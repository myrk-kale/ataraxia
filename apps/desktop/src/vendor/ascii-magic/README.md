# ascii-magic (vendored)

Animated ASCII art from [ascii-magic.com](https://www.ascii-magic.com), copied here so the app
never loads code from the network at runtime.

- Source: `ascii-magic-art@1.1.0` on npm (MIT, see `LICENSE`); the files here are byte-for-byte the
  ones served at `https://www.ascii-magic.com/ascii/` on 2026-11-12.
- Files: `player.js`, `glyphs.js`, `canvas.js`, `lib/kit.js`, and four pieces under `pieces/` (the
  opening picks one by the time of day, see `src/intro/scenes.ts`): `summit-cloud-sea` (morning),
  `tropical-island` (afternoon), `savanna-sunset` (evening) and `moonlit-sea` (night). The
  `<ascii-art>` element (`ascii.js`) is not used; `src/intro/AsciiBackground.tsx` calls `play()` directly.
- The `.d.ts` files are ours (the library has no types). Do not edit the `.js` files; to add a
  piece, copy it from the npm package (`pieces/<slug>.js`) and add a `.d.ts` for it.
- Read before vendoring: no network, `eval`, storage or Tauri calls; it only computes frames and
  paints them on a canvas.

## License check (2026-11-12)

- `LICENSE` here is byte-identical to the one in `ascii-magic-art@1.1.0` (MIT, "Copyright (c) 2026
  ASCII Magic"), and `package.json` declares `MIT`. The notice stays with the copied files, as MIT requires.
- The package's `NOTICE` carves out exactly two pieces, `ocean-sunset` and `starry-ridge`, whose
  image data stays under the Unsplash License. Neither is used here. `summit-cloud-sea` is
  procedural (no embedded image data, checked) and falls under the MIT terms.
- The three pieces added on 2026-11-14 (`tropical-island`, `savanna-sunset`, `moonlit-sea`) were read
  for the same things (no network, `eval`, storage, DOM or Tauri use; they only import
  `lib/kit.js`), contain no image data, and are byte-identical to the ones in `ascii-magic-art@1.1.0`.
  None is `ocean-sunset` or `starry-ridge`. Do not add the pieces tagged `photo` (`ocean-sunset`,
  `starry-ridge`, `temple-sunset`): they are halftones of photographs.
- If you add a piece, read `NOTICE` again first: photo-based pieces are not MIT.
