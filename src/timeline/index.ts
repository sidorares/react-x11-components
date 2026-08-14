// <Timeline> — a vertical run of events: an indicator per step, a line
// between them, and content beside them.
//
// The API is [Chakra UI's Timeline](https://chakra-ui.com/docs/components/timeline)
// with its parts spelled flat — `Timeline.Root` is `<Timeline>`,
// `Timeline.Item` is `<TimelineItem>` — because that is how the rest of this
// package names a composition (see `/charts`), and because a namespace object
// is a module-scope mutation the tree-shaking guard would have to reason
// about. Everything else is Chakra's: the eight parts, `size`, `variant`, and
// the last item's line being off by default.
//
// It is pure composition of `<box>` and `<text>`, so there is no
// `registerElement` here and nothing for the reconciler to learn. The one
// piece that looks like it wants a custom drawing element — the line running
// down the gutter — is a 1px `<box>` positioned absolutely over the item's
// full height, which is exactly how the web does it and costs a rectangle
// instead of a paint callback.
import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useTheme } from 'react-x11';
import { interpolate, readableInk } from 'react-x11/style';
import type { Style } from 'react-x11/style';

import { hx } from './hx.js';

const h = React.createElement;

/** What `style` props here accept, matching the rest of the package. */
type StyleInput = Style | Style[];

// --- geometry ---------------------------------------------------------------
//
// Chakra's numbers, tightened for the desktop: a web timeline is read at arm's
// length down a column that owns the page, and a panel in an application
// window is not. Everything a caller is likely to want to move — the width of
// the whole thing, the space around it — is `style` on the root, so these stay
// constants rather than props.

/** The line. One pixel, at every size, the way every timeline draws it. */
const THICKNESS = 1;
/** Between the connector column and the content beside it. */
const ITEM_GAP = 12;
/** Between the rows inside one item's content. */
const CONTENT_GAP = 4;
/** Under one item's content: the run of line between two indicators. */
const STEP_GAP = 18;
/** Inside a title, between the label and whatever is set beside it. */
const TITLE_GAP = 6;
/**
 * How far an indicator clears the line it sits on.
 *
 * Drawn as an `outline`, which is painted outside the border box and never
 * seen by yoga — so the clearance cannot move the circle it surrounds, and a
 * variant that turns it off cannot change the layout either.
 */
const RING = 2;

export type TimelineSize = 'sm' | 'md' | 'lg' | 'xl';
export type TimelineVariant = 'subtle' | 'solid' | 'outline' | 'plain';

interface SizeSpec {
  /** The indicator's box, and so the diameter of its circle. */
  indicator: number;
  /** Whatever is written inside the indicator — a step number, a glyph. */
  font: number;
  /** How far the title sits off the theme's body size. */
  titleStep: number;
  /**
   * What the title drops by, so its letters line up with the middle of an
   * indicator taller than they are.
   *
   * A constant rather than a measurement: giving the title a `minHeight` of
   * the indicator would centre it exactly, and would also push the
   * description that far down for a row nothing else fills. These are
   * Chakra's own numbers, and they are what half the difference between a
   * 14px line and each circle comes to.
   */
  titleTop: number;
}

// The indicator sizes are Chakra's (16/20/24/32). The type sizes are not:
// they step off the theme's own `fontSize` rather than a fixed scale, so a
// theme that sets 16 gets a timeline in 16 instead of one that ignores it.
const SIZES: Record<TimelineSize, SizeSpec> = {
  sm: { indicator: 16, font: 10, titleStep: -2, titleTop: 0 },
  md: { indicator: 20, font: 12, titleStep: 0, titleTop: 0 },
  lg: { indicator: 24, font: 12, titleStep: 0, titleTop: 2 },
  xl: { indicator: 32, font: 14, titleStep: 0, titleTop: 6 },
};

/** What the parts of one timeline share. */
interface TimelineLook {
  variant: TimelineVariant;
  /** The indicator colour, resolved: `tint` and `readableInk` need a real
   *  colour rather than a `$token`. */
  accent: string;
  /** What the line is cleared with around an indicator — the colour behind
   *  the timeline, also resolved. */
  ground: string;
  indicator: number;
  indicatorFont: number;
  titleFont: number;
  titleTop: number;
  descriptionFont: number;
  showLastSeparator: boolean;
}

const LookContext = React.createContext<TimelineLook | null>(null);
/** Whether the item being rendered is the last one. */
const LastContext = React.createContext(false);

function useLook(part: string): TimelineLook {
  const look = React.useContext(LookContext);
  if (!look) {
    throw new Error(
      `@react-x11/components: <${part}> has to be inside a <Timeline>. ` +
        'It reads the size, the variant and the accent from it.',
    );
  }
  return look;
}

/**
 * A colour prop, resolved against the palette.
 *
 * `$token` is normally the renderer's job — it resolves one against the
 * nearest `theme` prop while painting — but `tint()` and `readableInk()` are
 * arithmetic over real colours and run here, before any of that. So the two
 * colours this component computes *from* are looked up eagerly, and every
 * other colour it uses stays a `$token` in the style.
 */
function resolveColor(
  value: string | undefined,
  theme: Record<string, unknown>,
  fallback: string,
): string {
  if (!value) return fallback;
  if (!value.startsWith('$')) return value;
  const named = theme[value.slice(1)];
  return typeof named === 'string' ? named : fallback;
}

/**
 * `accent` laid over `ground`, opaquely — a weak wash of the accent at
 * `amount`, a strong one near 1.
 *
 * The obvious spelling of a `subtle` chip is `tint(accent, 0.22)`, and it is
 * the wrong one here: the line runs *behind* every indicator, so a
 * translucent chip has it showing through the middle of the mark. Mixing
 * against the ground gives the same colour and stops the light — and it is
 * still one expression for both palettes, because the ground is what
 * differs between them.
 *
 * `interpolate` is the renderer's own colour lerp, the one that drives every
 * `transition`; it answers null for anything it cannot parse, which is the
 * same "keep going with what you were given" the rest of the style layer
 * does.
 */
function over(ground: string, accent: string, amount: number): string {
  const mixed = interpolate(ground, accent, amount);
  return typeof mixed === 'string' ? mixed : accent;
}

/**
 * Strings and numbers are only legal inside `<text>`, and every part here
 * takes prose — `<TimelineTitle>Product shipped</TimelineTitle>` is the
 * shortest thing that works and has to keep working. So a primitive child is
 * wrapped, and an element child is left exactly as it was written.
 *
 * The wrapper carries no style of its own: `color`, `fontSize`, `fontFamily`
 * and `fontWeight` inherit down the tree, so the box above it has already
 * said everything there is to say — and an app's own `<text>` child inherits
 * the same thing, which is what keeps the two forms looking alike.
 */
function withText(children: ReactNode): ReactNode {
  let wrapped = false;
  const mapped = React.Children.map(children, (child) => {
    if (typeof child !== 'string' && typeof child !== 'number') return child;
    wrapped = true;
    return hx('text', null, child);
  });
  return wrapped ? mapped : children;
}

/**
 * The part's own style, then the caller's — later entries win, which is how
 * every `style` prop in this renderer resolves precedence.
 */
function styled(base: Style, extra: StyleInput | undefined): Style[] {
  if (!extra) return [base];
  return Array.isArray(extra) ? [base, ...extra] : [base, extra];
}

// --- root -------------------------------------------------------------------

export interface TimelineProps {
  /** Indicator size, and the type that goes with it. Default `'md'`. */
  size?: TimelineSize;
  /** How an indicator is painted. Default `'solid'`. */
  variant?: TimelineVariant;
  /**
   * The colour the indicators take — Chakra's `colorPalette`, as one colour.
   * A `$token` is resolved against the palette. Default `$accent`.
   */
  accent?: string;
  /**
   * The colour behind the timeline, which is what the line is cleared with
   * around each indicator. Default `$background`; a timeline on a card wants
   * `'$surface'`.
   */
  ground?: string;
  /**
   * Keep the line running past the last indicator. Default false, as in
   * Chakra: a line that stops at the last step reads as "this is the end of
   * it", and one that carries on reads as "there is more below".
   */
  showLastSeparator?: boolean;
  /** The root `<box>`'s style — width, padding, `flexGrow`. */
  style?: StyleInput;
  'data-testname'?: string;
  children?: ReactNode;
}

/**
 * A timeline.
 *
 * ```jsx
 * <Timeline>
 *   <TimelineItem>
 *     <TimelineConnector>
 *       <TimelineSeparator />
 *       <TimelineIndicator>1</TimelineIndicator>
 *     </TimelineConnector>
 *     <TimelineContent>
 *       <TimelineTitle>Product shipped</TimelineTitle>
 *       <TimelineDescription>13th May 2021</TimelineDescription>
 *     </TimelineContent>
 *   </TimelineItem>
 * </Timeline>
 * ```
 */
export function Timeline(props: TimelineProps): ReactElement {
  // `Theme` is an interface, so it has no implicit index signature — the same
  // widening `hx.ts` documents for the `theme` prop.
  const theme = useTheme() as unknown as Record<string, unknown>;
  const size = props.size ?? 'md';
  const variant = props.variant ?? 'solid';
  const accent = resolveColor(props.accent, theme, String(theme.accent));
  const ground = resolveColor(props.ground, theme, String(theme.background));
  const showLastSeparator = props.showLastSeparator ?? false;
  const body = typeof theme.fontSize === 'number' ? theme.fontSize : 14;

  const look = React.useMemo<TimelineLook>(() => {
    const spec = SIZES[size] ?? SIZES.md;
    return {
      variant,
      accent,
      ground,
      indicator: spec.indicator,
      indicatorFont: spec.font,
      titleFont: body + spec.titleStep,
      titleTop: spec.titleTop,
      // One size for every timeline, as in Chakra: a caption is a caption,
      // and a description that grew with the indicator would make the
      // biggest timeline the one whose dates are hardest to skim.
      descriptionFont: body - 2,
      showLastSeparator,
    };
  }, [size, variant, accent, ground, showLastSeparator, body]);

  // Which item is last is a `:last-of-type` selector on the web and a walk
  // here. `Children.toArray` drops the nulls a `{cond && <TimelineItem/>}`
  // leaves behind, so "last" means the last one actually rendered.
  const items = React.Children.toArray(props.children);
  const end = items.length - 1;

  return h(
    LookContext.Provider,
    { value: look },
    hx(
      'box',
      {
        // A run of steps is a list, and saying so is what gets a screen
        // reader to announce "list, 4 items" before reading the first one.
        role: 'list',
        style: styled({ flexDirection: 'column' }, props.style),
        'data-testname': props['data-testname'],
      },
      items.map((child, i) =>
        h(
          LastContext.Provider,
          {
            key: (React.isValidElement(child) && child.key) || i,
            value: i === end,
          },
          child,
        ),
      ),
    ),
  );
}

// --- item -------------------------------------------------------------------

export interface TimelineItemProps {
  style?: StyleInput;
  'data-testname'?: string;
  children?: ReactNode;
}

/**
 * One step: a connector column and the content beside it, in whichever order
 * they are written. Putting a `<TimelineContent>` *before* the connector is
 * how the two-sided layout is built.
 */
export function TimelineItem(props: TimelineItemProps): ReactElement {
  useLook('TimelineItem');
  return hx(
    'box',
    {
      // `listitem` takes its accessible name from its contents, so the title
      // and the date below are what an assistive technology reads out.
      role: 'listitem',
      style: styled(
        {
          flexDirection: 'row',
          alignItems: 'flex-start',
          flexShrink: 0,
          gap: ITEM_GAP,
        },
        props.style,
      ),
      'data-testname': props['data-testname'],
    },
    props.children,
  );
}

// --- connector, separator, indicator ----------------------------------------

export interface TimelineConnectorProps {
  style?: StyleInput;
  'data-testname'?: string;
  children?: ReactNode;
}

/**
 * The gutter: the indicator, and the line running past it.
 *
 * `alignSelf: 'stretch'` is what makes it as tall as the item however tall
 * the content beside it turns out to be, which is what the separator measures
 * itself against.
 *
 * Which *side* it lands on is nobody's decision here: `<TimelineItem>` is a
 * plain flex row, so an RTL subtree mirrors it and the marks end up on the
 * right, where an RTL reader starts. That is the reason there is no `side`
 * prop — `direction` already says this, and a second way to say it is a
 * second thing that can disagree with the first.
 */
export function TimelineConnector(props: TimelineConnectorProps): ReactElement {
  useLook('TimelineConnector');
  return hx(
    'box',
    {
      style: styled(
        { alignSelf: 'stretch', alignItems: 'center', flexShrink: 0 },
        props.style,
      ),
      'data-testname': props['data-testname'],
    },
    props.children,
  );
}

export interface TimelineSeparatorProps {
  style?: StyleInput;
  'data-testname'?: string;
}

/**
 * The line down the gutter.
 *
 * It spans the item's full height and the indicator is painted over it,
 * rather than being two stubs above and below — that is the arrangement that
 * needs no arithmetic about where the indicator ends, and it is why the
 * indicator carries a `ground`-coloured ring: the ring is what cuts the line.
 *
 * `zIndex: -1` rather than an ordering rule: Chakra's snippets write the
 * separator before the indicator, but a reader who writes it after should get
 * the same picture, and paint order is otherwise document order.
 */
export function TimelineSeparator(
  props: TimelineSeparatorProps,
): ReactElement | null {
  const look = useLook('TimelineSeparator');
  const last = React.useContext(LastContext);
  if (last && !look.showLastSeparator) return null;
  return hx('box', {
    style: styled(
      {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: THICKNESS,
        // `start` rather than `left`, so an RTL timeline puts its gutter on
        // the other side without anything here knowing which way it reads.
        start: Math.round((look.indicator - THICKNESS) / 2),
        backgroundColor: '$border',
        zIndex: -1,
      },
      props.style,
    ),
    'data-testname': props['data-testname'],
  });
}

export interface TimelineIndicatorProps {
  /** Overrides the timeline's `variant` for this step alone. */
  variant?: TimelineVariant;
  /** Overrides the timeline's `accent` for this step alone — a green tick
   *  for what is done, the danger colour for what failed. `$token` allowed. */
  accent?: string;
  /** The ink inside. Default: the readable one for the fill. */
  color?: string;
  style?: StyleInput;
  'data-testname'?: string;
  children?: ReactNode;
}

/**
 * The mark on the line: a filled circle by default, with a step number, a
 * glyph or nothing inside it.
 *
 * An `<Icon>` in here needs no colour of its own — `color` inherits down the
 * tree and a `mono` canvas resolves its ink the same way `<text>` does — but
 * it does need a `size`, which does not inherit.
 */
export function TimelineIndicator(props: TimelineIndicatorProps): ReactElement {
  const look = useLook('TimelineIndicator');
  const theme = useTheme() as unknown as Record<string, unknown>;
  const variant = props.variant ?? look.variant;
  const accent =
    props.accent === undefined
      ? look.accent
      : resolveColor(props.accent, theme, look.accent);

  // The ink on a filled indicator. The palette has already answered this for
  // its own accent (`accentText`, itself derived), so ask it rather than
  // deriving a second answer that could disagree; a colour the app brought is
  // measured the same way core measures one.
  const onAccent =
    accent === theme.accent
      ? String(theme.accentText)
      : readableInk(accent, [String(theme.text), String(theme.background)]);

  const paint: Style =
    variant === 'solid'
      ? { backgroundColor: accent, color: props.color ?? onAccent }
      : variant === 'subtle'
        ? {
            backgroundColor: over(look.ground, accent, 0.22),
            color: props.color ?? '$text',
          }
        : variant === 'outline'
          ? {
              backgroundColor: look.ground,
              borderWidth: 1,
              borderColor: over(look.ground, accent, 0.55),
              color: props.color ?? '$text',
            }
          : // plain: no chip, but still opaque. The line runs *behind* every
            // indicator, and a transparent one would have it struck through
            // whatever is inside — which is the one thing a tick in a
            // timeline must not look like.
            { backgroundColor: look.ground, color: props.color ?? '$text' };

  return hx(
    'box',
    {
      style: styled(
        {
          width: look.indicator,
          height: look.indicator,
          borderRadius: look.indicator / 2,
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          fontSize: look.indicatorFont,
          fontWeight: 'bold',
          // The clearance around the mark. An explicit `outlineWidth` draws
          // the ring whether or not anything is focused, which is what makes
          // it usable as something other than a focus ring.
          outlineWidth: RING,
          outlineColor: look.ground,
          outlineOffset: 0,
          ...paint,
        },
        props.style,
      ),
      'data-testname': props['data-testname'],
    },
    withText(props.children),
  );
}

// --- content ----------------------------------------------------------------

export interface TimelineContentProps {
  style?: StyleInput;
  'data-testname'?: string;
  children?: ReactNode;
}

/**
 * What the step says. Its bottom padding is the run of line between this
 * indicator and the next, so the gutter's length is decided by the content
 * beside it rather than by a height anyone has to name — and the last item
 * has none, which is what stops a timeline ending in a gap.
 */
export function TimelineContent(props: TimelineContentProps): ReactElement {
  useLook('TimelineContent');
  const last = React.useContext(LastContext);
  return hx(
    'box',
    {
      style: styled(
        {
          flexDirection: 'column',
          flexGrow: 1,
          flexShrink: 1,
          gap: CONTENT_GAP,
          paddingBottom: last ? 0 : STEP_GAP,
        },
        props.style,
      ),
      'data-testname': props['data-testname'],
    },
    withText(props.children),
  );
}

export interface TimelineTitleProps {
  style?: StyleInput;
  'data-testname'?: string;
  children?: ReactNode;
}

/**
 * The step's heading. A row, so a badge or a timestamp can sit beside the
 * label, dropped by whatever it takes to line its letters up with the middle
 * of the indicator at this size.
 */
export function TimelineTitle(props: TimelineTitleProps): ReactElement {
  const look = useLook('TimelineTitle');
  return hx(
    'box',
    {
      style: styled(
        {
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: TITLE_GAP,
          marginTop: look.titleTop,
          fontSize: look.titleFont,
          fontWeight: 'bold',
          color: '$text',
        },
        props.style,
      ),
      'data-testname': props['data-testname'],
    },
    withText(props.children),
  );
}

export interface TimelineDescriptionProps {
  style?: StyleInput;
  'data-testname'?: string;
  children?: ReactNode;
}

/** The quiet line under the title: a date, a name, a status. */
export function TimelineDescription(
  props: TimelineDescriptionProps,
): ReactElement {
  const look = useLook('TimelineDescription');
  return hx(
    'box',
    {
      style: styled(
        {
          flexDirection: 'column',
          fontSize: look.descriptionFont,
          color: '$textMuted',
        },
        props.style,
      ),
      'data-testname': props['data-testname'],
    },
    withText(props.children),
  );
}
