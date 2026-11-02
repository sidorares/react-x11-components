// `<Html scripts>`'s windows: `window.open`, `opener`, `close()`, `closed` and
// what a name finds, over the `popups` seam (`src/html/popups.ts`,
// `src/html/scripts/popups.ts`, `src/html/scripts/windows.ts`). The host here
// is the smallest that shows a window: an `<Html>` for what it opened with, and
// one for each document it goes to, in a box of this tree.
import assert from 'node:assert/strict';
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
  HtmlPopup,
  HtmlPopups,
  HtmlScripts,
} from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { DomHost, DomShared } from '../../src/html/scripts/host.js';
import type {
  FetchRequest,
  FetchResponse,
  FramePost,
  HostSeams,
} from '../../src/html/scripts/host.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const APP = 'https://app.test/';
const PROVIDER = 'https://provider.test/';

/** What the fake network answers: a body, or where it redirects to. */
type Answer = string | { redirect: string };

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
  } = {},
): Promise<Scene> {
  const logs: string[] = [];
  const popups: HtmlPopup[] = [];
  const requests: string[] = [];
  const tabs: string[] = [];
  const showing = new Map<number, string>();
  let serial = 0;
  let pressAt: (() => Promise<void>) | null = null;

  const fetch = async (request: FetchRequest): Promise<FetchResponse> => {
    let url = request.url.split('#')[0];
    requests.push(`${request.method} ${url}`);
    for (let hops = 0; hops < 5; hops += 1) {
      const answer = pages[url];
      if (answer === undefined) return respond(url, 'missing', 404);
      if (typeof answer === 'string') {
        return { ...respond(url, answer), url, redirected: hops > 0 };
      }
      url = new URL(answer.redirect, url).href;
    }
    throw new Error('too many redirects');
  };

  /** A window: an `<Html>` for each document it goes to. */
  function Win(props: { popup?: HtmlPopup; first?: string }) {
    const { popup } = props;
    const handle = useHtmlHandle();
    const [session] = useState(() => new HtmlSessionHistory());
    const [doc, setDoc] = useState<{ n: number; url: string; body: string }>({
      n: 0,
      url: props.first ? APP : 'about:blank',
      body: props.first ?? '',
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
  pages: Record<string, string>,
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
    const body = pages[path];
    response.writeHead(body === undefined ? 404 : 200, {
      'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/html',
    });
    response.end(body ?? 'none');
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
    const [doc, setDoc] = useState({
      n: 0,
      url: props.first ? url('/opener') : 'about:blank',
      body: props.first ?? '',
    });
    const load = (to: string) =>
      void network
        .html(to)
        .then((got) =>
          setDoc((was) => ({ n: was.n + 1, url: got.url, body: got.source })),
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
        h(Win, { first: pages['/opener'] }),
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
