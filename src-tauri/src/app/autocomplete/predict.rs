//! Turns the text before the caret into a suggestion: the rest of the word being typed and, when
//! the model is sure enough, the words that usually follow it.

use std::collections::HashSet;

use serde::Serialize;

use super::lexicon::Lexicons;
use super::model::{MAX_CONTEXT, Model};
use super::tokens::{BOS, EOS, is_word_char, normalize, split};

/// How likely a name from the code is when nothing else is known about it: about as likely as a
/// word in the lower thousands of a dictionary.
const SYMBOL_PRIOR: f64 = 3e-4;
/// A word is only offered, without letters typed, when the model gives it at least this much.
const FIRST_WORD_MIN: f64 = 0.25;
/// Each word added to a phrase has to clear this.
const NEXT_WORD_MIN: f64 = 0.35;
/// How many words a phrase may run to, counting the one being finished.
const MAX_PHRASE: usize = 6;
/// How often a context has to have been seen before it predicts anything on its own.
const MIN_SUPPORT: u32 = 2;
/// How many dictionary words and names are looked at for a prefix.
const SHORTLIST: usize = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Word,
    Phrase,
    Symbol,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Suggestion {
    /// What to add after the caret.
    pub text: String,
    pub kind: Kind,
}

pub struct Predictor<'a> {
    pub global: &'a Model,
    pub chat: Option<&'a Model>,
    pub lexicons: &'a Lexicons,
    pub symbols: &'a [String],
    pub phrases: bool,
}

/// Whether `word` starts with `prefix` and goes on. The case of the letters after the first is
/// only ignored when the person did not use capitals there: `buildAp` means a name, `build` a word.
fn continues(word: &str, prefix: &str) -> bool {
    let exact = prefix.chars().skip(1).any(char::is_uppercase);
    let mut word_chars = word.chars();
    for typed in prefix.chars() {
        let Some(have) = word_chars.next() else {
            return false;
        };
        let same = if exact {
            have == typed
        } else {
            have.to_lowercase().eq(typed.to_lowercase())
        };
        if !same {
            return false;
        }
    }
    word_chars.next().is_some()
}

fn skippable(chunk: &str) -> bool {
    chunk.contains(['/', '\\', '@', '`', '=', '{', '}', '<', '>']) || chunk.contains("://")
}

impl Predictor<'_> {
    fn is_symbol(&self, word: &str) -> bool {
        self.symbols.iter().any(|symbol| symbol == word)
    }

    fn probability(&self, history: &[String], word: &str) -> f64 {
        let lowered = word.to_lowercase();
        let mut base = self.lexicons.probability(&lowered);
        if base < SYMBOL_PRIOR && self.is_symbol(word) {
            base = SYMBOL_PRIOR;
        }
        let global = self.global.probability(history, word, base);
        let Some(chat) = self.chat else {
            return global;
        };
        // A chat counts for more the more has been written in it.
        let seen = f64::from(chat.seen());
        let weight = 0.7 * seen / (seen + 300.0);
        weight * chat.probability(history, word, base) + (1.0 - weight) * global
    }

    fn support(&self, history: &[String]) -> u32 {
        self.global
            .support(history)
            .max(self.chat.map_or(0, |chat| chat.support(history)))
    }

    fn best<'w>(&self, history: &[String], words: &'w HashSet<String>) -> Option<(&'w str, f64)> {
        words
            .iter()
            .map(|word| (word.as_str(), self.probability(history, word)))
            .max_by(|a, b| {
                a.1.total_cmp(&b.1)
                    .then_with(|| b.0.chars().count().cmp(&a.0.chars().count()))
                    .then_with(|| b.0.cmp(a.0))
            })
    }

    /// The word that most likely comes next, leaving a sentence's end out, if it is likely enough.
    fn next_word(&self, history: &[String], minimum: f64) -> Option<String> {
        if self.support(history) < MIN_SUPPORT {
            return None;
        }
        let mut words = HashSet::new();
        let any = |_: &str| true;
        self.global.candidates(history, false, &any, &mut words);
        if let Some(chat) = self.chat {
            chat.candidates(history, false, &any, &mut words);
        }
        let (word, probability) = self.best(history, &words)?;
        (word != EOS && probability >= minimum).then(|| word.to_string())
    }

    /// Finishes the word `prefix` begins.
    fn finish_word(&self, history: &[String], prefix: &str) -> Option<(String, Kind)> {
        let matches = |word: &str| continues(word, prefix);
        let mut words = HashSet::new();
        self.global.candidates(history, true, &matches, &mut words);
        if let Some(chat) = self.chat {
            chat.candidates(history, true, &matches, &mut words);
        }
        let lowered = prefix.to_lowercase();
        for word in self.lexicons.starting_with(&lowered, SHORTLIST) {
            if continues(&word, prefix) {
                words.insert(word);
            }
        }
        let mut names = 0;
        if prefix.chars().count() >= 2 {
            for symbol in self.symbols {
                if continues(symbol, prefix) {
                    words.insert(symbol.clone());
                    names += 1;
                    if names >= SHORTLIST {
                        break;
                    }
                }
            }
        }
        words.remove(EOS);
        let (word, _) = self.best(history, &words)?;
        let kind = if self.is_symbol(word)
            && self.lexicons.probability(&word.to_lowercase()) < SYMBOL_PRIOR
        {
            Kind::Symbol
        } else {
            Kind::Word
        };
        Some((word.to_string(), kind))
    }

    pub fn suggest(&self, text: &str) -> Option<Suggestion> {
        let start = text
            .char_indices()
            .rev()
            .take_while(|(_, c)| is_word_char(*c))
            .last()
            .map_or(text.len(), |(index, _)| index);
        let (before, prefix) = text.split_at(start);
        if text.starts_with('/') && !text.contains(char::is_whitespace) {
            return None;
        }
        if text.split_whitespace().next_back().is_some_and(skippable) {
            return None;
        }
        if prefix.is_empty() {
            if !text.ends_with([' ', '\t']) || text.trim().is_empty() {
                return None;
            }
        } else {
            let first = prefix.chars().next()?;
            if !first.is_alphabetic() || prefix.chars().count() < 2 {
                return None;
            }
            let opener = before.chars().next_back();
            if opener.is_some_and(|c| !c.is_whitespace() && !"([{\"'«“".contains(c)) {
                return None;
            }
        }

        let (_, open) = split(before);
        let mut history: Vec<String> = std::iter::once(BOS.to_string())
            .chain(normalize(&open).iter().map(|word| word.to_lowercase()))
            .collect();
        history.drain(..history.len().saturating_sub(MAX_CONTEXT));

        let (first, kind, already) = if prefix.is_empty() {
            (self.next_word(&history, FIRST_WORD_MIN)?, Kind::Word, 0)
        } else {
            let (word, kind) = self.finish_word(&history, prefix)?;
            (word, kind, prefix.chars().count())
        };
        let mut suggestion: String = first.chars().skip(already).collect();
        if self.phrases && kind != Kind::Symbol {
            let mut context = history;
            let mut words = 1;
            let mut last = first;
            while words < MAX_PHRASE {
                context.push(last.to_lowercase());
                context.drain(..context.len().saturating_sub(MAX_CONTEXT));
                let Some(next) = self.next_word(&context, NEXT_WORD_MIN) else {
                    break;
                };
                suggestion.push(' ');
                suggestion.push_str(&next);
                last = next;
                words += 1;
            }
            if words > 1 {
                return Some(Suggestion {
                    text: suggestion,
                    kind: Kind::Phrase,
                });
            }
        }
        (!suggestion.is_empty()).then_some(Suggestion {
            text: suggestion,
            kind,
        })
    }
}
