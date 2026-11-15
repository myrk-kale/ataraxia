//! What `/name` means for Codex. Its app server has no slash commands: a skill is run by naming it
//! (`$name`) together with a `skill` input item, and a custom prompt is a markdown file whose text
//! the client fills in and sends as the message.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::domain::agent::SlashCommand;

/// A skill, as `skills/list` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: String,
    /// Where it comes from: user, repo, a plugin.
    pub scope: Option<String>,
}

/// A custom prompt: `~/.codex/prompts/<name>.md`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomPrompt {
    pub name: String,
    pub description: String,
    pub hint: Option<String>,
    pub body: String,
}

/// The enabled skills of a `skills/list` answer.
pub fn parse_skills(answer: &Value) -> Vec<Skill> {
    let mut found: Vec<Skill> = Vec::new();
    let entries = answer.get("data").and_then(Value::as_array);
    for skills in entries
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("skills").and_then(Value::as_array))
    {
        for node in skills {
            if node.get("enabled").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let text = |key: &str| {
                node.get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            };
            let (Some(name), Some(path)) = (text("name"), text("path")) else {
                continue;
            };
            if found.iter().any(|skill| skill.name == name) {
                continue;
            }
            found.push(Skill {
                name: name.to_string(),
                description: text("shortDescription")
                    .or_else(|| text("description"))
                    .unwrap_or_default()
                    .to_string(),
                path: path.to_string(),
                scope: text("scope").map(str::to_string),
            });
        }
    }
    found
}

/// Where Codex keeps its custom prompts.
pub fn prompts_dir() -> Option<PathBuf> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))?;
    Some(home.join("prompts"))
}

/// The custom prompts in `dir`, by name.
pub fn read_prompts(dir: &Path) -> Vec<CustomPrompt> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut prompts: Vec<CustomPrompt> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
        .filter_map(|path| {
            let name = path.file_stem()?.to_str()?.to_string();
            let text = std::fs::read_to_string(&path).ok()?;
            Some(parse_prompt(&name, &text))
        })
        .collect();
    prompts.sort_by(|a, b| a.name.cmp(&b.name));
    prompts
}

/// A prompt file: optional front matter (`description`, `argument-hint`), then the text.
pub fn parse_prompt(name: &str, text: &str) -> CustomPrompt {
    let mut description = String::new();
    let mut hint = None;
    let mut body = text;
    if let Some(rest) = text.strip_prefix("---") {
        if let Some((front, after)) = rest.split_once("\n---") {
            for line in front.lines() {
                let Some((key, value)) = line.split_once(':') else {
                    continue;
                };
                let value = value.trim().trim_matches(['"', '\'']).to_string();
                match key.trim() {
                    "description" => description = value,
                    "argument-hint" | "argument_hint" if !value.is_empty() => hint = Some(value),
                    _ => {}
                }
            }
            body = after.trim_start_matches(['\r', '\n']);
        }
    }
    CustomPrompt {
        name: name.to_string(),
        description,
        hint,
        body: body.to_string(),
    }
}

/// What `/` offers for Codex: its skills, then its custom prompts.
pub fn commands(skills: &[Skill], prompts: &[CustomPrompt]) -> Vec<SlashCommand> {
    let skills = skills.iter().map(|skill| SlashCommand {
        name: skill.name.clone(),
        description: skill.description.clone(),
        hint: None,
        source: skill.scope.clone(),
    });
    let prompts = prompts
        .iter()
        .filter(|prompt| !skills_named(skills.clone(), &prompt.name))
        .map(|prompt| SlashCommand {
            name: prompt.name.clone(),
            description: prompt.description.clone(),
            hint: prompt.hint.clone(),
            source: Some("prompt".into()),
        });
    skills.clone().chain(prompts).collect()
}

fn skills_named(mut skills: impl Iterator<Item = SlashCommand>, name: &str) -> bool {
    skills.any(|skill| skill.name == name)
}

/// What a `/name args` message becomes for Codex.
#[derive(Debug, Clone, PartialEq)]
pub struct Invocation {
    pub text: String,
    /// Extra input items that go with the text (the `skill` item of a skill).
    pub items: Vec<Value>,
}

/// The message as Codex takes it: a skill is named with `$` and attached, a custom prompt is
/// filled in. `None` for a message that is no command of Codex's, which goes out as typed.
pub fn invocation(
    command: &str,
    args: &str,
    skills: &[Skill],
    prompts: &[CustomPrompt],
) -> Option<Invocation> {
    if let Some(skill) = skills.iter().find(|skill| skill.name == command) {
        let text = if args.is_empty() {
            format!("${}", skill.name)
        } else {
            format!("${} {args}", skill.name)
        };
        return Some(Invocation {
            text,
            items: vec![json!({ "type": "skill", "name": skill.name, "path": skill.path })],
        });
    }
    let prompt = prompts.iter().find(|prompt| prompt.name == command)?;
    Some(Invocation {
        text: expand(&prompt.body, args),
        items: Vec::new(),
    })
}

/// Splits arguments on spaces, keeping what is inside quotes together.
fn split_args(args: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in args.chars() {
        match (quote, c) {
            (Some(open), c) if c == open => quote = None,
            (Some(_), c) => current.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                started = true;
            }
            (None, c) if c.is_whitespace() => {
                if started || !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            (None, c) => current.push(c),
        }
    }
    if started || !current.is_empty() {
        words.push(current);
    }
    words
}

/// Fills a prompt in: `$ARGUMENTS` is all the arguments, `$1`..`$9` the words, `$NAME` a
/// `NAME=value` argument, `$$` a dollar sign. A placeholder with nothing to put there stays as
/// written, except a missing word, which is empty.
pub fn expand(body: &str, args: &str) -> String {
    let words = split_args(args);
    let mut named: HashMap<String, String> = HashMap::new();
    let mut positional = Vec::new();
    for word in words {
        match word.split_once('=') {
            Some((key, value))
                if key.starts_with(|c: char| c.is_ascii_uppercase())
                    && key
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') =>
            {
                named.insert(key.to_string(), value.to_string());
            }
            _ => positional.push(word),
        }
    }
    let mut out = String::new();
    let mut rest = body;
    while let Some(at) = rest.find('$') {
        out.push_str(&rest[..at]);
        rest = &rest[at + 1..];
        if let Some(after) = rest.strip_prefix('$') {
            out.push('$');
            rest = after;
        } else if let Some(after) = rest.strip_prefix("ARGUMENTS") {
            out.push_str(args.trim());
            rest = after;
        } else if let Some(digit) = rest.chars().next().filter(|c| ('1'..='9').contains(c)) {
            let index = digit as usize - '1' as usize;
            out.push_str(positional.get(index).map_or("", String::as_str));
            rest = &rest[1..];
        } else {
            let end = rest
                .find(|c: char| !(c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
                .unwrap_or(rest.len());
            let key = &rest[..end];
            match named.get(key) {
                Some(value) if !key.is_empty() => {
                    out.push_str(value);
                    rest = &rest[end..];
                }
                _ => out.push('$'),
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(name: &str) -> Skill {
        Skill {
            name: name.into(),
            description: "Does it".into(),
            path: format!("/skills/{name}/SKILL.md"),
            scope: Some("user".into()),
        }
    }

    #[test]
    fn the_enabled_skills_of_the_answer_are_listed_once_by_name() {
        let answer = json!({ "data": [
            { "cwd": "/a", "skills": [
                { "name": "review", "description": "long", "shortDescription": "short",
                  "path": "/s/review/SKILL.md", "scope": "user", "enabled": true },
                { "name": "off", "description": "x", "path": "/s/off/SKILL.md", "enabled": false }
            ]},
            { "cwd": "/b", "skills": [
                { "name": "review", "description": "again", "path": "/other", "enabled": true },
                { "name": "lint", "description": "Lints", "path": "/s/lint/SKILL.md" }
            ]}
        ]});
        let skills = parse_skills(&answer);
        let names: Vec<&str> = skills.iter().map(|skill| skill.name.as_str()).collect();
        assert_eq!(names, ["review", "lint"]);
        assert_eq!(skills[0].description, "short");
        assert_eq!(skills[0].scope.as_deref(), Some("user"));
    }

    #[test]
    fn a_prompt_file_gives_its_hint_description_and_text() {
        let text = "---\ndescription: \"Fix an issue\"\nargument-hint: ISSUE=<number>\n---\nFix $ISSUE now.\n";
        let prompt = parse_prompt("fix", text);
        assert_eq!(prompt.name, "fix");
        assert_eq!(prompt.description, "Fix an issue");
        assert_eq!(prompt.hint.as_deref(), Some("ISSUE=<number>"));
        assert_eq!(prompt.body, "Fix $ISSUE now.\n");
        let plain = parse_prompt("plain", "Just text");
        assert_eq!(plain.body, "Just text");
        assert_eq!(plain.description, "");
        assert_eq!(plain.hint, None);
    }

    #[test]
    fn placeholders_take_the_arguments() {
        assert_eq!(expand("All: $ARGUMENTS", "a  b"), "All: a  b");
        assert_eq!(
            expand("$1 then $2 then $3", "one \"two words\""),
            "one then two words then "
        );
        assert_eq!(
            expand("Fix $ISSUE in $AREA", "ISSUE=42 AREA=\"the api\""),
            "Fix 42 in the api"
        );
        assert_eq!(
            expand("Cost: $$5 and $UNKNOWN", ""),
            "Cost: $5 and $UNKNOWN"
        );
        assert_eq!(expand("$1 $ISSUE", "first ISSUE=7"), "first 7");
        assert_eq!(expand("no placeholders", "ignored"), "no placeholders");
        assert_eq!(expand("price $ 5", ""), "price $ 5");
    }

    #[test]
    fn a_skill_is_named_and_attached_while_a_prompt_is_filled_in() {
        let skills = [skill("review")];
        let prompts = [parse_prompt("fix", "Fix $1 please")];
        let run = invocation("review", "the diff", &skills, &prompts).expect("skill");
        assert_eq!(run.text, "$review the diff");
        assert_eq!(
            run.items,
            vec![json!({ "type": "skill", "name": "review", "path": "/skills/review/SKILL.md" })]
        );
        let bare = invocation("review", "", &skills, &prompts).expect("skill");
        assert_eq!(bare.text, "$review");
        let filled = invocation("fix", "bug-7", &skills, &prompts).expect("prompt");
        assert_eq!(filled.text, "Fix bug-7 please");
        assert!(filled.items.is_empty());
        assert_eq!(invocation("nope", "", &skills, &prompts), None);
    }

    #[test]
    fn the_list_has_skills_first_and_a_prompt_never_hides_a_skill_of_its_name() {
        let skills = [skill("review")];
        let prompts = [parse_prompt("review", "x"), parse_prompt("fix", "y")];
        let list = commands(&skills, &prompts);
        let names: Vec<&str> = list.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, ["review", "fix"]);
        assert_eq!(list[1].source.as_deref(), Some("prompt"));
    }

    #[test]
    fn the_prompts_of_a_folder_are_read_by_name() {
        let dir = std::env::temp_dir().join(format!("ataraxia-prompts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("folder");
        std::fs::write(dir.join("b.md"), "Second").expect("file");
        std::fs::write(dir.join("a.md"), "---\ndescription: First\n---\nOne").expect("file");
        std::fs::write(dir.join("notes.txt"), "not a prompt").expect("file");
        let prompts = read_prompts(&dir);
        std::fs::remove_dir_all(&dir).ok();
        let names: Vec<&str> = prompts.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, ["a", "b"]);
        assert_eq!(prompts[0].description, "First");
        assert!(read_prompts(&dir).is_empty());
    }
}
