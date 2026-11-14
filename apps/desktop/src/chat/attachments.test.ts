// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { imagesFromClipboard, MAX_IMAGE_BYTES, MAX_IMAGES, pickImages, toUploads } from "./attachments";

function file(name: string, type: string, size = 10): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("pickImages", () => {
  it("takes the picture formats and says why it left anything else out", () => {
    const { accepted, problems } = pickImages(
      [file("a.png", "image/png"), file("b.webp", "image/webp"), file("c.svg", "image/svg+xml"), file("d.pdf", "application/pdf")],
      MAX_IMAGES,
    );
    expect(accepted.map((item) => item.name)).toEqual(["a.png", "b.webp"]);
    expect(problems).toEqual(["c.svg is not a PNG, JPEG, GIF or WebP image.", "d.pdf is not a PNG, JPEG, GIF or WebP image."]);
  });

  it("refuses a picture over the size limit", () => {
    const { accepted, problems } = pickImages([file("big.png", "image/png", MAX_IMAGE_BYTES + 1)], MAX_IMAGES);
    expect(accepted).toEqual([]);
    expect(problems[0]).toBe("big.png is over 5 MB.");
  });

  it("stops at the room the message has left", () => {
    const files = [file("1.png", "image/png"), file("2.png", "image/png"), file("3.png", "image/png")];
    const { accepted, problems } = pickImages(files, 2);
    expect(accepted).toHaveLength(2);
    expect(problems).toEqual([`3.png was left out: a message takes ${MAX_IMAGES} images at most.`]);
  });

  it("names a pasted picture that has no name", () => {
    expect(pickImages([file("", "image/gif", MAX_IMAGE_BYTES + 5)], 1).problems[0]).toMatch(/^A pasted image is over/);
  });
});

describe("imagesFromClipboard", () => {
  function clipboard(types: string[], files: File[]) {
    return {
      types,
      items: files.map((item) => ({ kind: "file", type: item.type, getAsFile: () => item })),
    } as unknown as DataTransfer;
  }

  it("reads the pictures a paste carries", () => {
    const shot = file("image.png", "image/png");
    expect(imagesFromClipboard(clipboard(["Files"], [shot]))).toEqual([shot]);
  });

  it("leaves a paste that has text to the text", () => {
    expect(imagesFromClipboard(clipboard(["text/plain", "Files"], [file("cells.png", "image/png")]))).toEqual([]);
  });

  it("ignores files that are not pictures and an empty clipboard", () => {
    expect(imagesFromClipboard(clipboard(["Files"], [file("a.pdf", "application/pdf")]))).toEqual([]);
    expect(imagesFromClipboard(null)).toEqual([]);
  });
});

describe("toUploads", () => {
  it("sends the bytes as base64 with the name and type", async () => {
    const attachment = { id: "1", file: new File([new Uint8Array([104, 105])], "hi.png", { type: "image/png" }), preview: "blob:x" };
    expect(await toUploads([attachment])).toEqual([{ name: "hi.png", mime: "image/png", data: "aGk=" }]);
  });

  it("gives a nameless picture a name", async () => {
    const attachment = { id: "1", file: new File([new Uint8Array([1])], "", { type: "image/png" }), preview: "blob:x" };
    expect((await toUploads([attachment]))[0]?.name).toBe("image 1");
  });
});
