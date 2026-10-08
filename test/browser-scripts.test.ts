// The browser example's script engine (examples/browser/script/): a page's
// scripts run in a `node:vm` context over `<Html>`'s DOM, and nothing of
// the host's is reachable from them. docs/prd-html-scripts.md is the
// design; these run it against an `<Html>` in the in-process X server, with
// a network and a pane that are stand-ins.
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  cleanup,
  fireEvent,
  renderX11,
  screen,
  userEvent,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import { Html, useHtmlHandle } from '../src/html/index.js';
import type {
  FormSubmission,
  HtmlHandle,
  HtmlViewNode,
} from '../src/html/index.js';
import type { Element as DocElement } from '../src/html/dom.js';
import { useScripts } from '../examples/browser/script/index.js';
import { ScriptEngine } from '../examples/browser/script/engine.js';
import { DomHost } from '../examples/browser/script/host.js';
import { HtmlSource } from '../src/html/dom.js';
import type { ScriptsOptions } from '../examples/browser/script/index.js';
import type {
  FetchRequest,
  FetchResponse,
} from '../examples/browser/script/host.js';
import { FONTS, findById, h, metric } from './html/harness.js';

afterEach(cleanup);

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
}

/** A page whose scripts run, with stand-ins for the network and the pane:
 *  `scripts` answers a script's URL, `answer` a `fetch`. */
async function hosted(
  source: string,
  options: {
    scripts?: Record<string, string>;
    answer?: (request: FetchRequest) => FetchResponse | null;
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
    return h(Html, {
      source,
      partial: false,
      ref: handle.ref,
      baseUrl: PAGE,
      onLink: (href: string) => void out.links.push(href),
      onSubmit: (s: FormSubmission) => void out.submitted.push(s),
      'data-testname': 'doc',
      ...scripts,
    });
  }
  await renderX11(
    h('box', { style: { width: 400, flexDirection: 'column' } }, h(Page)),
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

test('where a page’s import() would reach the host, no engine is made', () => {
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
});

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
        "import('fs').catch(function (e) { r.push(e.constructor.constructor(reach)()) });" +
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
        'undefined,undefined,string,null,undefinedundefinedundefined number',
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

test('a promise nothing catches is the page’s to report, not the process’s to die of', async (t) => {
  // node:test listens for unhandled rejections too, and fails the test it
  // hears one in: its listeners are set aside while the page's is out there
  const others = process.listeners('unhandledRejection');
  for (const l of others) process.off('unhandledRejection', l);
  t.after(() => {
    for (const l of others) process.on('unhandledRejection', l);
  });
  const doc = await hosted(
    "<script>Promise.reject(new Error('nobody catches this'));</script>",
  );
  await settle();
  assert.ok(doc.logs.some((l) => l.includes('Uncaught (in promise)')));
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
      "fetch('data.json', { method: 'POST', body: 'q=1', headers: { 'X-Test': 'yes' } })" +
      ".then(function (r) { return r.json().then(function (j) { document.getElementById('out').textContent = r.status + ' ' + j.ok; }); });" +
      "fetch('https://elsewhere.test/x').catch(function (e) { document.getElementById('out').textContent += ' ' + e.name; });" +
      '</script>',
    {
      answer: (request) =>
        request.url === 'https://example.test/dir/data.json'
          ? {
              url: request.url,
              status: 200,
              statusText: 'OK',
              redirected: false,
              headers: [['content-type', 'application/json']],
              body: '{"ok":"yes"}',
            }
          : null,
    },
  );
  await settle(60);
  assert.equal(doc.text('out'), '200 yes TypeError');
  assert.deepEqual(
    doc.fetched.map((r) => [r.method, r.url, r.body, r.headers]),
    [
      [
        'POST',
        'https://example.test/dir/data.json',
        'q=1',
        [['x-test', 'yes']],
      ],
    ],
    'the other origin was never asked',
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
      // read after `load`: a top-level `await` goes on past it, as a
      // browser's does
      "<script>window.addEventListener('load', function () { setTimeout(function () { document.getElementById('out').textContent = order.join(' | '); }, 30); });</script>",
    {
      scripts: {
        'https://example.test/dir/lib/twice.js':
          'var count = 0; export function twice(n) { return n * 2; } export function seen() { return ++count; }',
        'https://example.test/dir/lib/shout.js':
          "import { twice } from './twice.js'; export default function (s) { return s.toUpperCase() + twice(1); }",
        'https://example.test/dir/lib/main.js':
          "import { seen } from './twice.js'; order.push('main ' + seen() + ' ' + import.meta.url);" +
          // what a static import linked and evaluated, imported again
          "const again = await import('./twice.js'); order.push('again ' + again.seen());",
      },
    },
  );
  await settle(60);
  assert.equal(
    doc.text('out'),
    [
      'classic',
      // one twice.js for both, whichever imported it
      'inline 4 A2 1 https://example.test/dir/page.html',
      'main 2 https://example.test/dir/lib/main.js',
      'again 3',
    ].join(' | '),
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
