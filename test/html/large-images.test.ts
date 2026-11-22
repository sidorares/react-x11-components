// <Html> — an image drawn larger, or further away, than an X request carries
// (`src/html/draw-image.ts`): what shows of it is drawn, and the document
// with it. Each page is held to one that shows the same part another way: a
// few pixels cut out of the image, drawn as large a pixel.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { PNG } from 'pngjs';
import { act, cleanup, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import * as ntk from 'react-x11/ntk';
import { Html } from '../../src/index.js';
import {
  drawImageAt,
  drawImagePart,
  drawImageSized,
} from '../../src/html/draw-image.js';
import { SurfaceCache } from '../../src/html/surfaces.js';
import {
  FONTS,
  h,
  imagesIn,
  metric,
  paneOf,
  snapshot,
  solidPng,
  view,
} from './harness.js';

afterEach(cleanup);

/** Pixels of noise, the same at every run, their alpha too for a mask. */
function noise(
  x0: number,
  y0: number,
  width: number,
  height: number,
  alpha = false,
): PNG {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const n = (x0 + x) * 7919 + (y0 + y) * 104729;
      png.data[i] = (n * 37) % 251;
      png.data[i + 1] = (n * 101) % 241;
      png.data[i + 2] = (n * 59) % 239;
      png.data[i + 3] = alpha ? (n * 83) % 256 : 255;
    }
  }
  return png;
}

const bytes = (png: PNG): Uint8Array => new Uint8Array(PNG.sync.write(png));

// An image of 700 pixels drawn at 100 of the page's each is 70,000 across.
// `cut.png` is four of its pixels each way, from the 599th across and the
// 499th down, and `start.png` its first four.
const IMAGES: Record<string, Uint8Array> = {
  'big.png': bytes(noise(0, 0, 700, 700)),
  'cut.png': bytes(noise(599, 499, 4, 4)),
  'start.png': bytes(noise(0, 0, 4, 4)),
  'veil.png': bytes(noise(0, 0, 700, 700, true)),
  'veilcut.png': bytes(noise(599, 499, 4, 4, true)),
  'rows.png': bytes(noise(0, 499, 700, 4)),
  'ring.png': bytes(noise(0, 0, 30, 30)),
  // longer than a server makes a pixmap, and than a request says one is
  'tall.png': bytes(noise(0, 0, 4, 40000)),
  'tallcut.png': bytes(noise(0, 35000, 4, 60)),
  'taller.png': bytes(noise(0, 0, 4, 70000)),
  'tallercut.png': bytes(noise(0, 69000, 4, 60)),
  'red.png': solidPng(4, 70000, [255, 0, 0]),
};

const imageOf = (png: PNG): unknown =>
  new (ntk as unknown as { Image: new (pixels: unknown) => unknown }).Image({
    width: png.width,
    height: png.height,
    data: png.data,
  });

const canvasImage = (el: { attribs: Record<string, string> }): unknown =>
  imageOf(
    el.attribs.width === '700' ? noise(0, 0, 700, 700) : noise(599, 499, 4, 4),
  );

const onResource = (r: { url: string; kind: string }) =>
  r.kind === 'image' && IMAGES[r.url]
    ? { kind: 'image' as const, bytes: IMAGES[r.url] }
    : null;

const BLUE = '<div style="width:100px;height:20px;background:#0000ff"></div>';

/** A box of 100 by 50 that shows no more than it. */
const box = (css: string, inside = ''): string =>
  '<style>body{margin:0}</style>' +
  '<div style="position:relative;width:100px;height:50px;overflow:hidden">' +
  `<div style="width:100px;height:50px;${css}">${inside}</div></div>${BLUE}`;

const img = (src: string, side: number, css = ''): string =>
  `<img src=${src} width=${side} height=${side} style="display:block;${css}">`;

/** What `run` does, and that no document was left blank by it. */
async function unbroken<T>(source: string, run: () => Promise<T>): Promise<T> {
  const errors: string[] = [];
  const { error } = console;
  console.error = (...said: unknown[]) => void errors.push(String(said[0]));
  let made: T;
  try {
    made = await run();
  } finally {
    console.error = error;
  }
  const blank = errors.filter((e) => e.includes('leaves it blank'));
  assert.deepStrictEqual(blank, [], source);
  return made;
}

/** The document's pixels as it is painted the first time and the third,
 *  when what is kept of its images has been made. */
function drawn(source: string, scale: number) {
  return unbroken(source, async () => {
    const result = await renderX11(
      h(
        'box',
        { style: { width: 300, height: 100, flexDirection: 'column' } },
        h(Html, {
          source,
          partial: false,
          'data-testname': 'doc',
          style: { height: 100 },
          canvasImage,
          onResource,
        } as never),
      ),
      {
        width: 300,
        height: 100,
        fonts: FONTS!,
        ...(scale !== 1 && { scale }),
      },
    );
    const el = view(screen.getByTestName('doc') as DrawnNode);
    await imagesIn(el);
    const first = await snapshot(result, el);
    for (let i = 0; i < 2; i += 1) {
      await act(() => (el as unknown as { invalidate(): void }).invalidate());
    }
    const kept = await snapshot(result, el);
    await cleanup();
    return { first, kept };
  });
}

/** What a pane 100 by 100 shows of a document scrolled to `top`, but for
 *  its bar. */
function scrolled(source: string, top: number, scale: number) {
  return unbroken(source, async () => {
    const result = await renderX11(
      h(
        'box',
        { style: { width: 100, height: 100, flexDirection: 'column' } },
        h(
          'box',
          { style: { flexGrow: 1, overflow: 'scroll' } },
          h(Html, {
            source,
            partial: false,
            'data-testname': 'doc',
            onResource,
          }),
        ),
      ),
      {
        width: 100,
        height: 100,
        fonts: FONTS!,
        ...(scale !== 1 && { scale }),
      },
    );
    const el = view(screen.getByTestName('doc') as DrawnNode);
    await imagesIn(el);
    await act(() => paneOf(el).scrollTo({ y: top }));
    await act();
    const { abs } = el as unknown as { abs: { y: number } };
    assert.ok(Math.abs(abs.y + top * scale) < 1, `at ${abs.y}`);
    const { data } = await new Promise<{ data: Uint8ClampedArray }>(
      (ok, fail) =>
        (
          result.ctx as unknown as {
            getImageData(
              x: number,
              y: number,
              w: number,
              h: number,
              cb: (e: unknown, d: { data: Uint8ClampedArray }) => void,
            ): void;
          }
        ).getImageData(0, 0, 80 * scale, 100 * scale, (e, d) =>
          e ? fail(e) : ok(d),
        ),
    );
    await cleanup();
    return data;
  });
}

/** How far apart the two are at most, in a channel. */
function furthest(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  assert.strictEqual(a.length, b.length);
  let most = 0;
  for (let i = 0; i < a.length; i += 1) {
    most = Math.max(most, Math.abs(a[i] - b[i]));
  }
  return most;
}

const colours = (data: Uint8ClampedArray): number => {
  const seen = new Set<number>();
  for (let i = 0; i < data.length; i += 4) {
    seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  }
  return seen.size;
};

const AT = '-60000px -50000px/70000px 70000px';
const CUT = '-100px -100px/400px 400px';
const FAR = 'margin:-50000px 0 0 -60000px';
const NEAR = 'margin:-100px 0 0 -100px';

const start = box('', img('start.png', 400));

const inline = (background: string): string =>
  '<style>body{margin:0;font:40px/50px serif}span{color:transparent;' +
  `background:${background}}</style><span>XX</span>${BLUE}`;

/** A page, the one it is held to, and how many levels of 255 apart two
 *  pixels may be: the two step across the image in 16.16 fixed point, from
 *  other corners of it. */
const PAIRS: [name: string, large: string, same: string, apart?: number][] = [
  [
    'a background from its corner',
    box('background:url(big.png) 0 0/70000px 70000px'),
    box('background:url(start.png) 0 0/400px 400px no-repeat'),
  ],
  [
    'a background from far into it',
    box(`background:url(big.png) ${AT}`),
    box(`background:url(cut.png) ${CUT} no-repeat`),
  ],
  [
    'a background on the canvas',
    `<style>html{background:url(big.png) ${AT}}</style>`,
    `<style>html{background:url(cut.png) ${CUT} no-repeat}</style>`,
  ],
  [
    'a background in rounded corners',
    box(`border-radius:20px;background:url(big.png) ${AT}`),
    box(`border-radius:20px;background:url(cut.png) ${CUT} no-repeat`),
  ],
  [
    'a background of an inline box',
    inline(`url(big.png) ${AT}`),
    inline(`url(cut.png) ${CUT} no-repeat`),
  ],
  [
    'a background repeated across, a pixel wide',
    box('background:url(big.png) 0 -50000px/1px 70000px'),
    box('background:url(rows.png) 0 -100px/1px 400px repeat-x'),
  ],
  [
    'a background with space round it',
    box('background:url(big.png) 0 0/70000px 70000px space'),
    box('background:url(start.png) 0 0/400px 400px no-repeat'),
  ],
  [
    'a pixelated background, too large to be made so',
    box(`image-rendering:pixelated;background:url(big.png) ${AT}`),
    box(`background:url(cut.png) ${CUT} no-repeat`),
  ],
  [
    'a pixelated background a pixel wide',
    box(
      'image-rendering:pixelated;' +
        'background:url(red.png) 0 0/1px 70000px no-repeat',
    ),
    box('background:linear-gradient(#ff0000,#ff0000) 0 0/1px 100% no-repeat'),
  ],
  [
    'an image an image-set() chose at a hundredth of its density',
    box('background-image:image-set(url(big.png) 0.01x)'),
    box('background:url(start.png) 0 0/400px 400px no-repeat'),
  ],
  [
    'a background far clear of its box',
    box(
      'background:linear-gradient(#c03010,#c03010) 0 0/50px 50px no-repeat,' +
        'url(big.png) 1e30px 0/70000px 70000px no-repeat',
    ),
    box('background:linear-gradient(#c03010,#c03010) 0 0/50px 50px no-repeat'),
  ],
  [
    'a mask',
    box(`background:#c03010;mask:url(veil.png) ${AT}`),
    box(`background:#c03010;mask:url(veilcut.png) ${CUT} no-repeat`),
  ],
  [
    'a mask intersected with one',
    box(
      `background:#c03010;mask:url(veil.png) ${AT},` +
        'linear-gradient(#000,transparent);mask-composite:intersect',
    ),
    box(
      `background:#c03010;mask:url(veilcut.png) ${CUT} no-repeat,` +
        'linear-gradient(#000,transparent);mask-composite:intersect',
    ),
  ],
  ['an <img> from its corner', box('', img('big.png', 70000)), start],
  [
    'an <img> from far into it',
    box('', img('big.png', 70000, FAR)),
    box('', img('cut.png', 400, NEAR)),
  ],
  [
    'an <img> with rounded corners',
    box('', img('big.png', 70000, 'border-radius:30px')),
    box('', img('start.png', 400, 'border-radius:30px')),
  ],
  [
    'an object-position far from its box',
    box('', img('tall.png', 50, 'object-fit:none;object-position:0 -35000px')),
    box('', img('tallcut.png', 50, 'object-fit:none;object-position:0 0')),
  ],
  [
    'an object-view-box of one pixel',
    box(
      '',
      '<img src=big.png style="display:block;width:100px;height:100px;' +
        'object-view-box:xywh(600px 500px 1px 1px)">',
    ),
    box(`background:url(cut.png) ${CUT} no-repeat`),
  ],
  [
    'an image longer than a server makes a pixmap',
    box('', '<img src=tall.png style="display:block;margin-top:-35000px">'),
    box('', '<img src=tallcut.png style="display:block">'),
  ],
  [
    'an image longer than a request says one is',
    box('', '<img src=taller.png style="display:block;margin-top:-69000px">'),
    box('', '<img src=tallercut.png style="display:block">'),
  ],
  [
    'a background of one, repeated across',
    box('background:url(taller.png) 0 -69000px'),
    box('background:url(tallercut.png) repeat-x'),
  ],
  [
    'an image longer than a request says one is, drawn small',
    box('', '<img src=red.png width=100 height=50 style="display:block">'),
    box('background:#ff0000'),
  ],
  [
    'a gradient tile round its centre, long and thin',
    box(
      'background:conic-gradient(#ff0000 50%,#00ff00 0) 0 -100px/10px 70000px',
    ),
    box('background:linear-gradient(90deg,#00ff00 50%,#ff0000 0) 0 0/10px'),
  ],
  [
    'an image turned about its corner',
    box(
      '',
      img('big.png', 70000, 'transform:rotate(10deg);transform-origin:0 0'),
    ),
    box(
      '',
      img('start.png', 400, 'transform:rotate(10deg);transform-origin:0 0'),
    ),
  ],
  [
    'an image a transform moves',
    box('', img('big.png', 70000, 'transform:translate(-60000px,-50000px)')),
    box('', img('cut.png', 400, 'transform:translate(-100px,-100px)')),
  ],
  [
    'an image out of the plane',
    box(
      'perspective:500px;perspective-origin:0 0',
      img('big.png', 70000, 'transform:rotateY(10deg);transform-origin:0 0'),
    ),
    box(
      'perspective:500px;perspective-origin:0 0',
      img('start.png', 400, 'transform:rotateY(10deg);transform-origin:0 0'),
    ),
  ],
  [
    'an image in a group that fades',
    box('opacity:.5', img('big.png', 70000) + BLUE),
    box('opacity:.5', img('start.png', 400) + BLUE),
  ],
  [
    'a generated image',
    box('content:url(big.png);width:70000px;height:70000px'),
    start,
  ],
  [
    "a ::before's image",
    '<style>#b::before{content:image-set(url(big.png) 0.01x);' +
      `display:block}</style>${box('', '<div id=b></div>')}`,
    start,
  ],
  [
    'a list marker',
    box(
      '',
      '<div style="display:list-item;list-style:inside ' +
        'image-set(url(big.png) 0.01x)"></div>',
    ),
    start,
  ],
  [
    'an image button',
    box(
      '',
      '<input type=image src=big.png width=70000 height=70000 ' +
        'style="display:block">',
    ),
    start,
  ],
  [
    'an <object>',
    box(
      '',
      '<object data=big.png type=image/png width=70000 height=70000 ' +
        'style="display:block"></object>',
    ),
    start,
  ],
  [
    "a video's poster",
    box(
      '',
      '<video poster=big.png width=70000 height=70000 ' +
        'style="display:block"></video>',
    ),
    start,
  ],
  [
    'a canvas',
    box(
      '',
      '<canvas width=700 height=700 style="display:block;width:70000px;' +
        `height:70000px;${FAR}"></canvas>`,
    ),
    box(
      '',
      '<canvas width=4 height=4 style="display:block;width:400px;' +
        `height:400px;${NEAR}"></canvas>`,
    ),
  ],
  [
    "a border image's middle",
    box(
      '',
      '<div style="box-sizing:border-box;width:70000px;height:70000px;' +
        `${FAR};border:100px solid;border-image:url(big.png) 1 fill"></div>`,
    ),
    box(`background:url(cut.png) ${CUT} no-repeat`),
  ],
  [
    "a border image's edge, its slice repeated along it",
    box(
      '',
      '<div style="box-sizing:border-box;width:40000px;height:40px;' +
        'margin-left:-39900px;border:10px solid;' +
        'border-image:url(ring.png) 10 repeat"></div>',
    ),
    box(
      '',
      '<div style="box-sizing:border-box;width:400px;height:40px;' +
        'margin-left:-300px;border:10px solid;' +
        'border-image:url(ring.png) 10 repeat"></div>',
    ),
  ],
  [
    'a border image of a gradient, longer than a surface is',
    box(
      '',
      '<div style="box-sizing:border-box;width:70000px;height:15px;' +
        'border:5px solid;' +
        'border-image:linear-gradient(90deg,#ff0000 50%,#0000ff 50%) 5">' +
        '</div>',
    ),
    box(
      '',
      '<div style="height:15px;box-sizing:border-box;width:200px;' +
        'border:5px solid #ff0000"></div>',
    ),
  ],
];

for (const scale of [1, 2]) {
  for (const [name, large, same, apart = 2] of PAIRS) {
    metric(`drawn large: ${name}, at ${scale}x`, async () => {
      const a = await drawn(large, scale);
      const b = await drawn(same, scale);
      assert.ok(colours(b.first) > 2, 'the page it is held to shows it');
      const first = furthest(a.first, b.first);
      assert.ok(first <= apart, `painted first: ${first} apart`);
      const kept = furthest(a.kept, b.kept);
      assert.ok(kept <= apart, `painted again: ${kept} apart`);
    });
  }

  // A pane scrolls the document up past what a request can place: the
  // image's corner is further above the window than it can say.
  for (const [name, tall] of [
    ['an <img>', img('big.png', 70000)],
    [
      'a background',
      '<div style="width:70000px;height:70000px;' +
        'background:url(big.png) 0 0/70000px 70000px"></div>',
    ],
  ]) {
    metric(`${name} scrolled past what is placed, at ${scale}x`, async () => {
      const body = '<style>body{margin:0}body>div{overflow:hidden}</style>';
      const a = await scrolled(
        `${body}<div><div style="margin-left:-60000px">${tall}</div></div>`,
        50000,
        scale,
      );
      const b = await scrolled(
        `${body}<div style="height:70000px;background:url(cut.png) ` +
          '-100px 49900px/400px 400px no-repeat"></div>',
        50000,
        scale,
      );
      assert.ok(colours(b) > 2, 'the page it is held to shows it');
      assert.ok(furthest(a, b) <= 2, `${furthest(a, b)} apart`);
    });
  }
}

test('a draw a request carries goes to the context as it came', () => {
  const calls: unknown[][] = [];
  const ctx = {
    width: 100,
    height: 50,
    drawImage: (...args: unknown[]) => void calls.push(args),
    getTransform: () => assert.fail('asked nothing more'),
  };
  const image = { width: 8, height: 8 };
  drawImageAt(ctx, image, -32768, 32767);
  drawImageSized(ctx, image, -32768, 32767, 65535, 65535);
  drawImagePart(ctx, image, 1, 2, 3, 4, -5, 6, 7.5, 8);
  assert.deepStrictEqual(calls, [
    [image, -32768, 32767],
    [image, -32768, 32767, 65535, 65535],
    [image, 1, 2, 3, 4, -5, 6, 7.5, 8],
  ]);
});

test('a draw a request does not carry is cut to the surface', () => {
  const calls: unknown[][] = [];
  const ctx = {
    width: 100,
    height: 50,
    drawImage: (...args: unknown[]) => void calls.push(args),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  const image = { width: 1000, height: 1000 };
  drawImageSized(ctx, image, -50000, 10, 100000, 100000);
  // an image at its own size is read at it
  drawImageAt(ctx, { width: 32000, height: 10 }, -32800, 0);
  drawImagePart(ctx, image, 100, 0, 10, 10, 0, -40000, 100, 80000);
  // and what is past the surface draws nothing
  drawImageAt(ctx, image, 40000, 0);
  assert.deepStrictEqual(
    calls.map((call) => call.slice(1)),
    [
      [500, 0, 1, 0.4, 0, 10, 100, 40],
      [100, 5, 10, 0.00625, 0, 0, 100, 50],
    ],
  );
  // A native context is handed what it was, and so is one a transform is on.
  calls.length = 0;
  drawImageSized({ ...ctx, scalesText: true }, image, 0, 0, 70000, 70000);
  drawImageSized(
    { ...ctx, getTransform: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }) },
    image,
    0,
    0,
    70000,
    70000,
  );
  assert.deepStrictEqual(
    calls.map((call) => call.slice(1)),
    [
      [0, 0, 1000, 1000, 0, 0, 70000, 70000],
      [0, 0, 1000, 1000, 0, 0, 70000, 70000],
    ],
  );
});

metric('a surface no server makes is not asked for', async () => {
  const { app } = await renderX11(h('box', {}), { fonts: FONTS! });
  const cache = new SurfaceCache(app);
  const draw = (): void => {};
  assert.strictEqual(cache.get('long', 1, 70000, draw), null);
  assert.strictEqual(cache.get('wide', 70000, 1, draw), null);
  // which says nothing of the next one
  assert.ok(cache.get('short', 10, 10, draw));
  cache.destroy();
});
