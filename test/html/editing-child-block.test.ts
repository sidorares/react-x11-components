// <Html scripts>' delete of a selection that ends in a block inside the one
// it starts in (WPT's `editing/other/delete-without-unwrapping-first-line-of-child-block`):
// what it held is deleted and the block is left whole, the caret at its
// start, where the editing specification's reference joined the block's
// first line to the line before it. A selection that holds nothing before
// the block still joins the two, as a Backspace there would.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** What a function of the page's comes to, through JSON. */
async function inPage(code: string): Promise<unknown> {
  const page = await scriptedPage(
    `<div id="host" contenteditable></div><script>
     var host = document.getElementById('host');
     /** host's markup with a selection from its child at \`from\` to the
      *  child block's text at \`to\`, deleted, then "X" typed. */
     function run(html, from, to, command) {
       host.innerHTML = html;
       var text = document.getElementById('child').firstChild;
       var range = document.createRange();
       range.setStart(host, from);
       range.setEnd(text, to);
       getSelection().removeAllRanges();
       getSelection().addRange(range);
       document.execCommand(command);
       document.execCommand('insertText', false, 'X');
       return host.innerHTML;
     }
     var out;
     try { out = (function () {${code}})(); } catch (e) { out = 'threw ' + e; }
     console.log('out ' + JSON.stringify(out));
     </script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

const html = 'abc<br><br><div id="child">def<br>ghi</div>';

test('a selection into a child block deletes what it held and leaves the block whole', async () => {
  const out = await inPage(
    `return [run('${html}', 2, 0, 'delete'), run('${html}', 2, 1, 'forwardDelete')];`,
  );
  assert.deepEqual(out, [
    'abc<br><div id="child">Xdef<br>ghi</div>',
    'abc<br><div id="child">Xef<br>ghi</div>',
  ]);
});
