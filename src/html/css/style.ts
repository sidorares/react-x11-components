// The computed style: what the cascade produces and what everything below it
// reads. One flat object per element, built once per style pass and then
// treated as immutable — layout reads it many times and writes to it never,
// which is what lets a resize skip the whole cascade.
//
// Two rules the shape encodes:
//
//  - **Inherited and non-inherited properties are separated by construction.**
//    `inherit(parent)` copies the inherited half and resets the rest to its
//    initial value, so "did I remember to reset `border-width` on the child"
//    is not a question that can be got wrong one property at a time.
//  - **Nothing here depends on the containing block.** Percentages and `auto`
//    survive as `Len`s (see values.ts). A style computed at one width is
//    correct at every width, which is the whole of the resize story.
import {
  AUTO,
  fourSides,
  inkColor,
  keywordFontSize,
  parseAlpha,
  parseColor,
  parseLength,
  parseNumber,
  parseWeight,
  resolve,
  splitCommas,
  splitValue,
} from './values.js';
import type { Len, Pct, UnitContext } from './values.js';
import { parseUrl, readIdent, startsIdent } from './parse.js';
import {
  DEFAULT_QUOTES,
  parseContent,
  parseCounterList,
  parseQuotes,
} from './content.js';
import type { ContentItem, CounterChange } from './content.js';
import type { CustomProps } from './vars.js';

export type Display =
  | 'none'
  | 'block'
  | 'inline'
  | 'inline-block'
  | 'list-item'
  | 'flex'
  | 'inline-flex'
  | 'table'
  | 'inline-table'
  | 'table-row'
  | 'table-row-group'
  | 'table-header-group'
  | 'table-footer-group'
  | 'table-cell'
  | 'table-caption'
  | 'table-column'
  | 'table-column-group';

export interface ClipRect {
  top: number | null;
  right: number | null;
  bottom: number | null;
  left: number | null;
}

/** Whether a length is one `padding` takes: not `auto`, not negative. A
 *  `calc()` with a percentage in it has no sign until layout, which clamps
 *  it at zero (CSS Values 4 10.12). */
function notNegative(len: Len): boolean {
  if (len === AUTO) return true;
  if (typeof len === 'number') return len >= 0;
  return len.px !== undefined || len.pct >= 0;
}

function validPadding(len: Len | null): boolean {
  if (len === null || len === AUTO) return false;
  return notNegative(len);
}

/** `auto`, or `rect()` of four lengths or `auto`s, commas between them or
 *  not; undefined for anything else, which leaves the value as it was. */
function parseClip(
  value: string,
  ctx: UnitContext,
): ClipRect | null | undefined {
  const v = value.trim();
  if (/^auto$/i.test(v)) return null;
  const m = /^rect\(([^)]*)\)$/i.exec(v);
  if (!m) return undefined;
  const parts = m[1].includes(',')
    ? m[1].split(',').map((p) => p.trim())
    : m[1].trim().split(/\s+/);
  if (parts.length !== 4) return undefined;
  const edges: (number | null)[] = [];
  for (const part of parts) {
    if (/^auto$/i.test(part)) {
      edges.push(null);
      continue;
    }
    const len = parseLength(part, ctx);
    if (typeof len !== 'number') return undefined;
    edges.push(len);
  }
  return { top: edges[0], right: edges[1], bottom: edges[2], left: edges[3] };
}

export type BorderStyle =
  | 'none'
  | 'hidden'
  | 'solid'
  | 'dashed'
  | 'dotted'
  | 'double'
  | 'groove'
  | 'ridge'
  | 'inset'
  | 'outset';

export interface ComputedStyle {
  // --- inherited ------------------------------------------------------------
  color: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: 'normal' | 'italic' | 'oblique';
  /** A multiplier, or a px number when the author wrote a length. `normal`
   *  is the font's own, which only the inline layout can know. */
  lineHeight: number | 'normal';
  lineHeightIsLength: boolean;
  textAlign: 'left' | 'right' | 'center' | 'justify' | 'start' | 'end';
  /** Where an element aligns the blocks in it that fill no line of their
   *  own and have no auto margin: HTML's `<center>` and `align`, and the
   *  `-webkit-center` that browsers spell them as. Inherited with
   *  `text-align`, which resets it. */
  alignBlocks: 'left' | 'right' | 'center' | null;
  textIndent: Len;
  textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  letterSpacing: number;
  wordSpacing: number;
  whiteSpace: 'normal' | 'nowrap' | 'pre' | 'pre-wrap' | 'pre-line';
  direction: 'ltr' | 'rtl';
  /** How an element's text takes part in the bidi algorithm: not
   *  inherited, and carried out as the control characters it stands for
   *  (`bidiControls`). */
  unicodeBidi:
    | 'normal'
    | 'embed'
    | 'isolate'
    | 'bidi-override'
    | 'isolate-override'
    | 'plaintext';
  visibility: 'visible' | 'hidden';
  listStyleType: string;
  listStylePosition: 'inside' | 'outside';
  cursor: string | null;
  borderCollapse: 'separate' | 'collapse';
  /** `border-spacing`: between columns, and between rows. */
  borderSpacing: number;
  borderSpacingY: number;
  captionSide: 'top' | 'bottom';
  /** Inherited so a `<td>` picks up the table's, which is how authors expect
   *  `text-align` on a `<table>` to behave. */
  tableTextAlignSet: boolean;
  /** The marks `open-quote` and `close-quote` write, pairs outermost first. */
  quotes: readonly string[] | 'none';
  /** Custom properties, `--name`, with their `var()`s replaced (`vars.ts`);
   *  null where none is set. Inherited as the same map. */
  custom: CustomProps | null;

  // --- not inherited --------------------------------------------------------
  display: Display;
  /** `display: flow-root`: a block that makes a formatting context of its
   *  own, which is what `display` is then (CSS Display 3, 2.3). */
  flowRoot: boolean;
  position: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';
  float: 'none' | 'left' | 'right';
  clear: 'none' | 'left' | 'right' | 'both';
  boxSizing: 'content-box' | 'border-box';
  overflowX: 'visible' | 'hidden' | 'scroll' | 'auto';
  overflowY: 'visible' | 'hidden' | 'scroll' | 'auto';
  /** `clip: rect(…)`: the part of an absolutely positioned box that shows,
   *  its edges measured from the border box's top left, a null edge the
   *  border box's own (CSS 2.1 11.1.2). Null for `auto`. */
  clip: ClipRect | null;
  opacity: number;
  zIndex: number | 'auto';
  /** A keyword, a length to raise the box by, or a percentage of its own
   *  line height. */
  verticalAlign:
    | 'baseline'
    | 'top'
    | 'middle'
    | 'bottom'
    | 'sub'
    | 'super'
    | 'text-top'
    | 'text-bottom'
    | number
    | Pct;

  width: Len;
  height: Len;
  minWidth: Len;
  maxWidth: Len | 'none';
  minHeight: Len;
  maxHeight: Len | 'none';

  marginTop: Len;
  marginRight: Len;
  marginBottom: Len;
  marginLeft: Len;
  paddingTop: Len;
  paddingRight: Len;
  paddingBottom: Len;
  paddingLeft: Len;

  borderTopWidth: number;
  borderRightWidth: number;
  borderBottomWidth: number;
  borderLeftWidth: number;
  borderTopStyle: BorderStyle;
  borderRightStyle: BorderStyle;
  borderBottomStyle: BorderStyle;
  borderLeftStyle: BorderStyle;
  borderTopColor: string;
  borderRightColor: string;
  borderBottomColor: string;
  borderLeftColor: string;
  /** top-left, top-right, bottom-right, bottom-left. */
  borderRadius: [number, number, number, number];

  top: Len;
  right: Len;
  bottom: Len;
  left: Len;

  backgroundColor: string | null;
  backgroundImage: string | null;
  backgroundRepeat: 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat';
  backgroundSize: 'auto' | 'cover' | 'contain';
  backgroundAttachment: 'scroll' | 'fixed' | 'local';
  backgroundPositionX: Len;
  backgroundPositionY: Len;

  textDecorationLine: 'none' | 'underline' | 'line-through' | 'overline';
  textDecorationColor: string | null;
  textDecorationStyle: 'solid' | 'double' | 'dotted' | 'dashed' | 'wavy';
  /** What this box's text is drawn with: its own `text-decoration` and the
   *  ones its ancestors propagate to it, each in the colour of the box that
   *  set it (`decorate`). No property: the cascade works them out. */
  underline: string | null;
  underlineStyle: 'solid' | 'double' | 'dotted' | 'dashed' | 'wavy';
  lineThrough: string | null;

  // flex — handed to yoga rather than interpreted here
  flexDirection: 'row' | 'row-reverse' | 'column' | 'column-reverse';
  flexWrap: 'nowrap' | 'wrap' | 'wrap-reverse';
  justifyContent:
    | 'flex-start'
    | 'flex-end'
    | 'center'
    | 'space-between'
    | 'space-around'
    | 'space-evenly';
  alignItems: 'flex-start' | 'flex-end' | 'center' | 'stretch' | 'baseline';
  alignSelf:
    'auto' | 'flex-start' | 'flex-end' | 'center' | 'stretch' | 'baseline';
  alignContent:
    | 'flex-start'
    | 'flex-end'
    | 'center'
    | 'stretch'
    | 'space-between'
    | 'space-around';
  flexGrow: number;
  flexShrink: number;
  flexBasis: Len | 'auto' | 'content';
  order: number;
  rowGap: number;
  columnGap: number;

  tableLayout: 'auto' | 'fixed';

  // generated content (CSS 2.1 12)
  /** What a `::before` or `::after` holds; `normal` and `none` make none. */
  content: ContentItem[] | 'normal' | 'none';
  counterReset: CounterChange[] | null;
  counterIncrement: CounterChange[] | null;
}

/** The properties that inherit. Named once, so `inherit()` and the `inherit`
 *  keyword cannot disagree about the list. */
const INHERITED = [
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'lineHeightIsLength',
  'textAlign',
  'alignBlocks',
  'textIndent',
  'textTransform',
  'letterSpacing',
  'wordSpacing',
  'whiteSpace',
  'direction',
  'visibility',
  'listStyleType',
  'listStylePosition',
  'cursor',
  'borderCollapse',
  'borderSpacing',
  'borderSpacingY',
  'captionSide',
  'tableTextAlignSet',
  'quotes',
  'custom',
] as const satisfies readonly (keyof ComputedStyle)[];

/** What the document's root inherits from — the host's own text look, so an
 *  unstyled document reads as part of the application rather than as a
 *  white rectangle from 1994. */
export interface RootLook {
  color: string;
  fontFamily: string;
  fontSize: number;
  monoFamily: string;
  linkColor: string;
  borderColor: string;
  mutedColor: string;
  background: string;
  /** Which scheme the palette is — what `@media (prefers-color-scheme)`
   *  is answered from. */
  colorScheme: 'light' | 'dark';
  /**
   * The palette's own control chrome, carried here because the **box in the
   * flow has to be the size the widget will be** and layout runs long before
   * the widget exists. These are the same tokens core's `<Button>` and
   * `<Select>` read, so a form in a document and a form in the window around
   * it come out the same height.
   */
  surface: string;
  controlPadY: number;
  controlBorder: number;
  controlRadius: number;
}

export function initialStyle(look: RootLook, scale = 1): ComputedStyle {
  // `medium`, in device pixels
  const medium = BORDER_WIDTH_KEYWORDS.medium * scale;
  return {
    color: look.color,
    fontFamily: look.fontFamily,
    fontSize: look.fontSize,
    fontWeight: 400,
    fontStyle: 'normal',
    lineHeight: 'normal',
    lineHeightIsLength: false,
    textAlign: 'start',
    alignBlocks: null,
    textIndent: 0,
    textTransform: 'none',
    letterSpacing: 0,
    wordSpacing: 0,
    whiteSpace: 'normal',
    direction: 'ltr',
    unicodeBidi: 'normal',
    visibility: 'visible',
    listStyleType: 'disc',
    listStylePosition: 'outside',
    cursor: null,
    borderCollapse: 'separate',
    // CSS's initial value; a `<table>` gets its 2px from the UA sheet, and
    // an anonymous table, which no sheet names, has none
    borderSpacing: 0,
    borderSpacingY: 0,
    captionSide: 'top',
    tableTextAlignSet: false,
    quotes: DEFAULT_QUOTES,
    custom: null,

    display: 'inline',
    flowRoot: false,
    position: 'static',
    float: 'none',
    clear: 'none',
    boxSizing: 'content-box',
    overflowX: 'visible',
    overflowY: 'visible',
    clip: null,
    opacity: 1,
    zIndex: AUTO,
    verticalAlign: 'baseline',

    width: AUTO,
    height: AUTO,
    minWidth: 0,
    maxWidth: 'none',
    minHeight: 0,
    maxHeight: 'none',

    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,

    // `medium`, and drawn as nothing while the style is `none`: a width
    // computes to zero there (CSS 2.1 8.5.1), which is the layout's to
    // apply, so that `border-style: solid` alone brings a border back
    borderTopWidth: medium,
    borderRightWidth: medium,
    borderBottomWidth: medium,
    borderLeftWidth: medium,
    borderTopStyle: 'none',
    borderRightStyle: 'none',
    borderBottomStyle: 'none',
    borderLeftStyle: 'none',
    // The token, not a colour: a border with no colour of its own follows
    // the element's ink wherever the cascade takes it, resolved at paint.
    borderTopColor: 'currentColor',
    borderRightColor: 'currentColor',
    borderBottomColor: 'currentColor',
    borderLeftColor: 'currentColor',
    borderRadius: [0, 0, 0, 0],

    top: AUTO,
    right: AUTO,
    bottom: AUTO,
    left: AUTO,

    backgroundColor: null,
    backgroundImage: null,
    backgroundRepeat: 'repeat',
    backgroundSize: 'auto',
    backgroundAttachment: 'scroll',
    backgroundPositionX: 0,
    backgroundPositionY: 0,

    textDecorationLine: 'none',
    textDecorationColor: null,
    textDecorationStyle: 'solid',
    underline: null,
    underlineStyle: 'solid',
    lineThrough: null,

    flexDirection: 'row',
    flexWrap: 'nowrap',
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    alignSelf: 'auto',
    alignContent: 'stretch',
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: AUTO,
    order: 0,
    rowGap: 0,
    columnGap: 0,

    tableLayout: 'auto',

    content: 'normal',
    counterReset: null,
    counterIncrement: null,
  };
}

/**
 * A child's starting style: the inherited half of `parent`, everything else
 * back at its initial value. `initial` is passed in rather than rebuilt
 * because it is the same object for every element in a pass.
 */
export function inherit(
  parent: ComputedStyle,
  initial: ComputedStyle,
): ComputedStyle {
  const out: ComputedStyle = { ...initial };
  for (const key of INHERITED) {
    // The cast is the price of one loop instead of twenty-one assignments:
    // both sides are the same key of the same interface, which the indexed
    // write cannot see.
    (out as unknown as Record<string, unknown>)[key] = parent[key];
  }
  out.borderTopColor = 'currentColor';
  out.borderRightColor = 'currentColor';
  out.borderBottomColor = 'currentColor';
  out.borderLeftColor = 'currentColor';
  // propagated, not inherited: `decorate` drops them where CSS stops them
  out.underline = parent.underline;
  out.underlineStyle = parent.underlineStyle;
  out.lineThrough = parent.lineThrough;
  return out;
}

// --- applying a declaration -------------------------------------------------

/** Longhands that take a colour and nothing else, by property name. */
const COLOR_PROPS: Record<string, keyof ComputedStyle> = {
  color: 'color',
  'background-color': 'backgroundColor',
  'border-top-color': 'borderTopColor',
  'border-right-color': 'borderRightColor',
  'border-bottom-color': 'borderBottomColor',
  'border-left-color': 'borderLeftColor',
  'text-decoration-color': 'textDecorationColor',
};

const SIDE_PROPS: Record<
  string,
  [
    keyof ComputedStyle,
    keyof ComputedStyle,
    keyof ComputedStyle,
    keyof ComputedStyle,
  ]
> = {
  margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
  padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
};

const BORDER_STYLES = new Set<string>([
  'none',
  'hidden',
  'solid',
  'dashed',
  'dotted',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
]);

const BORDER_WIDTH_KEYWORDS: Record<string, number> = {
  thin: 1,
  medium: 3,
  thick: 5,
};

/**
 * Apply one declaration to a style, in place.
 *
 * Unknown properties and unparseable values are dropped silently, which is
 * CSS's own error handling and not laziness: a document written for a real
 * browser is full of properties this renderer has never heard of, and the
 * correct response to every one of them is to render the rest.
 */
export function applyDeclaration(
  style: ComputedStyle,
  parent: ComputedStyle,
  prop: string,
  rawValue: string,
  ctx: UnitContext,
): void {
  const name = prop.toLowerCase();
  let value = rawValue.trim();
  if (!value) return;

  // CSS-wide keywords, before anything else parses the value.
  const lower = value.toLowerCase();
  if (lower === 'inherit') {
    inheritOne(style, parent, name);
    return;
  }
  if (lower === 'initial' || lower === 'unset' || lower === 'revert') {
    // `unset` is `inherit` for an inherited property and `initial` otherwise;
    // `revert` would be the UA sheet's value, and treating it as initial is
    // the closest this gets without keeping a third cascade level.
    if (lower === 'unset' && isInherited(name)) inheritOne(style, parent, name);
    return;
  }
  // `!important` is stripped by the parser; a stray one here is an author
  // writing it in an inline style, where it still wins by being last.
  if (/!\s*important$/i.test(value)) {
    value = value.replace(/!\s*important$/i, '').trim();
  }

  const color = COLOR_PROPS[name];
  if (color) {
    const parsed = parseColor(value);
    if (parsed === null) return;
    // `currentColor` in `color` is the one place the token refers to itself:
    // it means the inherited colour, and so does one in a `color-mix()`
    if (name === 'color') {
      style.color = inkColor(parsed, parent.color);
      return;
    }
    (style as unknown as Record<string, unknown>)[color] = parsed;
    return;
  }

  switch (name) {
    // --- box ----------------------------------------------------------------
    case 'display': {
      const v = value.toLowerCase();
      if (v === 'inline-block' || v === 'inline-flex') style.display = v;
      else if (v === 'grid')
        style.display = 'block'; // graceful, per the PRD
      else if (v === 'inline-grid') style.display = 'inline-block';
      else if (v === 'flow-root') style.display = 'block';
      else if (DISPLAYS.has(v)) style.display = v as Display;
      else return;
      style.flowRoot = v === 'flow-root';
      return;
    }
    case 'position': {
      const v = value.toLowerCase();
      if (
        v === 'static' ||
        v === 'relative' ||
        v === 'absolute' ||
        v === 'fixed' ||
        v === 'sticky'
      ) {
        style.position = v;
      }
      return;
    }
    case 'float': {
      const v = value.toLowerCase();
      if (v === 'left' || v === 'right' || v === 'none') style.float = v;
      // `inline-start`/`inline-end` are the logical spellings; the box tree
      // has the direction, so resolve them there rather than losing them.
      else if (v === 'inline-start')
        style.float = style.direction === 'rtl' ? 'right' : 'left';
      else if (v === 'inline-end')
        style.float = style.direction === 'rtl' ? 'left' : 'right';
      return;
    }
    case 'clear': {
      const v = value.toLowerCase();
      if (v === 'left' || v === 'right' || v === 'both' || v === 'none')
        style.clear = v;
      return;
    }
    case 'box-sizing': {
      const v = value.toLowerCase();
      if (v === 'border-box' || v === 'content-box') style.boxSizing = v;
      return;
    }
    case 'overflow':
    case 'overflow-x':
    case 'overflow-y': {
      const parts = splitValue(value);
      const x = overflowKeyword(parts[0]);
      const y = overflowKeyword(parts[1] ?? parts[0]);
      if (name !== 'overflow-y' && x) style.overflowX = x;
      if (name !== 'overflow-x' && y) style.overflowY = y;
      return;
    }
    case 'clip': {
      const clip = parseClip(value, ctx);
      if (clip !== undefined) style.clip = clip;
      return;
    }
    case 'opacity': {
      const a = parseAlpha(value);
      if (a !== null) style.opacity = a;
      return;
    }
    case 'visibility': {
      const v = value.toLowerCase();
      if (v === 'hidden' || v === 'collapse') style.visibility = 'hidden';
      else if (v === 'visible') style.visibility = 'visible';
      return;
    }
    case 'z-index': {
      // an integer: `1.5` is none, and a `calc()` is rounded to one, half
      // up (CSS Values 4 10.9)
      const v = value.trim().toLowerCase();
      if (v === 'auto') style.zIndex = AUTO;
      else if (/^[+-]?\d+$/.test(v)) style.zIndex = Number(v);
      else if (/^[a-z-]+\(/.test(v)) {
        const n = parseNumber(v);
        if (n !== null) style.zIndex = Math.floor(n + 0.5);
      }
      return;
    }
    case 'vertical-align': {
      const v = value.toLowerCase();
      if (
        v === 'baseline' ||
        v === 'top' ||
        v === 'middle' ||
        v === 'bottom' ||
        v === 'sub' ||
        v === 'super' ||
        v === 'text-top' ||
        v === 'text-bottom'
      ) {
        style.verticalAlign = v;
      } else {
        // a percentage is of the element's own line height, which layout
        // knows
        const len = parseLength(value, ctx);
        if (len !== null && len !== AUTO) style.verticalAlign = len;
      }
      return;
    }

    // --- geometry -----------------------------------------------------------
    case 'width':
    case 'height':
    case 'min-width':
    case 'min-height': {
      // a negative size is no value, and the declaration goes (CSS 2.1
      // 10.2, 10.4, 10.5, 10.7)
      const len = parseLength(value, ctx);
      if (len !== null && notNegative(len))
        (style as unknown as Record<string, unknown>)[camel(name)] = len;
      return;
    }
    case 'max-width':
    case 'max-height': {
      if (value.toLowerCase() === 'none') {
        (style as unknown as Record<string, unknown>)[camel(name)] = 'none';
        return;
      }
      const len = parseLength(value, ctx);
      if (len !== null && notNegative(len))
        (style as unknown as Record<string, unknown>)[camel(name)] = len;
      return;
    }
    case 'top':
    case 'right':
    case 'bottom':
    case 'left': {
      const len = parseLength(value, ctx);
      if (len !== null)
        (style as unknown as Record<string, unknown>)[name] = len;
      return;
    }
    case 'margin':
    case 'padding': {
      const keys = SIDE_PROPS[name];
      const parts = splitValue(value).map((p) => parseLength(p, ctx));
      if (parts.some((p) => p === null)) return;
      // padding is never `auto` and never negative: a value that is either
      // is no value, and the declaration goes (CSS 2.1 8.4)
      if (name === 'padding' && !parts.every(validPadding)) return;
      const sides = fourSides(parts as Len[]);
      for (let i = 0; i < 4; i += 1) {
        (style as unknown as Record<string, unknown>)[keys[i]] = sides[i];
      }
      return;
    }
    case 'margin-top':
    case 'margin-right':
    case 'margin-bottom':
    case 'margin-left':
    case 'padding-top':
    case 'padding-right':
    case 'padding-bottom':
    case 'padding-left': {
      const len = parseLength(value, ctx);
      if (len === null) return;
      if (name.startsWith('padding') && !validPadding(len)) return;
      (style as unknown as Record<string, unknown>)[camel(name)] = len;
      return;
    }

    // --- borders ------------------------------------------------------------
    case 'border':
    case 'border-top':
    case 'border-right':
    case 'border-bottom':
    case 'border-left': {
      applyBorderShorthand(style, name, value, ctx);
      return;
    }
    case 'border-width': {
      const parts = splitValue(value).map((p) => borderWidth(p, ctx));
      if (parts.some((p) => p === null)) return;
      const sides = fourSides(parts as number[]);
      style.borderTopWidth = sides[0];
      style.borderRightWidth = sides[1];
      style.borderBottomWidth = sides[2];
      style.borderLeftWidth = sides[3];
      return;
    }
    case 'border-style': {
      const parts = splitValue(value).map((p) => p.toLowerCase());
      if (!parts.every((p) => BORDER_STYLES.has(p))) return;
      const sides = fourSides(parts as BorderStyle[]);
      style.borderTopStyle = sides[0];
      style.borderRightStyle = sides[1];
      style.borderBottomStyle = sides[2];
      style.borderLeftStyle = sides[3];
      return;
    }
    case 'border-color': {
      const parts = splitValue(value).map((p) => parseColor(p));
      if (parts.some((p) => p === null)) return;
      const sides = fourSides(parts as string[]);
      style.borderTopColor = sides[0];
      style.borderRightColor = sides[1];
      style.borderBottomColor = sides[2];
      style.borderLeftColor = sides[3];
      return;
    }
    case 'border-top-width':
    case 'border-right-width':
    case 'border-bottom-width':
    case 'border-left-width': {
      const w = borderWidth(value, ctx);
      if (w !== null)
        (style as unknown as Record<string, unknown>)[camel(name)] = w;
      return;
    }
    case 'border-top-style':
    case 'border-right-style':
    case 'border-bottom-style':
    case 'border-left-style': {
      const v = value.toLowerCase();
      if (BORDER_STYLES.has(v))
        (style as unknown as Record<string, unknown>)[camel(name)] = v;
      return;
    }
    case 'border-radius': {
      // The `/` form gives elliptical corners, which this rounds to the
      // horizontal radius rather than dropping the declaration.
      const horizontal = value.split('/')[0];
      const parts = splitValue(horizontal).map((p) => {
        const len = parseLength(p, ctx);
        return typeof len === 'number'
          ? len
          : len && typeof len === 'object'
            ? 0
            : null;
      });
      if (parts.some((p) => p === null)) return;
      style.borderRadius = fourSides(parts as number[]);
      return;
    }

    // --- background ---------------------------------------------------------
    case 'background': {
      applyBackgroundShorthand(style, value, ctx);
      return;
    }
    case 'background-image': {
      // a bad url makes the declaration invalid, and it is dropped
      const url = parseUrl(splitCommas(value)[0]);
      if (url !== undefined) style.backgroundImage = url;
      return;
    }
    case 'background-repeat': {
      const words = splitValue(value.toLowerCase());
      const repeat = words.length <= 2 ? readRepeat(words) : null;
      if (repeat) style.backgroundRepeat = repeat;
      return;
    }
    case 'background-attachment': {
      // the last layer's, as the shorthand takes it
      const v = (splitCommas(value).pop() ?? '').toLowerCase().trim();
      if (v === 'scroll' || v === 'fixed' || v === 'local') {
        style.backgroundAttachment = v;
      }
      return;
    }
    case 'background-size': {
      const v = value.toLowerCase().trim();
      if (v === 'cover' || v === 'contain' || v === 'auto')
        style.backgroundSize = v;
      return;
    }
    case 'background-position': {
      const pair = positionPair(splitValue(value), ctx);
      if (!pair) return;
      style.backgroundPositionX = pair[0];
      style.backgroundPositionY = pair[1];
      return;
    }

    // --- generated content --------------------------------------------------
    case 'content': {
      const parsed = parseContent(value);
      if (parsed !== null) style.content = parsed;
      return;
    }
    case 'counter-reset':
    case 'counter-increment': {
      const reset = name === 'counter-reset';
      const parsed = parseCounterList(value, reset ? 0 : 1);
      if (parsed === null) return;
      const list = parsed === 'none' ? null : parsed;
      if (reset) style.counterReset = list;
      else style.counterIncrement = list;
      return;
    }
    case 'quotes': {
      const parsed = parseQuotes(value);
      if (parsed !== null) style.quotes = parsed;
      return;
    }

    // --- text ---------------------------------------------------------------
    case 'font': {
      applyFontShorthand(style, parent, value, ctx);
      return;
    }
    case 'font-family': {
      // ntk's font matcher takes the CSS list as written and walks it, so the
      // value passes through whole rather than being resolved here — once
      // every name in it is one: a string, or identifiers (CSS 2.1 15.3).
      // `test!foo, Ahem` is no list, and set Ahem.
      const names = splitCommas(value);
      if (!names.every(isFamilyName)) return;
      style.fontFamily = names
        .map((f) => f.replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
        .join(', ');
      return;
    }
    case 'font-size': {
      const kw = keywordFontSize(value, parent.fontSize, ctx.rem);
      if (kw !== null) {
        style.fontSize = kw;
        return;
      }
      // `em` in a `font-size` is relative to the *parent's* size, not this
      // element's — the one place the unit context has to be overridden.
      // 0 is a size — the text takes no room, which is what a container of
      // inline-blocks sets to lose the spaces between them — and a negative
      // one is no size at all, so the declaration goes
      const len = parseLength(value, { ...ctx, em: parent.fontSize });
      if (typeof len === 'number') {
        if (len >= 0) style.fontSize = len;
      } else if (len && typeof len === 'object') {
        const size = resolve(len, parent.fontSize);
        if (size >= 0) style.fontSize = size;
      }
      return;
    }
    case 'font-weight': {
      style.fontWeight = parseWeight(value, parent.fontWeight);
      return;
    }
    case 'font-style': {
      const v = value.toLowerCase();
      if (v === 'italic' || v === 'oblique' || v === 'normal')
        style.fontStyle = v;
      return;
    }
    case 'line-height': {
      const v = value.toLowerCase();
      if (v === 'normal') {
        style.lineHeight = 'normal';
        style.lineHeightIsLength = false;
        return;
      }
      const n = parseNumber(value);
      if (n !== null) {
        style.lineHeight = n;
        style.lineHeightIsLength = false;
        return;
      }
      const len = parseLength(value, ctx);
      if (typeof len === 'number') {
        style.lineHeight = len;
        style.lineHeightIsLength = true;
      } else if (len && typeof len === 'object') {
        style.lineHeight = resolve(len, style.fontSize);
        style.lineHeightIsLength = true;
      }
      return;
    }
    case 'text-align': {
      const v = value.toLowerCase();
      if (
        v === 'left' ||
        v === 'right' ||
        v === 'center' ||
        v === 'justify' ||
        v === 'start' ||
        v === 'end'
      ) {
        style.textAlign = v;
        style.alignBlocks = null;
        style.tableTextAlignSet = true;
        return;
      }
      // the value HTML's alignment is given as, the blocks inside aligned
      // with the text — and which mail writes for itself
      const aligned = /^-(?:webkit|moz|khtml)-(left|right|center)$/.exec(v);
      if (aligned) {
        const side = aligned[1] as 'left' | 'right' | 'center';
        style.textAlign = side;
        style.alignBlocks = side;
        style.tableTextAlignSet = true;
      }
      return;
    }
    case 'text-indent': {
      const len = parseLength(value, ctx);
      if (len !== null && len !== AUTO) style.textIndent = len;
      return;
    }
    case 'text-transform': {
      const v = value.toLowerCase();
      if (
        v === 'uppercase' ||
        v === 'lowercase' ||
        v === 'capitalize' ||
        v === 'none'
      ) {
        style.textTransform = v;
      }
      return;
    }
    case 'letter-spacing':
    case 'word-spacing': {
      if (value.toLowerCase() === 'normal') {
        if (name === 'letter-spacing') style.letterSpacing = 0;
        else style.wordSpacing = 0;
        return;
      }
      const len = parseLength(value, ctx);
      if (typeof len === 'number') {
        if (name === 'letter-spacing') style.letterSpacing = len;
        else style.wordSpacing = len;
      }
      return;
    }
    case 'white-space': {
      const v = value.toLowerCase();
      if (
        v === 'normal' ||
        v === 'nowrap' ||
        v === 'pre' ||
        v === 'pre-wrap' ||
        v === 'pre-line'
      ) {
        style.whiteSpace = v;
      }
      return;
    }
    case 'direction': {
      const v = value.toLowerCase();
      if (v === 'ltr' || v === 'rtl') style.direction = v;
      return;
    }
    case 'unicode-bidi': {
      const v = value.trim().toLowerCase();
      if (
        v === 'normal' ||
        v === 'embed' ||
        v === 'isolate' ||
        v === 'bidi-override' ||
        v === 'isolate-override' ||
        v === 'plaintext'
      ) {
        style.unicodeBidi = v;
      }
      return;
    }
    case 'text-decoration':
    case 'text-decoration-line': {
      for (const part of splitValue(value)) {
        const v = part.toLowerCase();
        if (
          v === 'underline' ||
          v === 'line-through' ||
          v === 'overline' ||
          v === 'none'
        ) {
          style.textDecorationLine = v;
        } else if (name === 'text-decoration') {
          const c = parseColor(part);
          if (c) style.textDecorationColor = c;
          else if (DECORATION_STYLES.has(v)) {
            style.textDecorationStyle =
              v as ComputedStyle['textDecorationStyle'];
          }
        }
      }
      return;
    }
    case 'text-decoration-style': {
      const v = value.toLowerCase();
      if (DECORATION_STYLES.has(v)) {
        style.textDecorationStyle = v as ComputedStyle['textDecorationStyle'];
      }
      return;
    }
    case 'cursor': {
      style.cursor = splitCommas(value)[0]?.trim().toLowerCase() || null;
      return;
    }

    // --- lists --------------------------------------------------------------
    case 'list-style': {
      for (const part of splitValue(value)) {
        const v = part.toLowerCase();
        if (v === 'inside' || v === 'outside') style.listStylePosition = v;
        else if (v !== 'none' || style.listStyleType === 'disc')
          style.listStyleType = v;
      }
      return;
    }
    case 'list-style-type': {
      style.listStyleType = value.toLowerCase();
      return;
    }
    case 'list-style-position': {
      const v = value.toLowerCase();
      if (v === 'inside' || v === 'outside') style.listStylePosition = v;
      return;
    }

    // --- flex ---------------------------------------------------------------
    case 'flex-direction': {
      const v = value.toLowerCase();
      if (
        v === 'row' ||
        v === 'row-reverse' ||
        v === 'column' ||
        v === 'column-reverse'
      ) {
        style.flexDirection = v;
      }
      return;
    }
    case 'flex-wrap': {
      const v = value.toLowerCase();
      if (v === 'nowrap' || v === 'wrap' || v === 'wrap-reverse')
        style.flexWrap = v;
      return;
    }
    case 'flex-flow': {
      for (const part of splitValue(value)) {
        applyDeclaration(style, parent, 'flex-direction', part, ctx);
        applyDeclaration(style, parent, 'flex-wrap', part, ctx);
      }
      return;
    }
    case 'justify-content': {
      const v = alignKeyword(value);
      if (v) style.justifyContent = v as ComputedStyle['justifyContent'];
      return;
    }
    case 'align-items': {
      const v = alignKeyword(value);
      if (v) style.alignItems = v as ComputedStyle['alignItems'];
      return;
    }
    case 'align-self': {
      if (value.toLowerCase() === 'auto') {
        style.alignSelf = AUTO;
        return;
      }
      const v = alignKeyword(value);
      if (v) style.alignSelf = v as ComputedStyle['alignSelf'];
      return;
    }
    case 'align-content': {
      const v = alignKeyword(value);
      if (v) style.alignContent = v as ComputedStyle['alignContent'];
      return;
    }
    case 'flex': {
      applyFlexShorthand(style, value, ctx);
      return;
    }
    case 'flex-grow':
    case 'flex-shrink': {
      const n = parseNumber(value);
      if (n !== null && n >= 0) {
        if (name === 'flex-grow') style.flexGrow = n;
        else style.flexShrink = n;
      }
      return;
    }
    case 'flex-basis': {
      const v = value.toLowerCase();
      if (v === 'content') style.flexBasis = 'content';
      else {
        const len = parseLength(value, ctx);
        if (len !== null) style.flexBasis = len;
      }
      return;
    }
    case 'order': {
      const n = parseNumber(value);
      if (n !== null) style.order = Math.trunc(n);
      return;
    }
    case 'gap':
    case 'row-gap':
    case 'column-gap': {
      const parts = splitValue(value).map((p) => parseLength(p, ctx));
      const row = typeof parts[0] === 'number' ? parts[0] : null;
      const col = typeof parts[1] === 'number' ? parts[1] : row;
      if (row === null) return;
      if (name !== 'column-gap') style.rowGap = row;
      if (name !== 'row-gap') style.columnGap = col ?? row;
      return;
    }

    // --- tables -------------------------------------------------------------
    case 'border-collapse': {
      const v = value.toLowerCase();
      if (v === 'collapse' || v === 'separate') style.borderCollapse = v;
      return;
    }
    case 'caption-side': {
      const v = value.toLowerCase();
      if (v === 'top' || v === 'bottom') style.captionSide = v;
      return;
    }
    case 'border-spacing': {
      // one length for both, or the columns' and then the rows' (CSS 2.1
      // 17.6.1), never negative
      const parts = splitValue(value);
      if (parts.length < 1 || parts.length > 2) return;
      const x = parseLength(parts[0], ctx);
      const y = parts.length > 1 ? parseLength(parts[1], ctx) : x;
      if (typeof x !== 'number' || typeof y !== 'number' || x < 0 || y < 0)
        return;
      style.borderSpacing = x;
      style.borderSpacingY = y;
      return;
    }
    case 'table-layout': {
      const v = value.toLowerCase();
      if (v === 'fixed' || v === 'auto') style.tableLayout = v;
      return;
    }
    default:
      return;
  }
}

const DISPLAYS = new Set<string>([
  'none',
  'block',
  'inline',
  'inline-block',
  'list-item',
  'flex',
  'inline-flex',
  'table',
  'inline-table',
  'table-row',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-cell',
  'table-caption',
  'table-column',
  'table-column-group',
]);

const DECORATION_STYLES = new Set([
  'solid',
  'double',
  'dotted',
  'dashed',
  'wavy',
]);

function overflowKeyword(
  v: string | undefined,
): ComputedStyle['overflowX'] | null {
  const s = (v ?? '').toLowerCase();
  if (s === 'visible' || s === 'hidden' || s === 'scroll' || s === 'auto')
    return s;
  if (s === 'clip') return 'hidden';
  return null;
}

function alignKeyword(value: string): string | null {
  const v = value.trim().toLowerCase();
  switch (v) {
    case 'start':
    case 'flex-start':
    case 'left':
      return 'flex-start';
    case 'end':
    case 'flex-end':
    case 'right':
      return 'flex-end';
    case 'center':
      return 'center';
    case 'stretch':
      return 'stretch';
    case 'baseline':
      return 'baseline';
    case 'space-between':
    case 'space-around':
    case 'space-evenly':
      return v;
    default:
      return null;
  }
}

function borderWidth(value: string, ctx: UnitContext): number | null {
  const kw = BORDER_WIDTH_KEYWORDS[value.trim().toLowerCase()];
  // The keywords are CSS pixels that never pass through `parseLength`, so
  // they take the display scale here.
  if (kw !== undefined) return kw * ctx.scale;
  const len = parseLength(value, ctx);
  // a negative width is not a width: the declaration is dropped, and the
  // one before it stands (CSS 2.1 8.5.1)
  return typeof len === 'number' && len >= 0 ? len : null;
}

const HORIZONTAL: Record<string, number> = { left: 0, center: 50, right: 100 };
const VERTICAL: Record<string, number> = { top: 0, center: 50, bottom: 100 };

/**
 * A `background-position` as its horizontal and vertical parts. A keyword
 * says which axis it is on, so one value alone is centred on the other —
 * `bottom` is the bottom, midway across — and two keywords come in either
 * order; with a length or a percentage among two, the first is across and
 * the second down (CSS 2.1 14.2.1). Three or four are CSS3's edge form:
 * `right 10px center` is ten pixels in from the right, midway down.
 */
function positionPair(parts: string[], ctx: UnitContext): [Len, Len] | null {
  if (parts.length === 0 || parts.length > 4) return null;
  const words = parts.map((p) => p.toLowerCase());
  if (parts.length > 2) return edgePosition(words, ctx);
  const keyword = (w: string) => w in HORIZONTAL || w in VERTICAL;
  const pct = (n: number): Len => (n === 0 ? 0 : { pct: n });
  if (parts.length === 1) {
    const [w] = words;
    if (w in VERTICAL && !(w in HORIZONTAL)) return [pct(50), pct(VERTICAL[w])];
    if (keyword(w)) return [pct(HORIZONTAL[w]), pct(50)];
    const x = positionLength(w, ctx);
    return x === null ? null : [x, pct(50)];
  }
  const [a, b] = words;
  if (keyword(a) && keyword(b)) {
    const swap =
      (a in VERTICAL && !(a in HORIZONTAL)) ||
      (b in HORIZONTAL && !(b in VERTICAL));
    const [h, v] = swap ? [b, a] : [a, b];
    if (!(h in HORIZONTAL) || !(v in VERTICAL)) return null;
    return [pct(HORIZONTAL[h]), pct(VERTICAL[v])];
  }
  if (a in VERTICAL && !(a in HORIZONTAL)) return null;
  if (b in HORIZONTAL && !(b in VERTICAL)) return null;
  const x = keyword(a) ? pct(HORIZONTAL[a]) : positionLength(a, ctx);
  const y = keyword(b) ? pct(VERTICAL[b]) : positionLength(b, ctx);
  return x === null || y === null ? null : [x, y];
}

/** A position's length or percentage — `auto` is none. */
function positionLength(word: string, ctx: UnitContext): Len | null {
  const len = parseLength(word, ctx);
  return len === AUTO ? null : len;
}

/** The edge form: a keyword for each axis, each but `center` with an
 *  offset in from its edge or not. */
function edgePosition(words: string[], ctx: UnitContext): [Len, Len] | null {
  const keyword = (w: string | undefined) =>
    w !== undefined && (w in HORIZONTAL || w in VERTICAL);
  const groups: { word: string; offset: Len | null }[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (!keyword(word)) return null;
    let offset: Len | null = null;
    if (i + 1 < words.length && !keyword(words[i + 1])) {
      if (word === 'center') return null;
      offset = positionLength(words[i + 1], ctx);
      if (offset === null) return null;
      i += 1;
    }
    groups.push({ word, offset });
  }
  if (groups.length !== 2) return null;
  let [h, v] = groups;
  if (
    (h.word in VERTICAL && !(h.word in HORIZONTAL)) ||
    (v.word in HORIZONTAL && !(v.word in VERTICAL))
  ) {
    [h, v] = [v, h];
  }
  if (!(h.word in HORIZONTAL) || !(v.word in VERTICAL)) return null;
  const x = fromEdge(HORIZONTAL[h.word], h.offset);
  const y = fromEdge(VERTICAL[v.word], v.offset);
  return x === null || y === null ? null : [x, y];
}

function fromEdge(at: number, offset: Len | null): Len | null {
  if (offset === null) return at === 0 ? 0 : { pct: at };
  if (at === 0) return offset;
  // in from the right or the bottom: `100% - offset`, which a comparison
  // (`right min(10%, 20px)`) is not the sum for
  if (typeof offset === 'number') return { pct: 100, px: -offset };
  if (offset === AUTO || offset.of) return null;
  return { pct: 100 - offset.pct, px: -(offset.px ?? 0) };
}

/** `background-repeat`: one keyword, or one for each axis (CSS3). `space`
 *  and `round` tile as `repeat` does. */
function readRepeat(words: string[]): ComputedStyle['backgroundRepeat'] | null {
  if (words.length === 1) {
    const [w] = words;
    if (w === 'repeat-x' || w === 'repeat-y') return w;
    if (!REPEATS.has(w)) return null;
    return w === 'no-repeat' ? 'no-repeat' : 'repeat';
  }
  if (words.length !== 2 || !REPEATS.has(words[0]) || !REPEATS.has(words[1]))
    return null;
  const x = words[0] !== 'no-repeat';
  const y = words[1] !== 'no-repeat';
  return x && y ? 'repeat' : x ? 'repeat-x' : y ? 'repeat-y' : 'no-repeat';
}

const REPEATS = new Set(['repeat', 'space', 'round', 'no-repeat']);

function applyBorderShorthand(
  style: ComputedStyle,
  name: string,
  value: string,
  ctx: UnitContext,
): void {
  const sides =
    name === 'border'
      ? (['Top', 'Right', 'Bottom', 'Left'] as const)
      : ([
          name.slice('border-'.length).replace(/^./, (c) => c.toUpperCase()),
        ] as const);
  // `border: none` and `border: 0` both mean "no border", and neither names
  // all three components — so the shorthand resets all three first, which is
  // what the spec says and what an author relies on to undo a UA border.
  let width = BORDER_WIDTH_KEYWORDS.medium * ctx.scale;
  let borderStyle: BorderStyle = 'none';
  let color: string | null = 'currentColor';
  for (const part of splitValue(value)) {
    const v = part.toLowerCase();
    if (BORDER_STYLES.has(v)) {
      borderStyle = v as BorderStyle;
      continue;
    }
    const w = borderWidth(part, ctx);
    if (w !== null) {
      width = w;
      continue;
    }
    const c = parseColor(part);
    if (c !== null) {
      color = c;
      continue;
    }
    // a negative width makes the whole shorthand invalid
    const len = parseLength(part, ctx);
    if (typeof len === 'number' && len < 0) return;
  }
  // A width with no style is kept rather than zeroed — the layout draws
  // nothing for `none` — so a later `border-style` alone finds it.
  for (const side of sides) {
    (style as unknown as Record<string, unknown>)[`border${side}Width`] = width;
    (style as unknown as Record<string, unknown>)[`border${side}Style`] =
      borderStyle;
    if (color !== null)
      (style as unknown as Record<string, unknown>)[`border${side}Color`] =
        color;
  }
}

/** A font family name: quoted, or a sequence of identifiers. */
function isFamilyName(name: string): boolean {
  const n = name.trim();
  if (n[0] === '"' || n[0] === "'") return true;
  if (!n) return false;
  for (const word of n.split(/\s+/)) {
    if (!startsIdent(word, 0) || readIdent(word, 0).end !== word.length) {
      return false;
    }
  }
  return true;
}

function applyBackgroundShorthand(
  style: ComputedStyle,
  value: string,
  ctx: UnitContext,
): void {
  // Only the last layer paints against the box, so a multi-layer background
  // reduces to its last comma group — but each has to be a layer, and only
  // the last may have a colour, or the declaration is none
  const layers = splitCommas(value);
  let layer: BackgroundLayer | null = null;
  for (let k = 0; k < layers.length; k += 1) {
    layer = readBackgroundLayer(layers[k], ctx, k === layers.length - 1);
    if (!layer) return;
  }
  if (!layer) return;
  style.backgroundColor = layer.color;
  style.backgroundImage = layer.image;
  style.backgroundRepeat = layer.repeat;
  style.backgroundSize = layer.size;
  style.backgroundAttachment = layer.attachment;
  const [x, y] = layer.position ?? [0, 0];
  style.backgroundPositionX = x;
  style.backgroundPositionY = y;
}

interface BackgroundLayer {
  color: string | null;
  image: string | null;
  repeat: ComputedStyle['backgroundRepeat'];
  size: ComputedStyle['backgroundSize'];
  attachment: ComputedStyle['backgroundAttachment'];
  position: [Len, Len] | null;
}

/**
 * One layer of the `background` shorthand, read whole before anything is
 * set: each part at most once, and a token that is none of them — a
 * string, `red\;`, a second colour — makes the declaration invalid, and it
 * is dropped rather than resetting the background it meant to replace
 * (CSS 2.1 4.2). What CSS3 adds is read too, so that a declaration a
 * browser keeps is kept: `/ cover` after the position, `space` and `round`,
 * a gradient — drawn as nothing, over the layer's colour.
 */
function readBackgroundLayer(
  text: string,
  ctx: UnitContext,
  last: boolean,
): BackgroundLayer | null {
  const parts = splitValue(text).flatMap(splitSlash);
  const layer: BackgroundLayer = {
    color: null,
    image: null,
    repeat: 'repeat',
    size: 'auto',
    attachment: 'scroll',
    position: null,
  };
  let seen = 0;
  const once = (bit: number): boolean => {
    if (seen & bit) return false;
    seen |= bit;
    return true;
  };
  let boxes = 0;
  for (let i = 0; i < parts.length;) {
    const part = parts[i];
    const v = part.toLowerCase();
    if (v === 'none' || v.startsWith('url(') || IMAGE_FUNCTION.test(v)) {
      if (!once(1)) return null;
      if (v.startsWith('url(')) {
        const url = parseUrl(part);
        if (url === undefined) return null;
        layer.image = url;
      }
      i += 1;
    } else if (v === 'repeat-x' || v === 'repeat-y' || REPEATS.has(v)) {
      if (!once(2)) return null;
      const pair = REPEATS.has(v) && REPEATS.has(parts[i + 1]?.toLowerCase());
      const repeat = readRepeat(pair ? [v, parts[i + 1].toLowerCase()] : [v]);
      if (!repeat) return null;
      layer.repeat = repeat;
      i += pair ? 2 : 1;
    } else if (v === 'scroll' || v === 'fixed' || v === 'local') {
      if (!once(4)) return null;
      layer.attachment = v;
      i += 1;
    } else if (
      v === 'border-box' ||
      v === 'padding-box' ||
      v === 'content-box'
    ) {
      if ((boxes += 1) > 2) return null;
      i += 1;
    } else if (isPositionPart(v, ctx)) {
      if (!once(8)) return null;
      let end = i;
      while (
        end < parts.length &&
        isPositionPart(parts[end].toLowerCase(), ctx)
      ) {
        end += 1;
      }
      layer.position = positionPair(parts.slice(i, end), ctx);
      if (!layer.position) return null;
      i = end;
      if (parts[i] !== '/') continue;
      // `/ <size>`: `cover`, `contain`, or one or two lengths, which have
      // nothing to be stored as and are read as `auto`
      const first = parts[i + 1]?.toLowerCase();
      if (first === 'cover' || first === 'contain') {
        layer.size = first;
        i += 2;
      } else if (first !== undefined && isSizePart(first, ctx)) {
        i += 2;
        if (i < parts.length && isSizePart(parts[i].toLowerCase(), ctx)) {
          i += 1;
        }
      } else {
        return null;
      }
    } else {
      const color = parseColor(part);
      if (color === null || !last || !once(16)) return null;
      layer.color = color;
      i += 1;
    }
  }
  return layer;
}

/** The images CSS3 has beyond `url()`, which a layer may name and this
 *  draws as nothing. */
const IMAGE_FUNCTION =
  /^(?:-(?:webkit|moz|o|ms)-)?(?:(?:repeating-)?(?:linear|radial|conic)-gradient|gradient|image-set|cross-fade|element|paint)\(/;

function isPositionPart(word: string, ctx: UnitContext): boolean {
  return (
    word in HORIZONTAL || word in VERTICAL || positionLength(word, ctx) !== null
  );
}

function isSizePart(word: string, ctx: UnitContext): boolean {
  if (word === 'auto') return true;
  const len = positionLength(word, ctx);
  if (len === null || len === AUTO) return false;
  return typeof len === 'number' ? len >= 0 : len.pct >= 0;
}

/** `center/cover` is three tokens, as `center / cover` is. */
function splitSlash(part: string): string[] {
  if (!part.includes('/') || part.includes('(')) return [part];
  return part.split(/(\/)/).filter(Boolean);
}

function applyFontShorthand(
  style: ComputedStyle,
  parent: ComputedStyle,
  value: string,
  ctx: UnitContext,
): void {
  // The `font: caption | menu | …` system forms name a font this renderer
  // has no table for; leaving the style alone is closer than guessing.
  const parts = splitValue(value);
  if (parts.length < 2) return;
  let fontStyle: ComputedStyle['fontStyle'] = 'normal';
  let weight: string | null = null;
  let i = 0;
  for (; i < parts.length; i += 1) {
    const v = parts[i].toLowerCase();
    if (v === 'italic' || v === 'oblique') fontStyle = v;
    else if (
      v === 'bold' ||
      v === 'bolder' ||
      v === 'lighter' ||
      /^\d{3}$/.test(v)
    ) {
      weight = v;
    } else if (v === 'normal' || v === 'small-caps') continue;
    else break;
  }
  // `12px/1.5`, or the same with space round the slash
  let [sizeText, lineText] = (parts[i] ?? '').split('/');
  let next = i + 1;
  if (lineText === '' || (lineText === undefined && parts[next]?.[0] === '/')) {
    const slash = lineText === undefined ? parts[next++].slice(1) : '';
    lineText = slash || parts[next++];
  }
  const family = parts.slice(next).join(' ');
  // A size and a family, or the value is not a font and the declaration is
  // dropped whole, as CSS drops any value it cannot read.
  const size =
    keywordFontSize(sizeText ?? '', parent.fontSize, ctx.rem) ??
    parseLength(sizeText ?? '', { ...ctx, em: parent.fontSize });
  if (!family || size === null || size === AUTO) return;
  // What the shorthand does not name goes back to its initial value rather
  // than keeping the parent's (CSS 2.1 15.8): `p { font: 12pt serif }`
  // inside a document set at `20px/1em` has lines of normal height, not 20px.
  style.fontStyle = fontStyle;
  style.fontWeight = weight ? parseWeight(weight, parent.fontWeight) : 400;
  style.lineHeight = 'normal';
  style.lineHeightIsLength = false;
  applyDeclaration(style, parent, 'font-size', sizeText, ctx);
  if (lineText) {
    applyDeclaration(style, parent, 'line-height', lineText, {
      ...ctx,
      em: style.fontSize,
    });
  }
  applyDeclaration(style, parent, 'font-family', family, ctx);
}

function applyFlexShorthand(
  style: ComputedStyle,
  value: string,
  ctx: UnitContext,
): void {
  const v = value.trim().toLowerCase();
  if (v === 'none') {
    style.flexGrow = 0;
    style.flexShrink = 0;
    style.flexBasis = AUTO;
    return;
  }
  if (v === 'auto') {
    style.flexGrow = 1;
    style.flexShrink = 1;
    style.flexBasis = AUTO;
    return;
  }
  const parts = splitValue(value);
  const numbers: number[] = [];
  let basis: Len | null = null;
  for (const part of parts) {
    const n = parseNumber(part);
    if (n !== null && numbers.length < 2 && !part.includes('%')) {
      numbers.push(n);
      continue;
    }
    const len = parseLength(part, ctx);
    if (len !== null) basis = len;
  }
  if (numbers.length) style.flexGrow = numbers[0];
  // `flex: 1` is grow 1, shrink 1, basis 0 — the single-number form's basis
  // is `0`, not `auto`, and getting that wrong makes every `flex: 1` sibling
  // size to its content instead of sharing the line.
  style.flexShrink = numbers.length > 1 ? numbers[1] : 1;
  style.flexBasis = basis ?? (numbers.length ? 0 : AUTO);
}

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

const INHERITED_NAMES = new Set<string>([
  'color',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'text-align',
  'text-indent',
  'text-transform',
  'letter-spacing',
  'word-spacing',
  'white-space',
  'direction',
  'visibility',
  'list-style',
  'list-style-type',
  'list-style-position',
  'cursor',
  'border-collapse',
  'border-spacing',
  'quotes',
]);

export function isInherited(name: string): boolean {
  return INHERITED_NAMES.has(name);
}

/** `prop: inherit` — take the parent's computed value for whatever longhands
 *  the property names. Shorthands copy each of their longhands. */
/** A property back to its initial value: what a declaration whose `var()`
 *  has no value comes to, where the property is not inherited. */
export function initialOne(
  style: ComputedStyle,
  initial: ComputedStyle,
  name: string,
): void {
  const keys = INHERIT_TARGETS[name];
  if (!keys) return;
  for (const key of keys) {
    (style as unknown as Record<string, unknown>)[key] = initial[key];
  }
}

function inheritOne(
  style: ComputedStyle,
  parent: ComputedStyle,
  name: string,
): void {
  const keys = INHERIT_TARGETS[name];
  if (!keys) return;
  // A border colour left to `currentColor` inherits as the keyword and
  // takes the child's own colour (CSS Color 4) — not the parent's colour,
  // which is what CSS 2.1 computed it to.
  for (const key of keys) {
    (style as unknown as Record<string, unknown>)[key] = parent[key];
  }
}

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const;
const sides = (
  make: (side: (typeof SIDES)[number]) => keyof ComputedStyle,
): (keyof ComputedStyle)[] => SIDES.map(make);

const INHERIT_TARGETS: Record<string, readonly (keyof ComputedStyle)[]> = {
  color: ['color'],
  'font-family': ['fontFamily'],
  'font-size': ['fontSize'],
  'font-weight': ['fontWeight'],
  'font-style': ['fontStyle'],
  // the unit travels with the height: a length inherited as a bare number
  // would be read as a multiple of the font size
  font: [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'lineHeight',
    'lineHeightIsLength',
  ],
  'line-height': ['lineHeight', 'lineHeightIsLength'],
  'text-align': ['textAlign', 'alignBlocks'],
  'text-indent': ['textIndent'],
  'text-transform': ['textTransform'],
  'letter-spacing': ['letterSpacing'],
  'word-spacing': ['wordSpacing'],
  'white-space': ['whiteSpace'],
  direction: ['direction'],
  'unicode-bidi': ['unicodeBidi'],
  visibility: ['visibility'],
  'list-style': ['listStyleType', 'listStylePosition'],
  'list-style-type': ['listStyleType'],
  'list-style-position': ['listStylePosition'],
  cursor: ['cursor'],
  'border-collapse': ['borderCollapse'],
  'caption-side': ['captionSide'],
  quotes: ['quotes'],
  content: ['content'],
  'counter-reset': ['counterReset'],
  'counter-increment': ['counterIncrement'],
  'border-spacing': ['borderSpacing', 'borderSpacingY'],
  display: ['display', 'flowRoot'],
  width: ['width'],
  height: ['height'],
  'min-width': ['minWidth'],
  'max-width': ['maxWidth'],
  'min-height': ['minHeight'],
  'max-height': ['maxHeight'],
  'box-sizing': ['boxSizing'],
  margin: sides((s) => `margin${s}`),
  'margin-top': ['marginTop'],
  'margin-right': ['marginRight'],
  'margin-bottom': ['marginBottom'],
  'margin-left': ['marginLeft'],
  padding: sides((s) => `padding${s}`),
  'padding-top': ['paddingTop'],
  'padding-right': ['paddingRight'],
  'padding-bottom': ['paddingBottom'],
  'padding-left': ['paddingLeft'],
  border: [
    ...sides((s) => `border${s}Width`),
    ...sides((s) => `border${s}Style`),
    ...sides((s) => `border${s}Color`),
  ],
  'border-width': sides((s) => `border${s}Width`),
  'border-style': sides((s) => `border${s}Style`),
  'border-color': sides((s) => `border${s}Color`),
  ...Object.fromEntries(
    SIDES.flatMap((s) => {
      const side = s.toLowerCase();
      return [
        [
          `border-${side}`,
          [`border${s}Width`, `border${s}Style`, `border${s}Color`],
        ],
        [`border-${side}-width`, [`border${s}Width`]],
        [`border-${side}-style`, [`border${s}Style`]],
        [`border-${side}-color`, [`border${s}Color`]],
      ];
    }),
  ),
  'border-radius': ['borderRadius'],
  background: [
    'backgroundColor',
    'backgroundImage',
    'backgroundRepeat',
    'backgroundSize',
    'backgroundAttachment',
    'backgroundPositionX',
    'backgroundPositionY',
  ],
  'background-color': ['backgroundColor'],
  'background-image': ['backgroundImage'],
  'background-repeat': ['backgroundRepeat'],
  'background-size': ['backgroundSize'],
  'background-attachment': ['backgroundAttachment'],
  'background-position': ['backgroundPositionX', 'backgroundPositionY'],
  position: ['position'],
  top: ['top'],
  right: ['right'],
  bottom: ['bottom'],
  left: ['left'],
  float: ['float'],
  clear: ['clear'],
  overflow: ['overflowX', 'overflowY'],
  clip: ['clip'],
  'overflow-x': ['overflowX'],
  'overflow-y': ['overflowY'],
  opacity: ['opacity'],
  'z-index': ['zIndex'],
  'vertical-align': ['verticalAlign'],
  'text-decoration': [
    'textDecorationLine',
    'textDecorationColor',
    'textDecorationStyle',
  ],
  'text-decoration-line': ['textDecorationLine'],
  'text-decoration-style': ['textDecorationStyle'],
  'table-layout': ['tableLayout'],
};

/**
 * The decorations a box's text is drawn with (CSS 2.1 16.3.1): those its
 * ancestors propagate to it, and its own, each in the colour of the box that
 * set it, so an underlined link's `<strong>` is underlined in the link's
 * colour. A float, an absolutely positioned box and an atomic inline box —
 * an inline block, table or flex box — take none from above, and `none`
 * takes none away. After `blockify`, whose `float` and `position` it reads.
 */
export function decorate(style: ComputedStyle): void {
  const display = style.display;
  if (
    style.float !== 'none' ||
    style.position === 'absolute' ||
    style.position === 'fixed' ||
    display === 'inline-block' ||
    display === 'inline-table' ||
    display === 'inline-flex'
  ) {
    style.underline = null;
    style.lineThrough = null;
  }
  const own = style.textDecorationLine;
  if (own === 'underline') {
    style.underline = inkColor(
      style.textDecorationColor ?? 'currentColor',
      style.color,
    );
    style.underlineStyle = style.textDecorationStyle;
  } else if (own === 'line-through') {
    style.lineThrough = inkColor(
      style.textDecorationColor ?? 'currentColor',
      style.color,
    );
  }
}

/**
 * The blockification the box tree depends on: a floated or absolutely
 * positioned element is a block whatever `display` said, and a flex item's
 * `display: inline` is a block too. Applied after the cascade rather than
 * during it, because it depends on the *final* `float` and `position`.
 */
export function blockify(style: ComputedStyle, inFlexContainer: boolean): void {
  const out = style.display;
  if (out === 'none') return;
  const isOutOfFlow =
    style.float !== 'none' ||
    style.position === 'absolute' ||
    style.position === 'fixed';
  if (!isOutOfFlow && !inFlexContainer) return;
  switch (out) {
    case 'inline':
    case 'inline-block':
    case 'table-cell':
    case 'table-row':
    case 'table-row-group':
    case 'table-header-group':
    case 'table-footer-group':
    case 'table-caption':
    case 'table-column':
    case 'table-column-group':
      style.display = 'block';
      return;
    case 'inline-flex':
      style.display = 'flex';
      return;
    case 'inline-table':
      style.display = 'table';
      return;
    default:
      return;
  }
}
