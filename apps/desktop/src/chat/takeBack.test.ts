import { describe, expect, it } from "vitest";
import { takesBack, withTakenBack } from "./takeBack";

describe("taking a queued message back into the field", () => {
  it("does it when the field is empty, or only spaces", () => {
    expect(takesBack("", "write the tests")).toBe(true);
    expect(takesBack("  \n", "write the tests")).toBe(true);
  });

  it("leaves what is typed alone", () => {
    expect(takesBack("something else", "write the tests")).toBe(false);
  });

  it("has nothing to bring back for a message that was only pictures", () => {
    expect(takesBack("", "")).toBe(false);
    expect(takesBack("", "   ")).toBe(false);
  });

  it("does not overwrite what was typed while the removal was on its way", () => {
    expect(withTakenBack("", "queued")).toBe("queued");
    expect(withTakenBack("typed meanwhile", "queued")).toBe("typed meanwhile");
  });
});
