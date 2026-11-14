// `<Html scripts>`'s windows: `window.open`, `opener`, `close()`, `closed` and
// what a name finds, over the `popups` seam (`src/html/popups.ts`,
// `src/html/scripts/popups.ts`, `src/html/scripts/windows.ts`). The host here
// is the smallest that shows a window: an `<Html>` for what it opened with, and
// one for each document it goes to, in a box of this tree.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test as nodeTest } from 'node:test';
import { Document, Element } from 'domhandler';
import { appendChild } from 'domutils';
import React, { useEffect, useRef, useState } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  renderX11,
  waitForPixel,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import {
  Html,
  HtmlNetwork,
  HtmlServiceWorkers,
  HtmlSessionHistory,
  memoryNotifications,
  parseWindowFeatures,
  preloadHtmlScripts,
  useHtmlHandle,
} from '../../src/html/index.js';
import type {
  HtmlDocumentHop,
  HtmlPopup,
  HtmlPopups,
  HtmlScripts,
} from '../../src/html/index.js';
import {
  itemToken,
  leavesGroup,
  openerPolicyOf,
  requiresGroupSwitch,
} from '../../src/html/scripts/coop.js';
import type { OpenerPolicy, PolicyOf } from '../../src/html/scripts/coop.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { DomHost, DomShared } from '../../src/html/scripts/host.js';
import type {
  FetchRequest,
  FetchResponse,
  FramePost,
  HostSeams,
} from '../../src/html/scripts/host.js';
import {
  WindowGroup,
  WindowSlot,
  windowOps,
} from '../../src/html/scripts/popups.js';
import type { ScriptRunner } from '../../src/html/scripts/runner.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const APP = 'https://app.test/';
const PROVIDER = 'https://provider.test/';

type Headers = [string, string][];

/** What the fake network answers: a body, or where it redirects to, and what
 *  either says of itself. */
type Answer =
  | string
  | { redirect: string; headers?: Headers }
  | { body: string; headers: Headers };

/** A response with this `Cross-Origin-Opener-Policy`. */
const coop = (value: string): Headers => [
  ['cross-origin-opener-policy', value],
];

interface Scene {
  logs: string[];
  ctx: Awaited<ReturnType<typeof renderX11>>['ctx'];
  /** What the host was handed, in order. */
  popups: HtmlPopup[];
  /** The URLs asked for, in order, with their method. */
  requests: string[];
  /** The windows that are showing, by the address each shows. */
  shown(): string[];
  /** Wait until a log line starts with `prefix`, and answer the rest. */
  until(prefix: string): Promise<string>;
  /** Wait until a test holds. */
  when(test: () => boolean, what: string): Promise<void>;
  /** The press the page's window hears. */
  press(): Promise<void>;
  /** The tabs asked for with no opener. */
  tabs: string[];
}

function respond(url: string, body: string, status = 200): FetchResponse {
  return {
    url,
    status,
    statusText: 'OK',
    redirected: false,
    headers: [
      ['content-type', 'text/html'],
      ['access-control-allow-origin', '*'],
    ],
    body,
    type: 'basic',
  };
}

async function scene(
  source: string,
  pages: Record<string, Answer>,
  options: {
    popups?: Partial<HtmlPopups> | null;
    refuse?: boolean;
    close?: (alone: boolean) => boolean | void;
    frames?: boolean;
    /** What the first document's response said of itself. */
    headers?: Headers;
  } = {},
): Promise<Scene> {
  const logs: string[] = [];
  const popups: HtmlPopup[] = [];
  const requests: string[] = [];
  const tabs: string[] = [];
  const showing = new Map<number, string>();
  let serial = 0;
  let pressAt: (() => Promise<void>) | null = null;

  const fetch = async (
    request: FetchRequest,
  ): Promise<FetchResponse & { redirects?: HtmlDocumentHop[] }> => {
    let url = request.url.split('#')[0];
    requests.push(`${request.method} ${url}`);
    const redirects: HtmlDocumentHop[] = [];
    for (let hops = 0; hops < 5; hops += 1) {
      const answer = pages[url];
      if (answer === undefined) return respond(url, 'missing', 404);
      if (typeof answer === 'string') {
        return {
          ...respond(url, answer),
          url,
          redirected: hops > 0,
          redirects,
        };
      }
      if ('body' in answer) {
        const ok = respond(url, answer.body);
        return {
          ...ok,
          url,
          redirected: hops > 0,
          headers: [...ok.headers, ...answer.headers],
          redirects,
        };
      }
      redirects.push({ url, headers: answer.headers ?? [] });
      url = new URL(answer.redirect, url).href;
    }
    throw new Error('too many redirects');
  };

  /** A window: an `<Html>` for each document it goes to. */
  function Win(props: { popup?: HtmlPopup; first?: string }) {
    const { popup } = props;
    const handle = useHtmlHandle();
    const [session] = useState(() => new HtmlSessionHistory());
    const [doc, setDoc] = useState<{
      n: number;
      url: string;
      body: string;
      headers?: Headers;
      redirects?: HtmlDocumentHop[];
    }>({
      n: 0,
      url: props.first ? APP : 'about:blank',
      body: props.first ?? '',
      headers: props.first ? options.headers : undefined,
    });
    const id = useRef(++serial).current;
    useEffect(() => {
      showing.set(id, doc.url);
      return () => void showing.delete(id);
    }, [doc.url]);
    const load = (to: string, post: FramePost | null = null): void => {
      if (post) session.push();
      void fetch({
        url: to,
        method: post ? 'POST' : 'GET',
        headers: [],
        body: null,
      } as FetchRequest).then((response) => {
        setDoc((was) => ({
          n: was.n + 1,
          url: response.url,
          body: response.body as string,
          headers: response.headers,
          redirects: response.redirects,
        }));
      });
    };
    useEffect(() => {
      if (popup && popup.url !== 'about:blank') load(popup.url, popup.post);
    }, []);
    const seam: HtmlPopups | undefined =
      options.popups === null
        ? undefined
        : {
            open(opened) {
              if (options.refuse) return false;
              popups.push(opened);
              setOpened((all) => [...all, opened]);
              return true;
            },
            ...options.popups,
          };
    const scripts: HtmlScripts = {
      log: (level, text) => void logs.push(`${level}: ${text}`),
      fetch: (request) => fetch(request),
      headers: doc.headers,
      redirects: doc.redirects,
      session,
      ...(popup && { popup }),
      popups: seam,
      close: options.close,
      ...(options.frames === false && { frames: false }),
      navigate: (to, how, post) => {
        if (how === 'tab') {
          tabs.push(to);
          return;
        }
        load(to, post ?? null);
      },
    };
    return h(Html, {
      key: doc.n,
      ref: (node: unknown) => {
        if (node && !popup) {
          pressAt = async () => {
            await act(async () => {
              fireEvent.mouseDown(node as DrawnNode);
              fireEvent.mouseUp(node as DrawnNode);
            });
          };
        }
        (handle.ref as React.MutableRefObject<unknown>).current = node;
      },
      source: doc.body,
      partial: false,
      baseUrl: doc.url,
      scripts,
      style: { flexGrow: 1 },
    });
  }

  let setOpened: React.Dispatch<React.SetStateAction<HtmlPopup[]>> = () => {};
  function Host() {
    const [opened, set] = useState<HtmlPopup[]>([]);
    setOpened = set;
    useEffect(() => {
      const stops = opened.map((popup) =>
        popup.onClose(() =>
          set((all) => all.filter((other) => other !== popup)),
        ),
      );
      return () => stops.forEach((stop) => stop());
    }, [opened]);
    return h(
      'box',
      { style: { flexDirection: 'column', flexGrow: 1 } },
      h(
        'box',
        { style: { flexDirection: 'column', height: 200 } },
        h(Win, { first: source }),
      ),
      ...opened.map((popup, i) =>
        h(
          'box',
          {
            key: popup.id,
            style: {
              position: 'absolute',
              top: 200,
              left: i * 210,
              width: 200,
              height: 150,
              flexDirection: 'column',
            },
          },
          h(Win, { popup }),
        ),
      ),
    );
  }

  const rendered = await renderX11(
    h(Host),
    FONTS
      ? { width: 640, height: 400, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  const when = async (test: () => boolean, what: string): Promise<void> => {
    const end = Date.now() + 5000;
    while (!test() && Date.now() < end) {
      await act(() => new Promise((r) => setTimeout(r, 10)));
    }
    assert.ok(test(), `${what}, in:\n${logs.join('\n')}`);
  };
  return {
    logs,
    popups,
    requests,
    tabs,
    ctx: rendered.ctx,
    shown: () => [...showing.values()],
    when,
    async until(prefix) {
      let line: string | undefined;
      await when(() => {
        line = logs.find((l) => l.startsWith(`log: ${prefix}`));
        return !!line;
      }, `no "${prefix}"`);
      return line!.slice(`log: ${prefix}`.length).trim();
    },
    press: () => pressAt!(),
  };
}

/** A document that runs `code` once it has loaded, on a press where `press`
 *  says so, which is what lets a page open a window. */
const page = (code: string): string =>
  `<!doctype html><html><head></head><body style="margin:0"><div style="height:100px">page</div><script>${code}</script></body></html>`;

const pressed = (code: string): string =>
  page(`addEventListener('mousedown', () => { ${code} });`);

test('a press opens a window, and it is the same object through every document it shows', async () => {
  const s = await scene(
    pressed(`
      const w = window.open('${APP}one');
      console.log('type', typeof w, w.closed, w.opener === window);
      console.log('blank', w.location.href, w.document.readyState);
      addEventListener('message', (e) => {
        console.log('heard', e.data, e.origin, e.source === w);
      });
    `),
    {
      [`${APP}one`]: page(
        `opener.postMessage('from ' + location.pathname, '*');`,
      ),
    },
  );
  await s.press();
  assert.equal(await s.until('type'), 'object false true');
  assert.equal(await s.until('blank'), 'about:blank complete');
  assert.equal(await s.until('heard'), `from /one ${APP.slice(0, -1)} true`);
  assert.equal(s.popups.length, 1);
  assert.equal(s.popups[0].url, `${APP}one`);
});

test('a window opened at about:blank with a fragment is at it at once, and its initial about:blank tells no entry changes', async () => {
  // HTML's window open steps: an `about:blank` address is no navigation,
  // its query or fragment the document's at once, and an initial
  // `about:blank` has its entries and events disabled (WPT's
  // currententrychange-event/navigate-from-initial-about-blank-same-doc-popup)
  const s = await scene(
    pressed(`
      const w = window.open('about:blank#1');
      w.navigation.oncurrententrychange = () => console.log('changed');
      console.log('at', w.location.href);
      w.location.href = 'about:blank#2';
      console.log('then', w.location.href);
      setTimeout(() => console.log('done'), 40);
    `),
    {},
  );
  await s.press();
  assert.equal(await s.until('at'), 'about:blank#1');
  assert.equal(await s.until('then'), 'about:blank#2');
  await s.until('done');
  assert.ok(!s.logs.some((l) => l.includes('changed')), s.logs.join('\n'));
});

test('a popup login comes home: another origin, a redirect, and the callback posts to its opener and closes', async () => {
  const s = await scene(
    pressed(`
      const w = window.open('${PROVIDER}login', 'login', 'popup,width=400,height=300');
      addEventListener('message', (e) => {
        console.log('code', e.data.code, e.origin, e.source === w);
        setTimeout(() => console.log('closed', w.closed), 40);
      });
      console.log('crossed', w.closed);
    `),
    {
      [`${PROVIDER}login`]: page(
        `console.log('provider', typeof opener, opener !== null);
         location.href = '${PROVIDER}authorize';`,
      ),
      [`${PROVIDER}authorize`]: { redirect: `${APP}callback?code=abc` },
      [`${APP}callback?code=abc`]: page(
        `const code = new URLSearchParams(location.search).get('code');
         window.opener.postMessage({ code }, window.origin);
         window.close();`,
      ),
    },
  );
  await s.press();
  assert.equal(await s.until('crossed'), 'false');
  assert.equal(await s.until('provider'), 'object true');
  assert.equal(await s.until('code'), `abc ${APP.slice(0, -1)} true`);
  assert.equal(await s.until('closed'), 'true');
  await s.when(() => s.shown().length === 1, 'the popup still showed');
  assert.deepEqual(s.requests, [
    `GET ${PROVIDER}login`,
    `GET ${PROVIDER}authorize`,
  ]);
  assert.deepEqual(s.popups[0].features, {
    noopener: false,
    noreferrer: false,
    popup: true,
    width: 400,
    height: 300,
  });
});

test('the opener polls: another origin refuses it, and the callback answers it once it is home', async () => {
  const s = await scene(
    pressed(`
      const w = window.open('${PROVIDER}login');
      const timer = setInterval(() => {
        try {
          const at = w.location.href;
          if (at === 'about:blank') return;
          clearInterval(timer);
          console.log('home', at, w.document.title);
          w.close();
          console.log('closed', w.closed);
        } catch (e) {
          if (!self.refused) {
            self.refused = true;
            console.log('refused', e.name);
            w.location.href = '${APP}callback';
          }
        }
      }, 5);
    `),
    {
      [`${PROVIDER}login`]: page(``),
      [`${APP}callback`]: `<!doctype html><title>done</title><body>done`,
    },
  );
  await s.press();
  assert.equal(await s.until('refused'), 'SecurityError');
  assert.equal(await s.until('home'), `${APP}callback done`);
  assert.equal(await s.until('closed'), 'true');
});

test('a window opened at a javascript: URL runs it in its about:blank, where the opener’s policy lets it, and a violation is the opener’s', async () => {
  const run = "javascript:opener.postMessage('ran', '*')";
  const hash = createHash('sha256').update(run).digest('base64');
  const policed = (policy: string): string =>
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"></head>` +
    `<body style="margin:0"><div style="height:100px">page</div><script nonce="n">` +
    `addEventListener('message', (e) => console.log('heard', e.data));` +
    `document.addEventListener('securitypolicyviolation', (e) => console.log('refused', e.blockedURI, e.violatedDirective));` +
    `addEventListener('mousedown', () => { window.open(${JSON.stringify(run)}); });` +
    `</script></body></html>`;
  const allowed = await scene(
    policed(`script-src 'nonce-n' 'unsafe-hashes' 'sha256-${hash}'`),
    {},
  );
  await allowed.press();
  assert.equal(await allowed.until('heard'), 'ran');
  // the host is handed the window at the address it shows, which no host
  // could load a javascript: URL at
  assert.equal(allowed.popups[0].url, 'about:blank');
  const refused = await scene(policed(`script-src 'nonce-n'`), {});
  await refused.press();
  assert.equal(await refused.until('refused'), 'inline script-src-elem');
  assert.equal(refused.popups.length, 1, 'the window opens all the same');
  assert.ok(!refused.logs.some((l) => l.includes('heard')));
});

test('window.open answers at once with a document a page may write', async () => {
  const s = await scene(
    pressed(`
      const w = window.open('', 'report', 'width=300,height=200');
      w.document.write('<!doctype html><title>made</title><body><p id=p>written</p>');
      w.document.close();
      console.log('title', w.document.title);
      console.log('p', w.document.getElementById('p').textContent);
      const made = document.createElement('b');
      made.textContent = 'moved';
      w.document.body.appendChild(made);
      console.log('held', w.document.body.lastChild.textContent, w.document.body.children.length);
      const again = window.open('', 'report');
      console.log('same', again === w);
    `),
    {},
  );
  await s.press();
  assert.equal(await s.until('title'), 'made');
  assert.equal(await s.until('p'), 'written');
  assert.equal(await s.until('held'), 'moved 2');
  assert.equal(await s.until('same'), 'true');
  assert.equal(s.popups.length, 1, 'a name finds the window it named');
});

test('a property a page fixes on a window it opened is one that window keeps, through every document', async () => {
  // the proxy over a popup keeps ECMAScript's invariants (10.5.6): a trap
  // that said true of a fixed property its target did not hold threw
  const s = await scene(
    pressed(`
      const w = window.open('', 'fixed');
      const P = function P() {};
      try {
        Object.defineProperty(w, 'Promise', { value: P, writable: true, enumerable: false, configurable: false });
        console.log('defined', 'yes');
      } catch (e) {
        console.log('defined', e.message);
      }
      const d = Object.getOwnPropertyDescriptor(w, 'Promise');
      console.log('read', [w.Promise === P, d.value === P, d.configurable, 'Promise' in w, delete w.Promise].join(' '));
    `),
    {},
  );
  await s.press();
  assert.equal(await s.until('defined'), 'yes');
  assert.equal(await s.until('read'), 'true true false true false');
});

test('what a page puts on a window before its document comes stays on it', async () => {
  const s = await scene(
    pressed(`
      const w = window.open('${APP}one');
      w.handed = 'kept';
      w.addEventListener('load', () => console.log('loaded', w.location.pathname));
    `),
    { [`${APP}one`]: page(`console.log('read', self.handed);`) },
  );
  await s.press();
  assert.equal(await s.until('read'), 'kept');
  assert.equal(await s.until('loaded'), '/one');
});

test('with no host window.open answers null and hands the address on as a tab', async () => {
  const s = await scene(
    pressed(`console.log('got', window.open('${APP}one'));`),
    {},
    { popups: null },
  );
  await s.press();
  assert.equal(await s.until('got'), 'null');
  assert.deepEqual(s.tabs, [`${APP}one`]);
  assert.equal(s.popups.length, 0);
});

test('a host that says no leaves window.open null', async () => {
  const s = await scene(
    pressed(`console.log('got', window.open('${APP}one'));`),
    {},
    { refuse: true },
  );
  await s.press();
  assert.equal(await s.until('got'), 'null');
});

test('with no press behind it a window is blocked, and one press opens one', async () => {
  const blocked: string[] = [];
  const s = await scene(
    page(`
      console.log('early', window.open('${APP}one'));
      addEventListener('mousedown', () => {
        const first = window.open('${APP}two');
        const second = window.open('${APP}three');
        console.log('opened', first !== null, second === null);
      });
    `),
    {},
    { popups: { blocked: (url) => void blocked.push(url) } },
  );
  assert.equal(await s.until('early'), 'null');
  assert.deepEqual(blocked, [`${APP}one`]);
  await s.press();
  assert.equal(await s.until('opened'), 'true true');
});

test('noopener and noreferrer open a tab, and hand nothing back', async () => {
  const s = await scene(
    pressed(`
      console.log('a', window.open('${APP}a', '_blank', 'noopener'));
      console.log('b', window.open('${APP}b', '_blank', 'noreferrer'));
      console.log('c', window.open('${APP}c', '', 'noopener=0') !== null);
    `),
    {},
    { popups: { unblocked: true } },
  );
  await s.press();
  assert.equal(await s.until('a'), 'null');
  assert.equal(await s.until('b'), 'null');
  assert.equal(await s.until('c'), 'true');
  assert.deepEqual(s.tabs, [`${APP}a`, `${APP}b`]);
});

test('an invalid address throws, as HTML has it', async () => {
  const s = await scene(
    pressed(`
      try { window.open('https://example.com:port/'); } catch (e) { console.log('threw', e.name); }
    `),
    {},
  );
  await s.press();
  assert.equal(await s.until('threw'), 'SyntaxError');
});

test('opener may be disowned, and replaced by a value of the page', async () => {
  const s = await scene(
    pressed(`
      const w = window.open('${APP}a');
      addEventListener('message', (e) => console.log(e.data));
      self.w = w;
    `),
    {
      [`${APP}a`]: page(`
        const up = opener;
        const get = Object.getOwnPropertyDescriptor(self, 'opener').get;
        console.log('desc', typeof get, get.call(self) === up);
        self.opener = null;
        console.log('gone', self.opener, up.closed);
      `),
    },
  );
  await s.press();
  assert.equal(await s.until('desc'), 'function true');
  assert.equal(await s.until('gone'), 'null false');
});

test('a link names a window, and a form posts into one', async () => {
  const s = await scene(
    page(`
      addEventListener('mousedown', () => {
        const a = document.createElement('a');
        a.href = '${APP}a';
        a.target = 'side';
        document.body.append(a);
        a.click();
      });
    `),
    { [`${APP}a`]: page(`console.log('name', self.name, opener !== null);`) },
    { popups: { unblocked: true } },
  );
  await s.press();
  assert.equal(await s.until('name'), 'side true');
});

test('the host hears focus, and closing it by hand tells the opener', async () => {
  const s = await scene(
    pressed(`
      const w = window.open('', 'x');
      self.w = w;
      w.focus();
      const poll = setInterval(() => {
        if (!w.closed) return;
        clearInterval(poll);
        console.log('closed', w.closed);
      }, 5);
    `),
    {},
  );
  let focused = 0;
  await s.press();
  await s.when(() => s.popups.length === 1, 'nothing opened');
  s.popups[0].onFocus(() => (focused += 1));
  await act(async () => s.popups[0].close());
  assert.equal(await s.until('closed'), 'true');
  assert.equal(s.popups[0].closed, true);
  assert.equal(focused, 0);
});

test("window.close in a tab is the host's, and says whether it stands alone", async () => {
  const closes: boolean[] = [];
  const s = await scene(
    page(`window.close(); console.log('done', window.closed);`),
    {},
    { close: (alone) => void closes.push(alone) },
  );
  assert.equal(await s.until('done'), 'false');
  assert.deepEqual(closes, [true]);
});

test('an opener that navigates keeps its popup, which reaches its next document', async () => {
  const s = await scene(
    pressed(`
      self.w = window.open('${PROVIDER}side', 'side');
      addEventListener('message', (e) => {
        if (e.data === 'ready') location.href = '${APP}next';
      });
    `),
    {
      [`${PROVIDER}side`]: page(`
        opener.postMessage('ready', '*');
        addEventListener('message', (e) => console.log('told', e.data, e.origin));
        const was = opener;
        const ask = setInterval(() => was.postMessage('ask', '*'), 20);
      `),
      [`${APP}next`]: page(`
        addEventListener('message', (e) => {
          if (e.data !== 'ask') return;
          e.source.postMessage('from the next document', '*');
          console.log('source', e.origin);
        });
      `),
    },
  );
  await s.press();
  assert.equal(await s.until('source'), PROVIDER.slice(0, -1));
  assert.equal(
    await s.until('told'),
    `from the next document ${APP.slice(0, -1)}`,
  );
  assert.equal(s.popups.length, 1, 'the popup stayed');
});

test('another origin reaches what crosses origins and nothing else', async () => {
  const s = await scene(
    pressed(`
      const w = window.open('${PROVIDER}side');
      addEventListener('message', () => {
        const refuses = (read) => { try { read(); return 'read'; } catch (e) { return e.name; } };
        console.log('document', refuses(() => w.document));
        console.log('href', refuses(() => w.location.href));
        console.log('set', refuses(() => { w.foo = 1; }));
        console.log('search', refuses(() => w.location.search));
        console.log('ok', w.closed, w.length, w.self === w, w.top === w, w.opener === window);
        w.postMessage('wrong', '${APP}');
        w.postMessage('right', '${PROVIDER.slice(0, -1)}');
        try { w.document; } catch (e) {
          console.log('host', e instanceof DOMException, (() => { try { return e.constructor.constructor('return typeof process')(); } catch (x) { return x.name; } })());
        }
      }, { once: true });
    `),
    {
      [`${PROVIDER}side`]: page(`
        addEventListener('message', (e) => console.log('got', e.data));
        opener.postMessage('up', '*');
      `),
    },
  );
  await s.press();
  assert.equal(await s.until('document'), 'SecurityError');
  assert.equal(await s.until('href'), 'SecurityError');
  assert.equal(await s.until('set'), 'SecurityError');
  assert.equal(await s.until('search'), 'SecurityError');
  assert.equal(await s.until('ok'), 'false 0 true true true');
  assert.equal(await s.until('host'), 'true undefined');
  assert.equal(await s.until('got'), 'right');
  assert.ok(!s.logs.some((l) => l.includes('wrong')));
});

/** The ways a page writes one, each of which `URL` makes the same address. */
const SCRIPT_URLS = [
  'javascript:parent.ran = 1',
  'JaVaScRiPt:parent.ran = 1',
  '  javascript:parent.ran = 1',
  'java\tscript:parent.ran = 1',
  'java\nscript:parent.ran = 1',
];

test('a window of another origin is sent to no javascript: URL: the navigation ends, and the host hears of none', async () => {
  const s = await scene(
    pressed(`
      const w = window.open('${PROVIDER}side', 'side');
      addEventListener('message', () => {
        for (const url of ${JSON.stringify(SCRIPT_URLS)}) {
          w.location = url;
          w.location.href = url;
          w.location.replace(url);
        }
        window.open('javascript:parent.ran = 1', 'side');
        console.log('sent');
        w.postMessage('still there?', '*');
      }, { once: true });
    `),
    {
      [`${PROVIDER}side`]: page(`
        addEventListener('message', (e) => e.source.postMessage('alive', '*'));
        opener.postMessage('up', '*');
      `),
    },
    { popups: { unblocked: true } },
  );
  await s.press();
  await s.until('sent');
  await act(() => new Promise((r) => setTimeout(r, 60)));
  const sent = s.requests.filter((r) => /script:/i.test(r));
  assert.deepEqual(sent, [], 'the host was asked to go there');
  assert.ok(
    s.shown().includes(`${PROVIDER}side`),
    `the popup stayed on its page: ${s.shown()}`,
  );
});

test('a window of another origin is still sent to a place, so what is refused is the script and not the navigation', async () => {
  const s = await scene(
    pressed(`
      const w = window.open('${PROVIDER}side', 'side');
      addEventListener('message', () => {
        w.location = '${PROVIDER}next';
      }, { once: true });
    `),
    {
      [`${PROVIDER}side`]: page(`opener.postMessage('up', '*');`),
      [`${PROVIDER}next`]: page(`console.log('arrived');`),
    },
    { popups: { unblocked: true } },
  );
  await s.press();
  await s.when(() => s.requests.includes(`GET ${PROVIDER}next`), 'not sent');
});

test('a frame of another origin is sent to no javascript: URL, and stays on its page', async () => {
  const s = await scene(
    pressed(`
      const frame = document.querySelector('iframe');
      frame.addEventListener('load', () => console.log('frame loaded again'));
      for (const url of ${JSON.stringify(SCRIPT_URLS)}) {
        frame.contentWindow.location = url;
      }
      // past the task such a navigation would unload the frame in
      setTimeout(() => {
        console.log('sent');
        frame.contentWindow.postMessage('still there?', '*');
      }, 30);
    `).replace(
      '<div style="height:100px">page</div>',
      `<div style="height:20px">page</div><iframe src="${PROVIDER}frame" style="width:100px;height:40px"></iframe>`,
    ),
    {
      [`${PROVIDER}frame`]: page(`
        addEventListener('message', (e) => console.log('frame heard', e.data));
        addEventListener('pagehide', () => console.log('frame left'));
      `),
    },
    { popups: { unblocked: true } },
  );
  await s.when(() => s.requests.includes(`GET ${PROVIDER}frame`), 'no frame');
  await act(() => new Promise((r) => setTimeout(r, 60)));
  await s.press();
  await s.until('sent');
  assert.equal(
    await s.until(`[frame ${PROVIDER}frame] frame heard`),
    'still there?',
  );
  assert.ok(
    !s.logs.some((l) => /frame (left|loaded)/.test(l)),
    s.logs.join('\n'),
  );
  assert.deepEqual(
    s.requests.filter((r) => /script:/i.test(r)),
    [],
  );
  assert.equal(
    s.requests.filter((r) => r === `GET ${PROVIDER}frame`).length,
    1,
    'loaded once',
  );
});

test("a frame's fetch takes a Request of the page's, method, body and all, where it was read as a URL", async () => {
  // a frame with a realm of its own has a `Request` of its own, and the
  // page's was no instance of it
  const s = await scene(
    pressed(`
      const frame = document.querySelector('iframe');
      const request = new Request('${APP}taken', { method: 'POST', body: 'BODY' });
      frame.contentWindow.fetch(request).then(
        (r) => console.log('answered', r.status),
        (e) => console.log('answered', e.name),
      );
    `).replace(
      '<div style="height:100px">page</div>',
      `<div style="height:20px">page</div><iframe src="${APP}frame" style="width:100px;height:40px"></iframe>`,
    ),
    {
      [`${APP}frame`]: page(`console.log('frame');`),
      [`${APP}taken`]: 'taken',
    },
  );
  await s.when(() => s.requests.includes(`GET ${APP}frame`), 'no frame');
  await act(() => new Promise((r) => setTimeout(r, 60)));
  await s.press();
  await s.until('answered');
  assert.ok(s.requests.includes(`POST ${APP}taken`), s.requests.join('\n'));
});

test('a frame opens a window, and that window talks to the frame', async () => {
  const s = await scene(
    pressed(`
      const frame = document.querySelector('iframe');
      frame.contentWindow.postMessage('open', '*');
    `).replace(
      '<div style="height:100px">page</div>',
      `<div style="height:20px">page</div><iframe src="${PROVIDER}frame" style="width:100px;height:40px"></iframe>`,
    ),
    {
      [`${PROVIDER}frame`]: page(`
        addEventListener('message', (e) => {
          if (e.data === 'open') self.w = window.open('${PROVIDER}side', 'side');
          else console.log('frame heard', e.data, e.source === self.w);
        });
      `),
      [`${PROVIDER}side`]: page(`
        opener.postMessage('hello frame', '*');
        console.log('top', top === self, parent === self, frameElement);
      `),
    },
    { popups: { unblocked: true } },
  );
  await s.when(() => s.requests.includes(`GET ${PROVIDER}frame`), 'no frame');
  await act(() => new Promise((r) => setTimeout(r, 60)));
  await s.press();
  assert.equal(await s.until('top'), 'true true null');
  assert.equal(
    await s.until(`[frame ${PROVIDER}frame] frame heard`),
    'hello frame true',
  );
});

test('close is told at once and done in a task, and a name goes with it', async () => {
  const s = await scene(
    pressed(`
      const a = window.open('', 'same');
      console.log('open', a.closed, a.opener === self);
      a.close();
      console.log('closing', a.closed, a.opener === self);
      const b = window.open('', 'same');
      console.log('another', b !== a, a.closed, b.closed);
      setTimeout(() => {
        console.log('gone', a.closed, a.opener, a.document);
        b.close();
      }, 20);
    `),
    {},
    { popups: { unblocked: true } },
  );
  await s.press();
  assert.equal(await s.until('open'), 'false true');
  assert.equal(await s.until('closing'), 'true true');
  assert.equal(await s.until('another'), 'true true false');
  assert.equal(await s.until('gone'), 'true null undefined');
  await s.when(() => s.shown().length === 1, 'a window still showed');
});

test('a window a window opened has it for its opener, and a name finds it from anywhere', async () => {
  const s = await scene(
    pressed(`
      self.a = window.open('${APP}a', 'first');
    `),
    {
      [`${APP}a`]: page(`
        const b = window.open('${APP}b', 'second');
        console.log('from a', b.closed);
      `),
      [`${APP}b`]: page(`
        console.log('opener', opener.name, opener.opener.name === '', opener.opener === window.open('', 'none-of-these') ? 'x' : 'y');
        console.log('found', window.open('', 'first') === opener);
      `),
    },
    { popups: { unblocked: true } },
  );
  await s.press();
  assert.equal(await s.until('opener'), 'first true y');
  assert.equal(await s.until('found'), 'true');
});

test('a frame has an index and is counted, and a window has its bars', async () => {
  const s = await scene(
    page(`
      const before = window.length;
      const frame = document.createElement('iframe');
      document.body.append(frame);
      console.log('frames', before, window.length, window[0] === frame.contentWindow, window[1]);
      console.log('bars', window.locationbar.visible, window.toolbar.visible, window.locationbar !== window.toolbar);
      addEventListener('mousedown', () => {
        const w = window.open('${APP}a', '', 'popup');
        const x = window.open('${APP}a');
        console.log('window bars', w.toolbar.visible, x === null);
      });
    `),
    {},
  );
  assert.equal(await s.until('frames'), '0 1 true undefined');
  assert.equal(await s.until('bars'), 'true true true');
  await s.press();
  assert.equal(await s.until('window bars'), 'false true');
});

test('a page that awaits a window hears it, with no task of its own to wake it', async () => {
  const s = await scene(
    pressed(`
      (async () => {
        const w = window.open('${APP}one');
        await new Promise((go) => (w.onload = go));
        console.log('loaded', w.location.pathname);
        const told = await new Promise((go) => (w.tell = go));
        console.log('told', told);
      })();
    `),
    {
      [`${APP}one`]: page(
        `addEventListener('load', () => setTimeout(() => self.tell('from its script'), 0));`,
      ),
    },
  );
  await s.press();
  assert.equal(await s.until('loaded'), '/one');
  assert.equal(await s.until('told'), 'from its script');
});

/** A page of a real address, which a worker can control: its host, a network
 *  and a keeper, and a window for each it opens, as a tab holds them. */
async function controlled(
  pages: Record<
    string,
    string | { status?: number; headers: Headers; body: string }
  >,
  t: { after(fn: () => unknown): void },
): Promise<{
  url(path: string): string;
  logs: string[];
  tabs: string[];
  popups: HtmlPopup[];
  asked: string[];
  notes: ReturnType<typeof memoryNotifications>;
  until(prefix: string): Promise<string>;
  press(): Promise<void>;
}> {
  const notes = memoryNotifications();
  const asked: string[] = [];
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    asked.push(path);
    const page = pages[path];
    const {
      status = 200,
      headers = [],
      body = 'none',
    } = typeof page === 'string' ? { body: page } : (page ?? { status: 404 });
    response.writeHead(status, {
      'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/html',
      ...Object.fromEntries(headers),
    });
    response.end(body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(
    () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  );
  const port = (server.address() as AddressInfo).port;
  const url = (path: string) => `http://localhost:${port}${path}`;
  const keeper = new HtmlServiceWorkers();
  t.after(() => keeper.dispose());
  const network = new HtmlNetwork({ serviceWorkers: keeper });
  const logs: string[] = [];
  const tabs: string[] = [];
  const popups: HtmlPopup[] = [];
  let setOpened: (popup: HtmlPopup) => void = () => {};
  let pressAt: (() => Promise<void>) | null = null;

  function Win(props: { popup?: HtmlPopup; first?: string }) {
    const { popup } = props;
    const [session] = useState(() => new HtmlSessionHistory());
    const [doc, setDoc] = useState<{
      n: number;
      url: string;
      body: string;
      headers?: Headers;
      redirects?: HtmlDocumentHop[];
    }>({
      n: 0,
      url: props.first ? url('/opener') : 'about:blank',
      body: props.first ?? '',
    });
    const load = (to: string) =>
      void network.html(to).then((got) =>
        setDoc((was) => ({
          n: was.n + 1,
          url: got.url,
          body: got.source,
          headers: got.headers,
          redirects: got.redirects,
        })),
      );
    useEffect(() => {
      if (popup && popup.url !== 'about:blank') load(popup.url);
    }, []);
    const fetcher = network.fetcher(doc.url);
    return h(Html, {
      key: doc.n,
      ref: (node: unknown) => {
        if (node && !popup) {
          pressAt = async () => {
            await act(async () => {
              fireEvent.mouseDown(node as DrawnNode);
              fireEvent.mouseUp(node as DrawnNode);
            });
          };
        }
      },
      source: doc.body,
      partial: false,
      baseUrl: doc.url,
      style: { flexGrow: 1 },
      scripts: {
        log: (level: string, text: string) =>
          void logs.push(`${level}: ${text}`),
        fetch: fetcher,
        headers: doc.headers,
        redirects: doc.redirects,
        session,
        serviceWorkers: keeper,
        notifications: notes,
        ...(popup && { popup }),
        popups: {
          unblocked: true,
          open(opened: HtmlPopup) {
            popups.push(opened);
            setOpened(opened);
            return true;
          },
        },
        navigate: (to: string, how: string) => {
          if (how === 'tab') tabs.push(to);
          else load(to);
        },
      } as HtmlScripts,
    });
  }
  function Host() {
    const [opened, set] = useState<HtmlPopup[]>([]);
    setOpened = (popup) => set((all) => [...all, popup]);
    return h(
      'box',
      { style: { flexDirection: 'column', flexGrow: 1 } },
      h(
        'box',
        { style: { flexDirection: 'column', height: 120 } },
        h(Win, { first: pages['/opener'] as string }),
      ),
      ...opened.map((popup) =>
        h(
          'box',
          { key: popup.id, style: { flexDirection: 'column', height: 120 } },
          h(Win, { popup }),
        ),
      ),
    );
  }
  await renderX11(
    h(Host),
    FONTS
      ? { width: 400, height: 400, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  return {
    url,
    logs,
    tabs,
    popups,
    asked,
    notes,
    press: () => pressAt!(),
    async until(prefix) {
      const end = Date.now() + 15000;
      for (;;) {
        await act(() => new Promise((r) => setTimeout(r, 10)));
        const line = logs.find((l) => l.startsWith(`log: ${prefix}`));
        if (line) return line.slice(`log: ${prefix}`.length).trim();
        assert.ok(Date.now() < end, `no "${prefix}", in:\n${logs.join('\n')}`);
      }
    },
  };
}

/** Takes the page's requests for `/data`, and says what clients it has. */
const LISTING_WORKER = `
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
self.addEventListener('fetch', (e) => {
  if (new URL(e.request.url).pathname === '/data') {
    e.respondWith(new Response('the worker'));
  }
});
self.addEventListener('notificationclick', (e) => {
  e.waitUntil(clients.openWindow('/opened'));
});
self.addEventListener('message', (e) => {
  if (e.data === 'notify') {
    registration.showNotification('go');
    return;
  }
  clients.matchAll({ includeUncontrolled: true }).then((all) => {
    e.source.postMessage(all.map((c) => new URL(c.url).pathname + ' ' + c.frameType).sort().join(', '));
  });
});`;

/** Registers the worker, and says so once it controls the page. */
const WORKER_OPENER = (press: string) => `<!doctype html><body><script>
navigator.serviceWorker.register('/sw.js');
navigator.serviceWorker.addEventListener('controllerchange', () => console.log('controlled'));
addEventListener('mousedown', () => { ${press} });
</script>`;

test("a window is its opener worker's auxiliary client, and the worker answers what it asks for", async (t) => {
  const s = await controlled(
    {
      '/opener': WORKER_OPENER(`
        const blank = window.open('', 'blank');
        console.log('blank', blank.isSecureContext, blank.navigator.serviceWorker.controller !== null);
        self.w = window.open('/side', 'side');
      `),
      '/side': `<!doctype html><body><script>
        const worker = navigator.serviceWorker;
        console.log('side', worker.controller !== null, opener !== null);
        fetch('/data').then((r) => r.text()).then((text) => console.log('data', text));
        worker.onmessage = (e) => console.log('clients', e.data);
        worker.controller.postMessage('list');
        </script>`,
      '/sw.js': LISTING_WORKER,
    },
    t,
  );
  await s.until('controlled');
  await s.press();
  assert.equal(await s.until('blank'), 'true true');
  assert.equal(await s.until('side'), 'true true');
  assert.equal(await s.until('data'), 'the worker');
  assert.ok(!s.asked.includes('/data'), 'the network never heard');
  assert.equal(
    await s.until('clients'),
    '/opener top-level, /side auxiliary, blank auxiliary',
  );
});

test("a window that left is no worker's auxiliary client, and a redirect's policy took it there over a real network", async (t) => {
  const s = await controlled(
    {
      '/opener': WORKER_OPENER(`self.w = window.open('/go', 'side');`),
      // the redirect says what the last response does not
      '/go': {
        status: 302,
        headers: [
          ['location', '/side'],
          ['cross-origin-opener-policy', 'same-origin'],
        ],
        body: '',
      },
      '/side': `<!doctype html><body><script>
        const worker = navigator.serviceWorker;
        console.log('side', worker.controller !== null, opener);
        worker.onmessage = (e) => console.log('clients', e.data);
        worker.controller.postMessage('list');
        </script>`,
      '/sw.js': LISTING_WORKER,
    },
    t,
  );
  await s.until('controlled');
  await s.press();
  assert.equal(await s.until('side'), 'true null');
  assert.equal(await s.until('clients'), '/opener top-level, /side top-level');
});

test("a worker's clients.openWindow is a tab with no opener, whatever a page's windows do", async (t) => {
  const s = await controlled(
    {
      '/opener': WORKER_OPENER(`
        navigator.serviceWorker.controller.postMessage('notify');
      `),
      '/sw.js': LISTING_WORKER,
    },
    t,
  );
  await s.until('controlled');
  await s.press();
  const end = Date.now() + 5000;
  while (!s.notes.shown.length && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  await act(async () => s.notes.shown[0].click());
  while (!s.tabs.length && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  assert.deepEqual(s.tabs, [s.url('/opened')]);
  assert.equal(s.popups.length, 0);
});

/**
 * What a page of one origin tries on a window it should have only by number:
 * with what the facade calls replaced, it looks through every object those
 * show it for the victim's global, and reads what it finds. `reach` is the
 * expression for the window, and the facade is walked through what crosses.
 */
const STEAL = (reach: string, say: string): string => `
  const target = ${reach};
  const hits = [];
  let route = 'plain';
  const look = (found) => {
    if (found === window || found === null) return;
    if (typeof found !== 'object' && typeof found !== 'function') return;
    try {
      if (found.secret === 'victim-secret') hits.push(route + ':global');
      if (found.document?.title === 'victim-title') hits.push(route + ':title');
      if (found.title === 'victim-title') hits.push(route + ':document');
    } catch {}
  };
  let shown = 0;
  const seen = (found) => { shown += 1; look(found); return found; };
  const real = {
    get: Map.prototype.get,
    weak: WeakMap.prototype.get,
    has: Set.prototype.has,
    own: Object.prototype.hasOwnProperty,
    str: String,
    set: Map.prototype.set,
  };
  const touch = () => {
    for (const walk of [
      () => target.postMessage('x', '*'),
      () => target.closed,
      () => target.document,
      () => target.secret,
      () => target.location.href,
      () => target.length,
      () => target.opener,
      () => target.parent,
      () => target.top,
      () => { const f = document.querySelector('iframe'); return f && f.contentDocument; },
    ]) {
      try { look(walk()); } catch {}
    }
  };
  touch();
  // Map, WeakMap: what the facade reads a window by hands it to the page
  route = 'map';
  Map.prototype.get = function (key) { return seen(real.get.call(this, key)); };
  WeakMap.prototype.get = function (key) { return seen(real.weak.call(this, key)); };
  Map.prototype.set = function (key, value) { seen(value); return real.set.call(this, key, value); };
  touch();
  Map.prototype.get = real.get;
  WeakMap.prototype.get = real.weak;
  Map.prototype.set = real.set;
  // String: every comparison of two origins goes through it
  route = 'string';
  window.String = () => 'same';
  touch();
  window.String = real.str;
  // a set says no, and a table says yes
  route = 'set';
  Set.prototype.has = () => false;
  touch();
  Set.prototype.has = real.has;
  route = 'own';
  Object.prototype.hasOwnProperty = () => true;
  touch();
  Object.prototype.hasOwnProperty = real.own;
  ${say}('attacked', shown > 0, JSON.stringify([...new Set(hits)]));
`;

/** The document whose global, title and address are what is after. */
const VICTIM = `document.title = 'victim-title'; window.secret = 'victim-secret';`;

test('another origin is a number: an opener gets nothing of its popup, whatever it replaces', async () => {
  const s = await scene(
    pressed(`
      self.w = window.open('${PROVIDER}side');
      addEventListener('message', () => { ${STEAL('self.w', 'console.log')} }, { once: true });
    `),
    { [`${PROVIDER}side`]: page(`${VICTIM} opener.postMessage('up', '*');`) },
  );
  await s.press();
  assert.equal(await s.until('attacked'), 'true []');
  assert.ok(!s.logs.some((l) => l.includes('victim-')), s.logs.join('\n'));
});

test('another origin is a number: a popup gets nothing of its opener, whatever it replaces', async () => {
  const s = await scene(pressed(`${VICTIM} window.open('${PROVIDER}side');`), {
    [`${PROVIDER}side`]: page(STEAL('opener', 'console.log')),
  });
  await s.press();
  assert.equal(await s.until('attacked'), 'true []');
  assert.ok(!s.logs.some((l) => l.includes('victim-')), s.logs.join('\n'));
});

test('another origin is a number: a page gets nothing of its frame, whatever it replaces', async () => {
  const s = await scene(
    page(`
      addEventListener('message', () => { ${STEAL("document.querySelector('iframe').contentWindow", 'console.log')} }, { once: true });
      const f = document.createElement('iframe');
      f.src = '${PROVIDER}side';
      document.body.append(f);
    `),
    { [`${PROVIDER}side`]: page(`${VICTIM} parent.postMessage('up', '*');`) },
    { popups: { unblocked: true } },
  );
  assert.equal(await s.until('attacked'), 'true []');
  assert.ok(!s.logs.some((l) => l.includes('victim-')), s.logs.join('\n'));
});

test('another origin is a number: a frame gets nothing of its page, whatever it replaces', async () => {
  const s = await scene(
    page(`
      ${VICTIM}
      const f = document.createElement('iframe');
      f.src = '${PROVIDER}side';
      document.body.append(f);
    `),
    { [`${PROVIDER}side`]: page(STEAL('parent', 'console.log')) },
    { popups: { unblocked: true } },
  );
  assert.equal(await s.until(`[frame ${PROVIDER}side] attacked`), 'true []');
  assert.ok(!s.logs.some((l) => l.includes('victim-')), s.logs.join('\n'));
});

test('another origin is a number: a frame with no script of its own stays out of reach, whatever the page replaces', async () => {
  const s = await scene(
    page(`
      const f = document.createElement('iframe');
      f.src = '${PROVIDER}side';
      f.onload = () => { ${STEAL("document.querySelector('iframe').contentWindow", 'console.log')} };
      document.body.append(f);
    `),
    {
      [`${PROVIDER}side`]: `<!doctype html><title>victim-title</title><p>victim-text</p>`,
    },
  );
  assert.equal(await s.until('attacked'), 'true []');
});

/** A frame of the page's site, on another host: another origin, which
 *  `document.domain` can make of one origin-domain with the page. */
const SUB = 'https://www.app.test/';

test('document.domain: a page and a frame of its site that both set it reach each other, and either reaches nothing where the other did not', async () => {
  // both set the site's domain: each is the other's to read, a window and a
  // document and an element (HTML 7.1.1, "same origin-domain")
  const s = await scene(
    page(`
      window.secret = 'page-secret';
      document.domain = 'app.test';
      addEventListener('message', () => {
        const w = document.querySelector('iframe').contentWindow;
        console.log('page', document.domain, w.secret, w.document.title,
          w.frameElement === document.querySelector('iframe'));
      }, { once: true });
      const f = document.createElement('iframe');
      f.src = '${SUB}side';
      document.body.append(f);
    `),
    {
      [`${SUB}side`]: page(`
        ${VICTIM}
        document.domain = 'APP.test';
        console.log('frame', document.domain, parent.secret);
        parent.postMessage('up', '*');
      `),
    },
    { popups: { unblocked: true } },
  );
  assert.equal(
    await s.until(`[frame ${SUB}side] frame`),
    'app.test page-secret',
  );
  assert.equal(
    await s.until('page'),
    'app.test victim-secret victim-title true',
  );
});

test('document.domain set by the page alone leaves its frame of the site a number, whatever the page replaces', async () => {
  // set before the frame's realm starts, and again once it is in: the link
  // made as it starts and the one made again as the page sets it
  const s = await scene(
    page(`
      document.domain = 'app.test';
      addEventListener('message', () => {
        document.domain = 'app.test';
        ${STEAL("document.querySelector('iframe').contentWindow", 'console.log')}
      }, { once: true });
      const f = document.createElement('iframe');
      f.src = '${SUB}side';
      document.body.append(f);
    `),
    { [`${SUB}side`]: page(`${VICTIM} parent.postMessage('up', '*');`) },
    { popups: { unblocked: true } },
  );
  assert.equal(await s.until('attacked'), 'true []');
  assert.ok(!s.logs.some((l) => l.includes('victim-')), s.logs.join('\n'));
});

test('document.domain set by the frame alone leaves its page a number, whatever the frame replaces', async () => {
  const s = await scene(
    page(`
      ${VICTIM}
      const f = document.createElement('iframe');
      f.src = '${SUB}side';
      document.body.append(f);
    `),
    {
      [`${SUB}side`]: page(
        `document.domain = 'app.test'; ${STEAL('parent', 'console.log')}`,
      ),
    },
    { popups: { unblocked: true } },
  );
  assert.equal(await s.until(`[frame ${SUB}side] attacked`), 'true []');
  assert.ok(!s.logs.some((l) => l.includes('victim-')), s.logs.join('\n'));
});

test('document.domain set by both hands the frame its page: the search that finds nothing above finds it here', async () => {
  // the control for the two above: the same search, with the domain set on
  // both sides, finds the victim, so finding nothing there is the host's doing
  const s = await scene(
    page(`
      ${VICTIM}
      document.domain = 'app.test';
      const f = document.createElement('iframe');
      f.src = '${SUB}side';
      document.body.append(f);
    `),
    {
      [`${SUB}side`]: page(
        `document.domain = 'app.test'; ${STEAL('parent', 'console.log')}`,
      ),
    },
    { popups: { unblocked: true } },
  );
  const found = await s.until(`[frame ${SUB}side] attacked`);
  assert.match(found, /^true \[.*plain:global.*\]$/, found);
});

test('document.domain refuses what is not its host or a registrable suffix of it, whatever the page replaces', async () => {
  // the host checks the value (HTML 7.1.1, "is a registrable domain suffix
  // of or is equal to"): a public suffix, another site, a port, a path, an
  // address and nothing are no domain to relax to, and what the page makes
  // the facade's string methods answer changes none of it
  const tried = [
    'test',
    '.app.test',
    'provider.test',
    'other.app.test',
    'app.test:443',
    'app.test/',
    '127.0.0.1',
    '',
  ];
  const s = await scene(
    page(`
      const f = document.createElement('iframe');
      f.src = '${SUB}side';
      document.body.append(f);
    `),
    {
      [`${SUB}side`]: page(`
        String.prototype.endsWith = () => true;
        String.prototype.toLowerCase = function () { return 'app.test'; };
        const out = [];
        for (const value of ${JSON.stringify(tried)}) {
          try { document.domain = value; out.push(value + ':set'); }
          catch (e) { out.push(value + ':' + e.name); }
        }
        console.log('tried', document.domain, JSON.stringify(out));
      `),
    },
    { popups: { unblocked: true } },
  );
  const said = await s.until(`[frame ${SUB}side] tried`);
  assert.equal(
    said,
    `www.app.test ${JSON.stringify(tried.map((v) => `${v}:SecurityError`))}`,
  );
});

test('document.domain set by one of two documents of one origin takes back what each reaches from then on, and the other setting it gives it back', async () => {
  // a WindowProxy's checks are made at each access (HTML 7.2.3): a page that
  // sets the domain its frame of its own origin did not is of another
  // origin-domain from then on, and of one again once the frame sets it
  // too. A document the page took while they were one stays the page's, as
  // it does in a browser
  const s = await scene(
    page(`
      let held = null;
      const read = () => {
        const f = document.querySelector('iframe');
        try { return f.contentWindow.secret; } catch (error) { return error.name; }
      };
      addEventListener('message', (e) => {
        const f = document.querySelector('iframe');
        if (e.data === 'up') {
          held = f.contentDocument;
          const before = read();
          document.domain = 'app.test';
          console.log('apart', before, read(), f.contentDocument, held.title);
          f.contentWindow.postMessage('join', '*');
        } else if (e.data === 'joined') {
          console.log('joined', read(), f.contentDocument === held);
        }
      });
      const f = document.createElement('iframe');
      f.src = '${APP}side';
      document.body.append(f);
    `),
    {
      [`${APP}side`]: page(`
        ${VICTIM}
        addEventListener('message', () => {
          document.domain = 'app.test';
          parent.postMessage('joined', '*');
        });
        parent.postMessage('up', '*');
      `),
    },
    { popups: { unblocked: true } },
  );
  assert.equal(
    await s.until('apart'),
    'victim-secret SecurityError null victim-title',
  );
  assert.equal(await s.until('joined'), 'victim-secret true');
});

test("document.domain set by an opener is its about:blank popup's too, which it writes into as before", async () => {
  // a window's `about:blank` is of its creator's origin, the domain it set
  // and all (HTML 7.1.1), so a page that sets the domain and opens a window
  // to print from still reaches it
  const s = await scene(
    pressed(`
      document.domain = 'app.test';
      const w = window.open();
      w.document.body.textContent = 'printed';
      console.log('blank', w.document.domain, w.document.body.textContent);
    `),
    {},
  );
  await s.press();
  assert.equal(await s.until('blank'), 'app.test printed');
});

test('document.domain set by an opener and its popup of the site hands each the other', async () => {
  const s = await scene(
    pressed(`
      window.secret = 'opener-secret';
      document.domain = 'app.test';
      self.w = window.open('${SUB}side');
      addEventListener('message', () => console.log('opener', self.w.secret), { once: true });
    `),
    {
      [`${SUB}side`]: page(`
        ${VICTIM}
        document.domain = 'app.test';
        console.log('popup', opener.secret);
        opener.postMessage('up', '*');
      `),
    },
  );
  await s.press();
  assert.equal(await s.until('popup'), 'opener-secret');
  assert.equal(await s.until('opener'), 'victim-secret');
});

test('a frame sent to another origin by a redirect is of that origin, whatever it asked for', async () => {
  const s = await scene(
    page(`
      const f = document.createElement('iframe');
      f.src = '${APP}go';
      f.onload = () => { ${STEAL("document.querySelector('iframe').contentWindow", 'console.log')} };
      document.body.append(f);
    `),
    {
      [`${APP}go`]: { redirect: `${PROVIDER}side` },
      [`${PROVIDER}side`]: `<!doctype html><title>victim-title</title><p>victim-text</p>`,
    },
  );
  assert.equal(await s.until('attacked'), 'true []');
});

test('where frames run in the page, a frame a redirect sent to another origin runs nothing there, and hands it nothing', async () => {
  const watch = `
    for (const [kind, name] of [[Map, 'Map'], [WeakMap, 'WeakMap']]) {
      const real = kind.prototype.set;
      let busy = false;
      kind.prototype.set = function (key, value) {
        if (!busy && value !== null && typeof value === 'object') {
          busy = true;
          try {
            if (value.title === 'victim-title') console.log('stolen', name);
          } catch {}
          busy = false;
        }
        return real.call(this, key, value);
      };
    }
  `;
  const s = await scene(
    page(`
      ${watch}
      for (const src of ['${APP}own', '${APP}go']) {
        const f = document.createElement('iframe');
        f.src = src;
        f.onload = () => console.log('loaded', src);
        document.body.append(f);
      }
    `),
    {
      [`${APP}own`]: page(`console.log('ran', 'own');`),
      [`${APP}go`]: { redirect: `${PROVIDER}side` },
      [`${PROVIDER}side`]: `<!doctype html><title>victim-title</title><script>console.log('ran', 'theirs');</script>`,
    },
    { frames: false },
  );
  assert.equal(await s.until('ran'), 'own');
  await s.when(
    () => s.logs.includes(`log: loaded ${APP}go`),
    'the frame that goes elsewhere',
  );
  assert.ok(!s.logs.some((l) => /theirs|stolen/.test(l)), s.logs.join('\n'));
});

test('a popup that goes to a data: address has no origin, and its opener least of all', async () => {
  const data = 'data:text/html,side';
  const s = await scene(pressed(`${VICTIM} window.open('${PROVIDER}side');`), {
    [`${PROVIDER}side`]: page(`location.href = '${data}';`),
    [data]: page(`
      console.log('there', self.origin, self.isSecureContext);
      ${STEAL('opener', 'console.log')}
    `),
  });
  await s.press();
  assert.equal(await s.until('there'), 'null false');
  assert.equal(await s.until('attacked'), 'true []');
  assert.ok(!s.logs.some((l) => l.includes('victim-')), s.logs.join('\n'));
});

test('an opaque origin is no other: two data: windows, and a data: frame in one, are numbers to each other', async () => {
  const first = 'data:text/html,first';
  const second = 'data:text/html,second';
  // a `data:` URL is its own body, which no network is asked for
  const frame = `data:text/html,${encodeURIComponent(
    page(
      `console.log('framed', ${JSON.stringify('x')}); try { console.log('parent', parent.secret, parent.document.title); } catch (x) { console.log('parent', x.name); }`,
    ),
  )}`;
  const s = await scene(
    pressed(`window.open('${first}');`),
    {
      [first]: page(`
        self.w = window.open('${second}');
        addEventListener('message', (e) => {
          if (e.data !== 'up') return;
          ${STEAL('self.w', 'console.log')}
          self.w.postMessage('to my own origin', '/');
          self.w.postMessage('to anyone', '*');
          const f = document.createElement('iframe');
          f.src = ${JSON.stringify(frame)};
          document.body.append(f);
        });
      `),
      [second]: page(`
        ${VICTIM}
        addEventListener('message', (e) => console.log('heard', e.data));
        opener.postMessage('up', '*');
      `),
    },
    { popups: { unblocked: true } },
  );
  await s.press();
  assert.equal(await s.until('attacked'), 'true []');
  assert.equal(await s.until(`[frame ${frame}] parent`), 'SecurityError');
  await s.when(
    () => s.logs.includes('log: heard to anyone'),
    'the message for anyone',
  );
  assert.ok(!s.logs.includes('log: heard to my own origin'));
});

test("a javascript: address set on another origin's window goes to no host", async () => {
  const s = await scene(
    pressed(`
      self.w = window.open('${PROVIDER}side');
      addEventListener('message', () => {
        self.w.location = 'javascript:alert(1)';
        console.log('set');
      }, { once: true });
    `),
    { [`${PROVIDER}side`]: page(`opener.postMessage('up', '*');`) },
  );
  await s.press();
  await s.until('set');
  await act(() => new Promise((r) => setTimeout(r, 100)));
  assert.ok(
    !s.requests.some((r) => r.includes('javascript:')),
    s.requests.join(),
  );
});

test('the same reach finds a window of one origin, so what finds nothing above can find something', async () => {
  const s = await scene(
    pressed(`
      self.w = window.open('${APP}side');
      addEventListener('message', () => { ${STEAL('self.w', 'console.log')} }, { once: true });
    `),
    { [`${APP}side`]: page(`${VICTIM} opener.postMessage('up', '*');`) },
  );
  await s.press();
  const found = JSON.parse((await s.until('attacked')).slice('true '.length));
  for (const route of ['plain', 'map', 'string', 'set', 'own']) {
    assert.ok(found.includes(`${route}:global`), found.join(' '));
  }
});

test('what crosses origins still crosses: a clone, a port and what it answers, a canvas and what it draws', async () => {
  const s = await scene(
    pressed(`
      const w = window.open('${PROVIDER}side');
      const shown = document.createElement('canvas');
      shown.width = 4;
      shown.height = 2;
      shown.style.cssText = 'display:block;width:80px;height:40px';
      document.body.prepend(shown);
      addEventListener('message', (e) => {
        console.log('source', e.source === w, e.origin);
        const channel = new MessageChannel();
        channel.port1.onmessage = (m) => console.log('reply', m.data);
        const off = shown.transferControlToOffscreen();
        const bytes = new Uint8Array([1, 2, 3]);
        w.postMessage(
          { hello: 'there', bytes, map: new Map([[1, 'one']]), off },
          '*',
          [channel.port2, off],
        );
      });
    `),
    {
      [`${PROVIDER}side`]: page(`
        addEventListener('message', (e) => {
          const { hello, bytes, map, off } = e.data;
          console.log('got', e.origin, e.source === opener, hello, bytes.length, map.get(1), e.ports.length);
          e.ports[0].postMessage('through the port');
          const x = off.getContext('2d');
          x.fillStyle = '#ff0000';
          x.fillRect(0, 0, 4, 2);
        });
        opener.postMessage('ready', '*');
      `),
    },
  );
  await s.press();
  assert.equal(await s.until('source'), `true ${PROVIDER.slice(0, -1)}`);
  assert.equal(await s.until('got'), `${APP.slice(0, -1)} true there 3 one 1`);
  assert.equal(await s.until('reply'), 'through the port');
  if (FONTS) {
    await waitForPixel(s.ctx, 20, 20, '#ff0000', {
      message: 'what the popup drew on the canvas it was handed',
    });
  }
});

test('a message goes only to the origin it is meant for, and says who sent it as the host knows', async () => {
  const s = await scene(
    pressed(`
      const w = window.open('${PROVIDER}side');
      addEventListener('message', (e) => {
        if (e.data !== 'ready') return;
        w.postMessage('to me', '/');
        w.postMessage('to another', 'https://other.test');
        w.postMessage('to it', '${PROVIDER.slice(0, -1)}');
        try { w.postMessage('bad', 'not a url'); } catch (x) { console.log('threw', x.name); }
      });
    `),
    {
      [`${PROVIDER}side`]: page(`
        addEventListener('message', (e) => console.log('got', e.data, e.origin));
        opener.postMessage('ready', '*');
      `),
    },
  );
  await s.press();
  assert.equal(await s.until('threw'), 'SyntaxError');
  assert.equal(await s.until('got'), `to it ${APP.slice(0, -1)}`);
  await act(() => new Promise((r) => setTimeout(r, 40)));
  assert.equal(s.logs.filter((l) => l.startsWith('log: got')).length, 1);
});

/** A host by itself, as its bridge is asked by a facade a page has bent. */
function hostAt(url: string, shared = new DomShared()): DomHost {
  const seams = new Proxy(
    {},
    {
      get: (_, key) =>
        key === 'handle'
          ? { base: null }
          : key === 'log'
            ? () => {}
            : undefined,
    },
  );
  return new DomHost(new Document([]), seams as HostSeams, url, shared);
}

const refused = (answer: unknown): boolean =>
  typeof answer === 'string' && answer.startsWith('\u0001SecurityError');

test('the host refuses what reaches another origin, whatever the facade asks', () => {
  const page = hostAt(`${APP}page`);
  // its own address, which every check of its origin reads
  assert.ok(refused(page.bridge('setLocation', `${PROVIDER}page`)));
  assert.equal(page.url, `${APP}page`);
  assert.equal(page.bridge('setLocation', `${APP}other`), null);
  assert.equal(page.url, `${APP}other`);

  // a frame of another origin: its address, and its document by rewriting it
  const frame = new Element('iframe', {});
  appendChild(page.document, frame);
  const held = new Document([]);
  page.shared.frames.set(frame, held);
  page.shared.frameAt.set(frame, `${PROVIDER}side`);
  const id = page.idOf(frame);
  assert.equal(page.bridge('frameDocument', id), 0);
  assert.ok(refused(page.bridge('frameLocation', id)));
  assert.ok(refused(page.bridge('setFrameLocation', id, `${APP}mine`)));
  assert.equal(page.bridge('frameDocument', id), 0);
  assert.equal(page.shared.frameAt.get(frame), `${PROVIDER}side`);

  // and one of its own, which keeps to its origin
  page.shared.frameAt.set(frame, `${APP}side`);
  assert.equal(page.bridge('frameLocation', id), `${APP}side`);
  assert.equal(page.bridge('setFrameLocation', id, `${APP}side#x`), null);
  assert.ok(refused(page.bridge('setFrameLocation', id, `${PROVIDER}side`)));

  // the element a frame's document is in, from another origin's realm
  const inside = hostAt(`${PROVIDER}side`, page.shared);
  page.shared.frameOf.set(inside.document, frame);
  inside.foreignParent = true;
  assert.equal(inside.bridge('frameElement', 1), 0);
  inside.foreignParent = false;
  assert.notEqual(inside.bridge('frameElement', 1), 0);

  // a node handed across realms, only to its own origin
  inside.bridge('handOver', 1);
  assert.ok(refused(page.bridge('takeNode')));
  const same = hostAt(`${APP}again`, page.shared);
  page.bridge('handOver', 1);
  assert.equal(typeof same.bridge('takeNode'), 'number');
});

// --- Cross-Origin-Opener-Policy ---------------------------------------------

/** A popup that says whether it has an opener, and an opener that keeps saying
 *  what it reads of the popup, so that a test can read it after the fact. */
const WATCHED = (url: string, name = '') =>
  pressed(`
    self.w = window.open('${url}', '${name}');
    setInterval(() => console.log('state', w.closed, w.length), 5);
  `);
const SAYS = page(
  `console.log('inside', opener !== null, JSON.stringify(name));`,
);

/** What the opener reads of the popup once the popup has come in. */
async function openerRead(s: Scene): Promise<string> {
  const lines = (): string[] =>
    s.logs.filter((l) => l.startsWith('log: state'));
  const before = lines().length;
  await s.when(() => lines().length > before + 2, 'the opener went quiet');
  return lines().at(-1)!.slice('log: state '.length);
}

test('a document with COOP takes its window from its opener: closed, no opener, no name, and nothing crosses', async () => {
  const s = await scene(
    pressed(`
      self.w = window.open('${APP}strict', 'named');
      console.log('opened', w.closed, w.opener === window);
      addEventListener('message', (e) => console.log('heard', e.data));
      const timer = setInterval(() => {
        if (!w.closed) return;
        clearInterval(timer);
        console.log('severed', w.closed, w.length, w.opener, w.name, w.document);
        w.postMessage('to the popup', '*');
        w.close();
        // a name finds no window of another group, which it would go to
        const again = window.open('', 'named');
        console.log('found', again === w, again.closed);
        setTimeout(() => console.log('waited'), 30);
      }, 5);
    `),
    {
      [`${APP}strict`]: {
        body: page(`
          console.log('inside', opener, JSON.stringify(name));
          addEventListener('message', (e) => console.log('told', e.data));
          setInterval(() => console.log('alive'), 10);
        `),
        headers: coop('same-origin'),
      },
    },
    { popups: { unblocked: true } },
  );
  await s.press();
  assert.equal(await s.until('opened'), 'false true');
  assert.equal(await s.until('inside'), 'null ""');
  assert.equal(await s.until('severed'), 'true 0 null undefined undefined');
  assert.equal(await s.until('found'), 'false false');
  await s.until('waited');
  assert.ok(!s.logs.some((l) => l.startsWith('log: told')), s.logs.join('\n'));
  // that is a window to its host still, which it did not close
  assert.equal(s.popups[0].closed, false);
  assert.equal(s.shown().length, 3);
  await act(async () => s.popups[0].close());
  await s.when(() => s.shown().length === 2, 'the window stayed');
});

for (const [opener, url, policy, kept] of [
  [[], `${APP}side`, '', true],
  [[], `${PROVIDER}side`, 'unsafe-none', true],
  [[], `${APP}side`, 'same-origin', false],
  [[], `${APP}side`, 'same-origin-allow-popups', false],
  [coop('same-origin'), `${APP}side`, 'same-origin', true],
  [coop('same-origin'), `${APP}side`, '', false],
  [coop('same-origin'), `${APP}side`, 'same-origin-allow-popups', false],
  [coop('same-origin'), `${PROVIDER}side`, 'same-origin', false],
  [coop('same-origin-allow-popups'), `${APP}side`, '', true],
  [coop('same-origin-allow-popups'), `${PROVIDER}side`, '', true],
  [
    coop('same-origin-allow-popups'),
    `${APP}side`,
    'same-origin-allow-popups',
    true,
  ],
  [
    coop('same-origin-allow-popups'),
    `${PROVIDER}side`,
    'same-origin-allow-popups',
    false,
  ],
  [coop('same-origin-allow-popups'), `${APP}side`, 'same-origin', false],
  [[], `${APP}side`, 'noopener-allow-popups', false],
  [coop('noopener-allow-popups'), `${APP}side`, '', true],
  [coop('noopener-allow-popups'), `${APP}side`, 'noopener-allow-popups', false],
] as [Headers, string, string, boolean][]) {
  const said = opener[0]?.[1] ?? 'none';
  test(`an opener of ${said} ${kept ? 'keeps' : 'loses'} ${url.slice(8)} of ${policy || 'none'}`, async () => {
    const s = await scene(
      WATCHED(url),
      { [url]: { body: SAYS, headers: policy ? coop(policy) : [] } },
      { headers: opener },
    );
    await s.press();
    assert.equal(await s.until('inside'), `${kept} ""`);
    assert.equal(await openerRead(s), kept ? 'false 0' : 'true 0');
  });
}

test('same-origin with an embedder policy is a policy of its own, which same-origin alone does not match', async () => {
  const isolated: Headers = [
    ...coop('same-origin'),
    ['cross-origin-embedder-policy', 'require-corp'],
  ];
  for (const [popup, kept] of [
    [isolated, true],
    [coop('same-origin'), false],
  ] as [Headers, boolean][]) {
    const s = await scene(
      WATCHED(`${APP}side`),
      { [`${APP}side`]: { body: SAYS, headers: popup } },
      { headers: isolated },
    );
    await s.press();
    assert.equal(await s.until('inside'), `${kept} ""`);
    await cleanup();
  }
});

test('nothing here is isolated, whatever a document asks: its realm shares a process', async () => {
  const s = await scene(
    page(`
      console.log('isolated', crossOriginIsolated);
      crossOriginIsolated = true;
      console.log('still', crossOriginIsolated);
    `),
    {},
    {
      headers: [
        ...coop('same-origin'),
        ['cross-origin-embedder-policy', 'require-corp'],
      ],
    },
  );
  assert.equal(await s.until('isolated'), 'false');
  assert.equal(await s.until('still'), 'false');
});

test('a popup login comes home to a same-origin-allow-popups opener: another origin, a redirect, and the callback posts and closes', async () => {
  const s = await scene(
    pressed(`
      const w = window.open('${PROVIDER}login', 'login', 'popup,width=400,height=300');
      addEventListener('message', (e) => {
        console.log('code', e.data.code, e.origin, e.source === w);
        setTimeout(() => console.log('closed', w.closed), 40);
      });
    `),
    {
      [`${PROVIDER}login`]: page(
        `console.log('provider', opener !== null, name);
         location.href = '${PROVIDER}authorize';`,
      ),
      [`${PROVIDER}authorize`]: { redirect: `${APP}callback?code=abc` },
      [`${APP}callback?code=abc`]: page(
        `const code = new URLSearchParams(location.search).get('code');
         window.opener.postMessage({ code }, window.origin);
         window.close();`,
      ),
    },
    { headers: coop('same-origin-allow-popups') },
  );
  await s.press();
  assert.equal(await s.until('provider'), 'true login');
  assert.equal(await s.until('code'), `abc ${APP.slice(0, -1)} true`);
  assert.equal(await s.until('closed'), 'true');
  await s.when(() => s.shown().length === 1, 'the popup still showed');
});

test('the opener polls through a same-origin-allow-popups login, and reads the popup once it is home', async () => {
  const s = await scene(
    pressed(`
      const w = window.open('${PROVIDER}login');
      const timer = setInterval(() => {
        try {
          const at = w.location.href;
          if (at === 'about:blank') return;
          clearInterval(timer);
          console.log('home', at, w.document.title, w.closed);
        } catch {}
      }, 5);
    `),
    {
      [`${PROVIDER}login`]: page(`location.href = '${APP}callback';`),
      [`${APP}callback`]: `<!doctype html><title>done</title><body>done`,
    },
    { headers: coop('same-origin-allow-popups') },
  );
  await s.press();
  assert.equal(await s.until('home'), `${APP}callback done false`);
});

test('a callback with a policy of its own ends the login, since a provider with none does not match it', async () => {
  const s = await scene(
    WATCHED(`${PROVIDER}login`),
    {
      [`${PROVIDER}login`]: page(`location.href = '${APP}callback';`),
      [`${APP}callback`]: {
        body: SAYS,
        headers: coop('same-origin-allow-popups'),
      },
    },
    { headers: coop('same-origin-allow-popups') },
  );
  await s.press();
  assert.equal(await s.until('inside'), 'false ""');
  assert.equal(await openerRead(s), 'true 0');
});

for (const [title, opener, redirect, last, kept] of [
  [
    'a redirect with the policy of both ends keeps the window',
    coop('same-origin'),
    { redirect: `${APP}side`, headers: coop('same-origin') },
    coop('same-origin'),
    true,
  ],
  [
    'a redirect with no policy loses it, whatever the last response says',
    coop('same-origin'),
    { redirect: `${APP}side` },
    coop('same-origin'),
    false,
  ],
  [
    'a redirect with a policy loses it, where the last response has none',
    [],
    { redirect: `${PROVIDER}side`, headers: coop('same-origin') },
    [],
    false,
  ],
  [
    'same-origin-allow-popups lets a redirect through, and holds what it led to',
    coop('same-origin-allow-popups'),
    { redirect: `${APP}side` },
    coop('same-origin-allow-popups'),
    false,
  ],
  [
    'what a redirect took a window out of, a last response that agrees with it does not put it back in',
    [],
    { redirect: `${APP}side`, headers: coop('same-origin') },
    coop('same-origin'),
    false,
  ],
] as [string, Headers, Answer, Headers, boolean][]) {
  test(title, async () => {
    const side =
      typeof redirect === 'object' && 'redirect' in redirect
        ? redirect.redirect
        : '';
    const s = await scene(
      WATCHED(`${APP}go`),
      { [`${APP}go`]: redirect, [side]: { body: SAYS, headers: last } },
      { headers: opener },
    );
    await s.press();
    assert.equal(await s.until('inside'), `${kept} ""`);
    assert.equal(await openerRead(s), kept ? 'false 0' : 'true 0');
  });
}

test('an opener that goes to a document with COOP leaves what it opened behind, and that goes on', async () => {
  const s = await scene(
    pressed(`
      window.open('${APP}side');
      addEventListener('message', () => { location.href = '${APP}strict'; });
    `),
    {
      [`${APP}side`]: page(`
        opener.postMessage('here', '*');
        const timer = setInterval(() => {
          if (opener) return;
          clearInterval(timer);
          console.log('alone', opener);
        }, 5);
      `),
      [`${APP}strict`]: {
        body: page(`console.log('arrived', opener, JSON.stringify(name));`),
        headers: coop('same-origin'),
      },
    },
  );
  await s.press();
  assert.equal(await s.until('arrived'), 'null ""');
  assert.equal(await s.until('alone'), 'null');
  assert.equal(s.shown().length, 2);
});

test('an opener that left goes on in its new group through every document after, and reads what it opens', async () => {
  const strict = (next: string, code: string): Answer => ({
    body: page(`console.log('at', location.pathname); ${code} ${next}`),
    headers: coop('same-origin'),
  });
  const s = await scene(
    pressed(`
      window.open('${APP}side', 'side');
      addEventListener('message', () => { location.href = '${APP}two'; });
    `),
    {
      [`${APP}side`]: page(`opener.postMessage('here', '*');`),
      [`${APP}two`]: strict(`location.href = '${APP}three';`, ''),
      // the second document since it left: a tab's slot is found by its session
      [`${APP}three`]: strict(
        '',
        `const found = window.open('', 'side');
         console.log('named', found.location.href);
         const child = window.open('${APP}four', 'child');
         console.log('child', child.document.readyState, child.opener === window);`,
      ),
      [`${APP}four`]: { body: SAYS, headers: coop('same-origin') },
    },
    { popups: { unblocked: true } },
  );
  await s.press();
  assert.equal(await s.until('named'), 'about:blank');
  assert.equal(await s.until('child'), 'complete true');
  assert.equal(await s.until('inside'), 'true "child"');
  // what it left is out of reach of the name it left by: a window of its own
  assert.equal(s.popups.length, 3);
});

test('the about:blank a window left behind runs nothing from then on', async () => {
  const s = await scene(
    pressed(`
      self.w = window.open('${APP}strict');
      w.setInterval(() => console.log('tick'), 2);
    `),
    { [`${APP}strict`]: { body: SAYS, headers: coop('same-origin') } },
  );
  await s.press();
  await s.until('inside');
  const ticks = () => s.logs.filter((l) => l === 'log: tick').length;
  const was = ticks();
  await act(() => new Promise((r) => setTimeout(r, 60)));
  assert.equal(ticks(), was);
});

test('a window that left says who sent it there, as it would have', async () => {
  const s = await scene(WATCHED(`${APP}strict`), {
    [`${APP}strict`]: {
      body: page(`console.log('referrer', document.referrer);`),
      headers: coop('same-origin'),
    },
  });
  await s.press();
  assert.equal(await s.until('referrer'), APP);
});

test('a frame that opened a window keeps it as the frame goes on, whatever the page it is in asks of its windows', async () => {
  const s = await scene(
    page(`
      const frame = document.createElement('iframe');
      frame.src = '${APP}framed';
      document.body.append(frame);
    `),
    {
      [`${APP}framed`]: page(`
        window.name = 'kept';
        window.open('${APP}side', 'side');
        addEventListener('message', () => { location.href = '${APP}again'; });
      `),
      [`${APP}again`]: page(`console.log('again');`),
      [`${APP}side`]: {
        body: page(`
          opener.postMessage('here', '*');
          setInterval(() => console.log('side', opener !== null), 5);
        `),
        headers: coop('same-origin'),
      },
    },
    { headers: coop('same-origin'), popups: { unblocked: true } },
  );
  await s.when(
    () => s.logs.some((l) => l.endsWith('again')),
    'the frame never went on',
  );
  await act(() => new Promise((r) => setTimeout(r, 30)));
  const said = s.logs.filter((l) => l.startsWith('log: side'));
  assert.equal(said.at(-1), 'log: side true');
});

test('a window that left its group opens windows of its own, under numbers no other window has', async () => {
  const s = await scene(
    WATCHED(`${APP}strict`),
    {
      [`${APP}strict`]: {
        body: page(`
          const child = window.open('${APP}child', 'child');
          addEventListener('message', (e) => console.log('heard', e.data, e.source === child));
        `),
        headers: coop('same-origin'),
      },
      [`${APP}child`]: {
        body: page(`opener.postMessage(String(opener.closed), '*');`),
        headers: coop('same-origin'),
      },
    },
    { popups: { unblocked: true } },
  );
  await s.press();
  assert.equal(await s.until('heard'), 'false true');
  assert.equal(new Set(s.popups.map((p) => p.id)).size, 2);
  assert.equal(await openerRead(s), 'true 0');
});

test('its history goes back with it: a document the window goes back to has no opener either', async () => {
  const s = await scene(WATCHED(`${APP}one`), {
    [`${APP}one`]: page(`
        console.log('one', opener !== null, JSON.stringify(name));
        if (!sessionStorage.seen) {
          sessionStorage.seen = 1;
          location.href = '${APP}strict';
        }
      `),
    [`${APP}strict`]: {
      body: page(`location.href = '${APP}one';`),
      headers: coop('same-origin'),
    },
  });
  await s.press();
  assert.equal(await s.until('one'), 'true ""');
  await s.when(
    () => s.logs.filter((l) => l.startsWith('log: one')).length === 2,
    'it never came back',
  );
  assert.equal(
    s.logs.filter((l) => l.startsWith('log: one')).at(-1),
    'log: one false ""',
  );
});

test('a window that left is a window of no group: a same-origin opener gets nothing of it, whatever it replaces', async () => {
  const s = await scene(
    pressed(`
      self.w = window.open('${APP}side');
      const timer = setInterval(() => {
        if (!w.closed) return;
        clearInterval(timer);
        ${STEAL('self.w', 'console.log')}
      }, 5);
    `),
    {
      [`${APP}side`]: {
        body: page(`${VICTIM}`),
        headers: coop('same-origin'),
      },
    },
  );
  await s.press();
  assert.equal(await s.until('attacked'), 'true []');
});

test('a window that left is a window of no group: nor does it have anything of its opener', async () => {
  const s = await scene(
    pressed(`${VICTIM} self.w = window.open('${APP}side');`),
    {
      [`${APP}side`]: {
        body: page(`
          console.log('inside', opener);
          ${STEAL('window.opener', 'console.log')}
        `),
        headers: coop('same-origin'),
      },
    },
  );
  await s.press();
  assert.equal(await s.until('inside'), 'null');
  assert.match(await s.until('attacked'), / \[\]$/);
});

test('the host decides: a document whose window left reaches no window of its group by a number, and none reaches it', () => {
  const group = new WindowGroup(new DomShared());
  const told: string[] = [];
  const window = (name: string, opener: WindowSlot | null) => {
    const slot = new WindowSlot(group, opener, null);
    const runner = {
      slot,
      host: { shared: group.shared, origin: 'https://app.test' },
      seams: {},
      engine: {
        call: (entry: string) => told.push(`${name} ${entry}`),
        unlinkWindow: (id: number, gone: boolean) =>
          told.push(`${name} lost ${id === slot.id ? 'itself' : id} ${gone}`),
      },
    } as unknown as ScriptRunner;
    slot.name = name;
    slot.runner = runner;
    slot.active = { value: 'unsafe-none', origin: 'https://app.test' };
    return { slot, runner, ops: windowOps(runner, () => runner) };
  };
  const a = window('a', null);
  const b = window('b', a.slot);
  assert.equal(a.ops.find('b'), b.slot.id);
  assert.equal(b.ops.openerOf(b.slot.id), a.slot.id);
  told.length = 0;

  const next = a.slot.arrives(`${APP}strict`, coop('same-origin'), [], {});

  assert.notEqual(next, a.slot);
  assert.equal(next.opener, null);
  assert.equal(next.name, '');
  assert.notEqual(next.group, group, 'a group of its own');
  assert.notEqual(next.group.shared, group.shared, 'over a tree of its own');
  assert.equal(next.group.shared.windows, next.group, 'and the two are one');
  assert.notEqual(next.id, a.slot.id);
  assert.equal(group.slots.has(a.slot), false);
  assert.equal(a.slot.closing, true);
  assert.equal(b.slot.opener, null, 'what it opened has no opener');
  assert.deepEqual(told.sort(), [
    `a lost ${b.slot.id} true`,
    `b lost ${a.slot.id} true`,
  ]);

  // what is left of the document it showed, while the host lets it go
  told.length = 0;
  assert.equal(a.ops.find('b'), 0);
  assert.equal(a.ops.openerOf(b.slot.id), 0);
  a.ops.post(-b.slot.id, 'text', '*');
  a.ops.wire(-b.slot.id, 'text');
  // and what is left behind has lost it
  assert.equal(b.ops.find('a'), 0);
  assert.equal(b.ops.openerOf(a.slot.id), 0);
  b.ops.post(-a.slot.id, 'text', '*');
  assert.deepEqual(told, []);

  // a window on its way out is not brought back by what comes to it
  const c = window('c', null);
  c.slot.closing = true;
  assert.equal(
    c.slot.arrives(`${APP}strict`, coop('same-origin'), [], {}),
    c.slot,
  );
});

test('a document in a frame says nothing to its window, whatever its policy', async () => {
  const s = await scene(WATCHED(`${APP}side`), {
    [`${APP}side`]: {
      body: page(`
          const frame = document.createElement('iframe');
          frame.src = '${APP}framed';
          document.body.append(frame);
          console.log('inside', opener !== null, JSON.stringify(name));
        `),
      headers: coop('unsafe-none'),
    },
    [`${APP}framed`]: {
      body: page(`console.log('framed', parent !== self);`),
      headers: coop('same-origin'),
    },
  });
  await s.press();
  assert.equal(await s.until('inside'), 'true ""');
  await s.when(
    () => s.logs.some((l) => l.endsWith('framed true')),
    'the frame never ran',
  );
  assert.equal(await openerRead(s), 'false 1');
});

test('over no secure context a policy says nothing', async () => {
  const url = 'http://plain.test/side';
  const s = await scene(WATCHED(url), {
    [url]: { body: SAYS, headers: coop('same-origin') },
  });
  await s.press();
  assert.equal(await s.until('inside'), 'true ""');
  assert.equal(await openerRead(s), 'false 0');
});

test("a window of a same-origin opener's stays through its own about:blank, and has the opener's policy there", async () => {
  const s = await scene(
    WATCHED(`${APP}side`),
    {
      [`${APP}side`]: {
        body: page(`location.href = 'about:blank';`),
        headers: coop('same-origin'),
      },
      'about:blank': '',
    },
    { headers: coop('same-origin') },
  );
  await s.press();
  await s.when(
    () => s.requests.includes('GET about:blank'),
    'it never went there',
  );
  assert.equal(await openerRead(s), 'false 0');
});

for (const [policy, frame, opened] of [
  ['same-origin', PROVIDER, false],
  ['same-origin', APP, true],
  ['same-origin-allow-popups', PROVIDER, true],
  ['', PROVIDER, true],
] as [string, string, boolean][]) {
  test(`a frame of ${frame.slice(8, -1)} in a page of ${policy || 'no policy'} ${opened ? 'opens a window' : 'opens one with no opener, and is handed none'}`, async () => {
    const s = await scene(
      page(`
        const frame = document.createElement('iframe');
        frame.src = '${frame}framed';
        document.body.append(frame);
      `),
      {
        [`${frame}framed`]: page(`
          const w = window.open('${frame}side', 'asked');
          console.log('handed', w === null);
        `),
        [`${frame}side`]: SAYS,
      },
      {
        headers: policy ? coop(policy) : [],
        popups: { unblocked: true },
      },
    );
    await s.when(
      () => s.logs.some((l) => l.includes('handed ')),
      'the frame never opened it',
    );
    assert.ok(
      s.logs.some((l) => l.endsWith(`handed ${!opened}`)),
      s.logs.join('\n'),
    );
    assert.equal(s.popups.length, opened ? 1 : 0);
    assert.deepEqual(s.tabs, opened ? [] : [`${frame}side`]);
  });
}

test('a sandboxed frame in a page of same-origin keeps its flags on the window it opens, which has no opener and is no tab', async () => {
  const s = await scene(
    page(`
      const frame = document.createElement('iframe');
      frame.sandbox = 'allow-popups allow-scripts';
      frame.srcdoc = \`<script>
        console.log('handed', window.open('${APP}plain', 'asked') === null);
      <\\/script>\`;
      document.body.append(frame);
    `),
    {
      [`${APP}plain`]: page(`
        console.log('inside', opener, JSON.stringify(name), self.origin);
      `),
    },
    { headers: coop('same-origin'), popups: { unblocked: true } },
  );
  assert.equal(await s.until('inside'), 'null "" null');
  assert.ok(
    s.logs.some((l) => l.endsWith('handed true')),
    s.logs.join('\n'),
  );
  assert.equal(s.popups.length, 1);
  assert.deepEqual(s.tabs, []);
});

/** A frame with these tokens that runs `code`. */
const sandboxed = (tokens: string, code: string): string =>
  page(`
    const frame = document.createElement('iframe');
    frame.sandbox = '${tokens}';
    frame.srcdoc = \`<script>${code}<\\/script>\`;
    document.body.append(frame);
  `);

/** A plain `<a>` and how a script follows it, which has no opener. */
const clickBlank = (to: string, rel = ''): string => `{
  const a = document.createElement('a');
  a.href = '${to}';
  a.target = '_blank';
  a.rel = '${rel}';
  document.body.append(a);
  a.click();
}`;

/** Each way a document asks for a window with no opener. */
const NO_OPENER: [string, (to: string) => string][] = [
  ['noopener', (to) => `window.open('${to}', '_blank', 'noopener');`],
  ['noreferrer', (to) => `window.open('${to}', '', 'noreferrer');`],
  ['named noopener', (to) => `window.open('${to}', 'asked', 'noopener');`],
  ['plain target=_blank', (to) => clickBlank(to)],
  ['rel=noopener', (to) => clickBlank(to, 'noopener')],
];

for (const [how, open] of NO_OPENER) {
  test(`a sandbox's ${how} window keeps its flags, and is no tab`, async () => {
    const s = await scene(
      sandboxed('allow-popups allow-scripts', open(`${APP}plain`)),
      {
        [`${APP}plain`]: page(`
          let read = 'none';
          try { read = localStorage.length; } catch (e) { read = e.name; }
          console.log('inside', self.origin, read, opener);
        `),
      },
      { popups: { unblocked: true } },
    );
    assert.equal(await s.until('inside'), 'null SecurityError null');
    assert.deepEqual(s.tabs, []);
    assert.equal(s.popups.length, 1);
  });
}

test("a sandbox's window with no allow-scripts keeps them through two documents", async () => {
  const s = await scene(
    sandboxed(
      'allow-popups allow-scripts',
      clickBlank(`${APP}plain`).replace(`'${APP}plain'`, `'${APP}first'`),
    ),
    {
      [`${APP}first`]: page(`
        console.log('first', self.origin);
        location.href = '${APP}second';
      `),
      [`${APP}second`]: page(`
        console.log('second', self.origin, opener);
        window.open('${APP}third', '_blank', 'noopener');
      `),
      [`${APP}third`]: page(`console.log('third', self.origin, opener);`),
    },
    { popups: { unblocked: true } },
  );
  assert.equal(await s.until('first'), 'null');
  assert.equal(await s.until('second'), 'null null');
  assert.equal(await s.until('third'), 'null null');
  assert.deepEqual(s.tabs, []);
  assert.equal(s.popups.length, 2);
});

test('a host that shows no windows opens nothing for a sandbox: there is nowhere to keep its flags', async () => {
  const s = await scene(
    sandboxed(
      'allow-popups allow-scripts',
      `
      window.open('${APP}a');
      window.open('${APP}b', '_blank', 'noopener');
      ${clickBlank(`${APP}c`)}
      ${clickBlank(`${APP}d`, 'opener')}
      setTimeout(() => console.log('asked'), 20);
    `,
    ),
    {},
    { popups: null },
  );
  await s.when(() => s.logs.some((l) => l.endsWith(' asked')), 'not asked');
  await act(() => new Promise((r) => setTimeout(r, 60)));
  assert.deepEqual(s.tabs, []);
  assert.deepEqual(s.popups, []);
});

test('a host that refuses a window hands a sandbox no tab in its place', async () => {
  const s = await scene(
    sandboxed(
      'allow-popups allow-scripts',
      `
      window.open('${APP}a');
      ${clickBlank(`${APP}b`, 'opener')}
      setTimeout(() => console.log('asked'), 20);
    `,
    ),
    {},
    { refuse: true, popups: { unblocked: true } },
  );
  await s.when(() => s.logs.some((l) => l.endsWith(' asked')), 'not asked');
  await act(() => new Promise((r) => setTimeout(r, 60)));
  assert.deepEqual(s.tabs, []);
});

test('a sandbox that lets its windows out has a tab, as any document does', async () => {
  const s = await scene(
    sandboxed(
      'allow-popups allow-scripts allow-popups-to-escape-sandbox',
      `window.open('${APP}a', '_blank', 'noopener');`,
    ),
    {},
    { popups: { unblocked: true } },
  );
  await s.when(() => s.tabs.length > 0, 'no tab');
  assert.deepEqual(s.tabs, [`${APP}a`]);
  assert.deepEqual(s.popups, []);
});

test('no press behind it, a window that keeps its flags is blocked as any is', async () => {
  const blocked: string[] = [];
  const s = await scene(
    sandboxed(
      'allow-popups allow-scripts',
      `
      window.open('${APP}a', '_blank', 'noopener');
      ${clickBlank(`${APP}b`)}
      setTimeout(() => console.log('asked'), 20);
    `,
    ),
    {},
    { popups: { blocked: (url) => void blocked.push(url) } },
  );
  await s.when(() => s.logs.some((l) => l.endsWith(' asked')), 'not asked');
  assert.deepEqual(s.tabs, []);
  assert.deepEqual(s.popups, []);
  assert.deepEqual(blocked, [`${APP}a`, `${APP}b`]);
});

test("a page's own replaced builtins talk the host out of none of it", async () => {
  const s = await scene(
    sandboxed(
      'allow-popups allow-scripts',
      `
      const real = String;
      // the facade's own reading of the seam: no host to show a window
      window.String = (v) => (v === 'any' || v === 'gesture' ? 'none' : real(v));
      window.open('${APP}a');
      window.String = real;
      // and of the features: no opener asked for
      const parse = JSON.parse;
      JSON.parse = (t) => {
        const read = parse(t);
        return read && typeof read === 'object' && 'popup' in read
          ? { ...read, noopener: true }
          : read;
      };
      window.open('${APP}b');
      JSON.parse = parse;
      setTimeout(() => console.log('asked'), 20);
    `,
    ),
    {},
    { popups: { unblocked: true } },
  );
  await s.when(() => s.logs.some((l) => l.endsWith(' asked')), 'not asked');
  await act(() => new Promise((r) => setTimeout(r, 60)));
  assert.deepEqual(s.tabs, []);
  // what it asked for is a window that keeps its flags, or none
  for (const popup of s.popups) {
    assert.ok((popup as unknown as { sandbox: number }).sandbox, popup.url);
  }
});

test("a document's own policy keeps a window its flags, and a window that keeps them hands them on", async () => {
  const s = await scene(
    page(`
      window.open('${APP}a', '_blank', 'noopener');
      console.log('top', self.origin);
    `),
    {
      [`${APP}a`]: page(`
        console.log('inside', self.origin, opener);
        window.open('${APP}b', '_blank', 'noopener');
      `),
      [`${APP}b`]: page(`console.log('next', self.origin, opener);`),
    },
    {
      headers: [
        ['content-security-policy', 'sandbox allow-scripts allow-popups'],
      ],
      popups: { unblocked: true },
    },
  );
  assert.equal(await s.until('top'), 'null');
  assert.equal(await s.until('inside'), 'null null');
  assert.equal(await s.until('next'), 'null null');
  assert.deepEqual(s.tabs, []);
});

test('a sandboxed frame in a page of same-origin opens no document with a policy, by a window or by a tab', async () => {
  const s = await scene(
    page(`
      const frame = document.createElement('iframe');
      frame.sandbox = 'allow-popups allow-scripts';
      frame.srcdoc = \`<script>
        window.open('${APP}strict');
        const a = document.createElement('a');
        a.href = '${APP}strict';
        a.target = '_blank';
        a.rel = 'opener';
        document.body.append(a);
        a.click();
        setTimeout(() => console.log('clicked'), 20);
      <\\/script>\`;
      document.body.append(frame);
    `),
    {
      [`${APP}strict`]: {
        body: page(`console.log('ran');`),
        headers: coop('same-origin'),
      },
    },
    { headers: coop('same-origin'), popups: { unblocked: true } },
  );
  await s.when(
    () => s.logs.some((l) => l.endsWith('clicked')),
    'the frame never ran',
  );
  await act(() => new Promise((r) => setTimeout(r, 40)));
  assert.ok(!s.logs.includes('log: ran'), s.logs.join('\n'));
  assert.deepEqual(s.tabs, []);
});

test('a frame of another origin finds a window by its name all the same, and a link it follows has no opener', async () => {
  const s = await scene(
    pressed(`
      self.w = window.open('${APP}side', 'named');
      const frame = document.createElement('iframe');
      frame.src = '${PROVIDER}framed';
      document.body.append(frame);
    `),
    {
      [`${APP}side`]: { body: page(``), headers: coop('same-origin') },
      [`${APP}again`]: { body: SAYS, headers: coop('same-origin') },
      [`${PROVIDER}framed`]: page(`
        console.log('found', window.open('', 'named') !== null);
        const a = document.createElement('a');
        a.href = '${PROVIDER}linked';
        a.target = 'asked';
        document.body.append(a);
        a.click();
        setTimeout(() => console.log('clicked'), 10);
      `),
    },
    {
      headers: coop('same-origin'),
      popups: { unblocked: true },
    },
  );
  await s.press();
  await s.when(
    () => s.logs.some((l) => l.endsWith('clicked')),
    'the frame never ran',
  );
  assert.ok(
    s.logs.some((l) => l.endsWith('found true')),
    s.logs.join('\n'),
  );
  assert.equal(s.popups.length, 1, 'no window of its own');
  assert.deepEqual(s.tabs, [`${PROVIDER}linked`]);
});

test('a local document goes by who sent the window there: another window, and the window itself', async () => {
  for (const [who, kept] of [
    ['opener', false],
    ['itself', true],
  ] as [string, boolean][]) {
    const s = await scene(
      pressed(`
        self.w = window.open('${PROVIDER}side');
        setInterval(() => console.log('state', w.closed, w.length), 5);
        addEventListener('message', () => { w.location = 'about:blank'; });
      `),
      {
        [`${PROVIDER}side`]: page(
          who === 'opener'
            ? `opener.postMessage('go', '*');`
            : `location.href = 'about:blank';`,
        ),
        'about:blank': '',
      },
      { headers: coop('same-origin-allow-popups') },
    );
    await s.press();
    await s.when(
      () => s.requests.includes('GET about:blank'),
      'it never went there',
    );
    await act(() => new Promise((r) => setTimeout(r, 30)));
    assert.equal(await openerRead(s), kept ? 'false 0' : 'true 0', who);
    await cleanup();
  }
});

test('a window of this origin sent to a local document by its name goes by who sent it, which its location cannot say', async () => {
  const s = await scene(
    pressed(`
      self.w = window.open('${APP}side', 'named');
      setInterval(() => console.log('state', w.closed, w.length), 5);
      addEventListener('message', () => { window.open('about:blank', 'named'); });
    `),
    {
      [`${APP}side`]: page(`opener.postMessage('go', '*');`),
      'about:blank': '',
    },
    {
      headers: coop('same-origin-allow-popups'),
      popups: { unblocked: true },
    },
  );
  await s.press();
  await s.when(
    () => s.requests.includes('GET about:blank'),
    'it never went there',
  );
  await act(() => new Promise((r) => setTimeout(r, 30)));
  assert.equal(await openerRead(s), 'true 0');
});

test('document.write ends a window being the one it opened with, so same-origin-allow-popups no longer lets it through', async () => {
  for (const [write, kept] of [
    ['', true],
    [`w.document.write('<p>written</p>'); w.document.close();`, false],
  ] as [string, boolean][]) {
    const s = await scene(
      pressed(`
        self.w = window.open();
        ${write}
        setTimeout(() => { w.location = '${PROVIDER}side'; }, 10);
        setInterval(() => console.log('state', w.closed, w.length), 5);
      `),
      { [`${PROVIDER}side`]: SAYS },
      { headers: coop('same-origin-allow-popups') },
    );
    await s.press();
    assert.equal(await s.until('inside'), `${kept} ""`);
    assert.equal(await openerRead(s), kept ? 'false 0' : 'true 0');
    await cleanup();
  }
});

test('a window with sandboxing flags turns a document with a policy down: nothing of it runs or is drawn, and the window has gone', async () => {
  const body = `<!doctype html><body style="margin:0;background:#ff0000"><script>console.log('ran');</script>`;
  const s = await scene(
    page(`
      const frame = document.createElement('iframe');
      frame.sandbox = 'allow-popups allow-scripts allow-same-origin';
      frame.srcdoc = \`<script>
        const w = window.open('${APP}strict');
        setInterval(() => console.log('state', w.closed), 5);
      <\\/script>\`;
      document.body.append(frame);
    `),
    { [`${APP}strict`]: { body, headers: coop('same-origin') } },
    { popups: { unblocked: true } },
  );
  await s.when(
    () => s.logs.some((l) => l.endsWith('state true')),
    'the window was still there',
  );
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(!s.logs.includes('log: ran'), s.logs.join('\n'));
  if (FONTS) {
    await assert.rejects(
      waitForPixel(s.ctx, 20, 300, '#ff0000', { timeout: 200 }),
      'the document was drawn',
    );
  }
});

test("a window's flags let a document with no policy through", async () => {
  const s = await scene(
    page(`
      const frame = document.createElement('iframe');
      frame.sandbox = 'allow-popups allow-scripts';
      frame.srcdoc = \`<script>window.open('${APP}plain');<\\/script>\`;
      document.body.append(frame);
    `),
    { [`${APP}plain`]: SAYS },
    { popups: { unblocked: true } },
  );
  assert.equal(await s.until('inside'), 'true ""');
});

test("a document's own sandbox is no refusal: it loads, of an opaque origin, and that alone takes it from its opener", async () => {
  const s = await scene(
    WATCHED(`${APP}side`),
    {
      [`${APP}side`]: {
        body: SAYS,
        headers: [
          ...coop('same-origin'),
          ['content-security-policy', 'sandbox allow-scripts'],
        ],
      },
    },
    { headers: coop('same-origin') },
  );
  await s.press();
  assert.equal(await s.until('inside'), 'false ""');
  assert.equal(await openerRead(s), 'true 0');
});

test('a host that hands in no headers is a host of no policies', async () => {
  const s = await scene(WATCHED(`${PROVIDER}side`), {
    [`${PROVIDER}side`]: SAYS,
  });
  await s.press();
  assert.equal(await s.until('inside'), 'true ""');
});

test('the header reads as a structured item, by the rules WPT holds three browsers to', () => {
  for (const value of [
    'same-origin',
    ' same-origin',
    'same-origin ',
    '\tsame-origin',
    'same-origin\t',
    'same-origin;same-origin',
    'same-origin; foo=bar',
    'same-origin; report-to="endpoint"',
    'same-origin; a=1; b=2.5; c=?1; d=:YWJj:; e="s\\"t"',
  ]) {
    assert.equal(itemToken(value), 'same-origin', JSON.stringify(value));
  }
  for (const value of [
    'same-origin;',
    '\vsame-origin\v',
    '\fsame-origin\f',
    '\rsame-origin\r',
    'same-origin;\tfoo=bar',
    'same-origin ;foo=bar',
    'same-origin; foo=bar;',
    '"same-origin"',
    ':c2FtZS1vcmlnaW4=:',
    '?1',
    '1',
    '$same-origin',
    'same-origin same-origin',
    'same-origin,same-origin',
    'same-origin, same-origin',
    'same-origin; é=1',
    'sämé-origin',
    '',
  ]) {
    assert.equal(itemToken(value), null, JSON.stringify(value));
  }
  assert.equal(itemToken('Same-origin'), 'Same-origin');
  assert.equal(itemToken('*same-origin'), '*same-origin');
});

test('a policy is read from a response as HTML reads one', () => {
  const read = (headers: Headers, secure = true): OpenerPolicy =>
    openerPolicyOf(headers, secure);
  assert.equal(read([]), 'unsafe-none');
  assert.equal(read(coop('same-origin'), false), 'unsafe-none');
  assert.equal(read(coop('same-origin')), 'same-origin');
  assert.equal(read(coop('Same-origin')), 'unsafe-none');
  assert.equal(read(coop('same-site')), 'unsafe-none');
  assert.equal(read(coop('unsafe-none; report-to=x')), 'unsafe-none');
  assert.equal(
    read(coop('same-origin-allow-popups')),
    'same-origin-allow-popups',
  );
  assert.equal(read(coop('noopener-allow-popups')), 'noopener-allow-popups');
  // two lines of a header are a list, which is no item
  assert.equal(
    read([...coop('same-origin'), ...coop('same-origin')]),
    'unsafe-none',
  );
  for (const coep of ['require-corp', 'credentialless']) {
    assert.equal(
      read([...coop('same-origin'), ['Cross-Origin-Embedder-Policy', coep]]),
      'same-origin-plus-coep',
    );
  }
  assert.equal(
    read([...coop('same-origin'), ['cross-origin-embedder-policy', 'x']]),
    'same-origin',
  );
  assert.equal(
    read([
      ...coop('same-origin-allow-popups'),
      ['cross-origin-embedder-policy', 'require-corp'],
    ]),
    'same-origin-allow-popups',
  );
});

test('what requires a browsing context group switch, as HTML has it', () => {
  const at = (value: OpenerPolicy, origin = APP): PolicyOf => ({
    value,
    origin,
  });
  const other = 'https://other.test';
  // the matching rule: both none, or one value in one origin
  assert.equal(
    requiresGroupSwitch(false, at('unsafe-none'), at('unsafe-none', other)),
    false,
  );
  assert.equal(
    requiresGroupSwitch(false, at('unsafe-none'), at('same-origin')),
    true,
  );
  assert.equal(
    requiresGroupSwitch(false, at('same-origin'), at('same-origin')),
    false,
  );
  assert.equal(
    requiresGroupSwitch(false, at('same-origin'), at('same-origin', other)),
    true,
  );
  assert.equal(
    requiresGroupSwitch(false, at('same-origin'), at('same-origin-plus-coep')),
    true,
  );
  // an opaque origin is no other's
  assert.equal(
    requiresGroupSwitch(
      false,
      at('same-origin', 'null'),
      at('same-origin', 'null'),
    ),
    true,
  );
  // what only a window's first document lets through
  assert.equal(
    requiresGroupSwitch(
      true,
      at('same-origin-allow-popups'),
      at('unsafe-none', other),
    ),
    false,
  );
  assert.equal(
    requiresGroupSwitch(
      false,
      at('same-origin-allow-popups'),
      at('unsafe-none', other),
    ),
    true,
  );
  assert.equal(
    requiresGroupSwitch(
      true,
      at('noopener-allow-popups'),
      at('unsafe-none', other),
    ),
    false,
  );
  assert.equal(
    requiresGroupSwitch(true, at('same-origin'), at('unsafe-none')),
    true,
  );
  // noopener-allow-popups keeps no opener at all, and only at its first
  assert.equal(
    requiresGroupSwitch(
      true,
      at('noopener-allow-popups'),
      at('noopener-allow-popups'),
    ),
    true,
  );
  assert.equal(
    requiresGroupSwitch(
      false,
      at('noopener-allow-popups'),
      at('noopener-allow-popups'),
    ),
    false,
  );
  // a chain is each held to the one before, and none puts a switch back
  assert.equal(
    leavesGroup(true, at('same-origin-allow-popups'), [
      at('unsafe-none', other),
      at('same-origin-allow-popups'),
    ]),
    true,
  );
  assert.equal(
    leavesGroup(false, at('same-origin'), [
      at('unsafe-none'),
      at('same-origin'),
    ]),
    true,
  );
  assert.equal(
    leavesGroup(false, at('unsafe-none'), [
      at('same-origin'),
      at('same-origin'),
    ]),
    true,
  );
  assert.equal(leavesGroup(false, at('unsafe-none'), []), false);
});

test('features read as HTML reads them', () => {
  const popup = (text: string) => parseWindowFeatures(text).popup;
  assert.equal(popup(''), false);
  assert.equal(popup('popup'), true);
  assert.equal(popup('popup=0'), false);
  assert.equal(popup('popup=no'), false);
  assert.equal(popup('width=10'), true);
  assert.equal(popup('noopener'), false);
  assert.equal(popup('location,toolbar,menubar,scrollbars,status'), false);
  const read = parseWindowFeatures(
    ' noopener \f\t , width = 320 ,height=480 left=-3,TOP=9x',
  );
  assert.equal(read.noopener, true);
  assert.equal(read.width, 320);
  assert.equal(read.height, 480);
  assert.equal(read.left, 0);
  assert.equal(read.top, 9);
  assert.equal(parseWindowFeatures('width=10').width, 100);
  assert.equal(parseWindowFeatures('noreferrer').noopener, true);
  assert.equal(parseWindowFeatures('noopener=0').noopener, false);
  assert.equal(parseWindowFeatures('noopener=yes').noopener, true);
  assert.equal(parseWindowFeatures('noopener=abc').noopener, false);
});
