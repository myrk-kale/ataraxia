# Drawing in the chat with SVG

You can put a picture in your reply: a fenced block whose language is `svg`. The chat shows it as an
image, in the colours of the reader's theme. This page is how to make one that is clear and good
to look at. Read it once per chat, before your first drawing.

## When a drawing earns its place

Draw when a picture teaches faster than the same words: a concept map or mind map, how the parts of
a system sit together, a comparison, before and after, a timeline, layers, a sketch of how data
moves. The reader should understand something in a glance that a paragraph would make them
assemble in their head.

Do not draw for decoration, for what a sentence or a table says as well, or for code (that is a
code block). A request for "a diagram" with no kind is a Mermaid diagram, not this; draw an SVG when
they ask for one, or for a mind map, an illustration or a visual explanation. At most one drawing
in a reply unless they ask for more. Answer in words as well: the drawing completes the answer, it
does not replace it.

## What the chat does with it

It is shown through an `<img>`: it cannot run code and cannot fetch anything. Scripts, event
attributes, links, `<image>`, `<foreignObject>` and animation are removed, and fonts are the
system's. So make a static, self-contained drawing. The reader can expand it, view its code and copy
it.

## The shape of the block

Exactly one `<svg>`, nothing else in the fence: no prose, no markdown, no XML prolog.

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 240">
  <title>Short name of the picture</title>
  <desc>One sentence on what it shows, for someone who cannot see it.</desc>
  ...
</svg>
```

- `viewBox` is `0 0 800 H`: always 800 wide, `H` between 240 and 560 as the drawing needs. Never
  set `width` or `height`.
- `<title>` and `<desc>` are required: they are the picture's text alternative.
- Escape `&` as `&amp;` and `<` as `&lt;` in text. Close every tag.

## Colour: use the theme's names

The app adds a stylesheet before yours, so a drawing is right in light and dark. Use these classes
instead of colours of your own (a hex colour is fine on a small detail, never for text or for the
boxes):

| class | for |
|---|---|
| `title` | the drawing's heading (22 px, bold), once, top left |
| `label` | text inside a node (15 px, medium) |
| `small` | a caption or a note (13 px, muted) |
| `muted`, `accent`, `good`, `bad`, `warn` | text or shape fill in that colour |
| `node` | a box: soft fill, thin border |
| `node-accent` | the one box the explanation is about |
| `edge`, `edge-accent` | a connector line (no fill) |
| `arrow` | the fill of an arrowhead |
| `bg` | a full-size backdrop, only if you need one: the panel is already that colour |

Variables work in `style` (`style="fill:var(--accent-bg)"`): `--ink --muted --line --tint --panel
--accent --accent-bg --green --red --amber`. Do not set `font-family`.

## Making it good

- One idea per drawing. Ten or twelve shapes at most. A label is one to three words; the detail
  goes in your text.
- One focus. Make the thing you are explaining `node-accent` and the rest `node`. Two hues beyond
  the neutrals is the limit, and meaning never rests on colour alone: say it in a label.
- Compose on a grid of 8. Margins of at least 32 from the edge, gaps of at least 24 between boxes,
  siblings the same size, corners `rx="12"`. Align centres and edges; a crooked row looks careless.
- Text must fit. A character is about 0.55 of the font size wide (about 8.5 px at `label`), so a box
  is at least `characters x 8.5 + 32` wide. Centre text with `text-anchor="middle"` and
  `dominant-baseline="central"` at the box's centre. Two lines: two `<text>` elements, 20 apart.
  No text under 13 px.
- Connectors: straight, or a gentle cubic curve; do not cross lines, route around. Put a tiny label
  (`small`) beside a line only if the line needs a name. Arrowheads with a `<marker>` (below).
- Read left to right and top to bottom. Start from the title, end at the conclusion.
- Write labels in the language the developer writes in.

### A mind map

Centre in `node-accent`, four to eight branches around it, curves from the centre's edge to each
branch, a `small` line under a branch for its one detail.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 460">
  <title>How sign-in is organised</title>
  <desc>Sign-in at the centre, with four parts around it: login, sessions, tokens and permissions.</desc>
  <text class="title" x="40" y="44">How sign-in is organised</text>
  <path class="edge" d="M310 250 C 250 250, 260 130, 210 130"/>
  <path class="edge" d="M310 250 C 250 250, 260 380, 210 380"/>
  <path class="edge" d="M490 250 C 550 250, 540 130, 590 130"/>
  <path class="edge" d="M490 250 C 550 250, 540 380, 590 380"/>
  <rect class="node-accent" x="310" y="218" width="180" height="64" rx="14"/>
  <text class="label" x="400" y="250" text-anchor="middle" dominant-baseline="central">Sign-in</text>
  <rect class="node" x="40" y="106" width="170" height="48" rx="12"/>
  <text class="label" x="125" y="130" text-anchor="middle" dominant-baseline="central">Login</text>
  <text class="small" x="125" y="176" text-anchor="middle">email and password</text>
  <rect class="node" x="40" y="356" width="170" height="48" rx="12"/>
  <text class="label" x="125" y="380" text-anchor="middle" dominant-baseline="central">Sessions</text>
  <text class="small" x="125" y="426" text-anchor="middle">kept for 30 days</text>
  <rect class="node" x="590" y="106" width="170" height="48" rx="12"/>
  <text class="label" x="675" y="130" text-anchor="middle" dominant-baseline="central">Tokens</text>
  <text class="small" x="675" y="176" text-anchor="middle">short lived</text>
  <rect class="node" x="590" y="356" width="170" height="48" rx="12"/>
  <text class="label" x="675" y="380" text-anchor="middle" dominant-baseline="central">Permissions</text>
  <text class="small" x="675" y="426" text-anchor="middle">per workspace</text>
</svg>
```

### Boxes and arrows

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 220">
  <title>A request reaching the database</title>
  <desc>A request goes to the server, which queries the database.</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path class="arrow" d="M0 0 L10 5 L0 10 z"/>
    </marker>
  </defs>
  <text class="title" x="40" y="44">A request reaching the database</text>
  <rect class="node" x="40" y="96" width="180" height="64" rx="12"/>
  <text class="label" x="130" y="128" text-anchor="middle" dominant-baseline="central">Request</text>
  <rect class="node-accent" x="310" y="96" width="180" height="64" rx="12"/>
  <text class="label" x="400" y="128" text-anchor="middle" dominant-baseline="central">Server</text>
  <rect class="node" x="580" y="96" width="180" height="64" rx="12"/>
  <text class="label" x="670" y="128" text-anchor="middle" dominant-baseline="central">Database</text>
  <path class="edge" d="M220 128 L304 128" marker-end="url(#arrow)"/>
  <path class="edge" d="M490 128 L574 128" marker-end="url(#arrow)"/>
  <text class="small" x="262" y="116" text-anchor="middle">HTTP</text>
  <text class="small" x="532" y="116" text-anchor="middle">SQL</text>
</svg>
```

## Before you send it

Check it as if you were the renderer: every coordinate is inside the viewBox; no two texts touch;
every text fits its box; every `url(#id)` has its `id`; the XML is well formed. If it would not
read at a glance, simplify it: fewer shapes, shorter labels. Then add a sentence or two, after
the block, on how to read it.
