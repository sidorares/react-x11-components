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

test('a name no property has is an expando on the style, as in a browser, and makes no declaration', async () => {
  const page = await scriptedPage(
    `<style>@font-face { font-family: f; src: url(f.woff2); }</style>
    <div id="e"></div><script>
    var e = document.getElementById('e');
    var before = 'corner' in e.style;
    e.style.corner = 'auto';
    e.style['--x'] = '1';
    e.style.setProperty('corners', 'round');
    e.style.setProperty('--y', '2');
    e.style.color = 'red';
    e.style.webkitTransform = 'rotate(1deg)';
    var face = document.styleSheets[1].cssRules[0].style;
    face.setProperty('font-display', 'swap');
    console.log('out ' + JSON.stringify([
      before, e.style.corner, e.style.getPropertyValue('corner'),
      e.style.getPropertyValue('corners'), e.style['--x'],
      e.style.getPropertyValue('--x'), e.style.getPropertyValue('--y'),
      e.style.cssText, 'color' in e.style, 'backgroundColor' in e.style,
      'webkitTransform' in e.style, face.getPropertyValue('font-display'),
    ]));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  assert.deepEqual(out, [
    false,
    'auto',
    '',
    '',
    '1',
    '',
    '2',
    '--y: 2; color: red; -webkit-transform: rotate(1deg);',
    true,
    true,
    true,
    'swap',
  ]);
});

test('a keyword property takes its keywords each at most once, as the three browsers do, and writes them back in its own order', async () => {
  const cases: [string, string, string][] = [
    ['object-fit', 'scale-down cover', 'cover scale-down'],
    ['object-fit', 'contain scale-down', 'scale-down'],
    ['object-fit', 'contain cover', ''],
    ['object-fit', 'auto', ''],
    ['font-synthesis', 'small-caps style weight', 'weight style small-caps'],
    ['font-synthesis', 'none weight', ''],
    ['font-synthesis', 'style oblique-only', ''],
    ['font-style', 'italic oblique', ''],
    ['font-style', 'auto', ''],
    ['font-style', 'oblique 10deg', 'oblique 10deg'],
    [
      'text-decoration-line',
      'blink overline underline',
      'underline overline blink',
    ],
    ['text-decoration-line', 'none underline', ''],
    ['text-decoration-line', 'underline underline', ''],
    ['text-decoration-line', 'spelling-error overline', ''],
    ['text-overflow', 'clip ellipsis clip', ''],
    ['text-overflow', '"-"', '"-"'],
    ['vertical-align', 'super middle first', 'first middle super'],
    ['vertical-align', 'baseline 0', 'baseline'],
    ['vertical-align', 'sub super', ''],
    ['vertical-align', 'none', ''],
    ['display', 'list-item flow-root inline', 'inline flow-root list-item'],
    ['display', 'flex inline', 'inline-flex'],
    ['display', 'ruby block', 'block ruby'],
    ['display', 'flow', 'block'],
    ['display', 'ruby list-item', ''],
    ['display', 'flex ruby', ''],
    ['opacity', '50%', '0.5'],
    ['opacity', '2.5e-1', '0.25'],
    ['opacity', 'auto', ''],
    ['opacity', '1.', ''],
    ['image-orientation', 'from-image', 'from-image'],
    ['image-orientation', '30deg', ''],
    ['caret-color', 'auto auto', ''],
    ['caret-color', 'red green', ''],
    ['caret-color', '50%', ''],
    ['caret-color', 'auto', 'auto'],
    ['caret-color', 'currentcolor auto', ''],
    ['initial-letter', 'drop 1.23', '1.23 drop'],
    ['initial-letter', 'drop', ''],
    ['initial-letter', '0', ''],
    ['baseline-source', 'auto first', ''],
    ['hanging-punctuation', 'first last force-end', 'first last force-end'],
    ['hanging-punctuation', 'force-end allow-end', ''],
    ['block-ellipsis', 'auto', ''],
    ['scroll-marker-group', 'before, after', ''],
    ['max-lines', 'auto 8', '8 auto'],
    ['max-lines', '0', ''],
    ['max-lines', '3 4', ''],
    ['continue', 'auto discard', ''],
    ['continue', 'discard', 'discard'],
    [
      'border-shape',
      'circle() border-box circle() content-box',
      'circle() circle() content-box',
    ],
    ['border-shape', 'circle() padding-box margin-box', ''],
    ['border-shape', 'padding-box circle()', ''],
    ['border-shape', 'nonsense', ''],
    [
      'border-shape',
      'circle(farthest-corner at center)',
      'circle(farthest-corner at center center)',
    ],
    [
      'border-shape',
      'ellipse(closest-corner farthest-corner at 20px 50px)',
      'ellipse(closest-corner farthest-corner at 20px 50px)',
    ],
  ];
  const out = await readBack(cases.map(([p, v]) => [p, v]));
  assert.deepEqual(
    out.map((got, i) => [cases[i][0], cases[i][1], got]),
    cases,
  );
});
