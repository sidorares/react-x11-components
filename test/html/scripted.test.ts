// `<Html scripts>`: a document's scripts turned on with one prop, every seam
// the example browser used to fill by hand given a default
// (`src/html/scripts/scripted.ts`). The engine itself is `scripts.test.ts`'s;
// these hold the wiring — what is on by default and what is not, what goes
// through the application's seams, and where the page is shown.
//
// This file does not load the engine ahead of the first page, as
// `scripts.test.ts` does: the first test is the page that is parsed before
// the engine's chunk is in, which `useScripts` keeps what it reports for.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { TestContext } from 'node:test';
import { useState } from 'react';
import { act, cleanup, renderX11, screen, userEvent } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import {
  Html,
  HtmlNetwork,
  preloadHtmlScripts,
  useHtmlHandle,
} from '../../src/html/index.js';
import type {
  FetchRequest,
  FetchResponse,
  HtmlHandle,
  HtmlProps,
  HtmlScripts,
  ResourceRequest,
} from '../../src/html/index.js';
import { frameClock, resizeClock } from '../../src/html/node.js';
import { ScriptEngine } from '../../src/html/scripts/engine.js';
import { holdClock } from '../held-clock.js';
import {
  FONTS,
  drawnText,
  findById,
  h,
  mountBetweenFrames,
} from './harness.js';
import type { HtmlViewNode } from '../../src/html/index.js';

afterEach(cleanup);

const PAGE = 'https://example.test/page.html';

function textOf(node: { children?: unknown[]; data?: string }): string {
  if (typeof node.data === 'string') return node.data;
  return (node.children ?? []).map((n) => textOf(n as never)).join('');
}

interface Shown {
  handle: HtmlHandle;
  pane: () => DrawnNode & {
    scrollTo(to: { x?: number; y?: number }): void;
    scrollY: number;
  };
  text(id: string): string;
  /** What the document draws. */
  drawn(): string;
}

/** A document in a scroll pane 300 pixels tall, as an application shows
 *  one: `<Html>` with the props given and nothing else, on a display of
 *  `scale`. */
async function shown(
  source: string,
  props: Partial<HtmlProps> = {},
  scale = 1,
) {
  const out = {} as Shown;
  let pane: unknown = null;
  function Page() {
    const handle = useHtmlHandle();
    out.handle = handle;
    return h(
      'box',
      {
        ref: (node: unknown) => void (pane = node),
        style: { width: 400, height: 300, overflow: 'scroll' },
      },
      h(Html, {
        source,
        partial: false,
        baseUrl: PAGE,
        ref: handle.ref,
        ...props,
      }),
    );
  }
  await renderX11(
    h(Page),
    FONTS
      ? { width: 440, height: 400, fonts: FONTS, scale }
      : { backend: 'mock', scale },
  );
  out.pane = () => pane as ReturnType<Shown['pane']>;
  out.drawn = () =>
    drawnText(
      (out.handle as unknown as { ref: { current: HtmlViewNode } }).ref.current,
    );
  out.text = (id) => {
    const el = findById(out.handle.document, id);
    return el ? textOf(el as never) : '';
  };
  return out;
}

/** Let the page's turns run until `done` holds of an element's text, and
 *  that text either way. */
async function until(
  page: Shown,
  id: string,
  done: (text: string) => boolean,
  ms = 5000,
): Promise<string> {
  const end = Date.now() + ms;
  while (!done(page.text(id)) && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  return page.text(id);
}

test('one prop runs a page: what it reported before the engine was in is run in order once it is', async (t) => {
  const page = await shown(
    '<p id="out"></p><noscript><p id="ns">fallback</p></noscript>' +
      '<script>var order = ["first"];</script>' +
      '<script>order.push("second");' +
      'document.addEventListener("DOMContentLoaded", function () { order.push("ready"); });' +
      'window.addEventListener("load", function () {' +
      '  order.push("load", innerWidth, navigator.userAgent.indexOf("react-x11") >= 0);' +
      '  document.getElementById("out").textContent = order.join("|"); });' +
      '</script>',
    { scripts: true },
  );
  // what the render found before the engine was here
  if (!(await preloadHtmlScripts())) {
    t.skip('this runtime keeps no page in its context');
    return;
  }
  const text = await until(page, 'out', (s) => s !== '');
  assert.equal(text, 'first|second|ready|load|400|true');
  // a `<noscript>` is nothing where scripts run
  assert.ok(!page.drawn().includes('fallback'), page.drawn());
});

test('scripts are off unless they are turned on', async () => {
  const page = await shown(
    '<p id="out">untouched</p><noscript><p id="ns">fallback</p></noscript>' +
      '<script>document.getElementById("out").textContent = "ran";</script>',
  );
  await act(() => new Promise((r) => setTimeout(r, 50)));
  assert.equal(page.text('out'), 'untouched');
  assert.match(page.drawn(), /fallback/);
});

test('what a page loads goes through the application: a script through onResource, a fetch through scripts.fetch', async (t) => {
  if (!(await preloadHtmlScripts())) return t.skip();
  const asked: ResourceRequest[] = [];
  const fetched: FetchRequest[] = [];
  const page = await shown(
    '<p id="out"></p><script id="s" src="lib.js"></script>' +
      '<script>fetch("/api").then(function (r) { return r.text(); })' +
      '.then(function (body) { document.getElementById("out").textContent = lib + "|" + body; });' +
      '</script>',
    {
      onResource: (request) => {
        asked.push(request);
        return request.kind === 'script'
          ? {
              kind: 'script',
              bytes: new TextEncoder().encode('var lib = "lib";'),
            }
          : null;
      },
      scripts: {
        fetch: async (request) => {
          fetched.push(request);
          return {
            url: request.url,
            status: 200,
            statusText: 'OK',
            redirected: false,
            headers: [['content-type', 'text/plain']],
            body: 'answered',
          };
        },
      },
    },
  );
  assert.equal(await until(page, 'out', (s) => s !== ''), 'lib|answered');
  const script = asked.find((r) => r.kind === 'script');
  assert.equal(script?.url, 'https://example.test/lib.js');
  assert.equal(script?.element.attribs.id, 's');
  assert.deepEqual(
    fetched.map((r) => [r.method, r.url]),
    [['GET', 'https://example.test/api']],
  );
});

test('a page with no scripts.fetch has no network: its requests fail, and nothing else is asked', async (t) => {
  if (!(await preloadHtmlScripts())) return t.skip();
  const page = await shown(
    '<p id="out"></p><script>' +
      'fetch("/api").then(function () { return "answered"; }, function (e) { return e.name; })' +
      '.then(function (r) { document.getElementById("out").textContent = r; });' +
      '</script>',
    { scripts: true },
  );
  assert.equal(await until(page, 'out', (s) => s !== ''), 'TypeError');
});

test('a page that adopted a sheet hands the element the same sheets as its scripts change the document, so a change restyles what it reaches and not all of it', async (t) => {
  if (!(await preloadHtmlScripts())) return t.skip();
  // Each refresh the page's scripts make renders `<Html>` again, and the
  // element restyles the whole document when its `stylesheet` is another
  // array: merged afresh at every render, GitHub's pages, which adopt the
  // popover polyfill's sheet, were styled whole at each class a script set
  const page = await shown(
    '<style>.a { color: rgb(0, 0, 0) }</style>' +
      '<p id="z" class="a">z</p><p id="out"></p><script>' +
      'var sheet = new CSSStyleSheet(); sheet.replaceSync(".b { color: rgb(1, 2, 3) }");' +
      'document.adoptedStyleSheets = [sheet];' +
      'var z = document.getElementById("z"), out = document.getElementById("out");' +
      'setTimeout(function () { z.className = "b"; out.textContent = "b";' +
      '  setTimeout(function () { z.className = "a"; out.textContent = "a";' +
      '    setTimeout(function () { sheet.insertRule(".a { color: rgb(4, 5, 6) }", 1);' +
      '      out.textContent = "edited"; }, 200);' +
      '  }, 200);' +
      '}, 200);' +
      '</script>',
    { scripts: true },
  );
  const view = (
    page.handle as unknown as {
      ref: { current: { props: { stylesheet?: unknown } } };
    }
  ).ref.current;
  const z = () => findById(page.handle.document, 'z')!;
  const rest = () => act(() => new Promise((r) => setTimeout(r, 30)));
  await until(page, 'out', (s) => s === 'b');
  await rest();
  assert.equal(page.handle.computedStyle(z())?.color, 'rgb(1, 2, 3)');
  const sheets = view.props.stylesheet;
  assert.ok(Array.isArray(sheets), 'the adopted sheet reaches the element');
  await until(page, 'out', (s) => s === 'a');
  await rest();
  assert.equal(page.handle.computedStyle(z())?.color, 'rgb(0, 0, 0)');
  assert.ok(
    view.props.stylesheet === sheets,
    'the same array after the refresh rendered <Html> again',
  );
  // and a sheet the page edits is another sheet
  await until(page, 'out', (s) => s === 'edited');
  await rest();
  assert.equal(page.handle.computedStyle(z())?.color, 'rgb(4, 5, 6)');
});

test('what leaves the document is handed to its seams: location, the title, the console', async (t) => {
  if (!(await preloadHtmlScripts())) return t.skip();
  const went: string[] = [];
  const titles: (string | null)[] = [];
  const logged: string[] = [];
  const scripts: HtmlScripts = {
    navigate: (url, how) => void went.push(`${how} ${url}`),
    title: (title) => void titles.push(title),
    log: (level, text) => void logged.push(`${level}: ${text}`),
  };
  const page = await shown(
    '<p id="out"></p><script>' +
      'document.title = "Named"; console.warn("careful");' +
      'location.href = "next.html"; window.open("/other", "_blank");' +
      'document.getElementById("out").textContent = "done";' +
      '</script>',
    { scripts },
  );
  await until(page, 'out', (s) => s === 'done');
  // an address assigned while the document is loading, with no user
  // activation, replaces its entry (HTML's Location-object navigate)
  assert.deepEqual(went, [
    'replace https://example.test/next.html',
    'tab https://example.test/other',
  ]);
  assert.deepEqual(titles, ['Named']);
  assert.ok(logged.includes('warn: careful'), logged.join('\n'));
});

test('the handle asks the document whether it may be left: its beforeunload, and the prompt where it asks to be confirmed and has been used', async (t) => {
  if (!(await preloadHtmlScripts())) return t.skip();
  let answer = false;
  let prompts = 0;
  const logged: string[] = [];
  const scripts: HtmlScripts = {
    promptToUnload: () => {
      prompts += 1;
      return answer;
    },
    log: (level, text) => void logged.push(text),
  };
  const page = await shown(
    '<input type="button" value="go"><p id="out"></p><script>' +
      'onbeforeunload = function () { console.log("asked"); return "stay?"; };' +
      'document.getElementById("out").textContent = "ready";' +
      '</script>',
    { scripts },
  );
  await until(page, 'out', (s) => s === 'ready');
  // nobody has used it: asked, and left with no prompt
  assert.equal(page.handle.beforeUnload(), true);
  assert.equal(prompts, 0);
  await userEvent.click(screen.getByRole('button') as DrawnNode);
  assert.equal(page.handle.beforeUnload(), false, 'the prompt kept it');
  answer = true;
  assert.equal(page.handle.beforeUnload(), true);
  assert.equal(prompts, 2);
  assert.equal(logged.filter((text) => text === 'asked').length, 3);
  // and a document with no scripts is left as it is
  const still = await shown('<p>no scripts</p>');
  assert.equal(still.handle.beforeUnload(), true);
});

test('the handle runs what a console typed in the page, and hands back only what it came to, written out', async (t) => {
  if (!(await preloadHtmlScripts())) return t.skip();
  const page = await shown(
    '<p id="out"></p><script>' +
      'var greeting = "hi";' +
      'document.getElementById("out").textContent = "ready";' +
      '</script>',
    { scripts: {} },
  );
  await until(page, 'out', (s) => s === 'ready');
  const said = (r: ReturnType<HtmlHandle['evaluate']>) =>
    r && { text: r.text, threw: r.threw };
  // the page's own globals, and a string quoted as a console shows one
  assert.deepEqual(said(page.handle.evaluate('greeting + "!"')), {
    text: '"hi!"',
    threw: false,
  });
  // `{ … }` typed alone is an object, not a block
  assert.deepEqual(said(page.handle.evaluate('{ a: 1, b: [2, 3] }')), {
    text: '{ a: 1, b: [2, 3] }',
    threw: false,
  });
  // what it declares is the window's, for the next line to read
  page.handle.evaluate('var counted = 41');
  assert.deepEqual(said(page.handle.evaluate('counted + 1')), {
    text: '42',
    threw: false,
  });
  // an element is its tag, and what it changes is drawn
  assert.deepEqual(
    said(
      page.handle.evaluate(
        'var p = document.getElementById("out"); p.textContent = "changed"; p',
      ),
    ),
    { text: '<p>', threw: false },
  );
  await until(page, 'out', (s) => s === 'changed');
  // what it throws, and what does not parse, comes back as the error
  const thrown = page.handle.evaluate('nope.at.all');
  assert.equal(thrown?.threw, true);
  assert.match(thrown!.text, /ReferenceError/);
  // its stack stops at the line typed: the frames that ran it are the host's
  assert.doesNotMatch(thrown!.text, /ScriptEngine|evalmachine|node:vm/);
  // and a function of the page's it went through is still in it
  page.handle.evaluate('function broken() { throw new TypeError("deep"); }');
  const deep = page.handle.evaluate('broken()');
  assert.match(deep!.text, /TypeError: deep\n\s+at broken/);
  assert.doesNotMatch(deep!.text, /ScriptEngine|evalmachine|node:vm/);
  const unparsed = page.handle.evaluate('1 +');
  assert.equal(unparsed?.threw, true);
  assert.match(unparsed!.text, /SyntaxError/);
  // a page that replaced its own `eval` is still run as typed
  page.handle.evaluate('window.eval = function () { return "fake"; }');
  assert.deepEqual(said(page.handle.evaluate('6 * 7')), {
    text: '42',
    threw: false,
  });
  // and a document with no scripts has nothing to run it in
  const still = await shown('<p>no scripts</p>');
  assert.equal(still.handle.evaluate('1'), null);
});

test('an object the console came to is read a level at a time, and let go', async (t) => {
  if (!(await preloadHtmlScripts())) return t.skip();
  const page = await shown(
    '<p id="out"></p><script>' +
      'var shared = { n: 1, list: [10, "x"], get later() { throw new Error("read"); } };' +
      'document.getElementById("out").textContent = "ready";' +
      '</script>',
    { scripts: {} },
  );
  await until(page, 'out', (s) => s === 'ready');
  const result = page.handle.evaluate('shared');
  assert.equal(result?.value?.type, 'object');
  const id = result!.value!.id!;
  assert.equal(typeof id, 'number');
  const props = page.handle.inspectValue(id)!;
  const byName = new Map(props.map((p) => [p.name, p]));
  assert.deepEqual(byName.get('n')?.value, { type: 'number', text: '1' });
  // a getter is not read, which would run the page's code
  assert.equal(byName.get('later')?.value.type, 'accessor');
  assert.equal(byName.get('[[Prototype]]')?.enumerable, false);
  const list = byName.get('list')!.value;
  assert.equal(list.type, 'array');
  assert.match(list.text, /^\(2\) /);
  const items = page.handle.inspectValue(list.id!)!;
  assert.deepEqual(
    items.filter((p) => p.enumerable).map((p) => [p.name, p.value.text]),
    [
      ['0', '10'],
      ['1', '"x"'],
    ],
  );
  // a primitive has no id; an element is a node
  assert.equal(page.handle.evaluate('42')?.value?.id, undefined);
  assert.equal(page.handle.evaluate('document.body')?.value?.type, 'node');
  // let go, an object is no longer there to read
  page.handle.releaseValues();
  assert.equal(page.handle.inspectValue(id), null);
});

test('workers are on unless they are turned off', async (t) => {
  if (!(await preloadHtmlScripts())) return t.skip();
  const page = await shown(
    '<p id="out"></p><script>' +
      'try { new Worker("w.js"); document.getElementById("out").textContent = "made"; }' +
      'catch (e) { document.getElementById("out").textContent = e.name; }' +
      '</script>',
    { scripts: { workers: false } },
  );
  assert.equal(await until(page, 'out', (s) => s !== ''), 'NotSupportedError');
});

test('the page is shown in the pane around <Html>: it measures it, scrolls it, and hears it scroll', async (t) => {
  if (!(await preloadHtmlScripts())) return t.skip();
  const page = await shown(
    '<p id="out"></p><div style="height:2000px"></div><script>' +
      'var r = [innerWidth, innerHeight];' +
      'window.addEventListener("scroll", function () {' +
      '  r.push("scroll", scrollY); document.getElementById("out").textContent = r.join("|"); });' +
      'scrollTo(0, 50);' +
      '</script>',
    { scripts: true },
  );
  // the page's `scrollTo` moved the pane, and the pane's move is the
  // page's `scroll`
  const text = await until(page, 'out', (s) => s.includes('scroll'));
  assert.equal(page.pane().scrollY, 50);
  assert.equal(text, '400|300|scroll|50');
  // and so is one the reader makes
  await act(async () => page.pane().scrollTo({ y: 120 }));
  assert.equal(
    await until(page, 'out', (s) => s.endsWith('|120')),
    '400|300|scroll|50|scroll|120',
  );
});

test("a page's scripts measure it at the width it is drawn at from the parse on, however long the window takes to lay it out", async (t) => {
  if (!(await preloadHtmlScripts())) return t.skip();
  // the frame that lays the page out comes a quarter of a second after
  // its parse, where Chrome lays a page out at the viewport's width before
  // any script measures it
  const source =
    '<div id="d" style="border: 3px solid"></div><p id="out"></p><script>' +
    "var d = document.getElementById('d'), seen = [];" +
    'function note(at) {' +
    "  seen.push(at + ' ' + d.getBoundingClientRect().width + ' ' + d.offsetWidth + ' ' + innerWidth);" +
    "  document.getElementById('out').textContent = seen.join('|'); }" +
    "note('parse');" +
    "addEventListener('DOMContentLoaded', function () { note('ready') });" +
    "addEventListener('load', function () { note('load') });" +
    "setTimeout(function () { note('timer') }, 0);" +
    '</script>';
  const page = {} as { handle: HtmlHandle };
  function Page() {
    const handle = useHtmlHandle();
    page.handle = handle;
    return h(
      'box',
      { style: { width: 400, height: 300, overflow: 'scroll' } },
      h(Html, {
        source,
        partial: false,
        baseUrl: PAGE,
        ref: handle.ref,
        scripts: true,
      }),
    );
  }
  await mountBetweenFrames(h(Page));
  const out = () => {
    const el = page.handle.document && findById(page.handle.document, 'out');
    return el ? textOf(el as never) : '';
  };
  const end = Date.now() + 5000;
  while (out().split('|').length < 4 && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 20)));
  }
  assert.deepEqual(out().split('|').sort(), [
    'load 384 384 400',
    'parse 384 384 400',
    'ready 384 384 400',
    'timer 384 384 400',
  ]);
});

test('on a display of scale 2 the page reads the pane in its own pixels: its scroll, and what is at the top of it', async (t) => {
  // A pane's offsets are device pixels and its rect logical: read as one
  // unit, a page on a Retina display read a `scrollY` twice the pane's,
  // and an element at the viewport's top read as far above it as the
  // pane had scrolled
  if (!(await preloadHtmlScripts())) return t.skip();
  const page = await shown(
    '<style>body{margin:0}</style><p id="out"></p>' +
      '<div id="d" style="position:absolute;top:600px;width:5px;height:5px"></div>' +
      '<div style="height:2000px"></div><script>' +
      'var r = [innerWidth, innerHeight];' +
      'window.addEventListener("scroll", function () {' +
      '  r.push(scrollY, document.getElementById("d").getBoundingClientRect().top);' +
      '  document.getElementById("out").textContent = r.join("|"); });' +
      'scrollTo(0, 50);' +
      '</script>',
    { scripts: true },
    2,
  );
  assert.equal(
    await until(page, 'out', (s) => s.split('|').length > 2),
    '400|300|50|550',
  );
  // device pixels, as core keeps a pane's offsets
  assert.equal(page.pane().scrollY, 100);
  await act(async () => page.pane().scrollTo({ y: 120 }));
  assert.equal(
    await until(page, 'out', (s) => s.endsWith('|480')),
    '400|300|50|550|120|480',
  );
});

test("the page hears the pane it is shown in resized: its window's resize, then its media query lists' change, then the animation frame its listener asked for", async (t) => {
  if (!(await preloadHtmlScripts())) return t.skip();
  const source =
    '<p id="out"></p><script>' +
    'var heard = [], wide = matchMedia("(min-width: 350px)");' +
    'function note(what) { heard.push(what); document.getElementById("out").textContent = heard.join("|"); }' +
    'note(innerWidth + " " + wide.matches);' +
    'addEventListener("resize", function () {' +
    '  note("resize " + innerWidth + " " + visualViewport.width);' +
    '  requestAnimationFrame(function () { note("frame " + innerWidth); });' +
    '});' +
    'visualViewport.addEventListener("resize", function () { note("visual"); });' +
    'wide.addEventListener("change", function (e) { note("change " + e.matches); });' +
    '</script>';
  const page = {} as { handle: HtmlHandle; width: (w: number) => void };
  function Page() {
    const handle = useHtmlHandle();
    const [width, setWidth] = useState(400);
    page.handle = handle;
    page.width = setWidth;
    return h(
      'box',
      { style: { width, height: 300, overflow: 'scroll' } },
      h(Html, {
        source,
        partial: false,
        baseUrl: PAGE,
        ref: handle.ref,
        scripts: true,
      }),
    );
  }
  await renderX11(
    h(Page),
    FONTS ? { width: 440, height: 400, fonts: FONTS } : { backend: 'mock' },
  );
  const text = () => {
    const el = page.handle.document && findById(page.handle.document, 'out');
    return el ? textOf(el as never) : '';
  };
  const until = async (done: (s: string) => boolean): Promise<string> => {
    const end = Date.now() + 5000;
    while (!done(text()) && Date.now() < end) {
      await act(() => new Promise((r) => setTimeout(r, 10)));
    }
    return text();
  };
  assert.equal(await until((s) => s !== ''), '400 true');
  // a frame of quiet, and then the reader drags the pane narrower
  await act(() => new Promise((r) => setTimeout(r, 50)));
  await act(async () => page.width(300));
  assert.equal(
    await until((s) => s.includes('frame')),
    '400 true|resize 300 300|visual|change false|frame 300',
  );
});

// A drag of a window's edge the document cannot keep up with holds what its
// page hears of the viewport (`HtmlViewNode.viewportHeld`): the page's scripts
// are a cycle of their own at each width, and a layout says all its sheets do.

/** A page that says what it hears and reads, in a pane the test drags: its
 *  document's work and its scripts' time each as long as the test says. A
 *  `quiet` one writes nothing but for a `resize`, so nothing paints it. */
async function dragged(t: TestContext, extra = '', quiet = false) {
  await preloadHtmlScripts();
  const source =
    '<!DOCTYPE html><html><head><style>body{margin:0}#box{height:10px}</style></head><body>' +
    '<div id="box"></div><p id="out"></p><p id="read"></p><script>' +
    'var heard = [], ticks = 0, box = document.getElementById("box");' +
    'var wide = matchMedia("(min-width: 350px)");' +
    'function note(what) { heard.push(what); document.getElementById("out").textContent = heard.join("|"); }' +
    'addEventListener("resize", function () { note("resize " + innerWidth); });' +
    'visualViewport.addEventListener("resize", function () { note("visual"); });' +
    'wide.addEventListener("change", function (e) { note("change " + e.matches); });' +
    (quiet
      ? 'document.getElementById("read").textContent = "1 here";'
      : 'var seen = false;' +
        'new ResizeObserver(function (entries) {' +
        '  if (seen) note("observer " + entries[0].contentRect.width);' +
        '  seen = true;' +
        '}).observe(box);' +
        'setInterval(function () {' +
        '  ticks += 1;' +
        '  document.getElementById("read").textContent = ticks + " " + innerWidth + " " + wide.matches + " " + box.getBoundingClientRect().width;' +
        '}, 20);') +
    extra +
    '</script></body></html>';
  const clock = holdClock(t, resizeClock);
  const work = { value: 0 };
  let now = 0;
  t.mock.method(frameClock, 'now', () => (now += work.value));
  const scripts = { value: 0 };
  t.mock.getter(ScriptEngine.prototype, 'busy', () => scripts.value);
  const page = {} as Shown & { width: (w: number) => void };
  let pane: unknown = null;
  function Page() {
    const handle = useHtmlHandle();
    const [width, setWidth] = useState(400);
    page.handle = handle;
    page.width = setWidth;
    return h(
      'box',
      {
        ref: (node: unknown) => void (pane = node),
        style: { width, height: 300, overflow: 'scroll' },
      },
      h(Html, {
        source,
        partial: false,
        baseUrl: PAGE,
        ref: handle.ref,
        scripts: true,
      }),
    );
  }
  await renderX11(
    h(Page),
    FONTS ? { width: 640, height: 400, fonts: FONTS } : { backend: 'mock' },
  );
  page.pane = () => pane as ReturnType<Shown['pane']>;
  page.text = (id) => {
    const el = page.handle.document && findById(page.handle.document, id);
    return el ? textOf(el as never) : '';
  };
  await until(page, 'read', (s) => s !== '');
  const node = () =>
    (page.handle as unknown as { ref: { current: HtmlViewNode } }).ref.current;
  const wnd = () =>
    (node() as unknown as { root: { window: { liveResizing?: boolean } } }).root
      .window;
  const step = async (...widths: number[]): Promise<void> => {
    for (const width of widths) {
      await act(async () => page.width(width));
      await act();
    }
  };
  const held = () => (node() as unknown as { _cheap: boolean })._cheap;
  return {
    page,
    clock,
    work,
    scripts,
    step,
    held,
    /** The drag begins, or ends. */
    live: (live: boolean) => void (wnd().liveResizing = live),
    /** The drag falls behind its edge: three frames past the budget, and
     *  the page has heard the last of them. */
    async behind(...widths: number[]): Promise<void> {
      work.value = 20;
      await step(...widths);
      assert.ok(held(), 'the drag fell behind');
      const last = widths[widths.length - 1];
      await this.hears(`resize ${last}`);
      if (!quiet) await this.hears(`observer ${last}`);
    },
    /** What the page has heard. */
    heard: () => page.text('out'),
    /** What it has heard since it had heard `before`, in the order of the
     *  words: its observers look when they look, and its `resize` comes
     *  with a frame. */
    since: (before: string) =>
      page.text('out').slice(before.length).split('|').filter(Boolean).sort(),
    /** What it reads, as its clock next comes round: the width, whether
     *  the query holds, and the box. */
    async reads(): Promise<string> {
      const at = Number(page.text('read').split(' ')[0]);
      // past a look of its observers, which comes every tenth of a second
      await until(page, 'read', (s) => Number(s.split(' ')[0]) >= at + 8);
      return page.text('read').split(' ').slice(1).join(' ');
    },
    /** Until the page has heard `what`. */
    async hears(what: string): Promise<void> {
      const heard = await until(page, 'out', (s) => s.includes(what));
      assert.ok(heard.includes(what), `${what} in ${heard}`);
    },
    /** A rest for what is coming to the page, by its own clock. */
    async rests(): Promise<void> {
      await this.reads();
    },
  };
}

test('a drag that fell behind tells a page nothing and leaves what it reads true, and it hears one resize, one change and one size as the drag ends', async (t) => {
  const drag = await dragged(t);
  drag.live(true);
  await drag.behind(396, 392, 388);
  await drag.rests();
  const before = drag.heard();
  // the page's scripts have had all of the time since it last heard
  drag.scripts.value += 1e9;
  await drag.step(380, 370, 360, 340, 320);
  assert.equal(await drag.reads(), '320 false 320', 'it reads what is there');
  assert.equal(drag.heard(), before, 'and has heard none of it');
  await drag.step(310, 300);
  assert.equal(await drag.reads(), '300 false 300');
  assert.equal(drag.heard(), before);
  // the hand lets go: told once the drag rests, what it is now, once
  drag.live(false);
  await act(async () => void (await drag.clock.finish()));
  assert.ok(!drag.held());
  await drag.hears('observer 300');
  await drag.hears('change false');
  const told = ['change false', 'observer 300', 'resize 300', 'visual'];
  assert.deepEqual(drag.since(before), told);
  await drag.rests();
  assert.deepEqual(drag.since(before), told, 'and nothing more');
});

test('a hand that holds still tells the page where the drag has come to, and the next step holds it again', async (t) => {
  const drag = await dragged(t);
  drag.live(true);
  await drag.behind(396, 392, 388);
  await drag.rests();
  drag.scripts.value += 1e9;
  await drag.step(340, 320);
  await drag.rests();
  const before = drag.heard();
  assert.ok(!before.includes('resize 320'), before);
  // past a rest of the hand, with the window still saying it is dragged
  let frames = 0;
  while (drag.held() && frames < 40) {
    await act(async () => void (await drag.clock.frame()));
    frames += 1;
  }
  assert.ok(!drag.held(), 'the hand rested');
  await drag.hears('resize 320');
  await drag.hears('observer 320');
  // a page that has spent nothing since it heard hears the next step
  await drag.step(310);
  await drag.hears('resize 310');
  await drag.hears('observer 310');
  assert.ok(drag.held(), 'and it is behind again from the next step');
  const told = drag.heard();
  // and its scripts' time goes in now the drag is behind: at rest, a look of
  // the page's would count it as heard, and nothing would hold the next width
  drag.scripts.value += 1e9;
  await drag.step(300);
  await drag.rests();
  assert.equal(drag.heard(), told, 'the next width waits');
  drag.live(false);
  await act(async () => void (await drag.clock.finish()));
  await drag.hears('observer 300');
});

test('a hand that holds still tells a page that draws nothing after it, where no paint would', async (t) => {
  const drag = await dragged(t, '', true);
  drag.live(true);
  await drag.behind(396, 392, 388);
  drag.scripts.value += 1e9;
  await drag.step(340, 320);
  assert.ok(!drag.heard().includes('resize 320'), drag.heard());
  let frames = 0;
  while (drag.held() && frames < 40) {
    await act(async () => void (await drag.clock.frame()));
    frames += 1;
  }
  assert.ok(!drag.held(), 'the hand rested');
  await drag.hears('resize 320');
  drag.live(false);
  await act(async () => void (await drag.clock.finish()));
});

test('a page whose scripts take little of a drag that fell behind hears every width of it', async (t) => {
  const drag = await dragged(t);
  drag.live(true);
  await drag.behind(396, 392, 388);
  await drag.rests();
  for (const width of [380, 370, 360]) {
    await drag.step(width);
    await drag.hears(`resize ${width}`);
    await drag.hears(`observer ${width}`);
  }
  assert.ok(drag.held(), 'behind all the while');
  drag.live(false);
  await act(async () => void (await drag.clock.finish()));
});

test('a page told nothing hears again once its scripts have had their part of the time since', async (t) => {
  const drag = await dragged(t);
  drag.live(true);
  await drag.behind(396, 392, 388);
  await drag.rests();
  drag.scripts.value += 1000;
  await drag.step(380, 370);
  await drag.rests();
  const before = drag.heard();
  assert.ok(!before.includes('resize 370'), before);
  // the document's work goes on the same clock, and the time goes by
  drag.work.value = 100_000;
  await drag.step(360);
  await drag.hears('resize 360');
  await drag.hears('observer 360');
  drag.live(false);
  await act(async () => void (await drag.clock.finish()));
});

test('a drag the document keeps up with tells a page every width, and so does a window that says nothing of a drag', async (t) => {
  const drag = await dragged(t);
  // the clock moves at the document's work, and none of it is past the
  // budget; the page's scripts have spent all there is
  drag.work.value = 1;
  drag.scripts.value += 1e9;
  drag.live(true);
  for (const width of [396, 392, 388, 384]) {
    await drag.step(width);
    await drag.hears(`resize ${width}`);
    await drag.hears(`observer ${width}`);
    drag.scripts.value += 1e9;
  }
  assert.ok(!drag.held());
  drag.live(false);
  // X11's: past the budget at every frame
  drag.work.value = 20;
  for (const width of [380, 376, 372, 368]) {
    await drag.step(width);
    await drag.hears(`resize ${width}`);
    await drag.hears(`observer ${width}`);
    drag.scripts.value += 1e9;
  }
  assert.ok(!drag.held());
});

test('a drag that came back to where it was tells a page nothing, across a breakpoint and back', async (t) => {
  const drag = await dragged(t);
  drag.live(true);
  await drag.behind(396, 392, 388);
  await drag.rests();
  drag.scripts.value += 1e9;
  await drag.step(340, 320);
  assert.equal(await drag.reads(), '320 false 320');
  await drag.step(340, 388);
  assert.equal(await drag.reads(), '388 true 388');
  const before = drag.heard();
  drag.live(false);
  await act(async () => void (await drag.clock.finish()));
  await drag.rests();
  await drag.rests();
  assert.equal(drag.heard(), before, 'it is where the page last heard');
});

test('what a drag holds a page from is its viewport: an observer of a new target, and what leaves the view, are told at once', async (t) => {
  const drag = await dragged(
    t,
    'var edge = document.createElement("div");' +
      'edge.style.cssText = "position:absolute;top:0;left:385px;width:10px;height:4px";' +
      'document.body.appendChild(edge);' +
      'var shown = null;' +
      'new IntersectionObserver(function (entries) {' +
      '  var now = entries[entries.length - 1].isIntersecting;' +
      '  if (shown !== null && now !== shown) note("shown " + now);' +
      '  shown = now;' +
      '}).observe(edge);' +
      'var tracked = false;' +
      'setInterval(function () {' +
      '  if (innerWidth >= 385 || tracked) return;' +
      '  tracked = true;' +
      '  var late = document.createElement("div");' +
      '  late.style.height = "3px";' +
      '  document.body.appendChild(late);' +
      '  new ResizeObserver(function (entries) { note("late " + entries[0].contentRect.height); }).observe(late);' +
      '}, 20);',
  );
  drag.live(true);
  await drag.behind(396, 392, 388);
  await drag.rests();
  drag.scripts.value += 1e9;
  await drag.step(380);
  await drag.hears('shown false');
  await drag.hears('late 3');
  assert.ok(!drag.heard().includes('resize 380'), drag.heard());
  assert.ok(!drag.heard().includes('observer 380'), drag.heard());
  drag.live(false);
  await act(async () => void (await drag.clock.finish()));
  await drag.hears('observer 380');
  await drag.hears('resize 380');
});

test("a frame's document that runs in the page's realm is held with the page", async (t) => {
  const drag = await dragged(
    t,
    'var frame = document.createElement("iframe");' +
      'frame.style.cssText = "display:block;border:0;width:50%;height:20px";' +
      'document.body.appendChild(frame);' +
      'var inner = frame.contentWindow;' +
      'inner.addEventListener("resize", function () { note("frame " + inner.innerWidth); });' +
      'setInterval(function () { window.frameWidth = inner.innerWidth; }, 20);',
  );
  drag.live(true);
  await drag.behind(396, 392, 388);
  await drag.rests();
  drag.scripts.value += 1e9;
  const before = drag.heard();
  await drag.step(340, 300);
  await drag.rests();
  assert.equal(drag.heard(), before);
  drag.live(false);
  await act(async () => void (await drag.clock.finish()));
  await drag.hears('frame 150');
  assert.equal(drag.heard().split('frame 150').length, 2, 'once');
  assert.ok(!drag.heard().includes('frame 170'), drag.heard());
});

test("an HtmlNetwork answers a document's scripts and its page's requests", async () => {
  const sent: string[] = [];
  const network = new HtmlNetwork({
    connectTimeout: null,
    fetch: async (url, init) => {
      sent.push(`${init.method} ${url} ${init.headers.referer ?? ''}`);
      const body = new TextEncoder().encode('var x = 1;');
      return {
        url,
        status: 200,
        statusText: 'OK',
        redirected: false,
        headers: new Map([
          ['content-type', 'text/javascript; charset=utf-8'],
        ]) as unknown as FetchResponseHeaders,
        body: {
          getReader() {
            let done = false;
            return {
              read: async () =>
                done
                  ? { done: true }
                  : ((done = true), { done: false, value: body }),
              cancel: async () => {},
            };
          },
        },
      };
    },
  });
  const onResource = network.resources(PAGE);
  const element = { attribs: {} } as unknown as ResourceRequest['element'];
  const script = await onResource({
    url: 'https://example.test/a.js',
    kind: 'script',
    element,
  });
  assert.equal(script?.kind, 'script');
  // a secure page's script over an insecure connection is not asked for
  assert.equal(
    await network.resources('https://secure.test/')({
      url: 'http://example.test/b.js',
      kind: 'script',
      element,
    }),
    null,
  );
  const answer: FetchResponse = await network.fetcher(PAGE)(
    { url: 'https://example.test/api', method: 'GET', headers: [], body: null },
    new AbortController().signal,
  );
  assert.equal(answer.body, 'var x = 1;');
  assert.deepEqual(sent, [
    'GET https://example.test/a.js https://example.test/page.html',
    'GET https://example.test/api https://example.test/page.html',
  ]);
});

type FetchResponseHeaders = {
  get(name: string): string | null;
  entries(): IterableIterator<[string, string]>;
};
