// What a frame has of the page around it, and the page of the frame, where one
// of them asks for less: `<iframe sandbox>` and a policy's `sandbox`, which
// `src/html/scripts/sandbox.ts` reads, and `X-Frame-Options` and
// `frame-ancestors`, which `framing.ts` does. Each is the host's to hold, so
// the tests are a page doing what it should not, and what it was told.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Document, Element } from 'domhandler';

import { Html, HtmlNetwork, preloadHtmlScripts } from '../../src/html/index.js';
import { CookieJar } from '../../src/html/cookies.js';
import type {
  HtmlPopup,
  HtmlScripts,
  ResourceRequest,
} from '../../src/html/index.js';
import type { HtmlPermissionState } from '../../src/html/permissions.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { framingRefused } from '../../src/html/scripts/framing.js';
import { DomHost } from '../../src/html/scripts/host.js';
import type {
  FetchRequest,
  FetchResponse,
  HostSeams,
} from '../../src/html/scripts/host.js';
import {
  SB_ALL,
  SB_FORMS,
  SB_ORIGIN,
  SB_POPUPS,
  SB_SCRIPTS,
  SB_TOP,
  SB_TOP_GESTURE,
  parseSandbox,
  sandboxOfPolicy,
} from '../../src/html/scripts/sandbox.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;
/** A test that presses at a point, which only a real server can. */
const pressing = SCRIPTS_CONTAINED && FONTS ? nodeTest : nodeTest.skip;

const APP = 'https://app.test/';
const OTHER = 'https://other.test/';

interface Answer {
  body?: string;
  headers?: [string, string][];
}

interface Scene {
  logs: string[];
  asked: FetchRequest[];
  submitted: string[];
  /** What the host's `onLink` heard. */
  linked: string[];
  /** What was asked of `onResource`. */
  resources: ResourceRequest[];
  navigated: string[];
  opened: HtmlPopup[];
  tabs: string[];
  /** What the host's `onDownload` was handed to save. */
  downloads: string[];
  /** A press and a release at a point of the window, as a user's. */
  click(x: number, y: number): Promise<void>;
}

const HTML: [string, string][] = [['content-type', 'text/html']];

/** A page of `APP` with `body` in it, on a network that answers `pages`. */
async function scene(
  body: string,
  pages: Record<string, Answer | string> = {},
  extra: Partial<HtmlScripts> = {},
  base = APP,
): Promise<Scene> {
  const out: Scene = {
    logs: [],
    asked: [],
    submitted: [],
    linked: [],
    resources: [],
    navigated: [],
    opened: [],
    tabs: [],
    downloads: [],
    click: async () => {},
  };
  const fetch = async (request: FetchRequest): Promise<FetchResponse> => {
    out.asked.push(request);
    const url = request.url.split('#')[0];
    const found = pages[url];
    const answer = typeof found === 'string' ? { body: found } : found;
    return {
      url,
      status: answer ? 200 : 404,
      statusText: '',
      redirected: false,
      headers: [...HTML, ...(answer?.headers ?? [])],
      body: answer?.body ?? 'missing',
    };
  };
  const scripts: HtmlScripts = {
    log: (level, text) => void out.logs.push(`${level}: ${text}`),
    fetch,
    navigate: (to, how) => {
      if (how === 'tab') out.tabs.push(to);
      else out.navigated.push(to);
    },
    popups: {
      unblocked: true,
      open(popup) {
        out.opened.push(popup);
        return true;
      },
    },
    ...extra,
  };
  function Host() {
    return h(Html, {
      source: `<!doctype html><html><body style="margin:0">${body}</body></html>`,
      partial: false,
      baseUrl: base,
      scripts,
      onSubmit: (s: { url: string }) => void out.submitted.push(s.url),
      onLink: (href: string) => void out.linked.push(href),
      onDownload: (d: { url: string }) => void out.downloads.push(d.url),
      onResource: (request: ResourceRequest) => {
        out.resources.push(request);
        const found = pages[request.url];
        return request.kind === 'script' && typeof found === 'string'
          ? { kind: 'script' as const, text: found }
          : null;
      },
      style: { flexGrow: 1 },
    });
  }
  const rendered = await renderX11(
    h(Host),
    FONTS
      ? { width: 480, height: 320, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  const server = (
    rendered as unknown as {
      server?: {
        injectPointerMove(x: number, y: number): void;
        injectButton(button: number, down: boolean): void;
      };
    }
  ).server;
  out.click = async (x, y) => {
    for (const step of [
      () => server!.injectPointerMove(x, y),
      () => server!.injectButton(1, true),
      () => server!.injectButton(1, false),
    ]) {
      step();
      await settle(40);
    }
  };
  return out;
}

async function until(s: Scene, prefix: string, ms = 4000): Promise<string> {
  const end = Date.now() + ms;
  for (;;) {
    const line = s.logs.find((l) => l.includes(prefix));
    if (line) {
      return line.slice(line.lastIndexOf(prefix) + prefix.length).trim();
    }
    assert.ok(Date.now() < end, `no "${prefix}", in:\n${s.logs.join('\n')}`);
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
}

async function settle(ms = 250): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
}

const script = (code: string): string => `<script>${code}<\/script>`;
const escapeQuotes = (html: string): string => html.replaceAll('"', '&quot;');

const FRAME = `${APP}frame`;

test('a token lifts its own flag, and what it does not know lifts nothing', () => {
  assert.equal(parseSandbox(''), SB_ALL);
  assert.equal(parseSandbox('nonsense'), SB_ALL);
  assert.ok(!(parseSandbox('ALLOW-SCRIPTS') & SB_SCRIPTS));
  assert.ok(parseSandbox('allow-scripts') & SB_ORIGIN);
  assert.ok(!(parseSandbox('\tallow-same-origin\n allow-forms') & SB_FORMS));
  assert.ok(!(parseSandbox('allow-popups') & SB_POPUPS));
  const gesture = parseSandbox('allow-top-navigation-by-user-activation');
  assert.ok(!(gesture & SB_TOP_GESTURE) && gesture & SB_TOP);
  assert.ok(!(parseSandbox('allow-top-navigation') & SB_TOP));
  assert.equal(
    sandboxOfPolicy([
      ['Content-Security-Policy', "default-src 'self'; sandbox allow-forms"],
    ]) & SB_FORMS,
    0,
  );
  assert.equal(
    sandboxOfPolicy([
      ['content-security-policy-report-only', 'sandbox'],
      ['content-security-policy', "default-src 'self'"],
    ]),
    0,
  );
  assert.equal(
    sandboxOfPolicy([
      ['content-security-policy', 'sandbox allow-scripts, sandbox'],
    ]),
    SB_ALL,
  );
});

test("a sandboxed frame of the page's own address has an origin of none, and the page's window is a number to it", async () => {
  const s = await scene(
    `${script(`
      window.secret = 'page-secret';
      document.title = 'page-title';
    `)}<iframe id=f sandbox="allow-scripts" src="${FRAME}"></iframe>${script(`
      const f = document.getElementById('f');
      f.onload = () => {
        console.log('page reads', f.contentDocument === null, (() => {
          try { return f.contentWindow.document; } catch (e) { return e.name; }
        })());
      };
    `)}`,
    {
      [FRAME]: script(`
        const read = (name, go) => {
          try { console.log(name, go()); } catch (e) { console.log(name, e.name); }
        };
        read('parent global', () => parent.secret);
        read('parent document', () => parent.document.title);
        read('element', () => frameElement);
        read('own origin', () => self.origin);
        read('address origin', () => location.origin);
        read('cookie', () => document.cookie);
        read('storage', () => localStorage.length);
        read('session', () => sessionStorage.length);
      `),
    },
  );
  assert.equal(await until(s, 'parent global'), 'SecurityError');
  assert.equal(await until(s, 'parent document'), 'SecurityError');
  assert.equal(await until(s, 'element'), 'null');
  assert.equal(await until(s, 'own origin'), 'null');
  assert.equal(await until(s, 'address origin'), 'https://app.test');
  assert.equal(await until(s, 'cookie'), 'SecurityError');
  assert.equal(await until(s, 'storage'), 'SecurityError');
  assert.equal(await until(s, 'session'), 'SecurityError');
  assert.equal(await until(s, 'page reads'), 'true SecurityError');
  assert.ok(!s.logs.join('\n').includes('page-secret'), s.logs.join('\n'));
});

test('allow-same-origin keeps the origin the address gives it, and hands the page its document', async () => {
  const s = await scene(
    `<iframe id=f sandbox="allow-scripts allow-same-origin" src="${FRAME}"></iframe>${script(`
      window.secret = 'mine';
      const f = document.getElementById('f');
      f.onload = () => console.log('page reads', f.contentDocument.title);
    `)}`,
    {
      [FRAME]: `<title>own</title>${script(`console.log('heard', parent.secret, self.origin);`)}`,
    },
  );
  assert.equal(await until(s, 'heard'), 'mine https://app.test');
  assert.equal(await until(s, 'page reads'), 'own');
});

test('a sandbox with no allow-scripts runs nothing, and its noscript is what it shows', async () => {
  const s = await scene(
    `<iframe id=f sandbox="allow-same-origin" src="${FRAME}"></iframe>${script(`
      const f = document.getElementById('f');
      f.onload = () => {
        console.log('noscript', !!f.contentDocument.querySelector('noscript'));
        const added = f.contentDocument.createElement('script');
        added.textContent = "console.log('put in ran')";
        f.contentDocument.body.append(added);
        console.log('loaded');
      };
    `)}`,
    {
      [FRAME]: `<body>${script(`console.log('frame ran');`)}<noscript>shown</noscript>`,
    },
  );
  await until(s, 'loaded');
  await settle();
  assert.ok(!s.logs.join('\n').includes('frame ran'), s.logs.join('\n'));
  assert.ok(!s.logs.join('\n').includes('put in ran'), s.logs.join('\n'));
});

/** A frame's document with no script of its own, around a frame that runs
 *  `code`. */
const around = (code: string): string =>
  `<p>no script</p><iframe srcdoc="<script>${code}<\/script>"></iframe>`;

test('a frame in a document with no script of its own loads, runs and is drawn, as one in the page is', async () => {
  const s = await scene(
    `<iframe src="${APP}a" style="border:0;width:300px;height:200px"></iframe>`,
    {
      [`${APP}a`]: `<p>no script</p><iframe style="border:0;width:200px;height:100px" srcdoc="<p id=deep>deep</p><script>console.log('nested ran', self.origin)<\/script>"></iframe>`,
    },
  );
  assert.equal(await until(s, 'nested ran'), APP.slice(0, -1));
  await settle(300);
  if (!FONTS) return;
  const { screen } = await import('react-x11/test');
  type View = {
    kind: string;
    document?: Document;
    abs: { width: number; height: number };
  };
  const drawn = screen
    .all((n) => n.kind === 'htmlview')
    .map((n) => n as unknown as View)
    .find((v) => !!v.document && findDeep(v.document));
  assert.ok(drawn, 'no view draws the inner frame');
  assert.ok(
    drawn.abs.width > 0 && drawn.abs.height > 0,
    JSON.stringify(drawn.abs),
  );
});

/** Whether a document holds the inner frame's `#deep`. */
function findDeep(doc: Document): boolean {
  const walk = (nodes: unknown[]): boolean =>
    nodes.some((n) => {
      const el = n as Element;
      return (
        el.attribs?.id === 'deep' ||
        (Array.isArray(el.children) && walk(el.children))
      );
    });
  return walk(doc.children);
}

test("a frame in a sandbox with no script of its own is the sandbox's, and runs only as it lets it", async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${APP}a"></iframe>
     <iframe sandbox src="${APP}b"></iframe>`,
    {
      [`${APP}a`]: around(`console.log('nested a', self.origin)`),
      [`${APP}b`]: around(`console.log('nested b', self.origin)`),
    },
  );
  assert.equal(await until(s, 'nested a'), 'null');
  await settle();
  assert.ok(!s.logs.some((l) => l.includes('nested b')), s.logs.join('\n'));
});

test("a frame in another origin's document with no script is not run as the page's", async () => {
  const s = await scene(`<iframe src="${OTHER}a"></iframe>`, {
    [`${OTHER}a`]: around(`console.log('nested of other', self.origin)`),
  });
  await settle(600);
  const ran = s.logs.find((l) => l.includes('nested of other'));
  assert.ok(
    !ran || !ran.endsWith(APP.slice(0, -1)),
    `ran as the page's: ${ran}`,
  );
});

test('a sandboxed srcdoc is sandboxed, of no origin, whatever the page it came from', async () => {
  const s = await scene(
    `${script(`window.secret = 'page-secret';`)}
    <iframe sandbox="allow-scripts" srcdoc="<script>
      try { console.log('reached', parent.secret); } catch (e) { console.log('reached', e.name); }
      console.log('srcdoc origin', self.origin);
    <\/script>"></iframe>
    <iframe sandbox srcdoc="<script>console.log('no scripts ran')<\/script>"></iframe>`,
  );
  assert.equal(await until(s, 'reached'), 'SecurityError');
  assert.equal(await until(s, 'srcdoc origin'), 'null');
  await settle();
  assert.ok(!s.logs.join('\n').includes('no scripts ran'), s.logs.join('\n'));
});

test("what a sandbox's response says of itself is a sandbox, of a frame with none", async () => {
  const s = await scene(
    `${script(`window.secret = 'page-secret';`)}
    <iframe id=f src="${FRAME}"></iframe>${script(`
      const f = document.getElementById('f');
      f.onload = () => console.log('page reads', f.contentDocument === null);
    `)}`,
    {
      [FRAME]: {
        body: script(`
          try { console.log('reached', parent.secret); } catch (e) { console.log('reached', e.name); }
        `),
        headers: [['content-security-policy', 'sandbox allow-scripts']],
      },
    },
  );
  assert.equal(await until(s, 'reached'), 'SecurityError');
  assert.equal(await until(s, 'page reads'), 'true');
});

test('a frame in a sandboxed frame is sandboxed, whatever it asks for', async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${FRAME}"></iframe>`,
    {
      [FRAME]: `<iframe sandbox="allow-scripts allow-same-origin" src="${APP}inner"></iframe>${script(`console.log('outer');`)}`,
      [`${APP}inner`]: script(`
        console.log('inner origin', self.origin);
        try { console.log('inner reached', localStorage.length); } catch (e) { console.log('inner reached', e.name); }
      `),
    },
  );
  assert.equal(await until(s, 'inner origin'), 'null');
  assert.equal(await until(s, 'inner reached'), 'SecurityError');
});

test('a change to the attribute is read at the next load, and not before', async () => {
  const s = await scene(
    `<iframe id=f src="${FRAME}"></iframe>${script(`
      const f = document.getElementById('f');
      let loads = 0;
      f.onload = () => {
        loads += 1;
        if (loads === 1) {
          f.setAttribute('sandbox', 'allow-scripts');
          console.log('still reached', f.contentDocument !== null);
          f.contentWindow.location.href = '${APP}second';
        } else console.log('then', f.contentDocument === null);
      };
    `)}`,
    {
      [FRAME]: script(`console.log('first', self.origin);`),
      [`${APP}second`]: script(`console.log('second', self.origin);`),
    },
  );
  assert.equal(await until(s, 'first'), 'https://app.test');
  assert.equal(await until(s, 'still reached'), 'true');
  assert.equal(await until(s, 'second'), 'null');
});

test('a form in a sandbox goes nowhere without allow-forms', async () => {
  const s = await scene(
    `<iframe id=a sandbox="allow-scripts" src="${APP}a"></iframe>
     <iframe id=b sandbox="allow-scripts allow-forms" src="${APP}b"></iframe>`,
    {
      [`${APP}a`]: `<form action="${APP}posted-a"></form>${script(`
        document.querySelector('form').submit();
        console.log('a done');
      `)}`,
      [`${APP}b`]: `<form action="${APP}posted-b"></form>${script(`
        document.querySelector('form').submit();
      `)}`,
      [`${APP}posted-b`]: 'done',
    },
  );
  await until(s, 'a done');
  await settle(400);
  const urls = s.asked.map((r) => r.url);
  assert.ok(!urls.some((u) => u.includes('posted-a')), urls.join(' '));
  assert.ok(
    urls.some((u) => u.includes('posted-b')),
    urls.join(' '),
  );
});

test('a sandbox opens no window, unless it may, and what it opens is sandboxed too', async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${APP}a"></iframe>
     <iframe sandbox="allow-scripts allow-popups" src="${APP}b"></iframe>
     <iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" src="${APP}c"></iframe>`,
    {
      [`${APP}a`]: script(`
        console.log('a opened', window.open('${APP}x') === null);
        console.log('a noopener', window.open('${APP}y', '_blank', 'noopener') === null);
      `),
      [`${APP}b`]: script(
        `console.log('b opened', window.open('${APP}b1') !== null);`,
      ),
      [`${APP}c`]: script(
        `console.log('c opened', window.open('${APP}c1') !== null);`,
      ),
    },
  );
  assert.equal(await until(s, 'a opened'), 'true');
  assert.equal(await until(s, 'a noopener'), 'true');
  assert.equal(await until(s, 'b opened'), 'true');
  assert.equal(await until(s, 'c opened'), 'true');
  await settle();
  assert.deepEqual(s.tabs, []);
  const opened = new Map(s.opened.map((p) => [p.url, p]));
  assert.equal(opened.size, 2);
  const sandboxOf = (url: string): number =>
    (opened.get(url) as unknown as { sandbox: number }).sandbox;
  assert.ok(sandboxOf(`${APP}b1`) & SB_ORIGIN);
  assert.equal(sandboxOf(`${APP}c1`), 0);
});

test('a window a sandbox lets out is of the opaque origin that opened it, and no real one', async () => {
  const s = await scene(
    `${script(`window.secret = 'page-secret';`)}
    <iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" src="${FRAME}"></iframe>`,
    {
      [FRAME]: script(`
        const w = window.open('');
        console.log('window origin', w.origin);
        console.log('its document', w.document !== null);
        const read = w.eval(\`
          try { opener.parent.secret; 'reached page ' + opener.parent.secret; }
          catch (e) { 'refused ' + e.name; }
        \`);
        console.log('from it', read);
      `),
    },
  );
  assert.equal(await until(s, 'window origin'), 'null');
  assert.equal(await until(s, 'its document'), 'true');
  assert.equal(await until(s, 'from it'), 'refused SecurityError');
});

test('a frame of no content stays what it was, and hears no load', async () => {
  const noContent = `${APP}none`;
  const s = await scene(
    `<iframe id="f" src="${noContent}"></iframe>${script(`
      const frame = document.getElementById('f');
      frame.onload = () => console.log('heard load');
      setTimeout(() => {
        console.log('still blank', frame.contentWindow.location.href);
        frame.onload = () => console.log('then', frame.contentDocument.title);
        frame.src = '${APP}next';
      }, 100);
    `)}`,
    { [`${APP}next`]: '<title>next</title>' },
    {
      fetch: async (request) => ({
        url: request.url,
        status: request.url === noContent ? 204 : 200,
        statusText: '',
        redirected: false,
        headers: HTML,
        body: request.url === noContent ? '' : '<title>next</title>',
      }),
    },
  );
  assert.equal(await until(s, 'still blank'), 'about:blank');
  assert.equal(await until(s, 'then'), 'next');
  assert.ok(!s.logs.some((l) => l.includes('heard load')), s.logs.join('\n'));
});

test("a frame's marginwidth and marginheight are its document's body's, under the body's own", async () => {
  const read = `
    const s = getComputedStyle(document.body);
    console.log(location.pathname, s.marginTop, s.marginLeft);
  `;
  const s = await scene(
    `<iframe marginwidth="70" marginheight="60" src="${APP}a"></iframe>
     <iframe marginwidth="70" src="${APP}b"></iframe>
     <iframe id="still" marginwidth="70"></iframe>
     ${script(`
       const body = document.getElementById('still').contentDocument.body;
       console.log('blank', getComputedStyle(body).marginLeft);
     `)}`,
    {
      [`${APP}a`]: `<!doctype html><body>${script(read)}`,
      [`${APP}b`]: `<!doctype html><body leftmargin="30">${script(read)}`,
    },
  );
  assert.equal(await until(s, '/a'), '60px 70px');
  assert.equal(await until(s, '/b'), '8px 30px');
  assert.equal(await until(s, 'blank'), '70px');
});

test("a sandbox's srcdoc reads the origin it has, which its blob URLs say", async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts" srcdoc="${escapeQuotes(
      script(`
        console.log('blob', new URL(URL.createObjectURL(new Blob(['x']))).origin);
        console.log('location', location.origin);
        console.log('window', self.origin);
      `),
    )}"></iframe>
    <iframe srcdoc="${escapeQuotes(
      script(`console.log('unsandboxed', location.origin);`),
    )}"></iframe>
    <iframe sandbox="allow-scripts" src="${FRAME}"></iframe>`,
    { [FRAME]: script(`console.log('addressed', location.origin);`) },
  );
  assert.equal(await until(s, 'blob'), 'null');
  assert.equal(await until(s, 'location'), 'null');
  assert.equal(await until(s, 'window'), 'null');
  assert.equal(await until(s, 'unsandboxed'), new URL(APP).origin);
  assert.equal(await until(s, 'addressed'), new URL(FRAME).origin);
});

test('a frame sends the top window somewhere only as its flags say', async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${APP}a"></iframe>
     <iframe sandbox="allow-scripts allow-top-navigation" src="${APP}b"></iframe>
     <iframe sandbox="allow-scripts allow-top-navigation-by-user-activation" src="${APP}c"></iframe>
     <iframe src="${OTHER}d"></iframe>`,
    {
      [`${APP}a`]: script(
        `try { top.location = '${APP}from-a'; } catch (e) { console.log('a refused', e.name); } console.log('a done');`,
      ),
      [`${APP}b`]: script(
        `top.location = '${APP}from-b'; console.log('b done');`,
      ),
      [`${APP}c`]: script(
        `try { top.location.href = '${APP}from-c'; } catch (e) { console.log('c refused', e.name); } console.log('c done');`,
      ),
      [`${OTHER}d`]: script(
        `try { top.location.replace('${OTHER}from-d'); } catch (e) { console.log('d refused', e.name); } console.log('d done');`,
      ),
    },
  );
  assert.equal(await until(s, 'a refused'), 'SecurityError');
  await until(s, 'b done');
  assert.equal(await until(s, 'c refused'), 'SecurityError');
  assert.equal(await until(s, 'd refused'), 'SecurityError');
  assert.deepEqual(s.navigated, [`${APP}from-b`]);
});

test('a javascript: address goes nowhere up', async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts allow-top-navigation" src="${APP}a"></iframe>`,
    {
      [`${APP}a`]: script(
        `top.location = 'javascript:alert(1)'; console.log('a done');`,
      ),
    },
  );
  await until(s, 'a done');
  assert.deepEqual(s.navigated, []);
});

test('two sandboxes share nothing by having no origin', async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${APP}a"></iframe>
     <iframe sandbox="allow-scripts" src="${APP}b"></iframe>`,
    {
      [`${APP}a`]: script(`
        const c = new BroadcastChannel('x');
        c.onmessage = (e) => console.log('heard across', e.data);
        parent.postMessage('a ready', '*');
        console.log('a ready');
      `),
      [`${APP}b`]: script(`
        setTimeout(() => {
          new BroadcastChannel('x').postMessage('secret');
          console.log('b sent');
        }, 100);
      `),
    },
  );
  await until(s, 'a ready');
  await until(s, 'b sent');
  await settle();
  assert.ok(!s.logs.join('\n').includes('heard across'), s.logs.join('\n'));
});

test("a sandbox's request says it is of no origin, and carries no cookies of the address's", async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${FRAME}"></iframe>`,
    {
      [FRAME]: script(`
        fetch('${APP}data').then(
          (r) => console.log('read', r.status),
          () => console.log('refused'),
        );
      `),
      [`${APP}data`]: {
        body: 'secret',
        headers: [['access-control-allow-origin', 'https://app.test']],
      },
    },
  );
  assert.equal(await until(s, 'refused'), '');
  const asked = s.asked.find((r) => r.url === `${APP}data`)!;
  assert.equal(asked.opaqueOrigin, true);
  assert.equal(asked.credentials, 'omit');
});

test("what a sandbox's document loads is asked for as of no origin, and as the frame's", async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${APP}a"></iframe>
     <iframe src="${APP}b"></iframe>`,
    {
      [`${APP}a`]: `<img src="${APP}a.png"><script src="${APP}a.js"></script>`,
      [`${APP}a.js`]: `console.log('a ran');`,
      [`${APP}b`]: `<img src="${APP}b.png"><script src="${APP}b.js"></script>`,
      [`${APP}b.js`]: `console.log('b ran');`,
    },
  );
  await until(s, 'a ran');
  await until(s, 'b ran');
  await settle();
  const of = (url: string) => {
    const found = s.resources.find((r) => r.url === url);
    assert.ok(found, `${url} was not asked for`);
    return { client: found.client, opaque: !!found.opaqueOrigin };
  };
  assert.deepEqual(of(`${APP}a.png`), { client: `${APP}a`, opaque: true });
  assert.deepEqual(of(`${APP}a.js`), { client: `${APP}a`, opaque: true });
  assert.deepEqual(of(`${APP}b.png`), { client: `${APP}b`, opaque: false });
  assert.deepEqual(of(`${APP}b.js`), { client: `${APP}b`, opaque: false });
});

test('a top-level document its policy sandboxes asks for what it loads as of no origin', async () => {
  const s = await scene(
    `<img src="${APP}top.png">${script(`console.log('ran');`)}`,
    {},
    { headers: [['content-security-policy', 'sandbox allow-scripts']] },
  );
  await until(s, 'ran');
  await settle();
  const asked = s.resources.find((r) => r.url === `${APP}top.png`);
  assert.equal(asked?.opaqueOrigin, true);
});

test("the network asks for what a document of no origin loads with no cookie of the site's alone, and as the frame's", async (t) => {
  const heard: { cookie?: string; referer?: string; url: string }[] = [];
  const site = createServer((req, res) => {
    heard.push({
      url: req.url ?? '',
      cookie: req.headers.cookie,
      referer: req.headers.referer,
    });
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'max-age=600');
    res.end('x');
  });
  await new Promise<void>((go) => site.listen(0, '127.0.0.1', go));
  t.after(() => site.close());
  const { port } = site.address() as AddressInfo;
  const page = `http://127.0.0.1:${port}/`;
  const jar = new CookieJar();
  jar.store(page, ['lax=1; SameSite=Lax; Path=/'], {
    http: true,
    sameSite: true,
  });
  const load = new HtmlNetwork({ cookies: jar }).resources(page);
  const element = new Element('img', {});
  const ask = (path: string, extra: Partial<ResourceRequest>) =>
    load({ url: `${page}${path}`, kind: 'image', element, ...extra });
  await ask('pic', {});
  await ask('pic', { opaqueOrigin: true, client: `${page}frame` });
  await ask('other', { client: `${page}frame` });
  assert.deepEqual(heard, [
    { url: '/pic', cookie: 'lax=1', referer: page },
    { url: '/pic', cookie: undefined, referer: `${page}frame` },
    { url: '/other', cookie: 'lax=1', referer: `${page}frame` },
  ]);
});

/** A page its server says is a file to save. */
const DOWNLOAD: Answer = {
  body: script(`console.log('shown', location.pathname);`),
  headers: [['content-disposition', 'attachment']],
};

test('a sandbox that saves no file goes nowhere where it is sent to a download, and one that may hands it to the host to save', async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${APP}a"></iframe>
     <iframe sandbox="allow-scripts allow-downloads" src="${APP}b"></iframe>`,
    {
      [`${APP}a`]: script(`location.href = '${APP}dl-a';`),
      [`${APP}b`]: script(`location.href = '${APP}dl-b';`),
      [`${APP}dl-a`]: DOWNLOAD,
      [`${APP}dl-b`]: DOWNLOAD,
    },
  );
  const end = Date.now() + 4000;
  while (!s.downloads.length && Date.now() < end) await settle(20);
  // a download, and no navigation: the frame shows what it showed (HTML
  // 7.4.2.3.3, "handle as a download")
  assert.deepEqual(s.downloads, [`${APP}dl-b`]);
  await settle();
  assert.ok(!s.logs.some((l) => l.includes('shown /dl-')), s.logs.join('\n'));
  assert.ok(
    s.logs.some((l) => l.includes(`${APP}dl-a was not downloaded`)),
    s.logs.join('\n'),
  );
  assert.equal(
    s.asked.find((r) => r.url === `${APP}dl-a`)?.stream,
    true,
    'not asked for a piece at a time, so not to be cut off',
  );
});

test('a page of a sandbox is told by its origin what it may answer to', async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${FRAME}"></iframe>`,
    {
      [FRAME]: script(`
        fetch('${APP}data').then((r) => r.text()).then((t) => console.log('read', t));
      `),
      [`${APP}data`]: {
        body: 'for anyone',
        headers: [['access-control-allow-origin', 'null']],
      },
    },
  );
  assert.equal(await until(s, 'read'), 'for anyone');
});

test('a message from a sandbox says it is from nobody, and one meant for its address does not reach it', async () => {
  const s = await scene(
    `<iframe id=f sandbox="allow-scripts" src="${FRAME}"></iframe>${script(`
      addEventListener('message', (e) => {
        console.log('from', JSON.stringify(e.origin), e.data);
        const w = document.getElementById('f').contentWindow;
        w.postMessage('wrong', 'https://app.test');
        w.postMessage('right', '*');
      });
    `)}`,
    {
      [FRAME]: script(`
        addEventListener('message', (e) => console.log('frame heard', e.data, JSON.stringify(e.origin)));
        parent.postMessage('up', '*');
      `),
    },
  );
  assert.equal(await until(s, 'from'), '"null" up');
  assert.equal(await until(s, 'frame heard'), 'right "https://app.test"');
  assert.ok(
    !s.logs.some((l) => l.includes('frame heard wrong')),
    s.logs.join('\n'),
  );
});

test("what a sandboxed frame holds is none of the page's, whatever the page replaces", async () => {
  const hook = `
    const hits = [];
    const frame = document.getElementById('f');
    const raw = { get: Map.prototype.get, weak: WeakMap.prototype.get, set: Map.prototype.set, str: String };
    const look = (found) => {
      try {
        if (found && found.victim === 'victim-secret') hits.push('global');
        if (found && found.title === 'victim-title') hits.push('document');
      } catch {}
      return found;
    };
    Map.prototype.get = function (k) { return look(raw.get.call(this, k)); };
    WeakMap.prototype.get = function (k) { return look(raw.weak.call(this, k)); };
    Map.prototype.set = function (k, v) { look(v); return raw.set.call(this, k, v); };
    const touch = () => {
      const w = frame.contentWindow;
      for (const walk of [() => w.victim, () => w.document, () => w.location.href, () => w.frames, () => frame.contentDocument]) {
        try { look(walk()); } catch {}
      }
    };
    addEventListener('message', () => {
      touch();
      window.String = () => 'same';
      touch();
      window.String = raw.str;
      Map.prototype.get = raw.get; WeakMap.prototype.get = raw.weak; Map.prototype.set = raw.set;
      console.log('attacked', JSON.stringify([...new Set(hits)]));
    }, { once: true });
  `;
  const s = await scene(
    `<iframe id=f sandbox="allow-scripts" src="${FRAME}"></iframe>${script(hook)}`,
    {
      [FRAME]: `<title>victim-title</title>${script(`
        window.victim = 'victim-secret';
        parent.postMessage('up', '*');
      `)}`,
    },
  );
  assert.equal(await until(s, 'attacked'), '[]');
});

/**
 * A page that sees everything the facade touches: every method of what the
 * facade calls is replaced before the frame is even there, and each argument,
 * `this` and result is looked through for what the victim holds. `reach`
 * names the victim's window, `when` is what starts the walk over it.
 */
const SEE_ALL = (reach: string, when: string): string => `
  const apply = Reflect.apply;
  const names = Object.getOwnPropertyNames;
  const describe = Object.getOwnPropertyDescriptor;
  const define = Object.defineProperty;
  const includes = String.prototype.includes;
  const hits = [];
  let shown = 0;
  let busy = false;
  const look = (v) => {
    if (busy || v === null || v === undefined || v === window) return;
    busy = true;
    shown += 1;
    try {
      if (typeof v === 'string') {
        if (apply(includes, v, ['victim-'])) hits[hits.length] = v;
      } else if (typeof v === 'object' || typeof v === 'function') {
        if (v.victim === 'victim-secret') hits[hits.length] = 'global';
        if (v.title === 'victim-title') hits[hits.length] = 'document';
      }
    } catch {}
    busy = false;
  };
  const undo = [];
  const hook = (target) => {
    for (const name of names(target)) {
      const d = describe(target, name);
      if (typeof d?.value !== 'function' || !d.configurable) continue;
      if (name === 'constructor') continue;
      const fn = d.value;
      define(target, name, {
        ...d,
        value: function (...args) {
          if (!busy) {
            look(this);
            for (let i = 0; i < args.length; i += 1) look(args[i]);
          }
          const r = apply(fn, this, args);
          if (!busy) look(r);
          return r;
        },
      });
      undo[undo.length] = () => define(target, name, d);
    }
  };
  for (const target of [
    Map.prototype, WeakMap.prototype, Set.prototype, WeakSet.prototype,
    Array.prototype, Promise.prototype, Object, Object.prototype, Promise,
    Reflect, JSON,
  ]) hook(target);
  const walk = () => {
    const w = ${reach};
    for (const go of [
      () => w.victim, () => w.document, () => w.document.title,
      () => w.location.href, () => w.frames, () => w.parent, () => w.top,
      () => frameElement, () => document.querySelector('iframe')?.contentDocument,
    ]) {
      try { look(go()); } catch {}
    }
  };
  ${when}(() => {
    walk();
    for (let i = undo.length - 1; i >= 0; i -= 1) undo[i]();
    console.log('saw', shown > 0, hits.length ? 'caught' : 'nothing');
  });
`;

/** The victim's page: what it holds, and what it says once it has. */
const VICTIM = `<title>victim-title</title>${script(`
  window.victim = 'victim-secret';
  parent.postMessage('up', '*');
`)}`;

test('the probe that finds nothing below finds a frame of the same origin', async () => {
  const s = await scene(
    `<iframe id=f src="${FRAME}"></iframe>${script(
      SEE_ALL(
        'document.getElementById("f").contentWindow',
        "((go) => addEventListener('message', go, { once: true }))",
      ),
    )}`,
    { [FRAME]: VICTIM },
  );
  assert.equal(await until(s, 'saw'), 'true caught');
});

test('a page that sees all the facade touches finds nothing of a sandboxed frame of its own address', async () => {
  const s = await scene(
    `<iframe id=f sandbox="allow-scripts" src="${FRAME}"></iframe>${script(
      SEE_ALL(
        'document.getElementById("f").contentWindow',
        "((go) => addEventListener('message', go, { once: true }))",
      ),
    )}`,
    { [FRAME]: VICTIM },
  );
  assert.equal(await until(s, 'saw'), 'true nothing');
});

test('a sandboxed frame that sees all the facade touches finds nothing of the page around it', async () => {
  const s = await scene(
    `<title>victim-title</title>${script(`window.victim = 'victim-secret';`)}
    <iframe sandbox="allow-scripts" src="${FRAME}"></iframe>`,
    {
      [FRAME]: script(SEE_ALL('parent', '((go) => setTimeout(go, 50))')),
    },
  );
  assert.equal(await until(s, 'saw'), 'true nothing');
});

test('a document that refused its frame leaves a page that sees all the facade touches nothing', async () => {
  const s = await scene(
    `<iframe id=f src="${APP}deny"></iframe>${script(
      SEE_ALL(
        'document.getElementById("f").contentWindow',
        "((go) => document.getElementById('f').addEventListener('load', go, { once: true }))",
      ),
    )}`,
    {
      [`${APP}deny`]: {
        body: VICTIM,
        headers: [['x-frame-options', 'DENY']],
      },
    },
  );
  assert.equal(await until(s, 'saw'), 'true nothing');
});

test('a worker a sandbox starts is of no origin either, from a blob or its own address', async () => {
  const worker = `
    fetch('${APP}data').then(
      (r) => postMessage('read ' + r.status),
      () => postMessage('refused ' + self.origin),
    );
  `;
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${FRAME}"></iframe>`,
    {
      [FRAME]: script(`
        const url = URL.createObjectURL(new Blob([${JSON.stringify(worker)}]));
        console.log('blob', url.startsWith('blob:null/'));
        new Worker(url).onmessage = (e) => console.log('worker said', e.data);
        try {
          new Worker('${APP}w.js');
          console.log('address started');
        } catch (e) {
          console.log('address', e.name);
        }
      `),
      [`${APP}w.js`]: worker,
      [`${APP}data`]: {
        body: 'secret',
        headers: [['access-control-allow-origin', 'https://app.test']],
      },
    },
  );
  assert.equal(await until(s, 'blob'), 'true');
  assert.equal(await until(s, 'address'), 'SecurityError');
  assert.equal(await until(s, 'worker said', 8000), 'refused null');
  const asked = s.asked.find((r) => r.url === `${APP}data`)!;
  assert.equal(asked.opaqueOrigin, true);
  assert.equal(asked.credentials, 'omit');
});

test("a sandbox that talks its facade round still starts no worker from an address of no origin's", async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${FRAME}"></iframe>`,
    {
      [FRAME]: script(`
        // what the facade checks is its own address's; what it hands the host
        // is written by the page's own \`JSON\`
        const stringify = JSON.stringify;
        JSON.stringify = (v, ...rest) =>
          v && typeof v === 'object' && typeof v.url === 'string' && v.url.endsWith('w.js')
            ? stringify({ ...v, url: window.forged }, ...rest)
            : stringify(v, ...rest);
        for (const to of ['file:///etc/hosts', 'https://elsewhere.test/w.js']) {
          window.forged = to;
          try {
            new Worker('w.js');
            console.log('started', to);
          } catch (e) {
            console.log('refused', to, e.name);
          }
        }
        JSON.stringify = stringify;
        const url = URL.createObjectURL(new Blob(['postMessage(self.origin)']));
        new Worker(url).onmessage = (e) => console.log('blob said', e.data);
      `),
    },
  );
  assert.equal(await until(s, 'blob said', 8000), 'null');
  for (const to of ['file:///etc/hosts', 'https://elsewhere.test/w.js']) {
    assert.ok(
      s.logs.some((l) => l.endsWith(`refused ${to} SecurityError`)),
      s.logs.join('\n'),
    );
  }
  assert.ok(!s.logs.some((l) => l.includes('started')), s.logs.join('\n'));
  assert.ok(!s.asked.some((r) => /^file:|elsewhere/.test(r.url)));
});

test('a sandbox may not set document.domain, whatever its tokens let it keep', async () => {
  const set = script(`
    try { document.domain = document.domain; console.log('domain', location.pathname, 'set'); }
    catch (e) { console.log('domain', location.pathname, e.name); }
  `);
  const s = await scene(
    `<iframe sandbox="allow-scripts allow-same-origin" src="${APP}kept"></iframe>
     <iframe src="${APP}plain"></iframe>`,
    { [`${APP}kept`]: set, [`${APP}plain`]: set },
  );
  await until(s, 'domain /kept');
  await until(s, 'domain /plain');
  assert.ok(
    s.logs.some((l) => l.endsWith('domain /kept SecurityError')),
    s.logs.join('\n'),
  );
  assert.ok(
    s.logs.some((l) => l.endsWith('domain /plain set')),
    s.logs.join('\n'),
  );
});

test('document.domain and the storage getters answer for an origin of none', async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${FRAME}"></iframe>`,
    {
      [FRAME]: script(`
        const read = (name, go) => {
          try { console.log(name, JSON.stringify(go())); } catch (e) { console.log(name, e.name); }
        };
        read('domain', () => document.domain);
        read('set domain', () => { document.domain = 'app.test'; return 'set'; });
        read('getter', () => window.localStorage);
      `),
    },
  );
  assert.equal(await until(s, 'domain'), '""');
  assert.equal(await until(s, 'set domain'), 'SecurityError');
  assert.equal(await until(s, 'getter'), 'SecurityError');
});

test('a file: frame of a file: page is another origin: it loads, and the page has no document of it', async () => {
  const s = await scene(
    `<iframe id=f src="file:///site/frame.html"></iframe>${script(`
      const f = document.getElementById('f');
      f.onload = () => console.log('page reads', f.contentDocument === null);
    `)}`,
    {
      'file:///site/frame.html': `<title>t</title>${script(`
        try { console.log('reached', parent.document.title); } catch (e) { console.log('reached', e.name); }
      `)}`,
    },
    {},
    'file:///site/page.html',
  );
  assert.equal(await until(s, 'reached'), 'SecurityError');
  assert.equal(await until(s, 'page reads'), 'true');
});

test('a file: frame with no script of its own is no document of the page either', async () => {
  const s = await scene(
    `<iframe id=f src="file:///site/plain.html"></iframe>${script(`
      const f = document.getElementById('f');
      f.onload = () => console.log('page reads', f.contentDocument === null);
    `)}`,
    { 'file:///site/plain.html': '<title>plain</title>' },
    {},
    'file:///site/page.html',
  );
  assert.equal(await until(s, 'page reads'), 'true');
});

test('a page on the web does not reach a file: frame', async () => {
  const s = await scene(
    `<iframe id=f src="file:///etc/hosts"></iframe>${script(`
      document.getElementById('f').onload = () => console.log('settled');
    `)}`,
  );
  await until(s, 'settled');
  assert.deepEqual(s.asked, []);
});

test('a page replacing what the facade reads an origin through gets no store, no cookie and no worker', async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${FRAME}"></iframe>`,
    {
      [FRAME]: script(`
        const real = String;
        const read = (name, go) => {
          try { console.log(name, go()); } catch (e) { console.log(name, e.name); }
        };
        window.String = () => 'https://app.test';
        const url = URL.createObjectURL(new Blob(['postMessage(self.origin)']));
        read('forged store', () => window.localStorage);
        window.String = real;
        console.log('forged', url.slice(0, 22));
        read('forged worker', () => { new Worker(url); return 'started'; });
      `),
    },
  );
  assert.equal(await until(s, 'forged store'), 'SecurityError');
  assert.equal(await until(s, 'forged worker'), 'SecurityError');
});

/** A link the size of its frame, to a new window. */
const BLANK_LINK = `<body style="margin:0"><a href="${APP}x" target="_blank" style="display:block;height:90px">go</a></body>`;

pressing(
  'a sandbox with no script of its own opens a window that keeps its flags from a link a user follows, and no tab',
  async () => {
    const s = await scene(
      `<iframe sandbox="allow-popups" style="border:0;display:block;width:300px;height:100px" srcdoc='${BLANK_LINK}'></iframe>`,
      { [`${APP}x`]: 'x' },
    );
    await settle(300);
    await s.click(40, 30);
    await settle(300);
    assert.deepEqual(s.tabs, []);
    assert.deepEqual(s.linked, []);
    assert.equal(s.opened.length, 1);
    const flags = (s.opened[0] as unknown as { sandbox: number }).sandbox;
    assert.ok(flags & SB_ORIGIN && flags & SB_SCRIPTS, String(flags));
  },
);

pressing(
  'a top-level document whose policy sandboxes it, with no scripts to run, opens a window that keeps its flags and no tab',
  async () => {
    const s = await scene(
      `<a href="${APP}x" target="_blank" style="display:block;height:90px">go</a>`,
      { [`${APP}x`]: 'x' },
      { headers: [['content-security-policy', 'sandbox allow-popups']] },
    );
    await settle(300);
    await s.click(40, 30);
    await settle(300);
    assert.deepEqual(s.tabs, []);
    assert.deepEqual(s.linked, []);
    assert.equal(s.opened.length, 1);
    const flags = (s.opened[0] as unknown as { sandbox: number }).sandbox;
    assert.ok(flags & SB_ORIGIN && flags & SB_SCRIPTS, String(flags));
  },
);

pressing(
  'a sandbox with no allow-popups opens nothing from a link a user follows',
  async () => {
    const s = await scene(
      `<iframe sandbox style="border:0;display:block;width:300px;height:100px" srcdoc='${BLANK_LINK}'></iframe>`,
      { [`${APP}x`]: 'x' },
      { headers: [] },
    );
    await settle(300);
    await s.click(40, 30);
    await settle(300);
    assert.deepEqual(s.tabs, []);
    assert.deepEqual(s.linked, []);
    assert.deepEqual(s.opened, []);
  },
);

/** A document with scripts off, its response's headers handed in, and what
 *  it asked of the host. */
async function plain(source: string, headers: [string, string][]) {
  const out = {
    submitted: [] as string[],
    linked: [] as string[],
    downloads: [] as string[],
    click: async (_x: number, _y: number) => {},
    focused: (): string | undefined => undefined,
  };
  const rendered = await renderX11(
    h(Html, {
      source: `<!doctype html><body style="margin:0">${source}`,
      partial: false,
      baseUrl: APP,
      headers,
      onSubmit: (s: { url: string }) => void out.submitted.push(s.url),
      onLink: (href: string) => void out.linked.push(href),
      onDownload: (d: { url: string }) => void out.downloads.push(d.url),
      style: { flexGrow: 1 },
    }),
    { width: 480, height: 320, fonts: FONTS! },
  );
  const server = (
    rendered as unknown as {
      server: {
        injectPointerMove(x: number, y: number): void;
        injectButton(button: number, down: boolean): void;
      };
    }
  ).server;
  out.click = async (x, y) => {
    for (const step of [
      () => server.injectPointerMove(x, y),
      () => server.injectButton(1, true),
      () => server.injectButton(1, false),
    ]) {
      step();
      await settle(40);
    }
  };
  type Mounted = {
    focused?: boolean;
    children: Mounted[];
    props: { placeholder?: string };
  };
  out.focused = () => {
    const find = (node: Mounted): Mounted | null => {
      if (node.focused) return node;
      for (const child of node.children) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    return find(rendered.windowNode as unknown as Mounted)?.props.placeholder;
  };
  await settle(200);
  return out;
}

const ROWS = `<form action="${APP}posted"><button style="display:block;width:300px;height:50px;margin:0;border:0">go</button></form>
  <a href="${APP}blank" target="_blank" style="display:block;height:50px">blank</a>
  <a href="${APP}saved" download style="display:block;height:50px">save</a>
  <a href="${APP}here" style="display:block;height:50px">here</a>`;

pressing(
  "with scripts off, a document's own policy keeps its forms, its new windows and its downloads from it",
  async () => {
    const s = await plain(ROWS, [['content-security-policy', 'sandbox']]);
    for (const y of [25, 75, 125, 175]) await s.click(40, y);
    assert.deepEqual(s.submitted, []);
    assert.deepEqual(s.downloads, []);
    assert.deepEqual(s.linked, [`${APP}here`]);
  },
);

pressing(
  'with scripts off, what a policy gives back a document has',
  async () => {
    const s = await plain(ROWS, [
      [
        'content-security-policy',
        'sandbox allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads',
      ],
    ]);
    for (const y of [25, 75, 125, 175]) await s.click(40, y);
    assert.deepEqual(s.submitted, [`${APP}posted?`]);
    assert.deepEqual(s.downloads, [`${APP}saved`]);
    assert.deepEqual(s.linked, [`${APP}blank`, `${APP}here`]);
  },
);

pressing(
  'with scripts off and allow-popups, a link to a new window has no tab to carry its flags in, and goes nowhere',
  async () => {
    const s = await plain(ROWS, [
      ['content-security-policy', 'sandbox allow-popups'],
    ]);
    await s.click(40, 75);
    assert.deepEqual(s.linked, []);
  },
);

pressing(
  'a sandbox with no allow-scripts focuses nothing by autofocus, and one with it does',
  async () => {
    const field = '<input placeholder="wants" autofocus>';
    const held = await plain(field, [['content-security-policy', 'sandbox']]);
    assert.equal(held.focused(), undefined);
    cleanup();
    const given = await plain(field, [
      ['content-security-policy', 'sandbox allow-scripts'],
    ]);
    assert.equal(given.focused(), 'wants');
  },
);

pressing(
  "a sandboxed frame's autofocus is held back too, and one that may focuses",
  async () => {
    type Mounted = { focused?: boolean; props: { placeholder?: string } };
    const { screen } = await import('react-x11/test');
    const field = async (tokens: string): Promise<Mounted> => {
      await scene(
        `<iframe sandbox="${tokens}" style="border:0;display:block" srcdoc='<input placeholder="framed" autofocus>'></iframe>`,
      );
      await settle(400);
      const found = screen.all(
        (n) => (n as unknown as Mounted).props?.placeholder === 'framed',
      )[0] as unknown as Mounted | undefined;
      assert.ok(found, 'the frame drew no field');
      return found;
    };
    assert.ok(!(await field('allow-same-origin')).focused);
    cleanup();
    assert.ok((await field('allow-same-origin allow-scripts')).focused);
  },
);

pressing(
  'a sandbox with no allow-forms asks a form nothing, and a press on its button tells no submit',
  async () => {
    const s = await scene(
      `<iframe sandbox="allow-scripts" style="border:0;display:block;width:300px;height:100px" srcdoc='<body style="margin:0"><form action="${APP}posted"><button style="display:block;width:280px;height:80px;margin:0;border:0">go</button></form><script>
      const form = document.querySelector("form");
      form.addEventListener("submit", () => console.log("heard submit"));
      form.requestSubmit();
      console.log("asked");
    <\/script>'></iframe>`,
      { [`${APP}posted`]: 'posted' },
    );
    await until(s, 'asked');
    await s.click(40, 30);
    await settle(300);
    assert.ok(
      !s.logs.some((l) => l.includes('heard submit')),
      s.logs.join('\n'),
    );
    assert.ok(!s.asked.some((r) => r.url.includes('posted')));
  },
);

test('with no window seam, a sandbox opens no tab either, whatever it tells itself', async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${FRAME}"></iframe>`,
    {
      [FRAME]: script(`
        const real = String;
        window.open('${APP}plain');
        window.String = (v) => (v === 'sandboxed' ? 'none' : real(v));
        window.open('${APP}forged');
        window.String = real;
        console.log('done');
      `),
    },
    { popups: undefined },
  );
  await until(s, 'done');
  await settle();
  assert.deepEqual(s.tabs, []);
});

test('a top-level document whose response sandboxes it is told so by its headers', async () => {
  const s = await scene(
    `<form action="${APP}posted"></form>${script(`
      console.log('top origin', self.origin);
      try { console.log('top storage', localStorage.length); } catch (e) { console.log('top storage', e.name); }
      document.querySelector('form').submit();
      console.log('submitted');
    `)}`,
    {},
    { headers: [['content-security-policy', 'sandbox allow-scripts']] },
  );
  assert.equal(await until(s, 'top origin'), 'null');
  assert.equal(await until(s, 'top storage'), 'SecurityError');
  await until(s, 'submitted');
  await settle();
  assert.deepEqual(s.submitted, []);
});

test('a top-level document with no allow-scripts in its policy runs nothing', async () => {
  const s = await scene(
    `${script(`console.log('ran at top');`)}<p>x</p>`,
    {},
    { headers: [['content-security-policy', 'sandbox']] },
  );
  await settle();
  assert.deepEqual(s.logs, []);
});

test('every sandbox would be one table of locks, so a sandbox has none', async () => {
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${APP}a"></iframe>
     <iframe sandbox="allow-scripts" src="${APP}b"></iframe>`,
    {
      [`${APP}a`]: script(`
        navigator.locks.request('a-secret-name', () => new Promise(() => {})).catch(
          (e) => console.log('a request', e.name),
        );
      `),
      [`${APP}b`]: script(`
        setTimeout(() => {
          navigator.locks.query().then(
            (held) => console.log('b query', JSON.stringify(held)),
            (e) => console.log('b query', e.name),
          );
        }, 50);
      `),
    },
  );
  assert.equal(await until(s, 'a request'), 'SecurityError');
  assert.equal(await until(s, 'b query'), 'SecurityError');
  assert.ok(!s.logs.join('\n').includes('a-secret-name'), s.logs.join('\n'));
});

test('a sandbox asks nobody for anything: no permission is by no origin', async () => {
  const asked: string[] = [];
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${FRAME}"></iframe>`,
    {
      [FRAME]: script(`
        Notification.requestPermission().then((p) => console.log('asked', p));
        navigator.permissions.query({ name: 'notifications' }).then((p) => console.log('state', p.state));
        navigator.mediaDevices.getUserMedia({ video: true }).catch((e) => console.log('camera', e.name));
        navigator.mediaDevices.enumerateDevices().then((d) => console.log('devices', JSON.stringify(d.map((x) => x.deviceId + x.label))));
      `),
    },
    {
      permissions: {
        state: () => 'granted',
        request: async (name, origin) => {
          asked.push(`${name} ${origin}`);
          return 'granted';
        },
      },
      mediaDevices: {
        devices: async () => [
          {
            kind: 'videoinput',
            deviceId: 'real-id',
            groupId: 'real-group',
            label: 'A camera',
          },
        ],
        permission: () => 'granted',
        request: async () => {
          asked.push('camera');
          return true;
        },
      } as unknown as HtmlScripts['mediaDevices'],
    },
  );
  assert.equal(await until(s, 'asked'), 'denied');
  assert.equal(await until(s, 'state'), 'denied');
  assert.equal(await until(s, 'camera'), 'NotAllowedError');
  // nor is it told of a camera: one is `'self'`'s by default (Permissions
  // Policy), which an origin of none is no frame's
  assert.equal(await until(s, 'devices'), '[]');
  assert.deepEqual(asked, []);
});

/** A document's host at an address, with what it asks of a page's seams. */
function hostOf(url: string, seams: Partial<HostSeams> = {}): DomHost {
  return new DomHost(
    new Document([]),
    {
      handle: {},
      log() {},
      fetch: async () => {
        throw new Error('no network');
      },
      ...seams,
    } as unknown as HostSeams,
    url,
  );
}

const SANDBOXED = (url: string, seams: Partial<HostSeams> = {}): DomHost => {
  const host = hostOf(url, seams);
  host.shared.sandboxes.set(host.document, SB_ORIGIN);
  return host;
};

const refusal = (answer: unknown): boolean =>
  typeof answer === 'string' && answer.includes('SecurityError');

test('the host refuses a sandbox what is by origin, whatever the facade asks', () => {
  const box = SANDBOXED(FRAME);
  assert.equal(box.originless, true);
  assert.ok(refusal(box.bridge('storage', 'local', 'get', 'x')));
  assert.ok(refusal(box.bridge('storage', 'session', 'get', 'x')));
  assert.equal(box.bridge('storage', 'local', 'allowed'), false);
  assert.ok(refusal(box.bridge('lockRequest', 1, 'name', true, '')));
  assert.ok(refusal(box.bridge('lockQuery')));
  assert.equal(box.bridge('lockRelease', 1), null);
  assert.equal(box.bridge('permission', 'notifications'), 'denied');
});

test('a document at a data: address has nothing of its own, and a file: page keeps its store', () => {
  const data = hostOf('data:text/html,x');
  assert.equal(data.originless, true);
  assert.ok(refusal(data.bridge('storage', 'local', 'get', 'x')));
  const file = hostOf('file:///site/page.html');
  assert.equal(file.origin, 'null');
  assert.equal(file.originless, false);
  assert.equal(file.bridge('storage', 'local', 'allowed'), true);
  assert.equal(file.bridge('storage', 'local', 'set', 'kept', '1'), null);
  assert.equal(file.bridge('storage', 'local', 'get', 'kept'), '1');
  assert.equal(file.bridge('lockQuery') !== undefined, true);
  assert.ok(!refusal(file.bridge('lockQuery')));
});

test('a sandbox at a file: address has no store either', () => {
  const box = SANDBOXED('file:///site/frame.html');
  assert.equal(box.originless, true);
  assert.ok(refusal(box.bridge('storage', 'local', 'get', 'x')));
});

test('a sandbox asks nobody for the clipboard either, whatever the page hands the host', async () => {
  const asked: string[] = [];
  const box = SANDBOXED(FRAME, {
    secureContext: true,
    clipboard: { read: async () => ({ text: 'x' }), write: async () => {} },
    permissions: {
      state: () => 'granted',
      request: async (name: string, origin: string) => {
        asked.push(`${name} ${origin}`);
        return 'granted';
      },
    },
  } as unknown as Partial<HostSeams>);
  box.bridge('clipboard', 'request', 1, 'clipboard-read');
  await act(() => new Promise((r) => setTimeout(r, 20)));
  assert.deepEqual(asked, []);
});

test("a feature of the top document is no opaque frame's for sharing its `null`", () => {
  const frameOf = (allow: string | null): DomHost => {
    const host = new DomHost(
      new Document([]),
      { handle: {}, log() {} } as unknown as HostSeams,
      'data:text/html,frame',
      undefined,
      'data:text/html,top',
    );
    const frame = new Element('iframe', allow ? { allow } : {});
    host.shared.frameOf.set(host.document, frame);
    return host;
  };
  assert.equal(frameOf(null).bridge('featureAllowed', 'camera'), false);
  assert.equal(frameOf('camera').bridge('featureAllowed', 'camera'), true);
});

test('a sandbox on a secure page is held to mixed content by its address, which its origin no longer says', async () => {
  let connected = 0;
  const s = await scene(
    `<iframe sandbox="allow-scripts" src="${FRAME}"></iframe>`,
    {
      [FRAME]: script(`
        const socket = new WebSocket('ws://other.test/');
        socket.onerror = () => console.log('socket failed');
      `),
    },
    {
      webSocket: {
        connect() {
          connected += 1;
          return { send() {}, close() {}, bufferedAmount: () => 0 };
        },
      },
    } as Partial<HtmlScripts>,
  );
  await until(s, 'socket failed');
  assert.equal(connected, 0);
});

nodeTest(
  'a request of no origin is same-site with nothing, so what a cookie holds back it holds back',
  async (t) => {
    const heard: (string | undefined)[] = [];
    const site = createServer((req, res) => {
      heard.push(req.headers.cookie);
      res.end('x');
    });
    await new Promise<void>((go) => site.listen(0, '127.0.0.1', go));
    t.after(() => site.close());
    const { port } = site.address() as AddressInfo;
    const page = `http://127.0.0.1:${port}/`;
    const jar = new CookieJar();
    jar.store(page, ['strict=1; SameSite=Strict; Path=/'], {
      http: true,
      sameSite: true,
    });
    const fetch = new HtmlNetwork({ cookies: jar }).fetcher(page);
    const ask = (opaqueOrigin: boolean) =>
      fetch(
        {
          url: page,
          method: 'GET',
          headers: [],
          body: null,
          credentials: 'include',
          ...(opaqueOrigin ? { opaqueOrigin } : {}),
        },
        new AbortController().signal,
      );
    await ask(false);
    await ask(true);
    assert.deepEqual(heard, ['strict=1', undefined]);
  },
);

test('a file: page reads the localStorage it had, where a sandbox of one reads none', async () => {
  const s = await scene(
    script(`
      try {
        localStorage.setItem('k', 'v');
        console.log('file store', localStorage.getItem('k'));
      } catch (e) {
        console.log('file store', e.name);
      }
    `),
    {},
    {},
    'file:///site/page.html',
  );
  assert.equal(await until(s, 'file store'), 'v');
});

test('what the realm gates, the host asks again: a page that talks it round reads no clipboard and shows no notification', async () => {
  let read = 0;
  let wrote = 0;
  const shown: string[] = [];
  const seams = (state: 'granted' | 'denied' | 'prompt') => ({
    secureContext: true,
    clipboard: {
      read: async () => {
        read += 1;
        return { text: 'password' };
      },
      write: async () => {
        wrote += 1;
      },
    },
    notifications: {
      show: async (n: { title: string }) => {
        shown.push(n.title);
        return { close() {} };
      },
    },
    permissions: {
      state: () => state,
      request: async () => state,
    },
  });
  const settled = () => act(() => new Promise((r) => setTimeout(r, 20)));
  const write = JSON.stringify([]);
  const note = JSON.stringify({ title: 'hello' });

  // told no, wherever the page's own gate left it
  const closed = hostOf(FRAME, seams('denied') as Partial<HostSeams>);
  closed.bridge('clipboard', 'read', 1, '');
  closed.bridge('clipboard', 'write', 2, write);
  closed.bridge('notification', 'show', 3, note);
  await settled();
  assert.equal(read, 0);
  assert.equal(wrote, 0);
  assert.deepEqual(shown, []);

  // a sandbox, whatever its host would say of `null`
  const box = SANDBOXED(FRAME, seams('granted') as Partial<HostSeams>);
  box.bridge('clipboard', 'read', 1, '');
  box.bridge('clipboard', 'write', 2, write);
  box.bridge('notification', 'show', 3, note);
  await settled();
  assert.equal(read, 0);
  assert.equal(wrote, 0);
  assert.deepEqual(shown, []);

  // and what a host says yes to goes through
  const open = hostOf(FRAME, seams('granted') as Partial<HostSeams>);
  open.bridge('clipboard', 'read', 1, '');
  open.bridge('clipboard', 'write', 2, write);
  open.bridge('notification', 'show', 3, note);
  await settled();
  assert.equal(read, 1);
  assert.equal(wrote, 1);
  assert.deepEqual(shown, ['hello']);
});

test('a clipboard write with no grant takes a press the host saw, whatever the realm says it saw', async () => {
  let wrote = 0;
  const host = hostOf(FRAME, {
    secureContext: true,
    clipboard: {
      read: async () => ({ text: '' }),
      write: async () => {
        wrote += 1;
      },
    },
  } as unknown as Partial<HostSeams>);
  const settled = () => act(() => new Promise((r) => setTimeout(r, 20)));
  const write = JSON.stringify([{ t: 'text/plain', s: 'pasted over' }]);
  // the realm's gate passed it, as a page that set its own clock can have it
  host.bridge('clipboard', 'write', 1, write);
  await settled();
  assert.equal(wrote, 0);
  const body = new Element('body', {});
  host.document.children.push(body);
  body.parent = host.document;
  host.dispatch({ type: 'mousedown', target: body } as never);
  host.bridge('clipboard', 'write', 2, write);
  await settled();
  assert.equal(wrote, 1);
  // a key is one, and Escape is none
  const later = hostOf(FRAME, {
    secureContext: true,
    clipboard: {
      read: async () => ({ text: '' }),
      write: async () => {
        wrote += 1;
      },
    },
  } as unknown as Partial<HostSeams>);
  later.document.children.push(body);
  later.dispatch({ type: 'keydown', key: 'Escape', target: body } as never);
  later.bridge('clipboard', 'write', 3, write);
  await settled();
  assert.equal(wrote, 1);
  later.dispatch({ type: 'keydown', key: 'c', target: body } as never);
  later.bridge('clipboard', 'write', 4, write);
  await settled();
  assert.equal(wrote, 2);
});

test('a read a user just said yes to goes through, where the host answers no state of it', async () => {
  let read = 0;
  let answer: HtmlPermissionState = 'prompt';
  const host = hostOf(FRAME, {
    secureContext: true,
    clipboard: {
      read: async () => {
        read += 1;
        return { text: 'x' };
      },
      write: async () => {},
    },
    permissions: {
      state: () => 'prompt',
      request: async () => answer,
    },
  } as unknown as Partial<HostSeams>);
  const settled = () => act(() => new Promise((r) => setTimeout(r, 20)));
  host.bridge('clipboard', 'read', 1, '');
  await settled();
  assert.equal(read, 0);
  answer = 'granted';
  host.bridge('clipboard', 'request', 2, 'clipboard-read');
  await settled();
  host.bridge('clipboard', 'read', 3, '');
  await settled();
  assert.equal(read, 1);
});

// --- framing --------------------------------------------------------------

const refused = (
  headers: [string, string][],
  url: string,
  ancestors: string[],
  origin = new URL(url).origin,
) => framingRefused(headers, url, origin, ancestors);

test('X-Frame-Options reads as HTML has it', () => {
  const xfo = (v: string): [string, string][] => [['x-frame-options', v]];
  const site = 'https://site.test/x';
  const own = ['https://site.test'];
  const other = ['https://other.test'];
  assert.equal(refused([], site, other), null);
  assert.equal(refused(xfo('DENY'), site, own), 'x-frame-options');
  assert.equal(refused(xfo('  deny '), site, other), 'x-frame-options');
  assert.equal(refused(xfo('SAMEORIGIN'), site, own), null);
  assert.equal(refused(xfo('sameorigin'), site, other), 'x-frame-options');
  assert.equal(refused(xfo('ALLOWALL'), site, other), null);
  assert.equal(refused(xfo('nonsense'), site, other), null);
  assert.equal(refused(xfo('deny, sameorigin'), site, own), 'x-frame-options');
  assert.equal(refused(xfo('sameorigin, sameorigin'), site, own), null);
  assert.equal(
    refused(xfo('allowall, nonsense'), site, own),
    'x-frame-options',
  );
  assert.equal(refused(xfo('nonsense, other'), site, own), null);
  assert.equal(refused(xfo('"deny, x"'), site, own), null);
  // a vertical tab is no whitespace of HTTP's, whatever `trim` thinks
  assert.equal(refused(xfo('\x0BDENY'), site, own), null);
  // every document around it, and the top of them most of all
  assert.equal(
    refused(xfo('sameorigin'), site, [
      'https://site.test',
      'https://evil.test',
    ]),
    'x-frame-options',
  );
  assert.equal(
    refused(xfo('sameorigin'), site, own, 'null'),
    'x-frame-options',
  );
});

test('frame-ancestors asks of every document around the frame, and X-Frame-Options steps aside for it', () => {
  const csp = (v: string): [string, string][] => [
    ['content-security-policy', v],
  ];
  const site = 'https://site.test/x';
  const own = ['https://site.test'];
  const other = ['https://other.test'];
  assert.equal(
    refused(csp("frame-ancestors 'none'"), site, own),
    'frame-ancestors',
  );
  assert.equal(refused(csp("frame-ancestors 'self'"), site, own), null);
  assert.equal(
    refused(csp("frame-ancestors 'self'"), site, other),
    'frame-ancestors',
  );
  assert.equal(
    refused(csp('frame-ancestors https://other.test'), site, other),
    null,
  );
  assert.equal(
    refused(csp('frame-ancestors *.other.test'), site, [
      'https://a.other.test',
    ]),
    null,
  );
  assert.equal(refused(csp('frame-ancestors *'), site, other), null);
  assert.equal(refused(csp('frame-ancestors https:'), site, other), null);
  assert.equal(
    refused(csp("frame-ancestors 'self'"), site, [
      'https://site.test',
      'https://evil.test',
    ]),
    'frame-ancestors',
  );
  assert.equal(
    refused(csp('frame-ancestors *'), site, ['null']),
    'frame-ancestors',
  );
  // each policy has its say
  assert.equal(
    refused(csp("frame-ancestors *, frame-ancestors 'none'"), site, other),
    'frame-ancestors',
  );
  assert.equal(
    refused(
      [
        ['x-frame-options', 'DENY'],
        ['content-security-policy', "frame-ancestors 'self'"],
      ],
      site,
      own,
    ),
    null,
  );
  // no frame-ancestors, no say
  assert.equal(
    refused(
      [
        ['x-frame-options', 'DENY'],
        ['content-security-policy', "default-src 'self'"],
      ],
      site,
      own,
    ),
    'x-frame-options',
  );
  assert.equal(
    refused(
      [['content-security-policy-report-only', "frame-ancestors 'none'"]],
      site,
      other,
    ),
    null,
  );
  assert.equal(
    refused(csp("frame-ancestors 'none'"), 'data:text/html,x', other, 'null'),
    null,
  );
});

const DENY: Answer = {
  body: `<title>signed-in-title</title>${script(`
    console.log('framed ran');
  `)}<img src="${OTHER}tracked.png">`,
  headers: [['x-frame-options', 'DENY']],
};

test('a document that refuses its frame is not loaded there, and the frame shows that it refused', async () => {
  const s = await scene(
    `<iframe id=f src="${OTHER}deny"></iframe>${script(`
      const f = document.getElementById('f');
      f.onload = () => {
        let doc = 'none';
        try { doc = f.contentWindow.document; } catch (e) { doc = e.name; }
        console.log('loaded', f.contentDocument === null, doc);
      };
    `)}`,
    { [`${OTHER}deny`]: DENY },
  );
  assert.equal(await until(s, 'loaded'), 'true SecurityError');
  await settle();
  const all = s.logs.join('\n');
  assert.ok(!all.includes('framed ran'), all);
  assert.match(all, /Refused to display/);
});

test('a same-origin document refuses as any does, and the page has no document of it', async () => {
  const s = await scene(
    `<iframe id=f src="${APP}deny"></iframe>${script(`
      const f = document.getElementById('f');
      f.onload = () => console.log('loaded', f.contentDocument === null);
    `)}`,
    { [`${APP}deny`]: DENY },
  );
  assert.equal(await until(s, 'loaded'), 'true');
  await settle();
  assert.ok(!s.logs.join('\n').includes('framed ran'), s.logs.join('\n'));
});

test('a page of the site that is framed by another cannot lend the site its origin', async () => {
  const s = await scene(`<iframe src="${OTHER}outer"></iframe>`, {
    [`${OTHER}outer`]: `<iframe id=i src="${OTHER}inner"></iframe>${script(`
        document.getElementById('i').onload = () => console.log('inner load');
      `)}`,
    [`${OTHER}inner`]: {
      body: script(`console.log('inner ran');`),
      headers: [['x-frame-options', 'SAMEORIGIN']],
    },
  });
  await until(s, 'inner load');
  await settle();
  assert.ok(!s.logs.join('\n').includes('inner ran'), s.logs.join('\n'));
});

test("a frame of the page's own origin that allows itself loads as it did", async () => {
  const s = await scene(
    `<iframe id=f src="${FRAME}"></iframe>${script(`
      window.mine = 'kept';
      const f = document.getElementById('f');
      f.onload = () => console.log('title', f.contentDocument.title);
    `)}`,
    {
      [FRAME]: {
        body: `<title>own</title>${script(`console.log('heard', parent.mine);`)}`,
        headers: [
          ['x-frame-options', 'SAMEORIGIN'],
          ['content-security-policy', "frame-ancestors 'self'"],
        ],
      },
    },
  );
  assert.equal(await until(s, 'heard'), 'kept');
  assert.equal(await until(s, 'title'), 'own');
});

test('a data: frame of another page is of no origin, and runs', async () => {
  const s = await scene(
    `<iframe src="data:text/html,<script>console.log('data origin', self.origin)<\/script>"></iframe>`,
  );
  assert.equal(await until(s, 'data origin'), 'null');
});
