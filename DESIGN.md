# Ataraxia design direction

This file records the direction the interface already follows, so the next change starts from it instead of from a default. The identity (name, the A mark, the calm tone) comes from the product; where a reason below was written by the agent that documented it, it is marked **to confirm**.

## Read

A code-review workspace for developers who delegate work to coding agents, in a calm, dense, text-first style. Dials: **ENERGY 1 / RHYTHM 1 / MOTION 1**.

- ENERGY 1: the interface is a tool people sit in for hours. It does not say hello; the code and the agent's words are the loudest things on screen.
- RHYTHM 1: the screens are working surfaces (a queue, an editor, a thread), so they repeat one structure on purpose. Variety would cost scanning speed.
- MOTION 1: hover, focus and press states, plus indicators for work in progress (a spinner or typing dots). The opening plays every time the app opens, and any key skips it. No entrance animation on panels, menus or messages. One slow exception: the animated ASCII background of the chat (see Identity). It stops while the window is hidden, is a still picture with reduced motion, and can be turned off in Settings (Appearance, Animated background).

## Palette

Neutral warm greys, one violet accent, one near-black action colour, and three semantic colours. Every token lives in `apps/desktop/src/styles/index.css` for both themes, and each text and control pairing was measured against WCAG AA (4.5:1 text, 3:1 controls and borders).

- Accent (violet): links, focus rings, the selected item. Nothing else.
- Primary (near-black in light, near-white in dark): the one main action of a screen.
- Green: ready, approved, added. Red: failed, rejected, removed, high priority. Amber: needs attention (out of date, medium priority). Each means one thing, and every use also carries words or a shape, never colour alone.
- Hairline borders (`--cg-line`) separate areas; a control's own edge uses `--cg-control` (3:1).

## Type

Geist for text and Geist Mono for code, paths and keys. Reason (**to confirm**): Geist was drawn for developer interfaces and its mono shares the sans metrics, so a path or identifier sitting inside a sentence does not break the line height. Nothing informative is smaller than 12px. Section labels are sentence case with weight, not capitals with tracking.

## Shape and depth

- Three radii: `sm` 6px (rows, chips, icon buttons), `md` 9px (buttons, inputs, menu items), `lg` 14px (dialogs, panels, composer). Round is only for dots and the count badge.
- Elevation marks only what floats above the page: menus, tooltips, dialogs, the toast. Everything else sits flat. Shadows are tokens with a dark variant.
- Blur is used once, behind the permission dialog, where it isolates a decision.

## Identity

- The mark is the A of ATARAXIA, drawn with the same strokes as the opening. The favicon and app icon use it on the ink colour. The header carries no logo: on macOS it is the window's title bar, with room left for the window buttons and empty parts that move the window.
- The empty chat shows the A as animated ASCII art behind the "What shall we build?" block, in the same voice as the opening (ASCII, monochrome ink). Reason: it is the one moment the screen has nothing to read, so it can carry the identity. When the chat begins the A rises and fades within about a second and a half, and the faint field that drifted around it stays behind the conversation, so the screen keeps its calm movement. The motion is slow (the name means calm): the stroke breathes, a light runs up the legs and across the bar, the field drifts and keeps clear of the A, and the cursor lights the characters near it. Behind words the art is kept faint (at most 6% ink: the title block of the empty state, and the whole message column once the chat has begun), which was measured against 4.5:1 for the primary, secondary and muted text in both themes (`asciiArt.test.ts`); only the margins beside the column show it more strongly. The only words on screen while the A is still fading are the person's own message, on its opaque bubble, and the chat's title line.
- Agents are told apart by name plus an initial on a tint of their own. This is a stand-in until the providers' official marks are cleared for use (**to confirm**).
- The app is English-only for now: the interface text, `lang="en"`, and the prompts it sends.

## Rules for new screens

1. A screen that holds data has an empty, a loading and a failed state, each saying what is happening and what to do.
2. A state is words (and a shape) first. Colour only reinforces it.
3. A control is one native element with a name, a visible focus ring and a keyboard path. Tooltips go through `Tip`, which keeps the button as the only control.
4. Anything the product can do is reachable without knowing a shortcut. Shortcuts are the fast path, not the only path (BTW is the one deliberate exception, summoned by Ctrl/⌘ K and explained wherever it applies).
5. No invented numbers, people or activity. An empty state beats a fake one.
