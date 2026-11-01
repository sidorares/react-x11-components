// <Html> — replaced elements: images, SVG, aspect-ratio and object-fit.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import {
  act,
  cleanup,
  expectPixel,
  fireEvent,
  renderX11,
  screen,
  waitFor,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import * as ntk from 'react-x11/ntk';
import type { ChildNode, Document, Element, ParentNode } from 'domhandler';
import { appendChild, removeElement } from 'domutils';
import { parseDocument } from 'htmlparser2';
import { Html } from '../../src/index.js';
import type { HtmlChange, HtmlViewNode } from '../../src/html/index.js';
import { decodesImageType } from '../../src/html/image-types.js';
import {
  drawsForeignObjects,
  forgetDrawings,
  inlineDrawing,
} from '../../src/html/svg.js';
import { HtmlSource, shadowRootOf } from '../../src/html/dom.js';
import {
  allowsAutoSizes,
  normalize,
  parseSizes,
  parseSrcset,
  pick,
  sourceSize,
} from '../../src/html/srcset.js';
import {
  FONTS,
  RED_PNG,
  SVG_NS,
  boxOf,
  bytesApart,
  fillsOf,
  findById,
  h,
  metric,
  pixelsIn,
  pixelsPng,
  render,
  render2x,
  renderWithBytes,
  renderWithImages,
  snapshot,
  solidPng,
  svgBytes,
  view,
  withForeignObjects,
} from './harness.js';
import type { LaidBox, PaintOp, ReplacedBox } from './harness.js';
import { animationClock } from '../../src/html/node.js';
import { imageDecoder } from '../../src/html/resources.js';
import { holdClock } from '../held-clock.js';
import { mulberry32 } from '../mulberry32.js';
import { gifBytes } from '../gif-fixture.js';

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

/** A 4 by 4 GIF that is red for 20 ms, then green for 20 ms, `loops`. */
const blinking = (loops?: number) =>
  gifBytes({
    width: 4,
    height: 4,
    palette: [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255],
    ],
    loops,
    frames: [
      { pixels: new Array(16).fill(0), delay: 2 },
      { pixels: new Array(16).fill(1), delay: 2 },
    ],
  });

metric(
  'an animated GIF plays, in an <img> and in a background, repainting only where it is drawn',
  async (t) => {
    const clock = holdClock(t, animationClock);
    const { result, el } = await renderWithBytes(
      '<style>body{margin:0}img{display:block}</style>' +
        '<img id="a" src="a.gif" width="8" height="8">' +
        '<div id="b" style="width:8px;height:8px;background:url(a.gif)"></div>' +
        '<p>text below, which no frame repaints</p>',
      { 'a.gif': blinking(0) },
    );
    const { ctx } = result;
    const abs = (el as unknown as DrawnNode).abs;
    await act();
    await expectPixel(ctx, abs.x + 4, abs.y + 4, '#ff0000', {
      message: 'img, first',
    });
    await expectPixel(ctx, abs.x + 4, abs.y + 12, '#ff0000', {
      message: 'bg, first',
    });
    const damage: { width: number; height: number }[] = [];
    const invalidate = (el as unknown as { invalidate: Function }).invalidate;
    t.mock.method(
      el,
      'invalidate',
      function (this: unknown, ...args: unknown[]) {
        const rect = args[1] as { width: number; height: number } | undefined;
        if (rect && typeof rect === 'object') damage.push(rect);
        return invalidate.apply(this, args);
      },
    );
    assert.ok(clock.pending, 'a frame is waited for');
    await clock.frame();
    await clock.frame();
    await act();
    await expectPixel(ctx, abs.x + 4, abs.y + 4, '#00ff00', {
      message: 'img, second',
    });
    await expectPixel(ctx, abs.x + 4, abs.y + 12, '#00ff00', {
      message: 'bg, second',
    });
    assert.ok(damage.length > 0, 'the frame was repainted');
    for (const rect of damage) {
      assert.ok(
        rect.width <= 10 && rect.height <= 18,
        `damage ${rect.width}x${rect.height} is the boxes that drew it`,
      );
    }
    await clock.frame();
    await clock.frame();
    await clock.frame();
    await act();
    await expectPixel(ctx, abs.x + 4, abs.y + 4, '#ff0000', {
      message: 'img, again',
    });
  },
);

metric(
  'an animated WebP plays as a GIF does, once its decoder has loaded',
  async (t) => {
    const clock = holdClock(t, animationClock);
    // red for 20 ms, then green for 20, for ever; made with libwebp's webpmux
    const webp = new Uint8Array(
      Buffer.from(
        'UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAwAAAwAAQU5JTQYAAAD/////AABBTk1GKAAAAAAA' +
          'AAAAAAMAAAMAABQAAAJWUDhMDwAAAC8DwAAABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAAMA' +
          'AAMAABQAAAJWUDhMDwAAAC8DwAAAB9D/iP4HIqL/AQA=',
        'base64',
      ),
    );
    const { result, el } = await renderWithBytes(
      '<style>body{margin:0}img{display:block}</style>' +
        '<img src="a.webp" width="8" height="8">',
      { 'a.webp': webp },
    );
    const { ctx } = result;
    const abs = (el as unknown as DrawnNode).abs;
    await waitFor(() =>
      assert.ok(clock.pending, 'decoded, and waiting for a frame'),
    );
    await act();
    await expectPixel(ctx, abs.x + 4, abs.y + 4, '#ff0000', {
      message: 'first',
    });
    await clock.frame();
    await clock.frame();
    await act();
    await expectPixel(ctx, abs.x + 4, abs.y + 4, '#00ff00', {
      message: 'second',
    });
  },
);

metric(
  'an animated GIF that has played its loops rests on its last frame, and waits for nothing',
  async (t) => {
    const clock = holdClock(t, animationClock);
    const { result, el } = await renderWithBytes(
      '<style>body{margin:0}img{display:block}</style>' +
        '<img src="a.gif" width="8" height="8">',
      { 'a.gif': blinking() },
    );
    const abs = (el as unknown as DrawnNode).abs;
    await act();
    assert.ok((await clock.finish()) > 0, 'it played');
    await act();
    assert.strictEqual(clock.pending, false);
    await expectPixel(result.ctx, abs.x + 4, abs.y + 4, '#00ff00');
  },
);

metric(
  'an animated GIF out of view asks for no frame until it is drawn',
  async (t) => {
    const clock = holdClock(t, animationClock);
    const gif = blinking(0);
    await renderX11(
      h(
        'box',
        {
          'data-testname': 'pane',
          style: { width: 200, height: 50, overflow: 'scroll' },
        },
        h(Html, {
          source:
            '<style>body{margin:0}img{display:block}</style>' +
            '<div style="height:400px"></div><img src="a.gif" width="8" height="8">',
          partial: false,
          'data-testname': 'doc',
          onResource: (r: { kind: string }) =>
            r.kind === 'image' ? { kind: 'image' as const, bytes: gif } : null,
        }),
      ),
      { width: 240, height: 100, fonts: FONTS! },
    );
    await act();
    assert.strictEqual(clock.pending, false, 'below the pane, nothing ticks');
    const pane = screen.getByTestName('pane') as unknown as {
      scrollTo(y: number): void;
    };
    await act(async () => pane.scrollTo(380));
    await act();
    assert.ok(clock.pending, 'scrolled into view, it plays');
  },
);

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

test('an object whose data is a document is a frame, and what it holds is not drawn; one whose data is nothing is what it holds', async () => {
  // Acid3's test 16: a 404, holding an object of a page, holding an object
  // of a picture and the word FAIL. The page shows, so neither does.
  const later: Array<() => void> = [];
  await renderX11(
    h(
      'box',
      { style: { width: 400, flexDirection: 'column' } },
      h(Html, {
        source:
          '<style>body{margin:0}object{border:0}</style>' +
          '<object id="a" data="gone.png"><object id="b" data="page.png">' +
          '<object id="c" data="r.png">FAIL</object></object></object>',
        partial: false,
        'data-testname': 'doc',
        onResource: (r: { url: string; kind: string }) => {
          const answer =
            r.url === 'page.png'
              ? { kind: 'document' as const }
              : r.url === 'r.png'
                ? { kind: 'image' as const, bytes: RED_PNG }
                : null;
          // the page arrives after the boxes are built
          return answer && r.url === 'page.png'
            ? new Promise<typeof answer>((ok) => later.push(() => ok(answer)))
            : answer;
        },
      }),
    ),
    { backend: 'mock' },
  );
  const el = () => view(screen.getByTestName('doc') as DrawnNode);
  await waitFor(() => assert.strictEqual(later.length, 1));
  assert.strictEqual(
    (boxOf(el(), 'c') as ReplacedBox).replaced,
    'image',
    'until the page is in, what the object holds is drawn',
  );
  await act(async () => later[0]());
  await waitFor(() =>
    assert.strictEqual((boxOf(el(), 'b') as ReplacedBox).replaced, 'frame'),
  );
  assert.strictEqual(
    (boxOf(el(), 'a') as ReplacedBox).replaced,
    'none',
    'the object of nothing is what it holds',
  );
  const b = boxOf(el(), 'b');
  assert.deepStrictEqual(
    [b.width, b.height],
    [300, 150],
    'a frame of its size',
  );
  assert.throws(() => boxOf(el(), 'c'), /has a box/, 'nor what it holds');
  assert.ok(!el().textContent().includes('FAIL'));
});

// An image that arrives after the boxes were built takes its size in place:
// it builds no boxes, and lays the document out again only where a size
// moves — an `<img>` its attributes size whatever its image is is painted.

/** The box tree the element holds: a build makes another. */
const treeOf = (el: HtmlViewNode): unknown =>
  (el as unknown as { _tree: unknown })._tree;

test('an image the size its attributes said is painted where it arrives, and builds nothing', async () => {
  const doc = await choosing(
    '<img id="a" width="20" height="10" src="small.png">' +
      '<img id="b" width="30" height="30" src="small.png">',
    { 'small.png': SMALL },
    { later: true },
  );
  await waitFor(() => assert.deepStrictEqual(doc.size('a'), [20, 10]));
  const tree = treeOf(doc.el());
  await doc.release();
  assert.strictEqual(treeOf(doc.el()), tree, 'the same boxes');
  assert.deepStrictEqual(doc.size('a'), [20, 10]);
  assert.deepStrictEqual(
    doc.size('b'),
    [30, 30],
    'the size its attributes give',
  );
  assert.strictEqual(
    (boxOf(doc.el(), 'b') as unknown as { intrinsic: { ratio: number } })
      .intrinsic.ratio,
    2,
    "the image's ratio, which object-fit fits it by",
  );
});

test('an image its own size lays out lays the document out again where it arrives, and builds nothing', async () => {
  const doc = await choosing(
    '<img id="a" src="large.png"><img id="b" width="20" height="20" ' +
      'style="height:auto" src="small.png"><p id="p">after</p>',
    { 'small.png': SMALL, 'large.png': LARGE },
    { later: true },
  );
  await waitFor(() => assert.deepStrictEqual(doc.size('b'), [20, 20]));
  const tree = treeOf(doc.el());
  const before = boxOf(doc.el(), 'p').y;
  await doc.release();
  await waitFor(() => assert.deepStrictEqual(doc.size('a'), [40, 20]));
  assert.deepStrictEqual(
    doc.size('b'),
    [20, 10],
    "an auto height, its ratio's",
  );
  assert.strictEqual(treeOf(doc.el()), tree, 'the same boxes');
  assert.strictEqual(boxOf(doc.el(), 'p').y, before + 20 - 10, 'what follows');
});

/** Hold every decode `resources.ts` hands core's ladder, for the rest of
 *  `t`: each lands, as `pixels` says, only when the test lets it go. */
function holdDecodes(
  t: { mock: { method: typeof import('node:test').mock.method } },
  pixels: (bytes: Uint8Array) => Uint8Array | null = (bytes) => bytes,
): { held: () => number; release: (count?: number) => Promise<void> } {
  const waiting: Array<() => void> = [];
  t.mock.method(
    imageDecoder,
    'decode',
    (bytes: Uint8Array) =>
      new Promise<{ width: number; height: number }>((resolve, reject) => {
        waiting.push(() => {
          const decoded = pixels(bytes);
          if (decoded) resolve(ntk.decodeImageBytes(decoded) as never);
          else reject(new Error('not an image'));
        });
      }),
  );
  return {
    held: () => waiting.length,
    /** The first `count` held, in the order asked; all of them by default. */
    release: async (count = waiting.length) => {
      for (const go of waiting.splice(0, count)) go();
      await act();
    },
  };
}

/** How many images `el` draws, by its own idea of which it has. */
async function imagesDrawn(el: HtmlViewNode): Promise<number> {
  const ops: PaintOp[] = [];
  const { imageFor } = (
    el as unknown as {
      _paintOptions(r: null, d: null): { imageFor(box: unknown): unknown };
    }
  )._paintOptions(null, null);
  await fillsOf(el, ops, { imageFor: imageFor as () => unknown });
  return ops.filter((op) => op.op === 'image').length;
}

test('an image is laid out at the size its header says before its decode lands, and drawn only once it has', async (t) => {
  // Apple's MacBook Pro page: an `<img>` only its image sizes, answered
  // from the host's cache, was still decoding on a worker 2.5 s later, and
  // everything under it was laid out 284px too high until it landed. A
  // browser lays it out from the bytes that say its size.
  const decodes = holdDecodes(t);
  for (const later of [false, true]) {
    const doc = await choosing(
      '<style>p{margin:0}</style><img id="a" src="large.png">' +
        '<img id="s" srcset="dense.png 2x"><p id="p">after</p>',
      { 'large.png': LARGE, 'dense.png': LARGE },
      { later },
    );
    if (later) {
      assert.deepStrictEqual(doc.size('a'), [0, 0], 'nothing has said yet');
      await doc.release();
    }
    await waitFor(() => assert.strictEqual(decodes.held(), 2));
    assert.deepStrictEqual(doc.size('a'), [40, 20], `at its size (${later})`);
    assert.deepStrictEqual(doc.size('s'), [20, 10], 'a choice at its density');
    assert.strictEqual(boxOf(doc.el(), 'p').y, 30, 'and what follows under');
    assert.strictEqual(await imagesDrawn(doc.el()), 0, 'with nothing drawn');
    const tree = treeOf(doc.el());
    await decodes.release();
    await waitFor(async () =>
      assert.strictEqual(await imagesDrawn(doc.el()), 2, 'drawn'),
    );
    assert.strictEqual(treeOf(doc.el()), tree, 'the same boxes');
    assert.deepStrictEqual(doc.size('a'), [40, 20]);
    assert.strictEqual(boxOf(doc.el(), 'p').y, 30, 'nothing moved');
    cleanup();
  }
});

test('a decode that comes to another size than its header said lays out at that one, and one that fails at none', async (t) => {
  // the header is believed only until the pixels are in: a file whose
  // header lies, or that does not decode, is laid out as it decodes
  const decodes = holdDecodes(t, (bytes) =>
    bytes === LARGE ? SMALL : bytes === SMALL ? null : bytes,
  );
  const doc = await choosing(
    '<style>p{margin:0}</style><img id="a" src="large.png">' +
      '<img id="b" src="small.png"><p id="p">after</p>',
    { 'small.png': SMALL, 'large.png': LARGE },
  );
  await waitFor(() => assert.strictEqual(decodes.held(), 2));
  assert.deepStrictEqual(doc.size('a'), [40, 20], "the header's");
  assert.deepStrictEqual(doc.size('b'), [20, 10]);
  assert.strictEqual(boxOf(doc.el(), 'p').y, 30);
  await decodes.release(1);
  await waitFor(() => assert.deepStrictEqual(doc.size('a'), [20, 10]));
  assert.deepStrictEqual(doc.size('b'), [20, 10], 'still its header');
  assert.strictEqual(boxOf(doc.el(), 'p').y, 20, 'what follows moved up');
  await decodes.release();
  await waitFor(() => assert.deepStrictEqual(doc.size('b'), [0, 0]));
  assert.strictEqual(boxOf(doc.el(), 'p').y, 10, 'and up again');
  assert.strictEqual(await imagesDrawn(doc.el()), 1, 'only what decoded');
});

test('a chosen source is laid out at the size its header says, and one chosen in place of a picture shows that picture until its pixels are in', async (t) => {
  // `ImageSources.sizePending`: the first choice has nothing to show
  // meanwhile, and takes its header's size at its density; a later one
  // keeps the picture on screen, at that picture's size, rather than a
  // frame the size of one not decoded yet
  const decodes = holdDecodes(t);
  const doc = await choosing(
    '<img id="s" srcset="large.png 2x"><picture>' +
      '<source media="(min-width: 300px)" srcset="wide.png">' +
      '<img id="p" src="small.png"></picture>',
    { 'small.png': SMALL, 'large.png': LARGE, 'wide.png': LARGE },
    { width: 200 },
  );
  await waitFor(() => assert.strictEqual(decodes.held(), 2));
  assert.deepStrictEqual(doc.size('s'), [20, 10], 'over its density');
  assert.deepStrictEqual(doc.size('p'), [20, 10]);
  await decodes.release();
  await waitFor(async () => assert.strictEqual(await imagesDrawn(doc.el()), 2));
  await doc.resize(400);
  await waitFor(() => assert.strictEqual(decodes.held(), 1));
  assert.ok(doc.asked.includes('wide.png'));
  assert.deepStrictEqual(doc.size('p'), [20, 10], 'the picture it has');
  assert.strictEqual(await imagesDrawn(doc.el()), 2, 'drawn meanwhile');
  await decodes.release();
  await waitFor(() => assert.deepStrictEqual(doc.size('p'), [40, 20]));
});

test('an image that arrives after the first layout widens the boxes that shrink to it, as one there from the start does', async () => {
  // what a flex item and an inline-block measured of the image while it
  // was on its way is kept for their lives, and was kept after it arrived:
  // the item was as narrow as no image, and the image hung out of it
  const source =
    '<div style="display:flex;width:10px"><div id="i"><img id="a" ' +
    'src="large.png"></div></div><span id="ib" style="display:inline-block">' +
    '<img id="b" src="large.png"></span><div id="f" style="float:left">' +
    '<img id="c" src="large.png"></div>';
  const laid = (doc: Awaited<ReturnType<typeof choosing>>) =>
    ['i', 'a', 'ib', 'b', 'f', 'c'].map((id) => [id, ...doc.size(id)]);
  const at = await choosing(source, { 'large.png': LARGE });
  const expected = laid(at);
  assert.deepStrictEqual(expected[0], ['i', 40, 20], 'as wide as the image');
  cleanup();
  const later = await choosing(source, { 'large.png': LARGE }, { later: true });
  assert.deepStrictEqual(later.size('i'), [0, 0], 'no image yet');
  const tree = treeOf(later.el());
  await later.release();
  await waitFor(() => assert.deepStrictEqual(later.size('a'), [40, 20]));
  assert.strictEqual(treeOf(later.el()), tree, 'the same boxes');
  assert.deepStrictEqual(laid(later), expected);
});

test('an image whose w candidate shows at another density takes its size in place at a new width, and lays out as a build does', async () => {
  // BBC's images: `w` candidates and a `sizes` in `vw`, so at every step
  // of a drag the candidate shown is another density, another size — and
  // the boxes were built for each. A flex item and an inline-block hold
  // two of them, and what they measured of the image is measured again.
  const source =
    '<div style="display:flex;width:5px"><div id="i"><img id="a" ' +
    'srcset="small.png 20w, large.png 40w" sizes="50vw"></div></div>' +
    '<span id="ib" style="display:inline-block"><img id="b" ' +
    'srcset="small.png 20w, large.png 40w" sizes="25vw"></span>';
  const doc = await choosing(
    source,
    { 'small.png': SMALL, 'large.png': LARGE },
    { width: 80 },
  );
  const laid = () => ['i', 'a', 'ib', 'b'].map((id) => [id, ...doc.size(id)]);
  assert.deepStrictEqual(doc.size('a'), [40, 20]);
  for (const width of [60, 100, 72, 80]) {
    const tree = treeOf(doc.el());
    await doc.resize(width);
    assert.strictEqual(treeOf(doc.el()), tree, `built again at ${width}`);
    assert.deepStrictEqual(doc.size('a'), [width / 2, width / 4]);
    const inPlace = laid();
    // and the document styled and built again whole, at the same width
    const el = doc.el() as unknown as {
      _invalidate(stale: number): void;
      layoutNow(): void;
    };
    el._invalidate(3);
    el.layoutNow();
    assert.deepStrictEqual(inPlace, laid(), `at ${width}`);
  }
});

test('an object built before its image arrived is built again as one', async () => {
  const doc = await choosing(
    '<object id="o" data="small.png" type="image/png">fallback</object>',
    { 'small.png': SMALL },
    { later: true },
  );
  await waitFor(() =>
    assert.strictEqual((boxOf(doc.el(), 'o') as ReplacedBox).replaced, 'none'),
  );
  await doc.release();
  await waitFor(() =>
    assert.strictEqual((boxOf(doc.el(), 'o') as ReplacedBox).replaced, 'image'),
  );
  assert.deepStrictEqual(doc.size('o'), [20, 10]);
});

// --- choosing an image's source ----------------------------------------------
//
// HTML's "selecting an image source" (4.8.4.3). Every case below was put to
// Chrome 154, Firefox and WebKit through Playwright, at 1x and 2x and at two
// viewport widths, and each answer here is theirs — all three agree on all
// of these but where a comment says otherwise.

test('a srcset is read as every browser reads it: a URL to white space, its descriptors, a candidate dropped whole', () => {
  const read = (srcset: string) =>
    parseSrcset(srcset).map((c) =>
      c.width !== undefined
        ? `${c.url} ${c.width}w`
        : c.density !== undefined
          ? `${c.url} ${c.density}`
          : c.url,
    );
  assert.deepStrictEqual(read('a.png, b.png 2x'), ['a.png', 'b.png 2']);
  assert.deepStrictEqual(
    read('  ,, a.png  1x  ,,b.png 2x ,'),
    ['a.png 1', 'b.png 2'],
    'commas and white space around candidates',
  );
  // a URL runs to white space: a comma inside one is the URL's, and a data:
  // URL is one candidate
  assert.deepStrictEqual(read('a.png,b.png 2x'), ['a.png,b.png 2']);
  assert.deepStrictEqual(read('data:image/png;base64,iVBO= 1x, b.png 2x'), [
    'data:image/png;base64,iVBO= 1',
    'b.png 2',
  ]);
  assert.deepStrictEqual(
    read('a.png 400w, b.png 0400w, c.png 400w 200h'),
    ['a.png 400w', 'b.png 400w', 'c.png 400w'],
    'a width, leading zeros and all, and a height beside one',
  );
  assert.deepStrictEqual(
    read('a.png .5x, b.png 1e1x, c.png -0x'),
    ['a.png 0.5', 'b.png 10', 'c.png 0'],
    'a density is any valid floating-point number at or above zero',
  );
  for (const none of [
    'a.png 1X',
    'a.png 400W',
    'a.png 1.x',
    'a.png +1x',
    'a.png -1x',
    'a.png 0w',
    'a.png 1x 2x',
    'a.png 400w 1x',
    'a.png 200h',
    'a.png 1x (foo, bar)',
  ]) {
    assert.deepStrictEqual(read(none), [], `${none} is no candidate`);
  }
  assert.deepStrictEqual(
    read('a.png 1x (foo, bar), b.png 2x'),
    ['b.png 2'],
    'a comma in parentheses is the descriptor’s, and the next goes on',
  );
});

test('sizes: the first entry whose condition holds, past entries that are none, and the viewport where none does', () => {
  const env = (width: number) => ({
    width,
    height: 700,
    scale: 1,
    scheme: 'light' as const,
    reducedMotion: false,
    scripting: false,
    decodes: () => true,
  });
  const size = (sizes: string, width = 1000) =>
    sourceSize(parseSizes(sizes), env(width));
  assert.strictEqual(size('(max-width: 600px) 100vw, 420px'), 420);
  assert.strictEqual(size('(max-width: 600px) 100vw, 420px', 500), 500);
  assert.strictEqual(size('(max-width:600px)100vw,500px', 500), 500);
  assert.strictEqual(size('calc(50vw - 100px)'), 400);
  assert.strictEqual(size('calc(50vw - 100px)', 100), 0, 'held at zero');
  assert.strictEqual(
    size('(min-width: 2000px) 10px, 20em'),
    320,
    'an em is the initial font size, as in a media query',
  );
  assert.strictEqual(
    size('(max-width: 600px) 100vw, 50em, 10px'),
    800,
    'what follows a size with no condition is never reached',
  );
  assert.strictEqual(size('0'), 0, 'a zero needs no unit');
  // none of these is a size, and the list goes on past it
  assert.strictEqual(size('50%'), 1000, 'a percentage');
  assert.strictEqual(size('300'), 1000, 'a number');
  assert.strictEqual(size('-10px, 300px'), 300, 'a negative length');
  assert.strictEqual(size('screen 300px, 600px'), 600, 'a media type');
  // `auto` is the laid-out width of a lazy image, and with none it is
  // passed over, as Firefox and WebKit pass it over — Chrome takes 100vw
  // for the whole list
  assert.strictEqual(size('auto, 300px'), 300, 'auto, with no width');
  assert.strictEqual(size('AUTO'), 1000, 'auto alone, with none');
  assert.strictEqual(size(''), 1000, 'none at all is 100vw');
  const laidOut = (sizes: string, width: number) =>
    sourceSize(parseSizes(sizes), env(1000), width);
  assert.strictEqual(laidOut('auto, 300px', 120), 120, 'auto is the width');
  assert.strictEqual(laidOut('Auto,300px', 120), 120, 'in any case');
  assert.strictEqual(
    laidOut('auto, (min-width: 2000px) auto, 300px', 0),
    0,
    'of nothing',
  );
  assert.strictEqual(
    laidOut('(min-width: 2000px) auto, 300px', 120),
    300,
    'under a condition that does not hold',
  );
  assert.strictEqual(
    laidOut('(min-width: 600px) auto, 300px', 120),
    120,
    'and one that does',
  );
});

test('an image allows auto in its sizes where it loads lazily and its sizes starts with it, as written', () => {
  const img = (attribs: string) =>
    parseDocument(`<img ${attribs}>`).children[0] as Element;
  assert.ok(allowsAutoSizes(img('loading="lazy" sizes="auto"')));
  assert.ok(allowsAutoSizes(img('loading="LAZY" sizes="AUTO,100px"')));
  assert.ok(allowsAutoSizes(img('loading="lazy" sizes="auto, 100px"')));
  // Firefox and WebKit allow none of these, as HTML says; Chrome 154 takes
  // the second and the third, and 100vw for the first
  assert.ok(!allowsAutoSizes(img('sizes="auto, 100px"')), 'not lazy');
  assert.ok(
    !allowsAutoSizes(img('loading="lazy" sizes=" auto, 100px"')),
    'a space before it',
  );
  assert.ok(
    !allowsAutoSizes(img('loading="lazy" sizes="(min-width: 1px) 1px, auto"')),
    'after another entry',
  );
  assert.ok(!allowsAutoSizes(img('loading="lazy" sizes="autoplay"')));
  assert.ok(!allowsAutoSizes(img('loading="lazy"')), 'no sizes');
});

test('the least dense candidate at or above the scale is chosen, else the densest, and of equal ones the first', () => {
  const at = (srcset: string, scale: number, size = 1000) =>
    pick(normalize(parseSrcset(srcset), size), scale)?.url;
  assert.strictEqual(at('a 1x, b 2x', 1), 'a');
  assert.strictEqual(at('a 1x, b 2x', 1.5), 'b');
  assert.strictEqual(at('a 1x, b 2x', 3), 'b', 'the densest, short of it');
  // Chrome once chose 1x here at 1.5 and 2 — below the scale, where the
  // scale fell short of the geometric mean of the two — and 154 does not
  assert.strictEqual(at('a 1x, b 5x', 1.5), 'b');
  assert.strictEqual(at('a 1.5x, b 3x', 1), 'a');
  assert.strictEqual(at('a 0.5x, b 1x', 2), 'b');
  assert.strictEqual(at('a 1x, b 1x', 1), 'a', 'the first of equal ones');
  assert.strictEqual(at('b 2x, a 1x', 1), 'a', 'in any order');
  assert.strictEqual(
    at('s 400w, m 800w, l 1600w', 2, 420),
    'l',
    'a width over the size: 0.95x, 1.9x and 3.8x',
  );
  assert.strictEqual(at('s 400w, m 800w, l 1600w', 1, 420), 'm');
  // and a denser candidate already asked for is taken over a lighter one
  // asked for anew, as Chrome takes one it has cached: Firefox would take
  // the lighter one
  const held = (url: string) => url === 'l';
  assert.strictEqual(
    pick(normalize(parseSrcset('s 400w, m 800w, l 1600w'), 500), 1, held)?.url,
    'l',
  );
  assert.strictEqual(
    pick(
      normalize(parseSrcset('s 400w, m 800w, l 1600w'), 500),
      1,
      (u) => u === 's',
    )?.url,
    'm',
    'a lighter one held is not',
  );
});

test("a source's type is one the decoders here read, parameters and case aside", (t) => {
  for (const type of [
    'image/webp',
    ' IMAGE/WEBP ; codecs=x',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/svg+xml',
    '',
  ]) {
    assert.ok(decodesImageType(type), `${type || 'none'} decodes`);
  }
  const g = globalThis as { Bun?: unknown };
  const had = 'Bun' in g;
  const bun = g.Bun;
  t.after(() => {
    if (had) g.Bun = bun;
    else delete g.Bun;
  });
  delete g.Bun;
  for (const type of ['image/avif', 'image/bmp', 'image/jxl', 'webp']) {
    assert.ok(!decodesImageType(type), `${type} does not, under Node`);
  }
  // `Bun.Image`, found as core's ladder finds it: BMP everywhere, and AVIF
  // where macOS's ImageIO decodes it — never JPEG XL, which Bun sniffs for
  // itself and turns down
  g.Bun = { Image: function Image() {} };
  const darwin =
    (globalThis as { process?: { platform?: string } }).process?.platform ===
    'darwin';
  assert.ok(decodesImageType('image/bmp'), 'a BMP under Bun');
  assert.strictEqual(decodesImageType('image/avif'), darwin);
  assert.ok(!decodesImageType('image/jxl'));
});

/** A document whose images are answered from `images` — at once, or, with
 *  `later`, each when the test lets it go — in a column the test can make
 *  another width. What it asked for is `asked`, in order. */
async function choosing(
  source: string,
  images: Record<string, Uint8Array>,
  options: { width?: number; scale?: number; later?: boolean } = {},
) {
  const asked: string[] = [];
  const waiting: Array<() => void> = [];
  const doc = (width: number) =>
    h(
      'box',
      { style: { width, flexDirection: 'column' } },
      h(Html, {
        source: '<style>body{margin:0}img{display:block}</style>' + source,
        partial: false,
        'data-testname': 'doc',
        onResource: (r: { url: string; kind: string; element: unknown }) => {
          if (r.kind !== 'image') return null;
          asked.push(r.url);
          const bytes = images[r.url];
          if (!bytes) return null;
          const answer = { kind: 'image' as const, bytes };
          if (!options.later) return answer;
          return new Promise<typeof answer>((resolve) => {
            waiting.push(() => resolve(answer));
          });
        },
      }),
    );
  const result = await renderX11(doc(options.width ?? 400), {
    backend: 'mock',
    ...(options.scale && { scale: options.scale }),
  });
  const el = () => view(screen.getByTestName('doc') as DrawnNode);
  return {
    asked,
    el,
    size: (id: string): [number, number] => {
      const box = boxOf(el(), id);
      return [box.width, box.height];
    },
    resize: async (width: number) => {
      await result.rerender(doc(width));
      await act();
    },
    release: async () => {
      for (const go of waiting.splice(0)) go();
      await waitFor(() => assert.strictEqual(waiting.length, 0));
      await act();
    },
  };
}

const SMALL = solidPng(20, 10, [255, 0, 0]);
const LARGE = solidPng(40, 20, [0, 0, 255]);

test('an <img srcset> with no src shows its candidate, as large as its density makes it', async () => {
  // An `<img srcset>` with no `src` showed nothing, and one with a `src`
  // showed the `src` whatever the set said.
  const source =
    '<img id="a" srcset="small.png 1x, large.png 2x">' +
    '<img id="b" srcset="large.png 2x">';
  const at1 = await choosing(source, {
    'small.png': SMALL,
    'large.png': LARGE,
  });
  assert.deepStrictEqual(at1.asked, ['small.png', 'large.png']);
  assert.deepStrictEqual(at1.size('a'), [20, 10], 'the 1x, at its pixels');
  assert.deepStrictEqual(at1.size('b'), [20, 10], 'the 2x, at half of them');
  cleanup();
  const at2 = await choosing(
    source,
    { 'small.png': SMALL, 'large.png': LARGE },
    { scale: 2 },
  );
  assert.deepStrictEqual(at2.asked, ['large.png'], 'the 2x alone, at 2x');
  // device pixels: 20 by 10 CSS pixels at 2x
  assert.deepStrictEqual(at2.size('a'), [40, 20]);
  assert.deepStrictEqual(at2.size('b'), [40, 20]);
});

test("Next.js's srcset is chosen at 1x, and its src, the 2x, is not asked for", async () => {
  // The course card on joshwcomeau.com: `next/image` writes the 2x as the
  // `src` for a browser with no `srcset`, and Chrome loads the 640.
  const url = (w: number) => `/_next/image/?url=%2Fcourse.jpg&w=${w}&q=75`;
  const markup = (w: number) => url(w).replace(/&/g, '&amp;');
  const source =
    `<img id="card" alt="" width="640" height="337.5" ` +
    `srcset="${markup(640)} 1x, ${markup(1920)} 2x" src="${markup(1920)}">`;
  const at1 = await choosing(source, {}, { width: 700 });
  assert.deepStrictEqual(at1.asked, [url(640)]);
  cleanup();
  const at2 = await choosing(source, {}, { width: 700, scale: 2 });
  assert.deepStrictEqual(at2.asked, [url(1920)]);
});

test("a <picture>'s first source that decodes here is its image's, and the <img> is the fallback", async () => {
  // The footer of joshwcomeau.com: a WebP source, and a PNG `<img>` for a
  // browser without WebP. The PNG was loaded, where every browser loads
  // the WebP.
  const webp = new Uint8Array(
    Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvCUACAAcQ/Y/+ByKi/wEA', 'base64'),
  );
  const { asked, size } = await choosing(
    '<picture><source type="image/avif" srcset="a.avif">' +
      '<source type="image/jxl" srcset="a.jxl">' +
      '<source type=" IMAGE/WEBP ; codecs=x" srcset="a.webp">' +
      '<img id="a" src="a.png"></picture>',
    { 'a.webp': webp, 'a.png': SMALL },
  );
  // AVIF is past what Node decodes, and JPEG XL past what anything here
  // does: a browser without either goes on the same way
  assert.deepStrictEqual(asked, ['a.webp']);
  await waitFor(() => assert.deepStrictEqual(size('a'), [10, 10]));
});

test("a <picture>'s sources: a media that does not hold, a source after the <img>, one with no srcset, and one not the picture's child", async () => {
  const { asked } = await choosing(
    '<picture><source media="(min-width: 600px)" srcset="wide.png">' +
      '<source media="print" srcset="print.png">' +
      '<source media="(prefers-color-scheme: dark)" srcset="dark.png">' +
      '<img id="a" src="a.png"></picture>' +
      '<picture><source srcset=""><source src="src.png">' +
      '<div><source srcset="nested.png"></div>' +
      '<img id="b" src="b.png"><source srcset="after.png"></picture>' +
      '<picture><source media="" srcset="any.png"><img src="c.png"></picture>' +
      '<picture><img srcset="d2.png 2x" src="d.png"></picture>',
    {},
  );
  assert.deepStrictEqual(asked, ['a.png', 'b.png', 'any.png', 'd.png']);
});

test('a choice that is declined is a declined image, and its src is not asked for in its place', async () => {
  const { asked, size } = await choosing(
    '<img id="a" srcset="gone.png 1x" src="small.png" width="30" height="12">',
    { 'small.png': SMALL },
  );
  assert.deepStrictEqual(asked, ['gone.png']);
  assert.deepStrictEqual(size('a'), [30, 12], 'framed at its attributes');
});

test('sizes and w descriptors: the image is as wide as sizes says, and a narrower window keeps the denser image it has', async () => {
  // 20w and 40w over a size of 100vw: at 40 CSS pixels the 40w is 1x; at
  // 20 the 20w is, but the 40w is in hand, and Chrome keeps it, at 2x —
  // Firefox asks for the 20w, and Safari asks nothing and keeps the 40w at
  // 1x, 40 pixels wide in a 20 pixel window
  const doc = await choosing(
    '<img id="a" srcset="small.png 20w, large.png 40w" sizes="100vw">',
    { 'small.png': SMALL, 'large.png': LARGE },
    { width: 40 },
  );
  assert.deepStrictEqual(doc.asked, ['large.png']);
  assert.deepStrictEqual(doc.size('a'), [40, 20]);
  await doc.resize(20);
  assert.deepStrictEqual(doc.asked, ['large.png'], 'nothing asked anew');
  assert.deepStrictEqual(doc.size('a'), [20, 10], 'the 40w at 2x');
  await doc.resize(30);
  assert.deepStrictEqual(doc.size('a'), [30, 15], 'at 4/3x');
  cleanup();
  // and a wider one asks for the denser image it now needs
  const widening = await choosing(
    '<img id="a" srcset="small.png 20w, large.png 40w" sizes="(max-width: 25px) 20px, 40px">',
    { 'small.png': SMALL, 'large.png': LARGE },
    { width: 20 },
  );
  assert.deepStrictEqual(widening.asked, ['small.png']);
  assert.deepStrictEqual(widening.size('a'), [20, 10]);
  await widening.resize(40);
  assert.deepStrictEqual(widening.asked, ['small.png', 'large.png']);
  assert.deepStrictEqual(widening.size('a'), [40, 20]);
});

test('a resize across a source’s media chooses again, and the image shown stays until the new one arrives', async () => {
  const doc = await choosing(
    '<picture><source media="(min-width: 300px)" srcset="large.png">' +
      '<img id="a" src="small.png"></picture>',
    { 'small.png': SMALL, 'large.png': LARGE },
    { width: 200, later: true },
  );
  assert.deepStrictEqual(doc.asked, ['small.png']);
  await doc.release();
  await waitFor(() => assert.deepStrictEqual(doc.size('a'), [20, 10]));
  await doc.resize(320);
  assert.deepStrictEqual(doc.asked, ['small.png', 'large.png']);
  // HTML's current request, beside the pending one: not a frame while the
  // new one is on its way
  assert.deepStrictEqual(doc.size('a'), [20, 10], 'the small one meanwhile');
  await doc.release();
  await waitFor(() => assert.deepStrictEqual(doc.size('a'), [40, 20]));
  // and back: both in hand, so nothing is asked for again
  await doc.resize(200);
  assert.deepStrictEqual(doc.size('a'), [20, 10]);
  assert.deepStrictEqual(doc.asked, ['small.png', 'large.png']);
});

test("a <picture>'s chosen source sizes its image with its width and height, in place of the image's own", async () => {
  // HTML's dimension attribute source: an art-directed picture reserves
  // another shape at each breakpoint, as Chrome, Firefox and Safari all
  // have it. The two images are written alike, and have two styles.
  const picture = (width: number, height: number) =>
    '<picture><source media="(min-width: 300px)" srcset="large.png" ' +
    `width="${width}" height="${height}">` +
    '<img src="small.png" width="30" height="30"></picture>';
  const doc = await choosing(picture(50, 10) + picture(60, 12), {
    'small.png': SMALL,
    'large.png': LARGE,
  });
  const sizes = () => {
    const root = (doc.el() as unknown as { _tree: { root: LaidBox } })._tree
      .root;
    const out: [number, number][] = [];
    const walk = (box: LaidBox): void => {
      if ((box.el as { name?: string } | null)?.name === 'img') {
        out.push([box.width, box.height]);
      }
      box.children.forEach(walk);
    };
    walk(root);
    return out;
  };
  assert.deepStrictEqual(sizes(), [
    [50, 10],
    [60, 12],
  ]);
  // a resize that takes the <img>'s own restyles it, with the boxes built
  // again around every other style
  await doc.resize(200);
  assert.deepStrictEqual(sizes(), [
    [30, 30],
    [30, 30],
  ]);
  await doc.resize(400);
  assert.deepStrictEqual(sizes(), [
    [50, 10],
    [60, 12],
  ]);
});

test("a source's width and height map as every browser maps them: one alone, one that is no length, one that sizes nothing", async () => {
  const img = (id: string, style = '') =>
    `<img id="${id}" src="small.png" width="30" height="30"${style}></picture>`;
  const { size } = await choosing(
    // a width alone: the height is the image's, at its ratio, and not the
    // <img>'s; and a height alone
    '<picture><source srcset="large.png" width="50">' +
      img('w') +
      '<picture><source srcset="large.png" height="10">' +
      img('h') +
      // one that is no length leaves the <img>'s, and so its ratio
      '<picture><source srcset="large.png" width="wide" height="10">' +
      img('x') +
      '<picture><source srcset="large.png" width="50%" height="10">' +
      img('p') +
      // a source with neither, one not chosen, and one after the <img>
      '<picture><source srcset="large.png">' +
      img('n') +
      '<picture><source type="image/x-none" srcset="large.png" width="50" height="10">' +
      img('t') +
      '<picture><img id="f" src="small.png" width="30" height="30">' +
      '<source srcset="large.png" width="50" height="10"></picture>' +
      // and an image that never comes takes the ratio the source gives
      '<picture><source srcset="gone.png" width="40" height="10">' +
      img('g', ' style="width:20px;height:auto"'),
    { 'small.png': SMALL, 'large.png': LARGE },
    { width: 400 },
  );
  assert.deepStrictEqual(size('w'), [50, 25]);
  assert.deepStrictEqual(size('h'), [20, 10]);
  assert.deepStrictEqual(size('x'), [30, 10]);
  assert.deepStrictEqual(size('p'), [200, 10], 'half the column');
  assert.deepStrictEqual(size('n'), [30, 30]);
  assert.deepStrictEqual(size('t'), [30, 30]);
  assert.deepStrictEqual(size('f'), [30, 30]);
  assert.deepStrictEqual(size('g'), [20, 5]);
});

/** WordPress 6.7's lazy image: `auto`, and the sizes for a browser without
 *  it, which is any image that is not lazy. */
const wordpress = (id: string, lazy = true) =>
  `<img id="${id}" ${lazy ? 'loading="lazy" ' : ''}width="40" height="20" ` +
  'sizes="auto, (max-width: 40px) 100vw, 40px" ' +
  'srcset="small.png 20w, large.png 40w" src="large.png" ' +
  'style="max-width:100%;height:auto">';

test('an image whose sizes is auto is chosen for the width it is laid out at, and nothing else is asked for', async () => {
  const images = { 'small.png': SMALL, 'large.png': LARGE };
  const lazy = await choosing(
    `<div style="width:20px">${wordpress('a')}</div>`,
    images,
  );
  assert.deepStrictEqual(lazy.asked, ['small.png'], 'the 20w for 20 pixels');
  assert.deepStrictEqual(lazy.size('a'), [20, 10]);
  cleanup();
  // 20 CSS pixels at 2x: the 40w
  const at2 = await choosing(
    `<div style="width:20px">${wordpress('a')}</div>`,
    images,
    { scale: 2 },
  );
  assert.deepStrictEqual(at2.asked, ['large.png']);
  assert.deepStrictEqual(at2.size('a'), [40, 20]);
  cleanup();
  // an image that is not lazy has no auto: its 40px, as Firefox and WebKit
  // have it, where Chrome 154 takes 100vw
  const eager = await choosing(
    `<div style="width:20px">${wordpress('a', false)}</div>`,
    images,
  );
  assert.deepStrictEqual(eager.asked, ['large.png']);
  assert.deepStrictEqual(eager.size('a'), [20, 10]);
});

test("auto: in a lazy image's sizes as written, a source's with none, at 2x and in no box at all", async () => {
  const set = 'srcset="small.png 20w, large.png 40w"';
  const images = { 'small.png': SMALL, 'large.png': LARGE };
  const { asked } = await choosing(
    // 15 pixels wide: the 20w, where auto is; the 40w, for 30px, where not
    `<img loading="lazy" sizes="auto, 30px" ${set} style="width:15px;height:5px">` +
      `<img sizes="auto, 30px" srcset="a.png 20w, b.png 40w" style="width:15px;height:5px">` +
      `<img loading="lazy" sizes=" auto, 30px" srcset="c.png 20w, d.png 40w" style="width:15px;height:5px">` +
      // a <source> with no sizes before a lazy image's auto is auto
      `<picture><source srcset="e.png 20w, f.png 40w">` +
      `<img loading="lazy" sizes="auto" src="g.png" style="width:15px;height:5px"></picture>` +
      // and an image with no box is passed over to the size after it
      `<img loading="lazy" sizes="auto, 30px" srcset="h.png 20w, i.png 40w" style="display:none">`,
    images,
  );
  // the images that are not auto as the boxes are built, and those that
  // are once they are laid out
  assert.deepStrictEqual(asked, [
    'b.png',
    'd.png',
    'small.png',
    'e.png',
    'i.png',
  ]);
  cleanup();
  // the width is in CSS pixels: 10 of them at 2x is the 20w
  const at2 = await choosing(
    `<img loading="lazy" sizes="auto" ${set} style="width:10px;height:5px">`,
    images,
    { scale: 2 },
  );
  assert.deepStrictEqual(at2.asked, ['small.png']);
});

test("an image whose sizes is auto is laid out as though it had none, over any rule of the page, so its width is no candidate's", async () => {
  // HTML's `contain: size !important` and `contain-intrinsic-size: 300px
  // 150px` for it: with no size of its own it is 300 by 150 whichever
  // candidate it holds, and a page cannot take that back
  const doc = await choosing(
    '<style>img{contain:none !important}</style>' +
      '<img id="a" loading="lazy" sizes="auto" srcset="small.png 20w, large.png 40w">' +
      '<img id="b" loading="lazy" sizes="auto" srcset="small.png 20w, large.png 40w" ' +
      'style="width:25px;height:15px;object-fit:none">' +
      // and in a flex row, whose item's height was the 40w's ratio's
      '<div style="display:flex;width:60px">' +
      '<img id="c" loading="lazy" sizes="auto" srcset="small.png 20w, large.png 40w" ' +
      'style="flex:1;min-width:0"></div>',
    { 'small.png': SMALL, 'large.png': LARGE },
  );
  assert.deepStrictEqual(doc.size('a'), [300, 150]);
  assert.deepStrictEqual(doc.size('b'), [25, 15]);
  assert.deepStrictEqual(doc.size('c'), [60, 150]);
  // what it holds is the 40w at 40/25x, 25 by 12.5: what `object-fit:
  // none` draws, built again for once it was picked
  const held = boxOf(doc.el(), 'b') as unknown as {
    intrinsic: { width: number; height: number };
  };
  assert.deepStrictEqual(
    [held.intrinsic.width, held.intrinsic.height],
    [25, 12.5],
  );
  assert.deepStrictEqual(doc.asked, ['large.png']);
});

test('an image whose sizes is auto is chosen again as its width moves, and picking settles', async () => {
  const doc = await choosing(
    '<img id="a" loading="lazy" sizes="auto" srcset="small.png 20w, large.png 40w" ' +
      'style="width:50%;height:10px">',
    { 'small.png': SMALL, 'large.png': LARGE },
    { width: 40 },
  );
  const el = doc.el() as unknown as {
    _chooseLaidOut(tree: unknown): boolean;
    _invalidate(stale: number): void;
  };
  const picked: boolean[] = [];
  const real = el._chooseLaidOut.bind(el);
  el._chooseLaidOut = (tree) => {
    const changed = real(tree);
    picked.push(changed);
    return changed;
  };
  assert.deepStrictEqual(doc.asked, ['small.png']);
  await doc.resize(80);
  assert.deepStrictEqual(doc.asked, ['small.png', 'large.png']);
  // what it draws changed once, for the boxes built again around it, and
  // that build's layout picked nothing anew
  assert.deepStrictEqual(picked, [true]);
  // a layout at the same width picks the same, and builds nothing
  el._invalidate(1);
  await act();
  assert.deepStrictEqual(picked, [true, false]);
  // and narrower again: the 40w in hand, at 2x, as for any width
  await doc.resize(40);
  assert.deepStrictEqual(doc.asked, ['small.png', 'large.png']);
  const box = boxOf(doc.el(), 'a') as unknown as {
    intrinsic: { width: number };
  };
  assert.strictEqual(box.intrinsic.width, 20);
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
  "an SVG's currentcolor and none are paint keywords in any case",
  async () => {
    // CSS Values 4, 2.5: Apple's tab strips draw their arrows with
    // `fill="currentcolor"`, as CSS Color 4 writes the keyword, and drew
    // none, since ntk took it for a colour nobody knows (sidorares/ntk#554)
    const { result } = await renderWithBytes(
      '<style>body{margin:0}svg{display:block}</style>' +
        '<div style="color:#ff00ff"><svg width="10" height="10">' +
        '<rect width="10" height="10" fill="currentcolor"/></svg></div>' +
        '<div style="color:#00ff00"><svg width="10" height="10">' +
        '<rect width="10" height="10" fill="CURRENTCOLOR"/></svg></div>' +
        '<svg width="10" height="10"><rect width="10" height="10" fill="NONE"/></svg>',
      {},
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 5, 5, '#ff00ff', { message: 'currentcolor' });
    await expectPixel(ctx, 5, 15, '#00ff00', { message: 'CURRENTCOLOR' });
    await expectPixel(ctx, 5, 25, '#ffffff', { message: 'NONE fills nothing' });
  },
);

metric(
  'an SVG geometry attribute that is a math function is of the viewport, as a percentage is',
  async () => {
    // SVG 2's geometry properties take a <length-percentage>, and a
    // presentation attribute is read as CSS: `width="calc(100% - 1px)"` is
    // the viewport's width less a pixel. SvgView reads no math function,
    // and a dashed border drawn as such a rect drew nothing.
    const { result } = await renderWithBytes(
      '<style>body{margin:0}svg{display:block}</style>' +
        // x 10% + 2px of 300 is 32, and the width 300 less 64 is 236
        '<svg height="20" style="width:300px"><rect x="calc(10% + 2px)" ' +
        'width="calc(100% - 64px)" height="calc(50% + 0.25in)" ' +
        'fill="#00ff00"/></svg>' +
        // the least of the two, 40
        '<svg height="20" style="width:300px"><rect ' +
        'width="min(100%, 40px)" height="100%" fill="#0000ff"/></svg>',
      {},
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 31, 10, '#ffffff', { message: 'before 32' });
    await expectPixel(ctx, 33, 10, '#00ff00', { message: 'from 32' });
    await expectPixel(ctx, 267, 10, '#00ff00', { message: 'to 268' });
    await expectPixel(ctx, 269, 10, '#ffffff', { message: 'past 268' });
    // 50% of 20 and a quarter of an inch: past the viewport, and clipped
    await expectPixel(ctx, 100, 19, '#00ff00', { message: 'all the way down' });
    await expectPixel(ctx, 39, 30, '#0000ff', { message: 'min(), to 40' });
    await expectPixel(ctx, 41, 30, '#ffffff', { message: 'min(), past 40' });
  },
);

metric(
  "a stroke is dashed as its stroke-dasharray and stroke-dashoffset say, from an attribute or a document's rule",
  async () => {
    // ntk's SvgView dashes a stroke from 8.25.0 (sidorares/ntk#548); a rule
    // of the document's reaches a shape through the drawing's cascade
    // (`shapes.ts`), which carries the two as user units
    const line = (attrs = '') =>
      '<svg width="100" height="10"><line x1="0" y1="5" x2="100" y2="5" ' +
      `stroke="#000000" stroke-width="4" ${attrs}/></svg>`;
    const { result } = await renderWithBytes(
      '<style>body{margin:0} svg{display:block}' +
        '.d line{stroke-dasharray:10px,10px;stroke-dashoffset:5}' +
        '.e line{stroke-dasharray:4 -1}</style>' +
        line('stroke-dasharray="10 10"') +
        `<div class="d">${line()}</div>` +
        `<div class="e">${line()}</div>`,
      {},
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 5, 5, '#000000', { message: 'a dash' });
    await expectPixel(ctx, 15, 5, '#ffffff', { message: 'a gap' });
    await expectPixel(ctx, 25, 5, '#000000', { message: 'the next dash' });
    // 5 into the pattern: a dash to 5, a gap to 15, a dash to 25
    await expectPixel(ctx, 2, 15, '#000000', { message: 'offset, a dash' });
    await expectPixel(ctx, 10, 15, '#ffffff', { message: 'offset, a gap' });
    await expectPixel(ctx, 20, 15, '#000000', { message: 'offset, a dash' });
    // a negative length is an error, and the stroke is solid
    await expectPixel(ctx, 6, 25, '#000000', { message: 'solid' });
    await expectPixel(ctx, 50, 25, '#000000', { message: 'solid' });
  },
);

metric(
  "an inline drawing inherits its stroke's width and dashes from the document around it, its math worked out",
  async () => {
    // SVG 2, 13: `stroke-width`, `stroke-dasharray` and their kin inherit,
    // so a rule on a `<div>` reaches the lines of an `<svg>` in it — WPT's
    // zoom/stroke sets them so, its reference with `calc()` and a `var()`
    const line =
      '<svg width="100" height="20"><line x1="0" y1="10" x2="100" y2="10"/></svg>';
    const { result } = await renderWithBytes(
      '<style>body{margin:0} svg{display:block}' +
        '.d{--k:2;stroke:#000000;stroke-width:calc(5px * var(--k));stroke-dasharray:calc(5px * var(--k))}</style>' +
        `<div class="d">${line}${line.replace('<svg ', '<svg stroke-width="2" ')}</div>`,
      {},
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 5, 6, '#000000', { message: 'ten wide, a dash' });
    await expectPixel(ctx, 15, 10, '#ffffff', { message: 'a gap' });
    await expectPixel(ctx, 25, 14, '#000000', { message: 'the next dash' });
    // an attribute of the drawing's own is over what it inherits
    await expectPixel(ctx, 5, 30, '#000000', { message: 'its own width' });
    await expectPixel(ctx, 5, 26, '#ffffff', { message: 'two wide' });
  },
);

for (const scale of [1, 2]) {
  metric(
    `zoom draws an inline drawing as one four times its size, its lengths in every unit, its strokes and its text with it, at ${scale}x`,
    async () => {
      // WPT's zoom/svg.html: a drawing under two zooms of 2 is the drawing
      // four times the size with every number in it four times as large.
      // Its user unit is a CSS pixel, so a `2.5em` is of its font size, a
      // `5rem` of the root's and a `1vw` of the viewport, all unzoomed, and
      // a rule's stroke and font are in user units too. SvgView read the
      // three units as the number before them, and a rule's `font` was
      // none: the text was set in what it inherited, 80px here and 20 in
      // the reference
      const style = (k: number) =>
        `<style>:root{font-size:10px${k === 1 ? ';zoom:2' : ''}}` +
        'body{margin:0}svg{display:block;background:#ff0000}' +
        '.container{font-size:20px}' +
        (k === 1 ? '.child{zoom:2}' : '') +
        `line{stroke:#00ff00;stroke-width:${10 * k}px}` +
        `.e{stroke-width:${0.5 * k}em}` +
        `polygon,text{fill:#00ff00}text{font:${10 * k}px/1 sans-serif}</style>`;
      const test =
        style(1) +
        '<div class="container"><div class="child">' +
        '<svg width="100" height="100">' +
        '<rect width="10rem" height="100" fill="#0000ff"/>' +
        '<line y1="0" y2="0" x1="0" x2="50"/>' +
        '<line y1="10" y2="10" x1="0" x2="2.5em"/>' +
        '<line y1="20" y2="20" x1="0" x2="5rem"/>' +
        '<line y1="30" y2="30" x1="0" x2="50%"/>' +
        '<line y1="40" y2="40" x1="0" x2="1vw"/>' +
        '<line class="e" y1="55" y2="55" x1="60" x2="70"/>' +
        '<polygon points="0,60 50,60 50,70 0,70"/>' +
        '<text x="80" y="60">X</text></svg></div></div>';
      const reference =
        style(4) +
        '<div class="container"><svg width="400" height="400">' +
        '<rect width="400" height="400" fill="#0000ff"/>' +
        '<line y1="0" y2="0" x1="0" x2="200"/>' +
        '<line y1="40" y2="40" x1="0" x2="10em"/>' +
        '<line y1="80" y2="80" x1="0" x2="20rem"/>' +
        '<line y1="120" y2="120" x1="0" x2="50%"/>' +
        '<line y1="160" y2="160" x1="0" x2="4vw"/>' +
        '<line class="e" y1="220" y2="220" x1="240" x2="280"/>' +
        '<polygon points="0,240 200,240 200,280 0,280"/>' +
        '<text x="320" y="240">X</text></svg></div>';
      const area = { x: 0, y: 0, width: 400 * scale, height: 400 * scale };
      const drawn = async (source: string) => {
        const { result } = await renderWithBytes(source, {}, 400, scale);
        await act();
        const pixels = await pixelsIn(result.ctx, area);
        cleanup();
        return pixels;
      };
      const ours = await drawn(test);
      const theirs = await drawn(reference);
      const at = (px: Uint8ClampedArray, x: number, y: number): string => {
        const i = (y * scale * area.width + x * scale) * 4;
        return [px[i], px[i + 1], px[i + 2]]
          .map((c) => c.toString(16).padStart(2, '0'))
          .join('');
      };
      // what the reference draws is what CSS has it draw: an em of 20px,
      // a rem of 10 and a vw of 4, a stroke 40 wide, the text 40px tall
      assert.strictEqual(at(theirs, 190, 45), '00ff00', 'ten ems');
      assert.strictEqual(at(theirs, 210, 45), '0000ff', 'and no more');
      assert.strictEqual(at(theirs, 190, 85), '00ff00', 'twenty rems');
      assert.strictEqual(at(theirs, 14, 165), '00ff00', 'four vw');
      assert.strictEqual(at(theirs, 18, 165), '0000ff', 'of 400px');
      assert.strictEqual(at(theirs, 260, 202), '00ff00', 'two ems wide');
      let rows = 0;
      for (let y = 180; y < 260; y += 1) {
        for (let x = 300; x < 380; x += 1) {
          if (at(theirs, x, y) === '00ff00') {
            rows += 1;
            break;
          }
        }
      }
      assert.ok(rows > 24 && rows < 34, `an X 40px tall, not ${rows} rows`);
      // and the zoomed drawing is that, pixel for pixel
      assert.strictEqual(bytesApart(ours, theirs), 0, 'drawn as the reference');
    },
  );
}

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
  'a drawing is cut to the clipPath its clip-path names, through a use in it as Illustrator writes one, in an image and inline',
  async () => {
    // CSS Zen Garden 215's arm in a circle: an Illustrator drawing whose
    // shapes are cut to a `<use>` of a circle (CSS Masking 1, 6). ntk drew
    // no clip path at all, and the arm reached out of its circle. Inline,
    // a rule that reaches into a drawing has it drawn from a copy, where a
    // `<use>` was a group, which a clipPath takes nothing from; and one in
    // a clipPath may name an element of another drawing, as a `<use>`
    // anywhere may.
    const arm = (id: string) =>
      `<defs><circle id="${id}c" cx="10" cy="10" r="8"/></defs>` +
      `<clipPath id="${id}k"><use xlink:href="#${id}c" overflow="visible"/></clipPath>` +
      `<rect width="20" height="20" fill="#ff0000" clip-path="url(#${id}k)"/>`;
    const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
    const { result } = await renderWithBytes(
      '<style>body{margin:0}svg,div{display:block} .ruled rect{stroke:none}' +
        ' .cut{clip-path:url(#ck)} .eo{clip-rule:evenodd}</style>' +
        // an SVG image, as 215's `::after` draws it
        '<div style="width:20px;height:20px;background:url(arm.svg)"></div>' +
        `<svg class="ruled" width="20" height="20" ${XLINK}>${arm('a')}</svg>` +
        '<svg style="display:none"><circle id="far" cx="10" cy="10" r="8"/></svg>' +
        '<svg width="20" height="20"><clipPath id="bk"><use href="#far"/></clipPath>' +
        '<rect width="20" height="20" fill="#ff0000" clip-path="url(#bk)"/></svg>' +
        // what the rules give a clip path and what is in one
        '<svg width="20" height="20"><clipPath id="ck">' +
        '<path class="eo" d="M2 2h16v16h-16zM6 6h8v8h-8z"/></clipPath>' +
        '<rect class="cut" width="20" height="20" fill="#ff0000"/></svg>',
      {
        'arm.svg': svgBytes(
          `<svg ${SVG_NS} ${XLINK} width="20" height="20">${arm('i')}</svg>`,
        ),
      },
    );
    const ctx = result.ctx;
    for (const [y, what] of [
      [0, 'an image'],
      [20, 'inline, with a rule that reaches it'],
      [40, 'its use naming the circle of another drawing'],
    ] as const) {
      await expectPixel(ctx, 10, y + 10, '#ff0000', {
        message: `${what}: inside the circle`,
      });
      await expectPixel(ctx, 2, y + 18, '#ffffff', {
        message: `${what}: a corner it leaves out`,
      });
    }
    await expectPixel(ctx, 4, 64, '#ff0000', { message: 'a ring' });
    await expectPixel(ctx, 10, 70, '#ffffff', { message: 'its hole, evenodd' });
    await expectPixel(ctx, 19, 79, '#ffffff', { message: 'outside it' });
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
  "a sprite's symbol a rule styles is drawn as more of it arrives",
  async () => {
    // the sprite after the icons, and its symbol cut between two chunks
    const icon =
      '<style>body{margin:0}svg{display:block} symbol .a{fill:#00aa00}' +
      '</style><svg width="12" height="12"><use href="#late"/></svg><p>text</p>';
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
    await expectPixel(result.ctx, 3, 6, '#ffffff', { message: 'not yet' });
    const half =
      icon +
      '<svg style="display:none"><symbol id="late" viewBox="0 0 2 2">' +
      '<rect class="a" width="1" height="2" fill="#ff0000"/>';
    await act(() => result.rerender(doc(half)));
    await expectPixel(result.ctx, 3, 6, '#00aa00', { message: 'its first' });
    await expectPixel(result.ctx, 9, 6, '#ffffff', { message: 'and no more' });
    await act(() =>
      result.rerender(
        doc(
          half +
            '<rect class="a" x="1" width="1" height="2" fill="#ff0000"/>' +
            '</symbol></svg>',
        ),
      ),
    );
    await expectPixel(result.ctx, 9, 6, '#00aa00', { message: 'its second' });
  },
);

metric(
  "a sprite's symbol is drawn as more of it arrives, with no rule for it",
  async () => {
    // The symbol cut between two chunks, as the test above has it, and no
    // rule to restyle anything when the second lands: what the copy was
    // made from has to say so itself. The first copy found the symbol with
    // one of its rects, and the icon kept only that one for good.
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
    await expectPixel(result.ctx, 3, 6, '#ffffff', { message: 'not yet' });
    const half =
      icon +
      '<svg style="display:none"><symbol id="late" viewBox="0 0 2 2">' +
      '<rect width="1" height="2" fill="#0000ff"/>';
    await act(() => result.rerender(doc(half)));
    await expectPixel(result.ctx, 3, 6, '#0000ff', { message: 'its first' });
    await expectPixel(result.ctx, 9, 6, '#ffffff', { message: 'and no more' });
    await act(() =>
      result.rerender(
        doc(
          half +
            '<rect x="1" width="1" height="2" fill="#0000ff"/></symbol></svg>',
        ),
      ),
    );
    await expectPixel(result.ctx, 9, 6, '#0000ff', { message: 'its second' });
    await expectPixel(result.ctx, 3, 6, '#0000ff', {
      message: 'and its first',
    });
  },
);

metric(
  'a drawing read from a copy is drawn as more of a group or a text in it arrives',
  async () => {
    // A percentage has the drawing read from a copy, and a chunk that ends
    // inside a group of it leaves the root's last child as it was. A chunk
    // that ends inside a text leaves even the last node as it was: the
    // next one's text goes on the end of it.
    const doc = (source: string) =>
      h(
        'box',
        { style: { width: 300, flexDirection: 'column' } },
        h(Html, {
          source:
            '<style>body{margin:0}svg{display:block}</style>' +
            '<svg width="200" height="24"><g>' +
            '<rect width="5%" height="4" fill="#0000ff"/>' +
            source,
        }),
      );
    const result = await renderX11(doc(''), {
      width: 340,
      height: 200,
      fonts: FONTS!,
    });
    await expectPixel(result.ctx, 5, 2, '#0000ff', { message: 'its first' });
    await expectPixel(result.ctx, 105, 2, '#ffffff', { message: 'no more' });
    const second = '<rect x="50%" width="5%" height="4" fill="#0000ff"/>';
    await act(() => result.rerender(doc(second)));
    await expectPixel(result.ctx, 105, 2, '#0000ff', { message: 'its second' });
    // one letter, and then ten more of the same text
    const text = second + '<text y="22" font-size="16" fill="#ff0000">M';
    const red = async (x: number, width: number) => {
      const data = await pixelsIn(result.ctx, { x, y: 6, width, height: 18 });
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] < 80) n += 1;
      }
      return n;
    };
    await act(() => result.rerender(doc(text)));
    assert.ok((await red(0, 60)) > 0, 'the letter');
    assert.strictEqual(await red(60, 140), 0, 'and nothing past it');
    await act(() => result.rerender(doc(text + 'MMMMMMMMMM')));
    assert.ok((await red(60, 140)) > 0, 'the rest of the text');
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
        svg(rect('class="g" fill="var(--brand)"')),
        '#00aa00',
        'over an attribute with a variable',
      ],
      [svg(rect('fill="var(--brand)"')), '#ff00ff', 'and the attribute'],
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
      // a rule kept by a class that names an ancestor, of every element it
      // matches, where it gave the first and none after it
      [
        `<div class="scope">${svg(rect('class="kept"'))}</div>`,
        '#00aa00',
        'a class under a class',
      ],
      [
        `<div class="scope">${svg(rect('class="kept"'))}</div>`,
        '#00aa00',
        'and the next it matches',
      ],
      [svg(rect('class="kept"')), '#000000', 'and not outside the class'],
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
        '.sib + g rect{fill:#00aa00} .off rect{fill:#ff0000}' +
        '.scope .kept{fill:#00aa00}</style>' +
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
  'a var() in a presentation attribute is the custom property it names',
  async () => {
    // A presentation attribute is a declaration (SVG 2, 6.2), and its
    // value is CSS, `var()` and all, as Chrome, Firefox and WebKit read
    // it. `SvgView` reads the attribute as written, and a `var()` is no
    // colour: a callout's corner, `fill="var(--color-page-background)"`,
    // was drawn black on macOS and not at all on X11, and so were the
    // clouds of the page it is on. This document has no rule that reaches
    // a shape, which is where the attributes were never looked at.
    const rect = (attrs = '') => `<rect width="10" height="10" ${attrs}/>`;
    const svg = (inside: string, attrs = '') =>
      `<svg width="10" height="10" ${attrs}>${inside}</svg>`;
    const rows: [string, string, string, number?][] = [
      [svg(rect('fill="var(--g)"')), '#00aa00', 'a variable'],
      [
        svg(`<g fill="#0000ff">${rect('fill="var(--none)"')}</g>`),
        '#0000ff',
        'one that names none is as though unset',
      ],
      [
        svg(`<g fill="#0000ff">${rect('fill="var(--wide)"')}</g>`),
        '#0000ff',
        'and so is one that is no colour',
      ],
      [svg(rect('fill="var(--none, #ff00ff)"')), '#ff00ff', 'a fallback'],
      [
        svg(rect('style="fill:var(--g)" fill="#ff0000"')),
        '#00aa00',
        'in a style, over the attribute',
      ],
      [
        svg(`<g style="--b:#0000ff">${rect('fill="var(--b)"')}</g>`),
        '#0000ff',
        'a custom property set in the drawing',
      ],
      [
        svg(rect('fill="none" stroke="var(--g)" stroke-width="var(--w, 4)"')),
        '#00aa00',
        'a stroke and its width',
        1,
      ],
      [
        svg(rect('fill="none" stroke="var(--g)" stroke-width="var(--w, 4)"')),
        '#ffffff',
        'and no fill',
      ],
      [svg(rect(), 'fill="var(--g)"'), '#00aa00', "the root's"],
      [svg(rect(), 'fill="var(--none)"'), '#000000', 'and one unset'],
      [svg('<use href="#sym"/>'), '#00aa00', 'what a <use> draws'],
    ];
    const { result } = await renderWithBytes(
      '<style>body{margin:0} svg{display:block}' +
        ':root{--g:#00aa00;--wide:10px}</style>' +
        '<svg width="0" height="0" style="position:absolute">' +
        `<symbol id="sym">${rect('fill="var(--g)"')}</symbol></svg>` +
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
  'an inline SVG an application changed is drawn as it is now after refresh()',
  async () => {
    // A drawing was kept by its element, and handed `SvgView` its tree
    // again only where a stream had added to it — and `SvgView` reads the
    // root's `viewBox` and the ids its `url()`s name as it is handed the
    // tree. So a `viewBox` an application changed, and a `refresh()`, was
    // fitted to the box as the new one and drawn through as the old, and a
    // gradient given an id was no paint server; and what of a shape's
    // attributes had a `var()` in it was kept by the element as well: one
    // taken out was still substituted, and one put in was not.
    const rect = (id: string, fill: string) =>
      `<svg width="10" height="10">` +
      `<rect id="${id}" width="10" height="10" fill="${fill}"/></svg>`;
    const { result, el } = await renderWithBytes(
      '<style>body{margin:0} svg{display:block} :root{--g:#00aa00}</style>' +
        rect('a', '#ff0000') +
        rect('b', 'var(--g)') +
        rect('c', '#ff0000') +
        '<svg id="d" width="10" height="10" viewBox="0 0 20 20">' +
        '<rect width="10" height="10" fill="#00aa00"/></svg>' +
        '<svg width="10" height="10"><defs><linearGradient id="x">' +
        '<stop offset="0" stop-color="#00aa00"/>' +
        '<stop offset="1" stop-color="#00aa00"/></linearGradient></defs>' +
        '<rect id="e" width="10" height="10" fill="#ff0000"/></svg>',
      {},
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 5, 5, '#ff0000');
    await expectPixel(ctx, 5, 15, '#00aa00');
    await expectPixel(ctx, 5, 25, '#ff0000');
    await expectPixel(ctx, 7, 37, '#ffffff');
    await expectPixel(ctx, 5, 45, '#ff0000');
    const set = (id: string, name: string, value: string) => {
      (findById(el.document, id) as unknown as Element).attribs[name] = value;
    };
    set('a', 'fill', '#0000ff');
    set('b', 'fill', '#0000ff');
    set('c', 'fill', 'var(--g)');
    // the parser lowercased it, as an HTML parse does
    set('d', 'viewbox', '0 0 10 10');
    set('x', 'id', 'g');
    set('e', 'fill', 'url(#g)');
    el.touchDocument();
    await act();
    await expectPixel(ctx, 5, 5, '#0000ff', { message: 'a shape changed' });
    await expectPixel(ctx, 5, 15, '#0000ff', { message: 'a var() taken out' });
    await expectPixel(ctx, 5, 25, '#00aa00', { message: 'and one put in' });
    await expectPixel(ctx, 7, 37, '#00aa00', { message: 'its viewBox' });
    await expectPixel(ctx, 5, 45, '#00aa00', { message: 'a paint server' });
  },
);

metric(
  'an SVG image is painted as its own style sheets say, and the page’s rules stay out of it',
  async () => {
    // An SVG image is a document of its own, and its `<style>` elements are
    // its style sheets: a drawing exported from Illustrator has its colours
    // in `.st0 { fill: … }`, and was drawn all black, since only the
    // attributes were read. No rule of the page's reaches into an image,
    // and `prefers-color-scheme` in one answers the colour scheme of the
    // element that embeds it, as Chrome has them.
    const svg = (sheet: string, shapes: string) =>
      svgBytes(
        `<svg ${SVG_NS} width="30" height="20" viewBox="0 0 30 20">` +
          `${sheet}${shapes}</svg>`,
      );
    const rect = (x: number, attrs = '') =>
      `<rect x="${x}" width="10" height="20" ${attrs}/>`;
    const images = {
      'st.svg': svgBytes(
        '<?xml version="1.0" encoding="utf-8"?>\n' +
          '<!-- Generator: Adobe Illustrator 27.0.0 -->\n' +
          `<svg version="1.1" ${SVG_NS} viewBox="0 0 30 20" ` +
          'xml:space="preserve">\n<style type="text/css">\n' +
          '\t.st0{fill:#00AA00;}\n\t.st1{fill:#0000FF;}\n</style>\n' +
          `${rect(0, 'class="st0"')}${rect(10, 'class="st1"')}` +
          `${rect(20, 'class="st0"')}</svg>`,
      ),
      'cdata.svg': svg(
        '<defs><style><![CDATA[ g > .a { fill: #00aa00 } ' +
          '/* a < in the text */ .b { fill: #0000ff } ]]></style></defs>',
        `<g>${rect(0, 'class="a"')}${rect(10, 'class="b"')}</g>`,
      ),
      'root.svg': svg(
        '<style>:root { --c: #ff00ff; color: #0000ff } svg { fill: #00aa00 }' +
          ' .v { fill: var(--c) } .c { fill: currentColor }</style>',
        rect(0) + rect(10, 'class="v"') + rect(20, 'class="c"'),
      ),
      'scheme.svg': svg(
        '<style>rect { fill: #0000ff } @media (prefers-color-scheme: dark) ' +
          '{ rect { fill: #ff00ff } }</style>',
        rect(0) + rect(10) + rect(20),
      ),
      'media.svg': svg(
        '<style>.a { fill: #0000ff } @media (max-width: 20px) ' +
          '{ .a { fill: #00aa00 } }</style>' +
          '<style type="text/plain">.a { fill: #ff0000 }</style>' +
          '<style media="(prefers-color-scheme: dark)">.a { fill: #ff0000 }' +
          '</style>',
        rect(0, 'class="a"') + rect(10, 'class="a"') + rect(20, 'class="a"'),
      ),
      'bare.svg': svg(
        '',
        rect(0, 'class="st0" fill="#00aa00"') + rect(10, 'fill="#0000ff"'),
      ),
      // a `var()` in an attribute, and no sheet: its fallback, and what a
      // `style` in the image sets — the page's `--c` stays out of it
      'vars.svg': svg(
        '',
        rect(0, 'fill="var(--none, #00aa00)"') +
          `<g style="--c:#0000ff">${rect(10, 'fill="var(--c)"')}</g>` +
          `<g fill="#00aa00">${rect(20, 'fill="var(--c)"')}</g>`,
      ),
    };
    // the element an image's URL names by its fragment is its `:target`,
    // which a sprite sheet shows its icons with
    const target = svg(
      '<style>.t { fill: #0000ff } .t:target { fill: #00aa00 } ' +
        '.u:not(:target) { fill: #ff00ff }</style>',
      `<g id="on" class="t">${rect(0)}</g><g class="t">${rect(10)}</g>` +
        `<g class="u">${rect(20)}</g>`,
    );
    Object.assign(images, { 'target.svg': target, 'target.svg#on': target });
    const rows: [string, string[], string][] = [
      ['<img src="st.svg">', ['#00aa00', '#0000ff'], 'its own style sheet'],
      [
        '<div class="bg"></div>',
        ['#00aa00', '#0000ff', '#00aa00'],
        'and a background',
      ],
      ['<img src="cdata.svg">', ['#00aa00', '#0000ff'], 'a CDATA section'],
      [
        '<img src="root.svg">',
        ['#00aa00', '#ff00ff', '#0000ff'],
        "its root's fill, a variable and colour",
      ],
      ['<img src="scheme.svg">', ['#0000ff'], 'a light scheme'],
      ['<img class="dark" src="scheme.svg">', ['#ff00ff'], 'a dark one'],
      ['<img src="media.svg">', ['#0000ff', '#0000ff'], 'its viewport, wide'],
      ['<img class="n" src="media.svg">', ['#00aa00'], 'and narrow'],
      ['<img src="bare.svg">', ['#00aa00', '#0000ff'], 'no sheet of its own'],
      [
        '<img src="vars.svg">',
        ['#00aa00', '#0000ff', '#00aa00'],
        'a variable in an attribute',
      ],
      [
        '<img src="target.svg#on">',
        ['#00aa00', '#0000ff', '#ff00ff'],
        "the element its URL's fragment names",
      ],
      [
        '<img src="target.svg">',
        ['#0000ff', '#0000ff', '#ff00ff'],
        'and none where it names none',
      ],
    ];
    const { result } = await renderWithBytes(
      '<style>body{margin:0} img,div{display:block;width:30px;height:20px}' +
        '.bg{background:url(st.svg)} .dark{color-scheme:dark} .n{width:20px}' +
        // what would reach into an image, if anything did
        ' svg,rect,.st0,.st1,.a,.b,g>rect{fill:#ff0000 !important;' +
        'stroke:none !important;color:#ff0000}' +
        ':root{--c:#ff0000}</style>' +
        rows.map(([markup]) => markup).join(''),
      images,
    );
    const ctx = result.ctx;
    for (const [i, [, colours, message]] of rows.entries()) {
      for (const [j, colour] of colours.entries()) {
        await expectPixel(ctx, j * 10 + 5, i * 20 + 10, colour, {
          message: `${message}, ${j}`,
        });
      }
    }
  },
);

metric(
  'an SVG image with no viewBox is stretched from its own size to its box',
  async () => {
    // Blink gives one a `viewBox` of its own size, fitted with
    // `preserveAspectRatio: none`, an axis at a time: an icon of
    // `width="20" height="20"` shown 60 wide was a third of its box, and
    // one with no height is laid out down the box's
    const sq = (attrs: string, shape: string) =>
      svgBytes(`<svg ${SVG_NS} ${attrs}>${shape}</svg>`);
    const { result } = await renderWithBytes(
      '<style>body{margin:0} img{display:block;width:60px;height:20px}' +
        '</style><img src="wh.svg"><img src="w.svg"><img src="vb.svg">',
      {
        'wh.svg': sq(
          'width="20" height="20"',
          '<rect width="20" height="20" fill="#00aa00"/>',
        ),
        'w.svg': sq(
          'width="20"',
          '<rect width="20" height="10" fill="#0000ff"/>',
        ),
        // with one, it is fitted as before, and keeps its shape
        'vb.svg': sq(
          'width="20" height="20" viewBox="0 0 20 20"',
          '<rect width="20" height="20" fill="#ff00ff"/>',
        ),
      },
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 55, 10, '#00aa00', { message: 'stretched across' });
    await expectPixel(ctx, 55, 25, '#0000ff', {
      message: 'across, at its height',
    });
    await expectPixel(ctx, 55, 35, '#ffffff', { message: 'and not down' });
    await expectPixel(ctx, 30, 50, '#ff00ff', {
      message: 'fitted, in the middle',
    });
    await expectPixel(ctx, 5, 50, '#ffffff', { message: 'and not stretched' });
  },
);

metric(
  'a drawing finds a marker or a gradient its url(#…) names in another <svg>, styled where it stands',
  async () => {
    // A `url(#…)` names an element of the document, wherever it is (SVG 2,
    // 16.1). A flow editor draws each edge in an `<svg>` of its own and the
    // `<marker>`s of its arrowheads in another, and a page keeps its
    // gradients in a hidden one. `SvgView` looks a reference up among the
    // elements of the drawing it is handed, and every edge was drawn with
    // no arrowhead.
    const marker = (id: string, attrs: string, inside: string) =>
      `<marker id="${id}" ${attrs} viewBox="0 0 10 10" refY="5" ` +
      'markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse">' +
      `${inside}</marker>`;
    const square = (attrs = '') => `<path d="M0,0H10V10H0Z" ${attrs}/>`;
    // a line to x = 10, the marker the ten pixels past it
    const edge = (end: string) =>
      '<svg width="40" height="10"><path d="M0,5 L10,5" stroke="#000000" ' +
      `stroke-width="2" marker-end="${end}"/></svg>`;
    const rows: [string, string, string][] = [
      [edge("url('#var')"), '#ff0000', "its fill a var(), the page's"],
      [edge('url(#ruled)'), '#0000ff', 'a rule that names its marker'],
      [edge('url(#bare)'), '#000000', 'and no rule'],
      [edge('url(#nowhere)'), '#ffffff', 'and one that names nothing'],
      [
        '<svg width="40" height="10"><rect width="20" height="10" ' +
          'fill="url(#g)"/></svg>',
        '#00aa00',
        'a gradient, after the one it takes after',
      ],
    ];
    const { result } = await renderWithBytes(
      '<style>:root{--ink:#ff0000} body{margin:0} svg{display:block}' +
        '.arrows .ruled path{fill:#0000ff}</style>' +
        '<svg class="arrows" width="0" height="0" ' +
        'style="position:absolute"><defs>' +
        marker('var', '', square('style="fill: var(--ink)"')) +
        marker('ruled', 'class="ruled"', square()) +
        marker('bare', '', square()) +
        '<linearGradient id="g0"><stop stop-color="#00aa00"/></linearGradient>' +
        '<linearGradient id="g" href="#g0"/>' +
        '</defs></svg>' +
        rows.map(([markup]) => markup).join(''),
      {},
    );
    for (const [i, [, colour, message]] of rows.entries()) {
      const line = i < 4 ? '#000000' : colour;
      await expectPixel(result.ctx, 5, i * 10 + 5, line, {
        message: `${message}: the line`,
      });
      await expectPixel(result.ctx, 15, i * 10 + 5, colour, { message });
      await expectPixel(result.ctx, 25, i * 10 + 5, '#ffffff', {
        message: `${message}: no further`,
      });
    }
  },
);

metric(
  'an inline <svg> is cut to its box unless its overflow is visible, and is repainted where it draws past it',
  async () => {
    // Every engine's sheet cuts an inline drawing to its box
    // (`svg:not(:root) { overflow: hidden }`, SVG 2, 6.14), and a page that
    // sets `overflow: visible` shows what is past it, on the axes it sets
    // it on. A flow editor draws each edge in an `<svg>` of the default
    // size, 300 by 150, at the corner of its graph, and the edge wherever
    // it goes: the edges below the first 150 pixels were cut away. What it
    // draws past its box is the box's ink, so a hover that repaints what
    // is under it repaints it.
    const { result, node } = await render(
      '<style>body{margin:0} svg{position:absolute;left:0}' +
        '#under{position:absolute;top:60px;width:60px;height:40px}' +
        '#under:hover{background:#eeeeee}</style>' +
        '<div id="under"></div>' +
        // shown past its box both ways
        '<svg id="shown" style="top:0;overflow:visible" width="20" height="20">' +
        '<rect x="30" y="70" width="10" height="10" fill="#00aa00"/></svg>' +
        // cut across, with `clip`, and shown down
        '<svg style="top:120px;overflow-x:clip;overflow-y:visible" ' +
        'width="20" height="20">' +
        '<rect x="5" y="25" width="10" height="10" fill="#00aa00"/>' +
        '<rect x="25" width="10" height="10" fill="#ff0000"/></svg>' +
        // cut as the page says nothing, and with `auto`
        '<svg id="cut" style="top:180px" width="20" height="20">' +
        '<rect x="25" width="10" height="10" fill="#ff0000"/></svg>' +
        '<svg style="top:210px;overflow:auto" width="20" height="20">' +
        '<rect x="25" width="10" height="10" fill="#ff0000"/></svg>',
      200,
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 35, 75, '#00aa00', { message: 'past it both ways' });
    await expectPixel(ctx, 10, 150, '#00aa00', { message: 'shown down' });
    await expectPixel(ctx, 30, 125, '#ffffff', { message: 'cut across' });
    await expectPixel(ctx, 30, 185, '#ffffff', { message: 'cut by default' });
    await expectPixel(ctx, 30, 215, '#ffffff', { message: 'and with auto' });
    const el = view(node);
    const overflow = (id: string) =>
      (el.computedStyle(findById(el.document, id)!) as { overflow: string })
        .overflow;
    assert.strictEqual(overflow('cut'), 'hidden', "the sheet's");
    assert.strictEqual(overflow('shown'), 'visible', "the page's");
    // the pointer onto what is under the drawing, beside its rect
    const abs = (el as unknown as DrawnNode).abs;
    fireEvent.mouseMove(el as unknown as DrawnNode, {
      dx: 10 - abs.width / 2,
      dy: 95 - abs.height / 2,
    });
    await waitFor(() =>
      expectPixel(ctx, 10, 95, '#eeeeee', { message: 'the hover' }),
    );
    await expectPixel(ctx, 35, 75, '#00aa00', {
      message: 'and what the drawing draws over it, repainted',
    });
  },
);

test('what a drawing paints past its box takes in its strokes, markers, uses and transforms', () => {
  // The ink of an inline drawing whose overflow shows is as far as it
  // paints (`SvgDrawing.reach`): reaching less, a repaint of what is past
  // its box leaves that part out.
  const doc = parseDocument(
    '<svg id="d" width="20" height="20">' +
      '<defs><marker id="m" markerWidth="10" markerHeight="10" ' +
      'markerUnits="userSpaceOnUse"><path d="M0,0H10V10H0Z"/></marker>' +
      '<rect id="r" width="10" height="10"/></defs>' +
      '<g transform="translate(100,0)"><rect width="10" height="10"/></g>' +
      '<g marker-end="url(#m)"><path d="M0,0 V200" stroke-width="4"/></g>' +
      '<use href="#r" x="-50"/>' +
      '<text x="0" y="-30">ab</text></svg>',
  );
  const root = findById(doc, 'd')!;
  const r = inlineDrawing(root).reach(0, 0, 20, 20, 1, null, 16)!;
  assert.ok(
    r.x + r.width >= 110,
    `the group moved right: ${JSON.stringify(r)}`,
  );
  assert.ok(r.y + r.height >= 210, 'the stroke, and the marker at its end');
  assert.ok(r.x <= -50, 'what the use moved left');
  assert.ok(r.y <= -30 - 16, 'the text above the box');
  assert.ok(r.x + r.width < 400 && r.y + r.height < 400, 'and no further');
  // drawn at twice the size, at a corner of its own
  const twice = inlineDrawing(root).reach(5, 5, 40, 40, 2, null, 16)!;
  assert.ok(twice.x + twice.width >= 5 + 220, 'scaled with it');
  assert.ok(twice.x <= 5 - 100, 'and moved with it');
});

metric(
  'a shape a <use> draws is styled where its copy is, from a sprite outside the drawing too',
  async () => {
    // A `<use>` draws a copy of what it names, in a tree of the copy's own
    // (SVG 2, 5.5.3, as Chrome has it): a rule is matched against the
    // original with nothing above what the `<use>` names, and the copy
    // inherits from the `<use>`. An icon sprite's `<symbol>` is outside the
    // drawing, in a hidden `<svg>` of them, so no rule reached it, and
    // every sprite icon was drawn from its attributes alone.
    const sq = (attrs = '') => `<rect width="10" height="10" ${attrs}/>`;
    const symbol = (id: string, inside: string, attrs = '') =>
      `<symbol id="${id}" viewBox="0 0 10 10" ${attrs}>${inside}</symbol>`;
    const use = (id: string, attrs = '') =>
      `<svg width="10" height="10"><use href="#${id}" ${attrs}/></svg>`;
    const sprite =
      '<svg class="sprite" style="display:none"><g></g>' +
      symbol('a', sq('class="ln"')) +
      symbol('b', sq('class="sp" fill="#00aa00"')) +
      symbol('c', sq('class="ho" fill="#00aa00"')) +
      symbol('d', sq()) +
      symbol('e', sq(), 'fill="#00aa00"') +
      '<g id="f" class="k">' +
      sq() +
      '</g>' +
      symbol('g', sq('class="v"')) +
      symbol('h', sq('class="cc"')) +
      symbol('i', sq('class="fc"')) +
      symbol('inner', sq('class="in"')) +
      symbol('j', '<use href="#inner"/>') +
      symbol('k', sq('fill="#00aa00"') + sq('class="hd" fill="#ff0000"')) +
      symbol('l', sq()) +
      symbol('o', sq('fill="#ff0000"'), 'class="dn"') +
      symbol('p', sq('fill="#ff0000"'), 'class="vh"') +
      '</svg>';
    const rows: [string, string, string][] = [
      [use('a'), '#00aa00', 'a rule that names the symbol above it'],
      [use('b'), '#00aa00', "and none that names the sprite's"],
      [`<div class="host">${use('c')}</div>`, '#00aa00', "nor the <use>'s"],
      [use('d'), '#00aa00', 'a rule on the symbol, inherited'],
      [use('e'), '#00aa00', "the symbol's own fill"],
      [use('f'), '#00aa00', 'a group of the sprite'],
      [
        `<div class="hv">${use('g')}</div>`,
        '#00aa00',
        "a variable, the <use>'s",
      ],
      [
        `<div style="color:#00aa00">${use('h')}</div>`,
        '#00aa00',
        "currentColor, the <use>'s",
      ],
      [use('i'), '#00aa00', 'the top of its tree is its first child'],
      [use('j'), '#00aa00', 'a <use> in the copy, and its copy'],
      [use('k'), '#00aa00', 'display: none in the copy'],
      [use('l'), '#000000', 'and no rule'],
      [use('o'), '#ffffff', 'a symbol a rule gives display: none'],
      [use('p'), '#ffffff', 'and one it hides'],
      // one of the drawing's own: its copy is not where it stands
      [
        '<svg class="x" width="10" height="10"><defs>' +
          sq('id="m" fill="#00aa00"') +
          '</defs><use href="#m"/></svg>',
        '#00aa00',
        'a rule that reaches the original alone',
      ],
      [
        '<svg class="y" width="10" height="10"><defs>' +
          sq('id="n"') +
          '</defs><use href="#n"/></svg>',
        '#00aa00',
        'a rule on the <use>, inherited',
      ],
    ];
    const { result } = await renderWithBytes(
      '<style>body{margin:0} svg{display:block}' +
        'symbol .ln{fill:#00aa00} .sprite .sp{fill:#ff0000}' +
        '.host .ho{fill:#ff0000} #d{fill:#00aa00} .k rect{fill:#00aa00}' +
        '.sprite{--c:#ff0000} .hv{--c:#00aa00} .v{fill:var(--c)}' +
        '.cc{fill:currentColor} symbol:first-child .fc{fill:#00aa00}' +
        '.in{fill:#00aa00} .hd{display:none} .dn{display:none}' +
        '.vh{visibility:hidden}' +
        '.x rect{fill:#ff0000} .y use{fill:#00aa00}</style>' +
        sprite +
        rows.map(([markup]) => markup).join(''),
      {},
    );
    for (const [i, [, colour, message]] of rows.entries()) {
      await expectPixel(result.ctx, 5, i * 10 + 5, colour, { message });
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

/** The part of a context the stand-ins for `SvgView.draw` below call. */
interface CanvasLike {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
}

/** A document of an inline SVG and a band after it, the band's colour
 *  given. */
function afterAnSvg(svg: string, band: string) {
  return h(
    'box',
    { style: { width: 200, flexDirection: 'column' } },
    h(Html, {
      source:
        '<style>body{margin:0}svg,div{display:block}</style>' +
        `${svg}<div style="height:20px;background:${band}"></div>`,
      partial: false,
    }),
  );
}

metric(
  'an inline SVG ntk cannot draw leaves the rest of the document drawn, and every frame after',
  async () => {
    // nextjs.org's icons: a root that sets `color: currentColor`, which
    // ntk reads as a colour named "currentColor", and a presentation
    // attribute that is a `var()`. ntk throws on both halfway through the
    // drawing, and the clip to the icon's box stayed on the window's
    // context: nothing past the icon was drawn, in that frame or any after.
    const icons =
      '<svg viewBox="0 0 16 16" width="16" height="16" style="color:currentColor">' +
      '<path fill="currentColor" d="M0 0h16v16H0z"/></svg>' +
      '<svg viewBox="0 0 6 6" width="7" height="7">' +
      '<path d="M0 0h6v6H0z" fill="var(--accents-3)"/></svg>';
    const result = await renderX11(afterAnSvg(icons, '#0000ff'), {
      width: 240,
      height: 100,
      fonts: FONTS!,
    });
    await expectPixel(result.ctx, 100, 33, '#0000ff', {
      message: 'the band after the icons',
    });
    await act(() => result.rerender(afterAnSvg(icons, '#ff0000')));
    await expectPixel(result.ctx, 100, 33, '#ff0000', {
      message: 'and a frame after that',
    });
  },
);

metric(
  'a drawing that throws with saves open is unwound to where it began',
  async (t) => {
    // Whatever throws out of `SvgView`, however deep: the saves it made and
    // did not restore are restored after it, the clip and the transform it
    // left with them, and what follows is drawn where it is.
    const SvgView = (
      ntk as unknown as {
        SvgView: { prototype: { draw(ctx: unknown): void } };
      }
    ).SvgView;
    t.mock.method(SvgView.prototype, 'draw', (ctx: CanvasLike) => {
      ctx.save();
      ctx.translate(50, 0);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, 1, 1);
      ctx.clip();
      throw new Error('a drawing ntk cannot read');
    });
    const svg = '<svg width="10" height="10"></svg>';
    const result = await renderX11(afterAnSvg(svg, '#0000ff'), {
      width: 240,
      height: 100,
      fonts: FONTS!,
    });
    await expectPixel(result.ctx, 5, 20, '#0000ff', {
      message: 'from the left edge, unclipped',
    });
    await act(() => result.rerender(afterAnSvg(svg, '#ff0000')));
    await expectPixel(result.ctx, 5, 20, '#ff0000', {
      message: 'and in a frame after',
    });
  },
);

test('a drawing on a context lent at an alpha is drawn at a fraction of it', (t) => {
  // SvgView sets `globalAlpha` to each mark's own, from 1 at its root, and
  // a native context fades an element a thing at a time where no group
  // goes on a surface: reactmelbourne.com's grain, a full-window rect at
  // `opacity: .025`, drew the whole window black on macOS
  const SvgView = (
    ntk as unknown as {
      SvgView: { prototype: { draw(ctx: unknown): void } };
    }
  ).SvgView;
  const seen: number[] = [];
  const raw = {
    globalAlpha: 0.25,
    stack: [] as number[],
    save() {
      this.stack.push(this.globalAlpha);
    },
    restore() {
      this.globalAlpha = this.stack.pop() ?? this.globalAlpha;
    },
    beginPath() {},
    rect() {},
    clip() {},
    fill() {
      seen.push(this.globalAlpha);
    },
  };
  t.mock.method(SvgView.prototype, 'draw', (ctx: typeof raw) => {
    ctx.save();
    ctx.globalAlpha = 0.5;
    seen.push(ctx.globalAlpha);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fill();
    ctx.restore();
  });
  const svg = parseDocument(
    '<svg viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10"/></svg>',
  ).children[0] as Element;
  inlineDrawing(svg).draw(raw, 0, 0, 10, 10, 1);
  // what it reads is what it set, and what it draws is a fraction of what
  // it was lent at; and the alpha is the lender's again after it
  assert.deepStrictEqual(seen, [0.5, 0.125, 0.25]);
  assert.strictEqual(raw.globalAlpha, 0.25);
});

metric('a drawing restores none of what it did not save', async (t) => {
  // A restore past a drawing's own saves would take its caller's: the
  // clip of the box the drawing is in, which the box after it — painted
  // after it, a replaced element in its place — is cut to
  const SvgView = (
    ntk as unknown as {
      SvgView: { prototype: { draw(ctx: unknown): void } };
    }
  ).SvgView;
  t.mock.method(SvgView.prototype, 'draw', (ctx: CanvasLike) => {
    for (let i = 0; i < 4; i += 1) ctx.restore();
  });
  const result = await renderX11(
    afterAnSvg(
      '<div style="overflow:hidden;height:15px">' +
        '<svg width="10" height="10"></svg>' +
        '<svg width="10" height="40" style="background:#ff0000"></svg></div>',
      '#0000ff',
    ),
    { width: 240, height: 100, fonts: FONTS! },
  );
  await expectPixel(result.ctx, 5, 12, '#ff0000', { message: 'inside' });
  await expectPixel(result.ctx, 5, 25, '#0000ff', { message: 'the band' });
  await expectPixel(result.ctx, 5, 42, '#ffffff', {
    message: 'the box still clips what it holds',
  });
});

/** What `SvgView.draw` was handed, each time a drawing was drawn. */
interface DrawCall {
  /** The context's transform as the drawing began. */
  matrix: { a: number; b: number; c: number; d: number };
  opts: {
    surface?: (w: number, h: number) => { destroy?(): void } | null;
    font?: unknown;
  };
}

function recordDraws(t: { mock: { method: typeof test.mock.method } }) {
  const SvgView = (
    ntk as unknown as {
      SvgView: { prototype: { draw(...args: unknown[]): void } };
    }
  ).SvgView;
  const calls: DrawCall[] = [];
  t.mock.method(
    SvgView.prototype,
    'draw',
    (ctx: { getTransform(): DrawCall['matrix'] }, ...rest: unknown[]) => {
      calls.push({
        matrix: ctx.getTransform(),
        opts: (rest[4] ?? {}) as DrawCall['opts'],
      });
    },
  );
  return calls;
}

metric(
  "an inline drawing's text is set in its box's font, and a mask in it is drawn on the document's surfaces",
  async (t) => {
    // bun.sh's badge names its family as `var(--font-sans)`, which only
    // the page around it can answer, and a browser sets a drawing's text
    // in the page's font where it names none; at 2x the size is still the
    // CSS pixels a user unit is
    const calls = recordDraws(t);
    await renderX11(
      h(
        'box',
        { style: { width: 200, flexDirection: 'column' } },
        h(Html, {
          source:
            '<style>body{margin:0;font:italic 600 20px "Font Awesome 6 Free", serif}</style>' +
            '<svg width="40" height="20"><text y="15">x</text></svg>',
          partial: false,
        }),
      ),
      { width: 240, height: 100, fonts: FONTS!, scale: 2 },
    );
    await waitFor(() => assert.ok(calls.length > 0, 'drawn'));
    const { opts } = calls[calls.length - 1];
    assert.deepStrictEqual(opts.font, {
      // quoted, or a context's parser drops the whole shorthand at the 6
      family: '"Font Awesome 6 Free", serif',
      size: 20,
      weight: 600,
      style: 'italic',
    });
    // what a masked element in the drawing is drawn on: the document's
    // own, since a macOS context has no surface of ntk's to make
    assert.strictEqual(typeof opts.surface, 'function');
    const surface = opts.surface!(4, 4);
    assert.ok(surface, 'a surface');
    surface.destroy?.();
  },
);

metric(
  'a turned drawing with text in it is drawn level on a surface where the context turns no glyphs',
  async (t) => {
    // ntk sets a glyph as it was shaped, where the matrix puts it: drawn
    // through the matrix, bun.sh's rotated badge kept its words level.
    // A drawing of paths alone is still drawn through it.
    const calls = recordDraws(t);
    await renderX11(
      h(
        'box',
        { style: { width: 200, flexDirection: 'column' } },
        h(Html, {
          source:
            '<style>body{margin:0}svg{display:block;transform:rotate(30deg)}</style>' +
            '<svg width="40" height="20"><text y="15">x</text></svg>' +
            '<svg width="40" height="20"><path d="M0 0h40v20z"/></svg>',
          partial: false,
        }),
      ),
      { width: 240, height: 100, fonts: FONTS! },
    );
    await waitFor(() => assert.ok(calls.length >= 2, 'both drawn'));
    const [text, paths] = calls.slice(-2);
    assert.strictEqual(text.matrix.b, 0, 'the text drawn level, on a surface');
    assert.ok(
      Math.abs(paths.matrix.b - 0.5) < 1e-6,
      'the paths through the turn',
    );
  },
);

/** A document of drawings, laid out from the window's corner. */
const ALONE = '<style>body{margin:0;background:#fff}svg{display:block}</style>';

/** How many of a region's pixels are within `tolerance` of a colour, in
 *  each channel. */
async function pixelsNear(
  ctx: unknown,
  region: { x: number; y: number; width: number; height: number },
  colour: [number, number, number],
  tolerance = 24,
): Promise<number> {
  const px = await pixelsIn(ctx, region);
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (
      Math.abs(px[i] - colour[0]) <= tolerance &&
      Math.abs(px[i + 1] - colour[1]) <= tolerance &&
      Math.abs(px[i + 2] - colour[2]) <= tolerance
    ) {
      n += 1;
    }
  }
  return n;
}

/** The `<foreignObject>`s a document's last build made a tree for. */
function foreignOf(node: DrawnNode): Map<unknown, unknown> | undefined {
  return (
    view(node) as unknown as { _tree: { foreign?: Map<unknown, unknown> } }
  )._tree.foreign;
}

metric(
  "a foreignObject's HTML is laid out in the object's box and drawn there",
  async (t) => {
    withForeignObjects(t);
    // SVG 2, 23.2: what a `<foreignObject>` holds is HTML, a formatting
    // context of the object's size at the object's place in the drawing.
    // It drew nothing: an inline drawing is one replaced box, and
    // `SvgView` draws nothing of an object. Mermaid's labels are these.
    const { result, node } = await render(
      ALONE +
        '<svg width="160" height="100">' +
        '<rect width="160" height="100" fill="#ddeeff"/>' +
        '<foreignObject x="20" y="10" width="120" height="60">' +
        '<div style="background:#00ff00;height:20px"></div>' +
        '<p style="margin:0;color:#000000;font:16px/18px sans-serif">Hello there world</p>' +
        '</foreignObject></svg>',
      200,
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 25, 15, '#00ff00', { message: 'its first block' });
    await expectPixel(ctx, 135, 28, '#00ff00', {
      message: 'as wide as the object',
    });
    await expectPixel(ctx, 15, 15, '#ddeeff', { message: 'left of it' });
    await expectPixel(ctx, 145, 15, '#ddeeff', { message: 'right of it' });
    await expectPixel(ctx, 25, 8, '#ddeeff', { message: 'above it' });
    // its text, in the 120 pixels the object is wide: two lines of it
    const first = await pixelsNear(
      ctx,
      { x: 20, y: 30, width: 120, height: 18 },
      [0, 0, 0],
      64,
    );
    const second = await pixelsNear(
      ctx,
      { x: 20, y: 48, width: 120, height: 18 },
      [0, 0, 0],
      64,
    );
    assert.ok(first > 20, `its first line is drawn (${first})`);
    assert.ok(second > 10, `and the words that wrapped (${second})`);
    assert.strictEqual(foreignOf(node)?.size, 1);
  },
);

metric(
  "a foreignObject's HTML has no canvas of its own, in a document of the other scheme",
  async (t) => {
    withForeignObjects(t);
    // A document whose scheme is not the palette's is drawn on an opaque
    // canvas of its own (`paintDocument`); what an object holds is drawn
    // as a document is, and its canvas would have hidden the drawing
    // under it. Its own background is still drawn.
    const { result } = await render(
      ALONE +
        '<style>:root{color-scheme:dark}</style>' +
        '<svg width="160" height="60">' +
        '<rect width="160" height="60" fill="#ddeeff"/>' +
        '<foreignObject width="160" height="30">' +
        '<div style="height:10px;width:20px;background:#00ff00"></div>' +
        '</foreignObject>' +
        '<foreignObject y="30" width="160" height="30" ' +
        'style="background:#ff00ff"></foreignObject>' +
        '</svg>',
      200,
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 10, 5, '#00ff00', { message: 'what it holds' });
    await expectPixel(ctx, 80, 20, '#ddeeff', {
      message: 'the drawing, under the rest of it',
    });
    await expectPixel(ctx, 80, 45, '#ff00ff', {
      message: "an object's own background",
    });
  },
);

metric(
  "a switch draws a foreignObject that asks for SVG 1.1's Extensibility, ahead of its fallback",
  async (t) => {
    withForeignObjects(t);
    // draw.io's exports: the object in a group that asks for the feature,
    // in a `<switch>` ahead of a `<text>` for a renderer without it, which
    // was the one drawn here
    const { result } = await render(
      ALONE +
        '<svg width="160" height="40"><switch>' +
        '<g requiredFeatures="http://www.w3.org/TR/SVG11/feature#Extensibility">' +
        '<foreignObject width="160" height="40">' +
        '<div style="background:#00ff00;height:40px"></div>' +
        '</foreignObject></g>' +
        '<rect width="160" height="40" fill="#ff0000"/>' +
        '</switch></svg>',
      200,
    );
    await expectPixel(result.ctx, 80, 20, '#00ff00', {
      message: 'the object, and not the fallback after it',
    });
  },
);

metric(
  'where SvgView hands no foreignObject over, none is built, and a switch draws its fallback',
  async (t) => {
    // an ntk from before the hook (sidorares/ntk#549): an object draws
    // nothing, as it did, and nothing is built or laid out for it
    if (drawsForeignObjects()) {
      t.skip('this ntk hands an object over');
      return;
    }
    const source =
      ALONE +
      '<svg width="160" height="40"><switch>' +
      '<foreignObject width="160" height="20" ' +
      'requiredFeatures="http://www.w3.org/TR/SVG11/feature#Extensibility">' +
      '<div style="background:#00ff00;height:40px"></div></foreignObject>' +
      '<rect width="160" height="40" fill="#ff0000"/>' +
      '</switch></svg>';
    const { result, node } = await render(source, 200);
    assert.strictEqual(foreignOf(node), undefined, 'none built');
    await expectPixel(result.ctx, 80, 10, '#ff0000', {
      message: 'the fallback',
    });
    // and the stand-in for the hook is one the view is asked about
    withForeignObjects(t);
    assert.ok(drawsForeignObjects(), 'the hook, found where it is');
  },
);

test('a document with no foreignObject builds none', async () => {
  // what every walk over them asks first, so a page of icons pays nothing
  const { node } = await render(
    '<svg width="10" height="10"><rect width="10" height="10"/></svg><p>x</p>',
  );
  assert.strictEqual(foreignOf(node), undefined);
});

metric(
  "a foreignObject's HTML is drawn through the drawing's viewBox and transforms",
  async (t) => {
    withForeignObjects(t);
    // A user unit is a CSS pixel of what the object holds, so a `viewBox`
    // that doubles the drawing doubles it, and a `rotate()` on a group
    // around it turns it: a picture of it, on a surface, where the context
    // sets glyphs as they were shaped (ntk's)
    const { result } = await render(
      ALONE +
        '<svg width="160" height="100" viewBox="0 0 80 50">' +
        '<foreignObject x="10" y="5" width="60" height="30">' +
        '<div style="background:#00ff00;height:10px"></div>' +
        '<div style="background:#0000ff;height:5px;width:20px"></div>' +
        '</foreignObject></svg>' +
        '<svg width="160" height="160">' +
        '<g transform="rotate(90 80 80)">' +
        '<foreignObject x="20" y="60" width="120" height="40">' +
        '<div style="background:#ff00ff;height:10px"></div>' +
        '<p style="margin:0;color:#000000">Turned</p>' +
        '</foreignObject></g></svg>',
      200,
    );
    const ctx = result.ctx;
    // the first drawing: the object at (20, 10), 120 by 60, its blocks
    // 20 and 10 tall
    await expectPixel(ctx, 25, 15, '#00ff00', { message: 'scaled: its top' });
    await expectPixel(ctx, 135, 28, '#00ff00', {
      message: 'scaled: as wide as the object, twice over',
    });
    await expectPixel(ctx, 25, 35, '#0000ff', {
      message: 'scaled: its second block, under the first',
    });
    await expectPixel(ctx, 65, 35, '#ffffff', {
      message: 'scaled: forty wide, and no wider',
    });
    // the second, 100 down: (x, y) turned about (80, 80) is (160 - y, x)
    await expectPixel(ctx, 95, 100 + 30, '#ff00ff', {
      message: 'turned: its first block runs down the drawing',
    });
    await expectPixel(ctx, 95, 100 + 130, '#ff00ff', {
      message: 'turned: all of its length',
    });
    await expectPixel(ctx, 50, 100 + 30, '#ffffff', {
      message: 'turned: and not across it',
    });
    const text = await pixelsNear(
      ctx,
      { x: 60, y: 100 + 20, width: 30, height: 120 },
      [0, 0, 0],
      96,
    );
    assert.ok(text > 20, `turned: its text, beside the block (${text})`);
  },
);

metric(
  "a foreignObject's HTML is cut to the object, and to a clip-path on it or a group around it",
  async (t) => {
    withForeignObjects(t);
    const { result } = await render(
      ALONE +
        // a block taller than the object: cut at its foot, unless its
        // overflow is visible — by a rule, or by its presentation attribute
        '<svg width="160" height="40">' +
        '<foreignObject width="50" height="20">' +
        '<div style="background:#00ff00;height:40px"></div></foreignObject>' +
        '<foreignObject x="55" width="50" height="20" style="overflow:visible">' +
        '<div style="background:#00ff00;height:40px"></div></foreignObject>' +
        '<foreignObject x="110" width="50" height="20" overflow="visible">' +
        '<div style="background:#00ff00;height:40px"></div></foreignObject>' +
        '</svg>' +
        // a circle on the object
        '<svg width="160" height="100">' +
        '<clipPath id="round"><circle cx="80" cy="50" r="40"/></clipPath>' +
        '<foreignObject width="160" height="100" clip-path="url(#round)">' +
        '<div style="background:#ff00ff;height:100px"></div>' +
        '</foreignObject></svg>' +
        // the middle of the object's box, on the group around it
        '<svg width="160" height="100">' +
        '<clipPath id="mid" clipPathUnits="objectBoundingBox">' +
        '<rect x="0.25" y="0.25" width="0.5" height="0.5"/></clipPath>' +
        '<g clip-path="url(#mid)"><foreignObject width="160" height="100">' +
        '<div style="background:#0000ff;height:100px"></div>' +
        '</foreignObject></g></svg>',
      200,
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 25, 10, '#00ff00', { message: 'in the object' });
    await expectPixel(ctx, 25, 30, '#ffffff', {
      message: "below it, cut: SVG's UA sheet hides its overflow",
    });
    await expectPixel(ctx, 80, 30, '#00ff00', {
      message: 'below one a rule makes visible',
    });
    await expectPixel(ctx, 135, 30, '#00ff00', {
      message: 'below one its attribute makes visible',
    });
    await expectPixel(ctx, 80, 40 + 50, '#ff00ff', {
      message: 'in the circle',
    });
    await expectPixel(ctx, 5, 40 + 5, '#ffffff', {
      message: 'a corner the circle cuts away',
    });
    await expectPixel(ctx, 80, 140 + 50, '#0000ff', {
      message: 'in the middle of its box',
    });
    await expectPixel(ctx, 20, 140 + 50, '#ffffff', {
      message: 'outside the middle, which the clip is of its box',
    });
  },
);

metric(
  "a foreignObject's HTML is painted in the drawing's order, styled by the document's rules, and faded with its group",
  async (t) => {
    withForeignObjects(t);
    const { result } = await render(
      ALONE +
        '<style>g.ink{color:#ff0000}.label{background:#00ff00}</style>' +
        '<svg width="160" height="60">' +
        '<rect width="80" height="60" fill="#0000ff"/>' +
        '<g class="ink"><foreignObject width="160" height="60">' +
        '<div class="label" style="height:20px;width:120px"></div>' +
        '<div style="font:40px/40px sans-serif;margin-left:84px">MM</div>' +
        '</foreignObject></g>' +
        '<rect x="100" width="60" height="10" fill="#ff00ff"/>' +
        '</svg>' +
        '<svg width="160" height="40">' +
        '<g opacity="0.5"><foreignObject width="160" height="40">' +
        '<div style="background:#000000;height:40px"></div>' +
        '</foreignObject></g></svg>',
      200,
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 40, 10, '#00ff00', {
      message: 'over the rect before it, in a class of the page',
    });
    await expectPixel(ctx, 40, 30, '#0000ff', {
      message: 'what it does not cover shows through',
    });
    await expectPixel(ctx, 110, 5, '#ff00ff', {
      message: 'under the rect after it',
    });
    await expectPixel(ctx, 110, 15, '#00ff00', {
      message: 'and below that rect, its own',
    });
    const red = await pixelsNear(
      ctx,
      { x: 80, y: 20, width: 80, height: 40 },
      [255, 0, 0],
      32,
    );
    assert.ok(red > 40, `its text in the colour a group's rule gives (${red})`);
    await expectPixel(ctx, 80, 60 + 20, [128, 128, 128], {
      tolerance: 3,
      message: 'faded as the group around it',
    });
  },
);

metric(
  "a foreignObject's HTML is laid out in CSS pixels at 2x, and drawn on the device's grid",
  async (t) => {
    withForeignObjects(t);
    // a user unit is a CSS pixel, two device pixels here: the object, its
    // block and its text are twice the device pixels across
    const { result, node } = await render2x(
      ALONE +
        '<svg width="160" height="100">' +
        '<foreignObject x="20" y="10" width="120" height="60">' +
        '<div style="background:#00ff00;height:20px"></div>' +
        '<p style="margin:0;color:#000000;font:16px/18px sans-serif">Hello there world</p>' +
        '</foreignObject></svg>',
      200,
    );
    const { abs } = view(node) as unknown as { abs: { x: number; y: number } };
    const ctx = result.ctx;
    await expectPixel(ctx, abs.x + 42, abs.y + 22, '#00ff00', {
      message: 'its corner, two device pixels to a user unit',
    });
    await expectPixel(ctx, abs.x + 278, abs.y + 58, '#00ff00', {
      message: 'its far corner',
    });
    await expectPixel(ctx, abs.x + 282, abs.y + 30, '#ffffff', {
      message: 'past the object',
    });
    await expectPixel(ctx, abs.x + 42, abs.y + 61, '#ffffff', {
      message: 'below the block, on the grid',
    });
    const second = await pixelsNear(
      ctx,
      { x: abs.x + 40, y: abs.y + 96, width: 240, height: 36 },
      [0, 0, 0],
      64,
    );
    assert.ok(second > 40, `its text wraps where it does at 1x (${second})`);
  },
);

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
      '<iframe id="g" style="width:320px;aspect-ratio:16/9;border:0"></iframe>' +
      // a replaced box's too, its ratio written without `auto`; with it,
      // of the content box whatever the box-sizing
      '<iframe id="h" style="box-sizing:border-box;width:100px;' +
      'aspect-ratio:2;border:0;border-left:20px solid"></iframe>' +
      '<iframe id="i" style="box-sizing:border-box;width:100px;' +
      'aspect-ratio:auto 2;border:0;border-left:20px solid"></iframe>',
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
  assert.strictEqual(heightOf('h'), 50, 'its border box half as tall');
  assert.strictEqual(heightOf('i'), 40, 'its content box half as tall');
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

metric(
  'an image drawn at another size than its own is copied from a raster of it, the pixels it draws',
  async () => {
    // CoreGraphics reads all of a source for a draw that scales it, so a
    // photograph drawn small cost its whole size at every paint that
    // reached any of it: nine previews of the Zen Garden's all-designs
    // page at each frame of a card's hover. Its second drawing at a size
    // keeps a raster, and every drawing after copies it.
    const photo = pixelsPng(171, 129, (x, y) => [
      (x * 37 + y * 11) % 256,
      (x * x + y * 3) % 256,
      (x ^ y) & 255,
    ]);
    const small = pixelsPng(20, 15, (x, y) => [x * 12, y * 17, (x + y) * 7]);
    for (const scale of [1, 2]) {
      const { result, el } = await renderWithBytes(
        '<style>body{margin:0}img{display:block;margin:3px}</style>' +
          '<img src="p.png" style="width:57px;height:43px;border-radius:6px">' +
          '<img src="p.png" style="width:171px;height:129px">' +
          '<img src="s.png" style="width:63px;height:47px">',
        { 'p.png': photo, 's.png': small },
        200,
        scale,
      );
      // every image the document asks to be drawn at a size: those the
      // context resamples
      let proto = Object.getPrototypeOf(result.ctx);
      while (!Object.prototype.hasOwnProperty.call(proto, 'drawImage')) {
        proto = Object.getPrototypeOf(proto);
      }
      const draw = proto.drawImage;
      let resampled = 0;
      proto.drawImage = function (this: unknown, ...args: unknown[]) {
        const [image, , , w, h] = args as [
          { width?: number; height?: number },
          number,
          number,
          number?,
          number?,
        ];
        if (w !== undefined && (w !== image.width || h !== image.height)) {
          resampled += 1;
        }
        return draw.apply(this, args);
      };
      const node = el as unknown as {
        invalidate(all: boolean, by: unknown, why: string): void;
        _drawings: { destroy(): void } | null;
        _drawnOnce: Set<string>;
      };
      try {
        const repaint = async () => {
          resampled = 0;
          node.invalidate(false, el, 'test');
          return snapshot(result, el);
        };
        node._drawings?.destroy();
        node._drawings = null;
        node._drawnOnce.clear();
        // the middle one is drawn at its own size, but at 1x only
        const scaled = scale === 1 ? 2 : 3;
        const first = await repaint();
        assert.strictEqual(resampled, scaled, `${scale}x: drawn as they are`);
        const second = await repaint();
        assert.strictEqual(resampled, scaled, `${scale}x: rasters are made`);
        const third = await repaint();
        assert.strictEqual(resampled, 0, `${scale}x: and copied`);
        // the same pixels, but where the rounded one's curve cuts it: there
        // the copy is rounded to a level before the curve fades it, where
        // the image drawn there is faded as it is resampled, and the two
        // may be a level apart
        const width = (el as unknown as DrawnNode).abs.width;
        const [x0, y0, r] = [3 * scale, 3 * scale, 6 * scale];
        const [x1, y1] = [x0 + 57 * scale, y0 + 43 * scale];
        const apart = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
          let n = Math.abs(a.length - b.length);
          for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
            if (a[i] === b[i]) continue;
            const x = Math.floor(i / 4) % width;
            const y = Math.floor(i / 4 / width);
            const curve =
              x >= x0 &&
              x < x1 &&
              y >= y0 &&
              y < y1 &&
              (x < x0 + r || x >= x1 - r) &&
              (y < y0 + r || y >= y1 - r);
            if (!curve || Math.abs(a[i] - b[i]) > 1) n += 1;
          }
          return n;
        };
        assert.strictEqual(apart(first, second), 0, `${scale}x: second`);
        assert.strictEqual(apart(first, third), 0, `${scale}x: third`);
      } finally {
        proto.drawImage = draw;
      }
      cleanup();
    }
  },
);

/** `SvgView`, off ntk's exports as `SvgDrawing` reaches it. */
const SvgView = (
  ntk as unknown as {
    SvgView: {
      prototype: {
        draw(...args: unknown[]): unknown;
        setSvgDom(...args: unknown[]): unknown;
      };
    };
  }
).SvgView;

/**
 * Whole repaints of a document, with how many drawings were set from their
 * paths (`drawn`) and how many trees `SvgView` was handed (`read`); and what
 * a paint with no rasters kept comes to, which is what each has to be.
 */
function repaints(
  t: { mock: typeof import('node:test').mock },
  result: Awaited<ReturnType<typeof render>>['result'],
  el: HtmlViewNode,
) {
  const draw = t.mock.method(SvgView.prototype, 'draw');
  const read = t.mock.method(SvgView.prototype, 'setSvgDom');
  const node = el as unknown as {
    invalidate(all: boolean, by: unknown, why: string): void;
    _drawingKept?: unknown;
    _drawings: { kept: Map<string, unknown>; destroy(): void } | null;
    _drawnOnce: Set<string>;
  };
  const repaint = async () => {
    draw.mock.resetCalls();
    read.mock.resetCalls();
    node.invalidate(false, el, 'layout');
    const pixels = await snapshot(result, el);
    return {
      pixels,
      drawn: draw.mock.callCount(),
      read: read.mock.callCount(),
    };
  };
  return {
    repaint,
    /** How many were set since the last repaint began. */
    drawnYet: () => draw.mock.callCount(),
    /** How many trees it was handed since then. */
    readYet: () => read.mock.callCount(),
    kept: () => [...(node._drawings?.kept.keys() ?? [])],
    /** No raster kept, and no drawing noted. */
    forget: () => {
      node._drawings?.destroy();
      node._drawings = null;
      node._drawnOnce.clear();
    },
    /** The document with every drawing set from its paths. */
    direct: async () => {
      node._drawingKept = () => null;
      try {
        return (await repaint()).pixels;
      } finally {
        delete node._drawingKept;
      }
    },
  };
}

/** The most two snapshots differ by in any byte. */
function levelsApart(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  assert.strictEqual(a.length, b.length);
  let most = 0;
  for (let i = 0; i < a.length; i += 1) {
    most = Math.max(most, Math.abs(a[i] - b[i]));
  }
  return most;
}

/** A change to an attribute, as a refresh is told of it. */
function setAttribute(target: Element, name: string, value: string) {
  const oldValue = target.attribs[name] ?? null;
  target.attribs[name] = value;
  return {
    type: 'attributes' as const,
    target,
    attributeName: name,
    oldValue,
  };
}

/** What is put into an element that holds it already, as it is told once it
 *  has been out and come back: all a change said of it while it was out was
 *  told to nobody (`DomHost._tell`). */
function cameBack(target: ParentNode, node: ChildNode): HtmlChange {
  return {
    type: 'childList',
    target,
    addedNodes: [node],
    removedNodes: [],
  };
}

metric(
  'an inline drawing drawn again at its size is copied from a raster of it, the pixels its paths set',
  async (t) => {
    // Sixty icons were parsed and set from their paths at every paint that
    // reached them, which was a seventh of each frame of a window's edge
    // on a webmail page. Its second drawing keeps a raster, and every
    // drawing after copies it: none of it is parsed or set again.
    const icon =
      '<svg class="i" width="24" height="24" viewBox="0 0 24 24">' +
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#0000ff"/>' +
      '<stop offset="1" stop-color="#ff00ff"/></linearGradient></defs>' +
      '<rect width="24" height="24" rx="5" fill="url(#g)"/>' +
      '<path d="M3 12 Q 12 1 21 12 T 3 12" fill="currentColor"' +
      ' stroke="#ffffff" stroke-width="1.3" fill-opacity=".6"/></svg>';
    for (const scale of [1, 2]) {
      const over = scale === 1 ? render : render2x;
      const { result, node } = await over(
        '<style>body{margin:0;background:#20406a;color:#ffcc00}' +
          'svg{display:block;margin:3.3px}.b{color:#00ff99}</style>' +
          icon +
          icon +
          `<div class="b">${icon}</div>`,
        300,
      );
      const el = view(node);
      const { repaint, direct, kept, forget } = repaints(t, result, el);
      forget();
      // two alike, of which the second makes the raster, and one in another
      // colour, whose raster waits for its second paint
      const first = await repaint();
      assert.strictEqual(first.drawn, 3, `${scale}x: from their paths`);
      const second = await repaint();
      assert.strictEqual(second.drawn, 1, `${scale}x: the other raster`);
      const third = await repaint();
      assert.strictEqual(third.drawn, 0, `${scale}x: and nothing is set`);
      assert.strictEqual(third.read, 0, `${scale}x: or read`);
      assert.strictEqual(kept().length, 2, `${scale}x: the first two are one`);
      const set = await direct();
      assert.ok(levelsApart(set, second.pixels) <= 1, `${scale}x: second`);
      assert.ok(levelsApart(set, third.pixels) <= 1, `${scale}x: third`);
      cleanup();
    }
  },
);

metric(
  'a refresh that leaves an inline drawing as it was copies its raster, and draws nothing anew',
  async (t) => {
    // A refresh makes every drawing of a document again (`inlineDrawing`),
    // and the page this was measured on refreshed at most frames, so a
    // raster of a drawing object would hardly ever have been asked for
    // twice. It is kept by what the drawing says.
    const { result, node } = await render(
      '<style>body{margin:0}.on{color:#ff0000}</style>' +
        '<p id="p">Some text</p>' +
        '<svg width="30" height="30"><circle cx="15" cy="15" r="9"/></svg>',
      300,
    );
    const el = view(node);
    const { repaint } = repaints(t, result, el);
    await repaint();
    await repaint();
    assert.strictEqual((await repaint()).drawn, 0);
    const p = findById(el.document, 'p')!;
    el.touchDocument([setAttribute(p, 'class', 'on')]);
    await act();
    let after = await repaint();
    assert.deepStrictEqual([after.drawn, after.read], [0, 0], 'told');
    el.touchDocument();
    await act();
    after = await repaint();
    assert.deepStrictEqual([after.drawn, after.read], [0, 0], 'not told');
  },
);

metric(
  'a refresh told of a change elsewhere reads no inline drawing again',
  async (t) => {
    // Each drawing was made again at every refresh, and was read for what
    // it says to find its raster: a webmail page refreshed at most of its
    // frames, and the reading was up to half of what was left of drawing
    // sixty icons. And what no raster stands for was handed to `SvgView`
    // again, for a change on the far side of the page.
    const { result, node } = await render(
      '<style>body{margin:0}svg{display:block}.on{color:#ff0000}</style>' +
        '<p id="p">Some text</p>' +
        '<svg id="copied" width="30" height="30"><circle cx="15" cy="15"' +
        ' r="9"/></svg>' +
        '<svg id="set" width="60" height="24"><text y="16">A</text></svg>' +
        '<svg style="display:none"><symbol id="s"><rect width="9"' +
        ' height="9"/></symbol></svg>' +
        '<svg id="used" width="30" height="30"><use href="#s"/></svg>',
      300,
    );
    const el = view(node);
    const { repaint, readYet } = repaints(t, result, el);
    await repaint();
    await repaint();
    const by = (id: string) => findById(el.document, id)!;
    const drawings = () =>
      ['copied', 'set', 'used'].map((id) => inlineDrawing(by(id)));
    const [copied, set, used] = drawings();
    // what reaches outside itself holds while nothing changes
    await repaint();
    assert.ok(inlineDrawing(by('used')) === used, 'a repaint keeps every one');
    el.touchDocument([setAttribute(by('p'), 'class', 'on')]);
    await act();
    const read = readYet();
    await repaint();
    const [nowCopied, nowSet, nowUsed] = drawings();
    assert.ok(nowCopied === copied, 'what a raster stands for');
    assert.ok(nowSet === set, 'and what it does not');
    assert.ok(nowUsed !== used, 'but what it names may be what changed');
    assert.strictEqual(read + readYet(), 0, 'and no tree is handed over');
    el.touchDocument();
    await act();
    const [wholeCopied, wholeSet] = drawings();
    assert.ok(wholeCopied !== copied, 'told nothing, it may be anything');
    assert.ok(wholeSet !== set, 'and that is every drawing');
  },
);

metric(
  'a drawing that failed is tried again at a refresh told of a change elsewhere',
  async (t) => {
    // What it failed on is not known, and may be outside it
    const { result, node } = await render(
      '<style>body{margin:0}svg{display:block}</style><p id="p">Text</p>' +
        '<svg id="d" width="60" height="24"><text y="16">A</text>' +
        '<rect width="60" height="24" fill="#00aa00"/></svg>',
      300,
    );
    const el = view(node);
    const handOver = SvgView.prototype.setSvgDom;
    let failing = true;
    t.mock.method(
      SvgView.prototype,
      'setSvgDom',
      function (this: unknown, tree: unknown) {
        if (failing) throw new Error('no such tree');
        return handOver.call(this, tree);
      },
    );
    const { repaint } = repaints(t, result, el);
    el.touchDocument();
    await act();
    const failed = (await repaint()).pixels;
    failing = false;
    const p = findById(el.document, 'p')!;
    el.touchDocument([setAttribute(p, 'class', 'on')]);
    await act();
    const after = await repaint();
    assert.ok(bytesApart(after.pixels, failed) > 0, 'it is drawn now');
  },
);

metric(
  'a drawing is drawn as a whole refresh draws it after a told change to what it reads',
  async (t) => {
    // Everything a drawing was read from has to say so, as each record
    // told is all that drops one now: its elements, its root, what it names
    // outside itself, what it named and did not find, and what no record
    // could tell of. Each case stands on one way of saying so.
    const box = 'width="60" height="24"';
    const sprite =
      '<svg style="display:none"><symbol id="s" viewBox="0 0 10 10">' +
      '<rect id="in-sprite" width="5" height="10"/></symbol></svg>';
    const icon = `<svg ${box}><use href="#s"/></svg>`;
    const cases: {
      name: string;
      html: string;
      style?: string;
      change: (by: (id: string) => Element) => HtmlChange[];
    }[] = [
      {
        name: 'a shape in it',
        html: `<svg ${box}><path id="x" d="M0 0h9v9z"/></svg>`,
        change: (by) => [setAttribute(by('x'), 'd', 'M9 9h9v9z')],
      },
      {
        name: 'an id what it paints with names, which no raster stands for',
        html:
          `<svg ${box}><linearGradient id="a"><stop stop-color="#00aa00"/>` +
          `</linearGradient><rect ${box} fill="url(#b)"/>` +
          '<text y="16">A</text></svg>',
        change: (by) => [setAttribute(by('a'), 'id', 'b')],
      },
      {
        name: 'a child put in it',
        html: `<svg id="d" ${box}><g id="g"></g></svg>`,
        change: (by) => {
          const made = parseDocument(
            '<rect width="30" height="24" fill="#ff0000"/>',
          ).children[0] as Element;
          const g = by('g');
          made.parent = g;
          g.children.push(made);
          return [cameBack(g, made)];
        },
      },
      {
        name: 'its root, as a raster has it',
        html:
          `<svg id="d" ${box} viewBox="0 0 60 24"><rect width="30"` +
          ' height="24"/></svg>',
        change: (by) => [setAttribute(by('d'), 'viewBox', '0 0 30 12')],
      },
      {
        name: 'its root, where no raster stands for it',
        html:
          `<svg id="d" ${box} viewBox="0 0 60 24"><rect width="30"` +
          ' height="24"/><text y="16">A</text></svg>',
        change: (by) => [setAttribute(by('d'), 'viewBox', '0 0 30 12')],
      },
      {
        // the third is copied from the raster the second made, and is
        // nothing but a key
        name: "a sprite's symbol",
        html: sprite + icon + icon + icon,
        change: (by) => [setAttribute(by('in-sprite'), 'fill', '#00aa00')],
      },
      {
        name: 'a gradient only a rule names',
        html:
          '<svg style="display:none"><linearGradient id="far"><stop id="stop"' +
          ` stop-color="#ff0000"/></linearGradient></svg>` +
          `<svg id="by-rule" ${box}><rect ${box}/></svg>`,
        style: '#by-rule rect{fill:url(#far)}',
        change: (by) => [setAttribute(by('stop'), 'stop-color', '#00aa00')],
      },
      {
        // put in before the drawing, so the document's last node stays as
        // it was, and drawn through a matrix, so no key has looked for it
        name: 'what it named and did not find',
        html:
          '<div id="holder"></div><div style="transform:rotate(180deg)">' +
          `<svg ${box}><use href="#later"/></svg></div>`,
        change: (by) => {
          const made = parseDocument(
            '<svg style="display:none"><rect id="later" width="30"' +
              ' height="24" fill="#ff0000"/></svg>',
          ).children[0] as Element;
          const holder = by('holder');
          made.parent = holder;
          holder.children.push(made);
          return [cameBack(holder, made)];
        },
      },
      {
        name: 'a drawing that went out and came back',
        html:
          `<div id="holder"><svg id="d" ${box} viewBox="0 0 60 24">` +
          '<rect width="30" height="24"/></svg></div>',
        change: (by) => {
          by('d').attribs.viewBox = '0 0 30 12';
          return [cameBack(by('holder'), by('d'))];
        },
      },
      {
        name: 'a drawing in what went out and came back',
        html:
          `<div id="holder"><div id="in"><svg id="d" ${box}` +
          ' viewBox="0 0 60 24"><rect width="30" height="24"/></svg></div>' +
          '</div>',
        change: (by) => {
          by('d').attribs.viewBox = '0 0 30 12';
          return [cameBack(by('holder'), by('in'))];
        },
      },
      {
        name: 'a drawing in the shadow tree of what went out and came back',
        html:
          '<div id="holder"><div id="host"><template shadowrootmode="open">' +
          `<svg id="d" ${box} viewBox="0 0 60 24"><rect width="30"` +
          ' height="24"/></svg></template></div></div>',
        change: (by) => {
          const host = by('host');
          const tree = shadowRootOf(host)!;
          const d = tree.children.find((n) => n.type === 'tag') as Element;
          d.attribs.viewBox = '0 0 30 12';
          return [cameBack(by('holder'), host)];
        },
      },
    ];
    for (const { name, html, style, change } of cases) {
      const { result, node } = await render(
        `<style>body{margin:0}svg{display:block}${style ?? ''}</style>${html}`,
        300,
      );
      const el = view(node);
      const { repaint } = repaints(t, result, el);
      await repaint();
      await repaint();
      const was = (await repaint()).pixels;
      const by = (id: string) => findById(el.document, id)!;
      el.touchDocument(change(by));
      await act();
      const told = (await repaint()).pixels;
      assert.ok(bytesApart(told, was) > 0, `${name}: drawn as it was`);
      el.touchDocument();
      await act();
      const whole = (await repaint()).pixels;
      assert.ok(levelsApart(told, whole) <= 1, `${name}: what it reads now`);
      cleanup();
    }
  },
);

test('what an inline drawing reaches past its box follows what it names', () => {
  // Asked of a drawing no paint has reached: the ink of one off screen
  const doc = parseDocument(
    '<svg><defs><marker id="m" markerWidth="10" markerHeight="10" ' +
      'markerUnits="userSpaceOnUse"><path d="M0,0H10V10H0Z"/></marker>' +
      '</defs></svg>' +
      '<svg id="d" width="20" height="20"><g marker-end="url(#m)">' +
      '<path d="M0,0 V200" stroke-width="4"/></g></svg>',
  );
  const root = findById(doc, 'd')!;
  const reach = () => inlineDrawing(root).reach(0, 0, 20, 20, 1, null, 16)!;
  const before = reach();
  const changed = setAttribute(findById(doc, 'm')!, 'markerwidth', '90');
  new HtmlSource().touch(true);
  forgetDrawings([changed]);
  const after = reach();
  assert.ok(
    after.x + after.width > before.x + before.width + 50,
    `as far as the marker reaches now: ${JSON.stringify(after)}`,
  );
});

metric('a document taken over is read as it stands', async () => {
  // What changed while nothing drew it was told to nobody
  const doc = parseDocument(
    '<svg id="d" width="60" height="24" viewBox="0 0 60 24"><rect width="30"' +
      ' height="24"/></svg>',
  ) as unknown as Document;
  const page = (shown: boolean) =>
    h(
      'box',
      { style: { width: 300, flexDirection: 'column' } },
      shown && h(Html, { source: '', document: doc, 'data-testname': 'doc' }),
    );
  const result = await renderX11(page(true), {
    width: 340,
    height: 100,
    fonts: FONTS!,
  });
  await act();
  const before = await snapshot(
    result,
    view(screen.getByTestName('doc') as DrawnNode),
  );
  const root = findById(doc, 'd')!;
  await act(() => result.rerender(page(false)));
  root.attribs.viewBox = '0 0 30 12';
  await act(() => result.rerender(page(true)));
  await act();
  const after = await snapshot(
    result,
    view(screen.getByTestName('doc') as DrawnNode),
  );
  assert.ok(bytesApart(after, before) > 0, 'drawn as it was');
});

metric(
  'a script stopped in the middle of what it asked leaves no drawing as it was',
  async (t) => {
    // What it was cut in the middle of told nobody what it changed
    const { result, node } = await render(
      '<style>body{margin:0}svg{display:block}</style>' +
        '<svg id="d" width="60" height="24" viewBox="0 0 60 24"><rect' +
        ' width="30" height="24"/></svg>',
      300,
    );
    const el = view(node);
    const { repaint } = repaints(t, result, el);
    await repaint();
    await repaint();
    const was = (await repaint()).pixels;
    findById(el.document, 'd')!.attribs.viewBox = '0 0 30 12';
    el.interrupted();
    await act();
    const after = await repaint();
    assert.ok(bytesApart(after.pixels, was) > 0, 'drawn as it was');
  },
);

metric(
  'told what changed, generated drawings are drawn as a whole refresh draws them',
  async () => {
    // Drawings that hold shapes, name a sprite and a gradient outside them,
    // name what is not there yet, set text or are drawn through a matrix,
    // and changes to each of those, a few at a time before a whole refresh
    // says what they should have come to. DRAWING_SEEDS sweeps more of
    // them, and DRAWING_FROM starts at one.
    const { env } = process;
    const seeds = Number(env.DRAWING_SEEDS ?? 24);
    const from = Number(env.DRAWING_FROM ?? 0);
    const colours = ['#ff0000', '#00aa00', '#0000ff', '#ff00ff', '#00aaaa'];
    for (let seed = from; seed < from + seeds; seed += 1) {
      const next = mulberry32(seed * 7001 + 1);
      const below = (n: number) => Math.floor(next() * n);
      const colour = () => colours[below(colours.length)];
      const count = 3 + below(4);
      const parts = [
        `<rect id="r-@" width="20" height="20" fill="${colour()}"/>`,
        '<use href="#s"/>',
        `<rect id="g-@" y="20" width="40" height="20" fill="url(#g)"/>`,
        '<use href="#late-@" x="20"/>',
        '<text y="30">A</text>',
        `<linearGradient id="own-@"><stop id="stop-@" stop-color="${colour()}"/></linearGradient>` +
          '<rect x="20" width="20" height="20" fill="url(#own-@)"/>',
      ];
      let html =
        '<style>body{margin:0}svg{display:block}</style>' +
        '<div id="head"></div>' +
        '<svg id="sprite" style="display:none"><symbol id="s" viewBox="0 0 10 10">' +
        `<rect id="in-s" width="5" height="10" fill="${colour()}"/></symbol>` +
        `<linearGradient id="g"><stop id="stop" stop-color="${colour()}"/>` +
        '</linearGradient></svg>';
      for (let i = 0; i < count; i += 1) {
        // no text in a box that turns, which is drawn on a surface kept for
        // the box, and a told change to what it names leaves that as it was
        const turns = next() < 0.25;
        const own = parts
          .filter((part) => next() < 0.5 && !(turns && part.includes('<text')))
          .join('')
          .replaceAll('@', String(i));
        const svg =
          `<svg id="d${i}" width="40" height="40" viewBox="0 0 40 40">` +
          `<rect id="x${i}" width="9" height="9"/>${own}</svg>`;
        const style = turns ? ' style="transform:rotate(180deg)"' : '';
        html += `<div id="h${i}"${style}>${svg}</div>`;
      }
      const { result, node } = await render(html, 300);
      const el = view(node);
      const repaint = async () => {
        (
          el as unknown as {
            invalidate(all: boolean, by: unknown, why: string): void;
          }
        ).invalidate(false, el, 'layout');
        return snapshot(result, el);
      };
      await repaint();
      await repaint();
      const by = (id: string) => findById(el.document, id);
      const made = (text: string) => {
        const node = parseDocument(text).children[0] as Element;
        delete (node as { parent?: unknown }).parent;
        return node;
      };
      const steps: (() => HtmlChange[])[] = [
        () => [setAttribute(by(`x${below(count)}`)!, 'fill', colour())],
        () => [setAttribute(by(`d${below(count)}`)!, 'viewBox', '0 0 20 20')],
        () => {
          const shape = by('in-s');
          return shape ? [setAttribute(shape, 'fill', colour())] : [];
        },
        () => {
          const stop = by('stop');
          return stop ? [setAttribute(stop, 'stop-color', colour())] : [];
        },
        () => {
          const added = made(
            `<svg style="display:none"><rect id="late-${below(count)}"` +
              ` width="20" height="20" fill="${colour()}"/></svg>`,
          );
          const head = by('head')!;
          appendChild(head, added);
          return [cameBack(head, added)];
        },
        () => {
          const added = made(
            `<rect width="9" height="9" y="30" fill="${colour()}"/>`,
          );
          const d = by(`d${below(count)}`)!;
          appendChild(d, added);
          return [cameBack(d, added)];
        },
        () => {
          const sprite = by('sprite');
          if (!sprite) return [];
          const target = sprite.parent!;
          removeElement(sprite);
          return [
            {
              type: 'childList',
              target,
              addedNodes: [],
              removedNodes: [sprite],
            },
          ];
        },
        () => {
          const g = by('g');
          return g ? [setAttribute(g, 'id', 'not-g')] : [];
        },
        () => {
          const i = below(count);
          const d = by(`d${i}`)!;
          const holder = by(`h${i}`)!;
          // out and back, changed on the way, which is all that is told
          removeElement(d);
          d.attribs.viewbox = '0 0 30 30';
          appendChild(holder, d);
          return [
            {
              type: 'childList',
              target: holder,
              addedNodes: [],
              removedNodes: [d],
            },
            cameBack(holder, d),
          ];
        },
      ];
      for (let step = 0; step < 8; step += 1) {
        el.touchDocument(steps[below(steps.length)]());
        await act();
        const told = await repaint();
        if (next() < 0.5) continue;
        el.touchDocument();
        await act();
        const whole = await repaint();
        assert.ok(
          levelsApart(told, whole) <= 1,
          `seed ${seed}, step ${step}: drawn otherwise than a whole refresh`,
        );
      }
      cleanup();
    }
  },
);

metric(
  'a raster of an inline drawing is held to everything the drawing is set from',
  async (t) => {
    // Each drawing reads one thing, and each step changes that thing and
    // nothing else, so a key that leaves it out draws the raster it kept.
    const { result, node } = await render(
      '<html><style>html{font-size:10px}html.big{font-size:20px}' +
        'body{margin:0;color:#000000}' +
        'svg{display:block;margin:2px}' +
        '.color{color:#00aa00}.fill #fill{fill:#ff0000}' +
        '.stroke #stroke{stroke:#ff0000}.shape #shape rect{fill:#0000ff}' +
        '.width{stroke-width:7}.em{font-size:40px}.size #size{width:34px}' +
        '.zoom #zoom{zoom:2;width:12px;height:12px}#prop{--c:#ff0000}.prop #prop{--c:#00aa00}#rem{font-size:13px}' +
        '</style>' +
        '<div id="top"><svg style="display:none">' +
        '<symbol id="sprite" viewBox="0 0 10 10"><rect id="in-sprite"' +
        ' width="5" height="10"/></symbol><linearGradient id="far">' +
        '<stop id="far-stop" stop-color="#ff0000"/></linearGradient></svg>' +
        '<svg id="color" width="24" height="24"><rect width="24" height="24"' +
        ' fill="currentColor"/></svg>' +
        '<svg id="fill" width="24" height="24"><rect width="24" height="24"/>' +
        '</svg>' +
        '<svg id="stroke" width="24" height="24"><line x1="2" y1="12" x2="22"' +
        ' y2="12" stroke-width="4"/></svg>' +
        '<svg id="shape" width="24" height="24"><rect width="24" height="24"/>' +
        '</svg>' +
        '<svg id="width" width="24" height="24" stroke="#000000"><line x1="2"' +
        ' y1="12" x2="22" y2="12"/></svg>' +
        '<svg id="em" width="60" height="24"><rect width="1em" height="24"/>' +
        '</svg>' +
        '<svg id="rem" width="60" height="24"><rect width="2rem" height="24"/>' +
        '</svg>' +
        '<svg id="size" width="24" height="24" viewBox="0 0 24 24"><rect' +
        ' width="12" height="24"/></svg>' +
        '<svg id="zoom" width="24" height="24"><rect width="12" height="12"/>' +
        '</svg>' +
        '<svg id="prop" width="24" height="24"><rect width="24" height="24"' +
        ' fill="var(--c)"/></svg>' +
        '<svg id="used" width="24" height="24"><use href="#sprite"/></svg>' +
        '<svg id="far-fill" width="24" height="24"><rect width="24" height="24"' +
        ' fill="url(#far)"/></svg>' +
        '<svg id="d" width="24" height="24"><path id="d-path" d="M0 0h9v9z"/>' +
        '</svg>' +
        '<svg id="box" width="24" height="24" viewBox="0 0 24 24"><rect' +
        ' id="in-box" width="24" height="12"/></svg>' +
        // alike but for the name of an element, and alike but for what a
        // group holds
        '<svg width="24" height="24"><rect width="24" height="24" r="4"' +
        ' cx="12" cy="12"/></svg>' +
        '<svg width="24" height="24"><circle width="24" height="24" r="4"' +
        ' cx="12" cy="12"/></svg>' +
        '<svg width="24" height="24"><g fill="#ff0000"><rect width="24"' +
        ' height="24"/></g></svg>' +
        '<svg width="24" height="24"><g fill="#ff0000"></g><rect width="24"' +
        ' height="24"/></svg></div>',
      300,
    );
    const el = view(node);
    const { repaint, direct, drawnYet } = repaints(t, result, el);
    const by = (id: string) => findById(el.document, id)!;
    const top = by('top');
    const root = el.document.children.find(
      (n): n is Element => n.type === 'tag',
    )!;
    const addClass = (name: string) => () => [
      setAttribute(top, 'class', `${top.attribs.class ?? ''} ${name}`.trim()),
    ];
    const steps: [string, () => readonly HtmlChange[] | null][] = [
      ['its currentColor', addClass('color')],
      ['its fill', addClass('fill')],
      ['its stroke', addClass('stroke')],
      ['what a rule gives a shape', addClass('shape')],
      ['what it inherits', addClass('width')],
      ['its font size', addClass('em')],
      ['the root font size', () => [setAttribute(root, 'class', 'big')]],
      ['its size', addClass('size')],
      ['its zoom', addClass('zoom')],
      ['a custom property', addClass('prop')],
      [
        "a sprite's symbol",
        () => [setAttribute(by('in-sprite'), 'fill', '#00aa00')],
      ],
      [
        'a gradient outside it',
        () => [setAttribute(by('far-stop'), 'stop-color', '#00aa00')],
      ],
      ['a shape, told', () => [setAttribute(by('d-path'), 'd', 'M9 9h9v9z')]],
      [
        'a shape, not told',
        () => {
          by('d-path').attribs.d = 'M0 9h9v9z';
          return null;
        },
      ],
      ['its viewBox', () => [setAttribute(by('box'), 'viewBox', '0 0 12 12')]],
    ];
    await repaint();
    await repaint();
    let was = (await repaint()).pixels;
    for (const [name, change] of steps) {
      el.touchDocument(change());
      await act();
      // the paint the change asked for, and maybe more than one
      const set = drawnYet();
      const first = await repaint();
      assert.ok(bytesApart(first.pixels, was) > 0, `${name}: drawn the same`);
      assert.ok(set + first.drawn > 0, `${name}: nothing set anew`);
      await repaint();
      const copied = await repaint();
      assert.strictEqual(copied.drawn, 0, `${name}: kept in the end`);
      was = copied.pixels;
      assert.strictEqual(
        levelsApart(await direct(), was),
        0,
        `${name}: the raster`,
      );
    }
  },
);

metric(
  'a raster of an inline drawing follows a stream through it and through what it names',
  async (t) => {
    // A chunk adds to what a drawing holds, and to a sprite's symbol, and
    // says so to nothing: no `refresh`, and no new drawing
    const head = '<style>body{margin:0}</style>';
    const parts = [
      '<svg width="40" height="40"><rect width="10" height="40" fill="#f00"/>',
      '<rect x="10" width="10" height="40" fill="#0f0"/></svg>' +
        '<svg width="40" height="40"><use href="#s"/></svg>',
      '<svg style="display:none"><symbol id="s"><rect width="10" height="10"' +
        ' fill="#00f"/>',
      '<rect x="10" width="10" height="10" fill="#f0f"/></symbol></svg>',
    ];
    let source = head + parts[0];
    const doc = (text: string) =>
      h(
        'box',
        { style: { width: 300, flexDirection: 'column' } },
        h(Html, { source: text, partial: true, 'data-testname': 'doc' }),
      );
    const result = await renderX11(doc(source), {
      width: 340,
      height: 300,
      fonts: FONTS!,
    });
    await act();
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const { repaint, direct } = repaints(t, result, el);
    const settled = async (when: string) => {
      for (let i = 0; i < 3; i += 1) await repaint();
      const copied = await repaint();
      assert.strictEqual(levelsApart(await direct(), copied.pixels), 0, when);
      return copied;
    };
    for (const part of parts.slice(1)) {
      await settled(`before ${JSON.stringify(part.slice(0, 40))}`);
      source += part;
      await act(() => result.rerender(doc(source)));
      await act();
    }
    // and all of it is kept, the drawing that named what had not come too
    assert.strictEqual((await settled('at the end')).drawn, 0);
  },
);

metric(
  'no raster stands for an inline drawing that sets text, holds HTML, shows what is past its box or names what no key holds',
  async (t) => {
    withForeignObjects(t);
    const { result, node } = await render(
      '<style>body{margin:0}svg{display:block;margin:2px}' +
        '#by-rule rect{fill:url(#far)}</style>' +
        '<svg style="display:none"><linearGradient id="far"><stop' +
        ' stop-color="#ff0000"/></linearGradient><text id="label" y="16">A' +
        '</text></svg>' +
        '<svg width="60" height="24"><text y="16">A</text></svg>' +
        '<svg width="60" height="24"><use href="#label"/></svg>' +
        '<svg width="60" height="24"><foreignObject width="60" height="24">' +
        '<p xmlns="http://www.w3.org/1999/xhtml">A</p></foreignObject></svg>' +
        '<svg width="24" height="24" style="overflow:visible"><circle cx="12"' +
        ' cy="12" r="20"/></svg>' +
        '<svg id="by-rule" width="24" height="24"><rect width="24"' +
        ' height="24"/></svg>' +
        '<svg width="24" height="24"><use href="#nothing"/><rect width="24"' +
        ' height="24"/></svg>' +
        '<svg width="24" height="24"><rect width="24" height="24"/></svg>',
      300,
    );
    const el = view(node);
    const { repaint, kept } = repaints(t, result, el);
    await repaint();
    await repaint();
    const last = await repaint();
    // the one that is none of them
    assert.strictEqual(kept().length, 1, kept().join('\n'));
    assert.strictEqual(last.drawn, 6);
  },
);

metric(
  'an inline drawing drawn through a matrix is set from its paths',
  async (t) => {
    // on a context that draws through it, as macOS's does: a raster of it
    // is the drawing resampled, where the context would set it anew
    const { result, node } = await render(
      '<style>body{margin:0}svg{display:block;margin:40px;' +
        'transform:rotate(30deg)}</style>' +
        '<svg width="40" height="40"><rect width="40" height="20"/></svg>',
      300,
    );
    const el = view(node);
    const { repaint, kept } = repaints(t, result, el);
    await repaint();
    await repaint();
    await repaint();
    assert.ok(
      kept().every((key) => !key.startsWith('inline|')),
      kept().join('\n'),
    );
  },
);

/** A drawing that reads as much of what `SvgView` draws as a raster has to
 *  stand for: shapes over one another, in colours, strokes and fractions of
 *  a pixel; a gradient, a clip, a mask, a transform and an opacity. */
function drawingFrom(next: () => number, id: number): string {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const at = () => (next() * 40).toFixed(2);
  const colour = () =>
    pick(['#ff0000', '#00aa00', '#0000ff', '#ffcc00', 'currentColor', 'none']);
  const shape = (): string => {
    const paint =
      ` fill="${pick([colour(), colour(), `url(#g${id})`])}"` +
      ` stroke="${colour()}" stroke-width="${(next() * 4).toFixed(1)}"` +
      ` opacity="${pick(['1', '1', '.5'])}"` +
      pick(['', '', ` transform="rotate(${at()} 20 20)"`]) +
      pick(['', '', ` clip-path="url(#c${id})"`, ` mask="url(#m${id})"`]);
    switch (Math.floor(next() * 4)) {
      case 0:
        return `<rect x="${at()}" y="${at()}" width="${at()}" height="${at()}" rx="3"${paint}/>`;
      case 1:
        return `<circle cx="${at()}" cy="${at()}" r="${at()}"${paint}/>`;
      case 2:
        return `<path d="M${at()} ${at()}Q${at()} ${at()} ${at()} ${at()}T${at()} ${at()}z"${paint}/>`;
      default:
        return `<polyline points="${at()},${at()} ${at()},${at()} ${at()},${at()}"${paint}/>`;
    }
  };
  const box = 20 + Math.floor(next() * 40);
  return (
    `<svg width="${box}" height="${box}"` +
    pick(['', ' viewBox="0 0 40 40"', ' viewBox="5 5 20 30"']) +
    ` style="display:block;margin:${(next() * 4).toFixed(2)}px;` +
    `color:${pick(['#123456', '#fedcba', '#00aa00'])}"><defs>` +
    `<linearGradient id="g${id}"><stop stop-color="${pick(['#ff0000', '#00ff00'])}"/>` +
    '<stop offset="1" stop-color="#0000ff" stop-opacity=".5"/></linearGradient>' +
    `<clipPath id="c${id}"><circle cx="20" cy="20" r="${at()}"/></clipPath>` +
    `<mask id="m${id}"><rect width="40" height="40" fill="#808080"/></mask>` +
    `</defs>${Array.from({ length: 1 + Math.floor(next() * 4) }, shape).join('')}` +
    '</svg>'
  );
}

const DRAWING_FROM = Number(process.env.DRAWING_FROM ?? 1);
const DRAWING_SEEDS = Number(process.env.DRAWING_SEEDS ?? 6);

for (const scale of [1, 2]) {
  metric(
    `a raster of an inline drawing is the drawing, in generated drawings at ${scale}x`,
    async (t) => {
      for (let i = 0; i < DRAWING_SEEDS; i += 1) {
        const seed = DRAWING_FROM + i;
        const next = mulberry32(seed * 7001);
        const drawings = Array.from({ length: 8 }, (_, id) =>
          drawingFrom(next, id),
        ).join('');
        const over = scale === 1 ? render : render2x;
        const { result, node } = await over(
          '<style>body{margin:0;background:#c0d0e0}</style>' +
            `<div style="columns:3">${drawings}</div>`,
          300,
        );
        const el = view(node);
        const { repaint, direct } = repaints(t, result, el);
        await repaint();
        await repaint();
        const copied = await repaint();
        assert.strictEqual(copied.drawn, 0, `seed ${seed}`);
        const apart = levelsApart(await direct(), copied.pixels);
        // a translucent edge rounded on the surface and again over the page
        assert.ok(apart <= 3, `seed ${seed}: ${apart} levels apart`);
        t.mock.restoreAll();
        cleanup();
      }
    },
  );
}
