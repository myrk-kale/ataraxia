//! Autocomplete for the message field: the rest of a word, a phrase, or a name from the code.
//!
//! Three things feed a suggestion. The packaged word lists of the languages the person chose say
//! what is common. A language model (see [`model`]) learns from every message they send, in
//! general and in each chat, and is kept on disk so it survives a restart. The symbols the
//! syntax analyzer finds in the chat's repositories say what the code calls things.
//!
//! Only what the person types is learned: never what an agent writes, never code, paths or
//! addresses (see [`tokens`]). It can be turned off, and forgotten, in Settings.

mod lexicon;
mod model;
mod predict;
mod tokens;

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::domain::ids::SessionId;
use crate::domain::{Error, ErrorCode, Result, SCHEDULED_PREFIX};
use crate::ports::GramRow;

use super::engine::Engine;
use super::schedule::unix_now;

pub use lexicon::LANGUAGES;
use lexicon::LexiconCache;
use model::Model;
pub use predict::{Kind, Predictor, Suggestion};

const SETTINGS_KEY: &str = "autocomplete:settings";
const GLOBAL: &str = "global";
/// How many steps each model keeps: past this the rarest and oldest are dropped.
const GLOBAL_ROWS: usize = 400_000;
const CHAT_ROWS: usize = 80_000;
/// How long the symbols of a chat are trusted before they are looked up again.
const SYMBOLS_TTL: Duration = Duration::from_secs(45);
const SYMBOL_FILES: usize = 2500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutocompleteSettings {
    pub enabled: bool,
    /// Language codes (see [`LANGUAGES`]), the first weighing the most; at most two.
    pub languages: Vec<String>,
    /// Learn from the messages sent.
    pub learn: bool,
    /// Suggest names found in the code.
    pub symbols: bool,
    /// Suggest several words, not only the rest of one.
    pub phrases: bool,
}

impl Default for AutocompleteSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            languages: vec!["en".into()],
            learn: true,
            symbols: true,
            phrases: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AutocompleteLanguage {
    pub code: &'static str,
    pub name: &'static str,
}

pub fn languages() -> Vec<AutocompleteLanguage> {
    LANGUAGES
        .iter()
        .map(|(code, name, _)| AutocompleteLanguage { code, name })
        .collect()
}

/// The languages to start with for a locale such as `pt-BR` or `en_US.UTF-8`: its own, and English
/// next to it, which is what code and tools are written in.
pub fn languages_for_locale(locale: &str) -> Vec<String> {
    let lower = locale.to_lowercase().replace('_', "-");
    let lower = lower.split('.').next().unwrap_or("");
    let primary = match lower.split('-').next().unwrap_or("") {
        "pt" if lower == "pt-pt" => "pt-PT",
        "pt" => "pt-BR",
        "es" => "es",
        "fr" => "fr",
        "de" => "de",
        "it" => "it",
        _ => "en",
    };
    if primary == "en" {
        vec!["en".into()]
    } else {
        vec![primary.into(), "en".into()]
    }
}

impl AutocompleteSettings {
    fn normalized(mut self) -> Self {
        let mut seen = Vec::new();
        for code in self.languages.drain(..) {
            if LANGUAGES.iter().any(|(known, ..)| *known == code) && !seen.contains(&code) {
                seen.push(code);
            }
        }
        seen.truncate(2);
        self.languages = seen;
        self
    }
}

#[derive(Default)]
struct SymbolCache {
    names: Arc<Vec<String>>,
    built: Option<Instant>,
    building: bool,
}

#[derive(Default)]
pub(crate) struct AutocompleteState {
    settings: Mutex<Option<AutocompleteSettings>>,
    models: Mutex<HashMap<String, Model>>,
    lexicons: LexiconCache,
    symbols: Mutex<HashMap<SessionId, SymbolCache>>,
}

fn io(error: impl ToString) -> Error {
    Error::new(ErrorCode::Io, error.to_string())
}

impl Engine {
    /// The settings, starting from `locale` the first time they are asked for.
    pub fn autocomplete_settings(&self, locale: Option<&str>) -> AutocompleteSettings {
        let mut cached = self.autocomplete.settings.lock();
        if let Some(settings) = cached.as_ref() {
            return settings.clone();
        }
        let stored = self
            .db
            .get_preference(SETTINGS_KEY)
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str::<AutocompleteSettings>(&text).ok());
        let settings = match stored {
            Some(stored) => stored.normalized(),
            None => {
                let from = locale
                    .map(str::to_string)
                    .or_else(|| std::env::var("LC_ALL").ok())
                    .or_else(|| std::env::var("LANG").ok())
                    .unwrap_or_default();
                let settings = AutocompleteSettings {
                    languages: languages_for_locale(&from),
                    ..AutocompleteSettings::default()
                };
                if let Ok(text) = serde_json::to_string(&settings) {
                    let _ = self.db.set_preference(SETTINGS_KEY, &text);
                }
                settings
            }
        };
        *cached = Some(settings.clone());
        settings
    }

    pub fn autocomplete_set_settings(
        &self,
        settings: AutocompleteSettings,
    ) -> Result<AutocompleteSettings> {
        let settings = settings.normalized();
        let text = serde_json::to_string(&settings).map_err(io)?;
        self.db.set_preference(SETTINGS_KEY, &text)?;
        *self.autocomplete.settings.lock() = Some(settings.clone());
        Ok(settings)
    }

    /// Forgets everything learned, in general and in every chat.
    pub fn autocomplete_forget(&self) -> Result<()> {
        self.db.autocomplete_clear(None)?;
        self.autocomplete.models.lock().clear();
        Ok(())
    }

    /// Makes sure the model of `scope` is in memory, reading it from disk the first time.
    fn autocomplete_load(&self, models: &mut HashMap<String, Model>, scope: &str) {
        if !models.contains_key(scope) {
            let rows = self.db.autocomplete_load(scope).unwrap_or_default();
            models.insert(scope.to_string(), Model::from_rows(&rows));
        }
    }

    /// What to add after `text`, which ends at the caret, in the chat `session_id`.
    pub fn autocomplete_suggest(
        self: &Arc<Self>,
        session_id: SessionId,
        text: &str,
    ) -> Option<Suggestion> {
        let settings = self.autocomplete_settings(None);
        if !settings.enabled {
            return None;
        }
        let symbols = if settings.symbols {
            self.autocomplete_symbols(session_id)
        } else {
            Arc::default()
        };
        let lexicons = self.autocomplete.lexicons.load(&settings.languages);
        let scope = session_id.0.to_string();
        let mut models = self.autocomplete.models.lock();
        self.autocomplete_load(&mut models, GLOBAL);
        self.autocomplete_load(&mut models, &scope);
        Predictor {
            global: models.get(GLOBAL)?,
            chat: models.get(&scope),
            lexicons: &lexicons,
            symbols: &symbols,
            phrases: settings.phrases,
        }
        .suggest(text)
    }

    /// Learns from a message the person sent. Anything that is not theirs, or not prose, is not
    /// learned.
    pub fn autocomplete_learn(&self, session_id: SessionId, text: &str) {
        let settings = self.autocomplete_settings(None);
        if !settings.enabled || !settings.learn {
            return;
        }
        if text.starts_with(SCHEDULED_PREFIX) || text.starts_with('/') {
            return;
        }
        let (mut sentences, open) = tokens::split(text);
        sentences.push(open);
        let mut rows: HashMap<(String, String), i64> = HashMap::new();
        for sentence in sentences.iter().filter(|sentence| !sentence.is_empty()) {
            for (context, word, count) in Model::rows_for(&tokens::normalize(sentence)) {
                *rows.entry((context, word)).or_default() += count;
            }
        }
        if rows.is_empty() {
            return;
        }
        let rows: Vec<GramRow> = rows
            .into_iter()
            .map(|((context, word), count)| (context, word, count))
            .collect();
        let now = unix_now();
        let chat = session_id.0.to_string();
        let mut models = self.autocomplete.models.lock();
        for (scope, cap) in [(GLOBAL, GLOBAL_ROWS), (chat.as_str(), CHAT_ROWS)] {
            self.autocomplete_load(&mut models, scope);
            if let Err(error) = self.db.autocomplete_add(scope, &rows, now) {
                eprintln!("ataraxia: could not save what autocomplete learned: {error}");
                continue;
            }
            let model = models.get_mut(scope).expect("loaded above");
            model.apply(&rows);
            if model.rows() > cap {
                let _ = self.db.autocomplete_prune(scope, cap * 3 / 4);
                let kept = self.db.autocomplete_load(scope).unwrap_or_default();
                models.insert(scope.to_string(), Model::from_rows(&kept));
            }
        }
    }

    /// The names the syntax analyzer found in the chat's repositories, looked up in the
    /// background and kept for a little while.
    fn autocomplete_symbols(self: &Arc<Self>, session_id: SessionId) -> Arc<Vec<String>> {
        let mut caches = self.autocomplete.symbols.lock();
        let cache = caches.entry(session_id).or_default();
        let stale = cache.built.is_none_or(|at| at.elapsed() > SYMBOLS_TTL);
        if stale && !cache.building {
            cache.building = true;
            let engine = Arc::clone(self);
            std::thread::spawn(move || {
                let names = engine.collect_symbol_names(session_id);
                let mut caches = engine.autocomplete.symbols.lock();
                let cache = caches.entry(session_id).or_default();
                cache.names = Arc::new(names);
                cache.built = Some(Instant::now());
                cache.building = false;
            });
        }
        Arc::clone(&cache.names)
    }

    fn collect_symbol_names(&self, session_id: SessionId) -> Vec<String> {
        let Ok(Some(session)) = self.db.get_session(session_id) else {
            return Vec::new();
        };
        let mut worktrees = vec![session.worktree_id];
        worktrees.extend(self.db.session_worktrees(session_id).unwrap_or_default());
        let mut names = BTreeSet::new();
        let mut files = 0;
        for id in worktrees {
            let Ok(Some(worktree)) = self.db.get_worktree(id) else {
                continue;
            };
            let Ok(listed) = self.git.list_files(&worktree.path) else {
                continue;
            };
            for path in listed {
                if self.syntax.language_of(&path).is_none() {
                    continue;
                }
                files += 1;
                if files > SYMBOL_FILES {
                    break;
                }
                let Ok(content) = self.fs.read_text(&worktree.path, &path) else {
                    continue;
                };
                if content.binary || content.too_large {
                    continue;
                }
                for symbol in self
                    .syntax
                    .symbols(&path, &content.text)
                    .unwrap_or_default()
                {
                    let name = symbol.name;
                    let length = name.chars().count();
                    if (3..=60).contains(&length)
                        && name.chars().all(|c| c.is_alphanumeric() || c == '_')
                    {
                        names.insert(name);
                    }
                }
            }
        }
        names.into_iter().collect()
    }
}

#[cfg(test)]
mod tests;
