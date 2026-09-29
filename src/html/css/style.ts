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
  alphaOf,
  fourSides,
  inkColor,
  isTransparent,
  keywordFontSize,
  parseAlpha,
  parseColor,
  isPct,
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
  parseListStyleType,
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
  | 'table-column-group'
  | 'contents';

/** A grid track's sizing: its minimum and maximum sizing functions (CSS
 *  Grid 1, 7.2.3). A plain length is both; `auto` is a minimum of the
 *  items' min-content and a maximum of their max-content. */
export interface GridTrack {
  min: Len | 'min-content' | 'max-content';
  /** `fit-content()`'s argument is `fit`. */
  max: Len | 'min-content' | 'max-content' | { fr: number } | { fit: Len };
}

/** `grid-template-columns` or `-rows`: its tracks and the names of the
 *  lines between them — `names[i]` the line's before track `i`, and the
 *  last the line's after the last track — and a `repeat()` whose count the
 *  width decides (`auto-fill`, `auto-fit`): where it goes, its tracks and
 *  its own lines' names, and the names of the line after it. */
export interface GridTemplate {
  tracks: GridTrack[];
  names: string[][];
  repeat: {
    at: number;
    tracks: GridTrack[];
    names: string[][];
    after: string[];
  } | null;
}

/** `grid-template-areas` (CSS Grid 1, 7.3): how many rows and columns its
 *  strings make, and each named area's lines, from zero, start and end. */
export interface GridAreas {
  rows: number;
  columns: number;
  areas: Map<string, { rows: [number, number]; columns: [number, number] }>;
}

/** One of a `box-shadow`'s shadows, in device pixels. */
export interface BoxShadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  /** A colour as `parseColor` leaves it, `currentColor` included. */
  color: string;
  inset: boolean;
}

/** A `linear-gradient()` (CSS Images 3, 3.1): its direction, an angle
 *  clockwise from up or a corner the box's shape turns into one, and its
 *  colour stops, each at a position or where its neighbours put it. */
export interface LinearGradient {
  angle: number;
  corner: 'top left' | 'top right' | 'bottom left' | 'bottom right' | null;
  stops: { color: string; at: Len | null }[];
}

/** Where a grid item starts or ends (CSS Grid 1, 8.3): a line, counted
 *  among the lines of a name where it has one; a span, to a line of a name
 *  where it has one; a name alone, an area's edge or a line's; or auto. */
export type GridLine =
  | { line: number; name?: string }
  | { span: number; name?: string }
  | { name: string }
  | null;

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

/** A background layer's image: a url, a gradient, or none. */
export type BackgroundImage = string | LinearGradient | null;

/** An intrinsic size: `min-content`, `max-content` or `fit-content`, and
 *  `fit-content()`, whose argument stands in for the room (`fit`). */
export type ContentSize =
  'min-content' | 'max-content' | 'fit-content' | { fit: Len };

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
  /** How a block's last line is aligned, and each line a forced break ends
   *  (CSS Text 3, 7.2); `auto` is as `textAlign` has it, but `justify`,
   *  which leaves those lines at the start. */
  textAlignLast:
    'auto' | 'left' | 'right' | 'center' | 'justify' | 'start' | 'end';
  /** `none` turns justification off, the lines `justify` sets going to the
   *  start (CSS Text 3, 7.4); the rest space the words apart. */
  textJustify: 'auto' | 'none' | 'inter-word' | 'inter-character';
  /** Where an element aligns the blocks in it that fill no line of their
   *  own and have no auto margin: HTML's `<center>` and `align`, and the
   *  `-webkit-center` that browsers spell them as. Inherited with
   *  `text-align`, which resets it. */
  alignBlocks: 'left' | 'right' | 'center' | null;
  textIndent: Len;
  textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  letterSpacing: number;
  wordSpacing: number;
  /** The shadows its text casts, front to back, as `boxShadow`'s are but
   *  with no spread and never inset; null for none. Inherited. */
  textShadow: BoxShadow[] | null;
  /** The OpenType features the `font-variant` longhands, `font-kerning`
   *  and `font-feature-settings` ask for, each as `tag=value` pairs joined
   *  by commas, and '' for none: strings, so that equal ones are equal,
   *  and a run's features are found by them (`featuresOf`). */
  fontVariantNumeric: string;
  fontVariantCaps: string;
  fontVariantLigatures: string;
  fontVariantPosition: string;
  fontKerning: string;
  fontFeatureSettings: string;
  /** Where a kept tab's stops are (CSS Text 3, 4.2): every so many spaces,
   *  or every so many pixels where `tabSizeIsLength`. */
  tabSize: number;
  tabSizeIsLength: boolean;
  whiteSpace: 'normal' | 'nowrap' | 'pre' | 'pre-wrap' | 'pre-line';
  /** Whether a word too long for its line may be cut inside itself
   *  (`overflow-wrap`, CSS Text 3, 5.5): `normal` lets it run past the
   *  line's end, as a browser does, and `anywhere` is `break-word`. */
  overflowWrap: 'normal' | 'break-word';
  /** `word-break` (CSS Text 3, 5.2): `break-all` and `break-word` cut a
   *  word too long for its line whatever `overflow-wrap` says, which is
   *  as near as the engines come to breaking between any two letters. */
  wordBreak: 'normal' | 'break-all' | 'keep-all' | 'break-word';
  /** `line-break: anywhere` (CSS Text 3, 5.3) breaks between any two
   *  letters, which the engines come nearest to by cutting a word where
   *  its line runs out; the other values are the engine's own breaking. */
  lineBreakAnywhere: boolean;
  /** `text-wrap-style` (CSS Text 4, 6.2): `balance` evens a short
   *  paragraph's lines out; `pretty` and `stable` wrap as `auto` does. */
  textWrapStyle: 'auto' | 'balance';
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
  /** `collapse` is `hidden` but on a table's rows, which it takes out of
   *  the table (CSS 2.1 17.5.5); paint draws `visible` only. */
  visibility: 'visible' | 'hidden' | 'collapse';
  listStyleType: string;
  listStylePosition: 'inside' | 'outside';
  /** `list-style-image`: an image a list item's marker is, where it loads,
   *  in place of its `list-style-type`'s; null for `none`. */
  listStyleImage: string | null;
  cursor: string | null;
  borderCollapse: 'separate' | 'collapse';
  /** `border-spacing`: between columns, and between rows. */
  borderSpacing: number;
  borderSpacingY: number;
  captionSide: 'top' | 'bottom';
  /** `empty-cells` (CSS 2.1 17.6.1.1): `hide` draws no background and no
   *  borders for a cell with nothing in it, where borders are separate. */
  emptyCells: 'show' | 'hide';
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
  /** Whether a block is a line-clamp container, and how many lines of its
   *  formatting context it shows (CSS Overflow 4, 5.3.1): its `max-lines`,
   *  or Infinity for `line-clamp: auto`, which shows as many as its height
   *  holds; null for a box that clamps nothing. Settled from the longhands
   *  below once the cascade is done (`settleClamp`), since whether
   *  `-webkit-line-clamp` counts depends on `display` and
   *  `-webkit-box-orient`. */
  lineClamp: number | null;
  /** `max-lines`, which `line-clamp` sets: null for `none`. */
  maxLines: number | null;
  /** `continue`: `collapse` hides what is past the clamp point, and
   *  `-webkit-line-clamp`'s `-webkit-legacy` does so only in a vertical
   *  `-webkit-box`; `discard` is read as `collapse`. */
  clampContinue: 'auto' | 'collapse' | 'legacy';
  /** `block-ellipsis`, inherited: whether the line before a clamp point
   *  ends in an ellipsis. */
  blockEllipsis: boolean;
  /** `display: -webkit-box` (`block`) or `-webkit-inline-box`, as
   *  specified: the legacy flexible box, a flex box whose direction is
   *  `-webkit-box-orient`'s, or where it clamps its lines vertically, a
   *  block of its own formatting context (`settleClamp`). */
  webkitBox: 'block' | 'inline' | null;
  webkitBoxOrient: 'horizontal' | 'vertical';
  webkitBoxDirection: 'normal' | 'reverse';
  /** `-webkit-box-pack` and `-webkit-box-align`, which such a box takes
   *  for `justify-content` and `align-items`; null where unset. */
  webkitBoxPack: ComputedStyle['justifyContent'] | null;
  webkitBoxAlign: ComputedStyle['alignItems'] | null;
  /** `-webkit-box-flex`: how an item of a `-webkit-box` grows and shrinks,
   *  which is not at all unless it is set. */
  webkitBoxFlex: number;
  /** Whether `column-count` (1) or `column-width` (2) makes the box a
   *  multicol container, which this lays out as one column and which
   *  `line-clamp` does not clamp (CSS Overflow 4, 5.2). */
  columns: number;
  /** How a line cut by `overflow` ends: `clip`, or with an ellipsis. */
  textOverflow: 'clip' | 'ellipsis';
  /** `aspect-ratio`: a box's width over its height, where its height is
   *  `auto`; `auto` beside it, as `auto 16 / 9`, gives a replaced element
   *  its own where it has one. Null for `auto` alone. */
  aspectRatio: { ratio: number; auto: boolean } | null;
  /** How an image fills its content box, and where in it. */
  objectFit: 'fill' | 'contain' | 'cover' | 'none' | 'scale-down';
  /** A form control's own look (`auto`), or `none`: the page draws it,
   *  with its own background, borders and padding (`ControlFace`). */
  appearance: 'auto' | 'none';
  objectPositionX: Len;
  objectPositionY: Len;
  overflowX: 'visible' | 'hidden' | 'scroll' | 'auto' | 'clip';
  overflowY: 'visible' | 'hidden' | 'scroll' | 'auto' | 'clip';
  /** `clip: rect(…)`: the part of an absolutely positioned box that shows,
   *  its edges measured from the border box's top left, a null edge the
   *  border box's own (CSS 2.1 11.1.2). Null for `auto`. */
  clip: ClipRect | null;
  opacity: number;
  /** Where `translate` moves the box after layout (CSS Transforms 2): a
   *  length or a percentage of its own border box across and down; null
   *  for `none`. */
  translate: [Len, Len] | null;
  /** The translation in its `transform`, the one part of a transform
   *  this draws — rotating, scaling and skewing are not; null for `none`.
   *  Either makes the box a containing block and paints it with the
   *  positioned boxes, as a transform does. */
  transformTranslate: [Len, Len] | null;
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
  /** `width`, `min-width` and `max-width` as an intrinsic size (CSS Sizing
   *  3, 3.1): the box's content's, where the length beside it is `auto`
   *  or `none` so that what does not know these sizes the box as though it
   *  had none; null for a length or a percentage. A height of one is its
   *  content's, which is what `auto` already is. */
  widthKeyword: ContentSize | null;
  minWidthKeyword: ContentSize | null;
  maxWidthKeyword: ContentSize | null;
  /** `min-height` as one: the content's height, which a flex item in a
   *  column is no shorter than whatever its `overflow` (`flex.ts`). */
  minHeightKeyword: ContentSize | null;
  /** `height` as one, which is its content's as `auto` is — but it is not
   *  `auto`, and what stretches an item of `auto` height does not stretch
   *  it (CSS Grid 1, 10.3). */
  heightKeyword: ContentSize | null;

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
  /** The corners' horizontal radii — top-left, top-right, bottom-right,
   *  bottom-left — each a length or a percentage of the border box's
   *  width. */
  borderRadius: [Len, Len, Len, Len];
  /** Their vertical radii, percentages of its height, where `/` wrote
   *  them apart; null where they are the same values, as almost always. */
  borderRadiusY: [Len, Len, Len, Len] | null;
  /** Its shadows front to back, the ones that can be seen; null for none. */
  boxShadow: BoxShadow[] | null;
  /** Its outline (CSS 2.1 18.4, CSS UI 4): drawn around the border box,
   *  grown by `outlineOffset`, taking no room; `auto` is drawn solid. */
  outlineStyle: BorderStyle | 'auto';
  outlineWidth: number;
  outlineColor: string;
  outlineOffset: number;

  top: Len;
  right: Len;
  bottom: Len;
  left: Len;

  backgroundColor: string | null;
  backgroundImage: string | null;
  /** A background drawn rather than fetched: the first layer's linear
   *  gradient, where it is one. */
  backgroundGradient: LinearGradient | null;
  backgroundRepeat: 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat';
  /** `auto`, `cover`, `contain`, or a width and a height, either of which
   *  may be `auto` (CSS Backgrounds 3, 3.9). */
  backgroundSize: 'auto' | 'cover' | 'contain' | [Len | 'auto', Len | 'auto'];
  backgroundAttachment: 'scroll' | 'fixed' | 'local';
  backgroundPositionX: Len;
  backgroundPositionY: Len;
  /** Where a background has more than one layer (CSS Backgrounds 3, 2.1),
   *  each layer's image, top first; null where it has one, which the fields
   *  above are. The four lists after it are the same for the others: all of
   *  a property's values where it has more than one, which the layers take
   *  in turn, and over again where there are fewer than the images. The
   *  fields above are the first of each. */
  backgroundImages: BackgroundImage[] | null;
  backgroundRepeats: ComputedStyle['backgroundRepeat'][] | null;
  backgroundSizes: ComputedStyle['backgroundSize'][] | null;
  backgroundAttachments: ComputedStyle['backgroundAttachment'][] | null;
  backgroundPositions: [Len, Len][] | null;
  /** `background-clip: text` (CSS Backgrounds 4): the background is
   *  painted through the element's text rather than behind its box. */
  backgroundClipText: boolean;
  /** `-webkit-text-fill-color`: what the glyphs are filled with where it
   *  is not the text's `color` — Tailwind's `text-transparent` over a
   *  `bg-clip-text` gradient; null for `color`, as `currentColor` is. */
  textFillColor: string | null;

  /** `none`, or the lines drawn, space-separated in the order written:
   *  `underline line-through` draws both. */
  textDecorationLine: string;
  textDecorationColor: string | null;
  textDecorationStyle: 'solid' | 'double' | 'dotted' | 'dashed' | 'wavy';
  /** `text-decoration-thickness`, or null for `auto` and `from-font`. */
  textDecorationThickness: number | null;
  /** `text-underline-offset`, from the alphabetic baseline down, or null
   *  for `auto`. Inherited. */
  textUnderlineOffset: number | null;
  /** What this box's text is drawn with: its own `text-decoration` and the
   *  ones its ancestors propagate to it, each in the colour of the box that
   *  set it (`decorate`). No property: the cascade works them out. */
  underline: string | null;
  underlineStyle: 'solid' | 'double' | 'dotted' | 'dashed' | 'wavy';
  /** And the underline's thickness and offset, the box's that set it. */
  underlineThickness: number | null;
  underlineOffset: number | null;
  lineThrough: string | null;

  // flex — handed to yoga rather than interpreted here
  flexDirection: 'row' | 'row-reverse' | 'column' | 'column-reverse';
  flexWrap: 'nowrap' | 'wrap' | 'wrap-reverse';
  /** `start` and `end` are the writing mode's, and `left` and `right`
   *  the page's sides, which a flex box resolves against its direction
   *  (`flex.ts`); `flex-start` and `flex-end` are its main axis's. */
  justifyContent:
    | 'normal'
    | 'stretch'
    | 'flex-start'
    | 'flex-end'
    | 'start'
    | 'end'
    | 'left'
    | 'right'
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

  // grid (CSS Grid 1): a grid container is a flex box to the box tree, and
  // laid out by `layout/css-grid.ts`
  grid: boolean;
  gridColumns: GridTemplate | null;
  gridRows: GridTemplate | null;
  gridAutoRows: GridTrack;
  /** `grid-auto-columns`: a column the placement makes past the template. */
  gridAutoColumns: GridTrack;
  /** `grid-template-areas`, which also names the lines at their edges. */
  gridAreas: GridAreas | null;
  /** `grid-auto-flow`: which way the placement fills the grid, and whether
   *  it goes back for the holes it left. */
  gridAutoFlow: 'row' | 'column' | 'row dense' | 'column dense';
  gridColumnStart: GridLine;
  gridColumnEnd: GridLine;
  gridRowStart: GridLine;
  gridRowEnd: GridLine;
  justifyItems: 'stretch' | 'flex-start' | 'flex-end' | 'center';
  justifySelf: 'auto' | 'stretch' | 'flex-start' | 'flex-end' | 'center';

  tableLayout: 'auto' | 'fixed';

  // generated content (CSS 2.1 12)
  /** What a `::before` or `::after` holds; `normal` and `none` make none. */
  content: ContentItem[] | 'normal' | 'none';
  counterReset: CounterChange[] | null;
  counterIncrement: CounterChange[] | null;
  counterSet: CounterChange[] | null;
}

/** The properties that inherit. Named once, so `inherit()` and the `inherit`
 *  keyword cannot disagree about the list. */
/** The fields a style takes from its parent's (CSS 2.1's "Inherited:
 *  yes"), which `inherit` copies one by one; the test holds the two to the
 *  same list. */
export const INHERITED = [
  'color',
  'textFillColor',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'lineHeightIsLength',
  'textAlign',
  'textAlignLast',
  'textJustify',
  'blockEllipsis',
  'alignBlocks',
  'textIndent',
  'textTransform',
  'textUnderlineOffset',
  'letterSpacing',
  'wordSpacing',
  'textShadow',
  'fontVariantNumeric',
  'fontVariantCaps',
  'fontVariantLigatures',
  'fontVariantPosition',
  'fontKerning',
  'fontFeatureSettings',
  'tabSize',
  'tabSizeIsLength',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
  'lineBreakAnywhere',
  'textWrapStyle',
  'direction',
  'visibility',
  'listStyleType',
  'listStylePosition',
  'listStyleImage',
  'cursor',
  'borderCollapse',
  'borderSpacing',
  'borderSpacingY',
  'captionSide',
  'emptyCells',
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
  // a copy of the literal, not the literal: see `copyStyle`
  return copyStyle({
    color: look.color,
    fontFamily: look.fontFamily,
    fontSize: look.fontSize,
    fontWeight: 400,
    fontStyle: 'normal',
    lineHeight: 'normal',
    lineHeightIsLength: false,
    textAlign: 'start',
    textAlignLast: 'auto',
    textJustify: 'auto',
    alignBlocks: null,
    textIndent: 0,
    textTransform: 'none',
    letterSpacing: 0,
    wordSpacing: 0,
    textShadow: null,
    fontVariantNumeric: '',
    fontVariantCaps: '',
    fontVariantLigatures: '',
    fontVariantPosition: '',
    fontKerning: '',
    fontFeatureSettings: '',
    tabSize: 8,
    tabSizeIsLength: false,
    whiteSpace: 'normal',
    overflowWrap: 'normal',
    wordBreak: 'normal',
    lineBreakAnywhere: false,
    textWrapStyle: 'auto',
    direction: 'ltr',
    unicodeBidi: 'normal',
    visibility: 'visible',
    listStyleType: 'disc',
    listStylePosition: 'outside',
    listStyleImage: null,
    cursor: null,
    borderCollapse: 'separate',
    // CSS's initial value; a `<table>` gets its 2px from the UA sheet, and
    // an anonymous table, which no sheet names, has none
    borderSpacing: 0,
    borderSpacingY: 0,
    captionSide: 'top',
    emptyCells: 'show',
    tableTextAlignSet: false,
    quotes: DEFAULT_QUOTES,
    custom: null,

    display: 'inline',
    flowRoot: false,
    position: 'static',
    float: 'none',
    clear: 'none',
    boxSizing: 'content-box',
    lineClamp: null,
    maxLines: null,
    clampContinue: 'auto',
    blockEllipsis: false,
    webkitBox: null,
    webkitBoxOrient: 'horizontal',
    webkitBoxDirection: 'normal',
    webkitBoxPack: null,
    webkitBoxAlign: null,
    webkitBoxFlex: 0,
    columns: 0,
    textOverflow: 'clip',
    aspectRatio: null,
    objectFit: 'fill',
    appearance: 'auto',
    objectPositionX: { pct: 50 },
    objectPositionY: { pct: 50 },
    overflowX: 'visible',
    overflowY: 'visible',
    clip: null,
    opacity: 1,
    translate: null,
    transformTranslate: null,
    zIndex: AUTO,
    verticalAlign: 'baseline',

    width: AUTO,
    height: AUTO,
    // `auto`, which is 0 but for a flex item (CSS Flexbox 4.5): what
    // `min-w-0` undoes has to be told from what it is set to
    minWidth: AUTO,
    maxWidth: 'none',
    minHeight: AUTO,
    maxHeight: 'none',
    widthKeyword: null,
    minWidthKeyword: null,
    minHeightKeyword: null,
    maxWidthKeyword: null,
    heightKeyword: null,

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
    borderRadiusY: null,
    boxShadow: null,
    outlineStyle: 'none',
    outlineWidth: medium,
    outlineColor: 'currentColor',
    outlineOffset: 0,

    top: AUTO,
    right: AUTO,
    bottom: AUTO,
    left: AUTO,

    backgroundColor: null,
    backgroundImage: null,
    backgroundGradient: null,
    backgroundRepeat: 'repeat',
    backgroundSize: 'auto',
    backgroundAttachment: 'scroll',
    backgroundPositionX: 0,
    backgroundPositionY: 0,
    backgroundImages: null,
    backgroundRepeats: null,
    backgroundSizes: null,
    backgroundAttachments: null,
    backgroundPositions: null,
    backgroundClipText: false,
    textFillColor: null,

    textDecorationLine: 'none',
    textDecorationColor: null,
    textDecorationStyle: 'solid',
    textDecorationThickness: null,
    textUnderlineOffset: null,
    underline: null,
    underlineStyle: 'solid',
    underlineThickness: null,
    underlineOffset: null,
    lineThrough: null,

    flexDirection: 'row',
    flexWrap: 'nowrap',
    justifyContent: 'normal',
    alignItems: 'stretch',
    alignSelf: 'auto',
    alignContent: 'stretch',
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: AUTO,
    order: 0,
    rowGap: 0,
    columnGap: 0,
    grid: false,
    gridColumns: null,
    gridRows: null,
    gridAutoRows: AUTO_TRACK,
    gridAutoColumns: AUTO_TRACK,
    gridAreas: null,
    gridAutoFlow: 'row',
    gridColumnStart: null,
    gridColumnEnd: null,
    gridRowStart: null,
    gridRowEnd: null,
    justifyItems: 'stretch',
    justifySelf: 'auto',

    tableLayout: 'auto',

    content: 'normal',
    counterReset: null,
    counterIncrement: null,
    counterSet: null,
  });
}

type StyleCopy = new (from: ComputedStyle) => ComputedStyle;
let StyleCopy: StyleCopy | null = null;

/**
 * A copy of a style, made by a constructor that assigns every field.
 *
 * Never `{ ...style }`. V8 gives an object literal of 128 properties or
 * more a dictionary map — a hash table where a shape would be — and a
 * spread of one adds the copy's properties one at a time: 20 µs a copy at
 * 149 fields, where a literal of 127 spreads in 0.2. A style passed 128 and
 * every `inherit` paid it, and a spread of a style that is not a literal
 * costs 4 µs. A constructor's fields are laid out in the object whatever
 * their number: 0.13 µs a copy, and read as fast as a small literal's.
 *
 * The constructor is written from the fields of the first style copied,
 * which is `initialStyle`'s literal and so every field there is: one added
 * to the style cannot be left out of the copy.
 */
export function copyStyle(from: ComputedStyle): ComputedStyle {
  StyleCopy ??= copyConstructor(Object.keys(from));
  return new StyleCopy(from);
}

function copyConstructor(fields: string[]): StyleCopy {
  const body = fields.map((field) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(field)) {
      throw new Error(`a style field that is not a name: ${field}`);
    }
    return `this.${field} = from.${field};`;
  });
  return new Function('from', body.join('\n')) as unknown as StyleCopy;
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
  const out = copyStyle(initial);
  // `INHERITED`, a field at a time: a loop over the names was three
  // quarters of the cost of every element's style, a store through a
  // computed name costing thirty times one through a written one
  out.color = parent.color;
  out.textFillColor = parent.textFillColor;
  out.fontFamily = parent.fontFamily;
  out.fontSize = parent.fontSize;
  out.fontWeight = parent.fontWeight;
  out.fontStyle = parent.fontStyle;
  out.lineHeight = parent.lineHeight;
  out.lineHeightIsLength = parent.lineHeightIsLength;
  out.textAlign = parent.textAlign;
  out.textAlignLast = parent.textAlignLast;
  out.textJustify = parent.textJustify;
  out.blockEllipsis = parent.blockEllipsis;
  out.alignBlocks = parent.alignBlocks;
  out.textIndent = parent.textIndent;
  out.textTransform = parent.textTransform;
  out.letterSpacing = parent.letterSpacing;
  out.wordSpacing = parent.wordSpacing;
  out.textShadow = parent.textShadow;
  out.fontVariantNumeric = parent.fontVariantNumeric;
  out.fontVariantCaps = parent.fontVariantCaps;
  out.fontVariantLigatures = parent.fontVariantLigatures;
  out.fontVariantPosition = parent.fontVariantPosition;
  out.fontKerning = parent.fontKerning;
  out.fontFeatureSettings = parent.fontFeatureSettings;
  out.tabSize = parent.tabSize;
  out.tabSizeIsLength = parent.tabSizeIsLength;
  out.whiteSpace = parent.whiteSpace;
  out.overflowWrap = parent.overflowWrap;
  out.wordBreak = parent.wordBreak;
  out.lineBreakAnywhere = parent.lineBreakAnywhere;
  out.textWrapStyle = parent.textWrapStyle;
  out.direction = parent.direction;
  out.visibility = parent.visibility;
  out.listStyleType = parent.listStyleType;
  out.listStylePosition = parent.listStylePosition;
  out.listStyleImage = parent.listStyleImage;
  out.cursor = parent.cursor;
  out.borderCollapse = parent.borderCollapse;
  out.borderSpacing = parent.borderSpacing;
  out.borderSpacingY = parent.borderSpacingY;
  out.captionSide = parent.captionSide;
  out.emptyCells = parent.emptyCells;
  out.tableTextAlignSet = parent.tableTextAlignSet;
  out.quotes = parent.quotes;
  out.custom = parent.custom;
  out.borderTopColor = 'currentColor';
  out.borderRightColor = 'currentColor';
  out.borderBottomColor = 'currentColor';
  out.borderLeftColor = 'currentColor';
  out.textUnderlineOffset = parent.textUnderlineOffset;
  // propagated, not inherited: `decorate` drops them where CSS stops them
  out.underline = parent.underline;
  out.underlineStyle = parent.underlineStyle;
  out.underlineThickness = parent.underlineThickness;
  out.underlineOffset = parent.underlineOffset;
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
  '-webkit-text-fill-color': 'textFillColor',
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
  inset: ['top', 'right', 'bottom', 'left'],
};

/** An `outline-style`: a border style but `hidden`, or `auto`. */
function outlineStyleOf(v: string): ComputedStyle['outlineStyle'] | null {
  if (v === 'auto') return 'auto';
  return BORDER_STYLES.has(v) && v !== 'hidden' ? (v as BorderStyle) : null;
}

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

/** The largest font size, in CSS pixels (`font-size`). */
const MAX_FONT_SIZE = 10000;

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
  // a logical property is the physical one it stands for, the CSS-wide
  // keywords and a stray `!important` included, so it is read first
  const logical = LOGICAL[name];
  if (logical) {
    applyLogical(
      style,
      parent,
      logical,
      value.replace(/\s*!\s*important$/i, ''),
      ctx,
    );
    return;
  }

  // CSS-wide keywords, before anything else parses the value.
  const lower = value.toLowerCase();
  if (lower === 'inherit') {
    inheritOne(style, parent, name);
    return;
  }
  if (lower === 'initial' || lower === 'unset' || lower === 'revert') {
    // `unset` is `inherit` for an inherited property and `initial` otherwise.
    // `initial` is the value the property starts at, which an inherited one
    // does not keep: left as it was, `line-height: initial` in a box inside
    // a 200px line height was that line height still, and one after an
    // earlier declaration of the property was that declaration. `revert`
    // would be the UA sheet's value, and leaving the one the cascade has
    // reached is the closest this gets without a third cascade level.
    if (lower === 'unset' && isInherited(name)) inheritOne(style, parent, name);
    else if (lower !== 'revert' && ctx.initial) {
      inheritOne(style, ctx.initial, name);
    }
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
      // a grid container is a flex container to the box tree — its
      // children are blockified items, and it holds its floats — and its
      // own layout (`css-grid.ts`) to the engine
      else if (v === 'grid') style.display = 'flex';
      else if (v === 'inline-grid') style.display = 'inline-flex';
      else if (v === 'flow-root') style.display = 'block';
      // the legacy flexible box, a flex box until `settleClamp` has read
      // its orient, and the prefixed spelling of the modern one
      else if (v === '-webkit-box' || v === '-webkit-flex') {
        style.display = 'flex';
      } else if (v === '-webkit-inline-box' || v === '-webkit-inline-flex') {
        style.display = 'inline-flex';
      } else if (DISPLAYS.has(v)) style.display = v as Display;
      else return;
      style.flowRoot = v === 'flow-root';
      style.grid = v === 'grid' || v === 'inline-grid';
      style.webkitBox =
        v === '-webkit-box'
          ? 'block'
          : v === '-webkit-inline-box'
            ? 'inline'
            : null;
      return;
    }
    case '-webkit-box-orient': {
      const v = value.toLowerCase();
      if (v === 'horizontal' || v === 'inline-axis') {
        style.webkitBoxOrient = 'horizontal';
      } else if (v === 'vertical' || v === 'block-axis') {
        style.webkitBoxOrient = 'vertical';
      }
      return;
    }
    case '-webkit-box-direction': {
      const v = value.toLowerCase();
      if (v === 'normal' || v === 'reverse') style.webkitBoxDirection = v;
      return;
    }
    case '-webkit-box-pack': {
      const v = BOX_PACK.get(value.trim().toLowerCase());
      if (v) style.webkitBoxPack = v;
      return;
    }
    case '-webkit-box-align': {
      const v = BOX_ALIGN.get(value.trim().toLowerCase());
      if (v) style.webkitBoxAlign = v;
      return;
    }
    case 'column-count':
    case 'column-width':
    case 'columns': {
      // `auto`, or a count, a width or both of them
      const bit = name === 'column-count' ? 1 : name === 'column-width' ? 2 : 3;
      let set = 0;
      for (const part of splitValue(value)) {
        const v = part.toLowerCase();
        if (v === 'auto') continue;
        if (/^\d+$/.test(v) && Number(v) >= 1) set |= 1;
        else if (parseLength(part, ctx) !== null) set |= 2;
        else return;
      }
      style.columns = (style.columns & ~bit) | (set & bit);
      return;
    }
    case '-webkit-box-flex': {
      const n = parseNumber(value);
      if (n !== null && n >= 0) style.webkitBoxFlex = n;
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
      else if (v === 'inline-start')
        style.clear = style.direction === 'rtl' ? 'right' : 'left';
      else if (v === 'inline-end')
        style.clear = style.direction === 'rtl' ? 'left' : 'right';
      return;
    }
    case 'line-clamp': {
      // `none`, or a count of lines, an ellipsis or both, and
      // `-webkit-legacy` (CSS Overflow 4, 5.1): the ellipsis a string
      // names is drawn as the one `auto` draws
      const parts = splitValue(value);
      if (parts.length === 1 && parts[0].toLowerCase() === 'none') {
        style.maxLines = null;
        style.clampContinue = 'auto';
        style.blockEllipsis = false;
        return;
      }
      let lines: number | null = null;
      let ellipsis: boolean | null = null;
      let legacy = false;
      for (const part of parts) {
        const v = part.toLowerCase();
        if (/^\d+$/.test(v) && lines === null) lines = Number(v);
        else if (v === '-webkit-legacy' && !legacy) legacy = true;
        else if (ellipsis === null && (v === 'auto' || v === 'no-ellipsis')) {
          ellipsis = v === 'auto';
        } else if (ellipsis === null && /^(["']).*\1$/s.test(part)) {
          ellipsis = part.length > 2;
        } else return;
      }
      if (lines === 0 || (lines === null && ellipsis === null)) return;
      style.maxLines = lines;
      style.clampContinue = legacy ? 'legacy' : 'collapse';
      style.blockEllipsis = ellipsis ?? true;
      return;
    }
    case '-webkit-line-clamp': {
      // `line-clamp` as it was, which clamps only a vertical `-webkit-box`
      // (5.1.1) and always with an ellipsis
      const v = value.trim().toLowerCase();
      if (v === 'none') {
        style.maxLines = null;
        style.clampContinue = 'auto';
        style.blockEllipsis = true;
      } else if (/^\d+$/.test(v) && Number(v) >= 1) {
        style.maxLines = Number(v);
        style.clampContinue = 'legacy';
        style.blockEllipsis = true;
      }
      return;
    }
    case 'max-lines': {
      const v = value.trim().toLowerCase();
      if (v === 'none') style.maxLines = null;
      else if (/^\d+$/.test(v) && Number(v) >= 1) style.maxLines = Number(v);
      return;
    }
    case 'continue': {
      const v = value.trim().toLowerCase();
      if (v === 'auto') style.clampContinue = 'auto';
      else if (v === 'collapse' || v === 'discard') {
        style.clampContinue = 'collapse';
      } else if (v === '-webkit-legacy') style.clampContinue = 'legacy';
      return;
    }
    case 'block-ellipsis': {
      const v = value.trim();
      const lower = v.toLowerCase();
      if (lower === 'auto' || lower === 'no-ellipsis') {
        style.blockEllipsis = lower === 'auto';
      } else if (/^(["']).*\1$/s.test(v)) style.blockEllipsis = v.length > 2;
      return;
    }
    case 'text-overflow': {
      // one value for the end a line is cut at, or two, start and end
      const parts = splitValue(value).map((p) => p.toLowerCase());
      const end = parts[parts.length - 1];
      if (parts.length <= 2 && (end === 'clip' || end === 'ellipsis')) {
        style.textOverflow = end;
      }
      return;
    }
    case 'box-sizing': {
      const v = value.toLowerCase();
      if (v === 'border-box' || v === 'content-box') style.boxSizing = v;
      return;
    }
    case 'aspect-ratio': {
      const parsed = parseAspectRatio(value);
      if (parsed !== undefined) style.aspectRatio = parsed;
      return;
    }
    case 'object-fit': {
      const v = value.trim().toLowerCase();
      if (OBJECT_FITS.has(v)) style.objectFit = v as ComputedStyle['objectFit'];
      return;
    }
    case 'appearance':
    case '-webkit-appearance':
    case '-moz-appearance': {
      // every keyword but `none` is some control's own look, which is the
      // only other thing this engine has
      const v = value.trim().toLowerCase();
      if (/^[a-z-]+$/.test(v))
        style.appearance = v === 'none' ? 'none' : 'auto';
      return;
    }
    case 'object-position': {
      const pair = positionPair(splitValue(value), ctx);
      if (!pair) return;
      style.objectPositionX = pair[0];
      style.objectPositionY = pair[1];
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
    case 'translate': {
      // `none`, or across, down, and a depth nothing here has
      if (value.trim().toLowerCase() === 'none') {
        style.translate = null;
        return;
      }
      const parts = splitValue(value);
      if (parts.length > 3) return;
      const [x, y, z] = parts.map((p) => parseLength(p, ctx));
      if (x == null || x === AUTO || y === null || y === AUTO) return;
      if (z !== undefined && typeof z !== 'number') return;
      style.translate = [x, y ?? 0];
      return;
    }
    case 'transform': {
      const moved = transformTranslation(value, ctx);
      if (moved !== undefined) style.transformTranslate = moved;
      return;
    }
    case 'visibility': {
      const v = value.toLowerCase();
      if (v === 'hidden' || v === 'collapse' || v === 'visible') {
        style.visibility = v;
      }
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
      const keyword = contentSizeOf(value, ctx, name.endsWith('width'));
      if (keyword) {
        // `auto` beside it, which is a height's content height already
        (style as unknown as Record<string, unknown>)[camel(name)] = AUTO;
        if (name === 'width') style.widthKeyword = keyword;
        else if (name === 'min-width') style.minWidthKeyword = keyword;
        else if (name === 'min-height') style.minHeightKeyword = keyword;
        else style.heightKeyword = keyword;
        return;
      }
      // a negative size is no value, and the declaration goes (CSS 2.1
      // 10.2, 10.4, 10.5, 10.7)
      const len = parseLength(value, ctx);
      if (len !== null && notNegative(len)) {
        (style as unknown as Record<string, unknown>)[camel(name)] = len;
        if (name === 'width') style.widthKeyword = null;
        else if (name === 'min-width') style.minWidthKeyword = null;
        else if (name === 'min-height') style.minHeightKeyword = null;
        else style.heightKeyword = null;
      }
      return;
    }
    case 'max-width':
    case 'max-height': {
      const keyword = contentSizeOf(value, ctx, name === 'max-width');
      if (keyword || value.toLowerCase() === 'none') {
        (style as unknown as Record<string, unknown>)[camel(name)] = 'none';
        if (name === 'max-width') style.maxWidthKeyword = keyword;
        return;
      }
      const len = parseLength(value, ctx);
      if (len !== null && notNegative(len)) {
        (style as unknown as Record<string, unknown>)[camel(name)] = len;
        if (name === 'max-width') style.maxWidthKeyword = null;
      }
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
    case 'inset':
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
    case 'border-top-left-radius':
    case 'border-top-right-radius':
    case 'border-bottom-right-radius':
    case 'border-bottom-left-radius': {
      // a radius, or a horizontal one and a vertical one
      const parts = splitValue(value).map((p) => radiusOf(p, ctx));
      if (!parts.length || parts.length > 2 || parts.includes(null)) return;
      const [x, y = x] = parts as Len[];
      const corner = CORNERS.indexOf(name);
      const radii = style.borderRadius.slice() as ComputedStyle['borderRadius'];
      const vertical = (
        style.borderRadiusY ?? style.borderRadius
      ).slice() as ComputedStyle['borderRadius'];
      radii[corner] = x;
      vertical[corner] = y;
      style.borderRadius = radii;
      style.borderRadiusY = sameRadii(radii, vertical) ? null : vertical;
      return;
    }
    case 'outline': {
      // width, style and colour in any order, each reset where it is left
      // out, as `border`'s are
      let width = BORDER_WIDTH_KEYWORDS.medium * ctx.scale;
      let outline: ComputedStyle['outlineStyle'] = 'none';
      let color = 'currentColor';
      for (const part of splitValue(value)) {
        const v = part.toLowerCase();
        const kind = outlineStyleOf(v);
        if (kind) {
          outline = kind;
          continue;
        }
        const w = borderWidth(part, ctx);
        if (w !== null) {
          width = w;
          continue;
        }
        const c = v === 'invert' ? 'currentColor' : parseColor(part);
        if (c === null) return;
        color = c;
      }
      style.outlineStyle = outline;
      style.outlineWidth = width;
      style.outlineColor = color;
      return;
    }
    case 'outline-style': {
      const kind = outlineStyleOf(value.trim().toLowerCase());
      if (kind) style.outlineStyle = kind;
      return;
    }
    case 'outline-width': {
      const w = borderWidth(value, ctx);
      if (w !== null) style.outlineWidth = w;
      return;
    }
    case 'outline-color': {
      // `invert` is the text's colour where a browser cannot invert
      const v = value.trim().toLowerCase();
      const c = v === 'invert' ? 'currentColor' : parseColor(value);
      if (c !== null) style.outlineColor = c;
      return;
    }
    case 'outline-offset': {
      const len = parseLength(value, ctx);
      if (typeof len === 'number') style.outlineOffset = len;
      return;
    }
    case 'box-shadow': {
      const shadows = parseBoxShadow(value, ctx);
      if (shadows !== undefined) style.boxShadow = shadows;
      return;
    }
    case 'text-shadow': {
      const shadows = parseBoxShadow(value, ctx, true);
      if (shadows !== undefined) style.textShadow = shadows;
      return;
    }
    case 'border-radius': {
      // one to four radii, and after a `/` one to four more for the
      // vertical radii where they differ: elliptical corners
      const halves = value.split('/');
      if (halves.length > 2) return;
      const [horizontal, vertical] = halves.map((half) =>
        splitValue(half).map((p) => radiusOf(p, ctx)),
      );
      for (const parts of vertical ? [horizontal, vertical] : [horizontal]) {
        if (!parts.length || parts.length > 4 || parts.includes(null)) return;
      }
      style.borderRadius = fourSides(horizontal as Len[]);
      const y = vertical ? fourSides(vertical as Len[]) : null;
      style.borderRadiusY = y && !sameRadii(style.borderRadius, y) ? y : null;
      return;
    }

    // --- background ---------------------------------------------------------
    case 'background': {
      applyBackgroundShorthand(style, value, ctx);
      return;
    }
    case 'background-image': {
      // one a layer; a bad url makes the declaration invalid, and it is
      // dropped
      const images: BackgroundImage[] = [];
      for (const part of splitCommas(value)) {
        const image = backgroundImageOf(part, ctx);
        if (image === undefined) return;
        images.push(image);
      }
      if (!images.length) return;
      const [first] = images;
      style.backgroundImage = typeof first === 'string' ? first : null;
      style.backgroundGradient = typeof first === 'string' ? null : first;
      style.backgroundImages = images.length > 1 ? images : null;
      return;
    }
    case 'background-clip':
    case '-webkit-background-clip': {
      // the first layer's; the box keywords all clip where the box is
      const v = (splitCommas(value)[0] ?? '').trim().toLowerCase();
      if (v === 'text') style.backgroundClipText = true;
      else if (
        v === 'border-box' ||
        v === 'padding-box' ||
        v === 'content-box'
      ) {
        style.backgroundClipText = false;
      }
      return;
    }
    case 'background-repeat': {
      const repeats = layerValues(value, (part) => {
        const words = splitValue(part.toLowerCase());
        return words.length <= 2 ? readRepeat(words) : null;
      });
      if (!repeats) return;
      style.backgroundRepeat = repeats[0];
      style.backgroundRepeats = repeats.length > 1 ? repeats : null;
      return;
    }
    case 'background-attachment': {
      const attachments = layerValues(value, (part) => {
        const v = part.toLowerCase();
        return v === 'scroll' || v === 'fixed' || v === 'local' ? v : null;
      });
      if (!attachments) return;
      style.backgroundAttachment = attachments[0];
      style.backgroundAttachments = attachments.length > 1 ? attachments : null;
      return;
    }
    case 'background-size': {
      const sizes = layerValues(value, (part) =>
        backgroundSizeOf(splitValue(part), ctx),
      );
      if (!sizes) return;
      style.backgroundSize = sizes[0];
      style.backgroundSizes = sizes.length > 1 ? sizes : null;
      return;
    }
    case 'background-position': {
      const pairs = layerValues(value, (part) =>
        positionPair(splitValue(part), ctx),
      );
      if (!pairs) return;
      [style.backgroundPositionX, style.backgroundPositionY] = pairs[0];
      style.backgroundPositions = pairs.length > 1 ? pairs : null;
      return;
    }

    // --- generated content --------------------------------------------------
    case 'content': {
      const parsed = parseContent(value);
      if (parsed !== null) style.content = parsed;
      return;
    }
    case 'counter-reset':
    case 'counter-increment':
    case 'counter-set': {
      const reset = name === 'counter-reset';
      const increment = name === 'counter-increment';
      const parsed = parseCounterList(value, increment ? 1 : 0, reset);
      if (parsed === null) return;
      const list = parsed === 'none' ? null : parsed;
      if (reset) style.counterReset = list;
      else if (increment) style.counterIncrement = list;
      else style.counterSet = list;
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
      // and an unquoted name is its identifiers joined by one space each,
      // however they were spaced: `Courier   New` over two lines is
      // `Courier New`, and was a name no font has
      const list = names
        .map((f) =>
          /^['"]/.test(f)
            ? f.replace(/^['"]|['"]$/g, '')
            : f.trim().replace(/[ \t\n\r\f]+/g, ' '),
        )
        .filter(Boolean)
        .join(', ');
      style.fontFamily = ctx.families ? ctx.families(list) : list;
      return;
    }
    case 'font-size': {
      // No larger than 10,000 pixels, as Chrome keeps it: a text engine
      // handed a face at a size of millions shapes and caches glyphs that
      // size, and a nest of `larger`s gets there on its own
      const most = MAX_FONT_SIZE * ctx.scale;
      const kw = keywordFontSize(value, parent.fontSize, ctx.rem);
      if (kw !== null) {
        style.fontSize = Math.min(kw, most);
        return;
      }
      // `em` in a `font-size` is relative to the *parent's* size, not this
      // element's — the one place the unit context has to be overridden.
      // 0 is a size — the text takes no room, which is what a container of
      // inline-blocks sets to lose the spaces between them — and a negative
      // one is no size at all, so the declaration goes
      const len = parseLength(value, { ...ctx, em: parent.fontSize });
      if (typeof len === 'number') {
        if (len >= 0) style.fontSize = Math.min(len, most);
      } else if (len && typeof len === 'object') {
        const size = resolve(len, parent.fontSize);
        if (size >= 0) style.fontSize = Math.min(size, most);
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
      // none of it below nought, which drops the declaration (CSS 2.1
      // 10.8.1)
      const n = parseNumber(value);
      if (n !== null) {
        if (n < 0) return;
        style.lineHeight = n;
        style.lineHeightIsLength = false;
        return;
      }
      const len = parseLength(value, ctx);
      if (typeof len === 'number') {
        if (len < 0) return;
        style.lineHeight = len;
        style.lineHeightIsLength = true;
      } else if (len && typeof len === 'object') {
        const px = resolve(len, style.fontSize);
        if (px < 0) return;
        style.lineHeight = px;
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
      // every line justified, the last as well (CSS Text 3, 7.1)
      if (v === 'justify-all') {
        style.textAlign = 'justify';
        style.textAlignLast = 'justify';
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
    case 'text-align-last': {
      const v = value.toLowerCase();
      if (
        v === 'auto' ||
        v === 'left' ||
        v === 'right' ||
        v === 'center' ||
        v === 'justify' ||
        v === 'start' ||
        v === 'end'
      ) {
        style.textAlignLast = v;
      } else if (v === 'match-parent') {
        style.textAlignLast = parent.textAlignLast;
      }
      return;
    }
    case 'text-justify': {
      const v = value.toLowerCase();
      if (
        v === 'auto' ||
        v === 'none' ||
        v === 'inter-word' ||
        v === 'inter-character'
      ) {
        style.textJustify = v;
      } else if (v === 'distribute') {
        style.textJustify = 'inter-character';
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
      } else if (name === 'letter-spacing' && len && isPct(len)) {
        // a percentage of the font size, as `em` is (CSS Text 4): `200%`
        // was dropped, where it is twice the letter's size apart
        style.letterSpacing = resolve(len, ctx.em);
      }
      return;
    }
    case 'font-variant-numeric':
    case 'font-variant-caps':
    case 'font-variant-ligatures':
    case 'font-variant-position': {
      const kind = name.slice('font-variant-'.length) as VariantKind;
      const variant = parseFontVariant(value, kind);
      if (variant) Object.assign(style, variant);
      return;
    }
    case 'font-variant': {
      const variant = parseFontVariant(value, null);
      if (variant) Object.assign(style, variant);
      return;
    }
    case 'font-kerning': {
      const v = value.trim().toLowerCase();
      if (v === 'auto') style.fontKerning = '';
      else if (v === 'normal') style.fontKerning = 'kern=1';
      else if (v === 'none') style.fontKerning = 'kern=0';
      return;
    }
    case 'font-feature-settings': {
      const settings = parseFeatureSettings(value);
      if (settings !== null) style.fontFeatureSettings = settings;
      return;
    }
    case 'tab-size':
    case '-moz-tab-size': {
      // a number of spaces, or a length; neither below nought
      const v = value.trim();
      if (/^[+]?(\d+\.?\d*|\.\d+)$/.test(v)) {
        style.tabSize = Number(v);
        style.tabSizeIsLength = false;
        return;
      }
      const len = parseLength(v, ctx);
      if (typeof len === 'number' && len >= 0) {
        style.tabSize = len;
        style.tabSizeIsLength = true;
      }
      return;
    }
    case 'white-space': {
      const v = value.trim().toLowerCase();
      if (
        v === 'normal' ||
        v === 'nowrap' ||
        v === 'pre' ||
        v === 'pre-wrap' ||
        v === 'pre-line'
      ) {
        style.whiteSpace = v;
      } else if (v === 'break-spaces') {
        // `pre-wrap` whose spaces take room at a line's end rather than
        // hanging past it, which is as near as the engines come
        style.whiteSpace = 'pre-wrap';
      }
      return;
    }
    // a word is cut inside itself only where the style says it may be:
    // `anywhere` as `break-word` is
    case 'overflow-wrap':
    case 'word-wrap': {
      const v = value.trim().toLowerCase();
      if (v === 'normal') style.overflowWrap = 'normal';
      else if (v === 'break-word' || v === 'anywhere') {
        style.overflowWrap = 'break-word';
      }
      return;
    }
    case 'line-break': {
      const v = value.trim().toLowerCase();
      if (
        v === 'auto' ||
        v === 'loose' ||
        v === 'normal' ||
        v === 'strict' ||
        v === 'anywhere'
      ) {
        style.lineBreakAnywhere = v === 'anywhere';
      }
      return;
    }
    case 'word-break': {
      const v = value.trim().toLowerCase();
      if (
        v === 'normal' ||
        v === 'break-all' ||
        v === 'keep-all' ||
        v === 'break-word'
      ) {
        style.wordBreak = v;
      }
      return;
    }
    // CSS Text 4 splits `white-space` into what it keeps of the white space
    // and whether its lines wrap; each longhand changes its half of it
    case 'white-space-collapse': {
      const v = value.trim().toLowerCase();
      const collapse =
        v === 'collapse'
          ? 'collapse'
          : v === 'preserve' || v === 'break-spaces' || v === 'preserve-spaces'
            ? 'preserve'
            : v === 'preserve-breaks'
              ? 'preserve-breaks'
              : null;
      if (collapse) {
        style.whiteSpace = whiteSpaceOf(collapse, wrapsIn(style.whiteSpace));
      }
      return;
    }
    case 'text-wrap':
    case 'text-wrap-mode':
    case 'text-wrap-style': {
      // `text-wrap` is both, and resets the one it leaves out: Tailwind 4
      // writes `text-nowrap` and `text-balance` in it
      let wrap: boolean | null = null;
      let balance: boolean | null = null;
      for (const word of splitValue(value.toLowerCase())) {
        const mode = word === 'wrap' || word === 'nowrap';
        const kind =
          word === 'auto' ||
          word === 'balance' ||
          word === 'pretty' ||
          word === 'stable';
        if (mode && wrap === null && name !== 'text-wrap-style') {
          wrap = word === 'wrap';
        } else if (kind && balance === null && name !== 'text-wrap-mode') {
          balance = word === 'balance';
        } else return;
      }
      if (wrap === null && balance === null) return;
      if (name === 'text-wrap') {
        wrap ??= true;
        balance ??= false;
      }
      if (wrap !== null) {
        style.whiteSpace = whiteSpaceOf(COLLAPSE_OF[style.whiteSpace], wrap);
      }
      if (balance !== null) style.textWrapStyle = balance ? 'balance' : 'auto';
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
      // Read whole before any of it is taken: a word the property does not
      // know, one given twice, or `none` beside a line makes the declaration
      // invalid, and it is ignored (CSS 2.1 4.2) — `underline overline
      // line-through diagonal` draws nothing, where it drew a line-through.
      const lines: string[] = [];
      let none = false;
      let color: string | null = null;
      let decorationStyle: ComputedStyle['textDecorationStyle'] | null = null;
      let thickness: number | null | undefined;
      for (const part of splitValue(value)) {
        const v = part.toLowerCase();
        if (LINE_KEYWORDS.has(v)) {
          if (none || lines.includes(v)) return;
          lines.push(v);
          continue;
        }
        if (v === 'none') {
          if (none || lines.length) return;
          none = true;
          continue;
        }
        if (name !== 'text-decoration') return;
        const c = parseColor(part);
        if (c) {
          if (color !== null) return;
          color = c;
        } else if (DECORATION_STYLES.has(v)) {
          if (decorationStyle !== null) return;
          decorationStyle = v as ComputedStyle['textDecorationStyle'];
        } else {
          const t = decorationLength(part, ctx);
          if (t === undefined || thickness !== undefined) return;
          thickness = t;
        }
      }
      if (!none && !lines.length && name === 'text-decoration-line') return;
      style.textDecorationLine = lines.length ? lines.join(' ') : 'none';
      if (name === 'text-decoration') {
        // a shorthand: what it does not name goes back to its initial value
        style.textDecorationColor = color;
        style.textDecorationStyle = decorationStyle ?? 'solid';
        style.textDecorationThickness = thickness ?? null;
      }
      return;
    }
    case 'text-decoration-thickness': {
      const thickness = decorationLength(value, ctx, 'from-font');
      if (thickness !== undefined) style.textDecorationThickness = thickness;
      return;
    }
    case 'text-underline-offset': {
      const offset = decorationLength(value, ctx);
      if (offset !== undefined) style.textUnderlineOffset = offset;
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
      // a type, a position and an image, each at most once and in any
      // order, and each left out reset (CSS 2.1 12.5.1); a `none` is
      // whichever of the type and the image is not otherwise given, both
      // where neither is, and a third thing where both are, which is
      // nothing and makes the declaration invalid
      let type: string | null = null;
      let position: ComputedStyle['listStylePosition'] | null = null;
      let image: string | null | undefined;
      let nones = 0;
      for (const part of splitValue(value)) {
        const v = part.toLowerCase();
        if (v === 'inside' || v === 'outside') {
          if (position) return;
          position = v;
        } else if (v === 'none') nones += 1;
        else if (v.startsWith('url(') || IMAGE_FUNCTION.test(v)) {
          if (image !== undefined) return;
          image = v.startsWith('url(') ? (parseUrl(part) ?? null) : null;
        } else {
          if (type !== null) return;
          type = parseListStyleType(part);
          if (type === null) return;
        }
      }
      if (nones > 2) return;
      if (nones === 2 && (type !== null || image !== undefined)) return;
      if (nones === 1) {
        if (type !== null && image !== undefined) return;
        if (type === null) type = 'none';
        else image = null;
      }
      if (nones === 2) {
        type = 'none';
        image = null;
      }
      style.listStyleType = type ?? 'disc';
      style.listStylePosition = position ?? 'outside';
      style.listStyleImage = image ?? null;
      return;
    }
    case 'list-style-image': {
      const v = value.trim();
      if (v.toLowerCase() === 'none') style.listStyleImage = null;
      else if (IMAGE_FUNCTION.test(v.toLowerCase())) {
        // a gradient is an image this draws no marker as
        style.listStyleImage = null;
      } else if (/^url\(/i.test(v)) {
        const url = parseUrl(v);
        if (url !== undefined) style.listStyleImage = url;
      }
      return;
    }
    case 'list-style-type': {
      const type = parseListStyleType(value);
      if (type !== null) style.listStyleType = type;
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
      const v = justifyKeyword(value);
      if (v) style.justifyContent = v;
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
      // an integer, and nothing else (CSS Flexbox 5.4)
      const v = value.trim();
      if (/^[+-]?\d+$/.test(v)) style.order = Number(v);
      return;
    }
    case 'gap':
    case 'row-gap':
    case 'column-gap':
    // the names CSS Grid 1 first gave them, which browsers still read
    case 'grid-gap':
    case 'grid-row-gap':
    case 'grid-column-gap': {
      const which = name.replace(/^grid-/, '');
      const parts = splitValue(value).map((p) => parseLength(p, ctx));
      const row = typeof parts[0] === 'number' ? parts[0] : null;
      const col = typeof parts[1] === 'number' ? parts[1] : row;
      if (row === null) return;
      if (which !== 'column-gap') style.rowGap = row;
      if (which !== 'row-gap') style.columnGap = col ?? row;
      return;
    }
    case 'grid-template-columns':
    case 'grid-template-rows': {
      const template =
        value.toLowerCase() === 'none' ? null : parseGridTemplate(value, ctx);
      if (template === undefined) return;
      if (name === 'grid-template-columns') style.gridColumns = template;
      else style.gridRows = template;
      return;
    }
    case 'grid-template-areas': {
      if (value.trim().toLowerCase() === 'none') {
        style.gridAreas = null;
        return;
      }
      const parts = trackParts(value);
      if (!parts?.length || !parts.every((p) => /^["']/.test(p))) return;
      const areas = parseAreas(parts);
      if (areas) style.gridAreas = areas;
      return;
    }
    case 'grid-auto-flow': {
      const words = value.trim().toLowerCase().split(/\s+/);
      const dense = words.includes('dense');
      const axis = words.filter((w) => w !== 'dense');
      if (
        axis.length > 1 ||
        words.length > 2 ||
        (axis.length && axis[0] !== 'row' && axis[0] !== 'column') ||
        (!dense && !axis.length)
      ) {
        return;
      }
      const flow = axis[0] ?? 'row';
      style.gridAutoFlow = dense
        ? flow === 'row'
          ? 'row dense'
          : 'column dense'
        : (flow as 'row' | 'column');
      return;
    }
    case 'grid-auto-rows':
    case 'grid-auto-columns': {
      const track = parseGridTrack(splitValue(value)[0] ?? '', ctx);
      if (!track) return;
      if (name === 'grid-auto-rows') style.gridAutoRows = track;
      else style.gridAutoColumns = track;
      return;
    }
    case 'grid-template': {
      // rows, a slash and columns, or `none` (CSS Grid 1, 7.4)
      if (value.trim().toLowerCase() === 'none') {
        style.gridRows = null;
        style.gridColumns = null;
        style.gridAreas = null;
        return;
      }
      const template = parseTemplateShorthand(value, ctx);
      if (!template) return;
      style.gridRows = template.rows;
      style.gridColumns = template.columns;
      style.gridAreas = template.areas;
      return;
    }
    case 'grid': {
      // a template, or one axis's template and the other's `auto-flow`
      // tracks (7.8); every longhand it does not name back to its initial
      const parts = splitTopLevelSlash(value);
      const flows = (part: string | undefined) =>
        part !== undefined && /(^|\s)auto-flow(\s|$)/i.test(part);
      const autoTrack = (part: string): GridTrack | null => {
        const words = splitValue(part).filter(
          (w) => !/^(auto-flow|dense)$/i.test(w),
        );
        return words.length ? parseGridTrack(words[0], ctx) : AUTO_TRACK;
      };
      const dense = (part: string) => /(^|\s)dense(\s|$)/i.test(part);
      const axis = (part: string): GridTemplate | null | undefined =>
        part.trim().toLowerCase() === 'none'
          ? null
          : parseGridTemplate(part, ctx);
      if (parts.length === 2 && flows(parts[0])) {
        const rows = autoTrack(parts[0]);
        const columns = axis(parts[1]);
        if (!rows || columns === undefined) return;
        style.gridRows = null;
        style.gridColumns = columns;
        style.gridAreas = null;
        style.gridAutoRows = rows;
        style.gridAutoColumns = AUTO_TRACK;
        style.gridAutoFlow = dense(parts[0]) ? 'row dense' : 'row';
        return;
      }
      if (parts.length === 2 && flows(parts[1])) {
        const rows = axis(parts[0]);
        const columns = autoTrack(parts[1]);
        if (rows === undefined || !columns) return;
        style.gridRows = rows;
        style.gridColumns = null;
        style.gridAreas = null;
        style.gridAutoRows = AUTO_TRACK;
        style.gridAutoColumns = columns;
        style.gridAutoFlow = dense(parts[1]) ? 'column dense' : 'column';
        return;
      }
      const none = value.trim().toLowerCase() === 'none';
      const template = none ? null : parseTemplateShorthand(value, ctx);
      if (!none && !template) return;
      style.gridRows = template?.rows ?? null;
      style.gridColumns = template?.columns ?? null;
      style.gridAreas = template?.areas ?? null;
      style.gridAutoRows = AUTO_TRACK;
      style.gridAutoColumns = AUTO_TRACK;
      style.gridAutoFlow = 'row';
      return;
    }
    case 'grid-column':
    case 'grid-row': {
      // an end left out is the start where the start is a name, and auto
      // where it is not (8.4)
      const parts = splitTopLevelSlash(value);
      const start = parseGridLine(parts[0]);
      const end = parts.length > 1 ? parseGridLine(parts[1]) : named(start);
      if (start === undefined || end === undefined || parts.length > 2) return;
      if (name === 'grid-column') {
        style.gridColumnStart = start;
        style.gridColumnEnd = end;
      } else {
        style.gridRowStart = start;
        style.gridRowEnd = end;
      }
      return;
    }
    case 'grid-area': {
      // the lines left out copy a name: the column start the row start's,
      // and each end its start's (8.4)
      const parts = splitTopLevelSlash(value).map(parseGridLine);
      if (parts.length > 4 || parts.some((p) => p === undefined)) return;
      const rowStart = parts[0] ?? null;
      const columnStart = parts.length > 1 ? parts[1]! : named(rowStart);
      style.gridRowStart = rowStart;
      style.gridColumnStart = columnStart;
      style.gridRowEnd = parts.length > 2 ? parts[2]! : named(rowStart);
      style.gridColumnEnd = parts.length > 3 ? parts[3]! : named(columnStart);
      return;
    }
    case 'grid-column-start':
    case 'grid-column-end':
    case 'grid-row-start':
    case 'grid-row-end': {
      const line = parseGridLine(value);
      if (line === undefined) return;
      (style as unknown as Record<string, unknown>)[camel(name)] = line;
      return;
    }
    case 'justify-items':
    case 'justify-self': {
      const v = value.trim().toLowerCase();
      const keyword =
        v === 'auto' && name === 'justify-self'
          ? 'auto'
          : v === 'normal' || v === 'stretch'
            ? 'stretch'
            : alignKeyword(v);
      if (
        keyword === 'auto' ||
        keyword === 'stretch' ||
        keyword === 'flex-start' ||
        keyword === 'flex-end' ||
        keyword === 'center'
      ) {
        if (name === 'justify-items' && keyword !== 'auto') {
          style.justifyItems = keyword;
        } else if (name === 'justify-self') style.justifySelf = keyword;
      }
      return;
    }
    case 'place-items':
    case 'place-self': {
      const parts = splitValue(value);
      if (!parts.length || parts.length > 2) return;
      const align = name === 'place-items' ? 'align-items' : 'align-self';
      const justify = name === 'place-items' ? 'justify-items' : 'justify-self';
      applyDeclaration(style, parent, align, parts[0], ctx);
      applyDeclaration(style, parent, justify, parts[1] ?? parts[0], ctx);
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
    case 'empty-cells': {
      const v = value.trim().toLowerCase();
      if (v === 'show' || v === 'hide') style.emptyCells = v;
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

/** `-webkit-box-pack` and `-webkit-box-align`, as `justify-content` and
 *  `align-items` say them. */
const BOX_PACK = new Map<string, ComputedStyle['justifyContent']>([
  ['start', 'flex-start'],
  ['end', 'flex-end'],
  ['center', 'center'],
  ['justify', 'space-between'],
]);
const BOX_ALIGN = new Map<string, ComputedStyle['alignItems']>([
  ['start', 'flex-start'],
  ['end', 'flex-end'],
  ['center', 'center'],
  ['baseline', 'baseline'],
  ['stretch', 'stretch'],
]);

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
  'contents',
]);

/** `text-decoration-line`'s lines. `blink` is one a user agent may leave
 *  undrawn (CSS 2.1 16.3.1), and this one does; `overline` is not drawn
 *  yet either. */
const LINE_KEYWORDS = new Set([
  'underline',
  'overline',
  'line-through',
  'blink',
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
  if (
    s === 'visible' ||
    s === 'hidden' ||
    s === 'scroll' ||
    s === 'auto' ||
    s === 'clip'
  ) {
    return s;
  }
  return null;
}

/**
 * The two axes' `overflow` as they compute together (CSS Overflow 3, 3.1):
 * `visible` and `clip` hold beside each other, and beside a value that
 * makes the box a scroll container, `visible` is `auto` and `clip` is
 * `hidden`.
 */
export function settleOverflow(style: ComputedStyle): void {
  const x = style.overflowX;
  const y = style.overflowY;
  const scrollsX = x !== 'visible' && x !== 'clip';
  const scrollsY = y !== 'visible' && y !== 'clip';
  if (scrollsX === scrollsY) return;
  if (scrollsX) style.overflowY = y === 'visible' ? 'auto' : 'hidden';
  else style.overflowX = x === 'visible' ? 'auto' : 'hidden';
}

/**
 * Whether a box is a scroll container: its `overflow` is neither `visible`
 * nor `clip`. `clip` cuts what overflows as `hidden` does, but makes no
 * formatting context and keeps a flex or grid item's automatic minimum
 * (CSS Overflow 3, 3.1) — so only this asks it apart from `hidden`.
 */
export function scrolls(style: ComputedStyle): boolean {
  const x = style.overflowX;
  const y = style.overflowY;
  return (x !== 'visible' && x !== 'clip') || (y !== 'visible' && y !== 'clip');
}

/** A `justify-content`: the writing mode's `start` and `end`, and `left`
 *  and `right`, kept for the flex box to resolve against its direction;
 *  `normal` and `stretch` pack as `flex-start` does (`overflowAligned`). */
function justifyKeyword(value: string): ComputedStyle['justifyContent'] | null {
  const v = overflowAligned(value);
  switch (v) {
    case 'start':
    case 'end':
    case 'left':
    case 'right':
    case 'flex-start':
    case 'flex-end':
    case 'center':
    case 'space-between':
    case 'space-around':
    case 'space-evenly':
      return v;
    case 'normal':
    case 'stretch':
      return v;
    default:
      return null;
  }
}

/** An alignment's keyword, with `unsafe` before it read past, which is
 *  what an alignment does anyway. A `safe` one sets the subject at the
 *  start where it overflows its room, which is not done here: it is no
 *  value, and the declaration is dropped — which is the start's for the
 *  flex box that overflows, as it was before `safe` was read at all. */
function overflowAligned(value: string): string {
  const v = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const m = /^unsafe (.+)$/.exec(v);
  return m ? m[1] : v;
}

function alignKeyword(value: string): string | null {
  const v = overflowAligned(value);
  switch (v) {
    case 'start':
    case 'flex-start':
    case 'self-start':
    case 'left':
      return 'flex-start';
    case 'end':
    case 'flex-end':
    case 'self-end':
    case 'right':
      return 'flex-end';
    case 'first baseline':
      return 'baseline';
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
  // each of the three at most once (`<line-width> || <line-style> ||
  // <color>`): `red solid 16px red` is no border, where the second colour
  // was taken for the first
  let seen = 0;
  for (const part of splitValue(value)) {
    const v = part.toLowerCase();
    if (BORDER_STYLES.has(v)) {
      if (seen & 1) return;
      seen |= 1;
      borderStyle = v as BorderStyle;
      continue;
    }
    const w = borderWidth(part, ctx);
    if (w !== null) {
      if (seen & 2) return;
      seen |= 2;
      width = w;
      continue;
    }
    const c = parseColor(part);
    if (c !== null) {
      if (seen & 4) return;
      seen |= 4;
      color = c;
      continue;
    }
    // a negative width makes the whole shorthand invalid
    const len = parseLength(part, ctx);
    if (typeof len === 'number' && len < 0) return;
  }
  // A width with no style is kept rather than zeroed — the layout draws
  // nothing for `none` — so a later `border-style` alone finds it.
  if (name === 'border') {
    // named, not built: preflight's `border: 0 solid` is on every element,
    // and twelve stores through a computed name were most of its cost
    style.borderTopWidth = width;
    style.borderRightWidth = width;
    style.borderBottomWidth = width;
    style.borderLeftWidth = width;
    style.borderTopStyle = borderStyle;
    style.borderRightStyle = borderStyle;
    style.borderBottomStyle = borderStyle;
    style.borderLeftStyle = borderStyle;
    if (color !== null) {
      style.borderTopColor = color;
      style.borderRightColor = color;
      style.borderBottomColor = color;
      style.borderLeftColor = color;
    }
    return;
  }
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
  // A layer a comma group, top first: each has to be a layer, and only the
  // last, which is painted against the box, may have a colour, or the
  // declaration is none
  const texts = splitCommas(value);
  const layers: BackgroundLayer[] = [];
  for (let k = 0; k < texts.length; k += 1) {
    const layer = readBackgroundLayer(texts[k], ctx, k === texts.length - 1);
    if (!layer) return;
    layers.push(layer);
  }
  if (!layers.length) return;
  const [top] = layers;
  style.backgroundClipText = false;
  style.backgroundColor = layers[layers.length - 1].color;
  style.backgroundImage = top.image;
  style.backgroundGradient = top.gradient;
  style.backgroundRepeat = top.repeat;
  style.backgroundSize = top.size;
  style.backgroundAttachment = top.attachment;
  [style.backgroundPositionX, style.backgroundPositionY] = top.position ?? [
    0, 0,
  ];
  const many = layers.length > 1;
  style.backgroundImages = many
    ? layers.map((l) => l.image ?? l.gradient)
    : null;
  style.backgroundRepeats = many ? layers.map((l) => l.repeat) : null;
  style.backgroundSizes = many ? layers.map((l) => l.size) : null;
  style.backgroundAttachments = many ? layers.map((l) => l.attachment) : null;
  style.backgroundPositions = many
    ? layers.map((l) => l.position ?? [0, 0])
    : null;
}

/** One layer's `background-image`: a url, a gradient — none where it is
 *  one this does not draw, as though there were none — or none; undefined
 *  where it is not an image at all. */
function backgroundImageOf(
  text: string,
  ctx: UnitContext,
): BackgroundImage | undefined {
  const v = text.trim();
  if (IMAGE_FUNCTION.test(v.toLowerCase())) return parseLinearGradient(v, ctx);
  return parseUrl(v);
}

/** A background property's values, one a comma-separated layer, each read
 *  by `read`; null where one is not a value, which drops the declaration. */
function layerValues<T>(
  value: string,
  read: (part: string) => T | null,
): T[] | null {
  const out: T[] = [];
  for (const part of splitCommas(value)) {
    const v = read(part.trim());
    if (v === null) return null;
    out.push(v);
  }
  return out.length ? out : null;
}

interface BackgroundLayer {
  color: string | null;
  image: string | null;
  gradient: LinearGradient | null;
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
    gradient: null,
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
      } else if (v !== 'none') layer.gradient = parseLinearGradient(part, ctx);
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
      // `/ <size>`: `cover`, `contain`, or one or two lengths
      const first = parts[i + 1]?.toLowerCase();
      if (first === 'cover' || first === 'contain') {
        layer.size = first;
        i += 2;
      } else if (first !== undefined && isSizePart(first, ctx)) {
        const two =
          i + 2 < parts.length && isSizePart(parts[i + 2].toLowerCase(), ctx);
        layer.size =
          backgroundSizeOf(parts.slice(i + 1, i + (two ? 3 : 2)), ctx) ??
          'auto';
        i += two ? 3 : 2;
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

/**
 * A `linear-gradient()`, or null for any other image function and for one
 * that is no gradient: a direction by angle, by side or by corner, with a
 * colour interpolation method (`in oklab`, which Tailwind 4 writes) read and
 * not honoured, and at least two stops, each with no position, one, or two;
 * a bare percentage between stops, a hint, is passed over.
 */
function parseLinearGradient(
  text: string,
  ctx: UnitContext,
): LinearGradient | null {
  const m = /^linear-gradient\((.*)\)$/is.exec(text.trim());
  if (!m) return null;
  const args = splitCommas(m[1]).map((a) => a.trim());
  const out: LinearGradient = { angle: Math.PI, corner: null, stops: [] };
  const first = (args[0] ?? '')
    .toLowerCase()
    .replace(
      /\bin\s+[a-z-]+(?:\s+(?:shorter|longer|increasing|decreasing)\s+hue)?/,
      '',
    )
    .trim();
  let from = 0;
  if (!first || first.startsWith('to ')) {
    from = 1;
    const sides = first.split(/\s+/).slice(1).sort();
    const side = sides.join(' ');
    const SIDES: Record<string, number> = {
      top: 0,
      right: Math.PI / 2,
      bottom: Math.PI,
      left: (3 * Math.PI) / 2,
    };
    if (sides.length === 1 && side in SIDES) out.angle = SIDES[side];
    else if (sides.length === 2) {
      const [a, b] = sides;
      const vertical = a === 'bottom' || a === 'top' ? a : b;
      const horizontal = a === 'left' || a === 'right' ? a : b;
      if (vertical === horizontal) return null;
      out.corner = `${vertical} ${horizontal}` as LinearGradient['corner'];
    } else if (sides.length) return null;
  } else {
    const angle = /^(-?\d*\.?\d+)(deg|rad|grad|turn)?$/.exec(first);
    if (angle) {
      const n = Number(angle[1]);
      const unit = angle[2] ?? (n === 0 ? 'deg' : '');
      const turns: Record<string, number> = {
        deg: 1 / 360,
        rad: 1 / (2 * Math.PI),
        grad: 1 / 400,
        turn: 1,
      };
      if (!(unit in turns)) return null;
      out.angle = n * turns[unit] * 2 * Math.PI;
      from = 1;
    }
  }
  for (const arg of args.slice(from)) {
    const parts = splitValue(arg);
    const color = parseColor(parts[0] ?? '');
    if (color === null) {
      // a hint, the midpoint of the transition, which this does not move
      if (parts.length === 1 && parseLength(parts[0], ctx) !== null) continue;
      return null;
    }
    if (parts.length > 3) return null;
    const at = parts.slice(1).map((p) => parseLength(p, ctx));
    if (at.some((p) => p === null || p === AUTO)) return null;
    if (!at.length) out.stops.push({ color, at: null });
    for (const p of at) out.stops.push({ color, at: p as Len });
  }
  return out.stops.length >= 2 ? out : null;
}

/** The images CSS3 has beyond `url()`, which a layer may name: a linear
 *  gradient is drawn, and the rest draw as nothing. */
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

type WhiteSpace = ComputedStyle['whiteSpace'];
type Collapse = 'collapse' | 'preserve' | 'preserve-breaks';

/** What each `white-space` keeps of the white space (CSS Text 4, 3.1). */
const COLLAPSE_OF: Record<WhiteSpace, Collapse> = {
  normal: 'collapse',
  nowrap: 'collapse',
  pre: 'preserve',
  'pre-wrap': 'preserve',
  'pre-line': 'preserve-breaks',
};

function wrapsIn(whiteSpace: WhiteSpace): boolean {
  return whiteSpace !== 'nowrap' && whiteSpace !== 'pre';
}

/** The `white-space` of a collapse and a wrap. Kept breaks and no wrapping
 *  have no keyword of their own, and keep their breaks, as `pre-line`. */
function whiteSpaceOf(collapse: Collapse, wrap: boolean): WhiteSpace {
  if (collapse === 'collapse') return wrap ? 'normal' : 'nowrap';
  if (collapse === 'preserve') return wrap ? 'pre-wrap' : 'pre';
  return 'pre-line';
}

/**
 * The translation a `transform` makes: the sum of its translate functions'
 * and its matrices' — `translate(-50%, -50%)`, Tailwind 3's `translate(
 * var(--tw-translate-x), var(--tw-translate-y)) rotate(…) skewX(…) …` —
 * with the functions that rotate, scale, skew or add perspective read and
 * not drawn. Null for `none`, and undefined for what is no transform list,
 * which drops the declaration.
 */
function transformTranslation(
  value: string,
  ctx: UnitContext,
): [Len, Len] | null | undefined {
  if (value.trim().toLowerCase() === 'none') return null;
  let x: Len = 0;
  let y: Len = 0;
  const parts = splitValue(value);
  if (!parts.length) return undefined;
  for (const part of parts) {
    const m = /^([a-z0-9]+)\((.*)\)$/is.exec(part.trim());
    if (!m) return undefined;
    const name = m[1].toLowerCase();
    const args = splitCommas(m[2]).map((a) => a.trim());
    let dx: Len | null = 0;
    let dy: Len | null = 0;
    if (name === 'translate' || name === 'translate3d') {
      dx = parseLength(args[0] ?? '', ctx);
      dy = args[1] === undefined ? 0 : parseLength(args[1], ctx);
    } else if (name === 'translatex') dx = parseLength(args[0] ?? '', ctx);
    else if (name === 'translatey') dy = parseLength(args[0] ?? '', ctx);
    else if (name === 'matrix' || name === 'matrix3d') {
      // the translation is the last column's
      const n = args.map(Number);
      if (n.length !== (name === 'matrix' ? 6 : 16) || n.some(isNaN)) {
        return undefined;
      }
      [dx, dy] = name === 'matrix' ? [n[4], n[5]] : [n[12], n[13]];
    } else if (!TRANSFORMS.has(name)) return undefined;
    if (dx === null || dx === AUTO || dy === null || dy === AUTO) {
      return undefined;
    }
    const sx = addLen(x, dx);
    const sy = addLen(y, dy);
    if (sx === null || sy === null) return undefined;
    x = sx;
    y = sy;
  }
  return [x, y];
}

/** The transform functions read and not drawn. */
const TRANSFORMS = new Set([
  'translatez',
  'rotate',
  'rotatex',
  'rotatey',
  'rotatez',
  'rotate3d',
  'scale',
  'scalex',
  'scaley',
  'scalez',
  'scale3d',
  'skew',
  'skewx',
  'skewy',
  'perspective',
]);

/** Two lengths added, a percentage and a length kept apart; null where
 *  one is a `min()` or a `max()`, which a sum cannot be kept of. */
function addLen(a: Len, b: Len): Len | null {
  if (a === AUTO || b === AUTO) return null;
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (a === 0) return b;
  if (b === 0) return a;
  const pa: Pct = typeof a === 'number' ? { pct: 0, px: a } : a;
  const pb: Pct = typeof b === 'number' ? { pct: 0, px: b } : b;
  if (pa.of || pb.of) return null;
  return { pct: pa.pct + pb.pct, px: (pa.px ?? 0) + (pb.px ?? 0) };
}

/** An intrinsic size keyword, with the prefixes browsers still read, or
 *  `fit-content()` of a length or a percentage (CSS Sizing 3, 3.1) — a
 *  width's, where a height's is its content height as the keyword is;
 *  null for anything else. */
function contentSizeOf(
  value: string,
  ctx: UnitContext,
  inline: boolean,
): ContentSize | null {
  const v = value
    .trim()
    .toLowerCase()
    .replace(/^-(?:webkit|moz)-/, '');
  if (v === 'min-content' || v === 'max-content' || v === 'fit-content') {
    return v;
  }
  const m = /^fit-content\((.*)\)$/s.exec(v);
  if (!m) return null;
  const fit = parseLength(m[1], ctx);
  if (fit === null || fit === AUTO || !notNegative(fit)) return null;
  return inline ? { fit } : 'fit-content';
}

/** A `background-size`: `cover`, `contain`, `auto`, or one or two of a
 *  length, a percentage and `auto`, the second `auto` where there is none;
 *  null for what is none of these. */
function backgroundSizeOf(
  parts: string[],
  ctx: UnitContext,
): ComputedStyle['backgroundSize'] | null {
  const words = parts.map((p) => p.toLowerCase());
  if (words.length === 1 && (words[0] === 'cover' || words[0] === 'contain')) {
    return words[0];
  }
  if (!words.length || words.length > 2) return null;
  if (!words.every((w) => isSizePart(w, ctx))) return null;
  const axis = (w: string | undefined): Len | 'auto' => {
    if (w === undefined || w === 'auto') return 'auto';
    const len = positionLength(w, ctx);
    return len === null || len === AUTO ? 'auto' : len;
  };
  const width = axis(words[0]);
  const height = axis(words[1]);
  return width === 'auto' && height === 'auto' ? 'auto' : [width, height];
}

/** `center/cover` is three tokens, as `center / cover` is. */
function splitSlash(part: string): string[] {
  if (!part.includes('/') || part.includes('(')) return [part];
  return part.split(/(\/)/).filter(Boolean);
}

type VariantKind = 'numeric' | 'caps' | 'ligatures' | 'position';

/** Each `font-variant` keyword: the longhand it belongs to and the features
 *  it stands for (CSS Fonts 3, 6). */
const VARIANTS: Record<string, [VariantKind, string]> = {
  'lining-nums': ['numeric', 'lnum=1'],
  'oldstyle-nums': ['numeric', 'onum=1'],
  'proportional-nums': ['numeric', 'pnum=1'],
  'tabular-nums': ['numeric', 'tnum=1'],
  'diagonal-fractions': ['numeric', 'frac=1'],
  'stacked-fractions': ['numeric', 'afrc=1'],
  ordinal: ['numeric', 'ordn=1'],
  'slashed-zero': ['numeric', 'zero=1'],
  'small-caps': ['caps', 'smcp=1'],
  'all-small-caps': ['caps', 'c2sc=1,smcp=1'],
  'petite-caps': ['caps', 'pcap=1'],
  'all-petite-caps': ['caps', 'c2pc=1,pcap=1'],
  unicase: ['caps', 'unic=1'],
  'titling-caps': ['caps', 'titl=1'],
  'common-ligatures': ['ligatures', 'liga=1,clig=1'],
  'no-common-ligatures': ['ligatures', 'liga=0,clig=0'],
  'discretionary-ligatures': ['ligatures', 'dlig=1'],
  'no-discretionary-ligatures': ['ligatures', 'dlig=0'],
  'historical-ligatures': ['ligatures', 'hlig=1'],
  'no-historical-ligatures': ['ligatures', 'hlig=0'],
  contextual: ['ligatures', 'calt=1'],
  'no-contextual': ['ligatures', 'calt=0'],
  sub: ['position', 'subs=1'],
  super: ['position', 'sups=1'],
};

const VARIANT_FIELDS = {
  numeric: 'fontVariantNumeric',
  caps: 'fontVariantCaps',
  ligatures: 'fontVariantLigatures',
  position: 'fontVariantPosition',
} as const;

const ALL_VARIANTS: VariantKind[] = [
  'numeric',
  'caps',
  'ligatures',
  'position',
];

/**
 * A `font-variant` longhand's value, or the shorthand's (`kind` null), as
 * the fields it sets; null for a value it does not take. The shorthand
 * sets all four, the ones it names nothing of back to `normal`.
 */
function parseFontVariant(
  value: string,
  kind: VariantKind | null,
): Partial<ComputedStyle> | null {
  const words = value.trim().toLowerCase().split(/\s+/);
  const kinds = kind ? [kind] : ALL_VARIANTS;
  const named: Partial<Record<VariantKind, string[]>> = {};
  if (words.length === 1 && words[0] === 'normal') {
    // every longhand the value sets goes back to none
  } else if (
    words.length === 1 &&
    words[0] === 'none' &&
    (kind === null || kind === 'ligatures')
  ) {
    named.ligatures = ['liga=0,clig=0,dlig=0,hlig=0,calt=0'];
  } else {
    for (const word of words) {
      const known = VARIANTS[word];
      if (!known || !kinds.includes(known[0])) return null;
      (named[known[0]] ??= []).push(known[1]);
    }
  }
  const fields: Partial<ComputedStyle> = {};
  for (const k of kinds) {
    fields[VARIANT_FIELDS[k]] = (named[k] ?? []).join(',');
  }
  return fields;
}

/** `font-feature-settings`: `"tnum", "liga" 0, "ss01" on` as `tnum=1,…`,
 *  '' for `normal`, and null for a value that is neither. */
function parseFeatureSettings(value: string): string | null {
  const v = value.trim();
  if (v.toLowerCase() === 'normal') return '';
  const pairs: string[] = [];
  for (const part of splitCommas(v)) {
    const m = /^(["'])([\x20-\x7e]{4})\1(?:\s+(on|off|\d+))?$/i.exec(
      part.trim(),
    );
    if (!m) return null;
    const setting = (m[3] ?? 'on').toLowerCase();
    const n = setting === 'on' ? 1 : setting === 'off' ? 0 : Number(setting);
    pairs.push(`${m[2]}=${n}`);
  }
  return pairs.join(',');
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
  let smallCaps = false;
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
    } else if (v === 'small-caps') smallCaps = true;
    else if (v === 'normal') continue;
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
  // dropped whole, as CSS drops any value it cannot read — a line height
  // below nought included: `font: 4em/-2em serif` set the text at 4em.
  const size =
    keywordFontSize(sizeText ?? '', parent.fontSize, ctx.rem) ??
    parseLength(sizeText ?? '', { ...ctx, em: parent.fontSize });
  if (!family || size === null || size === AUTO) return;
  if (lineText && negativeLength(lineText, ctx)) return;
  // What the shorthand does not name goes back to its initial value rather
  // than keeping the parent's (CSS 2.1 15.8): `p { font: 12pt serif }`
  // inside a document set at `20px/1em` has lines of normal height, not 20px.
  style.fontStyle = fontStyle;
  style.fontWeight = weight ? parseWeight(weight, parent.fontWeight) : 400;
  // the variants too, save the small capitals it may name; not the
  // features `font-feature-settings` sets, which the shorthand leaves
  style.fontVariantNumeric = '';
  style.fontVariantCaps = smallCaps ? 'smcp=1' : '';
  style.fontVariantLigatures = '';
  style.fontVariantPosition = '';
  style.fontKerning = '';
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

/** Whether a line height is a number or a length below nought. */
function negativeLength(value: string, ctx: UnitContext): boolean {
  const n = parseNumber(value);
  if (n !== null) return n < 0;
  const len = parseLength(value, ctx);
  if (typeof len === 'number') return len < 0;
  return !!len && typeof len === 'object' && resolve(len, 100) < 0;
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
  let basis: Len | 'content' | null = null;
  for (const part of parts) {
    if (part.toLowerCase() === 'content') {
      basis = 'content';
      continue;
    }
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

// --- grid ------------------------------------------------------------------

const AUTO_TRACK: GridTrack = { min: 'auto', max: 'auto' };

/** One track's sizing, or null for what is not one. */
function parseGridTrack(token: string, ctx: UnitContext): GridTrack | null {
  const t = token.trim().toLowerCase();
  if (!t) return null;
  if (t === 'auto') return AUTO_TRACK;
  if (t === 'min-content' || t === 'max-content') return { min: t, max: t };
  const fr = /^(\d*\.?\d+)fr$/.exec(t);
  if (fr) return { min: 'auto', max: { fr: Number(fr[1]) } };
  const fn = /^(minmax|fit-content)\((.*)\)$/s.exec(t);
  if (fn) {
    if (fn[1] === 'fit-content') {
      const fit = parseLength(fn[2].trim(), ctx);
      if (fit === null || fit === AUTO) return null;
      if (typeof fit === 'number' && fit < 0) return null;
      return { min: AUTO, max: { fit } };
    }
    const [a, b] = splitCommas(fn[2]).map((p) => p.trim());
    if (a === undefined || b === undefined) return null;
    const min = parseGridTrack(a, ctx);
    const max = parseGridTrack(b, ctx);
    // an `fr` is no minimum
    if (
      !min ||
      !max ||
      (typeof min.max === 'object' && min.max !== null && 'fr' in min.max)
    )
      return null;
    return { min: min.min, max: max.max };
  }
  const len = parseLength(token.trim(), ctx);
  if (len === null || len === AUTO) return null;
  return { min: len, max: len };
}

/**
 * A track list's parts: a bracketed group of line names as one part, a
 * quoted string as one, and a size or a function as one — a group of two
 * names was two parts, and the second was no size. Undefined where a
 * bracket or a quote is not closed.
 */
function trackParts(value: string): string[] | undefined {
  const out: string[] = [];
  const text = value.trim();
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const close = ch === '[' ? ']' : ch === '"' || ch === "'" ? ch : null;
    if (close) {
      const end = text.indexOf(close, i + 1);
      if (end < 0) return undefined;
      out.push(text.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < text.length; j += 1) {
      const c = text[j];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (depth === 0 && /[\s["']/.test(c)) break;
    }
    out.push(text.slice(i, j));
    i = j;
  }
  return out;
}

/** The names in a bracketed group of line names, or undefined for a part
 *  that is not one or names what no line may be called. */
function lineNames(part: string): string[] | undefined {
  if (!part.startsWith('[') || !part.endsWith(']')) return undefined;
  const names = part.slice(1, -1).trim().split(/\s+/).filter(Boolean);
  return names.every(isLineName) ? names : undefined;
}

/** A `<custom-ident>` a grid line may take: not `span` nor `auto`. */
function isLineName(word: string): boolean {
  return (
    /^-?[a-zA-Z_\u0080-\uffff][\w\u0080-\uffff-]*$/.test(word) &&
    !/^(span|auto|inherit|initial|unset|default)$/i.test(word)
  );
}

/**
 * A track list (CSS Grid 1, 7.2): lengths, `fr`s, `auto`, `minmax()`,
 * `fit-content()`, `repeat()` with a count or with `auto-fill`/`auto-fit`,
 * whose count the width decides, and the names of the lines between them.
 * Undefined for a list that is none.
 */
function parseGridTemplate(
  value: string,
  ctx: UnitContext,
): GridTemplate | undefined {
  const out: GridTemplate = { tracks: [], names: [[]], repeat: null };
  // where a group of names goes: the line after the last track, or the
  // line after an auto repeat until a track follows it
  let pending: string[] | null = null;
  const read = (
    parts: string[],
    into: GridTrack[],
    names: string[][],
    top: boolean,
  ): boolean => {
    for (const part of parts) {
      if (part.startsWith('[')) {
        const group = lineNames(part);
        if (!group) return false;
        (top && pending ? pending : names[names.length - 1]).push(...group);
        continue;
      }
      const repeat = /^repeat\((.*)\)$/is.exec(part);
      if (repeat) {
        const [count, ...rest] = splitCommas(repeat[1]);
        const inner: GridTrack[] = [];
        const innerNames: string[][] = [[]];
        const innerParts = trackParts(rest.join(','));
        if (
          !innerParts ||
          !read(innerParts, inner, innerNames, false) ||
          !inner.length
        ) {
          return false;
        }
        const n = count.trim().toLowerCase();
        if (n === 'auto-fill' || n === 'auto-fit') {
          if (out.repeat || !top) return false;
          out.repeat = {
            at: into.length,
            tracks: inner,
            names: innerNames,
            after: [],
          };
          pending = out.repeat.after;
          continue;
        }
        const times = Number(n);
        if (!Number.isInteger(times) || times < 1 || times > 1000) return false;
        for (let i = 0; i < times; i += 1) {
          names[names.length - 1].push(...innerNames[0]);
          for (let t = 0; t < inner.length; t += 1) {
            into.push(inner[t]);
            names.push([...innerNames[t + 1]]);
          }
        }
        if (top) pending = null;
        continue;
      }
      const track = parseGridTrack(part, ctx);
      if (!track) return false;
      into.push(track);
      names.push([]);
      if (top) pending = null;
    }
    return true;
  };
  const parts = trackParts(value);
  if (!parts || !read(parts, out.tracks, out.names, true)) return undefined;
  if (!out.tracks.length && !out.repeat) return undefined;
  return out;
}

/**
 * `grid-template-areas`' strings (CSS Grid 1, 7.3): a row each, a cell to a
 * word or a run of dots, every row as wide as the first and every name a
 * rectangle. Undefined where they are not.
 */
function parseAreas(strings: string[]): GridAreas | undefined {
  const grid: (string | null)[][] = [];
  for (const quoted of strings) {
    const cells: (string | null)[] = [];
    const text = quoted.slice(1, -1);
    const re = /\s*(?:(\.+)|([\w\u0080-\uffff-]+)|(\S))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) && m[0].trim()) {
      if (m[3]) return undefined;
      cells.push(m[1] ? null : m[2]);
    }
    if (!cells.length) return undefined;
    if (grid.length && cells.length !== grid[0].length) return undefined;
    grid.push(cells);
  }
  const areas: GridAreas['areas'] = new Map();
  grid.forEach((cells, r) =>
    cells.forEach((name, c) => {
      if (name === null) return;
      const area = areas.get(name);
      if (!area) areas.set(name, { rows: [r, r + 1], columns: [c, c + 1] });
      else {
        area.rows[1] = Math.max(area.rows[1], r + 1);
        area.columns[1] = Math.max(area.columns[1], c + 1);
      }
    }),
  );
  // each name fills the rectangle its first and last cells make, and
  // nothing else
  let cellsNamed = 0;
  for (const cells of grid) for (const name of cells) if (name) cellsNamed += 1;
  let rectangles = 0;
  for (const [name, { rows, columns }] of areas) {
    for (let r = rows[0]; r < rows[1]; r += 1) {
      for (let c = columns[0]; c < columns[1]; c += 1) {
        if (grid[r][c] !== name) return undefined;
      }
    }
    rectangles += (rows[1] - rows[0]) * (columns[1] - columns[0]);
  }
  if (rectangles !== cellsNamed) return undefined;
  return { rows: grid.length, columns: grid[0].length, areas };
}

/**
 * `grid-template`'s rows and columns either side of a slash (7.4): the
 * rows as track list, or as the strings of `grid-template-areas`, each
 * string's row the size after it or `auto`, with the names of the lines
 * before and after it. Undefined for no value.
 */
function parseTemplateShorthand(
  value: string,
  ctx: UnitContext,
):
  | {
      rows: GridTemplate | null;
      columns: GridTemplate | null;
      areas: GridAreas | null;
    }
  | undefined {
  const parts = splitTopLevelSlash(value);
  if (parts.length !== 2) return undefined;
  const columnsNone = parts[1].trim().toLowerCase() === 'none';
  const columns = columnsNone ? null : parseGridTemplate(parts[1], ctx);
  if (columns === undefined) return undefined;
  if (!/["']/.test(parts[0])) {
    const rows =
      parts[0].trim().toLowerCase() === 'none'
        ? null
        : parseGridTemplate(parts[0], ctx);
    return rows === undefined ? undefined : { rows, columns, areas: null };
  }
  // the strings' form takes no `repeat()` for its columns
  if (columns?.repeat) return undefined;
  const pieces = trackParts(parts[0]);
  if (!pieces) return undefined;
  const tracks: GridTrack[] = [];
  const names: string[][] = [[]];
  const strings: string[] = [];
  // after a string, and before its size, if it has one
  let open = false;
  for (const piece of pieces) {
    if (piece.startsWith('[')) {
      const group = lineNames(piece);
      if (!group) return undefined;
      if (open) {
        tracks.push(AUTO_TRACK);
        names.push([]);
        open = false;
      }
      names[names.length - 1].push(...group);
      continue;
    }
    if (/^["']/.test(piece)) {
      if (open) {
        tracks.push(AUTO_TRACK);
        names.push([]);
      }
      strings.push(piece);
      open = true;
      continue;
    }
    if (!open) return undefined;
    const track = parseGridTrack(piece, ctx);
    if (!track) return undefined;
    tracks.push(track);
    names.push([]);
    open = false;
  }
  if (open) {
    tracks.push(AUTO_TRACK);
    names.push([]);
  }
  const areas = parseAreas(strings);
  if (!areas) return undefined;
  if (columns && columns.tracks.length !== areas.columns) return undefined;
  return { rows: { tracks, names, repeat: null }, columns, areas };
}

/**
 * A grid line (CSS Grid 1, 8.3): `auto`; a number; a name; a number and a
 * name, in either order; or `span` with a number, a name or both.
 * Undefined for a value that is none of them.
 */
function parseGridLine(value: string | undefined): GridLine | undefined {
  if (value === undefined) return null;
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1 && words[0].toLowerCase() === 'auto') return null;
  let span = false;
  let count: number | null = null;
  let name: string | null = null;
  for (const word of words) {
    if (word.toLowerCase() === 'span') {
      if (span) return undefined;
      span = true;
    } else if (/^[+-]?\d+$/.test(word)) {
      if (count !== null) return undefined;
      count = Number(word);
    } else if (isLineName(word)) {
      if (name !== null) return undefined;
      name = word;
    } else return undefined;
  }
  // `span` goes first or last, never between a number and a name
  if (span && words.length === 3 && words[1].toLowerCase() === 'span') {
    return undefined;
  }
  if (span) {
    if (count !== null && count < 1) return undefined;
    const out: { span: number; name?: string } = { span: count ?? 1 };
    if (name !== null) out.name = name;
    return out;
  }
  if (count !== null) {
    if (count === 0) return undefined;
    return name === null ? { line: count } : { line: count, name };
  }
  return name === null ? undefined : { name };
}

/** A grid line that is a name alone, which a shorthand copies to the
 *  line it leaves out; auto for any other. */
function named(line: GridLine | undefined): GridLine {
  return line && 'name' in line && !('line' in line) && !('span' in line)
    ? line
    : null;
}

/** A value's parts either side of a top-level `/`. */
function splitTopLevelSlash(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === '/' && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out;
}

// --- logical properties ----------------------------------------------------

const OBJECT_FITS = new Set(['fill', 'contain', 'cover', 'none', 'scale-down']);

/**
 * `aspect-ratio` (CSS Sizing 4, 5.1): `auto`, a ratio — one number, or
 * two with a `/` between — or both, in either order. Undefined where it is
 * none of that, and the declaration is dropped; a ratio with a nought in it
 * is none, and `auto` is what is left.
 */
function parseAspectRatio(
  value: string,
): ComputedStyle['aspectRatio'] | undefined {
  let auto = false;
  let rest = value.trim().toLowerCase();
  const word = /(?:^auto\s+|\s+auto$|^auto$)/.exec(rest);
  if (word) {
    auto = true;
    rest = rest.replace(word[0], '').trim();
    if (!rest) return null;
  }
  const m =
    /^(\d*\.?\d+(?:e[+-]?\d+)?)(?:\s*\/\s*(\d*\.?\d+(?:e[+-]?\d+)?))?$/.exec(
      rest,
    );
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = m[2] === undefined ? 1 : Number(m[2]);
  if (!(w > 0 && h > 0)) return null;
  return { ratio: w / h, auto };
}

/**
 * A `box-shadow` (CSS Backgrounds 3, 7.1): `none`, or shadows front to
 * back, each two offsets and then a blur and a spread, with a colour and
 * `inset` on either side of the lengths. Undefined where the value is none
 * of that, and the declaration is dropped. A shadow no colour can be seen
 * in is left out — Tailwind writes four of them, `0 0 #0000`, under every
 * one it means.
 */
/** `box-shadow`'s shadows, or with `text` `text-shadow`'s, which have no
 *  spread and are never inset (CSS Text Decoration 3, 4): null for none,
 *  and undefined for a value that is not one. */
function parseBoxShadow(
  value: string,
  ctx: UnitContext,
  text = false,
): BoxShadow[] | null | undefined {
  if (value.trim().toLowerCase() === 'none') return null;
  const out: BoxShadow[] = [];
  for (const part of splitCommas(value)) {
    let inset = false;
    let color: string | null = null;
    const lengths: number[] = [];
    // the lengths are written together, with nothing between them
    let closed = false;
    for (const token of splitValue(part.trim())) {
      if (token.toLowerCase() === 'inset') {
        if (inset || text) return undefined;
        inset = true;
        closed = lengths.length > 0;
        continue;
      }
      const len = parseLength(token, ctx);
      if (typeof len === 'number') {
        if (closed || lengths.length === (text ? 3 : 4)) return undefined;
        lengths.push(len);
        continue;
      }
      const c = parseColor(token);
      if (c === null || color !== null) return undefined;
      color = c;
      closed = lengths.length > 0;
    }
    if (lengths.length < 2) return undefined;
    const [x, y, blur = 0, spread = 0] = lengths;
    if (blur < 0) return undefined;
    const ink = color ?? 'currentColor';
    if (alphaOf(ink) === 0 || isTransparent(ink)) continue;
    out.push({ x, y, blur, spread, color: ink, inset });
  }
  return out.length ? out : null;
}

/** A corner's radius: a length or a percentage, and neither negative nor
 *  `auto`; null where it is none. */
function radiusOf(text: string, ctx: UnitContext): Len | null {
  const len = parseLength(text, ctx);
  if (len === null || len === AUTO) return null;
  if (typeof len === 'number') return len < 0 ? null : len;
  return len.pct < 0 && !len.px && !len.of ? null : len;
}

/** Whether two corners' radii are the same values. */
function sameRadii(a: readonly Len[], b: readonly Len[]): boolean {
  for (let i = 0; i < 4; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x !== 'object' || typeof y !== 'object') return false;
    if (x.pct !== y.pct || x.px !== y.px || x.of || y.of) return false;
  }
  return true;
}

/** The four corners, in `border-radius`'s order. */
const CORNERS = [
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
];

type Side = 'inline-start' | 'inline-end' | 'block-start' | 'block-end';

/** What a logical property stands for: a physical one found by a side, the
 *  two sides of an axis, or a corner. */
type Logical =
  | { kind: 'side'; side: Side; physical: (side: string) => string }
  | {
      kind: 'axis';
      axis: 'inline' | 'block';
      /** One value for both sides, as `border-inline` takes it, rather
       *  than one each, as `margin-inline` does. */
      same: boolean;
      physical: (side: string) => string;
      valid: (part: string, ctx: UnitContext) => boolean;
    }
  | { kind: 'size'; physical: string }
  | { kind: 'corner'; block: 'start' | 'end'; inline: 'start' | 'end' };

/**
 * CSS Logical Properties 1, in the horizontal writing mode `<Html>` lays
 * out: the inline axis is the line's, its start the left of a
 * left-to-right element and the right of a right-to-left one, and the block
 * axis runs down. Tailwind 4 writes its spacing in them — `px-4` is
 * `padding-inline`, `mx-auto` is `margin-inline: auto` — and every modern
 * reset writes some.
 */
const LOGICAL: Record<string, Logical> = (() => {
  const out: Record<string, Logical> = {};
  const length = (part: string, ctx: UnitContext) =>
    parseLength(part, ctx) !== null;
  const groups: [
    string,
    (side: string) => string,
    (part: string, ctx: UnitContext) => boolean,
  ][] = [
    ['margin', (side) => `margin-${side}`, length],
    [
      'padding',
      (side) => `padding-${side}`,
      (part, ctx) => validPadding(parseLength(part, ctx)),
    ],
    ['inset', (side) => side, length],
    [
      'border-*-width',
      (side) => `border-${side}-width`,
      (part, ctx) => borderWidth(part, ctx) !== null,
    ],
    [
      'border-*-style',
      (side) => `border-${side}-style`,
      (part) => BORDER_STYLES.has(part.toLowerCase()),
    ],
    [
      'border-*-color',
      (side) => `border-${side}-color`,
      (part) => parseColor(part) !== null,
    ],
  ];
  for (const [group, physical, valid] of groups) {
    for (const axis of ['inline', 'block'] as const) {
      const name = group.includes('*')
        ? group.replace('*', axis)
        : `${group}-${axis}`;
      out[name] = { kind: 'axis', axis, same: false, physical, valid };
      for (const end of ['start', 'end'] as const) {
        const side = `${axis}-${end}` as Side;
        const longhand = group.includes('*')
          ? group.replace('*', side)
          : `${group}-${side}`;
        out[longhand] = { kind: 'side', side, physical };
      }
    }
  }
  for (const axis of ['inline', 'block'] as const) {
    out[`border-${axis}`] = {
      kind: 'axis',
      axis,
      same: true,
      physical: (side) => `border-${side}`,
      valid: () => true,
    };
    for (const end of ['start', 'end'] as const) {
      out[`border-${axis}-${end}`] = {
        kind: 'side',
        side: `${axis}-${end}`,
        physical: (side) => `border-${side}`,
      };
    }
  }
  const sizes: [string, string][] = [
    ['inline-size', 'width'],
    ['block-size', 'height'],
    ['min-inline-size', 'min-width'],
    ['min-block-size', 'min-height'],
    ['max-inline-size', 'max-width'],
    ['max-block-size', 'max-height'],
  ];
  for (const [name, physical] of sizes) out[name] = { kind: 'size', physical };
  for (const block of ['start', 'end'] as const) {
    for (const inline of ['start', 'end'] as const) {
      out[`border-${block}-${inline}-radius`] = {
        kind: 'corner',
        block,
        inline,
      };
    }
  }
  return out;
})();

/** The physical side a logical one is, by the element's direction. */
function physicalSide(side: Side, rtl: boolean): string {
  switch (side) {
    case 'inline-start':
      return rtl ? 'right' : 'left';
    case 'inline-end':
      return rtl ? 'left' : 'right';
    case 'block-start':
      return 'top';
    default:
      return 'bottom';
  }
}

/**
 * A logical declaration, as the physical ones it stands for. The direction
 * is the element's as far as the cascade has got: its parent's, or one it
 * set itself earlier in cascade order, which is where HTML's `dir` puts it.
 * A two-value shorthand with a part that is no value for its property is
 * none, and the declaration goes, as a physical shorthand's does.
 */
function applyLogical(
  style: ComputedStyle,
  parent: ComputedStyle,
  logical: Logical,
  value: string,
  ctx: UnitContext,
): void {
  const rtl = style.direction === 'rtl';
  switch (logical.kind) {
    case 'side':
      applyDeclaration(
        style,
        parent,
        logical.physical(physicalSide(logical.side, rtl)),
        value,
        ctx,
      );
      return;
    case 'size':
      applyDeclaration(style, parent, logical.physical, value, ctx);
      return;
    case 'corner': {
      const vertical = logical.block === 'start' ? 'top' : 'bottom';
      const left = (logical.inline === 'start') !== rtl;
      applyDeclaration(
        style,
        parent,
        `border-${vertical}-${left ? 'left' : 'right'}-radius`,
        value,
        ctx,
      );
      return;
    }
    default: {
      const start = physicalSide(`${logical.axis}-start`, rtl);
      const end = physicalSide(`${logical.axis}-end`, rtl);
      let parts: string[];
      if (logical.same || CSS_WIDE.has(value.toLowerCase())) {
        parts = [value, value];
      } else {
        parts = splitValue(value);
        if (parts.length === 1) parts.push(parts[0]);
        if (parts.length !== 2 || !parts.every((p) => logical.valid(p, ctx)))
          return;
      }
      applyDeclaration(style, parent, logical.physical(start), parts[0], ctx);
      applyDeclaration(style, parent, logical.physical(end), parts[1], ctx);
    }
  }
}

const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert']);

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

const INHERITED_NAMES = new Set<string>([
  'color',
  '-webkit-text-fill-color',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'text-align',
  'text-align-last',
  'text-justify',
  'block-ellipsis',
  'text-indent',
  'text-transform',
  'letter-spacing',
  'word-spacing',
  'white-space',
  'overflow-wrap',
  'word-wrap',
  'word-break',
  'line-break',
  'white-space-collapse',
  'text-wrap',
  'text-wrap-mode',
  'text-wrap-style',
  'direction',
  'visibility',
  'list-style',
  'list-style-type',
  'list-style-position',
  'list-style-image',
  'cursor',
  'border-collapse',
  'border-spacing',
  'empty-cells',
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
  '-webkit-text-fill-color': ['textFillColor'],
  'background-clip': ['backgroundClipText'],
  '-webkit-background-clip': ['backgroundClipText'],
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
    'fontVariantNumeric',
    'fontVariantCaps',
    'fontVariantLigatures',
    'fontVariantPosition',
    'fontKerning',
  ],
  'line-height': ['lineHeight', 'lineHeightIsLength'],
  'text-align': ['textAlign', 'alignBlocks'],
  'text-align-last': ['textAlignLast'],
  'text-justify': ['textJustify'],
  'text-indent': ['textIndent'],
  'text-transform': ['textTransform'],
  'letter-spacing': ['letterSpacing'],
  'word-spacing': ['wordSpacing'],
  'font-variant': [
    'fontVariantNumeric',
    'fontVariantCaps',
    'fontVariantLigatures',
    'fontVariantPosition',
  ],
  'font-variant-numeric': ['fontVariantNumeric'],
  'font-variant-caps': ['fontVariantCaps'],
  'font-variant-ligatures': ['fontVariantLigatures'],
  'font-variant-position': ['fontVariantPosition'],
  'font-kerning': ['fontKerning'],
  'font-feature-settings': ['fontFeatureSettings'],
  'tab-size': ['tabSize', 'tabSizeIsLength'],
  '-moz-tab-size': ['tabSize', 'tabSizeIsLength'],
  'white-space': ['whiteSpace'],
  'overflow-wrap': ['overflowWrap'],
  'word-wrap': ['overflowWrap'],
  'word-break': ['wordBreak'],
  'line-break': ['lineBreakAnywhere'],
  'white-space-collapse': ['whiteSpace'],
  'text-wrap': ['whiteSpace', 'textWrapStyle'],
  'text-wrap-mode': ['whiteSpace'],
  'text-wrap-style': ['textWrapStyle'],
  direction: ['direction'],
  'unicode-bidi': ['unicodeBidi'],
  visibility: ['visibility'],
  'list-style': ['listStyleType', 'listStylePosition', 'listStyleImage'],
  'list-style-type': ['listStyleType'],
  'list-style-position': ['listStylePosition'],
  'list-style-image': ['listStyleImage'],
  cursor: ['cursor'],
  'border-collapse': ['borderCollapse'],
  'caption-side': ['captionSide'],
  'empty-cells': ['emptyCells'],
  quotes: ['quotes'],
  content: ['content'],
  'counter-reset': ['counterReset'],
  'counter-increment': ['counterIncrement'],
  'counter-set': ['counterSet'],
  'border-spacing': ['borderSpacing', 'borderSpacingY'],
  display: ['display', 'flowRoot', 'webkitBox', 'grid'],
  width: ['width', 'widthKeyword'],
  height: ['height', 'heightKeyword'],
  'min-width': ['minWidth', 'minWidthKeyword'],
  'max-width': ['maxWidth', 'maxWidthKeyword'],
  'min-height': ['minHeight', 'minHeightKeyword'],
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
  'box-shadow': ['boxShadow'],
  outline: ['outlineStyle', 'outlineWidth', 'outlineColor'],
  'outline-style': ['outlineStyle'],
  'outline-width': ['outlineWidth'],
  'outline-color': ['outlineColor'],
  'outline-offset': ['outlineOffset'],
  'text-shadow': ['textShadow'],
  'line-clamp': ['maxLines', 'clampContinue', 'blockEllipsis'],
  '-webkit-line-clamp': ['maxLines', 'clampContinue', 'blockEllipsis'],
  'max-lines': ['maxLines'],
  continue: ['clampContinue'],
  'block-ellipsis': ['blockEllipsis'],
  '-webkit-box-orient': ['webkitBoxOrient'],
  '-webkit-box-direction': ['webkitBoxDirection'],
  '-webkit-box-pack': ['webkitBoxPack'],
  '-webkit-box-align': ['webkitBoxAlign'],
  '-webkit-box-flex': ['webkitBoxFlex'],
  columns: ['columns'],
  'column-count': ['columns'],
  'column-width': ['columns'],
  'text-overflow': ['textOverflow'],
  // a flex box's and its items', and a grid's
  'flex-direction': ['flexDirection'],
  'flex-wrap': ['flexWrap'],
  'flex-flow': ['flexDirection', 'flexWrap'],
  'justify-content': ['justifyContent'],
  'align-items': ['alignItems'],
  'align-self': ['alignSelf'],
  'align-content': ['alignContent'],
  flex: ['flexGrow', 'flexShrink', 'flexBasis'],
  'flex-grow': ['flexGrow'],
  'flex-shrink': ['flexShrink'],
  'flex-basis': ['flexBasis'],
  order: ['order'],
  gap: ['rowGap', 'columnGap'],
  'row-gap': ['rowGap'],
  'column-gap': ['columnGap'],
  'grid-gap': ['rowGap', 'columnGap'],
  'grid-row-gap': ['rowGap'],
  'grid-column-gap': ['columnGap'],
  'grid-template-columns': ['gridColumns'],
  'grid-template-rows': ['gridRows'],
  'grid-auto-rows': ['gridAutoRows'],
  'grid-auto-columns': ['gridAutoColumns'],
  'grid-template-areas': ['gridAreas'],
  'grid-auto-flow': ['gridAutoFlow'],
  'grid-template': ['gridRows', 'gridColumns', 'gridAreas'],
  grid: [
    'gridRows',
    'gridColumns',
    'gridAreas',
    'gridAutoRows',
    'gridAutoColumns',
    'gridAutoFlow',
  ],
  'grid-area': [
    'gridRowStart',
    'gridColumnStart',
    'gridRowEnd',
    'gridColumnEnd',
  ],
  'grid-row': ['gridRowStart', 'gridRowEnd'],
  'grid-row-start': ['gridRowStart'],
  'grid-row-end': ['gridRowEnd'],
  'grid-column': ['gridColumnStart', 'gridColumnEnd'],
  'grid-column-start': ['gridColumnStart'],
  'grid-column-end': ['gridColumnEnd'],
  'justify-items': ['justifyItems'],
  'justify-self': ['justifySelf'],
  'place-items': ['alignItems', 'justifyItems'],
  'place-self': ['alignSelf', 'justifySelf'],
  'border-radius': ['borderRadius', 'borderRadiusY'],
  'border-top-left-radius': ['borderRadius', 'borderRadiusY'],
  'border-top-right-radius': ['borderRadius', 'borderRadiusY'],
  'border-bottom-right-radius': ['borderRadius', 'borderRadiusY'],
  'border-bottom-left-radius': ['borderRadius', 'borderRadiusY'],
  inset: ['top', 'right', 'bottom', 'left'],
  background: [
    'backgroundColor',
    'backgroundImage',
    'backgroundGradient',
    'backgroundRepeat',
    'backgroundSize',
    'backgroundAttachment',
    'backgroundPositionX',
    'backgroundPositionY',
    'backgroundImages',
    'backgroundRepeats',
    'backgroundSizes',
    'backgroundAttachments',
    'backgroundPositions',
    'backgroundClipText',
  ],
  'background-color': ['backgroundColor'],
  'background-image': [
    'backgroundImage',
    'backgroundGradient',
    'backgroundImages',
  ],
  'background-repeat': ['backgroundRepeat', 'backgroundRepeats'],
  'background-size': ['backgroundSize', 'backgroundSizes'],
  'background-attachment': ['backgroundAttachment', 'backgroundAttachments'],
  'background-position': [
    'backgroundPositionX',
    'backgroundPositionY',
    'backgroundPositions',
  ],
  'aspect-ratio': ['aspectRatio'],
  'object-fit': ['objectFit'],
  appearance: ['appearance'],
  '-webkit-appearance': ['appearance'],
  '-moz-appearance': ['appearance'],
  'object-position': ['objectPositionX', 'objectPositionY'],
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
  translate: ['translate'],
  transform: ['transformTranslate'],
  'z-index': ['zIndex'],
  'vertical-align': ['verticalAlign'],
  'text-decoration': [
    'textDecorationLine',
    'textDecorationColor',
    'textDecorationStyle',
  ],
  'text-decoration-line': ['textDecorationLine'],
  'text-decoration-style': ['textDecorationStyle'],
  'text-decoration-thickness': ['textDecorationThickness'],
  'text-underline-offset': ['textUnderlineOffset'],
  'table-layout': ['tableLayout'],
};

/**
 * A decoration's thickness or an underline's offset: a length, a
 * percentage of the font size, or null for `auto` (and `alsoAuto`, which is
 * `from-font` for a thickness); undefined for a value that is none.
 */
function decorationLength(
  value: string,
  ctx: UnitContext,
  alsoAuto?: string,
): number | null | undefined {
  const v = value.trim().toLowerCase();
  if (v === 'auto' || v === alsoAuto) return null;
  const pct = /^(-?\d*\.?\d+)%$/.exec(v);
  if (pct) return (Number(pct[1]) / 100) * ctx.em;
  const len = parseLength(v, ctx);
  return typeof len === 'number' ? len : undefined;
}

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
  if (own === 'none') return;
  const lines = own.split(' ');
  if (lines.includes('underline')) {
    style.underline = inkColor(
      style.textDecorationColor ?? 'currentColor',
      style.color,
    );
    style.underlineStyle = style.textDecorationStyle;
    style.underlineThickness = style.textDecorationThickness;
    style.underlineOffset = style.textUnderlineOffset;
  }
  if (lines.includes('line-through')) {
    style.lineThrough = inkColor(
      style.textDecorationColor ?? 'currentColor',
      style.color,
    );
  }
}

/**
 * The absolutely positioned styles that were inline-level before they were
 * made blocks: where such a box would have been in flow is on its line,
 * where a block's is under it (CSS 2.1 10.3.7, `staticPositions`).
 */
export const INLINE_BEFORE_ABSOLUTE = new WeakSet<ComputedStyle>();

/**
 * `line-clamp`'s longhands and the legacy flexible box they are written
 * with, settled once the cascade is done, since each reads the others
 * (CSS Overflow 4, 5.1.1 and 5.3). `continue: collapse` makes a block
 * container a line-clamp container, and `-webkit-line-clamp`'s
 * `-webkit-legacy` does only in a `display: -webkit-box` whose
 * `-webkit-box-orient` is vertical — which is then a block of its own
 * formatting context, as Tailwind's `line-clamp-2` writes all four. Any
 * other `-webkit-box` is a flex box, in its orient's direction, packed and
 * aligned as it says, whose items grow and shrink by `-webkit-box-flex`
 * alone (as Blink lays one out). Before `blockify`, whose `display` this
 * decides.
 */
export function settleClamp(
  style: ComputedStyle,
  parent: ComputedStyle | null,
): void {
  const box = style.webkitBox;
  const vertical = style.webkitBoxOrient === 'vertical';
  const collapses =
    style.clampContinue === 'collapse' ||
    (style.clampContinue === 'legacy' && box !== null && vertical);
  if (box !== null) {
    if (collapses && vertical) {
      style.display = box === 'inline' ? 'inline-block' : 'block';
      style.flowRoot = box === 'block';
    } else {
      const reverse = style.webkitBoxDirection === 'reverse';
      style.flexDirection = vertical
        ? reverse
          ? 'column-reverse'
          : 'column'
        : reverse
          ? 'row-reverse'
          : 'row';
      style.flexWrap = 'nowrap';
      style.justifyContent = style.webkitBoxPack ?? 'flex-start';
      style.alignItems = style.webkitBoxAlign ?? 'stretch';
    }
  }
  if (
    parent?.webkitBox &&
    (parent.display === 'flex' || parent.display === 'inline-flex')
  ) {
    style.flexGrow = style.webkitBoxFlex;
    style.flexShrink = style.webkitBoxFlex;
  }
  style.lineClamp =
    collapses && CLAMPS.has(style.display) && !style.columns
      ? (style.maxLines ?? Infinity)
      : null;
}

/** The displays of a block container, which `continue` applies to. */
const CLAMPS = new Set<ComputedStyle['display']>([
  'block',
  'inline-block',
  'list-item',
  'table-cell',
  'table-caption',
]);

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
  if (
    (style.position === 'absolute' || style.position === 'fixed') &&
    (out === 'inline' ||
      out === 'inline-block' ||
      out === 'inline-table' ||
      out === 'inline-flex')
  ) {
    INLINE_BEFORE_ABSOLUTE.add(style);
  }
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
