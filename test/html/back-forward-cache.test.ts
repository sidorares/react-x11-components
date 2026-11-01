// A session's back-forward cache (`HtmlSessionOptions.backForwardCache`,
// `src/html/scripts/session.ts`): a document left is kept, frozen, and a step
// back or forward to it shows it again as it was — its scripts' state, its
// DOM — told `pageshow` with `persisted` true, where without the cache it
// would unload and load again. These run a tab as a host that keeps one
// does: an `<Html>` a document, the documents the session keeps mounted and
// hidden, and the one the current entry is of shown.
import { afterEach, test as nodeTest } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { act, cleanup, renderX11 } from 'react-x11/test';

import {
  Html,
  HtmlSessionHistory,
  useHtmlHandle,
} from '../../src/html/index.js';
import { preloadHtmlScripts, useScripts } from '../../src/html/scripts/hook.js';
import { FrameHolder, embeddedMounts } from '../../src/html/scripts/frames.js';
import type { FrameContext } from '../../src/html/scripts/frames.js';
import type { ScriptRunner } from '../../src/html/scripts/runner.js';
import type { ScriptsOptions } from '../../src/html/scripts/runner.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import type { HtmlWebTransport } from '../../src/html/transport.js';
import type { HtmlWebSocket } from '../../src/html/socket.js';
import type {
  FetchRequest,
  FetchResponse,
} from '../../src/html/scripts/host.js';
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
  fetch: (request: FetchRequest) => Promise<FetchResponse> = async () => {
    throw new Error('no network');
  },
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
      fetch: (request) => fetch(request),
      load: async () => null,
      onTimeout: () => {},
      drawsFrames: true,
      session,
      ...(webTransport && { webTransport }),
      ...(webSocket && { webSocket }),
    };
    const scripts = useScripts(true, handle, doc.url, seams);
    runners.set(doc.n, () => scripts.runner?.() ?? null);
    useEffect(() => () => void runners.delete(doc.n), []);
    const file = new URL(doc.url).pathname.slice(1);
    const frames = (): FrameContext | null => {
      const parent = scripts.runner?.();
      return parent
        ? { parent, seams, look: { onResource: () => null } }
        : null;
    };
    const holder = frames();
    return h(
      Fragment,
      null,
      h(Html, {
        source: `${pages[file] ?? '<p>missing</p>'}<!--${doc.n}-->`,
        partial: false,
        ref: handle.ref,
        baseUrl: doc.url,
        style: props.visible ? { flexGrow: 1 } : { display: 'none' },
        ...scripts,
        renderEmbedded: embeddedMounts(frames),
      }),
      holder ? h(FrameHolder, { context: holder }) : null,
    );
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

/** Wait for what a worker's thread comes to, a count or what it asked of a
 *  seam. The thread has the whole engine to load, however long the machine
 *  takes over that, so this waits for what it does and not for a time; the
 *  test's `timeout` is what ends it if it never comes. It ends with the test
 *  (`t.signal`): a loop that outlived its test held the file's process open
 *  for good, so a regression here hung the run where it should fail it. */
async function whenever(t: TestContext, done: () => boolean): Promise<void> {
  while (!done()) {
    t.signal.throwIfAborted();
    await settle(20);
  }
}

/**
 * A network with `files` on it, each answered at once but the one `held`,
 * which is answered once the test says: a worker asking for it stops there,
 * its thread waiting on the seam, not yet running a script `held` is, or in
 * the `importScripts` of one that is.
 */
function network(files: Record<string, string>, held: string) {
  let heard = () => {};
  let answer = () => {};
  const asked = new Promise<void>((resolve) => {
    heard = resolve;
  });
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const fetch = async (request: FetchRequest): Promise<FetchResponse> => {
    const file = new URL(request.url).pathname.slice(1);
    if (file === held) {
      heard();
      await answered;
    }
    return {
      url: request.url,
      status: 200,
      statusText: 'OK',
      redirected: false,
      headers: [['content-type', 'text/html']],
      body: files[file] ?? '',
    };
  };
  return { fetch, asked, answer };
}

/** How many of the workers of the document at an address have stopped. */
const stopped = (doc: Tab, url: string): number | undefined =>
  doc.runnerAt(url)?.host.workers?.stopped;

/** A worker that connects, and tells its page; and the page that hears it. */
const CONNECTS = 'var ws = new WebSocket("wss://ws.test/w");';
const SAYS_CONNECTED = 'ws.onopen = function () { postMessage("connected"); };';
const HEARS =
  'var w = new Worker("w.js"); w.onmessage = function (e) { say("worker " + e.data); };';

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

test('a document with a WebTransport session open is kept, the session ended as it goes, and hears that it failed once it is shown again', async () => {
  const transport = new FakeTransport((server) => server.accept());
  const doc = await tab(
    {
      'a.html': page(
        'a',
        'window.wt = new WebTransport("https://wt.test/");' +
          'wt.ready.then(function () { say("connected"); });' +
          'wt.closed.then(function () { say("closed"); }, function (e) { say("failed " + e.name + " " + e.source); });' +
          'addEventListener("unload", function () { say("unload"); });',
      ),
      'b.html': page('b'),
    },
    `${SITE}a.html`,
    3,
    transport,
  );
  await until(doc, 'a connected');
  doc.run('location.href = "b.html";');
  await until(doc, 'b pageshow false 1');
  assert.ok(doc.logs.includes('a pagehide true'), doc.logs.join('\n'));
  assert.ok(!doc.logs.includes('a unload'), doc.logs.join('\n'));
  assert.deepEqual(doc.session.kept, [doc.session.entries[0].document]);
  // its server sees it go now, and the page, stopped, hears nothing of it
  assert.deepEqual(transport.servers[0].closedWith, {
    closeCode: 0,
    reason: '',
  });
  await settle();
  assert.ok(
    !doc.logs.some((l) => l.startsWith('a failed')),
    doc.logs.join('\n'),
  );
  doc.run('history.back();');
  const logs = await until(doc, 'a failed WebTransportError session');
  assert.ok(
    logs.indexOf('a pageshow true 1') <
      logs.indexOf('a failed WebTransportError session'),
    logs.join('\n'),
  );
  assert.equal(logs.filter((l) => l === 'a loaded').length, 1);
  assert.equal(transport.servers.length, 1);
});

test('a session still opening as its document is kept is ended, its ready rejected once it is shown again', async () => {
  // a server that never answers
  const transport = new FakeTransport(() => {});
  const doc = await tab(
    {
      'a.html': page(
        'a',
        'window.wt = new WebTransport("https://wt.test/");' +
          'wt.ready.then(null, function (e) { say("not ready " + e.source); });',
      ),
      'b.html': page('b'),
    },
    `${SITE}a.html`,
    3,
    transport,
  );
  await until(doc, 'a pageshow false 1');
  doc.run('location.href = "b.html";');
  await until(doc, 'b pageshow false 1');
  assert.ok(doc.logs.includes('a pagehide true'), doc.logs.join('\n'));
  assert.deepEqual(transport.servers[0].closedWith, {
    closeCode: 0,
    reason: '',
  });
  doc.run('history.back();');
  await until(doc, 'a not ready session');
});

test('a session the page closes as it is hidden closes as it asked, since the steps that end one come after pagehide', async () => {
  const transport = new FakeTransport((server) => server.accept());
  const doc = await tab(
    {
      'a.html': page(
        'a',
        'window.wt = new WebTransport("https://wt.test/");' +
          'wt.ready.then(function () { say("connected"); });' +
          'wt.closed.then(function (i) { say("closed " + i.closeCode + " " + i.reason); });' +
          'addEventListener("pagehide", function () { wt.close({ closeCode: 7, reason: "bye" }); });',
      ),
      'b.html': page('b'),
    },
    `${SITE}a.html`,
    3,
    transport,
  );
  await until(doc, 'a connected');
  doc.run('location.href = "b.html";');
  await until(doc, 'b pageshow false 1');
  assert.deepEqual(transport.servers[0].closedWith, {
    closeCode: 7,
    reason: 'bye',
  });
  assert.equal(doc.session.kept.length, 1);
  await until(doc, 'a closed 7 bye');
});

test("a frame's session ends with the page the frame is in, which is kept", async () => {
  const transport = new FakeTransport((server) => server.accept());
  const net = network(
    {
      'f.html':
        '<script>window.wt = new WebTransport("https://wt.test/");</script>',
    },
    '',
  );
  const doc = await tab(
    {
      'a.html': page('a') + '<iframe src="f.html"></iframe>',
      'b.html': page('b'),
    },
    `${SITE}a.html`,
    3,
    transport,
    undefined,
    net.fetch,
  );
  await until(doc, 'a pageshow false 1');
  const end = Date.now() + 3000;
  while (!transport.servers.length && Date.now() < end) await settle(20);
  assert.equal(transport.servers.length, 1);
  doc.run('location.href = "b.html";');
  await until(doc, 'b pageshow false 1');
  assert.ok(doc.logs.includes('a pagehide true'), doc.logs.join('\n'));
  assert.equal(doc.session.kept.length, 1);
  assert.deepEqual(transport.servers[0].closedWith, {
    closeCode: 0,
    reason: '',
  });
});

test(
  'a document with a WebSocket open, or a worker of its with one, unloads; once the socket is closed it is kept',
  { timeout: 120_000 },
  async (t) => {
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

test(
  'a worker whose thread is still starting as its document is kept runs nothing until it is shown again, and the document stays kept',
  { timeout: 120_000 },
  async (t) => {
    const sockets = new FakeSockets((c) => setTimeout(() => c.open(), 0));
    const net = network({ 'w.js': CONNECTS + SAYS_CONNECTED }, 'w.js');
    const doc = await tab(
      { 'a.html': page('a', HEARS), 'b.html': page('b') },
      `${SITE}a.html`,
      3,
      undefined,
      sockets,
      net.fetch,
    );
    await until(doc, 'a pageshow false 1');
    // its thread is up as far as its script, and the page leaves
    await net.asked;
    doc.run('location.href = "b.html";');
    await until(doc, 'b pageshow false 1');
    assert.equal(doc.session.kept.length, 1);
    net.answer();
    await whenever(
      t,
      () =>
        stopped(doc, `${SITE}a.html`) === 1 || sockets.connections.length > 0,
    );
    // HTML 10.2.4: a worker whose owners are all in the cache is suspendable,
    // and its script does not run
    assert.equal(sockets.connections.length, 0);
    assert.equal(doc.session.kept.length, 1);
    doc.run('history.back();');
    await until(doc, 'a pageshow true 1');
    await whenever(t, () => doc.logs.includes('a worker connected'));
    // the same document, its worker having gone on from where it stopped
    assert.equal(doc.logs.filter((l) => l === 'a loaded').length, 1);
    assert.equal(sockets.connections.length, 1);
  },
);

test(
  'what a page posted to a worker still starting as its document was kept reaches the script that waited, once it is shown again',
  { timeout: 120_000 },
  async (t) => {
    const net = network(
      {
        'w.js': 'onmessage = function (e) { postMessage("heard " + e.data); };',
      },
      'w.js',
    );
    const doc = await tab(
      {
        'a.html': page('a', HEARS + 'w.postMessage("hello");'),
        'b.html': page('b'),
      },
      `${SITE}a.html`,
      3,
      undefined,
      undefined,
      net.fetch,
    );
    await until(doc, 'a pageshow false 1');
    await net.asked;
    doc.run('location.href = "b.html";');
    await until(doc, 'b pageshow false 1');
    net.answer();
    await whenever(t, () => stopped(doc, `${SITE}a.html`) === 1);
    doc.run('history.back();');
    await until(doc, 'a pageshow true 1');
    // run after the message, the script would have left it nobody to hear
    await whenever(t, () => doc.logs.includes('a worker heard hello'));
  },
);

test(
  'a timer of a worker whose document is kept waits until it is shown again, and what it does then is the page shown',
  { timeout: 120_000 },
  async (t) => {
    const sockets = new FakeSockets((c) => setTimeout(() => c.open(), 0));
    const net = network(
      {
        'w.js':
          'postMessage("up");' +
          'onmessage = function () { setTimeout(function () {' +
          CONNECTS +
          SAYS_CONNECTED +
          '}, 0); };',
      },
      '',
    );
    const doc = await tab(
      {
        'a.html': page(
          'a',
          HEARS +
            'addEventListener("pagehide", function () { w.postMessage("soon"); });',
        ),
        'b.html': page('b'),
      },
      `${SITE}a.html`,
      3,
      undefined,
      sockets,
      net.fetch,
    );
    await whenever(t, () => doc.logs.includes('a worker up'));
    doc.run('location.href = "b.html";');
    await until(doc, 'b pageshow false 1');
    await whenever(
      t,
      () =>
        stopped(doc, `${SITE}a.html`) === 1 || sockets.connections.length > 0,
    );
    assert.equal(sockets.connections.length, 0);
    assert.equal(doc.session.kept.length, 1);
    doc.run('history.back();');
    await until(doc, 'a pageshow true 1');
    await whenever(t, () => doc.logs.includes('a worker connected'));
    assert.equal(doc.logs.filter((l) => l === 'a loaded').length, 1);
    assert.equal(stopped(doc, `${SITE}a.html`), 0);
  },
);

test(
  "a WebSocket asked for by a task under way as its worker's document is kept lets the document go, and is never opened",
  { timeout: 120_000 },
  async (t) => {
    const sockets = new FakeSockets();
    const net = network(
      { 'w.js': `importScripts("hold.js");${CONNECTS}` },
      'hold.js',
    );
    const doc = await tab(
      {
        'a.html': page(
          'a',
          HEARS + 'addEventListener("unload", function () { say("unload"); });',
        ),
        'b.html': page('b'),
      },
      `${SITE}a.html`,
      3,
      undefined,
      sockets,
      net.fetch,
    );
    await until(doc, 'a pageshow false 1');
    // the task is in its `importScripts`, where no message reaches it
    await net.asked;
    doc.run('location.href = "b.html";');
    await until(doc, 'b pageshow false 1');
    assert.equal(doc.session.kept.length, 1);
    net.answer();
    await whenever(
      t,
      () => doc.session.kept.length === 0 || sockets.connections.length > 0,
    );
    assert.equal(sockets.connections.length, 0);
    assert.deepEqual(doc.session.kept, []);
    await settle();
    assert.deepEqual(doc.mounted(), [`${SITE}b.html`]);
    // let go as it was, told nothing
    assert.ok(!doc.logs.includes('a unload'));
    doc.run('history.back();');
    await until(doc, 'a loaded', 2);
  },
);

test(
  "a WebTransport session asked for by a task under way as its worker's document is kept is never opened, and the worker hears that it failed once the document is shown again",
  { timeout: 120_000 },
  async (t) => {
    const transport = new FakeTransport((server) => server.accept());
    const net = network(
      {
        'w.js':
          'importScripts("hold.js");' +
          'var wt = new WebTransport("https://wt.test/");' +
          'wt.ready.catch(function (e) { postMessage("failed " + e.source); });' +
          // after the ask on the thread's one channel, and heard by the
          // host, where a message to the page waits for it
          'console.log("asked");',
      },
      'hold.js',
    );
    const doc = await tab(
      { 'a.html': page('a', HEARS), 'b.html': page('b') },
      `${SITE}a.html`,
      3,
      transport,
      undefined,
      net.fetch,
    );
    await until(doc, 'a pageshow false 1');
    // the task is in its `importScripts`, where no message reaches it
    await net.asked;
    doc.run('location.href = "b.html";');
    await until(doc, 'b pageshow false 1');
    assert.equal(doc.session.kept.length, 1);
    net.answer();
    await whenever(t, () => doc.logs.some((l) => l.endsWith(' asked')));
    await settle();
    assert.equal(transport.servers.length, 0);
    assert.equal(doc.session.kept.length, 1);
    doc.run('history.back();');
    await until(doc, 'a pageshow true 1');
    await whenever(t, () => doc.logs.includes('a worker failed session'));
    assert.equal(doc.logs.filter((l) => l === 'a loaded').length, 1);
    assert.equal(transport.servers.length, 0);
  },
);

test(
  "a worker's connection a frame's document asks for lets go of the page the frame is in, not the frame alone",
  { timeout: 120_000 },
  async (t) => {
    const sockets = new FakeSockets();
    const net = network(
      {
        'f.html': '<script>new Worker("w.js");</script>',
        'w.js': `importScripts("hold.js");${CONNECTS}`,
      },
      'hold.js',
    );
    const doc = await tab(
      {
        'a.html': page('a') + '<iframe src="f.html"></iframe>',
        'b.html': page('b'),
      },
      `${SITE}a.html`,
      3,
      undefined,
      sockets,
      net.fetch,
    );
    await net.asked;
    await until(doc, 'a pageshow false 1');
    doc.run('location.href = "b.html";');
    await until(doc, 'b pageshow false 1');
    assert.equal(doc.session.kept.length, 1);
    net.answer();
    await whenever(
      t,
      () => doc.session.kept.length === 0 || sockets.connections.length > 0,
    );
    assert.equal(sockets.connections.length, 0);
    await settle();
    assert.deepEqual(doc.mounted(), [`${SITE}b.html`]);
  },
);

test(
  "a worker's WebTransport session ends as its document is kept, and the worker hears that it failed once the document is shown again",
  { timeout: 120_000 },
  async (t) => {
    const transport = new FakeTransport((server) => server.accept());
    const net = network(
      {
        'w.js':
          'var wt = new WebTransport("https://wt.test/");' +
          'wt.ready.then(function () { postMessage("connected"); });' +
          'wt.closed.catch(function (e) { postMessage("failed " + e.source); });',
      },
      '',
    );
    const doc = await tab(
      { 'a.html': page('a', HEARS), 'b.html': page('b') },
      `${SITE}a.html`,
      3,
      transport,
      undefined,
      net.fetch,
    );
    await whenever(t, () => doc.logs.includes('a worker connected'));
    doc.run('location.href = "b.html";');
    await until(doc, 'b pageshow false 1');
    assert.ok(doc.logs.includes('a pagehide true'), doc.logs.join('\n'));
    assert.equal(doc.session.kept.length, 1);
    assert.deepEqual(transport.servers[0].closedWith, {
      closeCode: 0,
      reason: '',
    });
    await whenever(t, () => stopped(doc, `${SITE}a.html`) === 1);
    doc.run('history.back();');
    await until(doc, 'a pageshow true 1');
    await whenever(t, () => doc.logs.includes('a worker failed session'));
    assert.equal(doc.logs.filter((l) => l === 'a loaded').length, 1);
    assert.equal(transport.servers.length, 1);
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
