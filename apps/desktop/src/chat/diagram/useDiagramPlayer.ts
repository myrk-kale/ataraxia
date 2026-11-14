import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EFFECTS, Frame, type EffectId } from "./effects";
import { CELL_H, CELL_W, sharedRenderer } from "./gpu";
import { useReducedMotion } from "./hooks";
import { Player, type PlayState } from "./player";
import type { Scene } from "./scene";
import { currentPalette, diagramFont, themeVersion, useThemeVersion } from "./theme";

export interface DiagramPlayerOptions {
  scene: Scene;
  source: string;
  effect: EffectId | "none";
  loop: boolean;
  /** Whether it should be moving now: in view, and not covered by something else. */
  active: boolean;
  /** Device pixels per CSS pixel of the drawing: the screen's ratio, times any zoom. */
  scale: number;
  /** Tells two views of the same diagram apart, so one having played does not stop the other. */
  variant?: string;
  onUnavailable: () => void;
}

/** The size in device pixels of the canvas a diagram is drawn on, at a scale. */
export function canvasSize(scene: Scene, scale: number): { width: number; height: number } {
  return {
    width: scene.width * Math.round(CELL_W * scale),
    height: scene.height * Math.round(CELL_H * scale),
  };
}

/**
 * Draws a diagram on a canvas and plays its animation: the canvas to put in the page, the state
 * of the animation, and what to do to it. Used by the diagram in the reply and by the full
 * screen view, which draw the same scene at different scales.
 */
export function useDiagramPlayer({
  scene,
  source,
  effect,
  loop,
  active,
  scale,
  variant = "",
  onUnavailable,
}: DiagramPlayerOptions) {
  const reduced = useReducedMotion();
  const theme = useThemeVersion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<Player | null>(null);
  const frame = useMemo(() => new Frame(scene.width * scene.height), [scene]);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const [state, setState] = useState<PlayState>("rest");

  // The canvas holds one device pixel per pixel drawn; setting its size clears it.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      const { width, height } = canvasSize(scene, scale);
      canvas.width = width;
      canvas.height = height;
    }
    playerRef.current?.repaint();
  }, [scene, scale]);

  useEffect(() => {
    const player = new Player({
      scene,
      frame,
      key: `${scene.style}\0${variant}\0${source}`,
      draw: () => {
        const context = canvasRef.current?.getContext("2d");
        const renderer = sharedRenderer();
        if (!context || !renderer) {
          return false;
        }
        return renderer.draw(
          context,
          frame,
          scene.width,
          scene.height,
          scaleRef.current,
          currentPalette(),
          diagramFont(),
          themeVersion(),
        );
      },
      onFail: onUnavailable,
      onChange: setState,
    });
    playerRef.current = player;
    setState("rest");
    // The letters are set in a font the page may not have asked for yet; ask, and draw again.
    void document.fonts?.load?.(`13px ${diagramFont()}`).catch(() => undefined);
    return () => {
      player.dispose();
      playerRef.current = null;
    };
  }, [scene, frame, source, variant, onUnavailable]);

  useEffect(() => {
    playerRef.current?.configure(effect, loop, reduced);
  }, [effect, loop, reduced, scene]);

  useEffect(() => {
    playerRef.current?.setVisible(active);
  }, [active, scene]);

  useEffect(() => {
    if (playerRef.current && !playerRef.current.running) {
      playerRef.current.repaint();
    }
  }, [theme]);

  return {
    canvasRef,
    state,
    reduced,
    /** Whether there is an animation to pause: one is chosen, and the system allows motion. */
    animated: effect !== "none" && EFFECTS.includes(effect) && !reduced,
    toggle: () => playerRef.current?.toggle(),
  };
}
