// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEY } from "./config";
import { PetSettings } from "./PetSettings";
import { forgetPetForTests } from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const stored = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
const byLabel = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
const byText = (text: string) => [...host.querySelectorAll<HTMLElement>("button")].find((node) => node.textContent?.trim() === text)!;
const state = () => host.querySelector(".pet")?.getAttribute("data-state");

function write(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event(input.type === "range" ? "change" : "input", { bubbles: true }));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  forgetPetForTests();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<PetSettings />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the companion's settings", () => {
  it("previews each state the way the pet will look for it", () => {
    expect(state()).toBe("idle");
    for (const [label, expected] of [["Working", "running"], ["Needs you", "needs-input"], ["Done", "ready"], ["Error", "blocked"], ["Resting", "idle"]] as const) {
      act(() => byText(label).click());
      expect(state()).toBe(expected);
    }
  });

  it("chooses whether it is shown", () => {
    act(() => byText("Mini").click());
    expect(stored().mode).toBe("mini");
    act(() => byText("Off").click());
    expect(stored().mode).toBe("off");
    act(() => byText("Pet").click());
    expect(stored().mode).toBe("pet");
  });

  it("changes who it is: species, colour, accessory and name, each remembered", () => {
    act(() => byLabel("Robot").click());
    expect(stored().species).toBe("robot");
    act(() => byLabel("Colour #3fa58a").click());
    expect(stored().color).toBe("#3fa58a");
    expect(byLabel("Colour #3fa58a").getAttribute("aria-pressed")).toBe("true");
    act(() => byText("Crown").click());
    expect(stored().accessory).toBe("crown");
    const name = byLabel("Name") as HTMLInputElement;
    write(name, "Bolt");
    expect(stored().name).toBe("Bolt");
    expect(host.querySelector(".pet")?.getAttribute("aria-label")).toContain("Bolt");
    // A name left empty goes back to the default when the field is left.
    write(name, "   ");
    act(() => name.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(stored().name).toBe("Ata");
  });

  it("sets the size within its limits", () => {
    write(byLabel("Size") as HTMLInputElement, "1.5");
    expect(stored().scale).toBe(1.5);
    expect(host.textContent).toContain("150%");
  });

  it("takes the person's own picture in place of a species, and gives it back", () => {
    act(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored(), image: "data:image/png;base64,iVBORw0KGgo=" }));
      forgetPetForTests();
    });
    expect(host.querySelector(".pet img")).not.toBeNull();
    expect((byText("Crown") as HTMLButtonElement).disabled).toBe(true);
    act(() => byText("Remove").click());
    expect(stored().image).toBeNull();
    expect(host.querySelector(".pet img")).toBeNull();
    // Choosing a species also puts the picture away.
    act(() => byLabel("Cat").click());
    expect(stored().species).toBe("cat");
  });

  it("starts over, keeping whether it is shown", () => {
    act(() => byText("Mini").click());
    act(() => byLabel("Ghost").click());
    write(byLabel("Size") as HTMLInputElement, "2");
    act(() => byText("Reset").click());
    expect(stored()).toMatchObject({ mode: "mini", species: "blob", name: "Ata", scale: 1, position: null });
  });
});
