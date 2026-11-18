//! Review triage: a read-only subagent orders the review queue of a checkpoint and leaves out what
//! does not need a person's eyes, so the developer reviews only what matters.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::actions::{self, TRIAGE};
use super::analysis::extract_json;
use super::engine::Engine;
use super::review::{ReviewPriority, Unit};
use crate::domain::ids::{CheckpointId, SessionId};
use crate::domain::{Error, ErrorCode, InsightEvent, Result, SessionKind};

/// How many components the subagent is shown at most.
const MAX_UNITS: usize = 150;

/// What the triage did, for the notice the developer sees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriageOutcome {
    pub reordered: usize,
    pub skipped: usize,
    /// Entries of the answer that named no component of the queue.
    pub ignored: usize,
}

/// One verdict of the subagent on one component.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriageVerdict {
    pub path: String,
    pub unit: String,
    /// 1 to 100 to keep it, at that place; `None` to leave it out.
    pub score: Option<u32>,
    pub reason: String,
}

fn unit_line(unit: &Unit) -> String {
    let mut line = format!(
        "- {} | {} | {}:{}-{} | {} {:?} | +{} -{}",
        unit.score,
        unit.name,
        unit.path,
        unit.start_line,
        unit.end_line,
        unit.kind,
        unit.change,
        unit.additions,
        unit.deletions
    );
    if unit.format_only {
        line.push_str(" | format only");
    }
    if unit.generated {
        line.push_str(" | generated file");
    }
    if let Some(reason) = unit.reasons.first() {
        line.push_str(&format!(" | {reason}"));
    }
    line
}

pub fn triage_prompt(priority: &ReviewPriority) -> String {
    let mut out = String::from(
        "You triage a code review queue for a developer who wants to review ONLY what needs a \
         person's eyes. Read the changed code in this repository if you need to (read-only: \
         never modify files or run anything that writes).\n\n\
         For every component below decide:\n\
         - keep it, with a score from 1 to 100 (higher is reviewed first): behaviour changes, \
         contracts, security, data, error handling, anything subtle or risky;\n\
         - or leave it out: formatting, renames, generated code, trivial wiring, tests that only \
         mirror the code, or anything a reviewer gains nothing from reading.\n\
         When in doubt, keep it. Answer with ONE JSON block and nothing after it:\n\
         ```json\n\
         {\"keep\": [{\"path\": \"src/a.rs\", \"unit\": \"Repo.create\", \"score\": 80, \"reason\": \"why\"}],\n\
          \"skip\": [{\"path\": \"src/b.rs\", \"unit\": \"format_name\", \"reason\": \"why\"}]}\n\
         ```\n\
         Use the component names and paths exactly as listed.\n\n\
         Queue (current score | component | file:lines | kind change | size | why it scored so):\n",
    );
    for unit in priority.units.iter().take(MAX_UNITS) {
        out.push_str(&unit_line(unit));
        out.push('\n');
    }
    if priority.units.len() > MAX_UNITS {
        out.push_str(&format!(
            "({} more components not listed: leave them as they are)\n",
            priority.units.len() - MAX_UNITS
        ));
    }
    out
}

/// The verdicts in the subagent's answer. An answer with no readable block is an error.
pub fn parse_triage(answer: &str) -> Result<Vec<TriageVerdict>> {
    let value = extract_json(answer).ok_or_else(|| {
        Error::new(
            ErrorCode::Agent,
            "the triage answered without the list it was asked for",
        )
    })?;
    let text = |item: &Value, key: &str| actions::text_of(item, key);
    let list = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let mut verdicts = Vec::new();
    for item in list("keep") {
        let score = item
            .get("score")
            .and_then(Value::as_f64)
            .map(|score| score.round().clamp(1.0, 100.0) as u32)
            .unwrap_or(50);
        verdicts.push(TriageVerdict {
            path: text(&item, "path"),
            unit: text(&item, "unit"),
            score: Some(score),
            reason: text(&item, "reason"),
        });
    }
    for item in list("skip") {
        verdicts.push(TriageVerdict {
            path: text(&item, "path"),
            unit: text(&item, "unit"),
            score: None,
            reason: text(&item, "reason"),
        });
    }
    if verdicts.is_empty() {
        return Err(Error::new(
            ErrorCode::Agent,
            "the triage returned an empty list",
        ));
    }
    Ok(verdicts)
}

impl Engine {
    /// Runs the triage on a checkpoint (the newest of the chat when `None`) and puts its order on
    /// the queue. What the triage set before is replaced; what the developer set stays on top.
    pub fn review_triage(
        &self,
        session_id: SessionId,
        checkpoint_id: Option<CheckpointId>,
    ) -> Result<TriageOutcome> {
        let session = self.session(session_id)?;
        let checkpoint = match checkpoint_id {
            Some(id) => self.db.get_checkpoint(id)?,
            None => self.db.latest_checkpoint(session_id)?,
        }
        .filter(|checkpoint| checkpoint.session_id == session_id)
        .ok_or_else(|| {
            Error::new(
                ErrorCode::NotFound,
                "there is no review queue to triage yet",
            )
        })?;
        let computed = self.computed_priority(&checkpoint);
        if computed.units.is_empty() {
            return Err(Error::new(
                ErrorCode::Invalid,
                "the queue has no components to triage",
            ));
        }
        let hidden = self.hidden_session(&session, SessionKind::Analysis, "Review triage")?;
        let answer = self.ask_and_wait(&hidden, &triage_prompt(&computed))?;
        let verdicts = parse_triage(&answer)?;

        let existing = self.db.list_unit_priorities(checkpoint.id)?;
        // The developer's own priorities win: the triage never overwrites them.
        let mine: HashSet<(String, String)> = existing
            .iter()
            .filter(|set| set.set_by == "you")
            .map(|set| (set.path.clone(), set.name.clone()))
            .collect();
        for set in existing.iter().filter(|set| set.set_by == TRIAGE) {
            self.db
                .clear_unit_priority(checkpoint.id, &set.path, &set.name)?;
        }
        let now = self.now();
        let mut outcome = TriageOutcome {
            reordered: 0,
            skipped: 0,
            ignored: 0,
        };
        for verdict in verdicts {
            let Ok(unit) = actions::find_unit(&computed, &verdict.path, &verdict.unit) else {
                outcome.ignored += 1;
                continue;
            };
            if mine.contains(&(unit.path.clone(), unit.name.clone())) {
                continue;
            }
            let reason = if verdict.reason.is_empty() {
                "no reason given".to_string()
            } else {
                verdict.reason.clone()
            };
            actions::set_unit_priority(
                self.db.as_ref(),
                &computed,
                checkpoint.id,
                &unit.path,
                &unit.name,
                verdict.score.unwrap_or(0),
                &reason,
                TRIAGE,
                &now,
            )?;
            match verdict.score {
                Some(_) => outcome.reordered += 1,
                None => outcome.skipped += 1,
            }
        }
        self.sink.emit_insight(InsightEvent::Checkpoint {
            session_id,
            checkpoint_id: checkpoint.id,
        });
        Ok(outcome)
    }

    /// Takes back everything the triage set on a checkpoint: the queue is the computed one again.
    pub fn review_untriage(&self, checkpoint_id: CheckpointId) -> Result<()> {
        let checkpoint = self
            .db
            .get_checkpoint(checkpoint_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "checkpoint not found"))?;
        for set in self
            .db
            .list_unit_priorities(checkpoint.id)?
            .into_iter()
            .filter(|set| set.set_by == TRIAGE)
        {
            self.db
                .clear_unit_priority(checkpoint.id, &set.path, &set.name)?;
        }
        self.sink.emit_insight(InsightEvent::Checkpoint {
            session_id: checkpoint.session_id,
            checkpoint_id: checkpoint.id,
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_keeps_some_components_at_a_score_and_leaves_others_out() {
        let answer = "Here it is.\n```json\n{\"keep\": [{\"path\": \"a.rs\", \"unit\": \"run\", \"score\": 140, \"reason\": \"core\"}], \
                      \"skip\": [{\"path\": \"b.rs\", \"unit\": \"fmt\", \"reason\": \"formatting\"}]}\n```";
        let verdicts = parse_triage(answer).unwrap();
        assert_eq!(verdicts.len(), 2);
        assert_eq!(verdicts[0].score, Some(100));
        assert_eq!(verdicts[1].score, None);
        assert_eq!(verdicts[1].reason, "formatting");
        assert!(parse_triage("no idea").is_err());
        assert!(parse_triage("{\"keep\": [], \"skip\": []}").is_err());
    }
}
