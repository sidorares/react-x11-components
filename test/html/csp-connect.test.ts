// A WebSocket and a WebTransport session connect-src refuses, told as violations.

import assert from 'node:assert/strict';
import { LISTEN, policed, scripted } from './csp-harness.js';

scripted(
  'a WebSocket and a WebTransport session connect-src refuses are told as violations',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="connect-src 'self'">${LISTEN}`,
      `<script nonce="n">
      var ws = new WebSocket('wss://other.test/s');
      ws.onerror = function () { console.log('ws error'); };
      try { new WebTransport('https://other.test/t').ready.catch(function () {}); } catch (e) {}
      setTimeout(function () {
        console.log('seen ' + JSON.stringify(seen.map(function (s) { return [s[0], s[1]]; })));
      }, 100);
    </script>`,
    );
    assert.deepEqual(JSON.parse(await page.until('seen')), [
      ['wss://other.test/s', 'connect-src'],
      ['https://other.test/t', 'connect-src'],
    ]);
    page.unmount();
  },
);
