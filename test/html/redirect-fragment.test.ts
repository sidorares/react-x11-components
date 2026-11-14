// A navigation's fragment across its redirects (Fetch 4.4, "HTTP-redirect
// fetch", step 13), and a document scrolled to its fragment as its parse ends
// (HTML 7.4.6.4). WPT's fetch/redirect-navigate/preserve-fragment.html is the
// check.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test as nodeTest } from 'node:test';
import React from 'react';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html } from '../../src/html/index.js';
import { HtmlNetwork } from '../../src/html/network.js';
import { CookieJar } from '../../src/html/cookies.js';
import { preloadHtmlScripts } from '../../src/html/scripts/hook.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** A server whose `/r?to=…` redirects to `to`, and whose every other path
 *  answers 200. */
async function redirecting(t: { after(fn: () => void): void }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const to = url.searchParams.get('to');
    if (url.pathname === '/r' && to) {
      res.writeHead(302, { location: to });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('ok');
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

nodeTest(
  "a navigation lands at the last redirect's fragment, or keeps the one it had",
  async (t) => {
    const origin = await redirecting(t);
    const network = new HtmlNetwork({
      connectTimeout: null,
      cookies: new CookieJar(),
    });
    const signal = new AbortController().signal;
    const go = async (url: string, mode?: 'navigate') =>
      (
        await network.fetcher(`${origin}/page`)(
          {
            url,
            method: 'GET',
            headers: [],
            body: null,
            ...(mode ? { mode, destination: 'iframe' } : {}),
          },
          signal,
        )
      ).url;
    const to = (path: string) => `${origin}/r?to=${encodeURIComponent(path)}`;
    assert.equal(
      await go(`${to('/dest#fromRedirect')}#target`, 'navigate'),
      `${origin}/dest#fromRedirect`,
    );
    assert.equal(
      await go(`${to('/dest')}#target`, 'navigate'),
      `${origin}/dest#target`,
    );
    // urlA#target -> urlB#fromRedirect -> urlC
    assert.equal(
      await go(
        `${to(to('/dest').slice(origin.length) + '#fromRedirect')}#target`,
        'navigate',
      ),
      `${origin}/dest#fromRedirect`,
    );
    // a page's fetch has a response URL, which says no fragment
    assert.equal(
      await go(`${to('/dest#fromRedirect')}#target`),
      `${origin}/dest`,
    );
  },
);

test('a document navigated to a fragment is at it by its load', async () => {
  const logs: string[] = [];
  await renderX11(
    React.createElement(
      'box',
      { style: { width: 400, height: 300, overflow: 'scroll' } },
      React.createElement(Html, {
        source:
          '<!doctype html><html><head><style>body { margin: 0 } p { height: 2000px; margin: 0 }</style>' +
          "<script>onload = function () { console.log('at:' + scrollY) }</script>" +
          '</head><body><p>first</p><p id="target">target</p><p>after</p></body></html>',
        partial: false,
        baseUrl: 'https://example.test/page.html#target',
        scripts: {
          log: (level: string, text: string) => void logs.push(text),
        },
      }),
    ),
    { backend: 'mock', width: 400, height: 300 },
  );
  const end = Date.now() + 5000;
  while (!logs.some((l) => l.startsWith('at:')) && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  assert.deepEqual(logs, ['at:2000']);
});
