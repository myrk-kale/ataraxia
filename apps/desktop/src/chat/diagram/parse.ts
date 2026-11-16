/**
 * A reader for the part of Mermaid flowcharts that can be drawn faithfully as text: nodes with
 * a label and a rough shape, and arrows between them, with or without a label. It is strict on
 * purpose. Anything it does not understand (`A & B`, a link to a whole subgraph, a diagram that
 * is not a flowchart) makes it say so instead of leaving it out, so the caller can hand the source to
 * the full Mermaid library and nothing is silently drawn wrong.
 */

export type Direction = "LR" | "RL" | "TD" | "BT";
/** How a node's box is drawn: square corners, rounded corners, or a decision (pointed sides). */
export type Shape = "rect" | "round" | "decision";

export interface GraphNode {
  id: string;
  label: string;
  shape: Shape;
  /** The subgraph it sits in (the innermost), or null at the top. */
  group: string | null;
}

/** A `subgraph ... end` block: a titled frame round the nodes written inside it. */
export interface GraphGroup {
  id: string;
  title: string;
  /** The subgraph it is written inside, or null at the top. */
  parent: string | null;
  /** Its own `direction`, when it has one. */
  direction: Direction | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string | null;
  /** False for an open link (`---`), which has no arrowhead. */
  arrow: boolean;
}

export interface Graph {
  direction: Direction;
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups: GraphGroup[];
}

export type Parsed = { ok: true; graph: Graph } | { ok: false; reason: string };

export const LIMITS = { source: 16000, nodes: 60, edges: 100, label: 120, groups: 16, depth: 3 } as const;

const fail = (reason: string): Parsed => ({ ok: false, reason });

/** Lines that only style or annotate; the drawing does not use them. */
const IGNORED = /^(style|classDef|class|linkStyle|click|accTitle|accDescr|title)\b/;
/** The statements that open, close and set up a subgraph. */
const GROUP_WORDS = /^(subgraph|end|direction)\b/;

/** Shape delimiters, longest opener first. */
const SHAPES: { open: string; close: string; shape: Shape }[] = [
  { open: "((", close: "))", shape: "round" },
  { open: "([", close: "])", shape: "round" },
  { open: "[(", close: ")]", shape: "round" },
  { open: "[[", close: "]]", shape: "rect" },
  { open: "{{", close: "}}", shape: "decision" },
  { open: "[", close: "]", shape: "rect" },
  { open: "(", close: ")", shape: "round" },
  { open: "{", close: "}", shape: "decision" },
];

/** Link operators, plain or with the label in `|bars|` after them. */
const PLAIN_LINK = /^(-->|---|-\.->|-\.-|==>|===)(?:\s*\|([^|]*)\|)?/;
/** Links with the label written inside: `-- text -->`, `-. text .->`, `== text ==>`. */
const INLINE_LINKS: { start: string; end: RegExp }[] = [
  { start: "--", end: /\s+(-->|---)/ },
  { start: "-.", end: /\s+(\.->|\.-)/ },
  { start: "==", end: /\s+(==>|===)/ },
];

function cleanLabel(raw: string): string | null {
  let text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1);
  }
  // Markup in a label (line breaks, formatting) is something the text drawing cannot show.
  if (/<[a-z/]/i.test(text) || text.includes("`") || text.includes("\\n")) {
    return null;
  }
  return text.replace(/\s+/g, " ").trim();
}

interface Cursor {
  text: string;
  at: number;
}

function skipSpace(cursor: Cursor) {
  while (cursor.at < cursor.text.length && /\s/.test(cursor.text[cursor.at]!)) {
    cursor.at += 1;
  }
}

/** The text up to `close`, ignoring a `close` inside double quotes. */
function readUntil(cursor: Cursor, close: string): string | null {
  let quoted = false;
  for (let i = cursor.at; i < cursor.text.length; i += 1) {
    const char = cursor.text[i]!;
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && cursor.text.startsWith(close, i)) {
      const body = cursor.text.slice(cursor.at, i);
      cursor.at = i + close.length;
      return body;
    }
  }
  return null;
}

type NodeRead = { id: string; label: string | null; shape: Shape | null } | string;

/** A node: an id, and optionally a shape holding its label. A string is a reason it failed. */
function readNode(cursor: Cursor): NodeRead {
  skipSpace(cursor);
  const id = /^[A-Za-z0-9_]+/.exec(cursor.text.slice(cursor.at))?.[0];
  if (!id) {
    return "a node was expected";
  }
  cursor.at += id.length;
  const rest = cursor.text.slice(cursor.at);
  if (rest.startsWith(":::") || rest.startsWith("@{")) {
    return "node styling is not drawn";
  }
  const shape = SHAPES.find((candidate) => rest.startsWith(candidate.open));
  if (!shape) {
    return { id, label: null, shape: null };
  }
  cursor.at += shape.open.length;
  const body = readUntil(cursor, shape.close);
  if (body === null) {
    return "a node label is not closed";
  }
  const label = cleanLabel(body);
  if (label === null) {
    return "a label has markup";
  }
  return { id, label: label || id, shape: shape.shape };
}

type LinkRead = { arrow: boolean; label: string | null } | string | null;

/** The link after a node, or null when the statement ends. A string is a reason it failed. */
function readLink(cursor: Cursor): LinkRead {
  skipSpace(cursor);
  const rest = cursor.text.slice(cursor.at);
  if (rest === "") {
    return null;
  }
  const plain = PLAIN_LINK.exec(rest);
  if (plain) {
    cursor.at += plain[0].length;
    const label = plain[2] === undefined ? null : cleanLabel(plain[2]);
    if (plain[2] !== undefined && label === null) {
      return "a link label has markup";
    }
    return { arrow: plain[1]!.endsWith(">"), label: label || null };
  }
  for (const link of INLINE_LINKS) {
    if (rest.startsWith(link.start) && rest[link.start.length] === " ") {
      const after = rest.slice(link.start.length);
      const end = link.end.exec(after);
      if (end) {
        const label = cleanLabel(after.slice(0, end.index));
        if (label === null) {
          return "a link label has markup";
        }
        cursor.at += link.start.length + end.index + end[0].length;
        return { arrow: end[1]!.endsWith(">"), label: label || null };
      }
    }
  }
  if (rest.startsWith("&")) {
    return "'&' links are not drawn";
  }
  if (/^(<|--[xo]|~~~)/.test(rest)) {
    return "this link style is not drawn";
  }
  return "a link was expected";
}

const DIRECTIONS = /^(LR|RL|TD|TB|BT)$/;

const asDirection = (word: string): Direction => (word === "TB" ? "TD" : (word as Direction));

/** The id and the title of `subgraph id[Title]`, `subgraph id["Title"]` or `subgraph Title`. */
function readSubgraph(rest: string): { id: string; title: string } | string {
  if (rest === "") {
    return "a subgraph needs a title";
  }
  const bracket = /^([A-Za-z0-9_]+)\s*\[([\s\S]*)\]$/.exec(rest);
  const title = cleanLabel(bracket ? bracket[2]! : rest);
  if (title === null) {
    return "a subgraph title has markup";
  }
  if (title === "") {
    return "a subgraph needs a title";
  }
  const shown = title.length > LIMITS.label ? `${title.slice(0, LIMITS.label - 1)}…` : title;
  return { id: bracket ? bracket[1]! : title, title: shown };
}

export function parseFlowchart(source: string): Parsed {
  if (source.length > LIMITS.source) {
    return fail("the diagram is too long to draw as text");
  }
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.replace(/%%.*$/, "").trim())
    .filter((line) => line !== "");
  const header = /^(?:flowchart|graph)(?:\s+(LR|RL|TD|TB|BT))?\s*;?$/.exec(lines[0] ?? "");
  if (!header) {
    return fail("only flowcharts are drawn as text");
  }
  const direction = (header[1] === "TB" || !header[1] ? "TD" : header[1]) as Direction;

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const groups: GraphGroup[] = [];
  // The subgraphs written around the statement being read, the innermost last.
  const open: GraphGroup[] = [];
  const declare = (read: Exclude<NodeRead, string>) => {
    const inside = open.at(-1)?.id ?? null;
    const known = nodes.get(read.id);
    if (!known) {
      nodes.set(read.id, { id: read.id, label: read.label ?? read.id, shape: read.shape ?? "rect", group: inside });
    } else {
      if (read.label !== null) {
        // A later mention that gives a label is the one that counts.
        known.label = read.label;
        known.shape = read.shape ?? known.shape;
      }
      // A node belongs to the first subgraph it is written in; mentioning it again later, in
      // a link outside, does not move it.
      if (known.group === null && inside !== null) {
        known.group = inside;
      }
    }
  };
  /** Reads `subgraph`, `end` or `direction`; a string is a reason it failed. */
  const readGroupWord = (statement: string): string | null => {
    const word = GROUP_WORDS.exec(statement)![1]!;
    const rest = statement.slice(word.length).trim();
    if (word === "subgraph") {
      const read = readSubgraph(rest);
      if (typeof read === "string") {
        return read;
      }
      if (groups.some((group) => group.id === read.id)) {
        return "two subgraphs have the same name";
      }
      if (open.length >= LIMITS.depth) {
        return "subgraphs are nested too deep to draw as text";
      }
      const group: GraphGroup = { id: read.id, title: read.title, parent: open.at(-1)?.id ?? null, direction: null };
      groups.push(group);
      open.push(group);
      return null;
    }
    if (word === "end") {
      if (rest !== "") {
        return "'end' must stand alone";
      }
      return open.pop() ? null : "'end' closes no subgraph";
    }
    const inside = open.at(-1);
    if (!inside) {
      return "'direction' only applies inside a subgraph";
    }
    if (!DIRECTIONS.test(rest)) {
      return "a direction was expected: LR, RL, TD or BT";
    }
    inside.direction = asDirection(rest);
    return null;
  };

  for (const line of lines.slice(1)) {
    if (IGNORED.test(line)) {
      continue;
    }
    for (const statement of line.split(";")) {
      const cursor: Cursor = { text: statement.trim(), at: 0 };
      if (cursor.text === "") {
        continue;
      }
      if (GROUP_WORDS.test(cursor.text)) {
        const reason = readGroupWord(cursor.text);
        if (reason !== null) {
          return fail(reason);
        }
        continue;
      }
      let previous = readNode(cursor);
      if (typeof previous === "string") {
        return fail(previous);
      }
      declare(previous);
      for (;;) {
        const link = readLink(cursor);
        if (link === null) {
          break;
        }
        if (typeof link === "string") {
          return fail(link);
        }
        const next = readNode(cursor);
        if (typeof next === "string") {
          return fail(next);
        }
        declare(next);
        const key = `${previous.id}\0${next.id}\0${link.label ?? ""}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ from: previous.id, to: next.id, label: link.label, arrow: link.arrow });
        }
        previous = next;
      }
    }
  }
  if (open.length > 0) {
    return fail("a subgraph is not closed");
  }
  if (nodes.size === 0) {
    return fail("the diagram has no nodes");
  }
  if (nodes.size > LIMITS.nodes || edges.length > LIMITS.edges || groups.length > LIMITS.groups) {
    return fail("the diagram is too large to draw as text");
  }
  // A link to a subgraph itself was read as a link to a node of that name.
  if (groups.some((group) => nodes.has(group.id))) {
    return fail("a link to a whole subgraph is not drawn");
  }
  // A subgraph with nothing in it (or only empty ones) has nothing to put the frame round.
  const filled = new Set<string>();
  for (const node of nodes.values()) {
    for (let id = node.group; id !== null; id = groups.find((group) => group.id === id)!.parent) {
      filled.add(id);
    }
  }
  if (groups.some((group) => !filled.has(group.id))) {
    return fail("an empty subgraph is not drawn");
  }
  for (const node of nodes.values()) {
    if (node.label.length > LIMITS.label) {
      node.label = `${node.label.slice(0, LIMITS.label - 1)}…`;
    }
  }
  return { ok: true, graph: { direction, nodes: [...nodes.values()], edges, groups } };
}
