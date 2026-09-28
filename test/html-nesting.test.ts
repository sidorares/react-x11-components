// Deeply nested documents. A box that sizes itself to its content — a flex
// item, a float, an inline-block, an absolute box — lays that content out to
// measure it, and nested, every level laid out the whole of what was under
// it again: twelve flex boxes took two seconds, and a hundred floats, the
// markup of a page with unclosed tags, never finished. What each case here
// holds is that the layout comes back, and soon; a regression is not a
// slower test but one that does not end.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';
import { renderX11, cleanup, screen } from 'react-x11/test';

import { Html } from '../src/index.js';
import { HtmlSource } from '../src/html/dom.js';
import type { Element } from '../src/html/dom.js';

afterEach(cleanup);

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];
const font = FONT_CANDIDATES.find((path) => existsSync(path));
const FONTS = font ? { 'sans-serif': font } : null;

async function render(source: string) {
  await renderX11(
    React.createElement(
      'box',
      { style: { width: 600, flexDirection: 'column' } },
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
  children: Laid[];
  el: Element | null;
}

/** A document `depth` elements deep, each opened with `open`. */
function nested(open: string, close: string, depth: number): string {
  return open.repeat(depth) + 'Some text in the middle' + close.repeat(depth);
}

/** The time a layout of a fresh box tree takes: measured, nothing kept. */
function coldLayout(node: Awaited<ReturnType<typeof render>>): number {
  node._stale = 2;
  const t = performance.now();
  node._prepare(600);
  return performance.now() - t;
}

for (const [kind, open, close] of [
  ['flex boxes', '<div style="display:flex">', '</div>'],
  ['grids', '<div style="display:grid">', '</div>'],
  ['floats', '<div style="float:left">', '</div>'],
  ['inline-blocks', '<div style="display:inline-block">', '</div>'],
  ['absolute boxes', '<div style="position:absolute">', '</div>'],
] as const) {
  test(`forty nested ${kind} are laid out once each`, async () => {
    const node = await render(nested(open, close, 40));
    const ms = coldLayout(node);
    // three layouts a level made it 3^40 and two made it 2^40; a layout a
    // level is well under a millisecond
    assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
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

test('two thousand floats in rows are placed in a moment', async () => {
  // each went up into any gap the rows above it left, and so walked the
  // bottom of every float above its own row: two thousand floated
  // thumbnails took six seconds
  const node = await render(
    '<div>' +
      '<span style="float:left;width:20px;height:20px"></span>'.repeat(2000) +
      '</div>',
  );
  const ms = coldLayout(node);
  assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
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
  );
  const ms = coldLayout(node);
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
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
  assert.ok(text.includes('Some text in the middle'));
  let divs = 0;
  const count = (node: { name?: string; children?: unknown[] }): void => {
    if (node.name === 'div') divs += 1;
    for (const child of (node.children ?? []) as { name?: string }[]) {
      count(child);
    }
  };
  count(source.document as unknown as { children?: unknown[] });
  assert.strictEqual(divs, 1000);
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
  );
  const ms = coldLayout(node);
  assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
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
    assert.doesNotThrow(() => node._prepare(500));
    assert.doesNotThrow(() => node._prepare(500));
    assert.strictEqual(node._tree, null, 'blank');
    assert.strictEqual(errors.length, 1, 'and said once');
    assert.match(errors[0], /could not lay out or paint/);
  } finally {
    proto._update = update;
    g.console.error = error;
  }
  // and laid out again once something changes
  node._stale = 2;
  node._prepare(500);
  assert.ok(node._tree, 'laid out again');
});
