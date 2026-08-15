// The retained node behind `<formula>` — one laid-out piece of mathematics.
//
// The split with `layout.ts`: the layout is pure geometry (KaTeX's tree in,
// positioned glyphs/rules/paths out), and this node is the ntk connection —
// it measures through the app's font manager, draws each glyph run through
// `fonts.layout`, fills rules and svg surds, and answers core's four text
// accessors so a `selectable` document (a `<Markdown>` with a math fence,
// or the component's own root) selects across the mathematics like any
// other text. Same seam `../richtext/node.ts` stands on; docs/extending.md
// calls it "answer from what you draw".
import { Node } from 'react-x11/node';
import type {
  Context2D,
  MeasureConstraints,
  MeasuredSize,
} from 'react-x11/node';
import type { Rect } from 'react-x11';

import { faceOf } from './katex.js';
import type { KatexNode } from './katex.js';
import { layoutFormula } from './layout.js';
import type {
  FormulaGlyph,
  FormulaLayout,
  FormulaPath,
  FormulaShaper,
} from './layout.js';

/** The element name — registration key, `node.kind` and JSX tag alike. */
export const ELEMENT = 'formula';

/** The ntk connection a node is built against. Derived from `Node`'s own
 *  constructor rather than named, so it cannot drift from core's. */
export type NtkApp = ConstructorParameters<typeof Node>[2];

/** The props `<formula>` takes. The component builds them; apps use
 *  `<Formula>`, which also carries the fallback states. */
export interface FormulaElementProps {
  /** KaTeX's virtual DOM for the expression. Stable identity per source —
   *  the layout cache keys off it. */
  tree: KatexNode;
  /** Pixels per em at the formula's base size. */
  size: number;
  /** Ink color for everything the expression does not color itself. */
  color: string;
  /** `KaTeX_Main-Regular.ttf` → bytes, registered into the app's font
   *  manager on first use. Absent means "shape through system fonts". */
  fontData?: ReadonlyMap<string, Uint8Array> | null;
}

// --- the slices of ntk this node speaks to ---------------------------------
// Typed structurally rather than imported: react-x11 keeps ntk deliberately
// loose, so an element says what it needs and nothing more.

interface MiniLine {
  baseline: number;
}

interface MiniLayout {
  width: number;
  lines: MiniLine[];
  draw(ctx: unknown, x?: number, y?: number): void;
}

interface FontsLike {
  layout(
    content: Array<Record<string, unknown>>,
    style: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): MiniLayout;
  load(
    source: Uint8Array,
    opts?: { family?: string; weight?: number; style?: string },
  ): unknown;
}

interface FillContext {
  fillStyle: unknown;
  save(): void;
  restore(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
}

function canFill(ctx: Context2D): ctx is FillContext {
  return typeof (ctx as Partial<FillContext> | null)?.fillRect === 'function';
}

interface PathContext extends FillContext {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x: number,
    y: number,
  ): void;
  quadraticCurveTo(x1: number, y1: number, x: number, y: number): void;
  closePath(): void;
  fill(): void;
}

function canPath(ctx: FillContext): ctx is PathContext {
  const c = ctx as Partial<PathContext>;
  return (
    typeof c.beginPath === 'function' &&
    typeof c.bezierCurveTo === 'function' &&
    typeof c.fill === 'function'
  );
}

/** The managers that already hold the KaTeX faces — `fonts.load` is
 *  registration, so doing it twice per manager would shadow itself. */
const fontsRegistered = new WeakSet<object>();

function registerKatexFonts(
  fonts: FontsLike,
  data: ReadonlyMap<string, Uint8Array>,
): void {
  if (fontsRegistered.has(fonts)) return;
  fontsRegistered.add(fonts);
  for (const [file, bytes] of data) {
    try {
      fonts.load(bytes, faceOf(file));
    } catch {
      // one unreadable face degrades that face to system fallback, which
      // is the ordinary state, not an error
    }
  }
}

export class FormulaNode extends Node {
  private _layout: FormulaLayout | null = null;
  private _layoutOf: { tree: KatexNode; size: number; color: string } | null =
    null;
  private _widths = new Map<string, number>();
  private _minis = new Map<string, MiniLayout | null>();

  constructor(props: Record<string, unknown>, app: NtkApp) {
    super(ELEMENT, props, app);
  }

  private _props(): Partial<FormulaElementProps> {
    return this.props as unknown as Partial<FormulaElementProps>;
  }

  private _fonts(): FontsLike | null {
    const fonts = (this.app as { fonts?: FontsLike } | null)?.fonts;
    if (!fonts || typeof fonts.layout !== 'function') return null;
    const data = this._props().fontData;
    if (data && typeof fonts.load === 'function') {
      registerKatexFonts(fonts, data);
    }
    return fonts;
  }

  /** Measure one run in one face, memoized — the layout asks per glyph. */
  private _shaper(fonts: FontsLike): FormulaShaper {
    return {
      width: (text, family, weight, style, size) => {
        const key = `${family}|${weight}|${style}|${size}|${text}`;
        const hit = this._widths.get(key);
        if (hit !== undefined) return hit;
        let width: number;
        try {
          width = fonts.layout([{ text, family, size, weight, style }], {
            family,
            size,
          }).width;
        } catch {
          return null;
        }
        if (this._widths.size > 2048) this._widths.clear();
        this._widths.set(key, width);
        return width;
      },
    };
  }

  private _ensureLayout(): FormulaLayout | null {
    const { tree, size = 14, color = 'black' } = this._props();
    if (!tree) return null;
    const prev = this._layoutOf;
    if (
      this._layout &&
      prev &&
      prev.tree === tree &&
      prev.size === size &&
      prev.color === color
    ) {
      return this._layout;
    }
    const fonts = this._fonts();
    this._layout = layoutFormula(tree, {
      em: size,
      color,
      shaper: fonts ? this._shaper(fonts) : null,
    });
    this._layoutOf = { tree, size, color };
    return this._layout;
  }

  /** The natural size; mathematics does not wrap, so the offered width is
   *  not consulted and an over-wide formula overflows (scrollable inside
   *  its parent, like a code block). */
  override measureContent(_constraints: MeasureConstraints): MeasuredSize {
    const layout = this._ensureLayout();
    if (!layout) return { width: 0, height: 0 };
    return {
      width: layout.width,
      height: layout.ascent + layout.descent,
    };
  }

  override applyProps(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): void {
    super.applyProps(nextProps, prevProps);
    if (
      nextProps.tree !== prevProps.tree ||
      nextProps.size !== prevProps.size ||
      nextProps.color !== prevProps.color ||
      nextProps.fontData !== prevProps.fontData
    ) {
      this._layout = null;
      this._layoutOf = null;
      this._minis.clear();
      this.invalidateMeasure('content');
    }
  }

  override destroySubtree(): void {
    this._widths.clear();
    this._minis.clear();
    super.destroySubtree();
  }

  // --- answering for our own text ------------------------------------------
  //
  // The four accessors from react-x11#291, over the glyphs in reading
  // order. Indices are **code points** into `textContent()` and rectangles
  // are in the owning window's coordinates — the space `abs` is in.

  private _glyphs(): FormulaGlyph[] {
    return this._ensureLayout()?.glyphs ?? [];
  }

  override textContent(): string {
    return this._ensureLayout()?.text ?? '';
  }

  override textIndexAt(x: number, y: number): number {
    const glyphs = this._glyphs();
    if (!glyphs.length) return 0;
    const lx = x - this.abs.x;
    const ly = y - this.abs.y;
    let best: FormulaGlyph | null = null;
    let bestDist = Infinity;
    for (const g of glyphs) {
      const dx =
        lx < g.x ? g.x - lx : lx > g.x + g.width ? lx - (g.x + g.width) : 0;
      const dy = ly < g.top ? g.top - ly : ly > g.bottom ? ly - g.bottom : 0;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = g;
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
    const glyphs = this._glyphs();
    if (!glyphs.length) return null;
    let g = glyphs[glyphs.length - 1];
    for (const candidate of glyphs) {
      if (
        index >= candidate.index &&
        index <= candidate.index + candidate.length
      ) {
        g = candidate;
        break;
      }
    }
    const fraction = g.length
      ? Math.max(0, Math.min(1, (index - g.index) / g.length))
      : 0;
    return {
      x: this.abs.x + g.x + fraction * g.width,
      y: this.abs.y + g.top,
      width: 0,
      height: g.bottom - g.top,
    };
  }

  override textRangeRects(start: number, end: number): Rect[] {
    if (end <= start) return [];
    const bands: Rect[] = [];
    for (const g of this._glyphs()) {
      const a = Math.max(start, g.index);
      const b = Math.min(end, g.index + g.length);
      if (b <= a) continue;
      const x1 = g.x + (g.length ? ((a - g.index) / g.length) * g.width : 0);
      const x2 =
        g.x + (g.length ? ((b - g.index) / g.length) * g.width : g.width);
      const rect = {
        x: this.abs.x + x1,
        y: this.abs.y + g.top,
        width: x2 - x1,
        height: g.bottom - g.top,
      };
      // consecutive glyphs on the same band fuse into one rectangle, so an
      // ordinary run selects as one strip rather than a picket fence
      const last = bands[bands.length - 1];
      if (
        last &&
        Math.abs(last.y - rect.y) < 0.5 &&
        Math.abs(last.height - rect.height) < 0.5 &&
        rect.x >= last.x - 0.5 &&
        rect.x <= last.x + last.width + 1.5
      ) {
        last.width = Math.max(last.width, rect.x + rect.width - last.x);
      } else {
        bands.push(rect);
      }
    }
    return bands;
  }

  // --- paint ---------------------------------------------------------------

  private _mini(g: FormulaGlyph): MiniLayout | null {
    const fonts = this._fonts();
    if (!fonts) return null;
    const key = `${g.family}|${g.weight}|${g.style}|${g.size}|${g.color}|${g.text}`;
    const hit = this._minis.get(key);
    if (hit !== undefined) return hit;
    let mini: MiniLayout | null = null;
    try {
      mini = fonts.layout(
        [
          {
            text: g.text,
            family: g.family,
            size: g.size,
            weight: g.weight,
            style: g.style,
            color: g.color,
          },
        ],
        { family: g.family, size: g.size },
      );
    } catch {
      mini = null;
    }
    if (this._minis.size > 1024) this._minis.clear();
    this._minis.set(key, mini);
    return mini;
  }

  private _fillPath(ctx: PathContext, p: FormulaPath): void {
    // The transform, per katex.css: `slice` is "scale by height, clip the
    // 400em tail at the box edge" — clamping x in path space renders the
    // same shape as the clip because the tails are horizontal fills.
    let sx: number;
    let sy: number;
    let clampX = Infinity;
    if (p.mode === 'none') {
      sx = p.width / p.viewWidth;
      sy = p.height / p.viewHeight;
    } else {
      sy = p.height / p.viewHeight;
      sx = sy;
      if (p.mode === 'slice') clampX = p.width / (sx || 1);
      else sx = sy = Math.min(sy, p.width / p.viewWidth || sy);
    }
    const ox = this.abs.x + p.x;
    const oy = this.abs.y + p.y;
    const X = (x: number): number => ox + Math.min(x, clampX) * sx;
    const Y = (y: number): number => oy + y * sy;
    ctx.beginPath();
    for (const s of p.segs) {
      switch (s.c) {
        case 'M':
          ctx.moveTo(X(s.x), Y(s.y));
          break;
        case 'L':
          ctx.lineTo(X(s.x), Y(s.y));
          break;
        case 'C':
          ctx.bezierCurveTo(X(s.x1), Y(s.y1), X(s.x2), Y(s.y2), X(s.x), Y(s.y));
          break;
        case 'Q':
          ctx.quadraticCurveTo(X(s.x1), Y(s.y1), X(s.x), Y(s.y));
          break;
        case 'Z':
          ctx.closePath();
          break;
      }
    }
    ctx.fillStyle = p.color;
    ctx.fill();
  }

  override paint(ctx: Context2D): void {
    super.paint(ctx); // background, border, clip to `abs`
    const layout = this._ensureLayout();
    if (!layout || !canFill(ctx)) return;
    const { x, y } = this.abs;

    ctx.save();

    // 1. the band the document selection has claimed of this formula
    const range = this.selectionRange;
    if (range && range.end > range.start) {
      ctx.fillStyle = this.selectionColor;
      for (const r of this.textRangeRects(range.start, range.end)) {
        ctx.fillRect(
          Math.round(r.x),
          Math.round(r.y),
          Math.ceil(r.width),
          Math.ceil(r.height),
        );
      }
    }

    // 2. rules — fraction bars, \rule, overlines
    for (const r of layout.rules) {
      if (r.color === 'transparent') continue;
      ctx.fillStyle = r.color;
      ctx.fillRect(
        Math.round(x + r.x),
        Math.round(y + r.y),
        Math.max(1, Math.round(r.width)),
        Math.max(1, Math.round(r.height)),
      );
    }

    // 3. svg geometry — surds, stretchy accents (needs a path API, which
    //    the mock backend does not have; skipping is the convention)
    if (canPath(ctx)) {
      for (const p of layout.paths) {
        if (p.color === 'transparent' || !p.segs.length) continue;
        if (p.width <= 0 || p.height <= 0) continue;
        this._fillPath(ctx, p);
      }
    }

    // 4. the ink
    for (const g of layout.glyphs) {
      if (g.color === 'transparent') continue;
      const mini = this._mini(g);
      if (!mini || !mini.lines.length) continue;
      mini.draw(ctx, x + g.x, y + g.baseline - mini.lines[0].baseline);
    }

    ctx.restore();
  }
}
