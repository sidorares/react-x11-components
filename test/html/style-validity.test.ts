// What a page's script is told a property takes (CSSOM 6.7, "set a CSS
// declaration"): `el.style`'s setter, `setProperty`, `cssText` and
// `CSS.supports()` give one answer, a value its property does not take
// changing nothing and reading back as `''`. The values are WPT's, from `css/*/parsing/`'s
// `-invalid` and `-valid` tests, which hold the rest.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** For each [property, value]: what the setter, `setProperty`, `cssText`
 *  and `CSS.supports()` make of it, as `set`/`''` and `true`/`false`. */
async function answers(
  cases: [string, string][],
): Promise<[string, string, string, boolean][]> {
  const page = await scriptedPage(
    `<div id="e"></div><script>
    var e = document.getElementById('e');
    var out = ${JSON.stringify(cases)}.map(function (c) {
      e.removeAttribute('style');
      e.style[c[0]] = c[1];
      var setter = e.style.getPropertyValue(c[0]) ? 'set' : '';
      e.removeAttribute('style');
      e.style.setProperty(c[0], c[1]);
      var set = e.style.getPropertyValue(c[0]) ? 'set' : '';
      e.removeAttribute('style');
      e.style.cssText = c[0] + ': ' + c[1];
      var text = e.style.getPropertyValue(c[0]) ? 'set' : '';
      return [setter, set, text, CSS.supports(c[0], c[1])];
    });
    console.log('out ' + JSON.stringify(out));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

const INVALID: [string, string][] = [
  ['color', '4'],
  ['color', '#12345'],
  ['color', 'rgb(1, 2)'],
  ['caret-color', 'none'],
  ['background-image', 'none, auto'],
  ['box-shadow', '1 2'],
  ['opacity', 'red'],
  ['z-index', '1.5'],
  ['letter-spacing', '1'],
  ['font-family', 'a, , b'],
  ['font-size-adjust', 'auto'],
  ['font-size-adjust', '0.5 ex-height'],
  ['font-variation-settings', '700'],
  ['font-weight', '1623'],
  ['font-weight', 'bold 900'],
  ['font-variant', 'small-caps all-small-caps'],
  ['font-variant-numeric', 'lining-nums oldstyle-nums'],
];

const VALID: [string, string][] = [
  ['color', 'red'],
  ['color', 'rgb(1 2 3 / 50%)'],
  ['color', 'color-mix(in srgb, red, blue)'],
  ['caret-color', 'auto'],
  ['background-image', 'url("a.png"), linear-gradient(red, blue)'],
  ['box-shadow', 'inset 1px 2px 3px 4px red, 0 0 1px'],
  ['opacity', '50%'],
  ['z-index', 'auto'],
  ['letter-spacing', 'normal'],
  ['font-family', 'Arial, sans-serif'],
  ['display', 'inline-block'],
  ['font-size-adjust', 'cap-height 0.5'],
  ['font-variation-settings', '"wght" 700'],
  ['font-weight', '650'],
  ['font-variant', 'small-caps lining-nums common-ligatures'],
  ['width', 'calc(1px + 2%)'],
  ['color', 'var(--x)'],
  ['box-shadow', 'inherit'],
];

test('a value its property does not take is refused alike by the setter, setProperty, cssText and CSS.supports()', async () => {
  const out = await answers(INVALID);
  assert.deepEqual(
    out.map((a, i) => [...INVALID[i], ...a]),
    INVALID.map((c) => [...c, '', '', '', false]),
  );
});

test('a value it does take is kept alike by all four, and one read only as it is substituted is kept as written', async () => {
  const out = await answers(VALID);
  assert.deepEqual(
    out.map((a, i) => [...VALID[i], ...a]),
    VALID.map((c) => [...c, 'set', 'set', 'set', true]),
  );
});
