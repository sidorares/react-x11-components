// What a page reads of another origin: a script's errors, a module's exports,
// what a redirect hides, a canvas's pixels. Each test is a page of one origin
// after what another holds, and what the page is told is the assertion, since
// the rules are the host's (`fetch-hops.ts`, `script-origin.ts`) and a page
// can change anything the facade does.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html, HtmlNetwork, preloadHtmlScripts } from '../../src/html/index.js';
import type { HtmlScripts, ResourceRequest } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import type {
  FetchRequest,
  FetchResponse,
} from '../../src/html/scripts/host.js';
import { judgeScript } from '../../src/html/scripts/script-origin.js';
import {
  agentHeaders,
  nextHop,
  redirectTainted,
} from '../../src/html/scripts/fetch-hops.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const APP = 'https://app.test/';
const OTHER = 'https://other.test/';
const THIRD = 'https://third.test/';

/** What the fake network answers an address with. */
interface Page {
  status?: number;
  body?: string;
  headers?: [string, string][];
}

/** A script's source, as a host that says where it came from hands it over. */
interface Source {
  text: string;
  url?: string;
  headers?: [string, string][];
}

const seen = (logs: string[], prefix: string): Promise<string> =>
  (async () => {
    const end = Date.now() + 5000;
    for (;;) {
      const line = logs.find((l) => l.startsWith(`log: ${prefix}`));
      if (line) return line.slice(`log: ${prefix}`.length).trim();
      assert.ok(Date.now() < end, `no "${prefix}", in:\n${logs.join('\n')}`);
      await act(() => new Promise((r) => setTimeout(r, 10)));
    }
  })();

/** A document of `APP` running `code`, on a network that holds to hops as
 *  `HtmlNetwork` does: it answers a redirect as it is. `follows` makes it a
 *  network that follows redirects itself. */
async function scene(
  code: string,
  options: {
    pages?: Record<string, Page>;
    sources?: Record<string, string | Source>;
    follows?: boolean;
    head?: string;
  } = {},
): Promise<{ logs: string[]; asked: FetchRequest[] }> {
  const logs: string[] = [];
  const asked: FetchRequest[] = [];
  const pages = options.pages ?? {};
  const answer = (url: string, request: FetchRequest): FetchResponse => {
    const at = url.split('#')[0];
    const key =
      request.method === 'OPTIONS' && pages[`OPTIONS ${at}`]
        ? `OPTIONS ${at}`
        : at;
    const page = pages[key] ?? { status: 404 };
    return {
      url: at,
      status: page.status ?? 200,
      statusText: '',
      redirected: false,
      headers: page.headers ?? [],
      body: page.body ?? '',
    };
  };
  const fetch = async (request: FetchRequest): Promise<FetchResponse> => {
    asked.push(request);
    if (options.follows) {
      let url = request.url;
      for (let hop = 0; hop < 5; hop += 1) {
        const r = answer(url, request);
        const to = r.headers.find(([k]) => k === 'location')?.[1];
        if (!to) return { ...r, redirected: hop > 0 };
        url = new URL(to, url).href;
      }
    }
    return answer(request.url, request);
  };
  const scripts: HtmlScripts = {
    log: (level, text) => void logs.push(`${level}: ${text}`),
    fetch,
  };
  await renderX11(
    h(Html, {
      source: `<!doctype html><html><head>${options.head ?? ''}</head><body><script>${code}</script></body></html>`,
      partial: false,
      baseUrl: APP,
      scripts,
      onResource: async (r: ResourceRequest) => {
        const found = options.sources?.[r.url];
        if (found === undefined || r.kind !== 'script') return null;
        return typeof found === 'string'
          ? { kind: 'script' as const, text: found }
          : { kind: 'script' as const, ...found };
      },
      style: { flexGrow: 1 },
    }),
    FONTS
      ? { width: 320, height: 200, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  return { logs, asked };
}

const JS: [string, string][] = [['content-type', 'text/javascript']];
const ANY: [string, string][] = [['access-control-allow-origin', '*']];
const redirect = (to: string, headers: [string, string][] = []): Page => ({
  status: 307,
  headers: [['location', to], ...headers],
});

test("another origin's script runs, and what it throws is no business of the page's", async () => {
  const { logs } = await scene(
    `
    window.onerror = (m, f, l, c, e) => {
      console.log('error', JSON.stringify([m, f, l, c, e]));
      return true;
    };
    const s = document.createElement('script');
    s.src = '${OTHER}data.csv';
    s.onload = () => console.log('loaded');
    document.body.append(s);
    `,
    { sources: { [`${OTHER}data.csv`]: 'alice_secret_token' } },
  );
  assert.equal(await seen(logs, 'error'), '["Script error.","",0,0,null]');
  await seen(logs, 'loaded');
  assert.ok(!logs.join('\n').includes('alice'), logs.join('\n'));
});

test("what another origin's script fails to parse with says nothing of it either", async () => {
  const { logs } = await scene(
    `
    window.onerror = (m) => { console.log('error', m); return true; };
    const s = document.createElement('script');
    s.src = '${OTHER}x.js';
    document.body.append(s);
    `,
    { sources: { [`${OTHER}x.js`]: 'name,secret\nalice,hunter2 (' } },
  );
  assert.equal(await seen(logs, 'error'), 'Script error.');
  assert.ok(!logs.join('\n').includes('alice'), logs.join('\n'));
});

test('a script a redirect took to another origin is held to where it landed', async () => {
  const { logs } = await scene(
    `
    window.onerror = (m) => { console.log('error', m); return true; };
    const s = document.createElement('script');
    s.src = '${APP}moved.js';
    document.body.append(s);
    `,
    {
      sources: {
        [`${APP}moved.js`]: { text: 'alice_secret', url: `${OTHER}landed.js` },
      },
    },
  );
  assert.equal(await seen(logs, 'error'), 'Script error.');
});

test("the page's own script tells it everything, a data: URL's too", async () => {
  const { logs } = await scene(
    `
    window.onerror = (m) => { console.log('error', m); return true; };
    const s = document.createElement('script');
    s.src = '${APP}own.js';
    document.body.append(s);
    `,
    { sources: { [`${APP}own.js`]: 'own_name' } },
  );
  assert.match(await seen(logs, 'error'), /own_name is not defined/);
  assert.equal(
    judgeScript('x', 'data:text/javascript,x', 'https://app.test', null, false)
      ?.muted,
    false,
  );
});

/** A page that hears every name it can, then points a script at a word. */
const LISTEN = `
  const heard = [];
  const look = (v) => { try { if (String(v).includes('alice')) heard.push(String(v)); } catch {} };
  const has = Reflect.has, get = Reflect.get, own = Reflect.getOwnPropertyDescriptor;
  const code = String.prototype.charCodeAt, charAt = String.prototype.charAt;
  Reflect.has = function (t, k) { look(k); return has(t, k); };
  Reflect.get = function (t, k, r) { look(k); return get(t, k, r); };
  Reflect.getOwnPropertyDescriptor = function (t, k) { look(k); return own(t, k); };
  String.prototype.charCodeAt = function (i) { look(this); return code.call(this, i); };
  String.prototype.charAt = function (i) { look(this); return charAt.call(this, i); };
  Object.prototype.set = function (t, k) { look(k); return true; };
  Object.prototype.has = function (t, k) { look(k); return false; };
  Object.prototype.getOwnPropertyDescriptor = function (t, k) { look(k); };
`;

test('the names a script of another origin looks up reach nothing a page replaced', async () => {
  const { logs } = await scene(
    `${LISTEN}
    window.onerror = () => true;
    let left = 2;
    for (const name of ['read', 'written']) {
      const s = document.createElement('script');
      s.src = '${OTHER}' + name + '.csv';
      s.onload = () => {
        if (!--left) console.log('heard', JSON.stringify(heard));
      };
      document.body.append(s);
    }
    `,
    {
      sources: {
        [`${OTHER}read.csv`]: 'alice_one',
        // an assignment to a name nothing declares goes up the same chain
        [`${OTHER}written.csv`]: 'alice_two = 1',
      },
    },
  );
  assert.equal(await seen(logs, 'heard'), '[]');
});

test("a proxy a page put on what the window inherits keeps another origin's script from running", async () => {
  const { logs } = await scene(
    `
    const heard = [];
    Object.setPrototypeOf(EventTarget.prototype, new Proxy(Object.create(Object.prototype), {
      has(t, k) { heard.push(String(k)); return false; },
    }));
    const s = document.createElement('script');
    s.src = '${OTHER}data.csv';
    s.onerror = () => console.log('refused', heard.filter((k) => k.includes('alice')).length);
    s.onload = () => console.log('ran', heard.filter((k) => k.includes('alice')).length);
    document.body.append(s);
    `,
    { sources: { [`${OTHER}data.csv`]: 'alice_secret' } },
  );
  assert.equal(await seen(logs, 'refused'), '0');
});

test("a module of another origin is the page's only by its leave", async () => {
  const { logs } = await scene(
    `
    import('${OTHER}closed.js').then(
      (m) => console.log('closed', m.secret),
      (e) => console.log('closed refused', e.name),
    );
    import('${OTHER}open.js').then((m) => console.log('open', m.secret));
    import('${APP}moved.js').then(
      (m) => console.log('moved', m.secret),
      (e) => console.log('moved refused', e.name),
    );
    `,
    {
      sources: {
        [`${OTHER}closed.js`]: {
          text: "export const secret = 'x'",
          headers: JS,
        },
        [`${OTHER}open.js`]: {
          text: "export const secret = 'shared'",
          headers: [...JS, ...ANY],
        },
        [`${APP}moved.js`]: {
          text: "export const secret = 'y'",
          url: `${OTHER}elsewhere.js`,
          headers: JS,
        },
      },
    },
  );
  assert.equal(await seen(logs, 'closed refused'), 'TypeError');
  assert.equal(await seen(logs, 'open'), 'shared');
  assert.equal(await seen(logs, 'moved refused'), 'TypeError');
});

test('a host that says nothing of a module of another origin has it refused', () => {
  assert.equal(
    judgeScript('x', `${OTHER}m.js`, 'https://app.test', 'anonymous', true),
    null,
  );
  assert.deepEqual(
    judgeScript('x', `${OTHER}c.js`, 'https://app.test', 'anonymous', false),
    { text: 'x', muted: true },
  );
});

test('a script with a crossorigin attribute runs only by the leave of its origin, and tells all where it has it', async () => {
  const { logs } = await scene(
    `
    window.onerror = (m) => { console.log('error', m); return true; };
    for (const name of ['closed', 'open']) {
      const s = document.createElement('script');
      s.crossOrigin = 'anonymous';
      s.src = '${OTHER}' + name + '.js';
      s.onload = () => console.log('load', name);
      s.onerror = () => console.log('failed', name);
      document.body.append(s);
    }
    `,
    {
      sources: {
        [`${OTHER}closed.js`]: { text: 'closed_name', headers: JS },
        [`${OTHER}open.js`]: { text: 'open_name', headers: [...JS, ...ANY] },
      },
    },
  );
  assert.equal(await seen(logs, 'failed'), 'closed');
  assert.match(await seen(logs, 'error'), /open_name is not defined/);
  assert.ok(!logs.join('\n').includes('closed_name'), logs.join('\n'));
});

test('what says it is no script is none, and a module has to say it is one', () => {
  const own = 'https://app.test';
  const type = (t: string): [string, string][] => [['content-type', t]];
  const loaded = (headers: [string, string][]) => ({
    text: 'x',
    url: `${own}/x`,
    headers,
  });
  const judged = (headers: [string, string][], module = false) =>
    judgeScript(loaded(headers), `${own}/x`, own, null, module);
  assert.equal(judged(type('text/csv')), null);
  assert.equal(judged(type('image/png')), null);
  assert.equal(judged(type('video/mp4')), null);
  assert.equal(
    judged([...type('text/plain'), ['x-content-type-options', 'nosniff']]),
    null,
  );
  assert.ok(judged(type('text/plain')));
  assert.ok(judged(type('application/javascript; charset=utf-8')));
  assert.equal(judged(type('text/plain'), true), null);
  assert.ok(judged(type('text/javascript'), true));
});

test('a request a preflight let through asks wherever a redirect sends it, and goes no further', async () => {
  const allow: [string, string][] = [
    ['access-control-allow-origin', 'https://app.test'],
    ['access-control-allow-methods', 'DELETE'],
    ['access-control-allow-headers', 'x-token'],
  ];
  const { logs, asked } = await scene(
    `
    fetch('${OTHER}go', { method: 'DELETE', headers: { 'x-token': '1' } }).then(
      (r) => console.log('answered', r.status),
      (e) => console.log('failed', e.message),
    );
    `,
    {
      pages: {
        [`OPTIONS ${OTHER}go`]: { headers: allow },
        [`${OTHER}go`]: redirect(`${THIRD}victim`, allow),
        [`OPTIONS ${THIRD}victim`]: { status: 403 },
        [`${THIRD}victim`]: { body: 'deleted' },
      },
    },
  );
  assert.equal(await seen(logs, 'failed'), 'Failed to fetch');
  assert.deepEqual(
    asked.map((r) => `${r.method} ${r.url}`),
    [`OPTIONS ${OTHER}go`, `DELETE ${OTHER}go`, `OPTIONS ${THIRD}victim`],
  );
});

test('a redirect of another origin is its own to let a page know of', async () => {
  const { logs, asked } = await scene(
    `
    fetch('${OTHER}moved').then(
      (r) => console.log('answered', r.url),
      (e) => console.log('failed', e.message),
    );
    `,
    {
      pages: {
        [`${OTHER}moved`]: redirect(`${THIRD}token=hunter2`),
        [`${THIRD}token=hunter2`]: { headers: ANY, body: 'x' },
      },
    },
  );
  assert.equal(await seen(logs, 'failed'), 'Failed to fetch');
  assert.equal(asked.length, 1);
});

test("a request that left the page's origin carries none of its cookies back, and is read as another's", async () => {
  const { logs, asked } = await scene(
    `
    fetch('${APP}out').then(
      (r) => console.log('answered', r.type, r.url),
      (e) => console.log('failed', e.message),
    );
    `,
    {
      pages: {
        [`${APP}out`]: redirect(`${OTHER}turn`),
        [`${OTHER}turn`]: redirect(`${APP}back`, ANY),
        [`${APP}back`]: { body: 'home', headers: ANY },
      },
    },
  );
  assert.equal(await seen(logs, 'answered'), `cors ${APP}back`);
  assert.deepEqual(
    asked.map((r) => r.credentials),
    ['include', 'omit', 'omit'],
  );
});

test("a request that passed through another origin asks the next in nobody's name", async () => {
  const { logs, asked } = await scene(
    `
    fetch('${OTHER}one').then(
      (r) => console.log('answered', r.status),
      (e) => console.log('failed', e.message),
    );
    `,
    {
      pages: {
        [`${OTHER}one`]: redirect(`${THIRD}two`, ANY),
        // a server that trusts the page's origin, asked by whoever sent this
        [`${THIRD}two`]: {
          headers: [['access-control-allow-origin', 'https://app.test']],
        },
      },
    },
  );
  assert.equal(await seen(logs, 'failed'), 'Failed to fetch');
  assert.equal(asked[0].opaqueOrigin, undefined);
  assert.equal(asked[1].opaqueOrigin, true);
});

test('fetch keeps to the redirect mode it was asked for', async () => {
  const { logs, asked } = await scene(
    `
    const go = (mode, name, at = 'r') => fetch('${APP}' + at, { redirect: mode }).then(
      (r) => console.log(name, r.type, r.status, r.url, r.body === null, r.headers.has('location')),
      (e) => console.log(name, 'failed', e.message),
    );
    go('manual', 'manual').then(() => go('error', 'error')).then(() => go('follow', 'follow'))
      // one that says nowhere is a redirect all the same to one that asked to
      // see it, or to be refused it
      .then(() => go('manual', 'nowhere manual', 'nowhere'))
      .then(() => go('error', 'nowhere error', 'nowhere'))
      .then(() => go('follow', 'nowhere follow', 'nowhere'))
      .then(() => fetch('${OTHER}r', { mode: 'no-cors', redirect: 'manual' }))
      .then(() => console.log('no-cors answered'), (e) => console.log('no-cors', e.name));
    `,
    {
      pages: {
        [`${APP}r`]: redirect(`${APP}target`),
        [`${APP}target`]: { body: 'there' },
        [`${APP}nowhere`]: { status: 302 },
      },
    },
  );
  // what it asked for, which is no more than it knew
  assert.equal(
    await seen(logs, 'manual'),
    `opaqueredirect 0 ${APP}r true false`,
  );
  assert.equal(await seen(logs, 'error'), 'failed Failed to fetch');
  assert.equal(
    await seen(logs, 'nowhere manual'),
    `opaqueredirect 0 ${APP}nowhere true false`,
  );
  assert.equal(await seen(logs, 'nowhere error'), 'failed Failed to fetch');
  assert.equal(
    await seen(logs, 'nowhere follow'),
    `basic 302 ${APP}nowhere false false`,
  );
  assert.equal(
    await seen(logs, 'follow'),
    `basic 200 ${APP}target false false`,
  );
  assert.equal(await seen(logs, 'no-cors'), 'TypeError');
  assert.ok(asked.every((r) => r.redirect === 'manual'));
});

test('a network that follows redirects itself is held to where it landed, and to redirect: error', async () => {
  const { logs } = await scene(
    `
    fetch('${APP}r').then(
      (r) => console.log('follow', r.type),
      (e) => console.log('follow failed', e.message),
    );
    fetch('${APP}r', { redirect: 'error' }).then(
      (r) => console.log('error', r.type),
      (e) => console.log('error failed', e.message),
    );
    `,
    {
      follows: true,
      pages: {
        [`${APP}r`]: redirect(`${OTHER}x`),
        [`${OTHER}x`]: { body: 'secret' },
      },
    },
  );
  assert.equal(await seen(logs, 'follow failed'), 'Failed to fetch');
  assert.equal(await seen(logs, 'error failed'), 'Failed to fetch');
});

test('what a page hands the host of a request is no way past a preflight', async () => {
  const { logs, asked } = await scene(
    `
    const real = JSON.stringify;
    JSON.stringify = function (v, ...rest) {
      if (v && v.url && v.method) v = { ...v, uaHeaders: ['x-evil'] };
      return real.call(this, v, ...rest);
    };
    fetch('${OTHER}api', { method: 'POST', headers: { 'x-evil': '1' } }).catch(() => 0);
    JSON.stringify = real;
    console.log('asked');
    `,
    {
      pages: {
        [`OPTIONS ${OTHER}api`]: { status: 403 },
        [`${OTHER}api`]: { body: 'done' },
      },
    },
  );
  await seen(logs, 'asked');
  const end = Date.now() + 500;
  while (Date.now() < end && !asked.length) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  assert.deepEqual(
    asked.map((r) => r.method),
    ['OPTIONS'],
  );
});

test('a method no page may send is sent by none, and a forged one is refused on the host', async () => {
  const { logs, asked } = await scene(
    `
    const real = JSON.stringify;
    JSON.stringify = function (v, ...rest) {
      if (v && v.url && v.method) v = { ...v, method: 'TRACE' };
      return real.call(this, v, ...rest);
    };
    fetch('${APP}x').catch((e) => console.log('refused', e.name));
    JSON.stringify = real;
    `,
    { pages: { [`${APP}x`]: { body: 'x' } } },
  );
  assert.equal(await seen(logs, 'refused'), 'TypeError');
  assert.equal(asked.length, 0);
});

test("the user agent's own headers on an EventSource are all a request may leave out of CORS", () => {
  const given: [string, string][] = [
    ['cache-control', 'no-cache'],
    ['x-evil', '1'],
    ['last-event-id', '7'],
  ];
  assert.deepEqual(
    agentHeaders(['cache-control', 'x-evil', 'last-event-id'], 'GET', given),
    ['cache-control', 'last-event-id'],
  );
  assert.equal(agentHeaders(['last-event-id'], 'POST', given), undefined);
  assert.deepEqual(
    agentHeaders(['cache-control'], 'GET', [['cache-control', 'no-cache, x']]),
    undefined,
  );
});

test('an EventSource to another origin asks no preflight: it sends what the user agent sends', async () => {
  const { logs, asked } = await scene(
    `
    const source = new EventSource('${OTHER}stream');
    source.onmessage = (e) => {
      console.log('message', e.data);
      source.close();
    };
    source.onerror = () => console.log('error', source.readyState);
    `,
    {
      pages: {
        [`${OTHER}stream`]: {
          body: 'data: hello\n\n',
          headers: [
            ['content-type', 'text/event-stream'],
            ['access-control-allow-origin', 'https://app.test'],
          ],
        },
      },
    },
  );
  assert.equal(await seen(logs, 'message'), 'hello');
  assert.deepEqual(
    asked.map((r) => r.method),
    ['GET'],
  );
  assert.equal(
    asked[0].headers.find(([k]) => k === 'cache-control')?.[1],
    'no-cache',
  );
});

test('an EventSource that CORS turns down is over, where one that lost its connection tries again', async () => {
  const { logs, asked } = await scene(
    `
    const source = new EventSource('${OTHER}stream');
    source.onerror = () => console.log('refused', source.readyState);
    const lost = new EventSource('${APP}lost');
    lost.onerror = () => {
      console.log('lost', lost.readyState);
      lost.close();
    };
    `,
    {
      pages: {
        [`${OTHER}stream`]: {
          body: 'data: hello\n\n',
          headers: [['content-type', 'text/event-stream']],
        },
        [`${APP}lost`]: {
          body: '',
          headers: [['content-type', 'text/event-stream']],
        },
      },
    },
  );
  assert.equal(await seen(logs, 'refused'), String(2));
  assert.equal(await seen(logs, 'lost'), String(0));
  assert.equal(asked.filter((r) => r.url === `${OTHER}stream`).length, 1);
});

test('what a hop owes is worked out as Fetch has it', () => {
  const hop = {
    url: `${APP}a`,
    method: 'POST',
    headers: [
      ['content-type', 'text/plain'],
      ['authorization', 'Bearer x'],
    ] as [string, string][],
    body: 'x',
  };
  const post = nextHop(hop, `${OTHER}b`, 302, 1, null);
  assert.equal(post.method, 'GET');
  assert.equal(post.body, null);
  assert.deepEqual(post.headers, []);
  const kept = nextHop(hop, '/b', 307, 1, null);
  assert.equal(kept.method, 'POST');
  assert.equal(kept.url, `${APP}b`);
  assert.equal(kept.headers.length, 2);
  assert.throws(() => nextHop(hop, 'file:///etc/passwd', 302, 1, null));
  // twenty redirects are followed, and the next is not (Fetch 4.4)
  assert.equal(nextHop(hop, '/b', 307, 19, null).url, `${APP}b`);
  assert.throws(() => nextHop(hop, '/b', 302, 20, null));
  assert.throws(() =>
    nextHop(hop, 'https://a:b@other.test/', 307, 1, {
      origin: 'https://app.test',
      tainting: false,
    }),
  );
  assert.throws(() =>
    nextHop({ ...hop, streamedBody: true }, '/b', 307, 1, null),
  );
  assert.equal(
    redirectTainted([`${APP}a`, `${OTHER}b`], 'https://app.test'),
    false,
  );
  assert.equal(
    redirectTainted([`${APP}a`, `${OTHER}b`, `${THIRD}c`], 'https://app.test'),
    true,
  );
  assert.equal(
    redirectTainted([`${OTHER}a`, `${APP}b`], 'https://app.test'),
    true,
  );
});

test('a worker runs only from its own origin, whatever the page tells the host', async () => {
  const { logs } = await scene(`
    const real = JSON.stringify;
    JSON.stringify = function (v, ...rest) {
      if (v && v.type === 'classic') v = { ...v, url: '${OTHER}w.js' };
      return real.call(this, v, ...rest);
    };
    try {
      new Worker('${APP}w.js');
      console.log('started');
    } catch (e) {
      console.log('refused', e.name);
    }
    JSON.stringify = real;
  `);
  assert.equal(await seen(logs, 'refused'), 'SecurityError');
});

const IMAGE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A document that loads `src`, and hands `code` the image once it is in. */
async function withImage(src: string, code: string): Promise<string[]> {
  const logs: string[] = [];
  await renderX11(
    h(Html, {
      source: `<!doctype html><body><img id=i src="${src}" width=1 height=1><script>
        const start = () => { const image = document.getElementById('i'); ${code} };
        const i = document.getElementById('i');
        if (i.complete) start(); else i.onload = start;
      </script></body>`,
      partial: false,
      baseUrl: APP,
      scripts: { log: (level, text) => void logs.push(`${level}: ${text}`) },
      onResource: async () => ({
        kind: 'image' as const,
        bytes: Buffer.from(IMAGE, 'base64'),
      }),
      style: { flexGrow: 1 },
    }),
    FONTS
      ? { width: 320, height: 200, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  return logs;
}

const READS = `
  const read = (name, go) => {
    try { go(); console.log(name, 'read'); } catch (e) { console.log(name, e.name); }
  };
`;

test("a canvas with another origin's image on it is no longer the page's to read, until it is made anew", async () => {
  const logs = await withImage(
    `${OTHER}p.png`,
    `${READS}
    const c = document.createElement('canvas');
    const x = c.getContext('2d');
    x.drawImage(image, 0, 0);
    read('pixels', () => x.getImageData(0, 0, 1, 1));
    read('url', () => c.toDataURL());
    read('blob', () => c.toBlob(() => {}));
    const d = document.createElement('canvas');
    d.getContext('2d').drawImage(c, 0, 0);
    read('copied', () => d.toDataURL());
    c.width = 10;
    read('again', () => x.getImageData(0, 0, 1, 1));
    `,
  );
  assert.equal(await seen(logs, 'pixels'), 'SecurityError');
  assert.equal(await seen(logs, 'url'), 'SecurityError');
  assert.equal(await seen(logs, 'blob'), 'SecurityError');
  assert.equal(await seen(logs, 'copied'), 'SecurityError');
  assert.equal(await seen(logs, 'again'), 'read');
});

test('a pattern and a bitmap carry where they came from, and creating one taints nothing', async () => {
  const logs = await withImage(
    `${OTHER}p.png`,
    `${READS}
    const c = document.createElement('canvas');
    const x = c.getContext('2d');
    const pattern = x.createPattern(image, 'repeat');
    console.log('pattern', pattern !== null);
    read('made', () => x.getImageData(0, 0, 1, 1));
    x.fillStyle = pattern;
    x.fillRect(0, 0, 1, 1);
    read('filled', () => x.getImageData(0, 0, 1, 1));
    createImageBitmap(image).then((bitmap) => {
      read('clone', () => structuredClone(bitmap));
      const d = document.createElement('canvas').getContext('2d');
      d.drawImage(bitmap, 0, 0);
      read('bitmap', () => d.getImageData(0, 0, 1, 1));
    });
    `,
  );
  assert.equal(await seen(logs, 'pattern'), 'true');
  assert.equal(await seen(logs, 'made'), 'read');
  assert.equal(await seen(logs, 'filled'), 'SecurityError');
  assert.equal(await seen(logs, 'clone'), 'DataCloneError');
  assert.equal(await seen(logs, 'bitmap'), 'SecurityError');
});

test('a pattern is of a picture there is: none of an image on its way, of no size or with no address, and a broken one or no image at all throws', async () => {
  const logs: string[] = [];
  const flat =
    '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="10"></svg>';
  await renderX11(
    h(Html, {
      source: `<!doctype html><body><img id=ok src="${APP}p.png"><img id=gone src="${APP}gone.png"><img id=flat src="${APP}flat.svg"><script>
        ${READS}
        const x = document.createElement('canvas').getContext('2d');
        const of = (name, what) => read(name, () => {
          if (x.createPattern(what, 'repeat') === null) throw { name: 'null' };
        });
        of('coming', new Image());
        // an address nothing has asked for, or it would be complete at once
        const loading = new Image();
        loading.src = '${APP}q.png';
        of('loading', loading);
        of('nothing', null);
        of('text', 'p.png');
        onload = () => {
          of('ok', document.getElementById('ok'));
          of('gone', document.getElementById('gone'));
          of('flat', document.getElementById('flat'));
          const none = document.createElement('canvas');
          none.width = 0;
          of('canvas', none);
        };
      </script></body>`,
      partial: false,
      baseUrl: APP,
      scripts: { log: (level, text) => void logs.push(`${level}: ${text}`) },
      onResource: async ({ url }: ResourceRequest) =>
        url.endsWith('gone.png')
          ? null
          : {
              kind: 'image' as const,
              bytes: url.endsWith('.svg')
                ? new TextEncoder().encode(flat)
                : Buffer.from(IMAGE, 'base64'),
            },
      style: { flexGrow: 1 },
    }),
    FONTS
      ? { width: 320, height: 200, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  assert.equal(await seen(logs, 'coming'), 'null');
  assert.equal(await seen(logs, 'loading'), 'null');
  assert.equal(await seen(logs, 'nothing'), 'TypeError');
  assert.equal(await seen(logs, 'text'), 'TypeError');
  assert.equal(await seen(logs, 'ok'), 'read');
  assert.equal(await seen(logs, 'gone'), 'InvalidStateError');
  assert.equal(await seen(logs, 'flat'), 'null');
  // a canvas of no size throws as it always has
  assert.equal(await seen(logs, 'canvas'), 'InvalidStateError');
});

test("the page's own image, and one asked for by CORS, leave a canvas its own", async () => {
  for (const src of [`${APP}p.png`, `data:image/png;base64,${IMAGE}`]) {
    const logs = await withImage(
      src,
      `${READS}
      const x = document.createElement('canvas').getContext('2d');
      x.drawImage(image, 0, 0);
      read('pixels', () => x.getImageData(0, 0, 1, 1));
      `,
    );
    assert.equal(await seen(logs, 'pixels'), 'read');
    await cleanup();
  }
});

test('an image taints a canvas by the response it came in, and one asked for by CORS is had only by the leave of its origin', async () => {
  const logs: string[] = [];
  const asked: string[] = [];
  const bytes = Buffer.from(IMAGE, 'base64');
  const ALLOW: [string, string][] = [
    ['access-control-allow-origin', 'https://app.test'],
  ];
  /** Each address, with where its answer came from and the headers it had. */
  const answers: Record<string, { url: string; headers: [string, string][] }> =
    {
      [`${OTHER}let.png`]: { url: `${OTHER}let.png`, headers: ALLOW },
      [`${OTHER}shut.png`]: { url: `${OTHER}shut.png`, headers: [] },
      [`${APP}moved.png`]: { url: `${OTHER}moved.png`, headers: [] },
      [`${OTHER}both.png`]: {
        url: `${OTHER}both.png`,
        headers: [...ALLOW, ['access-control-allow-credentials', 'true']],
      },
    };
  await renderX11(
    h(Html, {
      source: `<!doctype html><body><script>
        ${READS}
        const load = (name, src, cors) => {
          const image = new Image();
          if (cors) image.crossOrigin = cors;
          image.onerror = () => console.log(name, 'failed');
          image.onload = () => {
            const x = document.createElement('canvas').getContext('2d');
            x.drawImage(image, 0, 0);
            read(name, () => x.getImageData(0, 0, 1, 1));
          };
          image.src = src;
          return image;
        };
        console.log('reflected', load('let', '${OTHER}let.png', 'anonymous').getAttribute('crossorigin'));
        load('shut', '${OTHER}shut.png', 'anonymous');
        load('moved', '${APP}moved.png', '');
        load('plain', '${OTHER}both.png', '');
        load('cors', '${OTHER}both.png', 'use-credentials');
      </script></body>`,
      partial: false,
      baseUrl: APP,
      scripts: { log: (level, text) => void logs.push(`${level}: ${text}`) },
      onResource: async (r: ResourceRequest) => {
        asked.push(
          `${r.url} ${r.cors ? `${r.cors.origin} ${r.cors.mode}` : '-'}`,
        );
        const answer = answers[r.url];
        return answer ? { kind: 'image' as const, bytes, ...answer } : null;
      },
      style: { flexGrow: 1 },
    }),
    FONTS
      ? { width: 320, height: 200, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  assert.equal(await seen(logs, 'reflected'), 'anonymous');
  // another origin's, which said this one may have it
  assert.equal(await seen(logs, 'let'), 'read');
  // another origin's, which said nothing of it: no image at all
  assert.equal(await seen(logs, 'shut'), 'failed');
  // asked for of this origin, and answered from another
  assert.equal(await seen(logs, 'moved'), 'SecurityError');
  // one address, two requests: what an `Origin` is answered is no answer to
  // a request without one
  assert.equal(await seen(logs, 'plain'), 'SecurityError');
  assert.equal(await seen(logs, 'cors'), 'read');
  assert.deepEqual(asked.filter((a) => a.includes('both')).sort(), [
    `${OTHER}both.png -`,
    `${OTHER}both.png https://app.test use-credentials`,
  ]);
});

/** A server of its own, which is an origin of its own. */
async function server(
  handle: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close(): void }> {
  const made = createServer(handle);
  await new Promise<void>((go) => made.listen(0, '127.0.0.1', go));
  const { port } = made.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, close: () => made.close() };
}

nodeTest(
  "the network answers a redirect as it is where asked, and in nobody's name",
  async (t) => {
    const seenOrigins: (string | undefined)[] = [];
    const site = await server((req, res) => {
      seenOrigins.push(req.headers.origin);
      res.writeHead(302, { location: '/there', 'set-cookie': 'a=1' });
      res.end();
    });
    t.after(() => site.close());
    const network = new HtmlNetwork();
    const fetch = network.fetcher(site.url);
    const answer = await fetch(
      {
        url: `${site.url}here`,
        method: 'GET',
        headers: [],
        body: null,
        redirect: 'manual',
        opaqueOrigin: true,
      },
      new AbortController().signal,
    );
    assert.equal(answer.status, 302);
    assert.equal(answer.headers.find(([k]) => k === 'location')?.[1], '/there');
    assert.deepEqual(seenOrigins, ['null']);
  },
);

nodeTest(
  'a script asked for by CORS says who asks, carries no cookies across, and is kept apart',
  async (t) => {
    const heard: { origin?: string; cookie?: string }[] = [];
    const site = await server((req, res) => {
      heard.push({ origin: req.headers.origin, cookie: req.headers.cookie });
      res.writeHead(200, {
        'content-type': 'text/javascript',
        'cache-control': 'max-age=100',
        ...(req.headers.origin
          ? { 'access-control-allow-origin': req.headers.origin }
          : {}),
      });
      res.end('1');
    });
    t.after(() => site.close());
    const network = new HtmlNetwork();
    const page = 'http://app.test/';
    const element = {} as never;
    const ask = network.resources(page);
    const plain = await ask({
      url: `${site.url}x.js`,
      kind: 'script',
      element,
    });
    const cors = { origin: 'http://app.test', mode: 'anonymous' as const };
    const shared = await ask({
      url: `${site.url}x.js`,
      kind: 'script',
      element,
      cors,
    });
    assert.equal(heard.length, 2);
    assert.equal(heard[0].origin, undefined);
    assert.equal(heard[1].origin, 'http://app.test');
    assert.equal(
      (plain as { headers: [string, string][] }).headers.some(
        ([k]) => k === 'access-control-allow-origin',
      ),
      false,
    );
    assert.equal(
      (shared as { headers: [string, string][] }).headers.some(
        ([k]) => k === 'access-control-allow-origin',
      ),
      true,
    );
  },
);
