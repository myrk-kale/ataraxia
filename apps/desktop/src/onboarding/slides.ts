import type { SceneId } from "./scenes";
/** What a slide shows: an animation made for it (see scenes/), drawn in the interface's own colours. */
export type Visual = { scene: SceneId };

export type Slide = {
  id: string;
  /** The small label above the title: which part of the app this is. */
  eyebrow: string;
  title: string;
  /** The problem it solves, in a line. */
  problem: string;
  /** What to do with it: short, one idea each. */
  points: readonly string[];
  /** Keys worth knowing, shown as keycaps. */
  keys?: readonly { keys: readonly string[]; label: string }[];
  visual: Visual;
};

export const SLIDES: readonly Slide[] = [
  {
    id: "welcome",
    eyebrow: "Welcome",
    title: "Agents write fast. You decide what ships.",
    problem: "Ataraxia is where you work with coding agents and keep up with what they change.",
    points: ["Talk to your agent in a chat", "Review only what matters", "Keep every decision and the reason for it"],
    visual: { scene: "welcome" },
  },
  {
    id: "workflow",
    eyebrow: "The flow",
    title: "A session, start to finish",
    problem: "A long diff read top to bottom hides the one change that matters.",
    points: ["Ask the agent for the work", "Open the review queue: the riskiest changes come first", "Settle the decisions it left to you", "Commit with the reasons on record"],
    visual: { scene: "workflow" },
  },
  {
    id: "chat",
    eyebrow: "Chat",
    title: "One chat, any agent",
    problem: "Every agent has its own window, its own habits and its own account.",
    points: [
      "Claude Code, Codex, OpenCode and Cursor in the same place",
      "Keep typing while it works: messages queue, and you can pause the queue",
      "Choose the account per chat, right next to the model",
    ],
    visual: { scene: "chat" },
  },
  {
    id: "review",
    eyebrow: "Code review",
    title: "A queue ranked by risk",
    problem: "Nobody reads 40 files with the same attention.",
    points: [
      "Each changed function is scored 0 to 100 from the syntax tree and git, with the reasons listed",
      "Flip old and new with Alt+V, and comment on any line",
      "Let a subagent order the queue and leave out what needs no review",
    ],
    visual: { scene: "review" },
  },
  {
    id: "decisions",
    eyebrow: "Decisions",
    title: "Choices get a verdict, not just a diff",
    problem: "The reasons behind a change are lost the moment it is merged.",
    points: ["Choices that deserve your say become threads", "Approve, push back or ask the agent why", "Link the commits that follow from each one"],
    visual: { scene: "decisions" },
  },
  {
    id: "flow",
    eyebrow: "Flow",
    title: "Diagrams tied to real code",
    problem: "Nobody can hold how a change works in their head.",
    points: ["Ask for a diagram of how it works", "Every node points at a file that exists", "It tells you when the code has moved on and it is out of date"],
    visual: { scene: "flow" },
  },
  {
    id: "btw",
    eyebrow: "BTW",
    title: "Ask on the side, from anywhere",
    problem: "A quick question should not derail the agent's work.",
    points: ["It knows what you have open: the file, the decision, the diagram", "Read-only by default, and the main agent hears a short summary", "A private one never reaches the main chat"],
    keys: [
      { keys: ["Ctrl/⌘", "K"], label: "BTW" },
      { keys: ["Ctrl/⌘", "Shift", "K"], label: "Private BTW" },
    ],
    visual: { scene: "btw" },
  },
  {
    id: "browser",
    eyebrow: "Browser",
    title: "A browser your agent can use",
    problem: "Agents guess at web pages they cannot see.",
    points: [
      "Tabs, a console and a network panel, kept across pages",
      "The agent clicks with a visible mouse; you watch, or take over",
      "It reads the page's own HTTP calls, so a job becomes a script instead of a thousand clicks",
      "Its tabs keep their own cookies: yours are shared only when you say so",
    ],
    keys: [{ keys: ["Ctrl/⌘", "Shift", "L"], label: "Browser" }],
    visual: { scene: "browser" },
  },
  {
    id: "memory",
    eyebrow: "Memory and tasks",
    title: "What you teach once, every agent knows",
    problem: "Each chat starts from zero, and the same correction is made again.",
    points: [
      "A memory shared by every chat and agent: preferences, causes, decisions",
      "Numbered tasks: say “#12” and the agent reads it",
      "An agent can ask to be woken later, to check a deploy or retry",
    ],
    keys: [
      { keys: ["Ctrl/⌘", "Shift", "G"], label: "Memory graph" },
      { keys: ["Ctrl/⌘", "T"], label: "Tasks" },
    ],
    visual: { scene: "memory" },
  },
  {
    id: "yours",
    eyebrow: "Make it yours",
    title: "Quick to move, easy on the eyes",
    problem: "A tool you live in should fit the way you work.",
    points: ["Themes, light and dark, fonts and sounds", "An optional pet to switch on, drag anywhere and dress up: it shows what your agents are doing", "Dictate a message instead of typing it", "Search every chat, decision and file in one place"],
    keys: [
      { keys: ["Shift", "↑/↓"], label: "Next space" },
      { keys: ["Ctrl/⌘", "B"], label: "Search" },
      { keys: ["Ctrl/⌘", "Shift", "M"], label: "Dictate" },
    ],
    visual: { scene: "yours" },
  },
];
