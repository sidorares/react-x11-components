// <Html> — transforms: a box turned, scaled or skewed is painted through
// its matrix, found under the pointer where that puts it, and laid out as
// though it had none.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { deflateSync } from 'node:zlib';
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
} from '../../src/html/css/transform.js';
import { Html } from '../../src/index.js';
import {
  boxOf,
  fillsOf,
  findById,
  h,
  metric,
  render,
  render2x,
  renderWithBytes,
  view,
} from './harness.js';
import type { LaidBox } from './harness.js';

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
    transform: ({ by: unknown } | { matrix: Matrix })[] | null;
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
  assert.deepStrictEqual(matrix('a'), [0, 1, -1, 0, 0, 0]);
  assert.deepStrictEqual(list('b'), [{ by: [{ pct: -50 }, { pct: -50 }] }]);
  // Tailwind 3's list: the translation, and the rest multiplied to nothing
  assert.strictEqual(list('c')!.length, 2);
  assert.deepStrictEqual(list('c')![0], { by: [10, 5] });
  assert.ok(near(matrix('c', 1), [1, 0, 0, 1, 0, 0]), `${matrix('c', 1)}`);
  // a run of numbers is one matrix: half as wide, then turned, then twice
  // the size
  assert.strictEqual(list('d')!.length, 1);
  assert.ok(near(matrix('d'), [0, 1, -2, 0, 0, 0]), `${matrix('d')}`);
  assert.deepStrictEqual(matrix('e'), [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(
    list('f'),
    [],
    'a transform, and nothing in the plane',
  );
  // out of the plane is left out; about the axis out of the page is a turn
  assert.ok(near(matrix('g'), [0, 2, -3, 0, 0, 0]), `${matrix('g')}`);
  assert.deepStrictEqual(matrix('h'), [0, 1, -1, 0, 0, 0], 'no angle: dropped');
  assert.strictEqual(list('i'), null);
  assert.ok(near(matrix('j'), [1, 0, 1, 1, 0, 0]), `${matrix('j')}`);
  assert.deepStrictEqual(matrix('k'), [0, -1, 1, 0, 0, 0]);
  assert.deepStrictEqual(matrix('l'), [1, 0, 0, 1, 7, 8]);
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
      '<div id="p" style="transform-origin:top left"></div>',
  );
  const el = view(node);
  const style = (id: string) => (boxOf(el, id) as Styled).style;
  assert.strictEqual(style('a').rotate, 90);
  assert.strictEqual(style('b').rotate, -180);
  assert.strictEqual(style('c').rotate, 90);
  assert.strictEqual(style('d').rotate, null, 'out of the plane');
  assert.strictEqual(style('e').rotate, null);
  assert.strictEqual(style('f').rotate, 45, 'a number is no angle');
  assert.deepStrictEqual(style('g').scale, [2, 2]);
  assert.deepStrictEqual(style('h').scale, [1.5, 0.5]);
  assert.deepStrictEqual(style('i').scale, [2, 3], 'a depth is dropped');
  assert.strictEqual(style('j').scale, null);
  assert.deepStrictEqual(style('k').scale, [-1.5, 1]);
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

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A window region's pixels, straight RGBA. */
function pixelsIn(ctx: unknown, region: Region): Promise<Uint8ClampedArray> {
  const { x, y, width, height } = region;
  return new Promise<Uint8ClampedArray>((ok, fail) =>
    (
      ctx as {
        getImageData(
          x: number,
          y: number,
          w: number,
          h: number,
          cb: (e: unknown, d: { data: Uint8ClampedArray }) => void,
        ): void;
      }
    ).getImageData(x, y, width, height, (e, d) => (e ? fail(e) : ok(d.data))),
  );
}

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

/** A PNG of one colour, `width` by `height`. */
function solidPng(
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
): Uint8Array {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    let crc = ~0;
    for (const byte of body) {
      crc ^= byte;
      for (let k = 0; k < 8; k += 1)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(~crc >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

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
