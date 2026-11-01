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
import { deflateSync } from 'node:zlib';
import React from 'react';
import { act, renderX11, screen } from 'react-x11/test';
import type { RenderX11Options } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import * as ntk from 'react-x11/ntk';
import { Html } from '../../src/index.js';
import { HtmlViewNode } from '../../src/html/index.js';
import { parseColor } from '../../src/html/css/values.js';
import { mapPoint } from '../../src/html/css/transform.js';
import { placedMatrix } from '../../src/html/layout/block.js';
import { drawsForeignObjects } from '../../src/html/svg.js';
import { GENERATED_FROM } from '../../src/html/layout/boxes.js';
import { stackingOf, topLayerBoxes } from '../../src/html/paint.js';
import type { Box, BoxTree } from '../../src/html/layout/boxes.js';
import type { Element } from '../../src/html/index.js';

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

export async function render(
  source: string,
  width = 400,
  /** More of `<Html>`'s props: `animate`, say. */
  props: Record<string, unknown> = {},
) {
  const result = await renderX11(
    h(
      'box',
      { style: { width, flexDirection: 'column' } },
      h(Html, { source, partial: false, 'data-testname': 'doc', ...props }),
    ),
    FONTS
      ? { width: width + 40, height: 600, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  return { result, node: screen.getByTestName('doc') as DrawnNode };
}

export const metric = FONTS ? test : test.skip;

const HAS_P = '<div class="p" id="t"></div>';

/**
 * `:has()`s css-select reads otherwise than a browser, each with markup its
 * `#t` is matched in and markup it is not: with something in their argument
 * that compiles a selector of its own, and with an entry that starts at no
 * combinator and has one in it. Every row is what Chrome 152 answers, by
 * `matches()`, `querySelector()`, `closest()`, `querySelectorAll()` and a
 * computed style alike. All but the one with no combinator in its argument,
 * and those that say so, failed one side or the other before
 * `compileHoisted`.
 */
export const HAS_ARGUMENTS: readonly (readonly [string, string, string])[] = [
  ['.p:has(+ .a:not(.b))', '<div class="a"></div>', '<div class="a b"></div>'],
  [
    '.p:has(~ .a:not(.b))',
    '<i></i><div class="a"></div>',
    '<i></i><div class="a b"></div>',
  ],
  ['.p:has(+ :is(.a))', '<div class="a"></div>', '<div class="c"></div>'],
  [
    '.p:has(~ :where(.a, .b))',
    '<i></i><div class="b"></div>',
    '<i></i><div class="c"></div>',
  ],
  [
    '.p:has(+ .a > .b:not(.c))',
    '<div class="a"><i class="b"></i></div>',
    '<div class="a"><i class="b c"></i></div>',
  ],
  // css-select's aliases and `of`, which come to the same
  [
    '.p:has(+ input:checked)',
    '<input type="checkbox" checked />',
    '<input type="checkbox" />',
  ],
  ['.p:has(~ :disabled)', '<i></i><input disabled />', '<i></i><input />'],
  ['.p:has(+ a:any-link)', '<a href="#x">x</a>', '<a>x</a>'],
  [
    '.p:has(+ :nth-child(2 of .a))',
    `<i class="a"></i>${HAS_P}<i class="a"></i>`,
    `<i class="c"></i>${HAS_P}<i class="a"></i>`,
  ],
  // a selector in a function reads above the `:has()`'s element
  [
    '.p:has(+ .a:is(.x .a))',
    `<section class="x">${HAS_P}<div class="a"></div></section>`,
    `<section>${HAS_P}<div class="a"></div></section>`,
  ],
  [
    '.p:has(+ .a:not(.x .a))',
    `<section>${HAS_P}<div class="a"></div></section>`,
    `<section class="x">${HAS_P}<div class="a"></div></section>`,
  ],
  [
    '.p:has(> .a:is(.x .a))',
    '<section class="x"><div class="p" id="t"><b class="a"></b></div></section>',
    '<section><div class="p" id="t"><b class="a"></b></div></section>',
  ],
  [
    '.p:has(> .a:not(.x .a))',
    '<section><div class="p" id="t"><b class="a"></b></div></section>',
    '<section class="x"><div class="p" id="t"><b class="a"></b></div></section>',
  ],
  [
    '.p:has(.b .a:is(.x .a))',
    '<section class="x"><div class="p" id="t"><b class="b"><i class="a"></i></b></div></section>',
    '<section><div class="p" id="t"><b class="b"><i class="a"></i></b></div></section>',
  ],
  [
    '.p:has(.a:is(.x .a))',
    '<section class="x"><div class="p" id="t"><b class="a"></b></div></section>',
    '<section><div class="p" id="t"><b class="a"></b></div></section>',
  ],
  [
    '.p:has(+ .a:is(.x ~ .a))',
    `<i class="x"></i>${HAS_P}<div class="a"></div>`,
    `<i></i>${HAS_P}<div class="a"></div>`,
  ],
  // around it, and written as a selector can be
  [
    '.p:not(:has(+ .a:not(.b)))',
    '<div class="a b"></div>',
    '<div class="a"></div>',
  ],
  [
    '.p:has(+ .md\\:a:not(.md\\:b))',
    '<div class="md:a"></div>',
    '<div class="md:a md:b"></div>',
  ],
  [
    '.p:has(+ [data-x=":not(.b)"]:not(.b))',
    '<div data-x=":not(.b)"></div>',
    '<div data-x=":not(.b)" class="b"></div>',
  ],
  ['.p:HAS(+ .a:NOT(.b))', '<div class="a"></div>', '<div class="a b"></div>'],
  [
    '.p:has(+ .c, ~ .a:not(.b))',
    '<i></i><div class="a"></div>',
    '<i></i><div class="a b"></div>',
  ],
  [
    '.p:has(+ :is(.a, .x .b):not(.c))',
    `<section class="x">${HAS_P}<div class="b"></div></section>`,
    `<section class="x">${HAS_P}<div class="b c"></div></section>`,
  ],
  // what an entry with a combinator in it starts at is inside the element,
  // and css-select took the element for it, so a `.p` with a `.b` in it held
  insideHasRow('.p:has(.p .b)'),
  insideHasRow('.p:has(.p > .b)'),
  insideHasRow('.p:HAS(.p .b)'),
  insideHasRow('.p:has(.p .b, .c)'),
  insideHasRow('.p:has(.c, .p .b)'),
  insideHasRow('.p:has(.p:not(.c) .b)'),
  insideHasRow('.p:has(:is(.p, .c) .b)'),
  insideHasRow(':is(.p:has(.p .b))'),
  [
    '.p:has(.p .c .b)',
    '<div class="p" id="t"><u class="p"><s class="c"><i class="b"></i></s></u></div>',
    '<div class="p" id="t"><s class="c"><i class="b"></i></s></div>',
  ],
  [
    '.p:has(* .b)',
    '<div class="p" id="t"><u><i class="b"></i></u></div>',
    '<div class="p" id="t"><i class="b"></i></div>',
  ],
  [
    '.p:has(div > .b)',
    '<div class="p" id="t"><div><i class="b"></i></div></div>',
    '<div class="p" id="t"><i class="b"></i></div>',
  ],
  [
    '.p:has(:any-link .b)',
    '<div class="p" id="t"><a href="#x"><i class="b"></i></a></div>',
    '<a class="p" id="t" href="#x"><i class="b"></i></a>',
  ],
  [
    '.p:not(:has(.x .b))',
    '<div class="p x" id="t"><i class="b"></i></div>',
    '<div class="p x" id="t"><u class="x"><i class="b"></i></u></div>',
  ],
  // where one entry starts at a sibling, css-select looks there for all of
  // them, and the element is before what it finds
  [
    '.p:has(+ .c, .p + .b)',
    '<div class="p" id="t"><u class="p"></u><i class="b"></i></div>',
    '<div class="p" id="t"></div><i class="b"></i>',
  ],
  [
    '.p:has(~ .c, .p ~ .b)',
    '<div class="p" id="t"><u class="p"></u><s></s><i class="b"></i></div>',
    '<div class="p" id="t"></div><s></s><i class="b"></i>',
  ],
  // written as a selector can be, which a split at commas and combinators
  // does not cut
  [
    '.p:has(.md\\:a .b)',
    '<div class="p md:a" id="t"><u class="md:a"><i class="b"></i></u></div>',
    '<div class="p md:a" id="t"><i class="b"></i></div>',
  ],
  [
    '.p:has([data-x="a, b > c"] .b)',
    '<div class="p" id="t"><u data-x="a, b > c"><i class="b"></i></u></div>',
    '<div class="p" id="t" data-x="a, b > c"><i class="b"></i></div>',
  ],
  // these two held before as well: an `X` above the element is not inside
  // it, and a combinator after a comment is still where an entry starts
  [
    '.p:has(.x .b)',
    '<section><div class="p" id="t"><u class="x"><i class="b"></i></u></div></section>',
    '<section class="x"><div class="p" id="t"><i class="b"></i></div></section>',
  ],
  [
    '.p:has(/* x */ > .a .b)',
    '<div class="p" id="t"><u class="a"><i class="b"></i></u></div>',
    '<div class="p" id="t"><s><u class="a"><i class="b"></i></u></s></div>',
  ],
];

/** A row of `HAS_ARGUMENTS` for a selector that asks a `.p` for a `.p` with
 *  a `.b` in it. */
function insideHasRow(selector: string): readonly [string, string, string] {
  return [
    selector,
    '<div class="p" id="t"><u class="p"><i class="b"></i></u></div>',
    '<div class="p" id="t"><i class="b"></i></div>',
  ];
}

/** The colour a row of `HAS_ARGUMENTS` gives what it matches. */
export const HAS_MATCHED = 'rgb(0, 255, 0)';

/** `HAS_ARGUMENTS` as one document: each side of row `i` in a box of its
 *  own, `#y<i>` and `#n<i>`, its `#t` being `#y<i>t` and `#n<i>t`, and a rule
 *  in each box for its row. */
export function hasArgumentsDocument(): string {
  const side = (id: string, markup: string): string => {
    const held = markup.includes('id="t"') ? markup : HAS_P + markup;
    return `<div id="${id}">${held.replace('id="t"', `id="${id}t"`)}</div>`;
  };
  const rules = HAS_ARGUMENTS.map(
    ([selector], i) =>
      `#y${i} ${selector}, #n${i} ${selector} { color: ${HAS_MATCHED} }`,
  );
  const boxes = HAS_ARGUMENTS.map(
    ([, yes, no], i) => side(`y${i}`, yes) + side(`n${i}`, no),
  );
  return `<style>${rules.join('\n')}</style>${boxes.join('')}`;
}

/**
 * Mount `content` in a window whose frames are held to four a second, as a
 * display's clock holds one a vertical blank away, straight after a frame
 * has begun: the frame that lays `content` out comes a quarter of a second
 * after the render that mounts it, which no count of the event loop's turns
 * waits out. A probe box is laid out again first, and its report is that
 * frame.
 */
export async function mountBetweenFrames(
  content: React.ReactElement,
): Promise<void> {
  let step = (): void => {};
  let laid = 0;
  function Held() {
    const [at, setAt] = React.useState(0);
    step = () => setAt((n) => n + 1);
    return h(
      'window',
      { width: 440, height: 400, frameRate: 4 },
      h('box', {
        style: { width: 1 + at, height: 1 },
        // the width that frame laid out: core calls the handler of the
        // render it calls it after, which may be a step on
        onLayout: (ev: { width: number }) => void (laid = ev.width - 1),
      }),
      at >= 2 ? content : null,
    );
  }
  await renderX11(
    h(Held),
    FONTS ? { wrap: false, fonts: FONTS } : { wrap: false, backend: 'mock' },
  );
  await act(async () => step());
  while (laid < 1) await act(() => new Promise((r) => setTimeout(r, 5)));
  await act(async () => step());
}

/** What `SvgView` is to the stand-in below: the slice it wraps. */
interface ViewProto {
  draw(this: ViewThis, ...args: unknown[]): void;
  _renderElement(this: ViewThis, ...args: unknown[]): void;
  _bbox(this: ViewThis, ...args: unknown[]): unknown;
}
type ViewThis = {
  _viewport: [number, number];
  _standInObject?: ((el: unknown, ctx: unknown, box: unknown) => void) | null;
};
type ViewNode = { name: string; attribs: Record<string, string> };
type ViewContext = { save(): void; restore(): void; globalAlpha: number };

/**
 * ntk's `opts.foreignObject` on `SvgView.draw` — an object handed to the
 * caller where the drawing reaches it, in its user space, with its box and
 * its opacity, measured as its box, and SVG 1.1's `Extensibility` held in a
 * `<switch>`'s choice, sidorares/ntk#549 — for an ntk that has none, as
 * that change writes it, so a test sees what `<Html>` draws through it.
 * Installed until the test ends; on an ntk that has the hook nothing is
 * installed, and the test runs against ntk's. Delete it once the floor's
 * ntk carries the hook.
 */
export function withForeignObjects(t: { after(fn: () => void): void }): void {
  if (drawsForeignObjects()) return;
  const View = (ntk as unknown as { SvgView: { prototype: ViewProto } })
    .SvgView;
  const proto = View.prototype;
  const own = {
    draw: proto.draw,
    _renderElement: proto._renderElement,
    _bbox: proto._bbox,
  };
  const local = (name: string) =>
    name.slice(name.indexOf(':') + 1).toLowerCase();
  const attr = (node: ViewNode, name: string) =>
    node.attribs[name] ?? node.attribs[name.toLowerCase()];
  const length = (node: ViewNode, name: string, of: number) => {
    const v = String(attr(node, name) ?? '').trim();
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return 0;
    return v.endsWith('%') ? (n / 100) * of : n;
  };
  const boxOf = (node: ViewNode, [pw, ph]: [number, number]) => {
    const width = length(node, 'width', pw);
    const height = length(node, 'height', ph);
    return {
      x: length(node, 'x', pw),
      y: length(node, 'y', ph),
      width: width > 0 ? width : 0,
      height: height > 0 ? height : 0,
    };
  };
  const EXTENSIBILITY = 'http://www.w3.org/TR/SVG11/feature#Extensibility';
  proto.draw = function (this: ViewThis, ...args: unknown[]) {
    const opts = (args[5] ?? {}) as { foreignObject?: unknown };
    this._standInObject =
      typeof opts.foreignObject === 'function'
        ? (opts.foreignObject as ViewThis['_standInObject'])
        : null;
    try {
      own.draw.apply(this, args);
    } finally {
      this._standInObject = null;
    }
  };
  proto._renderElement = function (this: ViewThis, ...args: unknown[]) {
    const [node, ctx, style, alpha] = args as [
      ViewNode,
      ViewContext,
      { visibility: string },
      number,
    ];
    const name = local(node.name);
    const draw = this._standInObject;
    if (name === 'foreignobject') {
      if (!draw || style.visibility !== 'visible') return;
      const box = boxOf(node, this._viewport);
      if (!(box.width > 0 && box.height > 0)) return;
      ctx.save();
      try {
        ctx.globalAlpha = alpha;
        draw(node, ctx, { ...box, opacity: alpha });
      } finally {
        ctx.restore();
      }
      return;
    }
    // what a `<switch>` chooses among, with `#Extensibility` holding,
    // while it chooses
    const taken: [ViewNode, string, string][] = [];
    if (name === 'switch' && draw) {
      for (const child of (node as unknown as { children: ViewNode[] })
        .children) {
        if (!child.attribs) continue;
        for (const key of ['requiredFeatures', 'requiredfeatures']) {
          const value = child.attribs[key];
          if (value === undefined || !value.includes(EXTENSIBILITY)) continue;
          taken.push([child, key, value]);
          const rest = value
            .split(/\s+/)
            .filter((f) => f && f !== EXTENSIBILITY)
            .join(' ');
          if (rest) child.attribs[key] = rest;
          else delete child.attribs[key];
        }
      }
    }
    try {
      own._renderElement.apply(this, args);
    } finally {
      for (const [child, key, value] of taken) child.attribs[key] = value;
    }
  };
  proto._bbox = function (this: ViewThis, ...args: unknown[]) {
    const node = args[0] as ViewNode;
    if (local(node.name) !== 'foreignobject') {
      return own._bbox.apply(this, args);
    }
    const { x, y, width, height } = boxOf(node, this._viewport);
    return { x, y, w: width, h: height };
  };
  t.after(() => Object.assign(proto, own));
}

/** The text a document's boxes hold, generated content included. */
export async function documentText(source: string): Promise<string> {
  const { node } = await render(source, 300);
  return drawnText(view(node));
}

/** The text an element draws, generated content included: `textContent()`
 *  is what a selection can take, which leaves `user-select: none` out. */
export function drawnText(el: HtmlViewNode): string {
  return (el as unknown as { _tree: { text: string } })._tree.text;
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
  | {
      op: 'text';
      x: number;
      y: number;
      shadow?: Fill['shadow'];
      /** The matrix the layout was drawn under, where `transform` set one. */
      matrix?: number[];
    };

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
    /** Which of a scroll container's bars a page's rules hide. */
    scrollbarHidden?: () => { x: boolean; y: boolean };
    /** A context whose radial gradients are one colour. */
    flatRadial?: boolean;
    /** A context that draws text through its matrix: react-x11's macOS and
     *  Windows one. */
    scalesText?: boolean;
    /** A context whose surfaces cost about the same drawn under an alpha:
     *  react-x11's macOS one over a bridge that scales them. */
    fadesSurfacesCheaply?: boolean;
    /** A paint of a drag of the window's edge (`DragPaint`). */
    drag?: {
      cheap: boolean;
      moved(layer: object, width: number, height: number): boolean;
      paused(box: never): boolean;
      drawn(): void;
    };
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
  if (options?.scalesText) (ctx as { scalesText?: boolean }).scalesText = true;
  if (options?.fadesSurfacesCheaply) {
    (ctx as { fadesSurfacesCheaply?: boolean }).fadesSurfacesCheaply = true;
  }
  for (const layout of layouts) {
    (layout as { draw: unknown }).draw = (_: unknown, x: number, y: number) => {
      const shadow = shadowOf();
      ops?.push({
        op: 'text',
        x,
        y,
        ...(shadow ? { shadow } : null),
        ...(matrix ? { matrix } : null),
      });
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
  /** More of `<Html>`'s props. */
  props: Record<string, unknown> = {},
) {
  const doc = (height: number, width: number) =>
    h(
      'box',
      { style: { width, height, flexDirection: 'column' } },
      h(
        'box',
        { style: { flexGrow: 1, overflow: 'scroll' } },
        h(Html, { source, partial: false, 'data-testname': 'doc', ...props }),
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
  return { el, resize, result };
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

/** A fill `pathsOf` saw: its outlines, by its rule, in the clips then in
 *  force, each by the rule beside it in `clipRules`. */
export interface PathFill {
  style: unknown;
  rule: string;
  outlines: Outline[];
  clips: Outline[][];
  clipRules: string[];
  shadow?: Fill['shadow'];
}

/** What a paint of the part of the document `damage` names fills and clips
 *  to, in order, each path as the outlines it is made of — so that where a
 *  shape reaches can be asked of any point (`windingAt`), whatever mix of
 *  rectangles, rounded rectangles and curves drew it. A fill carries the
 *  clips it was made in and the context's shadow, where it had a blur. An
 *  image is drawn as nothing, so `backgroundImageFor` is there for the clip
 *  it is drawn in. */
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
  fills: PathFill[];
  clips: Outline[][];
}> {
  const { paintDocument } = await import('../../src/html/paint.js');
  const fills: PathFill[] = [];
  const clips: Outline[][] = [];
  let outlines: Outline[] = [];
  // the clips in force and their rules, and what a save keeps of them and
  // of the shadow
  let clipped: Outline[][] = [];
  let clipRules: string[] = [];
  const saved: [Outline[][], string[], string, number, number, number][] = [];
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
  const fill = (rule: string, filled: Outline[]): void => {
    fills.push({
      style: ctx.fillStyle,
      rule,
      outlines: filled,
      clips: clipped,
      clipRules,
      ...(ctx.shadowBlur > 0
        ? {
            shadow: {
              color: ctx.shadowColor,
              blur: ctx.shadowBlur,
              x: ctx.shadowOffsetX,
              y: ctx.shadowOffsetY,
            },
          }
        : null),
    });
  };
  const ctx = {
    fillStyle: null as unknown,
    shadowColor: 'rgba(0, 0, 0, 0)',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    save() {
      saved.push([
        clipped,
        clipRules,
        ctx.shadowColor,
        ctx.shadowBlur,
        ctx.shadowOffsetX,
        ctx.shadowOffsetY,
      ]);
    },
    restore() {
      const state = saved.pop();
      if (state) {
        [
          clipped,
          clipRules,
          ctx.shadowColor,
          ctx.shadowBlur,
          ctx.shadowOffsetX,
          ctx.shadowOffsetY,
        ] = state;
      }
    },
    fillRect(x: number, y: number, w: number, h: number) {
      const rect: Outline = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ];
      fill('nonzero', [rect]);
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
      fill(rule ?? 'nonzero', outlines);
      outlines = [];
    },
    clip(rule?: string) {
      clips.push(outlines);
      clipped = [...clipped, outlines];
      clipRules = [...clipRules, rule ?? 'nonzero'];
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

/** A PNG of one colour, `width` by `height`. */
export function solidPng(
  width: number,
  height: number,
  colour: [number, number, number],
): Uint8Array {
  return pixelsPng(width, height, () => colour);
}

/** A PNG whose pixel at (`x`, `y`) is `at`'s colour for it. */
export function pixelsPng(
  width: number,
  height: number,
  at: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const rows = Buffer.concat(
    Array.from({ length: height }, (_, y) => {
      const row = Buffer.alloc(1 + width * 3);
      for (let x = 0; x < width; x += 1) row.set(at(x, y), 1 + x * 3);
      return row;
    }),
  );
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    let crc = ~0;
    for (const byte of body) {
      crc ^= byte;
      for (let k = 0; k < 8; k += 1)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(~crc >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

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
  /** A `::before`'s or an `::after`'s, which has no element of its own. */
  pseudo?: string | null;
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

/** The corners of a rect, clockwise from its top left. */
export function cornersOf(r: {
  x: number;
  y: number;
  width: number;
  height: number;
}): [number, number][] {
  return [
    [r.x, r.y],
    [r.x + r.width, r.y],
    [r.x + r.width, r.y + r.height],
    [r.x, r.y + r.height],
  ];
}

/** Where a sprite's layer puts the corners of its rect in the window: its
 *  matrix — `m`, or the one it rests at — about its origin, and over the w
 *  it comes to where it is a `matrix3d()`. */
export function layerCorners(
  sprite: {
    rect: { x: number; y: number; width: number; height: number };
    origin?: { x: number; y: number };
    transform?: readonly number[];
  },
  m: readonly number[] = sprite.transform ?? [1, 0, 0, 1, 0, 0],
): [number, number][] {
  const { x: ox, y: oy } = sprite.origin!;
  return cornersOf(sprite.rect).map(([x, y]) => {
    const dx = x - ox;
    const dy = y - oy;
    if (m.length !== 16) {
      return [
        m[0] * dx + m[2] * dy + m[4] + ox,
        m[1] * dx + m[3] * dy + m[5] + oy,
      ];
    }
    const w = m[3] * dx + m[7] * dy + m[15];
    return [
      (m[0] * dx + m[4] * dy + m[12]) / w + ox,
      (m[1] * dx + m[5] * dy + m[13]) / w + oy,
    ];
  });
}

/** Where the document draws the corners of an element's box in the window:
 *  through the matrix, or the projection, it paints the box through
 *  (`placedMatrix`). */
export function drawnCorners(el: HtmlViewNode, id: string): [number, number][] {
  const box = boxOf(el, id) as unknown as Box;
  const placed = placedMatrix(box);
  const abs = (el as unknown as DrawnNode).abs;
  return cornersOf(box).map(([x, y]) => {
    const [px, py] = placed ? mapPoint(placed, x, y) : [x, y];
    return [px + abs.x, py + abs.y];
  });
}

/** Whether two lists of points are the same, each to within `by`. */
export function samePoints(
  a: readonly (readonly [number, number])[],
  b: readonly (readonly [number, number])[],
  by = 1e-6,
): boolean {
  return (
    a.length === b.length &&
    a.every(
      ([x, y], i) => Math.abs(x - b[i][0]) <= by && Math.abs(y - b[i][1]) <= by,
    )
  );
}

export type ReplacedBox = LaidBox & { kind: string; replaced: string };

/** Render with each image URL answered from `images`, as bytes. */
export async function renderWithBytes(
  source: string,
  images: Record<string, Uint8Array>,
  width = 400,
  /** The display's, as `atScale2` sets it. */
  scale = 1,
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
      ? {
          width: width + 40,
          height: 400,
          fonts: FONTS,
          ...(scale !== 1 && { scale }),
        }
      : { backend: 'mock' as const },
  );
  const el = view(screen.getByTestName('doc') as DrawnNode);
  await imagesIn(el);
  return { result, el };
}

/**
 * Wait for every image the document asked for to arrive or fail. A PNG or
 * a JPEG long enough decodes on a worker thread (`offThread`, core's
 * `decodeImageBytes`), and lands a task or more after the render, which no
 * `act()` waits for.
 */
export async function imagesIn(el: HtmlViewNode): Promise<void> {
  const store = (el as unknown as { _resources: { pending: number } })
    ._resources;
  for (let i = 0; i < 1000 && store.pending > 0; i += 1) {
    await new Promise((done) => setTimeout(done, 2));
  }
  await act();
}

/** Render on the mock backend at a display scale, each image URL answered
 *  from `images` at once, and every image URL asked for in `asked`, in the
 *  order asked. */
export async function renderAsking(
  source: string,
  images: Record<string, Uint8Array>,
  scale = 1,
) {
  const asked: string[] = [];
  await renderX11(
    h(
      'box',
      { style: { width: 400, flexDirection: 'column' } },
      h(Html, {
        source,
        partial: false,
        'data-testname': 'doc',
        onResource: (r: { url: string; kind: string }) => {
          if (r.kind !== 'image') return null;
          asked.push(r.url);
          const bytes = images[r.url];
          return bytes ? { kind: 'image' as const, bytes } : null;
        },
      }),
    ),
    { backend: 'mock', ...(scale !== 1 && { scale }) },
  );
  await act();
  return { asked, el: view(screen.getByTestName('doc') as DrawnNode) };
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

/** What a document 700px wide fills in one colour, each as its `[x, y,
 *  width, height]`, in the order drawn: a container's gap rules. */
export async function rulesIn(
  source: string,
  color: string,
): Promise<[number, number, number, number][]> {
  const { node } = await render('<style>body{margin:0}</style>' + source, 700);
  const ink = parseColor(color);
  return (await fillsOf(view(node)))
    .filter((f) => f.style === ink)
    .map((f) => [f.x, f.y, f.w, f.h]);
}

/** The fills a document's boxes paint, of one colour. */
export async function fillsIn(source: string, color: string): Promise<Fill[]> {
  const { node } = await render('<style>body{margin:0}</style>' + source);
  const ink = parseColor(color);
  return (await fillsOf(view(node))).filter((f) => f.style === ink);
}

/** The element's pixels, as the server has them. */
export async function snapshot(
  result: Awaited<ReturnType<typeof render>>['result'],
  el: HtmlViewNode,
): Promise<Uint8ClampedArray> {
  const { abs } = el as unknown as DrawnNode;
  await act();
  return new Promise((ok, fail) =>
    (
      result.ctx as unknown as {
        getImageData(
          x: number,
          y: number,
          w: number,
          h: number,
          cb: (e: unknown, d: { data: Uint8ClampedArray }) => void,
        ): void;
      }
    ).getImageData(abs.x, abs.y, abs.width, abs.height, (e, d) =>
      e ? fail(e) : ok(d.data),
    ),
  );
}

/** What a document built again from its sheets draws: what a change made
 *  in place has to come to. */
export async function rebuilt(
  result: Awaited<ReturnType<typeof render>>['result'],
  el: HtmlViewNode,
): Promise<Uint8ClampedArray> {
  (el as unknown as { _invalidate(stale: number): void })._invalidate(2);
  return snapshot(result, el);
}

/** How many bytes two snapshots differ in. An assertion on the arrays
 *  themselves diffs them when it fails, and a page of pixels diffed runs
 *  the test process out of memory before it says anything. */
export function bytesApart(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = Math.abs(a.length - b.length);
  const end = Math.min(a.length, b.length);
  for (let i = 0; i < end; i += 1) if (a[i] !== b[i]) n += 1;
  return n;
}

/** The box tree, to tell a restyle in place from a document built again. */
export const treeOf = (el: HtmlViewNode) =>
  (el as unknown as { _tree: unknown })._tree;

/** A logical window point inside an element of the document. */
export function pointIn(el: HtmlViewNode, id: string): [number, number] {
  const target = findById(el.document, id)!;
  const rect = el.elementRect(target)!;
  const { abs } = el as unknown as DrawnNode;
  return [abs.x + rect.x + rect.width / 2, abs.y + rect.y + rect.height / 2];
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

export function pathOf(el: Element | null | undefined): string {
  if (!el) return '-';
  const steps: number[] = [];
  for (let at: Element = el; at.parent; at = at.parent as Element) {
    steps.push((at.parent as Element).children.indexOf(at));
  }
  return steps.reverse().join('.');
}

/** A number to a thousandth, off the grid's halves: a sum in a kept box's
 *  place comes out a last bit from the same sum in a new one's, and on a
 *  half that is two thousandths — 390.9775 and 390.97749999999996, seed 364
 *  of the image sweep — where half thousandths are what line heights come
 *  to. */
const thousandths = (n: number): number => Math.round(n * 1000 + 0.2137) / 1000;

/** What a box says of itself that two builds must agree on. */
function boxLine(box: Box): string {
  const s = box.style;
  const el = box.el ?? GENERATED_FROM.get(box);
  return [
    box.kind,
    pathOf(el),
    box.pseudo ?? '',
    JSON.stringify(box.text),
    `${box.textStart}-${box.textEnd}`,
    `${box.subtreeTextStart}-${box.subtreeTextEnd}`,
    // a text's, a break's or an inline box's rect is never laid out, and
    // `translate` moves it with the rest, pass after pass
    box.kind === 'text' || box.kind === 'break' || box.kind === 'inline'
      ? ''
      : // to a thousandth of a pixel: Yoga's sizes are float32, and one a
        // kept box's layout measured comes out a last bit or two apart
        [box.x, box.y, box.width, box.height].map(thousandths).join(','),
    s.display,
    s.position,
    s.float,
    s.color,
    s.fontFamily,
    s.fontSize,
    s.whiteSpace,
    s.userSelect,
    box.marker?.layout ? box.marker.layout.width : '',
    box.outOfFlow ? 'out' : '',
    box.isFloat ? 'float' : '',
    // the size an image's box took, in place or as it was built
    box.intrinsic ? JSON.stringify(box.intrinsic) : '',
    // and where it inks, which a block a layout kept is walked for again;
    // a text's is its line's
    box.kind === 'text' || box.kind === 'break'
      ? ''
      : [box.boundsX, box.boundsY, box.boundsWidth, box.boundsHeight]
          .map(thousandths)
          .join(','),
    box.lines?.length ?? '',
    // a list item's number
    box.marker ? JSON.stringify(box.marker.text) : '',
    // where its lines and the text on them are drawn, which a block kept
    // from an earlier layout carries with it
    (box.lines ?? [])
      .map((line) =>
        [
          line.x,
          line.y,
          line.width,
          line.height,
          line.baseline,
          ...line.texts.flatMap((t) => [t.drawX, t.drawY]),
        ]
          .map(thousandths)
          .join(','),
      )
      .join(';'),
    // and which of the document's text is on them, which a build of what is
    // before a kept block moves: what a selection and a hit test read
    (box.lines ?? [])
      .map((line) =>
        [
          line.textStart,
          line.textEnd,
          ...line.texts.flatMap((t) => [
            t.textStart,
            t.textEnd,
            t.spans.documentAt(t.layoutStart),
          ]),
        ].join(','),
      )
      .join(';'),
  ].join('|');
}

/** The elements the UA's sheet never draws, whose styles a build that
 *  restyles what a change reached may leave out. */
const UNDRAWN = [
  'script',
  'style',
  'link',
  'meta',
  'title',
  'base',
  'template',
];

/** A tree as two builds of one document must have it alike. */
export function treeLines(tree: BoxTree): string[] {
  const out: string[] = [];
  const order = new Map<Box, number>();
  const walk = (box: Box, depth: number) => {
    order.set(box, order.size);
    out.push(`${' '.repeat(depth)}${boxLine(box)}`);
    for (const child of box.children) walk(child, depth + 1);
  };
  walk(tree.root, 0);
  // the order the document paints its layers in, which nothing above reads:
  // each box by its place in the tree, so that two builds' boxes compare
  const places = (list: readonly Box[]): string =>
    list.map((b) => order.get(b) ?? 'gone').join(',');
  for (const [box, at] of order) {
    const { above, below, clips, lines } = stackingOf(box);
    if (!above.length && !below.length && !clips.length && !lines) continue;
    out.push(
      `layers of ${at}: ${places(above)} below ${places(below)}` +
        ` clips ${places(clips)} lines ${lines}`,
    );
  }
  out.push(`top layer: ${places(topLayerBoxes(tree.root))}`);
  const boxes = (name: string, list: readonly Box[]) =>
    out.push(
      `${name}: ${list.map((b) => boxLine(b).split('|').slice(0, 3).join('|')).join(' ')}`,
    );
  boxes('textBoxes', tree.textBoxes);
  boxes('controls', tree.controls);
  boxes('links', tree.links);
  boxes('focusables', tree.focusables);
  boxes('backgrounds', tree.backgrounds);
  boxes('images', tree.images);
  boxes('awaiting', tree.awaiting);
  // a set: nothing reads it in order, and a splice lists an element's
  // `::after` by the element, where a build lists it after what that holds
  out.push(
    `contentImages: ${tree.contentImages
      .map((c) => `${c.url}@${pathOf(c.element)}:${c.sized}`)
      .sort()
      .join(' ')}`,
  );
  out.push(`awaitingKind: ${tree.awaitingKind.map(pathOf).join(' ')}`);
  out.push(`text: ${JSON.stringify(tree.text)}`);
  out.push(`unselectable: ${tree.unselectable.join(',')}`);
  out.push(
    `textNodes: ${(tree.textNodes ?? [])
      .map((t) => `${JSON.stringify(t.node.data)}@${t.start}-${t.end}`)
      .join(' ')}`,
  );
  out.push(
    // but for what is never drawn, which a restyle in place leaves out
    `styles: ${[...tree.styles]
      .filter(([el]) => !UNDRAWN.includes(el.name))
      .map(
        ([el, { style, inFlex }]) =>
          `${pathOf(el)}:${style.display}:${style.color}:${inFlex}`,
      )
      .join(' ')}`,
  );
  return out;
}
