//! Tree-sitter adapter: finds the functions, classes and types of a source file.
//!
//! Initial language pack: Rust, TypeScript/TSX, JavaScript/JSX, Python, Go and Java. A file in
//! any other language simply has no symbols, and the review falls back to the whole file.

use tree_sitter::{Language, Node, Parser};

mod facts;

use crate::domain::Symbol;
use crate::ports::Syntax;

#[derive(Debug, Default, Clone, Copy)]
pub struct TreeSitterSyntax;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Lang {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Go,
    Java,
}

impl Lang {
    fn of(path: &str) -> Option<Self> {
        let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
        Some(match extension.as_str() {
            "rs" => Self::Rust,
            "ts" | "mts" | "cts" => Self::TypeScript,
            "tsx" => Self::Tsx,
            "js" | "jsx" | "mjs" | "cjs" => Self::JavaScript,
            "py" => Self::Python,
            "go" => Self::Go,
            "java" => Self::Java,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::TypeScript | Self::Tsx => "typescript",
            Self::JavaScript => "javascript",
            Self::Python => "python",
            Self::Go => "go",
            Self::Java => "java",
        }
    }

    fn grammar(self) -> Language {
        match self {
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::Go => tree_sitter_go::LANGUAGE.into(),
            Self::Java => tree_sitter_java::LANGUAGE.into(),
        }
    }
}

impl Syntax for TreeSitterSyntax {
    fn language_of(&self, path: &str) -> Option<&'static str> {
        Lang::of(path).map(Lang::name)
    }

    fn symbols(&self, path: &str, text: &str) -> Option<Vec<Symbol>> {
        let lang = Lang::of(path)?;
        let mut parser = Parser::new();
        parser.set_language(&lang.grammar()).ok()?;
        let tree = parser.parse(text, None)?;
        let mut out = Vec::new();
        let walker = Walker {
            lang,
            source: text.as_bytes(),
        };
        walker.walk(tree.root_node(), None, false, &mut out);
        Some(out)
    }
}

/// What a node declares, when it declares something worth attributing a change to.
struct Found {
    name: String,
    kind: &'static str,
    /// Its children are symbols too (class, impl, trait, module).
    container: bool,
    public: bool,
    /// The node that holds the body, to cut the signature short of it.
    body: Option<usize>,
}

struct Walker<'a> {
    lang: Lang,
    source: &'a [u8],
}

impl Walker<'_> {
    fn text(&self, node: Node) -> String {
        node.utf8_text(self.source).unwrap_or_default().to_string()
    }

    fn field_text(&self, node: Node, field: &str) -> Option<String> {
        node.child_by_field_name(field)
            .map(|child| self.text(child))
    }

    fn walk(&self, node: Node, parent: Option<&str>, exported: bool, out: &mut Vec<Symbol>) {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "export_statement" {
                self.walk(child, parent, true, out);
                continue;
            }
            // Lexical declarations can declare several functions at once.
            for found in self.classify(child, parent, exported) {
                let qualified = match parent {
                    Some(parent) => format!("{parent}.{}", found.name),
                    None => found.name.clone(),
                };
                let body_start = found.body.unwrap_or(child.end_byte());
                let measured = facts::measure(self.lang, child, self.source, found.container);
                out.push(Symbol {
                    name: found.name.clone(),
                    qualified: qualified.clone(),
                    kind: found.kind.to_string(),
                    start_line: child.start_position().row as u32 + 1,
                    end_line: child.end_position().row as u32 + 1,
                    signature: self.signature(child, body_start),
                    public: found.public,
                    container: parent.map(str::to_string),
                    complexity: measured.complexity,
                    fingerprint: measured.fingerprint,
                    markers: measured.markers,
                    attributes: facts::attributes(self.lang, child, self.source),
                });
                if found.container {
                    self.walk(child, Some(&qualified), exported, out);
                }
            }
            if !self.is_declaration(child) {
                // Wrappers (decorators, declaration lists, class bodies, blocks) hold symbols too.
                self.walk(child, parent, exported, out);
            }
        }
    }

    /// The declaration up to its body. A comment between the header and the body is not part of
    /// it: adding one must not look like a change of contract.
    fn signature(&self, node: Node, body_start: usize) -> String {
        fn first_comment(node: Node, from: usize, to: usize) -> Option<usize> {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.end_byte() <= from || child.start_byte() >= to {
                    continue;
                }
                if child.kind().contains("comment") {
                    return Some(child.start_byte());
                }
                if let Some(found) = first_comment(child, from, to) {
                    return Some(found);
                }
            }
            None
        }
        let start = node.start_byte();
        let mut end = body_start.max(start).min(self.source.len());
        if let Some(comment) = first_comment(node, start, end) {
            end = comment.max(start);
        }
        let raw = String::from_utf8_lossy(&self.source[start..end]);
        let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        collapsed
            .trim_end_matches(['{', ':', ' '])
            .chars()
            .take(240)
            .collect()
    }

    /// Nodes `classify` recognises are handled there and not searched again for nested symbols.
    fn is_declaration(&self, node: Node) -> bool {
        !self.classify(node, None, false).is_empty()
    }

    fn classify(&self, node: Node, parent: Option<&str>, exported: bool) -> Vec<Found> {
        let one = |found: Option<Found>| found.into_iter().collect::<Vec<_>>();
        let kind = node.kind();
        match self.lang {
            Lang::Rust => one(self.rust(node, kind, parent)),
            Lang::TypeScript | Lang::Tsx | Lang::JavaScript => {
                self.script(node, kind, parent, exported)
            }
            Lang::Python => one(self.python(node, kind, parent)),
            Lang::Go => one(self.go(node, kind)),
            Lang::Java => one(self.java(node, kind)),
        }
    }

    fn body_start(&self, node: Node) -> Option<usize> {
        node.child_by_field_name("body")
            .map(|body| body.start_byte())
    }

    fn rust(&self, node: Node, kind: &str, parent: Option<&str>) -> Option<Found> {
        let public = (0..node.child_count()).any(|index| {
            node.child(index as u32)
                .is_some_and(|child| child.kind() == "visibility_modifier")
        });
        let simple = |kind: &'static str, container: bool| -> Option<Found> {
            Some(Found {
                name: self.field_text(node, "name")?,
                kind,
                container,
                public,
                body: self.body_start(node),
            })
        };
        match kind {
            "function_item" | "function_signature_item" => simple(
                if parent.is_some() {
                    "method"
                } else {
                    "function"
                },
                false,
            ),
            "struct_item" => simple("struct", false),
            "enum_item" => simple("enum", false),
            "union_item" => simple("struct", false),
            "trait_item" => simple("trait", true),
            "mod_item" if node.child_by_field_name("body").is_some() => simple("module", true),
            "const_item" | "static_item" => simple("const", false),
            "type_item" => simple("type", false),
            "impl_item" => {
                let ty = self.field_text(node, "type")?;
                let name = match self.field_text(node, "trait") {
                    Some(tr) => format!("{ty} as {tr}"),
                    None => ty,
                };
                Some(Found {
                    name,
                    kind: "impl",
                    container: true,
                    public: false,
                    body: self.body_start(node),
                })
            }
            _ => None,
        }
    }

    fn script(&self, node: Node, kind: &str, parent: Option<&str>, exported: bool) -> Vec<Found> {
        let named = |kind: &'static str, container: bool, public: bool| -> Vec<Found> {
            self.field_text(node, "name")
                .map(|name| Found {
                    name,
                    kind,
                    container,
                    public,
                    body: self.body_start(node),
                })
                .into_iter()
                .collect()
        };
        match kind {
            "function_declaration" | "generator_function_declaration" => {
                named("function", false, exported)
            }
            "class_declaration" | "abstract_class_declaration" => named("class", true, exported),
            "interface_declaration" => named("interface", false, exported),
            "type_alias_declaration" => named("type", false, exported),
            "enum_declaration" => named("enum", false, exported),
            "method_definition" | "method_signature" | "abstract_method_signature" => {
                let text = self.text(node);
                let hidden = text.starts_with("private ") || text.starts_with('#');
                self.field_text(node, "name")
                    .map(|name| Found {
                        public: exported && !hidden && !name.starts_with('#'),
                        name,
                        kind: "method",
                        container: false,
                        body: self.body_start(node),
                    })
                    .into_iter()
                    .collect()
            }
            "lexical_declaration" | "variable_declaration" => {
                let mut found = Vec::new();
                let mut cursor = node.walk();
                for declarator in node.children(&mut cursor) {
                    if declarator.kind() != "variable_declarator" {
                        continue;
                    }
                    let Some(value) = declarator.child_by_field_name("value") else {
                        continue;
                    };
                    if !matches!(
                        value.kind(),
                        "arrow_function" | "function_expression" | "function"
                    ) {
                        continue;
                    }
                    if let Some(name) = self.field_text(declarator, "name") {
                        found.push(Found {
                            name,
                            kind: "function",
                            container: false,
                            public: exported && parent.is_none(),
                            body: value
                                .child_by_field_name("body")
                                .map(|body| body.start_byte()),
                        });
                    }
                }
                found
            }
            _ => Vec::new(),
        }
    }

    fn python(&self, node: Node, kind: &str, parent: Option<&str>) -> Option<Found> {
        let name = self.field_text(node, "name")?;
        match kind {
            "function_definition" => Some(Found {
                kind: if parent.is_some() {
                    "method"
                } else {
                    "function"
                },
                public: !name.starts_with('_') || (name.starts_with("__") && name.ends_with("__")),
                container: false,
                body: self.body_start(node),
                name,
            }),
            "class_definition" => Some(Found {
                kind: "class",
                public: !name.starts_with('_'),
                container: true,
                body: self.body_start(node),
                name,
            }),
            _ => None,
        }
    }

    fn go(&self, node: Node, kind: &str) -> Option<Found> {
        match kind {
            "function_declaration" => {
                let name = self.field_text(node, "name")?;
                Some(Found {
                    public: name.chars().next().is_some_and(char::is_uppercase),
                    kind: "function",
                    container: false,
                    body: self.body_start(node),
                    name,
                })
            }
            "method_declaration" => {
                let name = self.field_text(node, "name")?;
                let receiver = self.field_text(node, "receiver").unwrap_or_default();
                let ty: String = receiver
                    .trim_matches(|c| c == '(' || c == ')')
                    .split_whitespace()
                    .last()
                    .unwrap_or("")
                    .trim_start_matches('*')
                    .to_string();
                Some(Found {
                    public: name.chars().next().is_some_and(char::is_uppercase),
                    kind: "method",
                    container: false,
                    body: self.body_start(node),
                    name: if ty.is_empty() {
                        name
                    } else {
                        format!("{ty}.{name}")
                    },
                })
            }
            "type_spec" => {
                let name = self.field_text(node, "name")?;
                let shape = node
                    .child_by_field_name("type")
                    .map(|ty| ty.kind().to_string());
                Some(Found {
                    public: name.chars().next().is_some_and(char::is_uppercase),
                    kind: if shape.as_deref() == Some("interface_type") {
                        "interface"
                    } else {
                        "struct"
                    },
                    container: false,
                    body: None,
                    name,
                })
            }
            _ => None,
        }
    }

    fn java(&self, node: Node, kind: &str) -> Option<Found> {
        let name = self.field_text(node, "name")?;
        let modifiers = (0..node.child_count())
            .filter_map(|index| node.child(index as u32))
            .find(|child| child.kind() == "modifiers")
            .map(|child| self.text(child))
            .unwrap_or_default();
        let public = modifiers.contains("public");
        let (symbol_kind, container) = match kind {
            "class_declaration" | "record_declaration" => ("class", true),
            "interface_declaration" => ("interface", true),
            "enum_declaration" => ("enum", true),
            "method_declaration" => ("method", false),
            "constructor_declaration" => ("method", false),
            _ => return None,
        };
        Some(Found {
            name,
            kind: symbol_kind,
            container,
            public,
            body: self.body_start(node),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn symbols(path: &str, text: &str) -> Vec<Symbol> {
        TreeSitterSyntax
            .symbols(path, text)
            .expect("supported language")
    }

    fn names(symbols: &[Symbol]) -> Vec<String> {
        symbols
            .iter()
            .map(|symbol| format!("{}:{}", symbol.kind, symbol.qualified))
            .collect()
    }

    #[test]
    fn knows_the_initial_language_pack_and_nothing_else() {
        for path in [
            "a.rs", "a.ts", "a.tsx", "a.js", "a.jsx", "a.py", "a.go", "A.java",
        ] {
            assert!(TreeSitterSyntax.language_of(path).is_some(), "{path}");
        }
        assert_eq!(TreeSitterSyntax.language_of("a.rb"), None);
        assert!(TreeSitterSyntax.symbols("notes.md", "# hi").is_none());
    }

    #[test]
    fn rust_functions_impls_and_visibility() {
        let found = symbols(
            "lib.rs",
            "pub struct Repo;\n\nimpl Repo {\n    pub fn create(&self, id: u32) -> u32 {\n        id\n    }\n    fn hidden(&self) {}\n}\n\nfn helper() {}\n\npub trait Store {\n    fn get(&self);\n}\n",
        );
        assert_eq!(
            names(&found),
            [
                "struct:Repo",
                "impl:Repo",
                "method:Repo.create",
                "method:Repo.hidden",
                "function:helper",
                "trait:Store",
                "method:Store.get"
            ]
        );
        let create = found.iter().find(|s| s.name == "create").unwrap();
        assert!(create.public);
        assert_eq!((create.start_line, create.end_line), (4, 6));
        assert_eq!(create.signature, "pub fn create(&self, id: u32) -> u32");
        assert!(!found.iter().find(|s| s.name == "hidden").unwrap().public);
        assert!(!found.iter().find(|s| s.name == "helper").unwrap().public);
    }

    #[test]
    fn typescript_classes_exports_and_arrow_functions() {
        let found = symbols(
            "a.ts",
            "export class Service {\n  run(x: number): number {\n    return x;\n  }\n  private secret() {}\n}\n\nexport const load = async (id: string) => {\n  return id;\n};\n\nconst internal = () => 1;\n\nexport interface Options { a: number }\nexport type Id = string;\n",
        );
        assert_eq!(
            names(&found),
            [
                "class:Service",
                "method:Service.run",
                "method:Service.secret",
                "function:load",
                "function:internal",
                "interface:Options",
                "type:Id"
            ]
        );
        assert!(found.iter().find(|s| s.name == "run").unwrap().public);
        assert!(!found.iter().find(|s| s.name == "secret").unwrap().public);
        assert!(found.iter().find(|s| s.name == "load").unwrap().public);
        assert!(!found.iter().find(|s| s.name == "internal").unwrap().public);
    }

    #[test]
    fn tsx_and_javascript_parse() {
        let tsx = symbols(
            "c.tsx",
            "export function Button() {\n  return <button/>;\n}\n",
        );
        assert_eq!(names(&tsx), ["function:Button"]);
        let js = symbols("c.js", "function a() {}\nclass B { m() {} }\n");
        assert_eq!(names(&js), ["function:a", "class:B", "method:B.m"]);
    }

    #[test]
    fn python_classes_methods_and_decorators() {
        let found = symbols(
            "m.py",
            "class Repo:\n    def create(self, x):\n        return x\n\n    def _private(self):\n        pass\n\n@decorator\ndef top():\n    pass\n",
        );
        assert_eq!(
            names(&found),
            [
                "class:Repo",
                "method:Repo.create",
                "method:Repo._private",
                "function:top"
            ]
        );
        assert!(found.iter().find(|s| s.name == "create").unwrap().public);
        assert!(!found.iter().find(|s| s.name == "_private").unwrap().public);
    }

    #[test]
    fn go_functions_methods_and_types() {
        let found = symbols(
            "m.go",
            "package m\n\ntype Repo struct{}\n\nfunc (r *Repo) Create(id int) int { return id }\n\nfunc helper() {}\n",
        );
        assert_eq!(
            names(&found),
            ["struct:Repo", "method:Repo.Create", "function:helper"]
        );
        assert!(
            found
                .iter()
                .find(|s| s.name == "Repo.Create")
                .unwrap()
                .public
        );
        assert!(!found.iter().find(|s| s.name == "helper").unwrap().public);
    }

    #[test]
    fn java_classes_and_methods() {
        let found = symbols(
            "A.java",
            "public class Repo {\n  public int create(int id) {\n    return id;\n  }\n  private void hidden() {}\n}\n",
        );
        assert_eq!(
            names(&found),
            ["class:Repo", "method:Repo.create", "method:Repo.hidden"]
        );
        assert!(found.iter().find(|s| s.name == "create").unwrap().public);
        assert!(!found.iter().find(|s| s.name == "hidden").unwrap().public);
    }

    #[test]
    fn broken_code_still_yields_what_parses() {
        let found = symbols("a.rs", "fn ok() {}\nfn broken( {\n");
        assert!(found.iter().any(|s| s.name == "ok"));
    }
}
