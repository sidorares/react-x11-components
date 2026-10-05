// <Html> — transforms: a box turned, scaled or skewed is painted through
// its matrix, found under the pointer where that puts it, and laid out as
// though it had none.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import {
  act,
  cleanup,
  expectPixel,
  pixelAt,
  renderX11,
  screen,
  waitFor,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import type { Matrix } from '../../src/html/css/transform.js';
import {
  invert,
  mapPoint,
  mapRect,
  multiply,
  rotation,
  solidOf,
} from '../../src/html/css/transform.js';
import type { TransformFunction } from '../../src/html/css/transform.js';
import {
  IDENTITY4,
  multiply4,
  perspective4,
  rotate4,
  scale4,
} from '../../src/html/css/transform3d.js';
import { Html } from '../../src/index.js';
import {
  boxOf,
  fillsOf,
  findById,
  h,
  linesOf,
  metric,
  pixelsIn,
  render,
  render2x,
  renderWithBytes,
  solidPng,
  view,
} from './harness.js';
import type { LaidBox, PaintOp, Region } from './harness.js';

afterEach(cleanup);

const WHITE = '#ffffff';
const RED = '#ff0000';
const BLUE = '#0000ff';
const PAGE = '<style>html{background:#ffffff}body{margin:0}</style>';

type Styled = LaidBox & {
  style: {
    translate: unknown;
    rotate: unknown;
    scale: unknown;
    transform:
      | (
          | { by: unknown; z?: number }
          | { matrix: Matrix; fn?: { kind: string } }
          | { solid: readonly number[]; fn?: { kind: string } }
        )[]
      | null;
    transformOrigin: unknown;
  };
  boundsX: number;
  boundsY: number;
  boundsWidth: number;
  boundsHeight: number;
};

const near = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

test('a matrix after another does the second written first', () => {
  // `translate(10px) rotate(90deg)` turns the box where it is and then
  // moves it across: the point (1, 0) goes down to (0, 1), and then right
  const turnThenMove = multiply([1, 0, 0, 1, 10, 0], rotation(90));
  assert.deepStrictEqual(mapPoint(turnThenMove, 1, 0), [10, 1]);
  // and written the other way round the move is turned with the axes
  const moveThenTurn = multiply(rotation(90), [1, 0, 0, 1, 10, 0]);
  assert.deepStrictEqual(mapPoint(moveThenTurn, 1, 0), [0, 11]);
  // a quarter turn is its numbers exactly, and four are none
  assert.deepStrictEqual([...rotation(90)], [0, 1, -1, 0, 0, 0]);
  assert.deepStrictEqual([...rotation(-90)], [0, -1, 1, 0, 0, 0]);
  assert.deepStrictEqual([...rotation(360)], [1, 0, 0, 1, 0, 0]);
  assert.ok(
    near(rotation(45), [
      Math.SQRT1_2,
      Math.SQRT1_2,
      -Math.SQRT1_2,
      Math.SQRT1_2,
      0,
      0,
    ]),
  );
  // what undoes a matrix, and none for one that flattens the plane
  const back = invert(turnThenMove)!;
  assert.ok(near(mapPoint(back, 10, 1), [1, 0]));
  assert.strictEqual(invert([0, 0, 0, 1, 0, 0]), null);
  assert.deepStrictEqual(mapRect(rotation(90), 0, 0, 20, 10), {
    x: -10,
    y: 0,
    width: 10,
    height: 20,
  });
});

test('a transform is read as its functions, in the order written', async () => {
  const { node } = await render(
    '<div id="a" style="transform:rotate(90deg)"></div>' +
      '<div id="b" style="transform:translate(-50%, -50%)"></div>' +
      '<div id="c" style="transform:translate(10px, 5px) rotate(0) skewX(0) ' +
      'skewY(0) scaleX(1) scaleY(1)"></div>' +
      '<div id="d" style="transform:scale(2) rotate(.25turn) scaleX(50%)">' +
      '</div>' +
      '<div id="e" style="transform:matrix(1, 2, 3, 4, 5, 6)"></div>' +
      '<div id="f" style="transform:translateZ(0)"></div>' +
      '<div id="g" style="transform:rotateX(45deg) rotate3d(0, 0, 1, 90deg) ' +
      'perspective(100px) scale3d(2, 3, 4)"></div>' +
      '<div id="h" style="transform:rotate(90deg);transform:rotate(90px)">' +
      '</div>' +
      '<div id="i" style="transform:rotate(45deg);transform:none"></div>' +
      '<div id="j" style="transform:skew(45deg)"></div>' +
      '<div id="k" style="transform:rotate(calc(90deg * -1))"></div>' +
      '<div id="l" style="-webkit-transform:matrix3d(1, 0, 0, 0, 0, 1, 0, 0, ' +
      '0, 0, 1, 0, 7, 8, 9, 1)"></div>' +
      '<div id="m" style="transform:rotate(90deg) scale()"></div>',
  );
  const el = view(node);
  const list = (id: string) => (boxOf(el, id) as Styled).style.transform;
  const matrix = (id: string, at = 0): number[] => {
    const fn = list(id)![at];
    assert.ok('matrix' in fn, `#${id}'s function ${at} is a matrix`);
    return [...fn.matrix];
  };
  // what a run of the functions that are numbers alone comes to: each is
  // kept, with what it was, for an animation to interpolate
  const product = (id: string, from = 0): number[] => {
    let m: Matrix = [1, 0, 0, 1, 0, 0];
    for (const fn of list(id)!.slice(from)) {
      assert.ok('matrix' in fn, `#${id} is matrices from ${from}`);
      m = multiply(m, fn.matrix);
    }
    return [...m];
  };
  assert.deepStrictEqual(matrix('a'), [0, 1, -1, 0, 0, 0]);
  assert.deepStrictEqual(list('b'), [{ by: [{ pct: -50 }, { pct: -50 }] }]);
  // Tailwind 3's list: the translation, and the rest coming to nothing
  assert.strictEqual(list('c')!.length, 6);
  assert.deepStrictEqual(list('c')![0], { by: [10, 5] });
  assert.ok(near(product('c', 1), [1, 0, 0, 1, 0, 0]), `${product('c', 1)}`);
  assert.deepStrictEqual(
    list('c')!.map((fn) => ('by' in fn ? 'by' : fn.fn?.kind)),
    ['by', 'rotate', 'skew', 'skew', 'scale', 'scale'],
  );
  // half as wide, then turned, then twice the size
  assert.strictEqual(list('d')!.length, 3);
  assert.ok(near(product('d'), [0, 1, -2, 0, 0, 0]), `${product('d')}`);
  assert.deepStrictEqual(matrix('e'), [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(
    list('f'),
    [{ by: [0, 0] }],
    'a transform, and a move by nothing',
  );
  // out of the plane: each a 4×4, and about the axis out of the page a
  // turn in it
  assert.deepStrictEqual(
    list('g')!.map((fn) => ('by' in fn ? 'by' : fn.fn?.kind)),
    ['rotate3d', 'rotate', 'perspective', 'scale'],
  );
  assert.deepStrictEqual(
    list('g')!.map((fn) => ('solid' in fn ? 'solid' : 'plane')),
    ['solid', 'plane', 'solid', 'solid'],
  );
  const g = multiply4(
    multiply4(rotate4(1, 0, 0, 45), rotate4(0, 0, 1, 90)),
    multiply4(perspective4(100), scale4(2, 3, 4)),
  );
  let made: readonly number[] = IDENTITY4;
  for (const fn of list('g')!) {
    made = multiply4(made, solidOf(fn as TransformFunction, 0, 0));
  }
  assert.ok(near(made, g), `${made}`);
  assert.deepStrictEqual(matrix('h'), [0, 1, -1, 0, 0, 0], 'no angle: dropped');
  assert.strictEqual(list('i'), null);
  assert.ok(near(matrix('j'), [1, 0, 1, 1, 0, 0]), `${matrix('j')}`);
  assert.deepStrictEqual(matrix('k'), [0, -1, 1, 0, 0, 0]);
  // a 4×4 with a depth in it is one
  const l = list('l')![0];
  assert.ok('solid' in l, 'a matrix3d() that moves toward the viewer');
  assert.deepStrictEqual(
    [...l.solid],
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1],
  );
  assert.strictEqual(list('m'), null, 'a function with no argument: dropped');
});

test('rotate, scale and transform-origin are read', async () => {
  const { node } = await render(
    '<div id="a" style="rotate:90deg"></div>' +
      '<div id="b" style="rotate:z -0.5turn"></div>' +
      '<div id="c" style="rotate:0 0 1 100grad"></div>' +
      '<div id="d" style="rotate:x 90deg"></div>' +
      '<div id="e" style="rotate:45deg;rotate:none"></div>' +
      '<div id="f" style="rotate:45deg;rotate:45"></div>' +
      '<div id="g" style="scale:2"></div>' +
      '<div id="h" style="scale:150% 50%"></div>' +
      '<div id="i" style="scale:2 3 4"></div>' +
      '<div id="j" style="scale:2;scale:none"></div>' +
      '<div id="k" style="--tw-scale-x:calc(150% * -1);--tw-scale-y:100%;' +
      'scale:var(--tw-scale-x) var(--tw-scale-y)"></div>' +
      '<div id="l"></div>' +
      '<div id="m" style="transform-origin:0 0"></div>' +
      '<div id="n" style="transform-origin:bottom"></div>' +
      '<div id="o" style="transform-origin:right 10px 5px"></div>' +
      '<div id="p" style="transform-origin:top left"></div>' +
      '<div id="q" style="rotate:30deg y"></div>' +
      '<div id="r" style="rotate:1 2 0 -45deg"></div>' +
      '<div id="s" style="rotate:0 0 -2 45deg"></div>' +
      '<div id="t" style="rotate:45deg;rotate:x y 45deg"></div>' +
      '<div id="u" style="rotate:45deg;rotate:w 45deg"></div>',
  );
  const el = view(node);
  const style = (id: string) => (boxOf(el, id) as Styled).style;
  // in the plane: about the axis out of the page, either way it points
  assert.deepStrictEqual(style('a').rotate, { kind: 'rotate', angle: 90 });
  assert.deepStrictEqual(style('b').rotate, { kind: 'rotate', angle: -180 });
  assert.deepStrictEqual(style('c').rotate, { kind: 'rotate', angle: 90 });
  assert.deepStrictEqual(
    style('s').rotate,
    { kind: 'rotate', angle: -45 },
    'about the axis into the page',
  );
  // and in space about any other: a letter or a vector, as written, its
  // angle before or after it
  assert.deepStrictEqual(style('d').rotate, {
    kind: 'rotate3d',
    x: 1,
    y: 0,
    z: 0,
    angle: 90,
  });
  assert.deepStrictEqual(style('q').rotate, {
    kind: 'rotate3d',
    x: 0,
    y: 1,
    z: 0,
    angle: 30,
  });
  assert.deepStrictEqual(style('r').rotate, {
    kind: 'rotate3d',
    x: 1,
    y: 2,
    z: 0,
    angle: -45,
  });
  assert.strictEqual(style('e').rotate, null);
  const turn = { kind: 'rotate', angle: 45 };
  assert.deepStrictEqual(style('f').rotate, turn, 'a number is no angle');
  assert.deepStrictEqual(style('t').rotate, turn, 'two axes are none');
  assert.deepStrictEqual(style('u').rotate, turn, 'an axis is x, y or z');
  // across, down and in depth, which is 1 where it is not written
  assert.deepStrictEqual(style('g').scale, [2, 2, 1]);
  assert.deepStrictEqual(style('h').scale, [1.5, 0.5, 1]);
  assert.deepStrictEqual(style('i').scale, [2, 3, 4], 'in depth');
  assert.strictEqual(style('j').scale, null);
  assert.deepStrictEqual(style('k').scale, [-1.5, 1, 1]);
  assert.deepStrictEqual(style('l').transformOrigin, [
    { pct: 50 },
    { pct: 50 },
  ]);
  assert.deepStrictEqual(style('m').transformOrigin, [0, 0]);
  assert.deepStrictEqual(style('n').transformOrigin, [
    { pct: 50 },
    { pct: 100 },
  ]);
  assert.deepStrictEqual(style('o').transformOrigin, [{ pct: 100 }, 10]);
  assert.deepStrictEqual(style('p').transformOrigin, [0, 0]);
});

test('a transform moves nothing but its box, by the translation it comes to', async () => {
  const { node } = await render(
    '<style>body{margin:0}div{width:40px;height:20px}</style>' +
      '<div id="a" style="transform:rotate(90deg)"></div>' +
      '<div id="b" style="transform:rotate(90deg) translate(10px, 0)"></div>' +
      '<div id="c" style="transform:translate(10px, 0) rotate(90deg)"></div>' +
      '<div id="d" style="translate:5px 0;rotate:90deg;scale:2;' +
      'transform:translate(50%, 0)"></div>' +
      '<div id="e" style="transform:matrix(1, 0, 0, 1, 10, 20)"></div>' +
      '<div id="f"></div>',
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).y];
  assert.deepStrictEqual(at('a'), [0, 0], 'turned where it is');
  // across the turned box is down the page
  assert.deepStrictEqual(at('b'), [0, 30]);
  assert.deepStrictEqual(at('c'), [10, 40]);
  // `translate`, then `rotate`, then `scale`, then the list: half its
  // width along its own axis, which is down, and twice as far
  assert.deepStrictEqual(at('d'), [5, 100]);
  assert.deepStrictEqual(at('e'), [10, 100]);
  // and the flow goes on as though none of them had moved
  assert.deepStrictEqual(at('f'), [0, 100]);
});

metric(
  'a box turned a quarter is painted on its side, about its centre',
  async () => {
    const { result, node } = await render(
      PAGE +
        '<div style="height:30px"></div>' +
        '<div id="r" style="margin-left:30px;width:20px;height:10px;' +
        'background:#ff0000;transform:rotate(90deg)"></div>',
    );
    await act();
    const el = view(node);
    // laid out 20 by 10 at (30, 30), and drawn 10 by 20 about (40, 35)
    const box = boxOf(el, 'r') as Styled;
    assert.deepStrictEqual(
      [box.x, box.y, box.width, box.height],
      [30, 30, 20, 10],
    );
    for (const [x, y] of [
      [36, 26],
      [44, 26],
      [40, 35],
      [36, 44],
      [44, 44],
    ]) {
      await expectPixel(result.ctx, x, y, RED, { message: 'turned' });
    }
    // where it was laid out and is not drawn, and just past where it is
    for (const [x, y] of [
      [31, 35],
      [49, 35],
      [34, 26],
      [46, 44],
      [40, 23],
      [40, 46],
    ]) {
      await expectPixel(result.ctx, x, y, WHITE, { message: 'not turned' });
    }
    // what it draws reaches as far as that: a repaint of the rows above
    // where it was laid out has to reach it
    assert.deepStrictEqual(
      [box.boundsX, box.boundsY, box.boundsWidth, box.boundsHeight],
      [35, 25, 10, 20],
    );
    // and it is where it is drawn for the pointer and for who asks
    const r = findById(el.document, 'r');
    assert.strictEqual(el.elementAtPoint(40, 27), r, 'under the pointer');
    assert.notStrictEqual(el.elementAtPoint(32, 35), r, 'not where it was');
    assert.deepStrictEqual(el.elementRect(r!), {
      x: 35,
      y: 25,
      width: 10,
      height: 20,
    });
  },
);

metric('a transform turns and scales about its transform-origin', async () => {
  const { result, node } = await render(
    PAGE +
      '<style>div{position:absolute;width:20px;height:20px}</style>' +
      '<div id="a" style="left:40px;top:40px;background:#ff0000;' +
      'transform:scale(2)"></div>' +
      '<div id="b" style="left:120px;top:40px;background:#0000ff;' +
      'transform:scale(2);transform-origin:0 0"></div>' +
      '<div id="c" style="left:220px;top:40px;height:10px;' +
      'background:#ff0000;rotate:90deg;transform-origin:top left"></div>' +
      '<div id="d" style="left:300px;top:40px;background:#0000ff;' +
      'scale:0.5 1"></div>',
  );
  await act();
  // about its centre: 40 by 40 around (50, 50)
  await expectPixel(result.ctx, 32, 32, RED);
  await expectPixel(result.ctx, 68, 68, RED);
  await expectPixel(result.ctx, 28, 50, WHITE);
  await expectPixel(result.ctx, 72, 50, WHITE);
  // from its corner: 40 by 40 from (120, 40)
  await expectPixel(result.ctx, 122, 42, BLUE);
  await expectPixel(result.ctx, 158, 78, BLUE);
  await expectPixel(result.ctx, 118, 50, WHITE);
  await expectPixel(result.ctx, 162, 50, WHITE);
  // turned about its top left: 20 across goes down, 10 down goes left
  await expectPixel(result.ctx, 212, 42, RED);
  await expectPixel(result.ctx, 218, 58, RED);
  await expectPixel(result.ctx, 225, 45, WHITE);
  // half as wide, about its centre: 10 by 20 from (305, 40)
  await expectPixel(result.ctx, 307, 50, BLUE);
  await expectPixel(result.ctx, 313, 50, BLUE);
  await expectPixel(result.ctx, 302, 50, WHITE);
  await expectPixel(result.ctx, 317, 50, WHITE);
  const el = view(node);
  const rect = (id: string) => el.elementRect(findById(el.document, id)!);
  assert.deepStrictEqual(rect('a'), { x: 30, y: 30, width: 40, height: 40 });
  assert.deepStrictEqual(rect('c'), { x: 210, y: 40, width: 10, height: 20 });
});

metric('an inline icon turned a quarter points the other way', async () => {
  // GitHub's menu buttons hold a triangle pointing right, turned to point
  // down with `transform: rotate(90deg)`, and it pointed right
  const { result, node } = await render(
    PAGE +
      '<p style="margin:20px;line-height:20px">' +
      '<svg id="i" width="16" height="16" viewBox="0 0 16 16" ' +
      'style="transform:rotate(90deg);vertical-align:top">' +
      '<rect width="8" height="16" fill="#ff0000"/></svg></p>',
  );
  await act();
  const el = view(node);
  const { x, y } = boxOf(el, 'i');
  // its left half is red, which turned is its top half
  await expectPixel(result.ctx, x + 4, y + 4, RED);
  await expectPixel(result.ctx, x + 12, y + 4, RED, { message: 'top right' });
  await expectPixel(result.ctx, x + 4, y + 12, WHITE, {
    message: 'bottom left',
  });
  await expectPixel(result.ctx, x + 12, y + 12, WHITE);
  assert.strictEqual(
    el.elementAtPoint(x + 12, y + 4),
    findById(el.document, 'i'),
  );
});

metric(
  'what a transformed box holds is painted through its matrix',
  async () => {
    // a stacking context and a containing block: the absolute box in it is
    // placed against it, and turned with it
    const { result, node } = await render(
      PAGE +
        '<div id="p" style="margin:40px;width:40px;height:20px;' +
        'background:#ff0000;transform:rotate(90deg)">' +
        '<div id="c" style="position:absolute;left:0;top:0;width:10px;' +
        'height:10px;background:#0000ff"></div></div>',
    );
    await act();
    const el = view(node);
    const c = boxOf(el, 'c');
    assert.deepStrictEqual([c.x, c.y], [40, 40], 'against the turned box');
    // the box: 20 by 40 about (60, 50); its top left corner turned is its
    // top right
    await expectPixel(result.ctx, 65, 35, BLUE);
    await expectPixel(result.ctx, 55, 35, RED);
    await expectPixel(result.ctx, 55, 65, RED);
    await expectPixel(result.ctx, 45, 45, WHITE, { message: 'where it was' });
    assert.strictEqual(el.elementAtPoint(65, 35), findById(el.document, 'c'));
    assert.strictEqual(el.elementAtPoint(55, 35), findById(el.document, 'p'));
    assert.deepStrictEqual(el.elementRect(findById(el.document, 'c')!), {
      x: 60,
      y: 30,
      width: 10,
      height: 10,
    });
  },
);

/** The rectangle around the pixels of a window region that are darker than
 *  `below` in every channel. */
async function inkIn(
  ctx: unknown,
  region: Region,
  below = 96,
): Promise<{ width: number; height: number; count: number }> {
  const { width, height } = region;
  const data = await pixelsIn(ctx, region);
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  let count = 0;
  for (let i = 0; i < width * height; i += 1) {
    if (data[i * 4] >= below || data[i * 4 + 1] >= below) continue;
    if (data[i * 4 + 2] >= below) continue;
    count += 1;
    x1 = Math.min(x1, i % width);
    x2 = Math.max(x2, i % width);
    y1 = Math.min(y1, Math.floor(i / width));
    y2 = Math.max(y2, Math.floor(i / width));
  }
  return count
    ? { width: x2 - x1 + 1, height: y2 - y1 + 1, count }
    : { width: 0, height: 0, count };
}

metric(
  'a box drawn on a surface through its matrix is faded as the group it is',
  async () => {
    // A context that draws a turned box holding a gradient on a surface of
    // its own (`paintRaster`) — X11's, and the in-process server's — fades
    // the surface as it draws it: the red over the box's own blue shows no
    // blue through it (CSS Color 4, 3.2), where each thing drawn faded on
    // its own showed the one under it
    const { result } = await render(
      PAGE +
        '<div style="margin:20px;width:40px;height:40px;padding:10px;' +
        'background:#0000ff;opacity:.5;transform:rotate(180deg)">' +
        '<div style="height:40px;background:linear-gradient(#ff0000,#ff0000)">' +
        '</div></div>',
    );
    await act();
    await expectPixel(result.ctx, 50, 50, [255, 128, 128], {
      tolerance: 2,
      message: 'the red, half over the page',
    });
    await expectPixel(result.ctx, 24, 24, [128, 128, 255], {
      tolerance: 2,
      message: 'the blue around it, half over the page',
    });
  },
);

metric(
  'a box drawn through its matrix by the context is faded as the group it is',
  async () => {
    // paths and flat colour, which the context draws through the matrix
    // itself (`drawnAsPaths`), as the native contexts draw every box: drawn
    // so onto a surface where it lands, and the surface faded
    const { result } = await render(
      PAGE +
        '<div style="margin:20px;width:40px;height:40px;padding:10px;' +
        'background:#0000ff;opacity:.5;transform:rotate(180deg)">' +
        '<div style="height:40px;background:#ff0000"></div></div>',
    );
    await act();
    await expectPixel(result.ctx, 50, 50, [255, 128, 128], {
      tolerance: 2,
      message: 'the red, half over the page',
    });
    await expectPixel(result.ctx, 24, 24, [128, 128, 255], {
      tolerance: 2,
      message: 'the blue around it, half over the page',
    });
  },
);

metric('the text of a turned box is turned with it', async () => {
  // A context that draws glyphs as they were shaped puts each where the
  // matrix puts its origin, upright: the box is drawn on a surface of its
  // own there, and the surface through the matrix. An `l` is a stroke far
  // taller than it is wide, and on its side one far wider than it is tall.
  const page = (turn: string) =>
    PAGE +
    '<div id="t" style="margin:40px 0 0 40px;width:60px;height:60px;' +
    `font:48px/60px sans-serif;color:#000000;${turn}">l</div>`;
  const region = { x: 40, y: 40, width: 60, height: 60 };
  const upright = await render(page(''));
  await act();
  const stroke = await inkIn(upright.result.ctx, region);
  assert.ok(stroke.height > stroke.width * 3, `${JSON.stringify(stroke)}`);
  cleanup();
  const turned = await render(page('transform:rotate(90deg)'));
  await act();
  const side = await inkIn(turned.result.ctx, region);
  assert.ok(side.count > 0, 'the text is drawn');
  assert.ok(side.width > side.height * 3, `${JSON.stringify(side)}`);
  assert.ok(
    Math.abs(side.width - stroke.height) <= 2,
    `as long as it was tall: ${side.width} for ${stroke.height}`,
  );
});

metric(
  'a box scaled to nothing is not drawn, and not under the pointer',
  async () => {
    const { result, node } = await render(
      PAGE +
        '<div id="z" style="width:40px;height:40px;background:#ff0000;' +
        'transform:scale(0)"></div>',
    );
    await act();
    const el = view(node);
    await expectPixel(result.ctx, 20, 20, WHITE);
    assert.notStrictEqual(
      el.elementAtPoint(20, 20),
      findById(el.document, 'z'),
    );
    const box = boxOf(el, 'z') as Styled;
    assert.strictEqual(box.boundsWidth, 0, 'no ink');
  },
);

metric(
  'a box a fraction of a pixel down the page is turned about the pixel it is drawn from',
  async () => {
    // What is painted is snapped to the pixel grid a box at a time, and a
    // transform about where the box was laid out took it back off the grid:
    // a square mirrored onto itself showed a line of what was under it
    // along each side (WPT's transform-matrix-009). Its corner is snapped
    // before its transform, as a browser snaps it.
    const { result, node } = await render(
      PAGE +
        '<div style="height:10.4px"></div>' +
        '<div style="margin-left:20px;width:40px;height:40px;' +
        'background:#ff0000"><div id="m" style="width:40px;height:40px;' +
        'background:#0000ff;transform:matrix(0, 1, 1, 0, 0, 0)"></div></div>',
    );
    await act();
    const box = boxOf(view(node), 'm');
    assert.ok(box.y % 1 !== 0 && box.x % 1 === 0, `${box.x}, ${box.y}`);
    const region = { x: 10, y: 0, width: 60, height: 60 };
    const data = await pixelsIn(result.ctx, region);
    let blue = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r === 0 && g === 0 && b === 255) blue += 1;
      else {
        const at = `${10 + ((i / 4) % 60)}, ${Math.floor(i / 4 / 60)}`;
        assert.ok(
          r === 255 && g === 255 && b === 255,
          `${r},${g},${b} at ${at}`,
        );
      }
    }
    assert.strictEqual(blue, 40 * 40, 'the square, whole, on the grid');
  },
);

metric(
  'a large picture drawn small in a turned box far across a wide window is drawn',
  async () => {
    // ntk draws an image under a matrix through a transform the server
    // holds in 16.16 fixed point, in the window's coordinates: a picture at
    // a fortieth of its size 2,200 pixels across did not fit, the request
    // threw out of the paint, and the document was left blank. A box that
    // is more than paths is painted on a surface of its own as it was laid
    // out, and the surface through the matrix.
    const { result, el } = await renderWithBytes(
      PAGE +
        '<p id="p" style="margin:0">some text</p>' +
        '<img id="i" src="big.png" style="position:absolute;left:2200px;' +
        'top:40px;width:50px;height:30px;transform:rotate(90deg)">',
      { 'big.png': solidPng(2000, 1200, [0, 0, 255]) },
      2400,
    );
    // 30 by 50 about (2225, 55)
    await waitFor(() => expectPixel(result.ctx, 2225, 33, BLUE), {
      timeout: 5000,
    });
    await expectPixel(result.ctx, 2225, 77, BLUE);
    await expectPixel(result.ctx, 2204, 55, WHITE, { message: 'where it was' });
    await expectPixel(result.ctx, 2246, 55, WHITE);
    assert.deepStrictEqual(el.elementRect(findById(el.document, 'i')!), {
      x: 2210,
      y: 30,
      width: 30,
      height: 50,
    });
    // and the document with it
    const ink = await inkIn(result.ctx, { x: 0, y: 0, width: 100, height: 20 });
    assert.ok(ink.count > 0, 'the text is drawn');
  },
);

test('a widget in a box scaled to nothing is not mounted', async () => {
  const { node } = await render(
    '<div style="transform:scale(0)"><input id="closed"></div>' +
      '<div style="transform:scale(0.5)"><input id="small"></div>' +
      '<input id="plain">',
  );
  const ids = (
    view(node) as unknown as {
      _controls: { element: { attribs: Record<string, string> } }[];
    }
  )._controls.map((r) => r.element.attribs.id);
  assert.deepStrictEqual(ids, ['small', 'plain']);
});

test('on the mock backend a transformed document is laid out and asked, and paints nothing', async () => {
  // no path API and no surface there: paint is a structural no-op, and
  // the geometry is what it is anywhere
  await renderX11(
    h(
      'box',
      { style: { width: 300, flexDirection: 'column' } },
      h(Html, {
        source:
          '<style>body{margin:0}</style>' +
          '<div id="r" style="margin:10px 0 0 30px;width:20px;height:10px;' +
          'transform:rotate(90deg)"><b>x</b></div>',
        partial: false,
        'data-testname': 'doc',
      }),
    ),
    { backend: 'mock' },
  );
  await act();
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const r = findById(el.document, 'r')!;
  assert.deepStrictEqual(el.elementRect(r), {
    x: 35,
    y: 5,
    width: 10,
    height: 20,
  });
  const { abs } = el as unknown as DrawnNode;
  assert.notStrictEqual(el.elementAtPoint(abs.x + 40, abs.y + 7), null);
  assert.notStrictEqual(
    el.elementAtPoint(abs.x + 32, abs.y + 15),
    r,
    'not where it was laid out',
  );
});

test('a transformed box is under the pointer over the block after it', async () => {
  // it is painted with the positioned boxes, after the flow, whether or
  // not it is positioned: where a box scaled up covers the block after it,
  // the point is the scaled box's, and taken as a block of the flow it was
  // the later block's
  const { node } = await render(
    '<style>body{margin:0}div{width:40px;height:20px}</style>' +
      '<div id="a" style="transform:scale(2);transform-origin:0 0"></div>' +
      '<div id="b"></div>',
  );
  const el = view(node);
  const { abs } = el as unknown as DrawnNode;
  const at = (x: number, y: number) => el.elementAtPoint(abs.x + x, abs.y + y);
  assert.strictEqual(at(10, 30), findById(el.document, 'a'), 'over the next');
  assert.strictEqual(at(10, 10), findById(el.document, 'a'));
  assert.notStrictEqual(at(10, 45), findById(el.document, 'a'), 'past it');
});

test('a context with no transform draws a turned box where it was laid out', async () => {
  // the recorder has `save`, `restore` and fills, and no matrix: nothing
  // throws, and the box is drawn as it was laid out
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:20px;height:10px;background:#ff0000;' +
      'transform:rotate(90deg)"></div>',
  );
  const fills = (await fillsOf(view(node))).filter((f) => f.style === RED);
  assert.deepStrictEqual(
    fills.map((f) => [f.x, f.y, f.w, f.h]),
    [[0, 0, 20, 10]],
  );
});

test('a box drawn through its matrix casts its blurred shadow where it is drawn', async () => {
  // A context takes a shadow's offset and blur in the window's
  // coordinates, whatever matrix it draws through, and the shape a shadow
  // is cast from is drawn clear of the window with the shadow offset back.
  // The shape was moved in the box's coordinates and the shadow offset
  // back by as much in the window's: a card at scale(1.01) — the Zen
  // Garden's design list, hovered — cast its glow 20px left of itself on a
  // 2x display, where every box is drawn through its matrix.
  for (const [transform, scale] of [
    ['scale(2)', 2],
    ['scale(1.01)', 1.01],
    ['rotate(90deg)', 1],
    ['rotate(30deg) scale(1.5)', 1.5],
    ['scale(2, 0.5)', 1],
  ] as const) {
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="margin:200px 0 0 300px;width:100px;height:40px;' +
        `background:#ffffff;box-shadow:0 0 10px #0d0d0d;transform:${transform}">` +
        '</div>',
    );
    const shadow = (await fillsOf(view(node))).find((f) => f.shadow);
    assert.ok(shadow?.matrix, `${transform}: a shadowed fill through a matrix`);
    const m = shadow.matrix as unknown as Matrix;
    const s = shadow.shadow!;
    // where the box's corner is drawn, and where the shadow of the shape's
    // corner lands
    const [bx, by] = mapPoint(m, 300, 200);
    const [sx, sy] = mapPoint(m, shadow.x, shadow.y);
    assert.ok(
      Math.abs(sx + s.x - bx) < 1e-6 && Math.abs(sy + s.y - by) < 1e-6,
      `${transform}: lands at ${[sx + s.x, sy + s.y]}, drawn at ${[bx, by]}`,
    );
    assert.ok(
      Math.abs(s.blur - 10 * scale) < 1e-9,
      `${transform}: blurred as the box is scaled, ${s.blur}`,
    );
    const drawn = mapRect(m, shadow.x, shadow.y, shadow.w, shadow.h);
    assert.ok(
      drawn.x + drawn.width < 0,
      `${transform}: the shape itself is clear of the window`,
    );
  }
});

test('a box drawn through its matrix casts its text shadow where its text is drawn', async () => {
  const { node } = await render(
    '<style>body{margin:0}p{margin:0;font-size:20px}</style>' +
      '<p id="t" style="margin:100px 0 0 200px;width:80px;transform:rotate(30deg) ' +
      'scale(2);text-shadow:3px 4px 2px #ff0000">Title</p>',
  );
  const el = view(node);
  const ops: PaintOp[] = [];
  await fillsOf(el, ops);
  const texts = ops.filter(
    (op): op is Extract<PaintOp, { op: 'text' }> => op.op === 'text',
  );
  const cast = texts.find((op) => op.shadow);
  const text = texts.find((op) => !op.shadow);
  assert.ok(cast?.matrix && text?.matrix, 'both drawn through the matrix');
  const m = cast.matrix as unknown as Matrix;
  const s = cast.shadow!;
  // the shadow's own offset is the box's, turned and scaled with it
  const [tx, ty] = mapPoint(m, text.x + 3, text.y + 4);
  const [cx, cy] = mapPoint(m, cast.x, cast.y);
  assert.ok(
    Math.abs(cx + s.x - tx) < 1e-6 && Math.abs(cy + s.y - ty) < 1e-6,
    `lands at ${[cx + s.x, cy + s.y]}, cast to ${[tx, ty]}`,
  );
  assert.ok(Math.abs(s.blur - 4) < 1e-9, `blurred twice as much: ${s.blur}`);
  const [line] = linesOf(el, 't');
  const right =
    cast.x + Math.max(...line.texts[0].layout.lines.map((l) => l.x + l.width));
  assert.ok(mapPoint(m, right, cast.y)[0] < 0, 'the glyphs clear of it');
});

metric(
  'a transform is drawn in device pixels at 2x, wherever the element is',
  async () => {
    // the element is 20 logical pixels in from the window's corner, so its
    // origin is no part of the matrix twice, and a `matrix()`'s translation
    // is CSS pixels
    const { result, node } = await render2x(
      PAGE +
        '<div style="height:10px"></div>' +
        '<div id="r" style="margin-left:30px;width:20px;height:10px;' +
        'background:#ff0000;transform:rotate(90deg)"></div>' +
        '<div id="m" style="width:10px;height:10px;background:#0000ff;' +
        'transform:matrix(0, 1, -1, 0, 100, 20)"></div>',
    );
    await act();
    const el = view(node);
    const { abs } = el as unknown as DrawnNode;
    const r = boxOf(el, 'r');
    assert.deepStrictEqual([r.x, r.y, r.width, r.height], [60, 20, 40, 20]);
    // drawn 20 by 40 about (80, 30), in the document's device pixels
    const at = (x: number, y: number) =>
      pixelAt(result.ctx, abs.x + x, abs.y + y);
    assert.deepStrictEqual(await at(72, 12), [255, 0, 0], 'turned, at the top');
    assert.deepStrictEqual(await at(88, 48), [255, 0, 0], 'and at the bottom');
    assert.deepStrictEqual(
      await at(62, 30),
      [255, 255, 255],
      'not where it was',
    );
    assert.deepStrictEqual(await at(98, 30), [255, 255, 255]);
    // the pointer is in logical pixels
    assert.strictEqual(
      el.elementAtPoint((abs.x + 80) / 2, (abs.y + 14) / 2),
      findById(el.document, 'r'),
    );
    assert.deepStrictEqual(el.elementRect(findById(el.document, 'r')!), {
      x: 35,
      y: 5,
      width: 10,
      height: 20,
    });
    const m = boxOf(el, 'm');
    assert.deepStrictEqual(
      [m.x, m.y],
      [200, 80],
      'a hundred across, twenty down',
    );
    assert.deepStrictEqual(await at(210, 90), [0, 0, 255]);
  },
);

/** Where CSS Transforms 2 puts a point of the plane turned `deg` about the
 *  upright through `o` — the transform's origin, its depth `o.z` — and then
 *  scaled `depth` times in depth about it, and seen from `d` in front of
 *  `p`: worked out here as the spec has it, to hold the projection to. */
function seen(
  x: number,
  y: number,
  o: { x: number; y: number; z?: number },
  deg: number,
  d: number | null,
  p: { x: number; y: number },
  depth = 1,
): [number, number] {
  const t = (deg * Math.PI) / 180;
  const oz = o.z ?? 0;
  const X = x - o.x;
  const Z = -oz;
  const wx = o.x + X * Math.cos(t) + Z * Math.sin(t);
  const wz = oz + depth * (-X * Math.sin(t) + Z * Math.cos(t));
  const w = d === null ? 1 : 1 - wz / d;
  return [p.x + (wx - p.x) / w, p.y + (y - p.y) / w];
}

/** The rectangle around a box's four corners where `at` puts them. */
function around(
  box: { x: number; y: number; width: number; height: number },
  at: (x: number, y: number) => [number, number],
) {
  const corners = [
    at(box.x, box.y),
    at(box.x + box.width, box.y),
    at(box.x, box.y + box.height),
    at(box.x + box.width, box.y + box.height),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}

const closeRect = (
  got: { x: number; y: number; width: number; height: number } | null,
  want: { x: number; y: number; width: number; height: number },
  message: string,
) =>
  assert.ok(
    got &&
      Math.abs(got.x - want.x) < 1e-6 &&
      Math.abs(got.y - want.y) < 1e-6 &&
      Math.abs(got.width - want.width) < 1e-6 &&
      Math.abs(got.height - want.height) < 1e-6,
    `${message}: ${JSON.stringify(got)} for ${JSON.stringify(want)}`,
  );

metric(
  'a box turned out of the plane in the perspective of the box it is laid out in is drawn smaller where it turns away, and is under the pointer there',
  async () => {
    // the Zen Garden's 219 at a third of the size: a panel turned about its
    // upright in a box with a perspective
    const { result, node } = await render(
      PAGE +
        '<style>#s{position:relative;width:400px;height:400px;' +
        'perspective:500px}#w{position:absolute;left:50px;top:100px;' +
        'width:300px;height:200px;background:#ff0000;' +
        'transform:rotateY(40deg)}</style>' +
        '<div id="s"><div id="w"></div></div>',
    );
    await act();
    const el = view(node);
    const w = findById(el.document, 'w')!;
    const at = (x: number, y: number) =>
      seen(x, y, { x: 200, y: 200 }, 40, 500, { x: 200, y: 200 });
    const want = around({ x: 50, y: 100, width: 300, height: 200 }, at);
    // the side that turns away is drawn shorter: it is the left that comes
    // near, and taller than the box is
    assert.ok(want.height > 200 && want.width < 300, JSON.stringify(want));
    closeRect(el.elementRect(w), want, 'where it is drawn');
    // drawn there: above the box at its near side, and short of where it
    // was laid out at its far one
    await expectPixel(result.ctx, 60, 80, RED, { message: 'near corner' });
    await expectPixel(result.ctx, 60, 320, RED, { message: 'near, below' });
    await expectPixel(result.ctx, 290, 120, RED, { message: 'far corner' });
    await expectPixel(result.ctx, 290, 110, WHITE, { message: 'above it' });
    await expectPixel(result.ctx, 330, 200, WHITE, { message: 'where it was' });
    // and the pointer finds it where it is drawn
    assert.strictEqual(el.elementAtPoint(60, 80), w, 'over its near corner');
    assert.strictEqual(el.elementAtPoint(290, 120), w, 'over its far corner');
    assert.notStrictEqual(el.elementAtPoint(330, 200), w, 'where it was');
    assert.notStrictEqual(el.elementAtPoint(290, 110), w, 'above it');
  },
);

metric(
  "the tiles a box in perspective is drawn in are drawn at 'low' smoothing where the context has the setting, as a layer in perspective is, and the context has its own back after",
  async () => {
    const { node } = await render(
      PAGE +
        '<style>#s{position:relative;width:400px;height:400px;' +
        'perspective:500px}#w{position:absolute;left:50px;top:100px;' +
        'width:300px;height:200px;background:#ff0000;' +
        'transform:rotateY(40deg)}</style>' +
        '<div id="s"><div id="w"></div></div>',
    );
    await act();
    const el = view(node);
    // a context that resamples at the quality it holds, as the native
    // contexts do, and draws nothing
    let quality: string = 'medium';
    const saved: string[] = [];
    const drawn: string[] = [];
    const own = {
      get imageSmoothingQuality() {
        return quality;
      },
      set imageSmoothingQuality(value: string) {
        quality = value;
      },
      save() {
        saved.push(quality);
      },
      restore() {
        quality = saved.pop() ?? quality;
      },
      drawImage() {
        drawn.push(quality);
      },
    };
    const ctx = new Proxy(own, {
      get: (target, key) =>
        key in target ? Reflect.get(target, key) : () => undefined,
    });
    el.paint(ctx as never);
    assert.ok(drawn.length > 1, `${drawn.length} tiles`);
    assert.ok(
      drawn.every((q) => q === 'low'),
      [...new Set(drawn)].join(),
    );
    assert.strictEqual(quality, 'medium', 'its own back');
  },
);

/** A context that records how a box in perspective reaches it: tiles, each a
 *  `drawImage`, or one `drawImageProjected` answering `projects`. */
function projectingContext(projects: boolean) {
  const tiles: unknown[] = [];
  const projected: { image: { width: number; height: number }; m: number[] }[] =
    [];
  const own = {
    drawImage(image: unknown) {
      tiles.push(image);
    },
    drawImageProjected(image: { width: number; height: number }, m: number[]) {
      projected.push({ image, m: [...m] });
      return projects;
    },
  };
  const ctx = new Proxy(own, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : () => undefined,
  });
  return { ctx, tiles, projected };
}

metric(
  'a box in perspective is one projected draw where the context has one, its surface placed where the box is drawn, and no tiles',
  async () => {
    const { node } = await render(
      PAGE +
        '<style>#s{position:relative;width:400px;height:400px;' +
        'perspective:500px}#w{position:absolute;left:50px;top:100px;' +
        'width:300px;height:200px;background:#ff0000;' +
        'transform:rotateY(40deg)}</style>' +
        '<div id="s"><div id="w"></div></div>',
    );
    await act();
    const el = view(node);
    const { ctx, tiles, projected } = projectingContext(true);
    el.paint(ctx as never);
    assert.strictEqual(projected.length, 1, 'one draw');
    assert.strictEqual(tiles.length, 0, 'and no tiles');
    // the surface's corners land on the corners of where the box is drawn
    const { image, m } = projected[0];
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [u, v] of [
      [0, 0],
      [image.width, 0],
      [image.width, image.height],
      [0, image.height],
    ]) {
      const w = m[6] * u + m[7] * v + m[8];
      assert.ok(w > 0, 'in front of the viewer');
      xs.push((m[0] * u + m[1] * v + m[2]) / w);
      ys.push((m[3] * u + m[4] * v + m[5]) / w);
    }
    const want = el.elementRect(findById(el.document, 'w')!)!;
    // the surface is the box's ink to the whole pixel round it
    assert.ok(Math.abs(Math.min(...xs) - want.x) <= 1.5, `left ${xs}`);
    assert.ok(Math.abs(Math.min(...ys) - want.y) <= 1.5, `top ${ys}`);
    assert.ok(
      Math.abs(Math.max(...xs) - (want.x + want.width)) <= 1.5,
      `right ${xs}`,
    );
    assert.ok(
      Math.abs(Math.max(...ys) - (want.y + want.height)) <= 1.5,
      `bottom ${ys}`,
    );
  },
);

metric(
  'a box in perspective is drawn in tiles where the context declines the projected draw, as for a corner behind the viewer',
  async () => {
    const { node } = await render(
      PAGE +
        '<style>#s{position:relative;width:400px;height:400px;' +
        'perspective:500px}#w{position:absolute;left:50px;top:100px;' +
        'width:300px;height:200px;background:#ff0000;' +
        'transform:rotateY(40deg)}</style>' +
        '<div id="s"><div id="w"></div></div>',
    );
    await act();
    const el = view(node);
    const { ctx, tiles, projected } = projectingContext(false);
    el.paint(ctx as never);
    assert.strictEqual(projected.length, 1, 'asked once');
    assert.ok(tiles.length > 1, `then ${tiles.length} tiles`);
  },
);

metric(
  "a box's perspective is the nearest up its containing blocks, through a positioned box and not through one with a transform, from its perspective-origin; and transform-origin's depth is the turn's",
  async () => {
    const { node } = await render(
      PAGE +
        '<style>.s{position:relative;width:300px;height:150px;' +
        'perspective:300px}.r{position:relative;height:150px}' +
        '.t{position:relative;height:150px;transform:translateX(0)}' +
        '.w{position:absolute;left:50px;top:25px;width:200px;height:100px;' +
        'background:#ff0000;transform:rotateY(40deg)}</style>' +
        '<div class="s"><div class="w" id="a"></div></div>' +
        '<div class="s"><div class="r"><div class="w" id="b"></div></div></div>' +
        '<div class="s"><div class="t"><div class="w" id="c"></div></div></div>' +
        '<div class="s" style="perspective-origin:right center">' +
        '<div class="w" id="d"></div></div>' +
        '<div class="s" style="perspective:none">' +
        '<div class="w" id="e" style="transform:perspective(300px) ' +
        'rotateY(40deg)"></div></div>',
    );
    const el = view(node);
    const rect = (id: string) => el.elementRect(findById(el.document, id)!);
    const box = (top: number) => ({
      x: 50,
      y: top + 25,
      width: 200,
      height: 100,
    });
    const turned = (top: number, d: number | null, px = 150, oz = 0) =>
      around(box(top), (x, y) =>
        seen(x, y, { x: 150, y: top + 75, z: oz }, 40, d, {
          x: px,
          y: top + 75,
        }),
      );
    closeRect(rect('a'), turned(0, 300), 'in its parent’s perspective');
    closeRect(rect('b'), turned(150, 300), 'through a positioned box');
    // flattened into the plane of the box with a transform: as wide as it
    // turns to, and as tall as it is
    closeRect(rect('c'), turned(300, null), 'not through a transform');
    assert.ok(Math.abs(rect('c')!.height - 100) < 1e-9);
    closeRect(rect('d'), turned(450, 300, 300), 'seen from the right');
    // a perspective of its own, from its origin, which is the middle of the
    // box a perspective around it would be seen from
    closeRect(rect('e'), turned(600, 300), 'its own perspective()');
  },
);

metric(
  'a box moved toward the viewer is drawn larger about the perspective origin, and one moved behind the viewer is not drawn',
  async () => {
    const { result, node } = await render(
      PAGE +
        '<style>.s{position:relative;width:300px;height:150px;' +
        'perspective:300px}.w{position:absolute;left:50px;top:25px;' +
        'width:200px;height:100px;background:#ff0000}</style>' +
        '<div class="s"><div class="w" id="a" style="transform:translateZ(100px)">' +
        '</div></div>' +
        '<div class="s"><div class="w" id="b" style="transform:translateZ(400px)">' +
        '</div></div>' +
        '<div class="s"><div class="w" id="c" ' +
        'style="transform-origin:50% 50% -100px;transform:rotateY(40deg)">' +
        '</div></div>',
    );
    await act();
    const el = view(node);
    const a = findById(el.document, 'a')!;
    const b = findById(el.document, 'b')!;
    // a third of the way to the viewer: half as large again, about the
    // middle of the box it is in
    closeRect(
      el.elementRect(a),
      { x: 0, y: 0, width: 300, height: 150 },
      'nearer',
    );
    await expectPixel(result.ctx, 4, 4, RED, { message: 'drawn larger' });
    assert.strictEqual(el.elementAtPoint(4, 4), a);
    // past the viewer: none of it is in front
    await expectPixel(result.ctx, 150, 225, WHITE, { message: 'behind' });
    assert.notStrictEqual(el.elementAtPoint(150, 225), b);
    // turned about a point behind its plane, it swings away as it turns
    closeRect(
      el.elementRect(findById(el.document, 'c')!),
      around({ x: 50, y: 325, width: 200, height: 100 }, (x, y) =>
        seen(x, y, { x: 150, y: 375, z: -100 }, 40, 300, { x: 150, y: 375 }),
      ),
      'about its origin’s depth',
    );
  },
);

metric(
  'at a display scale of 2 a box turned out of the plane is where it is at 1',
  async () => {
    const source =
      PAGE +
      '<style>#s{position:relative;width:300px;height:150px;' +
      'perspective:300px}#w{position:absolute;left:50px;top:25px;' +
      'width:200px;height:100px;background:#ff0000;' +
      'transform:rotateY(40deg)}</style>' +
      '<div id="s"><div id="w"></div></div>';
    const { result, node } = await render2x(source);
    await act();
    const el = view(node);
    const w = findById(el.document, 'w')!;
    const want = around({ x: 50, y: 25, width: 200, height: 100 }, (x, y) =>
      seen(x, y, { x: 150, y: 75 }, 40, 300, { x: 150, y: 75 }),
    );
    closeRect(el.elementRect(w), want, 'in logical pixels');
    // the document is 20 pixels in, and the window's pixels are two a pixel
    const { abs } = el as unknown as DrawnNode;
    const near = { x: want.x + 3, y: want.y + 8 };
    assert.strictEqual(el.elementAtPoint(20 + near.x, 20 + near.y), w);
    await expectPixel(result.ctx, abs.x + 2 * near.x, abs.y + 2 * near.y, RED);
    const flat = { x: 245, y: 75 };
    assert.notStrictEqual(el.elementAtPoint(20 + flat.x, 20 + flat.y), w);
    await expectPixel(
      result.ctx,
      abs.x + 2 * flat.x,
      abs.y + 2 * flat.y,
      WHITE,
    );
  },
);

metric(
  "a card's back face turned away from the viewer is not drawn under backface-visibility: hidden, and is drawn mirrored where it is visible",
  async () => {
    // a card that flips: its back is turned half round behind its front
    const { result, node } = await render(
      PAGE +
        '<style>.card{position:relative;width:100px;height:60px;' +
        'margin-bottom:20px;perspective:400px}.card div{position:absolute;' +
        'inset:0}.front{background:#ff0000}.back{background:#0000ff;' +
        'transform:rotateY(180deg)}.hidden .back{backface-visibility:hidden}' +
        '</style>' +
        '<div class="card hidden"><div class="front"></div>' +
        '<div class="back" id="a"></div></div>' +
        '<div class="card"><div class="front"></div>' +
        '<div class="back" id="b"></div></div>',
    );
    await act();
    const el = view(node);
    await expectPixel(result.ctx, 50, 30, RED, { message: 'its front' });
    assert.notStrictEqual(
      el.elementAtPoint(50, 30),
      findById(el.document, 'a'),
    );
    await expectPixel(result.ctx, 50, 110, BLUE, { message: 'its back' });
    assert.strictEqual(el.elementAtPoint(50, 110), findById(el.document, 'b'));
  },
);

/** Boxes of 200 by 100 at (50, 25) in boxes of 300 by 150 with a
 *  perspective of 300px, one under the other, each holding the one whose
 *  style is given. */
const IN_PERSPECTIVE =
  PAGE +
  '<style>.s{position:relative;width:300px;height:150px;' +
  'perspective:300px}.w{position:absolute;left:50px;top:25px;' +
  'width:200px;height:100px;background:#ff0000}</style>';

metric(
  'rotate turns a box about an axis in the page as the function does, in the perspective of the box it is laid out in; and turned half round under backface-visibility: hidden it is not drawn',
  async () => {
    const { result, node } = await render(
      IN_PERSPECTIVE +
        '<div class="s"><div class="w" id="a" style="rotate:y 40deg"></div>' +
        '</div><div class="s"><div class="w" id="b" style="rotate:0 2 0 40deg">' +
        '</div></div><div class="s"><div class="w"></div>' +
        '<div class="w" id="e" style="background:#0000ff;rotate:y 180deg;' +
        'backface-visibility:hidden"></div></div>' +
        '<div class="s"><div class="w" id="c" style="rotate:1 1 0 30deg">' +
        '</div></div><div class="s"><div class="w" id="d" ' +
        'style="transform:rotate3d(1, 1, 0, 30deg)"></div></div>',
    );
    await act();
    const el = view(node);
    const rect = (id: string) => el.elementRect(findById(el.document, id)!);
    const turned = (top: number) =>
      around({ x: 50, y: top + 25, width: 200, height: 100 }, (x, y) =>
        seen(x, y, { x: 150, y: top + 75 }, 40, 300, { x: 150, y: top + 75 }),
      );
    closeRect(rect('a'), turned(0), 'about the upright');
    closeRect(rect('b'), turned(150), 'about a vector of any length');
    // drawn there: above the box at its near side, and short of where it
    // was laid out at its far one
    await expectPixel(result.ctx, 60, 15, RED, { message: 'near side' });
    await expectPixel(result.ctx, 205, 40, RED, { message: 'far side' });
    await expectPixel(result.ctx, 205, 26, WHITE, { message: 'above it' });
    await expectPixel(result.ctx, 230, 75, WHITE, { message: 'where it was' });
    assert.strictEqual(el.elementAtPoint(60, 15), findById(el.document, 'a'));
    // its back to the viewer, the box under it shows
    await expectPixel(result.ctx, 150, 375, RED, { message: 'its back' });
    assert.notStrictEqual(
      el.elementAtPoint(150, 375),
      findById(el.document, 'e'),
    );
    // and about any axis as rotate3d() turns about it
    const c = rect('c')!;
    closeRect(rect('d'), { ...c, y: c.y + 150 }, 'as rotate3d()');
  },
);

metric(
  'translate with a depth moves a box toward the viewer: drawn larger about the perspective origin, from where its move across lays it out, and not drawn past the viewer',
  async () => {
    const { result, node } = await render(
      IN_PERSPECTIVE +
        '<div class="s"><div class="w" id="a" style="translate:0 0 100px">' +
        '</div></div><div class="s" style="perspective-origin:0 0">' +
        '<div class="w" id="b" style="translate:0 0 100px"></div></div>' +
        '<div class="s"><div class="w" id="c" style="translate:30px 0 100px">' +
        '</div></div><div class="s"><div class="w" id="d" ' +
        'style="translate:0 0 400px"></div></div>',
    );
    await act();
    const el = view(node);
    const rect = (id: string) => el.elementRect(findById(el.document, id)!);
    // a third of the way to the viewer: half as large again, about the
    // middle of the box it is in, as translateZ(100px) is
    closeRect(rect('a'), { x: 0, y: 0, width: 300, height: 150 }, 'nearer');
    await expectPixel(result.ctx, 4, 4, RED, { message: 'drawn larger' });
    assert.strictEqual(el.elementAtPoint(4, 4), findById(el.document, 'a'));
    // and about the corner where the viewer is in front of that
    closeRect(
      rect('b'),
      { x: 75, y: 187.5, width: 300, height: 150 },
      'about the corner',
    );
    // laid out where its move across puts it, and drawn nearer from there
    assert.strictEqual(boxOf(el, 'c').x, 80);
    closeRect(
      rect('c'),
      { x: 45, y: 300, width: 300, height: 150 },
      'moved across first',
    );
    // past the viewer: none of it is in front
    await expectPixel(result.ctx, 150, 525, WHITE, { message: 'behind' });
    assert.notStrictEqual(
      el.elementAtPoint(150, 525),
      findById(el.document, 'd'),
    );
  },
);

metric(
  'scale with a depth deepens what a turn in the list takes out of the plane, and is nothing to the flat box rotate turns after it',
  async () => {
    const { result, node } = await render(
      IN_PERSPECTIVE +
        '<div class="s"><div class="w" id="a" ' +
        'style="scale:1 1 2;transform:rotateY(40deg)"></div></div>' +
        '<div class="s"><div class="w" id="b" style="scale:1 1 2;' +
        'rotate:y 40deg"></div></div>',
    );
    await act();
    const el = view(node);
    const rect = (id: string) => el.elementRect(findById(el.document, id)!);
    const turned = (top: number, depth: number) =>
      around({ x: 50, y: top + 25, width: 200, height: 100 }, (x, y) =>
        seen(
          x,
          y,
          { x: 150, y: top + 75 },
          40,
          300,
          { x: 150, y: top + 75 },
          depth,
        ),
      );
    // the list turns the box, and the scale then puts each side of it
    // twice as far from the plane: the near one nearer, and drawn larger
    closeRect(rect('a'), turned(0, 2), 'turned, then deepened');
    await expectPixel(result.ctx, 25, 5, RED, { message: 'twice as near' });
    // `rotate` turns it after the scale, which found it flat
    closeRect(rect('b'), turned(150, 1), 'deepened, then turned');
  },
);

metric(
  'translate, rotate and scale are one transform before the list, in that order, each with its depth',
  async () => {
    const { node } = await render(
      IN_PERSPECTIVE +
        '<div class="s"><div class="w" id="a" style="translate:20px 10% 50px;' +
        'rotate:y 40deg;scale:0.8 1 2;transform:translateZ(30px) ' +
        'rotateX(20deg)"></div></div>' +
        '<div class="s"><div class="w" id="b" style="transform:' +
        'translate3d(20px, 10%, 50px) rotateY(40deg) scale3d(0.8, 1, 2) ' +
        'translateZ(30px) rotateX(20deg)"></div></div>',
    );
    const el = view(node);
    const a = boxOf(el, 'a');
    const b = boxOf(el, 'b');
    assert.deepStrictEqual([a.x, a.y + 150], [b.x, b.y], 'moved as the list');
    const drawn = el.elementRect(findById(el.document, 'a')!)!;
    closeRect(
      el.elementRect(findById(el.document, 'b')!),
      { ...drawn, y: drawn.y + 150 },
      'drawn as the list',
    );
  },
);

metric(
  "at a display scale of 2 translate's depth is where it is at 1",
  async () => {
    const { result, node } = await render2x(
      IN_PERSPECTIVE +
        '<div class="s"><div class="w" id="a" style="translate:0 0 100px">' +
        '</div></div>',
    );
    await act();
    const el = view(node);
    closeRect(
      el.elementRect(findById(el.document, 'a')!),
      { x: 0, y: 0, width: 300, height: 150 },
      'in logical pixels',
    );
    const { abs } = el as unknown as DrawnNode;
    await expectPixel(result.ctx, abs.x + 8, abs.y + 8, RED);
  },
);
