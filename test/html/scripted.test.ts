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
import { act, cleanup, renderX11 } from 'react-x11/test';
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
import { FONTS, drawnText, findById, h } from './harness.js';
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
 *  one: `<Html>` with the props given and nothing else. */
async function shown(source: string, props: Partial<HtmlProps> = {}) {
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
    FONTS ? { width: 440, height: 400, fonts: FONTS } : { backend: 'mock' },
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
  assert.deepEqual(went, [
    'here https://example.test/next.html',
    'tab https://example.test/other',
  ]);
  assert.deepEqual(titles, ['Named']);
  assert.ok(logged.includes('warn: careful'), logged.join('\n'));
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
