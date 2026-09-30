import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  mixedContent,
  Network,
  readDataUrl,
} from '../examples/browser/network.js';

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
  const network = new Network();
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
  const network = new Network();
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
  const browser = new Network();
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
