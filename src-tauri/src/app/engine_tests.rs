//! End to end: real SQLite, real git, the agent host with the scripted fake provider.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::btw::{BtwContext, ContextItem};
use super::engine::{Engine, TeeEventSink};
use crate::adapters::agents::{AgentHost, FakeBackend};
use crate::adapters::fs::StdFs;
use crate::adapters::git::GitCli;
use crate::adapters::sqlite::SqliteStore;
use crate::adapters::syntax::TreeSitterSyntax;
use crate::domain::agent::ProviderKind;
use crate::domain::ids::{RepositoryId, SessionId, TurnId, WorktreeId};
use crate::domain::{
    AgentEvent, ArtifactKind, ArtifactStatus, BtwMode, ChatSession, DecisionState, InsightEvent,
    PermissionDecision, Repository, ReturnPolicy, ReviewState, SessionKind, SessionStatus,
    Worktree,
};
use crate::ports::{AgentRuntime, Database, EventSink, Git, InsightSink, InsightStore, Store};

#[derive(Default)]
struct Recorder(Mutex<Vec<InsightEvent>>);
impl InsightSink for Recorder {
    fn emit_insight(&self, event: InsightEvent) {
        self.0.lock().push(event);
    }
}

#[derive(Default)]
struct NullSink;
impl EventSink for NullSink {
    fn emit_agent(&self, _event: AgentEvent) {}
}

struct World {
    engine: Arc<Engine>,
    db: Arc<SqliteStore>,
    host: Arc<AgentHost>,
    repo: PathBuf,
    session: ChatSession,
    events: Arc<Recorder>,
}

fn git(repo: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn world() -> World {
    let repo = std::env::temp_dir().join(format!("ataraxia-engine-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.email", "t@example.com"]);
    git(&repo, &["config", "user.name", "T"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.join("README.md"), "# demo\nline two\nline three\n").unwrap();
    std::fs::write(repo.join(".env"), "TOKEN=abc\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);

    let db = Arc::new(SqliteStore::open_in_memory().unwrap());
    let now = "2026-01-01T00:00:00Z".to_string();
    let repository = Repository {
        id: RepositoryId::new(),
        root: repo.clone(),
        name: "demo".into(),
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    db.upsert_repository(&repository).unwrap();
    let worktree = Worktree {
        id: WorktreeId::new(),
        repository_id: repository.id,
        path: repo.clone(),
        branch: Some("main".into()),
        head: None,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    db.upsert_worktree(&worktree).unwrap();
    let session = ChatSession {
        id: SessionId::new(),
        repository_id: repository.id,
        worktree_id: worktree.id,
        provider: ProviderKind::Fake,
        title: "Chat 1".into(),
        status: SessionStatus::Idle,
        model: None,
        effort: None,
        agent: None,
        kind: SessionKind::Chat,
        parent_session_id: None,
        created_at: now.clone(),
        updated_at: now,
        last_opened_at: None,
    };
    db.create_session(&session).unwrap();

    let tee = Arc::new(TeeEventSink::new(Arc::new(NullSink)));
    let store: Arc<dyn Store> = db.clone();
    let host = Arc::new(
        AgentHost::new(store, tee.clone())
            .with_insights(db.clone())
            .with_backend(
                ProviderKind::Fake,
                Arc::new(FakeBackend::new(Duration::from_millis(5))),
            ),
    );
    let events = Arc::new(Recorder::default());
    let database: Arc<dyn Database> = db.clone();
    let runtime: Arc<dyn AgentRuntime> = host.clone();
    let engine = Engine::new(
        Arc::new(GitCli),
        Arc::new(StdFs),
        Arc::new(TreeSitterSyntax),
        database,
        runtime,
        events.clone(),
    );
    tee.attach(&engine);
    World {
        engine,
        db,
        host,
        repo,
        session,
        events,
    }
}

fn wait_for<T>(what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// An agent turn that edits a file, as the host reports it.
fn agent_turn_editing(world: &World, file: &str, contents: &str) {
    world.engine.turn_started(world.session.id);
    std::fs::write(world.repo.join(file), contents).unwrap();
    world.engine.on_agent_event(&AgentEvent::TurnDone {
        session_id: world.session.id,
        turn_id: TurnId::new(),
        ok: true,
    });
}

#[test]
fn a_finished_turn_becomes_a_checkpoint_with_a_review_queue_and_decisions_wait_to_be_asked_for() {
    let w = world();
    agent_turn_editing(
        &w,
        "README.md",
        "# demo\nline two changed\nline three\nline four\n",
    );

    let checkpoint = wait_for("checkpoint", || {
        w.db.latest_checkpoint(w.session.id).unwrap()
    });
    assert_eq!(checkpoint.seq, 1);
    assert_eq!(checkpoint.files.len(), 1);
    assert_eq!(checkpoint.files[0].path, "README.md");

    // The queue is computed from the code at once. No model runs, and no decisions appear.
    let queue = wait_for("review queue", || {
        w.db.list_artifacts(w.session.id, Some(ArtifactKind::ReviewPriority))
            .unwrap()
            .into_iter()
            .next()
    });
    assert_eq!(queue.status, ArtifactStatus::Ready);
    std::thread::sleep(Duration::from_millis(250));
    assert!(w.engine.decisions(w.session.id).unwrap().is_empty());
    assert!(
        w.db.list_artifacts(w.session.id, Some(ArtifactKind::Decision))
            .unwrap()
            .is_empty()
    );
    assert!(w.db.list_child_sessions(w.session.id).unwrap().is_empty());

    // Asking is what starts it, on the provider the reviewer names.
    w.engine
        .generate_decisions(
            w.session.id,
            None,
            Some(ProviderKind::Fake),
            Some("demo-model".into()),
        )
        .unwrap();
    wait_for("decision analysis", || {
        w.db.list_artifacts(w.session.id, Some(ArtifactKind::Decision))
            .unwrap()
            .iter()
            .any(|a| a.status == ArtifactStatus::Ready)
            .then_some(())
    });
    let decisions = w.engine.decisions(w.session.id).unwrap();
    assert_eq!(decisions.len(), 2);
    assert!(decisions.iter().all(|d| d.state == DecisionState::Pending));
    assert_eq!(decisions[0].refs[0].path, "README.md");
    assert_eq!(decisions[0].opened_by, "fake · demo-model");
    assert_eq!(
        w.db.list_child_sessions(w.session.id).unwrap()[0]
            .model
            .as_deref(),
        Some("demo-model")
    );

    // Asking again never opens twins: a later chapter lands in the thread that is already open.
    w.engine
        .generate_decisions(w.session.id, None, None, None)
        .unwrap();
    wait_for("second analysis", || {
        let runs =
            w.db.list_artifacts(w.session.id, Some(ArtifactKind::Decision))
                .unwrap();
        (runs.len() == 2 && runs.iter().all(|a| a.status == ArtifactStatus::Ready)).then_some(())
    });
    assert_eq!(w.engine.decisions(w.session.id).unwrap().len(), 2);
    let thread = w.engine.decision_detail(decisions[0].id).unwrap();
    assert!(
        thread
            .messages
            .iter()
            .any(|m| m.text.contains("Seen again in checkpoint #1"))
    );
    assert_eq!(thread.decision.version, 2);
    // Hidden sessions never show up in the chat list.
    assert_eq!(
        w.db.list_sessions(w.session.repository_id).unwrap().len(),
        1
    );
    let _ = std::fs::remove_dir_all(&w.repo);
}

#[test]
fn turns_without_file_changes_leave_no_checkpoint() {
    let w = world();
    w.engine.turn_started(w.session.id);
    w.engine.on_agent_event(&AgentEvent::TurnDone {
        session_id: w.session.id,
        turn_id: TurnId::new(),
        ok: true,
    });
    std::thread::sleep(Duration::from_millis(300));
    assert!(w.db.latest_checkpoint(w.session.id).unwrap().is_none());
    let _ = std::fs::remove_dir_all(&w.repo);
}

#[test]
fn approving_a_decision_is_independent_from_reviewing_the_code() {
    let w = world();
    agent_turn_editing(&w, "README.md", "# changed\nmore\n");
    let checkpoint = wait_for("checkpoint", || {
        w.db.latest_checkpoint(w.session.id).unwrap()
    });
    w.engine
        .generate_decisions(w.session.id, None, None, None)
        .unwrap();
    let decisions = wait_for("decisions", || {
        let list = w.engine.decisions(w.session.id).unwrap();
        (!list.is_empty()).then_some(list)
    });
    let id = decisions[0].id;

    w.engine
        .set_review_mark(checkpoint.id, "README.md", ReviewState::ChangesRequested)
        .unwrap();
    let approved = w
        .engine
        .set_decision_state(id, DecisionState::Approved)
        .unwrap();
    assert_eq!(approved.version, 2);
    // Reviewing the file did not touch the decision, approving did not touch the review.
    let marks = w.db.list_review_marks(checkpoint.id).unwrap();
    assert_eq!(marks[0].state, ReviewState::ChangesRequested);
    assert!(
        w.engine
            .set_decision_state(id, DecisionState::Superseded)
            .is_err()
    );

    // The discussion stays open after approval, and a question is read-only.
    let message = w
        .engine
        .post_decision_message(id, "Why not a new entry point?", None)
        .unwrap();
    assert_eq!(message.author, "user");
    let detail = wait_for("agent reply", || {
        let detail = w.engine.decision_detail(id).unwrap();
        (detail.messages.len() >= 2).then_some(detail)
    });
    assert_eq!(detail.messages[1].author, "agent");
    assert_eq!(detail.revisions.len(), 2);
    assert_eq!(detail.decision.state, DecisionState::Approved);
    assert_eq!(
        std::fs::read_to_string(w.repo.join("README.md")).unwrap(),
        "# changed\nmore\n",
        "a question must not change files"
    );
    let _ = std::fs::remove_dir_all(&w.repo);
}

#[test]
fn a_verdict_can_carry_a_comment_and_a_comment_can_stand_alone_without_an_agent_answering() {
    let w = world();
    agent_turn_editing(&w, "README.md", "# changed\nmore\n");
    wait_for("checkpoint", || {
        w.db.latest_checkpoint(w.session.id).unwrap()
    });
    w.engine
        .generate_decisions(w.session.id, None, None, None)
        .unwrap();
    wait_for("the generation to finish", || {
        w.db.list_artifacts(w.session.id, Some(ArtifactKind::Decision))
            .unwrap()
            .iter()
            .all(|a| a.status == ArtifactStatus::Ready)
            .then_some(())
    });
    let decisions = w.engine.decisions(w.session.id).unwrap();
    let (first, second) = (decisions[0].id, decisions[1].id);

    // Rejecting with a reason: the comment comes first in the thread, then the verdict.
    let rejected = w
        .engine
        .set_decision_state_with_comment(
            first,
            DecisionState::Rejected,
            Some("  Too risky for a patch release  "),
        )
        .unwrap();
    assert_eq!(rejected.state, DecisionState::Rejected);
    let detail = w.engine.decision_detail(first).unwrap();
    assert_eq!(detail.messages.len(), 1);
    assert_eq!(
        (
            detail.messages[0].author.as_str(),
            detail.messages[0].text.as_str()
        ),
        ("user", "Too risky for a patch release")
    );
    assert!(
        detail
            .revisions
            .iter()
            .any(|r| r.reason == "state:rejected")
    );

    // Approving with a comment works the same way, and an empty comment adds nothing.
    w.engine
        .set_decision_state_with_comment(second, DecisionState::Approved, Some("   "))
        .unwrap();
    assert!(
        w.engine
            .decision_detail(second)
            .unwrap()
            .messages
            .is_empty()
    );
    w.engine
        .set_decision_state_with_comment(
            second,
            DecisionState::Pending,
            Some("Reopening: see the new commit"),
        )
        .unwrap();
    assert_eq!(w.engine.decision_detail(second).unwrap().messages.len(), 1);

    // A comment alone changes no verdict, and no agent answers it.
    w.engine
        .comment_decision(first, "Noted for the release notes")
        .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let detail = w.engine.decision_detail(first).unwrap();
    assert_eq!(detail.decision.state, DecisionState::Rejected);
    assert_eq!(detail.messages.len(), 2);
    assert!(detail.messages.iter().all(|m| m.author == "user"));
    assert!(w.engine.comment_decision(first, "  ").is_err());
    let _ = std::fs::remove_dir_all(&w.repo);
}

#[test]
fn deleting_all_artifacts_needs_the_chat_title_waits_for_running_work_and_leaves_the_chat_alone() {
    let w = world();
    agent_turn_editing(&w, "README.md", "# changed\nmore\n");
    let checkpoint = wait_for("checkpoint", || {
        w.db.latest_checkpoint(w.session.id).unwrap()
    });
    w.engine
        .generate_decisions(w.session.id, None, None, None)
        .unwrap();
    wait_for("the generation to finish", || {
        w.db.list_artifacts(w.session.id, Some(ArtifactKind::Decision))
            .unwrap()
            .iter()
            .all(|a| a.status == ArtifactStatus::Ready)
            .then_some(())
    });
    let decision = w.engine.decisions(w.session.id).unwrap()[0].id;
    w.engine.comment_decision(decision, "a note").unwrap();
    w.engine
        .add_review_comment(
            checkpoint.id,
            "README.md",
            Some(1),
            super::artifacts::Side::Head,
            "look",
        )
        .unwrap();
    let title = w.db.get_session(w.session.id).unwrap().unwrap().title;

    // Not without typing the title back, exactly.
    assert!(w.engine.delete_artifacts(w.session.id, "").is_err());
    assert!(
        w.engine
            .delete_artifacts(w.session.id, &title.to_lowercase())
            .is_err()
    );
    assert!(
        w.engine
            .delete_artifacts(w.session.id, &format!("{title} "))
            .is_err()
    );
    assert!(!w.engine.decisions(w.session.id).unwrap().is_empty());

    // Not while something is being generated.
    let run =
        w.db.list_artifacts(w.session.id, Some(ArtifactKind::Decision))
            .unwrap()
            .remove(0);
    w.db.update_artifact(run.id, ArtifactStatus::Running, None, None, None, "now")
        .unwrap();
    let busy = w.engine.delete_artifacts(w.session.id, &title).unwrap_err();
    assert!(
        busy.message.contains("still being generated"),
        "{}",
        busy.message
    );
    w.db.update_artifact(run.id, ArtifactStatus::Ready, None, None, None, "now")
        .unwrap();

    // Then everything derived goes, and only that.
    let cleared = w.engine.delete_artifacts(w.session.id, &title).unwrap();
    assert_eq!((cleared.checkpoints, cleared.decisions), (1, 2));
    assert!(w.db.list_checkpoints(w.session.id).unwrap().is_empty());
    assert!(w.db.list_artifacts(w.session.id, None).unwrap().is_empty());
    assert!(w.engine.decisions(w.session.id).unwrap().is_empty());
    assert!(w.db.list_review_comments(checkpoint.id).unwrap().is_empty());
    assert!(
        w.db.get_session(w.session.id).unwrap().is_some(),
        "the chat stays"
    );
    assert_eq!(
        std::fs::read_to_string(w.repo.join("README.md")).unwrap(),
        "# changed\nmore\n",
        "so does the code"
    );
    // And a new change starts over with the numbering at 1.
    agent_turn_editing(&w, "README.md", "# changed again\n");
    let fresh = wait_for("a new checkpoint", || {
        w.db.latest_checkpoint(w.session.id).unwrap()
    });
    assert_eq!(fresh.seq, 1);
    let _ = std::fs::remove_dir_all(&w.repo);
}

#[test]
fn btw_is_read_only_by_default_and_never_reaches_the_main_chat_on_its_own() {
    let w = world();
    let context = BtwContext {
        space: "code".into(),
        item: Some(ContextItem {
            kind: "file".into(),
            label: "README.md".into(),
            path: Some("README.md".into()),
            start_line: Some(1),
            end_line: Some(2),
            text: None,
        }),
    };
    let rendered = w.engine.btw_render_context(w.session.id, &context).unwrap();
    assert!(rendered.contains("File: README.md:1-2"), "{rendered}");
    assert!(rendered.contains("# demo"));
    assert!(
        !rendered.contains("line three"),
        "only the selected lines are attached"
    );

    let secret = BtwContext {
        space: "code".into(),
        item: Some(ContextItem {
            kind: "file".into(),
            label: ".env".into(),
            path: Some(".env".into()),
            start_line: None,
            end_line: None,
            text: None,
        }),
    };
    assert!(
        !w.engine
            .btw_render_context(w.session.id, &secret)
            .unwrap()
            .contains("TOKEN")
    );
    let outside = BtwContext {
        space: "code".into(),
        item: Some(ContextItem {
            kind: "file".into(),
            label: "x".into(),
            path: Some("../../etc/passwd".into()),
            start_line: None,
            end_line: None,
            text: None,
        }),
    };
    let rendered = w.engine.btw_render_context(w.session.id, &outside).unwrap();
    assert!(
        !rendered.contains("root:"),
        "files outside the worktree are never attached"
    );

    // A change needs explicit authorization.
    assert!(
        w.engine
            .btw_start(
                w.session.id,
                BtwMode::Change,
                "fix it",
                &context,
                ReturnPolicy::Manual,
                false
            )
            .is_err()
    );
    assert!(
        w.engine
            .btw_start(
                w.session.id,
                BtwMode::Ask,
                "  ",
                &context,
                ReturnPolicy::Manual,
                false
            )
            .is_err()
    );

    let task = w
        .engine
        .btw_start(
            w.session.id,
            BtwMode::Ask,
            "What does this file say?",
            &context,
            ReturnPolicy::OnCompletion,
            false,
        )
        .unwrap();
    assert_eq!(
        task.return_policy,
        ReturnPolicy::OnCompletion,
        "the main agent is always told when BTW is done"
    );
    let done = wait_for("btw answer", || {
        let task = w.db.get_btw_task(task.id).unwrap().unwrap();
        (task.status == ArtifactStatus::Ready && task.returned_at.is_some()).then_some(task)
    });
    assert!(done.summary.unwrap().contains("nothing was modified"));
    let hidden = w.db.get_session(done.session_id).unwrap().unwrap();
    assert_eq!(hidden.kind, SessionKind::Btw);
    assert_eq!(hidden.parent_session_id, Some(w.session.id));
    // The main conversation was told, once, in words that say it is for awareness only.
    let heard = format!("{:?}", w.host.snapshot(&w.session.id).unwrap().items);
    assert!(heard.contains("[BTW report, for your awareness"), "{heard}");
    assert!(heard.contains("What does this file say?"));
    assert_eq!(heard.matches("[BTW report").count(), 1);
    assert_eq!(w.engine.btw_tasks(w.session.id).unwrap().len(), 1);
    // Nothing is sent twice: the note is only for what the main agent has not heard.
    w.engine.btw_deliver(w.session.id);
    std::thread::sleep(Duration::from_millis(200));
    let again = format!("{:?}", w.host.snapshot(&w.session.id).unwrap().items);
    assert_eq!(again.matches("[BTW report").count(), 1);
    let _ = std::fs::remove_dir_all(&w.repo);
}

#[test]
fn btw_does_what_it_was_asked_in_ataraxia_and_the_main_agent_hears_what_was_done() {
    let w = world();
    std::fs::write(
        w.repo.join("lib.py"),
        "def publish(x):\n    return x\n\n\ndef quiet():\n    return 1\n",
    )
    .unwrap();
    git(&w.repo, &["add", "."]);
    git(&w.repo, &["commit", "-q", "-m", "add lib"]);
    agent_turn_editing(
        &w,
        "lib.py",
        "def publish(x, y):\n    return x + y\n\n\ndef quiet():\n    return 1\n\n\ndef extra():\n    return 2\n",
    );
    let checkpoint = wait_for("checkpoint", || {
        w.db.latest_checkpoint(w.session.id).unwrap()
    });
    let before = priority_of(&w);
    let top = before.units[0].name.clone();
    let lowest = before.units.last().unwrap().clone();
    assert_ne!(top, lowest.name);

    // Nothing happens to the queue, the decisions or the diagrams until someone asks.
    assert!(w.db.list_review_comments(checkpoint.id).unwrap().is_empty());
    assert!(w.db.list_unit_priorities(checkpoint.id).unwrap().is_empty());

    let context = BtwContext {
        space: "code".into(),
        item: None,
    };
    let task = w
        .engine
        .btw_start(
            w.session.id,
            BtwMode::Ask,
            "comment on the first component, raise it, and generate decisions and a diagram [fake:actions]",
            &context,
            ReturnPolicy::Manual,
            false,
        )
        .unwrap();
    let done = wait_for("btw actions", || {
        let task = w.db.get_btw_task(task.id).unwrap().unwrap();
        (task.status == ArtifactStatus::Ready && task.returned_at.is_some()).then_some(task)
    });

    // The answer keeps its words and loses the machine block; what was done is listed after it.
    let summary = done.summary.unwrap();
    assert!(summary.starts_with("I commented on"), "{summary}");
    assert!(!summary.contains("ataraxia-actions"), "{summary}");
    assert!(summary.contains("Done in Ataraxia:"), "{summary}");
    assert!(
        summary.contains(&format!("- Commented on `{top}`")),
        "{summary}"
    );
    assert!(
        summary.contains(&format!("- Set the priority of `{top}` to 99")),
        "{summary}"
    );
    assert!(
        summary.contains("Could not comment:") && summary.contains("no_such_component"),
        "{summary}"
    );
    assert!(
        summary.contains("Started generating decisions") && summary.contains("focused on: retries"),
        "{summary}"
    );
    assert!(
        summary.contains("Started drawing a diagram") && summary.contains("the entry point"),
        "{summary}"
    );

    // The comment is marked as the agent's, on the component's first line.
    let comments = w.db.list_review_comments(checkpoint.id).unwrap();
    assert_eq!(
        comments.len(),
        1,
        "the one naming a component that does not exist was refused"
    );
    assert_eq!(comments[0].author, "agent");
    assert_eq!(comments[0].text, format!("Fake comment on {top}"));
    assert!(comments[0].line.is_some());

    // The priority was set on top of the computed queue, with its reason, and can be undone.
    let view = w.engine.review(w.session.id, None).unwrap();
    let raised = view
        .priority
        .unwrap()
        .units
        .into_iter()
        .find(|u| u.name == top)
        .unwrap();
    assert_eq!(raised.score, 99);
    assert!(
        raised.reasons[0].starts_with("The agent set the priority to 99"),
        "{:?}",
        raised.reasons
    );
    w.engine
        .reset_unit_priority(checkpoint.id, &raised.path, &raised.name)
        .unwrap();
    let restored = w
        .engine
        .review(w.session.id, None)
        .unwrap()
        .priority
        .unwrap();
    assert_ne!(
        restored.units.iter().find(|u| u.name == top).unwrap().score,
        99
    );

    // Decisions and the diagram were started, with what BTW was told to look at.
    let runs =
        w.db.list_artifacts(w.session.id, Some(ArtifactKind::Decision))
            .unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].provenance["focus"], "retries");
    let flows =
        w.db.list_artifacts(w.session.id, Some(ArtifactKind::Flow))
            .unwrap();
    assert_eq!(flows.len(), 1);
    assert_eq!(flows[0].provenance["extra"], "the entry point");

    // And the main agent was told all of it, as a note for awareness.
    let heard = format!("{:?}", w.host.snapshot(&w.session.id).unwrap().items);
    assert!(heard.contains("[BTW report, for your awareness"), "{heard}");
    assert!(heard.contains("Done in Ataraxia:"), "{heard}");
    assert!(heard.contains("Set the priority of"), "{heard}");
    let _ = std::fs::remove_dir_all(&w.repo);
}

#[test]
fn a_btw_runs_on_the_provider_and_model_that_were_chosen_for_it() {
    let w = world();
    let context = BtwContext {
        space: "chat".into(),
        item: None,
    };
    let task = w
        .engine
        .btw_start_with(
            w.session.id,
            BtwMode::Ask,
            "what is a token?",
            &context,
            ReturnPolicy::Manual,
            false,
            Some(ProviderKind::Fake),
            Some("quick-model".into()),
        )
        .unwrap();
    let hidden = w.db.get_session(task.session_id).unwrap().unwrap();
    assert_eq!(hidden.provider, ProviderKind::Fake);
    assert_eq!(hidden.model.as_deref(), Some("quick-model"));
    // With nothing chosen it runs as the chat does.
    let plain = w
        .engine
        .btw_start(
            w.session.id,
            BtwMode::Ask,
            "and a session?",
            &context,
            ReturnPolicy::Manual,
            false,
        )
        .unwrap();
    let hidden = w.db.get_session(plain.session_id).unwrap().unwrap();
    assert_eq!((hidden.provider, hidden.model), (w.session.provider, None));
    let _ = std::fs::remove_dir_all(&w.repo);
}

#[test]
fn a_btw_that_finishes_while_the_main_agent_is_busy_is_told_when_its_turn_ends() {
    let w = world();
    // The main agent is in the middle of a turn.
    w.host.start_session(&w.session).unwrap();
    w.engine.turn_started(w.session.id);
    w.host
        .prompt(&w.session.id, "keep working on the migration")
        .unwrap();
    let context = BtwContext {
        space: "chat".into(),
        item: None,
    };
    let task = w
        .engine
        .btw_start(
            w.session.id,
            BtwMode::Ask,
            "what is a token?",
            &context,
            ReturnPolicy::Manual,
            false,
        )
        .unwrap();
    wait_for("btw answer", || {
        let task = w.db.get_btw_task(task.id).unwrap().unwrap();
        (task.status == ArtifactStatus::Ready).then_some(())
    });
    // The main agent is still in its turn (it is waiting for a permission), so the note is held,
    // not lost and not forced into the middle of the turn.
    std::thread::sleep(Duration::from_millis(900));
    assert!(
        w.db.get_btw_task(task.id)
            .unwrap()
            .unwrap()
            .returned_at
            .is_none()
    );
    assert!(
        !format!("{:?}", w.host.snapshot(&w.session.id).unwrap().items).contains("[BTW report")
    );

    // The turn ends: the note arrives, once.
    let request_id = wait_for("the permission request", || {
        w.host
            .snapshot(&w.session.id)
            .unwrap()
            .pending_permission
            .map(|p| p.request_id)
    });
    w.host
        .resolve_permission(
            &w.session.id,
            PermissionDecision {
                request_id,
                allow: true,
            },
        )
        .unwrap();
    let done = wait_for("the main agent hears it", || {
        let task = w.db.get_btw_task(task.id).unwrap().unwrap();
        task.returned_at.is_some().then_some(task)
    });
    assert!(done.returned_at.is_some());
    let heard = format!("{:?}", w.host.snapshot(&w.session.id).unwrap().items);
    assert_eq!(heard.matches("[BTW report").count(), 1, "{heard}");
    assert!(heard.contains("what is a token?"));
    let _ = std::fs::remove_dir_all(&w.repo);
}

#[test]
fn flow_presets_are_seeded_edited_and_never_generate_by_themselves() {
    let w = world();
    let presets = w.engine.flow_presets(w.session.repository_id).unwrap();
    assert_eq!(presets.len(), 4);
    assert!(presets.iter().all(|p| p.builtin));

    let mine = w
        .engine
        .save_flow_preset(
            None,
            Some(w.session.repository_id),
            "Auth path",
            "Trace login.",
        )
        .unwrap();
    let edited = w
        .engine
        .save_flow_preset(Some(mine.id), None, "Auth path", "Trace login and logout.")
        .unwrap();
    assert_eq!(edited.version, 2);
    assert!(w.engine.save_flow_preset(None, None, " ", "x").is_err());
    assert!(w.engine.delete_flow_preset(presets[0].id).is_err());
    // Creating and editing presets produced no diagram.
    assert!(w.engine.flows(w.session.id).unwrap().is_empty());

    let artifact = w
        .engine
        .flow_generate(w.session.id, edited.id, "focus on the happy path")
        .unwrap();
    assert_eq!(artifact.version, 1);
    let ready = wait_for("flow", || {
        let a = w.db.get_artifact(artifact.id).unwrap().unwrap();
        (a.status == ArtifactStatus::Ready).then_some(a)
    });
    assert_eq!(ready.content["nodes"].as_array().unwrap().len(), 3);
    assert_eq!(ready.provenance["presetName"], "Auth path");
    assert_eq!(ready.provenance["extra"], "focus on the happy path");
    assert_eq!(ready.content["nodes"][0]["verified"], true);
    assert_eq!(ready.content["nodes"][1]["verified"], false);

    // The code moves on: the diagram says it is out of date.
    agent_turn_editing(&w, "README.md", "# something else entirely\n");
    wait_for("flow stale", || {
        let a = w.db.get_artifact(artifact.id).unwrap().unwrap();
        (a.status == ArtifactStatus::Stale).then_some(())
    });
    let _ = std::fs::remove_dir_all(&w.repo);
}

#[test]
fn review_marks_comments_and_file_versions_work_against_a_checkpoint() {
    let w = world();
    agent_turn_editing(&w, "README.md", "# demo\nline two\nline three\nadded\n");
    let checkpoint = wait_for("checkpoint", || {
        w.db.latest_checkpoint(w.session.id).unwrap()
    });

    let view = w.engine.review(w.session.id, None).unwrap();
    assert_eq!(view.checkpoint.as_ref().unwrap().id, checkpoint.id);
    assert_eq!(view.priority.as_ref().unwrap().files[0].path, "README.md");

    use super::artifacts::Side;
    assert_eq!(
        w.engine
            .code_file_at(checkpoint.id, "README.md", Side::Base)
            .unwrap()
            .unwrap(),
        "# demo\nline two\nline three\n"
    );
    assert!(
        w.engine
            .code_file_at(checkpoint.id, "README.md", Side::Head)
            .unwrap()
            .unwrap()
            .ends_with("added\n")
    );

    w.engine
        .set_review_mark(checkpoint.id, "README.md", ReviewState::Approved)
        .unwrap();
    assert!(
        w.engine
            .set_review_mark(checkpoint.id, "nope.txt", ReviewState::Approved)
            .is_err()
    );
    w.engine
        .add_review_comment(
            checkpoint.id,
            "README.md",
            Some(4),
            Side::Head,
            "why add this?",
        )
        .unwrap();
    assert!(
        w.engine
            .add_review_comment(checkpoint.id, "README.md", Some(4), Side::Head, "  ")
            .is_err()
    );
    let view = w.engine.review(w.session.id, Some(checkpoint.id)).unwrap();
    assert_eq!(view.marks.len(), 1);
    assert_eq!(view.comments.len(), 1);

    // Editing goes through the sandbox and detects an outside edit.
    let read = w
        .engine
        .code_read(w.session.worktree_id, "README.md")
        .unwrap();
    w.engine
        .code_write(
            w.session.worktree_id,
            "README.md",
            "mine\n",
            Some(read.mtime_ms),
        )
        .unwrap();
    assert!(
        w.engine
            .code_write(w.session.worktree_id, "../escape.txt", "x", None)
            .is_err()
    );
    assert!(
        w.engine
            .code_tree(w.session.worktree_id)
            .unwrap()
            .contains(&"README.md".to_string())
    );
    let _ = std::fs::remove_dir_all(&w.repo);
}

#[test]
fn a_chat_with_no_checkpoint_gets_one_on_first_review_when_files_changed() {
    let w = world();
    assert!(
        w.engine
            .review(w.session.id, None)
            .unwrap()
            .checkpoint
            .is_none()
    );
    std::fs::write(w.repo.join("README.md"), "# edited by hand\n").unwrap();
    let view = w.engine.review(w.session.id, None).unwrap();
    let checkpoint = view.checkpoint.expect("manual checkpoint");
    assert_eq!(checkpoint.source, crate::domain::CheckpointSource::Manual);
    assert_eq!(checkpoint.files.len(), 1);
    // Nothing changed since: the same checkpoint is reused.
    let again = w.engine.refresh_checkpoint(w.session.id).unwrap().unwrap();
    assert_eq!(again.id, checkpoint.id);
    let _ = std::fs::remove_dir_all(&w.repo);
}

#[test]
fn work_left_running_by_a_previous_run_is_failed_not_forgotten() {
    let w = world();
    agent_turn_editing(&w, "README.md", "# x\n");
    let checkpoint = wait_for("checkpoint", || {
        w.db.latest_checkpoint(w.session.id).unwrap()
    });
    w.engine
        .generate_decisions(w.session.id, None, None, None)
        .unwrap();
    wait_for("decision artifact", || {
        w.db.list_artifacts(w.session.id, Some(ArtifactKind::Decision))
            .unwrap()
            .iter()
            .any(|a| a.status == ArtifactStatus::Ready)
            .then_some(())
    });
    let artifact =
        w.db.list_artifacts(w.session.id, Some(ArtifactKind::Decision))
            .unwrap()
            .remove(0);
    w.db.update_artifact(
        artifact.id,
        ArtifactStatus::Running,
        None,
        None,
        None,
        "now",
    )
    .unwrap();
    w.engine.recover();
    let after = w.db.get_artifact(artifact.id).unwrap().unwrap();
    assert_eq!(after.status, ArtifactStatus::Failed);
    assert!(after.error.unwrap().contains("Retry"));
    // Retrying re-runs it without a duplicate.
    w.engine.retry_artifact(artifact.id).unwrap();
    wait_for("retry", || {
        let a = w.db.get_artifact(artifact.id).unwrap().unwrap();
        (a.status == ArtifactStatus::Ready).then_some(())
    });
    assert_eq!(
        w.db.list_artifacts(w.session.id, Some(ArtifactKind::Decision))
            .unwrap()
            .len(),
        1
    );
    let _ = (checkpoint, &w.events);
    let _ = std::fs::remove_dir_all(&w.repo);
}

#[test]
fn subagent_conversations_survive_a_restart() {
    use crate::domain::{SubagentRecord, SubagentStatus};
    let w = world();
    w.db.replace_subagents(
        w.session.id,
        &[SubagentRecord {
            id: "sub-1".into(),
            title: "explorer".into(),
            status: SubagentStatus::Running,
            detached: true,
            items: Vec::new(),
        }],
    )
    .unwrap();
    w.host.start_session(&w.session).unwrap();
    let snapshot = w.host.snapshot(&w.session.id).unwrap();
    assert_eq!(snapshot.subagents.len(), 1);
    // It cannot still be running: the process that ran it is gone.
    assert_eq!(snapshot.subagents[0].status, SubagentStatus::Failed);
    let _ = std::fs::remove_dir_all(&w.repo);
    let _ = w.host.snapshot(&w.session.id);
    let _: &dyn Git = &GitCli;
}

fn priority_of(w: &World) -> crate::app::review::ReviewPriority {
    let artifact = wait_for("review priority", || {
        w.db.list_artifacts(w.session.id, Some(ArtifactKind::ReviewPriority))
            .unwrap()
            .into_iter()
            .next()
    });
    serde_json::from_value(artifact.content).unwrap()
}

#[test]
fn the_review_queue_is_ranked_from_the_code_and_explains_every_point() {
    let w = world();
    std::fs::write(
        w.repo.join("lib.py"),
        "def publish(x):\n    return x\n\n\ndef quiet():\n    return 1\n",
    )
    .unwrap();
    git(&w.repo, &["add", "."]);
    git(&w.repo, &["commit", "-q", "-m", "add lib"]);
    agent_turn_editing(
        &w,
        "lib.py",
        "def publish(x, y):\n    return x + y\n\n\ndef quiet():\n    return 1\n\n\ndef extra():\n    return 2\n",
    );

    let priority = priority_of(&w);
    assert_eq!(priority.languages, vec!["python".to_string()]);
    let names: Vec<&str> = priority.units.iter().map(|u| u.name.as_str()).collect();
    assert!(
        names.contains(&"publish") && names.contains(&"extra"),
        "{names:?}"
    );
    assert!(!names.contains(&"quiet"), "untouched code is not a unit");
    // The changed public signature leads, and each of its points has a reason.
    assert_eq!(priority.units[0].name, "publish");
    assert!(
        priority.units[0]
            .factors
            .iter()
            .any(|f| f.component == "contract")
    );
    assert!(priority.units[0].reasons.iter().all(|r| r.ends_with(')')));
    // Components are the classes, impls or files that hold the units: no model groups them.
    assert!(priority.components.iter().all(|c| c.path.is_some()));
    // And no model took part: no hidden analysis session, a queue that is ready on arrival.
    assert!(w.db.list_child_sessions(w.session.id).unwrap().is_empty());
    let artifact =
        w.db.list_artifacts(w.session.id, Some(ArtifactKind::ReviewPriority))
            .unwrap()
            .remove(0);
    assert_eq!(artifact.status, ArtifactStatus::Ready);
    assert_eq!(artifact.provenance["generator"], "tree-sitter+heuristics");
    let _ = std::fs::remove_dir_all(&w.repo);
}

#[test]
fn a_decision_is_a_thread_that_outlives_the_code_and_collects_commits() {
    let w = world();
    agent_turn_editing(&w, "README.md", "# changed\nmore\n");
    wait_for("checkpoint", || {
        w.db.latest_checkpoint(w.session.id).unwrap()
    });
    w.engine
        .generate_decisions(w.session.id, None, None, None)
        .unwrap();
    wait_for("the generation to finish", || {
        w.db.list_artifacts(w.session.id, Some(ArtifactKind::Decision))
            .unwrap()
            .iter()
            .all(|a| a.status == ArtifactStatus::Ready)
            .then_some(())
    });
    let decisions = w.engine.decisions(w.session.id).unwrap();
    let id = decisions[0].id;

    // The reviewer can open one by hand, like an issue.
    let manual = w
        .engine
        .create_decision(
            w.session.id,
            "Should retries be capped?",
            "",
            crate::domain::DecisionKind::Behavior,
            Vec::new(),
            "you",
        )
        .unwrap();
    assert_eq!(manual.seq, 3);
    assert_eq!(manual.opened_by, "you");
    assert_eq!(manual.summary, "Should retries be capped?");
    assert!(
        w.engine
            .create_decision(
                w.session.id,
                " ",
                "x",
                crate::domain::DecisionKind::Other,
                Vec::new(),
                "you"
            )
            .is_err()
    );

    // The code changes and is committed: the commit shows up first, because it touches the
    // files the decision is about.
    std::fs::write(w.repo.join("README.md"), "# changed again\n").unwrap();
    git(&w.repo, &["add", "."]);
    git(&w.repo, &["commit", "-q", "-m", "rework readme"]);
    let candidates = w.engine.decision_commit_candidates(id).unwrap();
    assert!(candidates[0].touches_decision_files);
    assert_eq!(candidates[0].commit.subject, "rework readme");
    assert!(!candidates[0].linked);

    let linked = w
        .engine
        .link_decision_commit(
            id,
            &candidates[0].commit.short,
            "Changes the answer",
            "user",
        )
        .unwrap();
    assert_eq!(linked.rev, candidates[0].commit.rev);
    assert_eq!(linked.linked_by, "user");
    // Linking it again only updates the note.
    w.engine
        .link_decision_commit(id, "HEAD", "Reworked the intro", "agent")
        .unwrap();
    let detail = w.engine.decision_detail(id).unwrap();
    assert_eq!(detail.commits.len(), 1);
    assert_eq!(detail.commits[0].note, "Reworked the intro");
    assert!(w.engine.decision_commit_candidates(id).unwrap()[0].linked);
    assert!(
        w.engine
            .link_decision_commit(id, "no-such-commit", "", "user")
            .is_err()
    );

    // The thread is still there, still open, with its history.
    assert_eq!(detail.decision.state, DecisionState::Pending);
    w.engine.unlink_decision_commit(id, &linked.rev).unwrap();
    assert!(w.engine.decision_detail(id).unwrap().commits.is_empty());
    let _ = std::fs::remove_dir_all(&w.repo);
}

#[test]
fn any_two_revisions_can_be_compared_and_the_same_comparison_is_the_same_checkpoint() {
    let w = world();
    git(&w.repo, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(w.repo.join("feature.py"), "def feature():\n    return 1\n").unwrap();
    git(&w.repo, &["add", "."]);
    git(&w.repo, &["commit", "-q", "-m", "feature work"]);
    git(&w.repo, &["checkout", "-q", "main"]);
    std::fs::write(
        w.repo.join("main_only.py"),
        "def on_main():\n    return 2\n",
    )
    .unwrap();
    git(&w.repo, &["add", "."]);
    git(&w.repo, &["commit", "-q", "-m", "main moved"]);

    // main..feature as a pull request shows it: only what the branch added.
    let pr = w
        .engine
        .compare(w.session.id, "main", Some("feature"), true)
        .unwrap();
    assert_eq!(pr.source, crate::domain::CheckpointSource::Compare);
    assert_eq!(pr.base_label.as_deref(), Some("main (merge base)"));
    assert_eq!(pr.head_label.as_deref(), Some("feature"));
    assert!(
        !pr.head_live,
        "a branch is a fixed revision, not something to edit"
    );
    assert_eq!(
        pr.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
        ["feature.py"]
    );

    // Without the merge base, main's own commit shows up as a deletion on the way to feature.
    let direct = w
        .engine
        .compare(w.session.id, "main", Some("feature"), false)
        .unwrap();
    assert_ne!(direct.id, pr.id);
    assert!(direct.files.iter().any(|f| f.path == "main_only.py"));

    // Asking for the same comparison again is the same checkpoint.
    assert_eq!(
        w.engine
            .compare(w.session.id, "main", Some("feature"), true)
            .unwrap()
            .id,
        pr.id
    );

    // The working tree as head: live, editable.
    std::fs::write(w.repo.join("scratch.py"), "def scratch():\n    return 3\n").unwrap();
    let live = w
        .engine
        .compare(w.session.id, "feature", None, false)
        .unwrap();
    assert!(live.head_live);
    assert_eq!(live.head_label.as_deref(), Some("working tree"));
    assert!(live.files.iter().any(|f| f.path == "scratch.py"));

    // Bad input is refused plainly.
    assert!(
        w.engine
            .compare(w.session.id, "no-such-branch", None, false)
            .is_err()
    );
    assert!(
        w.engine
            .compare(w.session.id, "--output=/tmp/x", None, false)
            .is_err()
    );
    let same = w
        .engine
        .compare(w.session.id, "feature", Some("feature"), false)
        .unwrap_err();
    assert!(same.message.contains("no differences"), "{}", same.message);

    // The selector's choices.
    let refs = w.engine.code_refs(w.session.id).unwrap();
    assert!(refs.refs.iter().any(|r| r.name == "feature"));
    assert_eq!(refs.current.as_deref(), Some("main"));

    // A comparison has its own review queue, and the model judges it too.
    wait_for("queue for the comparison", || {
        w.db.list_artifacts(w.session.id, Some(ArtifactKind::ReviewPriority))
            .unwrap()
            .iter()
            .any(|a| a.checkpoint_id == pr.id && a.status == ArtifactStatus::Ready)
            .then_some(())
    });
    let _ = std::fs::remove_dir_all(&w.repo);
}
