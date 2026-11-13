// <Html scripts>' document accessors WPT's `html/dom/documents/` reads:
// `document.title` set where there is a head to put one in (HTML 3.1.3),
// `document.lastModified` (3.1.2), `DOMStringList`'s arguments, and a
// page's `:lang()` in a shadow tree.
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
    `<script>console.log("out " + JSON.stringify((function () {${code}})()));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

test('a title is set only where the document element is HTML’s and has a head', async () => {
  const out = await inPage(
    `var xml = document.implementation.createDocument(null, 'foo', null);
     xml.title = 'fail';
     var headless = document.implementation.createHTMLDocument('x');
     headless.documentElement.removeChild(headless.head);
     headless.title = 'fail';
     var empty = document.implementation.createHTMLDocument('');
     empty.head.removeChild(empty.head.firstChild);
     empty.title = '';
     var made = empty.head.lastChild;
     return [xml.title, xml.documentElement.childNodes.length, headless.title,
       made.localName, made.firstChild];`,
  );
  assert.deepEqual(out, ['', 0, '', 'title', null]);
});

test('lastModified is now, as MM/DD/YYYY hh:mm:ss in local time', async () => {
  const out = (await inPage(`return [document.lastModified, Date.now()];`)) as [
    string,
    number,
  ];
  const match = /^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d):(\d\d)$/.exec(out[0]);
  assert.ok(match, out[0]);
  const [, mm, dd, yyyy, h, m, sec] = match.map(Number);
  const when = new Date(yyyy, mm - 1, dd, h, m, sec).getTime();
  assert.ok(Math.abs(when - out[1]) < 5000, `${out[0]} is not now`);
});

test('a DOMStringList’s methods want their argument', async () => {
  const page = await scriptedPage(
    `<script>
     var open = indexedDB.open('names' + Math.random());
     open.onupgradeneeded = function () {
       var db = open.result;
       db.createObjectStore('b');
       db.createObjectStore('a');
       var list = db.objectStoreNames;
       var thrown = [];
       ['item', 'contains'].forEach(function (name) {
         try { list[name](); } catch (e) { thrown.push(e instanceof TypeError); }
       });
       console.log('out ' + JSON.stringify([String(list), thrown, list.item(0),
         list.item(-1), list.contains('b'), list.contains('')]));
     };
     </script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  assert.deepEqual(out, [
    '[object DOMStringList]',
    [true, true],
    'a',
    null,
    true,
    false,
  ]);
});

test('a :lang() query goes up from a shadow tree to its host', async () => {
  const out = await inPage(
    `var host = document.createElement('div');
     host.lang = 'en-AU';
     host.innerHTML = '<span></span>';
     document.body.append(host);
     var root = host.attachShadow({ mode: 'open' });
     root.innerHTML = '<slot></slot><b lang="fr"></b>';
     var slot = root.querySelector('slot');
     return [slot.matches(':lang(en-AU)'), slot.matches(':lang(en)'),
       host.firstChild.matches(':lang(en-AU)'),
       root.querySelector('b').matches(':lang(fr)'),
       slot.matches(':lang(fr)')];`,
  );
  assert.deepEqual(out, [true, true, true, true, false]);
});
