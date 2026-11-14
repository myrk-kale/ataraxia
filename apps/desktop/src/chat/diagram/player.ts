import { EFFECTS, Frame, effectDuration, renderEffect, renderRest, type EffectId } from "./effects";
import type { Scene } from "./scene";
import { onFrame } from "./ticker";

/** A frame is drawn at most this often: a diagram does not need more than 30 a second. */
const FRAME_MS = 30;
/** A pause longer than this (a hidden tab) does not make the animation jump ahead. */
const MAX_STEP_S = 0.1;
const PLAYED_LIMIT = 300;

/** Diagrams whose animation has played, so scrolling back to one does not play it again. */
const played = new Set<string>();

export const hasPlayed = (key: string) => played.has(key);

function remember(key: string) {
  played.delete(key);
  played.add(key);
  if (played.size > PLAYED_LIMIT) {
    const oldest = played.values().next().value;
    if (oldest !== undefined) {
      played.delete(oldest);
    }
  }
}

/** Whether a diagram is moving, held where it is by the reader, or showing its finished drawing. */
export type PlayState = "playing" | "paused" | "rest";

export interface PlayerOptions {
  scene: Scene;
  frame: Frame;
  /** Identifies this diagram among the ones that have played. */
  key: string;
  /** Puts the frame on the screen. False means it could not be drawn at all. */
  draw: () => boolean;
  onFail: () => void;
  /** Called when the state changes: it started, was paused or resumed, or came to its end. */
  onChange?: (state: PlayState) => void;
  subscribe?: typeof onFrame;
}

/**
 * Plays an effect on one diagram, by hand: no framework state changes per frame. It plays one
 * cycle when the diagram is in view and then stops, leaving the picture at rest and the page
 * doing nothing; in a loop it keeps going, but only while the diagram is in view.
 */
export class Player {
  private effect: EffectId | "none" = "none";
  private loop = false;
  private still = false;
  private visible = false;
  private seconds = 0;
  private previous = 0;
  private lastDrawn = -Infinity;
  private stop: (() => void) | null = null;
  private disposed = false;
  private paused = false;
  private told: PlayState = "rest";

  constructor(private readonly options: PlayerOptions) {}

  /** What to play. A change starts the effect over. */
  configure(effect: EffectId | "none", loop: boolean, still: boolean) {
    if (effect === this.effect && loop === this.loop && still === this.still) {
      return;
    }
    this.effect = effect;
    this.loop = loop;
    this.still = still;
    this.halt();
    this.seconds = 0;
    // Choosing an animation starts it, even if the last one was held.
    this.paused = false;
    this.begin();
  }

  setVisible(visible: boolean) {
    if (visible === this.visible) {
      return;
    }
    this.visible = visible;
    if (visible) {
      this.begin();
    } else {
      this.halt();
    }
  }

  /** Plays the effect again from the start. */
  replay() {
    if (!this.animated) {
      return;
    }
    this.halt();
    this.seconds = 0;
    this.paused = false;
    played.delete(this.playedKey);
    this.begin();
  }

  /** Holds the animation where it is. It costs nothing while held. */
  pause() {
    if (!this.animated || this.paused || !this.stop) {
      return;
    }
    this.paused = true;
    this.halt();
    this.tell();
  }

  /** Lets a held animation go on from where it was. */
  resume() {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.begin();
  }

  /** What a click does: hold it if it moves, let it go if it is held, play it again if it is over. */
  toggle() {
    if (this.paused) {
      this.resume();
    } else if (this.stop) {
      this.pause();
    } else {
      this.replay();
    }
  }

  get state(): PlayState {
    return this.paused ? "paused" : this.stop ? "playing" : "rest";
  }

  /** Draws what is there now: the diagram at rest, or the moment the effect has reached. */
  repaint() {
    if (this.stop || this.paused) {
      this.render();
    } else {
      renderRest(this.options.scene, this.options.frame);
      this.put();
    }
  }

  dispose() {
    this.disposed = true;
    this.halt();
  }

  get running(): boolean {
    return this.stop !== null;
  }

  private get animated(): boolean {
    return !this.still && this.effect !== "none" && EFFECTS.includes(this.effect);
  }

  private get playedKey(): string {
    return `${this.options.key}\0${this.effect}`;
  }

  private begin() {
    if (this.disposed || this.stop) {
      return;
    }
    const again = this.loop || !hasPlayed(this.playedKey);
    if (this.animated && this.visible && again && !this.paused) {
      this.previous = 0;
      this.lastDrawn = -Infinity;
      this.stop = (this.options.subscribe ?? onFrame)((now) => this.tick(now));
    } else {
      this.repaint();
    }
    this.tell();
  }

  private tell() {
    const now = this.state;
    if (now !== this.told) {
      this.told = now;
      this.options.onChange?.(now);
    }
  }

  private halt() {
    this.stop?.();
    this.stop = null;
  }

  private tick(now: number) {
    const effect = this.effect as EffectId;
    const step = this.previous === 0 ? 0 : Math.min(MAX_STEP_S, (now - this.previous) / 1000);
    this.previous = now;
    this.seconds += step;
    if (!this.loop && this.seconds >= effectDuration(effect, this.options.scene)) {
      // Done: the diagram stays as it is until it is asked to play again.
      this.halt();
      remember(this.playedKey);
      renderRest(this.options.scene, this.options.frame);
      this.put();
      this.tell();
      return;
    }
    if (now - this.lastDrawn >= FRAME_MS) {
      this.lastDrawn = now;
      this.render();
    }
  }

  private render() {
    const effect = this.effect as EffectId;
    const length = effectDuration(effect, this.options.scene);
    const t = this.loop ? this.seconds % length : this.seconds;
    renderEffect(effect, this.options.scene, t, this.options.frame, this.loop ? Math.floor(this.seconds / length) : 0);
    this.put();
  }

  private put() {
    if (!this.options.draw()) {
      this.halt();
      this.options.onFail();
    }
  }
}
