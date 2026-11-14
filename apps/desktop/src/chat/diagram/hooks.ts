import { useEffect, useState, useSyncExternalStore } from "react";

/** Whether the person asked the system for less motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
}

/** The ratio of device pixels to CSS pixels, which changes with zoom and between screens. */
export function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    let query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const update = () => {
      setRatio(window.devicePixelRatio || 1);
      query.removeEventListener("change", update);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      query.addEventListener("change", update);
    };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return ratio;
}

/** `value`, but only once it has stopped changing for `ms`. The first value is there at once. */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(value, settled)) {
      return;
    }
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, settled, ms]);
  return settled;
}

/**
 * Whether `value` has stayed the same for `ms`. False at first, and again after every change,
 * so it is false while text is arriving and true once the writer has stopped.
 */
export function useQuiet(value: unknown, ms: number): boolean {
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    setQuiet(false);
    const timer = window.setTimeout(() => setQuiet(true), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return quiet;
}
