// <Html scripts>' editing commands in a focused text field, as Chromium has
// them (WPT's tentative `editing/other/exec-command-with-text-editor`):
// `undo` and `redo` are the field's own history, which a value a script
// sets forgets; `insertHTML` inserts the markup's text; a single-line field
// breaks no line; and the document's settings stay the document's.
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
    `<input id="f"><div contenteditable><input id="g"></div><script>
     var f = document.getElementById('f');
     var at = function (field, value, from, to) {
       field.value = value;
       field.focus();
       field.setSelectionRange(from, to);
     };
     var out;
     try { out = (function () {${code}})(); } catch (e) { out = 'threw ' + e; }
     console.log('out ' + JSON.stringify(out));
     </script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

test('a field undoes and redoes what its commands did, and a value set forgets it', async () => {
  const out = await inPage(
    `var types = [];
     f.addEventListener('beforeinput', function () { types.push('before'); });
     f.addEventListener('input', function (e) { types.push(e.inputType); });
     at(f, 'abc', 1, 2);
     var none = document.queryCommandEnabled('undo');
     document.execCommand('delete');
     var deleted = f.value;
     var undone = document.execCommand('undo');
     var back = [f.value, f.selectionStart, f.selectionEnd];
     document.execCommand('redo');
     var again = f.value;
     f.value = 'xyz';
     return [none, deleted, undone, back, again,
       document.queryCommandEnabled('undo'), types];`,
  );
  assert.deepEqual(out, [
    false,
    'ac',
    true,
    ['abc', 1, 2],
    'ac',
    false,
    ['deleteContentBackward', 'historyUndo', 'historyRedo'],
  ]);
});

test('insertHTML inserts text, and a single-line field breaks no line', async () => {
  const out = await inPage(
    `at(f, 'abc', 1, 2);
     var html = document.execCommand('insertHTML', false, '<b>in</b>');
     var inserted = f.value;
     var line = [document.queryCommandEnabled('insertParagraph'),
       document.execCommand('insertLineBreak'), f.value];
     return [html, inserted, line];`,
  );
  assert.deepEqual(out, [true, 'ainc', [false, false, 'ainc']]);
});

test('the document’s settings are its own, set from a field only in an editing host', async () => {
  const out = await inPage(
    `at(f, 'abc', 1, 1);
     var outside = [document.queryCommandEnabled('defaultParagraphSeparator'),
       document.execCommand('defaultParagraphSeparator', false, 'p'),
       document.queryCommandValue('defaultParagraphSeparator')];
     at(document.getElementById('g'), 'abc', 1, 1);
     var inside = [document.execCommand('defaultParagraphSeparator', false, 'p'),
       document.queryCommandValue('defaultParagraphSeparator')];
     return [outside, inside];`,
  );
  assert.deepEqual(out, [
    [false, false, 'div'],
    [true, 'p'],
  ]);
});
