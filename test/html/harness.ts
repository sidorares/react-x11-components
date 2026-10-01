// What the <Html> tests share. The pure halves are tested directly (the CSS
// parser, the cascade and the box tree are where every subtle bug lives, and
// none of them needs a display), the widget through react-x11's harness: the
// mock backend for structure and registration, the in-process X server for
// anything that depends on real font metrics — layout, selection, hit
// testing.
//
// The tests are a file a subject, beside this one. A helper one file's tests
// use is in that file; one that two use is here.
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';
import { act, renderX11, screen } from 'react-x11/test';
import type { RenderX11Options } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { HtmlViewNode } from '../../src/html/index.js';
import { parseColor } from '../../src/html/css/values.js';

export const h = React.createElement;

// Real font files, so metrics are machine-stable. Both families ship with
// macOS and the Linux paths cover the common distros; a box with neither
// skips the metric-dependent tests rather than failing them.
const FONT_CANDIDATES: Array<[string, string]> = [
  [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Monaco.ttf',
  ],
  [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  ],
];
const found = FONT_CANDIDATES.find(
  ([sans, mono]) => existsSync(sans) && existsSync(mono),
);
export const FONTS = found
  ? { 'sans-serif': found[0], monospace: found[1] }
  : null;

export function view(node: DrawnNode): HtmlViewNode {
  return (node as unknown as { children: HtmlViewNode[] }).children[0];
}

export async function render(source: string, width = 400) {
  const result = await renderX11(
    h(
      'box',
      { style: { width, flexDirection: 'column' } },
      h(Html, { source, partial: false, 'data-testname': 'doc' }),
    ),
    FONTS
      ? { width: width + 40, height: 600, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  return { result, node: screen.getByTestName('doc') as DrawnNode };
}

export const metric = FONTS ? test : test.skip;

/** The text a document's boxes hold, generated content included. */
export async function documentText(source: string): Promise<string> {
  const { node } = await render(source, 300);
  return (view(node) as unknown as { _tree: { text: string } })._tree.text;
}

interface PlacedText {
  drawX: number;
  drawY: number;
  layout: { lines: { x: number; width: number; baseline: number }[] };
  layoutLine: number;
  textStart: number;
  textEnd: number;
}

export interface PlacedLine {
  x: number;
  y: number;
  width: number;
  height: number;
  baseline: number;
  texts: PlacedText[];
  atomics: { x: number; box: { width: number } }[];
  edges?: { side: 'start' | 'end'; x: number; width: number }[];
}

/** Every line under an element, in document order. */
export function linesOf(el: HtmlViewNode, id: string): PlacedLine[] {
  type B = { lines: PlacedLine[] | null; children: B[] };
  const out: PlacedLine[] = [];
  const walk = (b: B): void => {
    out.push(...(b.lines ?? []));
    b.children.forEach(walk);
  };
  walk(boxOf(el, id) as unknown as B);
  return out;
}

/** Where a fragment's text starts and ends. */
export function extentOf(text: PlacedText): [number, number] {
  const natural = text.layout.lines[text.layoutLine];
  return [text.drawX + natural.x, text.drawX + natural.x + natural.width];
}

/** Where each run of a line's document text lies, left to right: a line
 *  laid out in one piece has its inline boxes' edges in it as spacers,
 *  which are no text of the document's and are left out. */
export function textRunsOf(line: PlacedLine): [number, number][] {
  const out: [number, number][] = [];
  for (const text of line.texts) {
    const t = text as PlacedText & {
      layout: {
        lines: { runs?: { x: number; width: number; start: number }[] }[];
      };
      spans: { boxAt?(offset: number): unknown };
    };
    const natural = t.layout.lines[t.layoutLine] as {
      x: number;
      runs?: { x: number; width: number; start: number }[];
    };
    for (const run of natural.runs ?? []) {
      if (t.spans.boxAt && !t.spans.boxAt(run.start)) continue;
      const x = t.drawX + natural.x + run.x;
      out.push([x, x + run.width]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

export interface Fill {
  style: unknown;
  x: number;
  y: number;
  w: number;
  h: number;
  /** A rounded fill's corners; null for a plain rectangle. */
  radii: number[] | null;
  /** A second subpath and the rule it was filled by: a ring's inside. */
  inner?: {
    x: number;
    y: number;
    w: number;
    h: number;
    radii: number[] | null;
  };
  rule?: string;
  /** A path of curves: each curve's reach across and down, in the order
   *  drawn — a quarter ellipse's radii. The bounds are the whole path's. */
  corners?: [number, number][];
  /** The context's shadow when the fill was made, where it had a blur. */
  shadow?: { color: string; blur: number; x: number; y: number };
  /** The matrix the fill was made under, where `transform` set one. */
  matrix?: number[];
}

/** What a paint did, in order: a fill, or a clip pushed or popped. */
export type PaintOp =
  | ({ op: 'fill' } & Fill)
  | {
      op: 'clip';
      x: number;
      y: number;
      w: number;
      h: number;
      radii: number[] | null;
    }
  | { op: 'save' }
  | { op: 'restore' }
  | {
      op: 'image';
      x: number;
      y: number;
      w: number;
      h: number;
      /** The piece of the image drawn, where not all of it is. */
      src?: number[];
    }
  | { op: 'text'; x: number; y: number; shadow?: Fill['shadow'] };

/** What painting the document fills, in order. The glyphs are left out:
 *  the recorder has nowhere to draw them. `ops`, when given, gets the fills
 *  and the clips around them. */
export async function fillsOf(
  el: HtmlViewNode,
  ops?: PaintOp[],
  options?: {
    originX?: number;
    originY?: number;
    canvas?: { x: number; y: number; width: number; height: number };
    viewport?: { x: number; y: number; width: number; height: number };
    /** The rectangle being repainted; all of it where none is given. */
    damage?: { x: number; y: number; width: number; height: number };
    surface?: (
      width: number,
      height: number,
    ) => { getContext(kind: '2d'): unknown; destroy?(): void } | null;
    imageFor?: () => unknown;
    cached?: (
      key: string,
      width: number,
      height: number,
      draw: (ctx: never) => void,
    ) => unknown;
    backgroundImageFor?: (url: string) => {
      image: unknown;
      width: number | null;
      height: number | null;
      ratio: number;
    } | null;
    scale?: number;
    /** A context whose radial gradients are one colour. */
    flatRadial?: boolean;
  },
): Promise<Fill[]> {
  const { paintDocument } = await import('../../src/html/paint.js');
  type T = { lines: { texts: { layout: object }[] }[] | null; children: T[] };
  const tree = (el as unknown as { _tree: { root: T } })._tree;
  const layouts = new Set<object>();
  const walk = (b: T): void => {
    for (const line of b.lines ?? []) {
      for (const text of line.texts) layouts.add(text.layout);
    }
    b.children.forEach(walk);
  };
  walk(tree.root);
  const fills: Fill[] = [];
  let fillStyle: unknown = null;
  let path: Omit<Fill, 'style'> | null = null;
  let inner: Fill['inner'] | null = null;
  let curves: {
    at: [number, number];
    corners: [number, number][];
    box: [number, number, number, number];
  } | null = null;
  const reach = (x: number, y: number): void => {
    const b = curves!.box;
    curves!.at = [x, y];
    b[0] = Math.min(b[0], x);
    b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x);
    b[3] = Math.max(b[3], y);
  };
  const shadowOf = (): Fill['shadow'] =>
    ctx.shadowBlur > 0
      ? {
          color: ctx.shadowColor,
          blur: ctx.shadowBlur,
          x: ctx.shadowOffsetX,
          y: ctx.shadowOffsetY,
        }
      : undefined;
  const saved: [string, number, number, number][] = [];
  let matrix: number[] | null = null;
  const matrices: (number[] | null)[] = [];
  const ctx = {
    shadowColor: 'rgba(0, 0, 0, 0)',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(v: unknown) {
      fillStyle = v;
    },
    save() {
      saved.push([
        ctx.shadowColor,
        ctx.shadowBlur,
        ctx.shadowOffsetX,
        ctx.shadowOffsetY,
      ]);
      matrices.push(matrix);
      ops?.push({ op: 'save' });
    },
    restore() {
      const state = saved.pop();
      if (state) {
        [
          ctx.shadowColor,
          ctx.shadowBlur,
          ctx.shadowOffsetX,
          ctx.shadowOffsetY,
        ] = state;
      }
      matrix = matrices.pop() ?? null;
      ops?.push({ op: 'restore' });
    },
    fillRect(x: number, y: number, w: number, h: number) {
      const fill = { style: fillStyle, x, y, w, h, radii: null };
      fills.push(fill);
      ops?.push({ op: 'fill', ...fill });
    },
    beginPath() {
      path = null;
      inner = null;
      curves = null;
    },
    moveTo(x: number, y: number) {
      curves ??= { at: [x, y], corners: [], box: [x, y, x, y] };
      reach(x, y);
    },
    lineTo(x: number, y: number) {
      reach(x, y);
    },
    bezierCurveTo(...args: number[]) {
      const [x, y] = args.slice(4);
      const [fromX, fromY] = curves!.at;
      curves!.corners.push([Math.abs(x - fromX), Math.abs(y - fromY)]);
      reach(x, y);
    },
    closePath() {},
    rect(x: number, y: number, w: number, h: number) {
      path = { x, y, w, h, radii: null };
    },
    roundRect(
      x: number,
      y: number,
      w: number,
      h: number,
      radii: (number | { x: number; y: number })[],
    ) {
      const r = radii as number[];
      if (path) inner = { x, y, w, h, radii: r };
      else path = { x, y, w, h, radii: r };
    },
    fill(rule?: string) {
      if (curves) {
        const [x0, y0, x1, y1] = curves.box;
        const fill: Fill = {
          style: fillStyle,
          x: x0,
          y: y0,
          w: x1 - x0,
          h: y1 - y0,
          radii: null,
          corners: curves.corners,
          rule,
        };
        const shadow = shadowOf();
        if (shadow) fill.shadow = shadow;
        if (matrix) fill.matrix = matrix;
        fills.push(fill);
        ops?.push({ op: 'fill', ...fill });
        curves = null;
        path = null;
        inner = null;
        return;
      }
      if (path) {
        const fill: Fill = { style: fillStyle, ...path };
        if (inner) Object.assign(fill, { inner, rule });
        const shadow = shadowOf();
        if (shadow) fill.shadow = shadow;
        if (matrix) fill.matrix = matrix;
        fills.push(fill);
        ops?.push({ op: 'fill', ...fill });
      }
      path = null;
      inner = null;
    },
    clip() {
      if (curves) {
        const [x0, y0, x1, y1] = curves.box;
        ops?.push({
          op: 'clip',
          x: x0,
          y: y0,
          w: x1 - x0,
          h: y1 - y0,
          radii: null,
        });
        curves = null;
      }
      if (path) {
        const { x, y, w, h, radii } = path;
        ops?.push({ op: 'clip', x, y, w, h, radii });
      }
      path = null;
    },
    drawImage(_image: unknown, ...args: number[]) {
      if (args.length >= 8) {
        const [x, y, w, h] = args.slice(4);
        ops?.push({ op: 'image', x, y, w, h, src: args.slice(0, 4) });
        return;
      }
      const [x, y, w, h] = args;
      ops?.push({ op: 'image', x, y, w, h });
    },
    createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
      const stops: [number, string][] = [];
      return {
        line: [x0, y0, x1, y1],
        stops,
        addColorStop(at: number, color: string) {
          stops.push([at, color]);
        },
      };
    },
    createRadialGradient(
      x0: number,
      y0: number,
      r0: number,
      x1: number,
      y1: number,
      r1: number,
    ) {
      const stops: [number, string][] = [];
      return {
        circles: [x0, y0, r0, x1, y1, r1],
        stops,
        addColorStop(at: number, color: string) {
          stops.push([at, color]);
        },
      };
    },
    transform(...m: number[]) {
      matrix = m;
    },
  };
  if (options?.flatRadial) {
    // react-x11's macOS context: the method, with no circles to take
    (ctx as { createRadialGradient: unknown }).createRadialGradient = () => ({
      flat: true,
      addColorStop() {},
    });
  }
  for (const layout of layouts) {
    (layout as { draw: unknown }).draw = (_: unknown, x: number, y: number) => {
      const shadow = shadowOf();
      ops?.push({ op: 'text', x, y, ...(shadow ? { shadow } : null) });
    };
  }
  try {
    paintDocument(ctx as never, tree as never, {
      originX: 0,
      originY: 0,
      damage: null,
      selection: null,
      selectionColor: null,
      imageFor: () => null,
      ...options,
    });
  } finally {
    for (const layout of layouts) delete (layout as { draw?: unknown }).draw;
  }
  return fills;
}

// A box that `position: relative` moves has its text laid out apart, a line
// a piece at a time, as bidi text is: the path that decides a break at an
// inline box's edge itself, where one layout of the paragraph leaves it to
// the text engine.
export const MOVED = 'position:relative;top:1px';

/**
 * A document in a box `height` tall that scrolls it — the viewport a `vh`,
 * the root's percentage height and the initial containing block are
 * measured against — with a `resize` that sets the box's size again.
 */
export async function renderScrolled(
  source: string,
  height: number,
  width = 400,
) {
  const doc = (height: number, width: number) =>
    h(
      'box',
      { style: { width, height, flexDirection: 'column' } },
      h(
        'box',
        { style: { flexGrow: 1, overflow: 'scroll' } },
        h(Html, { source, partial: false, 'data-testname': 'doc' }),
      ),
    );
  const result = await renderX11(
    doc(height, width),
    FONTS
      ? { width: 640, height: 800, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  // How tall the scroll box came out is a layout pass's to decide, and the
  // element reads it after that pass, so a frame of its own is where a
  // change of viewport is seen — and the one after, where core asks again.
  await act();
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const resize = async (height: number, w = width): Promise<void> => {
    await act(() => result.rerender(doc(height, w)));
    await act();
  };
  return { el, resize };
}

/** The clips standing when a fill of this colour was made, innermost last. */
export function clipsAround(ops: PaintOp[], color: string): PaintOp[][] {
  const stack: (PaintOp | null)[] = [];
  const out: PaintOp[][] = [];
  for (const op of ops) {
    if (op.op === 'save') stack.push(null);
    else if (op.op === 'restore') stack.pop();
    else if (op.op === 'clip') stack[stack.length - 1] = op;
    else if (op.op === 'fill' && op.style === parseColor(color)) {
      out.push(stack.filter((c): c is PaintOp => c !== null));
    }
  }
  return out;
}

/** One closed outline in a path: a rectangle as its four corners, a curve
 *  as the line it bends along. */
export type Outline = [number, number][];

/** What a paint of the part of the document `damage` names fills and clips
 *  to, in order, each path as the outlines it is made of — so that where a
 *  shape reaches can be asked of any point (`windingAt`), whatever mix of
 *  rectangles, rounded rectangles and curves drew it. An image is drawn as
 *  nothing, so `backgroundImageFor` is there for the clip it is drawn in. */
export async function pathsOf(
  el: HtmlViewNode,
  damage: { x: number; y: number; width: number; height: number },
  backgroundImageFor?: (url: string) => {
    image: unknown;
    width: number | null;
    height: number | null;
    ratio: number;
  } | null,
): Promise<{
  fills: { style: unknown; rule: string; outlines: Outline[] }[];
  clips: Outline[][];
}> {
  const { paintDocument } = await import('../../src/html/paint.js');
  const fills: { style: unknown; rule: string; outlines: Outline[] }[] = [];
  const clips: Outline[][] = [];
  let outlines: Outline[] = [];
  let at: [number, number] = [0, 0];
  const last = (): Outline => outlines[outlines.length - 1];
  /** A quarter ellipse about its centre, from `from` a quarter turn on. */
  const quarter = (
    out: Outline,
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    from: number,
  ): void => {
    for (let i = 0; i <= 16; i += 1) {
      const a = ((from + i / 16) * Math.PI) / 2;
      out.push([cx + rx * Math.sin(a), cy - ry * Math.cos(a)]);
    }
  };
  const ctx = {
    fillStyle: null as unknown,
    save() {},
    restore() {},
    fillRect(x: number, y: number, w: number, h: number) {
      const rect: Outline = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ];
      fills.push({ style: ctx.fillStyle, rule: 'nonzero', outlines: [rect] });
    },
    beginPath() {
      outlines = [];
    },
    rect(x: number, y: number, w: number, h: number) {
      outlines.push([
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ]);
    },
    roundRect(
      x: number,
      y: number,
      w: number,
      h: number,
      radii: (number | { x: number; y: number })[],
    ) {
      const [a, b, c, d] = radii.map((r) =>
        typeof r === 'number' ? { x: r, y: r } : r,
      );
      const out: Outline = [];
      quarter(out, x + w - b.x, y + b.y, b.x, b.y, 0);
      quarter(out, x + w - c.x, y + h - c.y, c.x, c.y, 1);
      quarter(out, x + d.x, y + h - d.y, d.x, d.y, 2);
      quarter(out, x + a.x, y + a.y, a.x, a.y, 3);
      outlines.push(out);
    },
    moveTo(x: number, y: number) {
      outlines.push([[x, y]]);
      at = [x, y];
    },
    lineTo(x: number, y: number) {
      last().push([x, y]);
      at = [x, y];
    },
    bezierCurveTo(...p: number[]) {
      const [x0, y0] = at;
      const [x1, y1, x2, y2, x3, y3] = p;
      for (let i = 1; i <= 64; i += 1) {
        const t = i / 64;
        const u = 1 - t;
        const [k0, k1, k2, k3] = [
          u * u * u,
          3 * u * u * t,
          3 * u * t * t,
          t ** 3,
        ];
        last().push([
          k0 * x0 + k1 * x1 + k2 * x2 + k3 * x3,
          k0 * y0 + k1 * y1 + k2 * y2 + k3 * y3,
        ]);
      }
      at = [x3, y3];
    },
    closePath() {},
    fill(rule?: string) {
      fills.push({ style: ctx.fillStyle, rule: rule ?? 'nonzero', outlines });
      outlines = [];
    },
    clip() {
      clips.push(outlines);
      outlines = [];
    },
    drawImage() {},
  };
  paintDocument(ctx as never, (el as unknown as { _tree: never })._tree, {
    originX: 0,
    originY: 0,
    damage,
    selection: null,
    selectionColor: null,
    imageFor: () => null,
    backgroundImageFor,
  });
  return { fills, clips };
}

/** How many times outlines wind round a point: inside them by the non-zero
 *  rule where not 0, and by the even-odd rule where odd. */
export function windingAt(outlines: Outline[], x: number, y: number): number {
  let winding = 0;
  for (const outline of outlines) {
    for (let i = 0; i < outline.length; i += 1) {
      const [x0, y0] = outline[i];
      const [x1, y1] = outline[(i + 1) % outline.length];
      if (y0 <= y === y1 <= y) continue;
      // where the edge crosses the line through the point, right of it
      if (x0 + ((y - y0) / (y1 - y0)) * (x1 - x0) <= x) continue;
      winding += y1 > y0 ? 1 : -1;
    }
  }
  return winding;
}

// a 10x10 PNG, solid #ff0000
export const RED_PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAIUlEQVR4AX3BAQEAAAiDMKR/' +
      '59uA7UaRJEmSJEmSJEmS9EEsAROhAw00AAAAAElFTkSuQmCC',
    'base64',
  ),
);

export async function renderWithImages(source: string, width = 200) {
  const result = await renderX11(
    h(
      'box',
      { style: { width, height: 120, flexDirection: 'column' } },
      h(Html, {
        source,
        partial: false,
        style: { flexGrow: 1 },
        onResource: (r: { kind: string }) =>
          r.kind === 'image'
            ? { kind: 'image' as const, bytes: RED_PNG }
            : null,
      }),
    ),
    { width: width + 40, height: 160, fonts: FONTS! },
  );
  return result.ctx;
}

// react-x11 hands a registered element two units (its docs/scale.md): `abs`,
// the paint context and every box the engine lays out are device pixels,
// while a synthetic event's `x`/`y` and every style length are logical. At
// 1x — every other test here — the two coincide, which is how a view
// that compared `ev.x` with `abs` and laid a `16px` out as sixteen device
// pixels passed all of it. These run at 2x, with the document offset in its
// window so that a device origin and a logical one differ — with `abs` at
// (0, 0) the mistake being pinned cancels out.

/** The harness at a display scale of 2 (react-x11's docs/scale.md): the
 *  headless server resolves to exactly 1 on its own, which is why every
 *  other test here can read its numbers literally. */
export function atScale2(over: RenderX11Options): RenderX11Options {
  return { ...over, scale: 2 };
}

export async function render2x(
  source: string,
  width = 300,
  props: Record<string, unknown> = {},
): Promise<{ result: Awaited<ReturnType<typeof renderX11>>; node: DrawnNode }> {
  const result = await renderX11(
    h(
      'box',
      { style: { width: width + 40, padding: 20, flexDirection: 'column' } },
      h(Html, {
        source,
        partial: false,
        'data-testname': 'doc',
        ...props,
      }),
    ),
    atScale2({ width: width + 80, height: 300, fonts: FONTS! }),
  );
  return { result, node: screen.getByTestName('doc') as DrawnNode };
}

export interface LaidBox {
  el: { attribs: Record<string, string> } | null;
  x: number;
  y: number;
  width: number;
  height: number;
  children: LaidBox[];
}

/** The box the engine laid an element out in — device pixels, document
 *  coordinates. */
export function boxOf(el: HtmlViewNode, id: string): LaidBox {
  const root = (el as unknown as { _tree: { root: LaidBox } })._tree.root;
  const find = (box: LaidBox): LaidBox | null => {
    if (box.el?.attribs.id === id) return box;
    for (const child of box.children) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  const found = find(root);
  assert.ok(found, `#${id} has a box`);
  return found;
}

export type ReplacedBox = LaidBox & { kind: string; replaced: string };

/** Render with each image URL answered from `images`, as bytes. */
export async function renderWithBytes(
  source: string,
  images: Record<string, Uint8Array>,
  width = 400,
) {
  const result = await renderX11(
    h(
      'box',
      { style: { width, flexDirection: 'column' } },
      h(Html, {
        source,
        partial: false,
        'data-testname': 'doc',
        onResource: (r: { url: string; kind: string }) =>
          r.kind === 'image' && images[r.url]
            ? { kind: 'image' as const, bytes: images[r.url] }
            : null,
      }),
    ),
    FONTS
      ? { width: width + 40, height: 400, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  return { result, el: view(screen.getByTestName('doc') as DrawnNode) };
}

export const svgBytes = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, 'utf8'));

export const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

/** The fragments of a paragraph's lines, each with the document text it
 *  draws and where its layout's origin is. */
export function fragmentsOf(el: HtmlViewNode, id: string) {
  const text = el.textContent();
  return linesOf(el, id).flatMap((line) =>
    line.texts.map((t) => ({
      text: text.slice(t.textStart, t.textEnd),
      x: t.drawX,
      y: t.drawY,
      line: [line.y, line.height],
    })),
  );
}

/** Each fragment's text and the baseline it is drawn on. */
export function baselinesOf(el: HtmlViewNode, id: string) {
  const text = el.textContent();
  return linesOf(el, id).flatMap((line) =>
    line.texts.map((t) => ({
      text: text.slice(t.textStart, t.textEnd),
      at: t.drawY + t.layout.lines[t.layoutLine].baseline,
      line: line.y + (line as unknown as { baseline: number }).baseline,
    })),
  );
}

/** The document text of each line a paragraph was laid out in. */
export function lineTextsOf(el: HtmlViewNode, id: string): string[] {
  const text = el.textContent();
  return linesOf(el, id).map((line) =>
    line.texts.map((t) => text.slice(t.textStart, t.textEnd)).join(''),
  );
}

/** A laid box's resolved edges and style, which `LaidBox` leaves out. */
export function edgesOf(box: LaidBox) {
  return box as unknown as {
    padLeft: number;
    padRight: number;
    padTop: number;
    padBottom: number;
    borderLeft: number;
    marginLeft: number;
    marginRight: number;
    style: { borderRadius: number[] };
  };
}

/** A window region, in device pixels. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A window region's pixels, straight RGBA. */
export function pixelsIn(
  ctx: unknown,
  region: Region,
): Promise<Uint8ClampedArray> {
  const { x, y, width, height } = region;
  return new Promise<Uint8ClampedArray>((ok, fail) =>
    (
      ctx as {
        getImageData(
          x: number,
          y: number,
          w: number,
          h: number,
          cb: (e: unknown, d: { data: Uint8ClampedArray }) => void,
        ): void;
      }
    ).getImageData(x, y, width, height, (e, d) => (e ? fail(e) : ok(d.data))),
  );
}

/** The fills a document's boxes paint, of one colour. */
export async function fillsIn(source: string, color: string): Promise<Fill[]> {
  const { node } = await render('<style>body{margin:0}</style>' + source);
  const ink = parseColor(color);
  return (await fillsOf(view(node))).filter((f) => f.style === ink);
}

type DocElement = Parameters<HtmlViewNode['elementRect']>[0];

export function findById(node: unknown, id: string): DocElement | null {
  const n = node as { attribs?: Record<string, string>; children?: unknown[] };
  if (n.attribs?.id === id) return n as unknown as DocElement;
  for (const child of n.children ?? []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}
