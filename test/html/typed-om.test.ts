// <Html scripts>' CSS Typed OM (CSS Typed OM 1, 4.3 and 4.5): numeric
// values with the types CSS gives them — added and multiplied as 4.3.3
// has it, a TypeError where they do not go together — their sum values,
// which `to()` and `toSum()` convert through, a `calc()` parsed as Chrome
// reifies one, the transform components and their matrices, and
// `CSSStyleValue.parse()`. WPT's `css/css-typed-om/` holds the rest.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** What each expression of the page's comes to, as a string, or the name
 *  of what it threw. */
async function inPage(...expressions: string[]): Promise<string[]> {
  const page = await scriptedPage(
    `<div id="e"></div><script>console.log("out " + JSON.stringify([${expressions
      .map(
        (e) =>
          `(function () { try { return String(${e}); } catch (x) { return '!' + x.name; } })()`,
      )
      .join(', ')}]));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

test('a numeric value has the type its units make, and math values add and multiply them', async () => {
  const out = await inPage(
    'JSON.stringify(CSS.px(1).mul(CSS.px(2)).type())',
    'JSON.stringify(CSS.px(1).add(CSS.percent(2)).type())',
    'JSON.stringify(new CSSMathInvert(CSS.s(1)).type())',
    'new CSSMathSum(CSS.px(1), CSS.s(1))',
    'new CSSMathSum(new CSSMathProduct(CSS.px(1), CSS.px(1)), CSS.percent(1))',
    'new CSSMathProduct(CSS.px(1).add(CSS.percent(1)), CSS.deg(1).add(CSS.percent(1)))',
    'new CSSNumericValue()',
  );
  assert.deepEqual(out, [
    '{"length":2}',
    '{"length":1,"percentHint":"length"}',
    '{"time":-1}',
    '!TypeError',
    '!TypeError',
    '!TypeError',
    '!TypeError',
  ]);
});

test('arithmetic simplifies what is all one unit, and leaves a math value made of the rest', async () => {
  const out = await inPage(
    'new CSSMathSum(CSS.number(1)).add(CSS.number(2), CSS.number(3))',
    'CSS.number(10).mul(CSS.px(5), CSS.number(2))',
    'CSS.number(10).mul(CSS.px(5), CSS.px(2)).constructor.name',
    'CSS.number(1).sub(CSS.number(1), new CSSMathNegate(1), new CSSMathSum(1))',
    'CSS.number(2).div(CSS.number(2), CSS.px(2))',
    'CSS.number(2).div(CSS.number(0))',
    'new CSSMathMin(CSS.px(1), CSS.percent(1)).min()',
  );
  assert.deepEqual(out, [
    '6',
    '100px',
    'CSSMathProduct',
    'calc(1 + -1 + 1 - (1))',
    'calc(2 * 0.5 / 2px)',
    '!RangeError',
    'min(1px, 1%)',
  ]);
});

test('to() and toSum() convert through the sum value', async () => {
  const out = await inPage(
    "new CSSMathProduct(CSS.px(4), new CSSMathInvert(CSS.px(2))).to('number')",
    "new CSSMathMax(CSS.cm(1), CSS.mm(1)).to('mm').value.toFixed(6)",
    "new CSSMathClamp(CSS.px(90), CSS.px(100), CSS.px(110)).to('px')",
    "new CSSMathMin(CSS.px(2), CSS.em(3)).to('px')",
    'new CSSMathSum(CSS.px(1), CSS.em(1), CSS.vw(1), CSS.rem(1)).toSum()',
    "new CSSMathSum(CSS.cm(1), CSS.mm(10)).toSum('mm', 'cm')",
    "CSS.px(1).toSum('px', 'lemon')",
  );
  assert.deepEqual(out, [
    '2',
    '10.000000',
    '100px',
    '!TypeError',
    'calc(1em + 1px + 1rem + 1vw)',
    'calc(20mm + 0cm)',
    '!SyntaxError',
  ]);
});

test('a calc() parses to a math value, its like terms put together, and serializes with the parentheses its nesting needs', async () => {
  const out = await inPage(
    "CSSNumericValue.parse('calc(10px)').constructor.name",
    "CSSNumericValue.parse('calc(1px + 1in)')",
    "CSSNumericValue.parse('calc(9em - 8px + 1vh + (2 * min(10px, 20%)))')",
    "CSSNumericValue.parse('clamp(10px, 10%, 20px)').constructor.name",
    "CSSNumericValue.parse('calc(calc(1px * 2s) + 3%)')",
    'new CSSMathSum(new CSSMathNegate(1), 2, 3)',
    'new CSSMathProduct(new CSSMathInvert(1), 2, 3)',
    'new CSSMathMax(new CSSMathSum(1, 2), 3)',
  );
  assert.deepEqual(out, [
    'CSSMathSum',
    'calc(97px)',
    'calc(9em - 8px + 1vh + (2 * min(10px, 20%)))',
    'CSSMathClamp',
    '!SyntaxError',
    'calc((-1) + 2 + 3)',
    'calc((1 / 1) * 2 * 3)',
    'max(1 + 2, 3)',
  ]);
});

test('transform components check their arguments, serialize as their functions and come to their matrices', async () => {
  const out = await inPage(
    'new CSSTransformValue([new CSSTranslate(CSS.px(1), CSS.percent(2), CSS.px(3)), new CSSRotate(1, 2, 3, CSS.deg(90)), new CSSSkew(CSS.deg(90), CSS.turn(0)), new CSSPerspective(CSS.px(-1)), new CSSMatrixComponent(new DOMMatrixReadOnly([1, 2, 3, 4, 5, 6]))])',
    'new CSSTranslate(CSS.deg(1), CSS.px(0))',
    'new CSSTranslate(CSS.px(0), CSS.px(0), CSS.percent(0))',
    'new CSSRotate(CSS.px(1), 0, 0, CSS.deg(0))',
    'new CSSSkew(3.14, CSS.deg(0))',
    "new CSSPerspective('auto')",
    'new CSSTransformValue([])',
    'new CSSTransformValue([new CSSScale(2, 2), new CSSTranslate(CSS.px(10), CSS.px(20))]).toMatrix()',
    'new CSSTranslate(CSS.px(1), CSS.em(1)).toMatrix()',
    'new CSSPerspective(CSS.px(0.5)).toMatrix().m34',
    '(function () { var s = new CSSSkew(CSS.deg(0), CSS.deg(0)); s.is2D = false; return s.is2D; })()',
    '(function () { var t = new CSSTransformValue([new CSSScale(1, 1)]); t[1] = new CSSRotate(CSS.deg(4)); return t.length + " " + t.is2D + " " + t; })()',
  );
  assert.deepEqual(out, [
    'translate3d(1px, 2%, 3px) rotate3d(1, 2, 3, 90deg) skew(90deg) perspective(calc(-1px)) matrix(1, 2, 3, 4, 5, 6)',
    '!TypeError',
    '!TypeError',
    '!TypeError',
    '!TypeError',
    '!TypeError',
    '!TypeError',
    'matrix(2, 0, 0, 2, 20, 40)',
    '!TypeError',
    '-1',
    'true',
    '2 true scale(1, 1) rotate(4deg)',
  ]);
});

test('CSSStyleValue.parse() reifies a value for its property, and refuses what the property does not take', async () => {
  const out = await inPage(
    "CSSStyleValue.parse('transform', 'translateX(0) rotateZ(90deg) perspective(none)')",
    "CSSStyleValue.parse('transform', 'rotateZ(90deg)')[0].is2D",
    "CSSStyleValue.parse('WiDtH', 'calc(1px + calc(1px) + calc(1px * 2) + 1%)')",
    "CSSStyleValue.parse('width', '0').unit",
    "CSSStyleValue.parse('opacity', '0').unit",
    "CSSStyleValue.parse('display', 'block').constructor.name",
    "CSSStyleValue.parseAll('transition-duration', '1s, 2s, 3s').length",
    "CSSStyleValue.parse('lemon', 'auto')",
    "CSSStyleValue.parse('width', '10deg')",
    "CSSStyleValue.parse('--foo', '')",
  );
  assert.deepEqual(out, [
    'translate(0px, 0px) rotate3d(0, 0, 1, 90deg) perspective(none)',
    'false',
    'calc(4px + 1%)',
    'px',
    'number',
    'CSSKeywordValue',
    '3',
    '!TypeError',
    '!TypeError',
    '!TypeError',
  ]);
});
