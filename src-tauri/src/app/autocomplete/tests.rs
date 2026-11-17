use super::lexicon::LexiconCache;
use super::model::Model;
use super::predict::{Kind, Predictor};
use super::tokens::{normalize, split};
use super::{AutocompleteSettings, languages_for_locale};

fn learn(model: &mut Model, text: &str, times: usize) {
    for _ in 0..times {
        let (mut done, open) = split(text);
        done.push(open);
        for sentence in done.iter().filter(|sentence| !sentence.is_empty()) {
            model.apply(&Model::rows_for(&normalize(sentence)));
        }
    }
}

fn suggest(model: &Model, codes: &[&str], symbols: &[&str], text: &str) -> Option<(String, Kind)> {
    let lexicons =
        LexiconCache::default().load(&codes.iter().map(|c| c.to_string()).collect::<Vec<_>>());
    let symbols: Vec<String> = symbols.iter().map(|s| s.to_string()).collect();
    Predictor {
        global: model,
        chat: None,
        lexicons: &lexicons,
        symbols: &symbols,
        phrases: true,
    }
    .suggest(text)
    .map(|suggestion| (suggestion.text, suggestion.kind))
}

#[test]
fn the_dictionary_finishes_a_word_in_the_chosen_language() {
    let empty = Model::default();
    let (text, kind) = suggest(&empty, &["pt-BR"], &[], "preciso corr").unwrap();
    assert_eq!(kind, Kind::Word);
    assert!(
        text.starts_with("ig") || text.starts_with("e"),
        "got {text}"
    );
    let (english, _) = suggest(&empty, &["en"], &[], "please prev").unwrap();
    assert!(
        english.starts_with("i") || english.starts_with("e"),
        "got {english}"
    );
    assert!(suggest(&empty, &["en"], &[], "c").is_none());
}

#[test]
fn what_is_written_is_learned_and_beats_the_dictionary() {
    let mut model = Model::default();
    learn(&mut model, "o xilofone toca bem", 3);
    let (text, _) = suggest(&model, &["pt-BR"], &[], "o xil").unwrap();
    assert!(text.starts_with("ofone"), "got {text}");
}

#[test]
fn a_phrase_is_offered_once_it_has_been_written_often_enough() {
    let mut model = Model::default();
    learn(&mut model, "por favor revise o diff completo", 3);
    let (text, kind) = suggest(&model, &["en"], &[], "por fa").unwrap();
    assert_eq!(kind, Kind::Phrase);
    assert_eq!(text, "vor revise o diff completo");
    // After a space, the next words come without any letters typed.
    let (next, _) = suggest(&model, &["en"], &[], "por favor ").unwrap();
    assert_eq!(next, "revise o diff completo");
}

#[test]
fn a_phrase_seen_once_is_not_pushed_on_the_person() {
    let mut model = Model::default();
    learn(&mut model, "uma frase rara que escrevi uma vez", 1);
    assert!(suggest(&model, &["en"], &[], "uma frase ").is_none());
}

#[test]
fn a_phrase_stops_where_the_sentences_used_to_stop() {
    let mut model = Model::default();
    learn(&mut model, "rode os testes. depois publique", 3);
    let (text, _) = suggest(&model, &["en"], &[], "rode os te").unwrap();
    assert_eq!(text, "stes");
}

#[test]
fn names_from_the_code_are_suggested_by_prefix_and_case_matters() {
    let empty = Model::default();
    let symbols = ["buildAppState", "BuildQueue"];
    let (text, kind) = suggest(&empty, &["en"], &symbols, "see buildApp").unwrap();
    assert_eq!((text.as_str(), kind), ("State", Kind::Symbol));
    // Capitals after the first letter mean a name: a different case does not match.
    assert!(suggest(&empty, &["en"], &["buildAppState"], "see buildAPP").is_none());
}

#[test]
fn code_paths_and_commands_get_no_suggestion() {
    let empty = Model::default();
    assert!(suggest(&empty, &["en"], &["alpha"], "/comp").is_none());
    assert!(suggest(&empty, &["en"], &["alpha"], "look at src/app/alp").is_none());
    assert!(suggest(&empty, &["en"], &["alpha"], "see @alp").is_none());
}

#[test]
fn code_and_secrets_are_not_learned() {
    let (done, open) = split(
        "use this:\n```\nlet secret_value = 1;\n```\nand the key sk9f8a7b6c5d4e3f2a1b0c9d8e7f6 now https://a.b/c src/x.rs",
    );
    let words: Vec<_> = done.iter().chain([&open]).flatten().cloned().collect();
    assert_eq!(words, ["use", "this", "and", "the", "key", "now"]);
}

#[test]
fn a_capital_at_the_start_of_a_sentence_is_not_a_different_word() {
    let mut model = Model::default();
    learn(&mut model, "Revise o código", 3);
    assert_eq!(
        suggest(&model, &["en"], &[], "Rev").unwrap().0,
        "ise o código"
    );
}

#[test]
fn the_default_languages_follow_the_locale() {
    assert_eq!(languages_for_locale("pt-BR"), ["pt-BR", "en"]);
    assert_eq!(languages_for_locale("pt_PT.UTF-8"), ["pt-PT", "en"]);
    assert_eq!(languages_for_locale("en-US"), ["en"]);
    assert_eq!(languages_for_locale(""), ["en"]);
}

#[test]
fn settings_keep_only_known_languages_and_at_most_two() {
    let settings = AutocompleteSettings {
        languages: vec![
            "xx".into(),
            "es".into(),
            "es".into(),
            "fr".into(),
            "de".into(),
        ],
        ..Default::default()
    }
    .normalized();
    assert_eq!(settings.languages, ["es", "fr"]);
}
