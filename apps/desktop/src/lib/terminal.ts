import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PtySessionId = string;
export type WorktreeId = string;

export type PtyEnsureResponse = {
  sessionId: PtySessionId;
  created: boolean;
  replay: string;
};

export type TerminalOutputEvent = {
  worktreeId: WorktreeId;
  sessionId: PtySessionId;
  data: string;
};

export type TerminalExitEvent = {
  worktreeId: WorktreeId;
  sessionId: PtySessionId;
  code: number | null;
};

export function terminalEnsure(
  worktreeId: WorktreeId,
  cwd: string,
  cols: number,
  rows: number,
) {
  return invoke<PtyEnsureResponse>("terminal_ensure", {
    worktreeId,
    cwd,
    cols,
    rows,
  });
}

export function terminalWrite(sessionId: PtySessionId, data: string) {
  return invoke<void>("terminal_write", { sessionId, data });
}

export function terminalResize(
  sessionId: PtySessionId,
  cols: number,
  rows: number,
) {
  return invoke<void>("terminal_resize", { sessionId, cols, rows });
}

export function terminalKill(sessionId: PtySessionId) {
  return invoke<void>("terminal_kill", { sessionId });
}

export function encodeTerminalBytes(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function decodeTerminalBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function listenTerminalOutput(
  handler: (event: TerminalOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<TerminalOutputEvent>("terminal://output", (event) => {
    handler(event.payload);
  });
}

export async function listenTerminalExit(
  handler: (event: TerminalExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<TerminalExitEvent>("terminal://exit", (event) => {
    handler(event.payload);
  });
}
