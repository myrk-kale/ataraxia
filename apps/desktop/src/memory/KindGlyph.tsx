import { BookOpen, History, ListChecks, Timer, type LucideIcon } from "lucide-react";
import type { MemoryKind } from "../lib/memory";

const GLYPHS: Record<MemoryKind, LucideIcon> = {
  semantic: BookOpen,
  episodic: History,
  procedural: ListChecks,
  working: Timer,
};

/** A shape for each kind, so the kind never rests on a colour alone. */
export function KindGlyph({ kind, size = 13, className = "" }: { kind: MemoryKind; size?: number; className?: string }) {
  const Glyph = GLYPHS[kind];
  return <Glyph aria-hidden="true" className={className} size={size} />;
}
