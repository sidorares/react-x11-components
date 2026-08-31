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
import { useDirection, useTheme } from 'react-x11';
import type { DrawnNode, KeyboardEvent } from 'react-x11';
import { interpolate } from 'react-x11/style';
import type { Style } from 'react-x11/style';
import {
  XK_DOWN,
  XK_END,
  XK_HOME,
  XK_LEFT,
  XK_RIGHT,
  XK_UP,
} from 'react-x11/keysyms';

import { hx } from './hx.js';

const h = React.createElement;

/** What `style` props here accept, matching the rest of the package. */
type StyleInput = Style | Style[];

// --- geometry ---------------------------------------------------------------

/** The selected trigger's marker in the `line` variant. */
const INDICATOR = 2;
/** The strip's own line in the `line` and `outline` variants. */
const RULE = 1;
/** Inside a trigger, between a glyph and the label beside it. */
const TRIGGER_GAP = 6;
/** Between a strip and its panel. */
const PANEL_GAP = 8;

export type TabsVariant = 'line' | 'subtle' | 'enclosed' | 'outline' | 'plain';
export type TabsSize = 'sm' | 'md' | 'lg';

interface SizeSpec {
  /** Horizontal padding inside a trigger. */
  px: number;
  /** Vertical padding inside a trigger. */
  py: number;
  /** How far the label sits off the theme's body size. */
  step: number;
}

// The paddings are Chakra's proportions tightened for the desktop — a tab in
// an application window is a control, not a navigation bar read at arm's
// length. The type steps off the theme's own `fontSize` rather than a fixed
// scale, so a theme that sets 16 gets tabs in 16 (the same call `/timeline`
// makes).
const SIZES: Record<TabsSize, SizeSpec> = {
  sm: { px: 10, py: 4, step: -1 },
  md: { px: 12, py: 6, step: 0 },
  lg: { px: 16, py: 8, step: 1 },
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

/** What a `<TabsIndicator>` written into the strip asks the selected trigger
 *  to draw. `null` when the strip has none. */
const IndicatorContext = React.createContext<TabsIndicatorProps | null>(null);

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
 * Strings and numbers are only legal inside `<text>`, and a trigger's label
 * is prose — `<TabsTrigger value="a">Members</TabsTrigger>` is the shortest
 * thing that works and has to keep working. A primitive child is wrapped; an
 * element child is left exactly as written, and inherits the same ink.
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
 */
export function TabsList(props: TabsListProps): ReactElement {
  const look = useLook('TabsList');
  const rtl = useDirection() === 'rtl';
  const { vertical } = look;

  // A `<TabsIndicator>` written into the strip, Chakra-style, is read here
  // and handed to the triggers — the selected one draws it. It has to be a
  // direct child for this to see it; anything else in the strip renders
  // where it was written.
  let indicator: TabsIndicatorProps | null = null;
  for (const child of React.Children.toArray(props.children)) {
    if (React.isValidElement(child) && child.type === TabsIndicator) {
      indicator = child.props as TabsIndicatorProps;
    }
  }

  const onKeyDown = (ev: KeyboardEvent) => {
    // Where layout put each trigger is the one ordering that cannot drift
    // from what the user sees — mount order can, after a remove and re-add.
    const entries = [...look.triggers.entries()]
      .map(([value, entry]) => ({ value, ...entry }))
      .sort((a, b) =>
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
      if (!look.manual) look.select(entry.value);
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
          borderRadius: 6,
          padding: 3,
          gap: 2,
        }
      : { gap: look.variant === 'outline' ? 0 : 2 };

  return h(
    IndicatorContext.Provider,
    { value: indicator },
    hx(
      'box',
      {
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
            ...chrome,
          },
          props.style,
        ),
        'data-testname': props['data-testname'],
      },
      rule,
      props.children,
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
  const indicator = React.useContext(IndicatorContext);
  const { value, disabled = false } = props;
  const selected = look.selected === value;
  const vertical = look.vertical;

  // Registration is the ref callback: a new closure each render, so React
  // re-runs it and a `disabled` that changed is re-registered. Order in the
  // map churns with that, which is why the keyboard sorts by position
  // instead of trusting it.
  const register = (node: DrawnNode | null) => {
    if (node) look.triggers.set(value, { node, disabled });
    else look.triggers.delete(value);
  };

  // What the trigger looks like, per variant. Each selected state is opaque
  // where it has to cover the strip's rule, and every ink change is a
  // `$token` so a `theme` prop above still wins.
  const variantStyle: Style[] = [];
  const hover: Style = {};
  switch (look.variant) {
    case 'line':
    case 'plain':
      Object.assign(hover, { ':hover': { color: '$text' } });
      break;
    case 'subtle':
      variantStyle.push({ borderRadius: 4 });
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
        borderRadius: 4,
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
          backgroundColor: look.ground,
          borderWidth: 1,
          borderColor: '$border',
          // The side facing the panel stays open. A longhand overrides the
          // shorthand, which is the whole trick: three edges, no rule for a
          // fourth to sit on.
          ...(vertical ? { borderEndWidth: 0 } : { borderBottomWidth: 0 }),
        });
      else
        Object.assign(hover, {
          ':hover': { backgroundColor: '$surfaceHover' },
        });
      break;
  }

  // The selected marker in the `line` variant: a 2px box riding the panel
  // edge of the trigger, over the strip's 1px rule.
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

  // A `<TabsIndicator>` in the strip is drawn here, by the selected trigger,
  // behind its label. Layout owns its geometry — see the part's own comment.
  const chip =
    indicator && selected
      ? hx('box', {
          style: styled(
            {
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              right: 0,
              zIndex: -1,
              borderRadius: 4,
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
      onClick: () => !disabled && look.select(value),
      style: styled(
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          ...(look.fitted && { flexGrow: 1 }),
          gap: TRIGGER_GAP,
          paddingTop: look.py,
          paddingBottom: look.py,
          paddingLeft: look.px,
          paddingRight: look.px,
          fontSize: look.font,
          color: ink,
          ...(disabled ? {} : { cursor: 'pointer' }),
          transition: { backgroundColor: 100, color: 100 },
          ...Object.assign({}, ...variantStyle),
          ...(disabled ? {} : hover),
        },
        props.style,
      ),
      'data-testname': props['data-testname'],
    },
    chip,
    withText(props.children),
    marker,
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
