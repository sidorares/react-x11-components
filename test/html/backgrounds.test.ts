// <Html> — backgrounds: images, gradients, layers, their size, position and
// clip.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import {
  act,
  cleanup,
  expectPixel,
  isNear,
  pixelAt,
  renderX11,
  screen,
  waitFor,
} from 'react-x11/test';
import { parseColor } from '../../src/html/css/values.js';
import { blend } from '../../src/html/css/color.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import { SvgDrawing } from '../../src/html/svg.js';
import {
  FONTS,
  RED_PNG,
  SVG_NS,
  boxOf,
  bytesApart,
  fillsIn,
  fillsOf,
  h,
  metric,
  pathsOf,
  pixelsPng,
  render,
  render2x,
  renderAsking,
  rebuilt,
  renderWithBytes,
  renderWithImages,
  snapshot,
  solidPng,
  svgBytes,
  treeOf,
  view,
  windingAt,
} from './harness.js';
import type { Fill, PaintOp } from './harness.js';
import { Html } from '../../src/index.js';
import type { DrawnNode } from 'react-x11';
import type {
  HtmlViewNode,
  ResourceRequest,
  ResourceResult,
} from '../../src/html/index.js';

afterEach(cleanup);

test('a background-position keyword says which axis it is on', async () => {
  const { node } = await render(
    '<div id="a" style="background-position:bottom"></div>' +
      '<div id="b" style="background-position:top right"></div>' +
      '<div id="c" style="background:url(x.png) repeat-x left 10px"></div>',
  );
  const el = view(node);
  const at = (id: string) => {
    const s = (
      boxOf(el, id) as unknown as {
        style: { backgroundPositionX: unknown; backgroundPositionY: unknown };
      }
    ).style;
    return [s.backgroundPositionX, s.backgroundPositionY];
  };
  assert.deepStrictEqual(at('a'), [{ pct: 50 }, { pct: 100 }], 'alone');
  assert.deepStrictEqual(at('b'), [{ pct: 100 }, 0], 'either order');
  assert.deepStrictEqual(at('c'), [0, 10], 'in the shorthand');
});

test('background-attachment is read, in its longhand and the shorthand', async () => {
  // `fixed` positions the image against the viewport, the element, rather
  // than the box (CSS 2.1 14.2.1); the shorthand sets it back to `scroll`
  const { node } = await render(
    '<div id="a" style="background-attachment:fixed"></div>' +
      '<div id="b" style="background:url(x.png) fixed repeat-x"></div>' +
      '<div id="c" style="background-attachment:fixed;background:red"></div>',
  );
  const el = view(node);
  const of = (id: string) =>
    (boxOf(el, id) as unknown as { style: { backgroundAttachment: string } })
      .style.backgroundAttachment;
  assert.deepStrictEqual(['a', 'b', 'c'].map(of), ['fixed', 'fixed', 'scroll']);
});

metric(
  'a background image is placed, repeated and clipped as CSS says',
  async () => {
    // Parsed and never drawn: background-image had no request and no paint.
    const ctx = await renderWithImages(
      '<style>body{margin:0}div{width:60px;height:30px;' +
        'background:#00ff00 url(red.png) no-repeat 20px 10px}' +
        '.x{background-repeat:repeat-x;background-position:0 0}</style>' +
        '<div></div><div class="x"></div>',
    );
    await expectPixel(ctx, 25, 15, '#ff0000', {
      message: 'the tile, at 20,10',
    });
    await expectPixel(ctx, 5, 5, '#00ff00', {
      message: 'the colour around it',
    });
    await expectPixel(ctx, 45, 15, '#00ff00', {
      message: 'no-repeat: one tile',
    });
    // repeat-x: a row of tiles across the second box, and nothing under them
    await expectPixel(ctx, 55, 35, '#ff0000', { message: 'repeated across' });
    await expectPixel(ctx, 55, 50, '#00ff00', { message: 'one row only' });
  },
);

metric("the root's background covers the whole canvas", async () => {
  // CSS 2.1 14.2: <body>'s background, where <html> has none, is the
  // canvas's — the margin round the body included — as an email's
  // <body bgcolor> is meant to be.
  const ctx = await renderWithImages(
    '<html><body style="background:#00ff00;margin:20px"><p>x</p></body></html>',
  );
  await expectPixel(ctx, 4, 4, '#00ff00', {
    message: 'inside the body margin',
  });
  await expectPixel(ctx, 100, 110, '#00ff00', {
    message: 'below the document, where the element has grown',
  });
});

test('background-size is in CSS pixels at 2x', async () => {
  // a length and a percentage are device pixels by the time they are
  // stored, and an image's own size is CSS pixels until it is drawn
  const { node } = await render2x(
    '<style>body{margin:0}div{width:100px;height:100px;' +
      'background:url(x.png) no-repeat}</style>' +
      '<div style="background-size:20px 10px"></div>' +
      '<div style="background-size:contain"></div>' +
      '<div style="background-size:auto 15px"></div>' +
      '<div style="background-size:50%"></div>',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    scale: 2,
    backgroundImageFor: () => ({ image: {}, width: 20, height: 10, ratio: 2 }),
  });
  assert.deepStrictEqual(
    ops.flatMap((op) => (op.op === 'image' ? [[op.w, op.h]] : [])),
    [
      [40, 20],
      [200, 100],
      [60, 30],
      [100, 50],
    ],
  );
});

metric(
  "an inline box's background image is drawn, as its colour is",
  async () => {
    // CSS Backgrounds 3: an inline box's background is its images as much
    // as its colour, on each of its fragments. Only its colour was drawn:
    // design 021's resource links, each with an arrow in its left padding,
    // came out as coloured boxes with none
    const { result } = await renderWithBytes(
      '<style>body{margin:0;font:16px/30px sans-serif}p{margin:0}' +
        'span{padding:0 0 0 20px;background:#ffffff url(a.svg) 0 5px ' +
        'no-repeat}</style><p><span>word</span></p>',
      {
        'a.svg': svgBytes(
          `<svg ${SVG_NS} width="10" height="10">` +
            '<rect width="10" height="10" fill="#ff0000"/></svg>',
        ),
      },
    );
    await act();
    const ctx = result.ctx;
    // the image, 10px square at 0 5px of the span's padding box: its top
    // is the span's content area's, which a 30px line puts below the top
    let found = -1;
    for (let y = 0; y < 30 && found < 0; y += 1) {
      const px = await new Promise<Uint8ClampedArray>((ok, fail) =>
        (
          ctx as unknown as {
            getImageData(
              x: number,
              y: number,
              w: number,
              h: number,
              cb: (e: unknown, d: { data: Uint8ClampedArray }) => void,
            ): void;
          }
        ).getImageData(5, y, 1, 1, (e, d) => (e ? fail(e) : ok(d.data))),
      );
      if (px[0] > 200 && px[1] < 60 && px[2] < 60) found = y;
    }
    assert.ok(found >= 0, 'the image is drawn in the padding');
    await expectPixel(ctx, 15, found + 2, '#ffffff', {
      message: 'and no further than its own width',
    });
  },
);

metric(
  "a fragment's implied html paints the canvas, and its body is as tall as it says",
  async () => {
    // A document with neither tag has the root box standing in for its
    // body, and the `<html>` around it implied: what an `html` or `:root`
    // rule gave that `<html>` beyond what it passes down was drawn nowhere
    // — its background, which a reftest's reference sets on a document
    // with no tags at all — and the box took the body's font and colours
    // but not its height, so `html, body { height: 100% }` left a page as
    // short as its text
    const first = await renderWithBytes(
      '<style>:root{background:#00ff00}</style><p>x</p>',
      {},
    );
    await expectPixel(first.result.ctx, 200, 10, '#00ff00', {
      message: "the implied html's background",
    });
    cleanup();
    // a body a quarter of the window tall, and a page taller than it
    const { result } = await renderWithBytes(
      '<style>html{height:100%;background:#00ff00}' +
        'body{margin:0;height:25%;background:#0000ff}div{height:300px}' +
        '</style><div></div>',
      {},
    );
    await expectPixel(result.ctx, 200, 50, '#0000ff', {
      message: "the body's own background",
    });
    await expectPixel(result.ctx, 200, 200, '#00ff00', {
      message: 'the canvas below the body, under what overflows it',
    });
  },
);

metric(
  "an invalid background is dropped whole, and CSS3's forms are kept",
  async () => {
    const { el } = await renderWithBytes(
      '<style>p { background: #00ff00 }' +
        '#a { background: "red" } #b { background: red\\; }' +
        '#c { background: red green } #d { background: red, url(b.png) }' +
        '#e { background: url(a.png) no-repeat right 10px center / cover #fff }' +
        '#f { background: #333 linear-gradient(to right, #fff, #000) }' +
        '#g { background-position: 5px 5px; background: #fff }</style>' +
        '<p id="a">a</p><p id="b">b</p><p id="c">c</p><p id="d">d</p>' +
        '<p id="e">e</p><p id="f">f</p><p id="g">g</p>',
      {},
    );
    const style = (id: string) =>
      (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
    // each of these was a background reset to nothing
    for (const id of ['a', 'b', 'c', 'd']) {
      assert.strictEqual(style(id).backgroundColor, '#00ff00', id);
    }
    const e = style('e');
    assert.strictEqual(e.backgroundColor, '#fff');
    assert.strictEqual(e.backgroundImage, 'a.png');
    assert.deepStrictEqual(e.backgroundRepeat, ['no-repeat', 'no-repeat']);
    assert.strictEqual(e.backgroundSize, 'cover');
    assert.deepStrictEqual(e.backgroundPositionX, { pct: 100, px: -10 });
    assert.deepStrictEqual(e.backgroundPositionY, { pct: 50 });
    // a gradient is drawn as nothing, over the colour beside it
    assert.strictEqual(style('f').backgroundColor, '#333');
    // and the shorthand resets what it does not name
    assert.strictEqual(style('g').backgroundPositionX, 0);
  },
);

metric('a body with no html tag paints the canvas', async () => {
  const { result } = await renderWithBytes(
    '<body style="background: #00ff00; margin: 20px"><p>x</p></body>',
    {},
  );
  // outside the body's margin, where only the canvas is
  const [r, g, b] = await pixelAt(result.ctx, 4, 4);
  assert.ok(g > 200 && r < 60 && b < 60, `the canvas is green: ${r},${g},${b}`);
});

metric('a body in an html set to be a table paints the canvas', async () => {
  // the body is in an anonymous row and cell there, and the canvas looked
  // for it among the root's children only
  const { result } = await renderWithBytes(
    '<html style="display:table"><body style="position:absolute;' +
      'left:50px;top:50px;width:20px;height:20px;margin:0;' +
      'background:#00ff00"></body></html>',
    {},
  );
  const [r, g, b] = await pixelAt(result.ctx, 4, 4);
  assert.ok(g > 200 && r < 60 && b < 60, `the canvas is green: ${r},${g},${b}`);
});

metric(
  'a background position from the far edge is that far in from it',
  async () => {
    const { result } = await renderWithBytes(
      '<style>body { margin: 0 }</style>' +
        '<div style="width: 100px; height: 40px; ' +
        'background: url(r.png) no-repeat right 20px top 5px"></div>',
      { 'r.png': RED_PNG },
    );
    // the 10px image's right edge twenty pixels in from the box's
    const red = async (x: number, y: number) => {
      const [r, g, b] = await pixelAt(result.ctx, x, y);
      return r > 200 && g < 60 && b < 60;
    };
    await waitFor(async () =>
      assert.ok(await red(75, 10), 'in from the right'),
    );
    assert.ok(!(await red(95, 10)), 'not against the right edge');
    assert.ok(!(await red(75, 2)), 'and five down');
  },
);

test('a linear gradient is drawn over the colour, across the box', async () => {
  // CSS Images 3: Tailwind 4's `bg-linear-to-r from-… to-…` is written
  // `linear-gradient(to right in oklab, …)`, and a gradient was drawn as
  // nothing
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:200px;height:100px;background:#ffffff ' +
      'linear-gradient(to right in oklab, #ff0000, #00ff00 40%, #0000ff)">' +
      '</div><div style="width:100px;height:100px;background-image:' +
      'linear-gradient(to top right, #ff0000 20px, #0000ff)"></div>',
  );
  const fills = await fillsOf(view(node));
  const gradients = fills
    .map((f) => f.style as { line?: number[]; stops?: [number, string][] })
    .filter((g) => g && g.line);
  assert.strictEqual(gradients.length, 2);
  const [across, corner] = gradients;
  assert.deepStrictEqual(
    across.line!.map((v) => Math.round(v)),
    [0, 50, 200, 50],
  );
  assert.deepStrictEqual(
    across.stops!.map(([at]) => at),
    [0, 0.4, 1],
  );
  // a corner's line is the square's diagonal, its first stop 20px along it
  const [x0, y0, x1, y1] = corner.line!;
  assert.ok(Math.abs(x1 - x0 - 100) < 1e-6 && Math.abs(y0 - y1 - 100) < 1e-6);
  assert.ok(Math.abs(corner.stops![0][0] - 20 / Math.hypot(100, 100)) < 1e-6);
  // and the white is painted under the first one
  assert.ok(fills.some((f) => f.style === parseColor('#ffffff')));
});

/** The gradients a paint filled with, and where. */
function gradientFills(fills: Fill[]) {
  return fills
    .filter((f) => (f.style as { line?: number[] } | null)?.line)
    .map((f) => {
      const g = f.style as { line: number[]; stops: [number, string][] };
      // to the thousandth, where a sine of pi is not quite nought
      const line = g.line.map((v) => Math.round(v * 1000) / 1000 + 0);
      return { x: f.x, y: f.y, w: f.w, h: f.h, line, stops: g.stops };
    });
}

test('a gradient is the size of the padding box, and repeats under the borders', async () => {
  // CSS Backgrounds 3: an image with no size of its own is the size of the
  // background positioning area, the padding box, and tiles from there; a
  // gradient measured on the border box put every stop a border's width
  // early (WPT floats-clear/clear-on-replaced-element's red bands)
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px;height:40px;' +
      'border:10px dashed transparent;background-image:' +
      'linear-gradient(to right, #ff0000, #0000ff)"></div>',
  );
  const tiles = gradientFills(await fillsOf(view(node)));
  assert.strictEqual(
    tiles.length,
    9,
    'the padding box and the eight around it',
  );
  const middle = tiles.find((t) => t.x === 10 && t.y === 10)!;
  assert.deepStrictEqual([middle.w, middle.h], [100, 40]);
  assert.deepStrictEqual(middle.line, [10, 30, 110, 30]);
  // the left border shows the end of the tile before, not the start colour
  const left = tiles.find((t) => t.x === 0 && t.y === 10)!;
  assert.deepStrictEqual([left.w, left.h], [10, 40]);
  assert.deepStrictEqual(left.line, [-90, 30, 10, 30]);
});

test("a gradient's stops past its ends lengthen its line", async () => {
  // the colours at the box's edges are the ones between, not the stops'
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px;height:20px;' +
      'background-image:linear-gradient(90deg, #ff0000 -50%, #00ff00, ' +
      '#0000ff 150%)"></div>',
  );
  const [only] = gradientFills(await fillsOf(view(node)));
  assert.deepStrictEqual(only.line, [-50, 10, 150, 10]);
  assert.deepStrictEqual(
    only.stops.map(([at]) => at),
    [0, 0.5, 1],
  );
});

test('a gradient far off the window is drawn from the part of its line it shows', async () => {
  // X RENDER takes a gradient's ends in 16.16 fixed point, and a line that
  // ended past ±32,767 pixels threw from the paint: a gradient down a long
  // wrapper scrolled far enough, or a stop at calc(Infinity * 1px) (WPT
  // css-images/gradient/gradient-infinity-001). The line is cut to what
  // the fill covers, and its ends are the colours the whole line has there.
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:100px;height:20px;background:linear-gradient(' +
      'to right, #00ff00 100px, #ff0000 calc(Infinity * 1px))"></div>' +
      '<div style="position:relative;top:-40020px;height:50000px;' +
      'background:linear-gradient(#000000,#ffffff)"></div>',
  );
  const fills = gradientFills(await fillsOf(view(node)));
  assert.strictEqual(fills.length, 2);
  for (const fill of fills) {
    for (const v of fill.line) assert.ok(Math.abs(v) < 32768, `${fill.line}`);
  }
  const grey = (color: string) => parseInt(color.slice(1, 3), 16);
  const [far, tall] = fills;
  const [, top, , bottom] = tall.line;
  const [[first, from], [last, to]] = [
    tall.stops[0],
    tall.stops[tall.stops.length - 1],
  ];
  assert.deepStrictEqual([first, last], [0, 1]);
  const at = (y: number) => (255 * (y + 40000)) / 50000;
  assert.ok(Math.abs(grey(from) - at(top)) <= 1, `${from} at ${top}`);
  assert.ok(Math.abs(grey(to) - at(bottom)) <= 1, `${to} at ${bottom}`);
  assert.ok(bottom > top, 'down the box');
  // the far stop is past the whole box: all of it is the first colour
  assert.deepStrictEqual(
    [...new Set(far.stops.map(([, color]) => color))],
    ['#00ff00'],
  );
});

test('a gradient on the root repeats down a canvas taller than the page', async () => {
  // the root's background is sized by the root element and tiled over the
  // canvas: the stripes a browser shows under a short page
  const { node } = await render(
    '<style>body{margin:0;background:linear-gradient(#ff0000, #0000ff)}' +
      '</style><div style="height:100px"></div>',
  );
  const tiles = gradientFills(
    await fillsOf(view(node), undefined, {
      canvas: { x: 0, y: 0, width: 400, height: 250 },
    }),
  );
  assert.deepStrictEqual(
    tiles.map((t) => [t.y, t.h, t.line[1], t.line[3]]),
    [
      [0, 100, 0, 100],
      [100, 100, 100, 200],
      [200, 50, 200, 300],
    ],
  );
});

/** The radial gradients a paint filled with: the circles each was made
 *  from, its stops, and the matrix it was filled under, an ellipse's. */
function radialFills(fills: Fill[]) {
  return fills
    .filter((f) => (f.style as { circles?: number[] } | null)?.circles)
    .map((f) => {
      const g = f.style as { circles: number[]; stops: [number, string][] };
      const round = (v: number) => Math.round(v * 1000) / 1000 + 0;
      return {
        rect: [f.x, f.y, f.w, f.h],
        circles: g.circles.map(round),
        stops: g.stops.map(([at, color]) => [round(at), color]),
        matrix: f.matrix?.map(round) ?? null,
      };
    });
}

const radial = (gradient: string, more = ''): string =>
  '<style>body{margin:0}</style><div style="width:200px;height:100px;' +
  `background-image:radial-gradient(${gradient});${more}"></div>`;

test('a radial gradient is an ellipse through the farthest corner, from the middle of the box', async () => {
  // CSS Images 3, 3.2: with no shape, size or position, an ellipse centred
  // in the box through its corners, in the shape the box's sides give it.
  // It was drawn as nothing: the Zen Garden's 216 has its preamble on a
  // disc of one, white at the middle, and ours had no disc at all. A
  // context's radial gradients are circles, so an ellipse is one as wide as
  // the ellipse is narrow, filled under a matrix that stretches it
  const { node } = await render(radial('#ff0000, #0000ff'));
  const [g] = radialFills(await fillsOf(view(node)));
  assert.ok(g, 'a radial gradient is filled with');
  assert.deepStrictEqual(g.rect, [0, 0, 200, 100], 'across the box');
  assert.deepStrictEqual(
    g.circles,
    [0, 0, 0, 0, 0, 70.711],
    'a circle of the smaller radius, 50 by the root of two',
  );
  assert.deepStrictEqual(
    g.matrix,
    [2, 0, 0, 1, 100, 50],
    'stretched to the larger, about the middle of the box',
  );
  assert.deepStrictEqual(
    g.stops,
    [
      [0, parseColor('#ff0000')],
      [1, parseColor('#0000ff')],
    ],
    'its stops from the centre to the edge',
  );
});

test("a radial gradient's shape, size and centre are the ones it names", async () => {
  const shape = async (gradient: string) => {
    const { node } = await render(radial(`${gradient}, #ff0000, #0000ff`));
    const [g] = radialFills(await fillsOf(view(node)));
    cleanup();
    return g ? [g.circles, g.matrix] : null;
  };
  // a circle is filled where it is, under no matrix
  assert.deepStrictEqual(
    await shape('circle closest-side at 30px 40px'),
    [[30, 40, 0, 30, 40, 30], null],
    'a circle to the nearest side',
  );
  assert.deepStrictEqual(
    await shape('farthest-side circle at 50px 20px'),
    [[50, 20, 0, 50, 20, 150], null],
    'to the furthest, the keywords in either order',
  );
  assert.deepStrictEqual(
    await shape('circle at left top'),
    [[0, 0, 0, 0, 0, 223.607], null],
    'and, with no size, to the furthest corner',
  );
  assert.deepStrictEqual(
    await shape('25px at 100% 100%'),
    [[200, 100, 0, 200, 100, 25], null],
    'one length is a circle of that radius',
  );
  assert.deepStrictEqual(
    await shape('closest-side at 50px 20px'),
    [
      [0, 0, 0, 0, 0, 20],
      [2.5, 0, 0, 1, 50, 20],
    ],
    'an ellipse to the nearest sides, 50 across and 20 down',
  );
  assert.deepStrictEqual(
    await shape('ellipse closest-corner at 50px 20px'),
    [
      [0, 0, 0, 0, 0, 28.284],
      [2.5, 0, 0, 1, 50, 20],
    ],
    'through the nearest corner, in that shape',
  );
  assert.deepStrictEqual(
    await shape('25% 80px at center'),
    [
      [0, 0, 0, 0, 0, 50],
      [1, 0, 0, 1.6, 100, 50],
    ],
    'two sizes are its radii, a percentage of the box each way',
  );
  // what the grammar has no place for is no gradient
  for (const bad of [
    'circle 10px 20px',
    'ellipse 10px',
    'circle 50%',
    '10px -5px',
    'closest-side 10px',
    'circle circle',
    'at nowhere',
  ]) {
    assert.strictEqual(await shape(bad), null, `${bad} is drawn as nothing`);
  }
});

test("a radial gradient's stops run from its centre, along the ray to its edge and past it", async () => {
  const stops = async (gradient: string) => {
    const { node } = await render(radial(gradient));
    const fills = await fillsOf(view(node));
    const [g] = radialFills(fills);
    cleanup();
    return g ? { r: g.circles[5], stops: g.stops } : fills.map((f) => f.style);
  };
  const [black, white, red, blue] = [
    '#000000',
    '#ffffff',
    '#ff0000',
    '#0000ff',
  ].map((c) => parseColor(c)!);
  // a length is a distance along the ray, a percentage a share of it; a
  // stop past the edge makes the circle that much larger
  assert.deepStrictEqual(
    await stops('circle 40px, #ff0000 10px, #0000ff 150%'),
    {
      r: 60,
      stops: [
        [0.167, red],
        [1, blue],
      ],
    },
    'a stop past the edge carries the gradient on',
  );
  // the ray starts at the centre: a stop before it gives the colour there
  assert.deepStrictEqual(
    await stops('circle 100px, #000000 -100px, #ffffff 100px'),
    {
      r: 100,
      stops: [
        [0, blend(black, white, 0.5)],
        [1, white],
      ],
    },
    'a stop before the centre is the colour between, at it',
  );
  // a shape with no width or no height is its last colour, as Chrome
  // draws each
  for (const flat of [
    'circle 0px, #ff0000, #0000ff',
    '0px 50px, #ff0000, #0000ff',
    'closest-side at 0 50%, #ff0000, #0000ff',
  ]) {
    assert.deepStrictEqual(
      await stops(flat),
      [blue],
      `${flat} is its last colour`,
    );
  }
});

test('a radial gradient a context cannot carry is cut to what is seen of it', async () => {
  // a context's gradients are 16.16 fixed point, and a circle too large
  // for that is one only to where the box sees it: its stops past there
  // are never drawn, and the colour at the cut ends it
  const { node } = await render(
    radial('circle 100000px, #ff0000, #0000ff 100%'),
  );
  const [g] = radialFills(await fillsOf(view(node)));
  const [red, blue] = ['#ff0000', '#0000ff'].map((c) => parseColor(c)!);
  // the box's corners are 111.8px from its middle
  assert.deepStrictEqual(g.circles, [100, 50, 0, 100, 50, 111.803]);
  assert.deepStrictEqual(
    g.stops,
    [
      [0, red],
      [1, blend(red, blue, Math.hypot(100, 50) / 100000)],
    ],
    'the colour that far along its ray, at the edge',
  );
});

test('a radial gradient centred out of reach is drawn as the line it is where it is seen', async () => {
  // `at 0 calc(infinity * 1px)` is a centre at the largest length there
  // is, thirty million pixels down, which no context's matrix carries:
  // from there the rings are straight across the box, and the gradient is
  // the linear one that runs the way they spread. WPT's
  // css-images/gradient/gradient-infinity-003 has one whose first stop is
  // as far off as its centre, so all of its box is that stop's colour
  const { node } = await render(
    radial(
      'circle at 0 calc(infinity * 1px), #00ff00 calc(infinity * 1px), #ff0000 0',
    ),
  );
  const fills = await fillsOf(view(node));
  assert.strictEqual(radialFills(fills).length, 0, 'no circle is asked for');
  const [line] = gradientFills(fills);
  assert.ok(line, 'a linear gradient is');
  // all of it but the corner furthest from the centre, a sliver of a
  // pixel past the stop
  const lime = parseColor('#00ff00');
  const other = line.stops.find(([, color]) => color !== lime);
  assert.ok(
    line.stops[0][1] === lime && (!other || other[0] > 0.9999),
    `in the first stop's colour across it: ${JSON.stringify(line.stops)}`,
  );
  // up the box, away from a centre far below it
  const [x0, y0, x1, y1] = line.line;
  assert.ok(
    Math.abs(x1 - x0) < 1 && y0 <= 101 && y1 >= -1 && y1 < y0,
    `within the box, away from the centre: ${line.line}`,
  );
});

test('a radial gradient in a rounded box is the rounded shape, filled under its matrix', async () => {
  // the shape is laid down before the matrix is set, which a context
  // applies to a fill's paint and not to the path it already has: the
  // matrix first would have stretched the box with the gradient
  const { node } = await render(
    radial('#ff0000, #0000ff', 'border-radius:50%'),
  );
  const ops: PaintOp[] = [];
  const fills = await fillsOf(view(node), ops);
  const [g] = radialFills(fills);
  assert.deepStrictEqual(g.rect, [0, 0, 200, 100], "the box's own bounds");
  assert.deepStrictEqual(g.matrix, [2, 0, 0, 1, 100, 50]);
  const fill = fills.find((f) => f.matrix)!;
  assert.ok(
    fill.radii !== null || (fill.corners?.length ?? 0) > 0,
    'and its rounded corners',
  );
  // and the matrix is gone after it
  const at = ops.findIndex((op) => op.op === 'fill' && op.matrix);
  assert.strictEqual(ops[at + 1]?.op, 'restore', 'restored after the fill');
});

test('a context that paints a radial gradient flat is not asked for one', async () => {
  // react-x11's macOS and Windows contexts have `createRadialGradient` and
  // paint what it returns in one colour: a vignette would cover what it
  // darkens the edges of. Theirs takes no circles, and nothing is drawn
  const { node } = await render(
    radial('#ff0000, #0000ff', 'background-color:#00ff00'),
  );
  const fills = await fillsOf(view(node), undefined, { flatRadial: true });
  assert.ok(
    fills.every((f) => !(f.style as { flat?: boolean } | null)?.flat),
    'no fill is the flat gradient',
  );
  assert.ok(
    fills.some((f) => f.style === parseColor('#00ff00')),
    'and the colour under it is drawn',
  );
  // one that comes to a single colour needs no gradient, and is drawn
  cleanup();
  const { node: flat } = await render(radial('circle 0px, #ff0000, #0000ff'));
  assert.ok(
    (await fillsOf(view(flat), undefined, { flatRadial: true })).some(
      (f) => f.style === parseColor('#0000ff'),
    ),
    'a shape with no size is still its last colour',
  );
});

metric(
  'a radial gradient is drawn as an ellipse, not as a circle',
  async () => {
    // real pixels, where the matrix has to be one the context fills through:
    // a hard stop half way out an ellipse 100 across and 50 down is 50 from
    // the centre sideways and 25 down
    const { result, node } = await render(
      '<style>body{margin:0}</style><div style="width:200px;height:100px;' +
        'background:radial-gradient(closest-side, #ff0000 50%, #0000ff 50%)">' +
        '</div>',
    );
    const at = (node as unknown as { abs: { x: number; y: number } }).abs;
    await waitFor(async () => {
      for (const [x, y, red] of [
        [100, 50, true],
        [140, 50, true],
        [160, 50, false],
        [100, 70, true],
        [100, 80, false],
        [60, 50, true],
        [100, 20, false],
      ] as [number, number, boolean][]) {
        const [r, , b] = await pixelAt(result.ctx, at.x + x, at.y + y);
        assert.ok(
          red ? r > 200 && b < 60 : b > 200 && r < 60,
          `${red ? 'red' : 'blue'} at ${x},${y}: ${r},${b}`,
        );
      }
    });
  },
);

test('background-size is read, in its longhand and after the position', async () => {
  const { node } = await render(
    '<div id="a" style="background-size:cover"></div>' +
      '<div id="b" style="background-size:50% auto"></div>' +
      '<div id="c" style="background-size:20px 10px"></div>' +
      '<div id="d" style="background-size:auto"></div>' +
      '<div id="e" style="background:url(x.png) center / 100px no-repeat">' +
      '</div>' +
      '<div id="f" style="background-size:contain, 10px"></div>' +
      '<div id="g" style="background-size:cover 10px"></div>',
  );
  const el = view(node);
  const size = (id: string) =>
    (boxOf(el, id) as unknown as { style: { backgroundSize: unknown } }).style
      .backgroundSize;
  assert.strictEqual(size('a'), 'cover');
  assert.deepStrictEqual(size('b'), [{ pct: 50 }, 'auto']);
  assert.deepStrictEqual(size('c'), [20, 10]);
  assert.strictEqual(size('d'), 'auto');
  assert.deepStrictEqual(size('e'), [100, 'auto']);
  assert.strictEqual(size('f'), 'contain', 'the first layer');
  assert.strictEqual(size('g'), 'auto', 'no such size');
});

test('a background is drawn at the size background-size gives it', async () => {
  // it was read and never drawn: a hero's `cover` photograph was tiled at
  // its own size. A 20×10 image in boxes 100 square
  const { node } = await render(
    '<style>body{margin:0}div{width:100px;height:100px;' +
      'background:url(x.png) no-repeat}</style>' +
      '<div style="background-size:cover"></div>' +
      '<div style="background-size:contain"></div>' +
      '<div style="background-size:50% auto"></div>' +
      '<div style="background-size:20px 20px;background-repeat:repeat"></div>',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    backgroundImageFor: () => ({ image: {}, width: 20, height: 10, ratio: 2 }),
  });
  const images = ops.filter(
    (op): op is Extract<PaintOp, { op: 'image' }> => op.op === 'image',
  );
  const at = (top: number) =>
    images.filter((op) => op.y >= top && op.y < top + 100);
  // covering, it is as tall as the box and twice as wide
  assert.deepStrictEqual(
    at(0).map((op) => [op.w, op.h]),
    [[200, 100]],
  );
  // contained, as wide as the box
  assert.deepStrictEqual(
    at(100).map((op) => [op.w, op.h]),
    [[100, 50]],
  );
  // half the box's width, and as tall as its ratio makes it
  assert.deepStrictEqual(
    at(200).map((op) => [op.w, op.h]),
    [[50, 25]],
  );
  // twenty square, and tiled
  const tiles = at(300);
  assert.ok(tiles.length >= 25, `${tiles.length} tiles`);
  assert.ok(tiles.every((op) => op.w === 20 && op.h === 20));
});

/** `<Html>`'s paint options with no surface to keep a block of tiles on:
 *  the document drawn a tile at a time. */
function withoutTileBlocks(el: HtmlViewNode): void {
  const node = el as unknown as {
    _paintOptions(...a: unknown[]): Record<string, unknown>;
  };
  const options = node._paintOptions;
  node._paintOptions = function (this: unknown, ...a: unknown[]) {
    const out = options.apply(this, a);
    delete out.tilesKept;
    return out;
  };
}

metric(
  'a small image tiled at 2x is drawn from a block of its tiles, pixel for pixel as a tile at a time',
  async () => {
    // A tile is a drawImage of its own where the context has no pattern,
    // on macOS and on X11 at any scale but 1, so the 4 by 4 GIF Zen Garden
    // 008 lays across its boxes was thousands of calls a paint, 35 ms a
    // frame of a resize. A block of tiles kept on a surface stands in for
    // them, and has to draw what they drew: along both axes, along one, and
    // from a position that is no multiple of the tile
    const { result, el } = await renderWithBytes(
      '<style>body{margin:0}div{width:200px;height:60px}</style>' +
        '<div style="background:url(t.png)"></div>' +
        '<div style="background:url(s.png) repeat-x 0 7px"></div>' +
        '<div style="background:url(t.png) 5px 3px repeat-y"></div>' +
        '<div style="background:url(t.png) 1px 1px;border:3px solid;' +
        'border-radius:9px"></div>',
      {
        't.png': pixelsPng(3, 2, (x, y) => [x * 100, y * 200, 50]),
        's.png': pixelsPng(1, 5, (_, y) => [200, y * 50, 0]),
      },
      240,
      2,
    );
    const blocks = await snapshot(result, el);
    const kept = (
      el as unknown as { _tileBlocks: { kept: Map<string, unknown> } }
    )._tileBlocks;
    assert.ok(kept && kept.kept.size > 0, 'drawn from blocks');
    withoutTileBlocks(el);
    const tiles = await rebuilt(result, el);
    assert.strictEqual(bytesApart(blocks, tiles), 0);
  },
);

metric(
  'a tile of a pixel covers a box it takes more than 4096 of',
  async () => {
    // a tile at a time stops at 4096 and draws the image once, at its
    // place: a pixel square at the top left of a box it was to fill
    const { result, el } = await renderWithBytes(
      '<style>body{margin:0}div{width:200px;height:100px;' +
        'background:url(p.png)}</style><div></div>',
      { 'p.png': solidPng(1, 1, [0, 0, 255]) },
      240,
      2,
    );
    await act();
    const { abs } = el as unknown as DrawnNode;
    await expectPixel(result.ctx, abs.x + 390, abs.y + 190, '#0000ff', {
      message: 'the far corner of the box',
    });
  },
);

// `image-set()`: recognised as an image and never resolved, so a layer that
// named one drew nothing and asked for nothing (CSS Images 4, 2.4). Every
// answer below is Chrome's, Firefox's and WebKit's alike, at a device
// scale factor of 1 and of 2.

const SMALL = solidPng(20, 10, [255, 0, 0]);
const LARGE = solidPng(40, 20, [0, 0, 255]);

/** What a box's first background layer is: its url's image, or the kind
 *  of its gradient. */
function layerOf(el: HtmlViewNode, id: string): unknown {
  const style = (boxOf(el, id) as unknown as { style: ComputedStyle }).style;
  return style.backgroundGradient?.kind ?? style.backgroundImage;
}

test("an image-set() is the option the display's scale chooses, and that alone is asked for", async () => {
  const source =
    '<style>div{width:60px;height:30px}</style>' +
    `<div id="a" style="background-image:image-set('small.png' 1x, 'large.png' 2x)"></div>` +
    '<div id="b" style="background:#fff -webkit-image-set(url(small.png) 1x,' +
    ' url(large.png) 2x) no-repeat"></div>' +
    `<div id="c" style="border:10px solid;border-image:image-set('small.png' 1x, 'large.png' 2x) 10"></div>` +
    `<div id="d" style="mask-image:image-set('small.png' 1x, 'large.png' 2x)"></div>`;
  const images = { 'small.png': SMALL, 'large.png': LARGE };
  const at1 = await renderAsking(source, images);
  assert.deepStrictEqual(at1.asked, ['small.png']);
  assert.strictEqual(layerOf(at1.el, 'a'), 'small.png', 'a 1x is its url');
  assert.strictEqual(layerOf(at1.el, 'b'), 'small.png', 'in the shorthand');
  cleanup();
  const at2 = await renderAsking(source, images, 2);
  assert.deepStrictEqual(at2.asked, ['large.png']);
  const large = { url: 'large.png', density: 2 };
  assert.deepStrictEqual(layerOf(at2.el, 'a'), large, 'a 2x is its density');
  assert.deepStrictEqual(layerOf(at2.el, 'b'), large);
});

test('an image-set() takes the least dense option at or above the scale, else the densest, of those whose type decodes', async () => {
  const set = (id: string, value: string) =>
    `<div id="${id}" style="background-image:url(before.png);` +
    `background-image:${value}"></div>`;
  const source =
    set('a', `image-set('y.png' 0.5x, 'b.png' 1.5x)`) +
    // the units of a <resolution>, and options in any order
    set('b', `image-set('b.png' 2dppx, 'r.png' 96dpi)`) +
    set('c', `image-set('r.png' 1x, 'b.png' 75.6dpcm)`) +
    // a type this cannot decode is passed over, whatever its density
    set('d', `image-set('g.jxl' type('image/jxl') 2x, 'r.png' 1x)`) +
    set(
      'e',
      `image-set('b.png' type('IMAGE/PNG') 2x, 'r.png' type('image/png'))`,
    ) +
    // of two at one density, the first
    set('f', `image-set('b.png' 1x, 'r.png' 1x, 'g.png')`) +
    // a string between the quotes is the type as written, which no engine
    // has with a parameter, white space round it, or nothing in it: an
    // image-set() with no option left is an image that draws nothing, and
    // the declaration stands
    set('g', `image-set('b.png' type('image/png; q=1'))`) +
    set('h', `image-set('b.png' type(' image/png'), 'r.png' type(''))`) +
    // a gradient is an option as a url is
    set('i', `image-set(linear-gradient(#f00, #00f) 1x, 'b.png' 2x)`) +
    set('j', `image-set('b.png'2x)`) +
    // none of these is an image-set(), and the url before it stands
    set('k', 'image-set()') +
    set('l', `image-set('b.png' -1x)`) +
    set('m', `image-set('b.png' 1x 2x)`) +
    set('n', `image-set(image-set('b.png' 2x) 1x)`) +
    set('o', `image-set('b.png' type(image/png))`) +
    set('p', `image-set('b.png' x)`) +
    set('q', `image-set('b.png' 2x,)`) +
    set('r', `image-set(none 1x)`);
  const at = (density: number, url: string) =>
    density === 1 ? url : { url, density };
  const want: Record<string, [unknown, unknown]> = {
    a: [at(1.5, 'b.png'), at(1.5, 'b.png')],
    b: ['r.png', at(2, 'b.png')],
    // a hair over 2x
    c: ['r.png', at(75.6 * (2.54 / 96), 'b.png')],
    d: ['r.png', 'r.png'],
    e: ['r.png', at(2, 'b.png')],
    f: ['b.png', 'b.png'],
    g: [null, null],
    h: [null, null],
    i: ['linear', at(2, 'b.png')],
    j: [at(2, 'b.png'), at(2, 'b.png')],
  };
  for (const id of 'klmnopqr') want[id] = ['before.png', 'before.png'];
  for (const [i, scale] of [1, 2].entries()) {
    const { node } = await (scale === 1 ? render(source) : render2x(source));
    const el = view(node);
    for (const [id, layer] of Object.entries(want)) {
      assert.deepStrictEqual(layerOf(el, id), layer[i], `#${id} at ${scale}x`);
    }
    cleanup();
  }
});

test('an image-set() option is as large as its pixels over its density', async () => {
  // a 40 by 20 image: at 2x it is 20 CSS pixels across, whatever the
  // display's scale, and `background-size` reads that size
  const source =
    '<style>body{margin:0}div{width:100px;height:100px;' +
    `background:image-set('i.png' 2x) no-repeat}</style>` +
    '<div></div>' +
    '<div style="background-size:30px auto"></div>' +
    `<div style="background-image:image-set('i.png' 1.25x)"></div>`;
  const backgroundImageFor = () => ({
    image: {},
    width: 40,
    height: 20,
    ratio: 2,
  });
  const sizes = async (node: DrawnNode, scale: number) => {
    const ops: PaintOp[] = [];
    await fillsOf(view(node), ops, { scale, backgroundImageFor });
    return ops.flatMap((op) => (op.op === 'image' ? [[op.w, op.h]] : []));
  };
  assert.deepStrictEqual(await sizes((await render(source)).node, 1), [
    [20, 10],
    [30, 15],
    [32, 16],
  ]);
  cleanup();
  // device pixels: a 2x image at 2x is drawn a pixel a pixel
  assert.deepStrictEqual(await sizes((await render2x(source)).node, 2), [
    [40, 20],
    [60, 30],
    [64, 32],
  ]);
});

test('a border image an image-set() chose is sliced in its own pixels over its density', async () => {
  // `border-image-slice: 10` is ten of the image's CSS pixels, which at 2x
  // are twenty of its pixels, as Chrome, Firefox and WebKit slice it
  const { node } = await render(
    '<style>body{margin:0}div{width:40px;height:40px;' +
      'border:20px solid #000}</style>' +
      '<div style="border-image:url(i.png) 10"></div>' +
      `<div style="border-image:image-set('i.png' 2x) 10"></div>`,
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    backgroundImageFor: () => ({ image: {}, width: 40, height: 40, ratio: 1 }),
  });
  // each top left corner, the piece of the image it is
  const corners = ops.flatMap((op) =>
    op.op === 'image' && op.src?.[0] === 0 && op.src[1] === 0 ? [op.src] : [],
  );
  assert.deepStrictEqual(corners, [
    [0, 0, 10, 10],
    [0, 0, 20, 20],
  ]);
});

test('a gradient is tiled at the size background-size gives it', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px;height:40px;' +
      'background:linear-gradient(#ff0000,#0000ff);background-size:20px 20px">' +
      '</div>',
  );
  const fills = await fillsOf(view(node));
  const tiles = fills.filter(
    (f) => typeof f.style === 'object' && f.style !== null,
  );
  assert.strictEqual(tiles.length, 10, 'five across and two down');
  assert.ok(tiles.every((f) => f.w === 20 && f.h === 20));
});

test('a sized gradient in a rounded box is tiled and cut to its corners', async () => {
  // a rounded box's gradient was one fill of its shape, whatever its size
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px;height:40px;' +
      'border-radius:8px;background:linear-gradient(#ff0000,#0000ff);' +
      'background-size:20px 20px"></div>',
  );
  const ops: PaintOp[] = [];
  const fills = await fillsOf(view(node), ops);
  const tiles = fills.filter(
    (f) => typeof f.style === 'object' && f.style !== null,
  );
  assert.strictEqual(tiles.length, 10, 'five across and two down');
  assert.ok(tiles.every((f) => f.w === 20 && f.h === 20 && !f.radii));
  const clip = ops.findIndex((op) => op.op === 'clip');
  const first = ops.findIndex(
    (op) => op.op === 'fill' && typeof op.style === 'object',
  );
  assert.ok(clip >= 0 && clip < first, 'clipped before the first tile');
});

test('a gradient given only a width is as tall as its box', async () => {
  // it has no ratio to take a height from, and no height of its own
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px;height:40px;' +
      'background:linear-gradient(#ff0000,#0000ff);background-size:25px">' +
      '</div>',
  );
  const fills = await fillsOf(view(node));
  const tiles = fills.filter(
    (f) => typeof f.style === 'object' && f.style !== null,
  );
  assert.deepStrictEqual(
    tiles.map((f) => [f.w, f.h]),
    [
      [25, 40],
      [25, 40],
      [25, 40],
      [25, 40],
    ],
  );
});

test('background-clip: text and -webkit-text-fill-color are read', async () => {
  const { node } = await render(
    '<style>.clip{-webkit-background-clip:text}</style>' +
      '<div id="a" style="background-clip:text"></div>' +
      '<div id="b" class="clip"></div>' +
      '<div id="c" style="background-clip:text;background-clip:padding-box"></div>' +
      '<div id="d" class="clip" style="background:#ff0000"></div>' +
      '<div id="e" style="color:#00ff00;-webkit-text-fill-color:transparent">' +
      '<span id="f"></span></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { backgroundClipText: boolean; textFillColor: string | null };
      }
    ).style;
  assert.strictEqual(style('a').backgroundClipText, true);
  assert.strictEqual(style('b').backgroundClipText, true, 'prefixed');
  assert.strictEqual(style('c').backgroundClipText, false);
  assert.strictEqual(
    style('d').backgroundClipText,
    false,
    'the shorthand resets it',
  );
  assert.strictEqual(style('e').textFillColor, 'transparent');
  assert.strictEqual(style('f').textFillColor, 'transparent', 'inherited');
});

metric(
  'a background painted through its text fills the glyphs, and not its box',
  async () => {
    // `bg-clip-text text-transparent`: the box was painted with its gradient
    // and the text drawn in no ink over it, a bar where the headline was
    const { result } = await render(
      '<style>body{margin:0}h1{margin:0;font:48px/1 sans-serif;width:360px;' +
        'background:linear-gradient(90deg,#ff0000,#0000ff);' +
        '-webkit-background-clip:text;background-clip:text;color:transparent}' +
        '</style><h1>HHHHHHH</h1>',
    );
    const ink: [number, number, number][] = [];
    let white = 0;
    for (let x = 0; x < 360; x += 2) {
      const [r, g, b] = await pixelAt(result.ctx, x, 24);
      if (r > 240 && g > 240 && b > 240) white += 1;
      else if (g < 60) ink.push([x, r, b]);
    }
    assert.ok(ink.length > 20, `${ink.length} pixels of ink`);
    assert.ok(
      white > 20,
      'the box between and after the glyphs is not painted',
    );
    const [, r0, b0] = ink[0];
    const [, r1, b1] = ink[ink.length - 1];
    assert.ok(r0 > b0, `the first glyph is the gradient's start: ${r0}, ${b0}`);
    assert.ok(b1 > r1, `and the last towards its end: ${r1}, ${b1}`);
    // above the glyphs, inside the box
    assert.ok(isNear(await pixelAt(result.ctx, 180, 2), '#ffffff'));
  },
);

metric(
  'an elliptical gradient painted through text fills the glyphs where they are',
  async () => {
    // an ellipse is a circle filled under a matrix, which glyphs drawn
    // under it would be stretched by too: the text is filled with a
    // picture of the gradient instead
    const { result } = await render(
      '<style>body{margin:0}h1{margin:0;font:48px/1 sans-serif;width:360px;' +
        'background:radial-gradient(closest-side,#ff0000 50%,#0000ff 50%);' +
        'background-clip:text;color:transparent}</style><h1>HHHHHHH</h1>',
    );
    await waitFor(async () => {
      const ink: [number, number, number][] = [];
      for (let x = 0; x < 360; x += 2) {
        const [r, g, b] = await pixelAt(result.ctx, x, 24);
        if (g < 60 && (r > 200 || b > 200)) ink.push([x, r, b]);
      }
      assert.ok(ink.length > 20, `${ink.length} pixels of ink`);
      assert.ok(ink[0][0] < 12, `the first glyph where it is: ${ink[0][0]}`);
      // half way out the ellipse is 90 either side of the middle
      for (const [x, r, b] of ink) {
        if (Math.abs(x - 180) < 80) assert.ok(r > b, `red at ${x}: ${r},${b}`);
        if (Math.abs(x - 180) > 100)
          assert.ok(b > r, `blue at ${x}: ${r},${b}`);
      }
      assert.ok(
        ink.some(([x]) => Math.abs(x - 180) < 80) &&
          ink.some(([x]) => Math.abs(x - 180) > 100),
        'glyphs in both',
      );
    });
  },
);

metric(
  'text a span paints its background through keeps its neighbours ink',
  async () => {
    const { result } = await render(
      '<style>body{margin:0}p{margin:0;font:48px/1 sans-serif}' +
        'span{background:linear-gradient(#00ff00,#00ff00);' +
        '-webkit-background-clip:text;-webkit-text-fill-color:transparent}' +
        '</style><p style="color:#0000ff">HHH<span>HHH</span></p>',
    );
    let blue = 0;
    let green = 0;
    for (let x = 0; x < 240; x += 1) {
      const [r, g, b] = await pixelAt(result.ctx, x, 24);
      if (b > 200 && g < 80 && r < 80) blue += 1;
      if (g > 200 && b < 80 && r < 80) green += 1;
    }
    assert.ok(blue > 10, `${blue} blue`);
    assert.ok(
      green > 10,
      `${green} green: the span's glyphs, in its background`,
    );
  },
);

metric(
  "a background painted through text shows through its descendants' text",
  async () => {
    // CSS Backgrounds 4: the text of the box and of its descendants in flow
    // and floating, a block, an inline-block or a flex item's among them:
    // `bg-clip-text` on a `<div>` round a heading showed nothing through
    // it. An absolutely positioned descendant's text is its own.
    const { node, result } = await render(
      '<style>body{margin:0}.c{background:#00ff00;background-clip:text;' +
        'color:transparent;font:48px/1 sans-serif}p{margin:0}' +
        'i{position:absolute;left:300px;top:0;font-style:normal;' +
        'color:#0000ff}</style>' +
        '<div class="c"><p id="b">HH</p>' +
        '<span style="display:inline-block">HH</span>' +
        '<div style="display:flex"><span>HH</span></div><i>HH</i></div>',
    );
    const green = async (y: number) => {
      let n = 0;
      for (let x = 0; x < 120; x += 1) {
        const [r, g, b] = await pixelAt(result.ctx, x, y);
        if (g > 200 && r < 80 && b < 80) n += 1;
      }
      return n;
    };
    const top = boxOf(view(node), 'b').y;
    for (const [i, what] of [
      'a block',
      'an inline-block',
      'a flex item',
    ].entries()) {
      assert.ok((await green(top + 48 * i + 24)) > 10, what);
    }
    // the absolute box's own ink, not the background
    let blue = 0;
    for (let x = 300; x < 400; x += 1) {
      const [, g, b] = await pixelAt(result.ctx, x, top + 24);
      if (b > 200 && g < 80) blue += 1;
    }
    assert.ok(blue > 10, `${blue} blue in the absolute box`);
  },
);

test('background layers are read, top first, from the shorthand and the longhands', async () => {
  const { node } = await render(
    '<style>.d{background-image:url(a.png),url(b.png)}' +
      '.d{background-image:url(c.png)}</style>' +
      '<div id="r" style="background:#eeeeee"></div>' +
      '<div id="a" style="background:linear-gradient(#000000,#ffffff),' +
      'url(a.png) center / cover no-repeat #eeeeee"></div>' +
      '<div id="b" style="background-image:url(a.png),url(b.png);' +
      'background-position:left top,right bottom;' +
      'background-repeat:no-repeat"></div>' +
      '<div id="c" style="background:#eeeeee;' +
      'background:#ff0000,url(a.png)"></div>' +
      '<div id="d" class="d"></div>',
  );
  const el = view(node);
  type Layered = {
    backgroundColor: string | null;
    backgroundImage: string | null;
    backgroundGradient: object | null;
    backgroundSize: unknown;
    backgroundRepeat: readonly string[];
    backgroundPositionX: unknown;
    backgroundImages: unknown[] | null;
    backgroundRepeats: (readonly string[])[] | null;
    backgroundSizes: unknown[] | null;
    backgroundPositions: unknown[] | null;
  };
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: Layered }).style;
  const a = style('a');
  assert.strictEqual(a.backgroundImages?.length, 2);
  assert.strictEqual(a.backgroundGradient, a.backgroundImages![0]);
  assert.strictEqual(a.backgroundImage, null, 'the first layer is the top');
  assert.strictEqual(a.backgroundImages![1], 'a.png');
  assert.deepStrictEqual(a.backgroundSizes, ['auto', 'cover']);
  assert.deepStrictEqual(a.backgroundRepeats, [
    ['repeat', 'repeat'],
    ['no-repeat', 'no-repeat'],
  ]);
  assert.deepStrictEqual(a.backgroundPositions, [
    [0, 0],
    [{ pct: 50 }, { pct: 50 }],
  ]);
  assert.strictEqual(
    a.backgroundColor,
    style('r').backgroundColor,
    'the last layer carries the colour',
  );
  const b = style('b');
  assert.deepStrictEqual(b.backgroundImages, ['a.png', 'b.png']);
  assert.deepStrictEqual(b.backgroundPositions, [
    [0, 0],
    [{ pct: 100 }, { pct: 100 }],
  ]);
  assert.strictEqual(b.backgroundRepeats, null, 'one value, for every layer');
  assert.deepStrictEqual(b.backgroundRepeat, ['no-repeat', 'no-repeat']);
  const c = style('c');
  assert.strictEqual(
    c.backgroundColor,
    style('r').backgroundColor,
    'a colour before the last layer makes the declaration invalid',
  );
  assert.strictEqual(c.backgroundImages, null);
  const d = style('d');
  assert.strictEqual(d.backgroundImages, null, 'one image is one layer');
  assert.strictEqual(d.backgroundImage, 'c.png');
});

test('background layers are painted bottom first, over the colour', async () => {
  // only the last layer of a shorthand was kept, and only the first of
  // `background-image`: a gradient over a photograph drew one of them
  const { node } = await render(
    '<style>body{margin:0}div{width:100px;height:100px}</style>' +
      '<div style="background:url(top.png) no-repeat,' +
      'url(bottom.png) no-repeat 50px 50px,#eeeeee"></div>' +
      '<div style="background:linear-gradient(rgba(0,0,0,.5),' +
      'rgba(0,0,0,.5)),url(photo.png) center / cover"></div>',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    backgroundImageFor: (url) =>
      url === 'top.png'
        ? { image: {}, width: 10, height: 10, ratio: 1 }
        : url === 'bottom.png'
          ? { image: {}, width: 20, height: 20, ratio: 1 }
          : { image: {}, width: 20, height: 10, ratio: 2 },
  });
  const drawn = ops.flatMap((op): object[] =>
    op.op === 'image'
      ? [{ at: [op.x, op.y], size: [op.w, op.h] }]
      : op.op === 'fill' && op.y < 200
        ? [{ fill: typeof op.style === 'object' ? 'gradient' : 'colour' }]
        : [],
  );
  assert.deepStrictEqual(drawn, [
    { fill: 'colour' },
    { at: [50, 50], size: [20, 20] },
    { at: [0, 0], size: [10, 10] },
    // covering a square, centred
    { at: [-50, 100], size: [200, 100] },
    { fill: 'gradient' },
  ]);
});

test('a property with fewer values than the images takes them over again', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px;height:100px;' +
      'background-image:url(a.png),url(b.png),url(c.png);' +
      'background-size:10px 10px,20px 20px;background-repeat:no-repeat">' +
      '</div>',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    backgroundImageFor: () => ({ image: {}, width: 5, height: 5, ratio: 1 }),
  });
  // c, b and a, bottom up: the first size, the second, and the first again
  assert.deepStrictEqual(
    ops.flatMap((op) => (op.op === 'image' ? [op.w] : [])),
    [10, 20, 10],
  );
});

test("the root's background layers cover the canvas", async () => {
  const { node } = await render(
    '<html style="background:url(a.png) no-repeat,' +
      'url(b.png) no-repeat 30px 30px"><body></body></html>',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    backgroundImageFor: (url) =>
      url === 'a.png'
        ? { image: {}, width: 10, height: 10, ratio: 1 }
        : { image: {}, width: 20, height: 20, ratio: 1 },
  });
  assert.deepStrictEqual(
    ops.flatMap((op) => (op.op === 'image' ? [[op.x, op.y, op.w]] : [])),
    [
      [30, 30, 20],
      [0, 0, 10],
    ],
  );
});

metric('a layer is drawn over the one under it', async () => {
  const ctx = await renderWithImages(
    '<style>body{margin:0}div{width:60px;height:30px;' +
      'background:linear-gradient(#0000ff,#0000ff) no-repeat 20px 10px / ' +
      '5px 5px,url(red.png) no-repeat 20px 10px,#00ff00}</style><div></div>',
  );
  await expectPixel(ctx, 22, 12, '#0000ff', {
    message: 'the top layer, over the image',
  });
  await expectPixel(ctx, 27, 17, '#ff0000', { message: 'the image' });
  await expectPixel(ctx, 5, 5, '#00ff00', { message: 'the colour' });
});

test("an image is trimmed to its box's corners", async () => {
  // an avatar is a round photograph: a replaced image is clipped to the
  // curve of its content edge, and a background to its box's
  const { node } = await render(
    '<style>body{margin:0}</style><img src="a.png" style="display:block;' +
      'width:40px;height:40px;border-radius:50%;border:2px solid #000">' +
      '<div style="width:60px;height:30px;border-radius:50%;' +
      'background-image:url(b.png)"></div><img src="c.png" ' +
      'style="display:block;width:40px;height:40px">',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    imageFor: () => ({}),
    backgroundImageFor: () => ({ image: {}, width: 60, height: 30, ratio: 2 }),
  });
  // each image, and the clip in force where it is drawn
  const drawn = (x: number, y: number) => {
    const i = ops.findIndex(
      (op) => op.op === 'image' && op.x === x && op.y === y,
    );
    assert.ok(i >= 0, `an image drawn at ${x},${y}`);
    let depth = 0;
    for (let j = i - 1; j >= 0; j -= 1) {
      const op = ops[j];
      if (op.op === 'restore') depth += 1;
      else if (op.op === 'save') depth = Math.max(0, depth - 1);
      else if (op.op === 'clip' && depth === 0) return op;
    }
    return null;
  };
  // inside a 2px border: a circle 40px across, its radius 22px less 2px
  const avatar = drawn(2, 2)!;
  assert.deepStrictEqual(
    [avatar.x, avatar.y, avatar.w, avatar.h, avatar.radii],
    [2, 2, 40, 40, [20, 20, 20, 20]],
  );
  // the background's box is 60 by 30: an ellipse, clipped in curves
  const background = drawn(0, 44)!;
  assert.deepStrictEqual(
    [background.x, background.y, background.w, background.h, background.radii],
    [0, 44, 60, 30, null],
  );
  // and a square image is drawn with no clip of its own
  assert.strictEqual(drawn(0, 74), null);
});

test('background-clip and background-origin name the boxes a layer takes', async () => {
  // only `text` was read: a background was painted over the border box
  // and placed at the padding box's corner whatever they said (CSS
  // Backgrounds 3, 3.7 and 3.8)
  const frame =
    'width:100px;height:50px;padding:10px;border:5px solid transparent;';
  const fills = await fillsIn(
    `<div style="${frame}background:#fe0000 content-box"></div>` +
      `<div style="${frame}background:#fe0000;background-clip:padding-box;` +
      'border-radius:20px"></div>' +
      // two boxes: the origin, and then the clip
      `<div style="${frame}background:#fe0000 padding-box content-box"></div>`,
    '#fe0000',
  );
  assert.deepStrictEqual(
    fills.map((f) => [f.x, f.y, f.w, f.h, f.radii]),
    [
      [15, 15, 100, 50, null],
      [5, 85, 120, 70, [15, 15, 15, 15]],
      [15, 175, 100, 50, null],
    ],
  );
  const { node } = await render(
    '<style>body{margin:0}div{background:linear-gradient(#0000fe,#0000fe) ' +
      `no-repeat;background-size:10px 10px;${frame}}</style>` +
      '<div style="background-origin:content-box"></div>' +
      '<div style="background-origin:border-box"></div>' +
      '<div></div>',
  );
  assert.deepStrictEqual(
    gradientFills(await fillsOf(view(node))).map((t) => [t.x, t.y]),
    [
      [15, 15],
      [0, 80],
      [5, 165],
    ],
  );
});

test('background-clip reads border-area, alone and with text', async () => {
  // CSS Backgrounds 4, 2.1: a layer painted in what its border paints; and
  // in the shorthand a clip of its own, where a box is the origin
  const { node } = await render(
    '<div id="a" style="background-clip:border-area"></div>' +
      '<div id="b" style="background-clip:text border-area"></div>' +
      '<div id="c" style="background-clip:border-area, padding-box"></div>' +
      '<div id="d" style="background:url(x.png) border-area content-box"></div>' +
      '<div id="e" style="background:url(x.png) content-box border-area"></div>' +
      // three boxes is one too many
      '<div id="f" style="background:url(x.png) padding-box content-box ' +
      'border-area"></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: Pick<
          ComputedStyle,
          | 'backgroundClip'
          | 'backgroundClips'
          | 'backgroundClipText'
          | 'backgroundOrigin'
          | 'backgroundImage'
        >;
      }
    ).style;
  assert.deepStrictEqual(
    [style('a').backgroundClip, style('a').backgroundClipText],
    ['border-area', false],
  );
  assert.deepStrictEqual(
    [style('b').backgroundClip, style('b').backgroundClipText],
    ['border-area', true],
    'the text as well',
  );
  assert.deepStrictEqual(style('c').backgroundClips, [
    'border-area',
    'padding-box',
  ]);
  for (const id of ['d', 'e']) {
    assert.deepStrictEqual(
      [style(id).backgroundOrigin, style(id).backgroundClip],
      ['content-box', 'border-area'],
      id,
    );
  }
  assert.strictEqual(style('f').backgroundImage, null, 'dropped');
});

metric(
  'background-clip: border-area paints where the border would, whatever its colour',
  async () => {
    // A transparent border still has its width and style, and a layer so
    // clipped is painted in them: a solid border's band, a double border's
    // two lines, a rounded border's ring. The value was not read, and the
    // background filled the box under the border.
    const { result } = await renderWithBytes(
      '<style>body{margin:0}div{width:60px;height:30px;margin-bottom:10px;' +
        'border:21px solid transparent;' +
        'background:linear-gradient(#0000ff,#0000ff);' +
        'background-clip:border-area}</style>' +
        '<div></div>' +
        '<div style="border-style:double"></div>' +
        '<div style="border-radius:50%"></div>' +
        // and in the border where the text has nothing to show it through
        '<div style="background-clip:text border-area"></div>',
      {},
    );
    const ctx = result.ctx;
    // each 102 by 72, 82 apart
    await expectPixel(ctx, 10, 10, '#0000ff', { message: 'in the border' });
    await expectPixel(ctx, 92, 36, '#0000ff', { message: 'its right side' });
    await expectPixel(ctx, 51, 36, '#ffffff', { message: 'inside it' });
    await expectPixel(ctx, 51, 85, '#0000ff', { message: 'the outer line' });
    await expectPixel(ctx, 51, 92, '#ffffff', { message: 'between the two' });
    await expectPixel(ctx, 51, 99, '#0000ff', { message: 'the inner line' });
    // and joined at the corners as the border's lines are painted: the
    // outer lines a frame, and the inner ones a frame inside it
    await expectPixel(ctx, 3, 92, '#0000ff', {
      message: 'the outer frame round the corner',
    });
    await expectPixel(ctx, 10, 99, '#ffffff', {
      message: "the top's inner line stopped at the left's",
    });
    await expectPixel(ctx, 2, 166, '#ffffff', { message: 'past the curve' });
    await expectPixel(ctx, 51, 170, '#0000ff', { message: 'in the ring' });
    await expectPixel(ctx, 51, 200, '#ffffff', { message: 'inside the ring' });
    await expectPixel(ctx, 10, 256, '#0000ff', {
      message: 'with the text, in the border too',
    });
    await expectPixel(ctx, 51, 282, '#ffffff', {
      message: 'and nowhere else',
    });
  },
);

test('a border-area clip is the border wherever the paint is cut', async () => {
  // A paint that reaches part of a box is cut to 64 pixels round what it
  // repaints, and the clip was built from that cut as though it were the
  // box. A 3D border's bands were placed a border's width in from each cut
  // edge, so 500px sides on a cut 148 across ran backwards, wound the other
  // way and cancelled the rest: a strip repainted across the border's
  // inner edge had no background in the border at all. A rounded border's
  // ring was the cut and the cut inset by the borders, which leaves no
  // hole once the border is wider than the margin: the background was
  // painted over the content, and a corner the cut went through was a
  // curve 300 across on a rectangle 148 across.
  const solid = 'border:500px solid #888888';
  // the border area of a box 2000 across, less the content's 1000
  const border = (x: number, y: number) =>
    !(x > 500 && x < 1500 && y > 500 && y < 1500);
  const inContent = { x: 1000, y: 1000, width: 20, height: 20 };
  const acrossEdge = { x: 490, y: 990, width: 20, height: 20 };
  const cases = [
    ['a 3D border', 'border:500px inset #888888', inContent, border],
    ['a 3D border', 'border:500px inset #888888', acrossEdge, border],
    ['a rounded one', `${solid};border-radius:20px`, inContent, border],
    ['a rounded one', `${solid};border-radius:20px`, acrossEdge, border],
    [
      'a rounded one, across its curve',
      `${solid};border-radius:300px`,
      { x: 80, y: 80, width: 20, height: 20 },
      (x: number, y: number) => Math.hypot(x - 300, y - 300) < 300,
    ],
  ] as const;
  for (const [name, style, damage, inside] of cases) {
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        `<div style="width:1000px;height:1000px;${style};` +
        'background:#ff0000;background-clip:border-area"></div>',
    );
    const { clips } = await pathsOf(view(node), damage);
    const at = `${name}, repainted at ${damage.x},${damage.y}`;
    assert.ok(clips.length <= 1, `one clip, or none: ${at}`);
    const wrong: string[] = [];
    for (let y = damage.y; y < damage.y + damage.height; y += 1) {
      for (let x = damage.x; x < damage.x + damage.width; x += 1) {
        const [px, py] = [x + 0.5, y + 0.5];
        // clear of the curve, which the recorder bends in straight lines
        if (Math.abs(Math.hypot(px - 300, py - 300) - 300) < 1) continue;
        const clipped = clips.length === 1 && windingAt(clips[0], px, py) !== 0;
        if (clipped !== inside(px, py)) wrong.push(`${x},${y}`);
      }
    }
    assert.deepStrictEqual(
      wrong.slice(0, 4),
      [],
      `the border area and nothing else, ${at}: ${wrong.length} wrong`,
    );
  }
});

test("a border-area clip is a dashed or dotted side's pattern wherever the paint is cut", async () => {
  // The clip is made of the rectangles the border's dashes and dots are
  // painted as, and those were measured from the side cut to 64 pixels
  // round what is repainted: a 500px side in a strip 20 across had dashes
  // 296 long every 444, where they are 1000 long every 1500, so the
  // background showed in the gaps of a pattern the border did not have
  const cases = [
    [
      'a dashed left side',
      'border-left:500px dashed #888888',
      { x: 240, y: 700, width: 20, height: 1000 },
      (x: number, y: number) => x < 500 && y % 1500 < 1000,
    ],
    [
      'a dotted top',
      'border-top:500px dotted #888888',
      { x: 300, y: 240, width: 1000, height: 20 },
      (x: number, y: number) => y < 500 && x % 1000 < 500,
    ],
  ] as const;
  for (const [name, style, damage, inside] of cases) {
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        `<div style="width:3000px;height:3000px;${style};` +
        'background:#ff0000;background-clip:border-area"></div>',
    );
    const { clips } = await pathsOf(view(node), damage);
    assert.ok(clips.length <= 1, `one clip, or none: ${name}`);
    const wrong: string[] = [];
    for (let y = damage.y; y < damage.y + damage.height; y += 1) {
      for (let x = damage.x; x < damage.x + damage.width; x += 1) {
        const [px, py] = [x + 0.5, y + 0.5];
        const clipped = clips.length === 1 && windingAt(clips[0], px, py) !== 0;
        if (clipped !== inside(px, py)) wrong.push(`${x},${y}`);
      }
    }
    assert.deepStrictEqual(
      wrong.slice(0, 4),
      [],
      `the side's own pattern, ${name}: ${wrong.length} wrong`,
    );
  }
});

test('a rounded background cut to what the paint reaches keeps its shape', async () => {
  // A paint that reaches part of a box cuts its background to 64 pixels
  // round what it repaints, and the cut was filled with the box's own
  // corners: a corner left at a cut edge curves no further into it than
  // its radius, which leaves what is painted alone while the radius is no
  // more than 64. A circle's is more. A strip repainted across the curve of
  // one 400 across was filled as a rectangle 148 across with corners of
  // 200, a path that crosses itself, and an image in the box was clipped
  // to it: the strip was filled outside the circle and left bare inside.
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:380px;height:380px;border:10px solid #0000ff;' +
      'background:#ffcc00 url(a.png);border-radius:50%"></div>',
  );
  const ink = parseColor('#ffcc00');
  const circle = (x: number, y: number) => Math.hypot(x - 200, y - 200) < 200;
  // across the curve, by its top, its left and two of its corners
  const strips = [
    { x: 150, y: 0, width: 20, height: 20 },
    { x: 0, y: 150, width: 20, height: 20 },
    { x: 330, y: 40, width: 20, height: 20 },
    { x: 50, y: 50, width: 20, height: 20 },
  ];
  for (const damage of strips) {
    const { fills, clips } = await pathsOf(view(node), damage, () => ({
      image: {},
      width: 400,
      height: 400,
      ratio: 1,
    }));
    const at = `repainted at ${damage.x},${damage.y}`;
    const colour = fills.filter((f) => f.style === ink);
    assert.strictEqual(colour.length, 1, `one fill of the colour, ${at}`);
    assert.strictEqual(clips.length, 1, `one clip, the image's, ${at}`);
    const wrong: string[] = [];
    for (let y = damage.y; y < damage.y + damage.height; y += 1) {
      for (let x = damage.x; x < damage.x + damage.width; x += 1) {
        const [px, py] = [x + 0.5, y + 0.5];
        // clear of the curve, which the recorder bends in straight lines
        if (Math.abs(Math.hypot(px - 200, py - 200) - 200) < 1) continue;
        const inside = circle(px, py);
        if ((windingAt(colour[0].outlines, px, py) !== 0) !== inside) {
          wrong.push(`colour ${x},${y}`);
        }
        if ((windingAt(clips[0], px, py) !== 0) !== inside) {
          wrong.push(`image ${x},${y}`);
        }
      }
    }
    assert.deepStrictEqual(
      wrong.slice(0, 4),
      [],
      `the circle and nothing else, ${at}: ${wrong.length} wrong`,
    );
  }
});

metric(
  'an inline box whose background is an image or a gradient alone is painted',
  async () => {
    // A span was painted where it had a background colour, a border or an
    // outline, so an image with no colour under it was asked for and never
    // drawn, and a gradient alone — a highlighter's — was not drawn either
    const { result } = await renderWithBytes(
      '<style>body{margin:0}p{margin:0;font:20px/40px sans-serif;' +
        'color:transparent}span{background:url(b.svg)}</style>' +
        '<p><span>xxxxxxxx</span></p>' +
        '<p><span style="border:6px solid transparent;' +
        'background-clip:border-area">xxxxxxxx</span></p>' +
        '<p><span style="background:linear-gradient(#00ff00,#00ff00)">' +
        'xxxxxxxx</span></p>',
      {
        'b.svg': svgBytes(
          `<svg ${SVG_NS} width="10" height="10">` +
            '<rect width="10" height="10" fill="#0000ff"/></svg>',
        ),
      },
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 30, 20, '#0000ff', { message: 'the image' });
    await expectPixel(ctx, 3, 60, '#0000ff', { message: 'in its border' });
    await expectPixel(ctx, 30, 60, '#ffffff', { message: 'and not inside it' });
    await expectPixel(ctx, 30, 100, '#00ff00', { message: 'the gradient' });
  },
);

test("background-repeat's space and round fit whole tiles", async () => {
  // Both were read as `repeat` (CSS Backgrounds 3, 3.4): `space` sets as
  // many whole tiles as fit, the first and last against the edges and the
  // rest spread between, or one where two do not fit; `round` sizes the
  // tile so that a whole number of them fit
  const { node } = await render(
    '<style>body{margin:0}div{width:96px;height:30px;' +
      'background:linear-gradient(#0000fe,#0000fe);background-size:30px 30px}' +
      '</style>' +
      '<div style="background-repeat:space no-repeat"></div>' +
      '<div style="background-repeat:round no-repeat"></div>' +
      '<div style="background-repeat:space no-repeat;background-size:60px 30px;' +
      'background-position:right"></div>',
  );
  assert.deepStrictEqual(
    gradientFills(await fillsOf(view(node))).map((t) => [t.x, t.y, t.w]),
    [
      [0, 0, 30],
      [33, 0, 30],
      [66, 0, 30],
      [0, 30, 32],
      [32, 30, 32],
      [64, 30, 32],
      [36, 60, 60],
    ],
  );
});

/** The images a paint drew that show through the clips around them. */
function shownImages(ops: PaintOp[]) {
  type Area = { x: number; y: number; w: number; h: number };
  const meet = (a: Area, b: Area): Area => {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    return {
      x,
      y,
      w: Math.min(a.x + a.w, b.x + b.w) - x,
      h: Math.min(a.y + a.h, b.y + b.h) - y,
    };
  };
  let clip: Area | null = null;
  const saved: (Area | null)[] = [];
  const shown: Area[] = [];
  for (const op of ops) {
    if (op.op === 'save') saved.push(clip);
    else if (op.op === 'restore') clip = saved.pop() ?? null;
    else if (op.op === 'clip') clip = clip ? meet(clip, op) : op;
    else if (op.op === 'image') {
      const seen = clip ? meet(clip, op) : op;
      if (seen.w > 0 && seen.h > 0) {
        shown.push({ x: op.x, y: op.y, w: op.w, h: op.h });
      }
    }
  }
  return shown;
}

metric(
  "a wrapped inline box's image is placed in its fragments laid end to end",
  async () => {
    // CSS Fragmentation 3, 5.4: `box-decoration-break: slice`, CSS's
    // default, places a box's background as though its fragments were one
    // box end to end, of which each shows its slice. An arrow `no-repeat`
    // in a link's left padding was placed in each fragment's own padding
    // box, and so drawn again over the text at the start of every line the
    // link wrapped onto
    const { node } = await render(
      '<style>body{margin:0;font:16px/30px sans-serif}p{margin:0;' +
        'width:160px}a{padding-left:20px;background:#ffff00 url(i.png) ' +
        '0 3px no-repeat}</style><p>Read <a href="#">the guide for the ' +
        'whole design team</a> first.</p>',
    );
    const ops: PaintOp[] = [];
    await fillsOf(view(node), ops, {
      backgroundImageFor: () => ({
        image: {},
        width: 10,
        height: 10,
        ratio: 1,
      }),
    });
    const yellow = parseColor('#ffff00');
    const fragments = ops.flatMap((op) =>
      op.op === 'fill' && op.style === yellow ? [op] : [],
    );
    assert.ok(fragments.length >= 2, 'the link wraps');
    assert.deepStrictEqual(
      shownImages(ops).map((r) => [r.x, r.y]),
      [[fragments[0].x, fragments[0].y + 3]],
      'on the first fragment alone',
    );
  },
);

metric(
  "a wrapped inline box's gradient runs across its fragments, and `clone` starts it on each",
  async () => {
    // Sliced, a gradient spans the strip a box's fragments make laid end
    // to end in its direction, the first line's fragment at its start —
    // the left, or the right where the box is right to left — and each
    // line's carries on where the line before's stopped; it started again
    // on each. `box-decoration-break: clone` places it in each fragment's
    // own box, as it was
    const { node } = await render(
      '<style>body{margin:0;font:16px/30px sans-serif}p{margin:0;' +
        'width:160px;height:150px}span{background:linear-gradient(' +
        'to right,#ff0000,#0000ff)}#c{box-decoration-break:clone}</style>' +
        '<p>A <span>gradient across every line this wraps onto</span></p>' +
        '<p dir="rtl">A <span>gradient across every line this wraps onto' +
        '</span></p><p>A <span id="c">gradient across every line this ' +
        'wraps onto</span></p><p><i id="w" style="-webkit-box-decoration-' +
        'break:clone">prefixed</i></p>',
    );
    const el = view(node);
    const fills = gradientFills(await fillsOf(el));
    // each paragraph's fragments, a line at a time, and each one's slice
    // of its gradient's line: from how far along it its left edge is to
    // how far its right edge is, in pixels
    const slices = (p: number) =>
      fills
        .filter((f) => f.y >= p * 150 && f.y < (p + 1) * 150)
        .sort((a, b) => a.y - b.y)
        .map((f) => ({
          from: f.x - f.line[0],
          to: f.x + f.w - f.line[0],
          length: f.line[2] - f.line[0],
        }));
    const near = (a: number, b: number, message: string) =>
      assert.ok(Math.abs(a - b) <= 1, `${message}: ${a} against ${b}`);
    const ltr = slices(0);
    assert.ok(ltr.length >= 2, 'the span wraps');
    near(ltr[0].from, 0, 'the first line starts it');
    for (let i = 1; i < ltr.length; i += 1) {
      near(ltr[i].from, ltr[i - 1].to, `line ${i + 1} carries it on`);
    }
    near(ltr.at(-1)!.to, ltr.at(-1)!.length, 'and the last ends it');

    const rtl = slices(1);
    assert.ok(rtl.length >= 2, 'the right-to-left span wraps');
    near(rtl[0].to, rtl[0].length, 'its first line is at the right end');
    for (let i = 1; i < rtl.length; i += 1) {
      near(rtl[i].to, rtl[i - 1].from, `line ${i + 1} carries it on leftward`);
    }
    near(rtl.at(-1)!.from, 0, 'and its last is at the left');

    const cloned = slices(2);
    assert.ok(cloned.length >= 2, 'the cloned span wraps');
    for (const [i, slice] of cloned.entries()) {
      near(slice.from, 0, `line ${i + 1} starts it again`);
      near(slice.to, slice.length, `and line ${i + 1} ends it`);
    }
    assert.strictEqual(
      (boxOf(el, 'w') as unknown as { style: ComputedStyle }).style
        .boxDecorationBreak,
      'clone',
      'under its prefixed name too',
    );
  },
);

metric(
  'an image that arrives to be painted only is painted, the boxes kept; one an image is sized by builds them again',
  async () => {
    // A page's backgrounds arrive one at a time over a network, after the
    // build that asked for them. None of them is a box's size, and each was a
    // build and a layout of the whole document; an <img> without a size is
    // one, and still is.
    const BLUE = solidPng(30, 16, [0, 0, 255]);
    const waiting = new Map<string, () => void>();
    const { result } = await (async () => {
      const result = await renderX11(
        h(
          'box',
          { style: { width: 300, flexDirection: 'column' } },
          h(Html, {
            source:
              '<style>body{margin:0}#bg{width:40px;height:20px;' +
              'background:url(bg.png)}#bd{width:40px;height:20px;' +
              'border:4px solid;border-image:url(bg.png) 4}' +
              'img{display:block}</style>' +
              '<div id="bg"></div><div id="bd"></div><img id="im" src="im.png">',
            partial: false,
            'data-testname': 'doc',
            onResource: (r: ResourceRequest) => {
              if (r.kind !== 'image') return null;
              const bytes = r.url === 'im.png' ? BLUE : RED_PNG;
              return new Promise<ResourceResult>((answer) =>
                waiting.set(r.url, () => answer({ kind: 'image', bytes })),
              );
            },
          }),
        ),
        { width: 340, height: 200, fonts: FONTS! },
      );
      await act();
      return { result };
    })();
    const el = view(screen.getByTestName('doc') as DrawnNode);
    await waitFor(() =>
      assert.ok(waiting.has('bg.png') && waiting.has('im.png')),
    );
    const before = treeOf(el);
    await expectPixel(result.ctx, 20, 10, [255, 255, 255], {
      message: 'nothing yet',
    });
    // the background: painted, from the same boxes
    waiting.get('bg.png')!();
    await waitFor(() => expectPixel(result.ctx, 20, 10, [255, 0, 0]));
    assert.strictEqual(treeOf(el), before, 'not built again');
    await expectPixel(result.ctx, 2, 22, [255, 0, 0], {
      message: 'the border image too',
    });
    assert.strictEqual(
      bytesApart(await snapshot(result, el), await rebuilt(result, el)),
      0,
      'as a build of the whole document draws it',
    );
    // the image without a size: built again, at its size
    const built = treeOf(el);
    assert.deepStrictEqual(
      [boxOf(el, 'im').width, boxOf(el, 'im').height],
      [0, 0],
    );
    waiting.get('im.png')!();
    await waitFor(() => assert.notStrictEqual(treeOf(el), built));
    assert.deepStrictEqual(
      [boxOf(el, 'im').width, boxOf(el, 'im').height],
      [30, 16],
    );
  },
);

metric(
  'an SVG background drawn again at its size is copied from a raster of it, the pixels its paths set',
  async () => {
    // Set from its paths at every paint that reached it, a drawing of a
    // few tens of kilobytes was milliseconds a paint: Zen Garden 219's
    // fixed backgrounds at every frame of a scroll. Its second drawing at a
    // size keeps a raster, and every drawing after copies it: a repeated
    // tile from the first paint, a lone one from the second.
    const drawing = svgBytes(
      `<svg ${SVG_NS} width="40" height="30" viewBox="0 0 40 30">` +
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#0000ff"/>' +
        '<stop offset="1" stop-color="#ff00ff"/></linearGradient></defs>' +
        '<rect width="40" height="30" fill="url(#g)"/>' +
        '<circle cx="17.3" cy="13.6" r="9.4" fill="#ffcc00"/></svg>',
    );
    for (const scale of [1, 2]) {
      const { result, el } = await renderWithBytes(
        '<style>body{margin:0}div{height:60px}' +
          '#lone{background:url(a.svg) 3px 4px/33.3px auto no-repeat}' +
          '#tiled{background:url(a.svg) 0 0/21.7px auto}</style>' +
          '<div id="lone"></div><div id="tiled"></div>',
        { 'a.svg': drawing },
        200,
        scale,
      );
      const proto = SvgDrawing.prototype;
      const draw = proto.drawImage;
      let set = 0;
      proto.drawImage = function (
        this: SvgDrawing,
        ...args: Parameters<typeof draw>
      ) {
        set += 1;
        return draw.apply(this, args);
      };
      try {
        const repaint = async () => {
          set = 0;
          (
            el as unknown as {
              invalidate(all: boolean, by: unknown, why: string): void;
            }
          ).invalidate(false, el, 'test');
          return snapshot(result, el);
        };
        const first = await snapshot(result, el);
        const second = await repaint();
        assert.strictEqual(set, 1, `${scale}x: the lone one's raster is made`);
        const third = await repaint();
        assert.strictEqual(set, 0, `${scale}x: and nothing is set from paths`);
        assert.strictEqual(bytesApart(first, second), 0, `${scale}x: second`);
        assert.strictEqual(bytesApart(first, third), 0, `${scale}x: third`);
      } finally {
        proto.drawImage = draw;
      }
      cleanup();
    }
  },
);

metric(
  'a large gradient straight down or across is copied from a strip of it, the pixels it fills',
  async () => {
    // Shaded a pixel at a time, a page's body gradient was 7 ms of every
    // frame that repainted most of a window on macOS at 2x. One that runs
    // straight down does not change across, so a strip of it is shaded on
    // a surface and copied along; and one straight across, down. A small
    // one, a tile of one and one at a slant are filled as they were.
    // Where it is opaque, the pixels are the ones the fill drew.
    const page =
      '<style>body{margin:0;background:linear-gradient(to bottom,' +
      ' #102030, #e5ede8 120px, #ffffff)}' +
      '#a{height:280px;margin:10px 7px;background:linear-gradient(90deg,' +
      ' #ff0000, #00ff0080 30%, #0000ff)}' +
      '#b{height:40px;margin:10px;background:linear-gradient(45deg,' +
      ' #ff0000, #0000ff)}' +
      '#c{width:200px;height:200px;margin:10px;background:' +
      'linear-gradient(to top, #ff000080, #0000ff) 0 0/50px 50px}</style>' +
      '<div id="a"></div><div id="b"></div><div id="c"></div>';
    for (const scale of [1, 2]) {
      const result = await renderX11(
        h(
          'box',
          { style: { width: 400, flexDirection: 'column' } },
          h(Html, { source: page, partial: false, 'data-testname': 'doc' }),
        ),
        { width: 440, height: 600, fonts: FONTS!, scale },
      );
      const el = view(screen.getByTestName('doc') as DrawnNode);
      let proto = Object.getPrototypeOf(result.ctx);
      while (!Object.prototype.hasOwnProperty.call(proto, 'getTransform')) {
        proto = Object.getPrototypeOf(proto);
      }
      const get = proto.getTransform;
      let draw = proto;
      while (!Object.prototype.hasOwnProperty.call(draw, 'drawImage')) {
        draw = Object.getPrototypeOf(draw);
      }
      const drawImage = draw.drawImage;
      let copies = 0;
      draw.drawImage = function (this: unknown, ...args: unknown[]) {
        if (args.length === 9) copies += 1;
        return drawImage.apply(this, args);
      };
      try {
        const repaint = () => {
          copies = 0;
          (
            el as unknown as {
              invalidate(all: boolean, by: unknown, why: string): void;
            }
          ).invalidate(false, el, 'test');
          return snapshot(result, el);
        };
        const strips = await repaint();
        // the body's, 400 wide, and #a's, 280 down, at 64 a copy
        const wide = 400 * scale;
        const tall = 280 * scale;
        assert.strictEqual(
          copies,
          Math.ceil(wide / 64) + Math.ceil(tall / 64),
          `${scale}x: copied`,
        );
        // a context with no matrix to read fills each as it is
        proto.getTransform = undefined;
        const filled = await repaint();
        assert.strictEqual(copies, 0, `${scale}x: filled`);
        // the same pixels where the gradient is opaque; where it is not, a
        // strip holds it rounded to a level before it is laid over what
        // is under it, and may be a level off the fill
        const a = boxOf(el, 'a');
        const width = (el as unknown as DrawnNode).abs.width;
        let off = Math.abs(strips.length - filled.length);
        for (let i = 0; i < Math.min(strips.length, filled.length); i += 1) {
          if (strips[i] === filled[i]) continue;
          const x = Math.floor(i / 4) % width;
          const y = Math.floor(i / 4 / width);
          const inA =
            x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height;
          if (!inA || Math.abs(strips[i] - filled[i]) > 1) off += 1;
        }
        assert.strictEqual(off, 0, `${scale}x`);
      } finally {
        proto.getTransform = get;
        draw.drawImage = drawImage;
      }
      cleanup();
    }
  },
);
