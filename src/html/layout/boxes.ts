// The box tree: what the DOM and the cascade become before layout runs.
//
// This is the phase that pays for itself twice. Building it is where the
// cascade is driven, where whitespace is collapsed, where anonymous boxes
// are generated and where every element's text is given its slice of the
// document-wide index the selection uses — all of which depend on the DOM
// and the stylesheets and **none of which depend on the width**. So a
// resize re-runs layout over this tree and skips all of it, and a repaint
// skips layout too. Three phases, three invalidation reasons:
//
//   DOM or CSS changed  → rebuild boxes, lay out, paint
//   width changed       → lay out, paint
//   damage only         → paint
//
// The document text is assembled here rather than by a later walk, for the
// reason richtext's node gives for answering from what it draws: an index
// built by a second traversal can disagree with the boxes, and a selection
// that disagrees with the glyphs is worse than no selection.
import type { ChildNode, Element, ParentNode, Text } from 'domhandler';

import type { TextRun } from '../../richtext/index.js';
import {
  attr,
  childrenOf,
  flatChildrenOf,
  flatParentOf,
  imageUrlOf,
  isElement,
  isInputButton,
  isText,
  inImpliedHead,
  NON_RENDERED,
  ShadowRoot,
  shadowRootOf,
  tagOf,
} from '../dom.js';
import {
  ShapeCopies,
  VIEWPORT_AUTO,
  languageOf,
  metaColorScheme,
  overflowGivenToViewport,
} from '../css/cascade.js';
import { outOfPlane } from '../css/transform.js';
import { makeFrame } from './writing.js';
import type {
  Cascade,
  FirstLetterRules,
  KeptStyles,
  SelectionStyle,
  ViewportOverflow,
} from '../css/cascade.js';
import type { CollapsedTable } from './collapse.js';
import { quoteAt } from '../css/content.js';
import type { CounterStyles } from '../css/counter-styles.js';
import type { ContentItem } from '../css/content.js';
import type { DrawingUnits, ShapeStyles } from '../css/shapes.js';
import {
  CONTAIN_INLINE_SIZE,
  CONTAIN_SIZE,
  CONTAIN_STYLE,
  FIRST_LINE_INHERITED,
  NO_MASK,
  copyStyle,
  densityOf,
  firstLineParent,
  inherit,
  urlOf,
} from '../css/style.js';
import { AUTO } from '../css/values.js';
import { focusableElement } from '../focus.js';
import {
  atDensity,
  concreteSize,
  drawsForeignObjects,
  inlineDrawing,
  svgIntrinsics,
} from '../svg.js';
import type { IntrinsicSize } from '../svg.js';
import type { BoxShadow, ComputedStyle } from '../css/style.js';
import type { GridLines } from './grid-lines.js';

export type BoxKind =
  | 'block'
  | 'inline'
  | 'text'
  | 'replaced'
  | 'flex'
  | 'table'
  | 'table-row-group'
  | 'table-row'
  | 'table-cell'
  | 'table-caption'
  | 'marker'
  | 'break';

// What only a few boxes carry lives beside the box rather than in it: a box
// is made for every element and every run of text, and each field on it is
// memory every walk over the tree goes through — fifteen fields more, never
// read, made a document's first paint 6% slower.

/** A list item's marker: its text, a bullet or the item's number, and
 *  where it was laid out. */
export interface Marker {
  text: string;
  layout: TextLayoutLike | null;
  x: number;
  y: number;
  /** Its own style where a `::marker` rule gives it one; the item's where
   *  none does. */
  style: ComputedStyle | null;
  /** The image it is, `list-style-image`'s, where that has arrived, at its
   *  size in device pixels — its own, or the one a marker image with none
   *  is given (`Builder._markerImageSize`); its text is then not drawn.
   *  `gap` is the room between it and the content, in device pixels
   *  (`MARKER_IMAGE_GAP`). */
  image?: { url: string; width: number; height: number; gap: number };
  /** Its text is its own — a string `list-style-type`, a `::marker`'s
   *  `content` — and ends at the content's edge, with no gap a number
   *  or a bullet is set apart by. */
  flush?: true;
}

/**
 * The room between a list marker's image and the item's content, in CSS
 * pixels: between the image and the content's edge outside the item, and
 * after the image inside it. CSS 2.1 (12.5.1) leaves where a marker goes
 * to the user agent, and this is Blink's `kCMarkerPaddingPx`
 * (`ListMarker::InlineMarginsForOutside` and `…ForInside`), which WebKit
 * has too. Outside, ours was the gap a bullet has, 0.4em — 16 pixels at
 * 40px text where Chrome has 7 — and inside the space a marker's text ends
 * in, a space's width. Blink writes it into the marker's margins unzoomed,
 * so at a device scale of 2 Chrome's is 7 device pixels; here it is 7 CSS
 * pixels at any scale, so that a page at 2x is the page at 1x doubled.
 */
const MARKER_IMAGE_GAP = 7;

/** An out-of-flow box's static position, as an offset from the box whose
 *  flow it was taken from, which may yet move. */
export interface StaticPosition {
  from: Box;
  x: number;
  right: number;
  y: number;
  /**
   * For a flex box's or a grid's child, the box it is where it would be as
   * the one item in — `from`'s content box or its padding box, whose size
   * is read once its layout is done — and how far along the free room in
   * it its alignment puts it, from the start across and from the top down.
   */
  inside?: {
    box: 'content' | 'padding';
    across: number;
    down: number;
  };
}

/** The ascent and descent of a decorated inline box's own face. */
export interface InlineDecoration {
  ascent: number;
  descent: number;
}

/**
 * A set of adjoining margins as CSS 2.1 8.3.1 collapses them: the largest
 * positive and the most negative, whose sum is the margin. Kept apart as
 * margins join, because summing at each join is not associative once the
 * signs mix: 2, -4 and 14 collapse to 10, and taken two at a time to 12,
 * and to 8 with a -4 after.
 */
export interface MarginStrut {
  pos: number;
  neg: number;
}

/** A laid-out line inside an inline formatting context. */
export interface LineBox {
  /** Content-box relative, resolved to document coordinates at paint. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** From the line's top — where a text engine's own lines carry theirs
   *  from the top of the layout. */
  baseline: number;
  /**
   * The text on this line, as one or more fragments.
   *
   * More than one whenever an atomic splits the text — `a <img> b` is two
   * fragments of two different `TextLayout`s on one line — which is why this
   * is a list rather than the single layout the common case would suggest.
   */
  texts: LineText[];
  /** Where this line's text sits in the document index, in **code units**. */
  textStart: number;
  textEnd: number;
  /** Atomic items sitting on this line — images, inline-blocks, controls. */
  atomics: AtomicPlacement[];
  /** The inline boxes that open or close on this line, where their own
   *  margin, border and padding sit. */
  edges?: EdgePlacement[];
  /** A `::first-line` style with a background, painted behind the line's
   *  content over its face's height, as an inline box's is. */
  background?: { style: ComputedStyle } & InlineDecoration;
  /** How wide the floats placed at this line's top are, side by side: what
   *  stands beside its content, and so what its content is measured with
   *  where a box is as wide as its content (`intrinsicWidth`). */
  floats?: number;
}

/**
 * One `TextLayout` line, placed on a line box.
 *
 * `drawX`/`drawY` are where the **layout's origin** sits in document
 * coordinates — not where this line sits — because ntk draws a layout, not a
 * line: `layout.draw(ctx, drawX, drawY)` emits every line it holds in one
 * glyph batch, which is exactly the batching that makes a paragraph one
 * composite instead of one per line. So the whole-paragraph case gives every
 * one of its lines the same `drawX`/`drawY` and paint draws it once; the
 * fragment case (text broken around an inline image) gives each fragment a
 * layout holding one line, and each is drawn where it was placed.
 */
export interface LineText {
  layout: TextLayoutLike;
  /** Which of `layout.lines` this fragment is. */
  layoutLine: number;
  /** Where the layout's origin lands, in document coordinates. */
  drawX: number;
  drawY: number;
  /** Document index of this fragment's first and last character, in code
   *  units. */
  textStart: number;
  textEnd: number;
  /** Code-unit offset within the layout's own text that `textStart` maps to,
   *  so a document index can be turned into a caret index in this layout. */
  layoutStart: number;
  /** Where in the layout's text an inline box's edge was laid out as a
   *  spacer: a unit of the layout that is no text of the document's
   *  (`documentOffsetOf`, `layoutOffsetOf`). */
  gaps?: number[];
  /**
   * The spaces `pre-wrap` keeps that this fragment's line ends on, which an
   * engine strips from a line's end as though CSS removed them there: each
   * one's offset in the layout's text and where it is, from the layout's
   * origin, beside the line's end in logical order (`hangPreserved`). They
   * are their inline box's, whose background and border cover them, and
   * the ones before a forced break that fit take room on the line.
   */
  hung?: { at: number; x: number; width: number }[];
  /**
   * How far the line goes on past this text for the collapsible spaces it
   * ends on, which its engine, laying out a piece of a line as a line,
   * stripped: the room they take where more follows them on the line, and
   * none where the line ends on them, since CSS removes them there (CSS
   * Text 3, 4.1.2). They are the text's, in the elements they are in, and
   * `trailRun` is the run they are the end of: whose underline, line
   * through and highlight go on under them.
   */
  trail?: number;
  trailRun?: TextRun;
  /** Any offset in the layout's own text as a document index — how a run
   *  under the pointer finds the element whose text it is. Per pass: the
   *  layout may be one an earlier pass made (`TextLayoutCache`), and the
   *  document index is this parse's. */
  spans: {
    documentAt(offset: number): number;
    /** The text box an offset's text is, where the layout knows. */
    boxAt?(offset: number): Box | null;
    /** Every document index it answers moved by `by`: a block a layout
     *  keeps, whose text a build of subtrees before it moved
     *  (`shiftLines`). Once in a `pass`, which lines that share it ask of
     *  it each. */
    shiftDocument?(by: number, pass: number): void;
  };
}

export interface AtomicPlacement {
  box: Box;
  x: number;
  y: number;
  /** How far its `vertical-align` raises its baseline above its parent's,
   *  worked out as it joined the line; absent for none, and for `top` and
   *  `bottom`, which the line box's edges place instead. */
  raise?: number;
  /** How many of its line's texts are before it in the document — its
   *  place among them, which paint and the hit test order it by (CSS 2.1
   *  Appendix E, 7.2.1): `line.texts` and `line.atomics` are each in the
   *  document's order, and apart. */
  before: number;
}

/**
 * Where an inline box's own margin, border and padding on one side sit on a
 * line: CSS 2.1 puts the start side's before the box's first fragment and the
 * end side's after its last, taking room on those lines (10.3.1). `x` is the
 * edge's outer side, margin included, and `width` all three.
 */
export interface EdgePlacement {
  box: Box;
  side: 'start' | 'end';
  x: number;
  width: number;
}

/** The slice of ntk's `TextLayout` this renderer reads. Structural for the
 *  reason every other element here types ntk structurally: ntk ships no
 *  declarations and this says what it needs and nothing more. */
export interface TextLayoutLike {
  width: number;
  height: number;
  lines: {
    x: number;
    y: number;
    height: number;
    baseline: number;
    width: number;
    /** Its width with the white space it ends on kept, in the item it
     *  ends: how far it moves the pen where text goes on after it on the
     *  same line. ntk's, from 8.17.0; an engine without it leaves it out. */
    advance?: number;
    ascent: number;
    descent: number;
    start: number;
    end: number;
    runs: {
      x: number;
      width: number;
      start: number;
      end: number;
      /** The span as handed in — a richtext `TextRun`, which is how the
       *  decoration a `<span>` carried reaches the paint pass on the same
       *  object the glyphs did. Optional, with `run`, for the reason
       *  `src/richtext/runs.ts` gives: react-x11's Cocoa engine hands back
       *  a run's geometry and nothing else. */
      span?: TextRun;
      run?: {
        font: { metrics(size: number): { ascent: number; descent: number } };
        size: number;
        direction?: 'ltr' | 'rtl';
      };
    }[];
  }[];
  draw(ctx: unknown, x?: number, y?: number): void;
  caretPosition(index: number): {
    x: number;
    y: number;
    height: number;
    line: number;
  };
  indexAt(x: number, y: number): number;
  /** Whether `maxLines` dropped content — the slow inline path's "did this
   *  segment wrap" question, answered without laying the tail out. */
  truncated?: boolean;
}

/**
 * One box. Fields are assigned rather than passed so the shape stays
 * monomorphic — every box has every field, which is what keeps the property
 * access in the layout and paint loops a fixed offset rather than a
 * megamorphic lookup.
 */
export class Box {
  kind: BoxKind;
  el: Element | null;
  style: ComputedStyle;
  parent: Box | null = null;
  children: Box[] = [];

  /** Border-box, in document coordinates, after layout. */
  x = 0;
  y = 0;
  width = 0;
  height = 0;

  /** For an inline box broken around a block in it (CSS 2.1 9.2.1.1), the
   *  sides it goes on from, which have no edge: 1 its start, 2 its end. */
  cut = 0;

  /** Resolved edges — border + padding, per side. */
  borderTop = 0;
  borderRight = 0;
  borderBottom = 0;
  borderLeft = 0;
  padTop = 0;
  padRight = 0;
  padBottom = 0;
  padLeft = 0;
  marginTop = 0;
  marginRight = 0;
  marginBottom = 0;
  marginLeft = 0;
  /** The margin that came out through the box's bottom edge from its last
   *  children, collapsed with its own bottom margin, which is their sum:
   *  kept as a strut for the next sibling's to collapse with. Null where
   *  none came out, which is most boxes. Set by the block layout. */
  bottomStrut: MarginStrut | null = null;
  /** An inline box with a background, a border or a shadow to paint behind
   *  its fragments: the ascent and descent of its own face, the height CSS
   *  paints them over (10.6.1). Set by the inline layout. */
  decoration: InlineDecoration | null = null;
  /** What a percentage `height` resolves against: an absolutely positioned
   *  box's containing block's height, which is known before the box is laid
   *  out (CSS 2.1 10.5). NaN everywhere else, where that height depends on
   *  the content and a percentage is `auto`. */
  percentHeightBase = NaN;
  /** Whether this box last handed its children a percentage base that
   *  was a number: until it does, they hold NaN already, and the next
   *  pass need not visit them to say so again. */
  gavePercentBase = false;
  /** Whether this box's top margin collapsed through its parent's top edge
   *  and was spent placing the parent (CSS 2.1 8.3.1): its own layout puts
   *  it at the parent's content top, and applies no margin again. `2` when
   *  the box is empty and its bottom margin went the same way, so the next
   *  sibling's may have too; `3` for a new formatting context the margin
   *  stopped above, separated from the floats it carries, which sits where
   *  the margins before it end and applies none of its own. Set by the walk
   *  that places the parent, each pass, and read only while every sibling
   *  before it was a `2`. */
  topAbsorbed: 0 | 1 | 2 | 3 = 0;

  /** Text, for a `text` box: already whitespace-processed and transformed. */
  text = '';
  /** This box's slice of the document text index. */
  textStart = 0;
  textEnd = 0;

  /** Lines, for a box that established an inline formatting context. */
  lines: LineBox[] | null = null;
  /** The widest row of floats its lines placed beside none of them, side
   *  by side: what the box is measured with, as a line's floats are
   *  (`LineBox.floats`). */
  floatRow = 0;

  /** A replaced box's intrinsic size and ratio; null on every other box,
   *  which is nearly all of them, so it is one field rather than four. */
  intrinsic: Intrinsic | null = null;
  /**
   * Cached min-/max-content widths, for a table cell and for a box an
   * intrinsic size (`width: fit-content`) sizes. -1 until measured.
   *
   * Intrinsic widths are width-independent by definition, so measuring them
   * per layout pass was this engine breaking its own phase rule — a resize
   * re-probed every cell twice and cost as much as the first layout. The
   * cache lives on the box because the box's lifetime is exactly the
   * invalidation rule: any DOM or style change rebuilds the tree, and a new
   * box starts unmeasured.
   */
  intrinsicMinContent = -1;
  intrinsicMaxContent = -1;
  /** Which layout of the pass this box last had, counted across all boxes:
   *  what tells a layout kept for reuse (`layoutOwn`) from one a probe has
   *  laid over since. */
  layoutSerial = 0;
  /** What a replaced box is: the resource seam and the control host both
   *  key on this rather than re-reading the tag. */
  replaced: ReplacedKind = 'none';

  /** The marker of a `list-item`, if it generated one. The marker is not a
   *  box: it is not in the flow, nothing can select it (CSS spells that
   *  `::marker`, and no author styles it here), and giving it one would put
   *  a bullet in every copied list. */
  marker: Marker | null = null;
  /** Which of an element's pseudo-elements this box is. Its `el` is null —
   *  it is no element — and its text box's is the element it hangs off, so
   *  a click on a link's generated text or first letter is a click on the
   *  link. A `::backdrop`'s is the sibling before its element's box, and
   *  holds nothing. */
  pseudo:
    | 'before'
    | 'after'
    | 'first-letter'
    | 'backdrop'
    | 'details-content'
    | 'view-transition'
    | null = null;

  /**
   * The bounds of everything this box and its descendants draw, in document
   * coordinates — **ink** bounds, not the border box, because `overflow:
   * visible` lets a child draw outside its parent and a box-rect test would
   * then cull something still on screen. Filled by `computePaintBounds`
   * after layout; the paint pass culls against it.
   */
  boundsX = 0;
  boundsY = 0;
  boundsWidth = 0;
  boundsHeight = 0;

  /**
   * The viewport query over a wide child list, built by `computePaintBounds`
   * past a size threshold: the paintable in-flow children sorted by ink top,
   * with each entry's document-order position and a running maximum of ink
   * bottoms. What it buys is the promise this component makes about tall
   * documents — the cost of a paint is the viewport's, not the document's —
   * because without it every expose walked all N children of a flat
   * document to reject N−20 of them.
   */
  paintIndex: {
    boxes: Box[];
    order: number[];
    prefixBottom: number[];
  } | null = null;
  /** Out-of-flow children in paint order (z-index, then document order),
   *  precomputed so a paint does not filter and sort per box per frame. */
  positionedPaint: Box[] | null = null;
  /** Whether a positioned box is somewhere under this one: what the pass
   *  that gives each stacking context its positioned boxes walks, so that
   *  a subtree with none is not walked at all (`stackLayers`). */
  holdsLayers = false;
  /** The tallest line box under this box — the slack a binary search over
   *  the y-sorted lines needs, since a line's bottom is not monotone. */
  maxLineHeight = 0;

  /**
   * The document range this box's *subtree* covers, in code units. `[0, 0)`
   * for a subtree with no text. Assigned once per build; the selection
   * walks prune on it, which is what keeps "which pixels does this range
   * cover" from touching the ninety-nine paragraphs a selection is not in.
   */
  subtreeTextStart = 0;
  subtreeTextEnd = 0;

  /** Set on a box whose `position` takes it out of flow, so the block pass
   *  can skip it and the positioned pass can find it. */
  outOfFlow = false;
  /** Set on a float, for the same reason. */
  isFloat = false;
  /** Set on a box drawn in its document's top layer (CSS Position 4, 3.1):
   *  an element's whose style says so (`overlay`), and its `::backdrop`'s.
   *  Out of the flow, and nothing around it reaches it — no clip, matrix,
   *  opacity or filter, and no containing block but the viewport's or the
   *  initial one — and painted over everything else, in the order its
   *  element went into the layer (`topLayerBoxes` in `paint.ts`). */
  topLayer = false;
  /** Where an out-of-flow box would have been in the flow it was taken
   *  from — its static position (CSS 2.1 10.3.7, 10.6.4). */
  staticPosition: StaticPosition | null = null;

  /** A table's captions, above and below it: they are in the box's height,
   *  and outside the table's own border and background (CSS 2.1 17.4). */
  captionTop = 0;
  captionBottom = 0;
  /** A table whose borders collapse: the border each segment of its grid
   *  carries, resolved once per build (`collapseTable`). */
  collapsed: CollapsedTable | null = null;
  /** Set on a table whose borders collapse, and on its cells: their border
   *  widths are the halves the collapsing model leaves them, and the table
   *  paints the borders rather than the boxes. */
  bordersCollapsed = false;

  constructor(kind: BoxKind, el: Element | null, style: ComputedStyle) {
    this.kind = kind;
    this.el = el;
    this.style = style;
  }

  append(child: Box): void {
    child.parent = this;
    this.children.push(child);
  }

  /** Content-box left edge, in document coordinates. */
  get contentX(): number {
    return this.x + this.borderLeft + this.padLeft;
  }
  get contentY(): number {
    return this.y + this.borderTop + this.padTop;
  }
  get contentWidth(): number {
    return Math.max(
      0,
      this.width -
        this.borderLeft -
        this.borderRight -
        this.padLeft -
        this.padRight,
    );
  }
  get contentHeight(): number {
    return Math.max(
      0,
      this.height -
        this.borderTop -
        this.borderBottom -
        this.padTop -
        this.padBottom,
    );
  }
  /** Border + padding across, which is what a `border-box` width already
   *  contains and a `content-box` width does not. */
  get horizontalExtra(): number {
    return this.borderLeft + this.borderRight + this.padLeft + this.padRight;
  }
  get verticalExtra(): number {
    return this.borderTop + this.borderBottom + this.padTop + this.padBottom;
  }
}

export type ReplacedKind =
  | 'none'
  | 'image'
  | 'input'
  | 'textarea'
  | 'select'
  | 'button'
  | 'checkbox'
  | 'radio'
  | 'hr'
  /** An `<iframe>`, `<video>`, `<embed>` or `<canvas>`: what it would
   *  show is never loaded or drawn, so it is a box of its size with nothing
   *  in it. */
  | 'frame'
  /** An inline `<svg>`: a drawing, sized by what it says of its size. */
  | 'svg';

/**
 * Where a control sits on the line, as Chrome sets it: a field, a select
 * or an input button on the baseline of the text it shows, its line in its
 * face centred in its content box — that face's ascent and descent — and a
 * checkbox, a radio button or a range on its border box's bottom, its
 * bottom margin under the line. A `<textarea>` is none of these, and sits
 * on its bottom margin edge as a box that scrolls does.
 */
export const CONTROL_BASELINES = new WeakMap<
  Box,
  InlineDecoration | 'border'
>();

function controlBaseline(
  el: Element,
  kind: ReplacedKind,
  style: ComputedStyle,
  options: BuildOptions,
): InlineDecoration | 'border' | null {
  if (kind === 'checkbox' || kind === 'radio') return 'border';
  if (kind === 'input' && (attr(el, 'type') ?? '').toLowerCase() === 'range') {
    return 'border';
  }
  if (kind !== 'input' && kind !== 'select' && kind !== 'button') return null;
  // a list box shows rows, and sits on its bottom edge
  if (kind === 'select' && Number(attr(el, 'size') ?? 1) > 1) return null;
  return (
    options.faceExtent?.(style) ?? {
      ascent: style.fontSize * 0.8,
      descent: style.fontSize * 0.2,
    }
  );
}

/** A replaced box's intrinsic dimensions, in device pixels. */
export interface Intrinsic {
  /** Its size — or, on an axis `missing` names, the default object size of
   *  300 by 150 CSS pixels that CSS falls back to there (CSS 2.1 10.3.2,
   *  10.6.2). */
  width: number;
  height: number;
  /** The dimensions it lacks: 1 its width, 2 its height. Only an SVG can. */
  missing: number;
  /** Its ratio, width over height, or 0 where it has none: an image's, or
   *  an SVG's from its size or its `viewBox`. */
  ratio: number;
}

/** The `::first-line` style of each block container a rule gives one to,
 *  kept beside the boxes: few documents have any (`BoxTree.firstLine`). */
export const FIRST_LINE = new WeakMap<Box, ComputedStyle>();

/**
 * A box's style on the first line of the block it is in, given its
 * parent's style there (CSS Pseudo 4, 2.1.2): an element's own rules over
 * what it inherits on the line, which takes the properties `::first-line`
 * applies to from `parent` and the rest from its parent's own style.
 */
export type FirstLineStyler = (
  box: Box,
  parent: ComputedStyle,
) => ComputedStyle;

/** The `::selection` of the element a box's text is in, or null for the
 *  palette's highlight (`Cascade.selectionStyle`). */
export type SelectionStyler = (box: Box | null) => SelectionStyle | null;

/** The url of an image generated content put in a pseudo-element: it has
 *  no element of its own to name it (`imageUrlOf`). */
export const CONTENT_IMAGES = new WeakMap<Box, string>();

/** How far `position: relative` moved an inline box (`offsetInline`), how
 *  far each text on a line moved with the boxes it is in, and the lines
 *  holding one: beside the boxes and the lines, since few documents move an
 *  inline box. A moved text's `drawX` and `drawY` are where it is drawn;
 *  its box's decorations are worked out from where it was, and moved by
 *  their own box's offset. */
export const INLINE_OFFSETS = new WeakMap<Box, { x: number; y: number }>();
export const TEXT_SHIFTS = new WeakMap<LineText, { x: number; y: number }>();
export const SHIFTED_LINES = new WeakSet<LineBox>();

/** Of a block's lines, by the array they are, those `position: relative`
 *  or a translation moved something off — a text in a moved inline box, or
 *  an inline-block or an image on it — which is drawn where it went while
 *  the line stays where it was: what the paint's cull of a block's lines
 *  has to look at past the lines the damage meets (`paintLines`). By the
 *  array, so that a layout that makes new lines leaves none of the old. */
export const MOVED_OFF_LINES = new WeakMap<LineBox[], Set<LineBox>>();

/** How far `vertical-align` raised a text above its line's baseline, and an
 *  inline box's own baseline, where it did: beside the lines and the boxes
 *  for the reason the offsets above are. A line holding a raised text is
 *  among `SHIFTED_LINES` too, as its text is off the line's baseline. */
export const TEXT_RAISES = new WeakMap<LineText, number>();

/** The blocks some of whose text casts a shadow (`text-shadow`), and each
 *  list of shadows it casts: the paint pass looks for them in these blocks
 *  and in no other, and their ink reaches as far past the text as the
 *  shadows fall (`computePaintBounds`). */
export const SHADOWED_TEXT = new WeakMap<Box, readonly BoxShadow[][]>();
export const BOX_RAISES = new WeakMap<Box, number>();

/** And the raise, on one line, of each inline box a `top` or `bottom` box
 *  holds, the box itself among them: that box's baseline is where the
 *  line's edge puts it, which is a different height on every line, so its
 *  background, drawn from its baseline, is put there by line. */
export const LINE_BOX_RAISES = new WeakMap<LineBox, Map<Box, number>>();

/** The face of an inline box with padding above or below its text and
 *  nothing to paint behind it, which has no `decoration`: its fragments
 *  still reach past its lines by the padding, and count in the scrollable
 *  overflow of the block they are in (`computePaintBounds`). */
export const PADDED_FACES = new WeakMap<Box, InlineDecoration>();

/** The table cells wholly in columns `visibility: collapse` took out of
 *  their table (CSS 2.1 17.5.5), which the paint pass leaves out: a cell is
 *  no descendant of its column and inherits nothing from it, so its own
 *  style still says `visible`. */
export const COLLAPSED_CELLS = new WeakSet<Box>();
/** And the cells spanning into a column or a row taken out: laid out as
 *  they would have been, placed over what is left of their span, and
 *  clipped to it. */
export const CLIPPED_CELLS = new WeakSet<Box>();

/** The boxes after a line-clamp container's clamp point (CSS Overflow 4,
 *  5.3.1): invisible, with all they hold, and no taller than nothing to
 *  the blocks around them. Marked by the layout of the flow they are in,
 *  which leaves them where the last layout put them, and passed over by
 *  paint and the paint bounds. */
export const CLAMPED = new WeakSet<Box>();

/** A grid's tracks as its layout left them, each column's and each row's
 *  start and end from the content box's corner, with the lines of each
 *  axis by number and by name: what an absolutely positioned box's grid
 *  area is found in (CSS Grid 1, 9.1). And the first of its items in
 *  row-major order, where they were placed and not where they were
 *  written, which the grid's own baseline is taken from (10.6): null for a
 *  grid with no item. */
export interface GridTracks {
  cols: [number, number][];
  rows: [number, number][];
  colLines: GridLines;
  rowLines: GridLines;
  first: Box | null;
  /** The tracks that stay — `cols` and `rows` without those an `auto-fit`
   *  collapsed — and each item's area in them, as its first column, how
   *  many, its first row and how many: what a gap's rules are drawn along
   *  and broken by (CSS Gap Decorations 1). */
  lanes: {
    cols: [number, number][];
    rows: [number, number][];
    areas: [number, number, number, number][];
    /** The item each area is, which `grid-rows` and `grid-columns` read in
     *  the order their areas are (`inReadingOrder`). */
    items: Box[];
  };
}
export const GRID_TRACKS = new WeakMap<Box, GridTracks>();

/** A multicol container's rows of column boxes as its layout left them
 *  (CSS Multi-column 1, 3): one row, or one between each two boxes that
 *  span the columns, each its top and height from the content box's top
 *  and the left of each column that holds something from its left, with
 *  their width — where the rules between them are drawn. */
export interface ColumnRow {
  top: number;
  height: number;
  lefts: number[];
  width: number;
}
export const COLUMN_BOXES = new WeakMap<Box, ColumnRow[]>();

/** A flex or grid box's children in the order it lays them out and paints
 *  them, `order` first and the document's after it (CSS Flexbox 5.4, CSS
 *  Grid 1 6.3), where `order` moves any: an absolutely positioned child's
 *  is 0. */
export const PAINT_ORDER = new WeakMap<Box, Box[]>();

/**
 * Put a flex or grid box's items in order-modified document order — by
 * `order`, and in the document's where two have the same (CSS Flexbox 5.4)
 * — which flex lays them out in and grid places them in (CSS Grid 1, 7.7
 * and 8.5), and keep its children in it for paint and the hit test, as a
 * flex item and a grid item are painted (CSS Flexbox 5.4, CSS Grid 1
 * 6.5).
 */
export function inOrder(box: Box, items: Box[]): void {
  if (items.every((item) => item.style.order === 0)) {
    PAINT_ORDER.delete(box);
    return;
  }
  items.sort((a, b) => a.style.order - b.style.order);
  PAINT_ORDER.set(
    box,
    [...box.children].sort((a, b) => orderOf(a) - orderOf(b)),
  );
}

/** A child's `order`, which an absolutely positioned one takes as 0 when
 *  it is painted among the items. */
function orderOf(box: Box): number {
  return box.outOfFlow || box.kind === 'text' ? 0 : box.style.order;
}

/** The blocks that broke an inline box in pieces, under its first piece
 *  (`breakAround`): a relative offset of the box moves them too (CSS 2.1
 *  9.2.1.1), though they stand outside it, and its rect takes them in, as
 *  a browser's does (`elementRect`). */
export const CUT_BLOCKS = new WeakMap<Box, Box[]>();

/** Where a block that clearance moved below the floats would have stood
 *  without it, its border edge's top (CSS 2.1 9.5.2): a browser's
 *  fragment of an inline box around such a block starts there, and takes
 *  the clearance in (`elementRect`). Only the blocks that had clearance. */
export const CLEARED_FROM = new WeakMap<Box, number>();

/**
 * One piece of a block that a column break falls inside (CSS Multi-column
 * 1): its border box in one column, as far as the box goes in it, and where
 * the whole box would stand there — the box its background and its borders
 * are drawn as, cut to the piece (`box-decoration-break: slice`).
 */
export interface ColumnPiece {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The top of the whole box, in this column, and its height. */
  wholeY: number;
  wholeHeight: number;
}

/** The pieces of each block a column break falls inside, in the order of
 *  the columns. The block's own rect is what takes them all in, as a
 *  browser's bounding rect of it is. */
export const COLUMN_PIECES = new WeakMap<Box, ColumnPiece[]>();

/** The lines of a box that columns took apart: they are not one under
 *  another, and a search that counts on their tops rising reads them all
 *  instead. */
export const COLUMN_LINES = new WeakSet<LineBox[]>();

/**
 * The rows of a text's layout that are in the text's own column, from the
 * layout's origin, where the layout's lines went to more than one: a layout
 * is drawn whole, so it is drawn once for each column, there, and clipped
 * to the rows that are that column's. One object for all the texts of a
 * layout in a column, which is what tells a draw of it from another.
 */
export const COLUMN_ROWS = new WeakMap<
  LineText,
  { top: number; bottom: number }
>();

/** Whether any layout has broken a box between columns: what the walks
 *  that would ask the three maps above of every box ask first. */
export const columned = { any: false };

/** What the document's rules give the elements inside an inline `<svg>`
 *  (`Cascade.shapeStyles`), null where they give none. */
export type ShapeStyler = (box: Box) => ShapeStyles | null;

/** What `BoxTree.shapeStyler` answered for each drawing's box it has been
 *  asked of, which are the ones painted: a box restyled where it is has
 *  its answer put here again (`HtmlViewNode._hoverInPlace`). */
export const SHAPE_STYLES = new WeakMap<Box, ShapeStyles | null>();

/** The device pixels a user unit of an inline drawing's is, by its box: the
 *  document's scale and the box's zoom, as it was built. What it paints
 *  past its box is worked out from it (`SvgDrawing.reach`). */
export const DRAWING_SCALE = new WeakMap<Box, number>();

/** The element a pseudo-element's box is generated from, which has no
 *  element of its own (`Box.pseudo`): whose the images its styles name are,
 *  when the host is asked for them. */
export const GENERATED_FROM = new WeakMap<Box, Element>();

/** The elements a build has given a `::before` or an `::after`, whatever
 *  anonymous box the fix-up put it in, or a `display: contents` left it
 *  with no box of its element's to be found under. */
export const GENERATED_ON = new WeakSet<Element>();

/** What came before a block among its parent's children (`ranBefore`). */
const RAN_INLINE = 1;
const RAN_OUT = 2;

/**
 * For a box whose children the fix-up wrapped (`fixUpOwn`), where it holds
 * blocks and inline-level content both: the first block in the flow among
 * them with inline-level content before it, as they were built — white
 * space the wrap then dropped among it — and the first with a float or a
 * box out of the flow before it, which is wrapped where anything is. What a
 * tail after a block is fixed up as coming after (`ranBefore`); each holds
 * for every block after it, since what came before only grows. A box the
 * fix-up did not wrap has no entry, and its children are as they were
 * built, none of them inline-level where one is a block. Noted in the
 * wrap's own loop, and not on every box or in the loop every box's
 * children go through: two fields more on a box were a fiftieth of a
 * document's first paint. Noted in every build, a stream's chunk's or
 * not: a script's child put in or taken out builds a tail too
 * (`ChangeScope.ends`), and where a build of a document handed over whole
 * had noted nothing, Apple's pages, which put their dialogs at the end of
 * a `<body>` with a wrap in it, built the whole page for each.
 */
const RAN_FROM = new WeakMap<Box, RanFrom>();

interface RanFrom {
  inline: Box | null;
  out: Box | null;
}

/** What the fix-up saw before `block` among `holder`'s children, as
 *  `RAN_INLINE` and `RAN_OUT`; -1 where `block`, or a box `RAN_FROM` names,
 *  is no longer among them. */
function ranBefore(block: Box, holder: Box): number {
  const kids = holder.children;
  const at = kids.indexOf(block);
  if (at < 0) return -1;
  const from = RAN_FROM.get(holder);
  if (!from) {
    for (let i = 0; i < at; i += 1) {
      const kid = kids[i];
      if (kid.outOfFlow || kid.isFloat) return RAN_OUT;
    }
    return 0;
  }
  let bits = 0;
  for (const [first, bit] of [
    [from.inline, RAN_INLINE],
    [from.out, RAN_OUT],
  ] as const) {
    if (!first) continue;
    const index = kids.indexOf(first);
    if (index < 0) return -1;
    if (index <= at) bits |= bit;
  }
  return bits;
}

/**
 * Where the document's text had got to once the builder had built `box`'s
 * element and ended its line (`_endLine`): what a tail after a block starts
 * from, and where the text of all a holder holds ends (`tailRoot`). The end
 * of the last text the tree's ranges say is at or before the end of the box
 * (`assignSubtreeRanges`, `textBefore`), and past it what the fix-up took
 * out of the box right there — a grid's white space, a run's start under
 * `white-space: pre` — which is the document's text where the builder
 * pushed it, and in no box's range: a dropped text keeps its parent, and
 * the list of text boxes keeps it (`subtreeRoot` reads it so too). -1 where
 * such a text is not the box's and it holds none of its own, which says
 * nothing of whether the text is before it or after. Worked out, where a
 * tail needs it, and not noted as each box is built: on every box, two
 * fields more were a fiftieth of a document's first paint, and in a map a
 * fiftieth of every build of it.
 */
function textAfterBox(box: Box, textBoxes: readonly Box[]): number {
  const own = box.subtreeTextEnd > box.subtreeTextStart;
  let end = own ? box.subtreeTextEnd : textBefore(box);
  if (end === null) return -1;
  for (let k = textBoxAt(textBoxes, end); k < textBoxes.length; k += 1) {
    const next = textBoxes[k];
    if (next.textStart !== end) break;
    if (next.textEnd === next.textStart) continue;
    // the next text the tree holds comes after the box
    if (inTree(next)) break;
    let held = false;
    for (let at = next.parent; at && !held; at = at.parent) held = at === box;
    if (!held) return own ? end : -1;
    end = next.textEnd;
  }
  return end;
}

/**
 * What a view transition's tree is built from (CSS View Transitions 1,
 * 3.4): the style of its root, and for each name a group, an image pair
 * and an old and a new image — an image's style and the size of the
 * element it shows, its natural size; null for one the transition has
 * not got, or that is not displayed.
 */
export interface TransitionTree {
  style: ComputedStyle;
  groups: {
    name: string;
    group: ComputedStyle;
    pair: ComputedStyle;
    old: TransitionImageBox | null;
    new: TransitionImageBox | null;
  }[];
}

export interface TransitionImageBox {
  style: ComputedStyle;
  width: number;
  height: number;
}

/** Each box of a view transition's tree, by the pseudo-element it is as
 *  its styles are keyed: `view-transition`, `view-transition-group(a)`… */
export const TRANSITION_KEYS = new WeakMap<Box, string>();

/** The style a box of a view transition's tree has, where the box is laid
 *  out by another: `::view-transition`, absolute against the snapshot
 *  containing block, which is the viewport's, and so laid out fixed. */
export const TRANSITION_STYLES = new WeakMap<Box, ComputedStyle>();

/** The box of a view transition's old or new image, by what it shows. */
export const TRANSITION_IMAGES = new WeakMap<
  Box,
  { name: string; which: 'old' | 'new' }
>();

/** The blocks that broke an inline box under full opacity in pieces, and
 *  the opacity they take from it — from each such inline box around them,
 *  multiplied. They stand outside it (CSS 2.1 9.2.1.1) and are still its
 *  content, which its opacity fades as a group: a green square in a
 *  `<span style="opacity: .5">` was drawn at full strength. */
export const FADED_BLOCKS = new WeakMap<Box, number>();

/**
 * How much the inline boxes from `box` out to their block fade what is in
 * them, their opacities multiplied: 1 where none is under full opacity, as
 * nearly none is. What an inline box holds is drawn on its block's lines —
 * its text, its background and borders, the inline-blocks and images on
 * them — and not in its own paint, which no group of its could hold, so
 * each of those is drawn faded by the boxes around it. In the styles
 * `styles` has for the boxes it names: a restyle's, before it is made.
 */
export function inlineFade(
  box: Box | null,
  styles?: ReadonlyMap<Box, ComputedStyle>,
): number {
  if (box?.kind !== 'inline') return 1;
  // the outermost first, as the layout multiplies them going in
  // (`collect`): a product taken in another order may differ in its last
  // bit, and the colour rounded from it with it, which a run's colour is
  // compared by
  return (
    inlineFade(box.parent, styles) * (styles?.get(box) ?? box.style).opacity
  );
}

/** How much the inline boxes around a run of text fade it (`inlineFade`),
 *  where `box` is whose the run is: the ones a text box is in, or a bidi
 *  control's own, which an inline box's text is wrapped in — and none for
 *  a block's, which is no inline box's content but its own. */
export function textFade(
  box: Box,
  styles?: ReadonlyMap<Box, ComputedStyle>,
): number {
  return inlineFade(
    box.kind === 'text' || box.kind === 'break' ? box.parent : box,
    styles,
  );
}

/** What the builder produced, plus the document-wide text it indexed. */
/** The first box of each element that is a size container, in a tree as
 *  it was built. */
export function containerBoxes(root: Box): Map<Element, Box> {
  const out = new Map<Element, Box>();
  const stack: Box[] = [root];
  while (stack.length) {
    const box = stack.pop()!;
    if (
      box.el &&
      (box.style.containerType !== 'normal' ||
        box.style.scrollStateContainer ||
        box.style.anchoredContainer) &&
      box.pseudo === null &&
      !out.has(box.el)
    ) {
      out.set(box.el, box);
    }
    for (let i = box.children.length - 1; i >= 0; i -= 1) {
      stack.push(box.children[i]);
    }
  }
  return out;
}

/** A text node of the document, and the code units of the document's text
 *  it came to: `[start, end)`. */
export interface TextSource {
  node: Text;
  start: number;
  end: number;
}

export interface BoxTree {
  root: Box;
  /** The document's text as it will be drawn, which is what `textContent()`
   *  answers and what a copy puts on the clipboard. */
  text: string;
  /** Text boxes in document order — the selection binary-searches this. */
  textBoxes: Box[];
  /** Each of the document's text nodes that came to text, in document
   *  order, with the code units of the document text it came to: what a
   *  point in the DOM is found in the text by, and a place in the text in
   *  the DOM (`dom-text.ts`) — a page's selection and its ranges' rects. */
  textNodes?: TextSource[];
  /** The text no selection takes, where `user-select` is `none` — generated
   *  content's, unless a rule says otherwise: sorted, disjoint `[start,
   *  end)` pairs of code units, flat. Empty in most documents. */
  unselectable: readonly number[];
  /** The styles text is set in, each once: the faces a host warms before
   *  laying the text out, found here rather than by walking `textBoxes`
   *  again after every build. */
  textStyles: Set<ComputedStyle>;
  /** Each element the build gave a style, with it and whether its parent
   *  was a flex container: what a pointer move restyles an element from
   *  where it did not change the rest (`HtmlViewNode._hoverInPlace`). */
  styles: Map<Element, { style: ComputedStyle; inFlex: boolean }>;
  /** Each size container's box (`container-type`), where some style read
   *  one's size: what a layout measures the containers by
   *  (`HtmlViewNode._containersMoved`). Taken as the tree is built, since a
   *  layout may set boxes aside from the root's walk. */
  containers?: Map<Element, Box>;
  /** Every replaced box that needs a real widget, in document order. */
  controls: Box[];
  /** Every `<video>`'s box, in document order: what a player may be
   *  mounted over (`media.ts`). */
  media: Box[];
  /** Every `<iframe>`'s, `<canvas>`'s and `<embed>`'s box, in document
   *  order: what a host may mount its own content over (`renderEmbedded`,
   *  `media.ts`). */
  embedded: Box[];
  /** Every box carrying an `href`, for click and hover. */
  links: Box[];
  /** Every box of an element whose markup makes it focusable — a link, a
   *  control, a summary, a `tabindex` — in document order, controls
   *  included: the order Tab goes through it in (`focus.ts`). */
  focusables: Box[];
  /** The style of an anonymous box under a parent's (`anonymousStyles`):
   *  the one the fix-up gave each it made, and what such a box takes when
   *  its parent's style changes where it is (`HtmlViewNode._hoverInPlace`). */
  anonymous: AnonymousStyle;
  /** Every box with a `background-image`, a border image or a mask image,
   *  an element's or a pseudo-element's, for the host to be asked for: a
   *  document has a handful, and finding them was a walk over every box
   *  after every build. */
  backgrounds: Box[];
  /** Every image generated content names, the element whose
   *  pseudo-element names it, for the host to be asked for, and whether its
   *  size was known when the box was built. */
  contentImages: { url: string; element: Element; sized: boolean }[];
  /** Every `<img>` box built before its image's size was known — at the
   *  size its element's attributes say, or the image it showed before —
   *  and what an image arriving is checked against, since one that sizes
   *  nothing anew changes no box (`HtmlViewNode._imageArrived`). One its
   *  header sized while its pixels decode waits for none. */
  awaiting: Box[];
  /** Every image's box, in document order, laid out or set aside: what an
   *  image that shows another source takes its size into
   *  (`HtmlViewNode._showInPlace`). */
  images: Box[];
  /** Every element whose box is another kind once its image is in — an
   *  `<object>`, an `<embed>`, a `<video>`'s poster, an image button —
   *  built before it was. */
  awaitingKind: Element[];
  /** Whether any box is relatively positioned: where none is, layout skips
   *  the walk that moves them. */
  relative: boolean;
  /** Whether any box is turned out of the plane (`outOfPlane`): where none
   *  is, no layer is offered for one (`HtmlViewNode.sprites`), and nothing
   *  looks. A restyle in place that turns one sets it too. */
  tilted: boolean;
  /** Whether any box is the root of a flow in a vertical writing mode,
   *  turned on its side in a frame of its own (`layout/writing.ts`): where
   *  none is, nothing in the layout or the paint asks a box whether it is
   *  one. */
  vertical: boolean;
  /** Whether any box has a `reading-flow`: where none has, Tab goes in the
   *  document's order and nothing asks the boxes (`inReadingOrder`). */
  readingFlow: boolean;
  /** Whether any box has an `anchor-name`: where none has, no positioned
   *  box looks for an anchor (`layoutPositioned`). */
  anchors: boolean;
  /** Whether any positioned box has a negative `z-index`: where none has,
   *  paint has no layer below the flow to find. */
  negative: boolean;
  /** Whether any block has a `::first-line` style (`FIRST_LINE`): where
   *  none has, layout looks for none. */
  firstLine: boolean;
  /** Each box's style on a first line (`FirstLineStyler`), where any
   *  block has a `::first-line`. */
  firstLineStyler: FirstLineStyler | null;
  /** Each box's `::selection` (`SelectionStyler`), where any rule styles
   *  one: worked out as a selection is first painted over it, not as the
   *  tree is built, since most builds are never selected in. */
  selectionStyler: SelectionStyler | null;
  /** Each custom highlight's `::highlight()` styler, by its name, as
   *  `selectionStyler` is the selection's: null where no rule styles any
   *  (`Cascade.highlightStyle`). */
  highlightStyler: ((name: string) => SelectionStyler) | null;
  /** What the rules give the elements in each inline `<svg>`
   *  (`ShapeStyler`), which have no boxes and no styles, and what the
   *  `var()`s in their attributes come to: worked out as a drawing is
   *  first painted, since a page of icons shows few of them at once. */
  shapeStyler: ShapeStyler | null;
  /** What the drawings of this build share in `Cascade.shapeStyles`: the
   *  document's elements by their ids, indexed when first asked, where a
   *  `<use>` finds the icon a sprite has for it; and what the rules matched
   *  in each copy a `<use>` makes. Null where `shapeStyler` is. */
  shapeCopies: ShapeCopies | null;
  /** What a `rem` and a `vw` in a drawing's geometry are of, as the
   *  document has them when it is painted (`Cascade.drawingUnits`). */
  drawingUnits: () => DrawingUnits;
  /** The HTML each inline `<svg>`'s `<foreignObject>`s hold, by the
   *  object (`ForeignObject`): absent where the document has none, which
   *  is what every walk over them asks first. */
  foreign?: Map<Element, ForeignObject>;
  /** Whether a float or an out-of-flow box sits in an inline box: where
   *  none does, layout looks for them among a block's own children and
   *  goes through no inline box to find them. */
  nestedOutOfLine: boolean;
  /** Whether `position: relative` moves an inline box or `vertical-align`
   *  raises one: where none does, no text is off its line's baseline, and
   *  the bounds walk looks for none. */
  movedInline: boolean;
  /** Whether any box paints its background through its text
   *  (`background-clip: text`): where none does, no paragraph looks. */
  clipText: boolean;
  /** Whether a counter counts down from what its scope adds up to
   *  (`reversed()`), which every item before the scope's end reads: where
   *  one does, no subtree is built apart that counts (`buildSubtrees`). */
  reversed?: boolean;
  /** The style of the `<html>` a document with neither an `<html>` nor a
   *  `<body>` implies around the body the root box stands in for
   *  (`Cascade.rootStyle`), whose background is the canvas's; null where
   *  the document has either. */
  impliedHtml: ComputedStyle | null;
  /** Whether the root box stands in for the `<html>` a document with a
   *  `<body>` and no `<html>` implies around it (`Cascade.rootStyle`): it
   *  is the root element then, as well as the initial containing block. */
  impliedRoot: boolean;
  /** The scheme the palette is, which the element the document is drawn
   *  in is of: where the root element's is the other, the canvas is that
   *  scheme's and opaque (`paintDocument`). */
  paletteScheme: 'light' | 'dark';
  /** The `overflow` the root element, or the `<body>`, gave the viewport
   *  (`propagateOverflow`): what the host that scrolls the document is
   *  told it asks of it. */
  viewportOverflow: ViewportOverflow;
}

/**
 * The HTML a `<foreignObject>` in an inline `<svg>` holds (SVG 2, 23.2): a
 * tree of boxes of its own, the object its root and its initial containing
 * block, styled by the document's cascade from the drawing's elements down,
 * laid out as a document is at the object's size (`layoutDocument`) and
 * painted by the drawing where it reaches the object in its order, in the
 * object's user space (`ForeignPainter`). Out of the document's tree: no
 * walk of the document's boxes reaches it, and its text is no part of the
 * document's.
 */
export interface ForeignObject {
  /** The drawing's box, which the object's user units are of. */
  svg: Box;
  el: Element;
  tree: BoxTree;
  /** Whether what it holds is cut to its rectangle: the UA sheet's
   *  `overflow: hidden`, unless a rule says `visible`. */
  clips: boolean;
  /** Device pixels a user unit was last laid out at, and its size in
   *  device pixels then; 0 by 0 where it is none, or not laid out yet. */
  scale: number;
  width: number;
  height: number;
}

export interface BuildOptions {
  cascade: Cascade;
  /** A view transition's tree, where one is under way: what hangs off the
   *  root element in the top layer (`TransitionTree`). */
  transition?:
    ((root: Element, rootStyle: ComputedStyle) => TransitionTree | null) | null;
  /** The styles of the tree this one replaces, where only some elements'
   *  can have changed since (`Cascade.beginSharing`). */
  kept?: KeptStyles | null;
  /** Device pixels per CSS pixel. An image's pixels and a `width="600"`
   *  attribute are CSS pixels; every box is device, so both are multiplied
   *  on the way in. Default 1. */
  scale?: number;
  /** Intrinsic size for an image the host has already loaded, in the
   *  image's own pixels — or whose header has said it, while its pixels
   *  decode. `null` when neither: the box takes the attribute size, or a
   *  placeholder. */
  imageSize(el: Element): IntrinsicSize | null;
  /** Whether what an `<object>` or an `<embed>` names is a document, which
   *  it shows as a frame, rather than its fallback content. */
  holdsDocument?(el: Element): boolean;
  /** Whether the size an element's box takes is still to come, whatever
   *  it shows meanwhile — the one it chose before, where that is in: the
   *  box it is built with waits for it (`BoxTree.awaiting`). Not whether
   *  its pixels are: `imageSize` may answer from an image's header while
   *  they decode, and such a box waits for nothing. */
  sizePending?(el: Element): boolean;
  /** The same for an image named by url — generated content's. */
  urlSize?(url: string): IntrinsicSize | null;
  /** How far a style's first face reaches above its baseline, in device
   *  pixels: what a list marker's image with no size of its own is sized
   *  by (`_markerImageSize`). Where it is not known, 0.8em. */
  faceAscent?(style: ComputedStyle): number | undefined;
  /** How far a style's first face reaches above and below its baseline,
   *  in device pixels: where a control sets its text, which is where its
   *  baseline is (`CONTROL_BASELINES`). */
  faceExtent?(style: ComputedStyle): InlineDecoration | undefined;
  /** The size a real widget wants, so the box in the flow is the size the
   *  control will be drawn at. */
  controlSize(
    el: Element,
    kind: ReplacedKind,
    style: ComputedStyle,
  ): {
    width: number;
    height: number;
  };
}

/** Build the box tree for a document. */
export function buildBoxes(
  root: Element | { children: unknown },
  options: BuildOptions,
): BoxTree {
  const builder = new Builder(options);
  return builder.run(root as Element);
}

/** What a build of one subtree made (`Builder.runSubtree`, `runTail`): its
 *  boxes, its text numbered from 0, and its part of each of the tree's
 *  lists. */
interface SubtreeBuild {
  /** The root's box, or the boxes of what a tail holds, in order. */
  boxes: Box[];
  /** For a tail, the first of its blocks that what came before makes each
   *  of `RAN_FROM`'s, before it or in it, and whether it holds inline-level
   *  content, which wraps what its holder holds. */
  ranFrom?: RanFrom & { wraps: boolean };
  text: string;
  textBoxes: Box[];
  unselectable: number[];
  textNodes: TextSource[];
  textStyles: Set<ComputedStyle>;
  styles: Map<Element, { style: ComputedStyle; inFlex: boolean }>;
  controls: Box[];
  media: Box[];
  embedded: Box[];
  links: Box[];
  focusables: Box[];
  backgrounds: Box[];
  contentImages: { url: string; element: Element; sized: boolean }[];
  awaiting: Box[];
  images: Box[];
  awaitingKind: Element[];
  /** How many list items it counted, none of whose markers is a number. */
  listItems: number;
  /** Whether it did anything else to a counter, or read one, or a quote's
   *  depth (`Builder._counts`). */
  counts: boolean;
  /** Whether a counter counts down in it (`BoxTree.reversed`). */
  reversed: boolean;
  flags: Pick<
    BoxTree,
    | 'relative'
    | 'tilted'
    | 'readingFlow'
    | 'anchors'
    | 'negative'
    | 'nestedOutOfLine'
    | 'movedInline'
    | 'clipText'
  >;
}

/**
 * One root of a subtree build, before it is built: an element whose boxes
 * are built again (`subtreeRoot`), or the end of what an element — or the
 * document — holds, from a child on (`tailRoot`); the run of its parent's
 * children its old boxes are; and the part of the document's text they
 * had.
 */
interface SubtreeRoot {
  /** The root's element, or the element whose children a tail is of: null
   *  for the document's own. */
  el: Element | null;
  /** For a tail: what holds it, the first of its children it builds, and
   *  those children. */
  tail: {
    node: ParentNode;
    from: number;
    nodes: Set<ChildNode>;
    /** What came before it among its holder's children (`ranBefore`),
     *  and whether that is wrapped where it is floats and boxes out of the
     *  flow alone. */
    ran: number;
    wrapped: boolean;
  } | null;
  /** The first node of the document it builds, in the document's order. */
  first: ChildNode;
  /** The root's old box, or the box of what holds a tail, which stays. */
  box: Box;
  /** The box whose children the new boxes go in, and the run of them the
   *  old ones are. */
  parent: Box;
  index: number;
  count: number;
  depth: number;
  start: number;
  end: number;
  /** Every box of the old subtree, for the lists to drop theirs. */
  boxes: Set<Box>;
  /** How many list items it held, none numbered (`counts`). */
  listItems: number;
  /** Whether a box of it changed a counter or read one, or a quote, beyond
   *  those list items (`counts`). */
  counts: boolean;
}

/** What a change reaches, as a subtree build takes it (`buildSubtrees`). */
export interface SubtreeRoots {
  /** The elements whose subtrees are built again, none in another. */
  roots: Element[];
  /** The ends of what elements hold, or the document, built again from a
   *  child on — the one after a block-level box of their own that stays,
   *  whose line it ended (`tailRoot`) — none in a root or another tail. */
  tails: { node: ParentNode; from: number }[];
  /** Elements with no box, new or `display: none` before, styled where
   *  they are: a build of only these finds them `display: none` again, or
   *  is no subtree build. */
  hidden: Element[];
  /** Elements out of the document, whose styles go. */
  gone: Element[];
  /** Where roots or tails came out as no subtree of their own, the
   *  elements a build around them would start from — a root's parent, a
   *  tail's holder — set by `buildSubtrees` as it gives up: a caption a
   *  class makes absolute is a box its parent's flow places otherwise
   *  (`HtmlViewNode._subtreeBuild`). All of them, so that a gallery whose
   *  every caption moved is built again once from around them. */
  wider?: Element[];
  /** Whether all that changed is what a stream's chunks put in, which
   *  moves and takes away nothing (`HtmlViewNode._buildParsed`). */
  appendOnly?: boolean;
}

/**
 * The tree `tree` becomes where only the subtrees of `roots` and the ends of
 * what `tails` hold can differ: the boxes of each built again
 * (`Builder.runSubtree`, `runTail`) and put where its old boxes were, and
 * every other box the tree's own, kept with all that its layouts learnt —
 * with the document's text, every box's place in it and the tree's lists
 * made to say what a build of the whole document says. A new `BoxTree`, so
 * that what is kept by the tree is not kept for it, with the new boxes
 * beside, and the box of what holds each tail: their ancestors are the
 * caller's to make forget their sizes (`forgetSizes`). Null where a root's
 * subtree cannot be built apart from what is around it
 * (`prd-subtree-build.md`), and the whole document is to be built.
 */
export function buildSubtrees(
  tree: BoxTree,
  document: { children: unknown },
  found: SubtreeRoots,
  options: BuildOptions,
  firstBoxes: ReadonlyMap<Element, Box>,
): SubtreesBuilt | null {
  const { roots, tails, hidden, gone } = found;
  const cascade = options.cascade;
  if (
    tree.foreign ||
    tree.vertical ||
    tree.firstLine ||
    cascade.hasFirstLine ||
    options.transition
  ) {
    return null;
  }
  const olds: SubtreeRoot[] = [];
  for (const el of roots) {
    const old = subtreeRoot(el, firstBoxes);
    if (!old) return null;
    olds.push(old);
  }
  holdDroppedText(olds, tree.textBoxes);
  for (const old of olds) {
    if (old.end >= old.start) continue;
    const at = textBefore(old.box);
    if (at === null) return null;
    old.start = old.end = pastDropped(
      at,
      old.el!,
      tree.textBoxes,
      tree.textNodes ?? [],
    );
  }
  for (const { node, from } of tails) {
    const old = tailRoot(node, from, tree, document, firstBoxes);
    if (!old) return null;
    olds.push(old);
  }
  // a root a block around looks for a first letter in, or a tail of one
  if (cascade.hasFirstLetter) {
    for (const old of olds) {
      const from = old.tail ? old.el : old.el && flatParentOf(old.el);
      if (lookedForLetter(from, tree, cascade)) return null;
    }
  }
  // in the document's order, which their text is in: two at one place are
  // in the order of their nodes, the one with no text first
  olds.sort(
    (a, b) =>
      a.start - b.start ||
      (a.first === b.first ? 0 : precedes(a.first, b.first) ? -1 : 1),
  );
  for (let i = 1; i < olds.length; i += 1) {
    if (olds[i].start < olds[i - 1].end) return null;
  }
  // and none in another's boxes
  const ofRoot = new Map<Box, SubtreeRoot>();
  for (const o of olds) for (const box of o.boxes) ofRoot.set(box, o);
  for (const o of olds) {
    const inBox = ofRoot.get(o.box);
    const inParent = ofRoot.get(o.parent);
    if ((inBox && inBox !== o) || (inParent && inParent !== o)) return null;
  }
  const copies = new ShapeCopies(idIndex(document as Element));
  if (!olds.length && !hidden.length) {
    // nothing drawn changed: the tree as it is, its stylers over the
    // cascade the build is for, which sheets that added rules made again —
    // and the styles of what went with none
    const styles = gone.length ? new Map(tree.styles) : tree.styles;
    for (const el of gone) styles.delete(el);
    const stylers = new Builder(options, copies).stylersFor(
      styles,
      false,
      copies,
    );
    return {
      tree: { ...tree, ...stylers, styles },
      made: [],
      replaced: [],
      added: [],
    };
  }
  const built: SubtreeBuild[] = [];
  const fresh = new Map<Element, { style: ComputedStyle; inFlex: boolean }>();
  /** The boxless elements' styles (`SubtreeRoots.hidden`). */
  const unboxed = new Map<Element, { style: ComputedStyle; inFlex: boolean }>();
  /** The first root that counts, or whose list items are another number,
   *  from which nothing kept may read a counter (`boxesAfter`). */
  let counting: SubtreeRoot | null = null;
  const outer = cascade.stylesOf;
  cascade.stylesOf = (el) => fresh.get(el)?.style ?? tree.styles.get(el)?.style;
  cascade.beginSharing(options.kept ?? null);
  try {
    for (const el of hidden) {
      const tag = tagOf(el);
      // what a build does not style
      if (NON_RENDERED.has(tag) || inImpliedHead(el, tag)) continue;
      if (!inLightTree(el)) return null;
      const up = flatParentOf(el);
      const parentStyle = up && tree.styles.get(up)?.style;
      if (!parentStyle) return null;
      const inFlex =
        parentStyle.display === 'flex' || parentStyle.display === 'inline-flex';
      const { style } = cascade.sharedStyleFor(
        el,
        parentStyle,
        cascade.freshShareKey(),
        inFlex,
      );
      // drawn after all: its boxes are its parent's to build
      if (style.display !== 'none') return null;
      unboxed.set(el, { style, inFlex });
      fresh.set(el, { style, inFlex });
    }
    for (const old of olds) {
      let made: SubtreeBuild | null;
      if (old.tail) {
        made = new Builder(options, copies).runTail(
          old.el,
          old.tail.node,
          old.box,
          old.tail.from,
          old.depth,
          tree.anonymous,
          old.tail.ran,
          old.tail.wrapped,
        );
      } else {
        const parentStyle = tree.styles.get(old.parent.el!)?.style;
        if (!parentStyle) return null;
        made = new Builder(options, copies).runSubtree(
          old.el!,
          old.parent,
          parentStyle,
          old.depth,
          tree.anonymous,
        );
      }
      if (!made) {
        const wider = old.tail ? old.el : old.el && flatParentOf(old.el);
        if (!wider) {
          found.wider = undefined;
          return null;
        }
        (found.wider ??= []).push(wider);
        continue;
      }
      // As many list items as it had, numbering nothing, and nothing else
      // done to a counter or a quote, before or after: what follows it
      // counts as it did. Or else nothing kept after it reads a counter or
      // a quote (`readsCounter`) — a stream's tail, at the document's
      // end, adding a list — with none counting down in the document.
      if (
        (old.counts || made.counts || made.listItems !== old.listItems) &&
        countedBy(
          old.parent.children.slice(old.index, old.index + old.count),
        ) !== countedBy(made.boxes)
      ) {
        if (tree.reversed || made.reversed) return null;
        counting ??= old;
      }
      // A float or a box out of the flow that pushed text holds the space
      // before it from the end of the line it is on (`after`'s `held`),
      // and one that pushed none leaves it to be taken back: where what is
      // built in one comes to text, or to none, from the other, the space
      // outside it is another.
      if (old.end > old.start !== made.text.length > 0) {
        for (let at: Box | null = old.parent; at; at = at.parent) {
          if ((at.outOfFlow || at.isFloat) && mayFollowSpace(at)) return null;
        }
      }
      for (const [el, entry] of made.styles) fresh.set(el, entry);
      built.push(made);
    }
  } finally {
    cascade.endSharing();
    cascade.stylesOf = outer;
  }
  if (found.wider) return null;
  if (counting) {
    // where a counter a box after them reads is made: before the roots,
    // or in what they are in, it counts what they hold
    const around = new Set<Box>();
    for (const o of olds) {
      for (let at: Box | null = o.parent; at; at = at.parent) around.add(at);
    }
    const before = (box: Box): boolean =>
      around.has(box) || olds.some((o) => o.boxes.has(box));
    if (
      boxesAfter(
        counting,
        olds,
        (box) => readsCounter(box) && countsAcross(box, before),
      )
    ) {
      return null;
    }
  }
  // A stream's chunk at the document's end: what it builds replaces all
  // there is after the first thing it touched, but the boxes around it, so
  // every list, the text and the styles end with what it builds, and what
  // is kept before it stays where it is in each. Where it only put nodes in,
  // nothing kept is gone or moved, and each is spliced at its end.
  const atEnd =
    !!found.appendOnly &&
    !gone.length &&
    !hidden.length &&
    olds.length > 0 &&
    !boxesAfter(olds[0], olds, () => true);
  if (atEnd) endBuilds += 1;
  // each new boxless element's style goes before the style of the element
  // after it in the document's order, as a build sets them
  const goneSet = new Set(gone);
  const styledAt = new Map<Element, Element[]>();
  const last: Element[] = [];
  for (const el of unboxed.keys()) {
    if (tree.styles.has(el)) continue;
    const next = styledAfter(el, (at) => tree.styles.has(at));
    if (!next) last.push(el);
    else {
      const at = styledAt.get(next);
      if (at) at.push(el);
      else styledAt.set(next, [el]);
    }
  }
  const placeUnboxed = (
    styles: Map<Element, { style: ComputedStyle; inFlex: boolean }>,
    el: Element | null,
  ): void => {
    for (const at of (el ? styledAt.get(el) : last) ?? []) {
      styles.set(at, unboxed.get(at)!);
    }
  };
  if (!olds.length) {
    // only boxless elements: their styles, and the tree as it is
    const styles = new Map<
      Element,
      { style: ComputedStyle; inFlex: boolean }
    >();
    for (const [el, entry] of tree.styles) {
      placeUnboxed(styles, el);
      if (goneSet.has(el)) continue;
      styles.set(el, unboxed.get(el) ?? entry);
    }
    placeUnboxed(styles, null);
    const stylers = new Builder(options, copies).stylersFor(
      styles,
      false,
      copies,
    );
    cascade.stylesOf = (el) => styles.get(el)?.style;
    return {
      tree: { ...tree, ...stylers, styles },
      made: [],
      replaced: [],
      added: [],
    };
  }

  // the styles, in the order a build sets them, which is the tree's: a
  // root's where its element's was, and a tail's before the first style
  // of what it held, or else of what comes after what holds it — that
  // alone where a script's change is built, whose tail may hold what it
  // moved there from before, styled where it was (`placed`)
  const tailStyles: {
    at: number;
    els: Set<Element>;
    placed: ReadonlySet<Element>;
    next: Element | null;
  }[] = [];
  olds.forEach((o, i) => {
    if (!o.tail || atEnd) return;
    const els = new Set<Element>();
    for (const node of o.tail.nodes) {
      if (!isElement(node)) continue;
      const stack: Element[] = [node];
      while (stack.length) {
        const at = stack.pop()!;
        if (tree.styles.has(at)) els.add(at);
        for (const child of at.children)
          if (isElement(child)) stack.push(child);
      }
    }
    const next = o.el
      ? styledAfter(o.el, (at) => tree.styles.has(at) && !els.has(at))
      : null;
    tailStyles.push({
      at: i,
      els,
      placed: found.appendOnly ? els : new Set(),
      next,
    });
  });
  // where a boxless element's style goes there too, which of the two is
  // first is more than can be said here
  for (const { next } of tailStyles) {
    if (next ? styledAt.has(next) : last.length) return null;
  }

  // the boxes around each root and tail, before they hold the new boxes:
  // where the line of one of them ends is past it
  const around = olds.map((o) => {
    const up = new Set<Box>();
    for (let at: Box | null = o.parent; at; at = at.parent) up.add(at);
    return up;
  });

  // the new boxes where the old were: a root's in its old box's place, a
  // tail's for the run that ends its parent's children
  for (let i = 0; i < olds.length; i += 1) {
    const { parent, index, count, boxes, tail, box: was } = olds[i];
    for (let k = index; k < index + count; k += 1) {
      const old = parent.children[k];
      if (boxes.has(old)) old.parent = null;
    }
    parent.children.splice(index, count, ...built[i].boxes);
    for (const box of built[i].boxes) box.parent = parent;
    // what came before the blocks of the parent's is as it was: a root's
    // box stands where its old one did, and a tail's first blocks are the
    // first kept before it, or its own
    const from = RAN_FROM.get(parent);
    if (!tail) {
      if (from?.inline === was) from.inline = built[i].boxes[0];
      if (from?.out === was) from.out = built[i].boxes[0];
    } else if (from || built[i].ranFrom?.wraps) {
      // one the tail wraps had no float or box out of the flow before it,
      // which a whole build would wrap then (`runTail`'s `wrapped`)
      const kept = (first: Box | null | undefined): Box | null =>
        first && !boxes.has(first) ? first : null;
      RAN_FROM.set(parent, {
        inline: kept(from?.inline) ?? built[i].ranFrom?.inline ?? null,
        out: kept(from?.out) ?? built[i].ranFrom?.out ?? null,
      });
    }
  }

  // The text: each root's old part of it given the new subtree's, and every
  // place in it after moved by as much.
  const bases: number[] = [];
  const deltas: number[] = [];
  let shift = 0;
  let text = '';
  let from = 0;
  for (let i = 0; i < olds.length; i += 1) {
    text += tree.text.slice(from, olds[i].start) + built[i].text;
    from = olds[i].end;
    bases.push(olds[i].start + shift);
    deltas.push(built[i].text.length - (olds[i].end - olds[i].start));
    shift += deltas[i];
  }
  text += tree.text.slice(from);
  const moved = (at: number): number => {
    let by = 0;
    for (let i = 0; i < olds.length && at >= olds[i].end; i += 1) {
      by += deltas[i];
    }
    return at + by;
  };
  // The text boxes, the document's text is in, by where they start — the
  // ones the fix-up took out of the tree as well (whitespace a flex box
  // holds), whose text is still the document's, as a build leaves them.
  const inside = (at: number): boolean =>
    olds.some((o) => at >= o.start && at < o.end);
  const keptText = atEnd
    ? null
    : tree.textBoxes.filter((box) => !inside(box.textStart));
  const made = new Set<Box>();
  built.forEach(({ boxes, textBoxes }, i) => {
    const base = bases[i];
    const stack = [...boxes, ...textBoxes];
    while (stack.length) {
      const at = stack.pop()!;
      if (made.has(at)) continue;
      made.add(at);
      if (at.textEnd > at.textStart) {
        at.textStart += base;
        at.textEnd += base;
      }
      for (const child of at.children) stack.push(child);
    }
  });
  const shifted = new Set<Box>();
  const pass = ++shiftPasses;
  const shiftBox = (at: Box): void => {
    if (made.has(at) || shifted.has(at)) return;
    shifted.add(at);
    if (at.textEnd > at.textStart && at.textStart >= olds[0].end) {
      const by = moved(at.textStart) - at.textStart;
      at.textStart += by;
      at.textEnd += by;
    }
    // and the lines a layout laid it out in, which one that keeps it keeps
    // with it: all of them before every root and tail, or after
    const lines = at.lines;
    if (lines?.length && lines[0].textStart >= olds[0].start) {
      const by = movedFor(lines[0].textStart, at);
      if (by) shiftLines(lines, by, pass);
    }
  };
  // How far a place in the text that a kept box has moves: past each root
  // or tail before it or in it. At one's end, it is past one with text, and
  // past one with none where the box holds the one or comes after it.
  const movedFor = (at: number, box: Box): number => {
    let by = 0;
    for (let i = 0; i < olds.length; i += 1) {
      const o = olds[i];
      if (
        at > o.end ||
        (at === o.end &&
          (o.start < o.end ||
            around[i].has(box) ||
            (!!box.el && precedes(o.first, box.el))))
      ) {
        by += deltas[i];
      }
    }
    return by;
  };
  // at the document's end, what is kept after the first is what holds them,
  // and what the fix-up dropped from those
  const ups = atEnd ? new Set<Box>() : null;
  if (ups) {
    for (const up of around) for (const at of up) ups.add(at);
    for (const at of ups) shiftBox(at);
    const boxes = tree.textBoxes;
    for (let k = textBoxAt(boxes, olds[0].start); k < boxes.length; k += 1) {
      if (!inside(boxes[k].textStart)) shiftBox(boxes[k]);
    }
    for (const b of built) for (const box of b.boxes) assignSubtreeRanges(box);
    // and the ranges around them, from the innermost out
    const depth = (box: Box): number => {
      let n = 0;
      for (let at = box.parent; at; at = at.parent) n += 1;
      return n;
    };
    for (const box of [...ups].sort((a, b) => depth(b) - depth(a))) {
      rangeOfChildren(box);
    }
  } else {
    for (const box of keptText!) shiftBox(box);
    const stack = [tree.root];
    while (stack.length) {
      const at = stack.pop()!;
      if (made.has(at)) continue;
      shiftBox(at);
      for (const child of at.children) stack.push(child);
    }
    assignSubtreeRanges(tree.root);
  }

  // each list: its old run for a root's subtree given the new subtree's
  const dropped = (box: Box): boolean => olds.some((o) => o.boxes.has(box));
  const relist = <T>(
    list: readonly T[],
    parts: (build: SubtreeBuild) => readonly T[],
    elementOf: (entry: T) => Element | null,
    gone: (entry: T) => boolean,
  ): T[] => {
    const out: T[] = [];
    let next = 0;
    for (const entry of list) {
      if (gone(entry)) continue;
      const el = elementOf(entry);
      while (next < olds.length && el && !beforeRoot(el, entry, olds[next])) {
        out.push(...parts(built[next]));
        next += 1;
      }
      out.push(entry);
    }
    while (next < olds.length) out.push(...parts(built[next++]));
    return out;
  };
  // under an element of `display: none`, as the styles are now
  const undrawnKnown = new Map<Element, boolean>();
  const noneHere = (at: Element): boolean =>
    (fresh.get(at)?.style ?? tree.styles.get(at)?.style)?.display === 'none';
  const undrawn = (el: Element): boolean =>
    atOrAbove(el, noneHere, undrawnKnown);
  // in what a root or a tail builds (`insideRoot`), a root's answer kept
  // for the elements under it
  const plainRoots = new Set<Element>();
  for (const o of olds) if (!o.tail) plainRoots.add(o.el!);
  const tailRoots = olds.filter((o) => o.tail);
  const plainKnown = new Map<Element, boolean>();
  const isPlainRoot = (at: Element): boolean => plainRoots.has(at);
  const insideAny = (node: ChildNode): boolean => {
    const holder = isElement(node) ? node : node.parent;
    if (
      plainRoots.size &&
      holder &&
      isElement(holder) &&
      atOrAbove(holder as Element, isPlainRoot, plainKnown)
    ) {
      return true;
    }
    return tailRoots.some((o) => insideRoot(node, o));
  };
  const goneElement = (el: Element): boolean => !connected(el) || insideAny(el);
  // and from a list, one no box is made for now: what a script moved out of
  // a root to under an element of `display: none`
  const goneEntry = (el: Element): boolean => goneElement(el) || undrawn(el);
  // by its box, and by its element: a list holds the box an element made
  // before the fix-up broke it around a block, which is in no tree
  const elementOfBox = (box: Box): Element | null =>
    box.el ?? GENERATED_FROM.get(box) ?? null;
  const inRange = (el: Element): boolean => insideAny(el);
  // at the document's end: each list's entries of what was rebuilt end it,
  // and the new ones end it now
  const atEndOf = <T>(
    list: readonly T[],
    parts: (build: SubtreeBuild) => readonly T[],
    replaced: (entry: T) => boolean,
  ): T[] => {
    let n = list.length;
    while (n > 0 && replaced(list[n - 1])) n -= 1;
    const out = list.slice(0, n);
    for (const b of built) for (const entry of parts(b)) out.push(entry);
    return out;
  };
  const boxList = (
    list: readonly Box[],
    parts: (build: SubtreeBuild) => readonly Box[],
  ): Box[] =>
    atEnd
      ? atEndOf(list, parts, (box) => {
          if (dropped(box)) return true;
          const el = elementOfBox(box);
          return !!el && inRange(el);
        })
      : relist(list, parts, elementOfBox, (box) => {
          if (dropped(box)) return true;
          const el = elementOfBox(box);
          return !!el && goneEntry(el);
        });
  const elementList = <T>(
    list: readonly T[],
    parts: (build: SubtreeBuild) => readonly T[],
    elementOf: (entry: T) => Element,
  ): T[] =>
    atEnd
      ? atEndOf(list, parts, (entry) => inRange(elementOf(entry)))
      : relist(list, parts, elementOf, (entry) => goneEntry(elementOf(entry)));

  let textBoxes: Box[];
  if (keptText) {
    textBoxes = [...keptText, ...built.flatMap((b) => b.textBoxes)].sort(
      (a, b) => a.textStart - b.textStart,
    );
  } else {
    const at = textBoxAt(tree.textBoxes, olds[0].start);
    textBoxes = tree.textBoxes.slice(0, at);
    const rest = tree.textBoxes
      .slice(at)
      .filter((box) => !inside(box.textStart));
    for (const b of built) rest.push(...b.textBoxes);
    rest.sort((a, b) => a.textStart - b.textStart);
    for (const box of rest) textBoxes.push(box);
  }

  // at the document's end, the text nodes before the first are as they
  // were, where none moved
  const sources = tree.textNodes ?? [];
  const firstSource = atEnd ? textNodeAt(sources, olds[0].start) : 0;
  const keptNodes: TextSource[] = sources.slice(0, firstSource);
  for (let k = firstSource; k < sources.length; k += 1) {
    const source = sources[k];
    // by where it starts, and where it is: one whose line took back the
    // space it ended on ends a unit past its text, and one whose line took
    // back all it had starts at its subtree's end
    const node = source.node as unknown as ChildNode;
    const holder = node.parent as Element | null;
    if (
      !holder ||
      !connected(node as unknown as Element) ||
      insideAny(node) ||
      olds.some(
        (o) =>
          // one moved out of a root to where nothing draws it, at its end
          // too where the root's line took back all it had — but not one
          // before it, drawn, whose space the root's line took back
          source.start >= o.start &&
          source.start <= o.end &&
          ((isElement(holder) && undrawn(holder)) ||
            (source.start < o.end && !precedes(source.node, o.first))),
      )
    ) {
      continue;
    }
    // past each root before it — and at a root's end, one whose line took
    // back all it had is before it or after it as its node is
    let by = 0;
    olds.forEach((o, i) => {
      if (
        source.start > o.end ||
        (source.start === o.end && !precedes(source.node, o.first))
      ) {
        by += deltas[i];
      }
    });
    keptNodes.push({
      ...source,
      start: source.start + by,
      end: source.end + by,
    });
  }
  // each root's where its text is, and at the same place where it is in
  // the document: a text whose line took back all it had starts where the
  // next does
  const textNodes: TextSource[] = [];
  let nextRoot = 0;
  const flush = (): void => {
    for (const source of built[nextRoot].textNodes) {
      textNodes.push({
        ...source,
        start: source.start + bases[nextRoot],
        end: source.end + bases[nextRoot],
      });
    }
    nextRoot += 1;
  };
  for (const source of keptNodes) {
    while (
      nextRoot < olds.length &&
      (source.start > bases[nextRoot] ||
        (source.start === bases[nextRoot] &&
          !precedes(source.node, olds[nextRoot].first)))
    ) {
      flush();
    }
    textNodes.push(source);
  }
  while (nextRoot < olds.length) flush();

  const pairs: [number, number][] = [];
  const old = tree.unselectable;
  for (let i = 0; i < old.length; i += 2) {
    let pieces: [number, number][] = [[old[i], old[i + 1]]];
    for (const o of olds) {
      pieces = pieces.flatMap(([a, b]): [number, number][] =>
        b <= o.start || a >= o.end
          ? [[a, b]]
          : [
              ...(a < o.start ? [[a, o.start] as [number, number]] : []),
              ...(b > o.end ? [[o.end, b] as [number, number]] : []),
            ],
      );
    }
    for (const [a, b] of pieces) {
      const by = moved(a) - a;
      pairs.push([a + by, b + by]);
    }
  }
  built.forEach((b, i) => {
    for (let j = 0; j < b.unselectable.length; j += 2) {
      pairs.push([
        b.unselectable[j] + bases[i],
        b.unselectable[j + 1] + bases[i],
      ]);
    }
  });
  pairs.sort((a, b) => a[0] - b[0]);
  const unselectable: number[] = [];
  for (const [a, b] of pairs) {
    if (b <= a) continue;
    const n = unselectable.length;
    if (n && unselectable[n - 1] >= a) {
      unselectable[n - 1] = Math.max(unselectable[n - 1], b);
    } else unselectable.push(a, b);
  }

  // the styles, in the order a build sets them, which is the tree's
  const styles = atEnd
    ? new Map(tree.styles)
    : new Map<Element, { style: ComputedStyle; inFlex: boolean }>();
  if (atEnd) {
    // what each held, which ends the document: the old with what came, by
    // the document as it is; and what each built, after it
    for (const o of olds) {
      for (const node of o.tail ? o.tail.nodes : [o.el!]) {
        if (!isElement(node)) continue;
        const stack: Element[] = [node];
        while (stack.length) {
          const at = stack.pop()!;
          styles.delete(at);
          for (const child of at.children) {
            if (isElement(child)) stack.push(child);
          }
        }
      }
    }
    for (const b of built) for (const [k, v] of b.styles) styles.set(k, v);
  }
  let nextTail = 0;
  const tailHere = (el: Element | null): void => {
    while (
      nextTail < tailStyles.length &&
      (el === null ||
        tailStyles[nextTail].placed.has(el) ||
        tailStyles[nextTail].next === el)
    ) {
      for (const [k, v] of built[tailStyles[nextTail].at].styles) {
        styles.set(k, v);
      }
      nextTail += 1;
    }
  };
  for (const [el, entry] of atEnd ? [] : tree.styles) {
    placeUnboxed(styles, el);
    tailHere(el);
    const at = olds.findIndex((o) => !o.tail && o.el === el);
    if (at >= 0) {
      for (const [k, v] of built[at].styles) styles.set(k, v);
      continue;
    }
    const boxless = unboxed.get(el);
    if (boxless) {
      styles.set(el, boxless);
      continue;
    }
    if (fresh.has(el) || goneElement(el)) continue;
    styles.set(el, entry);
  }
  if (!atEnd) {
    tailHere(null);
    placeUnboxed(styles, null);
  }
  // and none under an element of `display: none`, which a build styles and
  // goes no further into: one a script moved out of a root, into one — at
  // the document's end, of what was built, where nothing kept moved
  const restyled = atEnd ? built.flatMap((b) => [...b.styles.keys()]) : null;
  const hiddenKnown = new Map<Element, boolean>();
  const hidesHere = (at: Element): boolean =>
    styles.get(at)?.style.display === 'none';
  for (const el of restyled ?? styles.keys()) {
    if (atOrAbove(flatParentOf(el), hidesHere, hiddenKnown)) styles.delete(el);
  }
  cascade.stylesOf = (el) => styles.get(el)?.style;

  const textStyles = new Set(tree.textStyles);
  for (const b of built)
    for (const style of b.textStyles) textStyles.add(style);
  const flag = (name: keyof SubtreeBuild['flags']): boolean =>
    tree[name] || built.some((b) => b.flags[name]);
  const stylers = new Builder(options, copies).stylersFor(
    styles,
    false,
    copies,
  );
  const next: BoxTree = {
    ...tree,
    ...(tree.containers && { containers: containerBoxes(tree.root) }),
    ...stylers,
    text,
    textBoxes,
    textNodes,
    unselectable,
    textStyles,
    styles,
    controls: boxList(tree.controls, (b) => b.controls),
    media: boxList(tree.media, (b) => b.media),
    embedded: boxList(tree.embedded, (b) => b.embedded),
    links: boxList(tree.links, (b) => b.links),
    focusables: boxList(tree.focusables, (b) => b.focusables),
    backgrounds: boxList(tree.backgrounds, (b) => b.backgrounds),
    awaiting: boxList(tree.awaiting, (b) => b.awaiting),
    images: boxList(tree.images, (b) => b.images),
    contentImages: elementList(
      tree.contentImages,
      (b) => b.contentImages,
      (entry) => entry.element,
    ),
    awaitingKind: elementList(
      tree.awaitingKind,
      (b) => b.awaitingKind,
      (el) => el,
    ),
    relative: flag('relative'),
    tilted: flag('tilted'),
    readingFlow: flag('readingFlow'),
    anchors: flag('anchors'),
    negative: flag('negative'),
    nestedOutOfLine: flag('nestedOutOfLine'),
    movedInline: flag('movedInline'),
    clipText: flag('clipText'),
    reversed: !!tree.reversed || built.some((b) => b.reversed),
  };
  // what layout forgets the sizes of: each new box, and what holds a tail,
  // whose content is another
  const forget: Box[] = [];
  olds.forEach((o, i) => {
    if (o.tail) forget.push(o.box);
    forget.push(...built[i].boxes);
  });
  return {
    tree: next,
    made: forget,
    replaced: olds.map((o) => o.boxes),
    added: built.flatMap((b) => b.boxes),
  };
}

/** How many subtree builds were spliced at the document's end (`atEnd`),
 *  for a test to say that some were. */
let endBuilds = 0;
export function buildsAtEnd(): number {
  return endBuilds;
}

/** What `buildSubtrees` made: the tree, the boxes whose sizes and those of
 *  what holds them are to be forgotten (`forgetSizes`), each root's and
 *  tail's old boxes, and the new boxes at the top of each, in the
 *  document's order. */
export interface SubtreesBuilt {
  tree: BoxTree;
  made: Box[];
  replaced: ReadonlySet<Box>[];
  added: Box[];
}

/** A kept block's lines moved by `by` in the document's text, and the
 *  texts on them, and what maps their layouts' text to the document's,
 *  each once in the build of subtrees `pass` is (`SpanMap.shiftDocument`). */
function shiftLines(lines: readonly LineBox[], by: number, pass: number): void {
  for (const line of lines) {
    line.textStart += by;
    line.textEnd += by;
    for (const text of line.texts) {
      text.textStart += by;
      text.textEnd += by;
      text.spans.shiftDocument?.(by, pass);
    }
  }
}

/** Every build of subtrees counted, for `shiftLines`: a set of the span
 *  maps one moved was one entry more for every block kept after a change,
 *  at every build a page's scripts made. */
let shiftPasses = 0;

/** A box's range in the document's text from its own text and its
 *  children's ranges, which are theirs already (`assignSubtreeRanges`). */
function rangeOfChildren(box: Box): void {
  let start = box.textEnd > box.textStart ? box.textStart : Infinity;
  let end = box.textEnd > box.textStart ? box.textEnd : -Infinity;
  for (const child of box.children) {
    if (child.subtreeTextEnd > child.subtreeTextStart) {
      start = Math.min(start, child.subtreeTextStart);
      end = Math.max(end, child.subtreeTextEnd);
    }
  }
  if (end <= start) {
    box.subtreeTextStart = 0;
    box.subtreeTextEnd = 0;
  } else {
    box.subtreeTextStart = start;
    box.subtreeTextEnd = end;
  }
}

/** The first of text boxes, in the order of the text, that starts at `at`
 *  or past it. */
function textBoxAt(boxes: readonly Box[], at: number): number {
  let lo = 0;
  let hi = boxes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boxes[mid].textStart < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The same of the text's nodes (`TextSource`). */
function textNodeAt(sources: readonly TextSource[], at: number): number {
  let lo = 0;
  let hi = sources.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sources[mid].start < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Whether `test` holds of `el` or of an element above it in the flat tree,
 * every answer found on the way kept in `known` for the walks after it: a
 * subtree build asks it of each entry of each list it splices, and a walk
 * to the top of the document for each was most of the build of a sparkle
 * in a long article.
 */
function atOrAbove(
  el: Element | null,
  test: (at: Element) => boolean,
  known: Map<Element, boolean>,
): boolean {
  const path: Element[] = [];
  let answer = false;
  for (let at = el; at; at = flatParentOf(at)) {
    const was = known.get(at);
    if (was !== undefined) {
      answer = was;
      break;
    }
    path.push(at);
    if (test(at)) {
      answer = true;
      break;
    }
  }
  for (const at of path) known.set(at, answer);
  return answer;
}

/** Whether `node` is in what a root or a tail builds: the root's element
 *  or in it, or one of a tail's nodes or in one. */
function insideRoot(node: ChildNode, o: SubtreeRoot): boolean {
  const tail = o.tail;
  if (!tail) {
    const holder = isElement(node) ? node : (node.parent as Element | null);
    return !!holder && isElement(holder) && within(holder, o.el!);
  }
  let at: ChildNode = node;
  while (at.parent && at.parent !== tail.node) at = at.parent as ChildNode;
  return at.parent === tail.node && tail.nodes.has(at);
}

/** Whether a list's entry for a box of `el` comes before what a build of a
 *  root or a tail adds to the list (`before`): a tail's holder's own
 *  entries do, but for its `::after`, which the tail builds. */
function beforeRoot(el: Element, entry: unknown, o: SubtreeRoot): boolean {
  if (!o.tail) return before(el, entry, o.el!);
  if (insideRoot(el, o)) return false;
  if (o.el && (el === o.el || within(o.el, el))) {
    const box = entry instanceof Box ? entry : null;
    return box?.pseudo !== 'after';
  }
  return precedes(el, o.first);
}

/**
 * Whether a box kept after `from` in the document's order — none of the
 * roots' and tails' — is one `test` says: one that reads a counter, or a
 * quote's depth (`readsCounter`), which the new boxes' builds read none of
 * they did not make (`CounterScopes`), and which a root that counts
 * otherwise than it did would make another number; or any at all. A
 * stream's tail is at the document's end, with nothing after it.
 */
function boxesAfter(
  from: SubtreeRoot,
  olds: readonly SubtreeRoot[],
  test: (box: Box) => boolean,
): boolean {
  const replaced = (box: Box): boolean => olds.some((o) => o.boxes.has(box));
  const reads = (root: Box): boolean => {
    const stack = [root];
    while (stack.length) {
      const box = stack.pop()!;
      if (replaced(box)) continue;
      if (test(box)) return true;
      for (const child of box.children) stack.push(child);
    }
    return false;
  };
  // after its run in its parent, then after each box around it in theirs
  let at = from.parent;
  for (let k = from.index + from.count; k < at.children.length; k += 1) {
    if (reads(at.children[k])) return true;
  }
  for (; at.parent; at = at.parent) {
    const siblings = at.parent.children;
    for (let k = siblings.indexOf(at) + 1; k < siblings.length; k += 1) {
      if (reads(siblings[k])) return true;
    }
  }
  return false;
}

/** Whether a box reads a counter or a quote's depth: a numbered marker, a
 *  `::marker` or a pseudo-element whose content has one. */
function readsCounter(box: Box): boolean {
  const style = box.style;
  if (
    style.display === 'list-item' &&
    (box.el || box.pseudo) &&
    numberedMarker(style)
  ) {
    return true;
  }
  const marker = box.marker?.style?.content;
  if (Array.isArray(marker) && contentReads(marker as ContentItem[])) {
    return true;
  }
  return (
    !!box.pseudo &&
    Array.isArray(style.content) &&
    contentReads(style.content as ContentItem[])
  );
}

/**
 * Whether what a box after roots built again reads of a counter can be
 * what they counted (`readsCounter`, `buildSubtrees`): a quote's depth, or
 * every instance of a name in `counters()`; or a counter whose instance —
 * made by the nearest reset of its name on the box, on a box before it
 * among its siblings, or on a box around it and those before it (CSS
 * Lists 3, 4.4) — is made by a box `before` says is a root's or holds one,
 * or before such a box. One made after the roots counts from there,
 * whatever they did: Apple's footnotes are an `<ol>`, which makes its own
 * `list-item`, and every section built again before them was a build of
 * the whole page.
 */
function countsAcross(box: Box, before: (box: Box) => boolean): boolean {
  const names = countersOf(box);
  if (!names) return true;
  for (const name of names) {
    for (let at: Box | null = box; ; at = at.parent) {
      if (!at || before(at)) return true;
      if (resets(at, name)) break;
      const siblings = at.parent?.children ?? [];
      let made = false;
      for (let k = siblings.indexOf(at) - 1; k >= 0 && !made; k -= 1) {
        if (before(siblings[k])) return true;
        made = resets(siblings[k], name);
      }
      if (made) break;
    }
  }
  return false;
}

/** The names of the counters a box reads (`readsCounter`), each the one
 *  instance in scope; null where it reads a quote's depth, or every
 *  instance of a name. */
function countersOf(box: Box): string[] | null {
  const names: string[] = [];
  const style = box.style;
  if (
    style.display === 'list-item' &&
    (box.el || box.pseudo) &&
    numberedMarker(style)
  ) {
    names.push('list-item');
  }
  for (const content of [
    box.marker?.style?.content,
    box.pseudo ? style.content : null,
  ]) {
    if (!Array.isArray(content)) continue;
    for (const item of content as ContentItem[]) {
      if (item.kind === 'counter') names.push(item.name);
      else if (
        item.kind !== 'string' &&
        item.kind !== 'url' &&
        item.kind !== 'attr'
      ) {
        return null;
      }
    }
  }
  return names;
}

/** Whether a box makes a counter of `name` (`counter-reset`). */
function resets(box: Box, name: string): boolean {
  return !!box.style.counterReset?.some((c) => c.name === name);
}

/** Whether generated content has a counter or a quote in it. */
function contentReads(items: readonly ContentItem[]): boolean {
  for (const item of items) {
    if (item.kind !== 'string' && item.kind !== 'url' && item.kind !== 'attr') {
      return true;
    }
  }
  return false;
}

/**
 * `el`'s old box, as the root of a subtree build: its only box, a block
 * or a flex box in the flow, the child of its parent element's block or
 * flex box, its subtree hosting no shadow tree and with no box in the top
 * layer, and where in the document's text its subtree's is — from what the
 * boxes before it in its ancestors hold, where it holds none. Null where
 * any of that is not so.
 */
function subtreeRoot(
  el: Element,
  firstBoxes: ReadonlyMap<Element, Box>,
): SubtreeRoot | null {
  if (!canRebuild(el, firstBoxes) || !inLightTree(el)) return null;
  const box = firstBoxes.get(el)!;
  const parent = box.parent!;
  const index = parent.children.indexOf(box);
  if (index < 0) return null;
  let depth = 0;
  for (let at: Box | null = parent; at?.parent; at = at.parent) depth += 1;
  if (depth > MAX_DEPTH - 64) return null;
  const { boxes, listItems, counts: counted } = oldBoxes([box]) ?? {};
  if (!boxes) return null;
  let start = Infinity;
  let end = -Infinity;
  if (box.subtreeTextEnd > box.subtreeTextStart) {
    start = box.subtreeTextStart;
    end = box.subtreeTextEnd;
  }
  return {
    el,
    tail: null,
    first: el,
    box,
    parent,
    index,
    count: 1,
    depth,
    start,
    end,
    boxes,
    listItems: listItems!,
    counts: counted!,
  };
}

/**
 * The text of what the fix-up took out of each root, white space between its
 * blocks, into where its text starts and ends: it is the document's text
 * where the builder pushed it, its parent says where, and no walk of the
 * root's boxes finds it. Once over the document's text for all the roots,
 * each box asked once for the root it is in: asked for each root, a sheet
 * that styled 749 of Wikipedia's headings took 1.5 seconds to find them.
 */
function holdDroppedText(
  olds: readonly SubtreeRoot[],
  textBoxes: readonly Box[],
): void {
  const rootOf = new Map<Box, SubtreeRoot | null>();
  for (const old of olds) rootOf.set(old.box, old);
  const above: Box[] = [];
  for (const text of textBoxes) {
    let root: SubtreeRoot | null | undefined;
    for (let at = text.parent; at; at = at.parent) {
      root = rootOf.get(at);
      if (root !== undefined) break;
      above.push(at);
    }
    while (above.length) rootOf.set(above.pop()!, root ?? null);
    if (!root || root.boxes.has(text)) continue;
    root.start = Math.min(root.start, text.textStart);
    root.end = Math.max(root.end, text.textEnd);
  }
}

/** Every box of a run of old boxes and what they hold, with how many list
 *  items they hold that number nothing and whether any other changes a
 *  counter or reads one, or a quote (`counts`): null where one hosts a
 *  shadow tree or is in the top layer, which no build apart takes apart. */
function oldBoxes(
  run: readonly Box[],
): { boxes: Set<Box>; listItems: number; counts: boolean } | null {
  const boxes = new Set<Box>();
  let listItems = 0;
  let counted = false;
  const stack = [...run];
  while (stack.length) {
    const at = stack.pop()!;
    boxes.add(at);
    if (at.topLayer || (at.el && holdsShadow(at.el))) return null;
    if (at.style.display === 'list-item' && (at.el || at.pseudo)) {
      listItems += 1;
    }
    if (counts(at)) counted = true;
    for (const child of at.children) stack.push(child);
  }
  return { boxes, listItems, counts: counted };
}

/**
 * The end of what `node` holds — an element, or the document — from its
 * child at `from` on, as the root of a subtree build (`Builder.runTail`):
 * where the child before is a block-level box of the holder's own in the
 * flow, which stays, and whose line it ended, so that what comes after it
 * starts where the builder starts a build of its own — its white space,
 * the word it is in and the holder's anonymous blocks as a block leaves
 * them. The holder's box stays as it is: a block container in the
 * document's own tree, hosting no shadow tree and with nothing it holds
 * moved elsewhere (`TAILS_REFUSED`). Its old boxes are the run of the
 * holder box's children after the box before, its `::after` with them, and
 * its text from where that box's line ended (`textAfterBox`) to where the
 * holder's did. Null where any of that is not so.
 */
function tailRoot(
  node: ParentNode,
  from: number,
  tree: BoxTree,
  document: { children: unknown },
  firstBoxes: ReadonlyMap<Element, Box>,
): SubtreeRoot | null {
  const kids = node.children;
  if (from <= 0 || from >= kids.length) return null;
  const holder = isElement(node) ? node : null;
  let box: Box | undefined;
  if (holder) {
    box = firstBoxes.get(holder);
    if (
      !box ||
      box.el !== holder ||
      box.pseudo ||
      !inLightTree(holder) ||
      holdsShadow(holder) ||
      flatChildrenOf(holder) !== holder.children ||
      TAILS_REFUSED.has(tagOf(holder))
    ) {
      return null;
    }
  } else {
    // the document's own children, which the root box holds
    if (node !== document) return null;
    box = tree.root;
  }
  // a block's, or a flex or grid box's, whose children are each an item of
  // their own, with nothing before one that its fix-up carries to it
  const items = box.kind === 'flex';
  if (
    (box.kind !== 'block' && !items) ||
    box.style.contentVisibility === 'hidden'
  ) {
    return null;
  }
  const before = kids[from - 1];
  const after = isElement(before) ? firstBoxes.get(before) : undefined;
  if (!after || !endsLine(after, before as Element, box)) return null;
  const index = box.children.indexOf(after);
  if (index < 0) return null;
  const ran = items ? 0 : ranBefore(after, box);
  if (ran < 0) return null;
  // where only floats and boxes out of the flow came before, whether they
  // are wrapped, which a whole build wraps as the tail has it
  let wrapped = false;
  if (!(ran & RAN_INLINE) && ran & RAN_OUT) {
    for (let k = index - 1; k >= 0; k -= 1) {
      const at = box.children[k];
      if (!at.el && !at.pseudo && at.kind === 'block') {
        wrapped = true;
        break;
      }
      if (at.outOfFlow || at.isFloat) break;
    }
  }
  const start = textAfterBox(after, tree.textBoxes);
  const end = holder ? textAfterBox(box, tree.textBoxes) : tree.text.length;
  if (start < 0 || end < start) return null;
  let depth = 0;
  for (let at: Box | null = box; at?.parent; at = at.parent) depth += 1;
  if (depth > MAX_DEPTH - 64) return null;
  const run = box.children.slice(index + 1);
  const found = oldBoxes(run);
  if (!found) return null;
  return {
    el: holder,
    tail: { node, from, nodes: new Set(kids.slice(from)), ran, wrapped },
    first: kids[from],
    box,
    parent: box,
    index: index + 1,
    count: run.length,
    depth,
    start,
    end,
    boxes: found.boxes,
    listItems: found.listItems,
    counts: found.counts,
  };
}

/** Whether `el`'s box can be what a tail of `holder`'s box follows
 *  (`tailRoot`): its element's only box, a block-level box of the holder's
 *  own — a block, a flex box, a table — in the flow, which ends the line
 *  before what follows it. */
function endsLine(box: Box, el: Element, holder: Box): boolean {
  return (
    box.el === el &&
    !box.pseudo &&
    box.parent === holder &&
    (box.kind === 'block' || box.kind === 'flex' || box.kind === 'table') &&
    isBlockLevel(box) &&
    !box.outOfFlow &&
    !box.isFloat &&
    !box.topLayer &&
    box.style.overlay !== 'auto' &&
    // a break that clears the floats is a block that ended no line
    // (`_elementIn`), and every other the builder made ended one
    tagOf(el) !== 'br'
  );
}

/**
 * Where a tail of what `node` holds starts, for a change that touched its
 * children from `touched` on (`HtmlViewNode._subtreeRoots`): after the last
 * of its children before that whose box ends the line in the holder's box
 * (`endsLine`) — what comes between is built again with what changed. -1
 * where there is none, or the holder's box holds no block (`tailRoot`
 * says the rest).
 */
export function tailFrom(
  node: ParentNode,
  touched: ChildNode,
  firstBoxes: ReadonlyMap<Element, Box>,
  tree: BoxTree,
): number {
  const holder = isElement(node) ? firstBoxes.get(node) : tree.root;
  if (!holder || (holder.kind !== 'block' && holder.kind !== 'flex')) {
    return -1;
  }
  const kids = node.children;
  for (let i = kids.lastIndexOf(touched) - 1; i >= 0; i -= 1) {
    const kid = kids[i];
    if (!isElement(kid)) continue;
    const box = firstBoxes.get(kid);
    if (box && endsLine(box, kid, holder)) return i + 1;
  }
  return -1;
}

/** The elements whose children no tail is built of: what holds them is
 *  laid out or drawn otherwise than its children are in a block — a
 *  `<details>`'s content in a `::details-content`, a fieldset's legend on
 *  its border, a control's. The root element's are built as a block's
 *  are: Apple's scripts put a probe of the viewport after the `<body>` at
 *  every step of a drag, and take it out, and each built the document. */
const TAILS_REFUSED = new Set([
  'details',
  'summary',
  'fieldset',
  'legend',
  'button',
  'select',
  'option',
  'optgroup',
  'textarea',
  'datalist',
]);

/**
 * Where a root with no text of its own starts in the document's text, from
 * `at`, where the text of the tree's boxes before it ends: past the text of
 * what the fix-up took out of the tree right there, whitespace a block
 * holds, where its text node is before the root — which the builder pushed
 * before the root's, and no box's range in the tree says.
 */
function pastDropped(
  at: number,
  root: Element,
  textBoxes: readonly Box[],
  textNodes: readonly TextSource[],
): number {
  for (;;) {
    const next = textBoxes.find((box) => box.textStart === at);
    if (!next || inTree(next)) return at;
    const source = textNodes.find((node) => node.start <= at && at < node.end);
    if (!source || !precedes(source.node, root)) {
      return at;
    }
    at = next.textEnd;
  }
}

/** Whether a box is in its tree: each box above it holds the one below. */
function inTree(box: Box): boolean {
  let at = box;
  for (; at.parent; at = at.parent) {
    if (!at.parent.children.includes(at)) return false;
  }
  return true;
}

/**
 * Whether `el`'s box can be the root of a subtree build, by what the box
 * is: its element's only box, a block or a flex box in the flow, the child
 * of its parent element's block or flex box, and no `<html>` or `<body>`,
 * whose styles the root box's and the viewport's are read from. What its
 * subtree holds is asked as it is built (`buildSubtrees`).
 */
export function canRebuild(
  el: Element,
  firstBoxes: ReadonlyMap<Element, Box>,
): boolean {
  const box = firstBoxes.get(el);
  const parent = box?.parent;
  const up = flatParentOf(el);
  if (!box || !parent || !up || parent.el !== up || parent.pseudo) return false;
  if (box.el !== el || box.pseudo) return false;
  if (box.kind !== 'block' && box.kind !== 'flex') return false;
  // and block-level: an inline-block is in the line around it, whose word
  // a `capitalize` carries into it
  if (!isBlockLevel(box)) return false;
  if (box.outOfFlow || box.isFloat || box.topLayer) return false;
  if (box.style.overlay === 'auto') return false;
  if (parent.kind !== 'block' && parent.kind !== 'flex') return false;
  const tag = tagOf(el);
  return tag !== 'html' && tag !== 'body';
}

/**
 * Whether an element is in the document's own tree and where its parent
 * is in the flat tree too, as each element around it is: in no shadow tree,
 * and assigned to no slot. A subtree of such an element is a run of the
 * document's order, and its text one of the document's text, and a build
 * of it finds the boxes and the entries it replaces by where their
 * elements are in it (`within`, `before`).
 */
function inLightTree(el: Element): boolean {
  for (let at: Element = el; ;) {
    const parent = at.parent;
    if (!parent || parent instanceof ShadowRoot) return false;
    if (!isElement(parent)) return true;
    if (flatParentOf(at) !== parent) return false;
    at = parent;
  }
}

/** Whether a box's element hosts a shadow tree, or is at the top of one:
 *  what a subtree build of the document's own tree cannot take apart, since
 *  what such a tree holds is no run of the document's order. */
function holdsShadow(el: Element): boolean {
  return shadowRootOf(el) !== null || el.parent instanceof ShadowRoot;
}

/**
 * Whether a float or a box out of the flow can come after a space on a line
 * (`after`'s `held`): there is inline content before it, or an anonymous
 * box that may hold some, in what holds it. After a block, or first in a
 * block, no line has started: Apple's menu counts its search results in an
 * empty absolute box, and each count laid out the whole document.
 */
function mayFollowSpace(box: Box): boolean {
  for (let at = box; ;) {
    const parent = at.parent;
    if (!parent) return false;
    const kids = parent.children;
    for (let i = kids.indexOf(at) - 1; i >= 0; i -= 1) {
      const kid = kids[i];
      if (kid.outOfFlow || kid.isFloat) continue;
      return !kid.el || !isBlockLevel(kid);
    }
    if (parent.kind !== 'inline') return false;
    at = parent;
  }
}

/**
 * What a run of boxes does to the counters and the quotes around it, in
 * their order: two runs alike leave what comes after them to count from
 * where it did, whatever else they hold. Wikipedia's articles number their
 * references, and a change to a section that holds a list built the whole
 * document for what that list could have done to them.
 */
function countedBy(run: readonly Box[]): string {
  const counted: unknown[] = [];
  const stack = [...run].reverse();
  while (stack.length) {
    const box = stack.pop()!;
    const style = box.style;
    const item = style.display === 'list-item' && (box.el || box.pseudo);
    if (item || counts(box)) {
      counted.push([
        !!item,
        box.topLayer,
        style.counterReset,
        style.counterIncrement,
        style.counterSet,
        box.el ? attr(box.el, 'value') : null,
        box.pseudo ? style.content : null,
      ]);
    }
    for (let i = box.children.length - 1; i >= 0; i -= 1) {
      stack.push(box.children[i]);
    }
  }
  return JSON.stringify(counted);
}

/** Whether a box changes or reads a counter, or a quote, or is in the top
 *  layer: what a subtree holding it cannot be built apart for. */
function counts(box: Box): boolean {
  const style = box.style;
  if (box.topLayer) return true;
  if (
    style.counterReset ||
    style.counterIncrement ||
    style.counterSet ||
    (style.display === 'list-item' && numberedMarker(style))
  ) {
    return true;
  }
  if (box.pseudo && Array.isArray(style.content)) {
    for (const item of style.content as ContentItem[]) {
      if (
        item.kind !== 'string' &&
        item.kind !== 'url' &&
        item.kind !== 'attr'
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Where in the document's text a box that holds none would start: after
 *  the last text of what comes before it among its ancestors' children,
 *  which is the document's order but in a table, whose captions the
 *  fix-up moves (`fixUpTable`) — null there. */
function textBefore(box: Box): number | null {
  for (let at = box; at.parent; at = at.parent) {
    const parent = at.parent;
    if (parent.kind === 'table') return null;
    const siblings = parent.children;
    for (let i = siblings.indexOf(at) - 1; i >= 0; i -= 1) {
      const sib = siblings[i];
      if (sib.subtreeTextEnd > sib.subtreeTextStart) return sib.subtreeTextEnd;
    }
    if (parent.textEnd > parent.textStart) return parent.textEnd;
  }
  return 0;
}

/** Whether `el` is `root` or in it, in the flat tree a build walks. */
function within(el: Element, root: Element): boolean {
  for (let at: Element | null = el; at; at = flatParentOf(at)) {
    if (at === root) return true;
  }
  return false;
}

/** The first element after `el` in the document's order, and not in it,
 *  that `has` holds: whose style a build sets after `el`'s. */
function styledAfter(
  el: Element,
  has: (el: Element) => boolean,
): Element | null {
  for (let at: ChildNode = el; ;) {
    for (let next = at.next; next; next = next.next) {
      const found = firstStyled(next, has);
      if (found) return found;
    }
    const parent: ChildNode | null = at.parent as ChildNode | null;
    if (!parent || !isElement(parent)) return null;
    at = parent;
  }
}

/** The first element in `node`, `node` first, that `has` holds. */
function firstStyled(
  node: ChildNode,
  has: (el: Element) => boolean,
): Element | null {
  if (!isElement(node)) return null;
  if (has(node)) return node;
  for (const child of node.children) {
    const found = firstStyled(child, has);
    if (found) return found;
  }
  return null;
}

/** Whether `el` is still in a document. */
function connected(el: Element): boolean {
  let at: { parent: unknown } = el;
  while (at.parent) at = at.parent as { parent: unknown };
  return (at as { type?: string }).type === 'root';
}

/** Whether a list's entry for a box of `el` comes before what a build of
 *  `root`'s subtree adds to the list: an element before it in the
 *  document, or one around it, but for its `::after`. */
function before(el: Element, entry: unknown, root: Element): boolean {
  if (el === root || within(el, root)) return false;
  if (within(root, el)) {
    const box = entry instanceof Box ? entry : null;
    return box?.pseudo !== 'after';
  }
  return precedes(el, root);
}

/**
 * Whether `a` comes before `b` in the document, neither in the other: by
 * their places in the parent their chains last share. Not domutils'
 * `compareDocumentPosition`, which starts a node with no children from its
 * parent, and took a text after an element beside it for one before it.
 */
function precedes(a: { parent: unknown }, b: { parent: unknown }): boolean {
  const chain = (node: { parent: unknown }): unknown[] => {
    const out: unknown[] = [];
    for (let at: { parent: unknown } | null = node; at;) {
      out.unshift(at);
      at = at.parent as { parent: unknown } | null;
    }
    return out;
  };
  const up = chain(a);
  const down = chain(b);
  let i = 0;
  while (i < up.length && i < down.length && up[i] === down[i]) i += 1;
  // in two trees: by their places in the flat tree, which the build walks
  if (i === 0) return flatPrecedes(a as ChildNode, b as ChildNode);
  // one in the other
  if (i === up.length || i === down.length) return false;
  const siblings = (up[i - 1] as { children: unknown[] }).children;
  return siblings.indexOf(up[i]) < siblings.indexOf(down[i]);
}

/** `precedes` in the flat tree, for a node in a shadow tree and one
 *  outside it: by their places in the flat parent their chains last share
 *  (`flatChildrenOf`). False where they share none. */
function flatPrecedes(a: ChildNode, b: ChildNode): boolean {
  const chain = (node: ChildNode): ChildNode[] => {
    const out: ChildNode[] = [];
    for (let at: ChildNode | null = node; at; at = flatParentOf(at)) {
      out.unshift(at);
    }
    return out;
  };
  const up = chain(a);
  const down = chain(b);
  let i = 0;
  while (i < up.length && i < down.length && up[i] === down[i]) i += 1;
  if (i === 0 || i === up.length || i === down.length) return false;
  const siblings = flatChildrenOf(up[i - 1] as Element);
  return siblings.indexOf(up[i]) < siblings.indexOf(down[i]);
}

/** A document's first element with an id: one walk of it, the first time
 *  an id is asked for (`ShapeCopies`). */
export function idIndex(root: Element): (id: string) => Element | null {
  let index: Map<string, Element> | null = null;
  return (id) => {
    if (!index) {
      index = new Map();
      const stack: ChildNode[] = [...root.children].reverse();
      for (let node = stack.pop(); node; node = stack.pop()) {
        if (!isElement(node)) continue;
        const own = node.attribs.id;
        if (own && !index.has(own)) index.set(own, node);
        const children = node.children;
        for (let i = children.length - 1; i >= 0; i -= 1) {
          stack.push(children[i]);
        }
      }
    }
    return index.get(id) ?? null;
  };
}

/**
 * How deep the box tree may go. Everything downstream of the builder — the
 * fix-up pass, layout, paint, the accessor walks — recurses on box depth, so
 * this is the one bound that keeps a degenerately nested document (fuzzer
 * output, a runaway template) from a stack overflow five phases later.
 * Blink's parser flattens at 512 for the same reason; content past the cap
 * is dropped, which beats the alternative of crashing the application.
 *
 * The parser keeps a document to 256 elements (`dom.ts`), so what reaches
 * this is the anonymous boxes a table builds round them, which the builder
 * counts as it goes (`wrappersAround`), since the fix-up makes them after
 * it. Counted as elements, a `display: table-cell` box in another was one
 * level where it is four boxes — a table, a row group, a row and the cell
 * — and every pass pays for a box: painting one takes some 800 bytes of
 * the stack. Two hundred and fifty cells deep, a thousand boxes, layout
 * and paint each ran out of the 984 KB V8 gives the main thread, and the
 * document came out blank. 512 boxes paint in under half of it, and are a
 * cell in a cell 128 deep.
 */
const MAX_DEPTH = 512;

/** The writing mode a box's content is laid out in: its own, but for a
 *  table's rows and row groups, to which `writing-mode` does not apply and
 *  whose cells are in the table's (CSS Writing Modes 4, 3.1). */
function flowModeAround(box: Box): ComputedStyle['writingMode'] {
  let at: Box | null = box;
  while (at && (at.kind === 'table-row' || at.kind === 'table-row-group')) {
    at = at.parent;
  }
  return (at ?? box).style.writingMode;
}

/** What of a `<foreignObject>`'s own style is the drawing's, and none of
 *  its box's (`foreignRootStyle`): where it is, its size, and what moves,
 *  fades, cuts or filters it, which the drawing does to it as it does to
 *  any of its elements — its `overflow` among them, which cuts what it
 *  holds to its rectangle where the drawing draws it (`ForeignObject`). */
const DRAWING_OWNS = [
  'position',
  'float',
  'transform',
  'translate',
  'rotate',
  'scale',
  'perspective',
  'opacity',
  'filter',
  'backdropFilter',
  'clipPath',
  'clip',
  'mask',
  'mixBlendMode',
  'isolation',
  'zIndex',
  'willChange',
  'overlay',
  'overflowX',
  'overflowY',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'widthKeyword',
  'minWidthKeyword',
  'maxWidthKeyword',
  'minHeightKeyword',
  'maxHeightKeyword',
  'heightKeyword',
  'widthSize',
  'heightSize',
  'top',
  'right',
  'bottom',
  'left',
] as const satisfies readonly (keyof ComputedStyle)[];

/**
 * The style of the box a `<foreignObject>`'s HTML is laid out in: the
 * object's, a block that is its initial containing block, with what the
 * drawing does to the object (`DRAWING_OWNS`) put back to the initial
 * values — the drawing has done it. Its background, its borders and its
 * padding are its box's, as a browser draws them.
 */
function foreignRootStyle(
  own: ComputedStyle,
  initial: ComputedStyle,
): ComputedStyle {
  const style = copyStyle(own);
  const to = style as unknown as Record<string, unknown>;
  const from = initial as unknown as Record<string, unknown>;
  for (const name of DRAWING_OWNS) to[name] = from[name];
  style.display = 'block';
  return style;
}

/** The sharing key the root box's children share under: one root style per
 *  build, and the shared styles last a build (`Cascade.beginSharing`). */
const ROOT_SHARE_KEY = 0;

class Builder {
  private _options: BuildOptions;
  /** The document text, in the pieces it was pushed in — joined once at the
   *  end, so that taking back a line's last space is not a copy of it. */
  private _chunks: string[] = [];
  private _length = 0;
  private _unselectable: number[] = [];
  private _textBoxes: Box[] = [];
  private _textNodes: TextSource[] = [];
  private _textStyles = new Set<ComputedStyle>();
  private _styles = new Map<
    Element,
    { style: ComputedStyle; inFlex: boolean }
  >();
  /** The last text box's style: runs of text share their parent's, so
   *  most text boxes repeat it and add nothing to `_textStyles`. */
  private _lastTextStyle: ComputedStyle | null = null;
  private _controls: Box[] = [];
  private _media: Box[] = [];
  private _embedded: Box[] = [];
  private _links: Box[] = [];
  private _focusables: Box[] = [];
  private _backgrounds: Box[] = [];
  private _contentImages: {
    url: string;
    element: Element;
    sized: boolean;
  }[] = [];
  private _awaiting: Box[] = [];
  private _images: Box[] = [];
  private _awaitingKind: Element[] = [];
  private _relative = false;
  private _tilted = false;
  /** The boxes in a vertical writing mode whose parents are in a
   *  horizontal one, which a frame is made in once the fix-up has run
   *  (`makeFrame`). */
  private _orthogonal: Box[] = [];
  private _readingFlow = false;
  private _anchors = false;
  private _negative = false;
  private _firstLine = false;
  private _nestedOutOfLine = false;
  private _movedInline = false;
  private _clipText = false;
  /** The CSS counters in scope, for `counter()` in generated content. */
  private _scopes = new CounterScopes();
  /** Whether anything built changed a counter or read one, or opened or
   *  closed a quote: what a subtree cannot be built apart from what is
   *  around it for (`runSubtree`). */
  private _counts = false;
  /** How many list items counted the `list-item` counter and did nothing
   *  else to a counter, their markers no number (`numberedMarker`): what a
   *  subtree build holds to the count of the subtree it replaces. */
  private _listItems = 0;
  /** How many quotes generated content has opened and not closed. */
  private _quoteDepth = 0;
  /** Whether a counter counts down (`BoxTree.reversed`). */
  private _reversed = false;
  /** Where the inline content being built stands, for collapsing white
   *  space across element boundaries. */
  private _ws: Collapse = 'start';
  /** Whether the word the inline content being built is in has had its
   *  first letter, for `text-transform: capitalize`: a word runs on across
   *  element boundaries, as white space collapses across them. */
  private _lettered = false;
  private _depth = 0;
  /** The `::first-letter` whose letter is still to come, for the block
   *  container whose first line has not begun. Null when there is none,
   *  and once anything but a letter begins that line. */
  private _firstLetter: LetterSearch | null = null;
  /** The `<foreignObject>`s built, by the object; null until one is. */
  private _foreign: Map<Element, ForeignObject> | null = null;
  /** What this build's drawings share (`BoxTree.shapeCopies`), the
   *  document's: a drawing in a `<foreignObject>` finds its `<use>`'s
   *  icon among the document's ids. */
  private _copies: ShapeCopies | null = null;

  constructor(options: BuildOptions, copies: ShapeCopies | null = null) {
    this._options = options;
    this._copies = copies;
  }

  run(root: Element): BoxTree {
    const cascade = this._options.cascade;
    // every build has one: a drawing may want its attributes' `var()`s
    // read where no rule reaches it (`Cascade.shapeStyles`), and the index
    // of ids is made only if a `<use>` asks it
    this._copies = new ShapeCopies(idIndex(root));
    cascade.beginSharing(this._options.kept ?? null);
    // the styles of an element's ancestors, which an `@container` rule
    // finds its container among: this build's as it goes, and the tree's
    // once it is the tree's
    const styles = this._styles;
    cascade.stylesOf = (el) => styles.get(el)?.style;
    cascade.pageColorScheme = metaColorScheme(root);
    const body = hasBody(root);
    const html = hasHtml(root);
    const { style: rootStyle, html: impliedHtml } = cascade.rootStyle(
      body,
      html,
    );
    const rootBox = new Box('block', null, rootStyle);
    // the root standing in for a `<body>` has its background clipped to
    // the document's text as the body's would be
    if (rootStyle.backgroundClipText) this._clipText = true;
    // a fragment's root stands in for a `<body>`, counters and all
    this._scopes.open();
    this._counterChanges(rootStyle, {
      node: root,
      style: rootStyle,
      key: ROOT_SHARE_KEY,
      parent: null,
    });
    // The DOM's `<html>`/`<body>` are ordinary elements with ordinary styles;
    // the box above them exists only to be the initial containing block, so
    // it carries no margins of its own and cannot collapse with anything.
    this._children(root, rootBox, rootStyle, false, null, ROOT_SHARE_KEY);
    this._endLine();
    // the initial containing block's direction is the root element's (CSS
    // 2.1 10.1), which puts an `<html>` narrower than it at its right end
    if (body && html) {
      const top = rootBox.children.find((b) => b.el && tagOf(b.el) === 'html');
      if (top) rootStyle.direction = top.style.direction;
    }
    cascade.endSharing();
    return this._finish(rootBox, rootStyle, {
      impliedHtml,
      impliedRoot: body && !html,
      paletteScheme: cascade.look.colorScheme,
      viewportOverflow: viewportOverflowOf(
        root,
        [impliedHtml, rootStyle],
        this._styles,
      ),
    });
  }

  /**
   * The tree of the HTML a `<foreignObject>` holds (`ForeignObject`), its
   * root the object, in `style` — the object's, as the cascade gave it
   * under the drawing's elements around it. Inside the document's build,
   * whose sharing it is styled under: what is in it is matched against the
   * document's rules, as the HTML around the drawing is.
   */
  runForeign(el: Element, style: ComputedStyle): BoxTree {
    const cascade = this._options.cascade;
    const styles = this._styles;
    const outer = cascade.stylesOf;
    // an `@container` rule finds its container among the object's own
    cascade.stylesOf = (at) => styles.get(at)?.style ?? outer?.(at);
    const rootBox = new Box('block', null, style);
    if (style.backgroundClipText) this._clipText = true;
    this._scopes.open();
    try {
      this._children(el, rootBox, style, false, el, cascade.freshShareKey());
      this._endLine();
    } finally {
      cascade.stylesOf = outer;
    }
    return this._finish(rootBox, style, {
      impliedHtml: null,
      impliedRoot: false,
      // drawn in the scheme of the drawing it is in, and on no canvas of
      // its own: it is transparent, as an `<iframe>`'s document is not
      paletteScheme: style.colorScheme,
      viewportOverflow: VIEWPORT_AUTO,
    });
  }

  /**
   * The boxes of one element a change reached, built as a build of the
   * whole document builds them where its box is (`buildSubtrees`): into a
   * box of its parent's kind and style, at the depth its box was at, with
   * the line before it ended and no counter or quote in scope — which is
   * how a block-level box in the flow starts, and how it leaves what comes
   * after it. Its text is numbered from 0, for the splice to move to where
   * its old box's was. Null where what it made is not one such box, or
   * counts, quotes, or holds what a build of the whole document finishes
   * across the tree: an orthogonal flow, a `<foreignObject>`.
   */
  runSubtree(
    el: Element,
    parent: Box,
    parentStyle: ComputedStyle,
    depth: number,
    anonymous: AnonymousStyle,
  ): SubtreeBuild | null {
    const cascade = this._options.cascade;
    const holder = new Box(parent.kind, null, parent.style);
    const inFlex =
      parentStyle.display === 'flex' || parentStyle.display === 'inline-flex';
    this._depth = depth;
    this._scopes.detach();
    this._scopes.open();
    // an `@container` rule finds its container among the subtree's styles
    // as this build makes them, and among the tree's above it
    const styles = this._styles;
    const outer = cascade.stylesOf;
    cascade.stylesOf = (at) => styles.get(at)?.style ?? outer?.(at);
    try {
      this._element(el, holder, parentStyle, inFlex, cascade.freshShareKey());
      this._endLine();
    } finally {
      cascade.stylesOf = outer;
    }
    const box = holder.children.length === 1 ? holder.children[0] : null;
    if (
      !box ||
      box.el !== el ||
      (box.kind !== 'block' && box.kind !== 'flex') ||
      !isBlockLevel(box) ||
      box.outOfFlow ||
      box.isFloat ||
      box.topLayer ||
      !this._apart()
    ) {
      return null;
    }
    box.parent = null;
    fixUp(box, anonymous);
    return this._subtree([box]);
  }

  /**
   * The boxes of what an element holds from its child at `from` on, and
   * its `::after` — or what the document holds, the root box's — built as
   * a build of the whole document builds them there (`buildSubtrees`): into
   * a box of the holder's kind and style, at the depth its children are
   * at, from where the block before them left the builder — its line ended,
   * no word begun (`_endLine`) — and with no counter or quote in scope,
   * fixed up as what follows a block in the holder's box is (`fixUp`). Its
   * text is numbered from 0, as `runSubtree`'s is. Null as there.
   */
  runTail(
    holder: Element | null,
    node: ParentNode,
    box: Box,
    from: number,
    depth: number,
    anonymous: AnonymousStyle,
    /** What came before among the holder's children (`ranBefore`), and
     *  whether it is wrapped. */
    ran: number,
    wrapped: boolean,
  ): SubtreeBuild | null {
    const cascade = this._options.cascade;
    const style = box.style;
    const into = new Box(box.kind, null, style);
    const inFlex = style.display === 'flex' || style.display === 'inline-flex';
    this._depth = depth;
    this._scopes.detach();
    this._scopes.open();
    const styles = this._styles;
    const outer = cascade.stylesOf;
    cascade.stylesOf = (at) => styles.get(at)?.style ?? outer?.(at);
    // styled under a parent no other element's key stands for, as a
    // subtree's root is
    const key = cascade.freshShareKey();
    try {
      const kids = node.children;
      for (let i = from; i < kids.length; i += 1) {
        const child = kids[i];
        if (isText(child)) {
          const start = this._length;
          this._textNode(child.data, into, style, holder);
          if (this._length > start) {
            this._textNodes.push({ node: child, start, end: this._length });
          }
          continue;
        }
        if (!isElement(child)) continue;
        this._element(child, into, style, inFlex, key);
      }
      if (holder) this._pseudo(holder, 'after', style, into);
      this._endLine();
    } finally {
      cascade.stylesOf = outer;
    }
    if (!this._apart()) return null;
    // Fixed up after a block, as the holder's children after the one before
    // them are: the runs among them wrapped where the holder holds anything
    // inline, before them or among them — and the floats and boxes out of
    // the flow before them wrapped as they were, or this is no tail.
    let inline = (ran & RAN_INLINE) !== 0;
    let out = (ran & RAN_OUT) !== 0;
    const ranFrom = { inline: null, out: null, wraps: false } as RanFrom & {
      wraps: boolean;
    };
    for (const child of into.children) {
      if (isBlockLevel(child) && !child.outOfFlow && !child.isFloat) {
        if (inline) ranFrom.inline ??= child;
        if (out) ranFrom.out ??= child;
      }
      if (child.outOfFlow || child.isFloat) out = true;
      if (!child.outOfFlow && !isBlockLevel(child)) {
        inline = true;
        ranFrom.wraps = true;
      }
    }
    if (ran & RAN_OUT && !(ran & RAN_INLINE) && inline !== wrapped) return null;
    // a block of the holder's, whose own display may be inline-block
    const before = new Box('block', null, anonymous(style, 'block'));
    before.parent = into;
    into.children.unshift(before);
    // and what is inline before the block, white space a whole build drops
    // where it wraps the rest
    if (ran & RAN_INLINE) {
      const held = new Box('text', null, style);
      held.text = '';
      held.parent = into;
      into.children.unshift(held);
    }
    fixUp(into, anonymous);
    if (into.children[0] !== before) return null;
    into.children.shift();
    const boxes = into.children;
    for (const child of boxes) child.parent = null;
    const built = this._subtree(boxes);
    built.ranFrom = ranFrom;
    return built;
  }

  /** Whether what was just built can be built apart from what is around it
   *  (`runSubtree`, `runTail`): it read no counter it did not make, and
   *  holds nothing a build of the whole finishes across the tree — an
   *  orthogonal flow, a `<foreignObject>`, a first line's style — nor a
   *  shadow tree's host (`holdsShadow`). */
  private _apart(): boolean {
    if (
      this._scopes.escapedRead ||
      this._orthogonal.length ||
      this._foreign ||
      this._firstLine
    ) {
      return false;
    }
    for (const at of this._styles.keys()) {
      if (shadowRootOf(at) !== null) return false;
    }
    return true;
  }

  /** What `runSubtree` or `runTail` made: `boxes` and what was found as
   *  they were built. */
  private _subtree(boxes: Box[]): SubtreeBuild {
    return {
      boxes,
      text: this._chunks.join(''),
      textBoxes: this._textBoxes,
      unselectable: this._unselectable,
      textNodes: this._textNodes,
      textStyles: this._textStyles,
      styles: this._styles,
      controls: this._controls,
      media: this._media,
      embedded: this._embedded,
      links: this._links,
      focusables: this._focusables,
      backgrounds: this._backgrounds,
      contentImages: this._contentImages,
      awaiting: this._awaiting,
      images: this._images,
      awaitingKind: this._awaitingKind,
      listItems: this._listItems,
      counts: this._counts,
      reversed: this._reversed,
      flags: {
        relative: this._relative,
        tilted: this._tilted,
        readingFlow: this._readingFlow,
        anchors: this._anchors,
        negative: this._negative,
        nestedOutOfLine: this._nestedOutOfLine,
        movedInline: this._movedInline,
        clipText: this._clipText,
      },
    };
  }

  /** The stylers a tree hands its paint, over this build's cascade and
   *  `styles` (`_finish`): made again for a tree a subtree build patched,
   *  whose cascade may be made again for sheets that only added rules. */
  stylersFor(
    styles: Map<Element, { style: ComputedStyle; inFlex: boolean }>,
    firstLine: boolean,
    copies: ShapeCopies,
  ): Pick<
    BoxTree,
    | 'firstLineStyler'
    | 'selectionStyler'
    | 'highlightStyler'
    | 'shapeStyler'
    | 'shapeCopies'
    | 'drawingUnits'
  > {
    const cascade = this._options.cascade;
    this._styles = styles;
    return {
      firstLineStyler: firstLine ? this._firstLineStyler() : null,
      selectionStyler: cascade.hasSelection ? this._selectionStyler() : null,
      highlightStyler: cascade.hasHighlights ? this._highlightStyler() : null,
      shapeStyler: this._shapeStyler(copies),
      shapeCopies: copies,
      drawingUnits: () => cascade.drawingUnits(),
    };
  }

  private _finish(
    rootBox: Box,
    rootStyle: ComputedStyle,
    root: Pick<
      BoxTree,
      'impliedHtml' | 'impliedRoot' | 'paletteScheme' | 'viewportOverflow'
    >,
  ): BoxTree {
    const cascade = this._options.cascade;
    const anonymous = anonymousStyles(cascade.initial);
    fixUp(rootBox, anonymous);
    for (const box of this._orthogonal) {
      makeFrame(box, anonymous(box.style, 'block'));
    }
    assignSubtreeRanges(rootBox);
    const copies = this._copies!;
    return {
      ...(cascade.readsContainers && { containers: containerBoxes(rootBox) }),
      ...(this._foreign && { foreign: this._foreign }),
      root: rootBox,
      anonymous,
      text: this._chunks.join(''),
      textBoxes: this._textBoxes,
      textNodes: this._textNodes,
      unselectable: this._unselectable,
      textStyles: this._textStyles,
      styles: this._styles,
      controls: this._controls,
      media: this._media,
      embedded: this._embedded,
      links: this._links,
      focusables: this._focusables,
      backgrounds: this._backgrounds,
      contentImages: this._contentImages,
      awaiting: this._awaiting,
      images: this._images,
      awaitingKind: this._awaitingKind,
      relative: this._relative || isRelative(rootStyle),
      tilted: this._tilted || outOfPlane(rootStyle),
      vertical: this._orthogonal.length > 0,
      readingFlow: this._readingFlow || rootStyle.readingFlow !== 'normal',
      anchors: this._anchors || rootStyle.anchorNames !== null,
      negative: this._negative,
      firstLine: this._firstLine,
      firstLineStyler: this._firstLine ? this._firstLineStyler() : null,
      selectionStyler: cascade.hasSelection ? this._selectionStyler() : null,
      highlightStyler: cascade.hasHighlights ? this._highlightStyler() : null,
      shapeStyler: this._shapeStyler(copies),
      shapeCopies: copies,
      drawingUnits: () => cascade.drawingUnits(),
      nestedOutOfLine: this._nestedOutOfLine,
      movedInline: this._movedInline,
      clipText: this._clipText,
      reversed: this._reversed,
      impliedHtml: root.impliedHtml,
      impliedRoot: root.impliedRoot,
      paletteScheme: root.paletteScheme,
      viewportOverflow: root.viewportOverflow,
    };
  }

  /** `BoxTree.selectionStyler`, over this build's cascade: an element's
   *  over its parent's, each once. A box with no element of its own — text,
   *  an anonymous box — is its nearest element's. */
  private _selectionStyler(): SelectionStyler {
    const cascade = this._options.cascade;
    const styles = this._styles;
    const known = new Map<Element, SelectionStyle | null>();
    const of = (el: Element): SelectionStyle | null => {
      let found = known.get(el);
      if (found !== undefined) return found;
      // the parser keeps a document to 256 elements deep (`dom.ts`)
      const parent = isElement(el.parent) ? of(el.parent) : null;
      const own = styles.get(el)?.style;
      found = own ? cascade.selectionStyle(el, own, parent) : parent;
      known.set(el, found);
      return found;
    };
    return (box) => {
      let at = box;
      while (at && !at.el) at = at.parent;
      return at?.el ? of(at.el) : null;
    };
  }

  /** `BoxTree.highlightStyler`, over this build's cascade: a styler for
   *  each name, made once, each element's over its parent's. */
  private _highlightStyler(): (name: string) => SelectionStyler {
    const cascade = this._options.cascade;
    const styles = this._styles;
    const byName = new Map<string, SelectionStyler>();
    // what each name's styler kept, while what a highlight's style reads
    // stands (`Cascade.highlightGeneration`)
    let generation = cascade.highlightGeneration;
    return (name) => {
      if (generation !== cascade.highlightGeneration) {
        generation = cascade.highlightGeneration;
        byName.clear();
      }
      let styler = byName.get(name);
      if (styler) return styler;
      const known = new Map<Element, SelectionStyle | null>();
      const of = (el: Element): SelectionStyle | null => {
        let found = known.get(el);
        if (found !== undefined) return found;
        const parent = isElement(el.parent) ? of(el.parent) : null;
        const own = styles.get(el)?.style;
        found = own ? cascade.highlightStyle(el, own, name, parent) : parent;
        known.set(el, found);
        return found;
      };
      styler = (box) => {
        let at = box;
        while (at && !at.el) at = at.parent;
        return at?.el ? of(at.el) : null;
      };
      byName.set(name, styler);
      return styler;
    };
  }

  /** `BoxTree.shapeStyler`, over this build's cascade: each drawing's
   *  once, from its box's style as it is when first asked. */
  private _shapeStyler(copies: ShapeCopies): ShapeStyler {
    const cascade = this._options.cascade;
    return (box) => {
      let shapes = SHAPE_STYLES.get(box);
      if (shapes === undefined) {
        shapes = box.el ? cascade.shapeStyles(box.el, box.style, copies) : null;
        SHAPE_STYLES.set(box, shapes);
      }
      return shapes;
    };
  }

  /** `BoxTree.firstLineStyler`, over this build's cascade. */
  private _firstLineStyler(): FirstLineStyler {
    const cascade = this._options.cascade;
    const styles = this._styles;
    return (box, parent) => {
      const up = box.parent?.style ?? box.style;
      const inherits = firstLineParent(up, parent);
      const el = box.kind === 'text' ? null : box.el;
      const own = el ? styles.get(el) : undefined;
      if (el && own && own.style === box.style) {
        return cascade.styleFor(el, inherits, own.inFlex);
      }
      // text, an anonymous box, a pseudo-element's: no rules of its own to
      // be asked again, so what it took from its parent it takes from the
      // parent's style on the line, and what it set it keeps
      const out = copyStyle(box.style);
      const to = out as unknown as Record<string, unknown>;
      const mine = box.style as unknown as Record<string, unknown>;
      const theirs = up as unknown as Record<string, unknown>;
      const line = inherits as unknown as Record<string, unknown>;
      for (const name of FIRST_LINE_INHERITED) {
        if (mine[name] === theirs[name]) to[name] = line[name];
      }
      return out;
    };
  }

  /** Build boxes for a parent's children into `into`: its children in
   *  the flat tree (`flatChildrenOf`) — a host's shadow tree, and in a
   *  slot what is assigned to it — styled from its style, as what is
   *  drawn inherits through the flat tree (CSS Scoping 1, 2.2). */
  private _children(
    node: Element | { children: unknown },
    into: Box,
    parentStyle: ComputedStyle,
    inFlex: boolean,
    owner: Element | null,
    parentKey: number,
  ): void {
    // CSS 2.1 17.2.1: a column group holds columns, and anything else in it
    // is not rendered
    const onlyColumns = parentStyle.display === 'table-column-group';
    // A `<details>` shows its first `<summary>` first, and all else it holds
    // in its `::details-content` after it (HTML 15.3.4), which the UA sheet
    // hides while it is shut (`_detailsContent`).
    const held =
      owner !== null && tagOf(owner) === 'details' ? ([] as ChildNode[]) : null;
    let summarised = false;
    for (const child of flatChildrenOf(node as Element)) {
      if (held) {
        if (summarised || !isElement(child) || tagOf(child) !== 'summary') {
          held.push(child);
          continue;
        }
        summarised = true;
      }
      if (isText(child)) {
        if (onlyColumns) continue;
        const start = this._length;
        this._textNode(child.data, into, parentStyle, owner);
        // where the line it ends takes back a space it ended on, `end`
        // is a unit past the text, which a lookup clamps
        if (this._length > start) {
          this._textNodes.push({ node: child, start, end: this._length });
        }
        continue;
      }
      if (!isElement(child)) continue;
      this._element(child, into, parentStyle, inFlex, parentKey, onlyColumns);
    }
    if (held?.length) this._detailsContent(owner!, held, into, parentStyle);
  }

  /**
   * A `<details>`'s `::details-content` (HTML 15.3.4, CSS Pseudo 4): a box
   * of its own `display` after the summary, holding all the element holds
   * but its summary, and inheriting from it. Shut, the UA sheet gives it
   * `content-visibility: hidden`, which keeps the box and makes none of
   * what is in it (`_element`'s `skips`) — so a page that makes it visible
   * while it shuts, as an accordion animating its height does, still has
   * its content to draw. It is its element's to the pointer and to its
   * images, as a `::before` is (`GENERATED_FROM`).
   */
  private _detailsContent(
    details: Element,
    held: ChildNode[],
    into: Box,
    detailsStyle: ComputedStyle,
  ): void {
    const cascade = this._options.cascade;
    const style = cascade.detailsContentStyleFor(details, detailsStyle);
    if (style.display === 'none') return;
    if (isRelative(style) || style.translate || style.transform) {
      this._relative = true;
    }
    if (outOfPlane(style)) this._tilted = true;
    if (isNegative(style)) this._negative = true;
    const box = new Box(boxKindFor(style.display), null, style);
    box.pseudo = 'details-content';
    into.append(box);
    GENERATED_FROM.set(box, details);
    if (namesImages(style)) this._backgrounds.push(box);
    placeInFlow(box, style, into);
    if (into.kind === 'inline' && (box.outOfFlow || box.isFloat)) {
      this._nestedOutOfLine = true;
    }
    const flow = flowOf(style, box);
    const around = this._ws;
    const aroundAt = this._length;
    const aroundWord = this._lettered;
    if (flow === 'block') this._endLine();
    if (flow !== 'inline') this._ws = 'start';
    const skips =
      style.contentVisibility === 'hidden' &&
      containmentApplies(box, CONTAIN_SIZE);
    if (!skips) {
      const inFlex =
        style.display === 'flex' || style.display === 'inline-flex';
      // what is in it is styled under its style, which no element's key
      // stands for
      const key = cascade.freshShareKey();
      for (const child of held) {
        if (isText(child)) {
          const start = this._length;
          this._textNode(child.data, box, style, details);
          if (this._length > start) {
            this._textNodes.push({ node: child, start, end: this._length });
          }
        } else if (isElement(child)) {
          this._element(child, box, style, inFlex, key);
        }
      }
    }
    if (flow !== 'inline') this._endLine();
    this._ws = after(flow, this._ws, around, this._length !== aroundAt);
    this._lettered = letteredAfterFlow(flow, this._lettered, aroundWord);
  }

  private _element(
    el: Element,
    into: Box,
    parentStyle: ComputedStyle,
    inFlex: boolean,
    parentKey: number,
    onlyColumns = false,
  ): void {
    const tag = tagOf(el);
    if (NON_RENDERED.has(tag) || inImpliedHead(el, tag)) return;

    // shared with every element that must compute the same style, which in
    // a long document is most of them (`Cascade.sharedStyleFor`)
    const { style, key } = this._options.cascade.sharedStyleFor(
      el,
      parentStyle,
      parentKey,
      inFlex,
    );
    this._styles.set(el, { style, inFlex });
    if (style.display === 'none') return;
    if (onlyColumns && style.display !== 'table-column') return;
    // what an element counts is in scope for it and what it holds, and for
    // what follows it where its parent has no such counter
    // (`CounterScopes`)
    this._scopes.open();
    // style containment keeps what the element's subtree does to counters
    // and quotes in it (CSS Containment 2, 3.4)
    const contains =
      (style.contain & CONTAIN_STYLE) !== 0 && style.display !== 'contents';
    const quoteDepth = this._quoteDepth;
    if (contains) this._scopes.contain();
    this._elementIn(el, tag, style, key, into, inFlex, {
      node: el,
      style,
      key,
      parent: { style: parentStyle, key: parentKey, inFlex },
    });
    if (contains) this._quoteDepth = quoteDepth;
    this._scopes.close();
  }

  private _elementIn(
    el: Element,
    tag: string,
    style: ComputedStyle,
    key: number,
    into: Box,
    inFlex: boolean,
    place: CounterPlace,
  ): void {
    if (style.display === 'contents') {
      // no box of its own (CSS Display 3, 2.5): its `::before`, its
      // children and its `::after` are its parent's, in its style — the
      // items of a flex row still, through a wrapper Tailwind's `contents`
      // takes out — and a replaced element, which has nothing to hand on,
      // is not rendered
      if (tag === 'br' || replacedKind(el, tag) !== 'none') return;
      this._counterChanges(style, place);
      this._pseudo(el, 'before', style, into);
      this._children(el, into, style, inFlex, el, key);
      this._pseudo(el, 'after', style, into);
      return;
    }
    if (isRelative(style)) {
      this._relative = true;
      if (style.display === 'inline' && isOffset(style)) {
        this._movedInline = true;
      }
    }
    // a translation is moved by the same pass
    if (style.translate || style.transform) this._relative = true;
    if (outOfPlane(style)) this._tilted = true;
    if (style.readingFlow !== 'normal') this._readingFlow = true;
    if (style.anchorNames !== null || mayAnchorImplicitly(style)) {
      this._anchors = true;
    }
    if (style.backgroundClipText) this._clipText = true;
    if (style.verticalAlign !== 'baseline' && style.display === 'inline') {
      this._movedInline = true;
    }
    if (isNegative(style)) this._negative = true;
    // before anything else of the element's, including its `::before`,
    // and for the element whatever box it makes (CSS 2.1 12.4)
    this._counterChanges(style, place);

    // `<br>` is a line break rather than a box, and it is the one element
    // whose *absence* of a box still has to reach the inline layout.
    if (tag === 'br') {
      this._endLine();
      // the first line ends with no letter on it (CSS 2.1 5.12.2)
      this._abandonLetter();
      if (style.clear !== 'none') {
        // a break that clears the floats — `<br clear="all">` after a
        // floated image — puts what follows it below them: an empty block
        // that clears them, which the inline content around it is broken
        // for (`breakInlines`), where a line break went on beside them
        const clearing = copyStyle(style);
        clearing.display = 'block';
        into.append(new Box('block', el, clearing));
        this._ws = 'start';
        return;
      }
      const box = new Box('break', el, style);
      into.append(box);
      this._push('\n', box);
      this._ws = 'start';
      return;
    }

    // what is under an element in the top layer: a box of its own before
    // the element's, as Blink lays one out
    if (style.overlay === 'auto') this._backdrop(el, style, into);

    // an `<object>` is its image once it has one, a frame where what it
    // names is a document, and its content until either; an `<embed>` its
    // image, and a `<video>` its poster, or a frame; an image button its
    // image, and a button saying what it is for until it has one, so it can
    // be pressed either way
    const replaced =
      tag === 'object'
        ? this._options.imageSize(el)
          ? 'image'
          : this._options.holdsDocument?.(el)
            ? 'frame'
            : 'none'
        : (tag === 'embed' || tag === 'video') && this._options.imageSize(el)
          ? 'image'
          : isImageButton(el, tag)
            ? this._options.imageSize(el)
              ? 'image'
              : 'button'
            : replacedKind(el, tag);
    if (
      replaced !== 'image' &&
      (tag === 'object' ||
        tag === 'embed' ||
        tag === 'video' ||
        isImageButton(el, tag)) &&
      imageUrlOf(el)
    ) {
      this._awaitingKind.push(el);
    }
    // An input button the page styled is drawn as the page has it, as a
    // `<button>` is: a box with its label in it, and not the palette's
    // widget, whose look and size would be the window's — a black pill
    // with white text was a framed white button half as wide again.
    const drawnButton =
      replaced === 'button' && style.styledControl && isInputButton(el);
    if (replaced !== 'none' && !drawnButton) {
      this._replaced(el, tag, replaced, style, into);
      return;
    }

    const kind = boxKindFor(style.display);
    // the box, and the anonymous boxes the fix-up will put round it
    const depth = 1 + wrappersAround(into.kind, kind, style);
    if (this._depth + depth > MAX_DEPTH) return;
    const box = new Box(kind, el, style);
    into.append(box);
    // a block container in a vertical writing mode in a horizontal one:
    // the root of an orthogonal flow (CSS Writing Modes 4, 7.3)
    if (
      style.writingMode !== 'horizontal-tb' &&
      (kind === 'table-cell' ||
        kind === 'table-caption' ||
        (kind === 'block' && !style.grid)) &&
      flowModeAround(into) === 'horizontal-tb'
    ) {
      this._orthogonal.push(box);
    }
    if (
      (kind === 'block' || kind === 'table-cell' || kind === 'table-caption') &&
      this._options.cascade.hasFirstLine
    ) {
      const firstLine = this._options.cascade.firstLineStyle(el, style);
      if (firstLine) {
        FIRST_LINE.set(box, firstLine);
        this._firstLine = true;
      }
    }
    if (namesImages(style)) this._backgrounds.push(box);
    placeInFlow(box, style, into);
    if (style.overlay === 'auto') box.topLayer = true;
    if (into.kind === 'inline' && (box.outOfFlow || box.isFloat))
      this._nestedOutOfLine = true;

    if (attr(el, 'href') && (tag === 'a' || tag === 'area'))
      this._links.push(box);
    if (focusableElement(el, tag)) this._focusables.push(box);

    // a column's content is not rendered at all (CSS 2.1 17.2.1)
    if (style.display === 'table-column') return;

    let insideMarker: string | null = null;
    let markerStyle: ComputedStyle | null = null;
    let ownMarker = false;
    let markerImage: { url: string; size: IntrinsicSize } | null = null;
    let insideImage: NonNullable<Marker['image']> | null = null;
    const listImage =
      style.display === 'list-item' ? urlOf(style.listStyleImage) : null;
    if (listImage !== null) {
      // asked for as generated content's images are, and the tree built
      // again when it arrives; until it has, and where it never does, the
      // item's marker is its `list-style-type`'s. One an `image-set()`
      // chose is its pixels over its density across.
      const url = listImage;
      const size = this._options.urlSize?.(url) ?? null;
      this._contentImages.push({ url, element: el, sized: !!size });
      if (size) {
        const density = densityOf(style.listStyleImage);
        markerImage = { url, size: atDensity(size, density) };
      }
    }
    if (style.display === 'list-item') {
      // the item's number, the `list-item` counter it has just counted
      const written = markerFor(
        style,
        this._listItemValue(style),
        this._options.cascade.counterStyles,
      );
      let text = written.text;
      let flush = written.flush;
      markerStyle = this._options.cascade.markerStyle(el, style);
      // a `::marker` with a `content` is set as that, as it is written —
      // its strings and its counters, where one of `none` is no marker
      const content = markerStyle?.content;
      if (content === 'none') text = '';
      else if (Array.isArray(content) && markerStyle) {
        text = this._generated(content, markerStyle, el)
          .filter((piece) => typeof piece === 'string')
          .join('');
        ownMarker = true;
        flush = true;
      } else if (style.listStyleType.startsWith('"')) {
        ownMarker = true;
        flush = true;
      }
      if (markerImage && !ownMarker) {
        const [width, height] = this._markerImageSize(
          markerImage.size,
          markerStyle ?? style,
        );
        const gap = MARKER_IMAGE_GAP * (this._options.scale ?? 1);
        const image = { url: markerImage.url, width, height, gap };
        if (style.listStylePosition === 'inside') insideImage = image;
        else {
          box.marker = {
            text: '',
            layout: null,
            x: 0,
            y: 0,
            style: markerStyle,
            image,
          };
        }
      } else if (text && style.listStylePosition === 'inside') {
        insideMarker = flush ? text : `${text} `;
      } else if (text) {
        box.marker = { text, layout: null, x: 0, y: 0, style: markerStyle };
        if (flush) box.marker.flush = true;
      }
    }
    const childInFlex =
      style.display === 'flex' || style.display === 'inline-flex';
    const flow = flowOf(style, box);
    const around = this._ws;
    const aroundAt = this._length;
    const aroundWord = this._lettered;
    if (flow === 'block') this._endLine();
    if (flow !== 'inline') this._ws = 'start';
    // A first letter is looked for in the first line of a block container,
    // down through its inline content and its first blocks. A float, a
    // positioned box and a flex container are no part of that line, and
    // an atomic inline is something other than a letter at its start
    // (CSS 2.1 5.12.2). A block container with rules of its own takes the
    // search over.
    const outerLetter = this._firstLetter;
    const skipped = flow === 'out' || flow === 'atomic' || kind === 'flex';
    if (skipped) this._firstLetter = null;
    // a block starts a line, and punctuation before it was on another
    else if (flow === 'block' && outerLetter) giveBack(outerLetter);
    const ownRules = hasFirstLetter(style.display)
      ? this._options.cascade.firstLetterRules(el)
      : null;
    const ownLetter = ownRules ? { rules: ownRules, punctuation: [] } : null;
    if (ownLetter) this._firstLetter = ownLetter;
    this._depth += depth;
    // `content-visibility: hidden` skips what the element holds, where size
    // containment applies to its box (CSS Containment 2, 4): its contents
    // are not drawn, and take no press, no focus and no part in the text
    // (4.1), so no box is made for any of them — no widget, no stop, no
    // link. Its own background, border and outline are drawn
    // (`paintContent`), and it is laid out as one that holds nothing, which
    // size containment says anyway. `hidden="until-found"` asks for it
    // (HTML 15.3.1), and a menu that keeps every panel it has not opened
    // that way, under a `display: block` of its own, drew all of them.
    const skips =
      style.contentVisibility === 'hidden' &&
      containmentApplies(box, CONTAIN_SIZE);
    if (drawnButton) {
      // its label, and none of what an element's content would be: an
      // `<input>` has no `::before` or `::after` and no children. One
      // with no label is a line tall all the same, as Chrome draws it.
      this._textNode(inputButtonLabel(el) || '\u200b', box, style, el);
    } else if (!skips) {
      if (insideImage) {
        // an inline image at the start of the first line, as a generated
        // image is, and the room after it Blink gives it rather than a
        // space: the content's own white space after it is kept, as it is
        // after an image (`MARKER_IMAGE_GAP`)
        const { url, gap } = insideImage;
        const image = this._contentImage(url, box, style, el, insideImage);
        if (style.direction === 'rtl') image.style.marginLeft = gap;
        else image.style.marginRight = gap;
      } else if (insideMarker) {
        this._insideMarker(insideMarker, style, markerStyle, box, el);
      }
      this._pseudo(el, 'before', style, box);
      this._children(el, box, style, childInFlex, el, key);
      this._pseudo(el, 'after', style, box);
      if (
        this._options.transition &&
        el.parent &&
        !el.parent.parent &&
        !(el.parent instanceof ShadowRoot)
      ) {
        this._viewTransition(el, box);
      }
    }
    this._depth -= depth;
    this._letterAfter(flow, skipped, outerLetter, ownLetter);
    if (flow !== 'inline') this._endLine();
    this._ws = after(flow, this._ws, around, this._length !== aroundAt);
    this._lettered = letteredAfterFlow(flow, this._lettered, aroundWord);
  }

  private _replaced(
    el: Element,
    tag: string,
    replaced: ReplacedKind,
    style: ComputedStyle,
    into: Box,
  ): void {
    const box = new Box('replaced', el, style);
    box.replaced = replaced;
    into.append(box);
    if (tag === 'video') this._media.push(box);
    else if (tag === 'iframe' || tag === 'canvas' || tag === 'embed') {
      this._embedded.push(box);
    }
    if (focusableElement(el, tag)) this._focusables.push(box);
    if (namesImages(style)) this._backgrounds.push(box);
    placeInFlow(box, style, into);
    if (style.overlay === 'auto') box.topLayer = true;
    if (into.kind === 'inline' && (box.outOfFlow || box.isFloat))
      this._nestedOutOfLine = true;
    const flow = flowOf(style, box);
    if (flow === 'block') this._endLine();
    this._ws = after(flow, this._ws, this._ws);
    this._lettered = letteredAfterFlow(flow, this._lettered, this._lettered);
    if (flow === 'atomic') this._abandonLetter();

    if (replaced === 'image') {
      // Both sources are CSS pixels — an image pixel is one, and so is an
      // attribute — and the box is device, and zoomed as its lengths are
      // (CSS Viewport 1, 5).
      const scale = (this._options.scale ?? 1) * style.effectiveZoom;
      this._images.push(box);
      const loaded = this._options.imageSize(el);
      if (loaded) {
        setIntrinsics(box, loaded, scale);
        if (this._options.sizePending?.(el)) this._awaiting.push(box);
      } else {
        // An image that has not arrived still needs a box, or the document
        // reflows under the reader when it does. The attributes are the
        // author telling us the size in advance — those of the `<source>`
        // its `<picture>` chose, where that has any (`dimensionSource`);
        // without them the box is a small placeholder rather than nothing.
        const sized = this._options.cascade.dimensionSource?.(el) ?? el;
        box.intrinsic = awaitedIntrinsics(sized, scale);
        this._awaiting.push(box);
      }
      // The alt text joins the document text, so a document read with the
      // images blocked still copies as prose.
      const alt = attr(el, 'alt');
      if (alt) this._push(alt, box);
      return;
    }

    if (replaced === 'hr') return;
    if (replaced === 'svg') {
      // its `em` is its own font size, in CSS pixels like the rest of it
      const scale = (this._options.scale ?? 1) * style.effectiveZoom;
      setIntrinsics(box, svgIntrinsics(el, style.fontSize / scale), scale);
      DRAWING_SCALE.set(box, scale);
      // and the HTML its `<foreignObject>`s hold, which most drawings have
      // none of, where `SvgView` hands an object over to be drawn
      const objects = inlineDrawing(el).foreignObjects();
      if (objects.length && drawsForeignObjects()) {
        this._foreignObjects(el, box, style, objects);
      }
      return;
    }
    if (replaced === 'frame') {
      const scale = (this._options.scale ?? 1) * style.effectiveZoom;
      if (tag === 'canvas') {
        // A canvas is the size of its bitmap, which its `width` and
        // `height` attributes give, 300 by 150 where they do not, and
        // keeps its proportions (HTML 4.12.5): no script draws in it, so it
        // is that box with nothing in it. Taken for an element with no box
        // of its own, it took no room, and one set a height kept no width.
        const width = canvasSize(el, 'width', 300);
        const height = canvasSize(el, 'height', 150);
        box.intrinsic = {
          width: width * scale,
          height: height * scale,
          missing: 0,
          ratio: width > 0 && height > 0 ? width / height : 0,
        };
        return;
      }
      // HTML's default object size, in CSS pixels; `width` and `height`
      // attributes reach the style as presentational hints and win
      box.intrinsic = {
        width: 300 * scale,
        height: 150 * scale,
        missing: 0,
        ratio: 0,
      };
      return;
    }

    const size = this._options.controlSize(el, replaced, style);
    box.intrinsic = {
      width: size.width,
      height: size.height,
      missing: 0,
      ratio: 0,
    };
    this._controls.push(box);
    const baseline = controlBaseline(el, replaced, style, this._options);
    if (baseline) CONTROL_BASELINES.set(box, baseline);
    // A control's value is the widget's, not the document's: putting it in
    // the selection index would make Ctrl+A copy the contents of every text
    // field, which no document viewer does.
  }

  /**
   * The HTML of a drawing's `<foreignObject>`s, each a tree of its own
   * (`ForeignObject`): styled through the drawing's elements from the
   * root's box down, as a browser inherits into it, and built by a builder
   * of its own, whose text, links and controls are its own. What the
   * document asks of a build for the images in it — the backgrounds, the
   * generated images, the faces its text is set in — is the document's
   * too, and an `<img>` built before its image was in builds the document
   * again when it is, since nothing lays an object out again in place.
   */
  private _foreignObjects(
    svg: Element,
    box: Box,
    svgStyle: ComputedStyle,
    objects: readonly Element[],
  ): void {
    const cascade = this._options.cascade;
    const known = new Map<Element, ComputedStyle>([[svg, svgStyle]]);
    // the parser keeps a document to 256 elements deep (`dom.ts`)
    const styleOf = (el: Element): ComputedStyle => {
      let style = known.get(el);
      if (style) return style;
      const parent = isElement(el.parent) ? styleOf(el.parent) : svgStyle;
      style = cascade.styleFor(el, parent, false);
      known.set(el, style);
      return style;
    };
    for (const el of objects) {
      let hidden = false;
      for (let at = el.parent; isElement(at) && at !== svg; at = at.parent) {
        if (styleOf(at).display === 'none') hidden = true;
      }
      if (hidden) continue;
      const parent = isElement(el.parent) ? styleOf(el.parent) : svgStyle;
      const own = cascade.styleFor(el, parent, false);
      if (own.display === 'none') continue;
      const sub = new Builder(this._options, this._copies);
      sub._depth = this._depth + 1;
      const tree = sub.runForeign(el, foreignRootStyle(own, cascade.initial));
      for (const style of tree.textStyles) this._textStyles.add(style);
      this._backgrounds.push(...tree.backgrounds);
      this._contentImages.push(...tree.contentImages);
      this._awaitingKind.push(...tree.awaitingKind);
      for (const at of tree.awaiting) if (at.el) this._awaitingKind.push(at.el);
      (this._foreign ??= new Map()).set(el, {
        svg: box,
        el,
        tree,
        clips: own.overflowX !== 'visible' || own.overflowY !== 'visible',
        scale: 0,
        width: 0,
        height: 0,
      });
    }
  }

  /**
   * The `::backdrop` of an element in the top layer (CSS Position 4, 3.2):
   * a box fixed to the viewport, all of it, before the element's box, in
   * the layer with it. It holds nothing — no `content` applies to it — and
   * is its element's to the pointer and to its images (`GENERATED_FROM`).
   */
  private _backdrop(el: Element, elementStyle: ComputedStyle, into: Box): void {
    const style = this._options.cascade.backdropStyleFor(el, elementStyle);
    if (style.display === 'none') return;
    if (style.translate || style.transform) this._relative = true;
    if (outOfPlane(style)) this._tilted = true;
    const box = new Box(boxKindFor(style.display), null, style);
    box.pseudo = 'backdrop';
    box.outOfFlow = true;
    box.topLayer = true;
    into.append(box);
    GENERATED_FROM.set(box, el);
    if (namesImages(style)) this._backgrounds.push(box);
    if (into.kind === 'inline') this._nestedOutOfLine = true;
  }

  /**
   * A view transition's tree, after all the root element holds (CSS View
   * Transitions 1, 3.4): `::view-transition` in the top layer, over
   * everything, and in it a group for each name, an image pair in that and
   * the old and the new image in the pair — each a box of the style the
   * transition gives it, and each image a replaced box of the size of the
   * element it shows (`TRANSITION_IMAGES`). Each is the root element's to
   * the pointer, as a pseudo-element is its element's (`GENERATED_FROM`).
   */
  private _viewTransition(el: Element, into: Box): void {
    const tree = this._options.transition?.(el, into.style);
    if (!tree || tree.style.display === 'none') return;
    const make = (style: ComputedStyle, parent: Box, key: string): Box => {
      if (style.translate || style.transform) this._relative = true;
      if (outOfPlane(style)) this._tilted = true;
      const box = new Box(boxKindFor(style.display), null, style);
      box.pseudo = 'view-transition';
      placeInFlow(box, style, parent);
      parent.append(box);
      GENERATED_FROM.set(box, el);
      TRANSITION_KEYS.set(box, key);
      if (namesImages(style)) this._backgrounds.push(box);
      return box;
    };
    // absolute against the snapshot containing block (CSS View Transitions
    // 1, 3.4), the viewport's whatever the scroll: laid out fixed
    const fixed =
      tree.style.position === 'absolute' ? copyStyle(tree.style) : null;
    if (fixed) fixed.position = 'fixed';
    const root = make(fixed ?? tree.style, into, 'view-transition');
    if (fixed) TRANSITION_STYLES.set(root, tree.style);
    root.topLayer = true;
    for (const g of tree.groups) {
      if (g.group.display === 'none') continue;
      const group = make(g.group, root, `view-transition-group(${g.name})`);
      if (g.pair.display === 'none') continue;
      const pair = make(g.pair, group, `view-transition-image-pair(${g.name})`);
      for (const which of ['old', 'new'] as const) {
        const image = g[which];
        if (!image || image.style.display === 'none') continue;
        const box = new Box('replaced', null, image.style);
        box.pseudo = 'view-transition';
        box.replaced = 'image';
        box.intrinsic = {
          width: image.width,
          height: image.height,
          missing: 0,
          ratio: image.height > 0 ? image.width / image.height : 0,
        };
        placeInFlow(box, image.style, pair);
        pair.append(box);
        GENERATED_FROM.set(box, el);
        TRANSITION_KEYS.set(box, `view-transition-${which}(${g.name})`);
        TRANSITION_IMAGES.set(box, { name: g.name, which });
      }
    }
  }

  /**
   * An element's `::before` or `::after`, when a rule gives it content: a
   * box of its own `display`, holding the text its `content` comes to, which
   * goes through the same white-space processing as the document's text.
   */
  private _pseudo(
    el: Element,
    which: 'before' | 'after',
    elementStyle: ComputedStyle,
    into: Box,
  ): void {
    const style = this._options.cascade.pseudoStyleFor(el, which, elementStyle);
    if (!style || style.display === 'none') return;
    if (isRelative(style)) {
      this._relative = true;
      if (style.display === 'inline' && isOffset(style)) {
        this._movedInline = true;
      }
    }
    // a translation is moved by the same pass
    if (style.translate || style.transform) this._relative = true;
    if (outOfPlane(style)) this._tilted = true;
    // a `::before` or an `::after` is an anchor as its element is, and is
    // anchored to its element as its implicit anchor
    if (style.anchorNames !== null || mayAnchorImplicitly(style)) {
      this._anchors = true;
    }
    if (style.backgroundClipText) this._clipText = true;
    if (style.verticalAlign !== 'baseline' && style.display === 'inline') {
      this._movedInline = true;
    }
    if (isNegative(style)) this._negative = true;
    // a column renders no content, and generated content is all it would
    // hold; in a column group it is not a column either (CSS 2.1 17.2.1)
    if (
      style.display === 'table-column' ||
      style.display === 'table-column-group' ||
      elementStyle.display === 'table-column-group'
    ) {
      return;
    }
    // a scope of its own, which what it counts is in where its element has
    // the counter already (`CounterScopes`)
    this._scopes.open();
    this._counterChanges(style, null);
    const box = new Box(boxKindFor(style.display), null, style);
    box.pseudo = which;
    into.append(box);
    // its images are its element's to ask for: a `::after` with no content
    // but a background, which designs hang a picture on, drew nothing
    GENERATED_FROM.set(box, el);
    GENERATED_ON.add(el);
    if (namesImages(style)) this._backgrounds.push(box);
    // a list item it generates has a marker as an element's has, of the
    // `list-item` counter it has just counted (CSS 2.1 12.5): outside it,
    // or at the start of its content
    const written =
      style.display === 'list-item'
        ? markerFor(
            style,
            this._listItemValue(style),
            this._options.cascade.counterStyles,
          )
        : null;
    let marker = written?.text ?? '';
    if (marker && style.listStylePosition !== 'inside') {
      box.marker = { text: marker, layout: null, x: 0, y: 0, style: null };
      if (written?.flush) box.marker.flush = true;
      marker = '';
    }
    placeInFlow(box, style, into);
    if (into.kind === 'inline' && (box.outOfFlow || box.isFloat))
      this._nestedOutOfLine = true;
    const pieces = this._generated(style.content as ContentItem[], style, el);
    if (marker) pieces.unshift(written?.flush ? marker : `${marker} `);
    this._scopes.close();
    const flow = flowOf(style, box);
    const around = this._ws;
    const aroundAt = this._length;
    const aroundWord = this._lettered;
    if (flow === 'block') this._endLine();
    if (flow !== 'inline') this._ws = 'start';
    // the first letter can be generated, and is looked for here as in an
    // element of the same display
    const outerLetter = this._firstLetter;
    const skipped = flow === 'out' || flow === 'atomic';
    if (skipped) this._firstLetter = null;
    else if (flow === 'block' && outerLetter) giveBack(outerLetter);
    for (const piece of pieces) {
      if (typeof piece === 'string') this._textNode(piece, box, style, el);
      else {
        this._contentImage(piece.url, box, style, el, undefined, piece.density);
      }
    }
    this._letterAfter(flow, skipped, outerLetter, null);
    if (flow !== 'inline') this._endLine();
    this._ws = after(flow, this._ws, around, this._length !== aroundAt);
    this._lettered = letteredAfterFlow(flow, this._lettered, aroundWord);
  }

  /**
   * An `inside` list marker: an inline box at the start of the item, the
   * marker and a space, which takes its room on the first line as a
   * `::marker` does (CSS Lists 3, 3.1), where a marker set beside the line
   * was drawn over its first letters — every `list-style-position: inside`
   * list, and every `<summary>`. It inherits the item's text style and has
   * none of its box.
   */
  private _insideMarker(
    text: string,
    itemStyle: ComputedStyle,
    markerStyle: ComputedStyle | null,
    into: Box,
    el: Element,
  ): void {
    const style = inherit(
      markerStyle ?? itemStyle,
      this._options.cascade.initial,
    );
    style.display = 'inline';
    // a marker's direction is its own, whatever the text after it, unless
    // its rules say otherwise (the HTML style sheet's `::marker`)
    style.unicodeBidi = markerStyle?.unicodeBidi ?? 'isolate';
    const box = new Box('inline', null, style);
    box.pseudo = 'before';
    into.append(box);
    this._textNode(text, box, style, el);
  }

  /**
   * `counter-reset`, then `counter-increment`, then `counter-set`, as CSS
   * Lists 3 orders them (4.2). A list item counts `list-item` besides,
   * unless its `counter-increment` names it: one up, or one down in a list
   * that counts down. `place` is where an element is, for a reversed
   * counter to be counted from; a pseudo-element has none.
   */
  /** The number a list item's marker shows: the `list-item` counter it
   *  has just counted, read only where its marker is a number — a symbol's
   *  reads none, so a build apart need not know it (`CounterScopes`). */
  private _listItemValue(style: ComputedStyle): number {
    return numberedMarker(style) ? this._scopes.value('list-item') : 0;
  }

  private _counterChanges(
    style: ComputedStyle,
    place: CounterPlace | null,
  ): void {
    const resets = style.counterReset;
    const increments = style.counterIncrement;
    const sets = style.counterSet;
    const listItem = style.display === 'list-item';
    if (!resets && !increments && !sets && !listItem) return;
    // a list item that counts and numbers nothing: what follows it is
    // numbered as before wherever as many of them are where it was
    if (!resets && !increments && !sets && !numberedMarker(style)) {
      this._listItems += 1;
    } else this._counts = true;
    if (resets) {
      for (let i = 0; i < resets.length; i += 1) {
        const change = resets[i];
        // a name reset twice is reset by the last
        if (resets.some((c, j) => j > i && c.name === change.name)) continue;
        // a counter that counts down from what its scope adds up to reads
        // all of that scope, and is read by every item before the end of it
        if (change.counted || change.reversed) {
          this._reversed = true;
          this._scopes.escape();
        }
        const value = change.counted
          ? this._countedStart(change.name, style, place)
          : change.value;
        this._scopes.reset(change.name, value, !!change.reversed);
      }
    }
    let counted = false;
    for (const { name, value } of increments ?? []) {
      this._scopes.increment(name, value);
      if (name === 'list-item') counted = true;
    }
    if (listItem && !counted) {
      this._scopes.increment(
        'list-item',
        this._scopes.reversed('list-item') ? -1 : 1,
      );
    }
    for (const { name, value } of sets ?? []) this._scopes.set(name, value);
  }

  /**
   * Where a reversed counter written with no number starts (CSS Lists 3,
   * 4.4.2): minus what the elements and pseudo-elements in its scope add to
   * it, as far as the first that sets it, and what that sets it to, and as
   * much again as the last of them that counted took away — 1 for a list
   * item. `<ol reversed>`'s items count down to 1, and to an item's
   * `value` before it. The scope is walked ahead of the builder, from the styles it will
   * find shared when it gets there (`Cascade.sharedStyleFor`), and only for
   * such a counter.
   */
  private _countedStart(
    name: string,
    style: ComputedStyle,
    place: CounterPlace | null,
  ): number {
    const cascade = this._options.cascade;
    /** What each element and pseudo-element in the scope does to the
     *  counter, in document order: what it adds, and what it sets it to. */
    const steps: { by: number; set: number | null }[] = [];
    const note = (st: ComputedStyle): void => {
      let by = 0;
      let increments = false;
      for (const change of st.counterIncrement ?? []) {
        if (change.name !== name) continue;
        by += change.value;
        increments = true;
      }
      if (!increments && name === 'list-item' && st.display === 'list-item') {
        by = -1;
        increments = true;
      }
      let set: number | null = null;
      for (const change of st.counterSet ?? []) {
        if (change.name === name) set = change.value;
      }
      if (increments || set !== null) steps.push({ by, set });
    };
    const resets = (st: ComputedStyle): boolean =>
      st.counterReset?.some((change) => change.name === name) ?? false;
    const pseudo = (
      el: Element,
      which: 'before' | 'after',
      st: ComputedStyle,
    ): void => {
      const own = cascade.pseudoStyleFor(el, which, st);
      if (own && own.display !== 'none' && !resets(own)) note(own);
    };
    /** The elements from `from` on of a parent, and what is in them: a
     *  reset of the counter in one is a counter of its own, and a later
     *  sibling's reset at the scope's own level ends it (`stopAtReset`). */
    const walk = (
      children: readonly ChildNode[],
      from: number,
      parentStyle: ComputedStyle,
      parentKey: number,
      inFlex: boolean,
      stopAtReset: boolean,
    ): void => {
      for (let i = from; i < children.length; i += 1) {
        const child = children[i];
        if (!isElement(child)) continue;
        const tag = tagOf(child);
        if (NON_RENDERED.has(tag) || inImpliedHead(child, tag)) continue;
        const shared = cascade.sharedStyleFor(
          child,
          parentStyle,
          parentKey,
          inFlex,
        );
        const st = shared.style;
        if (st.display === 'none') continue;
        if (resets(st)) {
          if (stopAtReset) return;
          continue;
        }
        note(st);
        inside(child, st, shared.key);
      }
    };
    const inside = (el: Element, st: ComputedStyle, key: number): void => {
      pseudo(el, 'before', st);
      walk(
        flatChildrenOf(el),
        0,
        st,
        key,
        st.display === 'flex' || st.display === 'inline-flex',
        false,
      );
      pseudo(el, 'after', st);
    };

    // the element that resets it counts in it too, after the reset
    note(style);
    if (place) {
      const siblings = this._scopes.reachesSiblings(name);
      inside(place.node, place.style, place.key);
      const parent = place.parent;
      const node = place.node as Element & { parent?: Element | null };
      if (siblings && parent && node.parent) {
        const children = flatChildrenOf(flatParentOf(node) ?? node.parent);
        walk(
          children,
          children.indexOf(node) + 1,
          parent.style,
          parent.key,
          parent.inFlex,
          true,
        );
      }
    }
    let num = 0;
    let last = 0;
    for (const { by, set } of steps) {
      if (by !== 0) last = -by;
      if (set !== null) {
        num += set;
        break;
      }
      num -= by;
    }
    return num + last;
  }

  /** A counter's value in a style the document can name, as `counter()`
   *  writes it; `none` writes nothing. */
  private _counterText(n: number, name: string, style: ComputedStyle): string {
    if (name === 'none') return '';
    return this._options.cascade.counterStyles.text(
      n,
      name,
      style.direction === 'rtl',
    );
  }

  /** What `content` comes to here, in document order: its text, broken
   *  where it names an image. The quotes it opens and closes count for
   *  everything after it. */
  private _generated(
    items: ContentItem[],
    style: ComputedStyle,
    el: Element,
  ): (string | { url: string; density: number })[] {
    const pieces: (string | { url: string; density: number })[] = [];
    let text = '';
    for (const item of items) {
      switch (item.kind) {
        case 'string':
          text += item.text;
          break;
        case 'url':
          if (text) pieces.push(text);
          text = '';
          pieces.push({ url: item.url, density: item.density ?? 1 });
          break;
        case 'attr':
          text += attr(el, item.name) ?? '';
          break;
        case 'counter':
          this._counts = true;
          text += this._counterText(
            this._scopes.value(item.name),
            item.style,
            style,
          );
          break;
        case 'counters':
          this._counts = true;
          text += this._scopes
            .values(item.name)
            .map((v) => this._counterText(v, item.style, style))
            .join(item.separator);
          break;
        case 'open-quote':
          this._counts = true;
          // the depth the quotes around it left, which a build apart has not
          this._scopes.escape();
          text += quoteAt(style.quotes, this._quoteDepth, 0, languageOf(el));
          this._quoteDepth += 1;
          break;
        case 'close-quote':
          this._counts = true;
          // the depth the quotes around it left, which a build apart has not
          this._scopes.escape();
          // a close with nothing open writes nothing and closes nothing
          if (this._quoteDepth > 0) {
            this._quoteDepth -= 1;
            text += quoteAt(style.quotes, this._quoteDepth, 1, languageOf(el));
          }
          break;
        case 'no-open-quote':
          this._counts = true;
          // the depth the quotes around it left, which a build apart has not
          this._scopes.escape();
          this._quoteDepth += 1;
          break;
        case 'no-close-quote':
          this._counts = true;
          // the depth the quotes around it left, which a build apart has not
          this._scopes.escape();
          if (this._quoteDepth > 0) this._quoteDepth -= 1;
          break;
      }
    }
    if (text) pieces.push(text);
    return pieces;
  }

  /**
   * An image generated content names: an inline replaced box in the
   * pseudo-element, of the style it inherits and no other (CSS 2.1 12.2),
   * the image's size once the host has it and none before. An image that
   * never arrives takes no room, as no image does.
   */
  private _contentImage(
    url: string,
    into: Box,
    style: ComputedStyle,
    owner: Element,
    /** Its size where it is a list marker's, which has one whatever the
     *  image says (`_markerImageSize`). */
    marker?: { width: number; height: number },
    /** Its pixel density, where an `image-set()` chose it: a `2x` image is
     *  half its pixels across. */
    density = 1,
  ): Box {
    const box = new Box('replaced', null, {
      ...inherit(style, this._options.cascade.initial),
      display: 'inline',
    });
    box.replaced = 'image';
    into.append(box);
    CONTENT_IMAGES.set(box, url);
    const size = this._options.urlSize?.(url) ?? null;
    this._contentImages.push({ url, element: owner, sized: !!size });
    if (marker) {
      const { width, height } = marker;
      const ratio = width > 0 && height > 0 ? width / height : 0;
      box.intrinsic = { width, height, missing: 0, ratio };
    } else if (size) {
      setIntrinsics(
        box,
        atDensity(size, density),
        (this._options.scale ?? 1) * style.effectiveZoom,
      );
    } else box.intrinsic = { width: 0, height: 0, missing: 0, ratio: 0 };
    this._ws = after('atomic', this._ws, this._ws);
    this._lettered = false;
    this._abandonLetter();
    return box;
  }

  /**
   * A list marker image's size, in device pixels: its own where it has one,
   * and where it lacks some — an SVG with only a `viewBox`, or with no size
   * and no ratio — CSS Images' default sizing in a square half its face's
   * ascent across. CSS Lists 3 (3.3) makes the square 1em, which both
   * engines find too large (w3c/csswg-drafts#4207): Blink's is half the
   * ascent, rounded to a whole pixel first
   * (`LayoutListMarkerImage::DefaultSize`), Gecko's 0.4em, and this is
   * Blink's. A `viewBox` alone came to 0 by 0 and drew no marker at all,
   * and inside the item to the 300 by 150 a generated image defaults to.
   */
  private _markerImageSize(
    size: IntrinsicSize,
    style: ComputedStyle,
  ): [number, number] {
    let side = 0;
    // CoreText reads a size of 0 as its default twelve points
    if ((size.width === null || size.height === null) && style.fontSize > 0) {
      const ascent = this._options.faceAscent?.(style) ?? style.fontSize * 0.8;
      side = Math.round(ascent) / 2;
    }
    return concreteSize(size, side, side, this._options.scale ?? 1);
  }

  /** A text node, whitespace-processed per the inherited `white-space`. */
  private _textNode(
    data: string,
    into: Box,
    style: ComputedStyle,
    owner: Element | null,
  ): void {
    // text set at no size draws nothing and takes no room, so it needs no
    // box — and it is no part of the white space around it either
    if (!(style.fontSize > 0)) return;
    // a word does not run on over the start of a line
    if (this._ws === 'start') this._lettered = false;
    const ws = style.whiteSpace;
    let text: string;
    if (ws === 'pre' || ws === 'pre-wrap') {
      text = data;
      if (!text) return;
      // preserved spaces do not collapse with the ones after them
      this._ws = text.endsWith('\n') ? 'start' : 'content';
    } else {
      text =
        ws === 'pre-line'
          ? data.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n')
          : COLLAPSIBLE.test(data)
            ? data.replace(/[\t\n\r\f ]+/g, ' ')
            : data;
      // A space at the start of a line goes, and so does one after another
      // space, across element boundaries (CSS 2.1 16.6.1): `<p>\n  Hi` has
      // no space before the H, and `Hi <b> there</b>` has one between.
      if (text.charCodeAt(0) === 32 && this._ws !== 'content') {
        text = text.slice(1);
      }
      if (!text) return;
      const last = text.charCodeAt(text.length - 1);
      this._ws = last === 32 ? 'space' : last === 10 ? 'start' : 'content';
    }
    text = transformText(text, style.textTransform, this._lettered);
    this._lettered = letteredAfter(text, this._lettered);
    const search = this._firstLetter;
    const letter = search ? FIRST_LETTER.exec(text) : null;
    if (!search || !letter) {
      const punctuation = search ? PUNCTUATION_ONLY.exec(text) : null;
      if (!search || !punctuation) {
        this._textBox(text, into, style, owner);
        return;
      }
      // punctuation the letter comes after, in a text of its own —
      // `<q>`'s open quote — takes the letter's style, and gives it back
      // if no letter follows on the line
      const start = punctuation[1].length;
      if (start > 0) this._textBox(text.slice(0, start), into, style, owner);
      search.punctuation.push(
        this._letterBox(search, text.slice(start), into, style, owner),
      );
      return;
    }
    // The first letter, with the punctuation around it, in a box of its
    // own inside the box it was found in, and so inheriting from that
    // (CSS 2.1 5.12.2): `<p><b>T</b>his` has a bold first letter.
    this._firstLetter = null;
    const start = letter[1].length;
    const end = letter[0].length;
    if (start > 0) this._textBox(text.slice(0, start), into, style, owner);
    this._letterBox(search, text.slice(start, end), into, style, owner);
    if (end < text.length) {
      this._textBox(text.slice(end), into, style, owner);
    }
  }

  /** A box of the first letter's style around `text`, in `into`. */
  private _letterBox(
    search: LetterSearch,
    text: string,
    into: Box,
    style: ComputedStyle,
    owner: Element | null,
  ): { box: Box; text: Box; style: ComputedStyle } {
    const cascade = this._options.cascade;
    const letterStyle = cascade.firstLetterStyle(search.rules, style);
    const box = new Box(boxKindFor(letterStyle.display), null, letterStyle);
    box.pseudo = 'first-letter';
    if (owner) {
      GENERATED_FROM.set(box, owner);
      if (namesImages(letterStyle)) this._backgrounds.push(box);
    }
    if (letterStyle.float !== 'none') {
      box.isFloat = true;
      if (into.kind === 'inline') this._nestedOutOfLine = true;
    }
    into.append(box);
    if (letterStyle.textTransform !== style.textTransform) {
      text = transformText(text, letterStyle.textTransform);
    }
    return { box, text: this._textBox(text, box, letterStyle, owner), style };
  }

  /**
   * Where the search for a first letter stands after a box. A box that was
   * no part of the line — a float, a positioned box — leaves it where it
   * was, and one that was something other than a letter on it ends it. A
   * block that looked for a letter of its own and found its first line
   * ended its parent's too, and one that found no line leaves the parent
   * looking. A block ends the line it is on.
   */
  private _letterAfter(
    flow: 'inline' | 'atomic' | 'block' | 'out',
    skipped: boolean,
    outer: LetterSearch | null,
    own: LetterSearch | null,
  ): void {
    const lined = own !== null && this._firstLetter !== own;
    if (own && !lined) this._abandonLetter();
    if (skipped || own) this._firstLetter = skipped || !lined ? outer : null;
    if (lined && !skipped && outer) giveBack(outer);
    if (flow === 'atomic') this._abandonLetter();
    else if (flow === 'block' && this._firstLetter) giveBack(this._firstLetter);
  }

  /** The first line ended, or began with something other than a letter:
   *  there is no first letter, and punctuation that took its style gives
   *  it back. */
  private _abandonLetter(): void {
    const search = this._firstLetter;
    this._firstLetter = null;
    if (search) giveBack(search);
  }

  private _textBox(
    text: string,
    into: Box,
    style: ComputedStyle,
    owner: Element | null,
  ): Box {
    // The owning element rides on the text box, and from there onto the
    // `TextRun`: hit testing inside a paragraph has no rectangle to test —
    // an inline box is the runs on its lines — so the run is what has to
    // know whose text it is.
    const box = new Box('text', owner, style);
    box.text = text;
    into.append(box);
    this._push(text, box);
    return box;
  }

  /**
   * A line ends here — a block's inline content is over, or a `<br>` or a
   * block interrupts it — and a collapsible space it ends on goes (CSS 2.1
   * 16.6.1). Content standing on a space means that space was the last
   * thing pushed, so taking it back is a character off the last chunk; a
   * text box it empties goes with it.
   */
  private _endLine(): void {
    if (this._ws === 'held') this._ws = 'start';
    if (this._ws !== 'space') return;
    this._ws = 'start';
    const box = this._textBoxes[this._textBoxes.length - 1];
    if (!box || box.textEnd !== this._length || !box.text.endsWith(' ')) {
      return;
    }
    box.text = box.text.slice(0, -1);
    box.textEnd -= 1;
    this._length -= 1;
    const ranges = this._unselectable;
    const n = ranges.length;
    if (n && ranges[n - 1] > this._length) {
      ranges[n - 1] = this._length;
      if (ranges[n - 2] >= this._length) ranges.length = n - 2;
    }
    const last = this._chunks.length - 1;
    this._chunks[last] = this._chunks[last].slice(0, -1);
    if (!box.text) {
      this._textBoxes.pop();
      const siblings = box.parent?.children;
      const at = siblings ? siblings.lastIndexOf(box) : -1;
      if (at >= 0) siblings!.splice(at, 1);
    }
  }

  /** Give a box its slice of the document text index. */
  private _push(text: string, box: Box): void {
    box.textStart = this._length;
    this._chunks.push(text);
    this._length += text.length;
    box.textEnd = this._length;
    if (box.style.userSelect === 'none' && text) {
      const ranges = this._unselectable;
      if (ranges[ranges.length - 1] === box.textStart) {
        ranges[ranges.length - 1] = box.textEnd;
      } else ranges.push(box.textStart, box.textEnd);
    }
    if (box.kind === 'text') {
      this._textBoxes.push(box);
      if (box.style !== this._lastTextStyle) {
        this._lastTextStyle = box.style;
        this._textStyles.add(box.style);
      }
    }
  }
}

/**
 * The CSS counters in scope as the builder walks the document (CSS Lists 3,
 * 4.5). Every element and pseudo-element opens a level, which closes after
 * what it holds. A `counter-reset` makes an instance that reaches the
 * element's descendants and — where its parent has no counter of the name
 * — its later siblings too, so that instance belongs to the level the
 * element is on, its parent's, and goes when that closes; a later sibling's
 * reset takes its place. Where its parent has one, the new instance nests
 * in it and reaches the element's descendants alone, on the element's own
 * level: a list in a list item, a counter reset in a `::before`. `counter()`
 * reads the innermost instance and `counters()` all of them, outermost
 * first. A counter used where none is in scope is reset to 0 there, as
 * though the element had asked.
 */
class CounterScopes {
  /** Per name, its instances, outermost first: the level each goes with,
   *  whether it is the own one of the element that level is, and whether it
   *  counts down. */
  private _instances = new Map<string, CounterInstance[]>();
  /** The names each open level made an instance of, so closing it drops
   *  exactly those: null for a level that made none, which is nearly every
   *  one, so that opening an element allocates nothing. */
  private _made: (string[] | null)[] = [null];
  /** The levels of the open elements with style containment, innermost
   *  last: below one, a counter made further out is not counted on. */
  private _contained: number[] = [];
  /**
   * A subtree's build, apart from the document around it (`runSubtree`,
   * `runTail`), knows none of the counters in scope where it starts. So it
   * notes where what it does would have met one of them in a build of the
   * whole document: a read of a counter none of its own elements made, or
   * of one whose reach a counter outside could have changed
   * (`CounterInstance.uncertain`) from past the element that made it
   * (`escapedRead`), which it cannot be built apart for; and a change to
   * one of those (`escapedWrite`), which it can where nothing after it
   * reads a counter (`buildSubtrees`). Null in a build of the whole.
   */
  private _detached: { escapedRead: boolean; escapedWrite: boolean } | null =
    null;
  /** Each open level's id, for an instance to say whether the element that
   *  made it is still open (`CounterInstance.owner`). */
  private _ids: number[] = [0];
  private _nextId = 1;

  /** Count apart from the document around (`_detached`). */
  detach(): void {
    this._detached = { escapedRead: false, escapedWrite: false };
  }

  get escapedRead(): boolean {
    return this._detached?.escapedRead ?? false;
  }

  get escapedWrite(): boolean {
    return this._detached?.escapedWrite ?? false;
  }

  /** A read of a counter, or of a quote's depth, that a build apart cannot
   *  answer as the whole document's would. */
  escape(): void {
    if (this._detached) this._detached.escapedRead = true;
  }

  open(): void {
    this._made.push(null);
    if (this._detached) this._ids.push(this._nextId++);
  }

  close(): void {
    const level = this._made.length - 1;
    if (this._detached) this._ids.pop();
    const made = this._made.pop();
    if (made) {
      for (const name of made) {
        const stack = this._instances.get(name);
        if (stack && stack[stack.length - 1]?.level === level) stack.pop();
      }
    }
    const contained = this._contained;
    if (contained[contained.length - 1] === level) contained.pop();
  }

  /** The element whose level is open has style containment. */
  contain(): void {
    this._contained.push(this._made.length - 1);
  }

  /** Whether the parent of the element whose level is open has a counter
   *  of this name: its own, or one from further out — not one a sibling
   *  before the element made. */
  private _parentHas(name: string): boolean {
    const stack = this._instances.get(name);
    if (!stack?.length) return false;
    const parent = this._made.length - 2;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const instance = stack[i];
      if (instance.level < parent) return true;
      if (instance.level === parent && instance.own) return true;
    }
    return false;
  }

  /** Whether a reset of `name` here reaches the element's later siblings,
   *  or its descendants alone. */
  reachesSiblings(name: string): boolean {
    return this._made.length < 2 || !this._parentHas(name);
  }

  reset(name: string, value: number, reversed: boolean): void {
    const own = !this.reachesSiblings(name);
    const level = own ? this._made.length - 1 : this._made.length - 2;
    let stack = this._instances.get(name);
    if (!stack) {
      stack = [];
      this._instances.set(name, stack);
    }
    const top = stack[stack.length - 1];
    if (top?.level === level && top.own === own) {
      top.value = value;
      top.reversed = reversed;
      if (this._detached) this._own(top, own);
      return;
    }
    const instance: CounterInstance = { level, own, value, reversed };
    if (this._detached) this._own(instance, own);
    stack.push(instance);
    (this._made[level] ??= []).push(name);
  }

  /** An instance a reset here makes, or takes over, in a build apart: the
   *  element that made it, and whether a counter outside could have made it
   *  reach this element's descendants alone, where it reaches its later
   *  siblings here (`CounterInstance.uncertain`). */
  private _own(instance: CounterInstance, own: boolean): void {
    const at = this._made.length - 1;
    instance.ownerLevel = at;
    instance.owner = this._ids[at];
    instance.uncertain = !own;
    instance.outer = false;
  }

  /** The innermost instance, made here at 0 where there is none. In a build
   *  apart, one made so stands for one outside (`CounterInstance.outer`). */
  private _innermost(name: string): CounterInstance {
    let stack = this._instances.get(name);
    if (!stack?.length) {
      this.reset(name, 0, false);
      stack = this._instances.get(name)!;
      if (this._detached) stack[stack.length - 1].outer = true;
    }
    return stack[stack.length - 1];
  }

  /** Whether a build apart answers for `instance` as a build of the whole
   *  document would: one its own elements made, and reached from inside
   *  the element that made it or past one whose reach is certain. */
  private _answers(instance: CounterInstance): boolean {
    if (instance.outer) return false;
    if (!instance.uncertain) return true;
    const at = instance.ownerLevel!;
    return at < this._ids.length && this._ids[at] === instance.owner;
  }

  /** The instance a read in a build apart reads, noting where it is not one
   *  it answers for. */
  private _read(name: string): CounterInstance {
    const instance = this._innermost(name);
    if (this._detached && !this._answers(instance)) {
      this._detached.escapedRead = true;
    }
    return instance;
  }

  increment(name: string, by: number): void {
    const instance = this._counted(name);
    instance.value = clampCounter(instance.value + by);
  }

  set(name: string, value: number): void {
    this._counted(name).value = value;
  }

  /** The instance an increment or a set counts on: the innermost, unless
   *  it was made outside an element with style containment that this is
   *  inside, where a new one is made instead, as though this reset it for
   *  itself and its later siblings — which one outside the element's parent
   *  then does not see (CSS Containment 2, 3.4). */
  private _counted(name: string): CounterInstance {
    const instance = this._innermost(name);
    const detached = this._detached;
    if (detached && !this._answers(instance)) detached.escapedWrite = true;
    const bound = this._contained[this._contained.length - 1];
    // containment in a build apart: where the instance counted on is is
    // too much to say
    if (detached && bound !== undefined) detached.escapedRead = true;
    const level = this._made.length - 1;
    if (bound === undefined || level <= bound || instance.level >= bound) {
      return instance;
    }
    const parent = level - 1;
    const fresh = { level: parent, own: false, value: 0, reversed: false };
    this._instances.get(name)!.push(fresh);
    (this._made[parent] ??= []).push(name);
    return fresh;
  }

  /** Whether the innermost instance counts down: a list item takes one
   *  from it rather than adding one. */
  reversed(name: string): boolean {
    const instance = this._innermost(name);
    // the way a list item counts, which is its write's
    if (this._detached && !this._answers(instance)) {
      this._detached.escapedWrite = true;
    }
    return instance.reversed;
  }

  value(name: string): number {
    return this._read(name).value;
  }

  values(name: string): number[] {
    this._innermost(name);
    // every instance, outermost first: the outer ones are the document's
    this.escape();
    return this._instances.get(name)!.map((instance) => instance.value);
  }
}

interface CounterInstance {
  level: number;
  own: boolean;
  value: number;
  reversed: boolean;
  /** In a build apart (`CounterScopes._detached`): the level and the id of
   *  the element whose reset made it; whether a counter of the name outside
   *  could have made that reset reach the element's descendants alone,
   *  where here it reaches its later siblings too; and whether it stands
   *  for one outside, made where a counter was used with none in scope. */
  ownerLevel?: number;
  owner?: number;
  uncertain?: boolean;
  outer?: boolean;
}

/** A counter is a 32-bit integer in a browser, and saturates there. */
function clampCounter(value: number): number {
  return Math.max(-2147483648, Math.min(2147483647, value));
}

/** Where the element whose counters change is: what the walk that counts
 *  a reversed counter's scope starts from (`BoxBuilder._countedStart`). */
interface CounterPlace {
  node: Element;
  style: ComputedStyle;
  key: number;
  /** The element's parent's style and share key, and whether it is a flex
   *  container: what its later siblings' styles are computed from. Null
   *  for the root. */
  parent: { style: ComputedStyle; key: number; inFlex: boolean } | null;
}

/**
 * What the document gives its viewport (`propagateOverflow`): the root
 * element's `overflow`, or the first `<body>`'s where the root's went
 * nowhere — whichever of them the markup has, and else the `<html>` and the
 * `<body>` the cascade implies, whose styles the root box took (`implied`).
 * Only one of them ever gives anything.
 */
function viewportOverflowOf(
  root: Element,
  implied: (ComputedStyle | null)[],
  styles: Map<Element, { style: ComputedStyle }>,
): ViewportOverflow {
  for (const style of implied) {
    const given = overflowGivenToViewport(style);
    if (given) return given;
  }
  for (const child of childrenOf(root)) {
    if (!isElement(child)) continue;
    const tag = tagOf(child);
    if (tag !== 'html' && tag !== 'body') continue;
    const given = overflowGivenToViewport(styles.get(child)?.style);
    if (given) return given;
    if (tag !== 'html') continue;
    for (const inner of childrenOf(child)) {
      if (!isElement(inner) || tagOf(inner) !== 'body') continue;
      return overflowGivenToViewport(styles.get(inner)?.style) ?? VIEWPORT_AUTO;
    }
  }
  return VIEWPORT_AUTO;
}

/** Whether the parsed document has a `<body>`. htmlparser2 does not
 *  synthesise one — it parses what it was given — so a fragment has none,
 *  and the root box stands in for it. */
function hasHtml(root: Element | { children: unknown }): boolean {
  for (const child of childrenOf(root as Element)) {
    if (isElement(child) && tagOf(child) === 'html') return true;
  }
  return false;
}

function hasBody(root: Element | { children: unknown }): boolean {
  for (const child of childrenOf(root as Element)) {
    if (!isElement(child)) continue;
    const tag = tagOf(child);
    if (tag === 'body') return true;
    if (tag === 'html' && hasBody(child)) return true;
  }
  return false;
}

/** A canvas's bitmap dimension: a non-negative integer, as HTML parses
 *  one, or its default where the attribute is missing or no number. */
function canvasSize(el: Element, name: string, fallback: number): number {
  const raw = attr(el, name);
  const n = raw == null ? NaN : parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function numberAttr(el: Element, name: string): number | null {
  const raw = attr(el, name);
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function transformText(
  text: string,
  transform: ComputedStyle['textTransform'],
  lettered = false,
): string {
  switch (transform) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize':
      return capitalize(text, lettered);
    default:
      return text;
  }
}

/**
 * `text` transformed as `transform` says, where it stands for text laid out
 * already — a first line's, whose `::first-line` transforms it (CSS 2.1
 * 5.12.1): a character at a time where the transform would change its
 * length, which moves every offset after it — `ß` is `SS` in capitals —
 * and that character kept as it is.
 */
export function transformInPlace(
  text: string,
  transform: ComputedStyle['textTransform'],
  lettered = false,
): string {
  const whole = transformText(text, transform, lettered);
  if (whole.length === text.length) return whole;
  let out = '';
  let state = lettered;
  for (const ch of text) {
    const one = transformText(ch, transform, state);
    out += one.length === ch.length ? one : ch;
    state = letteredAfter(ch, state);
  }
  return out;
}

/** A letter or a number: what a word's first typographic letter unit is
 *  (CSS Text 3, 2.1). */
const LETTER_UNIT = /[\p{L}\p{N}]/u;

/**
 * What does not end a word (UAX #29): a combining mark, and the
 * punctuation that joins letters into one — `x.y`, `don't`, `a:b`. Any
 * other character that is not a letter or a number is between words: a
 * space, a no-break space, a hyphen, a bracket.
 */
const IN_WORD =
  /[\p{M}'.:\u00b7\u0387\u05f4\u2018\u2019\u2024\u2027\ufe13\ufe52\ufe55\uff07\uff0e\uff1a]/u;

/**
 * `text-transform: capitalize` (CSS Text 3, 2.1): the first letter or
 * number of each word in upper case, and nothing else. Punctuation a word
 * starts with is not its first letter — `(p.p.)` is `(P.p.)` — and a word
 * the text continues, `lettered`, has had its own: `<b>fo</b>o` is `Foo`.
 */
function capitalize(text: string, lettered: boolean): string {
  let out = '';
  let from = 0;
  let at = 0;
  for (const ch of text) {
    if (LETTER_UNIT.test(ch)) {
      if (!lettered) {
        const title = titleCase(ch);
        if (title !== ch) {
          out += text.slice(from, at) + title;
          from = at + ch.length;
        }
        lettered = true;
      }
    } else if (!IN_WORD.test(ch)) {
      lettered = false;
    }
    at += ch.length;
  }
  return from ? out + text.slice(from) : text;
}

/**
 * A letter in title case (Unicode's SpecialCasing), which is its upper case
 * but for a letter that is two: a digraph is capitalized as its first
 * letter alone — `ǆ` as `ǅ`, where upper case is `Ǆ` — and a Greek vowel
 * with a subscript iota keeps the iota subscript, where upper case writes
 * it out. A letter whose upper case is two letters, as `ß` is `SS`, is the
 * first of them: `Ss`.
 */
function titleCase(ch: string): string {
  const cp = ch.codePointAt(0)!;
  if (cp >= 0x1c4 && cp <= 0x1cc) {
    return String.fromCharCode(0x1c5 + 3 * Math.floor((cp - 0x1c4) / 3));
  }
  if (cp >= 0x1f1 && cp <= 0x1f3) return '\u01f2';
  if (cp >= 0x1f80 && cp <= 0x1faf) return String.fromCharCode(cp | 0x08);
  if (cp === 0x1fb3 || cp === 0x1fc3 || cp === 0x1ff3) {
    return String.fromCharCode(cp + 9);
  }
  if (cp === 0x1fbc || cp === 0x1fcc || cp === 0x1ffc) return ch;
  const upper = ch.toUpperCase();
  if (upper.length <= ch.length) return upper;
  const first = String.fromCodePoint(upper.codePointAt(0)!);
  return first + upper.slice(first.length).toLowerCase();
}

/**
 * Whether a word is under way after `text`, as `capitalize` reads words: its
 * last letter, number or character between words decides, and a text of
 * nothing but joining punctuation leaves it as it was. Asked of every text,
 * from the end, where it is almost always decided by the last character.
 */
export function letteredAfter(text: string, lettered: boolean): boolean {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      if (
        (c >= 0x61 && c <= 0x7a) ||
        (c >= 0x41 && c <= 0x5a) ||
        (c >= 0x30 && c <= 0x39)
      ) {
        return true;
      }
      if (c === 0x27 || c === 0x2e || c === 0x3a) continue;
      return false;
    }
    // a low surrogate is read with the high one before it
    const start =
      c >= 0xdc00 && c <= 0xdfff && i > 0 && isHighSurrogate(text, i - 1)
        ? i - 1
        : i;
    const ch = text.slice(start, i + 1);
    if (LETTER_UNIT.test(ch)) return true;
    if (!IN_WORD.test(ch)) return false;
    i = start;
  }
  return lettered;
}

function isHighSurrogate(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff;
}

/** Whether a word is under way after a box, as `after` says where white
 *  space stands: an inline box leaves it as its content did, an atomic
 *  inline and a block end it, and a float or a positioned box leaves the
 *  word around it as it was. */
function letteredAfterFlow(
  flow: 'inline' | 'atomic' | 'block' | 'out',
  inside: boolean,
  before: boolean,
): boolean {
  if (flow === 'inline') return inside;
  if (flow === 'out') return before;
  return false;
}

/** Where the inline content being built stands, for white space: at the
 *  start of a line, just after a space that may collapse, or after anything
 *  else. `held` is a space that still collapses the one after it, with a
 *  float's or a positioned box's text pushed after it: it is no longer the
 *  last chunk, so the line's end cannot take it back (`_endLine`). */
type Collapse = 'start' | 'space' | 'held' | 'content';

/**
 * A text's first letter, with the punctuation before and after it that CSS
 * 2.1 5.12.2 counts in — the Ps, Pe, Pi, Pf and Po classes — and the white
 * space before it in the first group. No match when the text ends, or
 * reaches a space, before any letter: its first letter is in a later text,
 * as browsers read it.
 */
const FIRST_LETTER =
  /^([ \t\n\r\f\u00a0]*)(?:[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Po}]\p{M}*)*[^ \t\n\r\f\u00a0\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Po}]\p{M}*(?:[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Po}]\p{M}*)*/u;

/** A text that is punctuation and nothing else, but for the white space
 *  before it in the first group. */
const PUNCTUATION_ONLY =
  /^([ \t\n\r\f\u00a0]*)(?:[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Po}]\p{M}*)+$/u;

/** A `::first-letter` looking for its letter. */
interface LetterSearch {
  rules: FirstLetterRules;
  /** Punctuation already in the letter's style, from texts that ended
   *  before the letter came. */
  punctuation: { box: Box; text: Box; style: ComputedStyle }[];
}

/** Put punctuation a search styled back in its own box and style: the
 *  letter it was waiting for is not on its line. */
function giveBack(search: LetterSearch): void {
  for (const { box, text, style } of search.punctuation) {
    const parent = box.parent;
    if (!parent) continue;
    const at = parent.children.indexOf(box);
    if (at < 0) continue;
    parent.children[at] = text;
    text.parent = parent;
    text.style = style;
  }
  search.punctuation.length = 0;
}

/** Whether a box of this display is a block container, which is what can
 *  have a first letter. */
/**
 * Whether a block at or around `from` looks for a first letter in what it
 * holds (`Builder._firstLetter`): one a `::first-letter` rule matches. Only
 * such a block hands the builder a search, and none is carried out past
 * what it holds, so what a subtree build makes below none is what a whole
 * build makes there. One rule of the kind anywhere in a webmail page's
 * sheets — the first letter of the account name in its header — made every
 * change to the page a build of all 12,894 of its elements.
 */
function lookedForLetter(
  from: Element | null,
  tree: BoxTree,
  cascade: Cascade,
): boolean {
  for (let at = from; at; at = flatParentOf(at)) {
    const style = tree.styles.get(at)?.style;
    if (style && hasFirstLetter(style.display) && cascade.firstLetterRules(at))
      return true;
  }
  return false;
}

function hasFirstLetter(display: ComputedStyle['display']): boolean {
  switch (display) {
    case 'block':
    case 'inline-block':
    case 'list-item':
    case 'table-cell':
    case 'table-caption':
      return true;
    default:
      return false;
  }
}

/**
 * Whether a box is out of the flow or a float, as its style and the box it
 * is in have it. `float` does not apply to a flex item or a grid item (CSS
 * Flexbox 1, 4; CSS Grid 2, 6.1), which Chrome lays out as an item like any
 * other and whose `float` it still computes as given.
 */
function placeInFlow(box: Box, style: ComputedStyle, into: Box): void {
  if (style.position === 'absolute' || style.position === 'fixed') {
    box.outOfFlow = true;
  } else if (style.float !== 'none' && into.kind !== 'flex') {
    box.isFloat = true;
  }
}

/**
 * How a box sits in its parent's inline content, for white space. An inline
 * box's content is its parent's own; an atomic inline — an inline-block, an
 * image — is one piece of it; a block ends the line it interrupts and starts
 * another; a float or a positioned box is no part of it at all.
 */
function flowOf(
  style: ComputedStyle,
  box: Box,
): 'inline' | 'atomic' | 'block' | 'out' {
  if (box.outOfFlow || box.isFloat) return 'out';
  // an image told to be a table's part is an inline one (`isBlockLevel`)
  if (box.kind === 'replaced' && style.display.startsWith('table-')) {
    return 'atomic';
  }
  switch (style.display) {
    case 'inline':
      return box.kind === 'replaced' ? 'atomic' : 'inline';
    case 'inline-block':
    case 'inline-table':
    case 'inline-flex':
      return 'atomic';
    case 'table-row-group':
    case 'table-header-group':
    case 'table-footer-group':
    case 'table-row':
    case 'table-cell':
    case 'table-caption':
    case 'table-column':
    case 'table-column-group':
      // table parts in an inline box are given an inline table around them
      // (CSS 2.1 17.2.1), which sits in the line as an inline-block does:
      // the white space either side of it is the line's
      return box.parent?.kind === 'inline' ? 'atomic' : 'block';
    default:
      return 'block';
  }
}

/** Where the inline content stands after a box, from where it stood inside
 *  the box and before it. */
function after(
  flow: 'inline' | 'atomic' | 'block' | 'out',
  inside: Collapse,
  before: Collapse,
  pushed = false,
): Collapse {
  switch (flow) {
    case 'inline':
      return inside;
    case 'atomic':
      return 'content';
    case 'out':
      // a box out of the flow is no part of the line's white space, but
      // the text it pushed is after the space: taken back at the line's
      // end, the character off the last chunk was the box's own — a
      // preserved space a float's `white-space: pre` text ends on
      return before === 'space' && pushed ? 'held' : before;
    default:
      return 'start';
  }
}

/**
 * How many anonymous boxes the fix-up will put between a box of `kind` and
 * the box it is appended to, `parent` (`fixUpTable`, `wrapOrphans`,
 * `wrapTableParts`): a table part outside a table is given what it is
 * missing of one, and what is in a table and no part of it is given a
 * cell, a row and a row group. A cell in a block is in a table, a row group
 * and a row of its own, and a block in a row is in a cell. Counted against
 * `MAX_DEPTH`, which bounds the boxes and not the elements.
 */
function wrappersAround(
  parent: BoxKind,
  kind: BoxKind,
  style: ComputedStyle,
): number {
  const column =
    style.display === 'table-column' || style.display === 'table-column-group';
  switch (parent) {
    case 'table':
      if (kind === 'table-row-group' || kind === 'table-caption' || column) {
        return 0;
      }
      return kind === 'table-row' ? 1 : kind === 'table-cell' ? 2 : 3;
    case 'table-row-group':
      return kind === 'table-row' ? 0 : kind === 'table-cell' ? 1 : 2;
    case 'table-row':
      return kind === 'table-cell' ? 0 : 1;
  }
  // a part out of flow is no part (`isTablePart`)
  if (
    style.position === 'absolute' ||
    style.position === 'fixed' ||
    style.float !== 'none'
  ) {
    return 0;
  }
  if (kind === 'table-row-group' || kind === 'table-caption' || column) {
    return 1;
  }
  return kind === 'table-row' ? 2 : kind === 'table-cell' ? 3 : 0;
}

function boxKindFor(display: ComputedStyle['display']): BoxKind {
  switch (display) {
    case 'inline':
      return 'inline';
    case 'flex':
    case 'inline-flex':
      return 'flex';
    case 'table':
    case 'inline-table':
      return 'table';
    case 'table-row-group':
    case 'table-header-group':
    case 'table-footer-group':
      return 'table-row-group';
    case 'table-row':
      return 'table-row';
    case 'table-cell':
      return 'table-cell';
    case 'table-caption':
      return 'table-caption';
    case 'table-column':
    case 'table-column-group':
      // A column box paints nothing and lays out nothing; the table reads
      // its style for the column width and skips the box.
      return 'block';
    default:
      // `inline-block` and `list-item` are block *containers* that happen to
      // be inline-level or to carry a marker; both lay out inside like a
      // block, and the difference is what the parent does with them.
      return 'block';
  }
}

/** A replaced box's intrinsic size from what its content says, in CSS
 *  pixels: an axis it does not give takes the default object size. */
function setIntrinsics(box: Box, size: IntrinsicSize, scale: number): void {
  box.intrinsic = intrinsicsOf(size, scale);
}

/** A replaced box's intrinsic size from its image's, which is in CSS
 *  pixels: the default object size on a side it has none of. */
export function intrinsicsOf(
  size: IntrinsicSize,
  scale: number,
): NonNullable<Box['intrinsic']> {
  return {
    width: (size.width ?? 300) * scale,
    height: (size.height ?? 150) * scale,
    missing: (size.width === null ? 1 : 0) | (size.height === null ? 2 : 0),
    ratio: size.ratio,
  };
}

/** An image box's intrinsic size while its image has not arrived: what
 *  the `width` and `height` of `sized` say, its own or the `<source>`'s
 *  its `<picture>` chose (`dimensionSource`), and no size without them. */
export function awaitedIntrinsics(
  sized: Element,
  scale: number,
): NonNullable<Box['intrinsic']> {
  const width = numberAttr(sized, 'width') ?? 0;
  const height = numberAttr(sized, 'height') ?? 0;
  return {
    width: width * scale,
    height: height * scale,
    missing: 0,
    ratio: width > 0 && height > 0 ? width / height : 0,
  };
}

/** An `<input type=image>`: a picture that submits its form. */
function isImageButton(el: Element, tag: string): boolean {
  return (
    tag === 'input' && (attr(el, 'type') ?? '').trim().toLowerCase() === 'image'
  );
}

function replacedKind(el: Element, tag: string): ReplacedKind {
  switch (tag) {
    case 'img':
      return 'image';
    case 'svg':
      // XHTML's `<svg:svg>` too, which `tagOf` names `svg`
      return 'svg';
    case 'hr':
      return 'hr';
    case 'iframe':
    case 'video':
    case 'embed':
    case 'canvas':
      return 'frame';
    case 'textarea':
      return 'textarea';
    case 'select':
      return 'select';
    // A `<button>` is not one: its content is the document's, laid out and
    // drawn like any box's (the UA sheet's `button` rule), where an
    // `<input type=submit>` has only a value to show and is a widget.
    case 'input': {
      const type = (attr(el, 'type') ?? 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset')
        return 'button';
      if (type === 'hidden') return 'none';
      return 'input';
    }
    default:
      return 'none';
  }
}

/**
 * The marker a `list-item` draws: its `list-item` counter written in its
 * `list-style-type`, between the style's prefix and suffix, or the string
 * the type is. The counter is the builder's (`CounterScopes`), which is
 * what lets `value` on an `<li>`, `start` and `reversed` on an `<ol>`, a
 * list in a list and an author's own `counter-reset` and `counter-set` all
 * count as a browser counts them. A suffix that ends in a space — `. `, a
 * bullet's — is written without it, and the layout sets the marker off by
 * its own gap; one that does not, `、`, sets the marker against the text.
 */
function markerFor(
  style: ComputedStyle,
  n: number,
  styles: CounterStyles,
): { text: string; flush: boolean } {
  const type = style.listStyleType;
  if (type === 'none') return { text: '', flush: false };
  if (type.startsWith('"')) return { text: type.slice(1), flush: true };
  const { prefix, text, suffix } = styles.marker(
    n,
    type,
    style.direction === 'rtl',
  );
  const spaced = /\s$/.test(suffix);
  return {
    text: prefix + text + (spaced ? suffix.trimEnd() : suffix),
    flush: !spaced,
  };
}

/** The marker styles that are one symbol whatever an item's number,
 *  which no `@counter-style` may define again (CSS Counter Styles 3, 3). */
const SYMBOL_MARKERS = new Set([
  'disc',
  'circle',
  'square',
  'disclosure-open',
  'disclosure-closed',
]);

/** Whether a list item's marker shows its number: any but no marker, a
 *  string, and one symbol (`markerFor`) — or a `::marker`'s content, which
 *  reads what it reads where it is generated (`_generated`). */
function numberedMarker(style: ComputedStyle): boolean {
  const type = style.listStyleType;
  return !(type === 'none' || type.startsWith('"') || SYMBOL_MARKERS.has(type));
}

/**
 * Give every box the document range its subtree covers. Runs after `fixUp`,
 * because fix-up reparents children into anonymous boxes and the ranges have
 * to describe the tree the walks will actually traverse. Document order
 * makes each subtree's range contiguous, so min/max over the children is
 * exact rather than an approximation.
 */
function assignSubtreeRanges(box: Box): { start: number; end: number } {
  let start = box.textEnd > box.textStart ? box.textStart : Infinity;
  let end = box.textEnd > box.textStart ? box.textEnd : -Infinity;
  for (const child of box.children) {
    const range = assignSubtreeRanges(child);
    if (range.end > range.start) {
      start = Math.min(start, range.start);
      end = Math.max(end, range.end);
    }
  }
  if (end <= start) {
    box.subtreeTextStart = 0;
    box.subtreeTextEnd = 0;
    return { start: 0, end: 0 };
  }
  box.subtreeTextStart = start;
  box.subtreeTextEnd = end;
  return { start, end };
}

// --- anonymous boxes --------------------------------------------------------

/**
 * The fix-up pass: CSS's anonymous box rules, applied bottom-up.
 *
 * Two of them, and both are the difference between a document that lays out
 * and one that silently drops content:
 *
 *  - **A block container with a mix of block-level and inline-level children
 *    wraps each run of inline children in an anonymous block.** Without it
 *    `<div>text<p>para</p></div>` has to decide whether the div is a block
 *    context or an inline one, and either answer loses something.
 *  - **A table's structure is completed.** Real documents write `<table>`
 *    straight to `<tr>`, and CSS says the missing row group is generated
 *    rather than the rows being dropped.
 */
function fixUp(box: Box, anonymous: AnonymousStyle): void {
  for (const child of box.children) fixUp(child, anonymous);
  fixUpOwn(box, anonymous);
}

/** `fixUp` of a box whose children have had theirs. */
function fixUpOwn(box: Box, anonymous: AnonymousStyle): void {
  if (box.kind === 'table') {
    fixUpTable(box, anonymous);
    return;
  }
  if (box.kind === 'table-row-group') {
    wrapOrphans(box, 'table-row', (k) => k === 'table-row', anonymous);
    return;
  }
  if (box.kind === 'table-row') {
    wrapOrphans(box, 'table-cell', (k) => k === 'table-cell', anonymous);
    return;
  }
  // a column group holds its columns, which are where they belong, and the
  // builder kept nothing else in it
  if (box.style.display === 'table-column-group') return;

  if (!box.children.length) return;
  wrapTableParts(box, anonymous);
  // An inline box holds no block: a block in one is its block container's,
  // which breaks the inline box around it
  if (box.kind === 'inline') return;
  if (box.kind !== 'flex') breakInlines(box);
  let hasBlockLevel = false;
  let hasInlineLevel = false;
  for (const child of box.children) {
    if (child.outOfFlow) continue;
    if (isBlockLevel(child)) hasBlockLevel = true;
    else hasInlineLevel = true;
  }
  // A flex container has no inline formatting context at all: every run of
  // inline-level content becomes an anonymous flex *item*, whether or not a
  // block-level sibling forced the question. `<div style="display:flex">some
  // text</div>` is the case the mixed-content rule alone drops on the floor —
  // all-inline children, so no wrapping, so the flex pass finds bare text
  // boxes it cannot lay out and renders nothing.
  const wrapAllInline = box.kind === 'flex';
  if (!wrapAllInline && (!hasBlockLevel || !hasInlineLevel)) return;
  if (wrapAllInline && !hasInlineLevel) return;

  const next: Box[] = [];
  let run: Box[] | null = null;
  // what came before the blocks in the flow, for a tail after one
  // (`RAN_FROM`)
  let inline = false;
  let out = false;
  let inlineFrom: Box | null = null;
  let outFrom: Box | null = null;
  for (const child of box.children) {
    // A float or an absolutely positioned box sits in whichever context it
    // finds itself; it does not force an anonymous block on its own. In a
    // flex container or a grid it is in no item (CSS Flexbox 1, 4.1): the
    // text before it and after it are two, as Chrome makes them, and alone
    // it is none. Wrapped, Primer's accordion trigger — a title, a chevron
    // and an absolute `::after` the size of the item, spaced apart — had
    // three items, and the chevron stood half way along the row.
    if (
      (isBlockLevel(child) && !child.outOfFlow && !child.isFloat) ||
      (wrapAllInline && child.outOfFlow)
    ) {
      if (!child.outOfFlow) {
        if (inline) inlineFrom ??= child;
        if (out) outFrom ??= child;
      }
      if (run) {
        next.push(anonymousOf(box, 'block', run, anonymous));
        run = null;
      }
      next.push(child);
      continue;
    }
    if (child.outOfFlow || child.isFloat) out = true;
    else inline = true;
    // Whitespace between two blocks is not content and must not generate a
    // line box — `<div><p>a</p> <p>b</p></div>` has no blank line in it.
    if (!run && child.kind === 'text' && isBlank(child.text)) continue;
    (run ??= []).push(child);
  }
  if (!wrapAllInline) {
    RAN_FROM.set(box, { inline: inlineFrom, out: outFrom });
  }
  if (run) {
    if (run.every((c) => c.kind === 'text' && isBlank(c.text))) {
      // trailing whitespace after the last block: same rule
    } else {
      next.push(anonymousOf(box, 'block', run, anonymous));
    }
  }
  box.children = next;
}

/**
 * Break a block container's inline children around the blocks in them
 * (CSS 2.1 9.2.1.1): an inline box with an in-flow block in it — at any
 * depth of inline box — becomes the pieces of it before, between and after
 * its blocks, and the blocks stand beside them as the container's own, for
 * the mixed-content rule to wrap the pieces in anonymous blocks.
 * `<font><p>One</p><p>Two</p></font>` laid its paragraphs side by side as
 * inline-blocks, and a link around a card's blocks set them in a line.
 */
function breakInlines(box: Box): void {
  let next: Box[] | null = null;
  for (let i = 0; i < box.children.length; i += 1) {
    const child = box.children[i];
    const pieces =
      child.kind === 'inline' && holdsBlock(child) ? breakAround(child) : null;
    if (!pieces) {
      next?.push(child);
      continue;
    }
    next ??= box.children.slice(0, i);
    for (const piece of pieces) {
      piece.parent = box;
      next.push(piece);
    }
  }
  if (next) box.children = next;
}

/** Whether an inline box has an in-flow block in it, at any depth of
 *  inline box: asked first, and without making anything, since nearly
 *  every inline box has none. */
function holdsBlock(inline: Box): boolean {
  for (const child of inline.children) {
    if (child.kind === 'inline') {
      if (holdsBlock(child)) return true;
    } else if (isBlockLevel(child) && !child.outOfFlow && !child.isFloat) {
      return true;
    }
  }
  return false;
}

/**
 * An inline box broken around the in-flow blocks in it: its pieces, each a
 * box of its element and style holding the content between two blocks,
 * with the blocks between them; null where it has none, which is nearly
 * every inline box. A piece has no edge on a side a block cut: the start of
 * the first and the end of the last are the box's own.
 */
function breakAround(inline: Box): Box[] | null {
  let out: Box[] | null = null;
  const pieces: Box[] = [];
  let run: Box[] = [];
  const close = (): void => {
    const piece = new Box('inline', inline.el, inline.style);
    piece.pseudo = inline.pseudo;
    for (const child of run) piece.append(child);
    pieces.push(piece);
    (out ??= []).push(piece);
    run = [];
  };
  const blocks: Box[] = [];
  for (const child of inline.children) {
    if (isBlockLevel(child) && !child.outOfFlow && !child.isFloat) {
      close();
      out!.push(child);
      blocks.push(child);
      continue;
    }
    const inner =
      child.kind === 'inline' && holdsBlock(child) ? breakAround(child) : null;
    if (!inner) {
      run.push(child);
      continue;
    }
    for (const piece of inner) {
      if (piece.kind === 'inline') {
        run.push(piece);
      } else {
        close();
        out!.push(piece);
        blocks.push(piece);
      }
    }
  }
  if (!out) return null;
  close();
  for (let i = 0; i < pieces.length; i += 1) {
    pieces[i].cut = (i > 0 ? 1 : 0) | (i < pieces.length - 1 ? 2 : 0);
  }
  CUT_BLOCKS.set(pieces[0], blocks);
  const fade = inline.style.opacity;
  if (fade < 1) {
    for (const block of blocks) {
      FADED_BLOCKS.set(block, (FADED_BLOCKS.get(block) ?? 1) * fade);
    }
  }
  return out;
}

/** Whether a style names an image for its box to be drawn with: a
 *  background's, a border's, or a mask's. */
function namesImages(style: ComputedStyle): boolean {
  return (
    !!style.backgroundImage ||
    !!style.backgroundImages ||
    urlOf(style.borderImage.source) !== null ||
    style.mask !== NO_MASK
  );
}

/**
 * The style of an anonymous box inside a parent: what the parent passes on
 * by inheritance, and every other property at its initial value, as CSS 2.1
 * gives anonymous boxes theirs (9.2.1.1, 17.2.1). An anonymous box that took
 * the parent's style itself took its height, its padding and borders, its
 * background, its relative offset and its opacity a second time — the text
 * in `<div style="padding: 20px">text<p>…</p></div>` sat 40px in, and the
 * paragraph after it the height of the div further down. One per parent
 * style, which the cascade already shares between elements.
 */
export type AnonymousStyle = (
  parent: ComputedStyle,
  display: ComputedStyle['display'],
) => ComputedStyle;

function anonymousStyles(initial: ComputedStyle): AnonymousStyle {
  const made = new WeakMap<ComputedStyle, Map<string, ComputedStyle>>();
  return (parent, display) => {
    let byDisplay = made.get(parent);
    if (!byDisplay) {
      byDisplay = new Map();
      made.set(parent, byDisplay);
    }
    let style = byDisplay.get(display);
    if (!style) {
      // `display` is the one property it does not start from: it is the
      // box the fix-up made, and layout asks the style what a box is
      style = inherit(parent, initial);
      style.display = display;
      byDisplay.set(display, style);
    }
    return style;
  };
}

function isBlockLevel(box: Box): boolean {
  switch (box.kind) {
    case 'block':
    case 'flex':
    case 'table':
    case 'table-row':
    case 'table-row-group':
    case 'table-cell':
    case 'table-caption':
      // An `inline-block` or `inline-flex` is a block *container* with an
      // inline-level outer role, so it belongs to the inline run around it.
      return !isInlineLevelDisplay(box.style.display);
    case 'replaced':
      // an image is inline unless it is told otherwise, and then it is a
      // block: `img { display: block }`, which mail writes to lose the gap
      // under its images, stacks them. A table's part is no display it
      // can take, and one told to be a cell is inline (CSS Display 3,
      // 2.4), which is what a table wraps a cell around.
      return (
        box.style.display !== 'inline' &&
        !isInlineLevelDisplay(box.style.display) &&
        !box.style.display.startsWith('table-')
      );
    default:
      return false;
  }
}

function isInlineLevelDisplay(display: ComputedStyle['display']): boolean {
  return (
    display === 'inline-block' ||
    display === 'inline-flex' ||
    display === 'inline-table'
  );
}

/** Wrap children that are not of `expect` in an anonymous box that is. */
function wrapOrphans(
  box: Box,
  kind: BoxKind,
  accept: (k: BoxKind) => boolean,
  anonymous: AnonymousStyle,
): void {
  let needed = false;
  for (const child of box.children) {
    if (!accept(child.kind) && !isDroppableWhitespace(child)) {
      needed = true;
      break;
    }
  }
  if (!needed) return;
  // White space goes only between two of the parts, or beside one at an
  // end (CSS 2.1 17.2.1, rule 1): beside a child the fix-up wraps, it is
  // that child's run's, so `<span>a</span> <span>b</span>` in a row is one
  // anonymous cell of `a b`, where it was `ab`
  const next: Box[] = [];
  let run: Box[] | null = null;
  let space: Box[] = [];
  for (const child of box.children) {
    if (accept(child.kind)) {
      if (run) {
        run.push(...space);
        next.push(anonymousOf(box, kind, run, anonymous));
        run = null;
      }
      space = [];
      next.push(child);
      continue;
    }
    if (isDroppableWhitespace(child)) {
      space.push(child);
      continue;
    }
    (run ??= []).push(...space, child);
    space = [];
  }
  if (run) {
    run.push(...space);
    next.push(anonymousOf(box, kind, run, anonymous));
  }
  box.children = next;
  // A cell made here is a block container the fix-up has not been to: its
  // children had theirs, as the table's, before it held them. Text beside a
  // block in it goes in an anonymous block as in any other (CSS 2.1
  // 9.2.1.1) — `<span style="display: inline-table">bcd<div>x</div>` laid
  // `bcd` out as nothing, and drew the table as wide as the `x`.
  if (kind === 'table-cell') {
    for (const child of next) {
      if (child.kind === 'table-cell' && !child.el) fixUpOwn(child, anonymous);
    }
  }
}

function anonymousOf(
  parent: Box,
  kind: BoxKind,
  run: Box[],
  anonymous: AnonymousStyle,
  display: ComputedStyle['display'] = kind as ComputedStyle['display'],
): Box {
  const box = new Box(kind, null, anonymous(parent.style, display));
  box.parent = parent;
  for (const child of run) {
    child.parent = box;
    box.children.push(child);
  }
  return box;
}

/** White space alone, which the table fix-up drops between the parts of a
 *  table whether it is kept or not (CSS 2.1 17.2.1, rule 1). Kept, under
 *  `white-space: pre`, it made a cell of the line break before every row. */
function isDroppableWhitespace(box: Box): boolean {
  return box.kind === 'text' && isBlank(box.text);
}

/** The label an input button shows: its `value`, or what a submit or a
 *  reset button says without one (HTML 4.10.5.1.18, 4.10.5.1.20). */
function inputButtonLabel(el: Element): string {
  const value = attr(el, 'value');
  if (value !== undefined) return value;
  const type = (attr(el, 'type') ?? '').trim().toLowerCase();
  return type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '';
}

/** Whether the containments `bits` would apply to a box, were they set
 *  (`contained`): none to an inline box that is no atomic one, and none to
 *  a table's inner parts but a cell — nor size containment to a table or a
 *  cell (CSS Containment 2, 3). */
export function containmentApplies(box: Box, bits: number): boolean {
  switch (box.kind) {
    case 'block':
    case 'flex':
    case 'replaced':
      return true;
    case 'table':
    case 'table-cell':
      return !!(bits & ~(CONTAIN_SIZE | CONTAIN_INLINE_SIZE));
    default:
      return false;
  }
}

/**
 * Whether a text is white space alone: CSS's white space, which is the
 * space, the tab and the three line breaks and nothing else (CSS Text 3,
 * 4.1). JavaScript's `\s` and `trim` take in the no-break space and the
 * other Unicode spaces too, so a `<p>&nbsp;</p>` spacer or a
 * `<td>&nbsp;</td>` beside a block was dropped as if it held nothing. Tested
 * rather than trimmed, which copies a paragraph's text to find out.
 */
export function isBlank(text: string): boolean {
  return BLANK.test(text);
}

const BLANK = /^[ \t\n\r\f]*$/;

/** White space that collapsing would change: anything but a lone space.
 *  Most of a document's text has none, and is its own collapsed form. */
const COLLAPSIBLE = /[\t\n\r\f]| {2}/;

function isRelative(style: ComputedStyle): boolean {
  return style.position === 'relative' || style.position === 'sticky';
}

/** Whether a box may be placed against its implicit anchor element, which
 *  no `anchor-name` says is there: a positioned box with an `auto`
 *  `position-anchor` that anchors anything, or a `normal` one in a
 *  `position-area`, its own or an option's. A tree with one is a tree with
 *  anchors (`BoxTree.anchors`). */
function mayAnchorImplicitly(style: ComputedStyle): boolean {
  if (style.positionAnchor !== null) return false;
  if (style.position !== 'absolute' && style.position !== 'fixed') {
    return false;
  }
  const text = style.positionAnchorText;
  if (text === 'normal') {
    return !!(style.positionArea || style.positionTryFallbacks);
  }
  return (
    text === 'auto' &&
    !!(
      style.positionArea ||
      style.anchorInsets ||
      style.anchorSizes ||
      style.positionTryFallbacks ||
      style.justifyAnchorCenter ||
      style.alignAnchorCenter
    )
  );
}

/** Whether `position: relative` moves a box: an inset is set. An inline box
 *  that is moved has its text laid out apart (`collect`), so one whose
 *  insets resolve to nothing still costs its paragraph the layout of a line
 *  at a time, which a box with every inset `auto` does not. */
export function isOffset(style: ComputedStyle): boolean {
  if (!isRelative(style)) return false;
  return (
    style.top !== AUTO ||
    style.right !== AUTO ||
    style.bottom !== AUTO ||
    style.left !== AUTO
  );
}

/** Whether a style may put its box under its stacking context's flow: a
 *  negative `z-index` on a positioned box, or on a flex item, which that
 *  makes a stacking context as it is (`stacksLayers`). */
function isNegative(style: ComputedStyle): boolean {
  return typeof style.zIndex === 'number' && style.zIndex < 0;
}

/** A box that belongs inside a table: a row group, a row, a cell, a
 *  caption or a column. Asked of every child of every box in a build, so
 *  a text or an inline box is answered from its kind, without its style. */
function isTablePart(box: Box): boolean {
  switch (box.kind) {
    case 'table-row-group':
    case 'table-row':
    case 'table-cell':
    case 'table-caption':
      return !box.outOfFlow && !box.isFloat;
    case 'block': {
      if (box.outOfFlow || box.isFloat) return false;
      const display = box.style.display;
      return display === 'table-column' || display === 'table-column-group';
    }
    default:
      return false;
  }
}

/**
 * Table parts outside a table get one around them (CSS 2.1 17.2.1, rule 3):
 * each run of them — the white space between them no part of it — is
 * wrapped in an anonymous table, an inline one where the parent is inline,
 * and the table is then completed as any other. Laid out on their own, two
 * cells side by side in a line were two inline-blocks with a space between
 * them, and in a block two blocks, one above the other.
 */
function wrapTableParts(box: Box, anonymous: AnonymousStyle): void {
  if (!box.children.some(isTablePart)) return;
  const display = box.kind === 'inline' ? 'inline-table' : 'table';
  const next: Box[] = [];
  let run: Box[] | null = null;
  let space: Box[] = [];
  const flush = (): void => {
    if (!run) return;
    const table = anonymousOf(box, 'table', run, anonymous, display);
    fixUpTable(table, anonymous);
    next.push(table);
    run = null;
  };
  for (const child of box.children) {
    if (isTablePart(child)) {
      run ??= [];
      run.push(child);
      space = [];
      continue;
    }
    if (run && isDroppableWhitespace(child)) {
      // held back: between two parts it goes, after the last it stays
      space.push(child);
      continue;
    }
    flush();
    next.push(...space, child);
    space = [];
  }
  flush();
  next.push(...space);
  box.children = next;
  for (const child of next) child.parent = box;
}

function fixUpTable(table: Box, anonymous: AnonymousStyle): void {
  const groups: Box[] = [];
  const captions: Box[] = [];
  const columns: Box[] = [];
  let looseRows: Box[] | null = null;
  let looseCells: Box[] | null = null;
  const flushCells = (): void => {
    if (!looseCells) return;
    (looseRows ??= []).push(
      anonymousOf(table, 'table-row', looseCells, anonymous),
    );
    looseCells = null;
  };
  for (const child of table.children) {
    const display = child.style.display;
    // an image told to be a column is an inline image, as one told to be a
    // cell is (`flowOf`): taken for a column, it was never drawn
    if (
      (display === 'table-column' || display === 'table-column-group') &&
      child.kind !== 'replaced'
    ) {
      // A column is the table's, beside its rows: it lays out nothing and
      // paints nothing (17.2.1). Taken for a stray child, it was wrapped in
      // a row of its own and drawn as a cell.
      columns.push(child);
    } else if (child.kind === 'table-row-group') {
      flushCells();
      if (looseRows) {
        groups.push(
          anonymousOf(table, 'table-row-group', looseRows, anonymous),
        );
        looseRows = null;
      }
      groups.push(child);
    } else if (child.kind === 'table-caption') {
      captions.push(child);
    } else if (isDroppableWhitespace(child)) {
      // after a loose child it goes with the loose children, and the cells
      // they are wrapped in say whether it stays (`wrapOrphans`)
      if (looseCells) looseCells.push(child);
      continue;
    } else if (child.kind === 'table-row') {
      flushCells();
      (looseRows ??= []).push(child);
    } else {
      // Anything else that ended up here is a cell, or goes in one, and a
      // run of them shares an anonymous row — which is how a browser
      // rescues `<table>text</table>`, and how three cells in a table
      // with no row are one row of three rather than three rows of one.
      (looseCells ??= []).push(child);
    }
  }
  flushCells();
  if (looseRows) {
    groups.push(anonymousOf(table, 'table-row-group', looseRows, anonymous));
  }
  for (const group of groups) {
    wrapOrphans(group, 'table-row', (k) => k === 'table-row', anonymous);
    for (const row of group.children) {
      wrapOrphans(row, 'table-cell', (k) => k === 'table-cell', anonymous);
    }
  }
  table.children = [...captions, ...columns, ...groups];
  for (const child of table.children) child.parent = table;
}
