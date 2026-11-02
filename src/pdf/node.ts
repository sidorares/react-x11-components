// The element behind `<Pdf>`: one node that draws a whole document.
//
// A document's viewport is a transform, so the element draws (see "Drawing
// beats composing" in AGENTS.md), and a page is pixels an engine made, so
// what it draws is tiles: PDFium is a thread away and draws a tile in a
// millisecond or two, and the only work here is putting the result on a
// `Surface` and compositing surfaces. That is `<Map>`'s shape, and for the
// same reason:
//
// - **A scroll draws nothing.** It is a blit and the strip it exposed.
// - **A zoom composites what there is**, scaled, and asks for the tiles of
//   the new scale once the wheel has rested.
// - **The queue is here and it is short.** At most `IN_FLIGHT` tiles are at
//   the engine, and what to ask for next is worked out from the view as each
//   lands, so a flick through a thousand pages leaves no thousand requests
//   behind it.
//
// Units are as `layout.ts` has them. A pane is logical, a tile and a paint
// are device pixels, and page text is points.
import { Node } from 'react-x11/node';
import { Surface } from 'react-x11/ntk';
import type { A11yTextState, Context2D } from 'react-x11/node';
import type { Rect } from 'react-x11';

import type { PageLink, PdfEngine, PdfInfo } from './engine.js';
import {
  clampZoom,
  currentPage,
  firstPageBelow,
  pagePixels,
  pagesIn,
  placePages,
  PX_PER_POINT,
  tilesCovering,
  TILE_SIZE,
  levelKey,
} from './layout.js';
import type {
  DocumentLayout,
  PageSize,
  PlacedPage,
  TileAddress,
  ViewRect,
} from './layout.js';
import {
  caretAt,
  indexPageText,
  lineAround,
  onText,
  rangeBands,
  wordAround,
} from './text.js';
import type { PageTextIndex } from './text.js';

/** The element name — registration key, `node.kind` and JSX tag alike. */
export const ELEMENT = 'pdfview';

/** The ntk connection a node is built against. */
export type NtkApp = ConstructorParameters<typeof Node>[2];

export type PdfFit = 'width' | 'page';

export interface PdfViewProps {
  engine?: PdfEngine | null;
  document?: PdfInfo | null;
  /** A number, or `'width'`/`'page'`, which follow the pane. */
  defaultZoom?: number | PdfFit;
  /** What shows between and around the pages. */
  ground?: string;
  /** What the scroll thumbs are drawn in. */
  thumb?: string;
  /** Logical pixels between pages. */
  gap?: number;
  /** What a surface cache may hold, in bytes. */
  cacheBytes?: number;
  onPageChange?: (page: number) => void;
  onZoomChange?: (zoom: number) => void;
  onLink?: (link: { url?: string; page?: number }) => void;
}

/** The props the node diffs itself, so a commit claims nothing for them. */
export const SELF_DAMAGED_PROPS = [
  'engine',
  'document',
  'defaultZoom',
  'onPageChange',
  'onZoomChange',
  'onLink',
] as const;

/** How many tiles the engine holds at once. Enough that a thread is never
 *  idle while one crosses, few enough that a flick leaves nothing behind. */
const IN_FLIGHT = 3;
/** The ground ahead of the view that is drawn before it is reached, in
 *  panes, each way. */
const AHEAD = 1;
/** How long a zoom has to rest before it is drawn at its own scale. */
const SETTLE_MS = 120;
/** A megabyte of surface a tile: 256 of them is twenty screens of a laptop at
 *  2x, or eight of a 4K display. */
const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;
/** A surface the same size saved from the cache: making one is three
 *  requests and a clear. */
const POOL = 32;
/** Page texts kept: each is some 40 bytes a character. */
const TEXTS = 48;
const DEFAULT_GAP = 12;
/** A notch of the wheel with Ctrl held. */
const ZOOM_STEP = 1.1;
const THUMB_WIDTH = 8;
const THUMB_MIN = 32;

/** The slice of the 2D context used here. Every backend's has `drawImage`;
 *  the mock's has neither that nor a `Surface`, which is what `_drawable`
 *  asks before anything is drawn. */
interface PdfCanvas {
  fillStyle: unknown;
  globalAlpha?: number;
  imageSmoothingEnabled?: boolean;
  imageSmoothingQuality?: string;
  fillRect?(x: number, y: number, width: number, height: number): void;
  drawImage?(image: unknown, ...args: number[]): void;
  putImageData?(data: unknown, x: number, y: number): void;
  save?(): void;
  restore?(): void;
  destroy?(): void;
}

interface SurfaceLike {
  bytes: number;
  getContext(name: '2d'): unknown;
  destroy(): void;
}

interface Tile {
  address: TileAddress;
  surface: SurfaceLike;
}

/** A place in the document's text. */
interface TextPlace {
  page: number;
  index: number;
}

export interface PdfViewStats {
  tilesDrawn: number;
  uploadMs: number;
  uploadMax: number;
  paints: number;
  paintMs: number;
  paintMax: number;
  tilesComposited: number;
  staleComposited: number;
  /** Paints that had to show part of a page without its tiles. */
  incomplete: number;
  /** `performance.now()` when the first view was whole. */
  wholeAt: number;
}

declare const setTimeout: (fn: () => void, ms: number) => { unref?(): void };
declare const clearTimeout: (id: unknown) => void;
declare const performance: { now(): number };

export class PdfViewNode extends Node {
  private _sizes: PageSize[] = [];
  private _handle = -1;
  private _layout: DocumentLayout = { pages: [], width: 0, height: 0, zoom: 1 };
  private _zoom = 1;
  private _fit: PdfFit | null = 'width';
  /** The scroll, logical pixels. */
  private _left = 0;
  private _top = 0;
  private _paneWidth = 0;
  private _paneHeight = 0;
  /** The level tiles are asked for at, which lags a zoom. */
  private _level = 0;

  private _tiles = new Map<string, Tile>();
  private _byPage = new Map<number, Set<Tile>>();
  private _cached = 0;
  private _pool: SurfaceLike[] = [];
  private _asked = new Set<string>();
  /** What the engine could not draw: asked once, or a page it cannot read
   *  would be asked for as fast as it can refuse. */
  private _failed = new Set<string>();
  private _noSurfaces = false;
  private _inFlight = 0;
  private _settle: unknown = null;
  private _generation = 0;
  private _pumping = false;

  private _texts = new Map<number, PageTextIndex>();
  private _links = new Map<number, PageLink[]>();
  private _textsAsked = new Set<number>();

  private _anchor: TextPlace | null = null;
  private _focus: TextPlace | null = null;
  private _selecting: 1 | 2 | 3 | null = null;
  private _thumbDrag: { axis: 'x' | 'y'; from: number; start: number } | null =
    null;
  private _pressed: PageLink | null = null;
  private _reported = -1;
  private _gaps = 0;
  private _scaleSeen = 0;
  /** What a screen reader is told: the text of the pages in view. */
  private _spoken = '';

  readonly stats: PdfViewStats = {
    tilesDrawn: 0,
    uploadMs: 0,
    uploadMax: 0,
    paints: 0,
    paintMs: 0,
    paintMax: 0,
    tilesComposited: 0,
    staleComposited: 0,
    incomplete: 0,
    wholeAt: 0,
  };

  constructor(props: Record<string, unknown>, app: NtkApp) {
    super(ELEMENT, props, app);
    this.focusableByDefault = true;
    this.hasOwnSelection = true;
    this.applyDocument();
  }

  private _props(): Partial<PdfViewProps> {
    return this.props as unknown as Partial<PdfViewProps>;
  }

  private get _scale(): number {
    return this.scale > 0 ? this.scale : 1;
  }

  // --- the document --------------------------------------------------------

  override applyProps(
    next: Record<string, unknown>,
    prev: Record<string, unknown>,
  ): void {
    const before = (prev ?? this.props) as Partial<PdfViewProps>;
    super.applyProps(next, prev);
    const after = next as Partial<PdfViewProps>;
    if (after.document !== before.document) {
      this.applyDocument();
    } else if (after.gap !== before.gap) {
      this._place();
      this._clamp();
    }
  }

  private applyDocument(): void {
    const { document, defaultZoom } = this._props();
    this._clear();
    this._sizes = document?.pages ?? [];
    this._handle = document?.handle ?? -1;
    this._left = 0;
    this._top = 0;
    if (typeof defaultZoom === 'number') {
      this._zoom = clampZoom(defaultZoom);
      this._fit = null;
    } else {
      this._fit = defaultZoom ?? 'width';
    }
    this._place();
    this._repaint();
  }

  private _clear(): void {
    this._generation++;
    for (const tile of this._tiles.values()) tile.surface.destroy();
    for (const surface of this._pool) surface.destroy();
    this._tiles.clear();
    this._byPage.clear();
    this._pool = [];
    this._cached = 0;
    this._asked.clear();
    this._failed.clear();
    this._inFlight = 0;
    this._texts.clear();
    this._links.clear();
    this._textsAsked.clear();
    this._anchor = this._focus = null;
    this._level = 0;
  }

  /** Where the pages stand at the zoom a fit comes to in this pane. */
  private _place(): void {
    const gap = this._props().gap ?? DEFAULT_GAP;
    if (this._fit && this._paneWidth > 0) {
      this._zoom = this._fitted(this._fit, gap);
    }
    this._layout = placePages(this._sizes, this._zoom, gap, this._paneWidth);
  }

  private _fitted(fit: PdfFit, gap: number): number {
    let width = 0;
    let height = 0;
    for (const size of this._sizes) {
      width = Math.max(width, size.width);
      height = Math.max(height, size.height);
    }
    if (!width || !height) return 1;
    const across =
      (this._paneWidth - gap * 2 - THUMB_WIDTH) / (width * PX_PER_POINT);
    if (fit === 'width') return clampZoom(across);
    const down = (this._paneHeight - gap * 2) / (height * PX_PER_POINT);
    return clampZoom(Math.min(across, down));
  }

  override destroySubtree(): void {
    this._clear();
    clearTimeout(this._settle);
    super.destroySubtree();
  }

  // --- the view ------------------------------------------------------------

  private _view(): ViewRect {
    return {
      x: this._left,
      y: this._top,
      width: this._paneWidth,
      height: this._paneHeight,
    };
  }

  private _maxLeft(): number {
    return Math.max(0, this._layout.width - this._paneWidth);
  }

  private _maxTop(): number {
    return Math.max(0, this._layout.height - this._paneHeight);
  }

  private _repaint(reason = 'content'): void {
    this.invalidate(false, this.abs, reason);
  }

  /** A logical rectangle of the document as damage. */
  private _claimDocument(x: number, y: number, w: number, h: number): void {
    const s = this._scale;
    const box = this.contentBox();
    const left = Math.max(box.x, Math.floor(box.x + (x - this._left) * s));
    const top = Math.max(box.y, Math.floor(box.y + (y - this._top) * s));
    const right = Math.min(
      box.x + box.width,
      Math.ceil(box.x + (x + w - this._left) * s),
    );
    const bottom = Math.min(
      box.y + box.height,
      Math.ceil(box.y + (y + h - this._top) * s),
    );
    if (right <= left || bottom <= top) return;
    this.invalidate(
      false,
      { x: left, y: top, width: right - left, height: bottom - top },
      'content',
    );
  }

  /** The zoom a fit or the wheel asks for, with the document point under
   *  `(px, py)` of the pane left where it is. */
  zoomTo(zoom: number, px = this._paneWidth / 2, py = this._paneHeight / 2) {
    const next = clampZoom(zoom);
    if (next === this._zoom) return;
    const before = this._layout;
    const at = this._pointAt(px, py, before);
    this._fit = null;
    this._zoom = next;
    this._place();
    if (at) {
      const page = this._layout.pages[at.page]!;
      this._left = page.x + at.u * page.width - px;
      this._top = page.y + at.v * page.height - py;
    }
    this._clamp();
    this._repaint();
    this._props().onZoomChange?.(next);
    this._armSettle();
  }

  fit(fit: PdfFit): void {
    const zoom = this._zoom;
    this._fit = fit;
    this._place();
    this._clamp();
    this._repaint();
    this._armSettle();
    if (this._zoom !== zoom) this._props().onZoomChange?.(this._zoom);
  }

  get zoom(): number {
    return this._zoom;
  }

  /** A pane point as a fraction of the page under it. */
  private _pointAt(px: number, py: number, layout: DocumentLayout) {
    if (layout.pages.length === 0) return null;
    const y = this._top + py;
    const at = Math.min(
      firstPageBelow(layout.pages, y),
      layout.pages.length - 1,
    );
    const page = layout.pages[at]!;
    return {
      page: at,
      u: (this._left + px - page.x) / page.width,
      v: (y - page.y) / page.height,
    };
  }

  /** A scroll stays on the device grid: a blit moves whole pixels, and a
   *  strip painted from a fraction would not meet the band it moved. */
  private _snap(offset: number): number {
    const s = this._scale;
    return Math.round(offset * s) / s;
  }

  private _clamp(): void {
    this._left = this._snap(Math.max(0, Math.min(this._left, this._maxLeft())));
    this._top = this._snap(Math.max(0, Math.min(this._top, this._maxTop())));
  }

  private _armSettle(): void {
    clearTimeout(this._settle);
    const timer = setTimeout(() => {
      this._settle = null;
      if (this.destroyed) return;
      this._level = 0;
      this._pump();
      this._repaint();
    }, SETTLE_MS);
    timer.unref?.();
    this._settle = timer;
  }

  scrollToPage(index: number): void {
    const page = this._layout.pages[index];
    if (!page) return;
    this.scrollTo(this._left, page.y - (this._props().gap ?? DEFAULT_GAP));
  }

  scrollTo(left: number, top: number): void {
    const s = this._scale;
    const x = Math.max(0, Math.min(left, this._maxLeft()));
    const y = Math.max(0, Math.min(top, this._maxTop()));
    this._moveBy(
      Math.round((x - this._left) * s),
      Math.round((y - this._top) * s),
    );
  }

  canScroll(dx: number, dy: number): boolean {
    return (
      (dy !== 0 && this._maxTop() > 0) || (dx !== 0 && this._maxLeft() > 0)
    );
  }

  scrollBy(by: number | { x?: number; y?: number }): void {
    const dx = typeof by === 'number' ? 0 : (by.x ?? 0);
    const dy = typeof by === 'number' ? by : (by.y ?? 0);
    const s = this._scale;
    this._moveBy(Math.round(dx * s), Math.round(dy * s));
  }

  /** Move by whole device pixels: what a blit can be. */
  private _moveBy(dx: number, dy: number): void {
    const s = this._scale;
    const nx = this._snap(
      Math.max(0, Math.min(this._left + dx / s, this._maxLeft())),
    );
    const ny = this._snap(
      Math.max(0, Math.min(this._top + dy / s, this._maxTop())),
    );
    const shiftX = Math.round((this._left - nx) * s);
    const shiftY = Math.round((this._top - ny) * s);
    this._left = nx;
    this._top = ny;
    if (shiftX === 0 && shiftY === 0) return;
    const box = this.contentBox();
    if (
      Math.abs(shiftX) < box.width &&
      Math.abs(shiftY) < box.height &&
      box.width > 64 &&
      box.height > 64
    ) {
      this.scrollContents(box, shiftX, shiftY, null, this._thumbRects());
    } else {
      this._repaint('scroll');
    }
    this._reportPage();
    this._pump();
  }

  private _reportPage(): void {
    const page = currentPage(this._layout, this._view());
    if (page === this._reported) return;
    this._reported = page;
    this._props().onPageChange?.(page);
    this._speak();
  }

  /** The element's text for an assistive technology: what is in view, since
   *  a document may be thousands of pages and is read a page at a time. */
  private _speak(): void {
    const parts: string[] = [];
    for (const page of pagesIn(this._layout, this._view())) {
      const text = this._texts.get(page.index);
      if (text) parts.push(text.text);
    }
    const spoken = parts.join('\n');
    if (spoken === this._spoken) return;
    this._spoken = spoken;
    this.notifyA11yTextChanged();
  }

  override a11yTextState(): A11yTextState | null {
    return this._spoken
      ? { value: this._spoken, editable: false, multiline: true }
      : null;
  }

  // --- tiles ---------------------------------------------------------------

  private _wantedLevel(): number {
    return this._zoom * PX_PER_POINT * this._scale;
  }

  /** What to ask for next: what the view shows, then what is ahead of it. */
  private _wanted(limit: number): TileAddress[] {
    if (this._level === 0) this._level = this._wantedLevel();
    const level = this._level;
    const s = this._scale;
    const view = this._view();
    const out: TileAddress[] = [];
    const collect = (rect: ViewRect): void => {
      for (const page of pagesIn(this._layout, rect)) {
        const size = this._sizes[page.index]!;
        const across = {
          x: (rect.x - page.x) * s,
          y: (rect.y - page.y) * s,
          width: rect.width * s,
          height: rect.height * s,
        };
        const focus = (rect.y + rect.height / 2 - page.y) * s;
        for (const tile of tilesCovering(
          page.index,
          size,
          level,
          across,
          focus,
        )) {
          if (
            this._tiles.has(tile.key) ||
            this._asked.has(tile.key) ||
            this._failed.has(tile.key)
          ) {
            continue;
          }
          out.push(tile);
          if (out.length >= limit) return;
        }
      }
    };
    collect(view);
    if (out.length < limit) {
      collect({
        ...view,
        y: view.y + view.height,
        height: view.height * AHEAD,
      });
    }
    if (out.length < limit) {
      collect({
        ...view,
        y: view.y - view.height * AHEAD,
        height: view.height * AHEAD,
      });
    }
    return out;
  }

  private _pump(): void {
    const engine = this._props().engine;
    if (!engine || this._handle < 0 || this._pumping) return;
    if (this._settle !== null || this._noSurfaces) return;
    if (this._paneWidth <= 0) return;
    this._pumping = true;
    const room = IN_FLIGHT - this._inFlight;
    if (room > 0) {
      for (const tile of this._wanted(room)) this._ask(engine, tile);
    }
    this._pumping = false;
    if (this._inFlight === 0) this._askText(engine);
  }

  private _ask(engine: PdfEngine, tile: TileAddress): void {
    this._asked.add(tile.key);
    this._inFlight++;
    const generation = this._generation;
    engine
      .render(this._handle, {
        page: tile.page,
        level: tile.level,
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
      })
      .then(
        (pixels) => {
          if (generation !== this._generation || this.destroyed) return;
          this._inFlight--;
          this._asked.delete(tile.key);
          if (pixels) this._land(tile, pixels);
          else this._failed.add(tile.key);
          this._pump();
        },
        () => {
          if (generation !== this._generation || this.destroyed) return;
          this._inFlight--;
          this._asked.delete(tile.key);
          this._failed.add(tile.key);
          this._pump();
        },
      );
  }

  private _makeSurface(): SurfaceLike | null {
    const pooled = this._pool.pop();
    if (pooled) return pooled;
    try {
      return new Surface(this.app, {
        width: TILE_SIZE,
        height: TILE_SIZE,
      }) as unknown as SurfaceLike;
    } catch {
      return null;
    }
  }

  private _land(
    address: TileAddress,
    pixels: { width: number; height: number; data: Uint8ClampedArray },
  ): void {
    const started = performance.now();
    const surface = this._makeSurface();
    if (!surface) {
      // A backend with no offscreen surface: the headless mock, which then
      // draws its pages blank. Asked again, the tile would be asked for ever.
      this._noSurfaces = true;
      return;
    }
    const ctx = surface.getContext('2d') as PdfCanvas;
    ctx.putImageData?.(pixels, 0, 0);
    ctx.destroy?.();
    const tile: Tile = { address, surface };
    this._tiles.set(address.key, tile);
    let set = this._byPage.get(address.page);
    if (!set) this._byPage.set(address.page, (set = new Set()));
    set.add(tile);
    this._cached += surface.bytes;
    this._evict();
    const took = performance.now() - started;
    this.stats.tilesDrawn++;
    this.stats.uploadMs += took;
    this.stats.uploadMax = Math.max(this.stats.uploadMax, took);
    if (address.level === this._level) {
      const page = this._layout.pages[address.page];
      if (page) {
        const s = this._scale;
        this._claimDocument(
          page.x + address.x / s,
          page.y + address.y / s,
          address.width / s,
          address.height / s,
        );
      }
    }
  }

  private _evict(): void {
    const budget = this._props().cacheBytes ?? DEFAULT_CACHE_BYTES;
    if (this._cached <= budget) return;
    const s = this._scale;
    const view = this._view();
    const margin = view.height * (AHEAD + 1);
    // A `Map` keeps insertion order, and `_touch` moves a drawn tile to its
    // end, so the first entries are the ones drawn longest ago.
    for (const [key, tile] of this._tiles) {
      if (this._cached <= budget) break;
      const { address } = tile;
      const page = this._layout.pages[address.page];
      const near =
        page &&
        address.level === this._level &&
        page.y + (address.y + address.height) / s > view.y - margin &&
        page.y + address.y / s < view.y + view.height + margin;
      if (near) continue;
      this._tiles.delete(key);
      this._byPage.get(address.page)?.delete(tile);
      this._cached -= tile.surface.bytes;
      if (this._pool.length < POOL) this._pool.push(tile.surface);
      else tile.surface.destroy();
    }
  }

  private _touch(tile: Tile): void {
    this._tiles.delete(tile.address.key);
    this._tiles.set(tile.address.key, tile);
  }

  // --- text ----------------------------------------------------------------

  /** The pages in view's text and links, once the tiles are done: a thread
   *  that is reading text is one that is not drawing. */
  private _askText(engine: PdfEngine): void {
    for (const page of pagesIn(this._layout, this._view())) {
      const index = page.index;
      if (this._textsAsked.has(index)) continue;
      this._textsAsked.add(index);
      const generation = this._generation;
      void Promise.all([
        engine.text(this._handle, index),
        engine.links(this._handle, index),
      ]).then(([text, links]) => {
        if (generation !== this._generation || this.destroyed) return;
        this._texts.set(index, indexPageText(text));
        this._links.set(index, links);
        this._trimTexts();
        this._speak();
      });
    }
  }

  private _trimTexts(): void {
    if (this._texts.size <= TEXTS) return;
    const keep = new Set(
      pagesIn(this._layout, this._view()).map((p) => p.index),
    );
    if (this._anchor) keep.add(this._anchor.page);
    if (this._focus) keep.add(this._focus.page);
    for (const page of this._texts.keys()) {
      if (this._texts.size <= TEXTS) break;
      if (keep.has(page)) continue;
      this._texts.delete(page);
      this._links.delete(page);
      this._textsAsked.delete(page);
    }
  }

  /** Where a logical window point is on a page, in points. */
  private _onPage(
    x: number,
    y: number,
  ): { page: PlacedPage; px: number; py: number } | null {
    const s = this._scale;
    const box = this.contentBox();
    const paneX = x - box.x / s;
    const paneY = y - box.y / s;
    const docX = this._left + paneX;
    const docY = this._top + paneY;
    const { pages } = this._layout;
    const at = firstPageBelow(pages, docY);
    const page = pages[Math.min(at, pages.length - 1)];
    if (!page) return null;
    const k = this._zoom * PX_PER_POINT;
    return { page, px: (docX - page.x) / k, py: (docY - page.y) / k };
  }

  private _linkAt(x: number, y: number): PageLink | null {
    const hit = this._onPage(x, y);
    if (!hit) return null;
    const links = this._links.get(hit.page.index);
    if (!links) return null;
    for (const link of links) {
      if (
        hit.px >= link.x &&
        hit.px <= link.x + link.width &&
        hit.py >= link.y &&
        hit.py <= link.y + link.height
      ) {
        return link;
      }
    }
    return null;
  }

  override cursorAt(x: number, y: number): string | null {
    const s = this._scale;
    const px = x / s;
    const py = y / s;
    if (this._linkAt(px, py)) return 'pointer';
    const hit = this._onPage(px, py);
    const text = hit && this._texts.get(hit.page.index);
    return text && hit && onText(text, hit.px, hit.py) ? 'text' : null;
  }

  private _hasSelection(): boolean {
    const a = this._anchor;
    const f = this._focus;
    return !!a && !!f && (a.page !== f.page || a.index !== f.index);
  }

  /** The selection in order, or null. */
  private _range(): { from: TextPlace; to: TextPlace } | null {
    if (!this._hasSelection()) return null;
    const a = this._anchor!;
    const f = this._focus!;
    const forward =
      a.page < f.page || (a.page === f.page && a.index <= f.index);
    return forward ? { from: a, to: f } : { from: f, to: a };
  }

  /** The selection as text, from what is held: core asks synchronously, so a
   *  page that has gone from the cache of texts is left out here. */
  override selectedText(): string {
    const range = this._range();
    if (!range) return '';
    const parts: string[] = [];
    for (let page = range.from.page; page <= range.to.page; page++) {
      const text = this._texts.get(page);
      if (text) parts.push(this._part(text.text, page, range));
    }
    return parts.join('\n');
  }

  /** The selection as text, all of it: what is not held is read again, so a
   *  Ctrl+A of a manual costs the engine's thread and not this one. */
  async readSelection(): Promise<string> {
    const range = this._range();
    const engine = this._props().engine;
    if (!range || !engine) return '';
    const parts: string[] = [];
    for (let page = range.from.page; page <= range.to.page; page++) {
      const text =
        this._texts.get(page)?.text ??
        (await engine.text(this._handle, page)).text;
      parts.push(this._part(text, page, range));
    }
    return parts.join('\n');
  }

  private _part(
    text: string,
    page: number,
    range: { from: TextPlace; to: TextPlace },
  ): string {
    const start = page === range.from.page ? range.from.index : 0;
    const end = page === range.to.page ? range.to.index : text.length;
    return text.slice(start, end).replace(/\r\n/g, '\n');
  }

  private _copy(selection = 'CLIPBOARD'): void {
    void this.readSelection().then((text) => {
      if (!text) return;
      const app = this.app as {
        clipboard?: {
          write(
            text: string,
            options?: { selection?: string },
          ): Promise<unknown>;
        };
      } | null;
      app?.clipboard?.write(text, { selection }).catch(() => {});
    });
  }

  // --- gestures ------------------------------------------------------------

  private _thumbRects(): Rect[] {
    const out: Rect[] = [];
    const y = this._thumbY();
    const x = this._thumbX();
    if (y) out.push(y);
    if (x) out.push(x);
    return out;
  }

  /** The vertical thumb, in the window's device pixels. */
  private _thumbY(): Rect | null {
    const max = this._maxTop();
    if (max <= 0) return null;
    const s = this._scale;
    const box = this.contentBox();
    const track = box.height;
    const height = Math.max(
      THUMB_MIN * s,
      Math.round((track * this._paneHeight) / this._layout.height),
    );
    const width = THUMB_WIDTH * s;
    return {
      x: box.x + box.width - width,
      y: box.y + Math.round((this._top / max) * (track - height)),
      width,
      height,
    };
  }

  private _thumbX(): Rect | null {
    const max = this._maxLeft();
    if (max <= 0) return null;
    const s = this._scale;
    const box = this.contentBox();
    const track = box.width - THUMB_WIDTH * s;
    const width = Math.max(
      THUMB_MIN * s,
      Math.round((track * this._paneWidth) / this._layout.width),
    );
    const height = THUMB_WIDTH * s;
    return {
      x: box.x + Math.round((this._left / max) * (track - width)),
      y: box.y + box.height - height,
      width,
      height,
    };
  }

  private _onThumb(x: number, y: number): 'x' | 'y' | null {
    const s = this._scale;
    const dx = x * s;
    const dy = y * s;
    const box = this.contentBox();
    if (dx >= box.x + box.width - THUMB_WIDTH * s && this._maxTop() > 0) {
      return 'y';
    }
    if (dy >= box.y + box.height - THUMB_WIDTH * s && this._maxLeft() > 0) {
      return 'x';
    }
    return null;
  }

  override defaultMouseDown(ev: PdfMouseEvent): void {
    const thumb = this._onThumb(ev.x, ev.y);
    if (thumb) {
      this._thumbDrag = {
        axis: thumb,
        from: thumb === 'y' ? ev.y : ev.x,
        start: thumb === 'y' ? this._top : this._left,
      };
      ev.capturePointer?.();
      return;
    }
    this._pressed = this._linkAt(ev.x, ev.y);
    const hit = this._onPage(ev.x, ev.y);
    const text = hit && this._texts.get(hit.page.index);
    const had = this._hasSelection();
    this._anchor = this._focus = null;
    if (hit && text) {
      const caret = caretAt(text, hit.px, hit.py);
      if (caret >= 0) {
        const clicks = Math.min(ev.detail ?? 1, 3) as 1 | 2 | 3;
        this._selecting = clicks;
        const page = hit.page.index;
        const [start, end] =
          clicks === 3
            ? lineAround(text, Math.min(caret, text.text.length - 1))
            : clicks === 2
              ? wordAround(text, Math.min(caret, text.text.length - 1))
              : [caret, caret];
        this._anchor = { page, index: start };
        this._focus = { page, index: end };
        ev.capturePointer?.();
      }
    }
    if (had || this._hasSelection()) this._repaint('selection');
  }

  override defaultMouseDrag(ev: PdfMouseEvent): void {
    const drag = this._thumbDrag;
    if (drag) {
      const s = this._scale;
      const box = this.contentBox();
      if (drag.axis === 'y') {
        const thumb = this._thumbY();
        const room = box.height / s - (thumb?.height ?? 0) / s;
        if (room > 0) {
          this.scrollTo(
            this._left,
            drag.start + ((ev.y - drag.from) * this._maxTop()) / room,
          );
        }
      } else {
        const thumb = this._thumbX();
        const room = box.width / s - (thumb?.width ?? 0) / s;
        if (room > 0) {
          this.scrollTo(
            drag.start + ((ev.x - drag.from) * this._maxLeft()) / room,
            this._top,
          );
        }
      }
      return;
    }
    if (!this._selecting || !this._anchor) return;
    const hit = this._onPage(ev.x, ev.y);
    const text = hit && this._texts.get(hit.page.index);
    if (!hit || !text) return;
    const caret = caretAt(text, hit.px, hit.py);
    if (caret < 0) return;
    this._focus = { page: hit.page.index, index: caret };
    this._pressed = null;
    this._repaint('selection');
  }

  override defaultMouseUp(ev: PdfMouseEvent): void {
    this._thumbDrag = null;
    this._selecting = null;
    if (this._hasSelection()) this._copy('PRIMARY');
    const pressed = this._pressed;
    this._pressed = null;
    if (pressed && pressed === this._linkAt(ev.x, ev.y)) {
      if (pressed.page !== undefined) this.scrollToPage(pressed.page);
      this._props().onLink?.({
        ...(pressed.url ? { url: pressed.url } : {}),
        ...(pressed.page !== undefined ? { page: pressed.page } : {}),
      });
    }
  }

  override defaultWheel(ev: PdfWheelEvent): void {
    if (!ev.ctrlKey && !ev.metaKey) return;
    const s = this._scale;
    const box = this.contentBox();
    const notches = (ev.deltaY ?? 0) / 48;
    this.zoomTo(
      this._zoom * Math.pow(ZOOM_STEP, -notches),
      ev.x - box.x / s,
      ev.y - box.y / s,
    );
    ev.preventDefault();
  }

  override defaultKeyDown(ev: PdfKeyEvent): void {
    const step = 48;
    const page = this._paneHeight - 48;
    const mod = ev.ctrlKey || ev.metaKey;
    switch (ev.keysym) {
      case 0xff52: // XK_Up
        this.scrollBy({ y: -step });
        break;
      case 0xff54: // XK_Down
        this.scrollBy({ y: step });
        break;
      case 0xff51: // XK_Left
        this.scrollBy({ x: -step });
        break;
      case 0xff53: // XK_Right
        this.scrollBy({ x: step });
        break;
      case 0xff55: // XK_Page_Up
        this.scrollBy({ y: -page });
        break;
      case 0xff56: // XK_Page_Down
      case 0x0020: // XK_space
        this.scrollBy({ y: ev.shiftKey ? -page : page });
        break;
      case 0xff50: // XK_Home
        this.scrollTo(this._left, 0);
        break;
      case 0xff57: // XK_End
        this.scrollTo(this._left, this._maxTop());
        break;
      case 0xff1b: // XK_Escape
        if (!this._hasSelection()) return super.defaultKeyDown?.(ev as never);
        this._anchor = this._focus = null;
        this._repaint('selection');
        break;
      default:
        if (!mod || !this._chord(ev.keysym ?? 0)) {
          return super.defaultKeyDown?.(ev as never);
        }
    }
    ev.preventDefault();
  }

  /** What a key does with Ctrl or Cmd held. */
  private _chord(keysym: number): boolean {
    switch (keysym) {
      case 0x002b: // XK_plus
      case 0x003d: // XK_equal
        this.zoomTo(this._zoom * 1.25);
        return true;
      case 0x002d: // XK_minus
        this.zoomTo(this._zoom / 1.25);
        return true;
      case 0x0030: // XK_0
        this.fit('width');
        return true;
      case 0x0063: // XK_c
      case 0x0043: // XK_C
        this._copy();
        return true;
      case 0x0061: // XK_a
      case 0x0041: // XK_A
        this._selectAll();
        return true;
      default:
        return false;
    }
  }

  private _selectAll(): void {
    const last = this._sizes.length - 1;
    if (last < 0) return;
    this._anchor = { page: 0, index: 0 };
    // Past the end of a text that may not be read yet: a range is cut to the
    // text it lands on.
    this._focus = { page: last, index: Number.MAX_SAFE_INTEGER };
    this._repaint('selection');
  }

  override opaqueRect(): Rect | null {
    return this.contentBox();
  }

  // --- paint ---------------------------------------------------------------

  override paint(ctx: Context2D): void {
    super.paint(ctx);
    const started = performance.now();
    const canvas = ctx as unknown as PdfCanvas;
    if (typeof canvas.fillRect !== 'function') return;
    const box = this.contentBox();
    const s = this._scale;
    const width = box.width / s;
    const height = box.height / s;
    if (width !== this._paneWidth || height !== this._paneHeight) {
      this._resized(width, height);
    }
    if (s !== this._scaleSeen) {
      // The window went to another display: what there is is of the old one.
      this._scaleSeen = s;
      this._level = 0;
      this._clamp();
    }
    const damage = this.paintDamage() ?? box;
    const left = Math.max(box.x, Math.floor(damage.x));
    const top = Math.max(box.y, Math.floor(damage.y));
    const right = Math.min(
      box.x + box.width,
      Math.ceil(damage.x + damage.width),
    );
    const bottom = Math.min(
      box.y + box.height,
      Math.ceil(damage.y + damage.height),
    );
    const { ground = '#525659' } = this._props();
    canvas.fillStyle = ground;
    canvas.fillRect(left, top, right - left, bottom - top);

    const view: ViewRect = {
      x: this._left + (left - box.x) / s,
      y: this._top + (top - box.y) / s,
      width: (right - left) / s,
      height: (bottom - top) / s,
    };
    const level = this._level || this._wantedLevel();
    const range = this._range();
    this._gaps = 0;
    for (const page of pagesIn(this._layout, view)) {
      this._paintPage(canvas, page, level, box, { left, top, right, bottom });
      if (range) this._paintSelection(canvas, page, box, range);
    }
    this._paintThumbs(canvas);
    this._pump();
    const took = performance.now() - started;
    if (this._gaps > 0) this.stats.incomplete++;
    if (this.stats.wholeAt === 0 && this._wholeView()) {
      this.stats.wholeAt = performance.now();
    }
    this.stats.paints++;
    this.stats.paintMs += took;
    this.stats.paintMax = Math.max(this.stats.paintMax, took);
  }

  /**
   * Whether every tile of everything in view has landed. A paint only says
   * so of its damage, and a paint of the first tile to land has no other in
   * it, so this asks of the view.
   */
  private _wholeView(): boolean {
    if (this._sizes.length === 0 || this._paneWidth <= 0) return false;
    const s = this._scale;
    const view = this._view();
    const level = this._level || this._wantedLevel();
    for (const page of pagesIn(this._layout, view)) {
      const across = {
        x: (view.x - page.x) * s,
        y: (view.y - page.y) * s,
        width: view.width * s,
        height: view.height * s,
      };
      const size = this._sizes[page.index]!;
      for (const tile of tilesCovering(page.index, size, level, across, 0)) {
        if (!this._tiles.has(tile.key)) return false;
      }
    }
    return true;
  }

  private _resized(width: number, height: number): void {
    const before = this._paneWidth;
    const zoom = this._zoom;
    const at = before > 0 ? this._pointAt(0, 0, this._layout) : null;
    this._paneWidth = width;
    this._paneHeight = height;
    this._place();
    if (at) {
      const page = this._layout.pages[at.page];
      if (page) this._top = page.y + at.v * page.height;
    }
    this._clamp();
    if (before === 0) {
      this._level = 0;
    } else if (this._zoom !== zoom) {
      // A fit follows a dragged edge, and every step is another scale: what
      // there is is stretched until the edge rests.
      this._armSettle();
    }
    this._told(() => {
      if (this._zoom !== zoom) this._props().onZoomChange?.(this._zoom);
      this._reportPage();
    });
  }

  /** Tell the application something a paint found: never from inside it. */
  private _told(tell: () => void): void {
    void Promise.resolve().then(() => {
      if (!this.destroyed) tell();
    });
  }

  private _paintPage(
    ctx: PdfCanvas,
    page: PlacedPage,
    level: number,
    box: Rect,
    damage: { left: number; top: number; right: number; bottom: number },
  ): void {
    const s = this._scale;
    const size = this._sizes[page.index]!;
    const shown = this._zoom * PX_PER_POINT * s;
    const whole = pagePixels(size, shown);
    const x = box.x + Math.round((page.x - this._left) * s);
    const y = box.y + Math.round((page.y - this._top) * s);
    const left = Math.max(damage.left, x);
    const top = Math.max(damage.top, y);
    const right = Math.min(damage.right, x + whole.width);
    const bottom = Math.min(damage.bottom, y + whole.height);
    if (right <= left || bottom <= top) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect!(left, top, right - left, bottom - top);

    const within = {
      x: left - x,
      y: top - y,
      width: right - left,
      height: bottom - top,
    };
    const exact = Math.abs(level - shown) < 1 / 1024;
    const tiles = exact
      ? tilesCovering(page.index, size, level, within, within.y)
      : [];
    let missing = !exact;
    for (const address of tiles) {
      if (!this._tiles.has(address.key)) missing = true;
    }
    if (missing) this._gaps++;
    // What is on hand of the page at another scale goes under what there is
    // at this one: the nearest scale last, so it is what shows.
    if (missing)
      this._paintStale(ctx, page.index, shown, x, y, left, top, right, bottom);
    for (const address of tiles) {
      const tile = this._tiles.get(address.key);
      if (!tile) continue;
      this._touch(tile);
      ctx.drawImage!(
        tile.surface,
        0,
        0,
        address.width,
        address.height,
        x + address.x,
        y + address.y,
        address.width,
        address.height,
      );
      this.stats.tilesComposited++;
    }
  }

  private _paintStale(
    ctx: PdfCanvas,
    pageIndex: number,
    shown: number,
    x: number,
    y: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): void {
    const set = this._byPage.get(pageIndex);
    if (!set || set.size === 0) return;
    const wanted = levelKey(shown);
    const stale = [...set].filter((t) => levelKey(t.address.level) !== wanted);
    if (stale.length === 0) return;
    stale.sort(
      (a, b) =>
        Math.abs(Math.log(b.address.level / shown)) -
        Math.abs(Math.log(a.address.level / shown)),
    );
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'low';
    for (const tile of stale) {
      const { address } = tile;
      const k = shown / address.level;
      const dx0 = x + Math.round(address.x * k);
      const dy0 = y + Math.round(address.y * k);
      const dx1 = x + Math.round((address.x + address.width) * k);
      const dy1 = y + Math.round((address.y + address.height) * k);
      if (dx1 <= left || dy1 <= top || dx0 >= right || dy0 >= bottom) continue;
      // Clipped before it is handed over: at a deep zoom a tile starts tens
      // of thousands of pixels off the pane, past what X takes.
      const cx0 = Math.max(dx0, left);
      const cy0 = Math.max(dy0, top);
      const cx1 = Math.min(dx1, right);
      const cy1 = Math.min(dy1, bottom);
      const kx = address.width / (dx1 - dx0);
      const ky = address.height / (dy1 - dy0);
      ctx.drawImage!(
        tile.surface,
        (cx0 - dx0) * kx,
        (cy0 - dy0) * ky,
        (cx1 - cx0) * kx,
        (cy1 - cy0) * ky,
        cx0,
        cy0,
        cx1 - cx0,
        cy1 - cy0,
      );
      this.stats.staleComposited++;
    }
  }

  private _paintSelection(
    ctx: PdfCanvas,
    page: PlacedPage,
    box: Rect,
    range: { from: TextPlace; to: TextPlace },
  ): void {
    const index = page.index;
    if (index < range.from.page || index > range.to.page) return;
    const text = this._texts.get(index);
    if (!text) return;
    const start = index === range.from.page ? range.from.index : 0;
    const end = index === range.to.page ? range.to.index : text.text.length;
    const s = this._scale;
    const k = this._zoom * PX_PER_POINT * s;
    const x = box.x + Math.round((page.x - this._left) * s);
    const y = box.y + Math.round((page.y - this._top) * s);
    ctx.fillStyle = this.selectionColor ?? 'rgba(66, 133, 244, 0.35)';
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = 0.4;
    for (const band of rangeBands(text, start, end)) {
      ctx.fillRect!(
        Math.floor(x + band.x * k),
        Math.floor(y + band.y * k),
        Math.ceil(band.width * k),
        Math.ceil(band.height * k),
      );
    }
    ctx.globalAlpha = alpha ?? 1;
  }

  private _paintThumbs(ctx: PdfCanvas): void {
    // A grey that shows on the ground and on a white page alike: past a page
    // as wide as the pane, the thumb is over the page.
    const { thumb = 'rgba(128, 128, 128, 0.65)' } = this._props();
    ctx.fillStyle = thumb;
    const s = this._scale;
    const inset = 2 * s;
    const y = this._thumbY();
    if (y) {
      ctx.fillRect!(y.x + inset, y.y, y.width - inset * 2, y.height);
    }
    const x = this._thumbX();
    if (x) {
      ctx.fillRect!(x.x, x.y + inset, x.width, x.height - inset * 2);
    }
  }
}

interface PdfMouseEvent {
  x: number;
  y: number;
  detail?: number;
  capturePointer?(): void;
}

interface PdfWheelEvent {
  x: number;
  y: number;
  deltaY?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  preventDefault(): void;
}

interface PdfKeyEvent {
  keysym?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  preventDefault(): void;
}
