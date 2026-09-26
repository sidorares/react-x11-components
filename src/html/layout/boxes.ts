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
import type { Cascade, FirstLetterRules } from '../css/cascade.js';
import type { CollapsedTable } from './collapse.js';
import { counterText, quoteAt } from '../css/content.js';
import type { ContentItem } from '../css/content.js';
import { inherit } from '../css/style.js';
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
  /** Any offset in the layout's own text as a document index — how a run
   *  under the pointer finds the element whose text it is. Per pass: the
   *  layout may be one an earlier pass made (`TextLayoutCache`), and the
   *  document index is this parse's. */
  spans: {
    documentAt(offset: number): number;
    /** The text box an offset's text is, where the layout knows. */
    boxAt?(offset: number): Box | null;
  };
}

export interface AtomicPlacement {
  box: Box;
  x: number;
  y: number;
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
  /** An inline box with a background or a border to paint behind its
   *  fragments, and the ascent and descent of its own face — the height CSS
   *  paints them over (10.6.1). Set by the inline layout. */
  decorated = false;
  contentAscent = 0;
  contentDescent = 0;
  /** What a percentage `height` resolves against: an absolutely positioned
   *  box's containing block's height, which is known before the box is laid
   *  out (CSS 2.1 10.5). NaN everywhere else, where that height depends on
   *  the content and a percentage is `auto`. */
  percentHeightBase = NaN;
  /** Whether this box's top margin collapsed through its parent's top edge
   *  and was spent placing the parent (CSS 2.1 8.3.1): its own layout puts
   *  it at the parent's content top, and applies no margin again. Set by
   *  the parent's flow each pass. */
  topAbsorbed = false;

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
  /** Which of an element's pseudo-elements this box is. Its `el` is null —
   *  it is no element — and its text box's is the element it hangs off, so
   *  a click on a link's generated text or first letter is a click on the
   *  link. */
  pseudo: 'before' | 'after' | 'first-letter' | null = null;
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
  /** Where an out-of-flow box would have been in the flow it was taken
   *  from — its static position (CSS 2.1 10.3.7, 10.6.4) — as an offset
   *  from the box that flow is in, which may yet move. */
  staticFrom: Box | null = null;
  staticX = 0;
  staticRight = 0;
  staticY = 0;

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
  /** An `<iframe>`, `<video>` or `<embed>`: what it would show is never
   *  loaded, so it is a box of its size with nothing in it. */
  | 'frame';

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

/** The sharing key the root box's children share under: one root style per
 *  build, and the shared styles last a build (`Cascade.beginSharing`). */
const ROOT_SHARE_KEY = 0;

class Builder {
  private _options: BuildOptions;
  /** The document text, in the pieces it was pushed in — joined once at the
   *  end, so that taking back a line's last space is not a copy of it. */
  private _chunks: string[] = [];
  private _length = 0;
  private _textBoxes: Box[] = [];
  private _controls: Box[] = [];
  private _links: Box[] = [];
  /** Counter stack for `<ol>` numbering, one entry per open list. */
  private _counters: number[] = [];
  /** The CSS counters in scope, for `counter()` in generated content. */
  private _scopes = new CounterScopes();
  /** How many quotes generated content has opened and not closed. */
  private _quoteDepth = 0;
  /** Where the inline content being built stands, for collapsing white
   *  space across element boundaries. */
  private _ws: Collapse = 'start';
  private _depth = 0;
  /** The `::first-letter` whose letter is still to come, for the block
   *  container whose first line has not begun. Null when there is none,
   *  and once anything but a letter begins that line. */
  private _firstLetter: LetterSearch | null = null;

  constructor(options: BuildOptions) {
    this._options = options;
  }

  run(root: Element): BoxTree {
    const cascade = this._options.cascade;
    cascade.beginSharing();
    const rootStyle = cascade.rootStyle(hasBody(root));
    const rootBox = new Box('block', null, rootStyle);
    // a fragment's root stands in for a `<body>`, counters and all
    if (rootStyle.counterReset || rootStyle.counterIncrement) {
      this._counterChanges(rootStyle);
    }
    // The DOM's `<html>`/`<body>` are ordinary elements with ordinary styles;
    // the box above them exists only to be the initial containing block, so
    // it carries no margins of its own and cannot collapse with anything.
    this._children(root, rootBox, rootStyle, false, null, ROOT_SHARE_KEY);
    this._endLine();
    fixUp(rootBox, anonymousStyles(cascade.initial));
    assignSubtreeRanges(rootBox);
    return {
      root: rootBox,
      text: this._chunks.join(''),
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
    owner: Element | null,
    parentKey: number,
  ): void {
    // CSS 2.1 17.2.1: a column group holds columns, and anything else in it
    // is not rendered
    const onlyColumns = parentStyle.display === 'table-column-group';
    for (const child of childrenOf(node as Element)) {
      if (isText(child)) {
        if (!onlyColumns) this._textNode(child.data, into, parentStyle, owner);
        continue;
      }
      if (!isElement(child)) continue;
      this._element(child, into, parentStyle, inFlex, parentKey, onlyColumns);
    }
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
    if (NON_RENDERED.has(tag)) return;

    // shared with every element that must compute the same style, which in
    // a long document is most of them (`Cascade.sharedStyleFor`)
    const { style, key } = this._options.cascade.sharedStyleFor(
      el,
      parentStyle,
      parentKey,
      inFlex,
    );
    if (style.display === 'none') return;
    if (onlyColumns && style.display !== 'table-column') return;
    // before anything else of the element's, including its `::before`,
    // and for the element whatever box it makes (CSS 2.1 12.4)
    if (style.counterReset || style.counterIncrement) {
      this._counterChanges(style);
    }

    // `<br>` is a line break rather than a box, and it is the one element
    // whose *absence* of a box still has to reach the inline layout.
    if (tag === 'br') {
      this._endLine();
      // the first line ends with no letter on it (CSS 2.1 5.12.2)
      this._abandonLetter();
      const box = new Box('break', el, style);
      into.append(box);
      this._push('\n', box);
      this._ws = 'start';
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

    // a column's content is not rendered at all (CSS 2.1 17.2.1)
    if (style.display === 'table-column') return;

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
    const flow = flowOf(style, box);
    const around = this._ws;
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
    this._depth += 1;
    // a counter reset in here reaches the element's later children and not
    // past its end; `::before` and `::after` are children like any other
    this._scopes.open();
    this._pseudo(el, 'before', style, box);
    this._children(el, box, style, childInFlex, el, key);
    this._pseudo(el, 'after', style, box);
    this._scopes.close();
    this._depth -= 1;
    this._letterAfter(flow, skipped, outerLetter, ownLetter);
    if (flow !== 'inline') this._endLine();
    this._ws = after(flow, this._ws, around);

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
    const flow = flowOf(style, box);
    if (flow === 'block') this._endLine();
    this._ws = after(flow, this._ws, this._ws);
    if (flow === 'atomic') this._abandonLetter();

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
    if (replaced === 'frame') {
      // HTML's default object size, in CSS pixels; `width` and `height`
      // attributes reach the style as presentational hints and win
      const scale = this._options.scale ?? 1;
      box.intrinsicWidth = 300 * scale;
      box.intrinsicHeight = 150 * scale;
      return;
    }

    const size = this._options.controlSize(el, replaced, style);
    box.intrinsicWidth = size.width;
    box.intrinsicHeight = size.height;
    this._controls.push(box);
    // A control's value is the widget's, not the document's: putting it in
    // the selection index would make Ctrl+A copy the contents of every text
    // field, which no document viewer does.
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
    // a column renders no content, and generated content is all it would
    // hold; in a column group it is not a column either (CSS 2.1 17.2.1)
    if (
      style.display === 'table-column' ||
      style.display === 'table-column-group' ||
      elementStyle.display === 'table-column-group'
    ) {
      return;
    }
    if (style.counterReset || style.counterIncrement) {
      this._counterChanges(style);
    }
    const box = new Box(boxKindFor(style.display), null, style);
    box.pseudo = which;
    into.append(box);
    if (style.position === 'absolute' || style.position === 'fixed')
      box.outOfFlow = true;
    else if (style.float !== 'none') box.isFloat = true;
    const text = this._generated(style.content as ContentItem[], style, el);
    const flow = flowOf(style, box);
    const around = this._ws;
    if (flow === 'block') this._endLine();
    if (flow !== 'inline') this._ws = 'start';
    // the first letter can be generated, and is looked for here as in an
    // element of the same display
    const outerLetter = this._firstLetter;
    const skipped = flow === 'out' || flow === 'atomic';
    if (skipped) this._firstLetter = null;
    else if (flow === 'block' && outerLetter) giveBack(outerLetter);
    if (text) this._textNode(text, box, style, el);
    this._letterAfter(flow, skipped, outerLetter, null);
    if (flow !== 'inline') this._endLine();
    this._ws = after(flow, this._ws, around);
  }

  /** `counter-reset`, then `counter-increment`, as CSS 2.1 orders them. */
  private _counterChanges(style: ComputedStyle): void {
    for (const { name, value } of style.counterReset ?? []) {
      this._scopes.reset(name, value);
    }
    for (const { name, value } of style.counterIncrement ?? []) {
      this._scopes.increment(name, value);
    }
  }

  /** What `content` comes to here, in document order: the quotes it opens
   *  and closes count for everything after it. */
  private _generated(
    items: ContentItem[],
    style: ComputedStyle,
    el: Element,
  ): string {
    let text = '';
    for (const item of items) {
      switch (item.kind) {
        case 'string':
          text += item.text;
          break;
        case 'attr':
          text += attr(el, item.name) ?? '';
          break;
        case 'counter':
          text += counterText(this._scopes.value(item.name), item.style);
          break;
        case 'counters':
          text += this._scopes
            .values(item.name)
            .map((v) => counterText(v, item.style))
            .join(item.separator);
          break;
        case 'open-quote':
          text += quoteAt(style.quotes, this._quoteDepth, 0);
          this._quoteDepth += 1;
          break;
        case 'close-quote':
          // a close with nothing open writes nothing and closes nothing
          if (this._quoteDepth > 0) {
            this._quoteDepth -= 1;
            text += quoteAt(style.quotes, this._quoteDepth, 1);
          }
          break;
        case 'no-open-quote':
          this._quoteDepth += 1;
          break;
        case 'no-close-quote':
          if (this._quoteDepth > 0) this._quoteDepth -= 1;
          break;
      }
    }
    return text;
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
          : data.replace(/[\t\n\r\f ]+/g, ' ');
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
    text = transformText(text, style.textTransform);
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
    if (letterStyle.float !== 'none') box.isFloat = true;
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
    if (this._ws !== 'space') return;
    this._ws = 'start';
    const box = this._textBoxes[this._textBoxes.length - 1];
    if (!box || box.textEnd !== this._length || !box.text.endsWith(' ')) {
      return;
    }
    box.text = box.text.slice(0, -1);
    box.textEnd -= 1;
    this._length -= 1;
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
    if (box.kind === 'text') this._textBoxes.push(box);
  }
}

/**
 * The CSS counters in scope as the builder walks the document (CSS 2.1
 * 12.4.1). A `counter-reset` makes an instance that reaches the element's
 * descendants and its later siblings, so the instance belongs to the level
 * the element is on — its parent's children — and goes when that level
 * closes; a later reset on the same level takes its place. `counter()` reads
 * the innermost instance and `counters()` all of them, outermost first. A
 * counter used where none is in scope is reset to 0 there, as though the
 * element had asked.
 */
class CounterScopes {
  /** Per name, its instances, outermost first, with the level each is on. */
  private _instances = new Map<string, { level: number; value: number }[]>();
  /** The names each open level made an instance of, so closing it drops
   *  exactly those. */
  private _made: string[][] = [[]];

  open(): void {
    this._made.push([]);
  }

  close(): void {
    const level = this._made.length - 1;
    for (const name of this._made.pop() ?? []) {
      const stack = this._instances.get(name);
      if (stack && stack[stack.length - 1]?.level === level) stack.pop();
    }
  }

  reset(name: string, value: number): void {
    const level = this._made.length - 1;
    let stack = this._instances.get(name);
    if (!stack) {
      stack = [];
      this._instances.set(name, stack);
    }
    const top = stack[stack.length - 1];
    if (top?.level === level) {
      top.value = value;
      return;
    }
    stack.push({ level, value });
    this._made[level].push(name);
  }

  increment(name: string, by: number): void {
    const stack = this._instances.get(name);
    if (!stack?.length) this.reset(name, 0);
    const innermost = this._instances.get(name)!;
    innermost[innermost.length - 1].value += by;
  }

  value(name: string): number {
    const stack = this._instances.get(name);
    if (stack?.length) return stack[stack.length - 1].value;
    this.reset(name, 0);
    return 0;
  }

  values(name: string): number[] {
    const stack = this._instances.get(name);
    if (stack?.length) return stack.map((instance) => instance.value);
    this.reset(name, 0);
    return [0];
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

/** Where the inline content being built stands, for white space: at the
 *  start of a line, just after a space that may collapse, or after anything
 *  else. */
type Collapse = 'start' | 'space' | 'content';

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
  switch (style.display) {
    case 'inline':
      return box.kind === 'replaced' ? 'atomic' : 'inline';
    case 'inline-block':
    case 'inline-table':
    case 'inline-flex':
      return 'atomic';
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
): Collapse {
  switch (flow) {
    case 'inline':
      return inside;
    case 'atomic':
      return 'content';
    case 'out':
      return before;
    default:
      return 'start';
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
    case 'iframe':
    case 'video':
    case 'embed':
      return 'frame';
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
function fixUp(box: Box, anonymous: AnonymousStyle): void {
  for (const child of box.children) fixUp(child, anonymous);

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
        next.push(anonymousOf(box, 'block', run, anonymous));
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
      next.push(anonymousOf(box, 'block', run, anonymous));
    }
  }
  box.children = next;
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
type AnonymousStyle = (
  parent: Box,
  display: ComputedStyle['display'],
) => ComputedStyle;

function anonymousStyles(initial: ComputedStyle): AnonymousStyle {
  const made = new WeakMap<ComputedStyle, Map<string, ComputedStyle>>();
  return (parent, display) => {
    let byDisplay = made.get(parent.style);
    if (!byDisplay) {
      byDisplay = new Map();
      made.set(parent.style, byDisplay);
    }
    let style = byDisplay.get(display);
    if (!style) {
      // `display` is the one property it does not start from: it is the
      // box the fix-up made, and layout asks the style what a box is
      style = { ...inherit(parent.style, initial), display };
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
      // under its images, stacks them
      return (
        box.style.display !== 'inline' &&
        !isInlineLevelDisplay(box.style.display)
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
  const next: Box[] = [];
  let run: Box[] | null = null;
  for (const child of box.children) {
    if (accept(child.kind)) {
      if (run) {
        next.push(anonymousOf(box, kind, run, anonymous));
        run = null;
      }
      next.push(child);
      continue;
    }
    if (isDroppableWhitespace(child)) continue;
    (run ??= []).push(child);
  }
  if (run) next.push(anonymousOf(box, kind, run, anonymous));
  box.children = next;
}

function anonymousOf(
  parent: Box,
  kind: BoxKind,
  run: Box[],
  anonymous: AnonymousStyle,
  display: ComputedStyle['display'] = kind as ComputedStyle['display'],
): Box {
  const box = new Box(kind, null, anonymous(parent, display));
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

/** A box that belongs inside a table: a row group, a row, a cell, a
 *  caption or a column. */
function isTablePart(box: Box): boolean {
  if (box.outOfFlow || box.isFloat) return false;
  const display = box.style.display;
  return (
    box.kind === 'table-row-group' ||
    box.kind === 'table-row' ||
    box.kind === 'table-cell' ||
    box.kind === 'table-caption' ||
    display === 'table-column' ||
    display === 'table-column-group'
  );
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
    if (display === 'table-column' || display === 'table-column-group') {
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
