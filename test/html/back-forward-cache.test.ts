// A session's back-forward cache (`HtmlSessionOptions.backForwardCache`,
// `src/html/scripts/session.ts`): a document left is kept, frozen, and a step
// back or forward to it shows it again as it was — its scripts' state, its
// DOM — told `pageshow` with `persisted` true, where without the cache it
// would unload and load again. These run a tab as a host that keeps one
// does: an `<Html>` a document, the documents the session keeps mounted and
// hidden, and the one the current entry is of shown.
import { afterEach, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { act, cleanup, renderX11 } from 'react-x11/test';

import {
  Html,
  HtmlSessionHistory,
  useHtmlHandle,
} from '../../src/html/index.js';
import { preloadHtmlScripts, useScripts } from '../../src/html/scripts/hook.js';
import type { ScriptRunner } from '../../src/html/scripts/runner.js';
import type { ScriptsOptions } from '../../src/html/scripts/runner.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import type { HtmlWebTransport } from '../../src/html/transport.js';
import type { HtmlWebSocket } from '../../src/html/socket.js';
import { FakeTransport } from '../fake-transport.js';
import { FakeSockets } from '../fake-socket.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);

await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const SITE = 'https://example.test/';

interface Tab {
  session: HtmlSessionHistory;
  /** What the pages wrote to their consoles, in order. */
  logs: string[];
  /** The `<Html>`s mounted now, by the address each shows. */
  mounted(): string[];
  /** Run a script in the document shown, as a task of its own. */
  run(code: string): void;
  runner(): ScriptRunner | null;
  /** The runner of the document mounted at an address, shown or kept. */
  runnerAt(url: string): ScriptRunner | null;
}

interface Doc {
  n: number;
  url: string;
  /** Its number in the session, where that is known. */
  number?: number;
}

/**
 * A tab with a back-forward cache of `cache` documents: each document an
 * `<Html>` of its own, loaded from `pages` by its file; the next whenever a
 * page navigates, the same address again for a reload — under the current
 * entry's number — and the entry `session.go` answers for a step to a
 * document the session does not keep. A document the session keeps stays
 * mounted, `display: none`; one it lets go is unmounted.
 */
async function tab(
  pages: Record<string, string>,
  first: string,
  cache: number,
  webTransport?: HtmlWebTransport,
  webSocket?: HtmlWebSocket,
): Promise<Tab> {
  const session = new HtmlSessionHistory(undefined, {
    backForwardCache: cache,
  });
  const out = { session, logs: [] } as unknown as Tab;
  const runners = new Map<number, () => ScriptRunner | null>();
  let shownNow = 0;
  let load: (url: string, number?: number) => void = () => {};

  function Page(props: { doc: Doc; visible: boolean }) {
    const { doc } = props;
    const handle = useHtmlHandle();
    const seams: ScriptsOptions = {
      userAgent: 'test',
      language: 'en-US',
      viewport: () => ({
        width: 400,
        height: 300,
        scrollX: 0,
        scrollY: 0,
        zoom: 1,
        dpr: 1,
        left: 0,
        top: 0,
      }),
      scrollTo: () => {},
      navigate: (url, how) => {
        if (how !== 'tab') load(url);
      },
      reload: () => {
        const entry = session.current;
        load(entry?.url ?? doc.url, entry?.document);
      },
      go: (delta) => {
        const to = session.go(delta);
        if (to) load(to.url, to.document);
      },
      log: (_level, text) => void out.logs.push(text),
      title: () => {},
      fetch: async () => {
        throw new Error('no network');
      },
      load: async () => null,
      onTimeout: () => {},
      session,
      ...(webTransport && { webTransport }),
      ...(webSocket && { webSocket }),
    };
    const scripts = useScripts(true, handle, doc.url, seams);
    runners.set(doc.n, () => scripts.runner?.() ?? null);
    useEffect(() => () => void runners.delete(doc.n), []);
    const file = new URL(doc.url).pathname.slice(1);
    return h(Html, {
      source: `${pages[file] ?? '<p>missing</p>'}<!--${doc.n}-->`,
      partial: false,
      ref: handle.ref,
      baseUrl: doc.url,
      style: props.visible ? { flexGrow: 1 } : { display: 'none' },
      ...scripts,
    });
  }

  function Shown() {
    const [win, setWin] = useState<{ docs: Doc[]; shown: number }>({
      docs: [{ n: 0, url: first }],
      shown: 0,
    });
    const { docs, shown } = win;
    shownNow = shown;
    const mounted = useRef(new Set<number>());
    useLayoutEffect(() => {
      mounted.current = new Set(docs.map((d) => d.n));
    });
    const seq = useRef(0);
    load = (url, number) => {
      const n = ++seq.current;
      setWin((w) => ({ docs: [...w.docs, { n, url, number }], shown: n }));
    };
    const now = useRef(docs);
    now.current = docs;
    out.mounted = () => now.current.map((d) => d.url);
    // as the runner's `Tab` follows its session
    useEffect(() => {
      // the first document came in before this listened
      setWin((w) => follow(w, session, mounted.current));
      return session.onChange(() =>
        setWin((w) => follow(w, session, mounted.current)),
      );
    }, []);
    return h(
      'box',
      { style: { width: 400, height: 300, flexDirection: 'column' } },
      ...docs.map((doc) =>
        h(Page, { key: doc.n, doc, visible: doc.n === shown }),
      ),
    );
  }

  out.runner = () => runners.get(shownNow)?.() ?? null;
  out.runnerAt = (url) => {
    for (const get of runners.values()) {
      const runner = get();
      if (runner?.host.url === url) return runner;
    }
    return null;
  };
  out.run = (code) => out.runner()?.engine.exec(code, 'test', 0);
  await renderX11(
    h(Shown),
    FONTS ? { width: 440, height: 400, fonts: FONTS } : { backend: 'mock' },
  );
  await settle();
  return out;
}

/**
 * What a tab shows once its session changed, as the runner's `follow`
 * has it: the document shown came
 * into the session under a number of its own, once its `<Html>` is in (as
 * its scripts start); a step to a document the session keeps shows that
 * one again; and a document neither shown, current nor kept goes. One on
 * its way in stays shown, and the one it will take the place of stays
 * mounted until it is in, so that it is told where it goes — and kept,
 * where it may be — as it goes.
 */
function follow(
  win: { docs: Doc[]; shown: number },
  session: HtmlSessionHistory,
  mounted: ReadonlySet<number>,
): { docs: Doc[]; shown: number } {
  const entry = session.current;
  if (!entry) return win;
  let docs = win.docs;
  const arriving = (d: Doc) => !mounted.has(d.n) || d.number === undefined;
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

/** Let the pages' turns run: timers at no delay, frames, and the render
 *  after. */
async function settle(ms = 40) {
  for (let i = 0; i < 4; i += 1) {
    await act(() => new Promise((r) => setTimeout(r, ms / 4)));
  }
}

/** Wait until a line has been logged `times` times, and every line logged
 *  by then. */
async function until(
  doc: Tab,
  line: string,
  times = 1,
  ms = 3000,
): Promise<string[]> {
  const count = () => doc.logs.filter((l) => l === line).length;
  const end = Date.now() + ms;
  while (count() < times && Date.now() < end) await settle(20);
  assert.ok(
    count() >= times,
    `no "${line}" ${times}× in:\n${doc.logs.join('\n')}`,
  );
  return doc.logs;
}

/** A page that says what becomes of it: its loads, its page lifecycle, its
 *  visibility and its unload, each line starting with its name. */
function page(name: string, extra = ''): string {
  return (
    '<script>' +
    `var say = function (s) { console.log("${name} " + s); };` +
    'window.mark = (window.mark || 0) + 1;' +
    'say("loaded");' +
    'addEventListener("pageshow", function (e) { say("pageshow " + e.persisted + " " + window.mark); });' +
    'addEventListener("pagehide", function (e) { say("pagehide " + e.persisted); });' +
    'document.addEventListener("visibilitychange", function () { say("visibility " + document.visibilityState); });' +
    extra +
    '</script>'
  );
}

test('a document left is kept, and a step back shows it again as it was, told pageshow with persisted true, and never unloads, though it listens for it', async () => {
  const doc = await tab(
    {
      'a.html': page(
        'a',
        'addEventListener("unload", function () { say("unload"); });',
      ),
      'b.html': page('b'),
    },
    `${SITE}a.html`,
    3,
  );
  await until(doc, 'a pageshow false 1');
  doc.run('window.mark = 41; location.href = "b.html";');
  await until(doc, 'b pageshow false 1');
  // the first document went into the cache, hidden and kept mounted
  assert.deepEqual(doc.session.kept, [doc.session.entries[0].document]);
  assert.deepEqual(doc.mounted(), [`${SITE}a.html`, `${SITE}b.html`]);
  doc.run('history.back();');
  const logs = await until(doc, 'a pageshow true 41');
  assert.deepEqual(
    logs.filter((l) => l.startsWith('a ')),
    [
      'a loaded',
      'a pageshow false 1',
      'a pagehide true',
      'a visibility hidden',
      'a visibility visible',
      'a pageshow true 41',
    ],
  );
  // the one it left is kept in its turn, and nothing unloaded
  assert.equal(doc.session.index, 0);
  assert.deepEqual(doc.session.kept, [doc.session.entries[1].document]);
  assert.ok(logs.includes('b pagehide true'), logs.join('\n'));
  // and forward again by the host's own step
  assert.equal(doc.session.go(1), null);
  await until(doc, 'b pageshow true 1');
  assert.equal(logs.filter((l) => l.endsWith(' loaded')).length, 2);
});

test('what a kept document plays is paused, in its tree and out of it, and told so as it is shown again', async () => {
  const doc = await tab(
    {
      'a.html': page(
        'a',
        'window.inTree = document.createElement("audio");' +
          'document.documentElement.appendChild(inTree);' +
          'window.outOfTree = new Audio();' +
          'inTree.play(); outOfTree.play();' +
          'addEventListener("pageshow", function (e) {' +
          '  say("playing " + !inTree.paused + " " + !outOfTree.paused); });',
      ),
      'b.html': page('b'),
    },
    `${SITE}a.html`,
    3,
  );
  await until(doc, 'a playing true true');
  doc.run('location.href = "b.html";');
  await until(doc, 'b pageshow false 1');
  doc.run('history.back();');
  await until(doc, 'a pageshow true 1');
  await until(doc, 'a playing false false');
});

test('a kept document runs nothing: its timers wait, and an interval owed while it was kept runs once, after pageshow', async () => {
  const doc = await tab(
    {
      'a.html': page(
        'a',
        'window.ticks = 0; setInterval(function () { window.ticks += 1; }, 5);' +
          'addEventListener("pagehide", function () { say("ticks " + window.ticks); });' +
          'addEventListener("pageshow", function (e) {' +
          '  if (!e.persisted) return;' +
          '  say("ticks " + window.ticks);' +
          '  setTimeout(function () { say("ticks " + window.ticks); }, 0);' +
          '});',
      ),
      'b.html': page('b'),
    },
    `${SITE}a.html`,
    3,
  );
  await until(doc, 'a pageshow false 1');
  await settle(60);
  doc.run('location.href = "b.html";');
  await until(doc, 'b pageshow false 1');
  // kept for many of its intervals, which fire on the host and wait, once
  await settle(200);
  doc.run('history.back();');
  await until(doc, 'a pageshow true 1');
  const end = Date.now() + 3000;
  const ticks = () =>
    doc.logs
      .filter((l) => l.startsWith('a ticks '))
      .map((l) => Number(l.slice(8)));
  while (ticks().length < 3 && Date.now() < end) await settle(20);
  const [left, shown, after] = ticks();
  // none ran while it was kept; the ticks owed — some forty, at five
  // milliseconds for two hundred — ran once, after its pageshow, with what
  // fired since
  assert.ok(left > 0, doc.logs.join('\n'));
  assert.equal(shown, left, doc.logs.join('\n'));
  assert.ok(after > left && after < left + 5, doc.logs.join('\n'));
});

test('a document with a WebTransport session open unloads, and a step back loads it again; once the session is closed it is kept', async () => {
  const transport = new FakeTransport((server) => server.accept());
  const wt =
    'window.wt = new WebTransport("https://wt.test/");' +
    'wt.ready.then(function () { say("connected"); });';
  const doc = await tab(
    {
      'a.html': page(
        'a',
        wt + 'addEventListener("unload", function () { say("unload"); });',
      ),
      'b.html': page('b', wt),
    },
    `${SITE}a.html`,
    3,
    transport,
  );
  await until(doc, 'a connected');
  doc.run('location.href = "b.html";');
  await until(doc, 'b connected');
  // a session open keeps it out: it unloads, and is let go
  assert.ok(doc.logs.includes('a pagehide false'), doc.logs.join('\n'));
  assert.ok(doc.logs.includes('a unload'), doc.logs.join('\n'));
  assert.deepEqual(doc.session.kept, []);
  await settle();
  assert.deepEqual(doc.mounted(), [`${SITE}b.html`]);
  // closed, it is kept
  doc.run('wt.close(); wt.closed.then(function () { say("closed"); });');
  await until(doc, 'b closed');
  // a step back to one not kept loads it again
  doc.run('history.back();');
  await until(doc, 'a connected', 2);
  assert.equal(doc.logs.filter((l) => l === 'a loaded').length, 2);
  assert.ok(doc.logs.includes('b pagehide true'), doc.logs.join('\n'));
  assert.deepEqual(doc.session.kept, [doc.session.entries[1].document]);
});

test(
  'a document with a WebSocket open, or a worker of its with one, unloads; once the socket is closed it is kept',
  { timeout: 120_000 },
  async () => {
    let workerAsked = () => {};
    const asked = new Promise<void>((resolve) => {
      workerAsked = resolve;
    });
    const sockets = new FakeSockets((c) => {
      if (c.request.url === 'wss://ws.test/w') workerAsked();
      setTimeout(() => c.open(), 0);
    });
    const ws =
      'window.ws = new WebSocket("wss://ws.test/");' +
      'ws.onopen = function () { say("connected"); };' +
      'ws.onclose = function (e) { say("closed " + e.code); };';
    const worker =
      'var ws = new WebSocket("wss://ws.test/w"); ws.onopen = function () { postMessage("connected"); };';
    const doc = await tab(
      {
        'a.html': page(
          'a',
          ws + 'addEventListener("unload", function () { say("unload"); });',
        ),
        'b.html': page('b', ws),
        'c.html': page(
          'c',
          `var w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}], { type: "text/javascript" })));` +
            'w.onmessage = function (e) { say("worker " + e.data); };',
        ),
      },
      `${SITE}a.html`,
      3,
      undefined,
      sockets,
    );
    await until(doc, 'a connected');
    doc.run('location.href = "b.html";');
    await until(doc, 'b connected');
    // a socket open keeps it out: it unloads, and the socket goes with it,
    // going away
    assert.ok(doc.logs.includes('a pagehide false'), doc.logs.join('\n'));
    assert.ok(doc.logs.includes('a unload'), doc.logs.join('\n'));
    assert.deepEqual(doc.session.kept, []);
    assert.deepEqual(sockets.connections[0].closes, [[1001, '']]);
    // closed, it is kept
    doc.run('ws.close();');
    await until(doc, 'b closed 1005');
    doc.run('location.href = "c.html";');
    await until(doc, 'c pageshow false 1');
    // a worker's thread has the whole engine to load before its script runs,
    // however long the machine takes over that, so this waits for what the
    // worker asks of the seam and not for a time; the test's `timeout` is
    // only what ends it if the worker never asks
    await asked;
    await until(doc, 'c worker connected');
    assert.ok(doc.logs.includes('b pagehide true'), doc.logs.join('\n'));
    // a worker's socket keeps its page out as one of its own does
    doc.run('history.back();');
    await until(doc, 'b pageshow true 1');
    assert.ok(doc.logs.includes('c pagehide false'), doc.logs.join('\n'));
  },
);

test('the cache keeps as many documents as it is given, the one left longest ago going first, and one no entry is of any more goes', async () => {
  const pages = {
    'a.html': page('a'),
    'b.html': page('b'),
    'c.html': page('c'),
    'd.html': page('d'),
  };
  const doc = await tab(pages, `${SITE}a.html`, 1);
  await until(doc, 'a pageshow false 1');
  doc.run('location.href = "b.html";');
  await until(doc, 'b pageshow false 1');
  doc.run('location.href = "c.html";');
  await until(doc, 'c pageshow false 1');
  const [a, b] = doc.session.entries.map((e) => e.document);
  // one kept: the last left; the first was let go as it was, told nothing
  assert.deepEqual(doc.session.kept, [b]);
  await settle();
  assert.deepEqual(doc.mounted(), [`${SITE}b.html`, `${SITE}c.html`]);
  assert.ok(!doc.logs.includes('a unload'));
  assert.notEqual(a, b);
  // back to b, from the cache, and on to d from there: c's entry goes, and
  // c with it, and b is kept
  doc.run('history.back();');
  await until(doc, 'b pageshow true 1');
  doc.run('location.href = "d.html";');
  await until(doc, 'd pageshow false 1');
  await settle();
  assert.deepEqual(
    doc.session.entries.map((e) => e.url),
    [`${SITE}a.html`, `${SITE}b.html`, `${SITE}d.html`],
  );
  assert.deepEqual(doc.session.kept, [b]);
  assert.deepEqual(doc.mounted(), [`${SITE}b.html`, `${SITE}d.html`]);
});

test('a document shown again reads the session as it is now: its entries, how it was shown and from where, and its own entries that went are disposed after pageshow', async () => {
  const doc = await tab(
    {
      'a.html':
        page('a') +
        '<script>' +
        'window.first = navigation.entries()[0];' +
        'addEventListener("pageshow", function (e) {' +
        '  if (!e.persisted) return;' +
        '  say("entries " + navigation.entries().map(function (n) { return n.url.slice(n.url.lastIndexOf("/") + 1) + (n.sameDocument ? "*" : ""); }).join(","));' +
        '  say("activation " + navigation.activation.navigationType + " " + navigation.activation.from.url.slice(-6) + " " + (navigation.activation.entry === navigation.currentEntry) + " " + (navigation.currentEntry === window.first));' +
        '  say("length " + history.length);' +
        '});' +
        '</script>',
      'b.html': page('b'),
    },
    `${SITE}a.html`,
    3,
  );
  await until(doc, 'a pageshow false 1');
  // an entry of its own ahead of it, which the navigation to b takes away
  doc.run(
    'history.pushState(null, "", "#x"); history.back();' +
      'addEventListener("popstate", function () {' +
      '  navigation.entries()[1].addEventListener("dispose", function () { say("disposed"); });' +
      '  location.href = "b.html";' +
      '}, { once: true });',
  );
  await until(doc, 'b pageshow false 1');
  doc.run('history.back();');
  const logs = await until(doc, 'a disposed');
  const after = logs.slice(logs.indexOf('a pageshow true 1'));
  assert.deepEqual(
    after.filter((l) => l.startsWith('a ')),
    [
      'a pageshow true 1',
      'a entries a.html*,b.html',
      'a activation traverse b.html true true',
      'a length 2',
      'a disposed',
    ],
  );
});

test('a kept document that too much is asked of while it waits is let go, and a step back loads it again', async () => {
  const doc = await tab(
    { 'a.html': page('a'), 'b.html': page('b') },
    `${SITE}a.html`,
    3,
  );
  await until(doc, 'a pageshow false 1');
  doc.run('location.href = "b.html";');
  await until(doc, 'b pageshow false 1');
  const kept = doc.runnerAt(`${SITE}a.html`);
  assert.ok(kept?.engine.frozen);
  // what a worker that goes on talking to it would ask, past what is held
  for (let i = 0; i < 5000; i++) kept!.engine.call('__fire', [0, 'ping']);
  await settle();
  assert.deepEqual(doc.session.kept, []);
  assert.deepEqual(doc.mounted(), [`${SITE}b.html`]);
  // let go as it was, told nothing
  assert.ok(!doc.logs.includes('a unload'));
  doc.run('history.back();');
  await until(doc, 'a loaded', 2);
});
