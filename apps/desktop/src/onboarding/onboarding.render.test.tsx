// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "./Onboarding";
import { SLIDES } from "./slides";
import { ONBOARDING_KEY, ONBOARDING_VERSION, shouldShowOnboarding } from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const close = vi.fn();
const dialog = () => document.querySelector<HTMLElement>('[aria-label="Welcome to Ataraxia"]');
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim().startsWith(label))!;

function show(isOpen = true) {
  act(() => root.render(<Onboarding isOpen={isOpen} onClose={close} />));
}

function press(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

beforeEach(() => {
  close.mockClear();
  window.localStorage.clear();
  document.documentElement.setAttribute("data-theme", "dark");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the slides", () => {
  it("are short, each with a title, the problem it solves and a few points, and a picture for each theme", () => {
    expect(SLIDES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(SLIDES.map((slide) => slide.id)).size).toBe(SLIDES.length);
    for (const slide of SLIDES) {
      expect(slide.title.length, slide.id).toBeGreaterThan(5);
      expect(slide.problem.length, slide.id).toBeGreaterThan(10);
      expect(slide.points.length, slide.id).toBeGreaterThanOrEqual(2);
      expect(slide.points.length, slide.id).toBeLessThanOrEqual(4);
      slide.points.forEach((point) => expect(point.length, point).toBeLessThan(130));
      if (slide.visual.kind === "shot") {
        expect(slide.visual.light, slide.id).not.toBe(slide.visual.dark);
        expect(slide.visual.alt.length).toBeGreaterThan(10);
      }
    }
    // The screenshots are of the real app; the others are drawings made for the tour.
    expect(SLIDES.filter((slide) => slide.visual.kind === "shot").length).toBeGreaterThanOrEqual(5);
  });
});

describe("the welcome tour", () => {
  it("is a dialog in the middle of the screen that dims everything else, starting at the first slide", () => {
    show();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain(SLIDES[0]!.title);
    expect(document.querySelector(".bg-black\\/65")).not.toBeNull();
    show(false);
    expect(dialog()).toBeNull();
  });

  it("goes forward and back, by button, by the dots and by the arrow keys", () => {
    show();
    act(() => button("Next").click());
    expect(dialog()!.textContent).toContain(SLIDES[1]!.title);
    act(() => button("Previous slide").click());
    expect(dialog()!.textContent).toContain(SLIDES[0]!.title);
    expect((button("Previous slide") as HTMLButtonElement).disabled).toBe(true);
    act(() => button(`Go to ${SLIDES[4]!.title}`).click());
    expect(dialog()!.textContent).toContain(SLIDES[4]!.title);
    expect(document.querySelector('[aria-current="step"]')?.getAttribute("aria-label")).toBe(`Go to ${SLIDES[4]!.title}`);
    press("ArrowRight");
    expect(dialog()!.textContent).toContain(SLIDES[5]!.title);
    press("ArrowLeft");
    press("ArrowLeft");
    expect(dialog()!.textContent).toContain(SLIDES[3]!.title);
    for (let i = 0; i < 20; i++) press("ArrowLeft");
    expect(dialog()!.textContent).toContain(SLIDES[0]!.title);
    for (let i = 0; i < 20; i++) press("ArrowRight");
    expect(dialog()!.textContent).toContain(SLIDES.at(-1)!.title);
  });

  it("shows a screenshot of the theme in use and another when the theme changes", async () => {
    show();
    act(() => button(`Go to ${SLIDES.find((slide) => slide.id === "chat")!.title}`).click());
    const chat = SLIDES.find((slide) => slide.id === "chat")!;
    if (chat.visual.kind !== "shot") throw new Error("chat is a screenshot");
    expect(dialog()!.querySelector("img")?.getAttribute("src")).toBe(chat.visual.dark);
    await act(async () => {
      document.documentElement.setAttribute("data-theme", "light");
      await Promise.resolve();
    });
    expect(dialog()!.querySelector("img")?.getAttribute("src")).toBe(chat.visual.light);
  });

  it("can be skipped at any slide, and what was skipped is remembered", () => {
    show();
    act(() => button("Next").click());
    expect(shouldShowOnboarding()).toBe(true);
    act(() => button("Skip the tour").click());
    expect(close).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(ONBOARDING_KEY)).toBe(String(ONBOARDING_VERSION));
    expect(shouldShowOnboarding()).toBe(false);
  });

  it("ends on the last slide with a button that closes it and remembers it", () => {
    show();
    act(() => button(`Go to ${SLIDES.at(-1)!.title}`).click());
    expect([...document.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Next")).toBe(false);
    act(() => button("Start using Ataraxia").click());
    expect(close).toHaveBeenCalledTimes(1);
    expect(shouldShowOnboarding()).toBe(false);
  });

  it("starts from the first slide every time it is opened", () => {
    show();
    act(() => button("Next").click());
    show(false);
    show(true);
    expect(dialog()!.textContent).toContain(SLIDES[0]!.title);
  });

  it("is not closed by a click outside, which could dismiss it by accident", () => {
    show();
    act(() => {
      document.querySelector<HTMLElement>(".bg-black\\/65")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      document.querySelector<HTMLElement>(".bg-black\\/65")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("shows the keys worth knowing for a slide as keycaps", () => {
    show();
    act(() => button(`Go to ${SLIDES.find((slide) => slide.id === "btw")!.title}`).click());
    expect(dialog()!.textContent).toContain("Private BTW");
    expect(dialog()!.querySelectorAll("kbd").length).toBeGreaterThanOrEqual(4);
  });
});
