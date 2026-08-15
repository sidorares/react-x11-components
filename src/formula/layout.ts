// KaTeX's virtual DOM, laid out in pixels.
//
// A browser renders KaTeX's tree with a small, deliberate subset of CSS:
// inline flow with em margins, the vlist's absolutely-positioned rows,
// border-bottom rules, font classes, `text-align` on fraction and limit
// stacks, and overflow-hidden svg surds. This module is that subset,
// written against pixel coordinates instead of a style engine. It is pure —
// no ntk, no react — which is what lets a test assert a superscript sits
// above the baseline without a display.
//
// Two sources of truth meet here, and the split matters:
//
// - **Vertical geometry is KaTeX's.** Every node in the tree carries
//   `height`/`depth` in em (descendant size changes already multiplied in),
//   and a vlist row's `top` plus its pstrut's height place a row's baseline
//   exactly as `buildCommon.makeVList` computed it: baseline offset =
//   `top + pstrut` em below the stack's own baseline.
// - **Horizontal geometry is the shaper's** — widths come from measuring
//   the actual face ntk will draw, so ink and hit-testing cannot drift from
//   what is on screen. KaTeX's own metric width rides along as the
//   fallback (`SymbolNode.width`), which is honest because it describes
//   the same font files; it is what the mock backend lays out with.
//
// Reading order: glyphs are emitted in tree order, except that a vlist's
// rows are emitted top row first — the DOM stacks them bottom-up, and a
// selection that reads "numerator, then denominator" (or "superscript,
// then subscript") is the one a reader expects to copy.

import type { KatexNode } from './katex.js';

// --- public shapes ----------------------------------------------------------

/** Measures one run of text in a face, in px. `null` means "no fonts here"
 *  (the mock backend) — the caller falls back to KaTeX's own metrics. */
export interface FormulaShaper {
  width(
    text: string,
    family: string,
    weight: number,
    style: 'normal' | 'italic',
    size: number,
  ): number | null;
}

/** One positioned run of ink. Coordinates are px from the layout's
 *  top-left; `baseline` is where the glyph sits, `top`/`bottom` bound the
 *  band a selection lights. */
export interface FormulaGlyph {
  text: string;
  x: number;
  width: number;
  baseline: number;
  top: number;
  bottom: number;
  size: number;
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  color: string;
  /** Code-point offset of this glyph's text in `FormulaLayout.text`. */
  index: number;
  /** Code points in `text`. */
  length: number;
}

/** A filled rectangle — fraction bars, `\rule`, overlines. */
export interface FormulaRule {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

type PathSeg =
  | { c: 'M' | 'L'; x: number; y: number }
  | {
      c: 'C';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      x: number;
      y: number;
    }
  | { c: 'Q'; x1: number; y1: number; x: number; y: number }
  | { c: 'Z' };

/**
 * An svg drawing (surds, stretchy accents), still in its viewBox units.
 * The painter derives the transform: `'slice'` scales uniformly by height
 * and clips horizontally at `width` (KaTeX's 400em-wide surd tails);
 * `'none'` stretches each axis independently; `'fit'` scales uniformly.
 */
export interface FormulaPath {
  segs: PathSeg[];
  x: number;
  y: number;
  width: number;
  height: number;
  viewWidth: number;
  viewHeight: number;
  mode: 'slice' | 'none' | 'fit';
  color: string;
}

export interface FormulaLayout {
  width: number;
  /** Above / below the baseline of the outermost line, px. */
  ascent: number;
  descent: number;
  baseline: number;
  glyphs: FormulaGlyph[];
  rules: FormulaRule[];
  paths: FormulaPath[];
  /** The glyphs' text in reading order — what a selection copies. */
  text: string;
}

export interface FormulaLayoutOptions {
  /** Pixels per em at the formula's base size. */
  em: number;
  color: string;
  shaper: FormulaShaper | null;
}

// --- tables -----------------------------------------------------------------

/** `Options.js`'s sizeMultipliers: `reset-sizeN sizeM` scales by M/N. */
const SIZE_MULT = [
  0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.44, 1.728, 2.074, 2.488,
];

interface FontBits {
  family?: string;
  weight?: number;
  style?: 'normal' | 'italic';
}

/** katex.css's font rules, class by class. */
const FONT_CLASSES: Record<string, FontBits> = {
  mathnormal: { family: 'KaTeX_Math', style: 'italic' },
  mathdefault: { family: 'KaTeX_Math', style: 'italic' },
  mathit: { family: 'KaTeX_Main', style: 'italic' },
  mathrm: { style: 'normal' },
  mathbf: { family: 'KaTeX_Main', weight: 700 },
  boldsymbol: { family: 'KaTeX_Math', weight: 700, style: 'italic' },
  amsrm: { family: 'KaTeX_AMS' },
  mathbb: { family: 'KaTeX_AMS' },
  textbb: { family: 'KaTeX_AMS' },
  mathcal: { family: 'KaTeX_Caligraphic' },
  mathfrak: { family: 'KaTeX_Fraktur' },
  textfrak: { family: 'KaTeX_Fraktur' },
  mathboldfrak: { family: 'KaTeX_Fraktur', weight: 700 },
  textboldfrak: { family: 'KaTeX_Fraktur', weight: 700 },
  mathtt: { family: 'KaTeX_Typewriter' },
  mathscr: { family: 'KaTeX_Script' },
  textscr: { family: 'KaTeX_Script' },
  mathsf: { family: 'KaTeX_SansSerif' },
  textsf: { family: 'KaTeX_SansSerif' },
  mathboldsf: { family: 'KaTeX_SansSerif', weight: 700 },
  textboldsf: { family: 'KaTeX_SansSerif', weight: 700 },
  mathsfit: { family: 'KaTeX_SansSerif', style: 'italic' },
  mathitsf: { family: 'KaTeX_SansSerif', style: 'italic' },
  textitsf: { family: 'KaTeX_SansSerif', style: 'italic' },
  mainrm: { family: 'KaTeX_Main', style: 'normal' },
  textrm: { family: 'KaTeX_Main' },
  texttt: { family: 'KaTeX_Typewriter' },
  textbf: { weight: 700 },
  textit: { style: 'italic' },
  textup: { style: 'normal' },
  textmd: { weight: 400 },
  'delim-size1': { family: 'KaTeX_Size1' },
  'delim-size4': { family: 'KaTeX_Size4' },
};

/** Rules drawn as a border-bottom the width of their container. */
const LINE_CLASSES = new Set([
  'frac-line',
  'overline-line',
  'underline-line',
  'hline',
  'hdashline',
]);

// --- small helpers ----------------------------------------------------------

function classesOf(node: KatexNode): string[] {
  return Array.isArray(node.classes) ? node.classes : [];
}

function has(classes: string[], name: string): boolean {
  return classes.includes(name);
}

function em(value: string | undefined): number {
  if (!value) return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function countCodePoints(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** The walking state: current scale, ink color, inherited face, and the
 *  `text-align` a vlist row would inherit. */
interface Ctx {
  base: number; // px per em at scale 1
  scale: number;
  color: string;
  font: Required<FontBits>;
  align: 'left' | 'center' | 'right';
  shaper: FormulaShaper | null;
}

function pxEm(ctx: Ctx): number {
  return ctx.base * ctx.scale;
}

/** Only a `reset-sizeN sizeM` *pair* rescales — `delimsizing size1`'s
 *  lone `size1` is a font pick, and falls through to factor 1 here. */
function sizingFactor(classes: string[]): number {
  let from = 0;
  let to = 0;
  for (const c of classes) {
    let m = /^reset-size(\d+)$/.exec(c);
    if (m) from = Number(m[1]);
    m = /^size(\d+)$/.exec(c);
    if (m) to = Number(m[1]);
  }
  if (!from || !to || !SIZE_MULT[from - 1] || !SIZE_MULT[to - 1]) return 1;
  return SIZE_MULT[to - 1] / SIZE_MULT[from - 1];
}

function deriveCtx(ctx: Ctx, node: KatexNode): Ctx {
  const classes = classesOf(node);
  let next = ctx;
  const factor = sizingFactor(classes);
  const color = node.style?.color;
  const font = fontFrom(classes, ctx.font);
  const align = alignFrom(classes, ctx.align);
  if (factor !== 1 || color || font !== ctx.font || align !== ctx.align) {
    next = {
      ...ctx,
      scale: ctx.scale * factor,
      color: color ?? ctx.color,
      font,
      align,
    };
  }
  return next;
}

function fontFrom(
  classes: string[],
  inherited: Required<FontBits>,
): Required<FontBits> {
  let out: Required<FontBits> | null = null;
  const apply = (bits: FontBits): void => {
    out = { ...(out ?? inherited), ...bits };
  };
  for (const c of classes) {
    const bits = FONT_CLASSES[c];
    if (bits) apply(bits);
  }
  // `.delimsizing.size1` — the size class doubles as a font pick here
  if (has(classes, 'delimsizing')) {
    for (let i = 1; i <= 4; i += 1) {
      if (has(classes, `size${i}`)) apply({ family: `KaTeX_Size${i}` });
    }
  }
  if (has(classes, 'op-symbol')) {
    if (has(classes, 'small-op')) apply({ family: 'KaTeX_Size1' });
    if (has(classes, 'large-op')) apply({ family: 'KaTeX_Size2' });
  }
  return out ?? inherited;
}

function alignFrom(classes: string[], inherited: Ctx['align']): Ctx['align'] {
  if (has(classes, 'mfrac') || has(classes, 'op-limits')) return 'center';
  if (has(classes, 'katex-accent') || has(classes, 'accent')) return 'center';
  if (has(classes, 'col-align-c')) return 'center';
  if (has(classes, 'col-align-r')) return 'right';
  if (has(classes, 'col-align-l') || has(classes, 'msupsub')) return 'left';
  if (has(classes, 'svg-align')) return 'left';
  return inherited;
}

// --- boxes ------------------------------------------------------------------

/** Everything a subtree laid out to, in its own coordinates: x from the
 *  box's left edge, y relative to the box's baseline (down positive). */
interface LBox {
  width: number;
  /** The advance the parent flow moves by — a symbol's italic correction
   *  makes it wider than the ink. Defaults to `width`. */
  advance?: number;
  height: number;
  depth: number;
  glyphs: FormulaGlyph[];
  rules: (FormulaRule & { stretch?: boolean })[];
  paths: (FormulaPath & { stretch?: boolean })[];
  /** True for boxes whose width is the container's (frac lines, surds). */
  stretch?: boolean;
  /** A `\\` — the flow breaks the line after it. */
  newline?: boolean;
}

function emptyBox(): LBox {
  return { width: 0, height: 0, depth: 0, glyphs: [], rules: [], paths: [] };
}

/** Append `child`'s items into `into`, translated. Emission order is
 *  reading order, so callers control it. */
function mergeBox(into: LBox, child: LBox, dx: number, dy: number): void {
  for (const g of child.glyphs) {
    into.glyphs.push({
      ...g,
      x: g.x + dx,
      baseline: g.baseline + dy,
      top: g.top + dy,
      bottom: g.bottom + dy,
    });
  }
  for (const r of child.rules) {
    into.rules.push({ ...r, x: r.x + dx, y: r.y + dy });
  }
  for (const p of child.paths) {
    into.paths.push({ ...p, x: p.x + dx, y: p.y + dy });
  }
}

/** Give a stretchable box its container's width. */
function stretchBox(box: LBox, width: number): void {
  box.width = width;
  for (const r of box.rules) {
    if (r.stretch) r.width = Math.max(0, width - r.x);
  }
  for (const p of box.paths) {
    if (p.stretch) p.width = Math.max(p.width, width - p.x);
  }
}

// --- node dispatch ----------------------------------------------------------

function layoutNode(node: KatexNode, ctx: Ctx): LBox {
  if (typeof node.text === 'string') return symbolBox(node, ctx);
  const classes = classesOf(node);
  if (has(classes, 'katex-mathml')) return emptyBox();
  if (has(classes, 'pstrut')) return emptyBox();
  if (has(classes, 'strut') || has(classes, 'katex-strut')) {
    return strutBox(node, ctx);
  }
  for (const c of classes) {
    if (LINE_CLASSES.has(c)) return lineBox(node, ctx);
  }
  if (has(classes, 'rule') || has(classes, 'katex-rule')) {
    return ruleBox(node, ctx);
  }
  if (has(classes, 'vlist-t')) return vlistBox(node, ctx);
  if (node.children?.some((c) => c.attributes?.viewBox)) {
    return svgBox(node, ctx);
  }
  if (has(classes, 'newline')) {
    const box = emptyBox();
    box.newline = true;
    return box;
  }
  const lap = has(classes, 'llap')
    ? 'llap'
    : has(classes, 'rlap')
      ? 'rlap'
      : has(classes, 'clap')
        ? 'clap'
        : null;
  const box = flowBox(node, ctx);
  if (lap) {
    // `width: 0; position: relative` — the ink hangs out of the flow
    const w = box.width;
    const shift = lap === 'llap' ? -w : lap === 'clap' ? -w / 2 : 0;
    const out = emptyBox();
    out.height = box.height;
    out.depth = box.depth;
    mergeBox(out, box, shift, 0);
    return out;
  }
  return box;
}

function symbolBox(node: KatexNode, ctx: Ctx): LBox {
  const text = node.text ?? '';
  const box = emptyBox();
  // KaTeX's Safari shim: a zero-width joiner in every vlist-s cell
  if (text === '' || text === '​') return box;
  const my = deriveCtx(ctx, node);
  const size = pxEm(my);
  const measured = my.shaper?.width(
    text,
    my.font.family,
    my.font.weight,
    my.font.style,
    size,
  );
  const width = measured ?? (node.width ?? 0.55 * countCodePoints(text)) * size;
  const height = (node.height ?? 0) * size;
  const depth = (node.depth ?? 0) * size;
  box.width = width;
  box.advance = width + (node.italic ?? 0) * size;
  box.height = height;
  box.depth = depth;
  box.glyphs.push({
    text,
    x: 0,
    width,
    baseline: 0,
    // The selection band: at least a text line's worth, so a lone minus
    // sign does not light up as a two-pixel sliver.
    top: -Math.max(height, 0.75 * size),
    bottom: Math.max(depth, 0.22 * size),
    size,
    family: my.font.family,
    weight: my.font.weight,
    style: my.font.style,
    color: my.color,
    index: 0,
    length: countCodePoints(text),
  });
  return box;
}

/** `strut` spans claim line height without ink: `height` stands above the
 *  baseline plus `vertical-align` (negative = below). */
function strutBox(node: KatexNode, ctx: Ctx): LBox {
  const size = pxEm(ctx);
  const h = em(node.style?.height) * size;
  const va = em(node.style?.verticalAlign) * size;
  const box = emptyBox();
  box.height = Math.max(0, h + va);
  box.depth = Math.max(0, -va);
  return box;
}

/** A border-bottom rule (`frac-line` and friends): an empty inline-block's
 *  baseline is its bottom edge, so the border fills `[-thickness, 0]`. */
function lineBox(node: KatexNode, ctx: Ctx): LBox {
  const my = deriveCtx(ctx, node);
  const size = pxEm(my);
  const thickness = Math.max(
    1,
    (em(node.style?.borderBottomWidth) || node.height || 0.04) * size,
  );
  const box = emptyBox();
  box.height = thickness;
  box.stretch = true;
  box.rules.push({
    x: 0,
    y: -thickness,
    width: 0,
    height: thickness,
    color: my.color,
    stretch: true,
  });
  return box;
}

/** `\rule[shift]{w}{h}` — a filled box lifted by `vertical-align`. */
function ruleBox(node: KatexNode, ctx: Ctx): LBox {
  const my = deriveCtx(ctx, node);
  const size = pxEm(my);
  const w = em(node.style?.width) * size;
  const h = em(node.style?.height) * size;
  const shift = em(node.style?.verticalAlign) * size;
  const box = emptyBox();
  box.width = w;
  box.height = Math.max(0, h + shift);
  box.depth = Math.max(0, -shift);
  box.rules.push({
    x: 0,
    y: -(h + shift),
    width: w,
    height: h,
    color: my.color,
  });
  return box;
}

/**
 * A vlist: rows stacked at exact baselines. `makeVList` writes each row's
 * wrapper with `top: -pstrut - pos - depth`, so reading it back,
 * `top + pstrut` is the row's baseline below the stack's. Rows come
 * bottom-up in the DOM and are emitted top-down here (reading order).
 */
function vlistBox(node: KatexNode, ctx: Ctx): LBox {
  const size = pxEm(ctx);
  const rows: {
    box: LBox;
    dy: number;
    ml: number;
    mr: number;
    align: Ctx['align'];
    minWidth: number;
  }[] = [];
  const firstColumn = node.children?.[0]; // vlist-r
  const list = firstColumn?.children?.find((c) => has(classesOf(c), 'vlist'));
  for (const wrap of list?.children ?? []) {
    const wclasses = classesOf(wrap);
    if (has(wclasses, 'vlist-s')) continue;
    const pstrut = wrap.children?.find((c) => has(classesOf(c), 'pstrut'));
    const dy = (em(wrap.style?.top) + em(pstrut?.style?.height)) * size;
    const wctx = deriveCtx(ctx, wrap);
    const content: KatexNode = {
      classes: [],
      children: wrap.children?.filter((c) => !has(classesOf(c), 'pstrut')),
      style: { paddingLeft: wrap.style?.paddingLeft },
    };
    const box = flowBox(content, wctx);
    rows.push({
      box,
      dy,
      ml: em(wrap.style?.marginLeft) * size,
      mr: em(wrap.style?.marginRight) * size,
      align: alignFrom(wclasses, wctx.align),
      minWidth: em(wrap.style?.minWidth) * size,
    });
  }

  let width = 0;
  for (const row of rows) {
    const natural = row.box.stretch
      ? Math.max(row.box.width, row.minWidth)
      : row.ml + row.box.width + row.mr;
    width = Math.max(width, natural);
  }

  const out = emptyBox();
  out.width = width;
  out.height = (node.height ?? 0) * size;
  out.depth = (node.depth ?? 0) * size;
  // Emission order is reading order, and the DOM's row order is not it:
  // `makeVList` stacks bottom-up for fractions and scripts but takes
  // `individualShift` rows (arrays, aligned environments) top-down. The
  // computed baseline is the one ordering that is right in every case —
  // topmost row first. The sort is stable, so equal baselines keep DOM
  // order.
  const ordered = rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => a.row.dy - b.row.dy || a.i - b.i)
    .map((e) => e.row);
  for (const row of ordered) {
    if (row.box.stretch) stretchBox(row.box, width - row.ml - row.mr);
    const room = width - row.ml - row.mr - row.box.width;
    const dx =
      row.ml +
      (row.align === 'center' ? room / 2 : row.align === 'right' ? room : 0);
    mergeBox(out, row.box, dx, row.dy);
  }
  return out;
}

/** A span whose children include `<svg>` — surds and stretchy accents.
 *  The span's baseline is its bottom edge; the drawing may poke above the
 *  claimed height (a surd does, by design). */
function svgBox(node: KatexNode, ctx: Ctx): LBox {
  const my = deriveCtx(ctx, node);
  const size = pxEm(my);
  const classes = classesOf(node);
  const styleH = em(node.style?.height) * size;
  const minW = em(node.style?.minWidth) * size;
  const box = emptyBox();
  box.width = minW;
  box.height = (node.height ?? em(node.style?.height)) * size;
  box.depth = (node.depth ?? 0) * size;
  box.stretch = has(classes, 'hide-tail') || has(classes, 'katex-stretchy');
  for (const svg of node.children ?? []) {
    const viewBox = svg.attributes?.viewBox;
    if (!viewBox) continue;
    const parts = viewBox.split(/[\s,]+/).map(Number);
    const viewWidth = parts[2] || 1;
    const viewHeight = parts[3] || 1;
    const aspect = svg.attributes?.preserveAspectRatio ?? '';
    const mode: FormulaPath['mode'] = aspect.includes('slice')
      ? 'slice'
      : aspect === 'none'
        ? 'none'
        : 'fit';
    const height = em(svg.attributes?.height) * size || styleH;
    for (const child of svg.children ?? []) {
      const d = pathDataOf(child);
      if (!d) continue;
      box.paths.push({
        segs: parsePathData(d),
        x: 0,
        y: -(styleH || height),
        width: minW,
        height,
        viewWidth,
        viewHeight,
        mode,
        color: my.color,
        stretch: box.stretch,
      });
    }
  }
  return box;
}

function pathDataOf(node: KatexNode): string | null {
  if (typeof node.pathName !== 'string') return null;
  if (node.alternate) return node.alternate;
  // The static path table is not exported, but every node serializes
  // itself without a DOM.
  const markup = node.toMarkup?.() ?? '';
  const m = /\sd=['"]([^'"]+)['"]/.exec(markup);
  return m ? m[1] : null;
}

/**
 * Inline flow: children left to right on a shared baseline, margins in
 * their own em, `\\` starting a new line below. The height and depth are
 * whatever the children (struts included) claim.
 */
function flowBox(node: KatexNode, ctx: Ctx): LBox {
  const my = deriveCtx(ctx, node);
  const size = pxEm(my);

  // segment at newlines; almost every flow is a single segment
  const segments: KatexNode[][] = [[]];
  for (const child of node.children ?? []) {
    if (has(classesOf(child), 'newline')) segments.push([]);
    else segments[segments.length - 1].push(child);
  }

  const lines: LBox[] = segments.map((children) => {
    const line = emptyBox();
    let x = em(node.style?.paddingLeft) * size;
    for (const child of children) {
      const cctx = deriveCtx(my, child);
      const csize = pxEm(cctx);
      const cbox = layoutNode(child, cctx);
      x += em(child.style?.marginLeft) * csize;
      mergeBox(line, cbox, x, 0);
      x += (cbox.advance ?? cbox.width) + em(child.style?.marginRight) * csize;
      line.height = Math.max(line.height, cbox.height);
      line.depth = Math.max(line.depth, cbox.depth);
      if (cbox.stretch && children.length === 1) line.stretch = true;
    }
    line.width = Math.max(x, 0);
    return line;
  });

  if (lines.length === 1) {
    const line = lines[0];
    if (node.style?.width) line.width = em(node.style.width) * size;
    return line;
  }

  // stacked lines: first line's baseline is the box's
  const out = emptyBox();
  let baseline = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (i > 0) baseline += lines[i - 1].depth + line.height + 0.2 * size;
    mergeBox(out, line, 0, baseline);
    out.width = Math.max(out.width, line.width);
  }
  out.height = lines[0].height;
  out.depth = baseline + lines[lines.length - 1].depth;
  return out;
}

// --- svg path data ----------------------------------------------------------

const PATH_TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:e[+-]?\d+)?)/g;

/**
 * The subset of SVG path syntax KaTeX's geometry uses. Arcs never occur;
 * if one ever does, it degrades to a line to its endpoint rather than
 * throwing mid-paint.
 */
export function parsePathData(d: string): PathSeg[] {
  const segs: PathSeg[] = [];
  const tokens: (string | number)[] = [];
  let m: RegExpExecArray | null;
  while ((m = PATH_TOKEN.exec(d))) {
    tokens.push(m[1] ?? Number(m[2]));
  }
  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastCtrlX = 0;
  let lastCtrlY = 0;
  let lastCmd = '';
  const num = (): number => {
    const t = tokens[i];
    i += 1;
    return typeof t === 'number' ? t : 0;
  };
  while (i < tokens.length) {
    const t = tokens[i];
    if (typeof t === 'string') {
      cmd = t;
      i += 1;
    } else if (cmd === 'M') {
      cmd = 'L'; // extra coordinate pairs after a moveto are linetos
    } else if (cmd === 'm') {
      cmd = 'l';
    }
    const rel = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();
    switch (upper) {
      case 'M': {
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        cx = x;
        cy = y;
        sx = x;
        sy = y;
        segs.push({ c: 'M', x, y });
        break;
      }
      case 'L': {
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        cx = x;
        cy = y;
        segs.push({ c: 'L', x, y });
        break;
      }
      case 'H': {
        const x = num() + (rel ? cx : 0);
        cx = x;
        segs.push({ c: 'L', x, y: cy });
        break;
      }
      case 'V': {
        const y = num() + (rel ? cy : 0);
        cy = y;
        segs.push({ c: 'L', x: cx, y });
        break;
      }
      case 'C': {
        const x1 = num() + (rel ? cx : 0);
        const y1 = num() + (rel ? cy : 0);
        const x2 = num() + (rel ? cx : 0);
        const y2 = num() + (rel ? cy : 0);
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        segs.push({ c: 'C', x1, y1, x2, y2, x, y });
        lastCtrlX = x2;
        lastCtrlY = y2;
        cx = x;
        cy = y;
        break;
      }
      case 'S': {
        const reflects = lastCmd === 'C' || lastCmd === 'S';
        const x1 = reflects ? 2 * cx - lastCtrlX : cx;
        const y1 = reflects ? 2 * cy - lastCtrlY : cy;
        const x2 = num() + (rel ? cx : 0);
        const y2 = num() + (rel ? cy : 0);
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        segs.push({ c: 'C', x1, y1, x2, y2, x, y });
        lastCtrlX = x2;
        lastCtrlY = y2;
        cx = x;
        cy = y;
        break;
      }
      case 'Q': {
        const x1 = num() + (rel ? cx : 0);
        const y1 = num() + (rel ? cy : 0);
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        segs.push({ c: 'Q', x1, y1, x, y });
        lastCtrlX = x1;
        lastCtrlY = y1;
        cx = x;
        cy = y;
        break;
      }
      case 'T': {
        const reflects = lastCmd === 'Q' || lastCmd === 'T';
        const x1 = reflects ? 2 * cx - lastCtrlX : cx;
        const y1 = reflects ? 2 * cy - lastCtrlY : cy;
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        segs.push({ c: 'Q', x1, y1, x, y });
        lastCtrlX = x1;
        lastCtrlY = y1;
        cx = x;
        cy = y;
        break;
      }
      case 'A': {
        num(); // rx
        num(); // ry
        num(); // rotation
        num(); // large-arc
        num(); // sweep
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        segs.push({ c: 'L', x, y });
        cx = x;
        cy = y;
        break;
      }
      case 'Z': {
        segs.push({ c: 'Z' });
        cx = sx;
        cy = sy;
        break;
      }
      default:
        i += 1; // unknown — skip the token and move on
    }
    lastCmd = upper;
  }
  return segs;
}

// --- entry ------------------------------------------------------------------

/**
 * Lay a KaTeX dom tree out. `root` is what `__renderToDomTree` returned —
 * the `.katex` span, or the `.katex-display` wrapper around it.
 */
export function layoutFormula(
  root: KatexNode,
  options: FormulaLayoutOptions,
): FormulaLayout {
  const ctx: Ctx = {
    base: options.em,
    scale: 1,
    color: options.color,
    font: { family: 'KaTeX_Main', weight: 400, style: 'normal' },
    align: 'left',
    shaper: options.shaper,
  };
  const box = layoutNode(root, ctx);

  // shift to a top-left origin
  const ascent = Math.ceil(box.height);
  const glyphs: FormulaGlyph[] = [];
  let text = '';
  let index = 0;
  for (const g of box.glyphs) {
    const length = g.length;
    glyphs.push({
      ...g,
      baseline: g.baseline + ascent,
      top: g.top + ascent,
      bottom: g.bottom + ascent,
      index,
      length,
    });
    text += g.text;
    index += length;
  }
  return {
    width: Math.ceil(box.width),
    ascent,
    descent: Math.ceil(box.depth),
    baseline: ascent,
    glyphs,
    rules: box.rules.map((r) => ({ ...r, y: r.y + ascent })),
    paths: box.paths.map((p) => ({ ...p, y: p.y + ascent })),
    text,
  };
}
