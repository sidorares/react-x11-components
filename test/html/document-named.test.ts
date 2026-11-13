// <Html scripts>' document named properties (HTML 3.1.5): `document.foo`
// for an `<img name=foo>`, a `<form>`, an `<embed>`, an `<object>` or an
// `<iframe>`, which WPT's `html/dom/documents/dom-tree-accessors/nameditem-*`
// hold a page to. A document is a proxy for them, made where its wrapper is.
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
async function inPage(body: string, code: string): Promise<unknown> {
  const page = await scriptedPage(
    `${body}<script>console.log("out " + JSON.stringify((function () {${code}})()));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

test('a named img, form, embed and object are the document’s, by name', async () => {
  const out = await inPage(
    `<img name="pic" id="picId"><form name="f"></form><embed name="e">
     <object name="o" id="oid"></object><img id="justId"><div name="d"></div>`,
    `var q = function (s) { return document.querySelector(s); };
     return [
       document.pic === q('img'), document.picId === q('img'),
       document.f === q('form'), document.e === q('embed'),
       document.o === q('object'), document.oid === q('object'),
       document.justId, document.d, 'pic' in document, 'justId' in document,
       Object.getOwnPropertyNames(document).filter(function (n) {
         return ['pic', 'picId', 'f', 'e', 'o', 'oid'].indexOf(n) >= 0;
       }),
       Object.keys(document).indexOf('pic'),
     ];`,
  );
  assert.deepEqual(out, [
    true,
    true,
    true,
    true,
    true,
    true,
    null,
    null,
    true,
    false,
    ['picId', 'pic', 'f', 'e', 'oid', 'o'],
    -1,
  ]);
});

test('several elements of a name are one live collection, in tree order', async () => {
  const out = await inPage(
    `<div id="p"></div>`,
    `var p = document.getElementById('p');
     var a = document.createElement('img'), b = document.createElement('img');
     a.name = 'twice'; b.name = 'twice';
     p.append(a, b);
     var list = document.twice;
     var first = [String(list), list.length, list[0] === a, list[1] === b];
     p.prepend(b);
     var moved = [document.twice === list, list[0] === b, list[1] === a];
     b.name = 'other';
     return [first, moved, document.twice === a, document.other === b];`,
  );
  assert.deepEqual(out, [
    ['[object HTMLCollection]', 2, true, true],
    [true, true, true],
    true,
    true,
  ]);
});

test('a name follows the element into and out of a shadow tree', async () => {
  const out = await inPage(
    `<div id="host"></div>`,
    `var root = document.getElementById('host').attachShadow({ mode: 'open' });
     var form = document.createElement('form');
     form.name = 'moving';
     document.body.append(form);
     var a = document.moving === form;
     root.append(form);
     var b = document.moving;
     document.body.append(form);
     return [a, b === undefined, document.moving === form];`,
  );
  assert.deepEqual(out, [true, true, true]);
});

test('a name shadows none of the document’s members', async () => {
  const out = await inPage(
    `<img name="forms"><img name="constructor"><img name="firstChild">`,
    `return [
       document.forms instanceof HTMLCollection,
       typeof document.constructor,
       document.firstChild instanceof DocumentType,
       Object.getPrototypeOf(document) === HTMLDocument.prototype,
       Object.getOwnPropertyNames(document).indexOf('forms'),
     ];`,
  );
  assert.deepEqual(out, [true, 'function', true, true, -1]);
});

test('an iframe alone is its window', async () => {
  const out = await inPage(
    `<iframe name="fr"></iframe>`,
    `var frame = document.querySelector('iframe');
     return [document.fr === frame.contentWindow, document.fr === frame];`,
  );
  assert.deepEqual(out, [true, false]);
});
