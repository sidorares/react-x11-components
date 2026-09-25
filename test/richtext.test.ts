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
