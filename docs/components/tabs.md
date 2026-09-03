# Tabs

```jsx
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@react-x11/components/tabs';

<Tabs defaultValue="members">
  <TabsList>
    <TabsTrigger value="members">Members</TabsTrigger>
    <TabsTrigger value="projects">Projects</TabsTrigger>
  </TabsList>
  <TabsContent value="members">Manage your team members</TabsContent>
  <TabsContent value="projects">Manage your projects</TabsContent>
</Tabs>;
```

One visible panel at a time, switched by a strip of triggers.

The API is [Chakra UI's Tabs](https://chakra-ui.com/docs/components/tabs)
with its parts spelled flat, the way [Timeline](timeline.md) spells its own:
`Tabs.Root` is `<Tabs>`, `Tabs.Trigger` is `<TabsTrigger>`, and so on. The
vocabulary is Chakra's too — `value` / `defaultValue` / `onValueChange`, the
five variants, `size`, `orientation`, `activationMode`, `fitted`, `justify`,
`lazyMount`, `unmountOnExit` — so a snippet copied from Chakra's docs is the
same tree with the dots removed. `asChild` is the one part of the surface
deliberately absent: it exists to merge props into somebody else's DOM
element, and there is no DOM here.

`overflow` is the one prop with no counterpart there, and it is on by
default: a horizontal strip narrower than its tabs keeps the ones that fit
and drops the rest into a menu, rather than running off its own edge.

The behaviour is that of react-x11's own `<Tabs>`, **which this component
supersedes**: the keyboard model, the RTL handling and the manual activation
mode carry over, the items-array API does not — triggers and panels are
elements now, so a tab can carry a glyph, a badge, or anything else beside
its label.

It registers **no host element**. Tabs are `<box>` and `<text>`, which is
also why every part takes `style` and gets out of the way.

## Parts

| Part            | What it is                                                                        |
| --------------- | --------------------------------------------------------------------------------- |
| `Tabs`          | The root. Holds the selection, and carries everything the parts share.            |
| `TabsList`      | The strip of triggers — a single tab stop, walked with the arrows.                |
| `TabsTrigger`   | One tab. `value` names it; prose children are wrapped in `<text>`.                |
| `TabsContent`   | One panel, shown while its `value` is selected — and mounted even when it is not. |
| `TabsIndicator` | A marker that follows the selected trigger. Written into the strip; see below.    |

Every part takes `style` (`Style | Style[]`) and `data-testname`.

## Props

### `<Tabs>`

| Prop             | Type                                                       | Notes                                                                                                                                |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `value`          | `string`                                                   | The selected trigger's value. Providing it makes the tabs controlled.                                                                |
| `defaultValue`   | `string`                                                   | The initial selection, when uncontrolled. With neither prop nothing is selected — see below.                                         |
| `onValueChange`  | `(change: { value: string }) => void`                      | Chakra's details object, so a handler written for Chakra (`(e) => setValue(e.value)`) transfers unchanged.                           |
| `variant`        | `'line' \| 'subtle' \| 'enclosed' \| 'outline' \| 'plain'` | How the strip is drawn. Default `'line'`.                                                                                            |
| `size`           | `'sm' \| 'md' \| 'lg'`                                     | Trigger padding, and the type inside — which steps off the theme's own `fontSize` rather than a fixed scale. Default `'md'`.         |
| `orientation`    | `'horizontal' \| 'vertical'`                               | A vertical strip is a column beside its panel. Default `'horizontal'`.                                                               |
| `activationMode` | `'automatic' \| 'manual'`                                  | `automatic` (default) selects as the arrows move; `manual` moves focus only and commits on Enter or Space.                           |
| `fitted`         | `boolean`                                                  | Triggers share the strip equally, filling its length.                                                                                |
| `justify`        | `'start' \| 'center' \| 'end'`                             | Where the triggers sit along the strip. Default `'start'`.                                                                           |
| `overflow`       | `'menu' \| 'clip'`                                         | What a horizontal strip does with more tabs than it has room for. Default `'menu'` — see below.                                      |
| `lazyMount`      | `boolean`                                                  | Build a panel the first time its tab is selected rather than up front.                                                               |
| `unmountOnExit`  | `boolean`                                                  | Unmount a panel when its tab is deselected, giving up its state.                                                                     |
| `accent`         | `string`                                                   | The colour the selection takes — Chakra's `colorPalette`, as one colour. A `$token` resolves against the palette. Default `$accent`. |
| `ground`         | `string`                                                   | The colour behind the tabs. Default `$background`; tabs on a card want `'$surface'` — see below.                                     |
| `style`          | `Style \| Style[]`                                         | The root box. It grows to fill its container by default, the way the core widget did; `style` wins for the one that should not.      |

### `<TabsTrigger>`

| Prop       | Type      | Notes                                       |
| ---------- | --------- | ------------------------------------------- |
| `value`    | `string`  | Required. What this trigger selects.        |
| `disabled` | `boolean` | Unclickable, and skipped by the arrow keys. |

### `<TabsContent>`

| Prop    | Type     | Notes                                     |
| ------- | -------- | ----------------------------------------- |
| `value` | `string` | Required. Which trigger shows this panel. |

## Hidden panels stay mounted

By default every `<TabsContent>` mounts up front and the unselected ones are
`display: 'none'` — out of layout, out of the accessibility tree
(`aria-hidden`), but alive. That is what keeps a form half-filled on another
tab filled: switching away and back loses nothing.

The two opt-outs are Chakra's, and they live on the root because they are a
policy about the set, not about one panel:

- `lazyMount` defers a panel until the first time its tab is selected — for
  a panel that is expensive to build and may never be looked at. Once built,
  it hides rather than unmounts.
- `unmountOnExit` unmounts a panel when its tab is deselected — for a panel
  that should start fresh every time, or that holds something heavy.

The other half of "expensive panel" is `activationMode="manual"`: arrow keys
move focus without selecting, and Enter or Space commits. Automatic mode —
the default, and the way a desktop notebook behaves — selects as the arrows
move.

## Nothing is selected until something is

With neither `value` nor `defaultValue`, no trigger is selected and no panel
shows — the same call Chakra makes. There is no "first tab wins" fallback,
deliberately: the root cannot know its triggers until they mount, so a first
render that selected nobody, only to snap to the first trigger a frame
later, would be worse than asking for one line. Pass `defaultValue`.

While nothing is selected every trigger is in the tab order, since there is
no selected trigger to be the strip's one stop.

## Tabs that do not fit go in a menu

A horizontal strip narrower than its tabs keeps the ones that fit, puts a
button at its end, and drops the rest as a menu under it. Nothing to write —
`overflow` defaults to `'menu'`, and `overflow="clip"` is the way back to a
strip that simply runs off its own edge.

Three decisions inside it are worth knowing:

- **The button is a stop on the strip like any other**, drawn from the same
  chrome the triggers are. So when the selected tab is one of the ones behind
  it, the button wears the selected look — the accent marker under a `line`
  strip, the chip on a `subtle` one — and the menu draws a mark beside the row
  it stands for. That is what picking a tab out of the menu does, rather than
  displacing a tab that fitted: which tabs are on the strip is a question
  about room and nothing else, so the strip does not reshuffle itself every
  time a tab is chosen. The button also takes the strip's tab stop while it
  holds the selection, since the trigger that would normally have it is not on
  the strip.
- **The menu draws the trigger's own children**, so a tab with an
  [`<Icon>`](https://github.com/sidorares/react-x11/blob/master/docs/components.md)
  beside its label keeps both, and there is nowhere to write the label twice.
  Anything in the strip that is _not_ a `<TabsTrigger>` stays on the strip and
  is not counted — the arithmetic is about tabs. A row is announced as a
  `menuitemradio`, which is the only place a screen reader hears about a tab
  that is not on the strip to carry `role="tab"`.
- **The arrows reach the button** like any tab, and it selects nothing on the
  way past. Down opens the menu, Down and Up walk it, Enter or Space commits,
  Escape closes it.

It works off measurement, which costs a frame: a tab whose width is not known
yet — a first render, a tab just added, a label just changed — puts the strip
back to showing everything for one pass, which is what measures it, and the
pass after that is the one that decides. The strip clips while `overflow` is
`'menu'`, so that pass is a strip cut off at its edge rather than one spilling
over the panel. What is hidden is then a pure function of the measured widths
and the room, which is what keeps it from hunting.

Those same measurements size the menu. A row is the tab it stands for with the
row's padding instead of the tab's — same label, same face, same glyph — so
the sheet's size is arithmetic rather than something the popup works out about
itself, and where it lands is a number this component can see.

A `fitted` strip stops sharing its width out the moment anything is in the
menu, and that is not cosmetic: a grown trigger lays out at its share of the
strip rather than at its label, so hiding one tab would leave the rest looking
wider, and the next pass would hide another.

A **vertical** strip ignores `overflow` entirely. It runs out of room
downward, where a menu is the wrong answer.

## The keyboard walks the strip, not the markup

The strip is a single tab stop: the selected trigger takes the focus, and
the arrows rove it — wrapping at the ends, skipping disabled triggers, with
Home and End jumping to the extremes. Left/Right walk a horizontal strip,
Up/Down a vertical one.

Two decisions inside that are worth knowing:

- **The walk follows layout, not mount order.** Which trigger is "next" is
  answered by sorting the live triggers by where layout actually put them,
  so a trigger removed and re-added, or a strip reordered, cannot leave the
  arrows walking a stale order.
- **The arrows are visual, the list is logical.** In an RTL subtree the
  strip mirrors on its own (it is a plain flex row, so yoga mirrors it), and
  the _next_ tab is the one to the left. A vertical strip never mirrors —
  Up is Up.

Enter and Space are not handled here: core makes those keys the click the
trigger's own `onClick` already is, which is exactly the commit manual mode
needs.

## The five variants, and why the marks are boxes

Every variant is styled out of the box:

- **`line`** (default) — a 1px rule along the strip with a 2px accent marker
  under the selected trigger; the selected label takes the accent. Hovering a
  tab washes it the way `subtle` does, and at the same size: the label with
  the same padding round it, standing that same distance again off the panel
  edge — a `line` trigger carries the extra as padding, which is why its strip
  is a little taller than the others'. The wash is a box rather than a
  background because the strip's rule runs under the triggers, and a
  background would break the line under whichever tab the pointer was on.
- **`subtle`** — a rounded wash of the accent behind the selected label.
- **`enclosed`** — the strip is a muted chip and the selected trigger is a
  raised segment of it, filled with the `ground`.
- **`outline`** — the classic notebook: the selected trigger is a bordered
  tab with rounded shoulders (the same radius as the `enclosed` chip) that
  stays open toward the panel, so tab and panel read as one surface.
- **`plain`** — nothing at all except ink. This is the variant to pair with
  `<TabsIndicator>`, or to style entirely from the app.

The rule and the marker are absolutely positioned boxes rather than borders,
because borders here are all-edges and these marks each have to sit on one
side. The `outline` tab's shape is built from boxes too, and the reason is
worth spelling out because it is two renderer rules deep. `borderRadius` is
one number and requires a uniform border (a per-side width paints square, by
core's own rule) — so the shape wants a full rounded border with its panel
edge covered over. And a node's own border cannot be the thing covered: this
renderer paints a border _after_ the node's children, so nothing inside the
tab can lie over it (the retained tree looks right and the pixels are not —
the bug class the pixel test in `test/tabs.test.ts` exists for). The stroke
therefore lives on a _frame_ child (an inset-0 box carrying the rounded
border), and a _skirt_ sibling after it lays ground over the frame's panel
edge — the border, and the two corners that would curl toward the panel —
redrawing the straight side walls over itself. Both are painted before the
label, so a descender dips over them rather than being cut. Two more
consequences are deliberate:

- **Every selected fill is opaque.** The `subtle` wash and the `enclosed`
  chip are mixed against `ground` with the renderer's own `interpolate`
  rather than laid over it translucently — the strip's rule runs behind the
  triggers, and light through a wash would show it striking through the
  selected tab. This is why `ground` is a prop and not decoration: it is the
  colour the selected `outline`/`enclosed` trigger is filled with and the
  washes are mixed against. Tabs on the window background need nothing; tabs
  on a card take `ground="$surface"`.
- **An `enclosed` trigger carries its border always**, inked only when
  selected, so selecting a tab cannot change its size and make the strip
  jitter.

## `<TabsIndicator>` is drawn by the selected trigger

Chakra's `Tabs.Indicator` follows the selected trigger around; this one does
too, with a different mechanism. Write it as a direct child of
`<TabsList>` — it renders nothing where it stands, and the selected trigger
draws it as a box behind its own label:

```jsx
<Tabs defaultValue="a" variant="plain">
  <TabsList>
    <TabsIndicator style={{ borderRadius: 6 }} />
    <TabsTrigger value="a">One</TabsTrigger>
    <TabsTrigger value="b">Two</TabsTrigger>
  </TabsList>
  …
</Tabs>
```

Because the trigger draws it, layout owns its geometry: a resize, a font
change or an RTL mirror can never leave the marker where a trigger used to
be, and there is no measuring pass. What that costs is the slide — this
renderer cannot animate between two mounts, so the marker moves in one step
rather than gliding. Its default look is the `subtle` wash; `style` is
merged over it.

## Prose, glyphs, and what inherits

A trigger's label is prose — a bare string child is wrapped in `<text>`, so
`<TabsTrigger value="a">Members</TabsTrigger>` is the shortest thing that
works. The wrapped label is **cap-trimmed** (`textBoxTrim:
'cap-alphabetic'`), the rule every core widget label follows: a line box
carries more space over a capital than under the baseline, so an untrimmed
label centred beside an icon sits visibly low. Trimming makes the box the
letters, and centring centres what can be seen — an app that brings its own
`<text>` element as the label should apply the same trim. Panel prose is a
paragraph, not a label, and keeps its line boxes.

An element child is left exactly as written and inherits the same
ink, which changes with selection; an
[`<Icon>`](https://github.com/sidorares/react-x11/blob/master/docs/components.md)
beside the label follows it with no colour of its own, but its `size` does
not inherit and has to be named:

```jsx
<TabsTrigger value="members">
  <Icon name="dot" size={10} />
  Members
</TabsTrigger>
```

## Example

`npm run examples:tabs` renders the five variants (one with a disabled
trigger, `plain` wearing a `<TabsIndicator>`), the three sizes and a
`fitted` strip, and the behaviours: a panel that keeps its state while
hidden beside one that gives it up on `unmountOnExit`, a controlled
vertical strip in `manual` mode, and a strip of seven tabs on a width you
can drag, so the menu fills and empties as you do.
