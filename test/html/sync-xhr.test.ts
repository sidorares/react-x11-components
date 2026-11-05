// A synchronous `XMLHttpRequest`: the page's thread sleeps while another makes
// the request (`src/html/scripts/sync-fetch.ts`), and a worker's thread sleeps
// while the page's network does (`workers.ts`). The server is on a thread of
// its own, since on this one it would sleep with the page.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { Worker } from 'node:worker_threads';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { CookieJar } from '../../src/html/cookies.js';
import { Html, preloadHtmlScripts } from '../../src/html/index.js';
import { HtmlNetwork } from '../../src/html/network.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const SERVER = `
const { parentPort } = require('node:worker_threads');
const http = require('node:http');
const seen = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ method: req.method, path: url.pathname, headers: req.headers, body });
    const cors = { 'access-control-allow-origin': req.headers.origin ?? '*' };
    switch (url.pathname) {
      case '/seen':
        res.writeHead(200, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify(seen.slice(0, -1)));
        return;
      case '/text':
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...cors });
        res.end('hello');
        return;
      case '/slow':
        setTimeout(() => {
          res.writeHead(200, cors);
          res.end('late');
        }, Number(url.searchParams.get('ms')));
        return;
      case '/redirect':
        res.writeHead(302, {
          location: '/text',
          'set-cookie': 'hop=1; Path=/',
          ...cors,
        });
        res.end();
        return;
      case '/cookie':
        res.writeHead(200, { 'set-cookie': 'made=yes; Path=/', ...cors });
        res.end(req.headers.cookie ?? 'none');
        return;
      case '/closed':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('no cors');
        return;
      case '/who':
        res.writeHead(200, {
          ...cors,
          'access-control-allow-credentials': 'true',
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ origin: req.headers.origin ?? '', cookie: req.headers.cookie ?? '' }));
        return;
      case '/frame':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<!doctype html><script>' +
            'function ask(credentials) {' +
            '  var x = new XMLHttpRequest(); x.open("GET", "/who", false);' +
            '  x.withCredentials = credentials; x.send(); return x.responseText;' +
            '}' +
            'parent.postMessage([ask(false), ask(true), String(self.origin)].join("|"), "*");' +
            '</script>',
        );
        return;
      case '/hop': {
        const open = !url.searchParams.has('closed');
        const allow = open
          ? {
              ...cors,
              'access-control-allow-methods': 'PUT',
              'access-control-allow-headers': 'x-custom',
            }
          : {};
        if (req.method === 'OPTIONS') {
          res.writeHead(204, allow);
          res.end();
          return;
        }
        res.writeHead(307, { ...allow, location: url.searchParams.get('to') });
        res.end();
        return;
      }
      case '/refuses':
        res.writeHead(req.method === 'OPTIONS' ? 204 : 200);
        res.end('refused');
        return;
      case '/preflight':
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            ...cors,
            'access-control-allow-methods': 'PUT',
            'access-control-allow-headers': 'x-custom',
          });
          res.end();
          return;
        }
        res.writeHead(200, cors);
        res.end(req.method + ' ' + body);
        return;
    }
    res.writeHead(404, cors);
    res.end('none');
  });
});
server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
parentPort.on('message', () => server.close(() => process.exit(0)));
`;

async function server(t: { after(fn: () => void): void }): Promise<string> {
  const thread = new Worker(SERVER, { eval: true });
  t.after(() => {
    void thread.terminate();
  });
  const port = await new Promise<number>((resolve) =>
    thread.once('message', resolve),
  );
  return `http://127.0.0.1:${port}`;
}

const LOG =
  'function log() { console.log([].slice.call(arguments).join("|")); }' +
  'function get(url) { var x = new XMLHttpRequest(); x.open("GET", url, false); x.send(); return x; }';

/** A page whose scripts run on `network`, and what it logged. */
async function page(
  script: string,
  options: {
    url: string;
    network?: HtmlNetwork;
    sync?: boolean;
    timeout?: number;
    body?: string;
  },
): Promise<{ until(prefix: string, ms?: number): Promise<string> }> {
  const logs: string[] = [];
  const network = options.network ?? new HtmlNetwork();
  await renderX11(
    h(Html, {
      source: `<!doctype html><html><body>${options.body ?? ''}<script>${script}</script></body></html>`,
      partial: false,
      baseUrl: options.url,
      scripts: {
        fetch: network.fetcher(options.url),
        ...(network.cookies && { cookies: network.cookies }),
        ...(options.sync !== false && { syncNetwork: network.syncNetwork() }),
        ...(options.timeout && { timeout: options.timeout }),
        log: (level: string, text: string) =>
          void logs.push(`${level}: ${text}`),
      },
    }),
    FONTS ? { width: 200, height: 100, fonts: FONTS } : { backend: 'mock' },
  );
  return {
    async until(prefix, ms = 8000) {
      const end = Date.now() + ms;
      const found = () => logs.find((l) => l.startsWith(`log: ${prefix}`));
      while (!found() && Date.now() < end) {
        await act(() => new Promise((r) => setTimeout(r, 10)));
      }
      const line = found();
      assert.ok(line, `no "${prefix}" in:\n${logs.join('\n')}`);
      return line.slice(`log: ${prefix}`.length);
    },
  };
}

test('a synchronous request answers before send() returns, with DONE and no event between', async (t) => {
  const url = await server(t);
  const p = await page(
    LOG +
      'var events = []; var x = new XMLHttpRequest();' +
      '["loadstart", "progress", "load", "loadend", "readystatechange"].forEach(function (e) { x.addEventListener(e, function () { events.push(e + x.readyState); }); });' +
      `x.open("GET", "${url}/text", false); events.push("opened" + x.readyState); x.send();` +
      'log("done", x.readyState, x.status, x.responseText, x.getResponseHeader("content-type"), x.responseURL.slice(-5));' +
      'log("events", events.join(","));',
    { url: `${url}/page.html` },
  );
  assert.equal(
    await p.until('done|'),
    `4|200|hello|text/plain; charset=utf-8|/text`,
  );
  assert.equal(
    await p.until('events|'),
    'readystatechange1,opened1,readystatechange4,load4,loadend4',
  );
});

test('a host with no way to make one keeps the error a page always had', async (t) => {
  const url = await server(t);
  const p = await page(
    LOG +
      'try { new XMLHttpRequest().open("GET", "/text", false); log("no", "opened"); }' +
      'catch (e) { log("no", e.name); }',
    { url: `${url}/page.html`, sync: false },
  );
  assert.equal(await p.until('no|'), 'InvalidAccessError');
});

test('a network whose transport is the host’s function cannot be had on a thread', () => {
  const network = new HtmlNetwork({
    fetch: () => Promise.reject(new Error('no')),
  });
  assert.equal(network.syncNetwork(), null);
});

test('a document may not ask for a timeout or a response type, and a request that fails throws', async (t) => {
  const url = await server(t);
  const p = await page(
    LOG +
      'function name(fn) { try { fn(); return "none"; } catch (e) { return e.name; } }' +
      'var a = new XMLHttpRequest(); a.timeout = 5;' +
      `log("open", name(function () { a.open("GET", "/text", false); }));` +
      'var b = new XMLHttpRequest(); b.open("GET", "/text", false);' +
      'log("set", name(function () { b.timeout = 5; }), name(function () { b.responseType = "json"; }));' +
      'var c = new XMLHttpRequest(); var heard = 0; c.onerror = c.onloadend = function () { heard += 1; };' +
      'c.open("GET", "http://127.0.0.1:1/", false);' +
      'log("failed", name(function () { c.send(); }), c.readyState, c.status, heard);',
    { url: `${url}/page.html` },
  );
  assert.equal(await p.until('open|'), 'InvalidAccessError');
  assert.equal(await p.until('set|'), 'InvalidAccessError|InvalidAccessError');
  assert.equal(await p.until('failed|'), 'NetworkError|4|0|0');
});

test('cookies go with it, follow its redirects and are the jar’s when it returns', async (t) => {
  const url = await server(t);
  const jar = new CookieJar();
  jar.store(`${url}/`, ['sid=abc; Path=/'], { http: true, sameSite: true });
  const network = new HtmlNetwork({ cookies: jar, userAgent: 'TestAgent/1' });
  const p = await page(
    LOG +
      `log("sent", get("${url}/cookie").responseText);` +
      'log("kept", document.cookie);' +
      `log("hop", get("${url}/redirect").responseText, document.cookie);` +
      `log("after", get("${url}/cookie").responseText);`,
    { url: `${url}/page.html`, network },
  );
  assert.equal(await p.until('sent|'), 'sid=abc');
  assert.equal(await p.until('kept|'), 'sid=abc; made=yes');
  assert.equal(await p.until('hop|'), 'hello|sid=abc; made=yes; hop=1');
  assert.equal(await p.until('after|'), 'sid=abc; made=yes; hop=1');
  assert.deepEqual(
    jar
      .all()
      .map((c) => c.name)
      .sort(),
    ['hop', 'made', 'sid'],
  );
});

test('the network’s own headers go with it, and a body as a page wrote it', async (t) => {
  const url = await server(t);
  const network = new HtmlNetwork({ userAgent: 'TestAgent/1' });
  const p = await page(
    LOG +
      'var x = new XMLHttpRequest(); x.open("POST", "/text", false);' +
      'x.setRequestHeader("x-page", "1"); x.send("bytes é");' +
      'var seen = JSON.parse(get("/seen").responseText)[0];' +
      'log("seen", seen.method, seen.body, seen.headers["user-agent"], seen.headers["x-page"], seen.headers["content-type"], seen.headers.origin);',
    { url: `${url}/page.html`, network },
  );
  assert.equal(
    await p.until('seen|'),
    `POST|bytes é|TestAgent/1|1|text/plain;charset=UTF-8|${url}`,
  );
});

test('CORS holds as it does for any request: a preflight first, and a response that says nothing is no response', async (t) => {
  const here = await server(t);
  const there = (await server(t)).replace('127.0.0.1', 'localhost');
  const p = await page(
    LOG +
      'function name(fn) { try { fn(); return "none"; } catch (e) { return e.name; } }' +
      `var c = new XMLHttpRequest(); c.open("GET", "${there}/closed", false);` +
      'log("closed", name(function () { c.send(); }), c.status);' +
      `var x = new XMLHttpRequest(); x.open("PUT", "${there}/preflight", false);` +
      'x.setRequestHeader("x-custom", "1"); x.send("up");' +
      'log("put", x.status, x.responseText);' +
      `var y = new XMLHttpRequest(); y.open("PUT", "${there}/preflight", false);` +
      'y.setRequestHeader("x-custom", "1"); y.send("again");' +
      `var seen = JSON.parse(get("${there}/seen").responseText).map(function (s) { return s.method; });` +
      'log("seen", seen.join(","));' +
      `var z = new XMLHttpRequest(); z.open("DELETE", "${there}/preflight", false);` +
      'log("refused", name(function () { z.send(); }));',
    { url: `${here}/page.html` },
  );
  assert.equal(await p.until('closed|'), 'NetworkError|0');
  assert.equal(await p.until('put|'), '200|PUT up');
  // what a preflight said is kept
  assert.equal(await p.until('seen|'), 'GET,OPTIONS,PUT,PUT');
  assert.equal(await p.until('refused|'), 'NetworkError');
});

test('a redirect is asked about at every hop: another preflight where it lands, and nothing sent where it is not let through', async (t) => {
  const here = await server(t);
  const first = (await server(t)).replace('127.0.0.1', 'localhost');
  const second = await server(t);
  const p = await page(
    LOG +
      'function name(fn) { try { fn(); return "none"; } catch (e) { return e.name; } }' +
      'function put(url) { var x = new XMLHttpRequest(); x.open("PUT", url, false); x.setRequestHeader("x-custom", "1"); x.send("up"); return x; }' +
      `var hopped = put("${first}/hop?to=${second}/preflight");` +
      'log("hopped", hopped.status, hopped.responseText);' +
      `var heard = JSON.parse(get("${second}/seen").responseText);` +
      'log("heard", heard.map(function (s) { return s.method + " " + s.path + " " + s.headers.origin; }).join(","));' +
      `log("refused", name(function () { put("${first}/hop?to=${second}/refuses"); }));` +
      `var refused = JSON.parse(get("${second}/seen").responseText).filter(function (s) { return s.path === "/refuses"; });` +
      'log("then", refused.map(function (s) { return s.method; }).join(","));' +
      `log("closed", name(function () { get("${first}/hop?closed=1&to=${second}/text"); }));` +
      `var landed = JSON.parse(get("${second}/seen").responseText).filter(function (s) { return s.path === "/text"; });` +
      'log("reached", landed.length);',
    { url: `${here}/page.html` },
  );
  assert.equal(await p.until('hopped|'), '200|PUT up');
  // the first origin's preflight says nothing of the second, and a page's
  // origin is no longer who is asking there
  assert.equal(
    await p.until('heard|'),
    'OPTIONS /preflight null,PUT /preflight null',
  );
  assert.equal(await p.until('refused|'), 'NetworkError');
  assert.equal(await p.until('then|'), 'OPTIONS');
  assert.equal(await p.until('closed|'), 'NetworkError');
  assert.equal(await p.until('reached|'), '0');
});

test('a sandboxed frame’s request is of no origin, and carries none of its address’s cookies', async (t) => {
  const url = await server(t);
  const jar = new CookieJar();
  jar.store(`${url}/`, ['sid=abc; Path=/; SameSite=Lax'], {
    http: true,
    sameSite: true,
  });
  const network = new HtmlNetwork({ cookies: jar });
  const p = await page(
    LOG +
      `var own = get("/who").responseText;` +
      'log("page", own);' +
      'addEventListener("message", function (e) { log("frame", e.data); });',
    {
      url: `${url}/page.html`,
      network,
      body: '<iframe sandbox="allow-scripts" src="/frame"></iframe>',
    },
  );
  // the same request from the page itself, so that what follows says
  // something: a GET of its own origin has no `Origin` (Fetch 3.1), and
  // carries its cookies
  assert.equal(await p.until('page|'), '{"origin":"","cookie":"sid=abc"}');
  const none = '{"origin":"null","cookie":""}';
  assert.equal(await p.until('frame|'), `${none}|${none}|null`);
});

test('a request that takes too long fails before the watchdog would cut the task, and the page goes on', async (t) => {
  const url = await server(t);
  // the watchdog is five times this, and counts the sleep
  const p = await page(
    LOG +
      'var x = new XMLHttpRequest(); x.open("GET", "/slow?ms=4000", false);' +
      'var began = Date.now();' +
      'try { x.send(); log("sent", "answered"); } catch (e) { log("sent", e.name, Date.now() - began < 2000); }' +
      'log("after", document.title === "", new XMLHttpRequest().readyState);',
    { url: `${url}/page.html`, timeout: 200 },
  );
  assert.equal(await p.until('sent|'), 'TimeoutError|true');
  // its ops are not refused: the wait left it a task to go on in
  assert.equal(await p.until('after|'), 'true|0');
});

/** How long a test waits on a worker, whose thread loads the engine. */
const WORKER_MS = 30000;

test('a worker’s synchronous request is the page’s network’s, and its own `timeout` holds', async (t) => {
  const url = await server(t);
  const jar = new CookieJar();
  jar.store(`${url}/`, ['sid=abc; Path=/'], { http: true, sameSite: true });
  const network = new HtmlNetwork({ cookies: jar });
  const worker =
    `var x = new XMLHttpRequest(); x.open("GET", "${url}/cookie", false); x.send();` +
    `var y = new XMLHttpRequest(); y.open("GET", "${url}/slow?ms=2000", false); y.timeout = 50;` +
    'var failed = "none"; try { y.send(); } catch (e) { failed = e.name; }' +
    `var z = new XMLHttpRequest(); z.responseType = "text"; z.open("GET", "${url}/text", false); z.send();` +
    'postMessage([x.responseText, failed, z.responseText].join("|"));';
  const p = await page(
    LOG +
      `var w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker).replace(/</g, '\\u003c')}], { type: "text/javascript" })));` +
      'w.onmessage = function (e) { log("worker", e.data); };' +
      'w.onerror = function (e) { log("worker", "error", e.message); };',
    { url: `${url}/page.html`, network, sync: false },
  );
  // a worker's thread loads the engine afresh, which a busy runner takes
  // seconds over
  assert.equal(
    await p.until('worker|', WORKER_MS),
    'sid=abc|TimeoutError|hello',
  );
  assert.ok(jar.all().some((c) => c.name === 'made'));
});

test('a worker reads past the late answer of a request its timeout gave up on, however soon the next answer comes', async (t) => {
  const url = await server(t);
  const network = new HtmlNetwork();
  // each request given up on is answered as it is let go, a moment before
  // the next one is: read alone, that answer left the next unread
  const worker =
    'var out = [];' +
    'for (var i = 0; i < 6; i++) {' +
    `  var y = new XMLHttpRequest(); y.open("GET", "${url}/slow?ms=150", false); y.timeout = 5;` +
    '  try { y.send(); out.push("late"); } catch (e) { out.push(e.name === "TimeoutError" ? "t" : e.name); }' +
    `  var z = new XMLHttpRequest(); z.open("GET", "${url}/text", false);` +
    '  try { z.send(); out.push(z.responseText === "hello" ? "z" : "?"); } catch (e) { out.push(e.name); }' +
    '}' +
    'postMessage(out.join(""));';
  const p = await page(
    LOG +
      `var w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker).replace(/</g, '\\u003c')}], { type: "text/javascript" })));` +
      'w.onmessage = function (e) { log("worker", e.data); };' +
      'w.onerror = function (e) { log("worker", "error", e.message); };',
    { url: `${url}/page.html`, network, sync: false },
  );
  assert.equal(await p.until('worker|', WORKER_MS), 'tz'.repeat(6));
});

test('overrideMimeType says what a synchronous response is decoded with, and a data: URL needs no network', async (t) => {
  const url = await server(t);
  const p = await page(
    LOG +
      'var x = new XMLHttpRequest(); x.open("GET", "data:text/plain,caf%C3%A9", false); x.send();' +
      'log("data", x.status, x.responseText);',
    { url: `${url}/page.html` },
  );
  assert.equal(await p.until('data|'), '200|café');
});
