//! What the syntax tree says about one symbol beyond its name: how branchy it is, a fingerprint
//! of its code without comments, the risky constructs inside it and the attributes on it.
//!
//! Every marker is deliberately conservative and a pointer for a human, never a verdict: it says
//! "look here". Nothing here leaves the machine and nothing needs a model.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use tree_sitter::Node;

use super::Lang;
use crate::domain::RiskMarker;

pub(super) struct Facts {
    pub complexity: u32,
    pub fingerprint: u64,
    pub markers: Vec<RiskMarker>,
}

/// Branching constructs, by node kind across the supported grammars.
const BRANCHES: &[&str] = &[
    "if_expression",
    "if_statement",
    "if_let_expression",
    "elif_clause",
    "for_expression",
    "for_statement",
    "for_in_statement",
    "enhanced_for_statement",
    "while_expression",
    "while_statement",
    "while_let_expression",
    "do_statement",
    "loop_expression",
    "match_arm",
    "switch_case",
    "switch_label",
    "case_clause",
    "expression_case",
    "type_case",
    "communication_case",
    "catch_clause",
    "except_clause",
    "conditional_expression",
    "ternary_expression",
    "boolean_operator",
];

const LOOPS: &[&str] = &[
    "for_expression",
    "for_statement",
    "for_in_statement",
    "enhanced_for_statement",
    "while_expression",
    "while_statement",
    "while_let_expression",
    "do_statement",
    "loop_expression",
];

const CALLS: &[&str] = &["call_expression", "call", "method_invocation"];

const SECRET_WORDS: &[&str] = &[
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "privatekey",
    "credential",
    "accesskey",
    "authkey",
];
const NOT_A_SECRET_SUFFIXES: &[&str] = &[
    "path",
    "file",
    "name",
    "url",
    "uri",
    "type",
    "field",
    "length",
    "len",
    "count",
    "ttl",
    "expiry",
    "expires",
    "header",
    "prefix",
    "suffix",
    "endpoint",
    "env",
    "var",
    "keyid",
    "label",
    "hint",
    "regex",
    "pattern",
    "mask",
    "placeholder",
];
const PLACEHOLDER_WORDS: &[&str] = &[
    "example",
    "changeme",
    "placeholder",
    "dummy",
    "xxxx",
    "your",
    "fake",
    "todo",
    "sample",
    "redacted",
];

/// Whether an identifier looks like the name of a secret (`api_key`, `dbPassword`).
pub(super) fn secret_name(name: &str) -> bool {
    let normalized: String = name
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase();
    SECRET_WORDS.iter().any(|word| normalized.contains(word))
        && !NOT_A_SECRET_SUFFIXES
            .iter()
            .any(|suffix| normalized.ends_with(suffix))
}

/// Whether a string literal could plausibly be a real secret rather than a placeholder.
pub(super) fn plausible_secret(value: &str) -> bool {
    if value.chars().count() < 8 || value.chars().any(char::is_whitespace) {
        return false;
    }
    if value.starts_with(['$', '{', '<', '%', '#']) || value.contains("${") || value.contains("://")
    {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    if PLACEHOLDER_WORDS.iter().any(|word| lower.contains(word)) {
        return false;
    }
    let first = value.chars().next();
    !value.chars().all(|c| Some(c) == first)
}

fn sql_sink(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "execute"
            | "executemany"
            | "executescript"
            | "query"
            | "queryrow"
            | "queryraw"
            | "raw"
            | "exec"
            | "querycontext"
            | "execcontext"
    ) || name == "$queryRawUnsafe"
        || name == "$executeRawUnsafe"
}

fn shell_call(receiver: Option<&str>, name: &str) -> bool {
    matches!(
        (receiver, name),
        (Some("os"), "system" | "popen") | (Some("child_process" | "cp"), "exec" | "execSync")
    ) || (receiver.is_none() && name == "execSync")
}

fn dynamic_exec_call(receiver: Option<&str>, name: &str) -> bool {
    receiver.is_none() && matches!(name, "eval" | "exec")
}

/// Whether a call looks like network, file or database I/O.
fn io_call(receiver: Option<&str>, name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let name = name.as_str();
    match receiver.map(str::to_ascii_lowercase).as_deref() {
        Some(
            "requests" | "httpx" | "urllib" | "aiohttp" | "axios" | "http" | "https" | "got"
            | "reqwest" | "ureq" | "surf",
        ) => true,
        Some(
            "cursor" | "conn" | "connection" | "db" | "session" | "engine" | "pool" | "client"
            | "tx",
        ) => matches!(
            name,
            "execute"
                | "executemany"
                | "query"
                | "commit"
                | "fetchall"
                | "fetchone"
                | "fetch"
                | "get"
                | "post"
                | "send"
                | "exec"
                | "queryrow"
                | "find"
                | "findone"
                | "save"
        ),
        Some("fs" | "promises" | "os") => {
            name.starts_with("read")
                || name.starts_with("write")
                || matches!(name, "open" | "stat" | "readdir" | "mkdir")
        }
        Some("subprocess") => matches!(
            name,
            "run" | "check_output" | "check_call" | "popen" | "call"
        ),
        None => matches!(
            name,
            "open"
                | "fetch"
                | "urlopen"
                | "readfile"
                | "readfilesync"
                | "writefile"
                | "writefilesync"
        ),
        Some(_) => false,
    }
}

struct Scan<'a> {
    lang: Lang,
    source: &'a [u8],
    complexity: u32,
    hasher: DefaultHasher,
    markers: Vec<RiskMarker>,
    markers_wanted: bool,
}

pub(super) fn measure(lang: Lang, node: Node, source: &[u8], container: bool) -> Facts {
    let mut scan = Scan {
        lang,
        source,
        complexity: u32::from(!container),
        hasher: DefaultHasher::new(),
        markers: Vec::new(),
        markers_wanted: !container,
    };
    scan.visit(node, 0);
    scan.markers
        .sort_by_key(|marker| (marker.rule.clone(), marker.line));
    scan.markers.dedup_by(|a, b| a.rule == b.rule);
    Facts {
        complexity: if container { 0 } else { scan.complexity },
        fingerprint: scan.hasher.finish(),
        markers: scan.markers,
    }
}

impl Scan<'_> {
    fn text(&self, node: Node) -> String {
        node.utf8_text(self.source).unwrap_or_default().to_string()
    }

    fn flag(&mut self, rule: &str, node: Node) {
        if self.markers_wanted {
            self.markers.push(RiskMarker {
                rule: rule.to_string(),
                line: node.start_position().row as u32 + 1,
            });
        }
    }

    fn visit(&mut self, node: Node, loops: u32) {
        let kind = node.kind();
        if kind.contains("comment") {
            return;
        }
        if node.child_count() == 0 {
            node.utf8_text(self.source)
                .unwrap_or_default()
                .hash(&mut self.hasher);
        }
        if self.markers_wanted {
            if BRANCHES.contains(&kind) || matches!(kind, "&&" | "||") {
                self.complexity += 1;
            }
            self.inspect(node, loops);
        }
        let inside = loops + u32::from(LOOPS.contains(&kind));
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.visit(child, inside);
        }
    }

    fn inspect(&mut self, node: Node, loops: u32) {
        let kind = node.kind();
        if CALLS.contains(&kind) {
            self.call(node, loops);
        }
        match kind {
            "unsafe_block" => self.flag("unsafe_block", node),
            "except_clause" | "catch_clause" if self.swallows(node) => {
                self.flag("swallowed_error", node);
            }
            "pair" | "keyword_argument" | "keyed_element" => {
                let compact: String = self.text(node).split_whitespace().collect();
                if matches!(
                    compact.as_str(),
                    "verify=False"
                        | "rejectUnauthorized:false"
                        | "InsecureSkipVerify:true"
                        | "\"rejectUnauthorized\":false"
                ) {
                    self.flag("verification_disabled", node);
                }
            }
            "assignment"
            | "variable_declarator"
            | "assignment_expression"
            | "let_declaration"
            | "const_item"
            | "static_item"
            | "short_var_declaration"
            | "const_spec" => {
                self.secret(node);
            }
            _ => {}
        }
    }

    /// An `except`/`catch` that does nothing with the error.
    fn swallows(&self, node: Node) -> bool {
        let body = node.child_by_field_name("body").or_else(|| {
            let mut cursor = node.walk();
            node.children(&mut cursor)
                .find(|child| matches!(child.kind(), "block" | "statement_block"))
        });
        let Some(body) = body else {
            return false;
        };
        let mut cursor = body.walk();
        let meaningful = body
            .named_children(&mut cursor)
            .filter(|child| !child.kind().contains("comment"))
            .count();
        meaningful == 0
            || (meaningful == 1
                && body
                    .named_child(0)
                    .is_some_and(|only| only.kind() == "pass_statement"))
    }

    fn secret(&mut self, node: Node) {
        let name = ["name", "left", "pattern"]
            .iter()
            .find_map(|field| node.child_by_field_name(field))
            .map(|n| self.text(n));
        let value = ["value", "right"]
            .iter()
            .find_map(|field| node.child_by_field_name(field));
        let (Some(name), Some(value)) = (name, value) else {
            return;
        };
        if !matches!(
            value.kind(),
            "string" | "string_literal" | "interpreted_string_literal" | "raw_string_literal"
        ) || !secret_name(name.trim_start_matches("mut ").trim())
        {
            return;
        }
        let raw = self.text(value);
        let content = raw.trim_matches(|c| matches!(c, '"' | '\'' | '`'));
        if plausible_secret(content) {
            self.flag("secret_literal", node);
        }
    }

    /// The callee split into the last identifier of its receiver and its own name.
    fn callee(&self, node: Node) -> Option<(Option<String>, String)> {
        let text = if node.kind() == "method_invocation" {
            let name = self.text(node.child_by_field_name("name")?);
            match node.child_by_field_name("object") {
                Some(object) => format!("{}.{name}", self.text(object)),
                None => name,
            }
        } else {
            self.text(node.child_by_field_name("function")?)
        };
        if text.len() > 80 || text.contains('(') || text.contains('\n') {
            // A computed receiver is not a name that can be matched.
            let name = text.rsplit(['.', ':']).next().unwrap_or_default().trim();
            return (!name.is_empty() && !name.contains('(')).then(|| (None, name.to_string()));
        }
        let text = text.replace("::", ".");
        let mut parts = text.rsplit('.');
        let name = parts.next()?.trim().to_string();
        let receiver = parts.next().map(|part| part.trim().to_string());
        (!name.is_empty()).then_some((receiver.filter(|part| !part.is_empty()), name))
    }

    fn first_argument<'a>(&self, node: Node<'a>) -> Option<Node<'a>> {
        let args = node.child_by_field_name("arguments")?;
        args.named_child(0)
    }

    /// Text assembled at run time: concatenation, interpolation, `format`.
    fn dynamic_text(&self, node: Node) -> bool {
        let mut cursor = node.walk();
        match node.kind() {
            "reference_expression" | "parenthesized_expression" | "await_expression" => node
                .named_child((node.named_child_count().saturating_sub(1)) as u32)
                .is_some_and(|inner| self.dynamic_text(inner)),
            "binary_expression" | "binary_operator" => {
                let text = self.text(node);
                (text.contains('+') || text.contains('%'))
                    && node
                        .children(&mut cursor)
                        .any(|child| child.kind().contains("string"))
            }
            "template_string" => node
                .children(&mut cursor)
                .any(|child| child.kind() == "template_substitution"),
            "string" => node
                .children(&mut cursor)
                .any(|child| child.kind() == "interpolation"),
            "macro_invocation" => self.text(node).starts_with("format!"),
            "call" | "call_expression" | "method_invocation" => {
                let text = self.text(node);
                let head: String = text.chars().take_while(|c| *c != '(').collect();
                head.ends_with(".format")
                    || head.ends_with("Sprintf")
                    || head.ends_with("String.format")
            }
            _ => false,
        }
    }

    fn call(&mut self, node: Node, loops: u32) {
        let Some((receiver, name)) = self.callee(node) else {
            return;
        };
        let receiver = receiver.as_deref();
        if sql_sink(&name)
            && self
                .first_argument(node)
                .is_some_and(|arg| self.dynamic_text(arg))
        {
            self.flag("sql_from_dynamic_text", node);
        }
        let shell_flag = receiver == Some("subprocess") && self.text(node).contains("shell=True");
        let rust_shell = self.lang == Lang::Rust
            && receiver == Some("Command")
            && name == "new"
            && self.first_argument(node).is_some_and(|arg| {
                matches!(
                    self.text(arg).trim_matches('"'),
                    "sh" | "bash" | "zsh" | "cmd"
                )
            });
        if shell_call(receiver, &name) || shell_flag || rust_shell {
            self.flag("shell_execution", node);
        }
        if dynamic_exec_call(receiver, &name) {
            self.flag("dynamic_execution", node);
        }
        if matches!(
            name.as_str(),
            "danger_accept_invalid_certs" | "danger_accept_invalid_hostnames"
        ) && self.text(node).contains("(true)")
        {
            self.flag("verification_disabled", node);
        }
        if let Some(argument) = node.child_by_field_name("arguments") {
            let compact: String = self.text(argument).split_whitespace().collect();
            if compact.contains("verify=False") || compact.contains("rejectUnauthorized:false") {
                self.flag("verification_disabled", node);
            }
        }
        if loops > 0 && io_call(receiver, &name) {
            self.flag("io_in_loop", node);
        }
    }
}

/// Decorators, attributes and annotations attached to a declaration.
pub(super) fn attributes(lang: Lang, node: Node, source: &[u8]) -> Vec<String> {
    let text = |n: Node| -> String {
        n.utf8_text(source)
            .unwrap_or_default()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(80)
            .collect()
    };
    let mut out = Vec::new();
    match lang {
        Lang::Rust => {
            let mut sibling = node.prev_sibling();
            while let Some(previous) = sibling {
                match previous.kind() {
                    "attribute_item" => out.push(text(previous)),
                    "line_comment" | "block_comment" => {}
                    _ => break,
                }
                sibling = previous.prev_sibling();
            }
        }
        Lang::Python => {
            if let Some(parent) = node.parent().filter(|p| p.kind() == "decorated_definition") {
                let mut cursor = parent.walk();
                out.extend(
                    parent
                        .children(&mut cursor)
                        .filter(|child| child.kind() == "decorator")
                        .map(text),
                );
            }
        }
        Lang::Java => {
            let mut cursor = node.walk();
            for child in node
                .children(&mut cursor)
                .filter(|c| c.kind() == "modifiers")
            {
                let mut inner = child.walk();
                out.extend(
                    child
                        .children(&mut inner)
                        .filter(|m| matches!(m.kind(), "annotation" | "marker_annotation"))
                        .map(text),
                );
            }
        }
        Lang::TypeScript | Lang::Tsx | Lang::JavaScript => {
            let mut cursor = node.walk();
            out.extend(
                node.children(&mut cursor)
                    .filter(|child| child.kind() == "decorator")
                    .map(text),
            );
            let mut sibling = node.prev_sibling();
            while let Some(previous) = sibling.filter(|p| p.kind() == "decorator") {
                out.push(text(previous));
                sibling = previous.prev_sibling();
            }
        }
        Lang::Go => {}
    }
    out.reverse();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::syntax::TreeSitterSyntax;
    use crate::ports::Syntax;

    fn symbol(path: &str, text: &str, name: &str) -> crate::domain::Symbol {
        TreeSitterSyntax
            .symbols(path, text)
            .expect("supported")
            .into_iter()
            .find(|symbol| symbol.name == name)
            .expect("symbol")
    }

    fn rules(path: &str, text: &str, name: &str) -> Vec<String> {
        symbol(path, text, name)
            .markers
            .into_iter()
            .map(|marker| marker.rule)
            .collect()
    }

    #[test]
    fn secret_names_and_values() {
        for yes in [
            "password",
            "DB_PASSWORD",
            "apiKey",
            "client_secret",
            "authToken",
        ] {
            assert!(secret_name(yes), "{yes}");
        }
        for no in [
            "token_type",
            "password_field",
            "secret_path",
            "name",
            "tokenizer_name",
        ] {
            assert!(!secret_name(no), "{no}");
        }
        assert!(plausible_secret("hunter2hunter2"));
        for no in [
            "short",
            "your-api-key-here",
            "${API_KEY}",
            "https://example.com",
            "aaaaaaaaaaaa",
        ] {
            assert!(!plausible_secret(no), "{no}");
        }
    }

    #[test]
    fn complexity_counts_branches() {
        let flat = symbol("a.py", "def f(x):\n    return x\n", "f");
        let branchy = symbol(
            "a.py",
            "def f(x, y):\n    if x and y:\n        for i in x:\n            pass\n    elif y:\n        return 1\n    return 0\n",
            "f",
        );
        assert_eq!(flat.complexity, 1);
        assert!(branchy.complexity >= 5, "{}", branchy.complexity);
    }

    #[test]
    fn comments_and_whitespace_do_not_change_the_fingerprint() {
        let a = symbol("a.rs", "fn f(x: u32) -> u32 {\n    x + 1\n}\n", "f");
        let b = symbol(
            "a.rs",
            "fn f(x: u32) -> u32 {\n    // add one\n    x   +   1\n}\n",
            "f",
        );
        let c = symbol("a.rs", "fn f(x: u32) -> u32 {\n    x + 2\n}\n", "f");
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_ne!(a.fingerprint, c.fingerprint);
    }

    #[test]
    fn python_comments_and_spacing_do_not_change_the_fingerprint() {
        let a = symbol("a.py", "def tidy(x):\n    return x + 1\n", "tidy");
        let b = symbol(
            "a.py",
            "def fetch(c):\n    return c\n\n\ndef tidy(x):\n    # add one\n    return x  +  1\n",
            "tidy",
        );
        assert_eq!(a.signature, b.signature);
        assert_eq!(a.fingerprint, b.fingerprint);
    }

    #[test]
    fn python_markers() {
        let text = "def run(user, cur):\n    cur.execute(\"select * from t where u=\" + user)\n    api_key = \"hunter2hunter2\"\n    eval(user)\n    try:\n        pass\n    except Exception:\n        pass\n    for i in user:\n        requests.get(i)\n    requests.get(user, verify=False)\n";
        let found = rules("a.py", text, "run");
        for rule in [
            "sql_from_dynamic_text",
            "secret_literal",
            "dynamic_execution",
            "swallowed_error",
            "io_in_loop",
            "verification_disabled",
        ] {
            assert!(found.iter().any(|r| r == rule), "{rule} in {found:?}");
        }
    }

    #[test]
    fn a_parameterised_query_and_a_placeholder_are_not_flagged() {
        let found = rules(
            "a.py",
            "def run(cur):\n    cur.execute(\"select 1 where u = ?\", (1,))\n    password = \"your-password-here\"\n",
            "run",
        );
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn rust_and_typescript_markers() {
        let rust = rules(
            "a.rs",
            "fn go(user: &str) {\n    unsafe { danger(); }\n    let cmd = std::process::Command::new(\"sh\");\n    db.execute(&format!(\"select {}\", user));\n}\n",
            "go",
        );
        for rule in ["unsafe_block", "shell_execution", "sql_from_dynamic_text"] {
            assert!(rust.iter().any(|r| r == rule), "{rule} in {rust:?}");
        }
        let ts = rules(
            "a.ts",
            "function go(user: string) {\n  child_process.exec(\"ls \" + user);\n  try { a(); } catch (e) {}\n  db.query(`select ${user}`);\n}\n",
            "go",
        );
        for rule in [
            "shell_execution",
            "swallowed_error",
            "sql_from_dynamic_text",
        ] {
            assert!(ts.iter().any(|r| r == rule), "{rule} in {ts:?}");
        }
    }

    #[test]
    fn attributes_are_read_per_language() {
        let rust = symbol(
            "a.rs",
            "#[tauri::command]\n#[allow(dead_code)]\npub fn go() {}\n",
            "go",
        );
        assert_eq!(
            rust.attributes,
            vec!["#[tauri::command]", "#[allow(dead_code)]"]
        );
        let py = symbol("a.py", "@app.route(\"/x\")\ndef go():\n    pass\n", "go");
        assert_eq!(py.attributes, vec!["@app.route(\"/x\")"]);
        let java = symbol(
            "A.java",
            "class A {\n  @GetMapping(\"/x\")\n  public void go() {}\n}\n",
            "go",
        );
        assert_eq!(java.attributes, vec!["@GetMapping(\"/x\")"]);
    }
}
