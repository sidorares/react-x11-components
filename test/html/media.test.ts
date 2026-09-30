// <Html> — media queries, and the colour scheme.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, renderX11, screen, waitFor } from 'react-x11/test';
import { ThemeProvider } from 'react-x11';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import {
  mediaMatches,
  parseMediaQuery,
  parseStylesheet,
} from '../../src/html/css/parse.js';
import { HtmlSource } from '../../src/html/dom.js';
import { lightDark, usedColorScheme } from '../../src/html/css/color.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import {
  FONTS,
  boxOf,
  h,
  render,
  render2x,
  renderScrolled,
  view,
} from './harness.js';

afterEach(cleanup);

test('@media width queries become conditions, and their breakpoints are collected', () => {
  const sheet = parseStylesheet(
    '@media (min-width: 600px) { p { color: red } }',
  );
  assert.strictEqual(sheet.rules.length, 1);
  assert.deepStrictEqual(sheet.rules[0].media, [[{ min: 600 }]]);
  assert.deepStrictEqual(sheet.breakpoints, [600]);
});

test('a print-only stylesheet is not applied', () => {
  const source = new HtmlSource();
  source.setSource('<style media="print">p{color:red}</style>', true);
  assert.strictEqual(source.facts().sheets.length, 0);
});

test('prefers-color-scheme is a live condition, alone and beside a width', () => {
  const sheet = parseStylesheet(
    '@media (prefers-color-scheme: dark) { p { color: red } }' +
      '@media (prefers-color-scheme: light) and (max-width: 520px) { p { color: blue } }' +
      '@media not (prefers-color-scheme: dark) { p { color: green } }' +
      '@media (prefers-color-scheme: no-preference) { p { color: gray } }',
  );
  assert.deepStrictEqual(
    sheet.rules.map((r) => r.media),
    [
      [[{ scheme: 'dark' }]],
      [[{ max: 520, scheme: 'light' }]],
      [[{ scheme: 'light' }]],
      [[{ staticPass: false }]],
    ],
  );
  // a scheme is not a width: the only breakpoint is the width test's, just
  // past the widest width it holds at
  assert.deepStrictEqual(sheet.breakpoints, [520 + 1 / 64]);

  assert.ok(mediaMatches([[{ scheme: 'dark' }]], 800, 'dark'));
  assert.ok(!mediaMatches([[{ scheme: 'dark' }]], 800, 'light'));
  assert.ok(mediaMatches([[{ max: 520, scheme: 'light' }]], 400, 'light'));
  assert.ok(!mediaMatches([[{ max: 520, scheme: 'light' }]], 600, 'light'));
  assert.ok(!mediaMatches([[{ max: 520, scheme: 'light' }]], 400, 'dark'));
  // with no scheme given the light branch holds, as before
  assert.ok(mediaMatches([[{ scheme: 'light' }]], 400));
});

test('a medium other than the screen matches nothing, an @import included', () => {
  // `print` and `speech`, and the media CSS 2.1 named that Media Queries
  // retired: `braille`, `embossed`, `handheld`, `projection`, `tty`, `tv`.
  // A term that is no name, `(color)`, is left as it was.
  const sheet = parseStylesheet(
    '@import url(a.css) tv; @import "b.css" screen, print; @import "c.css";' +
      '@media braille { p { color: red } } @media (color) { p { color: blue } }',
  );
  assert.deepStrictEqual(sheet.imports, ['b.css', 'c.css']);
  assert.deepStrictEqual(
    sheet.rules.map((r) => r.media),
    [[[{ staticPass: false }]], [[{ staticPass: true }]]],
  );
});

test("an @import's media queries are the conditions the sheet it imports is under", async () => {
  // CSS Cascade 4, 2: an import's media query list is its import
  // conditions, and the sheet it imports applies as though an `@media`
  // block of them were around all of it. The list was taken to hold at
  // every width, so a design that imports a sheet a breakpoint had all of
  // them at once: the Zen Garden's 219, `@import url("219-1367.css") all
  // and (min-width: 1367px)`, laid out for a screen wider than it had
  const sheet = parseStylesheet(
    '@import "wide.css" all and (min-width: 800px) and (max-width: 1366px);' +
      '@import url(tall.css) (min-height: 900px), (min-width: 2000px);' +
      '@import "always.css" screen; @import "never.css" print;',
  );
  assert.deepStrictEqual(
    sheet.imports,
    ['wide.css', 'tall.css', 'always.css'],
    'a list that holds nowhere leaves its sheet out',
  );
  assert.deepStrictEqual(
    sheet.importConditions,
    [[{ min: 800, max: 1366 }], [{ minHeight: 900 }, { min: 2000 }], null],
    'and one that always holds is no condition',
  );
  // the sheet an import brings in, parsed under its conditions: every rule
  // in it, a face and the blocks inside it, and its breakpoints
  const under = [sheet.importConditions[0]!];
  const wide = parseStylesheet(
    '@import "inner.css" (min-width: 1200px);' +
      'p { color: red } @media (min-width: 1000px) { p { color: blue } }' +
      '@font-face { font-family: F; src: url(f.woff) }',
    0,
    undefined,
    null,
    under,
  );
  assert.deepStrictEqual(
    wide.rules.map((r) => r.media),
    [[[{ min: 800, max: 1366 }]], [[{ min: 800, max: 1366 }], [{ min: 1000 }]]],
    'each rule under the import, and under its own block inside that',
  );
  assert.deepStrictEqual(wide.fontFaces[0].media, [[{ min: 800, max: 1366 }]]);
  assert.deepStrictEqual(
    [...wide.breakpoints].sort((a, b) => a - b).map(Math.floor),
    [800, 1000, 1366],
    'the widths a resize restyles at',
  );
  assert.deepStrictEqual(
    [wide.imports, wide.importConditions],
    [['inner.css'], [[{ min: 1200 }]]],
    'a sheet imported under a condition may import',
  );
  assert.ok(
    mediaMatches(wide.rules[0].media, 1280) &&
      !mediaMatches(wide.rules[0].media, 1400) &&
      !mediaMatches(wide.rules[0].media, 700),
    'which hold where the import does',
  );
});

test('a sheet imported under a width is applied at that width, and dropped past it', async () => {
  const sheets: Record<string, string> = {
    'narrow.css': 'p { color: #ff0000 }',
    'wide.css': '@import "inner.css" (min-width: 450px); p { color: #0000ff }',
    'inner.css': 'p { margin-left: 30px }',
  };
  const asked: string[] = [];
  const doc = (width: number) =>
    h(
      'box',
      { style: { width, flexDirection: 'column' } },
      h(Html, {
        source:
          '<style>@import "narrow.css" (max-width: 399px);' +
          '@import "wide.css" (min-width: 400px);</style>' +
          '<p id="p">x</p>',
        partial: false,
        onResource: (r: { kind: string; url: string }) => {
          asked.push(r.url);
          return r.kind === 'stylesheet'
            ? { kind: 'stylesheet' as const, text: sheets[r.url] }
            : null;
        },
        'data-testname': 'doc',
      }),
    );
  const result = await renderX11(doc(300), { backend: 'mock' });
  const p = () =>
    boxOf(view(screen.getByTestName('doc') as DrawnNode), 'p') as unknown as {
      style: { color: string };
      marginLeft: number;
    };
  assert.deepStrictEqual(
    [p().style.color, p().marginLeft],
    ['#ff0000', 0],
    'the narrow sheet at 300',
  );
  assert.deepStrictEqual(
    [...new Set(asked)].sort(),
    ['inner.css', 'narrow.css', 'wide.css'],
    'each asked for once, whatever the width',
  );
  await result.rerender(doc(420));
  await act();
  assert.deepStrictEqual(
    [p().style.color, p().marginLeft],
    ['#0000ff', 0],
    'the wide one at 420, and not yet what it imports',
  );
  await result.rerender(doc(500));
  await act();
  assert.deepStrictEqual(
    [p().style.color, p().marginLeft],
    ['#0000ff', 30],
    'and at 500 the sheet it imports under its own width',
  );
});

test('the palette in force answers prefers-color-scheme, and a switch re-cascades', async () => {
  const source =
    '<style>p{margin:0;color:#ff0000}' +
    '@media (prefers-color-scheme: dark){p{color:#00ff00}}</style><p>x</p>';
  // The window is the test's own, so the same tree can be rendered again
  // with the provider switched: the harness's raw `root.render` does not
  // wrap, and a window is the one thing a root may hold.
  const doc = (scheme: 'light' | 'dark') =>
    h(
      'window',
      { width: 340, height: 200 } as Record<string, unknown>,
      h(
        ThemeProvider,
        { colorScheme: scheme },
        h(
          'box',
          { style: { width: 300, flexDirection: 'column' } },
          h(Html, { source, partial: false, 'data-testname': 'doc' }),
        ),
      ),
    );
  const result = await renderX11(
    doc('light'),
    FONTS ? { fonts: FONTS, wrap: false } : { backend: 'mock', wrap: false },
  );
  const colorOf = (): string | undefined => {
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const tree = (
      el as unknown as {
        _tree: { root: { children: { style: { color: string } }[] } } | null;
      }
    )._tree;
    return tree?.root.children[0]?.style.color;
  };
  assert.strictEqual(colorOf(), '#ff0000', 'the light branch under light');

  // The provider switches scheme: the look changes, and with it the answer
  // to the query — a restyle, not a re-parse.
  await act(async () => {
    result.root.render(doc('dark'));
  });
  await waitFor(() =>
    assert.strictEqual(colorOf(), '#00ff00', 'the dark branch under dark'),
  );
});

test('light-dark() takes the branch the scheme picks, wherever a colour stands', () => {
  assert.strictEqual(lightDark('light-dark(red, blue)', 'light'), 'red');
  assert.strictEqual(lightDark('light-dark(red, blue)', 'dark'), 'blue');
  // in a shorthand, with functions for branches, and the spelling's case
  assert.strictEqual(
    lightDark(
      '1px solid LIGHT-DARK(oklab(89.755% 0 -0.0001), oklch(38% 0 271))',
      'dark',
    ),
    '1px solid oklch(38% 0 271)',
  );
  // two in one value, and one inside another's branch
  assert.strictEqual(
    lightDark(
      '0 0 1px light-dark(#111, #222), 0 0 2px light-dark(light-dark(#333, #444), #555)',
      'light',
    ),
    '0 0 1px #111, 0 0 2px #333',
  );
  // a name that only ends in it is some other function
  assert.strictEqual(
    lightDark('--my-light-dark(red, blue)', 'dark'),
    '--my-light-dark(red, blue)',
  );
  // one argument, or three, is no light-dark(): the declaration is invalid
  assert.strictEqual(lightDark('light-dark(red)', 'light'), null);
  assert.strictEqual(lightDark('light-dark(red, blue, green)', 'light'), null);
  assert.strictEqual(lightDark('light-dark(, blue)', 'light'), null);
});

test("color-scheme resolves against the palette's scheme, which stands for the preference", () => {
  // the preferred one where the element supports it
  assert.strictEqual(usedColorScheme('light dark', 'dark'), 'dark');
  assert.strictEqual(usedColorScheme('light dark', 'light'), 'light');
  assert.strictEqual(usedColorScheme('dark light', 'light'), 'light');
  // else the first it names that is a scheme
  assert.strictEqual(usedColorScheme('dark', 'light'), 'dark');
  assert.strictEqual(usedColorScheme('only light', 'dark'), 'light');
  assert.strictEqual(usedColorScheme('sepia dark', 'light'), 'dark');
  // `normal`, and a list of none the renderer has: the palette's own
  assert.strictEqual(usedColorScheme('normal', 'dark'), 'dark');
  assert.strictEqual(usedColorScheme('sepia', 'dark'), 'dark');
  // not a color-scheme
  for (const bad of [
    'only',
    'light only dark',
    'normal dark',
    '12px',
    'light, dark',
  ]) {
    assert.strictEqual(usedColorScheme(bad, 'light'), null, bad);
  }
});

test('a theme of light-dark() custom properties follows the palette, and color-scheme overrides it', async () => {
  // melbcss.com's shape: every colour of the page a `light-dark()` on
  // `:root`, reached through `var()`. Unread, every one of them was
  // invalid at computed-value time: no backgrounds, no icons, no borders.
  const source =
    '<style>' +
    ':root{color-scheme:light dark;--bg:light-dark(#ff0000,#00ff00)}' +
    'p{margin:0;background-color:var(--bg);' +
    'color:light-dark(#010101,#020202);' +
    'border:1px solid light-dark(#030303,#040404)}' +
    '.light{color-scheme:light}.dark{color-scheme:only dark}' +
    '.normal{color-scheme:normal}' +
    '</style>' +
    '<p id="a">a</p><p id="l" class="light">l</p>' +
    '<div class="dark"><p id="d">d</p><p id="n" class="normal">n</p></div>';
  const doc = (scheme: 'light' | 'dark') =>
    h(
      'window',
      { width: 340, height: 200 } as Record<string, unknown>,
      h(
        ThemeProvider,
        { colorScheme: scheme },
        h(
          'box',
          { style: { width: 300, flexDirection: 'column' } },
          h(Html, { source, partial: false, 'data-testname': 'doc' }),
        ),
      ),
    );
  const result = await renderX11(
    doc('light'),
    FONTS ? { fonts: FONTS, wrap: false } : { backend: 'mock', wrap: false },
  );
  const looks = () => {
    const el = view(screen.getByTestName('doc') as DrawnNode);
    return Object.fromEntries(
      ['a', 'l', 'd', 'n'].map((id) => {
        const style = (boxOf(el, id) as unknown as { style: ComputedStyle })
          .style;
        return [
          id,
          [style.backgroundColor, style.color, style.borderTopColor].join(' '),
        ];
      }),
    );
  };
  const LIGHT = '#ff0000 #010101 #030303';
  const DARK = '#00ff00 #020202 #040404';
  assert.deepStrictEqual(looks(), { a: LIGHT, l: LIGHT, d: DARK, n: LIGHT });

  await act(async () => {
    result.root.render(doc('dark'));
  });
  // `light` alone stays light, and `normal` is the palette's again under
  // a parent that is only dark
  await waitFor(() =>
    assert.deepStrictEqual(looks(), { a: DARK, l: LIGHT, d: DARK, n: DARK }),
  );
});

test("a media range is a width's bounds", () => {
  // Media Queries 4: Tailwind 4 writes its breakpoints so
  assert.deepStrictEqual(parseMediaQuery('(width >= 48rem)'), [{ min: 768 }]);
  assert.deepStrictEqual(parseMediaQuery('(40rem <= width < 60rem)'), [
    { min: 640, max: 960 - 1 / 64 },
  ]);
  assert.deepStrictEqual(parseMediaQuery('(60rem > width)'), [
    { max: 960 - 1 / 64 },
  ]);
  assert.deepStrictEqual(parseMediaQuery('screen and (width > 30em)'), [
    { min: 480 + 1 / 64 },
  ]);
});

test("a media feature's value may hold parentheses of its own", async () => {
  // MediaWiki writes its breakpoints `(max-width: calc(640px - 1px))`: the
  // value was read to the first `)`, found no feature, and the term was
  // passed over — every narrow-screen rule held at every width, and hid
  // Wikipedia's Read, Edit and View history tabs on a desktop
  assert.deepStrictEqual(
    parseMediaQuery('screen and (max-width:calc(640px - 1px))'),
    [{ max: 639 }],
  );
  assert.deepStrictEqual(
    parseMediaQuery(
      '(min-width: calc(40rem - 1px)) and (max-width: calc(1680px - 1px))',
    ),
    [{ min: 639, max: 1679 }],
  );
  const { node } = await render(
    '<style>@media screen and (max-width:calc(200px - 1px)){#a{display:none}}' +
      '@media screen and (min-width:calc(200px - 1px)){#b{display:none}}' +
      '</style><p id="a">wide</p><p id="b">narrow</p>',
  );
  const text = view(node).textContent();
  assert.ok(text.includes('wide'), `the wide rule holds: ${text}`);
  assert.ok(!text.includes('narrow'), `and the narrow one does not: ${text}`);
});

test("device-width is the viewport's width", async () => {
  // The Web-exposed screen area may be the viewport's (CSSOM View 2.3),
  // and an element has no screen of its own. DuckDuckGo Lite keeps its
  // phone sheet under `(max-device-width: 700px)`; the feature went unread,
  // the query held at every width, and a desktop window drew the phone's
  // 12px dropdowns, measured too narrow for the caption the widget draws
  assert.deepStrictEqual(
    parseMediaQuery('only screen and (max-device-width: 700px)'),
    [{ max: 700 }],
  );
  assert.deepStrictEqual(parseMediaQuery('(min-device-width: 30em)'), [
    { min: 480 },
  ]);
  assert.deepStrictEqual(parseMediaQuery('(device-width < 700px)'), [
    { max: 700 - 1 / 64 },
  ]);
  // and device-height is the viewport's height, as height is
  assert.deepStrictEqual(parseMediaQuery('(max-device-height: 500px)'), [
    { maxHeight: 500 },
  ]);
  assert.deepStrictEqual(parseMediaQuery('(device-height >= 30em)'), [
    { minHeight: 480 },
  ]);
  // and its landscape one runs a term into the `and` after it: two terms,
  // the width's and the orientation's, which is the viewport's aspect
  assert.deepStrictEqual(
    parseMediaQuery(
      'only screen and (max-device-width: 701px)and (orientation: landscape)',
    ),
    [{ max: 701, minAspect: 1 + 1e-9 }],
  );
  const source =
    '<style>#phone{display:none}' +
    '@media only screen and (max-device-width: 700px){' +
    '#phone{display:block}#desk{display:none}}</style>' +
    '<p id="desk">desk</p><p id="phone">phone</p>';
  const wide = view((await render(source, 800)).node).textContent();
  assert.strictEqual(wide.trim(), 'desk', 'a desktop window');
  const narrow = view((await render(source, 400)).node).textContent();
  assert.strictEqual(narrow.trim(), 'phone', 'a narrow one');
});

test("a media query on the viewport's height is answered from it, and again as it moves", async () => {
  // Media Queries 4's `height` is the viewport's, as `width` is: a query
  // on it was a feature nothing read, so it held at every height, and the
  // Zen Garden's 216, which sets its heading's size in steps of the
  // window's height, took the tallest step's
  const { el, resize } = await renderScrolled(
    '<style>body{margin:0}#t{height:10px}' +
      '@media (min-height:400px){#t{height:40px}}' +
      '@media (height >= 600px){#t{height:60px}}' +
      '@media screen and (max-height:250px){#t{height:5px}}</style>' +
      '<div id="t"></div>',
    300,
  );
  const height = () => boxOf(el, 't').height;
  assert.strictEqual(height(), 10, 'at 300px, none of the queries hold');
  await resize(450);
  assert.strictEqual(height(), 40, 'min-height: 400px holds at 450');
  await resize(650);
  assert.strictEqual(height(), 60, 'and the range at 650');
  await resize(200);
  assert.strictEqual(height(), 5, 'and max-height: 250px at 200');
});

test('a media query whose size is no length does not parse, and holds nowhere', async () => {
  // Media Queries 4 (3.2): a query that does not parse is `not all`. The
  // hack `@media screen and (min-width:0\0)` kept a block of rules for
  // Internet Explorer 9 and 10, which no other browser reads; here the
  // query asked nothing and its rules applied, and the Zen Garden's 220 set
  // its banner heading at the width meant for Internet Explorer
  const { node, result } = await render(
    '<style>body{margin:0}#t{height:10px}' +
      '@media screen and (min-width:0\\0){#t{height:50px}}' +
      '@media (max-height:tall){#t{height:60px}}' +
      '@media (min-width:0){#u{height:20px}}</style>' +
      '<div id="t"></div><div id="u"></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 't').height, 10, 'neither hack applies');
  assert.strictEqual(boxOf(el, 'u').height, 20, 'a query that parses does');
  await result.unmount();
});

test('a media query on the resolution, the pointer or a feature nothing knows is answered as a desktop screen answers it', async () => {
  // Media Queries 4 makes a feature nothing knows false (3.2), and every
  // feature `<Html>` did not read held: the Zen Garden's 214 keeps its
  // high-DPI rules under `(min-resolution: 1.5dppx),
  // (min-device-pixel-ratio: 1.5)` and Firefox's and Opera's spellings
  // beside them, and at one dot to the pixel took the rules it keeps for
  // two. The resolution is the display scale's; a pointer is a mouse
  const source =
    '<style>body{margin:0}div{height:10px}' +
    '@media (min-resolution:1.5dppx),(-webkit-min-device-pixel-ratio:1.5)' +
    '{#r{height:20px}}' +
    '@media (min--moz-device-pixel-ratio:1.5),(min-device-pixel-ratio:1.5),' +
    '(unknown-feature:1){#u{height:30px}}' +
    '@media (hover:hover) and (pointer:fine) and (color){#p{height:40px}}' +
    '</style><div id="r"></div><div id="u"></div><div id="p"></div>';
  const cases: [string, (s: string) => Promise<{ node: DrawnNode }>, number][] =
    [
      ['1x', (s) => render(s), 1],
      ['2x', (s) => render2x(s), 2],
    ];
  for (const [name, draw, scale] of cases) {
    const { node } = await draw(source);
    const el = view(node);
    const css = (id: string) => boxOf(el, id).height / scale;
    assert.strictEqual(
      css('r'),
      scale >= 1.5 ? 20 : 10,
      `${name}: the high-DPI rule holds at 2x and not at 1x`,
    );
    assert.strictEqual(css('u'), 10, `${name}: features nothing knows fail`);
    assert.strictEqual(css('p'), 40, `${name}: a mouse hovers and is fine`);
  }

  // and the orientation is the viewport's, as it moves
  const { el, resize } = await renderScrolled(
    '<style>body{margin:0}#o{height:10px}' +
      '@media (orientation:portrait){#o{height:20px}}</style>' +
      '<div id="o"></div>',
    300,
  );
  assert.strictEqual(boxOf(el, 'o').height, 10, '400 by 300 is landscape');
  await resize(500);
  assert.strictEqual(boxOf(el, 'o').height, 20, '400 by 500 is portrait');
  await resize(500, 800);
  assert.strictEqual(
    boxOf(el, 'o').height,
    10,
    'and 800 by 500 landscape again, a change of width alone',
  );
});
