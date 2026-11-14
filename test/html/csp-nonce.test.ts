// A script or a style whose start tag named an attribute twice is not
// nonceable (HTML, "is element nonceable").

import assert from 'node:assert/strict';
import { act } from 'react-x11/test';
import { policed, scripted } from './csp-harness.js';

scripted(
  'a script whose start tag named an attribute twice is not nonceable',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-n'">`,
      `<script attribute attribute nonce="n">console.log('ran twice-named');</script>
     <script nonce="n">console.log('ran once');</script>`,
    );
    await page.until('ran once');
    await act(() => new Promise((r) => setTimeout(r, 50)));
    assert.ok(!page.logs.includes('log: ran twice-named'));
    page.unmount();
  },
);
