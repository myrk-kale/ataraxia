//! Splits what the person wrote into sentences of words, the unit the model learns from.
//!
//! Only prose is kept: code fences, inline code, paths, addresses and anything that looks like a
//! secret never become words, so they are neither learned nor suggested back.

/// Stands for the start of a sentence in a context.
pub const BOS: &str = "<s>";
/// Stands for the end of a sentence: what lets a phrase stop where people usually stop.
pub const EOS: &str = "</s>";

pub fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-'
}

fn skippable(chunk: &str) -> bool {
    chunk.contains(['/', '\\', '@', '`', '=', '{', '}', '<', '>']) || chunk.contains("://")
}

fn acceptable(token: &str) -> bool {
    let length = token.chars().count();
    if !(1..=40).contains(&length) || !token.chars().any(char::is_alphabetic) {
        return false;
    }
    // A long run of letters and digits is a key or a hash, not something to suggest back.
    let digits = token.chars().any(|c| c.is_ascii_digit());
    !(length >= 20 && digits)
}

/// The sentences of `text` that are finished, and the one still being written (empty when the
/// text ends where a sentence does).
pub fn split(text: &str) -> (Vec<Vec<String>>, Vec<String>) {
    let mut done: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut fenced = false;
    let lines: Vec<&str> = text.split('\n').collect();
    for (index, line) in lines.iter().enumerate() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if !fenced {
            for chunk in line.split_whitespace() {
                if skippable(chunk) {
                    continue;
                }
                for raw in chunk.split(|c: char| !is_word_char(c)) {
                    let token = raw.trim_matches(['-', '_']);
                    if acceptable(token) {
                        current.push(token.to_string());
                    }
                }
                if chunk.ends_with(['.', '!', '?', ';']) && !current.is_empty() {
                    done.push(std::mem::take(&mut current));
                }
            }
        }
        // A line break ends the sentence; the last line is still being typed.
        if index + 1 < lines.len() && !current.is_empty() {
            done.push(std::mem::take(&mut current));
        }
    }
    (done, current)
}

/// A word at the start of a sentence is written with a capital that says nothing about the
/// word: the model keeps it as it is spelled elsewhere.
pub fn normalize(sentence: &[String]) -> Vec<String> {
    sentence
        .iter()
        .enumerate()
        .map(|(index, word)| {
            let mut chars = word.chars();
            let only_first_upper =
                chars.next().is_some_and(char::is_uppercase) && !chars.any(char::is_uppercase);
            if index == 0 && only_first_upper {
                word.to_lowercase()
            } else {
                word.clone()
            }
        })
        .collect()
}
