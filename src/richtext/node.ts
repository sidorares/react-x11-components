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

import {
  canFill,
  lineBands,
  paintRunBackgrounds,
  paintRunRules,
} from './runs.js';
import type { FillContext } from './runs.js';
import { codeUnitOffsets } from '../internal/text.js';

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
  /** Pixels added after every glyph — CSS's `letter-spacing`. Both text
   *  engines take it on a span, and it passes through to them as the rest
   *  of the ntk vocabulary does. */
  letterSpacing?: number;
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
  /** How far below the baseline the underline's top is, and how thick it
   *  is, in the unit `size` is in — CSS's `text-underline-offset` and
   *  `text-decoration-thickness`. Unset, two pixels below and one thick. */
  underlineOffset?: number;
  underlineThickness?: number;
  /** 1px rule through the x-height, in this colour — `~~del~~`. */
  strike?: string;
  /** Link target. `null` is a link still streaming in (not clickable). */
  href?: string | null;
  /** OpenType features the run is shaped with, by tag — `{ tnum: 1 }`,
   *  `{ liga: 0 }` — which both text engines take on a span. A run's fields
   *  are compared by identity (`sameRuns`), so the same features should be
   *  the same object. */
  features?: Readonly<Record<string, number>>;
  /** Runs that share a truthy `nowrap` have no break inside them or between
   *  them — the text of one element with `white-space: nowrap`, the element
   *  being the value. ntk's, from 8.13.0; CoreText breaks as it would. */
  nowrap?: unknown;
  /** Shaped on its own: ntk shapes a word that runs across spans shaped
   *  alike as one, kerned and joined across them, and a run marked so is
   *  kept apart from the ones either side of it — as CSS keeps the text
   *  either side of an inline box's margin, border or padding. ntk's, from
   *  8.14.2. */
  shapeApart?: boolean;
}

/** The props `<richtext>` takes. */
export interface RichTextProps {
  /** The styled runs. Give a stable array identity where you can — the
   *  streaming path keys off it; an equal new array keeps its layout, for
   *  one pass over the runs (`sameRuns`). */
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
  /** Optional for the same reason as `runs.ts`'s `LaidRun`: react-x11's
   *  Cocoa engine hands back a run's geometry and nothing else. */
  span?: TextRun;
  run?: {
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

/** Spacing that tells runs apart and moves nothing: an engine that merges
 *  adjacent runs alike (CoreText) keeps a tab's space to itself. */
const HAIR = 1e-6;

/**
 * The runs with each tab laid out as a space of its own, letter-spaced to
 * the next stop: every eight spaces from its line's start, and past one
 * less than half a "0" on (CSS Text 3, 4.2's `tab-size`). Neither engine
 * sets a tab so — ntk has no glyph for one and draws a box, and CoreText
 * stops every 28 points — so a tab-indented fence in `<Markdown>` or a
 * `<Code>` block came out boxed or ragged. The space is the tab's length,
 * so every offset holds, and the text a selection copies keeps its tabs.
 * Placed from a first layout that has each tab as an unspaced space; a
 * later tab on a line moves by what the ones before it added.
 */
function tabbedRuns(
  fonts: FontsLike,
  runs: TextRun[],
  base: Record<string, unknown>,
): TextRun[] {
  const out: TextRun[] = [];
  const tabs: { at: number; index: number }[] = [];
  let units = 0;
  for (const run of runs) {
    const text = run.text;
    if (!text.includes('\t')) {
      out.push(run);
      units += text.length;
      continue;
    }
    let done = 0;
    for (let p = text.indexOf('\t'); p >= 0; p = text.indexOf('\t', p + 1)) {
      if (p > done) out.push({ ...run, text: text.slice(done, p) });
      tabs.push({ at: units + p, index: out.length });
      out.push({
        ...run,
        text: ' ',
        letterSpacing: (run.letterSpacing ?? 0) + tabs.length * HAIR,
      });
      done = p + 1;
    }
    if (done < text.length) out.push({ ...run, text: text.slice(done) });
    units += text.length;
  }
  const natural = fonts.layout(out, base, {});
  const found = new Map<number, { x: number; line: number }>();
  natural.lines.forEach((line, i) => {
    for (const run of line.runs ?? []) {
      found.set(run.start, { x: line.x + run.x, line: i });
    }
  });
  /** The room tabs have added to each line so far. */
  const added = new Map<number, number>();
  for (const tab of tabs) {
    const run = out[tab.index];
    const face = {
      ...base,
      ...(run.family !== undefined ? { family: run.family } : null),
      ...(run.size !== undefined ? { size: run.size } : null),
      ...(run.weight !== undefined ? { weight: run.weight } : null),
      ...(run.style !== undefined ? { style: run.style } : null),
    };
    const space = advanceOf(fonts, face, ' ');
    const every = 8 * space;
    const own = space + (run.letterSpacing ?? 0);
    const at = found.get(tab.at) ?? natural.caretPosition(tab.at);
    const before = added.get(at.line) ?? 0;
    const x = at.x + before;
    let advance = own;
    if (every > 0) {
      let stop = (Math.floor(x / every) + 1) * every;
      if (stop - x < advanceOf(fonts, face, '0') / 2) stop += every;
      advance = stop - x;
    }
    out[tab.index] = {
      ...run,
      letterSpacing: (run.letterSpacing ?? 0) + advance - own,
    };
    added.set(at.line, before + advance - own);
  }
  return out;
}

/** A character's advance in a face: between two letters, so that no engine
 *  drops it as a line's end. Kept per engine and face: a file indented with
 *  tabs asks for it thousands of times. */
function advanceOf(
  fonts: FontsLike,
  face: Record<string, unknown>,
  char: string,
): number {
  let kept = ADVANCES.get(fonts);
  if (!kept) ADVANCES.set(fonts, (kept = new Map()));
  const key = `${face.family}|${face.size}|${face.weight}|${face.style}|${char}`;
  let advance = kept.get(key);
  if (advance === undefined) {
    advance =
      fonts.layout([{ ...face, text: `x${char}x` } as TextRun], face, {})
        .width -
      fonts.layout([{ ...face, text: 'xx' } as TextRun], face, {}).width;
    kept.set(key, advance);
  }
  return advance;
}

const ADVANCES = new WeakMap<FontsLike, Map<string, number>>();

/**
 * The bands a highlight over `[start, end)` fills, in layout coordinates —
 * one per line, and more than one on a line that changes direction. The
 * per-line work is `runs.ts`'s, which is also what `<Html>` calls with its
 * own line placement.
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
    for (const band of lineBands(layout, line, offsets, from, to)) {
      bands.push({
        x: band.x,
        y: line.y,
        width: band.width,
        height: line.height,
      });
    }
  }
  return bands;
}

/**
 * Whether two `runs` props say the same thing. A component that builds its
 * runs in render hands over a new array whenever it renders, whether or not
 * the text changed — the rich text editor does on every keystroke, for
 * paragraphs the keystroke never reached — and the array's identity was
 * all a layout cache cleared on. A run's fields are all primitives, so one
 * shallow pass decides it, where the layout it spares is a paragraph shaped
 * and broken again.
 */
function sameRuns(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as Record<string, unknown>;
    const y = b[i] as Record<string, unknown>;
    if (x === y) continue;
    if (!x || !y) return false;
    const keys = Object.keys(x);
    if (keys.length !== Object.keys(y).length) return false;
    for (const key of keys) if (x[key] !== y[key]) return false;
  }
  return true;
}

export class RichTextNode extends Node {
  private _layouts = new Map<string, TextLayoutLike | null>();
  private _text: string | null = null;
  /** The runs as laid out where a tab is among them, and what from. */
  private _tabbed: { from: TextRun[]; scale: number; to: TextRun[] } | null =
    null;

  /**
   * `kind` is for a subclass registered under a name of its own — the rich
   * text editor's text blocks are `<richtext>` plus a caret and a selection
   * the editor owns (`src/rich-text-editor/nodes.ts`). A node's `kind` must be
   * the name it was registered under, so the subclass passes its own.
   */
  constructor(
    props: Record<string, unknown>,
    app: NtkApp,
    kind: string = ELEMENT,
  ) {
    super(kind, props, app);
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
      const s = this._scale;
      const base = { family: 'sans-serif', size: 14 * s };
      layout = fonts.layout(this._tabRuns(fonts, base, s), base, {
        maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
        lineHeight: this.style.lineHeight,
        align: this.style.textAlign,
      });
    }
    if (this._layouts.size > 32) this._layouts.clear();
    this._layouts.set(key, layout);
    return layout;
  }

  /** The runs with their tabs set to their stops (`tabbedRuns`), found
   *  once for a list of runs: most have none, and are handed on as they
   *  are. */
  private _tabRuns(
    fonts: FontsLike,
    base: Record<string, unknown>,
    scale: number,
  ): TextRun[] {
    const from = this._runs();
    const runs = this._deviceRuns(scale);
    if (!runs.some((run) => run.text.includes('\t'))) return runs;
    const kept = this._tabbed;
    if (kept && kept.from === from && kept.scale === scale) return kept.to;
    const to = tabbedRuns(fonts, runs, base);
    this._tabbed = { from, scale, to };
    return to;
  }

  // --- units ---------------------------------------------------------------
  //
  // The layout, `abs` and the paint are device pixels (react-x11's
  // docs/scale.md). A `TextRun.size` is a length the application wrote, so
  // like every style length it is logical, and unlike a style length nothing
  // in core multiplies it on the way in — `_deviceRuns` does, so the runs are
  // shaped at `size * scale` and a 14 on a 2x panel is the size a
  // `fontSize: 14` is, sharper rather than smaller. A synthetic event's
  // `x`/`y` are logical too, which is what `hrefAtPoint` is handed; the four
  // selection accessors are core's device-pixel contract and stay device.

  /** Device pixels per logical pixel — the display scale this element's
   *  window resolved to, constant for the node's life. */
  private get _scale(): number {
    return this.scale > 0 ? this.scale : 1;
  }

  /** The runs with their sizes on the device grid. The array identity is
   *  what the layout cache keys on, so at 1x the props' own array is
   *  returned untouched. */
  private _deviceRuns(scale: number): TextRun[] {
    const runs = this._runs();
    if (scale === 1) return runs;
    return runs.map((r) =>
      typeof r.size === 'number' ||
      r.underlineOffset !== undefined ||
      r.underlineThickness !== undefined
        ? {
            ...r,
            ...(typeof r.size === 'number' ? { size: r.size * scale } : null),
            ...(r.underlineOffset !== undefined
              ? { underlineOffset: r.underlineOffset * scale }
              : null),
            ...(r.underlineThickness !== undefined
              ? { underlineThickness: r.underlineThickness * scale }
              : null),
          }
        : r,
    );
  }

  /**
   * The layout this node is currently painted with — and, because it is the
   * one thing every accessor below answers from, the reason a caret rect and
   * a glyph cannot disagree (docs/extending.md, "answer from what you draw").
   * Protected rather than private for the editor's subclass, whose line-wise
   * caret motion reads the lines off the same layout the glyphs came from.
   */
  protected paintLayout(): TextLayoutLike | null {
    const wrap = (this.props as unknown as RichTextProps).wrap !== false;
    return this._layoutFor(wrap ? this.abs.width : Infinity);
  }

  override applyProps(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): void {
    super.applyProps(nextProps, prevProps);
    if (
      nextProps.wrap !== prevProps.wrap ||
      !sameRuns(nextProps.runs, prevProps.runs)
    ) {
      this._layouts.clear();
      this._text = null;
      this._tabbed = null;
      this.invalidateMeasure('content');
    }
  }

  /** A new `runs` array that says what the last one said changes nothing
   *  drawn — see `sameRuns`. */
  override paintChanged(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): boolean {
    if (
      nextProps.runs !== prevProps.runs &&
      sameRuns(nextProps.runs, prevProps.runs)
    ) {
      return super.paintChanged(
        { ...nextProps, runs: prevProps.runs },
        prevProps,
      );
    }
    return super.paintChanged(nextProps, prevProps);
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
  // and rectangles are in the **owning window's** coordinates in **device**
  // pixels — the space `abs` is in, and the one core asks in (it reads the
  // point back off the native event; a synthetic `x`/`y` is logical).

  override textContent(): string {
    if (this._text === null) {
      this._text = this._runs()
        .map((r) => r.text)
        .join('');
    }
    return this._text;
  }

  override textIndexAt(x: number, y: number): number {
    const layout = this.paintLayout();
    if (!layout) return 0;
    const i = layout.indexAt(x - this.abs.x, y - this.abs.y);
    return Math.max(0, Math.min([...this.textContent()].length, i));
  }

  override textCaretRect(index: number): Rect | null {
    const layout = this.paintLayout();
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
    const layout = this.paintLayout();
    if (!layout) return [];
    return rangeBands(layout, this.textContent(), start, end).map((band) => ({
      x: this.abs.x + band.x,
      y: this.abs.y + band.y,
      width: band.width,
      height: band.height,
    }));
  }

  /** The run's link target under a **logical** window point — the one a
   *  mouse event carries — if any, for click-to-follow. Not part of the
   *  selection seam: core deliberately left hover and `cursorAt` out of
   *  #291, so following a link stays this package's. */
  hrefAtPoint(x: number, y: number): string | null {
    const layout = this.paintLayout();
    if (!layout) return null;
    const s = this._scale;
    const lx = x * s - this.abs.x;
    const ly = y * s - this.abs.y;
    for (const line of layout.lines) {
      if (ly < line.y || ly >= line.y + line.height) continue;
      for (const r of line.runs) {
        const href = r.span?.href;
        if (href == null) continue;
        if (lx >= line.x + r.x && lx <= line.x + r.x + r.width) return href;
      }
    }
    return null;
  }

  // --- paint ---------------------------------------------------------------

  override paint(ctx: Context2D): void {
    super.paint(ctx); // background, border, clip to `abs`
    const layout = this.paintLayout();
    if (!layout || !canFill(ctx)) return;
    const { x, y } = this.abs;
    const s = this._scale;

    ctx.save();

    // 1. run decorations that sit under everything: the code chip, and the
    //    terminal's cell backgrounds
    for (const line of layout.lines) paintRunBackgrounds(ctx, line, x, y, s);

    // 2. the band a selection has claimed of this element's text
    this.paintSelection(ctx);

    // 3. the ink
    layout.draw(ctx, x, y);

    // 4. rules over the ink: link underlines, strikethrough
    for (const line of layout.lines) paintRunRules(ctx, line, x, y, s);

    // 5. anything that belongs over everything — a subclass's caret
    this.paintOverlay(ctx);

    ctx.restore();
  }

  /**
   * The selection band, between the run backgrounds and the ink. The default
   * is core's document selection: the band the `selectable` surface above
   * has claimed of this element's text, translucent so the ink keeps its
   * contrast on either palette (the same reasoning as `<textarea>`'s). The
   * range and the colour both arrive from that surface; `textRangeRects` is
   * what a custom element and core's own `<text>` both fill, so they cannot
   * drift. An element with a selection of its own — the editor's text
   * blocks — overrides this and fills that one instead.
   */
  protected paintSelection(ctx: FillContext): void {
    const range = this.selectionRange;
    // The colour is the condition, not just the range: core types it
    // `string | null` and defines it as what to fill the rectangles with
    // *while a selection is set*, so a null one is "nothing to draw"
    // rather than a band in the default ink.
    const selectionColor = this.selectionColor;
    if (!selectionColor || !range || range.end <= range.start) return;
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

  /** Drawn last, over the ink and the rules: nothing here, a caret in the
   *  editor's subclass. Inside the same save/restore as the rest. */
  protected paintOverlay(_ctx: FillContext): void {}
}
