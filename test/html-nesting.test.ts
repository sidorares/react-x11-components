// Deeply nested documents. A box that sizes itself to its content — a flex
// item, a float, an inline-block, an absolute box — lays that content out to
// measure it, and nested, every level laid out the whole of what was under
// it again: twelve flex boxes took two seconds, and a hundred floats, the
// markup of a page with unclosed tags, never finished. What each case here
// counts is what that multiplied — the layouts of a box, the heights a
// float is tried at — and holds it to a bound that grows with the depth, if
// at all, rather than as a power of it. Counted, a loaded machine gets the
// answer an idle one does; and the count ends a layout at the first box
// past its bound, so a regression is a test that fails, not one that never
// ends.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';
import { renderX11, cleanup, screen } from 'react-x11/test';

import { Html } from '../src/index.js';
import { HtmlSource } from '../src/html/dom.js';
import type { Element } from '../src/html/dom.js';
import { FloatContext } from '../src/html/layout/floats.js';

afterEach(cleanup);

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];
const font = FONT_CANDIDATES.find((path) => existsSync(path));
const FONTS = font ? { 'sans-serif': font } : null;

/**
 * Mount a document. `hidden`, in a box that is not displayed, so nothing
 * lays it out until the test does: a count that is to stop a layout past
 * its bound has to be there for the first one, and with the fix it guards
 * taken out, the mount's own layout was the one that never ended.
 */
async function render(source: string, hidden = false) {
  await renderX11(
    React.createElement(
      'box',
      {
        style: {
          width: 600,
          flexDirection: 'column',
          ...(hidden ? { display: 'none' as const } : null),
        },
      },
      React.createElement(Html, { source, 'data-testname': 'doc' }),
    ),
    FONTS
      ? { width: 640, height: 400, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  return (screen.getByTestName('doc') as unknown as { children: unknown[] })
    .children[0] as TestNode;
}

/** The node's pipeline, as the tests drive it. */
interface TestNode {
  _stale: number;
  _prepare(width: number): void;
  _tree: { root: Laid } | null;
}

interface Laid {
  kind: string;
  x: number;
  width: number;
  height: number;
  children: Laid[];
  el: Element | null;
  layoutSerial: number;
  boundsX: number;
}

/** A document `depth` elements deep, each opened with `open`. */
function nested(open: string, close: string, depth: number): string {
  return open.repeat(depth) + 'Some text in the middle' + close.repeat(depth);
}

/** A layout of a fresh box tree, nothing kept. */
function coldLayout(node: Awaited<ReturnType<typeof render>>): void {
  node._stale = 2;
  node._prepare(600);
}

/** What a cold layout did to a box: how many of the boxes counted it is
 *  inside, how many times it was laid out, and how many times its paint
 *  bounds were taken. */
interface Counted {
  depth: number;
  layouts: number;
  bounds: number;
}

/** What a count throws to end a layout past its bound. */
const STOPPED = 'the count stopped the layout';

/**
 * A cold layout that a count may end by throwing: the node takes the throw
 * as a document it cannot lay out, leaves it blank and says so, and what
 * it says is kept out of the log. Anything else it says is a failure.
 */
function countedLayout(node: Awaited<ReturnType<typeof render>>): void {
  const errors: string[] = [];
  const g = globalThis as unknown as { console: { error(m: string): void } };
  const error = g.console.error;
  g.console.error = (m: string) => errors.push(m);
  try {
    coldLayout(node);
  } finally {
    g.console.error = error;
  }
  assert.ok(
    errors.every((m) => m.includes(STOPPED)),
    `the layout threw: ${errors.join('\n')}`,
  );
}

/**
 * How many times a cold layout lays out each box `which` picks, and takes
 * its paint bounds. Counted where every layout of a box is: `layoutBox`
 * numbers the box it lays out (`Box.layoutSerial`), and it is the only
 * caller of `layoutTable`; and `computePaintBounds` writes a box's
 * `boundsX` once each time it walks it. The boxes are the fresh tree's,
 * counted from when the node is handed it, before anything lays it out.
 *
 * A box counted past `most` of either, for its depth, ends the layout
 * there (`countedLayout`): what these guard against was exponential, and
 * counted to the end, a regression would still be a test that never ends.
 */
function coldLayouts(
  node: Awaited<ReturnType<typeof render>>,
  which: (box: Laid) => boolean,
  most: (depth: number) => number,
): Counted[] {
  let counts: Counted[] = [];
  const counter = (
    box: Laid,
    seen: Counted,
    key: 'layoutSerial' | 'boundsX',
    field: 'layouts' | 'bounds',
  ): void => {
    let value = box[key];
    Object.defineProperty(box, key, {
      get: () => value,
      set: (next: number) => {
        value = next;
        seen[field] += 1;
        if (seen[field] > most(seen.depth)) {
          throw new Error(`${STOPPED}: ${said(seen, field)}`);
        }
      },
    });
  };
  const count = (box: Laid, depth: number): void => {
    const picked = which(box);
    if (picked) {
      const seen = { depth, layouts: 0, bounds: 0 };
      counts.push(seen);
      counter(box, seen, 'layoutSerial', 'layouts');
      counter(box, seen, 'boundsX', 'bounds');
    }
    for (const child of box.children) count(child, picked ? depth + 1 : depth);
  };
  let tree = node._tree;
  Object.defineProperty(node, '_tree', {
    get: () => tree,
    set: (value: TestNode['_tree']) => {
      tree = value;
      // blank, where the count ended the layout: the tree it counted stays
      if (!value) return;
      counts = [];
      count(value.root, 0);
    },
    configurable: true,
  });
  try {
    countedLayout(node);
  } finally {
    Object.defineProperty(node, '_tree', { value: tree, writable: true });
  }
  return counts;
}

/** That no box was counted past `most` of `field`, or not at all: the
 *  first that was is the failure's message. The count may have ended the
 *  layout before it came to a box (`coldLayouts`), which is not the box
 *  to name. */
function within(
  counts: Counted[],
  field: 'layouts' | 'bounds',
  most: (depth: number) => number,
): void {
  const box =
    counts.find((c) => c[field] > most(c.depth)) ??
    counts.find((c) => c[field] < 1);
  if (box) assert.fail(said(box, field));
}

function said(box: Counted, field: 'layouts' | 'bounds'): string {
  const what = field === 'layouts' ? 'was laid out' : 'had its bounds taken';
  return `the one ${box.depth} deep ${what} ${box[field]} times`;
}

/**
 * How many heights each float a cold layout places is tried at, in the
 * order they are placed: the calls `FloatContext.placeAt` makes to
 * `_fits`, which is asked whether a float fits at a height, and by nothing
 * else. A float tried at more than `most` ends the layout there
 * (`countedLayout`).
 */
function coldPlacements(
  node: Awaited<ReturnType<typeof render>>,
  most: number,
): number[] {
  const proto = FloatContext.prototype as unknown as {
    placeAt(...args: unknown[]): number;
    _fits(...args: unknown[]): boolean;
  };
  const { placeAt, _fits: fits } = proto;
  const placed: number[] = [];
  proto.placeAt = function (this: unknown, ...args: unknown[]) {
    placed.push(0);
    return placeAt.apply(this, args);
  };
  proto._fits = function (this: unknown, ...args: unknown[]) {
    const tried = (placed[placed.length - 1] += 1);
    if (tried > most) {
      throw new Error(`${STOPPED}: float ${placed.length - 1} tried ${tried}`);
    }
    return fits.apply(this, args);
  };
  try {
    countedLayout(node);
  } finally {
    proto.placeAt = placeAt;
    proto._fits = fits;
  }
  return placed;
}

// The one k deep in a flex box or a grid is laid out whenever the one
// around it is, and to be measured besides, the once in its life: at its
// max-content width in a flex box, and at its min- and max-content widths
// in a grid — k + 1 times, and 2k + 1. A float, an inline-block and an
// absolute box laid out again at a width they already have are kept, and
// come to two or three at any depth. Measured at every layout of the box
// around them, as before #235 and #238, the one k deep was laid out 2^k or
// 3^k times.
for (const [kind, open, close, most] of [
  ['flex boxes', '<div style="display:flex">', '</div>', (k: number) => k + 1],
  ['grids', '<div style="display:grid">', '</div>', (k: number) => 2 * k + 1],
  ['floats', '<div style="float:left">', '</div>', () => 3],
  ['inline-blocks', '<div style="display:inline-block">', '</div>', () => 3],
  ['absolute boxes', '<div style="position:absolute">', '</div>', () => 3],
] as const) {
  test(`forty nested ${kind} are laid out a number of times linear in their depth`, async () => {
    const node = await render(nested(open, close, 40), true);
    const divs = coldLayouts(
      node,
      (box) => box.kind !== 'text' && box.el?.name === 'div',
      most,
    );
    assert.strictEqual(divs.length, 40, 'every level counted');
    within(divs, 'layouts', most);
    // and its paint bounds are taken once: an inline-block's were taken
    // from its line as well as from its parent, twice a level
    within(divs, 'bounds', () => 1);
    // and it is a layout: the innermost element's box holds the text
    const element = (c: Laid) => c.el !== null && c.kind !== 'text';
    let box = node._tree!.root;
    let depth = 0;
    while (box.children.some(element)) {
      box = box.children.find(element)!;
      depth += 1;
    }
    assert.ok(depth >= 40, `${depth} levels`);
    assert.ok(box.width > 0, 'the text has room');
  });
}

// A flex item that is a flex box itself is laid out again in the height
// the flex layout gave it — its line's, stretched across a row (CSS Flexbox
// 9.4, step 11), or what a column flexed it to (9.7) — and so is what it
// stretches or flexes in turn. Each is laid out for its content's height,
// the once, and then at every height the ones around it come to. With what
// is in a box laid out for its content's height again at each of those,
// the one k deep was laid out 2^k times.
for (const [kind, build, most] of [
  [
    // a row of a card and a taller box beside it, the card a column of one
    // such row that takes its height, and so on down
    'cards stretched',
    (inner: string, k: number) =>
      '<div style="display:flex;flex:1">' +
      `<div style="width:10px;height:${600 - 20 * k}px"></div>` +
      '<div class="card" style="display:flex;flex-direction:column;flex:1">' +
      `${inner}</div></div>`,
    // each row comes to its height as the ones around it are laid out: one
    // more a level
    (k: number) => k + 2,
  ],
  [
    // a column that takes the height of the column it is in, down from
    // one whose own is its least, and no definite height
    'columns flexed',
    (inner: string, k: number) =>
      (k
        ? ''
        : '<div style="display:flex;flex-direction:column;' +
          'min-height:600px">') +
      '<div class="card" style="display:flex;flex-direction:column;flex:1">' +
      `${inner}</div>${k ? '' : '</div>'}`,
    // the height comes down from the top, the once
    () => 2,
  ],
] as const) {
  test(`twelve ${kind} one inside another are laid out a number of times linear in their depth`, async () => {
    const depth = 12;
    let html = '<p>Some text in the middle</p>';
    for (let k = depth - 1; k >= 0; k -= 1) html = build(html, k);
    const node = await render(html, true);
    const cards = coldLayouts(
      node,
      (box) => box.el?.attribs.class === 'card',
      most,
    );
    assert.strictEqual(cards.length, depth, 'every card counted');
    within(cards, 'layouts', most);
    // and it is a layout: every card as tall as the outermost box
    const heights: number[] = [];
    const walk = (box: Laid): void => {
      if (box.el?.attribs.class === 'card') heights.push(box.height);
      box.children.forEach(walk);
    };
    walk(node._tree!.root);
    assert.deepStrictEqual(heights, new Array(depth).fill(600));
  });
}

test('a box laid out again is where its last layout put it, not at infinity', async () => {
  // A table measures its cell at no width limit, where a right float
  // stands at an infinite x; a layout kept for reuse and moved back from
  // there came out at NaN (WPT floats-wrap-bfc-001-right-overflow)
  const node = await render(
    '<table width="300" style="border-spacing:0"><tr><td style="padding:0">' +
      '<div id="f" style="float:right;width:100px;height:100px"></div>' +
      '<div style="overflow:hidden"><span style="display:inline-block;' +
      'width:150px;height:50px"></span></div></td></tr></table>',
  );
  const find = (box: Laid): Laid | null => {
    if (box.el?.attribs.id === 'f') return box;
    for (const child of box.children) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  const float = find(node._tree!.root)!;
  assert.ok(Number.isFinite(float.x), `x ${float.x}`);
  assert.ok(float.x > 150, 'at the right of its cell');
});

test('two thousand floats in rows are each tried at a height or two', async () => {
  // each went up into any gap the rows above it left, and so walked the
  // bottom of every float above its own row: two thousand floated
  // thumbnails took six seconds
  const node = await render(
    '<div>' +
      '<span style="float:left;width:20px;height:20px"></span>'.repeat(2000) +
      '</div>',
    true,
  );
  // No higher than the float before it (CSS 2.1 9.5.1, rule 5), a float is
  // tried where that one stands, and the first of a row at the bottom of
  // the row above as well; and a row's floats end at one height, tried the
  // once. Tried from the top at every float's bottom, as before #238, one
  // in the thirtieth row was tried at some eight hundred.
  const placed = coldPlacements(node, 2);
  const over = placed.findIndex((heights) => heights < 1 || heights > 2);
  assert.ok(over < 0, `float ${over} was tried at ${placed[over]} heights`);
  assert.strictEqual(placed.length, 2000, 'every float placed, the once');
});

test('a nest of right floats lays out what it holds once, not once a level', async () => {
  // Measured at no width limit, a right float stands at an infinite x, and
  // its box went there: nothing in it could be moved back, so it was all
  // laid out again at its next layout — the floats in the innermost once a
  // level, and a page of 250 levels around 4,000 of them took 24 seconds
  const node = await render(
    '<span style="float:right">'.repeat(100) +
      '<span style="float:right">x</span>'.repeat(2000) +
      '</span>'.repeat(100),
    true,
  );
  // A float in the nest is laid out four times and one in the innermost
  // twice, at any depth. Put at infinity, the innermost 2,000 were laid out
  // again at every level: `placeFloat` puts it where the float context
  // does not (#238), and `moveTo` refuses to since (#264).
  const spans = coldLayouts(
    node,
    (box) => box.kind !== 'text' && box.el?.name === 'span',
    () => 4,
  );
  assert.strictEqual(spans.length, 2100, 'every float counted');
  within(spans, 'layouts', () => 4);
});

test('flex boxes past sixty-four deep are laid out as blocks, not thrown', async () => {
  // each runs its Yoga pass inside the measure of the one around it, and
  // Yoga's own stack ran out at about a hundred and fifty: a RuntimeError
  // out of the layout, and of the application's paint
  const node = await render(
    nested('<div style="display:flex">', '</div>', 200),
  );
  assert.ok(node._tree, 'laid out');
  coldLayout(node);
  assert.ok(node._tree, 'and again');
});

test('a document nests no deeper than 256 elements, as a browser has it', () => {
  // past that, what is opened goes into the element at the limit: the
  // stack a thousand unclosed <div>s ran every walk of the document down
  const source = new HtmlSource();
  source.setSource(nested('<div>', '</div>', 1000), true);
  let deepest = 0;
  const walk = (node: { children?: unknown[] }, depth: number): void => {
    deepest = Math.max(deepest, depth);
    for (const child of (node.children ?? []) as { children?: unknown[] }[]) {
      walk(child, depth + 1);
    }
  };
  walk(source.document as unknown as { children?: unknown[] }, 0);
  assert.ok(deepest <= 258, `${deepest} deep`);
  // and nothing is lost: all thousand elements and the text are there
  const text = JSON.stringify(
    (source.document as unknown as { children: unknown[] }).children,
    (key, value) =>
      key === 'parent' || key === 'prev' || key === 'next' ? undefined : value,
  );
  assert.ok(text.includes('Some text in the middle'), 'the text is there');
  let divs = 0;
  const count = (node: { name?: string; children?: unknown[] }): void => {
    if (node.name === 'div') divs += 1;
    for (const child of (node.children ?? []) as { name?: string }[]) {
      count(child);
    }
  };
  count(source.document as unknown as { children?: unknown[] });
  assert.strictEqual(divs, 1000, 'every element is there');
});

test('a table asked for again at the same width is not laid out again', async () => {
  // A table in a table's cell is laid out as the cell is, and the cell as
  // its table is, and every level lays out all of what it holds again:
  // a hundred nested tables around five hundred more took a second. Asked
  // at a width it was laid out at in this pass, with nothing laid out over
  // it since, a table is moved rather than laid out.
  const node = await render(
    '<table>'.repeat(100) +
      '<table><tr><td>x</td></tr></table>'.repeat(500) +
      '</table>'.repeat(100),
    true,
  );
  const tables = coldLayouts(
    node,
    (box) => box.kind === 'table',
    () => 3,
  );
  assert.strictEqual(tables.length, 600, 'every table counted');
  // A table is laid out as the cell around it is measured, at min content
  // and at max content, and as that cell is laid out: three times at any
  // depth. Laid out again at every level, the one k tables deep was laid
  // out 2k + 1 times — 201 at the bottom, 110,500 layouts in all. Counted
  // rather than timed, that is the same answer on a loaded machine as on
  // an idle one.
  within(tables, 'layouts', () => 3);
});

test('a thousand nested table cells render', async () => {
  // each a table of its own, so every level is four boxes and a table's
  // layout: the stack ran out, where now the document stops at 256
  const node = await render(
    nested('<div style="display:table-cell">', '</div>', 1000),
  );
  assert.ok(node._tree, 'laid out');
});

test('a document that cannot be laid out is left blank, not thrown', async () => {
  // Whatever still throws — a limit of the text engine's, or of the
  // server's — does so from a paint, where it is the application's end
  const node = await render('<p>fine</p>');
  const errors: string[] = [];
  const g = globalThis as unknown as { console: { error(m: string): void } };
  const error = g.console.error;
  g.console.error = (m: string) => errors.push(m);
  const proto = Object.getPrototypeOf(node) as {
    _update(width: number): void;
  };
  const update = proto._update;
  proto._update = () => {
    throw new RangeError('Maximum call stack size exceeded');
  };
  try {
    node._stale = 2;
    assert.doesNotThrow(() => node._prepare(500), 'not thrown');
    assert.doesNotThrow(() => node._prepare(500), 'nor thrown again');
    // `===`: a tree that failed this would be formatted, all of it
    assert.ok(node._tree === null, 'blank');
    assert.strictEqual(errors.length, 1, 'and said once');
    assert.match(errors[0], /could not lay out or paint/, 'what it says');
  } finally {
    proto._update = update;
    g.console.error = error;
  }
  // and laid out again once something changes
  node._stale = 2;
  node._prepare(500);
  assert.ok(node._tree, 'laid out again');
});
