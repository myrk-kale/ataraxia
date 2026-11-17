//! An n-gram language model that learns as the person writes.
//!
//! It counts how often a word followed the one, two or three words before it. A prediction mixes
//! the orders from the longest context down to the single word with absolute discounting (the
//! interpolated scheme Kneser-Ney is built on): a context seen often is trusted, a rare one hands
//! most of its weight to the shorter context, and the shortest one hands it to the dictionary.
//! Learning is adding to counts, so it never stops and costs nothing to keep up.

use std::collections::{HashMap, HashSet};

use crate::ports::GramRow;

use super::tokens::{BOS, EOS};

/// How many words before the one being predicted count as its context.
pub const MAX_CONTEXT: usize = 3;
/// What each seen count gives up to the shorter context.
const DISCOUNT: f64 = 0.75;

#[derive(Debug, Default)]
struct Context {
    total: u32,
    words: HashMap<String, u32>,
}

#[derive(Debug, Default)]
pub struct Model {
    grams: HashMap<String, Context>,
    rows: usize,
}

fn key(words: &[String]) -> String {
    words.join(" ")
}

impl Model {
    pub fn from_rows(rows: &[GramRow]) -> Self {
        let mut model = Self::default();
        model.apply(rows);
        model
    }

    /// How many distinct steps are stored.
    pub fn rows(&self) -> usize {
        self.rows
    }

    /// How many words it has seen in all.
    pub fn seen(&self) -> u32 {
        self.grams.get("").map_or(0, |context| context.total)
    }

    /// The steps one sentence teaches: every word after each of the contexts that end before it.
    pub fn rows_for(sentence: &[String]) -> Vec<GramRow> {
        let mut sequence = Vec::with_capacity(sentence.len() + 2);
        sequence.push(BOS.to_string());
        sequence.extend(sentence.iter().cloned());
        sequence.push(EOS.to_string());
        let lower: Vec<String> = sequence.iter().map(|word| word.to_lowercase()).collect();
        let mut counts: HashMap<(String, String), i64> = HashMap::new();
        for index in 1..sequence.len() {
            let word = &sequence[index];
            for order in 0..=index.min(MAX_CONTEXT) {
                if order == 0 && word == EOS {
                    continue;
                }
                let context = key(&lower[index - order..index]);
                *counts.entry((context, word.clone())).or_default() += 1;
            }
        }
        counts
            .into_iter()
            .map(|((context, word), count)| (context, word, count))
            .collect()
    }

    pub fn apply(&mut self, rows: &[GramRow]) {
        for (context, word, count) in rows {
            let count = u32::try_from(*count).unwrap_or(0);
            if count == 0 {
                continue;
            }
            let entry = self.grams.entry(context.clone()).or_default();
            entry.total = entry.total.saturating_add(count);
            let slot = entry.words.entry(word.clone()).or_insert_with(|| {
                self.rows += 1;
                0
            });
            *slot = slot.saturating_add(count);
        }
    }

    /// How likely `word` is after `history` (lowercase, oldest first), with `base` as the odds of
    /// the word knowing nothing about the person: what the shortest context falls back on.
    pub fn probability(&self, history: &[String], word: &str, base: f64) -> f64 {
        let mut probability = base;
        for order in 0..=history.len().min(MAX_CONTEXT) {
            let Some(context) = self.grams.get(&key(&history[history.len() - order..])) else {
                continue;
            };
            let total = f64::from(context.total);
            let count = f64::from(context.words.get(word).copied().unwrap_or(0));
            let distinct = context.words.len() as f64;
            probability =
                (count - DISCOUNT).max(0.0) / total + DISCOUNT * distinct / total * probability;
        }
        probability
    }

    /// How often the longest context of `history` that was ever seen has been seen, leaving out
    /// the empty one: how much there is to go on.
    pub fn support(&self, history: &[String]) -> u32 {
        (1..=history.len().min(MAX_CONTEXT))
            .rev()
            .find_map(|order| self.grams.get(&key(&history[history.len() - order..])))
            .map_or(0, |context| context.total)
    }

    /// The words that followed `history` before and start with `matches`. With `alone` the single
    /// words count too, which is what finishing a word someone has begun looks at.
    pub fn candidates(
        &self,
        history: &[String],
        alone: bool,
        matches: &dyn Fn(&str) -> bool,
        into: &mut HashSet<String>,
    ) {
        for order in usize::from(!alone)..=history.len().min(MAX_CONTEXT) {
            let Some(context) = self.grams.get(&key(&history[history.len() - order..])) else {
                continue;
            };
            for word in context.words.keys() {
                if word != BOS && matches(word) {
                    into.insert(word.clone());
                }
            }
        }
    }
}
