import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import {
  mixedContent,
  HtmlNetwork,
  HTML_USER_AGENT,
  readDataUrl,
  resourceResult,
} from '../../src/html/network.js';
import { CookieJar } from '../../src/html/cookies.js';
import type { HtmlNetworkActivity } from '../../src/html/network.js';

test('a secure page has none of its stylesheets or fonts over an insecure connection, and its images over a secure one', () => {
  // W3C Mixed Content: a stylesheet or a font is blockable, an image is
  // upgradeable. The Zen Garden's older designs import Google Fonts over
  // http from an https page, and Chrome draws them in their fallbacks
  const page = 'https://example.com/a/';
  assert.equal(
    mixedContent('http://fonts.example/css?family=X', 'stylesheet', page),
    null,
    'an insecure stylesheet is not asked for',
  );
  assert.equal(
    mixedContent('http://fonts.example/x.ttf', 'font', page),
    null,
    'nor an insecure font',
  );
  assert.equal(
    mixedContent('http://img.example/a.png', 'image', page),
    'https://img.example/a.png',
    'an insecure image is asked for over https',
  );
  assert.equal(
    mixedContent('https://fonts.example/x.ttf', 'font', page),
    'https://fonts.example/x.ttf',
    'a secure one as it is',
  );
  for (const local of [
    'http://localhost:8080/a.css',
    'http://127.0.0.1/a.css',
    'http://dev.localhost/a.css',
  ]) {
    assert.equal(
      mixedContent(local, 'stylesheet', page),
      local,
      `a loopback host is trustworthy: ${local}`,
    );
  }
  for (const insecure of ['http://example.com/', 'file:///tmp/a.html']) {
    assert.equal(
      mixedContent('http://fonts.example/css', 'stylesheet', insecure),
      'http://fonts.example/css',
      `an insecure page asks for what it names: ${insecure}`,
    );
  }
});

test("a data: URL is read as Fetch's data: URL processor reads it", () => {
  const text = (url: string) => {
    const read = readDataUrl(url);
    return read && new TextDecoder().decode(read.bytes);
  };
  // Zen Garden 215's robot: a space after the comma, which forgiving-base64
  // drops, and which Bun's fetch refused
  const svg = readDataUrl('data:image/svg+xml;base64, PHN2Zz48L3N2Zz4=');
  assert.equal(svg?.type, 'image/svg+xml');
  assert.equal(new TextDecoder().decode(svg?.bytes), '<svg></svg>');
  assert.equal(
    text('data:image/svg+xml;BASE64,PHN2Zz48%0AL3N2Zz4'),
    '<svg></svg>',
    'white space anywhere in it, and no padding',
  );
  assert.equal(
    readDataUrl('data:image/png;base64,PH$N'),
    null,
    'a body that is not base64 is none',
  );
  const html = readDataUrl(
    'data:text/html;charset=UTF-8,%3Cp%3Eh%C3%AF%3C/p%3E',
  );
  assert.equal(html?.type, 'text/html');
  assert.equal(html?.charset, 'utf-8');
  assert.equal(new TextDecoder().decode(html?.bytes), '<p>hï</p>');
  assert.equal(text('data:text/plain,a#b'), 'a', 'a fragment is no body');
  const plain = readDataUrl('data:,Hello');
  assert.deepEqual(
    [plain?.type, plain?.charset],
    ['text/plain', 'us-ascii'],
    'no type is text/plain in US-ASCII',
  );
  assert.equal(readDataUrl('data:;charset=utf-8,x')?.type, 'text/plain');
  assert.equal(readDataUrl('data:nonsense,x')?.type, 'text/plain');
  assert.equal(readDataUrl('data:text/plain'), null, 'no comma, no body');
  assert.equal(readDataUrl('https://example.com/,x'), null);
});

test('the network reads a data: URL itself, for a resource and a page', async () => {
  const network = new HtmlNetwork();
  const real = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('asked the network'));
  try {
    const image = await network.resource(
      'data:image/svg+xml;base64, PHN2Zz48L3N2Zz4=',
      'image',
      'https://example.com/',
    );
    assert.equal(new TextDecoder().decode(image?.bytes), '<svg></svg>');
    const page = await network.document(
      'data:text/html,%3Cp%3Ehi',
      new AbortController().signal,
    );
    assert.equal(page.type, 'text/html');
    const chunks: Uint8Array[] = [];
    for await (const chunk of page.body) chunks.push(chunk);
    assert.equal(new TextDecoder().decode(chunks[0]), '<p>hi');
  } finally {
    globalThis.fetch = real;
  }
});

/** A response whose head came and whose body stopped partway: what a fetch
 *  sees when its timeout runs out while the body is still arriving. */
function cutShort(head: string): Response {
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    // the first chunk, and the timeout at the read after it: a head asked
    // for and let go of is a 200 like any other
    pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(new TextEncoder().encode(head));
        return;
      }
      controller.error(
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError',
        ),
      );
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/css' },
  });
}

test('the network says why a resource came back as nothing: not asked for, answered, or never answered', async (t) => {
  const site = 'https://site.example';
  const page = `${site}/blog`;
  t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    const url = String(input);
    if (url === `${site}/a.css`) {
      return new Response('a{}', {
        status: 200,
        headers: { 'content-type': 'text/css' },
      });
    }
    if (url === `${site}/gone.css`) return new Response('', { status: 404 });
    if (url === `${site}/busy.css`) return new Response('', { status: 503 });
    if (url === `${site}/cut.css`) return cutShort('a{');
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${url}`), {
        code: 'ENOTFOUND',
      }),
    });
  });
  const network = new HtmlNetwork();
  const why = async (url: string, signal?: AbortSignal) => {
    const loaded = await network.load(url, 'stylesheet', page, signal);
    if ('fetched' in loaded) {
      return new TextDecoder().decode(loaded.fetched.bytes);
    }
    if ('status' in loaded) return loaded.status;
    return 'refused' in loaded ? 'refused' : 'failed';
  };
  assert.equal(await why(`${site}/a.css`), 'a{}');
  assert.equal(await why(`${site}/gone.css`), 404, 'a server that has none');
  assert.equal(await why(`${site}/busy.css`), 503, 'a server that is busy');
  assert.equal(
    await why(`${site}/cut.css`),
    'failed',
    'a 200 whose body never all came is no answer, not a file of no kind',
  );
  assert.equal(await why('https://nowhere.example/a.css'), 'failed');
  const gone = new AbortController();
  gone.abort();
  assert.equal(
    await why(`${site}/a2.css`, gone.signal),
    'failed',
    'nor is a request whose page went away before it was made',
  );
  for (const url of [
    'http://site.example/a.css',
    'file:///etc/passwd',
    'ftp://site.example/a.css',
    'data:text/css;base64,YS$b',
  ]) {
    assert.equal(await why(url), 'refused', `not asked for: ${url}`);
  }

  // and a page is told what it always was: the body, or nothing
  const browser = new HtmlNetwork();
  const text = async (url: string) => {
    const fetched = await browser.resource(url, 'stylesheet', page);
    return fetched && new TextDecoder().decode(fetched.bytes);
  };
  assert.equal(await text(`${site}/a.css`), 'a{}');
  for (const url of [
    `${site}/gone.css`,
    `${site}/busy.css`,
    `${site}/cut.css`,
    'https://nowhere.example/a.css',
    'http://site.example/a.css',
  ]) {
    assert.equal(await text(url), null, `nothing for ${url}`);
  }
});

test('a sheet served as anything but CSS is no sheet, and a page where an image was asked for is a document', () => {
  const fetched = (type: string) => ({
    url: 'https://x.test/a',
    status: 200,
    type,
    charset: null,
    bytes: new Uint8Array([60, 112, 62]),
  });
  // Acid3 links a page served as text/html, which must not style it
  assert.equal(resourceResult(fetched('text/html'), 'stylesheet'), null);
  assert.equal(
    resourceResult(fetched('text/css'), 'stylesheet')?.kind,
    'stylesheet',
  );
  assert.equal(
    resourceResult(fetched(''), 'stylesheet')?.kind,
    'stylesheet',
    'a server that names no type is believed',
  );
  // an `<object>` of a page shows it, and not what it holds
  assert.deepEqual(resourceResult(fetched('text/html'), 'image'), {
    kind: 'document',
  });
  assert.equal(resourceResult(fetched('image/png'), 'image')?.kind, 'image');
  assert.equal(
    resourceResult(fetched('application/octet-stream'), 'image')?.kind,
    'image',
    'an image a server mislabels is still read as one',
  );
});

test("a page's request hands its body on as it arrives where it asks to, and sends bytes as bytes", async () => {
  const page = 'https://site.example/app';
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let cancelled = 0;
  const sent: {
    url: string;
    body: unknown;
    headers: Record<string, string>;
  }[] = [];
  const network = new HtmlNetwork({
    fetch: async (url, init) => {
      sent.push({ url, body: init.body, headers: init.headers });
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          controller.enqueue(new TextEncoder().encode('one '));
          await held;
          controller.enqueue(new TextEncoder().encode('two'));
          controller.close();
        },
        cancel() {
          cancelled += 1;
        },
      });
      return new Response(body, { status: 200 });
    },
  });
  const fetch = network.fetcher(page);
  const signal = new AbortController().signal;
  const streamed = await fetch(
    {
      url: `${page}/s`,
      method: 'POST',
      headers: [['range', 'bytes=0-1']],
      body: '',
      bytes: new Uint8Array([0, 255]),
      stream: true,
    },
    signal,
  );
  assert.ok(streamed.chunks, 'a body to read as it arrives');
  assert.equal(streamed.body, '');
  assert.deepEqual([...(sent[0].body as Uint8Array)], [0, 255]);
  const it = streamed.chunks[Symbol.asyncIterator]();
  const first = await it.next();
  assert.equal(new TextDecoder().decode(first.value), 'one ');
  release();
  const second = await it.next();
  assert.equal(new TextDecoder().decode(second.value), 'two');
  assert.equal((await it.next()).done, true);

  // one let go unread lets its connection go
  const dropped = await fetch(
    { url: `${page}/d`, method: 'GET', headers: [], body: null, stream: true },
    signal,
  );
  await dropped.chunks![Symbol.asyncIterator]().return!();
  assert.equal(cancelled, 1);

  // and one that does not ask is answered whole, as before
  const whole = await fetch(
    { url: `${page}/w`, method: 'GET', headers: [], body: null },
    signal,
  );
  assert.equal(whole.chunks, undefined);
  assert.equal(whole.body, 'one two');
});

test("a page's stream body is sent once: a 421 is its answer, where Node's fetch sends bytes again on a new connection", async (t) => {
  // HTTP/2's 421 Misdirected Request asks for the request on another
  // connection, and Fetch has a browser send it again where the body has a
  // source to be sent from — and a stream has none: WPT's
  // fetch/api/basic/request-upload.h2.any.js
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push(
        `${req.url} ${req.headers['content-length']} ${Buffer.concat(chunks)}`,
      );
      res.writeHead(421, { 'content-type': 'text/plain' });
      res.end(`sent ${seen.length}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetch = new HtmlNetwork({ connectTimeout: null }).fetcher(
    `${origin}/page`,
  );
  const signal = new AbortController().signal;
  const post = (path: string, body: string, streamedBody: boolean) =>
    fetch(
      {
        url: `${origin}${path}`,
        method: 'POST',
        headers: [],
        body,
        ...(streamedBody ? { streamedBody } : {}),
      },
      signal,
    );

  const streamed = await post('/stream', 'Test', true);
  assert.deepEqual([streamed.status, streamed.body], [421, 'sent 1']);
  // with its length, as its bytes went
  assert.deepEqual(seen, ['/stream 4 Test']);
  seen.length = 0;
  const empty = await post('/empty', '', true);
  assert.equal(empty.status, 421);
  assert.deepEqual(seen, ['/empty 0 ']);

  // the same bytes from a string are sent again, as Fetch lets them be
  seen.length = 0;
  const replayed = await post('/string', 'Test', false);
  assert.deepEqual([replayed.status, replayed.body], [421, 'sent 2']);
  assert.deepEqual(seen, ['/string 4 Test', '/string 4 Test']);
});

/** A site that logs in by cookie, as most do: a form POSTed to `/login`
 *  answers a 303 that sets the session, `/home` says whose it is, and every
 *  request is noted with the cookies it carried. */
async function cookieSite(t: { after(fn: () => void): void }) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push(`${req.method} ${url.pathname} ${req.headers.cookie ?? '-'}`);
    if (url.pathname === '/login') {
      res.writeHead(303, {
        location: '/home',
        'set-cookie': [
          'session=alice; Path=/; HttpOnly; SameSite=Lax',
          'theme=dark; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
        ],
      });
      res.end();
      return;
    }
    if (url.pathname === '/hop') {
      res.writeHead(302, {
        location: url.searchParams.get('to') ?? '/home',
        'set-cookie': 'hopped=1; Path=/',
      });
      res.end();
      return;
    }
    if (url.pathname === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    }
    const who = /session=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    res.writeHead(200, {
      'content-type': 'text/plain',
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-credentials': 'true',
    });
    res.end(who ? `hello ${who}` : 'who are you?');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
  };
}

async function readText(body: AsyncIterable<Uint8Array>): Promise<string> {
  let text = '';
  for await (const chunk of body) text += Buffer.from(chunk).toString();
  return text;
}

test('with a jar, a login’s cookies are kept from its redirect and sent on every request after', async (t) => {
  const { origin, seen } = await cookieSite(t);
  const jar = new CookieJar();
  const network = new HtmlNetwork({ connectTimeout: null, cookies: jar });
  const signal = new AbortController().signal;
  const home = await network.document(`${origin}/login`, signal, {
    body: 'user=alice',
    contentType: 'application/x-www-form-urlencoded',
    from: `${origin}/form`,
  });
  assert.equal(home.url, `${origin}/home`, 'the 303 is followed');
  assert.equal(home.redirected, true);
  assert.equal(await readText(home.body), 'hello alice');
  assert.deepEqual(seen, [
    'POST /login -',
    // the session set on the 303 goes with the GET it turned into
    'GET /home session=alice; theme=dark',
  ]);
  // a subresource, and a page's own fetch, carry it too
  seen.length = 0;
  const image = await network.load(
    `${origin}/a.png`,
    'image',
    `${origin}/home`,
  );
  assert.ok('fetched' in image);
  const fetched = await network.fetcher(`${origin}/home`)(
    { url: `${origin}/api`, method: 'GET', headers: [], body: null },
    signal,
  );
  assert.equal(fetched.body, 'hello alice');
  assert.deepEqual(seen, [
    'GET /a.png session=alice; theme=dark',
    'GET /api session=alice; theme=dark',
  ]);
  assert.equal(network.cookies, jar);
});

test('a page’s fetch carries cookies as its credentials mode says, and a redirect’s Set-Cookie is kept', async (t) => {
  const { origin, seen } = await cookieSite(t);
  const jar = new CookieJar();
  const network = new HtmlNetwork({ connectTimeout: null, cookies: jar });
  const signal = new AbortController().signal;
  await readText(
    (await network.document(`${origin}/hop?to=/home`, signal)).body,
  );
  assert.deepEqual(seen, ['GET /hop -', 'GET /home hopped=1']);
  seen.length = 0;
  const fetch = network.fetcher(`${origin}/page`);
  const ask = (credentials: 'omit' | 'same-origin' | 'include', page = fetch) =>
    page(
      {
        url: `${origin}/api`,
        method: 'GET',
        headers: [],
        body: null,
        credentials,
      },
      signal,
    );
  await ask('omit');
  await ask('same-origin');
  // from another origin's page: `same-origin` sends none, `include` all
  const other = network.fetcher('http://other.test/page');
  await ask('same-origin', other);
  await ask('include', other);
  assert.deepEqual(seen, [
    'GET /api -',
    'GET /api hopped=1',
    'GET /api -',
    'GET /api hopped=1',
  ]);
  // a page may not set its own Cookie header
  seen.length = 0;
  await fetch(
    {
      url: `${origin}/api`,
      method: 'GET',
      headers: [['cookie', 'forged=1']],
      body: null,
    },
    signal,
  );
  assert.deepEqual(seen, ['GET /api hopped=1']);
});

test("a frame's request carries the frame's Origin and Referer, and its own origin's cookies, under the page's site", async (t) => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/set') {
      res.writeHead(200, { 'set-cookie': 'id=1; Path=/' });
      res.end();
      return;
    }
    seen.push(
      [req.headers.origin, req.headers.referer, req.headers.cookie ?? '-'].join(
        ' ',
      ),
    );
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const network = new HtmlNetwork({
    connectTimeout: null,
    cookies: new CookieJar(),
  });
  const signal = new AbortController().signal;
  await readText((await network.document(`${origin}/set`, signal)).body);
  // the page is another site's, and a frame on the server's origin is in it
  const fetch = network.fetcher('http://page.test/inbox');
  const ask = (client?: string) =>
    fetch(
      {
        url: `${origin}/api`,
        method: 'GET',
        headers: [],
        body: null,
        credentials: 'same-origin',
        ...(client ? { client } : {}),
      },
      signal,
    );
  await ask();
  await ask(`${origin}/frame?x=1#top`);
  assert.deepEqual(seen, [
    'http://page.test http://page.test/ -',
    `${origin} ${origin}/frame?x=1 id=1`,
  ]);
});

test('a body that keeps arriving is read to its end however long it takes, and one that stops arriving is given up', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/css' });
    // a chunk every 60 ms for half a second, past a bound of 200 ms in all;
    // or a first chunk, and then nothing for 400 ms
    const stalls = req.url === '/stalls.css';
    let sent = 0;
    const next = (): void => {
      if (res.destroyed) return;
      res.write(`a${sent}{}`);
      sent += 1;
      if (sent === 8) res.end();
      else setTimeout(next, stalls ? 400 : 60);
    };
    next();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const network = new HtmlNetwork({ connectTimeout: null, timeout: 200 });
  const page = `${origin}/page`;
  const css = async (path: string) => {
    const loaded = await network.load(`${origin}${path}`, 'stylesheet', page);
    return 'fetched' in loaded
      ? new TextDecoder().decode(loaded.fetched.bytes)
      : 'failed' in loaded
        ? 'failed'
        : loaded;
  };
  const whole = 'a0{}a1{}a2{}a3{}a4{}a5{}a6{}a7{}';
  assert.equal(await css('/slow.css'), whole, 'a slow resource');
  assert.equal(await css('/stalls.css'), 'failed', 'a stalled resource');
  const signal = new AbortController().signal;
  const document = await network.document(`${origin}/slow2.css`, signal);
  assert.equal(await readText(document.body), whole, 'a slow document');
  const stalled = await network.document(`${origin}/stalls.css`, signal);
  await assert.rejects(readText(stalled.body), 'a stalled document');
});

test('a redirect followed by the network: a loop ends, and a POST’s 302 is a GET', async (t) => {
  const { origin } = await cookieSite(t);
  const network = new HtmlNetwork({
    connectTimeout: null,
    cookies: new CookieJar(),
  });
  const signal = new AbortController().signal;
  await assert.rejects(
    network.fetcher(`${origin}/page`)(
      { url: `${origin}/loop`, method: 'GET', headers: [], body: null },
      signal,
    ),
    /too many redirects/,
  );
  const answer = await network.fetcher(`${origin}/page`)(
    {
      url: `${origin}/hop?to=/echo`,
      method: 'POST',
      headers: [['content-type', 'text/plain']],
      body: 'x',
    },
    signal,
  );
  assert.equal(answer.status, 200);
  assert.equal(answer.redirected, true);
  assert.equal(answer.url, `${origin}/echo`);
});

test('a network with no jar keeps no cookies and leaves redirects to the transport', async () => {
  const asked: string[] = [];
  const network = new HtmlNetwork({
    fetch: async (url, init) => {
      asked.push(`${init.redirect} ${init.headers.cookie ?? '-'}`);
      return {
        url,
        status: 200,
        statusText: 'OK',
        redirected: false,
        headers: new Headers({ 'set-cookie': 'a=1' }),
        body: null,
      };
    },
  });
  const signal = new AbortController().signal;
  await network.fetcher('https://example.test/')(
    { url: 'https://example.test/a', method: 'GET', headers: [], body: null },
    signal,
  );
  await network.fetcher('https://example.test/')(
    { url: 'https://example.test/b', method: 'GET', headers: [], body: null },
    signal,
  );
  assert.deepEqual(asked, ['follow -', 'follow -']);
  assert.equal(network.cookies, null);
});

test('a Strict cookie stays home from a link on another site, and goes with one typed', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/set') {
      res.writeHead(200, {
        'set-cookie': ['strict=1; SameSite=Strict', 'lax=1; SameSite=Lax'],
      });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.headers.cookie ?? '-');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const network = new HtmlNetwork({
    connectTimeout: null,
    cookies: new CookieJar(),
  });
  const signal = new AbortController().signal;
  const go = async (initiator: string | null) =>
    readText(
      (await network.document(`${origin}/page`, signal, null, { initiator }))
        .body,
    );
  await readText((await network.document(`${origin}/set`, signal)).body);
  assert.equal(await go(null), 'strict=1; lax=1', 'typed, or a bookmark');
  assert.equal(
    await go(`${origin}/elsewhere`),
    'strict=1; lax=1',
    'a link of its own',
  );
  assert.equal(
    await go('https://news.example/'),
    'lax=1',
    'a link from another site',
  );
});

test('the User-Agent can be set, and the next request carries the new one', async (t) => {
  // A host that lets a reader switch agents (the example browser's menu)
  // sets it on the running network; the next request sends it, where before
  // the agent was fixed at construction. An empty string falls back to the
  // default, so unsetting it is not a blank header.
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers['user-agent'] ?? '-');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<p>ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const network = new HtmlNetwork({ connectTimeout: null });
  const signal = new AbortController().signal;

  assert.equal(network.userAgent, HTML_USER_AGENT, 'the default to begin');
  await network.document(`${origin}/a`, signal);

  network.userAgent =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  assert.equal(network.userAgent.includes('Chrome/141'), true, 'the new one');
  await network.document(`${origin}/b`, signal);

  network.userAgent = '';
  assert.equal(network.userAgent, HTML_USER_AGENT, 'empty is the default');
  await network.document(`${origin}/c`, signal);

  assert.deepEqual(
    seen.map((ua) => (ua.includes('Chrome/141') ? 'chrome' : 'default')),
    ['default', 'chrome', 'default'],
    'each request carried the agent set at the time',
  );
});

test('an observer is told of each request as it goes: a resource, the same from memory, a document and a page fetch', async () => {
  const page = 'https://example.test/page.html';
  const network = new HtmlNetwork({
    connectTimeout: null,
    fetch: async (url, init) => {
      if (url.endsWith('/style.css')) {
        return new Response('p { color: red }', {
          status: 200,
          headers: {
            'content-type': 'text/css',
            'cache-control': 'max-age=60',
          },
        });
      }
      if (url.endsWith('/api')) {
        return new Response(JSON.stringify({ method: init.method }), {
          status: 201,
          statusText: 'Created',
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('<p>hi</p>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const told: HtmlNetworkActivity[] = [];
  const stop = network.observe((activity) => told.push(activity));
  const of = (id: number) => told.filter((a) => a.id === id).map((a) => a.type);
  const body = (id: number) =>
    new TextDecoder().decode(
      concatBytes(
        told.flatMap((a) =>
          a.id === id && a.type === 'data' ? [a.chunk] : [],
        ),
      ),
    );

  await network.resource(`https://example.test/style.css`, 'stylesheet', page);
  const css = told.find((a) => a.type === 'request')!;
  assert.equal(css.type === 'request' && css.kind, 'stylesheet');
  assert.deepEqual(of(css.id), ['request', 'sent', 'response', 'data', 'end']);
  assert.equal(body(css.id), 'p { color: red }');

  // asked again, it is answered from memory with nothing sent
  await network.resource(`https://example.test/style.css`, 'stylesheet', page);
  await new Promise((r) => setTimeout(r, 0));
  const again = told.filter((a) => a.type === 'request')[1];
  assert.deepEqual(of(again.id), ['request', 'response', 'data', 'end']);
  const cached = told.find((a) => a.id === again.id && a.type === 'response');
  assert.equal(cached?.type === 'response' && cached.cache, 'memory');

  // a document is told as its body is read, and ends when it is
  const doc = await network.document(page, new AbortController().signal);
  let text = '';
  for await (const chunk of doc.body) text += new TextDecoder().decode(chunk);
  const nav = told.filter((a) => a.type === 'request')[2];
  assert.equal(nav.type === 'request' && nav.kind, 'document');
  assert.deepEqual(of(nav.id), ['request', 'sent', 'response', 'data', 'end']);
  assert.equal(body(nav.id), text);

  // and a page's fetch, its method, body and status
  await network.fetcher(page)(
    {
      url: 'https://example.test/api',
      method: 'POST',
      headers: [['content-type', 'text/plain']],
      body: 'ping',
    },
    new AbortController().signal,
  );
  const api = told.filter((a) => a.type === 'request')[3];
  assert.ok(api.type === 'request');
  assert.equal(api.kind, 'fetch');
  assert.equal(api.method, 'POST');
  assert.equal(api.body, 'ping');
  const answer = told.find((a) => a.id === api.id && a.type === 'response');
  assert.ok(answer?.type === 'response');
  assert.equal(answer.status, 201);
  assert.equal(answer.statusText, 'Created');
  assert.equal(body(api.id), '{"method":"POST"}');

  // stopped, it is told nothing more
  stop();
  const before = told.length;
  await network.resource(`https://example.test/style.css`, 'stylesheet', page);
  assert.equal(told.length, before);
});

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
