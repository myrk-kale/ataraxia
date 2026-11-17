//! The words of a language and how common each is, from the lists packaged with the app
//! (`src-tauri/dictionaries`). They are what suggestions fall back on before the model has
//! learned anything from the person.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

/// `(code, name, word list)` of every language the app ships.
pub const LANGUAGES: &[(&str, &str, &str)] = &[
    (
        "en",
        "English",
        include_str!("../../../dictionaries/en.txt"),
    ),
    (
        "pt-BR",
        "Português (Brasil)",
        include_str!("../../../dictionaries/pt-BR.txt"),
    ),
    (
        "pt-PT",
        "Português (Portugal)",
        include_str!("../../../dictionaries/pt-PT.txt"),
    ),
    (
        "es",
        "Español",
        include_str!("../../../dictionaries/es.txt"),
    ),
    (
        "fr",
        "Français",
        include_str!("../../../dictionaries/fr.txt"),
    ),
    (
        "de",
        "Deutsch",
        include_str!("../../../dictionaries/de.txt"),
    ),
    (
        "it",
        "Italiano",
        include_str!("../../../dictionaries/it.txt"),
    ),
];

/// The probability given to a word no list knows.
const UNSEEN: f64 = 1e-8;

#[derive(Debug, Default)]
pub struct Lexicon {
    /// Sorted by word, so what starts with a prefix is one range.
    words: Vec<(String, u32)>,
    total: f64,
}

impl Lexicon {
    pub fn parse(text: &str) -> Self {
        let mut words: Vec<(String, u32)> = text
            .lines()
            .filter_map(|line| {
                let (word, count) = line.split_once('\t')?;
                Some((word.to_string(), count.trim().parse().ok()?))
            })
            .collect();
        words.sort();
        words.dedup_by(|a, b| a.0 == b.0);
        let total = words.iter().map(|(_, count)| f64::from(*count)).sum();
        Self { words, total }
    }

    /// How likely `word` (lowercase) is among the words of the language.
    pub fn probability(&self, word: &str) -> f64 {
        match self
            .words
            .binary_search_by(|(known, _)| known.as_str().cmp(word))
        {
            Ok(index) if self.total > 0.0 => f64::from(self.words[index].1) / self.total,
            _ => UNSEEN,
        }
    }

    /// The most common words that start with `prefix` (lowercase), commonest first.
    pub fn starting_with(&self, prefix: &str, limit: usize) -> Vec<&str> {
        let from = self
            .words
            .partition_point(|(word, _)| word.as_str() < prefix);
        let mut found: Vec<&(String, u32)> = self.words[from..]
            .iter()
            .take_while(|(word, _)| word.starts_with(prefix))
            .collect();
        found.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        found
            .into_iter()
            .take(limit)
            .map(|(word, _)| word.as_str())
            .collect()
    }
}

/// The lexicons of the chosen languages, the first one weighing the most.
#[derive(Debug, Clone, Default)]
pub struct Lexicons {
    chosen: Vec<(Arc<Lexicon>, f64)>,
}

impl Lexicons {
    pub fn probability(&self, word: &str) -> f64 {
        if self.chosen.is_empty() {
            return UNSEEN;
        }
        self.chosen
            .iter()
            .map(|(lexicon, weight)| weight * lexicon.probability(word))
            .sum()
    }

    pub fn starting_with(&self, prefix: &str, limit: usize) -> Vec<String> {
        let mut words: Vec<String> = Vec::new();
        for (lexicon, _) in &self.chosen {
            for word in lexicon.starting_with(prefix, limit) {
                if !words.iter().any(|known| known == word) {
                    words.push(word.to_string());
                }
            }
        }
        words
    }
}

/// Parses each list once, the first time its language is chosen.
#[derive(Default)]
pub struct LexiconCache {
    parsed: Mutex<HashMap<&'static str, Arc<Lexicon>>>,
}

impl LexiconCache {
    pub fn load(&self, codes: &[String]) -> Lexicons {
        let mut parsed = self.parsed.lock();
        let mut chosen = Vec::new();
        for code in codes {
            let Some((known, _, text)) = LANGUAGES.iter().find(|(known, ..)| known == code) else {
                continue;
            };
            let lexicon = parsed
                .entry(known)
                .or_insert_with(|| Arc::new(Lexicon::parse(text)))
                .clone();
            let weight = if chosen.is_empty() { 1.0 } else { 0.6 };
            chosen.push((lexicon, weight));
        }
        // Weights add up to one, so the mixture is still a probability.
        let sum: f64 = chosen.iter().map(|(_, weight)| weight).sum();
        for (_, weight) in &mut chosen {
            *weight /= sum.max(f64::EPSILON);
        }
        Lexicons { chosen }
    }
}
