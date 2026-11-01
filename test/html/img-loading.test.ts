// What a page's script hears of an `<img>`: `load` and `error`, `complete`,
// the size of its image and what `decode()` waits for, in the document and
// out of it (`HtmlViewNode.askImage`, HTML 4.8.4.3).
//
// This file does not load the engine ahead of the first page: the first test
// is an image that came to something before the engine's chunk was in, which
// `useScripts` keeps for the page.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, renderX11, screen } from 'react-x11/test';

import { owedClock } from '../../src/html/node.js';
import { holdClock } from '../held-clock.js';
import { Html, useHtmlHandle } from '../../src/html/index.js';
import type {
  HtmlHandle,
  HtmlProps,
  ResourceRequest,
  ResourceResult,
} from '../../src/html/index.js';
import type { Rect } from 'react-x11';
import type { HtmlViewNode } from '../../src/html/node.js';
import {
  FONTS,
  RED_PNG,
  findById,
  h,
  solidPng,
  withForeignObjects,
} from './harness.js';

afterEach(cleanup);

const PAGE = 'https://example.test/dir/page.html';

/** The image bytes a page's URLs answer with, by the file's name. */
type Images = Record<string, Uint8Array | Promise<Uint8Array | null>>;

interface Page {
  handle: HtmlHandle;
  /** Every image asked of the host, by the file's name. */
  asked: string[];
  log(): string[];
  /** The pane, scrolled to `y` and to `x`, and the frames after it. */
  scroll(y: number, x?: number): Promise<void>;
}

function textOf(node: { children?: unknown[]; data?: string }): string {
  if (typeof node.data === 'string') return node.data;
  return (node.children ?? []).map((n) => textOf(n as never)).join('');
}

/** What a page's `log()` wrote, a line an entry. */
const LOG =
  '<pre id="log"></pre><script>function log() {' +
  '  document.getElementById("log").textContent +=' +
  '    Array.prototype.join.call(arguments, " ") + "\\n"; }</script>';

async function show(
  source: string,
  images: Images = {},
  props: Partial<HtmlProps> = {},
  scale = 1,
): Promise<Page> {
  const out = { asked: [] as string[] } as Page;
  const name = (url: string): string => url.slice(url.lastIndexOf('/') + 1);
  const onResource = (
    request: ResourceRequest,
  ): ResourceResult | null | Promise<ResourceResult | null> => {
    if (request.kind !== 'image') return null;
    const file = name(request.url);
    out.asked.push(file);
    const found = images[file];
    if (!found) return null;
    if (found instanceof Uint8Array) return { kind: 'image', bytes: found };
    return found.then((bytes) => bytes && { kind: 'image', bytes });
  };
  function Shown() {
    const handle = useHtmlHandle();
    out.handle = handle;
    return h(
      'box',
      {
        'data-testname': 'pane',
        style: { width: 400, height: 300, overflow: 'scroll' },
      },
      h(Html, {
        source: LOG + source,
        partial: false,
        baseUrl: PAGE,
        scripts: true,
        onResource,
        ref: handle.ref,
        ...props,
      }),
    );
  }
  await renderX11(
    h(Shown),
    FONTS
      ? { width: 440, height: 400, fonts: FONTS, scale }
      : { backend: 'mock', scale },
  );
  out.log = () => {
    const el = findById(out.handle.document, 'log');
    return el
      ? textOf(el as never)
          .split('\n')
          .filter(Boolean)
      : [];
  };
  out.scroll = async (y, x = 0) => {
    const pane = screen.getByTestName('pane') as unknown as {
      scrollTo(to: { x: number; y: number }): void;
    };
    await act(() => pane.scrollTo({ x, y }));
    await act();
    await turns();
  };
  return out;
}

/** Let the page's turns run until `lines` lines are logged, and those. */
async function logged(page: Page, lines: number): Promise<string[]> {
  const end = Date.now() + 5000;
  while (page.log().length < lines && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 5)));
  }
  return page.log();
}

/** Let the page's turns run until `files` are asked for, and those. */
async function asked(page: Page, files: number): Promise<string[]> {
  const end = Date.now() + 5000;
  while (page.asked.length < files && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 5)));
  }
  return page.asked;
}

/** A few of the page's turns, for what is not to happen. */
async function turns(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(() => new Promise((r) => setTimeout(r, 2)));
  }
}

/** A promise a test settles, and its answer. */
function held<T>(): { promise: Promise<T>; answer(value: T): void } {
  let answer!: (value: T) => void;
  const promise = new Promise<T>((done) => (answer = done));
  return { promise, answer };
}

test('an image that came to something before the engine was in is heard by the handler in its markup', async () => {
  const page = await show(
    '<img src="a.png" onload="log(\'loaded\', this.complete, this.naturalWidth)">',
    { 'a.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 1), ['loaded true 10']);
});

test('new Image() loads its image out of the document, and is told what it came to', async () => {
  const bytes = held<Uint8Array | null>();
  const page = await show(
    '<script>var i = new Image();' +
      'log("before", i.complete, i.currentSrc === "", i.naturalWidth);' +
      'i.onload = function () { log("load", i.complete, i.naturalWidth, i.naturalHeight, i.width, i.height, i.currentSrc); };' +
      'i.onerror = function () { log("error"); };' +
      'i.src = "b.png";' +
      'log("asked", i.complete, i.currentSrc === "");</script>',
    { 'b.png': bytes.promise },
  );
  assert.deepEqual(await logged(page, 2), [
    'before true true 0',
    'asked false true',
  ]);
  bytes.answer(solidPng(6, 4, [0, 128, 0]));
  assert.equal(
    (await logged(page, 3))[2],
    'load true 6 4 6 4 https://example.test/dir/b.png',
  );
});

test('an image that fails is an error, complete, and has no size', async () => {
  const page = await show(
    '<script>var i = new Image();' +
      'i.onload = function () { log("load"); };' +
      'i.onerror = function () { log("error", i.complete, i.naturalWidth, i.width, i.currentSrc.slice(-8)); };' +
      'i.src = "none.png";</script>',
  );
  assert.deepEqual(await logged(page, 1), ['error true 0 0 none.png']);
});

test('an image the document has is there as it is asked for, and still heard of a task later', async () => {
  const page = await show(
    '<script>var i = new Image();' +
      'i.onload = function () {' +
      '  var j = new Image(); j.src = "a.png";' +
      '  log("here", j.complete, j.naturalWidth, j.currentSrc.slice(-5));' +
      '  j.onload = function () { log("load"); };' +
      '};' +
      'i.src = "a.png";</script>',
    { 'a.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 2), ['here true 10 a.png', 'load']);
});

test('bytes that decode to nothing are an error: the test a page makes for a format', async () => {
  const page = await show(
    '<script>var i = new Image();' +
      'i.onload = function () { log("load", i.width > 0 && i.height > 0); };' +
      'i.onerror = function () { log("error"); };' +
      'i.src = "broken.png";</script>',
    { 'broken.png': new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
  );
  assert.deepEqual(await logged(page, 1), ['error']);
});

test('an empty src is an error, and no src at all is nothing to hear of', async () => {
  const page = await show(
    '<script>var i = new Image();' +
      'i.onerror = function () { log("error", i.complete); };' +
      'i.src = "";' +
      'var j = new Image();' +
      'j.onerror = j.onload = function () { log("heard"); };' +
      'j.alt = "x";' +
      'log("none", j.complete);</script>',
  );
  assert.deepEqual(await logged(page, 2), ['none true', 'error true']);
  await turns();
  assert.equal(page.log().length, 2);
});

test('of two sources set in one task, only the last is told', async () => {
  const page = await show(
    '<script>var i = new Image();' +
      'i.onload = function () { log("load", i.currentSrc.slice(-5)); };' +
      'i.src = "a.png";' +
      'i.src = "b.png";</script>',
    { 'a.png': RED_PNG, 'b.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 1), ['load b.png']);
  await turns();
  assert.equal(page.log().length, 1);
});

test('a source set again loads again, as a page that retries one expects', async () => {
  const page = await show(
    '<script>var i = new Image(), n = 0;' +
      'i.onload = function () { log("load"); if (++n < 2) i.src = i.src; };' +
      'i.src = "a.png";</script>',
    { 'a.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 2), ['load', 'load']);
  await turns();
  assert.equal(page.log().length, 2);
  assert.deepEqual(page.asked, ['a.png'], 'the image is the one the store has');
});

test('an image in the markup is heard once, by the capture a lazy loader listens with', async () => {
  const page = await show(
    '<script>document.addEventListener("load", function (e) {' +
      '  log("captured", e.target.id, e.bubbles); }, true);</script>' +
      '<img id="a" src="a.png" onload="log(\'load\', this.id)">',
    { 'a.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 2), ['captured a false', 'load a']);
  await act(() => page.handle.refresh());
  await turns();
  assert.equal(page.log().length, 2);
});

test('a script that changes an image in the document is told of the new one', async () => {
  const page = await show(
    '<img id="a" src="a.png" onload="log(\'load\', this.currentSrc.slice(-5))">' +
      '<script>window.addEventListener("load", function () {' +
      '  document.getElementById("a").src = "b.png"; });</script>',
    { 'a.png': RED_PNG, 'b.png': solidPng(3, 3, [0, 0, 255]) },
  );
  assert.deepEqual(await logged(page, 2), ['load a.png', 'load b.png']);
});

test('the window is loaded after the images, in the document and out of it', async () => {
  const late = held<Uint8Array | null>();
  const page = await show(
    '<img src="a.png" onload="log(\'in\')">' +
      '<script>var i = new Image(); i.onload = function () { log("out"); };' +
      'i.src = "late.png";' +
      'window.addEventListener("load", function () { log("window"); });</script>',
    { 'a.png': RED_PNG, 'late.png': late.promise },
  );
  assert.deepEqual(await logged(page, 1), ['in']);
  await turns();
  assert.equal(page.log().length, 1, 'the page waits for the image it made');
  late.answer(RED_PNG);
  assert.deepEqual(await logged(page, 3), ['in', 'out', 'window']);
});

test('a srcset out of the document is chosen for the display, and is its density across', async () => {
  const page = await show(
    '<script>var i = new Image();' +
      'i.onload = function () { log("load", i.naturalWidth, i.currentSrc.slice(-7)); };' +
      'i.srcset = "one.png 1x, two.png 2x";</script>',
    {
      'one.png': solidPng(4, 4, [255, 0, 0]),
      'two.png': solidPng(8, 8, [0, 255, 0]),
    },
    {},
    2,
  );
  assert.deepEqual(await logged(page, 1), ['load 4 two.png']);
  assert.deepEqual(page.asked, ['two.png']);
});

test('an <img> in a <picture> is told of the source it chose', async () => {
  const page = await show(
    '<picture><source srcset="wide.png" media="(min-width: 100px)">' +
      '<img id="a" src="narrow.png" onload="log(\'load\', this.currentSrc.slice(-8))"></picture>',
    { 'wide.png': RED_PNG, 'narrow.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 1), ['load wide.png']);
  await turns();
  assert.equal(page.log().length, 1);
});

test('a source a script changes in the document is not complete until it has come', async () => {
  const late = held<Uint8Array | null>();
  const page = await show(
    '<img id="a" srcset="a.png 1x" onload="log(\'load\', this.complete)">' +
      '<script>var a = document.getElementById("a");' +
      'window.addEventListener("load", function () {' +
      '  a.srcset = "b.png 1x"; log("set", a.complete); });</script>',
    { 'a.png': RED_PNG, 'b.png': late.promise },
  );
  assert.deepEqual(await logged(page, 2), ['load true', 'set false']);
  late.answer(RED_PNG);
  assert.deepEqual(await logged(page, 3), [
    'load true',
    'set false',
    'load true',
  ]);
});

test('decode() waits for the image and says what it came to', async () => {
  const page = await show(
    '<script>var e = function (x) { return x.name; };' +
      'var i = new Image(); i.src = "a.png";' +
      'var d = i.decode().then(function () { log("decoded", i.complete, i.naturalWidth); });' +
      'var b = new Image(); b.src = "none.png";' +
      'var f = b.decode().then(function () { log("no"); }, function (x) { log("failed", e(x)); });' +
      'd.then(function () { return new Image().decode(); }).then(' +
      '  function () { log("no"); }, function (x) { log("no image", e(x)); });</script>',
    { 'a.png': RED_PNG },
  );
  assert.deepEqual([...(await logged(page, 3))].sort(), [
    'decoded true 10',
    'failed EncodingError',
    'no image EncodingError',
  ]);
});

test('innerHTML and a copy load their images, out of the document as well', async () => {
  const page = await show(
    '<script>var d = document.createElement("div");' +
      'd.innerHTML = \'<img src="a.png" onload="log(\\\'inner\\\')">\';' +
      'var i = new Image(); i.src = "b.png";' +
      'var c = i.cloneNode(); c.onload = function () { log("copy"); };</script>',
    { 'a.png': RED_PNG, 'b.png': RED_PNG },
  );
  assert.deepEqual([...(await logged(page, 2))].sort(), ['copy', 'inner']);
});

test('what is in a <template> asks for nothing until it is used', async () => {
  const page = await show(
    '<template id="t"><img id="in"></template>' +
      '<script>var t = document.getElementById("t");' +
      'var i = t.content.firstChild; i.src = "a.png";' +
      'log("set", i.complete);' +
      'setTimeout(function () { log("later");' +
      '  var c = document.importNode(t.content, true).firstChild;' +
      '  c.onload = function () { log("used"); };' +
      '  document.body.appendChild(c); }, 0);</script>',
    { 'a.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 3), ['set true', 'later', 'used']);
});

test('a page that only reads what its images came to costs no getComputedStyle', async () => {
  const page = await show(
    '<img id="a" src="a.png"><script>var a = document.getElementById("a");' +
      'var s = getComputedStyle(a), n = 0;' +
      'var first = s.display;' +
      'for (var i = 0; i < 1000; i += 1) { n += a.complete ? 1 : 0; n += s.display.length; }' +
      'log("read", first === s.display);</script>',
    { 'a.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 1), ['read true']);
});

// --- loading="lazy" --------------------------------------------------------
//
// HTML 2.5.7, and what Chrome, Firefox and WebKit do with it, each case
// tried in all three. The window's height is 300px and an image is near
// within 4,000px of it until `load` and 1,250px after, so `FAR` is past both.

const FAR = '<div style="height:5000px"></div>';

/** A script that runs `then` once the test says so (`go`), which leaves the
 *  first paint and what it asked for to be looked at first. */
const onGo = (then: string) =>
  '<i id="go"></i><script>var on = setInterval(function () {' +
  `  if (go.hasAttribute("title")) { clearInterval(on); ${then}; }` +
  '}, 2);</script>';

/** The element a page is drawn by. */
function nodeOf(page: Page): HtmlViewNode {
  const { ref } = page.handle as unknown as {
    ref: { current: HtmlViewNode };
  };
  return ref.current;
}

/** How many layouts the element is owed from here on, as it runs them. */
function countLayouts(page: Page): () => number {
  const inner = nodeOf(page) as unknown as {
    _stale: number;
    _update(target: number): void;
  };
  const update = inner._update;
  let laid = 0;
  inner._update = function (target) {
    if (inner._stale !== 0) laid += 1;
    update.call(inner, target);
  };
  return () => laid;
}

async function go(page: Page): Promise<void> {
  await act(async () => {
    findById(page.handle.document, 'go')!.attribs.title = 'go';
  });
}

test('a lazy image far from the viewport waits, and a page reads an image that has come to nothing yet', async () => {
  const page = await show(
    FAR +
      '<img id="a" loading="lazy" src="a.png" alt="alt" width="50" height="60">' +
      '<script>log(a.complete, "[" + a.currentSrc + "]", a.naturalWidth, a.width, a.height, a.loading);' +
      'addEventListener("load", function () { log("window", a.complete); });</script>',
    { 'a.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 2), [
    'false [] 0 50 60 lazy',
    'window false',
  ]);
  assert.deepEqual(page.asked, []);
});

test('loading reads as the keyword it comes to, whatever is written', async () => {
  const page = await show(
    '<script>var i = new Image(); log("[" + i.getAttribute("loading") + "]", i.loading);' +
      'i.loading = "soon"; log(i.getAttribute("loading"), i.loading);' +
      'i.setAttribute("loading", "LAZY"); log(i.loading);</script>',
  );
  assert.deepEqual(await logged(page, 3), [
    '[null] eager',
    'soon eager',
    'lazy',
  ]);
});

test('a lazy image is asked for as the viewport comes near it, and not before, in time for a scroll to find it', async () => {
  const page = await show(
    '<div style="height:900px"></div>' +
      '<img id="near" loading="lazy" src="near.png" width="5" height="5">' +
      FAR +
      '<img id="far" loading="lazy" src="far.png" width="5" height="5">' +
      '<script>[near, far].forEach(function (i) {' +
      '  i.onload = function () { log("load", i.id, i.naturalWidth); };' +
      '});</script>',
    { 'near.png': RED_PNG, 'far.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 1), ['load near 10']);
  assert.deepEqual(page.asked, ['near.png']);
  // 1,250 short of it: the image comes before the reader does
  await page.scroll(4700);
  assert.deepEqual(await logged(page, 2), ['load near 10', 'load far 10']);
  assert.deepEqual(page.asked, ['near.png', 'far.png']);
});

test('what is drawn in the viewport is asked for first, whatever its order in the document', async () => {
  const page = await show(
    '<img loading="lazy" src="plain-far.png" width="5" height="5" ' +
      'style="position:absolute;top:1200px">' +
      '<picture><source srcset="seen.png">' +
      '<img loading="lazy" src="x.png" width="5" height="5"></picture>',
  );
  assert.deepEqual(await asked(page, 2), ['seen.png', 'plain-far.png']);
});

test('a lazy image holds no load: not one in the viewport, whatever it comes to', async () => {
  const bytes = held<Uint8Array | null>();
  const page = await show(
    '<img id="a" loading="lazy" src="a.png" width="5" height="5">' +
      '<script>a.onload = function () { log("image", a.complete); };' +
      'addEventListener("load", function () { log("window", a.complete); });</script>',
    { 'a.png': bytes.promise },
  );
  assert.deepEqual(await logged(page, 1), ['window false']);
  bytes.answer(RED_PNG);
  assert.deepEqual(await logged(page, 2), ['window false', 'image true']);
});

test('a lazy image on its way holds no load: the eager one it waits beside ends it', async () => {
  const lazy = held<Uint8Array | null>();
  const gate = held<Uint8Array | null>();
  const page = await show(
    '<img id="a" loading="lazy" src="a.png" width="5" height="5">' +
      '<img id="g" src="gate.png" width="5" height="5">' +
      '<script>addEventListener("load", function () { log("window", a.complete); });</script>',
    { 'a.png': lazy.promise, 'gate.png': gate.promise },
  );
  assert.deepEqual(await asked(page, 2), ['gate.png', 'a.png']);
  await turns();
  assert.deepEqual(page.log(), []);
  gate.answer(RED_PNG);
  assert.deepEqual(await logged(page, 1), ['window false']);
});

test('an eager image of the same URL holds the load a lazy one did not', async () => {
  const lazy = held<Uint8Array | null>();
  const gate = held<Uint8Array | null>();
  const page = await show(
    '<img id="a" loading="lazy" src="a.png" width="5" height="5">' +
      '<img id="g" src="gate.png" width="5" height="5">' +
      '<script>addEventListener("load", function () { log("window"); });' +
      'setTimeout(function () {' +
      '  log("eager");' +
      '  var i = document.createElement("img"); i.src = "a.png";' +
      '  document.body.appendChild(i);' +
      '}, 30);</script>',
    { 'a.png': lazy.promise, 'gate.png': gate.promise },
  );
  assert.deepEqual(await logged(page, 1), ['eager']);
  assert.deepEqual(page.asked, ['gate.png', 'a.png']);
  gate.answer(RED_PNG);
  await turns();
  assert.deepEqual(page.log(), ['eager'], 'the load waits for it now');
  lazy.answer(RED_PNG);
  assert.deepEqual(await logged(page, 2), ['eager', 'window']);
});

test('where scripts are off a lazy image is asked for as any is, which no server can read a scroll from', async () => {
  const page = await show(
    FAR + '<img loading="lazy" src="a.png" width="5" height="5">',
    { 'a.png': RED_PNG },
    { scripts: false },
  );
  assert.deepEqual(await asked(page, 1), ['a.png']);
});

test("a lazy image's decode() waits with it, and its load is heard once it comes", async () => {
  const page = await show(
    FAR +
      '<img id="a" loading="lazy" src="a.png" width="5" height="5">' +
      '<script>a.decode().then(function () { log("decoded", a.naturalWidth); },' +
      '  function (e) { log("rejected", e.name); });' +
      'setTimeout(function () { log("waiting"); }, 0);</script>',
    { 'a.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 1), ['waiting']);
  await turns();
  assert.equal(page.log().length, 1, 'nothing has settled it');
  await page.scroll(4000);
  assert.deepEqual(await logged(page, 2), ['waiting', 'decoded 10']);
});

test('a lazy image in no document waits for one, and for the viewport once it is in one', async () => {
  const page = await show(
    FAR +
      '<div id="end"></div>' +
      '<script>var i = new Image(); i.loading = "lazy";' +
      'i.onload = function () { log("load"); };' +
      'i.src = "a.png"; log("made", i.complete);' +
      'setTimeout(function () { log("in"); end.appendChild(i); }, 0);' +
      '</script>',
    { 'a.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 2), ['made false', 'in']);
  await turns();
  assert.deepEqual(page.asked, []);
  await page.scroll(4000);
  assert.deepEqual(await logged(page, 3), ['made false', 'in', 'load']);
});

test('a lazy image with no box waits for one: display: none has none and visibility: hidden has', async () => {
  const page = await show(
    '<img id="none" loading="lazy" src="none.png" width="5" height="5" style="display:none">' +
      '<img loading="lazy" src="hidden.png" width="5" height="5" style="visibility:hidden">' +
      '<script>log("waits", none.complete);</script>',
    { 'none.png': RED_PNG, 'hidden.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 1), ['waits false']);
  await turns();
  assert.deepEqual(page.asked, ['hidden.png']);
  await act(async () => {
    findById(page.handle.document, 'none')!.attribs.style = 'display:block';
    page.handle.refresh();
  });
  assert.deepEqual(await asked(page, 2), ['hidden.png', 'none.png']);
});

for (const [name, change] of [
  ['set eager', 'a.loading = "eager"'],
  ['taken away', 'a.removeAttribute("loading")'],
  ['nonsense', 'a.setAttribute("loading", "soon")'],
] as const) {
  test(`a lazy image whose loading is ${name} is asked for at once`, async () => {
    const page = await show(
      FAR +
        '<img id="a" loading="lazy" src="a.png" width="5" height="5">' +
        '<script>a.onload = function () { log("load"); };' +
        `setTimeout(function () { log("now"); ${change}; }, 0);</script>`,
      { 'a.png': RED_PNG },
    );
    assert.deepEqual(await logged(page, 2), ['now', 'load']);
  });
}

test("a picture's lazy image made eager is asked for by the choice made again", async () => {
  const page = await show(
    FAR +
      '<picture><source srcset="s.png"><img id="a" loading="lazy" src="i.png" width="5" height="5"></picture>' +
      '<script>a.onload = function () { log("load", a.currentSrc.slice(-5)); };</script>' +
      onGo('a.loading = "eager"'),
    { 's.png': RED_PNG },
  );
  await turns();
  await turns();
  assert.deepEqual(page.asked, []);
  await go(page);
  assert.deepEqual(await logged(page, 1), ['load s.png']);
  assert.deepEqual(page.asked, ['s.png']);
});

test('a loaded image made lazy, or eager again, loads nothing and tells nothing', async () => {
  const page = await show(
    '<img id="a" src="a.png" width="5" height="5" ' +
      "onload=\"log('load'); a.loading = 'lazy'; a.loading = 'eager';\">",
    { 'a.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 1), ['load']);
  await turns();
  assert.equal(page.log().length, 1);
  assert.deepEqual(page.asked, ['a.png']);
});

test('a lazy image given another source waits for the viewport again', async () => {
  const page = await show(
    FAR +
      '<img id="a" src="a.png" width="5" height="5">' +
      '<script>a.loading = "lazy";' +
      'addEventListener("load", function () {' +
      '  a.src = "b.png"; log("set", a.complete);' +
      '});</script>',
    { 'a.png': RED_PNG, 'b.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 1), ['set false']);
  await turns();
  assert.deepEqual(page.asked, ['a.png']);
  await page.scroll(4000);
  assert.deepEqual(await asked(page, 2), ['a.png', 'b.png']);
});

test('a lazy source set straight after its src, in one task, is lazy', async () => {
  const page = await show(
    FAR +
      '<img id="a" width="5" height="5">' +
      '<script>a.src = "a.png"; a.loading = "lazy";' +
      'a.onload = function () { log("load"); };</script>',
    { 'a.png': RED_PNG },
  );
  await turns();
  assert.deepEqual(page.asked, []);
  await page.scroll(4000);
  assert.deepEqual(await logged(page, 1), ['load']);
});

test('what the document already has shows in a lazy image however far it is, and is heard', async () => {
  const page = await show(
    '<img id="e" src="a.png" width="5" height="5">' +
      FAR +
      '<img id="a" loading="lazy" src="a.png" width="5" height="5" ' +
      'onload="log(\'lazy\', this.naturalWidth)">',
    { 'a.png': RED_PNG },
  );
  assert.deepEqual(await logged(page, 1), ['lazy 10']);
  assert.deepEqual(page.asked, ['a.png']);
});

test('a background that asks first for what a lazy image shows sizes the image as it lands', async () => {
  const page = await show(
    '<div style="height:5px;background-image:url(a.png)"></div>' +
      FAR +
      '<img id="a" loading="lazy" src="a.png" onload="log(\'load\', this.offsetWidth)">',
    { 'a.png': Promise.resolve(RED_PNG) },
  );
  assert.deepEqual(await logged(page, 1), ['load 10']);
  assert.deepEqual(page.asked, ['a.png']);
});

test('a lazy image a script puts in for what a background asked for takes its size from it', async () => {
  const bytes = held<Uint8Array | null>();
  const page = await show(
    '<div id="s" style="height:5px;background-image:url(a.png)"></div>' +
      '<script>setTimeout(function () {' +
      '  var i = document.createElement("img"); i.loading = "lazy"; i.src = "a.png";' +
      '  i.onload = function () { log("load", i.offsetWidth); };' +
      '  s.appendChild(i); log("in");' +
      '}, 30);</script>',
    { 'a.png': bytes.promise },
  );
  assert.deepEqual(await logged(page, 1), ['in']);
  await turns();
  bytes.answer(RED_PNG);
  assert.deepEqual(await logged(page, 2), ['in', 'load 10']);
  assert.deepEqual(page.asked, ['a.png']);
});

test('a lazy srcset chooses as the rest do and asks for what it chose alone, once it is near', async () => {
  const page = await show(
    FAR +
      '<img id="a" loading="lazy" srcset="s.png 1x, l.png 2x" width="5" height="5">' +
      '<script>a.onload = function () { log("load", a.currentSrc.slice(-5)); };</script>',
    { 'l.png': RED_PNG },
    {},
    2,
  );
  await turns();
  assert.deepEqual(page.asked, []);
  await page.scroll(4000);
  assert.deepEqual(await logged(page, 1), ['load l.png']);
  assert.deepEqual(page.asked, ['l.png']);
});

test('a lazy sizes="auto" asks for what its laid-out width picks, once it is near', async () => {
  const page = await show(
    FAR +
      '<img id="a" loading="lazy" sizes="auto" srcset="s.png 20w, l.png 40w" ' +
      'style="width:20px;height:5px" onload="log(\'load\', this.currentSrc.slice(-5))">',
    { 's.png': RED_PNG },
  );
  await turns();
  assert.deepEqual(page.asked, []);
  await page.scroll(4000);
  assert.deepEqual(await asked(page, 1), ['s.png']);
  assert.deepEqual(await logged(page, 1), ['load s.png']);
});

test('a host that answers as it is asked is told of as one that answers later is', async () => {
  const page = await show(
    '<img id="a" loading="lazy" src="a.png" width="5" height="5">' +
      '<img id="b" loading="lazy" src="none.png" width="5" height="5">' +
      '<script>a.onload = function () { log("load", a.naturalWidth); };' +
      'b.onerror = function () { log("error", b.complete); };</script>',
    { 'a.png': RED_PNG },
  );
  assert.deepEqual([...(await logged(page, 2))].sort(), [
    'error true',
    'load 10',
  ]);
});

test('an image clipped by what scrolls waits for that to come near it, as well as the viewport', async () => {
  const carousel = (id: string, left: number) =>
    `<div style="position:absolute;left:${left}px"><img id="${id}" loading="lazy" src="${id}.png" width="5" height="5"></div>`;
  const page = await show(
    '<div id="s" style="position:relative;width:300px;height:100px;overflow:hidden">' +
      carousel('near', 1000) +
      carousel('far', 6000) +
      '</div>' +
      '<div style="position:relative;height:100px;overflow:clip">' +
      carousel('cut', 800) +
      '</div>' +
      onGo('s.scrollLeft = 5000'),
    { 'near.png': RED_PNG, 'far.png': RED_PNG, 'cut.png': RED_PNG },
  );
  assert.deepEqual(await asked(page, 1), ['near.png']);
  await turns();
  assert.deepEqual(page.asked, ['near.png'], 'not the one 5,700px on');
  await go(page);
  assert.deepEqual(await asked(page, 2), ['near.png', 'far.png']);
  await turns();
  assert.equal(
    page.asked.length,
    2,
    '`clip` scrolls nothing, and has no margin',
  );
});

test('an image in a scroll container is asked for as that scrolls', async () => {
  const page = await show(
    '<div id="s" style="height:200px;overflow:auto">' +
      FAR +
      '<img id="a" loading="lazy" src="a.png" width="5" height="5">' +
      '</div>' +
      onGo('s.scrollTop = 4000'),
    { 'a.png': RED_PNG },
  );
  await turns();
  assert.deepEqual(page.asked, []);
  await go(page);
  assert.deepEqual(await asked(page, 1), ['a.png']);
});

test('a box fixed to the viewport is near it wherever the pane has scrolled to', async () => {
  const page = await show(
    FAR +
      '<img id="f" loading="lazy" src="f.png" width="5" height="5" style="display:none;position:fixed;top:0">',
    { 'f.png': RED_PNG },
  );
  await page.scroll(4800);
  assert.deepEqual(page.asked, []);
  await act(async () => {
    findById(page.handle.document, 'f')!.attribs.style = 'position:fixed;top:0';
    page.handle.refresh();
  });
  assert.deepEqual(await asked(page, 1), ['f.png']);
});

test('a pane that scrolls across brings images near as one that scrolls down does', async () => {
  const page = await show(
    '<img loading="lazy" src="a.png" width="5" height="5" style="position:absolute;left:8000px;top:0">',
    { 'a.png': RED_PNG },
    { style: { width: 9000 } },
  );
  await turns();
  assert.deepEqual(page.asked, []);
  await page.scroll(0, 7000);
  assert.deepEqual(await asked(page, 1), ['a.png']);
});

test('near is nearer once the document has loaded, where its boxes are no longer a guess', async () => {
  const gate = held<Uint8Array | null>();
  const page = await show(
    '<img src="gate.png" width="5" height="5">' +
      '<div style="height:3000px"></div>' +
      '<img id="soon" loading="lazy" src="soon.png" width="5" height="5">' +
      '<img id="after" loading="lazy" src="after.png" width="5" height="5" ' +
      'style="display:none">' +
      '<script>addEventListener("load", function () { log("loaded"); });</script>',
    { 'gate.png': gate.promise, 'soon.png': RED_PNG, 'after.png': RED_PNG },
  );
  assert.deepEqual(await asked(page, 2), ['gate.png', 'soon.png']);
  gate.answer(RED_PNG);
  await logged(page, 1);
  await act(async () => {
    findById(page.handle.document, 'after')!.attribs.style = 'display:block';
    page.handle.refresh();
  });
  await turns();
  assert.equal(page.asked.length, 2, 'past 1,250, and within 4,000');
  await page.scroll(1800);
  assert.deepEqual(await asked(page, 3), ['gate.png', 'soon.png', 'after.png']);
});

test('a paint walks what waits only once the pane has moved far enough for it to matter, or the boxes have', async () => {
  const images = Array.from(
    { length: 10 },
    (_, i) =>
      `<img loading="lazy" src="${i}.png" width="5" height="5" style="position:absolute;top:${9000 + i}px">`,
  ).join('');
  const page = await show(images + FAR + FAR + '<div id="b"></div>');
  await turns();
  const node = nodeOf(page);
  const proto = Object.getPrototypeOf(node);
  let walked = 0;
  const away = proto._lazyAway;
  proto._lazyAway = function (...a: unknown[]) {
    walked += 1;
    return away.apply(this, a);
  };
  try {
    for (const y of [50, 100, 150, 200, 250]) await page.scroll(y);
    assert.equal(walked, 0, 'a scroll of less than a step walks nothing');
    await page.scroll(400);
    assert.equal(walked, 10, 'one past it walks them once');
    await act(async () => {
      findById(page.handle.document, 'b')!.attribs.style = 'height:9px';
      page.handle.refresh();
    });
    await turns();
    assert.equal(walked, 20, 'and the boxes moving walks them again');
  } finally {
    proto._lazyAway = away;
  }
});

test('what an image shows stays there while the source it is given waits to be near', async () => {
  const page = await show(
    '<img id="a" loading="lazy" srcset="a.png" width="5" height="5">' +
      FAR +
      FAR,
    { 'a.png': RED_PNG, 'b.png': RED_PNG },
  );
  await asked(page, 1);
  await turns();
  const node = nodeOf(page);
  const el = findById(page.handle.document, 'a')!;
  await page.scroll(5000);
  await act(async () => {
    el.attribs.srcset = 'b.png';
    page.handle.refresh();
  });
  await turns();
  assert.deepEqual(
    (
      node as unknown as { _images: { shown(e: unknown): { url: string } } }
    )._images
      .shown(el)
      .url.slice(-5),
    'a.png',
    'scrolled away, it is asked for nothing and shows what it has',
  );
});

test('an image a transform brings near is near, and one it takes away is not', async () => {
  const page = await show(
    '<div style="height:3000px"></div>' +
      '<div style="position:absolute;top:0;left:0;width:100%">' +
      '<div style="transform:translateY(5000px)"><img loading="lazy" src="away.png" width="5" height="5"></div>' +
      '</div>' +
      '<div style="position:absolute;top:6000px;transform:translateY(-6000px)">' +
      '<img loading="lazy" src="back.png" width="5" height="5"></div>' +
      '<div style="position:absolute;top:0;left:0;transform:scale(100);transform-origin:0 0">' +
      '<div style="margin-top:50px"><img loading="lazy" src="scaled.png" width="5" height="5"></div></div>',
  );
  assert.deepEqual(await asked(page, 1), ['back.png']);
  await turns();
  assert.deepEqual(page.asked, ['back.png']);
});

test('what a <foreignObject> holds is asked for with its drawing', (t) => {
  withForeignObjects(t);
  return (async () => {
    const page = await show(
      '<svg width="50" height="50"><foreignObject width="50" height="50">' +
        '<img xmlns="http://www.w3.org/1999/xhtml" loading="lazy" src="a.png" width="5" height="5">' +
        '</foreignObject></svg>',
      { 'a.png': RED_PNG },
    );
    assert.deepEqual(await asked(page, 1), ['a.png']);
  })();
});

test('a lazy image that lands off screen lays nothing out until the reader comes near it, or a read asks', async (t) => {
  holdClock(t, owedClock);
  const bytes = held<Uint8Array | null>();
  const page = await show(
    '<div style="height:1000px"></div>' +
      '<div id="mark"></div>' +
      '<img id="a" loading="lazy" src="a.png" style="display:block">' +
      '<div id="after"></div>' +
      FAR +
      '<script>addEventListener("load", function () {});</script>',
    { 'a.png': bytes.promise },
  );
  await asked(page, 1);
  await turns();
  const node = nodeOf(page);
  const laid = countLayouts(page);
  bytes.answer(RED_PNG);
  await turns();
  await turns();
  assert.equal(laid(), 0, 'off screen, nothing moved for it');
  const after = findById(page.handle.document, 'after')!;
  const mark = findById(page.handle.document, 'mark')!;
  // what a read answers is what a whole build would: the image's 10px
  const rect = node.elementRect(after as never)!;
  const start = node.elementRect(mark as never)!;
  assert.equal(rect.y - start.y, 10);
});

test('a lazy image that lands in view takes its size at once', async (t) => {
  holdClock(t, owedClock);
  const bytes = held<Uint8Array | null>();
  const page = await show(
    '<img id="a" loading="lazy" src="a.png" style="display:block"><div id="b"></div>',
    { 'a.png': bytes.promise },
  );
  await asked(page, 1);
  await turns();
  const node = nodeOf(page) as unknown as {
    _owed: Map<unknown, unknown>;
    _tree: { images: { intrinsic?: { width: number } }[] };
  };
  bytes.answer(RED_PNG);
  const end = Date.now() + 5000;
  while (node._tree.images[0]?.intrinsic?.width === 0 && Date.now() < end) {
    await turns();
  }
  assert.ok(node._tree.images[0].intrinsic!.width > 0, 'it has its size');
  assert.equal(node._owed.size, 0, 'and nothing waits for it');
});

test('a lazy image comes in when the reader comes near where it landed', async (t) => {
  holdClock(t, owedClock);
  const bytes = held<Uint8Array | null>();
  const page = await show(
    '<div style="height:1000px"></div>' +
      '<img loading="lazy" src="a.png" style="display:block">' +
      FAR,
    { 'a.png': bytes.promise },
  );
  await asked(page, 1);
  await turns();
  const inner = nodeOf(page) as unknown as { _owed: Map<unknown, unknown> };
  bytes.answer(RED_PNG);
  const end = Date.now() + 5000;
  while (!inner._owed.size && Date.now() < end) await turns();
  assert.equal(inner._owed.size, 1, 'it waits');
  await page.scroll(500);
  assert.equal(inner._owed.size, 0, 'and a frame of the scroll takes it');
});

test('a size a pixel from the one a lazy image has waits for the scroll to end, in view or not', async (t) => {
  holdClock(t, owedClock);
  const bytes = held<Uint8Array | null>();
  const page = await show(
    '<img id="a" loading="lazy" src="a.png" width="10" height="11" ' +
      'style="display:block;height:auto"><div id="b"></div>' +
      FAR,
    { 'a.png': bytes.promise },
  );
  await asked(page, 1);
  await turns();
  const node = nodeOf(page);
  const inner = node as unknown as {
    _owed: Map<unknown, unknown>;
    _inputAt: number;
    _owedSlice(): void;
  };
  const laid = countLayouts(page);
  bytes.answer(RED_PNG);
  const end = Date.now() + 5000;
  while (!inner._owed.size && Date.now() < end) await turns();
  assert.equal(inner._owed.size, 1, 'in view, and it waits');
  await page.scroll(100);
  await page.scroll(600);
  assert.equal(laid(), 0, 'a scroll past it asks nothing');
  inner._inputAt = -Infinity;
  inner._owedSlice();
  await turns();
  assert.equal(inner._owed.size, 0, 'and the idle thread takes it');
  assert.equal(
    node.elementRect(findById(page.handle.document, 'b') as never)!.y -
      node.elementRect(findById(page.handle.document, 'a') as never)!.y,
    10,
  );
});

test('a lazy image that lands off screen repaints nothing, and one in view repaints itself', async () => {
  const near = held<Uint8Array | null>();
  const seen = held<Uint8Array | null>();
  const page = await show(
    '<div style="height:90px;background:#00ff00"></div>' +
      '<img loading="lazy" src="seen.png" width="20" height="20" style="display:block">' +
      '<div style="height:900px"></div>' +
      '<img loading="lazy" src="near.png" width="20" height="20" style="display:block">',
    { 'near.png': near.promise, 'seen.png': seen.promise },
  );
  await asked(page, 2);
  await turns();
  const node = nodeOf(page);
  const proto = Object.getPrototypeOf(node);
  const damages: (Rect | null)[] = [];
  const paint = proto.paint;
  proto.paint = function (this: HtmlViewNode, ctx: never) {
    damages.push(this.paintDamage());
    return paint.call(this, ctx);
  };
  try {
    near.answer(RED_PNG);
    await turns();
    assert.equal(damages.length, 0, 'off screen, nothing is painted for it');
    seen.answer(RED_PNG);
    const end = Date.now() + 5000;
    while (!damages.length && Date.now() < end) await turns();
    assert.ok(damages.length > 0, 'it is painted');
    for (const d of damages) {
      assert.ok(d, 'and a part of the document');
      assert.ok(d.height <= 24, `${d.height}px tall, for an image of 20`);
    }
  } finally {
    proto.paint = paint;
  }
});

test('scrolling past lazy images, and an observer watching one, lays nothing out', async () => {
  const images = Array.from(
    { length: 40 },
    (_, i) =>
      `<img loading="lazy" src="${i}.png" width="5" height="500" style="display:block">`,
  ).join('');
  const page = await show(
    images +
      '<div id="t" style="height:1px"></div><script>' +
      'new IntersectionObserver(function () {}).observe(t);</script>',
  );
  await turns();
  const laid = countLayouts(page);
  for (let y = 300; y <= 3000; y += 300) await page.scroll(y);
  // the images are declined, which moves nothing
  assert.equal(laid(), 0);
  assert.ok(page.asked.length < 40);
  assert.ok(page.asked.length > 6);
});
