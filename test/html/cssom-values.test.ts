// CSSOM as a page reads and writes it back: a specified value kept as
// written is serialized as CSSOM 6.7.2 has it, its numbers canonical, its
// strings in double quotes and a `url()`'s argument a string; and a style
// rule's `selectorText` takes a selector that parses, serialized, and leaves
// the rule as it was for one that does not. WPT's `css/cssom/` holds the
// rest.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

async function inPage(markup: string, code: string): Promise<unknown> {
  const page = await scriptedPage(
    `${markup}<script>console.log("out " + JSON.stringify((function () {
      ${code}
    })()));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

test('a value kept as written serializes its numbers, strings and urls as CSSOM does', async () => {
  const cases = [
    ['background-position', '.5% -.5%'],
    ['background-position', '-0px .5%'],
    ['width', 'calc(100% - .5em)'],
    ['line-height', '-0'],
    ['content', '\'say "hi"\''],
    ['background-image', 'url(http://localhost/a.png)'],
    ['transform', 'translate3d(1.50px, +2px, 0)'],
    ['color', '#0f0'],
    ['grid-row', 'col-1 / 2'],
    ['width', 'var(--x, .5px)'],
  ];
  const out = await inPage(
    '<div id="e"></div>',
    `var e = document.getElementById('e');
     return ${JSON.stringify(cases)}.map(function (c) {
       e.setAttribute('style', c[0] + ': ' + c[1]);
       return e.style.getPropertyValue(c[0]);
     });`,
  );
  assert.deepEqual(out, [
    '0.5% -0.5%',
    '0px 0.5%',
    'calc(100% - 0.5em)',
    '0',
    '"say \\"hi\\""',
    'url("http://localhost/a.png")',
    'translate3d(1.5px, 2px, 0)',
    '#0f0',
    'col-1 / 2',
    'var(--x, .5px)',
  ]);
});

test("a style rule's selectorText takes a selector that parses, and keeps its own for one that does not", async () => {
  const out = await inPage(
    '<style id="s">.a { color: rgb(0, 0, 255) }</style><div id="e" lang="zh-CN"></div>',
    `var rule = document.getElementById('s').sheet.cssRules[0];
     var e = document.getElementById('e');
     var r = [];
     ['', ':gibberish', '{}', '123'].forEach(function (s) { rule.selectorText = s; r.push(rule.selectorText); });
     rule.selectorText = '  #e  ';
     r.push(rule.selectorText, getComputedStyle(e).color);
     rule.selectorText = '*|div';
     r.push(rule.selectorText);
     rule.selectorText = '[|lang]';
     r.push(rule.selectorText, rule.cssText);
     rule.selectorText = 'div::before';
     r.push(rule.selectorText);
     return r;`,
  );
  assert.deepEqual(out, [
    '.a',
    '.a',
    '.a',
    '.a',
    '#e',
    'rgb(0, 0, 255)',
    'div',
    '[lang]',
    '[lang] { color: rgb(0, 0, 255); }',
    'div::before',
  ]);
});

test('an @page rule is a CSSPageRule, its style the descriptors it declares and no other property', async () => {
  const out = await inPage(
    '<style id="s">@page { size: a3; margin: 1em 24px 2in 101.5mm } @page { size: 216mm }</style>',
    `var rules = document.getElementById('s').sheet.cssRules;
     var st = rules[0].style, other = rules[1].style;
     other.size = 'portrait';
     other.size = 'notarealsize';
     other.setProperty('float', 'left');
     rules[1].selectorText = 'named:First';
     var kept = rules[1].selectorText;
     rules[1].selectorText = 'named :first';
     return [
       rules[0] instanceof CSSPageRule,
       Object.getPrototypeOf(st) === CSSPageDescriptors.prototype,
       st.size, st.marginLeft, st['margin-bottom'],
       other.size, other.cssFloat === undefined,
       kept, rules[1].selectorText, rules[1].cssText,
     ];`,
  );
  assert.deepEqual(out, [
    true,
    true,
    'a3',
    '101.5mm',
    '2in',
    'portrait',
    true,
    'named:first',
    'named:first',
    '@page named:first { size: portrait; }',
  ]);
});

test('a selector reads back as CSSOM serializes it, its namespaces and its arguments canonical', async () => {
  const cases = [
    '*|e',
    '*.c',
    '*|*:hover',
    'e:nth-child(  3n - 0)',
    ':nth-child( even   )',
    ':lang( ja )',
    '[a="*.c"]',
    '@namespace url(d); @namespace nd url(d); nd|*.c',
    '@namespace url(d); *|e',
  ];
  const out = await inPage(
    '<style id="s"></style>',
    `var st = document.getElementById('s');
     return ${JSON.stringify(cases)}.map(function (c) {
       st.textContent = c + ' { }';
       var rules = st.sheet.cssRules;
       return rules[rules.length - 1].selectorText;
     });`,
  );
  assert.deepEqual(out, [
    'e',
    '.c',
    ':hover',
    'e:nth-child(3n)',
    ':nth-child(2n)',
    ':lang(ja)',
    '[a="*.c"]',
    '.c',
    '*|e',
  ]);
});

test('a sheet the document adopts styles it in the task that adopted it', async () => {
  const out = await inPage(
    '<span id="g">x</span>',
    `var g = document.getElementById('g'), r = [];
     var s = new CSSStyleSheet();
     s.replaceSync('span { color: rgb(0, 128, 0) }');
     var before = getComputedStyle(g).color;
     document.adoptedStyleSheets = [s];
     r.push(getComputedStyle(g).color);
     s.replaceSync('span { color: rgb(255, 0, 0) }');
     r.push(getComputedStyle(g).color);
     document.adoptedStyleSheets = [];
     r.push(getComputedStyle(g).color === before);
     return r;`,
  );
  assert.deepEqual(out, ['rgb(0, 128, 0)', 'rgb(255, 0, 0)', true]);
});

test('a grid shorthand in cssText is its longhands, read back as the longest shorthand they make', async () => {
  // WPT's css/css-grid/parsing/grid-shorthand-serialization: `cssText`
  // keeps `grid` as its six longhands, as `el.style.grid` does, and writes
  // `grid` back where they make one and `grid-template` where they make
  // only that
  const out = await inPage(
    '<div id="e"></div>',
    `var e = document.getElementById('e'), r = [];
     function read(text) {
       e.style.cssText = text;
       return [e.style.grid, e.style.gridTemplate, e.style.gridAutoFlow,
         e.style.gridTemplateRows, e.style.cssText].join(' | ');
     }
     r.push(read('grid: auto-flow / 10px; grid-template-rows: 20px'));
     r.push(read('grid: 30px 40px / 50px 60px; grid-auto-flow: column'));
     r.push(read('grid: auto-flow 1px / 2px; grid-auto-columns: 3px'));
     return r;`,
  );
  assert.deepEqual(out, [
    '20px / 10px | 20px / 10px | row | 20px | grid: 20px / 10px;',
    ' | 30px 40px / 50px 60px | column | 30px 40px | ' +
      'grid-template: 30px 40px / 50px 60px; grid-auto-rows: auto; ' +
      'grid-auto-columns: auto; grid-auto-flow: column;',
    // the auto columns declared again stand where they were last declared
    ' | none / 2px | row | none | grid-template: none / 2px; ' +
      'grid-auto-rows: 1px; grid-auto-flow: row; grid-auto-columns: 3px;',
  ]);
});

test('CSS.supports() is false for a property a style has not got, a value that is no colour, and what is no condition', async () => {
  // CSSOM's `CSS.supports()` answers what the page could set: an unknown
  // name, `color: rainbow`, `;` and a condition cut short are false, where
  // all four were true. A function this knows nothing of stays true, and a
  // property named `not-…` is no `not` (WPT's css/cssom/CSS-supports).
  const out = await inPage(
    '<div></div>',
    `return [CSS.supports('color', 'red'), CSS.supports('--x', 'y'),
       CSS.supports('not-a-real-property', 'red'), CSS.supports('color', 'rainbow'),
       CSS.supports('(color: red)'), CSS.supports('color: red'),
       CSS.supports('not (colour: red)'), CSS.supports(';'),
       CSS.supports('(color: red) and'), CSS.supports(' color', 'red')];`,
  );
  assert.deepEqual(out, [
    true,
    true,
    false,
    false,
    true,
    true,
    true,
    false,
    false,
    false,
  ]);
});

test('CSS.supports() takes every property a browser knows and every colour a colour property takes', async () => {
  // a property nothing here draws is still one a page sets, and a WPT
  // interpolation test asks before anything else; a colour is held to a
  // colour only where it is one word, and `border-color` takes four
  const out = await inPage(
    '<div></div>',
    `return [CSS.supports('font-size-adjust', 'none'),
       CSS.supports('font-variation-settings', 'normal'),
       CSS.supports('initial-letter', 'normal'),
       CSS.supports('caret-color', 'auto'), CSS.supports('accent-color', 'auto'),
       CSS.supports('border-color', 'red yellow'), CSS.supports('color', 'Field'),
       CSS.supports('color', 'revert-rule'), CSS.supports('color:revert-rule'),
       CSS.supports('color', 'r\\gb(0, 51, 102)'),
       CSS.supports('color', '/**/transparent'),
       CSS.supports('background-color', 'contrast-color(buttonface)'),
       CSS.supports('selector(::details-content:hover'),
       'fontSizeAdjust' in document.body.style,
       CSS.supports('not-a-real-property', 'red'),
       CSS.supports('color', 'rainbow'), CSS.supports('caret-color', 'rainbow')];`,
  );
  assert.deepEqual(out, [...Array(14).fill(true), false, false, false]);
});

test('a grouping rule takes rules in and gives them up, and the page is styled by them', async () => {
  // CSSOM 6.4.2: `insertRule` and `deleteRule` on `@media` and on a style
  // rule that nests, where both threw (WPT's CSSGroupingRule-insertRule)
  const out = await inPage(
    '<style id="s">@media all { .x { color: red } } .n { color: blue; .m { color: red } }</style>' +
      '<div id="e" class="y"></div>',
    `var sheet = document.getElementById('s').sheet;
     var media = sheet.cssRules[0];
     var r = [media.insertRule('.y { color: rgb(0, 128, 0) }', 1)];
     r.push(media.cssRules.length, getComputedStyle(document.getElementById('e')).color);
     media.deleteRule(0);
     r.push(media.cssRules.length, media.cssRules[0].selectorText);
     try { media.insertRule('@import url(a.css);'); } catch (e) { r.push(e.name); }
     try { media.insertRule('nonsense'); } catch (e) { r.push(e.name); }
     try { media.deleteRule(5); } catch (e) { r.push(e.name); }
     var nest = sheet.cssRules[1];
     nest.insertRule('.k { color: green }', 0);
     r.push(nest.cssRules.length, nest.cssRules[0].style.color, nest.style.color);
     return r;`,
  );
  assert.deepEqual(out, [
    1,
    2,
    'rgb(0, 128, 0)',
    1,
    '.y',
    'HierarchyRequestError',
    'SyntaxError',
    'IndexSizeError',
    2,
    'green',
    'blue',
  ]);
});

test("a nested rule's selectorText says the & it is relative to", async () => {
  // CSS Nesting 1, 3.2: a nested selector with no `&` is relative to one at
  // its start, which it serializes with (WPT's css-nesting/parsing)
  const out = await inPage(
    '<style id="s">.a { > .b { color: red } .c, &.d, .e & { color: red }' +
      ' @media all { .f { color: red } } }</style>',
    `var rules = document.getElementById('s').sheet.cssRules[0].cssRules;
     return [rules[0].selectorText, rules[1].selectorText,
       rules[2].cssRules[0].selectorText];`,
  );
  assert.deepEqual(out, ['& > .b', '& .c, &.d, .e &', '& .f']);
});
