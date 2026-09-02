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
import type { Element } from 'domhandler';

import type { TextRun } from '../../richtext/index.js';
import {
  attr,
  childrenOf,
  isElement,
  isText,
  NON_RENDERED,
  tagOf,
} from '../dom.js';
import type { Cascade } from '../css/cascade.js';
import type { ComputedStyle } from '../css/style.js';

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

/** A laid-out line inside an inline formatting context. */
export interface LineBox {
  /** Content-box relative, resolved to document coordinates at paint. */
  x: number;
  y: number;
  width: number;
  height: number;
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
}

export interface AtomicPlacement {
  box: Box;
  x: number;
  y: number;
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

  /** Text, for a `text` box: already whitespace-processed and transformed. */
  text = '';
  /** This box's slice of the document text index. */
  textStart = 0;
  textEnd = 0;

  /** Lines, for a box that established an inline formatting context. */
  lines: LineBox[] | null = null;

  /** Intrinsic size, for a replaced box that knows one. */
  intrinsicWidth = 0;
  intrinsicHeight = 0;
  /**
   * Cached min-/max-content widths, for a table cell. -1 until measured.
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
  /** What a replaced box is: the resource seam and the control host both
   *  key on this rather than re-reading the tag. */
  replaced: ReplacedKind = 'none';

  /** The marker text of a `list-item`, if it generated one, and where it
   *  was laid out. The marker is not a box: it is not in the flow, nothing
   *  can select it (CSS spells that `::marker`, and no author styles it
   *  here), and giving it one would put a bullet in every copied list. */
  markerText = '';
  markerLayout: TextLayoutLike | null = null;
  markerX = 0;
  markerY = 0;

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
  | 'hr';

/** What the builder produced, plus the document-wide text it indexed. */
export interface BoxTree {
  root: Box;
  /** The document's text as it will be drawn, which is what `textContent()`
   *  answers and what a copy puts on the clipboard. */
  text: string;
  /** Text boxes in document order — the selection binary-searches this. */
  textBoxes: Box[];
  /** Every replaced box that needs a real widget, in document order. */
  controls: Box[];
  /** Every box carrying an `href`, for click and hover. */
  links: Box[];
}

export interface BuildOptions {
  cascade: Cascade;
  /** Device pixels per CSS pixel. An image's pixels and a `width="600"`
   *  attribute are CSS pixels; every box is device, so both are multiplied
   *  on the way in. Default 1. */
  scale?: number;
  /** Intrinsic size for an image the host has already loaded, in the
   *  image's own pixels. `null` when it has not: the box takes the attribute
   *  size, or a placeholder. */
  imageSize(el: Element): { width: number; height: number } | null;
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

/**
 * How deep the box tree may go. Everything downstream of the builder — the
 * fix-up pass, layout, paint, the accessor walks — recurses on box depth, so
 * this is the one bound that keeps a degenerately nested document (fuzzer
 * output, a runaway template) from a stack overflow five phases later.
 * Blink's parser flattens at 512 for the same reason; content past the cap
 * is dropped, which beats the alternative of crashing the application.
 */
const MAX_DEPTH = 512;

class Builder {
  private _options: BuildOptions;
  private _text = '';
  private _textBoxes: Box[] = [];
  private _controls: Box[] = [];
  private _links: Box[] = [];
  /** Counter stack for `<ol>` numbering, one entry per open list. */
  private _counters: number[] = [];
  private _depth = 0;

  constructor(options: BuildOptions) {
    this._options = options;
  }

  run(root: Element): BoxTree {
    const cascade = this._options.cascade;
    const rootStyle = cascade.rootStyle(hasBody(root));
    const rootBox = new Box('block', null, rootStyle);
    // The DOM's `<html>`/`<body>` are ordinary elements with ordinary styles;
    // the box above them exists only to be the initial containing block, so
    // it carries no margins of its own and cannot collapse with anything.
    this._children(root, rootBox, rootStyle, false);
    fixUp(rootBox);
    assignSubtreeRanges(rootBox);
    return {
      root: rootBox,
      text: this._text,
      textBoxes: this._textBoxes,
      controls: this._controls,
      links: this._links,
    };
  }

  /** Build boxes for a parent's children into `into`. */
  private _children(
    node: Element | { children: unknown },
    into: Box,
    parentStyle: ComputedStyle,
    inFlex: boolean,
    owner: Element | null = null,
  ): void {
    for (const child of childrenOf(node as Element)) {
      if (isText(child)) {
        this._textNode(child.data, into, parentStyle, owner);
        continue;
      }
      if (!isElement(child)) continue;
      this._element(child, into, parentStyle, inFlex);
    }
  }

  private _element(
    el: Element,
    into: Box,
    parentStyle: ComputedStyle,
    inFlex: boolean,
  ): void {
    const tag = tagOf(el);
    if (NON_RENDERED.has(tag)) return;

    const style = this._options.cascade.styleFor(el, parentStyle, inFlex);
    if (style.display === 'none') return;

    // `<br>` is a line break rather than a box, and it is the one element
    // whose *absence* of a box still has to reach the inline layout.
    if (tag === 'br') {
      const box = new Box('break', el, style);
      into.append(box);
      this._push('\n', box);
      return;
    }

    const replaced = replacedKind(el, tag);
    if (replaced !== 'none') {
      this._replaced(el, tag, replaced, style, into);
      return;
    }

    if (this._depth >= MAX_DEPTH) return;
    const kind = boxKindFor(style.display);
    const box = new Box(kind, el, style);
    into.append(box);
    if (style.position === 'absolute' || style.position === 'fixed')
      box.outOfFlow = true;
    else if (style.float !== 'none') box.isFloat = true;

    if (attr(el, 'href') && (tag === 'a' || tag === 'area'))
      this._links.push(box);

    if (style.display === 'list-item') {
      box.markerText = markerFor(el, style, this._counters);
    }
    const opensCounter = tag === 'ol' || tag === 'ul';
    if (opensCounter) {
      const start = Number(attr(el, 'start') ?? '1');
      this._counters.push(Number.isFinite(start) ? start : 1);
    }

    const childInFlex =
      style.display === 'flex' || style.display === 'inline-flex';
    this._depth += 1;
    this._children(el, box, style, childInFlex, el);
    this._depth -= 1;

    if (opensCounter) this._counters.pop();
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
    if (style.position === 'absolute' || style.position === 'fixed')
      box.outOfFlow = true;
    else if (style.float !== 'none') box.isFloat = true;

    if (replaced === 'image') {
      // Both sources are CSS pixels — an image pixel is one, and so is an
      // attribute — and the box is device.
      const scale = this._options.scale ?? 1;
      const loaded = this._options.imageSize(el);
      if (loaded) {
        box.intrinsicWidth = loaded.width * scale;
        box.intrinsicHeight = loaded.height * scale;
      } else {
        // An image that has not arrived still needs a box, or the document
        // reflows under the reader when it does. The attributes are the
        // author telling us the size in advance; without them the box is a
        // small placeholder rather than nothing.
        box.intrinsicWidth = (numberAttr(el, 'width') ?? 0) * scale;
        box.intrinsicHeight = (numberAttr(el, 'height') ?? 0) * scale;
      }
      // The alt text joins the document text, so a document read with the
      // images blocked still copies as prose.
      const alt = attr(el, 'alt');
      if (alt) this._push(alt, box);
      return;
    }

    if (replaced === 'hr') return;

    const size = this._options.controlSize(el, replaced, style);
    box.intrinsicWidth = size.width;
    box.intrinsicHeight = size.height;
    this._controls.push(box);
    // A control's value is the widget's, not the document's: putting it in
    // the selection index would make Ctrl+A copy the contents of every text
    // field, which no document viewer does.
  }

  /** A text node, whitespace-processed per the inherited `white-space`. */
  private _textNode(
    data: string,
    into: Box,
    style: ComputedStyle,
    owner: Element | null,
  ): void {
    const ws = style.whiteSpace;
    let text: string;
    if (ws === 'pre' || ws === 'pre-wrap') {
      text = data;
    } else if (ws === 'pre-line') {
      text = data.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
    } else {
      text = data.replace(/[\t\n\r\f ]+/g, ' ');
      // A run of whitespace against the start of a block collapses away
      // entirely; between two inline boxes it collapses to one space, which
      // the replace above already did.
      if (text === ' ' && !hasInlineContent(into)) return;
    }
    if (!text) return;
    text = transformText(text, style.textTransform);
    // The owning element rides on the text box, and from there onto the
    // `TextRun`: hit testing inside a paragraph has no rectangle to test —
    // an inline box is the runs on its lines — so the run is what has to
    // know whose text it is.
    const box = new Box('text', owner, style);
    box.text = text;
    into.append(box);
    this._push(text, box);
  }

  /** Give a box its slice of the document text index. */
  private _push(text: string, box: Box): void {
    box.textStart = this._text.length;
    this._text += text;
    box.textEnd = this._text.length;
    if (box.kind === 'text') this._textBoxes.push(box);
  }
}

/** Whether the parsed document has a `<body>`. htmlparser2 does not
 *  synthesise one — it parses what it was given — so a fragment has none,
 *  and the root box stands in for it. */
function hasBody(root: Element | { children: unknown }): boolean {
  for (const child of childrenOf(root as Element)) {
    if (!isElement(child)) continue;
    const tag = tagOf(child);
    if (tag === 'body') return true;
    if (tag === 'html' && hasBody(child)) return true;
  }
  return false;
}

function numberAttr(el: Element, name: string): number | null {
  const raw = attr(el, name);
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function hasInlineContent(box: Box): boolean {
  for (let i = box.children.length - 1; i >= 0; i -= 1) {
    const kind = box.children[i].kind;
    if (kind === 'text' || kind === 'inline' || kind === 'replaced')
      return true;
    if (kind === 'block' || kind === 'flex' || kind === 'table') return false;
  }
  return false;
}

function transformText(
  text: string,
  transform: ComputedStyle['textTransform'],
): string {
  switch (transform) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize':
      return text.replace(
        /(^|\s)(\S)/g,
        (_, sp: string, c: string) => sp + c.toUpperCase(),
      );
    default:
      return text;
  }
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

function replacedKind(el: Element, tag: string): ReplacedKind {
  switch (tag) {
    case 'img':
      return 'image';
    case 'hr':
      return 'hr';
    case 'textarea':
      return 'textarea';
    case 'select':
      return 'select';
    case 'button':
      return 'button';
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

const ROMAN: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

/**
 * The marker a `list-item` draws. The counter is the *builder's*, not the
 * element's, because `value` on an `<li>` restarts it and a nested list has
 * its own — both of which are lost if the number is derived from the index
 * of the child in its parent.
 */
function markerFor(
  el: Element,
  style: ComputedStyle,
  counters: number[],
): string {
  const type = style.listStyleType;
  if (type === 'none') return '';
  const depth = counters.length;
  if (depth) {
    const value = numberAttr(el, 'value');
    if (value !== null) counters[depth - 1] = value;
  }
  const n = depth ? counters[depth - 1]++ : 1;
  switch (type) {
    case 'decimal':
      return `${n}.`;
    case 'decimal-leading-zero':
      return `${n < 10 ? '0' : ''}${n}.`;
    case 'lower-alpha':
    case 'lower-latin':
      return `${alpha(n).toLowerCase()}.`;
    case 'upper-alpha':
    case 'upper-latin':
      return `${alpha(n)}.`;
    case 'lower-roman':
      return `${roman(n)}.`;
    case 'upper-roman':
      return `${roman(n).toUpperCase()}.`;
    case 'circle':
      return '◦';
    case 'square':
      return '▪';
    case 'disc':
    default:
      return '•';
  }
}

function alpha(n: number): string {
  let out = '';
  let v = Math.max(1, n);
  while (v > 0) {
    const rem = (v - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    v = Math.floor((v - 1) / 26);
  }
  return out;
}

function roman(n: number): string {
  let v = Math.max(1, Math.min(3999, n));
  let out = '';
  for (const [value, sym] of ROMAN) {
    while (v >= value) {
      out += sym;
      v -= value;
    }
  }
  return out;
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
function fixUp(box: Box): void {
  for (const child of box.children) fixUp(child);

  if (box.kind === 'table') {
    fixUpTable(box);
    return;
  }
  if (box.kind === 'table-row-group') {
    wrapOrphans(box, 'table-row', (k) => k === 'table-row');
    return;
  }
  if (box.kind === 'table-row') {
    wrapOrphans(box, 'table-cell', (k) => k === 'table-cell');
    return;
  }

  if (!box.children.length) return;
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
  for (const child of box.children) {
    // A float or an absolutely positioned box sits in whichever context it
    // finds itself; it does not force an anonymous block on its own.
    if (isBlockLevel(child) && !child.outOfFlow && !child.isFloat) {
      if (run) {
        next.push(anonymousBlock(box, run));
        run = null;
      }
      next.push(child);
      continue;
    }
    // Whitespace between two blocks is not content and must not generate a
    // line box — `<div><p>a</p> <p>b</p></div>` has no blank line in it.
    if (!run && child.kind === 'text' && !child.text.trim()) continue;
    (run ??= []).push(child);
  }
  if (run) {
    if (run.every((c) => c.kind === 'text' && !c.text.trim())) {
      // trailing whitespace after the last block: same rule
    } else {
      next.push(anonymousBlock(box, run));
    }
  }
  box.children = next;
}

function anonymousBlock(parent: Box, run: Box[]): Box {
  const box = new Box('block', null, parent.style);
  box.parent = parent;
  for (const child of run) {
    child.parent = box;
    box.children.push(child);
  }
  return box;
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
): void {
  let needed = false;
  for (const child of box.children) {
    if (!accept(child.kind) && !isDroppableWhitespace(child)) {
      needed = true;
      break;
    }
  }
  if (!needed) return;
  const next: Box[] = [];
  let run: Box[] | null = null;
  for (const child of box.children) {
    if (accept(child.kind)) {
      if (run) {
        next.push(anonymousOf(box, kind, run));
        run = null;
      }
      next.push(child);
      continue;
    }
    if (isDroppableWhitespace(child)) continue;
    (run ??= []).push(child);
  }
  if (run) next.push(anonymousOf(box, kind, run));
  box.children = next;
}

function anonymousOf(parent: Box, kind: BoxKind, run: Box[]): Box {
  const box = new Box(kind, null, parent.style);
  box.parent = parent;
  for (const child of run) {
    child.parent = box;
    box.children.push(child);
  }
  return box;
}

function isDroppableWhitespace(box: Box): boolean {
  return box.kind === 'text' && !box.text.trim();
}

function fixUpTable(table: Box): void {
  const groups: Box[] = [];
  const captions: Box[] = [];
  let looseRows: Box[] | null = null;
  for (const child of table.children) {
    if (child.kind === 'table-row-group') {
      if (looseRows) {
        groups.push(anonymousOf(table, 'table-row-group', looseRows));
        looseRows = null;
      }
      groups.push(child);
    } else if (child.kind === 'table-caption') {
      captions.push(child);
    } else if (isDroppableWhitespace(child)) {
      continue;
    } else {
      // A `<tr>`, or anything else that ended up here: rows go into an
      // anonymous group, and anything that is not a row becomes a cell in
      // one, which is how a browser rescues `<table>text</table>`.
      const row =
        child.kind === 'table-row'
          ? child
          : anonymousOf(table, 'table-row', [child]);
      (looseRows ??= []).push(row);
    }
  }
  if (looseRows) groups.push(anonymousOf(table, 'table-row-group', looseRows));
  for (const group of groups) {
    wrapOrphans(group, 'table-row', (k) => k === 'table-row');
    for (const row of group.children) {
      wrapOrphans(row, 'table-cell', (k) => k === 'table-cell');
    }
  }
  table.children = [...captions, ...groups];
  for (const child of table.children) child.parent = table;
}
