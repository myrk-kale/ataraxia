/** The companion's species. Each is drawn in code (Sprite.tsx), so a colour and an accessory can go on any. */
export const SPECIES = [
  { id: "blob", label: "Drop" },
  { id: "cat", label: "Cat" },
  { id: "bunny", label: "Bunny" },
  { id: "robot", label: "Robot" },
  { id: "ghost", label: "Ghost" },
] as const;
export type SpeciesId = (typeof SPECIES)[number]["id"];

export const ACCESSORIES = [
  { id: "none", label: "None" },
  { id: "cap", label: "Cap" },
  { id: "glasses", label: "Glasses" },
  { id: "bow", label: "Bow" },
  { id: "crown", label: "Crown" },
] as const;
export type AccessoryId = (typeof ACCESSORIES)[number]["id"];

export const COLORS = ["#8b7cc8", "#5b8def", "#3fa58a", "#e2a03f", "#e0695f", "#d974a6", "#7a8794", "#f2efe9"] as const;

/** `pet` is the companion, `mini` only its status, `off` nothing. */
export type PetMode = "pet" | "mini" | "off";

/** Where it stands: 0 to 1 across the room the window leaves it (0,0 the top left, 1,1 the bottom right). */
export type PetPosition = { x: number; y: number };

export type PetConfig = {
  mode: PetMode;
  species: SpeciesId;
  name: string;
  color: string;
  accessory: AccessoryId;
  /** 0.6 to 2: how large it is drawn, as a share of its normal size. */
  scale: number;
  /** `null`: in its corner, where it starts. */
  position: PetPosition | null;
  /** A picture of the person's own, as a data URL, drawn instead of a species. */
  image: string | null;
};

export const DEFAULT_PET: PetConfig = {
  mode: "pet",
  species: "blob",
  name: "Ata",
  color: COLORS[0],
  accessory: "none",
  scale: 1,
  position: null,
  image: null,
};

export const SCALE = { min: 0.6, max: 2, step: 0.1 } as const;
export const BASE_SIZE = 88;
export const MAX_IMAGE_CHARS = 450_000;
export const NAME_MAX = 24;
export const STORAGE_KEY = "ataraxia.pet";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** What was stored, made into something safe to use: anything unreadable falls back to the default. */
export function sanitize(raw: unknown): PetConfig {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pick = <T extends string>(value: unknown, allowed: readonly { id: T }[], fallback: T): T =>
    allowed.some((item) => item.id === value) ? (value as T) : fallback;
  const position = source.position as Partial<PetPosition> | null | undefined;
  const name = typeof source.name === "string" ? source.name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
  const image = typeof source.image === "string" && /^data:image\/(png|webp|gif|jpeg);base64,[A-Za-z0-9+/=]+$/.test(source.image) && source.image.length <= MAX_IMAGE_CHARS ? source.image : null;
  return {
    mode: source.mode === "mini" || source.mode === "off" ? source.mode : "pet",
    species: pick(source.species, SPECIES, DEFAULT_PET.species),
    name: name || DEFAULT_PET.name,
    color: typeof source.color === "string" && /^#[0-9a-fA-F]{6}$/.test(source.color) ? source.color.toLowerCase() : DEFAULT_PET.color,
    accessory: pick(source.accessory, ACCESSORIES, DEFAULT_PET.accessory),
    scale: typeof source.scale === "number" && Number.isFinite(source.scale) ? Math.round(clamp(source.scale, SCALE.min, SCALE.max) * 10) / 10 : 1,
    position:
      position && typeof position.x === "number" && typeof position.y === "number" && Number.isFinite(position.x) && Number.isFinite(position.y)
        ? { x: clamp(position.x, 0, 1), y: clamp(position.y, 0, 1) }
        : null,
    image,
  };
}

export function loadPet(storage: Pick<Storage, "getItem"> | null = safeStorage()): PetConfig {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    return sanitize(text ? JSON.parse(text) : null);
  } catch {
    return { ...DEFAULT_PET };
  }
}

export function savePet(config: PetConfig, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Storage full or blocked: the pet keeps working, it only forgets after a restart.
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** How many pixels wide it is drawn. */
export const sizeOf = (config: Pick<PetConfig, "scale">) => Math.round(BASE_SIZE * config.scale);

export type View = { width: number; height: number };
export const MARGIN = 16;

/** Where its top left corner is, for a position, a window and a size. */
export function placement(position: PetPosition | null, view: View, size: number): { left: number; top: number } {
  const room = { x: Math.max(0, view.width - size - 2 * MARGIN), y: Math.max(0, view.height - size - 2 * MARGIN) };
  const at = position ?? { x: 1, y: 1 };
  return { left: MARGIN + at.x * room.x, top: MARGIN + at.y * room.y };
}

/** The position for a top left corner the pointer has put it at, kept inside the window. */
export function positionAt(left: number, top: number, view: View, size: number): PetPosition {
  const room = { x: view.width - size - 2 * MARGIN, y: view.height - size - 2 * MARGIN };
  return {
    x: room.x <= 0 ? 0 : clamp((left - MARGIN) / room.x, 0, 1),
    y: room.y <= 0 ? 0 : clamp((top - MARGIN) / room.y, 0, 1),
  };
}

/** Moves it by a number of pixels, as the arrow keys do. */
export function nudge(position: PetPosition | null, dx: number, dy: number, view: View, size: number): PetPosition {
  const now = placement(position, view, size);
  return positionAt(now.left + dx, now.top + dy, view, size);
}
