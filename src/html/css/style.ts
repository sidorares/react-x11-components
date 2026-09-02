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
  keywordFontSize,
  parseAlpha,
  parseColor,
  parseLength,
  parseNumber,
  parseUrl,
  parseWeight,
  splitCommas,
  splitValue,
} from './values.js';
import type { Len, UnitContext } from './values.js';

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
  textIndent: Len;
  textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  letterSpacing: number;
  wordSpacing: number;
  whiteSpace: 'normal' | 'nowrap' | 'pre' | 'pre-wrap' | 'pre-line';
  direction: 'ltr' | 'rtl';
  visibility: 'visible' | 'hidden';
  listStyleType: string;
  listStylePosition: 'inside' | 'outside';
  cursor: string | null;
  borderCollapse: 'separate' | 'collapse';
  borderSpacing: number;
  /** Inherited so a `<td>` picks up the table's, which is how authors expect
   *  `text-align` on a `<table>` to behave. */
  tableTextAlignSet: boolean;

  // --- not inherited --------------------------------------------------------
  display: Display;
  position: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';
  float: 'none' | 'left' | 'right';
  clear: 'none' | 'left' | 'right' | 'both';
  boxSizing: 'content-box' | 'border-box';
  overflowX: 'visible' | 'hidden' | 'scroll' | 'auto';
  overflowY: 'visible' | 'hidden' | 'scroll' | 'auto';
  opacity: number;
  zIndex: number | 'auto';
  verticalAlign:
    'baseline' | 'top' | 'middle' | 'bottom' | 'sub' | 'super' | number;

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
  backgroundPositionX: Len;
  backgroundPositionY: Len;

  textDecorationLine: 'none' | 'underline' | 'line-through' | 'overline';
  textDecorationColor: string | null;
  textDecorationStyle: 'solid' | 'double' | 'dotted' | 'dashed' | 'wavy';

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
  'tableTextAlignSet',
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

export function initialStyle(look: RootLook): ComputedStyle {
  return {
    color: look.color,
    fontFamily: look.fontFamily,
    fontSize: look.fontSize,
    fontWeight: 400,
    fontStyle: 'normal',
    lineHeight: 'normal',
    lineHeightIsLength: false,
    textAlign: 'start',
    textIndent: 0,
    textTransform: 'none',
    letterSpacing: 0,
    wordSpacing: 0,
    whiteSpace: 'normal',
    direction: 'ltr',
    visibility: 'visible',
    listStyleType: 'disc',
    listStylePosition: 'outside',
    cursor: null,
    borderCollapse: 'separate',
    borderSpacing: 2,
    tableTextAlignSet: false,

    display: 'inline',
    position: 'static',
    float: 'none',
    clear: 'none',
    boxSizing: 'content-box',
    overflowX: 'visible',
    overflowY: 'visible',
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

    borderTopWidth: 0,
    borderRightWidth: 0,
    borderBottomWidth: 0,
    borderLeftWidth: 0,
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
    backgroundPositionX: 0,
    backgroundPositionY: 0,

    textDecorationLine: 'none',
    textDecorationColor: null,
    textDecorationStyle: 'solid',

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
    // `color: currentColor` is the one place the token refers to itself; it
    // means "keep the inherited colour", which the style already holds.
    if (name === 'color' && parsed === 'currentColor') return;
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
      else if (DISPLAYS.has(v)) style.display = v as Display;
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
      if (value.toLowerCase() === 'auto') style.zIndex = AUTO;
      else {
        const n = parseNumber(value);
        if (n !== null) style.zIndex = Math.trunc(n);
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
        v === 'super'
      ) {
        style.verticalAlign = v;
      } else {
        const len = parseLength(value, ctx);
        if (typeof len === 'number') style.verticalAlign = len;
      }
      return;
    }

    // --- geometry -----------------------------------------------------------
    case 'width':
    case 'height':
    case 'min-width':
    case 'min-height': {
      const len = parseLength(value, ctx);
      if (len !== null)
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
      if (len !== null)
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
      const sides = fourSides(parts as Len[]);
      // `padding: auto` is not a thing; a stray one computes to zero rather
      // than making layout branch on an impossible value.
      for (let i = 0; i < 4; i += 1) {
        const v = name === 'padding' && sides[i] === AUTO ? 0 : sides[i];
        (style as unknown as Record<string, unknown>)[keys[i]] = v;
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
      const isPadding = name.startsWith('padding');
      (style as unknown as Record<string, unknown>)[camel(name)] =
        isPadding && len === AUTO ? 0 : len;
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
      style.backgroundImage = parseUrl(splitCommas(value)[0]);
      return;
    }
    case 'background-repeat': {
      const v = value.toLowerCase().trim();
      if (
        v === 'repeat' ||
        v === 'repeat-x' ||
        v === 'repeat-y' ||
        v === 'no-repeat'
      ) {
        style.backgroundRepeat = v;
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
      const parts = splitValue(value);
      const x = backgroundPosition(parts[0], ctx);
      const y = backgroundPosition(parts[1] ?? 'center', ctx);
      if (x !== null) style.backgroundPositionX = x;
      if (y !== null) style.backgroundPositionY = y;
      return;
    }

    // --- text ---------------------------------------------------------------
    case 'font': {
      applyFontShorthand(style, parent, value, ctx);
      return;
    }
    case 'font-family': {
      // ntk's font matcher takes the CSS list as written and walks it, so the
      // value passes through whole rather than being resolved here.
      style.fontFamily = splitCommas(value)
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
      const len = parseLength(value, { ...ctx, em: parent.fontSize });
      if (typeof len === 'number') style.fontSize = Math.max(1, len);
      else if (len && typeof len === 'object') {
        style.fontSize = Math.max(1, (len.pct / 100) * parent.fontSize);
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
        style.lineHeight = (len.pct / 100) * style.fontSize;
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
    case 'border-spacing': {
      const len = parseLength(splitValue(value)[0] ?? '', ctx);
      if (typeof len === 'number') style.borderSpacing = len;
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
  return typeof len === 'number' ? Math.max(0, len) : null;
}

function backgroundPosition(
  value: string | undefined,
  ctx: UnitContext,
): Len | null {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'left' || v === 'top') return 0;
  if (v === 'center') return { pct: 50 };
  if (v === 'right' || v === 'bottom') return { pct: 100 };
  const len = parseLength(v, ctx);
  return len === AUTO ? 0 : len;
}

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
  let width: number | null = 3;
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
    if (c !== null) color = c;
  }
  // A shorthand with a style but no width takes the initial `medium`; one
  // with neither paints nothing, so the width is irrelevant.
  const effective =
    borderStyle === 'none' || borderStyle === 'hidden' ? 0 : (width ?? 3);
  for (const side of sides) {
    (style as unknown as Record<string, unknown>)[`border${side}Width`] =
      effective;
    (style as unknown as Record<string, unknown>)[`border${side}Style`] =
      borderStyle;
    if (color !== null)
      (style as unknown as Record<string, unknown>)[`border${side}Color`] =
        color;
  }
}

function applyBackgroundShorthand(
  style: ComputedStyle,
  value: string,
  ctx: UnitContext,
): void {
  // Only the last layer paints against the box, so a multi-layer background
  // reduces to its last comma group rather than being dropped.
  const layer = splitCommas(value).pop() ?? '';
  style.backgroundColor = null;
  style.backgroundImage = null;
  style.backgroundRepeat = 'repeat';
  style.backgroundSize = 'auto';
  const positions: Len[] = [];
  for (const part of splitValue(layer)) {
    const v = part.toLowerCase();
    if (v.startsWith('url(')) {
      style.backgroundImage = parseUrl(part);
      continue;
    }
    if (
      v === 'repeat' ||
      v === 'repeat-x' ||
      v === 'repeat-y' ||
      v === 'no-repeat'
    ) {
      style.backgroundRepeat = v;
      continue;
    }
    if (v === 'cover' || v === 'contain') {
      style.backgroundSize = v;
      continue;
    }
    if (
      v === 'border-box' ||
      v === 'padding-box' ||
      v === 'content-box' ||
      v === 'fixed' ||
      v === 'scroll' ||
      v === 'local'
    ) {
      continue;
    }
    const c = parseColor(part);
    if (c !== null) {
      style.backgroundColor = c;
      continue;
    }
    const pos = backgroundPosition(part, ctx);
    if (pos !== null) positions.push(pos);
  }
  if (positions.length) {
    style.backgroundPositionX = positions[0];
    style.backgroundPositionY = positions[1] ?? { pct: 50 };
  }
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
  let i = 0;
  for (; i < parts.length; i += 1) {
    const v = parts[i].toLowerCase();
    if (v === 'italic' || v === 'oblique') style.fontStyle = v;
    else if (
      v === 'bold' ||
      v === 'bolder' ||
      v === 'lighter' ||
      /^\d{3}$/.test(v)
    ) {
      style.fontWeight = parseWeight(v, parent.fontWeight);
    } else if (v === 'normal' || v === 'small-caps') continue;
    else break;
  }
  const sizePart = parts[i];
  if (!sizePart) return;
  const [sizeText, lineText] = sizePart.split('/');
  applyDeclaration(style, parent, 'font-size', sizeText, ctx);
  if (lineText) {
    applyDeclaration(style, parent, 'line-height', lineText, {
      ...ctx,
      em: style.fontSize,
    });
  }
  const family = parts.slice(i + 1).join(' ');
  if (family) applyDeclaration(style, parent, 'font-family', family, ctx);
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
]);

function isInherited(name: string): boolean {
  return INHERITED_NAMES.has(name);
}

/** `prop: inherit` — take the parent's computed value for whatever longhands
 *  the property names. Shorthands copy each of their longhands. */
function inheritOne(
  style: ComputedStyle,
  parent: ComputedStyle,
  name: string,
): void {
  const keys = INHERIT_TARGETS[name];
  if (!keys) return;
  for (const key of keys) {
    (style as unknown as Record<string, unknown>)[key] = parent[key];
  }
}

const INHERIT_TARGETS: Record<string, readonly (keyof ComputedStyle)[]> = {
  color: ['color'],
  'font-family': ['fontFamily'],
  'font-size': ['fontSize'],
  'font-weight': ['fontWeight'],
  'font-style': ['fontStyle'],
  font: ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight'],
  'line-height': ['lineHeight', 'lineHeightIsLength'],
  'text-align': ['textAlign'],
  'text-indent': ['textIndent'],
  'text-transform': ['textTransform'],
  'letter-spacing': ['letterSpacing'],
  'word-spacing': ['wordSpacing'],
  'white-space': ['whiteSpace'],
  direction: ['direction'],
  visibility: ['visibility'],
  'list-style': ['listStyleType', 'listStylePosition'],
  'list-style-type': ['listStyleType'],
  'list-style-position': ['listStylePosition'],
  cursor: ['cursor'],
  'border-collapse': ['borderCollapse'],
  'border-spacing': ['borderSpacing'],
  display: ['display'],
  width: ['width'],
  height: ['height'],
  'background-color': ['backgroundColor'],
};

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
