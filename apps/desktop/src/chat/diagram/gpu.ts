import { drawGlyph } from "./atlas";
import type { Frame } from "./effects";
import { CLASS_COUNT } from "./palette";
import { charOf, glyphCount } from "./registry";

/** The size of a cell in CSS pixels. Eight by sixteen is a 13px monospace font. */
export const CELL_W = 8;
export const CELL_H = 16;

const ATLAS_COLS = 64;
const FLOATS_PER_CELL = 6;

const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec2 aCell;
layout(location=2) in float aGlyph;
layout(location=3) in vec3 aColor;
uniform vec2 uViewport;
uniform vec2 uCell;
out vec2 vLocal;
flat out vec2 vOrigin;
out vec3 vColor;
void main() {
  vec2 pixel = (aCell + aCorner) * uCell;
  gl_Position = vec4(2.0 * pixel.x / uViewport.x - 1.0, 1.0 - 2.0 * pixel.y / uViewport.y, 0.0, 1.0);
  float g = aGlyph;
  float col = mod(g, ${ATLAS_COLS}.0);
  float row = floor(g / ${ATLAS_COLS}.0);
  vOrigin = vec2(col, row) * uCell;
  vLocal = aCorner * uCell;
  vColor = aColor;
}`;

// Each pixel of a cell reads exactly one texel of the atlas: no filtering, no blur.
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec2 vOrigin;
in vec3 vColor;
uniform vec2 uCell;
uniform highp sampler2D uGlyphs;
out vec4 outColor;
void main() {
  vec2 inside = min(floor(vLocal), uCell - 1.0);
  float coverage = texelFetch(uGlyphs, ivec2(vOrigin + inside), 0).a;
  outColor = vec4(vColor * coverage, coverage);
}`;

export interface Renderer {
  /** Draws a frame into `target`, a 2D canvas context sized `cols * cell` by `rows * cell` device pixels. */
  draw(
    target: CanvasRenderingContext2D,
    frame: Frame,
    cols: number,
    rows: number,
    dpr: number,
    palette: Float32Array,
    font: string,
    /** Changes when the font is not the one the letters were drawn in, say it just loaded. */
    salt: number,
  ): boolean;
  readonly lost: boolean;
  /** The largest width or height, in device pixels, it can draw. */
  readonly maxSize: number;
}

class GpuRenderer implements Renderer {
  lost = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly instances: WebGLBuffer;
  private readonly atlasTexture: WebGLTexture;
  private readonly locations: Record<"viewport" | "cell" | "glyphs", WebGLUniformLocation | null>;
  private readonly maxTexture: number;
  get maxSize(): number {
    return this.maxTexture;
  }
  private packed = new Float32Array(0);
  private atlas = document.createElement("canvas");
  private atlasContext: CanvasRenderingContext2D;
  private atlasKey = "";
  private atlasRows = 0;
  private drawn = 1;
  private dirty = false;

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
      }
      return shader;
    };
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(this.program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(this.program) ?? "program");
    }
    gl.useProgram(this.program);
    this.locations = {
      viewport: gl.getUniformLocation(this.program, "uViewport"),
      cell: gl.getUniformLocation(this.program, "uCell"),
      glyphs: gl.getUniformLocation(this.program, "uGlyphs"),
    };
    gl.bindVertexArray(gl.createVertexArray());
    const corner = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instances = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    const stride = FLOATS_PER_CELL * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(3, 1);
    this.atlasTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.uniform1i(this.locations.glyphs, 0);
    // The glyphs are coverage; the shader premultiplies, so the blend is the premultiplied one.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.SCISSOR_TEST);
    this.atlasContext = this.atlas.getContext("2d", { willReadFrequently: false })!;
  }

  /** Makes the atlas hold every registered character, drawing the ones it has not yet. */
  private syncAtlas(cw: number, ch: number, dpr: number, font: string, salt: number) {
    const key = `${cw}x${ch}|${font}|${salt}`;
    const wanted = Math.min(glyphCount(), Math.floor(this.maxTexture / ch) * ATLAS_COLS);
    const rowsNeeded = Math.max(1, Math.ceil(wanted / ATLAS_COLS));
    if (key !== this.atlasKey) {
      this.atlasKey = key;
      this.drawn = 1;
      this.atlasRows = 0;
    }
    if (rowsNeeded > this.atlasRows) {
      // Grow in steps, keeping what is drawn.
      const rows = Math.min(Math.floor(this.maxTexture / ch), Math.max(rowsNeeded, this.atlasRows * 2, 8));
      const previous = this.atlas;
      this.atlas = document.createElement("canvas");
      this.atlas.width = ATLAS_COLS * cw;
      this.atlas.height = rows * ch;
      this.atlasContext = this.atlas.getContext("2d")!;
      if (this.atlasRows > 0) {
        this.atlasContext.drawImage(previous, 0, 0);
      }
      this.atlasRows = rows;
      this.dirty = true;
    }
    for (; this.drawn < wanted; this.drawn += 1) {
      const col = this.drawn % ATLAS_COLS;
      const row = Math.floor(this.drawn / ATLAS_COLS);
      drawGlyph(this.atlasContext, charOf(this.drawn), { x: col * cw, y: row * ch, w: cw, h: ch, dpr, font });
      this.dirty = true;
    }
    if (this.dirty) {
      const { gl } = this;
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlas);
      this.dirty = false;
    }
    return wanted;
  }

  draw(
    target: CanvasRenderingContext2D,
    frame: Frame,
    cols: number,
    rows: number,
    dpr: number,
    palette: Float32Array,
    font: string,
    salt: number,
  ): boolean {
    if (this.lost) {
      return false;
    }
    const { gl, canvas } = this;
    const cw = Math.round(CELL_W * dpr);
    const ch = Math.round(CELL_H * dpr);
    const width = cols * cw;
    const height = rows * ch;
    if (width > this.maxTexture || height > this.maxTexture) {
      return false;
    }
    const capacity = this.syncAtlas(cw, ch, dpr, font, salt);
    // The drawing surface only ever grows, and in steps, so switching between diagrams of
    // different sizes does not reallocate it each time.
    if (canvas.width < width || canvas.height < height) {
      canvas.width = Math.min(this.maxTexture, Math.max(canvas.width, Math.ceil(width / 256) * 256));
      canvas.height = Math.min(this.maxTexture, Math.max(canvas.height, Math.ceil(height / 256) * 256));
    }
    const need = frame.size * FLOATS_PER_CELL;
    if (this.packed.length < need) {
      this.packed = new Float32Array(need);
    }
    const packed = this.packed;
    let count = 0;
    const { glyph, cls } = frame;
    for (let cell = 0; cell < frame.size; cell += 1) {
      const id = glyph[cell]!;
      if (id === 0) {
        continue;
      }
      const at = count * FLOATS_PER_CELL;
      const colour = Math.min(cls[cell]!, CLASS_COUNT - 1) * 3;
      packed[at] = cell % cols;
      packed[at + 1] = (cell / cols) | 0;
      packed[at + 2] = id < capacity ? id : 1;
      packed[at + 3] = palette[colour]!;
      packed[at + 4] = palette[colour + 1]!;
      packed[at + 5] = palette[colour + 2]!;
      count += 1;
    }
    gl.useProgram(this.program);
    gl.viewport(0, 0, width, height);
    gl.scissor(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (count > 0) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
      gl.uniform2f(this.locations.viewport, width, height);
      gl.uniform2f(this.locations.cell, cw, ch);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
      gl.bufferData(gl.ARRAY_BUFFER, packed.subarray(0, count * FLOATS_PER_CELL), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    }
    // The viewport is the bottom-left corner of the surface, and the copy happens in the same
    // task as the drawing, while the picture is still there to copy.
    target.clearRect(0, 0, width, height);
    target.drawImage(canvas, 0, canvas.height - height, width, height, 0, 0, width, height);
    return true;
  }
}

let shared: GpuRenderer | null = null;
let failed = false;

/**
 * The one renderer every diagram draws with, made the first time it is asked for. Browsers
 * allow only a few WebGL contexts at once, so diagrams share one and each keeps its own plain
 * canvas to show the result. Null where WebGL2 is not available.
 */
export function sharedRenderer(): Renderer | null {
  if (shared && !shared.lost) {
    return shared;
  }
  if (failed && !shared) {
    return null;
  }
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      // A diagram is no reason to wake the discrete GPU.
      powerPreference: "low-power",
    });
    if (!gl) {
      failed = true;
      return null;
    }
    const renderer = new GpuRenderer(canvas, gl);
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      renderer.lost = true;
    });
    shared = renderer;
    return renderer;
  } catch {
    failed = true;
    return null;
  }
}
