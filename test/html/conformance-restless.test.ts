// What the WPT runner (`scripts/conformance/testharness.tsx`) makes of a page
// that never comes to rest.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';

import { RUNNER_RUNS, runTests } from './conformance-runner.js';

const test = RUNNER_RUNS ? nodeTest : nodeTest.skip;

// `selectall-containing-textarea-and-subscript.html` of WPT's
// `editing/crashtests`: each `selectionchange` edits and so tells another,
// for as long as the page is shown, in a browser too.
const RESTLESS = `<!doctype html>
<script>
addEventListener('DOMContentLoaded', () => {
  document.designMode = 'on';
  document.onselectionchange = () => {
    document.execCommand('undo');
    document.execCommand('subscript');
    document.execCommand('delete');
  };
  document.execCommand('selectAll', false);
}, { once: true });
</script>
<body>
AAAA
<tt>
<style>
*::selection {
  background-origin: border-box, border-box;
}
</style>
</tt>
<textarea></textarea>
</body>`;

test('a page that changes in every task is shown, and leaves the pages after it their turn', async () => {
  const told = await runTests(
    ['restless.html', 'still.html', 'again.html'],
    {
      'restless.html': RESTLESS,
      'still.html': '<!doctype html><p>still</p>',
      'again.html': RESTLESS,
    },
    60000,
    { WPT_ACT_MS: '500' },
  );
  assert.deepEqual(
    told.map((o) => [o.test, o.kind, o.status]),
    [
      ['restless.html', 'crashtest', 'PASS'],
      ['still.html', 'crashtest', 'PASS'],
      ['again.html', 'crashtest', 'PASS'],
    ],
  );
});
