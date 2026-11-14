// <Html scripts>' DOM as WPT's `dom/` holds a page to it: `DOMTokenList`
// (DOM 7.1), Node's constants and a disconnected node's position (4.4),
// one mutation record a replacement (4.2.3), a range over a processing
// instruction (5.5), `attachShadow` on what is no HTML element (4.9), a
// made document's URL (4.5), and a copy of a customized built-in.
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
    `<div id="box"></div><script>
     var out;
     try { out = (function () {${code}})(); } catch (e) { out = 'threw ' + e; }
     console.log('out ' + JSON.stringify(out));
     </script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

const name = (f: string): string =>
  `(function () { try { ${f}; return 'none'; } catch (e) { return e.name; } })()`;

test('a class list is an ordered set of the attribute’s tokens', async () => {
  const out = await inPage(
    `var el = document.createElement('p');
     el.setAttribute('class', ' a b  a ');
     var list = el.classList;
     var read = [list.length, list[0], list[1], list[2], list.value,
       Object.keys(list), Array.from(list.entries())];
     list.add('c');
     var added = el.getAttribute('class');
     var bare = document.createElement('p');
     bare.classList.remove('x');
     var errors = [${name("list.add('')")}, ${name("list.add('a b')")},
       ${name("list.replace('a', '')")}, ${name('list.contains()')}];
     list.replace('c', 'a');
     return [read, added, bare.hasAttribute('class'), errors,
       el.getAttribute('class'), list.toggle('z', false), String(list),
       list.supports === undefined, ${name("list.supports('a')")}];`,
  );
  assert.deepEqual(out, [
    [
      2,
      'a',
      'b',
      null,
      ' a b  a ',
      ['0', '1'],
      [
        [0, 'a'],
        [1, 'b'],
      ],
    ],
    'a b c',
    false,
    ['SyntaxError', 'InvalidCharacterError', 'SyntaxError', 'TypeError'],
    'a b',
    false,
    'a b',
    false,
    'TypeError',
  ]);
});

test('Node’s constants are fixed, and two trees have an order', async () => {
  const out = await inPage(
    `var d = Object.getOwnPropertyDescriptor(Node, 'DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC');
     var p = Object.getOwnPropertyDescriptor(Node.prototype, 'ELEMENT_NODE');
     var a = document.createElement('a'), b = document.createElement('b');
     var ab = a.compareDocumentPosition(b), ba = b.compareDocumentPosition(a);
     return [d.value, d.writable, d.configurable, d.enumerable, p && p.value,
       Node.NOTATION_NODE, (ab | ba) === (1 | 32 | 2 | 4), ab & 1, ab & 32];`,
  );
  assert.deepEqual(out, [32, false, false, true, 1, 12, true, 1, 32]);
});

test('replaceChild and a fragment each make the records a browser makes', async () => {
  const out = await inPage(
    `var box = document.getElementById('box');
     box.innerHTML = '<i></i><b></b>';
     var records = [];
     var mo = new MutationObserver(function () {});
     mo.observe(box, { childList: true });
     box.replaceChild(box.lastChild, box.firstChild);
     var internal = mo.takeRecords().map(function (r) {
       return [r.addedNodes.length, r.removedNodes.length];
     });
     var frag = document.createDocumentFragment();
     frag.append(document.createElement('u'), document.createElement('s'));
     mo.observe(frag, { childList: true });
     box.appendChild(frag);
     var moved = mo.takeRecords().map(function (r) {
       return [r.target === frag, r.addedNodes.length, r.removedNodes.length];
     });
     box.replaceChildren(box.firstChild);
     var all = mo.takeRecords().map(function (r) {
       return [r.addedNodes.length, r.removedNodes.length];
     });
     return [internal, moved, all];`,
  );
  assert.deepEqual(out, [
    [
      [0, 1],
      [1, 1],
    ],
    [
      [true, 0, 2],
      [false, 2, 0],
    ],
    [[1, 3]],
  ]);
});

test('a range counts a processing instruction’s data, and surrounds nothing in a text', async () => {
  const out = await inPage(
    `var xml = document.implementation.createDocument(null, 'r', null);
     var pi = xml.createProcessingInstruction('t', 'abcd');
     xml.documentElement.appendChild(pi);
     var range = xml.createRange();
     range.setStart(pi, 4);
     range.setEnd(pi, 4);
     var bad = null;
     try { range.setStart(pi, 5); } catch (e) { bad = e.name; }
     var r2 = document.createRange();
     var t = document.createTextNode('xy');
     document.getElementById('box').append(t);
     r2.setStart(t, 0); r2.setEnd(t, 1);
     var surround = ${name("r2.surroundContents(document.createTextNode('n'))")};
     return [range.startOffset, bad, surround];`,
  );
  assert.deepEqual(out, [4, 'IndexSizeError', 'HierarchyRequestError']);
});

test('only an HTML element hosts a shadow root', async () => {
  const out = await inPage(
    `var svg = document.createElementNS('http://www.w3.org/2000/svg', 'div');
     return [${name("svg.attachShadow({ mode: 'open' })")},
       ${name("document.createElement('div').attachShadow({ mode: 'open' })")}];`,
  );
  assert.deepEqual(out, ['NotSupportedError', 'none']);
});

test('a document made by a script is at about:blank', async () => {
  const out = await inPage(
    `var impl = document.implementation;
     return [impl.createDocument(null, null, null).URL,
       impl.createHTMLDocument('x').documentURI, new Document().URL,
       document.URL === 'about:blank'];`,
  );
  assert.deepEqual(out, ['about:blank', 'about:blank', 'about:blank', false]);
});

test('a copy of a customized built-in is one, however it was made', async () => {
  const out = await inPage(
    `var K = class extends HTMLParagraphElement {};
     customElements.define('my-p', K, { extends: 'p' });
     var made = document.createElement('p', { is: 'my-p' });
     var newed = new K();
     return [made.constructor === K, made.cloneNode().constructor === K,
       newed.cloneNode(true).constructor === K];`,
  );
  assert.deepEqual(out, [true, true, true]);
});

test('a query asks its argument, and a pseudo-element matches nothing', async () => {
  const out = await inPage(
    `var box = document.getElementById('box');
     return [${name('document.querySelector()')}, ${name('box.matches()')},
       ${name('box.closest()')}, document.querySelector('#box::before'),
       document.querySelectorAll('#box:first-line, #box').length,
       ${name("document.querySelector('#box::nope')")},
       ${name("box.toggleAttribute('')")}, box.toggleAttribute("it's"),
       ${name('box.insertBefore(document.createElement("i"))')}];`,
  );
  assert.deepEqual(out, [
    'TypeError',
    'TypeError',
    'TypeError',
    null,
    1,
    'SyntaxError',
    'InvalidCharacterError',
    true,
    'TypeError',
  ]);
});

test('a custom element’s internals have ARIA, and its form value is submitted', async () => {
  const out = await inPage(
    `var C = class extends HTMLElement {
       static get formAssociated() { return true; }
       constructor() { super(); this.i = this.attachInternals(); }
     };
     customElements.define('my-field', C);
     var form = document.createElement('form');
     form.innerHTML = '<my-field name="n"></my-field><my-field></my-field>';
     document.body.append(form);
     var fields = form.querySelectorAll('my-field');
     var i = fields[0].i;
     var before = [i.role, i.ariaLabel, i.ariaControlsElements, 'role' in i];
     i.role = 'slider';
     i.ariaControlsElements = [form];
     fields[0].i.setFormValue('v');
     var pairs = new FormData();
     pairs.append('a', '1'); pairs.append('b', '2');
     fields[1].i.setFormValue(pairs);
     var sent = Array.from(new FormData(form).entries());
     return [before, i.role, i.ariaControlsElements[0] === form,
       Object.isFrozen(i.ariaControlsElements), sent];`,
  );
  assert.deepEqual(out, [
    [null, null, null, true],
    'slider',
    true,
    true,
    [
      ['n', 'v'],
      ['a', '1'],
      ['b', '2'],
    ],
  ]);
});
