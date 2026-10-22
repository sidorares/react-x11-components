// `<Html>`'s script engine (src/html/scripts/): a page's
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
  waitForPixel,
} from 'react-x11/test';
import { ThemeProvider, createVideoFrames, useApp } from 'react-x11';
import {
  XK_BACKSPACE,
  XK_DELETE,
  XK_ESCAPE,
  XK_RETURN,
} from 'react-x11/keysyms';
import type { DrawnNode } from 'react-x11';

import { Html, shadowRootOf, useHtmlHandle } from '../../src/html/index.js';
import type {
  FormSubmission,
  HtmlHandle,
  HtmlViewNode,
  ResourceRequest,
  ResourceResult,
} from '../../src/html/index.js';
import type {
  Document as HtmlDocument,
  Element as DocElement,
} from '../../src/html/dom.js';
import { preloadHtmlScripts, useScripts } from '../../src/html/scripts/hook.js';
import type { ScriptRunner } from '../../src/html/scripts/runner.js';
import {
  SCRIPTS_CONTAINED,
  ScriptEngine,
  namedAccessWorks,
} from '../../src/html/scripts/engine.js';
import { DomHost } from '../../src/html/scripts/host.js';
import { HtmlSource } from '../../src/html/dom.js';
import type { ScriptsOptions } from '../../src/html/scripts/runner.js';
import { linkTarget, navigableFor } from '../../src/html/scripts/target.js';
import { FrameHolder, embeddedMounts } from '../../src/html/scripts/frames.js';
import type { FrameContext } from '../../src/html/scripts/frames.js';
import type {
  FetchRequest,
  FetchResponse,
} from '../../src/html/scripts/host.js';
import {
  FONTS,
  findById,
  h,
  bytesApart,
  metric as fontMetric,
  pixelsIn,
  rebuilt,
  snapshot,
} from './harness.js';
import { animationClock } from '../../src/html/node.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import { holdClock } from '../held-clock.js';
import type { HeldClock } from '../held-clock.js';

afterEach(cleanup);

// the engine's chunk, loaded before the first page rather than by it, so
// that no test's first page waits on its transpile (`./hook.ts`)
await preloadHtmlScripts();

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
  /** The scroll pane around the page, where `pane` asked for one. */
  pane: ScrollPane | null;
  /** The window the page is drawn in. */
  result: Awaited<ReturnType<typeof renderX11>>;
  /** Run a script in the page, as a task of its own. */
  run(code: string): void;
}

/** A scroll pane of core's, as `hosted` puts a page in one. */
interface ScrollPane {
  scrollTo(to: number | { x?: number; y?: number }): void;
  scrollX: number;
  scrollY: number;
}

/** A page whose scripts run, with stand-ins for the network and the pane:
 *  `scripts` answers a script's URL, `answer` a `fetch`, `sheets` a
 *  stylesheet's, by its file's name, or `held` when the test lets it go;
 *  `videos` a video's, with a sink; `scheme` is the palette's. `pane`
 *  puts the page in a scroll pane that tall, as the browser's is, whose
 *  scroll the page's viewport is, on a display of `scale`. */
async function hosted(
  source: string,
  options: {
    scripts?: Record<string, string>;
    answer?: (request: FetchRequest) => FetchResponse | null;
    sheets?: Record<string, string>;
    held?: HeldSheets;
    videos?: boolean;
    scheme?: 'light' | 'dark';
    pane?: number;
    scale?: number;
    animate?: boolean;
  } = {},
): Promise<Hosted> {
  const scale = options.scale ?? 1;
  const out = {
    logs: [] as string[],
    links: [] as string[],
    submitted: [] as FormSubmission[],
    timeouts: 0,
    fetched: [] as FetchRequest[],
    pane: null,
  } as Hosted;
  const seams: ScriptsOptions = {
    userAgent: 'test',
    language: 'en-US',
    viewport: () => ({
      width: 400,
      height: options.pane ?? 300,
      // a pane's offsets are device pixels, as core keeps them
      scrollX: (out.pane?.scrollX ?? 0) / scale,
      scrollY: (out.pane?.scrollY ?? 0) / scale,
      zoom: 1,
      dpr: scale,
      left: 0,
      top: 0,
    }),
    scrollTo: (x, y) => out.pane?.scrollTo({ x, y }),
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
    const app = useApp();
    const handle = useHtmlHandle();
    out.handle = handle;
    const scripts = useScripts(true, handle, PAGE, seams);
    out.scrolled = () => scripts.scrolled?.();
    out.run = (code) => scripts.runner?.()?.engine.exec(code, 'test', 0);
    return h(Html, {
      source,
      partial: false,
      ref: handle.ref,
      baseUrl: PAGE,
      animate: options.animate,
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
        if (options.videos && kind === 'video') {
          return {
            kind,
            frames: createVideoFrames(app, { width: 16, height: 16 }),
          };
        }
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
  out.result = await renderX11(
    h(
      ThemeProvider,
      { colorScheme: options.scheme ?? 'light' } as Record<string, unknown>,
      h(
        'box',
        {
          style: {
            width: 400,
            flexDirection: 'column',
            ...(options.pane !== undefined && {
              height: options.pane,
              overflow: 'scroll',
            }),
          },
          ref: (node: ScrollPane | null) => {
            if (options.pane !== undefined) out.pane = node;
          },
        },
        h(Page),
      ),
    ),
    FONTS
      ? { width: 440, height: 400, fonts: FONTS, scale }
      : { backend: 'mock', scale },
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

/** The smallest modules: `add`, two i32s summed, and `spin`, a loop with
 *  no end. */
const ADD_WASM = [
  0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7,
  7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11,
];
const SPIN_WASM = [
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4, 115,
  112, 105, 110, 0, 0, 10, 9, 1, 7, 0, 3, 64, 12, 0, 11, 11,
];

/** A response of bytes, as the browser's network answers: `body` is the
 *  text the host reads, which the page must not be handed in their place. */
function bytesAnswer(
  request: FetchRequest,
  type: string,
  bytes: Uint8Array,
): FetchResponse {
  return {
    url: request.url,
    status: 200,
    statusText: 'OK',
    redirected: false,
    headers: [['content-type', type]],
    body: 'not the bytes',
    bytes,
  };
}

test('a page compiles WebAssembly, streamed from its fetch, reads a body as its bytes, and is refused with errors of its own', async () => {
  const every = new Uint8Array(256).map((_, i) => i);
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = [];' +
      'function own(e) { return e.constructor.constructor("return typeof process")(); }' +
      'fetch("add.wasm").then(function (res) { return WebAssembly.instantiateStreaming(res, {}); })' +
      '.then(function (m) { r.push(m.instance.exports.add(2, 3));' +
      // the runtime's own streaming compile refused this with the host's
      // TypeError, whose constructor's constructor is the host's Function
      '  return WebAssembly.compileStreaming({}); })' +
      '.catch(function (e) { r.push(e instanceof TypeError, own(e)); })' +
      '.then(function () { return WebAssembly.compileStreaming(fetch("every.bin")); })' +
      '.catch(function (e) { r.push(e instanceof TypeError); })' +
      '.then(function () { return WebAssembly.compile(new Uint8Array([1, 2, 3])); })' +
      '.catch(function (e) { r.push(e instanceof WebAssembly.CompileError, own(e)); })' +
      '.then(function () { return fetch("every.bin"); })' +
      '.then(function (res) { return res.arrayBuffer(); })' +
      '.then(function (b) { var u = new Uint8Array(b); r.push(u.length, u[0], u[128], u[255]);' +
      '  return fetch("text.txt"); })' +
      '.then(function (res) { return res.text(); })' +
      '.then(function (t) { r.push(t);' +
      '  var x = new XMLHttpRequest(); x.responseType = "arraybuffer"; x.open("GET", "every.bin");' +
      '  x.onload = function () { var u = new Uint8Array(x.response); r.push(u.length, u[200]);' +
      '    document.getElementById("out").textContent = r.join("|"); };' +
      '  x.send(); })' +
      '.catch(function (e) { document.getElementById("out").textContent = "failed: " + e; });' +
      '</script>',
    {
      answer: (request) => {
        const name = request.url.slice(request.url.lastIndexOf('/') + 1);
        if (name === 'add.wasm') {
          return bytesAnswer(
            request,
            'application/wasm',
            Uint8Array.from(ADD_WASM),
          );
        }
        if (name === 'every.bin') {
          return bytesAnswer(request, 'application/octet-stream', every);
        }
        if (name === 'text.txt') {
          return bytesAnswer(
            request,
            'text/plain',
            new TextEncoder().encode('héllo ✓'),
          );
        }
        return null;
      },
    },
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(
    text,
    [
      5,
      true,
      'undefined',
      true,
      true,
      'undefined',
      256,
      0,
      128,
      255,
      'héllo ✓',
      256,
      200,
    ].join('|'),
    doc.logs.join('\n'),
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
        "import { SCRIPTS_CONTAINED, ScriptEngine } from './src/html/scripts/engine.ts';" +
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

test("a classic script's declarations are the window's, a strict one's and its let, const and class too, and one that does not parse is the page's SyntaxError", async () => {
  const doc = await hosted(
    '<p id="out">-</p>' +
      '<script src="strict.js"></script>' +
      "<script>let early = 'let'; const fixed = 'const'; class Shape {}</script>" +
      "<script>window.addEventListener('error', function (e) { window.caught = e.error instanceof SyntaxError ? 'SyntaxError' : String(e.error); });</script>" +
      '<script>this is not javascript</script>' +
      "<script>document.getElementById('out').textContent = [typeof helper, helper(), counted, early, fixed, typeof Shape, caught, document.currentScript.tagName].join(' ');</script>",
    {
      // as WPT's computed-testcommon.js is: strict, and its functions what
      // the test's own script calls
      scripts: {
        'https://example.test/dir/strict.js':
          "'use strict'; function helper() { return 'helper'; } var counted = 'var';",
      },
    },
  );
  assert.equal(
    doc.text('out'),
    'function helper var let const function SyntaxError SCRIPT',
  );
});

// a runtime that refuses a proxy in the global's chain, Bun's, has none
const named = SCRIPTS_CONTAINED && namedAccessWorks() ? test : nodeTest.skip;

named(
  'an element is a global by its id, and a form by its name, under every global and declaration of the window',
  async () => {
    const doc = await hosted(
      '<p id="out">-</p><div id="target"></div><form name="login"></form>' +
        '<span id="twice"></span><b id="twice"></b>' +
        '<div id="close"></div><div id="shadowed"></div>' +
        "<script>var shadowed = 'var';" +
        'var before = typeof added;' +
        "var el = document.createElement('i'); el.id = 'added'; document.body.appendChild(el);" +
        'var after = typeof added; el.remove();' +
        "var strict = (function () { 'use strict'; try { nothingNamedThis; return 'found'; } catch (e) { return e.name; } })();" +
        "document.getElementById('out').textContent = [target.id, window.target === document.getElementById('target'), 'target' in window, login.tagName, twice.length, typeof close, shadowed, before, after, typeof added, strict].join(' ');</script>",
    );
    assert.equal(
      doc.text('out'),
      'target true true FORM 2 function var undefined object undefined ReferenceError',
    );
  },
);

test('an @container rule is a CSSContainerRule, its name and its query serialized as CSSOM serializes them', async () => {
  // WPT's at-container-style-serialization cases, and the check every
  // style-query test makes before it runs (`cq-testcommon.js`)
  const cases: [string, string][] = [
    ['STYLE(--foo: bar)', 'style(--foo: bar)'],
    ['style(        --foo:bar)', 'style(--foo: bar)'],
    ['STyle(--foo:    )', 'style(--foo: )'],
    ['STyle(--foo:)', 'style(--foo: )'],
    ['STyle(--foo)', 'style(--foo)'],
    [
      ' style(  ( --FOO: BAR) OR ( prop: val  ) )',
      'style((--FOO: BAR) or ( prop: val  ))',
    ],
    // a container named `style`, and its query
    ['style (--foo: bar)', 'style (--foo: bar)'],
    ['style(--foo: bar   baz)', 'style(--foo: bar   baz)'],
    ['style(--foo:2.100  )', 'style(--foo: 2.100)'],
    ['style((--foo: bar))', 'style((--foo: bar))'],
    ['style(( (  (( (--foo )) )  )))', 'style((((((--foo))))))'],
    ['style((not ((--foo: BAR))))', 'style((not ((--foo: BAR))))'],
    [
      'style(((--FOO: BAR)) and (--bar: foo))',
      'style(((--FOO: BAR)) and (--bar: foo))',
    ],
    ['style(100px  > --foo >10px)', 'style(100px > --foo > 10px)'],
  ];
  const doc = await hosted(
    '<p id="out">-</p><script>' +
      `var cases = ${JSON.stringify(cases.map(([q]) => q))};` +
      'var out = cases.map(function (q) {' +
      "  var sheet = new CSSStyleSheet(); sheet.replaceSync('@container ' + q + ' {}');" +
      '  var rule = sheet.cssRules[0];' +
      "  return rule instanceof CSSContainerRule ? rule.conditionText : 'not a CSSContainerRule';" +
      '});' +
      "var named = new CSSStyleSheet(); named.replaceSync('@container card (width > 10px) { p { color: red } } @container STYLE(--foo: bar) {}');" +
      'var rule = named.cssRules[0];' +
      'out.push(rule.containerName, rule.containerQuery, rule.conditionText, String(rule.cssRules.length));' +
      'out.push(named.cssRules[1].containerName, named.cssRules[1].containerQuery);' +
      "document.getElementById('out').textContent = JSON.stringify(out);</script>",
  );
  assert.deepEqual(JSON.parse(doc.text('out')), [
    ...cases.map(([, want]) => want),
    'card',
    '(width > 10px)',
    'card (width > 10px)',
    '1',
    '',
    'style(--foo: bar)',
  ]);
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

test('a classic script that runs away leaves the engine timed out, for the host to repair its tree', () => {
  // Node makes the timeout's error in the context's realm, so a script the
  // host runs is told it timed out only by the page (`__fault`), and the
  // tree a bridge op was moving when V8 stopped it still wants repairing
  const source = new HtmlSource();
  source.setSource('<html><body></body></html>', true);
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
      log() {},
      title() {},
      fetch: () => Promise.reject(new Error('none')),
    },
    'https://example.test/',
  );
  let timeouts = 0;
  // long enough for the facade to install on a slow runner, which runs
  // under the same timeout
  const engine = new ScriptEngine(host.bridge, {
    timeout: 1000,
    onTimeout: () => void (timeouts += 1),
    log() {},
    settled() {},
  });
  host.entries = engine;
  assert.equal(engine.exec('for (;;) {}', 'a', 0), false);
  assert.equal(timeouts, 1);
  assert.equal(engine.timedOutSince(), true);
  assert.equal(engine.timedOutSince(), false);
  assert.equal(engine.exec('var after = 1;', 'b', 0), true);
});

test('a worker runs in a thread of its own, started from a blob URL as Parcel starts one, and messages go both ways as structured clones', async () => {
  const doc = await hosted(
    '<p id="out"></p><p id="err"></p><script>' +
      'var shim = "importScripts(" + JSON.stringify(new URL("worker.js", location.href).href) + ");";' +
      'var w = new Worker(URL.createObjectURL(new Blob([shim], { type: "application/javascript" })));' +
      'w.onmessage = function (e) { var d = e.data;' +
      '  document.getElementById("out").textContent = [d.sum, d.when instanceof Date, d.when.getTime(),' +
      '    d.bytes instanceof Uint8Array, d.bytes.join("."), d.map.get("k"), d.global, d.noDocument].join("|"); };' +
      'w.postMessage({ a: 2, b: 3, when: new Date(5), bytes: new Uint8Array([1, 2, 3]), map: new Map([["k", "v"]]) });' +
      'var bad = new Worker("bad.js");' +
      'bad.onerror = function (e) { document.getElementById("err").textContent = e.message + "@" + /bad.js$/.test(e.filename); };' +
      '</script>',
    {
      answer: (request) => {
        const name = request.url.slice(request.url.lastIndexOf('/') + 1);
        const body =
          name === 'worker.js'
            ? 'self.onmessage = function (e) { var d = e.data;' +
              '  postMessage({ sum: d.a + d.b, when: d.when, bytes: d.bytes, map: d.map,' +
              '    global: typeof importScripts + ":" + (self instanceof WorkerGlobalScope) + ":" + name,' +
              '    noDocument: typeof document + ":" + typeof window }); };'
            : name === 'bad.js'
              ? 'throw new TypeError("no good");'
              : null;
        if (body === null) return null;
        return {
          url: request.url,
          status: 200,
          statusText: 'OK',
          redirected: false,
          headers: [['content-type', 'text/javascript']],
          body,
        };
      },
    },
  );
  const text = await settled(doc, 'out', (t) => t !== '', 15000);
  assert.equal(
    text,
    '5|true|5|true|1.2.3|v|function:true:|undefined:undefined',
    doc.logs.join('\n'),
  );
  assert.equal(
    await settled(doc, 'err', (t) => t !== '', 15000),
    'Uncaught TypeError: no good@true',
    doc.logs.join('\n'),
  );
});

test('a shared worker is one thread for a script and a name, which each SharedWorker connects to through a port of its own', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var src = "var seen = 0; onconnect = function (e) { var port = e.source; seen += 1;" +' +
      '  "port.postMessage({ n: seen, same: e.ports[0] === port, scope: self instanceof SharedWorkerGlobalScope, post: typeof postMessage, name: name });" +' +
      '  "port.onmessage = function (m) { port.postMessage({ echo: m.data.x * 2 }); }; };";' +
      'var url = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));' +
      'var r = [];' +
      'function done() { if (r.length === 3) document.getElementById("out").textContent = r.sort().join("|"); }' +
      'var a = new SharedWorker(url, "w"), b = new SharedWorker(url, { name: "w" });' +
      'a.port.onmessage = function (e) { var d = e.data;' +
      '  r.push(d.echo !== undefined ? "a echo " + d.echo : ["a", d.n, d.same, d.scope, d.post, d.name].join(" "));' +
      '  if (d.n) a.port.postMessage({ x: 21 }); done(); };' +
      // a port listened to with addEventListener is started by hand
      'b.port.addEventListener("message", function (e) { r.push("b " + e.data.n); done(); }); b.port.start();' +
      '</script>',
  );
  // one thread, which counted both connections, in the order made; and a
  // shared worker's global posts on its ports alone
  assert.equal(
    await settled(doc, 'out', (t) => t !== '', 15000),
    'a 1 true true undefined w|a echo 42|b 2',
    doc.logs.join('\n'),
  );
});

test('a worker’s imported script is a script of its own: a strict one’s declarations are the worker’s, and what one throws is thrown to its caller', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var base = new URL(".", location.href).href;' +
      'var src = "var base = " + JSON.stringify(base) + "; var r = [];" +' +
      '  "importScripts(base + \'strict.js\'); r.push(helper(), typeof Kept, answer);" +' +
      '  "try { importScripts(base + \'throws.js\'); } catch (e) { r.push(e instanceof RangeError, e.message); }" +' +
      '  "try { importScripts(base + \'broken.js\'); } catch (e) { r.push(e.name); }" +' +
      '  "try { importScripts(base + \'missing.js\'); } catch (e) { r.push(e.name); }" +' +
      '  "postMessage(r.join(\'|\'));";' +
      'var w = new Worker(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));' +
      'w.onmessage = function (e) { document.getElementById("out").textContent = e.data; };' +
      '</script>',
    {
      answer: (request) => {
        const name = request.url.slice(request.url.lastIndexOf('/') + 1);
        const body = {
          'strict.js':
            "'use strict'; function helper() { return 'helped'; } class Kept {} const answer = 42;",
          'throws.js': "throw new RangeError('out of range');",
          'broken.js': 'function (',
        }[name];
        if (body === undefined) return null;
        return {
          url: request.url,
          status: 200,
          statusText: 'OK',
          redirected: false,
          headers: [['content-type', 'text/javascript']],
          body,
        };
      },
    },
  );
  assert.equal(
    await settled(doc, 'out', (t) => t !== '', 15000),
    'helped|function|42|true|out of range|SyntaxError|NetworkError',
    doc.logs.join('\n'),
  );
});

test('a worker’s fetch resolves at its headers too, its body handed across from the page process as it arrives', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const text = (t: string) => new TextEncoder().encode(t);
  const doc = await hosted(
    '<p id="out"></p><script type="text/worker" id="src">' +
      'fetch(slow).then(function (res) { var reader = res.body.getReader(); var dec = new TextDecoder(); var got = "";' +
      '  var pump = function () { return reader.read().then(function (r) { if (r.done) { postMessage("done:" + got); return; }' +
      '    got += dec.decode(r.value); postMessage("chunk:" + got); return pump(); }); }; return pump(); });' +
      '</script><script>' +
      // a blob URL's worker has no base to resolve `slow` against
      'var src = "var slow = " + JSON.stringify(new URL("slow", location.href).href) + ";" + document.getElementById("src").textContent;' +
      'var w = new Worker(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));' +
      'w.onmessage = function (e) { var out = document.getElementById("out"); out.textContent += (out.textContent ? "|" : "") + e.data; };' +
      '</script>',
    {
      answer: (request) => ({
        url: request.url,
        status: 200,
        statusText: 'OK',
        redirected: false,
        headers: [],
        body: '',
        chunks: (async function* () {
          yield text('one ');
          await held;
          yield text('two');
        })(),
      }),
    },
  );
  assert.equal(
    await settled(doc, 'out', (t) => t !== '', 15000),
    'chunk:one ',
    doc.logs.join('\n'),
  );
  release();
  assert.equal(
    await settled(doc, 'out', (t) => t.includes('done'), 15000),
    'chunk:one |chunk:one two|done:one two',
    doc.logs.join('\n'),
  );
});

// where the engine could turn JSPI on: Node 24's V8 and later, and not
// Bun's JavaScriptCore or Node 20's and 22's V8, which have only an
// earlier proposal
const jspi =
  SCRIPTS_CONTAINED &&
  (await import('node:vm')).runInNewContext('typeof WebAssembly.Suspending') ===
    'function'
    ? test
    : nodeTest.skip;

jspi(
  'a page suspends WebAssembly on a promise with JSPI, WebAssembly.Suspending and WebAssembly.promising',
  async () => {
    // (module (import "m" "f" (func (result i32)))
    //         (func (export "g") (result i32) call 0))
    const bytes = [
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60,
      0x00, 0x01, 0x7f, 0x02, 0x07, 0x01, 0x01, 0x6d, 0x01, 0x66, 0x00, 0x00,
      0x03, 0x02, 0x01, 0x00, 0x07, 0x05, 0x01, 0x01, 0x67, 0x00, 0x01, 0x0a,
      0x06, 0x01, 0x04, 0x00, 0x10, 0x00, 0x0b,
    ];
    const doc = await hosted(
      '<p id="out">-</p><script>' +
        `var bytes = new Uint8Array(${JSON.stringify(bytes)});` +
        'var f = new WebAssembly.Suspending(function () {' +
        '  return new Promise(function (resolve) { setTimeout(function () { resolve(42); }, 0); }); });' +
        'WebAssembly.instantiate(bytes, { m: { f: f } }).then(function (made) {' +
        '  var g = WebAssembly.promising(made.instance.exports.g); var p = g();' +
        '  return Promise.all([p instanceof Promise, p]); }).then(function (r) {' +
        '  document.getElementById("out").textContent = r.join(" "); });' +
        '</script>',
    );
    const text = await settled(doc, 'out', (t) => t !== '-');
    assert.equal(text, 'true 42', doc.logs.join('\n'));
  },
);

test('a WebAssembly module that runs away is stopped as a script is, and the page goes on', async () => {
  // Node's timeout reaches into the module; Bun's does not, and there the
  // pane's watchdog ends the tab
  const doc = await hosted(
    '<p id="out">-</p><script>' +
      `new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([${SPIN_WASM}]))).exports.spin();` +
      "</script><script>document.getElementById('out').textContent = 'after';</script>",
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
      "import { ScriptEngine } from './src/html/scripts/engine.ts';" +
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
        // a page sets no cookie of its own; a string's type is implied
        [
          ['x-test', 'yes'],
          ['content-type', 'text/plain;charset=UTF-8'],
        ],
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
      [
        'POST',
        'q=1',
        [
          ['x-test', 'yes'],
          ['content-type', 'text/plain;charset=UTF-8'],
        ],
      ],
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

test("a video's play() and pause() are its player's, and paused, the events and the promise are what the page asked", async () => {
  const doc = await hosted(
    '<video id="v" src="clip.mp4" autoplay muted ' +
      'style="display:block;width:60px;height:30px"></video>' +
      '<input type="button" id="go" value="go"><p id="out"></p><script>' +
      'var v = document.getElementById("v"), r = [];' +
      '["play", "playing", "pause", "timeupdate", "seeking", "seeked", "volumechange"].forEach(function (t) {' +
      '  v.addEventListener(t, function () { r.push(t) }) });' +
      // an autoplaying video plays until the page says otherwise
      'r.push(v.paused); v.pause(); r.push(v.paused);' +
      'document.getElementById("go").addEventListener("click", function () {' +
      '  v.play().then(function () {' +
      '    r.push("kept", v.paused);' +
      '    v.muted = false; r.push(v.muted, v.defaultMuted);' +
      '    v.currentTime = 2.5; r.push(v.currentTime);' +
      '    setTimeout(function () { document.getElementById("out").textContent = r.join(",") }, 0);' +
      '  }) });' +
      '</script>',
    { videos: true },
  );
  const player = () =>
    screen.all((n) => n.kind === 'video')[0] as
      (DrawnNode & { props: Record<string, unknown> }) | undefined;
  // mounted once the host's answer is in, after the script asked
  const end = Date.now() + 3000;
  while (player()?.props.paused === undefined && Date.now() < end) {
    await settle();
  }
  const video = player();
  assert.ok(video, 'a player is mounted');
  assert.equal(video.props.paused, true, 'paused, as the page asked');
  assert.equal(video.props.autoPlay, true, 'and its markup as it was');
  const sought: number[] = [];
  Object.assign(video, { seek: (t: number) => void sought.push(t) });
  await userEvent.click(screen.getByRole('button') as DrawnNode);
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(
    text,
    [
      'false',
      'true',
      'timeupdate',
      'pause',
      'play',
      'playing',
      'kept',
      'false',
      'false',
      'true',
      '2.5',
      'volumechange',
      'seeking',
      'timeupdate',
      'seeked',
    ].join(','),
  );
  assert.equal(player(), video, 'the same player, told');
  assert.equal(video.props.paused, false);
  assert.equal(video.props.muted, false);
  assert.deepEqual(sought, [2.5]);
});

test('a pause() before play()’s task turns its promise down, and volume, playbackRate and currentTime take what WebIDL lets them', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var v = document.createElement("video"), r = [];' +
      '["play", "playing", "pause", "timeupdate", "volumechange", "ratechange"].forEach(function (t) {' +
      '  v.addEventListener(t, function () { r.push(t) }) });' +
      'r.push(v.paused);' +
      'v.play().then(function () { r.push("kept") }, function (e) { r.push(e.name) });' +
      'v.pause();' +
      'try { v.volume = 2 } catch (e) { r.push(e.name) }' +
      'try { v.currentTime = NaN } catch (e) { r.push(e.name) }' +
      'v.volume = 0.5; v.playbackRate = 2; v.volume = 0.5;' +
      'r.push(v.volume, v.playbackRate, typeof v.onplay, typeof v.onvolumechange);' +
      'setTimeout(function () { document.getElementById("out").textContent = r.join(",") }, 0);' +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(
    text,
    [
      'true',
      'IndexSizeError',
      'TypeError',
      '0.5',
      '2',
      'object',
      'object',
      'play',
      'timeupdate',
      'pause',
      'AbortError',
      'volumechange',
      'ratechange',
    ].join(','),
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

test('a response made of a stream reads it to its end, as three.js’s loaders make one to count a download', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'function parts(chunks) { return new ReadableStream({ start: function (c) {' +
      '  chunks.forEach(function (x) { c.enqueue(x); }); c.close(); } }); }' +
      // FileLoader: the fetched body, read through a stream of its own
      'var glb = new Response(parts([new Uint8Array([103, 108]), new Uint8Array([84, 70, 2])]));' +
      'var twin = glb.clone();' +
      'var odd = new Response(parts(["text"]));' +
      'Promise.all([' +
      '  glb.arrayBuffer().then(function (b) { return [b instanceof ArrayBuffer, b.byteLength, new TextDecoder().decode(new Uint8Array(b, 0, 4))].join(","); }),' +
      '  twin.text(),' +
      '  glb.text().catch(function (e) { return e.name; }),' +
      '  odd.arrayBuffer().catch(function (e) { return e.name; }),' +
      '  new Response(parts([new Uint8Array([123, 125])])).json().then(function (j) { return typeof j; }),' +
      ']).then(function (got) {' +
      '  got.push(glb.bodyUsed);' +
      '  document.getElementById("out").textContent = got.join("|");' +
      '});' +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(text, 'true,5,glTF|glTF\u0002|TypeError|TypeError|object|true');
});

test('a canvas has a WebGL context of either version, which keeps what a page sets and draws nothing', async () => {
  const doc = await hosted(
    '<canvas id="a" width="30" height="20"></canvas><canvas id="b"></canvas><p id="out"></p><script>' +
      'var r = []; var a = document.getElementById("a"); var b = document.getElementById("b");' +
      'var gl = a.getContext("webgl2", { alpha: false, antialias: false });' +
      'r.push(gl instanceof WebGL2RenderingContext, gl instanceof WebGLRenderingContext,' +
      '  gl === a.getContext("webgl2"), a.getContext("2d"), a.getContext("webgl"));' +
      'r.push(gl.canvas === a, gl.drawingBufferWidth, gl.drawingBufferHeight,' +
      '  gl.TEXTURE_2D, WebGL2RenderingContext.RGBA8, gl.getParameter(gl.VERSION).slice(0, 9));' +
      'r.push(gl.getContextAttributes().alpha, gl.getContextAttributes().depth, gl.isContextLost(), gl.getError(), gl.getExtension("EXT_color_buffer_float"));' +
      // what three.js reads before it sets it
      'var vp = gl.getParameter(gl.VIEWPORT); r.push(vp instanceof Int32Array, Array.from(vp).join(" "));' +
      'gl.viewport(1, 2, 3, 4); gl.enable(gl.DEPTH_TEST); gl.clearColor(1, 0.5, 0, 1);' +
      'r.push(Array.from(gl.getParameter(gl.VIEWPORT)).join(" "), gl.isEnabled(gl.DEPTH_TEST), gl.getParameter(gl.COLOR_CLEAR_VALUE)[1]);' +
      // a shader compiles and a program links, with nothing active in it
      'var vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, "void main() {}"); gl.compileShader(vs);' +
      'var prog = gl.createProgram(); gl.attachShader(prog, vs); gl.linkProgram(prog);' +
      'r.push(gl.getShaderParameter(vs, gl.COMPILE_STATUS), gl.getShaderSource(vs), gl.getProgramParameter(prog, gl.LINK_STATUS),' +
      '  gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS), gl.getProgramParameter(prog, gl.ATTACHED_SHADERS), gl.getUniformLocation(prog, "u"));' +
      'var p = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT); r.push(p.precision, p instanceof WebGLShaderPrecisionFormat);' +
      // an object bound is read back, and unbound as it is deleted
      'var tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);' +
      'r.push(gl.getParameter(gl.TEXTURE_BINDING_2D) === tex, gl.isTexture(tex), Object.keys(tex).length);' +
      'gl.deleteTexture(tex); r.push(gl.isTexture(tex), gl.getParameter(gl.TEXTURE_BINDING_2D));' +
      'r.push(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, gl.clientWaitSync(gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), 0, 0) === gl.ALREADY_SIGNALED);' +
      'var px = new Uint8Array([9, 9, 9, 9]); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); r.push(px.join(""));' +
      'try { new WebGLTexture(); } catch (e) { r.push(e.name); }' +
      'try { WebGL2RenderingContext.prototype.getParameter.call({}, 0); } catch (e) { r.push(e.name); }' +
      'var one = b.getContext("experimental-webgl");' +
      'r.push(one instanceof WebGLRenderingContext, one === b.getContext("webgl"), b.getContext("webgl2"), one.getParameter(one.VERSION).slice(0, 9), typeof one.createVertexArray);' +
      "document.getElementById('out').textContent = r.join('|');" +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    [
      'true|false|true||',
      'true|30|20|3553|32856|WebGL 2.0',
      'false|true|false|0|',
      'true|0 0 30 20',
      '1 2 3 4|true|0.5',
      'true|void main() {}|true|0|1|',
      '23|true',
      'true|true|0',
      'false|',
      'true|true',
      '0000',
      'TypeError|TypeError',
      'true|true||WebGL 1.0|undefined',
    ].join('|'),
  );
});

test('a scroll container scrolls as a script sets it, reads back where it is, and is told its scroll', async () => {
  const doc = await hosted(
    '<style>body{margin:0}#s{height:100px;overflow:auto;border:2px solid;padding:3px}' +
      '.row{height:40px}#t{height:50px;overflow:hidden}</style>' +
      '<div id="s"><div class="row" id="r0"></div><div class="row"></div><div class="row"></div>' +
      '<div class="row"></div><div class="row" id="r4"></div><div class="row" id="r5"></div></div>' +
      '<div id="t"><div style="height:200px"></div><p id="deep">deep</p></div>' +
      '<p id="out"></p><script>' +
      'var r = []; var s = document.getElementById("s"); var heard = [];' +
      's.addEventListener("scroll", function (e) { heard.push(e.target.id + ":" + s.scrollTop + ":" + e.bubbles); });' +
      'document.addEventListener("scroll", function (e) { if (e.target !== document) heard.push("bubbled"); });' +
      'r.push(s.scrollTop, s.scrollHeight, s.clientHeight, s.clientTop);' +
      's.scrollTop = 50; r.push(s.scrollTop, Math.round(document.getElementById("r0").getBoundingClientRect().top));' +
      's.scrollTop = 9999; r.push(s.scrollTop);' +
      's.scrollTo({ top: 10 }); s.scrollBy(0, 5); r.push(s.scrollTop);' +
      // the row brought into view through the box it is in
      'document.getElementById("r5").scrollIntoView(); r.push(s.scrollTop);' +
      // as far down as the box it is in goes, which stops short of its top
      'var t = document.getElementById("t");' +
      'document.getElementById("deep").scrollIntoView(); r.push(Math.abs(t.scrollTop - (t.scrollHeight - t.clientHeight)) < 0.5);' +
      'r.push(document.getElementById("out").scrollTop, document.documentElement.scrollTop);' +
      'document.getElementById("out").textContent = r.join("|");' +
      'setTimeout(function () { setTimeout(function () { document.getElementById("out").textContent += "|" + heard.join(",") + "|" + s.clientWidth; }, 50); }, 50);' +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t.split('|').length > 13);
  // 6 rows of 40 and 3 of padding each side; a scrollport of 106 inside a
  // border of 2
  assert.equal(
    text,
    [
      0,
      246,
      106,
      2,
      50,
      2 + 3 - 50,
      140,
      15,
      140,
      true,
      0,
      0,
      's:140:false',
      396,
    ].join('|'),
  );
});

test('a resize observer is told a size as its target is observed and again each time its content box changes', async () => {
  const doc = await hosted(
    '<style>#box{width:100px;height:20px;padding:5px;border:2px solid}</style>' +
      '<div id="box"></div><div id="none" style="display:none"></div><p id="out"></p><script>' +
      'var seen = []; var box = document.getElementById("box");' +
      'var ro = new ResizeObserver(function (entries) { entries.forEach(function (e) {' +
      '  seen.push([e.target.id, e.contentRect.width, e.contentRect.height, e.contentRect.x, e.borderBoxSize[0].inlineSize].join(":")); }); });' +
      'ro.observe(box); ro.observe(document.getElementById("none"));' +
      'setTimeout(function () { box.style.height = "40px"; }, 150);' +
      'setTimeout(function () { document.getElementById("out").textContent = seen.join(",") + "|" + (typeof ResizeObserverEntry); }, 600);' +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  // nothing for what has no size, and nothing again for what did not move
  assert.equal(text, 'box:100:20:5:114,box:100:40:5:114|function');
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

// --- custom elements ---------------------------------------------------------

test('a custom element defined after the parse upgrades the ones in the document, in tree order, and its callbacks run as the tree changes', async () => {
  const doc = await hosted(
    '<x-one id="a" mode="m" other="o"><x-one id="b"></x-one></x-one>' +
      '<div id="host"></div><template id="t"><x-one id="inert"></x-one></template>' +
      '<p id="out"></p><script>' +
      'var r = [];' +
      'class XOne extends HTMLElement {' +
      '  static observedAttributes = ["mode"];' +
      '  constructor() { super(); r.push("new " + this.id + ":" + (this instanceof XOne)); }' +
      '  connectedCallback() { r.push("in " + this.id); }' +
      '  disconnectedCallback() { r.push("out " + this.id); }' +
      '  attributeChangedCallback(n, was, now) { r.push(this.id + "." + n + ":" + was + ">" + now); }' +
      '}' +
      'var a = document.getElementById("a");' +
      'r.push(a instanceof XOne, customElements.get("x-one"));' +
      'customElements.whenDefined("x-one").then(function (c) { r.push("defined " + (c === XOne)); out(); });' +
      'customElements.define("x-one", XOne);' +
      'r.push(a instanceof XOne, customElements.get("x-one") === XOne, customElements.getName(XOne));' +
      'a.setAttribute("mode", "n"); a.setAttribute("other", "p");' +
      'var c = document.createElement("x-one"); c.id = "c";' +
      'r.push(c instanceof XOne, c.isConnected);' +
      'document.getElementById("host").appendChild(c);' +
      'c.remove();' +
      'document.getElementById("host").innerHTML = "<x-one id=d></x-one>";' +
      'r.push(document.getElementById("t").content.firstChild instanceof XOne);' +
      'function out() { document.getElementById("out").textContent = r.join("|"); }' +
      '</script>',
  );
  await settle();
  assert.equal(
    doc.text('out'),
    [
      'false',
      '', // `get` of a name no one defined
      // the constructor first, then what its upgrade queued
      'new a:true',
      'a.mode:null>m',
      'in a',
      'new b:true',
      'in b',
      'true',
      'true',
      'x-one',
      'a.mode:m>n',
      'new :true',
      'true',
      'false',
      'in c',
      'out c',
      'new d:true',
      'in d',
      'false',
      'defined true',
    ].join('|'),
  );
});

test('an element put into the document by markup is upgraded only as it is connected, and a copy into the document at once', async () => {
  const doc = await hosted(
    '<div id="host"></div><p id="out"></p><script>' +
      'var r = [];' +
      'class XTwo extends HTMLElement { connectedCallback() { r.push("in " + this.id); } }' +
      'customElements.define("x-two", XTwo);' +
      'var held = document.createElement("div");' +
      'held.innerHTML = "<x-two id=a></x-two>";' +
      'r.push(held.firstChild instanceof XTwo);' +
      'document.getElementById("host").appendChild(held);' +
      'r.push(held.firstChild instanceof XTwo);' +
      'var copy = held.cloneNode(true);' +
      'r.push(copy.firstChild instanceof XTwo, copy.firstChild.isConnected);' +
      'var t = document.createElement("template"); t.innerHTML = "<x-two id=b></x-two>";' +
      'var own = t.content.cloneNode(true);' +
      'r.push(own.firstChild instanceof XTwo);' +
      'var imported = document.importNode(t.content, true);' +
      'r.push(imported.firstChild instanceof XTwo);' +
      'var made = new XTwo(); made.id = "e";' +
      'document.body.append(made);' +
      'class Stray extends HTMLElement {}' +
      'try { new Stray(); } catch (e) { r.push(e.name); }' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    'false|in a|true|true|false|false|true|in e|TypeError',
  );
});

test('a definition is checked as a browser checks it, and an element whose constructor throws is reported and left failed', async () => {
  const doc = await hosted(
    '<x-bad id="bad"></x-bad><p id="out"></p><script>' +
      'var r = [];' +
      'function name(f) { try { f(); r.push("ok"); } catch (e) { r.push(e.name); } }' +
      'class A extends HTMLElement {}' +
      'name(function () { customElements.define("nohyphen", A); });' +
      'name(function () { customElements.define("Up-per", A); });' +
      'name(function () { customElements.define("font-face", A); });' +
      'name(function () { customElements.define("x-a", function () {}.bind(null)); });' +
      'name(function () { customElements.define("x-a", () => {}); });' +
      'name(function () { customElements.define("x-a", A); });' +
      'name(function () { customElements.define("x-a", class extends HTMLElement {}); });' +
      'name(function () { customElements.define("x-b", A); });' +
      'name(function () { customElements.define("x-c", class extends HTMLElement {}, { extends: "x-a" }); });' +
      'customElements.whenDefined("nope").catch(function (e) { r.push("when " + e.name); out(); });' +
      'window.addEventListener("error", function (e) { r.push("reported " + e.error.message); });' +
      'class Bad extends HTMLElement { constructor() { super(); throw new Error("no"); } connectedCallback() { r.push("never"); } }' +
      'customElements.define("x-bad", Bad);' +
      'var bad = document.getElementById("bad");' +
      'r.push(bad instanceof Bad);' +
      'customElements.upgrade(document.body);' +
      'class Loud extends HTMLElement { constructor() { super(); this.setAttribute("a", "b"); } }' +
      'customElements.define("x-loud", Loud);' +
      'var loud = document.createElement("x-loud");' +
      'r.push(loud instanceof Loud, loud instanceof HTMLUnknownElement);' +
      'function out() { document.getElementById("out").textContent = r.join("|"); }' +
      '</script>',
  );
  await settle();
  assert.equal(
    doc.text('out'),
    [
      'SyntaxError',
      'SyntaxError',
      'SyntaxError',
      // a bound function is a constructor with no prototype
      'TypeError',
      'TypeError',
      'ok',
      'NotSupportedError',
      'NotSupportedError',
      'NotSupportedError',
      'reported no',
      // its `super()` had given it the class's prototype before it threw
      'true',
      "reported Failed to execute 'createElement' on 'Document': The result must not have attributes",
      'false',
      'true',
      'when SyntaxError',
    ].join('|'),
  );
  assert.ok(
    doc.logs.some((l) => l.startsWith('error: Uncaught Error: no')),
    doc.logs.join('\n'),
  );
});

test('a page with a doctype has the head and the body HTML implies, and a sheet put in the head applies', async () => {
  const doc = await hosted(
    '<!doctype html><title>t</title><p id="out"></p><div id="d"></div><script>' +
      'var r = [document.documentElement.localName, document.head.localName, document.body.localName,' +
      '  document.querySelector("title").parentNode === document.head, document.getElementById("d").parentNode === document.body];' +
      'var s = document.createElement("style"); s.textContent = "#d { width: 30px }"; document.head.append(s);' +
      'r.push(getComputedStyle(document.getElementById("d")).width);' +
      "document.getElementById('out').textContent = r.join('|');" +
      '</script>',
  );
  assert.strictEqual(
    await settled(doc, 'out', (t) => t !== ''),
    'html|head|body|true|true|30px',
  );
});

test('a scoped registry defines for the elements and shadow roots made with it, and a declarative root with none is initialized by a page', async () => {
  const doc = await hosted(
    '<p id="out"></p>' +
      '<div id="host"><template shadowrootmode="open" shadowrootcustomelementregistry><x-a id="inside"></x-a></template></div>' +
      '<script>' +
      'var r = []; var scoped = new CustomElementRegistry();' +
      'class XA extends HTMLElement {} scoped.define("x-a", XA);' +
      'r.push(customElements.get("x-a") === undefined, scoped.get("x-a") === XA, scoped !== customElements);' +
      // a constructor with no definition but a scoped one is no element
      'try { new XA(); } catch (e) { r.push(e.name); }' +
      'var made = document.createElement("x-a", { customElementRegistry: scoped });' +
      'r.push(made instanceof XA, made.customElementRegistry === scoped, document.createElement("x-a") instanceof XA);' +
      // a shadow root made with it upgrades what its markup makes
      'var root = document.createElement("div").attachShadow({ mode: "open", customElementRegistry: scoped });' +
      'root.innerHTML = "<x-a></x-a>"; r.push(root.firstChild instanceof XA, root.customElementRegistry === scoped);' +
      // a declarative root written with no registry has none until one is initialized
      'var host = document.getElementById("host").shadowRoot; var inside = host.firstChild;' +
      'r.push(host.customElementRegistry, inside.customElementRegistry, inside instanceof XA);' +
      'scoped.initialize(host); r.push(host.customElementRegistry === scoped, inside instanceof XA);' +
      'try { customElements.initialize(document); } catch (e) { r.push(e.name); }' +
      // an unknown name is an HTMLUnknownElement, and a document a page makes has no registry
      'r.push(document.createElement("nonexistent") instanceof HTMLUnknownElement, document.createElement("section") instanceof HTMLUnknownElement);' +
      'var made2 = new Document(); r.push(made2.customElementRegistry, made2.nodeType);' +
      "document.getElementById('out').textContent = r.join('|');" +
      '</script>',
  );
  assert.strictEqual(
    doc.text('out'),
    'true|true|true|TypeError|true|true|false|true|true|||false|true|true|NotSupportedError|true|false||9',
  );
});

test('setHTMLUnsafe takes a declarative shadow root where innerHTML does not, and a template reflects its shadow root attributes', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = []; var markup = "<span><template shadowrootmode=open><b>in</b></template></span>";' +
      'var a = document.createElement("div"); a.setHTMLUnsafe(markup);' +
      'r.push(!!a.firstChild.shadowRoot, a.firstChild.shadowRoot && a.firstChild.shadowRoot.textContent);' +
      'var b = document.createElement("div"); b.innerHTML = markup;' +
      'r.push(!!b.firstChild.shadowRoot, b.firstChild.firstChild.localName);' +
      'var t = document.createElement("template");' +
      'r.push(JSON.stringify(t.shadowRootMode), t.shadowRootCustomElementRegistry === "");' +
      't.shadowRootMode = "CLOSED"; t.shadowRootClonable = true; t.shadowRootCustomElementRegistry = "x";' +
      'r.push(t.shadowRootMode, t.getAttribute("shadowrootclonable"), t.getAttribute("shadowrootcustomelementregistry"));' +
      "document.getElementById('out').textContent = r.join('|');" +
      '</script>',
  );
  assert.strictEqual(
    doc.text('out'),
    'true|in|false|template|""|true|closed||x',
  );
});

test('a customized built-in is upgraded from its is, and attachInternals is a custom element’s once', async () => {
  const doc = await hosted(
    '<button is="x-press" id="b">b</button><p id="out"></p><script>' +
      'var r = [];' +
      'class Press extends HTMLButtonElement { connectedCallback() { r.push("in " + this.localName); } }' +
      'customElements.define("x-press", Press, { extends: "button" });' +
      'var b = document.getElementById("b");' +
      'r.push(b instanceof Press, b instanceof HTMLButtonElement);' +
      'var made = document.createElement("button", { is: "x-press" });' +
      'r.push(made instanceof Press);' +
      'class Field extends HTMLElement {' +
      '  static formAssociated = true;' +
      '  constructor() { super(); this.internals = this.attachInternals(); }' +
      '}' +
      'customElements.define("x-field", Field);' +
      'var f = document.createElement("x-field");' +
      'f.internals.states.add("on");' +
      'r.push(f.internals instanceof ElementInternals, f.internals.states.has("on"), f.internals.willValidate);' +
      'try { f.attachInternals(); } catch (e) { r.push(e.name); }' +
      'try { document.createElement("div").attachInternals(); } catch (e) { r.push(e.name); }' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    'in button|true|true|true|true|true|true|NotSupportedError|NotSupportedError',
  );
});

test('querySelector and matches answer the pseudo-classes a browser does, where css-select threw', async () => {
  const doc = await hosted(
    '<p id="t">t</p><x-not id="x"></x-not><details id="d" open><summary>s</summary></details>' +
      '<form id="f"><input id="req" required placeholder="p"><input id="ok" value="v"></form>' +
      '<p id="out"></p><script>' +
      'var r = [];' +
      'history.replaceState(null, "", "#t");' +
      'r.push(document.querySelector(":target").id);' +
      'r.push(document.querySelectorAll("x-not:not(:defined)").length, document.getElementById("t").matches(":defined"));' +
      'r.push(document.querySelector("details:open").id);' +
      'r.push(document.getElementById("req").matches(":invalid"), document.getElementById("ok").matches(":valid"));' +
      'r.push(document.querySelector(":placeholder-shown").id);' +
      'r.push(document.querySelectorAll(":popover-open, :modal, :state(on), :fullscreen").length);' +
      'customElements.define("x-not", class extends HTMLElement {});' +
      'r.push(document.getElementById("x").matches(":defined"));' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>',
  );
  assert.equal(doc.text('out'), 't|1|true|d|true|true|req|0|true');
});

test(':defined is false for a custom element no definition has upgraded, and restyles as one does', async () => {
  const doc = await hosted(
    '<style>x-late:not(:defined) { display: none } x-late:defined { color: rgb(1, 2, 3) }</style>' +
      '<x-late id="late">late</x-late><p id="plain">plain</p><p id="out"></p>' +
      '<input type="button" id="go" value="go"><script>' +
      'document.getElementById("go").addEventListener("click", function () {' +
      '  customElements.define("x-late", class extends HTMLElement {});' +
      '});</script>',
  );
  assert.equal(doc.view.computedStyle(doc.byId('late'))?.display, 'none');
  assert.ok(doc.view.computedStyle(doc.byId('plain')));
  await userEvent.click(screen.getByRole('button') as DrawnNode);
  await settle();
  assert.equal(doc.view.computedStyle(doc.byId('late'))?.color, 'rgb(1, 2, 3)');
});

test('showModal puts a dialog in the top layer: :modal matches it, it is centred in the viewport over all of the page, and close takes it out', async () => {
  const doc = await hosted(
    '<style>body{margin:0;font-size:16px}</style>' +
      '<div style="position:relative;z-index:9;transform:translateX(10px);overflow:hidden;width:50px;height:50px">' +
      '<dialog id="d"><div style="width:100px;height:30px"></div></dialog></div>' +
      '<p id="out"></p><script>' +
      'var d = document.getElementById("d"), r = [];' +
      'd.addEventListener("beforetoggle", function (e) { r.push("before:" + e.oldState + ">" + e.newState); });' +
      'd.addEventListener("toggle", function (e) { r.push("toggle:" + e.oldState + ">" + e.newState); });' +
      'd.addEventListener("close", function () { r.push("close:" + d.returnValue); });' +
      'd.showModal();' +
      'var b = d.getBoundingClientRect();' +
      'r.push(d.matches(":modal"), d.open, getComputedStyle(d).position, [b.x, b.y, b.width, b.height].join(","));' +
      'try { d.show(); } catch (e) { r.push(e.name); }' +
      'd.showModal();' +
      'r.push(document.querySelectorAll(":modal").length);' +
      'setTimeout(function () { d.close("done"); r.push(d.matches(":modal"), d.open, getComputedStyle(d).position);' +
      // taken out of the document, it is modal no more, and put back it
      // is open and not modal, as Chrome has it
      '  setTimeout(function () { d.showModal(); var p = d.parentNode; d.remove(); r.push("out:" + d.matches(":modal"));' +
      '    p.appendChild(d); r.push("back:" + d.matches(":modal") + ":" + d.open);' +
      '    setTimeout(function () { document.getElementById("out").textContent = r.join("|"); }, 0); }, 0); }, 0);' +
      '</script>',
    { pane: 300 },
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  // Chrome 152 in a 400 by 300 viewport: its padding and border round
  // what it holds, centred, out of the transformed, clipped box it is in;
  // `show()` on a modal one throws, and `showModal()` again does nothing;
  // `toggle` and `close` come in tasks of their own
  assert.equal(
    text,
    [
      'before:closed>open',
      'true',
      'true',
      'fixed',
      '131,116,138,68',
      'InvalidStateError',
      '1',
      'toggle:closed>open',
      'before:open>closed',
      'false',
      'false',
      'absolute',
      'toggle:open>closed',
      'close:done',
      'before:closed>open',
      'out:false',
      'back:false:true',
      'toggle:closed>open',
    ].join('|'),
  );
  assert.equal(doc.view.computedStyle(doc.byId('d'))?.position, 'absolute');
});

test('Escape the page lets be closes the last modal dialog opened, after a cancel it may cancel, and gives the focus back', async () => {
  const doc = await hosted(
    '<input type="button" id="opener" value="open">' +
      '<dialog id="a"><button id="in-a">a</button></dialog>' +
      '<dialog id="b"><button id="in-b">b</button></dialog>' +
      '<p id="out"></p><script>' +
      'var r = [], a = document.getElementById("a"), b = document.getElementById("b");' +
      'function push(x) { r.push(x); document.getElementById("out").textContent = r.join("|"); }' +
      'var keep = true;' +
      'b.addEventListener("cancel", function (e) { push("cancel:b:" + e.cancelable); if (keep) { keep = false; e.preventDefault(); } });' +
      'a.addEventListener("cancel", function () { push("cancel:a"); });' +
      'for (const d of [a, b]) d.addEventListener("close", function () {' +
      '  push("close:" + d.id + ":" + document.querySelectorAll(":modal").length + ":" + document.activeElement.id);' +
      '});' +
      'document.getElementById("opener").addEventListener("click", function () {' +
      '  a.showModal(); b.showModal(); push(document.activeElement.id);' +
      '});' +
      '</script>',
    { pane: 300 },
  );
  await userEvent.click(screen.getByRole('button') as DrawnNode);
  await settle();
  const escape = async () => {
    await userEvent.key(XK_ESCAPE);
    await settle();
  };
  // the first Escape is cancelled, the second closes b, the third a
  await escape();
  assert.equal(doc.byId('b').attribs.open, '', 'cancelled, b stays open');
  await escape();
  assert.equal(doc.byId('b').attribs.open, undefined);
  assert.equal(doc.byId('a').attribs.open, '');
  await escape();
  assert.equal(doc.byId('a').attribs.open, undefined);
  assert.equal(
    doc.text('out'),
    'in-b|cancel:b:true|cancel:b:true|close:b:1:in-a|cancel:a|close:a:0:opener',
  );
});

test('popovers show and hide as their kind has them: auto ones nested or closing the others, manual ones alone, hints under them, with beforetoggle and toggle', async () => {
  const doc = await hosted(
    '<div id="a" popover>A<div id="a-child" popover>child</div></div>' +
      '<div id="b" popover>B</div><div id="m" popover="manual">M</div>' +
      '<div id="h" popover="hint">H</div><div id="x" popover="bogus"></div>' +
      '<p id="out"></p><script>' +
      'var r = [];' +
      'function log(e) { r.push(e.type + ":" + e.target.id + ":" + e.oldState + ">" + e.newState); }' +
      'var ids = ["a", "a-child", "b", "m", "h"];' +
      'var els = ids.map(function (id) { var el = document.getElementById(id);' +
      '  el.addEventListener("beforetoggle", log); el.addEventListener("toggle", log); return el; });' +
      'var a = els[0], child = els[1], b = els[2], m = els[3], h = els[4];' +
      'r.push([a.popover, m.popover, h.popover, document.getElementById("x").popover, String(document.getElementById("out").popover)].join(","));' +
      'a.showPopover(); child.showPopover();' +
      'r.push(a.matches(":popover-open") + "," + child.matches(":popover-open"));' +
      'm.showPopover(); h.showPopover(); b.showPopover();' +
      'r.push(els.map(function (e) { return e.matches(":popover-open") ? 1 : 0; }).join(""));' +
      'r.push(b.togglePopover(), b.togglePopover(true));' +
      'try { document.createElement("div").showPopover(); } catch (e) { r.push(e.name); }' +
      'try { var d = document.createElement("div"); d.popover = "auto"; d.showPopover(); } catch (e) { r.push(e.name); }' +
      'r.push([getComputedStyle(m).display, getComputedStyle(a).display, getComputedStyle(m).position].join(","));' +
      // a hint nested in nothing outlives the auto popover hidden after it
      'h.showPopover(); b.hidePopover(); r.push(h.matches(":popover-open"));' +
      'setTimeout(function () { document.getElementById("out").textContent = r.join("|"); }, 20);' +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(
    text,
    [
      'auto,manual,hint,manual,null',
      'beforetoggle:a:closed>open',
      // nested in `a`, which stays
      'beforetoggle:a-child:closed>open',
      'true,true',
      'beforetoggle:m:closed>open',
      'beforetoggle:h:closed>open',
      // an auto popover nested in nothing, once its own beforetoggle is not
      // cancelled, closes the hint and the other auto ones, the last
      // first, and leaves the manual one
      'beforetoggle:b:closed>open',
      'beforetoggle:h:open>closed',
      'beforetoggle:a-child:open>closed',
      'beforetoggle:a:open>closed',
      '00110',
      'beforetoggle:b:open>closed',
      'beforetoggle:b:closed>open',
      'false',
      'true',
      'NotSupportedError',
      'InvalidStateError',
      'block,none,fixed',
      'beforetoggle:h:closed>open',
      'beforetoggle:b:open>closed',
      'true',
      // one `toggle` a popover, from where it was before its first change
      'toggle:a:closed>closed',
      'toggle:a-child:closed>closed',
      'toggle:m:closed>open',
      'toggle:h:closed>open',
      'toggle:b:closed>closed',
    ].join('|'),
    doc.logs.join('\n'),
  );
});

metric(
  'a popovertarget button toggles its popover, a press outside dismisses it, Escape hides it, and a dialog closes as its closedby has it',
  async () => {
    const doc = await hosted(
      '<style>body{margin:0}</style>' +
        '<button id="t" popovertarget="p" style="display:block;width:80px;height:20px">toggle</button>' +
        '<div id="p" popover>popover</div>' +
        '<p id="far" style="margin-top:150px">far</p>' +
        '<dialog id="d" closedby="any">any</dialog><dialog id="n">none</dialog>' +
        '<p id="out"></p><script>' +
        'var r = [], d = document.getElementById("d"), n = document.getElementById("n");' +
        'r.push(document.getElementById("t").popoverTargetElement.id, document.getElementById("t").popoverTargetAction, d.closedBy, n.closedBy);' +
        'document.getElementById("out").textContent = r.join("|");' +
        '</script>',
    );
    const node = doc.view as unknown as DrawnNode;
    const press = async (id: string) => {
      const rect = doc.view.elementRect(doc.byId(id))!;
      await act(async () => {
        const dx = rect.x + rect.width / 2 - node.abs.width / 2;
        const dy = rect.y + rect.height / 2 - node.abs.height / 2;
        fireEvent.mouseDown(node, { dx, dy });
        fireEvent.mouseUp(node, { dx, dy });
      });
      await settle();
    };
    const open = (id: string) =>
      doc.view.computedStyle(doc.byId(id))?.display !== 'none';
    assert.equal(doc.text('out'), 'p|toggle|any|none');
    await press('t');
    assert.ok(open('p'), 'the button showed it');
    // a press on the button is no press outside the popover it targets
    await press('t');
    assert.ok(!open('p'), 'the button hid it');
    await press('t');
    await press('far');
    assert.ok(!open('p'), 'a press outside dismissed it');
    await press('t');
    await userEvent.key(XK_ESCAPE);
    await settle();
    assert.ok(!open('p'), 'Escape hid it');
    // a modeless dialog closed by any press outside it, and one closed by
    // nothing; shown modal, a dialog is closed by a close request
    await act(() => doc.run('document.getElementById("d").show()'));
    await press('far');
    assert.equal(doc.byId('d').attribs.open, undefined, 'closedby=any');
    await act(() => doc.run('document.getElementById("n").show()'));
    await userEvent.key(XK_ESCAPE);
    await settle();
    assert.equal(doc.byId('n').attribs.open, '', 'closedby=none');
    await act(() =>
      doc.run(
        'n.close(); n.showModal(); document.getElementById("out").textContent = n.closedBy;',
      ),
    );
    assert.equal(doc.text('out'), 'closerequest');
    await userEvent.key(XK_ESCAPE);
    await settle();
    assert.equal(doc.byId('n').attribs.open, undefined, 'a modal one');
  },
);

test('a modal dialog with nothing in it to focus keeps the keys in the document, and Escape closes it', async () => {
  const doc = await hosted(
    '<input type="button" id="opener" value="open">' +
      '<dialog id="d"><p>Loading…</p></dialog><p id="out"></p><script>' +
      'var d = document.getElementById("d");' +
      'd.addEventListener("close", function () { document.getElementById("out").textContent = "closed"; });' +
      'document.getElementById("opener").addEventListener("click", function () { d.showModal(); });' +
      '</script>',
    { pane: 300 },
  );
  await userEvent.click(screen.getByRole('button') as DrawnNode);
  await settle();
  assert.equal(doc.byId('d').attribs.open, '');
  // the button that opened it is the page's, which the dialog blocks, and
  // has no widget to hold the focus any more
  assert.equal(screen.queryAllByRole('button').length, 0);
  await userEvent.key(XK_ESCAPE);
  await settle();
  assert.equal(doc.byId('d').attribs.open, undefined);
  assert.equal(doc.text('out'), 'closed');
});

test('a dialog open by its attribute is one of the open dialogs, last where a script set it, so Escape closes it where its closedby lets it and stops at one it does not', async () => {
  // HTML 4.11.4, the dialog's attribute change steps: parsed open, it is
  // there from the start; `open` set by a script makes it the last opened
  const doc = await hosted(
    '<dialog id="a" closedby="any" open>a</dialog><dialog id="b" closedby="any">b</dialog>' +
      '<dialog id="c" closedby="none" open>c</dialog><p id="out"></p><script>' +
      'var r = [];' +
      '["a", "b", "c"].forEach(function (id) { document.getElementById(id).addEventListener("close", function () {' +
      '  r.push(id); document.getElementById("out").textContent = r.join("|"); }); });' +
      'document.getElementById("b").open = true;' +
      '</script>',
  );
  // the document has the focus, as a press on it would give it
  await act(async () => void (doc.view.parent as unknown as DrawnNode).focus());
  await userEvent.key(XK_ESCAPE);
  await settle();
  assert.equal(doc.text('out'), 'b');
  await userEvent.key(XK_ESCAPE);
  await settle();
  // `c` is no dialog Escape closes, and it takes the request all the same:
  // `a`, open before it, stays open
  assert.equal(doc.text('out'), 'b');
  assert.equal(doc.byId('a').attribs.open, '');
  assert.equal(doc.byId('c').attribs.open, '');
});

test('a page keeps its own session history: pushState and replaceState, a fragment, and traversal with popstate and hashchange', async () => {
  const doc = await hosted(
    '<p id="out"></p><div id="x"></div><script>' +
      'var r = [];' +
      'window.addEventListener("popstate", function (e) { r.push("pop " + JSON.stringify(e.state) + " " + location.hash); });' +
      'window.addEventListener("hashchange", function (e) { r.push("hash " + e.newURL.split("#")[1]); });' +
      'window.onload = function () {' +
      '  history.pushState({ a: 1 }, "", "#one"); r.push(history.length, JSON.stringify(history.state), location.hash);' +
      '  history.replaceState({ a: 2 }, "", "#two"); r.push(history.length, JSON.stringify(history.state));' +
      '  try { history.pushState(null, "", "https://other.example/"); } catch (e) { r.push(e.name); }' +
      '  location.hash = "x"; r.push(history.length);' +
      '  setTimeout(function () { history.back(); setTimeout(function () { history.go(-1);' +
      "    setTimeout(function () { document.getElementById('out').textContent = r.join('|'); }, 30); }, 30); }, 30);" +
      '};' +
      '</script>',
  );
  assert.strictEqual(
    await settled(doc, 'out', (t) => t !== ''),
    [
      '2',
      '{"a":1}',
      '#one',
      '2',
      '{"a":2}',
      'SecurityError',
      '3',
      'hash x',
      'pop {"a":2} #two',
      'hash two',
      'pop null ',
      // the first entry's URL has no fragment
      'hash undefined',
    ].join('|'),
  );
  // a fragment the page navigated to is told to the host, as it was
  assert.deepStrictEqual(doc.links, [`${PAGE}#x`]);
});

test('navigation is the page’s entries, and navigate() fires navigate, which a listener intercepts, cancels or lets go', async () => {
  const doc = await hosted(
    '<p id="out"></p><a id="link" href="elsewhere">go</a><script>' +
      'var r = [];' +
      'navigation.addEventListener("currententrychange", function (e) { r.push("change " + e.navigationType); });' +
      'navigation.addEventListener("navigatesuccess", function () { r.push("success"); });' +
      'navigation.addEventListener("navigateerror", function (e) { r.push("error " + e.error.name); });' +
      'window.onload = async function () {' +
      '  r.push(navigation.entries().length, navigation.currentEntry.index, navigation.canGoBack);' +
      // a fragment: navigate, the entry, success
      '  navigation.onnavigate = function (e) { r.push("navigate " + e.navigationType + " " + e.hashChange + " " + e.canIntercept); };' +
      '  var res = navigation.navigate("#a", { state: { s: 1 }, info: "i" });' +
      '  var entry = await res.committed; r.push(entry.index, JSON.stringify(entry.getState()));' +
      '  await res.finished;' +
      // another path, kept in the page by its handler
      '  navigation.onnavigate = function (e) { e.intercept({ handler: function () { return new Promise(function (ok) { setTimeout(ok, 10); }); } }); };' +
      '  await navigation.navigate("kept").finished; r.push(location.pathname.split("/").pop(), navigation.entries().length);' +
      // canceled: rejected, and nothing changes
      '  navigation.onnavigate = function (e) { e.preventDefault(); };' +
      '  try { await navigation.navigate("#b").committed; } catch (e) { r.push("rejected " + e.name); }' +
      '  navigation.onnavigate = null;' +
      '  navigation.updateCurrentEntry({ state: 5 }); r.push(navigation.currentEntry.getState());' +
      '  await navigation.back().finished; r.push(navigation.currentEntry.index, location.hash);' +
      // a link a listener intercepts stays in the page, and the host follows none
      '  navigation.onnavigate = function (e) { r.push("link " + (e.sourceElement && e.sourceElement.id)); e.intercept(); };' +
      '  document.getElementById("link").click();' +
      "  setTimeout(function () { document.getElementById('out').textContent = r.join('|'); }, 30);" +
      '};' +
      '</script>',
  );
  assert.strictEqual(
    await settled(doc, 'out', (t) => t !== ''),
    [
      '1',
      '0',
      'false',
      'navigate push true true',
      'change push',
      // with no handler, success is a microtask queued in navigate() itself
      // (WebIDL's "wait for all"), ahead of what awaits `committed`
      'success',
      '1',
      '{"s":1}',
      'change push',
      'success',
      'kept',
      '3',
      'error AbortError',
      'rejected AbortError',
      'change null',
      '5',
      'change traverse',
      'success',
      '1',
      '#a',
      'link link',
      'change push',
      'success',
    ].join('|'),
  );
  assert.deepStrictEqual(
    doc.links,
    [`${PAGE}#a`],
    'the host heard of the fragment, and of neither the kept path nor the link',
  );
});

test('a frame’s initial about:blank has no entries and tells no navigation, and a push from it is refused', async () => {
  // HTML 7.2.6.1, "has entries and events disabled"
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var i = document.createElement("iframe"); document.body.append(i);' +
      'var w = i.contentWindow, r = [];' +
      'w.navigation.onnavigate = function () { r.push("navigate"); };' +
      'r.push(w.navigation.entries().length, String(w.navigation.currentEntry), w.navigation.canGoBack);' +
      'w.navigation.navigate("#1");' +
      'w.navigation.navigate("#2", { history: "push" }).committed.catch(function (e) {' +
      '  r.push(e.name); document.getElementById("out").textContent = r.join("|"); });' +
      '</script>',
  );
  assert.strictEqual(
    await settled(doc, 'out', (t) => t !== ''),
    '0|null|false|NotSupportedError',
  );
});

test('navigateerror says where a handler threw, pushState is no hash change, and a navigation started from navigateerror is aborted in turn', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = [];' +
      'window.onload = function () { setTimeout(function () {' +
      '  var err = new TypeError("no");' +
      '  navigation.onnavigate = function (e) { e.intercept({ handler: function () { return Promise.reject(err); } }); };' +
      '  navigation.onnavigateerror = function (e) {' +
      '    r.push(e.error === err, e.message, e.filename === location.href.split("#")[0], e.lineno > 0);' +
      // the order of three navigations, the second started as the first fails
      '    navigation.onnavigate = function (e) { r.push("nav " + new URL(e.destination.url).hash + " " + e.hashChange); };' +
      '    navigation.onnavigateerror = function () { r.push("error " + location.hash); if (location.hash === "#b") location.href = "#d"; };' +
      '    navigation.onnavigatesuccess = function () { r.push("success " + location.hash); document.getElementById("out").textContent = r.join("|"); };' +
      '    history.pushState(null, "", "#b"); location.href = "#c";' +
      '  };' +
      '  location.href = "#a";' +
      '}, 0); };' +
      '</script>',
  );
  assert.strictEqual(
    await settled(doc, 'out', (t) => t !== ''),
    [
      'true',
      'TypeError: no',
      'true',
      'true',
      // pushState's navigate is no hash change, a fragment's is
      'nav #b false',
      'error #b',
      'nav #d true',
      'error #d',
      'nav #c true',
      'success #c',
    ].join('|'),
  );
});

test('an intercepted navigation scrolls where it ends, a traversal restores where its entry was scrolled to, and the transition lasts through navigatesuccess', async () => {
  const doc = await hosted(
    '<p id="out"></p><div style="height:3000px"></div><div id="frag">f</div><div style="height:3000px"></div><script>' +
      'var r = [];' +
      'window.onload = function () { setTimeout(async function () {' +
      '  r.push(scrollY);' +
      '  await navigation.navigate("#frag").finished; var at = scrollY; r.push(at > 0);' +
      // back, kept in the page: the handler runs before the scroll is
      // restored, and the transition is there while navigatesuccess is told
      '  navigation.onnavigate = function (e) { e.intercept({ handler: function () { r.push("handler " + (scrollY === at)); } }); };' +
      '  navigation.onnavigatesuccess = function () { r.push("success " + !!navigation.transition); };' +
      '  await navigation.back().finished; r.push(scrollY, navigation.transition);' +
      '  navigation.onnavigatesuccess = null;' +
      // a push the page scrolls itself, once and no more
      '  var ev; navigation.onnavigate = function (e) { ev = e; e.intercept({ scroll: "manual", handler: function () { return new Promise(function (ok) { setTimeout(ok, 10); }); } }); };' +
      '  var res = navigation.navigate("#frag"); await res.committed; r.push(scrollY);' +
      '  ev.scroll(); r.push(scrollY === at); await res.finished;' +
      '  try { ev.scroll(); } catch (e) { r.push(e.name); }' +
      '  history.scrollRestoration = "manual"; history.scrollRestoration = "x"; r.push(history.scrollRestoration);' +
      "  document.getElementById('out').textContent = r.join('|');" +
      '}, 0); };' +
      '</script>',
    { pane: 300 },
  );
  assert.strictEqual(
    await settled(doc, 'out', (t) => t !== ''),
    '0|true|handler true|success true|0||0|true|InvalidStateError|manual',
  );
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

test('a body is extracted as Fetch has it: bytes sent as they are, a stream read to its end, its type implied, and read back as a form', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = []; var step = function (p) { return p.then(function (v) { r.push(v); }, function (e) { r.push(typeof e === "string" ? e : e.name + ":" + e.message.slice(0, 12)); }); };' +
      'var bin = new Uint8Array([0, 255, 128, 10]);' +
      'var stream = function () { return new ReadableStream({ start: function (c) { c.enqueue(new Uint8Array([104, 105])); c.close(); } }); };' +
      'r.push(new Response("a").headers.get("content-type"), new Response(new URLSearchParams("a=1")).headers.get("content-type"),' +
      '  new Response(new Blob(["x"], { type: "text/x" })).headers.get("content-type"), new Response(bin).headers.get("content-type"),' +
      '  new Request("u", { method: "POST", body: "b" }).headers.get("content-type"));' +
      'try { new Request("u", { method: "POST", body: stream() }); } catch (e) { r.push(e.name); }' +
      'var c = new AbortController(); c.abort("mine");' +
      'step(fetch("bin", { method: "POST", body: bin }).then(function (res) { return res.status; }))' +
      '.then(function () { return step(fetch("stream", { method: "POST", body: stream(), duplex: "half" }).then(function (res) { return res.status; })); })' +
      '.then(function () { return step(fetch("get", { body: "b" })); })' +
      '.then(function () { return step(fetch("aborted", { signal: c.signal })); })' +
      '.then(function () { var fd = new FormData(); fd.append("a", "1"); fd.append("f", new File(["xy"], "f.txt", { type: "text/plain" }));' +
      '  return new Response(fd).formData().then(function (back) { return back.get("a") + "," + back.get("f").name + "," + back.get("f").size; }); })' +
      '.then(function (v) { r.push(v); return new Response(new URLSearchParams("p=1&q=2")).formData(); })' +
      '.then(function (back) { r.push(back.get("q")); var url = URL.createObjectURL(new Blob(["abcdefgh"], { type: "text/plain" }));' +
      '  return Promise.all([fetch(url, { headers: { Range: "bytes=2-4" } }), fetch(url, { headers: { Range: "bytes=-3" } }), fetch(url, { headers: { Range: "bytes=9-" } }).catch(function (e) { return e.name; })]); })' +
      '.then(function (all) { return Promise.all([all[0].text(), all[1].text()]).then(function (texts) {' +
      '  r.push(all[0].status, all[0].headers.get("content-range"), texts[0], all[1].headers.get("content-range"), texts[1], all[2]); }); })' +
      ".then(function () { document.getElementById('out').textContent = r.join('|'); });" +
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
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded;charset=UTF-8',
      'text/x',
      // no type for bytes, which join() writes as nothing
      '',
      'text/plain;charset=UTF-8',
      'TypeError',
      '200',
      '200',
      'TypeError:Failed to ex',
      'mine',
      '1,f.txt,2',
      '2',
      '206',
      'bytes 2-4/8',
      'cde',
      'bytes 5-7/8',
      'fgh',
      'TypeError',
    ].join('|'),
  );
  const [bin, stream] = doc.fetched;
  // bytes that are no UTF-8 cross as they are, and a stream as its bytes
  assert.deepEqual([...(bin.bytes ?? [])], [0, 255, 128, 10]);
  assert.equal(bin.body, '');
  assert.equal(stream.body, 'hi');
  assert.equal(doc.fetched.length, 2);
});

test('an abort cancels a stream body with its reason, and a stream body answered 401 is a network error', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = []; var show = function () { document.getElementById("out").textContent = r.join("|"); };' +
      'var cancelled = new Promise(function (res) {' +
      '  var stream = new ReadableStream({ cancel: function (reason) { res(reason); } });' +
      '  var c = new AbortController();' +
      '  fetch("up", { method: "POST", body: stream, duplex: "half", signal: c.signal }).then(null, function (e) { r.push("rejected " + e); });' +
      '  c.abort("foo abort");' +
      '});' +
      'cancelled.then(function (reason) { r.push("cancelled " + reason);' +
      '  var body = new ReadableStream({ start: function (c) { c.close(); } });' +
      '  return fetch("auth", { method: "POST", body: body, duplex: "half" }); })' +
      '.then(function () { r.push("401 resolved"); }, function (e) { r.push(e.name); })' +
      '.then(function () { return fetch("auth", { method: "POST", body: "x" }); })' +
      '.then(function (res) { r.push(res.status); show(); });' +
      '</script>',
    {
      answer: (request) => ({
        url: request.url,
        status: request.url.endsWith('auth') ? 401 : 200,
        statusText: '',
        redirected: false,
        headers: [],
        body: '',
      }),
    },
  );
  assert.equal(
    await settled(doc, 'out', (t) => t !== ''),
    'rejected foo abort|cancelled foo abort|TypeError|401',
  );
});

test('headers keep to their guard, a response is made as Fetch makes one, and a data: URL is answered in the page', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = []; var t = function (f) { try { r.push(f()); } catch (e) { r.push(e.name); } };' +
      't(function () { return new Request("u", { headers: { Cookie: "c", "X-A": "1" } }).headers.has("cookie"); });' +
      't(function () { var h = new Request("u", { mode: "no-cors", headers: { Range: "bytes=0-1", Accept: "a" } }).headers; return h.has("range") + "," + h.get("accept"); });' +
      't(function () { return new Request("u", { mode: "no-cors", method: "PUT" }); });' +
      't(function () { var h = new Headers([["b", " 2 "], ["a", "1"]]); return Array.from(h.keys()).join("") + h.get("b"); });' +
      't(function () { return new Headers({ "bad name": "x" }); });' +
      't(function () { return Response.error().headers.set("a", "b"); });' +
      't(function () { var e = Response.error(); return e.type + e.status; });' +
      't(function () { var x = Response.redirect("/to", 301); return x.status + x.headers.get("location"); });' +
      't(function () { return Response.redirect("/to", 200); });' +
      't(function () { return new Response("", { status: 99 }); });' +
      't(function () { return new Response("x", { status: 204 }); });' +
      't(function () { return Response.json({ a: 1 }).headers.get("content-type"); });' +
      't(function () { return new Response("", { headers: { "Set-Cookie": "a=1" } }).headers.has("set-cookie"); });' +
      'Promise.all([fetch("data:text/plain;charset=US-ASCII,a%2Cb", { headers: { Range: "bytes=0-0" } }), fetch("data:;base64,aGk="), fetch("data:,x%"), fetch("data:;base64,a")["catch"](function (e) { return e.name; })])' +
      '.then(function (all) { return Promise.all([all[0].text(), all[1].text(), all[2].text()]).then(function (texts) {' +
      '  r.push(all[0].status, all[0].headers.get("content-type"), texts[0], all[1].headers.get("content-type"), texts[1], texts[2], all[3]); }); })' +
      '.then(function () { var url = URL.createObjectURL(new Blob(["abc"])); return fetch(url, { headers: { Range: "bytes=1-" } }); })' +
      ".then(function (res) { r.push(JSON.stringify(res.headers.get('content-type'))); document.getElementById('out').textContent = r.join('|'); });" +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(
    text,
    [
      'false',
      'false,a',
      'TypeError',
      'ab2',
      'TypeError',
      'TypeError',
      'error0',
      `301${new URL('/to', PAGE).href}`,
      'RangeError',
      'RangeError',
      'TypeError',
      'application/json',
      'false',
      '200',
      'text/plain;charset=US-ASCII',
      'a,b',
      // a type of nothing, once its base64 is taken off, is the default
      'text/plain;charset=US-ASCII',
      'hi',
      'x%',
      'TypeError',
      '""',
    ].join('|'),
  );
  assert.equal(doc.fetched.length, 0);
});

test('el.style keeps a clip-path shape() in its canonical form, and does not set one the property does not take', async () => {
  const doc = await hosted(
    '<p id="out"></p><div id="t"></div><script>' +
      'var t = document.getElementById("t"); var r = [];' +
      't.style.clipPath = "shape(from top left, line to 0 1px)"; r.push(t.style.clipPath);' +
      't.style.clipPath = "shape(from 0 0 line to 1px 1px)"; r.push(t.style.clipPath);' +
      't.style.setProperty("clip-path", "shape(from 0 0)"); r.push(t.style.getPropertyValue("clip-path"));' +
      'r.push(CSS.supports("clip-path", "shape(from 0 0, close)"), CSS.supports("clip-path: shape(from 0 0)"));' +
      "document.getElementById('out').textContent = r.join('|');" +
      '</script>',
  );
  assert.strictEqual(
    await settled(doc, 'out', (t) => t !== ''),
    'shape(from left top, line to 0px 1px)|shape(from left top, line to 0px 1px)|' +
      'shape(from left top, line to 0px 1px)|true|false',
  );
});

test('CSS.registerProperty registers as @property does, checking what it is given; an attr() in a style reads the attribute as it changes', async () => {
  const doc = await hosted(
    '<p id="out"></p><div id="t" data-w="12"></div><script>' +
      'var t = document.getElementById("t"); var r = [];' +
      'function fails(d) { try { CSS.registerProperty(d); return "ok"; } catch (e) { return e.name; } }' +
      'r.push(fails({ name: "--a", syntax: "<length>", inherits: false, initialValue: "3px" }));' +
      'r.push(fails({ name: "--a", syntax: "<length>", inherits: false, initialValue: "3px" }));' +
      'r.push(fails({ name: "b", inherits: false }), fails({ name: "--c", syntax: "<length", inherits: false, initialValue: "1px" }));' +
      'r.push(fails({ name: "--d", syntax: "<length>", inherits: false }), fails({ name: "--e", syntax: "<length>", inherits: false, initialValue: "1em" }));' +
      'r.push(fails({ name: "--f", syntax: "<length>", inherits: false, initialValue: "red" }), fails({ name: "--g" }));' +
      'r.push(getComputedStyle(t).getPropertyValue("--a"));' +
      // an attr() in the style attribute reads the attribute each time it
      // changes, with the style text as it was
      't.style.width = "attr(data-w px)"; r.push(getComputedStyle(t).width);' +
      't.setAttribute("data-w", "30"); r.push(getComputedStyle(t).width);' +
      't.style.width = ""; t.setAttribute("data-w", "7"); t.style.width = "attr(data-w px"; r.push(t.style.width, getComputedStyle(t).width);' +
      // a pseudo-element no rule styles has its element's inherited style
      't.style.fontSize = "20px"; r.push(getComputedStyle(t, "::after").fontSize);' +
      "document.getElementById('out').textContent = r.join('|');" +
      '</script>',
  );
  assert.strictEqual(
    await settled(doc, 'out', (t) => t !== ''),
    'ok|InvalidModificationError|SyntaxError|SyntaxError|SyntaxError|SyntaxError|SyntaxError|TypeError|' +
      '3px|12px|30px|attr(data-w px)|7px|20px',
  );
});

test(':muted matches a muted media element, by its attribute or a script’s say, and :volume-locked none', async () => {
  const doc = await hosted(
    '<p id="out"></p><video id="v"></video><audio id="a" muted></audio><script>' +
      'var v = document.getElementById("v"), a = document.getElementById("a"); var r = [];' +
      'r.push(CSS.supports("selector(:muted)"), CSS.supports("selector(:volume-locked)"));' +
      'r.push(v.matches(":muted"), a.matches(":muted"), document.querySelectorAll(":volume-locked").length);' +
      'v.muted = true; a.muted = false;' +
      'r.push(v.matches(":muted"), a.matches(":muted"), document.querySelector("video:not(:muted)"));' +
      // the page's say holds whatever the attribute comes to
      'v.removeAttribute("muted"); r.push(v.matches(":muted"));' +
      'var made = document.createElement("video"); made.setAttribute("muted", ""); r.push(made.muted, made.matches(":muted"));' +
      "document.getElementById('out').textContent = r.join('|');" +
      '</script>',
  );
  assert.strictEqual(
    await settled(doc, 'out', (t) => t !== ''),
    'true|true|false|true|0|true|false||true|true|true',
  );
});

test('the page’s selection is the reader’s: getSelection() answers what the reader selected, and what the page selects is drawn and copied', async () => {
  const doc = await hosted('<p id="out"></p><p id="t">hello world</p>');
  // the reader selects, and the page reads it
  // the surface is `<Html>`'s selectable box around the document
  const surface = doc.view.parent as unknown as DrawnNode;
  await act(async () => void surface.selectAll());
  doc.run(
    'var s = getSelection(); document.getElementById("out").textContent = [s.toString(), s.anchorNode.nodeType, s.type].join("|");',
  );
  assert.equal(
    await settled(doc, 'out', (t) => t !== ''),
    'hello world|3|Range',
  );
  // the page selects, and the reader has it: drawn, and what a copy takes
  doc.run(
    'var t = document.getElementById("t").firstChild; getSelection().setBaseAndExtent(t, 6, t, 11);',
  );
  await settled(doc, 'out', () => surface.selectedText() === 'world');
  assert.equal(surface.selectedText(), 'world');
  // a caret draws nothing: the reader's selection is none
  doc.run('getSelection().collapseToStart();');
  await settled(doc, 'out', () => surface.selectedText() === '');
  assert.equal(surface.selectedText(), '');
});

test('a text field’s selection is what a script set, kept to its value, and told as select; a type with none says null and refuses one', async () => {
  const doc = await hosted(
    '<p id="out"></p><input id="i" value="hello"><textarea id="t">abc</textarea><input id="n" type="number" value="5">' +
      '<script>' +
      'var i = document.getElementById("i"), t = document.getElementById("t"), n = document.getElementById("n"); var r = []; var told = 0;' +
      'i.addEventListener("select", function () { told += 1; });' +
      'i.select(); r.push(i.selectionStart, i.selectionEnd, i.selectionDirection);' +
      'i.setSelectionRange(4, 2, "backward"); r.push(i.selectionStart, i.selectionEnd, i.selectionDirection);' +
      'i.setSelectionRange(1, 99); r.push(i.selectionEnd);' +
      'i.value = "hi"; r.push(i.selectionStart, i.selectionEnd);' +
      't.setSelectionRange(1, 2); r.push(t.value.substring(t.selectionStart, t.selectionEnd));' +
      'r.push(n.selectionStart);' +
      'try { n.setSelectionRange(0, 1); } catch (e) { r.push(e.name); }' +
      'setTimeout(function () { r.push(told > 0); ' +
      "  document.getElementById('out').textContent = r.join('|'); }, 20);" +
      '</script>',
  );
  assert.strictEqual(
    await settled(doc, 'out', (t) => t !== ''),
    '0|5|none|2|2|backward|5|2|2|b||InvalidStateError|true',
  );
});

test('a response resolves at its headers and its body arrives as the network hands it on, and an abort or a cancel lets the network go', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const letGo: string[] = [];
  const text = (t: string) => new TextEncoder().encode(t);
  // a body of two chunks, the second waiting on `held`, or on nothing ever
  const chunks = (name: string, second: Promise<void> | null) => ({
    [Symbol.asyncIterator]() {
      let step = 0;
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          step += 1;
          if (step === 1) return { done: false, value: text('one ') };
          if (step === 2) {
            await (second ?? new Promise(() => {}));
            return { done: false, value: text('two') };
          }
          return { done: true, value: undefined };
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          letGo.push(name);
          return { done: true, value: undefined };
        },
      };
    },
  });
  const doc = await hosted(
    '<p id="out"></p><script>' +
      "var log = []; var show = function () { document.getElementById('out').textContent = log.join('|'); };" +
      'var dec = new TextDecoder();' +
      'fetch("slow").then(function (res) { log.push("headers " + res.status); show();' +
      '  var reader = res.body.getReader();' +
      '  var pump = function () { return reader.read().then(function (r) { if (r.done) { log.push("done"); show(); return; } log.push(dec.decode(r.value)); show(); return pump(); }); };' +
      '  return pump(); });' +
      'var c = new AbortController();' +
      'fetch("hang", { signal: c.signal }).then(function (res) { var reader = res.body.getReader();' +
      '  return reader.read().then(function (r) { log.push("first " + dec.decode(r.value)); c.abort("stop"); return reader.read(); }); })' +
      '.then(null, function (e) { log.push("aborted " + e); show(); });' +
      'fetch("cancel").then(function (res) { return res.body.cancel(); }).then(function () { log.push("cancelled"); show(); });' +
      '</script>',
    {
      answer: (request) => {
        const name = new URL(request.url).pathname.split('/').pop()!;
        assert.equal(request.stream, true);
        return {
          url: request.url,
          status: 200,
          statusText: 'OK',
          redirected: false,
          headers: [],
          body: '',
          chunks: chunks(name, name === 'slow' ? held : null),
        };
      },
    },
  );
  const before = await settled(
    doc,
    'out',
    (t) =>
      t.includes('one ') && t.includes('aborted') && t.includes('cancelled'),
  );
  // the first chunk is read while the second is still to come
  assert.ok(before.includes('headers 200'), before);
  assert.ok(!before.includes('two'), before);
  assert.ok(before.includes('first one |aborted stop'), before);
  release();
  const after = await settled(doc, 'out', (t) => t.includes('done'));
  assert.ok(after.endsWith('|two|done'), after);
  assert.deepEqual(letGo.sort(), ['cancel', 'hang']);
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

test('getAll, getAllKeys and getAllRecords take a query, a count and a direction, as arguments or as a dictionary', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = []; var out = document.getElementById("out");' +
      'var open = indexedDB.open("all", 1);' +
      'open.onupgradeneeded = function () {' +
      '  var s = open.result.createObjectStore("s"); s.createIndex("by-v", "v");' +
      '  ["a", "b", "c", "d"].forEach(function (k, i) { s.put({ v: i < 2 ? 1 : 2 }, k); });' +
      '};' +
      'open.onsuccess = function () {' +
      '  var s = open.result.transaction("s").objectStore("s"); var ix = s.index("by-v");' +
      '  function keys(req, label) { req.onsuccess = function () { r.push(label + "=" + req.result.join(",")); }; }' +
      '  keys(s.getAllKeys(IDBKeyRange.bound("b", "d"), 2), "args");' +
      '  keys(s.getAllKeys({ direction: "prev", count: 3 }, 1), "dict");' +
      '  keys(ix.getAllKeys({ direction: "nextunique" }), "nextunique");' +
      '  keys(ix.getAllKeys({ direction: "prevunique" }), "prevunique");' +
      '  try { s.getAll({ direction: "sideways" }); } catch (e) { r.push(e.name); }' +
      '  try { s.getAll(undefined, -1); } catch (e) { r.push(e.name); }' +
      '  try { s.getAll({ query: [{}] }); } catch (e) { r.push(e.name); }' +
      '  var req = ix.getAllRecords({ query: 2, direction: "prev" });' +
      '  req.onsuccess = function () {' +
      '    var rec = req.result[0];' +
      '    r.push(Object.prototype.toString.call(rec), rec.key + "/" + rec.primaryKey + "/" + rec.value.v, req.result.length, "key" in rec);' +
      '    out.textContent = r.join("|");' +
      '  };' +
      '};' +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(
    text,
    [
      'TypeError',
      'TypeError',
      'DataError',
      'args=b,c',
      // the dictionary's count, and the one after it ignored
      'dict=d,c,b',
      // the first record of each key, and from the last key back
      'nextunique=a,c',
      'prevunique=c,a',
      '[object IDBRecord]',
      '2/d/2',
      '2',
      'true',
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

metric(
  'a box fixed to the viewport, and what is in it, is measured where it is drawn however far the pane has scrolled the page',
  async () => {
    // What Chrome answers of the same page, scrolled 0 and 500px (CSSOM
    // View 6.1): a fixed box stays where the viewport is, and one a
    // transformed box holds scrolls with the document. Measured where
    // layout put it, at the document's top, the header read -470 at 500
    const doc = await hosted(
      whole(
        '.tall { height: 2000px }' +
          '#bar { position: fixed; top: 30px; left: 40px; width: 100px; height: 20px; padding: 2px }' +
          '#in { margin-left: 5px; width: 10px; height: 4px }' +
          '#tf { transform: translateX(7px); position: absolute; top: 600px; left: 0 }' +
          '#held { position: fixed; top: 3px; left: 4px; width: 6px; height: 6px }',
        '<div class="tall"></div>' +
          '<div id="bar"><div id="in"></div><span id="sp">x</span></div>' +
          '<div id="flow" style="position: absolute; top: 520px; left: 9px; width: 8px; height: 8px"></div>' +
          '<div id="tf"><div id="held"></div></div>' +
          '<p id="out"></p><script>' +
          'var seen = [];' +
          "window.addEventListener('scroll', function () {" +
          "  seen.push(scrollY + ' ' + ['bar', 'in', 'flow', 'held'].map(function (id) {" +
          '    var r = document.getElementById(id).getBoundingClientRect();' +
          "    return id + ':' + [r.left, r.top, r.width, r.height].join(' ');" +
          "  }).join(',') + ' sp:' + Math.round(document.getElementById('sp').getBoundingClientRect().top)" +
          "    + ' at:' + document.elementFromPoint(45, 35).id);" +
          "  document.getElementById('out').textContent = seen.join('|');" +
          '});' +
          '</script>',
      ),
      { pane: 300 },
    );
    await act(async () => doc.scrolled());
    await settled(doc, 'out', (t) => t !== '');
    await act(async () => doc.pane!.scrollTo(500));
    await act(async () => doc.scrolled());
    assert.deepEqual(
      (await settled(doc, 'out', (t) => t.includes('|'))).split('|'),
      [
        '0 bar:40 30 104 24,in:47 32 10 4,flow:9 520 8 8,held:11 603 6 6 sp:36 at:bar',
        '500 bar:40 30 104 24,in:47 32 10 4,flow:9 20 8 8,held:11 103 6 6 sp:36 at:bar',
      ],
    );
  },
);

for (const scale of [1, 2]) {
  test(`a box fixed to the viewport is measured where the page's own scroll has it, before the pane is laid out again, at scale ${scale}`, async () => {
    // What Chrome 152 answers of the same page at 400x300: a page's
    // `scrollTo` moves the pane at once, and the next pass moves what is
    // in it. Measured in between, the header read -470 at 500, where it
    // had been drawn at the scroll before, and a point read the
    // document where it had been
    const doc = await hosted(
      whole(
        '.tall { height: 2000px }' +
          '#bar { position: fixed; top: 30px; left: 40px; width: 100px; height: 20px }' +
          '#flow { position: absolute; top: 520px; left: 9px; width: 8px; height: 8px }',
        '<div class="tall"></div><div id="bar"></div><div id="flow"></div>' +
          '<p id="out"></p><script>' +
          'var done = false;' +
          "window.addEventListener('scroll', function () {" +
          '  if (done) return;' +
          '  done = true;' +
          '  scrollTo(0, 500);' +
          "  var r = document.getElementById('bar').getBoundingClientRect();" +
          "  document.getElementById('out').textContent = [scrollY, r.left, r.top," +
          '    document.elementFromPoint(45, 35).id,' +
          "    document.elementFromPoint(12, 22).id].join(' ');" +
          '});' +
          '</script>',
      ),
      { pane: 300, scale },
    );
    await act(async () => doc.scrolled());
    assert.equal(
      await settled(doc, 'out', (t) => t !== ''),
      '500 40 30 bar flow',
    );
    // and the pass after it draws them there
    assert.equal(doc.pane!.scrollY, 500 * scale);
    const bar = doc.handle.elementRect(doc.byId('bar'))!;
    assert.deepEqual([bar.x, bar.y], [40, 530]);
  });
}

for (const scale of [1, 2]) {
  test(`a sticky box the viewport holds is measured where the page's own scroll has it, before the pane is laid out again, at scale ${scale}`, async () => {
    // What Chrome 152 answers of the same page at 400x300: the header is
    // held at the viewport's top as soon as the page has scrolled, and a
    // point there finds it. Placed for where the last pass put the
    // document, it read -492 — where the flow has it, scrolled away — and
    // the point found nothing
    const doc = await hosted(
      whole(
        '.tall { height: 2000px }' +
          '#head { position: sticky; top: 0; height: 20px }',
        '<div id="head"></div><div class="tall" id="tall"></div>' +
          '<p id="out"></p><script>' +
          'var done = false;' +
          "window.addEventListener('scroll', function () {" +
          '  if (done) return;' +
          '  done = true;' +
          '  scrollTo(0, 500);' +
          "  var r = document.getElementById('head').getBoundingClientRect();" +
          "  document.getElementById('out').textContent = [scrollY, r.left, r.top," +
          '    document.elementFromPoint(20, 10).id,' +
          "    document.elementFromPoint(20, 30).id].join(' ');" +
          '});' +
          '</script>',
      ),
      { pane: 300, scale },
    );
    await act(async () => doc.scrolled());
    assert.equal(
      await settled(doc, 'out', (t) => t !== ''),
      '500 8 0 head tall',
    );
    // and the pass after it draws it there
    assert.equal(doc.pane!.scrollY, 500 * scale);
    const head = doc.handle.elementRect(doc.byId('head'))!;
    assert.deepEqual([head.x, head.y], [8, 500]);
  });
}

for (const scale of [1, 2]) {
  fontMetric(
    `a box fixed to the viewport of a right-to-left pane is measured where the pane's scroll has it, before and after the pass, at scale ${scale}`,
    async () => {
      // A right-to-left pane scrolls from the right: its offset moves what
      // it holds the other way, and the measure follows it that way too
      const source =
        '<style>body{margin:0}#bar{position:fixed;top:10px;left:40px;' +
        'width:20px;height:20px}</style><div id="bar"></div>' +
        '<div style="height:2000px"></div>';
      await renderX11(
        h(
          'box',
          {
            'data-testname': 'pane',
            style: {
              width: 400,
              height: 200,
              overflow: 'scroll',
              flexDirection: 'row',
              direction: 'rtl',
            },
          },
          h(Html, {
            source,
            partial: false,
            style: { width: 1000, flexShrink: 0 },
            'data-testname': 'doc',
          }),
        ),
        { width: 440, height: 300, fonts: FONTS!, scale },
      );
      await act();
      const root = screen.getByTestName('doc') as unknown as {
        children: HtmlViewNode[];
      };
      const el = root.children[0];
      const pane = screen.getByTestName('pane') as DrawnNode & {
        scrollX: number;
        scrollTo(to: { x?: number; y?: number }): void;
      };
      const bar = () => findById(el.document, 'bar') as DocElement;
      // at the start, the pane shows the document's right-hand end
      assert.equal(el.elementRect(bar())!.x, 640);
      let between: number | undefined;
      await act(async () => {
        pane.scrollTo({ x: 200 });
        between = el.elementRect(bar())!.x;
      });
      assert.equal(pane.scrollX, 200 * scale);
      assert.equal(between, 440, 'measured before the pass');
      assert.equal(el.elementRect(bar())!.x, 440, 'and after it');
    },
  );
}

fontMetric(
  'a point is read where the pane has scrolled the document since a pass that only copied it',
  async () => {
    // A pane scrolling a document narrower than it copies what it shows
    // and paints the strip the scroll brought in, which misses the
    // document: that pass moved it, and only the copy asked it anything
    // (`viewportFixedRects`). A point read after the next `scrollTo` was
    // read where the document had been before that one
    const rows = Array.from({ length: 20 }, (_, i) => `<div id="d${i}"></div>`);
    await renderX11(
      h(
        'box',
        {
          'data-testname': 'pane',
          style: {
            width: 400,
            height: 300,
            overflow: 'scroll',
            flexDirection: 'column',
          },
        },
        h(Html, {
          source: `<style>body{margin:0}div{height:10px}</style>${rows.join('')}`,
          partial: false,
          style: { width: 200, flexGrow: 0 },
          'data-testname': 'doc',
        }),
        h('box', { style: { height: 2000, flexShrink: 0 } }),
      ),
      { width: 440, height: 400, fonts: FONTS! },
    );
    await act();
    const root = screen.getByTestName('doc') as unknown as {
      children: HtmlViewNode[];
    };
    const el = root.children[0];
    const pane = screen.getByTestName('pane') as DrawnNode & {
      scrollTo(y: number): void;
    };
    await act(async () => pane.scrollTo(10));
    await act();
    let between: string | undefined;
    await act(async () => {
      pane.scrollTo(100);
      between = el.elementAtPoint(5, 5)?.attribs.id;
    });
    assert.equal(between, 'd10', 'read before the pass');
    assert.equal(el.elementAtPoint(5, 5)?.attribs.id, 'd10', 'and after it');
  },
);

metric(
  'a box fixed to the viewport, and what is in it, is brought into view without scrolling the page, and through a scroll container inside it alone',
  async () => {
    // What Chrome 152 answers of the same page at 400 by 300, each step
    // from 500px down (CSSOM View 7.1): the viewport's scroll moves no box
    // fixed to it, nor a scroll container outside one, so neither scrolls
    // for it, and a scroll container inside a fixed box still scrolls what
    // it holds. A fixed box a transformed box holds scrolls with the
    // document. The viewport had scrolled for the bar as though it moved
    // with the page: 530 for its start, 250 for its end
    const doc = await hosted(
      whole(
        '.tall { height: 2000px }' +
          '#bar { position: fixed; top: 30px; left: 40px; width: 100px; height: 20px }' +
          '#tf { transform: translateX(7px); position: absolute; top: 600px; left: 0 }' +
          '#held { position: fixed; top: 3px; left: 4px; width: 6px; height: 6px }' +
          '#side { position: fixed; top: 0; right: 0; width: 80px; height: 100px; overflow: auto }' +
          '#side div { height: 50px }' +
          '#sc { position: absolute; top: 900px; left: 200px; width: 80px; height: 100px; overflow: auto }' +
          '#fx { position: fixed; top: 60px; left: 300px; width: 5px; height: 5px }' +
          '.pad { height: 300px }',
        '<div class="tall"></div>' +
          '<div id="bar"><div id="in"></div></div>' +
          '<div id="flow" style="position: absolute; top: 520px; left: 9px; width: 8px; height: 8px"></div>' +
          '<div id="tf"><div id="held"></div></div>' +
          '<div id="side"><div></div><div></div><div></div><div id="item"></div><div></div></div>' +
          '<div id="sc"><div class="pad"></div><div id="fx"></div><div class="pad"></div></div>' +
          '<p id="out"></p><script>' +
          'var side = document.getElementById("side"), sc = document.getElementById("sc");' +
          'function into(id, arg) {' +
          '  scrollTo(0, 500); side.scrollTop = 0; sc.scrollTop = 100;' +
          '  document.getElementById(id).scrollIntoView(arg);' +
          '  return id + ":" + [scrollY, side.scrollTop, sc.scrollTop].join(" ");' +
          '}' +
          'var steps = [' +
          '  ["bar"], ["bar", { block: "nearest" }], ["bar", false],' +
          '  ["in", { block: "center" }], ["flow"], ["held"],' +
          '  ["held", { block: "end" }], ["item"], ["fx"]' +
          '], seen = [];' +
          // a step a scroll, each from a pane the test has laid out at 500
          'window.addEventListener("scroll", function () {' +
          '  if (seen.length === steps.length) return;' +
          '  seen.push(into.apply(null, steps[seen.length]));' +
          '  document.getElementById("out").textContent = seen.join("|");' +
          '});' +
          '</script>',
      ),
      { pane: 300 },
    );
    for (let i = 1; i <= 9; i += 1) {
      await act(async () => doc.pane!.scrollTo(500));
      await act(async () => doc.scrolled());
      await settled(doc, 'out', (t) => t !== '' && t.split('|').length === i);
    }
    assert.deepEqual(doc.text('out').split('|'), [
      'bar:500 0 100',
      'bar:500 0 100',
      'bar:500 0 100',
      'in:500 0 100',
      'flow:520 0 100',
      'held:603 0 100',
      'held:309 0 100',
      'item:500 150 100',
      'fx:500 0 100',
    ]);
  },
);

metric(
  'a box positioned against something outside a scroll container is brought into view without scrolling that container',
  async () => {
    // What Chromium 151, Firefox 153 and WebKit 26.5 answer of the same
    // page at 400 by 300, each step from everything at 0 (CSSOM View 7.1):
    // a scroll container is scrolled only where its scroll moves the box,
    // which it does not for one positioned against something outside it,
    // nor for what that box holds. A container further out that does move
    // it still scrolls, and so does one that is the box's containing block.
    // `sc` and `sc2` had been scrolled to 300 for boxes they never move
    const doc = await hosted(
      whole(
        'body { margin: 0 }' +
          '.tall { height: 2000px }' +
          '#outer, #outer2 { position: relative }' +
          '#sc, #sc2 { overflow: auto; height: 100px; width: 100px }' +
          '.pad { height: 400px }' +
          '#abs, #abs2, #abs3 { position: absolute; top: 300px; left: 0; width: 5px; height: 5px }' +
          '#kid { height: 2px }' +
          '#big { overflow: auto; height: 150px; width: 200px }' +
          '.after { height: 600px }' +
          '#sc3 { position: relative; overflow: auto; height: 100px; width: 100px }',
        '<div id="outer"><div id="sc"><div class="pad"></div><div id="abs"><div id="kid"></div></div></div></div>' +
          '<div id="big"><div id="outer2"><div id="sc2"><div class="pad"></div><div id="abs2"></div></div></div><div class="after"></div></div>' +
          '<div id="sc3"><div class="pad"></div><div id="abs3"></div></div>' +
          '<div class="tall"></div>' +
          '<p id="out"></p><script>' +
          'var all = ["sc", "sc2", "big", "sc3"].map(function (id) { return document.getElementById(id); });' +
          'function into(id, arg) {' +
          '  scrollTo(0, 0); all.forEach(function (e) { e.scrollTop = 0; });' +
          '  document.getElementById(id).scrollIntoView(arg);' +
          '  return id + ":" + [scrollY].concat(all.map(function (e) { return e.scrollTop; })).join(" ");' +
          '}' +
          'var steps = [["abs"], ["kid"], ["abs", { block: "end" }], ["abs2"], ["abs3"]], seen = [];' +
          // a step a scroll, each from a pane the test has laid out at 0
          'window.addEventListener("scroll", function () {' +
          '  if (seen.length === steps.length) return;' +
          '  seen.push(into.apply(null, steps[seen.length]));' +
          '  document.getElementById("out").textContent = seen.join("|");' +
          '});' +
          '</script>',
      ),
      { pane: 300 },
    );
    for (let i = 1; i <= 5; i += 1) {
      await act(async () => doc.pane!.scrollTo(0));
      await act(async () => doc.scrolled());
      await settled(doc, 'out', (t) => t !== '' && t.split('|').length === i);
    }
    assert.deepEqual(doc.text('out').split('|'), [
      'abs:300 0 0 0 0',
      'kid:300 0 0 0 0',
      'abs:5 0 0 0 0',
      'abs2:100 0 0 300 0',
      'abs3:250 0 0 0 300',
    ]);
  },
);

/** A page's script reporting what the offset attributes answer of the
 *  elements it names: `id:offsetParent left top width height`, the parent
 *  by its id or its tag. */
const OFFSETS =
  'function offsets(ids) { return ids.map(function (id) {' +
  '  var e = document.getElementById(id), p = e.offsetParent;' +
  "  return id + ':' + (p ? p.id || p.tagName : null) + ' ' + [e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight].join(' ');" +
  "}).join('|') }";

/** A whole document, as Chrome's page is: a fragment's root box only
 *  stands in for a `<body>` the document does not have. */
const whole = (style: string, body: string) =>
  `<!doctype html><html><head><style>${style}</style></head><body>${body}</body></html>`;

/** A click on the document's corner, and the turns after it: what a page
 *  that measures on a click measures at, once `<Html>` is laid out at its
 *  width rather than the probe a script run in the parse can see. */
async function clickCorner(doc: Hosted) {
  const node = doc.view as unknown as DrawnNode;
  await act(async () => {
    const dx = 2 - node.abs.width / 2;
    const dy = node.abs.height / 2 - 2;
    fireEvent.mouseDown(node, { dx, dy });
    fireEvent.mouseUp(node, { dx, dy });
  });
  await settle();
}

metric(
  'offsetParent is the nearest positioned element, a cell or a table, or the body, and the offsets are from its padding edge',
  async () => {
    // what Chrome answers of the same page (CSSOM View 7)
    const doc = await hosted(
      whole(
        '#rel { position: relative; margin: 10px 0 0 20px; border: 3px solid; padding: 5px 7px }' +
          '.in { margin-left: 11px; width: 50px; height: 10px }' +
          'table { border-spacing: 2px; border: 4px solid }' +
          'td { padding: 6px; border: 1px solid }' +
          '#fix { position: fixed; top: 30px; left: 40px; width: 10px; height: 10px }' +
          '#none { display: none }',
        '<div id="rel"><div class="in" id="relIn"></div>' +
          '<div class="in" id="relAbs" style="position: absolute; left: 13px; top: 17px"></div></div>' +
          '<table id="tbl"><tr><td id="td">' +
          '<div id="inTd" style="margin-left: 3px; width: 4px; height: 5px"></div>' +
          '<div id="relInTd" style="position: relative; width: 7px; height: 5px"></div>' +
          '</td></tr></table>' +
          '<div id="fix"></div><div id="none"><div id="noneKid"></div></div>' +
          '<div id="dc" style="display: contents; position: relative"><div id="inDc" style="height: 3px"></div></div>' +
          '<p id="out"></p><script>' +
          OFFSETS +
          "document.addEventListener('click', function () { document.getElementById('out').textContent = offsets(['rel', 'relIn', 'relAbs', 'tbl', 'td', 'inTd', 'relInTd', 'fix', 'none', 'noneKid', 'dc', 'inDc'])" +
          " + '|body:' + document.body.offsetParent + ' ' + document.body.offsetLeft + ' ' + document.body.offsetTop + ' ' + document.body.offsetWidth" +
          " + '|html:' + document.documentElement.offsetParent });" +
          '</script>',
      ),
    );
    await clickCorner(doc);
    assert.deepEqual(doc.text('out').split('|'), [
      // the body is not positioned: from the document's corner
      'rel:BODY 28 10 364 26',
      // from the padding edge, inside the border
      'relIn:rel 18 5 50 10',
      'relAbs:rel 24 17 50 10',
      'tbl:BODY 8 36 33 36',
      'td:tbl 2 2 21 24',
      'inTd:td 9 6 4 5',
      // a positioned element passes over the cell and the table
      'relInTd:BODY 21 54 7 5',
      // fixed to the viewport: none, and from the viewport's corner
      'fix:null 40 30 10 10',
      'none:null 0 0 0 0',
      'noneKid:null 0 0 0 0',
      // no box, so no offsets, and passed over as no containing block
      'dc:null 0 0 0 0',
      'inDc:BODY 8 72 384 3',
      'body:null 0 0 384',
      'html:null',
    ]);
  },
);

metric(
  'the offsets are where layout put a box, before a transform turned, scaled or moved it or a scroll moved it',
  async () => {
    const doc = await hosted(
      whole(
        '#tr { transform: translate(15px, 5px); width: 30px; height: 10px }' +
          '#sc { transform: scale(2); transform-origin: 0 0; width: 50px; height: 10px; border: 1px solid }' +
          '#scroller { overflow: auto; height: 40px; border: 2px solid }' +
          '#scroller div { height: 30px }' +
          '#tf { transform: translateX(10px); border: 2px solid; padding: 1px; height: 60px }' +
          '#rel { position: relative; margin-left: 6px; border: 1px solid; height: 30px }' +
          '#fx { position: fixed; top: 4px; left: 5px; width: 5px; height: 5px }',
        '<div id="tr"></div>' +
          '<div id="sc"><div id="inSc" style="height: 3px; margin-left: 2px"></div></div>' +
          '<div id="scroller"><div></div><div id="inScroll"></div><div></div><div></div></div>' +
          '<div id="tf"><div id="rel"><div id="fx"></div></div></div>' +
          '<p id="out"></p><script>' +
          OFFSETS +
          "var tr = document.getElementById('tr'), sc = document.getElementById('sc');" +
          "var s = document.getElementById('scroller'), inScroll = document.getElementById('inScroll');" +
          'var r = tr.getBoundingClientRect(), before = inScroll.offsetTop, top0 = inScroll.getBoundingClientRect().top;' +
          's.scrollTop = 25;' +
          "document.getElementById('out').textContent = [" +
          "  (r.left - tr.offsetLeft) + ',' + (r.top - tr.offsetTop)," +
          '  sc.getBoundingClientRect().width,' +
          "  offsets(['tr', 'sc', 'inSc'])," +
          "  (inScroll.offsetTop - before) + ',' + (top0 - inScroll.getBoundingClientRect().top)," +
          // a fixed box's is its containing block, past the positioned
          // element between
          "  offsets(['fx'])].join('|');" +
          '</script>',
      ),
    );
    assert.deepEqual(doc.text('out').split('|'), [
      '15,5',
      '104',
      'tr:BODY 8 8 30 10',
      'sc:BODY 8 18 52 12',
      'inSc:sc 2 0 48 3',
      '0,25',
      'fx:tf 5 4 5 5',
    ]);
  },
);

metric(
  'an offset parent in a shadow tree the element is not in is passed over, open or closed, and the element is measured through it',
  async () => {
    // Chrome's answers, where the spec's words pass over a closed one alone
    const tree = (mode: string, id: string) =>
      `<div><template shadowrootmode="${mode}">` +
      '<div style="position: relative; padding: 5px; border: 2px solid"><slot></slot></div>' +
      `</template><div id="${id}" style="height: 4px"></div></div>`;
    const doc = await hosted(
      whole(
        '',
        tree('closed', 'closed') +
          tree('open', 'open') +
          '<p id="out"></p><script>' +
          OFFSETS +
          "document.addEventListener('click', function () { document.getElementById('out').textContent = offsets(['closed', 'open']) });" +
          '</script>',
      ),
    );
    await clickCorner(doc);
    assert.equal(
      doc.text('out'),
      'closed:BODY 13 13 370 4|open:BODY 13 31 370 4',
    );
  },
);

test("a custom property keeps its name's case, in an element's style and in its computed style", async () => {
  // as Chrome reads them: `--Pad` and `--pad` are two properties
  const doc = await hosted(
    '<style>:root { --Pad:  .25rem } #e { --own: 3px; --b: var(--own) }</style>' +
      '<div id="e"></div><p id="out"></p><script>' +
      "var e = document.getElementById('e');" +
      "e.style.setProperty('--Slider-X', '5px'); e.style.setProperty('COLOR', 'red');" +
      'var cs = getComputedStyle(e);' +
      "document.getElementById('out').textContent = JSON.stringify([" +
      "  e.getAttribute('style'), e.style.getPropertyValue('--Slider-X'), e.style.getPropertyValue('--slider-x')," +
      "  e.style.getPropertyValue('Color'), cs.getPropertyValue('--Pad'), cs.getPropertyValue('--pad')," +
      "  cs.getPropertyValue('--b'), cs.getPropertyValue('--own'), cs.getPropertyValue('--Slider-X')," +
      "  cs.getPropertyValue('--nope'), cs['--Pad']]);" +
      '</script>',
  );
  assert.deepEqual(JSON.parse(doc.text('out')), [
    '--Slider-X: 5px; color: red;',
    '5px',
    '',
    'red',
    '.25rem',
    '',
    // its `var()` replaced, by the element's own `--own`
    '3px',
    '3px',
    '5px',
    '',
    null,
  ]);
});

metric(
  "a tab strip measures its selected tab to size and place its pill, and slides it to the one pressed, as Primer's <Tabs> does",
  async () => {
    // Primer Brand's: the pill is placed from the selected tab's
    // `offsetLeft`, less the strip's padding as a custom property gives it
    // in rem, and sized from its `offsetWidth`, through custom properties
    // named in camel case; the strip scrolls the tab to its middle
    const doc = await hosted(
      '<style>' +
        // a browser's 16px to the rem, which Primer's script takes for granted
        '* { box-sizing: border-box } :root { font-size: 16px; --Tabs-container-padding: .25rem }' +
        '#wrap { margin-left: 30px; width: 260px }' +
        '#list { display: flex; gap: 4px; padding: var(--Tabs-container-padding); position: relative; width: fit-content; max-width: 100%; overflow: auto hidden }' +
        '.tab { padding: 8px 24px; white-space: nowrap; border: 0; z-index: 1 }' +
        '#pill { position: absolute; top: 4px; bottom: 4px; width: var(--Tabs-slider-width); transform: translateX(var(--Tabs-slider-x, 0px)); border: 1px solid }' +
        '</style>' +
        '<div id="wrap"><div id="list" role="tablist">' +
        '<button class="tab" role="tab" aria-selected="true" id="t0">Delegate to agents</button>' +
        '<button class="tab" role="tab" aria-selected="false" id="t1">Review</button>' +
        '<button class="tab" role="tab" aria-selected="false" id="t2">Ship it</button>' +
        '<div id="pill"></div></div></div><script>' +
        "var list = document.getElementById('list'), pill = document.getElementById('pill');" +
        "function pad() { return 16 * parseFloat(getComputedStyle(list).getPropertyValue('--Tabs-container-padding')) }" +
        'function selected() { return list.querySelector(\'[aria-selected="true"]\') }' +
        'function place() {' +
        '  var e = selected();' +
        "  pill.style.setProperty('--Tabs-slider-x', (e.offsetLeft - pad()) + 'px');" +
        "  pill.style.setProperty('--Tabs-slider-width', e.offsetWidth + 'px') }" +
        'function reveal() {' +
        '  var e = selected();' +
        '  var t = Math.max(0, Math.min(e.offsetLeft - pad() + e.offsetWidth / 2 - list.clientWidth / 2, list.scrollWidth - list.clientWidth));' +
        "  list.scrollTo({ left: t, behavior: 'smooth' }) }" +
        "list.addEventListener('click', function (ev) {" +
        "  var tab = ev.target.closest('[role=tab]'); if (!tab) return;" +
        "  [].forEach.call(list.querySelectorAll('[role=tab]'), function (t) { t.setAttribute('aria-selected', String(t === tab)) });" +
        // measured again once the strip scrolled, as Primer's
        // ResizeObserver does: an offset is where layout put the tab
        '  place(); reveal(); place() });' +
        'place(); reveal();' +
        '</script>',
    );
    const rect = (id: string) => doc.view.elementRect(doc.byId(id))!;
    const lined = (tab: string) => {
      const pill = rect('pill');
      const of = rect(tab);
      assert.ok(
        Math.abs(pill.x - of.x) <= 0.5 &&
          Math.abs(pill.width - of.width) <= 0.5,
        `the pill ${JSON.stringify(pill)} is over ${tab} ${JSON.stringify(of)}`,
      );
    };
    lined('t0');
    assert.ok(rect('t0').width > 100, 'the pill is as wide as the tab');

    // the second tab, past the strip's middle, which it scrolls to
    const node = doc.view as unknown as DrawnNode;
    const t1 = rect('t1');
    await act(async () => {
      const dx = t1.x + 10 - node.abs.width / 2;
      const dy = t1.y + t1.height / 2 - node.abs.height / 2;
      fireEvent.mouseDown(node, { dx, dy });
      fireEvent.mouseUp(node, { dx, dy });
    });
    await settle();
    assert.equal(doc.byId('t1').attribs['aria-selected'], 'true');
    assert.ok(
      doc.handle.scrollState(doc.byId('list'))!.x > 0,
      'the strip scrolled the tab toward its middle',
    );
    lined('t1');
  },
);

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

test('a key typed in an editing host the page focused is an edit of it at the selection, told as a beforeinput and an input', async () => {
  // what CodeMirror stands on: it cancels the keys it has a command for,
  // and reads every other edit back from the DOM a browser changed
  const doc = await hosted(
    '<div id="ed" contenteditable style="white-space: pre">ab</div>' +
      '<p id="out"></p><script>' +
      'var ed = document.getElementById("ed"), r = [];' +
      'function log(x) { r.push(x); document.getElementById("out").textContent = r.join("|"); }' +
      'ed.addEventListener("beforeinput", function (e) {' +
      '  log("before:" + e.inputType + ":" + e.data);' +
      '  if (e.data === "z") e.preventDefault();' +
      '});' +
      'ed.addEventListener("input", function (e) { log("input:" + e.inputType); });' +
      'document.addEventListener("selectionchange", function () { log("sel"); });' +
      '</script>',
  );
  doc.run(
    'ed.focus(); getSelection().collapse(ed.firstChild, 1);' +
      'log([document.activeElement.id, getSelection().type, getSelection().focusOffset].join(":"));',
  );
  await settle();
  assert.equal(doc.text('out'), 'ed:Caret:1|sel', doc.logs.join('\n'));
  const typed = async (fire: () => void) => {
    await act(async () => fire());
    await settle();
  };
  await typed(() => fireEvent.char('x'));
  assert.equal(doc.text('ed'), 'axb');
  await typed(() => fireEvent.char('z'));
  assert.equal(doc.text('ed'), 'axb', 'a cancelled beforeinput edits nothing');
  await typed(() => fireEvent.key(XK_BACKSPACE));
  await typed(() => fireEvent.key(XK_DELETE));
  assert.equal(doc.text('ed'), 'a');
  await typed(() => fireEvent.key(XK_RETURN));
  assert.equal(doc.text('ed'), 'a\n', 'pre keeps a line feed for Enter');
  doc.run(
    'var s = getSelection(); s.setBaseAndExtent(ed.firstChild, 2, ed.firstChild, 0);' +
      'log([s.type, s.direction, s.anchorOffset, s.focusOffset, s.toString().length].join(":"));',
  );
  await typed(() => fireEvent.char('q'));
  assert.equal(doc.text('ed'), 'q', 'what is selected is typed over');
  assert.equal(
    doc
      .text('out')
      .split('|')
      .filter((x) => x !== 'sel')
      .join('|'),
    [
      'ed:Caret:1',
      'before:insertText:x',
      'input:insertText',
      'before:insertText:z',
      'before:deleteContentBackward:null',
      'input:deleteContentBackward',
      'before:deleteContentForward:null',
      'input:deleteContentForward',
      'before:insertParagraph:null',
      'input:insertParagraph',
      'Range:backward:2:0:2',
      'before:insertText:q',
      'input:insertText',
    ].join('|'),
  );
});

metric(
  'a range of the text of an editing host is measured where its letters are drawn, and a press there puts the caret at the letter',
  async () => {
    const doc = await hosted(
      '<div id="ed" contenteditable style="font: 20px monospace; white-space: pre; margin: 0">' +
        'abcdef</div><p id="out"></p><p id="m"></p><script>' +
        'var ed = document.getElementById("ed");' +
        'function rects(a, b) { var r = document.createRange(); r.setStart(ed.firstChild, a); r.setEnd(ed.firstChild, b);' +
        '  return Array.from(r.getClientRects()).map(function (q) { return [q.left, q.top, q.width, q.height].map(Math.round).join(","); }).join(";"); }' +
        'document.addEventListener("selectionchange", function () {' +
        '  var s = getSelection(); document.getElementById("out").textContent =' +
        '    [document.activeElement.id, s.focusNode && s.focusNode.data, s.focusOffset].join(":");' +
        '});' +
        '</script>',
    );
    const measure = (a: number, b: number) => {
      doc.run(`document.getElementById("m").textContent = rects(${a}, ${b})`);
      return doc.text('m').split(',').map(Number);
    };
    const box = doc.view.elementRect(doc.byId('ed'))!;
    const first = measure(0, 1);
    const third = measure(2, 3);
    assert.equal(first.length, 4, 'one rectangle for one letter');
    const width = first[2];
    assert.ok(width > 5 && width < box.width / 3, `a letter's width, ${width}`);
    assert.ok(Math.abs(third[0] - (first[0] + 2 * width)) <= 1, `${third}`);
    // a press in the middle of the fourth letter's right half
    const node = doc.view as unknown as DrawnNode;
    const x = first[0] + 3.75 * width;
    const y = first[1] + first[3] / 2;
    await act(async () => {
      fireEvent.mouseDown(node, {
        dx: x - node.abs.width / 2,
        dy: y - node.abs.height / 2,
      });
      fireEvent.mouseUp(node, {
        dx: x - node.abs.width / 2,
        dy: y - node.abs.height / 2,
      });
    });
    await settle();
    assert.equal(doc.text('out'), 'ed:abcdef:4', doc.logs.join('\n'));
    await act(async () => fireEvent.char('X'));
    await settle();
    assert.equal(doc.text('ed'), 'abcdXef');
  },
);

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

test("an event's attributes are the prototype's, so a delegating library shadows currentTarget on the event and puts it back", async () => {
  // GitHub's delegated-events, under its sites' click analytics: with the
  // attribute a field there was no descriptor to take, the handler read
  // the document as its currentTarget, and github.blog threw on its tagName
  const doc = await hosted(
    '<p id="out"></p><ul><li id="li"><span id="s">go</span></li></ul><script>' +
      '"use strict";' +
      'var r = []; var H = Object.getOwnPropertyDescriptor(Event.prototype, "currentTarget");' +
      'r.push(["type", "target", "currentTarget", "eventPhase", "bubbles", "cancelable", "defaultPrevented", "composed", "timeStamp"]' +
      '  .every(function (n) { var d = Object.getOwnPropertyDescriptor(Event.prototype, n); return d && typeof d.get === "function" && !d.set; }));' +
      'document.addEventListener("click", function (e) {' +
      '  var li = e.target.closest("li");' +
      '  Object.defineProperty(e, "currentTarget", { configurable: true, enumerable: true, get: function () { return li; } });' +
      '  r.push(e.currentTarget.tagName.toLowerCase(), e.eventPhase);' +
      '  Object.defineProperty(e, "currentTarget", { configurable: true, enumerable: true, get: H.get });' +
      '});' +
      // the dispatch goes on past the accessor the page left on the event
      'window.addEventListener("click", function (e) {' +
      '  r.push(e.currentTarget === window, e.target.id, e.eventPhase);' +
      '  try { e.target = null; } catch (err) { r.push(err.name); }' +
      '});' +
      'var ev = new MouseEvent("click", { bubbles: true });' +
      'document.getElementById("s").dispatchEvent(ev);' +
      'r.push(ev.currentTarget, ev.eventPhase);' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    'true|li|3|true|s|3|TypeError||0',
    doc.logs.join('\n'),
  );
});

test('hidden reflects until-found, and every falsy value takes the attribute off', async () => {
  // HTML 6.1: the IDL attribute is `until-found` in that state, and its
  // setter takes the string back to the state rather than to `hidden=""`
  const doc = await hosted(
    '<p id="out"></p><p id="p">x</p><script>' +
      'var p = document.getElementById("p"), r = [];' +
      'r.push(String(p.hidden));' +
      'p.hidden = "UNTIL-FOUND"; r.push(p.getAttribute("hidden"), String(p.hidden));' +
      'p.hidden = true; r.push(JSON.stringify(p.getAttribute("hidden")), String(p.hidden));' +
      'p.hidden = 0; r.push(String(p.hasAttribute("hidden")));' +
      'p.hidden = "false"; r.push(String(p.hidden));' +
      'p.hidden = NaN; r.push(String(p.hasAttribute("hidden")));' +
      'p.hidden = undefined; r.push(String(p.hasAttribute("hidden")));' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    'false|until-found|until-found|""|true|false|true|false|false',
    doc.logs.join('\n'),
  );
});

test('an animation runs for its timing, then its promise resolves and its finish is told; a cancelled one rejects', async () => {
  // what it animates is not drawn, but a page that waits on it goes on:
  // the stand-in finished nothing, so a menu that hid a panel `onfinish`
  // kept every panel it had left on screen
  const doc = await hosted(
    '<p id="out"></p><div id="b">b</div><script>' +
      'var el = document.getElementById("b"), r = [];' +
      'var a = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 40 });' +
      'r.push(a.playState, typeof a.currentTime, a instanceof Animation,' +
      '  a.effect instanceof KeyframeEffect, a.effect.getComputedTiming().endTime,' +
      '  el.getAnimations().length, document.getAnimations().length);' +
      'a.finished.then(function (x) { r.push("finished:" + (x === a) + ":" + a.playState); });' +
      'a.onfinish = function (e) {' +
      '  r.push("finish:" + (e instanceof AnimationPlaybackEvent) + ":" + e.currentTime + ":" + el.getAnimations().length);' +
      '  document.getElementById("out").textContent = r.join("|"); };' +
      'var c = el.animate({ opacity: [0, 1] }, 1000);' +
      'c.oncancel = function () { r.push("cancel:" + c.playState); };' +
      'c.finished.catch(function (e) { r.push("rejected:" + e.name); });' +
      'c.cancel();' +
      // one with no duration finishes at once, and is told after the
      // script that made it set its handler
      'el.animate({ opacity: [0, 1] }).onfinish = function () { r.push("zero"); };' +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t.includes('finish:'));
  assert.equal(
    text,
    [
      'running',
      'number',
      'true',
      'true',
      '40',
      '1',
      '1',
      'rejected:AbortError',
      'cancel:idle',
      'zero',
      'finished:true:finished',
      'finish:true:40:0',
    ].join('|'),
    doc.logs.join('\n'),
  );
});

test('a menu that hides the panel it leaves once its fade ends shows one panel', async () => {
  // A mega menu's panels are `hidden="until-found"` under a `display:
  // block` of its own, each faded out with `animate()` and hidden again in
  // its `onfinish`. The attribute was `display: none`, which the page's
  // display won, and the fade never finished, so every panel the menu had
  // opened, and every one it had not, was drawn over the others.
  const doc = await hosted(
    '<style>.bar { position: relative; height: 30px; overflow: hidden }' +
      '.panel { position: absolute; top: 30px; left: 0; display: block }</style>' +
      '<div class="bar" id="bar">' +
      '<div class="panel" id="a" hidden="until-found">Alpha panel</div>' +
      '<div class="panel" id="b" hidden="until-found">Beta panel</div>' +
      '<div class="panel" id="c" hidden="until-found">Gamma panel</div></div>' +
      '<p id="out"></p><script>' +
      'var open = null;' +
      'function show(next) {' +
      '  if (open) { var was = open;' +
      '    was.animate({ opacity: [1, 0] }, 20).onfinish = function () {' +
      '      was.setAttribute("hidden", "until-found");' +
      '      document.getElementById("out").textContent = "done"; }; }' +
      '  next.hidden = false; next.animate({ opacity: [0, 1] }, 20);' +
      '  document.getElementById("bar").style.height = 30 + next.scrollHeight + "px";' +
      '  open = next; }' +
      'show(document.getElementById("a"));' +
      'setTimeout(function () { show(document.getElementById("b")); }, 10);' +
      '</script>',
  );
  await settled(doc, 'out', (t) => t === 'done');
  const drawn = (doc.view as unknown as { _tree: { text: string } })._tree.text;
  assert.ok(drawn.includes('Beta panel'), drawn);
  assert.ok(!drawn.includes('Alpha panel'), drawn);
  assert.ok(!drawn.includes('Gamma panel'), drawn);
});

/** The style `<Html>` draws an element in: its box's, as the last frame
 *  left it, and not one worked out for the asking. */
function drawnStyle(doc: Hosted, id: string): ComputedStyle {
  const tree = (
    doc.view as unknown as {
      _tree: { styles: Map<DocElement, { style: ComputedStyle }> };
    }
  )._tree;
  const style = tree.styles.get(doc.byId(id))?.style;
  assert.ok(style, `#${id} is drawn`);
  return style;
}

/** Until what `<Html>` draws an element in holds of `done`, the frames on
 *  the wall clock, however long the machine takes; and that style. */
async function drawnUntil(
  doc: Hosted,
  id: string,
  done: (style: ComputedStyle) => boolean,
  ms = 3000,
): Promise<ComputedStyle> {
  const end = Date.now() + ms;
  while (!done(drawnStyle(doc, id)) && Date.now() < end) await settle(20);
  return drawnStyle(doc, id);
}

/** `n` frames of a held animation clock, and the paint after them. */
async function frames(clock: HeldClock, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await clock.frame();
  await act();
}

/** An element's drawn colour at a point, `#rrggbb`. */
async function colourAt(doc: Hosted, x: number, y: number): Promise<string> {
  const [r, g, b] = await pixelsIn(doc.result.ctx, {
    x,
    y,
    width: 1,
    height: 1,
  });
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

metric(
  "a custom highlight's ranges are drawn in its ::highlight() style, and drawn no more once it is taken out of the registry",
  async () => {
    const doc = await hosted(
      '<style>body { margin: 0; font: 20px/40px sans-serif }' +
        ' ::highlight(lit) { background-color: #ffff00 }' +
        ' #ref { background: #ffff00; width: 10px; height: 10px }</style>' +
        '<p id="t" style="margin:0"><span id="a">AAAA</span><span id="b">BBBB</span></p>' +
        '<div id="ref"></div><p id="out"></p><script>' +
        'var text = document.getElementById("a").firstChild;' +
        'var r = new Range(); r.setStart(text, 0); r.setEnd(text, 4);' +
        'CSS.highlights.set("lit", new Highlight(r));' +
        'document.getElementById("out").textContent = "set";' +
        '</script>',
    );
    await settled(doc, 'out', (t) => t === 'set');
    await settle(40);
    const at = (id: string) => {
      const rect = doc.view.elementRect(doc.byId(id))!;
      // the line's top edge, over its band and above any glyph
      return [Math.round(rect.x + rect.width / 2), Math.round(rect.y + 2)];
    };
    const ref = doc.view.elementRect(doc.byId('ref'))!;
    const yellow = await colourAt(doc, ref.x + 5, ref.y + 5);
    const [ax, ay] = at('a');
    const [bx, by] = at('b');
    assert.equal(await colourAt(doc, ax, ay), yellow, 'the range is lit');
    assert.notEqual(await colourAt(doc, bx, by), yellow, 'past it is not');
    await act(() => doc.run('CSS.highlights.delete("lit")'));
    await settle(40);
    assert.notEqual(
      await colourAt(doc, ax, ay),
      yellow,
      'taken out, it is drawn no more',
    );
  },
);

metric(
  'overlapping highlights set text once, in the topmost colour, and lit as the same text in a span is',
  async () => {
    // Text two highlights colour is the later's colour alone, each glyph
    // where it is drawn unlit (CSS Pseudo 4, 4.2); a highlight's ranges
    // that overlap light their text once; and a static range that is no
    // range — reversed, or past its node's end — lights nothing (DOM
    // 5.4). Each holds the line to a span set as the highlights should
    // have it, pixel for pixel: the earlier colour round the later's
    // glyphs, a glyph cast a pixel aside, a band lit twice or one a pixel
    // wider all show.
    const doc = await hosted(
      '<style>body { margin: 0; font: 20px/30px sans-serif }' +
        ' p { margin: 0 } ::highlight(one) { color: #ff0000 }' +
        ' ::highlight(two) { color: #008000;' +
        ' background-color: rgba(0, 0, 255, 0.3) }' +
        ' ::highlight(bad) { background-color: #ffff00 }' +
        ' #ref span { color: #008000; background: rgba(0, 0, 255, 0.3) }' +
        '</style>' +
        '<p id="t">Lo<b>rem</b> ipsum. Lorem</p>' +
        '<p id="ref">Lo<b><span>rem</span></b><span> ipsum. </span>Lorem</p>' +
        '<p id="out"></p><script>' +
        'var p = document.getElementById("t");' +
        'var b = p.childNodes[1].firstChild, t = p.childNodes[2];' +
        'var all = new Range(); all.setStart(b, 0); all.setEnd(t, 8);' +
        'var r1 = new Range(); r1.setStart(b, 0); r1.setEnd(t, 4);' +
        'var r2 = new Range(); r2.setStart(t, 2); r2.setEnd(t, 8);' +
        'CSS.highlights.set("one", new Highlight(all));' +
        'CSS.highlights.set("two", new Highlight(r1, r2));' +
        'CSS.highlights.set("bad", new Highlight(' +
        ' new StaticRange({ startContainer: t, startOffset: 5,' +
        '   endContainer: t, endOffset: 2 }),' +
        ' new StaticRange({ startContainer: t, startOffset: 0,' +
        '   endContainer: t, endOffset: 99 })));' +
        'document.getElementById("out").textContent = "set";' +
        '</script>',
    );
    await settled(doc, 'out', (t) => t === 'set');
    await settle(40);
    const lit = doc.view.elementRect(doc.byId('t'))!;
    const ref = doc.view.elementRect(doc.byId('ref'))!;
    const width = Math.round(lit.width);
    const height = Math.round(lit.height);
    const a = await pixelsIn(doc.result.ctx, {
      x: Math.round(lit.x),
      y: Math.round(lit.y),
      width,
      height,
    });
    const r = await pixelsIn(doc.result.ctx, {
      x: Math.round(ref.x),
      y: Math.round(ref.y),
      width,
      height,
    });
    let differ = 0;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== r[i]) differ += 1;
    assert.equal(differ, 0, 'the lit line is the span line');
  },
);

test('a Highlight is a set of ranges and CSS.highlights a map of them, whatever a page does to Set and Map', async () => {
  const doc = await hosted(
    '<p id="t">text</p><p id="out"></p><script>' +
      'var r = []; var text = document.getElementById("t").firstChild;' +
      'var a = new Range(); a.setStart(text, 0); a.setEnd(text, 2);' +
      'var b = new StaticRange({ startContainer: text, startOffset: 1, endContainer: text, endOffset: 3 });' +
      'var out = document.getElementById("out");' +
      // the highlights' own sets and maps are worked by the built-ins as
      // they were; a page's DOM is no part of this
      'var add = Set.prototype.add, set = Map.prototype.set;' +
      'Set.prototype.add = function () { throw new Error("tampered"); };' +
      'Map.prototype.set = function () { throw new Error("tampered"); };' +
      'var h = new Highlight(a, b);' +
      'r.push(h.size, h.has(b), h.priority, h.type, Object.prototype.toString.call(h));' +
      'h.type = "nonsense"; h.type = "spelling-error"; h.priority = 3.7; r.push(h.type, h.priority);' +
      'try { h.add({}); } catch (e) { r.push(e.name); }' +
      'r.push(CSS.highlights.set("x", h) === CSS.highlights, CSS.highlights.size, CSS.highlights.get("x") === h);' +
      'r.push(Array.from(CSS.highlights.keys()).join(), Array.from(h).length, b.collapsed, b.startOffset);' +
      'try { new HighlightRegistry(); } catch (e) { r.push(e.name); }' +
      'r.push(h.delete(a), h.delete(a), CSS.highlights.delete("x"), CSS.highlights.size);' +
      'Set.prototype.add = add; Map.prototype.set = set;' +
      'out.textContent = r.join(",");' +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    '2,true,0,highlight,[object Highlight],spelling-error,3,TypeError,' +
      'true,1,true,x,2,false,1,TypeError,true,false,true,0',
    doc.logs.join('\n'),
  );
});

metric(
  'a fade a script starts is drawn, and filling forwards it holds its last frame once it has finished',
  async () => {
    // a panel that is `opacity: 0` in its sheet and faded in from a script,
    // left at its last frame: it was drawn in the style it had, which is
    // nothing at all
    const doc = await hosted(
      '<style>body { margin: 0 } #p { width: 100px; height: 40px;' +
        ' background: #0000ff; opacity: 0 }</style>' +
        '<div id="p"></div><p id="out"></p><script>' +
        'var p = document.getElementById("p");' +
        'var a = p.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: "forwards" });' +
        'a.onfinish = function () {' +
        '  document.getElementById("out").textContent =' +
        '    a.playState + " " + getComputedStyle(p).opacity; };' +
        '</script>',
    );
    const text = await settled(doc, 'out', (t) => t !== '');
    assert.equal(text, 'finished 1', doc.logs.join('\n'));
    assert.equal(
      (await drawnUntil(doc, 'p', (s) => s.opacity === 1)).opacity,
      1,
      'drawn at its last frame',
    );
    await waitForPixel(doc.result.ctx, 50, 20, '#0000ff', {
      message: 'the panel drawn at full strength',
    });
    // a frame drawn is no frame a page wrote down: its own style is as it was
    assert.equal(doc.byId('p').attribs.style, undefined);
  },
);

test('a slide a script starts is drawn moving, a frame at a time, where its timing has it', async (t) => {
  const clock = holdClock(t, animationClock);
  // a tenth of a pixel a millisecond, for longer than any test runs: the
  // page's own clock never ends it while the held one moves it
  const doc = await hosted(
    '<style>body { margin: 0 } #s { width: 20px; height: 20px;' +
      ' background: #0000ff }</style><div id="s"></div><script>' +
      'document.getElementById("s").animate(' +
      '  [{ transform: "translateX(0px)" }, { transform: "translateX(1000000px)" }],' +
      '  10000000);' +
      '</script>',
  );
  const x = () => doc.view.elementRect(doc.byId('s'))!.x;
  await frames(clock, 1);
  assert.ok(Math.abs(x() - 1.6) < 0.05, `a frame in: ${x()}`);
  await frames(clock, 10);
  assert.ok(Math.abs(x() - 17.6) < 0.05, `eleven frames in: ${x()}`);
  assert.ok(clock.pending, 'and it asks for the next');
  if (FONTS) {
    await frames(clock, 19);
    assert.equal(await colourAt(doc, 52, 10), '#0000ff', 'drawn where it is');
    assert.equal(
      await colourAt(doc, 10, 10),
      '#ffffff',
      'and gone from where it was',
    );
    // and a frame made in place draws what a build of the whole document
    // draws at that time
    const inPlace = await snapshot(doc.result, doc.view);
    const whole = await rebuilt(doc.result, doc.view);
    assert.ok(bytesApart(inPlace, whole) === 0, 'drawn as a build draws it');
  }
});

test('a paused animation is drawn where its time is set, and runs on from there at its rate as it plays', async (t) => {
  const clock = holdClock(t, animationClock);
  const doc = await hosted(
    '<div id="b">b</div><p id="out"></p><script>' +
      'var a = document.getElementById("b").animate([{ opacity: 0 }, { opacity: 1 }], 1000);' +
      'a.pause(); a.currentTime = 250;' +
      // read at once, before a frame has drawn it
      'document.getElementById("out").textContent =' +
      '  a.playState + " " + a.currentTime + " " +' +
      '  getComputedStyle(document.getElementById("b")).opacity;' +
      '</script>',
  );
  assert.equal(doc.text('out'), 'paused 250 0.25');
  await frames(clock, 1);
  assert.equal(drawnStyle(doc, 'b').opacity, 0.25);
  await frames(clock, 5);
  assert.equal(drawnStyle(doc, 'b').opacity, 0.25, 'held while paused');
  assert.equal(clock.pending, false, 'and asking for no frame');
  // it plays on from where it was held — what the page set, as the page
  // has it, and not a time read off another clock
  doc.run('a.play();');
  await frames(clock, 1);
  const played = drawnStyle(doc, 'b').opacity;
  assert.ok(Math.abs(played - 0.266) < 1e-3, `played ${played}`);
  doc.run(
    'a.pause(); a.playbackRate = 2; a.currentTime = 500; a.play();' +
      'document.getElementById("out").textContent = a.playState;',
  );
  assert.equal(doc.text('out'), 'running');
  await frames(clock, 1);
  const faster = drawnStyle(doc, 'b').opacity;
  assert.ok(Math.abs(faster - 0.532) < 1e-3, `twice as fast: ${faster}`);
  // and seeking a running one moves it there
  doc.run('a.currentTime = 900;');
  await frames(clock, 1);
  const sought = drawnStyle(doc, 'b').opacity;
  assert.ok(Math.abs(sought - 0.932) < 1e-3, `sought ${sought}`);
});

test("an animation's delay, iterations, direction and easing are drawn as Web Animations times them, and a delay is waited out", async (t) => {
  const clock = holdClock(t, animationClock);
  const doc = await hosted(
    '<div id="d">d</div><div id="w">w</div><script>' +
      'var a = document.getElementById("d").animate({ opacity: [0, 1] }, {' +
      '  duration: 1000, delay: 500, endDelay: 200, iterations: 2,' +
      '  iterationStart: 0.25, direction: "alternate", fill: "both",' +
      '  easing: "steps(4, end)" });' +
      'a.pause();' +
      // one that waits for longer than a frame before it starts
      'document.getElementById("w").animate({ opacity: [0, 1] },' +
      '  { duration: 10000000, delay: 40 });' +
      '</script>',
  );
  // two frames in, 32ms, the other is in its delay and the element's own,
  // and the frame its delay ends at is asked for; the third is past it
  await frames(clock, 2);
  assert.equal(drawnStyle(doc, 'w').opacity, 1);
  assert.ok(clock.pending, 'its start asked for');
  await frames(clock, 1);
  assert.ok(drawnStyle(doc, 'w').opacity < 1e-5, 'under way');
  const at = async (time: number) => {
    doc.run(`a.currentTime = ${time};`);
    await frames(clock, 1);
    return drawnStyle(doc, 'd').opacity;
  };
  // its delay filled backwards from a quarter in, then the first iteration
  // forwards, the second backwards, part of a third, and held there
  assert.equal(await at(0), 0.25);
  assert.equal(await at(750), 0.5);
  assert.equal(await at(1500), 0.75);
  assert.equal(await at(2400), 0);
  assert.equal(await at(2600), 0.25);
});

test('a cancelled animation leaves the element its own style, and one finished with no fill leaves it too', async () => {
  const doc = await hosted(
    '<style>#c, #n { opacity: .2 }</style><div id="c">c</div><div id="n">n</div>' +
      '<script>' +
      'var a = document.getElementById("c").animate({ opacity: [0, 0.8] }, { duration: 0, fill: "forwards" });' +
      'var n = document.getElementById("n").animate({ opacity: [0, 0.8] }, { duration: 0 });' +
      '</script>',
  );
  assert.equal(
    (await drawnUntil(doc, 'c', (s) => s.opacity === 0.8)).opacity,
    0.8,
    'held at its end',
  );
  assert.equal(drawnStyle(doc, 'n').opacity, 0.2, 'over, and filling nothing');
  doc.run('a.cancel();');
  assert.equal(
    (await drawnUntil(doc, 'c', (s) => s.opacity === 0.2)).opacity,
    0.2,
    'cancelled',
  );
});

test('an element a script animates is styled apart from its twin, through a build of the whole document', async () => {
  // two items alike in every attribute share one style, and the one a
  // script faded in took its twin's at the next build
  const doc = await hosted(
    '<style>li { opacity: .2 }</style><ul id="u"><li>x</li><li>x</li></ul><script>' +
      'document.querySelectorAll("li")[1].animate({ opacity: [0, 0.8] },' +
      '  { duration: 0, fill: "forwards" });' +
      '</script>',
  );
  const [first, second] = doc
    .byId('u')
    .children.filter((c): c is DocElement => (c as DocElement).name === 'li');
  const styles = () =>
    (
      doc.view as unknown as {
        _tree: { styles: Map<DocElement, { style: ComputedStyle }> };
      }
    )._tree.styles;
  const end = Date.now() + 3000;
  while (styles().get(second)?.style.opacity !== 0.8 && Date.now() < end) {
    await settle(20);
  }
  (doc.view as unknown as { _invalidate(stale: number): void })._invalidate(2);
  doc.view.elementRect(first);
  assert.equal(styles().get(first)?.style.opacity, 0.2);
  assert.equal(styles().get(second)?.style.opacity, 0.8);
});

test("an animation of a pseudo-element is drawn on the pseudo-element's box", async () => {
  const doc = await hosted(
    '<style>#q::before { content: "q"; opacity: .2 }</style><div id="q">x</div>' +
      '<script>' +
      'var a = document.getElementById("q").animate({ opacity: [0, 0.9] },' +
      '  { duration: 0, fill: "forwards", pseudoElement: "::before" });' +
      '</script>',
  );
  const view = doc.view as unknown as {
    _tree: unknown;
    _pseudoBoxOf(
      tree: unknown,
      el: DocElement,
      which: string,
    ): { style: ComputedStyle } | null;
  };
  const before = () =>
    view._pseudoBoxOf(view._tree, doc.byId('q'), 'before')?.style.opacity;
  const end = Date.now() + 3000;
  while (before() !== 0.9 && Date.now() < end) await settle(20);
  assert.equal(before(), 0.9);
  assert.equal(drawnStyle(doc, 'q').opacity, 1, 'and not on the element');
  doc.run('a.cancel();');
  while (before() !== 0.2 && Date.now() < end + 3000) await settle(20);
  assert.equal(before(), 0.2);
});

test('commitStyles writes what an animation comes to into the style attribute, under the animations made after it', async () => {
  const doc = await hosted(
    '<style>body { margin: 0 } #c { opacity: .2 } #h { display: none }</style>' +
      '<div id="c">c</div><div id="h">h</div><p id="out"></p><script>' +
      'var c = document.getElementById("c"), r = [];' +
      'var a = c.animate([{ opacity: 0.1, transform: "translateX(0px)" },' +
      '  { opacity: 0.5, transform: "translateX(40px)" }], { duration: 0, fill: "forwards" });' +
      // one made after it, and over it, is not what it writes
      'var over = c.animate({ opacity: [0.9, 0.9] }, 100000);' +
      'a.finished.then(function () {' +
      '  a.commitStyles(); a.cancel(); over.cancel();' +
      '  r.push(c.style.opacity, c.style.transform);' +
      '  try { document.getElementById("h").animate({ opacity: [0, 1] }, 10).commitStyles(); }' +
      '  catch (e) { r.push(e.name); }' +
      '  try { c.animate({ opacity: [0, 1] }, { duration: 10, pseudoElement: "::before" }).commitStyles(); }' +
      '  catch (e) { r.push(e.name); }' +
      '  document.getElementById("out").textContent = r.join("|"); });' +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(
    text,
    '0.5|translate(40px, 0px)|InvalidStateError|NoModificationAllowedError',
    doc.logs.join('\n'),
  );
  // and with the animation gone, the element is drawn as it was written
  const style = await drawnUntil(doc, 'c', (s) => s.opacity === 0.5);
  assert.equal(style.opacity, 0.5);
  assert.equal(doc.view.elementRect(doc.byId('c'))!.x, 40);
});

test('a finished animation that fills is removed once later ones cover what it sets, and told so', async () => {
  const doc = await hosted(
    '<div id="r">r</div><p id="out"></p><script>' +
      'var el = document.getElementById("r"), r = [];' +
      'var first = el.animate({ opacity: [0, 0.3] }, { duration: 0, fill: "forwards" });' +
      'var kept = el.animate({ opacity: [0, 0.3], color: ["red", "blue"] }, { duration: 0, fill: "both" });' +
      'kept.persist();' +
      'var last = el.animate({ opacity: [0, 0.6] }, { duration: 0, fill: "forwards" });' +
      'first.onremove = function (e) { r.push(e.type, first.replaceState, kept.replaceState); };' +
      'last.finished.then(function () { setTimeout(function () {' +
      '  r.push(el.getAnimations().length, last.replaceState);' +
      '  document.getElementById("out").textContent = r.join("|"); }, 0); });' +
      '</script>',
  );
  const text = await settled(doc, 'out', (t) => t !== '');
  assert.equal(text, 'remove|removed|persisted|2|active', doc.logs.join('\n'));
  assert.equal(
    (await drawnUntil(doc, 'r', (s) => s.opacity === 0.6)).opacity,
    0.6,
  );
});

test('keyframes take their offsets as Web Animations computes them, and a list per property is spread on its own', async () => {
  const doc = await hosted(
    '<p id="out"></p><script>' +
      'var r = [];' +
      'function offsets(k) { return new KeyframeEffect(null, k).getKeyframes()' +
      '  .map(function (f) { return f.computedOffset; }).join(","); }' +
      'r.push(offsets([{ opacity: 0 }, { opacity: .5 }, { opacity: .2, offset: .8 }, { opacity: 1 }]));' +
      'r.push(offsets({ opacity: [0, 1], left: ["0px", "5px", "10px"] }));' +
      'r.push(offsets({ opacity: 1 }));' +
      'var mid = new KeyframeEffect(null, { opacity: [0, 1], left: ["0px", "5px", "10px"],' +
      '  easing: ["ease-in", "linear"] }).getKeyframes()[1];' +
      'r.push(mid.left, String(mid.opacity), mid.easing);' +
      'try { new KeyframeEffect(null, [{ opacity: 0, offset: .6 }, { opacity: 1, offset: .2 }]); }' +
      'catch (e) { r.push(e.name); }' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    '0,0.4,0.8,1|0,0.5,1|1|5px|undefined|linear|TypeError',
    doc.logs.join('\n'),
  );
});

test('at rest, an animation a script made is drawn as it ends where it fills forwards, and not at all where not', async () => {
  const doc = await hosted(
    '<style>#f, #n { opacity: .2 }</style><div id="f">f</div><div id="n">n</div><script>' +
      'document.getElementById("f").animate({ opacity: [0, 0.7] }, { duration: 100000, fill: "forwards" });' +
      'document.getElementById("n").animate({ opacity: [0, 0.7] }, 100000);' +
      '</script>',
    { animate: false },
  );
  assert.equal(
    (await drawnUntil(doc, 'f', (s) => s.opacity === 0.7)).opacity,
    0.7,
  );
  assert.equal(drawnStyle(doc, 'n').opacity, 0.2);
});

test('aria attributes reflect as nullable strings, so a menu a script opens by its ariaHidden is shown', async () => {
  // github.blog's header menus: `toggle.ariaExpanded = "true"` and
  // `menu.ariaHidden = "false"` were expandos, and the menu, shown by its
  // attribute, stayed hidden
  const doc = await hosted(
    '<style>.menu[aria-hidden=true] { visibility: hidden }</style>' +
      '<p id="out"></p><a id="t" role="button" aria-expanded="false">Menu</a>' +
      '<ul class="menu" id="m" aria-hidden="true"><li>Item</li></ul><script>' +
      '"use strict";' +
      'var t = document.getElementById("t"), m = document.getElementById("m"), r = [];' +
      'r.push(t.role, t.ariaExpanded, m.ariaHidden, String(t.ariaLabel));' +
      't.ariaExpanded = "true"; t.ariaHasPopup = "menu"; t.ariaLabel = "Open";' +
      'r.push(t.getAttribute("aria-expanded"), t.getAttribute("aria-haspopup"), t.getAttribute("aria-label"));' +
      't.ariaLabel = null; t.role = null;' +
      'r.push(t.hasAttribute("aria-label"), String(t.ariaLabel), t.hasAttribute("role"));' +
      // every element's, an SVG one's too
      'var g = document.createElementNS("http://www.w3.org/2000/svg", "g"); g.ariaHidden = "true";' +
      'r.push(g.getAttribute("aria-hidden"));' +
      'm.ariaHidden = "false";' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    [
      'button',
      'false',
      'true',
      'null',
      'true',
      'menu',
      'Open',
      'false',
      'null',
      'false',
      'true',
    ].join('|'),
    doc.logs.join('\n'),
  );
  assert.equal(doc.byId('m').attribs['aria-hidden'], 'false');
  assert.equal(doc.view.computedStyle(doc.byId('m'))?.visibility, 'visible');
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

/** A page whose frames run in realms of their own, as `<Html scripts>`
 *  runs them (`drawsFrames`, `frames.ts`): each frame's document drawn by an
 *  `<Html>` of its own over the frame's box, or held where the page lays
 *  out none, its scripts its own runner's, linked to the page's. */
async function hostedFrames(
  source: string,
  files: Record<string, string>,
): Promise<{
  text: (where: string, id: string) => string;
  logs: string[];
  runner: () => ScriptRunner;
  result: Awaited<ReturnType<typeof renderX11>>;
}> {
  const logs: string[] = [];
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
    navigate: () => {},
    reload: () => {},
    go: () => {},
    log: (level, text) => void logs.push(`${level}: ${text}`),
    title: () => {},
    fetch: async (request) => {
      const name = request.url.slice(request.url.lastIndexOf('/') + 1);
      const body = files[name];
      if (body === undefined) throw new Error('no answer');
      return {
        url: request.url,
        status: 200,
        statusText: 'OK',
        redirected: false,
        headers: [['content-type', 'text/html']],
        body,
      };
    },
    load: async () => null,
    onTimeout: () => {},
    drawsFrames: true,
  };
  let runner: (() => ScriptRunner | null) | undefined;
  function Page() {
    const handle = useHtmlHandle();
    const scripts = useScripts(true, handle, PAGE, seams);
    runner = scripts.runner;
    const frames = (): FrameContext | null => {
      const parent = scripts.runner?.();
      return parent
        ? { parent, seams, look: { onResource: () => null } }
        : null;
    };
    const holder = frames();
    return h(
      'box',
      { style: { flexDirection: 'column' } },
      h(Html, {
        source,
        partial: false,
        ref: handle.ref,
        baseUrl: PAGE,
        'data-testname': 'page',
        ...scripts,
        renderEmbedded: embeddedMounts(frames),
      }),
      holder ? h(FrameHolder, { context: holder }) : null,
    );
  }
  const result = await renderX11(
    h('box', { style: { width: 400, flexDirection: 'column' } }, h(Page)),
    FONTS ? { width: 440, height: 400, fonts: FONTS } : { backend: 'mock' },
  );
  await settle();
  const page = () => runner!()!;
  const text = (where: string, id: string): string => {
    let document: HtmlDocument | undefined;
    if (where === 'page') {
      const root = screen.getByTestName('page') as unknown as {
        children: HtmlViewNode[];
      };
      document = root.children[0].document;
    } else {
      document = page()
        .host.frames()
        .find((f) => f.frame.attribs.id === where)?.document;
    }
    const el = document && findById(document, id);
    return el ? textOf(el) : '';
  };
  return { text, logs, runner: page, result };
}

/** What `read` answers once `done` holds of it, or by three seconds. */
async function until(
  read: () => string,
  done: (text: string) => boolean,
): Promise<string> {
  const end = Date.now() + 3000;
  let text = read();
  while (!done(text) && Date.now() < end) {
    await settle(20);
    text = read();
  }
  return text;
}

test('a frame runs in a realm of its own, linked to the page: its window, its parent and messages both ways', async () => {
  const frame =
    '<!DOCTYPE html><p id="got">-</p><script type="module">' +
    'const r = [location.pathname, window.parent !== window, window.top === window.parent,' +
    '  frameElement && frameElement.id, typeof parent.notify];' +
    'parent.postMessage({ type: "ready", r: r.join(",") }, "*");' +
    'addEventListener("message", (e) => {' +
    '  document.getElementById("got").textContent = e.data.n + ":" + (e.source === window.parent) + ":" + e.origin;' +
    '  e.source.postMessage({ type: "echo", n: e.data.n * 2 }, "*");' +
    '});' +
    '</script>';
  const { text, logs } = await hostedFrames(
    '<iframe id="f" src="frame.html"></iframe><p id="out"></p><script>' +
      'var f = document.getElementById("f"); var r = [];' +
      'function notify() {}' +
      'f.onload = function () { r.push("load"); };' +
      'addEventListener("message", function (e) {' +
      '  r.push(e.data.type + ":" + (e.source === f.contentWindow) + (e.data.r ? ":" + e.data.r : ""));' +
      '  if (e.data.type === "ready") {' +
      '    r.push(f.contentDocument === f.contentWindow.document, f.contentWindow.Array !== Array,' +
      '      f.contentDocument.getElementById("got") !== null);' +
      '    f.contentWindow.postMessage({ n: 21 }, "*");' +
      '  }' +
      '  document.getElementById("out").textContent = r.join("|");' +
      '});' +
      '</script>',
    { 'frame.html': frame },
  );
  const page = await until(
    () => text('page', 'out'),
    (t) => t.includes('echo'),
  );
  // the frame's `load` is told in the page once its document has loaded,
  // whenever that falls between the messages
  assert.ok(page.split('|').includes('load'), page);
  assert.equal(
    page
      .split('|')
      .filter((p) => p !== 'load')
      .join('|'),
    [
      'ready:true:/dir/frame.html,true,true,f,function',
      'true',
      'true',
      'true',
      'echo:true',
    ].join('|'),
    logs.join('\n'),
  );
  assert.equal(text('f', 'got'), '21:true:https://example.test');
});

test('a frame of another origin runs at its own origin, and the two reach each other only by messages', async () => {
  const frame =
    '<!DOCTYPE html><p id="got">-</p><script>' +
    'var blocked = "";' +
    'try { parent.document; } catch (e) { blocked = e.name; }' +
    'parent.postMessage({ type: "ready", r: [location.origin, parent !== window, blocked, String(frameElement)].join(":") }, "*");' +
    'var heard = 0;' +
    'addEventListener("message", function (e) {' +
    '  heard += 1;' +
    '  document.getElementById("got").textContent = heard + ":" + e.origin;' +
    '  e.source.postMessage({ type: "echo", n: heard }, e.origin);' +
    '});' +
    '</script>';
  const { text, logs } = await hostedFrames(
    '<iframe id="f" src="https://other.test/frame.html"></iframe><p id="out"></p><script>' +
      'var f = document.getElementById("f"); var r = [];' +
      'addEventListener("message", function (e) {' +
      '  r.push(e.data.type + ":" + e.origin + (e.data.r ? ":" + e.data.r : "") + (e.data.n ? ":" + e.data.n : ""));' +
      '  if (e.data.type === "ready") {' +
      '    var b = ""; try { f.contentWindow.document; } catch (x) { b = x.name; }' +
      '    r.push(String(f.contentDocument), b);' +
      // meant for this page's origin, which the frame is not: dropped
      '    f.contentWindow.postMessage("lost", location.origin);' +
      '    f.contentWindow.postMessage("kept", "https://other.test");' +
      '  }' +
      '  document.getElementById("out").textContent = r.join("|");' +
      '});' +
      '</script>',
    { 'frame.html': frame },
  );
  const page = await until(
    () => text('page', 'out'),
    (t) => t.includes('echo'),
  );
  assert.equal(
    page,
    [
      'ready:https://other.test:https://other.test:true:SecurityError:null',
      'null',
      'SecurityError',
      'echo:https://other.test:1',
    ].join('|'),
    logs.join('\n'),
  );
  assert.equal(text('f', 'got'), '1:https://example.test');
});

test('a frame the page lays out no box for runs all the same, and keeps its realm once it has one', async () => {
  const { text, logs, runner } = await hostedFrames(
    '<iframe id="f" src="frame.html" style="display:none"></iframe>' +
      '<p id="out"></p><script>' +
      'var f = document.getElementById("f");' +
      'f.onload = function () {' +
      '  document.getElementById("out").textContent = "load:" + window.runs;' +
      '  f.style.display = "block";' +
      '  setTimeout(function () {' +
      '    document.getElementById("out").textContent +=' +
      '      "|" + window.runs + ":" + f.contentWindow.mark;' +
      '  }, 300);' +
      '};' +
      '</script>',
    {
      'frame.html':
        '<p id="n">-</p><script>' +
        'parent.runs = (parent.runs || 0) + 1; var mark = 1;' +
        'document.getElementById("n").textContent = "ran " + parent.runs;' +
        '</script>',
    },
  );
  // run held, with no box: its scripts ran and its `load` came
  assert.match(
    await until(
      () => text('page', 'out'),
      (t) => t.startsWith('load:'),
    ),
    /^load:1/,
    logs.join('\n'),
  );
  // and drawn once it has one, in the realm it ran in: its script ran once
  assert.equal(
    await until(
      () => text('page', 'out'),
      (t) => t.includes('|'),
    ),
    'load:1|1:1',
  );
  const shown = runner()
    .host.frames()
    .find((f) => f.frame.attribs.id === 'f')!;
  assert.ok(runner().frameDrawn(shown.document), 'drawn over its box');
  assert.equal(text('f', 'n'), 'ran 1');
});

metric(
  "a frame's document is drawn over the frame's box, and drawn again as its scripts change it",
  async () => {
    const { result, logs, runner } = await hostedFrames(
      '<style>body{margin:0}iframe{display:block;border:0}</style>' +
        '<iframe id="f" src="frame.html" width="100" height="50"></iframe>' +
        '<script>addEventListener("message", function () {' +
        '  document.getElementById("f").contentWindow.postMessage("go", "*");' +
        '});</script>',
      {
        'frame.html':
          '<style>body{margin:0;background:#00ff00}</style><script>' +
          'addEventListener("message", function () {' +
          '  document.body.style.background = "#0000ff";' +
          '});' +
          '</script>',
      },
    );
    await waitForPixel(result.ctx, 50, 25, '#00ff00', {
      message: `the frame's green over its box\n${logs.join('\n')}`,
    });
    // the page asks the frame to change, through its realm's window
    runner().engine.exec('postMessage("ask", "*")', 'test', 0);
    await waitForPixel(result.ctx, 50, 25, '#0000ff', {
      message: "the frame's script's blue",
    });
    // and the page's own white below it
    await waitForPixel(result.ctx, 50, 75, '#ffffff');
  },
);

metric(
  'a frame with no script in it is drawn, and is the page realm’s, which draws what the page writes into it',
  async () => {
    const { result, text, logs, runner } = await hostedFrames(
      '<style>body{margin:0}iframe{display:block;border:0}</style>' +
        '<iframe id="f" src="static.html" width="100" height="50"></iframe>' +
        '<p id="out"></p><script>' +
        'var f = document.getElementById("f");' +
        'f.onload = function () {' +
        '  document.getElementById("out").textContent =' +
        '    "load:" + (f.contentWindow.Array === Array);' +
        '};' +
        'addEventListener("message", function () {' +
        '  f.contentDocument.body.style.background = "#0000ff";' +
        '});' +
        '</script>',
      {
        'static.html':
          '<style>body{margin:0;background:#00ff00}</style><p>static</p>',
      },
    );
    // its `load` is the page host's, and its window holds the page's globals
    assert.equal(
      await until(
        () => text('page', 'out'),
        (t) => t !== '',
      ),
      'load:true',
      logs.join('\n'),
    );
    await waitForPixel(result.ctx, 50, 25, '#00ff00', {
      message: "the frame's green over its box",
    });
    // what the page's realm writes into it is told to the frame's <Html>
    runner().engine.exec('postMessage("go", "*")', 'test', 0);
    await waitForPixel(result.ctx, 50, 25, '#0000ff', {
      message: "the page's blue in the frame",
    });
  },
);

metric(
  "a canvas's script draws pixels the page reads back at once, and the document draws them in the canvas's box",
  async () => {
    const { result, text, logs } = await hostedFrames(
      '<style>body{margin:0}canvas{display:block;width:80px;height:40px}</style>' +
        '<canvas id="c" width="4" height="2"></canvas><p id="out"></p><script>' +
        'var c = document.getElementById("c"); var x = c.getContext("2d");' +
        'var img = x.createImageData(2, 2);' +
        'for (var i = 0; i < 16; i += 4) { img.data[i] = 255; img.data[i + 3] = 255; }' +
        'x.putImageData(img, 0, 0);' +
        'x.fillStyle = "#0000ff"; x.fillRect(2, 0, 2, 2);' +
        'var back = x.getImageData(0, 0, 4, 1).data;' +
        'document.getElementById("out").textContent = [x === c.getContext("2d"),' +
        '  back[0], back[2], back[10], back[11], c.getContext("webgl"), c.width].join("|");' +
        '</script>',
      {},
    );
    assert.equal(
      await until(
        () => text('page', 'out'),
        (t) => t !== '',
      ),
      'true|255|0|255|255||4',
      logs.join('\n'),
    );
    // the bitmap stretched over the box, its left half red, its right blue
    await waitForPixel(result.ctx, 20, 20, '#ff0000', {
      message: 'the put pixels',
    });
    await waitForPixel(result.ctx, 60, 20, '#0000ff', {
      message: 'the filled rectangle',
    });
  },
);

test("a canvas's paths are filled, stroked and clipped to in the page's pixels, with gradients and the compositing operators", async () => {
  const doc = await hosted(
    '<canvas id="c" width="100" height="100"></canvas><p id="out"></p><script>' +
      'var x = document.getElementById("c").getContext("2d"); var r = [];' +
      'function px(a, b) { var d = x.getImageData(a, b, 1, 1).data; return [d[0], d[1], d[2], d[3]].join(","); }' +
      'function clear() { x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = "source-over"; x.clearRect(0, 0, 100, 100); }' +
      // a circle: in, out, and its edge between
      'x.fillStyle = "#ff0000"; x.beginPath(); x.arc(50, 50, 20, 0, Math.PI * 2); x.fill();' +
      'r.push(px(50, 50), px(5, 5)); var edge = x.getImageData(64, 64, 1, 1).data[3]; r.push(edge > 0 && edge < 255);' +
      'r.push(x.isPointInPath(50, 50), x.isPointInPath(5, 5));' +
      // a ring by the even-odd rule, from an SVG path
      'clear(); var ring = new Path2D("M10 10 h80 v80 h-80 Z M30 30 h40 v40 h-40 Z");' +
      'x.fillStyle = "#0000ff"; x.fill(ring, "evenodd"); r.push(px(20, 20), px(50, 50));' +
      'x.fill(ring); r.push(px(50, 50));' +
      // a stroke, 10px wide, square-capped
      'clear(); x.strokeStyle = "#00ff00"; x.lineWidth = 10; x.lineCap = "square"; x.beginPath(); x.moveTo(20, 50); x.lineTo(80, 50); x.stroke();' +
      'r.push(px(50, 46), px(50, 40), px(17, 50), x.isPointInStroke(50, 53), x.isPointInStroke(50, 60));' +
      // a dashed line: on, off
      'clear(); x.setLineDash([10, 10]); x.lineCap = "butt"; x.beginPath(); x.moveTo(0, 10); x.lineTo(100, 10); x.stroke(); x.setLineDash([]);' +
      'r.push(px(5, 10), px(15, 10));' +
      // a linear gradient, black to white across
      'clear(); var g = x.createLinearGradient(0, 0, 100, 0); g.addColorStop(0, "#000"); g.addColorStop(1, "#fff");' +
      'x.fillStyle = g; x.fillRect(0, 0, 100, 100); r.push(x.getImageData(50, 50, 1, 1).data[0] > 120 && x.getImageData(50, 50, 1, 1).data[0] < 135, x.getImageData(0, 0, 1, 1).data[0] < 4);' +
      // a clip: a fill cut to the left half
      'clear(); x.save(); x.beginPath(); x.rect(0, 0, 50, 100); x.clip(); x.fillStyle = "#ff00ff"; x.fillRect(0, 0, 100, 100); x.restore();' +
      'r.push(px(25, 50), px(75, 50)); x.fillRect(75, 50, 1, 1); r.push(px(75, 50) !== "0,0,0,0");' +
      // a rectangle turned a quarter about the canvas's middle
      'clear(); x.fillStyle = "#000000"; x.translate(50, 50); x.rotate(Math.PI / 4); x.fillRect(-10, -10, 20, 20);' +
      'x.setTransform(1, 0, 0, 1, 0, 0); r.push(px(50, 37), px(37, 37));' +
      // destination-out cuts a hole
      'clear(); x.fillStyle = "#ff0000"; x.fillRect(0, 0, 100, 100); x.globalCompositeOperation = "destination-out";' +
      'x.beginPath(); x.arc(50, 50, 10, 0, Math.PI * 2); x.fill(); r.push(px(50, 50), px(5, 5));' +
      // copy clears what the shape does not cover
      'x.globalCompositeOperation = "copy"; x.fillStyle = "#00ff00"; x.fillRect(0, 0, 10, 10); r.push(px(5, 5), px(50, 90));' +
      'r.push(typeof Path2D, x.createRadialGradient(0, 0, 0, 0, 0, 1) instanceof CanvasGradient);' +
      'try { x.createLinearGradient(0, 0, NaN, 0); } catch (e) { r.push(e.name); }' +
      'document.getElementById("out").textContent = r.join("|");' +
      '</script>',
  );
  assert.equal(
    doc.text('out'),
    [
      '255,0,0,255',
      '0,0,0,0',
      'true',
      'true',
      'false',
      '0,0,255,255',
      '0,0,0,0',
      '0,0,255,255',
      '0,255,0,255',
      '0,0,0,0',
      '0,255,0,255',
      'true',
      'false',
      '0,255,0,255',
      '0,0,0,0',
      'true',
      'true',
      '255,0,255,255',
      '0,0,0,0',
      'true',
      '0,0,0,255',
      '0,0,0,0',
      '0,0,0,0',
      '255,0,0,255',
      '0,255,0,255',
      '0,0,0,0',
      'function',
      'true',
      'TypeError',
    ].join('|'),
  );
});

metric(
  'an element that takes the pointer has its moves and its release wherever the pointer goes, until the buttons are let go',
  async () => {
    // a slider's track, which asks on every move whether it has the pointer:
    // `hasPointerCapture` was missing, and every move over it threw
    const { text, logs } = await hostedFrames(
      '<style>body{margin:0}div{height:20px}#other{height:40px}</style>' +
        '<div id="track"></div><div id="gap"></div><div id="other"></div><p id="out"></p><script>' +
        'var t = document.getElementById("track"); var r = [];' +
        'function say(s) { r.push(s); document.getElementById("out").textContent = r.join(","); }' +
        't.addEventListener("pointerdown", function (e) {' +
        '  say("down:" + t.hasPointerCapture(e.pointerId) + ":" + e.buttons);' +
        '  t.setPointerCapture(e.pointerId); say("set:" + t.hasPointerCapture(e.pointerId));' +
        '});' +
        't.addEventListener("gotpointercapture", function () { say("got"); });' +
        't.addEventListener("lostpointercapture", function () { say("lost"); });' +
        't.addEventListener("pointermove", function (e) {' +
        '  if (t.hasPointerCapture(e.pointerId)) say("move:" + Math.round(e.clientY) + ":" + e.buttons);' +
        '});' +
        't.addEventListener("pointerup", function (e) { say("up:" + t.hasPointerCapture(e.pointerId)); });' +
        't.addEventListener("mouseup", function () { say("mouseup"); });' +
        'document.getElementById("other").addEventListener("pointermove", function () {' +
        '  if (r.indexOf("other") < 0) say("other");' +
        '});' +
        'try { t.setPointerCapture(1); say("idle:" + t.hasPointerCapture(1)); } catch (e) { say(e.name); }' +
        'try { t.setPointerCapture(7); } catch (e) { say(e.name); }' +
        '</script>',
      {},
    );
    const root = screen.getByTestName('page') as unknown as {
      children: DrawnNode[];
    };
    const node = root.children[0];
    const dx = 50 - node.abs.width / 2;
    const onTrack = 10 - node.abs.height / 2;
    const onOther = 60 - node.abs.height / 2;
    await act(async () => fireEvent.mouseMove(node, { dx, dy: onTrack }));
    await act(async () => fireEvent.mouseDown(node, { dx, dy: onTrack }));
    await act(async () => fireEvent.mouseMove(node, { dx, dy: onOther }));
    await act(async () => fireEvent.mouseUp(node, { dx, dy: onOther }));
    await act(async () => fireEvent.mouseMove(node, { dx, dy: onOther + 1 }));
    assert.equal(
      await until(
        () => text('page', 'out'),
        (t) => t.includes('other'),
      ),
      [
        'idle:false',
        'NotFoundError',
        'down:false:1',
        'set:true',
        'got',
        'move:60:1',
        'up:true',
        'mouseup',
        'lost',
        'other',
      ].join(','),
      logs.join('\n'),
    );
    assert.ok(!logs.some((l) => l.includes('TypeError')), logs.join('\n'));
  },
);

metric(
  "the pointer's moves, the wheel and a secondary press over a canvas reach its listeners",
  async () => {
    const { text, logs } = await hostedFrames(
      '<style>body{margin:0}canvas{display:block;width:100px;height:50px}</style>' +
        '<canvas id="c" width="10" height="5"></canvas><p id="out"></p><script>' +
        'var c = document.getElementById("c"); var r = [];' +
        'var x = c.getContext("2d"); x.fillStyle = "red"; x.fillRect(0, 0, 10, 5);' +
        '["pointerover", "mouseenter", "mousemove", "wheel", "contextmenu"].forEach(function (t) {' +
        '  c.addEventListener(t, function (e) {' +
        '    var said = t + (t === "wheel" ? ":" + (e.deltaY > 0) + ":" + (e instanceof WheelEvent) : "")' +
        '      + (t === "mousemove" ? ":" + Math.round(e.offsetX) : "");' +
        '    if (r.indexOf(said) < 0) r.push(said);' +
        '    if (t === "wheel" || t === "contextmenu") e.preventDefault();' +
        '    document.getElementById("out").textContent = r.join(",");' +
        '  }, { passive: false });' +
        '});' +
        '</script>',
      {},
    );
    const root = screen.getByTestName('page') as unknown as {
      children: DrawnNode[];
    };
    const node = root.children[0];
    // the canvas's middle, 50 by 25 in the document
    const dx = 50 - node.abs.width / 2;
    const dy = 25 - node.abs.height / 2;
    await act(async () => fireEvent.mouseMove(node, { dx, dy }));
    await act(async () => fireEvent.wheel(node, { dx, dy, deltaY: 1 }));
    await act(async () => {
      fireEvent.mouseDown(node, { dx, dy, button: 3 });
      fireEvent.mouseUp(node, { dx, dy, button: 3 });
    });
    assert.equal(
      await until(
        () => text('page', 'out'),
        (t) => t.includes('contextmenu'),
      ),
      'pointerover,mouseenter,mousemove:50,wheel:true:true,contextmenu',
      logs.join('\n'),
    );
  },
);
