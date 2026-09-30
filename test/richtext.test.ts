// `<richtext>`, the element: what it lays out again, and when.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { act, cleanup, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import { RICHTEXT_ELEMENT, registerRichText } from '../src/richtext/index.js';
import type { TextRun } from '../src/richtext/index.js';

registerRichText();
const h = React.createElement;

afterEach(() => cleanup());

test('a new runs array that says the same thing is not a new layout', async () => {
  // A component that builds its runs in render hands over a new array every
  // time it renders — the rich text editor does, for paragraphs a keystroke
  // never reached — and the layout cache was cleared on the array's
  // identity: the paragraph was shaped and broken again for nothing.
  const runs = (): TextRun[] => [
    { text: 'the renderer lays each ' },
    { text: 'paragraph', weight: 700 },
    { text: ' out against the width it is given', color: '#205080' },
  ];
  const view = await renderX11(
    h(RICHTEXT_ELEMENT, { runs: runs(), style: { width: 300 } }),
    { width: 400, height: 200 },
  );
  const node = screen.all((n) => n.kind === RICHTEXT_ELEMENT)[0] as
    | (DrawnNode & { app: { fonts: { layout: (...a: unknown[]) => unknown } } })
    | undefined;
  assert.ok(node, 'the element is mounted');
  const fonts = node.app.fonts;
  const inner = fonts.layout;
  let laidOut = 0;
  fonts.layout = function (...a: unknown[]) {
    laidOut++;
    return inner.apply(this, a);
  };
  try {
    await view.rerender(
      h(RICHTEXT_ELEMENT, { runs: runs(), style: { width: 300 } }),
    );
    await act();
    assert.strictEqual(laidOut, 0, 'an equal array lays nothing out');

    const changed = runs();
    changed[1] = { ...changed[1], weight: 400 };
    await view.rerender(
      h(RICHTEXT_ELEMENT, { runs: changed, style: { width: 300 } }),
    );
    await act();
    assert.ok(laidOut > 0, 'a changed run is laid out again');
  } finally {
    fonts.layout = inner;
  }
});

test('a line through is as thick as its run says, on the device grid', async () => {
  // `strikeThickness` is a length in the unit `size` is in, a logical one
  // nothing in core multiplies: at 2x three pixels are six device ones, as
  // a rule that says nothing is two.
  const runs: TextRun[] = [
    { text: 'gone ', size: 20, color: '#000000', strike: '#ff0000' },
    {
      text: 'gone',
      size: 20,
      color: '#000000',
      strike: '#ff0000',
      strikeThickness: 3,
    },
  ];
  const view = await renderX11(
    h(RICHTEXT_ELEMENT, { runs, style: { width: 200 } }),
    { width: 240, height: 80, scale: 2 },
  );
  const node = screen.all((n) => n.kind === RICHTEXT_ELEMENT)[0] as DrawnNode;
  await act();
  const { abs } = node;
  const { data } = await (
    view.ctx as unknown as {
      getImageData(
        x: number,
        y: number,
        w: number,
        h: number,
      ): Promise<{ data: Uint8ClampedArray }>;
    }
  ).getImageData(abs.x, abs.y, abs.width, abs.height);
  /** How many rows of each column are the rule's red. */
  const red = (x: number): number => {
    let rows = 0;
    for (let y = 0; y < abs.height; y += 1) {
      const at = (y * abs.width + x) * 4;
      if (data[at] > 200 && data[at + 1] < 60 && data[at + 2] < 60) rows += 1;
    }
    return rows;
  };
  const thick = new Set<number>();
  for (let x = 0; x < abs.width; x += 1) thick.add(red(x));
  thick.delete(0);
  assert.deepStrictEqual(
    [...thick].sort((a, b) => a - b),
    [2, 6],
    'a logical pixel, and three of them',
  );
});
