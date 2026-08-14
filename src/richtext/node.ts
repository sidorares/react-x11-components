// The retained node behind `<richtext>` — one wrapped, styled run of inline
// text: a paragraph, a heading, a list item's line, a table cell, a code
// block. `<Markdown>` and `<Code>` compose documents out of these plus plain
// `<box>`es.
//
// This directory is a shared module, not a component: registration is a
// function (`registerRichText()`), called at module scope by each component
// whose index.ts uses the element, so the "a component registers its element
// in its own index.ts" tree-shaking rule keeps holding — an app that imports
// neither `<Markdown>` nor `<Code>` never registers or ships any of this.
//
// **Why the element still exists, now that core selects text.** react-x11#291
// gave every node the four text accessors and made `selectable` a core
// service, which is what this directory used to implement itself (a whole
// `TextSelection` controller and a gestures hook, both deleted with it). What
// core's `<text>` still does not do is paint *per-run decoration*: the
// inline-code chip's background, a link's underline, `~~del~~`'s rule — and
// it composes mixed styles by nesting spans rather than laying out one array
// of styled runs, which is the shape a markdown inline sequence and a
// tokenized line of code both already have. So the element is a painter that
// answers for its own text, which is exactly the seam docs/extending.md
// describes: implement the four accessors and a document selects across you,
// with no registration call.
import { registerElement, registeredElements } from 'react-x11/host';
import { Node } from 'react-x11/node';
import type {
  Context2D,
  MeasureConstraints,
  MeasuredSize,
} from 'react-x11/node';
import type { Rect } from 'react-x11';
import type { Style } from 'react-x11/style';

import { codePointAtOffset, codeUnitOffsets } from './internal.js';

/** The element name — registration key, `node.kind` and JSX tag alike. */
export const ELEMENT = 'richtext';

/**
 * Register `<richtext>`. Called at module scope by every component index
 * that renders the element — never at this module's own scope, so the
 * shared module stays side-effect free. Idempotent on purpose:
 * `registerElement` throws on a second registration without `override`,
 * which is the right default for two *packages* fighting over a name — but a
 * lockfile skew that puts two copies of this package in one app should not
 * fail to boot over it.
 */
export function registerRichText(): void {
  if (registeredElements().includes(ELEMENT)) return;
  registerElement(ELEMENT, {
    create: (props, app) => new RichTextNode(props, app),
    // neither is a style name today, but `wrap` reads like one — declaring
    // everything the element owns keeps the DEV assertion honest even if
    // core's style vocabulary grows underneath us
    semanticNames: ['runs', 'wrap'],
    childrenAllowed: false,
  });
}

/** The ntk connection a node is built against. Derived from `Node`'s own
 *  constructor rather than named, so it cannot drift from core's. */
export type NtkApp = ConstructorParameters<typeof Node>[2];

/**
 * One styled run. `text`/`family`/`size`/`weight`/`style`/`color` are
 * ntk-span vocabulary and pass straight through to `fonts.layout`; the
 * rest ride along unread by ntk and come back on the laid-out runs, which
 * is how the paint pass knows where code backgrounds, link underlines and
 * strikethroughs go (the same trick ntk's own MarkdownView used).
 */
export interface TextRun {
  text: string;
  family?: string;
  size?: number;
  weight?: number | 'normal' | 'bold';
  style?: 'normal' | 'italic';
  color?: string;
  /** Fill painted behind the run — the inline-code chip. */
  bg?: string;
  /**
   * How `bg` is painted. `'chip'` (the default) insets the fill to the run's
   * ink and pads it slightly, which is what an inline-code background wants.
   *
   * `'line'` fills the run's exact width and the line's full height instead,
   * so adjacent runs abut with no seam and no bleed — what a terminal's
   * background colours need, where a two-pixel overhang would paint over the
   * neighbouring cell and a fill that stops at the descender would leave a
   * gap between rows.
   */
  bgFill?: 'chip' | 'line';
  /** 1px rule under the baseline, in this colour — links. */
  underline?: string;
  /** The rule `underline` draws. Default `'single'`; the rest are SGR 4's
   *  sub-parameters, which a captured terminal session carries. Ignored
   *  without `underline`, which is what says the rule exists at all. */
  underlineStyle?: 'single' | 'double' | 'curly' | 'dotted' | 'dashed';
  /** 1px rule through the x-height, in this colour — `~~del~~`. */
  strike?: string;
  /** Link target. `null` is a link still streaming in (not clickable). */
  href?: string | null;
}

/** The props `<richtext>` takes. */
export interface RichTextProps {
  /** The styled runs. Give a stable array identity — the layout cache and
   *  the streaming path both key off it. */
  runs: TextRun[];
  /** False lays the text out at its natural width, unwrapped — code. */
  wrap?: boolean;
  style?: Style | Style[];
}

// --- the slices of ntk this node speaks to ---------------------------------
// Typed structurally rather than imported: react-x11 keeps ntk deliberately
// loose, so an element says what it needs and nothing more.

interface FontMetricsLike {
  ascent: number;
  descent: number;
}

interface LaidRunLike {
  x: number;
  width: number;
  /** Extent within the paragraph, in **code units** (ntk's run vocabulary). */
  start: number;
  end: number;
  span: TextRun;
  run: {
    font: { metrics(size: number): FontMetricsLike };
    size: number;
    direction?: 'ltr' | 'rtl';
  };
}

interface LineLike {
  x: number;
  y: number;
  height: number;
  baseline: number;
  width: number;
  ascent: number;
  descent: number;
  /** The line's extent, in code units, like its runs'. */
  start: number;
  end: number;
  runs: LaidRunLike[];
}

export interface TextLayoutLike {
  width: number;
  height: number;
  lines: LineLike[];
  draw(ctx: unknown, x?: number, y?: number): void;
  caretPosition(index: number): {
    x: number;
    y: number;
    height: number;
    line: number;
  };
  indexAt(x: number, y: number): number;
}

interface FontsLike {
  layout(
    content: TextRun[],
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

/** A selected empty line still shows as a sliver, so a selection spanning a
 *  blank line does not appear to skip it. Core's own width for the same. */
const EMPTY_LINE_BAND = 4;

/**
 * The bands a highlight over `[start, end)` fills, in layout coordinates.
 *
 * One per line — and more than one on a line that changes direction, because
 * a selection is contiguous in *logical* order while a line is laid out in
 * *visual* order: a range crossing from Latin into Arabic covers two disjoint
 * stretches of pixels, and a single rectangle drawn between the two caret
 * positions paints over text nobody selected. So this walks `line.runs` and
 * intersects each with the range rather than interpolating between carets.
 *
 * Core's `<text>` does the same thing with the same code (react-x11#291's
 * `rangeBands`), which is not on its exports map; when it is, delete this.
 */
function rangeBands(
  layout: TextLayoutLike,
  text: string,
  start: number,
  end: number,
): Rect[] {
  const lines = layout.lines;
  if (!lines?.length || end <= start) return [];
  const offsets = codeUnitOffsets(text);
  const last = offsets.length - 1;
  const from = offsets[Math.max(0, Math.min(start, last))];
  const to = offsets[Math.max(0, Math.min(end, last))];
  if (to <= from) return [];
  const bands: Rect[] = [];
  for (const line of lines) {
    if (line.end <= from || line.start >= to) continue;
    const spans: [number, number][] = [];
    for (const positioned of line.runs) {
      const a = Math.max(from, positioned.start);
      const b = Math.min(to, positioned.end);
      if (b <= a) continue;
      const rtl = positioned.run?.direction === 'rtl';
      const near = line.x + positioned.x;
      const far = near + positioned.width;
      // a boundary at the run's own logical edge is that edge — which side
      // of the pixels it is on is what the run's direction decides
      const edgeAt = (cu: number, logicalStart: boolean): number => {
        if (logicalStart ? cu <= positioned.start : cu >= positioned.end) {
          return rtl === logicalStart ? far : near;
        }
        return layout.caretPosition(codePointAtOffset(offsets, cu)).x;
      };
      const x1 = edgeAt(a, true);
      const x2 = edgeAt(b, false);
      spans.push([Math.min(x1, x2), Math.max(x1, x2)]);
    }
    if (!spans.length) {
      bands.push({
        x: line.x,
        y: line.y,
        width: EMPTY_LINE_BAND,
        height: line.height,
      });
      continue;
    }
    // Runs also split at every style span, so an ordinary line with a bold
    // word in it is three rectangles that touch. Merging keeps the common
    // case at one per line.
    spans.sort((p, q) => p[0] - q[0]);
    let [left, right] = spans[0];
    for (let i = 1; i <= spans.length; i += 1) {
      const next = spans[i];
      if (next && next[0] <= right + 0.5) {
        right = Math.max(right, next[1]);
        continue;
      }
      if (right > left) {
        bands.push({
          x: left,
          y: line.y,
          width: right - left,
          height: line.height,
        });
      }
      if (next) [left, right] = next;
    }
  }
  return bands;
}

/**
 * The rule under a run, in one of SGR 4's five styles.
 *
 * All five are built from 1px rectangles rather than a stroked path: the mock
 * backend has no path API (which is why every `paint` here checks `fillRect`
 * first), and a hairline stroke on a text baseline is not worth an antialiased
 * path even where there is one. The curl is a two-level square wave — at a
 * text size it reads as a squiggle, which is the entire job.
 */
function underlineRule(
  ctx: FillContext,
  x: number,
  y: number,
  width: number,
  style: NonNullable<TextRun['underlineStyle']>,
): void {
  switch (style) {
    case 'double':
      ctx.fillRect(x, y, width, 1);
      ctx.fillRect(x, y + 2, width, 1);
      return;
    case 'dotted':
      for (let i = 0; i < width; i += 2) ctx.fillRect(x + i, y, 1, 1);
      return;
    case 'dashed':
      for (let i = 0; i < width; i += 6) {
        ctx.fillRect(x + i, y, Math.min(3, width - i), 1);
      }
      return;
    case 'curly':
      for (let i = 0; i < width; i += 2) {
        ctx.fillRect(
          x + i,
          y + (i % 4 === 0 ? 0 : 1),
          Math.min(2, width - i),
          1,
        );
      }
      return;
    default:
      ctx.fillRect(x, y, width, 1);
      return;
  }
}

export class RichTextNode extends Node {
  private _layouts = new Map<string, TextLayoutLike | null>();
  private _text: string | null = null;

  constructor(props: Record<string, unknown>, app: NtkApp) {
    super(ELEMENT, props, app);
  }

  /**
   * The size the laid-out runs come to. An unbounded axis arrives as
   * `Infinity`, which is also what `wrap={false}` wants, so the wrap flag is
   * the only branch left — and an answer wider than the offer overflows
   * rather than being clamped, which is what makes a non-wrapping run
   * scrollable inside its parent. `null` is the mock backend, where there is
   * no font manager to measure through.
   */
  override measureContent({ width }: MeasureConstraints): MeasuredSize {
    const wrap = (this.props as unknown as RichTextProps).wrap !== false;
    const layout = this._layoutFor(wrap ? width : Infinity);
    if (!layout) return { width: 0, height: 0 };
    return {
      width: Math.ceil(layout.width),
      height: Math.ceil(layout.height),
    };
  }

  private _runs(): TextRun[] {
    const runs = (this.props as unknown as RichTextProps).runs;
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

  /**
   * The layout this node is currently painted with — and, because it is the
   * one thing every accessor below answers from, the reason a caret rect and
   * a glyph cannot disagree (docs/extending.md, "answer from what you draw").
   */
  private _paintLayout(): TextLayoutLike | null {
    const wrap = (this.props as unknown as RichTextProps).wrap !== false;
    return this._layoutFor(wrap ? this.abs.width : Infinity);
  }

  override applyProps(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): void {
    super.applyProps(nextProps, prevProps);
    if (
      nextProps.runs !== prevProps.runs ||
      nextProps.wrap !== prevProps.wrap
    ) {
      this._layouts.clear();
      this._text = null;
      this.invalidateMeasure('content');
    }
  }

  override destroySubtree(): void {
    this._layouts.clear();
    super.destroySubtree();
  }

  // --- answering for our own text ------------------------------------------
  //
  // The four accessors from react-x11#291. Implementing them is the whole of
  // joining a `selectable` document: core walks the subtree, asks, and pushes
  // back a `selectionRange` for `paint` to fill. Indices are **code points**
  // and rectangles are in the **owning window's** coordinates, which is the
  // space `abs` and a mouse event's `x`/`y` are already in.

  override textContent(): string {
    if (this._text === null) {
      this._text = this._runs()
        .map((r) => r.text)
        .join('');
    }
    return this._text;
  }

  override textIndexAt(x: number, y: number): number {
    const layout = this._paintLayout();
    if (!layout) return 0;
    const i = layout.indexAt(x - this.abs.x, y - this.abs.y);
    return Math.max(0, Math.min([...this.textContent()].length, i));
  }

  override textCaretRect(index: number): Rect | null {
    const layout = this._paintLayout();
    if (!layout) return null;
    const caret = layout.caretPosition(index);
    return {
      x: this.abs.x + caret.x,
      y: this.abs.y + caret.y,
      width: 0,
      height: caret.height,
    };
  }

  override textRangeRects(start: number, end: number): Rect[] {
    const layout = this._paintLayout();
    if (!layout) return [];
    return rangeBands(layout, this.textContent(), start, end).map((band) => ({
      x: this.abs.x + band.x,
      y: this.abs.y + band.y,
      width: band.width,
      height: band.height,
    }));
  }

  /** The run's link target under a point, if any — for click-to-follow.
   *  Not part of the selection seam: core deliberately left hover and
   *  `cursorAt` out of #291, so following a link stays this package's. */
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

    // 1. run decorations that sit under everything: the code chip, and the
    //    terminal's cell backgrounds
    for (const line of layout.lines) {
      for (const r of line.runs) {
        const bg = r.span.bg;
        if (!bg) continue;
        ctx.fillStyle = bg;
        if (r.span.bgFill === 'line') {
          // Both edges are rounded from absolute positions rather than the
          // left being rounded and the width ceiled, so two adjacent runs
          // agree on the pixel between them: no seam, and no overlap either.
          const left = Math.round(x + line.x + r.x);
          const right = Math.round(x + line.x + r.x + r.width);
          ctx.fillRect(
            left,
            Math.round(y + line.y),
            Math.max(0, right - left),
            Math.ceil(line.height),
          );
          continue;
        }
        const m = r.run.font.metrics(r.run.size);
        ctx.fillRect(
          Math.round(x + line.x + r.x - 2),
          Math.round(y + line.baseline - m.ascent),
          Math.ceil(r.width + 4),
          Math.ceil(m.ascent + m.descent),
        );
      }
    }

    // 2. the band the document selection has claimed of this element's text,
    //    translucent so the ink keeps its contrast on either palette (the
    //    same reasoning as `<textarea>`'s). The range and the colour both
    //    arrive from the surface above; `textRangeRects` is what a custom
    //    element and core's own `<text>` both fill, so they cannot drift.
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

    // 3. the ink
    layout.draw(ctx, x, y);

    // 4. rules over the ink: link underlines, strikethrough
    for (const line of layout.lines) {
      for (const r of line.runs) {
        const { underline, strike } = r.span;
        if (underline) {
          ctx.fillStyle = underline;
          underlineRule(
            ctx,
            Math.round(x + line.x + r.x),
            Math.round(y + line.baseline + 2),
            Math.ceil(r.width),
            r.span.underlineStyle ?? 'single',
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
