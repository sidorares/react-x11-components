# richtext

```jsx
import {
  registerRichText,
  RICHTEXT_ELEMENT,
  useSelectionMenu,
} from '@react-x11/components/richtext';
```

Styled text that a document can select across: the `<richtext>` element —
wrapped runs, per-run decoration, and the four text accessors core's
selection asks for — plus the right-click menu a read-only surface offers.

[`<Markdown>`](markdown.md) and [`<Code>`](code.md) are compositions over
this. It has a subpath of its own because an app building its own text
surface needs the same parts.

**A shared module, not a component.** Importing this barrel registers
nothing: a component that renders `<richtext>` calls `registerRichText()` at
its own module scope, so an app that imports neither `<Markdown>` nor
`<Code>` registers nothing at all.

## The element

```ts
interface RichTextProps {
  runs: TextRun[];
  wrap?: boolean;
  style?: Style | Style[];
}
```

Give `runs` a **stable array identity** — the layout cache and the streaming
path both key off it. `wrap: false` lays the text out at its natural width,
unwrapped, which is what a code line wants.

```ts
interface TextRun {
  text: string;
  family?: string;
  size?: number;
  weight?: number | 'normal' | 'bold';
  style?: 'normal' | 'italic';
  color?: string;
  bg?: string; // fill painted behind the run — the inline-code chip
  underline?: string; // 1px rule under the baseline, in this colour — links
  strike?: string; // 1px rule through the x-height — ~~del~~
  href?: string | null; // link target; null is a link still streaming in
}
```

`text`, `family`, `size`, `weight`, `style` and `color` are ntk-span
vocabulary and pass straight through to `fonts.layout`. The rest —`bg`,
`underline`, `strike`, `href` — are this element's, painted by it.

`href: null` is deliberate and is what makes a streamed `[text](partial-url`
render as link-styled text that is not yet clickable.

## Selection is core's

Since react-x11#291, selection lives in core: a `selectable` prop on a box
makes it a surface, everything under it that answers for its own text joins
the selection, and the anchor/focus, granularity, PRIMARY, Ctrl+A / Ctrl+C
and the one-visible-selection rule all come with it.

This module used to carry all of that — a `TextSelection` controller and a
`useSelectionGestures` hook. Both are gone, and so are the
`order`/`registry`/`joiner` props the element took to feed them: a copy's
separators now come from the layout.

What is left is the element answering core's four accessors —
`textContent`, `textIndexAt`, `textCaretRect`, `textRangeRects` — which is
all an element of your own has to do to join a document.

## `useSelectionMenu(enabled?)`

The read-only edit menu a surface offers on right-click. Spread the result
onto the **same box the `selectable` prop is on** — the menu's verbs are read
off that node, which is the surface:

```jsx
const menu = useSelectionMenu(selectable);

<box selectable {...menu}>
  …
</box>;
```

```ts
interface SelectionMenuHandlers {
  onContextMenu: (ev: X11MouseEvent<DrawnNode>) => void;
}
```

Core selects, copies and takes PRIMARY by itself, and opens the standard edit
menu by itself for `<textinput>` — but a `selectable` surface has no default
context menu, because which verbs a surface offers is the surface's to say. A
read-only document offers two: **Copy** and **Select all**. A verb left out
is a row that is not there rather than a greyed one, so this menu simply
never mentions Cut or Paste.

Everything else about the menu — which rows are enabled, the arrow keys,
Escape, the pointer grab that dismisses it, handing the keyboard back
afterwards — is core's `openEditMenu` and shared with the field.

## Also exported

- `RichTextNode` — the node class, for a component that wants to subclass or
  to type a ref.
- `NtkApp`, `TextLayoutLike` — the structural types the node speaks. ntk is
  deliberately loose in react-x11's declarations, so an element says what it
  needs rather than importing a wide type.

`tint(color, amount)` — the shade helper these surfaces share — used to be
exported from here as well. It is **core's** now: import it from
`react-x11/style`, where `readableInk` and `interpolate` sit beside it.

## Registering

```ts
import { registerRichText } from '@react-x11/components/richtext';

registerRichText(); // at module scope, in the component's own index.ts
```

Idempotent on purpose: `registerElement` throws on a second registration
without `override`, which is the right default for two _packages_ fighting
over a name — but a lockfile skew that puts two copies of this package in one
app should not fail to boot over it.
