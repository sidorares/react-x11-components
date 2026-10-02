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
import { animationClock } from '../../src/html/node.js';
import { lightDark, usedColorScheme } from '../../src/html/css/color.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import {
  FONTS,
  boxOf,
  fillsOf,
  h,
  render,
  render2x,
  renderScrolled,
  view,
} from './harness.js';
import { holdClock } from '../held-clock.js';

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

test("a sheet's media attribute is the condition it is under, and one that holds nowhere leaves it out", () => {
  // HTML 4.2.4, 4.2.6: a `<link>` or a `<style>` applies where its `media`
  // matches. The attribute was a string check: a query that started with
  // `(` held at every width, so a phone sheet styled a desktop window, and
  // one that started with `not` held at none
  const source = new HtmlSource();
  source.setSource(
    '<style media="(max-width: 600px)">a{}</style>' +
      '<style media="not all and (min-width: 640px)">b{}</style>' +
      '<style media="screen">c{}</style>' +
      '<style media="">d{}</style>' +
      '<style media="print">e{}</style>' +
      '<style media="speech, (min-height: 500px)">f{}</style>' +
      '<style media="tv and (min-width: 1px)">g{}</style>' +
      '<link rel="stylesheet" href="phone.css" media="(max-width: 600px)">' +
      '<link rel="stylesheet" href="print.css" media="print">' +
      '<link rel="stylesheet" href="all.css">',
    true,
  );
  const { sheets, resources } = source.facts();
  assert.deepStrictEqual(
    sheets.map((s) => (s.kind === 'inline' ? s.text : s.href)),
    ['a{}', 'b{}', 'c{}', 'd{}', 'f{}', 'phone.css', 'all.css'],
    'a list that holds nowhere leaves its sheet out',
  );
  assert.deepStrictEqual(
    sheets.map((s) => s.media),
    [
      [{ max: 600 }],
      [{ max: 640 - 1 / 64 }],
      null,
      null,
      [{ staticPass: false }, { minHeight: 500 }],
      [{ max: 600 }],
      null,
    ],
    'any other is its condition, and one that always holds none',
  );
  assert.deepStrictEqual(
    resources.map((el) => el.attribs.href),
    ['phone.css', 'all.css'],
    'a link under a width is asked for, and one left out is not',
  );
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

test('a sheet under its media attribute applies where it holds, and a resize across one restyles', async () => {
  const sheets: Record<string, string> = {
    'phone.css':
      '@import "tiny.css" (max-width: 300px); #p { margin-left: 10px }',
    'tiny.css': '#t { margin-left: 20px }',
    'print.css': '#p { margin-left: 99px }',
  };
  const asked: string[] = [];
  const doc = (width: number) =>
    h(
      'box',
      { style: { width, flexDirection: 'column' } },
      h(Html, {
        source:
          '<link rel="stylesheet" href="phone.css" media="(max-width: 600px)">' +
          '<link rel="stylesheet" href="print.css" media="print">' +
          '<style media="not all and (min-width: 640px)">#q { margin-left: 30px }</style>' +
          '<p id="p">p</p><p id="t">t</p><p id="q">q</p>',
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
  const result = await renderX11(doc(800), { backend: 'mock' });
  const margins = () =>
    ['p', 't', 'q'].map(
      (id) =>
        (
          boxOf(
            view(screen.getByTestName('doc') as DrawnNode),
            id,
          ) as unknown as { marginLeft: number }
        ).marginLeft,
    );
  assert.deepStrictEqual(margins(), [0, 0, 0], 'none of them at 800');
  assert.deepStrictEqual(
    [...new Set(asked)].sort(),
    ['phone.css', 'tiny.css'],
    'the phone sheet asked for at 800, and what it imports, and the print one not',
  );
  for (const [width, expected] of [
    [620, [0, 0, 30]],
    [500, [10, 0, 30]],
    [250, [10, 20, 30]],
    [800, [0, 0, 0]],
  ] as const) {
    await result.rerender(doc(width));
    await act();
    assert.deepStrictEqual(margins(), expected, `at ${width}`);
  }
});

test('a sheet under its media attribute stays parsed through an append, and is parsed again under another', async () => {
  // the document's facts are made again at every revision, so the
  // conditions are compared by what they are rather than which list
  const doc = (source: string) =>
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source, 'data-testname': 'doc' }),
    );
  const sheet = (media: string) =>
    `<style media="${media}">p { color: #0b0b0b }</style><p id="a">one</p>`;
  const head = sheet('(max-width: 600px)');
  const result = await renderX11(doc(head), { backend: 'mock' });
  const el = () => view(screen.getByTestName('doc') as DrawnNode);
  const cascadeOf = () => (el() as unknown as { _cascade: unknown })._cascade;
  const color = () =>
    (boxOf(el(), 'a') as unknown as { style: { color: string } }).style.color;
  el().textContent();
  const before = cascadeOf();
  assert.strictEqual(color(), '#0b0b0b', 'the sheet holds at 300');
  await act(() => result.rerender(doc(head + '<p>two</p>')));
  assert.strictEqual(el().textContent(), 'onetwo');
  assert.strictEqual(cascadeOf(), before, 'the same cascade after an append');
  await act(() =>
    result.rerender(doc(sheet('(min-width: 600px)') + '<p>two</p>')),
  );
  el().textContent();
  assert.notStrictEqual(cascadeOf(), before, 'another under another media');
  assert.notStrictEqual(color(), '#0b0b0b', 'which does not hold at 300');
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

test('a document of the scheme the palette is not is drawn on that scheme’s canvas, in its colours', async () => {
  // CSS Color Adjust 1, 2.2: the canvas, the initial `color` and the
  // system colours follow the root's used scheme, and a document embedded
  // on a transparent canvas whose scheme is not its embedder's gets an
  // opaque one. A Docusaurus page is `color-scheme: light` with its text
  // dark and no background at all — a script picks the dark theme — and
  // was dark text on the dark palette's ground.
  const page = (scheme: string, more = '') =>
    `<style>:root{color-scheme:${scheme}}body{margin:0}${more}</style>` +
    '<p id="p">x <a id="a" href="#">y</a></p>';
  const doc = (source: string, palette: 'light' | 'dark') =>
    h(
      'window',
      { width: 340, height: 200 } as Record<string, unknown>,
      h(
        ThemeProvider,
        { colorScheme: palette },
        h(
          'box',
          { style: { width: 300, flexDirection: 'column' } },
          h(Html, { source, partial: false, 'data-testname': 'doc' }),
        ),
      ),
    );
  const result = await renderX11(
    doc(page('light'), 'dark'),
    FONTS ? { fonts: FONTS, wrap: false } : { backend: 'mock', wrap: false },
  );
  const look = async () => {
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const color = (id: string) =>
      (boxOf(el, id) as unknown as { style: ComputedStyle }).style.color;
    const fills = await fillsOf(el);
    return {
      // what is filled across the element: a link's underline is a fill too
      canvas: fills.filter((f) => f.w === 300).map((f) => f.style),
      text: color('p'),
      link: color('a'),
    };
  };
  const show = async (source: string, palette: 'light' | 'dark') => {
    await act(async () => {
      result.root.render(doc(source, palette));
    });
    for (let i = 0; i < 4; i += 1) await act();
    return look();
  };
  assert.deepStrictEqual(
    await look(),
    { canvas: ['#ffffff'], text: '#000000', link: '#0000ee' },
    'a light page under a dark palette',
  );
  // a page of both schemes, or of none it names, is the palette's: no
  // canvas of its own, and the palette's text and links
  const both = await show(page('light dark'), 'dark');
  assert.deepStrictEqual(both.canvas, [], 'the palette’s ground shows');
  assert.notStrictEqual(both.text, '#000000');
  assert.deepStrictEqual(await show(page('normal'), 'dark'), both);
  // the palette turned light: the light page is of its scheme now
  const light = await show(page('light'), 'light');
  assert.deepStrictEqual(light.canvas, []);
  assert.notStrictEqual(light.text, both.text, 'the light palette’s text');
  // and a dark page under it is a browser's dark
  const DARK_PAGE = { canvas: ['#121212'], text: '#ffffff', link: '#9e9eff' };
  assert.deepStrictEqual(await show(page('dark'), 'light'), DARK_PAGE);
  // a `<meta name="color-scheme">` says it as well, where no rule sets the
  // root's (HTML 4.2.5.4), in a fragment and in a whole document
  const meta = (content: string, more = '') =>
    `<meta name="color-scheme" content="${content}">` +
    `<style>body{margin:0}${more}</style>` +
    '<p id="p">x <a id="a" href="#">y</a></p>';
  assert.deepStrictEqual(await show(meta('dark'), 'light'), DARK_PAGE);
  assert.deepStrictEqual(
    await show(
      '<!doctype html><html><head><meta name="color-scheme" ' +
        'content="only dark"><style>body{margin:0}</style></head><body>' +
        '<p id="p">x <a id="a" href="#">y</a></p></body></html>',
      'light',
    ),
    DARK_PAGE,
  );
  // a rule over it, and a content that is no scheme
  const ruled = await show(meta('dark', ':root{color-scheme:light}'), 'light');
  assert.deepStrictEqual(ruled.canvas, []);
  assert.deepStrictEqual((await show(meta('only'), 'light')).canvas, []);
  // the page's own colours are over the scheme's: its background over
  // the canvas, its text where it sets one
  assert.deepStrictEqual(
    await show(
      page('light', 'html{background:#ff0000}p{color:#010101}'),
      'dark',
    ),
    {
      canvas: ['#ffffff', '#ff0000'],
      text: '#010101',
      link: '#0000ee',
    },
  );
});

test("a system colour is the palette's in its scheme, and Chrome's in the other", async () => {
  // CSS Color 4, 6.2: `Canvas`, `CanvasText`, `ButtonBorder` and the rest
  // name the platform's colours, and the palette is this renderer's
  // platform. The deprecated ones are the same as one of them (6.3), and
  // a name a system colour has is no colour where a property takes none.
  const source =
    '<style>body{margin:0}p{margin:0}' +
    '#a,#d{background-color:Canvas;color:CanvasText;' +
    'border:1px solid ButtonBorder}' +
    '#b{background-color:Window;color:WindowText;' +
    'border:1px solid ThreeDShadow}' +
    '.dark{color-scheme:only dark}#e{font-family:Mark, serif}</style>' +
    '<p id="a">a</p><p id="b">b</p>' +
    '<div class="dark"><p id="d">d</p></div><p id="e">e</p>';
  await renderX11(
    h(
      'window',
      { width: 340, height: 200 } as Record<string, unknown>,
      h(
        ThemeProvider,
        { colorScheme: 'light' },
        h(
          'box',
          { style: { width: 300, flexDirection: 'column' } },
          h(Html, { source, partial: false, 'data-testname': 'doc' }),
        ),
      ),
    ),
    FONTS ? { fonts: FONTS, wrap: false } : { backend: 'mock', wrap: false },
  );
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: ComputedStyle }).style;
  const look = (id: string) => {
    const s = style(id);
    return [s.backgroundColor, s.color, s.borderTopColor];
  };
  // the light palette's ground, ink and border
  assert.deepStrictEqual(look('a'), ['white', '#2d3436', '#b2bec3']);
  assert.deepStrictEqual(look('b'), look('a'));
  assert.deepStrictEqual(look('d'), ['#121212', '#ffffff', '#6b6b6b']);
  assert.match(style('e').fontFamily, /Mark/);
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

test('a media query joins features with or, and its not is the other side of each', () => {
  // Media Queries 4, 3. `(max-width: 600px) or (min-width: 900px)` was one
  // term that was no feature and no medium, passed over, and its rules held
  // at every width; `not (max-width: 600px)` was decided once, and held at
  // none. A `not` over a width is a bound on its other side, just past it,
  // so its breakpoint is the one the width it negates has.
  const sheet = parseStylesheet(
    '@media (max-width: 600px) or (min-width: 900px) { p { color: red } }' +
      '@media not (max-width: 600px) { p { color: blue } }' +
      '@media not all and (min-width: 640px) { p { color: green } }',
  );
  assert.deepStrictEqual(
    sheet.rules.map((r) => r.media),
    [
      [[{ max: 600 }, { min: 900 }]],
      [[{ min: 600 + 1 / 64 }]],
      // Tailwind 3 writes its `max-sm:` variant so
      [[{ max: 640 - 1 / 64 }]],
    ],
  );
  assert.deepStrictEqual(sheet.breakpoints, [600 + 1 / 64, 640, 900]);

  // Each row is where Chrome 154, Firefox and WebKit hold the query, by
  // `matchMedia`, at each of these widths.
  const widths = [300, 500, 600, 601, 700, 800, 900, 1000];
  const rows: [string, string][] = [
    ['(max-width: 600px) or (min-width: 900px)', '111...11'],
    ['(max-width: 600px) OR (min-width: 900px)', '111...11'],
    ['(max-width: 600px)or (min-width: 900px)', '111...11'],
    ['(width > 600px) or (width < 300px)', '...11111'],
    ['not (max-width: 600px)', '...11111'],
    ['not (width > 600px)', '111.....'],
    ['not (width: 600px)', '11.11111'],
    ['not (400px <= width <= 700px)', '1....111'],
    ['not all and (max-width: 600px)', '...11111'],
    ['screen and not (max-width: 600px)', '...11111'],
    ['not (not (not (max-width: 600px)))', '...11111'],
    ['not ((max-width: 600px) or (min-width: 900px))', '...111..'],
    [
      '((max-width: 600px) or (min-width: 900px)) and (min-width: 400px)',
      '.11...11',
    ],
    [
      '(max-width: 600px) and ((min-width: 400px) or (min-width: 900px))',
      '.11.....',
    ],
    ['not ((min-width: 900px) and (max-width: 600px))', '11111111'],
    // `and` and `or` at one level, a `not` before more than one part, `only`
    // before no medium and a function where `or` should be are no queries
    [
      '(max-width: 600px) and (min-width: 100px) or (min-width: 900px)',
      '........',
    ],
    ['screen and (max-width: 600px) or (min-width: 900px)', '........'],
    ['not (max-width: 600px) and (min-width: 100px)', '........'],
    ['not (max-width: 600px) or (min-width: 900px)', '........'],
    ['(max-width: 600px)or(min-width: 900px)', '........'],
    ['only (max-width: 600px)', '........'],
    ['(min-width: 600px) or print', '........'],
    // a feature nothing knows, or a value its feature does not take, is
    // neither true nor false, under a `not` as well
    ['not (unknown-feature: 1)', '........'],
    ['not (min-width: tall)', '........'],
    ['not (min-width: 0\\0)', '........'],
    ['not (prefers-color-scheme: no-preference)', '........'],
    ['not (hover: bogus)', '........'],
    ['not func(x)', '........'],
    ['(min-width: tall) or (min-width: 0)', '11111111'],
    ['not ((unknown: 1) and (min-width: 600px))', '11......'],
    ['not ((unknown: 1) or (min-width: 600px))', '........'],
    ['not screen and (unknown: 1)', '........'],
    ['not print and (unknown: 1)', '11111111'],
    ['not (hover)', '........'],
    ['not (hover: none)', '11111111'],
    ['not (monochrome)', '11111111'],
  ];
  for (const [query, holds] of rows) {
    const media = [parseMediaQuery(query)];
    const ours = widths
      .map((w) => (mediaMatches(media, w, 'light', 600) ? '1' : '.'))
      .join('');
    assert.strictEqual(ours, holds, query);
  }

  // the opposite of a scheme is the other one, and of a run of tests any
  // one of their opposites
  assert.deepStrictEqual(
    parseMediaQuery(
      'not ((prefers-color-scheme: dark) and (max-width: 600px))',
    ),
    [{ scheme: 'light' }, { min: 600 + 1 / 64 }],
  );
  // and a square viewport is portrait, so it is not landscape
  const landscape = [parseMediaQuery('not (orientation: landscape)')];
  assert.ok(mediaMatches(landscape, 500, 'light', 500));
  assert.ok(!mediaMatches(landscape, 501, 'light', 500));
});

test('a document restyles across the widths an or and a not change their minds at', async () => {
  const { el, resize } = await renderScrolled(
    '<style>body{margin:0}div{height:10px}' +
      '@media (max-width:300px) or (min-width:500px){#or{height:20px}}' +
      '@media not (max-width:300px){#not{height:20px}}' +
      '@media not all and (min-width:500px){#max{height:20px}}' +
      '@media not ((max-width:300px) or (min-width:500px)){#mid{height:20px}}' +
      '</style><div id="or"></div><div id="not"></div>' +
      '<div id="max"></div><div id="mid"></div>',
    300,
    250,
  );
  const heights = () =>
    ['or', 'not', 'max', 'mid'].map((id) => boxOf(el, id).height);
  assert.deepStrictEqual(heights(), [20, 10, 20, 10], 'at 250');
  await resize(300, 400);
  assert.deepStrictEqual(heights(), [10, 20, 20, 20], 'at 400');
  await resize(300, 550);
  assert.deepStrictEqual(heights(), [20, 20, 10, 10], 'at 550');
  await resize(300, 250);
  assert.deepStrictEqual(heights(), [20, 10, 20, 10], 'and back at 250');
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
    [{ max: 701, minAspect: 1 + 2 ** -30 }],
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

test("prefers-reduced-motion is answered from the desktop's setting, as a browser answers it under each", () => {
  // It answered neither value while nothing here moved, so a page that
  // keeps its animations under `no-preference` lost them, and one that
  // writes the reduced branch as `not (… no-preference)` took it; then it
  // answered `no-preference` whatever the desktop said. Each row is where
  // Chromium 151, Firefox 153 and WebKit 26.5 hold the query, by
  // `matchMedia`, at 500px and at 1000px — with no preference, then with
  // Playwright's `reducedMotion: 'reduce'` — and all three agree on every
  // one. The opposite of one preference is the other, as the opposite of
  // a scheme is the other scheme.
  const rows: [string, string, string][] = [
    ['(prefers-reduced-motion: no-preference)', '11', '..'],
    ['(PREFERS-REDUCED-MOTION: No-Preference)', '11', '..'],
    ['screen and (prefers-reduced-motion: no-preference)', '11', '..'],
    ['(prefers-reduced-motion: reduce)', '..', '11'],
    // the boolean context: anything but `no-preference`
    ['(prefers-reduced-motion)', '..', '11'],
    ['not (prefers-reduced-motion: no-preference)', '..', '11'],
    ['not (prefers-reduced-motion: reduce)', '11', '..'],
    ['not (prefers-reduced-motion)', '11', '..'],
    ['not all and (prefers-reduced-motion: reduce)', '11', '..'],
    ['not all and (prefers-reduced-motion)', '11', '..'],
    ['(prefers-reduced-motion: reduce) or (min-width: 600px)', '.1', '11'],
    [
      '(prefers-reduced-motion: no-preference) or (min-width: 600px)',
      '11',
      '.1',
    ],
    ['(prefers-reduced-motion: reduce) and (min-width: 600px)', '..', '.1'],
    [
      'not ((prefers-reduced-motion: reduce) and (min-width: 600px))',
      '11',
      '1.',
    ],
    ['not ((prefers-reduced-motion) or (max-width: 600px))', '.1', '..'],
    // both at once holds nowhere
    [
      '(prefers-reduced-motion: reduce) and (prefers-reduced-motion: no-preference)',
      '..',
      '..',
    ],
    // a value it does not take is neither true nor false, and it is no
    // range feature
    ['(prefers-reduced-motion: bogus)', '..', '..'],
    ['not (prefers-reduced-motion: bogus)', '..', '..'],
    ['(min-prefers-reduced-motion: reduce)', '..', '..'],
  ];
  for (const [query, still, reduced] of rows) {
    const media = [parseMediaQuery(query)];
    const at = (reducedMotion: boolean) =>
      [500, 1000]
        .map((w) =>
          mediaMatches(media, w, 'light', 600, 1, reducedMotion) ? '1' : '.',
        )
        .join('');
    assert.strictEqual(at(false), still, `${query}, no preference`);
    assert.strictEqual(at(true), reduced, `${query}, reduce`);
  }
  // asked nothing about it, the answer is no preference
  assert.ok(
    mediaMatches(
      [parseMediaQuery('(prefers-reduced-motion: no-preference)')],
      800,
    ),
  );
});

test('a page animated under (prefers-reduced-motion: no-preference) runs its animations, and holds them at rest under animate={false}', async (t) => {
  // joshwcomeau.com writes its animations so, and hides under the same
  // query what it shows under `reduce`. `animate={false}` holds the page's
  // animations at rest and asks for no less motion: the reduced branch is
  // another page, and Chrome, which the Zen Garden bench holds still with
  // every animation at no length, draws this one. With no `reducedMotion`, the
  // desktop's setting answers, which the harness pins at no preference.
  const source =
    '<style>body{margin:0}div{height:10px}' +
    '@keyframes grow{to{height:30px}}' +
    '@media (prefers-reduced-motion:no-preference)' +
    '{#a{animation:grow 160ms linear forwards}}' +
    '@media (prefers-reduced-motion:reduce){#b{height:20px}}' +
    '@media not (prefers-reduced-motion:no-preference){#c{height:20px}}' +
    '@media (prefers-reduced-motion){#d{height:20px}}' +
    '</style><div id="a"></div><div id="b"></div><div id="c"></div>' +
    '<div id="d"></div>';
  const heights = (el: ReturnType<typeof view>) =>
    ['a', 'b', 'c', 'd'].map((id) => boxOf(el, id).height);

  const clock = holdClock(t, animationClock);
  const first = await render(source);
  const running = view(first.node);
  assert.deepStrictEqual(heights(running), [10, 10, 10, 10], 'as it starts');
  assert.ok(clock.pending, 'the animation asks for its frames');
  for (let i = 0; i < 5; i++) await clock.frame();
  await act();
  assert.strictEqual(boxOf(running, 'a').height, 20, 'halfway through');
  await clock.finish();
  await act();
  assert.deepStrictEqual(heights(running), [30, 10, 10, 10], 'at its end');
  await first.result.unmount();

  const still = view((await render(source, 400, { animate: false })).node);
  assert.deepStrictEqual(
    heights(still),
    [30, 10, 10, 10],
    'at rest it holds the frame it ends on, and no reduced branch is taken',
  );
});

test('a document restyles when the desktop asks for less motion, and again when it stops, over the sheets it parsed', async (t) => {
  // The setting is the desktop's (`useSystemAppearance().reducedMotion`),
  // which the harness pins at no preference and offers a test no way to
  // change, so the change comes in through the prop that overrides it:
  // the same path to the element, from the same render.
  const source =
    '<style>body{margin:0}div{height:10px}' +
    '@keyframes grow{to{height:30px}}' +
    '@media (prefers-reduced-motion:no-preference)' +
    '{#a{animation:grow 160ms linear forwards}}' +
    '@media (prefers-reduced-motion:reduce){#b{height:20px}}' +
    '@media not (prefers-reduced-motion:no-preference){#c{height:20px}}' +
    '@media (prefers-reduced-motion){#d{height:20px}}' +
    // a shadow tree's part, which the page's rules reach from outside
    '@media (prefers-reduced-motion:reduce){x-card::part(e){height:20px}}' +
    '</style><div id="a"></div><div id="b"></div><div id="c"></div>' +
    '<div id="d"></div><x-card><template shadowrootmode="open">' +
    '<div id="e" part="e"></div></template></x-card>';
  const doc = (props: Record<string, unknown>) =>
    h(
      'box',
      { style: { width: 400, flexDirection: 'column' } },
      h(Html, { source, partial: false, 'data-testname': 'doc', ...props }),
    );
  const el = () => view(screen.getByTestName('doc') as DrawnNode);
  const heights = () =>
    ['a', 'b', 'c', 'd', 'e'].map((id) => boxOf(el(), id).height);
  const cascadeOf = () => (el() as unknown as { _cascade: unknown })._cascade;

  const clock = holdClock(t, animationClock);
  const { result } = await render(source, 400, { reducedMotion: true });
  assert.deepStrictEqual(heights(), [10, 20, 20, 20, 20], 'the reduced branch');
  assert.ok(!clock.pending, 'and nothing animates in it');
  const parsed = cascadeOf();

  await result.rerender(doc({ reducedMotion: false }));
  await act();
  assert.deepStrictEqual(heights(), [10, 10, 10, 10, 0], 'the page that moves');
  assert.ok(clock.pending, 'its animation asks for its frames');
  assert.strictEqual(cascadeOf(), parsed, 'a restyle, not a parse');
  await clock.finish();
  await act();
  assert.deepStrictEqual(heights(), [30, 10, 10, 10, 0], 'and runs to its end');

  // and back, live, as a browser follows the setting: the animation, and
  // the frame it filled forwards with, go with the branch they were in
  await result.rerender(doc({ reducedMotion: true }));
  await act();
  assert.deepStrictEqual(heights(), [10, 20, 20, 20, 20], 'reduced again');
  assert.ok(!clock.pending, 'with nothing left asking for a frame');
  assert.strictEqual(cascadeOf(), parsed, 'over the same sheets');

  // `animate={false}` is no answer to it either way: held at rest, the
  // page is the one the setting picks
  await result.rerender(doc({ reducedMotion: true, animate: false }));
  await act();
  assert.deepStrictEqual(heights(), [10, 20, 20, 20, 20], 'reduced, held');
  await result.rerender(doc({ reducedMotion: false, animate: false }));
  await act();
  assert.deepStrictEqual(heights(), [30, 10, 10, 10, 0], 'moving, held');
});

test("a <picture>'s source under prefers-reduced-motion is chosen again when the setting changes", async () => {
  // A still frame in place of an animated image is what the feature is
  // most often written for in markup: the source the setting picks is
  // asked for, at the first choice and at a change.
  const source =
    '<picture>' +
    '<source media="(prefers-reduced-motion: reduce)" srcset="still.png">' +
    '<img id="a" src="moving.gif"></picture>';
  const asked: string[] = [];
  const onResource = (r: { url: string; kind: string }) => {
    if (r.kind === 'image') asked.push(r.url);
    return null;
  };
  const doc = (reducedMotion: boolean) =>
    h(
      'box',
      { style: { width: 400, flexDirection: 'column' } },
      h(Html, {
        source,
        partial: false,
        reducedMotion,
        onResource,
        'data-testname': 'doc',
      }),
    );
  const { result } = await render(source, 400, {
    reducedMotion: false,
    onResource,
  });
  await act();
  assert.deepStrictEqual(asked, ['moving.gif'], 'with no preference');
  await result.rerender(doc(true));
  await act();
  assert.deepStrictEqual(asked, ['moving.gif', 'still.png'], 'under reduce');
});
