// The retained node behind `<mermaid>` — one diagram, drawn.
//
// The split with `scene.ts`: the scene is ondine's SVG read into outlines
// and text runs in the diagram's own units, and this node is the ntk
// connection — it fits the scene to the box it was laid out in, fills and
// strokes the outlines, sets each run through the app's font manager, and
// answers core's four text accessors so a `selectable` document (a
// `<Markdown>` with a mermaid fence) selects across the labels like any
// other text. `../formula/node.ts` is the same shape.
import { Node } from 'react-x11/node';
import { Surface } from 'react-x11/ntk';
import type {
  Context2D,
  MeasureConstraints,
  MeasuredSize,
} from 'react-x11/node';
import type { Rect } from 'react-x11';

import { placedAnchor } from './scene.js';
import type { MermaidScene, ScenePath, SceneText } from './scene.js';

/** The element name — registration key, `node.kind` and JSX tag alike. */
export const ELEMENT = 'mermaid';

/** The ntk connection a node is built against. */
export type NtkApp = ConstructorParameters<typeof Node>[2];

/** The props `<mermaid>` takes. Apps use `<Mermaid>`, which compiles the
 *  source and carries the fallback states. */
export interface MermaidElementProps {
  /** The diagram, read. Stable identity per source and theme — the caches
   *  key off it. */
  scene: MermaidScene;
  /** Whether a link in the diagram shows the hand cursor — set when the
   *  component has an `onLink` to follow it with. */
  links?: boolean;
}

// --- the slices of ntk this node speaks to -----------------------------------

interface MiniLine {
  baseline: number;
  height?: number;
}

interface MiniLayout {
  width: number;
  height?: number;
  lines: MiniLine[];
  draw(ctx: unknown, x?: number, y?: number): void;
}

interface FontsLike {
  layout(
    content: Array<Record<string, unknown>>,
    style: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): MiniLayout;
}

// The mock backend's context implements none of the path API, and a paint
// that assumed otherwise would throw in every headless test.

function canFill(ctx: Context2D): boolean {
  return typeof ctx?.fillRect === 'function';
}

function canPath(ctx: Context2D): boolean {
  return (
    typeof ctx.beginPath === 'function' &&
    typeof ctx.bezierCurveTo === 'function' &&
    typeof ctx.fill === 'function' &&
    typeof ctx.stroke === 'function'
  );
}

/** A run as drawn: where its ink box is, in device pixels from the
 *  element's corner, and which code points of `textContent` it holds. */
interface PlacedRun {
  run: SceneText;
  index: number;
  length: number;
  x: number;
  top: number;
  width: number;
  bottom: number;
  /** Where `draw` puts the layout's top-left, and the layout. */
  drawX: number;
  drawY: number;
  mini: MiniLayout | null;
  /** The turn a run that is not upright is drawn through, about its
   *  anchor; null for the rest. */
  turn: {
    ax: number;
    ay: number;
    a: number;
    b: number;
    c: number;
    d: number;
  } | null;
}

interface Placement {
  /** Device pixels per diagram unit. */
  k: number;
  runs: PlacedRun[];
  text: string;
}

export class MermaidNode extends Node {
  private _placement: Placement | null = null;
  private _placedFor: { scene: MermaidScene; k: number } | null = null;
  private _minis = new Map<string, MiniLayout | null>();
  /** Turned labels, set level on a surface of their own — see `_drawTurned`. */
  private _turned = new Map<PlacedRun, Surface | null>();

  constructor(props: Record<string, unknown>, app: NtkApp) {
    super(ELEMENT, props, app);
  }

  private _props(): Partial<MermaidElementProps> {
    return this.props as unknown as Partial<MermaidElementProps>;
  }

  private _fonts(): FontsLike | null {
    const fonts = (this.app as { fonts?: FontsLike } | null)?.fonts;
    return fonts && typeof fonts.layout === 'function' ? fonts : null;
  }

  // --- units ---------------------------------------------------------------
  //
  // The scene is in ondine's units, which are logical pixels at the font
  // size it was compiled at. `abs`, the paint and the four text accessors
  // are device pixels (react-x11's docs/scale.md), so the node draws at
  // `k` device pixels per unit: the display scale where the diagram fits,
  // and less where its box was laid out narrower — a diagram wider than
  // its column shrinks to it, labels and all, as an `<img>` under
  // `max-width: 100%` does.

  private get _scale(): number {
    return this.scale > 0 ? this.scale : 1;
  }

  private _k(): number {
    const scene = this._props().scene;
    if (!scene || !(scene.width > 0)) return this._scale;
    const w = this.abs.width;
    if (!(w > 0)) return this._scale;
    return Math.min(this._scale, w / scene.width);
  }

  override measureContent(constraints: MeasureConstraints): MeasuredSize {
    const scene = this._props().scene;
    if (!scene || !(scene.width > 0) || !(scene.height > 0)) {
      return { width: 0, height: 0 };
    }
    const s = this._scale;
    let k = s;
    const room = constraints.width;
    if (Number.isFinite(room) && room > 0 && scene.width * s > room) {
      k = room / scene.width;
    }
    return { width: scene.width * k, height: scene.height * k };
  }

  override applyProps(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): void {
    super.applyProps(nextProps, prevProps);
    if (nextProps.scene !== prevProps.scene) {
      this._placement = null;
      this._placedFor = null;
      this._minis.clear();
      this._dropTurned();
      this.invalidateMeasure('content');
    }
  }

  override destroySubtree(): void {
    this._minis.clear();
    this._dropTurned();
    super.destroySubtree();
  }

  private _dropTurned(): void {
    for (const surface of this._turned.values()) surface?.destroy();
    this._turned.clear();
  }

  // --- placing the text --------------------------------------------------------

  private _mini(run: SceneText, size: number): MiniLayout | null {
    const fonts = this._fonts();
    if (!fonts) return null;
    const key = `${run.family}|${run.weight}|${size}|${run.fill}|${run.text}`;
    const hit = this._minis.get(key);
    if (hit !== undefined) return hit;
    let mini: MiniLayout | null = null;
    try {
      mini = fonts.layout(
        [
          {
            text: run.text,
            family: run.family,
            size,
            weight: run.weight,
            color: run.fill,
          },
        ],
        { family: run.family, size },
      );
    } catch {
      mini = null;
    }
    if (this._minis.size > 2048) this._minis.clear();
    this._minis.set(key, mini);
    return mini;
  }

  private _place(): Placement | null {
    const scene = this._props().scene;
    if (!scene) return null;
    const k = this._k();
    const prev = this._placedFor;
    if (this._placement && prev && prev.scene === scene && prev.k === k) {
      return this._placement;
    }
    const runs: PlacedRun[] = [];
    let index = 0;
    const parts: string[] = [];
    for (const run of scene.texts) {
      const at = placedAnchor(run);
      const size = at.size * k;
      const mini = this._mini(run, size);
      const length = [...run.text].length;
      // ondine laid the label out at 0.6 em a character; the face drawn may
      // differ, so the anchor is honoured with the width it actually has
      const width = mini ? mini.width : run.text.length * size * 0.6;
      const baseline = mini?.lines[0]?.baseline ?? size * 0.8;
      const lineHeight = mini?.lines[0]?.height ?? mini?.height ?? size * 1.2;
      const shift =
        run.anchor === 'middle' ? width / 2 : run.anchor === 'end' ? width : 0;
      const ax = at.x * k;
      const ay = at.y * k;
      let placed: PlacedRun;
      if (at.upright) {
        placed = {
          run,
          index,
          length,
          x: ax - shift,
          top: ay - baseline,
          width,
          bottom: ay - baseline + lineHeight,
          drawX: ax - shift,
          drawY: ay - baseline,
          mini,
          turn: null,
        };
      } else {
        // drawn about its anchor through the run's own linear part; its
        // box for selection is the turned box's bounds
        const m = run.matrix;
        const n = Math.hypot(m[0], m[1]) || 1;
        const turn = {
          ax,
          ay,
          a: m[0] / n,
          b: m[1] / n,
          c: m[2] / n,
          d: m[3] / n,
        };
        const corners: Array<[number, number]> = [
          [-shift, -baseline],
          [width - shift, -baseline],
          [-shift, lineHeight - baseline],
          [width - shift, lineHeight - baseline],
        ].map(([x, y]) => [
          ax + turn.a * x + turn.c * y,
          ay + turn.b * x + turn.d * y,
        ]);
        const xs = corners.map((p) => p[0]);
        const ys = corners.map((p) => p[1]);
        placed = {
          run,
          index,
          length,
          x: Math.min(...xs),
          top: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          bottom: Math.max(...ys),
          drawX: -shift,
          drawY: -baseline,
          mini,
          turn,
        };
      }
      runs.push(placed);
      parts.push(run.text);
      // one code point of separator between runs, which no run holds
      index += length + 1;
    }
    this._dropTurned();
    this._placement = { k, runs, text: parts.join('\n') };
    this._placedFor = { scene, k };
    return this._placement;
  }

  // --- answering for our own text ------------------------------------------
  //
  // The four accessors from react-x11#291, over the runs in reading order.
  // Indices are code points into `textContent()` and rectangles are in the
  // owning window's device coordinates — the space `abs` is in.

  override textContent(): string {
    return this._place()?.text ?? '';
  }

  override textIndexAt(x: number, y: number): number {
    const runs = this._place()?.runs ?? [];
    if (!runs.length) return 0;
    const lx = x - this.abs.x;
    const ly = y - this.abs.y;
    let best: PlacedRun | null = null;
    let bestDist = Infinity;
    for (const r of runs) {
      const dx =
        lx < r.x ? r.x - lx : lx > r.x + r.width ? lx - (r.x + r.width) : 0;
      const dy = ly < r.top ? r.top - ly : ly > r.bottom ? ly - r.bottom : 0;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = r;
        if (dist === 0) break;
      }
    }
    if (!best) return 0;
    const within = best.width
      ? Math.round(((lx - best.x) / best.width) * best.length)
      : 0;
    return best.index + Math.max(0, Math.min(best.length, within));
  }

  override textCaretRect(index: number): Rect | null {
    const runs = this._place()?.runs ?? [];
    if (!runs.length) return null;
    let r = runs[runs.length - 1];
    for (const candidate of runs) {
      if (
        index >= candidate.index &&
        index <= candidate.index + candidate.length
      ) {
        r = candidate;
        break;
      }
    }
    const fraction = r.length
      ? Math.max(0, Math.min(1, (index - r.index) / r.length))
      : 0;
    return {
      x: this.abs.x + r.x + fraction * r.width,
      y: this.abs.y + r.top,
      width: 0,
      height: r.bottom - r.top,
    };
  }

  override textRangeRects(start: number, end: number): Rect[] {
    if (end <= start) return [];
    const bands: Rect[] = [];
    for (const r of this._place()?.runs ?? []) {
      const a = Math.max(start, r.index);
      const b = Math.min(end, r.index + r.length);
      if (b <= a) continue;
      const x1 = r.x + (r.length ? ((a - r.index) / r.length) * r.width : 0);
      const x2 =
        r.x + (r.length ? ((b - r.index) / r.length) * r.width : r.width);
      bands.push({
        x: this.abs.x + x1,
        y: this.abs.y + r.top,
        width: x2 - x1,
        height: r.bottom - r.top,
      });
    }
    return bands;
  }

  // --- links ---------------------------------------------------------------

  /** The link under a device point, from what is painted on top. */
  private _hrefAtDevice(x: number, y: number): string | null {
    const placement = this._place();
    const scene = this._props().scene;
    if (!placement || !scene) return null;
    const lx = x - this.abs.x;
    const ly = y - this.abs.y;
    for (const r of placement.runs) {
      if (r.run.href == null) continue;
      if (lx >= r.x && lx <= r.x + r.width && ly >= r.top && ly <= r.bottom) {
        return r.run.href;
      }
    }
    const k = placement.k;
    for (let i = scene.items.length - 1; i >= 0; i--) {
      const item = scene.items[i];
      if (item.kind !== 'path' || item.href == null || !item.bounds) continue;
      const b = item.bounds;
      if (
        lx >= b.x * k &&
        lx <= (b.x + b.width) * k &&
        ly >= b.y * k &&
        ly <= (b.y + b.height) * k
      ) {
        return item.href;
      }
    }
    return null;
  }

  /** The link under a **logical** window point — the one a mouse event
   *  carries — for `useLinkClicks`, which asks for this method by name. */
  hrefAtPoint(x: number, y: number): string | null {
    const s = this._scale;
    return this._hrefAtDevice(x * s, y * s);
  }

  /** The hand over a link the component will follow. Core asks in device
   *  pixels. */
  override cursorAt(x: number, y: number): string | null {
    if (!this._props().links) return null;
    return this._hrefAtDevice(x, y) != null ? 'pointer' : null;
  }

  // --- paint ---------------------------------------------------------------

  private _drawPath(ctx: Context2D, p: ScenePath, k: number): void {
    const ox = this.abs.x;
    const oy = this.abs.y;
    ctx.beginPath();
    for (const s of p.segs) {
      switch (s.c) {
        case 'M':
          ctx.moveTo(ox + s.x * k, oy + s.y * k);
          break;
        case 'L':
          ctx.lineTo(ox + s.x * k, oy + s.y * k);
          break;
        case 'C':
          ctx.bezierCurveTo(
            ox + s.x1 * k,
            oy + s.y1 * k,
            ox + s.x2 * k,
            oy + s.y2 * k,
            ox + s.x * k,
            oy + s.y * k,
          );
          break;
        case 'Z':
          ctx.closePath();
          break;
      }
    }
    if (p.fill && p.fillOpacity > 0) {
      ctx.globalAlpha = Math.min(1, p.fillOpacity);
      ctx.fillStyle = p.fill;
      ctx.fill();
    }
    if (p.stroke && p.strokeOpacity > 0 && p.strokeWidth > 0) {
      ctx.globalAlpha = Math.min(1, p.strokeOpacity);
      ctx.strokeStyle = p.stroke;
      ctx.lineWidth = p.strokeWidth * k;
      ctx.lineCap = p.cap;
      ctx.lineJoin = p.join;
      if (typeof ctx.setLineDash === 'function') {
        ctx.setLineDash(p.dash ? p.dash.map((d) => d * k) : []);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * A label that is not upright — an axis title, a git commit id at 45° —
   * drawn about its anchor through its own turn. A context that turns
   * glyphs with the rest (`scalesText`: macOS, Windows) draws the layout
   * through the matrix; ntk sets a glyph as it was shaped wherever the
   * matrix puts it, so on X11 and Wayland the label is set level on a
   * surface and the surface is drawn through the matrix, which turns
   * pixels — `<Html>`'s `paintRaster` makes the same call.
   */
  private _drawTurned(
    ctx: Context2D,
    r: PlacedRun,
    x: number,
    y: number,
  ): void {
    const turn = r.turn!;
    const mini = r.mini!;
    ctx.save();
    ctx.translate(x + turn.ax, y + turn.ay);
    ctx.transform(turn.a, turn.b, turn.c, turn.d, 0, 0);
    if (ctx.scalesText || typeof ctx.drawImage !== 'function') {
      mini.draw(ctx, r.drawX, r.drawY);
      ctx.restore();
      return;
    }
    let surface = this._turned.get(r);
    if (surface === undefined) {
      surface = null;
      const lineHeight = mini.lines[0]?.height ?? mini.height ?? 0;
      const width = Math.ceil(mini.width) + 2;
      const height = Math.ceil(lineHeight || r.run.size * 1.5) + 2;
      try {
        surface = new Surface(this.app, { width, height });
        surface.render((sctx) => mini.draw(sctx, 1, 1));
      } catch {
        surface?.destroy();
        surface = null;
      }
      this._turned.set(r, surface);
    }
    if (surface) ctx.drawImage(surface, r.drawX - 1, r.drawY - 1);
    else mini.draw(ctx, r.drawX, r.drawY);
    ctx.restore();
  }

  override paint(ctx: Context2D): void {
    super.paint(ctx); // background, border, clip to `abs`
    const scene = this._props().scene;
    const placement = this._place();
    if (!scene || !placement || !canFill(ctx)) return;
    const { k } = placement;
    const { x, y } = this.abs;

    ctx.save();

    // 1. the band the document selection has claimed of this diagram
    const range = this.selectionRange;
    const selectionColor = this.selectionColor;
    if (selectionColor && range && range.end > range.start) {
      ctx.fillStyle = selectionColor;
      for (const r of this.textRangeRects(range.start, range.end)) {
        ctx.fillRect(
          Math.round(r.x),
          Math.round(r.y),
          Math.ceil(r.width),
          Math.ceil(r.height),
        );
      }
    }

    // 2. everything, in the order ondine wrote it — a label's backing
    //    pill is drawn before the label, and a node over the edges into it
    const paths = canPath(ctx);
    const placed = new Map<SceneText, PlacedRun>();
    for (const r of placement.runs) placed.set(r.run, r);
    for (const item of scene.items) {
      if (item.kind === 'path') {
        if (paths) this._drawPath(ctx, item, k);
        continue;
      }
      const r = placed.get(item);
      if (!r || !r.mini || !r.mini.lines.length) continue;
      const alpha = Math.min(1, item.opacity);
      if (alpha <= 0) continue;
      if (alpha < 1) ctx.globalAlpha = alpha;
      if (r.turn && typeof ctx.transform === 'function') {
        this._drawTurned(ctx, r, x, y);
      } else {
        r.mini.draw(ctx, x + r.drawX, y + r.drawY);
      }
      if (alpha < 1) ctx.globalAlpha = 1;
    }

    ctx.restore();
  }
}
