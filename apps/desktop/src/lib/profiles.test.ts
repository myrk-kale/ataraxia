import { describe, expect, it } from "vitest";
import { PROFILE_COLORS, activeProfile, nextColor, profilesOf, type Profiles } from "./profiles";

const book: Profiles = {
  profiles: [
    { id: "a", provider: "claude", name: "Work", color: "#3b82f6", command: "claude" },
    { id: "b", provider: "claude", name: "Home", color: "#22c55e", command: "claude" },
    { id: "c", provider: "codex", name: "Team", color: "#3b82f6", command: "codex" },
  ],
  active: { claude: "b" },
};

describe("profiles", () => {
  it("lists a harness's own profiles", () => {
    expect(profilesOf(book, "claude").map((p) => p.name)).toEqual(["Work", "Home"]);
    expect(profilesOf(book, "opencode")).toEqual([]);
  });

  it("finds the one in use, per harness", () => {
    expect(activeProfile(book, "claude")?.name).toBe("Home");
    expect(activeProfile(book, "codex")).toBeNull();
  });

  it("treats an active id that no longer exists as the default", () => {
    expect(activeProfile({ ...book, active: { claude: "gone" } }, "claude")).toBeNull();
    // An id of another harness's profile is not this one's.
    expect(activeProfile({ ...book, active: { claude: "c" } }, "claude")).toBeNull();
  });

  it("offers the first colour not used yet, and wraps when all are", () => {
    expect(nextColor([])).toBe(PROFILE_COLORS[0]);
    expect(nextColor(["#3b82f6", "#22c55e"])).toBe(PROFILE_COLORS[2]);
    expect(nextColor(["#3B82F6"])).toBe(PROFILE_COLORS[1]);
    expect(PROFILE_COLORS).toContain(nextColor([...PROFILE_COLORS]));
  });

  it("keeps every offered colour apart", () => {
    expect(new Set(PROFILE_COLORS).size).toBe(PROFILE_COLORS.length);
  });
});
