// A frame whose document could not be had (HTML 7.4.2.3.3, a network error):
// an error page of no origin, which the page cannot reach into, and a `load`
// all the same, as Chromium has it. WPT's fetch/h1-parsing is the check.
import { afterEach, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html } from '../../src/html/index.js';
import { preloadHtmlScripts } from '../../src/html/scripts/hook.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import type {
  FetchRequest,
  FetchResponse,
} from '../../src/html/scripts/host.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

test('a frame whose response is a network error loads an error page the page cannot reach', async () => {
  const logs: string[] = [];
  await renderX11(
    React.createElement(Html, {
      source:
        '<!doctype html><html><body><script>' +
        "var f = document.createElement('iframe');" +
        "f.onload = function () { console.log('load:' + (f.contentDocument === null)) };" +
        "f.src = 'broken.html'; document.body.appendChild(f);" +
        "var g = document.createElement('iframe');" +
        "g.onload = function () { console.log('ok:' + (g.contentDocument !== null)) };" +
        "g.src = 'fine.html'; document.body.appendChild(g);" +
        '</script></body></html>',
      partial: false,
      baseUrl: 'https://example.test/page.html',
      scripts: {
        log: (level: string, text: string) => void logs.push(text),
        fetch: async (request: FetchRequest): Promise<FetchResponse> => {
          // what the runtime throws for a response no parser reads
          if (request.url.endsWith('broken.html')) {
            throw new TypeError('fetch failed');
          }
          return {
            url: request.url,
            status: 200,
            statusText: 'OK',
            redirected: false,
            headers: [['content-type', 'text/html']],
            body: '<p>fine</p>',
          };
        },
      },
    }),
    { backend: 'mock' },
  );
  const end = Date.now() + 5000;
  while (logs.length < 2 && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  assert.deepEqual(logs.sort(), ['load:true', 'ok:true']);
});
