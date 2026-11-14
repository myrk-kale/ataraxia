/**
 * The characters a diagram can hold, numbered. Cells hold these numbers, not strings, so a
 * frame is two flat arrays that are filled again each time instead of an object per cell.
 * The numbers are shared by every diagram and by the glyph atlas on the graphics card, which
 * draws a character the first time it is asked for. Zero is the empty cell and one is `?`.
 */
const ids = new Map<string, number>([
  [" ", 0],
  // Reserved, so there is always something to answer with when the registry is full.
  ["?", 1],
]);
const chars: string[] = [" ", "?"];

/** More than any diagram needs; past this everything new is drawn as `?`. */
export const MAX_GLYPHS = 4000;

export function glyph(char: string): number {
  const known = ids.get(char);
  if (known !== undefined) {
    return known;
  }
  if (chars.length >= MAX_GLYPHS) {
    return 1;
  }
  const id = chars.length;
  ids.set(char, id);
  chars.push(char);
  return id;
}

export const charOf = (id: number): string => chars[id] ?? "?";

export const glyphCount = (): number => chars.length;
