import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QueuedMessages } from "./QueuedMessages";

const ITEMS = [
  { id: "a", text: "write the tests", images: [] },
  { id: "b", text: "then update the docs", images: [] },
];

function render(items = ITEMS, paused = false) {
  return renderToStaticMarkup(
    <QueuedMessages queue={{ items, paused }} onRemove={() => {}} onSendNow={() => {}} onSetPaused={() => {}} />,
  );
}

describe("QueuedMessages", () => {
  it("renders nothing for an empty queue", () => {
    expect(render([])).toBe("");
  });

  it("lists the messages in the order they will be sent and says so", () => {
    const html = render();
    expect(html.indexOf("write the tests")).toBeGreaterThan(-1);
    expect(html.indexOf("write the tests")).toBeLessThan(html.indexOf("then update the docs"));
    expect(html).toContain("Queued (2)");
    expect(html).toContain("one after another");
  });

  it("gives each message a send-now and a remove control named after it", () => {
    const html = render();
    expect(html).toContain('aria-label="Send now: then update the docs"');
    expect(html).toContain('aria-label="Remove from the queue: write the tests"');
    expect(html).toContain(">Send now<");
  });

  it("says why nothing is going out when the queue is paused", () => {
    const html = render(ITEMS, true);
    expect(html).toContain("Paused: nothing is sent until you resume");
    expect(html).not.toContain("Queued (2)");
  });

  it("says what the agent left undone when it asked for the pause", () => {
    const html = renderToStaticMarkup(
      <QueuedMessages
        queue={{ items: ITEMS, paused: true, reason: "The deploy needs a token." }}
        onRemove={() => {}}
        onSendNow={() => {}}
        onSetPaused={() => {}}
      />,
    );
    expect(html).toContain("Paused by the agent: The deploy needs a token. Resume");
    expect(html).not.toContain("nothing is sent until you resume");
  });

  it("shows a message that is still being added, but does not let it be sent or removed yet", () => {
    const html = renderToStaticMarkup(
      <QueuedMessages
        queue={{ items: [{ id: "pending:1", text: "just sent", images: [], pending: true }], paused: false }}
        onRemove={() => {}}
        onSendNow={() => {}}
        onSetPaused={() => {}}
      />,
    );
    expect(html).toContain("just sent");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain("Being added to the queue");
  });

  it("offers to hold a queue that is going on, and to resume one that is held", () => {
    expect(render()).toContain(">Pause<");
    expect(render()).toContain("not even after a /compact");
    expect(render(ITEMS, true)).toContain(">Resume<");
  });

  it("lets a message the app has listed be sent and removed", () => {
    expect(render()).not.toContain('disabled=""');
  });
});

