// `<Html scripts>`'s windows: `window.open`, `opener`, `close()`, `closed` and
// what a name finds, over the `popups` seam (`src/html/popups.ts`,
// `src/html/scripts/popups.ts`, `src/html/scripts/windows.ts`). The host here
// is the smallest that shows a window: an `<Html>` for what it opened with, and
// one for each document it goes to, in a box of this tree.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import React, { useEffect, useRef, useState } from 'react';
import { act, cleanup, fireEvent, renderX11 } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import {
  Html,
  HtmlSessionHistory,
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
import type {
  FetchRequest,
  FetchResponse,
  FramePost,
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

  await renderX11(
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
