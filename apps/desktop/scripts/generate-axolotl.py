#!/usr/bin/env python3
"""Draws the Concierge axolotl and converts it to braille art for the empty chat.

The picture is painted at high resolution (shapes with shading, gill filaments, fingers, skin
speckles, glossy eyes and a neutral mouth), squeezed onto the braille dot grid and dithered with
a per-pixel threshold. Because that dithering looks at one pixel at a time, the open-eyes and
closed-eyes frames differ only around the eyes, so blinking does not make the rest flicker.

Usage: python3 scripts/generate-axolotl.py [--preview DIR]
Writes src/chat/axolotlArt.ts.
"""
import argparse
import math
import os
import random

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

# Design canvas in square units; the dot grid is 160 x 192 (80 x 48 braille cells), which has the
# same physical aspect as the design because a braille dot is wider than it is tall.
DESIGN = 400
SS = 3  # supersampling of the design canvas
DOTS_W, DOTS_H = 160, 192

CX = 200


def lerp(a, b, t):
    return a + (b - a) * t


def bezier(points, steps=60):
    """Points of a cubic Bezier given its four control points."""
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = points
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        out.append((
            u**3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t**3 * x3,
            u**3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t**3 * y3,
        ))
    return out


def smooth_path(points, per_segment=24):
    """Catmull-Rom through the points, so a body line can be given as a few waypoints."""
    pts = [points[0]] + list(points) + [points[-1]]
    out = []
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        for k in range(per_segment):
            t = k / per_segment
            t2, t3 = t * t, t * t * t
            out.append((
                0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
                0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
            ))
    out.append(points[-1])
    return out


def normals(path):
    out = []
    for i in range(len(path)):
        a = path[max(0, i - 1)]
        b = path[min(len(path) - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy) or 1
        out.append((-dy / n, dx / n))
    return out


def ribbon(path, width_at):
    """Polygon around a path whose half-width is width_at(t), t in 0..1 along it."""
    ns = normals(path)
    left, right = [], []
    for i, ((x, y), (nx, ny)) in enumerate(zip(path, ns)):
        w = width_at(i / (len(path) - 1))
        left.append((x + nx * w, y + ny * w))
        right.append((x - nx * w, y - ny * w))
    return left + right[::-1]


class Canvas:
    """A float luminance image painted with antialiased masks."""

    def __init__(self):
        size = DESIGN * SS
        self.size = size
        self.lum = np.zeros((size, size), dtype=np.float32)

    def mask(self, draw_fn, blur=0.0):
        img = Image.new("L", (self.size, self.size), 0)
        draw_fn(ImageDraw.Draw(img), lambda v: int(round(v * SS)))
        if blur:
            img = img.filter(ImageFilter.GaussianBlur(blur * SS))
        return np.asarray(img, dtype=np.float32) / 255.0

    def paint(self, mask, value):
        """Lays `value` (a number or an array) over the picture where the mask is set."""
        self.lum = self.lum * (1 - mask) + value * mask


def poly_mask(canvas, polygon):
    return canvas.mask(lambda d, s: d.polygon([(s(x), s(y)) for x, y in polygon], fill=255))


def densify(path, step=1.6):
    """Adds points so that no two neighbours are farther apart than `step` design units."""
    out = [path[0]]
    for (x0, y0), (x1, y1) in zip(path, path[1:]):
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
        for k in range(1, n + 1):
            out.append((lerp(x0, x1, k / n), lerp(y0, y1, k / n)))
    return out


def stroke_mask(canvas, path, width, width_end=None):
    """A stroke of (optionally tapering) width drawn as overlapping discs along the path."""
    end = width if width_end is None else width_end
    path = densify(path)

    def draw(d, s):
        n = len(path)
        for i, (x, y) in enumerate(path):
            w = lerp(width, end, i / max(1, n - 1)) / 2
            d.ellipse([s(x - w), s(y - w), s(x + w), s(y + w)], fill=255)

    return canvas.mask(draw)


def ellipse_mask(canvas, cx, cy, rx, ry):
    return canvas.mask(lambda d, s: d.ellipse([s(cx - rx), s(cy - ry), s(cx + rx), s(cy + ry)], fill=255))


def superellipse(cx, cy, a, b, n=2.6, steps=180):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        pts.append((cx + a * math.copysign(abs(c) ** (2 / n), c), cy + b * math.copysign(abs(s) ** (2 / n), s)))
    return pts


def grid(canvas):
    ys, xs = np.mgrid[0:canvas.size, 0:canvas.size].astype(np.float32)
    return xs / SS, ys / SS  # design units


def erode(mask, radius):
    img = Image.fromarray((mask * 255).astype(np.uint8))
    img = img.filter(ImageFilter.MinFilter(max(3, int(radius * SS) | 1)))
    return np.asarray(img, dtype=np.float32) / 255.0


def dilate(mask, radius):
    img = Image.fromarray((mask * 255).astype(np.uint8))
    img = img.filter(ImageFilter.MaxFilter(max(3, int(radius * SS) | 1)))
    return np.asarray(img, dtype=np.float32) / 255.0


def blur(mask, radius):
    img = Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(radius * SS)), dtype=np.float32) / 255.0


def smoothstep(x, lo, hi):
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def inflate(mask, radius=13):
    """0 at the edge of a shape and 1 deep inside: a cheap way to shade it like a rounded volume."""
    return smoothstep(blur(mask, radius), 0.12, 0.62)


def mottling(c, seed, scale=20, strength=1.0):
    """Soft organic blotches (low-frequency noise), used for the skin markings."""
    rs = np.random.RandomState(seed)
    small = rs.rand(DESIGN // scale + 2, DESIGN // scale + 2).astype(np.float32)
    img = Image.fromarray((small * 255).astype(np.uint8)).resize((c.size, c.size), Image.BICUBIC)
    field = np.asarray(img, dtype=np.float32) / 255.0
    return smoothstep(field, 0.52, 0.70) * strength


def paint_gills(c, rng, scale_by_side):
    specs = [
        [(146, 86), (112, 62), (88, 40), (50, 22)],
        [(134, 112), (100, 106), (74, 104), (30, 92)],
        [(142, 136), (110, 148), (84, 160), (46, 170)],
    ]
    for side in (-1, 1):
        k = scale_by_side[side]
        for spec in specs:
            pts = [(CX + side * (CX - x) * k, 110 + (y - 110) * k) for x, y in spec]
            stalk = bezier(pts, 90)
            ns = normals(stalk)
            c.paint(stroke_mask(c, stalk, 12, 3.4), 0.5)
            # feathery filaments, spaced out so each one stays visible after dithering
            seg = 0.0
            for i in range(8, len(stalk) - 1):
                x0, y0 = stalk[i - 1]
                x, y = stalk[i]
                seg += math.hypot(x - x0, y - y0)
                if seg < 8.5:
                    continue
                seg = 0.0
                t = i / (len(stalk) - 1)
                tx, ty = -ns[i][1], ns[i][0]
                length = lerp(40, 11, t) * rng.uniform(0.9, 1.1)
                for sign in (-1, 1):
                    ang = math.atan2(ty, tx) + sign * lerp(0.95, 0.62, t)
                    ex, ey = x + math.cos(ang) * length, y + math.sin(ang) * length
                    mx = lerp(x, ex, 0.55) - ns[i][0] * sign * 4
                    my = lerp(y, ey, 0.55) - ns[i][1] * sign * 4
                    fil = bezier([(x, y), (mx, my), (mx, my), (ex, ey)], 14)
                    c.paint(stroke_mask(c, fil, 4.6, 1.8), 0.82)


def paint_axolotl(eyes_open, seed=7):
    rng = random.Random(seed)
    c = Canvas()
    xs, ys = grid(c)
    gap = lambda m, r=5: c.paint(dilate(m, r), 0.0)  # a dark halo that separates a shape from what is behind

    paint_gills(c, rng, {-1: 1.0, 1: 0.96})

    # ---- tail and body: a spine with a width profile
    spine = smooth_path([(200, 140), (200, 196), (197, 252), (203, 302), (224, 340), (262, 360), (310, 364), (348, 350), (374, 324)])
    n = len(spine)

    def half_width(t):
        if t < 0.12:
            return lerp(36, 46, t / 0.12)
        if t < 0.45:
            return lerp(46, 41, (t - 0.12) / 0.33)
        if t < 0.6:
            return lerp(41, 30, (t - 0.45) / 0.15)
        return max(2.5, lerp(30, 2.5, ((t - 0.6) / 0.4) ** 0.8))

    body = poly_mask(c, ribbon(spine, half_width))
    gap(body)
    inflated = inflate(body)
    body_val = 0.26 + 0.52 * inflated + 0.14 * (1 - (xs + ys * 0.4) / 560.0)
    c.paint(body, np.clip(body_val, 0, 1))
    # the tail fin: a lighter margin along its edge and a centre ridge
    tail = spine[int(n * 0.6):]
    fin = stroke_mask(c, tail, 5, 1.5)
    c.paint(fin * body, 0.9)
    c.paint(np.clip(body - erode(body, 2.6), 0, 1), 0.93)  # rim light

    # ---- legs: thick near the body, a broad paw with four or five clear fingers
    def leg(joints, widths, fingers, finger_len, spread, base_angle):
        path = smooth_path(joints, 20)
        limb = stroke_mask(c, path, widths[0], widths[1])
        hx, hy = path[-1]
        digits = []
        for k in range(fingers):
            a = base_angle + (k - (fingers - 1) / 2) * spread
            f1 = (hx + math.cos(a) * finger_len * 0.5, hy + math.sin(a) * finger_len * 0.5)
            f2 = (hx + math.cos(a + 0.1) * finger_len, hy + math.sin(a + 0.1) * finger_len)
            digits.append(stroke_mask(c, [(hx, hy), f1, f2], 10.5, 6.2))
        paw = ellipse_mask(c, hx, hy, widths[1] * 0.8, widths[1] * 0.8)
        shape = np.maximum.reduce([limb, paw] + digits)
        gap(shape, 4)
        c.paint(shape, np.clip(0.30 + 0.5 * inflate(np.maximum(limb, paw), 7), 0, 1))
        for digit in digits:
            c.paint(digit, 0.88)
            c.paint(np.clip(digit - erode(digit, 1.6), 0, 1), 1.0)
        c.paint(np.clip(np.maximum(limb, paw) - erode(np.maximum(limb, paw), 2.4), 0, 1), 0.92)

    leg([(168, 182), (134, 202), (112, 226), (100, 258)], (28, 17), 4, 30, 0.40, math.radians(112))
    leg([(232, 184), (268, 198), (290, 222), (300, 252)], (28, 17), 4, 30, 0.40, math.radians(68))
    leg([(170, 288), (134, 310), (116, 334), (110, 366)], (30, 18), 5, 32, 0.36, math.radians(98))
    leg([(228, 294), (262, 302), (284, 320), (296, 344)], (30, 18), 5, 32, 0.36, math.radians(80))

    # ---- head: broad and flat, with a halo that cuts it free of the gills and body
    head = poly_mask(c, superellipse(CX, 110, 76, 50, 2.7))
    gap(head, 6)
    head_val = 0.30 + 0.56 * inflate(head, 16) + 0.14 * (1 - (xs - 120 + (ys - 60) * 0.5) / 280.0)
    c.paint(head, np.clip(head_val, 0, 1))
    c.paint(np.clip(head - erode(head, 3.2), 0, 1), 0.95)

    # ---- skin markings: organic blotches plus a few bright speckles, kept off the face
    region = np.maximum(body, head)
    face_clear = 1 - np.clip(blur(ellipse_mask(c, CX, 110, 68, 42), 6), 0, 1)
    blotch = mottling(c, seed, 28, 0.42) * region * face_clear
    c.lum = c.lum * (1 - blotch * 0.55)
    for _ in range(150):
        x, y = rng.uniform(130, 290), rng.uniform(170, 355)
        r = rng.uniform(1.3, 2.4)
        spot = ellipse_mask(c, x, y, r, r) * body
        c.lum = np.clip(c.lum + spot * 0.28, 0, 1)

    # ---- face: nostrils, a calm straight mouth and eyes
    for side in (-1, 1):
        c.paint(ellipse_mask(c, CX + side * 11, 72, 3.0, 2.4), 0.04)
    mouth = [(CX - 40 + 80 * i / 40, 132 + 0.9 * ((abs(i - 20) / 20) ** 2)) for i in range(41)]
    c.paint(stroke_mask(c, [(x, y + 4.4) for x, y in mouth], 2.2, 2.2), 0.86)  # lower lip catches light
    c.paint(stroke_mask(c, mouth, 4.2, 4.2), 0.03)

    for side in (-1, 1):
        ex, ey = CX + side * 42, 98
        if eyes_open:
            c.paint(ellipse_mask(c, ex, ey, 15.5, 15.5), 0.98)   # bright ring
            c.paint(ellipse_mask(c, ex, ey, 11.8, 11.8), 0.03)   # dark eye
            c.paint(ellipse_mask(c, ex - 3.8, ey - 4.2, 3.9, 3.9), 1.0)   # glint
            c.paint(ellipse_mask(c, ex + 4.2, ey + 4.6, 1.9, 1.9), 0.9)   # small glint
        else:
            lid = [(ex - 12 + 24 * i / 20, ey + 1 + 3.0 * (1 - ((i - 10) / 10) ** 2)) for i in range(21)]
            c.paint(stroke_mask(c, lid, 4.0, 4.0), 0.03)
            c.paint(stroke_mask(c, [(x, y + 4.2) for x, y in lid], 2.6, 2.6), 0.88)
    return c


def to_dots(canvas):
    """Squeezes the design onto the dot grid and applies a per-pixel (order independent) dither."""
    img = Image.fromarray(np.clip(canvas.lum * 255, 0, 255).astype(np.uint8))
    img = img.resize((DOTS_W, DOTS_H), Image.LANCZOS)
    lum = np.asarray(img, dtype=np.float32) / 255.0
    # a little contrast and an unsharp lift keep fine lines visible after dithering
    lum = np.clip((lum - 0.5) * 1.18 + 0.5 + 0.02, 0, 1)
    ys, xs = np.mgrid[0:DOTS_H, 0:DOTS_W].astype(np.float64)
    # interleaved gradient noise: a cheap blue-noise-like threshold that depends on x and y only
    threshold = (52.9829189 * ((0.06711056 * xs + 0.00583715 * ys) % 1.0)) % 1.0
    return (lum > threshold * 0.96 + 0.02).astype(np.uint8), lum


BITS = {(0, 0): 0x01, (0, 1): 0x02, (0, 2): 0x04, (1, 0): 0x08, (1, 1): 0x10, (1, 2): 0x20, (0, 3): 0x40, (1, 3): 0x80}


def braille_rows(dots):
    rows = []
    for cy in range(0, dots.shape[0], 4):
        row = []
        for cx in range(0, dots.shape[1], 2):
            bits = 0
            for (dx, dy), bit in BITS.items():
                if dots[cy + dy, cx + dx]:
                    bits |= bit
            row.append(chr(0x2800 + bits))
        rows.append("".join(row))
    return rows


def preview(dots, lum, path, scale=5):
    h, w = dots.shape
    img = Image.new("L", (w * scale, h * scale), 18)
    d = ImageDraw.Draw(img)
    for y in range(h):
        for x in range(w):
            if dots[y, x]:
                cx, cy = x * scale + scale // 2, y * scale + scale // 2
                d.ellipse([cx - 1.6, cy - 1.6, cx + 1.6, cy + 1.6], fill=235)
    img.save(path)
    Image.fromarray(np.clip(lum * 255, 0, 255).astype(np.uint8)).resize((w * 3, h * 3)).save(path.replace(".png", "-lum.png"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", help="directory for preview PNGs")
    args = parser.parse_args()

    open_dots, open_lum = to_dots(paint_axolotl(True))
    closed_dots, closed_lum = to_dots(paint_axolotl(False))
    if args.preview:
        os.makedirs(args.preview, exist_ok=True)
        preview(open_dots, open_lum, os.path.join(args.preview, "open.png"))
        preview(closed_dots, closed_lum, os.path.join(args.preview, "closed.png"))

    open_rows = braille_rows(open_dots)
    closed_rows = braille_rows(closed_dots)
    # drop blank margins common to both frames so the art is as small as it can be
    blank = "\u2800"
    used_rows = [i for i in range(len(open_rows)) if any(ch != blank for ch in open_rows[i] + closed_rows[i])]
    used_cols = [j for j in range(len(open_rows[0])) if any(open_rows[i][j] != blank or closed_rows[i][j] != blank for i in range(len(open_rows)))]
    r0, r1, c0, c1 = used_rows[0], used_rows[-1], used_cols[0], used_cols[-1]
    trim = lambda rows: [row[c0 : c1 + 1] for row in rows[r0 : r1 + 1]]
    open_rows, closed_rows = trim(open_rows), trim(closed_rows)

    import json

    def block(rows):
        return ",\n".join("  " + json.dumps(r, ensure_ascii=False) for r in rows)

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "chat", "axolotlArt.ts")
    with open(out, "w", encoding="utf-8") as f:
        f.write(
            "/**\n * The axolotl mascot as braille art, one string per row, in two frames: eyes open and eyes\n"
            " * shut. Generated by scripts/generate-axolotl.py; do not edit by hand. Purely decorative.\n */\n"
            f"export const AXOLOTL_ROWS: readonly string[] = [\n{block(open_rows)},\n];\n\n"
            f"export const AXOLOTL_CLOSED_ROWS: readonly string[] = [\n{block(closed_rows)},\n];\n\n"
            'export const AXOLOTL_ART = AXOLOTL_ROWS.join("\\n");\n'
            'export const AXOLOTL_CLOSED_ART = AXOLOTL_CLOSED_ROWS.join("\\n");\n'
        )
    print(f"{len(open_rows)} rows x {len(open_rows[0])} cols -> {os.path.relpath(out)}")


if __name__ == "__main__":
    main()
