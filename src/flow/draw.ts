// The painter: the pane's drawing vocabulary, and the only place that talks
// to ntk's 2d context directly.
//
// It exists for two reasons beyond tidiness. The first is that react-x11
// types `Context2D` as `unknown` on purpose — it is ntk's API, not
// react-x11's — so *something* has to name the operations it uses, and
// naming them once beats naming them at forty call sites. The second is that
// the mock backend headless tests run on has no path API at all: this
// returns `null` there, the pane skips its drawing, and a custom node type
// written against `FlowPainter` never has to know (see `src/sparkline/`,
// which makes the same check for one stroke).
import type {
  FlowPainter,
  ShapeOptions,
  StrokeOptions,
  TextOptions,
  XYPosition,
} from './types.js';

/** The slice of ntk's context the pane draws through. */
interface CanvasLike {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin?: unknown;
  lineCap?: unknown;
  lineDashOffset?: number;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  roundRect?(x: number, y: number, w: number, h: number, radii: number): void;
  arc(x: number, y: number, r: number, from: number, to: number): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  setLineDash?(segments: number[]): void;
}

interface LayoutLike {
  width: number;
  height: number;
  draw(ctx: unknown, x: number, y: number): void;
}

/** One shaped string, kept between frames. */
export interface CachedText {
  width: number;
  height: number;
  layout: LayoutLike;
}

/** ntk's font cache, reached through `app.fonts`. */
export interface FontsLike {
  layout(
    content: string | Array<Record<string, unknown>>,
    style: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): LayoutLike;
}

export interface PainterOptions {
  fonts: FontsLike | null;
  /** The face unstyled text comes out in — the theme's `fontFamily`. */
  family: string;
  /** Ink for text that names no colour. */
  color: string;
  /**
   * Laid-out text, keyed by face, size, weight, colour and the string.
   *
   * Owned by the pane rather than the painter because a painter lives for
   * one repaint and a label does not change between them. The *layout* is
   * cached rather than only its width because shaping is the expensive half
   * and a `LayoutLike` can be drawn as many times as you like: a graph of
   * three hundred labels was shaping three hundred strings a frame, which
   * no amount of batching on the wire would have fixed.
   */
  cache: Map<string, CachedText>;
}

function isCanvas(ctx: unknown): ctx is CanvasLike {
  const c = ctx as Partial<CanvasLike> | null | undefined;
  return (
    typeof c?.beginPath === 'function' && typeof c?.fillRect === 'function'
  );
}

/** Bound, so a pathological graph cannot turn the width cache into a leak. */
const CACHE_LIMIT = 4000;

function fontStyle(
  opts: PainterOptions,
  options: TextOptions | undefined,
): Record<string, unknown> {
  return {
    family: options?.family ?? opts.family,
    size: options?.size ?? 13,
    weight: options?.weight ?? 400,
    style: 'normal',
    color: options?.color ?? opts.color,
  };
}

/**
 * Text metrics without a drawing context. The pane needs these *outside* a
 * repaint — a node with no explicit size is measured when the graph changes,
 * which is also when a hit test has to know how big it is — so measuring
 * cannot live behind the painter the way drawing does.
 */
function shape(
  opts: PainterOptions,
  text: string,
  options: TextOptions | undefined,
): CachedText | null {
  const { fonts, cache } = opts;
  if (!fonts) return null;
  const size = options?.size ?? 13;
  const family = options?.family ?? opts.family;
  // The colour is part of the key: it is baked into the layout, so two
  // labels that differ only in ink are two shaped runs.
  const key = `${family}|${size}|${options?.weight ?? 400}|${options?.color ?? opts.color}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const layout = fonts.layout(text, fontStyle(opts, options));
  if (cache.size >= CACHE_LIMIT) cache.clear();
  const entry = {
    width: layout.width,
    height: layout.height || size * 1.3,
    layout,
  };
  cache.set(key, entry);
  return entry;
}

export function measureText(
  opts: PainterOptions,
  text: string,
  options?: TextOptions,
): { width: number; height: number } {
  const size = options?.size ?? 13;
  const entry = shape(opts, text, options);
  if (!entry) {
    // No font stack to ask. An estimate keeps layout plausible rather than
    // collapsing every node to its own padding.
    return { width: text.length * size * 0.55, height: size * 1.3 };
  }
  return { width: entry.width, height: entry.height };
}

class Painter implements FlowPainter {
  readonly raw: unknown;
  private readonly ctx: CanvasLike;
  private readonly opts: PainterOptions;

  constructor(ctx: CanvasLike, opts: PainterOptions) {
    this.ctx = ctx;
    this.raw = ctx;
    this.opts = opts;
  }

  save(): void {
    this.ctx.save();
  }

  restore(): void {
    this.ctx.restore();
  }

  clipRect(x: number, y: number, w: number, h: number, radius = 0): void {
    const { ctx } = this;
    ctx.beginPath();
    if (radius > 0 && typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, radius);
    } else {
      ctx.rect(x, y, w, h);
    }
    ctx.clip();
  }

  private applyStroke(options: StrokeOptions): void {
    const { ctx } = this;
    ctx.strokeStyle = options.stroke ?? this.opts.color;
    ctx.lineWidth = options.lineWidth ?? 1;
    if (typeof ctx.setLineDash === 'function') {
      ctx.setLineDash(options.dash ? [...options.dash] : []);
      if ('lineDashOffset' in ctx) ctx.lineDashOffset = options.dashOffset ?? 0;
    }
  }

  private clearDash(): void {
    const { ctx } = this;
    if (typeof ctx.setLineDash === 'function') {
      ctx.setLineDash([]);
      if ('lineDashOffset' in ctx) ctx.lineDashOffset = 0;
    }
  }

  rect(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    options: ShapeOptions,
  ): void {
    if (w <= 0 || h <= 0) return;
    const { ctx } = this;
    const rounded = radius > 0 && typeof ctx.roundRect === 'function';
    // The square, opaque case is most of what a graph draws (the grid, the
    // minimap's nodes, a label chip's shadowless plate) and `fillRect` is a
    // single server-side rectangle rather than a path to rasterize.
    if (!rounded && !options.stroke && options.fill) {
      ctx.fillStyle = options.fill;
      ctx.fillRect(x, y, w, h);
      return;
    }
    ctx.beginPath();
    if (rounded) ctx.roundRect!(x, y, w, h, radius);
    else ctx.rect(x, y, w, h);
    if (options.fill) {
      ctx.fillStyle = options.fill;
      ctx.fill();
    }
    if (options.stroke) {
      // The stroke is a second path, inset by half the pen: ntk's stroke
      // fast path (ntk#211, #217) takes a border whose ink band lands on
      // whole pixels — "path inset by bw/2" is its documented contract —
      // and a band centred on the box edge is half-pixel at every width,
      // which cost every stroked card a rasterized mask and a PutImage.
      // This is also core's own `_paintBorder` geometry, so borders drawn
      // here sit exactly where `<box borderWidth>` puts them.
      const pen = options.lineWidth ?? 1;
      if (w > pen && h > pen) {
        const inset = pen / 2;
        ctx.beginPath();
        if (rounded) {
          ctx.roundRect!(
            x + inset,
            y + inset,
            w - pen,
            h - pen,
            Math.max(0, radius - inset),
          );
        } else {
          ctx.rect(x + inset, y + inset, w - pen, h - pen);
        }
      }
      this.applyStroke(options);
      ctx.stroke();
      this.clearDash();
    }
  }

  circle(x: number, y: number, r: number, options: ShapeOptions): void {
    if (r <= 0) return;
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (options.fill) {
      ctx.fillStyle = options.fill;
      ctx.fill();
    }
    if (options.stroke) {
      this.applyStroke(options);
      ctx.stroke();
      this.clearDash();
    }
  }

  polyline(points: readonly XYPosition[], options: StrokeOptions): void {
    if (points.length < 2) return;
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++)
      ctx.lineTo(points[i].x, points[i].y);
    this.applyStroke(options);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    this.clearDash();
  }

  strokeRuns(
    runs: readonly (readonly XYPosition[])[],
    options: StrokeOptions,
  ): void {
    const { ctx } = this;
    let any = false;
    ctx.beginPath();
    for (const run of runs) {
      if (run.length < 2) continue;
      any = true;
      ctx.moveTo(run[0].x, run[0].y);
      for (let i = 1; i < run.length; i++) ctx.lineTo(run[i].x, run[i].y);
    }
    if (!any) return;
    this.applyStroke(options);
    ctx.stroke();
    this.clearDash();
  }

  dots(centres: readonly XYPosition[], size: number, color: string): void {
    if (centres.length === 0 || size <= 0) return;
    const { ctx } = this;
    const half = size / 2;
    ctx.beginPath();
    for (const c of centres) ctx.rect(c.x - half, c.y - half, size, size);
    ctx.fillStyle = color;
    ctx.fill();
  }

  polygons(
    shapes: readonly (readonly XYPosition[])[],
    options: ShapeOptions,
  ): void {
    const { ctx } = this;
    let any = false;
    ctx.beginPath();
    for (const points of shapes) {
      if (points.length < 3) continue;
      any = true;
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++)
        ctx.lineTo(points[i].x, points[i].y);
      ctx.closePath();
    }
    if (!any) return;
    if (options.fill) {
      ctx.fillStyle = options.fill;
      ctx.fill();
    }
    if (options.stroke) {
      this.applyStroke(options);
      ctx.stroke();
      this.clearDash();
    }
  }

  polygon(points: readonly XYPosition[], options: ShapeOptions): void {
    if (points.length < 3) return;
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++)
      ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    if (options.fill) {
      ctx.fillStyle = options.fill;
      ctx.fill();
    }
    if (options.stroke) {
      this.applyStroke(options);
      ctx.stroke();
      this.clearDash();
    }
  }

  measureText(
    text: string,
    options?: TextOptions,
  ): { width: number; height: number } {
    return measureText(this.opts, text, options);
  }

  /** Cut a string to fit, with an ellipsis. Linear from the end rather than
   * a binary search: labels that need it are short, and the widths it walks
   * through are the ones the cache already holds. */
  private fit(
    text: string,
    options: TextOptions | undefined,
    max: number,
  ): string {
    if (this.measureText(text, options).width <= max) return text;
    let cut = text.length;
    while (cut > 1) {
      cut--;
      const candidate = `${text.slice(0, cut).trimEnd()}…`;
      if (this.measureText(candidate, options).width <= max) return candidate;
    }
    return '…';
  }

  text(text: string, x: number, y: number, options?: TextOptions): void {
    if (!text) return;
    const shown = options?.maxWidth
      ? this.fit(text, options, options.maxWidth)
      : text;
    const entry = shape(this.opts, shown, options);
    if (!entry) return;
    const layout = entry;
    const align = options?.align ?? 'left';
    const dx =
      align === 'center'
        ? -layout.width / 2
        : align === 'right'
          ? -layout.width
          : 0;
    const dy = options?.baseline === 'middle' ? -layout.height / 2 : 0;
    entry.layout.draw(this.raw, Math.round(x + dx), Math.round(y + dy));
  }
}

/**
 * A painter over this context, or `null` when the backend cannot draw paths
 * — which is the signal to skip drawing entirely rather than to throw.
 */
export function createPainter(
  ctx: unknown,
  options: PainterOptions,
): FlowPainter | null {
  if (!isCanvas(ctx)) return null;
  return new Painter(ctx, options);
}
