import { useEffect, useState } from "react";
import { agentAttachment, type ImageAttachment } from "../lib/agent";
import { ImageCache } from "./imageCache";

// A picture is read from the app once, not at every redraw or every time its message scrolls
// back into view; the cache is bounded, so a long chat does not hold all its pictures (32 MB).
const cache = new ImageCache(32 * 1024 * 1024);

/**
 * Gives a picture's address ahead of the app: a message shown the moment it is sent already has
 * its pictures, so they are there to show.
 */
export function seedPicture(sessionId: string, imageId: string, url: string) {
  cache.set(`${sessionId}:${imageId}`, url);
}

function Picture({ sessionId, image }: { sessionId: string; image: ImageAttachment }) {
  const key = `${sessionId}:${image.id}`;
  const [url, setUrl] = useState<string | null>(cache.get(key) ?? null);
  const [failed, setFailed] = useState(false);
  const [large, setLarge] = useState(false);

  useEffect(() => {
    if (cache.get(key) !== undefined) {
      setUrl(cache.get(key) ?? null);
      return;
    }
    let cancelled = false;
    agentAttachment(sessionId, image.id).then(
      (loaded) => {
        cache.set(key, loaded);
        if (!cancelled) {
          setUrl(loaded);
        }
      },
      () => {
        if (!cancelled) {
          setFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, sessionId, image.id]);

  if (failed || url === null) {
    return (
      <span className="rounded-cg-sm border border-cg-line px-2 py-1 text-small text-cg-muted-strong">
        {failed ? `${image.name} is no longer available` : `Loading ${image.name}…`}
      </span>
    );
  }
  return (
    <button
      aria-label={`${large ? "Show smaller" : "Show larger"}: ${image.name}`}
      aria-pressed={large}
      className="block max-w-full rounded-cg-md border border-cg-line bg-cg-panel p-0.5"
      type="button"
      onClick={() => setLarge((value) => !value)}
    >
      <img
        alt={image.name}
        className={`rounded-cg-sm object-contain ${large ? "max-h-[60vh] max-w-full" : "max-h-32 max-w-48"}`}
        src={url}
      />
    </button>
  );
}

/** The pictures of a user's message, above its words. */
export function MessageImages({ sessionId, images }: { sessionId: string; images: ImageAttachment[] }) {
  if (images.length === 0) {
    return null;
  }
  return (
    <div aria-label="Attached images" className="mb-2 flex flex-wrap items-start gap-2" role="group">
      {images.map((image) => (
        <Picture key={image.id} image={image} sessionId={sessionId} />
      ))}
    </div>
  );
}
