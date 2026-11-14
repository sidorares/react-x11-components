import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  determineReferrer,
  referrerPolicyOfHeaders,
  referrerPolicyOfMeta,
} from '../../src/html/referrer.js';
import { HtmlNetwork } from '../../src/html/network.js';
import type { HtmlTransport } from '../../src/html/network.js';
import React from 'react';
import { act, renderX11 } from 'react-x11/test';
import { Html } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { render } from './harness.js';

const PAGE = 'https://user:pw@a.example/dir/page?q=1#frag';

test('each policy says what it says, of the same origin, another and an insecure one', () => {
  const same = 'https://a.example/x';
  const other = 'https://b.example/x';
  const insecure = 'http://b.example/x';
  const full = 'https://a.example/dir/page?q=1';
  const origin = 'https://a.example/';
  const rows: [string, string | null, string | null, string | null][] = [
    // policy, same origin, another, an insecure one
    ['', full, origin, null],
    ['strict-origin-when-cross-origin', full, origin, null],
    ['no-referrer', null, null, null],
    ['no-referrer-when-downgrade', full, full, null],
    ['same-origin', full, null, null],
    ['origin', origin, origin, origin],
    ['strict-origin', origin, origin, null],
    ['origin-when-cross-origin', full, origin, origin],
    ['unsafe-url', full, full, full],
  ];
  for (const [policy, a, b, c] of rows) {
    const p = policy as Parameters<typeof determineReferrer>[2];
    assert.deepEqual(
      [
        determineReferrer(PAGE, same, p),
        determineReferrer(PAGE, other, p),
        determineReferrer(PAGE, insecure, p),
      ],
      [a, b, c],
      policy || '(none)',
    );
  }
  // nothing of a page that is not the web's
  assert.equal(determineReferrer('about:blank', same, 'unsafe-url'), null);
  assert.equal(determineReferrer('data:,x', same, 'unsafe-url'), null);
  // a URL past 4096 goes as its origin
  const long = `https://a.example/${'x'.repeat(5000)}`;
  assert.equal(determineReferrer(long, same, 'unsafe-url'), origin);
});

test("a header's last policy it knows is the one, and a meta's old words are read", () => {
  assert.equal(
    referrerPolicyOfHeaders([
      ['Referrer-Policy', 'no-referrer, origin'],
      ['referrer-policy', 'unsafe-url, a-policy-from-the-future'],
    ]),
    'unsafe-url',
  );
  assert.equal(referrerPolicyOfHeaders([['referrer-policy', 'nonsense']]), '');
  assert.equal(referrerPolicyOfMeta(' Never '), 'no-referrer');
  assert.equal(referrerPolicyOfMeta('always'), 'unsafe-url');
  assert.equal(
    referrerPolicyOfMeta('origin-when-crossorigin'),
    'origin-when-cross-origin',
  );
  assert.equal(referrerPolicyOfMeta('same-origin'), 'same-origin');
});

test("a resource's Referer is worked out at each hop, from what the one before came to, under a policy a redirect may change", async () => {
  const seen = new Map<string, string | undefined>();
  const routes: Record<string, [string, string?]> = {
    // same origin, then another, then home again
    'https://a.example/img': ['https://b.example/img'],
    'https://b.example/img': ['https://a.example/back'],
    // a redirect that says a policy of its own
    'https://a.example/says': ['https://a.example/after', 'no-referrer'],
  };
  const fetch: HtmlTransport = async (url, init) => {
    seen.set(url, init.headers.referer);
    const to = routes[url];
    if (to) {
      const headers: Record<string, string> = { location: to[0] };
      if (to[1]) headers['referrer-policy'] = to[1];
      return new Response(null, { status: 302, headers });
    }
    return new Response('x', { headers: { 'content-type': 'image/png' } });
  };
  const network = new HtmlNetwork({ fetch });
  const page = 'https://a.example/dir/page';
  await network.resource(
    'https://a.example/img',
    'image',
    page,
    undefined,
    undefined,
    undefined,
    {
      referrerPolicy: 'origin-when-cross-origin',
    },
  );
  assert.deepEqual(
    [
      seen.get('https://a.example/img'),
      seen.get('https://b.example/img'),
      // still the origin: the referrer is what the hop before came to
      seen.get('https://a.example/back'),
    ],
    [page, 'https://a.example/', 'https://a.example/'],
  );
  await network.resource('https://a.example/says', 'image', page);
  assert.deepEqual(
    [seen.get('https://a.example/says'), seen.get('https://a.example/after')],
    [page, undefined],
  );
});

test("a page's request sends the Referer its host worked out, and none where it said none", async () => {
  const seen = new Map<string, string | undefined>();
  const fetch: HtmlTransport = async (url, init) => {
    seen.set(url, init.headers.referer);
    return new Response('x');
  };
  const network = new HtmlNetwork({ fetch });
  const signal = new AbortController().signal;
  const page = 'https://a.example/dir/page';
  const ask = (url: string, referrer?: string | null) =>
    network.request(
      {
        url,
        method: 'GET',
        headers: [['referer', 'https://forged.example/']],
        body: null,
        ...(referrer !== undefined ? { referrer } : {}),
      },
      page,
      signal,
    );
  await ask('https://a.example/one');
  await ask('https://a.example/two', 'https://a.example/');
  await ask('https://a.example/three', null);
  assert.deepEqual(
    [
      seen.get('https://a.example/one'),
      seen.get('https://a.example/two'),
      seen.get('https://a.example/three'),
    ],
    [page, 'https://a.example/', undefined],
  );
});

test("<Html> asks for what an element loads under its referrerpolicy, else the document's: its <meta>, then its response's", async () => {
  const run = async (head: string, headers?: [string, string][]) => {
    const asked = new Map<string, string | undefined>();
    await render(
      `<html><head>${head}</head><body>` +
        '<img src="https://a.example/plain.png">' +
        '<img src="https://a.example/own.png" referrerpolicy="unsafe-url">' +
        '</body></html>',
      400,
      {
        baseUrl: 'https://a.example/',
        ...(headers ? { headers } : {}),
        onResource: (r: { url: string; referrerPolicy?: string }) => {
          asked.set(r.url, r.referrerPolicy);
          return null;
        },
      },
    );
    return [
      asked.get('https://a.example/plain.png'),
      asked.get('https://a.example/own.png'),
    ];
  };
  assert.deepEqual(await run(''), [undefined, 'unsafe-url']);
  assert.deepEqual(await run('', [['referrer-policy', 'origin']]), [
    'origin',
    'unsafe-url',
  ]);
  // a <meta> over the response's, the last that says one
  assert.deepEqual(
    await run(
      '<meta name="referrer" content="never">' +
        '<meta name="referrer" content="nonsense">',
      [['referrer-policy', 'origin']],
    ),
    ['no-referrer', 'unsafe-url'],
  );
});

(SCRIPTS_CONTAINED ? test : test.skip)(
  "what a page asks for after its script moved its address is asked as the page's address is now, which its Referer says",
  async () => {
    const asked = new Map<string, string | undefined>();
    const result = await renderX11(
      React.createElement(Html, {
        source:
          '<!doctype html><html><body><script>' +
          "history.replaceState(null, '', '/moved/here?x#y');" +
          "var i = document.createElement('img'); i.src = '/late.png';" +
          'document.body.appendChild(i);' +
          '</script></body></html>',
        partial: false,
        baseUrl: 'https://a.example/first.html',
        onResource: (r: { url: string; client?: string }) => {
          asked.set(r.url, r.client);
          return null;
        },
        scripts: {},
      }),
      { backend: 'mock' },
    );
    const end = Date.now() + 5000;
    while (!asked.has('https://a.example/late.png') && Date.now() < end) {
      await act(() => new Promise((r) => setTimeout(r, 10)));
    }
    assert.equal(
      asked.get('https://a.example/late.png'),
      'https://a.example/moved/here?x#y',
    );
    result.unmount();
  },
);
