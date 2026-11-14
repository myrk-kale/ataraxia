/** Colour tokens a diagram takes from the app, so it follows the theme the reader chose. */
const TOKENS = {
  panel: ["--cg-panel", "#ffffff"],
  tint: ["--cg-tint", "#f4f4f1"],
  ink: ["--cg-ink", "#232522"],
  muted: ["--cg-muted-strong", "#50534e"],
  line: ["--cg-line-strong", "#dbdad5"],
  accentBg: ["--cg-accent-bg", "#f0edf8"],
} as const;

type Token = keyof typeof TOKENS;

/** A colour the diagram library can compute with; other notations fall back to the default. */
function usable(value: string): boolean {
  return /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(value);
}

export function luminance(color: string): number {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(color)?.[1];
  let channels: number[] | null = null;
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    channels = [0, 2, 4].map((start) => parseInt(full.slice(start, start + 2), 16));
  } else {
    const parts = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(color);
    if (parts) {
      channels = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    }
  }
  if (!channels) {
    return 1;
  }
  const [r = 0, g = 0, b = 0] = channels.map((value) => value / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Theme variables for the diagram library, read through `read` (a CSS custom property reader). */
export function mermaidTheme(read: (name: string) => string, fontFamily: string) {
  const pick = (token: Token) => {
    const [name, fallback] = TOKENS[token];
    const value = read(name).trim();
    return usable(value) ? value : fallback;
  };
  const panel = pick("panel");
  return {
    dark: luminance(panel) < 0.5,
    variables: {
      fontFamily,
      background: panel,
      mainBkg: pick("tint"),
      primaryColor: pick("tint"),
      secondaryColor: pick("tint"),
      tertiaryColor: panel,
      primaryTextColor: pick("ink"),
      secondaryTextColor: pick("ink"),
      tertiaryTextColor: pick("ink"),
      textColor: pick("ink"),
      primaryBorderColor: pick("line"),
      nodeBorder: pick("line"),
      clusterBkg: panel,
      clusterBorder: pick("line"),
      lineColor: pick("muted"),
      edgeLabelBackground: panel,
      noteBkgColor: pick("accentBg"),
      noteTextColor: pick("ink"),
      noteBorderColor: pick("line"),
    },
  };
}
