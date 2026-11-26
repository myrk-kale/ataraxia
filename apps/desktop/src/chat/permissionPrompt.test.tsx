// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { PendingPermission, PermissionQuestion } from "../lib/agent";
import { PermissionPrompt } from "./PermissionPrompt";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: PendingPermission = {
  requestId: "r1",
  turnId: "t1",
  toolName: "Bash",
  detail: "Allow running: ls",
};

const single: PermissionQuestion = {
  question: "Which approach?",
  header: "Approach",
  multiSelect: false,
  options: [
    { label: "Resume", description: "Keeps the context" },
    { label: "Hide", description: "Only the screen" },
  ],
};

const multi: PermissionQuestion = {
  question: "Which checks?",
  header: "Checks",
  multiSelect: true,
  options: [
    { label: "Lint", description: "" },
    { label: "Tests", description: "" },
  ],
};

let root: Root;
let host: HTMLDivElement;
let resolve: Mock<(allow: boolean, answers?: Record<string, string>) => void | Promise<boolean>>;

function show(pending: PendingPermission) {
  act(() => root.render(<PermissionPrompt pending={pending} onResolve={resolve} />));
}

const ask = (...questions: PermissionQuestion[]): PendingPermission => ({
  ...base,
  toolName: "AskUserQuestion",
  detail: "Claude has a question for you",
  questions,
});

const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
const row = (text: string) => buttons().find((item) => item.textContent?.includes(text))!;
const input = () => host.querySelector<HTMLInputElement>("input")!;

function press(key: string, target: Element = document.activeElement ?? host) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function write(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  resolve = vi.fn<(allow: boolean, answers?: Record<string, string>) => void | Promise<boolean>>();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("a permission the agent asks for", () => {
  it("is shown in place, with Yes and No, and the first option has the focus", () => {
    show(base);
    expect(host.textContent).toContain("Allow running: ls");
    expect(host.querySelector("dialog")).toBeNull();
    expect(row("Yes").textContent).toContain("1.");
    expect(document.activeElement).toBe(row("Yes"));
  });

  it("is given with Enter on Yes, with 1, and refused with 2, No or Esc", () => {
    show(base);
    press("Enter", row("Yes"));
    // A real Enter on a focused button clicks it.
    act(() => row("Yes").click());
    expect(resolve).toHaveBeenLastCalledWith(true);
    // Each request is answered once, so the next answers are to new requests.
    show({ ...base, requestId: "r2" });
    press("2");
    expect(resolve).toHaveBeenLastCalledWith(false);
    show({ ...base, requestId: "r3" });
    press("1");
    expect(resolve).toHaveBeenLastCalledWith(true);
    show({ ...base, requestId: "r4" });
    const esc = press("Escape");
    expect(esc.defaultPrevented).toBe(true);
    expect(resolve).toHaveBeenLastCalledWith(false);
  });

  it("moves between the rows with the arrows, wrapping around", () => {
    show(base);
    press("ArrowDown");
    expect(document.activeElement).toBe(row("No"));
    press("ArrowDown");
    expect(document.activeElement).toBe(row("Yes"));
    press("ArrowUp");
    expect(document.activeElement).toBe(row("No"));
  });
});

describe("questions the agent asks", () => {
  it("shows the question and its options instead of an approval", () => {
    show(ask(single));
    expect(host.textContent).toContain("Which approach?");
    expect(host.textContent).toContain("Keeps the context");
    expect(host.textContent).not.toContain("Yes");
    expect(input().placeholder).toContain("something else");
    expect(document.activeElement).toBe(row("Resume"));
  });

  it("answers with the option chosen, by click, by its number or by Enter", () => {
    show(ask(single));
    act(() => row("Hide").click());
    expect(resolve).toHaveBeenLastCalledWith(true, { "Which approach?": "Hide" });
    show({ ...ask(single), requestId: "r2" });
    press("1");
    expect(resolve).toHaveBeenLastCalledWith(true, { "Which approach?": "Resume" });
  });

  it("answers with the person's own words when they type them and press Enter", () => {
    show(ask(single));
    act(() => input().focus());
    write("Something in between");
    press("Enter", input());
    expect(resolve).toHaveBeenLastCalledWith(true, { "Which approach?": "Something in between" });
  });

  it("does not take a number typed in the text line for an option", () => {
    show(ask(single));
    act(() => input().focus());
    press("1", input());
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not answer an empty line", () => {
    show(ask(single));
    act(() => input().focus());
    write("   ");
    press("Enter", input());
    expect(resolve).not.toHaveBeenCalled();
  });

  it("lets several options be ticked and sends them together with what was typed", () => {
    show(ask(multi));
    const send = () => buttons().find((item) => item.textContent === "Send")!;
    expect(send().disabled).toBe(true);
    act(() => row("Lint").click());
    act(() => row("Tests").click());
    expect(row("Lint").getAttribute("aria-checked")).toBe("true");
    write("and the docs");
    expect(send().disabled).toBe(false);
    act(() => send().click());
    expect(resolve).toHaveBeenLastCalledWith(true, {
      "Which checks?": "Lint, Tests, and the docs",
    });
  });

  it("unticks an option that is clicked again", () => {
    show(ask(multi));
    act(() => row("Lint").click());
    act(() => row("Lint").click());
    expect(row("Lint").getAttribute("aria-checked")).toBe("false");
  });

  it("goes through several questions one by one and sends all the answers at the end", () => {
    show(ask(single, multi));
    expect(host.textContent).toContain("Question 1 of 2");
    act(() => row("Resume").click());
    expect(resolve).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Question 2 of 2");
    expect(host.textContent).toContain("Which checks?");
    act(() => row("Tests").click());
    act(() => buttons().find((item) => item.textContent === "Send")!.click());
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenLastCalledWith(true, {
      "Which approach?": "Resume",
      "Which checks?": "Tests",
    });
  });

  it("goes back to the question before and finds the answer as it was left", () => {
    show(ask(single, multi));
    expect(buttons().some((item) => item.textContent === "Back")).toBe(false);
    act(() => row("Resume").click());
    act(() => row("Tests").click());
    act(() => buttons().find((item) => item.textContent === "Back")!.click());
    expect(host.textContent).toContain("Question 1 of 2");
    expect(row("Resume").getAttribute("aria-current")).toBe("true");
    act(() => row("Hide").click());
    expect(host.textContent).toContain("Question 2 of 2");
    // What was ticked before going back is still ticked.
    expect(row("Tests").getAttribute("aria-checked")).toBe("false");
    act(() => row("Lint").click());
    act(() => buttons().find((item) => item.textContent === "Send")!.click());
    expect(resolve).toHaveBeenLastCalledWith(true, {
      "Which approach?": "Hide",
      "Which checks?": "Lint",
    });
  });

  it("keeps what was ticked when going back and forth", () => {
    show(ask(multi, single));
    act(() => row("Tests").click());
    act(() => buttons().find((item) => item.textContent === "Next")!.click());
    act(() => buttons().find((item) => item.textContent === "Back")!.click());
    expect(row("Tests").getAttribute("aria-checked")).toBe("true");
  });

  it("passes over a question without answering it and sends the others", () => {
    show(ask(single, multi));
    act(() => buttons().find((item) => item.textContent === "Skip")!.click());
    expect(resolve).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Question 2 of 2");
    act(() => row("Lint").click());
    act(() => buttons().find((item) => item.textContent === "Send")!.click());
    expect(resolve).toHaveBeenLastCalledWith(true, { "Which checks?": "Lint" });
  });

  it("declines the request when every question was passed over", () => {
    show(ask(single, multi));
    act(() => buttons().find((item) => item.textContent === "Skip")!.click());
    act(() => buttons().find((item) => item.textContent === "Skip")!.click());
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenLastCalledWith(false);
  });

  it("drops an answer that was passed over after going back", () => {
    show(ask(single, multi));
    act(() => row("Resume").click());
    act(() => buttons().find((item) => item.textContent === "Back")!.click());
    act(() => buttons().find((item) => item.textContent === "Skip")!.click());
    act(() => row("Lint").click());
    act(() => buttons().find((item) => item.textContent === "Send")!.click());
    expect(resolve).toHaveBeenLastCalledWith(true, { "Which checks?": "Lint" });
  });

  it("is skipped with Esc or the Skip button, which declines it", () => {
    show(ask(single));
    const esc = press("Escape");
    expect(esc.defaultPrevented).toBe(true);
    expect(resolve).toHaveBeenLastCalledWith(false);
    show({ ...ask(single), requestId: "r2" });
    act(() => buttons().find((item) => item.textContent === "Skip")!.click());
    expect(resolve).toHaveBeenLastCalledWith(false);
  });

  it("answers a request once, however many times the answer is given", () => {
    show(ask(single));
    act(() => row("Resume").click());
    act(() => row("Resume").click());
    press("Escape");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("lets an answer that did not go through be given again", async () => {
    resolve.mockResolvedValueOnce(false);
    show(ask(single));
    await act(async () => row("Resume").click());
    await act(async () => row("Resume").click());
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("starts again for the next request", () => {
    show(ask(single, multi));
    act(() => row("Resume").click());
    expect(host.textContent).toContain("Question 2 of 2");
    show({ ...ask(single, multi), requestId: "r2" });
    expect(host.textContent).toContain("Question 1 of 2");
  });
});
