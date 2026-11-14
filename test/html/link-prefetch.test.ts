// A <link rel=prefetch>, the document's own request, told by its load or error.

import assert from 'node:assert/strict';
import { policed, scripted } from './csp-harness.js';

scripted(
  'a <link rel=prefetch> is the document’s request, heard of by its load, and held to its policies',
  async () => {
    const page = await policed(
      '',
      `<script>
      var out = [];
      function prefetch(href) {
        return new Promise(function (done) {
          var l = document.createElement('link');
          l.rel = 'prefetch';
          l.href = href;
          l.onload = function () { done('load'); };
          l.onerror = function () { done('error'); };
          document.head.appendChild(l);
        });
      }
      Promise.all([prefetch('https://example.test/p'), prefetch('https://other.test/q')])
        .then(function (r) { console.log('out ' + [document.createElement('link').relList.supports('prefetch')].concat(r).join('|')); });
    </script>`,
      [['Content-Security-Policy', "default-src 'self' 'unsafe-inline'"]],
    );
    assert.equal(await page.until('out'), 'true|load|error');
    assert.ok(page.sent.some((r) => r.url === 'https://example.test/p'));
    assert.ok(!page.sent.some((r) => r.url === 'https://other.test/q'));
    page.unmount();
  },
);
