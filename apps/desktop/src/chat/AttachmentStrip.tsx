import { X } from "lucide-react";
import type { Attachment } from "./attachments";

/** The pictures chosen for the next message, with a way to take each one back out. */
export function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <ul aria-label="Images to send" className="mb-2.5 flex flex-wrap gap-2">
      {attachments.map((item) => (
        <li key={item.id} className="relative">
          <img
            alt={item.file.name || "Pasted image"}
            className="h-14 w-14 rounded-cg-md border border-cg-line-strong bg-cg-panel object-cover"
            src={item.preview}
          />
          <button
            aria-label={`Remove ${item.file.name || "pasted image"}`}
            className="absolute -top-1.5 -right-1.5 grid h-5 w-5 place-items-center rounded-full border border-cg-line-strong bg-cg-panel text-cg-muted-strong hover:text-cg-ink"
            title="Remove"
            type="button"
            onClick={() => onRemove(item.id)}
          >
            <X aria-hidden="true" size={11} />
          </button>
        </li>
      ))}
    </ul>
  );
}
