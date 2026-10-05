// <Html> — replaced elements: images, SVG, aspect-ratio and object-fit.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import {
  act,
  cleanup,
  expectPixel,
  renderX11,
  screen,
  waitFor,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import * as ntk from 'react-x11/ntk';
import type { Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { Html } from '../../src/index.js';
import type { HtmlViewNode } from '../../src/html/index.js';
import { decodesImageType } from '../../src/html/image-types.js';
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
  fillsOf,
  h,
  metric,
  pixelsIn,
  pixelsPng,
  render,
  renderWithBytes,
  renderWithImages,
  snapshot,
  solidPng,
  svgBytes,
  view,
} from './harness.js';
import type { LaidBox, PaintOp, ReplacedBox } from './harness.js';

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
