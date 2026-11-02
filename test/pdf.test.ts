// `<Pdf>`, and the arithmetic under it.
//
// Three layers. The layout and the text index are pure and asserted with no
// display. The engine is real PDFium over documents `pdf-fixture.ts` writes
// out by hand, so what is asserted of a page is what the page says. The
// element runs over `FakePdfEngine`, whose every pixel says where it is: a
// flat page cannot show a shift, and these mount the pane away from the
// window's corner and at `scale: 2`, which is where a geometry bug hides.
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  pixelAt,
  renderX11,
  userEvent,
  waitFor,
} from 'react-x11/test';
import { drawnKinds, knownElements } from 'react-x11/host';

import {
  Pdf,
  PDF_ELEMENT,
  PdfOpenError,
  defaultPdfEngine,
} from '../src/pdf/index.js';
import type { PdfHandle, PdfEngine } from '../src/pdf/index.js';
import {
  PX_PER_POINT,
  TILE_SIZE,
  currentPage,
  firstPageBelow,
  levelKey,
  pagePixels,
  pagesIn,
  placePages,
  tilesCovering,
} from '../src/pdf/layout.js';
import {
  caretAt,
  indexPageText,
  lineAround,
  onText,
  rangeBands,
  wordAround,
} from '../src/pdf/text.js';
import { restClock } from '../src/pdf/clock.js';
import { FakePdfEngine, inkAt, lineOfText } from './fake-pdf.js';
import { holdClock } from './held-clock.js';
import { makePdf } from './pdf-fixture.js';
import type { FixturePage } from './pdf-fixture.js';
import { mulberry32 } from './mulberry32.js';

test.afterEach(() => cleanup());

// --- layout ------------------------------------------------------------------

test('pages stand one under another, centred, on whole pixels', () => {
  const layout = placePages(
    [
      { width: 300, height: 400 },
      { width: 150.5, height: 200.25 },
    ],
    1,
    10,
    800,
  );
  const [a, b] = layout.pages;
  assert.strictEqual(a!.y, 10);
  assert.strictEqual(a!.height, 534);
  assert.strictEqual(b!.y, 10 + 534 + 10);
  assert.strictEqual(a!.x, Math.floor((800 - a!.width) / 2));
  assert.strictEqual(layout.height, b!.y + b!.height + 10);
  for (const page of layout.pages) {
    assert.ok(Number.isInteger(page.x) && Number.isInteger(page.y));
  }
});

test('a page wider than the pane makes the document wider than the pane', () => {
  const layout = placePages([{ width: 1000, height: 100 }], 1, 8, 200);
  assert.strictEqual(layout.pages[0]!.x, 8);
  assert.strictEqual(layout.width, Math.ceil(1000 * PX_PER_POINT) + 16);
});

test('firstPageBelow agrees with walking the pages', () => {
  const random = mulberry32(7);
  for (let round = 0; round < 200; round++) {
    const sizes = Array.from({ length: 1 + Math.floor(random() * 40) }, () => ({
      width: 100 + random() * 500,
      height: 100 + random() * 800,
    }));
    const layout = placePages(sizes, 0.25 + random() * 2, 8, 600);
    const top = random() * layout.height * 1.1;
    let walked = 0;
    while (
      walked < layout.pages.length &&
      layout.pages[walked]!.y + layout.pages[walked]!.height <= top
    ) {
      walked++;
    }
    assert.strictEqual(firstPageBelow(layout.pages, top), walked);
  }
});

test('pagesIn and currentPage read the view', () => {
  const sizes = Array.from({ length: 10 }, () => ({ width: 300, height: 300 }));
  const layout = placePages(sizes, 1, 10, 500);
  const view = { x: 0, y: 420, width: 500, height: 500 };
  // Each is 400 tall with 10 between: the view starts on the second page's
  // top edge and its 500 reach into the third, which starts at 830.
  assert.deepStrictEqual(
    pagesIn(layout, view).map((p) => p.index),
    [1, 2],
  );
  assert.strictEqual(currentPage(layout, view), 1);
  assert.strictEqual(
    currentPage(layout, { ...view, y: layout.height - 100 }),
    9,
  );
});

test("a page's tiles cover it exactly once", () => {
  const random = mulberry32(11);
  for (let round = 0; round < 60; round++) {
    const size = { width: 50 + random() * 900, height: 50 + random() * 1200 };
    const level = 0.5 + random() * 3;
    const whole = pagePixels(size, level);
    const tiles = tilesCovering(
      0,
      size,
      level,
      { x: 0, y: 0, width: whole.width, height: whole.height },
      0,
    );
    let area = 0;
    for (const tile of tiles) {
      assert.ok(tile.width > 0 && tile.width <= TILE_SIZE);
      assert.ok(tile.height > 0 && tile.height <= TILE_SIZE);
      assert.strictEqual(tile.x % TILE_SIZE, 0);
      assert.strictEqual(tile.y % TILE_SIZE, 0);
      area += tile.width * tile.height;
    }
    assert.strictEqual(area, whole.width * whole.height);
    assert.strictEqual(new Set(tiles.map((t) => t.key)).size, tiles.length);
  }
});

test('the tiles of two levels of one page have different keys', () => {
  const size = { width: 400, height: 400 };
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  const [a] = tilesCovering(3, size, 2, rect, 0);
  const [b] = tilesCovering(3, size, 2.5, rect, 0);
  assert.notStrictEqual(a!.key, b!.key);
  assert.notStrictEqual(levelKey(2), levelKey(2.5));
});

test('no two tiles share a key, however deep the zoom', () => {
  const seen = new Set<string>();
  const size = { width: 14400, height: 14400 };
  const rect = { x: 0, y: 0, width: 2048, height: 2048 };
  for (const page of [0, 1, 4095, 4096]) {
    for (const level of [1, 16, 16.5, 64, 85.3]) {
      for (const tile of tilesCovering(page, size, level, rect, 0)) {
        assert.ok(!seen.has(tile.key), tile.key);
        seen.add(tile.key);
      }
    }
  }
});

test('tiles nearest the middle of the view come first', () => {
  const size = { width: 400, height: 2000 };
  const tiles = tilesCovering(
    0,
    size,
    1,
    { x: 0, y: 0, width: 400, height: 2000 },
    1000,
  );
  assert.strictEqual(tiles[0]!.ty, 1);
  assert.ok(tiles[0]!.y <= 1000 && tiles[0]!.y + tiles[0]!.height >= 512);
});

// --- text --------------------------------------------------------------------

const HELLO = indexPageText(lineOfText('hello world', 100, 200, 10, 12));

test('a caret lands on the nearer side of a character', () => {
  assert.strictEqual(caretAt(HELLO, 101, 205), 0);
  assert.strictEqual(caretAt(HELLO, 108, 205), 1);
  assert.strictEqual(caretAt(HELLO, 99999, 205), 11);
  assert.strictEqual(caretAt(HELLO, 0, 205), 0);
  assert.strictEqual(
    caretAt(indexPageText({ text: '', boxes: new Float32Array(0) }), 1, 1),
    -1,
  );
});

test('a range is a band of each line it reaches', () => {
  const page = indexPageText({
    text: 'ab\r\ncd',
    boxes: new Float32Array([
      0, 0, 10, 10, 10, 0, 20, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 10, 30, 10,
      20, 20, 30,
    ]),
  });
  assert.strictEqual(page.rows.length, 2);
  assert.deepStrictEqual(rangeBands(page, 1, 5), [
    { x: 10, y: 0, width: 10, height: 10 },
    { x: 0, y: 20, width: 10, height: 10 },
  ]);
});

test('a line ends where the next character is not beside the last', () => {
  // Two columns, in content order, on the same baseline.
  const left = lineOfText('one', 300, 100, 10, 12);
  const right = lineOfText('two', 100, 100, 10, 12);
  const boxes = new Float32Array(24);
  boxes.set(left.boxes);
  boxes.set(right.boxes, 12);
  const page = indexPageText({ text: 'onetwo', boxes });
  assert.strictEqual(page.rows.length, 2);
  assert.strictEqual(caretAt(page, 101, 105), 3);
});

test('a word and a line around a character', () => {
  assert.deepStrictEqual(wordAround(HELLO, 7), [6, 11]);
  assert.deepStrictEqual(wordAround(HELLO, 5), [5, 6]);
  assert.deepStrictEqual(lineAround(HELLO, 3), [0, 11]);
  assert.ok(onText(HELLO, 150, 205));
  assert.ok(!onText(HELLO, 150, 300));
});

// --- the engine --------------------------------------------------------------

async function engineOr(t: {
  skip(reason: string): void;
}): Promise<PdfEngine | null> {
  const engine = await defaultPdfEngine();
  if (!engine) t.skip('@embedpdf/pdfium is not installed');
  return engine;
}

test('PDFium reads the sizes, the title and the outline', async (t) => {
  const engine = await engineOr(t);
  if (!engine) return;
  const info = await engine.open(
    makePdf({
      title: 'A fixture',
      pages: [
        { width: 300, height: 400 },
        { width: 500, height: 200 },
      ],
      outline: [
        { title: 'First', page: 0 },
        { title: 'Second', page: 1 },
      ],
    }),
  );
  assert.deepStrictEqual(info.pages, [
    { width: 300, height: 400 },
    { width: 500, height: 200 },
  ]);
  assert.strictEqual(info.title, 'A fixture');
  assert.deepStrictEqual(
    info.outline.map((o) => [o.title, o.page]),
    [
      ['First', 0],
      ['Second', 1],
    ],
  );
  engine.close(info.handle);
});

test('a page turned by /Rotate is sized as shown', async (t) => {
  const engine = await engineOr(t);
  if (!engine) return;
  const info = await engine.open(
    makePdf({ pages: [{ width: 300, height: 400, rotate: 90 }] }),
  );
  assert.deepStrictEqual(info.pages[0], { width: 400, height: 300 });
  engine.close(info.handle);
});

test('what is not a PDF says so, and throws nothing else', async (t) => {
  const engine = await engineOr(t);
  if (!engine) return;
  await assert.rejects(
    engine.open(new TextEncoder().encode('no such document')),
    (error: Error) => error instanceof PdfOpenError && error.code === 'format',
  );
});

/** Where a colour is found in a tile: its box, as device pixels. */
function inkBox(
  pixels: { width: number; height: number; data: Uint8ClampedArray },
  match: (r: number, g: number, b: number) => boolean,
) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const at = (y * pixels.width + x) * 4;
      if (match(pixels.data[at]!, pixels.data[at + 1]!, pixels.data[at + 2]!)) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  return { x0, y0, x1, y1 };
}

const isRed = (r: number, g: number, b: number) => r > 200 && g < 60 && b < 60;

test('a tile is the part of the page it says, y down from the top', async (t) => {
  const engine = await engineOr(t);
  if (!engine) return;
  const info = await engine.open(
    makePdf({
      // A square 100 up from the page's bottom and 50 in from its left.
      pages: [{ width: 300, height: 400, rects: [[50, 100, 40, 20, 1, 0, 0]] }],
    }),
  );
  const level = 2;
  const whole = await engine.render(info.handle, {
    page: 0,
    level,
    x: 0,
    y: 0,
    width: 600,
    height: 800,
  });
  const box = inkBox(whole!, isRed);
  assert.deepStrictEqual(box, { x0: 100, y0: 560, x1: 179, y1: 599 });
  // The same square from a tile that starts inside it.
  const part = await engine.render(info.handle, {
    page: 0,
    level,
    x: 120,
    y: 570,
    width: 100,
    height: 100,
  });
  assert.deepStrictEqual(inkBox(part!, isRed), {
    x0: 0,
    y0: 0,
    x1: 59,
    y1: 29,
  });
  engine.close(info.handle);
});

test('a media box off the origin and a turned page draw where the text says', async (t) => {
  const engine = await engineOr(t);
  if (!engine) return;
  const page: FixturePage = {
    width: 300,
    height: 400,
    text: [[150, 300, 20, 'HH']],
    rects: [[150, 300, 30, 20, 1, 0, 0]],
  };
  const variants: FixturePage[] = [
    { ...page },
    { ...page, rotate: 90 },
    { ...page, rotate: 180 },
    { ...page, rotate: 270 },
    {
      ...page,
      origin: [40, 60],
      rects: [[190, 360, 30, 20, 1, 0, 0]],
      text: [[190, 360, 20, 'HH']],
    },
  ];
  for (const variant of variants) {
    const info = await engine.open(makePdf({ pages: [variant] }));
    const size = info.pages[0]!;
    const pixels = await engine.render(info.handle, {
      page: 0,
      level: 2,
      x: 0,
      y: 0,
      width: Math.ceil(size.width * 2),
      height: Math.ceil(size.height * 2),
    });
    const text = await engine.text(info.handle, 0);
    assert.strictEqual(text.text.slice(0, 2), 'HH');
    const ink = inkBox(pixels!, isRed);
    // Every box the engine gives must fall on the ink the page drew: this is
    // what stops a selection being drawn beside the text on a turned page.
    const left = text.boxes[0]! * 2;
    const top = text.boxes[1]! * 2;
    const right = text.boxes[2]! * 2;
    const bottom = text.boxes[3]! * 2;
    const middleX = (left + right) / 2;
    const middleY = (top + bottom) / 2;
    assert.ok(
      middleX >= ink.x0 - 4 &&
        middleX <= ink.x1 + 4 &&
        middleY >= ink.y0 - 4 &&
        middleY <= ink.y1 + 4,
      `rotate ${variant.rotate ?? 0}: ${[left, top, right, bottom]} outside ${JSON.stringify(ink)}`,
    );
    engine.close(info.handle);
  }
});

test('links say where they go, in points from the top', async (t) => {
  const engine = await engineOr(t);
  if (!engine) return;
  const info = await engine.open(
    makePdf({
      pages: [
        {
          width: 300,
          height: 400,
          links: [
            { rect: [10, 300, 100, 20], url: 'https://example.com/a?b=1' },
            { rect: [10, 200, 100, 20], page: 1 },
          ],
        },
        { width: 300, height: 400 },
      ],
    }),
  );
  const links = await engine.links(info.handle, 0);
  assert.strictEqual(links.length, 2);
  const outside = links.find((l) => l.url)!;
  assert.strictEqual(outside.url, 'https://example.com/a?b=1');
  assert.strictEqual(Math.round(outside.x), 10);
  assert.strictEqual(Math.round(outside.y), 80);
  assert.strictEqual(Math.round(outside.width), 100);
  assert.strictEqual(Math.round(outside.height), 20);
  assert.strictEqual(links.find((l) => !l.url)!.page, 1);
  engine.close(info.handle);
});

// Node 20 and the first releases of 22 hand a worker no hooks for a `.ts` entry,
// so from the source there is no thread there to hold anything open. From 24 on
// there has to be one, or these two prove nothing.
const threaded = Number(process.versions.node.split('.')[0]) >= 24;

function inAProcess(what: string) {
  const file = fileURLToPath(new URL('./pdf-process.ts', import.meta.url));
  const child = spawnSync(process.execPath, ['--import', 'tsx', file, what], {
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.strictEqual(child.signal, null, `held open: ${child.stderr}`);
  assert.strictEqual(child.status, 0, `cut short: ${child.stderr}`);
  if (threaded) assert.match(child.stdout, /^ThreadEngine/);
  return child.stdout;
}

test('a process that only made the engine ends by itself', () => {
  assert.match(inAProcess('nothing'), /ended/);
});

test('a process waits for the answer it asked for, and then ends', () => {
  assert.match(inAProcess('slow'), /drew\s+ended/);
});

// --- the element -------------------------------------------------------------

test('the element is registered, and draws', () => {
  assert.ok(knownElements().includes(PDF_ELEMENT));
  assert.ok(drawnKinds().includes(PDF_ELEMENT));
});

const FOUR_PAGES = Array.from({ length: 4 }, (_, i) => ({
  width: 400 + i * 40,
  height: 500,
}));

/** `<Pdf>` under a header and beside a sidebar: never at the window's corner. */
async function mounted(
  engine: PdfEngine,
  options: {
    scale?: number;
    zoom?: number | 'width' | 'page';
    props?: object;
  } = {},
) {
  const ref = React.createRef<PdfHandle>();
  const result = await renderX11(
    React.createElement(
      'box',
      { style: { flexDirection: 'column', width: 800, height: 600 } },
      React.createElement('box', { style: { height: 40, flexShrink: 0 } }),
      React.createElement(
        'box',
        { style: { flexDirection: 'row', flexGrow: 1 } },
        React.createElement('box', { style: { width: 60, flexShrink: 0 } }),
        React.createElement(Pdf, {
          ref,
          data: new Uint8Array(4),
          engine,
          defaultZoom: options.zoom ?? 1,
          gap: 10,
          ...options.props,
        }),
      ),
    ),
    { width: 800, height: 600, scale: options.scale ?? 1 } as never,
  );
  await waitFor(() => assert.ok(ref.current?.node, 'no element yet'));
  const handle = ref.current!;
  const node = handle.node!;
  await waitFor(() => assert.ok(node.abs.width > 0, 'not laid out yet'));
  return { result, handle, node };
}

/** Everything the view is waiting for has landed. */
async function settled(
  engine: FakePdfEngine,
  node: { stats: { tilesDrawn: number } },
) {
  let last = -1;
  await waitFor(() => {
    const drawn = node.stats.tilesDrawn;
    const still = drawn === last && engine.inFlight === 0 && drawn > 0;
    last = drawn;
    assert.ok(still, 'tiles are still landing');
  });
  await act(async () => {});
}

/** Hold window pixels to what the page says should be under them. */
async function showsPages(
  result: { ctx: unknown },
  node: {
    contentBox(): { x: number; y: number; width: number; height: number };
    zoom: number;
    scale: number;
  },
  layout: ReturnType<typeof placePages>,
  scroll: { left: number; top: number },
  points: Array<[number, number]>,
): Promise<number> {
  const s = node.scale;
  const box = node.contentBox();
  const k = node.zoom * PX_PER_POINT;
  const ctx = result.ctx;
  let checked = 0;
  for (const [wx, wy] of points) {
    const docX = scroll.left + (wx - box.x) / s;
    const docY = scroll.top + (wy - box.y) / s;
    const page = layout.pages[firstPageBelow(layout.pages, docY)];
    if (
      !page ||
      docY < page.y + 1 ||
      docX < page.x + 1 ||
      docX > page.x + page.width - 1 ||
      docY > page.y + page.height - 1
    ) {
      continue;
    }
    // A point on the edge of a square reads either side of it.
    const px = (docX - page.x) / k;
    const py = (docY - page.y) / k;
    if (px % 16 < 1.5 || px % 16 > 14.5 || py % 16 < 1.5 || py % 16 > 14.5)
      continue;
    const want = inkAt(page.index, px, py);
    const got = await pixelAt(ctx as never, wx, wy);
    assert.deepStrictEqual(
      [...got],
      want,
      `at ${wx},${wy}: page ${page.index} point ${px.toFixed(1)},${py.toFixed(1)}`,
    );
    checked++;
  }
  return checked;
}

function samples(box: { x: number; y: number; width: number; height: number }) {
  const out: Array<[number, number]> = [];
  for (let y = 0.1; y < 1; y += 0.13) {
    for (let x = 0.08; x < 1; x += 0.11) {
      out.push([
        Math.floor(box.x + box.width * x),
        Math.floor(box.y + box.height * y),
      ]);
    }
  }
  return out;
}

for (const scale of [1, 2]) {
  test(`pages land where they are placed, away from the corner, at ${scale}x`, async () => {
    const engine = new FakePdfEngine(FOUR_PAGES);
    const { result, node } = await mounted(engine, { scale });
    await settled(engine, node);
    const box = node.contentBox();
    assert.strictEqual(box.x, 60 * scale);
    assert.strictEqual(box.y, 40 * scale);
    const layout = placePages(FOUR_PAGES, 1, 10, box.width / scale);
    const checked = await showsPages(
      result,
      node,
      layout,
      { left: 0, top: 0 },
      samples(box),
    );
    assert.ok(checked > 20, `only ${checked} points were on a page`);
  });

  test(`a scroll shows the pages it reached, at ${scale}x`, async () => {
    const engine = new FakePdfEngine(FOUR_PAGES);
    const { result, node } = await mounted(engine, { scale });
    await settled(engine, node);
    await act(async () => node.scrollBy({ y: 333 }));
    await settled(engine, node);
    const box = node.contentBox();
    const layout = placePages(FOUR_PAGES, 1, 10, box.width / scale);
    const checked = await showsPages(
      result,
      node,
      layout,
      { left: 0, top: 333 },
      samples(box),
    );
    assert.ok(checked > 20, `only ${checked} points were on a page`);
  });
}

test('a whole first view asks for nothing the pane does not reach', async () => {
  const engine = new FakePdfEngine(FOUR_PAGES);
  const { node } = await mounted(engine);
  await settled(engine, node);
  const box = node.contentBox();
  const layout = placePages(FOUR_PAGES, 1, 10, box.width);
  const reach = box.height * 2;
  for (const request of engine.requests) {
    const page = layout.pages[request.page]!;
    assert.ok(page.y + request.y <= reach);
  }
});

test('the queue never holds more than it can answer, through a flick', async () => {
  const pages = Array.from({ length: 300 }, () => ({
    width: 400,
    height: 500,
  }));
  const engine = new FakePdfEngine(pages, { hold: true });
  const { node } = await mounted(engine);
  await waitFor(() =>
    assert.ok(engine.requests.length > 0, 'nothing asked for'),
  );
  for (let i = 0; i < 40; i++) {
    await act(async () => node.scrollBy({ y: 1400 }));
  }
  assert.ok(engine.mostInFlight <= 3, `${engine.mostInFlight} at once`);
  const asked = engine.requests.length;
  assert.ok(asked <= 3, `${asked} tiles asked for a view nobody stopped at`);
  engine.release();
  await waitFor(() => assert.strictEqual(engine.inFlight, 0));
  // What it asks for next is where the view is now, not where it was.
  await settled(engine, node);
  const last = engine.requests[engine.requests.length - 1]!;
  assert.ok(last.page > 50, `the last tile was of page ${last.page}`);
});

test('a zoom shows what there is and draws its own tiles once it rests', async (t) => {
  const rest = holdClock(t, restClock);
  const engine = new FakePdfEngine(FOUR_PAGES);
  const { result, node } = await mounted(engine);
  await settled(engine, node);
  const asked = engine.requests.length;
  await act(async () => node.zoomTo(1.5));
  assert.strictEqual(
    engine.requests.length,
    asked,
    'a zoom asked for tiles at once',
  );
  await waitFor(() =>
    assert.ok(node.stats.staleComposited > 0, 'nothing stretched yet'),
  );
  await rest.finish();
  await waitFor(() =>
    assert.ok(engine.requests.length > asked, 'no tiles asked for yet'),
  );
  await settled(engine, node);
  const levels = new Set(engine.requests.slice(asked).map((r) => r.level));
  assert.deepStrictEqual([...levels], [1.5 * PX_PER_POINT]);
  const box = node.contentBox();
  const layout = placePages(FOUR_PAGES, 1.5, 10, box.width);
  // The zoom kept the middle of the pane where it was.
  const left = (node as unknown as { _left: number })._left;
  const top = (node as unknown as { _top: number })._top;
  const checked = await showsPages(
    result,
    node,
    layout,
    { left, top },
    samples(box),
  );
  assert.ok(checked > 20, `only ${checked} points were on a page`);
});

test("a scroll inside a zoom's rest asks for no tiles of the scale it left", async (t) => {
  const rest = holdClock(t, restClock);
  const pages = Array.from({ length: 40 }, () => ({ width: 400, height: 500 }));
  const engine = new FakePdfEngine(pages);
  const { node } = await mounted(engine);
  await settled(engine, node);
  const asked = engine.requests.length;
  await act(async () => {
    node.zoomTo(1.5);
    node.scrollBy({ y: 9000 });
  });
  assert.strictEqual(engine.requests.length, asked);
  await rest.finish();
  await waitFor(() =>
    assert.ok(engine.requests.length > asked, 'no tiles asked for yet'),
  );
  for (const request of engine.requests.slice(asked)) {
    assert.strictEqual(request.level, 1.5 * PX_PER_POINT);
  }
});

for (const answer of ['nothing', 'throw'] as const) {
  test(`a tile the engine answers with ${answer} is asked for once`, async () => {
    const engine = new FakePdfEngine(FOUR_PAGES, {
      refuse: (tile) => (tile.page === 0 ? answer : undefined),
    });
    const refused = () =>
      engine.requests.filter((tile) => tile.page === 0).length;
    const { node } = await mounted(engine);
    await waitFor(() => assert.ok(refused() > 0, 'nothing refused yet'));
    await act(async () => {
      await new Promise((go) => setTimeout(go, 60));
      node.scrollBy({ y: 1 });
      await new Promise((go) => setTimeout(go, 60));
    });
    const tilesOfThePage = Math.ceil((420 * PX_PER_POINT) / TILE_SIZE) * 2;
    assert.ok(refused() <= tilesOfThePage, `${refused()} asks for page 0`);
  });
}

test('a backend with no surface asks for nothing more', async () => {
  const engine = new FakePdfEngine(FOUR_PAGES);
  const ref = React.createRef<PdfHandle>();
  await renderX11(
    React.createElement(Pdf, {
      ref,
      data: new Uint8Array(4),
      engine,
      style: { width: 400, height: 300 },
    }),
    { backend: 'mock' } as never,
  );
  await waitFor(() => assert.ok(ref.current?.node, 'no element yet'));
  await act(async () => {
    await new Promise((go) => setTimeout(go, 60));
  });
  assert.ok(engine.requests.length <= 3, `${engine.requests.length} asks`);
});

test('a fit follows the pane', async () => {
  const engine = new FakePdfEngine(FOUR_PAGES);
  const { node } = await mounted(engine, { zoom: 'width' });
  await settled(engine, node);
  const box = node.contentBox();
  const widest = FOUR_PAGES[3]!.width * PX_PER_POINT * node.zoom;
  assert.ok(widest <= box.width);
  assert.ok(widest > box.width - 40);
});

test('a fit says the zoom it came to', async () => {
  const told: number[] = [];
  const engine = new FakePdfEngine(FOUR_PAGES);
  const { handle, node } = await mounted(engine, {
    props: { onZoomChange: (zoom: number) => told.push(zoom) },
  });
  await settled(engine, node);
  await act(async () => handle.fit('page'));
  assert.deepStrictEqual(told, [node.zoom]);
  assert.notStrictEqual(node.zoom, 1);
});

test('two presses take a word and three a line', async () => {
  const engine = new FakePdfEngine(FOUR_PAGES, {
    text: () => lineOfText('hello world', 40, 40, 12, 14),
  });
  const { handle, node } = await mounted(engine);
  await settled(engine, node);
  await waitFor(() =>
    assert.ok(
      (node as unknown as { _texts: Map<number, unknown> })._texts.size > 0,
      'no text yet',
    ),
  );
  const box = node.contentBox();
  const layout = placePages(FOUR_PAGES, 1, 10, box.width);
  const page = layout.pages[0]!;
  const on = {
    dx: page.x + (40 + 12 * 8) * PX_PER_POINT - box.width / 2,
    dy: page.y + 46 * PX_PER_POINT - box.height / 2,
  };
  await userEvent.doubleClick(node as never, on);
  assert.strictEqual(await handle.selectedText(), 'world');
});

test('a press and a drag select, and a copy takes what was selected', async () => {
  const engine = new FakePdfEngine(FOUR_PAGES, {
    text: () => lineOfText('hello world', 40, 40, 12, 14),
  });
  const { handle, node } = await mounted(engine, { scale: 2 });
  await settled(engine, node);
  await waitFor(() =>
    assert.ok(
      (node as unknown as { _texts: Map<number, unknown> })._texts.size > 0,
      'no text yet',
    ),
  );
  const box = node.contentBox();
  const s = 2;
  const layout = placePages(FOUR_PAGES, 1, 10, box.width / s);
  const page = layout.pages[0]!;
  const at = (px: number, py: number) => ({
    x: box.x + (page.x + px * PX_PER_POINT) * s,
    y: box.y + (page.y + py * PX_PER_POINT) * s,
  });
  const from = at(41, 46);
  const to = at(40 + 12 * 5 - 1, 46);
  const offset = (p: { x: number; y: number }) => ({
    dx: p.x - (box.x + box.width / 2),
    dy: p.y - (box.y + box.height / 2),
  });
  await act(async () => {
    fireEvent.mouseMove(node as never, offset(from));
    fireEvent.mouseDown(node as never, offset(from));
    fireEvent.mouseMove(node as never, offset(to));
    fireEvent.mouseUp(node as never, offset(to));
  });
  assert.strictEqual(await handle.selectedText(), 'hello');
});

test('a press takes the keys, and the keys scroll and zoom', async () => {
  const pages = Array.from({ length: 20 }, () => ({ width: 400, height: 500 }));
  const engine = new FakePdfEngine(pages);
  const { node } = await mounted(engine);
  await settled(engine, node);
  await userEvent.click(node as never);
  assert.ok(node.focused);
  const top = () => (node as unknown as { _top: number })._top;
  await userEvent.key(0xff56); // Page Down
  const paged = top();
  assert.ok(paged > 300, `paged to ${paged}`);
  await userEvent.key(0xff50); // Home
  assert.strictEqual(top(), 0);
  await userEvent.key(0xff57); // End
  assert.ok(top() > 10000);
  const zoom = node.zoom;
  await userEvent.key(0x003d, { modifiers: ['Control'] });
  assert.ok(node.zoom > zoom);
});

test('a selection of everything reads pages nobody has looked at', async () => {
  const pages = Array.from({ length: 80 }, () => ({ width: 400, height: 500 }));
  const engine = new FakePdfEngine(pages, {
    text: (page) => lineOfText(`page${page}`, 40, 40, 12, 14),
  });
  const { handle, node } = await mounted(engine);
  await settled(engine, node);
  await userEvent.click(node as never);
  await userEvent.key(0x0061, { modifiers: ['Control'] });
  const text = await handle.selectedText();
  const lines = text.split('\n');
  assert.strictEqual(lines.length, 80);
  assert.strictEqual(lines[0], 'page0');
  assert.strictEqual(lines[79], 'page79');
  await userEvent.key(0xff1b); // Escape
  assert.strictEqual(await handle.selectedText(), '');
});

test('a screen reader reads the pages in view', async () => {
  const pages = Array.from({ length: 20 }, () => ({ width: 400, height: 500 }));
  const engine = new FakePdfEngine(pages, {
    text: (page) => lineOfText(`page${page}`, 40, 40, 12, 14),
  });
  const { node } = await mounted(engine);
  await settled(engine, node);
  await waitFor(() => assert.match(node.a11yTextState()?.value ?? '', /page0/));
  assert.ok(!/page19/.test(node.a11yTextState()!.value));
  await act(async () => node.scrollToPage(19));
  await settled(engine, node);
  await waitFor(() =>
    assert.match(node.a11yTextState()?.value ?? '', /page19/),
  );
  assert.ok(!/page0/.test(node.a11yTextState()!.value));
});

test('at a scale that is no whole number a scroll still meets its band', async (t) => {
  const rest = holdClock(t, restClock);
  const engine = new FakePdfEngine(FOUR_PAGES);
  const { result, node } = await mounted(engine, { scale: 1.5, zoom: 1.13 });
  await settled(engine, node);
  // A zoom about a point leaves the scroll wherever the arithmetic came to,
  // and a blit from there would not meet the strip it exposed.
  await act(async () => node.zoomTo(1.27, 173.3, 211.7));
  for (const step of [37, 101, 53]) {
    await act(async () => node.scrollBy({ y: step }));
  }
  await rest.finish();
  await waitFor(() =>
    assert.ok(
      engine.requests.some((r) => r.level !== engine.requests[0]!.level),
      'still at the first level',
    ),
  );
  await settled(engine, node);
  const box = node.contentBox();
  const layout = placePages(FOUR_PAGES, 1.27, 10, box.width / 1.5);
  const internals = node as unknown as { _left: number; _top: number };
  assert.ok(Number.isInteger(internals._top * 1.5));
  const checked = await showsPages(
    result,
    node,
    layout,
    { left: internals._left, top: internals._top },
    samples(box),
  );
  assert.ok(checked > 10, `only ${checked} points were on a page`);
});

test('a press on a link goes where it says', async () => {
  const followed: Array<{ url?: string; page?: number }> = [];
  const engine = new FakePdfEngine(FOUR_PAGES, {
    links: () => [
      { x: 40, y: 40, width: 100, height: 20, url: 'https://example.com/' },
    ],
  });
  const { node } = await mounted(engine, {
    props: { onLink: (link: { url?: string }) => followed.push(link) },
  });
  await settled(engine, node);
  await waitFor(() =>
    assert.ok(
      (node as unknown as { _links: Map<number, unknown> })._links.size > 0,
      'no links yet',
    ),
  );
  const box = node.contentBox();
  const layout = placePages(FOUR_PAGES, 1, 10, box.width);
  const page = layout.pages[0]!;
  const point = {
    dx: page.x + 60 * PX_PER_POINT - box.width / 2,
    dy: page.y + 50 * PX_PER_POINT - box.height / 2,
  };
  await userEvent.click(node as never, point as never);
  assert.deepStrictEqual(followed, [{ url: 'https://example.com/' }]);
});

test('a document that goes away is closed', async () => {
  const engine = new FakePdfEngine(FOUR_PAGES);
  const { result, node } = await mounted(engine);
  await settled(engine, node);
  await act(async () => result.root.unmount());
  assert.strictEqual(engine.closed, 1);
});

test('no engine is a fallback, not a throw', async () => {
  const failing: PdfEngine = {
    open: async () => {
      throw new PdfOpenError('password', 'locked');
    },
    render: async () => null,
    text: async () => ({ text: '', boxes: new Float32Array(0) }),
    links: async () => [],
    close: () => {},
  };
  const seen: string[] = [];
  await renderX11(
    React.createElement(Pdf, {
      data: new Uint8Array(4),
      engine: failing,
      onStatus: (status: string) => seen.push(status),
      fallback: ({ status }) =>
        React.createElement('text', null, `state ${status}`),
    }),
  );
  await waitFor(() => assert.deepStrictEqual(seen, ['password']));
});
