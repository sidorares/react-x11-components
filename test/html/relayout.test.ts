// <Html> — layouts kept across passes.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, renderX11, screen, waitFor } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { HtmlViewNode } from '../../src/html/index.js';
import type { FontsLike } from '../../src/html/layout/inline.js';
import { resizeClock } from '../../src/html/node.js';
import { holdClock } from '../held-clock.js';
import {
  boxOf,
  FONTS,
  fillsOf,
  h,
  metric,
  render,
  renderScrolled,
  view,
} from './harness.js';
import type { Fill } from './harness.js';

afterEach(cleanup);

// An edit re-parses the document and lays it out again, and laying the text
// out was most of that. A layout is kept under what went into it
// (`TextLayoutCache`), so a pass asks the text engine only for what changed.

/** The texts the engine is asked to lay out while `during` runs. */
async function laidOutDuring(
  el: HtmlViewNode,
  during: () => Promise<void>,
): Promise<string[]> {
  const engine = (el as unknown as { app: { fonts: FontsLike } }).app.fonts;
  const inner = engine.layout;
  const laid: string[] = [];
  engine.layout = function (content, style, options) {
    laid.push(content.map((r) => r.text).join(''));
    return inner.call(this, content, style, options);
  };
  try {
    await during();
  } finally {
    engine.layout = inner;
  }
  return laid;
}

metric(
  'paragraphs that start, end and run as long as each other keep their own layouts',
  async () => {
    // a kept layout is filed under a summary of its text, and found by all
    // of it: two paragraphs the summary cannot tell apart are still two
    const edge = 'the same twenty-four chars';
    const one = `${edge} first ${edge}`;
    const two = `${edge} other ${edge}`;
    const doc = (paras: string[]) =>
      h(
        'box',
        { style: { width: 400, flexDirection: 'column' } },
        h(Html, {
          source: paras.map((p) => `<p>${p}</p>`).join(''),
          partial: false,
          'data-testname': 'doc',
        }),
      );
    const result = await renderX11(doc([one]), {
      width: 440,
      height: 600,
      fonts: FONTS!,
    });
    const el = view(screen.getByTestName('doc') as DrawnNode);
    await act();
    const laid = await laidOutDuring(el, async () => {
      await act(() => result.rerender(doc([one, two])));
      await waitFor(() =>
        assert.ok(el.textContent().includes('other'), 'the new text is in'),
      );
      await act();
    });
    assert.ok(!laid.includes(one), `the first is kept: ${laid.join(' | ')}`);
    assert.ok(
      laid.includes(two),
      `the second is laid out, not taken for it: ${laid.join(' | ')}`,
    );
  },
);

metric('an edit lays out again only the text it changed', async () => {
  const doc = (word: string) =>
    h(
      'box',
      { style: { width: 400, flexDirection: 'column' } },
      h(Html, {
        source:
          '<h1>A title</h1><p>The first paragraph, unchanged.</p>' +
          `<p>The second one, which is ${word}.</p>` +
          '<ul><li>a list item</li></ul><p>And the last.</p>',
        partial: false,
        'data-testname': 'doc',
      }),
    );
  const result = await renderX11(doc('edited'), {
    width: 440,
    height: 600,
    fonts: FONTS!,
  });
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const laid = await laidOutDuring(el, async () => {
    await act(() => result.rerender(doc('changed')));
    await waitFor(() =>
      assert.ok(el.textContent().includes('changed'), 'the edit arrived'),
    );
    await act();
  });
  assert.deepStrictEqual(
    laid,
    ['The second one, which is changed.'],
    'the rest came from the last pass',
  );
});

metric('an edit asks the engine for no line height it has had', async () => {
  // `line-height: 1.5` is converted against the font's natural line height,
  // which every paragraph asks for; on CoreText each answer was a call to
  // the native side. It is kept per style, so an edit asks for none.
  const doc = (word: string) =>
    h(
      'box',
      { style: { width: 400, flexDirection: 'column' } },
      h(Html, {
        source:
          '<style>body { line-height: 1.5 }</style>' +
          '<p>The first paragraph.</p><p><b>Bold</b> and <i>italic</i>.</p>' +
          `<p>The third one, which is ${word}.</p><h2>A heading</h2>`,
        partial: false,
        'data-testname': 'doc',
      }),
    );
  const result = await renderX11(doc('edited'), {
    width: 440,
    height: 600,
    fonts: FONTS!,
  });
  const el = view(screen.getByTestName('doc') as DrawnNode);
  await act();
  // what the document asks, through the fonts its passes lay out with —
  // not the engine's own questions about the paragraph the edit changed
  const fonts = (el as unknown as { _layouts: { fonts: FontsLike } })._layouts
    .fonts;
  const match = fonts.match;
  let asked = 0;
  fonts.match = (family, style) =>
    new Proxy(match(family, style), {
      get(face, name, receiver) {
        if (name !== 'metrics') return Reflect.get(face, name, receiver);
        return (size: number) => {
          asked += 1;
          return face.metrics(size);
        };
      },
    });
  try {
    await act(() => result.rerender(doc('changed')));
    await waitFor(() =>
      assert.ok(el.textContent().includes('changed'), 'the edit arrived'),
    );
    await act();
  } finally {
    fonts.match = match;
  }
  assert.strictEqual(asked, 0);
});

metric(
  'a resize lays the document out once a step, at the new width',
  async () => {
    // Core asks a leaf for its height at the width it was measured at as well
    // as at the one it has now (`probeHeightFloors`). The document answered
    // the old width by laying itself out there, and the new one again for the
    // pass after: three passes over all of its text a frame of a resize.
    const paras = [
      'The first paragraph of the document, which wraps.',
      'A second one, a little longer than the first, and wrapping too.',
      'And a third.',
    ];
    const doc = (width: number) =>
      h(
        'box',
        { style: { width, height: 300, flexDirection: 'column' } },
        h(
          'box',
          { style: { flexGrow: 1, overflow: 'scroll' } },
          h(Html, {
            source: paras.map((p) => `<p>${p}</p>`).join(''),
            partial: false,
            'data-testname': 'doc',
          }),
        ),
      );
    const result = await renderX11(doc(400), {
      width: 440,
      height: 600,
      fonts: FONTS!,
    });
    const el = view(screen.getByTestName('doc') as DrawnNode);
    await act();
    const end = el.textContent().length;
    const shape = () => ({
      height: el.measureContent({
        width: el.abs.width,
        height: Infinity,
        widthMode: 'at-most',
        heightMode: 'unconstrained',
      }).height,
      caret: el.textCaretRect(end),
    });
    const first = shape();
    for (const width of [360, 300, 360, 400]) {
      const laid = await laidOutDuring(el, async () => {
        await act(() => result.rerender(doc(width)));
        await act();
      });
      for (const p of paras) {
        assert.strictEqual(
          laid.filter((t) => t === p).length,
          1,
          `at ${width}: "${p.slice(0, 12)}…" laid out ${laid.filter((t) => t === p).length} times`,
        );
      }
    }
    // …and back where it started, it is where it started: a size kept for a
    // width is never a layout for it
    assert.deepStrictEqual(shape(), first);
  },
);

metric(
  'a kept layout hit-tests the element of the parse it is shown for',
  async () => {
    // The layout of the first paragraph is the one the first parse made;
    // the anchor under the pointer has to be the second parse's.
    const doc = (word: string) =>
      h(
        'box',
        { style: { width: 400, flexDirection: 'column' } },
        h(Html, {
          source:
            '<p>see <a id="x" href="https://example.test/x">the link</a> now</p>' +
            `<p>and ${word}</p>`,
          partial: false,
          'data-testname': 'doc',
        }),
      );
    const result = await renderX11(doc('one'), {
      width: 440,
      height: 600,
      fonts: FONTS!,
    });
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const laid = await laidOutDuring(el, async () => {
      await act(() => result.rerender(doc('two')));
      await waitFor(() =>
        assert.ok(el.textContent().includes('two'), 'the new text is in'),
      );
      await act();
    });
    assert.ok(!laid.some((t) => t.includes('the link')), 'kept, not laid out');
    const caret = el.textCaretRect(6);
    assert.ok(caret, 'the paragraph is laid out');
    const found = el.elementAtPoint(caret.x + 1, caret.y + caret.height / 2);
    const anchor = (function find(node: unknown): unknown {
      const n = node as { attribs?: { id?: string }; children?: unknown[] };
      if (n.attribs?.id === 'x') return n;
      for (const child of n.children ?? []) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    })(el.document);
    assert.ok(anchor, 'the new parse has the anchor');
    assert.strictEqual(found, anchor, 'the anchor of this parse, not the last');
    assert.strictEqual(
      el.hrefAtPoint(caret.x + 1, caret.y + caret.height / 2),
      'https://example.test/x',
    );
  },
);

metric(
  'a layout that does not say whether it was cut is asked the same of its line ends',
  async () => {
    // Beside a float the paragraph is laid out a line at a time, and each
    // fragment's `truncated` is what says the segment wrapped. An engine that
    // reports none must not read as "fitted" — that dropped every line after
    // the first. The same tree is laid out twice: with the flag, and with it
    // hidden.
    const source =
      '<style>p{margin:0}.f{float:left;width:100px;height:40px}</style>' +
      '<div class="f"></div><p>' +
      'word '.repeat(40) +
      '</p>';
    const { result, node } = await render(source, 240);
    const el = view(node);
    const tree = (el as unknown as { _tree: unknown })._tree as {
      root: { children: { lines: { textEnd: number }[] | null }[] };
    };
    const control = tree.root.children[1].lines ?? [];
    assert.ok(
      control.length > 2,
      `the paragraph wraps (${control.length} lines)`,
    );

    const fonts = (result.app as unknown as { fonts: FontsLike }).fonts;
    const silent: FontsLike = {
      layout: (...args) => {
        const layout = fonts.layout(...args);
        delete (layout as { truncated?: boolean }).truncated;
        return layout;
      },
      match: (...args) => fonts.match(...args),
    };
    const { layoutDocument } = await import('../../src/html/layout/block.js');
    layoutDocument(tree as never, silent, 240, 600);
    const again = tree.root.children[1].lines ?? [];
    assert.strictEqual(
      again.length,
      control.length,
      'every line of the paragraph is laid out',
    );
    assert.strictEqual(
      again[again.length - 1].textEnd,
      control[control.length - 1].textEnd,
      'down to the last word',
    );
  },
);

// A window edge dragged moves the width a frame at a time, and the document
// is laid out at each step only down to a viewport past the one the pane
// shows (`_stopAt`); the rest is set aside and laid out once the width has
// rested (`resizeClock`), as tall as it was meanwhile.

/** Whether a box of the element's tree reaches the one with `id` from its
 *  root: what the paint and the hit test find. */
function reached(el: HtmlViewNode, id: string): boolean {
  type B = { el?: { attribs?: { id?: string } }; children: B[] };
  const root = (el as unknown as { _tree: { root: B } })._tree.root;
  const stack = [root];
  while (stack.length) {
    const box = stack.pop()!;
    if (box.el?.attribs?.id === id) return true;
    stack.push(...box.children);
  }
  return false;
}

const partial = (el: HtmlViewNode): boolean =>
  (el as unknown as { _partial: boolean })._partial;

/** Sixty rows of fifty pixels, every third one wider, with a paragraph in
 *  each fifth, and a box at the end. */
const LONG =
  '<body style="margin:0">' +
  Array.from(
    { length: 60 },
    (_, i) =>
      `<div id="r${i}" style="height:50px;width:${i % 3 ? 50 : 80}%;` +
      `background:#${(i * 40).toString(16).padStart(2, '0')}8040">` +
      (i % 5 ? '' : `<p style="margin:0">row ${i} of the long one</p>`) +
      '</div>',
  ).join('') +
  '<div id="end" style="height:10px"></div></body>';

/** The fills that reach the top `height` of the document. */
const shown = (fills: Fill[], height: number): string[] =>
  fills
    .filter((f) => f.y < height)
    .map((f) => `${String(f.style)} ${f.x},${f.y} ${f.w}x${f.h}`);

test('a dragged width lays out what can be seen, and the rest once it rests', async (t) => {
  const clock = holdClock(t, resizeClock);
  const { el, resize } = await renderScrolled(LONG, 300, 400);
  // a width that jumps — a window maximized, a sidebar shown — is laid out
  // whole, as a width set once is exact at once
  await resize(300, 330);
  assert.ok(!partial(el), 'a jump');
  assert.ok(reached(el, 'end'));
  // a drag's step, down to a viewport past the pane's
  await resize(300, 320);
  assert.ok(partial(el), 'a step');
  assert.strictEqual(boxOf(el, 'r0').width, 256, '80% of the new width');
  assert.ok(reached(el, 'r12'), 'what can be seen, and a viewport more');
  assert.ok(!reached(el, 'r20') && !reached(el, 'end'), 'and no further');
  assert.strictEqual(el.abs.height, 3010, 'as tall as it was');
  const seen = shown(await fillsOf(el), 300);
  // rested: laid out whole, at the width the drag ended at
  assert.ok(clock.pending, 'waiting for the width to rest');
  await clock.finish();
  assert.ok(!partial(el), 'laid out whole');
  assert.strictEqual(boxOf(el, 'end').y, 3000);
  assert.strictEqual(boxOf(el, 'r59').width, 160);
  assert.deepStrictEqual(
    shown(await fillsOf(el), 300),
    seen,
    'what can be seen drawn as the whole layout draws it',
  );
  // and the first step of the next drag is a step: laid out whole, it was
  // the drag catching at its start
  await resize(300, 310);
  assert.ok(partial(el), 'the first step of a drag');
  await clock.finish();
  assert.ok(!partial(el));
});

test('a dragged width lays out whole a document whose fixed box is set aside', async (t) => {
  // An out-of-flow box among the children set aside stays, and is placed
  // as ever. One inside a box set aside would go with it — and a fixed
  // box is drawn where the viewport is wherever the flow has it, so it
  // would be missing from the window: such a tree is laid out whole.
  holdClock(t, resizeClock);
  const fixed =
    '<div id="fixed" style="position:fixed;top:0;right:0;width:20px;' +
    'height:20px;background:#ff0000"></div>';
  const among = await renderScrolled(
    LONG.replace('</body>', `${fixed}</body>`),
    300,
    400,
  );
  await among.resize(300, 390);
  await among.resize(300, 380);
  assert.ok(partial(among.el), 'among the children set aside');
  assert.ok(reached(among.el, 'fixed'), 'it stays');
  assert.strictEqual(boxOf(among.el, 'fixed').x, 360, 'placed at the width');
  await cleanup();

  const inside = await renderScrolled(
    LONG.replace('</body>', `<div id="foot">${fixed}</div></body>`),
    300,
    400,
  );
  await inside.resize(300, 390);
  await inside.resize(300, 380);
  assert.ok(!partial(inside.el), 'inside one: laid out whole');
  assert.ok(reached(inside.el, 'fixed') && reached(inside.el, 'end'));
  await inside.resize(300, 370);
  assert.ok(!partial(inside.el), 'and whole from then on');
});

test('a dragged width mounts no control past where the layout stops', async (t) => {
  // its box is where it was a width ago, which may be over what the
  // layout put in view since: it is mounted again once the width rests
  const clock = holdClock(t, resizeClock);
  const { el, resize } = await renderScrolled(
    LONG.replace('</body>', '<input id="field" value="x"></body>'),
    300,
    400,
  );
  const mounted = () =>
    (
      el as unknown as {
        _controls: { element: { attribs: { id?: string } } }[];
      }
    )._controls.some((c) => c.element.attribs.id === 'field');
  assert.ok(mounted(), 'mounted at first');
  await resize(300, 390);
  await resize(300, 380);
  assert.ok(partial(el));
  assert.ok(!mounted(), 'not while it is set aside');
  await clock.finish();
  assert.ok(mounted(), 'and mounted again once the width rests');
});

test('a dragged width keeps the widget of a field with the focus where it was', async (t) => {
  // Unmounted, the field would take the focus with it, and the caret: a
  // field focused and scrolled away from lost both to the first step of a
  // drag. Set aside is out of sight, below what can be seen, and so is
  // where the field was a width ago.
  const clock = holdClock(t, resizeClock);
  const { el, resize } = await renderScrolled(
    LONG.replace('</body>', '<input id="field" placeholder="field"></body>'),
    300,
    400,
  );
  const field = screen.getByPlaceholder('field') as DrawnNode;
  await act(async () => {
    field.focus();
  });
  // scrolled away from it, whether or not the focus brought it into view
  type Pane = { scrollTo(y: number): void; isScroller?(): boolean };
  let pane = (el as unknown as { parent: Pane & { parent: unknown } }).parent;
  while (pane && !pane.isScroller?.()) {
    pane = pane.parent as Pane & { parent: unknown };
  }
  await act(() => pane.scrollTo(0));
  await act();
  assert.strictEqual(el.focusedElement?.attribs.id, 'field', 'focused');
  await resize(300, 390);
  await resize(300, 380);
  assert.ok(partial(el), 'set aside');
  // the same widget, mounted, with the focus
  const held = () =>
    screen.queryByPlaceholder('field') === field && field.focused;
  assert.ok(held(), 'its widget, still focused');
  assert.strictEqual(el.focusedElement?.attribs.id, 'field', "and the page's");
  await clock.finish();
  assert.ok(!partial(el));
  assert.ok(held(), 'and once the width rests');
});

test('a dragged width lays a multicol container out whole', async (t) => {
  // its content is one strip, balanced in its columns: what a layout set
  // aside of it would move the columns of what can be seen
  holdClock(t, resizeClock);
  const { el, resize } = await renderScrolled(
    LONG.replace(
      '<body style="margin:0">',
      '<body style="margin:0"><div style="columns:2;column-gap:0">' +
        Array.from(
          { length: 40 },
          (_, i) => `<div id="c${i}" style="height:50px"></div>`,
        ).join('') +
        '</div>',
    ),
    300,
    400,
  );
  await resize(300, 390);
  await resize(300, 380);
  assert.ok(partial(el), 'what comes after it is set aside');
  assert.ok(reached(el, 'c39'), 'and none of it');
  assert.strictEqual(boxOf(el, 'c20').y, 0, 'the second column at the top');
  assert.ok(!reached(el, 'end'));
});

test('a layout that stops measures the boxes it sizes from all they hold', async () => {
  // A shrink-to-fit box's width is its content's, measured by laying the
  // content out at no width limit: a probe, which a layout that stops
  // would cut short as it cuts the flow, and the float would be as wide
  // as its first blocks, not its widest
  const blocks = Array.from(
    { length: 30 },
    (_, i) => `<div style="height:50px;width:${i === 29 ? 200 : 20}px"></div>`,
  ).join('');
  const { el } = await renderScrolled(
    `<body style="margin:0"><div id="f" style="float:left">${blocks}</div>` +
      '<div style="height:3000px"></div></body>',
    300,
    400,
  );
  const node = el as unknown as {
    _source: { document: unknown };
    _cascade: unknown;
  };
  const { buildBoxes } = await import('../../src/html/layout/boxes.js');
  const { layoutDocument } = await import('../../src/html/layout/block.js');
  // a tree no layout has measured, as a band a drag crosses builds
  const tree = buildBoxes(node._source.document as never, {
    cascade: node._cascade as never,
    scale: 1,
    imageSize: () => null,
    urlSize: () => null,
    controlSize: () => ({ width: 0, height: 0 }) as never,
  });
  const result = layoutDocument(tree, null, 400, 300, 1, 300);
  assert.ok(result.partial, 'the layout stopped');
  type B = { el?: { attribs?: { id?: string } }; width: number; children: B[] };
  const find = (box: B): B | null =>
    box.el?.attribs?.id === 'f'
      ? box
      : box.children.reduce<B | null>((hit, child) => hit ?? find(child), null);
  const float = find(tree.root as unknown as B);
  assert.strictEqual(float?.width, 200, 'as wide as its widest block');
});

test('a dragged width that crosses a breakpoint goes on laying out what can be seen after it', async (t) => {
  // The band crossed builds the boxes again, and that takes long on a long
  // page: the width still moved then, and the step after it is the drag's,
  // where it was taken for a first move and laid out whole. The crossing
  // itself styles only what the band changes (`Cascade.crossed`) and is
  // laid out down to what can be seen, as every step of the drag is
  let time = 0;
  t.mock.method(resizeClock, 'now', () => time);
  t.mock.method(resizeClock, 'arm', () => ({}));
  t.mock.method(resizeClock, 'disarm', () => {});
  const { el, resize } = await renderScrolled(
    LONG.replace(
      '<body style="margin:0">',
      '<style>@media (max-width:385px){#r0{margin-left:10px}}</style>' +
        '<body style="margin:0">',
    ),
    300,
    400,
  );
  await resize(300, 390);
  assert.ok(partial(el), 'the first step');
  time = 100;
  await resize(300, 380);
  assert.strictEqual(boxOf(el, 'r0').x, 10, 'across the breakpoint');
  assert.ok(partial(el), 'and laid out down to what can be seen');
  time = 250;
  await resize(300, 370);
  assert.ok(partial(el), 'and the step after it the drag’s');
});
