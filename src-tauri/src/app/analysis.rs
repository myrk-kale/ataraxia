//! Prompts sent to a model and the strict parsing of what comes back.
//!
//! The model organizes and explains; what it returns is validated against facts the app
//! already knows (files that exist) before anything is stored.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::domain::{Alternative, ChangedFile, CodeRef, DecisionKind, Error, ErrorCode, Result};

pub const MAX_DECISIONS: usize = 12;
pub const MAX_FLOW_NODES: usize = 60;

/// First JSON value found in model output: a fenced block, or the first balanced `{}`/`[]`.
pub fn extract_json(text: &str) -> Option<Value> {
    let mut candidates: Vec<&str> = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("```") {
        let after = &rest[start + 3..];
        let Some(end) = after.find("```") else { break };
        let block = &after[..end];
        let block = block.strip_prefix("json").unwrap_or(block);
        candidates.push(block.trim());
        rest = &after[end + 3..];
    }
    candidates.push(text.trim());
    for candidate in candidates {
        if let Ok(value) = serde_json::from_str::<Value>(candidate) {
            return Some(value);
        }
        if let Some(value) = first_balanced(candidate) {
            return Some(value);
        }
    }
    None
}

fn first_balanced(text: &str) -> Option<Value> {
    let bytes: Vec<char> = text.chars().collect();
    for (start, ch) in bytes.iter().enumerate() {
        if *ch != '{' && *ch != '[' {
            continue;
        }
        let (open, close) = if *ch == '{' { ('{', '}') } else { ('[', ']') };
        let (mut depth, mut in_string, mut escaped) = (0i32, false, false);
        for (offset, current) in bytes[start..].iter().enumerate() {
            if in_string {
                match (escaped, *current) {
                    (true, _) => escaped = false,
                    (false, '\\') => escaped = true,
                    (false, '"') => in_string = false,
                    _ => {}
                }
                continue;
            }
            if *current == '"' {
                in_string = true;
            } else if *current == open {
                depth += 1;
            } else if *current == close {
                depth -= 1;
                if depth == 0 {
                    let slice: String = bytes[start..=start + offset].iter().collect();
                    if let Ok(value) = serde_json::from_str::<Value>(&slice) {
                        return Some(value);
                    }
                    break;
                }
            }
        }
    }
    None
}

fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn line(value: &Value, key: &str) -> Option<u32> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok())
        .filter(|number| *number > 0)
}

fn code_ref(value: &Value) -> Option<CodeRef> {
    match value {
        Value::String(path) if !path.trim().is_empty() => Some(CodeRef {
            path: path.trim().to_string(),
            start_line: None,
            end_line: None,
        }),
        Value::Object(_) => {
            let path = string(value, "path");
            if path.is_empty() {
                return None;
            }
            let start = line(value, "start_line").or_else(|| line(value, "line"));
            Some(CodeRef {
                path,
                start_line: start,
                end_line: line(value, "end_line").or(start),
            })
        }
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftDecision {
    pub kind: DecisionKind,
    pub title: String,
    pub summary: String,
    pub context: String,
    pub rationale: String,
    pub alternatives: Vec<Alternative>,
    pub refs: Vec<CodeRef>,
    /// Number of an existing decision this change is another chapter of, if the model said so.
    pub relates_to: Option<u32>,
}

/// Parses the decisions a model found. Only refs to files of the checkpoint survive.
pub fn parse_decisions(text: &str, changed: &[ChangedFile]) -> Result<Vec<DraftDecision>> {
    let value = extract_json(text)
        .ok_or_else(|| Error::new(ErrorCode::Invalid, "the answer contained no JSON"))?;
    let list = match &value {
        Value::Array(items) => items.clone(),
        Value::Object(map) => map
            .get("decisions")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| Error::new(ErrorCode::Invalid, "no `decisions` list in the answer"))?,
        _ => return Err(Error::new(ErrorCode::Invalid, "unexpected JSON shape")),
    };
    let known: HashSet<&str> = changed.iter().map(|file| file.path.as_str()).collect();
    let mut drafts = Vec::new();
    for item in list.iter().take(MAX_DECISIONS) {
        let title = string(item, "title");
        let summary = string(item, "summary");
        if title.is_empty() || summary.is_empty() {
            continue;
        }
        let alternatives = item
            .get("alternatives")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|alt| match alt {
                        Value::String(title) => Some(Alternative {
                            title: title.trim().to_string(),
                            note: String::new(),
                        }),
                        Value::Object(_) => {
                            let title = string(alt, "title");
                            (!title.is_empty()).then(|| Alternative {
                                title,
                                note: string(alt, "note"),
                            })
                        }
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let refs = item
            .get("files")
            .or_else(|| item.get("refs"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(code_ref)
                    .filter(|reference| known.contains(reference.path.as_str()))
                    .collect()
            })
            .unwrap_or_default();
        drafts.push(DraftDecision {
            kind: DecisionKind::parse_lenient(&string(item, "type")),
            title,
            summary,
            context: string(item, "context"),
            rationale: string(item, "rationale"),
            alternatives,
            refs,
            relates_to: item
                .get("relates_to")
                .and_then(Value::as_u64)
                .and_then(|number| u32::try_from(number).ok())
                .filter(|number| *number > 0),
        });
    }
    Ok(drafts)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FlowNode {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub description: String,
    pub refs: Vec<CodeRef>,
    /// At least one reference points at a file that exists in the checkpoint.
    pub verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FlowEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FlowGraph {
    pub summary: String,
    pub nodes: Vec<FlowNode>,
    pub edges: Vec<FlowEdge>,
}

/// Parses a diagram. Nodes keep only references to files that exist, edges only connect
/// nodes that survived, and duplicate ids are dropped.
pub fn parse_flow(text: &str, known_files: &HashSet<String>) -> Result<FlowGraph> {
    let value = extract_json(text)
        .ok_or_else(|| Error::new(ErrorCode::Invalid, "the answer contained no JSON"))?;
    let raw_nodes = value
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::new(ErrorCode::Invalid, "no `nodes` list in the answer"))?;
    let mut seen = HashSet::new();
    let mut nodes = Vec::new();
    for item in raw_nodes.iter().take(MAX_FLOW_NODES) {
        let id = string(item, "id");
        let label = string(item, "label");
        if id.is_empty() || label.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let refs: Vec<CodeRef> = item
            .get("refs")
            .or_else(|| item.get("files"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(code_ref)
                    .filter(|reference| known_files.contains(&reference.path))
                    .collect()
            })
            .unwrap_or_default();
        let kind = string(item, "kind");
        nodes.push(FlowNode {
            id,
            label,
            kind: if kind.is_empty() { "step".into() } else { kind },
            description: string(item, "description"),
            verified: !refs.is_empty(),
            refs,
        });
    }
    if nodes.is_empty() {
        return Err(Error::new(
            ErrorCode::Invalid,
            "the diagram has no usable nodes",
        ));
    }
    let ids: HashSet<&str> = nodes.iter().map(|node| node.id.as_str()).collect();
    let edges = value
        .get("edges")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .filter_map(|(index, edge)| {
                    let source = string(edge, "source");
                    let source = if source.is_empty() {
                        string(edge, "from")
                    } else {
                        source
                    };
                    let target = string(edge, "target");
                    let target = if target.is_empty() {
                        string(edge, "to")
                    } else {
                        target
                    };
                    (ids.contains(source.as_str()) && ids.contains(target.as_str())).then(|| {
                        FlowEdge {
                            id: format!("e{index}"),
                            source,
                            target,
                            label: string(edge, "label"),
                        }
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(FlowGraph {
        summary: string(&value, "summary"),
        nodes,
        edges,
    })
}

pub const DECISIONS_INSTRUCTIONS: &str = "\
You review the work an AI coding agent just did and extract the ENGINEERING DECISIONS it made. \
A decision is a choice a reviewer should consciously accept or reject (not every edit is one). \
This is a read-only task: do not modify any file and do not run commands that write.

Answer with JSON only, no prose, in this shape:
{\"decisions\":[{\"type\":\"api-contract|data-integrity|behavior|security|dependencies|performance|code-organization|ux|other\",\
\"title\":\"a question or a short statement\",\"summary\":\"one or two sentences\",\
\"context\":\"what led to it\",\"rationale\":\"why this option\",\
\"alternatives\":[{\"title\":\"...\",\"note\":\"...\"}],\
\"files\":[{\"path\":\"relative/path\",\"start_line\":1,\"end_line\":10}],\
\"relates_to\":3}]}
Use only paths from the changed files below. Return at most 8 decisions, most important first. \
Return {\"decisions\":[]} when nothing deserves a decision.

Decisions are threads that stay open while the code changes. The open decisions are listed below \
as `#number title`. When a change is another chapter of one of them, do not open a new decision: \
return an entry with `\"relates_to\":number`, a `summary` of what changed about it and the `files` \
involved. Leave `relates_to` out for a genuinely new decision.";

pub const FLOW_INSTRUCTIONS: &str = "\
You draw a diagram of how this code works. This is a read-only task: do not modify any file. \
Answer with JSON only, no prose:
{\"summary\":\"one sentence\",\"nodes\":[{\"id\":\"n1\",\"label\":\"short name\",\
\"kind\":\"entry|component|function|data|external|step\",\"description\":\"what it does\",\
\"refs\":[{\"path\":\"relative/path\",\"line\":12}]}],\
\"edges\":[{\"source\":\"n1\",\"target\":\"n2\",\"label\":\"calls | reads | emits ...\"}]}
Ground every node in real files: refs must be paths that appear in the repository listing below. \
Do not invent files. Keep the diagram readable: at most 30 nodes.";

/// Diff text cut to a budget, biggest-priority files first (the caller orders them).
pub fn diff_budget(diffs: &[(String, String)], budget: usize) -> String {
    let mut out = String::new();
    for (path, diff) in diffs {
        if out.len() >= budget {
            out.push_str(&format!(
                "\n… {path} and later files omitted (size limit)\n"
            ));
            break;
        }
        let room = budget - out.len();
        out.push_str(&format!("\n### {path}\n"));
        if diff.len() > room {
            let cut = diff
                .char_indices()
                .take_while(|(index, _)| *index < room)
                .last()
                .map_or(0, |(index, ch)| index + ch.len_utf8());
            out.push_str(&diff[..cut]);
            out.push_str("\n… (truncated)\n");
        } else {
            out.push_str(diff);
        }
    }
    out
}

/// `open` lists the threads already open as (number, title, summary), so a later change extends
/// one instead of duplicating it.
pub fn decisions_prompt(
    files: &[ChangedFile],
    diffs: &[(String, String)],
    open: &[(u32, String, String)],
    focus: &str,
) -> String {
    let focus = if focus.trim().is_empty() {
        String::new()
    } else {
        format!("\nThe developer asked you to focus on: {}\n", focus.trim())
    };
    let existing: String = if open.is_empty() {
        "(none)\n".to_string()
    } else {
        open.iter()
            .map(|(number, title, summary)| {
                let short: String = summary.chars().take(160).collect();
                format!("#{number} {title}: {short}\n")
            })
            .collect()
    };
    let listing: String = files
        .iter()
        .map(|file| {
            format!(
                "- {} (+{} -{})\n",
                file.path, file.additions, file.deletions
            )
        })
        .collect();
    format!(
        "ATARAXIA_TASK:decisions\n{DECISIONS_INSTRUCTIONS}\n\nOpen decisions:\n{existing}{focus}\nChanged files:\n{listing}\nDiff:\n{}",
        diff_budget(diffs, 60_000)
    )
}

pub fn flow_prompt(preset_prompt: &str, extra: &str, structure: &str) -> String {
    let extra = if extra.trim().is_empty() {
        String::new()
    } else {
        format!(
            "\nAdditional instructions for this run:\n{}\n",
            extra.trim()
        )
    };
    format!(
        "ATARAXIA_TASK:flow\n{FLOW_INSTRUCTIONS}\n\nWhat to diagram:\n{}\n{extra}\n{structure}",
        preset_prompt.trim()
    )
}

const SOURCE_EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "rs", "py"];

/// Relative imports of one source file that resolve to a file of the repository.
fn imports_of(path: &str, text: &str, known: &HashSet<String>) -> Vec<String> {
    let dir = path.rsplit_once('/').map_or("", |(dir, _)| dir);
    let extension = path.rsplit('.').next().unwrap_or("");
    let mut found: Vec<String> = Vec::new();
    let mut push = |candidate: String| {
        let normalized = normalize(&candidate);
        let options = [
            normalized.clone(),
            format!("{normalized}.ts"),
            format!("{normalized}.tsx"),
            format!("{normalized}.js"),
            format!("{normalized}.jsx"),
            format!("{normalized}.rs"),
            format!("{normalized}.py"),
            format!("{normalized}/index.ts"),
            format!("{normalized}/index.tsx"),
            format!("{normalized}/mod.rs"),
        ];
        if let Some(hit) = options.into_iter().find(|option| known.contains(option)) {
            if hit != path && !found.contains(&hit) {
                found.push(hit);
            }
        }
    };
    for raw in text.lines().take(400) {
        let line = raw.trim();
        match extension {
            "ts" | "tsx" | "js" | "jsx" | "mjs" => {
                let quoted = line
                    .split(['"', '\''])
                    .nth(1)
                    .filter(|_| line.starts_with("import") || line.contains("require("));
                if let Some(target) = quoted.filter(|target| target.starts_with('.')) {
                    push(join(dir, target));
                }
            }
            "rs" => {
                if let Some(name) = line
                    .strip_prefix("mod ")
                    .or_else(|| line.strip_prefix("pub mod "))
                    .and_then(|rest| rest.strip_suffix(';'))
                {
                    push(join(dir, name));
                }
            }
            "py" => {
                if let Some(rest) = line.strip_prefix("from .") {
                    let module = rest.split_whitespace().next().unwrap_or("");
                    if !module.is_empty() {
                        push(join(dir, &module.replace('.', "/")));
                    }
                }
            }
            _ => {}
        }
    }
    found
}

fn join(dir: &str, relative: &str) -> String {
    if dir.is_empty() {
        relative.to_string()
    } else {
        format!("{dir}/{relative}")
    }
}

fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// Static evidence for a diagram: the file listing plus the import edges between source files.
pub fn structure_summary(files: &[String], read: &dyn Fn(&str) -> Option<String>) -> String {
    let known: HashSet<String> = files.iter().cloned().collect();
    let mut out = String::from("Repository listing (relative paths):\n");
    for file in files.iter().take(400) {
        out.push_str(file);
        out.push('\n');
    }
    if files.len() > 400 {
        out.push_str(&format!("… and {} more files\n", files.len() - 400));
    }
    let mut edges: HashMap<&str, Vec<String>> = HashMap::new();
    for file in files.iter().take(600) {
        let extension = file.rsplit('.').next().unwrap_or("");
        if !SOURCE_EXTENSIONS.contains(&extension) {
            continue;
        }
        if let Some(text) = read(file) {
            let imports = imports_of(file, &text, &known);
            if !imports.is_empty() {
                edges.insert(file.as_str(), imports);
            }
        }
    }
    if !edges.is_empty() {
        out.push_str("\nImport edges found by static analysis (file -> imports):\n");
        let mut keys: Vec<&&str> = edges.keys().collect();
        keys.sort();
        for key in keys.into_iter().take(300) {
            out.push_str(&format!("{key} -> {}\n", edges[*key].join(", ")));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::FileChange;

    fn changed(path: &str) -> ChangedFile {
        ChangedFile {
            path: path.into(),
            old_path: None,
            change: FileChange::Modified,
            additions: 1,
            deletions: 0,
            binary: false,
        }
    }

    #[test]
    fn json_is_found_in_fences_and_surrounding_prose() {
        let fenced = "Here you go:\n```json\n{\"a\": [1, 2]}\n```\nbye";
        assert_eq!(extract_json(fenced).unwrap()["a"][1], 2);
        let prose = "Sure! {\"a\": \"brace } inside\"} trailing";
        assert_eq!(extract_json(prose).unwrap()["a"], "brace } inside");
        assert!(extract_json("no json here").is_none());
    }

    #[test]
    fn decisions_keep_only_known_files_and_fall_back_to_other() {
        let text = r#"{"decisions":[
          {"type":"Security","title":"Hash tokens?","summary":"Tokens are stored hashed.",
           "alternatives":["plain", {"title":"encrypt","note":"needs a key"}],
           "files":[{"path":"src/auth.rs","start_line":3,"end_line":9},"ghost.rs"]},
          {"type":"made-up","title":"Rename","summary":"Renamed a module."},
          {"title":"","summary":"dropped: no title"}
        ]}"#;
        let drafts = parse_decisions(text, &[changed("src/auth.rs")]).unwrap();
        assert_eq!(drafts.len(), 2);
        assert_eq!(drafts[0].kind, DecisionKind::Security);
        assert_eq!(drafts[0].refs.len(), 1);
        assert_eq!(drafts[0].refs[0].start_line, Some(3));
        assert_eq!(drafts[0].alternatives.len(), 2);
        assert_eq!(drafts[1].kind, DecisionKind::Other);
        assert!(parse_decisions("nothing", &[]).is_err());
        assert!(
            parse_decisions("{\"decisions\":[]}", &[])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn flows_drop_invented_files_and_dangling_edges() {
        let known: HashSet<String> = ["a.ts".to_string(), "b.ts".to_string()].into();
        let text = r#"{"summary":"s","nodes":[
          {"id":"1","label":"A","refs":[{"path":"a.ts","line":2}]},
          {"id":"2","label":"B","refs":[{"path":"invented.ts"}]},
          {"id":"1","label":"duplicate"}],
          "edges":[{"source":"1","target":"2","label":"calls"},{"from":"1","to":"9"}]}"#;
        let graph = parse_flow(text, &known).unwrap();
        assert_eq!(graph.nodes.len(), 2);
        assert!(graph.nodes[0].verified);
        assert!(!graph.nodes[1].verified);
        assert!(graph.nodes[1].refs.is_empty());
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.edges[0].label, "calls");
        assert!(parse_flow("{\"nodes\":[]}", &known).is_err());
    }

    #[test]
    fn structure_summary_finds_relative_imports() {
        let files: Vec<String> = [
            "src/app.ts",
            "src/util/format.ts",
            "src/lib.rs",
            "src/model.rs",
        ]
        .iter()
        .map(|path| path.to_string())
        .collect();
        let summary = structure_summary(&files, &|path| match path {
            "src/app.ts" => {
                Some("import { f } from \"./util/format\";\nimport x from \"react\";".into())
            }
            "src/lib.rs" => Some("pub mod model;\n".into()),
            _ => None,
        });
        assert!(
            summary.contains("src/app.ts -> src/util/format.ts"),
            "{summary}"
        );
        assert!(summary.contains("src/lib.rs -> src/model.rs"), "{summary}");
        assert!(!summary.contains("react"));
    }

    #[test]
    fn diff_budget_truncates_without_splitting_characters() {
        let diffs = vec![
            ("a".to_string(), "é".repeat(100)),
            ("b".to_string(), "x".into()),
        ];
        let out = diff_budget(&diffs, 50);
        assert!(out.contains("(truncated)") || out.contains("omitted"));
    }
}
