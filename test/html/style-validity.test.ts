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
  ['width', 'none'],
  ['height', '-10px'],
  ['min-width', 'none'],
  ['max-width', 'auto'],
  ['max-height', 'max-content 10px'],
  ['background-image', 'linear-gradient(red, blue, lab)'],
  ['background-image', 'linear-gradient(in lab shorter hue, red, blue)'],
  ['background-image', 'radial-gradient(circle -10px at center, red, blue)'],
  ['background-image', 'radial-gradient(at top 0px, red, blue)'],
  ['background-image', 'conic-gradient(lab lab, red, blue)'],
  ['background-image', 'cross-fade(101% red, green)'],
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
  [
    'background-image',
    'linear-gradient(to right in oklch longer hue, red, blue)',
  ],
  [
    'background-image',
    'radial-gradient(ellipse 10px 20% at left 10px top 20px, red, blue)',
  ],
  [
    'background-image',
    'conic-gradient(from 45deg at 10% 20%, red 0deg 90deg, blue)',
  ],
  ['background-image', '-webkit-linear-gradient(top, red, blue)'],
  ['width', 'calc(1px + 2%)'],
  ['width', 'fit-content(10px)'],
  ['min-width', 'auto'],
  ['max-width', 'none'],
  ['height', 'stretch'],
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

/** What the setter keeps of each [property, value], read back. */
async function readBack(cases: [string, string][]): Promise<string[]> {
  const page = await scriptedPage(
    `<div id="e"></div><script>
    var e = document.getElementById('e');
    var out = ${JSON.stringify(cases)}.map(function (c) {
      e.removeAttribute('style');
      e.style[c[0]] = c[1];
      return e.style.getPropertyValue(c[0]);
    });
    console.log('out ' + JSON.stringify(out));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

test('a value Chromium, Firefox and WebKit all take is kept in the form all three write it back in', async () => {
  const cases: [string, string, string][] = [
    // a tag and a number, the number a math function or a tree count
    ['font-variation-settings', '"wght" sign(2px)', '"wght" calc(1)'],
    [
      'font-variation-settings',
      '"wght" sibling-index()',
      '"wght" sibling-index()',
    ],
    [
      'font-variation-settings',
      "'wght' 1e3, 'slnt' -450.0e-1",
      '"wght" 1000, "slnt" -45',
    ],
    ['font-variation-settings', '"wght" calc(100px + 200px)', ''],
    ['font-variation-settings', '"abc\\7F" 0.5', ''],
    // a <position>, which has no three-value form
    ['object-position', '10%', '10% center'],
    ['object-position', 'bottom 10% right 20%', 'right 20% bottom 10%'],
    ['object-position', 'center left 1px', ''],
    ['object-position', 'auto', ''],
    // an if() is substituted before a property's grammar reads it
    [
      'background-image',
      'image-set(if(style(--true): url(a.png); else: url(b.png);))',
      'image-set(if(style(--true): url("a.png"); else: url("b.png");))',
    ],
  ];
  const out = await readBack(cases.map(([p, v]) => [p, v]));
  assert.deepEqual(
    out.map((got, i) => [cases[i][0], cases[i][1], got]),
    cases,
  );
});
