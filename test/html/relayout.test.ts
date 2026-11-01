// <Html> — layouts kept across passes.
import { afterEach, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, renderX11, screen, waitFor } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { HtmlViewNode } from '../../src/html/index.js';
import type { FontsLike } from '../../src/html/layout/inline.js';
import {
  animationClock,
  frameClock,
  resizeClock,
} from '../../src/html/node.js';
import { SpriteStore } from '../../src/html/surfaces.js';
import {
  heldBack,
  laidWhole,
  layoutDocument,
} from '../../src/html/layout/block.js';
import type { BoxTree } from '../../src/html/layout/boxes.js';
import { FRAME_MS, holdClock } from '../held-clock.js';
import { mulberry32 } from '../mulberry32.js';
import {
  boxOf,
  bytesApart,
  FONTS,
  fillsOf,
  findById,
  h,
  imagesIn,
  metric,
  pixelsPng,
  rebuilt,
  render,
  renderScrolled,
  snapshot,
  solidPng,
  treeOf as treeIn,
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

metric(
  'a layout of the boxes a layout laid out lays them out where it did',
  async () => {
    // An inline-block holding nothing but an empty inline box that clips: in
    // a flex row beside a box out of the flow, its baseline was read from the
    // inline box's rectangle, which no layout sets, and every layout after
    // the first stood it somewhere else. A stream's chunk lays out the boxes
    // a build of its tail kept, as a resize lays all of them out again.
    const { node } = await render(
      '<div style="display:flex"><span style="position:absolute"></span>' +
        '<section><b id="ib" style="display:inline-block;width:40px">' +
        '<span style="overflow:hidden"></span></b>two</section></div>',
      320,
    );
    const el = view(node);
    await act();
    const box = () => boxOf(el, 'ib');
    const first = [box().x, box().y];
    for (let i = 0; i < 3; i += 1) {
      (el as unknown as { _invalidate(stale: number): void })._invalidate(1);
      await act();
      assert.deepStrictEqual([box().x, box().y], first, `layout ${i + 2}`);
    }
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

/** The fills that reach the top `height` of the document, cut to it: what
 *  of each can be seen. A box set aside is as tall as it was a width ago,
 *  so a border down the side of one runs another length below. */
const shown = (fills: Fill[], height: number): string[] =>
  fills
    .filter((f) => f.y < height)
    .map(
      (f) =>
        `${String(f.style)} ${f.x},${f.y} ${f.w}x${Math.min(f.h, height - f.y)}`,
    );

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

test('a ::before a drag set aside reads as its rules compute it, a transform and the frame getKeyframes() makes up with the rest', async (t) => {
  holdClock(t, resizeClock);
  const rows = Array.from(
    { length: 40 },
    () => '<div style="height:50px"></div>',
  ).join('');
  const { el, resize } = await renderScrolled(
    '<style>body{margin:0}@keyframes k{to{margin-left:1px}}' +
      '#end::before{content:"";display:block;height:5px;margin-left:10%;' +
      'transform:translate(10px, 5px);animation:k 100s paused}</style>' +
      `<body>${rows}<div id="end"></div></body>`,
    300,
    400,
  );
  await resize(300, 330);
  await resize(300, 320);
  assert.ok(partial(el), 'a step');
  assert.ok(!reached(el, 'end'), 'set aside');
  // its box is a width ago, and there is one, so its transform is no `none`
  const end = findById(el.document, 'end')!;
  assert.strictEqual(
    el.computedStyle(end, 'before')!.transform,
    'translate(10px, 5px)',
  );
  assert.strictEqual(
    el.cssKeyframesOf(end, 'before', 'k')![0].values['margin-left'],
    '10%',
  );
});

test('a container a drag set aside is found when a read first asks for the containers, and read once it is back', async (t) => {
  const clock = holdClock(t, resizeClock);
  const rows = Array.from(
    { length: 40 },
    () => '<div style="height:50px"></div>',
  ).join('');
  const { el, resize } = await renderScrolled(
    '<style>body{margin:0}.l{container-type:inline-size}' +
      '@container (min-width: 150px) { .b { color: #123456 } }</style><body>' +
      `<div class="l"><p id="top">top</p></div>${rows}` +
      '<div class="l"><p id="end">end</p></div></body>',
    300,
    400,
  );
  const color = (id: string): string =>
    (boxOf(el, id) as unknown as { style: { color: string } }).style.color;
  const setClass = (id: string, value: string): void => {
    const target = findById(el.document, id)!;
    target.attribs.class = value;
    el.touchDocument([
      { type: 'attributes', target, attributeName: 'class', oldValue: null },
    ]);
  };
  await resize(300, 330);
  await resize(300, 320);
  assert.ok(partial(el), 'a step');
  assert.ok(!reached(el, 'end'), 'set aside');
  // the first read of any container takes the tree's: this tree's first
  // style to read one is a restyle in place, while a drag has the last of
  // them set aside
  setClass('top', 'b');
  await act();
  assert.strictEqual(color('top'), '#123456');
  await clock.finish();
  assert.ok(!partial(el), 'rested');
  setClass('end', 'b');
  await act();
  assert.strictEqual(color('end'), '#123456');
});

/** A long page of rows, each with a `::after` as wide as a tenth of the
 *  viewport and moved by as much again, as Apple's gallery slides are. */
const READERS =
  '<style>body{margin:0}.r{height:50px;position:relative;max-width:90vw;' +
  'font-size:calc(10px + 1vw)}.r::after{content:"";display:block;' +
  'height:10px;width:10vw;transform:translateX(5vw)}</style><body>' +
  Array.from(
    { length: 60 },
    (_, i) => `<div id="r${i}" class="r"><b id="b${i}">row ${i}</b></div>`,
  ).join('') +
  '</body>';

/** How often the cascade is asked for an element's style during `run`. */
async function stylesAsked(
  el: HtmlViewNode,
  run: () => Promise<void>,
): Promise<number> {
  const cascade = (
    el as unknown as { _cascade: { styleFor(...a: unknown[]): unknown } }
  )._cascade;
  const styleFor = cascade.styleFor;
  let asked = 0;
  cascade.styleFor = function (...a: unknown[]) {
    asked += 1;
    return styleFor.apply(this, a);
  };
  await run();
  cascade.styleFor = styleFor;
  return asked;
}

test('a step of a drag styles what can be seen, and keeps the boxes', async (t) => {
  // Each `vw` on a page was styled at every step, where only those drawn
  // are restyled: 107 elements on Apple's page, some 25 ms a step for the
  // 24 boxes that took them, and a `::after` no walk reached refused the
  // restyle at the end of that and built them all (`_heldBackOf`)
  const clock = holdClock(t, resizeClock);
  const { el, resize } = await renderScrolled(READERS, 300, 400);
  await resize(300, 410);
  await resize(300, 400);
  assert.ok(partial(el), 'a step');
  const tree = treeIn(el);
  const asked = await stylesAsked(el, () => resize(300, 390));
  assert.ok(partial(el), 'a step');
  assert.ok(treeIn(el) === tree, 'the boxes were built again');
  // of 120 on the page
  assert.ok(asked < 40, `${asked} styles for a screenful and a viewport more`);
  await clock.finish();
  assert.ok(!partial(el), 'rested');
});

test('what a step of a drag left unstyled is styled where a script asks, and when the drag rests', async (t) => {
  const clock = holdClock(t, resizeClock);
  const { el, resize } = await renderScrolled(READERS, 300, 400);
  await resize(300, 410);
  await resize(300, 400);
  await resize(300, 390);
  assert.ok(partial(el), 'a step');
  const far = findById(el.document, 'r50')!;
  const inside = findById(el.document, 'b50')!;
  // a page's `resize` handler, reading what no walk restyled: an element's
  // own length, and what an element in it takes from it
  assert.strictEqual(el.computedStyle(far)?.['max-width'], '351px');
  assert.strictEqual(el.computedStyle(inside)?.['font-size'], '13.9px');
  assert.strictEqual(
    el.computedStyle(far, 'after')?.width,
    '39px',
    'a tenth of the viewport as it is now',
  );
  await clock.finish();
  assert.ok(!partial(el), 'rested');
  const held = (el as unknown as { _stylesOwed: Set<unknown> })._stylesOwed;
  assert.strictEqual(held.size, 0, 'nothing owed once it rests');
  assert.strictEqual(el.computedStyle(far)?.['max-width'], '351px');
  assert.strictEqual(el.computedStyle(inside)?.['font-size'], '13.9px');
  assert.strictEqual(el.computedStyle(far, 'after')?.width, '39px');
  assert.strictEqual(boxOf(el, 'r50').y, 2500);
});

test('a dragged width lays out the boxes on the way to a fixed box it would set aside, and sets aside the rest', async (t) => {
  // An out-of-flow box among the children set aside stays, and is placed
  // as ever. One inside a box set aside would go with it — and a fixed box
  // is drawn where the viewport is wherever the flow has it, so it would be
  // missing from the window. The boxes that hold it are laid out, with all
  // but what holds it set aside in each, and the box is placed at the new
  // width: the Guardian's banner, fixed to the bottom, laid its whole tree
  // out at every step of a drag.
  const clock = holdClock(t, resizeClock);
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
  assert.ok(partial(inside.el), 'inside one: still stopped');
  assert.ok(reached(inside.el, 'fixed'), 'and reached');
  assert.ok(!reached(inside.el, 'end'), 'with the rest set aside');
  assert.strictEqual(boxOf(inside.el, 'fixed').x, 360, 'placed at the width');
  await cleanup();

  // and an absolute box placed against the root from inside one, which is
  // drawn at the document's top
  const corner = await renderScrolled(
    LONG.replace(
      '</body>',
      '<div id="foot"><div id="abs" style="position:absolute;top:5px;' +
        'right:5px;width:20px;height:20px;background:#00ff00"></div></div>' +
        '</body>',
    ),
    300,
    400,
  );
  await corner.resize(300, 390);
  await corner.resize(300, 380);
  assert.ok(partial(corner.el), 'stopped');
  assert.ok(reached(corner.el, 'abs') && !reached(corner.el, 'end'));
  assert.deepStrictEqual(
    [boxOf(corner.el, 'abs').x, boxOf(corner.el, 'abs').y],
    [355, 5],
    'placed at the width',
  );
  await cleanup();

  // the banner's shape: `bottom: 0`, as wide as its holder, which is
  // centred, so it takes its place across from the boxes that hold it; in
  // the middle of what is set aside, which is as tall as it was
  const banner =
    '<div id="wrap" style="max-width:300px;margin:0 auto;padding:0 7%">' +
    '<div id="holder"><div id="banner" style="position:fixed;bottom:0;' +
    'width:100%;height:24px;background:#0000ff"></div></div></div>';
  const doc = LONG.replace('<div id="r40"', `${banner}<div id="r40"`);
  const { el, resize } = await renderScrolled(doc, 300, 400);
  const tall = el.abs.height;
  await resize(300, 390);
  await resize(300, 380);
  assert.ok(partial(el));
  assert.ok(reached(el, 'banner') && !reached(el, 'r45'));
  assert.strictEqual(el.abs.height, tall, 'as tall as it was');
  const step = boxOf(el, 'banner');
  const seen = shown(await fillsOf(el), 300);
  await clock.finish();
  assert.ok(!partial(el));
  const rest = boxOf(el, 'banner');
  assert.deepStrictEqual(
    [step.x, step.y, step.width],
    [rest.x, rest.y, rest.width],
    'where the layout at rest puts it',
  );
  assert.deepStrictEqual(
    shown(await fillsOf(el), 300),
    seen,
    'what can be seen drawn as the whole layout draws it',
  );
});

test('a dragged width leaves a menu that draws nothing where it was, and places it once it rests', async (t) => {
  // GitHub keeps its menus in the page, absolute, shrink-to-fit, hidden and
  // faded to nothing, and laid out at every step of a drag they were a
  // third of the step. One that draws nothing all through is set aside
  // where it was until the layout at rest; one that draws is placed at
  // every step. In a box a relative offset moves, so a menu left in the
  // tree would be moved by it again at each step.
  const clock = holdClock(t, resizeClock);
  const items = Array.from(
    { length: 30 },
    (_, i) => `<li style="height:10px">item ${i}</li>`,
  ).join('');
  const menu = (id: string, how: string) =>
    `<div id="${id}" class="menu" style="position:absolute;top:40px;` +
    `left:10%;background:#00ff00;${how}"><ul style="margin:0;list-style:none">${items}` +
    '</ul></div>';
  const doc = LONG.replace(
    '<body style="margin:0">',
    '<body style="margin:0"><style>.open{visibility:visible !important}</style>' +
      '<div id="wrap" style="position:relative;top:3px;height:20px">' +
      menu('hidden', 'visibility:hidden') +
      menu('faded', 'opacity:0') +
      menu('shown', 'left:20%') +
      '</div>',
  );
  const { el, resize } = await renderScrolled(doc, 300, 400);
  await resize(300, 330);
  assert.ok(!partial(el), 'a jump, laid out whole');
  const hidden = boxOf(el, 'hidden');
  const faded = boxOf(el, 'faded');
  const was = geometry(hidden);
  assert.deepStrictEqual(was.slice(0, 2), [33, 43], 'placed at 330');
  await resize(300, 320);
  assert.ok(partial(el), 'a step');
  for (const [id, box] of [
    ['hidden', hidden],
    ['faded', faded],
  ] as const) {
    assert.ok(held(el, box), `${id}: set aside`);
    assert.ok(!reached(el, id), `${id}: nothing finds it`);
  }
  assert.ok(!held(el, boxOf(el, 'shown')) && reached(el, 'shown'));
  assert.strictEqual(boxOf(el, 'shown').x, 64, 'what draws is placed');
  await resize(300, 310);
  assert.deepStrictEqual(
    geometry(hidden),
    was,
    'where it was, moved by no offset again',
  );
  assert.strictEqual(boxOf(el, 'shown').x, 62);
  const seen = shown(await fillsOf(el), 300);
  await clock.finish();
  assert.ok(!partial(el), 'rested');
  for (const id of ['hidden', 'faded']) {
    assert.ok(reached(el, id), `${id}: put back`);
    assert.deepStrictEqual(
      geometry(boxOf(el, id)).slice(0, 2),
      [31, 43],
      `${id}: placed at the width it rests at`,
    );
  }
  assert.deepStrictEqual(
    shown(await fillsOf(el), 300),
    seen,
    'what can be seen drawn as the whole layout draws it',
  );

  // and one a restyle in place shows while it is set aside is laid out
  await resize(300, 300);
  assert.ok(held(el, hidden), 'set aside again');
  const tree = (el as unknown as { _tree: BoxTree })._tree;
  const target = findById(el.document, 'hidden') as unknown as {
    attribs: Record<string, string>;
  };
  const oldValue = target.attribs.class;
  target.attribs.class = 'menu open';
  await act(() =>
    el.touchDocument([
      {
        type: 'attributes',
        target: target as never,
        attributeName: 'class',
        oldValue,
      },
    ]),
  );
  await act();
  assert.ok(
    (el as unknown as { _tree: BoxTree })._tree === tree,
    'restyled in place',
  );
  assert.ok(reached(el, 'hidden'), 'shown, and found');
  assert.strictEqual(boxOf(el, 'hidden').x, 30, 'placed at the width');
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

test('a dragged width stops inside a scroll container where what it shows ends, scrolled or not, and keeps how far it scrolls', async (t) => {
  // A sidebar, a table of contents or a menu a window tall is a scroll
  // container, which was laid out whole at every step: what it holds is
  // where it is scrolled to, so it stops a viewport past its scrollport,
  // moved down by its scroll, and what it set aside keeps its scroll height
  const clock = holdClock(t, resizeClock);
  const side =
    '<div id="side" style="height:200px;overflow:auto">' +
    Array.from(
      { length: 80 },
      (_, i) => `<div id="s${i}" style="height:20px"></div>`,
    ).join('') +
    '</div>';
  const { el, resize } = await renderScrolled(
    LONG.replace('<body style="margin:0">', `<body style="margin:0">${side}`),
    300,
    400,
  );
  const sidebar = findById(el.document, 'side')!;
  await resize(300, 390);
  await resize(300, 380);
  assert.ok(partial(el), 'a step of the drag');
  assert.ok(reached(el, 's20'), 'what it shows, and a viewport more');
  assert.ok(!reached(el, 's40'), 'and no further');
  assert.strictEqual(el.scrollStateOf(sidebar)?.height, 1600, 'as tall');
  await clock.finish();
  assert.ok(reached(el, 's79'), 'all of it once the width rests');

  // scrolled down, it lays out where it is scrolled to, and stays there
  el.scrollElementTo(sidebar, { y: 1000 });
  await resize(300, 370);
  await resize(300, 360);
  assert.ok(partial(el));
  assert.ok(reached(el, 's50') && reached(el, 's58'), 'what it shows there');
  assert.strictEqual(el.scrollStateOf(sidebar)?.y, 1000, 'where it was');
  assert.strictEqual(el.scrollStateOf(sidebar)?.height, 1600);
});

test('a dragged width takes the density an image below where it stops shows into its box, which the layout at rest lays out', async (t) => {
  // BBC's images are `w` candidates with a `sizes` in `vw`: each step of a
  // drag shows another density, taken into the box in place — the box of
  // an image the layout set aside too, or the layout at rest lays it out
  // at the size of the step it was last laid out at
  const clock = holdClock(t, resizeClock);
  const images = {
    'small.png': solidPng(20, 10, [255, 0, 0]),
    'large.png': solidPng(40, 20, [0, 0, 255]),
  };
  const img = (id: string) =>
    `<img id="${id}" style="display:block" srcset="small.png 20w, large.png 40w" sizes="10vw">`;
  const { el, resize } = await renderScrolled(
    LONG.replace(
      '<body style="margin:0">',
      `<body style="margin:0">${img('top')}`,
    ).replace('<div id="end"', `${img('low')}<div id="end"`),
    300,
    400,
    {
      onResource: (r: { url: string; kind: string }) =>
        r.kind === 'image' && r.url in images
          ? {
              kind: 'image' as const,
              bytes: images[r.url as keyof typeof images],
            }
          : null,
    },
  );
  await waitFor(() => assert.strictEqual(boxOf(el, 'low').width, 40));
  const tree = (el as unknown as { _tree: unknown })._tree;
  await resize(300, 390);
  await resize(300, 380);
  assert.ok(partial(el), 'a step of the drag');
  assert.strictEqual(
    (el as unknown as { _tree: unknown })._tree,
    tree,
    'the same boxes',
  );
  assert.strictEqual(boxOf(el, 'top').width, 38, '10vw');
  assert.ok(!reached(el, 'low'), 'set aside');
  await clock.finish();
  assert.ok(!partial(el));
  assert.strictEqual(
    boxOf(el, 'low').width,
    38,
    'laid out at the density it shows',
  );
});

test('a dragged width keeps the rows of a grid below where it stops as they were, and lays them out once it rests', async (t) => {
  // Next.js's blog is a grid of cards, and every card was laid out at
  // every step of a drag: the rows below the window keep the sizes they
  // had, and their cards are set aside as a block's children are
  const clock = holdClock(t, resizeClock);
  const cards = (rows: string, extra = '') =>
    `<div id="grid" style="display:grid;grid-template-columns:repeat(3,1fr);` +
    `grid-auto-rows:${rows};gap:10px${extra}">` +
    Array.from(
      { length: 90 },
      (_, i) =>
        `<div id="c${i}" style="background:#${((i * 30) % 256).toString(16).padStart(2, '0')}4080">` +
        `card ${i}${i % 4 ? '' : ' with a longer title that wraps'}</div>`,
    ).join('') +
    '</div><div id="end" style="height:10px"></div>';
  const { el, resize } = await renderScrolled(
    `<body style="margin:0">${cards('minmax(50px,auto)')}</body>`,
    300,
    400,
  );
  const tall = boxOf(el, 'grid').height;
  await resize(300, 390);
  await resize(300, 380);
  assert.ok(partial(el), 'a step of the drag');
  assert.ok(reached(el, 'c20'), 'what can be seen, and a viewport more');
  assert.ok(!reached(el, 'c60') && !reached(el, 'c89'), 'and no further');
  assert.strictEqual(boxOf(el, 'grid').height, tall, 'as tall as it was');
  const seen = shown(await fillsOf(el), 300);
  await clock.finish();
  assert.ok(!partial(el));
  assert.ok(reached(el, 'c89'), 'all of it once the width rests');
  assert.deepStrictEqual(
    shown(await fillsOf(el), 300),
    seen,
    'what can be seen drawn as the whole layout draws it',
  );

  // and a grid whose rows share something out among them is laid out
  // whole: rows that are shares, a height of its own, an item that spans
  for (const [rows, extra] of [
    ['1fr', ''],
    ['minmax(50px,auto)', ';height:3000px'],
    ['minmax(50px,auto)', ';min-height:3000px'],
  ]) {
    cleanup();
    const doc = await renderScrolled(
      `<body style="margin:0">${cards(rows, extra)}</body>`,
      300,
      400,
    );
    await doc.resize(300, 390);
    await doc.resize(300, 380);
    assert.ok(reached(doc.el, 'c89'), `laid out whole: ${rows}${extra}`);
  }
  cleanup();
  const spans = await renderScrolled(
    `<body style="margin:0">${cards('minmax(50px,auto)').replace(
      'id="c3"',
      'id="c3" style="grid-row:span 30"',
    )}</body>`,
    300,
    400,
  );
  await spans.resize(300, 390);
  await spans.resize(300, 380);
  assert.ok(reached(spans.el, 'c89'), 'an item spans where it would stop');
});

test('a dragged width draws the rows of a grid it keeps as the whole layout at rest does, over generated grids', async (t) => {
  // rows of every kind of track a cut keeps or refuses, items that span
  // columns and rows, aligned and stretched, with a grid inside some, and
  // what can be seen at a step held to what the layout at rest draws there
  const clock = holdClock(t, resizeClock);
  const random = mulberry32(11);
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)];
  for (let doc = 0; doc < 24; doc += 1) {
    const rows = pick(['auto', 'minmax(40px,auto)', '60px', 'min-content']);
    const align = pick(['stretch', 'start', 'center', 'end']);
    const items = Array.from(
      { length: 60 + Math.floor(random() * 40) },
      (_, i) => {
        const span = random() < 0.15 ? `grid-column:span 2;` : '';
        const down = random() < 0.05 ? `grid-row:span 2;` : '';
        const inner =
          random() < 0.1
            ? '<div style="display:grid;grid-template-columns:1fr 1fr">' +
              '<b>a</b><b>b</b><b>c</b></div>'
            : '';
        const words = 'word '.repeat(1 + Math.floor(random() * 12));
        return (
          `<div style="${span}${down}padding:${Math.floor(random() * 8)}px;` +
          `background:#${Math.floor(random() * 0xffffff)
            .toString(16)
            .padStart(6, '0')}">` +
          `${words}${inner}</div>`
        );
      },
    ).join('');
    const source =
      `<body style="margin:0"><p>${'lead '.repeat(Math.floor(random() * 40))}</p>` +
      `<div style="display:grid;grid-template-columns:repeat(${2 + Math.floor(random() * 3)},1fr);` +
      `grid-auto-rows:${rows};align-items:${align};gap:${Math.floor(random() * 12)}px">` +
      `${items}</div><p>after</p></body>`;
    const { el, resize } = await renderScrolled(source, 300, 400);
    let width = 400;
    for (let step = 0; step < 3; step += 1) {
      width -= 4 + Math.floor(random() * 6);
      await resize(300, width);
    }
    const seen = shown(await fillsOf(el), 300);
    const stopped = partial(el);
    await clock.finish();
    assert.ok(!partial(el));
    assert.deepStrictEqual(
      shown(await fillsOf(el), 300),
      seen,
      `document ${doc} (${rows}, ${align}, ${stopped ? 'stopped' : 'whole'})`,
    );
    cleanup();
  }
});

test('a dragged width keeps the rows of a table below where it stops as they were, and lays them out once it rests', async (t) => {
  // Wikipedia's list of countries is one table of some 250 rows, and
  // every row was laid out at every step of a drag: the rows below the
  // window keep their heights, their cells are not laid out, and the rows
  // are set aside in their groups
  const clock = holdClock(t, resizeClock);
  const table = (extra = '', cell = (i: number) => `row ${i}`) =>
    `<table id="t" style="width:100%;border-collapse:collapse${extra}">` +
    '<thead><tr><th>name</th><th>value</th></tr></thead><tbody>' +
    Array.from(
      { length: 80 },
      (_, i) =>
        `<tr id="r${i}"><td style="background:#${((i * 37) % 256).toString(16).padStart(2, '0')}6080">` +
        `${cell(i)}${i % 5 ? '' : ' with more words that wrap at a narrow width'}` +
        `</td><td>${i * 13}</td></tr>`,
    ).join('') +
    '</tbody><tfoot><tr id="foot"><td>total</td><td>1</td></tr></tfoot></table>' +
    '<div id="end" style="height:10px"></div>';
  const { el, resize } = await renderScrolled(
    `<body style="margin:0">${table()}</body>`,
    300,
    400,
  );
  const tall = boxOf(el, 't').height;
  await resize(300, 390);
  await resize(300, 380);
  assert.ok(partial(el), 'a step of the drag');
  assert.ok(reached(el, 'r10'), 'what can be seen, and a viewport more');
  assert.ok(!reached(el, 'r60') && !reached(el, 'foot'), 'and no further');
  assert.strictEqual(boxOf(el, 't').height, tall, 'as tall as it was');
  const seen = shown(await fillsOf(el), 300);
  await clock.finish();
  assert.ok(!partial(el));
  assert.ok(reached(el, 'r79') && reached(el, 'foot'), 'all of it at rest');
  assert.deepStrictEqual(
    shown(await fillsOf(el), 300),
    seen,
    'what can be seen drawn as the whole layout draws it',
  );

  // and a table whose height is shared out among its rows, or with a cell
  // across where it would stop, is laid out whole
  for (const [extra, what] of [
    [';height:6000px', 'a height of its own'],
    [';min-height:6000px', 'a least one'],
  ]) {
    cleanup();
    const doc = await renderScrolled(
      `<body style="margin:0">${table(extra)}</body>`,
      300,
      400,
    );
    await doc.resize(300, 390);
    await doc.resize(300, 380);
    assert.ok(reached(doc.el, 'r79'), `laid out whole: ${what}`);
  }
  cleanup();
  const spans = await renderScrolled(
    `<body style="margin:0">${table().replace(
      '<tr id="r3"><td',
      '<tr id="r3"><td rowspan="40"',
    )}</body>`,
    300,
    400,
  );
  await spans.resize(300, 390);
  await spans.resize(300, 380);
  assert.ok(reached(spans.el, 'r79'), 'a cell spans where it would stop');
});

test('a dragged width draws the rows of a table it keeps as the whole layout at rest does, over generated tables', async (t) => {
  // spans across and down, cells aligned every way, collapsed and
  // separated borders, a table in a cell, captions, and what can be seen
  // at a step held to what the layout at rest draws there
  const clock = holdClock(t, resizeClock);
  let stops = 0;
  const random = mulberry32(23);
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)];
  for (let doc = 0; doc < 20; doc += 1) {
    const columns = 2 + Math.floor(random() * 3);
    const rows: string[] = [];
    let spanned = 0;
    for (let r = 0; r < 70 + Math.floor(random() * 30); r += 1) {
      const cells: string[] = [];
      let c = spanned > 0 ? 1 : 0;
      if (spanned > 0) spanned -= 1;
      while (c < columns) {
        const across = c + 1 < columns && random() < 0.1 ? 2 : 1;
        const down = c === 0 && spanned === 0 && random() < 0.04 ? 3 : 1;
        if (down > 1) spanned = down - 1;
        const va = pick(['baseline', 'top', 'middle', 'bottom']);
        const inner =
          random() < 0.05 ? '<table><tr><td>a</td><td>b</td></tr></table>' : '';
        cells.push(
          `<td colspan="${across}" rowspan="${down}" style="vertical-align:${va};` +
            `padding:${Math.floor(random() * 6)}px;` +
            `background:#${Math.floor(random() * 0xffffff)
              .toString(16)
              .padStart(6, '0')}">` +
            `${'word '.repeat(1 + Math.floor(random() * 10))}${inner}</td>`,
        );
        c += across;
      }
      rows.push(`<tr>${cells.join('')}</tr>`);
    }
    rows.push('<tr id="last"><td>the last row</td></tr>');
    const collapse = pick(['collapse', 'separate']);
    const source =
      `<body style="margin:0"><p>${'lead '.repeat(Math.floor(random() * 40))}</p>` +
      `<table style="border-collapse:${collapse};border:1px solid #333;` +
      `border-spacing:${Math.floor(random() * 4)}px">` +
      (random() < 0.3 ? '<caption>a caption</caption>' : '') +
      `<tbody>${rows.join('')}</tbody></table><p>after</p></body>`;
    const { el, resize } = await renderScrolled(source, 300, 400);
    let width = 400;
    for (let step = 0; step < 3; step += 1) {
      width -= 4 + Math.floor(random() * 6);
      await resize(300, width);
    }
    const seen = shown(await fillsOf(el), 300);
    // the table's own rows set aside, and not only what follows it
    const stopped = partial(el) && !reached(el, 'last');
    await clock.finish();
    assert.ok(!partial(el));
    assert.deepStrictEqual(
      shown(await fillsOf(el), 300),
      seen,
      `document ${doc} (${collapse}, ${stopped ? 'stopped' : 'whole'})`,
    );
    if (stopped) stops += 1;
    cleanup();
  }
  assert.ok(stops >= 10, `${stops} of 20 stopped inside the table`);
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

test('a dragged width restyles what it set aside, which the layout at rest lays out in its new style', async (t) => {
  // A step that takes a `vw` in place restyles the boxes from the elements
  // its new viewport reaches, and the last step set some of them aside: a
  // walk down the boxes the paint finds went past them, and the layout at
  // rest laid them out in the style of the step before — text below the
  // fold at the last width's size, and a box at its width.
  const clock = holdClock(t, resizeClock);
  const doc =
    '<body style="margin:0;font-size:calc(8px + 2vw)">' +
    Array.from(
      { length: 80 },
      (_, i) =>
        `<p id="p${i}" style="margin:0;width:90vw">paragraph ${i}, ` +
        'with words enough to wrap</p>',
    ).join('') +
    '</body>';
  const { el, resize } = await renderScrolled(doc, 300, 400);
  await resize(300, 330);
  await resize(300, 320);
  await resize(300, 310);
  assert.ok(partial(el), 'a step');
  assert.ok(!reached(el, 'p79'), 'with the end set aside');
  await clock.finish();
  assert.ok(!partial(el), 'rested');
  const tree = (el as unknown as { _tree: BoxTree })._tree;
  const stale: string[] = [];
  const stack = [tree.root];
  while (stack.length) {
    const box = stack.pop()!;
    const kept = box.el && !box.pseudo ? tree.styles.get(box.el) : undefined;
    if (box.kind !== 'text' && kept && kept.style !== box.style) {
      stale.push(String(box.el!.attribs.id));
    }
    stack.push(...box.children);
  }
  assert.deepStrictEqual(stale, [], 'every box in its element’s style');
  const drawn = ['p0', 'p40', 'p79'].map((id) => geometry(boxOf(el, id)));
  await cleanup();
  const fresh = await renderScrolled(doc, 300, 310);
  assert.deepStrictEqual(
    drawn,
    ['p0', 'p40', 'p79'].map((id) => geometry(boxOf(fresh.el, id))),
    'laid out as the document at that width is',
  );
});

test('a dragged width that builds again what holds a vw goes on laying out what can be seen', async (t) => {
  // A `vw` a box's text is spaced by builds the boxes again at every step, and
  // the tree it builds is laid out as a crossing's is: down to what can be
  // seen, sized from all it holds. Laid out whole, a long page was all of
  // it at every step.
  holdClock(t, resizeClock);
  const vw = '<style>#r0{margin-left:10vw;letter-spacing:1vw}</style>';
  const { el, resize } = await renderScrolled(
    LONG.replace('<body style="margin:0">', `${vw}<body style="margin:0">`),
    300,
    400,
  );
  const treeOf = (): BoxTree => (el as unknown as { _tree: BoxTree })._tree;
  let tree = treeOf();
  await resize(300, 390);
  assert.notStrictEqual(treeOf(), tree, 'built again');
  assert.strictEqual(boxOf(el, 'r0').x, 39, 'at the new width');
  assert.ok(partial(el), 'and laid out down to what can be seen');
  assert.ok(!reached(el, 'end'));
  tree = treeOf();
  await resize(300, 380);
  assert.notStrictEqual(treeOf(), tree);
  assert.strictEqual(boxOf(el, 'r0').x, 38);
  assert.ok(partial(el), 'at every step');
  await cleanup();

  // and one that holds a fixed box below where it stops lays out what holds
  // it, at every step, and stops: it had been laid out whole after its
  // first step set the box aside, and once more at every step after that
  const fixed =
    '<div id="foot"><div id="fixed" style="position:fixed;top:0;' +
    'right:0;width:20px;height:20px"></div></div>';
  const inside = await renderScrolled(
    LONG.replace(
      '<body style="margin:0">',
      `${vw}<body style="margin:0">`,
    ).replace('</body>', `${fixed}</body>`),
    300,
    400,
  );
  const insideTree = (): BoxTree =>
    (inside.el as unknown as { _tree: BoxTree })._tree;
  for (const width of [390, 380]) {
    await inside.resize(300, width);
    assert.ok(partial(inside.el), `stopped at ${width}`);
    assert.ok(!laidWhole(insideTree()));
    assert.ok(reached(inside.el, 'fixed') && !reached(inside.el, 'end'));
    assert.strictEqual(boxOf(inside.el, 'fixed').x, width - 20);
  }
  assert.strictEqual(boxOf(inside.el, 'r0').x, 38);
  await cleanup();

  // and a `vw` that moves nothing but a block's lengths builds nothing: the
  // boxes are kept, and laid out down to what can be seen at every step
  const lengths = await renderScrolled(
    LONG.replace(
      '<body style="margin:0">',
      '<style>#r0{margin-left:10vw}</style><body style="margin:0">',
    ),
    300,
    400,
  );
  const lengthsTree = (): BoxTree =>
    (lengths.el as unknown as { _tree: BoxTree })._tree;
  const kept = lengthsTree();
  await lengths.resize(300, 390);
  await lengths.resize(300, 380);
  assert.strictEqual(lengthsTree(), kept, 'built again');
  assert.strictEqual(boxOf(lengths.el, 'r0').x, 38);
  assert.ok(partial(lengths.el), 'laid out down to what can be seen');
});

// A dragged width lays out from the top of what can be seen: the blocks
// that ended above it keep their boxes and their place, and what follows is
// laid out from where they ended (`keepAbove`). The pane that scrolls the
// document keeps what is at its top where it is on screen while the text
// above it comes to more or less (`_keepAnchor`, react-x11's
// `anchorScrollBy`), and the blocks kept are laid out once the width rests.

/** Forty sections of a heading and a paragraph that wraps, one with
 *  `extra` in it. */
const textLong = (extra = '', at = -1): string =>
  '<body style="margin:0">' +
  Array.from(
    { length: 40 },
    (_, i) =>
      `<section id="s${i}"><h2 id="h${i}" style="margin:8px 0">Part ${i}</h2>` +
      (i === at ? extra : '') +
      `<p id="p${i}" style="margin:0 0 8px">` +
      'the quick brown fox jumps over the lazy dog '.repeat(6) +
      '</p></section>',
  ).join('') +
  '</body>';

type Laid = ReturnType<typeof boxOf>;

/** Lay the element's tree out again, at `width`, keeping what ended above
 *  `above` and setting aside what starts below `until`. */
function layOut(
  el: HtmlViewNode,
  width: number,
  above?: number,
  until?: number,
): { partial: boolean } {
  const node = el as unknown as {
    _tree: BoxTree;
    _layoutFonts(): FontsLike;
  };
  return layoutDocument(
    node._tree,
    node._layoutFonts(),
    width,
    300,
    1,
    until,
    above,
  );
}

const held = (el: HtmlViewNode, box: Laid): boolean =>
  heldBack((el as unknown as { _tree: BoxTree })._tree, box as never);

const geometry = (box: Laid) => [box.x, box.y, box.width, box.height];

metric(
  'a layout from the top of what can be seen keeps the blocks above it as they were, and lays out what follows from where they ended',
  async () => {
    const { el } = await renderScrolled(textLong(), 300, 400);
    const sections = Array.from({ length: 40 }, (_, i) => boxOf(el, `s${i}`));
    const was = sections.map(geometry);
    const top = sections[20].y + 1;
    const result = layOut(el, 300, top, top + 600);
    assert.ok(result.partial, 'it stopped');
    for (let i = 0; i < 20; i += 1) {
      assert.ok(held(el, sections[i]), `s${i} kept`);
      assert.deepStrictEqual(geometry(sections[i]), was[i], `s${i} as it was`);
    }
    // the first laid out where it was, at the new width, and taller for it
    assert.ok(!held(el, sections[20]));
    assert.strictEqual(sections[20].y, was[20][1], 'where it was');
    assert.strictEqual(sections[20].width, 300, 'at the new width');
    assert.ok(sections[20].height > was[20][3], 'its text broken again');
    assert.strictEqual(
      sections[21].y - (sections[20].y + sections[20].height),
      was[21][1] - (was[20][1] + was[20][3]),
      'and what follows after it, with the margin between them',
    );
    assert.ok(held(el, sections[39]), 'and the rest set aside below');
    // laid out whole after, it is what a layout of the whole always was
    layOut(el, 300);
    const whole = sections.map(geometry);
    layOut(el, 400);
    layOut(el, 300);
    assert.deepStrictEqual(sections.map(geometry), whole);
  },
);

metric(
  'a block above whose float reaches past where the layout starts is laid out, and what is above it kept',
  async () => {
    const float =
      '<div style="float:right;width:40px;height:2000px;background:#08f"></div>';
    const { el } = await renderScrolled(textLong(float, 5), 300, 400);
    const sections = Array.from({ length: 40 }, (_, i) => boxOf(el, `s${i}`));
    const top = sections[10].y + 1;
    assert.ok(sections[5].y + 2000 > top, 'the float reaches past it');
    layOut(el, 300, top, top + 600);
    for (let i = 0; i < 5; i += 1) assert.ok(held(el, sections[i]), `s${i}`);
    for (let i = 5; i <= 10; i += 1) {
      assert.ok(!held(el, sections[i]), `s${i} laid out, beside the float`);
    }
  },
);

metric(
  'a block above that holds a box placed against one outside it is laid out',
  async () => {
    const placed =
      '<div style="position:absolute;top:4px;right:4px;width:10px;height:10px"></div>';
    const { el } = await renderScrolled(textLong(placed, 3), 300, 400);
    const sections = Array.from({ length: 40 }, (_, i) => boxOf(el, `s${i}`));
    const top = sections[10].y + 1;
    layOut(el, 300, top, top + 600);
    for (let i = 0; i < 3; i += 1) assert.ok(held(el, sections[i]), `s${i}`);
    assert.ok(!held(el, sections[3]), 'the one that holds it');
    assert.ok(!held(el, sections[9]), 'and all after it');
  },
);

metric(
  'what a box as tall as the viewport holds past its bottom is kept in it',
  async () => {
    const { el } = await renderScrolled(
      textLong().replace(
        '<body style="margin:0">',
        '<style>html,body{height:100%}</style><body style="margin:0">',
      ),
      300,
      400,
    );
    const sections = Array.from({ length: 40 }, (_, i) => boxOf(el, `s${i}`));
    assert.ok(sections[20].y > 300, 'past the body’s bottom');
    const top = sections[20].y + 1;
    layOut(el, 300, top, top + 600);
    assert.ok(held(el, sections[0]) && held(el, sections[19]));
    assert.ok(!held(el, sections[20]));
  },
);

metric(
  'the column of a grid what can be seen is in keeps what is above it, beside the one that holds nothing there',
  async () => {
    const { el } = await renderScrolled(
      textLong()
        .replace(
          '<body style="margin:0">',
          '<body style="margin:0"><div style="display:grid;' +
            'grid-template-columns:60px 1fr"><nav id="nav">menu</nav><main>',
        )
        .replace('</body>', '</main></div></body>'),
      300,
      400,
    );
    const sections = Array.from({ length: 40 }, (_, i) => boxOf(el, `s${i}`));
    const top = sections[20].y + 1;
    layOut(el, 300, top, top + 600);
    assert.ok(held(el, sections[0]) && held(el, sections[19]));
    assert.ok(!held(el, sections[20]));
    assert.ok(!held(el, boxOf(el, 'nav')), 'the menu beside it');
  },
);

interface Pane {
  scrollTo(y: number): void;
  scrollY: number;
  isScroller?(): boolean;
  parent: Pane | null;
}

/** The pane that scrolls the element in `renderScrolled`. */
function paneOf(el: HtmlViewNode): Pane {
  let pane = (el as unknown as { parent: Pane | null }).parent;
  while (pane && !pane.isScroller?.()) pane = pane.parent;
  assert.ok(pane, 'a pane scrolls it');
  return pane;
}

/** Where a block of the document is in the window: what the reader sees. */
const onScreen = (el: HtmlViewNode, box: Laid): number =>
  (el as unknown as { contentBox(): { y: number } }).contentBox().y + box.y;

metric(
  'a dragged width keeps the block at the top of the pane where it is on screen, and lays out from it, at every step and once it rests',
  async (t) => {
    const clock = holdClock(t, resizeClock);
    const { el, resize } = await renderScrolled(textLong(), 300, 400);
    const pane = paneOf(el);
    const anchor = boxOf(el, 's20');
    pane.scrollTo(anchor.y + 10);
    await act();
    const at = onScreen(el, anchor);
    const first = boxOf(el, 's0');
    for (let width = 390; width >= 310; width -= 10) {
      await resize(300, width);
      assert.ok(partial(el), `${width}: a step`);
      assert.ok(held(el, first), `${width}: what is above kept`);
      assert.strictEqual(onScreen(el, anchor), at, `${width}: in place`);
    }
    // rested: laid out whole, the text above it broken into more lines,
    // and the pane's offset moved by as much
    const scrolled = pane.scrollY;
    await clock.finish();
    assert.ok(!partial(el), 'laid out whole');
    assert.ok(!held(el, first));
    assert.strictEqual(onScreen(el, anchor), at, 'still in place');
    assert.ok(pane.scrollY > scrolled, 'further down a longer document');
  },
);

metric(
  'a dragged width with the document at its top keeps its top there',
  async (t) => {
    const clock = holdClock(t, resizeClock);
    const { el, resize } = await renderScrolled(textLong(), 300, 400);
    const pane = paneOf(el);
    await resize(300, 390);
    await resize(300, 380);
    await clock.finish();
    assert.strictEqual(pane.scrollY, 0);
  },
);

/** A document mounted in `style`'s box, what `_update` is asked for from
 *  then on, and a change that has to be laid out. */
async function mounted(style: Record<string, unknown>) {
  await renderX11(
    h(
      'box',
      { style },
      h(Html, {
        source:
          '<style>.on{display:flex}' +
          '@media (max-width:100px){p{font-size:30px}}</style>' +
          '<body style="margin:0"><p id="p">one two three</p></body>',
        style: { flexGrow: 1 },
        'data-testname': 'doc',
      }),
    ),
    { width: 440, height: 600, fonts: FONTS! },
  );
  const el = view(screen.getByTestName('doc') as DrawnNode);
  await act();
  const inner = el as unknown as {
    _laidOutWidth: number;
    _documentHeight: number;
    _update(target: number): void;
    measureContent(c: Record<string, unknown>): {
      width: number;
      height: number;
    };
  };
  const updates: number[] = [];
  const update = inner._update;
  inner._update = function (this: unknown, target: number) {
    updates.push(target);
    return update.call(this, target);
  };
  const change = (): void => {
    const p = findById(el.document, 'p')!;
    p.attribs.class = 'on';
    el.touchDocument([
      {
        type: 'attributes',
        target: p,
        attributeName: 'class',
        oldValue: null,
      },
    ]);
  };
  const noRoom = () =>
    inner.measureContent({
      width: 0,
      height: Infinity,
      widthMode: 'exactly',
      heightMode: 'unconstrained',
    });
  return { el, inner, updates, change, noRoom };
}

metric(
  'a document drawn at a width lays nothing out for core’s content floors, across no breakpoint and back',
  async () => {
    // a row's items are asked what they come to with no room on offer. What
    // a document answers is cut to that, so all a layout could say is a
    // height nothing in the pass reads, and it crossed every breakpoint
    // down and back: Apple's product page built itself twice for each
    const { inner, updates, change, noRoom } = await mounted({
      flexDirection: 'row',
      width: 400,
    });
    assert.ok(inner._laidOutWidth > 100, `at ${inner._laidOutWidth}`);
    const height = inner._documentHeight;
    change();
    updates.length = 0;
    const asked = noRoom();
    assert.strictEqual(asked.width, 0);
    assert.ok(asked.height >= height, `${asked.height} under ${height}`);
    assert.deepStrictEqual(updates, [], 'laid out with no room on offer');
    await act();
    assert.ok(updates.length > 0, 'the change was never laid out');
    assert.ok(
      updates.every((target) => target > 100),
      `${updates}`,
    );
  },
);

metric(
  'a document in a box of no width lays out all the same, since its scripts hear of it from a layout',
  async () => {
    const { el, updates, change, noRoom } = await mounted({ width: 0 });
    assert.ok((el as unknown as { _tree: unknown })._tree, 'nothing was built');
    change();
    updates.length = 0;
    noRoom();
    assert.ok(updates.length > 0, 'it waited for a width it will not get');
  },
);

metric(
  'a layout that answers a question about the document’s size moves nothing on screen',
  async (t) => {
    // core's content floors ask what the document comes to with no room on
    // offer, and it is laid out a pixel or two wide to answer: no layout
    // it is drawn at. Taken for one, the pane went to the end of a document as
    // long as that made it, and back to its top from there
    const clock = holdClock(t, resizeClock);
    const { el, resize } = await renderScrolled(textLong(), 300, 400);
    const pane = paneOf(el);
    const anchor = boxOf(el, 's20');
    pane.scrollTo(anchor.y + 10);
    await act();
    const at = onScreen(el, anchor);
    await resize(300, 390);
    // a while after the drag rested, where the question is answered by a
    // layout of the whole, and the block moves as far as that makes it
    await clock.finish();
    for (let i = 0; i < 20; i += 1) await clock.frame();
    (
      el as unknown as {
        measureContent(c: Record<string, unknown>): unknown;
        invalidate(all: boolean, by: unknown, why: string): void;
      }
    ).measureContent({
      width: 2,
      height: Infinity,
      widthMode: 'exactly',
      heightMode: 'unconstrained',
    });
    await resize(300, 380);
    assert.strictEqual(onScreen(el, anchor), at, 'in place after it');
    await clock.finish();
    assert.strictEqual(onScreen(el, anchor), at, 'and once it rests');
  },
);

metric(
  'a dragged width that crosses a breakpoint keeps the block at the top of the pane where it is',
  async (t) => {
    // the band a drag crosses builds the boxes again: the block is found
    // again by its element, and laid out whole so it is not set aside
    const clock = holdClock(t, resizeClock);
    const { el, resize } = await renderScrolled(
      textLong().replace(
        '<body style="margin:0">',
        '<style>@media (max-width:375px){p{font-size:18px}}</style>' +
          '<body style="margin:0">',
      ),
      300,
      400,
    );
    const pane = paneOf(el);
    const at = () => onScreen(el, boxOf(el, 's20'));
    pane.scrollTo(boxOf(el, 's20').y + 10);
    await act();
    const was = at();
    await resize(300, 390);
    await resize(300, 380);
    await resize(300, 370);
    assert.strictEqual(at(), was, 'across the breakpoint');
    await resize(300, 360);
    await clock.finish();
    assert.strictEqual(at(), was, 'and once it rests');
  },
);

test('a dragged width rests once the window says the drag is over, not at a pause in it', async (t) => {
  // AppKit brackets a drag of a window's edge (`liveResizing`): a pause in
  // it is no rest, and the whole document laid out at every pause held the
  // frame after it
  const clock = holdClock(t, resizeClock);
  const { el, resize } = await renderScrolled(LONG, 300, 400);
  const wnd = (
    el as unknown as { root: { window: { liveResizing?: boolean } } }
  ).root.window;
  wnd.liveResizing = true;
  try {
    await resize(300, 390);
    await resize(300, 380);
    assert.ok(partial(el), 'a step');
    for (let i = 0; i < 40; i += 1) await clock.frame();
    assert.ok(partial(el), 'a pause in the drag lays out nothing more');
  } finally {
    wnd.liveResizing = false;
  }
  await clock.finish();
  assert.ok(!partial(el), 'laid out whole once it is over');
});

// A drag the document cannot keep up with is drawn cheaper while it moves
// (`_behind`): its frames are timed (`frameClock`), and where two of the
// last three drawn as at rest ran past the budget, the next is drawn
// cheaper — where the window says its edge is being dragged
// (`liveResizing`), and until the hand holds still or lets go.

/** The window a document is in, whose edge a drag moves. */
const windowOf = (el: HtmlViewNode) =>
  (el as unknown as { root: { window: { liveResizing?: boolean } } }).root
    .window;

const cheap = (el: HtmlViewNode): boolean =>
  (el as unknown as { _cheap: boolean })._cheap;

/** Each stretch of the document's own work timed at `ms.value`. */
function costing(t: TestContext, ms: { value: number }): void {
  let now = 0;
  t.mock.method(frameClock, 'now', () => (now += ms.value));
}

test('a live drag that falls behind is drawn cheaper from its third frame, at every step after, and as at rest once the hand holds still', async (t) => {
  const clock = holdClock(t, resizeClock);
  const cost = { value: 20 };
  costing(t, cost);
  const { el, resize } = await renderScrolled(LONG, 300, 400);
  const wnd = windowOf(el);
  wnd.liveResizing = true;
  try {
    await resize(300, 396);
    await resize(300, 392);
    assert.ok(!cheap(el), 'two frames past the budget');
    await resize(300, 388);
    assert.ok(cheap(el), 'and the third is drawn cheaper');
    // a frame drawn cheaper is cheap because it is, and says nothing of
    // what one drawn as at rest would cost
    cost.value = 0;
    for (const width of [384, 380, 376, 372]) await resize(300, width);
    assert.ok(cheap(el), 'as is every step after');
    let frames = 0;
    while (cheap(el) && frames < 40) {
      await clock.frame();
      frames += 1;
    }
    assert.ok(!cheap(el), 'drawn as at rest once the hand holds still');
    assert.ok(frames * FRAME_MS >= 300, `and not before: ${frames} frames`);
    // the frames before it fell behind
    await resize(300, 368);
    assert.ok(cheap(el), 'and cheaper again from the next step');
  } finally {
    wnd.liveResizing = false;
  }
  await clock.finish();
  assert.ok(!cheap(el), 'and as at rest once the drag is over');
});

test('a thread busy past a rest of the hand is no rest of the hand: the drag rests once a timer comes on time', async (t) => {
  // a clock whose timers come when the test says, as late as it likes
  let now = 0;
  const due = new Set<() => void>();
  t.mock.method(resizeClock, 'now', () => now);
  t.mock.method(resizeClock, 'arm', (step: () => void) => {
    due.add(step);
    return step;
  });
  t.mock.method(resizeClock, 'disarm', (step: () => void) => {
    due.delete(step);
  });
  const fire = () =>
    act(async () => {
      const step = [...due].at(-1);
      assert.ok(step, 'a timer is armed');
      due.delete(step);
      step();
    });
  costing(t, { value: 20 });
  const { el, resize } = await renderScrolled(LONG, 300, 400);
  const wnd = windowOf(el);
  wnd.liveResizing = true;
  try {
    for (const width of [396, 392, 388]) await resize(300, width);
    assert.ok(cheap(el), 'the drag fell behind');
    // a task of the page's, and the timer comes after it
    now += 700;
    await fire();
    assert.ok(cheap(el), 'the step after it may be waiting behind the timer');
    now += 150;
    await fire();
    assert.ok(!cheap(el), 'and a timer on time finds the hand has stopped');
  } finally {
    wnd.liveResizing = false;
  }
});

test('a drag the document keeps up with, and one the window does not say is live, are drawn as at rest', async (t) => {
  holdClock(t, resizeClock);
  const cost = { value: 0 };
  costing(t, cost);
  const { el, resize } = await renderScrolled(LONG, 300, 400);
  const wnd = windowOf(el);
  wnd.liveResizing = true;
  try {
    for (const width of [396, 392, 388, 384]) await resize(300, width);
    assert.ok(!cheap(el), 'frames inside the budget');
    // two frames past the budget, and the drag let go of
    cost.value = 20;
    await resize(300, 380);
    await resize(300, 376);
  } finally {
    wnd.liveResizing = false;
  }
  await resize(300, 372);
  assert.ok(!cheap(el), 'a width set once the drag is over');
  // X11's window says nothing of a drag
  for (const width of [368, 364, 360, 356]) await resize(300, width);
  assert.ok(!cheap(el), 'a window that says nothing of a drag');
});

test('a drag drawn cheaper makes no frame of the animations, which play on from where their time has got to once it rests', async (t) => {
  const clock = holdClock(t, resizeClock);
  costing(t, { value: 20 });
  // the animations' clock, held apart from the frames it asks for, so that
  // its time can pass while it asks for none
  let time = 0;
  const armed = new Map<object, { step: () => void; at: number }>();
  t.mock.method(animationClock, 'now', () => time);
  t.mock.method(animationClock, 'arm', (step: () => void, ms: number) => {
    const handle = {};
    armed.set(handle, { step, at: time + ms });
    return handle;
  });
  t.mock.method(animationClock, 'disarm', (handle: object) => {
    armed.delete(handle);
  });
  const { el, resize } = await renderScrolled(
    '<style>@keyframes slide { from { margin-left: 0 } to { margin-left: 100px } }' +
      '#a { animation: slide 1600ms linear }</style><p id="a">x</p>',
    300,
    400,
  );
  const left = () =>
    Math.round(
      (boxOf(el, 'a') as unknown as { style: { marginLeft: number } }).style
        .marginLeft,
    );
  assert.ok(armed.size > 0, 'a frame is asked for');
  const wnd = windowOf(el);
  wnd.liveResizing = true;
  try {
    for (const width of [396, 392, 388]) await resize(300, width);
    assert.ok(cheap(el));
    assert.strictEqual(armed.size, 0, 'and none while the drag is cheaper');
    time = 800;
    await resize(300, 384);
    assert.strictEqual(armed.size, 0, 'whatever the time');
    assert.ok(left() < 50, 'where it was');
    for (let i = 0; i < 40 && cheap(el); i += 1) await clock.frame();
    assert.ok(!cheap(el), 'drawn as at rest once the hand holds still');
    assert.ok(armed.size > 0, 'and a frame asked for');
    time = 816;
    for (const [handle, { step, at }] of [...armed]) {
      if (at > time) continue;
      armed.delete(handle);
      step();
    }
    await act();
    assert.strictEqual(left(), 51, 'where its time has got to');
  } finally {
    wnd.liveResizing = false;
  }
});

metric(
  'a drag drawn cheaper draws a photograph that covers its box on a step, and once it rests what a paint at rest draws',
  async (t) => {
    const clock = holdClock(t, resizeClock);
    costing(t, { value: 20 });
    const photo = pixelsPng(64, 48, (x, y) => [
      x * 4,
      y * 5,
      ((x ^ y) * 3) & 255,
    ]);
    const doc = (width: number) =>
      h(
        'box',
        { style: { width, height: 200, flexDirection: 'column' } },
        h(
          'box',
          { style: { flexGrow: 1, overflow: 'scroll' } },
          h(Html, {
            source:
              '<style>body{margin:0}' +
              '#p{height:120px;background:url(p.png) center/cover}</style>' +
              '<div id="p"></div>',
            partial: false,
            'data-testname': 'doc',
            onResource: (r: { kind: string }) =>
              r.kind === 'image'
                ? { kind: 'image' as const, bytes: photo }
                : null,
          }),
        ),
      );
    const result = await renderX11(doc(300), {
      width: 400,
      height: 300,
      fonts: FONTS!,
    });
    await act();
    const el = view(screen.getByTestName('doc') as DrawnNode);
    await imagesIn(el);
    const resize = async (width: number) => {
      await act(() => result.rerender(doc(width)));
      await act();
    };
    const wnd = windowOf(el);
    wnd.liveResizing = true;
    let during: Uint8ClampedArray;
    try {
      for (const width of [296, 292, 288, 284]) await resize(width);
      assert.ok(cheap(el));
      during = await snapshot(result, el);
    } finally {
      wnd.liveResizing = false;
    }
    await clock.finish();
    assert.ok(!cheap(el));
    const after = await snapshot(result, el);
    assert.ok(bytesApart(during, after) > 0, 'drawn on a step in the drag');
    assert.strictEqual(
      bytesApart(after, await rebuilt(result, el)),
      0,
      'and as a paint at rest draws it once it rests',
    );
  },
);

metric(
  'a drag drawn cheaper draws a box its paused animation turns from the surface kept for it, where the context would turn it itself',
  async (t) => {
    const clock = holdClock(t, resizeClock);
    holdClock(t, animationClock);
    costing(t, { value: 20 });
    const { el, resize, result } = await renderScrolled(
      '<style>body{margin:0}html{background:#ffffff}' +
        '@keyframes turn { to { transform: rotate(90deg) } }' +
        '#t { width: 40px; height: 40px; margin: 20px; background: #c00000;' +
        ' transform: rotate(10deg); animation: turn 4s linear infinite }' +
        '</style><div id="t"></div>',
      300,
      400,
    );
    // react-x11's macOS context turns a box itself: X11's is said to
    const root = (el as unknown as { root: { _ctx: object } }).root;
    Object.defineProperty(root._ctx, 'scalesText', {
      value: true,
      configurable: true,
    });
    const kept = () =>
      (el as unknown as { _sprites: { size: number } | null })._sprites?.size ??
      0;
    try {
      await rebuilt(result, el);
      assert.strictEqual(kept(), 0, 'turned through its matrix at rest');
      const make = t.mock.method(SpriteStore.prototype, 'make');
      const wnd = windowOf(el);
      wnd.liveResizing = true;
      try {
        for (const width of [396, 392, 388, 384, 380]) await resize(300, width);
        assert.ok(cheap(el));
        assert.ok(kept() > 0, 'from a surface kept in the drag');
        assert.strictEqual(make.mock.callCount(), 1, 'made once');
      } finally {
        wnd.liveResizing = false;
      }
      await clock.finish();
      assert.strictEqual(kept(), 0, 'and through its matrix once it rests');
    } finally {
      delete (root._ctx as { scalesText?: boolean }).scalesText;
    }
  },
);

metric(
  'a dragged width keeps a raster of an inline drawing whose size holds, and makes none of one sized from it',
  async (t) => {
    // The icons of a page do not change as its window's edge moves, and a
    // drawing sized from the width is another size at every step, as a
    // background is
    holdClock(t, resizeClock);
    const doc = (width: number) =>
      h(
        'box',
        { style: { width, height: 300, flexDirection: 'column' } },
        h(Html, {
          source:
            '<style>body{margin:0}svg{display:block}#wide{width:50%}</style>' +
            '<svg width="20" height="20"><rect width="9" height="20"/></svg>' +
            '<svg id="wide" viewBox="0 0 10 2"><rect width="5" height="2"/>' +
            '</svg>',
          partial: false,
          'data-testname': 'doc',
        }),
      );
    const result = await renderX11(doc(300), {
      width: 400,
      height: 400,
      fonts: FONTS!,
    });
    await act();
    const el = view(screen.getByTestName('doc') as DrawnNode);
    for (const width of [296, 292, 288, 292, 296]) {
      await act(() => result.rerender(doc(width)));
      await act();
    }
    const kept = [
      ...((
        el as unknown as { _drawings: { kept: Map<string, unknown> } | null }
      )._drawings?.kept.keys() ?? []),
    ];
    assert.deepStrictEqual(
      kept.map((key) => key.split('|')[2]),
      ['20x20'],
    );
  },
);

metric(
  'a dragged width makes a raster of an image drawn at another size only where the paint before drew that size too',
  async (t) => {
    // Each width of a drag draws a background sized from it at a size of
    // its own, and one the drag comes back to was made into a raster that
    // nothing copied: Zen Garden 214's photographs, at every step of a drag
    // that went back over its widths. A size that holds is kept from its
    // second paint, as at rest.
    const clock = holdClock(t, resizeClock);
    const photo = pixelsPng(64, 48, (x, y) => [x * 4, y * 5, 90]);
    const doc = (width: number) =>
      h(
        'box',
        { style: { width, height: 300, flexDirection: 'column' } },
        h(Html, {
          source:
            '<style>body{margin:0}' +
            '#p{height:100px;background:url(p.png) 0 0/50% auto no-repeat}' +
            '#q{width:60px;height:45px;background:url(p.png) 0 0/60px 45px' +
            ' no-repeat}</style><div id="p"></div><div id="q"></div>',
          partial: false,
          'data-testname': 'doc',
          onResource: (r: { kind: string }) =>
            r.kind === 'image'
              ? { kind: 'image' as const, bytes: photo }
              : null,
        }),
      );
    const result = await renderX11(doc(300), {
      width: 400,
      height: 400,
      fonts: FONTS!,
    });
    await act();
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const resize = async (width: number) => {
      await act(() => result.rerender(doc(width)));
      await act();
    };
    const kept = () => [
      ...((
        el as unknown as { _drawings: { kept: Map<string, unknown> } | null }
      )._drawings?.kept.keys() ?? []),
    ];
    const sizes = (keys: string[]) =>
      keys.map((key) => key.split('|')[2]).sort();
    for (const width of [296, 292, 288, 292, 296]) await resize(width);
    assert.deepStrictEqual(
      sizes(kept()),
      ['60x45'],
      'only the size that held, not the halves of five widths, one of them twice',
    );
    // at rest, a size is kept from its second paint
    void clock;
    t.mock.method(resizeClock, 'now', () => 1e9);
    const repaint = async () => {
      (
        el as unknown as {
          invalidate(all: boolean, by: unknown, why: string): void;
        }
      ).invalidate(false, el, 'props');
      await act();
    };
    await repaint();
    assert.strictEqual(sizes(kept()).length, 1, 'not at its first at rest');
    await repaint();
    assert.strictEqual(sizes(kept()).length, 2, 'and at its second');
  },
);
