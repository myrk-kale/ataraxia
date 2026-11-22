//! Navigation over the declarations and references in the chat's current worktrees.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;

use crate::domain::Result;
use crate::domain::ids::SessionId;
use crate::ports::CodeStructure;

use super::Engine;
use super::workspace::session_roots;

const MAX_CACHED_FILES: usize = 10_000;

#[derive(Default)]
pub(crate) struct CodeIndex(Mutex<HashMap<PathBuf, (u64, Arc<CodeStructure>)>>);

pub struct GraphQuery<'a> {
    pub query: &'a str,
    pub path: Option<&'a str>,
    pub kind: Option<&'a str>,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Serialize)]
pub struct GraphPage {
    indexed_files: usize,
    skipped_files: usize,
    total: usize,
    next_offset: Option<usize>,
    matches: Vec<GraphMatch>,
}

#[derive(Serialize)]
struct GraphMatch {
    kind: &'static str,
    path: String,
    line: u32,
    #[serde(flatten)]
    detail: GraphDetail,
}

#[derive(Serialize)]
#[serde(untagged)]
enum GraphDetail {
    Symbol {
        name: String,
        declaration: String,
        end_line: u32,
        container: Option<String>,
    },
    Reference {
        target: String,
        from: Option<String>,
    },
}

impl Engine {
    fn file_structure(&self, root: &Path, path: &str) -> Option<Arc<CodeStructure>> {
        let content = self.fs.read_text(root, path).ok()?;
        if content.binary || content.too_large {
            return None;
        }
        let mut hash = std::hash::DefaultHasher::new();
        content.text.hash(&mut hash);
        let fingerprint = hash.finish();
        let key = root.join(path);
        if let Some((stored, structure)) = self.code_index.0.lock().get(&key)
            && *stored == fingerprint
        {
            return Some(Arc::clone(structure));
        }
        let structure = Arc::new(self.syntax.code_structure(path, &content.text)?);
        let mut cache = self.code_index.0.lock();
        if cache.len() >= MAX_CACHED_FILES {
            cache.clear();
        }
        cache.insert(key, (fingerprint, Arc::clone(&structure)));
        Some(structure)
    }
}

impl crate::api::CodeGraph for Engine {
    fn code_graph(&self, session: SessionId, query: GraphQuery<'_>) -> Result<GraphPage> {
        let session = self.session(session)?;
        let roots = session_roots(self.db.as_ref(), &session)?;
        let searched = query.query.trim().to_lowercase();
        let terms: Vec<&str> = searched.split_whitespace().collect();
        let prefix = query
            .path
            .map(|path| path.trim().trim_start_matches("./").trim_end_matches('/'));
        let mut indexed_files = 0;
        let mut skipped_files = 0;
        let mut matches = Vec::new();

        for (index, (repository, root)) in roots.into_iter().enumerate() {
            let files = match self.git.list_files(&root) {
                Ok(files) => files,
                Err(error) if index == 0 => return Err(error),
                Err(_) => {
                    skipped_files += 1;
                    continue;
                }
            };
            for file in files {
                if self.syntax.language_of(&file).is_none() {
                    continue;
                }
                let path = if index == 0 {
                    file.clone()
                } else {
                    format!("{repository}/{file}")
                };
                if let Some(prefix) = prefix
                    && path != prefix
                    && !path
                        .strip_prefix(prefix)
                        .is_some_and(|rest| rest.starts_with('/'))
                {
                    continue;
                }
                let Some(structure) = self.file_structure(&root, &file) else {
                    skipped_files += 1;
                    continue;
                };
                indexed_files += 1;
                let path_lower = path.to_lowercase();
                let path_matches = terms.iter().all(|term| path_lower.contains(term));
                if query.kind.is_none_or(|kind| kind == "symbol") {
                    for symbol in &structure.symbols {
                        let name = symbol.qualified.to_lowercase();
                        if path_matches || terms.iter().all(|term| name.contains(term)) {
                            let rank = if name == searched
                                || symbol.name.eq_ignore_ascii_case(&searched)
                            {
                                0
                            } else {
                                1
                            };
                            matches.push((
                                rank,
                                GraphMatch {
                                    kind: "symbol",
                                    path: path.clone(),
                                    line: symbol.start_line,
                                    detail: GraphDetail::Symbol {
                                        name: symbol.qualified.clone(),
                                        declaration: symbol.kind.clone(),
                                        end_line: symbol.end_line,
                                        container: symbol.container.clone(),
                                    },
                                },
                            ));
                        }
                    }
                }
                if query.kind != Some("symbol") {
                    for reference in &structure.references {
                        if query.kind.is_some_and(|kind| kind != reference.kind) {
                            continue;
                        }
                        let owner = reference
                            .owner
                            .and_then(|index| structure.symbols.get(index));
                        let target = reference.target.to_lowercase();
                        let from = owner.map(|symbol| symbol.qualified.to_lowercase());
                        if path_matches
                            || terms.iter().all(|term| {
                                target.contains(term)
                                    || from.as_ref().is_some_and(|name| name.contains(term))
                            })
                        {
                            let leaf = target.rsplit(['.', ':']).next().unwrap_or(&target);
                            let rank = if target == searched || leaf == searched {
                                2
                            } else {
                                3
                            };
                            matches.push((
                                rank,
                                GraphMatch {
                                    kind: reference.kind,
                                    path: path.clone(),
                                    line: reference.line,
                                    detail: GraphDetail::Reference {
                                        target: reference.target.clone(),
                                        from: owner.map(|symbol| symbol.qualified.clone()),
                                    },
                                },
                            ));
                        }
                    }
                }
            }
        }
        matches.sort_by(|(left_rank, left), (right_rank, right)| {
            (left_rank, &left.path, left.line).cmp(&(right_rank, &right.path, right.line))
        });
        let total = matches.len();
        let end = query.offset.saturating_add(query.limit);
        Ok(GraphPage {
            indexed_files,
            skipped_files,
            total,
            next_offset: (end < total).then_some(end),
            matches: matches
                .into_iter()
                .skip(query.offset)
                .take(query.limit)
                .map(|(_, item)| item)
                .collect(),
        })
    }
}
