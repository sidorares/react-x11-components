// <Html> — borders, radii, outlines, border images and box shadows.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup, expectPixel, renderX11, screen } from 'react-x11/test';
import { parseColor } from '../../src/html/css/values.js';
import { NO_BORDER_IMAGE } from '../../src/html/css/style.js';
import type { BorderImage, ComputedStyle } from '../../src/html/css/style.js';
import { SurfaceCache } from '../../src/html/surfaces.js';
import {
  boxOf,
  fillsIn,
  fillsOf,
  h,
  metric,
  pathsOf,
  pixelsIn,
  render,
  view,
  windingAt,
} from './harness.js';
import type { Fill, LaidBox, PaintOp } from './harness.js';

afterEach(cleanup);

metric(
  "a border with no colour of its own follows the element's ink",
  async () => {
    // `border-bottom: 2px solid` then `color: red` in the same rule: the
    // border is currentColor, resolved when it is painted — not frozen to the
    // colour the cascade happened to hold mid-rule.
    const { node } = await render(
      '<style>p{border-bottom:2px solid;color:#ff0000;margin:0}</style><p>x</p>',
    );
    const el = view(node);
    // The recorder has no window for ntk's glyph path to draw through, so the
    // ink is stubbed out — the border fills are what this test is about.
    const tree = (el as unknown as { _tree: unknown })._tree as {
      root: {
        children: unknown[];
        lines: { texts: { layout: { draw(): void } }[] }[] | null;
      };
    };
    const stub = (box: typeof tree.root): void => {
      for (const line of box.lines ?? []) {
        for (const text of line.texts) text.layout.draw = () => {};
      }
      for (const child of box.children) stub(child as typeof tree.root);
    };
    stub(tree.root);
    const { paintDocument } = await import('../../src/html/paint.js');
    const fills: unknown[] = [];
    let fillStyle: unknown = null;
    paintDocument(
      {
        set fillStyle(v: unknown) {
          fillStyle = v;
        },
        get fillStyle() {
          return fillStyle;
        },
        save() {},
        restore() {},
        fillRect() {
          fills.push(fillStyle);
        },
      } as never,
      (el as unknown as { _tree: never })._tree,
      {
        originX: 0,
        originY: 0,
        damage: null,
        selection: null,
        selectionColor: null,
        imageFor: () => null,
      },
    );
    assert.ok(
      fills.includes('#ff0000'),
      `the border painted in the element's colour`,
    );
  },
);

test('a border style alone draws a medium border, and a negative width is dropped', async () => {
  const { node } = await render(
    '<div id="alone" style="border-style:solid">a</div>' +
      '<div id="negative" style="border:1px solid;border-width:-2px">b</div>' +
      '<div id="zeros" style="border:solid;border-top-width:-0;' +
      'border-right-width:+0;border-bottom-width:0.0">c</div>',
  );
  type Edges = LaidBox & {
    borderTop: number;
    borderRight: number;
    borderBottom: number;
    borderLeft: number;
  };
  const el = view(node);
  const alone = boxOf(el, 'alone') as Edges;
  assert.deepStrictEqual(
    [alone.borderTop, alone.borderRight, alone.borderBottom, alone.borderLeft],
    [3, 3, 3, 3],
    'medium, as CSS starts every border',
  );
  const negative = boxOf(el, 'negative') as Edges;
  assert.strictEqual(negative.borderTop, 1, 'the width before it stands');
  const zeros = boxOf(el, 'zeros') as Edges;
  assert.deepStrictEqual(
    [zeros.borderTop, zeros.borderRight, zeros.borderBottom, zeros.borderLeft],
    [0, 0, 0, 3],
    '-0, +0 and 0.0 are zeros',
  );
});

test('negative or auto padding is no padding value', async () => {
  // CSS 2.1 8.4: padding is never negative and never `auto`; a declaration
  // that says so is dropped, and what came before it stands
  const { node } = await render(
    '<div id="a" style="padding:5px;padding-left:-1px">a</div>' +
      '<div id="b" style="padding:5px;padding:2px -3px">b</div>' +
      '<div id="c" style="padding:5px;padding:auto">c</div>',
  );
  const el = view(node);
  const pads = (id: string) => {
    const b = boxOf(el, id) as LaidBox & { padLeft: number; padTop: number };
    return [b.padTop, b.padLeft];
  };
  assert.deepStrictEqual(pads('a'), [5, 5]);
  assert.deepStrictEqual(pads('b'), [5, 5], 'the whole shorthand goes');
  assert.deepStrictEqual(pads('c'), [5, 5]);
});

test('a border shorthand that names a part twice is no border', async () => {
  // `<line-width> || <line-style> || <color>`, each at most once: `red
  // solid 16px red` is invalid, and the border before it stands, where the
  // second colour was taken for the first
  const { node } = await render(
    '<div id="a" style="border:1px solid #00ff00;' +
      'border:#ff0000 solid 16px #ff0000"></div>',
  );
  const a = boxOf(view(node), 'a') as unknown as {
    style: { borderTopWidth: number; borderTopColor: string };
  };
  assert.strictEqual(a.style.borderTopWidth, 1);
  assert.strictEqual(a.style.borderTopColor, '#00ff00');
});

test('a shadow down a box far off the window is cut to what the paint reaches', async () => {
  // Its outline goes to the server in 16.16 fixed point, and a shadow cast
  // down a box tens of thousands of pixels tall, scrolled far, threw from
  // the paint. Cut where the blur cannot reach what is painted, as a
  // background is.
  const { node } = await render(
    '<style>body{margin:0}</style><div style="position:relative;' +
      'top:-40000px;height:50000px;margin:10px;border-radius:12px;' +
      'box-shadow:0 8px 30px #0006, inset 0 0 12px #ff0000"></div>',
  );
  const fills = await fillsOf(view(node));
  const shadows = fills.filter((f) => f.shadow);
  assert.strictEqual(shadows.length, 2, 'the outer shadow and the inset');
  for (const f of fills) {
    for (const v of [f.x, f.y, f.x + f.w, f.y + f.h]) {
      assert.ok(Math.abs(v) < 32768, `${f.x},${f.y} ${f.w}x${f.h}`);
    }
  }
});

test("a rounded box's border is a ring that follows its corners", async () => {
  // drawn a side at a time, its corners were square over the background's
  // rounded ones; the inside of the ring is rounded by the radius less the
  // border
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:100px;height:40px;border:2px solid #ff0000;' +
      'border-radius:8px"></div>' +
      '<div style="width:100px;height:40px;border-left:6px solid #0000ff;' +
      'border-radius:10px"></div>' +
      '<div style="width:100px;height:40px;border:2px solid #00ff00;' +
      'border-top-color:#ff00ff;border-radius:8px"></div>',
  );
  const fills = await fillsOf(view(node));
  const red = fills.find((f) => f.style === parseColor('#ff0000'));
  assert.ok(red, 'a fill in the border colour');
  assert.deepStrictEqual(
    [red.x, red.y, red.w, red.h, red.radii, red.rule],
    [0, 0, 104, 44, [8, 8, 8, 8], 'evenodd'],
  );
  assert.deepStrictEqual(red.inner, {
    x: 2,
    y: 2,
    w: 100,
    h: 40,
    radii: [6, 6, 6, 6],
  });
  // a border down one side curves into the corners it meets, the inside's
  // corners there ellipses 4px across and 10px down, and its hole is run
  // from the top left anticlockwise
  const blue = fills.find((f) => f.style === parseColor('#0000ff'));
  assert.deepStrictEqual(blue?.corners?.slice(4), [
    [4, 10],
    [4, 10],
    [10, 10],
    [10, 10],
  ]);
  // and sides of two colours are each a share of the ring: the top's across
  // the top, and the rest one fill round the other three
  const green = fills.filter((f) => f.style === parseColor('#00ff00'));
  const magenta = fills.filter((f) => f.style === parseColor('#ff00ff'));
  assert.strictEqual(green.length, 1, 'one fill for the three green sides');
  assert.strictEqual(magenta.length, 1, 'and one for the top');
  assert.deepStrictEqual(
    [green[0].x, green[0].y + green[0].h, green[0].w],
    [0, 128, 104],
  );
  assert.ok(green[0].y > 85, `from under the top: ${green[0].y}`);
  const top = magenta[0];
  assert.strictEqual(top.y, 84);
  assert.ok(
    top.h < 10 && top.x > 0 && top.x + top.w < 104,
    `the top alone, between its corners: ${top.x} ${top.w}x${top.h}`,
  );
});

test('a 3D border is shaded as Chromium shades one', async () => {
  const { borderShades } = await import('../../src/html/css/color.js');
  // the shadow is the colour darkened; where that leaves black, the colour
  // is the shadow and the light is lightened
  assert.deepStrictEqual(borderShades('black'), {
    lit: 'rgba(84, 84, 84, 1)',
    shadowed: 'rgba(0, 0, 0, 1)',
  });
  assert.deepStrictEqual(borderShades('white'), {
    lit: 'rgba(255, 255, 255, 1)',
    shadowed: 'rgba(171, 171, 171, 1)',
  });
  assert.deepStrictEqual(borderShades('rgba(0, 0, 0, 0.5)'), {
    lit: 'rgba(84, 84, 84, 0.5)',
    shadowed: 'rgba(0, 0, 0, 0.5)',
  });
});

test('groove and ridge are two bands, inset and outset one, lit from the top left', async () => {
  // a groove in its default colour was drawn as a solid border (WPT
  // borders/groove-default, ridge-default)
  const { node } = await render(
    '<style>body{margin:0} div{width:40px;height:20px;border:8px #ffffff}' +
      '</style><div style="border-style:groove"></div>' +
      '<div style="border-style:outset"></div>',
  );
  const fills = await fillsOf(view(node));
  const lit = 'rgba(255, 255, 255, 1)';
  const shadow = 'rgba(171, 171, 171, 1)';
  const of = (y0: number, y1: number) =>
    fills.filter((f) => f.y >= y0 && f.y < y1 && f.w > 0).map((f) => f.style);
  // the groove: its top's outer band in shadow and its inner band lit, its
  // bottom's the other way round — eight bands in all
  const groove = of(0, 36);
  assert.strictEqual(groove.length, 8);
  assert.deepStrictEqual(groove.slice(0, 2), [shadow, lit]);
  // the outset: a band a side, the top and the left lit
  const outset = of(36, 72);
  assert.deepStrictEqual(outset, [lit, shadow, shadow, lit]);
});

metric(
  'sides of different colours meet on the diagonal of the corner they share',
  async () => {
    // CSS Backgrounds 3, 4.4: a corner is divided between its two sides on
    // the line from its outer point to its inner one. The top and the
    // bottom were drawn full width and the sides between them, so the CSS
    // triangle — one coloured border between transparent ones, on a box of
    // no size — was the rectangle around it: a dropdown's caret, a
    // tooltip's arrow
    const { result } = await render(
      '<style>body{margin:0;background:#ffffff}' +
        'div{width:0;height:0;margin-bottom:10px}</style>' +
        '<div style="border:20px solid transparent;' +
        'border-top-color:#ff0000;border-bottom:0"></div>' +
        '<div style="border-left:20px solid transparent;' +
        'border-right:20px solid transparent;' +
        'border-bottom:30px solid #0000ff"></div>' +
        '<div style="border:20px solid transparent;' +
        'border-left-color:#00ff00;border-right:0"></div>' +
        '<div style="width:20px;height:10px;border:20px solid;' +
        'border-color:#ff0000 #00ff00 #0000ff #ff00ff"></div>',
    );
    const ctx = result.ctx;
    const at = (x: number, y: number, color: string, message: string) =>
      expectPixel(ctx, x, y, color, { message, tolerance: 8 });
    // pointing down, 40 by 20 at the top
    await at(20, 3, '#ff0000', 'the down triangle, under its base');
    await at(5, 2, '#ff0000', 'along its base');
    await at(20, 15, '#ff0000', 'near its point');
    await at(3, 12, '#ffffff', 'beside its left slope');
    await at(36, 12, '#ffffff', 'beside its right slope');
    await at(0, 19, '#ffffff', 'the corner under its left slope');
    await at(39, 19, '#ffffff', 'the corner under its right slope');
    // pointing up, 40 by 30 from 30 down
    await at(20, 55, '#0000ff', 'the up triangle, over its base');
    await at(20, 40, '#0000ff', 'under its point');
    await at(1, 59, '#0000ff', 'the end of its base');
    await at(0, 30, '#ffffff', 'the corner over its left slope');
    await at(39, 30, '#ffffff', 'the corner over its right slope');
    await at(5, 40, '#ffffff', 'beside its left slope');
    // pointing right, 20 by 40 from 70 down: its top and bottom are
    // transparent and as tall as the box between them, which left the side
    // no height at all
    await at(3, 90, '#00ff00', 'the right triangle, by its base');
    await at(15, 90, '#00ff00', 'near its point');
    await at(19, 70, '#ffffff', 'the corner over its slope');
    await at(19, 109, '#ffffff', 'the corner under its slope');
    // four colours round a box, 60 by 50 from 120 down: each corner is
    // two colours, where it was all the top's or the bottom's
    await at(10, 123, '#ff0000', 'the top of the top left corner');
    await at(3, 130, '#ff00ff', "and the left's half of it");
    await at(56, 130, '#00ff00', "the right's half of the top right");
    await at(3, 160, '#ff00ff', "the left's half of the bottom left");
    await at(10, 166, '#0000ff', "and the bottom's");
    await at(56, 160, '#00ff00', "the right's half of the bottom right");
    await at(30, 145, '#ffffff', 'and nothing inside it');
  },
);

metric(
  "a double border's lines join at its corners, two frames one inside the other",
  async () => {
    // CSS Backgrounds 3, 4.2: two parallel solid lines, and Chrome draws a
    // double border of one colour as a frame along the border edge and one
    // along the padding edge. The top and the bottom were two lines the
    // width of the box and the sides two lines between them, so the outer
    // frame was open at each corner and the inner line of the top ran on
    // past the side's to the border edge
    const { result } = await render(
      '<style>body{margin:0;background:#ffffff}' +
        'div{width:40px;height:20px;margin:4px}</style>' +
        '<div style="border:6px double #ff0000"></div>' +
        '<div style="border:3px double #0000ff"></div>' +
        '<div style="border:double #00ff00;border-width:6px 12px"></div>',
    );
    const ctx = result.ctx;
    const at = (x: number, y: number, color: string, message: string) =>
      expectPixel(ctx, x, y, color, { message });
    // 6px, from 4,4 to 56,36: lines of two pixels, two apart
    await at(4, 4, '#ff0000', 'the corner of the outer frame');
    await at(4, 7, '#ff0000', 'its left line, beside the gap under the top');
    await at(55, 33, '#ff0000', 'its right line, over the bottom');
    await at(7, 7, '#ffffff', 'between the two lines at the corner');
    await at(7, 9, '#ffffff', "the top's inner line stops at the left's");
    await at(8, 9, '#ff0000', 'and meets it');
    await at(52, 31, '#ffffff', "the bottom's stops at the right's");
    await at(51, 31, '#ff0000', 'and meets it too');
    // 3px, from 4,40 to 50,66: a pixel each, a pixel apart
    await at(4, 41, '#0000ff', 'a one-pixel outer frame, closed');
    await at(5, 41, '#ffffff', 'between the lines');
    await at(5, 42, '#ffffff', 'no notch where the inner line ran on');
    await at(6, 42, '#0000ff', 'the corner of the inner frame');
    // the sides twice as wide as the top, from 4,70: each line a third of
    // its own side, and a frame whatever the widths
    await at(7, 73, '#00ff00', "the left's outer line, four wide");
    await at(8, 72, '#ffffff', 'the gap beside it');
    await at(11, 74, '#ffffff', "the top's inner line stops at the left's");
    await at(12, 74, '#00ff00', 'its inner line, twelve in less a third');
  },
);

test("a double border wider than the paint's reach keeps its lines at its edges", async () => {
  // Only the part of a side near the repaint goes to the server, and the
  // two lines were split out of that part: repainted 60px down a border
  // 300px wide, the top's lines were drawn a third of 144px each, at the
  // edges of what was left of it
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:0;height:0;border:300px double #0000ff"></div>',
  );
  const ink = parseColor('#0000ff');
  const fills = await fillsOf(view(node), undefined, {
    damage: { x: 290, y: 60, width: 20, height: 20 },
  });
  assert.deepStrictEqual(
    fills.filter((f) => f.style === ink).map((f) => [f.x, f.y, f.w, f.h]),
    [[226, 0, 148, 100]],
    'the outer line of the top, a third of 300px, cut across to the reach',
  );
});

/** The polygons a paint fills — paths of straight lines, each as its
 *  corners — and how many rectangles, over the part of the document `damage`
 *  names, or all of it. */
async function polygonsOf(
  node: Parameters<typeof view>[0],
  damage: { x: number; y: number; width: number; height: number } | null = null,
  paths = true,
): Promise<{
  polygons: { style: unknown; points: number[] }[];
  rects: number;
}> {
  const { paintDocument } = await import('../../src/html/paint.js');
  const polygons: { style: unknown; points: number[] }[] = [];
  let rects = 0;
  let points: number[] = [];
  const ctx = {
    fillStyle: null as unknown,
    save() {},
    restore() {},
    fillRect() {
      rects += 1;
    },
  };
  // a context with no path API is the mock backend's
  if (paths) {
    Object.assign(ctx, {
      beginPath() {
        points = [];
      },
      moveTo: (x: number, y: number) => points.push(x, y),
      lineTo: (x: number, y: number) => points.push(x, y),
      closePath() {},
      fill: () => polygons.push({ style: ctx.fillStyle, points }),
    });
  }
  paintDocument(
    ctx as never,
    (view(node) as unknown as { _tree: never })._tree,
    {
      originX: 0,
      originY: 0,
      damage,
      selection: null,
      selectionColor: null,
      imageFor: () => null,
    },
  );
  return { polygons, rects };
}

test('a corner is cut only where a cut would show, and a side only where a corner of it is', async () => {
  // Four sides alike are four rectangles, as they were: one colour makes the
  // same corner whichever side has it, whatever the widths. So are a corner
  // of one pixel, and dots and dashes.
  const plain = await render(
    '<style>body{margin:0}div{width:40px;height:20px}</style>' +
      '<div style="border:4px solid #ff0000"></div>' +
      '<div style="border:solid #00ff00;border-width:2px 8px"></div>' +
      '<div style="border:1px solid;border-color:#0000ff #ff00ff"></div>' +
      '<div style="border:4px dashed #00ffff;border-left-color:#ffff00"></div>',
  );
  const alike = await polygonsOf(plain.node);
  assert.deepStrictEqual(alike.polygons, [], 'no path among them');
  assert.ok(alike.rects >= 16, `${alike.rects} rectangles`);
  cleanup();
  // One side of another colour, opaque: it is drawn after the top and the
  // bottom and takes its half of each corner over them, so they stay
  // rectangles and it alone is a trapezoid, the height of the box
  const { node } = await render(
    '<style>body{margin:0}div{width:40px;height:20px}</style>' +
      '<div style="border:4px solid #ff0000;border-left-color:#0000ff"></div>',
  );
  const one = await polygonsOf(node);
  assert.deepStrictEqual(one.polygons, [
    { style: parseColor('#0000ff'), points: [0, 28, 0, 0, 4, 4, 4, 24] },
  ]);
  assert.strictEqual(one.rects, 3, 'the top, the bottom and the right');
  // and a context that draws no path draws the sides straight
  const straight = await polygonsOf(node, null, false);
  assert.strictEqual(straight.rects, 4);
  cleanup();
  // A side that shows what is under it covers nothing: the top and the
  // bottom are cut back to the diagonal too
  const sheer = await render(
    '<style>body{margin:0}div{width:40px;height:20px}</style>' +
      '<div style="border:4px solid #ff0000;' +
      'border-left-color:rgba(0,0,255,0.5)"></div>',
  );
  const three = await polygonsOf(sheer.node);
  assert.deepStrictEqual(
    three.polygons.map((p) => p.points),
    [
      [0, 0, 48, 0, 48, 4, 4, 4],
      [48, 28, 0, 28, 4, 24, 48, 24],
      [0, 28, 0, 0, 4, 4, 4, 24],
    ],
  );
  assert.strictEqual(three.rects, 1, 'the right');
});

test('a side cut to what the paint reaches keeps its slope', async () => {
  // A slanted divider is a triangle the width of the page, and only what is
  // near the painted area goes to the server. Cut by moving its corners in,
  // the diagonal turned and crossed the painted area somewhere else.
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:0;height:0;border-left:1000px solid transparent;' +
      'border-bottom:400px solid #00aa77"></div>',
  );
  const whole = await polygonsOf(node);
  assert.deepStrictEqual(
    whole.polygons.map((p) => p.points),
    [[1000, 400, 0, 400, 1000, 0, 1000, 0]],
  );
  const { polygons } = await polygonsOf(node, {
    x: 480,
    y: 180,
    width: 20,
    height: 20,
  });
  assert.strictEqual(polygons.length, 1);
  const corners: [number, number][] = [];
  for (let i = 0; i < polygons[0].points.length; i += 2) {
    corners.push([polygons[0].points[i], polygons[0].points[i + 1]]);
  }
  // the diagonal, from the bottom left to the top right
  const above = ([x, y]: [number, number]): number => 400 - 0.4 * x - y;
  assert.ok(
    corners.every(([x, y]) => x > 300 && x < 700 && y > 0 && y < 400),
    `cut to the neighbourhood of the paint: ${corners.join(' ')}`,
  );
  assert.ok(
    corners.every((c) => above(c) < 1e-6),
    `nothing over the diagonal: ${corners.join(' ')}`,
  );
  assert.strictEqual(
    corners.filter((c) => Math.abs(above(c)) < 1e-6).length,
    2,
    `and two corners on it, where it is cut: ${corners.join(' ')}`,
  );
});

test('a 3D side cut to what the paint reaches keeps its slope', async () => {
  // A thick 3D border's sides are four triangles that meet at the middle of
  // the box. Cut by clamping their corners to the painted area, the joins
  // crossed the damage at 45° wherever they really were: the top's triangle
  // repainted 240,100 as (175,35) (325,35) (325,185), whose slope runs
  // through the damage, where its true one is nowhere near it — and a
  // scrolled strip smeared the corners.
  const { borderShades } = await import('../../src/html/css/color.js');
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:0;height:0;border:500px inset #888888"></div>',
  );
  const { lit, shadowed } = borderShades(parseColor('#888888')!)!;
  // each side's triangle, as how far a point is inside both its diagonals
  const sides = {
    top: {
      shade: shadowed,
      in: (x: number, y: number) => [x - y, 1000 - x - y],
    },
    right: { shade: lit, in: (x: number, y: number) => [x - y, x + y - 1000] },
    bottom: { shade: lit, in: (x: number, y: number) => [y - x, x + y - 1000] },
    left: {
      shade: shadowed,
      in: (x: number, y: number) => [y - x, 1000 - x - y],
    },
  };
  const whole = await polygonsOf(node);
  assert.deepStrictEqual(
    whole.polygons.map((p) => p.points),
    [
      [0, 0, 1000, 0, 500, 500, 500, 500],
      [1000, 0, 1000, 1000, 500, 500, 500, 500],
      [1000, 1000, 0, 1000, 500, 500, 500, 500],
      [0, 1000, 0, 0, 500, 500, 500, 500],
    ],
  );
  // the damage beside the top's join with the left, where the two are one
  // shade, and beside the left's with the bottom, where they are not
  for (const { damage, join, pair } of [
    {
      damage: { x: 240, y: 100, width: 20, height: 20 },
      join: (x: number, y: number) => y - x,
      pair: ['top', 'left'],
    },
    {
      damage: { x: 240, y: 680, width: 20, height: 20 },
      join: (x: number, y: number) => x + y - 1000,
      pair: ['bottom', 'left'],
    },
  ]) {
    const { polygons } = await polygonsOf(node, damage);
    const found: string[] = [];
    for (const { style, points } of polygons) {
      const corners: [number, number][] = [];
      for (let i = 0; i < points.length; i += 2) {
        corners.push([points[i], points[i + 1]]);
      }
      const at = `${damage.x},${damage.y}: ${corners.join(' ')}`;
      assert.ok(
        corners.every(
          ([x, y]) =>
            x >= damage.x - 65 &&
            x <= damage.x + damage.width + 65 &&
            y >= damage.y - 65 &&
            y <= damage.y + damage.height + 65,
        ),
        `cut to the neighbourhood of the paint, ${at}`,
      );
      const name = (Object.keys(sides) as (keyof typeof sides)[]).find((side) =>
        corners.every(([x, y]) => sides[side].in(x, y).every((d) => d > -1e-6)),
      );
      assert.ok(name, `inside one side's diagonals, ${at}`);
      assert.strictEqual(style, sides[name].shade, `in its shade, ${at}`);
      assert.strictEqual(
        corners.filter(([x, y]) => Math.abs(join(x, y)) < 1e-6).length,
        2,
        `and two corners on the join, where it is cut, ${at}`,
      );
      found.push(name);
    }
    assert.deepStrictEqual(
      found.sort(),
      pair.sort(),
      `the two sides it reaches`,
    );
  }
});

test('a rounded border cut to what the paint reaches keeps its hole', async () => {
  // A rounded solid border is one ring, and it was filled between the
  // painted area — the box cut to 64 pixels round the damage — and that
  // area inset by the borders. So the hole was a border's width in from
  // wherever the paint was cut, and a border wider than the margin had
  // none: a strip repainted in the middle of the content was filled with
  // the border's colour, and a corner the cut went through was drawn as a
  // curve 300 across on a rectangle 148 across.
  const ink = parseColor('#0000ff');
  // the border area of a box 2000 across, less the content's 1000
  const border = (x: number, y: number) =>
    !(x > 500 && x < 1500 && y > 500 && y < 1500);
  const cases = [
    [20, { x: 1000, y: 1000, width: 20, height: 20 }, border],
    [20, { x: 490, y: 990, width: 20, height: 20 }, border],
    [
      300,
      { x: 80, y: 80, width: 20, height: 20 },
      (x: number, y: number) => Math.hypot(x - 300, y - 300) < 300,
    ],
  ] as const;
  for (const [radius, damage, inside] of cases) {
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="width:1000px;height:1000px;border:500px solid #0000ff;' +
        `border-radius:${radius}px"></div>`,
    );
    const { fills } = await pathsOf(view(node), damage);
    const rings = fills.filter((f) => f.style === ink);
    const at = `a radius of ${radius}, repainted at ${damage.x},${damage.y}`;
    const wrong: string[] = [];
    for (let y = damage.y; y < damage.y + damage.height; y += 1) {
      for (let x = damage.x; x < damage.x + damage.width; x += 1) {
        const [px, py] = [x + 0.5, y + 0.5];
        // clear of the curve, which the recorder bends in straight lines
        if (Math.abs(Math.hypot(px - 300, py - 300) - 300) < 1) continue;
        const filled = rings.some(({ rule, outlines }) => {
          const winding = windingAt(outlines, px, py);
          return rule === 'evenodd' ? winding % 2 !== 0 : winding !== 0;
        });
        if (filled !== inside(px, py)) wrong.push(`${x},${y}`);
      }
    }
    assert.deepStrictEqual(
      wrong.slice(0, 4),
      [],
      `the border and nothing else, ${at}: ${wrong.length} wrong`,
    );
  }
});

test("a percentage radius is of the box's width across and its height down", async () => {
  // `50%` was read as no radius, so an avatar was a square: a circle on a
  // square box, and an ellipse on any other, drawn as four curves
  const [circle] = await fillsIn(
    '<div style="width:44px;height:44px;border-radius:50%;' +
      'background:#fde68a"></div>',
    '#fde68a',
  );
  assert.deepStrictEqual(circle.radii, [22, 22, 22, 22]);
  const [ellipse] = await fillsIn(
    '<div style="width:120px;height:56px;border-radius:50%;' +
      'background:#bae6fd"></div>',
    '#bae6fd',
  );
  assert.deepStrictEqual(
    [ellipse.x, ellipse.y, ellipse.w, ellipse.h],
    [0, 0, 120, 56],
  );
  assert.deepStrictEqual(ellipse.corners, [
    [60, 28],
    [60, 28],
    [60, 28],
    [60, 28],
  ]);
});

test('a slash gives the corners their vertical radii', async () => {
  const [both] = await fillsIn(
    '<div style="width:120px;height:56px;border-radius:40px / 20px;' +
      'background:#fecdd3"></div>',
    '#fecdd3',
  );
  assert.deepStrictEqual(both.corners, [
    [40, 20],
    [40, 20],
    [40, 20],
    [40, 20],
  ]);
  // and a corner's own property takes the two
  const [one] = await fillsIn(
    '<div style="width:120px;height:56px;border-top-left-radius:30px 10px;' +
      'background:#fecdd4"></div>',
    '#fecdd4',
  );
  assert.deepStrictEqual(one.corners, [
    [0, 0],
    [0, 0],
    [0, 0],
    [30, 10],
  ]);
});

test('radii too large for their box are reduced together', async () => {
  // Tailwind 4's rounded-full: a pill, its ends half the height round
  const [pill] = await fillsIn(
    '<div style="width:100px;height:30px;border-radius:calc(infinity * 1px);' +
      'background:#dcfce7"></div>',
    '#dcfce7',
  );
  assert.deepStrictEqual(pill.radii, [15, 15, 15, 15]);
  // two corners down a side 40px tall share it: 60px each is 40px, which
  // the Cocoa context's roundRect would clamp to 20px, so it is drawn in
  // curves
  const [tab] = await fillsIn(
    '<div style="width:100px;height:40px;border-radius:60px 60px 0 0;' +
      'background:#e9d5ff"></div>',
    '#e9d5ff',
  );
  assert.ok(tab.corners, 'drawn in curves');
  const [tr, br, bl, tl] = tab.corners!;
  assert.deepStrictEqual(
    [tr, tl],
    [
      [40, 40],
      [40, 40],
    ],
  );
  assert.deepStrictEqual(
    [br, bl],
    [
      [0, 0],
      [0, 0],
    ],
  );
});

test('a border down one side of a rounded box curves its inside by the ellipse left', async () => {
  // the inside's corner is the radius less the border across it: 14px less
  // 6px across and 14px down, an ellipse, so the ring is drawn in curves,
  // its hole run backwards under the non-zero rule (ntk leaves a hairline
  // where two curves drawn the same way meet under the even-odd one)
  const [ring] = await fillsIn(
    '<div style="width:200px;height:40px;border-left:6px solid #0000fe;' +
      'border-radius:14px"></div>',
    '#0000fe',
  );
  assert.strictEqual(ring.rule, 'nonzero');
  assert.deepStrictEqual(ring.corners!.slice(0, 4), [
    [14, 14],
    [14, 14],
    [14, 14],
    [14, 14],
  ]);
  // the hole, from its top left anticlockwise
  assert.deepStrictEqual(ring.corners!.slice(4), [
    [8, 14],
    [8, 14],
    [14, 14],
    [14, 14],
  ]);
});

metric(
  'a rounded border whose sides differ in colour is a ring, each side in its share of it',
  async () => {
    // CSS Backgrounds 3, 4.4: two sides' colours change on the curve of
    // the corner they share. Drawn a side at a time, the web's spinner —
    // `border-radius: 50%` and one side of another colour — was a square
    // frame, and a card with a coloured side was square at every corner
    const { result } = await render(
      '<style>body{margin:0;background:#ffffff}div{margin-bottom:10px}</style>' +
        '<div style="width:24px;height:24px;border:3px solid #cccccc;' +
        'border-top-color:#0077cc;border-radius:50%"></div>' +
        '<div style="width:40px;height:30px;border:6px solid;' +
        'border-color:#ff0000 #00ff00 #0000ff #ff00ff;border-radius:14px">' +
        '</div>',
    );
    const at = (x: number, y: number, color: string, message: string) =>
      expectPixel(result.ctx, x, y, color, { message, tolerance: 8 });
    // the spinner, 30 across from the top left: its top a quarter of the
    // ring, between the diagonals
    await at(15, 1, '#0077cc', 'the top of the spinner');
    await at(8, 3, '#0077cc', 'the top, above the top left diagonal');
    await at(21, 3, '#0077cc', 'and above the top right one');
    await at(3, 8, '#cccccc', 'the left, below the top left diagonal');
    await at(26, 8, '#cccccc', 'the right, below the top right one');
    await at(1, 15, '#cccccc', 'the left');
    await at(15, 28, '#cccccc', 'the bottom');
    await at(1, 1, '#ffffff', 'no corner of a frame at the top left');
    await at(28, 28, '#ffffff', 'nor at the bottom right');
    await at(15, 15, '#ffffff', 'and nothing inside');
    // four colours round a card 52 by 42 from 40 down, each corner two
    await at(0, 40, '#ffffff', 'the card has no square corner');
    await at(51, 81, '#ffffff', 'at either end');
    await at(26, 42, '#ff0000', 'its top');
    await at(10, 43, '#ff0000', 'the top of the top left corner');
    await at(3, 50, '#ff00ff', 'and the left of it');
    await at(48, 50, '#00ff00', 'the right of the top right corner');
    await at(41, 43, '#ff0000', 'and the top of it');
    await at(41, 78, '#0000ff', 'the bottom of the bottom right corner');
    await at(3, 71, '#ff00ff', 'the left of the bottom left corner');
    await at(26, 61, '#ffffff', 'and nothing inside');
  },
);

metric(
  'where two sides of a ring meet, nothing under the border shows between them',
  async () => {
    // Two antialiased fills that meet on a line each cover part of the
    // pixels along it, and the page showed through between them: a pale
    // seam down each cut. The share drawn first reaches on under the one
    // drawn over it, whose edge is the cut.
    const { result } = await render(
      '<style>body{margin:0;background:#ffffff}</style>' +
        '<div style="width:40px;height:40px;border:10px solid;' +
        'border-color:#ff0000 #00ff00;border-radius:50%"></div>',
    );
    const data = await pixelsIn(result.ctx, {
      x: 0,
      y: 0,
      width: 60,
      height: 60,
    });
    // Red and green have no blue in them, and nor does any mix of the two:
    // blue in the ring, away from its edges, is the white under it
    let worst = 0;
    let where = '';
    for (let y = 0; y < 60; y += 1) {
      for (let x = 0; x < 60; x += 1) {
        const d = Math.hypot(x + 0.5 - 30, y + 0.5 - 30);
        if (d < 21.5 || d > 28.5) continue;
        const blue = data[(y * 60 + x) * 4 + 2];
        if (blue > worst) [worst, where] = [blue, `${x},${y}`];
      }
    }
    assert.ok(worst <= 16, `the page shows through at ${where}: ${worst}`);
  },
);

/** The polygons a paint fills in one colour, each as its corners. */
async function sharesOf(
  node: Parameters<typeof view>[0],
  color: string,
  damage: { x: number; y: number; width: number; height: number } | null = null,
): Promise<[number, number][][]> {
  const { polygons } = await polygonsOf(node, damage);
  return polygons
    .filter((p) => p.style === parseColor(color))
    .map((p) => {
      const corners: [number, number][] = [];
      for (let i = 0; i < p.points.length; i += 2) {
        corners.push([p.points[i], p.points[i + 1]]);
      }
      return corners;
    });
}

/** How far a point is from the line through two others. */
function offLine(
  [x, y]: [number, number],
  [x0, y0]: [number, number],
  [x1, y1]: [number, number],
): number {
  return (
    Math.abs((x - x0) * (y1 - y0) - (y - y0) * (x1 - x0)) /
    Math.hypot(x1 - x0, y1 - y0)
  );
}

test("a ring's share is cut on the line from the border box's corner through the padding box's", async () => {
  // Blink's line: it meets the curve where the widths of the two sides say,
  // and here, with a left three times the top, that is not the middle of
  // the corner. A circle 40 across, the padding box from 12,4 to 36,36.
  // Sides that show what is under them are not drawn over each other, so
  // each share ends on the line.
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:24px;height:32px;border-style:solid;' +
      'border-width:4px 4px 4px 12px;border-radius:50%;' +
      'border-color:rgba(255,0,0,.5) rgba(0,255,0,.5) rgba(0,0,255,.5) ' +
      'rgba(255,0,255,.5)"></div>',
  );
  const corner: [number, number][] = [
    [0, 0],
    [40, 0],
    [40, 40],
    [0, 40],
  ];
  const inner: [number, number][] = [
    [12, 4],
    [36, 4],
    [36, 36],
    [12, 36],
  ];
  const sides = [
    'rgba(255,0,0,.5)',
    'rgba(0,255,0,.5)',
    'rgba(0,0,255,.5)',
    'rgba(255,0,255,.5)',
  ];
  for (let side = 0; side < 4; side += 1) {
    const shares = await sharesOf(node, sides[side]);
    assert.strictEqual(shares.length, 1, `one share for side ${side}`);
    const [share] = shares;
    // the border edge clockwise, then the padding edge back
    const outside = (p: [number, number]) =>
      Math.abs(Math.hypot(p[0] - 20, p[1] - 20) - 20) < 1e-6;
    const turn = share.findIndex((p) => !outside(p));
    assert.ok(turn > 1, `side ${side} starts on the border edge`);
    assert.ok(
      share.slice(turn).every((p) => !outside(p)),
      `and comes back along the padding edge`,
    );
    // Its ends: the corner it starts at, from the last point to the
    // first, and the one it ends at, where it turns
    const cuts: [[number, number], [number, number], number][] = [
      [share[share.length - 1], share[0], side],
      [share[turn - 1], share[turn], (side + 1) % 4],
    ];
    for (const [a, b, c] of cuts) {
      for (const p of [a, b]) {
        assert.ok(
          offLine(p, corner[c], inner[c]) < 1e-6,
          `side ${side}'s cut at corner ${c} is on the line: ${p}`,
        );
      }
    }
  }
});

test('an opaque share is drawn over the one before it, which reaches on under it', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:24px;height:24px;border:3px solid #cccccc;' +
      'border-top-color:#0077cc;border-radius:50%"></div>',
  );
  const [top] = await sharesOf(node, '#0077cc');
  const [rest] = await sharesOf(node, '#cccccc');
  const { polygons } = await polygonsOf(node);
  assert.deepStrictEqual(
    polygons.map((p) => p.style),
    [parseColor('#0077cc'), parseColor('#cccccc')],
    'the top first',
  );
  // every corner of either on the circle round the box or the one inside
  // the border
  for (const p of [...top, ...rest]) {
    const d = Math.hypot(p[0] - 15, p[1] - 15);
    assert.ok(
      Math.abs(d - 15) < 1e-6 || Math.abs(d - 12) < 1e-6,
      `${p} on the ring's edges`,
    );
  }
  // the grey ends on the diagonals of the top corners, y = x and y = 30 - x …
  const onCut = rest.filter(([x, y]) =>
    x < 15 ? Math.abs(y - x) < 1e-6 : Math.abs(y - (30 - x)) < 1e-6,
  );
  assert.strictEqual(
    onCut.length,
    4,
    `the grey's four ends: ${rest.join(' ')}`,
  );
  // … and the blue reaches past them under it, and not far
  const under = top.filter(([x, y]) => y > x + 0.5 || y > 30 - x + 0.5);
  assert.ok(under.length > 0, `the blue goes on under the grey`);
  assert.ok(
    top.every(([x, y]) => y < x + 4 && y < 30 - x + 4),
    `but not far: ${top.join(' ')}`,
  );
});

test('a side with no width gives the corner to the one beside it, and a context with no paths draws the sides straight', async () => {
  // 4.4: where one of two sides is zero-width, the other takes up the whole
  // corner. No left: the bottom's share runs round the bottom left corner
  // to the left edge, 16 up from the bottom of a box 42 tall
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:40px;height:30px;border:6px solid #0000ff;' +
      'border-left:0;border-top-color:transparent;border-radius:16px"></div>',
  );
  const shares = await sharesOf(node, '#0000ff');
  assert.strictEqual(shares.length, 1);
  assert.ok(
    shares[0].some(([x, y]) => Math.abs(x) < 1e-6 && Math.abs(y - 26) < 1e-6),
    `to the left edge: ${shares[0].join(' ')}`,
  );
  assert.ok(
    shares[0].every(([x]) => x > -1e-6),
    'and nothing left of the box',
  );
  // the mock backend's context has no path API
  const straight = await polygonsOf(node, null, false);
  assert.deepStrictEqual(straight.polygons, []);
  assert.ok(straight.rects >= 2, `${straight.rects} rectangles`);
});

test('a ring repainted a piece at a time is the same ring', async () => {
  // A share is cut to what the paint reaches, edge by edge; cutting the box
  // it is drawn in instead would put its corners at the edges of the cut
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:380px;height:380px;border:10px solid #0000ff;' +
      'border-top-color:#ff0000;border-radius:50%"></div>',
    500,
  );
  // around the top left cut, which crosses the ring at 58.6,58.6
  const damage = { x: 50, y: 50, width: 20, height: 20 };
  const reach = [50 - 64, 70 + 64];
  const red = await sharesOf(node, '#ff0000', damage);
  const blue = await sharesOf(node, '#0000ff', damage);
  assert.strictEqual(red.length, 1, 'the top, near the paint');
  assert.strictEqual(blue.length, 1, 'and the rest');
  for (const p of [...red[0], ...blue[0]]) {
    const d = Math.hypot(p[0] - 200, p[1] - 200);
    const onRing = Math.abs(d - 200) < 1e-6 || Math.abs(d - 190) < 1e-6;
    const onCut =
      p.some((v) => Math.abs(v - reach[0]) < 1e-6) ||
      p.some((v) => Math.abs(v - reach[1]) < 1e-6);
    assert.ok(
      p.every((v) => v > reach[0] - 1e-6 && v < reach[1] + 1e-6),
      `${p} near the paint`,
    );
    assert.ok(onRing || onCut, `${p} on the ring's edges or the cut`);
  }
  // and the blue ends on the diagonal where the ring is painted whole
  const ends = blue[0].filter(([x, y]) => Math.abs(y - x) < 1e-6);
  assert.deepStrictEqual(
    ends.map(([x]) => Math.round(Math.hypot(x - 200, x - 200))).sort(),
    [190, 200],
  );
});

test('outline and its longhands are read', async () => {
  const { node } = await render(
    '<div id="a" style="outline:2px dashed #ff0000;outline-offset:-1px"></div>' +
      '<div id="b" style="outline:1px solid;outline:none"></div>' +
      '<div id="c" style="outline:auto;outline-color:invert"></div>' +
      '<div id="d" style="outline-style:dotted;outline-style:hidden"></div>' +
      '<div id="e" style="outline:thick groove #00ff00 bogus"></div>',
  );
  const el = view(node);
  type Outlined = {
    outlineStyle: string;
    outlineWidth: number;
    outlineColor: string;
    outlineOffset: number;
  };
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: Outlined }).style;
  const a = style('a');
  assert.deepStrictEqual(
    [a.outlineStyle, a.outlineWidth, a.outlineOffset],
    ['dashed', 2, -1],
  );
  assert.strictEqual(style('b').outlineStyle, 'none');
  assert.deepStrictEqual(
    [style('c').outlineStyle, style('c').outlineColor],
    ['auto', 'currentColor'],
  );
  assert.strictEqual(
    style('d').outlineStyle,
    'dotted',
    'hidden is no outline style',
  );
  assert.strictEqual(
    style('e').outlineStyle,
    'none',
    'an unknown part drops it',
  );
});

test('an outline is drawn round the border box grown by its offset, over the content', async () => {
  // dropped: a focus ring, an avatar's ring and Tailwind UI's hairline
  // over an image's edge were not drawn at all
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:100px;height:40px;outline:3px solid #ff0000;' +
      'outline-offset:4px;margin:10px"></div>' +
      '<div style="width:100px;outline:2px solid #00ff00;outline-offset:-2px">' +
      '<div style="height:20px;background:#0000ff"></div></div>',
  );
  const fills = await fillsOf(view(node));
  const red = fills.filter((f) => f.style === '#ff0000');
  // four edges three pixels thick, round the 100 by 40 box at 10, 10
  // grown by the offset and the width, 7
  assert.deepStrictEqual(
    red.map((f) => [f.x, f.y, f.w, f.h]).sort(),
    [
      [3, 3, 114, 3],
      [3, 54, 114, 3],
      [3, 6, 3, 48],
      [114, 6, 3, 48],
    ].sort(),
  );
  const blue = fills.findIndex((f) => f.style === '#0000ff');
  const green = fills.findIndex((f) => f.style === '#00ff00');
  assert.ok(blue >= 0 && green > blue, 'over the block inside it');
});

test("a block's outline is drawn over the lines after it, and under positioned boxes", async () => {
  // as browsers draw it, after the flow's lines (CSS 2.1 Appendix E, step
  // 10 leaves the choice): drawn after its own, an inline-block after it
  // went over it
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="height:10px;outline:4px solid #ff00ff"></div>' +
      '<span style="display:inline-block;width:20px;height:20px;' +
      'background:#00ffff"></span>' +
      '<div style="position:relative;height:5px;background:#00ff00"></div>',
  );
  const fills = await fillsOf(view(node));
  const inline = fills.findIndex((f) => f.style === '#00ffff');
  const outline = fills.findIndex((f) => f.style === '#ff00ff');
  const positioned = fills.findIndex((f) => f.style === '#00ff00');
  assert.ok(
    inline >= 0 && outline > inline && positioned > outline,
    `${inline} ${outline} ${positioned}`,
  );
});

test("an inline box's outline is drawn round its fragment", async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><p>a <span style="outline:1px solid ' +
      '#ff0000">framed</span> word</p>',
  );
  const fills = await fillsOf(view(node));
  assert.strictEqual(fills.filter((f) => f.style === '#ff0000').length, 4);
});

test('box-shadow: offsets, blur, spread, a colour and inset in either place', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="a" style="box-shadow:0 1px 3px 0 rgb(0 0 0 / 0.1), ' +
      'inset 0 0 0 1px #d1d5db, 0 0 #0000"></div>' +
      '<div id="b" style="box-shadow:2px 3px red inset"></div>' +
      '<div id="c" style="box-shadow:1px 1px;box-shadow:1px red 2px"></div>' +
      '<div id="d" style="box-shadow:0 0 0 1px #000;box-shadow:none"></div>',
  );
  const el = view(node);
  const shadowOf = (id: string) =>
    (boxOf(el, id) as unknown as { style: { boxShadow: unknown } }).style
      .boxShadow;
  // the transparent one, Tailwind's placeholder, is left out
  assert.deepStrictEqual(shadowOf('a'), [
    {
      x: 0,
      y: 1,
      blur: 3,
      spread: 0,
      color: 'rgba(0, 0, 0, 0.1)',
      inset: false,
    },
    { x: 0, y: 0, blur: 0, spread: 1, color: '#d1d5db', inset: true },
  ]);
  assert.deepStrictEqual(shadowOf('b'), [
    { x: 2, y: 3, blur: 0, spread: 0, color: 'red', inset: true },
  ]);
  // a colour between the lengths drops the declaration, and the one
  // before stands, in currentColor
  assert.deepStrictEqual(shadowOf('c'), [
    { x: 1, y: 1, blur: 0, spread: 0, color: 'currentColor', inset: false },
  ]);
  assert.strictEqual(shadowOf('d'), null);
});

test('a ring is the band between a box and its spread, and needs no clip', async () => {
  // Tailwind's `ring-1` on a box with no background of its own
  const [ring] = await fillsIn(
    '<div style="width:100px;height:40px;margin:5px;' +
      'box-shadow:0 0 0 2px #0f0f0f"></div>',
    '#0f0f0f',
  );
  assert.deepStrictEqual(
    [ring.x, ring.y, ring.w, ring.h, ring.rule],
    [3, 3, 104, 44, 'evenodd'],
  );
  assert.deepStrictEqual(ring.inner, {
    x: 5,
    y: 5,
    w: 100,
    h: 40,
    radii: [0, 0, 0, 0],
  });
  // and `ring-inset`, inside the padding edge
  const [inside] = await fillsIn(
    '<div style="width:100px;height:40px;border:1px solid #fff;' +
      'box-shadow:inset 0 0 0 2px #0e0e0e"></div>',
    '#0e0e0e',
  );
  assert.deepStrictEqual(
    [inside.x, inside.y, inside.w, inside.h],
    [1, 1, 100, 40],
  );
  assert.deepStrictEqual(
    [inside.inner!.x, inside.inner!.y, inside.inner!.w, inside.inner!.h],
    [3, 3, 96, 36],
  );
});

test('a blurred shadow is the shadow of a shape drawn clear of the window', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px;height:40px;' +
      'margin:20px;background:#fff;border-radius:8px;' +
      'box-shadow:0 4px 6px -1px #0d0d0d"></div>',
  );
  const ops: PaintOp[] = [];
  const fills = await fillsOf(view(node), ops);
  const shadow = fills.find((f) => f.shadow);
  assert.ok(shadow, 'a fill with a shadow');
  // the spread shrinks the shape and its corners by a pixel; the shape is
  // drawn left of the window, and its shadow offset back onto the box
  assert.deepStrictEqual(
    [shadow.x + shadow.shadow!.x, shadow.y, shadow.w, shadow.h],
    [21, 25, 98, 38],
  );
  assert.ok(shadow.x + shadow.w < 0, 'the shape itself is off the window');
  assert.deepStrictEqual(
    [shadow.shadow!.color, shadow.shadow!.blur, shadow.shadow!.y],
    ['#0d0d0d', 6, 0],
  );
  assert.deepStrictEqual(shadow.radii, [7, 7, 7, 7]);
  // an opaque box covers what falls under it: no clip
  assert.ok(!ops.some((op) => op.op === 'clip'));
});

test('a shadow is not drawn under a box that shows what is behind it', async () => {
  // a hard shadow under a box with no background, clipped out of the box
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:90px;height:40px;' +
      'margin:10px;box-shadow:5px 5px 0 #0c0c0c"></div>',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops);
  const at = ops.findIndex(
    (op) => op.op === 'fill' && op.style === parseColor('#0c0c0c'),
  );
  assert.ok(at > 0, 'the shadow is filled');
  const fill = ops[at] as Fill;
  assert.deepStrictEqual([fill.x, fill.y, fill.w, fill.h], [15, 15, 90, 40]);
  const clip = ops
    .slice(0, at)
    .reverse()
    .find((op) => op.op === 'clip');
  assert.ok(clip, 'a clip around it');
});

test("a shadow's reach is ink: a repaint beside the box reaches it", async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><div id="s" style="width:100px;' +
      'height:40px;margin:30px;box-shadow:0 10px 15px -3px #000"></div>',
  );
  const box = boxOf(view(node), 's') as unknown as {
    y: number;
    height: number;
    boundsY: number;
    boundsHeight: number;
  };
  // 10px down, 3px in, and a blur of 15 reaching 23px past the edge: the
  // ink runs from 10px above the box to 30px below it
  assert.deepStrictEqual(
    [box.boundsY - box.y, box.boundsY + box.boundsHeight - box.y - box.height],
    [-10, 30],
  );
});

test('a blurred shadow is a shadowed fill of a shape the context draws from a tile', async () => {
  // <Html> baked each shadow on a surface of its own, keyed on the part of
  // it a paint reached: every strip a scroll exposed across a shadow baked
  // a new one, which on a 2x display was most of each frame. The context
  // now draws a rect's or a rounded rect's shadow from a tile it keeps
  // (react-x11, ntk/shadow-tiles), and asks only that the shape be one it
  // knows: a rect, a roundRect, or a rect less a roundRect filled evenodd.
  const card =
    '<div style="width:100px;height:40px;margin:10px;background:#fff;' +
    'border-radius:8px;box-shadow:0 4px 6px -1px rgb(0 0 0 / 0.1)"></div>';
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      card.repeat(3) +
      '<div style="width:100px;height:40px;margin:10px;' +
      'box-shadow:0 4px 6px -1px rgb(0 0 0 / 0.1)"></div>' +
      '<div style="width:100px;height:40px;margin:10px;border-radius:6px;' +
      'border-top-left-radius:20px 10px;box-shadow:inset 0 0 12px #f00"></div>',
  );
  const keys: string[] = [];
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    cached: (key) => {
      keys.push(key);
      return {};
    },
  });
  assert.deepStrictEqual(keys, [], 'nothing baked of its own');
  const shadows = ops.filter(
    (op): op is { op: 'fill' } & Fill => op.op === 'fill' && !!op.shadow,
  );
  assert.strictEqual(shadows.length, 5, 'one fill a shadow');
  // each card's: its rounded rect less the spread, 4px down, thrown back
  // from clear of the window by the shadow's offset
  for (const [i, y] of [10, 60, 110].entries()) {
    const s = shadows[i];
    assert.deepStrictEqual(
      [s.x + s.shadow!.x, s.y, s.w, s.h, s.radii],
      [11, y + 5, 98, 38, [7, 7, 7, 7]],
      `card ${i}`,
    );
    assert.ok(s.x + s.w < 0, 'the shape itself is off the window');
  }
  // the box that shows what is behind it is a plain rect, clipped out of it
  assert.strictEqual(shadows[3].radii, null);
  const at = ops.indexOf(shadows[3]);
  assert.ok(
    ops.slice(0, at).some((op) => op.op === 'clip'),
    'a clip around the fourth',
  );
  // the inset one: a frame, a rect less a rounded rect filled evenodd, its
  // hole the padding box with the box's corners — the elliptical one as a
  // point, the circular ones as the numbers they always were
  const inset = shadows[4];
  assert.strictEqual(inset.rule, 'evenodd');
  assert.deepStrictEqual(inset.inner!.radii, [{ x: 20, y: 10 }, 6, 6, 6]);
  assert.strictEqual(inset.shadow!.blur, 12);
});

test('the shadow cache keeps a surface per key, the oldest given up first', async () => {
  const result = await renderX11(h('box', { 'data-testname': 'b' }), {
    width: 20,
    height: 20,
  });
  const app = (screen.getByTestName('b') as unknown as { app: unknown }).app;
  const cache = new SurfaceCache(app, 400);
  let drawn = 0;
  const draw = () => {
    drawn += 1;
  };
  const a = cache.get('a', 10, 10, draw);
  assert.ok(a, 'a surface');
  assert.strictEqual(cache.get('a', 10, 10, draw), a);
  assert.strictEqual(drawn, 1, 'drawn once');
  // one larger than a quarter of the budget is not made
  assert.strictEqual(cache.get('big', 11, 10, draw), null);
  // four more of 100 pixels: the first is given up for the fifth
  for (const key of ['b', 'c', 'd', 'e']) cache.get(key, 10, 10, draw);
  assert.strictEqual(drawn, 5);
  cache.get('a', 10, 10, draw);
  assert.strictEqual(drawn, 6, 'drawn again');
  cache.destroy();
  void result;
});

test("border-image's shorthand and longhands are read", async () => {
  // none of them was (CSS Backgrounds 3, 6)
  const { node } = await render(
    '<div id="a" style="border-image:url(a.png) 27 fill / 10px 2 / 5 round space">' +
      '</div>' +
      '<div id="b" style="border-image:linear-gradient(red,blue) fill 10% 20 / / 3px">' +
      '</div>' +
      '<div id="c" style="border-image-source:url(c.png);border-image-slice:1 2;' +
      'border-image-width:auto 50%;border-image-repeat:repeat;' +
      'border-image-slice:-1"></div>' +
      '<div id="d" style="border-image:url(a.png) 27 / -1px"></div>',
  );
  const el = view(node);
  const image = (id: string) =>
    (boxOf(el, id) as unknown as { style: { borderImage: BorderImage } }).style
      .borderImage;
  assert.deepStrictEqual(image('a'), {
    source: 'a.png',
    slice: [27, 27, 27, 27],
    fill: true,
    width: [10, { times: 2 }, 10, { times: 2 }],
    outset: [{ times: 5 }, { times: 5 }, { times: 5 }, { times: 5 }],
    repeat: ['round', 'space'],
  });
  const b = image('b');
  assert.ok(b.source && typeof b.source === 'object', 'a gradient');
  assert.deepStrictEqual(
    [b.slice, b.fill, b.width, b.outset],
    [
      [{ pct: 10 }, 20, { pct: 10 }, 20],
      true,
      NO_BORDER_IMAGE.width,
      [3, 3, 3, 3],
    ],
  );
  const c = image('c');
  // a negative slice is none, and the one before it stands
  assert.deepStrictEqual(
    [c.source, c.slice, c.width, c.repeat],
    [
      'c.png',
      [1, 2, 1, 2],
      ['auto', { pct: 50 }, 'auto', { pct: 50 }],
      ['repeat', 'repeat'],
    ],
  );
  assert.strictEqual(image('d'), NO_BORDER_IMAGE, 'a negative width is none');
});

test('a border image is cut into nine and drawn over the border', async () => {
  // It was not read: the border was drawn as its style said. The corners
  // are scaled into theirs, the edges along their sides, the middle drawn
  // for `fill`, and the border's own style not at all (CSS Backgrounds 3,
  // 6.2)
  const draw = async (style: string) => {
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        `<div style="border:10px solid #fe0000;${style}"></div>`,
    );
    const ops: PaintOp[] = [];
    const fills = await fillsOf(view(node), ops, {
      backgroundImageFor: () => ({
        image: {},
        width: 15,
        height: 15,
        ratio: 1,
      }),
    });
    assert.ok(!fills.some((f) => f.style === parseColor('#fe0000')));
    return ops.flatMap((op) =>
      op.op === 'image' ? [[...(op.src ?? []), op.x, op.y, op.w, op.h]] : [],
    );
  };
  assert.deepStrictEqual(
    await draw('width:40px;height:20px;border-image:url(a.png) 5 fill'),
    [
      [0, 0, 5, 5, 0, 0, 10, 10],
      [10, 0, 5, 5, 50, 0, 10, 10],
      [0, 10, 5, 5, 0, 30, 10, 10],
      [10, 10, 5, 5, 50, 30, 10, 10],
      [5, 0, 5, 5, 10, 0, 40, 10],
      [5, 10, 5, 5, 10, 30, 40, 10],
      [0, 5, 5, 5, 0, 10, 10, 20],
      [10, 5, 5, 5, 50, 10, 10, 20],
      [5, 5, 5, 5, 10, 10, 40, 20],
    ],
  );
  // slices that overlap leave each corner all of its own, and no edges
  assert.deepStrictEqual(
    await draw('width:40px;height:20px;border-image:url(a.png) 10'),
    [
      [0, 0, 10, 10, 0, 0, 10, 10],
      [5, 0, 10, 10, 50, 0, 10, 10],
      [0, 5, 10, 10, 0, 30, 10, 10],
      [5, 5, 10, 10, 50, 30, 10, 10],
    ],
  );
  // `round` fits whole tiles along the top, and `space` sets them apart
  // down the sides, the tile the slice scaled to the side's width
  const tiles = await draw(
    'width:45px;height:26px;border-image:url(a.png) 5 / 10px round space',
  );
  assert.deepStrictEqual(
    tiles
      .filter((t) => t[5] === 0 && t[4] > 0 && t[4] < 55)
      .map((t) => [t[4], t[6]]),
    [
      [10, 9],
      [19, 9],
      [28, 9],
      [37, 9],
      [46, 9],
    ],
  );
  assert.deepStrictEqual(
    tiles
      .filter((t) => t[4] === 0 && t[5] > 0 && t[5] < 36)
      .map((t) => [t[5], t[7]]),
    [
      [12, 10],
      [24, 10],
    ],
  );
});

test('a border is as wide as the whole device pixels it covers', async () => {
  // Snapped as a border width (CSS Values 4): down to the pixel, and a
  // hairline up to one — two borders of 49.75px left their box half a
  // pixel, which painted nothing, where a browser leaves two
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="a" style="box-sizing:border-box;height:100px;' +
      'border-top:49.75px solid;border-bottom:49.75px solid"></div>' +
      '<div id="b" style="border:0.25px solid;outline:1.9px solid"></div>',
  );
  const el = view(node);
  type Bordered = {
    borderTop: number;
    borderBottom: number;
    borderLeft: number;
  };
  const a = boxOf(el, 'a') as unknown as Bordered;
  assert.deepStrictEqual([a.borderTop, a.borderBottom], [49, 49]);
  const b = boxOf(el, 'b') as unknown as Bordered & { style: ComputedStyle };
  assert.deepStrictEqual([b.borderLeft, b.style.outlineWidth], [1, 1]);
});
