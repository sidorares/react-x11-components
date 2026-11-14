// Mixed Content: what a secure page's scripts ask an insecure URL for.

import assert from 'node:assert/strict';
import { policed, scripted } from './csp-harness.js';

scripted(
  'Mixed Content: a secure page’s fetch of an insecure URL is a TypeError and never sent, and this machine’s is not insecure',
  async () => {
    const page = await policed(
      '',
      `<script>
      var out = [];
      function tried(url) {
        // no-cors, as what is asked here is whether it is sent at all
        return fetch(url, { mode: 'no-cors' }).then(function () { return 'sent'; },
          function (e) { return e.name; });
      }
      Promise.all([tried('http://other.test/x'), tried('http://localhost/y'), tried('https://other.test/z')])
        .then(function (r) { console.log('out ' + r.join('|')); });
    </script>`,
    );
    assert.equal(await page.until('out'), 'TypeError|sent|sent');
    assert.ok(!page.sent.some((r) => r.url === 'http://other.test/x'));
    page.unmount();
  },
);
