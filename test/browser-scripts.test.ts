// The browser example's script engine (examples/browser/script/): a page's
// scripts run in a `node:vm` context over `<Html>`'s DOM, and nothing of
// the host's is reachable from them. docs/prd-html-scripts.md is the
// design; these run it against an `<Html>` in the in-process X server, with
// a network and a pane that are stand-ins.
import { spawnSync } from 'node:child_process';
import { afterEach, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  cleanup,
  fireEvent,
  renderX11,
  screen,
  userEvent,
} from 'react-x11/test';
import { ThemeProvider } from 'react-x11';
import type { DrawnNode } from 'react-x11';

import { Html, shadowRootOf, useHtmlHandle } from '../src/html/index.js';
import type {
  FormSubmission,
  HtmlHandle,
  HtmlViewNode,
  ResourceRequest,
  ResourceResult,
} from '../src/html/index.js';
import type { Element as DocElement } from '../src/html/dom.js';
import { useScripts } from '../examples/browser/script/index.js';
import {
  SCRIPTS_CONTAINED,
  ScriptEngine,
} from '../examples/browser/script/engine.js';
import { DomHost } from '../examples/browser/script/host.js';
import { HtmlSource } from '../src/html/dom.js';
import type { ScriptsOptions } from '../examples/browser/script/index.js';
import { linkTarget, navigableFor } from '../examples/browser/target.js';
import type {
  FetchRequest,
  FetchResponse,
} from '../examples/browser/script/host.js';
import { FONTS, findById, h, metric as fontMetric } from './html/harness.js';

afterEach(cleanup);

/** Tests that run a page's scripts, skipped where this runtime runs none:
 *  Node 21 to 23 hand a page's `import()` a promise of the host's realm, so
 *  no engine is made there (`SCRIPTS_CONTAINED`). */
const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;
const metric = SCRIPTS_CONTAINED ? fontMetric : nodeTest.skip;

const PAGE = 'https://example.test/dir/page.html';

interface Hosted {
  handle: HtmlHandle;
  view: HtmlViewNode;
  logs: string[];
  links: string[];
  submitted: FormSubmission[];
  timeouts: number;
  fetched: FetchRequest[];
  byId(id: string): DocElement;
  text(id: string): string;
  /** The pane the page is in scrolled, as the browser's tells it. */
  scrolled(): void;
}

/** A page whose scripts run, with stand-ins for the network and the pane:
 *  `scripts` answers a script's URL, `answer` a `fetch`, `sheets` a
 *  stylesheet's, by its file's name, or `held` when the test lets it go;
 *  `scheme` is the palette's. */
async function hosted(
  source: string,
  options: {
    scripts?: Record<string, string>;
    answer?: (request: FetchRequest) => FetchResponse | null;
    sheets?: Record<string, string>;
    held?: HeldSheets;
    scheme?: 'light' | 'dark';
  } = {},
): Promise<Hosted> {
  const out = {
    logs: [] as string[],
    links: [] as string[],
    submitted: [] as FormSubmission[],
    timeouts: 0,
    fetched: [] as FetchRequest[],
  } as Hosted;
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
    navigate: (url) => void out.links.push(url),
    reload: () => {},
    go: () => {},
    log: (level, text) => void out.logs.push(`${level}: ${text}`),
    title: () => {},
    fetch: async (request) => {
      out.fetched.push(request);
      const response = options.answer?.(request);
      if (!response) throw new Error('no answer');
      return response;
    },
    load: async (url) => options.scripts?.[url] ?? null,
    onTimeout: () => {
      out.timeouts += 1;
    },
  };
  function Page() {
    const handle = useHtmlHandle();
    out.handle = handle;
    const scripts = useScripts(true, handle, PAGE, seams);
    out.scrolled = () => scripts.scrolled?.();
    return h(Html, {
      source,
      partial: false,
      ref: handle.ref,
      baseUrl: PAGE,
      onLink: (href: string) => void out.links.push(href),
      // where the page sends it: a frame its target names, or the tab
      onSubmit: (s: FormSubmission) => {
        const to = navigableFor(handle.document, s.target);
        if (typeof to === 'string') out.submitted.push(s);
        else {
          scripts.navigateFrame?.(
            to,
            s.url,
            s.body === null
              ? null
              : { body: s.body, contentType: s.contentType ?? '' },
          );
        }
      },
      onResource: ({ url, kind }: ResourceRequest) => {
        if (options.held && kind === 'stylesheet') {
          return options.held.ask(url.slice(url.lastIndexOf('/') + 1));
        }
        const text = options.sheets?.[url.slice(url.lastIndexOf('/') + 1)];
        // a moment later, as over a network
        return kind === 'stylesheet' && text !== undefined
          ? new Promise<ResourceResult>((ok) =>
              setTimeout(() => ok({ kind, text }), 5),
            )
          : null;
      },
      'data-testname': 'doc',
      ...scripts,
    });
  }
  await renderX11(
    h(
      ThemeProvider,
      { colorScheme: options.scheme ?? 'light' } as Record<string, unknown>,
      h('box', { style: { width: 400, flexDirection: 'column' } }, h(Page)),
    ),
    FONTS ? { width: 440, height: 400, fonts: FONTS } : { backend: 'mock' },
  );
  await settle();
  const root = screen.getByTestName('doc') as unknown as {
    children: HtmlViewNode[];
  };
  out.view = root.children[0];
  out.byId = (id) => findById(out.handle.document, id) as DocElement;
  out.text = (id) => {
    const el = out.byId(id);
    return el ? textOf(el) : '';
  };
  return out;
}

/** Stylesheets answered when a test says, by their files' names: with a
 *  text, or null for one not to be had. */
class HeldSheets {
  private _answers = new Map<string, (r: ResourceResult | null) => void>();
  ask(name: string): Promise<ResourceResult | null> {
    return new Promise((ok) => this._answers.set(name, ok));
  }
  async answer(name: string, text: string | null): Promise<void> {
    const ok = this._answers.get(name);
    assert.ok(ok, `${name} was asked for`);
    await act(async () =>
      ok(text === null ? null : { kind: 'stylesheet', text }),
    );
    await settle();
  }
}

function textOf(node: { children?: unknown[]; data?: string }): string {
  if (typeof node.data === 'string') return node.data;
  return (node.children ?? []).map((n) => textOf(n as never)).join('');
}

/** Let the scripts' turns run: the parse's microtask, a script's source,
 *  timers at no delay, and the render after. */
async function settle(ms = 20) {
  for (let i = 0; i < 4; i += 1) {
    await act(() => new Promise((r) => setTimeout(r, ms / 4)));
  }
}

/** Let the scripts' turns run until `done` holds of what the page shows,
 *  for what finishes after an `import()`, a fetch or a timer, however long
 *  the machine takes; and the text either way. */
async function settled(
  doc: Hosted,
  id: string,
  done: (text: string) => boolean,
  ms = 3000,
): Promise<string> {
  const end = Date.now() + ms;
  while (!done(doc.text(id)) && Date.now() < end) await settle(20);
  return doc.text(id);
}

test('nothing of the host is reachable from a page', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = [];' +
      "r.push(this.constructor.constructor('return typeof process')());" +
      "r.push(document.constructor.constructor('return typeof process')());" +
      "try { document.querySelector('[[[') } catch (e) {" +
      "  r.push(e.name, e.constructor.constructor('return typeof process')()) }" +
      'try { Error.prepareStackTrace = function (e, s) { return s.map(function (c) { return typeof c.getFunction() }) } } catch (e) {}' +
      'r.push(String(Error.prepareStackTrace));' +
      'r.push(typeof __bridge, typeof require, typeof Buffer);' +
      "document.body.addEventListener('x', function f() { r.push(String(f.caller)) });" +
      "document.body.dispatchEvent(new Event('x'));" +
      "document.getElementById('out').textContent = r.join(',');" +
      // what an `import()` is refused with is the page's own error, from
      // wherever it is called: it was the host's, and reached `process`
      'var reached = [];' +
      'function refused(how) { return function (e) {' +
      "  reached.push(how + ':' + (e instanceof TypeError) + ':' + e.constructor.constructor('return typeof process')());" +
      "  document.getElementById('reached').textContent = reached.sort().join(','); } }" +
      "import('fs').then(function () { reached.push('imported') }, refused('script'));" +
      "(0, eval)(\"import('fs').catch(refused('eval'))\");" +
      "new Function(\"return import('fs')\")().catch(refused('function'));" +
      "setTimeout(\"import('fs').catch(refused('timer'))\", 0);" +
      "document.getElementById('b').click();" +
      '</script><p id="reached"></p>' +
      '<button id="b" onclick="import(\'fs\').catch(refused(\'attribute\'))">b</button>',
  );
  await settle(60);
  assert.equal(
    doc.text('out'),
    [
      'undefined',
      'undefined',
      'SyntaxError',
      'undefined',
      'undefined',
      'undefined',
      'undefined',
      'undefined',
      'null',
    ].join(','),
  );
  assert.equal(
    doc.text('reached'),
    [
      'attribute:true:undefined',
      'eval:true:undefined',
      'function:true:undefined',
      'script:true:undefined',
      'timer:true:undefined',
    ].join(','),
  );
});

nodeTest(
  'where a page’s import() would reach the host, no engine is made',
  () => {
    // Node without --experimental-vm-modules ignores the callback that keeps
    // an `import()` in the page, and refuses one with an error of its own
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        "import { SCRIPTS_CONTAINED, ScriptEngine } from './examples/browser/script/engine.ts';" +
          'let made = true;' +
          'try { new ScriptEngine(() => null, { timeout: 1, onTimeout() {}, log() {}, settled() {} }); }' +
          'catch { made = false; }' +
          'console.log(JSON.stringify({ contained: SCRIPTS_CONTAINED, made }));',
      ],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').at(-1)!), {
      contained: false,
      made: false,
    });
  },
);

for (const global of ['own', 'object'] as const) {
  test(`nothing of the host is reachable over either kind of global: ${global}`, async () => {
    // The engine takes the context's own global where the runtime keeps a
    // script's `var`s in it, Node's, and one over an object with no
    // prototype where it does not, Bun's: the escapes are asked of both,
    // and of the facade over each, whichever this runs on.
    const source = new HtmlSource();
    source.setSource('<html><body><p id="out"></p></body></html>', true);
    const logs: string[] = [];
    const host = new DomHost(
      source.document,
      {
        handle: { refresh() {}, base: null } as unknown as HtmlHandle,
        userAgent: 'test',
        language: 'en-US',
        viewport: () => ({
          width: 1,
          height: 1,
          scrollX: 0,
          scrollY: 0,
          zoom: 1,
          dpr: 1,
          left: 0,
          top: 0,
        }),
        scrollTo() {},
        navigate() {},
        reload() {},
        go() {},
        log: (level, text) => void logs.push(`${level}: ${text}`),
        title() {},
        fetch: () => Promise.reject(new Error('none')),
      },
      'https://example.test/',
    );
    const engine = new ScriptEngine(host.bridge, {
      timeout: 1000,
      onTimeout() {},
      log: (level, text) => void logs.push(`engine ${level}: ${text}`),
      settled() {},
      global,
    });
    host.entries = engine;
    engine.exec(
      'var r = [];' +
        "var reach = 'return typeof process + typeof Bun + typeof require';" +
        'r.push(this.constructor.constructor(reach)());' +
        'r.push(document.constructor.constructor(reach)());' +
        'r.push(Object.getPrototypeOf(globalThis).constructor.constructor(reach)());' +
        "try { document.querySelector('[[[') } catch (e) { r.push(e.constructor.constructor(reach)()) }" +
        'try { Error.prepareStackTrace = function () { return 1 } } catch (e) {}' +
        'r.push(String(Error.prepareStackTrace), typeof __bridge, typeof globalThis.__in);' +
        "document.body.addEventListener('x', function f() { r.push(String(f.caller)) });" +
        "document.body.dispatchEvent(new Event('x'));" +
        // and what it hands the page before it is refused: a promise of the
        // host's realm on Node 21 to 23, where no engine is made
        "var made = import('fs'); r.push(made.constructor.constructor(reach)());" +
        'made.catch(function (e) { r.push(e.constructor.constructor(reach)()) });' +
        'var shared = 1;',
      'a',
      0,
    );
    // what the host's refusal settles runs at the next entry
    await new Promise((resolve) => setTimeout(resolve, 5));
    engine.call('__drain', null);
    engine.exec("console.log(r.join(','), typeof shared)", 'b', 0);
    assert.deepEqual(logs, [
      'log: undefinedundefinedundefined,undefinedundefinedundefined,' +
        'undefinedundefinedundefined,undefinedundefinedundefined,' +
        'undefined,undefined,string,null,undefinedundefinedundefined,' +
        'undefinedundefinedundefined number',
    ]);
    engine.dispose();
  });
}

test("a page's scripts run in order once it is parsed, and what they change is drawn", async () => {
  const doc = await hosted(
    '<h1 id="h">plain</h1><ul id="list"></ul>' +
      '<script src="a.js"></script>' +
      "<script>document.getElementById('h').textContent += ' then inline'; var shared = ' shared';</script>" +
      '<p id="state"></p>' +
      "<script>document.getElementById('state').textContent = document.readyState + shared;" +
      "document.addEventListener('DOMContentLoaded', function () { document.getElementById('state').textContent += ' ready'; });" +
      "window.addEventListener('load', function () { document.getElementById('state').textContent += ' loaded'; });</script>",
    {
      scripts: {
        'https://example.test/dir/a.js':
          "document.getElementById('h').textContent = 'from a.js';" +
          "for (var i = 0; i < 3; i++) { var li = document.createElement('li');" +
          " li.textContent = 'item ' + i; document.getElementById('list').appendChild(li); }",
      },
    },
  );
  assert.equal(doc.text('h'), 'from a.js then inline');
  assert.equal(doc.text('list'), 'item 0item 1item 2');
  // a `var` is the window's, as a classic script's is, which the next
  // script reads
  assert.equal(doc.text('state'), 'loading shared ready loaded');
  assert.ok(doc.view.textContent().includes('item 2'), 'drawn');
});

test('a script innerHTML puts in never runs, and one a script appends does', async () => {
  const doc = await hosted(
    '<html><body><p id="out">-</p><div id="box"></div><script>' +
      "document.getElementById('box').innerHTML = \"<script>document.getElementById('out').textContent = 'inner'</\" + \"script>\";" +
      "var s = document.createElement('script'); s.textContent = \"document.getElementById('out').textContent += 'appended'\";" +
      'document.body.appendChild(s);</script></body></html>',
  );
  await settle();
  assert.equal(doc.text('out'), '-appended');
});

test('a script that runs away is stopped, and the page goes on', async () => {
  const doc = await hosted(
    '<p id="out">-</p><script>for (;;) {}</script>' +
      "<script>document.getElementById('out').textContent = 'after';</script>",
  );
  assert.equal(doc.timeouts, 1);
  assert.equal(doc.text('out'), 'after');
});

test('a promise nothing catches is the page’s to report, not the process’s to die of', async () => {
  // node:test listens for unhandled rejections too, from before any engine
  // is made, and fails the test it hears one in: the page's never reaches it
  const doc = await hosted(
    "<script>Promise.reject(new Error('nobody catches this'));</script>",
  );
  await settle();
  assert.ok(doc.logs.some((l) => l.includes('Uncaught (in promise)')));
});

test('a listener there before the engine hears the host’s rejections and none of the page’s', () => {
  // core's pane listens before it loads the page's module, and ends the
  // process at the first rejection it hears: a page's reached it, and
  // closed the tab, where the engine's listener came after it
  const child = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--disable-warning=ExperimentalWarning',
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "import { ScriptEngine } from './examples/browser/script/engine.ts';" +
        'const heard = []; const logged = [];' +
        "process.on('unhandledRejection', (reason) => heard.push(reason.message));" +
        'const engine = new ScriptEngine(' +
        "  (op, level, text) => { if (op === 'log') logged.push(text.split('\\n')[0]); return null; }," +
        '  { timeout: 1000, onTimeout() {}, log() {}, settled() {} });' +
        "engine.exec(\"Promise.reject(new Error('page')); import('https://example.test/x.js')\", 'https://example.test/', 0);" +
        "Promise.reject(new Error('host'));" +
        'setTimeout(() => console.log(JSON.stringify({ heard, logged: logged.sort() })), 100);',
    ],
    { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').at(-1)!), {
    heard: ['host'],
    logged: [
      'Uncaught (in promise) Error: page',
      'Uncaught (in promise) TypeError: Failed to fetch module https://example.test/x.js',
    ],
  });
});

test('timers run, and a cleared one does not', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      "var out = document.getElementById('out');" +
      "setTimeout(function () { out.textContent += 'a'; }, 0);" +
      "var gone = setTimeout(function () { out.textContent += 'X'; }, 0); clearTimeout(gone);" +
      "var n = 0; var every = setInterval(function () { out.textContent += 'i'; if (++n === 2) clearInterval(every); }, 5);" +
      "requestAnimationFrame(function (t) { out.textContent += typeof t === 'number' ? 'r' : '?'; });" +
      "queueMicrotask(function () { out.textContent += 'm'; });" +
      '</script>',
  );
  await settle(120);
  const text = doc.text('out');
  assert.ok(text.startsWith('m'), `microtask first: ${text}`);
  assert.equal([...text].filter((c) => c === 'i').length, 2);
  assert.ok(
    text.includes('a') && text.includes('r') && !text.includes('X'),
    text,
  );
});

test('fetch is the page’s own origin’s, and answers as the network does', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      "fetch('data.json', { method: 'POST', body: 'q=1', headers: { 'X-Test': 'yes', Cookie: 'no' } })" +
      ".then(function (r) { return r.json().then(function (j) { document.getElementById('out').textContent = r.status + ' ' + j.ok + ' ' + r.type + ' ' + r.headers.get('set-cookie'); }); });" +
      '</script>',
    {
      answer: (request) =>
        request.url === 'https://example.test/dir/data.json'
          ? {
              url: request.url,
              status: 200,
              statusText: 'OK',
              redirected: false,
              headers: [
                ['content-type', 'application/json'],
                ['set-cookie', 'a=1'],
              ],
              body: '{"ok":"yes"}',
            }
          : null,
    },
  );
  await settle(60);
  assert.equal(doc.text('out'), '200 yes basic null');
  assert.deepEqual(
    doc.fetched.map((r) => [r.method, r.url, r.body, r.headers]),
    [
      [
        'POST',
        'https://example.test/dir/data.json',
        'q=1',
        // a page sets no cookie of its own
        [['x-test', 'yes']],
      ],
    ],
  );
});

test('another origin answers a page where CORS lets it: simple requests, preflights, credentials and the modes', async () => {
  const answers: Record<string, (r: FetchRequest) => [string, string][]> = {
    // ekazinich.com's chat: JSON posted to the site's API, which allows it
    'OPTIONS /chat': () => [
      ['access-control-allow-origin', 'https://example.test'],
      ['access-control-allow-methods', 'POST, OPTIONS'],
      ['access-control-allow-headers', 'Content-Type, X-Key'],
      ['access-control-max-age', '600'],
    ],
    'POST /chat': () => [
      ['access-control-allow-origin', 'https://example.test'],
      ['content-type', 'application/json'],
      ['x-hidden', 'h'],
      ['x-shown', 's'],
      ['access-control-expose-headers', 'X-Shown'],
    ],
    'GET /open': () => [['access-control-allow-origin', '*']],
    'GET /closed': () => [],
    'GET /creds': () => [
      ['access-control-allow-origin', 'https://example.test'],
      ['access-control-allow-credentials', 'true'],
    ],
    'OPTIONS /put': () => [
      ['access-control-allow-origin', '*'],
      ['access-control-allow-methods', 'GET'],
    ],
  };
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = [];' +
      'function step(p, name) { return p.then(function (x) { r.push(name + " " + x); }, function (e) { r.push(name + " " + e.name); }); }' +
      'var api = "https://api.example.test";' +
      // the AI SDK names itself in a User-Agent, which Chrome drops
      'step(fetch(api + "/chat", { method: "POST", headers: { "Content-Type": "application/json", "X-Key": "k", "User-Agent": "ai-sdk/5" }, body: "{}" })' +
      '  .then(function (res) { return res.type + ":" + res.headers.get("x-shown") + ":" + res.headers.get("x-hidden") + ":" + res.headers.get("content-type"); }), "chat")' +
      '.then(function () { return step(fetch(api + "/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(function (res) { return res.status; }), "again"); })' +
      '.then(function () { return step(fetch(api + "/open").then(function (res) { return res.type; }), "open"); })' +
      '.then(function () { return step(fetch(api + "/closed"), "closed"); })' +
      '.then(function () { return step(fetch(api + "/open", { credentials: "include" }), "wildcard"); })' +
      '.then(function () { return step(fetch(api + "/creds", { credentials: "include" }).then(function (res) { return res.status; }), "creds"); })' +
      '.then(function () { return step(fetch(api + "/put", { method: "PUT" }), "put"); })' +
      '.then(function () { return step(fetch(api + "/closed", { mode: "no-cors" }).then(function (res) { return res.type + res.status; }), "nocors"); })' +
      '.then(function () { return step(fetch(api + "/open", { mode: "same-origin" }), "same"); })' +
      '.then(function () { var x = new XMLHttpRequest(); x.open("GET", api + "/creds"); x.withCredentials = true;' +
      '  return new Promise(function (done) { x.onload = function () { r.push("xhr " + x.status); done(); }; x.send(); }); })' +
      ".then(function () { document.getElementById('out').textContent = r.join('|'); });" +
      '</script>',
    {
      answer: (request) => {
        const url = new URL(request.url);
        const make = answers[`${request.method} ${url.pathname}`];
        if (!make) return null;
        return {
          url: request.url,
          status: request.method === 'OPTIONS' ? 204 : 200,
          statusText: 'OK',
          redirected: false,
          headers: make(request),
          body: request.method === 'OPTIONS' ? '' : '{}',
        };
      },
    },
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(
    text,
    [
      'chat cors:s:null:application/json',
      'again 200',
      'open cors',
      'closed TypeError',
      'wildcard TypeError',
      'creds 200',
      'put TypeError',
      'nocors opaque0',
      'same TypeError',
      'xhr 200',
    ].join('|'),
  );
  // one preflight, remembered for the second post; the simple requests
  // were sent, and only their answers withheld
  assert.deepEqual(
    doc.fetched.map((r) => `${r.method} ${new URL(r.url).pathname}`),
    [
      'OPTIONS /chat',
      'POST /chat',
      'POST /chat',
      'GET /open',
      'GET /closed',
      'GET /open',
      'GET /creds',
      'OPTIONS /put',
      'GET /closed',
      'GET /creds',
    ],
  );
  const preflight = doc.fetched[0];
  assert.deepEqual(preflight.headers, [
    ['access-control-request-method', 'POST'],
    ['access-control-request-headers', 'content-type,x-key'],
  ]);
  assert.ok(
    doc.logs.some((l) =>
      l.includes(
        "Access to fetch at 'https://api.example.test/closed' from origin 'https://example.test' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header",
      ),
    ),
    doc.logs.join('\n'),
  );
});

test('a MutationObserver is handed what changed, after the script, in order', async () => {
  const doc = await hosted(
    '<div id="root"><p id="a" class="x">a</p></div><p id="out"></p><script>' +
      "var log = []; var root = document.getElementById('root');" +
      'var seen = new MutationObserver(function (records, observer) {' +
      '  records.forEach(function (r) {' +
      '    log.push([r.type, r.target.id || r.target.nodeName, r.attributeName, r.oldValue,' +
      '      r.addedNodes.length, r.removedNodes.length,' +
      "      r.previousSibling ? (r.previousSibling.id || r.previousSibling.nodeName) : '-'].join(':'));" +
      '  });' +
      "  log.push(observer === seen ? 'same' : 'other');" +
      '});' +
      'seen.observe(root, { childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });' +
      "var a = document.getElementById('a');" +
      "a.className = 'y';" +
      "var b = document.createElement('p'); b.id = 'b'; root.appendChild(b);" +
      "a.firstChild.data = 'changed';" +
      'root.removeChild(a);' +
      "log.push('script end');" +
      "Promise.resolve().then(function () { document.getElementById('out').textContent = log.join(' | '); });" +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    [
      'script end',
      // made outside and so unobserved, `b.id` is no record
      'attributes:a:class:x:0:0:-',
      'childList:root:::1:0:a',
      'characterData:#text::a:0:0:-',
      'childList:root:::0:1:-',
      'same',
    ].join(' | '),
  );
});

test("an observer's filter, takeRecords and disconnect, and a change its callback makes", async () => {
  const doc = await hosted(
    '<div id="t" title="t"></div><p id="out"></p><script>' +
      "var t = document.getElementById('t'); var log = [];" +
      'var filtered = new MutationObserver(function (records) {' +
      "  records.forEach(function (r) { log.push('f:' + r.attributeName + ':' + r.oldValue); });" +
      "  if (!t.hasAttribute('data-again')) t.setAttribute('data-again', '1');" +
      '});' +
      "filtered.observe(t, { attributeFilter: ['title', 'data-again'] });" +
      "t.setAttribute('title', 'u'); t.setAttribute('lang', 'en');" +
      'var taken = new MutationObserver(function () { log.push("taken called"); });' +
      'taken.observe(t, { attributes: true });' +
      "t.setAttribute('dir', 'rtl');" +
      "log.push('took ' + taken.takeRecords().map(function (r) { return r.attributeName; }).join(','));" +
      'var gone = new MutationObserver(function () { log.push("gone called"); });' +
      'gone.observe(t, { childList: true }); gone.disconnect();' +
      "t.appendChild(document.createElement('i'));" +
      "setTimeout(function () { document.getElementById('out').textContent = log.join(' '); }, 0);" +
      'try { new MutationObserver(function () {}).observe(t, {}); } catch (e) { log.push(e.name); }' +
      '</script>',
  );
  await settle(60);
  assert.equal(
    doc.text('out'),
    // `taken` made after the lang was set, and its records taken; `{}`
    // asks for nothing; the filter's: the title, and not the lang or the
    // dir; the change its callback made a second round, which `taken`
    // hears; and `gone` nothing
    'took dir TypeError f:title:null f:data-again:null taken called',
  );
});

metric(
  "what a page's scripts change is told to <Html> as records, once a task",
  async () => {
    const doc = await hosted(
      '<div id="box" class="a"><span id="s">s</span></div>' +
        '<input type="button" id="go" value="go"><script>' +
        "document.getElementById('go').addEventListener('click', function () {" +
        "  var box = document.getElementById('box'); box.classList.add('b');" +
        "  box.appendChild(document.createElement('em'));" +
        "  document.getElementById('s').firstChild.data = 't';" +
        '});</script>',
    );
    const told: unknown[] = [];
    const refresh = doc.handle.refresh;
    doc.handle.refresh = (changes) => {
      told.push(changes);
      refresh(changes);
    };
    await userEvent.click(screen.getByRole('button') as DrawnNode);
    await settle();
    assert.equal(told.length, 1, 'one refresh for the task');
    const changes = told[0] as {
      type: string;
      target: DocElement;
      attributeName?: string;
      oldValue?: string | null;
      addedNodes?: { name?: string }[];
    }[];
    assert.deepEqual(
      changes.map((c) => [
        c.type,
        c.target.attribs?.id ?? c.target.type,
        c.attributeName ?? null,
        c.oldValue ?? null,
        c.addedNodes?.map((n) => n.name) ?? null,
      ]),
      [
        ['attributes', 'box', 'class', 'a', null],
        ['childList', 'box', null, null, ['em']],
        ['characterData', 'text', null, null, null],
      ],
    );
    assert.equal(doc.byId('box').attribs.class, 'a b');
  },
);

test('XMLHttpRequest is fetch with its states, its events and its headers', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      "var log = []; var done = function () { document.getElementById('out').textContent = log.join(' '); };" +
      'var x = new XMLHttpRequest();' +
      "x.onreadystatechange = function () { log.push('rs' + x.readyState); };" +
      "x.addEventListener('loadstart', function () { log.push('start'); });" +
      "x.onload = function (e) { log.push('load:' + x.status + ':' + x.response.ok + ':' + x.getResponseHeader('Content-Type') + ':' + e.loaded); };" +
      "x.onloadend = function () { log.push('end'); posted(); };" +
      "x.open('GET', 'data.json'); x.responseType = 'json'; x.send();" +
      'function posted() {' +
      '  var p = new XMLHttpRequest();' +
      "  p.open('POST', 'data.json'); p.setRequestHeader('X-Test', 'yes');" +
      "  p.onload = function () { log.push('post:' + p.responseText.length); aborted(); };" +
      "  p.send('q=1');" +
      '}' +
      'function aborted() {' +
      '  var a = new XMLHttpRequest();' +
      "  a.open('GET', 'data.json');" +
      "  a.onabort = function () { log.push('abort:' + a.readyState + ':' + a.status); };" +
      "  a.onload = function () { log.push('never'); };" +
      '  a.send(); a.abort();' +
      "  log.push('after:' + a.readyState);" +
      "  try { a.open('GET', 'data.json', false); } catch (e) { log.push(e.name); }" +
      '  setTimeout(done, 20);' +
      '}' +
      '</script>',
    {
      answer: (request) => ({
        url: request.url,
        status: 200,
        statusText: 'OK',
        redirected: false,
        headers: [['content-type', 'application/json']],
        body: '{"ok":"yes"}',
      }),
    },
  );
  await settle(120);
  assert.equal(
    doc.text('out'),
    'rs1 start rs2 rs3 rs4 load:200:yes:application/json:12 end ' +
      'post:12 abort:4:0 after:0 InvalidAccessError',
  );
  assert.deepEqual(
    doc.fetched.slice(0, 2).map((r) => [r.method, r.body, r.headers]),
    [
      ['GET', null, []],
      ['POST', 'q=1', [['x-test', 'yes']]],
    ],
  );
});

test('module scripts run in order with the classic ones, their imports linked, and a nomodule script does not', async () => {
  const doc = await hosted(
    '<p id="out"></p>' +
      "<script>var order = ['classic'];</script>" +
      '<script type="module">' +
      "import { twice, seen } from './lib/twice.js';" +
      "import shout from './lib/shout.js';" +
      "order.push('inline ' + twice(2) + ' ' + shout('a') + ' ' + seen() + ' ' + import.meta.url);" +
      '</script>' +
      "<script nomodule>order.push('nomodule');</script>" +
      '<script type="module" src="lib/main.js"></script>' +
      // told by main.js once its `import()` is in: a top-level `await`
      // goes on past `load`, as a browser's does
      "<script>function report() { document.getElementById('out').textContent = order.join(' | '); }</script>",
    {
      scripts: {
        'https://example.test/dir/lib/twice.js':
          'var count = 0; export function twice(n) { return n * 2; } export function seen() { return ++count; }',
        'https://example.test/dir/lib/shout.js':
          "import { twice } from './twice.js'; export default function (s) { return s.toUpperCase() + twice(1); }",
        'https://example.test/dir/lib/main.js':
          "import { seen } from './twice.js'; order.push('main ' + seen() + ' ' + import.meta.url);" +
          // what a static import linked and evaluated, imported again
          "const again = await import('./twice.js'); order.push('again ' + again.seen()); report();",
      },
    },
  );
  await settled(doc, 'out', (text) => text.includes('again'));
  assert.equal(
    doc.text('out'),
    [
      'classic',
      // one twice.js for both, whichever imported it
      'inline 4 A2 1 https://example.test/dir/page.html',
      'main 2 https://example.test/dir/lib/main.js',
      'again 3',
    ].join(' | '),
    doc.logs.join('\n'),
  );
});

test('import() is the page’s, from a classic script and a module, and fails as the page’s own error', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var log = []; var done = function () { document.getElementById("out").textContent = log.join(" | "); };' +
      "import('./lib/value.js').then(function (m) { log.push('classic ' + m.value); });" +
      "import('lodash').catch(function (e) {" +
      "  log.push(e.name + ' ' + (e instanceof TypeError) + ' ' + e.constructor.constructor('return typeof process')());" +
      '});' +
      "import('./lib/missing.js').catch(function (e) { log.push('missing ' + (e instanceof TypeError)); });" +
      '</script><script type="module">' +
      "const m = await import('./lib/value.js'); log.push('module ' + m.value);" +
      'setTimeout(done, 20);' +
      '</script>',
    {
      scripts: {
        'https://example.test/dir/lib/value.js': 'export const value = 7;',
      },
    },
  );
  await settle(120);
  const out = doc.text('out').split(' | ').sort();
  assert.deepEqual(out, [
    'TypeError true undefined',
    'classic 7',
    'missing true',
    'module 7',
  ]);
});

test('an import map names the modules a page imports by name, by prefix and by scope', async () => {
  const doc = await hosted(
    '<p id="out"></p>' +
      '<script type="importmap">' +
      JSON.stringify({
        imports: {
          react: './vendor/react.js',
          'lib/': './lib/',
        },
        scopes: {
          './lib/old/': { react: './vendor/react-old.js' },
        },
      }) +
      '</script>' +
      '<script type="module">' +
      "import React from 'react';" +
      "import { twice } from 'lib/twice.js';" +
      "import { version } from 'lib/old/uses.js';" +
      "const missing = await import('nowhere').then(() => 'found', (e) => e.name);" +
      "document.getElementById('out').textContent = [React, twice(2), version, missing].join(' ');" +
      '</script>',
    {
      scripts: {
        'https://example.test/dir/vendor/react.js': "export default 'react';",
        'https://example.test/dir/vendor/react-old.js':
          "export default 'react-old';",
        'https://example.test/dir/lib/twice.js':
          'export function twice(n) { return n * 2; }',
        'https://example.test/dir/lib/old/uses.js':
          "import r from 'react'; export const version = r;",
      },
    },
  );
  await settled(doc, 'out', (text) => text !== '');
  assert.equal(
    doc.text('out'),
    'react 4 react-old TypeError',
    doc.logs.join('\n'),
  );
});

test('two import()s whose modules share one are both linked, the shared one once', async () => {
  // linked at once, the second was handed a module the first was linking
  const doc = await hosted(
    '<p id="out"></p><script>' +
      "Promise.all([import('./lib/a.js'), import('./lib/b.js')]).then(" +
      "  function (m) { document.getElementById('out').textContent = m[0].a + ' ' + m[1].b + ' ' + m[0].count(); }," +
      "  function (e) { document.getElementById('out').textContent = 'failed: ' + e.message; });" +
      '</script>',
    {
      scripts: {
        'https://example.test/dir/lib/a.js':
          "import { d, count } from './d.js'; export const a = d + 1; export { count };",
        'https://example.test/dir/lib/b.js':
          "import { d } from './d.js'; export const b = d + 2;",
        'https://example.test/dir/lib/d.js':
          "import { e } from './e.js'; var runs = 0; runs += 1; export const d = e * 10; export function count() { return runs; }",
        'https://example.test/dir/lib/e.js': 'export const e = 1;',
      },
    },
  );
  await settle(120);
  assert.equal(doc.text('out'), '11 12 1');
});

test('a module that throws, runs away or does not parse is reported, and the page goes on', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var seen = [];' +
      "window.addEventListener('error', function (e) {" +
      "  if (e.target && e.target.id === 'gone') { seen.push('gone'); return; }" +
      "  seen.push(e.error && e.error.constructor === Error ? 'Error ' + e.error.message : String(e.message));" +
      '}, true);' +
      "window.addEventListener('load', function () { setTimeout(function () { document.getElementById('out').textContent = seen.sort().join(' | '); }, 30); });" +
      '</script>' +
      '<script type="module">throw new Error("from a module");</script>' +
      '<script type="module">for (;;) {}</script>' +
      '<script type="module">import { nothing } from "./lib/value.js";</script>' +
      '<script type="module" src="lib/gone.js" id="gone"></script>' +
      "<script>document.getElementById('out').textContent = 'after';</script>",
    {
      scripts: {
        'https://example.test/dir/lib/value.js': 'export const value = 7;',
      },
    },
  );
  await settle(200);
  assert.equal(doc.timeouts, 1, 'the runaway module was stopped');
  const out = doc.text('out').split(' | ');
  assert.ok(
    out.includes('Error from a module'),
    `the page's own error: ${out}`,
  );
  assert.ok(
    out.some((s) => /nothing/.test(s)),
    `the import that names nothing: ${out}`,
  );
  assert.ok(out.includes('gone'), `the module not found: ${out}`);
  assert.equal(out.length, 3, `${out}`);
});

test('the window has what scripts read of it: name, crypto, text encodings, Image', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = [];' +
      // `window.name.match(…)`, the commonest error a page met here
      'r.push(typeof window.name.match, JSON.stringify(window.name));' +
      'var name = 7; r.push(typeof name, window.name);' +
      'window.status = 1; r.push(typeof window.status, window.closed, window.length, typeof screenX);' +
      'var a = new Uint8Array(16); crypto.getRandomValues(a);' +
      'r.push(a.some(function (b) { return b !== 0; }), /^[0-9a-f-]{36}$/.test(crypto.randomUUID()));' +
      'try { crypto.getRandomValues(new Float32Array(1)); } catch (e) { r.push(e.name); }' +
      "var bytes = new TextEncoder().encode('aé€😀\\ud800');" +
      "r.push(Array.prototype.join.call(bytes, ' '));" +
      'r.push(new TextDecoder().decode(bytes));' +
      'var d = new TextDecoder(); var part = d.decode(bytes.subarray(0, 4), { stream: true }) + d.decode(bytes.subarray(4));' +
      'r.push(part === new TextDecoder().decode(bytes));' +
      'r.push(new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xc3, 0x28])));' +
      "try { new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xc3])); } catch (e) { r.push(e.name); }" +
      "r.push(new TextDecoder('latin1').decode(new Uint8Array([0x80, 0xe9])));" +
      "var img = new Image(4, 5); r.push(img instanceof HTMLImageElement, img.tagName, img.getAttribute('width'));" +
      "var o = new Option('t', 'v'); r.push(o.tagName, o.value, o.textContent);" +
      'r.push(visualViewport.width === innerWidth);' +
      "document.getElementById('out').textContent = r.join('|');" +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    [
      'function',
      '""',
      'string',
      '7',
      'string',
      'false',
      '0',
      'number',
      'true',
      'true',
      'TypeMismatchError',
      '97 195 169 226 130 172 240 159 152 128 239 191 189',
      'aé€😀\ufffd',
      'true',
      'a\ufffd(',
      'TypeError',
      '€é',
      'true',
      'IMG',
      '4',
      'OPTION',
      'v',
      't',
      'true',
    ].join('|'),
  );
});

test('a page edits a <style>’s rules as CSS-in-JS does, and what it inserts is drawn', async () => {
  const doc = await hosted(
    '<style id="s">/* lead */ p { margin: 0 } @media (min-width: 1px) { .m { color: blue } }</style>' +
      '<p id="x">x</p><p id="out"></p><script>' +
      'var r = []; var el = document.getElementById("s");' +
      // how styled-components finds its tag's sheet
      'var sheet = [].slice.call(document.styleSheets).filter(function (s) { return s.ownerNode === el; })[0];' +
      'r.push(document.styleSheets.length, sheet === el.sheet, sheet instanceof CSSStyleSheet);' +
      'var rules = sheet.cssRules;' +
      'r.push(rules.length, rules[0].selectorText, rules[0].style.margin, rules[1].type, rules[1].conditionText, rules[1].cssRules[0].selectorText);' +
      // emotion's: at the end, by the list's length
      'sheet.insertRule("#x { color: rgb(255, 0, 0) }", sheet.cssRules.length);' +
      'sheet.insertRule(".a { color: red }", 0); sheet.deleteRule(0);' +
      'r.push(rules === sheet.cssRules, sheet.cssRules.length, sheet.cssRules[2].cssText);' +
      'r.push(getComputedStyle(document.getElementById("x")).color);' +
      'try { sheet.insertRule("a {} b {}"); } catch (e) { r.push(e.name); }' +
      'try { sheet.insertRule("a {}", 9); } catch (e) { r.push(e.name); }' +
      'r.push(document.createElement("style").sheet);' +
      'var made = new CSSStyleSheet(); made.replaceSync("@import url(a.css); b { c: d }");' +
      'r.push(made.cssRules.length, made.ownerNode, document.styleSheets.length);' +
      // a text the page sets is the sheet from then on
      'el.textContent = "p { color: rgb(0, 0, 255) }";' +
      'r.push(el.sheet.cssRules.length, getComputedStyle(document.getElementById("x")).color);' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>' +
      // a rule inserted and nothing asked: drawn from the flush at the end
      '<p id="y">y</p><script>document.getElementById("s").sheet.insertRule("#y { color: rgb(0, 128, 0) }", 1)</script>',
  );
  assert.equal(
    doc.text('out'),
    [
      '1',
      'true',
      'true',
      '2',
      'p',
      '0',
      '4',
      '(min-width: 1px)',
      '.m',
      'true',
      '3',
      '#x { color: rgb(255, 0, 0) }',
      'rgb(255, 0, 0)',
      'SyntaxError',
      'IndexSizeError',
      '',
      '1',
      '',
      '1',
      '1',
      'rgb(0, 0, 255)',
    ].join('|'),
  );
  assert.equal(doc.view.computedStyle(doc.byId('y'))?.color, 'rgb(0, 128, 0)');
});

test('what a polyfill or a tag manager feature-tests is there, or absent, but never undefined', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = [];' +
      'r.push(navigator.plugins.length, navigator.mimeTypes.length, "clipboard" in navigator, "serviceWorker" in navigator);' +
      'r.push(document.createElement("_").localName, document.createElement("é-x").localName);' +
      'try { document.createElement("1a"); } catch (e) { r.push(e.name); }' +
      'try { document.createElement("_ a"); } catch (e) { r.push(e.name); }' +
      'r.push(typeof CDATASection.prototype, Object.getPrototypeOf(CDATASection.prototype) === Text.prototype, typeof ProcessingInstruction.prototype);' +
      'r.push(location instanceof Location, history instanceof History, navigator instanceof Navigator, screen instanceof Screen, String(location) === location.href);' +
      'var wrote = []; var set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { wrote.push(k); return set.call(this, k, v); };' +
      'localStorage.setItem("a", 1); localStorage.b = 2; r.push(localStorage instanceof Storage, wrote.join(","), localStorage.a + localStorage.getItem("b"), "a" in localStorage, Object.keys(localStorage).sort().join(""), localStorage.length);' +
      'Storage.prototype.setItem = set; localStorage.removeItem("a"); delete localStorage.b; r.push(localStorage.length);' +
      "document.getElementById('out').textContent = r.join('|');" +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    '0|0|false|false|_|é-x|InvalidCharacterError|InvalidCharacterError|object|true|object|true|true|true|true|true|true|a|12|true|ab|2|0',
  );
});

test('messages are tasks of their own, and a clone is a copy of what can be copied', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = []; var out = document.getElementById("out");' +
      'var c = new MessageChannel();' +
      'c.port1.onmessage = function (e) { r.push("port " + e.data.n + " " + (e.data !== sent)); };' +
      'var sent = { n: 1 }; c.port2.postMessage(sent);' +
      'addEventListener("message", function (e) { r.push("window " + e.data + " " + (e.source === window) + " " + e.origin); out.textContent = r.join("|"); });' +
      'postMessage("hi", "*"); postMessage("other", "https://elsewhere.test");' +
      'Promise.resolve().then(function () { r.push("microtask"); });' +
      'r.push("sync");' +
      'r.push(window instanceof Window, document instanceof Window, Object.prototype.toString.call(window));' +
      'var m = new Map([[1, { d: new Date(5) }]]); var o = { m: m, a: new Uint8Array([1, 2]) }; o.self = o;' +
      'var k = structuredClone(o);' +
      'r.push(k !== o, k.self === k, k.m.get(1).d.getTime(), k.a[1], k.a instanceof Uint8Array);' +
      'try { structuredClone(function () {}); } catch (e) { r.push(e.name); }' +
      'try { structuredClone(document.body); } catch (e) { r.push(e.name); }' +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t.includes('window'));
  assert.equal(
    text,
    [
      'sync',
      'true',
      'false',
      '[object Window]',
      'true',
      'true',
      '5',
      '2',
      'true',
      'DataCloneError',
      'DataCloneError',
      'microtask',
      'port 1 true',
      'window hi true https://example.test',
    ].join('|'),
  );
});

test('blobs, files, form data and the media a page reads at rest', async () => {
  const doc = await hosted(
    '<form id="f"><input name="a" value="1"><input type="checkbox" name="b" checked>' +
      '<input type="checkbox" name="c"><select name="d"><option>x<option selected>y</select>' +
      '<input name="e" disabled value="no"><button name="g" value="h">go</button></form>' +
      '<video id="v" muted></video><p id="out"></p><script>' +
      'var r = [];' +
      'var b = new Blob(["aé", new Uint8Array([33])], { type: "Text/Plain" });' +
      'r.push(b.size, b.type, b.slice(1, 3).size);' +
      'var f = new File([b], "n.txt"); r.push(f.name, f instanceof Blob, f.size);' +
      'var fd = new FormData(document.getElementById("f"));' +
      'r.push(JSON.stringify(Array.from(fd.entries())));' +
      'fd.append("a", "2"); fd.set("b", "z"); r.push(fd.getAll("a").join(","), fd.get("b"), fd.has("e"));' +
      'var v = document.getElementById("v");' +
      'r.push(v instanceof HTMLVideoElement, v.paused, isNaN(v.duration), v.muted, v.textTracks.length, v.buffered.length);' +
      'v.textTracks.addEventListener("addtrack", function () {});' +
      'r.push(document.createElement("source") instanceof HTMLSourceElement, new Audio() instanceof HTMLAudioElement);' +
      'var keys = []; for (var k in navigator.plugins) keys.push(k); r.push(keys.length);' +
      'b.text().then(function (t) { r.push(t); document.getElementById("out").textContent = r.join("|"); });' +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(
    text,
    [
      '4',
      'text/plain',
      '2',
      'n.txt',
      'true',
      '4',
      '[["a","1"],["b","on"],["d","y"]]',
      '1,2',
      'z',
      'false',
      'true',
      'true',
      'true',
      'true',
      '0',
      '0',
      'true',
      'true',
      '0',
      'aé!',
    ].join('|'),
  );
});

test('a sheet a page constructs and adopts is drawn after the document’s own, and as it is edited', async () => {
  const doc = await hosted(
    '<style>#z { color: rgb(0, 0, 0) }</style><p id="z">z</p>' +
      '<input type="button" id="go" value="go"><p id="out"></p><script>' +
      'var sheet = new CSSStyleSheet(); sheet.replaceSync("#z { color: rgb(1, 2, 3) }");' +
      'document.adoptedStyleSheets = [sheet];' +
      'var refused = "";' +
      'try { document.adoptedStyleSheets = [document.styleSheets[0]]; } catch (e) { refused = e.name; }' +
      'document.getElementById("go").addEventListener("click", function () {' +
      '  sheet.insertRule("#z { color: rgb(4, 5, 6) }", 1);' +
      '  var more = new CSSStyleSheet(); more.replaceSync("#z { background-color: rgb(7, 8, 9) }");' +
      '  document.adoptedStyleSheets.push(more);' +
      '  document.getElementById("out").textContent = refused + " " + document.adoptedStyleSheets.length;' +
      '});</script>',
  );
  const z = doc.byId('z');
  await settle();
  assert.equal(doc.view.computedStyle(z)?.color, 'rgb(1, 2, 3)');
  await userEvent.click(screen.getByRole('button') as DrawnNode);
  await settle();
  assert.equal(doc.text('out'), 'NotAllowedError 2');
  assert.equal(doc.view.computedStyle(z)?.color, 'rgb(4, 5, 6)');
  assert.equal(doc.view.computedStyle(z)?.['background-color'], 'rgb(7, 8, 9)');
});

test('streams read, pipe, tee and transform, and a response’s body is one', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = []; var out = document.getElementById("out");' +
      // Next.js's app router: a stream of what inline scripts push, read
      // a chunk at a time
      'var writer; var flight = new ReadableStream({ start: function (c) { writer = c; } });' +
      'writer.enqueue("a"); setTimeout(function () { writer.enqueue("b"); writer.close(); }, 0);' +
      'var reader = flight.getReader(); var got = "";' +
      'function next() { return reader.read().then(function (x) { if (x.done) return got; got += x.value; return next(); }); }' +
      'var pulled = 0; var counted = new ReadableStream({ pull: function (c) { pulled += 1; if (pulled > 3) c.close(); else c.enqueue(pulled); } });' +
      'var upper = new TransformStream({ transform: function (chunk, c) { c.enqueue(String(chunk).toUpperCase()); } });' +
      'var parts = counted.pipeThrough(upper).tee();' +
      'function all(stream) { var seen = []; var rd = stream.getReader();' +
      '  function go() { return rd.read().then(function (x) { if (x.done) return seen.join(""); seen.push(x.value); return go(); }); } return go(); }' +
      'var bytes = new ReadableStream({ start: function (c) { c.enqueue(new Uint8Array([0xe2, 0x82])); c.enqueue(new Uint8Array([0xac, 0x21])); c.close(); } });' +
      'var failing = new ReadableStream({ start: function (c) { c.error(new Error("no")); } });' +
      'Promise.all([' +
      '  next(), all(parts[0]), all(parts[1]),' +
      '  all(bytes.pipeThrough(new TextDecoderStream())),' +
      '  failing.getReader().read().catch(function (e) { return e.message; }),' +
      '  new Response("héllo").body.getReader().read().then(function (x) { return new TextDecoder().decode(x.value); }),' +
      ']).then(function (got) {' +
      '  r = got; r.push(flight.locked, typeof ReadableStream.from([1]).getReader);' +
      '  try { flight.getReader(); } catch (e) { r.push(e.name); }' +
      '  out.textContent = r.join("|");' +
      '});' +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(text, 'ab|123|123|€!|no|héllo|true|function|TypeError');
});

test('attribute nodes are the element’s, one each, in a map that is live', async () => {
  const doc = await hosted(
    '<div id="d" class="c" title="t" data-x="1"></div><p id="out"></p><script>' +
      'var r = []; var d = document.getElementById("d"); var map = d.attributes;' +
      'r.push(map.length, map[1].name, map[1] === d.getAttributeNode("class"), map === d.attributes, map.getNamedItem("title").value);' +
      'var title = d.getAttributeNode("title"); d.setAttribute("title", "u"); r.push(title.value);' +
      'var names = []; for (var i = 0; i < map.length; i++) names.push(map[i].name); r.push(names.join(","));' +
      'r.push(Array.from(map, function (a) { return a.value; }).join(","));' +
      // React empties an element so
      'var held = d.getAttributeNode("data-x");' +
      'while (map.length) d.removeAttributeNode(map[0]);' +
      'r.push(d.getAttributeNames().length, held.ownerElement, held.value);' +
      'var a = document.createAttribute("lang"); a.value = "en"; r.push(d.setAttributeNode(a), d.getAttribute("lang"), a.ownerElement === d);' +
      'try { document.getElementById("out").setAttributeNode(a); } catch (e) { r.push(e.name); }' +
      'try { d.removeAttributeNode(held); } catch (e) { r.push(e.name); }' +
      "document.getElementById('out').textContent = r.join('|');" +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    '4|class|true|true|t|u|id,class,title,data-x|d,c,u,1|0||1||en|true|InUseAttributeError|NotFoundError',
  );
});

test('a shadow root a page attaches is drawn as a declarative one is, and events leave it composed', async () => {
  const doc = await hosted(
    '<div id="host"><b slot="s" id="light">light</b> unslotted</div><div id="shut"><i id="gone">gone</i></div><a id="a">a</a>' +
      '<p id="out"></p><script>' +
      'var r = []; var host = document.getElementById("host");' +
      'var root = host.attachShadow({ mode: "open" });' +
      'root.innerHTML = "<style>p { color: rgb(9, 9, 9) }</style><p id=in>shadow <slot name=s></slot></p>";' +
      'var inner = root.getElementById("in");' +
      'r.push(root instanceof ShadowRoot, root.nodeType, root.host === host, host.shadowRoot === root, root.mode, inner.textContent);' +
      'r.push(inner.getRootNode() === root, inner.getRootNode({ composed: true }) === document, inner.parentNode === root, root.parentNode);' +
      'var shut = document.getElementById("shut");' +
      'r.push(shut.attachShadow({ mode: "closed" }) !== null, shut.shadowRoot);' +
      'try { host.attachShadow({ mode: "open" }); } catch (e) { r.push(e.name); }' +
      'try { document.getElementById("a").attachShadow({ mode: "open" }); } catch (e) { r.push(e.name); }' +
      'try { host.attachShadow({}); } catch (e) { r.push(e.name); }' +
      'var heard = []; document.addEventListener("ping", function (e) { heard.push(e.composed); });' +
      'inner.dispatchEvent(new CustomEvent("ping", { bubbles: true, composed: true }));' +
      'inner.dispatchEvent(new CustomEvent("ping", { bubbles: true }));' +
      'r.push(heard.join(","));' +
      "document.getElementById('out').textContent = r.join('|');" +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    'true|11|true|true|open|shadow |true|true|true||true||NotSupportedError|NotSupportedError|TypeError|true',
  );
  await settle();
  const root = shadowRootOf(doc.byId('host'));
  assert.ok(root, 'no shadow root on the host');
  const inner = findById(root as never, 'in') as DocElement;
  assert.equal(doc.view.computedStyle(inner)?.color, 'rgb(9, 9, 9)');
  // the light child the slot takes is drawn there, in the tree's flat order
  assert.ok(
    doc.view.computedStyle(doc.byId('light')),
    'the slotted child is not drawn',
  );
  assert.equal(doc.view.computedStyle(doc.byId('gone')), null);
});

test('a shadow root attached with nothing in it hides the host’s children at the next flush', async () => {
  const doc = await hosted(
    '<div id="shut"><i id="gone">gone</i></div><input type="button" id="go" value="go"><script>' +
      'document.getElementById("go").addEventListener("click", function () {' +
      '  document.getElementById("shut").attachShadow({ mode: "closed" });' +
      '});</script>',
  );
  assert.ok(doc.view.computedStyle(doc.byId('gone')), 'not drawn before');
  await userEvent.click(screen.getByRole('button') as DrawnNode);
  await settle();
  assert.equal(doc.view.computedStyle(doc.byId('gone')), null);
});

test('CSS.supports answers as an @supports does, an address assigned to location navigates, and fetch takes a Request and form data', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = [];' +
      // vercel.com's test for an old browser
      'r.push(CSS.supports("color", "var(--v)"), CSS.supports("(display: grid) and (gap: 1px)"), CSS.supports("display: flex"), CSS.supports("not (mask: none)"));' +
      'var req = new Request("api", { method: "post", body: "b", headers: { "X-A": "1" } });' +
      'r.push(req.url, req.method, req.headers.get("x-a"), req instanceof Request, req.clone().url === req.url);' +
      'try { new Request("x", { body: "b" }); } catch (e) { r.push(e.name); }' +
      'var fd = new FormData(); fd.append("a", "1"); fd.append("f", new File(["x"], "f.txt", { type: "text/plain" }));' +
      'Promise.all([fetch(req), fetch("form", { method: "POST", body: fd })]).then(function () {' +
      '  window.location = "elsewhere";' +
      '  r.push(typeof location, location.href);' +
      "  document.getElementById('out').textContent = r.join('|');" +
      '});' +
      '</script>',
    {
      answer: (request) => ({
        url: request.url,
        status: 200,
        statusText: 'OK',
        redirected: false,
        headers: [],
        body: '',
      }),
    },
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(
    text,
    [
      'true',
      'true',
      'true',
      'false',
      'https://example.test/dir/api',
      'POST',
      '1',
      'true',
      'true',
      'TypeError',
      'object',
      PAGE,
    ].join('|'),
  );
  assert.deepEqual(doc.links, ['https://example.test/dir/elsewhere']);
  const [sent, form] = doc.fetched;
  assert.deepEqual(
    [sent.method, sent.url, sent.body],
    ['POST', 'https://example.test/dir/api', 'b'],
  );
  const type = form.headers.find(([k]) => k === 'content-type')?.[1] ?? '';
  const boundary = /boundary=(.+)$/.exec(type)?.[1];
  assert.ok(boundary, type);
  assert.equal(
    form.body,
    `--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="f.txt"\r\nContent-Type: text/plain\r\n\r\nx\r\n` +
      `--${boundary}--\r\n`,
  );
});

test('indexedDB keeps a page’s records for the document: stores, keys, indexes, cursors and transactions', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = []; var out = document.getElementById("out");' +
      'function p(req) { return new Promise(function (res, rej) { req.onsuccess = function () { res(req.result); }; req.onerror = function () { rej(req.error); }; }); }' +
      'var open = indexedDB.open("db", 2);' +
      'open.onupgradeneeded = function (e) {' +
      '  var db = open.result; r.push("up " + e.oldVersion + ">" + e.newVersion);' +
      '  var s = db.createObjectStore("things", { keyPath: "id" }); s.createIndex("by-tag", "tags", { multiEntry: true });' +
      // mazda.com.au's analytics queue
      '  db.createObjectStore("events", { autoIncrement: true });' +
      '};' +
      'open.onsuccess = function () {' +
      '  var db = open.result; r.push(db.version, db.objectStoreNames.join(","));' +
      '  var tx = db.transaction(["things", "events"], "readwrite"); var things = tx.objectStore("things");' +
      '  things.put({ id: 2, tags: ["b", "c"], when: new Date(5) }); things.put({ id: 1, tags: ["a", "b"] });' +
      '  tx.objectStore("events").add({ e: "x" }); tx.objectStore("events").add({ e: "y" }).onsuccess = function (e) { r.push("key " + e.target.result); };' +
      '  things.add({ id: 1 }).onerror = function (e) { r.push(e.target.error.name); e.preventDefault(); };' +
      '  tx.oncomplete = function () {' +
      '    var read = db.transaction("things").objectStore("things");' +
      '    read.get(2).onsuccess = function (e) { r.push(e.target.result.when instanceof Date); };' +
      '    read.index("by-tag").getAllKeys("b").onsuccess = function (e) { r.push(e.target.result.join(",")); };' +
      '    try { read.put({ id: 3 }); } catch (e) { r.push(e.name); }' +
      '    var seen = []; read.openCursor(null, "prev").onsuccess = function (e) { var c = e.target.result; if (c) { seen.push(c.key); c.continue(); } else { r.push(seen.join(",")); next(db); } };' +
      '  };' +
      '};' +
      // a promise wrapper, awaiting between two requests of one transaction
      'async function next(db) {' +
      '  var tx = db.transaction("events", "readwrite"); var s = tx.objectStore("events");' +
      '  var n = await p(s.count()); await p(s.add({ e: "z" })); var m = await p(s.count());' +
      '  var c = await p(s.openCursor()); await p(c.delete()); r.push(n + ">" + m + ">" + await p(s.count()));' +
      '  var undo = db.transaction("things", "readwrite"); undo.objectStore("things").delete(1); undo.abort();' +
      '  undo.onabort = function () { db.transaction("things").objectStore("things").count().onsuccess = function (e) { r.push("kept " + e.target.result);' +
      '    var old = indexedDB.open("db", 1); old.onerror = function () { r.push(old.error.name); out.textContent = r.join("|"); }; }; };' +
      '}' +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(
    text,
    [
      'up 0>2',
      '2',
      'events,things',
      'key 2',
      'ConstraintError',
      // the read-only store's put throws before the reads are answered
      'ReadOnlyError',
      'true',
      '1,2',
      '2,1',
      '2>3>2',
      'kept 2',
      'VersionError',
    ].join('|'),
    doc.logs.join('\n'),
  );
});

test('markup set inside a script, a style or a textarea is its text, as HTML parses it there', async () => {
  const doc = await hosted(
    '<p id="out"></p><textarea id="t"></textarea><script>' +
      'var r = [];' +
      // next/script's way with an inline script
      'var s = document.createElement("script"); s.innerHTML = "for (var i = 0, n = 0; i<n; i++) {} window.ran = \'<b>\' + 1;";' +
      'document.body.appendChild(s); r.push(s.childNodes.length);' +
      'var st = document.createElement("style"); st.innerHTML = "a > b { color: red }"; r.push(st.textContent);' +
      'var t = document.getElementById("t"); t.innerHTML = "x &amp; <b>y</b>"; r.push(t.textContent);' +
      'var d = document.createElement("div"); d.innerHTML = "a<b>b</b>"; r.push(d.childNodes.length);' +
      'var s2 = document.createElement("script"); s2.textContent = "x"; s2.insertAdjacentHTML("beforeend", "<i>"); r.push(s2.textContent);' +
      // an appended script runs a turn after the append, here
      "setTimeout(function () { r.push(window.ran); document.getElementById('out').textContent = r.join('|'); }, 0);" +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(text, '1|a > b { color: red }|x & <b>y</b>|2|x<i>|<b>1');
});

test('a page walks its tree, parses markup into documents of its own, and marks and measures', async () => {
  const doc = await hosted(
    '<div id="root"><p>a<b>b</b></p><!--c--><span>d</span></div><p id="out"></p><script>' +
      'var r = []; var root = document.getElementById("root");' +
      'var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);' +
      'var names = []; while (w.nextNode()) names.push(w.currentNode.localName);' +
      'r.push(names.join(","));' +
      'var t = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT,' +
      '  function (n) { return n.nodeType === 8 ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT; });' +
      'var texts = []; while (t.nextNode()) texts.push(t.currentNode.data);' +
      'while (t.previousNode()) texts.push(t.currentNode.nodeType === 3 ? t.currentNode.data.toUpperCase() : "?");' +
      'r.push(texts.join(""));' +
      'var it = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT, { acceptNode: function (n) { return n.localName === "b" ? 2 : 1; } });' +
      'var seen = []; for (var n; (n = it.nextNode());) seen.push(n.localName);' +
      'r.push(seen.join(","));' +
      // a sanitizer's document, and a parser's: out of the page, scripts inert
      'var made = document.implementation.createHTMLDocument("x");' +
      'made.body.innerHTML = "<i>in</i>";' +
      'r.push(made.body.firstChild.localName, made.documentElement.localName, document.getElementById("root").contains(made.body));' +
      'var parsed = new DOMParser().parseFromString("<p class=q>parsed</p>", "text/html");' +
      'r.push(parsed.body.querySelector(".q").textContent, parsed.head !== null);' +
      'performance.mark("a"); performance.mark("b");' +
      'var m = performance.measure("ab", "a", "b");' +
      'r.push(m.entryType, performance.getEntriesByType("mark").length);' +
      'performance.clearMarks("a"); r.push(performance.getEntriesByName("a").length);' +
      'new PerformanceObserver(function (list) { r.push("observed " + list.getEntries()[0].name);' +
      '  document.getElementById("out").textContent = r.join("|"); }).observe({ entryTypes: ["mark"] });' +
      'performance.mark("c");' +
      '</script>',
  );
  await settle(60);
  assert.equal(
    doc.text('out'),
    [
      'p,b,span',
      // forward, then back from the last to the first
      'abdBA',
      // an iterator starts at its root, and a rejected node's children
      // are still visited, as a skipped one's are
      'div,p,span',
      'i',
      'html',
      'false',
      'parsed',
      'true',
      'measure',
      '2',
      '0',
      'observed c',
    ].join('|'),
    doc.logs.join('\n'),
  );
});

test('document.currentScript is the script through the microtasks it queued, and null after', async () => {
  // Turbopack's chunks read it from a promise's callback, as a browser
  // runs those before it puts `currentScript` back
  const doc = await hosted(
    '<p id="out"></p><script id="s">' +
      'var seen = [];' +
      'Promise.resolve().then(function () { seen.push(document.currentScript && document.currentScript.id); })' +
      '  .then(function () { seen.push(document.currentScript && document.currentScript.id); });' +
      'setTimeout(function () { seen.push(String(document.currentScript));' +
      "  document.getElementById('out').textContent = seen.join(' '); }, 0);" +
      '</script>',
  );
  await settle(60);
  assert.equal(doc.text('out'), 's s null');
});

test('a promise nothing catches is told as unhandledrejection and reported with its reason', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      "var heard = []; window.addEventListener('unhandledrejection', function (e) {" +
      "  heard.push(e.reason.message + ':' + (e.promise instanceof Promise));" +
      "  if (e.reason.message === 'kept') e.preventDefault(); });" +
      "Promise.reject(new TypeError('told'));" +
      "Promise.reject(new Error('kept'));" +
      "setTimeout(function () { document.getElementById('out').textContent = heard.sort().join(' '); }, 30);" +
      '</script>',
  );
  await settle(80);
  assert.equal(doc.text('out'), 'kept:true told:true');
  const reported = doc.logs.filter((l) => l.includes('Uncaught (in promise)'));
  assert.equal(reported.length, 1, reported.join('\n'));
  assert.match(reported[0], /TypeError: told/);
});

test('storage keeps what a page puts in it', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      "localStorage.setItem('k', 'v'); localStorage.n = 2;" +
      "document.getElementById('out').textContent = localStorage.getItem('k') + localStorage.n + localStorage.length + Object.keys(localStorage).join('');" +
      '</script>',
  );
  assert.equal(doc.text('out'), 'v22kn');
});

metric(
  'a click listener hears the click, and cancels the link it was on',
  async () => {
    const doc = await hosted(
      '<style>body{margin:0}</style><p><a id="a" href="next.html">go</a></p><p id="out"></p><script>' +
        "document.getElementById('a').addEventListener('click', function (e) {" +
        "  document.getElementById('out').textContent = e.type + ' ' + e.target.id + ' ' + e.isTrusted + ' ' + (e.clientX > 0);" +
        '  e.preventDefault(); });</script>',
    );
    const node = doc.view as unknown as DrawnNode;
    const rect = doc.view.elementRect(doc.byId('a'))!;
    await act(async () => {
      const dx = rect.x + rect.width / 2 - node.abs.width / 2;
      const dy = rect.y + rect.height / 2 - node.abs.height / 2;
      fireEvent.mouseDown(node, { dx, dy });
      fireEvent.mouseUp(node, { dx, dy });
    });
    await settle();
    assert.equal(doc.text('out'), 'click a true true');
    assert.deepEqual(doc.links, [], 'the link was not followed');
  },
);

metric(
  'a submit handler fills a field that is then sent, and one that cancels sends nothing',
  async () => {
    const doc = await hosted(
      '<form id="f" action="/go"><input type="hidden" name="token" id="t">' +
        '<input name="q" value="x"><input type="submit" id="s" value="Go"></form><script>' +
        "var sent = 0; document.getElementById('f').addEventListener('submit', function (e) {" +
        "  document.getElementById('t').value = 'filled';" +
        '  if (++sent > 1) e.preventDefault(); });</script>',
    );
    const go = screen.getByRole('button') as DrawnNode;
    await userEvent.click(go);
    await userEvent.click(go);
    assert.deepEqual(
      doc.submitted.map((s) => s.url),
      ['https://example.test/go?token=filled&q=x'],
    );
  },
);

metric(
  'controls are read and set from a script, and typing is heard',
  async () => {
    const doc = await hosted(
      '<input id="i" value="start"><input id="c" type="checkbox"><p id="out"></p><script>' +
        "var i = document.getElementById('i'), out = document.getElementById('out');" +
        "i.addEventListener('input', function () { out.textContent = i.value + '|' + i.defaultValue; });" +
        "document.getElementById('c').checked = true;" +
        '</script>',
    );
    const field = screen.getByRole('textbox') as DrawnNode;
    await userEvent.type(field, '!');
    await settle();
    assert.equal(doc.text('out'), 'start!|start');
    assert.equal(doc.handle.controlValue(doc.byId('c')), true);
  },
);

metric('layout is asked of the document as the script left it', async () => {
  const doc = await hosted(
    '<style>body{margin:0} #b{width:100px;height:20px;color:rgb(255,0,0)}</style>' +
      '<div id="b"></div><p id="out"></p><script>' +
      "var b = document.getElementById('b'); b.style.width = '150px';" +
      'var r = b.getBoundingClientRect();' +
      "document.getElementById('out').textContent = r.width + ' ' + getComputedStyle(b).color + ' ' + (document.elementFromPoint(5, 5) === b);" +
      '</script>',
  );
  assert.equal(doc.text('out'), '150 rgb(255, 0, 0) true');
});

test("a theme switcher's page: matchMedia reads the reader's scheme, the root's color-scheme reads back, and a new <link> loads before the old one goes", async () => {
  // what melbcss.com's theme picker does
  const page = (scheme: 'light' | 'dark') =>
    hosted(
      '<html><head><link id="theme" rel="stylesheet" href="a.css"></head>' +
        '<body><p id="out"></p><p id="log"></p><script>' +
        "var dark = matchMedia('(prefers-color-scheme: dark)').matches;" +
        "document.documentElement.style.colorScheme = dark ? 'dark' : 'light';" +
        // read as the page loads: the script waits for the head's sheet
        "document.getElementById('out').textContent = dark + ' ' + getComputedStyle(document.documentElement).colorScheme;" +
        "var link = document.getElementById('theme'), log = [];" +
        "function sheets() { return [].map.call(document.querySelectorAll('link'), function (l) { return l.getAttribute('href') }).join(' ') }" +
        'function swap(href, then) {' +
        "  var next = document.createElement('link');" +
        "  next.rel = 'stylesheet'; next.href = href;" +
        '  next.onload = function () { link.remove(); link = next; log.push(sheets()); then() };' +
        "  next.onerror = function () { log.push('error ' + href); then() };" +
        '  document.head.appendChild(next) }' +
        'function done() {' +
        "  document.getElementById('log').textContent = log.join(' | ') }" +
        "swap('b.css', function () { swap('a.css', function () { swap('gone.css', done) }) });" +
        '</script></body></html>',
      {
        scheme,
        sheets: { 'a.css': 'p { color: red }', 'b.css': 'p { color: blue }' },
      },
    );
  const loaded = async (doc: Hosted) => {
    for (let i = 0; i < 20 && !doc.text('log'); i += 1) await settle(20);
    return doc;
  };
  const light = await loaded(await page('light'));
  assert.equal(light.text('out'), 'false light');
  await cleanup();

  const dark = await loaded(await page('dark'));
  assert.equal(dark.text('out'), 'true dark');
  assert.equal(
    dark.text('log'),
    'b.css | a.css | error gone.css',
    'the first sheet again, already in, is told too',
  );
});

test('a script after a <link> the head is still fetching runs once the sheet is in, and reads the document as it styles it; one before the link runs at once', async () => {
  const held = new HeldSheets();
  const doc = await hosted(
    '<html><head><script>' +
      "function note(s) { var log = document.getElementById('log'); log.textContent = (log.textContent ? log.textContent + ' ' : '') + s }" +
      "note('early:' + document.readyState);" +
      "document.addEventListener('DOMContentLoaded', function () { note('ready') });" +
      '</script><link rel="stylesheet" href="slow.css">' +
      '<link rel="stylesheet" href="gone.css"></head>' +
      '<body><p id="log"></p><p id="out">x</p><script>' +
      "note('late:' + getComputedStyle(document.getElementById('out')).color);" +
      '</script></body></html>',
    { held },
  );
  assert.equal(doc.text('log'), 'early:loading', 'held for the sheets');
  await held.answer('gone.css', null);
  assert.equal(doc.text('log'), 'early:loading', 'one failed, one to come');
  await held.answer('slow.css', '#out { color: #ff0000 }');
  assert.equal(
    await settled(doc, 'log', (t) => t.includes('ready')),
    'early:loading late:rgb(255, 0, 0) ready',
  );
});

test('an async script waits for no sheet, and a deferred one or a module for every one the parser met, after it as well', async () => {
  const held = new HeldSheets();
  const note =
    "function note(s) { var log = document.getElementById('log'); log.textContent = (log.textContent ? log.textContent + ' ' : '') + s }";
  const color = "getComputedStyle(document.getElementById('log')).color";
  let doc = await hosted(
    '<html><head><script>' +
      note +
      '</script><link rel="stylesheet" href="slow.css">' +
      '<script async src="a.js"></script><script>' +
      `note('inline:' + ${color})` +
      '</script></head><body><p id="log"></p></body></html>',
    { held, scripts: { 'https://example.test/dir/a.js': "note('async')" } },
  );
  assert.equal(doc.text('log'), 'async');
  await held.answer('slow.css', '#log { color: #0000ff }');
  assert.equal(
    await settled(doc, 'log', (t) => t.includes('inline')),
    'async inline:rgb(0, 0, 255)',
  );
  await cleanup();

  const later = new HeldSheets();
  doc = await hosted(
    '<html><head><script>' +
      note +
      '</script><script defer src="d.js"></script>' +
      `<script type="module">note('module:' + ${color})</script>` +
      '<link rel="stylesheet" href="slow.css"></head>' +
      '<body><p id="log"></p></body></html>',
    {
      held: later,
      scripts: { 'https://example.test/dir/d.js': `note('defer:' + ${color})` },
    },
  );
  assert.equal(doc.text('log'), '', 'both after the parse, after the sheet');
  await later.answer('slow.css', '#log { color: #0000ff }');
  assert.equal(
    await settled(doc, 'log', (t) => t.includes('module')),
    'defer:rgb(0, 0, 255) module:rgb(0, 0, 255)',
  );
});

test('a range follows the tree it is in, and takes and copies what it holds as DOM’s ranges do', async () => {
  const doc = await hosted(
    '<div id="box"><p id="p">12345</p><h1 id="h">Hello <em>Wonderful</em> Kitty</h1><p id="q">How?</p></div>' +
      '<p id="out"></p><script>' +
      'var r = []; var p = document.getElementById("p"); var t = p.firstChild;' +
      'var range = document.createRange();' +
      'r.push(range.collapsed, range.startContainer === document);' +
      'range.setStart(t, 2); range.setEnd(t, 3); r.push(range.toString());' +
      // a split under the range moves its end into the new text
      'var rest = t.splitText(2);' +
      'r.push(t.data + "/" + rest.data, range.endContainer === rest, range.endOffset, range.toString());' +
      // data replaced before the start moves it
      't.insertData(0, "ab"); r.push(range.startOffset);' +
      // a removal of what holds an end collapses it to the parent
      'var box = document.getElementById("box");' +
      'range.setEnd(box, 2); box.removeChild(p);' +
      'r.push(range.startContainer === box, range.startOffset, range.endOffset);' +
      // contents taken across texts and elements
      'var h = document.getElementById("h"); var em = h.querySelector("em");' +
      'var x = document.createRange(); x.setStart(em.firstChild, 6); x.setEnd(document.getElementById("q"), 0);' +
      'r.push(x.toString());' +
      'var f = x.extractContents();' +
      'r.push(f.childNodes.length, f.firstChild.outerHTML, h.outerHTML, x.collapsed);' +
      // insertNode, surroundContents and the boundary comparisons
      'var y = document.createRange(); y.selectNodeContents(h);' +
      'var b = document.createElement("b"); b.textContent = "B"; y.insertNode(b);' +
      'r.push(h.firstChild === b, y.startOffset, y.endOffset);' +
      'var z = y.cloneRange(); z.collapse(true);' +
      'r.push(y.compareBoundaryPoints(Range.START_TO_START, z), y.compareBoundaryPoints(Range.END_TO_END, z), z.comparePoint(b, 0), y.intersectsNode(b));' +
      'var s = document.createRange(); s.selectNodeContents(b); s.surroundContents(document.createElement("i"));' +
      'r.push(b.innerHTML);' +
      'var dt = document.implementation.createDocumentType("html", "", "");' +
      'try { s.setStart(dt, 0); r.push("no throw"); } catch (e) { r.push(e.name, e.code === e.INVALID_NODE_TYPE_ERR); }' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    [
      'true',
      'true',
      '3',
      // the split: the range's end in the new text
      '12/345',
      'true',
      '1',
      '3',
      '4',
      'true',
      '0',
      '1',
      'ful Kitty',
      '2',
      '<h1 id="h"><em>ful</em> Kitty</h1>',
      '<h1 id="h">Hello <em>Wonder</em></h1>',
      'true',
      'true',
      '0',
      '3',
      '0',
      '1',
      // a point in the first child is after its parent's start
      '1',
      'true',
      '<i>B</i>',
      'InvalidNodeTypeError',
      'true',
    ].join('|'),
    doc.logs.join('\n'),
  );
});

test('a node iterator steps off the node its filter takes out, and texts merge and split', async () => {
  const doc = await hosted(
    '<div id="root"><b id="t1"></b><b id="t2"></b><b id="t3"></b><b id="t4"></b></div><p id="out"></p><script>' +
      'var r = []; var root = document.getElementById("root");' +
      'var ids = function (n) { return n ? (n.id || n.localName) : "null"; };' +
      'var t2 = document.getElementById("t2"), t4 = document.getElementById("t4");' +
      'var calls = 0;' +
      // Acid3's test 2, shortened: a filter removes the node it is asked
      // about, and the iterator steps on from where that node was
      'var it = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT, function (n) {' +
      '  calls++; if (calls === 6) { root.removeChild(t4); return NodeFilter.FILTER_REJECT; }' +
      '  if (calls === 8) root.removeChild(t2); return NodeFilter.FILTER_ACCEPT; });' +
      'for (var i = 0; i < 5; i++) r.push(ids(it.nextNode()));' +
      'r.push(ids(it.previousNode()), ids(it.referenceNode), it.pointerBeforeReferenceNode);' +
      'r.push(ids(it.previousNode()), ids(it.previousNode()));' +
      // normalize, wholeText and splitText
      'var p = document.createElement("p"); p.append("a", "", "b", document.createElement("i"), "c");' +
      'r.push(p.childNodes[0].wholeText); p.normalize();' +
      'r.push(p.childNodes.length, p.firstChild.data, p.firstChild.splitText(1).data, p.childNodes.length);' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    'root|t1|t2|t3|t4|t3|t3|true|t2|t1|ab|3|ab|b|4',
    doc.logs.join('\n'),
  );
});

test('DOM Core as Acid3 asks it: constants, namespaces, documents of XML, doctypes and node documents', async () => {
  const doc = await hosted(
    '<!DOCTYPE html><p id="out"></p><script>' +
      'var r = [];' +
      'try { document.body.appendChild(document.documentElement); } catch (e) {' +
      '  r.push(e.code, e.HIERARCHY_REQUEST_ERR, DOMException.NAMESPACE_ERR); }' +
      'r.push(document.DOCUMENT_FRAGMENT_NODE, document.body.COMMENT_NODE, document.createTextNode("").ELEMENT_NODE);' +
      'var el = document.createElementNS("http://ns.example.com/", "prefix:localname");' +
      'r.push(el.tagName, el.prefix, el.localName, el.namespaceURI, el instanceof HTMLElement);' +
      'try { document.createElementNS(null, "a:b"); } catch (e) { r.push(e.name); }' +
      'var dt = document.implementation.createDocumentType("html", "-//W3C//DTD XHTML 1.0 Strict//EN", "x.dtd");' +
      'var x = document.implementation.createDocument("http://www.w3.org/1999/xhtml", "html", dt);' +
      'r.push(x.childNodes.length, x.doctype === dt, dt.ownerDocument === x, dt.publicId, x.contentType, x instanceof XMLDocument);' +
      'x.documentElement.appendChild(x.createElementNS("http://www.w3.org/1999/xhtml", "head"));' +
      'x.documentElement.appendChild(x.createElementNS("http://www.w3.org/1999/xhtml", "body"));' +
      'var title = x.createElementNS("http://www.w3.org/1999/xhtml", "title");' +
      'x.documentElement.firstChild.appendChild(title); title.textContent = "Sparrow";' +
      'r.push(x.title, x.body.localName, document.title !== "Sparrow");' +
      // a document holds one element: another is refused, and text too
      'try { x.appendChild(x.createElement("p")); } catch (e) { r.push(e.name); }' +
      'var xml = document.implementation.createDocument(null, null, null);' +
      'var made = xml.createElement("Mixed"); r.push(made.tagName, made.namespaceURI, made.ownerDocument === xml);' +
      'var holder = xml.createElement("root"); holder.appendChild(made); r.push(made.parentNode.ownerDocument === xml);' +
      // adopted into the page's document, its document is the page's
      'document.body.appendChild(holder); r.push(made.ownerDocument === document);' +
      'r.push(document.importNode(made, false).ownerDocument === document, document.doctype.name);' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    [
      '3',
      '3',
      '14',
      '11',
      '8',
      '1',
      'prefix:localname',
      'prefix',
      'localname',
      'http://ns.example.com/',
      'false',
      'NamespaceError',
      '2',
      'true',
      'true',
      '-//W3C//DTD XHTML 1.0 Strict//EN',
      'application/xhtml+xml',
      'true',
      'Sparrow',
      'body',
      'true',
      'HierarchyRequestError',
      'Mixed',
      // null, joined
      '',
      'true',
      'true',
      'true',
      'true',
      'html',
    ].join('|'),
    doc.logs.join('\n'),
  );
});

test('tables, forms and the rest of HTML’s DOM Acid3 reads: rows and sections, controls by name, a submit button’s click', async () => {
  const doc = await hosted(
    '<form id="f" action="javascript:"><input id="i" type="HIDDEN"></form>' +
      '<table id="t"><tr><td><p></tbody> </table><p id="out"></p><script>' +
      'var r = [];' +
      // the parser's tbody, and the whitespace after it the table's
      'var t = document.getElementById("t");' +
      'r.push(t.tBodies.length, t.tBodies[0].rows[0].cells[0].firstChild.tagName, t.childNodes.length, JSON.stringify(t.lastChild.data));' +
      'var u = document.createElement("table");' +
      'var row = u.insertRow(0); r.push(u.firstChild.localName, row.rowIndex, row.sectionRowIndex);' +
      'var head = u.createTHead(); head.insertRow(); r.push(u.rows.length, u.rows[0].parentNode === head);' +
      'var cap = u.createCaption(); r.push(u.firstChild === cap, u.createCaption() === cap, u.childNodes.length);' +
      'u.createTFoot(); u.deleteTHead(); u.deleteCaption(); r.push(u.tHead, u.tFoot.localName, u.lastChild === u.tFoot);' +
      'row.insertCell(); row.insertCell(0).id = "c0"; r.push(row.cells.length, row.cells[0].id, row.cells[1].cellIndex);' +
      'try { u.insertRow(9); } catch (e) { r.push(e.name); }' +
      // a form's controls, by index and by name, wherever the form is
      'var f = document.createElement("form"); var i = document.createElement("input");' +
      'i.name = "first"; f.appendChild(i); r.push(f.elements.length, f.elements.first === i, f.elements.second);' +
      'r.push(document.forms.f === document.getElementById("f"), document.forms.f.elements[0].type);' +
      'var s = document.createElement("select"); var o1 = document.createElement("option"); var o2 = document.createElement("option");' +
      'o2.defaultSelected = true; s.append(o1, o2); r.push(s.selectedIndex, s.options[s.selectedIndex] === o2);' +
      'var m = document.createElement("meta"); m.setAttribute("http-equiv", "boxes"); r.push(m.httpEquiv, m.hasAttribute("httpEquiv"));' +
      'document.body.setAttribute("style", "float: right"); r.push(document.body.style.cssFloat);' +
      'var ev = document.createEvent("UIEvents"); ev.initUIEvent("test", true, false, null, 6);' +
      'r.push(ev.type, ev.bubbles, ev.detail);' +
      // the hidden input made a submit button: its click submits its form
      'var input = document.getElementById("i"); var form = document.getElementById("f"); var heard = 0;' +
      'form.onsubmit = function (e) { heard++; e.preventDefault(); };' +
      'input.type = "submit"; input.click(); r.push(heard);' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    [
      '1',
      'P',
      '2',
      '" "',
      'tbody',
      '0',
      '0',
      '2',
      'true',
      'true',
      'true',
      '3',
      // null, joined
      '',
      'tfoot',
      'true',
      '2',
      'c0',
      '1',
      'IndexSizeError',
      '1',
      'true',
      '',
      'true',
      'hidden',
      '1',
      'true',
      'boxes',
      'false',
      'right',
      'test',
      'true',
      '6',
      '1',
    ].join('|'),
    doc.logs.join('\n'),
  );
  assert.deepEqual(
    doc.submitted,
    [],
    'and a cancelled submission sends nothing',
  );
});

test('a box a script checked keeps its checkedness when its attribute changes, and a reset puts its default back', async () => {
  const doc = await hosted(
    '<form id="f"><input type="radio" name="g" id="a"><input type="radio" name="g" id="b"></form>' +
      '<p id="out"></p><script>' +
      'var r = []; var a = document.getElementById("a"), b = document.getElementById("b");' +
      'b.click(); a.checked = true; r.push(a.checked, b.checked);' +
      // the attribute is the default now, and not the state
      'b.setAttribute("checked", "checked"); r.push(b.checked, b.getAttribute("checked"), b.defaultChecked);' +
      'r.push(document.querySelector(":checked").id);' +
      'document.getElementById("f").reset(); r.push(a.checked, b.checked);' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    'true|false|false|checked|true|a|false|true',
    doc.logs.join('\n'),
  );
});

test('a frame’s document: XML read as XML, a malformed one an error, its scripts run, a new src navigates, and open and write build a tree', async () => {
  const files: Record<string, [string, string]> = {
    'svg.xml': [
      'image/svg+xml',
      '<svg xmlns="http://www.w3.org/2000/svg" width="100"><text>X</text></svg>',
    ],
    'good.xhtml': [
      'text/xml',
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><script>parent.notify("good")</script></body></html>',
    ],
    'bad.xhtml': [
      'text/xml',
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p><strong/> x </strong></p><script>parent.notify("bad")</script></body></html>',
    ],
    'other.xhtml': [
      'text/xml',
      '<html xmlns="http://www.w3.org/1999/xhtml#"><body><script>parent.notify("other")</script></body></html>',
    ],
    'a.html': ['text/html', '<!DOCTYPE html><title>A</title><p>a</p>'],
    'b.html': ['text/html', '<title>B</title>'],
  };
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var told = []; function notify(what) { told.push(what); }' +
      'var r = []; var frames = {}; var left = 0;' +
      'function done() {' +
      '  var svg = frames["svg.xml"].contentDocument;' +
      '  r.push(svg.documentElement.localName, svg.documentElement.namespaceURI, svg.getElementsByTagName("text").length, svg.contentType);' +
      '  r.push(frames["svg.xml"].getSVGDocument() === svg, svg.documentElement instanceof SVGSVGElement, svg.documentElement.width.baseVal.value);' +
      '  r.push(frames["bad.xhtml"].contentDocument.documentElement.localName, told.join(","));' +
      '  var html = frames["a.html"]; var first = html.contentDocument;' +
      '  r.push(first.title, first.childNodes.length);' +
      '  first.open(); first.write("<!DOCTYPE HTML PUBLIC \\"-//W3C//DTD HTML 4.01//EN\\" \\"x.dtd\\"><title></title><span><script><\\/script></span>"); first.close();' +
      '  r.push(first.childNodes.length, first.firstChild.publicId, first.documentElement.childNodes.length, first.body.firstChild.firstChild.tagName);' +
      '  html.onload = function () { r.push(html.contentDocument.title, html.contentDocument !== first);' +
      '    document.getElementById("out").textContent = r.join("|"); };' +
      '  html.src = "b.html";' +
      '}' +
      'Object.keys(' +
      // a page's script ends at the first `</script>` in it
      JSON.stringify(files).replace(/<\//g, '<\\/') +
      ').forEach(function (name) {' +
      '  var f = document.createElement("iframe"); frames[name] = f; left++;' +
      '  f.onload = function () { f.onload = null; if (--left === 0) done(); };' +
      '  f.src = name; document.body.appendChild(f); });' +
      '</script>',
    {
      answer: (request) => {
        const name = request.url.slice(request.url.lastIndexOf('/') + 1);
        const file = files[name];
        if (!file) return null;
        return {
          url: request.url,
          status: 200,
          statusText: 'OK',
          redirected: false,
          headers: [['content-type', file[0]]],
          body: file[1],
        };
      },
    },
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(
    text,
    [
      'svg',
      'http://www.w3.org/2000/svg',
      '1',
      'image/svg+xml',
      'true',
      'true',
      '100',
      // a stray end tag is no well-formed document: an error, and no script
      'parsererror',
      // a script in another namespace than XHTML's is none
      'good',
      'A',
      '2',
      '2',
      '-//W3C//DTD HTML 4.01//EN',
      '2',
      'SCRIPT',
      'B',
      'true',
    ].join('|'),
    doc.logs.join('\n'),
  );
});

test('a frame’s window is one for the frame wherever it goes: its location sends it, it has the page’s globals, and another origin’s has only what crosses', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = []; var mine = 1; var wrapped = function () {}; var kept = window.fetch; window.fetch = wrapped;' +
      'function out() { document.getElementById("out").textContent = r.join("|"); }' +
      'function step(f, next) { f.onload = function () { f.onload = null; next(); }; }' +
      'r.push(document.createElement("iframe").contentWindow);' +
      'var f = document.createElement("iframe"); document.body.appendChild(f);' +
      'var w = f.contentWindow;' +
      'r.push(w === f.contentWindow, w instanceof Window, w.window === w, w.self === w, w.parent === window, w.top === window, w.frameElement === f);' +
      'r.push(w.location.href, w.document === f.contentDocument, f.contentDocument.defaultView === w);' +
      // what Contentsquare and Sentry take from a frame: the page's own, unwrapped
      'r.push(new w.RegExp("a+", "g").test("aa"), w.JSON.stringify([1]), w.fetch === kept, typeof w.mine,' +
      '  Object.getOwnPropertyDescriptor(w.Node.prototype, "nodeType").get.call(document.body));' +
      'var heard = []; w.addEventListener("message", function (e) { heard.push(e.data + ":" + (e.source === window)); });' +
      'w.postMessage("hi", "*");' +
      'setTimeout(function () { r.push(heard.join()); step(f, sent); w.location.replace("a.html"); }, 10);' +
      'function sent() {' +
      '  r.push(f.getAttribute("src"), f.contentWindow === w, w.location.pathname, w.document.title);' +
      '  step(f, function () {' +
      '    var blocked = function (read) { try { read(); return "read"; } catch (e) { return e.name; } };' +
      '    r.push(f.contentWindow === w, f.contentDocument, blocked(function () { return w.document; }), blocked(function () { return w.location.href; }));' +
      '    w.postMessage("across", "*");' +
      '    step(f, function () { r.push(w.location.href, w.document.title === "" && w.document !== null); out(); });' +
      '    w.location.replace("about:blank");' +
      '  });' +
      '  w.location.href = "https://elsewhere.test/";' +
      '}' +
      // in a closed shadow root, as Contentsquare keeps its frame
      'var holder = document.createElement("div"); var root = holder.attachShadow({ mode: "closed" });' +
      'root.innerHTML = "<iframe></iframe>"; document.body.appendChild(holder);' +
      'r.push(typeof root.firstElementChild.contentWindow.Array.isArray);' +
      '</script>',
    {
      answer: (request) =>
        request.url.endsWith('/a.html')
          ? {
              url: request.url,
              status: 200,
              statusText: 'OK',
              redirected: false,
              headers: [['content-type', 'text/html']],
              body: '<title>A</title>',
            }
          : null,
    },
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(
    text,
    [
      // one not in the document has none
      '',
      'true',
      'true',
      'true',
      'true',
      'true',
      'true',
      'true',
      'about:blank',
      'true',
      'true',
      'true',
      '[1]',
      'true',
      'undefined',
      '1',
      'function',
      'hi:true',
      // `location` sent it, and its `src` says nothing of it
      '',
      'true',
      '/dir/a.html',
      'A',
      // another origin's: the same window, with nothing of it to read
      'true',
      '',
      'SecurityError',
      'SecurityError',
      'about:blank',
      'true',
    ].join('|'),
    doc.logs.join('\n'),
  );
});

test('a form whose target names a frame posts into the frame, and the tab stays where it is', async () => {
  // Facebook's pixel: a hidden form posting into a frame inside it, named
  // as the form's target, submitted once the frame has loaded, and taken
  // out once it loads again — and the tab went to facebook.com/tr/
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = []; var left = 2;' +
      'function send(action, name) {' +
      '  var form = document.createElement("form"); form.method = "post";' +
      '  form.action = action; form.target = name; form.style.display = "none";' +
      '  var frame = document.createElement("iframe"); frame.src = "about:blank";' +
      '  frame.id = name; frame.name = name; form.appendChild(frame);' +
      '  frame.addEventListener("load", function first() {' +
      '    frame.removeEventListener("load", first);' +
      '    var input = document.createElement("input"); input.name = "ev"; input.value = "PageView"; form.appendChild(input);' +
      '    frame.addEventListener("load", function () {' +
      '      r.push(name + ":" + (frame.contentDocument ? frame.contentDocument.title : "elsewhere"));' +
      '      form.parentNode.removeChild(form);' +
      '      if (--left === 0) document.getElementById("out").textContent = r.sort().join("|") + "|" + document.forms.length;' +
      '    });' +
      '    form.submit();' +
      '  });' +
      '  document.body.appendChild(form);' +
      '}' +
      'send("https://www.facebook.com/tr/", "fb1");' +
      'send("collect.html", "fb2");' +
      '</script>',
    {
      answer: (request) =>
        request.url.endsWith('/collect.html')
          ? {
              url: request.url,
              status: 200,
              statusText: 'OK',
              redirected: false,
              headers: [['content-type', 'text/html']],
              body: `<title>${request.method} ${request.body}</title>`,
            }
          : null,
    },
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(
    text,
    // another origin's frame is sent there and nothing of it loaded, so
    // nothing is posted to it
    'fb1:elsewhere|fb2:POST ev=PageView|0',
    doc.logs.join('\n'),
  );
  assert.deepEqual(doc.submitted, []);
  assert.deepEqual(doc.links, []);
  assert.deepEqual(
    doc.fetched.map((r) => `${r.method} ${r.url}`),
    ['POST https://example.test/dir/collect.html'],
  );
});

test('a target is a keyword, a frame’s name, or a new tab; window.open goes where its name says', async () => {
  const doc = await hosted(
    '<base target="_top"><iframe name="side"></iframe><iframe name="Side"></iframe>' +
      '<a id="own" target="side" href="a.html">a</a><a id="based" href="b.html">b</a>' +
      '<p id="out"></p><script>' +
      'var side = document.getElementsByName("side")[0];' +
      'side.onload = function () { side.onload = null;' +
      '  document.getElementById("out").textContent = side.contentWindow.location.pathname; };' +
      'window.open("a.html", "side"); window.open("c.html", "_self"); window.open("d.html");' +
      '</script>',
    {
      answer: (request) => ({
        url: request.url,
        status: 200,
        statusText: 'OK',
        redirected: false,
        headers: [['content-type', 'text/html']],
        body: '<title>t</title>',
      }),
    },
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(text, '/dir/a.html');
  // the tab went nowhere for the frame, and here and to a new one for the rest
  assert.deepEqual(doc.links, [
    'https://example.test/dir/c.html',
    'https://example.test/dir/d.html',
  ]);
  const document = doc.handle.document!;
  const by = (id: string) => doc.byId(id);
  for (const [target, expected] of [
    ['', 'here'],
    ['_SELF', 'here'],
    ['_parent', 'here'],
    ['_top', 'here'],
    ['_Blank', 'tab'],
    ['nowhere', 'tab'],
  ] as const) {
    assert.equal(navigableFor(document, target), expected, target);
  }
  // a name is matched as it is written, and the first frame of it wins
  const side = navigableFor(document, 'side');
  assert.ok(typeof side !== 'string' && side.attribs.name === 'side');
  const upper = navigableFor(document, 'Side');
  assert.ok(typeof upper !== 'string' && upper.attribs.name === 'Side');
  // a link's own target, else the document's `<base target>`
  assert.equal(linkTarget(by('own'), document), 'side');
  assert.equal(linkTarget(by('based'), document), '_top');
});

test('what the DOM lets a page assign, a strict script assigns without a throw', async () => {
  // CodeMirror sets `contentEditable` on every widget it draws, as strict
  // mode code, and react.dev's examples threw where it was only read
  const doc = await hosted(
    '<p id="out"></p><a id="a" href="https://example.test/dir/x.html?q=1">a</a>' +
      '<svg id="s"></svg><select><option id="o">O</option></select><script>' +
      '"use strict";' +
      'var r = []; var p = document.createElement("div");' +
      'p.contentEditable = "false"; r.push(p.contentEditable, p.getAttribute("contenteditable"));' +
      'p.contentEditable = "inherit"; r.push(p.contentEditable, p.hasAttribute("contenteditable"));' +
      'try { p.contentEditable = "maybe"; } catch (e) { r.push(e.name); }' +
      'p.draggable = true; p.accessKey = "k"; p.slot = "s"; p.classList = "x y";' +
      'r.push(p.getAttribute("draggable"), p.getAttribute("accesskey"), p.slot, p.classList.length);' +
      'var a = document.getElementById("a");' +
      'a.pathname = "/other/y.html"; a.search = "?q=2"; a.hash = "h"; a.text = "b";' +
      'r.push(a.getAttribute("href"), a.textContent);' +
      'var s = document.getElementById("s"); s.style = "fill: red"; r.push(s.style.fill);' +
      'var o = document.getElementById("o"); o.label = "L"; r.push(o.label);' +
      'document.domain = document.domain;' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>' +
      // a classic script's `var` over a window attribute HTML lets a page
      // replace: the page's value, where the window's was read on
      '<p id="vars"></p><script>var length = 5; var origin = "mine"; var innerWidth = 7;' +
      'document.getElementById("vars").textContent = [length, origin, innerWidth, window.closed].join("|");' +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    [
      'false',
      'false',
      'inherit',
      'false',
      'SyntaxError',
      'true',
      'k',
      's',
      '2',
      'https://example.test/other/y.html?q=2#h',
      'b',
      'red',
      'L',
    ].join('|'),
    doc.logs.join('\n'),
  );
  assert.equal(doc.text('vars'), '5|mine|7|false');
});

test('style.cssText is the block serialized, each declaration ended, so what a page appends to it is a declaration of its own', async () => {
  // CodeMirror's gutter spacer: `height: 0px`, then `cssText +=
  // "visibility: hidden"` — appended to a text with no `;`, both were lost
  const doc = await hosted(
    '<p id="out"></p><div id="d" style="color:red"></div><script>' +
      'var d = document.getElementById("d"); var r = [d.style.cssText];' +
      'd.style.height = "0px"; d.style.cssText += "visibility: hidden; pointer-events: none";' +
      'r.push(d.style.height, d.style.visibility, d.style.color, d.style.cssText);' +
      'd.style.setProperty("width", "1px", "important"); r.push(d.getAttribute("style"));' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    [
      'color: red;',
      '0px',
      'hidden',
      'red',
      'color: red; height: 0px; visibility: hidden; pointer-events: none;',
      'color: red; height: 0px; visibility: hidden; pointer-events: none; width: 1px !important;',
    ].join('|'),
  );
});

test('the pane scrolling is a scroll at the document, which reaches the window, once a frame', async () => {
  // CodeMirror measures its lines once it scrolls into view, and heard
  // nothing: its gutter kept a default line height under taller lines
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var heard = []; function out() { document.getElementById("out").textContent = heard.join("|"); }' +
      'document.addEventListener("scroll", function (e) { heard.push("document:" + (e.target === document) + ":" + e.bubbles + ":" + e.isTrusted); out(); });' +
      'window.addEventListener("scroll", function (e) { heard.push("window:" + (e.currentTarget === window) + ":" + (this === window)); out(); });' +
      '</script>',
  );
  // three moves in one frame are one scroll
  await act(async () => {
    doc.scrolled();
    doc.scrolled();
    doc.scrolled();
  });
  await settled(doc, 'out', (t) => t !== '');
  await settle(60);
  assert.equal(doc.text('out'), 'document:true:true:true|window:true:true');
});

test('an IntersectionObserver hands entries of the interface a page asks for, so a polyfill keeps it', async () => {
  // Next.js installs the W3C polyfill where `intersectionRatio` is not on
  // `IntersectionObserverEntry.prototype`, and the polyfill measured every
  // target again at every mutation of react.dev's tutorial, without end
  const doc = await hosted(
    '<p id="out"></p><div id="t"></div><script>' +
      'var r = ["intersectionRatio" in IntersectionObserverEntry.prototype, "isIntersecting" in IntersectionObserverEntry.prototype];' +
      'new IntersectionObserver(function (entries) {' +
      '  var e = entries[0];' +
      '  r.push(e instanceof IntersectionObserverEntry, e.target.id, e.isIntersecting, e.intersectionRatio);' +
      '  document.getElementById("out").textContent = r.join("|");' +
      '}).observe(document.getElementById("t"));' +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(text, 'true|true|true|t|true|1');
});
