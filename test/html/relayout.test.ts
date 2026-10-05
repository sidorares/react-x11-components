// <Html> — layouts kept across passes.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, renderX11, screen, waitFor } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { HtmlViewNode } from '../../src/html/index.js';
import type { FontsLike } from '../../src/html/layout/inline.js';
import { resizeClock } from '../../src/html/node.js';
import { heldBack, layoutDocument } from '../../src/html/layout/block.js';
import type { BoxTree } from '../../src/html/layout/boxes.js';
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
