import type { ImageUpload } from "../lib/agent";

/** The wire protocol retains its image names; each message can also carry documents. */
export const MAX_IMAGES = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const DOCUMENT_TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  md: "text/markdown",
  markdown: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xls: "application/vnd.ms-excel",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odp: "application/vnd.oasis.opendocument.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  txt: "text/plain",
  json: "application/json",
  xml: "application/xml",
};
export const IMAGE_ACCEPT = [...IMAGE_TYPES, ...Object.keys(DOCUMENT_TYPES).map((extension) => `.${extension}`)].join(
  ",",
);

export function attachmentMime(file: File): string {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return DOCUMENT_TYPES[extension] ?? file.type;
}

/** A file chosen for the next message. Only images use the preview as a thumbnail. */
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
 * more files the message can take.
 */
export function pickImages(files: File[], room: number): { accepted: File[]; problems: string[] } {
  const accepted: File[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const name = file.name || "A pasted image";
    const mime = attachmentMime(file);
    const image = (IMAGE_TYPES as readonly string[]).includes(mime);
    const limit = image ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
    if (!image && !Object.values(DOCUMENT_TYPES).includes(mime)) {
      problems.push(`${name} is not a supported image, document, spreadsheet or presentation.`);
    } else if (file.size > limit) {
      problems.push(`${name} is over ${megabytes(limit)}.`);
    } else if (accepted.length >= room) {
      problems.push(`${name} was left out: a message takes ${MAX_IMAGES} files at most.`);
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
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
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
      mime: attachmentMime(file),
      data: await toBase64(file),
    })),
  );
}
