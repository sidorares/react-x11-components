// <Html> — borders, radii, outlines, border images and box shadows.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup, renderX11, screen } from 'react-x11/test';
import { parseColor } from '../../src/html/css/values.js';
import { NO_BORDER_IMAGE } from '../../src/html/css/style.js';
import type { BorderImage, ComputedStyle } from '../../src/html/css/style.js';
import { SurfaceCache } from '../../src/html/surfaces.js';
import { boxOf, fillsIn, fillsOf, h, metric, render, view } from './harness.js';
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
  // and sides of two colours are drawn a side at a time, as before
  const green = fills.filter((f) => f.style === parseColor('#00ff00'));
  assert.ok(
    green.length >= 3 && green.every((f) => !f.inner),
    'straight sides',
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
