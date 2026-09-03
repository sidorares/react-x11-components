// <Tabs> — one visible panel at a time, switched by a strip of triggers.
//
// The API is [Chakra UI's Tabs](https://chakra-ui.com/docs/components/tabs)
// with its parts spelled flat — `Tabs.Root` is `<Tabs>`, `Tabs.Trigger` is
// `<TabsTrigger>` — because that is how this package names a composition (see
// `/timeline` and `/charts`). The vocabulary is Chakra's too: `value` /
// `defaultValue` / `onValueChange({ value })`, the five variants (`line`,
// `subtle`, `enclosed`, `outline`, `plain`), `size`, `orientation`,
// `activationMode`, `fitted`, `justify`, `lazyMount` and `unmountOnExit` — so
// a snippet copied from Chakra's docs is the same tree with the dots removed.
// `asChild` is the one part of the surface deliberately absent: it exists to
// merge props into somebody else's DOM element, and there is no DOM here.
//
// `overflow` is the one prop with no counterpart there. A horizontal strip
// narrower than its tabs keeps the ones that fit and drops the rest into a
// menu at its end rather than running off its own edge — on by default,
// because a strip cut off mid-label is nobody's intention. It is the one
// thing here that has to measure, and `useOverflow` below is where that and
// its consequences live.
//
// The behaviour is core's `<Tabs>` — the widget this one supersedes: a single
// tab stop with roving focus, arrows that wrap and skip disabled triggers,
// Home/End, visual arrows in an RTL strip, and `activationMode="manual"` for
// a panel too expensive to build on every keystroke.
//
// It is pure composition of `<box>` and `<text>`, so there is no
// `registerElement` here and nothing for the reconciler to learn. The line
// under a `line` strip, the marker on the selected trigger, the chip behind
// an `enclosed` strip — each is a `<box>`, positioned absolutely where it has
// to sit on one edge, because borders alone cannot say "this side only" and a
// box can.
import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Icon, useDirection, useTheme } from 'react-x11';
import type { DrawnNode, KeyboardEvent } from 'react-x11';
import { interpolate } from 'react-x11/style';
import type { Style, StyleProperties } from 'react-x11/style';
import {
  XK_DOWN,
  XK_END,
  XK_ESCAPE,
  XK_HOME,
  XK_LEFT,
  XK_RETURN,
  XK_RIGHT,
  XK_UP,
} from 'react-x11/keysyms';

import { afterLayout, cancelAfterLayout } from '../internal/timers.js';
import { useDismissOnWindowBlur } from '../internal/widget.js';
import { hx } from './hx.js';

const h = React.createElement;

/** What `style` props here accept, matching the rest of the package. */
type StyleInput = Style | Style[];

/**
 * `'@supports transparency'` is a real style block — react-x11 answers it
 * from whether the display gave the window an ARGB visual — but its `Style`
 * type models only the `@width`/`@height` size queries and the `:state`
 * blocks. Spelled out here rather than by augmenting `StyleBlocks` globally,
 * for the reason `<DatePicker>` gives where it does the same: this package
 * should not quietly widen what type-checks in an app that merely installs
 * it.
 */
type SupportsStyle = Style & {
  '@supports transparency'?: StyleProperties;
};

// --- geometry ---------------------------------------------------------------

/** The selected trigger's marker in the `line` variant. */
const INDICATOR = 2;
/** The strip's own line in the `line` and `outline` variants. */
const RULE = 1;
/** Inside a trigger, between a glyph and the label beside it. */
const TRIGGER_GAP = 6;
/** Between a strip and its panel. */
const PANEL_GAP = 8;
/** The `enclosed` strip's chip, and an `outline` tab's shoulders — one
 *  radius, so the two variants agree about how round this notebook is. */
const CORNER = 6;

/** The rounding on everything that is a wash rather than a tab: the `subtle`
 *  fill, the `line` strip's hover, an `enclosed` trigger, a menu row. */
const WASH_CORNER = 4;
/** The gap the overflow menu leaves between two rows. Read twice: once to
 *  lay the sheet out, and once to work out how tall it comes to. */
const MENU_ROW_GAP = 1;
/** The overflow menu's sheet: a hairline where it meets the desktop, as the
 *  other popups out here use, and the inset that makes a row read as a pill
 *  on the sheet rather than a band across it. */
const SHEET_BORDER = 1;
const SHEET_PAD = 4;
/** A menu row is narrower than a tab is tall — it is a list entry, not a
 *  target on a strip — so it takes its own padding rather than the size's. */
const MENU_ROW_PX = 10;
const MENU_ROW_PY = 7;
/** So a menu of one short label is still a menu rather than a chip. */
const MENU_MIN_WIDTH = 140;

export type TabsVariant = 'line' | 'subtle' | 'enclosed' | 'outline' | 'plain';
export type TabsSize = 'sm' | 'md' | 'lg';
export type TabsOverflow = 'menu' | 'clip';

/**
 * Between two triggers on the strip — none in `outline`, where the tabs meet
 * shoulder to shoulder. Read twice: once to lay the strip out, and once by
 * the overflow arithmetic, which has to add up to the same number the strip
 * did or it will fit one tab too many.
 */
function stripGap(variant: TabsVariant): number {
  return variant === 'outline' ? 0 : 2;
}

interface SizeSpec {
  /** Horizontal padding inside a trigger. */
  px: number;
  /** Vertical padding inside a trigger. */
  py: number;
  /** How far the label sits off the theme's body size. */
  step: number;
}

// Chakra's proportions, and looser than a first guess would make them: the
// labels are cap-trimmed, so `py` is the *whole* visible gap over the caps
// and under the baseline — padding sized for an untrimmed line box reads as
// cramped once the box is the letters. The type steps off the theme's own
// `fontSize` rather than a fixed scale, so a theme that sets 16 gets tabs in
// 16 (the same call `/timeline` makes).
const SIZES: Record<TabsSize, SizeSpec> = {
  sm: { px: 12, py: 8, step: -1 },
  md: { px: 16, py: 10, step: 0 },
  lg: { px: 20, py: 12, step: 1 },
};

// --- shared state -----------------------------------------------------------

/** One trigger, as the keyboard sees it. */
interface TriggerEntry {
  node: DrawnNode;
  disabled: boolean;
}

/** What the parts of one `<Tabs>` share. */
interface TabsLook {
  variant: TabsVariant;
  vertical: boolean;
  manual: boolean;
  fitted: boolean;
  justify: 'start' | 'center' | 'end' | undefined;
  /** What a horizontal strip does with more tabs than it has room for. */
  overflow: TabsOverflow;
  /** The marker colour, resolved: `interpolate` mixes real colours, not
   *  `$token`s. */
  accent: string;
  /** The colour behind the tabs — what an `enclosed` or `outline` selected
   *  trigger is filled with, also resolved. */
  ground: string;
  /** The body ink, resolved, for the washes mixed from it. */
  text: string;
  font: number;
  px: number;
  py: number;
  selected: string | undefined;
  focused: string | null;
  select(value: string): void;
  setFocused(value: string | null): void;
  /** The live trigger registry the keyboard walks. Order is irrelevant —
   *  the walk sorts by where layout actually put each trigger. */
  triggers: Map<string, TriggerEntry>;
  everSelected(value: string): boolean;
  lazyMount: boolean;
  unmountOnExit: boolean;
}

const LookContext = React.createContext<TabsLook | null>(null);

/**
 * What the strip tells the triggers inside it — the two things it knows and
 * the shared look does not.
 *
 * `indicator` is the `<TabsIndicator>` written into the strip, which the
 * *selected trigger* is what draws; `null` when there is none.
 *
 * `grow` is whether a `fitted` strip is currently letting its triggers fill
 * it. It stops while anything is in the overflow menu, and that is not a
 * cosmetic call: a grown trigger lays out at its share of the strip rather
 * than at its label, and the share is what the overflow arithmetic would
 * then measure — hide one tab, the rest grow into the space it left, and the
 * next pass reads them as too wide and hides another.
 */
interface TabsStrip {
  indicator: TabsIndicatorProps | null;
  grow: boolean;
}

const StripContext = React.createContext<TabsStrip | null>(null);

function useLook(part: string): TabsLook {
  const look = React.useContext(LookContext);
  if (!look) {
    throw new Error(
      `@react-x11/components: <${part}> has to be inside a <Tabs>. ` +
        'It reads the selected value, the variant and the size from it.',
    );
  }
  return look;
}

/**
 * A colour prop, resolved against the palette — `$token` is normally the
 * renderer's job, but `interpolate()` is arithmetic over real colours and
 * runs here, before any of that. Same helper as `/timeline`'s.
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
 * `accent` laid over `ground`, opaquely — a weak wash at low `amount`.
 * Opaque rather than translucent for the same reason `/timeline` mixes: a
 * wash sits over the strip's own chrome, and light through it would show the
 * rule running behind a selected trigger.
 */
function over(ground: string, accent: string, amount: number): string {
  const mixed = interpolate(ground, accent, amount);
  return typeof mixed === 'string' ? mixed : accent;
}

/**
 * A single-line label's box trimmed to its letters — core's `capTrim`, the
 * rule every core widget label follows (`labelContent` in
 * `components/theme.js`). A line box is the font's ascent plus descent plus
 * line gap, and the space over a capital differs from the space under the
 * baseline by `(ascent - capHeight) - descent` — so a centred untrimmed
 * label sits visibly low beside the icon centred on its own middle. Trimming
 * makes the box *be* the letters, and centring centres what can be seen.
 * Labels only: the icon is a `<canvas>` and panel prose is a paragraph,
 * and neither wants it.
 */
const CAP_TRIM: Style = { textBoxTrim: 'cap-alphabetic' };

/**
 * Strings and numbers are only legal inside `<text>`, and a trigger's label
 * is prose — `<TabsTrigger value="a">Members</TabsTrigger>` is the shortest
 * thing that works and has to keep working. A primitive child is wrapped; an
 * element child is left exactly as written, and inherits the same ink.
 */
function withText(children: ReactNode, style?: Style): ReactNode {
  let wrapped = false;
  const mapped = React.Children.map(children, (child) => {
    if (typeof child !== 'string' && typeof child !== 'number') return child;
    wrapped = true;
    return hx('text', style ? { style } : null, child);
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

/**
 * The hover fill on a `line` strip — the wash a `subtle` trigger wears, on
 * the variant whose selected mark is a rule rather than a fill.
 *
 * Two things about it are deliberate and neither is obvious.
 *
 * **It is the size a `subtle` trigger's fill is** — the label with the same
 * padding round it — and it keeps that same distance again off the panel
 * edge, which is what {@link railGap} adds to a `line` trigger's padding to
 * make room for. The gap is not decoration: the strip's rule runs *under*
 * its triggers, so a fill over the whole box would take a bite out of that
 * line for exactly the width of whatever the pointer was on, and one that
 * merely cleared the rule would read as a block resting on it. Which is also
 * why it is a box and not a `backgroundColor` — a background fills the box
 * it is on, and this must not.
 *
 * And the hover that raises it is **state**, not a `:hover` block. `:hover`
 * lights the node under the pointer and its ancestors (react-x11's
 * `_updateHover`), and this box is the label's *sibling* — so a wash that
 * styled itself would go out every time the pointer crossed a letter.
 */
function hoverWash(look: TabsLook): ReactElement {
  const gap = railGap(look);
  return hx('box', {
    key: 'wash',
    style: [
      {
        position: 'absolute',
        top: 0,
        start: 0,
        borderRadius: WASH_CORNER,
        backgroundColor: '$surfaceHover',
      },
      look.vertical ? { bottom: 0, end: gap } : { bottom: gap, end: 0 },
    ],
  });
}

/**
 * The air a `line` trigger keeps between its wash and the strip's rule, and
 * therefore the padding it carries beyond the label's own on that one side.
 * It is the label's padding on the axis the rule crosses, so that the wash's
 * two distances — text to its edge, its edge to the line — come out the same.
 *
 * `0` for every other variant: they have no wash to stand off the rule, and
 * an `outline` tab's fill is *supposed* to reach it.
 */
function railGap(look: TabsLook): number {
  if (look.variant !== 'line') return 0;
  return look.vertical ? look.px : look.py;
}

/** What a stop on the strip is, as far as its looks are concerned. */
interface TabState {
  selected: boolean;
  disabled: boolean;
  hovered: boolean;
  /** A `fitted` strip is letting its stops fill it. */
  grow: boolean;
}

/** A stop's own style, and the boxes drawn around its label. */
interface TabChrome {
  /** The box's style, under whatever the caller merges over it. */
  style: Style;
  /** Written **before** the label, so a descender that dips below the
   *  baseline paints over them rather than being cut. */
  behind: ReactNode;
  /** Written after it: the `line` marker rides the panel edge, over the
   *  strip's rule. */
  after: ReactNode;
}

/**
 * Everything a stop on the strip looks like, per variant.
 *
 * Shared because the strip has two kinds of stop and they have to be
 * indistinguishable: a `<TabsTrigger>`, and the overflow button, which wears
 * the selected look whenever the tab that is selected is one of the ones it
 * is holding. Two copies of this switch would drift on the first variant
 * anybody touched.
 *
 * Each selected state is opaque where it has to cover the strip's rule, and
 * every ink change is a `$token` so a `theme` prop above still wins.
 */
function tabChrome(
  look: TabsLook,
  indicator: TabsIndicatorProps | null,
  state: TabState,
): TabChrome {
  const { selected, disabled, hovered, grow } = state;
  const vertical = look.vertical;
  const variantStyle: Style[] = [];
  const hover: Style = {};
  switch (look.variant) {
    case 'line':
    case 'plain':
      Object.assign(hover, { ':hover': { color: '$text' } });
      break;
    case 'subtle':
      variantStyle.push({ borderRadius: WASH_CORNER });
      if (selected)
        variantStyle.push({
          backgroundColor: over(look.ground, look.accent, 0.15),
        });
      else
        Object.assign(hover, {
          ':hover': { backgroundColor: '$surfaceHover' },
          ':active': { backgroundColor: '$surfaceActive' },
        });
      break;
    case 'enclosed':
      // Every trigger carries the border so selecting one cannot change its
      // size — only the selected one inks it.
      variantStyle.push({
        borderRadius: WASH_CORNER,
        borderWidth: 1,
        borderColor: 'transparent',
      });
      if (selected)
        variantStyle.push({
          backgroundColor: look.ground,
          borderColor: '$border',
        });
      else Object.assign(hover, { ':hover': { color: '$text' } });
      break;
    case 'outline':
      if (selected)
        variantStyle.push({
          // The fill is the ground, so the tab and its panel read as one
          // surface — and it is what covers the strip's rule underneath.
          // Rounded so the fill stays inside the frame's shoulders, but
          // deliberately **borderless**: this renderer paints a node's
          // border *after* its children (`Node.paint` — children, then
          // `_paintBorder`), so a border here could never be opened by a
          // child laid over it. The frame below carries the stroke instead.
          backgroundColor: look.ground,
          borderRadius: CORNER,
        });
      else
        Object.assign(hover, {
          ':hover': { backgroundColor: '$surfaceHover' },
        });
      break;
  }

  // The `line` strip's hover — see {@link hoverWash} for why it is a box and
  // why `hovered` is state rather than a `:hover` block.
  const wash =
    look.variant === 'line' && hovered && !disabled ? hoverWash(look) : null;

  // The `outline` tab's shape, from two stacked children — a shape the style
  // vocabulary cannot say in one box. `borderRadius` is one number and
  // requires a uniform border, so "rounded shoulders, open bottom" is drawn
  // as: a *frame* (inset-0 box carrying the full rounded border) and, after
  // it, a *skirt* (a strip of ground over the frame's panel edge, covering
  // the border and the two corners that would curl toward the panel, and
  // redrawing the straight side walls over itself). The skirt can cover the
  // frame only because they are siblings — a node's own border paints over
  // its children, which is why the frame is not the trigger's border.
  const outlineShape =
    look.variant === 'outline' && selected
      ? [
          hx('box', {
            key: 'frame',
            style: {
              position: 'absolute',
              top: 0,
              bottom: 0,
              start: 0,
              end: 0,
              borderWidth: 1,
              borderColor: '$border',
              borderRadius: CORNER,
            },
          }),
          hx('box', {
            key: 'skirt',
            style: [
              {
                position: 'absolute',
                backgroundColor: look.ground,
                borderColor: '$border',
              },
              vertical
                ? {
                    top: 0,
                    bottom: 0,
                    end: 0,
                    width: CORNER + 1,
                    borderTopWidth: 1,
                    borderBottomWidth: 1,
                  }
                : {
                    start: 0,
                    end: 0,
                    bottom: 0,
                    height: CORNER + 1,
                    borderStartWidth: 1,
                    borderEndWidth: 1,
                  },
            ],
          }),
        ]
      : null;

  // The selected marker in the `line` variant: a 2px box riding the panel
  // edge of the stop, over the strip's 1px rule.
  const marker =
    look.variant === 'line'
      ? hx('box', {
          style: [
            {
              position: 'absolute',
              backgroundColor: selected ? look.accent : 'transparent',
              transition: { backgroundColor: 100 },
            },
            vertical
              ? { top: 0, bottom: 0, end: 0, width: INDICATOR }
              : { left: 0, right: 0, bottom: 0, height: INDICATOR },
          ],
        })
      : null;

  // A `<TabsIndicator>` in the strip is drawn here, by the selected stop,
  // behind its label. Layout owns its geometry — see the part's own comment.
  const chip =
    indicator && selected
      ? hx('box', {
          key: 'chip',
          style: styled(
            {
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              right: 0,
              zIndex: -1,
              borderRadius: WASH_CORNER,
              backgroundColor: over(look.ground, look.accent, 0.15),
            },
            indicator.style,
          ),
        })
      : null;

  const ink = disabled
    ? '$textMuted'
    : selected
      ? look.variant === 'line' || look.variant === 'subtle'
        ? look.accent
        : '$text'
      : '$textMuted';

  return {
    style: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      ...(grow && { flexGrow: 1 }),
      gap: TRIGGER_GAP,
      // Logical rather than left/right, because the one side that differs is
      // the panel side: a `line` trigger carries the wash's air off the rule
      // as padding, so the label keeps the same room a `subtle` one gives it
      // and the wash still has somewhere to stop.
      paddingTop: look.py,
      paddingBottom: look.py + (vertical ? 0 : railGap(look)),
      paddingStart: look.px,
      paddingEnd: look.px + (vertical ? railGap(look) : 0),
      fontSize: look.font,
      color: ink,
      ...(disabled ? {} : { cursor: 'pointer' }),
      transition: { backgroundColor: 100, color: 100 },
      ...Object.assign({}, ...variantStyle),
      ...(disabled ? {} : hover),
    },
    behind: [chip, wash, outlineShape],
    after: marker,
  };
}

// --- root -------------------------------------------------------------------

/** What `onValueChange` reports — Chakra's `details` object, so a handler
 *  written for Chakra (`(e) => setValue(e.value)`) transfers unchanged. */
export interface TabsValueChange {
  value: string;
}

export interface TabsProps {
  /** The selected trigger's value. Providing it makes the tabs controlled. */
  value?: string;
  /**
   * The initially selected value, when uncontrolled. There is no implicit
   * default: with neither prop nothing is selected and no panel shows, as in
   * Chakra — the root cannot know its triggers until they mount, and a first
   * render that selected nobody only to snap a frame later would be worse
   * than asking for one line.
   */
  defaultValue?: string;
  /** Selection changed — by click or by keyboard. Fires in controlled and
   *  uncontrolled mode alike. */
  onValueChange?(change: TabsValueChange): void;
  /** How the strip is drawn. Default `'line'`. */
  variant?: TabsVariant;
  /** Trigger padding, and the type inside. Default `'md'`. */
  size?: TabsSize;
  /** A vertical strip is a column beside its panel. Default `'horizontal'`. */
  orientation?: 'horizontal' | 'vertical';
  /**
   * `'automatic'` (default) selects as the arrows move, the way a desktop
   * notebook behaves. `'manual'` moves focus only and commits on Enter or
   * Space — what you want when a panel is expensive to build.
   */
  activationMode?: 'automatic' | 'manual';
  /** Triggers share the strip equally, filling its length. Default false. */
  fitted?: boolean;
  /** Where the triggers sit along the strip. Default `'start'`. */
  justify?: 'start' | 'center' | 'end';
  /**
   * What a **horizontal** strip does with more tabs than it has room for.
   *
   * `'menu'` (the default) keeps as many as fit and moves the rest behind a
   * button at the end of the strip, which drops them as a menu; the selected
   * tab is never one of them. `'clip'` is the older behaviour — the strip
   * overflows and the tabs past its edge are simply not visible.
   *
   * A vertical strip ignores this: it overflows downward, where a menu is
   * the wrong answer and a scroll is the right one.
   */
  overflow?: TabsOverflow;
  /** Build a panel the first time its tab is selected rather than up front.
   *  Default false: every panel mounts, hidden, so its state is live. */
  lazyMount?: boolean;
  /** Unmount a panel when its tab is deselected, giving up its state.
   *  Default false. */
  unmountOnExit?: boolean;
  /**
   * The colour the selection takes — Chakra's `colorPalette`, as one colour.
   * A `$token` is resolved against the palette. Default `$accent`.
   */
  accent?: string;
  /**
   * The colour behind the tabs, which is what an `enclosed` or `outline`
   * selected trigger is filled with so it reads as part of the panel.
   * Default `$background`; tabs on a card want `'$surface'`.
   */
  ground?: string;
  /** The root `<box>`'s style — width, padding, `flexGrow`. */
  style?: StyleInput;
  'data-testname'?: string;
  children?: ReactNode;
}

/**
 * Tabs.
 *
 * ```jsx
 * <Tabs defaultValue="members">
 *   <TabsList>
 *     <TabsTrigger value="members">Members</TabsTrigger>
 *     <TabsTrigger value="projects">Projects</TabsTrigger>
 *   </TabsList>
 *   <TabsContent value="members">…</TabsContent>
 *   <TabsContent value="projects">…</TabsContent>
 * </Tabs>
 * ```
 */
export function Tabs(props: TabsProps): ReactElement {
  // `Theme` is an interface, so it has no implicit index signature — the same
  // widening `hx.ts` documents for the `theme` prop.
  const theme = useTheme() as unknown as Record<string, unknown>;
  const [uncontrolled, setUncontrolled] = React.useState(props.defaultValue);
  const [focused, setFocused] = React.useState<string | null>(null);
  const selected = props.value ?? uncontrolled;
  const vertical = props.orientation === 'vertical';
  const variant = props.variant ?? 'line';
  const size = SIZES[props.size ?? 'md'] ?? SIZES.md;
  const accent = resolveColor(props.accent, theme, String(theme.accent));
  const ground = resolveColor(props.ground, theme, String(theme.background));
  const body = typeof theme.fontSize === 'number' ? theme.fontSize : 14;
  const { onValueChange } = props;
  const controlled = props.value !== undefined;

  // The registry the keyboard walks. A ref rather than state: a trigger
  // mounting must not re-render the tree, and the walk only happens inside
  // an event handler, where `current` is always current.
  const triggers = React.useRef(new Map<string, TriggerEntry>());

  // Which values have ever been selected, for `lazyMount`. Written during
  // render on purpose — adding the current selection is idempotent, and an
  // effect would run a frame after the panel already needed the answer.
  const seen = React.useRef(new Set<string>());
  if (selected !== undefined) seen.current.add(selected);

  const select = React.useCallback(
    (value: string) => {
      if (value === selected) return;
      if (!controlled) setUncontrolled(value);
      onValueChange?.({ value });
    },
    [selected, controlled, onValueChange],
  );

  const look = React.useMemo<TabsLook>(
    () => ({
      variant,
      vertical,
      manual: props.activationMode === 'manual',
      fitted: props.fitted ?? false,
      justify: props.justify,
      overflow: props.overflow ?? 'menu',
      accent,
      ground,
      text: String(theme.text),
      font: body + size.step,
      px: size.px,
      py: size.py,
      selected,
      focused,
      select,
      setFocused,
      triggers: triggers.current,
      everSelected: (value: string) => seen.current.has(value),
      lazyMount: props.lazyMount ?? false,
      unmountOnExit: props.unmountOnExit ?? false,
    }),
    [
      variant,
      vertical,
      props.activationMode,
      props.fitted,
      props.justify,
      props.overflow,
      props.lazyMount,
      props.unmountOnExit,
      accent,
      ground,
      theme.text,
      body,
      size,
      selected,
      focused,
      select,
    ],
  );

  return h(
    LookContext.Provider,
    { value: look },
    hx(
      'box',
      {
        // The same fill-the-space default core's `<Tabs>` had: a notebook is
        // usually the main region of whatever pane it is in. `style` wins for
        // the one that is not.
        style: styled(
          {
            flexGrow: 1,
            minHeight: 0,
            minWidth: 0,
            flexDirection: vertical ? 'row' : 'column',
          },
          props.style,
        ),
        'data-testname': props['data-testname'],
      },
      props.children,
    ),
  );
}

// --- overflow ---------------------------------------------------------------

/**
 * A trigger the strip could put in its menu, read off the element the app
 * wrote. The menu draws the same children the tab does, so there is no
 * second place to name a label and no way for the two to disagree.
 */
interface OverflowItem {
  value: string;
  disabled: boolean;
  /**
   * What this trigger's own children hash to — every primitive child, and a
   * placeholder for each element one. A relabelled tab has to be measured
   * again rather than kept at the width its old label had, and a tab in the
   * menu is not on the strip to be measured, so the width cache is keyed by
   * this as well as by `value`.
   */
  key: string;
  children: ReactNode;
}

/** What the strip's own re-measure needs and `DrawnNode` does not carry: the
 *  owning window's "something moved" signal, the display scale `abs` is in,
 *  and the box inside the padding. The same widening `internal/widget.ts`
 *  documents — a ref's public contract is geometry and focus. */
interface StripNode {
  root?: {
    onAnchorChange?: (fn: () => void) => () => void;
  } | null;
  scale?: number;
  contentBox?: () => { width: number; height: number };
}

/** A tab's laid-out size in logical pixels, or `null` for one the strip has
 *  not drawn since its label last changed. */
type SizeOf = (
  value: string,
  key: string,
) => { width: number; height: number } | null;

/** The strip's tab stop when the focus is on the overflow button rather than
 *  on a tab. A NUL is not a value any trigger can be given. */
const MORE = '\u0000more';

const NONE: readonly string[] = [];

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => b[i] === value);
}

/** Every primitive child, joined — see {@link OverflowItem.key}. */
function labelKey(children: ReactNode): string {
  const parts: string[] = [];
  React.Children.forEach(children, (child) => {
    parts.push(
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : '\u0000',
    );
  });
  return parts.join('\u0001');
}

/**
 * Which tabs do not fit, in the order they were written.
 *
 * The whole thing runs off what layout actually did, because nothing else
 * here can answer it: a tab's width is its label in the theme's face at the
 * size the theme is set to, plus whatever the app hung beside it. So the
 * strip measures the triggers it has drawn and remembers what each one came
 * out at, and the tabs in the menu are chosen from those remembered widths —
 * they are not on the strip to be measured while they are in the menu.
 *
 * **Two passes, not one.** A tab whose width is not known yet (a first
 * render, a tab just added, a label just changed) puts the strip back to
 * showing everything for one pass, which is what gives it a width; the pass
 * after that is the one that decides. That costs a frame of a strip
 * overflowing its own edge — clipped, since the strip clips while the menu
 * is on — and buys a fixed point: what is hidden is a pure function of the
 * remembered widths and the room, so the answer does not move unless
 * something really did.
 *
 * **When it re-runs.** After every commit, through `afterLayout` — react-x11
 * lays out on a frame flush rather than in the commit, so an effect reads the
 * *previous* pass's geometry. And after every layout this component did not
 * cause, through the owning window's `onAnchorChange`: the strip getting
 * narrower is usually the window being resized, which re-lays out without
 * re-rendering anything and would otherwise leave the menu answering a width
 * the strip stopped having.
 */
function useOverflow(
  active: boolean,
  items: readonly OverflowItem[],
  look: TabsLook,
  listRef: React.RefObject<DrawnNode | null>,
  moreRef: React.RefObject<DrawnNode | null>,
): { hidden: readonly string[]; sizeOf: SizeOf } {
  const widths = React.useRef(
    new Map<string, { key: string; width: number; height: number }>(),
  );
  // What `abs` was in when those were taken, so the menu can ask for them
  // back in the logical pixels a style length speaks.
  const measured = React.useRef(1);
  const [hidden, setHidden] = React.useState<readonly string[]>(NONE);
  // Read and written straight, beside the state: two `onAnchorChange`
  // notifications can land in one flush, and the second has to see what the
  // first decided rather than the render's stale copy.
  const hiddenRef = React.useRef(hidden);
  hiddenRef.current = hidden;

  const measure = (): void => {
    const list = listRef.current as (DrawnNode & StripNode) | null;
    const room = list?.contentBox?.().width ?? 0;
    // Nothing laid out yet, or laid out inside a hidden panel (`display:
    // 'none'` is out of layout, so the strip is 0 wide there). Answering
    // "everything overflows" would empty the strip into the menu and flash
    // it back the moment the panel is shown.
    if (!list || !(room > 0)) return;
    // `abs` and `contentBox()` are device pixels; a style length is logical.
    // Everything below is device, so the style numbers convert once, here.
    const scale = list.scale && list.scale > 0 ? list.scale : 1;
    measured.current = scale;
    const gap = stripGap(look.variant) * scale;

    const drawn = (value: string): DrawnNode | null => {
      const node = look.triggers.get(value)?.node;
      return node && node.abs.width > 0 ? node : null;
    };

    // A `fitted` strip with nothing hidden has already grown its triggers to
    // fill it, so those widths are the strip shared out rather than what a
    // tab needs, and writing them down would be writing down the answer to
    // the wrong question. The exception is the pass that matters: a `fitted`
    // strip that is *overflowing* had no free space to grow into, so the
    // widths are honest — and that is exactly the pass the menu appears on.
    let live = 0;
    let count = 0;
    for (const item of items) {
      const node = drawn(item.value);
      if (!node) continue;
      live += node.abs.width;
      count += 1;
    }
    live += Math.max(0, count - 1) * gap;
    if (!look.fitted || hiddenRef.current.length > 0 || live > room) {
      for (const item of items) {
        const node = drawn(item.value);
        if (!node) continue;
        widths.current.set(item.value, {
          key: item.key,
          width: node.abs.width,
          height: node.abs.height,
        });
      }
    }
    // A tab that has left the strip has no width worth keeping — and this is
    // the only thing that ever empties the map.
    const present = new Set(items.map((item) => item.value));
    for (const value of [...widths.current.keys()]) {
      if (!present.has(value)) widths.current.delete(value);
    }

    const known = (item: OverflowItem): number | null => {
      const seen = widths.current.get(item.value);
      return seen && seen.key === item.key ? seen.width : null;
    };

    let natural = Math.max(0, items.length - 1) * gap;
    let unmeasured = false;
    for (const item of items) {
      const width = known(item);
      if (width === null) unmeasured = true;
      else natural += width;
    }

    // The measuring pass — everything on the strip, nothing decided yet —
    // is `NONE`, which is also the answer when it all fits.
    let next: readonly string[] = NONE;
    if (!unmeasured && natural > room) {
      // The button is measured once it exists; before that it is guessed at
      // its own padding plus a chevron, and the pass after it mounts
      // corrects the guess.
      const more =
        moreRef.current?.abs.width || (look.px * 2 + look.font) * scale;
      const budget = room - more - gap;
      const shown = new Set<string>();
      let used = 0;
      const take = (value: string, width: number): void => {
        used += width + (shown.size ? gap : 0);
        shown.add(value);
      };
      // Straight down the strip, and the first tab that does not fit ends
      // it: which tabs are on the strip is a question about room, and
      // nothing else. The selected tab is not pulled out of the menu to keep
      // its place — the button wears the selected look instead, so the strip
      // does not reshuffle itself every time a tab is picked out of it.
      for (const item of items) {
        if (shown.has(item.value)) continue;
        const width = known(item) ?? 0;
        if (used + width + (shown.size ? gap : 0) > budget) break;
        take(item.value, width);
      }
      next = items
        .filter((item) => !shown.has(item.value))
        .map((item) => item.value);
    }

    if (sameValues(next, hiddenRef.current)) return;
    hiddenRef.current = next;
    setHidden(next);
  };

  // Re-read through a ref so the subscriptions below run this render's
  // closure without being torn down and rebuilt for every one of them.
  const measureRef = React.useRef(measure);
  measureRef.current = measure;

  // Deliberately no dependency array: any commit can move a tab's width.
  React.useEffect(() => {
    if (!active) return undefined;
    const tick = afterLayout(() => measureRef.current());
    return () => cancelAfterLayout(tick);
  });

  React.useEffect(() => {
    if (!active) return undefined;
    const root = (listRef.current as StripNode | null)?.root;
    if (!root?.onAnchorChange) return undefined;
    return root.onAnchorChange(() => measureRef.current());
  }, [active, listRef]);

  // `overflow="clip"` turned on mid-life, or the strip turned vertical: hand
  // the tabs back rather than leaving them in a menu nothing draws.
  React.useEffect(() => {
    if (!active && hiddenRef.current.length > 0) {
      hiddenRef.current = NONE;
      setHidden(NONE);
    }
  }, [active]);

  const sizeOf = React.useCallback<SizeOf>((value, key) => {
    const seen = widths.current.get(value);
    if (!seen || seen.key !== key) return null;
    const scale = measured.current || 1;
    return { width: seen.width / scale, height: seen.height / scale };
  }, []);

  return { hidden: active ? hidden : NONE, sizeOf };
}

/**
 * The overflow menu's own size, worked out from the measurements the strip
 * already took rather than left to the popup.
 *
 * A `<popup>` can size itself from its content, and that is normally the
 * right answer — but its placement is then a function of a number nothing
 * outside it can see, which is a bad thing for the one popup here whose
 * anchor moves every time the strip re-fits. A menu row is the same content
 * as the tab it stands for — same label, same face, same gap, same glyph
 * beside it — laid out with the row's padding instead of the tab's, so the
 * strip's own measurement answers it exactly.
 *
 * `null` when a tab in the menu has not been measured, which is the pass
 * where nothing is decided anyway; the popup sizes itself for that frame.
 */
function menuSheet(
  look: TabsLook,
  items: readonly OverflowItem[],
  sizeOf: SizeOf,
): { width: number; height: number } | null {
  if (items.length === 0) return null;
  let content = 0;
  let rows = 0;
  for (const item of items) {
    const size = sizeOf(item.value, item.key);
    if (!size) return null;
    content = Math.max(content, size.width - look.px * 2 + MENU_ROW_PX * 2);
    // …and off the height, the air a `line` trigger keeps under its wash on
    // top of its padding: a menu row has no rule to stand off.
    rows += size.height - look.py * 2 - railGap(look) + MENU_ROW_PY * 2;
  }
  const frame = (SHEET_PAD + SHEET_BORDER) * 2;
  return {
    width: Math.ceil(Math.max(content + frame, MENU_MIN_WIDTH)),
    height: Math.ceil(rows + (items.length - 1) * MENU_ROW_GAP + frame),
  };
}

/**
 * The button at the end of a strip that ran out of room, and the menu it
 * drops.
 *
 * **It is a stop on the strip like any other**, drawn from the same
 * {@link tabChrome} the triggers are — so when the selected tab is one of
 * the ones it is holding, the button wears the selected look (the accent
 * marker under a `line` strip, the chip on a `subtle` one) and the menu
 * marks the row. That is what a tab picked out of the menu does instead of
 * displacing a tab that fitted: the strip keeps the tabs it has room for,
 * and the button says the selection is behind it. It also takes the strip's
 * tab stop while it holds the selection, since the trigger that would
 * normally have it is not on the strip to hold anything.
 *
 * The menu is a `<popup>` anchored to the button and sized from its own
 * content — override-redirect, grabbing the pointer, dismissed by a press
 * anywhere else. Which means it never takes the focus, so **the button keeps
 * the keyboard** and hands the menu its keys, the way `<DatePicker>`'s
 * trigger does: Down/Up open it and walk it, Enter and Space commit, Escape
 * shuts it. A press elsewhere in the window blurs the button and that shuts
 * it too, and `useDismissOnWindowBlur` covers the one case a blur cannot —
 * the *window* going to the background, which leaves the button focused.
 */
function TabsMore(props: {
  items: readonly OverflowItem[];
  look: TabsLook;
  moreRef: React.RefObject<DrawnNode | null>;
  /** What the sheet comes to, from the strip's own measurements — see
   *  {@link menuSheet}. `null` leaves the popup to size itself. */
  sheet: { width: number; height: number } | null;
}): ReactElement {
  const { items, look, moreRef, sheet } = props;
  const strip = React.useContext(StripContext);
  const theme = useTheme();
  const [open, setOpen] = React.useState(false);
  // -1 is "nothing yet", which is what a menu dropped with the mouse opens
  // on: a row lit before the pointer or the arrows have said anything is a
  // row the next Enter would commit by accident.
  const [active, setActive] = React.useState(-1);
  // The button wears whatever the tabs beside it wear — including the reason
  // a `line` strip's fill has to be a box ({@link hoverWash}), which is why
  // this is tracked rather than declared.
  const [hovered, setHovered] = React.useState(false);
  const lit = hovered || open;

  /** Where the selection is, when it is behind this button. */
  const chosen = items.findIndex((item) => item.value === look.selected);
  const holds = chosen >= 0;

  const close = (): void => setOpen(false);
  useDismissOnWindowBlur(moreRef, open, close);

  // The menu is drawn from the tabs the strip could not fit, and that set
  // moves under it — a resize while it is open can take one back. Keeping
  // the cursor in range is cheaper than closing on every re-fit.
  const at = items.length ? Math.min(active, items.length - 1) : -1;

  const choose = (value: string): void => {
    close();
    look.select(value);
    // The focus stays here: the tab that was picked is still in this menu,
    // and this button is the stop on the strip that now stands for it.
  };

  const step = (delta: number): number => {
    const n = items.length;
    if (n === 0) return -1;
    // From "nothing yet", Down means the first row and Up means the last —
    // which is what starting one step outside either end comes to.
    const from = at < 0 ? (delta > 0 ? -1 : 0) : at;
    for (let i = 1; i <= n; i++) {
      const index = (((from + delta * i) % n) + n) % n;
      if (!items[index]?.disabled) return index;
    }
    return at;
  };

  const commit = (): void => {
    const item = items[at];
    if (item && !item.disabled) choose(item.value);
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.keysym === XK_ESCAPE) {
      if (!open) return;
      close();
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (!open) {
      if (ev.keysym !== XK_DOWN && ev.keysym !== XK_UP) return;
      // Opened from the keyboard, so it opens on a row: the selected one if
      // the selection is in here, and otherwise the end the key came from.
      setActive(holds ? chosen : ev.keysym === XK_UP ? items.length - 1 : 0);
      setOpen(true);
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    // An open menu owns the keyboard: the strip's own arrow walk is one
    // bubble away, and a Down that both moved the menu's cursor and roved
    // the focus off the button would close the menu it had just moved.
    if (ev.keysym === XK_DOWN) setActive(step(1));
    else if (ev.keysym === XK_UP) setActive(step(-1));
    else if (ev.keysym === XK_RETURN || ev.codepoint === 32) commit();
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  };

  const row = (item: OverflowItem, index: number): ReactElement =>
    hx(
      'box',
      {
        key: item.value,
        // A menu of tabs is a set of mutually exclusive choices, which is
        // what this role says — and it is the only place a screen reader
        // hears about a tab that is not on the strip to carry `role="tab"`.
        role: 'menuitemradio',
        'aria-checked': index === chosen,
        disabled: item.disabled || undefined,
        onMouseEnter: () => {
          if (!item.disabled) setActive(index);
        },
        onClick: () => {
          if (!item.disabled) choose(item.value);
        },
        style: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: TRIGGER_GAP,
          paddingLeft: MENU_ROW_PX,
          paddingRight: MENU_ROW_PX,
          paddingTop: MENU_ROW_PY,
          paddingBottom: MENU_ROW_PY,
          borderRadius: WASH_CORNER,
          fontSize: look.font,
          color: item.disabled ? '$textMuted' : '$text',
          ...(item.disabled
            ? {}
            : {
                cursor: 'pointer',
                // The lit row is state rather than a `:hover` block because
                // the arrows move it too, and a menu with two lit rows —
                // the pointer's and the keyboard's — is worse than one.
                ...(index === at && { backgroundColor: '$surfaceHover' }),
              }),
        },
      },
      // The selected row's marker: the strip's own accent bar, turned to
      // stand along a row instead of under a tab. It is a mark and not a
      // fill so it cannot be confused with the row the cursor is on — both
      // can be true of the same row.
      index === chosen
        ? hx('box', {
            key: 'mark',
            style: {
              position: 'absolute',
              start: 0,
              top: MENU_ROW_PY / 2,
              bottom: MENU_ROW_PY / 2,
              width: INDICATOR,
              borderRadius: INDICATOR / 2,
              backgroundColor: look.accent,
            },
          })
        : null,
      withText(item.children, CAP_TRIM),
    );

  const chrome = tabChrome(look, strip?.indicator ?? null, {
    selected: holds,
    disabled: false,
    hovered: lit,
    // Never: the button only exists while something is hidden, and a
    // `fitted` strip has stopped sharing its width out by then.
    grow: false,
  });

  return hx(
    'box',
    {
      ref: moreRef,
      role: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      'aria-label': `${items.length} more tab${items.length === 1 ? '' : 's'}`,
      focusable: true,
      // The strip is one tab stop. A tab holds it — unless the selected tab
      // is one of the ones behind this button, and then this holds it.
      tabIndex: holds ? 0 : -1,
      // On the press, not the release: a control whose whole purpose is to
      // be looked at has nothing to gain from waiting out the click.
      onMouseDown: () => {
        setActive(-1);
        setOpen((was) => !was);
      },
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      onFocus: () => look.setFocused(MORE),
      onBlur: () => {
        look.setFocused(null);
        close();
      },
      onKeyDown,
      style: [
        chrome.style,
        // An open button reads as engaged in every variant, not only the one
        // whose wash is a box — and not when it is already wearing the
        // selected look, which outranks a hover.
        lit && !holds
          ? look.variant === 'line'
            ? { color: '$text' }
            : { color: '$text', backgroundColor: '$surfaceHover' }
          : {},
      ],
      'data-testname': 'tabs-more',
    },
    chrome.behind,
    h(Icon, { name: 'chevronDown', size: look.font - 4 }),
    chrome.after,
    open &&
      items.length > 0 &&
      hx(
        'popup',
        {
          theme,
          // Sized here rather than from its own content, so where it lands is
          // arithmetic this component can see — {@link menuSheet}.
          ...(sheet ?? {}),
          anchor: {
            to: moreRef,
            placement: 'bottom',
            // The menu hangs off the end of the strip because the button
            // does, and `end` mirrors on its own in an RTL subtree.
            align: 'end',
          },
          grab: true,
          onDismiss: close,
          // ARGB where the display has it, so the corners the sheet gives up
          // are the desktop rather than a colour — the same call
          // `<DatePicker>`'s sheet makes, and the same reason the window
          // paints nothing itself when it can be seen through.
          transparent: true,
          style: {
            backgroundColor: theme.background,
            '@supports transparency': { backgroundColor: 'transparent' },
          } as SupportsStyle,
        },
        hx(
          'box',
          {
            role: 'menu',
            style: {
              flexGrow: 1,
              minWidth: MENU_MIN_WIDTH,
              padding: SHEET_PAD,
              gap: MENU_ROW_GAP,
              borderWidth: SHEET_BORDER,
              borderColor: '$border',
              backgroundColor: theme.background,
              '@supports transparency': { borderRadius: theme.radiusPopup },
            } as SupportsStyle,
          },
          items.map(row),
        ),
      ),
  );
}

// --- list -------------------------------------------------------------------

export interface TabsListProps {
  style?: StyleInput;
  'data-testname'?: string;
  children?: ReactNode;
}

/**
 * The strip of triggers — a single tab stop, walked with the arrows.
 *
 * The arrows are visual, the list is logical: in a mirrored horizontal strip
 * the *next* trigger is the one to the left, and in either direction the walk
 * follows where layout actually put each trigger (sorted by position, not by
 * mount order), wraps at the ends, and skips disabled triggers. Home/End jump
 * to the ends. In `manual` mode focus moves without selecting, and Enter or
 * Space commits — those keys are not handled here, because core makes them
 * the click the trigger's own `onClick` already is.
 *
 * A horizontal strip with more tabs than room keeps the ones that fit and
 * drops the rest into a menu at its end (`overflow`, on the root). The
 * menu's button is the last stop on the same walk.
 */
export function TabsList(props: TabsListProps): ReactElement {
  const look = useLook('TabsList');
  const rtl = useDirection() === 'rtl';
  const { vertical } = look;
  const listRef = React.useRef<DrawnNode | null>(null);
  const moreRef = React.useRef<DrawnNode | null>(null);

  // A `<TabsIndicator>` written into the strip, Chakra-style, is read here
  // and handed to the triggers — the selected one draws it. It has to be a
  // direct child for this to see it; anything else in the strip renders
  // where it was written.
  //
  // The triggers come off the same walk, for the overflow menu: it draws the
  // children the app wrote on the trigger, so a tab that moves into the menu
  // keeps its label without the app naming it twice. Anything in the strip
  // that is *not* a trigger stays on the strip and is not accounted for —
  // the arithmetic is about tabs.
  const children = React.Children.toArray(props.children);
  let indicator: TabsIndicatorProps | null = null;
  const items: OverflowItem[] = [];
  for (const child of children) {
    if (!React.isValidElement(child)) continue;
    if (child.type === TabsIndicator) {
      indicator = child.props as TabsIndicatorProps;
    } else if (child.type === TabsTrigger) {
      const trigger = child.props as TabsTriggerProps;
      items.push({
        value: trigger.value,
        disabled: trigger.disabled ?? false,
        key: labelKey(trigger.children),
        children: trigger.children,
      });
    }
  }

  // One tab cannot overflow into a menu that would take more room than it
  // does, so the machinery does not start until there are two.
  const { hidden, sizeOf } = useOverflow(
    look.overflow === 'menu' && !vertical && items.length > 1,
    items,
    look,
    listRef,
    moreRef,
  );
  const hiddenSet = hidden.length > 0 ? new Set(hidden) : null;
  const overflowed = hiddenSet
    ? items.filter((item) => hiddenSet.has(item.value))
    : [];

  const onKeyDown = (ev: KeyboardEvent) => {
    // Where layout put each trigger is the one ordering that cannot drift
    // from what the user sees — mount order can, after a remove and re-add.
    // The overflow button is a stop on the same walk and sorts in with the
    // rest, which is what puts it at the end without it being told.
    const stops = [...look.triggers.entries()].map(([value, entry]) => ({
      value,
      ...entry,
    }));
    if (moreRef.current) {
      stops.push({ value: MORE, node: moreRef.current, disabled: false });
    }
    const entries = stops.sort((a, b) =>
      vertical ? a.node.abs.y - b.node.abs.y : a.node.abs.x - b.node.abs.x,
    );
    // Visual order back to logical: an RTL strip reads right to left. A
    // vertical strip never mirrors — Up is Up.
    const swap = !vertical && rtl;
    if (swap) entries.reverse();

    /** The next enabled trigger `delta` steps away, wrapping. */
    const step = (from: number, delta: number) => {
      const n = entries.length;
      if (n === 0) return null;
      for (let i = 1; i <= n; i++) {
        const entry = entries[(((from + delta * i) % n) + n) % n];
        if (entry && !entry.disabled) return entry;
      }
      return null;
    };

    const goTo = (entry: { value: string; node: DrawnNode } | null) => {
      if (!entry) return;
      entry.node.focus();
      // The overflow button selects nothing: it is the way to the tabs that
      // did not fit, not one of them.
      if (!look.manual && entry.value !== MORE) look.select(entry.value);
    };

    const back = vertical ? XK_UP : swap ? XK_RIGHT : XK_LEFT;
    const forward = vertical ? XK_DOWN : swap ? XK_LEFT : XK_RIGHT;
    const current = entries.findIndex(
      (entry) => entry.value === (look.focused ?? look.selected),
    );
    switch (ev.keysym) {
      case back:
        goTo(step(current === -1 ? 0 : current, -1));
        return;
      case forward:
        goTo(step(current === -1 ? 0 : current, 1));
        return;
      case XK_HOME:
        goTo(entries.find((entry) => !entry.disabled) ?? null);
        return;
      case XK_END:
        goTo([...entries].reverse().find((entry) => !entry.disabled) ?? null);
        return;
      default:
    }
  };

  // What the strip itself draws, per variant. The `line` and `outline` rules
  // are an absolutely positioned 1px box on the panel edge rather than a
  // border: borders are all-edges here, and this has to sit on one side.
  // `zIndex: -1` paints it under the triggers, so a selected `outline`
  // trigger's opaque fill is what cuts it.
  const rule =
    look.variant === 'line' || look.variant === 'outline'
      ? hx('box', {
          style: [
            { position: 'absolute', backgroundColor: '$border', zIndex: -1 },
            vertical
              ? { top: 0, bottom: 0, end: 0, width: RULE }
              : { left: 0, right: 0, bottom: 0, height: RULE },
          ],
        })
      : null;

  const chrome: Style =
    look.variant === 'enclosed'
      ? {
          // Chakra's `bg.muted` chip, mixed from the palette this theme
          // actually has — opaque, for the reason `over` gives.
          backgroundColor: over(look.ground, look.text, 0.07),
          borderRadius: CORNER,
          padding: 3,
          gap: 2,
        }
      : { gap: stripGap(look.variant) };

  return h(
    StripContext.Provider,
    {
      value: {
        indicator,
        // A `fitted` strip stops growing its tabs while any of them is in
        // the menu — see {@link TabsStrip}.
        grow: look.fitted && hidden.length === 0,
      },
    },
    hx(
      'box',
      {
        ref: listRef,
        role: 'tablist',
        'aria-orientation': look.vertical ? 'vertical' : 'horizontal',
        onKeyDown,
        style: styled(
          {
            flexShrink: 0,
            flexDirection: vertical ? 'column' : 'row',
            alignItems: 'stretch',
            ...(look.justify && {
              justifyContent:
                look.justify === 'start'
                  ? 'flex-start'
                  : look.justify === 'end'
                    ? 'flex-end'
                    : 'center',
            }),
            // A pass that has not decided yet draws every tab at its natural
            // width, which is wider than the strip by definition — clipped
            // rather than spilling over the panel for the frame it takes.
            ...(look.overflow === 'menu' && !vertical
              ? { overflow: 'hidden' }
              : {}),
            ...chrome,
          },
          props.style,
        ),
        'data-testname': props['data-testname'],
      },
      rule,
      hiddenSet
        ? children.filter(
            (child) =>
              !(
                React.isValidElement(child) &&
                child.type === TabsTrigger &&
                hiddenSet.has((child.props as TabsTriggerProps).value)
              ),
          )
        : children,
      overflowed.length > 0
        ? h(TabsMore, {
            key: 'tabs-more',
            items: overflowed,
            look,
            moreRef,
            sheet: menuSheet(look, overflowed, sizeOf),
          })
        : null,
    ),
  );
}
// --- trigger ----------------------------------------------------------------

export interface TabsTriggerProps {
  /** What this trigger selects — the `value` its `<TabsContent>` names. */
  value: string;
  /** Unclickable and skipped by the arrows. */
  disabled?: boolean;
  style?: StyleInput;
  'data-testname'?: string;
  children?: ReactNode;
}

/**
 * One tab. Prose and glyphs alike are legal children — a string is wrapped
 * in `<text>`, and an `<Icon>` inherits the trigger's ink (its `size` does
 * not inherit and has to be named).
 */
export function TabsTrigger(props: TabsTriggerProps): ReactElement {
  const look = useLook('TabsTrigger');
  const strip = React.useContext(StripContext);
  const indicator = strip?.indicator ?? null;
  const { value, disabled = false } = props;
  const selected = look.selected === value;
  // Tracked rather than declared, because the wash is a box of its own —
  // {@link hoverWash}.
  const [hovered, setHovered] = React.useState(false);

  // Registration is the ref callback: a new closure each render, so React
  // re-runs it and a `disabled` that changed is re-registered. Order in the
  // map churns with that, which is why the keyboard sorts by position
  // instead of trusting it.
  const register = (node: DrawnNode | null) => {
    if (node) look.triggers.set(value, { node, disabled });
    else look.triggers.delete(value);
  };

  // Everything it looks like, shared with the overflow button beside it —
  // {@link tabChrome}.
  const chrome = tabChrome(look, indicator, {
    selected,
    disabled,
    hovered,
    grow: strip ? strip.grow : look.fitted,
  });

  return hx(
    'box',
    {
      role: 'tab',
      'aria-selected': selected,
      ref: register,
      focusable: !disabled,
      // Roving focus: the selected trigger is the strip's tab stop. With
      // nothing selected yet every trigger is reachable, which is the lesser
      // evil — a strip nobody can tab into is worse than two stops.
      tabIndex: look.selected === undefined ? 0 : selected ? 0 : -1,
      disabled,
      onFocus: () => look.setFocused(value),
      onBlur: () => look.setFocused(null),
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      onClick: () => !disabled && look.select(value),
      style: styled(chrome.style, props.style),
      'data-testname': props['data-testname'],
    },
    chrome.behind,
    withText(props.children, CAP_TRIM),
    chrome.after,
  );
}

// --- indicator --------------------------------------------------------------

export interface TabsIndicatorProps {
  /** Merged over the default chip — a wash of the accent, radius 4. */
  style?: StyleInput;
}

/**
 * A marker that follows the selected trigger — Chakra's `Tabs.Indicator`,
 * and like there it is what gives the `plain` variant a look.
 *
 * Write it as a direct child of `<TabsList>`. It renders nothing where it
 * stands: the selected trigger draws it, as a box behind its own label — so
 * layout owns the geometry and a resize, a font change or an RTL mirror can
 * never leave the marker where a trigger used to be. What that costs is the
 * slide: this renderer cannot animate between two mounts, so the marker
 * moves in one step.
 */
export function TabsIndicator(props: TabsIndicatorProps): null {
  useLook('TabsIndicator');
  void props;
  return null;
}

// --- content ----------------------------------------------------------------

export interface TabsContentProps {
  /** Which trigger shows this panel. */
  value: string;
  style?: StyleInput;
  'data-testname'?: string;
  children?: ReactNode;
}

/**
 * One panel. Every panel mounts up front and the unselected ones are
 * `display: 'none'` — out of layout, still alive, so a form half-filled on
 * another tab keeps its state. `lazyMount` defers a panel until its first
 * selection; `unmountOnExit` gives the state up when it hides. Both are on
 * the root, because they are a policy about the set, not about one panel.
 */
export function TabsContent(props: TabsContentProps): ReactElement | null {
  const look = useLook('TabsContent');
  const selected = look.selected === props.value;

  if (!selected) {
    if (look.unmountOnExit) return null;
    if (look.lazyMount && !look.everSelected(props.value)) return null;
  }

  return hx(
    'box',
    {
      role: 'tabpanel',
      // A hidden panel is still mounted (that is the point), but it must not
      // be read: `display: 'none'` takes it out of layout, and this takes it
      // out of the accessibility tree.
      'aria-hidden': selected ? undefined : true,
      style: styled(
        {
          display: selected ? 'flex' : 'none',
          flexDirection: 'column',
          flexGrow: 1,
          minHeight: 0,
          minWidth: 0,
          // Prose in a panel is body text. Named here because a bare
          // `<text>`'s default ink is not the palette's — it has to inherit
          // one, or a dark theme reads it in the light theme's black.
          color: '$text',
          ...(look.vertical
            ? { paddingStart: PANEL_GAP }
            : { paddingTop: PANEL_GAP }),
        },
        props.style,
      ),
      'data-testname': props['data-testname'],
    },
    withText(props.children),
  );
}
