// <Html scripts>' insertParagraph where what a paragraph is split from is
// laid out inline, as Chromium has it (WPT's tentative
// `editing/other/insertparagraph-with-white-space-style`): an editing host
// laid out inline takes a line break, or a line feed where its white space
// keeps one, and a <div> or a <p> laid out inline is a part of a line,
// which is wrapped in a <div> and split, the element with it.
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
     var out;
     try { out = (function () {${code}})(); } catch (e) { out = 'threw ' + e; }
     console.log('out ' + JSON.stringify(out));
     </script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}
test('a paragraph in a host laid out inline is a line break, and one in an inline <div> splits it', async () => {
  const out = await inPage(
    `var at = function (html, where) {
       host.innerHTML = html;
       var text = host.querySelector('[data-at]') || host;
       while (text.firstChild) text = text.firstChild;
       getSelection().collapse(text, where);
       document.execCommand('insertParagraph');
       return host.innerHTML;
     };
     host.style.cssText = 'display:inline; white-space:pre';
     var inline = at('abc', 1);
     host.style.cssText = '';
     return [inline,
       at('<div data-at style="display:inline">abc</div>', 1),
       at('<p data-at style="display:inline-block">abc</p>', 1)];`,
  );
  assert.deepEqual(out, [
    'a\nbc',
    '<div><div data-at="" style="display:inline">a</div></div><div><div data-at="" style="display:inline">bc</div></div>',
    '<div><p data-at="" style="display:inline-block">a</p></div><div><p data-at="" style="display:inline-block">bc</p></div>',
  ]);
});
