// <Html scripts>' join of two blocks of other white space, as Chromium and
// Gecko join them (WPT's `editing/other/join-different-white-space-style-*`):
// the second block's first line alone moves, in a `<span>` that keeps its
// white space, where the editing specification's reference moves all of
// it. A `<pre>`'s white space stays its element's, as `editing/run` has it.
// And the selection's boundary checks and `selectAllChildren` (Selection API).
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
     /** A join by delete with the caret at the start of the second
      *  block's first text, as Backspace there joins them. */
     function join(html) {
       host.innerHTML = html;
       var text = host.querySelector('[data-at]');
       var at = text.firstChild;
       while (at && at.nodeType != 3) at = at.firstChild;
       getSelection().collapse(at, 0);
       document.execCommand('delete');
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

test('a block of other white space gives up its first line, in a span that keeps it', async () => {
  const out = await inPage(
    `return [
       join('<div>abc</div><div data-at style="white-space:pre">def\\nghi</div>'),
       join('<div>abc</div><div data-at style="white-space:pre-wrap">def<br>ghi</div>'),
       join('<div>abc</div><div data-at style="white-space:pre"><b>def\\nghi</b></div>'),
       join('<div>abc</div><div data-at style="white-space:pre">def</div>'),
     ];`,
  );
  assert.deepEqual(out, [
    '<div>abc<span style="white-space:pre">def</span></div><div data-at="" style="white-space:pre">ghi</div>',
    '<div>abc<span style="white-space:pre-wrap">def</span></div><div data-at="" style="white-space:pre-wrap">ghi</div>',
    '<div>abc<span style="white-space:pre"><b>def</b></span></div><div data-at="" style="white-space:pre"><b>ghi</b></div>',
    '<div>abc<span style="white-space:pre">def</span></div>',
  ]);
});

test('blocks of one white space, and a <pre>, join as the reference joins them', async () => {
  const out = await inPage(
    `return [
       join('<div>abc</div><div data-at>def<br>ghi</div>'),
       join('<div>abc</div><pre data-at>def</pre>'),
     ];`,
  );
  assert.deepEqual(out, ['<div>abcdef<br>ghi</div>', '<div>abcdef</div>']);
});

test('a selection’s offset in a processing instruction counts its data, and selectAllChildren its children', async () => {
  const out = await inPage(
    `var pi = document.createProcessingInstruction('t', 'abcd');
     host.append(pi);
     var s = getSelection();
     s.collapse(pi, 3);
     var at = s.focusOffset;
     var t = document.createTextNode('xyz');
     host.append(t);
     s.selectAllChildren(t);
     return [at, s.anchorOffset, s.focusOffset];`,
  );
  assert.deepEqual(out, [3, 0, 0]);
});
