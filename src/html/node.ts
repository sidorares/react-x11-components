// `<htmlview>` — the retained element behind `<Html>`.
//
// It owns the whole pipeline and, more importantly, owns **when each stage
// runs**. That is the component's reason to exist, so it is worth stating in
// one place:
//
//   source changed      → parse (incrementally), style, box, lay out, paint
//   stylesheet arrived  → style, box, lay out, paint
//   DOM mutated         → box, lay out, paint
//   width changed       → lay out, paint          (no parse, no cascade)
//   media band crossed  → style, box, lay out, paint
//   scrolled / exposed  → paint, culled to the damage rect
//
// Each row is strictly cheaper than the one above it, and the two the
// component is measured on — first content painted, and what an expose or a
// resize costs — are the two cheapest. Nothing in a computed style depends on
// the width (see css/values.ts) and nothing in a box tree depends on the
// scroll, which is what makes the table true rather than aspirational.
//
// **Why one element rather than a tree of `<box>`es and `<richtext>`s**, the
// way `<Markdown>` is built. Two reasons, and the second is the load-bearing
// one:
//
//  1. A document of any size is thousands of elements. Reconciling them
//     through React and laying them out through yoga, per keystroke of a
//     streaming document, is the cost this is trying not to pay.
//  2. **CSS layout is not the host's layout.** react-x11 lays out with yoga,
//     which is flexbox; block flow with margin collapsing, floats, an inline
//     formatting context and table column sizing are not expressible in it.
//     Composing would mean approximating the layout model, which is what
//     ntk's `HtmlView` did and what makes it hard to trust. So the element
//     draws — the same call `<Flow>` makes for a different reason — and the
//     things that must be real widgets (form controls) are mounted beside it
//     rather than inside it.
//
// What is reused from `<richtext>` is everything that was not about the
// element: the `TextRun` vocabulary, the per-run decoration painter, and the
// bidi-correct selection bands. See `src/richtext/runs.ts`.
import { registerElement, registeredElements } from 'react-x11/host';
import { Node } from 'react-x11/node';
import type {
  Context2D,
  MeasureConstraints,
  MeasuredSize,
} from 'react-x11/node';
import type { Rect } from 'react-x11';
import type { Style } from 'react-x11/style';
import type { Element } from 'domhandler';

import { codePointAtOffset, codeUnitOffsets } from '../internal/text.js';
import { attr, HtmlSource, isElement, tagOf } from './dom.js';
import type { Document } from './dom.js';
import { Cascade } from './css/cascade.js';
import { parseStylesheet } from './css/parse.js';
import type { Stylesheet } from './css/parse.js';
import { uaStylesheet } from './css/ua.js';
import type { RootLook } from './css/style.js';
import { buildBoxes } from './layout/boxes.js';
import type { Box, BoxTree, ReplacedKind } from './layout/boxes.js';
import { layoutDocument } from './layout/block.js';
import type { FontsLike } from './layout/inline.js';
// Through the inline module rather than a second cache: the offsets table for
// a layout is built once, on the first selection that needs it.
import { layoutOffsets as layoutOffsetsOf } from './layout/inline.js';
import { lineBands as bandsFor } from '../richtext/runs.js';
import { paintDocument } from './paint.js';
import type { PaintContext } from './paint.js';
import { controlRectsOf, measureControl } from './controls.js';
import type { ControlRect } from './controls.js';
import { ResourceStore } from './resources.js';
import type { ResourceRequest, ResourceResult } from './resources.js';

/** The element name — registration key, `node.kind` and JSX tag alike. */
export const ELEMENT = 'htmlview';

/** The ntk connection a node is built against, derived from `Node`'s own
 *  constructor rather than named, so it cannot drift from core's. */
export type NtkApp = ConstructorParameters<typeof Node>[2];

/** What a `<script>` hands the host. Never parsed and never evaluated —
 *  the seam exists so an application can decide, not so this can pretend. */
export interface ScriptRequest {
  /** The `type` attribute, lowercased; `'text/javascript'` when absent. */
  type: string;
  /** `src`, for an external script. */
  src: string | null;
  /** The element's text, for an inline one. Handed over verbatim. */
  text: string;
  element: Element;
}

export interface HtmlViewProps {
  source: string;
  /** False while more source may still arrive. */
  complete?: boolean;
  /** Author stylesheets applied after the document's own. */
  stylesheet?: string | string[];
  look: RootLook;
  selectionColor?: string;
  onResource?: (
    request: ResourceRequest,
  ) => Promise<ResourceResult | null> | ResourceResult | null;
  onScript?: (script: ScriptRequest) => void;
  /** Where the real widgets go, in the element's own coordinates. */
  onControls?: (rects: ControlRect[]) => void;
  /** The parsed document, once per parse — the DOM handle. */
  onDocument?: (document: Document) => void;
  /** Bumped by the component to force a re-read of a mutated DOM. */
  domRevision?: number;
  style?: Style | Style[];
}

export function registerHtmlView(): void {
  if (registeredElements().includes(ELEMENT)) return;
  registerElement(ELEMENT, {
    create: (props, app) => new HtmlViewNode(props, app),
    // `source` and `look` are this element's own vocabulary and neither is a
    // style name today; declaring them keeps the DEV flat-style-prop
    // assertion honest if core's vocabulary grows underneath us.
    semanticNames: ['source', 'look', 'stylesheet', 'complete'],
    childrenAllowed: false,
  });
}

/** What changed, and therefore how far back up the pipeline to go. */
const enum Stale {
  Nothing = 0,
  Layout = 1,
  Boxes = 2,
  Style = 3,
  Everything = 4,
}

export class HtmlViewNode extends Node {
  private _source = new HtmlSource();
  private _resources: ResourceStore;
  private _cascade: Cascade | null = null;
  private _tree: BoxTree | null = null;
  private _stale: Stale = Stale.Everything;
  private _laidOutAt = -1;
  private _mediaBand = -1;
  private _documentHeight = 0;
  private _documentWidth = 0;
  private _textPoints: number[] | null = null;
  private _hovered: Element[] = [];
  private _scriptsSeen = new WeakSet<Element>();
  private _controls: ControlRect[] = [];
  private _reportedDomRevision = -1;

  constructor(props: Record<string, unknown>, app: NtkApp) {
    super(ELEMENT, props, app);
    this._resources = new ResourceStore(
      (request) => this._props().onResource?.(request) ?? null,
      () => {
        // A late resource changes intrinsic sizes, so the box tree is what
        // has to be rebuilt — not merely repainted. An image that arrives
        // after first paint is the ordinary case, not an error path.
        this._invalidate(Stale.Boxes);
      },
    );
    this._read();
  }

  private _props(): HtmlViewProps {
    return this.props as unknown as HtmlViewProps;
  }

  // --- the pipeline ---------------------------------------------------------

  private _invalidate(stale: Stale): void {
    if (stale > this._stale) this._stale = stale;
    if (stale >= Stale.Layout) this.invalidateMeasure('content');
    this.invalidate(stale >= Stale.Layout, this, 'props');
  }

  /** Take the props' source into the parser. Cheap when nothing changed, and
   *  an append when the new source extends the old — see `HtmlSource`. */
  private _read(): void {
    const props = this._props();
    const changed = this._source.setSource(
      props.source ?? '',
      props.complete !== false,
    );
    if (changed) {
      this._invalidate(Stale.Style);
      props.onDocument?.(this._source.document);
      this._reportedDomRevision = props.domRevision ?? 0;
    }
    this._sweep();
  }

  /**
   * Hand the document's own declarations to the host: every `<script>` once,
   * and every resource that has not been asked for.
   *
   * Scripts are **never parsed and never run**. The seam is the whole of the
   * feature: an application that wants scripting brings its own engine and
   * its own policy, and one that does not gets a document that cannot
   * surprise it. There is no configuration in between, because a renderer
   * that half-runs a script is a renderer nobody can reason about.
   */
  private _sweep(): void {
    const props = this._props();
    const facts = this._source.facts();
    if (props.onScript) {
      for (const el of facts.scripts) {
        if (this._scriptsSeen.has(el)) continue;
        this._scriptsSeen.add(el);
        props.onScript({
          type: (attr(el, 'type') ?? 'text/javascript').toLowerCase(),
          src: attr(el, 'src') ?? null,
          text: textOf(el),
          element: el,
        });
      }
    }
    for (const el of facts.resources) {
      const tag = tagOf(el);
      const url = tag === 'link' ? attr(el, 'href') : attr(el, 'src');
      if (!url) continue;
      this._resources.request({
        url,
        kind: tag === 'link' ? 'stylesheet' : 'image',
        element: el,
      });
    }
  }

  /** Rebuild the cascade — the document's sheets plus the host's. */
  private _restyle(width: number): void {
    const props = this._props();
    const sheets: Stylesheet[] = [uaStylesheet(props.look)];
    let order = 0;
    for (const ref of this._source.facts().sheets) {
      const text =
        ref.kind === 'inline'
          ? ref.text
          : this._resources.stylesheetText(ref.href);
      if (!text) continue;
      const sheet = parseStylesheet(text, order);
      order += sheet.rules.length + 1;
      // `@import` is a resource like any other, and its rules sit *before*
      // the importing sheet's — so a fetched import is spliced in ahead.
      for (const url of sheet.imports) {
        this._resources.request({
          url,
          kind: 'stylesheet',
          element: ref.element,
        });
        const imported = this._resources.stylesheetText(url);
        if (imported) {
          const parsed = parseStylesheet(imported, order);
          order += parsed.rules.length + 1;
          sheets.push(parsed);
        }
      }
      sheets.push(sheet);
    }
    const extra = props.stylesheet;
    for (const text of Array.isArray(extra) ? extra : extra ? [extra] : []) {
      const sheet = parseStylesheet(text, order);
      order += sheet.rules.length + 1;
      sheets.push(sheet);
    }
    this._cascade = new Cascade(
      sheets,
      props.look,
      width,
      this._viewportHeight(),
    );
    this._cascade.setPointer({
      hovered: new Set(this._hovered),
      active: EMPTY_SET,
    });
    this._mediaBand = this._cascade.mediaBand(width);
  }

  private _viewportHeight(): number {
    // The viewport a `vh` resolves against is the window's, not the
    // document's — a document taller than the window does not make `100vh`
    // taller with it.
    const root = this.root;
    const height = root?.abs?.height;
    return height && height > 0 ? height : 600;
  }

  private _fonts(): FontsLike | null {
    const fonts = (this.app as { fonts?: FontsLike } | null)?.fonts;
    return fonts ?? null;
  }

  /** Bring the pipeline up to date for a width. */
  private _prepare(width: number): void {
    const target = Math.max(1, Math.floor(width));
    const props = this._props();
    if ((props.domRevision ?? 0) !== this._reportedDomRevision) {
      this._reportedDomRevision = props.domRevision ?? 0;
      this._source.touch();
      this._sweep();
      if (this._stale < Stale.Style) this._stale = Stale.Style;
    }
    if (this._stale === Stale.Nothing && this._laidOutAt === target) return;

    if (this._stale >= Stale.Style || !this._cascade) {
      this._restyle(target);
      this._stale = Math.max(this._stale, Stale.Boxes) as Stale;
    } else if (this._cascade.mediaBand(target) !== this._mediaBand) {
      // A resize that crossed a `@media` breakpoint is the one resize that
      // does have to restyle. Knowing which resizes those are is why the
      // breakpoints are collected at parse time.
      this._restyle(target);
      this._stale = Math.max(this._stale, Stale.Boxes) as Stale;
    }

    const cascade = this._cascade;
    if (!cascade) return;
    cascade.viewportWidth = target;
    cascade.viewportHeight = this._viewportHeight();

    if (this._stale >= Stale.Boxes || !this._tree) {
      const props = this._props();
      this._tree = buildBoxes(this._source.document, {
        cascade,
        imageSize: (el) => this._resources.imageSize(attr(el, 'src') ?? ''),
        controlSize: (el, kind, style) =>
          measureControl(el, kind, style, this._fonts(), props.look),
      });
      this._textPoints = null;
      this._laidOutAt = -1;
    }

    if (
      this._tree &&
      (this._laidOutAt !== target || this._stale >= Stale.Layout)
    ) {
      const result = layoutDocument(
        this._tree,
        this._fonts(),
        target,
        this._viewportHeight(),
      );
      this._documentWidth = result.width;
      this._documentHeight = result.height;
      this._laidOutAt = target;
      this._reportControls();
    }
    this._stale = Stale.Nothing;
  }

  private _reportControls(): void {
    const tree = this._tree;
    const report = this._props().onControls;
    if (!tree || !report) return;
    const rects = controlRectsOf(tree);
    if (sameRects(rects, this._controls)) return;
    this._controls = rects;
    report(rects);
  }

  // --- core's questions -----------------------------------------------------

  /**
   * The size the document comes to at the offered width.
   *
   * The element sizes to its content and the application scrolls it — a
   * `<box overflow="scroll">` around it, the same shape `<Markdown>` uses.
   * That keeps the form controls mounted beside it scrolling with it for
   * free, and core's scroller already blits. Virtualizing a document taller
   * than X11's 16-bit coordinate space is the phase-2 work; see the PRD.
   */
  override measureContent({ width }: MeasureConstraints): MeasuredSize {
    const offered = Number.isFinite(width) ? width : 800;
    this._prepare(offered);
    return {
      width: Math.ceil(Math.min(this._documentWidth, offered)),
      height: Math.ceil(this._documentHeight),
    };
  }

  override applyProps(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): void {
    super.applyProps(nextProps, prevProps);
    const next = nextProps as unknown as HtmlViewProps;
    const prev = prevProps as unknown as HtmlViewProps;
    if (next.look !== prev.look || next.stylesheet !== prev.stylesheet) {
      this._invalidate(Stale.Style);
    }
    if (next.source !== prev.source || next.complete !== prev.complete) {
      this._read();
    } else if ((next.domRevision ?? 0) !== (prev.domRevision ?? 0)) {
      this._invalidate(Stale.Style);
    }
  }

  override destroySubtree(): void {
    this._resources.destroy();
    this._source.destroy();
    this._tree = null;
    this._cascade = null;
    super.destroySubtree();
  }

  // --- answering for our own text -------------------------------------------
  //
  // The four accessors from react-x11#291, over the whole document at once.
  // A single element answering for every paragraph is what makes a drag from
  // the first heading to the last table cell one contiguous selection with no
  // per-block plumbing — and it is only possible because the box tree already
  // gave every piece of text its slice of one index.
  //
  // Core counts in **code points**; the boxes count in code units, because
  // that is what ntk's run geometry speaks. The conversion is here, once.

  override textContent(): string {
    return this._tree?.text ?? '';
  }

  private _points(): number[] {
    if (!this._textPoints)
      this._textPoints = codeUnitOffsets(this.textContent());
    return this._textPoints;
  }

  private _toUnits(codePoint: number): number {
    const offsets = this._points();
    const at = Math.max(0, Math.min(codePoint, offsets.length - 1));
    return offsets[at];
  }

  private _toPoints(codeUnit: number): number {
    return codePointAtOffset(this._points(), codeUnit);
  }

  override textIndexAt(x: number, y: number): number {
    const tree = this._tree;
    if (!tree) return 0;
    const local = this._toDocument(x, y);
    const hit = nearestText(tree.root, local.x, local.y);
    if (!hit) return 0;
    return this._toPoints(hit);
  }

  override textCaretRect(index: number): Rect | null {
    const tree = this._tree;
    if (!tree) return null;
    const units = this._toUnits(index);
    const found = caretAt(tree.root, units);
    if (!found) return null;
    return {
      x: this.abs.x + found.x,
      y: this.abs.y + found.y,
      width: 0,
      height: found.height,
    };
  }

  override textRangeRects(start: number, end: number): Rect[] {
    const tree = this._tree;
    if (!tree) return [];
    const from = this._toUnits(start);
    const to = this._toUnits(end);
    if (to <= from) return [];
    const out: Rect[] = [];
    collectBands(tree.root, from, to, this.abs.x, this.abs.y, out);
    return out;
  }

  // --- pointer --------------------------------------------------------------

  /** The link under a point, if any. Not part of the selection seam: core
   *  deliberately left hover and `cursorAt` out of #291, so following a link
   *  stays this package's. */
  hrefAtPoint(x: number, y: number): string | null {
    const el = this.elementAtPoint(x, y);
    let node: Element | null = el;
    while (node) {
      const href = attr(node, 'href');
      if (href && (tagOf(node) === 'a' || tagOf(node) === 'area')) return href;
      node = isElement(node.parent) ? node.parent : null;
    }
    return null;
  }

  /** The deepest element whose box contains a window-space point. */
  elementAtPoint(x: number, y: number): Element | null {
    const tree = this._tree;
    if (!tree) return null;
    const local = this._toDocument(x, y);
    return deepestAt(tree.root, local.x, local.y);
  }

  /**
   * The pointer moved. Returns true when the cascade's answer could have
   * changed, so the caller knows whether to invalidate — which it only ever
   * does for a document that actually contains a `:hover` rule.
   */
  setHover(x: number, y: number): boolean {
    const cascade = this._cascade;
    if (!cascade || !cascade.hoverSensitive) return false;
    const chain: Element[] = [];
    let node = this.elementAtPoint(x, y);
    while (node) {
      chain.push(node);
      node = isElement(node.parent) ? node.parent : null;
    }
    if (sameChain(chain, this._hovered)) return false;
    this._hovered = chain;
    cascade.setPointer({ hovered: new Set(chain), active: EMPTY_SET });
    this._invalidate(Stale.Boxes);
    return true;
  }

  clearHover(): boolean {
    if (!this._hovered.length) return false;
    this._hovered = [];
    this._cascade?.setPointer({ hovered: new Set(), active: EMPTY_SET });
    this._invalidate(Stale.Boxes);
    return true;
  }

  /** The document, for an application that wants to read or change it. */
  get document(): Document {
    return this._source.document;
  }

  /**
   * An application changed the DOM under us. Restyles, re-lays-out and
   * repaints — everything but the parse, which nothing that happened to the
   * tree can invalidate.
   *
   * Explicit rather than observed: see `HtmlHandle.refresh`.
   */
  touchDocument(): void {
    this._source.touch();
    this._sweep();
    this._invalidate(Stale.Style);
  }

  /** The document's `<title>`, when it had one. */
  get title(): string | null {
    return this._source.facts().title;
  }

  private _toDocument(x: number, y: number): { x: number; y: number } {
    return { x: x - this.abs.x, y: y - this.abs.y };
  }

  // --- paint ----------------------------------------------------------------

  override paint(ctx: Context2D): void {
    super.paint(ctx); // background, border, clip to `abs`
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    if (!tree) return;
    const range = this.selectionRange;
    paintDocument(ctx as PaintContext, tree, {
      originX: this.abs.x,
      originY: this.abs.y,
      // Culling against the damage is what makes an expose of a strip cost
      // the strip rather than the document; `paintDamage()` is null when the
      // whole window is being repainted, which means "nothing bounds you".
      damage: this.paintDamage(),
      selection: range
        ? { start: this._toUnits(range.start), end: this._toUnits(range.end) }
        : null,
      selectionColor: this.selectionColor,
      imageFor: (box) =>
        this._resources.image(attr(box.el as Element, 'src') ?? ''),
    });
  }
}

const EMPTY_SET: ReadonlySet<Element> = new Set();

function textOf(el: Element): string {
  let out = '';
  for (const child of el.children) {
    if (child.type === 'text') out += child.data;
  }
  return out;
}

function sameChain(a: Element[], b: Element[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function sameRects(a: ControlRect[], b: ControlRect[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const p = a[i];
    const q = b[i];
    if (
      p.element !== q.element ||
      p.x !== q.x ||
      p.y !== q.y ||
      p.width !== q.width ||
      p.height !== q.height
    ) {
      return false;
    }
  }
  return true;
}

// --- walks over the laid-out tree -------------------------------------------

/** The code-unit offset nearest a document-space point. */
function nearestText(box: Box, x: number, y: number): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;

  const visit = (node: Box): void => {
    if (node.lines) {
      for (const line of node.lines) {
        const dy =
          y < line.y
            ? line.y - y
            : y > line.y + line.height
              ? y - (line.y + line.height)
              : 0;
        for (const text of line.texts) {
          const natural = text.layout.lines[text.layoutLine];
          if (!natural) continue;
          const left = text.drawX + natural.x;
          const dx =
            x < left
              ? left - x
              : x > left + natural.width
                ? x - (left + natural.width)
                : 0;
          const distance = dy * 4 + dx;
          if (distance >= bestDistance) continue;
          bestDistance = distance;
          const local = text.layout.indexAt(x - text.drawX, y - text.drawY);
          const offsets = layoutOffsetsOf(text.layout);
          const units = offsets.length
            ? offsets[Math.max(0, Math.min(local, offsets.length - 1))]
            : local;
          best = text.textStart + Math.max(0, units - text.layoutStart);
        }
        for (const placed of line.atomics) visit(placed.box);
      }
    }
    for (const child of node.children) {
      if (child.kind === 'text' || child.kind === 'break') continue;
      visit(child);
    }
  };
  visit(box);
  return best;
}

/** Where a caret at a code-unit offset stands, in document coordinates. */
function caretAt(
  box: Box,
  units: number,
): { x: number; y: number; height: number } | null {
  let found: { x: number; y: number; height: number } | null = null;
  const visit = (node: Box): void => {
    if (found) return;
    if (node.lines) {
      for (const line of node.lines) {
        for (const text of line.texts) {
          if (units < text.textStart || units > text.textEnd) continue;
          const offsets = layoutOffsetsOf(text.layout);
          const layoutUnits = text.layoutStart + (units - text.textStart);
          const caret = text.layout.caretPosition(
            codePointAtOffset(offsets, layoutUnits),
          );
          found = {
            x: text.drawX + caret.x,
            y: line.y,
            height: line.height,
          };
          return;
        }
        for (const placed of line.atomics) visit(placed.box);
        if (found) return;
      }
    }
    for (const child of node.children) {
      if (child.kind === 'text' || child.kind === 'break') continue;
      visit(child);
      if (found) return;
    }
  };
  visit(box);
  return found;
}

/** Every band a document range covers, in window coordinates. */
function collectBands(
  box: Box,
  from: number,
  to: number,
  dx: number,
  dy: number,
  out: Rect[],
): void {
  if (box.lines) {
    for (const line of box.lines) {
      if (line.textEnd > from && line.textStart < to) {
        for (const text of line.texts) {
          const natural = text.layout.lines[text.layoutLine];
          if (!natural) continue;
          const a = Math.max(from, text.textStart);
          const b = Math.min(to, text.textEnd);
          if (b <= a) continue;
          const offsets = layoutOffsetsOf(text.layout);
          for (const band of bandsFor(
            text.layout,
            natural,
            offsets,
            text.layoutStart + (a - text.textStart),
            text.layoutStart + (b - text.textStart),
          )) {
            out.push({
              x: dx + band.x + text.drawX,
              y: dy + line.y,
              width: band.width,
              height: line.height,
            });
          }
        }
      }
      for (const placed of line.atomics)
        collectBands(placed.box, from, to, dx, dy, out);
    }
  }
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    collectBands(child, from, to, dx, dy, out);
  }
}

/** The deepest element box containing a document-space point. */
function deepestAt(box: Box, x: number, y: number): Element | null {
  let found: Element | null = box.el;
  const visit = (node: Box): void => {
    for (const child of node.children) {
      if (child.kind === 'text' || child.kind === 'break') continue;
      if (
        x >= child.x &&
        x < child.x + child.width &&
        y >= child.y &&
        y < child.y + child.height
      ) {
        if (child.el) found = child.el;
        visit(child);
      }
    }
    if (node.lines) {
      for (const line of node.lines) {
        for (const placed of line.atomics) {
          if (
            x >= placed.box.x &&
            x < placed.box.x + placed.box.width &&
            y >= placed.box.y &&
            y < placed.box.y + placed.box.height
          ) {
            if (placed.box.el) found = placed.box.el;
            visit(placed.box);
          }
        }
        // An inline box has no box of its own — its extent is the runs on
        // this line — so the element under a point inside a paragraph is
        // found from the run rather than from a rectangle.
        if (y >= line.y && y < line.y + line.height) {
          for (const text of line.texts) {
            const natural = text.layout.lines[text.layoutLine];
            if (!natural) continue;
            for (const run of natural.runs) {
              const left = text.drawX + natural.x + run.x;
              if (x >= left && x < left + run.width) {
                const owner = (run.span as { element?: Element }).element;
                if (owner) found = owner;
              }
            }
          }
        }
      }
    }
  };
  visit(box);
  return found;
}

export type { ControlRect, ReplacedKind, ResourceRequest, ResourceResult };
