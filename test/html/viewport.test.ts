// <Html> — the viewport: its units, its height, and what is fixed to it.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { act, cleanup, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import type { HtmlViewNode, ViewportOverflow } from '../../src/html/index.js';
import { parseColor } from '../../src/html/css/values.js';
import {
  FONTS,
  boxOf,
  fillsOf,
  findById,
  h,
  metric,
  pixelsIn,
  render,
  renderScrolled,
  treeOf,
  view,
} from './harness.js';
import type { Fill, LaidBox, PaintOp } from './harness.js';

afterEach(cleanup);

test('html and body at 100% are a window tall, and hold what is longer', async () => {
  // A percentage height on the root element resolves against the initial
  // containing block, the viewport (CSS 2.1 10.1): the usual reset is a
  // window tall, as in a browser. The document is as tall as what
  // overflows it, so a message longer than the window is not cut off.
  const { node } = await render(
    '<html style="height:100%"><body style="height:100%;margin:0">' +
      '<div id="tall" style="height:900px"></div></body></html>',
  );
  const el = view(node) as unknown as {
    _tree: { root: LaidBox };
    _documentHeight: number;
  };
  const html = el._tree.root.children.find(
    (b) => (b as LaidBox & { el?: { name: string } }).el?.name === 'html',
  )!;
  assert.ok(
    html.height < 900,
    `the root element is a window tall: ${html.height}`,
  );
  assert.strictEqual(boxOf(view(node), 'tall').height, 900);
  assert.ok(el._documentHeight >= 900, 'and the document holds all 900px');
});

test('a 100vh page follows the height of the box that scrolls it', async () => {
  // A page's own "fill the window" — a column at least 100vh tall with its
  // footer pushed to the bottom — in a browser's page area. The viewport is
  // the box that scrolls the document, whose height only core's layout
  // decides, so the element read the old one while it was being measured
  // and the page kept the height the window had when it loaded.
  const { el, resize } = await renderScrolled(
    '<body style="margin:0"><div style="min-height:100vh;display:flex;' +
      'flex-direction:column"><div style="flex:1"></div>' +
      '<div id="foot" style="height:20px"></div></div></body>',
    300,
  );
  const bottomOf = (id: string): number => {
    const box = boxOf(el, id);
    return box.y + box.height;
  };
  assert.strictEqual(el.abs.height, 300);
  assert.strictEqual(bottomOf('foot'), 300);
  await resize(500);
  assert.strictEqual(el.abs.height, 500, 'the page grows with the viewport');
  assert.strictEqual(bottomOf('foot'), 500, 'with its footer at the bottom');
  await resize(200);
  assert.strictEqual(el.abs.height, 200, 'and shrinks with it');
  assert.strictEqual(bottomOf('foot'), 200);
});

test("html and body at 100% follow the viewport's height", async () => {
  const { el, resize } = await renderScrolled(
    '<html style="height:100%"><body style="height:100%;margin:0">' +
      '<div id="fill" style="height:100%"></div></body></html>',
    300,
  );
  assert.strictEqual(boxOf(el, 'fill').height, 300);
  await resize(450);
  assert.strictEqual(boxOf(el, 'fill').height, 450);
  assert.strictEqual(el.abs.height, 450);
});

/** A page with an `<html>` and a `<body>` of its own, under `css`. */
const page = (css: string, body: string): string =>
  `<html><head><style>${css}</style></head>` +
  `<body id="body">${body}</body></html>`;

test("the root's overflow is the viewport's, and the document holds all of the page", async () => {
  // CSS Overflow 3, 3.3: the root element's `overflow` goes to the
  // viewport, and the root's own is `visible`. bun.sh's sheet makes its
  // `<html>` a window tall and scrolls it; taken as the root's own, the
  // page was held inside a box a window tall, and the document ended at
  // the window with the footer below it
  const content =
    '<div style="height:600px"></div>' +
    '<div id="b" style="height:100px"></div>';
  const { el } = await renderScrolled(
    page(
      'html{height:100%;overflow-y:scroll;overflow-x:hidden}' +
        'body{margin:0;min-height:100%}',
      content,
    ),
    300,
  );
  assert.strictEqual(el.abs.height, 700, 'as tall as its content');
  const b = boxOf(el, 'b');
  assert.strictEqual(b.y + b.height, 700);
});

test("the body's overflow is the viewport's where the root's is visible", async () => {
  // and the body's own is `visible`: it clips nothing, and is no
  // formatting context of its own
  const hidden = 'body{margin:0;overflow:hidden}';
  const { el } = await renderScrolled(
    page(
      `html{height:100%}${hidden}body{height:100%}`,
      '<div style="height:600px"></div><div style="height:100px"></div>',
    ),
    300,
  );
  assert.strictEqual(el.abs.height, 700, 'the body does not cut it off');
  // a first child's margin collapses through it, and comes out above it
  const margin = await renderScrolled(
    page(hidden, '<div style="margin-top:50px;height:20px"></div>'),
    300,
  );
  assert.strictEqual(boxOf(margin.el, 'body').y, 50);
  assert.strictEqual(boxOf(margin.el, 'body').height, 20);
  // and a float is not its to hold
  const floats = await renderScrolled(
    page(hidden, '<div style="float:left;width:10px;height:100px"></div>'),
    300,
  );
  assert.strictEqual(boxOf(floats.el, 'body').height, 0);
});

test('the body keeps its overflow where the root gives the viewport its own, or either is contained', async () => {
  // then it clips what it holds, and the document is as tall as the
  // viewport it fills
  const tall = '<div style="height:600px"></div>';
  for (const css of [
    'html{height:100%;overflow:hidden}body{margin:0;height:100%;overflow:hidden}',
    'html{height:100%}body{margin:0;height:100%;overflow:hidden;contain:paint}',
    'html{height:100%;contain:layout}body{margin:0;height:100%;overflow:auto}',
  ]) {
    const { el } = await renderScrolled(page(css, tall), 300);
    assert.strictEqual(el.abs.height, 300, css);
  }
  // and paint containment on the root clips as `overflow: clip` would, as
  // Chrome has it: the document ends where the root does
  const { el } = await renderScrolled(
    page('html{height:100px;contain:paint}body{margin:0}', tall),
    300,
  );
  assert.strictEqual(el.abs.height, 100, 'cut at the root');
});

/** The same page with a `<body>` and no `<html>`, as most pages start. */
/** The box of a document's `<html>`, written or implied. */
const htmlOf = (el: unknown): LaidBox => {
  const find = (box: LaidBox): LaidBox | null => {
    if ((box.el as { name?: string } | null)?.name === 'html') return box;
    for (const child of box.children) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  const box = find((el as { _tree: { root: LaidBox } })._tree.root);
  assert.ok(box, 'an html box');
  return box;
};

const bare = (css: string, body: string): string =>
  `<!DOCTYPE html><title>t</title><style>${css}</style>` +
  `<body id="body">${body}</body>`;

/** Hidden both ways, and hidden down alone. */
const H: ViewportOverflow = { x: 'hidden', y: 'hidden' };
const YH: ViewportOverflow = { x: 'auto', y: 'hidden' };

/** What `onViewportOverflow` was told, in order, for a document. */
async function viewportReports(
  source: string,
  props: Record<string, unknown> = {},
) {
  const reports: ViewportOverflow[] = [];
  const onViewportOverflow = (overflow: ViewportOverflow) =>
    reports.push(overflow);
  const rendered = await render(source, 300, { onViewportOverflow, ...props });
  await act();
  return { reports, onViewportOverflow, ...rendered };
}

test('the host is told what the root or the body gave the viewport', async () => {
  // CSS Overflow 3, 3.3: the viewport takes them, `visible` as `auto` and
  // `clip` as `hidden`, and the host's pane is the viewport. Acid2 hides a
  // browser's scrollbars with `html { overflow: hidden }`, and the pane
  // that scrolled the document showed its own
  const tall = '<div style="height:600px"></div>';
  const cases: [string, string, ViewportOverflow][] = [
    ['nothing said', page('', tall), { x: 'auto', y: 'auto' }],
    ['the root', page('html{overflow:hidden}', tall), H],
    ['the body', page('body{overflow:hidden}', tall), H],
    [
      'one axis, the other auto',
      page('body{overflow-x:hidden}', tall),
      { x: 'hidden', y: 'auto' },
    ],
    ['clip is hidden', page('html{overflow:clip}', tall), H],
    [
      "the root's over the body's",
      page('html{overflow:scroll}body{overflow:hidden}', tall),
      { x: 'scroll', y: 'scroll' },
    ],
    [
      'a contained body keeps its own',
      page('body{overflow:hidden;contain:paint}', tall),
      { x: 'auto', y: 'auto' },
    ],
    ['a body with no html', bare('html{overflow:hidden}', tall), H],
    ["that body's own", bare('body{overflow-y:hidden}', tall), YH],
    [
      'a fragment, through the html implied around it',
      `<style>html{overflow:hidden}</style>${tall}`,
      H,
    ],
    [
      'a fragment, through the body the root box stands in for',
      `<style>body{overflow-y:hidden}</style>${tall}`,
      YH,
    ],
  ];
  for (const [name, source, want] of cases) {
    const { reports } = await viewportReports(source);
    assert.deepStrictEqual(reports, [want], name);
    await cleanup();
  }
});

test('the host is told again where a build changes what the viewport has, and only then', async () => {
  const source = page('', '<p>a</p>');
  const { reports, onViewportOverflow, result } = await viewportReports(
    source,
    { stylesheet: 'html{overflow:hidden}' },
  );
  assert.deepStrictEqual(reports, [H]);
  const again = async (stylesheet: string) => {
    await act(() =>
      result.rerender(
        h(
          'box',
          { style: { width: 300, flexDirection: 'column' } },
          h(Html, {
            source,
            partial: false,
            stylesheet,
            onViewportOverflow,
            'data-testname': 'doc',
          }),
        ),
      ),
    );
    await act();
  };
  // restyled, and the same: nothing to tell
  await again('html{overflow:hidden;color:red}');
  assert.deepStrictEqual(reports, [H]);
  await again('body{overflow-x:hidden}');
  assert.deepStrictEqual(reports, [H, { x: 'hidden', y: 'auto' }]);
  await again('');
  assert.deepStrictEqual(reports.at(-1), { x: 'auto', y: 'auto' });
  assert.strictEqual(reports.length, 3);
});

test('a body with no html around it takes its percentage height of the viewport', async () => {
  // The root box stands in for the `<html>` HTML implies around the body,
  // and is the root element: its percentage height is of the viewport
  // (CSS 2.1 10.1, 10.5), and the body's of the root's. Laid out as tall
  // as its flow, as the initial containing block is, the root had no
  // height to give, and the body's `height: 100%` was `auto`
  const { el, resize } = await renderScrolled(
    bare(
      'html{height:100%}body{margin:0;height:100%}',
      '<div style="height:10px"></div>',
    ),
    300,
  );
  assert.strictEqual(boxOf(el, 'body').height, 300);
  assert.strictEqual(el.abs.height, 300);
  await resize(450);
  assert.strictEqual(boxOf(el, 'body').height, 450, 'and follows it');
  assert.strictEqual(el.abs.height, 450);
  // and a body that clips is the viewport tall to clip at
  const tall = '<div style="height:600px"></div>';
  for (const css of [
    'html{height:100%;overflow:hidden}body{margin:0;height:100%;overflow:hidden}',
    'html{height:100%}body{margin:0;height:100%;overflow:hidden;contain:paint}',
  ]) {
    const clipped = await renderScrolled(bare(css, tall), 300);
    assert.strictEqual(boxOf(clipped.el, 'body').height, 300, css);
    assert.strictEqual(clipped.el.abs.height, 300, css);
  }
});

test('the html implied around a body with no html keeps its margins to itself', async () => {
  // The root box stands in for that `<html>`, the root element, whose
  // margins collapse with nothing (CSS 2.1 8.3.1). Its top margin was
  // handed to the flow as the margin pending before the body, as a
  // fragment's root box standing in for a body has its own, so it
  // collapsed with the body's: Chrome sets the body 20 + 30 down, and so
  // did the same page here written with an `<html>`, where the body stood
  // at 30. Each case has the body's top and the document's height, which
  // the explicit `<html>` gives as well, and Chrome; the first body, the
  // root's content height tall, runs 30px out of the root's bottom.
  const written = (css: string, body: string): string =>
    `<!DOCTYPE html><html><head><title>t</title><style>${css}</style>` +
    `</head><body id="body">${body}</body></html>`;
  const cases: [string, string, number, number][] = [
    [
      'html{height:50%;margin-top:20px}body{margin:30px 0 0;height:100%}',
      '<div style="height:10px"></div>',
      50,
      200,
    ],
    // the body's margins still collapse with its first and last block's,
    // inside the root's
    [
      'html{margin:20px 0 25px}body{margin:30px 0 35px}',
      '<div style="height:10px;margin:40px 0 45px"></div>',
      60,
      140,
    ],
    // and padding on the root is between the two
    [
      'html{margin-top:20px;padding-top:1px}body{margin:30px 0 0}',
      '<div style="height:10px;margin-top:40px"></div>',
      61,
      71,
    ],
  ];
  for (const [css, inner, top, height] of cases) {
    for (const source of [bare(css, inner), written(css, inner)]) {
      const { el } = await renderScrolled(source, 300);
      const what = `${source.includes('<html>') ? 'written' : 'bare'} ${css}`;
      assert.strictEqual(boxOf(el, 'body').y, top, what);
      assert.strictEqual(el.abs.height, height, what);
    }
  }
});

test('the element the root box stands in for is drawn inside its margins', async () => {
  // Where the markup writes no element for it, the root box is the box of
  // the one it stands in for: the `<html>` implied around a `<body>`, or a
  // fragment's body. Its margins were folded into its padding, which kept
  // what is in it where it belongs and drew its border at the window's
  // edge, the whole width across and down past the body. Chrome draws it
  // inset by the margins, as it does an element written in the markup.
  const red = parseColor('red');
  /** The rectangle a box's border sides are drawn over. */
  const ring = (fills: Fill[]): number[] => {
    const sides = fills.filter((f) => f.style === red);
    assert.ok(sides.length, 'a border is drawn');
    const x = Math.min(...sides.map((f) => f.x));
    const y = Math.min(...sides.map((f) => f.y));
    return [
      x,
      y,
      Math.max(...sides.map((f) => f.x + f.w)) - x,
      Math.max(...sides.map((f) => f.y + f.h)) - y,
    ];
  };
  // the implied `<html>`: Chrome's is at 20, 20, 160 × 60, the body 35 down
  const { el } = await renderScrolled(
    bare(
      'html{margin:20px;border:5px solid red}' +
        'body{margin:10px;background:#f4a261;height:30px}',
      '',
    ),
    120,
    200,
  );
  const fills = await fillsOf(el);
  assert.deepStrictEqual(ring(fills), [20, 20, 160, 60]);
  assert.strictEqual(boxOf(el, 'body').y, 35);
  // the body's background is the canvas's, and covers all of it still
  const ground = fills.find((f) => f.style === parseColor('#f4a261'));
  assert.deepStrictEqual(
    ground && [ground.x, ground.y, ground.w],
    [0, 0, 200],
    `the canvas: ${JSON.stringify(ground)}`,
  );
  // A fragment's body, drawn and laid out where the same body in an
  // `<html>` is. A body is a block in the `<html>` around it, so its top
  // margin collapses with its first block's only where nothing parts them:
  // with a border or padding on top, folded as well, it collapsed through
  // them, and the paragraph stood its own margin higher than Chrome puts
  // it, at 41 for Chrome's 16px one.
  const written = (css: string, body: string): string =>
    `<!DOCTYPE html><html><head><style>${css}</style></head>` +
    `<body>${body}</body></html>`;
  const fragment = (css: string, body: string): string =>
    `<style>${css}</style>${body}`;
  const cases: [string, string, number[]][] = [
    // Chrome: body 20, 20, 160 wide; the paragraph 25 across
    [
      'body{margin:20px;border:5px solid red}',
      '<p id="p">hi</p>',
      [20, 20, 160],
    ],
    [
      'body{margin:20px;border-top:5px solid red}',
      '<p id="p">hi</p>',
      [20, 20, 160],
    ],
    // with no border on top, the body starts where its margin and the
    // paragraph's end: Chrome's at 20, 40
    [
      'body{margin:20px 20px 30px;border-left:4px solid red}',
      '<p id="p" style="margin:40px 0 50px">hi</p>',
      [20, 40, 4],
    ],
  ];
  for (const [css, body, chrome] of cases) {
    const ours = await renderScrolled(fragment(css, body), 120, 200);
    const theirs = await renderScrolled(written(css, body), 120, 200);
    const drawn = ring(await fillsOf(ours.el));
    assert.deepStrictEqual(drawn.slice(0, 3), chrome, css);
    assert.deepStrictEqual(drawn, ring(await fillsOf(theirs.el)), css);
    const p = boxOf(ours.el, 'p');
    const q = boxOf(theirs.el, 'p');
    assert.deepStrictEqual([p.x, p.y], [q.x, q.y], `${css}: the paragraph`);
    assert.strictEqual(ours.el.abs.height, theirs.el.abs.height, css);
  }
  // and a body's own background, where the `<html>` has one, is drawn in
  // the body's box: Chrome's at 20, 20, 160 wide
  const white = parseColor('#fff');
  const own = await renderScrolled(
    fragment(
      'html{background:#ddd}body{margin:20px;background:#fff}',
      '<p>hi</p>',
    ),
    120,
    200,
  );
  const sheet = (await fillsOf(own.el)).find((f) => f.style === white);
  assert.deepStrictEqual(
    sheet && [sheet.x, sheet.y, sheet.w],
    [20, 20, 160],
    `the body's background: ${JSON.stringify(sheet)}`,
  );
});

test('the element the root box stands in for is as wide as its width and margins say', async () => {
  // Where the markup writes no element for it, the root box is the box of
  // the one it stands in for: a fragment's body, or the `<html>` implied
  // around a `<body>`. It was the window wide whatever that element said,
  // its `auto` margins none, so a body set `max-width: 100px; margin: 0
  // auto` stood at the window's left edge, 200 wide, where Chrome centres
  // it, as it does the same body written in an `<html>`. Each case has
  // Chrome's x and width at 200 × 120, for the element and the paragraph
  // in it; the heights are the same page's written with an `<html>`.
  const rootOf = (el: unknown): LaidBox =>
    (el as { _tree: { root: LaidBox } })._tree.root;
  const written = (css: string): string =>
    `<!DOCTYPE html><html><head><style>${css}</style></head>` +
    `<body id="body"><p id="p">hi</p></body></html>`;
  // a fragment declares no doctype: one that does is a document, whose
  // `<html>`, head and body are implied
  const fragment = (css: string): string =>
    `<style>${css}</style><p id="p">hi</p>`;
  const bodies: [string, number[] | null, number[] | null][] = [
    ['body{max-width:100px;margin:0 auto}', [50, 100], [50, 100]],
    ['body{max-width:50%;margin:0 auto}', [50, 100], [50, 100]],
    [
      'body{width:120px;margin:0 auto;padding:0 10px;border:5px solid}',
      [25, 150],
      [40, 120],
    ],
    ['body{width:50%;margin:0 10px 0 auto}', [90, 100], [90, 100]],
    [
      'body{box-sizing:border-box;width:100px;padding:0 10px;' +
        'margin-left:auto;margin-right:0}',
      [100, 100],
      [110, 80],
    ],
    // a width the margins over-constrain leaves the room to the margin at
    // the end, which is the left one where the `<html>` around the body
    // is right-to-left
    ['body{width:100px;margin:8px}', [8, 100], [8, 100]],
    ['html{direction:rtl}body{width:100px;margin:0}', [100, 100], [100, 100]],
    // the least width wins over the room
    ['body{min-width:300px;margin:0}', [0, 300], [0, 300]],
    // and a width the content gives it is centred too: Chrome's is the
    // width of "hi" in its own font
    ['body{width:fit-content;margin:0 auto}', null, null],
  ];
  for (const [css, body, p] of bodies) {
    const ours = await renderScrolled(fragment(css), 120, 200);
    const theirs = await renderScrolled(written(css), 120, 200);
    const box = rootOf(ours.el);
    const q = boxOf(ours.el, 'p');
    if (body && p) {
      assert.deepStrictEqual([box.x, box.width], body, css);
      assert.deepStrictEqual([q.x, q.width], p, `${css}: the paragraph`);
    } else {
      assert.ok(box.width < 100, `${css}: ${box.width} wide`);
      assert.ok(
        Math.abs(box.x * 2 + box.width - 200) < 1e-6,
        `${css}: centred at ${box.x}`,
      );
    }
    const b = boxOf(theirs.el, 'body');
    assert.deepStrictEqual(
      [box.x, box.y, box.width, box.height],
      [b.x, b.y, b.width, b.height],
      `${css}: as the body written in an html`,
    );
    const r = boxOf(theirs.el, 'p');
    assert.deepStrictEqual([q.x, q.width], [r.x, r.width], css);
    assert.strictEqual(ours.el.abs.height, theirs.el.abs.height, css);
  }
  // and the `<html>` a document implies around a `<body>`, a block in the
  // initial containing block, whose direction is the root element's (CSS
  // 2.1 10.1)
  const htmls: [string, number[], number[]][] = [
    ['html{max-width:100px;margin:0 auto}body{margin:0}', [50, 100], [50, 100]],
    [
      'html{width:100px;margin:0 auto;border:5px solid}body{margin:0}',
      [45, 110],
      [50, 100],
    ],
    [
      'html{width:120px;margin-left:auto;margin-right:auto}body{margin:0}',
      [40, 120],
      [40, 120],
    ],
    [
      'html{direction:rtl;width:100px;margin:0}body{margin:0}',
      [100, 100],
      [100, 100],
    ],
  ];
  for (const [css, html, p] of htmls) {
    const { el } = await renderScrolled(
      bare(css, '<p id="p">hi</p>'),
      120,
      200,
    );
    const box = htmlOf(el);
    assert.deepStrictEqual([box.x, box.width], html, css);
    const q = boxOf(el, 'p');
    assert.deepStrictEqual([q.x, q.width], p, `${css}: the paragraph`);
  }
});

test('the element the root box stands in for is as tall as its min-height and max-height let it be', async () => {
  // Where the markup writes no element for it, the root box stands in for
  // one — the `<html>` implied around a `<body>`, or a fragment's body —
  // and an `auto` height on it is what it holds, within its limits (CSS
  // 2.1 10.7). Only a height it set was read, and the limits on none:
  // `html { min-height: 100% }` was as tall as the page, and a fragment's
  // `body { min-height: 200px }` the height of its one block. Each case
  // has Chrome's boxes at 200 × 120 — the implied `<html>`'s where the
  // root box is that, and the body's — which the same page written with
  // an `<html>` gives as well, and the document's height: the bottom of
  // what overflows, or of the `<html>`'s margin, where Chrome's scroll
  // height is the viewport's at least.
  const written = (css: string, body: string): string =>
    `<!DOCTYPE html><html id="html"><head><title>t</title>` +
    `<style>${css}</style></head><body id="body">${body}</body></html>`;
  const fragment = (css: string, body: string): string =>
    `<style>${css}</style>${body}`;
  const div = (style: string): string => `<div style="${style}"></div>`;
  const rect = (box: LaidBox): number[] => [
    box.x,
    box.y,
    box.width,
    box.height,
  ];
  const rootOf = (el: HtmlViewNode): LaidBox =>
    (treeOf(el) as { root: LaidBox }).root;
  /** How the page is written, its style and body; the implied `<html>`'s
   *  box, the body's, the document's height. */
  const cases: [
    typeof bare,
    string,
    string,
    number[] | null,
    number[],
    number | null,
  ][] = [
    // the root element at least the viewport tall, its border outside it
    [
      bare,
      'html{min-height:100%;border:2px solid red}body{margin:10px}',
      div('height:10px'),
      [0, 0, 200, 124],
      [12, 12, 176, 10],
      124,
    ],
    // and at most 50px, what it holds running on out of it
    [
      bare,
      'html{max-height:50px;border:2px solid red}body{margin:10px}',
      div('height:200px'),
      [0, 0, 200, 54],
      [12, 12, 176, 200],
      212,
    ],
    // inside its margins
    [
      bare,
      'html{min-height:80px;margin:5px;padding:3px}body{margin:10px}',
      div('height:10px'),
      [5, 5, 190, 86],
      [18, 18, 164, 10],
      96,
    ],
    // a fragment's body: the minimum sets its height, and parts the last
    // block's bottom margin from its own, as it does a block's in the flow
    [
      fragment,
      'body{margin:20px;min-height:200px}',
      div('height:10px;margin:16px 0 50px'),
      null,
      [20, 20, 160, 200],
      240,
    ],
    // where the minimum is not what sets it, the margin collapses through
    [
      fragment,
      'body{margin:20px;min-height:30px}',
      div('height:10px;margin-bottom:50px') +
        div('height:40px;margin-bottom:50px'),
      null,
      [20, 20, 160, 100],
      170,
    ],
    [
      fragment,
      'body{margin:20px;min-height:100vh}',
      div('height:10px'),
      null,
      [20, 20, 160, 120],
      160,
    ],
    [
      fragment,
      'body{margin:20px;max-height:30px}',
      div('height:200px'),
      null,
      [20, 20, 160, 30],
      220,
    ],
    // a percentage of the `<html>` around it, where that has a height —
    // which, with no box of its own here, adds nothing to the document's
    [
      fragment,
      'html{height:100%}body{margin:20px;min-height:50%}',
      div('height:10px'),
      null,
      [20, 20, 160, 60],
      null,
    ],
    [
      fragment,
      'html{height:100px}body{margin:20px;max-height:50%;border:1px solid red}',
      div('height:200px'),
      null,
      [20, 20, 160, 52],
      221,
    ],
    // and of none where it has only a minimum
    [
      fragment,
      'html{min-height:100%}body{margin:20px;min-height:100%}',
      div('height:10px'),
      null,
      [20, 20, 160, 10],
      null,
    ],
  ];
  for (const [page, css, inner, html, body, height] of cases) {
    const ours = await renderScrolled(page(css, inner), 120, 200);
    const theirs = await renderScrolled(written(css, inner), 120, 200);
    const own = page === fragment ? rootOf(ours.el) : boxOf(ours.el, 'body');
    assert.deepStrictEqual(rect(own), body, `${css}: the body`);
    assert.deepStrictEqual(
      rect(boxOf(theirs.el, 'body')),
      body,
      `${css}: the body written in an <html>`,
    );
    if (html) {
      assert.deepStrictEqual(rect(htmlOf(ours.el)), html, `${css}: the html`);
      assert.deepStrictEqual(
        rect(boxOf(theirs.el, 'html')),
        html,
        `${css}: the html written`,
      );
    }
    if (height !== null) {
      assert.strictEqual(ours.el.abs.height, height, `${css}: the document`);
      assert.strictEqual(theirs.el.abs.height, height, `${css}: written`);
    }
  }
  // and a minimum of the viewport follows it
  const { el, resize } = await renderScrolled(
    bare('html{min-height:100%}body{margin:0}', div('height:10px')),
    120,
    200,
  );
  assert.strictEqual(rootOf(el).height, 120);
  await resize(200);
  assert.strictEqual(rootOf(el).height, 200, 'and follows it');
  assert.strictEqual(el.abs.height, 200);
});

metric(
  'a fixed box is drawn where the viewport is, however far the pane has scrolled the document',
  async () => {
    // CSS 2.1 9.6.1: a fixed box is positioned against the viewport and does
    // not move when the document scrolls. Laid out against the viewport at
    // the document's top, it was drawn there, and scrolled away with the
    // text: the Zen Garden's 069 frames its page in fixed edges, and 090
    // pins its intro to the window's corner
    const { node } = await render(
      '<style>body{margin:0}.tall{height:2000px}.bar{position:fixed;' +
        'left:0;bottom:0;width:100px;height:20px;background:#ff0000}' +
        '</style><div class="tall"></div><div class="bar"></div>',
    );
    const el = view(node);
    await act();
    // the window, which is what the fixed box was laid out against, with
    // the document scrolled 300px up it
    const viewport = { x: 0, y: 0, width: 440, height: 600 };
    const bar = (fills: Fill[]) =>
      fills.find((f) => f.style === parseColor('#ff0000'));
    const scrolled = bar(
      await fillsOf(el, undefined, { originY: -300, viewport }),
    );
    assert.deepStrictEqual(
      scrolled && [scrolled.x, scrolled.y, scrolled.w, scrolled.h],
      [0, 580, 100, 20],
      `at the viewport's bottom: ${JSON.stringify(scrolled)}`,
    );
    const unscrolled = bar(await fillsOf(el, undefined, { viewport }));
    assert.strictEqual(unscrolled?.y, 580, 'and there before the scroll');
  },
);

metric(
  'a fixed background is placed against the viewport the document is seen through',
  async () => {
    // CSS 2.1 14.2.1: fixed with regard to the viewport, which is the pane
    // that scrolls the element, not the element: placed against the element,
    // a body's picture scrolled away with the page — 041, 051 and 095
    const { node } = await render(
      '<style>body{margin:0;height:2000px;background:url(p.png) no-repeat ' +
        'fixed right bottom}</style>',
    );
    const el = view(node);
    await act();
    const ops: PaintOp[] = [];
    await fillsOf(el, ops, {
      originY: -300,
      canvas: { x: 0, y: -300, width: 400, height: 2000 },
      viewport: { x: 0, y: 0, width: 400, height: 200 },
      backgroundImageFor: () => ({
        image: {},
        width: 50,
        height: 40,
        ratio: 50 / 40,
      }),
    });
    const image = ops.find((op) => op.op === 'image') as
      { x: number; y: number; w: number; h: number } | undefined;
    assert.deepStrictEqual(
      image && [image.x, image.y, image.w, image.h],
      [350, 160, 50, 40],
      `in the viewport's bottom right: ${JSON.stringify(image)}`,
    );
  },
);

type FixedRect = { x: number; y: number; width: number; height: number };

metric(
  'what the document draws fixed to the viewport, it tells the scroll pane',
  async () => {
    // react-x11's `viewportFixedRects`: a pane's scroll that blits repaints
    // these where they are and where the copy dragged them, and one that
    // covers the viewport makes the scroll a repaint. Without it the copy
    // dragged a fixed header along with the text
    const renderIn = async (source: string) => {
      const pane = React.createRef<DrawnNode & { scrollTo(y: number): void }>();
      const result = await renderX11(
        h(
          'box',
          {
            ref: pane,
            style: { width: 400, height: 200, overflow: 'scroll' },
          },
          h(Html, { source, partial: false, 'data-testname': 'doc' }),
        ),
        { width: 440, height: 240, fonts: FONTS! },
      );
      await act();
      return {
        result,
        pane,
        el: view(screen.getByTestName('doc') as DrawnNode),
      };
    };
    const header = await renderIn(
      '<style>body{margin:0}.tall{height:2000px}.bar{position:fixed;' +
        'top:0;left:0;width:100px;height:20px;background:red}</style>' +
        '<div class="tall"></div><div class="bar"></div>',
    );
    await act(async () => header.pane.current!.scrollTo(300));
    const rects = (
      header.el as unknown as { viewportFixedRects(): FixedRect[] | null }
    ).viewportFixedRects();
    assert.deepStrictEqual(
      rects,
      [{ x: 0, y: 0, width: 100, height: 20 }],
      'the header, where the viewport is',
    );
    // and a point there is the header's, as it was drawn there
    const under = header.el.elementAtPoint(50, 10);
    assert.strictEqual(
      under?.attribs?.class,
      'bar',
      'the pointer finds the header where it is drawn',
    );
    await header.result.unmount();
    const background = await renderIn(
      '<style>body{margin:0;height:2000px;background:url(p.png) fixed}' +
        '</style><body><p>text</p></body>',
    );
    const whole = (
      background.el as unknown as { viewportFixedRects(): FixedRect[] | null }
    ).viewportFixedRects();
    assert.deepStrictEqual(
      whole,
      [{ x: 0, y: 0, width: 400, height: 200 }],
      `a fixed background: the whole viewport: ${JSON.stringify(whole)}`,
    );
    await background.result.unmount();
    const plain = await renderIn('<p>nothing fixed</p>');
    assert.strictEqual(
      (
        plain.el as unknown as { viewportFixedRects(): FixedRect[] | null }
      ).viewportFixedRects(),
      null,
      'and nothing where nothing is fixed',
    );
    await plain.result.unmount();
    // A fixed box that draws nothing is no rect the copy could drag: GitHub's
    // page-load bar across the top, at `opacity: 0`, met a contents list
    // stuck at `top: 0`, core merged the two into the box around both, and
    // every scroll repainted the window. One hidden with something visible
    // in it still draws that.
    const unseen = await renderIn(
      '<style>body{margin:0}.tall{height:2000px}.f{position:fixed;left:0;' +
        'width:100px;height:20px;background:red}</style>' +
        '<div class="tall"></div>' +
        '<div class="f" style="top:0;opacity:0"></div>' +
        '<div class="f" style="top:40px;visibility:hidden"></div>' +
        '<div class="f" style="top:80px;visibility:hidden">' +
        '<span style="visibility:visible">shown</span></div>',
    );
    await act(async () => unseen.pane.current!.scrollTo(300));
    const shown = (
      unseen.el as unknown as { viewportFixedRects(): FixedRect[] | null }
    ).viewportFixedRects();
    assert.deepStrictEqual(
      shown?.map((rect) => rect.y),
      [80],
      `only the box with something visible in it: ${JSON.stringify(shown)}`,
    );
  },
);

/** A page whose sticky boxes the viewport keeps: a header held at the
 *  top, a title in each of two sections held below it, and a footer held
 *  at the bottom. */
const STICKY =
  '<style>body{margin:0}#head{position:sticky;top:0;height:20px;' +
  'background:#0000ff}section{height:300px}.t{position:sticky;top:30px;' +
  'height:20px;background:#ff0000}#foot{position:sticky;bottom:0;' +
  'height:20px;background:#00ff00}</style><div id="head"></div>' +
  '<section><div class="t" id="t1"></div></section>' +
  '<section><div class="t" id="t2"></div></section>' +
  '<div style="height:600px"></div><div id="foot"></div>';

/** Sticky boxes the viewport holds a level down, one casting a shadow past
 *  itself, and one in a flex row its section lets go of half way down:
 *  what a pane's scroll moves, and the boxes around them grown to hold
 *  them (`boundsAfterMove`). */
const STICKY_DEEP =
  '<style>body{margin:0}.page{padding:0 0 40px}#head{position:sticky;' +
  'top:0;height:20px;background:#0000ff;box-shadow:0 6px 0 #000000}' +
  '.row{display:flex;height:400px;margin:10px 0;background:#eeeeee}' +
  '.side{position:sticky;top:30px;width:60px;height:40px;' +
  'background:#ff00ff;align-self:flex-start}.main{flex:1}' +
  '.main div{height:30px;margin:10px;background:#00aaaa}' +
  '.pin{position:sticky;top:30px;height:10px;width:30px;' +
  'margin-left:200px;background:#ff8800}.item{height:10px;margin:2px 0;' +
  'width:100px;background:#88cc88}</style>' +
  '<div class="page"><div id="head"></div>' +
  '<div class="row"><div class="side"></div><div class="main">' +
  '<div></div><div></div><div></div><div></div><div></div></div></div>' +
  '<div class="row"><div class="main"><div></div><div></div></div>' +
  '<div class="side"></div></div>' +
  // one among more children than a box indexes by where they are
  // (`PAINT_INDEX_MIN`), whose parent's index it moves in
  '<div class="list"><div class="pin"></div>' +
  '<div class="item"></div>'.repeat(80) +
  '</div><div style="height:300px"></div></div>';

/** The pane around a document: what scrolls it. */
function paneOf(node: HtmlViewNode): { scrollTo(y: number): void } {
  type Up = { parent: Up | null; props?: { style?: { overflow?: string } } };
  let at = (node as unknown as Up).parent;
  while (at && at.props?.style?.overflow !== 'scroll') at = at.parent;
  assert.ok(at, 'a pane');
  return at as unknown as { scrollTo(y: number): void };
}

test('a sticky box the viewport keeps holds to it as the pane scrolls the document, until its containing block takes it away, as browsers place it', async () => {
  // Placed once by the layout, as though the document were at its top, and
  // never again, since the pane's scroll lays nothing out: github.blog's
  // contents list, `top: 80px` beside its article, scrolled away with the
  // article where a browser holds it under the page's header
  const { el } = await renderScrolled(STICKY, 200);
  const pane = paneOf(el);
  const tops = () =>
    ['head', 't1', 't2', 'foot'].map(
      (id) => el.elementRect(findById(el.document, id)!)!.y,
    );
  // Chrome 154, Firefox and WebKit alike: the header at the top all the
  // way, each title 30px down until its section leaves, the footer at the
  // bottom until it is where the flow has it
  const browsers: [number, number[]][] = [
    [0, [0, 30, 320, 180]],
    [100, [100, 130, 320, 280]],
    [290, [290, 300, 320, 470]],
    [450, [450, 300, 480, 630]],
    [1040, [1040, 300, 600, 1220]],
  ];
  for (const [y, want] of browsers) {
    await act(async () => pane.scrollTo(y));
    assert.deepStrictEqual(tops(), want, `scrolled to ${y}`);
  }
  // and a point is the box held there, not what scrolled under it
  await act(async () => pane.scrollTo(450));
  assert.strictEqual(el.elementAtPoint(50, 10)?.attribs.id, 'head');
  assert.strictEqual(el.elementAtPoint(50, 40)?.attribs.id, 't2');
  assert.strictEqual(el.elementAtPoint(50, 190)?.attribs.id, 'foot');
});

test('what draws nothing inside a sticky box or a fixed one is no part of what the pane repaints as it scrolls', async () => {
  // Docusaurus: the navbar is stuck at the top, and holds its menu's
  // backdrop, fixed over the whole viewport and hidden until the menu
  // opens. The navbar's ink was the viewport, which the pane repainted at
  // every frame of a scroll, where a blit would have done. A fixed box
  // holding a hidden panel the size of the viewport is the same thing.
  const { el } = await renderScrolled(
    '<style>body{margin:0}nav{position:sticky;top:0;height:30px;' +
      'background:#00f}.backdrop{position:fixed;inset:0;opacity:0;' +
      'visibility:hidden;background:#000}#tab{position:fixed;right:0;' +
      'bottom:0;width:40px;height:20px;background:#f00}' +
      '.panel{position:fixed;inset:0;visibility:hidden;background:#000}' +
      '</style><nav><div class="backdrop"></div></nav>' +
      '<div id="tab"><div class="panel"></div></div>' +
      '<div style="height:2000px"></div>',
    200,
  );
  await act(async () => paneOf(el).scrollTo(300));
  const rects = (
    el as unknown as { viewportFixedRects(): FixedRect[] | null }
  ).viewportFixedRects();
  assert.ok(rects?.length, 'something is pinned');
  for (const rect of rects) {
    assert.ok(
      rect.height <= 30 && rect.width <= 400,
      `the navbar and the tab, not the viewport: ${JSON.stringify(rects)}`,
    );
  }
  assert.ok(
    rects.some((rect) => rect.width === 40 && rect.height === 20),
    `the tab is pinned: ${JSON.stringify(rects)}`,
  );
});

test('a sticky box keeps inside its containing block by its own margins, not by those its children take through its edges', async () => {
  // github.blog's contents list ends on an item whose 64px bottom margin
  // collapses through the list's foot: held by that margin, it stopped
  // 64px above the end of its sidebar, where Chrome takes it to the end
  const { el } = await renderScrolled(
    '<style>body{margin:0}#cb{height:1000px}#s{position:sticky;top:0}' +
      '#s p{margin:20px 0 50px;height:20px}#u{position:sticky;bottom:0}' +
      '#u p{margin:40px 0 0;height:20px}</style><div id="cb">' +
      '<div style="height:300px"></div><div id="s"><p></p></div>' +
      '<div style="height:300px"></div><div id="u"><p></p></div></div>' +
      '<div style="height:1000px"></div>',
    200,
  );
  const pane = paneOf(el);
  const tops = () =>
    ['s', 'u'].map((id) => el.elementRect(findById(el.document, id)!)!.y);
  // Chrome 154, Firefox and WebKit alike
  const browsers: [number, number[]][] = [
    [0, [320, 180]],
    [990, [980, 730]],
    [1500, [980, 730]],
  ];
  for (const [y, want] of browsers) {
    await act(async () => pane.scrollTo(y));
    assert.deepStrictEqual(tops(), want, `scrolled to ${y}`);
  }
});

test('a box fixed to the viewport stays where the viewport has it, whatever a sticky or a relative box around it is moved by', async () => {
  // docs.github.com's search dialog is fixed under the header, inside a
  // header stuck to the top: moved with the header as it stuck and then
  // to the viewport as well, it went down the window as the page went up
  const { el } = await renderScrolled(
    '<style>body{margin:0}div{box-sizing:border-box}' +
      '.k{width:20px;height:20px}</style><div style="height:100px"></div>' +
      '<div style="position:relative;top:50px;left:30px;height:40px">' +
      '<div id="a" class="k" style="position:fixed;top:10px"></div>' +
      '<div id="b" class="k" style="position:fixed;left:10px"></div>' +
      '<div id="c" class="k" style="position:fixed;top:10px;left:10px">' +
      '</div></div><div style="height:100px"></div>' +
      '<div id="s" style="position:sticky;top:300px;height:40px;' +
      'margin-left:60px">' +
      '<div id="d" class="k" style="position:fixed;top:300px;left:300px">' +
      '</div><div id="e" class="k" style="position:fixed"></div>' +
      '<div id="f" class="k" style="position:absolute"></div></div>' +
      '<div style="height:3000px"></div>',
    400,
  );
  const pane = paneOf(el);
  const at = () =>
    Object.fromEntries(
      ['a', 'b', 'c', 'd', 'e', 'f', 's'].map((id) => {
        const rect = el.elementRect(findById(el.document, id)!)!;
        return [id, [rect.x, rect.y]];
      }),
    );
  // Chrome 154, in the document's coordinates: a fixed box takes a
  // relative box's offset on an axis it has no inset on, where its static
  // position is, and a sticky box's on none; an absolute box is the sticky
  // box's and goes with it
  const chrome = (y: number, s: number) => ({
    a: [30, 10 + y],
    b: [10, 150 + y],
    c: [10, 10 + y],
    d: [300, 300 + y],
    e: [60, 240 + y],
    f: [60, s],
    s: [60, s],
  });
  for (const [y, s] of [
    [0, 300],
    [100, 400],
    [500, 800],
  ]) {
    await act(async () => pane.scrollTo(y));
    assert.deepStrictEqual(at(), chrome(y, s), `scrolled to ${y}`);
  }
});

for (const [measured, source, every] of [
  [false, STICKY, false],
  [true, STICKY, false],
  [false, STICKY_DEEP, true],
] as const) {
  metric(
    `a pane scrolled a step at a time draws the sticky boxes the viewport holds where a repaint of all of it does${measured ? ', measured between each scroll and its pass' : ''}${every ? ', a level down and casting a shadow' : ''}`,
    async () => {
      // A step of a pane's scroll copies what it shows and paints the strip
      // it exposed, and the copy drags a held box with the text. The document
      // tells the pane where each was drawn held and where it is held now
      // (`viewportFixedRects`), and the pane repaints both: without them, the
      // title caught on the way down left a copy of itself every step. And
      // measured between a scroll and its pass, as a page does after its own
      // `scrollTo` and core does on a move, which places them for the scroll
      // before the pass that draws it (`_followViewport`)
      const W = 400;
      const H = 200;
      const mount = async () => {
        const pane = React.createRef<
          DrawnNode & { scrollTo(y: number): void }
        >();
        const result = await renderX11(
          h(
            'box',
            { ref: pane, style: { width: W, height: H, overflow: 'scroll' } },
            h(Html, { source, partial: false, 'data-testname': 'doc' }),
          ),
          { width: W, height: H, fonts: FONTS! },
        );
        await act();
        const doc = screen.getByTestName('doc') as unknown as {
          children: HtmlViewNode[];
        };
        return { result, pane: pane.current!, el: doc.children[0] };
      };
      // left of the bar, whose thumb fades on a clock of its own
      const region = { x: 0, y: 0, width: W - 20, height: H };
      const stepped = await mount();
      // down to the step that catches the second title, which was where the
      // flow had it the step before; on, past where it is let go; and back
      // up past where it is caught again
      const path = [
        ...Array.from({ length: 30 }, (_, i) => 10 + i * 10),
        ...Array.from({ length: 30 }, (_, i) => 310 + i * 10),
        ...Array.from({ length: 15 }, (_, i) => 590 - i * 10),
        // and through the list, and back up a little
        ...(every
          ? [
              ...Array.from({ length: 100 }, (_, i) => 460 + i * 10),
              ...Array.from({ length: 20 }, (_, i) => 1450 - i * 10),
            ]
          : []),
      ];
      const stops = new Map<number, Uint8ClampedArray>();
      for (const [i, y] of path.entries()) {
        await act(async () => {
          stepped.pane.scrollTo(y);
          if (!measured) return;
          stepped.el.elementAtPoint(50, 10);
          stepped.el.cursorAt(50, 10);
        });
        if (y === 300 || i === path.length - 1 || (every && i % 7 === 0)) {
          stops.set(y, await pixelsIn(stepped.result.ctx, region));
        }
      }
      await stepped.result.unmount();
      for (const [y, after] of stops) {
        const whole = await mount();
        await act(async () => whole.pane.scrollTo(y));
        const want = await pixelsIn(whole.result.ctx, region);
        await whole.result.unmount();
        let wrong = 0;
        let first = -1;
        for (let i = 0; i < want.length; i += 4) {
          if (
            after[i] !== want[i] ||
            after[i + 1] !== want[i + 1] ||
            after[i + 2] !== want[i + 2]
          ) {
            wrong += 1;
            if (first < 0) first = i / 4;
          }
        }
        assert.strictEqual(
          wrong,
          0,
          `at ${y}: ${wrong} pixels off, the first at ` +
            `${first % region.width},${Math.floor(first / region.width)}`,
        );
      }
    },
  );
}

test('a box placed against the initial containing block follows the viewport', async () => {
  // nothing positioned around it: `bottom: 0` is the viewport's bottom
  const { el, resize } = await renderScrolled(
    '<body style="margin:0"><div id="pin" style="position:absolute;' +
      'bottom:0;width:10px;height:10px"></div></body>',
    300,
  );
  assert.strictEqual(boxOf(el, 'pin').y, 290);
  await resize(400);
  assert.strictEqual(boxOf(el, 'pin').y, 390);
});

test('a document that reads no viewport height is not laid out for one', async () => {
  // The layout says whether it read the height (a `vh`, the root's
  // percentage, the initial containing block's bottom), and a document that
  // read none of them — most — is left alone when the window only grows
  // taller: a page a hundred screens long is not laid out again per frame
  // of a vertical resize for nothing.
  const { el, resize } = await renderScrolled(
    '<body style="margin:0"><div id="a" style="height:40px"></div></body>',
    300,
  );
  const under = () =>
    (el as unknown as { _laidOutUnder: number })._laidOutUnder;
  const before = under();
  await resize(500);
  assert.strictEqual(under(), before, 'not laid out again');
  assert.strictEqual(boxOf(el, 'a').height, 40);
  assert.strictEqual(el.abs.height, 40);
});

test('a vw length follows the width of the viewport', async () => {
  // A `vw` is a number by the time the computed style holds it, so a resize
  // that crossed no `@media` breakpoint — the one kind that restyled —
  // left it at the width the page loaded at.
  const { el, resize } = await renderScrolled(
    '<body style="margin:0"><div id="half" style="width:50vw;' +
      'height:10px"></div></body>',
    300,
    400,
  );
  assert.strictEqual(boxOf(el, 'half').width, 200);
  await resize(300, 600);
  assert.strictEqual(boxOf(el, 'half').width, 300);
});

test('a vw only a sheet mentions leaves a resize to the layout', async () => {
  // Wikipedia's skin has a `75vw` under a class its pages are not served
  // with. Noted from the sheet, it made every pixel of a resize style the
  // whole article again and build its boxes again; a style holds none, so
  // a resize is a layout
  const { el, resize } = await renderScrolled(
    '<style>body{margin:0}.absent{width:75vw}</style>' +
      '<div id="a" style="height:10px"></div>',
    300,
    400,
  );
  const tree = treeOf(el);
  assert.strictEqual(boxOf(el, 'a').width, 400);
  await resize(300, 600);
  assert.strictEqual(boxOf(el, 'a').width, 600, 'laid out at the new width');
  assert.ok(treeOf(el) === tree, 'no box built again');
});

test('a vw that comes to hold follows the width, and one that stops does not', async () => {
  // under a `@media` band: crossing into it styles the page again, which
  // finds the `vw`, and every resize in the band after it does too
  const { el, resize } = await renderScrolled(
    '<style>body{margin:0}#a{height:10px}' +
      '@media (max-width:500px){#a{width:50vw}}</style><div id="a"></div>',
    300,
    600,
  );
  assert.strictEqual(boxOf(el, 'a').width, 600);
  await resize(300, 400);
  assert.strictEqual(boxOf(el, 'a').width, 200, 'into the band');
  await resize(300, 300);
  assert.strictEqual(boxOf(el, 'a').width, 150, 'inside it');
  await resize(300, 700);
  assert.strictEqual(boxOf(el, 'a').width, 700, 'out of it');
  const tree = treeOf(el);
  await resize(300, 800);
  assert.strictEqual(boxOf(el, 'a').width, 800);
  assert.ok(treeOf(el) === tree, 'the vw out of the band is read no more');
});

test('a vw through a custom property, or on a pseudo-element, follows the width', async () => {
  const { el, resize } = await renderScrolled(
    '<style>body{margin:0}:root{--w:25vw}#a{width:var(--w);height:10px}' +
      '#b{height:10px}#b::before{content:"";display:block;width:10vw;' +
      'height:5px}</style><div id="a"></div><div id="b"></div>',
    300,
    400,
  );
  // the `::before` is the first box in its element's
  const before = () => boxOf(el, 'b').children[0];
  assert.strictEqual(boxOf(el, 'a').width, 100);
  assert.strictEqual(before()?.width, 40);
  await resize(300, 800);
  assert.strictEqual(boxOf(el, 'a').width, 200);
  assert.strictEqual(before()?.width, 80);
});

test('a resize styles again the elements that hold a vw, and what inherits from them, and keeps the rest', async () => {
  // Every page of python.org's documentation, GitHub and Bootstrap sets a
  // `vw` or a `vh` on a few elements, and each pixel of a drag styled every
  // element again: 46% of a frame on Python's 19,680
  const rows = Array.from(
    { length: 40 },
    (_, i) => `<p id="p${i}" class="row">row ${i} <b>bold</b></p>`,
  ).join('');
  const { el, resize } = await renderScrolled(
    '<style>body{margin:0}.row{height:10px;margin:0}' +
      '#big{font-size:2vw;height:20px}#bar{width:25vw;height:5px}' +
      '#tall{height:10vh}#side::after{content:"";display:block;' +
      'width:10vw;height:5px}</style>' +
      '<div id="big"><span id="in">inherits</span></div>' +
      `<div id="bar"></div><div id="tall"></div><div id="side"></div>${rows}`,
    300,
    400,
  );
  const styleOf = (id: string) =>
    (
      treeOf(el) as {
        styles: Map<unknown, { style: { fontSize: number } }>;
      }
    ).styles.get(findById(el.document, id))!.style;
  const kept = ['p0', 'p20', 'p39'].map(styleOf);
  const tall = styleOf('tall');
  assert.strictEqual(styleOf('in').fontSize, 8);
  assert.strictEqual(boxOf(el, 'bar').width, 100);
  assert.strictEqual(boxOf(el, 'side').children[0]?.width, 40);

  await resize(300, 600);
  assert.strictEqual(styleOf('in').fontSize, 12, 'what inherits a 2vw');
  assert.strictEqual(boxOf(el, 'bar').width, 150);
  assert.strictEqual(boxOf(el, 'side').children[0]?.width, 60, '::after');
  assert.deepStrictEqual(
    ['p0', 'p20', 'p39'].map(styleOf),
    kept,
    'an element that reads no vw keeps its style',
  );
  assert.strictEqual(styleOf('tall'), tall, 'a vh, when only the width moved');
  // and the height, which only the `vh` reads
  await resize(500, 600);
  assert.strictEqual(boxOf(el, 'tall').height, 50);
  assert.deepStrictEqual(['p0', 'p20', 'p39'].map(styleOf), kept);
});

test('an orientation or a height in @media restyles where its answer turns, and nowhere else', async () => {
  // Tailwind's docs have an `(orientation: portrait)`: read as a `vw`, every
  // step of a drag styled the page again, where only the step that takes
  // the width past the height changes what it matches
  const { el, resize } = await renderScrolled(
    '<style>body{margin:0}#a{height:10px;width:10px}#b{height:10px}' +
      '@media (orientation:portrait){#a{width:20px}}' +
      '@media (min-height:400px){#b{height:30px}}</style>' +
      '<div id="a"></div><div id="b"></div>' +
      '<p id="p">text</p>',
    300,
    600,
  );
  assert.strictEqual(boxOf(el, 'a').width, 10);
  let tree = treeOf(el);
  await resize(300, 500);
  assert.strictEqual(boxOf(el, 'a').width, 10, 'still landscape');
  assert.ok(treeOf(el) === tree, 'a width that turns nothing builds nothing');
  await resize(300, 250);
  assert.strictEqual(boxOf(el, 'a').width, 20, 'portrait');
  tree = treeOf(el);
  await resize(300, 240);
  assert.ok(treeOf(el) === tree, 'and nothing within it');
  // the height's query the same way
  await resize(350, 240);
  assert.strictEqual(boxOf(el, 'b').height, 10);
  assert.ok(treeOf(el) === tree, 'a height that turns nothing');
  await resize(450, 240);
  assert.strictEqual(boxOf(el, 'b').height, 30, 'past 400px');
  assert.strictEqual(boxOf(el, 'a').width, 20);
});

test('a vw in a container query styles every element again on a resize', async () => {
  // what a rule matches turns on it, which no style holds
  const { el, resize } = await renderScrolled(
    '<style>body{margin:0}#c{container-type:inline-size;width:300px}' +
      '#a{height:10px;width:10px}' +
      '@container (min-width:50vw){#a{width:20px}}</style>' +
      '<div id="c"><div id="a"></div></div>',
    300,
    800,
  );
  assert.strictEqual(boxOf(el, 'a').width, 10);
  await resize(300, 500);
  assert.strictEqual(boxOf(el, 'a').width, 20);
});

test('the small, large and dynamic viewports, and its inline and block axes, are the viewport', async () => {
  // melbcss.com's body is `min-height: 100svh`: an unread unit dropped the
  // declaration, and the page did not fill the window
  const { el, resize } = await renderScrolled(
    '<body style="margin:0">' +
      '<div id="s" style="height:10svh;width:10svw"></div>' +
      '<div id="l" style="height:10lvh;width:10LVW"></div>' +
      '<div id="d" style="height:10dvh;width:calc(10dvw + 1px)"></div>' +
      '<div id="ib" style="height:10vb;width:10vi"></div>' +
      '<div id="m" style="width:10svmin;height:10dvmax"></div></body>',
    300,
    400,
  );
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  assert.deepStrictEqual(size('s'), [40, 30]);
  assert.deepStrictEqual(size('l'), [40, 30]);
  assert.deepStrictEqual(size('d'), [41, 30]);
  assert.deepStrictEqual(size('ib'), [40, 30]);
  assert.deepStrictEqual(size('m'), [30, 40]);
  // and like `vh` and `vw`, each follows the side of the viewport it reads
  await resize(500, 600);
  assert.deepStrictEqual(size('s'), [60, 50]);
  assert.deepStrictEqual(size('ib'), [60, 50]);
  assert.deepStrictEqual(size('m'), [50, 60]);
});

metric(
  'a fixed box in a masked element is drawn where the viewport is, on its surface',
  async () => {
    // A masked element is drawn on a surface of its own, its origin moved
    // to the surface's corner. A fixed box in it is placed by where the
    // viewport is from that origin, so the viewport moves with it: left in
    // window coordinates, the box was drawn the scroll away from where it
    // belongs
    const { node } = await render(
      '<style>body{margin:0}.m{height:2000px;' +
        'mask-image:linear-gradient(#000000,#000000)}.bar{position:fixed;' +
        'left:0;bottom:0;width:100px;height:20px;background:#ff0000}' +
        '</style><div class="m"><div class="bar"></div></div>',
    );
    const el = view(node);
    await act();
    // surfaces that keep what is filled on them
    const filled: { style: unknown; y: number }[] = [];
    const surface = () => {
      let fillStyle: unknown = null;
      const ctx = {
        globalCompositeOperation: 'source-over',
        get fillStyle() {
          return fillStyle;
        },
        set fillStyle(v: unknown) {
          fillStyle = v;
        },
        save() {},
        restore() {},
        fillRect(_x: number, y: number) {
          filled.push({ style: fillStyle, y });
        },
        drawImage() {},
      };
      return { getContext: () => ctx, destroy() {} };
    };
    const ops: PaintOp[] = [];
    await fillsOf(el, ops, {
      originY: -300,
      viewport: { x: 0, y: 0, width: 440, height: 600 },
      surface,
    });
    const composite = ops.find((op) => op.op === 'image') as
      { y: number } | undefined;
    const bar = filled.find((f) => f.style === parseColor('#ff0000'));
    assert.ok(composite && bar, 'the mask drew its element on a surface');
    assert.strictEqual(
      composite.y + bar.y,
      580,
      "at the viewport's bottom in the window",
    );
  },
);
