/** Which typefaces this machine really has, so the picker only offers ones that will show. */

const CANDIDATES: Record<"sans" | "mono", string[]> = {
  sans: [
    "Inter",
    "SF Pro Text",
    "Helvetica Neue",
    "Helvetica",
    "Arial",
    "Segoe UI",
    "Roboto",
    "IBM Plex Sans",
    "Source Sans 3",
    "Open Sans",
    "Lato",
    "Noto Sans",
    "Avenir Next",
    "Verdana",
    "Ubuntu",
    "Charter",
    "Georgia",
  ],
  mono: [
    "JetBrains Mono",
    "Fira Code",
    "Fira Mono",
    "Cascadia Code",
    "Cascadia Mono",
    "SF Mono",
    "Menlo",
    "Monaco",
    "Consolas",
    "IBM Plex Mono",
    "Source Code Pro",
    "Hack",
    "Inconsolata",
    "Iosevka",
    "Victor Mono",
    "Roboto Mono",
    "Ubuntu Mono",
    "DejaVu Sans Mono",
    "Andale Mono",
    "Courier New",
    "MesloLGS NF",
    "JetBrainsMono Nerd Font",
    "FiraCode Nerd Font",
  ],
};

const SAMPLE = "mmmmmmmmmmlli1WwQ@#0Oo";
const BASES = ["monospace", "serif", "sans-serif"];

/**
 * A face that is not installed is drawn in the fallback, so its text is exactly as wide as the
 * fallback's. A different width against any of the three fallbacks means the face exists.
 */
export function isInstalled(name: string): boolean {
  try {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) {
      return false;
    }
    return BASES.some((base) => {
      context.font = `64px ${base}`;
      const plain = context.measureText(SAMPLE).width;
      context.font = `64px "${name}", ${base}`;
      return context.measureText(SAMPLE).width !== plain;
    });
  } catch {
    return false;
  }
}

const found = new Map<string, string[]>();

export function installedFonts(kind: "sans" | "mono"): string[] {
  let list = found.get(kind);
  if (!list) {
    list = CANDIDATES[kind].filter(isInstalled);
    found.set(kind, list);
  }
  return list;
}
