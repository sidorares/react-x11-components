# ColorPicker and ColorField

```jsx
import { ColorPicker, ColorField } from '@react-x11/components/color-picker';
```

A colour input: a saturation/value field over a hue slider, with alpha,
swatches, a value field and an eyedropper as opt-ins on the same element —
and the same panel on a popup behind a field.

Neither registers a host element. They are compositions of `<box>`, `<text>`,
`<textinput>` and `<canvas>`, so importing them has **no side effect at
import time at all**.

The design record is [the PRD](../prd-color-picker.md): why the panel is here
and the screen sampler is in core, why the value is a string, and what the
panes are made of.

## `<ColorPicker>`

```jsx
<ColorPicker value={accent} onChange={(ev) => setAccent(ev.value)} />
```

```jsx
<ColorPicker
  value={fill}
  onChange={(ev) => setFill(ev.value)}
  onChangeEnd={(ev) => commit(ev.value)}
  alpha
  swatches={brand.colors}
  contrast={theme.background}
/>
```

Everything is additive. Adding alpha is a prop, not a different component;
so is a palette-only picker (`parts={['swatches']}`), so is the popup form
(`<ColorField>`, which takes every prop below).

### Props

| Prop           | Type                                                | Notes                                                                                                                                                        |
| -------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `value`        | `string`                                            | Controlled. Any CSS colour this package parses — which is more than the renderer paints; see "The value" below.                                              |
| `defaultValue` | `string`                                            | Uncontrolled. Default `#000000`.                                                                                                                             |
| `onChange`     | `(ev: ColorChangeEvent) => void`                    | Every pointer step, every arrow key, every accepted edit.                                                                                                    |
| `onChangeEnd`  | `(ev: ColorChangeEvent) => void`                    | Pointer release and keyboard commit — for a consumer too expensive to run per step.                                                                          |
| `name`         | `string`                                            | Echoed on the change event, for form libraries.                                                                                                              |
| `alpha`        | `boolean`                                           | Show the alpha strip and emit alpha. Default false, in both directions: without it the picker never emits transparency it was handed.                        |
| `format`       | `'auto'` (default) \| `'hex'` \| `'rgb'` \| `'hsl'` | `'auto'` answers in the spelling the value arrived in, hex when it had none.                                                                                 |
| `swatches`     | `readonly (string \| { value, label })[]`           | Presets, as a row under the panel.                                                                                                                           |
| `recent`       | same                                                | A second row. The component stores nothing — the list is the app's.                                                                                          |
| `parts`        | `readonly ColorPickerPart[]`                        | Which parts appear and in what order: `'area'`, `'hue'`, `'alpha'`, `'fields'`, `'swatches'`, `'recent'`, `'contrast'`. Default: what the other props imply. |
| `eyedropper`   | `boolean \| (() => Promise<string \| null>)`        | Default true: the button appears wherever core can sample the screen. A function replaces the sampler.                                                       |
| `contrast`     | `string`                                            | A colour to measure against; the `'contrast'` part shows the WCAG ratio and grade.                                                                           |
| `disabled`     | `boolean`                                           |                                                                                                                                                              |
| `focusable`    | `boolean`                                           | Whether the panel takes the keyboard itself. Default true.                                                                                                   |
| `focusVisible` | `boolean`                                           | Draw the axis cursor without the focus — the other half of `focusable={false}`.                                                                              |
| `style`        | `Style \| Style[]`                                  | The root box.                                                                                                                                                |
| `children`     | `ReactNode`                                         | Rendered under the panel: a Reset button, a note.                                                                                                            |
| `ref`          | `Ref<ColorPickerHandle>`                            | See below.                                                                                                                                                   |

`COLOR_PICKER_WIDTH` and `colorPickerHeight(parts, counts)` are exported for
laying a panel out before it renders — what `<ColorField>` sizes its popup
with, and what a popup of your own would need.

### `ColorChangeEvent`

```ts
interface ColorChangeEvent extends WidgetChangeEvent<string> {
  color: ColorChannels; // { r, g, b, h, s, v, a }
}
```

`ev.value` is the string and `ev.target` is the `{ type, name, value }`
descriptor a form library destructures. `ev.color` is what the string was
built from, which is how an app that wants channels gets them without a
second callback or an object-valued `value` — and `ev.color.h` is the live
hue, which the string cannot always carry.

### `ColorPickerHandle`

```ts
interface ColorPickerHandle {
  focus(): void;
  handleKey(ev: KeyboardEvent): boolean;
  readonly value: string;
  readonly channels: ColorChannels;
}
```

`handleKey` is what `<ColorField>` uses, exactly as `<DatePicker>` feeds
`<Calendar>`: a trigger that owns the keyboard forwards keys in, and `false`
back means "not mine".

## The value

**A colour is a CSS colour string**, the way a `<Calendar>`'s day is a
`'YYYY-MM-DD'` string. It goes straight into `style={{ backgroundColor }}`,
survives JSON, and needs no constructor.

Two consequences are worth knowing before they surprise you.

**What is read is wider than what is written.** The picker parses hex (3, 4,
6 and 8 digits), `rgb()`/`rgba()` and `hsl()`/`hsla()` in both the legacy
comma syntax and the modern space-separated one, `deg`/`turn` hues, and named
colours. It emits only hex and the **legacy comma** functional forms, because
that is what this renderer can paint: ntk parses hex itself and hands the
rest to `parse-color`, to which `rgb(52 152 219 / 50%)` and `oklch(…)` are
not colours at all. Normalizing a pasted value is a thing a picker should do;
handing back a string the app cannot paint is not.

**The hue outlives the string.** Every black is hue 0 once it is written
down, so a picker that re-parsed its own value would jump to red the moment
the brightness came back up. This one holds HSVA of its own and adopts the
`value` prop only when that prop is not the string it last emitted. An app
that echoes the value back is a no-op; an app that sets a genuinely new
colour resets the model.

## The eyedropper

`eyedropper` is on by default and costs nothing where there is no sampler:
the button exists only when core's `useEyedropper().supported` says a pick is
possible ([react-x11#360](https://github.com/sidorares/react-x11/issues/360)
— the portal's `Screenshot.PickColor`, or a crosshair pointer grab on plain
X11).

A function replaces the sampler with your own:

```jsx
<ColorPicker eyedropper={async () => myOwnSampler()} … />
```

which is also how a test drives a pick without a server. A pick that resolves
`null` is a cancel and leaves the colour alone.

## Keyboard

| Key                   | What it does                                                                      |
| --------------------- | --------------------------------------------------------------------------------- |
| `←` / `→`             | Saturation, hue or opacity, depending on the focused axis.                        |
| `↑` / `↓`             | Brightness, on the field.                                                         |
| `Shift` + the above   | Ten steps at a time.                                                              |
| `Home` / `End`        | The ends of the focused axis.                                                     |
| `PageUp` / `PageDown` | Full brightness, and none.                                                        |
| `Tab`                 | Between the axes — inside `<ColorField>`, where the panel does not own the focus. |

Each axis is a `role="slider"` with an `aria-valuetext` in words ("hue 204
degrees", "saturation 77%, brightness 86%"), because the number alone means
nothing read out loud.

## `<ColorField>`

```jsx
<ColorField value={fill} onChange={(ev) => setFill(ev.value)} alpha />
```

The panel on a `<popup>`, behind a field showing the swatch and the value.
Every `<ColorPicker>` prop passes through, plus:

| Prop           | Type                      | Notes                                  |
| -------------- | ------------------------- | -------------------------------------- |
| `placeholder`  | `string`                  | Shown when there is no colour yet.     |
| `anchor`       | `Partial<AnchorOptions>`  | Where the sheet hangs. Default: below. |
| `open`         | `boolean`                 | Controlled.                            |
| `defaultOpen`  | `boolean`                 | Uncontrolled.                          |
| `onOpenChange` | `(open: boolean) => void` |                                        |

It opens on the **press**, and closes on Escape, on a second press, and when
the window loses focus — but not on a change, because a colour is chosen by
dragging and there is no moment at which the choice is obviously finished.

The popup is override-redirect and never takes focus, so the trigger keeps
the keyboard and forwards it. That is also why the panel's value row is a
readout there rather than a text field: a `<textinput>` inside a window that
cannot take focus could never be typed into.

## The colour vocabulary

Exported because an app that renders a picker ends up doing a little of the
same arithmetic, exactly as `<Calendar>` exports its dates:

```ts
parseColor(value: string): ColorChannels | null;
formatColor(c: ColorChannels, format?: ColorFormat, alpha?: boolean): string;
formatOf(value: string): ColorFormat | null;
channelsFromRgb(r, g, b, a?, hueHint?): ColorChannels;
channelsFromHsv(h, s, v, a?): ColorChannels;
channelsFromHsl(h, s, l, a?): ColorChannels;
hslOf(c: ColorChannels): { h, s, l };
rgbToHsv(r, g, b): { h, s, v };
hsvToRgb(h, s, v): { r, g, b };
opaqueHex(c: ColorChannels): string;
relativeLuminance(c: ColorChannels): number;
contrastRatio(a, b): number | null;
contrastGrade(ratio: number): 'AAA' | 'AA' | 'fail';
wrapHue(h: number): number;
```

`tint`, `readableInk` and `interpolate` are deliberately **not** here. They
are core's, on `react-x11/style`.

## What it costs to draw

The three panes are `<canvas>` nodes drawn with server-side XRender
gradients — the field is a hue fill plus two gradients, the hue strip is one
seven-stop ramp — so a 240×150 field is a handful of protocol requests rather
than 36 000 pixels of JavaScript. Each carries a `cacheKey` naming everything
its drawing reads (`sv:204:240x150`), and the thumbs are absolutely
positioned `<box>`es rather than part of the drawing, so dragging moves a
style on a 12px node and never re-runs a gradient.

The panes are square-cornered on purpose: ntk's rounded-rect fast path bails
to polygon rasterization when the fill is not a plain colour — the `gradient`
reason in `stats.shapes`. The geometry is fixed for the same family of
reasons a `<Calendar>`'s is: a popup has to be sized before its contents lay
out, and a `cacheKey` cannot name a width the pane might not have.
