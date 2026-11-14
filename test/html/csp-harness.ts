// What the tests of a document's Content Security Policy, and of the
// policies beside it, share where its scripts run: a page with headers and a
// head of its own (`policed`), what a listener is told of each violation
// (`LISTEN`), and the test that runs only where scripts are contained
// (`scripted`). `csp.test.ts` has its own copy of these, from before they
// were shared; a test of a new subject goes in a file of its own and
// imports them from here.

import { afterEach, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, cleanup, renderX11 } from 'react-x11/test';
import { Html, preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import type { FetchRequest } from '../../src/html/scripts/host.js';
import type { ResourceRequest } from '../../src/html/resources.js';

afterEach(cleanup);
await preloadHtmlScripts();
export const scripted = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

export const PAGE_URL = 'https://example.test/page.html';

/** A page with headers and a head of its own, its logs, the requests its
 *  network was asked to make, and the images it was asked for. */
export async function policed(
  head: string,
  body: string,
  headers: [string, string][] = [],
): Promise<{
  logs: string[];
  sent: FetchRequest[];
  asked: string[];
  requests: ResourceRequest[];
  until(prefix: string): Promise<string>;
  unmount(): void;
}> {
  const logs: string[] = [];
  const sent: FetchRequest[] = [];
  const asked: string[] = [];
  const requests: ResourceRequest[] = [];
  const result = await renderX11(
    React.createElement(Html, {
      source: `<!doctype html><html><head>${head}</head><body>${body}</body></html>`,
      partial: false,
      baseUrl: PAGE_URL,
      onResource: (request: ResourceRequest) => {
        asked.push(request.url);
        requests.push(request);
        return null;
      },
      scripts: {
        headers,
        log: (level: string, text: string) =>
          void logs.push(`${level}: ${text}`),
        fetch: async (request: FetchRequest) => {
          sent.push(request);
          return {
            url: request.url,
            status: 204,
            statusText: 'No Content',
            redirected: false,
            headers: [],
            body: '',
          };
        },
      },
    }),
    { backend: 'mock' },
  );
  return {
    logs,
    sent,
    asked,
    requests,
    async until(prefix) {
      const end = Date.now() + 5000;
      const found = () => logs.find((l) => l.startsWith(`log: ${prefix}`));
      while (!found() && Date.now() < end) {
        await act(() => new Promise((r) => setTimeout(r, 10)));
      }
      const line = found();
      assert.ok(line, `no "${prefix}" in:\n${logs.join('\n')}`);
      return line.slice(`log: ${prefix}`.length).trim();
    },
    unmount: () => result.unmount(),
  };
}

/** What a listener on the document is told of each violation. */
export const LISTEN = `<script nonce="n">
  window.seen = [];
  document.addEventListener('securitypolicyviolation', function (e) {
    seen.push([e.blockedURI, e.effectiveDirective, e.violatedDirective,
      e.disposition, e.target === document ? 'document' : e.target.tagName,
      e.isTrusted, e.bubbles, e.composed, e.sample, e.originalPolicy]);
  });
</script>`;
