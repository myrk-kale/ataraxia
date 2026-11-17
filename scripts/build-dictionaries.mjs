// Builds src-tauri/dictionaries/<code>.txt: the most frequent words of each language, one
// "word<TAB>count" per line. The counts come from FrequencyWords (hermitdave/FrequencyWords,
// OpenSubtitles 2018, content under CC BY-SA 4.0; see src-tauri/dictionaries/NOTICE.md).
//
//   node scripts/build-dictionaries.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LANGUAGES = { en: "en", "pt-BR": "pt_br", "pt-PT": "pt", es: "es", fr: "fr", de: "de", it: "it" };
const KEEP = 20000;
const BASE = "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018";
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "dictionaries");

await mkdir(out, { recursive: true });
for (const [code, source] of Object.entries(LANGUAGES)) {
  const response = await fetch(`${BASE}/${source}/${source}_50k.txt`);
  if (!response.ok) throw new Error(`${code}: ${response.status}`);
  const seen = new Set();
  const lines = [];
  for (const line of (await response.text()).split("\n")) {
    const [raw, count] = line.trim().split(/\s+/);
    const word = raw?.toLocaleLowerCase();
    // Whole words only: no digits, apostrophes or hyphens, and no stray single letters.
    if (!word || !count || !/^\p{L}{2,30}$/u.test(word) || seen.has(word)) continue;
    seen.add(word);
    lines.push(`${word}\t${count}`);
    if (lines.length === KEEP) break;
  }
  await writeFile(join(out, `${code}.txt`), `${lines.join("\n")}\n`);
  console.log(code, lines.length);
}
