import { X } from "lucide-react";
import { attachmentMime, type Attachment } from "./attachments";

/** Files chosen for the next message, with a way to remove each one. */
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
    <ul aria-label="Files to send" className="mb-2.5 flex flex-wrap gap-2">
      {attachments.map((item) => (
        <li key={item.id} className="relative">
          {attachmentMime(item.file).startsWith("image/") ? (
            <img
              alt={item.file.name || "Pasted image"}
              width={56}
              height={56}
              className="h-14 w-14 rounded-cg-md border border-cg-line-strong bg-cg-panel object-cover"
              src={item.preview}
            />
          ) : (
            <span className="flex min-h-14 max-w-52 items-center break-all rounded-cg-md border border-cg-line-strong bg-cg-panel px-3 py-2 text-small text-cg-ink">
              {item.file.name}
            </span>
          )}
          <button
            aria-label={`Remove ${item.file.name || "pasted image"}`}
            className="absolute -top-1.5 -right-1.5 grid h-5 w-5 cursor-pointer place-items-center rounded-full border border-cg-line-strong bg-cg-panel text-cg-muted-strong hover:text-cg-ink active:bg-cg-hover focus-visible:outline-2 focus-visible:outline-cg-accent"
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
