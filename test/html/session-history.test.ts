// A tab's session history across the documents one `<Html>` shows
// (`src/html/scripts/session.ts`): a host hands every document it shows in
// a place the same `HtmlSessionHistory`, and each is the next of one
// history — `history.length`, `navigation.entries()`, `back()`,
// `forward()` and `traverseTo()` reach the documents before and after it,
// a document hears how it was shown (`navigation.activation`,
// `pagereveal`), and the one it replaces hears where it goes
// (`pageswap`). These run a tab as a browser's is: one `<Html>`, given the
// document of whatever address the page or the host goes to.
import { afterEach, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
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
import { FONTS, h } from './harness.js';

afterEach(cleanup);

await preloadHtmlScripts();

/** Tests that run a page's scripts, skipped where this runtime runs none
 *  (`SCRIPTS_CONTAINED`). */
const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const SITE = 'https://example.test/';

/** What each page says of itself as it starts, and of what it hears: its
 *  address, `history.length`, the entries the API shows (each the file
 *  and fragment it is at, `*` for one of its own), the current one's
 *  index, how it was shown, the entry it came from, and its
 *  `history.state`. */
const VIEW =
  '<script>' +
  'var fileOf = function (u) { return u ? u.slice(u.lastIndexOf("/") + 1) : "null"; };' +
  'var view = function () { return [' +
  '  fileOf(location.href), history.length,' +
  '  navigation.entries().map(function (e) { return fileOf(e.url) + (e.sameDocument ? "*" : ""); }).join(","),' +
  '  navigation.currentEntry.index, navigation.activation.navigationType,' +
  '  fileOf(navigation.activation.from && navigation.activation.from.url),' +
  '  JSON.stringify(history.state)].join(" "); };' +
  'console.log("view " + view());' +
  'addEventListener("popstate", function (e) { console.log("popstate " + view()); });' +
  '</script>';

interface Tab {
  session: HtmlSessionHistory;
  /** What the pages wrote to their consoles, in order. */
  logs: string[];
  /** What the seams were asked: `navigate <how> <url>`, `reload`,
   *  `go <delta>`. */
  asked: string[];
  /** The address shown now. */
  url(): string;
  /** Run a script in the document shown, as a task of its own. */
  run(code: string): void;
  runner(): ScriptRunner | null;
  /** The host shows another address itself: a typed one, its own Back. */
  show(url: string): Promise<void>;
}

/**
 * A tab: one `<Html>` showing the document at an address — `pages`' source
 * for its file — and the next whenever the page asks to go somewhere: an
 * address it navigates to, the same one again for a reload, and the entry
 * `session.go` answers for a step. Every document is shown with the same
 * session. `remount` gives each document an `<Html>` of its own, as a host
 * that keys the element on its document does.
 */
async function tab(
  pages: Record<string, string>,
  first: string,
  options: { session?: boolean; remount?: boolean } = {},
): Promise<Tab> {
  const session = new HtmlSessionHistory();
  const out = { session, logs: [], asked: [] } as unknown as Tab;
  let load: (url: string) => void = () => {};
  let shownUrl = first;
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
      out.asked.push(`navigate ${how} ${url}`);
      if (how !== 'tab') load(url);
    },
    reload: () => {
      out.asked.push('reload');
      load(shownUrl);
    },
    go: (delta) => {
      out.asked.push(`go ${delta}`);
      const to = session.go(delta);
      if (to) load(to.url);
    },
    log: (_level, text) => void out.logs.push(text),
    title: () => {},
    fetch: async () => {
      throw new Error('no network');
    },
    load: async () => null,
    onTimeout: () => {},
    session: options.session === false ? null : session,
  };
  function Page(props: { url: string; n: number }) {
    const handle = useHtmlHandle();
    const scripts = useScripts(true, handle, props.url, seams);
    out.run = (code) => scripts.runner?.()?.engine.exec(code, 'test', 0);
    out.runner = () => scripts.runner?.() ?? null;
    const file = new URL(props.url).pathname.slice(1);
    return h(Html, {
      // a document of its own each time, as a browser makes one
      source: `${pages[file] ?? '<p>missing</p>'}<!--${props.n}-->`,
      partial: false,
      ref: handle.ref,
      baseUrl: props.url,
      onLink: (href: string) => {
        out.asked.push(`link ${href}`);
        load(href);
      },
      ...scripts,
    });
  }
  function Shown() {
    const [at, setAt] = useState({ url: first, n: 0 });
    load = (url) => {
      shownUrl = url;
      setAt((was) => ({ url, n: was.n + 1 }));
    };
    out.url = () => at.url;
    return h(
      'box',
      { style: { width: 400, height: 300, flexDirection: 'column' } },
      h(Page, {
        ...(options.remount ? { key: at.n } : {}),
        url: at.url,
        n: at.n,
      }),
    );
  }
  out.show = async (url) => {
    await act(async () => load(url));
    await settle();
  };
  await renderX11(
    h(Shown),
    FONTS ? { width: 440, height: 400, fonts: FONTS } : { backend: 'mock' },
  );
  await settle();
  return out;
}

/** Let the pages' turns run: timers at no delay, frames, and the render
 *  after. */
async function settle(ms = 40) {
  for (let i = 0; i < 4; i += 1) {
    await act(() => new Promise((r) => setTimeout(r, ms / 4)));
  }
}

/** Wait until `count` lines start with `prefix`, and those lines. */
async function logged(
  doc: Tab,
  prefix: string,
  count: number,
  ms = 3000,
): Promise<string[]> {
  const lines = () =>
    doc.logs
      .filter((l) => l.startsWith(prefix))
      .map((l) => l.slice(prefix.length));
  const end = Date.now() + ms;
  while (lines().length < count && Date.now() < end) await settle(20);
  return lines();
}

test('a page reaches the entries of the documents the tab showed before and after it, and goes back and forward among them', async () => {
  const doc = await tab(
    { 'a.html': `<p>a</p>${VIEW}`, 'b.html': `<p>b</p>${VIEW}` },
    `${SITE}a.html`,
  );
  assert.deepEqual(await logged(doc, 'view ', 1), [
    'a.html 1 a.html* 0 push null null',
  ]);
  // an entry of its own, and then another document
  doc.run('history.pushState({ n: 1 }, "", "#one"); location.href = "b.html";');
  assert.equal(
    (await logged(doc, 'view ', 2))[1],
    'b.html 3 a.html,a.html#one,b.html* 2 push a.html#one null',
  );
  assert.equal(doc.url(), `${SITE}b.html`);
  const keys = doc.session.entries.map((e) => e.key);
  assert.equal(new Set(keys).size, 3);
  assert.equal(doc.session.index, 2);
  // back is the entry the first document made: that document again, at
  // that entry, its state and its own entries with it
  doc.run('history.back()');
  assert.equal(
    (await logged(doc, 'view ', 3))[2],
    'a.html#one 3 a.html*,a.html#one*,b.html 1 traverse b.html {"n":1}',
  );
  assert.equal(doc.url(), `${SITE}a.html#one`);
  assert.deepEqual(
    doc.session.entries.map((e) => e.key),
    keys,
    'a traversal keeps every entry',
  );
  // and back again inside it is its own: a popstate, no document
  doc.run('history.back()');
  assert.deepEqual(await logged(doc, 'popstate ', 1), [
    'a.html 3 a.html*,a.html#one*,b.html 0 traverse b.html null',
  ]);
  assert.equal(doc.logs.filter((l) => l.startsWith('view ')).length, 3);
  // the API's methods reach another document's entry by its key
  doc.run(
    'console.log("keys " + navigation.entries().map(function (e) { return e.key; }).join(","));' +
      'console.log("can " + navigation.canGoBack + " " + navigation.canGoForward);' +
      'navigation.traverseTo(navigation.entries()[2].key);',
  );
  assert.deepEqual(await logged(doc, 'keys ', 1), [keys.join(',')]);
  assert.deepEqual(await logged(doc, 'can ', 1), ['false true']);
  assert.equal(
    (await logged(doc, 'view ', 4))[3],
    'b.html 3 a.html,a.html#one,b.html* 2 traverse a.html null',
  );
  assert.deepEqual(
    doc.asked.filter((a) => a.startsWith('go')),
    ['go -1', 'go 2'],
  );
  // a push from the middle drops what was ahead
  doc.run('navigation.back();');
  await logged(doc, 'view ', 5);
  doc.run('location.href = "b.html?again";');
  assert.equal(
    (await logged(doc, 'view ', 6))[5],
    'b.html?again 3 a.html,a.html#one,b.html?again* 2 push a.html#one null',
  );
  assert.equal(doc.session.entries.length, 3);
});

test('the Navigation API shows the entries of its own origin, history.length all of them, and a step to another origin hears no navigate', async () => {
  const doc = await tab(
    {
      'a.html':
        `<p>a</p>${VIEW}<script>` +
        'navigation.onnavigate = function (e) {' +
        '  console.log("navigate " + e.navigationType + " " + e.destination.sameDocument + " " + e.cancelable + " " + e.canIntercept + " " + fileOf(e.destination.url));' +
        '};</script>',
    },
    `${SITE}a.html`,
  );
  await logged(doc, 'view ', 1);
  // an address the host goes to itself is a push
  await doc.show(`${SITE}a.html?2`);
  await doc.show('https://other.test/a.html');
  const views = await logged(doc, 'view ', 3);
  assert.deepEqual(views.slice(1), [
    'a.html?2 2 a.html,a.html?2* 1 push a.html null',
    // the entries before are another origin's: in the history, and not
    // the API's, and not where it came from
    'a.html 3 a.html* 0 push null null',
  ]);
  // a step back to another origin's entry tells no navigate, and one
  // within the origin tells a traversal neither cancelable nor one a
  // handler can take
  doc.run('history.back()');
  assert.equal(
    (await logged(doc, 'view ', 4))[3],
    'a.html?2 3 a.html,a.html?2* 1 traverse null null',
  );
  doc.run('history.go(-1)');
  assert.equal(
    (await logged(doc, 'view ', 5))[4],
    'a.html 3 a.html*,a.html?2 0 traverse a.html?2 null',
  );
  assert.deepEqual(await logged(doc, 'navigate ', 1), [
    'traverse false false false a.html',
  ]);
  assert.equal(doc.url(), `${SITE}a.html`);
  assert.equal(doc.session.index, 0);
  // and nothing is past the ends
  doc.run('history.go(-5); history.go(9);');
  await settle();
  assert.equal(doc.logs.filter((l) => l.startsWith('view ')).length, 5);
});

test('the document a navigation leaves hears where it goes in pageswap, after its frames and before its pagehide, and each one shown hears pagereveal before its first frame', async () => {
  const doc = await tab(
    {
      'a.html':
        `<p>a</p>${VIEW}<script>` +
        'addEventListener("pageswap", function (e) {' +
        '  var a = e.activation;' +
        '  console.log("pageswap " + (e instanceof PageSwapEvent) + " " + e.viewTransition + " " +' +
        '    (a ? [a.navigationType, fileOf(a.from.url), fileOf(a.entry.url), a.from === navigation.currentEntry,' +
        '      a.entry.key === (navigation.entries()[a.entry.index] || {}).key, a.entry.sameDocument, a.entry.index].join(" ") : "null"));' +
        // what it starts as it hears it goes nowhere
        '  location.href = "elsewhere.html";' +
        '});' +
        'addEventListener("pagehide", function () { console.log("pagehide"); });' +
        'addEventListener("unload", function () { console.log("unload"); });' +
        'requestAnimationFrame(function () { console.log("frame"); });' +
        'onpagereveal = function (e) { console.log("pagereveal " + (e instanceof PageRevealEvent) + " " + e.viewTransition); };' +
        // a frame of its own origin's, whose document goes before it
        'var f = document.createElement("iframe"); f.srcdoc = "<p>f</p>";' +
        'f.onload = function () {' +
        '  f.contentWindow.onpagehide = function () { console.log("frame pagehide"); };' +
        '  console.log("frame loaded");' +
        '};' +
        'document.body.appendChild(f);' +
        '</script>',
      'b.html': `<p>b</p>${VIEW}`,
    },
    `${SITE}a.html`,
  );
  await logged(doc, 'view ', 1);
  await logged(doc, 'frame', 2);
  const at = (prefix: string) =>
    doc.logs.findIndex((l) => l.startsWith(prefix));
  assert.ok(at('pagereveal') >= 0, doc.logs.join('\n'));
  assert.ok(at('pagereveal') < doc.logs.indexOf('frame'), doc.logs.join('\n'));
  assert.equal(doc.logs[at('pagereveal')], 'pagereveal true null');
  // a push to another document: the new entry is none of its entries yet
  doc.run('location.href = "b.html";');
  await logged(doc, 'view ', 2);
  assert.deepEqual(doc.logs.slice(at('frame pagehide'), at('unload') + 1), [
    'frame pagehide',
    'pageswap true null push a.html b.html true false false -1',
    'pagehide',
    'unload',
  ]);
  assert.ok(
    !doc.asked.some((a) => a.includes('elsewhere')),
    doc.asked.join('\n'),
  );
  // a traversal back, and forward: the entry among its own, and the
  // document shown again revealed again
  doc.run('history.back()');
  await logged(doc, 'view ', 3);
  assert.equal((await logged(doc, 'pagereveal ', 2))[1], 'true null');
  await logged(doc, 'frame loaded', 2);
  doc.run('navigation.forward()');
  await logged(doc, 'view ', 4);
  const swaps = await logged(doc, 'pageswap ', 2);
  assert.equal(swaps[1], 'true null traverse a.html b.html true true false 1');
});

test('a reload keeps the entry, its key and its state, and a replace takes the entry’s place with its key', async () => {
  const doc = await tab(
    {
      'a.html':
        `<p>a</p>${VIEW}<script>` +
        'console.log("state " + JSON.stringify(navigation.currentEntry.getState()) + " " + navigation.currentEntry.key +' +
        '  " " + (navigation.activation.from === navigation.currentEntry) + " " + (navigation.activation.entry === navigation.currentEntry));' +
        'addEventListener("pageswap", function (e) {' +
        '  console.log("pageswap " + e.activation.navigationType + " " + (e.activation.entry === navigation.currentEntry) +' +
        '    " " + JSON.stringify(e.activation.entry.getState()));' +
        '});</script>',
      'c.html':
        `<p>c</p>${VIEW}<script>` +
        'var from = navigation.activation.from;' +
        'console.log("replaced " + from.key + " " + navigation.currentEntry.key + " " + from.index + " " + from.sameDocument +' +
        '  " " + JSON.stringify(navigation.currentEntry.getState()));' +
        '</script>',
    },
    `${SITE}a.html`,
  );
  await logged(doc, 'view ', 1);
  doc.run('history.replaceState({ kept: true }, "");');
  doc.run('navigation.reload({ state: "s" });');
  const views = await logged(doc, 'view ', 2);
  assert.equal(views[1], 'a.html 1 a.html* 0 reload a.html {"kept":true}');
  const states = await logged(doc, 'state ', 2);
  const key = doc.session.entries[0].key;
  assert.deepEqual(states, [
    `undefined ${key} false true`,
    `"s" ${key} true true`,
  ]);
  // the entry it goes to is the one it is at, with the state it has
  assert.deepEqual(await logged(doc, 'pageswap ', 1), [
    'reload true undefined',
  ]);
  assert.ok(doc.asked.includes('reload'));
  // a replace: the same key, a new id, and the state the page gave it
  const id = doc.session.entries[0].id;
  doc.run(
    'navigation.navigate("c.html", { history: "replace", state: { c: 1 } });',
  );
  assert.equal(
    (await logged(doc, 'view ', 3))[2],
    'c.html 1 c.html* 0 replace a.html null',
  );
  assert.deepEqual(await logged(doc, 'replaced ', 1), [
    `${key} ${key} -1 false {"c":1}`,
  ]);
  assert.equal(doc.session.entries.length, 1);
  assert.equal(doc.session.entries[0].key, key);
  assert.notEqual(doc.session.entries[0].id, id);
});

test('the host steps the session itself: among the document’s own entries the document goes, and to another document the entry to load', async () => {
  const doc = await tab(
    { 'a.html': `<p>a</p>${VIEW}`, 'b.html': `<p>b</p>${VIEW}` },
    `${SITE}a.html`,
  );
  await logged(doc, 'view ', 1);
  doc.run('history.pushState(null, "", "#x")');
  await settle();
  await doc.show(`${SITE}b.html`);
  await logged(doc, 'view ', 2);
  assert.deepEqual(
    doc.session.entries.map((e) => [e.url.slice(SITE.length), e.document]),
    [
      ['a.html', 1],
      ['a.html#x', 1],
      ['b.html', 2],
    ],
  );
  // to another document's: the entry, which the host loads
  const to = doc.session.go(-1);
  assert.equal(to?.url, `${SITE}a.html#x`);
  await doc.show(to!.url);
  assert.equal(
    (await logged(doc, 'view ', 3))[2],
    'a.html#x 3 a.html*,a.html#x*,b.html 1 traverse b.html null',
  );
  // to one of its own: the document goes there itself, and nothing loads
  assert.equal(doc.session.go(-1), null);
  assert.deepEqual(await logged(doc, 'popstate ', 1), [
    'a.html 3 a.html*,a.html#x*,b.html 0 traverse b.html null',
  ]);
  assert.equal(doc.session.index, 0);
  assert.equal(doc.session.go(-1), null, 'nothing before the first');
  // a reload the host plans keeps the entry
  doc.session.reload();
  await doc.show(`${SITE}a.html`);
  assert.equal(
    (await logged(doc, 'view ', 4))[3],
    'a.html 3 a.html*,a.html#x*,b.html 0 reload a.html null',
  );
});

test('a host that mounts an <Html> for each document keeps one session, and the document it replaces still hears pageswap', async () => {
  const doc = await tab(
    {
      'a.html':
        `<p>a</p>${VIEW}<script>` +
        'addEventListener("pageswap", function (e) { console.log("pageswap " + (e.activation && e.activation.navigationType)); });' +
        'addEventListener("pagehide", function () { console.log("pagehide"); });' +
        '</script>',
      'b.html': `<p>b</p>${VIEW}`,
    },
    `${SITE}a.html`,
    { remount: true },
  );
  await logged(doc, 'view ', 1);
  doc.run('location.href = "b.html";');
  assert.equal(
    (await logged(doc, 'view ', 2))[1],
    'b.html 2 a.html,b.html* 1 push a.html null',
  );
  assert.deepEqual(
    doc.logs.filter((l) => /^page(swap|hide)/.test(l)),
    ['pageswap push', 'pagehide'],
  );
});

test('with no session each document’s history is its own, and the one it replaces hears pageswap with no activation', async () => {
  const doc = await tab(
    {
      'a.html':
        `<p>a</p>${VIEW}<script>` +
        'addEventListener("pageswap", function (e) { console.log("pageswap " + e.activation); });' +
        '</script>',
      'b.html': `<p>b</p>${VIEW}`,
    },
    `${SITE}a.html`,
    { session: false },
  );
  await logged(doc, 'view ', 1);
  doc.run('history.pushState(null, "", "#x"); location.href = "b.html";');
  assert.equal(
    (await logged(doc, 'view ', 2))[1],
    'b.html 1 b.html* 0 push null null',
  );
  assert.deepEqual(await logged(doc, 'pageswap ', 1), ['null']);
  // and past its own entries is still the host's, as it always was
  doc.run('history.back()');
  await settle();
  assert.ok(doc.asked.includes('go -1'), doc.asked.join('\n'));
});
