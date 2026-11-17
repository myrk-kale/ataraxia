import { invoke } from "@tauri-apps/api/core";
import type { RepositoryId, WorkspaceId } from "./workspace";

export type ResourceScope = "global" | "workspace" | "project";
export type ResourceKind = "skill" | "mcp";
export type ResourceMark = "inherit" | "on" | "off";

/** Where the manager is looking: the scope it edits and the workspace and repository around it. */
export type ResourceContext = {
  scope: ResourceScope;
  workspaceId: WorkspaceId | null;
  repositoryId: RepositoryId | null;
};

export type ResourceItem = {
  id: string;
  kind: ResourceKind;
  description: string;
  /** The narrowest scope that defines it. */
  definedIn: ResourceScope;
  /** What the scope being edited says about it. */
  state: ResourceMark;
  /** Whether it applies for someone at this scope. */
  effective: boolean;
  /** What it comes to when this scope says nothing, and the scope that decides it. */
  inherited: boolean;
  inheritedFrom: ResourceScope | null;
};

export type ResourceList = { skills: ResourceItem[]; mcps: ResourceItem[]; problems: string[] };
export type SkillText = { description: string; body: string };
export type McpConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

export const resourcesList = (context: ResourceContext) => invoke<ResourceList>("resources_list", { context });
export const resourcesSetState = (context: ResourceContext, kind: ResourceKind, id: string, mark: ResourceMark) =>
  invoke<void>("resources_set_state", { context, kind, id, mark });
export const resourcesReadSkill = (context: ResourceContext, id: string) =>
  invoke<SkillText>("resources_read_skill", { context, id });
export const resourcesSaveSkill = (
  context: ResourceContext,
  id: string,
  description: string,
  body: string,
  replace: boolean,
) => invoke<void>("resources_save_skill", { context, id, description, body, replace });
export const resourcesDeleteSkill = (context: ResourceContext, id: string) =>
  invoke<void>("resources_delete_skill", { context, id });
export const resourcesReadMcp = (context: ResourceContext, name: string) =>
  invoke<McpConfig>("resources_read_mcp", { context, name });
export const resourcesSaveMcp = (context: ResourceContext, name: string, config: McpConfig, replace: boolean) =>
  invoke<void>("resources_save_mcp", { context, name, config, replace });
export const resourcesDeleteMcp = (context: ResourceContext, name: string) =>
  invoke<void>("resources_delete_mcp", { context, name });

export const SCOPE_LABEL: Record<ResourceScope, string> = {
  global: "Global",
  workspace: "Workspace",
  project: "Project",
};

/** `KEY=value` per line, as typed in a form; a line without `=` says which one it is. */
export function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    const at = line.indexOf("=");
    if (at <= 0) {
      throw new Error(`"${line}" is not KEY=value`);
    }
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

export function formatPairs(values: Record<string, string> | undefined): string {
  return Object.entries(values ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export type McpForm = {
  kind: "command" | "url";
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
};

export const EMPTY_MCP_FORM: McpForm = { kind: "command", command: "", args: "", env: "", url: "", headers: "" };

/** The standard MCP server object a form describes; throws a sentence for what is missing or wrong. */
export function mcpConfigFromForm(form: McpForm): McpConfig {
  if (form.kind === "url") {
    const url = form.url.trim();
    if (url === "") {
      throw new Error("Give the server's URL.");
    }
    const headers = parsePairs(form.headers);
    return Object.keys(headers).length > 0 ? { url, headers } : { url };
  }
  const command = form.command.trim();
  if (command === "") {
    throw new Error("Give the command that starts the server.");
  }
  const args = form.args
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const env = parsePairs(form.env);
  return {
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

export function mcpFormFromConfig(config: McpConfig): McpForm {
  return config.url !== undefined
    ? { ...EMPTY_MCP_FORM, kind: "url", url: config.url, headers: formatPairs(config.headers) }
    : {
        ...EMPTY_MCP_FORM,
        command: config.command ?? "",
        args: (config.args ?? []).join("\n"),
        env: formatPairs(config.env),
      };
}

/** What a mark says in words, for the row of an item at the scope being edited. */
export function markSummary(item: Pick<ResourceItem, "state" | "effective" | "inherited" | "inheritedFrom">): string {
  if (item.state === "inherit") {
    const from = item.inheritedFrom ? ` (${SCOPE_LABEL[item.inheritedFrom].toLowerCase()} says so)` : "";
    return item.inherited ? `On${from}` : `Off${from}`;
  }
  return item.state === "on" ? "On here" : "Off here";
}
