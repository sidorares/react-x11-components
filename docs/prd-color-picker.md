# PRD: `src/color-picker/` — a colour picker, and where its line with core runs

Status: **implemented** — `src/color-picker/`, `docs/components/color-picker.md`,
`examples/color-picker.tsx`. This document records the prior-art survey, the
"does it belong here" answer and the design decisions, the way
`prd-table.md` and `prd-charts.md` do; the reference page is what the
component actually takes. Unlike those two there was nothing in core to
succeed — react-x11 has never had a colour input — so this is a pure
addition, and the interesting part of the "where" question was not whether it
lands here but **which half of it does**. The other half landed in core as
`pickScreenColor()` / `useEyedropper()`
([react-x11#360](https://github.com/sidorares/react-x11/issues/360),
[#377](https://github.com/sidorares/react-x11/pull/377)).

**What changed between this design and the code**, all of it in the direction
core's answer allowed:

- `eyedropper` is `boolean | (() => Promise<string | null>)` rather than a
  function-only seam, and it defaults to **on**. Core's `useEyedropper()`
  binds the tree's connection itself and reports `supported`, so there is
  nothing for an app to wire — the button simply appears where a pick is
  possible. The function form survives as the kiosk-and-tests seam.
- `'eyedropper'` is not one of the `parts`: the button rides in the value
  row, and its own prop is the switch. One knob, not two.
- `contrast` shipped in v1 rather than waiting for a theme editor to ask —
  it is a row, and the arithmetic was already there for `readableInk`'s
  neighbours.
- `oklch()` is **not** accepted as input after all. The modern
  space-separated `rgb()`/`hsl()` are, because they are one regexp away from
  the legacy ones; OKLCH is a conversion chain in service of a value that
  could never be emitted.

## What it is

A colour input: a saturation/value field over a hue slider, an optional
alpha strip, a hex readout, and — when the app supplies them — a row of
swatches. Controlled or uncontrolled, one CSS colour string in and out.

```tsx
import { ColorPicker } from '@react-x11/components/color-picker';

<ColorPicker value={accent} onChange={(ev) => setAccent(ev.value)} />;
```

That is the whole basic setup. It buys: a draggable SV field, a hue slider,
keyboard control on both, a hex field that accepts what the user types,
theme colours, and a value that goes straight into
`style={{ backgroundColor }}` without a conversion step. Everything else —
alpha, swatches, numeric channel fields, an eyedropper, a different output
format, a popup instead of a panel — is an opt-in on the same element.

## Does it belong here?

Against the three clauses in `AGENTS.md`:

**A smaller fraction of apps need it.** Yes. Buttons, menus and dialogs are
in every application; a colour input is in editors, drawing tools, theme
editors, terminal and IDE preference panes. It is the same population that
wants `<Flow>` or `<Charts>`, not the population that wants `<box>`.

**It can be built on the public API.** Yes, and with room to spare. The
panel is `<box>`, `<text>` and three `<canvas onDraw>` panes; the popup form
is `<popup anchor grab>` behind a trigger, which is exactly what
`<DatePicker>` already does in this package. Dragging is
`ev.capturePointer()`, the same contract core's `<Slider>` uses. Nothing
here needs `registerElement` at all — see "It composes, it does not draw"
below — so, like `src/calendar/`, importing it has **no side effect at
import time**.

**It is big enough that core would pay for it.** Yes, and the weight is not
the widget — it is the colour model underneath. Core's `react-x11/style`
carries `tint`, `readableInk` and `interpolate`, and ntk parses a CSS colour
string to RGBA. Nothing anywhere converts to or from HSV, and nothing
**serializes** a colour back to a string. A picker needs both, plus hue
memory, alpha compositing for the checkerboard, and a contrast ratio if the
contrast readout ships. That is a module core has no second use for.

So: it belongs here. But the line runs through the feature, twice.

### The line, cut one: the eyedropper is not ours to implement

Sampling a pixel from anywhere on the screen is the one part of a colour
picker that cannot be built on the public API. It needs a pointer grab that
survives leaving the window and a pixel read of the **root** drawable.
`<popup grab>` gives the first — that is what makes a menu modal — but there
is no public path to the second: `ctx.getImageData` reads the context's own
target, and reaching the root means `useApp()` and a hand-written
`GetImage` against `app.X`, which is precisely "standing on internals".

The desktop-native answer is `org.freedesktop.portal.Screenshot.PickColor`
over D-Bus — it works under a compositor that would refuse a root read at
all, it draws the magnifier itself, and core already carries the portal
request/response plumbing for `<FileDialog>`. `useSessionBus()` and
`portalRequest()` are both public — but `portalRequest()` hardcodes
FileChooser's `'ssa{sv}'` signature, and `PickColor` takes no title, so the
one helper that gets the subscribe-before-invoke ordering right cannot call
it. What is missing either way is the ladder (portal → X11 fallback → "no
picker here") that `<FileDialog>` already implements once.

The design consequence, and the reason this is worth writing down: **the
eyedropper enters this component as a function prop, not as a feature.**

```tsx
<ColorPicker eyedropper={pickScreenColor} … />
```

The component ships without a screen-capture dependency, an app that has a
sampler wires it in one line, and if core later exports `pickScreenColor()`
on the same ladder as its file dialogs, the prop's default becomes that and
no app changes. This is the `AGENTS.md` cut applied verbatim — the picker is
composition over public elements, the sampler is renderer/desktop
integration — and it keeps "nothing here needs a change to core to exist"
true. **Ask core for `pickScreenColor()`; do not ask core for a picker.**
Filed as [react-x11#360](https://github.com/sidorares/react-x11/issues/360),
which proposes `pickScreenColor()` / `useEyedropper()` on the file dialogs'
ladder — and records the two reasons an app cannot do it itself today:
`portalRequest()` hardcodes FileChooser's `'ssa{sv}'` signature, so it
cannot call `Screenshot.PickColor`, and nothing public delivers the events
of a pointer grab.

### The line, cut two: the colour math, and where it lives

`src/color-picker/color.ts` starts private. It is not a shared module
(`AGENTS.md`: those exist because more than one component needs them) and
not `src/internal/` (that is the half-step for code two components share).
The promotion path is named so nobody has to re-derive it: a second consumer
moves it to `src/internal/color.ts`; apps needing it in their own surfaces
promote it to a `/color` subpath; and if core ever wants `formatColor` next
to `tint`, **the rule when core catches up applies — delete the copy, import
the export**, the way three copies of `tint` were deleted.

What it must _not_ do is re-implement what core already exports. `tint`,
`readableInk` and `interpolate` come from `react-x11/style`; this module
adds only what is missing — HSV, serialization, and a parser (see below).

## Prior art, and what it settles

[React Aria Components](https://react-aria.adobe.com/ColorPicker),
[react-colorful](https://github.com/omgovich/react-colorful),
[react-color](https://casesandberg.github.io/react-color/),
GTK's [GtkColorChooser](https://docs.gtk.org/gtk4/class.ColorChooserWidget.html),
and the pickers in Chrome DevTools and Figma.

**React Aria is the behaviour model, and its value model is the one thing to
decline.** `ColorArea`, `ColorSlider`, `ColorWheel`, `ColorField`,
`ColorSwatchPicker` and a `ColorPicker` container is the right decomposition
of the _interaction_, and its keyboard grammar (arrows step, shift ×10,
Home/End, `aria-valuetext` per axis) is what this should copy. But the value
is an opaque immutable `Color` object from `parseColor('#f00')`, which every
app must construct, thread and stringify. This package already answered that
question the other way: **a day is a `'YYYY-MM-DD'` string, not a `Date`**.
A colour is a CSS colour string.

**react-colorful is the ergonomics target and the cliff to avoid.** String
in, string out, HSVA held internally — right. But its escalation is a
_different component per format_ (`HexColorPicker`, `RgbaStringColorPicker`,
…) and alpha is a different component again, so adding alpha to a shipped
picker is a rename, not a prop. That is exactly the rewrite cliff the
continuity contract exists to prevent.

**react-color is what a picker looks like when the API is a preset list**
(Sketch, Chrome, Photoshop, Twitter…). Presets are a docs recipe, not eight
exports.

**GTK is the desktop convention this sits next to.** `GtkColorChooserWidget`
is palette-first: a grid of swatches, a custom colour behind an expander,
and an eyedropper button in the custom pane. Two things to take: a
swatches-only picker is a first-class configuration rather than a degraded
one, and the eyedropper is expected furniture on this desktop even though
the web pickers treat it as exotic.

**Figma and DevTools** settle the small stuff: the format label is a
_cycling_ control, the picker remembers the hue behind a black, and the
contrast readout belongs next to the value rather than in a separate panel.

## Goals and non-goals

### Goals

- One CSS colour string in, one out, in the spelling the app used.
- A ladder: alpha, swatches, channel fields, eyedropper, popup form and
  contrast are each one orthogonal prop on the same element.
- Drawing cost independent of the pane's pixel count — gradients are XRender
  operations, and a drag repaints a thumb, not a field.
- Keyboard parity with the pointer, and an accessible name and value on
  every axis.
- Never emit a string this renderer cannot paint.

### Non-goals

- **A colour _management_ story.** No ICC profiles, no display
  characterization. Values are sRGB; that is what X11 pixels are.
- **A palette editor.** Editing, naming, reordering or persisting swatch
  sets is the app's; `swatches` is an input, `recent` is an input.
- **A screen sampler.** See cut one — the sampler is a prop.
- **Gradient editing.** A stop list over this picker is a plausible future
  component; it is not this one, and the value type stays a colour.
- **`<Select>`-of-theme-tokens.** An app picking `$accent` from a theme is
  choosing a token, not a colour; that is a `<Select>` with swatch labels.

## The continuity contract

Each rung is one prop on the instance above it. The diff is shown, because a
rung that cannot be shown as a small diff is a design bug.

**Rung 0 — a colour.**

```tsx
<ColorPicker value={accent} onChange={(ev) => setAccent(ev.value)} />
```

**Rung 1 — uncontrolled, in a form.** `defaultValue` and `name`, the same
grammar as every other value widget; `ev.target` is the
`{ type, name, value }` descriptor form libraries destructure.

```tsx
<ColorPicker defaultValue="#3498db" name="accent" onChange={handleChange} />
```

**Rung 2 — transparency.** `alpha` adds the alpha strip and the
checkerboard, and lets 8-digit hex out. Without it, alpha is never emitted.

```tsx
<ColorPicker value={fill} onChange={…} alpha />
```

**Rung 3 — presets.** `swatches` adds a row under the panel.

```tsx
<ColorPicker value={fill} onChange={…} alpha swatches={brand.colors} />
```

**Rung 3b — a palette-only picker,** the GTK shape, from the same element:
`parts` names what is shown and in what order.

```tsx
<ColorPicker value={fill} onChange={…} swatches={brand.colors}
             parts={['swatches']} />
```

**Rung 4 — channels.** `parts` again, adding the numeric fields; the model
the fields show is the user's to cycle, and `format` fixes the _output_
spelling independently of it.

```tsx
<ColorPicker … parts={['area', 'hue', 'alpha', 'fields', 'swatches']}
             format="hsl" />
```

**Rung 5 — sampling the screen.** One prop, the seam from cut one.

```tsx
<ColorPicker … eyedropper={pickScreenColor} />
```

**Rung 6 — an expensive consumer.** `onChange` fires on every pointer step;
`onChangeEnd` fires on release and on each keyboard commit, for apps that
re-render a document per change.

```tsx
<ColorPicker … onChange={preview} onChangeEnd={(ev) => commit(ev.value)} />
```

**Rung 7 — in a toolbar rather than a sidebar.** The same props, on the
trigger form. `<ColorField>` is to `<ColorPicker>` what `<DatePicker>` is to
`<Calendar>`: the panel on a `<popup>`, behind a field that shows the swatch
and the value.

```tsx
<ColorField value={fill} onChange={…} alpha swatches={brand.colors} />
```

No rung replaces a prop from a lower one, and nothing here is a second
component you graduate to.

## Public API

### `<ColorPicker>`

| Prop           | What it does                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `value`        | The colour, controlled. Any CSS colour this package can parse.                                                                                                   |
| `defaultValue` | The colour, uncontrolled. Defaults to `#000000`.                                                                                                                 |
| `onChange`     | `(ev: ColorChangeEvent) => void`, on every step of a drag, every arrow key, every accepted edit of the fields.                                                   |
| `onChangeEnd`  | The same event, on pointer release and on keyboard commit. Omit it and `onChange` is enough.                                                                     |
| `name`         | Carried on `ev.target.name`, for form libraries.                                                                                                                 |
| `alpha`        | Show the alpha strip and emit alpha. Default false.                                                                                                              |
| `format`       | `'auto' \| 'hex' \| 'rgb' \| 'hsl'`. Default `'auto'`: emit in the spelling the incoming value used, hex when it used none.                                      |
| `swatches`     | `readonly (string \| { value, label })[]`. A row of presets.                                                                                                     |
| `recent`       | The app's recently-used list, rendered as a second row. The component stores nothing.                                                                            |
| `parts`        | Which parts appear, and in what order: `'area' \| 'hue' \| 'alpha' \| 'fields' \| 'swatches' \| 'recent' \| 'eyedropper'`. Default derived from the other props. |
| `eyedropper`   | `() => Promise<string \| null>`. Present ⇒ the eyedropper button appears. Null resolves as a cancel.                                                             |
| `contrast`     | A colour to measure the current value against; shows the ratio and its WCAG grade.                                                                               |
| `disabled`     |                                                                                                                                                                  |
| `styles`       | Per-part style overrides, the `<Table>`/`<Tree>` spelling.                                                                                                       |
| `style`        | The root box's style, as everywhere.                                                                                                                             |
| `children`     | Rendered under the panel — a "Reset" button, a note, whatever the app has.                                                                                       |
| `ref`          | `ColorPickerHandle`.                                                                                                                                             |

`ColorChangeEvent` is `WidgetChangeEvent<string>` — `type: 'change'`,
`target: { type: 'color', name, value }` — **plus a `color` field** carrying
the channels the string was built from:

```ts
interface ColorChannels {
  r: number;
  g: number;
  b: number; // 0–255
  h: number;
  s: number;
  v: number; // 0–360, 0–1, 0–1
  a: number; // 0–1
}
```

That is the answer to "some apps want channels, not a string": one event,
one extra field, no second callback and no object value type. `ev.color.h`
is the _live_ hue, which the string cannot always carry — see below.

### `<ColorField>`

Everything `<ColorPicker>` takes, plus `placeholder`, `anchor`
(`AnchorOptions`, forwarded to the popup), `open`/`defaultOpen`/
`onOpenChange`, and `format` doubling as what the trigger shows. Escape
closes and restores, Enter and Space and Down open, the popup dismisses on
window blur — all of it the behaviour `<DatePicker>` already establishes, and
the reason that file is the one to read before writing this one.

### The handle

```ts
interface ColorPickerHandle {
  focus(): void;
  readonly value: string;
  readonly channels: ColorChannels;
}
```

`<ColorField>`'s adds `open()` / `close()`, as `<DatePicker>`'s does.

### The exported vocabulary

`src/calendar/` exports its date arithmetic because an app that renders a
calendar always ends up doing a little of the same. The same holds here:

```ts
export function parseColor(value: string): ColorChannels | null;
export function formatColor(c: ColorChannels, format?: ColorFormat): string;
export function contrastRatio(a: string, b: string): number;
export const COLOR_PICKER_WIDTH: number;
export const COLOR_PICKER_HEIGHT: number;
```

`tint`, `readableInk` and `interpolate` are **not** re-exported: they are
core's, on `react-x11/style`, and a subpath of this package forwarding a core
symbol under its own name is a claim of ownership that is not true.

The two size constants exist for the same reason `CALENDAR_WIDTH` does — a
popup must be sized before its contents are laid out, and a popup that
guesses is a popup that clips.

## The value model

**A colour is a CSS colour string.** It drops into `backgroundColor`, it
survives JSON, it diffs in a git-tracked settings file, and it needs no
constructor. This follows `<Calendar>`'s day strings, and it is the single
most consequential decision in this document.

Three things follow, and each is a rule rather than an implementation
detail.

### The renderer parses less than CSS does — so the picker parses more

Measured against ntk's `cssColorStraight` (this is what actually paints):

| Value                                     | Renderer |
| ----------------------------------------- | -------- |
| `#3498db`, `#3498db80`, `#39d`            | parsed   |
| `rgb(52,152,219)`, `hsla(204,70%,53%,.5)` | parsed   |
| `rebeccapurple`                           | parsed   |
| `rgb(52 152 219 / 50%)`                   | **null** |
| `hsl(204 70% 53%)`                        | **null** |
| `oklch(70% 0.1 200)`                      | **null** |

ntk parses hex itself and hands everything else to `parse-color`, which
predates modern CSS colour syntax: space-separated components, the `/`
alpha form, `deg` units, `oklch()` and `color()` are all "not a colour".
They fail closed rather than painting garbage, but they fail.

So:

- **The picker's own parser is wider than the renderer's.** Accepting
  `hsl(204 70% 53%)` from a user's clipboard costs a regexp and is the
  normalizing behaviour a picker is _for_.
- **The picker's output is narrower than CSS.** `format` names only
  spellings this renderer paints: `hex`, legacy-comma `rgb()`/`rgba()`,
  legacy-comma `hsl()`/`hsla()`. Emitting the modern spelling would produce
  a value the app cannot paint with the renderer that produced it, which is
  an indefensible default.
- **The default is hex**, which round-trips through ntk's own hex parser and
  never touches `parse-color` at all.
- Widening the renderer's parser is an upstream issue worth filing on its
  own merits, independent of this component.

### The string is lossy, so the picker holds HSVA

Drag value to black and hue is gone; the string is `#000000` whatever the
hue slider says. Round-trip through the app's state and the picker jumps to
red the moment the user drags back up. Every string-valued picker has this
bug unless it is designed out.

The rule: the component holds `{ h, s, v, a }` as its own state, and adopts
the incoming `value` prop **only when that prop does not round-trip to the
string it last emitted.** An app echoing the value back unchanged is a
no-op; an app setting a genuinely new colour resets the model. The hue
behind a black or a grey survives the drag, and `ev.color.h` reports it even
when `ev.value` cannot.

This is testable without a display and belongs in the unit tests as a named
case, not as an incidental.

### Alpha is opt-in in both directions

Without `alpha`, the picker never emits a value with alpha and drops the
alpha of an incoming one (it still paints the swatch with it, so the user
sees what they were handed). With `alpha`, `format="hex"` emits
`#RRGGBBAA` — which ntk parses, unlike the CSS-illiterate 4-and-7-digit
forms it rejects.

## It composes, it does not draw

`src/flow/` established the question to ask: **is the feature's viewport a
transform?** A picker's is not — there is no pan, no zoom, nothing to
re-lay-out per pointer step. So this is the `<Calendar>` shape: no
`registerElement`, no JSX augmentation, no side effect at import.

That still leaves three surfaces that are pictures, and the interesting part
is that they cost nothing to paint:

- **The SV field** is three XRender operations: fill with the pure hue, a
  white→transparent linear gradient across, a black→transparent linear
  gradient down.
- **The hue strip** is one seven-stop linear gradient.
- **The alpha strip** is a checkerboard plus a transparent→colour gradient.

ntk's 2d context exposes `createLinearGradient`, `createRadialGradient` and
`createConicalGradient`, all server-side. So a 240×180 field is a handful of
protocol requests, not 43 200 pixels of JavaScript — and a hue _wheel_, if
it is ever a rung, is a conical gradient plus a radial one rather than a
different rendering strategy.

Three consequences are load-bearing:

- **The thumbs are not part of the drawing.** Each is an absolutely
  positioned sibling `<box>` with a border radius. Dragging changes two
  numbers in a style, so the damage is a 14px node — the field's `onDraw`
  does not run at all. A thumb drawn _into_ the canvas would repaint the
  gradients on every pointer motion event, which is the whole cost the
  design is avoiding.
- **`cacheKey` is what makes hue changes free too.** The field's key is
  `sv:${hue}:${w}x${h}`, the alpha strip's `alpha:${rgb}:${w}x${h}`, the hue
  strip's just its size. A repaint from an unrelated damage rect composites
  a cached surface.
- **The panes have square corners, deliberately.** ntk's rounded-rect fast
  path bails to polygon rasterization when the fill is not a plain colour —
  it is the `gradient` reason in `stats.shapes`, and `formatShapes` exists to
  make exactly this kind of silent cliff visible. A rounded pane must round
  by drawing into a cached surface once, never per repaint. Whichever way it
  goes, `stats.shapes` in the example is the check.

## Keyboard, focus and a11y

- **SV field**: arrows move 1% of the axis, shift ×10, Home/End jump the
  saturation axis, PageUp/PageDown the value axis. One tab stop.
- **Hue and alpha**: arrows step 1 (shift 10), Home/End go to the ends —
  core's `<Slider>` grammar, because that is what the desktop already
  teaches.
- **Fields and swatches**: ordinary tab stops; a swatch row is one stop with
  arrow navigation inside it, the pattern `<Calendar>`'s grid uses.
- Each axis carries `role="slider"` with an `aria-valuetext` in words
  ("hue 204 degrees", "saturation 70%") rather than a raw number, since the
  number alone is meaningless to a screen reader. The panel is a `group`
  with an accessible name. Core maps these to AT-SPI, so Orca sees the same
  thing it sees from GTK.
- `<ColorField>` restores focus to the trigger on close, and Escape closes
  without committing — `<DatePicker>`'s behaviour, not a new one.

## Testing and guards

- **Colour math is unit-tested without a display**: parse/format round
  trips per format, the renderer-parseable table above as an explicit
  fixture, HSV↔RGB round trips, hue-behind-black memory, alpha on and off,
  and the "echoing the value back is a no-op" rule.
- **Drawing is asserted as operations.** On `react-x11/test`'s mock backend
  `createLinearGradient` returns a recorder, so the tests assert the op
  sequence and the cache keys — the same way `<Flow>`'s painter is tested —
  rather than pixels.
- **Interaction** goes through the harness: drag with captured pointer,
  every key above, controlled vs uncontrolled, `onChangeEnd` firing once per
  gesture.
- **A real server once per milestone.** Gradients are the first use of
  XRender gradients anywhere in this repository, so milestone 0 is a spike
  on a real display that confirms the three panes render and reports
  `stats.shapes` — an Xvfb rig is enough.
- The repo-wide guards apply unchanged: `treeshake.test.ts` (importing the
  barrel for nothing bundles to nothing), `check-package.ts` (the
  `/color-picker` subpath), `docs.test.ts` (`docs/components/color-picker.md`
  exists and is linked), and `examples/color-picker.tsx`.

## Milestones

0. **Spike**: three panes on a real display, gradient ops confirmed,
   `stats.shapes` clean. Nothing else is worth designing around until this
   holds.
1. **Rungs 0–1**: SV field, hue slider, hex field, pointer and keyboard,
   controlled and uncontrolled, `color.ts` with the parse/format table.
2. **Rungs 2–4**: alpha, swatches, `parts`, channel fields, `format`.
3. **Rung 7**: `<ColorField>` on a popup, anchored, dismissing.
4. **Rungs 5–6**: the `eyedropper` seam and `onChangeEnd`. The upstream ask
   is already out — [react-x11#360](https://github.com/sidorares/react-x11/issues/360)
   — so this rung may land against a real `pickScreenColor()` rather than
   against a hand-rolled one.
5. **`contrast`**, if the theme-editor case still wants it by then.

## Decisions, and what is still open

Settled by building it:

- **The names** are `<ColorPicker>` (panel) and `<ColorField>` (trigger +
  popup), mirroring `<Calendar>`/`<DatePicker>` — the thing named for what it
  is, the trigger named for where it sits. React Aria's `ColorField` is the
  _hex text input_; ours is not, and the reference page says so.
- **Modern CSS input, yes; OKLCH, no.** See the note at the top.
- **`recent` is a pure input.** Persistence is the app's; a picker that
  remembered would be a store. The example keeps the list in `useState` and
  that is the whole of it.
- **`contrast` renders inside the panel**, as a part — a readout that scrolls
  away from the value it describes is worse than one more prop.

Still open:

- **A hue wheel.** `layout="wheel"` is cheap given conical gradients and is
  what a paint app expects. Reserved as a rung; nothing about the current API
  is in its way.
- **Channel fields as fields.** The value row cycles hex → rgb → hsl as one
  text field. Three numeric spinners per model is what DevTools does and is
  more typing-friendly; it is additive on `parts` when someone wants it.
- **A live preview during a pick.** Core's eyedropper has no `onPreview`
  seam yet (deliberately), so the panel cannot show the colour under the
  pointer before the click.

## Risks

- **Gradients were unproven in this repo**, and are still the part with the
  least mileage: nothing else here draws one. The tests assert the ops and
  the cache keys on the mock backend, which is not the same as pixels on a
  real server — run `npm run examples:color-picker` against a display before
  believing the panes. The fallback, if XRender gradients disappoint
  somewhere, is a cached `Pixmap` per hue: more code, same API.
- **The rounded-corner cliff** is silent by construction. It is called out
  above and checked in the example rather than left to be rediscovered.
- **The eyedropper never arrives.** If core does not ship
  `pickScreenColor()`, the prop stays app-supplied forever. That is an
  acceptable resting state — the component is complete without it — but the
  docs must not promise it.
- **Format preservation surprises somebody.** `format="auto"` echoing the
  input's spelling is the friendlier default and the less predictable one.
  The escape is one prop, and the docs example shows it.
