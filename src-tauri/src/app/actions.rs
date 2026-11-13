//! What a person can ask an agent to do inside Ataraxia: leave a comment on a component, change a
//! component's priority in the review queue. Never something an agent does by itself: the chat or
//! BTW calls these because the developer asked, and every result is reported back in words.
//!
//! These work on the store alone, so the chat's local API and the BTW engine share them.

use serde_json::Value;
use uuid::Uuid;

use super::review::{Level, ReviewPriority, ScoreFactor, Unit};
use super::units::rebuild;
use crate::domain::ids::CheckpointId;
use crate::domain::{ArtifactKind, Error, ErrorCode, Result, ReviewComment, UnitPriority};
use crate::ports::InsightStore;

const MAX_COMMENT_CHARS: usize = 2_000;
const MAX_REASON_CHARS: usize = 300;

/// The review queue computed for a checkpoint, as it was stored (no priority set by hand on it).
pub fn stored_priority(
    db: &dyn InsightStore,
    checkpoint_id: CheckpointId,
    session_id: crate::domain::ids::SessionId,
    version: u32,
) -> Result<Option<ReviewPriority>> {
    Ok(db
        .list_artifacts(session_id, Some(ArtifactKind::ReviewPriority))?
        .into_iter()
        .find(|artifact| {
            artifact.checkpoint_id == checkpoint_id && artifact.provenance["version"] == version
        })
        .and_then(|artifact| serde_json::from_value::<ReviewPriority>(artifact.content).ok()))
}

fn short_name(name: &str) -> &str {
    name.rsplit(['.', ':']).next().unwrap_or(name)
}

/// The unit an agent means: the file and the name as the queue shows them, or just the short name
/// when it is unambiguous. An ambiguous name is an error that lists the candidates.
pub fn find_unit<'a>(priority: &'a ReviewPriority, path: &str, name: &str) -> Result<&'a Unit> {
    let name = name.trim();
    let path = path.trim();
    let in_file = |unit: &&Unit| path.is_empty() || unit.path == path;
    let pool: Vec<&Unit> = priority
        .units
        .iter()
        .filter(in_file)
        .filter(|unit| unit.name == name || short_name(&unit.name) == short_name(name))
        .collect();
    // A qualified name (`Repo.create`) picks its exact match; a bare one that several units share
    // is ambiguous, whatever else matches it exactly.
    let qualified = name.contains(['.', ':']);
    let exact: Vec<&Unit> = pool
        .iter()
        .copied()
        .filter(|unit| unit.name == name)
        .collect();
    let found = if pool.len() > 1 && qualified && exact.len() == 1 {
        exact
    } else {
        pool
    };
    match found.as_slice() {
        [one] => Ok(one),
        [] => Err(Error::new(
            ErrorCode::NotFound,
            format!(
                "`{name}` is not in the review queue{}. Use a name and file exactly as the queue lists them",
                if path.is_empty() {
                    String::new()
                } else {
                    format!(" for {path}")
                }
            ),
        )),
        many => Err(Error::new(
            ErrorCode::Invalid,
            format!(
                "`{name}` matches more than one unit ({}). Say which file",
                many.iter()
                    .map(|unit| format!("{} in {}", unit.name, unit.path))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
    }
}

fn who(set_by: &str) -> &str {
    if set_by == "you" { "You" } else { "The agent" }
}

fn signed(points: i32) -> String {
    if points > 0 {
        format!("+{points}")
    } else {
        points.to_string()
    }
}

/// Puts the priorities set on top of the computed queue, then ranks it again. A priority for a
/// unit the code no longer has is ignored, and stays stored for when it comes back.
pub fn apply_overrides(priority: &mut ReviewPriority, overrides: &[UnitPriority]) {
    let mut changed = false;
    for set in overrides {
        let Some(unit) = priority
            .units
            .iter_mut()
            .find(|unit| unit.path == set.path && unit.name == set.name)
        else {
            continue;
        };
        let points = i64::from(set.score) - i64::from(unit.score);
        let points = i32::try_from(points).unwrap_or(0);
        let reason = if set.reason.trim().is_empty() {
            "no reason given".to_string()
        } else {
            set.reason.trim().to_string()
        };
        unit.factors.push(ScoreFactor {
            component: "adjustment".into(),
            points,
            reason: format!(
                "{} set this priority: {reason}",
                who(&set.set_by).to_lowercase()
            ),
        });
        unit.reasons.insert(
            0,
            format!(
                "{} set the priority to {} ({}): {reason}",
                who(&set.set_by),
                set.score,
                signed(points)
            ),
        );
        unit.score = set.score;
        unit.level = Level::of_unit(set.score);
        changed = true;
    }
    if changed {
        rebuild(priority);
    }
}

/// Leaves a review comment on a component (or a line). Returns what was done, in words.
#[allow(clippy::too_many_arguments)]
pub fn comment_on_unit(
    db: &dyn InsightStore,
    priority: Option<&ReviewPriority>,
    checkpoint_id: CheckpointId,
    path: &str,
    unit: Option<&str>,
    line: Option<u32>,
    text: &str,
    author: &str,
    now: &str,
) -> Result<String> {
    let text = text.trim();
    if text.is_empty() {
        return Err(Error::new(ErrorCode::Invalid, "the comment is empty"));
    }
    let text: String = text.chars().take(MAX_COMMENT_CHARS).collect();
    let (path, line, side, label) = match unit.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => {
            let priority = priority.ok_or_else(|| {
                Error::new(
                    ErrorCode::NotFound,
                    "this checkpoint has no review queue yet",
                )
            })?;
            let found = find_unit(priority, path, name)?;
            (
                found.path.clone(),
                (found.kind != "file").then_some(found.start_line.max(1)),
                if found.side == "base" { "base" } else { "head" },
                format!("`{}`", found.name),
            )
        }
        None => {
            if path.trim().is_empty() {
                return Err(Error::new(
                    ErrorCode::Invalid,
                    "say which file or component the comment is about",
                ));
            }
            (
                path.trim().to_string(),
                line,
                "head",
                path.trim().to_string(),
            )
        }
    };
    db.add_review_comment(&ReviewComment {
        id: Uuid::new_v4().to_string(),
        checkpoint_id,
        path: path.clone(),
        line,
        side: side.into(),
        text,
        author: author.to_string(),
        created_at: now.to_string(),
    })?;
    Ok(match line {
        Some(line) => format!("Commented on {label} ({path}:{line})"),
        None => format!("Commented on {label} ({path})"),
    })
}

/// Sets the priority of a unit in the review queue. Returns what was done, in words.
#[allow(clippy::too_many_arguments)]
pub fn set_unit_priority(
    db: &dyn InsightStore,
    priority: &ReviewPriority,
    checkpoint_id: CheckpointId,
    path: &str,
    unit: &str,
    score: u32,
    reason: &str,
    set_by: &str,
    now: &str,
) -> Result<String> {
    let found = find_unit(priority, path, unit)?;
    let score = score.min(100);
    db.set_unit_priority(&UnitPriority {
        checkpoint_id,
        path: found.path.clone(),
        name: found.name.clone(),
        score,
        reason: reason.trim().chars().take(MAX_REASON_CHARS).collect(),
        set_by: set_by.to_string(),
        updated_at: now.to_string(),
    })?;
    Ok(format!(
        "Set the priority of `{}` to {score} (it was {})",
        found.name, found.score
    ))
}

/// Takes a set priority away, so the unit goes back to what the code says.
pub fn reset_unit_priority(
    db: &dyn InsightStore,
    priority: &ReviewPriority,
    checkpoint_id: CheckpointId,
    path: &str,
    unit: &str,
) -> Result<String> {
    let found = find_unit(priority, path, unit)?;
    db.clear_unit_priority(checkpoint_id, &found.path, &found.name)?;
    Ok(format!(
        "Restored the computed priority of `{}`",
        found.name
    ))
}

/// A string argument of a JSON object, trimmed.
pub fn text_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::review::{ReviewPriority, UnitChange};

    fn unit(name: &str, path: &str, score: u32) -> Unit {
        Unit {
            id: String::new(),
            name: name.into(),
            kind: "function".into(),
            path: path.into(),
            start_line: 10,
            end_line: 20,
            side: "head".into(),
            change: UnitChange::Modified,
            signature_changed: false,
            public: false,
            references: 0,
            additions: 3,
            deletions: 1,
            score,
            level: Level::of_unit(score),
            reasons: vec!["small, contained change".into()],
            container: None,
            factors: Vec::new(),
            complexity: 0,
            complexity_before: None,
            format_only: false,
            markers: Vec::new(),
            entry: None,
            sensitive: None,
            tested: None,
            dirs: 0,
            generated: false,
        }
    }

    fn priority() -> ReviewPriority {
        let mut priority = ReviewPriority {
            components: Vec::new(),
            files: Vec::new(),
            units: vec![
                unit("Repo.create", "src/repo.rs", 20),
                unit("create", "src/other.rs", 30),
                unit("verify", "src/auth.rs", 60),
            ],
            languages: Vec::new(),
        };
        rebuild(&mut priority);
        priority
    }

    #[test]
    fn a_unit_is_found_by_its_name_or_its_short_name_and_an_ambiguous_one_is_refused() {
        let queue = priority();
        assert_eq!(
            find_unit(&queue, "src/repo.rs", "Repo.create")
                .unwrap()
                .path,
            "src/repo.rs"
        );
        assert_eq!(
            find_unit(&queue, "src/repo.rs", "create").unwrap().name,
            "Repo.create"
        );
        assert_eq!(find_unit(&queue, "", "verify").unwrap().path, "src/auth.rs");
        let ambiguous = find_unit(&queue, "", "create").unwrap_err();
        assert_eq!(ambiguous.code, ErrorCode::Invalid);
        assert!(
            ambiguous.message.contains("src/repo.rs") && ambiguous.message.contains("src/other.rs")
        );
        assert_eq!(
            find_unit(&queue, "src/auth.rs", "nope").unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn a_set_priority_reorders_the_queue_and_says_who_set_it_and_by_how_much() {
        let mut queue = priority();
        assert_eq!(queue.units[0].name, "verify");
        let checkpoint = CheckpointId::new();
        apply_overrides(
            &mut queue,
            &[UnitPriority {
                checkpoint_id: checkpoint,
                path: "src/repo.rs".into(),
                name: "Repo.create".into(),
                score: 95,
                reason: "it writes to the database".into(),
                set_by: "agent".into(),
                updated_at: String::new(),
            }],
        );
        let top = &queue.units[0];
        assert_eq!(top.name, "Repo.create");
        assert_eq!((top.score, top.level.clone()), (95, Level::High));
        assert_eq!(
            top.reasons[0],
            "The agent set the priority to 95 (+75): it writes to the database"
        );
        let adjustment = top
            .factors
            .iter()
            .find(|f| f.component == "adjustment")
            .unwrap();
        assert_eq!(adjustment.points, 75);
        // The components follow the new order.
        assert_eq!(queue.components[0].path.as_deref(), Some("src/repo.rs"));
        // A priority for a unit that is gone changes nothing.
        let mut again = priority();
        apply_overrides(
            &mut again,
            &[UnitPriority {
                checkpoint_id: checkpoint,
                path: "src/gone.rs".into(),
                name: "gone".into(),
                score: 1,
                reason: String::new(),
                set_by: "you".into(),
                updated_at: String::new(),
            }],
        );
        assert_eq!(again.units[0].name, "verify");
        assert!(again.units.iter().all(|u| u.factors.is_empty()));
    }
}
