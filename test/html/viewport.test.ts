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
  h,
  metric,
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
    `<!DOCTYPE html><style>${css}</style>${body}`;
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
  const fragment = (css: string): string =>
    `<!DOCTYPE html><style>${css}</style><p id="p">hi</p>`;
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
  // and the `<html>` implied around a `<body>`, a block in the initial
  // containing block, whose direction is the root element's (CSS 2.1 10.1)
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
    const box = rootOf(el);
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
    `<!DOCTYPE html><style>${css}</style>${body}`;
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
      assert.deepStrictEqual(rect(rootOf(ours.el)), html, `${css}: the html`);
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
  },
);

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
