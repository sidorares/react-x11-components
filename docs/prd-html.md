# An HTML control worth having

The design record behind [`<Html>`](components/html.md). It covers why this
package has an HTML renderer at all after deciding twice that it should not,
what shape the renderer takes and why, what the seams are for, and the
isolated-process mode that is designed here and built next.

## Why this exists, having twice been ruled out

Two prior decisions are being reversed, and both deserve naming rather than
quietly contradicting.

**ntk's `HtmlView` is deprecated** ([ntk#106]) along with `MarkdownView`, and
this repository's own record said, in as many words, that there is
"deliberately **no `<html>` successor**: nothing in this package renders
through an HTML pass". That was the right call at the time and for the reason
given: the only thing wanting an HTML pass was `<Markdown>`, and markdown does
not need one — `src/markdown/` renders its AST straight to boxes and
`<richtext>`, which is how it got cross-block selection and per-block
streaming, neither of which the ntk widget had.

What changed is that **HTML arrived as an input in its own right**, not as an
intermediate representation. An application is handed HTML by things it does
not control — mail, release notes, a CMS, a help system, an exported report,
a model's output — and "render this document" is the whole requirement. There
is no markdown upstream of it to render instead.

So the question is not "should markdown go through HTML" (no, and that stays
answered) but "can this package render a document it is handed". The answer
was previously "ntk can, badly". Now it is this.

**What `HtmlView` got wrong**, and what any successor has to fix:

- **No selection.** Its layout items are unreachable, so a document is an
  opaque picture. For a component whose entire job is showing text a user
  wants to read, this is disqualifying — it is the same defect that made
  `<Markdown>` a from-scratch successor rather than a wrapper.
- **Everything through yoga.** Block flow, floats, margin collapsing and
  table column sizing are not flexbox, and approximating them means a
  document that is subtly wrong in ways nobody can predict from the markup.
- **Form controls dropped entirely.** `input`, `select`, `textarea` and
  `button` are in its skip list.
- **No streaming.** Any edit relaid the whole document.

## The shape

```
source ──► parse ──► DOM ──► cascade ──► box tree ──► layout ──► paint
           (streaming)       (+ CSSOM)
```

Six stages, and the design is mostly about **which of them a given change
re-runs**:

| What changed    | parse | cascade | boxes | layout | paint |
| --------------- | :---: | :-----: | :---: | :----: | :---: |
| `source` grew   | tail  |    ·    |   ●   |   ●    |   ●   |
| a stylesheet    |   ·   |    ●    |   ●   |   ●    |   ●   |
| the DOM         |   ·   |    ●    |   ●   |   ●    |   ●   |
| the width       |   ·   |    ·    |   ·   |   ●    |   ●   |
| a `@media` band |   ·   |    ●    |   ●   |   ●    |   ●   |
| expose / scroll |   ·   |    ·    |   ·   |   ·    |   ●   |

The two rows that matter are the last two, because they are the two the brief
named: **input HTML to first content painted**, and **what a subsequent
expose or resize costs**.

Two invariants make the table true rather than aspirational, and both are
enforced by the shape of the data rather than by discipline:

- **A computed style never depends on the width.** Percentages and `auto`
  survive into layout as unresolved `Len`s; `em`, `rem` and the viewport
  units resolve at computed-style time, when they are already known. So a
  style computed at one width is correct at every width, and a resize skips
  the cascade — which is the expensive half.
- **A box never depends on the scroll.** Layout writes absolute document
  coordinates, and painting is those coordinates plus an origin.

`@media` width queries are the exception that proves the first rule, so they
are handled explicitly: every width at which some rule changes its mind is
collected at parse time, and a resize restyles only when it crossed one.

### Why the element draws

Every other document surface in this package composes: `<Markdown>`,
`<Code>` and `<TerminalOutput>` are trees of `<box>` and `<richtext>`. This
one is a single registered element that lays out and paints the whole
document. Two reasons, and they are not the same weight.

The cheap reason is **cost**. A real document is thousands of elements; a
React element and a yoga node each, reconciled per streamed chunk, is the
cost the brief asks to avoid.

The load-bearing reason is that **CSS layout is not the host's layout**.
react-x11 lays out with yoga. Block flow with margin collapsing, an inline
formatting context, floats and table column sizing are not flexbox and cannot
be expressed in it. Composing onto `<box>` would mean _approximating the
layout model_, which is precisely what makes `HtmlView` hard to trust: the
markup is standard, the rendering is not, and no amount of reading the source
tells an author which is which.

This extends the rule `<Flow>` established ("ask whether the feature's
viewport is a transform; if it is, the element draws"). The extension:
**ask whether the feature brings its own layout model.** If it does, the
element draws, because the alternative is lying about the model.

### What is reused from `<richtext>`, and what is not

The brief suggested reusing the richtext control. What was reused is
everything that was never about the element:

- **`TextRun`** — the span vocabulary ntk's `TextLayout` takes. An inline run
  of HTML is exactly that shape, so nothing is converted.
- **`src/richtext/runs.ts`** — extracted in this change. The per-run
  decoration painter (backgrounds, the five underline styles, strikethrough)
  and the bidi-correct selection bands. `<richtext>`'s own `paint` is now a
  loop over its lines calling the same functions, so the two cannot drift.
- **`useLinkClicks`** — generalised from `instanceof RichTextNode` to any
  node answering `hrefAtPoint`, which also stops the hook from importing the
  element.
- **`useSelectionMenu`** — unchanged.
- **`src/internal/text.ts`** — the code-point/code-unit conversions, promoted
  out of `src/richtext/internal.ts` now that two directories share them.

What was **not** reused is the `<richtext>` element itself, for the layout
reason above. Rendering a document as a tree of `<richtext>` leaves would put
inline layout back inside yoga's box model, where an `<img>` in the middle of
a sentence has nowhere to go.

### Dependencies, and why this one is allowed to have some

This package's usual answer to a parser is "write it" (`src/markdown/parse.ts`
is a hand-written GFM parser) or "make it optional" (`ical.js`,
`@xterm/headless`), because install closure is a real cost.

Here the calculus inverts, on a fact rather than a preference: **ntk already
depends on `htmlparser2`, `domhandler`, `domutils` and `css-select`**, for its
own deprecated `HtmlView`, and ntk is react-x11's dependency. Every app that
can use this package already has all four installed. Declaring them adds no
packages to an install; it only makes the resolution correct under pnpm's
strict layout instead of relying on hoisting.

They also happen to be the right tools:

- **htmlparser2** is streaming by construction. `parser.write(chunk)` appends
  to the tree in place, which _is_ the progressive-DOM requirement rather
  than an approximation of it.
- **domhandler**'s nodes are plain mutable objects, so "manipulate the DOM and
  the control reflects it" is an object graph plus an invalidation call.
- **css-select** compiles a selector to a closure once. Selector matching is
  the one part of a CSS engine where a hand-written version is reliably both
  slower and wronger, and its adapter has an `isHovered` hook, which is how
  `:hover` is answered from this renderer's pointer state.

**CSS parsing is written here** rather than taken from postcss, which ntk also
brings. postcss is a _tooling_ parser: it keeps positions, comments and raws
so a transform can print the file back out, none of which survives into a
render. What the cascade wants is rules pre-split by selector with specificity
already computed — one pass, and a small object graph thrown away when the
sheet changes.

**Rule indexing is written here too**, and it is the difference between a 3 ms
and a 300 ms first paint on a document with a framework stylesheet attached:
rules are bucketed by their rightmost simple selector, so an element tries the
handful that could possibly match rather than all of them.

**Flexbox is Yoga's.** It is already in the process, `react-x11/ntk`
re-exports it precisely so an extension does not bring a second copy, and it
is the algorithm where writing it out would be the worst trade — long, subtle,
and silently wrong when wrong. Block flow, floats and margin collapsing are
none of those things, which is where the line falls: **not "is there a
library" but "would a bug be visible".** The bridge is `setMeasureFunc` in
both directions, so a flex item made of paragraphs is measured by this engine
and a flex container inside one is a nested Yoga node.

## The seams

**Nothing is fetched. Nothing is executed.** Both are properties of the
design, not settings.

`onResource` is asked for every external thing a document refers to — an
`<img src>`, a `<link rel=stylesheet>`, an `@import` — and what it hands back
is what gets used. URLs are passed exactly as the document wrote them,
unresolved, because this has no base and the host does. A component that
silently fetched them would make "render this HTML" mean "make these
requests", which an application cannot audit and a user did not ask for. The
host already knows its proxy, its cache, its offline policy and whether this
document is trusted.

`onScript` is handed the type, the `src`, the element and its text, verbatim.
There is no parser, no sandbox and no partial evaluation, because a renderer
that half-runs a script is one nobody can reason about. An application that
wants scripting brings an engine and drives the result through the DOM
handle. Inline event attributes are left in the DOM and never invoked.

A declined resource is an ordinary state, not an error — the same call
`useDesktopCalendarEvents` makes about a desktop with no Evolution Data
Server. Images draw as a frame at their attribute size; linked stylesheets
are skipped.

## Form controls are real widgets

`<button>`, `<select>`, `<input>` and `<textarea>` are core widgets mounted as
absolutely positioned siblings of the element, at the rectangles layout
reserved for them. This is `<Flow>`'s escape hatch for a node whose body is a
form, and it exists for the same reason: **a drawn control is a picture of a
control.** It takes no focus in the window's focus order, says nothing to an
assistive technology, blinks no caret, opens no menu, and agrees with no
platform keyboard convention — and every one of those would have to be
rebuilt inside a paint pass.

Mounting the real widget also makes a form in a document consistent with the
window around it: the `<select>` drops the same menu as a `<Select>`, because
it is one.

The cost is that **the box in the flow has to be the size the widget will
be, before the widget exists**. So control metrics are measured from the same
font the widget will use and the same palette numbers (`paddingY`,
`borderWidth`, `radius`) core's own widgets read. `<textinput>` and
`<textarea>` are elements rather than components and draw no frame of their
own, so the component supplies one from those same tokens.

## Phase 1 and what is left

**Phase 1 (this change).** Everything above: the pipeline, the layout engine
(block, inline, floats, lists, tables, positioning, flex through Yoga),
selection across the whole document, hit testing and `:hover`, the two seams,
the DOM handle, real form controls, the themed user-agent stylesheet, and
streaming.

**Not implemented, and degrading rather than failing:** CSS grid falls back to
block stacking; transforms, animations, transitions, multi-column, shadows and
gradients are ignored; `position: sticky` is treated as `relative`;
`border-collapse: collapse` is drawn as the separate model with zero spacing.

**Phase 2, in the order they are worth doing:**

1. **The element scrolls itself.** Today it sizes to its content and the
   application puts it in a `<box overflow="scroll">` — which is the right
   default (the mounted controls scroll with it for free, and core's scroller
   already blits) and does not survive a document taller than X11's 16-bit
   coordinate space. `Scrollable(Node)` plus `scrollContents` for the
   server-side blit gets both that and real virtualization: only the lines
   that intersect the viewport painted, only the visible controls mounted.
   The cost it introduces is that controls must be repositioned per scroll
   step, which is why it is not the default now.
2. **Targeted restyle on `:hover`.** Today a pointer move restyles the
   document — but only when the document contains a `:hover` selector at all,
   which most do not. Restyling from the nearest common ancestor of the old
   and new hover chains is the obvious narrowing.
3. **CSS grid**, if documents that need it show up.
4. **The isolated mode**, below.

## Isolated mode

**The design, to be built next.** `<Html isolated>` renders the same document
in a child process, in a window of its own, embedded through XEmbed.

### Why it is worth having

Not for security against the _document_ — a document cannot do anything in
the first place, because nothing is fetched or executed. The reasons are
about the **cost of the renderer**, and they are real ones:

- **A pathological document cannot stall the application's event loop.**
  Layout is synchronous and a table with fifty thousand rows takes as long as
  it takes; in-process, that is a frozen UI. In a child process it is a slow
  pane in a responsive window.
- **Memory is reclaimable.** A large document's box tree, shaped runs and
  decoded images go away when the process does, rather than depending on a
  GC that never quite gets to them.
- **A crash is survivable.** A bug in the engine takes down a pane, and the
  parent can say so and offer to reload.
- **Untrusted content can be given a different policy** — a resource seam
  that answers `null` for everything, in a process with no network access at
  all.

### The mechanism

Everything needed already exists and is public:

- **Core owns the plug side.** `createRoot({ embedInto })` is renderer
  internals and stays core's; that is the same split `<TrayHost>` records.
- **`<foreign>` owns the protocol.** The reparent, the save set,
  `_XEMBED_INFO`, the synthetic ICCCM `ConfigureNotify`, layout, focus
  forwarding and handing the client back without destroying it are all core's.
- **`src/embed/` owns the lifecycle.** `ProcessHost`, and the spawn/watch/
  hand-back sequence `<Terminal>` and `<MediaPlayer>` already share. The
  runner is a third `backends.ts`-shaped thing and nothing more.

So the child is: a small entry module that calls `createRoot({ embedInto:
containerId })` and renders `<Html>` — _the same component_ — into it. The
engine does not learn anything about processes; that is the whole point of
designing it now and building it later.

### The channel

Parent to child: the source (as deltas while `partial`), the stylesheet, the
look, and DOM operations. Child to parent: `onResource` and `onScript`
requests, `onLink`, `onControlChange`, the document title, and the content
height so the parent can size the pane.

Three constraints the design has to respect, each learnt from something in
this package that got it wrong first:

- **The seams stay the parent's.** `onResource` runs in the parent process,
  because the parent is what holds the policy, the cache and the credentials.
  A request is a round trip; the child renders the frame it can and repaints
  when the answer lands, which is already exactly how a late resource behaves
  in-process.
- **The DOM cannot be shared, so it is mirrored, and the handle says so.**
  `handle.document` in isolated mode is a snapshot with an operation log, not
  the live tree. Pretending otherwise would give an application an object
  whose mutations silently do nothing — the failure mode this package refuses
  elsewhere (`write()` returning `false` on an embedded emulator rather than
  throwing or lying).
- **A missing runner is an ordinary state.** No child process, no isolated
  mode: `isolated` falls back to in-process rendering and says so, the same
  call `backend: 'auto'` makes about a missing emulator.

### Why not now

The engine is the substance and it is large; a second lifecycle and an IPC
protocol in the same change would make it unreviewable. The engine is written
so that the renderer half is already process-portable — it takes a source
string and a look, and reports back through callbacks — so the follow-up adds
a runner and a channel and changes nothing here.

[ntk#106]: https://github.com/sidorares/ntk/issues/106
