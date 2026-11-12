/** Types for the vendored ascii-magic runtime (the library itself is plain JavaScript). */
export interface PieceMeta {
  slug: string;
  name: string;
  cols: number;
  rows: number;
  fps: number;
  cell?: string;
  still?: boolean;
}

export interface PieceModule {
  meta: PieceMeta;
  default: () => (t: number) => unknown;
}

export interface LookOptions {
  look?: string;
  chars?: string;
  all?: boolean;
  mono?: boolean;
  gamma?: number;
  size?: number;
  density?: number;
  steps?: number;
}

export interface PlayOptions {
  speed?: number;
  /** True draws one frame and stops; left out, it follows the reduced-motion setting. */
  still?: boolean;
  look?: LookOptions;
  t0?: number;
  maxFps?: number;
  dom?: boolean;
}

/** Draws the piece into a <pre> (as a canvas next to it) and returns a function that stops it. */
export function play(pre: HTMLPreElement, mod: PieceModule, opts?: PlayOptions): () => void;
