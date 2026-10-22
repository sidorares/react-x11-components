// One shard of a web-platform-tests run through <Html scripts>: each test
// loaded from WPT's own server (`./wpt serve`) as the example browser loads
// a page — `HtmlNetwork` for the document and what it asks for, the page's
// scripts in the engine — and its outcome read back the way WPT's runner
// reads a browser's.
//
//   node --import tsx scripts/conformance/testharness.tsx <list> <out.jsonl>
//
// <list> is a file of test paths as wpt.fyi names them (`a/b.any.html`,
// `c.html?variant`), one a line; `interop.ts` writes it and shards it. One
// JSON line per test on <out.jsonl>.
//
// - **testharness.js tests** report through the `testharnessreport.js` this
//   host answers in place of the checkout's stub, as wptrunner does: every
//   subtest's outcome and the harness's status, written to the console,
//   which `scripts.log` hears.
// - **Reftests** are rendered with their scripts on, held until
//   `reftest-wait` is gone, read back at 800×600 and compared with their
//   reference within the `fuzzy` the test allows.
// - **Crashtests** pass when the document loads and the renderer neither
//   throws nor hangs.
// - **`test_driver`** is answered by this host: the vendor script it loads
//   sends each command to a path the page's `fetch` reaches the host
//   through, and the host injects the input into the in-process X server.
//
// The server's hosts are `web-platform.test` and its subdomains, which this
// process resolves to the loopback itself, so nothing on the machine has to
// change; `interop.ts` hands Node WPT's CA for the https ones.
import dns from 'node:dns';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import React from 'react';
import { ThemeProvider } from 'react-x11';
import { act, renderX11 } from 'react-x11/test';
import type { RenderX11Result } from 'react-x11/test';

import { Html, HtmlNetwork, useHtmlHandle } from '../../src/html/index.js';
import type {
  HtmlHandle,
  HtmlProps,
  HtmlScripts,
  ResourceRequest,
} from '../../src/html/index.js';

const h = React.createElement;

const WIDTH = 800;
const HEIGHT = 600;
const HOST = 'web-platform.test';
const HTTP_PORT = 8000;
const HTTPS_PORT = 8443;
const H2_PORT = 9000;

const [listFile, outFile] = process.argv.slice(2);
if (!listFile || !outFile) {
  console.error('usage: testharness.tsx <list> <out.jsonl>');
  process.exit(2);
}

// WPT's hosts, on the loopback where wptserve listens
{
  const lookup = dns.lookup;
  const ours = /(^|\.)(not-)?web-platform\.test$/i;
  (dns as { lookup: unknown }).lookup = function (
    host: string,
    options: unknown,
    callback?: (...args: unknown[]) => void,
  ) {
    const cb = (typeof options === 'function' ? options : callback) as (
      ...args: unknown[]
    ) => void;
    const opts = (typeof options === 'object' && options) || {};
    if (ours.test(host)) {
      if ((opts as { all?: boolean }).all) {
        process.nextTick(cb, null, [{ address: '127.0.0.1', family: 4 }]);
      } else process.nextTick(cb, null, '127.0.0.1', 4);
      return;
    }
    return (lookup as (...a: unknown[]) => unknown).call(
      dns,
      host,
      options,
      callback,
    );
  };
}

const FONTS: Record<string, string> = {
  serif: '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf',
  'sans-serif':
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  monospace: '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',
};

const PALETTE = {
  text: '#000000',
  accent: '#0000ee',
  background: '#ffffff',
  surface: '#ffffff',
  border: '#808080',
  textMuted: '#000000',
};

/** The address wpt.fyi runs a test at: https for `.https.` and `.h2.`, a
 *  subdomain for `.www.`. */
export function urlFor(test: string): string {
  const name = test.split('?')[0];
  const sub = /\.www\./.test(name) ? 'www.' : '';
  if (/\.h2\./.test(name)) return `https://${sub}${HOST}:${H2_PORT}/${test}`;
  if (/\.https\./.test(name)) {
    return `https://${sub}${HOST}:${HTTPS_PORT}/${test}`;
  }
  return `http://${sub}${HOST}:${HTTP_PORT}/${test}`;
}

// What wptrunner's own testharnessreport.js does, by the console: no
// results table in the document, and every subtest as it finishes.
const MARK = '\u0001WPT';
const REPORTER = `(function () {
  function send(o) { console.log(${JSON.stringify(MARK)} + JSON.stringify(o)); }
  function brief(t) {
    return { name: String(t.name), status: t.status, message: t.message == null ? null : String(t.message).slice(0, 300) };
  }
  setup({ output: false });
  add_result_callback(function (t) { send({ kind: 'result', test: brief(t) }); });
  add_completion_callback(function (tests, status) {
    send({ kind: 'done', status: status.status, message: status.message == null ? null : String(status.message).slice(0, 300), tests: tests.map(brief) });
  });
})();`;

// test_driver over the page's fetch: each command is a POST to a path the
// host answers once it has done what it says.
const DRIVER = `(function () {
  var internal = window.test_driver_internal;
  if (!internal) return;
  function post(what, body) {
    return fetch('/__testdriver__/' + what, { method: 'POST', body: JSON.stringify(body || {}) })
      .then(function (r) { return r.text(); })
      .then(function (t) { var o = JSON.parse(t || '{}'); if (o.error) throw new Error(o.error); return o; });
  }
  function centre(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  internal.in_automation = true;
  internal.click = function (el) {
    var c = centre(el);
    return post('actions', { actions: [{ type: 'pointer', actions: [
      { type: 'pointerMove', x: c.x, y: c.y }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
  };
  internal.send_keys = function (el, keys) {
    if (el && el.focus) el.focus();
    var seq = [];
    for (var i = 0; i < keys.length; i++) { seq.push({ type: 'keyDown', value: keys[i] }); seq.push({ type: 'keyUp', value: keys[i] }); }
    return post('actions', { actions: [{ type: 'key', actions: seq }] });
  };
  internal.action_sequence = function (sources) {
    var out = sources.map(function (src) {
      return Object.assign({}, src, { actions: (src.actions || []).map(function (a) {
        var b = Object.assign({}, a);
        if (a.origin && typeof a.origin === 'object' && a.origin.getBoundingClientRect) {
          var c = centre(a.origin); b.x = c.x + (a.x || 0); b.y = c.y + (a.y || 0); b.origin = 'viewport';
        }
        return b;
      }) });
    });
    return post('actions', { actions: out });
  };
  internal.delete_all_cookies = function () { return Promise.resolve(); };
  internal.minimize_window = function () { return Promise.resolve({}); };
  internal.set_window_rect = function () { return Promise.resolve(); };
})();`;

/** A WebDriver key value as an X keysym. */
const SPECIAL_KEYS: Record<string, number> = {
  '': 0xff08, // Backspace
  '': 0xff09, // Tab
  '': 0xff0d, // Return
  '': 0xff0d, // Enter
  '': 0xffe1, // Shift
  '': 0xffe3, // Control
  '': 0xffe9, // Alt
  '': 0xff1b, // Escape
  '': 0x0020, // Space
  '': 0xff55, // PageUp
  '': 0xff56, // PageDown
  '': 0xff57, // End
  '': 0xff50, // Home
  '': 0xff51, // Left
  '': 0xff52, // Up
  '': 0xff53, // Right
  '': 0xff54, // Down
  '': 0xffff, // Delete
  '': 0xffeb, // Meta
};

function keysymOf(value: string): number {
  if (SPECIAL_KEYS[value] !== undefined) return SPECIAL_KEYS[value];
  const code = value.codePointAt(0) ?? 0;
  return code < 0x100 ? code : 0x01000000 + code;
}

interface Subtest {
  name: string;
  status: string;
  message?: string | null;
}

interface Outcome {
  test: string;
  kind: 'testharness' | 'reftest' | 'crashtest';
  status: string;
  message?: string | null;
  subtests?: Subtest[];
  diff?: number;
  ms: number;
  errors?: string[];
}

const HARNESS = ['OK', 'ERROR', 'TIMEOUT', 'PRECONDITION_FAILED'];
const SUBTEST = ['PASS', 'FAIL', 'TIMEOUT', 'NOTRUN', 'PRECONDITION_FAILED'];

/** What the page currently loaded is telling this host. */
interface Current {
  url: string;
  results: Map<string, Subtest>;
  done: { status: string; message: string | null; tests: Subtest[] } | null;
  errors: string[];
  loaded: boolean;
}

let current: Current | null = null;
let handle: HtmlHandle | null = null;
let harness: RenderX11Result | null = null;
/** The document's node, whose parent is the surface it is drawn on. */
let view: { parent?: { focus?(): void } | null } | null = null;

/** Mounted once per document: hands its handle out. */
function Page(props: {
  source: string;
  baseUrl: string;
  charset: string;
  network: HtmlNetwork;
  page: Current;
}): React.ReactElement {
  const handleOf = useHtmlHandle();
  handle = handleOf;
  const { network, page } = props;
  const resources = network.resources(props.baseUrl);
  const onResource = (request: ResourceRequest) => {
    if (request.kind === 'script') {
      const path = request.url.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0];
      if (path === '/resources/testharnessreport.js') {
        return { kind: 'script' as const, bytes: Buffer.from(REPORTER) };
      }
      if (path === '/resources/testdriver-vendor.js') {
        return { kind: 'script' as const, bytes: Buffer.from(DRIVER) };
      }
    }
    return resources(request);
  };
  const fetcher = network.fetcher(props.baseUrl);
  const scripts: HtmlScripts = {
    fetch: (request, signal) => {
      const path = request.url.replace(/^[a-z]+:\/\/[^/]+/i, '');
      if (path.startsWith('/__testdriver__/')) {
        return driver(path.slice('/__testdriver__/'.length), request.body)
          .then((answer) => answer)
          .catch((error) => JSON.stringify({ error: String(error) }))
          .then((body) => ({
            url: request.url,
            status: 200,
            statusText: 'OK',
            redirected: false,
            headers: [['content-type', 'application/json']],
            body,
            type: 'basic' as const,
          }));
      }
      return fetcher(request, signal);
    },
    log: (level, text) => {
      if (process.env.WPT_DEBUG)
        console.error(`[${level}]`, text.slice(0, 500));
      if (page !== current) return;
      if (text.startsWith(MARK)) {
        const report = JSON.parse(text.slice(MARK.length));
        if (report.kind === 'result') {
          const t = report.test;
          page.results.set(t.name, {
            name: t.name,
            status: SUBTEST[t.status] ?? String(t.status),
            message: t.message,
          });
        } else {
          page.done = {
            status: HARNESS[report.status] ?? String(report.status),
            message: report.message,
            tests: report.tests.map((t: Subtest & { status: number }) => ({
              name: t.name,
              status: SUBTEST[t.status] ?? String(t.status),
              message: t.message,
            })),
          };
        }
        return;
      }
      if (level === 'error' && page.errors.length < 8) {
        page.errors.push(text.slice(0, 300));
      }
    },
    timeout: 10000,
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) react-x11-components (wpt runner)',
  };
  const htmlProps: HtmlProps & { ref: React.Ref<unknown> } = {
    ref: (node: unknown) => {
      const ref = handleOf.ref as React.Ref<unknown>;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<unknown>).current = node;
      view = node as typeof view;
    },
    source: props.source,
    charset: props.charset,
    partial: false,
    baseUrl: props.baseUrl,
    fontSize: 16,
    fontFamily: 'serif',
    monoFamily: 'monospace',
    defaultColorScheme: 'light',
    onResource,
    scripts,
    onLoaded: () => {
      page.loaded = true;
      // The window a browser runs a test in has the focus, and its
      // document is the focused area where nothing in it has the focus, so
      // a key a test sends to the document element reaches the page: the
      // document's surface takes it here, where nothing of the page's has
      // it, as a press on the document would give it.
      if (!handleOf.activeElement) view?.parent?.focus?.();
    },
    style: { flexGrow: 1 },
  };
  return h(Html, htmlProps);
}

let serial = 0;

function tree(element: React.ReactElement | null): React.ReactElement {
  return h(
    ThemeProvider,
    { value: PALETTE, colorScheme: 'light' } as Record<string, unknown>,
    h(
      'box',
      {
        style: {
          width: WIDTH,
          height: HEIGHT,
          overflow: 'scroll',
          backgroundColor: '#ffffff',
          flexDirection: 'column',
        },
        scrollbar: false,
      },
      h('box', { style: { flexDirection: 'column', flexGrow: 1 } }, element),
    ),
  );
}

async function show(element: React.ReactElement | null): Promise<void> {
  if (!harness) {
    harness = await renderX11(tree(element), {
      width: WIDTH,
      height: HEIGHT,
      fonts: FONTS,
    });
  } else {
    await harness.rerender(tree(element));
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pump(ms: number): Promise<void> {
  await act();
  await wait(ms);
}

/** Inject a WebDriver action sequence: each tick runs every source's
 *  action at that index, as WebDriver's dispatch does. */
async function driver(what: string, body: string | null): Promise<string> {
  // the first page of a run starts its scripts while the window it is in
  // is still being made, before `show` has its harness
  for (let i = 0; !harness && i < 200; i++) await wait(10);
  const server = harness?.server;
  if (!server) throw new Error('no server');
  if (what !== 'actions') throw new Error(`unsupported: ${what}`);
  const { actions } = JSON.parse(body ?? '{}') as {
    actions: Array<{ type: string; actions: Array<Record<string, unknown>> }>;
  };
  const ticks = Math.max(0, ...actions.map((s) => s.actions.length));
  let px = 0;
  let py = 0;
  for (let tick = 0; tick < ticks; tick++) {
    for (const source of actions) {
      const a = source.actions[tick];
      if (!a) continue;
      const type = a.type as string;
      if (type === 'pause') {
        await wait(Math.min(Number(a.duration ?? 0), 2000));
      } else if (type === 'pointerMove' || type === 'scroll') {
        const x = Number(a.x ?? 0);
        const y = Number(a.y ?? 0);
        if (a.origin === 'pointer') {
          px += x;
          py += y;
        } else {
          px = x;
          py = y;
        }
        server.injectPointerMove(Math.round(px), Math.round(py));
        if (type === 'scroll') {
          const dy = Number(a.deltaY ?? 0);
          const dx = Number(a.deltaX ?? 0);
          const notches = (d: number) =>
            Math.max(1, Math.round(Math.abs(d) / 53));
          for (let i = 0; dy && i < notches(dy); i++) {
            server.injectButton(dy > 0 ? 5 : 4, true);
            server.injectButton(dy > 0 ? 5 : 4, false);
          }
          for (let i = 0; dx && i < notches(dx); i++) {
            server.injectButton(dx > 0 ? 7 : 6, true);
            server.injectButton(dx > 0 ? 7 : 6, false);
          }
        }
      } else if (type === 'pointerDown' || type === 'pointerUp') {
        const button = Number(a.button ?? 0);
        server.injectButton(
          button === 1 ? 2 : button === 2 ? 3 : 1,
          type === 'pointerDown',
        );
      } else if (type === 'keyDown' || type === 'keyUp') {
        const code = server.keymap.keycodeForKeysym(keysymOf(String(a.value)));
        if (code) server.injectKey(code, type === 'keyDown');
      }
    }
    await pump(16);
  }
  await pump(30);
  return '{}';
}

/** A test's references: `<link rel=match|mismatch href>`. */
function referencesOf(
  source: string,
): Array<{ kind: 'match' | 'mismatch'; href: string }> {
  const out: Array<{ kind: 'match' | 'mismatch'; href: string }> = [];
  for (const tag of source.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?(match|mismatch)\b/i.exec(tag);
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (rel && href) {
      out.push({
        kind: rel[1].toLowerCase() as 'match' | 'mismatch',
        href: href[1].trim(),
      });
    }
  }
  return out;
}

/** `<meta name=fuzzy content="maxDifference=a-b;totalPixels=c-d">`, the
 *  upper bounds of both. */
function fuzzyOf(source: string): {
  maxDifference: number;
  totalPixels: number;
} {
  let allowed = { maxDifference: 0, totalPixels: 0 };
  for (const tag of source.match(
    /<meta\b[^>]*name\s*=\s*["']fuzzy["'][^>]*>/gi,
  ) ?? []) {
    let spec = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!spec) continue;
    const named = /^([^:;=]+):(.*)$/.exec(spec);
    if (named && !/=/.test(named[1])) spec = named[2];
    const parts = spec.split(';').map((p) => p.trim());
    const upper = (s: string | undefined) => {
      const m = /(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(s ?? '');
      return m ? Number(m[2] ?? m[1]) : 0;
    };
    const byName = (name: string, index: number) =>
      parts.find((p) => p.startsWith(name + '=')) ?? parts[index];
    allowed = {
      maxDifference: upper(byName('maxDifference', 0)?.replace(/^.*=/, '')),
      totalPixels: upper(byName('totalPixels', 1)?.replace(/^.*=/, '')),
    };
  }
  return allowed;
}

function readViewport(): Promise<Uint8ClampedArray> {
  const ctx = harness!.ctx as {
    getImageData(
      x: number,
      y: number,
      w: number,
      h: number,
      cb: (err: unknown, image: { data: Uint8ClampedArray }) => void,
    ): void;
  };
  return new Promise((ok, fail) =>
    ctx.getImageData(0, 0, WIDTH, HEIGHT, (err, image) =>
      err ? fail(err) : ok(image.data),
    ),
  );
}

function sameBytes(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Whether the root still says `reftest-wait` or `test-wait`. */
function stillWaiting(): boolean {
  const doc = handle?.document as {
    children: Array<{
      type: string;
      name?: string;
      attribs?: Record<string, string>;
    }>;
  } | null;
  const root = doc?.children.find((c) => c.type === 'tag' && c.name === 'html');
  return /\b(reftest|test)-wait\b/.test(root?.attribs?.class ?? '');
}

/** Load a document, run it until it has loaded and stopped waiting, and
 *  read the viewport once two reads agree. */
async function render(
  url: string,
  budgetMs: number,
): Promise<{
  page: Current;
  pixels: Uint8ClampedArray | null;
  source: string;
  error?: string;
}> {
  const network = new HtmlNetwork({ connectTimeout: 2500 });
  const page: Current = {
    url,
    results: new Map(),
    done: null,
    errors: [],
    loaded: false,
  };
  current = page;
  let doc;
  try {
    doc = await network.html(url);
  } catch (error) {
    return { page, pixels: null, source: '', error: String(error) };
  }
  await show(
    h(Page, {
      key: `${serial++}`,
      source: doc.source,
      baseUrl: doc.url,
      charset: doc.charset,
      network,
      page,
    }),
  );
  const deadline = performance.now() + budgetMs;
  while ((!page.loaded || stillWaiting()) && performance.now() < deadline) {
    await pump(10);
  }
  if (!page.loaded || stillWaiting()) {
    return { page, pixels: null, source: doc.source, error: 'TIMEOUT' };
  }
  // wptrunner waits two animation frames once the document is ready for
  // its screenshot (`reftest-wait_webdriver.js`), and a test that resizes
  // something in a `requestAnimationFrame` without `reftest-wait` counts
  // on them
  for (let i = 0; i < 4; i++) await pump(12);
  let last = await readViewport();
  for (let i = 0; i < 8; i++) {
    await pump(i < 2 ? 8 : 30);
    const next = await readViewport();
    if (sameBytes(last, next))
      return { page, pixels: next, source: doc.source };
    last = next;
  }
  return { page, pixels: last, source: doc.source };
}

async function runReftest(test: string, source: string): Promise<Outcome> {
  const started = performance.now();
  const url = urlFor(test);
  const ref = referencesOf(source)[0];
  const ms = () => Math.round(performance.now() - started);
  const shot = await render(url, 10000);
  if (!shot.pixels) {
    return {
      test,
      kind: 'reftest',
      status: shot.error === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR',
      message: shot.error,
      ms: ms(),
    };
  }
  const refShot = await render(new URL(ref.href, url).href, 10000);
  if (!refShot.pixels) {
    return {
      test,
      kind: 'reftest',
      status: 'ERROR',
      message: `reference: ${refShot.error}`,
      ms: ms(),
    };
  }
  const allowed = fuzzyOf(source);
  let diff = 0;
  let maxDiff = 0;
  const a = shot.pixels;
  const b = refShot.pixels;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(
      Math.abs(a[i] - b[i]),
      Math.abs(a[i + 1] - b[i + 1]),
      Math.abs(a[i + 2] - b[i + 2]),
    );
    if (d > 0) {
      diff++;
      if (d > maxDiff) maxDiff = d;
    }
  }
  if (process.env.WPT_SHOTS) shots(test, a, b);
  const same =
    diff === 0 ||
    (maxDiff <= allowed.maxDifference && diff <= allowed.totalPixels);
  const pass = ref.kind === 'match' ? same : !same;
  return {
    test,
    kind: 'reftest',
    status: pass ? 'PASS' : 'FAIL',
    diff,
    ms: ms(),
    errors: shot.page.errors.length ? shot.page.errors : undefined,
  };
}

/** `WPT_SHOTS=<dir>`: the test and its reference side by side, as a PNG. */
function shots(test: string, a: Uint8ClampedArray, b: Uint8ClampedArray) {
  const png = new PNG({ width: WIDTH * 2, height: HEIGHT });
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      for (const [image, dx] of [
        [a, 0],
        [b, WIDTH],
      ] as const) {
        const from = (y * WIDTH + x) * 4;
        const to = (y * WIDTH * 2 + x + dx) * 4;
        // the context reads back BGRA
        png.data[to] = image[from + 2];
        png.data[to + 1] = image[from + 1];
        png.data[to + 2] = image[from];
        png.data[to + 3] = 255;
      }
    }
  }
  writeFileSync(
    join(process.env.WPT_SHOTS!, test.replace(/[/?]/g, '__') + '.png'),
    PNG.sync.write(png),
  );
}

async function runTestharness(test: string, source: string): Promise<Outcome> {
  const started = performance.now();
  const long = /<meta\s+name=["']?timeout["']?\s+content=["']?long/i.test(
    source,
  );
  const budget = (long ? 60000 : 10000) + 6000;
  const network = new HtmlNetwork({ connectTimeout: 2500 });
  const url = urlFor(test);
  const page: Current = {
    url,
    results: new Map(),
    done: null,
    errors: [],
    loaded: false,
  };
  current = page;
  let doc;
  try {
    doc = await network.html(url);
  } catch (error) {
    return {
      test,
      kind: 'testharness',
      status: 'ERROR',
      message: String(error),
      ms: 0,
    };
  }
  await show(
    h(Page, {
      key: `${serial++}`,
      source: doc.source,
      baseUrl: doc.url,
      charset: doc.charset,
      network,
      page,
    }),
  );
  const deadline = performance.now() + budget;
  while (!page.done && performance.now() < deadline) await pump(10);
  const ms = Math.round(performance.now() - started);
  if (page.done) {
    return {
      test,
      kind: 'testharness',
      status: page.done.status,
      message: page.done.message,
      subtests: page.done.tests,
      ms,
      errors: page.errors.length ? page.errors : undefined,
    };
  }
  // The harness never finished: the subtests it did report, and one more
  // for what it never got to, as a harness timeout scores in wpt.fyi.
  return {
    test,
    kind: 'testharness',
    status: 'TIMEOUT',
    message: page.loaded ? 'harness did not complete' : 'document did not load',
    subtests: [
      ...page.results.values(),
      { name: '(harness timeout)', status: 'TIMEOUT' },
    ],
    ms,
    errors: page.errors.length ? page.errors : undefined,
  };
}

async function runCrashtest(test: string): Promise<Outcome> {
  const started = performance.now();
  const shot = await render(urlFor(test), 10000);
  return {
    test,
    kind: 'crashtest',
    status: shot.pixels
      ? 'PASS'
      : shot.error === 'TIMEOUT'
        ? 'TIMEOUT'
        : 'ERROR',
    message: shot.error,
    ms: Math.round(performance.now() - started),
  };
}

process.on('uncaughtException', (error) => {
  console.error('uncaught', error);
  process.exit(3);
});

const tests = readFileSync(listFile, 'utf8').split('\n').filter(Boolean);
for (const test of tests) {
  let outcome: Outcome;
  try {
    const head = await new HtmlNetwork().html(urlFor(test));
    const source = head.source;
    if (referencesOf(source).length) outcome = await runReftest(test, source);
    else if (/testharness\.js/.test(source)) {
      outcome = await runTestharness(test, source);
    } else outcome = await runCrashtest(test);
  } catch (error) {
    outcome = {
      test,
      kind: 'testharness',
      status: 'ERROR',
      message: String((error as Error)?.stack ?? error).slice(0, 400),
      ms: 0,
    };
  }
  appendFileSync(outFile, JSON.stringify(outcome) + '\n');
}
await show(null);
process.exit(0);
