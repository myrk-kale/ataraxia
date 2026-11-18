import { invoke } from "@tauri-apps/api/core";

/** `draft` is a title jotted down, `ready` says it can be developed, `done` is finished. */
export type TaskStatus = "draft" | "ready" | "done";

/** One of the developer's own tasks. The number is what is said in a chat: "#12". */
export type Task = {
  number: number;
  title: string;
  notes: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
};

export type TaskPatch = { title?: string; notes?: string; status?: TaskStatus };

/** Newest first. */
export const tasksList = () => invoke<Task[]>("tasks_list");
export const taskCreate = (title: string) => invoke<Task>("task_create", { title });
export const taskUpdate = (number: number, patch: TaskPatch) => invoke<Task>("task_update", { number, patch });
export const taskDelete = (number: number) => invoke<void>("task_delete", { number });
