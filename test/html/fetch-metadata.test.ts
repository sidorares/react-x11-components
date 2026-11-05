import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  metadataHeaders,
  plainSite,
  trustworthy,
} from '../../src/html/fetch-metadata.js';
import { HtmlNetwork } from '../../src/html/network.js';
import type { HtmlTransport } from '../../src/html/network.js';

const PAGE = 'https://a.example/page';

test('Sec-Fetch-Site is reckoned over every URL on the way, and none goes to an insecure URL', () => {
  const fetch = {
    mode: 'cors' as const,
    destination: '',
    origin: 'https://a.example',
  };
  assert.deepEqual(metadataHeaders('https://a.example/x', fetch, []), {
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  });
  assert.equal(
    metadataHeaders('https://www.a.example/x', fetch, [])['sec-fetch-site'],
    'same-site',
  );
  assert.equal(
    metadataHeaders('https://b.example/x', fetch, [])['sec-fetch-site'],
    'cross-site',
  );
  // back home after leaving the site is still a request that left it
  assert.equal(
    metadataHeaders('https://a.example/x', fetch, ['https://b.example/r'])[
      'sec-fetch-site'
    ],
    'cross-site',
  );
  assert.equal(
    metadataHeaders('https://a.example/x', fetch, ['https://www.a.example/r'])[
      'sec-fetch-site'
    ],
    'same-site',
  );
  // a site is its scheme too
  assert.equal(
    metadataHeaders(
      'https://a.example/x',
      { ...fetch, origin: 'http://a.example' },
      [],
    )['sec-fetch-site'],
    'cross-site',
  );
  // an opaque origin is the same as nothing
  assert.equal(
    metadataHeaders('https://a.example/x', { ...fetch, origin: 'null' }, [])[
      'sec-fetch-site'
    ],
    'cross-site',
  );
  assert.deepEqual(metadataHeaders('http://a.example/x', fetch, []), {});
  assert.ok(trustworthy('http://127.0.0.1:8/'));
  assert.ok(trustworthy('http://app.localhost/'));
  assert.ok(!trustworthy('http://a.example/'));
  assert.equal(plainSite('wss://x.y.example:9/'), 'https://y.example');
});

test("a navigation the user made is no site's, and says the user made it", () => {
  const headers = metadataHeaders(
    'https://a.example/',
    { mode: 'navigate', destination: 'document', origin: null, user: true },
    [],
  );
  assert.deepEqual(headers, {
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
  });
  // only a navigation says so
  assert.equal(
    metadataHeaders(
      'https://a.example/',
      {
        mode: 'cors',
        destination: '',
        origin: 'https://a.example',
        user: true,
      },
      [],
    )['sec-fetch-user'],
    undefined,
  );
});

/** A network over a transport that answers from `routes` and notes what each
 *  request carried. */
function recording(routes: Record<string, string>): {
  network: HtmlNetwork;
  seen: Map<string, Record<string, string>>;
} {
  const seen = new Map<string, Record<string, string>>();
  const fetch: HtmlTransport = async (url, init) => {
    seen.set(url, { ...init.headers });
    const to = routes[url];
    if (to) {
      return new Response(null, { status: 302, headers: { location: to } });
    }
    return new Response('x', { headers: { 'content-type': 'image/png' } });
  };
  return { network: new HtmlNetwork({ fetch }), seen };
}

test('each hop of a resource says what it is for, and a redirect off the site or to insecure ground changes what it says', async () => {
  const { network, seen } = recording({
    'https://a.example/img': 'https://b.example/img',
    'https://b.example/img': 'http://a.example/img',
  });
  await network.resource('https://a.example/img', 'image', PAGE);
  assert.deepEqual(
    {
      dest: seen.get('https://a.example/img')!['sec-fetch-dest'],
      mode: seen.get('https://a.example/img')!['sec-fetch-mode'],
      site: seen.get('https://a.example/img')!['sec-fetch-site'],
    },
    { dest: 'image', mode: 'no-cors', site: 'same-origin' },
  );
  assert.equal(
    seen.get('https://b.example/img')!['sec-fetch-site'],
    'cross-site',
  );
  const insecure = seen.get('http://a.example/img')!;
  assert.equal(
    Object.keys(insecure).some((k) => k.startsWith('sec-fetch-')),
    false,
    'an insecure URL hears none of it',
  );
});

test("a font is asked for by CORS whoever serves it, and a page's request says what the page made it as", async () => {
  const { network, seen } = recording({});
  await network.resource('https://a.example/f.woff2', 'font', PAGE);
  assert.equal(
    seen.get('https://a.example/f.woff2')!['sec-fetch-mode'],
    'cors',
  );
  assert.equal(
    seen.get('https://a.example/f.woff2')!['sec-fetch-dest'],
    'font',
  );

  await network.request(
    {
      url: 'https://www.a.example/w.js',
      method: 'GET',
      headers: [],
      body: null,
      mode: 'same-origin',
      destination: 'worker',
      // the host followed a redirect from another site here
      through: ['https://b.example/r'],
    },
    PAGE,
    new AbortController().signal,
  );
  const worker = seen.get('https://www.a.example/w.js')!;
  assert.deepEqual(
    [
      worker['sec-fetch-dest'],
      worker['sec-fetch-mode'],
      worker['sec-fetch-site'],
    ],
    ['worker', 'same-origin', 'cross-site'],
  );

  await network.request(
    { url: 'https://a.example/api', method: 'GET', headers: [], body: null },
    PAGE,
    new AbortController().signal,
  );
  const api = seen.get('https://a.example/api')!;
  assert.deepEqual(
    [api['sec-fetch-dest'], api['sec-fetch-mode'], api['sec-fetch-site']],
    ['empty', 'cors', 'same-origin'],
  );
  // what a page writes is no metadata of the browser's
  await network.request(
    {
      url: 'https://a.example/forged',
      method: 'GET',
      headers: [['sec-fetch-site', 'same-origin']],
      body: null,
    },
    'https://b.example/',
    new AbortController().signal,
  );
  assert.equal(
    seen.get('https://a.example/forged')!['sec-fetch-site'],
    'cross-site',
  );
});

test('a document the browser navigated to is no site’s, and one a page navigated to is reckoned from it', async () => {
  const { network, seen } = recording({});
  const signal = new AbortController().signal;
  await network.document('https://a.example/one', signal);
  const typed = seen.get('https://a.example/one')!;
  assert.deepEqual(
    [typed['sec-fetch-site'], typed['sec-fetch-user'], typed['sec-fetch-dest']],
    ['none', '?1', 'document'],
  );
  await network.document('https://a.example/two', signal, null, {
    initiator: 'https://b.example/',
  });
  const linked = seen.get('https://a.example/two')!;
  assert.deepEqual(
    [
      linked['sec-fetch-site'],
      linked['sec-fetch-user'],
      linked['sec-fetch-mode'],
    ],
    ['cross-site', undefined, 'navigate'],
  );
});

test('a request a redirect through another origin tainted is still of its origin for Sec-Fetch-Site', async () => {
  const { network, seen } = recording({});
  await network.request(
    {
      url: 'https://a.example/back',
      method: 'GET',
      headers: [],
      body: null,
      mode: 'no-cors',
      // `Origin: null` from here on, as Fetch has it
      opaqueOrigin: true,
      origin: 'https://a.example',
      through: ['https://a.example/x', 'https://www.a.example/r'],
    },
    PAGE,
    new AbortController().signal,
  );
  const back = seen.get('https://a.example/back')!;
  assert.equal(back.origin, 'null');
  assert.equal(back['sec-fetch-site'], 'same-site');
  assert.equal(back['sec-fetch-mode'], 'no-cors');
});
