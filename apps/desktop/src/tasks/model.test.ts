import { describe, expect, it } from "vitest";
import type { Task } from "../lib/tasks";
import { countOf, taskAsMessage, taskRef, titleToAdd, toggledDone, toggledReady, visibleTasks } from "./model";

function task(number: number, status: Task["status"], notes = ""): Task {
  return { number, title: `task ${number}`, notes, status, created_at: "t", updated_at: "t" };
}

const all = [task(4, "done"), task(3, "ready"), task(2, "draft"), task(1, "ready")];

describe("the task list", () => {
  it("shows what is open, what is ready and what is done", () => {
    expect(visibleTasks(all, "open").map((item) => item.number)).toEqual([3, 2, 1]);
    expect(visibleTasks(all, "ready").map((item) => item.number)).toEqual([3, 1]);
    expect(visibleTasks(all, "done").map((item) => item.number)).toEqual([4]);
    expect([countOf(all, "open"), countOf(all, "ready"), countOf(all, "done")]).toEqual([3, 2, 1]);
  });

  it("is referred to by its number", () => {
    expect(taskRef(task(12, "draft"))).toBe("#12");
    expect(taskAsMessage(task(12, "draft"))).toBe("#12 task 12");
    expect(taskAsMessage(task(12, "draft", "  see the README\n"))).toBe("#12 task 12\n\nsee the README");
  });

  it("adds a task from a typed title, and nothing from a blank one", () => {
    expect(titleToAdd("  fix   the scroll ")).toBe("fix the scroll");
    expect(titleToAdd("   ")).toBeNull();
  });

  it("toggles done and ready", () => {
    expect(toggledDone("draft")).toBe("done");
    expect(toggledDone("ready")).toBe("done");
    expect(toggledDone("done")).toBe("draft");
    expect(toggledReady("draft")).toBe("ready");
    expect(toggledReady("ready")).toBe("draft");
    expect(toggledReady("done")).toBe("ready");
  });
});
