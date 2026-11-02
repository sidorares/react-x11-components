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
//   `set_permission` for a camera, a microphone or a display sets what the
//   test's fake devices answer.
// - **Media devices are fake**, as wptrunner runs a browser with fake
//   devices: a camera drawing a test pattern, a microphone playing a tone
//   and a screen, all allowed (`fakeMediaDevices`), a fresh set a test.
// - **A test's own navigations** — `location`, `navigation.navigate()`,
//   `history` past its document's entries, `reload()` — load into the place
//   the test was shown, each document the next of one session history a
//   test (`HtmlSessionHistory`), as a browser's tab holds them. A frame's
//   are the engine's, and a link or a form activated in the test's window
//   goes nowhere, as before: a test that left its own window would end its
//   harness, and a script's `a.click()` in a frame's document reaches
//   `onLink` with no point to tell it by.
// - **A window the test opens is a window** (`Tab`): `window.open`, and
//   anything else a page sends to a new tab, loads its address in a top-level
//   `<Html scripts>` of its own, with its own session history, laid out
//   beside the test's window where nothing is drawn. Its navigations are its
//   own, as the test's are; it has no opener — the test's `window.open`
//   answers null, as one with `noopener` does — and what its harness reports
//   is not the test's. WPT's remote contexts (`/common/dispatcher/`) open
//   their pages so.
//
// The server's hosts are `web-platform.test` and its subdomains, which this
// process resolves to the loopback itself, so nothing on the machine has to
// change; `interop.ts` hands Node WPT's CA for the https ones.
import dns from 'node:dns';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ThemeProvider } from 'react-x11';
import { act, renderX11 } from 'react-x11/test';
import type { RenderX11Result } from 'react-x11/test';

import {
  Html,
  HtmlNetwork,
  HtmlSessionHistory,
  fakeMediaDevices,
  memoryClipboard,
  useHtmlHandle,
} from '../../src/html/index.js';
import type {
  FakeMediaDevices,
  HtmlClipboard,
  HtmlHandle,
  HtmlPermissionState,
  HtmlProps,
  HtmlScripts,
  ResourceRequest,
} from '../../src/html/index.js';

const h = React.createElement;

const WIDTH = 800;
const HEIGHT = 600;
const HOST = 'web-platform.test';
// the ports `./wpt serve` listens on: its defaults, or what its
// `config.json` moved them to where another server holds those
const HTTP_PORT = Number(process.env.WPT_HTTP_PORT || 8000);
const HTTPS_PORT = Number(process.env.WPT_HTTPS_PORT || 8443);
const H2_PORT = Number(process.env.WPT_H2_PORT || 9000);

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

// The generic families as files: Liberation where it is installed, and on a
// Mac the faces it is metric-compatible with.
const LIBERATION = '/usr/share/fonts/truetype/liberation';
const MAC = '/System/Library/Fonts/Supplemental';
const FONTS: Record<string, string> = existsSync(LIBERATION)
  ? {
      serif: `${LIBERATION}/LiberationSerif-Regular.ttf`,
      'sans-serif': `${LIBERATION}/LiberationSans-Regular.ttf`,
      monospace: `${LIBERATION}/LiberationMono-Regular.ttf`,
    }
  : {
      serif: `${MAC}/Times New Roman.ttf`,
      'sans-serif': `${MAC}/Arial.ttf`,
      monospace: `${MAC}/Courier New.ttf`,
    };

const PALETTE = {
  text: '#000000',
  accent: '#0000ee',
  background: '#ffffff',
  surface: '#ffffff',
  border: '#808080',
  textMuted: '#000000',
};

/** The address wpt.fyi runs a test at: https for `.https.` and `.h2.`, and
 *  for a service worker's variant, which WPT's manifest forces onto https
 *  (`force_https`); a subdomain for `.www.`. */
export function urlFor(test: string): string {
  const name = test.split('?')[0];
  const sub = /\.www\./.test(name) ? 'www.' : '';
  if (/\.h2\./.test(name)) return `https://${sub}${HOST}:${H2_PORT}/${test}`;
  if (/\.https\.|\.serviceworker(?:-module)?\.html$/.test(name)) {
    return `https://${sub}${HOST}:${HTTPS_PORT}/${test}`;
  }
  return `http://${sub}${HOST}:${HTTP_PORT}/${test}`;
}

// What wptrunner's own testharnessreport.js does, by the console: no
// results table in the document, and every subtest as it finishes.
const MARK = '\u0001WPT';
const REPORTER = `(function () {
  function send(o) { console.log(${JSON.stringify(MARK)} + JSON.stringify(o)); }
  // a message's end is where check-layout-th.js says what it found
  function cut(m) {
    m = String(m);
    return m.length > 300 ? m.slice(0, 120) + ' … ' + m.slice(-180) : m;
  }
  function brief(t) {
    return { name: String(t.name), status: t.status, message: t.message == null ? null : cut(t.message) };
  }
  setup({ output: false });
  add_result_callback(function (t) { send({ kind: 'result', test: brief(t) }); });
  add_completion_callback(function (tests, status) {
    send({ kind: 'done', status: status.status, message: status.message == null ? null : cut(status.message), tests: tests.map(brief) });
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
  internal.set_permission = function (params) {
    return post('permission', { name: params.descriptor && params.descriptor.name, state: params.state }).then(function () {});
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
  /** Its devices, which `set_permission` changes. */
  media: FakeMediaDevices;
  /** What it may do, which `set_permission` changes: whatever it has not
   *  been given is `prompt`, and asking grants it, as a test run with
   *  nobody at the screen takes a browser's prompt as answered. */
  permissions: Record<string, HtmlPermissionState>;
  /** The clipboard its page reaches, a fresh one for each test. */
  clipboard: HtmlClipboard;
}

let current: Current | null = null;
let handle: HtmlHandle | null = null;
let harness: RenderX11Result | null = null;
/** The document's node, whose parent is the surface it is drawn on. */
let view: { parent?: { focus?(): void } | null } | null = null;

/** A document of a test's, as it was loaded. */
interface Loaded {
  source: string;
  baseUrl: string;
  charset: string;
}

/**
 * A test's windows: the one it runs in, and those it opens, each a `Tab`.
 * Mounted once per test, so that what a test opened goes with it.
 */
function Run(props: {
  first: Loaded;
  network: HtmlNetwork;
  page: Current;
}): React.ReactElement {
  const [opened, setOpened] = useState<{ id: number; url: string }[]>([]);
  const open = (url: string) => {
    if (props.page !== current) return;
    setOpened((all) => [...all, { id: all.length + 1, url }]);
  };
  const tab = (main: boolean, first: Loaded | string) =>
    h(Tab, { first, network: props.network, page: props.page, main, open });
  return h(
    'box',
    { style: { flexDirection: 'column', flexGrow: 1 } },
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
      h(
        'box',
        { style: { flexDirection: 'column', flexGrow: 1 } },
        tab(true, props.first),
      ),
    ),
    // beside the test's window, where nothing is drawn: a window of its
    // own size, which its documents are laid out in
    ...opened.map(({ id, url }) =>
      h(
        'box',
        {
          key: id,
          style: {
            position: 'absolute',
            left: WIDTH * id,
            top: 0,
            width: WIDTH,
            height: HEIGHT,
            overflow: 'scroll',
            backgroundColor: '#ffffff',
            flexDirection: 'column',
          },
          scrollbar: false,
        },
        h(
          'box',
          { style: { flexDirection: 'column', flexGrow: 1 } },
          tab(false, url),
        ),
      ),
    ),
  );
}

/** How many documents a window keeps to show again as they were left
 *  (`backForwardCache`): as many as Chrome keeps on the desktop. */
const BFCACHE = 6;

/** A document a window shows or keeps: what it was loaded from, and its
 *  number in the window's session (`HtmlSessionEntry.document`) where that
 *  is known. */
interface WindowDoc {
  n: number;
  doc: Loaded;
  number?: number;
}

/**
 * What a window shows once its session changed: the document shown came
 * into the session under a number of its own, once its `<Html>` is in (as
 * its scripts start); a step to a document the session keeps shows that
 * one again; and a document neither shown, current nor kept goes. One on
 * its way in stays shown, and the one it will take the place of stays
 * mounted until it is in, so that it is told where it goes — and kept,
 * where it may be — as it goes.
 */
function follow(
  win: { docs: WindowDoc[]; shown: number },
  session: HtmlSessionHistory,
  mounted: ReadonlySet<number>,
): { docs: WindowDoc[]; shown: number } {
  const entry = session.current;
  if (!entry) return win;
  let docs = win.docs;
  const arriving = (d: WindowDoc) =>
    !mounted.has(d.n) || d.number === undefined;
  // the current entry's document, where none has its number, is the one
  // in last that has none
  if (!docs.some((d) => d.number === entry.document)) {
    const fresh = [...docs]
      .reverse()
      .find((d) => d.number === undefined && mounted.has(d.n));
    if (fresh) {
      docs = docs.map((d) =>
        d === fresh ? { ...d, number: entry.document } : d,
      );
    }
  }
  const newest = (number: number | undefined) =>
    [...docs].reverse().find((d) => d.number === number && mounted.has(d.n))?.n;
  const shownDoc = docs.find((d) => d.n === win.shown);
  const showing =
    shownDoc && arriving(shownDoc)
      ? win.shown
      : (newest(entry.document) ?? win.shown);
  const kept = new Set(session.kept);
  docs = docs.filter(
    (d) =>
      d.n === showing ||
      arriving(d) ||
      ((d.number === entry.document || kept.has(d.number!)) &&
        d.n === newest(d.number)),
  );
  const same =
    docs.length === win.docs.length && docs.every((d, i) => d === win.docs[i]);
  return same && showing === win.shown
    ? win
    : { docs: same ? win.docs : docs, shown: showing };
}

/**
 * A top-level window, as a browser's tab is: shows its first document — the
 * test's, or the address a window was opened at — and then whatever its
 * scripts navigate it to, each the next of one session history
 * (`HtmlSessionHistory`), in an `<Html>` of its own. A document left that
 * the session keeps to show again (its back-forward cache) stays mounted,
 * hidden and frozen, and a step back or forward to it shows it again. The
 * test's window hands its handle out and reads what the test's harness
 * reports; a window the test opened (`main` false) does neither.
 */
function Tab(props: {
  first: Loaded | string;
  network: HtmlNetwork;
  page: Current;
  main: boolean;
  open: (url: string) => void;
}): React.ReactElement | null {
  const handleOf = useHtmlHandle();
  const { network, page, main } = props;
  if (main) handle = handleOf;
  const [session] = useState(
    () => new HtmlSessionHistory(undefined, { backForwardCache: BFCACHE }),
  );
  const [win, setWin] = useState<{ docs: WindowDoc[]; shown: number }>({
    docs: typeof props.first === 'string' ? [] : [{ n: 0, doc: props.first }],
    shown: 0,
  });
  const { docs, shown } = win;
  // the documents whose `<Html>` is in, whose scripts have started
  const mounted = useRef(new Set<number>());
  useLayoutEffect(() => {
    mounted.current = new Set(docs.map((d) => d.n));
  });
  const seq = useRef(0);
  /** The window's next document, loaded from `url`: `number` is the one
   *  the session will know it by where that is known before it arrives —
   *  a reload's, the current entry's; a step's, its entry's. */
  const load = (url: string, number?: number) => {
    void network
      .html(url)
      .then((doc) => {
        if (page !== current) return;
        // at the fragment it was asked for, which a fetch's answer drops
        const hash = url.indexOf('#');
        const at =
          doc.url.includes('#') || hash < 0
            ? doc.url
            : doc.url + url.slice(hash);
        const n = ++seq.current;
        setWin((w) => ({
          docs: [
            ...w.docs,
            {
              n,
              doc: { source: doc.source, baseUrl: at, charset: doc.charset },
              number,
            },
          ],
          shown: n,
        }));
      })
      .catch((error) => {
        if (page === current && page.errors.length < 8) {
          page.errors.push(`navigation to ${url}: ${String(error)}`);
        }
      });
  };
  // a window opened at an address loads it as it opens
  const opening = useRef(typeof props.first === 'string' ? props.first : null);
  useEffect(() => {
    if (opening.current) load(opening.current);
    opening.current = null;
  }, []);
  useEffect(() => {
    // the first document came in before this listened
    setWin((w) => follow(w, session, mounted.current));
    return session.onChange(() =>
      setWin((w) => follow(w, session, mounted.current)),
    );
  }, []);
  if (!docs.length) return null;
  const html = ({ n, doc }: WindowDoc): React.ReactElement => {
    const visible = n === shown;
    const resources = network.resources(doc.baseUrl);
    const onResource = (request: ResourceRequest) => {
      if (request.kind === 'script') {
        const path = request.url
          .replace(/^[a-z]+:\/\/[^/]+/i, '')
          .split('?')[0];
        if (path === '/resources/testharnessreport.js') {
          return { kind: 'script' as const, bytes: Buffer.from(REPORTER) };
        }
        if (path === '/resources/testdriver-vendor.js') {
          return { kind: 'script' as const, bytes: Buffer.from(DRIVER) };
        }
      }
      return resources(request);
    };
    const fetcher = network.fetcher(doc.baseUrl);
    const scripts: HtmlScripts = {
      // WPT's `.any.serviceworker.html` variants register their tests' worker
      serviceWorkers: true,
      session,
      navigate: (url, how) => {
        // a window of its own, beside this one
        if (how === 'tab') {
          props.open(url);
          return;
        }
        // a fragment the document went to itself, which its engine wrote
        if (url.includes('#') && session.current?.url === url) return;
        load(url);
      },
      reload: () => {
        const entry = session.current;
        load(entry?.url ?? doc.baseUrl, entry?.document);
      },
      // a step to an entry of a document the window keeps shows it again
      // as the session tells of it; to another document's, loads it
      go: (delta) => {
        const to = session.go(delta);
        if (to) load(to.url, to.document);
      },
      // WPT's WebTransport server, `./wpt serve --webtransport-h3`, over quico
      webTransport: network.webTransport,
      // two peers in one page, over werift
      webRTC: network.webRTC,
      mediaDevices: page.media,
      clipboard: page.clipboard,
      permissions: {
        state: (name) => page.permissions[name] ?? 'prompt',
        request: (name) => {
          page.permissions[name] ??= 'granted';
          return Promise.resolve(page.permissions[name]);
        },
      },
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
        if (process.env.WPT_DEBUG) {
          console.error(
            main ? `[${level}]` : `[window ${level}]`,
            text.slice(0, 500),
          );
        }
        if (page !== current) return;
        // a harness in a window the test opened is that window's
        if (!main && text.startsWith(MARK)) return;
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
    const htmlProps: HtmlProps & { ref?: React.Ref<unknown>; key: number } = {
      // the handle is the document shown's
      ...(visible && {
        ref: (node: unknown) => {
          const ref = handleOf.ref as React.Ref<unknown>;
          if (typeof ref === 'function') ref(node);
          else if (ref) (ref as React.MutableRefObject<unknown>).current = node;
          if (main) view = node as typeof view;
        },
      }),
      key: n,
      source: doc.source,
      charset: doc.charset,
      partial: false,
      baseUrl: doc.baseUrl,
      onResource,
      scripts,
      onLoaded: () => {
        if (!main) return;
        page.loaded = true;
        // The window a browser runs a test in has the focus, and its
        // document is the focused area where nothing in it has the focus,
        // so a key a test sends to the document element reaches the page:
        // the document's surface takes it here, where nothing of the
        // page's has it, as a press on the document would give it.
        if (!handleOf.activeElement) view?.parent?.focus?.();
      },
      // one kept to show again is laid out nowhere
      style: visible ? { flexGrow: 1 } : { display: 'none' },
    };
    return h(Html, htmlProps);
  };
  return h(React.Fragment, null, ...docs.map(html));
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
          backgroundColor: '#ffffff',
          flexDirection: 'column',
        },
      },
      element,
    ),
  );
}

/** The `act()` running now. A `test_driver` action pumps while the page's
 *  own loop does, and a page is shown while it pumps; two `act()` scopes
 *  that overlap restore React's scope depth out of order, so it stays
 *  above zero for the rest of the process, every later update waits in
 *  the act queue, and a later page times out or loops ("Maximum update
 *  depth exceeded"). So each waits for the one before. */
let acting: Promise<unknown> = Promise.resolve();

function inTurn<T>(run: () => Promise<T>): Promise<T> {
  const turn = acting.then(run);
  acting = turn.catch(() => {});
  return turn;
}

async function show(element: React.ReactElement | null): Promise<void> {
  if (!harness) {
    harness = await renderX11(tree(element), {
      width: WIDTH,
      height: HEIGHT,
      fonts: FONTS,
    });
  } else {
    const rendered = harness;
    await inTurn(() => rendered.rerender(tree(element)));
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pump(ms: number): Promise<void> {
  await inTurn(() => act());
  await wait(ms);
}

/** Inject a WebDriver action sequence: each tick runs every source's
 *  action at that index, as WebDriver's dispatch does. */
/** The devices a permission name sets what is answered for. */
const MEDIA_PERMISSIONS: Record<string, 'camera' | 'microphone' | 'display'> = {
  camera: 'camera',
  microphone: 'microphone',
  'display-capture': 'display',
};

async function driver(what: string, body: string | null): Promise<string> {
  if (what === 'permission') {
    const { name, state } = JSON.parse(body ?? '{}') as {
      name?: string;
      state?: string;
    };
    const kind = MEDIA_PERMISSIONS[name ?? ''];
    if (
      !name ||
      !current ||
      (state !== 'granted' && state !== 'denied' && state !== 'prompt')
    ) {
      // what test_driver says where its vendor script has none
      throw new Error(
        'set_permission() is not implemented by testdriver-vendor.js',
      );
    }
    if (kind) current.media.setPermission(kind, state);
    current.permissions[name] = state;
    return '{}';
  }
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
  // the name's quotes are optional, as an attribute's are
  for (const tag of source.match(
    /<meta\b[^>]*name\s*=\s*(?:"fuzzy"|'fuzzy'|fuzzy(?=[\s/>]))[^>]*>/gi,
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

/**
 * A `reftest-wait` document with what wptrunner runs in it once it has
 * loaded (`test-wait.js`): two frames, then `TestRendered` at the root,
 * which a test that waits for its first rendering listens for. Appended as
 * a script that takes itself out as it runs, since the runner has no
 * other way into the page.
 */
function withTestRendered(source: string): string {
  if (!/\bclass\s*=\s*["']?[^"'>]*\breftest-wait\b/i.test(source))
    return source;
  const script =
    '<script>(function(){var s=document.currentScript;if(s)s.remove();' +
    'function go(){var r=document.documentElement;' +
    'if(!/\\breftest-wait\\b/.test(r.className))return;' +
    'requestAnimationFrame(function(){requestAnimationFrame(function(){' +
    "r.dispatchEvent(new Event('TestRendered'));});});}" +
    "if(document.readyState==='complete')setTimeout(go,0);" +
    "else addEventListener('load',function(){setTimeout(go,0);},{once:true});" +
    '})();</script>';
  return source + script;
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
    media: fakeMediaDevices(),
    permissions: {},
    clipboard: memoryClipboard(),
  };
  current = page;
  let doc;
  try {
    doc = await network.html(url);
  } catch (error) {
    return { page, pixels: null, source: '', error: String(error) };
  }
  await show(
    h(Run, {
      key: `${serial++}`,
      first: {
        source: withTestRendered(doc.source),
        baseUrl: doc.url,
        charset: doc.charset,
      },
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
    media: fakeMediaDevices(),
    permissions: {},
    clipboard: memoryClipboard(),
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
    h(Run, {
      key: `${serial++}`,
      first: { source: doc.source, baseUrl: doc.url, charset: doc.charset },
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
