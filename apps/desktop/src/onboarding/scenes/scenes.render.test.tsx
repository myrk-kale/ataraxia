// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { SLIDES } from "../slides";
import SlideScene from "./index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class FakeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeObserver;

describe("the animations of the slides", () => {
  it.each(SLIDES.map((slide) => slide.visual.scene))("%s draws its scene, with a description for a screen reader", async (scene) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<SlideScene scene={scene} still />));
    const drawn = host.querySelector('[role="img"][aria-label]');
    expect(drawn, scene).not.toBeNull();
    expect(drawn!.getAttribute("aria-label")!.length).toBeGreaterThan(10);
    expect(drawn!.textContent!.length + drawn!.querySelectorAll("svg").length).toBeGreaterThan(0);
    act(() => root.unmount());
    host.remove();
  });
});
