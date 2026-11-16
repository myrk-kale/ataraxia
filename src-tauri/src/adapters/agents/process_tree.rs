//! Process-tree discovery for the agent harnesses and their stdio MCP servers.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::Value;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::domain::{Error, ErrorCode, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub started_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessDiscovery {
    Running(Vec<ProcessIdentity>),
    NotDetected,
    Unidentified,
}

#[derive(Debug, Clone)]
struct ProcessRecord {
    pid: u32,
    parent_pid: Option<u32>,
    started_at: u64,
    name: String,
    executable: Option<String>,
    command: Vec<String>,
}

pub struct ProcessSnapshot {
    system: System,
    records: HashMap<u32, ProcessRecord>,
}

impl ProcessSnapshot {
    pub fn new() -> Self {
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .with_cmd(UpdateKind::Always)
                .with_exe(UpdateKind::Always)
                .without_tasks(),
        );
        let records = system
            .processes()
            .values()
            .map(|process| {
                let pid = process.pid().as_u32();
                (
                    pid,
                    ProcessRecord {
                        pid,
                        parent_pid: process.parent().map(Pid::as_u32),
                        started_at: process.start_time(),
                        name: process.name().to_string_lossy().into_owned(),
                        executable: process
                            .exe()
                            .and_then(Path::file_name)
                            .map(|name| name.to_string_lossy().into_owned()),
                        command: process
                            .cmd()
                            .iter()
                            .map(|argument| argument.to_string_lossy().into_owned())
                            .collect(),
                    },
                )
            })
            .collect();
        Self { system, records }
    }

    /// Finds only a process whose executable and configured argument sequence both match below
    /// the owning harness. A process that merely uses the same executable is left unidentified.
    pub fn find_mcp_processes(&self, harness_pid: u32, server: &Value) -> ProcessDiscovery {
        let Some(program) = server.get("command").and_then(Value::as_str) else {
            return ProcessDiscovery::NotDetected;
        };
        let args: Vec<String> = server
            .get("args")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        if args.is_empty() {
            return ProcessDiscovery::Unidentified;
        }

        let descendants: Vec<&ProcessRecord> = self
            .records
            .values()
            .filter(|process| self.is_descendant(process.pid, harness_pid))
            .collect();
        let executable_matches: Vec<&ProcessRecord> = descendants
            .iter()
            .copied()
            .filter(|process| executable_matches(process, program))
            .collect();
        let mut matches: Vec<&ProcessRecord> = executable_matches
            .iter()
            .copied()
            .filter(|process| arguments_match(&process.command, &args))
            .collect();

        if matches.is_empty() {
            let arguments_seen = descendants
                .iter()
                .any(|process| arguments_match(&process.command, &args));
            return if executable_matches.is_empty() && !arguments_seen {
                ProcessDiscovery::NotDetected
            } else {
                ProcessDiscovery::Unidentified
            };
        }

        let matching_pids: HashSet<u32> = matches.iter().map(|process| process.pid).collect();
        matches.retain(|process| {
            !self
                .ancestors(process.pid)
                .into_iter()
                .any(|ancestor| matching_pids.contains(&ancestor))
        });

        ProcessDiscovery::Running(
            matches
                .into_iter()
                .map(|process| ProcessIdentity {
                    pid: process.pid,
                    started_at: process.started_at,
                })
                .collect(),
        )
    }

    /// Rechecks ownership and the start time before stopping an MCP process and its children.
    pub fn stop_mcp_process(
        &mut self,
        harness_pid: u32,
        server: &Value,
        target: ProcessIdentity,
    ) -> Result<()> {
        let matches = match self.find_mcp_processes(harness_pid, server) {
            ProcessDiscovery::Running(matches) => matches,
            ProcessDiscovery::NotDetected | ProcessDiscovery::Unidentified => Vec::new(),
        };
        if !matches.contains(&target) {
            return Err(Error::new(
                ErrorCode::Conflict,
                "the MCP process changed or is no longer owned by this harness",
            ));
        }

        let mut tree = self.descendant_tree(target.pid);
        tree.push(target);
        let mut failed = Vec::new();
        for process in tree {
            let Some(current) = self.system.process(Pid::from_u32(process.pid)) else {
                continue;
            };
            if current.start_time() != process.started_at {
                continue;
            }
            if !current.kill() {
                failed.push(process.pid);
            }
        }
        if failed.is_empty() {
            Ok(())
        } else {
            Err(Error::new(
                ErrorCode::Agent,
                format!(
                    "could not stop the complete MCP process tree ({})",
                    failed
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ))
        }
    }

    fn is_descendant(&self, pid: u32, root_pid: u32) -> bool {
        self.ancestors(pid).contains(&root_pid)
    }

    fn ancestors(&self, pid: u32) -> Vec<u32> {
        let mut ancestors = Vec::new();
        let mut next = self
            .records
            .get(&pid)
            .and_then(|process| process.parent_pid);
        let mut visited = HashSet::new();
        while let Some(parent) = next {
            if !visited.insert(parent) {
                break;
            }
            ancestors.push(parent);
            next = self
                .records
                .get(&parent)
                .and_then(|process| process.parent_pid);
        }
        ancestors
    }

    fn descendant_tree(&self, root_pid: u32) -> Vec<ProcessIdentity> {
        let mut processes: Vec<(usize, ProcessIdentity)> = self
            .records
            .values()
            .filter_map(|process| {
                let depth = self
                    .ancestors(process.pid)
                    .iter()
                    .position(|ancestor| *ancestor == root_pid)?;
                Some((
                    depth,
                    ProcessIdentity {
                        pid: process.pid,
                        started_at: process.started_at,
                    },
                ))
            })
            .collect();
        processes.sort_by(|left, right| right.0.cmp(&left.0));
        processes.into_iter().map(|(_, process)| process).collect()
    }
}

impl Default for ProcessSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

fn executable_matches(process: &ProcessRecord, expected: &str) -> bool {
    let expected = Path::new(expected)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let names = [process.executable.as_deref(), Some(&process.name)];
    names
        .into_iter()
        .flatten()
        .any(|name| same_name(name, &expected))
}

fn same_name(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

fn arguments_match(command: &[String], expected: &[String]) -> bool {
    if expected.is_empty() {
        return false;
    }
    command
        .iter()
        .skip(1)
        .collect::<Vec<_>>()
        .windows(expected.len())
        .any(|window| {
            window
                .iter()
                .zip(expected)
                .all(|(left, right)| *left == right)
        })
}
