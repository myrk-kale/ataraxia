import type { ImageUpload } from "../lib/agent";

/** Pictures on one message, and the size of each. The agent side holds to the same limits. */
export const MAX_IMAGES = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Only pictures for now. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const IMAGE_ACCEPT = IMAGE_TYPES.join(",");

/** A picture chosen for the next message, shown as a thumbnail until it is sent. */
export type Attachment = {
  id: string;
  file: File;
  /** An object URL for the thumbnail; revoke it when the attachment is dropped. */
  preview: string;
};

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/**
 * Which of the files can be added, with a sentence for each one that cannot. `room` is how many
 * more pictures the message can take.
 */
export function pickImages(files: File[], room: number): { accepted: File[]; problems: string[] } {
  const accepted: File[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const name = file.name || "A pasted image";
    if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) {
      problems.push(`${name} is not a PNG, JPEG, GIF or WebP image.`);
    } else if (file.size > MAX_IMAGE_BYTES) {
      problems.push(`${name} is over ${megabytes(MAX_IMAGE_BYTES)}.`);
    } else if (accepted.length >= room) {
      problems.push(`${name} was left out: a message takes ${MAX_IMAGES} images at most.`);
    } else {
      accepted.push(file);
    }
  }
  return { accepted, problems };
}

/**
 * The pictures on the clipboard, or none when it also carries text: copying cells from a sheet puts
 * a picture of them beside the text, and the text is what was meant.
 */
export function imagesFromClipboard(data: Pick<DataTransfer, "items" | "types"> | null): File[] {
  if (!data || Array.from(data.types).includes("text/plain")) {
    return [];
  }
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }
  }
  return files;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("could not read the image"));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** What goes to the app for these attachments. */
export function toUploads(attachments: Attachment[]): Promise<ImageUpload[]> {
  return Promise.all(
    attachments.map(async ({ file }, index) => ({
      name: file.name || `image ${index + 1}`,
      mime: file.type,
      data: await toBase64(file),
    })),
  );
}
