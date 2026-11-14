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
