// The retained node behind `<mdtext>` — one wrapped, styled, *selectable*
// run of inline text: a paragraph, a heading, a list item's line, a table
// cell, a code block. `<Markdown>` composes documents out of these plus
// plain `<box>`es; this node is deliberately unaware of markdown itself —
// it renders the `runs` it is given and answers geometry questions about
// them, which is the whole selection story (see selection.ts for the part
// that spans blocks).
//
// Why not core's `<text>`: nested `<text>` spans already wrap mixed styles,
// but the node keeps its TextLayout private, so there is no way to ask
// "which character is under this point" or "where is the caret for index
// 12" from outside — and no way to paint a highlight band behind the right
// glyphs. Selection needs exactly those, so this element owns its layout.
// (That is a gap worth closing in core one day: a text element that
// exposes hit-testing would let this file shrink to the selection parts.)
import { Node } from 'react-x11/node';
import type { Context2D } from 'react-x11/node';
import { Yoga } from 'react-x11/ntk';
import type { Style } from 'react-x11/style';

import { tint } from './internal.js';
import type { SelectionRegistry } from './selection.js';

/** The element name — registration key, `node.kind` and JSX tag alike. */
export const ELEMENT = 'mdtext';

/** The ntk connection a node is built against (same derivation, and the
 *  same reason, as `sparkline/node.ts`). */
export type NtkApp = ConstructorParameters<typeof Node>[2];

/**
 * One styled run. `text`/`family`/`size`/`weight`/`style`/`color` are
 * ntk-span vocabulary and pass straight through to `fonts.layout`; the
 * rest ride along unread by ntk and come back on the laid-out runs, which
 * is how the paint pass knows where code backgrounds, link underlines and
 * strikethroughs go (the same trick ntk's own MarkdownView used).
 */
export interface MdRun {
  text: string;
  family?: string;
  size?: number;
  weight?: number | 'normal' | 'bold';
  style?: 'normal' | 'italic';
  color?: string;
  /** Fill painted behind the run — the inline-code chip. */
  bg?: string;
  /** 1px rule under the baseline, in this colour — links. */
  underline?: string;
  /** 1px rule through the x-height, in this colour — `~~del~~`. */
  strike?: string;
  /** Link target. `null` is a link still streaming in (not clickable). */
  href?: string | null;
}

// What a selection host gives `<Markdown>`'s blocks. Defined in
// `selection.ts` over a structural `SelectableBlock` — never over this
// class, whose private fields would make the public `.d.ts` nominal and
// break the JSX augmentation's src/dist identity. The prop exists so the
// node and the controller find each other without React context (a
// retained node cannot read context).
export type { SelectableBlock, SelectionRegistry } from './selection.js';

/** The props `<mdtext>` takes. */
export interface MdTextProps {
  /** The styled runs. Give a stable array identity — the layout cache and
   *  the streaming path both key off it. */
  runs: MdRun[];
  /** False lays the text out at its natural width, unwrapped — code. */
  wrap?: boolean;
  /** Document position for cross-block selection ordering. */
  order?: number;
  /** Selection host; absent means this block is not selectable. */
  registry?: SelectionRegistry | null;
  /** Copy-time separator between this block and the previous one. */
  joiner?: string;
  /** Highlight fill; defaults to the theme accent at 35%. */
  selectionColor?: string;
  style?: Style | Style[];
}

// --- the slices of ntk this node speaks to ---------------------------------
// Typed structurally, the way `sparkline/node.ts` types its path context:
// react-x11 keeps ntk deliberately loose, so an element says what it needs.

interface FontMetricsLike {
  ascent: number;
  descent: number;
}

interface LaidRunLike {
  x: number;
  width: number;
  start: number;
  end: number;
  span: MdRun;
  run: { font: { metrics(size: number): FontMetricsLike }; size: number };
}

interface LineLike {
  x: number;
  y: number;
  height: number;
  baseline: number;
  width: number;
  ascent: number;
  descent: number;
  runs: LaidRunLike[];
}

export interface TextLayoutLike {
  width: number;
  height: number;
  lines: LineLike[];
  draw(ctx: unknown, x?: number, y?: number): void;
  caretPosition(index: number): { x: number; y: number; height: number; line: number };
  indexAt(x: number, y: number): number;
}

interface FontsLike {
  layout(
    content: MdRun[],
    style: Record<string, unknown>,
    options: { maxWidth?: number; lineHeight?: number; align?: string },
  ): TextLayoutLike;
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

const MEASURE_MODE_UNDEFINED = (Yoga as { MEASURE_MODE_UNDEFINED?: number })
  .MEASURE_MODE_UNDEFINED;

/** The layout-owning face of the runtime node that `node.d.ts` does not
 *  describe. Core's own `<text>` and `<markdown>` measure through exactly
 *  this seam; docs/extending.md just has no public word for it yet — the
 *  cast is local and commented, per this repo's rule for the places where
 *  react-x11's declarations are narrower than its runtime. */
interface MeasurableInternals {
  yoga?: {
    setMeasureFunc(
      fn: (
        width: number,
        widthMode: number,
        height: number,
        heightMode: number,
      ) => { width: number; height: number },
    ): void;
    markDirty(): void;
  };
}

export class MdTextNode extends Node {
  private _layouts = new Map<string, TextLayoutLike | null>();
  private _plain: string[] | null = null;
  private _selA = 0;
  private _selB = 0;

  constructor(props: Record<string, unknown>, app: NtkApp) {
    super(ELEMENT, props, app);
    const internals = this as unknown as MeasurableInternals;
    internals.yoga?.setMeasureFunc((width, widthMode) => {
      const wrap = (this.props as unknown as MdTextProps).wrap !== false;
      const maxWidth =
        !wrap || widthMode === MEASURE_MODE_UNDEFINED ? Infinity : width;
      const layout = this._layoutFor(maxWidth);
      if (!layout) return { width: 0, height: 0 };
      return {
        width: Math.ceil(layout.width),
        height: Math.ceil(layout.height),
      };
    });
    this._registry()?.register(this);
  }

  private _registry(): SelectionRegistry | null {
    return (this.props as unknown as MdTextProps).registry ?? null;
  }

  private _runs(): MdRun[] {
    const runs = (this.props as unknown as MdTextProps).runs;
    return Array.isArray(runs) ? runs : [];
  }

  /**
   * Lay the runs out at a width, memoized. The mock backend's app has no
   * font manager; every caller treats `null` as "skip the geometry", the
   * same convention core's rich nodes use.
   */
  private _layoutFor(maxWidth: number): TextLayoutLike | null {
    const key = String(maxWidth);
    const hit = this._layouts.get(key);
    if (hit !== undefined) return hit;
    const fonts = (this.app as { fonts?: FontsLike } | null)?.fonts;
    let layout: TextLayoutLike | null = null;
    if (fonts) {
      layout = fonts.layout(
        this._runs(),
        { family: 'sans-serif', size: 14 },
        {
          maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
          lineHeight: this.style.lineHeight,
          align: this.style.textAlign,
        },
      );
    }
    if (this._layouts.size > 32) this._layouts.clear();
    this._layouts.set(key, layout);
    return layout;
  }

  /** The layout this node is currently painted with. */
  private _paintLayout(): TextLayoutLike | null {
    const wrap = (this.props as unknown as MdTextProps).wrap !== false;
    return this._layoutFor(wrap ? this.abs.width : Infinity);
  }

  override applyProps(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): void {
    const prevRegistry = prevProps.registry as SelectionRegistry | undefined;
    super.applyProps(nextProps, prevProps);
    if (
      nextProps.runs !== prevProps.runs ||
      nextProps.wrap !== prevProps.wrap
    ) {
      this._layouts.clear();
      this._plain = null;
      this._clampSelection();
      const internals = this as unknown as MeasurableInternals;
      internals.yoga?.markDirty();
      this.root?.invalidate(true, null, 'content');
    }
    const registry = this._registry();
    if (registry !== (prevRegistry ?? null)) {
      prevRegistry?.unregister(this);
      registry?.register(this);
    }
  }

  override destroySubtree(): void {
    this._registry()?.unregister(this);
    this._layouts.clear();
    super.destroySubtree();
  }

  // --- what the selection controller talks to ------------------------------

  /** Document order, as assigned by the renderer. */
  get order(): number {
    return Number((this.props as unknown as MdTextProps).order ?? 0);
  }

  /** Copy-time separator between this block and the one before it. */
  get joiner(): string {
    return (this.props as unknown as MdTextProps).joiner ?? '\n\n';
  }

  /** The text as code points — the unit every index in this API uses,
   *  matching ntk's `caretPosition`/`indexAt`. */
  private _chars(): string[] {
    if (!this._plain) {
      this._plain = Array.from(this._runs().map((r) => r.text).join(''));
    }
    return this._plain;
  }

  get length(): number {
    return this._chars().length;
  }

  text(from = 0, to = this.length): string {
    return this._chars().slice(from, to).join('');
  }

  /** Code-point index under a window-coordinate point, clamped. */
  indexAtPoint(x: number, y: number): number {
    const layout = this._paintLayout();
    if (!layout) return 0;
    const i = layout.indexAt(x - this.abs.x, y - this.abs.y);
    return Math.max(0, Math.min(this.length, i));
  }

  /** The word around an index — double-click's unit. */
  wordRangeAt(index: number): [number, number] {
    const chars = this._chars();
    const n = chars.length;
    if (n === 0) return [0, 0];
    const i = Math.max(0, Math.min(n - 1, index));
    const isWord = (ch: string): boolean => /[\p{L}\p{N}_]/u.test(ch);
    const target = isWord(chars[i]);
    let a = i;
    let b = i + 1;
    while (a > 0 && isWord(chars[a - 1]) === target && target) a -= 1;
    while (b < n && isWord(chars[b]) === target && target) b += 1;
    if (!target) return [i, i + 1];
    return [a, b];
  }

  /** Set the highlighted range, [a, b) in code points. Equal ends clear. */
  setSelection(a: number, b: number): void {
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(this.length, Math.max(a, b));
    const [na, nb] = hi > lo ? [lo, hi] : [0, 0];
    if (na === this._selA && nb === this._selB) return;
    this._selA = na;
    this._selB = nb;
    this.root?.invalidate(false, this.abs, 'text');
  }

  get selection(): [number, number] {
    return [this._selA, this._selB];
  }

  private _clampSelection(): void {
    const n = this.length;
    if (this._selB > n) this._selB = n;
    if (this._selA > this._selB) this._selA = this._selB;
  }

  /** The run's link target under a point, if any — for click-to-follow. */
  hrefAtPoint(x: number, y: number): string | null {
    const layout = this._paintLayout();
    if (!layout) return null;
    const lx = x - this.abs.x;
    const ly = y - this.abs.y;
    for (const line of layout.lines) {
      if (ly < line.y || ly >= line.y + line.height) continue;
      for (const r of line.runs) {
        const href = r.span.href;
        if (href == null) continue;
        if (lx >= line.x + r.x && lx <= line.x + r.x + r.width) return href;
      }
    }
    return null;
  }

  // --- paint ---------------------------------------------------------------

  override paint(ctx: Context2D): void {
    super.paint(ctx); // background, border, clip to `abs`
    const layout = this._paintLayout();
    if (!layout || !canFill(ctx)) return;
    const { x, y } = this.abs;

    ctx.save();

    // 1. run decorations that sit under everything: the code chip
    for (const line of layout.lines) {
      for (const r of line.runs) {
        const bg = r.span.bg;
        if (!bg) continue;
        const m = r.run.font.metrics(r.run.size);
        ctx.fillStyle = bg;
        ctx.fillRect(
          Math.round(x + line.x + r.x - 2),
          Math.round(y + line.baseline - m.ascent),
          Math.ceil(r.width + 4),
          Math.ceil(m.ascent + m.descent),
        );
      }
    }

    // 2. the selection band — translucent, so the ink keeps its contrast
    //    on either palette (the same reasoning as `<textarea>`'s band)
    if (this._selB > this._selA) {
      const posA = layout.caretPosition(this._selA);
      const posB = layout.caretPosition(this._selB);
      const color =
        (this.props as unknown as MdTextProps).selectionColor ??
        tint(String(this.theme?.accent ?? '#2980b9'), 0.35);
      ctx.fillStyle = color;
      for (let li = posA.line; li <= posB.line; li += 1) {
        const line = layout.lines[li];
        if (!line) continue;
        const x0 = li === posA.line ? posA.x : line.x;
        const x1 = li === posB.line ? posB.x : line.x + line.width;
        // a selected empty stretch still shows as a sliver, so a selection
        // spanning a blank line does not appear to skip it
        const w = Math.max(x1 - x0, 3);
        ctx.fillRect(
          Math.round(x + x0),
          Math.round(y + line.y),
          Math.ceil(w),
          Math.ceil(line.height),
        );
      }
    }

    // 3. the ink
    layout.draw(ctx, x, y);

    // 4. rules over the ink: link underlines, strikethrough
    for (const line of layout.lines) {
      for (const r of line.runs) {
        const { underline, strike } = r.span;
        if (underline) {
          ctx.fillStyle = underline;
          ctx.fillRect(
            Math.round(x + line.x + r.x),
            Math.round(y + line.baseline + 2),
            Math.ceil(r.width),
            1,
          );
        }
        if (strike) {
          const m = r.run.font.metrics(r.run.size);
          ctx.fillStyle = strike;
          ctx.fillRect(
            Math.round(x + line.x + r.x),
            Math.round(y + line.baseline - m.ascent * 0.38),
            Math.ceil(r.width),
            1,
          );
        }
      }
    }

    ctx.restore();
  }
}
