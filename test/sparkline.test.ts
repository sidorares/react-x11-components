// The seed component, and with it the three ways a registered element
// silently fails: missing from DRAWN_KINDS (lays out, never paints), a
// prop name that collides with the style vocabulary (throws in DEV, works
// in production), and a `kind` that is not the registered name.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { renderX11, cleanup, screen } from 'react-x11/test';
import { drawnKinds, knownElements } from 'react-x11/host';
import { isStyleProp } from 'react-x11/style';
import type { Node as RetainedNode } from 'react-x11/node';

import { Sparkline, SPARKLINE_ELEMENT } from '../src/index.js';
import type { SparklineProps } from '../src/index.js';

const h = React.createElement;

afterEach(cleanup);

/**
 * The queries are typed as `DrawnNode` — the narrow, ref-facing view of a
 * node: `type`, `abs`, `focus()`. What they hand back at runtime is the
 * retained `Node`, which is what a test about `kind`, `props` and paint
 * order has to reach for. react-x11's public test types just describe the
 * smaller surface, so the widening is explicit and lives in one place.
 */
function retained(node: unknown): RetainedNode {
  return node as RetainedNode;
}

/** Mount without React's report of an escaping error on stderr — the
 * message under test is the one thrown, not the one React logs about it. */
async function rejectsQuietly(
  fn: () => Promise<unknown>,
  expected: RegExp,
): Promise<void> {
  const origError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(fn, expected);
  } finally {
    console.error = origError;
  }
}

function sparklineNode(): RetainedNode {
  const [node] = screen.all((n) => retained(n).kind === SPARKLINE_ELEMENT);
  assert.ok(node, 'the element is in the retained tree');
  return retained(node);
}

test('importing the component is what registers the element', () => {
  assert.strictEqual(SPARKLINE_ELEMENT, 'sparkline');
  assert.ok(knownElements().includes(SPARKLINE_ELEMENT));
  // the trap: a kind outside this set lays out, reports a sensible rect,
  // and never appears on screen, with no error anywhere
  assert.ok(drawnKinds().includes(SPARKLINE_ELEMENT));
});

test('it mounts, lays out and joins its parent paint order', async () => {
  await renderX11(
    h(
      'box',
      { style: { flexGrow: 1, padding: 10 } },
      h(Sparkline, {
        data: [1, 4, 2, 8],
        color: '#c0392b',
        style: { width: 120, height: 40 },
      }),
    ),
    { backend: 'mock' },
  );

  const node = sparklineNode();
  assert.strictEqual(node.abs.width, 120);
  assert.strictEqual(node.abs.height, 40);
  assert.strictEqual(node.abs.x, 10);

  const { parent } = node;
  assert.ok(parent, 'the element is attached');
  assert.ok(
    parent.paintOrder().includes(node),
    'painted by its parent rather than silently skipped',
  );
});

test('the element claims `color`, which is also a style name', async () => {
  // Without `semanticNames` this is the dev/prod split: react-x11 throws on
  // `<sparkline color="red">` in development and works in production.
  assert.strictEqual(isStyleProp('color'), true, 'precondition');

  await renderX11(
    h(Sparkline, { data: [1, 2], color: 'red', strokeWidth: 2 }),
    {
      backend: 'mock',
    },
  );
  sparklineNode();
});

test('props update through the normal commit path', async () => {
  const { rerender } = await renderX11(
    h(Sparkline, { data: [1, 2], style: { width: 50, height: 20 } }),
    { backend: 'mock' },
  );
  assert.deepStrictEqual(sparklineNode().props.data, [1, 2]);

  await rerender(
    h(Sparkline, { data: [3, 4, 5], style: { width: 50, height: 20 } }),
  );
  assert.deepStrictEqual(sparklineNode().props.data, [3, 4, 5]);
});

test('degenerate series paint without throwing', async () => {
  const style = { width: 60, height: 20 };
  // The type says `data` is a required `number[]`. What is under test is a
  // caller that ignores that — a plain-JavaScript app, or a series built at
  // runtime — so these props are asserted past the type on purpose. The
  // element re-checks the series in `paint` for exactly this reason.
  const series: unknown[] = [undefined, [], [7], [5, 5, 5], [-3, 0, -8]];
  for (const data of series) {
    await renderX11(h(Sparkline, { data, style } as SparklineProps), {
      backend: 'mock',
    });
    sparklineNode();
    await cleanup();
  }
});

test('it has no intrinsic size, so an unstyled one has no height', async () => {
  await renderX11(h(Sparkline, { data: [1, 2, 3] }), { backend: 'mock' });
  const node = sparklineNode();
  // The width it does have comes from `alignItems: stretch` filling the
  // window, not from the series — nothing here measures content, which is
  // why the documented usage always passes a width and a height.
  assert.strictEqual(node.abs.height, 0, 'no intrinsic size — needs a style');
});

test('children are refused by name, not laid out into nothing', async () => {
  await rejectsQuietly(
    () =>
      renderX11(h(Sparkline, { data: [1, 2] }, h('box', null)), {
        backend: 'mock',
      }),
    /<sparkline> takes no children/,
  );
});
