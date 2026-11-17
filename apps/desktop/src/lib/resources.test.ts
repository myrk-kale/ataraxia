import { describe, expect, it } from "vitest";
import { EMPTY_MCP_FORM, formatPairs, markSummary, mcpConfigFromForm, mcpFormFromConfig, parsePairs } from "./resources";

describe("MCP server forms", () => {
  it("builds a command server with arguments and environment, leaving out what is empty", () => {
    const config = mcpConfigFromForm({
      ...EMPTY_MCP_FORM,
      command: " npx ",
      args: "-y\n  @scope/server \n\n",
      env: "TOKEN=abc=def\n\nMODE = fast",
    });
    expect(config).toEqual({ command: "npx", args: ["-y", "@scope/server"], env: { TOKEN: "abc=def", MODE: "fast" } });
    expect(mcpConfigFromForm({ ...EMPTY_MCP_FORM, command: "echo" })).toEqual({ command: "echo" });
  });

  it("builds a URL server with headers", () => {
    expect(mcpConfigFromForm({ ...EMPTY_MCP_FORM, kind: "url", url: "https://x.dev/mcp", headers: "Authorization=Bearer t" })).toEqual({
      url: "https://x.dev/mcp",
      headers: { Authorization: "Bearer t" },
    });
  });

  it("says what is missing or wrong", () => {
    expect(() => mcpConfigFromForm(EMPTY_MCP_FORM)).toThrow(/command/);
    expect(() => mcpConfigFromForm({ ...EMPTY_MCP_FORM, kind: "url" })).toThrow(/URL/);
    expect(() => parsePairs("not a pair")).toThrow(/KEY=value/);
    expect(() => parsePairs("=x")).toThrow(/KEY=value/);
  });

  it("round-trips a server through the form", () => {
    const config = { command: "uvx", args: ["a", "b"], env: { K: "v" } };
    expect(mcpConfigFromForm(mcpFormFromConfig(config))).toEqual(config);
    const remote = { url: "https://x", headers: { H: "1" } };
    expect(mcpConfigFromForm(mcpFormFromConfig(remote))).toEqual(remote);
    expect(formatPairs(undefined)).toBe("");
  });
});

describe("what a mark says", () => {
  it("names the scope that decides when this one inherits", () => {
    const base = { effective: true, inherited: true, inheritedFrom: null } as const;
    expect(markSummary({ ...base, state: "inherit" })).toBe("On");
    expect(markSummary({ state: "inherit", effective: false, inherited: false, inheritedFrom: "workspace" })).toBe("Off (workspace says so)");
    expect(markSummary({ ...base, state: "on" })).toBe("On here");
    expect(markSummary({ ...base, state: "off", effective: false })).toBe("Off here");
  });
});
