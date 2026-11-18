import type { Task, TaskStatus } from "../lib/tasks";

/** What a task is called in a chat, so the agent can fetch it: `#12`. */
export function taskRef(task: Pick<Task, "number">): string {
  return `#${task.number}`;
}

export type TaskFilter = "open" | "ready" | "done";

export const FILTERS: readonly { id: TaskFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "ready", label: "Ready" },
  { id: "done", label: "Done" },
];

/** The tasks a filter shows: open is everything not done, ready is the ones cleared for development. */
export function visibleTasks(tasks: readonly Task[], filter: TaskFilter): Task[] {
  switch (filter) {
    case "open":
      return tasks.filter((task) => task.status !== "done");
    case "ready":
      return tasks.filter((task) => task.status === "ready");
    case "done":
      return tasks.filter((task) => task.status === "done");
  }
}

export function countOf(tasks: readonly Task[], filter: TaskFilter): number {
  return visibleTasks(tasks, filter).length;
}

/** Ticking a task off finishes it; ticking it again takes it back as a draft, to be cleared once more. */
export function toggledDone(status: TaskStatus): TaskStatus {
  return status === "done" ? "draft" : "done";
}

/** A title as typed into the field: one line, trimmed. Nothing to add when it is empty. */
export function titleToAdd(typed: string): string | null {
  const title = typed.split(/\s+/).filter(Boolean).join(" ");
  return title === "" ? null : title;
}

/**
 * The text of a task as it is put into a message to an agent: its reference, title and notes.
 * Handy to paste into a chat that cannot reach the API.
 */
export function taskAsMessage(task: Task): string {
  const notes = task.notes.trim();
  return notes ? `${taskRef(task)} ${task.title}\n\n${notes}` : `${taskRef(task)} ${task.title}`;
}

/** The status a click on "ready for development" leads to. */
export function toggledReady(status: TaskStatus): TaskStatus {
  return status === "ready" ? "draft" : "ready";
}
