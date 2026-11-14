// Upgrade Insecure Requests: a document's insecure requests sent securely.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradedUrl } from '../../src/html/csp.js';
import { policed, scripted } from './csp-harness.js';

test('an insecure URL is upgraded to its secure scheme, port 80 to 443 and any other as it was', () => {
  assert.equal(upgradedUrl('http://a.test/x?y#z'), 'https://a.test/x?y#z');
  assert.equal(upgradedUrl('http://a.test:80/'), 'https://a.test/');
  assert.equal(upgradedUrl('http://a.test:8080/'), 'https://a.test:8080/');
  assert.equal(upgradedUrl('ws://a.test/s'), 'wss://a.test/s');
  for (const same of [
    'https://a.test/',
    'wss://a.test/',
    'data:,x',
    'blob:x',
  ]) {
    assert.equal(upgradedUrl(same), same);
  }
});

scripted(
  'upgrade-insecure-requests sends a document’s insecure requests securely, and a report-only policy does not',
  async () => {
    for (const [header, upgraded] of [
      ['Content-Security-Policy', true],
      ['Content-Security-Policy-Report-Only', false],
    ] as const) {
      const page = await policed(
        '',
        `<img src="http://example.test/a.png">
       <script>
         fetch('http://example.test/f').then(function () { console.log('done'); },
           function () { console.log('done'); });
       </script>`,
        [[header, 'upgrade-insecure-requests']],
      );
      await page.until('done');
      const scheme = upgraded ? 'https' : 'http';
      // not upgraded, the fetch is sent as it was, or refused as mixed
      // content from this secure page: never over https
      assert.equal(
        page.sent.some((r) => r.url === 'https://example.test/f'),
        upgraded,
        page.sent.map((r) => r.url).join(' '),
      );
      assert.ok(
        page.asked.includes(`${scheme}://example.test/a.png`),
        page.asked.join(' '),
      );
      page.unmount();
    }
  },
);
