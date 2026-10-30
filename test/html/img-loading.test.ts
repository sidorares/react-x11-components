// What a page's script hears of an `<img>`: `load` and `error`, `complete`,
// the size of its image and what `decode()` waits for, in the document and
// out of it (`HtmlViewNode.askImage`, HTML 4.8.4.3).
//
// This file does not load the engine ahead of the first page: the first test
// is an image that came to something before the engine's chunk was in, which
// `useScripts` keeps for the page.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html, useHtmlHandle } from '../../src/html/index.js';
import type {
  HtmlHandle,
  HtmlProps,
  ResourceRequest,
  ResourceResult,
} from '../../src/html/index.js';
import { FONTS, RED_PNG, findById, h, solidPng } from './harness.js';

afterEach(cleanup);

const PAGE = 'https://example.test/dir/page.html';

/** The image bytes a page's URLs answer with, by the file's name. */
type Images = Record<string, Uint8Array | Promise<Uint8Array | null>>;

interface Page {
  handle: HtmlHandle;
  /** Every image asked of the host, by the file's name. */
  asked: string[];
  log(): string[];
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
      { style: { width: 400, height: 300, overflow: 'scroll' } },
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
