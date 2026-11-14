// Math functions as a specified value keeps them (CSS Values 4, 10):
// `specifiedMath` parses one, checks its types against the property's,
// simplifies what needs no layout and serializes it as Chrome does, and
// refuses what is wrong with it; a value it cannot judge is left as
// written. WPT's `css/css-values/` holds the rest.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup } from 'react-x11/test';

import { specifiedMath } from '../../src/html/css/math.js';
import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

test('a math function is simplified as far as values that need no layout go', () => {
  const cases: [string, string, string][] = [
    ['opacity', 'cos(0)', 'calc(1)'],
    ['opacity', 'round(1.5)', 'calc(2)'],
    ['width', 'round(10px, 3px)', 'calc(9px)'],
    ['height', 'round(up, 10px, 3px)', 'calc(12px)'],
    ['rotate', 'atan2(1, 1)', 'calc(45deg)'],
    ['transition-delay', 'calc(1000ms)', 'calc(1s)'],
    ['width', 'calc(1in)', 'calc(96px)'],
    ['width', 'hypot(3px, 4px)', 'calc(5px)'],
    ['width', 'clamp(1px, 2px, 3px)', 'calc(2px)'],
    ['opacity', 'pow(2, 3)', 'calc(8)'],
    ['width', 'calc(1px + 1%)', 'calc(1% + 1px)'],
    ['width', 'min(10px, 1em)', 'min(10px, 1em)'],
    ['width', 'calc(infinity * 1px)', 'calc(infinity * 1px)'],
    ['opacity', 'calc(NaN)', 'calc(NaN)'],
    [
      'orphans',
      'calc(pow(2, sign(1em - 18px)))',
      'calc(pow(2, sign(1em - 18px)))',
    ],
    ['letter-spacing', 'clamp(10px, 35px /* foo */, 30px)', 'calc(30px)'],
  ];
  for (const [prop, value, expected] of cases) {
    assert.equal(specifiedMath(prop, value), expected, `${prop}: ${value}`);
  }
});

test('what is wrong with one, its syntax or its types, is refused, and what it cannot judge is left', () => {
  for (const [prop, value] of [
    ['opacity', 'round(1, , 2)'],
    ['opacity', 'round(0px)'],
    ['width', 'mod(1px)'],
    ['width', 'calc(1px * 1px)'],
    ['width', 'calc(1px + 2)'],
    ['animation-duration', 'calc(sign(50%) * 1s)'],
    ['width', 'calc(1px+2px)'],
  ]) {
    assert.equal(specifiedMath(prop, value), null, `${prop}: ${value}`);
  }
  for (const [prop, value] of [
    ['width', 'calc(anchor(top) + 1px)'],
    ['background-position', 'calc(2px + 3px) calc(4px + 5px)'],
    ['tab-size', 'calc(1px + 1px)'],
    ['width', '10px'],
  ]) {
    assert.equal(specifiedMath(prop, value), undefined, `${prop}: ${value}`);
  }
});

(SCRIPTS_CONTAINED ? test : test.skip)(
  "a page's el.style keeps a math function simplified, and nothing of an invalid one",
  async () => {
    const page = await scriptedPage(
      `<div id="e"></div><script>
      var e = document.getElementById('e'), r = [];
      e.style.width = 'round(10px, 3px)';
      r.push(e.style.width);
      e.style.width = 'mod(1px)';
      r.push(e.style.width);
      e.style.opacity = 'cos(0)';
      r.push(e.style.opacity, getComputedStyle(e).opacity);
      console.log('out ' + JSON.stringify(r));
    </script>`,
    );
    const out = JSON.parse(await page.until('out'));
    page.result.unmount();
    assert.deepEqual(out, ['calc(9px)', 'calc(9px)', 'calc(1)', '1']);
  },
);
