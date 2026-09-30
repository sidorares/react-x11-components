// <Html> — replaced elements: images, SVG, aspect-ratio and object-fit.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, expectPixel, renderX11, waitFor } from 'react-x11/test';
import { Html } from '../../src/index.js';
import {
  FONTS,
  RED_PNG,
  SVG_NS,
  boxOf,
  fillsOf,
  h,
  metric,
  render,
  renderWithBytes,
  renderWithImages,
  svgBytes,
  view,
} from './harness.js';
import type { PaintOp, ReplacedBox } from './harness.js';

afterEach(cleanup);

test('an iframe is a box of its size with nothing in it', async () => {
  const { node } = await render(
    '<iframe id="a" style="border:0"></iframe>' +
      '<iframe id="b" width="120" height="40" style="border:0">fallback</iframe>' +
      '<div style="position:relative;height:200px"><div id="c" ' +
      'style="position:absolute;height:50%;width:10px"></div></div>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  assert.deepStrictEqual([a.width, a.height], [300, 150], "HTML's default");
  const b = boxOf(el, 'b');
  assert.deepStrictEqual([b.width, b.height], [120, 40], 'its attributes');
  assert.ok(
    !el.textContent().includes('fallback'),
    'what an iframe holds is not the document',
  );
  const c = boxOf(el, 'c');
  assert.strictEqual(c.height, 100, 'half its containing block');
});

test('a canvas is the size of its bitmap, and keeps its proportions', async () => {
  // HTML 4.12.5: `width` and `height` give a canvas its bitmap, 300 by 150
  // where they do not, and no script draws in it here. Taken for an
  // element with no box of its own it took no room, and the attributes
  // were no size hints either, so a canvas set a height kept no width.
  const { node } = await render(
    '<div><canvas id="a"></canvas></div>' +
      '<div><canvas id="b" width="10" height="20" style="height:60px">' +
      'fallback</canvas></div>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  assert.deepStrictEqual([a.width, a.height], [300, 150], 'the default bitmap');
  const b = boxOf(el, 'b');
  assert.deepStrictEqual([b.width, b.height], [30, 60], 'its proportions');
  assert.ok(!el.textContent().includes('fallback'), 'a canvas is drawn');
});

metric('an image set display: block is a block', async () => {
  // mail writes `img { display: block }` to lose the gap under its images;
  // they stacked on one line as inline images, and one beside a float
  // went under it
  const { node } = await render(
    '<div style="width:300px"><div id="f" style="float:left;width:40px;' +
      'height:100px"></div><img id="a" width="20" height="20" ' +
      'style="display:block"><img id="b" width="20" height="20" ' +
      'style="display:block"></div>',
  );
  const el = view(node);
  const [f, a, b] = ['f', 'a', 'b'].map((id) => boxOf(el, id));
  assert.strictEqual(b.y, a.y + a.height, 'one below the other');
  assert.strictEqual(a.x, f.x + f.width, 'beside the float, not under it');
});

/** The box laid out for an element, with the replaced fields this reads. */
test('an inline SVG is sized by the width, height and ratio it gives (CSS 2.1 10.3.2)', async () => {
  const { node } = await render(
    '<style>body{margin:0}svg{display:block}</style>' +
      // a height and no ratio: the width is the default object size's
      '<svg id="h" height="50"></svg>' +
      // nothing at all: the default object size, 300 by 150
      '<svg id="n"></svg>' +
      // a ratio alone: as wide as a block, and as tall as the ratio says
      '<svg id="r" viewBox="0 0 100 50"></svg>' +
      '<svg id="w" width="40" height="20"></svg>' +
      // the attributes are CSS lengths, a percentage too
      '<svg id="p" viewBox="0 0 10 10" width="25%"></svg>' +
      '<svg id="u" width="0.5in" height="1pc"></svg>',
    400,
  );
  const el = view(node);
  const size = (id: string): [number, number] => {
    const box = boxOf(el, id);
    return [box.width, box.height];
  };
  assert.deepStrictEqual(size('h'), [300, 50]);
  assert.deepStrictEqual(size('n'), [300, 150]);
  assert.deepStrictEqual(size('r'), [400, 200]);
  assert.deepStrictEqual(size('w'), [40, 20]);
  assert.deepStrictEqual(size('p'), [100, 100]);
  assert.deepStrictEqual(size('u'), [48, 16]);
  assert.strictEqual((boxOf(el, 'n') as ReplacedBox).replaced, 'svg');
});

test('an SVG root under a prefix bound to SVG is one, and a type selector sees it', async () => {
  const { node } = await render(
    '<style>body{margin:0}svg{display:block;width:77px}</style>' +
      '<div xmlns:svg="http://www.w3.org/2000/svg">' +
      '<svg:svg id="s" height="30"><svg:rect width="10" height="10"/></svg:svg>' +
      '</div>' +
      // a Word document's prefix: not SVG, and nothing a selector names
      '<div xmlns:o="urn:schemas-microsoft-com:office:office">' +
      '<o:svg id="o">x</o:svg></div>',
    400,
  );
  const el = view(node);
  const svg = boxOf(el, 's') as ReplacedBox;
  assert.strictEqual(svg.replaced, 'svg');
  assert.deepStrictEqual([svg.width, svg.height], [77, 30]);
  const other = boxOf(el, 'o') as ReplacedBox;
  assert.strictEqual(other.replaced, 'none');
  assert.notStrictEqual(other.width, 77);
});

test('a limit on one axis of an image carries to the other through its ratio (CSS 2.1 10.4)', async () => {
  // the 10 by 10 red square, in a column 5px wide
  const { el } = await renderWithBytes(
    '<style>body{margin:0}img{display:block}</style>' +
      '<div style="width:5px">' +
      '<img id="a" src="r.png" style="max-width:100%">' +
      // a width set, as a mail template sets it, and a limit under it
      '<img id="b" src="r.png" width="10" style="max-width:100%">' +
      '</div>' +
      '<img id="c" src="r.png" style="min-width:20px">' +
      '<img id="d" src="r.png" style="height:30px;max-width:15px">',
    { 'r.png': RED_PNG },
  );
  const size = (id: string): [number, number] => {
    const box = boxOf(el, id);
    return [box.width, box.height];
  };
  assert.deepStrictEqual(size('a'), [5, 5], 'max-width: 100%, both auto');
  assert.deepStrictEqual(size('b'), [5, 5], 'width set, height from it');
  assert.deepStrictEqual(size('c'), [20, 20], 'min-width, both auto');
  // a height set is kept: only the width follows the limit
  assert.deepStrictEqual(size('d'), [15, 30], 'height set');
});

test('an SVG image is sized by what its document says, and a PNG still decodes', async () => {
  const { el } = await renderWithBytes(
    '<style>body{margin:0}img{display:block}</style>' +
      '<img id="h" src="h.svg"><img id="r" src="r.svg">' +
      '<img id="w" src="w.svg"><img id="p" src="p.png">',
    {
      'h.svg': svgBytes(`<svg ${SVG_NS} height="25"><rect/></svg>`),
      // after a byte order mark and an XML declaration: still sniffed
      'r.svg': svgBytes(
        `﻿<?xml version="1.0"?>\n<svg ${SVG_NS} viewBox="0 0 2 1"/>`,
      ),
      'w.svg': svgBytes(`<svg ${SVG_NS} width="50" viewBox="0 0 1 2"/>`),
      'p.png': RED_PNG,
    },
  );
  const size = (id: string): [number, number] => {
    const box = boxOf(el, id);
    return [box.width, box.height];
  };
  await waitFor(() => assert.deepStrictEqual(size('h'), [300, 25]));
  assert.deepStrictEqual(size('r'), [400, 200]);
  assert.deepStrictEqual(size('w'), [50, 100]);
  assert.deepStrictEqual(size('p'), [10, 10]);
});

test('an object is its image once its data is one, and its content until then', async () => {
  const { el } = await renderWithBytes(
    '<style>body{margin:0}</style>' +
      '<object id="o" data="r.png" type="image/png">fallback</object>' +
      '<object id="f" data="gone.png">still here</object>',
    { 'r.png': RED_PNG },
  );
  await waitFor(() =>
    assert.strictEqual((boxOf(el, 'o') as ReplacedBox).replaced, 'image'),
  );
  const o = boxOf(el, 'o');
  assert.deepStrictEqual([o.width, o.height], [10, 10]);
  assert.strictEqual((boxOf(el, 'f') as ReplacedBox).replaced, 'none');
  assert.ok(el.textContent().includes('still here'), 'the fallback content');
  assert.ok(!el.textContent().includes('fallback'), 'not the loaded one');
});

metric(
  'an SVG draws its viewport: percentages, the fit of its viewBox, the clip and currentColor',
  async () => {
    const { result } = await renderWithBytes(
      '<style>body{margin:0}svg{display:block}</style>' +
        // 100% of a 300 by 20 viewport
        '<svg height="20"><rect width="100%" height="100%" fill="#00ff00"/></svg>' +
        // a square viewBox in a 40 by 20 box: 20 by 20, in the middle
        '<svg viewBox="0 0 10 10" style="width:40px;height:20px">' +
        '<rect width="10" height="10" fill="#0000ff"/></svg>' +
        // a rect larger than its viewport is clipped to it
        '<svg width="10" height="10"><rect width="50" height="50" fill="#ff0000"/></svg>' +
        // currentColor is the colour the box inherits
        '<div style="color:#ff00ff"><svg width="10" height="10">' +
        '<rect width="10" height="10" fill="currentColor"/></svg></div>',
      {},
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 250, 10, '#00ff00', { message: '100% wide' });
    await expectPixel(ctx, 5, 30, '#ffffff', { message: 'beside the fit' });
    await expectPixel(ctx, 20, 30, '#0000ff', { message: 'the fitted square' });
    await expectPixel(ctx, 35, 30, '#ffffff', { message: 'beside the fit' });
    await expectPixel(ctx, 5, 45, '#ff0000', { message: 'inside the clip' });
    await expectPixel(ctx, 20, 45, '#ffffff', { message: 'outside the clip' });
    await expectPixel(ctx, 5, 55, '#ff00ff', { message: 'currentColor' });
  },
);

metric(
  'a <use> draws an element from anywhere in the document, a symbol fitted to its viewport',
  async () => {
    // SVG 2, 5.5: a `<use>` refers to an element of the document, and a
    // `<symbol>` is drawn in a viewport of the use's, its `viewBox` fitted
    // to it. An icon sprite is a drawing that is not displayed, of symbols
    // every icon on the page is a `<use>` of: Docusaurus's external-link
    // arrow, GitHub's octicons. The drawing looked among its own elements
    // and found nothing, and a symbol of its own was drawn unfitted.
    const { result } = await renderWithBytes(
      '<style>body{margin:0}svg{display:block}</style>' +
        '<svg style="display:none"><symbol id="half" viewBox="0 0 24 24">' +
        '<rect x="12" width="12" height="24" fill="currentColor"/></symbol>' +
        '<rect id="bar" width="30" height="10" fill="#0000ff"/></svg>' +
        // 24 units across 12 pixels: the right half, in the box's colour
        '<div style="color:#ff0000"><svg width="12" height="12">' +
        '<use href="#half"/></svg></div>' +
        // a symbol of the drawing's own, in the viewport the use gives it
        '<svg width="40" height="20"><symbol id="own" viewBox="0 0 2 2">' +
        '<rect width="1" height="2" fill="#00ff00"/></symbol>' +
        '<use xlink:href="#own" x="20" width="20" height="20"/></svg>' +
        // an element that is no symbol, moved by the use's `x`
        '<svg width="60" height="10"><use href="#bar" x="20"/></svg>' +
        // and one that refers to nothing draws nothing
        '<svg width="10" height="10"><use href="#none"/></svg>',
      {},
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 3, 6, '#ffffff', { message: 'the left half' });
    await expectPixel(ctx, 9, 6, '#ff0000', { message: 'the right, fitted' });
    await expectPixel(ctx, 10, 22, '#ffffff', { message: 'before its x' });
    await expectPixel(ctx, 25, 22, '#00ff00', { message: 'its left half' });
    await expectPixel(ctx, 35, 22, '#ffffff', { message: 'its right' });
    await expectPixel(ctx, 10, 37, '#ffffff', { message: 'moved by x' });
    await expectPixel(ctx, 35, 37, '#0000ff', { message: 'the other’s rect' });
    await expectPixel(ctx, 55, 37, '#ffffff', { message: 'and no wider' });
    await expectPixel(ctx, 5, 47, '#ffffff', { message: 'nothing found' });
  },
);

metric(
  'a <use> finds the element a document that is still arriving brings later',
  async () => {
    // a sprite at the end of the body, after the icons that use it
    const icon =
      '<style>body{margin:0}svg{display:block}</style>' +
      '<svg width="12" height="12"><use href="#late"/></svg><p>text</p>';
    const doc = (source: string) =>
      h(
        'box',
        { style: { width: 300, flexDirection: 'column' } },
        h(Html, { source, 'data-testname': 'doc' }),
      );
    const result = await renderX11(doc(icon), {
      width: 340,
      height: 200,
      fonts: FONTS!,
    });
    await expectPixel(result.ctx, 6, 6, '#ffffff', { message: 'not yet' });
    await act(() =>
      result.rerender(
        doc(
          icon +
            '<svg style="display:none"><symbol id="late" viewBox="0 0 2 2">' +
            '<rect width="2" height="2" fill="#ff0000"/></symbol></svg>',
        ),
      ),
    );
    await expectPixel(result.ctx, 6, 6, '#ff0000', { message: 'now it has' });
  },
);

metric(
  "an inline SVG is painted with the fill and stroke the document's styles give it",
  async () => {
    // `fill` and `stroke` are properties (SVG 2, 13.2): a rule of the
    // document's sets them on an `<svg>` over its presentation attributes,
    // they inherit into it, and what is in the drawing inherits them from
    // its root. Only the attributes were read, so an icon set that paints
    // its icons from a style sheet — `.octicon { fill: currentColor }`, and
    // a muted tab's `fill: var(--fgColor-muted)` — drew them all black.
    const rect = '<rect width="10" height="10"/>';
    const svg = (attrs: string, inside = rect) =>
      `<svg width="10" height="10" ${attrs}>${inside}</svg>`;
    const { result } = await renderWithBytes(
      '<style>body{margin:0;color:#0000ff} svg{display:block}' +
        ':root{--muted:#ff0000} .i{fill:currentColor}' +
        '.m{color:var(--muted);fill:var(--muted)} .g{fill:#00aa00}' +
        '.s{stroke:#ff00ff} .n{fill:none}</style>' +
        svg('class="i"') +
        svg('class="i m"') +
        svg('class="g"') +
        // nothing set: the drawing's own, black
        svg('') +
        // a rule over the attribute, and the attribute over what is inherited
        svg('class="i" fill="#00aa00"') +
        `<div style="fill:#ff0000">${svg('fill="#00aa00"')}</div>` +
        `<div style="fill:#ff00ff">${svg('')}</div>` +
        // and what is in the drawing says for itself
        svg('class="g"', '<rect width="10" height="10" fill="#0000ff"/>') +
        svg('class="s" fill="none" stroke-width="4"') +
        svg('class="n"'),
      {},
    );
    const ctx = result.ctx;
    const row = (n: number) => n * 10 + 5;
    await expectPixel(ctx, 5, row(0), '#0000ff', { message: 'currentColor' });
    await expectPixel(ctx, 5, row(1), '#ff0000', { message: 'a variable' });
    await expectPixel(ctx, 5, row(2), '#00aa00', { message: 'a colour' });
    await expectPixel(ctx, 5, row(3), '#000000', { message: 'none set' });
    await expectPixel(ctx, 5, row(4), '#0000ff', { message: 'over its own' });
    await expectPixel(ctx, 5, row(5), '#00aa00', { message: 'its attribute' });
    await expectPixel(ctx, 5, row(6), '#ff00ff', { message: 'inherited' });
    await expectPixel(ctx, 5, row(7), '#0000ff', { message: "a shape's own" });
    await expectPixel(ctx, 1, row(8), '#ff00ff', { message: 'a stroke' });
    await expectPixel(ctx, 5, row(8), '#ffffff', { message: 'and no fill' });
    await expectPixel(ctx, 5, row(9), '#ffffff', { message: 'fill: none' });
  },
);

metric(
  "a shape in an inline SVG is painted as the document's rules say",
  async () => {
    // A rule's subject may be an element inside a drawing: `fill`, `stroke`
    // and their kin are properties (SVG 2, 6.2), which a rule sets on a
    // `<path>` over its presentation attributes, under its `style`. An
    // `<svg>` is a replaced box, so the cascade never reached what is in
    // it, and only the attributes were read: a logo coloured by
    // `.logo path { fill: … }` was black, and a drawing exported with a
    // style sheet of its own, `.st0 { fill: #fff }`, was all black too.
    const rect = (attrs = '') => `<rect width="10" height="10" ${attrs}/>`;
    const svg = (inside: string, attrs = '') =>
      `<svg width="10" height="10" ${attrs}>${inside}</svg>`;
    const rows: [string, string, string, number?][] = [
      [svg(rect('class="g"')), '#00aa00', 'a rule that names the shape'],
      [
        svg(rect('class="f"'), 'fill="none" stroke="currentColor"'),
        '#00aa00',
        "over what it inherits from its root's attribute",
      ],
      [svg(rect('class="g" fill="#ff0000"')), '#00aa00', 'over its own'],
      [
        svg(rect('class="g" style="fill:#0000ff"')),
        '#0000ff',
        'and under its style attribute',
      ],
      [
        svg(rect('class="m" style="fill:#ff0000"')),
        '#00aa00',
        'but for an important one',
      ],
      [svg(rect('class="c"'), 'fill="#ff0000"'), '#0000ff', 'currentColor'],
      [svg(rect('class="v"')), '#ff00ff', 'a variable'],
      [svg(`<g class="g">${rect()}</g>`), '#00aa00', 'inherited from a group'],
      [
        svg(`<g fill="#00aa00">${rect('class="u" fill="#ff0000"')}</g>`),
        '#00aa00',
        'put back to what it inherits',
      ],
      [svg(rect('class="g x"')), '#00aa00', 'a value that is none is no rule'],
      [svg(rect('class="s" fill="none"')), '#ff0000', 'a stroke', 1],
      [svg(rect('class="s" fill="none"')), '#ffffff', 'and no fill'],
      [
        svg(rect(), 'class="k" fill="none" stroke="#ff0000"'),
        '#ff0000',
        "the root's own stroke width",
        1,
      ],
      [svg(rect('class="h" fill="#ff0000"')), '#ffffff', 'display: none'],
      [
        svg(`<g class="i">${rect('fill="#ff0000"')}</g>`),
        '#ffffff',
        'hidden with its group',
      ],
      [
        svg(`<g class="i">${rect('class="w" fill="#00aa00"')}</g>`),
        '#00aa00',
        'and shown again in it',
      ],
      [svg(rect('class="o" fill="#ff0000"')), '#ffffff', 'opacity'],
      [
        svg(`<defs>${rect('id="r" class="g"')}</defs><use href="#r"/>`),
        '#00aa00',
        'a shape a <use> draws',
      ],
      // a rule for every shape of a type, under some ancestor: around the
      // drawing, in it, or a sibling of one, and no rule's where it has none
      [`<div class="on">${svg(rect())}</div>`, '#00aa00', 'under a class'],
      [svg(`<g class="on">${rect()}</g>`), '#00aa00', 'one in the drawing'],
      [
        `<div id="w">${svg('<circle cx="5" cy="5" r="5"/>')}</div>`,
        '#00aa00',
        'under an id',
      ],
      [
        svg(`<g class="sib"></g><g>${rect()}</g>`),
        '#00aa00',
        'after a sibling',
      ],
      [svg(rect()), '#000000', 'and under none of them'],
      // a drawing's own style sheet is one of the document's
      [
        svg(
          '<defs><style type="text/css"><![CDATA[\n.st0{fill:#00aa00;}\n]]>' +
            `</style></defs>${rect('class="st0"')}`,
        ),
        '#00aa00',
        'a style sheet in the drawing',
      ],
    ];
    const { result } = await renderWithBytes(
      '<style>body{margin:0;color:#0000ff} svg{display:block}' +
        ':root{--brand:#ff00ff} .g{fill:#00aa00} svg rect.f{fill:#00aa00}' +
        '.m{fill:#00aa00 !important} .c{fill:currentColor}' +
        '.v{fill:var(--brand)} .u{fill:inherit} .x{fill:no-colour}' +
        '.s{stroke:#ff0000;stroke-width:4px} .k{stroke-width:4px}' +
        '.h{display:none} .i{visibility:hidden} .w{visibility:visible}' +
        '.o{opacity:0} .on rect{fill:#00aa00} #w circle{fill:#00aa00}' +
        '.sib + g rect{fill:#00aa00} .off rect{fill:#ff0000}</style>' +
        rows.map(([markup]) => markup).join(''),
      {},
    );
    const ctx = result.ctx;
    for (const [i, [, colour, message, x = 5]] of rows.entries()) {
      await expectPixel(ctx, x, i * 10 + 5, colour, { message });
    }
  },
);

metric(
  'an SVG image fills the size it is drawn at, whatever its root says',
  async () => {
    // A root's width and height are what an image's intrinsic size is read
    // from. Drawn, it fills the size that sizing gave it, as every browser
    // draws one: `width="40%"` in an 80 by 100 area is all of it, where it
    // was drawn 32 wide and left `background-size: contain` two fifths
    // full. (CSS 2.1's background-intrinsic-006 asks for the old reading,
    // and no browser passes it.)
    const { result } = await renderWithBytes(
      '<style>body{margin:0}div{width:80px;height:100px;' +
        'background:#ffffff url(g.svg) no-repeat}' +
        '.c{background-size:contain}</style>' +
        '<div></div><div class="c"></div>',
      {
        'g.svg': svgBytes(
          `<svg ${SVG_NS} width="40%" height="60%">` +
            '<rect width="100%" height="100%" fill="#00ff00"/></svg>',
        ),
      },
    );
    const ctx = result.ctx;
    for (const [top, what] of [
      [0, 'no size of its own'],
      [100, 'contained'],
    ] as const) {
      await expectPixel(ctx, 30, top + 55, '#00ff00', { message: what });
      await expectPixel(ctx, 70, top + 10, '#00ff00', {
        message: `${what}: past two fifths of its width`,
      });
      await expectPixel(ctx, 10, top + 90, '#00ff00', {
        message: `${what}: past three fifths of its height`,
      });
    }
  },
);

metric('a viewBox of no height, or no width, draws nothing', async () => {
  // SVG: a zero extent disables the drawing, where a negative one is an
  // error and as though there were no viewBox. Both were read as no
  // viewBox, and the drawing filled its viewport.
  const { result } = await renderWithBytes(
    '<style>body{margin:0}div{width:80px;height:40px;' +
      'background:#ffffff url(z.svg) no-repeat}svg{display:block}</style>' +
      '<div></div>' +
      '<svg width="80" height="40" viewBox="0 0 0 8" preserveAspectRatio="none">' +
      '<rect width="100%" height="100%" fill="#ff0000"/></svg>' +
      '<svg width="80" height="40" viewBox="0 0 -8 8">' +
      '<rect width="100%" height="100%" fill="#0000ff"/></svg>',
    {
      'z.svg': svgBytes(
        `<svg ${SVG_NS} viewBox="0 0 8 0" preserveAspectRatio="none">` +
          '<rect width="100%" height="100%" fill="#ff0000"/></svg>',
      ),
    },
  );
  const ctx = result.ctx;
  await expectPixel(ctx, 40, 20, '#ffffff', { message: 'the image' });
  await expectPixel(ctx, 40, 60, '#ffffff', { message: 'the inline one' });
  await expectPixel(ctx, 40, 100, '#0000ff', {
    message: 'a negative extent is no viewBox, and draws',
  });
});

test('an area the author gives a display is drawn, in its map', async () => {
  // <map> is inline (HTML 15.3.1); hidden, it took its areas with it
  const { node } = await render(
    '<map><area style="display:block;height:10px;' +
      'border:2px solid #00ff00"></map>',
  );
  const fills = await fillsOf(view(node));
  assert.ok(fills.some((f) => f.style === '#00ff00'));
});

test('aspect-ratio: a ratio, auto, or both', async () => {
  const { node } = await render(
    '<div id="a" style="aspect-ratio:16 / 9"></div>' +
      '<div id="b" style="aspect-ratio:auto 4/3"></div>' +
      '<div id="c" style="aspect-ratio:1;aspect-ratio:auto"></div>' +
      '<div id="d" style="aspect-ratio:2;aspect-ratio:0 / 1"></div>' +
      '<div id="e" style="aspect-ratio:3;aspect-ratio:wide"></div>',
  );
  const el = view(node);
  const ratioOf = (id: string) =>
    (boxOf(el, id) as unknown as { style: { aspectRatio: unknown } }).style
      .aspectRatio;
  assert.deepStrictEqual(ratioOf('a'), { ratio: 16 / 9, auto: false });
  assert.deepStrictEqual(ratioOf('b'), { ratio: 4 / 3, auto: true });
  assert.strictEqual(ratioOf('c'), null);
  // a ratio with a nought in it is none, and a word that is no ratio is
  // dropped, leaving the one before
  assert.strictEqual(ratioOf('d'), null);
  assert.deepStrictEqual(ratioOf('e'), { ratio: 3, auto: false });
});

test('aspect-ratio makes an auto height of the width, grown to what it holds', async () => {
  // Tailwind's aspect-video and aspect-square, whose boxes were as tall as
  // their content, and so nothing at all when empty
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="a" style="width:320px;aspect-ratio:16/9"></div>' +
      // of the border box where box-sizing says so, and of the content box
      '<div id="b" style="width:100px;padding:10px;box-sizing:border-box;' +
      'aspect-ratio:1"></div>' +
      '<div id="c" style="width:100px;padding:10px;aspect-ratio:1"></div>' +
      // grown to its content, unless it clips
      '<div id="d" style="width:100px;aspect-ratio:4"><div style="height:60px">' +
      '</div></div>' +
      '<div id="e" style="width:100px;aspect-ratio:4;overflow:hidden">' +
      '<div style="height:60px"></div></div>' +
      // and a height it gives is one a percentage resolves against
      '<div style="width:200px;aspect-ratio:2"><div id="f" style="height:50%">' +
      '</div></div>' +
      '<iframe id="g" style="width:320px;aspect-ratio:16/9;border:0"></iframe>',
  );
  const el = view(node);
  const heightOf = (id: string) => boxOf(el, id).height;
  assert.strictEqual(heightOf('a'), 180);
  assert.strictEqual(heightOf('b'), 100);
  assert.strictEqual(heightOf('c'), 120);
  assert.strictEqual(heightOf('d'), 60);
  assert.strictEqual(heightOf('e'), 25);
  assert.strictEqual(heightOf('f'), 50);
  // a frame has no ratio of its own, and takes the one it is given
  assert.strictEqual(heightOf('g'), 180);
});

test('object-fit places an image in its box, and object-position in it', async () => {
  const fits = ['fill', 'cover', 'contain', 'none', 'scale-down'];
  const { node } = await render(
    '<style>body{margin:0} img{display:block;width:90px;height:90px}</style>' +
      fits
        .map(
          (fit, i) => `<img id="i${i}" src="a.png" style="object-fit:${fit}">`,
        )
        .join('') +
      '<img id="i5" src="a.png" style="object-fit:cover;object-position:left">' +
      '<img id="i6" src="a.png" style="object-fit:scale-down;width:400px;height:200px">',
  );
  const el = view(node);
  // an image twice as wide as it is tall: 240 by 120
  for (let i = 0; i < 7; i += 1) {
    (boxOf(el, `i${i}`) as unknown as { intrinsic: unknown }).intrinsic = {
      width: 240,
      height: 120,
      missing: 0,
      ratio: 2,
    };
  }
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, { imageFor: () => ({}) });
  const drawn = ops.filter((op) => op.op === 'image');
  const at = (i: number) => {
    const op = drawn[i];
    return op.op === 'image' ? [op.x, op.y - i * 90, op.w, op.h] : [];
  };
  assert.deepStrictEqual(at(0), [0, 0, 90, 90], 'fill: stretched');
  assert.deepStrictEqual(at(1), [-45, 0, 180, 90], 'cover: the middle');
  assert.deepStrictEqual(at(2), [0, 23, 90, 45], 'contain: all of it');
  assert.deepStrictEqual(at(3), [-75, -15, 240, 120], 'none: its own size');
  assert.deepStrictEqual(at(4), [0, 23, 90, 45], 'scale-down, when smaller');
  assert.deepStrictEqual(at(5), [0, 0, 180, 90], 'cover, from the left');
  // scale-down in a box larger than the image: its own size, in the middle
  const big = drawn[6];
  assert.ok(big.op === 'image');
  assert.deepStrictEqual([big.x, big.w, big.h], [80, 240, 120]);
  // what falls past its box is clipped to it, and nothing else is
  const clips = ops.filter((op) => op.op === 'clip').length;
  assert.strictEqual(clips, 3, 'cover twice and none');
});

test('object-position places a filled image, and one with a ratio and no size', async () => {
  // CSS Images 3, 5.5: `fill` was drawn at the box whatever object-position
  // said — its lengths still move it — and an image with a ratio and no
  // size of its own, an SVG with only a viewBox, was stretched to the box
  // whatever the fit. And it is placed on the pixel grid, as a
  // background's tile is: 13% of 15 pixels is 1.95
  const { node } = await render(
    '<style>body{margin:0} img{display:block;width:90px;height:60px}</style>' +
      '<img id="a" src="a.png" style="object-position:right 2px bottom 1px">' +
      '<img id="b" src="b.svg" style="object-fit:contain">' +
      '<img id="c" src="c.svg" style="object-fit:none">' +
      '<img id="d" src="d.png" style="object-fit:contain;' +
      'object-position:50% 13%">',
  );
  const el = view(node);
  const own = (id: string, missing: number) => {
    (boxOf(el, id) as unknown as { intrinsic: unknown }).intrinsic = {
      width: missing ? 300 : 240,
      height: missing ? 150 : 120,
      missing,
      ratio: 2,
    };
  };
  own('a', 0);
  own('b', 3);
  own('c', 3);
  own('d', 0);
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, { imageFor: () => ({}) });
  const drawn = ops.filter((op) => op.op === 'image');
  const at = (i: number) => {
    const op = drawn[i];
    return op.op === 'image' ? [op.x, op.y - i * 60, op.w, op.h] : [];
  };
  assert.deepStrictEqual(at(0), [-2, -1, 90, 60], 'fill, moved by lengths');
  assert.deepStrictEqual(at(1), [0, 8, 90, 45], 'contain: at its ratio');
  assert.deepStrictEqual(at(2), [0, 8, 90, 45], 'none, with no size: within');
  assert.deepStrictEqual(at(3), [0, 2, 90, 45], 'on the pixel grid');
});

metric("a video's poster and an embedded image are drawn", async () => {
  // A `<video>` and an `<embed>` were frames whatever they pointed at: a
  // video shows its poster, which it fits into its box by the HTML style
  // sheet's `object-fit: contain`, and an embed its image
  const ctx = await renderWithImages(
    '<style>body{margin:0} *{display:block}</style>' +
      '<video poster="p.png" style="width:40px;height:20px"></video>' +
      '<embed src="e.png" style="width:20px;height:20px">',
  );
  await expectPixel(ctx, 20, 10, '#ff0000', { message: "the poster's middle" });
  await expectPixel(ctx, 5, 10, '#ffffff', { message: 'contained: not here' });
  await expectPixel(ctx, 10, 30, '#ff0000', { message: 'the embed' });
});

test("aspect-ratio makes a box's width of its height, and crosses its limits over", async () => {
  // A height and a ratio gave a block the width of its container, and
  // `width: min-content` the width of what was in it
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="a" style="height:50px;aspect-ratio:2"></div>' +
      '<div id="b" style="height:50px;width:min-content;aspect-ratio:2"></div>' +
      // a greatest height is a greatest width through the ratio
      '<div id="c" style="aspect-ratio:1;max-height:40px"></div>' +
      // and a least height of 0 lets the ratio hold its content in
      '<div style="position:relative;height:200px">' +
      '<div id="d" style="position:absolute;aspect-ratio:1;width:100px;' +
      'min-height:0"><div style="height:200px"></div></div>' +
      // both offsets stretch a width that a greatest height then holds
      '<div id="e" style="position:absolute;inset:0;max-height:100px;' +
      'aspect-ratio:1"></div></div>' +
      // a height its ratio gives it parts its two margins, which went on
      // through it as through an empty block's
      '<div id="f"></div><div id="w">' +
      '<div style="width:100px;aspect-ratio:4;margin:10px 0 30px"></div></div>' +
      '<div id="g"></div>',
  );
  const el = view(node);
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  assert.deepStrictEqual(size('a'), [100, 50]);
  assert.deepStrictEqual(size('b'), [100, 50]);
  assert.deepStrictEqual(size('c'), [40, 40]);
  assert.deepStrictEqual(size('d'), [100, 100]);
  assert.deepStrictEqual(size('e'), [100, 100]);
  assert.strictEqual(boxOf(el, 'w').y - boxOf(el, 'f').y, 10);
  assert.strictEqual(boxOf(el, 'g').y - boxOf(el, 'f').y, 10 + 25 + 30);
});

metric("an SVG image's root background covers the image", async () => {
  // A browser paints it over the canvas, which is the whole image, wherever
  // the viewBox puts the drawing; it was not painted at all
  const { result } = await renderWithBytes(
    '<style>body{margin:0}img{display:block}</style>' +
      '<img src="g.svg" style="width:100px;height:40px">',
    {
      'g.svg': svgBytes(
        `<svg ${SVG_NS} viewBox="0 0 1 1" style="background-color:#00ff00">` +
          '</svg>',
      ),
    },
  );
  const ctx = result.ctx;
  await expectPixel(ctx, 50, 20, '#00ff00', { message: 'the middle' });
  await expectPixel(ctx, 5, 20, '#00ff00', { message: 'beside the viewBox' });
});
