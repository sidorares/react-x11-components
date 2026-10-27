// Where a page's storage and cookies are kept: the seams `<Html scripts>`
// asks (`storage`, `cookies`), memory by default, and the SQLite profile a
// browser's processes share (src/html/storage.ts, src/html/profile.ts).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import {
  CookieJar,
  Html,
  HtmlProfile,
  MemoryStorageArea,
  STORAGE_QUOTA,
  memoryStorage,
  useHtmlHandle,
} from '../../src/html/index.js';
import type {
  HtmlHandle,
  HtmlScripts,
  HtmlStorageChange,
} from '../../src/html/index.js';
import { preloadHtmlScripts } from '../../src/html/scripts/hook.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, findById, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

/** Whether this runtime has SQLite: Node 22.13 and later, and Bun. */
const SQLITE = await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-probe-'));
  try {
    const profile = await HtmlProfile.open(dir);
    profile?.close();
    return !!profile;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const withSqlite = SQLITE ? nodeTest : nodeTest.skip;
const scripted = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;
const both = SQLITE && SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** A profile directory of its own, gone after the test. */
function profileDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'profile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ORIGIN = 'https://example.test';

nodeTest(
  'an area in memory holds an origin to its quota, and lets it shrink past it',
  () => {
    const area = new MemoryStorageArea();
    assert.ok(area.set('a', 'x'.repeat(STORAGE_QUOTA - 2)));
    assert.equal(area.set('b', 'yy'), false, 'past the quota');
    assert.equal(area.get('b'), null);
    assert.ok(area.set('a', 'small'), 'smaller, it fits');
    assert.ok(area.set('b', 'yy'));
    assert.deepEqual(area.keys(), ['a', 'b']);
  },
);

nodeTest(
  'memory storage: an origin each, and the changes told to its listeners',
  () => {
    const storage = memoryStorage();
    storage.local(ORIGIN).set('k', 'v');
    assert.equal(storage.local(ORIGIN).get('k'), 'v');
    assert.equal(storage.local('https://other.test').get('k'), null);
    assert.equal(storage.session(ORIGIN).get('k'), null, 'session is apart');
    const heard: string[] = [];
    const stop = storage.watch!((c) => heard.push(`${c.key}=${c.newValue}`));
    storage.tell!({
      kind: 'local',
      origin: ORIGIN,
      key: 'k',
      oldValue: null,
      newValue: 'v',
      url: `${ORIGIN}/`,
      source: 'h1',
    });
    stop();
    storage.tell!({
      kind: 'local',
      origin: ORIGIN,
      key: 'k2',
      oldValue: null,
      newValue: 'v',
      url: `${ORIGIN}/`,
      source: 'h1',
    });
    assert.deepEqual(heard, ['k=v']);
  },
);

withSqlite(
  'a profile is shared by every connection that opens it, and outlives them',
  async (t) => {
    const dir = profileDir(t);
    const a = (await HtmlProfile.open(dir, { tab: 'one' }))!;
    const b = (await HtmlProfile.open(dir, { tab: 'two' }))!;
    const ja = new CookieJar({ store: a.cookies });
    const jb = new CookieJar({ store: b.cookies });
    const ctx = { http: true, sameSite: true, topLevel: true };
    ja.store(
      `${ORIGIN}/login`,
      ['session=alice; Path=/', 'keep=1; Path=/; Max-Age=3600'],
      ctx,
    );
    assert.equal(
      jb.header(`${ORIGIN}/`, ctx),
      'session=alice; keep=1',
      'another connection reads it',
    );
    jb.store(`${ORIGIN}/`, ['session=bob; Path=/'], ctx);
    assert.equal(
      ja.header(`${ORIGIN}/`, ctx),
      'session=bob; keep=1',
      'and writes it',
    );
    // localStorage, one origin's across connections
    a.storage.local(ORIGIN).set('k', 'v');
    assert.equal(b.storage.local(ORIGIN).get('k'), 'v');
    b.storage.local(ORIGIN).remove('k');
    assert.equal(a.storage.local(ORIGIN).get('k'), null);
    a.storage.local(ORIGIN).set('k', 'again');
    // sessionStorage, a tab's own
    a.storage.session(ORIGIN).set('s', 'one');
    assert.equal(
      b.storage.session(ORIGIN).get('s'),
      null,
      'another tab has none',
    );
    a.close();
    b.close();

    const c = (await HtmlProfile.open(dir, { tab: 'one' }))!;
    t.after(() => c.close());
    const jc = new CookieJar({ store: c.cookies });
    assert.equal(
      jc.header(`${ORIGIN}/`, ctx),
      'session=bob; keep=1',
      'after a restart',
    );
    assert.equal(c.storage.local(ORIGIN).get('k'), 'again');
    assert.equal(c.storage.session(ORIGIN).get('s'), 'one', 'the tab restored');
    // a session that is not restored keeps none of what lives for one
    c.endSession({ keepTabs: [] });
    const fresh = (await HtmlProfile.open(dir, { tab: 'one' }))!;
    t.after(() => fresh.close());
    assert.equal(
      new CookieJar({ store: fresh.cookies }).header(`${ORIGIN}/`, ctx),
      'keep=1',
    );
    assert.equal(fresh.storage.session(ORIGIN).get('s'), null);
    assert.equal(fresh.storage.local(ORIGIN).get('k'), 'again');
  },
);

withSqlite(
  'a session restored keeps its session cookies and its tabs’ sessionStorage',
  async (t) => {
    const dir = profileDir(t);
    const a = (await HtmlProfile.open(dir, { tab: 'kept' }))!;
    const jar = new CookieJar({ store: a.cookies });
    jar.store(`${ORIGIN}/`, ['session=1'], { http: true, sameSite: true });
    a.storage.session(ORIGIN).set('s', '1');
    a.endSession({ keepTabs: ['kept'], keepSessionCookies: true });
    a.close();
    const b = (await HtmlProfile.open(dir, { tab: 'kept' }))!;
    t.after(() => b.close());
    assert.equal(
      new CookieJar({ store: b.cookies }).header(`${ORIGIN}/`, {
        http: true,
        sameSite: true,
      }),
      'session=1',
    );
    assert.equal(b.storage.session(ORIGIN).get('s'), '1');
  },
);

withSqlite(
  'a change one connection tells is heard by another’s listeners, and not its own twice',
  async (t) => {
    const dir = profileDir(t);
    const a = (await HtmlProfile.open(dir))!;
    const b = (await HtmlProfile.open(dir))!;
    t.after(() => {
      a.close();
      b.close();
    });
    const heardA: HtmlStorageChange[] = [];
    const heardB: HtmlStorageChange[] = [];
    const stopA = a.storage.watch!((c) => heardA.push(c));
    const stopB = b.storage.watch!((c) => heardB.push(c));
    t.after(() => {
      stopA();
      stopB();
    });
    a.storage.local(ORIGIN).set('k', 'v');
    a.storage.tell!({
      kind: 'local',
      origin: ORIGIN,
      key: 'k',
      oldValue: null,
      newValue: 'v',
      url: `${ORIGIN}/a`,
      source: 'h1',
    });
    // a session's change is one tab's, and goes to no other connection
    a.storage.tell!({
      kind: 'session',
      origin: ORIGIN,
      key: 's',
      oldValue: null,
      newValue: 'v',
      url: `${ORIGIN}/a`,
      source: 'h1',
    });
    const deadline = Date.now() + 3000;
    while (!heardB.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(
      heardB.map((c) => [c.kind, c.key, c.newValue, c.url]),
      [['local', 'k', 'v', `${ORIGIN}/a`]],
    );
    assert.deepEqual(
      heardA.map((c) => [c.kind, c.key]),
      [
        ['local', 'k'],
        ['session', 's'],
      ],
      'heard once, as it was told',
    );
  },
);

withSqlite(
  'IndexedDB in a profile: a commit is a stamp, read back whole, gone with its store',
  async (t) => {
    const dir = profileDir(t);
    const a = (await HtmlProfile.open(dir))!;
    const b = (await HtmlProfile.open(dir))!;
    t.after(() => {
      a.close();
      b.close();
    });
    const idb = a.storage.indexedDB!;
    const store = (name: string) => ({
      name,
      keyPath: 'id',
      autoIncrement: false,
      current: 1,
      indexes: [],
    });
    assert.equal(idb.stamp(ORIGIN, 'db'), 0);
    assert.equal(
      idb.commit(ORIGIN, 'db', {
        version: 1,
        stores: [store('notes'), store('drafts')],
        put: [
          ['notes', 'k1', 'v1'],
          ['drafts', 'k2', 'v2'],
        ],
        delete: [],
      }),
      1,
    );
    assert.equal(
      b.storage.indexedDB!.stamp(ORIGIN, 'db'),
      1,
      'another connection sees it',
    );
    assert.equal(
      idb.commit(ORIGIN, 'db', {
        version: 2,
        stores: [store('notes')],
        put: [['notes', 'k3', 'v3']],
        delete: [['notes', 'k1']],
      }),
      2,
    );
    const read = b.storage.indexedDB!.load(ORIGIN, 'db')!;
    assert.equal(read.version, 2);
    assert.equal(read.stamp, 2);
    assert.deepEqual(
      read.stores.map((s) => s.name),
      ['notes'],
    );
    assert.deepEqual(
      read.records,
      [['notes', 'k3', 'v3']],
      'the store gone took its records',
    );
    assert.deepEqual(b.storage.indexedDB!.list(ORIGIN), [
      { name: 'db', version: 2 },
    ]);
    assert.deepEqual(b.storage.indexedDB!.list('https://other.test'), []);
    b.storage.indexedDB!.delete(ORIGIN, 'db');
    assert.equal(idb.load(ORIGIN, 'db'), null);
    assert.equal(idb.stamp(ORIGIN, 'db'), 0);
  },
);

// --- through `<Html scripts>` ------------------------------------------------

interface Page {
  handle: HtmlHandle;
  text(id: string): string;
}

function textOf(node: { children?: unknown[]; data?: string } | null): string {
  if (!node) return '';
  if (typeof node.data === 'string') return node.data;
  return (node.children ?? []).map((n) => textOf(n as never)).join('');
}

/** Documents whose scripts run, side by side in one window, each with its
 *  address, its source and its seams. */
async function pages(
  ...docs: { url: string; source: string; scripts: HtmlScripts }[]
): Promise<Page[]> {
  const out: Page[] = [];
  function Doc({ index }: { index: number }) {
    const handle = useHtmlHandle();
    const doc = docs[index];
    out[index] = {
      handle,
      text: (id) => textOf(findById(handle.document, id) as never),
    };
    return h(Html, {
      source: doc.source,
      partial: false,
      ref: handle.ref,
      baseUrl: doc.url,
      scripts: doc.scripts,
    });
  }
  await renderX11(
    h(
      'box',
      { style: { width: 400, flexDirection: 'column' } },
      ...docs.map((_, i) => h(Doc, { key: i, index: i })),
    ),
    FONTS ? { width: 440, height: 400, fonts: FONTS } : { backend: 'mock' },
  );
  return out;
}

/** The text of `id` once `done` holds of it, or as it is after a while. */
async function until(
  page: Page,
  id: string,
  done: (text: string) => boolean,
  ms = 3000,
): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    await act(() => new Promise((r) => setTimeout(r, 20)));
    const text = page.text(id);
    if (done(text) || Date.now() > deadline) return text;
  }
}

scripted(
  'document.cookie is the jar’s, but its HttpOnly cookies; cookieStore reads and writes it',
  async () => {
    const jar = new CookieJar();
    const url = `${ORIGIN}/app/page.html`;
    jar.store(url, ['sid=secret; Path=/; HttpOnly', 'theme=dark; Path=/'], {
      http: true,
      sameSite: true,
      topLevel: true,
    });
    const [page] = await pages({
      url,
      scripts: { cookies: jar },
      source:
        '<p id="out"></p><script>' +
        'var r = [navigator.cookieEnabled, document.cookie];' +
        "document.cookie = 'mine=1; Path=/';" +
        "document.cookie = 'sid=forged; Path=/';" +
        'r.push(document.cookie, typeof cookieStore);' +
        "cookieStore.set('store', 'v').then(function () { return cookieStore.get('store'); })" +
        '.then(function (c) { r.push(c.name + "=" + c.value + " " + c.sameSite + " " + c.path);' +
        "  return cookieStore.getAll(); }).then(function (all) { r.push(all.map(function (c) { return c.name; }).join(',')); " +
        "  return cookieStore.delete('store'); }).then(function () { r.push(document.cookie);" +
        "  document.getElementById('out').textContent = r.join(' | '); });" +
        '</script>',
    });
    const text = await until(page, 'out', (t) => t.length > 0);
    assert.equal(
      text,
      'true | theme=dark | theme=dark; mine=1 | object | store=v strict / | theme,mine,store | theme=dark; mine=1',
    );
    assert.equal(
      jar.header(url, { http: true, sameSite: true }),
      'sid=secret; theme=dark; mine=1',
      "the page's cookie goes on the next request, and the HttpOnly one stays",
    );
  },
);

scripted('with no jar a document has no cookies, as before', async () => {
  const [page] = await pages({
    url: `${ORIGIN}/`,
    scripts: {},
    source:
      '<p id="out"></p><script>document.cookie = "a=1";' +
      "document.getElementById('out').textContent = navigator.cookieEnabled + ' [' + document.cookie + ']';" +
      '</script>',
  });
  assert.equal(await until(page, 'out', (t) => t.length > 0), 'false []');
});

scripted(
  'a document hears the storage changes of another of its origin, and not its own',
  async () => {
    const storage = memoryStorage();
    const [writer, reader, other] = await pages(
      {
        url: `${ORIGIN}/writer.html`,
        scripts: { storage },
        source:
          '<p id="out"></p><script>' +
          "addEventListener('storage', function () { document.getElementById('out').textContent = 'heard my own'; });" +
          "setTimeout(function () { localStorage.setItem('k', 'v'); localStorage.setItem('k', 'v'); localStorage.removeItem('none');" +
          " sessionStorage.setItem('s', '1'); }, 50);" +
          '</script>',
      },
      {
        url: `${ORIGIN}/reader.html`,
        scripts: { storage },
        source:
          '<p id="out"></p><script>var r = [];' +
          "addEventListener('storage', function (e) { r.push([e.key, e.oldValue, e.newValue, e.url.split('/').pop(), e.storageArea === (e.key === 's' ? sessionStorage : localStorage), e instanceof StorageEvent].join(','));" +
          " document.getElementById('out').textContent = r.join(' | '); });" +
          '</script>',
      },
      {
        url: 'https://other.test/',
        scripts: { storage },
        source:
          '<p id="out"></p><script>' +
          "addEventListener('storage', function () { document.getElementById('out').textContent = 'heard another origin'; });" +
          '</script>',
      },
    );
    const text = await until(reader, 'out', (t) => t.split(' | ').length >= 2);
    assert.equal(
      text,
      'k,,v,writer.html,true,true | s,,1,writer.html,true,true',
      'once for the set that changed something, and once for the session',
    );
    await act(() => new Promise((r) => setTimeout(r, 100)));
    assert.equal(writer.text('out'), '');
    assert.equal(other.text('out'), '');
  },
);

scripted('setItem past the quota throws QuotaExceededError', async () => {
  const [page] = await pages({
    url: `${ORIGIN}/`,
    scripts: { storage: memoryStorage() },
    source:
      '<p id="out"></p><script>var name;' +
      "try { localStorage.setItem('big', 'x'.repeat(6 * 1024 * 1024)); } catch (e) { name = e.name; }" +
      "document.getElementById('out').textContent = name + ' ' + localStorage.length;" +
      '</script>',
  });
  assert.equal(
    await until(page, 'out', (t) => t.length > 0),
    'QuotaExceededError 0',
  );
});

both(
  'IndexedDB kept in a profile is there for the next document, and another tab’s commits are read',
  async (t) => {
    const dir = profileDir(t);
    const first = (await HtmlProfile.open(dir))!;
    t.after(() => first.close());
    const url = `${ORIGIN}/notes.html`;
    const [writer] = await pages({
      url,
      scripts: { storage: first.storage },
      source:
        '<p id="out"></p><script>' +
        "var open = indexedDB.open('notes', 1);" +
        "open.onupgradeneeded = function () { var s = open.result.createObjectStore('notes', { keyPath: 'id' }); s.createIndex('by', 'tag');" +
        "  open.result.createObjectStore('counter', { autoIncrement: true }); };" +
        'open.onsuccess = function () { var db = open.result;' +
        "  var tx = db.transaction(['notes', 'counter'], 'readwrite');" +
        "  tx.objectStore('notes').put({ id: 1, tag: 'a', text: 'one', at: new Date(0), bytes: new Uint8Array([1, 2]) });" +
        "  tx.objectStore('notes').put({ id: [2, 'x'], tag: 'b', text: 'two' });" +
        "  tx.objectStore('counter').add('first');" +
        '  tx.oncomplete = function () {' +
        "    var tx2 = db.transaction('notes', 'readwrite'); tx2.objectStore('notes').delete(1); tx2.objectStore('notes').put({ id: 3, tag: 'a', text: 'three' });" +
        "    tx2.oncomplete = function () { document.getElementById('out').textContent = 'written'; }; }; };" +
        '</script>',
    });
    assert.equal(await until(writer, 'out', (t) => t.length > 0), 'written');
    cleanup();

    // a restart: another connection, another document, a new realm
    const second = (await HtmlProfile.open(dir))!;
    t.after(() => second.close());
    const [reader] = await pages({
      url,
      scripts: { storage: second.storage },
      source:
        '<p id="out"></p><p id="count"></p><script>' +
        "var open = indexedDB.open('notes');" +
        'open.onsuccess = function () { var db = open.result;' +
        "  var tx = db.transaction(['notes', 'counter']); var r = [db.version, Array.from(db.objectStoreNames).join(',')];" +
        "  tx.objectStore('notes').getAll().onsuccess = function (e) { r.push(e.target.result.map(function (n) { return JSON.stringify(n.id) + ':' + n.text; }).join(',')); };" +
        "  tx.objectStore('notes').index('by').getAllKeys('a').onsuccess = function (e) { r.push(JSON.stringify(e.target.result)); };" +
        "  tx.objectStore('counter').getAllKeys().onsuccess = function (e) { r.push(JSON.stringify(e.target.result)); };" +
        "  tx.oncomplete = function () { indexedDB.databases().then(function (all) { r.push(all.map(function (d) { return d.name + d.version; }).join(','));" +
        "    document.getElementById('out').textContent = r.join(' | '); }); };" +
        // a transaction now and then, as a page that keeps a database open
        '  setInterval(function () {' +
        "    db.transaction('notes').objectStore('notes').count().onsuccess = function (c) {" +
        "      document.getElementById('count').textContent = 'count ' + c.target.result; }; }, 30); };" +
        '</script>',
    });
    assert.equal(
      await until(reader, 'out', (t) => t.length > 0),
      '1 | counter,notes | 3:three,[2,"x"]:two | [3] | [1] | notes1',
    );
    assert.equal(await until(reader, 'count', (t) => t.length > 0), 'count 2');
    // another tab commits: the reader's next transaction, in the document
    // it has open, reads it
    const other = (await HtmlProfile.open(dir))!;
    t.after(() => other.close());
    const snapshot = other.storage.indexedDB!.load(ORIGIN, 'notes')!;
    other.storage.indexedDB!.commit(ORIGIN, 'notes', {
      version: snapshot.version,
      stores: snapshot.stores,
      put: [],
      delete: [['notes', '["n",3]']],
    });
    assert.equal(
      await until(reader, 'count', (t) => t === 'count 1'),
      'count 1',
    );
  },
);
