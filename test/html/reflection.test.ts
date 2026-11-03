// <Html scripts>' reflected attributes (HTML 2.6.1): an IDL attribute that
// reads and writes a content attribute, by the rules its type has, which
// WPT's `html/dom/reflection-*.html` hold every element to. Each case here
// is one those found wrong: a number read by JavaScript's rules rather than
// HTML's, an enumerated attribute that answered whatever it was set to, an
// attribute an interface did not have.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { PAGE, scriptedPage } from './harness.js';

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

test('an enumerated attribute reads as the keyword of its state, matched in ASCII case', async () => {
  const out = await inPage(
    '',
    `var el = function (n) { return document.createElement(n); };
     var read = function (tag, name, attr, values) {
       var e = el(tag);
       var out = [e[name]];
       values.forEach(function (v) { e.setAttribute(attr, v); out.push(e[name]); });
       return out;
     };
     var cors = el('img');
     var corsOut = [cors.crossOrigin];
     cors.crossOrigin = 'x';
     corsOut.push(cors.crossOrigin, cors.getAttribute('crossorigin'));
     cors.crossOrigin = undefined;
     corsOut.push(cors.hasAttribute('crossorigin'));
     return {
       dir: read('div', 'dir', 'dir', ['RTL', 'foo', 'auto']),
       method: read('form', 'method', 'method', ['DIALOG', 'put']),
       enctype: read('form', 'enctype', 'enctype', ['TEXT/PLAIN', 'x']),
       // U+212A KELVIN SIGN is a k to toLowerCase, and to nothing here
       type: read('input', 'type', 'type', ['chec\\u212Abox', 'CHECKBOX']),
       button: read('button', 'type', 'type', ['RESET', 'x']),
       formMethod: read('input', 'formMethod', 'formmethod', ['POST', 'x']),
       kind: read('track', 'kind', 'kind', ['x', 'CAPTIONS']),
       preload: read('video', 'preload', 'preload', ['', 'none', 'x']),
       scope: read('td', 'scope', 'scope', ['ROW', 'x']),
       referrer: read('a', 'referrerPolicy', 'referrerpolicy', ['ORIGIN', 'x']),
       as: read('link', 'as', 'as', ['STYLE', 'x']),
       hint: read('x-y', 'enterKeyHint', 'enterkeyhint', ['GO', 'x']),
       mode: read('span', 'inputMode', 'inputmode', ['NUMERIC', 'x']),
       loading: read('iframe', 'loading', 'loading', ['LAZY', 'x']),
       cors: corsOut,
     };`,
  );
  assert.deepEqual(out, {
    dir: ['', 'rtl', '', 'auto'],
    method: ['get', 'dialog', 'get'],
    enctype: [
      'application/x-www-form-urlencoded',
      'text/plain',
      'application/x-www-form-urlencoded',
    ],
    type: ['text', 'text', 'checkbox'],
    button: ['submit', 'reset', 'submit'],
    formMethod: ['', 'post', 'get'],
    kind: ['subtitles', 'metadata', 'captions'],
    preload: ['metadata', 'auto', 'none', 'metadata'],
    scope: ['', 'row', ''],
    referrer: ['', 'origin', ''],
    as: ['', 'style', ''],
    hint: ['', 'go', ''],
    mode: ['', 'numeric', ''],
    loading: ['eager', 'lazy', 'eager'],
    cors: [null, 'anonymous', 'x', false],
  });
});

test("an integer is read by HTML's rules, and set by WebIDL's", async () => {
  const out = await inPage(
    '',
    `var el = function (n) { return document.createElement(n); };
     var read = function (tag, name, values) {
       var e = el(tag);
       var out = [e[name]];
       values.forEach(function (v) { e.setAttribute(name.toLowerCase(), v); out.push(e[name]); });
       return out;
     };
     var throws = function (f) { try { f(); return 'none'; } catch (e) { return e.name; } };
     var set = function (tag, name, v) { var e = el(tag); e[name] = v; return e.getAttribute(name.toLowerCase()); };
     var li = el('li');
     li.setAttribute('value', '-0');
     return {
       // a vertical tab and a no-break space are no white space here
       value: read('li', 'value', [' 7', '\\u000B7', '\\u00A07', '+3x', '2147483648']),
       negativeZero: Object.is(li.value, 0),
       start: read('ol', 'start', ['x', '-2']),
       maxLength: read('input', 'maxLength', ['5', '-1', 'x']),
       negativeMax: throws(function () { el('input').maxLength = -1; }),
       size: read('input', 'size', ['0', '4']),
       zeroSize: throws(function () { el('input').size = 0; }),
       cols: read('textarea', 'cols', ['0', '7']),
       zeroCols: set('textarea', 'cols', 0),
       selectSize: read('select', 'size', ['3', '-3']),
       colSpan: read('td', 'colSpan', ['0', '5000', '3']),
       rowSpan: read('td', 'rowSpan', ['0', '70000']),
       span: read('col', 'span', ['0', '2000']),
       hspace: read('img', 'hspace', ['4', '4294967296']),
       hugeHspace: set('img', 'hspace', 2147483648),
       scrollAmount: el('marquee').scrollAmount,
       videoWidth: read('video', 'width', ['640']),
       canvas: read('canvas', 'width', ['-0', '2147483648']),
     };`,
  );
  assert.deepEqual(out, {
    value: [0, 7, 0, 0, 3, 0],
    negativeZero: true,
    start: [1, 1, -2],
    maxLength: [-1, 5, -1, -1],
    negativeMax: 'IndexSizeError',
    size: [20, 20, 4],
    zeroSize: 'IndexSizeError',
    cols: [20, 20, 7],
    zeroCols: '20',
    selectSize: [0, 3, 0],
    colSpan: [1, 1, 1000, 3],
    rowSpan: [1, 0, 65534],
    span: [1, 1, 1000],
    hspace: [0, 4, 0],
    hugeHspace: '0',
    scrollAmount: 6,
    videoWidth: [0, 640],
    canvas: [300, 0, 300],
  });
});

test("a double is read by HTML's rules, and a meter's are held between each other", async () => {
  const out = await inPage(
    '',
    `var el = function (n) { return document.createElement(n); };
     var throws = function (f) { try { f(); return 'none'; } catch (e) { return e.name; } };
     var p = el('progress');
     var max = [p.max];
     ['1e2', '-1', ' .5', '1.8e308'].forEach(function (v) { p.setAttribute('max', v); max.push(p.max); });
     p.setAttribute('max', 'kept');
     p.max = 0;
     max.push(p.getAttribute('max'));
     var m = el('meter');
     m.setAttribute('min', '2');
     m.setAttribute('max', '6');
     m.setAttribute('value', '9');
     m.setAttribute('low', '1');
     var readings = [m.value, m.min, m.max, m.low, m.high, m.optimum];
     m.value = 1.5;
     return {
       max: max,
       readings: readings,
       set: m.getAttribute('value'),
       nan: throws(function () { m.value = NaN; }),
     };`,
  );
  assert.deepEqual(out, {
    max: [1, 100, 1, 0.5, 1, 'kept'],
    readings: [6, 2, 6, 2, 6, 4],
    set: '1.5',
    nan: 'TypeError',
  });
});

test('a string reflects its attribute by the name HTML gives it, and a URL resolves', async () => {
  const out = await inPage(
    '<p id="p"></p>',
    `var el = function (n) { return document.createElement(n); };
     var col = el('colgroup');
     col.ch = 'c';
     col.chOff = 'o';
     var table = el('table');
     table.bgColor = null;
     var form = el('form');
     form.acceptCharset = 'utf-8';
     var script = el('script');
     script.htmlFor = 'w';
     var a = el('a');
     a.ping = '\\uD800';
     var img = el('img');
     img.setAttribute('lowsrc', 'low.png');
     var input = el('input');
     input.setAttribute('formaction', '');
     document.body.setAttribute('text', 'red');
     document.dir = 'RTL';
     return {
       col: [col.getAttribute('char'), col.getAttribute('charoff')],
       table: table.getAttribute('bgcolor'),
       form: [form.getAttribute('accept-charset'), form.action],
       script: script.getAttribute('for'),
       ping: a.ping === '\\uFFFD',
       lowsrc: img.lowsrc,
       formAction: input.formAction,
       fgColor: document.fgColor,
       dir: [document.dir, document.documentElement.getAttribute('dir')],
       font: el('font').color,
       version: document.documentElement.version,
     };`,
  );
  assert.deepEqual(out, {
    col: ['c', 'o'],
    table: '',
    form: ['utf-8', PAGE],
    script: 'w',
    ping: true,
    lowsrc: 'https://example.test/low.png',
    formAction: PAGE,
    fgColor: 'red',
    dir: ['rtl', 'RTL'],
    font: '',
    version: '',
  });
});

test("a boolean attribute is every element's that HTML gives it, and true sets it empty", async () => {
  const out = await inPage(
    '',
    `var div = document.createElement('div');
     div.setAttribute('inert', 'x');
     var was = [div.inert, div.autofocus];
     div.inert = 1;
     var obj = document.createElement('object');
     obj.declare = true;
     return {
       was: was,
       inert: div.getAttribute('inert'),
       declare: obj.getAttribute('declare'),
       noResize: document.createElement('frame').noResize,
       trueSpeed: document.createElement('marquee').trueSpeed,
     };`,
  );
  assert.deepEqual(out, {
    was: [true, false],
    inert: '',
    declare: '',
    noResize: false,
    trueSpeed: false,
  });
});

test("reflection reads and writes past an element's own getAttribute and setAttribute", async () => {
  // WPT's `reflection-overridden-methods`
  const out = await inPage(
    '',
    `var div = document.createElement('div');
     var calls = [];
     ['getAttribute', 'getAttributeNS', 'setAttribute', 'setAttributeNS', 'hasAttribute', 'removeAttribute', 'toggleAttribute']
       .forEach(function (name) { div[name] = function () { calls.push(name); }; });
     div.title;
     div.title = 'foo';
     div.hidden = true;
     div.inert = false;
     return { calls: calls, title: Element.prototype.getAttribute.call(div, 'title') };`,
  );
  assert.deepEqual(out, { calls: [], title: 'foo' });
});

test('a nonce a script sets is no attribute, and an attribute set is the nonce again', async () => {
  const out = await inPage(
    '',
    `var s = document.createElement('style');
     s.setAttribute('nonce', 'a');
     var out = [s.nonce];
     s.nonce = 'b';
     out.push(s.nonce, s.getAttribute('nonce'));
     s.setAttribute('nonce', 'c');
     out.push(s.nonce);
     s.removeAttribute('nonce');
     out.push(s.nonce);
     return out;`,
  );
  assert.deepEqual(out, ['a', 'b', 'a', 'c', '']);
});

test("each element's interface is HTML's, with what it reflects on its prototype and none on the element", async () => {
  const out = await inPage(
    '<details><summary id="s">x</summary></details>',
    `var kinds = ['param', 'map', 'data', 'ins', 'del', 'menu', 'dir', 'font', 'frameset', 'frame', 'marquee']
       .map(function (n) { return Object.prototype.toString.call(document.createElement(n)); });
     var d = function (proto, name) {
       var at = Object.getOwnPropertyDescriptor(proto, name);
       return at ? [typeof at.get, typeof at.set, at.enumerable] : null;
     };
     var input = document.createElement('input');
     var area = document.createElement('area');
     area.setAttribute('name', 'foo');
     area.name = 'bar';
     area.href = '/maps/a?b';
     return {
       // a hyperlink as an \`<a>\` is, and no \`<a>\`
       area: [area instanceof HTMLAnchorElement, area.getAttribute('name'), area.pathname, area.search],
       kinds: kinds,
       inputName: d(HTMLInputElement.prototype, 'name'),
       fieldSetName: d(HTMLFieldSetElement.prototype, 'name'),
       title: d(HTMLElement.prototype, 'title'),
       own: Object.getOwnPropertyNames(input).filter(function (n) { return n === 'name' || n === 'type'; }),
       fieldSetRequired: 'required' in document.createElement('fieldset'),
       tabIndex: [
         document.createElement('button').tabIndex,
         document.createElement('a').tabIndex,
         document.createElement('div').tabIndex,
         document.getElementById('s').tabIndex,
         document.createElement('summary').tabIndex,
       ],
       areas: document.createElement('map').areas.length,
     };`,
  );
  assert.deepEqual(out, {
    area: [false, 'foo', '/maps/a', '?b'],
    kinds: [
      '[object HTMLParamElement]',
      '[object HTMLMapElement]',
      '[object HTMLDataElement]',
      '[object HTMLModElement]',
      '[object HTMLModElement]',
      '[object HTMLMenuElement]',
      '[object HTMLDirectoryElement]',
      '[object HTMLFontElement]',
      '[object HTMLFrameSetElement]',
      '[object HTMLFrameElement]',
      '[object HTMLMarqueeElement]',
    ],
    inputName: ['function', 'function', true],
    fieldSetName: ['function', 'function', true],
    title: ['function', 'function', true],
    own: [],
    fieldSetRequired: false,
    tabIndex: [0, 0, -1, 0, -1],
    areas: 0,
  });
});
