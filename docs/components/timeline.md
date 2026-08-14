# Timeline

```jsx
import {
  Timeline,
  TimelineItem,
  TimelineConnector,
  TimelineSeparator,
  TimelineIndicator,
  TimelineContent,
  TimelineTitle,
  TimelineDescription,
} from '@react-x11/components/timeline';

<Timeline>
  <TimelineItem>
    <TimelineConnector>
      <TimelineSeparator />
      <TimelineIndicator>1</TimelineIndicator>
    </TimelineConnector>
    <TimelineContent>
      <TimelineTitle>Product shipped</TimelineTitle>
      <TimelineDescription>13th May 2021</TimelineDescription>
    </TimelineContent>
  </TimelineItem>
</Timeline>;
```

A vertical run of events — a delivery, a deploy, an audit log, a wizard's
progress: an indicator per step, a line between them, and content beside them.

The API is [Chakra UI's Timeline](https://chakra-ui.com/docs/components/timeline)
with its parts spelled flat: `Timeline.Root` is `<Timeline>`, `Timeline.Item`
is `<TimelineItem>`, and so on for all eight. A snippet copied from Chakra's
docs is otherwise the same tree, `size` and `variant` included.

It registers **no host element**. A timeline is `<box>` and `<text>`, which is
also why every part takes `style` and gets out of the way — the composition is
the API, and an app that wants a step to look like something else renders that
something else inside `<TimelineContent>`.

## Parts

| Part                  | What it is                                                                             |
| --------------------- | -------------------------------------------------------------------------------------- |
| `Timeline`            | The root. Carries `size`, `variant`, `accent`, `ground`, and knows which item is last. |
| `TimelineItem`        | One step: a connector and the content beside it, in whichever order they are written.  |
| `TimelineConnector`   | The gutter — as tall as the item, whatever the content beside it turns out to be.      |
| `TimelineSeparator`   | The line down the gutter. Renders nothing in the last item unless `showLastSeparator`. |
| `TimelineIndicator`   | The mark on the line: a circle with a number, a glyph, or nothing.                     |
| `TimelineContent`     | What the step says. Its bottom padding is the run of line to the next indicator.       |
| `TimelineTitle`       | The heading. A row, so a badge or a time can sit beside the label.                     |
| `TimelineDescription` | The quiet line under it: a date, a name, a status.                                     |

Every part takes `style` (`Style | Style[]`), `data-testname`, and children.

## Props

### `<Timeline>`

| Prop                | Type                                          | Notes                                                                                                                                |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `size`              | `'sm' \| 'md' \| 'lg' \| 'xl'`                | The indicator (16 / 20 / 24 / 32px) and the type beside it. Default `'md'`.                                                          |
| `variant`           | `'subtle' \| 'solid' \| 'outline' \| 'plain'` | How an indicator is painted. Default `'solid'`.                                                                                      |
| `accent`            | `string`                                      | The colour the indicators take — Chakra's `colorPalette`, as one colour. A `$token` resolves against the palette. Default `$accent`. |
| `ground`            | `string`                                      | The colour behind the timeline, which is what the line is cleared with around each indicator. Default `$background`; see below.      |
| `showLastSeparator` | `boolean`                                     | Keep the line running past the last indicator. Default false.                                                                        |
| `style`             | `Style \| Style[]`                            | The root box — width, padding, `flexGrow`.                                                                                           |
| `data-testname`     | `string`                                      | For `react-x11/test` queries.                                                                                                        |

### `<TimelineIndicator>`

| Prop      | Type              | Notes                                                                                     |
| --------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `variant` | `TimelineVariant` | Overrides the timeline's, for this step alone.                                            |
| `accent`  | `string`          | Overrides the timeline's accent — `$success` for what is done, `$danger` for what failed. |
| `color`   | `string`          | The ink inside. Default: the readable one for the fill.                                   |

## The line runs behind the mark

`<TimelineSeparator>` is one absolutely-positioned 1px `<box>` spanning the
**whole item**, not two stubs above and below the indicator. That is what
makes the gutter's length a consequence of the content beside it rather than
arithmetic anyone has to do: `<TimelineContent>` carries the gap under a step
as bottom padding, the connector stretches to the item, and the line follows.

Two things fall out of it, and both are why the indicator is drawn the way it
is:

- **The mark is painted over the line, and cuts it with a ring.** The ring is
  an `outline` in the `ground` colour — outlines are painted outside the border
  box and are never seen by yoga, so the clearance cannot move the circle.
  Ordering is not what decides which paints first: the separator carries
  `zIndex: -1`, so writing it before the indicator (as Chakra's snippets do) or
  after gives the same picture.
- **Every variant's chip is opaque**, `plain` included. The obvious spelling of
  a `subtle` chip is the accent at 22% opacity, and it is the wrong one here:
  the line would show straight through the middle of the mark. The wash is
  mixed against `ground` instead — same colour, no light through it.

Which makes `ground` the one prop worth knowing about: it is not decoration,
it is the colour those two effects are cut with. A timeline on the window's
own background needs nothing; a timeline on a card takes `ground="$surface"`.

## The last step is the end of the list

By default the last item draws no line and reserves no gap under itself — the
same default Chakra has, and for the same reason: a line that stops at the
last indicator reads as "that is all of it", and one that carries on reads as
"there is more below". `showLastSeparator` is the second reading, for a
timeline that is still running or is scrolled.

Which item is last is `:last-of-type` on the web and a walk over the children
here. `React.Children.toArray` drops the nulls a `{done && <TimelineItem/>}`
leaves behind, so "last" means the last item actually rendered.

## Prose, glyphs, and what inherits

Every part wraps a string or number child in `<text>`, because strings are
only legal inside one and `<TimelineTitle>Product shipped</TimelineTitle>` has
to keep working. An element child is left exactly as written.

The wrapper carries no style of its own, and neither does it need to: `color`,
`fontSize`, `fontFamily` and `fontWeight` inherit down the tree, so an app's
own `<text>` inside a title is set the same as the wrapped one. An
[`<Icon>`](https://github.com/sidorares/react-x11/blob/master/docs/components.md)
in an indicator inherits its ink the same way — a `mono` canvas resolves its
colour exactly as `<text>` does — but **`size` does not inherit** and has to be
named:

```jsx
<TimelineIndicator accent="$success">
  <Icon name="check" size={12} />
</TimelineIndicator>
```

## Sizes are Chakra's; the type follows the theme

The four indicator diameters are Chakra's. The type is not on a scale of its
own: the title is the theme's `fontSize` (a step down at `sm`) and the
description is two under it, so a theme that sets 16px gets a timeline in 16px
rather than one that ignores it. The title also drops by a couple of pixels at
`lg` and `xl` so its letters line up with the middle of a taller circle.

## Example

`npm run examples:timeline` renders a live release pipeline — the stage that
is running, the ones that are done, and one that failed, each choosing its own
variant and accent — beside galleries of the four sizes and the four variants.
