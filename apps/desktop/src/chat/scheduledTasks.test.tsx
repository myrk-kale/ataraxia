import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseScheduledMessage, type Schedule } from "../lib/agent";
import { everyLabel, ScheduledTasks, whenLabel } from "./ScheduledTasks";
import { TranscriptRow } from "./TranscriptRow";

const NEXT = Date.UTC(2030, 5, 15, 12, 0, 0) / 1000;

function item(extra: Partial<Schedule> = {}): Schedule {
  return {
    id: "3f2a9c1e-0000-4000-8000-000000000000",
    prompt: "check the release",
    next_run: NEXT,
    every_secs: null,
    expires_at: null,
    created_at: 0,
    ...extra,
  };
}

function render(schedules: Schedule[]) {
  return renderToStaticMarkup(<ScheduledTasks schedules={schedules} onCancel={() => {}} />);
}

describe("ScheduledTasks", () => {
  it("renders nothing when nothing is scheduled", () => {
    expect(render([])).toBe("");
  });

  it("lists what the agent asked to be told about, with a cancel control named after it", () => {
    const html = render([item(), item({ id: "b", prompt: "retry the deploy" })]);
    expect(html).toContain("Scheduled (2)");
    expect(html).toContain("check the release");
    expect(html).toContain('aria-label="Cancel the schedule: retry the deploy"');
  });

  it("says when a recurring schedule repeats", () => {
    expect(render([item({ every_secs: 300 })])).toContain("every 5 min");
    expect(render([item()])).not.toContain("every");
  });
});

describe("labels", () => {
  it("names an interval in the biggest whole unit", () => {
    expect(everyLabel(60)).toBe("every 1 min");
    expect(everyLabel(330)).toBe("every 6 min");
    expect(everyLabel(7_200)).toBe("every 2 h");
    expect(everyLabel(86_400)).toBe("every day");
    expect(everyLabel(172_800)).toBe("every 2 days");
  });

  it("shows only the time for today and the day too for another day", () => {
    const sameDay = new Date(NEXT * 1000);
    expect(whenLabel(NEXT, sameDay)).not.toContain(",");
    const later = new Date((NEXT + 3 * 86_400) * 1000);
    expect(whenLabel(NEXT, later)).toContain(",");
  });
});

describe("parseScheduledMessage", () => {
  it("tells a message a schedule sent from one the user typed", () => {
    expect(parseScheduledMessage("[Scheduled task 3f2a9c1e] check the release\nand report")).toEqual({
      id: "3f2a9c1e",
      prompt: "check the release\nand report",
    });
    expect(parseScheduledMessage("scheduled task: check")).toBeNull();
    expect(parseScheduledMessage("please [Scheduled task 1] x")).toBeNull();
  });
});

describe("a message a schedule sent", () => {
  const row = (text: string) => ({
    key: "m1",
    item: { kind: "message" as const, id: "m1", turnId: "t1", role: "user" as const, text, images: [] },
    after: 0,
    notice: false,
  });

  it("is a labelled line, not the user's bubble", () => {
    const html = renderToStaticMarkup(
      <TranscriptRow row={row("[Scheduled task 3f2a9c1e] check the release")} sessionId="s1" />,
    );
    expect(html).toContain("Scheduled");
    expect(html).toContain("check the release");
    expect(html).not.toContain("3f2a9c1e");
    expect(html).not.toContain("bg-cg-bubble");
  });

  it("leaves what the user typed as a bubble", () => {
    const html = renderToStaticMarkup(<TranscriptRow row={row("hello")} sessionId="s1" />);
    expect(html).toContain("bg-cg-bubble");
  });
});
