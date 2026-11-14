//! Launch profiles: the ways a harness can be started.
//!
//! A person with more than one account on a harness (a work and a personal Claude, say) keeps one
//! profile per account. A profile is a command, written the way it would be in a terminal: any
//! `NAME=value` settings first (usually the variable that points the harness at another
//! account's folder), then optionally the program and its arguments. The default way of starting
//! a harness is not a profile; it is what is used when none is chosen.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::agent::ProviderKind;
use super::{Error, ErrorCode, Result};

/// The preference that keeps every profile and which one is active for each harness.
pub const PROFILES_KEY: &str = "harness_profiles";

const NAME_MAX: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessProfile {
    /// Empty on a profile that has not been saved yet.
    #[serde(default)]
    pub id: String,
    pub provider: ProviderKind,
    pub name: String,
    /// `#rrggbb`: the glow behind the harness's mark.
    pub color: String,
    /// What starts the harness, as typed in a terminal.
    pub command: String,
}

/// Every profile, and the one in use for each harness (none means the default).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profiles {
    #[serde(default)]
    pub profiles: Vec<HarnessProfile>,
    /// Harness name (`claude`, `codex`...) to the id of its active profile.
    #[serde(default)]
    pub active: BTreeMap<String, String>,
}

impl Profiles {
    /// Reads the stored value. Anything unreadable counts as no profiles: the harnesses then
    /// start the default way.
    pub fn parse(json: Option<&str>) -> Self {
        json.and_then(|text| serde_json::from_str(text).ok())
            .unwrap_or_default()
    }

    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string(self).map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
    }

    pub fn get(&self, id: &str) -> Option<&HarnessProfile> {
        self.profiles.iter().find(|profile| profile.id == id)
    }

    /// The profile the harness starts with, if one is chosen and still exists.
    pub fn active_for(&self, provider: ProviderKind) -> Option<&HarnessProfile> {
        let id = self.active.get(provider.as_str())?;
        self.get(id).filter(|profile| profile.provider == provider)
    }

    /// Adds a profile, or replaces the one with the same id. Returns it as kept.
    pub fn save(&mut self, mut profile: HarnessProfile) -> Result<HarnessProfile> {
        profile.name = profile.name.trim().to_string();
        profile.color = profile.color.trim().to_lowercase();
        profile.command = profile.command.trim().to_string();
        if matches!(profile.provider, ProviderKind::Fake) {
            return Err(invalid("the demo provider has no profiles"));
        }
        if profile.name.is_empty() {
            return Err(invalid("a profile needs a name"));
        }
        if profile.name.chars().count() > NAME_MAX {
            return Err(invalid(format!(
                "a profile name is at most {NAME_MAX} characters"
            )));
        }
        if !is_color(&profile.color) {
            return Err(invalid("the colour is written as #rrggbb"));
        }
        parse_command(&profile.command, None)?;
        let taken = self.profiles.iter().any(|other| {
            other.provider == profile.provider
                && other.id != profile.id
                && other.name.to_lowercase() == profile.name.to_lowercase()
        });
        if taken {
            return Err(invalid(format!(
                "there is already a profile called {}",
                profile.name
            )));
        }
        if profile.id.is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }
        match self
            .profiles
            .iter_mut()
            .find(|other| other.id == profile.id)
        {
            Some(slot) => {
                if slot.provider != profile.provider {
                    return Err(invalid("a profile cannot move to another harness"));
                }
                *slot = profile.clone();
            }
            None => self.profiles.push(profile.clone()),
        }
        Ok(profile)
    }

    /// Removes a profile. If it was the active one the harness goes back to the default.
    pub fn delete(&mut self, id: &str) {
        self.profiles.retain(|profile| profile.id != id);
        self.active.retain(|_, active| active != id);
    }

    /// Chooses the profile a harness starts with; `None` is the default.
    pub fn set_active(&mut self, provider: ProviderKind, id: Option<&str>) -> Result<()> {
        match id {
            None => {
                self.active.remove(provider.as_str());
            }
            Some(id) => {
                let found = self
                    .get(id)
                    .is_some_and(|profile| profile.provider == provider);
                if !found {
                    return Err(Error::new(
                        ErrorCode::NotFound,
                        "that profile does not exist",
                    ));
                }
                self.active
                    .insert(provider.as_str().to_string(), id.to_string());
            }
        }
        Ok(())
    }
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(ErrorCode::Invalid, message)
}

fn is_color(text: &str) -> bool {
    text.len() == 7 && text.starts_with('#') && text[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// A profile's command taken apart.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchCommand {
    /// `NAME=value` settings that precede the program.
    pub env: Vec<(String, String)>,
    /// The program, as written. `None` when the command only sets variables: the harness's
    /// usual program is then used.
    pub program: Option<String>,
    pub args: Vec<String>,
}

fn is_env_name(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Splits a command into words the way a shell would for the simple cases: spaces separate,
/// single quotes keep everything, double quotes keep everything but `\"` and `\\`, and a
/// backslash outside quotes takes the next character literally. Nothing is expanded.
fn split_words(text: &str) -> Result<Vec<String>> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(inner) => current.push(inner),
                        None => return Err(invalid("a single quote is not closed")),
                    }
                }
            }
            '"' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(escaped @ ('"' | '\\')) => current.push(escaped),
                            Some(other) => {
                                current.push('\\');
                                current.push(other);
                            }
                            None => return Err(invalid("a double quote is not closed")),
                        },
                        Some(inner) => current.push(inner),
                        None => return Err(invalid("a double quote is not closed")),
                    }
                }
            }
            '\\' => {
                started = true;
                match chars.next() {
                    Some(escaped) => current.push(escaped),
                    None => current.push('\\'),
                }
            }
            c if c.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            c => {
                started = true;
                current.push(c);
            }
        }
    }
    if started {
        words.push(current);
    }
    Ok(words)
}

/// `~` and `~/rest` in a word, as the home folder. Other words are returned as they are.
fn expand_home(word: &str, home: Option<&Path>) -> String {
    let Some(home) = home else {
        return word.to_string();
    };
    if word == "~" {
        return home.to_string_lossy().into_owned();
    }
    match word.strip_prefix("~/") {
        Some(rest) => home.join(rest).to_string_lossy().into_owned(),
        None => word.to_string(),
    }
}

/// Takes a profile's command apart: leading `NAME=value` settings, then the program and its
/// arguments. A `~` at the start of a word (or of a setting's value) is the home folder when
/// `home` is given. An empty command is refused; one made only of settings is allowed.
pub fn parse_command(text: &str, home: Option<&Path>) -> Result<LaunchCommand> {
    let words = split_words(text)?;
    if words.is_empty() {
        return Err(invalid("a profile needs a command"));
    }
    let mut command = LaunchCommand::default();
    let mut rest = words.into_iter().peekable();
    while let Some(word) = rest.peek() {
        let Some((name, value)) = word.split_once('=') else {
            break;
        };
        if !is_env_name(name) {
            break;
        }
        command
            .env
            .push((name.to_string(), expand_home(value, home)));
        rest.next();
    }
    if let Some(program) = rest.next() {
        command.program = Some(expand_home(&program, home));
        command.args = rest.map(|word| expand_home(&word, home)).collect();
    }
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(provider: ProviderKind, name: &str, command: &str) -> HarnessProfile {
        HarnessProfile {
            id: String::new(),
            provider,
            name: name.into(),
            color: "#3b82f6".into(),
            command: command.into(),
        }
    }

    #[test]
    fn a_command_is_settings_then_program_then_arguments() {
        let command = parse_command("CLAUDE_CONFIG_DIR=/a/b FOO=1 claude --verbose -p x", None)
            .expect("parse");
        assert_eq!(
            command.env,
            vec![
                ("CLAUDE_CONFIG_DIR".to_string(), "/a/b".to_string()),
                ("FOO".to_string(), "1".to_string())
            ]
        );
        assert_eq!(command.program.as_deref(), Some("claude"));
        assert_eq!(command.args, vec!["--verbose", "-p", "x"]);
    }

    #[test]
    fn a_command_of_settings_alone_keeps_the_usual_program() {
        let command = parse_command("CODEX_HOME=/work/codex", None).expect("parse");
        assert_eq!(command.program, None);
        assert_eq!(command.env.len(), 1);
    }

    #[test]
    fn quotes_keep_spaces_and_a_setting_after_the_program_is_an_argument() {
        let command = parse_command(r#"NAME="two words" 'my tool' --flag "a \"b\"" X=1"#, None)
            .expect("parse");
        assert_eq!(
            command.env,
            vec![("NAME".to_string(), "two words".to_string())]
        );
        assert_eq!(command.program.as_deref(), Some("my tool"));
        assert_eq!(command.args, vec!["--flag", r#"a "b""#, "X=1"]);
    }

    #[test]
    fn a_backslash_takes_the_next_character_and_an_empty_pair_of_quotes_is_a_word() {
        let command = parse_command(r"tool a\ b ''", None).expect("parse");
        assert_eq!(command.args, vec!["a b", ""]);
    }

    #[test]
    fn nothing_is_expanded_but_the_home_folder() {
        let home = Path::new("/home/me");
        let command = parse_command("DIR=~/.claude-work ~/bin/claude ~ $HOME ~other", Some(home))
            .expect("parse");
        assert_eq!(command.env[0].1, "/home/me/.claude-work");
        assert_eq!(command.program.as_deref(), Some("/home/me/bin/claude"));
        assert_eq!(command.args, vec!["/home/me", "$HOME", "~other"]);
        // Without a home, words are kept as written.
        let bare = parse_command("~/bin/claude", None).expect("parse");
        assert_eq!(bare.program.as_deref(), Some("~/bin/claude"));
    }

    #[test]
    fn an_empty_command_or_an_open_quote_is_refused() {
        assert!(parse_command("   ", None).is_err());
        assert!(parse_command("claude 'oops", None).is_err());
        assert!(parse_command("claude \"oops", None).is_err());
    }

    #[test]
    fn a_word_with_an_equals_sign_that_is_not_a_name_is_the_program() {
        let command = parse_command("./a=b --x", None).expect("parse");
        assert_eq!(command.program.as_deref(), Some("./a=b"));
        assert!(command.env.is_empty());
    }

    #[test]
    fn saving_trims_validates_and_gives_an_id() {
        let mut all = Profiles::default();
        let kept = all
            .save(HarnessProfile {
                color: " #AABBCC ".into(),
                ..profile(ProviderKind::Claude, "  Work  ", "  CLAUDE_CONFIG_DIR=/w  ")
            })
            .expect("save");
        assert_eq!(kept.name, "Work");
        assert_eq!(kept.color, "#aabbcc");
        assert_eq!(kept.command, "CLAUDE_CONFIG_DIR=/w");
        assert!(!kept.id.is_empty());
        assert_eq!(all.profiles.len(), 1);
    }

    #[test]
    fn saving_refuses_what_cannot_work() {
        let mut all = Profiles::default();
        assert!(
            all.save(profile(ProviderKind::Claude, "", "claude"))
                .is_err()
        );
        assert!(
            all.save(profile(ProviderKind::Claude, &"x".repeat(41), "claude"))
                .is_err()
        );
        assert!(all.save(profile(ProviderKind::Claude, "A", "")).is_err());
        assert!(
            all.save(profile(ProviderKind::Fake, "A", "claude"))
                .is_err()
        );
        let mut bad = profile(ProviderKind::Claude, "A", "claude");
        for color in ["red", "#fff", "#gggggg", "aabbcc"] {
            bad.color = color.into();
            assert!(all.save(bad.clone()).is_err(), "{color}");
        }
        assert!(all.profiles.is_empty());
    }

    #[test]
    fn two_profiles_of_a_harness_cannot_share_a_name_but_two_harnesses_can() {
        let mut all = Profiles::default();
        all.save(profile(ProviderKind::Claude, "Work", "claude"))
            .expect("first");
        assert!(
            all.save(profile(ProviderKind::Claude, "work", "claude"))
                .is_err()
        );
        assert!(
            all.save(profile(ProviderKind::Codex, "Work", "codex"))
                .is_ok()
        );
    }

    #[test]
    fn editing_replaces_the_profile_and_can_keep_its_own_name() {
        let mut all = Profiles::default();
        let mut work = all
            .save(profile(ProviderKind::Claude, "Work", "claude"))
            .expect("save");
        work.command = "CLAUDE_CONFIG_DIR=/w claude".into();
        let edited = all.save(work.clone()).expect("edit");
        assert_eq!(all.profiles.len(), 1);
        assert_eq!(
            all.get(&edited.id).map(|p| p.command.as_str()),
            Some("CLAUDE_CONFIG_DIR=/w claude")
        );
        // It cannot be moved to another harness under the same id.
        work.provider = ProviderKind::Codex;
        assert!(all.save(work).is_err());
    }

    #[test]
    fn the_active_profile_is_per_harness_and_deleting_it_goes_back_to_the_default() {
        let mut all = Profiles::default();
        let work = all
            .save(profile(ProviderKind::Claude, "Work", "claude"))
            .expect("save");
        let other = all
            .save(profile(ProviderKind::Codex, "Other", "codex"))
            .expect("save");
        assert!(all.active_for(ProviderKind::Claude).is_none());
        all.set_active(ProviderKind::Claude, Some(&work.id))
            .expect("set");
        assert_eq!(
            all.active_for(ProviderKind::Claude)
                .map(|p| p.name.as_str()),
            Some("Work")
        );
        assert!(all.active_for(ProviderKind::Codex).is_none());
        // A profile of one harness cannot be made active for another.
        assert!(
            all.set_active(ProviderKind::Claude, Some(&other.id))
                .is_err()
        );
        assert!(
            all.set_active(ProviderKind::Claude, Some("missing"))
                .is_err()
        );
        all.delete(&work.id);
        assert!(all.active_for(ProviderKind::Claude).is_none());
        assert!(all.active.is_empty());
        all.set_active(ProviderKind::Codex, Some(&other.id))
            .expect("set");
        all.set_active(ProviderKind::Codex, None).expect("default");
        assert!(all.active_for(ProviderKind::Codex).is_none());
    }

    #[test]
    fn what_is_stored_comes_back_and_what_is_unreadable_is_nothing() {
        let mut all = Profiles::default();
        let work = all
            .save(profile(ProviderKind::Claude, "Work", "claude"))
            .expect("save");
        all.set_active(ProviderKind::Claude, Some(&work.id))
            .expect("set");
        let json = all.to_json().expect("json");
        assert_eq!(Profiles::parse(Some(&json)), all);
        assert_eq!(Profiles::parse(Some("not json")), Profiles::default());
        assert_eq!(Profiles::parse(None), Profiles::default());
    }

    #[test]
    fn an_active_id_that_no_longer_exists_means_the_default() {
        let mut all = Profiles::default();
        all.active.insert("claude".into(), "gone".into());
        assert!(all.active_for(ProviderKind::Claude).is_none());
    }
}
