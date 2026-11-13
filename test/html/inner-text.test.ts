// <Html scripts>' `innerText` and `outerText` (HTML 3.2.7): what an element
// draws as text, with a line break around a block, a blank line around a
// paragraph, a tab between a row's cells and nothing of what is hidden
// (`src/html/inner-text.ts`), and the setters' line breaks as `<br>`s.
// WPT's `html/dom/elements/the-innertext-and-outertext-properties/` holds
// all of it; each case here is one the first cut got wrong.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** The `innerText` of each piece of markup, put in a container one at a
 *  time, as WPT's getter test does. */
async function innerTexts(cases: string[]): Promise<string[]> {
  const page = await scriptedPage(
    `<div id="c"></div><script>
      var c = document.getElementById('c');
      var out = ${JSON.stringify(cases)}.map(function (html) {
        c.innerHTML = html;
        var t = document.getElementById('t') || c.firstElementChild;
        return t.innerText;
      });
      console.log('out ' + JSON.stringify(out));
    </script>`,
  );
  const out = JSON.parse(await page.until('out')) as string[];
  page.result.unmount();
  return out;
}

test('innerText collapses white space as it is drawn and breaks lines around blocks', async () => {
  const out = await innerTexts([
    '<div> abc  def </div>',
    '<div>abc<div>123</div>def</div>',
    '<div>abc<p>123</p>def</div>',
    '<div>abc <br> def</div>',
    '<div><span>abc </span> def</div>',
    '<div style="text-transform:uppercase">abc</div>',
  ]);
  assert.deepEqual(out, [
    'abc def',
    'abc\n123\ndef',
    'abc\n\n123\n\ndef',
    'abc\ndef',
    'abc def',
    'ABC',
  ]);
});

test('innerText leaves out what is hidden or not rendered', async () => {
  const out = await innerTexts([
    '<div>123<span style="display:none">abc</span></div>',
    '<div>123<span style="visibility:hidden">abc</span></div>',
    '<div style="visibility:hidden">123<span style="visibility:visible">abc</span></div>',
    '<div><textarea>abc</textarea></div>',
    '<div><details><summary>abc</summary>123</details></div>',
  ]);
  assert.deepEqual(out, ['123', '123', 'abc', '', 'abc']);
});

test("innerText keeps an inline-block's edges its own and the spaces beside it", async () => {
  // its own trailing space goes with its line; the ones either side of it
  // stay, as an atom's do
  const out = await innerTexts([
    '<div>abc <span style="display:inline-block">def </span> ghi</div>',
    '<div>abc <span style="display:inline-block"></span> def</div>',
    '<div>abc <input> def</div>',
  ]);
  assert.deepEqual(out, ['abc def ghi', 'abc  def', 'abc  def']);
});

test("innerText separates a table's cells with tabs and its rows with line feeds", async () => {
  const out = await innerTexts([
    '<div><table><tr><td>a<td>b<tr><td>c<td>d</table></div>',
    '<div><select><option>one<option>two</select></div>',
  ]);
  assert.deepEqual(out, ['a\tb\nc\td', 'one\ntwo']);
});

test('innerText and outerText set line breaks as <br>s', async () => {
  const page = await scriptedPage(
    `<div id="a"></div><p>x<span id="b">y</span>z</p><script>
      var a = document.getElementById('a');
      a.innerText = 'one\\r\\ntwo\\nthree\\r';
      var b = document.getElementById('b');
      var p = b.parentNode;
      b.outerText = 'Y';
      console.log('out ' + JSON.stringify([a.innerHTML, p.childNodes.length, p.textContent]));
    </script>`,
  );
  // the text either side of what outerText replaced takes it in
  assert.deepEqual(JSON.parse(await page.until('out')), [
    'one<br>two<br>three<br>',
    1,
    'xYz',
  ]);
  page.result.unmount();
});
