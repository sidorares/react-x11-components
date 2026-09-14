// Cells to pixels, through two implementations of one interface.
//
// **`RetainedRenderer`** keeps an offscreen `Surface` holding the whole grid:
// the frame's changed cells are drawn into it, a scroll is one server-side
// `Surface.copyWithin` (ntk#252) instead of a screenful of glyph work, and
// the node's paint is a single `drawImage` composite of the band the window
// asked for. Everything it needs is public API — the escape hatches this
// component was designed around (a raw `X.CopyArea` on a pixmap, a private
// `Render.FillRectangles`, an undocumented glyph-run shape) were promoted
// upstream as ntk#252/#253/#254 before any of this shipped, so there is no
// hatch left to confine.
//
// **`DirectRenderer`** is the same cell decisions with no retained buffer:
// it draws into the paint context and answers `false` to `copyRows`, so the
// caller repaints what a scroll moved. Slower on scroll, identical pixels —
// and it is the correctness reference the tests compare the retained path
// against, plus what runs where a `Surface` cannot be created.
//
// Both batch. A frame's background rectangles go out as one
// `ctx.fillRects` per colour (ntk#253 — one `Render.FillRectangles` request
// instead of one composite per rectangle), and its glyphs as one
// `ctx.drawGlyphs` per colour (one `CompositeGlyphs` covering every run in
// the call). That is what keeps "the terminal scrolled" at a handful of
// requests rather than a few thousand.
//
// The retained renderer's composite is a `copy`, not a blend. Every cell of
// the grid is filled before it is shown, so replacing the window's pixels
// with the surface's is the same picture as compositing over them — and
// saying so is what lets the Cocoa backend send it as a row memcpy instead
// of building a CGImage and blending it (react-x11#501: 0.42ms against 1.37
// for a 125x45 grid at 2x), and X11 as `PictOp.Src`. Together with the
// node's `opaqueRect()` it is why a streaming frame no longer pays for
// pixels nobody sees.
import type { CellMetrics, GlyphRun } from './fonts.js';

/** What `ctx.drawGlyphs` takes: a run and where its baseline starts. */
export interface PositionedRun {
  run: GlyphRun;
  x: number;
  y: number;
}

/** The slice of ntk's 2d context the renderers draw through. */
export interface CellContext {
  fillStyle: unknown;
  /** Canvas's compositing operator. `'copy'` replaces rather than blends;
   *  a backend that cannot draw it refuses the assignment, so read it back
   *  rather than assume. Absent on a context with no notion of it. */
  globalCompositeOperation?: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  /** A batch of `[x, y, width, height]` rectangles. The tuple form is the
   *  one every backend reads: ntk and Cocoa also take a flat number list,
   *  and react-x11's Wayland context only takes tuples — see `_flushRects`. */
  fillRects?(rects: number[][]): void;
  drawGlyphs?(op: number, src: unknown, positioned: PositionedRun[]): void;
  createSolidPicture?(r: number, g: number, b: number, a: number): unknown;
  drawImage?(
    image: unknown,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  Render?: { PictOp?: { Over?: number; Src?: number } };
  /** Put back the drawing state this context assumes, after something else
   *  drew through the same device — react-x11's Wayland context offers it
   *  for a `<glarea>`'s foreign GL, and an offscreen surface's frame is the
   *  same interruption. Absent on a backend with no shared device state. */
  restoreGLState?(): void;
  destroy?(): void;
}

/** ntk's `Surface`, as the retained renderer uses it. */
interface SurfaceLike {
  width: number;
  height: number;
  getContext(name: string): CellContext;
  /** Draw into the surface through a context the surface itself provides,
   *  and which is only guaranteed to be drawable for the length of the call.
   *  `RetainedRenderer.draw` picks between this and a held `getContext`. */
  render(fn: (ctx: CellContext) => void): unknown;
  /** ntk#252 — overlapping self-copy inside the pixmap. */
  copyWithin(
    src: { x: number; y: number; width: number; height: number },
    dx: number,
    dy: number,
  ): boolean;
  destroy(): void;
}

export type SurfaceCtor = new (
  app: unknown,
  options: { width: number; height: number; format?: string },
) => SurfaceLike;

export type DecorationKind =
  | 'underline'
  | 'strike'
  | 'overline'
  /** The unfocused cursor's outline. */
  | 'box'
  /** The `bar` cursor: a rule down the left edge of the cell. */
  | 'bar'
  /** The `underline` cursor: a rule along the bottom of the cell, which is
   *  lower and thicker than the SGR 4 underline. */
  | 'cursorUnderline';

export interface FrameInfo {
  /** Where the grid's top-left corner is, in window coordinates. */
  originX: number;
  originY: number;
  cols: number;
  rows: number;
  metrics: CellMetrics;
}

/** What a frame cost, for the draw-op budget assertions in the tests. */
export interface RendererStats {
  /** `fillRects`/`fillRect` requests — one per colour, not one per cell. */
  fillRequests: number;
  /** `drawGlyphs` calls — one per colour. */
  glyphRequests: number;
  /** Server-side scroll copies. */
  copies: number;
  /** Surface → window composites. */
  blits: number;
  cellsFilled: number;
  glyphsDrawn: number;
}

export interface RendererOps {
  readonly kind: 'retained' | 'direct';
  /**
   * Grid geometry for the frames to come. `false` means the buffer was
   * reallocated and holds nothing — the caller drops its mirror.
   */
  ensure(cols: number, rows: number, metrics: CellMetrics): boolean;
  begin(ctx: CellContext, frame: FrameInfo): void;
  /** The scroll fast path. `false` when this renderer has no buffer to move
   *  pixels inside, and the caller repaints the band instead. */
  copyRows(srcRow: number, dstRow: number, count: number): boolean;
  fillCells(row: number, col: number, count: number, rgb: number): void;
  drawRun(row: number, col: number, run: GlyphRun, rgb: number): void;
  decorate(
    row: number,
    col: number,
    count: number,
    kind: DecorationKind,
    rgb: number,
  ): void;
  /** Flush the frame. */
  end(): void;
  /** What the frame being drawn has cost so far. Reset by `begin`. */
  readonly stats: RendererStats;
  /** The same counters over this renderer's whole life. A frame's cost is
   *  the thing to assert a budget against; a total is the thing to assert a
   *  fast path was *taken*, since the next frame would have reset it. */
  readonly totals: RendererStats;
  destroy(): void;
}

function zeroStats(): RendererStats {
  return {
    fillRequests: 0,
    glyphRequests: 0,
    copies: 0,
    blits: 0,
    cellsFilled: 0,
    glyphsDrawn: 0,
  };
}

function css(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * The batching half, shared by both renderers.
 *
 * Order within a frame is fixed and is the whole of the "two colours per
 * cell" model: backgrounds first, then glyphs over them, then decorations
 * (which are foreground-coloured rules) over those.
 */
abstract class BatchingRenderer implements RendererOps {
  abstract readonly kind: 'retained' | 'direct';
  protected frame: FrameInfo | null = null;
  protected ctx: CellContext | null = null;
  /** Where this renderer's coordinates sit relative to the paint context. */
  protected offsetX = 0;
  protected offsetY = 0;
  private _fills = new Map<number, number[][]>();
  private _decorations = new Map<number, number[][]>();
  private _runs = new Map<number, PositionedRun[]>();
  readonly stats: RendererStats = zeroStats();
  readonly totals: RendererStats = zeroStats();

  /** Every counter goes through here, so a total can never drift from the
   *  per-frame number it was added to. */
  protected count(key: keyof RendererStats, by = 1): void {
    this.stats[key] += by;
    this.totals[key] += by;
  }

  abstract ensure(cols: number, rows: number, metrics: CellMetrics): boolean;
  abstract copyRows(srcRow: number, dstRow: number, count: number): boolean;
  /**
   * Run `paint` against the context this frame's cells go to — the surface,
   * or the window. The subclass owns *how* that context is come by, because
   * a surface's may only be drawable inside a call it hands out.
   */
  protected abstract draw(paint: (ctx: CellContext) => void): void;
  /** After the batches are flushed: the retained renderer composites. */
  protected abstract present(): void;
  abstract destroy(): void;

  begin(ctx: CellContext, frame: FrameInfo): void {
    this.ctx = ctx;
    this.frame = frame;
    this._fills.clear();
    this._decorations.clear();
    this._runs.clear();
    this.stats.fillRequests = 0;
    this.stats.glyphRequests = 0;
    this.stats.copies = 0;
    this.stats.blits = 0;
    this.stats.cellsFilled = 0;
    this.stats.glyphsDrawn = 0;
  }

  fillCells(row: number, col: number, count: number, rgb: number): void {
    const frame = this.frame;
    if (!frame || count <= 0) return;
    const { cellWidth, cellHeight } = frame.metrics;
    push(this._fills, rgb, [
      this.offsetX + col * cellWidth,
      this.offsetY + row * cellHeight,
      count * cellWidth,
      cellHeight,
    ]);
    this.count('cellsFilled', count);
  }

  drawRun(row: number, col: number, run: GlyphRun, rgb: number): void {
    const frame = this.frame;
    if (!frame) return;
    const { cellWidth, cellHeight, baseline } = frame.metrics;
    let list = this._runs.get(rgb);
    if (!list) {
      list = [];
      this._runs.set(rgb, list);
    }
    // Grid-computed, per cell: a fractional font advance can never accumulate
    // into drift, because nothing ever advances a pen across the row.
    list.push({
      run,
      x: this.offsetX + col * cellWidth,
      y: this.offsetY + row * cellHeight + baseline,
    });
    this.count('glyphsDrawn', run.glyphs.length);
  }

  decorate(
    row: number,
    col: number,
    count: number,
    kind: DecorationKind,
    rgb: number,
  ): void {
    const frame = this.frame;
    if (!frame || count <= 0) return;
    const { cellWidth, cellHeight, baseline, underline, ruleHeight } =
      frame.metrics;
    const x = this.offsetX + col * cellWidth;
    const y = this.offsetY + row * cellHeight;
    const w = count * cellWidth;
    switch (kind) {
      case 'underline':
        push(this._decorations, rgb, [x, y + underline, w, ruleHeight]);
        break;
      case 'strike':
        push(this._decorations, rgb, [
          x,
          y + Math.round(baseline - baseline / 3),
          w,
          ruleHeight,
        ]);
        break;
      case 'overline':
        push(this._decorations, rgb, [x, y, w, ruleHeight]);
        break;
      case 'bar':
        push(this._decorations, rgb, [
          x,
          y,
          Math.max(1, ruleHeight * 2),
          cellHeight,
        ]);
        break;
      case 'cursorUnderline':
        push(this._decorations, rgb, [
          x,
          y + cellHeight - Math.max(2, ruleHeight * 2),
          w,
          Math.max(2, ruleHeight * 2),
        ]);
        break;
      case 'box': {
        // The unfocused cursor: an outline, so the cell keeps its own
        // colours and the character under it stays readable.
        const t = ruleHeight;
        push(this._decorations, rgb, [x, y, w, t]);
        push(this._decorations, rgb, [x, y + cellHeight - t, w, t]);
        push(this._decorations, rgb, [x, y, t, cellHeight]);
        push(this._decorations, rgb, [x + w - t, y, t, cellHeight]);
        break;
      }
    }
  }

  end(): void {
    this.draw((ctx) => {
      this._flushRects(ctx, this._fills);
      this._flushGlyphs(ctx);
      this._flushRects(ctx, this._decorations);
    });
    // After the surface's own call has returned, so a backend that had to
    // bind the surface to draw into it has put the window back first.
    this.present();
    this._fills.clear();
    this._decorations.clear();
    this._runs.clear();
  }

  private _flushRects(
    ctx: CellContext,
    batches: Map<number, number[][]>,
  ): void {
    for (const [rgb, rects] of batches) {
      if (!rects.length) continue;
      ctx.fillStyle = css(rgb);
      if (typeof ctx.fillRects === 'function') {
        // One `Render.FillRectangles` for the whole colour (ntk#253), where
        // a `fillRect` loop is one composite per rectangle.
        //
        // As `[x, y, w, h]` tuples rather than one flat run of numbers,
        // because the tuple is the only shape every backend reads: ntk and
        // Cocoa take either, and react-x11's Wayland context walks the
        // argument one *element* per rectangle, so a flat list hands it
        // numbers where it wants rectangles and it draws none of them —
        // silently, since a rectangle it cannot read is simply skipped.
        // Every background on that backend went missing (issue #17), which
        // left the grid transparent and the window's older pixels showing
        // through the composite.
        ctx.fillRects(rects);
      } else {
        for (const r of rects) ctx.fillRect(r[0], r[1], r[2], r[3]);
      }
      this.count('fillRequests');
    }
  }

  private _flushGlyphs(ctx: CellContext): void {
    if (!this._runs.size) return;
    if (typeof ctx.drawGlyphs !== 'function') return;
    const solid = ctx.createSolidPicture;
    const op = ctx.Render?.PictOp?.Over ?? 3;
    for (const [rgb, runs] of this._runs) {
      if (!runs.length) continue;
      let src: unknown;
      if (typeof solid === 'function') {
        // Premultiplied 0..1, which is what XRender solids are. Opaque, so the
        // premultiplication is the identity.
        src = solid.call(
          ctx,
          ((rgb >> 16) & 0xff) / 255,
          ((rgb >> 8) & 0xff) / 255,
          (rgb & 0xff) / 255,
          1,
        );
      } else {
        // No `createSolidPicture`: a backend drawing glyphs through something
        // other than XRender has no `Picture` to make one of. react-x11's
        // Wayland context2d is that backend (issue #17) — it rasterises
        // through a glyph atlas and takes the ink from the source's `color`,
        // or from `fillStyle` when the source has none. Both are set here,
        // because which of the two a non-XRender backend reads is its own
        // business; `fillStyle` is the public seam and the `color` is what
        // Wayland's own `fillText` hands its `drawGlyphs`.
        //
        // Requiring the solid was why this whole method used to return
        // early there — silently, because a frame that draws no glyphs is
        // still a frame: the cells came out in their own colours with no
        // text in any of them.
        const colour = css(rgb);
        ctx.fillStyle = colour;
        src = { color: colour };
      }
      ctx.drawGlyphs(op, src, runs);
      this.count('glyphRequests');
    }
  }
}

function push(
  batches: Map<number, number[][]>,
  key: number,
  rect: number[],
): void {
  const list = batches.get(key);
  if (list) list.push(rect);
  else batches.set(key, [rect]);
}

/**
 * The default: a retained `Surface` the size of the grid.
 *
 * Why a surface of our own rather than `Window#scrollRegion` on the window's
 * backing store: the window's backing store is where react-x11 paints every
 * *other* node too, so scrolling it would make our correctness depend on
 * nothing overlapping the band mid-frame and on core's damage bookkeeping not
 * repainting our rect after we moved it. The surface decouples us from both
 * for the price of one composite per frame.
 */
export class RetainedRenderer extends BatchingRenderer {
  readonly kind = 'retained' as const;
  private _app: unknown;
  private _Surface: SurfaceCtor;
  private _surface: SurfaceLike | null = null;
  private _surfaceCtx: CellContext | null = null;
  /** Whether `_surfaceCtx` is ours to destroy — see `ensure`. */
  private _ownsCtx = false;
  private _cols = 0;
  private _metrics: CellMetrics | null = null;

  constructor(app: unknown, Surface: SurfaceCtor) {
    super();
    this._app = app;
    this._Surface = Surface;
  }

  ensure(cols: number, rows: number, metrics: CellMetrics): boolean {
    const width = Math.max(1, cols * metrics.cellWidth);
    const height = Math.max(1, rows * metrics.cellHeight);
    const fits =
      this._surface !== null &&
      this._surface.width >= width &&
      this._surface.height >= height &&
      this._metrics?.cellWidth === metrics.cellWidth &&
      this._metrics?.cellHeight === metrics.cellHeight;
    this._cols = cols;
    this._metrics = metrics;
    if (fits) return true;
    this._release();
    // Grown with headroom, the way ntk grows a window's backing store: a
    // drag-resize is a stream of sizes, and reallocating on each one throws
    // the whole screen away every frame of the drag.
    const alloc = (n: number): number => Math.ceil((n * 5) / 4);
    try {
      this._surface = new this._Surface(this._app, {
        width: alloc(width),
        height: alloc(height),
        format: 'argb32',
      });
      // One context for the surface's whole life: a context is much heavier
      // than it looks on ntk's X11 surface (a GC and a Picture), which
      // builds one per `getContext` and says a caller doing many draws
      // should keep one rather than let `render` churn one per frame.
      //
      // Whether it *is* one per call is also how ownership is visible: ask
      // twice, and a surface that answers the same object owns it and frees
      // it with itself (the Cocoa and Wayland surfaces), where ntk's hands
      // over a new one the caller owes a `destroy()`. The spare goes back
      // here, and this costs one context per surface, not one per frame.
      this._surfaceCtx = this._surface.getContext('2d');
      const again = this._surface.getContext('2d');
      this._ownsCtx = again !== this._surfaceCtx;
      if (this._ownsCtx) again.destroy?.();
    } catch {
      this._surface = null;
      this._surfaceCtx = null;
      this._ownsCtx = false;
    }
    return false;
  }

  /**
   * Draw the frame into the surface.
   *
   * Straight through the held context, except where every context on the
   * backend is a view on one shared device: there the surface has to be made
   * the device's target before a draw lands in it, `render` is the public
   * call that does that and puts the window's target back after, and a draw
   * made outside it goes nowhere at all — which is silent, because nothing
   * refuses the draw. react-x11's Wayland backend is that case (issue #17):
   * its contexts are GL, and the grid the frame drew stayed empty.
   *
   * `restoreGLState` is the signal, because it *is* that property: a context
   * offers it to be put back after foreign drawing on the shared device (a
   * `<glarea>`'s frame, or — just as much — a surface's). On X11 and Cocoa
   * there is no shared device, no `restoreGLState`, and nothing changes.
   */
  protected draw(paint: (ctx: CellContext) => void): void {
    const windowCtx = this.ctx;
    const surface = this._surface;
    if (surface && typeof windowCtx?.restoreGLState === 'function') {
      surface.render(paint);
      // `render` rebinds the window's target but not the state around it,
      // and `present` is about to draw through this context again.
      windowCtx.restoreGLState();
      return;
    }
    if (this._surfaceCtx) paint(this._surfaceCtx);
  }

  copyRows(srcRow: number, dstRow: number, count: number): boolean {
    const surface = this._surface;
    const metrics = this._metrics;
    if (!surface || !metrics || count <= 0 || srcRow === dstRow) return false;
    const h = metrics.cellHeight;
    const delta = dstRow - srcRow;
    // `copyWithin(rect, dx, dy)` is `scrollRegion` for a surface: it shifts
    // the pixels *within* `rect` and writes nothing outside it — the band
    // that survives is `rect ∩ (rect + delta)`. So the rect is the union of
    // the source rows and the destination rows, not the source alone. Handed
    // only the source, a scroll up by one moved rows 2… into rows 1… and
    // never wrote row 0, while the mirror — shifted as a block — believed
    // the old row 1 had landed there, so the top line stayed stale after
    // every scroll (issue #60). With the union, the surviving band is exactly
    // `dstRow…dstRow+count`, sourced from exactly `srcRow…srcRow+count`.
    const ok = surface.copyWithin(
      {
        x: 0,
        y: Math.min(srcRow, dstRow) * h,
        width: this._cols * metrics.cellWidth,
        height: (count + Math.abs(delta)) * h,
      },
      0,
      delta * h,
    );
    if (ok) this.count('copies');
    return ok;
  }

  protected present(): void {
    const ctx = this.ctx;
    const frame = this.frame;
    const surface = this._surface;
    if (!ctx || !frame || !surface || typeof ctx.drawImage !== 'function') {
      return;
    }
    const width = frame.cols * frame.metrics.cellWidth;
    const height = frame.rows * frame.metrics.cellHeight;
    if (width <= 0 || height <= 0) return;
    // The whole grid, one composite, clipped by the pass: the damage the
    // node claimed is the grid rect, the diff decided what was *rendered*
    // into the surface — which is where the cost is — and the composite is
    // one request either way.
    //
    // As a `copy`: the grid is opaque, every cell filled, so replacing the
    // pixels under it is the same picture as blending over them, and it is
    // the shape the Cocoa backend turns into a row memcpy (react-x11#501)
    // and X11 into `PictOp.Src`. Context state, on the window's context, so
    // it goes back afterwards; a backend that cannot draw it refuses the
    // assignment and blends, which is the same pixels.
    const op = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(
      surface,
      0,
      0,
      width,
      height,
      frame.originX,
      frame.originY,
      width,
      height,
    );
    ctx.globalCompositeOperation = op ?? 'source-over';
    this.count('blits');
  }

  private _release(): void {
    if (this._ownsCtx) this._surfaceCtx?.destroy?.();
    this._surface?.destroy();
    this._surfaceCtx = null;
    this._ownsCtx = false;
    this._surface = null;
  }

  destroy(): void {
    this._release();
  }

  /** Whether the surface actually exists — the probe the factory reads. */
  get usable(): boolean {
    return this._surface !== null;
  }
}

/**
 * No buffer: draw the frame straight into the paint context.
 *
 * `copyRows` refuses, so the caller repaints what moved. That is not a
 * degradation to apologise for — `Node.paint` fills this node's background
 * before we draw, so there are no old pixels to shift in the first place.
 */
export class DirectRenderer extends BatchingRenderer {
  readonly kind = 'direct' as const;

  ensure(): boolean {
    // Nothing is retained between frames, so every frame is a fresh one and
    // the caller has to treat its mirror as empty.
    return false;
  }

  override begin(ctx: CellContext, frame: FrameInfo): void {
    super.begin(ctx, frame);
    this.offsetX = frame.originX;
    this.offsetY = frame.originY;
  }

  protected draw(paint: (ctx: CellContext) => void): void {
    if (this.ctx) paint(this.ctx);
  }

  copyRows(): boolean {
    return false;
  }

  protected present(): void {
    // already in the window
  }

  destroy(): void {
    // nothing owned
  }
}

/**
 * Pick a renderer for this context, or `null` when there is nothing to draw
 * with — the mock backend's context has no pixel API at all, and a component
 * that throws there cannot be tested headlessly (AGENTS.md).
 */
const PROBE_METRICS: CellMetrics = {
  cellWidth: 1,
  cellHeight: 1,
  baseline: 1,
  underline: 1,
  ruleHeight: 1,
};

export function createRenderer(
  app: unknown,
  ctx: CellContext,
  Surface: SurfaceCtor | null,
): RendererOps | null {
  if (typeof ctx.fillRect !== 'function') return null;
  if (Surface && typeof ctx.drawImage === 'function') {
    const retained = new RetainedRenderer(app, Surface);
    // Probing by construction rather than by feature-sniffing the server:
    // whether a pixmap can be made on this connection is the actual question.
    retained.ensure(1, 1, PROBE_METRICS);
    if (retained.usable) return retained;
    retained.destroy();
  }
  return new DirectRenderer();
}
