import { MAX_IMAGE_CHARS } from "./config";

/** The largest side a picture is kept at: it is drawn small, and it is stored in the window's storage. */
export const IMAGE_SIDE = 192;
export const ACCEPTED = ["image/png", "image/webp", "image/jpeg", "image/gif"];
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** The size a picture is brought down to, keeping its proportions; a smaller one is left as it is. */
export function fitSide(width: number, height: number, side = IMAGE_SIDE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= side || longest <= 0) {
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }
  const scale = side / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Why a file cannot be the pet, or `null` when it can. */
export function refuseFile(file: Pick<File, "type" | "size">): string | null {
  if (!ACCEPTED.includes(file.type)) return "Use a PNG, WebP, JPEG or GIF picture.";
  if (file.size > MAX_FILE_BYTES) return "That picture is larger than 4 MB.";
  return null;
}

/** Whether a data URL is small enough to keep. */
export const fitsStorage = (dataUrl: string) => dataUrl.length <= MAX_IMAGE_CHARS;

/** A picture file as a small PNG data URL (a transparent background stays transparent; an animated one becomes still). */
export async function toPetImage(file: File): Promise<string> {
  const refused = refuseFile(file);
  if (refused) throw new Error(refused);
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitSide(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This window cannot draw pictures.");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const url = canvas.toDataURL("image/png");
  if (!fitsStorage(url)) throw new Error("That picture is too detailed to keep. Try a simpler one.");
  return url;
}
