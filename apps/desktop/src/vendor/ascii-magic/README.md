# ascii-magic (vendored)

Animated ASCII art from [ascii-magic.com](https://www.ascii-magic.com), copied here so the app
never loads code from the network at runtime.

- Source: `ascii-magic-art@1.1.0` on npm (MIT, see `LICENSE`); the files here are byte-for-byte the
  ones served at `https://www.ascii-magic.com/ascii/` on 2026-11-12.
- Files: `player.js`, `glyphs.js`, `canvas.js`, `lib/kit.js`, `pieces/summit-cloud-sea.js`. The
  `<ascii-art>` element (`ascii.js`) is not used; `src/intro/AsciiBackground.tsx` calls `play()` directly.
- The `.d.ts` files are ours (the library has no types). Do not edit the `.js` files; to add a
  piece, copy it from the npm package (`pieces/<slug>.js`) and add a `.d.ts` for it.
- Read before vendoring: no network, `eval`, storage or Tauri calls; it only computes frames and
  paints them on a canvas.
