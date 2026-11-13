//! The scoring model for review units: itemised points, each with the reason it was given.
//!
//! Priority is an ordering of review work, never a verdict. Everything here comes from facts a
//! parser and git can state (what changed, who is exposed to it, how branchy it is, which risky
//! constructs it holds, whether a test mentions it). No model is involved, so the same diff gives
//! the same queue and every point can be argued with.

use super::review::{Level, ScoreFactor, Unit, UnitChange, UnitMarker, is_test};
use crate::domain::{RiskMarker, Symbol};

/// Points per fact. These are the defaults of the model; they are not configurable yet.
mod weight {
    pub const CONTRACT: i32 = 25;
    pub const ENTRY_EXTERNAL: i32 = 20;
    pub const ENTRY_INTERNAL: i32 = 8;
    pub const FAN_IN: i32 = 10;
    pub const CROSS_MODULE: i32 = 15;
    pub const GLOBAL: i32 = 20;
    pub const SENSITIVE: i32 = 15;
    pub const COMPLEXITY: i32 = 10;
    pub const COMPLEXITY_GROWTH: i32 = 8;
    pub const RISK_CRITICAL: i32 = 30;
    pub const RISK: i32 = 15;
    pub const RISK_PERF: i32 = 7;
    pub const RISK_CAP: i32 = 60;
    pub const NO_TESTS: i32 = 8;
    pub const FORMAT_ONLY: i32 = -40;
    pub const TEST_FILE: i32 = -15;
    pub const GENERATED: i32 = -30;
    pub const FAN_IN_THRESHOLD: u32 = 5;
    pub const GLOBAL_DIRS: u32 = 3;
    pub const COMPLEXITY_THRESHOLD: u32 = 15;
}

const SENSITIVE_WORDS: &[&str] = &[
    "auth",
    "authn",
    "authz",
    "authenticate",
    "authorize",
    "login",
    "logout",
    "session",
    "sessions",
    "password",
    "passwd",
    "credential",
    "credentials",
    "token",
    "tokens",
    "jwt",
    "oauth",
    "permission",
    "permissions",
    "acl",
    "rbac",
    "role",
    "roles",
    "payment",
    "payments",
    "billing",
    "charge",
    "invoice",
    "checkout",
    "crypto",
    "encrypt",
    "decrypt",
    "secret",
    "secrets",
    "migration",
    "migrations",
    "schema",
    "transaction",
    "transactions",
    "admin",
    "privilege",
    "privileges",
];

/// Splits text into lower-case words on non-alphanumerics and camel-case boundaries, so that
/// `validateToken` has the words `validate` and `token` and `authority` does not contain `auth`.
pub fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut previous: Option<char> = None;
    for c in text.chars() {
        if !c.is_alphanumeric() {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            previous = None;
            continue;
        }
        let boundary =
            previous.is_some_and(|p| (p.is_lowercase() || p.is_ascii_digit()) && c.is_uppercase());
        if boundary && !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
        current.extend(c.to_lowercase());
        previous = Some(c);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// The first sensitive word in any of the texts. A sensitive name raises attention, never
/// certainty.
pub fn sensitive_word<'a>(texts: impl IntoIterator<Item = &'a str>) -> Option<String> {
    texts
        .into_iter()
        .flat_map(words)
        .find(|word| SENSITIVE_WORDS.contains(&word.as_str()))
}

/// Whether a path or the top of a file says it was produced by a tool.
pub fn looks_generated(path: &str, head_text: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let by_path = [
        ".generated.",
        "_generated.",
        "/generated/",
        "__generated__",
        ".min.",
        ".pb.go",
        "_pb2.",
        "/dist/",
        "/vendor/",
        "node_modules/",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    let top: String = head_text.chars().take(400).collect();
    by_path
        || top.contains("@generated")
        || top.contains("DO NOT EDIT")
        || top.contains("Code generated")
}

const EXTERNAL_ATTRIBUTES: &[&str] = &[
    "tauri::command",
    "mapping(",
    ".route(",
    "@route",
    "@get",
    "@post",
    "@put",
    "@delete",
    "@patch",
    "#[get(",
    "#[post(",
    "#[put(",
    "#[delete(",
    "#[patch(",
    "@app.",
    "@router.",
    "@api.",
    "@bp.",
    "@blueprint",
    "@controller",
    "@command",
    ".command(",
];

/// How the outside reaches a callable: a route, a command or `main` (external), or just an
/// exported symbol (internal).
pub fn entry_of(symbol: &Symbol, path: &str) -> Option<String> {
    if !matches!(symbol.kind.as_str(), "function" | "method") {
        return None;
    }
    let attributes = symbol.attributes.join(" ").to_ascii_lowercase();
    let routed = path.to_ascii_lowercase().split('/').any(|part| {
        matches!(
            part,
            "routes" | "controllers" | "handlers" | "api" | "commands"
        )
    }) && symbol.public;
    if (symbol.name == "main" && symbol.container.is_none())
        || EXTERNAL_ATTRIBUTES
            .iter()
            .any(|needle| attributes.contains(needle))
        || routed
    {
        Some("external".into())
    } else if symbol.public {
        Some("internal".into())
    } else {
        None
    }
}

fn marker_title(rule: &str) -> &'static str {
    match rule {
        "sql_from_dynamic_text" => "SQL built from dynamic text",
        "secret_literal" => "Possible hard-coded secret",
        "dynamic_execution" => "Evaluates text as code",
        "shell_execution" => "Runs a shell command",
        "verification_disabled" => "Certificate verification disabled",
        "unsafe_block" => "Unsafe block",
        "swallowed_error" => "Error swallowed",
        "io_in_loop" => "I/O inside a loop",
        _ => "Risky construct",
    }
}

fn marker_weight(rule: &str) -> i32 {
    match rule {
        "sql_from_dynamic_text"
        | "secret_literal"
        | "dynamic_execution"
        | "shell_execution"
        | "verification_disabled" => weight::RISK_CRITICAL,
        "io_in_loop" => weight::RISK_PERF,
        _ => weight::RISK,
    }
}

/// The markers of a symbol, flagged by whether the change touched their line.
pub fn unit_markers(markers: &[RiskMarker], touched: impl Fn(u32) -> bool) -> Vec<UnitMarker> {
    markers
        .iter()
        .map(|marker| UnitMarker {
            rule: marker.rule.clone(),
            title: marker_title(&marker.rule).into(),
            line: marker.line,
            introduced: touched(marker.line),
        })
        .collect()
}

fn add(factors: &mut Vec<ScoreFactor>, component: &str, points: i32, reason: impl Into<String>) {
    if points != 0 {
        factors.push(ScoreFactor {
            component: component.into(),
            points,
            reason: reason.into(),
        });
    }
}

fn signed(points: i32) -> String {
    if points > 0 {
        format!("+{points}")
    } else {
        points.to_string()
    }
}

/// Scores a symbol unit and writes the itemised factors, the total, the level and the reasons.
pub fn score_unit(unit: &mut Unit) {
    let mut factors: Vec<ScoreFactor> = Vec::new();
    let callable = matches!(unit.kind.as_str(), "function" | "method");
    let lines = unit.additions + unit.deletions;
    let in_test = is_test(&unit.path.to_ascii_lowercase());

    // Contract: what callers depend on.
    if !in_test {
        match unit.change {
            UnitChange::Removed if unit.public => add(
                &mut factors,
                "contract",
                weight::CONTRACT,
                format!("a public {} was removed", unit.kind),
            ),
            UnitChange::Added if unit.public && unit.container.is_none() => add(
                &mut factors,
                "contract",
                weight::CONTRACT / 2,
                format!("a new public {} extends the API", unit.kind),
            ),
            _ if unit.signature_changed && unit.public => add(
                &mut factors,
                "contract",
                weight::CONTRACT,
                format!("the declaration of a public {} changed", unit.kind),
            ),
            _ if unit.signature_changed => add(
                &mut factors,
                "contract",
                weight::CONTRACT / 2,
                "the declaration changed",
            ),
            _ => {}
        }
    }
    let contract = factors.iter().any(|factor| factor.component == "contract");

    // Reach: who can be hurt by it.
    match unit.entry.as_deref() {
        Some("external") => add(
            &mut factors,
            "reach",
            weight::ENTRY_EXTERNAL,
            "an external entry point (route, command, main)",
        ),
        Some("internal") => add(
            &mut factors,
            "reach",
            weight::ENTRY_INTERNAL,
            "exported, so other code can call it",
        ),
        _ => {}
    }
    if unit.references >= weight::FAN_IN_THRESHOLD {
        add(
            &mut factors,
            "reach",
            weight::FAN_IN,
            format!("mentioned in {} other files", unit.references),
        );
    }
    if unit.dirs >= weight::GLOBAL_DIRS {
        add(
            &mut factors,
            "reach",
            weight::GLOBAL,
            format!("used from {} other folders", unit.dirs),
        );
    } else if unit.dirs >= 1 {
        add(
            &mut factors,
            "reach",
            weight::CROSS_MODULE,
            "used from another folder",
        );
    }

    // A sensitive area asks for attention, nothing more.
    if let Some(word) = &unit.sensitive {
        if !unit.format_only {
            add(
                &mut factors,
                "sensitivity",
                weight::SENSITIVE,
                format!("touches a sensitive area (`{word}`)"),
            );
        }
    }

    // Complexity.
    if unit.complexity >= weight::COMPLEXITY_THRESHOLD {
        add(
            &mut factors,
            "complexity",
            weight::COMPLEXITY,
            format!("cyclomatic complexity {}", unit.complexity),
        );
    }
    if let Some(before) = unit.complexity_before {
        let now = unit.complexity;
        if now >= before + 5 && now * 10 >= before * 13 {
            add(
                &mut factors,
                "complexity",
                weight::COMPLEXITY_GROWTH,
                format!("complexity grew from {before} to {now}"),
            );
        }
    }

    // Risky constructs in the code as it is after the change. Critical ones weigh double.
    let mut risk_so_far = 0;
    for marker in &unit.markers {
        let granted = marker_weight(&marker.rule).min((weight::RISK_CAP - risk_so_far).max(0));
        risk_so_far += granted;
        add(
            &mut factors,
            "risk",
            granted,
            format!(
                "{} ({})",
                marker.title.to_ascii_lowercase(),
                if marker.introduced {
                    "in the changed lines"
                } else {
                    "already in this code"
                }
            ),
        );
    }

    // Tests: not finding one is a signal, not a fact about the code.
    if callable
        && unit.tested == Some(false)
        && !in_test
        && !unit.format_only
        && unit.change != UnitChange::Removed
    {
        add(
            &mut factors,
            "tests",
            weight::NO_TESTS,
            "no test file mentions it (that does not prove there is no test)",
        );
    }

    // Size: a long change needs more reading, whatever it touches.
    if !unit.format_only {
        let points = (((1 + lines) as f64).ln() * 3.0).min(12.0).round() as i32;
        if lines >= 10 {
            add(
                &mut factors,
                "size",
                points,
                format!("{lines} lines changed"),
            );
        }
    }

    // What lowers it.
    if unit.format_only {
        add(
            &mut factors,
            "mitigation",
            weight::FORMAT_ONLY,
            "only whitespace or comments changed",
        );
    }
    if in_test {
        add(
            &mut factors,
            "mitigation",
            weight::TEST_FILE,
            "the file is a test",
        );
    }
    if unit.generated {
        add(
            &mut factors,
            "mitigation",
            weight::GENERATED,
            "the file looks generated",
        );
    }
    let _ = contract;

    let total: i32 = factors.iter().map(|factor| factor.points).sum();
    unit.score = total.clamp(0, 100) as u32;
    unit.level = Level::of_unit(unit.score);
    let mut ordered: Vec<&ScoreFactor> = factors.iter().collect();
    ordered.sort_by_key(|factor| std::cmp::Reverse(factor.points.abs()));
    unit.reasons = ordered
        .iter()
        .map(|factor| format!("{} ({})", factor.reason, signed(factor.points)))
        .collect();
    if unit.reasons.is_empty() {
        unit.reasons.push("small, contained change".into());
    }
    unit.factors = factors;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::review::{Level, Unit, UnitChange};

    fn unit() -> Unit {
        Unit {
            id: String::new(),
            name: "Repo.create".into(),
            kind: "method".into(),
            path: "src/repo.rs".into(),
            start_line: 1,
            end_line: 9,
            side: "head".into(),
            change: UnitChange::Modified,
            signature_changed: false,
            public: false,
            references: 0,
            additions: 3,
            deletions: 1,
            score: 0,
            level: Level::Low,
            reasons: Vec::new(),
            container: Some("Repo".into()),
            factors: Vec::new(),
            complexity: 2,
            complexity_before: Some(2),
            format_only: false,
            markers: Vec::new(),
            entry: None,
            sensitive: None,
            tested: None,
            dirs: 0,
            generated: false,
        }
    }

    #[test]
    fn identifiers_are_split_into_whole_words() {
        assert_eq!(words("validateToken"), vec!["validate", "token"]);
        assert_eq!(
            sensitive_word(["src/auth/views.py"]).as_deref(),
            Some("auth")
        );
        assert_eq!(
            sensitive_word(["authority", "tokenizer", "authorsList"]),
            None
        );
    }

    #[test]
    fn a_small_private_change_is_low_and_says_so() {
        let mut small = unit();
        score_unit(&mut small);
        assert_eq!(small.level, Level::Low);
        assert_eq!(small.reasons, vec!["small, contained change"]);
    }

    #[test]
    fn a_changed_public_signature_reached_from_outside_ranks_first_and_explains_every_point() {
        let mut risky = unit();
        risky.public = true;
        risky.signature_changed = true;
        risky.entry = Some("external".into());
        risky.references = 7;
        risky.dirs = 3;
        risky.tested = Some(false);
        risky.sensitive = Some("token".into());
        risky.markers = unit_markers(
            &[RiskMarker {
                rule: "sql_from_dynamic_text".into(),
                line: 4,
            }],
            |line| line == 4,
        );
        score_unit(&mut risky);
        assert_eq!(risky.level, Level::High);
        let total: i32 = risky.factors.iter().map(|f| f.points).sum();
        assert_eq!(i32::try_from(risky.score).unwrap(), total.clamp(0, 100));
        let components: Vec<&str> = risky.factors.iter().map(|f| f.component.as_str()).collect();
        for expected in ["contract", "reach", "sensitivity", "risk", "tests"] {
            assert!(
                components.contains(&expected),
                "{expected} in {components:?}"
            );
        }
        assert!(risky.reasons.iter().all(|reason| reason.ends_with(')')));
        assert!(risky.reasons[0].contains("(+30)") || risky.reasons[0].contains("(+25)"));
    }

    #[test]
    fn formatting_tests_and_generated_code_sink() {
        let mut format_only = unit();
        format_only.public = true;
        format_only.entry = Some("internal".into());
        format_only.format_only = true;
        format_only.additions = 40;
        score_unit(&mut format_only);
        assert_eq!(format_only.level, Level::Low);
        assert!(
            format_only
                .reasons
                .iter()
                .any(|r| r.contains("whitespace or comments"))
        );

        let mut tested = unit();
        tested.path = "tests/repo_test.rs".into();
        tested.signature_changed = true;
        tested.public = true;
        score_unit(&mut tested);
        assert!(
            tested.factors.iter().all(|f| f.component != "contract"),
            "{:?}",
            tested.factors
        );
    }

    #[test]
    fn risk_points_are_capped_and_old_code_is_labelled() {
        let mut many = unit();
        many.markers = unit_markers(
            &[
                "sql_from_dynamic_text",
                "secret_literal",
                "shell_execution",
                "dynamic_execution",
            ]
            .map(|rule| RiskMarker {
                rule: rule.into(),
                line: 2,
            }),
            |_| false,
        );
        score_unit(&mut many);
        let risk: i32 = many
            .factors
            .iter()
            .filter(|f| f.component == "risk")
            .map(|f| f.points)
            .sum();
        assert_eq!(risk, 60);
        assert!(
            many.reasons
                .iter()
                .any(|r| r.contains("already in this code"))
        );
    }

    #[test]
    fn entry_points_come_from_attributes_names_and_folders() {
        let symbol = |name: &str, public: bool, attributes: &[&str]| Symbol {
            name: name.into(),
            qualified: name.into(),
            kind: "function".into(),
            start_line: 1,
            end_line: 2,
            signature: String::new(),
            public,
            container: None,
            complexity: 1,
            fingerprint: 0,
            markers: Vec::new(),
            attributes: attributes.iter().map(|a| (*a).to_string()).collect(),
        };
        assert_eq!(
            entry_of(&symbol("go", false, &["#[tauri::command]"]), "src/a.rs").as_deref(),
            Some("external")
        );
        assert_eq!(
            entry_of(&symbol("main", false, &[]), "src/main.rs").as_deref(),
            Some("external")
        );
        assert_eq!(
            entry_of(&symbol("list", true, &[]), "src/api/users.ts").as_deref(),
            Some("external")
        );
        assert_eq!(
            entry_of(&symbol("helper", true, &[]), "src/util.ts").as_deref(),
            Some("internal")
        );
        assert_eq!(entry_of(&symbol("helper", false, &[]), "src/util.ts"), None);
    }

    #[test]
    fn generated_code_is_recognised_by_path_and_header() {
        assert!(looks_generated("src/api.pb.go", ""));
        assert!(looks_generated("src/a.ts", "// @generated by tool\n"));
        assert!(!looks_generated("src/a.ts", "export const a = 1;\n"));
    }
}
