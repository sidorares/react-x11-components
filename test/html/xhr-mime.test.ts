// An XMLHttpRequest's final MIME type (XHR 3.6.8, over MIME Sniffing 4.4 and
// 4.5): its override parsed and serialized, else its response's, else
// `text/xml`, which a `blob` response is typed by. WPT's
// xhr/overridemimetype-blob.html is the check.
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

test("a blob response's type is the final MIME type, serialized", async () => {
  const logs: string[] = [];
  const script =
    'function blob(path, override) {' +
    '  return new Promise(function (go) {' +
    '    var x = new XMLHttpRequest(); x.open("GET", path); x.responseType = "blob";' +
    '    if (override !== undefined) x.overrideMimeType(override);' +
    '    x.onload = function () { go(x.response.type) }; x.send();' +
    '  });' +
    '}' +
    'Promise.all([' +
    '  blob("none"),' +
    '  blob("none", "TEXT/HTML;CHARSET=GBK"),' +
    '  blob("none", "text/html;x=(;charset=gbk"),' +
    '  blob("none", "bogus"),' +
    '  blob("typed"),' +
    '  blob("typed", "image/png"),' +
    ']).then(function (types) { console.log(types.join("|")) });';
  await renderX11(
    React.createElement(Html, {
      source: `<!doctype html><html><body><script>${script}</script></body></html>`,
      partial: false,
      baseUrl: 'https://example.test/page.html',
      scripts: {
        log: (level: string, text: string) =>
          void (level === 'log' && logs.push(text)),
        fetch: async (request: FetchRequest): Promise<FetchResponse> => ({
          url: request.url,
          status: 200,
          statusText: 'OK',
          redirected: false,
          headers: request.url.endsWith('typed')
            ? [['content-type', 'text/plain; charset="a b"']]
            : [],
          body: 'x',
        }),
      },
    }),
    { backend: 'mock' },
  );
  const end = Date.now() + 5000;
  while (!logs.length && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  assert.deepEqual(logs[0]?.split('|'), [
    'text/xml',
    'text/html;charset=GBK',
    'text/html;x="(";charset=gbk',
    'application/octet-stream',
    'text/plain;charset="a b"',
    'image/png',
  ]);
});
