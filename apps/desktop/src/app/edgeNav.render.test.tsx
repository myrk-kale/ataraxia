// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeNav } from "./EdgeNav";
import { nextSpace, SPACES } from "./spaces";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the dots that move between spaces", () => {
  it("has a place for the workbench, with the other workspaces and before the artifacts", () => {
    expect(SPACES.map((space) => space.id)).toEqual(["chat", "code", "browser", "workbench", "flow"]);
    expect(SPACES.find((space) => space.id === "workbench")?.group).toBe("workspace");
    expect(nextSpace("browser", 1)).toBe("workbench");
    expect(nextSpace("workbench", 1)).toBe("flow");
  });

  it("says in words, and with a mark, that something waits for the person in a space", async () => {
    const onSelect = vi.fn();
    await act(async () => root.render(<EdgeNav attention={{ workbench: 2 }} space="chat" onSelect={onSelect} />));
    const waiting = host.querySelector<HTMLButtonElement>('button[aria-label="Workbench, 2 waiting for you"]');
    expect(waiting).toBeTruthy();
    expect(waiting!.textContent).toContain("Workbench · 2 waiting for you");
    // Only that dot is marked.
    expect(host.querySelector('button[aria-label="Chat"]')).toBeTruthy();
    expect(host.querySelectorAll("button .bg-cg-amber")).toHaveLength(1);
    await act(async () => waiting!.click());
    expect(onSelect).toHaveBeenCalledWith("workbench");
  });

  it("marks nothing when nothing waits", async () => {
    await act(async () => root.render(<EdgeNav attention={{ workbench: 0 }} space="chat" onSelect={() => undefined} />));
    expect(host.querySelector('button[aria-label="Workbench"]')).toBeTruthy();
    expect(host.querySelectorAll("button .bg-cg-amber")).toHaveLength(0);
  });
});
