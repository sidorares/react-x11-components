// <Html> — the pure halves are tested directly (the CSS parser, the cascade
// and the box tree are where every subtle bug lives, and none of them needs
// a display), the widget through the harness: the mock backend for structure
// and registration, the in-process X server for anything that depends on real
// font metrics — layout, selection, hit testing.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';

import {
  renderX11,
  cleanup,
  screen,
  fireEvent,
  act,
  expectPixel,
  isNear,
  pixelAt,
  waitFor,
} from 'react-x11/test';
import type { RenderX11Options } from 'react-x11/test';
import { drawnKinds, registeredElements } from 'react-x11/host';
import type { DrawnNode } from 'react-x11';
import { ThemeProvider } from 'react-x11';

import { Html } from '../src/index.js';
import { HtmlViewNode } from '../src/html/index.js';
import type { FontsLike } from '../src/html/layout/inline.js';
import { featuresOf, hungSpaces } from '../src/html/layout/inline.js';
import {
  CounterStyles,
  counterStyleRule,
} from '../src/html/css/counter-styles.js';
import type { CounterStyleRule } from '../src/html/css/counter-styles.js';
import { sizeTracks } from '../src/html/layout/tracks.js';
import { cocoaShapedLayout } from './cocoa-shaped.js';
import type { ShapedLayout } from './cocoa-shaped.js';
import {
  mediaMatches,
  parseMediaQuery,
  parseStylesheet,
  parseDeclarations,
  specificityOf,
} from '../src/html/css/parse.js';
import {
  parseColor,
  parseLength,
  parseNumber,
  resolve,
  resolveOrNull,
  splitValue,
  isTransparent,
} from '../src/html/css/values.js';
import {
  HtmlSource,
  parseFragment,
  appendChild,
  createElement,
  rawTextOf,
} from '../src/html/dom.js';
import {
  counterText,
  parseContent,
  parseCounterList,
  parseQuotes,
} from '../src/html/css/content.js';
import { decodeStylesheet } from '../src/html/css/decode.js';
import {
  INHERITED,
  NO_BORDER_IMAGE,
  inherit,
  initialStyle,
} from '../src/html/css/style.js';
import type { BorderImage, ComputedStyle } from '../src/html/css/style.js';
import { SurfaceCache } from '../src/html/surfaces.js';

const h = React.createElement;

afterEach(cleanup);

// Real font files, so metrics are machine-stable. Both families ship with
// macOS and the Linux paths cover the common distros; a box with neither
// skips the metric-dependent tests rather than failing them.
const FONT_CANDIDATES: Array<[string, string]> = [
  [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Monaco.ttf',
  ],
  [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  ],
];
const found = FONT_CANDIDATES.find(
  ([sans, mono]) => existsSync(sans) && existsSync(mono),
);
const FONTS = found ? { 'sans-serif': found[0], monospace: found[1] } : null;

function view(node: DrawnNode): HtmlViewNode {
  return (node as unknown as { children: HtmlViewNode[] }).children[0];
}

async function render(source: string, width = 400) {
  const result = await renderX11(
    h(
      'box',
      { style: { width, flexDirection: 'column' } },
      h(Html, { source, partial: false, 'data-testname': 'doc' }),
    ),
    FONTS
      ? { width: width + 40, height: 600, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  return { result, node: screen.getByTestName('doc') as DrawnNode };
}

// --- the CSS parser ---------------------------------------------------------

test('declarations survive semicolons, comments and !important', () => {
  const decls = parseDeclarations(
    'color: red; /* a note; with a semicolon */ margin : 0 auto ; width:50% !important',
  );
  assert.deepStrictEqual(
    decls.map((d) => [d.prop, d.value, d.important]),
    [
      ['color', 'red', false],
      ['margin', '0 auto', false],
      ['width', '50%', true],
    ],
  );
});

test('pseudo-class names and :lang() fold ASCII case only', async () => {
  // CSS 2.1 4.1.3: `:LINK` is `:link`, but a Kelvin sign is no K, where
  // Unicode's lower case makes one of it — and a rule with no pseudo-class
  // CSS knows is dropped
  const { node } = await render(
    '<style>p { color: #0000ff } :LiNk { color: #00ff00 }' +
      ' :lin\u212a { color: #ff0000 } :lang(\u212al) { color: #ff0000 }' +
      ' :lang(KL) { font-style: italic }</style>' +
      '<p><a id="a" href="x">link</a></p><p id="k" lang="kl">kl</p>',
  );
  const el = view(node);
  const style = (id: string) =>
    (boxOf(el, id) as LaidBox & { style: { color: string; fontStyle: string } })
      .style;
  assert.strictEqual(style('a').color, '#00ff00');
  assert.strictEqual(style('k').color, '#0000ff', 'not a K');
  assert.strictEqual(style('k').fontStyle, 'italic', 'but KL is kl');
});

test("a document's language is its meta's, where no element says", async () => {
  // HTML's pragma-set default language: `<meta http-equiv=
  // "content-language">` is the language of what no `lang` covers
  const { node } = await render(
    '<meta http-equiv="content-language" content="fr">' +
      '<style>:lang(fr) { color: #00ff00 } :lang(de) { color: #0000ff }</style>' +
      '<p id="a">a</p><div lang="de"><p id="b">b</p></div>',
  );
  const el = view(node);
  const color = (id: string) =>
    (boxOf(el, id) as LaidBox & { style: { color: string } }).style.color;
  assert.strictEqual(color('a'), '#00ff00', "the document's");
  assert.strictEqual(color('b'), '#0000ff', "an element's own wins");
});

test('an attribute operator needs a value, and an empty word is none', async () => {
  // `[title~=]` is no selector, and takes its group (CSS 2.1 4.1.7); and
  // `[title~=""]` represents nothing (Selectors 3, 6.3.1), where it was
  // taken for the empty word between two spaces
  const { node } = await render(
    '<style>p { color: #00ff00 } [title~=], p.a { color: #ff0000 }' +
      ' [title~=""] { color: #ff0000 }</style>' +
      '<p id="a" class="a">a</p><p id="b" title=" ">b</p>' +
      '<p id="c" title="">c</p>',
  );
  const el = view(node);
  const color = (id: string) =>
    (boxOf(el, id) as LaidBox & { style: { color: string } }).style.color;
  assert.deepStrictEqual(['a', 'b', 'c'].map(color), [
    '#00ff00',
    '#00ff00',
    '#00ff00',
  ]);
});

test('a selector list becomes one rule per selector', () => {
  const sheet = parseStylesheet('h1, h2 > .lead { color: red }');
  assert.deepStrictEqual(
    sheet.rules.map((r) => r.selector),
    ['h1', 'h2 > .lead'],
  );
});

test('specificity counts ids, classes and types', () => {
  assert.ok(specificityOf('#a') > specificityOf('.a.b.c'));
  assert.ok(specificityOf('.a') > specificityOf('div span p'));
  assert.strictEqual(specificityOf('div'), specificityOf('p'));
  // an attribute test and a pseudo-class both count as a class
  assert.strictEqual(specificityOf('a[href]'), specificityOf('a.x'));
});

test('a universal selector counts nothing, and does not stop the scan', () => {
  // The scan took `*` and `|` for the start of a name and then skipped
  // none of it, so it stood still on them for ever: `* { margin: 0 }` —
  // the commonest reset there is — hung the parser and the app with it.
  assert.strictEqual(specificityOf('*'), 0);
  assert.strictEqual(specificityOf('.tests *'), specificityOf('.tests'));
  assert.strictEqual(specificityOf('div > * + p'), specificityOf('div p'));
  assert.strictEqual(specificityOf('*|p'), specificityOf('p'));
  assert.strictEqual(specificityOf('.café'), specificityOf('.cafe'));
  const sheet = parseStylesheet('* { margin: 0 } .tests * { color: red }');
  assert.strictEqual(sheet.rules.length, 2);
});

test('a comment inside a selector leaves the rule standing', () => {
  // CSS drops a comment wherever it stands. One between a selector and its
  // brace stayed in the selector, the matcher refused it, and the rule went.
  const sheet = parseStylesheet(
    '[id=a] /* 0,0,1,0 */ { color: green }\n' +
      'div /* 0,0,0,1 */ { color: red }\n' +
      '.a/**/.b { color: blue }\n' +
      'p { content: "/* kept */" }\n' +
      // an escaped slash starts no comment: the declaration after it stands
      'q { \\/*; color: green; */ }',
  );
  assert.deepStrictEqual(
    sheet.rules.map((r) => [r.selector, r.declarations[0].value]),
    [
      ['[id=a]', 'green'],
      ['div', 'red'],
      ['.a.b', 'blue'],
      ['p', '"/* kept */"'],
      ['q', 'green'],
    ],
  );
});

test('a block the end of the sheet cuts off keeps all of its body', () => {
  // The end of a style sheet closes what is open (CSS 2.1 4.2). The block
  // reader took the last character for the `}` it expected and cut it.
  const sheet = parseStylesheet('p { color: red } div { color: blue');
  assert.deepStrictEqual(
    sheet.rules.map((r) => r.declarations.map((d) => d.value)),
    [['red'], ['blue']],
  );
});

test('a colour ntk cannot read is dropped, and one left open at the end is closed', () => {
  // A functional colour was passed through unread, and ntk's X11 context
  // throws on one it cannot parse — from inside paint, so `rgb(foo)` in a
  // stylesheet took the application down. CSS ignores an invalid value.
  assert.strictEqual(parseColor('rgb(foo)'), null);
  assert.strictEqual(parseColor('rgb(0, 128, 0)'), '#008000');
  // the end of a style sheet closes what is open (CSS 2.1 4.2)
  assert.strictEqual(parseColor('rgb(0, 128, 0'), '#008000');
});

test('a functional colour is read as CSS Color 4 reads it, and handed on as ntk reads it', () => {
  const cases: [string, string | null][] = [
    // percentages are of 255: ntk read them as numbers, nearly black
    ['rgb(0%, 50%, 0%)', '#008000'],
    // the space-separated form, Tailwind 3's
    ['rgb(59 130 246 / 0.5)', 'rgba(59, 130, 246, 0.5)'],
    ['RGB(0 128 0 / 100%)', '#008000'],
    ['rgba(0,128,0,.5)', 'rgba(0, 128, 0, 0.5)'],
    // the legacy form takes one kind of channel and three or four of them
    ['rgb(100%, 0, 0)', null],
    ['rgb(255, 0)', null],
    ['rgb(0, 0 0)', null],
    ['rgb(1e2 0 0)', '#640000'],
    ['hsl(120, 100%, 25%)', '#008000'],
    ['hsl(120deg 100 25)', '#008000'],
    ['hsl(120, 100, 25)', null],
    ['hsl(0.5turn 100% 50%)', '#00ffff'],
    ['hwb(120 0% 49.8039%)', '#008000'],
    // Tailwind 4's palette, and the rest of Lab's family
    ['oklch(51.975% 0.17686 142.495)', '#008000'],
    ['oklab(51.975% -0.1403 0.10768)', '#008000'],
    ['lab(46.2775% -47.5621 48.5837)', '#008000'],
    ['lch(46.2775% 67.9892 134.3912)', '#008000'],
    // a lightness at either end is white or black, whatever its chroma
    ['lch(100% 110 60)', '#ffffff'],
    ['oklch(0% 1.1 60 / 0.5)', 'rgba(0, 0, 0, 0.5)'],
    ['oklch(100% 0.3 60)', '#ffffff'],
    ['color(srgb 0 0.6 0)', '#009900'],
    ['color(display-p3 0.6 0.6 0.6)', '#999999'],
    ['color(nope 1 1 1)', null],
    // `calc()` and `var()` are not read here, and the declaration is dropped
    ['rgb(calc(1) 0 0)', null],
  ];
  for (const [value, want] of cases) {
    assert.strictEqual(parseColor(value), want, value);
  }
  // each space's matrix takes its white to white
  for (const space of [
    'display-p3',
    'display-p3-linear',
    'a98-rgb',
    'prophoto-rgb',
    'rec2020',
    'srgb-linear',
  ]) {
    assert.strictEqual(parseColor(`color(${space} 1 1 1)`), '#ffffff', space);
  }
  assert.strictEqual(
    parseColor('color(xyz-d50 0.9642957 1 0.8251046)'),
    '#ffffff',
  );
  assert.strictEqual(parseColor('color(xyz 0.9504559 1 1.0890578)'), '#ffffff');
});

test('@media width queries become conditions, and their breakpoints are collected', () => {
  const sheet = parseStylesheet(
    '@media (min-width: 600px) { p { color: red } }',
  );
  assert.strictEqual(sheet.rules.length, 1);
  assert.deepStrictEqual(sheet.rules[0].media, [[{ min: 600 }]]);
  assert.deepStrictEqual(sheet.breakpoints, [600]);
});

test('@import is collected rather than followed', () => {
  const sheet = parseStylesheet('@import url("theme.css"); p { color: red }');
  assert.deepStrictEqual(sheet.imports, ['theme.css']);
  assert.strictEqual(sheet.rules.length, 1);
});

test('a broken rule does not eat the rest of the sheet', () => {
  const sheet = parseStylesheet('p { color: } h1 { color: red }');
  const h1 = sheet.rules.find((r) => r.selector === 'h1');
  assert.ok(h1, 'the rule after a broken one still parses');
  assert.strictEqual(h1.declarations[0].value, 'red');
});

test('escapes resolve in selectors, names and values', () => {
  const sheet = parseStylesheet(
    '\\64\\69\\76 { \\63\\6F\\6C\\6F\\72: \\67\\72\\65\\65\\6E }',
  );
  assert.deepStrictEqual(
    sheet.rules.map((r) => [
      r.selector,
      r.declarations[0].prop,
      r.declarations[0].value,
    ]),
    [['\\64\\69\\76', 'color', 'green']],
  );
});

test('a rule runs to its block: a stray semicolon or a bare @ is part of it', () => {
  // CSS Syntax: a style rule's selector is everything up to its block, so
  // `@ import "x"; div {…}` is one rule whose selector is not one. A stray
  // `;` used to end the sheet there, and `@ import` read as an at-rule let
  // the rule after it through.
  const sheet = parseStylesheet(
    '@ import "red.css"; div { color: red }\n' +
      'foo; span { color: red }\n' +
      '@1import "red.css"; em { color: red }\n' +
      'p { color: green }',
  );
  assert.deepStrictEqual(
    sheet.rules.map((r) => r.selector),
    ['p'],
  );
  assert.deepStrictEqual(sheet.imports, [], 'and nothing is imported');
});

test('one invalid selector drops its whole group', () => {
  const sheet = parseStylesheet(
    '[1digit="true"], div { color: red }\n' +
      '.-1ident, .three { color: red }\n' +
      '.-ident, #-ident, .-\\31ident, .x { color: green }\n' +
      'a, , b { color: red }\n' +
      'a > { color: red }',
  );
  assert.deepStrictEqual(
    sheet.rules.map((r) => r.selector),
    ['.-ident', '#-ident', '.-\\31ident', '.x'],
  );
});

test('a pseudo-class takes an argument where it takes one, and only there', () => {
  // `:lang()` names no language, `:not()` negates nothing and `:hover(x)`
  // is no pseudo-class: each makes its group invalid, as an unknown name
  // does (the WPT suite's lang-selector-002). `:is()` forgives an empty
  // list, and `:host` is a pseudo-class with an argument or without
  const sheet = parseStylesheet(
    ':lang(), div { color: red }\n' +
      ':not( ), a { color: red }\n' +
      ':hover(x), b { color: red }\n' +
      'p:nth-child { color: red }\n' +
      ':is(), :lang(fr), :nth-child(2n), :host, :host(.x) { color: green }',
  );
  assert.deepStrictEqual(
    sheet.rules.map((r) => r.selector),
    [':is()', ':lang(fr)', ':nth-child(2n)', ':host', ':host(.x)'],
  );
});

test('@import counts only first, and never inside @media', () => {
  const first = parseStylesheet('@charset "utf-8"; @import "a.css"; p {}');
  assert.deepStrictEqual(first.imports, ['a.css']);
  const late = parseStylesheet('p { color: red } @import "b.css";');
  assert.deepStrictEqual(late.imports, [], 'after a rule');
  const nested = parseStylesheet('@media screen { @import "c.css"; }');
  assert.deepStrictEqual(nested.imports, [], 'inside @media');
});

test('only a rule that is one closes the imports', () => {
  // `@media;` and `@page;` want blocks, `@badat-rule` is no rule, `#` and
  // `:unknownpseudo` are no selectors: each is dropped as though never
  // written, and an `@import` after them still counts.
  for (const sheet of [
    '@media; @page; @charset; @import "a.css";',
    '@badat-rule foo; @import "a.css";',
    '# { color: red } :unknownpseudo { color: red } @import "a.css";',
  ]) {
    assert.deepStrictEqual(parseStylesheet(sheet).imports, ['a.css'], sheet);
  }
});

test('an escape is read whole, and stays part of its identifier', () => {
  // six hex digits take the white space after them — a newline included, so
  // the string goes on — and an escape that names a tab is not a tab
  const [content, color] = parseDeclarations(
    'content: "Filler\\\nText\\00000a\n Filler"; color: red \\9',
  );
  assert.strictEqual(content.value, '"Filler\\\nText\\00000a\n Filler"');
  assert.strictEqual(
    color.value,
    'red \\9',
    'left for the value parser to refuse',
  );
});

test('a declaration list reads at-rules and junk to where they end', () => {
  const decls = (text: string) =>
    parseDeclarations(text).map((d) => `${d.prop}:${d.value}`);
  assert.deepStrictEqual(decls('color: red; @import "x.css"; color: green'), [
    'color:red',
    'color:green',
  ]);
  assert.deepStrictEqual(decls('@foo {color: red} color: green'), [
    'color:green',
  ]);
  assert.deepStrictEqual(decls('12; color: green'), ['color:green']);
  assert.deepStrictEqual(decls('color: green; 12 color: red'), ['color:green']);
  assert.deepStrictEqual(
    decls(
      'background: red ! fail; color: red ! important fail; x: 1 !important',
    ),
    ['x:1'],
    'a `!` that is not `!important` is not a value',
  );
  assert.deepStrictEqual(
    decls('content: "a;b" ; background: url(a;b.png)'),
    ['content:"a;b"', 'background:url(a;b.png)'],
    'a semicolon in a string or a url ends nothing',
  );
});

test('an escaped class selector matches its element', async () => {
  // Tailwind writes its variants as escapes — `.md\\:flex`, `.w-1\\/2` —
  // and a rule was filed under the name as written, cut at the escape, so it
  // was never tried against the element it names.
  const { node } = await render(
    '<style>.md\\:green { color: #00ff00 } .w-1\\/2 { width: 50% }</style>' +
      '<div id="d" class="md:green w-1/2">x</div>',
  );
  const d = boxOf(view(node), 'd') as LaidBox & {
    style: { color: string; width: unknown };
  };
  assert.strictEqual(d.style.color, '#00ff00');
  assert.deepStrictEqual(d.style.width, { pct: 50 });
});

// --- values -----------------------------------------------------------------

test('lengths resolve the units a computed style can, and keep the ones it cannot', () => {
  const ctx = { em: 20, rem: 16, vw: 1000, vh: 500, scale: 1 };
  assert.strictEqual(parseLength('10px', ctx), 10);
  assert.strictEqual(parseLength('2em', ctx), 40);
  assert.strictEqual(parseLength('2rem', ctx), 32);
  assert.strictEqual(parseLength('12pt', ctx), 16);
  assert.strictEqual(parseLength('10vw', ctx), 100);
  assert.deepStrictEqual(parseLength('50%', ctx), { pct: 50 });
  assert.strictEqual(parseLength('auto', ctx), 'auto');
  // a bare number is not a length, which is what keeps `line-height: 1.5`
  // from being read as 1.5 pixels
  assert.strictEqual(parseLength('1.5', ctx), null);
});

test('at a display scale of 2 the absolute units are two device pixels each', () => {
  // `em`, `rem` and the viewport arrive device already (react-x11's
  // docs/scale.md), so only the CSS-pixel units carry the factor.
  const ctx = { em: 40, rem: 32, vw: 2000, vh: 1000, scale: 2 };
  assert.strictEqual(parseLength('10px', ctx), 20);
  assert.strictEqual(parseLength('12pt', ctx), 32);
  assert.strictEqual(parseLength('1in', ctx), 192);
  assert.strictEqual(parseLength('2em', ctx), 80);
  assert.strictEqual(parseLength('2rem', ctx), 64);
  assert.strictEqual(parseLength('10vw', ctx), 200);
  assert.strictEqual(parseLength('600', ctx, true), 1200);
  assert.deepStrictEqual(parseLength('50%', ctx), { pct: 50 });
});

test('splitValue keeps functions and quotes whole', () => {
  assert.deepStrictEqual(splitValue('1px solid rgb(1, 2, 3)'), [
    '1px',
    'solid',
    'rgb(1, 2, 3)',
  ]);
  assert.deepStrictEqual(splitValue('url(a b.png) no-repeat'), [
    'url(a b.png)',
    'no-repeat',
  ]);
});

test('transparency is answered without parsing a colour', () => {
  assert.ok(isTransparent('transparent'));
  assert.ok(isTransparent(null));
  assert.ok(isTransparent('rgba(0,0,0,0)'));
  assert.ok(!isTransparent('#fff'));
  assert.ok(!isTransparent('rgba(0,0,0,0.5)'));
});

// --- the streaming source ---------------------------------------------------

test('a growing source is written as a delta and keeps node identity', () => {
  const source = new HtmlSource();
  source.setSource('<p>one</p>', false);
  const first = source.document.children[0];
  source.setSource('<p>one</p><p>two</p>', false);
  assert.strictEqual(
    source.document.children[0],
    first,
    'the settled node is the same object, so its boxes and layout survive',
  );
  assert.strictEqual(source.document.children.length, 2);
});

test('a source that is not an extension re-parses', () => {
  const source = new HtmlSource();
  source.setSource('<p>one</p>', false);
  const first = source.document.children[0];
  source.setSource('<div>different</div>', false);
  assert.notStrictEqual(source.document.children[0], first);
});

test('the last chunk of a stream is still written as a delta', () => {
  const source = new HtmlSource();
  source.setSource('<p>one</p>', false);
  const first = source.document.children[0];
  source.setSource('<p>one</p><p>two</p>', true);
  assert.strictEqual(
    source.document.children[0],
    first,
    'completing the stream is an append like any other, so identity survives',
  );
  assert.ok(source.complete);
});

test('a completed source that grows re-parses instead of extending the parse', () => {
  const source = new HtmlSource();
  source.setSource('<p>hi</p>', true);
  // An append-shaped edit to a *completed* document: the parser has been
  // ended, so this has to reset rather than write. It threw
  // `.write() after done!` before — and only for an edit at the end of the
  // document, because an edit anywhere else is not a prefix (#77).
  source.setSource('<p>hi</p>!', true);
  assert.strictEqual(rawTextOf(source.document), 'hi!');
  assert.ok(source.complete, 'the re-parse is ended again');
});

test('typing at the end of a completed document is a re-parse per keystroke', () => {
  const source = new HtmlSource();
  // Every one of these extends the last, so every one of them is the crash.
  source.setSource('<p>a', true);
  source.setSource('<p>ab', true);
  source.setSource('<p>abc', true);
  assert.strictEqual(rawTextOf(source.document), 'abc');
  assert.strictEqual(
    source.setSource('<p>abc', true),
    false,
    'and an unchanged source is still no work at all',
  );
});

test('the document reports its stylesheets, scripts and resources in one pass', () => {
  const source = new HtmlSource();
  source.setSource(
    '<title>T</title><style>p{color:red}</style>' +
      '<link rel="stylesheet" href="a.css"><script src="b.js"></script>' +
      '<img src="c.png">',
    true,
  );
  const facts = source.facts();
  assert.strictEqual(facts.title, 'T');
  assert.strictEqual(facts.sheets.length, 2);
  assert.strictEqual(facts.sheets[0].kind, 'inline');
  assert.strictEqual(facts.sheets[1].kind, 'link');
  assert.strictEqual(facts.scripts.length, 1);
  // the stylesheet link and the image are both resources
  assert.strictEqual(facts.resources.length, 2);
});

/** A parsed document's elements, and its text that is not white space. */
function shapeOf(markup: string): string {
  const source = new HtmlSource();
  source.setSource(markup, true);
  type N = { name?: string; children?: N[]; data?: string };
  const walk = (nodes: N[]): string =>
    nodes
      .map((n) =>
        n.name !== undefined
          ? `${n.name}(${walk(n.children ?? [])})`
          : (n.data ?? '').trim(),
      )
      .filter(Boolean)
      .join(' ');
  return walk(source.document.children as unknown as N[]);
}

test("a written <html> holds its content in a body, as HTML's parser has it", () => {
  // htmlparser2 puts content where it stands. The root box stood in for a
  // body around the `<html>`, so a first paragraph's margin stood below
  // the body's, 8px lower than the same page with its `<body>` written.
  assert.strictEqual(
    shapeOf('<html><title>t</title><p>a</p></html>'),
    'html(title(t) body(p(a)))',
    'the first thing that is not head content opens it',
  );
  assert.strictEqual(shapeOf('<html>hi</html>'), 'html(body(hi))', 'text too');
  assert.strictEqual(
    shapeOf('<html><body><p>a</p></body><p>b</p></html><div>c</div>'),
    'html(body(p(a) p(b) div(c)))',
    'what comes after the body ends goes back into it',
  );
  assert.strictEqual(
    shapeOf('<html><p>a</p><body class="x"><p>b</p></body></html>'),
    'html(body(p(a) p(b)))',
    'and a second body is its attributes, on the first',
  );
  // with no `<html>`, a body written after content takes that content in
  assert.strictEqual(
    shapeOf('<title>t</title><p>a</p><body><div>b</div></body>'),
    'title(t) body(p(a) div(b))',
  );
  // and a fragment is left as it was written
  assert.strictEqual(shapeOf('<p>a</p>b'), 'p(a) b');
});

test('a print-only stylesheet is not applied', () => {
  const source = new HtmlSource();
  source.setSource('<style media="print">p{color:red}</style>', true);
  assert.strictEqual(source.facts().sheets.length, 0);
});

test('a fragment can be parsed and spliced in', () => {
  const nodes = parseFragment('<em>hi</em>');
  assert.strictEqual(nodes.length, 1);
  const holder = createElement('div');
  appendChild(holder, nodes[0]);
  assert.strictEqual(holder.children[0], nodes[0]);
  assert.strictEqual(nodes[0].parent, holder);
});

// --- the element ------------------------------------------------------------

test('importing the component is what registers the element', () => {
  assert.ok(registeredElements().includes('htmlview'));
  // `drawn` decides whether it paints at all, and a kind missing from the set
  // lays out correctly and never appears — see AGENTS.md, "Gotchas".
  assert.ok(drawnKinds().includes('htmlview'));
});

test('it mounts on the mock backend, where there are no font metrics', async () => {
  const result = await renderX11(
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source: '<p>hi</p>', partial: false, 'data-testname': 'doc' }),
    ),
    { backend: 'mock' },
  );
  const node = screen.getByTestName('doc') as DrawnNode;
  assert.strictEqual(view(node).kind, 'htmlview');
  void result;
});

test('a completed document survives an edit at its end', async () => {
  // The editor case from #77: `partial={false}` passes `complete` on every
  // render, so the parser is ended on the first one — and a keystroke at the
  // *end* of the document makes the next source a prefix extension of it.
  // Writing that delta into the ended parser threw `.write() after done!`
  // out of `commitUpdate`, so the failure was a crash rather than a misdraw,
  // and only for a caret at the end.
  const doc = (source: string) =>
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source, partial: false, 'data-testname': 'doc' }),
    );
  const result = await renderX11(doc('<p>hi</p>'), { backend: 'mock' });
  await act(() => result.rerender(doc('<p>hi</p><p>there</p>')));
  assert.strictEqual(
    view(screen.getByTestName('doc') as DrawnNode).textContent(),
    'hithere',
  );
});

test('the document text is what a copy would take', async () => {
  const { node } = await render('<h1>Title</h1><p>Body <em>text</em>.</p>');
  assert.strictEqual(view(node).textContent(), 'TitleBody text.');
});

test('a control is not in the document text', async () => {
  const { node } = await render(
    '<p>Name: <input type="text" value="secret"></p>',
  );
  assert.ok(!view(node).textContent().includes('secret'));
});

test("an image's alt text joins the document text", async () => {
  const { node } = await render(
    '<p>See <img src="x.png" alt="the chart"> here.</p>',
  );
  assert.ok(view(node).textContent().includes('the chart'));
});

// --- layout, which needs real metrics ---------------------------------------

const metric = FONTS ? test : test.skip;

metric('blocks stack, and the cascade decides their size', async () => {
  const { node } = await render(
    '<style>h1{font-size:32px;margin:0}p{margin:0;font-size:16px}</style>' +
      '<h1>Title</h1><p>Body</p>',
  );
  const el = view(node);
  const tree = (
    el as unknown as {
      _tree: { root: { children: { y: number; height: number }[] } };
    }
  )._tree;
  const [heading, body] = tree.root.children;
  assert.ok(
    heading.height > body.height,
    'a 32px heading is taller than 16px body text',
  );
  assert.ok(
    body.y >= heading.y + heading.height,
    'the paragraph starts below the heading',
  );
});

metric('a malformed colour does not reach paint', async () => {
  const { result } = await render(
    '<style>p{color:rgb(foo)} div{margin:0;color:rgb(0, 128, 0</style>' +
      '<p>ignored</p><div>green</div>',
  );
  // drawn at all is most of the assertion: it threw from paint before
  await waitFor(async () => {
    const ctx = result.ctx;
    let green = 0;
    for (let x = 8; x < 60; x += 1) {
      for (let y = 30; y < 90; y += 2) {
        const [r, g, b] = await pixelAt(ctx, x, y);
        if (g > 90 && r < 60 && b < 60) green += 1;
      }
    }
    assert.ok(green > 0, 'the unclosed rgb( drew its text green');
  });
});

metric(
  "a letter-spacing percentage is of the font size, and a font's size loses to a later font-size",
  async () => {
    // CSS Text 4: `letter-spacing: 200%` is two ems. And the `font`
    // shorthand's size lost to a more specific `font-size` only until the
    // cascade's second pass applied the `font` again
    const { node } = await render(
      '<style>span{font:15px/1 sans-serif} .b > span{font-size:30px}</style>' +
        '<p id="p" style="font-size:10px;letter-spacing:200%">x</p>' +
        '<div class="b"><span id="s">x</span></div>',
    );
    const el = view(node);
    const styleOf = (id: string) =>
      (
        boxOf(el, id) as unknown as {
          style: { letterSpacing: number; fontSize: number };
        }
      ).style;
    assert.strictEqual(styleOf('p').letterSpacing, 20);
    assert.strictEqual(styleOf('s').fontSize, 30);
  },
);

test('an image told to be a column is drawn, as one told to be a cell is', async () => {
  // a column is not drawn, and an image that is one is an inline image
  const { node } = await render(
    '<div style="display:table"><img id="i" width="20" height="10" ' +
      'style="display:table-column-group" src="x.png"></div>',
  );
  const img = boxOf(view(node), 'i');
  assert.ok(img.width === 20 && img.height === 10, 'laid out at its size');
});

metric(
  'a hex colour of five or seven digits is none, and does not throw from paint',
  async () => {
    const { el } = await renderWithBytes(
      '<p id="p" style="color:#ff000">five</p>' +
        '<div id="d" style="color:#00f;color:#ff00000;background:#ff00000">seven</div>' +
        '<div id="e" style="color:#0f08;background:#00ff0080">four, eight</div>',
      {},
    );
    // drawn at all is most of the assertion: both threw from paint before
    const style = (id: string) =>
      (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
    assert.notStrictEqual(style('p').color, '#ff000');
    assert.strictEqual(style('d').color, '#00f');
    assert.strictEqual(style('d').backgroundColor, null);
    assert.strictEqual(style('e').color, '#0f08');
    assert.strictEqual(style('e').backgroundColor, '#00ff0080');
  },
);

metric('sibling margins collapse to the larger of the two', async () => {
  const { node } = await render(
    '<style>p{margin:0;font-size:16px}.a{margin-bottom:40px}.b{margin-top:10px}</style>' +
      '<p class="a">one</p><p class="b">two</p>',
  );
  const tree = (
    view(node) as unknown as {
      _tree: { root: { children: { y: number; height: number }[] } };
    }
  )._tree;
  const [first, second] = tree.root.children;
  const gap = second.y - (first.y + first.height);
  assert.ok(
    Math.abs(gap - 40) < 1,
    `collapsed to the larger margin, got ${gap}`,
  );
});

test('margins of both signs collapse to the largest and the most negative of all', async () => {
  // 2, -4, 0, 14, -4 and 2 are 14 less 4: taken two at a time they came
  // to 8, and the block after them stood two pixels high (CSS 2.1 8.3.1)
  const { node } = await render(
    '<style>body{margin:0}</style><div style="height:1px"></div>' +
      '<div style="margin:2px"><div style="margin:-4px 20px">' +
      '<div style="margin:0 0 14px"></div></div></div>' +
      '<div id="a" style="height:10px"></div>',
  );
  assert.strictEqual(boxOf(view(node), 'a').y, 11);
});

metric(
  'text wraps to the width it is given, and rewraps when that changes',
  async () => {
    const source = '<p>' + 'word '.repeat(60) + '</p>';
    const narrow = await render(source, 200);
    const narrowLines = lineCount(narrow.node);
    await cleanup();
    const wide = await render(source, 600);
    const wideLines = lineCount(wide.node);
    assert.ok(
      narrowLines > wideLines,
      `${narrowLines} lines at 200px, ${wideLines} at 600px`,
    );
  },
);

function lineCount(node: DrawnNode): number {
  const tree = (
    view(node) as unknown as {
      _tree: { root: { children: { lines: unknown[] | null }[] } };
    }
  )._tree;
  let total = 0;
  const walk = (
    boxes: { lines: unknown[] | null; children?: unknown }[],
  ): void => {
    for (const box of boxes) {
      if (box.lines) total += box.lines.length;
      const kids = (box as { children?: typeof boxes }).children;
      if (kids) walk(kids);
    }
  };
  walk(tree.root.children);
  return total;
}

metric(
  "a float sits inside its own containing block, not at the formatting context's edge",
  async () => {
    // Placed in the band the whole formatting context allows, a float in a
    // padded block sat at the root's edge — outside the padding, and outside
    // the body's margin (CSS 2.1 9.5.1, rules 1 and 7).
    const { node } = await render(
      '<style>.wrap{padding:0 30px 0 50px}.l,.r{width:40px;height:20px}' +
        '.l{float:left}.r{float:right}</style>' +
        '<div class="wrap"><div class="l"></div><div class="r"></div></div>',
      300,
    );
    type B = { x: number; width: number; contentX: number; children: B[] };
    const tree = (view(node) as unknown as { _tree: { root: B } })._tree;
    const wrap = tree.root.children[0];
    const [left, right] = wrap.children;
    assert.strictEqual(
      left.x,
      wrap.contentX,
      'the left float at the content edge',
    );
    assert.strictEqual(
      right.x + right.width,
      wrap.x + wrap.width - 30,
      'the right float against the right padding',
    );
  },
);

metric(
  'a float shortens the lines beside it and not the ones below',
  async () => {
    const { node } = await render(
      '<style>.f{float:left;width:100px;height:40px}p{margin:0}</style>' +
        '<div class="f"></div><p>' +
        'word '.repeat(40) +
        '</p>',
      300,
    );
    const tree = (
      view(node) as unknown as {
        _tree: {
          root: {
            children: {
              lines: { x: number; width: number; y: number }[] | null;
            }[];
          };
        };
      }
    )._tree;
    const paragraph = tree.root.children.find(
      (b) => b.lines && b.lines.length > 2,
    );
    assert.ok(paragraph?.lines, 'the paragraph wrapped');
    const beside = paragraph.lines[0];
    const below = paragraph.lines[paragraph.lines.length - 1];
    assert.ok(
      beside.x >= 100,
      `the first line starts beside the float, at ${beside.x}`,
    );
    assert.ok(
      below.x < 100,
      `a line past the float starts at the edge again, at ${below.x}`,
    );
  },
);

metric('a table sizes its columns from every cell in them', async () => {
  const { node } = await render(
    '<table><tr><td>a</td><td>a much wider cell than the other one</td></tr>' +
      '<tr><td>b</td><td>x</td></tr></table>',
    500,
  );
  const tree = (view(node) as unknown as { _tree: { root: unknown } })._tree;
  const cells: { x: number; width: number }[] = [];
  const walk = (box: {
    kind: string;
    x: number;
    width: number;
    children: unknown[];
  }): void => {
    if (box.kind === 'table-cell') cells.push({ x: box.x, width: box.width });
    for (const child of box.children) walk(child as typeof box);
  };
  walk(tree.root as never);
  assert.strictEqual(cells.length, 4);
  // the second column is wider than the first, and the two rows agree
  assert.ok(cells[1].width > cells[0].width);
  assert.strictEqual(cells[0].width, cells[2].width);
  assert.strictEqual(cells[1].x, cells[3].x);
});

metric('display:flex lays out through yoga', async () => {
  const { node } = await render(
    '<style>.row{display:flex}.row>div{flex:1}</style>' +
      '<div class="row"><div>a</div><div>b</div><div>c</div></div>',
    300,
  );
  const tree = (view(node) as unknown as { _tree: { root: unknown } })._tree;
  const items: { x: number; width: number }[] = [];
  const walk = (box: {
    kind: string;
    style: { display: string };
    x: number;
    width: number;
    children: unknown[];
  }): void => {
    if (box.kind === 'flex') {
      for (const child of box.children) {
        const c = child as typeof box;
        items.push({ x: c.x, width: c.width });
      }
    }
    for (const child of box.children) walk(child as typeof box);
  };
  walk(tree.root as never);
  assert.strictEqual(items.length, 3, 'three flex items');
  assert.ok(
    items[0].x < items[1].x && items[1].x < items[2].x,
    'laid out in a row',
  );
  assert.ok(
    Math.abs(items[0].width - items[1].width) < 2,
    'flex: 1 shares the line evenly',
  );
});

metric(
  'an inline box laid out again reaches no further than its text',
  async () => {
    // A flex item's subtree is laid out and then moved into place, and the
    // move shifted the inline boxes in it too, whose position is never laid
    // out, so each pass added to it. A page whose first layout was at a
    // width of 1 — a window before its size is known — measured a card grid
    // with a <span> in each card three times its height.
    const { node } = await render(
      '<style>body{margin:0}.grid{display:flex;flex-wrap:wrap}' +
        '.grid a{display:block;width:120px;height:40px}' +
        '.grid b{display:block}</style>' +
        '<div class="grid">' +
        '<a><b>One</b><span>a note</span></a><a><b>Two</b><span>a note</span></a>' +
        '<a><b>Three</b><span>a note</span></a><a><b>Four</b><span>a note</span></a>' +
        '</div>',
      300,
    );
    const el = view(node) as unknown as {
      measureContent(constraints: { width: number }): { height: number };
    };
    const settled = el.measureContent({ width: 300 }).height;
    // two cards a row at 300px, and room for them at every width below
    for (const width of [1, 290, 2, 280, 3, 270]) el.measureContent({ width });
    assert.strictEqual(el.measureContent({ width: 260 }).height, settled);
  },
);

metric('a probe of an unbounded width puts no box at infinity', async () => {
  // A flex item is measured at its max-content width, a layout in unbounded
  // room. Its table's cell centred a block by its auto margins in that room
  // — at x = Infinity — and the pass after moved the image in it from there
  // by a finite amount: NaN, which went up every ink bound above it and left
  // everything under the flex container unpainted. Wikipedia's navboxes are
  // this shape, and the article under them did not draw.
  const { node } = await render(
    '<div style="display:flex"><div><table><tr><td>list</td><td>' +
      '<div style="margin:0 auto;width:80px"><img width="64" height="64">' +
      '</div></td></tr></table></div></div><p>after</p>',
    400,
  );
  type Laid = {
    x: number;
    y: number;
    boundsX: number;
    boundsWidth: number;
    children: Laid[];
  };
  const root = (view(node) as unknown as { _tree: { root: Laid } })._tree.root;
  const bad: Laid[] = [];
  const walk = (box: Laid): void => {
    if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) bad.push(box);
    for (const child of box.children) walk(child);
  };
  walk(root);
  assert.strictEqual(bad.length, 0, 'every box has a place');
  assert.ok(Number.isFinite(root.boundsX) && Number.isFinite(root.boundsWidth));
});

metric(
  'a fragment gets the body margin it would have had inside <body>',
  async () => {
    const { node } = await render(
      '<style>body{margin:20px}</style><p>hi</p>',
      300,
    );
    const tree = (
      view(node) as unknown as {
        _tree: { root: { children: { x: number }[] } };
      }
    )._tree;
    assert.ok(
      Math.abs(tree.root.children[0].x - 20) < 1,
      'the paragraph is inset by the body margin',
    );
  },
);

metric(
  "a fragment's first paragraph sits where it would inside <html><body>",
  async () => {
    // A body's top margin collapses with its first block's — <html> is the
    // formatting context's root, <body> is not — so a 16px paragraph in a
    // body with an 8px margin starts 16px down, not 24. The implied body of a
    // fragment has to do the same, or the two spellings of one document
    // disagree by the body margin.
    type B = { y: number; children: B[] };
    const firstParagraphY = async (source: string) => {
      const { node } = await render(source, 300);
      const tree = (view(node) as unknown as { _tree: { root: B } })._tree;
      let box = tree.root;
      while (box.children.length) box = box.children[0];
      const y = (box as unknown as { parent: B }).parent.y;
      await cleanup();
      return y;
    };
    const p = '<style>p{margin:16px 0}</style>';
    const fragment = await firstParagraphY(p + '<p>hi</p>');
    const full = await firstParagraphY(
      '<html><head>' + p + '</head><body><p>hi</p></body></html>',
    );
    assert.strictEqual(fragment, full, 'the same place either way');
    assert.ok(Math.abs(full - 16) < 1, `one collapsed margin, at ${full}`);
  },
);

metric(
  "<html>'s own margin never collapses with what is inside it",
  async () => {
    // The root element establishes the document's formatting context, so its
    // margin stays its own: a block 20px down in a body with no margin, in an
    // <html> 20px down, is 40px down — not 20.
    type B = { y: number; children: B[] };
    const { node } = await render(
      '<html style="margin-top:20px"><body style="margin:0">' +
        '<div style="margin-top:20px;height:10px"></div></body></html>',
      300,
    );
    const tree = (view(node) as unknown as { _tree: { root: B } })._tree;
    let box = tree.root;
    while (box.children.length) box = box.children[0];
    assert.ok(Math.abs(box.y - 40) < 1, `at ${box.y}`);
  },
);

metric('line-height: 0 lays lines on top of each other', async () => {
  // Legal CSS, and what the suite's line-height tests are built on: each
  // line box is 0 high, so two lines share a baseline. A 0.1 floor on the
  // multiplier set them a tenth of a line apart.
  const { node } = await render(
    '<div style="font-size:20px;line-height:0;width:1em">X X</div>',
    300,
  );
  type B = { lines: { y: number; baseline: number }[] | null; children: B[] };
  const tree = (view(node) as unknown as { _tree: { root: B } })._tree;
  const div = tree.root.children[0];
  const lines = div.lines ?? [];
  assert.strictEqual(lines.length, 2, 'the text wraps to two lines');
  assert.ok(
    Math.abs(lines[1].y - lines[0].y) < 0.01,
    `both lines at one height: ${lines[0].y} and ${lines[1].y}`,
  );
});

// --- white space ----------------------------------------------------------------

test('white space collapses across elements, and not at a line start', async () => {
  const text = async (source: string) =>
    (
      view((await render(source, 300)).node) as unknown as {
        _tree: { text: string };
      }
    )._tree.text;
  // CSS 2.1 16.6.1: a space at the start or the end of a line goes, and a
  // space after another collapses into it, whichever element either is in
  assert.strictEqual(await text('<p>\n   Hello world\n</p>'), 'Hello world');
  assert.strictEqual(await text('<p>Hi<b> </b>there</p>'), 'Hi there');
  assert.strictEqual(await text('<p>Hi <b> there</b></p>'), 'Hi there');
  assert.strictEqual(await text('<p>one <br>\n two</p>'), 'one\ntwo');
  // a space beside an image or an inline-block is a space; a float is no
  // part of the line, so the space after it collapses into the one before
  assert.strictEqual(await text('<p>a <img alt="i"> b</p>'), 'a i b');
  assert.strictEqual(
    await text('<p>a <span style="float:left">f</span> b</p>'),
    'a fb',
  );
  // preserved spaces stay, and do not swallow the next one
  assert.strictEqual(
    await text('<p><span style="white-space:pre">a  </span> b</p>'),
    'a   b',
  );
});

test('the generic monospace on its own is smaller, as in a browser', async () => {
  // 13 to 16: an element whose family becomes `monospace` scales the size
  // it inherits, and one that leaves it scales it back; a keyword reads the
  // smaller scale; a size an element sets is its own, and a list with a
  // fallback in it keeps the size it had
  const { node } = await render(
    '<div style="font-size:16px">' +
      '<p id="a" style="font-family:monospace">a</p>' +
      '<p id="b" style="font-family:monospace, monospace">b</p>' +
      '<p id="c" style="font-family:monospace;font-size:20px">c</p>' +
      '<p id="m" style="font-size:medium">m</p>' +
      '<div style="font-family:monospace">' +
      '<p id="d" style="font-family:serif">d</p>' +
      '<p id="e" style="font-size:medium">e</p>' +
      '<p id="f" style="font:italic medium monospace">f</p>' +
      '<p id="g" style="font-size:2em">g</p></div></div>',
  );
  const el = view(node);
  const size = (id: string) =>
    (boxOf(el, id) as LaidBox & { style: { fontSize: number } }).style.fontSize;
  assert.strictEqual(size('a'), 13, 'inherited, scaled');
  assert.strictEqual(size('b'), 16, 'a fallback: no');
  assert.strictEqual(size('c'), 20, 'set: its own');
  assert.strictEqual(size('d'), 16, 'and back');
  assert.strictEqual(size('e'), size('m') * (13 / 16), 'medium, smaller');
  assert.strictEqual(size('f'), size('m') * (13 / 16), 'through `font` too');
  assert.strictEqual(size('g'), 26, "an em of the parent's");
});

test('a first line keeps its first box after the indent, however wide', async () => {
  // there is no break before a line's first content, and a first line's
  // `text-indent` is room, not content: an inline-block that did not fit
  // after it went to a second line, and a float laid out at its least
  // width was as wide as the block without the indent
  const { node } = await render(
    '<div id="f" style="float:left;text-indent:30px">' +
      '<span style="display:inline-block;width:10px;height:10px"></span>' +
      '</div>',
    1,
  );
  const f = boxOf(view(node), 'f') as LaidBox & { lines: unknown[] };
  assert.strictEqual(f.width, 40);
  assert.strictEqual(f.lines.length, 1);
});

metric('font-size: 0 leaves no room between inline-blocks', async () => {
  // the common way to lose the spaces between columns set inline: at no
  // size the space between them takes no room, where it used to be 1px. The
  // row is wider than the body it sits in, which must not narrow its lines.
  const { node } = await render(
    '<div style="font-size:0;width:300px">' +
      '<div id="a" style="display:inline-block;width:100px;height:10px"></div> ' +
      '<div id="b" style="display:inline-block;width:100px;height:10px"></div> ' +
      '<div id="c" style="display:inline-block;width:100px;height:10px"></div></div>',
    300,
  );
  const el = view(node);
  const xs = ['a', 'b', 'c'].map((id) => boxOf(el, id).x);
  assert.deepStrictEqual(
    xs.map((x) => x - xs[0]),
    [0, 100, 200],
  );
  assert.strictEqual(boxOf(el, 'c').y, boxOf(el, 'a').y, 'one line');
});

metric('a word with no room beside a float goes below it, whole', async () => {
  // CSS 2.1 9.5: a line too short for any of its content moves down until
  // something fits. The word used to be cut to the room the float left.
  // Sized from the word as this machine's face sets it — DejaVu on Linux is
  // a fifth wider than Arial — so the room beside the float is always three
  // quarters of the word and the room below it always half as much again.
  type B = { lines: { y: number; width: number }[] | null; children: B[] };
  const word = 'Antidisestablishment';
  const probe = await render(
    `<p id="w" style="margin:0;font-size:20px">${word}</p>`,
    600,
  );
  const measured = boxOf(view(probe.node), 'w') as unknown as B;
  const wordWidth = measured.lines?.[0]?.width ?? 0;
  assert.ok(wordWidth > 0, 'the word is measured');
  await probe.result.unmount();

  const boxWidth = Math.ceil(wordWidth * 1.5);
  const { node } = await render(
    `<div id="box" style="width:${boxWidth}px;font-size:20px">` +
      `<div style="float:left;width:${Math.ceil(wordWidth * 0.75)}px;height:30px"></div>` +
      `${word}</div>`,
    boxWidth + 100,
  );
  // the text sits in an anonymous block beside the float, so its lines are
  // somewhere under the box rather than on it
  const lines: { y: number }[] = [];
  const walk = (b: B): void => {
    lines.push(...(b.lines ?? []));
    b.children.forEach(walk);
  };
  walk(boxOf(view(node), 'box') as unknown as B);
  assert.strictEqual(lines.length, 1, 'one line, the word whole');
  assert.ok(lines[0].y >= 30, `below the float: ${lines[0].y}`);
});

// --- generated content --------------------------------------------------------

test('content values: strings with escapes, attr(), counters and quotes', () => {
  assert.deepStrictEqual(parseContent('none'), 'none');
  assert.deepStrictEqual(parseContent('NORMAL'), 'normal');
  // a hex escape takes up to six digits and one space after them
  assert.deepStrictEqual(parseContent('"\\201C x\\A0" attr(Title)'), [
    { kind: 'string', text: '“x ' },
    { kind: 'attr', name: 'title' },
  ]);
  assert.deepStrictEqual(
    parseContent('counter(c, upper-roman) counters(c, ".") open-quote'),
    [
      { kind: 'counter', name: 'c', style: 'upper-roman' },
      { kind: 'counters', name: 'c', separator: '.', style: 'decimal' },
      { kind: 'open-quote' },
    ],
  );
  // an image is an item among the rest; what cannot be read drops all
  assert.deepStrictEqual(parseContent('url(x.png) "a"'), [
    { kind: 'url', url: 'x.png' },
    { kind: 'string', text: 'a' },
  ]);
  assert.strictEqual(parseContent('"a", "b"'), null);
  assert.strictEqual(parseContent('counter()'), null);
  assert.deepStrictEqual(parseCounterList('a b 3 c -2', 1), [
    { name: 'a', value: 1 },
    { name: 'b', value: 3 },
    { name: 'c', value: -2 },
  ]);
  assert.strictEqual(parseCounterList('none', 0), 'none');
  assert.strictEqual(parseCounterList('a 1.5', 0), null);
  assert.deepStrictEqual(parseQuotes('"<" ">" \'(\' \')\''), [
    '<',
    '>',
    '(',
    ')',
  ]);
  assert.strictEqual(parseQuotes('"<"'), null);
});

test('counter styles, and decimal past where a style has a form', () => {
  const at = (n: number, style: string) => counterText(n, style);
  assert.deepStrictEqual(
    [at(4, 'upper-roman'), at(14, 'lower-roman'), at(4000, 'upper-roman')],
    ['IV', 'xiv', '4000'],
  );
  assert.deepStrictEqual(
    [at(1, 'lower-alpha'), at(27, 'upper-latin'), at(0, 'lower-alpha')],
    ['a', 'AA', '0'],
  );
  assert.deepStrictEqual(
    [at(3, 'lower-greek'), at(25, 'lower-greek')],
    ['γ', 'αα'],
  );
  assert.deepStrictEqual(
    [at(1, 'armenian'), at(1999, 'armenian'), at(10001, 'georgian')],
    ['Ա', 'ՌՋՂԹ', 'ჵა'],
  );
  // `pad` counts the negative sign among the two (CSS Counter Styles 3,
  // 3.6)
  assert.deepStrictEqual(
    [at(7, 'decimal-leading-zero'), at(-3, 'decimal-leading-zero')],
    ['07', '-3'],
  );
  assert.deepStrictEqual([at(5, 'none'), at(5, 'square')], ['', '▪']);
});

/** The text a document's boxes hold, generated content included. */
async function documentText(source: string): Promise<string> {
  const { node } = await render(source, 300);
  return (view(node) as unknown as { _tree: { text: string } })._tree.text;
}

test('the predefined counter styles write what CSS Counter Styles 3 has them write', () => {
  // Past a dozen of them every style name was decimal: the numeric ones of
  // twenty-odd scripts, the kana, the CJK longhands and ethiopic-numeric
  const styles = new CounterStyles();
  const cases: [number, string, string][] = [
    [42, 'arabic-indic', '٤٢'],
    [0, 'cjk-decimal', '〇'],
    [15, 'hebrew', 'טו'],
    [3, 'katakana-iroha', 'ハ'],
    [13, 'cjk-earthly-branch', '一三'],
    [1111, 'japanese-informal', '千百十一'],
    [6001, 'japanese-formal', '六阡壱'],
    [-5, 'korean-hangul-formal', '마이너스 오'],
    [10000, 'korean-hanja-informal', '10000'],
    [101, 'trad-chinese-formal', '壹佰零壹'],
    [11, 'simp-chinese-informal', '十一'],
    [10010, 'simp-chinese-informal', '一万零十'],
    [1001001001001, 'simp-chinese-formal', '壹万亿零壹拾亿零壹佰万壹仟零壹'],
    [78010092, 'ethiopic-numeric', '፸፰፻፩፼፺፪'],
    [4000, 'upper-roman', '4000'],
  ];
  for (const [n, style, text] of cases) {
    assert.strictEqual(styles.text(n, style), text, `${n} in ${style}`);
  }
  assert.deepStrictEqual(styles.marker(3, 'cjk-decimal'), {
    prefix: '',
    text: '三',
    suffix: '、',
  });
});

test('@counter-style defines a style, extends one, and falls back', () => {
  const styles = (css: string) => {
    const sheet = parseStylesheet(css);
    const rules = new Map<string, CounterStyleRule>();
    for (const { prelude, declarations } of sheet.counterStyles ?? []) {
      const style = counterStyleRule(prelude, declarations);
      if (style) rules.set(style.name, style.rule);
    }
    return new CounterStyles(rules);
  };
  const s = styles(
    '@counter-style chapter { system: extends upper-roman; ' +
      'prefix: "Ch. "; range: 1 3; fallback: lower-alpha }' +
      "@counter-style box { system: fixed; symbols: ◰ ◳; suffix: ': ' }" +
      '@counter-style w { system: additive; additive-symbols: 5 V, 1 I, ' +
      'calc(-1) Z; negative: "(" ")"; pad: 3 "*"; range: infinite infinite }' +
      '@counter-style bad { system: alphabetic; symbols: a inherit }' +
      '@counter-style decimal { system: cyclic; symbols: x }',
  );
  assert.deepStrictEqual(
    [1, 3, 4].map((n) => s.text(n, 'chapter')),
    ['I', 'III', 'd'],
    'its range, and its fallback past it',
  );
  assert.deepStrictEqual(s.marker(4, 'chapter').prefix, 'Ch. ', 'its prefix');
  assert.deepStrictEqual(
    [1, 2, 3].map((n) => s.text(n, 'box')),
    ['◰', '◳', '3'],
    'fixed: its symbols, then decimal',
  );
  assert.deepStrictEqual(
    [6, 0, -2].map((n) => s.text(n, 'w')),
    ['*VI', '**Z', '(II)'],
    'additive, a calc() of -1 clamped to 0, pad and a negative sign',
  );
  assert.strictEqual(s.text(2, 'bad'), '2', 'inherit is no symbol');
  assert.strictEqual(s.text(2, 'decimal'), '2', 'decimal is not redefined');
});

metric("a list's marker is written in its counter style", async () => {
  // A `@counter-style` was skipped whole and every style past a dozen was
  // decimal. A marker is its style's prefix, its number and its suffix:
  // `、` sets it against the text, where a suffix that ends in a space is
  // set off by that space's width in the marker's face
  const text = await documentText(
    '<style>@counter-style star { system: cyclic; symbols: "*"; ' +
      'suffix: " " } ol { list-style-position: inside }</style>' +
      '<ol style="list-style-type: star"><li>a</li></ol>' +
      '<ol style="list-style-type: cjk-decimal"><li>b</li></ol>' +
      '<ol style="list-style-type: symbols(alphabetic \'x\' \'y\')" start="3">' +
      '<li>c</li></ol><p style="counter-reset: n 12">' +
      '<span style="content: none"></span></p>',
  );
  assert.ok(text.includes('* a'), JSON.stringify(text));
  assert.ok(text.includes('一、b'), JSON.stringify(text));
  assert.ok(text.includes('xx c'), JSON.stringify(text));
});

test('a <q> is in quotation marks, and a nested one in the next pair', async () => {
  // HTML's rendering: `q::before { content: open-quote }` and its close,
  // which the user-agent sheet did not have, so a quotation was bare
  const text = await documentText('<p><q>say <q>hi</q></q></p>');
  assert.strictEqual(text.trim(), '\u201csay \u2018hi\u2019\u201d');
});

test('::before and ::after hold their content, around the element', async () => {
  assert.strictEqual(
    await documentText(
      '<style>p:before{content:"[" attr(title) "] "}' +
        // the space after a hex escape is the escape's, so two for one
        'p::after{content:" \\2014  end"}</style><p title="T">body</p>',
    ),
    '[T] body — end',
  );
  // `none` after a string makes no box, and nothing else gets content
  assert.strictEqual(
    await documentText(
      '<style>div:before{content:"FAIL";content:none}' +
        'div{content:"FAIL"}</style><div>ok</div>',
    ),
    'ok',
  );
});

test('counters nest, and a reset reaches the siblings after it', async () => {
  assert.strictEqual(
    await documentText(
      '<style>ol{counter-reset:item;list-style:none}' +
        'li:before{counter-increment:item;content:counters(item,".") " "}' +
        '</style><ol><li>a<ol><li>b</li><li>c</li></ol></li><li>d</li></ol>',
    ),
    '1 a1.1 b1.2 c2 d',
  );
  // `h1` resets `sub` for the `h2`s after it, and each `h2` counts both
  assert.strictEqual(
    await documentText(
      '<style>body{counter-reset:sec}' +
        'h1{counter-increment:sec;counter-reset:sub}' +
        'h1:before{content:counter(sec) ". "}' +
        'h2{counter-increment:sub}' +
        'h2:before{content:counter(sec) "." counter(sub) " "}</style>' +
        '<h1>A</h1><h2>x</h2><h2>y</h2><h1>B</h1><h2>z</h2>',
    ),
    '1. A1.1 x1.2 y2. B2.1 z',
  );
});

/** The markers a document's list items draw, in document order. */
async function markersOf(source: string): Promise<string[]> {
  const { node } = await render(source, 300);
  type B = { marker: { text: string } | null; children: B[] };
  const root = (view(node) as unknown as { _tree: { root: B } })._tree.root;
  const out: string[] = [];
  const walk = (b: B): void => {
    if (b.marker) out.push(b.marker.text);
    b.children.forEach(walk);
  };
  walk(root);
  cleanup();
  return out;
}

metric('a pseudo-element set list-item has a marker', async () => {
  // CSS 2.1 12.5: outside it, or its content's start where it is inside
  const { node } = await render(
    '<style>#a::after{content:"x";display:list-item;margin-left:1em}' +
      '#b::before{content:"y";display:list-item;' +
      'list-style-position:inside}</style>' +
      '<div id="a">a</div><div id="b">b</div>',
  );
  const el = view(node);
  type Marked = LaidBox & {
    pseudo: string | null;
    marker: { text: string } | null;
  };
  const after = (boxOf(el, 'a').children as Marked[]).find(
    (child) => child.pseudo === 'after',
  );
  assert.ok(after?.marker, 'an outside marker');
  assert.strictEqual(after.marker.text, '\u2022');
  assert.ok(
    el.textContent().includes('\u2022 y'),
    'an inside one, in its text',
  );
});

test('a list counts with the list-item counter, down where it is reversed', async () => {
  // `<ol reversed>` counts its items down to 1, and to an item's `value`
  // before it: its counter is `reversed(list-item)`, which starts at as
  // many as its scope counts (CSS Lists 3, 4.4.2)
  assert.deepStrictEqual(await markersOf('<ol reversed><li>a<li>b<li>c</ol>'), [
    '3.',
    '2.',
    '1.',
  ]);
  assert.deepStrictEqual(
    await markersOf('<ol reversed><li>a<li value=6>b<li>c</ol>'),
    ['7.', '6.', '5.'],
  );
  assert.deepStrictEqual(
    await markersOf('<ol reversed start=10><li>a<li>b</ol>'),
    ['10.', '9.'],
  );
  // a list in an item is a counter of its own, and the outer goes on
  assert.deepStrictEqual(
    await markersOf('<ol reversed><li>a<ol reversed><li>x<li>y</ol><li>b</ol>'),
    ['2.', '2.', '1.', '1.'],
  );
  // `start`, `value` and `type`, and an item that counts by what it says
  assert.deepStrictEqual(
    await markersOf(
      '<ol start=5><li>a<li value=10>b<li>c' +
        '<li style="counter-increment:list-item 5">d</ol>' +
        '<ol type=a><li>a<li type=I>b</ol><ul type=square><li>x</ul>',
    ),
    ['5.', '10.', '11.', '16.', 'a.', 'II.', '▪'],
  );
});

test('a marker is its type written out, a string, or its ::marker content', async () => {
  assert.deepStrictEqual(
    await markersOf(
      '<ol style="list-style-type:lower-greek"><li>a<li>b</ol>' +
        '<ul style="list-style-type:\'→ \'"><li>x</ul>' +
        '<style>.m li::marker { content: "(" counter(list-item) ")" }</style>' +
        '<ol class=m><li>a<li>b</ol>',
    ),
    ['α.', 'β.', '→ ', '(1)', '(2)'],
  );
});

test('a reset in an element whose parent has the counter reaches its own', async () => {
  // and not its later siblings: the parent's counter goes on after it (CSS
  // Lists 3, 4.5), where CSS 2.1 had the nested reset reach them too
  assert.strictEqual(
    await documentText(
      '<style>.reset{counter-reset:c} .use{counter-increment:c}' +
        '.use:before{content:counters(c,".") " "}' +
        '.rb:before{counter-reset:c;content:"R "}</style>' +
        '<div><span class=reset></span><span class=use></span>' +
        '<span class=reset></span><span class=use></span>' +
        '<span class=rb><span class=use></span><span class=reset></span>' +
        '<span class=use></span></span></div>',
    ),
    '1 1 R 2 3',
  );
  // counter-set changes the counter in scope, after the element counts
  assert.strictEqual(
    await documentText(
      '<style>body{counter-reset:n} p{counter-increment:n}' +
        'p:before{content:counter(n) " "} .jump{counter-set:n 10}</style>' +
        '<p>a</p><p class=jump>b</p><p>c</p>',
    ),
    '1 a10 b11 c',
  );
});

test('quotes open and close by depth, and none writes nothing', async () => {
  assert.strictEqual(
    await documentText(
      '<style>q:before{content:open-quote} q:after{content:close-quote}' +
        '</style><p><q>outer <q>inner</q> back</q></p>',
    ),
    '“outer ‘inner’ back”',
  );
  assert.strictEqual(
    await documentText(
      '<style>q{quotes:"<" ">"} q:before{content:open-quote}' +
        'q:after{content:close-quote} i:before{content:close-quote "!"}' +
        '</style><q>a<q>b</q></q><i></i>',
    ),
    // the innermost pair repeats, and a close with nothing open writes
    // nothing of its own
    '<a<b>>!',
  );
});

/** The first letters a document has: the text in each, its colour, and
 *  whether it floats. */
async function firstLetters(
  source: string,
): Promise<{ text: string; color: string; float: boolean }[]> {
  const { node } = await render(source, 300);
  type B = {
    pseudo: string | null;
    text: string;
    isFloat: boolean;
    style: { color: string };
    children: B[];
  };
  const root = (view(node) as unknown as { _tree: { root: B } })._tree.root;
  const out: { text: string; color: string; float: boolean }[] = [];
  const walk = (b: B): void => {
    if (b.pseudo === 'first-letter') {
      out.push({
        text: b.children.map((c) => c.text).join(''),
        color: b.style.color,
        float: b.isFloat,
      });
    }
    b.children.forEach(walk);
  };
  walk(root);
  return out;
}

test('::first-letter takes the letter and the punctuation around it', async () => {
  const green = parseColor('green');
  assert.deepStrictEqual(
    await firstLetters(
      '<style>p::first-letter{color:green}</style><p>\u201cT\u201d est</p>',
    ),
    [{ text: '\u201cT\u201d', color: green, float: false }],
  );
  // CSS 2's single colon, down into the first block, inside a span, and a
  // float for a drop cap; the text is the document's all the same
  assert.deepStrictEqual(
    await firstLetters(
      '<style>div:first-letter{color:green;float:left}</style>' +
        '<div><p><b>(Q)uick</b></p><p>Later</p></div>',
    ),
    [{ text: '(Q)', color: green, float: true }],
  );
  assert.strictEqual(
    await documentText(
      '<style>p::first-letter{color:green}</style><p>(Q)uick</p>',
    ),
    '(Q)uick',
  );
});

test('::first-letter is not found past a break or an inline-block', async () => {
  const css = '<style>p::first-letter{color:green}</style>';
  assert.deepStrictEqual(await firstLetters(css + '<p><br>Two</p>'), []);
  assert.deepStrictEqual(
    await firstLetters(
      css + '<p><span style="display:inline-block">x</span> y</p>',
    ),
    [],
  );
  // a float is no part of the line, and an empty element is nothing on it
  assert.deepStrictEqual(
    (
      await firstLetters(
        css + '<p><span style="float:left">f</span><i></i> Yes</p>',
      )
    ).map((l) => l.text),
    ['Y'],
  );
  // `<q>`'s open quote is in a text of its own, and goes with the letter;
  // a quote that no letter follows on its line gives the style back
  const q = '<style>q::before{content:open-quote}</style>';
  assert.deepStrictEqual(
    (await firstLetters(css + q + '<p><q>Hi</q> there</p>')).map((l) => l.text),
    ['\u201c', 'H'],
  );
  assert.deepStrictEqual(
    await firstLetters(css + '<p><i>\u201c</i><br>Hi</p>'),
    [],
  );
});

test('an inline-block on a line is painted once', async () => {
  // the line paints what is placed on it, and the paragraph's own walk
  // over its children must not paint it again: a translucent fill drawn
  // twice is twice as opaque, and text twice as heavy
  const { node } = await render(
    '<p>a <span style="display:inline-block;width:13px;height:11px;' +
      'background:rgba(0,0,255,0.5)"></span> <img width="7" height="5"> b</p>',
  );
  const fills = await fillsOf(view(node));
  assert.strictEqual(fills.filter((f) => f.w === 13 && f.h === 11).length, 1);
});

test('an anchor with no href is drawn as the text around it', async () => {
  const { node } = await render(
    '<p style="color:#123456"><a id="n">name</a> <a id="l" href="#">link</a></p>',
  );
  const el = view(node);
  const styleOf = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { color: string; textDecorationLine: string };
      }
    ).style;
  assert.strictEqual(styleOf('n').color, parseColor('#123456'));
  assert.strictEqual(styleOf('n').textDecorationLine, 'none');
  assert.notStrictEqual(styleOf('l').color, parseColor('#123456'));
});

test('a pseudo-element is a box of its own display', async () => {
  const { node } = await render(
    '<style>.cf:after{content:"";display:block;height:10px}' +
      '.cf:before{content:"x";display:table-column}</style>' +
      '<div class="cf" id="cf"><span>in</span></div>',
    300,
  );
  type B = { pseudo: string | null; kind: string; children: B[] };
  const cf = boxOf(view(node), 'cf') as unknown as B;
  const pseudos = cf.children
    .filter((b) => b.pseudo)
    .map((b) => [b.pseudo, b.kind]);
  // the column renders nothing, so it makes no box
  assert.deepStrictEqual(pseudos, [['after', 'block']]);
});

test('the font shorthand resets what it does not name', async () => {
  // CSS 2.1 15.8: `font` sets the style, weight, size, line height and
  // family, and whatever it leaves out goes back to its initial value rather
  // than keeping the parent's. `p { font: 12pt serif }` in a document set at
  // `20px/1em` has lines of normal height; the suite's margin-collapse tests
  // are built on it, and 20px lines put their text a pixel low.
  const { node } = await render(
    '<div style="font: italic bold 20px/40px sans-serif">' +
      '<p id="plain" style="font: 12px sans-serif">reset</p>' +
      '<p id="named" style="font: oblique 600 14px / 2 sans-serif">named</p>' +
      '<p id="sizeless" style="font: bold 14px">kept</p>' +
      '<p id="inherits" style="font: 0 sans-serif; font: inherit">all</p></div>',
    300,
  );
  type S = {
    fontStyle: string;
    fontWeight: number;
    fontSize: number;
    lineHeight: number | 'normal';
    lineHeightIsLength: boolean;
  };
  const style = (id: string) => {
    const { fontStyle, fontWeight, fontSize, lineHeight, lineHeightIsLength } =
      (boxOf(view(node), id) as unknown as { style: S }).style;
    return { fontStyle, fontWeight, fontSize, lineHeight, lineHeightIsLength };
  };
  assert.deepStrictEqual(style('plain'), {
    fontStyle: 'normal',
    fontWeight: 400,
    fontSize: 12,
    lineHeight: 'normal',
    lineHeightIsLength: false,
  });
  assert.deepStrictEqual(style('named'), {
    fontStyle: 'oblique',
    fontWeight: 600,
    fontSize: 14,
    lineHeight: 2,
    lineHeightIsLength: false,
  });
  // a size and no family is not a font: the declaration goes whole, and
  // what the paragraph inherited stands
  const inherited = {
    fontStyle: 'italic',
    fontWeight: 700,
    fontSize: 20,
    lineHeight: 40,
    lineHeightIsLength: true,
  };
  assert.deepStrictEqual(style('sizeless'), inherited);
  // and `font: inherit` takes all of it, the line height's unit included —
  // 40 read as a multiple would be lines 800px tall
  assert.deepStrictEqual(style('inherits'), inherited);
});

test('a line height below nought is none, alone or in the font shorthand', async () => {
  // the declaration goes (CSS 2.1 10.8.1): `font: 4em/-2em serif` set the
  // text at 4em, and `line-height: -2` stood its lines on one another
  const { node } = await render(
    '<div style="font: 20px/30px sans-serif">' +
      '<p id="a" style="font: 40px/-20px sans-serif">a</p>' +
      '<p id="b" style="line-height: -2">b</p>' +
      '<p id="c" style="line-height: -10px">c</p></div>',
  );
  const style = (id: string) =>
    (
      boxOf(view(node), id) as unknown as {
        style: { fontSize: number; lineHeight: number | 'normal' };
      }
    ).style;
  assert.deepStrictEqual(
    [style('a').fontSize, style('b').lineHeight, style('c').lineHeight],
    [20, 30, 30],
  );
});

test('an unquoted family name is its words with one space between', async () => {
  // `Courier    New` over two lines, or with a tab, is `Courier New`
  // (CSS 2.1 15.3); kept as written, it was a name no font has
  const { node } = await render(
    '<p id="a" style="font-family: Courier    New, serif">a</p>' +
      '<p id="b" style="font-family: \'Courier  New\'">b</p>',
  );
  const family = (id: string) =>
    (boxOf(view(node), id) as unknown as { style: { fontFamily: string } })
      .style.fontFamily;
  assert.deepStrictEqual(
    [family('a'), family('b')],
    ['Courier New, serif', 'Courier  New'],
  );
});

metric(
  'mixed-sign sibling margins collapse to the sum of the extremes',
  async () => {
    // CSS 8.3.1: largest positive plus most negative — 40 + (-10) = 30. The
    // easy wrong answers are 40 (max of the pair) and 30-with-clamping bugs.
    const { node } = await render(
      '<style>p{margin:0}.a{margin-bottom:40px}.b{margin-top:-10px}</style>' +
        '<p class="a">one</p><p class="b">two</p>',
    );
    const tree = (
      view(node) as unknown as {
        _tree: { root: { children: { y: number; height: number }[] } };
      }
    )._tree;
    const [a, b] = tree.root.children;
    assert.ok(Math.abs(b.y - (a.y + a.height) - 30) < 1);
  },
);

metric(
  "a paragraph's bottom margin escapes a plain div around it",
  async () => {
    // Collapse-through: the div has no bottom border, padding or height, so
    // the margin belongs between the div and what follows — not dropped.
    const { node } = await render(
      '<style>p{margin:0 0 20px}div{margin:0}</style>' +
        '<div><p>in a div</p></div><p>after</p>',
    );
    const tree = (
      view(node) as unknown as {
        _tree: { root: { children: { y: number; height: number }[] } };
      }
    )._tree;
    const [d, after] = tree.root.children;
    assert.ok(Math.abs(after.y - (d.y + d.height) - 20) < 1);
  },
);

metric(
  "a paragraph's top margin escapes a plain div around it, and a padded one keeps it",
  async () => {
    // CSS 2.1 8.3.1: nothing parts a plain div's top edge from its first
    // child's, so the paragraph's margin and the one before it are one
    // margin. Applied inside the div as well, <div><p> stood a paragraph's
    // margin lower than <p> — which is most of the CSS 2.1 selector tests.
    const { node } = await render(
      '<style>p{margin:20px 0}div{margin:0}.pad{padding-top:1px}</style>' +
        '<p>before</p><div><p>in a div</p></div>' +
        '<div class="pad"><p>padded</p></div>',
    );
    type B = { y: number; height: number; children: B[] };
    const tree = (view(node) as unknown as { _tree: { root: B } })._tree;
    const [before, plain, padded] = tree.root.children;
    const inPlain = plain.children[0];
    const inPadded = padded.children[0];
    const gap = inPlain.y - (before.y + before.height);
    assert.ok(Math.abs(gap - 20) < 1, `one margin between them, got ${gap}`);
    assert.ok(
      Math.abs(plain.y - inPlain.y) < 1,
      'the div starts where its paragraph does',
    );
    // the padding parts the padded div from its paragraph: the margin is
    // applied inside it, after the padding
    assert.ok(
      Math.abs(inPadded.y - (padded.y + 1 + 20)) < 1,
      `the padded div keeps its paragraph's margin inside, got ${inPadded.y - padded.y}`,
    );
  },
);

metric(
  'a flex container whose children are bare text still renders them',
  async () => {
    // Flex has no inline formatting context: a run of inline content becomes
    // an anonymous item. Dropping it renders an empty row.
    const { node } = await render('<div style="display:flex">just text</div>');
    const el = view(node);
    assert.ok(el.textContent().includes('just text'));
    const tree = (
      view(node) as unknown as {
        _tree: { root: { children: { height: number }[] } };
      }
    )._tree;
    assert.ok(tree.root.children[0].height > 10, 'the row has the text height');
  },
);

metric('<br> breaks the line on the one-layout fast path too', async () => {
  const { node } = await render('<style>p{margin:0}</style><p>a<br><br>b</p>');
  const tree = (
    view(node) as unknown as {
      _tree: { root: { children: { lines: unknown[] | null }[] } };
    }
  )._tree;
  // a / blank / b — the blank line is real and takes the font's height.
  assert.strictEqual(tree.root.children[0].lines?.length, 3);
});

metric(
  'run backgrounds paint under the ink on every line, not just the first',
  async () => {
    // ntk draws a whole layout in one glyph batch, so a highlight reaching a
    // second line must be filled before the batch — filled after, it covers
    // the glyphs. The recorder replaces the layouts' `draw` and asserts every
    // highlight fill lands before any ink.
    const { node } = await render(
      '<style>p{margin:0}.hl{background:#ffee55}</style>' +
        '<p>before <span class="hl">a highlighted stretch of text long enough ' +
        'that it certainly wraps onto the following line</span> after</p>',
      240,
    );
    const el = view(node);
    const tree = (el as unknown as { _tree: unknown })._tree as {
      root: {
        children: unknown[];
        lines: { texts: { layout: { draw(): void } }[] }[] | null;
      };
    };
    const events: string[] = [];
    const patched = new Set<unknown>();
    const patch = (box: {
      children: unknown[];
      lines: { texts: { layout: { draw(): void } }[] }[] | null;
    }): void => {
      for (const line of box.lines ?? []) {
        for (const text of line.texts) {
          if (patched.has(text.layout)) continue;
          patched.add(text.layout);
          text.layout.draw = () => events.push('ink');
        }
      }
      for (const child of box.children) patch(child as typeof box);
    };
    patch(tree.root);

    const { paintDocument } = await import('../src/html/paint.js');
    let fillStyle: unknown = null;
    paintDocument(
      {
        set fillStyle(v: unknown) {
          fillStyle = v;
        },
        get fillStyle() {
          return fillStyle;
        },
        save() {},
        restore() {},
        fillRect() {
          events.push(fillStyle === '#ffee55' ? 'highlight' : 'fill');
        },
      } as never,
      (el as unknown as { _tree: never })._tree,
      {
        originX: 0,
        originY: 0,
        damage: null,
        selection: null,
        selectionColor: null,
        imageFor: () => null,
      },
    );
    const highlights = events.filter((e) => e === 'highlight').length;
    assert.ok(
      highlights >= 2,
      `the highlight spans lines (${highlights} fills)`,
    );
    const firstInk = events.indexOf('ink');
    const lastHighlight = events.lastIndexOf('highlight');
    assert.ok(firstInk >= 0, 'the ink was drawn');
    assert.ok(
      lastHighlight < firstInk,
      `every highlight fill precedes the ink (last highlight at ${lastHighlight}, first ink at ${firstInk})`,
    );
  },
);

metric(
  "a border with no colour of its own follows the element's ink",
  async () => {
    // `border-bottom: 2px solid` then `color: red` in the same rule: the
    // border is currentColor, resolved when it is painted — not frozen to the
    // colour the cascade happened to hold mid-rule.
    const { node } = await render(
      '<style>p{border-bottom:2px solid;color:#ff0000;margin:0}</style><p>x</p>',
    );
    const el = view(node);
    // The recorder has no window for ntk's glyph path to draw through, so the
    // ink is stubbed out — the border fills are what this test is about.
    const tree = (el as unknown as { _tree: unknown })._tree as {
      root: {
        children: unknown[];
        lines: { texts: { layout: { draw(): void } }[] }[] | null;
      };
    };
    const stub = (box: typeof tree.root): void => {
      for (const line of box.lines ?? []) {
        for (const text of line.texts) text.layout.draw = () => {};
      }
      for (const child of box.children) stub(child as typeof tree.root);
    };
    stub(tree.root);
    const { paintDocument } = await import('../src/html/paint.js');
    const fills: unknown[] = [];
    let fillStyle: unknown = null;
    paintDocument(
      {
        set fillStyle(v: unknown) {
          fillStyle = v;
        },
        get fillStyle() {
          return fillStyle;
        },
        save() {},
        restore() {},
        fillRect() {
          fills.push(fillStyle);
        },
      } as never,
      (el as unknown as { _tree: never })._tree,
      {
        originX: 0,
        originY: 0,
        damage: null,
        selection: null,
        selectionColor: null,
        imageFor: () => null,
      },
    );
    assert.ok(
      fills.includes('#ff0000'),
      `the border painted in the element's colour`,
    );
  },
);

test('a degenerately nested document is capped, not crashed', async () => {
  // The box tree stops at depth 512 (Blink flattens at the same number), so
  // fuzzer-shaped nesting cannot blow the stack five phases later.
  const depth = 4000;
  const source =
    '<div>'.repeat(depth) + '<p>bottom</p>' + '</div>'.repeat(depth);
  const result = await renderX11(
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source, partial: false, 'data-testname': 'doc' }),
    ),
    { backend: 'mock' },
  );
  const el = view(screen.getByTestName('doc') as DrawnNode);
  // The capped content is dropped; the point is that nothing threw.
  assert.strictEqual(typeof el.textContent(), 'string');
  void result;
});

metric('a tall document renders at any scroll depth', async () => {
  // The whole promise: viewport-bounded painting, whatever the height. The
  // background fill, the borders and every glyph batch have to survive X's
  // Int16 coordinates while the element sits hundreds of thousands of
  // pixels tall — scrolled to the middle, there must be ink on screen.
  const para =
    '<p>The quick brown fox jumps over the lazy dog and keeps going for a while longer.</p>';
  const result = await renderX11(
    h(
      'box',
      {
        style: { width: 500, height: 400, overflow: 'scroll' },
        'data-testname': 'scroller',
      },
      h(
        'box',
        { style: { flexDirection: 'column' } },
        h(Html, {
          source: '<style>body{background:#f4f6f8}</style>' + para.repeat(2500),
          partial: false,
          'data-testname': 'doc',
        }),
      ),
    ),
    { width: 540, height: 440, fonts: FONTS! },
  );
  const scroller = screen.getByTestName('scroller') as DrawnNode & {
    scrollTo(to: { y: number }): void;
  };
  const doc = view(screen.getByTestName('doc') as DrawnNode);
  const height = (doc as unknown as { abs: { height: number } }).abs.height;
  assert.ok(height > 60000, `the document is genuinely tall (${height}px)`);
  await act(async () => {
    scroller.scrollTo({ y: Math.round(height / 2) });
  });
  const { countPixels, settle } = await import('react-x11/test');
  await settle(result.app, 3);
  const ink = await countPixels(
    result.ctx,
    { x: 0, y: 0, width: 500, height: 400 },
    '#2d3436',
    60,
  );
  assert.ok(ink > 1000, `text is on screen at half-scroll (${ink} ink pixels)`);
});

metric('a huge <pre> is chunked, renders deep, and still selects', async () => {
  // One box, thousands of hard-broken lines: a single TextLayout would be
  // one glyph batch taller than X can address, so it is laid out in chunks
  // split at newlines — invisible seams, drawable pieces. The selection
  // accessors must agree across the chunk boundaries.
  const LINES = 5000;
  const log = Array.from(
    { length: LINES },
    (_, i) => `line ${i} of the log`,
  ).join('\n');
  const { node } = await render(`<pre>${log}</pre>`, 500);
  const el = view(node);
  const text = el.textContent();
  assert.ok(text.includes('line 4999'), 'every line is in the document text');

  const tree = (
    el as unknown as {
      _tree: { root: { children: { lines: { texts: unknown[] }[] | null }[] } };
    }
  )._tree;
  const pre = tree.root.children.find((b) => b.lines && b.lines.length > 1000);
  assert.ok(pre?.lines, 'the pre laid out');
  const layouts = new Set<unknown>();
  for (const line of pre.lines) {
    for (const t of line.texts) layouts.add((t as { layout: unknown }).layout);
  }
  assert.ok(
    layouts.size > 10,
    `the text is many layouts, not one (${layouts.size})`,
  );

  // A caret deep in the pre round-trips through a chunk that is not the first.
  const at = text.indexOf('line 3000');
  const caret = el.textCaretRect(at);
  assert.ok(caret, 'a deep caret resolves');
  const back = el.textIndexAt(caret.x + 1, caret.y + caret.height / 2);
  assert.ok(Math.abs(back - at) <= 1, `round-tripped to ${back}, wanted ${at}`);

  // A range crossing a chunk boundary yields bands on both sides.
  const boundary = text.indexOf('line 63'); // chunks are 64 hard lines
  const bands = el.textRangeRects(boundary, text.indexOf('line 65'));
  assert.ok(bands.length >= 2, `bands across the seam (${bands.length})`);
});

metric('non-BMP text still maps points to units both ways', async () => {
  // The identity shortcut must step aside when surrogate pairs exist: two
  // emoji before a word shift its code-unit offsets by two.
  const { node } = await render('<p>\u{1F600}\u{1F680} rocket</p>', 400);
  const el = view(node);
  const points = [...el.textContent()];
  const wordAt = points.indexOf('r'); // code-point index of "rocket"
  const caret = el.textCaretRect(wordAt);
  assert.ok(caret, 'caret after the emoji resolves');
  const back = el.textIndexAt(caret.x + 1, caret.y + caret.height / 2);
  assert.ok(
    Math.abs(back - wordAt) <= 1,
    `code-point round trip through surrogates (${back} vs ${wordAt})`,
  );
});

metric('an authored space before an inline atomic survives', async () => {
  // ntk strips a line's trailing whitespace; a fragment that ends before an
  // atomic is not a line end, so the stripped advance is measured back. The
  // probe is an <img> because images carry no UA margin — the gap this
  // asserts is the space itself.
  const { node } = await render(
    '<style>p{margin:0}img{margin:0}</style>' +
      '<p>Name <img src="x.png" width="20" height="10"> tail</p>',
  );
  const tree = (
    view(node) as unknown as {
      _tree: {
        root: {
          children: {
            lines:
              | {
                  texts: {
                    drawX: number;
                    layout: { lines: { width: number }[] };
                    layoutLine: number;
                  }[];
                  atomics: { box: { x: number } }[];
                }[]
              | null;
          }[];
        };
      };
    }
  )._tree;
  const line = tree.root.children[0].lines?.[0];
  assert.ok(line && line.atomics.length === 1);
  const label = line.texts[0];
  const inkEnd = label.drawX + label.layout.lines[label.layoutLine].width;
  const gap = line.atomics[0].box.x - inkEnd;
  assert.ok(
    gap > 2,
    `the image sits a space past the label (gap ${gap.toFixed(1)}px)`,
  );
});

// --- inline boxes -------------------------------------------------------------
//
// An inline element's padding, border and margin take room on its line — its
// start side before its first fragment, its end side after its last — and its
// background and border are painted a fragment a line, over its face's height
// and its padding, rounded and bordered only where the element starts and
// ends (CSS 2.1 8.6, 10.6.1). A line with anything but text on it is placed
// piece by piece, which is also where it is aligned and, where it reads right
// to left, put in visual order.

interface PlacedText {
  drawX: number;
  drawY: number;
  layout: { lines: { x: number; width: number; baseline: number }[] };
  layoutLine: number;
  textStart: number;
  textEnd: number;
}

interface PlacedLine {
  x: number;
  y: number;
  width: number;
  height: number;
  baseline: number;
  texts: PlacedText[];
  atomics: { x: number; box: { width: number } }[];
  edges?: { side: 'start' | 'end'; x: number; width: number }[];
}

/** Every line under an element, in document order. */
function linesOf(el: HtmlViewNode, id: string): PlacedLine[] {
  type B = { lines: PlacedLine[] | null; children: B[] };
  const out: PlacedLine[] = [];
  const walk = (b: B): void => {
    out.push(...(b.lines ?? []));
    b.children.forEach(walk);
  };
  walk(boxOf(el, id) as unknown as B);
  return out;
}

/** Where a fragment's text starts and ends. */
function extentOf(text: PlacedText): [number, number] {
  const natural = text.layout.lines[text.layoutLine];
  return [text.drawX + natural.x, text.drawX + natural.x + natural.width];
}

/** Where each run of a line's document text lies, left to right: a line
 *  laid out in one piece has its inline boxes' edges in it as spacers,
 *  which are no text of the document's and are left out. */
function textRunsOf(line: PlacedLine): [number, number][] {
  const out: [number, number][] = [];
  for (const text of line.texts) {
    const t = text as PlacedText & {
      layout: {
        lines: { runs?: { x: number; width: number; start: number }[] }[];
      };
      spans: { boxAt?(offset: number): unknown };
    };
    const natural = t.layout.lines[t.layoutLine] as {
      x: number;
      runs?: { x: number; width: number; start: number }[];
    };
    for (const run of natural.runs ?? []) {
      if (t.spans.boxAt && !t.spans.boxAt(run.start)) continue;
      const x = t.drawX + natural.x + run.x;
      out.push([x, x + run.width]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

interface Fill {
  style: unknown;
  x: number;
  y: number;
  w: number;
  h: number;
  /** A rounded fill's corners; null for a plain rectangle. */
  radii: number[] | null;
  /** A second subpath and the rule it was filled by: a ring's inside. */
  inner?: {
    x: number;
    y: number;
    w: number;
    h: number;
    radii: number[] | null;
  };
  rule?: string;
  /** A path of curves: each curve's reach across and down, in the order
   *  drawn — a quarter ellipse's radii. The bounds are the whole path's. */
  corners?: [number, number][];
  /** The context's shadow when the fill was made, where it had a blur. */
  shadow?: { color: string; blur: number; x: number; y: number };
}

/** What a paint did, in order: a fill, or a clip pushed or popped. */
type PaintOp =
  | ({ op: 'fill' } & Fill)
  | {
      op: 'clip';
      x: number;
      y: number;
      w: number;
      h: number;
      radii: number[] | null;
    }
  | { op: 'save' }
  | { op: 'restore' }
  | {
      op: 'image';
      x: number;
      y: number;
      w: number;
      h: number;
      /** The piece of the image drawn, where not all of it is. */
      src?: number[];
    }
  | { op: 'text'; x: number; y: number; shadow?: Fill['shadow'] };

/** What painting the document fills, in order. The glyphs are left out:
 *  the recorder has nowhere to draw them. `ops`, when given, gets the fills
 *  and the clips around them. */
async function fillsOf(
  el: HtmlViewNode,
  ops?: PaintOp[],
  options?: {
    canvas?: { x: number; y: number; width: number; height: number };
    imageFor?: () => unknown;
    cached?: (
      key: string,
      width: number,
      height: number,
      draw: (ctx: never) => void,
    ) => unknown;
    backgroundImageFor?: (url: string) => {
      image: unknown;
      width: number | null;
      height: number | null;
      ratio: number;
    } | null;
    scale?: number;
  },
): Promise<Fill[]> {
  const { paintDocument } = await import('../src/html/paint.js');
  type T = { lines: { texts: { layout: object }[] }[] | null; children: T[] };
  const tree = (el as unknown as { _tree: { root: T } })._tree;
  const layouts = new Set<object>();
  const walk = (b: T): void => {
    for (const line of b.lines ?? []) {
      for (const text of line.texts) layouts.add(text.layout);
    }
    b.children.forEach(walk);
  };
  walk(tree.root);
  const fills: Fill[] = [];
  let fillStyle: unknown = null;
  let path: Omit<Fill, 'style'> | null = null;
  let inner: Fill['inner'] | null = null;
  let curves: {
    at: [number, number];
    corners: [number, number][];
    box: [number, number, number, number];
  } | null = null;
  const reach = (x: number, y: number): void => {
    const b = curves!.box;
    curves!.at = [x, y];
    b[0] = Math.min(b[0], x);
    b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x);
    b[3] = Math.max(b[3], y);
  };
  const shadowOf = (): Fill['shadow'] =>
    ctx.shadowBlur > 0
      ? {
          color: ctx.shadowColor,
          blur: ctx.shadowBlur,
          x: ctx.shadowOffsetX,
          y: ctx.shadowOffsetY,
        }
      : undefined;
  const saved: [string, number, number, number][] = [];
  const ctx = {
    shadowColor: 'rgba(0, 0, 0, 0)',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(v: unknown) {
      fillStyle = v;
    },
    save() {
      saved.push([
        ctx.shadowColor,
        ctx.shadowBlur,
        ctx.shadowOffsetX,
        ctx.shadowOffsetY,
      ]);
      ops?.push({ op: 'save' });
    },
    restore() {
      const state = saved.pop();
      if (state) {
        [
          ctx.shadowColor,
          ctx.shadowBlur,
          ctx.shadowOffsetX,
          ctx.shadowOffsetY,
        ] = state;
      }
      ops?.push({ op: 'restore' });
    },
    fillRect(x: number, y: number, w: number, h: number) {
      const fill = { style: fillStyle, x, y, w, h, radii: null };
      fills.push(fill);
      ops?.push({ op: 'fill', ...fill });
    },
    beginPath() {
      path = null;
      inner = null;
      curves = null;
    },
    moveTo(x: number, y: number) {
      curves ??= { at: [x, y], corners: [], box: [x, y, x, y] };
      reach(x, y);
    },
    lineTo(x: number, y: number) {
      reach(x, y);
    },
    bezierCurveTo(...args: number[]) {
      const [x, y] = args.slice(4);
      const [fromX, fromY] = curves!.at;
      curves!.corners.push([Math.abs(x - fromX), Math.abs(y - fromY)]);
      reach(x, y);
    },
    closePath() {},
    rect(x: number, y: number, w: number, h: number) {
      path = { x, y, w, h, radii: null };
    },
    roundRect(x: number, y: number, w: number, h: number, radii: number[]) {
      if (path) inner = { x, y, w, h, radii };
      else path = { x, y, w, h, radii };
    },
    fill(rule?: string) {
      if (curves) {
        const [x0, y0, x1, y1] = curves.box;
        const fill: Fill = {
          style: fillStyle,
          x: x0,
          y: y0,
          w: x1 - x0,
          h: y1 - y0,
          radii: null,
          corners: curves.corners,
          rule,
        };
        const shadow = shadowOf();
        if (shadow) fill.shadow = shadow;
        fills.push(fill);
        ops?.push({ op: 'fill', ...fill });
        curves = null;
        path = null;
        inner = null;
        return;
      }
      if (path) {
        const fill: Fill = { style: fillStyle, ...path };
        if (inner) Object.assign(fill, { inner, rule });
        const shadow = shadowOf();
        if (shadow) fill.shadow = shadow;
        fills.push(fill);
        ops?.push({ op: 'fill', ...fill });
      }
      path = null;
      inner = null;
    },
    clip() {
      if (curves) {
        const [x0, y0, x1, y1] = curves.box;
        ops?.push({
          op: 'clip',
          x: x0,
          y: y0,
          w: x1 - x0,
          h: y1 - y0,
          radii: null,
        });
        curves = null;
      }
      if (path) {
        const { x, y, w, h, radii } = path;
        ops?.push({ op: 'clip', x, y, w, h, radii });
      }
      path = null;
    },
    drawImage(_image: unknown, ...args: number[]) {
      if (args.length >= 8) {
        const [x, y, w, h] = args.slice(4);
        ops?.push({ op: 'image', x, y, w, h, src: args.slice(0, 4) });
        return;
      }
      const [x, y, w, h] = args;
      ops?.push({ op: 'image', x, y, w, h });
    },
    createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
      const stops: [number, string][] = [];
      return {
        line: [x0, y0, x1, y1],
        stops,
        addColorStop(at: number, color: string) {
          stops.push([at, color]);
        },
      };
    },
  };
  for (const layout of layouts) {
    (layout as { draw: unknown }).draw = (_: unknown, x: number, y: number) => {
      const shadow = shadowOf();
      ops?.push({ op: 'text', x, y, ...(shadow ? { shadow } : null) });
    };
  }
  try {
    paintDocument(ctx as never, tree as never, {
      originX: 0,
      originY: 0,
      damage: null,
      selection: null,
      selectionColor: null,
      imageFor: () => null,
      ...options,
    });
  } finally {
    for (const layout of layouts) delete (layout as { draw?: unknown }).draw;
  }
  return fills;
}

metric(
  "an inline element's padding, border and margin take room on its line",
  async () => {
    const { node } = await render(
      '<p id="p" style="margin:0">ab<span style="padding:0 10px;' +
        'border-left:3px solid;margin-right:5px">cd</span>ef</p>',
    );
    const [line] = linesOf(view(node), 'p');
    const runs = textRunsOf(line);
    assert.strictEqual(runs.length, 3, 'before, inside and after it');
    const [ab, cd, ef] = runs;
    assert.ok(
      Math.abs(cd[0] - ab[1] - 13) < 0.5,
      `its left border and padding: ${cd[0] - ab[1]}`,
    );
    assert.ok(
      Math.abs(ef[0] - cd[1] - 15) < 0.5,
      `its right padding and margin: ${ef[0] - cd[1]}`,
    );
  },
);

metric(
  "an inline element's edges are no text: a caret, a point and a selection land on its letters",
  async () => {
    const { node } = await render(
      '<p id="p" style="margin:0">ab <code style="padding:0 10px">cd</code> ef</p>',
    );
    const el = view(node);
    const [line] = linesOf(el, 'p');
    assert.strictEqual(line.texts.length, 1, 'one layout, the edges in it');
    assert.strictEqual(el.textContent(), 'ab cd ef');
    const [ab, cd, ef] = textRunsOf(line);
    // the accessors answer in the window, the runs in the document
    const dx = el.textCaretRect(0)!.x - ab[0];
    const caret = el.textCaretRect(3)!;
    assert.ok(
      Math.abs(caret.x - dx - cd[0]) < 0.5,
      `before its first letter, past its padding: ${caret.x - dx} vs ${cd[0]}`,
    );
    assert.ok(
      Math.abs(el.textCaretRect(5)!.x - dx - ef[0]) < 0.5,
      'after it, past the padding at its end',
    );
    assert.strictEqual(
      el.textIndexAt(caret.x + 1, caret.y + caret.height / 2),
      3,
      'a point on its first letter is that letter',
    );
    const [band] = el.textRangeRects(3, 5);
    assert.ok(
      Math.abs(band.x - dx - cd[0]) < 0.5 &&
        Math.abs(band.width - (cd[1] - cd[0])) < 0.5,
      `a selection of its letters leaves the padding out: ${band.x - dx} +${band.width}`,
    );
  },
);

metric(
  'vertical padding on an inline element leaves its line as tall',
  async () => {
    const plain = await render(
      '<p id="p" style="margin:0">ab <span>cd</span> ef</p>',
    );
    const [before] = linesOf(view(plain.node), 'p');
    await plain.result.unmount();
    const padded = await render(
      '<p id="p" style="margin:0">ab <span style="padding:12px 4px;' +
        'border:2px solid">cd</span> ef</p>',
    );
    const [after] = linesOf(view(padded.node), 'p');
    assert.strictEqual(after.height, before.height);
  },
);

metric(
  "an inline element's opening edge goes to the next line with its first word",
  async () => {
    // wide enough for both words, and not for the padding as well
    const probe = await render('<p id="p" style="margin:0">aaaa bbbb</p>', 600);
    const width = Math.ceil(linesOf(view(probe.node), 'p')[0].width) + 2;
    await probe.result.unmount();
    const { node } = await render(
      `<p id="p" style="margin:0;width:${width}px">aaaa ` +
        '<span style="padding-left:30px">bbbb</span></p>',
      600,
    );
    const lines = linesOf(view(node), 'p');
    assert.strictEqual(lines.length, 2, 'the padding does not fit');
    assert.ok(!lines[0].edges?.length, 'nothing is left at the first line end');
    const [edge] = lines[1].edges ?? [];
    assert.ok(edge?.side === 'start', 'the edge opens the second line');
    const [word] = textRunsOf(lines[1]);
    assert.ok(Math.abs(word[0] - edge.x - 30) < 0.5, 'and the word follows it');
  },
);

metric(
  'an inline background covers its face and padding, not the line',
  async () => {
    const { result, node } = await render(
      '<style>body{margin:0}</style>' +
        '<p id="p" style="margin:0;font-size:16px;line-height:48px">' +
        '<span style="background:#ff0000;color:#ff0000;padding:2px 6px">XX</span></p>',
    );
    const [line] = linesOf(view(node), 'p');
    const [text] = line.texts;
    const [[left, right]] = textRunsOf(line);
    const baseline = text.drawY + text.layout.lines[text.layoutLine].baseline;
    const red = async (x: number, y: number): Promise<boolean> => {
      const [r, g, b] = await pixelAt(result.ctx, Math.round(x), Math.round(y));
      return r > 200 && g < 60 && b < 60;
    };
    assert.ok(await red(left - 3, baseline - 4), 'the left padding');
    assert.ok(await red(right + 3, baseline - 4), 'the right padding');
    assert.ok(!(await red(right + 9, baseline - 4)), 'and nothing past it');
    assert.ok(
      !(await red(left + 2, line.y + 3)),
      "the leading above the face is the line's, not the element's",
    );
  },
);

metric(
  'a highlight is one background under a nested element, and first',
  async () => {
    const { node } = await render(
      '<p id="p" style="margin:0"><mark style="background:#ffff00">one ' +
        '<b style="background:#ff8800">two</b> three</mark></p>',
    );
    const fills = await fillsOf(view(node));
    const outer = fills.filter((f) => f.style === '#ffff00');
    const inner = fills.filter((f) => f.style === '#ff8800');
    assert.strictEqual(outer.length, 1, 'one fragment on the one line');
    assert.strictEqual(inner.length, 1);
    assert.ok(fills.indexOf(outer[0]) < fills.indexOf(inner[0]), 'under it');
    assert.ok(
      outer[0].x < inner[0].x &&
        outer[0].x + outer[0].w > inner[0].x + inner[0].w,
      'and around it',
    );
  },
);

metric(
  'a rounded inline background is rounded only where it starts and ends',
  async () => {
    const { node } = await render(
      '<p id="p" style="margin:0;width:90px"><span style="background:#0000ff;' +
        'border-radius:6px">several words that wrap across lines</span></p>',
    );
    const fills = (await fillsOf(view(node))).filter(
      (f) => f.style === '#0000ff',
    );
    assert.ok(fills.length >= 3, `a fragment a line: ${fills.length}`);
    assert.deepStrictEqual(fills[0].radii, [6, 0, 0, 6], 'the first: its left');
    assert.deepStrictEqual(
      fills.at(-1)!.radii,
      [0, 6, 6, 0],
      'the last: its right',
    );
    for (const middle of fills.slice(1, -1)) {
      assert.strictEqual(middle.radii, null, 'the ones between are square');
    }
  },
);

metric(
  'a centred line with an inline-block on it is centred whole',
  async () => {
    // Each piece of a line with an atomic on it used to be centred alone, and
    // the pieces after the first were placed as though it had not been.
    const { node } = await render(
      '<style>body{margin:0}</style><p id="p" style="margin:0;width:300px;' +
        'text-align:center">left <span style="display:inline-block;width:30px;' +
        'height:10px"></span> right</p>',
    );
    const [line] = linesOf(view(node), 'p');
    const [a, b] = line.texts.map(extentOf);
    const box = line.atomics[0];
    assert.ok(
      a[1] <= box.x && box.x + box.box.width <= b[0],
      `in order: ${a}, ${box.x}, ${b}`,
    );
    assert.ok(Math.abs(a[0] - (300 - b[1])) < 2, `centred: ${a[0]}, ${b[1]}`);
  },
);

metric(
  'a right-to-left line with an inline-block on it reads right to left',
  async () => {
    const block =
      '<span style="display:inline-block;width:30px;height:10px"></span>';
    const { node } = await render(
      '<style>body{margin:0}p{margin:0;width:300px;direction:rtl}</style>' +
        `<p id="he">אחת ${block} שתיים</p><p id="en">Hello ${block} world</p>`,
    );
    const [he] = linesOf(view(node), 'he');
    const [one, two] = he.texts.map(extentOf);
    const heBox = he.atomics[0];
    assert.ok(
      two[1] <= heBox.x && heBox.x + heBox.box.width <= one[0],
      `the first word rightmost: ${one}, ${heBox.x}, ${two}`,
    );
    assert.ok(Math.abs(one[1] - 300) < 1, `and flush right: ${one[1]}`);
    // left-to-right words either side of it keep their order (UAX #9 N1)
    const [en] = linesOf(view(node), 'en');
    const [hello, world] = en.texts.map(extentOf);
    const enBox = en.atomics[0];
    assert.ok(
      hello[1] <= enBox.x && enBox.x + enBox.box.width <= world[0],
      `left to right inside it: ${hello}, ${enBox.x}, ${world}`,
    );
    assert.ok(Math.abs(world[1] - 300) < 1, `still flush right: ${world[1]}`);
  },
);

metric("an inline element's start side is its direction's", async () => {
  // CSS 2.1 8.6: a right-to-left element starts on its right
  const { node } = await render(
    '<p id="p" style="margin:0;direction:rtl">אחת <span style="padding-right:12px;' +
      'padding-left:4px">שתיים</span> שלוש</p>',
  );
  const [line] = linesOf(view(node), 'p');
  const inside = extentOf(line.texts[1]);
  const start = line.edges?.find((e) => e.side === 'start');
  const end = line.edges?.find((e) => e.side === 'end');
  assert.ok(start && end, 'both edges are on the line');
  assert.strictEqual(start.width, 12);
  assert.strictEqual(end.width, 4);
  assert.ok(
    Math.abs(start.x - inside[1]) < 0.5,
    'the start, right of its text',
  );
  assert.ok(
    Math.abs(end.x + end.width - inside[0]) < 0.5,
    'the end, left of it',
  );
});

metric(
  "a block's background is not painted again behind its text",
  async () => {
    // The run took the text's style, which was the block's, and filled its
    // background behind every run: a block of no height showed it anyway.
    const { node } = await render(
      '<div style="background:#ff0000;height:0">Filler text</div>',
    );
    const fills = await fillsOf(view(node));
    assert.ok(
      !fills.some((f) => f.style === '#ff0000' && f.w > 0 && f.h > 0),
      'nothing red: the block is 0px tall',
    );
  },
);

metric(
  'a line with an inline-block on it is aligned in the room beside the floats over its height',
  async () => {
    // The second line is 50px tall; the wider float starts 25px into it.
    const block =
      '<span style="display:inline-block;width:200px;height:50px"></span>';
    const { node } = await render(
      '<style>body{margin:0}</style><div id="d" style="width:400px;text-align:right">' +
        '<div style="float:right;width:50px;height:75px"></div>' +
        '<div style="float:right;clear:right;width:100px;height:75px"></div>' +
        `${block} ${block}</div>`,
      500,
    );
    const lines = linesOf(view(node), 'd');
    assert.strictEqual(lines.length, 2);
    const [first] = lines[0].atomics;
    const [second] = lines[1].atomics;
    assert.strictEqual(
      first.x + first.box.width,
      350,
      'beside the narrow float',
    );
    assert.strictEqual(second.x + second.box.width, 300, 'beside the wide one');
  },
);

metric('a line that ends at a <br> ends, whatever follows it', async () => {
  const { node } = await render(
    '<p id="p" style="margin:0">one<br><span style="display:inline-block;' +
      'width:10px;height:10px"></span> two</p>',
  );
  const lines = linesOf(view(node), 'p');
  assert.strictEqual(lines.length, 2, 'the inline-block starts the second');
  assert.strictEqual(lines[0].atomics.length, 0);
  assert.strictEqual(lines[1].atomics.length, 1);
});

test('a border style alone draws a medium border, and a negative width is dropped', async () => {
  const { node } = await render(
    '<div id="alone" style="border-style:solid">a</div>' +
      '<div id="negative" style="border:1px solid;border-width:-2px">b</div>' +
      '<div id="zeros" style="border:solid;border-top-width:-0;' +
      'border-right-width:+0;border-bottom-width:0.0">c</div>',
  );
  type Edges = LaidBox & {
    borderTop: number;
    borderRight: number;
    borderBottom: number;
    borderLeft: number;
  };
  const el = view(node);
  const alone = boxOf(el, 'alone') as Edges;
  assert.deepStrictEqual(
    [alone.borderTop, alone.borderRight, alone.borderBottom, alone.borderLeft],
    [3, 3, 3, 3],
    'medium, as CSS starts every border',
  );
  const negative = boxOf(el, 'negative') as Edges;
  assert.strictEqual(negative.borderTop, 1, 'the width before it stands');
  const zeros = boxOf(el, 'zeros') as Edges;
  assert.deepStrictEqual(
    [zeros.borderTop, zeros.borderRight, zeros.borderBottom, zeros.borderLeft],
    [0, 0, 0, 3],
    '-0, +0 and 0.0 are zeros',
  );
});

test('negative or auto padding is no padding value', async () => {
  // CSS 2.1 8.4: padding is never negative and never `auto`; a declaration
  // that says so is dropped, and what came before it stands
  const { node } = await render(
    '<div id="a" style="padding:5px;padding-left:-1px">a</div>' +
      '<div id="b" style="padding:5px;padding:2px -3px">b</div>' +
      '<div id="c" style="padding:5px;padding:auto">c</div>',
  );
  const el = view(node);
  const pads = (id: string) => {
    const b = boxOf(el, id) as LaidBox & { padLeft: number; padTop: number };
    return [b.padTop, b.padLeft];
  };
  assert.deepStrictEqual(pads('a'), [5, 5]);
  assert.deepStrictEqual(pads('b'), [5, 5], 'the whole shorthand goes');
  assert.deepStrictEqual(pads('c'), [5, 5]);
});

metric("ex is the font's x-height, or half an em", async () => {
  const { node } = await render(
    '<div id="d" style="width:10ex;height:10px;font-size:20px"></div>',
  );
  const el = view(node);
  const fonts = (
    el as unknown as {
      app: {
        fonts: {
          match(
            f: string,
            s: object,
          ): { metrics(size: number): { xHeight?: number | null } };
        };
      };
    }
  ).app.fonts;
  // DejaVu Sans, which the Linux runs find, has an OS/2 table too old to
  // state an x-height, and the engine answers NaN; an ex is half an em then
  const stated = fonts.match('sans-serif', { size: 20 }).metrics(20).xHeight;
  const x = typeof stated === 'number' && stated > 0 ? stated : 10;
  assert.ok(Math.abs(boxOf(el, 'd').width - 10 * x) < 0.01);
});

metric('a ch is the advance of the font\'s "0"', async () => {
  // CSS Values 4, 6.1.1. It was half an em, which is a monospace font's
  // "0" short by a sixth: Tailwind's `max-w-prose` is 65ch, and a `20ch`
  // column of code held seventeen characters
  const { node } = await render(
    '<style>body{margin:0} div{font:20px monospace}</style>' +
      '<div id="a" style="width:10ch;height:10px"></div>' +
      '<div><span id="b" style="display:inline-block">0000000000</span></div>',
  );
  const el = view(node);
  const b = boxOf(el, 'b').width;
  assert.ok(b > 100, `ten zeros are wider than ten half ems: ${b}`);
  assert.ok(Math.abs(boxOf(el, 'a').width - b) < 0.01);
});

metric('letter-spacing and word-spacing reach the text', async () => {
  const widthOf = async (style: string): Promise<number> => {
    const probe = await render(
      `<p id="p" style="margin:0;${style}">ab cd</p>`,
      600,
    );
    const [line] = linesOf(view(probe.node), 'p');
    await probe.result.unmount();
    return line.width;
  };
  const plain = await widthOf('');
  const letters = await widthOf('letter-spacing:10px');
  const words = await widthOf('word-spacing:20px');
  // five characters take ten each, the last included, as browsers set it
  assert.ok(Math.abs(letters - plain - 50) < 1, `letters: ${letters - plain}`);
  assert.ok(
    Math.abs(words - plain - 20) < 1,
    `the one space: ${words - plain}`,
  );
});

test('inherit reaches the box model', async () => {
  const { node } = await render(
    '<div style="margin:0 7px;padding:3px"><p id="p" style="margin:inherit;' +
      'padding:inherit">x</p></div>',
  );
  const p = boxOf(view(node), 'p') as LaidBox & {
    marginLeft: number;
    padLeft: number;
  };
  assert.strictEqual(p.marginLeft, 7);
  assert.strictEqual(p.padLeft, 3);
});

test('initial is where a property starts, inherited or not', async () => {
  // `line-height: initial` in a box inside 200px lines was 200px still,
  // which it inherits, and `margin: initial` after a margin was that
  // margin: the keyword is the property's initial value, whatever came
  // before it (CSS Cascade 4, 7.3.1)
  const { node } = await render(
    '<style>#a { margin: 9px } #a { margin: initial }</style>' +
      '<div style="line-height:200px"><p id="p" style="line-height:initial">' +
      'x</p></div><p id="a">x</p>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { lineHeight: unknown; marginTop: number };
      }
    ).style;
  assert.strictEqual(style('p').lineHeight, 'normal');
  assert.strictEqual(style('a').marginTop, 0);
});

test('a border shorthand that names a part twice is no border', async () => {
  // `<line-width> || <line-style> || <color>`, each at most once: `red
  // solid 16px red` is invalid, and the border before it stands, where the
  // second colour was taken for the first
  const { node } = await render(
    '<div id="a" style="border:1px solid #00ff00;' +
      'border:#ff0000 solid 16px #ff0000"></div>',
  );
  const a = boxOf(view(node), 'a') as unknown as {
    style: { borderTopWidth: number; borderTopColor: string };
  };
  assert.strictEqual(a.style.borderTopWidth, 1);
  assert.strictEqual(a.style.borderTopColor, '#00ff00');
});

test('an iframe is a box of its size with nothing in it', async () => {
  const { node } = await render(
    '<iframe id="a" style="border:0"></iframe>' +
      '<iframe id="b" width="120" height="40" style="border:0">fallback</iframe>' +
      '<div style="position:relative;height:200px"><div id="c" ' +
      'style="position:absolute;height:50%;width:10px"></div></div>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  assert.deepStrictEqual([a.width, a.height], [300, 150], "HTML's default");
  const b = boxOf(el, 'b');
  assert.deepStrictEqual([b.width, b.height], [120, 40], 'its attributes');
  assert.ok(
    !el.textContent().includes('fallback'),
    'what an iframe holds is not the document',
  );
  const c = boxOf(el, 'c');
  assert.strictEqual(c.height, 100, 'half its containing block');
});

test('a canvas is the size of its bitmap, and keeps its proportions', async () => {
  // HTML 4.12.5: `width` and `height` give a canvas its bitmap, 300 by 150
  // where they do not, and no script draws in it here. Taken for an
  // element with no box of its own it took no room, and the attributes
  // were no size hints either, so a canvas set a height kept no width.
  const { node } = await render(
    '<div><canvas id="a"></canvas></div>' +
      '<div><canvas id="b" width="10" height="20" style="height:60px">' +
      'fallback</canvas></div>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  assert.deepStrictEqual([a.width, a.height], [300, 150], 'the default bitmap');
  const b = boxOf(el, 'b');
  assert.deepStrictEqual([b.width, b.height], [30, 60], 'its proportions');
  assert.ok(!el.textContent().includes('fallback'), 'a canvas is drawn');
});

metric(
  'an anonymous block after a block in an inline takes no text-indent',
  async () => {
    // its first line is no element's first formatted line (CSS 2.1 16.1):
    // the text after the <div> started indented as the text before it did
    const { node } = await render(
      '<style>body{margin:0}</style><section id="s" style="text-indent:50px">' +
        '<span>one <div>two</div> three</span></section>',
    );
    const el = view(node);
    const s = boxOf(el, 's');
    assert.deepStrictEqual(
      linesOf(el, 's').map((l) => Math.round(extentOf(l.texts[0])[0] - s.x)),
      [50, 50, 0],
    );
  },
);

test('a no-break space before an image is added back only where the engine strips it', () => {
  // ntk to 8.12.9 and CoreText through appkit 0.15.0 strip a trailing
  // U+00A0, which CSS measures; the line adds back what the engine took, so
  // after an engine that keeps it, it would count twice.
  const engine = (stripsNoBreak: boolean): FontsLike =>
    ({
      layout: (runs: { text: string }[]) => {
        const text = runs.map((r) => r.text).join('');
        const kept = text.replace(
          stripsNoBreak ? /[ \t\u00A0]+$/ : /[ \t]+$/,
          '',
        );
        return { lines: [{ width: kept.length * 10 }] };
      },
    }) as unknown as FontsLike;
  const run = { text: 'a\u00A0', family: 'sans-serif', size: 16 };
  assert.ok(
    hungSpaces(engine(true), run).test('a\u00A0'),
    'stripped: added back',
  );
  assert.ok(
    !hungSpaces(engine(false), run).test('a\u00A0'),
    'kept: left alone',
  );
  assert.ok(hungSpaces(engine(false), run).test('a '), 'a space always is');
});

metric(
  'an anonymous block takes only what inherits from its parent',
  async () => {
    // `text` beside a block is wrapped in an anonymous block, which took the
    // div's own style: its height, padding and border a second time, so the
    // paragraph after it sat the height of the div further down.
    const { node } = await render(
      '<div id="d" style="margin:0;height:100px;padding:10px;border:2px solid;' +
        'background:#ff0000">text<p id="p" style="margin:0">para</p></div>',
    );
    const el = view(node);
    const d = boxOf(el, 'd') as LaidBox & { padTop: number };
    const [anonymous, p] = d.children as (LaidBox & { padTop: number })[];
    assert.strictEqual(anonymous.el, null, 'the text is in an anonymous block');
    assert.strictEqual(anonymous.padTop, 0, 'with no padding of its own');
    assert.strictEqual(
      anonymous.y,
      d.y + 12,
      "inside the div's border and padding",
    );
    assert.strictEqual(
      p.y,
      anonymous.y + anonymous.height,
      'and the paragraph after it',
    );
    const fills = await fillsOf(el);
    assert.strictEqual(
      fills.filter((f) => f.style === '#ff0000').length,
      1,
      'the background is painted once',
    );
  },
);

test('a percentage height resolves in a box whose height is set', async () => {
  const { node } = await render(
    '<div style="height:200px;padding:5px"><div id="half" style="height:50%">' +
      '</div>x <span><span id="quarter" style="display:inline-block;' +
      'width:10px;height:25%"></span></span></div>' +
      '<div><div id="auto" style="height:50%"></div></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'half').height, 100, 'half of the content box');
  assert.strictEqual(
    boxOf(el, 'quarter').height,
    50,
    'through the anonymous block and the span around it',
  );
  assert.strictEqual(
    boxOf(el, 'auto').height,
    0,
    'and auto under one that grew',
  );
});

test("an empty block's margins collapse through it", async () => {
  // CSS 2.1 8.3.1: nothing parts an empty block's top and bottom margins,
  // so they and the margins on either side of it are one — the largest
  const { node } = await render(
    '<div><p id="a" style="margin:0 0 20px;height:10px"></p>' +
      '<div style="margin:30px 0"></div>' +
      '<p id="b" style="margin:10px 0 0;height:10px"></p></div>' +
      // a min-height that sets the height keeps the margin inside the box
      '<div id="p" style="min-height:200px"><div style="height:30px;' +
      'margin-bottom:100px"></div><div id="m"></div></div>' +
      '<div id="f" style="height:10px"></div>',
  );
  const el = view(node);
  const [a, b, p, m, f] = ['a', 'b', 'p', 'm', 'f'].map((id) => boxOf(el, id));
  assert.strictEqual(b.y - (a.y + a.height), 30);
  assert.strictEqual(m.y, p.y + 130, 'the margin goes before the empty block');
  assert.strictEqual(f.y, p.y + 200, 'and stays inside its parent');
});

test("a margin collapses through an empty block into its parent's", async () => {
  // An empty block's two margins adjoin each other, so the margin after it
  // adjoins its parent's top margin through it (CSS 2.1 8.3.1): a `<div>`
  // holding only an absolute image left the rest of a document a body's
  // margin lower than a browser does. An empty `<span>` makes no line
  // (9.4.2), so a block holding one is as empty.
  const { node } = await render(
    '<body><div id="e"><img style="position:absolute;width:10px;height:10px">' +
      '</div>' +
      '<p id="p" style="margin:24px 0 0;height:10px"></p>' +
      '<div id="top" style="height:10px"></div>' +
      '<div id="g"><div><div style="margin-bottom:30px"></div></div>' +
      '<p id="h" style="margin:24px 0 0;height:10px"></p></div>' +
      '<div id="s" style="margin-top:10px"><div><span></span></div>' +
      '<p id="t" style="margin:24px 0 0;height:10px"></p></div></body>',
  );
  const el = view(node);
  const [e, p, top, g, h, s, t] = ['e', 'p', 'top', 'g', 'h', 's', 't'].map(
    (id) => boxOf(el, id),
  );
  assert.strictEqual(p.y, 24, "the body's 8px and the 24px are one margin");
  assert.strictEqual(e.y, 24, "the empty block stands at its parent's top");
  assert.strictEqual(g.y, top.y + 10 + 30, 'the largest of them, nested');
  assert.strictEqual(h.y, g.y);
  assert.strictEqual(s.y, g.y + 10 + 24, 'through a phantom line');
  assert.strictEqual(t.y, s.y);
});

test('a new formatting context separates from floats it cannot sit beside', async () => {
  // A float in an empty block is placed where the margin collapsing through
  // the block ends, so it moves with the margin, and a box with a formatting
  // context of its own after it must not overlap it (CSS 2.1 9.5). Where the
  // box fits beside the float, the margins collapse and both move; where it
  // does not, it separates from the float as clearance would, and sits under
  // the float rather than pushing it down.
  const { node } = await render(
    '<div id="o" style="overflow:hidden;width:200px"><div><div>' +
      '<div id="f1" style="float:left;width:200px;height:50px"></div></div>' +
      '<div id="c1" style="overflow:hidden;width:200px;height:10px;' +
      'margin-top:80px"></div></div></div>' +
      '<div id="w" style="overflow:hidden;width:300px"><div><div>' +
      '<div id="f2" style="float:left;width:200px;height:50px"></div></div>' +
      '<div id="c2" style="overflow:hidden;width:100px;height:10px;' +
      'margin-top:80px"></div></div></div>',
  );
  const el = view(node);
  const [o, f1, c1, w, f2, c2] = ['o', 'f1', 'c1', 'w', 'f2', 'c2'].map((id) =>
    boxOf(el, id),
  );
  assert.strictEqual(f1.y, o.y, 'the float stays at the top');
  assert.strictEqual(c1.y, f1.y + 50, 'and the box goes under it');
  assert.strictEqual(f2.y, w.y + 80, 'the float moves with the margin');
  assert.strictEqual(c2.y, f2.y, 'and the box sits beside it');
  assert.strictEqual(c2.x, f2.x + 200);
});

test('html and body at 100% are a window tall, and hold what is longer', async () => {
  // A percentage height on the root element resolves against the initial
  // containing block, the viewport (CSS 2.1 10.1): the usual reset is a
  // window tall, as in a browser. The document is as tall as what
  // overflows it, so a message longer than the window is not cut off.
  const { node } = await render(
    '<html style="height:100%"><body style="height:100%;margin:0">' +
      '<div id="tall" style="height:900px"></div></body></html>',
  );
  const el = view(node) as unknown as {
    _tree: { root: LaidBox };
    _documentHeight: number;
  };
  const html = el._tree.root.children.find(
    (b) => (b as LaidBox & { el?: { name: string } }).el?.name === 'html',
  )!;
  assert.ok(
    html.height < 900,
    `the root element is a window tall: ${html.height}`,
  );
  assert.strictEqual(boxOf(view(node), 'tall').height, 900);
  assert.ok(el._documentHeight >= 900, 'and the document holds all 900px');
});

/**
 * A document in a box `height` tall that scrolls it — the viewport a `vh`,
 * the root's percentage height and the initial containing block are
 * measured against — with a `resize` that sets the box's size again.
 */
async function renderScrolled(source: string, height: number, width = 400) {
  const doc = (height: number, width: number) =>
    h(
      'box',
      { style: { width, height, flexDirection: 'column' } },
      h(
        'box',
        { style: { flexGrow: 1, overflow: 'scroll' } },
        h(Html, { source, partial: false, 'data-testname': 'doc' }),
      ),
    );
  const result = await renderX11(
    doc(height, width),
    FONTS
      ? { width: 640, height: 800, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  // How tall the scroll box came out is a layout pass's to decide, and the
  // element reads it after that pass, so a frame of its own is where a
  // change of viewport is seen — and the one after, where core asks again.
  await act();
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const resize = async (height: number, w = width): Promise<void> => {
    await act(() => result.rerender(doc(height, w)));
    await act();
  };
  return { el, resize };
}

test('a 100vh page follows the height of the box that scrolls it', async () => {
  // A page's own "fill the window" — a column at least 100vh tall with its
  // footer pushed to the bottom — in a browser's page area. The viewport is
  // the box that scrolls the document, whose height only core's layout
  // decides, so the element read the old one while it was being measured
  // and the page kept the height the window had when it loaded.
  const { el, resize } = await renderScrolled(
    '<body style="margin:0"><div style="min-height:100vh;display:flex;' +
      'flex-direction:column"><div style="flex:1"></div>' +
      '<div id="foot" style="height:20px"></div></div></body>',
    300,
  );
  const bottomOf = (id: string): number => {
    const box = boxOf(el, id);
    return box.y + box.height;
  };
  assert.strictEqual(el.abs.height, 300);
  assert.strictEqual(bottomOf('foot'), 300);
  await resize(500);
  assert.strictEqual(el.abs.height, 500, 'the page grows with the viewport');
  assert.strictEqual(bottomOf('foot'), 500, 'with its footer at the bottom');
  await resize(200);
  assert.strictEqual(el.abs.height, 200, 'and shrinks with it');
  assert.strictEqual(bottomOf('foot'), 200);
});

test("html and body at 100% follow the viewport's height", async () => {
  const { el, resize } = await renderScrolled(
    '<html style="height:100%"><body style="height:100%;margin:0">' +
      '<div id="fill" style="height:100%"></div></body></html>',
    300,
  );
  assert.strictEqual(boxOf(el, 'fill').height, 300);
  await resize(450);
  assert.strictEqual(boxOf(el, 'fill').height, 450);
  assert.strictEqual(el.abs.height, 450);
});

test('a box placed against the initial containing block follows the viewport', async () => {
  // nothing positioned around it: `bottom: 0` is the viewport's bottom
  const { el, resize } = await renderScrolled(
    '<body style="margin:0"><div id="pin" style="position:absolute;' +
      'bottom:0;width:10px;height:10px"></div></body>',
    300,
  );
  assert.strictEqual(boxOf(el, 'pin').y, 290);
  await resize(400);
  assert.strictEqual(boxOf(el, 'pin').y, 390);
});

test('a document that reads no viewport height is not laid out for one', async () => {
  // The layout says whether it read the height (a `vh`, the root's
  // percentage, the initial containing block's bottom), and a document that
  // read none of them — most — is left alone when the window only grows
  // taller: a page a hundred screens long is not laid out again per frame
  // of a vertical resize for nothing.
  const { el, resize } = await renderScrolled(
    '<body style="margin:0"><div id="a" style="height:40px"></div></body>',
    300,
  );
  const under = () =>
    (el as unknown as { _laidOutUnder: number })._laidOutUnder;
  const before = under();
  await resize(500);
  assert.strictEqual(under(), before, 'not laid out again');
  assert.strictEqual(boxOf(el, 'a').height, 40);
  assert.strictEqual(el.abs.height, 40);
});

test('a vw length follows the width of the viewport', async () => {
  // A `vw` is a number by the time the computed style holds it, so a resize
  // that crossed no `@media` breakpoint — the one kind that restyled —
  // left it at the width the page loaded at.
  const { el, resize } = await renderScrolled(
    '<body style="margin:0"><div id="half" style="width:50vw;' +
      'height:10px"></div></body>',
    300,
    400,
  );
  assert.strictEqual(boxOf(el, 'half').width, 200);
  await resize(300, 600);
  assert.strictEqual(boxOf(el, 'half').width, 300);
});

test('a document a hair past a whole pixel measures that pixel', async () => {
  // A sum of Yoga's single-precision positions carries noise — a page
  // exactly 100vh tall came to 737.0000076 under a 737 pixel viewport — and
  // rounding that up scrolled the page by a pixel under a scrollbar.
  const { node } = await render(
    '<body style="margin:0"><div style="height:100.004px"></div></body>',
  );
  const el = view(node);
  const measure = () =>
    el.measureContent({
      width: 400,
      height: Infinity,
      widthMode: 'at-most',
      heightMode: 'unconstrained',
    }).height;
  assert.strictEqual(measure(), 100);
  const { node: over } = await render(
    '<body style="margin:0"><div style="height:100.3px"></div></body>',
  );
  assert.strictEqual(
    view(over).measureContent({
      width: 400,
      height: Infinity,
      widthMode: 'at-most',
      heightMode: 'unconstrained',
    }).height,
    101,
    'a fraction that is ink is a pixel of it',
  );
});

test('a flex item as wide as its content keeps it on one line', async () => {
  // An item exactly as wide as its content — `width: fit-content` in a
  // column, an item its content sizes in a row, a flex box sized to what it
  // holds — has that width held by Yoga as a float32, and a width rounded
  // down under the content laid it out a hair too narrow: meetup.com's
  // "About us" and "Related topics" headings wrapped their last word. Two
  // boxes whose widths sum to 116.728px, which a float32 holds as
  // 116.72799682…, stand in for a line of text.
  const line = (n: number) =>
    `<div style="line-height:10px">` +
    `<span id="a${n}" style="display:inline-block;width:106.728px;height:10px"></span>` +
    `<span id="b${n}" style="display:inline-block;width:10px;height:10px"></span>` +
    `</div>`;
  const shapes = [
    (n: number) =>
      `<div style="display:flex;flex-direction:column">` +
      `<div id="fit${n}" style="width:fit-content">${line(n)}</div></div>`,
    (n: number) =>
      `<div style="display:flex;align-items:baseline;justify-content:space-between">` +
      `<div style="display:flex;gap:8px">${line(n)}</div></div>`,
    (n: number) =>
      `<div style="display:flex">` +
      `<div style="display:flex;flex-direction:column">${line(n)}</div></div>`,
    (n: number) =>
      `<div style="display:flex;flex-direction:column;width:fit-content">` +
      `<div style="display:flex">${line(n)}</div></div>`,
  ];
  const { node } = await render(shapes.map((shape, n) => shape(n)).join(''));
  const el = view(node);
  assert.strictEqual(boxOf(el, 'fit0').width, 116.728);
  shapes.forEach((_, n) =>
    assert.strictEqual(
      boxOf(el, `b${n}`).y,
      boxOf(el, `a${n}`).y,
      `shape ${n}: the second box beside the first, not under it`,
    ),
  );
});

metric(
  'a character the engine cannot shape costs itself, not the document',
  async () => {
    // A bitmap-only colour emoji font (CBDT) is what fontconfig answers first
    // for an emoji on most Linux desktops, and fontkit has no glyph to make
    // from it: its shaper threw on meetup.com's pin, and the page was left
    // blank. The character is drawn as U+FFFD instead, at the same length in
    // UTF-16, so every offset past it still lands.
    const pin = '\u{1F4CD}';
    const { result } = await render('<p id="p">x</p>');
    const engine = (result.app as unknown as { fonts: FontsLike }).fonts;
    const inner = engine.layout;
    const shaped: string[] = [];
    engine.layout = function (content, style, options) {
      const text = content.map((r) => r.text).join('');
      if (text.includes(pin)) {
        throw new TypeError("Cannot read properties of null (reading 'id')");
      }
      shaped.push(text);
      return inner.call(this, content, style, options);
    };
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (message: string) => void warned.push(String(message));
    try {
      await act(() =>
        result.rerender(
          h(
            'box',
            { style: { width: 400, flexDirection: 'column' } },
            h(Html, {
              source: `<p id="p">${pin} Melbourne, AU</p><p id="q">after</p>`,
              partial: false,
              'data-testname': 'doc',
            }),
          ),
        ),
      );
      await act();
    } finally {
      engine.layout = inner;
      console.warn = warn;
    }
    const el = view(screen.getByTestName('doc') as DrawnNode);
    assert.ok(el['_tree' as keyof typeof el], 'laid out, not left blank');
    assert.ok(boxOf(el, 'q').height > 0, 'and what follows is there');
    // the document is the page's; only what is drawn stands in
    assert.ok(el.textContent().startsWith(`${pin} Melbourne`));
    assert.ok(
      shaped.includes('\uFFFD\uFE0F Melbourne, AU'),
      `the stand-in is shaped: ${JSON.stringify(shaped)}`,
    );
    assert.strictEqual(warned.length, 1, 'said once');
    assert.match(warned[0], /U\+1F4CD/);
  },
);

metric("a table column is the table's, not a row of its own", async () => {
  // A <colgroup> was taken for a stray child, wrapped in a row and a cell of
  // its own, and drawn as one — a table of one row had two.
  const { node } = await render(
    '<table id="t" style="border-spacing:0"><colgroup style="border-top:3px ' +
      'solid #00ff00"><col><col></colgroup><tr><td>a</td><td>b</td></tr></table>',
  );
  const el = view(node);
  type T = LaidBox & { kind: string };
  const rows: T[] = [];
  const walk = (b: T): void => {
    if (b.kind === 'table-row') rows.push(b);
    (b.children as T[]).forEach(walk);
  };
  walk(boxOf(el, 't') as T);
  assert.strictEqual(rows.length, 1, 'one row');
  const fills = await fillsOf(el);
  assert.ok(!fills.some((f) => f.style === '#00ff00'), 'and no column drawn');
});

metric(
  'table cells outside a table get one around them, a row a run',
  async () => {
    // CSS 2.1 17.2.1: a run of cells is one anonymous row in one anonymous
    // table — a block one in a block, an inline one in a line — where they
    // used to be blocks one above the other, or inline-blocks a space apart.
    const cell = (id: string, text: string) =>
      `<span id="${id}" style="display:table-cell">${text}</span>`;
    const { node } = await render(
      `<div id="block">${cell('b1', 'b')} ${cell('b2', 'c')}</div>` +
        `<p id="line" style="margin:0"><span>a ${cell('i1', 'b')} ` +
        `${cell('i2', 'c')} d</span></p>`,
    );
    const el = view(node);
    const [b1, b2, i1, i2] = ['b1', 'b2', 'i1', 'i2'].map((id) =>
      boxOf(el, id),
    );
    assert.strictEqual(b1.y, b2.y, 'side by side in one row');
    assert.strictEqual(b2.x, b1.x + b1.width, 'with nothing between them');
    const paragraph = boxOf(el, 'line') as LaidBox & { lines: unknown[] };
    assert.strictEqual(
      paragraph.lines.length,
      1,
      'the inline table is on the line',
    );
    assert.strictEqual(i2.x, i1.x + i1.width, 'its cells as close');
    assert.strictEqual(i1.y, i2.y);
  },
);

metric(
  'collapsed borders are one border an edge, the widest winning',
  async () => {
    // CSS 2.1 17.6.2: cells share the border between them, drawn once and
    // centred on the edge they meet at, where each used to draw its own and
    // the rule between two cells was two borders wide
    const { node } = await render(
      '<table style="border-collapse:collapse;border:1px solid #0000ff">' +
        '<tr><td id="a" style="border:4px solid #ff0000">a</td>' +
        '<td id="b" style="border:2px solid #00ff00">b</td></tr></table>',
    );
    const el = view(node);
    const [a, b] = ['a', 'b'].map((id) => boxOf(el, id));
    const edges = (box: LaidBox) =>
      box as unknown as { borderLeft: number; borderRight: number };
    assert.strictEqual(b.x, a.x + a.width, 'the cells meet');
    assert.deepStrictEqual(
      [edges(a).borderRight, edges(b).borderLeft, edges(b).borderRight],
      [2, 2, 1],
      'each holds half of the border along its edge',
    );
    const fills = await fillsOf(el);
    const of = (color: string) =>
      fills.filter((f) => f.style === parseColor(color));
    assert.deepStrictEqual(of('#0000ff'), [], "the table's border lost");
    const red = of('#ff0000').filter((f) => f.w === 4);
    assert.strictEqual(red.length, 2, "a's left edge, and the one between");
    assert.ok(
      red.some((f) => f.x === Math.round(b.x) - 2),
      'centred on the edge the cells share',
    );
    assert.strictEqual(of('#00ff00').filter((f) => f.w === 2).length, 1);
  },
);

metric(
  'a hidden border hides an edge, and a style outranks another',
  async () => {
    const { node } = await render(
      '<table style="border-collapse:collapse"><tr>' +
        '<td id="a" style="border:3px solid #ff0000;border-right-style:hidden">' +
        'a</td><td id="b" style="border:5px double #00ff00">b</td>' +
        '<td id="c" style="border:2px dotted #0000ff">c</td>' +
        '<td id="d" style="border:2px dashed #ff00ff">d</td></tr></table>',
    );
    const el = view(node);
    const left = (id: string) =>
      (boxOf(el, id) as unknown as { borderLeft: number }).borderLeft;
    assert.strictEqual(left('b'), 0, '`hidden` beats a wider double border');
    const fills = await fillsOf(el);
    const d = boxOf(el, 'd');
    // between c and d the widths are equal, and dashed outranks dotted
    assert.ok(
      fills.some(
        (f) => f.style === parseColor('#ff00ff') && f.x === Math.round(d.x) - 1,
      ),
    );
  },
);

metric("a corner equal borders meet at is the top-left cell's", async () => {
  // CSS 2.1 17.6.2.1: between two borders that win alike, the one further
  // up and further left; painted in the order they were found, the border
  // below the corner in the middle of four cells took it
  const { node } = await render(
    '<table style="border-collapse:collapse"><tr>' +
      '<td id="a" style="border:10px solid #0000ff">a</td>' +
      '<td style="border:10px solid #ff0000">b</td></tr><tr>' +
      '<td style="border:10px solid #ff0000">c</td>' +
      '<td style="border:10px solid #ff0000">d</td></tr></table>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  // the middle of the corner: a's bottom right, half a border in
  const x = Math.round(a.x + a.width);
  const y = Math.round(a.y + a.height);
  const over = (await fillsOf(el)).filter(
    (f) => f.x <= x && x < f.x + f.w && f.y <= y && y < f.y + f.h,
  );
  assert.ok(over.length > 1, 'more than one border meets there');
  assert.strictEqual(over[over.length - 1].style, parseColor('#0000ff'));
});

test("a collapsed table's sides are half its widest outer borders", async () => {
  // CSS Tables 3: along each side, the widest of its rows' borders, where
  // CSS 2.1 took the first row's and let a wider one below spill out of
  // the table, from under its background
  const { node } = await render(
    '<table id="t" style="border-collapse:collapse">' +
      '<tr><td style="padding:0;border-left:150px solid"></td></tr>' +
      '<tr><td style="padding:0;border-right:100px solid"></td></tr></table>',
  );
  assert.strictEqual(boxOf(view(node), 't').width, 75 + 75 + 50);
});

test('empty-cells: hide draws nothing of an empty cell', async () => {
  // CSS 2.1 17.6.1.1: no background of its own or its row's and no
  // borders, where borders are separate; white space collapsed away is
  // nothing, an empty element is something, and collapsed borders are
  // the grid's, which it does not touch
  const { node } = await render(
    '<table style="empty-cells:hide"><tr style="background:#0000ff">' +
      '<td style="background:#ff0000;border:2px solid #ff0000"> </td>' +
      '<td style="background:#00ff00"><span></span></td></tr></table>' +
      '<table style="empty-cells:hide;border-collapse:collapse"><tr>' +
      '<td style="border:2px solid #ff00ff"></td></tr></table>',
  );
  const fills = await fillsOf(view(node));
  const any = (color: string) =>
    fills.some((f) => f.style === parseColor(color));
  assert.ok(!any('#ff0000'), "the empty cell's background and borders");
  assert.ok(any('#00ff00'), 'a cell with an empty element in it is drawn');
  assert.strictEqual(
    fills.filter((f) => f.style === parseColor('#0000ff')).length,
    1,
    "the row's background under the second cell only",
  );
  assert.ok(any('#ff00ff'), 'collapsed borders are drawn');
});

test('a collapsed border on a line between two pixels starts on one', async () => {
  // a grid line at 12.5 carries a 25px border from 0 to 25; rounding the
  // line first and taking a whole half off drew it from 1, and the cell
  // under it showed a pixel wide at the table's edge
  const { node } = await render(
    '<table id="t" style="border-collapse:collapse;table-layout:fixed;' +
      'width:100px"><tr><td style="padding:10px 0"></td>' +
      '<td style="width:50%;padding:10px 0;border-left:25px solid #00ff00;' +
      'border-right:25px solid #00ff00"></td>' +
      '<td style="padding:10px 0"></td></tr></table>',
  );
  const el = view(node);
  const t = boxOf(el, 't');
  const green = (await fillsOf(el)).filter(
    (f) => f.style === parseColor('#00ff00'),
  );
  assert.deepStrictEqual(
    green.map((f) => [f.x - Math.round(t.x), f.w]).sort((a, b) => a[0] - b[0]),
    [
      [0, 25],
      [75, 25],
    ],
  );
});

test('a collapsed border between rows is drawn where the rows part', async () => {
  // a pixel's border is half in each row, and the two halves are what
  // layout leaves them; it was split a whole pixel to the row below, drawn
  // centred on the line all the same, and rounded apart from the table's
  // own place — a pixel over the row above, where a block's line was not
  const { node } = await render(
    '<div style="height:10.4px"></div>' +
      '<table id="t" style="border-collapse:collapse;width:50px"><tr>' +
      '<td style="padding:0;height:18.4px"></td></tr><tr>' +
      '<td style="padding:0;height:18.4px;border-top:1px solid #00ff00">' +
      '</td></tr></table>',
  );
  const el = view(node);
  const t = boxOf(el, 't');
  const green = (await fillsOf(el)).filter(
    (f) => f.style === parseColor('#00ff00'),
  );
  assert.deepStrictEqual(
    green.map((f) => [f.y, f.h]),
    [[Math.round(t.y + 18.4), 1]],
  );
});

test('an image told to be a table cell is inline', async () => {
  // CSS Display 3, 2.4: a table's part is no display a replaced element
  // takes, and it is inline — in a row, wrapped in a cell with what is
  // beside it, and in a block, on the line; they were stacked as blocks
  const { node } = await render(
    '<div style="display:table-row">' +
      '<img id="a" style="display:table-cell;width:15px;height:15px"> ' +
      '<img id="b" style="display:table-cell;width:15px;height:15px"></div>' +
      '<div><img id="c" style="display:table-cell;width:15px;height:15px">' +
      ' <img id="d" style="display:table-row;width:15px;height:15px"></div>',
  );
  const el = view(node);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => boxOf(el, id));
  assert.strictEqual(b.y, a.y, 'side by side in the row');
  assert.ok(b.x > a.x + a.width, 'a space between them');
  assert.strictEqual(d.y, c.y, 'and on one line in a block');
});

metric('a column group draws its borders where they collapse', async () => {
  const { node } = await render(
    '<table style="border-collapse:collapse"><colgroup ' +
      'style="border-top:3px solid #ff0000"><col><col></colgroup>' +
      '<tr><td>a</td><td>b</td></tr></table>',
  );
  const fills = await fillsOf(view(node));
  assert.strictEqual(
    fills.filter((f) => f.style === parseColor('#ff0000') && f.h === 3).length,
    2,
    'along both of its columns',
  );
});

metric(
  "a cell's box fills its row, and its content is aligned in it",
  async () => {
    // `vertical-align: middle` moved the whole cell down, so the row showed
    // the table's background above every cell shorter than the row
    const { node } = await render(
      '<table style="border-spacing:0"><tr><td id="s">a</td>' +
        '<td id="t" style="height:100px">b</td></tr></table>',
    );
    const el = view(node);
    const [s, t] = [boxOf(el, 's'), boxOf(el, 't')];
    assert.deepStrictEqual([s.y, s.height], [t.y, t.height]);
    const [line] = linesOf(el, 's');
    assert.ok(line.y > s.y + 30, 'the text is in the middle of the box');
  },
);

metric(
  'a cell with a height of its own centres its content in it',
  async () => {
    // `vertical-align: middle` moves the content in the box a height makes
    // as well: that height is no content, and taken for it, a cell set to
    // 100px kept its text at the top
    const { node } = await render(
      '<table style="border-spacing:0"><tr>' +
        '<td id="t" style="height:100px;padding:0">b</td></tr></table>',
    );
    const el = view(node);
    const t = boxOf(el, 't');
    const [line] = linesOf(el, 't');
    assert.ok(line.y > t.y + 30, `in the middle of the box: ${line.y - t.y}`);
  },
);

metric("a caption is outside the table's border, above or below", async () => {
  const { node } = await render(
    '<table id="t" style="border:5px solid #0000ff"><caption id="c">' +
      'Title</caption><tr><td>x</td></tr></table>' +
      '<table id="u" style="border:5px solid #00ff00"><caption id="d" ' +
      'style="caption-side:bottom">Note</caption><tr><td>y</td></tr></table>',
  );
  const el = view(node);
  const [t, c, u, d] = ['t', 'c', 'u', 'd'].map((id) => boxOf(el, id));
  const fills = await fillsOf(el);
  const blue = fills.filter((f) => f.style === parseColor('#0000ff'));
  const green = fills.filter((f) => f.style === parseColor('#00ff00'));
  const top = Math.min(...blue.map((f) => f.y));
  assert.ok(
    top >= Math.round(c.y + c.height),
    'the border is below the caption',
  );
  // (a border box is painted from a rounded top at a rounded-up height)
  const bottom = Math.max(...green.map((f) => f.y + f.h));
  assert.ok(bottom <= Math.round(d.y) + 1, 'and above a caption at the bottom');
  // an auto table is at least as wide as its caption's longest word
  assert.strictEqual(c.width, t.width);
  assert.ok(d.y + d.height <= u.y + u.height, 'the box holds its caption');
});

test('a background-position keyword says which axis it is on', async () => {
  const { node } = await render(
    '<div id="a" style="background-position:bottom"></div>' +
      '<div id="b" style="background-position:top right"></div>' +
      '<div id="c" style="background:url(x.png) repeat-x left 10px"></div>',
  );
  const el = view(node);
  const at = (id: string) => {
    const s = (
      boxOf(el, id) as unknown as {
        style: { backgroundPositionX: unknown; backgroundPositionY: unknown };
      }
    ).style;
    return [s.backgroundPositionX, s.backgroundPositionY];
  };
  assert.deepStrictEqual(at('a'), [{ pct: 50 }, { pct: 100 }], 'alone');
  assert.deepStrictEqual(at('b'), [{ pct: 100 }, 0], 'either order');
  assert.deepStrictEqual(at('c'), [0, 10], 'in the shorthand');
});

metric("a table's width includes its borders", async () => {
  // HTML's rendering rules give tables `box-sizing: border-box`, so mail's
  // `<table width="600" border="1">` is 600 pixels wide, borders and all
  const { node } = await render(
    '<table id="t" style="width:200px;border:10px solid;border-spacing:0">' +
      '<tr><td>x</td></tr></table>',
  );
  const t = boxOf(view(node), 't');
  assert.strictEqual(t.width, 200);
});

metric(
  'a fixed table takes its columns from its <col>s and its first row',
  async () => {
    // CSS 2.1 17.5.2.1: a column's width sets it; else a first-row cell's
    // border box does; the rest share what is left
    const { node } = await render(
      '<table style="table-layout:fixed;width:400px;border-spacing:0">' +
        '<col style="width:100px"><col><col>' +
        '<tr><td id="a">a</td><td id="b" style="width:80px;padding:0 10px">' +
        'b</td><td id="c">c</td></tr>' +
        '<tr><td>a</td><td style="width:300px">wide, but not the first row' +
        '</td><td>c</td></tr></table>',
    );
    const el = view(node);
    const [a, b, c] = ['a', 'b', 'c'].map((id) => boxOf(el, id));
    assert.strictEqual(a.width, 100, 'the column sets the first');
    assert.strictEqual(b.width, 100, "the cell's border box the second");
    assert.strictEqual(c.width, 200, 'and the third takes the rest');
  },
);

metric(
  "a fixed table of `width: auto` is laid out by its content, and a table's min-width widens its columns",
  async () => {
    const { node } = await render(
      '<table id="t" style="table-layout:fixed;border-spacing:0">' +
        '<tr><td id="a" style="padding:0">word</td></tr></table>' +
        '<table style="min-width:300px;border-spacing:0">' +
        '<tr><td id="b" style="padding:0"></td></tr></table>',
    );
    const el = view(node);
    const [t, a, b] = ['t', 'a', 'b'].map((id) => boxOf(el, id));
    assert.ok(t.width < 100, `as wide as its word: ${t.width}`);
    assert.strictEqual(a.width, t.width);
    assert.strictEqual(b.width, 300, 'an empty cell as wide as the table');
  },
);

metric(
  'border-spacing takes a length for the columns and one for the rows',
  async () => {
    const { node } = await render(
      '<table id="t" style="border-spacing:2px 10px;border:none">' +
        '<tr><td id="a" style="padding:0">a</td><td id="b" style="padding:0">' +
        'b</td></tr><tr><td id="c" style="padding:0">c</td></tr></table>',
    );
    const el = view(node);
    const [t, a, b, c] = ['t', 'a', 'b', 'c'].map((id) => boxOf(el, id));
    assert.strictEqual(a.x - t.x, 2, 'the columns 2 apart');
    assert.strictEqual(b.x - (a.x + a.width), 2);
    assert.strictEqual(a.y - t.y, 10, 'the rows 10');
    assert.strictEqual(c.y - (a.y + a.height), 10);
  },
);

metric("a column's background is painted under its cells", async () => {
  // CSS 2.1 17.5.1: a column box is laid out nowhere, and its background
  // covers the cells that start in it, over the table's and under theirs
  const { node } = await render(
    '<table style="border-spacing:0;background:#0000ff">' +
      '<col><col style="background:#ff0000">' +
      '<tr><td>a</td><td id="b">b</td></tr>' +
      '<tr><td>a</td><td id="c" style="background:#00ff00">c</td></tr>' +
      '</table>',
  );
  const el = view(node);
  const fills = await fillsOf(el);
  const red = fills.filter((f) => f.style === parseColor('#ff0000'));
  const b = boxOf(el, 'b');
  const c = boxOf(el, 'c');
  assert.deepStrictEqual(
    red.map((f) => [f.x, f.y, f.w, f.h]),
    [
      [b.x, b.y, b.width, b.height],
      [c.x, c.y, c.width, c.height],
    ].map(([x, y, w, h]) => [
      Math.round(x),
      Math.round(y),
      Math.round(x + w) - Math.round(x),
      Math.round(y + h) - Math.round(y),
    ]),
    "one fill a cell, the cells' own",
  );
  const order = fills.map((f) => f.style);
  assert.ok(
    order.indexOf(parseColor('#0000ff')) <
      order.indexOf(parseColor('#ff0000')) &&
      order.indexOf(parseColor('#ff0000')) <
        order.indexOf(parseColor('#00ff00')),
    "over the table's, under a cell's own",
  );
});

metric('a row spans its columns, not the spacing round them', async () => {
  // CSS 2.1 17.5.1: in the separated borders model a row's edges are its
  // cells', and a group's are its rows' — the spacing is the table's
  const { node } = await render(
    '<table id="t" style="border-spacing:10px;border:none">' +
      '<tbody id="g"><tr id="r"><td id="a">a</td><td id="b">b</td></tr>' +
      '</tbody></table>',
  );
  const el = view(node);
  const [t, g, r, a, b] = ['t', 'g', 'r', 'a', 'b'].map((id) => boxOf(el, id));
  assert.strictEqual(r.x - t.x, 10, 'the spacing before it outside it');
  assert.strictEqual(r.x, a.x);
  assert.strictEqual(r.x + r.width, b.x + b.width, 'and the spacing after');
  assert.deepStrictEqual([g.x, g.width], [r.x, r.width], 'its group the same');
});

metric(
  'visibility: collapse takes a row out of its table, and its spacing',
  async () => {
    // CSS 2.1 17.5.5: the row has sized the columns with the rest, and takes
    // no room; its cells inherit the value, and are not drawn
    const { node } = await render(
      '<table id="t" style="border-spacing:2px 10px;border:none">' +
        '<tr><td id="a" style="padding:0">a</td></tr>' +
        '<tr style="visibility:collapse"><td id="b" ' +
        'style="padding:0;background:#ff0000">a much wider cell</td></tr>' +
        '<tr><td id="c" style="padding:0">c</td></tr></table>',
    );
    const el = view(node);
    const [t, a, b, c] = ['t', 'a', 'b', 'c'].map((id) => boxOf(el, id));
    assert.strictEqual(
      c.y - (a.y + a.height),
      10,
      'one spacing where two were',
    );
    assert.strictEqual(t.height, 10 + a.height + 10 + c.height + 10);
    assert.ok(
      a.width > 50,
      `the column as wide as the row taken out: ${a.width}`,
    );
    assert.strictEqual(a.width, b.width);
    const fills = await fillsOf(el);
    assert.ok(
      !fills.some((f) => f.style === parseColor('#ff0000')),
      'its cell not drawn',
    );
  },
);

metric(
  'visibility: collapse takes a column out, and changes no row',
  async () => {
    // Its cells are laid out at the width they had, so a row is as tall as
    // it was, and are not drawn; the columns after it close up
    const row = (id: string, collapse: string) =>
      `<table id="t${id}" style="border-spacing:0;width:100px">` +
      `<col><col${collapse}><col>` +
      `<tr id="r${id}"><td id="a${id}">a</td>` +
      `<td id="b${id}" style="background:#ff0000">one two three` +
      ` four</td><td id="c${id}">c</td></tr></table>`;
    const { node } = await render(
      row('1', '') + row('2', ' style="visibility:collapse"'),
    );
    const el = view(node);
    const box = (id: string) => boxOf(el, id);
    const lines = (id: string) =>
      (box(id) as LaidBox & { lines: unknown[] | null }).lines?.length ?? 0;
    assert.ok(lines('b1') > 1 && lines('b2') === lines('b1'), 'wrapped alike');
    assert.strictEqual(box('r2').height, box('r1').height, 'as tall as it was');
    assert.strictEqual(box('c2').x, box('a2').x + box('a2').width, 'closed up');
    assert.strictEqual(box('t2').width, box('t1').width - box('b1').width);
    const fills = await fillsOf(el);
    const red = fills.filter((f) => f.style === parseColor('#ff0000'));
    assert.strictEqual(red.length, 1, "the first table's cell only");
  },
);

metric(
  'a cell spanning a column taken out is clipped to the ones left',
  async () => {
    // CSS 2.1 17.5.5: laid out across all its columns, moved left by the one
    // taken out, which cuts out what was in it
    const { node } = await render(
      '<table style="border-spacing:0"><col style="width:50px">' +
        '<col style="visibility:collapse;width:30px"><col style="width:40px">' +
        '<tr><td id="a" style="padding:0">a</td>' +
        '<td id="s" colspan="2" style="padding:0">x</td></tr>' +
        '<tr><td style="padding:0"></td><td style="padding:0"></td>' +
        '<td id="c" style="padding:0">c</td></tr></table>',
    );
    const el = view(node);
    const [a, s, c] = ['a', 's', 'c'].map((id) => boxOf(el, id));
    assert.strictEqual(s.x, a.x + a.width, 'over the column left');
    assert.strictEqual(s.width, c.width);
    const lines = (s as LaidBox & { lines: { texts: { drawX: number }[] }[] })
      .lines;
    assert.strictEqual(lines[0].texts[0].drawX, s.x - 30, 'its text cut');
  },
);

metric("a table's height is shared among its rows", async () => {
  // CSS 2.1 17.5.3: the height is a least height, and what the rows come
  // short of it goes to them; `max-height` holds it back
  const { node } = await render(
    '<table style="height:200px;border-spacing:0"><tr><td id="a">x</td></tr>' +
      '<tr><td id="b">y</td></tr></table>' +
      '<table style="height:300px;max-height:100px;border-spacing:0">' +
      '<tr><td id="c">z</td></tr></table>',
  );
  const el = view(node);
  const [a, b, c] = ['a', 'b', 'c'].map((id) => boxOf(el, id));
  assert.ok(
    Math.abs(a.height + b.height - 200) < 0.01,
    `${a.height} ${b.height}`,
  );
  assert.ok(Math.abs(a.height - b.height) < 0.01, 'in proportion');
  assert.ok(Math.abs(c.height - 100) < 0.01, `clamped: ${c.height}`);
});

test('a table set shorter than its rows is as tall as they are', async () => {
  // CSS 2.1 17.5.3: a table's height is a least one. Taken as the table's
  // height it ended its background over its rows, and a float after it
  // went up beside them.
  const { node } = await render(
    '<div id="t" style="display:table;width:50px;height:10px">' +
      '<div style="height:100px"></div></div>',
  );
  assert.strictEqual(boxOf(view(node), 't').height, 100);
});

metric(
  'table cells in an inline box are an inline table, with the spaces either side of it',
  async () => {
    // CSS 2.1 17.2.1: the anonymous table around them is inline-level,
    // and sits in the line as an inline-block would, the white space
    // around it kept
    const { node } = await render(
      '<p id="p" style="margin:0"><span>a<span id="c" style="display:table-cell">' +
        'b</span> c</span></p>',
    );
    const el = view(node);
    assert.strictEqual(el.textContent(), 'ab c', 'the space after it kept');
    const [line] = linesOf(el, 'p');
    assert.strictEqual(line.atomics.length, 1, 'the table is on the line');
  },
);

metric(
  "an empty list item's marker stands where its first line would",
  async () => {
    const { node } = await render(
      '<ul style="margin:0"><li id="a"></li></ul>' +
        '<ul style="margin:0"><li id="b">&nbsp;</li></ul>',
    );
    const el = view(node);
    type Marked = LaidBox & { marker: { y: number } | null };
    const a = boxOf(el, 'a') as Marked;
    const b = boxOf(el, 'b') as Marked;
    assert.ok(a.marker && b.marker, 'both have markers');
    assert.ok(
      Math.abs(a.marker.y - a.y - (b.marker.y - b.y)) < 0.5,
      `the same distance below its item's top: ${a.marker.y - a.y} and ${b.marker.y - b.y}`,
    );
  },
);

metric(
  "a line starts with its block's strut: an image alone is a line-height tall",
  async () => {
    // CSS 2.1 10.8.1; and a list item with no line holds its marker's, and
    // an inline table of empty rows stands on its first
    const { node } = await render(
      '<div id="a" style="line-height:96px"><img width="15" height="15" ' +
        'style="vertical-align:bottom" src="x.png"></div>' +
        '<ul style="margin:0"><li id="b"></li></ul>' +
        '<div id="c"><table style="display:inline-table;border-spacing:0">' +
        '<tr><td style="height:20px;padding:0"></td></tr>' +
        '<tr><td style="height:20px;padding:0"></td></tr></table></div>' +
        '<div id="z" style="font-size:0"><img width="15" height="15" src="x.png"></div>',
    );
    const el = view(node);
    const [a, b, c, z] = ['a', 'b', 'c', 'z'].map((id) => boxOf(el, id));
    assert.strictEqual(a.height, 96, 'the image on a line of the height');
    assert.ok(b.height > 10, `an empty item a line tall: ${b.height}`);
    assert.ok(
      c.height - 40 < 1,
      `the table on its first row, its second hanging below: ${c.height}`,
    );
    assert.strictEqual(z.height, 15, 'no strut at no size');
  },
);

metric(
  'text beside a block in an anonymous table cell is laid out',
  async () => {
    // the cell the table fix-up makes is a block container like another, and
    // wraps the text in an anonymous block (CSS 2.1 9.2.1.1)
    const { node } = await render(
      '<p>a<span id="t" style="display:inline-table">bcd' +
        '<span style="display:block">x</span></span>e</p>' +
        '<p>a<span id="u" style="display:inline-table">bcd</span>e</p>',
    );
    const el = view(node);
    const [t, u] = [boxOf(el, 't'), boxOf(el, 'u')];
    assert.ok(
      Math.abs(t.width - u.width) < 0.5,
      `${t.width} wide, as ${u.width}`,
    );
    assert.ok(t.height > u.height, 'and a line taller, for the block');
    assert.ok(
      linesOf(el, 't').some((line) => line.texts.length > 0 && line.y === t.y),
      'its text on its first line',
    );
  },
);

metric("a footer group's rows come last wherever it stands", async () => {
  const { node } = await render(
    '<table><thead><tr><td id="h">h</td></tr></thead>' +
      '<tfoot><tr><td id="f">f</td></tr></tfoot>' +
      '<tbody><tr><td id="b">b</td></tr></tbody></table>',
  );
  const el = view(node);
  const [h, f, b] = ['h', 'f', 'b'].map((id) => boxOf(el, id).y);
  assert.ok(h < b && b < f, 'header, body, footer');
});

metric(
  'a table cell is as tall as its content, whatever height it sets',
  async () => {
    // CSS 2.1 17.5.3: a cell's height is a least one
    const { node } = await render(
      '<table style="border-spacing:0"><tr>' +
        '<td id="a" height="4" style="padding:0">text</td>' +
        '<td id="b" style="height:4px;padding:0"></td></tr></table>',
    );
    const el = view(node);
    const [a, b] = [boxOf(el, 'a'), boxOf(el, 'b')];
    assert.ok(a.height > 12, `a line tall: ${a.height}`);
    assert.strictEqual(b.height, a.height, 'and so is its row');
  },
);

metric(
  "a table's parts take no margins, and a cell's width keeps within min and max",
  async () => {
    // CSS 2.1 8.3: margins apply to no part of a table but its caption; and
    // a cell's `min-width` and `max-width` hold it, as in every browser
    const { node } = await render(
      '<style>td{padding:0} table{border-spacing:0}</style>' +
        '<table id="t"><tr><td id="c" style="margin:50px">x</td></tr></table>' +
        '<div style="display:table"><div style="display:table-row">' +
        '<div id="max" style="display:table-cell;width:300px;max-width:100px;height:10px"></div>' +
        '</div></div>' +
        '<div style="display:table"><div style="display:table-row">' +
        '<div id="min" style="display:table-cell;min-width:80px;height:10px"></div>' +
        '</div></div>',
    );
    const el = view(node);
    const [t, c] = [boxOf(el, 't'), boxOf(el, 'c')];
    assert.strictEqual(c.x, t.x, 'at the start of its table');
    assert.strictEqual(c.y, t.y, 'at its top');
    assert.strictEqual(boxOf(el, 'max').width, 100);
    assert.strictEqual(boxOf(el, 'min').width, 80);
  },
);

metric('floats that add up to their room exactly fit in it', async () => {
  // ten of 0.87em in 8.7em came to more than it by a rounding error, and
  // the tenth went under the other nine
  const { node } = await render(
    '<div style="width:8.7em;font-size:16px">' +
      '<span id="f0" style="float:left;width:0.87em;height:5px"></span>'.repeat(
        9,
      ) +
      '<span id="last" style="float:left;width:0.87em;height:5px"></span></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'last').y, boxOf(el, 'f0').y, 'one row');
});

/** The clips standing when a fill of this colour was made, innermost last. */
function clipsAround(ops: PaintOp[], color: string): PaintOp[][] {
  const stack: (PaintOp | null)[] = [];
  const out: PaintOp[][] = [];
  for (const op of ops) {
    if (op.op === 'save') stack.push(null);
    else if (op.op === 'restore') stack.pop();
    else if (op.op === 'clip') stack[stack.length - 1] = op;
    else if (op.op === 'fill' && op.style === parseColor(color)) {
      out.push(stack.filter((c): c is PaintOp => c !== null));
    }
  }
  return out;
}

metric('overflow clips what a box holds to its padding box', async () => {
  // HTML mail hides its preheader with `max-height: 0; overflow: hidden`,
  // and a box that did not clip drew it over the message
  const { node } = await render(
    '<div id="o" style="overflow:hidden;width:50px;height:20px;' +
      'padding:2px;border:3px solid #0000ff">' +
      '<div style="width:200px;height:200px;background:#ff0000"></div>' +
      '<div style="position:absolute;width:5px;height:5px;' +
      'background:#00ff00"></div></div>',
  );
  const el = view(node);
  const o = boxOf(el, 'o');
  const ops: PaintOp[] = [];
  await fillsOf(el, ops);
  const [red] = clipsAround(ops, '#ff0000');
  assert.deepStrictEqual(
    red.map((c) => c.op === 'clip' && [c.x, c.y, c.w, c.h]),
    [[Math.round(o.x) + 3, Math.round(o.y) + 3, 54, 24]],
    'the content, clipped to the padding box',
  );
  const [blue] = clipsAround(ops, '#0000ff');
  assert.deepStrictEqual(blue, [], 'and the box itself, not');
  const [green] = clipsAround(ops, '#00ff00');
  assert.deepStrictEqual(
    green,
    [],
    'nor a positioned box whose containing block is outside it',
  );
});

metric(
  "an overflow clip covers the pixels its box's background does",
  async () => {
    // A background at a fractional position rounds to the nearest pixel. A
    // clip rounded out to whole pixels let a row of what it clips show
    // beyond the background's edge, which a 2x display turns up.
    const { node } = await render(
      '<div style="height:10.5px"></div>' +
        '<div style="overflow:hidden;width:50px;height:20px;background:#0000ff">' +
        '<div style="height:200px;background:#ff0000"></div></div>',
    );
    const ops: PaintOp[] = [];
    const fills = await fillsOf(view(node), ops);
    const blue = fills.find((f) => f.style === parseColor('#0000ff'))!;
    const [[clip]] = clipsAround(ops, '#ff0000');
    assert.deepStrictEqual(
      clip.op === 'clip' && [clip.x, clip.y, clip.w, clip.h],
      [blue.x, blue.y, blue.w, blue.h],
    );
  },
);

metric('what a box clipped to no area holds is not painted', async () => {
  // A menu at `max-height: 0`: clipped to an empty rectangle, what it held
  // was painted through a mask the size of the window, which is what an
  // empty rectangle is to the context, and a nest of them made one at
  // every level. An absolute box whose containing block is outside it
  // still shows.
  const { node } = await render(
    '<div style="max-height:0;overflow:hidden">' +
      '<div style="height:20px;background:#ff0000"></div></div>' +
      '<div style="height:0;overflow:hidden">' +
      '<div style="position:absolute;top:50px;width:20px;height:20px;' +
      'background:#0000ff"></div></div>',
  );
  const fills = await fillsOf(view(node));
  const painted = (color: string) =>
    fills.some((f) => f.style === parseColor(color));
  assert.ok(!painted('#ff0000'), 'what it holds');
  assert.ok(painted('#0000ff'), 'an absolute box outside its clip');
});

metric(
  'a rounded box clips rounded only where its padding leaves a corner to cut',
  async () => {
    const { node } = await render(
      '<div style="overflow:hidden;border-radius:6px;padding:8px">' +
        '<div style="height:10px;background:#ff0000"></div></div>' +
        '<div style="overflow:hidden;border-radius:6px;padding:8px 4px">' +
        '<div style="height:10px;background:#0000ff"></div></div>',
    );
    const ops: PaintOp[] = [];
    await fillsOf(view(node), ops);
    const [[red]] = clipsAround(ops, '#ff0000');
    assert.strictEqual(
      red.op === 'clip' && red.radii,
      null,
      'padding past every corner both ways: a rectangle clips the same',
    );
    const [[blue]] = clipsAround(ops, '#0000ff');
    assert.deepStrictEqual(
      blue.op === 'clip' && blue.radii,
      [6, 6, 6, 6],
      'a side thinner than its corner: rounded',
    );
  },
);

metric(
  'a negative z-index is painted under the flow of its stacking context',
  async () => {
    // CSS 2.1 Appendix E: over the context's background, under all else in
    // it; a parent that is no stacking context does not hold it
    const { node } = await render(
      '<div style="background:#0000ff;height:20px">' +
        '<div style="position:absolute;z-index:-1;width:10px;height:10px;' +
        'background:#ff0000"></div></div>' +
        '<div style="position:relative;z-index:0;background:#00ffff">' +
        '<div style="position:absolute;z-index:-1;width:10px;height:10px;' +
        'background:#ff00ff"></div><div style="height:20px;' +
        'background:#00ff00"></div></div>',
    );
    const order = (await fillsOf(view(node))).map((f) => f.style);
    const at = (color: string) => order.indexOf(parseColor(color));
    assert.ok(
      at('#ff0000') < at('#0000ff'),
      'under a parent that is no context',
    );
    assert.ok(
      at('#00ffff') < at('#ff00ff') && at('#ff00ff') < at('#00ff00'),
      "over its context's background, under its flow",
    );
  },
);

metric(
  'an absolute box between two offsets shares what is left with its auto margins, or fills it',
  async () => {
    // CSS 2.1 10.3.7 and 10.6.4
    const { node } = await render(
      '<div id="c" style="position:relative;width:300px;height:100px">' +
        '<div id="a" style="position:absolute;left:0;right:0;width:100px;' +
        'height:10px;margin:0 auto"></div>' +
        '<div id="b" style="position:absolute;top:10px;bottom:20px;' +
        'left:0;width:10px"></div>' +
        '<div id="m" style="position:absolute;top:0;bottom:0;height:20px;' +
        'left:0;width:10px;margin:auto 0"></div></div>',
    );
    const el = view(node);
    const [c, a, b, m] = ['c', 'a', 'b', 'm'].map((id) => boxOf(el, id));
    assert.strictEqual(a.x - c.x, 100, 'centred between left and right');
    assert.strictEqual(b.height, 70, 'as tall as top and bottom leave it');
    assert.strictEqual(m.y - c.y, 40, 'centred between top and bottom');
  },
);

metric(
  'an absolute box with auto offsets is where the flow put it',
  async () => {
    // CSS 2.1 10.3.7 and 10.6.4: with neither `left` nor `right`, and neither
    // `top` nor `bottom`, the box takes its static position — where it would
    // have been in the flow — not its containing block's corner
    const { node } = await render(
      '<div id="c" style="padding:10px;margin:0 20px">' +
        '<p id="p" style="margin:0;height:30px">x</p>' +
        '<div id="a" style="position:absolute;width:5px;height:5px"></div>' +
        '<div id="b" style="position:absolute;top:0;width:5px;height:5px">' +
        '</div></div>',
    );
    const el = view(node);
    const [c, p, a, b] = ['c', 'p', 'a', 'b'].map((id) => boxOf(el, id));
    assert.deepStrictEqual([a.x, a.y], [c.x + 10, p.y + p.height]);
    assert.strictEqual(b.x, c.x + 10, 'one axis at a time');
    assert.strictEqual(b.y, 0);
  },
);

metric(
  'an absolute box after text is under its line, or after it on the line',
  async () => {
    // The static position among a paragraph's text (CSS 2.1 10.3.7,
    // 10.6.4): a block-level box would have broken the line, so it goes
    // under it, and an inline-level one goes where the text left the pen.
    // Both went at the paragraph's top, over its text. The second is in a
    // padded span, whose paragraph is laid out another way.
    const { node } = await render(
      '<style>body{margin:0} div{line-height:20px}</style>' +
        '<div id="p">Some text<div id="a" style="position:absolute;' +
        'width:5px;height:5px"></div></div>' +
        '<div id="q">Some <span style="padding-left:4px">text<span id="b" ' +
        'style="position:absolute;width:5px;height:5px"></span></span></div>',
    );
    const el = view(node);
    const [p, a, q, b] = ['p', 'a', 'q', 'b'].map((id) => boxOf(el, id));
    assert.deepStrictEqual([a.x, a.y], [p.x, p.y + 20], 'under the line');
    const [line] = linesOf(el, 'q');
    assert.strictEqual(b.y, q.y, 'on the line');
    const end = line.x + line.width;
    assert.ok(Math.abs(b.x - end) < 1, `after the text: ${b.x}, ${end}`);
  },
);

metric(
  "an inline box's border before an absolute box is its line's content",
  async () => {
    // CSS 2.1 9.4.2: a line with nothing on it but white space is no line,
    // and one with an inline box's margin or border on it is one, even
    // where the two add up to no width; a block-level absolute box after
    // the first goes at its top, and after the second under it
    const { node } = await render(
      '<style>body{margin:0} div{line-height:20px}</style>' +
        '<div id="p"><span> <div id="a" style="position:absolute;' +
        'width:5px;height:5px"></div></span></div>' +
        '<div id="q"><span style="border-left:10px solid;margin-left:-10px">' +
        '<div id="b" style="position:absolute;width:5px;height:5px"></div>' +
        '</span></div>',
    );
    const el = view(node);
    const [p, a, q, b] = ['p', 'a', 'q', 'b'].map((id) => boxOf(el, id));
    assert.strictEqual(a.y, p.y, 'at the top');
    assert.strictEqual(b.y, q.y + 20, 'under the line');
  },
);

metric(
  'an absolute box in a positioned inline box is placed against it',
  async () => {
    // CSS 2.1 10.1, item 4: a `position: relative` inline box is the
    // containing block of what is absolute in it, from the padding edge its
    // first fragment starts at. Read as a box that lays itself out, it was
    // a rectangle of no size at the page's corner, and a tooltip under its
    // link came up there.
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<p id="p" style="margin:0 0 0 30px;line-height:20px">Hover ' +
        '<a id="l" style="position:relative;padding-left:4px">here<span ' +
        'id="t" style="position:absolute;left:0;top:100%;width:10px;' +
        'height:10px"></span></a></p>',
    );
    const el = view(node);
    const [p, t] = ['p', 't'].map((id) => boxOf(el, id));
    const [line] = linesOf(el, 'p');
    // the link's, the one inline box on the line
    const start = line.edges!.find((e) => e.side === 'start')!;
    assert.strictEqual(t.x, start.x, "at the link's padding edge");
    assert.ok(t.x > p.x, 'not at the corner');
    assert.ok(t.y > p.y && t.y <= p.y + 20, `under its text: ${t.y}`);
  },
);

metric(
  'a shrink-to-fit box that does not wrap is as wide as its line',
  async () => {
    // min(max(min-content, room), max-content) (CSS 2.1 10.3.5), and a line
    // that does not wrap is its own min-content: a `nowrap` tooltip in a
    // link narrower than it was cut to the link's width, its words taken
    // for places it could break
    const { node } = await render(
      '<div style="width:40px"><div id="f" style="float:left;' +
        'white-space:nowrap">one two three</div></div>',
    );
    const el = view(node);
    const [line] = linesOf(el, 'f');
    const f = boxOf(el, 'f');
    assert.ok(f.width > 40, `past its room: ${f.width}`);
    assert.ok(Math.abs(f.width - line.width) < 1, 'as wide as its line');
  },
);

metric('a relative box after an absolute one is painted over it', async () => {
  // both are positioned, and CSS paints positioned boxes in document order
  // after the flow (CSS 2.1 Appendix E); the relative one was painted with
  // the flow, under the absolute one
  const { node } = await render(
    '<div style="position:absolute;width:30px;height:30px;' +
      'background:#ff0000"></div>' +
      '<div style="position:relative;width:30px;height:30px;' +
      'background:#00ff00"></div><div style="height:10px;' +
      'background:#0000ff"></div>',
  );
  const fills = await fillsOf(view(node));
  const order = (color: string) =>
    fills.findIndex((f) => f.style === parseColor(color));
  assert.ok(order('#0000ff') < order('#ff0000'), 'the flow first');
  assert.ok(order('#ff0000') < order('#00ff00'), 'then in document order');
});

metric(
  'a positioned box in a box painted whole is painted with the others',
  async () => {
    // CSS 2.1 Appendix E: a stacking context paints every positioned box
    // in it after its flow, in document order, then by `z-index`, whatever
    // box it is in. One in an `overflow: hidden` box was painted with that
    // box, among the flow, and so under a positioned box before it; and a
    // menu with a `z-index` in a positioned header went under positioned
    // content after the header.
    const { node } = await render(
      '<div style="position:absolute;width:30px;height:30px;' +
        'background:#ff0000"></div>' +
        '<div style="overflow:hidden;width:30px;height:30px">' +
        '<div style="position:absolute;width:30px;height:30px;' +
        'background:#00ff00"></div></div>' +
        '<div style="position:relative;height:20px">' +
        '<div style="position:absolute;z-index:1;top:10px;width:30px;' +
        'height:40px;background:#0000ff"></div></div>' +
        '<div style="position:relative;height:40px;background:#ffff00"></div>',
    );
    const fills = await fillsOf(view(node));
    const order = (color: string) =>
      fills.findIndex((f) => f.style === parseColor(color));
    assert.ok(order('#ff0000') < order('#00ff00'), 'in document order');
    assert.ok(order('#ffff00') < order('#0000ff'), 'the z-index over it');
  },
);

metric(
  'a fixed box is a stacking context, and a box below its flow is not drawn over it',
  async () => {
    // CSS Positioned Layout 3: a fixed box is a stacking context with no
    // `z-index`, so a box in it set to `-1` goes over its background, not
    // behind the page. And a box set below the flow on a line, an
    // inline-block's canvas, is its stacking context's to draw there, and
    // was drawn by its line as well, over the box it was under.
    const { node } = await render(
      '<div style="position:fixed;left:0;top:0;width:30px;height:30px;' +
        'background:#ff0000"><div style="position:absolute;z-index:-1;' +
        'width:30px;height:30px;background:#00ff00"></div></div>' +
        '<div style="display:inline-block;width:40px;height:40px;' +
        'background:#0000ff"><canvas width="4" height="4" style="height:100%;' +
        'position:relative;z-index:-1;background:#ffff00"></canvas></div>',
    );
    const fills = await fillsOf(view(node));
    const at = (color: string) =>
      fills.findIndex((f) => f.style === parseColor(color));
    assert.ok(at('#ff0000') < at('#00ff00'), 'over the fixed box');
    const yellow = fills.filter((f) => f.style === parseColor('#ffff00'));
    assert.strictEqual(yellow.length, 1, 'drawn once');
    assert.ok(at('#ffff00') < at('#0000ff'), 'under the inline-block');
  },
);

metric(
  'a positioned box its stacking context paints is clipped where it is',
  async () => {
    // painted after the flow, apart from the boxes around it, an absolute
    // box is still under the clip of a box its containing block is in, and
    // a relative one under every one it is in
    const { node } = await render(
      '<div id="o" style="position:relative;overflow:hidden;width:20px;' +
        'height:20px"><div style="position:absolute;left:10px;width:40px;' +
        'height:40px;background:#00ff00"></div></div>' +
        '<div id="p" style="overflow:hidden;width:20px;height:20px">' +
        '<div style="position:relative;left:10px;width:40px;height:40px;' +
        'background:#0000ff"></div></div>',
    );
    const el = view(node);
    const [o, p] = ['o', 'p'].map((id) => boxOf(el, id));
    const ops: PaintOp[] = [];
    await fillsOf(el, ops);
    const rect = (c: PaintOp) => c.op === 'clip' && [c.x, c.y, c.w, c.h];
    const [green] = clipsAround(ops, '#00ff00');
    assert.deepStrictEqual(green.map(rect), [
      [Math.round(o.x), Math.round(o.y), 20, 20],
    ]);
    const [blue] = clipsAround(ops, '#0000ff');
    assert.deepStrictEqual(blue.map(rect), [
      [Math.round(p.x), Math.round(p.y), 20, 20],
    ]);
  },
);

metric(
  'a block with a formatting context of its own sits beside a float',
  async () => {
    // CSS 2.1 9.5: an `overflow: hidden` block beside a floated image is a
    // rectangle in the room the float leaves, where it ran under the image;
    // a table too wide for the room goes below the floats
    const { node } = await render(
      '<div id="c" style="width:400px">' +
        '<div id="f" style="float:left;width:100px;height:50px"></div>' +
        '<div id="b" style="overflow:hidden;height:20px">beside</div>' +
        '<div id="g" style="float:left;width:300px;height:40px"></div>' +
        '<table id="t" style="width:200px;border-spacing:0"><tr><td>x</td>' +
        '</tr></table></div>',
      500,
    );
    const el = view(node);
    const [c, f, b, g, t] = ['c', 'f', 'b', 'g', 't'].map((id) =>
      boxOf(el, id),
    );
    assert.deepStrictEqual([b.x, b.width], [f.x + f.width, c.width - 100]);
    assert.strictEqual(g.x, f.x + f.width, 'the second float fits beside');
    assert.ok(t.y >= g.y + g.height, `the table goes below both: ${t.y}`);
  },
);

metric('a right-to-left block starts at the right', async () => {
  // CSS 2.1 10.3.3: the margin that takes the slack is the one at the end,
  // the left one in a right-to-left containing block; 16.1: the indent is
  // at the start of the line; 10.3.7: so is an absolute box's static place
  const { node } = await render(
    '<div id="c" style="direction:rtl;width:300px;position:relative">' +
      '<div id="b" style="width:100px;height:10px"></div>' +
      '<p id="p" style="margin:0;text-indent:20px">word</p>' +
      '<div id="a" style="position:absolute;width:50px;height:5px"></div>' +
      '</div>' +
      '<div style="position:relative;margin-left:100px"><div id="f" ' +
      'style="position:fixed;left:0;top:0;width:10px;height:10px"></div></div>',
  );
  const el = view(node);
  const [c, b, p, a, f] = ['c', 'b', 'p', 'a', 'f'].map((id) => boxOf(el, id));
  assert.strictEqual(b.x, c.x + 200, 'a block of a set width');
  const [line] = linesOf(el, 'p');
  assert.ok(
    Math.abs(line.x + line.width - (p.x + p.width - 20)) < 0.5,
    `a line indented from the right: ${line.x + line.width}`,
  );
  assert.strictEqual(a.x, c.x + 250, 'an absolute box with auto offsets');
  assert.strictEqual(f.x, 0, "and a fixed box's containing block is the view");
});

metric('a justified paragraph fills every line but its last', async () => {
  // `justify` was set as `start`. Each line is widened at its spaces to
  // fill the box, but not the paragraph's last, nor one a forced break
  // ends (CSS Text 3, 7.4); the ragged copies say what those are unwidened
  const words = 'the quick brown fox jumps over the lazy dog and back again ';
  const { node } = await render(
    '<style>body{margin:0}p{margin:0;width:200px}.j{text-align:justify}' +
      '</style>' +
      `<p id="p" class="j">${words.repeat(3)}</p>` +
      `<p id="ragged">${words.repeat(3)}</p>` +
      `<p id="br" class="j">a b<br>${words}</p>` +
      `<p id="rtl" class="j" dir="rtl">${words.repeat(2)}</p>` +
      `<p id="rtl-ragged" dir="rtl">${words.repeat(2)}</p>`,
  );
  const el = view(node);
  const extents = (id: string) =>
    linesOf(el, id).map((line) => extentOf(line.texts[0]));
  const width = ([from, to]: [number, number]) => to - from;
  const last = <T>(list: T[]) => list[list.length - 1];
  const lines = extents('p');
  const ragged = extents('ragged');
  assert.ok(lines.length > 2, `${lines.length} lines`);
  assert.strictEqual(lines.length, ragged.length, 'broken where it was');
  for (const [from, to] of lines.slice(0, -1)) {
    assert.ok(from < 0.5 && to > 199.5, `a full line: ${from}..${to}`);
  }
  assert.ok(
    Math.abs(width(last(lines)) - width(last(ragged))) < 0.5,
    'not the last',
  );
  const [[, first]] = extents('br');
  assert.ok(first < 50, `not one a break ends: ${first}`);
  const rtl = extents('rtl');
  const rtlRagged = extents('rtl-ragged');
  assert.strictEqual(rtl.length, rtlRagged.length);
  for (const [from, to] of rtl.slice(0, -1)) {
    assert.ok(from < 0.5 && to > 199.5, `right to left: ${from}..${to}`);
  }
  assert.ok(last(rtl)[1] > 199.5, 'whose last line starts at the right');
  assert.ok(Math.abs(width(last(rtl)) - width(last(rtlRagged))) < 0.5);
});

metric('a justified line fills its room however it was made', async () => {
  // Only a paragraph laid out as one text layout was justified (CSS Text 3,
  // 7.4 justifies every line but the last): a line beside a float, the
  // lines past the float's bottom, a line with an inline-block on it and
  // one between an inline box's padding were all set at their start. The
  // Zen Garden's first design has its text beside a float
  const words = 'the quick brown fox jumps over the lazy dog and back again ';
  const { node } = await render(
    '<style>body{margin:0}p{margin:0;width:200px;text-align:justify}' +
      '.f{float:left;width:60px;height:40px}</style>' +
      `<div><div class="f"></div><p id="float">${words.repeat(3)}</p></div>` +
      `<p id="atomic">${words}<span style="display:inline-block;` +
      `width:20px;height:8px"></span> ${words.repeat(2)}</p>` +
      `<p id="padded">${words}<span style="padding:0 6px;` +
      `border-left:2px solid">quick brown</span> ${words.repeat(2)}</p>`,
    400,
  );
  const el = view(node);
  const extentsOf = (id: string) =>
    linesOf(el, id).map((line) => {
      let from = Infinity;
      let to = -Infinity;
      for (const text of line.texts) {
        const [a, b] = extentOf(text);
        from = Math.min(from, a);
        to = Math.max(to, b);
      }
      for (const placed of line.atomics) {
        from = Math.min(from, placed.x);
        to = Math.max(to, placed.x + placed.box.width);
      }
      return [from, to] as [number, number];
    });
  const beside = extentsOf('float');
  assert.ok(beside.length > 3, `${beside.length} lines`);
  for (const [from, to] of beside.slice(0, -1)) {
    // beside the float from its right edge, past it from the box's
    const left = from < 30 ? 0 : 60;
    assert.ok(
      Math.abs(from - left) < 0.5 && to > 199.5,
      `a full line: ${from}..${to}`,
    );
  }
  assert.ok(
    beside.slice(0, -1).some(([from]) => from > 59.5) &&
      beside.slice(0, -1).some(([from]) => from < 0.5),
    'lines beside the float and past it',
  );
  for (const id of ['atomic', 'padded']) {
    const lines = extentsOf(id);
    assert.ok(lines.length > 2, `${id}: ${lines.length} lines`);
    for (const [from, to] of lines.slice(0, -1)) {
      assert.ok(from < 0.5 && to > 199.5, `${id}, a full line: ${from}..${to}`);
    }
  }
  // and an edge is no space: the text after the padding starts at its end
  const edged = linesOf(el, 'padded').find((line) =>
    line.edges?.some((edge) => edge.side === 'start'),
  )!;
  const edge = edged.edges!.find((e) => e.side === 'start')!;
  const next = textRunsOf(edged).find(([from]) => from >= edge.x);
  assert.ok(
    next && Math.abs(next[0] - (edge.x + edge.width)) < 0.5,
    `the text after the edge at ${next?.[0]}, the edge ending at ${edge.x + edge.width}`,
  );
});

metric(
  'text-align-last sets the last line, and each a forced break ends, apart',
  async () => {
    // CSS Text 3, 7.2; it was not read, and every line was set as
    // `text-align` has it. `justify-all` justifies the last line too, and
    // `text-justify: none` justifies nothing
    const words = 'the quick brown fox jumps over the lazy dog and back again ';
    const { node } = await render(
      '<style>body{margin:0}p{margin:0;width:200px}</style>' +
        '<p id="one" style="text-align-last:center">short</p>' +
        `<p id="many" style="text-align-last:right">${words.repeat(2)}</p>` +
        `<p id="br" style="text-align-last:right">a b<br>${words}</p>` +
        `<p id="all" style="text-align:justify-all">${words.repeat(2)}</p>` +
        '<p id="j" style="text-align:justify;text-align-last:center">' +
        `${words.repeat(2)}</p>` +
        '<p id="none" style="text-align:justify;text-justify:none">' +
        `${words.repeat(2)}</p>`,
    );
    const el = view(node);
    const extents = (id: string) =>
      linesOf(el, id).map((line) => extentOf(line.texts[0]));
    const last = <T>(list: T[]) => list[list.length - 1];
    const [[from, to]] = extents('one');
    assert.ok(Math.abs(from - (200 - to)) < 1, `centred: ${from}..${to}`);
    const many = extents('many');
    assert.ok(
      many[0][0] < 0.5 && last(many)[1] > 199.5,
      'the last at the right',
    );
    assert.ok(extents('br')[0][1] > 199.5, 'and one a break ends');
    for (const [a, b] of extents('all')) {
      assert.ok(a < 0.5 && b > 199.5, `justified, the last too: ${a}..${b}`);
    }
    const j = extents('j');
    for (const [a, b] of j.slice(0, -1)) {
      assert.ok(a < 0.5 && b > 199.5, `${a}..${b}`);
    }
    const [ja, jb] = last(j);
    assert.ok(Math.abs(ja - (200 - jb)) < 1, `the last centred: ${ja}..${jb}`);
    assert.ok(
      extents('none').some(([, b]) => b < 199),
      'text-justify: none spaces nothing',
    );
  },
);

metric(
  'a justified line keeps its breaks where a spaced space is wider',
  async () => {
    // an engine measures a space that is a spaced run of its own wider
    // than the same space inside its run — ntk loses the kerning pair it
    // made, CoreText drops the font's pairs for its kerning attribute — so
    // a line justified from a measure of its spaces as they were no longer
    // fit, and broke a word early, short of the edge
    const words = 'The quick brown fox jumps over the lazy dog, and back. ';
    const { result, node } = await render(
      '<style>body{margin:0}p{margin:0;width:200px;text-align:justify}</style>' +
        `<p id="p">${words.repeat(3)}</p>`,
    );
    const el = view(node);
    const fonts = (result.app as unknown as { fonts: FontsLike }).fonts;
    const kerning: FontsLike = {
      layout: (runs, style, options) =>
        fonts.layout(
          runs.map((run) =>
            run.letterSpacing && (run.text === ' ' || run.text === '\u00a0')
              ? { ...run, letterSpacing: run.letterSpacing + 0.4 }
              : run,
          ),
          style,
          options,
        ),
      match: (...args) => fonts.match(...args),
    };
    const { layoutDocument } = await import('../src/html/layout/block.js');
    const tree = (el as unknown as { _tree: unknown })._tree;
    layoutDocument(tree as never, kerning, 400, 600);
    const lines = linesOf(el, 'p').map((line) => extentOf(line.texts[0]));
    assert.ok(lines.length > 2, `${lines.length} lines`);
    for (const [from, to] of lines.slice(0, -1)) {
      assert.ok(from < 0.5 && to > 199.5, `a full line: ${from}..${to}`);
    }
  },
);

metric('text that does not wrap is aligned in its box', async () => {
  // the engine aligns lines it is given no width for within the widest of
  // them, which for one line is no alignment at all: a centred `<td
  // nowrap>` or `white-space: nowrap` label was set flush left
  const long = 'a line too long for its box';
  const { node } = await render(
    '<style>body{margin:0}div{width:300px}td{padding:0}</style>' +
      '<div id="c" style="white-space:nowrap;text-align:center">centred</div>' +
      '<div id="r" style="white-space:nowrap;text-align:right">right</div>' +
      '<div id="rtl" dir="rtl" style="white-space:nowrap">start</div>' +
      '<div id="pre" style="white-space:pre;text-align:center">one\n' +
      'a longer line</div>' +
      '<table width="300" style="border-spacing:0"><tr>' +
      '<td id="td" nowrap align="center">cell</td></tr></table>' +
      '<div id="sp" style="white-space:nowrap;text-align:center">' +
      '<span style="padding:0 10px;background:#eee">boxed</span></div>' +
      `<div id="over" dir="rtl" style="white-space:nowrap;width:50px">${long}</div>` +
      '<div id="wide" style="white-space:nowrap;width:50px;text-align:center">' +
      `${long}</div>`,
  );
  const el = view(node);
  const extents = (id: string) =>
    linesOf(el, id).map((line) => extentOf(line.texts[0]));
  const centred = ([from, to]: [number, number], label: string) =>
    assert.ok(Math.abs(from + to - 300) < 0.5, `${label}: ${from}..${to}`);
  centred(extents('c')[0], 'centred');
  assert.ok(Math.abs(extents('r')[0][1] - 300) < 0.5, 'right');
  assert.ok(Math.abs(extents('rtl')[0][1] - 300) < 0.5, 'right-to-left');
  const pre = extents('pre');
  assert.strictEqual(pre.length, 2);
  pre.forEach((extent, i) => centred(extent, `pre line ${i}`));
  centred(extents('td')[0], 'a centred cell');
  // an inline box's edges go with the line they are on
  const [boxed] = linesOf(el, 'sp');
  assert.ok(Math.abs(2 * boxed.x + boxed.width - 300) < 0.5, 'with edges');
  assert.ok(
    Math.abs(boxed.edges![0].x - boxed.x) < 0.5,
    `the start edge at the line's start: ${boxed.edges![0].x}`,
  );
  // a line too long for its box is set at its start, overflowing its end
  const [[overFrom, overTo]] = extents('over');
  assert.ok(Math.abs(overTo - 50) < 0.5 && overFrom < 0, 'left, in rtl');
  assert.ok(Math.abs(extents('wide')[0][0]) < 0.5, 'right, centred');
});

metric(
  'a relatively positioned ::before moves, in a document where nothing else does',
  async () => {
    // the pass that moves relative boxes runs only where the build found
    // one, and generated content is built apart from its element
    const { node } = await render(
      '<style>#p::before { content: "x"; display: block; position: relative;' +
        ' left: 20px }</style><p id="p" style="margin:0">text</p>',
    );
    const el = view(node);
    const p = boxOf(el, 'p');
    const before = p.children.find(
      (b) => (b as unknown as { pseudo: string | null }).pseudo === 'before',
    );
    assert.ok(before, 'the ::before has a box');
    assert.strictEqual(before.x, p.x + 20);
  },
);

metric('an image set display: block is a block', async () => {
  // mail writes `img { display: block }` to lose the gap under its images;
  // they stacked on one line as inline images, and one beside a float
  // went under it
  const { node } = await render(
    '<div style="width:300px"><div id="f" style="float:left;width:40px;' +
      'height:100px"></div><img id="a" width="20" height="20" ' +
      'style="display:block"><img id="b" width="20" height="20" ' +
      'style="display:block"></div>',
  );
  const el = view(node);
  const [f, a, b] = ['f', 'a', 'b'].map((id) => boxOf(el, id));
  assert.strictEqual(b.y, a.y + a.height, 'one below the other');
  assert.strictEqual(a.x, f.x + f.width, 'beside the float, not under it');
});

metric("a list item's marker goes where its item is moved", async () => {
  // a table cell is laid out at the origin and then placed; the marker was
  // left behind, a bullet at the document's corner
  const { node } = await render(
    '<table style="margin-left:60px"><tr><td>' +
      '<ul style="margin:0"><li id="li">item</li></ul></td></tr></table>',
  );
  const el = view(node);
  const li = boxOf(el, 'li') as LaidBox & {
    marker: { x: number; y: number } | null;
  };
  assert.ok(
    li.marker!.x < li.x + 40 && li.marker!.x > li.x - 40,
    `beside its item: ${li.marker!.x} by ${li.x}`,
  );
  assert.ok(li.marker!.y >= li.y - 2 && li.marker!.y < li.y + li.height);
});

metric('clip shows the part of an absolute box it names', async () => {
  const { node } = await render(
    '<div id="a" style="position:absolute;top:0;left:0;width:40px;' +
      'height:40px;background:#ff0000;clip:rect(5px, 25px, auto, 5px)"></div>' +
      '<div style="position:absolute;width:40px;height:40px;' +
      'background:#00ff00;clip:rect(0, 0, 0, 0)"></div>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  const ops: PaintOp[] = [];
  const fills = await fillsOf(el, ops);
  const [red] = clipsAround(ops, '#ff0000');
  assert.deepStrictEqual(
    red.map((c) => c.op === 'clip' && [c.x, c.y, c.w, c.h]),
    [[a.x + 5, a.y + 5, 20, 35]],
    "its background too, and `auto` is the border box's edge",
  );
  assert.ok(
    !fills.some((f) => f.style === parseColor('#00ff00')),
    'an empty clip shows nothing',
  );
});

metric("an inline-block's text sits on the line's baseline", async () => {
  // CSS 2.1 10.8.1: an inline-block's baseline is its last line box's. Set
  // bottom-on-baseline, a button's label sat its descent above the text
  // beside it.
  const { node } = await render(
    '<p id="p" style="margin:0">x <span id="ib" style="display:inline-block;' +
      'padding:4px;border:1px solid">Label</span> y</p>',
  );
  const el = view(node);
  const [line] = linesOf(el, 'p');
  const [outside] = line.texts;
  const outsideBaseline =
    outside.drawY + outside.layout.lines[outside.layoutLine].baseline;
  const [inner] = linesOf(el, 'ib');
  const [label] = inner.texts;
  const labelBaseline =
    label.drawY + label.layout.lines[label.layoutLine].baseline;
  assert.ok(
    Math.abs(labelBaseline - outsideBaseline) < 0.5,
    `on one baseline: ${labelBaseline} and ${outsideBaseline}`,
  );
});

metric('form controls carry default margins from the UA sheet', async () => {
  const { node } = await render('<p>a <input size="4"> b</p>');
  const tree = (
    view(node) as unknown as {
      _tree: {
        root: {
          children: {
            children: {
              replaced: string;
              marginTop: number;
              marginLeft: number;
            }[];
          }[];
        };
      };
    }
  )._tree;
  const input = tree.root.children[0].children.find(
    (c) => c.replaced === 'input',
  );
  assert.ok(input, 'the input box exists');
  assert.ok(
    input.marginTop >= 2,
    `vertical breathing room (${input.marginTop})`,
  );
  assert.ok(
    input.marginLeft >= 1,
    `horizontal breathing room (${input.marginLeft})`,
  );
});

metric(
  'a text field the author gave a box is drawn by the document',
  async () => {
    // a browser drops a field's native look for the author's border and
    // background (CSS UI 4 7.1); the widget was mounted over the whole
    // box, with the theme's frame and fill over the author's
    const { result, node } = await render(
      '<style>body{margin:0}</style><input id="f" placeholder="q" ' +
        'style="margin:0;border:10px solid #00ff00;background:#0000ff;' +
        'padding:5px;width:100px;height:20px">',
    );
    const field = await screen.findByPlaceholder('q');
    const at = (node as unknown as { abs: { x: number; y: number } }).abs;
    const inner = (field as unknown as { abs: Record<string, number> }).abs;
    assert.deepStrictEqual(
      [inner.x - at.x, inner.y - at.y, inner.width, inner.height],
      [15, 15, 100, 20],
      'bare in the content box',
    );
    await waitFor(async () => {
      const [r, g, b] = await pixelAt(result.ctx, at.x + 5, at.y + 5);
      assert.ok(g > 200 && r < 60 && b < 60, `a green edge: ${r},${g},${b}`);
      const [r2, g2, b2] = await pixelAt(result.ctx, at.x + 100, at.y + 25);
      assert.ok(
        b2 > 200 && r2 < 60 && g2 < 60,
        `a blue field: ${r2},${g2},${b2}`,
      );
    });
  },
);

// --- selection and hit testing ----------------------------------------------

metric('the caret and the selection bands agree with the glyphs', async () => {
  const { node } = await render('<p>Hello world</p>', 400);
  const el = view(node);
  const start = el.textCaretRect(0);
  const later = el.textCaretRect(5);
  assert.ok(start && later);
  assert.ok(later.x > start.x, 'the caret advances through the line');
  const bands = el.textRangeRects(0, 5);
  assert.strictEqual(bands.length, 1, 'one band for a range inside one line');
  assert.ok(Math.abs(bands[0].x - start.x) < 1);
  assert.ok(bands[0].width > 0);
});

metric('a range spanning two blocks is two bands', async () => {
  const { node } = await render('<p>first</p><p>second</p>', 400);
  const el = view(node);
  const text = el.textContent();
  const bands = el.textRangeRects(0, text.length);
  assert.ok(bands.length >= 2, `one band per line, got ${bands.length}`);
  assert.ok(bands[1].y > bands[0].y, 'the second is below the first');
});

metric('a point maps back to the character under it', async () => {
  const { node } = await render('<p>Hello world</p>', 400);
  const el = view(node);
  const caret = el.textCaretRect(6);
  assert.ok(caret);
  const index = el.textIndexAt(caret.x + 1, caret.y + caret.height / 2);
  assert.ok(Math.abs(index - 6) <= 1, `round-tripped to ${index}`);
});

metric('Ctrl+A selects the whole document, across every block', async () => {
  const { node, result } = await render('<h1>Title</h1><p>Body.</p>', 400);
  // Focus lands on the selectable root through a press, like any focusable.
  await act(async () => {
    fireEvent.mouseDown(node, {});
    fireEvent.mouseUp(node, {});
  });
  await act(async () => {
    fireEvent.key(0x61 /* a */, { modifiers: ['Control'] });
  });
  assert.strictEqual(node.selectedText(), 'TitleBody.');
  void result;
});

metric('a click on a link reports its href; a drag does not', async () => {
  const clicks: string[] = [];
  const result = await renderX11(
    h(
      'box',
      { style: { width: 400, flexDirection: 'column' } },
      h(Html, {
        source: '<p><a href="https://example.test/x">a link here</a></p>',
        partial: false,
        onLink: (href: string) => clicks.push(href),
        'data-testname': 'doc',
      }),
    ),
    { width: 440, height: 200, fonts: FONTS! },
  );
  const node = screen.getByTestName('doc') as DrawnNode;
  const el = view(node);
  const caret = el.textCaretRect(2);
  assert.ok(caret, 'the link text is laid out');
  const x = caret.x + 1;
  const y = caret.y + caret.height / 2;
  assert.strictEqual(el.hrefAtPoint(x, y), 'https://example.test/x');

  // The press lands on the element, which is what a real pointer hits and
  // what `useLinkClicks` reads `hrefAtPoint` from. The harness places a
  // pointer by offset from the node's centre.
  const target = el as unknown as DrawnNode;
  const dx = x - (target.abs.x + target.abs.width / 2);
  const dy = y - (target.abs.y + target.abs.height / 2);
  await act(async () => {
    fireEvent.mouseDown(target, { dx, dy });
    fireEvent.mouseUp(target, { dx, dy });
  });
  assert.deepStrictEqual(clicks, ['https://example.test/x']);

  // A press that travelled is a selection gesture, not a click.
  await act(async () => {
    fireEvent.mouseDown(target, { dx, dy });
    fireEvent.mouseUp(target, { dx: dx + 60, dy });
  });
  assert.strictEqual(clicks.length, 1, 'the drag did not follow the link');
  void result;
});

metric(
  'a <button> is drawn with its content, and a press on it is reported',
  async () => {
    // A `<button>` was a mounted widget labelled with its text — or with
    // "Button", where its content was an icon or spans, as most buttons on the
    // web are — and the look the page gave it was lost. It is laid out and
    // drawn like any box, and pressing it is reported through
    // `onControlChange`, as pressing a widget is.
    const pressed: [string | undefined, unknown][] = [];
    await renderX11(
      h(
        'box',
        { style: { width: 400, flexDirection: 'column' } },
        h(Html, {
          source:
            '<button id="b" value="go"><span>Search</span></button> ' +
            '<button id="off" disabled><span>Off</span></button>',
          partial: false,
          onControlChange: (
            el: { attribs: Record<string, string> },
            v: unknown,
          ) => void pressed.push([el.attribs.id, v]),
          'data-testname': 'doc',
        }),
      ),
      { width: 440, height: 200, fonts: FONTS! },
    );
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const tree = (el as unknown as { _tree: { controls: unknown[] } })._tree;
    assert.strictEqual(tree.controls.length, 0, 'no widget is mounted for it');
    assert.ok(
      el.textContent().includes('Search'),
      "its text is the document's",
    );
    const press = async (id: string) => {
      const box = boxOf(el, id);
      const target = el as unknown as DrawnNode;
      const dx = box.x + box.width / 2 - target.abs.width / 2;
      const dy = box.y + box.height / 2 - target.abs.height / 2;
      await act(async () => {
        fireEvent.mouseDown(target, { dx, dy });
        fireEvent.mouseUp(target, { dx, dy });
      });
    };
    await press('b');
    assert.deepStrictEqual(pressed, [['b', 'go']]);
    await press('off');
    assert.strictEqual(pressed.length, 1, 'a disabled one is not pressed');
  },
);

test("a field set to appearance: none is the page's to draw", async () => {
  // `appearance: none` says a field's native look is off whether or not
  // the page gave it a border or a background — and it is how a design
  // system writes every field it has: meetup.com's search pill holds two
  // with no background, only one of them with a rule, and the other was
  // framed by the theme inside the pill.
  const { node } = await render(
    '<input id="own" style="appearance:none;margin:0;padding:2px 0;' +
      'border:0;background:transparent">' +
      '<input id="plain">',
  );
  const el = view(node);
  const rects = (
    el as unknown as {
      _controls: {
        element: { attribs: Record<string, string> };
        bare?: { height: number } | null;
      }[];
    }
  )._controls;
  const own = rects.find((r) => r.element.attribs.id === 'own')!;
  const plain = rects.find((r) => r.element.attribs.id === 'plain')!;
  assert.ok(own.bare, 'mounted bare');
  assert.strictEqual(
    own.bare.height,
    boxOf(el, 'own').height - 4,
    'inside its padding',
  );
  assert.ok(!plain.bare, "a field left alone keeps the theme's frame");
});

test('a replaced flex item is as wide as the flex layout made it', async () => {
  // Laid out alone a replaced box takes its own `width` or its intrinsic
  // one: two fields `width: 0; flex: 1` were no width at all, and so never
  // mounted, and images `flex: 1` overlapped at their own widths.
  const { node } = await render(
    '<div style="display:flex;width:300px">' +
      '<input id="a" style="width:0;flex:1;margin:0">' +
      '<input id="b" style="width:0;flex:1;margin:0">' +
      '<img id="c" width="50" height="20" style="flex:1">' +
      '</div>',
  );
  const el = view(node);
  const [a, b, c] = ['a', 'b', 'c'].map((id) => boxOf(el, id));
  assert.deepStrictEqual(
    [a.width, b.width, c.width],
    [100, 100, 100],
    'each takes a third',
  );
  assert.deepStrictEqual([a.x, b.x, c.x], [a.x, a.x + 100, a.x + 200]);
});

// --- the seams --------------------------------------------------------------

test('a script is handed over, unparsed and unevaluated', async () => {
  const seen: { type: string; src: string | null; text: string }[] = [];
  await renderX11(
    h(Html, {
      source:
        '<script type="module" src="a.js"></script><script>throw new Error("never run")</script>',
      partial: false,
      onScript: (s: { type: string; src: string | null; text: string }) =>
        seen.push({ type: s.type, src: s.src, text: s.text }),
    }),
    { backend: 'mock' },
  );
  assert.strictEqual(seen.length, 2);
  assert.deepStrictEqual(seen[0], { type: 'module', src: 'a.js', text: '' });
  assert.strictEqual(seen[1].src, null);
  assert.ok(
    seen[1].text.includes('never run'),
    'the text is handed over verbatim',
  );
});

test("cells aligned on the baseline hang their first lines from the row's", async () => {
  // CSS 2.1 17.5.3: a cell's baseline is its first line's, at any depth,
  // and the row's is the lowest of its cells'. An empty cell has none to
  // give, as in a browser, or a cell given a height would hang the rest
  // from its bottom.
  const { node } = await render(
    '<div id="t" style="display:table">' +
      '<div style="display:table-cell;padding-top:40px"><div id="a">a</div></div>' +
      '<div style="display:table-cell"><div id="b">b</div></div>' +
      '<div style="display:table-cell;height:200px"></div></div>',
  );
  const el = view(node);
  const [t, a, b] = ['t', 'a', 'b'].map((id) => boxOf(el, id));
  assert.strictEqual(a.y, t.y + 40, 'the padded cell sets the baseline');
  assert.strictEqual(b.y, a.y, 'and the other hangs from it');
});

test("a table cell takes its row's vertical-align", async () => {
  // HTML's rendering rules make the rows middle and the cells inherit, so
  // `<tr valign="top">`, all over mail, sets its cells at the top
  const { node } = await render(
    '<table><tr id="r1" valign="top"><td style="height:60px">a</td>' +
      '<td><div id="t">b</div></td></tr>' +
      '<tr id="r2"><td style="height:60px">a</td><td><div id="m">b</div></td>' +
      '</tr></table>',
  );
  const el = view(node);
  const [r1, t, r2, m] = ['r1', 't', 'r2', 'm'].map((id) => boxOf(el, id));
  assert.ok(t.y - r1.y < 5, `top: ${t.y - r1.y}`);
  assert.ok(m.y - r2.y > 15, `the next row is still middle: ${m.y - r2.y}`);
});

test('a negative size is no size, and the declaration goes', async () => {
  // CSS 2.1 10.2, 10.4, 10.5, 10.7: -1px was taken as a maximum height
  const { node } = await render(
    '<div id="a" style="height:40px;max-height:-1px"></div>' +
      '<div id="b" style="width:30px;width:-10px;min-height:-5px;height:20px"></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').height, 40);
  const b = boxOf(el, 'b');
  assert.deepStrictEqual([b.width, b.height], [30, 20]);
});

test("a row's background is its cells', and a row group has no borders", async () => {
  // CSS 2.1 17.5.1 and 17.6.1: a row or a row group paints its background
  // in the areas of its cells, so the spacing between them shows the
  // table, and in the separated model it has no borders at all
  const { node } = await render(
    '<table style="border-spacing:10px">' +
      '<tbody style="border:5px solid #00ff00">' +
      '<tr style="background:#ff0000"><td id="a">a</td><td id="b">b</td></tr>' +
      '</tbody></table>',
  );
  const el = view(node);
  const fills = await fillsOf(el);
  const red = fills.filter((f) => f.style === parseColor('#ff0000'));
  const cells = ['a', 'b'].map((id) => boxOf(el, id));
  assert.deepStrictEqual(
    red.map((f) => [f.x, f.y, f.w, f.h]),
    cells.map((c) => [
      Math.round(c.x),
      Math.round(c.y),
      Math.round(c.x + c.width) - Math.round(c.x),
      Math.round(c.y + c.height) - Math.round(c.y),
    ]),
    'one fill a cell, none across the spacing',
  );
  assert.ok(!fills.some((f) => f.style === parseColor('#00ff00')), 'no border');
});

test('an underline reaches the text of what is inside, in its own colour', async () => {
  // CSS 2.1 16.3.1: a decoration is propagated to an element's in-flow
  // descendants, drawn in the colour of the element that set it, so an
  // underlined link's <strong> is underlined; not to a float, an absolute
  // box or the inside of an inline block; and `none` takes none away
  const { node } = await render(
    '<a href="#" style="color:#0000ff"><strong id="s">x</strong></a>' +
      '<div style="text-decoration:underline;color:#ff0000">' +
      '<p id="p" style="color:#0000ff">y<span id="f" style="float:left">z</span>' +
      '<span id="i" style="display:inline-block">w</span>' +
      '<span id="n" style="text-decoration:none">v</span></p></div>' +
      '<u><s id="both">u</s></u>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { underline: string | null; lineThrough: string | null };
      }
    ).style;
  assert.strictEqual(style('s').underline, '#0000ff', "the link's colour");
  assert.strictEqual(style('p').underline, '#ff0000', "the div's colour");
  assert.strictEqual(style('n').underline, '#ff0000', '`none` removes none');
  assert.strictEqual(style('f').underline, null, 'not a float');
  assert.strictEqual(style('i').underline, null, 'nor an inline block');
  assert.ok(style('both').underline && style('both').lineThrough, 'both');
});

test("white space between a table's parts is no cell, kept or not", async () => {
  // CSS 2.1 17.2.1, rule 1: under `white-space: pre` the line breaks
  // between a table's rows made a cell of their own before each
  const { node } = await render(
    '<div id="t" style="display:table;white-space:pre">\n  ' +
      '<div style="display:table-row">\n    ' +
      '<div id="c" style="display:table-cell">x</div>\n  </div>\n</div>',
  );
  const el = view(node);
  const [t, c] = ['t', 'c'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([c.x, c.y], [t.x, t.y], 'the cell is the first');
});

metric('a no-break space beside a block is a line of its own', async () => {
  // CSS's white space is the space, the tab and the line breaks (CSS Text
  // 3, 4.1); `trim` and `\s` take the no-break space in too, so the
  // `&nbsp;` a mail layout holds a gap open with was dropped beside a
  // block as if it held nothing
  const { node } = await render(
    '<style>body{margin:0} div{line-height:20px}</style>' +
      '<div id="d">&nbsp;<div>x</div></div>' +
      '<div id="e"> <div>x</div></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'd').height, 40, 'its line, then the block');
  assert.strictEqual(boxOf(el, 'e').height, 20, 'a space is white space');
});

test("an auto table is as wide as its caption's own width", async () => {
  // CSS 2.1 17.4: the caption's least width is the table's, and one set to
  // a length has that one; measured at no width, an empty caption set to
  // 100px counted nothing, and the table under it was as narrow as its
  // empty cell
  const { node } = await render(
    '<table id="t" style="border-spacing:0"><caption style="width:100px">' +
      '</caption><tr><td style="padding:0"></td></tr></table>',
  );
  assert.strictEqual(boxOf(view(node), 't').width, 100);
});

metric(
  'white space beside what a table wraps in a cell stays in it',
  async () => {
    // CSS 2.1 17.2.1, rule 1: it goes only between two of a table's parts;
    // between two inline boxes in a row it is the anonymous cell's, as it is
    // between two loose ones in a table, and it was dropped from both
    const { node } = await render(
      '<div style="display:table-row"><span id="a">a</span> <span>b</span></div>' +
        '<div style="display:table"><span id="c">a</span> <span>b</span></div>' +
        '<div style="display:table"><div id="ref" style="display:table-cell">' +
        'a b</div></div>',
    );
    const el = view(node);
    const cellOf = (id: string) =>
      (boxOf(el, id) as LaidBox & { parent: LaidBox }).parent;
    const ref = boxOf(el, 'ref').width;
    assert.strictEqual(cellOf('a').width, ref, 'in a row: as wide as "a b"');
    assert.strictEqual(cellOf('c').width, ref, 'loose in a table: the same');
  },
);

test('a float is painted over the backgrounds of the blocks after it', async () => {
  // CSS 2.1 Appendix E: every in-flow block's background, then the floats,
  // then the lines. Painted a block at a time, the shaded paragraph beside
  // a floated image hid the image under its background.
  const { node } = await render(
    '<div style="float:left;width:50px;height:50px;background:#00ff00"></div>' +
      '<p style="margin:0;background:#ff0000">text</p>' +
      '<div style="float:left;width:50px;height:50px;background:#0000ff"></div>',
  );
  const fills = await fillsOf(view(node));
  const at = (colour: string) =>
    fills.findIndex((f) => f.style === parseColor(colour));
  assert.ok(at('#ff0000') >= 0, 'the paragraph has its background');
  assert.ok(at('#00ff00') > at('#ff0000'), 'the float before it goes over it');
  assert.ok(at('#0000ff') > at('#00ff00'), 'and the floats keep their order');
});

test('a box with a formatting context of its own clears every float along its height', async () => {
  // CSS 2.1 9.5: it must not overlap the margin box of any float beside it,
  // which is every float over its height, not only the one at its top. A
  // wider float starting halfway down it was run over.
  const { node } = await render(
    '<div id="f" style="float:left;clear:left;width:50px;height:75px"></div>' +
      '<div style="float:left;clear:left;width:100px;height:75px"></div>' +
      '<div id="a" style="overflow:hidden;width:200px;height:50px"></div>' +
      '<div id="b" style="overflow:hidden;width:200px;height:50px"></div>',
  );
  const el = view(node);
  const [f, a, b] = ['f', 'a', 'b'].map((id) => boxOf(el, id));
  assert.strictEqual(a.x, f.x + 50, 'beside the first float');
  assert.strictEqual(b.x, f.x + 100, 'and beside the second, lower down');
  assert.strictEqual(b.y, a.y + 50);
});

test("a spanning cell's width is shared by its columns, less the spacing", async () => {
  // CSS 2.1 17.5.2.2, steps 1 and 3: its own width is the least it is,
  // and the spacing between its columns is part of it, so a cell over
  // three columns set to 100px, with 20px between them, has 60 to share
  const { node } = await render(
    '<table style="border-spacing:20px"><tr>' +
      '<td id="s" colspan="3" style="width:100px;padding:0"></td></tr></table>',
  );
  assert.strictEqual(boxOf(view(node), 's').width, 100);
});

test('a spanning cell comes after the cells of one column', async () => {
  // in a first row it was shared out evenly before the cells under it
  // were seen, and a column one of them sets to 5px took half of it
  const { node } = await render(
    '<table style="width:110px;border-spacing:0">' +
      '<tr><td colspan="2" style="width:100px;padding:0"></td>' +
      '<td colspan="2" style="padding:0"></td></tr>' +
      '<tr><td id="a" style="width:5px;padding:0"></td>' +
      '<td id="s" colspan="2" style="padding:0"></td>' +
      '<td id="b" style="width:5px;padding:0"></td></tr></table>',
  );
  const el = view(node);
  const [a, s, b] = ['a', 's', 'b'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([a.width, s.width, b.width], [5, 100, 5]);
});

test("a cell's percentage is a share of the table, its borders in it", async () => {
  // added on, a 90% cell and a 10% one came to more than the table,
  // which took it back from both and left them 8.8 to 1
  const { node } = await render(
    '<table style="width:400px;border-collapse:collapse"><tr>' +
      '<td id="a" style="width:90%;border:1px solid;padding:0"></td>' +
      '<td id="b" style="width:10%;border:1px solid;padding:0"></td></tr>' +
      '</table>',
  );
  const el = view(node);
  const [a, b] = ['a', 'b'].map((id) => boxOf(el, id));
  assert.ok(Math.abs(a.width - 9 * b.width) < 0.01, `${a.width} ${b.width}`);
});

metric(
  'a cell set to a narrow percentage is no narrower than its word',
  async () => {
    // a table never goes narrower than its words (CSS 2.1 17.5.2.2): a
    // cell's own width is weighed apart from its content, and the content
    // was measured at the width the probe laid the cell out at, which for
    // one set to a width was its padding, so a 3% column cut its word
    const { node } = await render(
      '<table style="width:320px;border-spacing:0"><tr>' +
        '<td style="width:97%;padding:0">a</td>' +
        '<td id="b" style="width:3%;padding:0">unbreakable</td></tr></table>',
    );
    const el = view(node);
    const b = boxOf(el, 'b') as LaidBox & { lines: { width: number }[] };
    assert.ok(b.width >= b.lines[0].width, `${b.width} ${b.lines[0].width}`);
  },
);

test('a table with a width of its own fills it with its columns', async () => {
  // CSS 2.1 17.5.2.2: the columns not set to a width take what the table
  // has beyond their content, in proportion to it; <table width="600"> drew
  // its cells at their content's width and left the rest empty
  const { node } = await render(
    '<table id="t" width="300" style="border-spacing:0">' +
      '<tr><td id="a" style="padding:0">x</td></tr></table>' +
      '<table width="300" style="border-spacing:0"><tr>' +
      '<td id="b" style="padding:0;width:50px">x</td>' +
      '<td id="c" style="padding:0">x</td></tr></table>' +
      '<table id="u" style="border-spacing:0">' +
      '<tr><td id="d" style="padding:0">x</td></tr></table>',
  );
  const el = view(node);
  const [a, b, c, d, u] = ['a', 'b', 'c', 'd', 'u'].map((id) => boxOf(el, id));
  assert.strictEqual(a.width, 300, 'one column takes it all');
  assert.strictEqual(b.width, 50, 'a column set to a width keeps it');
  assert.strictEqual(c.width, 250, 'and the other takes the rest');
  assert.ok(d.width < 50 && u.width === d.width, 'a table of `auto` shrinks');
});

test('a line of an inline-block clears the floats beside all of its height', async () => {
  // CSS 2.1 9.5: a line box must not run into a float, and an inline-block
  // makes its line as tall as itself. The room was taken for a line of
  // text, so the block ran into a float that started beside its lower part.
  const { node } = await render(
    '<div id="w" style="width:400px">' +
      '<div style="float:left;width:150px;height:75px"></div>' +
      '<div style="float:right;width:300px;height:75px"></div>' +
      '<span id="a" style="display:inline-block;vertical-align:top;' +
      'width:200px;height:50px"></span>' +
      '<span id="b" style="display:inline-block;vertical-align:top;' +
      'width:200px;height:50px"></span></div>',
  );
  const el = view(node);
  const [w, a, b] = ['w', 'a', 'b'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([a.x - w.x, a.y - w.y], [150, 0]);
  assert.deepStrictEqual([b.x - w.x, b.y - w.y], [0, 150], 'below both');
});

test('a line takes its room beside the floats over its own height', async () => {
  // the room was taken over a line of text's, 1.4em, whatever the line
  // held: a 20px inline-block on a line of no height went below floats
  // that start 20px down, rather than beside the one at its top
  const { node } = await render(
    '<div id="w" style="width:100px;font-size:20px;line-height:0">' +
      '<div style="float:right;width:40px;height:20px"></div>' +
      '<div style="float:right;clear:right;width:50px;height:50px"></div>' +
      '<div style="float:left;width:50px;height:50px"></div>' +
      '<span id="s" style="display:inline-block;width:40px;height:20px">' +
      '</span></div>',
  );
  const el = view(node);
  const [w, s] = ['w', 's'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([s.x - w.x, s.y - w.y], [0, 0]);
});

test('a float after one that waits for the next line waits too', async () => {
  // none goes higher than a float before it (CSS 2.1 9.5.1, rule 5): the
  // two after a float too wide for the line went beside the line's text,
  // above it
  const { node } = await render(
    '<div style="width:100px;font-size:5px">H' +
      '<div id="a" style="width:100px;height:100px;float:left"></div>' +
      '<div id="b" style="width:30px;height:30px;float:left"></div>' +
      '<div id="c" style="width:30px;height:30px;float:right"></div></div>',
  );
  const el = view(node);
  const [a, b, c] = ['a', 'b', 'c'].map((id) => boxOf(el, id));
  assert.ok(b.y >= a.y + 100 && c.y >= b.y, `${a.y} ${b.y} ${c.y}`);
});

metric(
  'a float met inside text that may not break keeps that text on one line',
  async () => {
    // no break at the float, so the word before it goes to the next line
    // with the word after it: the line ran past its width, the float below
    const { node } = await render(
      '<style>body{margin:0}#d{font-size:10px;width:12ch;line-height:1}' +
        '#f{float:left;width:12ch;height:1em}</style>' +
        '<div id="d">1111 <nobr>2222 <div id="f"></div> 3333</nobr></div>',
    );
    const el = view(node);
    assert.strictEqual(linesOf(el, 'd').length, 2);
    assert.strictEqual(boxOf(el, 'f').y - boxOf(el, 'd').y, 20);
  },
);

test('a margin after an empty block with clearance stays in the parent', async () => {
  // CSS 2.1 8.3.1, 10.6.3: an empty block cleared past a float spends its
  // own margins on its clearance, and the margins that collapse with it
  // after it do not collapse through the parent's bottom
  const { node } = await render(
    '<div id="a"><div style="float:left;height:1px"></div>' +
      '<div style="clear:left"></div><div style="margin-top:99px"></div></div>' +
      '<div id="b" style="margin-bottom:40px">' +
      '<div style="height:20px;margin-bottom:20px"></div>' +
      '<div style="float:left;height:20px"></div>' +
      '<div style="clear:both;margin:30px 0 20px"></div></div>' +
      '<div id="c"></div>',
  );
  const el = view(node);
  const [a, b, c] = ['a', 'b', 'c'].map((id) => boxOf(el, id));
  assert.strictEqual(a.height, 100, 'the 99px after the cleared block');
  assert.strictEqual(b.height, 60, 'but none of its own');
  assert.strictEqual(c.y, b.y + 60 + 40);
});

test('a cleared block the margin above would take past its float goes under it, up if need be', async () => {
  // where it would be with `clear: none`, its margin collapsed up through
  // its parent's top, is above the float, so it has clearance, and its
  // border edge goes under the float: its own margin, held apart, stood it
  // 48px lower, and its parent as short as nothing (CSS 2.1 9.5.2)
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="float:left;width:50px;height:100px"></div>' +
      '<div style="padding-top:1px"><div id="p">' +
      '<div style="margin-bottom:49px"></div>' +
      '<div id="c" style="clear:left;margin-top:98px"></div></div></div>',
  );
  const el = view(node);
  const [p, c] = ['p', 'c'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([p.y, c.y, p.height], [50, 100, 50]);
});

test("a cleared block's place without clearance counts the margins in it", async () => {
  // a margin deep inside it collapses up through its top and takes it
  // past the floats, so it has no clearance: it was cleared from its own
  // margin alone, and drew itself under the floats (CSS 2.1 9.5.2)
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="float:left;width:50px;height:50px"></div>' +
      '<div style="float:right;width:50px;height:100px"></div>' +
      '<div style="width:100px;height:100px">' +
      '<div style="height:15px;margin-bottom:20px"></div>' +
      '<div id="a"><div id="l" style="clear:left"><div style="clear:right">' +
      '<div style="margin-top:185px"></div></div></div></div></div>',
  );
  const el = view(node);
  assert.deepStrictEqual([boxOf(el, 'a').y, boxOf(el, 'l').y], [200, 200]);
});

test("a block after an empty one cleared past a float starts at the cleared one's edge", async () => {
  // their margins collapse together, the cleared one's top margin among
  // them, which is above its edge: the block after starts at the edge
  // where they come to no more than that margin. It started the cleared
  // one's bottom margin lower (CSS 2.1 8.3.1)
  const { node } = await render(
    '<style>body{margin:0}</style><div id="w">' +
      '<div style="float:left;width:10px;height:64px"></div>' +
      '<div style="clear:left;margin:32px 0"></div>' +
      '<div id="b" style="margin-top:16px;border-top:32px solid"></div></div>',
  );
  const el = view(node);
  assert.deepStrictEqual([boxOf(el, 'b').y, boxOf(el, 'w').height], [64, 96]);
});

test("a table gives up its cells' set widths before its words", async () => {
  // CSS 2.1 17.5.2.2: a table is never narrower than what its content asks,
  // and a width a cell was set to gives way first. Clamped to the room, a
  // table beside a float ran under it; held at its cells' widths, it went
  // below floats it could have sat beside.
  const { node } = await render(
    '<div id="w" style="width:250px">' +
      '<div style="float:right;width:200px;height:50px"></div>' +
      '<table id="t" style="border-spacing:0"><tr>' +
      '<td style="width:100px;height:30px;padding:0"></td></tr></table></div>' +
      '<div id="v" style="width:300px;clear:both">' +
      '<div style="float:left;width:100px;height:100px"></div>' +
      '<table id="u" style="border-spacing:0"><tr><td style="padding:0">' +
      '<span style="display:inline-block;width:250px;height:10px"></span>' +
      '</td></tr></table></div>',
  );
  const el = view(node);
  const [w, t, v, u] = ['w', 't', 'v', 'u'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([t.y - w.y, t.width], [0, 50], 'beside the float');
  assert.deepStrictEqual([u.y - v.y, u.width], [100, 250], 'below it');
});

metric(
  'a column set to a width is that wide, and its text wraps in it',
  async () => {
    // browsers take a set width for the column's, which its content widens
    // only where it cannot break narrower; CSS 2.1's step 2 took it for a
    // floor under the text's widest line, and the column was one line wide
    const { node } = await render(
      '<table style="border-spacing:0"><col><col style="width:80px"><tr>' +
        '<td>a</td><td id="c" style="padding:0">Filler Text Filler Text</td>' +
        '</tr></table><table style="border-spacing:0"><tr><td>b</td>' +
        '<td id="d" style="padding:0;width:60px">Filler Text Filler Text</td>' +
        '</tr></table>',
    );
    const el = view(node);
    assert.deepStrictEqual(
      [boxOf(el, 'c').width, boxOf(el, 'd').width],
      [80, 60],
    );
    assert.ok(linesOf(el, 'c').length > 1, 'its text wraps');
  },
);

metric('a table of no cells is as wide as its caption can be', async () => {
  // not as the room on offer, where the caption was centred
  const { node } = await render(
    '<table id="t"><caption id="c">XXXXXXXXXX</caption></table>',
  );
  const el = view(node);
  const [t, c] = ['t', 'c'].map((id) => boxOf(el, id));
  const [line] = linesOf(el, 'c');
  assert.ok(t.width < 200, `${t.width}`);
  assert.ok(Math.abs(line.x - c.x) < 1, 'its text starts at its start');
});

test('an absolute box a max-width or max-height holds is centred by its auto margins', async () => {
  // CSS 2.1 10.4 and 10.7: with both offsets and an auto size, the box
  // fills what they leave — but a `max-width` or `max-height` that holds
  // it back makes a size like one set, and the rules run again with it,
  // where auto margins share what is left; it stayed at its start edge,
  // and at first did not take the `max-width` at all
  const { node } = await render(
    '<div style="position:relative;width:300px;height:200px">' +
      '<div id="a" style="position:absolute;left:0;right:0;top:0;bottom:0;' +
      'margin:auto;max-width:100px;max-height:50px"></div></div>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  const parent = (a as LaidBox & { parent: LaidBox }).parent;
  assert.deepStrictEqual(
    [a.width, a.height, a.x - parent.x, a.y - parent.y],
    [100, 50, 100, 75],
  );
});

test('a float or an absolute box inside an inline box is laid out', async () => {
  // An inline box lays out nothing of its own, and the block's walk met
  // only its own children: a float in a padded <span>, or a badge set
  // absolute inside a link, stood at the page's corner with no size.
  const { node } = await render(
    '<p id="p">text <span style="padding:30px;margin:40px">' +
      '<span id="f" style="float:left;width:40px;height:40px"></span>' +
      '<b id="a" style="position:absolute;width:20px;height:20px"></b>' +
      '</span></p>',
  );
  const el = view(node);
  const [p, f, a] = ['p', 'f', 'a'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([f.x, f.y, f.width, f.height], [p.x, p.y, 40, 40]);
  assert.deepStrictEqual([a.width, a.height], [20, 20]);
  assert.strictEqual(a.y, p.y, 'at its static position');
});

/** Blocks of set widths, run together, so a line holds what the widths
 *  say whatever the font: `[200, 'f', 40]` is two inline-blocks and the
 *  float `#f` between them. */
function floatLine(float: string, parts: (number | 'f')[]): string {
  let n = 0;
  return parts
    .map((part) =>
      part === 'f'
        ? `<span id="f" style="${float}"></span>`
        : `<span id="i${n++}" style="display:inline-block;` +
          `width:${part}px;height:10px"></span>`,
    )
    .join('');
}

test('a float met in a line goes at the top of that line', async () => {
  // CSS 2.1 9.5.1: a float goes no higher than the top of the line its
  // anchor is on, and where it fits beside what the line holds it goes at
  // that top, the line's content moving over for it. Every float in a
  // paragraph went at the paragraph's top, before its first line.
  for (const side of ['left', 'right']) {
    const { node } = await render(
      `<div id="w" style="width:300px">` +
        floatLine(`float:${side};width:50px;height:30px`, [200, 200, 'f', 40]) +
        '</div>',
    );
    const el = view(node);
    const [w, f, i1, i2] = ['w', 'f', 'i1', 'i2'].map((id) => boxOf(el, id));
    const lines = linesOf(el, 'w');
    assert.strictEqual(lines.length, 2, side);
    assert.strictEqual(f.y, lines[1].y, `${side}: at the second line's top`);
    assert.ok(f.y > w.y, side);
    const moved = side === 'left' ? 50 : 0;
    assert.strictEqual(f.x - w.x, side === 'left' ? 0 : 250, side);
    assert.strictEqual(i1.x - w.x, moved, `${side}: the line moves over`);
    assert.strictEqual(i2.x - w.x, moved + 200, `${side}: and goes on`);
    assert.strictEqual(i2.y, i1.y, side);
    cleanup();
  }
});

test('a float too wide for what is left of its line goes under it', async () => {
  // the rest of the line's content stays on the line, and the float is
  // placed as the line closes, at the top of the next
  const { node } = await render(
    `<div id="w" style="width:300px">` +
      floatLine('float:left;width:150px;height:30px', [200, 200, 'f', 40, 90]) +
      '</div>',
  );
  const el = view(node);
  const [w, f, i1, i2, i3] = ['w', 'f', 'i1', 'i2', 'i3'].map((id) =>
    boxOf(el, id),
  );
  const lines = linesOf(el, 'w');
  assert.strictEqual(f.y, lines[1].y + lines[1].height, 'under the line');
  assert.strictEqual(f.x, w.x);
  assert.deepStrictEqual([i1.x - w.x, i2.x - w.x], [0, 200], 'unmoved');
  assert.strictEqual(i2.y, i1.y, 'what follows it stays on the line');
  assert.strictEqual(i3.x - w.x, 150, 'and the next line is beside it');
});

test('a float the line cannot break at fits with what follows it', async () => {
  // float-nowrap: in text that does not wrap, what follows the float is on
  // its line whatever the room, so the float goes beside the line only
  // where that fits too, and under it where it does not — as browsers
  // place it. It went at the top where it fitted beside the text before it,
  // under the text that ran on past it.
  const para = (wrap: string) =>
    `<p id="p${wrap}" style="margin:0;width:300px;white-space:${wrap};` +
    'clear:both">' +
    'Some <span id="f' +
    wrap +
    '" style="float:right;width:150px;height:20px"></span>' +
    'text that runs on past the end of its box</p>';
  const { node } = await render(para('nowrap') + para('normal'));
  const el = view(node);
  const lines = linesOf(el, 'pnowrap');
  assert.strictEqual(lines.length, 1);
  const f = boxOf(el, 'fnowrap');
  assert.strictEqual(f.y, lines[0].y + lines[0].height, 'under the line');
  // where the line may break after "Some", the float goes at its top
  assert.strictEqual(boxOf(el, 'fnormal').y, linesOf(el, 'pnormal')[0].y);
});

test('a float goes no higher than the float before it', async () => {
  // CSS 2.1 9.5.1, rule 5: the third float fits in the room beside the
  // first, which the second went under, and still goes no higher than the
  // second's top
  const { node } = await render(
    '<div id="w" style="width:300px">' +
      '<div id="a" style="float:left;width:200px;height:50px"></div>' +
      '<div id="b" style="float:left;width:150px;height:20px"></div>' +
      '<div id="c" style="float:left;width:50px;height:20px"></div></div>',
  );
  const el = view(node);
  const [w, b, c] = ['w', 'b', 'c'].map((id) => boxOf(el, id));
  assert.strictEqual(b.y - w.y, 50, 'under the first');
  assert.strictEqual(c.y, b.y, 'no higher than the second');
  assert.strictEqual(c.x - w.x, 150, 'beside it');
});

test('a float wider than its block stands beside a float on the other side', async () => {
  // CSS 2.1 9.5.1: a left float may not reach past a right float beside it
  // (rule 3), and past its containing block only where a left float stands
  // beside it too (rule 7). Held to its block always, a float wider than
  // its block went below every float beside it.
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="float:left;width:500px;height:200px">' +
      '<div style="float:right;width:50px;height:100px"></div>' +
      '<div style="margin-right:100px"><div id="a" style="float:left;' +
      'width:425px;height:10px"></div></div></div>' +
      '<div style="clear:both;width:200px">' +
      '<div style="float:left;width:50px;height:30px"></div>' +
      '<div id="b" style="float:left;width:175px;height:10px"></div></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').y, 0, 'beside the right float');
  const b = boxOf(el, 'b');
  assert.ok(b.y >= 230, `below the left float, in its block: ${b.y}`);
});

test('a new formatting context beside a float takes no negative margin past its block', async () => {
  // where a float narrows the room, as every engine has it; with none
  // there, a negative margin still takes the box out
  const { node } = await render(
    '<style>body{margin:0 0 0 50px}</style><div style="width:125px">' +
      '<div style="float:left;width:0;height:50px"></div>' +
      '<div style="float:right;clear:left;width:25px;height:50px"></div>' +
      '<div id="a" style="overflow:hidden;margin-left:-50px;height:100px">' +
      '</div></div><div style="width:100px">' +
      '<div id="b" style="overflow:hidden;margin-left:-50px;height:10px">' +
      '</div></div>',
  );
  const el = view(node);
  const [a, b] = ['a', 'b'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([a.x, a.width, b.x, b.width], [50, 100, 0, 150]);
});

test('a new formatting context a negative margin takes up meets the float below its top', async () => {
  // its border box is what may not overlap a float, from its top down:
  // taken as tall as its margins, less the one taking it up, it missed
  // the float it overlapped
  const { node } = await render(
    '<style>body{margin:0}.w{display:flow-root;width:100px;margin-top:75px}' +
      '.f{float:left;width:50px;height:50px}' +
      '.b{overflow:hidden;height:50px;margin-top:-25px}</style>' +
      '<div class="w" id="w1"><div class="f"></div>' +
      '<div class="b" id="a" style="width:50px"></div></div>' +
      '<div class="w" id="w2"><div class="f"></div>' +
      '<div class="b" id="b" style="width:75px"></div></div>',
  );
  const el = view(node);
  const [w1, a, w2, b] = ['w1', 'a', 'w2', 'b'].map((id) => boxOf(el, id));
  assert.deepStrictEqual([a.x - w1.x, a.y - w1.y], [50, -25], 'beside it');
  assert.deepStrictEqual([b.x - w2.x, b.y - w2.y], [0, 50], 'under it');
});

test('a box as wide as its content measures its floats side by side', async () => {
  // A float, an inline-block and a table cell are as wide as their content
  // at its widest, and floats stand side by side there, beside the line
  // they are met on. Taken for the widest of them, a floated menu's items
  // went one under another, text beside a floated image wrapped, and a
  // float holding a linked, floated logo was no width at all.
  const { node } = await render(
    '<div id="menu" style="float:left">' +
      '<div id="m1" style="float:left;width:60px;height:20px"></div>' +
      '<div id="m2" style="float:left;width:80px;height:20px"></div>' +
      '<div id="m3" style="float:right;width:40px;height:20px"></div>' +
      '</div>' +
      '<div id="card" style="clear:both;display:inline-block">' +
      '<span style="float:left;width:50px;height:20px"></span>' +
      '<span id="t" style="display:inline-block;width:90px;height:10px">' +
      '</span></div>' +
      '<div id="logo" style="float:left"><a href="#">' +
      '<span style="float:left;width:70px;height:20px"></span></a></div>' +
      '<div id="cleared" style="clear:both;float:left">' +
      '<div style="float:left;width:60px;height:20px"></div>' +
      '<div style="float:left;clear:left;width:80px;height:20px"></div></div>',
    600,
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  assert.strictEqual(box('menu').width, 180, 'a menu holds its items');
  assert.strictEqual(box('m2').y, box('m1').y, 'side by side');
  assert.strictEqual(box('m3').y, box('m1').y, 'on both sides');
  assert.strictEqual(box('card').width, 140, 'the text beside its image');
  assert.strictEqual(box('logo').width, 70, 'a logo in a link');
  assert.strictEqual(box('cleared').width, 80, 'one under the other');
});

test('a box as narrow as its content is no narrower than a float in it', async () => {
  // and no wider than its widest float or word: the float's line breaks
  // under it where the two do not fit side by side
  const { node } = await render(
    '<table style="width:300px;border-spacing:0"><tr>' +
      '<td id="c" style="padding:0">' +
      '<span style="float:left;width:30px;height:20px"></span>' +
      '<span style="display:inline-block;width:70px;height:10px"></span>' +
      '</td><td style="width:100%;padding:0"></td></tr></table>',
  );
  assert.strictEqual(boxOf(view(node), 'c').width, 70);
});

test('a word with too little room left on its line goes to the next, whole', async () => {
  // Text laid out after something else on its line — an inline-block, or a
  // float it was cut at — has the room that is left, and a word wider than
  // that room was broken inside itself to fit it: its first letter at the
  // line's end, the rest on the next.
  // Room for a letter, where the engine cuts the word after it, and for
  // none, where it runs the whole word past the line's end: both ways.
  for (const filled of [290, 298]) {
    for (const between of [
      '',
      '<span style="float:left;width:50px;height:30px"></span>',
    ]) {
      const { node } = await render(
        '<div id="w" style="width:300px;font:16px/20px sans-serif">' +
          `<span style="display:inline-block;width:${filled}px;height:10px">` +
          `</span>${between}goes on</div>`,
      );
      const lines = linesOf(view(node), 'w');
      const which = `${300 - filled}px left, after ${between ? 'a float' : 'an inline-block'}`;
      assert.strictEqual(lines.length, 2, which);
      assert.strictEqual(lines[0].texts.length, 0, `${which}: none of it`);
      cleanup();
    }
  }
  // and where the block does not wrap, nothing goes to another line
  const { node } = await render(
    '<div id="w" style="width:300px;white-space:nowrap">' +
      '<span style="display:inline-block;width:290px;height:10px"></span>' +
      '<span style="float:left;width:50px;height:30px"></span> goes on</div>',
  );
  assert.strictEqual(linesOf(view(node), 'w').length, 1, 'nowrap');
});

test('a float in a line is placed once where ::first-line lays the lines out twice', async () => {
  const html = (sheet: string) =>
    `<style>${sheet}</style><div id="w" style="width:300px">` +
    floatLine('float:left;width:50px;height:30px', [200, 200, 'f', 40]) +
    '</div>';
  const place = async (sheet: string) => {
    const { node } = await render(html(sheet));
    const el = view(node);
    const out = ['f', 'i1', 'i2'].map((id) => {
      const b = boxOf(el, id);
      return [b.x, b.y];
    });
    cleanup();
    return out;
  };
  assert.deepStrictEqual(
    await place('#w::first-line { color: red }'),
    await place(''),
  );
});

test('a floated image, ::before or first letter in an inline box is laid out', async () => {
  // Found by the same walk into inline boxes, which a document with no
  // float or positioned box in one does not take — so each is alone in its
  // document here
  const image = view(
    (
      await render(
        '<p id="p">text <span>' +
          '<img id="i" style="float:left;width:40px;height:40px"></span></p>',
      )
    ).node,
  );
  const [p, i] = ['p', 'i'].map((id) => boxOf(image, id));
  assert.deepStrictEqual([i.x, i.y, i.width, i.height], [p.x, p.y, 40, 40]);
  cleanup();

  const pseudo = view(
    (
      await render(
        '<style>#g::before{content:"";float:left;width:30px;height:30px}' +
          '</style><p id="p">text <span id="g">g</span></p>',
      )
    ).node,
  );
  const [p2, g] = ['p', 'g'].map((id) => boxOf(pseudo, id));
  const before = g.children.find(
    (c) => (c as unknown as { pseudo?: string }).pseudo === 'before',
  );
  assert.ok(before, 'the ::before has a box');
  assert.deepStrictEqual(
    [before.x, before.y, before.width, before.height],
    [p2.x, p2.y, 30, 30],
  );
  cleanup();

  const letters = view(
    (
      await render(
        '<style>#q::first-letter{float:left;font-size:40px}</style>' +
          '<p id="q"><span>Letter</span></p>',
      )
    ).node,
  );
  const q = boxOf(letters, 'q');
  const letter = q.children[0].children.find(
    (c) => (c as unknown as { pseudo?: string }).pseudo === 'first-letter',
  );
  assert.ok(letter, 'the first letter has a box');
  assert.deepStrictEqual([letter.x, letter.y], [q.x, q.y]);
  assert.ok(letter.width > 0, 'and a size');
});

test('background-attachment is read, in its longhand and the shorthand', async () => {
  // `fixed` positions the image against the viewport, the element, rather
  // than the box (CSS 2.1 14.2.1); the shorthand sets it back to `scroll`
  const { node } = await render(
    '<div id="a" style="background-attachment:fixed"></div>' +
      '<div id="b" style="background:url(x.png) fixed repeat-x"></div>' +
      '<div id="c" style="background-attachment:fixed;background:red"></div>',
  );
  const el = view(node);
  const of = (id: string) =>
    (boxOf(el, id) as unknown as { style: { backgroundAttachment: string } })
      .style.backgroundAttachment;
  assert.deepStrictEqual(['a', 'b', 'c'].map(of), ['fixed', 'fixed', 'scroll']);
});

test('nothing loads without onResource, and every reference is offered to it', async () => {
  const asked: string[] = [];
  await renderX11(
    h(Html, {
      source:
        '<link rel="stylesheet" href="a.css"><img src="b.png"><p>text</p>',
      partial: false,
      onResource: (r: { url: string }) => {
        asked.push(r.url);
        return null;
      },
    }),
    { backend: 'mock' },
  );
  assert.deepStrictEqual(asked.sort(), ['a.css', 'b.png']);
});

test('a stylesheet handed back by the seam reaches the cascade', async () => {
  const result = await renderX11(
    h(
      'box',
      { style: { width: 300, flexDirection: 'column' } },
      h(Html, {
        source: '<link rel="stylesheet" href="a.css"><p>text</p>',
        partial: false,
        onResource: (r: { url: string; kind: string }) =>
          r.kind === 'stylesheet'
            ? { kind: 'stylesheet' as const, text: 'p { color: #ff0000 }' }
            : null,
        'data-testname': 'doc',
      }),
    ),
    { backend: 'mock' },
  );
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const tree = (
    el as unknown as {
      _tree: { root: { children: { style: { color: string } }[] } };
    }
  )._tree;
  assert.strictEqual(tree.root.children[0].style.color, '#ff0000');
  void result;
});

test('text-decoration with a word it does not know is ignored, and draws every line it names', async () => {
  // CSS 2.1 4.2: the whole declaration goes, not the words after it
  const { node } = await render(
    '<p id="a" style="text-decoration: underline line-through diagonal">a</p>' +
      '<p id="b" style="text-decoration: underline line-through">b</p>',
  );
  const el = view(node);
  const styleOf = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { underline: string | null; lineThrough: string | null };
      }
    ).style;
  assert.strictEqual(styleOf('a').underline, null);
  assert.strictEqual(styleOf('a').lineThrough, null);
  assert.ok(styleOf('b').underline && styleOf('b').lineThrough, 'both lines');
});

test('a form control or a frame keeps its height when only its width is set', async () => {
  // Only an image has an intrinsic ratio (CSS 2.1 10.3.2). A control's size
  // and a frame's 300 by 150 are defaults, and a text field set to
  // `width: 100%` came out twice its height.
  const { node } = await render(
    '<input id="a"><input id="b" style="width:300px">' +
      '<button id="c">Go</button><button id="d" style="width:200px">Go</button>' +
      '<iframe id="e"></iframe><iframe id="f" style="height:96px"></iframe>',
  );
  const el = view(node);
  const [a, b, c, d, e, f] = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
    boxOf(el, id),
  );
  assert.strictEqual(b.height, a.height, 'a text field');
  assert.strictEqual(d.height, c.height, 'a button');
  assert.strictEqual(f.width, e.width, 'a frame 96px tall is as wide');
});

test('a stylesheet handed over as bytes is decoded as CSS says', () => {
  // CSS 2.1 4.4 and CSS Syntax 3 3.2, in order: a byte order mark, the
  // protocol's charset, an `@charset` at the very start — UTF-16 named in
  // ASCII meaning UTF-8 — the referrer's encodings, then UTF-8. An é is E9
  // in windows-1252 and C3 A9 in UTF-8.
  const bytes = (text: string, ...tail: number[]): Uint8Array =>
    new Uint8Array([...text].map((c) => c.charCodeAt(0)).concat(tail));
  const decode = (b: Uint8Array, charset?: string, ...fallbacks: string[]) =>
    decodeStylesheet(b, charset, fallbacks);
  assert.deepStrictEqual(
    decode(bytes('', 0xef, 0xbb, 0xbf, 0xc3, 0xa9), 'windows-1252'),
    { text: 'é', encoding: 'utf-8' },
    'the byte order mark first, and it is not text',
  );
  assert.strictEqual(
    decode(bytes('@charset "shift_jis";', 0xe9), 'windows-1252').text,
    '@charset "shift_jis";é',
    "then the protocol's",
  );
  assert.strictEqual(
    decode(bytes('@charset "windows-1252";', 0xe9), undefined, 'shift_jis')
      .encoding,
    'windows-1252',
    "then the rule, over the referrer's",
  );
  assert.strictEqual(
    decode(bytes('@charset "utf-16le";', 0xc3, 0xa9)).encoding,
    'utf-8',
  );
  assert.strictEqual(
    decode(bytes(' @charset "windows-1252";', 0xc3, 0xa9)).encoding,
    'utf-8',
    'only at the very start',
  );
  assert.strictEqual(
    decode(bytes('', 0xe9), undefined, 'no-such-encoding', 'windows-1252').text,
    'é',
    'a name that names no encoding is passed over',
  );
  assert.deepStrictEqual(decode(bytes('', 0xc3, 0xa9)), {
    text: 'é',
    encoding: 'utf-8',
  });
});

test("a stylesheet in bytes falls back to its referrer's encoding", async () => {
  // `.é { … }` in windows-1252: read as UTF-8, a selector nothing matches
  const sheet = new Uint8Array([
    0x2e,
    0xe9,
    ...[...' { color: #00ff00 }'].map((c) => c.charCodeAt(0)),
  ]);
  const colorOf = async (source: string, charset?: string) => {
    await renderX11(
      h(
        'box',
        { style: { width: 300, flexDirection: 'column' } },
        h(Html, {
          source: `${source}<p id="p" class="é">text</p>`,
          charset,
          partial: false,
          onResource: (r: { kind: string }) =>
            r.kind === 'stylesheet'
              ? { kind: 'stylesheet' as const, bytes: sheet }
              : null,
          'data-testname': 'doc',
        }),
      ),
      { backend: 'mock' },
    );
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const p = boxOf(el, 'p') as unknown as { style: { color: string } };
    cleanup();
    return p.style.color;
  };
  const link = '<link rel="stylesheet" href="a.css">';
  assert.notStrictEqual(await colorOf(link), '#00ff00', 'UTF-8 by default');
  assert.strictEqual(await colorOf(link, 'windows-1252'), '#00ff00');
  assert.strictEqual(
    await colorOf(
      '<link rel="stylesheet" charset="windows-1252" href="a.css">',
    ),
    '#00ff00',
    'a <link charset> goes before the document',
  );
  assert.strictEqual(
    await colorOf('<style>@import "b.css";</style>', 'windows-1252'),
    '#00ff00',
    'an import is in the encoding of the sheet importing it',
  );
});

test("an imported stylesheet's rules come before its importer's", async () => {
  // CSS 2.1 6.4.1: an import stands where its `@import` does, so the sheet
  // importing it wins a tie. It was parsed after the sheet, and won.
  await renderX11(
    h(
      'box',
      { style: { width: 300, flexDirection: 'column' } },
      h(Html, {
        source:
          '<style>@import "a.css"; p { color: #00ff00 }</style><p id="p">x</p>',
        partial: false,
        onResource: (r: { kind: string }) =>
          r.kind === 'stylesheet'
            ? { kind: 'stylesheet' as const, text: 'p { color: #ff0000 }' }
            : null,
        'data-testname': 'doc',
      }),
    ),
    { backend: 'mock' },
  );
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const p = boxOf(el, 'p') as unknown as { style: { color: string } };
  assert.strictEqual(p.style.color, '#00ff00');
});

test('an image handed over as bytes is decoded and drawn', async (t) => {
  // `decodeImage` is a named export of react-x11/ntk; read off the default
  // one it was undefined, and every image a host returned as bytes drew as
  // an empty frame. A red square, then: its middle is red or it is not.
  if (!FONTS) return t.skip('no font files for the in-process server');
  // a 10x10 PNG, solid #ff0000
  const bytes = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAIUlEQVR4AX3BAQEAAAiDMKR/' +
        '59uA7UaRJEmSJEmSJEmS9EEsAROhAw00AAAAAElFTkSuQmCC',
      'base64',
    ),
  );
  const result = await renderX11(
    h(
      'box',
      { style: { width: 200, flexDirection: 'column' } },
      h(Html, {
        source: '<img src="red.png" style="display: block">',
        partial: false,
        onResource: (r: { kind: string }) =>
          r.kind === 'image' ? { kind: 'image' as const, bytes } : null,
      }),
    ),
    { width: 240, height: 100, fonts: FONTS },
  );
  // the body's 8px margin, and the middle of the square
  await expectPixel(result.ctx, 13, 13, '#ff0000', {
    message: 'the decoded image is drawn',
  });
});

test('an element at no opacity is not drawn, and at half is drawn faded', async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  // `opacity` was read and never painted, so the control a page keeps at
  // `opacity: 0` until its row is hovered — meetup.com's "Homepage" behind
  // its logo, the share button on each event card — was drawn over what it
  // hides. At 0 nothing in the element is drawn, a positioned child
  // included; between, each thing drawn is multiplied by it.
  const result = await renderX11(
    h(
      'box',
      { style: { width: 200, flexDirection: 'column' } },
      h(Html, {
        source:
          '<body style="margin:0;background:#ffffff">' +
          '<div style="opacity:0;height:20px;background:#ff0000">' +
          '<div style="position:absolute;left:40px;top:0;width:20px;' +
          'height:20px;background:#0000ff"></div></div>' +
          '<div style="opacity:0.5;height:20px;background:#ff0000"></div>' +
          '</body>',
        partial: false,
      }),
    ),
    { width: 240, height: 100, fonts: FONTS },
  );
  await expectPixel(result.ctx, 10, 10, '#ffffff', {
    message: 'the transparent block is not drawn',
  });
  await expectPixel(result.ctx, 50, 10, '#ffffff', {
    message: 'nor its positioned child',
  });
  await expectPixel(result.ctx, 10, 30, '#ff8080', {
    tolerance: 3,
    message: 'the half-opaque block is its colour at half over the page',
  });
});

test('a block inside an inline element is faded with it', async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  // CSS 2.1 9.2.1.1: the block breaks the inline box in pieces and stands
  // outside it, and is still its content, which the inline box's opacity
  // fades as a group (WPT's stacking-context/opacity-affects-block-in-inline).
  // Around two inline boxes, it takes both.
  const result = await renderX11(
    h(
      'box',
      { style: { width: 200, flexDirection: 'column' } },
      h(Html, {
        source:
          '<body style="margin:0;background:#ffffff">' +
          '<span style="opacity:0.5"><div style="height:20px;' +
          'background:#ff0000"></div></span>' +
          '<span style="opacity:0.5"><b style="opacity:0.5">' +
          '<div style="height:20px;background:#ff0000"></div></b></span>' +
          '</body>',
        partial: false,
      }),
    ),
    { width: 240, height: 100, fonts: FONTS },
  );
  await expectPixel(result.ctx, 10, 10, '#ff8080', {
    tolerance: 3,
    message: 'the block is its colour at half over the page',
  });
  await expectPixel(result.ctx, 10, 30, '#ffc0c0', {
    tolerance: 3,
    message: 'and at a quarter inside two such boxes',
  });
});

// a 10x10 PNG, solid #ff0000
const RED_PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAIUlEQVR4AX3BAQEAAAiDMKR/' +
      '59uA7UaRJEmSJEmSJEmS9EEsAROhAw00AAAAAElFTkSuQmCC',
    'base64',
  ),
);

async function renderWithImages(source: string, width = 200) {
  const result = await renderX11(
    h(
      'box',
      { style: { width, height: 120, flexDirection: 'column' } },
      h(Html, {
        source,
        partial: false,
        style: { flexGrow: 1 },
        onResource: (r: { kind: string }) =>
          r.kind === 'image'
            ? { kind: 'image' as const, bytes: RED_PNG }
            : null,
      }),
    ),
    { width: width + 40, height: 160, fonts: FONTS! },
  );
  return result.ctx;
}

metric(
  'a background image is placed, repeated and clipped as CSS says',
  async () => {
    // Parsed and never drawn: background-image had no request and no paint.
    const ctx = await renderWithImages(
      '<style>body{margin:0}div{width:60px;height:30px;' +
        'background:#00ff00 url(red.png) no-repeat 20px 10px}' +
        '.x{background-repeat:repeat-x;background-position:0 0}</style>' +
        '<div></div><div class="x"></div>',
    );
    await expectPixel(ctx, 25, 15, '#ff0000', {
      message: 'the tile, at 20,10',
    });
    await expectPixel(ctx, 5, 5, '#00ff00', {
      message: 'the colour around it',
    });
    await expectPixel(ctx, 45, 15, '#00ff00', {
      message: 'no-repeat: one tile',
    });
    // repeat-x: a row of tiles across the second box, and nothing under them
    await expectPixel(ctx, 55, 35, '#ff0000', { message: 'repeated across' });
    await expectPixel(ctx, 55, 50, '#00ff00', { message: 'one row only' });
  },
);

metric("the root's background covers the whole canvas", async () => {
  // CSS 2.1 14.2: <body>'s background, where <html> has none, is the
  // canvas's — the margin round the body included — as an email's
  // <body bgcolor> is meant to be.
  const ctx = await renderWithImages(
    '<html><body style="background:#00ff00;margin:20px"><p>x</p></body></html>',
  );
  await expectPixel(ctx, 4, 4, '#00ff00', {
    message: 'inside the body margin',
  });
  await expectPixel(ctx, 100, 110, '#00ff00', {
    message: 'below the document, where the element has grown',
  });
});

test('a document with no seams renders anyway', async () => {
  const { node } = await render(
    '<img src="nope.png" alt="x"><p>still here</p>',
  );
  assert.ok(view(node).textContent().includes('still here'));
});

// --- the display scale -------------------------------------------------------
//
// react-x11 hands a registered element two units (its docs/scale.md): `abs`,
// the paint context and every box the engine lays out are device pixels,
// while a synthetic event's `x`/`y` and every style length are logical. At
// 1x — every other test in this file — the two coincide, which is how a view
// that compared `ev.x` with `abs` and laid a `16px` out as sixteen device
// pixels passed all of it. These run at 2x, with the document offset in its
// window so that a device origin and a logical one differ — with `abs` at
// (0, 0) the mistake being pinned cancels out.

/** The harness at a display scale of 2 (react-x11's docs/scale.md): the
 *  headless server resolves to exactly 1 on its own, which is why every
 *  other test here can read its numbers literally. */
function atScale2(over: RenderX11Options): RenderX11Options {
  return { ...over, scale: 2 };
}

async function render2x(
  source: string,
  width = 300,
  props: Record<string, unknown> = {},
): Promise<{ result: Awaited<ReturnType<typeof renderX11>>; node: DrawnNode }> {
  const result = await renderX11(
    h(
      'box',
      { style: { width: width + 40, padding: 20, flexDirection: 'column' } },
      h(Html, {
        source,
        partial: false,
        'data-testname': 'doc',
        ...props,
      }),
    ),
    atScale2({ width: width + 80, height: 300, fonts: FONTS! }),
  );
  return { result, node: screen.getByTestName('doc') as DrawnNode };
}

interface LaidBox {
  el: { attribs: Record<string, string> } | null;
  x: number;
  y: number;
  width: number;
  height: number;
  children: LaidBox[];
}

/** The box the engine laid an element out in — device pixels, document
 *  coordinates. */
function boxOf(el: HtmlViewNode, id: string): LaidBox {
  const root = (el as unknown as { _tree: { root: LaidBox } })._tree.root;
  const find = (box: LaidBox): LaidBox | null => {
    if (box.el?.attribs.id === id) return box;
    for (const child of box.children) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  const found = find(root);
  assert.ok(found, `#${id} has a box`);
  return found;
}

test('background-size is in CSS pixels at 2x', async () => {
  // a length and a percentage are device pixels by the time they are
  // stored, and an image's own size is CSS pixels until it is drawn
  const { node } = await render2x(
    '<style>body{margin:0}div{width:100px;height:100px;' +
      'background:url(x.png) no-repeat}</style>' +
      '<div style="background-size:20px 10px"></div>' +
      '<div style="background-size:contain"></div>' +
      '<div style="background-size:auto 15px"></div>' +
      '<div style="background-size:50%"></div>',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    scale: 2,
    backgroundImageFor: () => ({ image: {}, width: 20, height: 10, ratio: 2 }),
  });
  assert.deepStrictEqual(
    ops.flatMap((op) => (op.op === 'image' ? [[op.w, op.h]] : [])),
    [
      [40, 20],
      [200, 100],
      [60, 30],
      [100, 50],
    ],
  );
});

metric(
  'at a display scale of 2 the document lays out in CSS pixels, on the device grid',
  async () => {
    const { result, node } = await render2x(
      '<style>body{margin:0}div{width:100px;height:50px;margin:0}' +
        '#a{background:#ff0000}#b{background:#0000ff}</style>' +
        '<div id="a"></div><div id="b"></div>',
    );
    const el = view(node);
    const { abs } = el as unknown as DrawnNode;
    assert.strictEqual(
      abs.x,
      40,
      'a 20-logical-pixel padding is 40 device pixels, and `abs` is device',
    );
    const a = boxOf(el, 'a');
    const b = boxOf(el, 'b');
    assert.deepStrictEqual(
      { width: a.width, height: a.height, by: b.y },
      { width: 200, height: 100, by: 100 },
      'a 100×50 CSS box is 200×100 device pixels, and the next block starts below it',
    );
    assert.strictEqual(
      abs.height,
      200,
      'the element measures to the device document',
    );
    await waitFor(() =>
      expectPixel(result.ctx, abs.x + 190, abs.y + 90, '#ff0000', {
        message: 'the box is painted at its device size',
      }),
    );
    await expectPixel(result.ctx, abs.x + 190, abs.y + 110, '#0000ff', {
      message: 'and the next one where it ends',
    });
    assert.ok(
      !isNear(await pixelAt(result.ctx, abs.x + 210, abs.y + 90), '#ff0000'),
      'nothing of it past 100 CSS pixels',
    );

    // The point queries take the logical point a mouse event carries.
    const centre = (box: LaidBox): [number, number] => [
      (abs.x + box.x + box.width / 2) / 2,
      (abs.y + box.y + box.height / 2) / 2,
    ];
    assert.strictEqual(el.elementAtPoint(...centre(b))?.attribs.id, 'b');
    assert.strictEqual(el.elementAtPoint(...centre(a))?.attribs.id, 'a');
  },
);

metric(
  'at a display scale of 2 the pointer hovers the element under it',
  async () => {
    const { result, node } = await render2x(
      '<style>body{margin:0}p{margin:0;height:40px}p:hover{background:#ff0000}</style>' +
        '<p id="a">one</p><p id="b">two</p>',
    );
    const el = view(node);
    const { abs } = el as unknown as DrawnNode;
    const a = boxOf(el, 'a');
    const b = boxOf(el, 'b');
    // Sampled inside each paragraph's box, past the end of its text.
    const sample = (box: LaidBox): [number, number] => [
      abs.x + box.x + box.width - 8,
      abs.y + box.y + box.height / 2,
    ];
    await act();
    assert.ok(
      !isNear(await pixelAt(result.ctx, ...sample(b)), '#ff0000'),
      'nothing is hovered before the pointer arrives',
    );

    // The pointer to the centre of #b: a device offset from the element's
    // device centre. Read as a device point, the logical one core hands the
    // element lands on #a.
    fireEvent.mouseMove(el as unknown as DrawnNode, {
      dx: b.x + b.width / 2 - abs.width / 2,
      dy: b.y + b.height / 2 - abs.height / 2,
    });
    await waitFor(() =>
      expectPixel(result.ctx, ...sample(b), '#ff0000', {
        message: '#b lights up under the pointer',
      }),
    );
    assert.ok(
      !isNear(await pixelAt(result.ctx, ...sample(a)), '#ff0000'),
      'and #a does not',
    );
  },
);

metric(
  'at a display scale of 2 a form control is mounted on the box the document reserved',
  async () => {
    const { node } = await render2x('<p>Agree <input type="checkbox"></p>');
    const el = view(node);
    await act();
    const { abs } = el as unknown as DrawnNode;
    const reserved = (el as unknown as { _tree: { controls: LaidBox[] } })._tree
      .controls[0];
    assert.ok(reserved, 'the document reserved a box');
    const widget = screen.getByRole('checkbox');
    // The rect is reported in logical pixels — it becomes the widget's style —
    // so the real widget lands on the device box. Reported in device pixels
    // it sat twice as far from the origin, and twice as big.
    assert.ok(
      Math.abs(widget.abs.x - (abs.x + reserved.x)) <= 2 &&
        Math.abs(widget.abs.y - (abs.y + reserved.y)) <= 2,
      `the widget at (${widget.abs.x}, ${widget.abs.y}) sits on the reserved box at (${
        abs.x + reserved.x
      }, ${abs.y + reserved.y})`,
    );
    assert.ok(
      Math.abs(widget.abs.width - reserved.width) <= 2,
      `and is its size: ${widget.abs.width} for a ${reserved.width} box`,
    );
  },
);

metric(
  'at a display scale of 2 a click on a link reports its href',
  async () => {
    const clicks: string[] = [];
    const { node } = await render2x(
      '<p><a href="https://example.test/x">a link here</a></p>',
      400,
      { onLink: (href: string) => clicks.push(href) },
    );
    const el = view(node);
    // Core's caret rect is device pixels — the selection seam's contract.
    const caret = el.textCaretRect(2);
    assert.ok(caret, 'the link text is laid out');
    const x = caret.x + 1;
    const y = caret.y + caret.height / 2;
    assert.strictEqual(
      el.hrefAtPoint(x / 2, y / 2),
      'https://example.test/x',
      'hrefAtPoint takes the logical point a mouse event carries',
    );

    const target = el as unknown as DrawnNode;
    const dx = x - (target.abs.x + target.abs.width / 2);
    const dy = y - (target.abs.y + target.abs.height / 2);
    await act(async () => {
      fireEvent.mouseDown(target, { dx, dy });
      fireEvent.mouseUp(target, { dx, dy });
    });
    assert.deepStrictEqual(clicks, ['https://example.test/x']);
  },
);

// --- the shape of a laid-out run is the engine's ----------------------------
//
// ntk hands every run back with the span it came from and the face it was
// shaped with; an engine may hand back geometry alone, as react-x11's
// Windows engine does and its Cocoa engine did before 2.22.8,
// and a layout it cut at `maxLines` carries no `truncated`. Both are
// reproduced here on ntk's own layouts, so the suite needs no macOS.

/** Every text layout in the tree, replaced by a view of it in the Cocoa
 *  engine's shape — with the ink stubbed, since the recorder has no window
 *  to draw into. One view per layout, so paint still draws each once. */
function cocoaShaped(el: HtmlViewNode): void {
  const tree = (el as unknown as { _tree: unknown })._tree as {
    root: {
      children: unknown[];
      lines: { texts: { layout: ShapedLayout }[] }[] | null;
    };
  };
  const views = new Map<ShapedLayout, ShapedLayout>();
  const strip = (box: typeof tree.root): void => {
    for (const line of box.lines ?? []) {
      for (const text of line.texts) {
        let view = views.get(text.layout);
        if (!view) {
          view = { ...cocoaShapedLayout(text.layout), draw: () => {} };
          views.set(text.layout, view);
        }
        text.layout = view;
      }
    }
    for (const child of box.children) strip(child as typeof tree.root);
  };
  strip(tree.root);
}

metric(
  "runs that come back without their spans paint, and hit-test through the document's text",
  async () => {
    const { node } = await render(
      '<style>p{margin:0}.hl{background:#ffee55}</style>' +
        '<p><span class="hl">lit</span> <a href="https://example.test/x">a link here</a> after</p>',
    );
    const el = view(node);
    // The point is taken first: the caret lookup keys off the original
    // layouts' identity, and the positions do not change.
    const caret = el.textCaretRect(7);
    assert.ok(caret, 'the paragraph is laid out');
    const x = caret.x + 1;
    const y = caret.y + caret.height / 2;
    assert.strictEqual(el.hrefAtPoint(x, y), 'https://example.test/x');
    cocoaShaped(el);

    const { paintDocument } = await import('../src/html/paint.js');
    const fills: unknown[] = [];
    let fillStyle: unknown = null;
    paintDocument(
      {
        set fillStyle(v: unknown) {
          fillStyle = v;
        },
        get fillStyle() {
          return fillStyle;
        },
        save() {},
        restore() {},
        fillRect() {
          fills.push(fillStyle);
        },
      } as never,
      (el as unknown as { _tree: never })._tree,
      {
        originX: 0,
        originY: 0,
        damage: null,
        selection: null,
        selectionColor: null,
        imageFor: () => null,
      },
    );
    // A highlight is its element's, not the run's: found from where the
    // run's text sits in the document, as the link below is.
    assert.ok(
      fills.includes('#ffee55'),
      'the highlight is painted without a span',
    );

    // Inside the link: no span, and no need of one — the run's place in the
    // document text is what finds the anchor.
    assert.strictEqual(el.hrefAtPoint(x, y), 'https://example.test/x');
    assert.strictEqual(el.elementAtPoint(x, y)?.name, 'a');
  },
);

// --- layouts kept across passes ------------------------------------------------
//
// An edit re-parses the document and lays it out again, and laying the text
// out was most of that. A layout is kept under what went into it
// (`TextLayoutCache`), so a pass asks the text engine only for what changed.

/** The texts the engine is asked to lay out while `during` runs. */
async function laidOutDuring(
  el: HtmlViewNode,
  during: () => Promise<void>,
): Promise<string[]> {
  const engine = (el as unknown as { app: { fonts: FontsLike } }).app.fonts;
  const inner = engine.layout;
  const laid: string[] = [];
  engine.layout = function (content, style, options) {
    laid.push(content.map((r) => r.text).join(''));
    return inner.call(this, content, style, options);
  };
  try {
    await during();
  } finally {
    engine.layout = inner;
  }
  return laid;
}

metric(
  'paragraphs that start, end and run as long as each other keep their own layouts',
  async () => {
    // a kept layout is filed under a summary of its text, and found by all
    // of it: two paragraphs the summary cannot tell apart are still two
    const edge = 'the same twenty-four chars';
    const one = `${edge} first ${edge}`;
    const two = `${edge} other ${edge}`;
    const doc = (paras: string[]) =>
      h(
        'box',
        { style: { width: 400, flexDirection: 'column' } },
        h(Html, {
          source: paras.map((p) => `<p>${p}</p>`).join(''),
          partial: false,
          'data-testname': 'doc',
        }),
      );
    const result = await renderX11(doc([one]), {
      width: 440,
      height: 600,
      fonts: FONTS!,
    });
    const el = view(screen.getByTestName('doc') as DrawnNode);
    await act();
    const laid = await laidOutDuring(el, async () => {
      await act(() => result.rerender(doc([one, two])));
      await waitFor(() =>
        assert.ok(el.textContent().includes('other'), 'the new text is in'),
      );
      await act();
    });
    assert.ok(!laid.includes(one), `the first is kept: ${laid.join(' | ')}`);
    assert.ok(
      laid.includes(two),
      `the second is laid out, not taken for it: ${laid.join(' | ')}`,
    );
  },
);

metric('an edit lays out again only the text it changed', async () => {
  const doc = (word: string) =>
    h(
      'box',
      { style: { width: 400, flexDirection: 'column' } },
      h(Html, {
        source:
          '<h1>A title</h1><p>The first paragraph, unchanged.</p>' +
          `<p>The second one, which is ${word}.</p>` +
          '<ul><li>a list item</li></ul><p>And the last.</p>',
        partial: false,
        'data-testname': 'doc',
      }),
    );
  const result = await renderX11(doc('edited'), {
    width: 440,
    height: 600,
    fonts: FONTS!,
  });
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const laid = await laidOutDuring(el, async () => {
    await act(() => result.rerender(doc('changed')));
    await waitFor(() =>
      assert.ok(el.textContent().includes('changed'), 'the edit arrived'),
    );
    await act();
  });
  assert.deepStrictEqual(
    laid,
    ['The second one, which is changed.'],
    'the rest came from the last pass',
  );
});

metric('an edit asks the engine for no line height it has had', async () => {
  // `line-height: 1.5` is converted against the font's natural line height,
  // which every paragraph asks for; on CoreText each answer was a call to
  // the native side. It is kept per style, so an edit asks for none.
  const doc = (word: string) =>
    h(
      'box',
      { style: { width: 400, flexDirection: 'column' } },
      h(Html, {
        source:
          '<style>body { line-height: 1.5 }</style>' +
          '<p>The first paragraph.</p><p><b>Bold</b> and <i>italic</i>.</p>' +
          `<p>The third one, which is ${word}.</p><h2>A heading</h2>`,
        partial: false,
        'data-testname': 'doc',
      }),
    );
  const result = await renderX11(doc('edited'), {
    width: 440,
    height: 600,
    fonts: FONTS!,
  });
  const el = view(screen.getByTestName('doc') as DrawnNode);
  await act();
  // what the document asks, through the fonts its passes lay out with —
  // not the engine's own questions about the paragraph the edit changed
  const fonts = (el as unknown as { _layouts: { fonts: FontsLike } })._layouts
    .fonts;
  const match = fonts.match;
  let asked = 0;
  fonts.match = (family, style) =>
    new Proxy(match(family, style), {
      get(face, name, receiver) {
        if (name !== 'metrics') return Reflect.get(face, name, receiver);
        return (size: number) => {
          asked += 1;
          return face.metrics(size);
        };
      },
    });
  try {
    await act(() => result.rerender(doc('changed')));
    await waitFor(() =>
      assert.ok(el.textContent().includes('changed'), 'the edit arrived'),
    );
    await act();
  } finally {
    fonts.match = match;
  }
  assert.strictEqual(asked, 0);
});

metric(
  'a resize lays the document out once a step, at the new width',
  async () => {
    // Core asks a leaf for its height at the width it was measured at as well
    // as at the one it has now (`probeHeightFloors`). The document answered
    // the old width by laying itself out there, and the new one again for the
    // pass after: three passes over all of its text a frame of a resize.
    const paras = [
      'The first paragraph of the document, which wraps.',
      'A second one, a little longer than the first, and wrapping too.',
      'And a third.',
    ];
    const doc = (width: number) =>
      h(
        'box',
        { style: { width, height: 300, flexDirection: 'column' } },
        h(
          'box',
          { style: { flexGrow: 1, overflow: 'scroll' } },
          h(Html, {
            source: paras.map((p) => `<p>${p}</p>`).join(''),
            partial: false,
            'data-testname': 'doc',
          }),
        ),
      );
    const result = await renderX11(doc(400), {
      width: 440,
      height: 600,
      fonts: FONTS!,
    });
    const el = view(screen.getByTestName('doc') as DrawnNode);
    await act();
    const end = el.textContent().length;
    const shape = () => ({
      height: el.measureContent({
        width: el.abs.width,
        height: Infinity,
        widthMode: 'at-most',
        heightMode: 'unconstrained',
      }).height,
      caret: el.textCaretRect(end),
    });
    const first = shape();
    for (const width of [360, 300, 360, 400]) {
      const laid = await laidOutDuring(el, async () => {
        await act(() => result.rerender(doc(width)));
        await act();
      });
      for (const p of paras) {
        assert.strictEqual(
          laid.filter((t) => t === p).length,
          1,
          `at ${width}: "${p.slice(0, 12)}…" laid out ${laid.filter((t) => t === p).length} times`,
        );
      }
    }
    // …and back where it started, it is where it started: a size kept for a
    // width is never a layout for it
    assert.deepStrictEqual(shape(), first);
  },
);

metric(
  'a kept layout hit-tests the element of the parse it is shown for',
  async () => {
    // The layout of the first paragraph is the one the first parse made;
    // the anchor under the pointer has to be the second parse's.
    const doc = (word: string) =>
      h(
        'box',
        { style: { width: 400, flexDirection: 'column' } },
        h(Html, {
          source:
            '<p>see <a id="x" href="https://example.test/x">the link</a> now</p>' +
            `<p>and ${word}</p>`,
          partial: false,
          'data-testname': 'doc',
        }),
      );
    const result = await renderX11(doc('one'), {
      width: 440,
      height: 600,
      fonts: FONTS!,
    });
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const laid = await laidOutDuring(el, async () => {
      await act(() => result.rerender(doc('two')));
      await waitFor(() =>
        assert.ok(el.textContent().includes('two'), 'the new text is in'),
      );
      await act();
    });
    assert.ok(!laid.some((t) => t.includes('the link')), 'kept, not laid out');
    const caret = el.textCaretRect(6);
    assert.ok(caret, 'the paragraph is laid out');
    const found = el.elementAtPoint(caret.x + 1, caret.y + caret.height / 2);
    const anchor = (function find(node: unknown): unknown {
      const n = node as { attribs?: { id?: string }; children?: unknown[] };
      if (n.attribs?.id === 'x') return n;
      for (const child of n.children ?? []) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    })(el.document);
    assert.ok(anchor, 'the new parse has the anchor');
    assert.strictEqual(found, anchor, 'the anchor of this parse, not the last');
    assert.strictEqual(
      el.hrefAtPoint(caret.x + 1, caret.y + caret.height / 2),
      'https://example.test/x',
    );
  },
);

metric(
  'a layout that does not say whether it was cut is asked the same of its line ends',
  async () => {
    // Beside a float the paragraph is laid out a line at a time, and each
    // fragment's `truncated` is what says the segment wrapped. An engine that
    // reports none must not read as "fitted" — that dropped every line after
    // the first. The same tree is laid out twice: with the flag, and with it
    // hidden.
    const source =
      '<style>p{margin:0}.f{float:left;width:100px;height:40px}</style>' +
      '<div class="f"></div><p>' +
      'word '.repeat(40) +
      '</p>';
    const { result, node } = await render(source, 240);
    const el = view(node);
    const tree = (el as unknown as { _tree: unknown })._tree as {
      root: { children: { lines: { textEnd: number }[] | null }[] };
    };
    const control = tree.root.children[1].lines ?? [];
    assert.ok(
      control.length > 2,
      `the paragraph wraps (${control.length} lines)`,
    );

    const fonts = (result.app as unknown as { fonts: FontsLike }).fonts;
    const silent: FontsLike = {
      layout: (...args) => {
        const layout = fonts.layout(...args);
        delete (layout as { truncated?: boolean }).truncated;
        return layout;
      },
      match: (...args) => fonts.match(...args),
    };
    const { layoutDocument } = await import('../src/html/layout/block.js');
    layoutDocument(tree as never, silent, 240, 600);
    const again = tree.root.children[1].lines ?? [];
    assert.strictEqual(
      again.length,
      control.length,
      'every line of the paragraph is laid out',
    );
    assert.strictEqual(
      again[again.length - 1].textEnd,
      control[control.length - 1].textEnd,
      'down to the last word',
    );
  },
);

// --- colour scheme ----------------------------------------------------------

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

// --- SVG, and what a replaced box has of a size ------------------------------

/** The box laid out for an element, with the replaced fields this reads. */
type ReplacedBox = LaidBox & { kind: string; replaced: string };

/** Render with each image URL answered from `images`, as bytes. */
async function renderWithBytes(
  source: string,
  images: Record<string, Uint8Array>,
  width = 400,
) {
  const result = await renderX11(
    h(
      'box',
      { style: { width, flexDirection: 'column' } },
      h(Html, {
        source,
        partial: false,
        'data-testname': 'doc',
        onResource: (r: { url: string; kind: string }) =>
          r.kind === 'image' && images[r.url]
            ? { kind: 'image' as const, bytes: images[r.url] }
            : null,
      }),
    ),
    FONTS
      ? { width: width + 40, height: 400, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  return { result, el: view(screen.getByTestName('doc') as DrawnNode) };
}

const svgBytes = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, 'utf8'));

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

test('an inline SVG is sized by the width, height and ratio it gives (CSS 2.1 10.3.2)', async () => {
  const { node } = await render(
    '<style>body{margin:0}svg{display:block}</style>' +
      // a height and no ratio: the width is the default object size's
      '<svg id="h" height="50"></svg>' +
      // nothing at all: the default object size, 300 by 150
      '<svg id="n"></svg>' +
      // a ratio alone: as wide as a block, and as tall as the ratio says
      '<svg id="r" viewBox="0 0 100 50"></svg>' +
      '<svg id="w" width="40" height="20"></svg>' +
      // the attributes are CSS lengths, a percentage too
      '<svg id="p" viewBox="0 0 10 10" width="25%"></svg>' +
      '<svg id="u" width="0.5in" height="1pc"></svg>',
    400,
  );
  const el = view(node);
  const size = (id: string): [number, number] => {
    const box = boxOf(el, id);
    return [box.width, box.height];
  };
  assert.deepStrictEqual(size('h'), [300, 50]);
  assert.deepStrictEqual(size('n'), [300, 150]);
  assert.deepStrictEqual(size('r'), [400, 200]);
  assert.deepStrictEqual(size('w'), [40, 20]);
  assert.deepStrictEqual(size('p'), [100, 100]);
  assert.deepStrictEqual(size('u'), [48, 16]);
  assert.strictEqual((boxOf(el, 'n') as ReplacedBox).replaced, 'svg');
});

test('an SVG root under a prefix bound to SVG is one, and a type selector sees it', async () => {
  const { node } = await render(
    '<style>body{margin:0}svg{display:block;width:77px}</style>' +
      '<div xmlns:svg="http://www.w3.org/2000/svg">' +
      '<svg:svg id="s" height="30"><svg:rect width="10" height="10"/></svg:svg>' +
      '</div>' +
      // a Word document's prefix: not SVG, and nothing a selector names
      '<div xmlns:o="urn:schemas-microsoft-com:office:office">' +
      '<o:svg id="o">x</o:svg></div>',
    400,
  );
  const el = view(node);
  const svg = boxOf(el, 's') as ReplacedBox;
  assert.strictEqual(svg.replaced, 'svg');
  assert.deepStrictEqual([svg.width, svg.height], [77, 30]);
  const other = boxOf(el, 'o') as ReplacedBox;
  assert.strictEqual(other.replaced, 'none');
  assert.notStrictEqual(other.width, 77);
});

test('a limit on one axis of an image carries to the other through its ratio (CSS 2.1 10.4)', async () => {
  // the 10 by 10 red square, in a column 5px wide
  const { el } = await renderWithBytes(
    '<style>body{margin:0}img{display:block}</style>' +
      '<div style="width:5px">' +
      '<img id="a" src="r.png" style="max-width:100%">' +
      // a width set, as a mail template sets it, and a limit under it
      '<img id="b" src="r.png" width="10" style="max-width:100%">' +
      '</div>' +
      '<img id="c" src="r.png" style="min-width:20px">' +
      '<img id="d" src="r.png" style="height:30px;max-width:15px">',
    { 'r.png': RED_PNG },
  );
  const size = (id: string): [number, number] => {
    const box = boxOf(el, id);
    return [box.width, box.height];
  };
  assert.deepStrictEqual(size('a'), [5, 5], 'max-width: 100%, both auto');
  assert.deepStrictEqual(size('b'), [5, 5], 'width set, height from it');
  assert.deepStrictEqual(size('c'), [20, 20], 'min-width, both auto');
  // a height set is kept: only the width follows the limit
  assert.deepStrictEqual(size('d'), [15, 30], 'height set');
});

test('an hr with no width set is as wide as its line', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><hr id="a"><hr id="b" style="width:50%">',
    400,
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').width, 400);
  assert.strictEqual(boxOf(el, 'b').width, 200);
});

test('an SVG image is sized by what its document says, and a PNG still decodes', async () => {
  const { el } = await renderWithBytes(
    '<style>body{margin:0}img{display:block}</style>' +
      '<img id="h" src="h.svg"><img id="r" src="r.svg">' +
      '<img id="w" src="w.svg"><img id="p" src="p.png">',
    {
      'h.svg': svgBytes(`<svg ${SVG_NS} height="25"><rect/></svg>`),
      // after a byte order mark and an XML declaration: still sniffed
      'r.svg': svgBytes(
        `﻿<?xml version="1.0"?>\n<svg ${SVG_NS} viewBox="0 0 2 1"/>`,
      ),
      'w.svg': svgBytes(`<svg ${SVG_NS} width="50" viewBox="0 0 1 2"/>`),
      'p.png': RED_PNG,
    },
  );
  const size = (id: string): [number, number] => {
    const box = boxOf(el, id);
    return [box.width, box.height];
  };
  await waitFor(() => assert.deepStrictEqual(size('h'), [300, 25]));
  assert.deepStrictEqual(size('r'), [400, 200]);
  assert.deepStrictEqual(size('w'), [50, 100]);
  assert.deepStrictEqual(size('p'), [10, 10]);
});

test('an object is its image once its data is one, and its content until then', async () => {
  const { el } = await renderWithBytes(
    '<style>body{margin:0}</style>' +
      '<object id="o" data="r.png" type="image/png">fallback</object>' +
      '<object id="f" data="gone.png">still here</object>',
    { 'r.png': RED_PNG },
  );
  await waitFor(() =>
    assert.strictEqual((boxOf(el, 'o') as ReplacedBox).replaced, 'image'),
  );
  const o = boxOf(el, 'o');
  assert.deepStrictEqual([o.width, o.height], [10, 10]);
  assert.strictEqual((boxOf(el, 'f') as ReplacedBox).replaced, 'none');
  assert.ok(el.textContent().includes('still here'), 'the fallback content');
  assert.ok(!el.textContent().includes('fallback'), 'not the loaded one');
});

metric(
  'an SVG draws its viewport: percentages, the fit of its viewBox, the clip and currentColor',
  async () => {
    const { result } = await renderWithBytes(
      '<style>body{margin:0}svg{display:block}</style>' +
        // 100% of a 300 by 20 viewport
        '<svg height="20"><rect width="100%" height="100%" fill="#00ff00"/></svg>' +
        // a square viewBox in a 40 by 20 box: 20 by 20, in the middle
        '<svg viewBox="0 0 10 10" style="width:40px;height:20px">' +
        '<rect width="10" height="10" fill="#0000ff"/></svg>' +
        // a rect larger than its viewport is clipped to it
        '<svg width="10" height="10"><rect width="50" height="50" fill="#ff0000"/></svg>' +
        // currentColor is the colour the box inherits
        '<div style="color:#ff00ff"><svg width="10" height="10">' +
        '<rect width="10" height="10" fill="currentColor"/></svg></div>',
      {},
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 250, 10, '#00ff00', { message: '100% wide' });
    await expectPixel(ctx, 5, 30, '#ffffff', { message: 'beside the fit' });
    await expectPixel(ctx, 20, 30, '#0000ff', { message: 'the fitted square' });
    await expectPixel(ctx, 35, 30, '#ffffff', { message: 'beside the fit' });
    await expectPixel(ctx, 5, 45, '#ff0000', { message: 'inside the clip' });
    await expectPixel(ctx, 20, 45, '#ffffff', { message: 'outside the clip' });
    await expectPixel(ctx, 5, 55, '#ff00ff', { message: 'currentColor' });
  },
);

metric(
  'an SVG background with no size of its own is sized in its area, its root by its percentages',
  async () => {
    const { result } = await renderWithBytes(
      '<style>body{margin:0}div{width:80px;height:100px;' +
        'background:#ffffff url(g.svg) no-repeat}</style><div></div>',
      {
        'g.svg': svgBytes(
          `<svg ${SVG_NS} width="40%" height="60%">` +
            '<rect width="100%" height="100%" fill="#00ff00"/></svg>',
        ),
      },
    );
    const ctx = result.ctx;
    // 40% by 60% of the 80 by 100 area: 32 by 60
    await expectPixel(ctx, 30, 55, '#00ff00', { message: 'inside' });
    await expectPixel(ctx, 36, 10, '#ffffff', { message: 'past its width' });
    await expectPixel(ctx, 10, 64, '#ffffff', { message: 'past its height' });
  },
);

// --- columns and column groups -------------------------------------------------

test('a column, or a column group, sets its columns in an auto table (CSS 2.1 17.5.2.2)', async () => {
  const { node } = await render(
    '<style>body{margin:0}table{border-spacing:0}td{padding:0}</style>' +
      // an empty group is one column, and its width is that column's
      '<table id="g"><colgroup style="width:100px"></colgroup><tr><td></td></tr></table>' +
      // a column within its limits
      '<table id="c"><col style="width:300px;max-width:50px"><tr><td></td></tr></table>' +
      // a limit alone sets one
      '<table id="m"><colgroup style="min-width:80px"></colgroup><tr><td></td></tr></table>' +
      // a group wider than its columns spreads the rest over them
      '<table id="s"><colgroup style="width:100px"><col style="width:20px">' +
      '<col style="width:20px"></colgroup>' +
      '<tr><td id="s1"></td><td id="s2"></td></tr></table>',
    400,
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'g').width, 100);
  assert.strictEqual(boxOf(el, 'c').width, 50);
  assert.strictEqual(boxOf(el, 'm').width, 80);
  assert.strictEqual(boxOf(el, 's').width, 100);
  assert.strictEqual(boxOf(el, 's1').width, 50);
  assert.strictEqual(boxOf(el, 's2').width, 50);
});

metric(
  "a column group's image is placed in the box its cells make, and a row's against its cells",
  async () => {
    const { result } = await renderWithBytes(
      '<style>body{margin:0}td{padding:0;height:30px;width:30px}' +
        'table{border-spacing:10px}' +
        // the group's two columns: its image at the bottom right of both
        '#g{background:url(r.png) no-repeat 100% 100%}' +
        // the row's at its first cell's corner, not the spacing's
        '#r{background:url(r.png) no-repeat 0 0}</style>' +
        '<table><colgroup id="g"><col><col></colgroup><col>' +
        '<tr><td></td><td></td><td></td></tr></table>' +
        '<table><tr id="r"><td></td><td></td></tr></table>',
      { 'r.png': RED_PNG },
    );
    const ctx = result.ctx;
    // the group runs from x 10 to 80, y 10 to 40: the 10px square ends there
    await expectPixel(ctx, 75, 35, '#ff0000', {
      message: 'group, bottom right',
    });
    await expectPixel(ctx, 15, 15, '#ffffff', { message: 'group, top left' });
    // the second table starts at y 50; its first cell at x 10, y 60
    await expectPixel(ctx, 15, 65, '#ff0000', { message: 'row, at its cell' });
    await expectPixel(ctx, 25, 65, '#ffffff', {
      message: 'row, past the tile',
    });
  },
);

// --- a block in an inline box ------------------------------------------------

test('an inline box is broken around a block in it, and its pieces lose their edges there (CSS 2.1 9.2.1.1)', async () => {
  const { node } = await render(
    '<style>body{margin:0}p{margin:0}</style>' +
      // old mail: paragraphs in a <font>
      '<div><font face="serif"><p id="one">One</p><p id="two">Two</p></font></div>' +
      // a link around a card's blocks
      '<div><a href="#">x<div id="card">Card</div>y</a></div>' +
      // an image set display: block in a link has no line around it
      '<div id="banner"><a href="#"><img id="img" width="40" height="20" style="display:block"></a></div>' +
      '<div><span id="s" style="border:2px solid">a<div>b</div>c</span></div>',
    400,
  );
  const el = view(node);
  const one = boxOf(el, 'one');
  const two = boxOf(el, 'two');
  assert.ok(two.y >= one.y + one.height, 'stacked, not side by side');
  assert.strictEqual(one.width, 400, 'as wide as a block');
  assert.strictEqual(boxOf(el, 'card').width, 400);
  assert.strictEqual(
    boxOf(el, 'img').y,
    boxOf(el, 'banner').y,
    'no line above it',
  );
  // the span's pieces: the first keeps its start edge, the last its end
  const pieces: (LaidBox & { borderLeft: number; borderRight: number })[] = [];
  const walk = (box: LaidBox): void => {
    const kind = (box as unknown as { kind: string }).kind;
    if (box.el?.attribs.id === 's' && kind === 'inline') {
      pieces.push(box as (typeof pieces)[number]);
    }
    box.children.forEach(walk);
  };
  walk((el as unknown as { _tree: { root: LaidBox } })._tree.root);
  assert.strictEqual(pieces.length, 2);
  assert.deepStrictEqual(
    pieces.map((p) => [p.borderLeft, p.borderRight]),
    [
      [2, 0],
      [0, 2],
    ],
  );
});

test('right to left, a relative box set on both sides moves by its right, and a table starts at the right', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div dir="rtl" style="width:200px">' +
      '<div id="r" style="position:relative;left:50px;right:50px;width:50px;height:10px"></div></div>' +
      '<table dir="rtl" style="border-spacing:0"><tr>' +
      '<td id="a" style="width:50px;padding:0"></td><td id="b" style="width:30px;padding:0"></td>' +
      '</tr></table>',
    400,
  );
  const el = view(node);
  // at the right of its 200px block, then 50px back to the left
  assert.strictEqual(boxOf(el, 'r').x, 100);
  const a = boxOf(el, 'a');
  const b = boxOf(el, 'b');
  assert.strictEqual(a.x, b.x + b.width, 'the first cell at the right');
});

// --- url(), font-family, and a table that clips --------------------------------

test('a url() is read as CSS Syntax reads it, and a bad one drops its declaration', async () => {
  const { node } = await render(
    '<style>' +
      // `/*` in an unquoted url is no comment: taken for one, it ran on
      // through the rest of the sheet, and #a lost its colour
      '#a { background-image: url(a/*b) } #a { color: #00ff00 }' +
      "#b { background-image: url(a\\ b\\'c) }" +
      // a bad url, and anything after one, drop the declaration whole
      '#c { background: #0000ff } #c { background: #ff0000 url(a b) }' +
      '#d { background-image: url(x.png) } #d { background-image: url(y.png) repeat }' +
      // the end of the sheet closes a url
      '#e { background-image: url("e.png' +
      '</style>' +
      '<div id="a"></div><div id="b"></div><div id="c"></div>' +
      '<div id="d"></div><div id="e"></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: {
          backgroundImage: string | null;
          backgroundColor: string | null;
          color: string;
        };
      }
    ).style;
  assert.strictEqual(style('a').backgroundImage, 'a/*b');
  assert.strictEqual(style('a').color, '#00ff00');
  assert.strictEqual(style('b').backgroundImage, "a b'c");
  assert.strictEqual(style('c').backgroundColor, '#0000ff');
  assert.strictEqual(style('d').backgroundImage, 'x.png');
  assert.strictEqual(style('e').backgroundImage, 'e.png');
});

test('a font-family with a name that is none is dropped (CSS 2.1 15.3)', async () => {
  const { node } = await render(
    '<div id="p" style="font-family: serif">' +
      '<div id="a" style="font-family: test!foo, monospace"></div>' +
      '<div id="b" style="font-family: 1996, monospace"></div>' +
      '<div id="c" style="font-family: Arial Black, \'Segoe UI\', -apple-system, monospace"></div>' +
      '</div>',
  );
  const el = view(node);
  const family = (id: string) =>
    (boxOf(el, id) as unknown as { style: { fontFamily: string } }).style
      .fontFamily;
  assert.strictEqual(family('a'), family('p'), 'inherited, not set');
  assert.strictEqual(family('b'), family('p'));
  assert.strictEqual(
    family('c'),
    'Arial Black, Segoe UI, -apple-system, monospace',
  );
});

metric(
  'a table that does not let its content overflow clips it to the table box, its caption outside',
  async () => {
    const { result } = await renderWithBytes(
      '<style>body{margin:0}table{overflow:hidden;border-spacing:0}' +
        'caption{height:20px;background:#0000ff}td{padding:0}' +
        'div{width:20px;height:20px;margin-top:-10px;background:#ff0000}</style>' +
        '<table><caption></caption><tr><td><div></div></td></tr></table>',
      {},
    );
    const ctx = result.ctx;
    // the caption is drawn, and the cell's block does not reach up over it
    await expectPixel(ctx, 10, 15, '#0000ff', { message: 'the caption' });
    await expectPixel(ctx, 10, 25, '#ff0000', { message: 'in the table box' });
  },
);

// --- HTML's alignment, as mail uses it -------------------------------------------

test('align places a table, and <center> or an aligned cell centres the blocks in it', async () => {
  const { node } = await render(
    '<style>body{margin:0}table{border-spacing:0}td{padding:0}</style>' +
      // the frame of nearly every mail: centred, its text left alone
      '<table id="t1" align="center" width="200"><tr><td id="c1">x</td></tr></table>' +
      '<center><table id="t2" width="100"><tr><td>x</td></tr></table></center>' +
      '<div align="center"><table id="t3" width="100"><tr><td>x</td></tr></table></div>' +
      // a button: no width, so centred once it has shrunk to its cell
      '<table id="t4" align="center"><tr><td>Button</td></tr></table>' +
      '<table id="t5" align="right" width="100"><tr><td>x</td></tr></table>' +
      '<table width="400" style="clear:both"><tr><td align="center">' +
      '<table id="t6" width="50"><tr><td>x</td></tr></table></td></tr></table>' +
      // what mail's own CSS writes for it
      '<div style="text-align:-webkit-center"><div id="d" style="width:100px">x</div></div>',
    400,
  );
  const el = view(node);
  const x = (id: string) => boxOf(el, id).x;
  assert.strictEqual(x('t1'), 100);
  assert.strictEqual(x('t2'), 150);
  assert.strictEqual(x('t3'), 150);
  const t4 = boxOf(el, 't4');
  assert.ok(Math.abs(t4.x - (400 - t4.width) / 2) < 0.01, 'centred shrunk');
  assert.strictEqual(x('t5'), 300, 'floated right');
  assert.strictEqual(x('t6'), 175);
  assert.strictEqual(x('d'), 150);
  const align = (boxOf(el, 'c1') as unknown as { style: { textAlign: string } })
    .style.textAlign;
  assert.notStrictEqual(align, 'center', "the table's text is its own");
});

test("a table in an aligned cell keeps its cells' text at their start", async () => {
  // Every mail centres its body in `<td align="center">`, which is
  // `-webkit-center`: the table is centred, and its cells' text is not,
  // since a table resets HTML's alignment as Blink does. An author's own
  // `text-align: center` is inherited into the table as ever.
  const { node } = await render(
    '<style>body{margin:0}table{border-spacing:0}td{padding:0}</style>' +
      '<table width="400"><tr><td align="center">' +
      '<table id="t1" width="200"><tr><td id="c1">text</td></tr></table>' +
      '</td></tr></table>' +
      '<center><table id="t2" width="200"><tr><td id="c2">text</td></tr>' +
      '</table></center>' +
      '<table width="400"><tr><td style="text-align:center">' +
      '<table width="200"><tr><td id="c3">text</td></tr></table>' +
      '</td></tr></table>',
    400,
  );
  const el = view(node);
  const align = (id: string) =>
    (boxOf(el, id) as unknown as { style: { textAlign: string } }).style
      .textAlign;
  assert.strictEqual(boxOf(el, 't1').x, 100, 'the table centred');
  assert.strictEqual(align('c1'), 'start');
  assert.strictEqual(boxOf(el, 't2').x, 100);
  assert.strictEqual(align('c2'), 'start');
  assert.strictEqual(align('c3'), 'center', "the author's own centring");
});

test('a ::marker rule styles the marker, and not its item', async () => {
  // `::marker` rules were read and never applied: Tailwind's `prose` sets
  // its bullets in a grey, and they came out in the text's colour
  const { node } = await render(
    '<style>li::marker{color:#ff0000;font-weight:700}' +
      '.arrow::marker{content:"-> ";color:#0000ff}</style>' +
      '<ul><li id="a">item</li></ul>' +
      '<ol><li id="b">one</li><li id="c" class="arrow">two</li>' +
      '<li id="d">three</li></ol>' +
      '<ul><li id="e" style="list-style-position:inside">inside</li></ul>',
  );
  const el = view(node);
  type Marked = {
    style: ComputedStyle;
    marker: { text: string; style: ComputedStyle | null } | null;
  };
  const item = (id: string) => boxOf(el, id) as unknown as Marked;
  const a = item('a');
  assert.strictEqual(a.marker?.style?.color, '#ff0000');
  assert.strictEqual(a.marker?.style?.fontWeight, 700);
  assert.notStrictEqual(a.style.color, '#ff0000', 'not the item');
  assert.strictEqual(a.style.fontWeight, 400);
  // a `content` is what the marker is set as, and the list counts on
  assert.strictEqual(item('c').marker?.text, '-> ');
  assert.strictEqual(item('c').marker?.style?.color, '#0000ff');
  assert.strictEqual(item('d').marker?.text, '3.');
  // an inside marker is an inline box in the marker's style
  const inside = (boxOf(el, 'e') as unknown as { children: Marked[] })
    .children[0];
  assert.strictEqual(inside.style.color, '#ff0000');
});
metric(
  'an underline sits at its offset, as thick as its thickness',
  async () => {
    // `text-underline-offset` and `text-decoration-thickness` were dropped:
    // every underline sat two pixels under the baseline, a pixel thick —
    // shadcn's links set theirs four pixels down
    const { node } = await render(
      '<style>body{margin:0;font:20px sans-serif}p{margin:0}' +
        'a{text-decoration:underline #ff0000}</style>' +
        '<p id="a"><a>plain</a></p>' +
        '<p id="b"><a style="text-underline-offset:6px;' +
        'text-decoration-thickness:3px">offset</a></p>' +
        '<p id="c"><a style="text-decoration:underline #00ff00 4px">short</a>' +
        '</p>',
    );
    const el = view(node);
    const fills = await fillsOf(el);
    const baseline = (id: string) => {
      const [line] = linesOf(el, id) as unknown as {
        y: number;
        baseline: number;
      }[];
      return line.y + line.baseline;
    };
    const rule = (color: string, id: string) => {
      const b = baseline(id);
      return fills.find(
        (f) => f.style === color && f.y > b - 1 && f.y < b + 12,
      );
    };
    const plain = rule('#ff0000', 'a')!;
    assert.deepStrictEqual(
      [Math.round(plain.y - baseline('a')), plain.h],
      [2, 1],
      'two below, a pixel thick',
    );
    const offset = rule('#ff0000', 'b')!;
    assert.deepStrictEqual(
      [Math.round(offset.y - baseline('b')), offset.h],
      [6, 3],
    );
    assert.strictEqual(rule('#00ff00', 'c')!.h, 4, 'the shorthand thickness');
  },
);

test('a closed details shows its summary, and an open one all of it', async () => {
  // a closed `<details>` showed everything in it: an FAQ of them was every
  // answer at once
  const { node } = await render(
    '<details id="closed"><summary id="s1">Question</summary>' +
      '<p id="hidden">Answer</p></details>' +
      '<details id="open" open><summary id="s2">Question</summary>' +
      '<p id="shown">Answer</p></details>' +
      '<details id="two"><summary id="s3">First</summary>' +
      '<summary id="s4">Second</summary></details>',
  );
  const el = view(node);
  const has = (id: string) => {
    try {
      boxOf(el, id);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(has('s1'), 'the summary');
  assert.ok(!has('hidden'), 'not the answer');
  assert.ok(has('shown'), "an open one's answer");
  assert.ok(has('s3') && !has('s4'), 'the first summary only');
  // with the marker HTML gives a summary, turned down when open
  const type = (id: string) =>
    (boxOf(el, id) as unknown as { style: { listStyleType: string } }).style
      .listStyleType;
  assert.strictEqual(type('s1'), 'disclosure-closed');
  assert.strictEqual(type('s2'), 'disclosure-open');
});

metric(
  'an inside marker takes its room at the start of the first line',
  async () => {
    // it was drawn at the content edge, over the first letters of the item:
    // every `list-style-position: inside` list, and every `<summary>`
    const { node } = await render(
      '<style>body{margin:0} ul{margin:0;padding:0}</style>' +
        '<ul style="list-style-position:inside"><li id="in">Item</li></ul>' +
        '<ul style="list-style:none"><li id="bare">Item</li></ul>',
    );
    const el = view(node);
    const [inside] = linesOf(el, 'in');
    const [bare] = linesOf(el, 'bare');
    assert.ok(
      inside.width > bare.width + 4,
      `the bullet and its space: ${inside.width} beside ${bare.width}`,
    );
    // and it is no marker set beside the line any more
    assert.strictEqual(
      (boxOf(el, 'in') as unknown as { marker: unknown }).marker,
      null,
    );
  },
);

test("a body's text and link colours, and a background attribute", async () => {
  const { node } = await render(
    '<body text="#123456" link="#00ff00">' +
      '<p id="p">x</p><a id="a" href="#">l</a>' +
      '<table id="t" background="bg.png"><tr><td>x</td></tr></table></body>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { color: string; backgroundImage: string | null };
      }
    ).style;
  assert.strictEqual(style('p').color, '#123456');
  assert.strictEqual(style('a').color, '#00ff00');
  assert.strictEqual(style('t').backgroundImage, 'bg.png');
});

test("nowrap, a clearing br, an image aligned in its line, and a rule's own attributes", async () => {
  const { node } = await render(
    '<style>body{margin:0}table{border-spacing:0}td{padding:0}p{margin:0}</style>' +
      '<div style="width:60px"><table><tr>' +
      '<td id="n" nowrap>one two three</td></tr></table></div>' +
      '<img id="f" src="a.png" width="30" height="30" style="float:left">x' +
      '<br clear="all"><p id="after">after</p>' +
      '<p><img id="m" src="a.png" width="10" height="10" align="middle">x</p>' +
      '<hr id="h" width="50%" size="3" color="#ff0000">' +
      '<hr id="l" width="50%" align="left">',
    400,
  );
  const el = view(node);
  type Styled = LaidBox & {
    lines: unknown[] | null;
    style: {
      verticalAlign: string;
      borderTopWidth: number;
      borderTopColor: string;
    };
  };
  const box = (id: string) => boxOf(el, id) as Styled;
  assert.strictEqual(box('n').lines?.length, 1, 'one line, and no wrap');
  const f = box('f');
  assert.ok(box('after').y >= f.y + f.height, 'below the float');
  assert.strictEqual(box('m').style.verticalAlign, 'middle');
  const h = box('h');
  assert.strictEqual(h.x, 100, 'centred, as a browser centres a rule');
  assert.strictEqual(h.style.borderTopWidth, 3);
  assert.strictEqual(h.style.borderTopColor, '#ff0000');
  assert.strictEqual(box('l').x, 0);
});

// --- ::first-line, and a pseudo-element's place in a selector -------------------

test('a pseudo-element ends its selector: a group with one inside is dropped', async () => {
  const { selectorList } = await import('../src/html/css/parse.js');
  assert.strictEqual(selectorList('p:first-line p, #p1'), null);
  assert.strictEqual(selectorList('p::before.x'), null);
  assert.deepStrictEqual(selectorList('div > p:first-line'), [
    'div > p:first-line',
  ]);
  // the user action pseudo-classes may follow one (Selectors 4)
  assert.deepStrictEqual(selectorList('a::before:hover'), ['a::before:hover']);
});

metric(
  '::first-line colours the first line, and paints its background behind it',
  async () => {
    const { result, el } = await renderWithBytes(
      '<style>body{margin:0}div{width:90px;color:#ff0000;' +
        'font:bold 40px/50px sans-serif}p{margin:0}' +
        'div::first-line{color:#00ff00;background:#0000ff}</style>' +
        // the div's first line is its first paragraph's
        '<div><p id="p">III <span style="color:#ff00ff">III III</span> III</p>' +
        '<p>III</p></div>',
      {},
    );
    const { lines } = boxOf(el, 'p') as unknown as {
      lines: { textStart: number; textEnd: number }[];
    };
    assert.strictEqual(lines.length, 2, 'the words wrap');
    // the span is across the first line's end, and the text after it is
    // still all on the second
    assert.deepStrictEqual(
      lines.map((l) => [l.textStart, l.textEnd]),
      [
        [0, 8],
        [8, 15],
      ],
    );
    const count = async (y0: number, y1: number) => {
      const w = 90;
      const data: Uint8ClampedArray = await new Promise((ok, fail) =>
        (
          result.ctx as unknown as {
            getImageData(
              x: number,
              y: number,
              w: number,
              h: number,
              cb: (e: unknown, d: { data: Uint8ClampedArray }) => void,
            ): void;
          }
        ).getImageData(0, y0, w, y1 - y0, (e, d) => (e ? fail(e) : ok(d.data))),
      );
      const seen = { green: 0, red: 0, blue: 0, magenta: 0 };
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (g > 200 && r < 60 && b < 60) seen.green += 1;
        if (r > 200 && g < 60 && b < 60) seen.red += 1;
        if (b > 200 && r < 60 && g < 60) seen.blue += 1;
        if (r > 200 && b > 200 && g < 60) seen.magenta += 1;
      }
      return seen;
    };
    const first = await count(0, 50);
    const second = await count(50, 100);
    const third = await count(100, 150);
    assert.ok(first.green > 0 && first.red === 0, 'the first line is green');
    assert.ok(first.magenta > 0, 'but for the span, in its own colour');
    assert.ok(first.blue > 0, 'on its background');
    assert.ok(second.red > 0 && second.green === 0, 'the second is not');
    assert.ok(second.magenta > 0);
    assert.strictEqual(second.blue, 0);
    assert.ok(third.red > 0 && third.green === 0, 'nor the next paragraph');
    assert.strictEqual(third.blue, 0);
  },
);

// --- CSS syntax: comments, numbers, escapes, white space --------------------

test('a comment ends the token before it in a declaration, and not in a selector', () => {
  // two values and no length, no negative length, and three channels
  assert.deepStrictEqual(
    parseDeclarations(
      'height: 1/**/0px; margin: -/**/10px; color: rgb(0/**/128/**/0)',
    ).map((d) => d.value),
    ['1 0px', '- 10px', 'rgb(0 128 0)'],
  );
  const sheet = parseStylesheet(
    '.a/**/.b { color: red } @media/**/all { p { margin: 1/**/0px } }',
  );
  assert.deepStrictEqual(
    sheet.rules.map((r) => [r.selector, r.declarations[0].value]),
    [
      ['.a.b', 'red'],
      ['p', '1 0px'],
    ],
  );
});

test("a number is CSS's: an exponent, a sign, and a digit after any point", () => {
  const ctx = { em: 20, rem: 16, vw: 1000, vh: 500, scale: 1 };
  assert.strictEqual(parseLength('1e1px', ctx), 10);
  assert.strictEqual(parseLength('0.1e1em', ctx), 20);
  assert.strictEqual(parseLength('+20px', ctx), 20);
  assert.strictEqual(parseLength('1em', ctx), 20);
  assert.strictEqual(parseLength('1.px', ctx), null);
  assert.strictEqual(parseNumber('1e3'), 1000);
  assert.strictEqual(parseNumber('0x10'), null);
  assert.strictEqual(parseNumber('1.'), null);
});

metric(
  'a hex escape takes the space after it, and a string its escaped newline',
  async () => {
    const { el } = await renderWithBytes(
      '<style>p.c\\06C ass { color: #00ff00 }' +
        '[title="a\\\n b"] { background: #0000ff }' +
        // CSS's other white space is a descendant combinator too
        'div\fp { font-weight: bold }</style>' +
        '<div><p id="p" class="class" title="a b">x</p></div>',
      {},
    );
    const style = (
      boxOf(el, 'p') as unknown as { style: Record<string, unknown> }
    ).style;
    assert.strictEqual(style.color, '#00ff00');
    assert.strictEqual(style.backgroundColor, '#0000ff');
    assert.strictEqual(style.fontWeight, 700);
  },
);

metric(
  "an invalid background is dropped whole, and CSS3's forms are kept",
  async () => {
    const { el } = await renderWithBytes(
      '<style>p { background: #00ff00 }' +
        '#a { background: "red" } #b { background: red\\; }' +
        '#c { background: red green } #d { background: red, url(b.png) }' +
        '#e { background: url(a.png) no-repeat right 10px center / cover #fff }' +
        '#f { background: #333 linear-gradient(to right, #fff, #000) }' +
        '#g { background-position: 5px 5px; background: #fff }</style>' +
        '<p id="a">a</p><p id="b">b</p><p id="c">c</p><p id="d">d</p>' +
        '<p id="e">e</p><p id="f">f</p><p id="g">g</p>',
      {},
    );
    const style = (id: string) =>
      (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
    // each of these was a background reset to nothing
    for (const id of ['a', 'b', 'c', 'd']) {
      assert.strictEqual(style(id).backgroundColor, '#00ff00', id);
    }
    const e = style('e');
    assert.strictEqual(e.backgroundColor, '#fff');
    assert.strictEqual(e.backgroundImage, 'a.png');
    assert.deepStrictEqual(e.backgroundRepeat, ['no-repeat', 'no-repeat']);
    assert.strictEqual(e.backgroundSize, 'cover');
    assert.deepStrictEqual(e.backgroundPositionX, { pct: 100, px: -10 });
    assert.deepStrictEqual(e.backgroundPositionY, { pct: 50 });
    // a gradient is drawn as nothing, over the colour beside it
    assert.strictEqual(style('f').backgroundColor, '#333');
    // and the shorthand resets what it does not name
    assert.strictEqual(style('g').backgroundPositionX, 0);
  },
);

metric(
  'the body inherits its colour and font from the root, an html rule too',
  async () => {
    const doc = await renderWithBytes(
      '<html><style>html { color: #00ff00; font-family: serif }</style>' +
        '<body><p id="p">x</p></body></html>',
      {},
    );
    const style = (el: HtmlViewNode) =>
      (boxOf(el, 'p') as unknown as { style: Record<string, unknown> }).style;
    assert.strictEqual(style(doc.el).color, '#00ff00');
    assert.strictEqual(style(doc.el).fontFamily, 'serif');
    cleanup();
    // a fragment's body inherits from the html a browser would imply
    const fragment = await renderWithBytes(
      '<style>html { color: #00ff00 }</style><p id="p">x</p>',
      {},
    );
    assert.strictEqual(style(fragment.el).color, '#00ff00');
    cleanup();
    // and so does a page with a <body> and no <html>, the usual shape of
    // one that starts `<!DOCTYPE html><title>`, where the rule matched
    // nothing and the page came out at the theme's size
    const page = await renderWithBytes(
      '<!DOCTYPE html><title>t</title><style>html { color: #00ff00; ' +
        'font-size: 10px }</style><body><p id="p">x</p></body>',
      {},
    );
    assert.strictEqual(style(page.el).color, '#00ff00');
    assert.strictEqual(style(page.el).fontSize, 10);
  },
);

metric('a body with no html tag paints the canvas', async () => {
  const { result } = await renderWithBytes(
    '<body style="background: #00ff00; margin: 20px"><p>x</p></body>',
    {},
  );
  // outside the body's margin, where only the canvas is
  const [r, g, b] = await pixelAt(result.ctx, 4, 4);
  assert.ok(g > 200 && r < 60 && b < 60, `the canvas is green: ${r},${g},${b}`);
});

metric('a body in an html set to be a table paints the canvas', async () => {
  // the body is in an anonymous row and cell there, and the canvas looked
  // for it among the root's children only
  const { result } = await renderWithBytes(
    '<html style="display:table"><body style="position:absolute;' +
      'left:50px;top:50px;width:20px;height:20px;margin:0;' +
      'background:#00ff00"></body></html>',
    {},
  );
  const [r, g, b] = await pixelAt(result.ctx, 4, 4);
  assert.ok(g > 200 && r < 60 && b < 60, `the canvas is green: ${r},${g},${b}`);
});

test('an area the author gives a display is drawn, in its map', async () => {
  // <map> is inline (HTML 15.3.1); hidden, it took its areas with it
  const { node } = await render(
    '<map><area style="display:block;height:10px;' +
      'border:2px solid #00ff00"></map>',
  );
  const fills = await fillsOf(view(node));
  assert.ok(fills.some((f) => f.style === '#00ff00'));
});

metric(
  'a background position from the far edge is that far in from it',
  async () => {
    const { result } = await renderWithBytes(
      '<style>body { margin: 0 }</style>' +
        '<div style="width: 100px; height: 40px; ' +
        'background: url(r.png) no-repeat right 20px top 5px"></div>',
      { 'r.png': RED_PNG },
    );
    // the 10px image's right edge twenty pixels in from the box's
    const red = async (x: number, y: number) => {
      const [r, g, b] = await pixelAt(result.ctx, x, y);
      return r > 200 && g < 60 && b < 60;
    };
    await waitFor(async () =>
      assert.ok(await red(75, 10), 'in from the right'),
    );
    assert.ok(!(await red(95, 10)), 'not against the right edge');
    assert.ok(!(await red(75, 2)), 'and five down');
  },
);

// --- calc(), min(), max() and clamp() ---------------------------------------

test('calc() and its kin come down to pixels and a percentage of what layout knows', () => {
  const ctx = { em: 20, rem: 16, vw: 1000, vh: 500, scale: 1 };
  const len = (v: string) => parseLength(v, ctx);
  assert.deepStrictEqual(len('calc(100% - 20px)'), { pct: 100, px: -20 });
  assert.deepStrictEqual(len('calc((100% - 20px) / 2)'), { pct: 50, px: -10 });
  assert.deepStrictEqual(len('-webkit-calc(100% - 1px)'), { pct: 100, px: -1 });
  assert.strictEqual(len('calc(2em + 4px)'), 44);
  // `+` and `-` want white space on both sides
  assert.strictEqual(len('calc(1px+2px)'), null);
  assert.strictEqual(len('calc(100% -1px)'), null);
  // a number is no length, and a division by zero no value
  assert.strictEqual(len('calc(1 + 2)'), null);
  assert.strictEqual(len('calc(10px / 0)'), null);
  assert.strictEqual(parseNumber('calc(1 + 0.5)'), 1.5);
  // with no percentage in them, the comparisons come to a length
  assert.strictEqual(len('min(10px, 2em)'), 10);
  assert.strictEqual(len('max(10px, 2em)'), 40);
  assert.strictEqual(len('clamp(10px, 50px, 20px)'), 20);
  // with one, to a sum for each width: a column 600px at most
  const column = len('min(100%, 600px)')!;
  assert.strictEqual(resolve(column, 400), 400);
  assert.strictEqual(resolve(column, 1000), 600);
  const inset = len('calc(min(100%, 600px) - 20px)')!;
  assert.strictEqual(resolve(inset, 400), 380);
  assert.strictEqual(resolve(inset, 1000), 580);
  // taking a minimum away, or scaling it by less than nothing, turns it over
  assert.strictEqual(resolve(len('calc(100px - min(10%, 50px))')!, 1000), 50);
  assert.strictEqual(resolve(len('calc(-1 * min(100%, 50px))')!, 1000), -50);
  assert.strictEqual(len('calc(1px -(2px))'), null);
  // a percentage the sum cancels is still one against a height nothing sets
  const cancelled = len('calc(40px + 10% - 20% / 2)')!;
  assert.strictEqual(resolve(cancelled, 100), 40);
  assert.strictEqual(resolveOrNull(cancelled, NaN), null);
});

metric(
  'a calc() width, margin and padding are of the containing block',
  async () => {
    const { el } = await renderWithBytes(
      '<html><head><style>body { margin: 0; width: 400px }' +
        '#f { display: flex; width: 300px } #f > div { width: calc(50% - 10px) }' +
        '</style></head><body>' +
        '<div id="a" style="width: calc(100% - 40px); margin-left: calc(10px + 5%); ' +
        'padding-top: calc(30px - 10%); padding-left: calc(30px - 1%)">a</div>' +
        '<div id="f"><div id="f1">b</div><div>c</div></div></body></html>',
      {},
    );
    const a = boxOf(el, 'a') as unknown as {
      x: number;
      width: number;
      padTop: number;
      padLeft: number;
    };
    // the content box, less the padding the calc() on the left comes to
    assert.strictEqual(a.width, 360 + 26);
    assert.strictEqual(a.x, 30);
    // thirty pixels less forty is none: a padding is never negative
    assert.strictEqual(a.padTop, 0);
    // and one with a percentage has no sign until then
    assert.strictEqual(a.padLeft, 26);
    assert.strictEqual(boxOf(el, 'f1').width, 140);
  },
);

metric(
  "a child's width of its own is what it gives a float, and a minimum's percentage is of zero",
  async () => {
    const { el } = await renderWithBytes(
      '<html><head><style>body { font-size: 10px } body > div { float: left; clear: left }' +
        '.wide { width: 200px; height: 1px } i { display: inline-block; width: 10px }' +
        '</style></head><body>' +
        '<div id="a"><div style="width: 47px"><div class="wide"></div></div></div>' +
        '<div id="b"><div style="width: 50%"><div class="wide"></div></div></div>' +
        '<div id="c"><div style="width: 1px; min-width: calc(5em - 0%)"><div class="wide"></div></div></div>' +
        '<div id="d" style="text-indent: calc(50% - 3px)"><i></i></div></body></html>',
      {},
    );
    // its content runs past a width of its own, and counts for nothing
    assert.strictEqual(boxOf(el, 'a').width, 47);
    // a percentage is cyclic here, and the content decides
    assert.strictEqual(boxOf(el, 'b').width, 200);
    assert.strictEqual(boxOf(el, 'c').width, 50);
    // the inline-block is where its line puts it, three pixels in the margin
    assert.strictEqual(boxOf(el, 'd').width, 7);
  },
);

metric(
  'a percentage offset or minimum is of a height the containing block sets',
  async () => {
    const { el } = await renderWithBytes(
      '<html><head><style>body { margin: 0 } .fixed { height: 100px }' +
        '.inner { height: 10px }</style></head><body>' +
        '<div class="fixed"><div id="r1" style="position: relative; top: 50%" class="inner"></div></div>' +
        '<div><div id="r2" style="position: relative; top: calc(25px + 50%)" class="inner"></div></div>' +
        '<div><div id="m" style="min-height: calc(25px + 50%)"><div class="inner"></div></div></div>' +
        '</body></html>',
      {},
    );
    const y = (id: string) => boxOf(el, id).y;
    assert.strictEqual(y('r1'), 50);
    // against a height its content decides, the offset is `auto`
    assert.strictEqual(y('r2'), 100);
    // and a minimum's percentage is none, which leaves the calc() its pixels
    assert.strictEqual(boxOf(el, 'm').height, 25);
  },
);

metric('a cell whose width adds a percentage to a length is auto', async () => {
  const { el } = await renderWithBytes(
    '<html><head><style>table { table-layout: fixed; width: 500px; ' +
      'border-spacing: 0 } td { padding: 0 }</style></head><body><table><tr>' +
      '<td id="a" style="width: calc(50% + 1px)">x</td>' +
      '<td style="width: 100px">y</td></tr></table>' +
      '<table><tr><td id="b" style="width: calc(50%)">x</td>' +
      '<td>y</td></tr></table></body></html>',
    {},
  );
  assert.strictEqual(boxOf(el, 'a').width, 400);
  assert.strictEqual(boxOf(el, 'b').width, 250);
});

metric('z-index is an integer, and a calc() rounds to one', async () => {
  const { el } = await renderWithBytes(
    '<p id="a" style="z-index: 1.5">a</p>' +
      '<p id="b" style="z-index: calc(3 / 2)">b</p>' +
      '<p id="c" style="z-index: calc(-3 / 2)">c</p>',
    {},
  );
  const z = (id: string) =>
    (boxOf(el, id) as unknown as { style: { zIndex: unknown } }).style.zIndex;
  assert.strictEqual(z('a'), 'auto');
  assert.strictEqual(z('b'), 2);
  assert.strictEqual(z('c'), -1);
});

// --- custom properties and var() ----------------------------------------------

metric(
  'a custom property is inherited, and a var() reads it before the declaration is',
  async () => {
    const { el } = await renderWithBytes(
      '<html><head><style>' +
        ':root { --brand: #00ff00; --gap: 12px; --tw: 59 130 246 }' +
        '.card { --brand: #0000ff }' +
        'p { color: var(--brand); margin: var(--gap) 0; ' +
        'background-color: rgb(var(--tw) / 1); width: calc(var(--gap) * 10) }' +
        '#b { padding-left: var(--missing, 7px) }' +
        '</style></head><body><p id="a">a</p>' +
        '<div class="card"><p id="b">b</p></div></body></html>',
      {},
    );
    const style = (id: string) =>
      (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
    assert.strictEqual(style('a').color, '#00ff00');
    assert.strictEqual(style('a').marginTop, 12);
    // Tailwind 3 writes its colours this way, and `calc()` reads one too
    assert.strictEqual(style('a').backgroundColor, '#3b82f6');
    assert.strictEqual(style('a').width, 120);
    // the nearer one wins, and a fallback stands in for none
    assert.strictEqual(style('b').color, '#0000ff');
    assert.strictEqual(style('b').paddingLeft, 7);
  },
);

metric(
  'a var() with no value leaves its property unset, and a malformed one is no declaration',
  async () => {
    const { el } = await renderWithBytes(
      '<html><head><style>body { color: #00ff00 } p { margin-top: 3px }' +
        '#a { color: red; color: var(--none) }' +
        '#b { margin-top: 9px; margin-top: var(--none) }' +
        // two words where a colour goes: invalid once substituted
        '#c { --x: red; --y: blue; color: red; color: var(--x) var(--y) }' +
        // a cycle has no value, whatever its fallbacks say
        '#d { --p: var(--q, red); --q: var(--p, red); color: var(--p, #0000ff) }' +
        // and a fallback with a `;` in it makes no declaration at all
        '#e { color: #0000ff; color: var(--x,;) }' +
        '</style></head><body><p id="a">a</p><p id="b">b</p><p id="c">c</p>' +
        '<p id="d">d</p><p id="e">e</p></body></html>',
      {},
    );
    const style = (id: string) =>
      (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
    // `color` inherits, so unset is the body's
    assert.strictEqual(style('a').color, '#00ff00');
    // `margin` does not, so unset is its initial value
    assert.strictEqual(style('b').marginTop, 0);
    assert.strictEqual(style('c').color, '#00ff00');
    assert.strictEqual(style('d').color, '#0000ff');
    assert.strictEqual(style('e').color, '#0000ff');
  },
);

metric(
  ':root is the html element, not every element at the top of a fragment',
  async () => {
    const { el } = await renderWithBytes(
      '<style>:root { --c: #00ff00; margin-left: 30px } p { color: var(--c) }</style>' +
        '<p id="p">x</p>',
      {},
    );
    const p = boxOf(el, 'p') as unknown as {
      x: number;
      style: Record<string, unknown>;
    };
    // the property reaches the paragraph through the html a browser implies
    assert.strictEqual(p.style.color, '#00ff00');
    // and the paragraph does not take the root's margin as its own
    assert.strictEqual(p.style.marginLeft, 0);
  },
);

metric("a var() is read as CSS's tokenizer reads it", async () => {
  const { el } = await renderWithBytes(
    '<html><head><style>body { color: #00ff00; --k: red }' +
      // a name keeps its case
      '#a { --brand: #0000ff; --Brand: red; color: var(--brand) }' +
      // `initial` is no value, and the fallback stands in
      '#b { --k: initial; color: var(--k, #0000ff) }' +
      // a bracket closed that nothing opened is no value either
      '#c { --u: #0000ff; --u: red); color: var(--u) }' +
      // `<!--` is a token, not a `!`
      '#d { --w: #0000ff; color: red; color: var(--w, <!--) }' +
      '#e { --q: 1px <!--; margin-left: var(--q, 4px) }' +
      // an escaped name is the name it spells
      '#f { --0: #0000ff; color: var(--\\30) }' +
      '</style>' +
      // the end of a style sheet closes a var(), but a newline in a string
      // it leaves open makes a bad one
      '<style>#g { --g: #0000ff; color: var(--g</style>' +
      '<style>#h { --h: red; color: #0000ff; color: var(--h, "\n</style>' +
      '</head><body><p id="a">a</p><p id="b">b</p><p id="c">c</p><p id="d">d</p>' +
      '<p id="e">e</p><p id="f">f</p><p id="g">g</p><p id="h">h</p></body></html>',
    {},
  );
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
  for (const id of ['a', 'b', 'c', 'd', 'f', 'g', 'h']) {
    assert.strictEqual(style(id).color, '#0000ff', id);
  }
  // the value is there, and no margin: unset
  assert.strictEqual(style('e').marginLeft, 0);
});

// --- color-mix() ---------------------------------------------------------------

test('color-mix() mixes in the space it names, premultiplied and weighted', () => {
  const cases: [string, string | null][] = [
    ['color-mix(in srgb, red, blue)', '#800080'],
    ['color-mix(in srgb, red 25%, blue)', '#4000bf'],
    ['color-mix(in srgb, red, blue 75%)', '#4000bf'],
    // percentages that come to less than 100% take their share of the alpha
    ['color-mix(in srgb, red 20%, blue 20%)', 'rgba(128, 0, 128, 0.4)'],
    // premultiplied: transparent lends its alpha and not its black, which is
    // how Tailwind 4 writes `bg-blue-500/50`
    ['color-mix(in srgb, #ff0000 50%, transparent)', 'rgba(255, 0, 0, 0.5)'],
    [
      'color-mix(in oklab, oklch(0.623 0.214 259.815) 50%, transparent)',
      'rgba(43, 127, 255, 0.5)',
    ],
    ['color-mix(in oklab, white, black)', '#636363'],
    ['color-mix(in hsl, red, blue)', '#ff00ff'],
    ['color-mix(in hsl longer hue, red, blue)', '#00ff00'],
    ['color-mix(in srgb-linear, red, blue)', '#bc00bc'],
    ['color-mix(in nope, red, blue)', null],
    ['color-mix(in srgb, red 0%, blue 0%)', null],
    ['color-mix(in srgb, red 150%, blue)', null],
    ['color-mix(in srgb, red, nope)', null],
  ];
  for (const [value, want] of cases) {
    assert.strictEqual(parseColor(value), want, value);
  }
});

metric(
  'a color-mix() with currentColor in it mixes the colour where it is used',
  async () => {
    const { el, result } = await renderWithBytes(
      '<html><head><style>body { margin: 0; color: #ff0000 }' +
        '#a { color: #0000ff; height: 20px; ' +
        'background-color: color-mix(in srgb, currentColor 50%, #ff0000) }' +
        '#b { color: color-mix(in srgb, currentColor, #0000ff) }' +
        // `currentColor` in `color` is the inherited colour
        '#c { color: #0000ff; color: currentColor }' +
        'table { border-collapse: collapse; color: #0000ff } ' +
        'td { border: 10px solid color-mix(in srgb, currentColor 50%, #ff0000); ' +
        'padding: 0; width: 10px; height: 10px }' +
        '</style></head><body><div id="a"></div><p id="b">b</p><p id="c">c</p>' +
        '<table id="t"><tr><td></td></tr></table></body></html>',
      {},
    );
    const style = (id: string) =>
      (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
    assert.strictEqual(style('b').color, '#800080');
    assert.strictEqual(style('c').color, '#ff0000');
    // drawn at all is part of it: an unread mix reaching the context throws
    const purple = async (x: number, y: number) => {
      const [r, g, b] = await pixelAt(result.ctx, x, y);
      return r > 110 && r < 145 && g < 20 && b > 110 && b < 145;
    };
    await waitFor(async () => assert.ok(await purple(5, 5), 'the background'));
    const table = boxOf(el, 't');
    assert.ok(await purple(3, Math.round(table.y) + 3), 'the collapsed border');
  },
);

metric(
  'custom properties set at every level of a deep tree read the nearest',
  async () => {
    // twenty levels, each setting one: the chain an element reads through is
    // folded once it is long, and has to answer as it did before
    let open = '';
    let close = '';
    for (let i = 0; i < 20; i += 1) {
      const set =
        i === 12
          ? '--gone: initial'
          : i === 3
            ? '--gone: 30px'
            : `--d${i}: ${i}px`;
      open += `<div style="${set}">`;
      close += '</div>';
    }
    const { el } = await renderWithBytes(
      '<html><head><style>:root { --top: #00ff00; --d5: 99px }</style></head><body>' +
        open +
        '<p id="p" style="color: var(--top); margin-left: var(--d5); ' +
        'margin-right: var(--d18); padding-left: var(--gone, 4px)">x</p>' +
        close +
        '</body></html>',
      {},
    );
    const style = (
      boxOf(el, 'p') as unknown as { style: Record<string, unknown> }
    ).style;
    assert.strictEqual(style.color, '#00ff00');
    // the nearer one wins over the root's
    assert.strictEqual(style.marginLeft, 5);
    assert.strictEqual(style.marginRight, 18);
    // and `initial` twelve levels down is none, over the one set at three
    assert.strictEqual(style.paddingLeft, 4);
  },
);

// --- what a paint goes through -------------------------------------------------

metric(
  'a block with a link or a column in it is found where it is, not from the top',
  async () => {
    // An inline box is drawn on its block's lines and a column in its
    // cells, and neither has a rectangle of its own. Taken for one at
    // (0, 0), each stretched the paint bounds of the block it was in up to
    // the top of the document, and a paint low in a long document went
    // through every block above the viewport.
    const paras = Array.from(
      { length: 80 },
      (_, i) =>
        `<p id="p${i}">paragraph ${i} with <a href="#">a <b>link</b></a></p>`,
    ).join('');
    const { node } = await render(
      `<style>p{margin:0 0 20px}</style>${paras}` +
        '<table id="t"><colgroup><col><col></colgroup>' +
        '<tr><td>a</td><td>b</td></tr></table>',
    );
    const el = view(node);
    type Bounded = LaidBox & { boundsY: number; boundsHeight: number };
    for (const id of ['p40', 'p79', 't']) {
      const box = boxOf(el, id) as Bounded;
      assert.ok(
        box.boundsY >= box.y - 1 && box.boundsHeight < box.height + 20,
        `#${id}'s ink is where it is: ${box.boundsY}+${box.boundsHeight} ` +
          `for a box at ${box.y}+${box.height}`,
      );
    }
    const { queryChildIndex } = await import('../src/html/paint.js');
    const root = (
      el as unknown as {
        _tree: { root: { paintIndex: Parameters<typeof queryChildIndex>[0] } };
      }
    )._tree.root;
    assert.ok(root.paintIndex, 'eighty paragraphs are indexed');
    const at = boxOf(el, 'p60');
    const hits = queryChildIndex(root.paintIndex, at.y, at.y + at.height);
    assert.ok(
      hits.length <= 2,
      `a strip one paragraph tall meets ${hits.length} of them`,
    );
  },
);

// --- a relatively positioned inline box -----------------------------------------

/** The fragments of a paragraph's lines, each with the document text it
 *  draws and where its layout's origin is. */
function fragmentsOf(el: HtmlViewNode, id: string) {
  const text = el.textContent();
  return linesOf(el, id).flatMap((line) =>
    line.texts.map((t) => ({
      text: text.slice(t.textStart, t.textEnd),
      x: t.drawX,
      y: t.drawY,
      line: [line.y, line.height],
    })),
  );
}

metric(
  'a relatively positioned inline box moves its text, and nothing around it',
  async () => {
    // CSS 2.1 9.4.3: the box is moved after the line is laid out, so the
    // line and the text either side of it stay where they were
    const doc = (offset: string) =>
      '<style>p{margin:0}</style><p id="p">one <span ' +
      `style="position:relative;${offset}">two</span> three</p>`;
    const still = fragmentsOf(
      view((await render(doc('top:0;left:0'))).node),
      'p',
    );
    cleanup();
    const moved = fragmentsOf(
      view((await render(doc('top:10px;left:5px'))).node),
      'p',
    );
    assert.deepStrictEqual(
      moved.map((f) => f.text),
      still.map((f) => f.text),
    );
    const two = still.findIndex((f) => f.text.includes('two'));
    assert.ok(two >= 0 && still[two].text.trim() === 'two', 'laid out apart');
    for (let i = 0; i < still.length; i += 1) {
      const [dx, dy] = i === two ? [5, 10] : [0, 0];
      assert.deepStrictEqual(
        [moved[i].x - still[i].x, moved[i].y - still[i].y, moved[i].line],
        [dx, dy, still[i].line],
        `"${still[i].text}"`,
      );
    }
  },
);

metric(
  "text moved off its line is inside its paragraph's paint bounds",
  async () => {
    // a repaint of where the text went has to find the paragraph there
    const { node } = await render(
      '<style>p{margin:0}</style><p id="p">one <span ' +
        'style="position:relative;top:120px">two</span></p>',
    );
    const el = view(node);
    const p = boxOf(el, 'p') as LaidBox & {
      boundsY: number;
      boundsHeight: number;
    };
    const two = fragmentsOf(el, 'p').find((f) => f.text === 'two')!;
    assert.ok(two.y >= p.y + 100, 'moved down');
    assert.ok(
      p.boundsY + p.boundsHeight >= two.y + 10,
      `bounds to ${p.boundsY + p.boundsHeight}, text at ${two.y}`,
    );
  },
);

metric(
  "a relatively positioned inline box's background goes with it",
  async () => {
    const doc = (offset: string) =>
      '<style>p{margin:0}</style><p id="p">one <span ' +
      `style="position:relative;background:#00ff00;${offset}">two</span> ` +
      '<b style="background:#0000ff">three</b></p>';
    const fills = async (offset: string) =>
      (await fillsOf(view((await render(doc(offset))).node))).filter(
        (f) => f.style === '#00ff00' || f.style === '#0000ff',
      );
    const still = await fills('top:0;left:0');
    cleanup();
    const moved = await fills('top:-6px;left:4px');
    assert.strictEqual(still.length, 2);
    assert.deepStrictEqual(
      moved.map((f) => [f.style, f.x, f.y, f.w, f.h]),
      [
        ['#00ff00', still[0].x + 4, still[0].y - 6, still[0].w, still[0].h],
        ['#0000ff', still[1].x, still[1].y, still[1].w, still[1].h],
      ],
    );
  },
);

metric(
  'a superscript raised as Tailwind and normalize.css raise it',
  async () => {
    // `sup { position: relative; top: -0.5em; vertical-align: baseline }`:
    // the line keeps its height, and the figure is half its own em higher
    const doc = (raise: string) =>
      '<style>p{margin:0;font-size:16px}' +
      `sup{font-size:75%;line-height:0;vertical-align:baseline;${raise}}` +
      '</style><p id="p">E = mc<sup>2</sup> and more</p>';
    const still = fragmentsOf(
      view((await render(doc('position:relative;top:0'))).node),
      'p',
    );
    cleanup();
    const raised = fragmentsOf(
      view((await render(doc('position:relative;top:-0.5em'))).node),
      'p',
    );
    const two = still.findIndex((f) => f.text === '2');
    assert.ok(two >= 0, 'the figure is laid out apart');
    assert.strictEqual(raised[two].y - still[two].y, -6);
    assert.deepStrictEqual(
      raised.map((f) => f.line),
      still.map((f) => f.line),
    );
  },
);

metric(
  'a block in a relatively positioned inline box moves with it',
  async () => {
    // it stands outside the pieces of the box it broke in two, and the
    // box's offset moves it all the same (CSS 2.1 9.2.1.1)
    const doc = (offset: string) =>
      '<style>body{margin:0}</style><div><span ' +
      `style="position:relative;${offset}">a<div id="b">block</div>c</span>` +
      '</div>';
    const at = async (offset: string) => {
      const b = boxOf(view((await render(doc(offset))).node), 'b');
      return [b.x, b.y, b.width];
    };
    const still = await at('top:0;left:0');
    cleanup();
    const moved = await at('top:5px;left:30px');
    assert.deepStrictEqual(moved, [still[0] + 30, still[1] + 5, still[2]]);
  },
);

// --- visibility on inline content ------------------------------------------------

/** How many pixels of each of three colours a laid-out element covers. */
async function inkIn(
  result: { ctx: unknown },
  el: HtmlViewNode,
  id: string,
): Promise<{ red: number; green: number; blue: number }> {
  const box = boxOf(el, id);
  const abs = (el as unknown as { abs: { x: number; y: number } }).abs;
  const data: Uint8ClampedArray = await new Promise((ok, fail) =>
    (
      result.ctx as {
        getImageData(
          x: number,
          y: number,
          w: number,
          h: number,
          cb: (e: unknown, d: { data: Uint8ClampedArray }) => void,
        ): void;
      }
    ).getImageData(
      Math.round(abs.x + box.x),
      Math.round(abs.y + box.y),
      Math.ceil(box.width),
      Math.ceil(box.height),
      (e, d) => (e ? fail(e) : ok(d.data)),
    ),
  );
  const seen = { red: 0, green: 0, blue: 0 };
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (r > 200 && g < 60 && b < 60) seen.red += 1;
    if (g > 200 && r < 60 && b < 60) seen.green += 1;
    if (b > 200 && r < 60 && g < 60) seen.blue += 1;
  }
  return seen;
}

metric(
  'hidden inline text is not drawn, and visible text inside it is',
  async () => {
    // `visibility: hidden` leaves the text its room and draws none of it,
    // and a descendant can be visible again (CSS 2.1 11.2)
    const style =
      '<style>body{margin:0}p,div{margin:0 0 10px;font:bold 30px/40px ' +
      'sans-serif;color:#ff0000}</style>';
    const width = (el: HtmlViewNode, id: string) =>
      linesOf(el, id).reduce((w, line) => Math.max(w, line.width), 0);
    const bare = await renderWithBytes(style + '<p id="a">III</p>', {});
    const alone = await inkIn(bare.result, bare.el, 'a');
    const aloneWidth = width(bare.el, 'a');
    cleanup();

    const { result, el } = await renderWithBytes(
      style +
        '<p id="a">III<span style="visibility:hidden"> IIII</span></p>' +
        '<p id="b"><span style="visibility:hidden">III <b ' +
        'style="visibility:visible;color:#00ff00">III</b></span></p>' +
        '<div id="c" style="visibility:hidden">III <span ' +
        'style="visibility:visible;color:#0000ff">III</span></div>',
      {},
    );
    const [a, b, c] = await Promise.all(
      ['a', 'b', 'c'].map((id) => inkIn(result, el, id)),
    );
    assert.ok(a.red > 0, 'the visible text is drawn');
    assert.ok(
      width(el, 'a') > aloneWidth * 2,
      'the hidden text keeps its room',
    );
    assert.strictEqual(a.red, alone.red, 'and none of the hidden text is');
    assert.deepStrictEqual([b.red > 0, b.green > 0], [false, true]);
    assert.deepStrictEqual([c.red > 0, c.blue > 0], [false, true]);
  },
);

// --- vertical-align on text --------------------------------------------------------

/** Each fragment's text and the baseline it is drawn on. */
function baselinesOf(el: HtmlViewNode, id: string) {
  const text = el.textContent();
  return linesOf(el, id).flatMap((line) =>
    line.texts.map((t) => ({
      text: text.slice(t.textStart, t.textEnd),
      at: t.drawY + t.layout.lines[t.layoutLine].baseline,
      line: line.y + (line as unknown as { baseline: number }).baseline,
    })),
  );
}

metric('<sup> and <sub> are raised and lowered off the line', async () => {
  // the UA sheet's `vertical-align: super` and `sub`: a third and a fifth
  // of the parent's font size and a pixel, as browsers set them
  const { node } = await render(
    '<style>p{margin:0;font-size:16px}</style>' +
      '<p id="p">E = mc<sup>2</sup> and H<sub>2</sub>O</p>',
  );
  const all = baselinesOf(view(node), 'p');
  const two = all.filter((f) => f.text === '2');
  assert.strictEqual(two.length, 2, 'both figures laid out apart');
  const [sup, sub] = two;
  const base = all.find((f) => f.text.startsWith('E'))!;
  assert.strictEqual(base.at, base.line, 'the text around them is on it');
  assert.ok(Math.abs(base.line - sup.at - (16 / 3 + 1)) < 0.01, 'super');
  assert.ok(Math.abs(sub.at - base.line - (16 / 5 + 1)) < 0.01, 'sub');
});

metric(
  'a raised box makes its line taller, unless its line height is none',
  async () => {
    const heightWith = async (sup: string) => {
      const { node } = await render(
        `<style>p{margin:0;font-size:16px;line-height:20px}sup{${sup}}</style>` +
          '<p id="p">E = mc<sup>2</sup></p>',
      );
      const lines = linesOf(view(node), 'p');
      cleanup();
      return lines[0].height;
    };
    // the paragraph's own line height, 20px, is the line's with nothing
    // in it taller
    assert.ok((await heightWith('')) > 20, 'the raised figure takes room');
    // Tailwind's preflight and normalize.css give it none
    assert.strictEqual(await heightWith('line-height:0'), 20);
  },
);

metric(
  'vertical-align takes a length, a percentage of the line height, and the edges of the font',
  async () => {
    const { node } = await render(
      '<style>p{margin:0;font-size:16px;line-height:20px}' +
        '#a{vertical-align:6px}#b{vertical-align:-50%}' +
        '#c{vertical-align:text-top;font-size:8px;line-height:8px}' +
        '#d{vertical-align:text-bottom;font-size:8px;line-height:8px}' +
        '</style>' +
        '<p id="p">x <span id="a">a</span> <span id="b">b</span> ' +
        '<span id="c">c</span> <span id="d">d</span></p>',
    );
    const all = baselinesOf(view(node), 'p');
    const at = (t: string) => all.find((f) => f.text === t)!;
    const line = at('a').line;
    assert.ok(Math.abs(line - at('a').at - 6) < 0.01, 'a length raises');
    assert.ok(Math.abs(at('b').at - line - 10) < 0.01, 'half the line lowers');
    // an eight-pixel box's top at the sixteen-pixel font's top, and its
    // bottom at that font's bottom
    assert.ok(at('c').at < line - 4, 'text-top is high');
    assert.ok(at('d').at > line, 'text-bottom is low');
  },
);

metric(
  "an image set middle is centred on its parent's x-height, not on its line",
  async () => {
    // CSS 2.1 10.8.1: its middle half the parent's x-height above the
    // baseline, wherever a taller image beside it puts the line's middle
    const { node } = await render(
      '<style>p{margin:0;font-size:16px;line-height:20px}</style>' +
        '<p id="a">x<img id="m" width="10" height="30" src="x.png" ' +
        'style="vertical-align:middle"></p>' +
        '<p id="b">x<img width="10" height="60" src="x.png">' +
        '<img id="n" width="10" height="30" src="x.png" ' +
        'style="vertical-align:middle"></p>',
    );
    const el = view(node);
    const above = (img: string, p: string) => {
      const box = boxOf(el, img);
      const [line] = linesOf(el, p);
      const { baseline } = line as unknown as { baseline: number };
      return line.y + baseline - (box.y + box.height / 2);
    };
    const alone = above('m', 'a');
    assert.ok(alone > 0 && alone < 8, `half an x-height up: ${alone}`);
    assert.ok(
      Math.abs(above('n', 'b') - alone) < 0.01,
      `and there beside a taller image: ${above('n', 'b')}`,
    );
  },
);

metric(
  'text-transform: capitalize takes the first letter of each word',
  async () => {
    // CSS Text 3, 2.1: punctuation a word starts with is not its first
    // letter, and a word runs on across an element's edge
    const { node } = await render(
      '<p style="text-transform:capitalize">(p.p.) <b>fo</b>o ' +
        "well-known don't x.y 3rd éa a&#xA0;b ǆa ᾀa ßa</p>",
    );
    const text = view(node).textContent();
    // in title case, which is not upper case for a letter that is two
    assert.ok(
      text.includes(
        "(P.p.) Foo Well-Known Don't X.y 3rd Éa A\u00a0B ǅa ᾈa Ssa",
      ),
      JSON.stringify(text),
    );
  },
);

metric(
  "a raised box's background is drawn around its raised text",
  async () => {
    const fills = async (align: string) => {
      const { node } = await render(
        '<style>p{margin:0;font-size:16px;line-height:30px}</style>' +
          // no line height of its own, so that the line stays where it is
          '<p id="p">x <span style="background:#00ff00;line-height:0;' +
          `vertical-align:${align}">y</span></p>`,
      );
      const out = (await fillsOf(view(node))).filter(
        (f) => f.style === '#00ff00',
      );
      cleanup();
      return out;
    };
    const [flat] = await fills('baseline');
    const [raised] = await fills('8px');
    assert.deepStrictEqual(
      [raised.x, raised.y, raised.w, raised.h],
      [flat.x, flat.y - 8, flat.w, flat.h],
    );
  },
);

metric(
  "a top-aligned box's background is drawn around its own text",
  async () => {
    // its baseline is where the line's top puts it, not the line's: in a line
    // made tall by its paragraph, the background stayed on the paragraph's
    // baseline while the text went up
    const around = async (align: string) => {
      const { node } = await render(
        '<style>p{margin:0;font-size:16px;line-height:40px}</style>' +
          '<p id="p">a <span id="s" style="background:#00ff00;line-height:1;' +
          `vertical-align:${align}">x</span></p>`,
      );
      const el = view(node);
      const [fill] = (await fillsOf(el)).filter((f) => f.style === '#00ff00');
      // on the baseline it is laid out with the text before it
      const x = baselinesOf(el, 'p').find((f) => f.text.includes('x'))!;
      cleanup();
      return x.at - fill.y;
    };
    assert.ok(
      Math.abs((await around('top')) - (await around('baseline'))) < 0.01,
      'as far above its baseline as on the baseline',
    );
  },
);

metric(
  'a box whose padding reaches up over the line before is drawn over its text',
  async () => {
    // CSS 2.1 Appendix E paints a block a line at a time, backgrounds first:
    // the second line's padding covers the first line's text
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<p style="margin:0;font-size:16px;line-height:20px">first line<br>' +
        '<span style="background:#00ff00;padding-top:20px">second</span></p>',
    );
    const ops: PaintOp[] = [];
    await fillsOf(view(node), ops);
    const text = ops.findIndex((op) => op.op === 'text');
    const again = ops.findIndex(
      (op, i) => i > text && op.op === 'fill' && op.style === '#00ff00',
    );
    assert.ok(text >= 0 && again > text, 'filled again after the text');
    const clip = ops
      .slice(text, again)
      .reverse()
      .find((op): op is Extract<PaintOp, { op: 'clip' }> => op.op === 'clip');
    assert.ok(
      clip && clip.y + clip.h <= 21,
      `only above its own line: ${JSON.stringify(clip)}`,
    );
  },
);

metric(
  'a top-aligned box sits at the top of its line, as tall as all it holds',
  async () => {
    // its baseline is its tallest content's ascent below the line's top,
    // the big letter in it included (CSS 2.1 10.8.1)
    const { node } = await render(
      '<style>p{margin:0;font-size:16px;line-height:40px}' +
        '#t{vertical-align:top;font-size:10px;line-height:10px}' +
        '#big{font-size:30px;line-height:30px}</style>' +
        '<p id="p">x <span id="t">t<span id="big">B</span></span></p>',
    );
    const el = view(node);
    const all = baselinesOf(el, 'p');
    const [line] = linesOf(el, 'p');
    // the box's text on one baseline, whether the big letter is a fragment
    // of its own (its box has a line height of its own) or not
    const t = all.find((f) => f.text.startsWith('t'))!;
    const big = all.find((f) => f.text.includes('B'))!;
    assert.ok(Math.abs(t.at - big.at) < 0.01, `${t.at} and ${big.at}`);
    // the big letter's ascent, not the box's own small font's, from the top
    assert.ok(t.at - line.y > 20, `${t.at - line.y} below the line's top`);
    assert.ok(t.at < all.find((f) => f.text.startsWith('x'))!.at);
  },
);

metric(
  'an image set top beside text leaves the text at the top of the line',
  async () => {
    // where the baseline goes in a line a `top` or `bottom` box made taller
    // than the rest is left open (CSS 2.1 10.8.1). Browsers keep it where
    // the rest of the line puts it, under its top, unless a `bottom` box is
    // the taller; the text was centred in what the image left
    const { node } = await render(
      '<style>p{margin:0;font-size:16px}' +
        'img{width:96px;height:96px}</style>' +
        '<p id="t"><img style="vertical-align:top">Filler</p>' +
        '<p id="b"><img style="vertical-align:bottom">Filler</p>',
    );
    const el = view(node);
    const [top] = linesOf(el, 't');
    const [bottom] = linesOf(el, 'b');
    assert.strictEqual(top.height, 96);
    assert.ok(top.baseline < 20, `under the line's top: ${top.baseline}`);
    assert.ok(bottom.baseline > 80, `at its foot: ${bottom.baseline}`);
  },
);

metric(
  "a raised text's underline from outside it stays on the line's baseline",
  async () => {
    // `vertical-align` moves the text, not the lines an element outside it
    // draws through it; an underline the raised box sets itself goes with
    // it (CSS Text Decoration 3, 2.1)
    const rules = async (inner: string) => {
      const { node } = await render(
        '<style>p{margin:0;font-size:16px;line-height:40px;' +
          'text-decoration:underline;text-decoration-color:#ff00ff}' +
          'span{text-decoration-color:#00ffff}</style>' +
          `<p id="p">aaa <span style="vertical-align:10px;${inner}">bbb</span> ccc</p>`,
      );
      const fills = await fillsOf(view(node));
      cleanup();
      return fills;
    };
    const outside = (await rules('')).filter((f) => f.style === '#ff00ff');
    assert.ok(outside.length >= 2, 'the underline is drawn');
    assert.strictEqual(
      new Set(outside.map((f) => f.y)).size,
      1,
      'all of it on one line',
    );
    // the longhand: `text-decoration: underline` would reset the colour
    // the sheet gave the span, as a shorthand does
    const own = await rules('text-decoration-line:underline');
    const a = own.find((f) => f.style === '#ff00ff')!;
    const b = own.find((f) => f.style === '#00ffff')!;
    assert.ok(Math.abs(a.y - b.y - 10) <= 1, 'the raised one goes with it');
  },
);

// --- what is in the head ------------------------------------------------------------

test('the head is shown where a stylesheet says so, as a browser shows it', async () => {
  // `display: none` by the UA sheet, like the rest of what has no box of
  // its own, and no longer skipped whatever the stylesheet said
  const { node } = await render(
    '<html><head><meta name="x" content="PASS"><title>T</title>' +
      '<style>head, meta { display: block } meta::before { content: attr(content) }</style>' +
      '</head><body><p>body</p></body></html>',
  );
  const text = view(node).textContent();
  assert.ok(text.includes('PASS'), `the meta's ::before is drawn: ${text}`);
  assert.ok(!text.includes('T\n') && !text.startsWith('T'), 'the title is not');
  assert.ok(text.includes('body'));
});

test('head content with no <head> around it stays hidden, as in the head a browser implies', async () => {
  const { node } = await render(
    '<title>Title</title><style>* { display: block }</style><p>body</p>',
  );
  const text = view(node).textContent();
  assert.ok(!text.includes('Title'), `no title: ${text}`);
  assert.ok(!text.includes('display'), 'no stylesheet');
  assert.ok(text.includes('body'));
});

metric('a negative inline margin takes room back on its line', async () => {
  // `margin-right: -30px` pulls what follows the span back over it, so the
  // last word fits beside it (CSS 2.1 8.3); taken for no margin, it wrapped
  const lines = async (margin: string) => {
    const { node } = await render(
      '<style>p{margin:0;font:10px monospace;width:60px}</style>' +
        '<p id="p">aaaa <span style="margin-right:' +
        margin +
        '">bbbb</span> cccc</p>',
    );
    const found = linesOf(view(node), 'p');
    cleanup();
    return found;
  };
  assert.strictEqual((await lines('0')).length, 2);
  const [pulled, ...rest] = await lines('-30px');
  assert.strictEqual(rest.length, 0, 'one line');
  // and laid out a piece at a time, where a positive margin is a spacer in
  // one layout: CoreText's typesetter breaks before a space whose letter
  // spacing is negative, and only this suite's engine does not
  assert.ok(pulled.texts.length > 1, 'in pieces');
});

// --- an image in generated content ----------------------------------------------------

metric(
  'an image generated content names is drawn, at its size, among its text',
  async () => {
    // `content: url(…)` was dropped from the value: the rest was drawn and
    // the image was not (CSS 2.1 12.2). It is asked for as a background image
    // is, and a host that answers at once is answered in the same pass.
    const ctx = await renderWithImages(
      '<style>body{margin:0;font:10px/10px monospace}' +
        'p{margin:0;color:#0000ff}p::before{content:url(red.png) "x"}</style>' +
        '<p>y</p>',
    );
    await expectPixel(ctx, 5, 5, '#ff0000', {
      message: 'the ten-pixel square, first on the line',
    });
    const [r, g, b] = await pixelAt(ctx, 14, 5);
    assert.ok(
      b > 150 && r < 100,
      `the text after it, beside it: ${r},${g},${b}`,
    );
  },
);

test('content: url() is an item of the value, and a bad url is no value', async () => {
  const { parseContent } = await import('../src/html/css/content.js');
  assert.deepStrictEqual(parseContent('url(a.png) "b"'), [
    { kind: 'url', url: 'a.png' },
    { kind: 'string', text: 'b' },
  ]);
  assert.deepStrictEqual(parseContent('url("a b.png")'), [
    { kind: 'url', url: 'a b.png' },
  ]);
  assert.strictEqual(parseContent('url(a b.png)'), null);
});

// --- unicode-bidi -------------------------------------------------------------------

metric(
  'unicode-bidi overrides and embeds as its controls do, and they are no text',
  async () => {
    // carried out as the bidi controls it stands for, which are laid out
    // and are no text of the document's: the text, a caret and a
    // selection skip them (CSS Writing Modes 3, 2.4.2)
    const { node } = await render(
      '<p style="margin:0">ab<span style="direction:rtl;unicode-bidi:bidi-override">' +
        'cde</span>fg <bdo dir="rtl">hij</bdo></p>',
    );
    const el = view(node);
    assert.strictEqual(el.textContent(), 'abcdefg hij');
    const at = (i: number) => el.textCaretRect(i)!.x;
    // `cde` is drawn `edc`: before `d` is right of before `e`. The carets
    // at the run's two ends are the engine's to place, on either side.
    assert.ok(at(3) > at(4), `d at ${at(3)}, e at ${at(4)}`);
    // and the text on either side reads on
    assert.ok(at(1) < at(3) && at(6) < at(7));
    // `<bdo dir="rtl">` overrides by the UA sheet's rule
    assert.ok(at(9) > at(10), `i at ${at(9)}, j at ${at(10)}`);
  },
);

test('HTML isolates what has a dir of its own, and a <bdo> overrides', async () => {
  const { node } = await render(
    '<p id="a" dir="rtl">x</p><span id="b" dir="ltr">y</span>' +
      '<bdi id="c">z</bdi><bdo id="d" dir="rtl">w</bdo>',
  );
  const el = view(node);
  const of = (id: string) =>
    (boxOf(el, id) as unknown as { style: { unicodeBidi: string } }).style
      .unicodeBidi;
  assert.deepStrictEqual(['a', 'b', 'c', 'd'].map(of), [
    'isolate',
    'isolate',
    'plaintext',
    'isolate-override',
  ]);
});

// --- white-space on an element, where its block wraps ----------------------------

/** The document text of each line a paragraph was laid out in. */
function lineTextsOf(el: HtmlViewNode, id: string): string[] {
  const text = el.textContent();
  return linesOf(el, id).map((line) =>
    line.texts.map((t) => text.slice(t.textStart, t.textEnd)).join(''),
  );
}

metric(
  "a nowrap element's words stay together, and it may break after its end",
  async () => {
    const { node } = await render(
      '<style>p{margin:0;font:10px monospace}</style>' +
        '<p id="a" style="width:50px">xx <span style="white-space:nowrap">aaa bbb</span> ccc</p>' +
        '<p id="b" style="width:0"><span style="white-space:nowrap">AA </span> BB</p>',
    );
    const el = view(node);
    const a = lineTextsOf(el, 'a');
    assert.ok(
      a.some((line) => line.includes('aaa bbb')),
      `aaa and bbb on one line: ${JSON.stringify(a)}`,
    );
    // the space the element ends on is its block's to break after
    assert.deepStrictEqual(
      lineTextsOf(el, 'b').map((line) => line.trim()),
      ['AA', 'BB'],
    );
  },
);

metric(
  'a word too long for its line runs past it unless the style cuts it',
  async () => {
    // CSS Text 3, 5.5: `overflow-wrap: normal`, the initial value, lets a
    // word wider than its line run past the line's end, as a browser does;
    // `break-word` or `anywhere`, `word-break: break-all` or `break-word`
    // whatever `overflow-wrap` says, cut it. Every such word was cut.
    const word = 'Pneumonoultramicroscopicsilicovolcanoconiosis';
    const { node } = await render(
      '<style>body{margin:0} p{margin:0;width:100px}</style>' +
        `<p id="a">${word}</p>` +
        `<p id="b" style="overflow-wrap:break-word">${word}</p>` +
        `<p id="c" style="word-break:break-word;overflow-wrap:normal">${word}</p>` +
        `<div style="word-break:break-all"><p id="d">${word}</p></div>` +
        // the engine cuts a paragraph's words or none, so a span that asks
        // for it has them cut
        `<p id="e">a <span style="overflow-wrap:anywhere">${word}</span></p>`,
    );
    const el = view(node);
    const a = linesOf(el, 'a');
    assert.strictEqual(a.length, 1, 'whole');
    assert.ok(a[0].width > 100, `past the line's end: ${a[0].width}`);
    for (const id of ['b', 'c', 'd', 'e']) {
      const lines = linesOf(el, id);
      assert.ok(lines.length > 1, `${id}: cut`);
      assert.ok(
        lines.every((line) => line.width <= 100.5),
        `${id}: within the line`,
      );
    }
  },
);

metric(
  'a space that collapses between two nowrap elements is a break',
  async () => {
    // CSS Text 3, 4.1.1: a space after another collapses away and keeps its
    // chance to wrap where its own element wraps, so the lines break between
    // the elements. They ran on as one word, cut where the line ran out.
    const spans = Array.from(
      { length: 8 },
      (_, i) => `<span style="white-space:nowrap">w${i} </span>`,
    );
    const { node } = await render(
      '<style>p{margin:0;font:10px monospace}</style>' +
        `<p id="a" style="width:100px">${spans.join(' ')}</p>`,
    );
    const lines = lineTextsOf(view(node), 'a').map((line) => line.trim());
    assert.ok(lines.length > 1, JSON.stringify(lines));
    for (const line of lines) {
      assert.match(line, /^w\d(\sw\d)*$/, JSON.stringify(lines));
    }
  },
);

metric('a nowrap element does not break at its hyphens', async () => {
  // CSS Text 3, 5.1: no break inside an element that does not wrap, at a
  // space or anywhere else. Its spaces were held; a hyphen was still a
  // place to break, and `whitespace-nowrap` on "state-of-the-art" broke
  // inside it.
  const { node } = await render(
    '<style>p{margin:0;font:10px monospace;width:100px}</style>' +
      '<p id="a">a <span style="white-space:nowrap">state-of-the-art</span> ' +
      'design</p>',
  );
  // whole on a line of its own: the line before cannot take it
  const a = lineTextsOf(view(node), 'a').map((line) => line.trim());
  assert.deepStrictEqual(a.slice(0, 2), ['a', 'state-of-the-art'], `${a}`);
});

metric(
  'a word too long for the room beside a float goes below it whole',
  async () => {
    // CSS 2.1 9.5: a line with too little room beside the floats for its
    // first word moves down past them. A word kept whole ran past the room,
    // over the float's side of the paragraph, and stayed beside it.
    const { node } = await render(
      '<style>body{margin:0}</style><div style="width:200px">' +
        '<div style="float:left;width:150px;height:30px"></div>' +
        '<p id="p" style="margin:0">Supercalifragilistic words</p></div>',
    );
    const [line] = linesOf(view(node), 'p');
    assert.ok(line.y >= 30, `below the float: ${line.y}`);
    assert.strictEqual(line.x, 0);
  },
);

metric('a kept tab goes to its stop', async () => {
  // a tab was a space wide in ntk and at CoreText's own stops, 28 points
  // apart: code indented with tabs, and columns a tab apart, did not line
  // up. A stop is every `tab-size` spaces from the line's start, and one
  // less than half a `ch` on is passed over (CSS Text 3, 4.2)
  const { node } = await render(
    '<style>body{margin:0}pre,div{margin:0;font:10px monospace}</style>' +
      '<pre id="a">\tA\n\t\tB\nab\tC\nabcdefghij\tD</pre>' +
      '<pre style="tab-size:4">four\n\tE\nab\tF</pre>' +
      '<pre style="-moz-tab-size:20px">px\nxxx\tG</pre>' +
      '<div style="white-space:pre-wrap">wrap\nab\tH</div>',
  );
  const el = view(node);
  const text = el.textContent();
  assert.ok(text.includes('\t\tB'), 'the document keeps its tabs');
  // from the start of the letter's own line, which is given
  const x = (letter: string, line: string) =>
    el.textCaretRect(text.indexOf(letter))!.x -
    el.textCaretRect(text.indexOf(line))!.x;
  const ch = x('D', 'abcdefghij') / 16;
  const at = (letter: string, line: string, chars: number) =>
    assert.ok(
      Math.abs(x(letter, line) - chars * ch) < 0.5,
      `${letter} at ${x(letter, line) / ch} characters, not ${chars}`,
    );
  at('A', '\tA', 8);
  at('B', '\t\tB', 16);
  at('C', 'ab\tC', 8);
  at('E', '\tE', 4);
  at('F', 'ab\tF', 4);
  at('H', 'ab\tH', 8);
  // three letters are less than half a character short of 20px, so the
  // tab goes on to 40
  assert.ok(20 - 3 * ch < ch / 2, `the case the rule is for, at ${ch}px`);
  const g = x('G', 'xxx');
  assert.ok(Math.abs(g - 40) < 0.5, `G at ${g}px`);
});

metric('a tab is set from where the room before it ends', async () => {
  // the edges of an inline box and the spacing of a word before a tab
  // move it: its stop is counted from where it is drawn, with them
  const { node, result } = await render(
    '<style>body{margin:0}pre{margin:0;padding:0;font:10px monospace}' +
      '.w{word-spacing:13px}</style>' +
      '<pre id="p">one\na<span style="padding-left:13px">b</span>\tX\n' +
      'a<span class="w"> </span>b\tY\nabcdefghij</pre>',
  );
  const el = view(node);
  const text = el.textContent();
  const x = (index: number) => el.textCaretRect(index)!.x;
  const left = x(text.indexOf('abcdefghij'));
  const ch = (x(text.indexOf('abcdefghij') + 10) - left) / 10;
  const stop = (from: number) => {
    let at = (Math.floor(from / (8 * ch)) + 1) * 8 * ch;
    if (at - from < ch / 2) at += 8 * ch;
    return at;
  };
  const expect = (letter: string, from: number) => {
    const got = x(text.indexOf(letter)) - left;
    assert.ok(
      Math.abs(got - stop(from)) < 0.5,
      `${letter} at ${got}, not ${stop(from)}`,
    );
  };
  expect('X', 2 * ch + 13);
  expect('Y', 3 * ch + 13);
  // and from the runs the engine drew, not from its carets: CoreText sets
  // a caret after a spaced glyph part of the way into its spacing. An
  // engine whose carets are all astray draws the same runs
  type Runs = { lines: { x: number; runs: { x: number; start: number }[] }[] };
  const drawn = () =>
    linesOf(el, 'p').flatMap((line) =>
      line.texts.flatMap((placed) => {
        const natural = (placed.layout as unknown as Runs).lines[
          placed.layoutLine
        ];
        return natural.runs.map(
          (run) =>
            `${run.start}@${(placed.drawX + natural.x + run.x).toFixed(2)}`,
        );
      }),
    );
  const before = drawn();
  const fonts = (result.app as unknown as { fonts: FontsLike }).fonts;
  const astray: FontsLike = {
    layout: (...args) => {
      const layout = fonts.layout(...args);
      const caretPosition = layout.caretPosition.bind(layout);
      layout.caretPosition = (index: number) => ({
        ...caretPosition(index),
        x: caretPosition(index).x + 1000,
      });
      return layout;
    },
    match: (...args) => fonts.match(...args),
  };
  const { layoutDocument } = await import('../src/html/layout/block.js');
  const tree = (el as unknown as { _tree: unknown })._tree;
  layoutDocument(tree as never, astray, 400, 600);
  assert.deepStrictEqual(drawn(), before);
});

test('the font-variant longhands, font-kerning and font-feature-settings are read', async () => {
  const { node } = await render(
    '<p id="a" style="font-variant-numeric:tabular-nums slashed-zero">a</p>' +
      '<p id="b" style="font-variant:small-caps oldstyle-nums">b</p>' +
      '<p id="c" style="font-variant-ligatures:none;font-kerning:none">c</p>' +
      '<p id="d" style="font-feature-settings:&quot;liga&quot; 0, ' +
      '&quot;ss01&quot;">d</p>' +
      '<p id="e" style="font-variant-numeric:tabular-nums small-caps">e</p>' +
      '<div style="font-variant-numeric:tabular-nums">' +
      '<p id="f" style="font:small-caps 12px serif">f</p><p id="g">g</p></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: ComputedStyle }).style;
  assert.strictEqual(style('a').fontVariantNumeric, 'tnum=1,zero=1');
  assert.strictEqual(style('b').fontVariantCaps, 'smcp=1');
  assert.strictEqual(style('b').fontVariantNumeric, 'onum=1');
  assert.strictEqual(
    style('c').fontVariantLigatures,
    'liga=0,clig=0,dlig=0,hlig=0,calt=0',
  );
  assert.strictEqual(style('c').fontKerning, 'kern=0');
  assert.strictEqual(style('d').fontFeatureSettings, 'liga=0,ss01=1');
  // a keyword of another longhand is no value of this one
  assert.strictEqual(style('e').fontVariantNumeric, '');
  // the `font` shorthand sets the variants back, save its small capitals,
  // and what it does not set is inherited
  assert.strictEqual(style('f').fontVariantNumeric, '');
  assert.strictEqual(style('f').fontVariantCaps, 'smcp=1');
  assert.strictEqual(style('g').fontVariantNumeric, 'tnum=1');
});

test("a style's features: the variants', then the settings', one object for each set", () => {
  // the six fields it reads
  const style = (fields: Partial<ComputedStyle>) =>
    ({
      fontVariantNumeric: '',
      fontVariantCaps: '',
      fontVariantLigatures: '',
      fontVariantPosition: '',
      fontKerning: '',
      fontFeatureSettings: '',
      ...fields,
    }) as ComputedStyle;
  assert.strictEqual(featuresOf(style({})), null, 'none at all');
  const tabular = featuresOf(
    style({
      fontVariantNumeric: 'tnum=1',
      fontFeatureSettings: 'tnum=0,ss01=1',
    }),
  );
  assert.deepStrictEqual(tabular, { tnum: 0, ss01: 1 }, 'the settings last');
  assert.strictEqual(
    featuresOf(
      style({
        fontVariantNumeric: 'tnum=1',
        fontFeatureSettings: 'tnum=0,ss01=1',
      }),
    ),
    tabular,
    'the same object, so that a run is found by it',
  );
});

metric('text is shaped with the features its style asks for', async () => {
  const { node } = await render(
    '<p id="p" style="font-variant-numeric:tabular-nums">1234</p>' +
      '<p id="q">1234</p>',
  );
  const el = view(node);
  type Spans = { lines: { runs: { span?: { features?: unknown } }[] }[] };
  const features = (id: string) => {
    const [line] = linesOf(el, id);
    const layout = line.texts[0].layout as unknown as Spans;
    return layout.lines[line.texts[0].layoutLine].runs[0].span?.features;
  };
  assert.deepStrictEqual(features('p'), { tnum: 1 });
  assert.strictEqual(features('q'), undefined);
});

test('a shadow down a box far off the window is cut to what the paint reaches', async () => {
  // Its outline goes to the server in 16.16 fixed point, and a shadow cast
  // down a box tens of thousands of pixels tall, scrolled far, threw from
  // the paint. Cut where the blur cannot reach what is painted, as a
  // background is.
  const { node } = await render(
    '<style>body{margin:0}</style><div style="position:relative;' +
      'top:-40000px;height:50000px;margin:10px;border-radius:12px;' +
      'box-shadow:0 8px 30px #0006, inset 0 0 12px #ff0000"></div>',
  );
  const fills = await fillsOf(view(node));
  const shadows = fills.filter((f) => f.shadow);
  assert.strictEqual(shadows.length, 2, 'the outer shadow and the inset');
  for (const f of fills) {
    for (const v of [f.x, f.y, f.x + f.w, f.y + f.h]) {
      assert.ok(Math.abs(v) < 32768, `${f.x},${f.y} ${f.w}x${f.h}`);
    }
  }
});

test('text-shadow is read, inherited, and has no spread and no inset', async () => {
  const { node } = await render(
    '<div id="a" style="text-shadow:1px 2px 3px red, blue 4px 5px">' +
      '<p id="b">b</p></div>' +
      '<p id="c" style="text-shadow:1px 2px 3px 4px red">c</p>' +
      '<p id="d" style="text-shadow:inset 1px 2px red">d</p>' +
      '<p id="e" style="text-shadow:1px 1px red;text-shadow:none">e</p>',
  );
  const el = view(node);
  const shadows = (id: string) =>
    (boxOf(el, id) as unknown as { style: { textShadow: unknown } }).style
      .textShadow;
  const red = parseColor('red');
  const blue = parseColor('blue');
  assert.deepStrictEqual(shadows('a'), [
    { x: 1, y: 2, blur: 3, spread: 0, color: red, inset: false },
    { x: 4, y: 5, blur: 0, spread: 0, color: blue, inset: false },
  ]);
  assert.strictEqual(shadows('b'), shadows('a'), 'inherited');
  assert.strictEqual(shadows('c'), null, 'a spread is no text shadow');
  assert.strictEqual(shadows('d'), null, 'nor is inset');
  assert.strictEqual(shadows('e'), null);
});

metric('text casts its shadows under it, the last first', async () => {
  // it cast none. Each is the layout drawn clear of the window with its
  // shadow offset back, so that only the shadow lands; a hard one is
  // blurred too little to see, as CoreGraphics casts none without a blur
  const { node } = await render(
    '<style>body{margin:0}p{margin:0;font-size:20px}</style>' +
      '<p id="h" style="text-shadow:1px 2px 3px #ff0000, 4px 5px 0 #0000ff">' +
      'Title</p><p id="p">plain</p>' +
      '<p style="text-shadow:0 1px #00ff00">Title</p>' +
      '<p id="m">plain <span id="s" style="text-shadow:0 0 2px #ff0000">' +
      'lit</span> plain</p>',
  );
  const el = view(node);
  const ops: PaintOp[] = [];
  await fillsOf(el, ops);
  const texts = ops.filter(
    (op): op is Extract<PaintOp, { op: 'text' }> => op.op === 'text',
  );
  const [line] = linesOf(el, 'h');
  const at = line.texts[0].drawX;
  const [blue, red, title] = texts;
  assert.ok(blue.shadow && red.shadow && !title.shadow, 'two, then the text');
  assert.strictEqual(title.x, at);
  assert.deepStrictEqual(
    [blue.shadow!.color, blue.x + blue.shadow!.x, blue.shadow!.y],
    ['#0000ff', at + 4, 5],
    'the last, and so the lowest, where it falls',
  );
  assert.ok(blue.shadow!.blur > 0 && blue.shadow!.blur < 0.1, 'hard');
  assert.deepStrictEqual(
    [red.shadow!.color, red.x + red.shadow!.x, red.shadow!.blur],
    ['#ff0000', at + 1, 3],
  );
  assert.ok(red.x + line.width < 0, 'the glyphs clear of the window');
  // a paragraph that casts none draws once, and one whose span casts a
  // shadow draws it clipped to the span
  const plain = texts.filter((op) => !op.shadow);
  assert.strictEqual(plain.length, 4, 'each paragraph once');
  // a paragraph of the same runs shares the first's layout, and casts its
  // own shadow, not the first's
  assert.ok(
    texts.some((op) => op.shadow?.color === '#00ff00'),
    "the second's own",
  );
  // the span's shadow, which alone has a blur of 2
  const shadowed = ops.findIndex(
    (op) => op.op === 'text' && op.shadow?.blur === 2,
  );
  const clip = ops[shadowed - 1];
  assert.ok(clip?.op === 'clip', 'the span clipped');
  const text = el.textContent();
  const from = el.textCaretRect(text.indexOf('lit'))!.x;
  const to = el.textCaretRect(text.indexOf('lit') + 3)!.x;
  assert.ok(
    clip.x <= from && clip.x + clip.w >= to && clip.w < to - from + 20,
    `to the span and its blur: ${clip.x}..${clip.x + clip.w}, ${from}..${to}`,
  );
});

test('tab-size is a number of spaces, or a length', async () => {
  const { node } = await render(
    '<pre id="a" style="tab-size:4">a</pre>' +
      '<pre id="b" style="tab-size:2em;font-size:10px">b</pre>' +
      '<pre id="c" style="-moz-tab-size:3">c</pre>' +
      '<pre id="d" style="tab-size:-1">d</pre>' +
      '<div style="tab-size:5"><pre id="e">e</pre></div>',
  );
  const el = view(node);
  const tab = (id: string) => {
    const { tabSize, tabSizeIsLength } = (
      boxOf(el, id) as unknown as {
        style: { tabSize: number; tabSizeIsLength: boolean };
      }
    ).style;
    return [tabSize, tabSizeIsLength];
  };
  assert.deepStrictEqual(tab('a'), [4, false]);
  assert.deepStrictEqual(tab('b'), [20, true]);
  assert.deepStrictEqual(tab('c'), [3, false]);
  assert.deepStrictEqual(tab('d'), [8, false], 'none below nought');
  assert.deepStrictEqual(tab('e'), [5, false], 'inherited');
});

metric(
  'a raised box is as tall on its line as its own face makes it',
  async () => {
    // a `<sup>` holding a smaller `<a>` — every footnote mark — made its
    // line no taller than the `<a>` did, and an empty raised box none; each
    // inline box is on the line with its own line height (CSS 2.1 10.8)
    const { node } = await render(
      '<style>body{margin:0;font:16px/1.6 serif}p{margin:0}</style>' +
        '<p id="plain">text</p>' +
        '<p id="mark">text<sup><a style="font-size:11px">1</a></sup></p>' +
        '<p id="sup">text<sup>1</sup></p>' +
        '<p id="empty">text<span style="vertical-align:super"></span></p>' +
        '<p id="full">text<span style="vertical-align:super">x</span></p>',
    );
    const el = view(node);
    const height = (id: string) => boxOf(el, id).height;
    assert.ok(height('sup') > height('plain') + 0.5, 'a raised mark');
    assert.ok(
      Math.abs(height('mark') - height('sup')) < 0.01,
      `the sup's own: ${height('mark')} against ${height('sup')}`,
    );
    assert.ok(
      Math.abs(height('empty') - height('full')) < 0.01,
      `an empty one's: ${height('empty')} against ${height('full')}`,
    );
  },
);

metric("pre's trailing spaces take room, where a line's hang", async () => {
  const widthOf = async (text: string) => {
    const { node } = await render(
      '<style>div{display:inline-block;font:10px monospace}</style>' +
        `<div id="d"><span style="white-space:pre">${text}</span></div>`,
    );
    const width = boxOf(view(node), 'd').width;
    cleanup();
    return width;
  };
  const bare = await widthOf('ab');
  const spaced = await widthOf('ab  ');
  assert.ok(spaced > bare * 1.8, `${spaced} against ${bare}`);
});

// --- clearance and the margins of an empty block -----------------------------------

test('an empty cleared block ends its parent where its collapsed margin ends', async () => {
  // its margins collapse to one, 140px, and its top border edge is its top
  // margin's 40px inside it, where clearance puts it: below the float
  // (CSS 2.1 8.3.1, 10.6.3). The parent is the float and the other 100px:
  // the margin is not spent in the clearance
  const { node } = await render(
    '<style>body{margin:0}#p{border-top:1px solid}' +
      '#f{float:left;width:10px;height:100px}' +
      '#c{clear:left;margin:40px 0 140px}' +
      '#s{margin-bottom:140px}</style>' +
      '<div id="p"><div id="f"></div><div id="c"></div></div>' +
      '<div id="q" style="border-top:1px solid"><div id="f2" ' +
      'style="float:left;width:10px;height:100px"></div>' +
      '<div style="clear:left;margin:40px 0 80px"></div><div id="s"></div></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'p').height, 201, 'the border and 200px');
  // and one that following empty blocks' margins collapse with
  assert.strictEqual(boxOf(el, 'q').height, 201);
});

test('a block that clears a float placed before any content is under it', async () => {
  // A float placed before anything fixed where its parent's content is
  // would go down with a margin collapsing up through the parent's top,
  // were `clear` none, so a block that clears it always has clearance:
  // its border edge goes under the float whatever its margin, and the
  // parent is the two of them (CSS 2.1 9.5.2, as the browsers read it).
  // The margin put it 400px below the float, the parent's background
  // showing between.
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="p" style="width:100px"><div><div id="f" style="float:left;' +
      'width:100px;height:50px"></div></div><div id="c" style="clear:left;' +
      'margin-top:400px;height:50px"></div></div>',
  );
  const el = view(node);
  const [p, f, c] = ['p', 'f', 'c'].map((id) => boxOf(el, id));
  assert.strictEqual(c.y, f.y + 50, 'under the float');
  assert.strictEqual(p.height, 100);
});

test('a margin that takes a cleared block past the floats is any margin', async () => {
  // with no clearance, nothing parts the block's margin from its parent's,
  // and it goes on up through the parent's top: stopped at the block, it
  // left the parent where it was, and its background showed above it
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="float:left;width:100px;height:100px"></div>' +
      '<div style="padding-top:1px"><div id="r"><div id="c" style="clear:left;' +
      'margin-top:150px;height:10px"></div></div></div>',
  );
  const el = view(node);
  const [r, c] = ['r', 'c'].map((id) => boxOf(el, id));
  assert.strictEqual(c.y, 151, 'its margin below the padding');
  assert.strictEqual(r.y, c.y, 'and the parent moved with it');
});

// --- an inline box's own line height -------------------------------------------------

metric("an empty inline box's line height makes its line taller", async () => {
  // every inline box is on its line as tall as its own line height, text
  // or none (CSS 2.1 10.8): an empty span of 100px lines before the text
  // was on a line of its own after it, and the text's line was 20px. A
  // line of nothing but empty boxes is no line (9.4.2), unless one of them
  // has a border or a margin, whatever the two add up to
  const { node } = await render(
    '<style>body{margin:0} div{line-height:1;font-size:20px}</style>' +
      '<div id="t"><span style="line-height:5"></span>X</div>' +
      '<div id="e"><span style="line-height:5"></span></div>' +
      '<div id="m"><span style="line-height:5;border-left:10px solid;' +
      'margin-left:-10px"></span></div>',
  );
  const el = view(node);
  const lines = linesOf(el, 't');
  assert.strictEqual(lines.length, 1, 'one line');
  assert.strictEqual(lines[0].height, 100);
  assert.strictEqual(boxOf(el, 'e').height, 0, 'no line');
  assert.strictEqual(boxOf(el, 'm').height, 100, 'a line');
});

metric("an inline box's own line height makes its line taller", async () => {
  // CSS gives every inline box its own line height, and the line box holds
  // them all (CSS 2.1 10.8.1): a span of 60px lines in a paragraph of 20px
  // ones makes the line a paragraph of 60px lines has
  const lineWith = async (p: string, markup: string) => {
    const { node } = await render(
      `<style>p{margin:0;font-size:16px;${p}}</style><p id="p">${markup}</p>`,
    );
    const el = view(node);
    const [line] = linesOf(el, 'p');
    const texts = baselinesOf(el, 'p');
    cleanup();
    return {
      height: line.height,
      baseline: texts[0].line - line.y,
      apart: texts.filter((t) => Math.abs(t.at - t.line) > 0.01).length,
    };
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const tall = await lineWith('line-height:60px', 'a b c');
  const held = await lineWith(
    'line-height:20px',
    'a <span style="line-height:60px">b</span> c',
  );
  assert.ok(near(held.height, 60), `${held.height}`);
  assert.ok(near(held.baseline, tall.baseline), 'the text in its middle');
  assert.strictEqual(held.apart, 0, 'every text on the one baseline');
  // the box is on the line whatever is in it: text in a box of 20px lines
  // inside it is set in its 60px
  const nested = await lineWith(
    'line-height:20px',
    'a <span style="line-height:60px"><em style="line-height:20px">b</em></span> c',
  );
  assert.ok(near(nested.height, 60), `${nested.height}`);
  assert.ok(near(nested.baseline, tall.baseline));
  // and one with less than its paragraph's is inside the paragraph's
  const less = await lineWith(
    'line-height:20px',
    'a <span style="line-height:10px">b</span> c',
  );
  assert.ok(near(less.height, 20), `${less.height}`);
});

// --- a minimum height, and the margin below ----------------------------------------

test("a height a minimum sets spends its last child's margin", async () => {
  // the margin neither escapes the box nor makes it taller, as browsers
  // have it: the next block starts where the box's height ends
  const nextAfter = async (parent: string, child: string) => {
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        `<div id="p" style="${parent}"><div style="${child}"></div></div>` +
        '<div id="n" style="height:10px"></div>',
    );
    const el = view(node);
    const out = [boxOf(el, 'p').height, boxOf(el, 'n').y];
    cleanup();
    return out;
  };
  assert.deepStrictEqual(
    await nextAfter('min-height:50px', 'height:49px;margin-bottom:10px'),
    [50, 50],
  );
  // one that leaves the height as it was leaves the margin to collapse
  // through the box's bottom, as it does through any
  assert.deepStrictEqual(
    await nextAfter('min-height:20px', 'height:49px;margin-bottom:10px'),
    [49, 59],
  );
  // and so does a maximum, as CSS 2.1 8.3.1 has it
  assert.deepStrictEqual(
    await nextAfter('max-height:50px', 'height:51px;margin-bottom:10px'),
    [50, 60],
  );
});

// --- a formatting context's margins beside a float ---------------------------------

test("a formatting context's margins are its containing block's, beside a float", async () => {
  // CSS 2.1 9.5 keeps the border box off the floats, and the margins are
  // the containing block's: one on the float's side overlaps the float
  // (the WPT suite's floats-wrap-bfc-with-margin tests)
  const placed = async (float: string, box: string) => {
    const { node } = await render(
      '<style>body{margin:0}</style><div style="width:600px">' +
        `<div style="float:${float};width:200px;height:50px"></div>` +
        `<div id="b" style="overflow:hidden;height:20px;${box}"></div></div>`,
      700,
    );
    const b = boxOf(view(node), 'b');
    const out = [b.x, b.y, b.width];
    cleanup();
    return out;
  };
  // a column beside a sidebar, its margin the sidebar's width and a gap
  assert.deepStrictEqual(
    await placed('left', 'margin-left:220px'),
    [220, 0, 380],
  );
  // and one narrower than the float starts at the float
  assert.deepStrictEqual(
    await placed('left', 'margin-left:20px'),
    [200, 0, 400],
  );
  assert.deepStrictEqual(
    await placed('right', 'margin-right:220px'),
    [0, 0, 380],
  );
  // a margin at the end runs past the room; one at the start that pushes
  // the box into the float puts it below the float
  assert.deepStrictEqual(
    await placed('left', 'width:400px;margin-right:10px'),
    [200, 0, 400],
  );
  assert.deepStrictEqual(
    await placed('right', 'margin-left:401px'),
    [401, 50, 199],
  );
});

test('a negative margin that reaches a float outside its containing block', async () => {
  // the float is beside the containing block, and the margin takes the
  // box over it: it goes below the float rather than under it
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px">' +
      '<div style="float:left;width:50px;height:50px"></div>' +
      '<div style="margin-left:50px"><div id="b" style="overflow:hidden;' +
      'width:100px;height:50px;margin-left:-50px"></div></div></div>',
  );
  const b = boxOf(view(node), 'b');
  assert.deepStrictEqual([b.x, b.y], [0, 50]);
  cleanup();
  // a float of no width has nothing to overlap, and is passed over
  const { node: zero } = await render(
    '<style>body{margin:0}</style><div style="width:100px;margin-left:50px">' +
      '<div style="float:left;width:0;height:50px"></div>' +
      '<div id="b" style="overflow:hidden;height:50px;margin-left:-50px">' +
      '</div></div>',
  );
  const z = boxOf(view(zero), 'b');
  assert.deepStrictEqual([z.x, z.y, z.width], [0, 0, 150]);
});

// --- display: flow-root ----------------------------------------------------------

test('display: flow-root makes a formatting context of its own', async () => {
  // the clearfix CSS Display 3 gives a name to, and Tailwind's `flow-root`:
  // it holds its floats, and its children's margins stay inside it
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="r" style="display:flow-root">' +
      '<div style="float:left;width:10px;height:40px"></div>' +
      '<div style="margin-top:15px;height:5px"></div></div>' +
      '<div id="n" style="height:10px"></div>',
  );
  const el = view(node);
  const [r, n] = [boxOf(el, 'r'), boxOf(el, 'n')];
  assert.deepStrictEqual([r.y, r.height], [0, 40], 'it holds the float');
  assert.strictEqual(n.y, 40);
  // and a later `display` takes it back
  const { node: again } = await render(
    '<style>body{margin:0}#r{display:flow-root}#r{display:block}</style>' +
      '<div id="r"><div style="float:left;width:10px;height:40px"></div>' +
      '</div>',
  );
  assert.strictEqual(boxOf(view(again), 'r').height, 0);
});

// --- a box on the pixel grid -------------------------------------------------------

test('a box is painted with each edge on the pixel it falls nearest', async () => {
  // as browsers snap a box: a rule 1pt wide is one pixel, not two, and two
  // boxes that meet at a fraction of one share the column their edge is
  // in, rather than both painting it
  const { node } = await render(
    '<style>body{margin:0}div{float:left;height:10px}</style>' +
      '<div style="width:1pt;background:#ff0000"></div>' +
      '<div style="width:10.4px;background:#00ff00"></div>' +
      '<div style="width:10.4px;background:#0000ff"></div>',
  );
  const fills = await fillsOf(view(node));
  const [red, green, blue] = ['#ff0000', '#00ff00', '#0000ff'].map((c) => {
    const found = fills.find((f) => f.style === parseColor(c));
    assert.ok(found, `a fill in ${c}`);
    return found;
  });
  assert.deepStrictEqual(
    [red.w, green.x - red.x, green.w, blue.x - green.x],
    [1, 1, 11, 11],
  );
});

// --- the newline after <pre> ---------------------------------------------------------

metric(
  'a newline straight after a <pre> start tag is no part of its text',
  async () => {
    // HTML's parser drops it as an authoring convenience (13.2.6.4.7), so a
    // code block written `<pre>` and a line break starts on its first line
    // of code, and a second newline is a blank line
    const { node } = await render(
      '<pre id="p">\nfirst\n  second</pre><pre id="q">\n\nafter a blank</pre>' +
        '<pre id="r">\r\ncrlf</pre>',
    );
    const el = view(node);
    assert.deepStrictEqual(lineTextsOf(el, 'p'), ['first\n', '  second']);
    assert.deepStrictEqual(lineTextsOf(el, 'q'), ['\n', 'after a blank']);
    assert.deepStrictEqual(lineTextsOf(el, 'r'), ['crlf']);
    assert.ok(!el.textContent().startsWith('\n'), 'nor of the document');
  },
);

// --- logical properties ----------------------------------------------------------

/** A laid box's resolved edges and style, which `LaidBox` leaves out. */
function edgesOf(box: LaidBox) {
  return box as unknown as {
    padLeft: number;
    padRight: number;
    padTop: number;
    padBottom: number;
    borderLeft: number;
    marginLeft: number;
    marginRight: number;
    style: { borderRadius: number[] };
  };
}

test("logical properties are the physical ones of the element's direction", async () => {
  // CSS Logical Properties 1 in the horizontal writing mode: Tailwind 4
  // writes its spacing in them, `px-4` as `padding-inline` and `mx-auto`
  // as `margin-inline: auto`
  const { node } = await render(
    '<style>body{margin:0}.px-4{padding-inline:calc(4px * 4)}' +
      '.py-2{padding-block:8px}.mx-auto{margin-inline:auto}</style>' +
      '<div style="width:400px"><div id="a" class="px-4 py-2 mx-auto" ' +
      'style="inline-size:100px;border-inline-start:3px solid"></div>' +
      '<div id="r" dir="rtl" style="margin-inline-start:10px;' +
      'padding-inline:1px 2px;border-start-end-radius:6px"></div>' +
      '<div id="o" style="padding-left:5px;padding-inline-start:7px;' +
      'margin-inline-end:4px;margin-right:9px"></div>' +
      '<div id="x" style="padding-inline:10px -5px;padding-block:1px 2px 3px">' +
      '</div></div>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  const ae = edgesOf(a);
  assert.deepStrictEqual(
    [ae.padLeft, ae.padRight, ae.padTop, ae.padBottom, ae.borderLeft, a.width],
    [16, 16, 8, 8, 3, 135],
  );
  assert.strictEqual(a.x, (400 - 135) / 2, 'centred by its auto margins');
  const r = edgesOf(boxOf(el, 'r'));
  assert.deepStrictEqual(
    [r.marginRight, r.marginLeft, r.padRight, r.padLeft],
    [10, 0, 1, 2],
    'the start is the right, right to left',
  );
  assert.deepStrictEqual(r.style.borderRadius, [6, 0, 0, 0], 'and the corner');
  const o = edgesOf(boxOf(el, 'o'));
  assert.deepStrictEqual(
    [o.padLeft, o.marginRight],
    [7, 9],
    'whichever of the two comes later',
  );
  const x = edgesOf(boxOf(el, 'x'));
  assert.deepStrictEqual(
    [x.padLeft, x.padRight, x.padTop, x.padBottom],
    [0, 0, 0, 0],
    'a part that is no value takes the declaration with it',
  );
});

test('inset sets all four offsets, and a corner its radius', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="position:relative;width:200px;height:100px">' +
      '<div id="f" style="position:absolute;inset:0"></div>' +
      '<div id="g" style="position:absolute;inset:10px 20px"></div></div>' +
      '<div id="c" style="border-top-left-radius:8px;' +
      'border-bottom-right-radius:4px 2px"></div>',
  );
  const el = view(node);
  const [f, g] = [boxOf(el, 'f'), boxOf(el, 'g')];
  assert.deepStrictEqual([f.x, f.y, f.width, f.height], [0, 0, 200, 100]);
  assert.deepStrictEqual([g.x, g.y, g.width, g.height], [20, 10, 160, 80]);
  assert.deepStrictEqual(
    edgesOf(boxOf(el, 'c')).style.borderRadius,
    [8, 0, 4, 0],
  );
});

// --- cascade layers --------------------------------------------------------------

test('a later cascade layer wins over an earlier one, and no layer over any', async () => {
  // CSS Cascade 5: Tailwind 4 writes all of its CSS in `@layer theme,
  // base, components, utilities`, which was dropped whole
  const colorOf = async (css: string, markup = '<p id="p" class="x">x</p>') => {
    const { node } = await render(`<style>${css}</style>${markup}`);
    const style = (
      boxOf(view(node), 'p') as unknown as { style: { color: string } }
    ).style;
    cleanup();
    return style.color;
  };
  const red = '#ff0000';
  const blue = '#0000ff';
  // the order the layers are first named in, not their specificity
  assert.strictEqual(
    await colorOf(
      '@layer a, b; @layer b { .x { color: #0000ff } } ' +
        '@layer a { p#p.x { color: #ff0000 } }',
    ),
    blue,
  );
  assert.strictEqual(
    await colorOf(
      '.x { color: #0000ff } @layer a { p#p.x { color: #ff0000 } }',
    ),
    blue,
    'a rule in no layer over one in any',
  );
  assert.strictEqual(
    await colorOf(
      '@layer a { .x { color: #ff0000 !important } } ' +
        '@layer b { .x { color: #0000ff !important } } .x { color: #008000 !important }',
    ),
    red,
    'and the other way round for !important',
  );
  assert.strictEqual(
    await colorOf(
      '@layer a { .x { color: #ff0000 } @layer b { p#p.x { color: #0000ff } } }',
    ),
    red,
    "a layer's own rules over the layers in it",
  );
  assert.strictEqual(
    await colorOf(
      '',
      '<style>@layer b, a;</style><style>@layer a { .x { color: #ff0000 } } ' +
        '@layer b { .x { color: #0000ff } }</style><p id="p" class="x">x</p>',
    ),
    red,
    "the order is the document's, across its sheets",
  );
  assert.strictEqual(
    await colorOf(
      '@layer { .x { color: #ff0000 } } @layer { .x { color: #0000ff } }',
    ),
    blue,
    'a layer with no name is one of its own',
  );
});

// --- nesting, and media ranges ----------------------------------------------------

test('a nested rule is relative to its parent, and a nested @media holds for it', () => {
  // CSS Nesting 1, as Tailwind 4 writes its variants: `md:flex` is a
  // `@media` inside the rule, and `hover:` is `&:hover`
  const sheet = parseStylesheet(
    '.md\\:flex { @media (width >= 48rem) { display: flex } }\n' +
      '.hover\\:x { &:hover { @media (hover: hover) { color: red } } }\n' +
      '.space { :where(& > :not(:last-child)) { margin: 1px } }\n' +
      '.card { color: blue; .title { color: red } > p { margin: 0 }' +
      ' &.on, &:focus { color: green } }\n' +
      '.a, .b { & + & { margin: 2px } }\n' +
      '.x { --x: { a: b }; div& { color: red } &div { color: red } }',
  );
  assert.deepStrictEqual(
    sheet.rules.map((r) => [r.selector, JSON.stringify(r.media)]),
    [
      ['.md\\:flex', '[[{"min":768}]]'],
      ['.hover\\:x:hover', '[[{"staticPass":true}]]'],
      [':where(:is(.space) > :not(:last-child))', 'null'],
      ['.card', 'null'],
      ['.card .title', 'null'],
      ['.card > p', 'null'],
      ['.card.on', 'null'],
      ['.card:focus', 'null'],
      [':is(.a) + :is(.a)', 'null'],
      [':is(.b) + :is(.b)', 'null'],
      ['.x', 'null'],
      // `&div` has its type after the rest of its compound, which is no
      // selector, and goes; `div&` is the way to write it
      ['div:is(.x)', 'null'],
    ],
  );
  // in the order they are written, after the parent's own declarations
  const orders = sheet.rules.map((r) => r.order);
  assert.deepStrictEqual(
    orders,
    [...orders].sort((a, b) => a - b),
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

test('a nested rule and a media range reach the document', async () => {
  const { node } = await render(
    '<style>body{margin:0}.p { padding-left: 1px; & { padding-top: 2px }' +
      ' @media (width >= 300px) { padding-right: 3px }' +
      ' @media (width < 300px) { padding-bottom: 4px }' +
      ' .c { margin-left: 5px } }</style>' +
      '<div id="p" class="p"><div id="c" class="c"></div></div>',
  );
  const el = view(node);
  const p = edgesOf(boxOf(el, 'p'));
  assert.deepStrictEqual(
    [p.padLeft, p.padTop, p.padRight, p.padBottom],
    [1, 2, 3, 0],
  );
  assert.strictEqual(edgesOf(boxOf(el, 'c')).marginLeft, 5);
});

// --- flex items ------------------------------------------------------------------

test('a flex and a grid property is inherited, and set back to its initial value', async () => {
  // `inherit`, `initial` and `unset` reached none of them: `align-self:
  // inherit` in the suite's flex boxes was `auto`
  const { node } = await render(
    '<div style="display:flex;flex-flow:column wrap;justify-content:center;' +
      'align-items:flex-end;align-self:center;align-content:space-between;' +
      'flex:2 3 40px;order:4;gap:6px 8px;grid-template-columns:10px 20px;' +
      'justify-items:center;grid-column:2 / 3">' +
      '<div id="a" style="flex-flow:inherit;justify-content:inherit;' +
      'align-items:inherit;align-self:inherit;align-content:inherit;' +
      'flex:inherit;order:inherit;gap:inherit;' +
      'grid-template-columns:inherit;justify-items:inherit;' +
      'grid-column:inherit"></div>' +
      '<div id="b" style="flex-direction:row-reverse;order:3;flex-grow:2;' +
      'order:initial;flex-grow:initial;flex-direction:unset"></div></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: Record<string, unknown> }).style;
  const a = style('a');
  assert.strictEqual(a.flexDirection, 'column');
  assert.strictEqual(a.flexWrap, 'wrap');
  assert.strictEqual(a.justifyContent, 'center');
  assert.strictEqual(a.alignItems, 'flex-end');
  assert.strictEqual(a.alignSelf, 'center');
  assert.strictEqual(a.alignContent, 'space-between');
  assert.deepStrictEqual([a.flexGrow, a.flexShrink, a.flexBasis], [2, 3, 40]);
  assert.strictEqual(a.order, 4);
  assert.deepStrictEqual([a.rowGap, a.columnGap], [6, 8]);
  assert.ok(a.gridColumns !== null, 'the template');
  assert.strictEqual(a.justifyItems, 'center');
  const b = style('b');
  assert.strictEqual(b.order, 0);
  assert.strictEqual(b.flexGrow, 0);
  assert.strictEqual(b.flexDirection, 'row');
});

metric(
  'flex items are painted in `order`, and by a `z-index` of their own',
  async () => {
    // CSS Flexbox 5.4: an item paints as an inline block does, in `order`,
    // and a `z-index` makes it a stacking context unpositioned
    const { node } = await render(
      '<style>body{margin:0} .r{display:flex} .r>div{width:40px;' +
        'height:20px;margin-right:-20px}</style>' +
        '<div class="r"><div style="order:2;background:#ff0000"></div>' +
        '<div style="order:1;background:#00ff00"></div></div>' +
        '<div class="r"><div style="z-index:2;background:#0000ff"></div>' +
        '<div style="z-index:1;background:#ffff00"></div></div>',
    );
    const fills = await fillsOf(view(node));
    const at = (color: string) =>
      fills.findIndex((f) => f.style === parseColor(color));
    assert.ok(at('#00ff00') < at('#ff0000'), 'the second in `order` over');
    assert.ok(at('#ffff00') < at('#0000ff'), 'the higher `z-index` over');
  },
);

metric(
  "a flex box's background goes with the flow's, and its items with its lines",
  async () => {
    // CSS 2.1 Appendix E: a block-level flex box's background and borders
    // are painted with the other blocks', in the document's order, and its
    // items as inline blocks are, over all of them — painted whole in its
    // place, it covered the block after it that a negative margin drew up
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="display:flex;height:40px;background:#ff0000">' +
        '<div style="width:20px;background:#0000ff"></div></div>' +
        '<div style="height:40px;margin-top:-40px;background:#00ff00"></div>',
    );
    const fills = await fillsOf(view(node));
    const at = (color: string) =>
      fills.findIndex((f) => f.style === parseColor(color));
    assert.ok(at('#ff0000') < at('#00ff00'), 'the next block over the box');
    assert.ok(at('#00ff00') < at('#0000ff'), 'and the item over both');
  },
);

metric(
  "justify-content's start, end, left and right follow the flex box's direction",
  async () => {
    // CSS Box Alignment 3, 6.1: `start` and `end` are the writing mode's,
    // so a reversed row turns them round; `left` and `right` are the
    // page's along a row, and `start` along a column. Read as the main
    // axis's own ends, `right` put a column's items at its bottom
    const place = async (css: string) => {
      const { node } = await render(
        '<style>body{margin:0} .f{display:flex;width:100px;height:100px}' +
          '.f>div{width:20px;height:20px}</style>' +
          `<div class="f" style="${css}"><div id="i"></div></div>`,
      );
      const box = boxOf(view(node), 'i');
      cleanup();
      return [box.x, box.y];
    };
    assert.deepStrictEqual(
      await place('flex-direction:column;justify-content:right'),
      [0, 0],
    );
    assert.deepStrictEqual(
      await place('flex-direction:row-reverse;justify-content:start'),
      [0, 0],
    );
    assert.deepStrictEqual(
      await place('flex-direction:row-reverse;justify-content:right'),
      [80, 0],
    );
    assert.deepStrictEqual(
      await place('direction:rtl;justify-content:left'),
      [0, 0],
    );
    assert.deepStrictEqual(
      await place('flex-direction:column-reverse;justify-content:end'),
      [0, 80],
    );
    assert.deepStrictEqual(
      await place('justify-content:unsafe center'),
      [40, 0],
    );
  },
);

metric(
  'a replaced flex item is the size the flex layout makes it',
  async () => {
    // An image was measured as nothing wide — its content's width, of which
    // it has none — and then laid out at its natural size whatever the
    // flex layout said: it did not grow, stretch or shrink. It grows, as
    // tall as its ratio makes the width it grew to (CSS Flexbox 9.4, step
    // 7), and stretches; it shrinks no further than its natural width; a
    // line of a definite height that stretches it gives it the width its
    // ratio makes of that height; and `flex-basis: content` is its
    // content's width whatever width it has
    const { node } = await render(
      '<style>body{margin:0} .r{display:flex;width:200px}</style>' +
        '<div class="r"><canvas id="a" width="20" height="10" ' +
        'style="flex-grow:1"></canvas></div>' +
        '<div class="r" style="width:10px"><canvas id="b" width="60" ' +
        'height="60"></canvas></div>' +
        '<div class="r" style="height:50px"><canvas id="c" width="20" ' +
        'height="150"></canvas></div>' +
        '<div class="r"><div id="d" style="flex-basis:content;width:0">' +
        '<span style="display:inline-block;width:30px"></span></div></div>',
    );
    const el = view(node);
    const size = (id: string) => {
      const box = boxOf(el, id);
      return [box.width, box.height];
    };
    assert.deepStrictEqual(size('a'), [200, 100], 'grown along its row');
    assert.deepStrictEqual(size('b'), [60, 60], 'not shrunk under its width');
    const [width, height] = size('c');
    assert.strictEqual(height, 50, 'stretched across its line');
    assert.ok(Math.abs(width - (50 * 20) / 150) < 0.01, `${width}`);
    assert.strictEqual(size('d')[0], 30, "its content's width, not its own");
  },
);

metric('flex items are laid out in `order`', async () => {
  // CSS Flexbox 5.4: `order` first, the document's where it is the same;
  // an `order` that is no integer is no value
  const { node } = await render(
    '<style>body{margin:0} .r{display:flex} .r>div{width:20px;height:10px}' +
      '</style><div class="r"><div id="a" style="order:2"></div>' +
      '<div id="b"></div><div id="c" style="order:-1"></div>' +
      '<div id="d" style="order:1.5"></div></div>',
  );
  const el = view(node);
  const x = (id: string) => boxOf(el, id).x;
  assert.deepStrictEqual(
    ['a', 'b', 'c', 'd'].map(x),
    [60, 20, 0, 40],
    'c, then b and d as they come, then a',
  );
});

metric(
  'flex items aligned by their baselines line up their first lines',
  async () => {
    // Yoga has no baseline for an item it measures, and lined them up by
    // their bottoms; a line of them is as tall as their baselines make it,
    // and a box that wraps sets one at its line's start below its margin
    const { node } = await render(
      '<style>body{margin:0} .r{display:flex;align-items:baseline;width:300px}' +
        '.r>div{width:60px}</style>' +
        '<div class="r" id="row"><div id="a" style="font-size:40px;' +
        'line-height:40px">A</div><div id="b" style="font-size:10px;' +
        'line-height:10px;padding-bottom:40px">b</div></div>' +
        '<div class="r" id="wrap" style="flex-wrap:wrap;align-items:flex-start;' +
        'width:120px"><div id="c" style="margin-top:10px;height:8px"></div>' +
        '<div style="height:30px"></div><div style="height:16px"></div></div>',
    );
    const el = view(node);
    const baseline = (id: string) => {
      const [line] = linesOf(el, id);
      return line.y + line.baseline;
    };
    assert.ok(
      Math.abs(baseline('a') - baseline('b')) < 0.01,
      `${baseline('a')} and ${baseline('b')}`,
    );
    const row = boxOf(el, 'row');
    const b = boxOf(el, 'b');
    assert.ok(b.y > row.y, 'the small one lower');
    assert.ok(
      Math.abs(row.y + row.height - (b.y + b.height)) < 0.01,
      'and the line as tall as it reaches',
    );
    assert.strictEqual(
      boxOf(el, 'c').y - boxOf(el, 'wrap').y,
      10,
      'its margin above it',
    );
  },
);

metric("an inline flex box sits on its first item's baseline", async () => {
  // CSS Flexbox 8.5: its first line's items aligned by their baselines, or
  // its first item — not its last line box, as an inline block does
  const { node } = await render(
    '<style>body{margin:0}</style><div id="p">x<span id="f" ' +
      'style="display:inline-flex"><span style="font-size:10px;' +
      'line-height:10px">b</span><span style="font-size:30px;' +
      'line-height:30px">C</span></span></div>',
  );
  const el = view(node);
  const [line] = linesOf(el, 'p');
  const flex = boxOf(el, 'f');
  const small = flex.children[0] as unknown as { lines: PlacedLine[] };
  const [first] = small.lines;
  assert.ok(
    Math.abs(first.y + first.baseline - (line.y + line.baseline)) < 0.01,
    'the small item on the line',
  );
});

metric(
  "a flex item takes its padding once, and its content's width",
  async () => {
    // Yoga holds an item's padding and adds it itself, so the measure answers
    // inside it; an item of `width: auto` is as wide as its content (CSS
    // Flexbox 9.2), not a share of the row
    const place = async (items: string, width = 700) => {
      const { node } = await render(
        '<style>body{margin:0;font:14px/20px sans-serif}.r{display:flex;' +
          'gap:12px}.r>div{padding:12px}</style>' +
          `<div class="r">${items}</div>`,
        width,
      );
      const el = view(node);
      const out = ['a', 'b'].map((id) => {
        const b = boxOf(el, id);
        return { x: b.x, width: b.width, height: b.height };
      });
      cleanup();
      return out;
    };
    const [a, b] = await place(
      '<div id="a">Install</div><div id="b">Run</div>',
    );
    assert.strictEqual(a.height, 44, '12 + 20 + 12, not the padding twice');
    assert.ok(a.width < 100, `as wide as its word and padding: ${a.width}`);
    assert.ok(
      Math.abs(b.x - (a.x + a.width + 12)) < 1e-6,
      'and the next after it',
    );
    // `flex: 1` shares the row, padding and all
    const [c, d] = await place(
      '<div id="a" style="flex:1">Install</div><div id="b" style="flex:1">Run</div>',
    );
    assert.deepStrictEqual([c.width, d.width, c.height], [344, 344, 44]);
    // a width of its own is its content box's, 100 + 24 + 4
    const [e] = await place(
      '<div id="a" style="width:100px;border:2px solid">W</div><div id="b"></div>',
    );
    assert.strictEqual(e.width, 128);
    // and a row inside a row is as wide as its items side by side
    const [f] = await place(
      '<div id="a" style="display:flex;gap:4px;padding:0"><span>One</span>' +
        '<span>Two</span></div><div id="b">x</div>',
    );
    const [one] = await place(
      '<div id="a" style="padding:0">One</div><div id="b"></div>',
    );
    assert.ok(f.width > one.width * 2, `${f.width} holds both words`);
    // and an auto margin takes the free space on its side
    const [, end] = await place(
      '<div id="a">A</div><div id="b" style="margin-left:auto">B</div>',
    );
    assert.ok(Math.abs(end.x + end.width - 700) < 1e-6, `${end.x + end.width}`);
  },
);

// --- grid --------------------------------------------------------------------------

metric('a grid places its items in its column tracks', async () => {
  // CSS Grid 1, the subset documents are written in: Tailwind's
  // `grid-cols-3`, a sidebar in `200px 1fr`, `repeat(auto-fill, …)` and
  // spans; `display: grid` stacked its items as blocks
  const grid = async (css: string, items: string) => {
    const { node } = await render(
      '<style>body{margin:0;font:14px/20px sans-serif}</style>' +
        `<div id="g" style="display:grid;${css}">${items}</div>`,
      700,
    );
    const g = boxOf(view(node), 'g');
    const out = g.children
      .filter((c) => (c as unknown as { kind: string }).kind !== 'text')
      .map((c) => [c.x, c.y, c.width]);
    cleanup();
    return out;
  };
  const rounded = async (css: string, items: string) =>
    (await grid(css, items)).map((cell) => cell.map((v) => Math.round(v)));
  assert.deepStrictEqual(
    await rounded(
      'grid-template-columns:repeat(3,minmax(0,1fr));gap:16px',
      '<div>A</div><div>B</div><div>C</div><div>D</div>',
    ),
    [
      [0, 0, 223],
      [239, 0, 223],
      [477, 0, 223],
      [0, 36, 223],
    ],
    'three equal columns, and a fourth item on the next row',
  );
  assert.deepStrictEqual(
    await rounded(
      'grid-template-columns:200px 1fr;gap:10px',
      '<div>Side</div><div>Main</div>',
    ),
    [
      [0, 0, 200],
      [210, 0, 490],
    ],
  );
  assert.deepStrictEqual(
    (
      await rounded(
        'grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px',
        '<div>1</div><div>2</div><div>3</div><div>4</div><div>5</div>',
      )
    ).map(([x, y]) => [x, y]),
    [
      [0, 0],
      [177, 0],
      [354, 0],
      [531, 0],
      [0, 28],
    ],
    'as many columns as fit',
  );
  assert.deepStrictEqual(
    await rounded(
      'grid-template-columns:repeat(4,1fr);gap:4px',
      '<div style="grid-column:span 2">wide</div><div>x</div><div>y</div>' +
        '<div style="grid-column:1 / -1">full</div>',
    ),
    [
      [0, 0, 348],
      [352, 0, 172],
      [528, 0, 172],
      [0, 24, 700],
    ],
    'spans, and a line counted back from the end',
  );
  // content-sized columns at the sides, and the rest in the middle: each
  // starts a gap after the one before, and the last ends at the edge, what
  // ever the font makes of the words
  const [first, middle, last] = await grid(
    'grid-template-columns:auto 1fr auto;gap:8px',
    '<div>Label</div><div>stretch</div><div>End</div>',
  );
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  assert.ok(
    near(middle[0] - (first[0] + first[2]), 8),
    'a gap after the first',
  );
  assert.ok(
    near(last[0] - (middle[0] + middle[2]), 8),
    'a gap after the middle',
  );
  assert.ok(near(last[0] + last[2], 700), 'the last ends at the edge');
  assert.ok(
    first[2] < 60 && last[2] < 60 && middle[2] > 500,
    `${first[2]} ${middle[2]} ${last[2]}`,
  );
  // an item is stretched to its row, and aligned in it where it says
  const { node } = await render(
    '<style>body{margin:0;font:14px/20px sans-serif}</style>' +
      '<div style="display:grid;grid-template-columns:100px 100px">' +
      '<div>two<br>lines</div><div id="s">one</div>' +
      '<div id="c" style="justify-self:center;align-self:center">c</div></div>',
    700,
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 's').height, 40);
  const c = boxOf(el, 'c');
  assert.ok(c.width < 20 && c.x > 40, `${c.x} ${c.width}`);
});

metric('grid-template and grid set the tracks they name', async () => {
  // Neither shorthand was read, so a grid written with one had no tracks
  // and stacked its items in a column; nor was grid-auto-columns
  const cells = async (css: string, items: string) => {
    const { node } = await render(
      '<style>body{margin:0;font:14px/20px sans-serif}</style>' +
        `<div id="g" style="display:grid;${css}">${items}</div>`,
      700,
    );
    const g = boxOf(view(node), 'g');
    const out = g.children
      .filter((c) => (c as unknown as { kind: string }).kind !== 'text')
      .map((c) => [c.x, c.y, c.width, c.height].map((v) => Math.round(v)));
    cleanup();
    return out;
  };
  const four = '<div>a</div><div>b</div><div>c</div><div>d</div>';
  assert.deepStrictEqual(
    await cells('grid-template:30px 40px / 100px 50px', four),
    [
      [0, 0, 100, 30],
      [100, 0, 50, 30],
      [0, 30, 100, 40],
      [100, 30, 50, 40],
    ],
    'rows, a slash and columns',
  );
  assert.deepStrictEqual(
    await cells("grid-template:'a b' 30px 'c d' / 60px 70px", four),
    [
      [0, 0, 60, 30],
      [60, 0, 70, 30],
      [0, 30, 60, 20],
      [60, 30, 70, 20],
    ],
    "each area string's row the size after it, and auto with none",
  );
  assert.deepStrictEqual(
    await cells('grid:auto-flow 25px / 60px 60px', four),
    [
      [0, 0, 60, 25],
      [60, 0, 60, 25],
      [0, 25, 60, 25],
      [60, 25, 60, 25],
    ],
    "auto-flow's rows, and the columns",
  );
  assert.deepStrictEqual(
    await cells(
      'grid-template-columns:50px;grid-auto-columns:30px',
      '<div>a</div><div style="grid-column:2">b</div>',
    ),
    [
      [0, 0, 50, 20],
      [50, 0, 30, 20],
    ],
    'a column past the template is grid-auto-columns wide',
  );
});

metric(
  'an absolute box in a grid takes its grid area for its containing block',
  async () => {
    // CSS Grid 1, 9.1: the area between the lines it names, the grid's
    // padding edge where a line is auto — which `grid-column: 2` leaves its
    // end line. Its offsets, its percentages and
    // its alignment were the grid's padding box's; a box deeper in the grid
    // is where its own flow put it
    const { node } = await render(
      '<style>body{margin:0;font:14px/20px sans-serif}' +
        '.a{position:absolute}</style>' +
        '<div style="display:grid;position:relative;padding:10px;' +
        'grid-template-columns:50px 100px;grid-template-rows:30px 40px">' +
        '<div>a</div><div>b</div><div>c</div>' +
        '<div><div id="d" class="a" style="width:50%;height:5px"></div></div>' +
        '<div id="p" class="a" style="grid-column:2 / 3;grid-row:2 / 3;' +
        'width:100%;height:100%"></div>' +
        '<div id="r" class="a" style="grid-column:2;grid-row:2;' +
        'width:100%;height:100%"></div>' +
        '<div id="q" class="a" style="grid-column:2 / 3;inset:5px"></div>' +
        '<div id="s" class="a" style="width:20px;height:20px;' +
        'justify-self:center;align-self:end"></div></div>',
      700,
    );
    const el = view(node);
    const rect = (id: string) => {
      const b = boxOf(el, id);
      return [b.x, b.y, b.width, b.height];
    };
    // the grid's padding box is 700 by 90
    assert.deepStrictEqual(rect('p'), [60, 40, 100, 40], 'its area');
    assert.deepStrictEqual(rect('r'), [60, 40, 640, 50], 'auto: the edge');
    assert.deepStrictEqual(rect('q'), [65, 5, 90, 80], 'a column, all rows');
    assert.deepStrictEqual(rect('s'), [340, 70, 20, 20], 'aligned in it');
    assert.deepStrictEqual(rect('d'), [60, 40, 350, 5], 'in the flow, deeper');
  },
);

metric(
  'an absolute box in a flex box is where it would be as its one item',
  async () => {
    // CSS Flexbox 4.1: its static position is in the flex box's content box,
    // aligned by justify-content and align-self; it was at the box's corner.
    // And its containing block is its own: one in a flex box that is not
    // positioned was placed against the flex box
    const place = async (css: string, child = 'width:20px;height:10px') => {
      const { node } = await render(
        '<style>body{margin:0}</style>' +
          '<div style="position:relative;padding:7px">' +
          `<div style="display:flex;width:100px;height:60px;padding:5px;${css}">` +
          `<div id="a" style="position:absolute;${child}"></div></div></div>`,
      );
      const b = boxOf(view(node), 'a');
      cleanup();
      return [b.x, b.y];
    };
    assert.deepStrictEqual(
      await place('justify-content:center;align-items:flex-end'),
      [52, 62],
      'centred along the row, at the end across it',
    );
    assert.deepStrictEqual(
      await place(
        'flex-direction:column;justify-content:flex-end;align-items:center',
      ),
      [52, 62],
      'and the same down a column',
    );
    assert.deepStrictEqual(
      await place('flex-direction:row-reverse'),
      [92, 12],
      'a reversed row starts at its end',
    );
    assert.deepStrictEqual(
      await place('', 'top:0;left:0;width:20px;height:10px'),
      [0, 0],
      "its offsets are from its containing block's padding edge",
    );
  },
);

metric(
  'auto rows share a grid height, and an item that does not stretch fits its content',
  async () => {
    // CSS Grid 1, 11.8: with align-content normal, the auto rows stretch to
    // fill a grid of a definite height; and an item that is not stretched is
    // as wide as its content fits, which is its longest word where that is
    // wider than its area — it was cut to the area
    const { node } = await render(
      '<style>body{margin:0;font:14px/20px sans-serif}</style>' +
        '<div style="display:grid;height:100px;grid-template-rows:20px auto auto">' +
        '<div>a</div><div id="b">b</div><div id="c">c</div></div>' +
        '<div style="display:grid;height:100px;align-content:start;' +
        'grid-template-rows:20px auto"><div>a</div><div id="e">e</div></div>' +
        '<div style="display:grid;grid-template-columns:10px;justify-items:start">' +
        '<div id="w">Supercalifragilistic</div></div>',
      700,
    );
    const el = view(node);
    assert.strictEqual(boxOf(el, 'b').height, 40, 'half of what is left');
    assert.strictEqual(boxOf(el, 'c').y, 60);
    assert.strictEqual(boxOf(el, 'e').height, 20, 'align-content: start');
    const w = boxOf(el, 'w');
    assert.ok(w.width > 50, `as wide as its word: ${w.width}`);
  },
);

test('grid tracks are sized as CSS Grid 11.5 to 11.8 has it', () => {
  const item = (
    start: number,
    span: number,
    min: number,
    max: number,
    minimum = min,
  ) => ({
    start,
    span,
    minContent: () => min,
    maxContent: () => max,
    minimum: () => minimum,
  });
  const space = (available: number, least = 0) => ({
    available,
    least,
    gap: 0,
    stretch: true,
  });
  const auto = { min: 'auto', max: 'auto' } as const;
  const fr = (n: number) => ({ min: 'auto' as const, max: { fr: n } });
  // An item spanning a length and a content-sized track grows the second
  // alone — the last spanned track grew, a length or not — and two
  // content-sized ones by what each maximum lets it take: the tracks of
  // `grid-intrinsic-maximums`, with an item 40 at its narrowest and 90 at
  // its widest
  assert.deepStrictEqual(
    sizeTracks(
      [
        { min: 0, max: 'min-content' },
        { min: 5, max: 5 },
      ],
      [item(0, 2, 40, 90, 15)],
      space(100),
    ),
    [35, 5],
  );
  assert.deepStrictEqual(
    sizeTracks(
      [
        { min: 0, max: 'min-content' },
        { min: 5, max: 5 },
        { min: 0, max: 'max-content' },
      ],
      [item(0, 3, 40, 90, 15)],
      space(100),
    ),
    [17.5, 5, 67.5],
  );
  // the free space grows the tracks equally, each as far as its limit —
  // it grew them in proportion to what each wanted
  assert.deepStrictEqual(
    sizeTracks(
      [auto, auto],
      [item(0, 1, 10, 30), item(1, 1, 50, 300)],
      space(200),
    ),
    [30, 170],
  );
  // an `fr` track whose content is more than its share keeps its content's
  assert.deepStrictEqual(
    sizeTracks([fr(1), fr(1)], [item(0, 1, 250, 250)], space(300)),
    [250, 50],
  );
  // with no size of its own, an axis's `fr` rows fill its least size
  assert.deepStrictEqual(
    sizeTracks(
      [auto, fr(1), auto],
      [item(0, 1, 50, 50), item(1, 1, 100, 100), item(2, 1, 50, 50)],
      space(Infinity, 600),
    ),
    [50, 500, 50],
  );
});

metric(
  "a grid's fr rows fill its height, and an item stretched into a row is its height",
  async () => {
    // `auto 1fr auto`, the page with a footer at the bottom: the `fr` row was
    // as tall as what was in it. And a main area that scrolls, in a grid of
    // a height, is the row's height — it was as tall as what it held
    const { node } = await render(
      '<style>body{margin:0} .g{display:grid;grid-template-rows:auto 1fr auto}' +
        '</style>' +
        '<div class="g" style="min-height:300px"><div style="height:40px"></div>' +
        '<div id="m"><div style="height:50px"></div></div>' +
        '<div id="f" style="height:30px"></div></div>' +
        '<div class="g" style="height:200px"><div style="height:40px"></div>' +
        '<div id="s" style="overflow:auto"><div style="height:1000px"></div>' +
        '</div><div style="height:30px"></div></div>',
    );
    const el = view(node);
    assert.strictEqual(boxOf(el, 'm').height, 230, 'what min-height leaves');
    assert.strictEqual(boxOf(el, 'f').y, 270, 'the footer at the bottom');
    assert.strictEqual(boxOf(el, 's').height, 130, 'the row, not its content');
  },
);

metric(
  'a grid places its tracks by justify-content and align-content, and an item by its auto margins',
  async () => {
    // CSS Box Alignment 3, 5.1, and CSS Grid 1, 10.2: the space the tracks
    // leave was all after them, and an auto margin was none
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="display:grid;width:300px;height:100px;' +
        'grid-template:20px / 50px 50px;justify-content:space-between;' +
        'align-content:center"><div></div><div id="b"></div></div>' +
        '<div style="display:grid;grid-template:100px / 100px">' +
        '<div id="c" style="margin:auto;width:20px;height:20px"></div></div>' +
        '<div style="display:grid;grid-template:100px / 100px">' +
        '<div id="d" style="margin-left:auto;height:20px">' +
        '<span style="display:inline-block;width:20px"></span></div></div>',
    );
    const el = view(node);
    const at = (id: string) => {
      const b = boxOf(el, id);
      return [b.x, b.y, b.width, b.height];
    };
    assert.deepStrictEqual(at('b'), [250, 40, 50, 20], 'spread, and centred');
    assert.deepStrictEqual(at('c'), [40, 140, 20, 20], 'centred in its area');
    assert.deepStrictEqual(
      at('d'),
      [80, 200, 20, 20],
      'at the end, unstretched',
    );
  },
);

metric(
  'grid placement moves its cursor past an item with a column, and places an item locked to a row first',
  async () => {
    // CSS Grid 1, 8.5: an item whose column is before the cursor goes to the
    // next row — it went in beside the last one — and an item that names
    // its row is placed before the ones that name neither
    const place = async (items: string) => {
      const { node } = await render(
        '<style>body{margin:0} div div{height:10px}</style>' +
          `<div id="g" style="display:grid;grid-template-columns:repeat(3,50px)">${items}</div>`,
      );
      const g = boxOf(view(node), 'g');
      const out = g.children
        .filter((c) => (c as unknown as { kind: string }).kind !== 'text')
        .map((c) => [c.x, c.y]);
      cleanup();
      return out;
    };
    assert.deepStrictEqual(
      await place(
        '<div></div><div style="grid-column:3"></div>' +
          '<div style="grid-column:2"></div>',
      ),
      [
        [0, 0],
        [100, 0],
        [50, 10],
      ],
    );
    assert.deepStrictEqual(
      await place('<div></div><div style="grid-row:1"></div>'),
      [
        [50, 0],
        [0, 0],
      ],
    );
  },
);

metric(
  'a grid item of a content width is that width, and fit-content() stops at its argument',
  async () => {
    // A grid item's `width: min-content` was stretched across its area, and
    // `height: max-content` down it; and `fit-content(100px)` was a
    // max-content track with no limit
    const { node } = await render(
      '<style>body{margin:0;font:14px/20px sans-serif}</style>' +
        '<div style="display:grid;grid-template:100px / 300px">' +
        '<div id="a" style="width:min-content;height:max-content">aa bb</div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:fit-content(100px) 1fr">' +
        '<div id="b">words enough to be wider than the argument</div><div></div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:fit-content(100px) 1fr">' +
        '<div id="c">ab</div><div></div></div>',
      400,
    );
    const el = view(node);
    const a = boxOf(el, 'a');
    assert.ok(a.width < 30, `its narrowest: ${a.width}`);
    assert.strictEqual(a.height, 40, 'its two lines, not its row');
    assert.strictEqual(boxOf(el, 'b').width, 100, 'no wider than the argument');
    const c = boxOf(el, 'c');
    assert.ok(c.width < 30, `no wider than its content: ${c.width}`);
  },
);

metric(
  'a grid places its items by the names of its areas and its lines',
  async () => {
    // CSS Grid 1, 7.3 and 8.3: `grid-template-areas`, the names in a track
    // list and the `-start` and `-end` lines an area's name makes were not
    // read, so every named item was placed in order — and a list with two
    // names in one bracket was no list at all
    const cells = async (css: string, items: string) => {
      const { node } = await render(
        '<style>body{margin:0} #g>div{height:10px}</style>' +
          `<div id="g" style="display:grid;${css}">${items}</div>`,
      );
      const g = boxOf(view(node), 'g');
      const out = g.children
        .filter((c) => (c as unknown as { kind: string }).kind !== 'text')
        .map((c) => [c.x, c.y, c.width, c.height]);
      cleanup();
      return out;
    };
    assert.deepStrictEqual(
      await cells(
        "grid-template-areas:'head head' 'nav main' 'foot foot';" +
          'grid-template-columns:100px 200px;grid-template-rows:30px 60px 20px',
        '<div style="grid-area:foot"></div><div style="grid-area:main"></div>' +
          '<div style="grid-area:head"></div><div style="grid-area:nav"></div>',
      ),
      [
        [0, 90, 300, 10],
        [100, 30, 200, 10],
        [0, 0, 300, 10],
        [0, 30, 100, 10],
      ],
      'each in its area, in any order',
    );
    assert.deepStrictEqual(
      (
        await cells(
          'grid-template-columns:[full-start] 50px [content-start a b] 100px ' +
            '[content-end] 50px [full-end]',
          '<div style="grid-column:content"></div>' +
            '<div style="grid-column:full"></div>' +
            '<div style="grid-column:b / span full-end"></div>',
        )
      ).map(([x, , w]) => [x, w]),
      [
        [50, 100],
        [0, 200],
        [50, 150],
      ],
      "an area's lines, two names in a bracket, and a span to a name",
    );
    assert.deepStrictEqual(
      (
        await cells(
          "grid-template:[top] 'a b' 30px [mid] / [l] 40px [m] 60px;" +
            'grid-template-columns:repeat(2, [col] 50px)',
          '<div style="grid-area:b"></div><div style="grid-column:col 2;' +
            'grid-row:mid"></div>',
        )
      ).map(([x, y, w]) => [x, y, w]),
      [
        [50, 0, 50],
        [50, 30, 50],
      ],
      "the shorthand's areas, and a repeated name counted",
    );
  },
);

metric(
  'grid-auto-flow fills the columns, or goes back for the holes',
  async () => {
    // `grid-auto-flow: column` and `dense` were not read: the items went
    // along the rows, and a hole a wide item left stayed a hole. And the
    // gaps' old names, `grid-gap` and its longhands, were not read either
    const place = async (css: string, items: string) => {
      const { node } = await render(
        '<style>body{margin:0} #g>div{height:10px}</style>' +
          `<div id="g" style="display:grid;${css}">${items}</div>`,
      );
      const g = boxOf(view(node), 'g');
      const out = g.children
        .filter((c) => (c as unknown as { kind: string }).kind !== 'text')
        .map((c) => [c.x, c.y]);
      cleanup();
      return out;
    };
    assert.deepStrictEqual(
      await place(
        'grid-auto-flow:column;grid-template-rows:10px 10px;' +
          'grid-auto-columns:50px',
        '<div></div><div></div><div></div>',
      ),
      [
        [0, 0],
        [0, 10],
        [50, 0],
      ],
      'down the columns',
    );
    const holes =
      '<div style="grid-column:span 2"></div>'.repeat(2) + '<div></div>';
    assert.deepStrictEqual(
      await place('grid-template-columns:repeat(3,50px)', holes),
      [
        [0, 0],
        [0, 10],
        [100, 10],
      ],
      'sparse: on from the last',
    );
    assert.deepStrictEqual(
      await place(
        'grid-template-columns:repeat(3,50px);grid-auto-flow:dense',
        holes,
      ),
      [
        [0, 0],
        [0, 10],
        [100, 0],
      ],
      'dense: back into the hole',
    );
    assert.deepStrictEqual(
      await place(
        'grid-template-columns:repeat(2,50px);grid-gap:5px 10px',
        '<div></div><div></div><div></div>',
      ),
      [
        [0, 0],
        [60, 0],
        [0, 15],
      ],
      'grid-gap',
    );
  },
);

metric(
  'a percentage row of a grid with no height is of the height its rows come to',
  async () => {
    // CSS Grid 1, 7.2.1: sized as `auto` to find the grid's height, and then
    // a percentage of it — a grid with no height kept it `auto`; and an
    // `auto-fill` of rows counted against the grid's height, which only the
    // columns' width did
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="display:grid;grid-template-rows:auto 20% auto">' +
        '<div style="height:40px"></div><div id="p" style="height:60px"></div>' +
        '<div id="q" style="height:40px"></div></div>' +
        '<div style="display:grid;height:100px;' +
        'grid-template-rows:repeat(auto-fill,30px);grid-auto-rows:5px">' +
        '<div id="r" style="grid-row:-2"></div></div>',
    );
    const el = view(node);
    assert.strictEqual(boxOf(el, 'p').y, 56, 'after an auto row stretched');
    assert.strictEqual(boxOf(el, 'q').y, 84, '20% of 140 before it');
    assert.strictEqual(boxOf(el, 'r').y, 140 + 60, 'the last of three rows');
  },
);

test('a grid item with a ratio is sized by it, and justify-items: normal starts an image', async () => {
  // An item with an aspect-ratio and a height was as wide as its column,
  // and `normal` stretched an image across it, where CSS Grid 1, 6.2 sizes
  // either as a block would be: an image at its own width, a box with a
  // ratio from a height it has, and else filling the column
  const { el } = await renderWithBytes(
    '<style>body{margin:0}</style>' +
      '<div style="display:grid;grid-template-columns:300px">' +
      '<div id="a" style="height:100px;aspect-ratio:1"></div>' +
      '<div id="b" style="aspect-ratio:3"></div>' +
      '<img id="c" src="r.png"></div>' +
      // stretched down a row, as wide as its ratio makes that height
      '<div style="display:grid;grid-template:100px/300px">' +
      '<canvas id="d" width="10" height="10" style="align-self:stretch">' +
      '</canvas></div>' +
      // and stretched across, as tall as its ratio makes that width
      '<div style="display:grid;grid-template-columns:60px">' +
      '<img id="e" src="r.png" style="justify-self:stretch"></div>' +
      // its percentage height is of a row that has a length, and its
      // column as wide as that makes it
      '<div id="fg" style="display:inline-grid;grid-template-rows:80px">' +
      '<div id="f" style="height:100%;aspect-ratio:1/2"></div></div>' +
      // stretched down a row another item sizes
      '<div style="display:grid;grid-template-columns:300px 50px">' +
      '<canvas id="h" width="10" height="10" style="align-self:stretch">' +
      '</canvas><div style="height:80px"></div></div>' +
      // and what is in an item takes its percentages of that item's height
      '<div id="ig" style="display:inline-grid;grid-template-rows:50px">' +
      '<div style="height:100%"><canvas width="20" height="10" ' +
      'style="height:100%;display:block"></canvas></div></div>' +
      // but a scroll container's sizes are not its ratio's
      '<div style="float:left"><div id="g" style="display:grid">' +
      '<div style="height:100px;aspect-ratio:2;overflow:auto"></div>' +
      '</div></div>',
    { 'r.png': RED_PNG },
  );
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  await waitFor(() => assert.deepStrictEqual(size('c'), [10, 10]));
  assert.deepStrictEqual(size('a'), [100, 100]);
  assert.deepStrictEqual(size('b'), [300, 100], 'no height: the column');
  assert.deepStrictEqual(size('d'), [100, 100]);
  assert.deepStrictEqual(size('e'), [60, 60]);
  assert.deepStrictEqual(size('f'), [40, 80]);
  assert.strictEqual(boxOf(el, 'fg').width, 40, 'its column too');
  assert.deepStrictEqual(size('h'), [80, 80]);
  assert.strictEqual(boxOf(el, 'ig').width, 100);
  assert.strictEqual(boxOf(el, 'g').width, 0);
});

test("a grid item's percentage height is of its area", async () => {
  // It was of the grid's height, so `height: 100%` in one of two rows was
  // as tall as both; and what is in a stretched item takes its percentages
  // of the item's height, as in a stretched flex item
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:grid;height:100px;grid-template-rows:50px 50px">' +
      '<div id="a" style="height:100%"><div id="b" style="height:50%">' +
      '</div></div><div id="c" style="height:100%"></div></div>' +
      '<div style="display:grid;height:200px;grid-template-rows:auto 60px">' +
      '<div><div id="d" style="height:50%"></div></div><div></div></div>' +
      // and of a row whose size is known only once the rows are sized
      '<div style="display:grid;height:200px;grid-template-rows:auto 60px">' +
      '<div id="e" style="height:50%"></div><div></div></div>',
  );
  const el = view(node);
  const height = (id: string) => boxOf(el, id).height;
  assert.deepStrictEqual([height('a'), height('b'), height('c')], [50, 25, 50]);
  assert.strictEqual(height('d'), 70, 'half the 140 its auto row is');
  assert.strictEqual(height('e'), 70);
});

test('auto-fit tracks no item is in collapse, gaps and all', async () => {
  // `repeat(auto-fit, …)` was `auto-fill`: every repetition stayed, empty,
  // and took its share of the space `justify-content` distributes
  const { node } = await render(
    '<style>body{margin:0} .g{display:grid;width:200px;height:200px;' +
      'grid-template-columns:repeat(auto-fit,25px);' +
      'grid-template-rows:repeat(auto-fit,25px);' +
      'justify-content:space-evenly;align-content:space-evenly}' +
      '.g>div{width:25px;height:25px}</style>' +
      '<div class="g"><div id="a" style="grid-area:2/3"></div>' +
      '<div id="b" style="grid-area:3/4"></div></div>' +
      // a collapsed track's gaps collapse with it
      '<div style="display:grid;width:500px;gap:100px;' +
      'grid-template-columns:repeat(auto-fit,200px);justify-content:center">' +
      '<div id="c"></div></div>',
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).y];
  assert.deepStrictEqual(at('a'), [50, 50], 'two tracks, spaced evenly');
  assert.deepStrictEqual(at('b'), [125, 125]);
  assert.strictEqual(boxOf(el, 'c').x, 150, 'one track centred, no gap');
});

test('gaps may be percentages, and a grid is as wide as its tracks', async () => {
  // A percentage gap was dropped whole: it is of the content box's size
  // along it, and where that is not known, of the size the tracks come to
  // without it (CSS Box Alignment 3, 8.3)
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:grid;width:200px;height:200px;gap:10%;' +
      'grid-template:90px 90px/90px 90px">' +
      '<div></div><div id="a"></div><div id="b"></div></div>' +
      '<div style="display:flex;width:200px;column-gap:25%">' +
      '<div style="width:20px"></div><div id="c" style="width:20px"></div>' +
      '</div>' +
      // a grid's own size is its tracks', not where an item past its
      // column ends
      '<div style="float:left"><div id="d" style="display:grid;' +
      'grid-template-columns:50px"><div style="width:200px"></div></div>' +
      '</div>' +
      // and an item whose width is its content's widest counts it so
      '<div style="float:left"><div id="e" style="display:grid;' +
      'grid-template-columns:min-content"><div style="width:max-content">' +
      '<span style="display:inline-block;width:60px"></span> ' +
      '<span style="display:inline-block;width:60px"></span></div></div>' +
      '</div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').x, 110, 'a column gap of 10% of 200');
  assert.strictEqual(boxOf(el, 'b').y, 110, 'a row gap of 10% of 200');
  assert.strictEqual(boxOf(el, 'c').x, 70);
  assert.strictEqual(boxOf(el, 'd').width, 50);
  assert.ok(boxOf(el, 'e').width >= 120, `${boxOf(el, 'e').width}`);
});

// --- rounded borders -------------------------------------------------------------

test("a rounded box's border is a ring that follows its corners", async () => {
  // drawn a side at a time, its corners were square over the background's
  // rounded ones; the inside of the ring is rounded by the radius less the
  // border
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:100px;height:40px;border:2px solid #ff0000;' +
      'border-radius:8px"></div>' +
      '<div style="width:100px;height:40px;border-left:6px solid #0000ff;' +
      'border-radius:10px"></div>' +
      '<div style="width:100px;height:40px;border:2px solid #00ff00;' +
      'border-top-color:#ff00ff;border-radius:8px"></div>',
  );
  const fills = await fillsOf(view(node));
  const red = fills.find((f) => f.style === parseColor('#ff0000'));
  assert.ok(red, 'a fill in the border colour');
  assert.deepStrictEqual(
    [red.x, red.y, red.w, red.h, red.radii, red.rule],
    [0, 0, 104, 44, [8, 8, 8, 8], 'evenodd'],
  );
  assert.deepStrictEqual(red.inner, {
    x: 2,
    y: 2,
    w: 100,
    h: 40,
    radii: [6, 6, 6, 6],
  });
  // a border down one side curves into the corners it meets, the inside's
  // corners there ellipses 4px across and 10px down, and its hole is run
  // from the top left anticlockwise
  const blue = fills.find((f) => f.style === parseColor('#0000ff'));
  assert.deepStrictEqual(blue?.corners?.slice(4), [
    [4, 10],
    [4, 10],
    [10, 10],
    [10, 10],
  ]);
  // and sides of two colours are drawn a side at a time, as before
  const green = fills.filter((f) => f.style === parseColor('#00ff00'));
  assert.ok(
    green.length >= 3 && green.every((f) => !f.inner),
    'straight sides',
  );
});

test('a 3D border is shaded as Chromium shades one', async () => {
  const { borderShades } = await import('../src/html/css/color.js');
  // the shadow is the colour darkened; where that leaves black, the colour
  // is the shadow and the light is lightened
  assert.deepStrictEqual(borderShades('black'), {
    lit: 'rgba(84, 84, 84, 1)',
    shadowed: 'rgba(0, 0, 0, 1)',
  });
  assert.deepStrictEqual(borderShades('white'), {
    lit: 'rgba(255, 255, 255, 1)',
    shadowed: 'rgba(171, 171, 171, 1)',
  });
  assert.deepStrictEqual(borderShades('rgba(0, 0, 0, 0.5)'), {
    lit: 'rgba(84, 84, 84, 0.5)',
    shadowed: 'rgba(0, 0, 0, 0.5)',
  });
});

test('groove and ridge are two bands, inset and outset one, lit from the top left', async () => {
  // a groove in its default colour was drawn as a solid border (WPT
  // borders/groove-default, ridge-default)
  const { node } = await render(
    '<style>body{margin:0} div{width:40px;height:20px;border:8px #ffffff}' +
      '</style><div style="border-style:groove"></div>' +
      '<div style="border-style:outset"></div>',
  );
  const fills = await fillsOf(view(node));
  const lit = 'rgba(255, 255, 255, 1)';
  const shadow = 'rgba(171, 171, 171, 1)';
  const of = (y0: number, y1: number) =>
    fills.filter((f) => f.y >= y0 && f.y < y1 && f.w > 0).map((f) => f.style);
  // the groove: its top's outer band in shadow and its inner band lit, its
  // bottom's the other way round — eight bands in all
  const groove = of(0, 36);
  assert.strictEqual(groove.length, 8);
  assert.deepStrictEqual(groove.slice(0, 2), [shadow, lit]);
  // the outset: a band a side, the top and the left lit
  const outset = of(36, 72);
  assert.deepStrictEqual(outset, [lit, shadow, shadow, lit]);
});

// --- linear gradients -------------------------------------------------------------

test('a linear gradient is drawn over the colour, across the box', async () => {
  // CSS Images 3: Tailwind 4's `bg-linear-to-r from-… to-…` is written
  // `linear-gradient(to right in oklab, …)`, and a gradient was drawn as
  // nothing
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:200px;height:100px;background:#ffffff ' +
      'linear-gradient(to right in oklab, #ff0000, #00ff00 40%, #0000ff)">' +
      '</div><div style="width:100px;height:100px;background-image:' +
      'linear-gradient(to top right, #ff0000 20px, #0000ff)"></div>',
  );
  const fills = await fillsOf(view(node));
  const gradients = fills
    .map((f) => f.style as { line?: number[]; stops?: [number, string][] })
    .filter((g) => g && g.line);
  assert.strictEqual(gradients.length, 2);
  const [across, corner] = gradients;
  assert.deepStrictEqual(
    across.line!.map((v) => Math.round(v)),
    [0, 50, 200, 50],
  );
  assert.deepStrictEqual(
    across.stops!.map(([at]) => at),
    [0, 0.4, 1],
  );
  // a corner's line is the square's diagonal, its first stop 20px along it
  const [x0, y0, x1, y1] = corner.line!;
  assert.ok(Math.abs(x1 - x0 - 100) < 1e-6 && Math.abs(y0 - y1 - 100) < 1e-6);
  assert.ok(Math.abs(corner.stops![0][0] - 20 / Math.hypot(100, 100)) < 1e-6);
  // and the white is painted under the first one
  assert.ok(fills.some((f) => f.style === parseColor('#ffffff')));
});

/** The gradients a paint filled with, and where. */
function gradientFills(fills: Fill[]) {
  return fills
    .filter((f) => (f.style as { line?: number[] } | null)?.line)
    .map((f) => {
      const g = f.style as { line: number[]; stops: [number, string][] };
      // to the thousandth, where a sine of pi is not quite nought
      const line = g.line.map((v) => Math.round(v * 1000) / 1000 + 0);
      return { x: f.x, y: f.y, w: f.w, h: f.h, line, stops: g.stops };
    });
}

test('a gradient is the size of the padding box, and repeats under the borders', async () => {
  // CSS Backgrounds 3: an image with no size of its own is the size of the
  // background positioning area, the padding box, and tiles from there; a
  // gradient measured on the border box put every stop a border's width
  // early (WPT floats-clear/clear-on-replaced-element's red bands)
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px;height:40px;' +
      'border:10px dashed transparent;background-image:' +
      'linear-gradient(to right, #ff0000, #0000ff)"></div>',
  );
  const tiles = gradientFills(await fillsOf(view(node)));
  assert.strictEqual(
    tiles.length,
    9,
    'the padding box and the eight around it',
  );
  const middle = tiles.find((t) => t.x === 10 && t.y === 10)!;
  assert.deepStrictEqual([middle.w, middle.h], [100, 40]);
  assert.deepStrictEqual(middle.line, [10, 30, 110, 30]);
  // the left border shows the end of the tile before, not the start colour
  const left = tiles.find((t) => t.x === 0 && t.y === 10)!;
  assert.deepStrictEqual([left.w, left.h], [10, 40]);
  assert.deepStrictEqual(left.line, [-90, 30, 10, 30]);
});

test("a gradient's stops past its ends lengthen its line", async () => {
  // the colours at the box's edges are the ones between, not the stops'
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px;height:20px;' +
      'background-image:linear-gradient(90deg, #ff0000 -50%, #00ff00, ' +
      '#0000ff 150%)"></div>',
  );
  const [only] = gradientFills(await fillsOf(view(node)));
  assert.deepStrictEqual(only.line, [-50, 10, 150, 10]);
  assert.deepStrictEqual(
    only.stops.map(([at]) => at),
    [0, 0.5, 1],
  );
});

test('a gradient far off the window is drawn from the part of its line it shows', async () => {
  // X RENDER takes a gradient's ends in 16.16 fixed point, and a line that
  // ended past ±32,767 pixels threw from the paint: a gradient down a long
  // wrapper scrolled far enough, or a stop at calc(Infinity * 1px) (WPT
  // css-images/gradient/gradient-infinity-001). The line is cut to what
  // the fill covers, and its ends are the colours the whole line has there.
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:100px;height:20px;background:linear-gradient(' +
      'to right, #00ff00 100px, #ff0000 calc(Infinity * 1px))"></div>' +
      '<div style="position:relative;top:-40020px;height:50000px;' +
      'background:linear-gradient(#000000,#ffffff)"></div>',
  );
  const fills = gradientFills(await fillsOf(view(node)));
  assert.strictEqual(fills.length, 2);
  for (const fill of fills) {
    for (const v of fill.line) assert.ok(Math.abs(v) < 32768, `${fill.line}`);
  }
  const grey = (color: string) => parseInt(color.slice(1, 3), 16);
  const [far, tall] = fills;
  const [, top, , bottom] = tall.line;
  const [[first, from], [last, to]] = [
    tall.stops[0],
    tall.stops[tall.stops.length - 1],
  ];
  assert.deepStrictEqual([first, last], [0, 1]);
  const at = (y: number) => (255 * (y + 40000)) / 50000;
  assert.ok(Math.abs(grey(from) - at(top)) <= 1, `${from} at ${top}`);
  assert.ok(Math.abs(grey(to) - at(bottom)) <= 1, `${to} at ${bottom}`);
  assert.ok(bottom > top, 'down the box');
  // the far stop is past the whole box: all of it is the first colour
  assert.deepStrictEqual(
    [...new Set(far.stops.map(([, color]) => color))],
    ['#00ff00'],
  );
});

test('a gradient on the root repeats down a canvas taller than the page', async () => {
  // the root's background is sized by the root element and tiled over the
  // canvas: the stripes a browser shows under a short page
  const { node } = await render(
    '<style>body{margin:0;background:linear-gradient(#ff0000, #0000ff)}' +
      '</style><div style="height:100px"></div>',
  );
  const tiles = gradientFills(
    await fillsOf(view(node), undefined, {
      canvas: { x: 0, y: 0, width: 400, height: 250 },
    }),
  );
  assert.deepStrictEqual(
    tiles.map((t) => [t.y, t.h, t.line[1], t.line[3]]),
    [
      [0, 100, 0, 100],
      [100, 100, 100, 200],
      [200, 50, 200, 300],
    ],
  );
});

// --- radii ----------------------------------------------------------------------

test("calc()'s constants: infinity, NaN, pi and e", () => {
  // CSS Values 4 names them, and Tailwind 4 writes a pill's radius as
  // `calc(infinity * 1px)`, which dropped the declaration: an infinity is
  // the largest length there is, and a NaN nought
  const ctx = { em: 20, rem: 16, vw: 1000, vh: 500, scale: 1 };
  const len = (v: string) => parseLength(v, ctx);
  assert.strictEqual(len('calc(infinity * 1px)'), 33554428);
  assert.strictEqual(len('calc(-infinity * 1px)'), -33554428);
  assert.strictEqual(len('calc(nan * 1px)'), 0);
  assert.ok(Math.abs((len('calc(pi * 1px)') as number) - Math.PI) < 1e-12);
  assert.ok(Math.abs((len('calc(e * 2px)') as number) - 2 * Math.E) < 1e-12);
  // a word that only starts like one is none
  assert.strictEqual(len('calc(ex * 1px)'), null);
  assert.strictEqual(len('calc(infinityx * 1px)'), null);
  assert.strictEqual(parseNumber('calc(infinity)'), 33554428);
});

/** The fills a document's boxes paint, of one colour. */
async function fillsIn(source: string, color: string): Promise<Fill[]> {
  const { node } = await render('<style>body{margin:0}</style>' + source);
  const ink = parseColor(color);
  return (await fillsOf(view(node))).filter((f) => f.style === ink);
}

test("a percentage radius is of the box's width across and its height down", async () => {
  // `50%` was read as no radius, so an avatar was a square: a circle on a
  // square box, and an ellipse on any other, drawn as four curves
  const [circle] = await fillsIn(
    '<div style="width:44px;height:44px;border-radius:50%;' +
      'background:#fde68a"></div>',
    '#fde68a',
  );
  assert.deepStrictEqual(circle.radii, [22, 22, 22, 22]);
  const [ellipse] = await fillsIn(
    '<div style="width:120px;height:56px;border-radius:50%;' +
      'background:#bae6fd"></div>',
    '#bae6fd',
  );
  assert.deepStrictEqual(
    [ellipse.x, ellipse.y, ellipse.w, ellipse.h],
    [0, 0, 120, 56],
  );
  assert.deepStrictEqual(ellipse.corners, [
    [60, 28],
    [60, 28],
    [60, 28],
    [60, 28],
  ]);
});

test('a slash gives the corners their vertical radii', async () => {
  const [both] = await fillsIn(
    '<div style="width:120px;height:56px;border-radius:40px / 20px;' +
      'background:#fecdd3"></div>',
    '#fecdd3',
  );
  assert.deepStrictEqual(both.corners, [
    [40, 20],
    [40, 20],
    [40, 20],
    [40, 20],
  ]);
  // and a corner's own property takes the two
  const [one] = await fillsIn(
    '<div style="width:120px;height:56px;border-top-left-radius:30px 10px;' +
      'background:#fecdd4"></div>',
    '#fecdd4',
  );
  assert.deepStrictEqual(one.corners, [
    [0, 0],
    [0, 0],
    [0, 0],
    [30, 10],
  ]);
});

test('radii too large for their box are reduced together', async () => {
  // Tailwind 4's rounded-full: a pill, its ends half the height round
  const [pill] = await fillsIn(
    '<div style="width:100px;height:30px;border-radius:calc(infinity * 1px);' +
      'background:#dcfce7"></div>',
    '#dcfce7',
  );
  assert.deepStrictEqual(pill.radii, [15, 15, 15, 15]);
  // two corners down a side 40px tall share it: 60px each is 40px, which
  // the Cocoa context's roundRect would clamp to 20px, so it is drawn in
  // curves
  const [tab] = await fillsIn(
    '<div style="width:100px;height:40px;border-radius:60px 60px 0 0;' +
      'background:#e9d5ff"></div>',
    '#e9d5ff',
  );
  assert.ok(tab.corners, 'drawn in curves');
  const [tr, br, bl, tl] = tab.corners!;
  assert.deepStrictEqual(
    [tr, tl],
    [
      [40, 40],
      [40, 40],
    ],
  );
  assert.deepStrictEqual(
    [br, bl],
    [
      [0, 0],
      [0, 0],
    ],
  );
});

test('a border down one side of a rounded box curves its inside by the ellipse left', async () => {
  // the inside's corner is the radius less the border across it: 14px less
  // 6px across and 14px down, an ellipse, so the ring is drawn in curves,
  // its hole run backwards under the non-zero rule (ntk leaves a hairline
  // where two curves drawn the same way meet under the even-odd one)
  const [ring] = await fillsIn(
    '<div style="width:200px;height:40px;border-left:6px solid #0000fe;' +
      'border-radius:14px"></div>',
    '#0000fe',
  );
  assert.strictEqual(ring.rule, 'nonzero');
  assert.deepStrictEqual(ring.corners!.slice(0, 4), [
    [14, 14],
    [14, 14],
    [14, 14],
    [14, 14],
  ]);
  // the hole, from its top left anticlockwise
  assert.deepStrictEqual(ring.corners!.slice(4), [
    [8, 14],
    [8, 14],
    [14, 14],
    [14, 14],
  ]);
});

test('background-size is read, in its longhand and after the position', async () => {
  const { node } = await render(
    '<div id="a" style="background-size:cover"></div>' +
      '<div id="b" style="background-size:50% auto"></div>' +
      '<div id="c" style="background-size:20px 10px"></div>' +
      '<div id="d" style="background-size:auto"></div>' +
      '<div id="e" style="background:url(x.png) center / 100px no-repeat">' +
      '</div>' +
      '<div id="f" style="background-size:contain, 10px"></div>' +
      '<div id="g" style="background-size:cover 10px"></div>',
  );
  const el = view(node);
  const size = (id: string) =>
    (boxOf(el, id) as unknown as { style: { backgroundSize: unknown } }).style
      .backgroundSize;
  assert.strictEqual(size('a'), 'cover');
  assert.deepStrictEqual(size('b'), [{ pct: 50 }, 'auto']);
  assert.deepStrictEqual(size('c'), [20, 10]);
  assert.strictEqual(size('d'), 'auto');
  assert.deepStrictEqual(size('e'), [100, 'auto']);
  assert.strictEqual(size('f'), 'contain', 'the first layer');
  assert.strictEqual(size('g'), 'auto', 'no such size');
});

test('a background is drawn at the size background-size gives it', async () => {
  // it was read and never drawn: a hero's `cover` photograph was tiled at
  // its own size. A 20×10 image in boxes 100 square
  const { node } = await render(
    '<style>body{margin:0}div{width:100px;height:100px;' +
      'background:url(x.png) no-repeat}</style>' +
      '<div style="background-size:cover"></div>' +
      '<div style="background-size:contain"></div>' +
      '<div style="background-size:50% auto"></div>' +
      '<div style="background-size:20px 20px;background-repeat:repeat"></div>',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    backgroundImageFor: () => ({ image: {}, width: 20, height: 10, ratio: 2 }),
  });
  const images = ops.filter(
    (op): op is Extract<PaintOp, { op: 'image' }> => op.op === 'image',
  );
  const at = (top: number) =>
    images.filter((op) => op.y >= top && op.y < top + 100);
  // covering, it is as tall as the box and twice as wide
  assert.deepStrictEqual(
    at(0).map((op) => [op.w, op.h]),
    [[200, 100]],
  );
  // contained, as wide as the box
  assert.deepStrictEqual(
    at(100).map((op) => [op.w, op.h]),
    [[100, 50]],
  );
  // half the box's width, and as tall as its ratio makes it
  assert.deepStrictEqual(
    at(200).map((op) => [op.w, op.h]),
    [[50, 25]],
  );
  // twenty square, and tiled
  const tiles = at(300);
  assert.ok(tiles.length >= 25, `${tiles.length} tiles`);
  assert.ok(tiles.every((op) => op.w === 20 && op.h === 20));
});

test('a gradient is tiled at the size background-size gives it', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px;height:40px;' +
      'background:linear-gradient(#ff0000,#0000ff);background-size:20px 20px">' +
      '</div>',
  );
  const fills = await fillsOf(view(node));
  const tiles = fills.filter(
    (f) => typeof f.style === 'object' && f.style !== null,
  );
  assert.strictEqual(tiles.length, 10, 'five across and two down');
  assert.ok(tiles.every((f) => f.w === 20 && f.h === 20));
});

test('a sized gradient in a rounded box is tiled and cut to its corners', async () => {
  // a rounded box's gradient was one fill of its shape, whatever its size
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px;height:40px;' +
      'border-radius:8px;background:linear-gradient(#ff0000,#0000ff);' +
      'background-size:20px 20px"></div>',
  );
  const ops: PaintOp[] = [];
  const fills = await fillsOf(view(node), ops);
  const tiles = fills.filter(
    (f) => typeof f.style === 'object' && f.style !== null,
  );
  assert.strictEqual(tiles.length, 10, 'five across and two down');
  assert.ok(tiles.every((f) => f.w === 20 && f.h === 20 && !f.radii));
  const clip = ops.findIndex((op) => op.op === 'clip');
  const first = ops.findIndex(
    (op) => op.op === 'fill' && typeof op.style === 'object',
  );
  assert.ok(clip >= 0 && clip < first, 'clipped before the first tile');
});

test('a gradient given only a width is as tall as its box', async () => {
  // it has no ratio to take a height from, and no height of its own
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px;height:40px;' +
      'background:linear-gradient(#ff0000,#0000ff);background-size:25px">' +
      '</div>',
  );
  const fills = await fillsOf(view(node));
  const tiles = fills.filter(
    (f) => typeof f.style === 'object' && f.style !== null,
  );
  assert.deepStrictEqual(
    tiles.map((f) => [f.w, f.h]),
    [
      [25, 40],
      [25, 40],
      [25, 40],
      [25, 40],
    ],
  );
});

metric(
  'a shrink-to-fit box has the room its margins and offsets leave',
  async () => {
    // it had the containing block's whole width: a float with side margins
    // stood out of it by them, and a box at `left: 50%` ran past its end
    const text = 'Words enough to wrap in any of these boxes. '.repeat(3);
    const { node } = await render(
      '<style>body{margin:0}.p{position:relative;width:320px}</style>' +
        `<div class="p"><div id="float" style="float:left;margin:0 20px">${text}</div></div>` +
        `<div class="p"><div id="ib" style="display:inline-block;margin:0 10px">${text}</div></div>` +
        `<div class="p"><div id="left" style="position:absolute;left:50%">${text}</div></div>` +
        `<div class="p"><div id="right" style="position:absolute;right:100px;margin-left:10px">${text}</div></div>` +
        '<div class="p" style="height:300px"><div style="margin-left:120px">' +
        `<div id="static" style="position:absolute">${text}</div></div></div>`,
    );
    const el = view(node);
    const width = (id: string) => boxOf(el, id).width;
    assert.strictEqual(width('float'), 280);
    assert.strictEqual(width('ib'), 300);
    assert.strictEqual(width('left'), 160);
    assert.strictEqual(width('right'), 210);
    assert.strictEqual(width('static'), 200, 'from where the flow put it');
  },
);

metric(
  "a table cell's min-content is its widest word, read or probed",
  async () => {
    // squeezed to nothing, each column is its min-content wide: read from
    // the words where they break only at spaces, and probed where they may
    // break elsewhere — a hyphen here
    const { node } = await render(
      '<style>body{margin:0}td{padding:0 3px}.f{float:left;clear:left;' +
        'padding:0 3px}</style>' +
        '<table style="width:1px;border-spacing:0"><tr>' +
        '<td id="a">alpha betalong gamma</td>' +
        '<td id="b">foo<b>barbaz</b> qux</td>' +
        '<td id="c"><div style="padding:0 7px">word longerword</div></td>' +
        '<td id="d">well-known</td>' +
        '<td id="e">café crème brûlée</td>' +
        '</tr></table>' +
        '<div style="width:1000px"><div class="f" id="ra">betalong</div>' +
        '<div class="f" id="rb">foo<b>barbaz</b></div>' +
        '<div class="f" id="rc" style="padding:0 10px">longerword</div>' +
        '<div class="f" id="rd1">well-</div><div class="f" id="rd2">known</div>' +
        '<div class="f" id="re">crème brûlée</div></div>',
    );
    const el = view(node);
    const width = (id: string) => boxOf(el, id).width;
    assert.strictEqual(width('a'), width('ra'));
    assert.strictEqual(width('b'), width('rb'), 'a word across two runs');
    assert.strictEqual(width('c'), width('rc'), "a block's padding counted");
    assert.strictEqual(
      width('d'),
      Math.max(width('rd1'), width('rd2')),
      'the hyphen is a break, which the probe finds',
    );
    assert.strictEqual(width('e'), width('re'), 'a no-break space joins');
  },
);

metric('a table of plain text is laid out at no pixel width', async () => {
  // its cells' min-content widths are read from their words: the probe a
  // pixel wide was four fifths of a table's first layout on X11
  const words = 'Some words in a cell that wraps. ';
  const { node } = await render(
    `<table style="width:300px"><tr><td>${words}</td><td>${words.repeat(2)}` +
      '</td><td>42.00</td></tr></table>',
  );
  const el = view(node) as unknown as {
    app: { fonts: FontsLike };
    _source: { document: unknown };
    _cascade: unknown;
  };
  const engine = el.app.fonts;
  const widths: number[] = [];
  const spy: FontsLike = {
    layout: (content, style, options) => {
      if (options?.maxWidth !== undefined) widths.push(options.maxWidth);
      return engine.layout(content, style, options);
    },
    match: (family, style) => engine.match(family, style),
  };
  const { buildBoxes } = await import('../src/html/layout/boxes.js');
  const { layoutDocument } = await import('../src/html/layout/block.js');
  const tree = buildBoxes(el._source.document as never, {
    cascade: el._cascade as never,
    scale: 1,
    imageSize: () => null,
    urlSize: () => null,
    controlSize: () => ({ width: 0, height: 0 }) as never,
  });
  layoutDocument(tree, spy, 400, 600);
  assert.ok(widths.length > 0);
  assert.ok(!widths.some((w) => w <= 1), `widths: ${widths.join(', ')}`);
});

metric(
  'a shrink-to-fit box of short words is laid out at no pixel width',
  async () => {
    // its floor is measured only where a word may be wider than the room: a
    // layout a pixel wide costs ntk fifteen to thirty ordinary ones, and as
    // first shipped every float, inline-block and absolute box whose text
    // wrapped paid it
    const words = 'Some words that run on long enough to wrap. '.repeat(4);
    const { node } = await render(
      '<div style="width:200px"><div style="float:left;margin:0 10px">' +
        `${words}</div><span style="display:inline-block">${words}</span>` +
        `<div style="position:absolute;left:50%">${words}</div></div>`,
    );
    const el = view(node) as unknown as {
      app: { fonts: FontsLike };
      _source: { document: unknown };
      _cascade: unknown;
    };
    const engine = el.app.fonts;
    const widths: number[] = [];
    const spy: FontsLike = {
      layout: (content, style, options) => {
        if (options?.maxWidth !== undefined) widths.push(options.maxWidth);
        return engine.layout(content, style, options);
      },
      match: (family, style) => engine.match(family, style),
    };
    const { buildBoxes } = await import('../src/html/layout/boxes.js');
    const { layoutDocument } = await import('../src/html/layout/block.js');
    const tree = buildBoxes(el._source.document as never, {
      cascade: el._cascade as never,
      scale: 1,
      imageSize: () => null,
      urlSize: () => null,
      controlSize: () => ({ width: 0, height: 0 }) as never,
    });
    layoutDocument(tree, spy, 400, 600);
    assert.ok(widths.length > 0);
    assert.ok(!widths.some((w) => w <= 1), `widths: ${widths.join(', ')}`);
  },
);

metric(
  'a shrink-to-fit box is never narrower than its longest word',
  async () => {
    // CSS 2.1 10.3.5: min(max(min-content, room), max-content) — a word
    // wider than the room widens the box to it rather than overflowing it
    const { node } = await render(
      '<style>body{margin:0}.p{width:150px}</style>' +
        '<div class="p"><div id="f" style="float:left;margin:0 20px">' +
        'Incomprehensibilities here</div></div>' +
        '<div style="width:1000px"><div id="ref" style="float:left">' +
        'Incomprehensibilities</div></div>',
    );
    const el = view(node);
    const word = boxOf(el, 'ref').width;
    assert.ok(word > 110, `${word}`);
    assert.strictEqual(boxOf(el, 'f').width, word);
  },
);

test('list-style-image and the list-style shorthand are read', async () => {
  // CSS 2.1 12.5.1: a `none` is whichever of the type and the image is not
  // otherwise given, both where neither is, and invalid where both are
  const { node } = await render(
    '<style>li{list-style:disc outside}</style><ul>' +
      '<li id="a" style="list-style:none"></li>' +
      '<li id="b" style="list-style:none square"></li>' +
      '<li id="c" style="list-style:url(d.png) none inside"></li>' +
      '<li id="d" style="list-style:none url(d.png)"></li>' +
      '<li id="e" style="list-style:none none"></li>' +
      '<li id="f" style="list-style:circle;list-style:none square none"></li>' +
      '<li id="g" style="list-style-image:url(g.png)"></li>' +
      '<li id="h" style="list-style-image:url(g.png);list-style:square"></li>' +
      '</ul>',
  );
  const el = view(node);
  type Listed = {
    listStyleType: string;
    listStylePosition: string;
    listStyleImage: string | null;
  };
  const seen = (id: string) => {
    const s = (boxOf(el, id) as unknown as { style: Listed }).style;
    return [s.listStyleType, s.listStylePosition, s.listStyleImage];
  };
  assert.deepStrictEqual(seen('a'), ['none', 'outside', null]);
  assert.deepStrictEqual(seen('b'), ['square', 'outside', null]);
  assert.deepStrictEqual(seen('c'), ['none', 'inside', 'd.png']);
  assert.deepStrictEqual(seen('d'), ['none', 'outside', 'd.png']);
  assert.deepStrictEqual(seen('e'), ['none', 'outside', null]);
  assert.deepStrictEqual(seen('f'), ['circle', 'outside', null], 'invalid');
  assert.deepStrictEqual(seen('g'), ['disc', 'outside', 'g.png']);
  assert.deepStrictEqual(seen('h'), ['square', 'outside', null], 'reset');
});

metric(
  "a list item's marker is its list-style-image where it loads",
  async () => {
    // dropped: every custom bullet was the type's disc
    const ctx = await renderWithImages(
      '<style>body{margin:0}ul{margin:0;padding:0 0 0 40px;font-size:16px;' +
        'line-height:30px}</style><ul style="list-style-image:url(dot.png)">' +
        '<li>Item</li></ul>',
    );
    let red = 0;
    for (let y = 0; y < 30; y += 1) {
      for (let x = 16; x < 40; x += 1) {
        if (isNear(await pixelAt(ctx, x, y), '#ff0000')) red += 1;
      }
    }
    // the ten pixel square of red the image is, before the text
    assert.ok(red >= 80, `${red} red pixels`);
  },
);

test('outline and its longhands are read', async () => {
  const { node } = await render(
    '<div id="a" style="outline:2px dashed #ff0000;outline-offset:-1px"></div>' +
      '<div id="b" style="outline:1px solid;outline:none"></div>' +
      '<div id="c" style="outline:auto;outline-color:invert"></div>' +
      '<div id="d" style="outline-style:dotted;outline-style:hidden"></div>' +
      '<div id="e" style="outline:thick groove #00ff00 bogus"></div>',
  );
  const el = view(node);
  type Outlined = {
    outlineStyle: string;
    outlineWidth: number;
    outlineColor: string;
    outlineOffset: number;
  };
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: Outlined }).style;
  const a = style('a');
  assert.deepStrictEqual(
    [a.outlineStyle, a.outlineWidth, a.outlineOffset],
    ['dashed', 2, -1],
  );
  assert.strictEqual(style('b').outlineStyle, 'none');
  assert.deepStrictEqual(
    [style('c').outlineStyle, style('c').outlineColor],
    ['auto', 'currentColor'],
  );
  assert.strictEqual(
    style('d').outlineStyle,
    'dotted',
    'hidden is no outline style',
  );
  assert.strictEqual(
    style('e').outlineStyle,
    'none',
    'an unknown part drops it',
  );
});

test('an outline is drawn round the border box grown by its offset, over the content', async () => {
  // dropped: a focus ring, an avatar's ring and Tailwind UI's hairline
  // over an image's edge were not drawn at all
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="width:100px;height:40px;outline:3px solid #ff0000;' +
      'outline-offset:4px;margin:10px"></div>' +
      '<div style="width:100px;outline:2px solid #00ff00;outline-offset:-2px">' +
      '<div style="height:20px;background:#0000ff"></div></div>',
  );
  const fills = await fillsOf(view(node));
  const red = fills.filter((f) => f.style === '#ff0000');
  // four edges three pixels thick, round the 100 by 40 box at 10, 10
  // grown by the offset and the width, 7
  assert.deepStrictEqual(
    red.map((f) => [f.x, f.y, f.w, f.h]).sort(),
    [
      [3, 3, 114, 3],
      [3, 54, 114, 3],
      [3, 6, 3, 48],
      [114, 6, 3, 48],
    ].sort(),
  );
  const blue = fills.findIndex((f) => f.style === '#0000ff');
  const green = fills.findIndex((f) => f.style === '#00ff00');
  assert.ok(blue >= 0 && green > blue, 'over the block inside it');
});

test("a block's outline is drawn over the lines after it, and under positioned boxes", async () => {
  // as browsers draw it, after the flow's lines (CSS 2.1 Appendix E, step
  // 10 leaves the choice): drawn after its own, an inline-block after it
  // went over it
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="height:10px;outline:4px solid #ff00ff"></div>' +
      '<span style="display:inline-block;width:20px;height:20px;' +
      'background:#00ffff"></span>' +
      '<div style="position:relative;height:5px;background:#00ff00"></div>',
  );
  const fills = await fillsOf(view(node));
  const inline = fills.findIndex((f) => f.style === '#00ffff');
  const outline = fills.findIndex((f) => f.style === '#ff00ff');
  const positioned = fills.findIndex((f) => f.style === '#00ff00');
  assert.ok(
    inline >= 0 && outline > inline && positioned > outline,
    `${inline} ${outline} ${positioned}`,
  );
});

test("an inline box's outline is drawn round its fragment", async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><p>a <span style="outline:1px solid ' +
      '#ff0000">framed</span> word</p>',
  );
  const fills = await fillsOf(view(node));
  assert.strictEqual(fills.filter((f) => f.style === '#ff0000').length, 4);
});

test("an element of display: contents has no box, and its children are its parent's", async () => {
  // dropped, so the element stayed a block: a wrapper Tailwind's
  // `contents` takes out of a flex row was one item, its children stacked
  // in it
  const { node } = await render(
    '<style>body{margin:0}.i{width:40px;height:20px}' +
      '.w::before{content:"";display:block;width:10px;height:20px}</style>' +
      '<div id="row" style="display:flex;gap:5px">' +
      '<div id="w" class="w" style="display:contents;color:#ff0000">' +
      '<div id="a" class="i"></div><div id="b" class="i"></div></div>' +
      '<div id="c" class="i"></div></div>' +
      '<div style="display:contents;color:#00ff00"><p id="p">text</p></div>' +
      '<img id="img" style="display:contents" width="30" height="30">' +
      '<p id="ref" style="color:#00ff00">text</p>',
  );
  const el = view(node);
  const row = boxOf(el, 'row') as unknown as { children: LaidBox[] };
  // the `::before`, a, b and c are the row's four items
  assert.strictEqual(row.children.filter((c) => c.width > 0).length, 4);
  const x = (id: string) => boxOf(el, id).x;
  assert.deepStrictEqual([x('a'), x('b'), x('c')], [15, 60, 105]);
  const color = (id: string) =>
    (boxOf(el, id) as unknown as { style: { color: string } }).style.color;
  assert.strictEqual(color('p'), color('ref'), 'what is in it inherits');
  const tree = (el as unknown as { _tree: { root: LaidBox } })._tree.root;
  const find = (box: LaidBox, id: string): boolean =>
    box.el?.attribs.id === id || box.children.some((c) => find(c, id));
  assert.ok(!find(tree, 'w'), 'no box for the element');
  assert.ok(!find(tree, 'img'), 'a replaced element is not rendered');
});

test('background-clip: text and -webkit-text-fill-color are read', async () => {
  const { node } = await render(
    '<style>.clip{-webkit-background-clip:text}</style>' +
      '<div id="a" style="background-clip:text"></div>' +
      '<div id="b" class="clip"></div>' +
      '<div id="c" style="background-clip:text;background-clip:padding-box"></div>' +
      '<div id="d" class="clip" style="background:#ff0000"></div>' +
      '<div id="e" style="color:#00ff00;-webkit-text-fill-color:transparent">' +
      '<span id="f"></span></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { backgroundClipText: boolean; textFillColor: string | null };
      }
    ).style;
  assert.strictEqual(style('a').backgroundClipText, true);
  assert.strictEqual(style('b').backgroundClipText, true, 'prefixed');
  assert.strictEqual(style('c').backgroundClipText, false);
  assert.strictEqual(
    style('d').backgroundClipText,
    false,
    'the shorthand resets it',
  );
  assert.strictEqual(style('e').textFillColor, 'transparent');
  assert.strictEqual(style('f').textFillColor, 'transparent', 'inherited');
});

metric(
  'a background painted through its text fills the glyphs, and not its box',
  async () => {
    // `bg-clip-text text-transparent`: the box was painted with its gradient
    // and the text drawn in no ink over it, a bar where the headline was
    const { result } = await render(
      '<style>body{margin:0}h1{margin:0;font:48px/1 sans-serif;width:360px;' +
        'background:linear-gradient(90deg,#ff0000,#0000ff);' +
        '-webkit-background-clip:text;background-clip:text;color:transparent}' +
        '</style><h1>HHHHHHH</h1>',
    );
    const ink: [number, number, number][] = [];
    let white = 0;
    for (let x = 0; x < 360; x += 2) {
      const [r, g, b] = await pixelAt(result.ctx, x, 24);
      if (r > 240 && g > 240 && b > 240) white += 1;
      else if (g < 60) ink.push([x, r, b]);
    }
    assert.ok(ink.length > 20, `${ink.length} pixels of ink`);
    assert.ok(
      white > 20,
      'the box between and after the glyphs is not painted',
    );
    const [, r0, b0] = ink[0];
    const [, r1, b1] = ink[ink.length - 1];
    assert.ok(r0 > b0, `the first glyph is the gradient's start: ${r0}, ${b0}`);
    assert.ok(b1 > r1, `and the last towards its end: ${r1}, ${b1}`);
    // above the glyphs, inside the box
    assert.ok(isNear(await pixelAt(result.ctx, 180, 2), '#ffffff'));
  },
);

metric(
  'text a span paints its background through keeps its neighbours ink',
  async () => {
    const { result } = await render(
      '<style>body{margin:0}p{margin:0;font:48px/1 sans-serif}' +
        'span{background:linear-gradient(#00ff00,#00ff00);' +
        '-webkit-background-clip:text;-webkit-text-fill-color:transparent}' +
        '</style><p style="color:#0000ff">HHH<span>HHH</span></p>',
    );
    let blue = 0;
    let green = 0;
    for (let x = 0; x < 240; x += 1) {
      const [r, g, b] = await pixelAt(result.ctx, x, 24);
      if (b > 200 && g < 80 && r < 80) blue += 1;
      if (g > 200 && b < 80 && r < 80) green += 1;
    }
    assert.ok(blue > 10, `${blue} blue`);
    assert.ok(
      green > 10,
      `${green} green: the span's glyphs, in its background`,
    );
  },
);

test('translate and the translation in a transform are read', async () => {
  const { node } = await render(
    '<div id="a" style="translate:10px 20%"></div>' +
      '<div id="b" style="translate:5px"></div>' +
      '<div id="c" style="translate:5px;translate:none"></div>' +
      '<div id="d" style="translate:1px 2px 3px"></div>' +
      '<div id="e" style="translate:4px;translate:1px 2px 3%"></div>' +
      '<div id="f" style="transform:translate(-50%, -50%)"></div>' +
      '<div id="g" style="transform:translateX(10px) translateY(5px) ' +
      'rotate(45deg) translate(1px, 1px)"></div>' +
      '<div id="h" style="transform:rotate(0) scale(1.5)"></div>' +
      '<div id="i" style="transform:matrix(1, 0, 0, 1, 10, 20)"></div>' +
      '<div id="j" style="transform:none"></div>' +
      '<div id="k" style="transform:translateX(3px);transform:wobble(1px)"></div>' +
      '<div id="l" style="--x:calc(calc(1/2 * 100%) * -1);' +
      'translate:var(--x) 0"></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { translate: unknown; transformTranslate: unknown };
      }
    ).style;
  assert.deepStrictEqual(style('a').translate, [10, { pct: 20 }]);
  assert.deepStrictEqual(style('b').translate, [5, 0]);
  assert.strictEqual(style('c').translate, null);
  assert.deepStrictEqual(style('d').translate, [1, 2], 'a depth is dropped');
  assert.deepStrictEqual(style('e').translate, [4, 0], 'a depth is a length');
  assert.deepStrictEqual(style('f').transformTranslate, [
    { pct: -50 },
    { pct: -50 },
  ]);
  assert.deepStrictEqual(style('g').transformTranslate, [11, 6]);
  assert.deepStrictEqual(
    style('h').transformTranslate,
    [0, 0],
    'rotating and scaling are read and not drawn',
  );
  assert.deepStrictEqual(style('i').transformTranslate, [10, 20]);
  assert.strictEqual(style('j').transformTranslate, null);
  assert.deepStrictEqual(style('k').transformTranslate, [3, 0]);
  assert.deepStrictEqual(style('l').translate, [{ pct: -50, px: 0 }, 0]);
});

test('a translated box is moved by a share of its own size', async () => {
  // `absolute left-1/2 -translate-x-1/2` and `translate(-50%, -50%)` were
  // dropped, and what they centre hung off to the right by half its width
  const { node } = await render(
    '<style>body{margin:0}.f{position:relative;width:300px;height:100px}' +
      '.c{position:absolute;width:80px;height:20px}</style>' +
      '<div class="f"><div id="a" class="c" style="top:50%;left:50%;' +
      'transform:translate(-50%, -50%)"></div>' +
      '<div id="b" class="c" style="top:0;left:50%;' +
      'translate:calc(calc(1/2 * 100%) * -1) 0"></div></div>' +
      '<div id="n" style="translate:10px 5px;height:10px"></div>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  assert.deepStrictEqual([a.x, a.y], [110, 40], 'centred');
  const b = boxOf(el, 'b');
  assert.deepStrictEqual([b.x, b.y], [110, 0]);
  const n = boxOf(el, 'n');
  assert.deepStrictEqual([n.x, n.y], [10, 105], 'after where it was laid out');
});

test('a transformed box holds the absolute boxes inside it', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><div style="height:50px"></div>' +
      '<div style="transform:translate(0, 0);height:40px">' +
      '<div id="a" style="position:absolute;top:0;left:10px;width:5px;' +
      'height:5px"></div></div>',
  );
  const a = boxOf(view(node), 'a');
  assert.deepStrictEqual([a.x, a.y], [10, 50], 'against it, not the page');
});

test('a translated block is painted over the flow after it', async () => {
  const { node } = await render(
    '<style>body{margin:0}div{height:20px}</style>' +
      '<div style="translate:0 10px;background:#ff0000"></div>' +
      '<div style="background:#0000ff"></div>',
  );
  const fills = await fillsOf(view(node));
  const order = fills
    .map((f) => f.style)
    .filter((c) => c === '#ff0000' || c === '#0000ff');
  assert.deepStrictEqual(order, ['#0000ff', '#ff0000']);
});

test('text-wrap and white-space-collapse change their halves of white-space', async () => {
  const { node } = await render(
    '<div id="a" style="text-wrap:nowrap"></div>' +
      '<div id="b" style="white-space:pre;text-wrap:wrap"></div>' +
      '<div id="c" style="white-space:nowrap;text-wrap:balance"></div>' +
      '<div id="d" style="white-space:nowrap;text-wrap-style:balance"></div>' +
      '<div id="e" style="white-space:pre-wrap;text-wrap-mode:nowrap"></div>' +
      '<div id="f" style="white-space-collapse:preserve"></div>' +
      '<div id="g" style="white-space:pre;white-space-collapse:collapse"></div>' +
      '<div id="h" style="white-space:break-spaces"></div>' +
      '<div id="i" style="text-wrap:nowrap;text-wrap:nowrap wrap"></div>' +
      '<div style="text-wrap:balance"><p id="j"></p></div>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { whiteSpace: string; textWrapStyle: string };
      }
    ).style;
  const seen = (id: string) => [style(id).whiteSpace, style(id).textWrapStyle];
  assert.deepStrictEqual(
    seen('a'),
    ['nowrap', 'auto'],
    "Tailwind 4's text-nowrap",
  );
  assert.deepStrictEqual(seen('b'), ['pre-wrap', 'auto']);
  assert.deepStrictEqual(
    seen('c'),
    ['normal', 'balance'],
    'the shorthand wraps',
  );
  assert.deepStrictEqual(
    seen('d'),
    ['nowrap', 'balance'],
    'the longhand does not',
  );
  assert.deepStrictEqual(seen('e'), ['pre', 'auto']);
  assert.deepStrictEqual(seen('f'), ['pre-wrap', 'auto']);
  assert.deepStrictEqual(seen('g'), ['nowrap', 'auto']);
  assert.deepStrictEqual(seen('h'), ['pre-wrap', 'auto']);
  assert.deepStrictEqual(seen('i'), ['nowrap', 'auto'], 'two modes is none');
  assert.deepStrictEqual(seen('j'), ['normal', 'balance'], 'inherited');
});

metric(
  'text-wrap: balance evens a heading out and sets it in the whole width',
  async () => {
    // dropped, and a heading ended on a word of its own
    const heading =
      'Build desktop interfaces in React and ship them to every platform today';
    const { node } = await render(
      '<style>body{margin:0}h2{width:360px;font-size:24px;margin:0}</style>' +
        `<h2 id="ragged">${heading}</h2>` +
        `<h2 id="even" style="text-wrap:balance">${heading}</h2>` +
        `<h2 id="centred" style="text-wrap:balance;text-align:center">${heading}</h2>`,
    );
    const el = view(node);
    const lines = (id: string) =>
      (boxOf(el, id) as unknown as { lines: { x: number; width: number }[] })
        .lines;
    const ragged = lines('ragged');
    const even = lines('even');
    assert.strictEqual(even.length, ragged.length, 'as many lines');
    const spread = (ls: { width: number }[]) =>
      Math.max(...ls.map((l) => l.width)) - Math.min(...ls.map((l) => l.width));
    assert.ok(
      spread(even) < spread(ragged) / 2,
      `${spread(even)} against ${spread(ragged)}`,
    );
    assert.ok(Math.max(...even.map((l) => l.width)) < 360);
    for (const line of lines('centred')) {
      assert.ok(
        Math.abs(line.x - (360 - line.width) / 2) < 1,
        `centred in the whole width: ${line.x}, ${line.width}`,
      );
    }
  },
);

metric('a paragraph of more than six lines is not balanced', async () => {
  const text = 'Some words of a paragraph that runs on. '.repeat(8);
  const { node } = await render(
    '<style>body{margin:0}p{width:200px;margin:0}</style>' +
      `<p id="a">${text}</p><p id="b" style="text-wrap:balance">${text}</p>`,
  );
  const el = view(node);
  const widths = (id: string) =>
    (boxOf(el, id) as unknown as { lines: { width: number }[] }).lines.map(
      (l) => l.width,
    );
  assert.ok(widths('a').length > 6);
  assert.deepStrictEqual(widths('b'), widths('a'));
});

test('an intrinsic size is read beside an auto length', async () => {
  const { node } = await render(
    '<style>.full{width:100%;height:60px}.fit{width:fit-content;' +
      'height:fit-content}</style>' +
      '<div id="a" style="width:fit-content"></div>' +
      '<div id="b" style="width:-moz-max-content"></div>' +
      '<div id="c" style="width:min-content;width:40px"></div>' +
      '<div id="d" class="full fit"></div>' +
      '<div id="e" style="min-width:max-content;max-width:fit-content"></div>' +
      '<div id="f" style="max-width:min-content;max-width:none"></div>',
  );
  const el = view(node);
  type Sized = {
    width: unknown;
    height: unknown;
    minWidth: unknown;
    maxWidth: unknown;
    widthKeyword: string | null;
    minWidthKeyword: string | null;
    maxWidthKeyword: string | null;
  };
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: Sized }).style;
  assert.deepStrictEqual(
    [style('a').width, style('a').widthKeyword],
    ['auto', 'fit-content'],
  );
  assert.strictEqual(style('b').widthKeyword, 'max-content', 'prefixed');
  assert.deepStrictEqual(
    [style('c').width, style('c').widthKeyword],
    [40, null],
    'a length after it is the width',
  );
  assert.deepStrictEqual(
    [style('d').width, style('d').widthKeyword, style('d').height],
    ['auto', 'fit-content', 'auto'],
    'and it is the width after a length, as a height is auto',
  );
  assert.deepStrictEqual(
    [
      style('e').minWidthKeyword,
      style('e').maxWidth,
      style('e').maxWidthKeyword,
    ],
    ['max-content', 'none', 'fit-content'],
  );
  assert.strictEqual(style('f').maxWidthKeyword, null);
});

metric(
  'a block is as wide as its content where its width is an intrinsic size',
  async () => {
    // `w-fit` and `w-max` were dropped, and the block filled its row
    const { node } = await render(
      '<style>body{margin:0}div{padding:0 5px}.p{width:200px;padding:0}' +
        '.f{float:left;clear:left}</style>' +
        '<div class="p"><div id="fit" style="width:fit-content">A few words</div>' +
        '<div id="centred" style="width:fit-content;margin:0 auto">A few words</div>' +
        '<div id="max" style="width:max-content">Words that run well past the parent</div>' +
        '<div id="min" style="width:min-content">Words longestword</div>' +
        '<div id="long" style="width:fit-content">Words that run well past the parent</div>' +
        '</div><div class="p">' +
        '<div class="f" id="ref-fit">A few words</div>' +
        '<div class="f" id="ref-min">longestword</div></div>' +
        '<div style="width:1000px"><div class="f" id="ref-max">' +
        'Words that run well past the parent</div></div>',
    );
    const el = view(node);
    const width = (id: string) => boxOf(el, id).width;
    assert.ok(width('fit') < 150, `${width('fit')}`);
    assert.strictEqual(width('fit'), width('ref-fit'), 'shrunk to fit');
    assert.strictEqual(
      boxOf(el, 'centred').x,
      (200 - width('centred')) / 2,
      'and centred by its auto margins',
    );
    assert.ok(width('max') > 200, `${width('max')}`);
    assert.strictEqual(width('max'), width('ref-max'), 'its longest line');
    assert.strictEqual(width('min'), width('ref-min'), 'its longest word');
    assert.strictEqual(width('long'), 200, 'no wider than its room');
  },
);

metric(
  'fit-content() fits the content in the room its argument makes',
  async () => {
    // CSS Sizing 3, 3.1: min(max-content, max(min-content, the argument)),
    // for a width, a least width and a greatest width alike — and the
    // content's own sizes, whatever width the box has beside them: probed
    // at no width, a box with a width answered the probe's
    const { node } = await render(
      '<style>body{margin:0} i{display:inline-block;width:60px;' +
        'height:10px}</style><div style="width:400px">' +
        '<div id="a" style="width:fit-content(100px)"><i></i> <i></i></div>' +
        '<div id="b" style="width:fit-content(10%)"><i></i> <i></i></div>' +
        '<div id="c" style="width:fit-content(500px)"><i></i> <i></i></div>' +
        '<div id="d" style="width:200px;max-width:fit-content(100px)">' +
        '<i></i> <i></i></div>' +
        '<div id="e" style="width:50px;min-width:fit-content(100px)">' +
        '<i></i> <i></i></div>' +
        '<div id="f" style="width:10px;min-width:min-content">' +
        '<i></i> <i></i></div></div>',
    );
    const el = view(node);
    const width = (id: string) => boxOf(el, id).width;
    assert.strictEqual(width('a'), 100, 'the argument, between the two');
    assert.strictEqual(width('b'), 60, 'no narrower than its widest word');
    const widest = width('c');
    assert.ok(widest > 120 && widest < 130, `its content's widest: ${widest}`);
    assert.strictEqual(width('d'), 100);
    assert.strictEqual(width('e'), 100);
    assert.strictEqual(width('f'), 60, "its content's, not its width's");
  },
);

metric(
  "an intrinsic size is a flex item's width, stretched or not",
  async () => {
    const { node } = await render(
      '<style>body{margin:0}span{padding:0 4px}</style>' +
        '<div style="display:flex;flex-direction:column;width:300px">' +
        '<div id="badge" style="width:fit-content">New</div>' +
        '<div id="stretched">New</div></div>' +
        '<div style="display:flex;width:200px">' +
        '<div id="whole" style="min-width:max-content">stays whole here</div>' +
        '<div id="wraps">this one shrinks and wraps instead</div></div>' +
        '<div style="width:1000px"><div style="float:left" id="ref">' +
        'stays whole here</div></div>',
    );
    const el = view(node);
    const width = (id: string) => boxOf(el, id).width;
    assert.strictEqual(width('stretched'), 300);
    assert.ok(width('badge') < 100, `${width('badge')}: not stretched`);
    assert.strictEqual(
      width('whole'),
      width('ref'),
      'min-w-max keeps a row item from shrinking below its content',
    );
  },
);

metric(
  'an absolute box with both offsets and an intrinsic width is centred by its margins',
  async () => {
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="position:relative;width:400px;height:40px">' +
        '<div id="pop" style="position:absolute;left:0;right:0;margin:0 auto;' +
        'width:fit-content">A tooltip</div></div>',
    );
    const pop = boxOf(view(node), 'pop');
    assert.ok(pop.width < 200, `${pop.width}: not stretched`);
    assert.strictEqual(pop.x, (400 - pop.width) / 2);
  },
);

test('background layers are read, top first, from the shorthand and the longhands', async () => {
  const { node } = await render(
    '<style>.d{background-image:url(a.png),url(b.png)}' +
      '.d{background-image:url(c.png)}</style>' +
      '<div id="r" style="background:#eeeeee"></div>' +
      '<div id="a" style="background:linear-gradient(#000000,#ffffff),' +
      'url(a.png) center / cover no-repeat #eeeeee"></div>' +
      '<div id="b" style="background-image:url(a.png),url(b.png);' +
      'background-position:left top,right bottom;' +
      'background-repeat:no-repeat"></div>' +
      '<div id="c" style="background:#eeeeee;' +
      'background:#ff0000,url(a.png)"></div>' +
      '<div id="d" class="d"></div>',
  );
  const el = view(node);
  type Layered = {
    backgroundColor: string | null;
    backgroundImage: string | null;
    backgroundGradient: object | null;
    backgroundSize: unknown;
    backgroundRepeat: readonly string[];
    backgroundPositionX: unknown;
    backgroundImages: unknown[] | null;
    backgroundRepeats: (readonly string[])[] | null;
    backgroundSizes: unknown[] | null;
    backgroundPositions: unknown[] | null;
  };
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: Layered }).style;
  const a = style('a');
  assert.strictEqual(a.backgroundImages?.length, 2);
  assert.strictEqual(a.backgroundGradient, a.backgroundImages![0]);
  assert.strictEqual(a.backgroundImage, null, 'the first layer is the top');
  assert.strictEqual(a.backgroundImages![1], 'a.png');
  assert.deepStrictEqual(a.backgroundSizes, ['auto', 'cover']);
  assert.deepStrictEqual(a.backgroundRepeats, [
    ['repeat', 'repeat'],
    ['no-repeat', 'no-repeat'],
  ]);
  assert.deepStrictEqual(a.backgroundPositions, [
    [0, 0],
    [{ pct: 50 }, { pct: 50 }],
  ]);
  assert.strictEqual(
    a.backgroundColor,
    style('r').backgroundColor,
    'the last layer carries the colour',
  );
  const b = style('b');
  assert.deepStrictEqual(b.backgroundImages, ['a.png', 'b.png']);
  assert.deepStrictEqual(b.backgroundPositions, [
    [0, 0],
    [{ pct: 100 }, { pct: 100 }],
  ]);
  assert.strictEqual(b.backgroundRepeats, null, 'one value, for every layer');
  assert.deepStrictEqual(b.backgroundRepeat, ['no-repeat', 'no-repeat']);
  const c = style('c');
  assert.strictEqual(
    c.backgroundColor,
    style('r').backgroundColor,
    'a colour before the last layer makes the declaration invalid',
  );
  assert.strictEqual(c.backgroundImages, null);
  const d = style('d');
  assert.strictEqual(d.backgroundImages, null, 'one image is one layer');
  assert.strictEqual(d.backgroundImage, 'c.png');
});

test('background layers are painted bottom first, over the colour', async () => {
  // only the last layer of a shorthand was kept, and only the first of
  // `background-image`: a gradient over a photograph drew one of them
  const { node } = await render(
    '<style>body{margin:0}div{width:100px;height:100px}</style>' +
      '<div style="background:url(top.png) no-repeat,' +
      'url(bottom.png) no-repeat 50px 50px,#eeeeee"></div>' +
      '<div style="background:linear-gradient(rgba(0,0,0,.5),' +
      'rgba(0,0,0,.5)),url(photo.png) center / cover"></div>',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    backgroundImageFor: (url) =>
      url === 'top.png'
        ? { image: {}, width: 10, height: 10, ratio: 1 }
        : url === 'bottom.png'
          ? { image: {}, width: 20, height: 20, ratio: 1 }
          : { image: {}, width: 20, height: 10, ratio: 2 },
  });
  const drawn = ops.flatMap((op): object[] =>
    op.op === 'image'
      ? [{ at: [op.x, op.y], size: [op.w, op.h] }]
      : op.op === 'fill' && op.y < 200
        ? [{ fill: typeof op.style === 'object' ? 'gradient' : 'colour' }]
        : [],
  );
  assert.deepStrictEqual(drawn, [
    { fill: 'colour' },
    { at: [50, 50], size: [20, 20] },
    { at: [0, 0], size: [10, 10] },
    // covering a square, centred
    { at: [-50, 100], size: [200, 100] },
    { fill: 'gradient' },
  ]);
});

test('a property with fewer values than the images takes them over again', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px;height:100px;' +
      'background-image:url(a.png),url(b.png),url(c.png);' +
      'background-size:10px 10px,20px 20px;background-repeat:no-repeat">' +
      '</div>',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    backgroundImageFor: () => ({ image: {}, width: 5, height: 5, ratio: 1 }),
  });
  // c, b and a, bottom up: the first size, the second, and the first again
  assert.deepStrictEqual(
    ops.flatMap((op) => (op.op === 'image' ? [op.w] : [])),
    [10, 20, 10],
  );
});

test("the root's background layers cover the canvas", async () => {
  const { node } = await render(
    '<html style="background:url(a.png) no-repeat,' +
      'url(b.png) no-repeat 30px 30px"><body></body></html>',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    backgroundImageFor: (url) =>
      url === 'a.png'
        ? { image: {}, width: 10, height: 10, ratio: 1 }
        : { image: {}, width: 20, height: 20, ratio: 1 },
  });
  assert.deepStrictEqual(
    ops.flatMap((op) => (op.op === 'image' ? [[op.x, op.y, op.w]] : [])),
    [
      [30, 30, 20],
      [0, 0, 10],
    ],
  );
});

test("every layer's image is asked for", async () => {
  const asked: string[] = [];
  await renderX11(
    h(Html, {
      source:
        '<div style="background:url(one.png),linear-gradient(red,blue),' +
        'url(two.png)">x</div>',
      partial: false,
      onResource: (r: { url: string; kind: string }) => {
        if (r.kind === 'image') asked.push(r.url);
        return null;
      },
    }),
    FONTS ? { width: 200, height: 100, fonts: FONTS } : { backend: 'mock' },
  );
  assert.deepStrictEqual(asked.sort(), ['one.png', 'two.png']);
});

metric('a layer is drawn over the one under it', async () => {
  const ctx = await renderWithImages(
    '<style>body{margin:0}div{width:60px;height:30px;' +
      'background:linear-gradient(#0000ff,#0000ff) no-repeat 20px 10px / ' +
      '5px 5px,url(red.png) no-repeat 20px 10px,#00ff00}</style><div></div>',
  );
  await expectPixel(ctx, 22, 12, '#0000ff', {
    message: 'the top layer, over the image',
  });
  await expectPixel(ctx, 27, 17, '#ff0000', { message: 'the image' });
  await expectPixel(ctx, 5, 5, '#00ff00', { message: 'the colour' });
});

test("an image is trimmed to its box's corners", async () => {
  // an avatar is a round photograph: a replaced image is clipped to the
  // curve of its content edge, and a background to its box's
  const { node } = await render(
    '<style>body{margin:0}</style><img src="a.png" style="display:block;' +
      'width:40px;height:40px;border-radius:50%;border:2px solid #000">' +
      '<div style="width:60px;height:30px;border-radius:50%;' +
      'background-image:url(b.png)"></div><img src="c.png" ' +
      'style="display:block;width:40px;height:40px">',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    imageFor: () => ({}),
    backgroundImageFor: () => ({ image: {}, width: 60, height: 30, ratio: 2 }),
  });
  // each image, and the clip in force where it is drawn
  const drawn = (x: number, y: number) => {
    const i = ops.findIndex(
      (op) => op.op === 'image' && op.x === x && op.y === y,
    );
    assert.ok(i >= 0, `an image drawn at ${x},${y}`);
    let depth = 0;
    for (let j = i - 1; j >= 0; j -= 1) {
      const op = ops[j];
      if (op.op === 'restore') depth += 1;
      else if (op.op === 'save') depth = Math.max(0, depth - 1);
      else if (op.op === 'clip' && depth === 0) return op;
    }
    return null;
  };
  // inside a 2px border: a circle 40px across, its radius 22px less 2px
  const avatar = drawn(2, 2)!;
  assert.deepStrictEqual(
    [avatar.x, avatar.y, avatar.w, avatar.h, avatar.radii],
    [2, 2, 40, 40, [20, 20, 20, 20]],
  );
  // the background's box is 60 by 30: an ellipse, clipped in curves
  const background = drawn(0, 44)!;
  assert.deepStrictEqual(
    [background.x, background.y, background.w, background.h, background.radii],
    [0, 44, 60, 30, null],
  );
  // and a square image is drawn with no clip of its own
  assert.strictEqual(drawn(0, 74), null);
});

// --- box shadows -----------------------------------------------------------------

test('box-shadow: offsets, blur, spread, a colour and inset in either place', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="a" style="box-shadow:0 1px 3px 0 rgb(0 0 0 / 0.1), ' +
      'inset 0 0 0 1px #d1d5db, 0 0 #0000"></div>' +
      '<div id="b" style="box-shadow:2px 3px red inset"></div>' +
      '<div id="c" style="box-shadow:1px 1px;box-shadow:1px red 2px"></div>' +
      '<div id="d" style="box-shadow:0 0 0 1px #000;box-shadow:none"></div>',
  );
  const el = view(node);
  const shadowOf = (id: string) =>
    (boxOf(el, id) as unknown as { style: { boxShadow: unknown } }).style
      .boxShadow;
  // the transparent one, Tailwind's placeholder, is left out
  assert.deepStrictEqual(shadowOf('a'), [
    {
      x: 0,
      y: 1,
      blur: 3,
      spread: 0,
      color: 'rgba(0, 0, 0, 0.1)',
      inset: false,
    },
    { x: 0, y: 0, blur: 0, spread: 1, color: '#d1d5db', inset: true },
  ]);
  assert.deepStrictEqual(shadowOf('b'), [
    { x: 2, y: 3, blur: 0, spread: 0, color: 'red', inset: true },
  ]);
  // a colour between the lengths drops the declaration, and the one
  // before stands, in currentColor
  assert.deepStrictEqual(shadowOf('c'), [
    { x: 1, y: 1, blur: 0, spread: 0, color: 'currentColor', inset: false },
  ]);
  assert.strictEqual(shadowOf('d'), null);
});

test('a ring is the band between a box and its spread, and needs no clip', async () => {
  // Tailwind's `ring-1` on a box with no background of its own
  const [ring] = await fillsIn(
    '<div style="width:100px;height:40px;margin:5px;' +
      'box-shadow:0 0 0 2px #0f0f0f"></div>',
    '#0f0f0f',
  );
  assert.deepStrictEqual(
    [ring.x, ring.y, ring.w, ring.h, ring.rule],
    [3, 3, 104, 44, 'evenodd'],
  );
  assert.deepStrictEqual(ring.inner, {
    x: 5,
    y: 5,
    w: 100,
    h: 40,
    radii: [0, 0, 0, 0],
  });
  // and `ring-inset`, inside the padding edge
  const [inside] = await fillsIn(
    '<div style="width:100px;height:40px;border:1px solid #fff;' +
      'box-shadow:inset 0 0 0 2px #0e0e0e"></div>',
    '#0e0e0e',
  );
  assert.deepStrictEqual(
    [inside.x, inside.y, inside.w, inside.h],
    [1, 1, 100, 40],
  );
  assert.deepStrictEqual(
    [inside.inner!.x, inside.inner!.y, inside.inner!.w, inside.inner!.h],
    [3, 3, 96, 36],
  );
});

test('a blurred shadow is the shadow of a shape drawn clear of the window', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:100px;height:40px;' +
      'margin:20px;background:#fff;border-radius:8px;' +
      'box-shadow:0 4px 6px -1px #0d0d0d"></div>',
  );
  const ops: PaintOp[] = [];
  const fills = await fillsOf(view(node), ops);
  const shadow = fills.find((f) => f.shadow);
  assert.ok(shadow, 'a fill with a shadow');
  // the spread shrinks the shape and its corners by a pixel; the shape is
  // drawn left of the window, and its shadow offset back onto the box
  assert.deepStrictEqual(
    [shadow.x + shadow.shadow!.x, shadow.y, shadow.w, shadow.h],
    [21, 25, 98, 38],
  );
  assert.ok(shadow.x + shadow.w < 0, 'the shape itself is off the window');
  assert.deepStrictEqual(
    [shadow.shadow!.color, shadow.shadow!.blur, shadow.shadow!.y],
    ['#0d0d0d', 6, 0],
  );
  assert.deepStrictEqual(shadow.radii, [7, 7, 7, 7]);
  // an opaque box covers what falls under it: no clip
  assert.ok(!ops.some((op) => op.op === 'clip'));
});

test('a shadow is not drawn under a box that shows what is behind it', async () => {
  // a hard shadow under a box with no background, clipped out of the box
  const { node } = await render(
    '<style>body{margin:0}</style><div style="width:90px;height:40px;' +
      'margin:10px;box-shadow:5px 5px 0 #0c0c0c"></div>',
  );
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops);
  const at = ops.findIndex(
    (op) => op.op === 'fill' && op.style === parseColor('#0c0c0c'),
  );
  assert.ok(at > 0, 'the shadow is filled');
  const fill = ops[at] as Fill;
  assert.deepStrictEqual([fill.x, fill.y, fill.w, fill.h], [15, 15, 90, 40]);
  const clip = ops
    .slice(0, at)
    .reverse()
    .find((op) => op.op === 'clip');
  assert.ok(clip, 'a clip around it');
});

test("a shadow's reach is ink: a repaint beside the box reaches it", async () => {
  const { node } = await render(
    '<style>body{margin:0}</style><div id="s" style="width:100px;' +
      'height:40px;margin:30px;box-shadow:0 10px 15px -3px #000"></div>',
  );
  const box = boxOf(view(node), 's') as unknown as {
    y: number;
    height: number;
    boundsY: number;
    boundsHeight: number;
  };
  // 10px down, 3px in, and a blur of 15 reaching 23px past the edge: the
  // ink runs from 10px above the box to 30px below it
  assert.deepStrictEqual(
    [box.boundsY - box.y, box.boundsY + box.boundsHeight - box.y - box.height],
    [-10, 30],
  );
});

test('a blurred shadow is drawn once for its geometry and composited after', async () => {
  // ntk blurs a path's shadow afresh on every fill, which put 500ms on a
  // repaint of thirty cards: the same shadow on three cards is one key
  const card =
    '<div style="width:100px;height:40px;margin:10px;background:#fff;' +
    'border-radius:8px;box-shadow:0 4px 6px -1px rgb(0 0 0 / 0.1)"></div>';
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      card.repeat(3) +
      '<div style="width:100px;height:40px;margin:10px;' +
      'box-shadow:0 4px 6px -1px rgb(0 0 0 / 0.1)"></div>',
  );
  const keys: string[] = [];
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, {
    cached: (key) => {
      keys.push(key);
      return {};
    },
  });
  assert.strictEqual(keys.length, 4);
  assert.strictEqual(new Set(keys.slice(0, 3)).size, 1, 'one for the cards');
  // the box with no background has its own, the box cut out of it
  assert.notStrictEqual(keys[3], keys[0]);
  const images = ops.filter((op) => op.op === 'image');
  assert.deepStrictEqual(
    images.map((op) => (op.op === 'image' ? op.y : 0)),
    // the cards 50px apart, their margins collapsed; each image 4px down
    // and a pixel in with its shape, and the blur and one more around it
    [10, 60, 110, 160].map((y) => y + 4 + 1 - 10),
    'each at its card',
  );
  // and no blur was drawn in the window
  assert.ok(!ops.some((op) => op.op === 'clip'));
});

test('the shadow cache keeps a surface per key, the oldest given up first', async () => {
  const result = await renderX11(h('box', { 'data-testname': 'b' }), {
    width: 20,
    height: 20,
  });
  const app = (screen.getByTestName('b') as unknown as { app: unknown }).app;
  const cache = new SurfaceCache(app, 400);
  let drawn = 0;
  const draw = () => {
    drawn += 1;
  };
  const a = cache.get('a', 10, 10, draw);
  assert.ok(a, 'a surface');
  assert.strictEqual(cache.get('a', 10, 10, draw), a);
  assert.strictEqual(drawn, 1, 'drawn once');
  // one larger than a quarter of the budget is not made
  assert.strictEqual(cache.get('big', 11, 10, draw), null);
  // four more of 100 pixels: the first is given up for the fifth
  for (const key of ['b', 'c', 'd', 'e']) cache.get(key, 10, 10, draw);
  assert.strictEqual(drawn, 5);
  cache.get('a', 10, 10, draw);
  assert.strictEqual(drawn, 6, 'drawn again');
  cache.destroy();
  void result;
});

// --- aspect-ratio and object-fit ------------------------------------------------

test('aspect-ratio: a ratio, auto, or both', async () => {
  const { node } = await render(
    '<div id="a" style="aspect-ratio:16 / 9"></div>' +
      '<div id="b" style="aspect-ratio:auto 4/3"></div>' +
      '<div id="c" style="aspect-ratio:1;aspect-ratio:auto"></div>' +
      '<div id="d" style="aspect-ratio:2;aspect-ratio:0 / 1"></div>' +
      '<div id="e" style="aspect-ratio:3;aspect-ratio:wide"></div>',
  );
  const el = view(node);
  const ratioOf = (id: string) =>
    (boxOf(el, id) as unknown as { style: { aspectRatio: unknown } }).style
      .aspectRatio;
  assert.deepStrictEqual(ratioOf('a'), { ratio: 16 / 9, auto: false });
  assert.deepStrictEqual(ratioOf('b'), { ratio: 4 / 3, auto: true });
  assert.strictEqual(ratioOf('c'), null);
  // a ratio with a nought in it is none, and a word that is no ratio is
  // dropped, leaving the one before
  assert.strictEqual(ratioOf('d'), null);
  assert.deepStrictEqual(ratioOf('e'), { ratio: 3, auto: false });
});

test('aspect-ratio makes an auto height of the width, grown to what it holds', async () => {
  // Tailwind's aspect-video and aspect-square, whose boxes were as tall as
  // their content, and so nothing at all when empty
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="a" style="width:320px;aspect-ratio:16/9"></div>' +
      // of the border box where box-sizing says so, and of the content box
      '<div id="b" style="width:100px;padding:10px;box-sizing:border-box;' +
      'aspect-ratio:1"></div>' +
      '<div id="c" style="width:100px;padding:10px;aspect-ratio:1"></div>' +
      // grown to its content, unless it clips
      '<div id="d" style="width:100px;aspect-ratio:4"><div style="height:60px">' +
      '</div></div>' +
      '<div id="e" style="width:100px;aspect-ratio:4;overflow:hidden">' +
      '<div style="height:60px"></div></div>' +
      // and a height it gives is one a percentage resolves against
      '<div style="width:200px;aspect-ratio:2"><div id="f" style="height:50%">' +
      '</div></div>' +
      '<iframe id="g" style="width:320px;aspect-ratio:16/9;border:0"></iframe>',
  );
  const el = view(node);
  const heightOf = (id: string) => boxOf(el, id).height;
  assert.strictEqual(heightOf('a'), 180);
  assert.strictEqual(heightOf('b'), 100);
  assert.strictEqual(heightOf('c'), 120);
  assert.strictEqual(heightOf('d'), 60);
  assert.strictEqual(heightOf('e'), 25);
  assert.strictEqual(heightOf('f'), 50);
  // a frame has no ratio of its own, and takes the one it is given
  assert.strictEqual(heightOf('g'), 180);
});

test('a flex container lays its items out in its content box', async () => {
  // a border-box height holds the padding: `h-16 py-2 items-center` put
  // its items eight pixels low, centred in 64px from the top of 48
  const { node } = await render(
    '<style>body{margin:0} *{box-sizing:border-box}</style>' +
      '<div style="display:flex;align-items:center;height:64px;padding:8px 0">' +
      '<div id="a" style="height:20px;width:50px"></div></div>' +
      // and a column with a minimum height gives its flex-1 the rest
      '<div style="display:flex;flex-direction:column;min-height:300px">' +
      '<div style="height:30px"></div><div id="b" style="flex:1"></div>' +
      '<div id="c" style="height:30px"></div></div>' +
      // an aspect-ratio box centres in the height its ratio gives it
      '<div style="width:320px;aspect-ratio:16/9;display:flex;' +
      'align-items:center;justify-content:center">' +
      '<div id="d" style="width:40px;height:40px"></div></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').y, 22);
  assert.strictEqual(boxOf(el, 'b').height, 240);
  assert.strictEqual(boxOf(el, 'c').y, 334);
  const d = boxOf(el, 'd');
  assert.deepStrictEqual([d.x, d.y - 364], [140, 70]);
});

test('a flex item is no smaller than its content, unless its minimum says', async () => {
  // `min-width: auto` in a row and `min-height: auto` in a column are the
  // least an item's content comes to (CSS Flexbox 4.5). Yoga has no such
  // minimum: it shrank a row's items under what they held, and a column's
  // first item under its content, which the next one was drawn over.
  const { node } = await render(
    '<style>body{margin:0} .i{display:inline-block;width:150px;' +
      'height:10px}</style>' +
      '<div style="display:flex;width:200px">' +
      '<div id="a" style="flex:1"><span class="i"></span></div>' +
      '<div id="b" style="flex:1"><span class="i"></span></div></div>' +
      // `min-w-0` lets it go, and so does a box that clips
      '<div style="display:flex;width:200px">' +
      '<div id="c" style="flex:1;min-width:0"><span class="i"></span></div>' +
      '<div id="d" style="flex:1;overflow:hidden"><span class="i"></span>' +
      '</div></div>' +
      '<div style="display:flex;flex-direction:column;height:30px">' +
      '<div id="e"><div style="height:60px"></div></div>' +
      '<div id="f" style="height:20px"></div></div>',
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  assert.deepStrictEqual(
    [box('a').width, box('b').width],
    [150, 150],
    'a row overflows before an item shrinks under its content',
  );
  assert.ok(box('c').width < 150, 'min-width: 0');
  assert.ok(box('d').width < 150, 'overflow: hidden');
  assert.strictEqual(box('e').height, 60, 'a column item');
  assert.strictEqual(box('f').y, box('e').y + 60, 'and the one after it');
});

test('what is in a stretched or flexed item takes its percentages of its height', async () => {
  // CSS Flexbox 9.8: an item stretched across its line, or flexed in a
  // column of a height of its own, has a definite height, and `h-full` in
  // it fills it — a sidebar's scrolling list, a column's panel. They had
  // nothing to take a percentage of, and were as tall as their content.
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:flex;height:200px">' +
      '<aside style="width:100px"><div id="a" style="height:100%"></div>' +
      '</aside><main style="flex:1"></main></div>' +
      '<div style="display:flex;flex-direction:column;height:200px">' +
      '<div style="height:40px"></div>' +
      '<div style="flex:1"><div id="b" style="height:50%"></div></div>' +
      '</div>' +
      // and a column item is as tall as the column makes it, shrunk too,
      // to the lesser of its height and its content's
      '<div style="display:flex;flex-direction:column;height:100px">' +
      '<div id="c" style="height:150px"><div style="height:120px"></div>' +
      '</div><div id="d" style="height:150px;min-height:0"></div></div>' +
      // and one with a ratio no shorter than its width through the ratio
      '<div style="display:flex;flex-direction:column;width:100px;height:0">' +
      '<div id="e" style="aspect-ratio:1"></div>' +
      '<div id="f" style="aspect-ratio:2;height:100px"></div></div>',
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  assert.strictEqual(box('a').height, 200, 'h-full in a stretched item');
  assert.strictEqual(box('b').height, 80, 'half of the flexed item');
  assert.strictEqual(box('c').height, 120, 'no shorter than its content');
  assert.strictEqual(box('d').height, 0, 'min-height: 0 lets it go');
  assert.strictEqual(box('e').height, 100, 'a square stays square');
  assert.strictEqual(box('f').height, 50, 'shrunk to its ratio');
});

metric(
  'a flex row measured for its content does not grow its flex: 1 items',
  async () => {
    // Tailwind UI's list item: a row of an avatar and a column that takes
    // `flex-1`, beside a column of a role and a badge. Measuring the row's
    // max-content laid it out at an infinite width, which Yoga took for a
    // width and grew the column to fill; the row came back vast, and the
    // role beside it was squeezed until "Designer" broke inside itself.
    const { node } = await render(
      '<style>body{margin:0} *{box-sizing:border-box;margin:0}</style>' +
        '<div style="display:flex;align-items:center;' +
        'justify-content:space-between;gap:24px;width:600px">' +
        '<div id="left" style="display:flex;min-width:0;gap:16px">' +
        '<div style="width:48px;height:48px"></div>' +
        '<div id="col" style="min-width:0;flex:1"><p>Leslie Alexander</p>' +
        '<p>leslie.alexander@example.com</p></div></div>' +
        '<div id="right" style="display:flex;flex-direction:column;' +
        'align-items:center"><p id="role">Co-Founder / CEO</p>' +
        '<span>Active</span></div></div>',
    );
    const el = view(node);
    const left = boxOf(el, 'left');
    const col = boxOf(el, 'col');
    // the left side is as wide as its content: the avatar, the gap, the text
    assert.ok(
      Math.abs(left.width - (48 + 16 + col.width)) < 0.5,
      `${left.width} is the avatar, the gap and ${col.width}`,
    );
    assert.ok(left.width < 400, `the left side is ${left.width}, not the row`);
    // and the role is on one line
    assert.strictEqual(linesOf(el, 'role').length, 1);
  },
);

test('object-fit places an image in its box, and object-position in it', async () => {
  const fits = ['fill', 'cover', 'contain', 'none', 'scale-down'];
  const { node } = await render(
    '<style>body{margin:0} img{display:block;width:90px;height:90px}</style>' +
      fits
        .map(
          (fit, i) => `<img id="i${i}" src="a.png" style="object-fit:${fit}">`,
        )
        .join('') +
      '<img id="i5" src="a.png" style="object-fit:cover;object-position:left">' +
      '<img id="i6" src="a.png" style="object-fit:scale-down;width:400px;height:200px">',
  );
  const el = view(node);
  // an image twice as wide as it is tall: 240 by 120
  for (let i = 0; i < 7; i += 1) {
    (boxOf(el, `i${i}`) as unknown as { intrinsic: unknown }).intrinsic = {
      width: 240,
      height: 120,
      missing: 0,
      ratio: 2,
    };
  }
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, { imageFor: () => ({}) });
  const drawn = ops.filter((op) => op.op === 'image');
  const at = (i: number) => {
    const op = drawn[i];
    return op.op === 'image' ? [op.x, op.y - i * 90, op.w, op.h] : [];
  };
  assert.deepStrictEqual(at(0), [0, 0, 90, 90], 'fill: stretched');
  assert.deepStrictEqual(at(1), [-45, 0, 180, 90], 'cover: the middle');
  assert.deepStrictEqual(at(2), [0, 23, 90, 45], 'contain: all of it');
  assert.deepStrictEqual(at(3), [-75, -15, 240, 120], 'none: its own size');
  assert.deepStrictEqual(at(4), [0, 23, 90, 45], 'scale-down, when smaller');
  assert.deepStrictEqual(at(5), [0, 0, 180, 90], 'cover, from the left');
  // scale-down in a box larger than the image: its own size, in the middle
  const big = drawn[6];
  assert.ok(big.op === 'image');
  assert.deepStrictEqual([big.x, big.w, big.h], [80, 240, 120]);
  // what falls past its box is clipped to it, and nothing else is
  const clips = ops.filter((op) => op.op === 'clip').length;
  assert.strictEqual(clips, 3, 'cover twice and none');
});

test('object-position places a filled image, and one with a ratio and no size', async () => {
  // CSS Images 3, 5.5: `fill` was drawn at the box whatever object-position
  // said — its lengths still move it — and an image with a ratio and no
  // size of its own, an SVG with only a viewBox, was stretched to the box
  // whatever the fit. And it is placed on the pixel grid, as a
  // background's tile is: 13% of 15 pixels is 1.95
  const { node } = await render(
    '<style>body{margin:0} img{display:block;width:90px;height:60px}</style>' +
      '<img id="a" src="a.png" style="object-position:right 2px bottom 1px">' +
      '<img id="b" src="b.svg" style="object-fit:contain">' +
      '<img id="c" src="c.svg" style="object-fit:none">' +
      '<img id="d" src="d.png" style="object-fit:contain;' +
      'object-position:50% 13%">',
  );
  const el = view(node);
  const own = (id: string, missing: number) => {
    (boxOf(el, id) as unknown as { intrinsic: unknown }).intrinsic = {
      width: missing ? 300 : 240,
      height: missing ? 150 : 120,
      missing,
      ratio: 2,
    };
  };
  own('a', 0);
  own('b', 3);
  own('c', 3);
  own('d', 0);
  const ops: PaintOp[] = [];
  await fillsOf(view(node), ops, { imageFor: () => ({}) });
  const drawn = ops.filter((op) => op.op === 'image');
  const at = (i: number) => {
    const op = drawn[i];
    return op.op === 'image' ? [op.x, op.y - i * 60, op.w, op.h] : [];
  };
  assert.deepStrictEqual(at(0), [-2, -1, 90, 60], 'fill, moved by lengths');
  assert.deepStrictEqual(at(1), [0, 8, 90, 45], 'contain: at its ratio');
  assert.deepStrictEqual(at(2), [0, 8, 90, 45], 'none, with no size: within');
  assert.deepStrictEqual(at(3), [0, 2, 90, 45], 'on the pixel grid');
});

metric("a video's poster and an embedded image are drawn", async () => {
  // A `<video>` and an `<embed>` were frames whatever they pointed at: a
  // video shows its poster, which it fits into its box by the HTML style
  // sheet's `object-fit: contain`, and an embed its image
  const ctx = await renderWithImages(
    '<style>body{margin:0} *{display:block}</style>' +
      '<video poster="p.png" style="width:40px;height:20px"></video>' +
      '<embed src="e.png" style="width:20px;height:20px">',
  );
  await expectPixel(ctx, 20, 10, '#ff0000', { message: "the poster's middle" });
  await expectPixel(ctx, 5, 10, '#ffffff', { message: 'contained: not here' });
  await expectPixel(ctx, 10, 30, '#ff0000', { message: 'the embed' });
});

test("aspect-ratio makes a box's width of its height, and crosses its limits over", async () => {
  // A height and a ratio gave a block the width of its container, and
  // `width: min-content` the width of what was in it
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="a" style="height:50px;aspect-ratio:2"></div>' +
      '<div id="b" style="height:50px;width:min-content;aspect-ratio:2"></div>' +
      // a greatest height is a greatest width through the ratio
      '<div id="c" style="aspect-ratio:1;max-height:40px"></div>' +
      // and a least height of 0 lets the ratio hold its content in
      '<div style="position:relative;height:200px">' +
      '<div id="d" style="position:absolute;aspect-ratio:1;width:100px;' +
      'min-height:0"><div style="height:200px"></div></div>' +
      // both offsets stretch a width that a greatest height then holds
      '<div id="e" style="position:absolute;inset:0;max-height:100px;' +
      'aspect-ratio:1"></div></div>' +
      // a height its ratio gives it parts its two margins, which went on
      // through it as through an empty block's
      '<div id="f"></div><div id="w">' +
      '<div style="width:100px;aspect-ratio:4;margin:10px 0 30px"></div></div>' +
      '<div id="g"></div>',
  );
  const el = view(node);
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  assert.deepStrictEqual(size('a'), [100, 50]);
  assert.deepStrictEqual(size('b'), [100, 50]);
  assert.deepStrictEqual(size('c'), [40, 40]);
  assert.deepStrictEqual(size('d'), [100, 100]);
  assert.deepStrictEqual(size('e'), [100, 100]);
  assert.strictEqual(boxOf(el, 'w').y - boxOf(el, 'f').y, 10);
  assert.strictEqual(boxOf(el, 'g').y - boxOf(el, 'f').y, 10 + 25 + 30);
});

test('a flex item with a ratio sizes across its line from its size along it', async () => {
  const { el } = await renderWithBytes(
    '<style>body{margin:0}</style>' +
      // down a column, as wide as the height it was flexed to
      '<div style="display:inline-flex;flex-direction:column;' +
      'flex-wrap:wrap;height:100px">' +
      '<div id="a" style="aspect-ratio:1;min-height:0;height:50px;flex:1">' +
      '</div></div>' +
      // along a row, as wide as the height it is stretched to, and no
      // narrower than that however little room there is
      '<div style="display:flex;width:0;height:100px">' +
      '<div id="b" style="aspect-ratio:1"></div></div>' +
      '<div style="display:flex;width:0;height:100px">' +
      '<div id="c" style="aspect-ratio:1/2"><div style="width:100px">' +
      '</div></div></div>' +
      // a column's content basis is its width through its ratio
      '<div style="display:flex;flex-direction:column">' +
      '<div id="d" style="flex-basis:content;width:100px;aspect-ratio:1;' +
      'height:20px;min-height:0"></div></div>' +
      // and an image grown along a row is as tall as that makes it
      '<div style="display:flex;width:100px">' +
      '<img id="e" src="r.png" style="width:50px;aspect-ratio:1;flex:1;' +
      'min-height:0"></div>',
    { 'r.png': RED_PNG },
  );
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  await waitFor(() => assert.deepStrictEqual(size('e'), [100, 100]));
  assert.deepStrictEqual(size('a'), [100, 100]);
  assert.deepStrictEqual(size('b'), [100, 100]);
  assert.deepStrictEqual(size('c'), [100, 100], 'its content is wider');
  assert.deepStrictEqual(size('d'), [100, 100]);
});

test("a column with no height keeps its items' flex-basis", async () => {
  // Yoga takes a basis only where the flex box's main size is definite, and
  // read `flex: 0 0 50px` down such a column as the item's own height, or
  // as its content's
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:flex;flex-direction:column">' +
      '<div id="a" style="flex:0 0 50px">x</div>' +
      '<div id="b" style="flex-basis:30px;height:80px;padding:5px"></div>' +
      '</div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').height, 50);
  assert.strictEqual(boxOf(el, 'b').height, 40, 'its content box, padded');
});

test('overflow: clip cuts what overflows, and is no scroll container', async () => {
  // It was read as `hidden`: a formatting context of its own, and no
  // automatic minimum for a flex item (CSS Overflow 3, 3.1)
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:flex;flex-direction:column;height:10px">' +
      '<div id="a" style="overflow:clip"><div style="height:50px"></div>' +
      '</div></div>' +
      '<div id="b" style="overflow:clip"><p id="c" style="margin:20px 0">x' +
      '</p></div>' +
      '<div id="d" style="overflow-x:hidden"></div>' +
      '<div id="e" style="overflow-x:clip"></div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').height, 50, 'its content is its least');
  assert.strictEqual(
    boxOf(el, 'c').y,
    boxOf(el, 'b').y,
    'a margin in it collapses through its top',
  );
  const overflow = (id: string) => {
    const style = (boxOf(el, id) as unknown as { style: ComputedStyle }).style;
    return [style.overflowX, style.overflowY];
  };
  // beside a value that scrolls, `visible` is `auto`; beside `clip`, it
  // stays
  assert.deepStrictEqual(overflow('d'), ['hidden', 'auto']);
  assert.deepStrictEqual(overflow('e'), ['clip', 'visible']);
});

metric("an SVG image's root background covers the image", async () => {
  // A browser paints it over the canvas, which is the whole image, wherever
  // the viewBox puts the drawing; it was not painted at all
  const { result } = await renderWithBytes(
    '<style>body{margin:0}img{display:block}</style>' +
      '<img src="g.svg" style="width:100px;height:40px">',
    {
      'g.svg': svgBytes(
        `<svg ${SVG_NS} viewBox="0 0 1 1" style="background-color:#00ff00">` +
          '</svg>',
      ),
    },
  );
  const ctx = result.ctx;
  await expectPixel(ctx, 50, 20, '#00ff00', { message: 'the middle' });
  await expectPixel(ctx, 5, 20, '#00ff00', { message: 'beside the viewBox' });
});

test('stretch fills what the margins leave of the containing block', async () => {
  // `stretch`, `-webkit-fill-available` and `-moz-available` were dropped
  // (CSS Sizing 3, 4.2): a float, an inline block or an absolute box was
  // as wide as its content
  const { el } = await renderWithBytes(
    '<style>body{margin:0}</style>' +
      '<div style="width:200px">' +
      '<div id="a" style="float:left;width:stretch;margin:0 10px;height:5px">' +
      '</div></div>' +
      '<div style="width:200px"><span id="b" style="display:inline-block;' +
      'width:-webkit-fill-available;height:5px"></span></div>' +
      '<div style="position:relative;width:200px;height:200px">' +
      '<div id="c" style="position:absolute;left:30px;width:stretch;' +
      'height:stretch;bottom:50px"></div>' +
      // with neither offset, from where the flow put it (CSS Position 3)
      '<div style="padding:40px 0 0 60px"><canvas id="d" width="2" ' +
      'height="1" style="position:absolute;width:stretch;height:stretch">' +
      '</canvas></div></div>' +
      // down a parent, less the margins but those that meet no border or
      // padding of the parent's, which would collapse through it
      '<div id="ep" style="height:100px;border-top:1px solid">' +
      '<div id="e" style="height:stretch;margin:10px 0"></div></div>' +
      '<div id="fp" style="height:100px"><div id="f" style="min-height:stretch;' +
      'margin-bottom:50px"></div></div>' +
      '<div style="height:100px"><div id="j" style="height:stretch;' +
      'margin-top:20px"></div></div>' +
      '<div style="height:100px"><div id="g" style="height:500px;' +
      'max-height:stretch"></div></div>' +
      // a replaced box beside a float fills what the float leaves
      '<div style="width:200px"><div style="float:left;width:120px;' +
      'height:10px"></div><canvas id="h" width="1" height="1" ' +
      'style="display:block;width:stretch"></canvas></div>' +
      '<div style="width:200px"><div id="i" style="width:10px;' +
      'min-width:stretch;height:5px"></div></div>',
    {},
  );
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  assert.strictEqual(boxOf(el, 'a').width, 180);
  assert.strictEqual(boxOf(el, 'b').width, 200);
  assert.deepStrictEqual(size('c'), [170, 150]);
  assert.deepStrictEqual(size('d'), [140, 160]);
  assert.strictEqual(
    boxOf(el, 'e').height,
    90,
    'its top margin, not its bottom',
  );
  assert.strictEqual(boxOf(el, 'f').height, 100);
  // and its margin is not taken for one an empty block's would collapse
  // through
  assert.strictEqual(boxOf(el, 'fp').y, boxOf(el, 'ep').y + 101);
  assert.strictEqual(boxOf(el, 'j').height, 100);
  assert.strictEqual(boxOf(el, 'g').height, 100);
  assert.deepStrictEqual(size('h'), [80, 80]);
  assert.strictEqual(boxOf(el, 'i').width, 200);
});

test('a flex item stretched across a column is as tall as its ratio makes it', async () => {
  // a replaced item was measured at the width it was given and answered
  // its natural height, along a column as it did along a row before
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="display:flex;flex-direction:column;width:200px">' +
      '<canvas id="a" width="100" height="50" style="width:stretch;' +
      'align-self:start;min-height:0"></canvas>' +
      '<canvas id="b" width="100" height="50" style="width:50%;' +
      'align-self:start;min-height:0"></canvas></div>',
  );
  const box = (id: string) => boxOf(view(node), id);
  assert.deepStrictEqual([box('a').width, box('a').height], [200, 100]);
  assert.deepStrictEqual([box('b').width, box('b').height], [100, 50]);
});

// --- containment -----------------------------------------------------------------

test('contain: size lays a box out as though it held nothing', async () => {
  // `contain` was dropped whole (CSS Containment 2): a size-contained box
  // is its `contain-intrinsic-size`, or nothing, whatever it holds
  const { el } = await renderWithBytes(
    '<style>body{margin:0} .w{width:120px;height:30px}</style>' +
      '<div id="a" style="float:left;contain:size"><div class="w"></div>' +
      '</div>' +
      '<div id="b" style="float:left;contain:size;' +
      'contain-intrinsic-size:70px 40px;padding:5px"><div class="w"></div>' +
      '</div>' +
      // `inline-size` holds its width and leaves its height its content's
      '<div id="c" style="float:left;contain:inline-size;' +
      'contain-intrinsic-width:25px"><div class="w"></div></div>' +
      '<div id="d" style="contain:strict;contain-intrinsic-height:15px">' +
      '<div class="w"></div></div>' +
      // an image is as though it had no size or ratio of its own
      '<img id="e" src="r.png" style="contain:size;display:block;' +
      'width:80px">' +
      // but the one its width and height attributes give it
      '<img id="f" src="r.png" width="4" height="2" style="contain:size;' +
      'display:block;width:80px;height:auto">',
    { 'r.png': RED_PNG },
  );
  await waitFor(() =>
    assert.strictEqual((boxOf(el, 'e') as ReplacedBox).replaced, 'image'),
  );
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  assert.deepStrictEqual(size('a'), [0, 0]);
  assert.deepStrictEqual(size('b'), [80, 50]);
  assert.deepStrictEqual(size('c'), [25, 30]);
  assert.strictEqual(boxOf(el, 'd').height, 15);
  assert.strictEqual(boxOf(el, 'e').height, 0);
  assert.deepStrictEqual(size('f'), [80, 40]);
});

test('layout and paint containment make a formatting context, a containing block and a clip', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      // an absolute box is placed against the box with layout containment
      '<div style="height:20px"></div>' +
      '<div id="a" style="contain:layout;margin-left:30px;height:40px">' +
      '<div id="b" style="position:absolute;left:0;top:0;width:5px;' +
      'height:5px"></div></div>' +
      // which holds its floats, and parts its child's margin from its own
      '<div id="c" style="contain:paint"><div style="float:left;width:5px;' +
      'height:25px"></div></div>' +
      '<div id="d" style="contain:layout"><p id="e" style="margin:10px 0">' +
      'x</p></div>' +
      // and keeps its baseline in: an inline-block with it sits on its
      // bottom, where one without sits on its first line
      '<div style="line-height:20px"><span id="f" style="display:inline-block;' +
      'contain:layout;height:40px">x</span><span id="g" ' +
      'style="display:inline-block;height:40px">x</span></div>',
  );
  const el = view(node);
  const at = (id: string) => [boxOf(el, id).x, boxOf(el, id).y];
  assert.deepStrictEqual(at('b'), at('a'));
  assert.strictEqual(boxOf(el, 'c').height, 25, 'its float held in');
  assert.strictEqual(boxOf(el, 'e').y - boxOf(el, 'd').y, 10);
  assert.ok(boxOf(el, 'f').y < boxOf(el, 'g').y, 'sat on its bottom');
});

metric('paint containment clips what overflows', async () => {
  const { result } = await renderWithBytes(
    '<style>body{margin:0;background:#ff0000;' +
      'width:50px;height:100px}</style>' +
      '<div style="contain:paint;width:20px;height:20px">' +
      '<div style="width:60px;height:20px;background:#0000ff"></div></div>',
    {},
  );
  const ctx = result.ctx;
  await expectPixel(ctx, 10, 10, '#0000ff', { message: 'inside the clip' });
  await expectPixel(ctx, 40, 10, '#ff0000', { message: 'clipped' });
});

test("containment keeps the body's background to the body", async () => {
  // it was the canvas's: the whole document red around a 50px body
  const fills = await fillsIn(
    '<html style="contain:layout"><body style="background:#fe0000;' +
      'width:50px;height:40px"></body></html>',
    '#fe0000',
  );
  assert.deepStrictEqual(
    fills.map((f) => [f.w, f.h]),
    [[50, 40]],
  );
});

test('overflow-clip-margin moves the edge overflow: clip cuts at', async () => {
  // it was not read: `overflow: clip` cut at the padding box however far
  // out the margin let what overflows show; a scroller keeps its padding
  // box, and an axis let overflow is not cut (CSS Overflow 4, 3.2)
  const box = (id: string, extra: string) =>
    `<div id="${id}" style="width:100px;height:50px;padding:10px;` +
    `border:5px solid #0000fe;${extra}">` +
    '<div style="height:200px;background:#fe0000"></div></div>';
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      box('a', 'overflow:clip;overflow-clip-margin:20px') +
      box('b', 'overflow:clip;overflow-clip-margin:content-box -2px') +
      box('c', 'overflow:hidden;contain:paint;overflow-clip-margin:20px') +
      box('d', 'overflow-x:clip;overflow-clip-margin:border-box'),
  );
  const el = view(node);
  const ops: PaintOp[] = [];
  await fillsOf(el, ops);
  const top = (id: string) => Math.round(boxOf(el, id).y);
  assert.deepStrictEqual(
    clipsAround(ops, '#fe0000').map(
      ([c]) => c.op === 'clip' && [c.x, c.y, c.w, c.h],
    ),
    [
      [-15, top('a') - 15, 160, 110],
      [17, top('b') + 17, 96, 46],
      [5, top('c') + 5, 120, 70],
      [0, -30000, 130, 60000],
    ],
  );
});

test('an overflow clip edge rounds out as a spread shadow does', async () => {
  // The corners grow with the margin, by less where the radius is small
  // beside it — but an ellipse stays an ellipse (CSS Backgrounds 3, 4.2) —
  // from the padding box's, as browsers draw them
  const clip = async (radius: string, border = '') => {
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="width:100px;height:100px;overflow:clip;' +
        `overflow-clip-margin:20px;border-radius:${radius};${border}">` +
        '<div style="height:200px;background:#fe0000"></div></div>',
    );
    const ops: PaintOp[] = [];
    await fillsOf(view(node), ops);
    const [[c]] = clipsAround(ops, '#fe0000');
    const radii = c.op === 'clip' ? c.radii : null;
    return radii?.map((r) => Math.round(r * 100) / 100);
  };
  assert.deepStrictEqual(await clip('50%'), [70, 70, 70, 70]);
  // 5 + 20 × (1 − (1 − 5/20)³ × (1 − 0.1³))
  assert.deepStrictEqual(await clip('5px'), [16.57, 16.57, 16.57, 16.57]);
  // the padding box's 10px, 20px and 30px, moved out by 20px
  assert.deepStrictEqual(
    await clip('0 15px 25px 35px', 'border:5px solid'),
    [0, 27.52, 40, 50],
  );
});

test('background-clip and background-origin name the boxes a layer takes', async () => {
  // only `text` was read: a background was painted over the border box
  // and placed at the padding box's corner whatever they said (CSS
  // Backgrounds 3, 3.7 and 3.8)
  const frame =
    'width:100px;height:50px;padding:10px;border:5px solid transparent;';
  const fills = await fillsIn(
    `<div style="${frame}background:#fe0000 content-box"></div>` +
      `<div style="${frame}background:#fe0000;background-clip:padding-box;` +
      'border-radius:20px"></div>' +
      // two boxes: the origin, and then the clip
      `<div style="${frame}background:#fe0000 padding-box content-box"></div>`,
    '#fe0000',
  );
  assert.deepStrictEqual(
    fills.map((f) => [f.x, f.y, f.w, f.h, f.radii]),
    [
      [15, 15, 100, 50, null],
      [5, 85, 120, 70, [15, 15, 15, 15]],
      [15, 175, 100, 50, null],
    ],
  );
  const { node } = await render(
    '<style>body{margin:0}div{background:linear-gradient(#0000fe,#0000fe) ' +
      `no-repeat;background-size:10px 10px;${frame}}</style>` +
      '<div style="background-origin:content-box"></div>' +
      '<div style="background-origin:border-box"></div>' +
      '<div></div>',
  );
  assert.deepStrictEqual(
    gradientFills(await fillsOf(view(node))).map((t) => [t.x, t.y]),
    [
      [15, 15],
      [0, 80],
      [5, 165],
    ],
  );
});

test("a table's height goes to its rows as a browser gives it", async () => {
  // It went to every row in proportion to its height, so the rows whose
  // cells set one grew, and an empty row between them stayed empty. CSS
  // 2.1 leaves it open (17.5.3); browsers give it to the rows a percentage
  // sets, up to it, then to the rows nothing sets, and to the empty ones
  // where every other row is set
  const { node } = await render(
    '<style>body{margin:0}table{border-spacing:0;height:300px}td{padding:0}' +
      '</style>' +
      '<table><tr id="a"><td style="height:50px"></td></tr>' +
      '<tr id="b"><td></td></tr>' +
      '<tr id="c"><td style="height:50px"></td></tr></table>' +
      '<table><tr id="d"><td>x</td></tr>' +
      '<tr id="e"><td style="height:50px">y</td></tr></table>' +
      '<table><tr id="f" style="height:50%"><td></td></tr>' +
      '<tr id="g"><td>x</td></tr></table>',
  );
  const el = view(node);
  const height = (id: string) => boxOf(el, id).height;
  assert.deepStrictEqual(
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(height),
    [50, 200, 50, 250, 50, 150, 150],
  );
});

test("border-image's shorthand and longhands are read", async () => {
  // none of them was (CSS Backgrounds 3, 6)
  const { node } = await render(
    '<div id="a" style="border-image:url(a.png) 27 fill / 10px 2 / 5 round space">' +
      '</div>' +
      '<div id="b" style="border-image:linear-gradient(red,blue) fill 10% 20 / / 3px">' +
      '</div>' +
      '<div id="c" style="border-image-source:url(c.png);border-image-slice:1 2;' +
      'border-image-width:auto 50%;border-image-repeat:repeat;' +
      'border-image-slice:-1"></div>' +
      '<div id="d" style="border-image:url(a.png) 27 / -1px"></div>',
  );
  const el = view(node);
  const image = (id: string) =>
    (boxOf(el, id) as unknown as { style: { borderImage: BorderImage } }).style
      .borderImage;
  assert.deepStrictEqual(image('a'), {
    source: 'a.png',
    slice: [27, 27, 27, 27],
    fill: true,
    width: [10, { times: 2 }, 10, { times: 2 }],
    outset: [{ times: 5 }, { times: 5 }, { times: 5 }, { times: 5 }],
    repeat: ['round', 'space'],
  });
  const b = image('b');
  assert.ok(b.source && typeof b.source === 'object', 'a gradient');
  assert.deepStrictEqual(
    [b.slice, b.fill, b.width, b.outset],
    [
      [{ pct: 10 }, 20, { pct: 10 }, 20],
      true,
      NO_BORDER_IMAGE.width,
      [3, 3, 3, 3],
    ],
  );
  const c = image('c');
  // a negative slice is none, and the one before it stands
  assert.deepStrictEqual(
    [c.source, c.slice, c.width, c.repeat],
    [
      'c.png',
      [1, 2, 1, 2],
      ['auto', { pct: 50 }, 'auto', { pct: 50 }],
      ['repeat', 'repeat'],
    ],
  );
  assert.strictEqual(image('d'), NO_BORDER_IMAGE, 'a negative width is none');
});

test('a border image is cut into nine and drawn over the border', async () => {
  // It was not read: the border was drawn as its style said. The corners
  // are scaled into theirs, the edges along their sides, the middle drawn
  // for `fill`, and the border's own style not at all (CSS Backgrounds 3,
  // 6.2)
  const draw = async (style: string) => {
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        `<div style="border:10px solid #fe0000;${style}"></div>`,
    );
    const ops: PaintOp[] = [];
    const fills = await fillsOf(view(node), ops, {
      backgroundImageFor: () => ({
        image: {},
        width: 15,
        height: 15,
        ratio: 1,
      }),
    });
    assert.ok(!fills.some((f) => f.style === parseColor('#fe0000')));
    return ops.flatMap((op) =>
      op.op === 'image' ? [[...(op.src ?? []), op.x, op.y, op.w, op.h]] : [],
    );
  };
  assert.deepStrictEqual(
    await draw('width:40px;height:20px;border-image:url(a.png) 5 fill'),
    [
      [0, 0, 5, 5, 0, 0, 10, 10],
      [10, 0, 5, 5, 50, 0, 10, 10],
      [0, 10, 5, 5, 0, 30, 10, 10],
      [10, 10, 5, 5, 50, 30, 10, 10],
      [5, 0, 5, 5, 10, 0, 40, 10],
      [5, 10, 5, 5, 10, 30, 40, 10],
      [0, 5, 5, 5, 0, 10, 10, 20],
      [10, 5, 5, 5, 50, 10, 10, 20],
      [5, 5, 5, 5, 10, 10, 40, 20],
    ],
  );
  // slices that overlap leave each corner all of its own, and no edges
  assert.deepStrictEqual(
    await draw('width:40px;height:20px;border-image:url(a.png) 10'),
    [
      [0, 0, 10, 10, 0, 0, 10, 10],
      [5, 0, 10, 10, 50, 0, 10, 10],
      [0, 5, 10, 10, 0, 30, 10, 10],
      [5, 5, 10, 10, 50, 30, 10, 10],
    ],
  );
  // `round` fits whole tiles along the top, and `space` sets them apart
  // down the sides, the tile the slice scaled to the side's width
  const tiles = await draw(
    'width:45px;height:26px;border-image:url(a.png) 5 / 10px round space',
  );
  assert.deepStrictEqual(
    tiles
      .filter((t) => t[5] === 0 && t[4] > 0 && t[4] < 55)
      .map((t) => [t[4], t[6]]),
    [
      [10, 9],
      [19, 9],
      [28, 9],
      [37, 9],
      [46, 9],
    ],
  );
  assert.deepStrictEqual(
    tiles
      .filter((t) => t[4] === 0 && t[5] > 0 && t[5] < 36)
      .map((t) => [t[5], t[7]]),
    [
      [12, 10],
      [24, 10],
    ],
  );
});

test("background-repeat's space and round fit whole tiles", async () => {
  // Both were read as `repeat` (CSS Backgrounds 3, 3.4): `space` sets as
  // many whole tiles as fit, the first and last against the edges and the
  // rest spread between, or one where two do not fit; `round` sizes the
  // tile so that a whole number of them fit
  const { node } = await render(
    '<style>body{margin:0}div{width:96px;height:30px;' +
      'background:linear-gradient(#0000fe,#0000fe);background-size:30px 30px}' +
      '</style>' +
      '<div style="background-repeat:space no-repeat"></div>' +
      '<div style="background-repeat:round no-repeat"></div>' +
      '<div style="background-repeat:space no-repeat;background-size:60px 30px;' +
      'background-position:right"></div>',
  );
  assert.deepStrictEqual(
    gradientFills(await fillsOf(view(node))).map((t) => [t.x, t.y, t.w]),
    [
      [0, 0, 30],
      [33, 0, 30],
      [66, 0, 30],
      [0, 30, 32],
      [32, 30, 32],
      [64, 30, 32],
      [36, 60, 60],
    ],
  );
});

test('a border is as wide as the whole device pixels it covers', async () => {
  // Snapped as a border width (CSS Values 4): down to the pixel, and a
  // hairline up to one — two borders of 49.75px left their box half a
  // pixel, which painted nothing, where a browser leaves two
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div id="a" style="box-sizing:border-box;height:100px;' +
      'border-top:49.75px solid;border-bottom:49.75px solid"></div>' +
      '<div id="b" style="border:0.25px solid;outline:1.9px solid"></div>',
  );
  const el = view(node);
  type Bordered = {
    borderTop: number;
    borderBottom: number;
    borderLeft: number;
  };
  const a = boxOf(el, 'a') as unknown as Bordered;
  assert.deepStrictEqual([a.borderTop, a.borderBottom], [49, 49]);
  const b = boxOf(el, 'b') as unknown as Bordered & { style: ComputedStyle };
  assert.deepStrictEqual([b.borderLeft, b.style.outlineWidth], [1, 1]);
});

metric('layout containment makes a stacking context', async () => {
  // what is in it is stacked in it, however high its `z-index`: under a
  // positioned box after it
  const { result } = await renderWithBytes(
    '<style>body{margin:0}</style>' +
      '<div style="contain:layout;height:20px"><div style="position:absolute;' +
      'z-index:10;width:20px;height:20px;background:#ff0000"></div></div>' +
      '<div style="position:relative;z-index:1;top:-20px;width:20px;' +
      'height:20px;background:#00ff00"></div>',
    {},
  );
  await expectPixel(result.ctx, 10, 10, '#00ff00', { message: 'on top' });
});

test('style containment keeps counters and quotes in its subtree', async () => {
  // a counter made outside is not counted on inside: a new one is made,
  // for the element that counts and its later siblings; and the quotes
  // are as deep after it as they were before it
  const counters = await documentText(
    '<style>div{contain:style;counter-increment:c 123}' +
      'span{counter-increment:c}span::before{content:counter(c)}</style>' +
      '<div><span></span> <span></span></div>',
  );
  assert.ok(counters.includes('1 2'), JSON.stringify(counters));
  const quotes = await documentText(
    '<style>div{quotes:"A" "Z" "1" "9"}div::before,span::before' +
      '{content:open-quote}div::after{content:close-quote}' +
      'span{contain:style}</style><div><span></span></div>',
  );
  assert.ok(quotes.includes('A1Z'), JSON.stringify(quotes));
});

// --- a restyle's cost --------------------------------------------------------------

test('a style takes from its parent the fields INHERITED names, and no others', () => {
  // `inherit` writes them out one by one, where a loop over the list was
  // three quarters of each element's style: the list and the function
  // have to stay the same set
  const look = {
    color: '#010101',
    fontFamily: 'sans-serif',
    fontSize: 14,
    monoFamily: 'monospace',
    linkColor: '#020202',
    borderColor: '#030303',
    mutedColor: '#040404',
    background: '#050505',
    colorScheme: 'light' as const,
    surface: '#060606',
    controlPadY: 4,
    controlBorder: 1,
    controlRadius: 4,
  };
  const initial = initialStyle(look, 1);
  // a parent every field of which differs from the initial style's
  const parent = { ...initial } as Record<string, unknown>;
  for (const key of Object.keys(parent)) parent[key] = { marker: key };
  const out = inherit(
    parent as unknown as ComputedStyle,
    initial,
  ) as unknown as Record<string, unknown>;
  const taken = Object.keys(out)
    .filter((key) => out[key] === parent[key])
    .sort();
  const expected = [
    ...INHERITED,
    'underline',
    'underlineStyle',
    'underlineThickness',
    'underlineOffset',
    'lineThrough',
  ].sort();
  assert.deepStrictEqual(taken, expected);
});

test('an append to a streamed document keeps its stylesheet parsed', async () => {
  // a framework's stylesheet was parsed and its rules indexed again on
  // every append, and every width across a breakpoint
  const doc = (source: string) =>
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source, 'data-testname': 'doc' }),
    );
  const head = '<style>p { color: #0b0b0b }</style><p>one</p>';
  const result = await renderX11(doc(head), { backend: 'mock' });
  const el = () => view(screen.getByTestName('doc') as DrawnNode);
  const cascadeOf = () => (el() as unknown as { _cascade: unknown })._cascade;
  el().textContent();
  const before = cascadeOf();
  assert.ok(before, 'a cascade');
  await act(() => result.rerender(doc(head + '<p>two</p>')));
  assert.strictEqual(el().textContent(), 'onetwo');
  assert.strictEqual(cascadeOf(), before, 'the same cascade');
  // and the paragraph that arrived is styled by it
  const tree = (
    el() as unknown as {
      _tree: {
        root: { children: { children: { style: { color: string } }[] }[] };
      };
    }
  )._tree;
  const colors: string[] = [];
  const walk = (b: {
    style?: { color: string };
    children?: unknown[];
  }): void => {
    if (b.style && (b as { el?: { name: string } }).el?.name === 'p') {
      colors.push(b.style.color);
    }
    for (const c of (b.children ?? []) as (typeof b)[]) walk(c);
  };
  walk(tree.root as never);
  // each paragraph's box and its text's, the new one's among them
  assert.deepStrictEqual(colors, ['#0b0b0b', '#0b0b0b', '#0b0b0b', '#0b0b0b']);
  // a change to the sheet is a new cascade
  await act(() =>
    result.rerender(
      doc('<style>p { color: #0c0c0c }</style><p>one</p><p>two</p>'),
    ),
  );
  el().textContent();
  assert.notStrictEqual(cascadeOf(), before);
});

test('a pseudo-element no rule gives a content to is none, whatever reaches it', async () => {
  // Tailwind's `*, ::before, ::after` reaches both of every element's
  const count = async (css: string) => {
    const { node } = await render(
      `<style>${css}</style><p>a</p><p class="x">b</p>`,
    );
    let n = 0;
    const walk = (b: { children?: unknown[] }): void => {
      n += 1;
      for (const c of (b.children ?? []) as (typeof b)[]) walk(c);
    };
    walk((view(node) as unknown as { _tree: { root: object } })._tree.root);
    return n;
  };
  const bare = await count('');
  assert.strictEqual(
    await count('*, ::before, ::after { box-sizing: border-box; --x: 1 }'),
    bare,
  );
  assert.strictEqual(
    await count('.x::before { content: var(--label, "*") }'),
    bare + 2,
    'a ::before box and its text',
  );
});

metric(
  "the text of an inline box with an edge is shaped apart from its neighbours'",
  async () => {
    // CSS Text 3, 7.3: shaping is broken across an inline box's margin,
    // border or padding, where the engine shapes a word that runs across
    // spans shaped alike as one — kerned, and joined in Arabic
    const { node } = await render(
      '<p id="a">Wa<span style="padding-left:4px">ve</span> Wa<b>ve</b> ' +
        'Wa<i style="margin-right:2px">ve</i></p>',
    );
    const el = view(node);
    const apart: string[] = [];
    for (const line of linesOf(el, 'a')) {
      for (const text of line.texts) {
        const layout = text.layout as unknown as {
          lines: {
            runs: { span?: { text: string; shapeApart?: boolean } }[];
          }[];
        };
        for (const run of layout.lines[text.layoutLine].runs) {
          if (run.span?.shapeApart) apart.push(run.span.text);
        }
      }
    }
    assert.deepStrictEqual(apart, ['ve', 've']);
  },
);

// --- line-clamp and text-overflow ------------------------------------------------

test('line-clamp and text-overflow are read', async () => {
  const box = 'display:-webkit-box;-webkit-box-orient:vertical;';
  const { node } = await render(
    `<p id="a" style="${box}-webkit-line-clamp:2">a</p>` +
      '<p id="b" style="line-clamp:3;line-clamp:none">b</p>' +
      `<p id="c" style="${box}-webkit-line-clamp:2;-webkit-line-clamp:0">c</p>` +
      '<p id="d" style="text-overflow:ellipsis">d</p>' +
      '<p id="e" style="text-overflow:clip ellipsis">e</p>' +
      '<p id="f" style="text-overflow:ellipsis;text-overflow:fade">f</p>' +
      // `-webkit-line-clamp` clamps a vertical `-webkit-box` only, as it
      // does in a browser, and `line-clamp` a block container
      '<p id="g" style="-webkit-line-clamp:2">g</p>' +
      '<p id="h" style="display:-webkit-box;-webkit-line-clamp:2">h</p>' +
      '<p id="i" style="line-clamp:3">i</p>' +
      '<p id="j" style="line-clamp:auto">j</p>' +
      '<p id="k" style="display:flex;line-clamp:3">k</p>' +
      '<p id="l" style="line-clamp:3;columns:2">l</p>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: {
          lineClamp: number | null;
          textOverflow: string;
          display: string;
          flowRoot: boolean;
          flexDirection: string;
        };
      }
    ).style;
  assert.strictEqual(style('a').lineClamp, 2);
  // a block of a formatting context of its own
  assert.strictEqual(style('a').display, 'block');
  assert.strictEqual(style('a').flowRoot, true);
  assert.strictEqual(style('b').lineClamp, null);
  // nought is no clamp, and the one before stands
  assert.strictEqual(style('c').lineClamp, 2);
  assert.strictEqual(style('g').lineClamp, null);
  // a `-webkit-box` that does not clamp vertically is a flex row
  assert.strictEqual(style('h').lineClamp, null);
  assert.strictEqual(style('h').display, 'flex');
  assert.strictEqual(style('h').flexDirection, 'row');
  assert.strictEqual(style('i').lineClamp, 3);
  assert.strictEqual(style('j').lineClamp, Infinity);
  assert.strictEqual(style('k').lineClamp, null);
  assert.strictEqual(style('l').lineClamp, null, 'not a multicol container');
  assert.strictEqual(style('d').textOverflow, 'ellipsis');
  // two values name the start and the end, and a line's end is cut
  assert.strictEqual(style('e').textOverflow, 'ellipsis');
  assert.strictEqual(style('f').textOverflow, 'ellipsis');
});

metric(
  'a clamped block shows its first lines, the last cut with an ellipsis',
  async () => {
    // Tailwind's line-clamp-2: a card's description, however long, two
    // lines tall
    const text =
      'Boost your conversion rate with a layout that keeps every card the ' +
      'same height, however long its description runs on and on and on.';
    const { node } = await render(
      '<style>body{margin:0} p{margin:0;width:160px;line-height:20px}</style>' +
        `<p id="a" style="overflow:hidden;display:-webkit-box;` +
        `-webkit-box-orient:vertical;-webkit-line-clamp:2">${text}</p>` +
        `<p id="b">${text}</p>` +
        // one that is shorter than its clamp is all there
        `<p id="c" style="-webkit-line-clamp:2">Short.</p>`,
    );
    const el = view(node);
    const clamped = linesOf(el, 'a');
    assert.strictEqual(clamped.length, 2);
    assert.strictEqual(boxOf(el, 'a').height, 40);
    assert.ok(linesOf(el, 'b').length > 2, 'the text is longer than two');
    assert.strictEqual(lastRunText(clamped[1]), '\u2026', 'with its ellipsis');
    assert.strictEqual(linesOf(el, 'c').length, 1);
  },
);

/** The text of a line's last run, where the engine hands its span back. */
function lastRunText(line: PlacedLine): string | undefined {
  const text = line.texts[line.texts.length - 1];
  const layout = text.layout as unknown as {
    lines: { runs: { span?: { text: string } }[] }[];
  };
  const runs = layout.lines[text.layoutLine].runs;
  return runs[runs.length - 1]?.span?.text;
}

metric(
  'a clamp counts the lines of its blocks, and hides what is past them',
  async () => {
    // CSS Overflow 4, 5.3.1: Tailwind's `line-clamp-3` on a card whose
    // text is in paragraphs counts through them, and the paragraph after
    // the third line is not drawn, nor any of its height
    const { node } = await render(
      '<style>body{margin:0} p{margin:0} div{width:160px;' +
        'line-height:20px}</style>' +
        '<div id="card" style="overflow:hidden;display:-webkit-box;' +
        '-webkit-box-orient:vertical;-webkit-line-clamp:3">' +
        '<p id="a">One line.</p>' +
        '<p id="b">Boost your conversion rate with a layout that keeps ' +
        'every card the same height.</p>' +
        '<p id="c" style="background:#ff0000">Hidden.</p></div>' +
        '<div id="after">After.</div>',
    );
    const el = view(node);
    assert.strictEqual(linesOf(el, 'a').length, 1);
    const b = linesOf(el, 'b');
    assert.strictEqual(b.length, 2, 'two of its lines left');
    assert.strictEqual(lastRunText(b[1]), '\u2026');
    assert.strictEqual(boxOf(el, 'card').height, 60, 'three lines tall');
    assert.strictEqual(boxOf(el, 'after').y, 60, 'and nothing below them');
    const fills = await fillsOf(el);
    assert.ok(
      !fills.some((f) => f.style === parseColor('#ff0000')),
      'the paragraph past the clamp point is invisible',
    );
  },
);

metric(
  'a clamp ends its last line in an ellipsis at a word, and only where more follows',
  async () => {
    // The ellipsis takes room on the line, and the words that do not fit
    // beside it go to the lines the clamp hides (CSS Overflow 4, 4.2): the
    // engine's own ellipsis, the one `text-overflow` asks for, cut inside
    // the last word. A clamp that shows every line shows no ellipsis, and
    // one that falls just after a block's lines, a block after it, does.
    const { node } = await render(
      '<style>body{margin:0} p{margin:0;width:160px;line-height:20px}' +
        '</style>' +
        '<p id="a" style="line-clamp:2">Boost your conversion rate with ' +
        'a layout that keeps uncharacteristically long words.</p>' +
        '<div style="line-clamp:2"><p id="b">Exactly one line.</p>' +
        '<p id="c">And one more.</p><p>Hidden.</p></div>' +
        '<div style="line-clamp:2"><p id="d">One line.</p>' +
        '<p id="e">And the last.</p></div>',
    );
    const el = view(node);
    const [, last] = linesOf(el, 'a');
    assert.strictEqual(lastRunText(last), '\u2026');
    assert.ok(last.width <= 160, `within the box: ${last.width}`);
    const text = last.texts
      .map((t) => {
        const layout = t.layout as unknown as {
          lines: { runs: { span?: { text: string } }[] }[];
        };
        return layout.lines[t.layoutLine].runs
          .map((r) => r.span?.text ?? '')
          .join('');
      })
      .join('');
    assert.ok(/\s\S+\u2026$/.test(text), `whole words before it: ${text}`);
    assert.ok(!/uncharacteri\u2026/.test(text), text);
    assert.notStrictEqual(lastRunText(linesOf(el, 'b')[0]), '\u2026');
    assert.strictEqual(lastRunText(linesOf(el, 'c')[0]), '\u2026');
    assert.notStrictEqual(lastRunText(linesOf(el, 'e')[0]), '\u2026');
  },
);

metric('line-clamp: auto shows the lines its height holds', async () => {
  // as many lines as a `max-height` in `lh` holds, the last cut with an
  // ellipsis (CSS Overflow 4, 5.3.1)
  const { node } = await render(
    '<style>body{margin:0} div{width:160px;line-height:20px}</style>' +
      '<div id="a" style="line-clamp:auto;max-height:3lh">' +
      '<p style="margin:0">One.</p><p style="margin:0">Two.</p>' +
      '<p style="margin:0">Three.</p><p id="d" style="margin:0">Four.</p>' +
      '</div>' +
      '<div id="b" style="height:2lh">Two lines tall.</div>',
  );
  const el = view(node);
  assert.strictEqual(boxOf(el, 'a').height, 60);
  assert.strictEqual(boxOf(el, 'b').height, 40, '`lh` is the line height');
  const ends = linesOf(el, 'a').map((line) => lastRunText(line));
  assert.strictEqual(ends.length, 3);
  assert.strictEqual(ends[2], '\u2026');
});

metric(
  "truncate: a line that clips ends in an ellipsis at the box's width",
  async () => {
    const { node } = await render(
      '<style>body{margin:0} div{width:120px;overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap}</style>' +
        '<div id="a">leslie.alexander@example.com and more</div>' +
        '<div id="b">Short</div>' +
        // and a line that does not clip is not cut, however long
        '<div id="c" style="overflow:visible">leslie.alexander@example.com</div>',
    );
    const el = view(node);
    const [cut] = linesOf(el, 'a');
    assert.strictEqual(linesOf(el, 'a').length, 1);
    assert.ok(cut.width <= 120, `within the box: ${cut.width}`);
    const truncated = (id: string) =>
      (linesOf(el, id)[0].texts[0].layout as unknown as { truncated: boolean })
        .truncated;
    assert.strictEqual(truncated('a'), true);
    assert.strictEqual(truncated('b'), false);
    assert.ok(linesOf(el, 'c')[0].width > 120, 'run past the box');
  },
);

metric('a truncated block cuts each of its lines, and loses none', async () => {
  // the cut was the paragraph's, one line with an ellipsis: a `truncate`
  // block with a `<br>` in it, or a `<pre>` that clips with
  // `text-overflow: ellipsis`, showed its first line and nothing else,
  // where `text-overflow` cuts every line that overflows
  const { node } = await render(
    '<style>body{margin:0} .t{width:120px;overflow:hidden;' +
      'text-overflow:ellipsis;white-space:nowrap}</style>' +
      '<div id="a" class="t">leslie.alexander@example.com<br>Short<br>' +
      'michael.foster@example.com</div>' +
      '<pre id="b" style="width:120px;padding:0;overflow:hidden;' +
      'text-overflow:ellipsis">const answer = computeTheAnswer();\n' +
      'return answer;</pre>',
  );
  const el = view(node);
  const truncated = (line: PlacedLine) =>
    (line.texts[0].layout as unknown as { truncated: boolean }).truncated;
  const lines = linesOf(el, 'a');
  assert.strictEqual(lines.length, 3, 'every line');
  assert.deepStrictEqual(lines.map(truncated), [true, false, true]);
  for (const line of lines) {
    assert.ok(line.width <= 120, `within the box: ${line.width}`);
  }
  assert.ok(lines[1].y > lines[0].y && lines[2].y > lines[1].y, 'in order');
  const pre = linesOf(el, 'b');
  assert.strictEqual(pre.length, 2);
  assert.deepStrictEqual(pre.map(truncated), [true, false]);
});

metric(
  'a clamped block laid out a line at a time is cut to its lines',
  async () => {
    // an image on a line lays the block out a line at a time, which the
    // engine's clamp does not see: the lines past it are dropped, with no
    // ellipsis, and the block ends where its last line does
    const { node } = await render(
      '<style>body{margin:0} p{margin:0;width:160px;line-height:20px}</style>' +
        '<p id="a" style="line-clamp:2"><img style="width:10px;' +
        'height:10px"> Boost your conversion rate with a layout that keeps ' +
        'every card the same height, however long its description runs.</p>',
    );
    const el = view(node);
    assert.strictEqual(linesOf(el, 'a').length, 2);
    assert.strictEqual(boxOf(el, 'a').height, 40);
  },
);

metric(
  "a document's faces are asked for before its layout sets text in them",
  async () => {
    // a `th` at 600 is none of the four faces a family is warmed in, and its
    // match was a synchronous fc-match inside the layout: 38 ms of the
    // benchmark report's first paint. The boxes say which faces the text is
    // set in before anything is laid out, and those are asked for then.
    const probe = await render('<p>x</p>');
    const proto = Object.getPrototypeOf(
      (probe.result.app as unknown as { fonts: object }).fonts,
    ) as {
      prewarm(
        family: string,
        faces?: { weight: number; style: string }[],
      ): void;
      match(
        family: string,
        opts?: { weight?: unknown; style?: string },
      ): unknown;
    };
    const { prewarm, match } = proto;
    const asked: string[] = [];
    proto.prewarm = function (family, faces) {
      for (const f of faces ?? []) asked.push(`warm ${f.weight} ${f.style}`);
      return prewarm.call(this, family, faces);
    };
    proto.match = function (family, opts) {
      asked.push(
        `match ${String(opts?.weight ?? 400)} ${opts?.style ?? 'normal'}`,
      );
      return match.call(this, family, opts);
    };
    try {
      await render(
        '<style>th { font-weight: 600 } em { font-style: italic }</style>' +
          '<table><tr><th>Heading</th></tr><tr><td>a <em>cell</em></td></tr></table>',
      );
    } finally {
      proto.prewarm = prewarm;
      proto.match = match;
    }
    const warmed = asked.indexOf('warm 600 normal');
    assert.ok(warmed >= 0, `the heading's face is warmed: ${asked.join(', ')}`);
    const matched = asked.indexOf('match 600 normal');
    assert.ok(
      matched === -1 || warmed < matched,
      'before the layout asks for it',
    );
    assert.ok(asked.includes('warm 400 italic'), 'and the emphasis');
    // a face is asked once, however many boxes are set in it
    assert.strictEqual(asked.filter((a) => a === 'warm 600 normal').length, 1);
  },
);

// --- a pointer move restyled where it happened (`_hoverInPlace`) ------------

/** The element's pixels, as the server has them. */
async function snapshot(
  result: Awaited<ReturnType<typeof render>>['result'],
  el: HtmlViewNode,
): Promise<Uint8ClampedArray> {
  const { abs } = el as unknown as DrawnNode;
  await act();
  return new Promise((ok, fail) =>
    (
      result.ctx as unknown as {
        getImageData(
          x: number,
          y: number,
          w: number,
          h: number,
          cb: (e: unknown, d: { data: Uint8ClampedArray }) => void,
        ): void;
      }
    ).getImageData(abs.x, abs.y, abs.width, abs.height, (e, d) =>
      e ? fail(e) : ok(d.data),
    ),
  );
}

/** A logical window point inside an element of the document. */
function pointIn(el: HtmlViewNode, id: string): [number, number] {
  const target = findById(el.document, id)!;
  const rect = el.elementRect(target)!;
  const { abs } = el as unknown as DrawnNode;
  return [abs.x + rect.x + rect.width / 2, abs.y + rect.y + rect.height / 2];
}

type DocElement = Parameters<HtmlViewNode['elementRect']>[0];

function findById(node: unknown, id: string): DocElement | null {
  const n = node as { attribs?: Record<string, string>; children?: unknown[] };
  if (n.attribs?.id === id) return n as unknown as DocElement;
  for (const child of n.children ?? []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

/** The box tree, to tell a restyle in place from a document built again. */
const treeOf = (el: HtmlViewNode) =>
  (el as unknown as { _tree: unknown })._tree;

/** What a document built again from its sheets makes of the same hover. */
async function rebuilt(
  result: Awaited<ReturnType<typeof render>>['result'],
  el: HtmlViewNode,
): Promise<Uint8ClampedArray> {
  (el as unknown as { _invalidate(stale: number): void })._invalidate(2);
  return snapshot(result, el);
}

const HOVER_PAGE =
  '<style>body{margin:0} a{color:#0000ee;text-decoration:none}' +
  ' a:hover{color:#ff0000;text-decoration:underline}' +
  ' .b{display:inline-block;padding:2px;border:2px solid #888888}' +
  ' .b:hover{background:#ffff00;border-color:#00aa00}' +
  ' li:hover{color:#008800}</style>' +
  '<p id="p">Some text with <a id="a" href="#x">a <span id="s">link</span>' +
  ' in it</a> and more text after it, long enough to wrap onto a second' +
  ' line in a paragraph this narrow.</p>' +
  '<p id="q">Another paragraph, with no link.</p>' +
  '<p><span class="b" id="b">button</span></p>' +
  '<ul><li id="li">an item</li></ul>';

metric(
  'a hovered link is restyled where it is, to the pixels a rebuild draws',
  async () => {
    const { result, node } = await render(HOVER_PAGE, 300);
    const el = view(node);
    const quiet = await snapshot(result, el);
    const tree = treeOf(el);

    el.setHover(...pointIn(el, 's'));
    const hovered = await snapshot(result, el);
    assert.strictEqual(treeOf(el), tree, 'the document was built again');
    assert.notDeepStrictEqual(hovered, quiet, 'the hover drew nothing');
    assert.deepStrictEqual(hovered, await rebuilt(result, el));

    // …and back off it, in place again
    const again = treeOf(el);
    el.setHover(...pointIn(el, 'q'));
    const left = await snapshot(result, el);
    assert.strictEqual(treeOf(el), again);
    assert.deepStrictEqual(left, quiet);
    assert.deepStrictEqual(left, await rebuilt(result, el));
  },
);

metric(
  'a hovered box takes its background and border colour in place',
  async () => {
    const { result, node } = await render(HOVER_PAGE, 300);
    const el = view(node);
    const tree = treeOf(el);
    el.setHover(...pointIn(el, 'b'));
    const hovered = await snapshot(result, el);
    assert.strictEqual(treeOf(el), tree);
    assert.deepStrictEqual(hovered, await rebuilt(result, el));
  },
);

metric(
  'a move that touches no rule restyles nothing, and one that changes more than ink builds the document again',
  async () => {
    const { result, node } = await render(
      HOVER_PAGE.replace('</style>', ' #q:hover{font-weight:bold}</style>'),
      300,
    );
    const el = view(node);
    const tree = treeOf(el);
    // from nothing to the plain paragraph: no compound testing the pointer
    // matches a `<p>` but `#q`'s
    el.setHover(...pointIn(el, 'p'));
    await snapshot(result, el);
    assert.strictEqual(treeOf(el), tree, 'a move over nothing hovered');
    // bold text is another shape
    el.setHover(...pointIn(el, 'q'));
    const bold = await snapshot(result, el);
    assert.notStrictEqual(treeOf(el), tree, 'bold was restyled in place');
    assert.deepStrictEqual(bold, await rebuilt(result, el));
  },
);

metric(
  'a list item, whose marker takes its colour, is built again',
  async () => {
    const { result, node } = await render(HOVER_PAGE, 300);
    const el = view(node);
    const tree = treeOf(el);
    el.setHover(...pointIn(el, 'li'));
    const hovered = await snapshot(result, el);
    assert.notStrictEqual(treeOf(el), tree);
    assert.deepStrictEqual(hovered, await rebuilt(result, el));
  },
);

metric('a hover in a long document builds and lays out nothing', async () => {
  // what took a Wikipedia article 270 ms a link on X11: every hover built
  // the boxes of the whole document again and laid it out
  const paragraphs = Array.from(
    { length: 400 },
    (_, i) =>
      `<p id="p${i}">Paragraph ${i} with <a id="a${i}" href="#${i}">a link</a> in the middle of enough text to wrap.</p>`,
  ).join('');
  const { result, node } = await render(
    `<style>body{margin:0} a{color:#0000ee} a:hover{color:#ff0000;text-decoration:underline}</style>${paragraphs}`,
    300,
  );
  const el = view(node);
  const updates = { n: 0 };
  const proto = el as unknown as { _update(width: number): void };
  const update = proto._update.bind(el);
  proto._update = (width: number) => {
    updates.n += 1;
    const tree = treeOf(el);
    update(width);
    if (treeOf(el) !== tree) updates.n += 1000;
  };
  await snapshot(result, el);
  const tree = treeOf(el);
  for (const id of ['a0', 'p1', 'a2', 'a3', 'p3']) {
    el.setHover(...pointIn(el, id));
    await snapshot(result, el);
  }
  assert.strictEqual(treeOf(el), tree);
  assert.ok(updates.n < 1000, 'a hover built the document again');
});

metric(
  "the cursor under the pointer is the document's: a link's pointer, text's I-beam",
  async () => {
    // what core asks a drawn element for as the pointer moves (`cursorAt`,
    // react-x11#757), in device pixels — at a scale of 1, the window's
    const { node } = await render(
      '<style>body{margin:0} .m{cursor:move} .u{cursor:url(x.cur)}</style>' +
        '<p><span id="t">plain text here</span></p>' +
        '<p><a id="a" href="#x">a <b id="ab">link</b></a></p>' +
        '<p><span class="m" id="m">moving</span></p>' +
        '<p><span class="u" id="u">unloaded</span></p>' +
        '<div id="e" style="height:40px"></div>',
      300,
    );
    const el = view(node);
    const at = (id: string) => el.cursorAt(...pointIn(el, id));
    assert.strictEqual(at('a'), 'pointer');
    assert.strictEqual(at('ab'), 'pointer', "and the link's own elements");
    assert.strictEqual(at('t'), 'text');
    assert.strictEqual(at('m'), 'move');
    assert.strictEqual(at('u'), 'text', 'a cursor it cannot load');
    assert.strictEqual(at('e'), 'default', 'and over nothing, the arrow');
  },
);

metric(
  'over a link the window shows the pointer, and over text the I-beam',
  async () => {
    // end to end: core asks the element as the pointer moves over it, and
    // puts what it names on the window
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<p><span id="t">plain text here</span></p>' +
        '<p><a id="a" href="#x">a link</a></p>' +
        '<div id="e" style="height:40px"></div>',
      300,
    );
    const el = view(node);
    await act();
    const drawn = el as unknown as DrawnNode;
    const wnd = (
      drawn as unknown as {
        root: { window: { setCursor(name: string | null): void } };
      }
    ).root.window;
    const shown: (string | null)[] = [];
    const set = wnd.setCursor.bind(wnd);
    wnd.setCursor = (name) => {
      shown.push(name);
      set(name);
    };
    // each step changes the cursor, which is when core sets one
    const over = async (id: string) => {
      const before = shown.length;
      const [x, y] = pointIn(el, id);
      const { abs } = drawn;
      fireEvent.mouseMove(drawn, {
        dx: x - (abs.x + abs.width / 2),
        dy: y - (abs.y + abs.height / 2),
      });
      await act();
      // with a message: without one, a failed `assert.ok` on Node 20 parses
      // this file again to quote the expression — seconds a try at this
      // size, so the first try (the motion lands an `act()` later) ran the
      // wait past its deadline
      await waitFor(() => assert.ok(shown.length > before, 'a new cursor'));
      return shown.at(-1);
    };
    assert.strictEqual(await over('a'), 'pointer');
    assert.strictEqual(await over('t'), 'text');
    // not the I-beam a selectable surface defaults to, which is where a
    // null from the element falls through to
    assert.strictEqual(await over('e'), 'default');
    assert.strictEqual(await over('a'), 'pointer');
  },
);

metric(
  'a link past the box its page overflows is found, and one a box clips away is not',
  async () => {
    // `html, body { height: 100% }` makes both one viewport tall and the
    // page overflow them: a hit test that went into a box only where its
    // own rectangle was found nothing below the first screen — a scrolled
    // Wikipedia article lit no link at all
    const { node } = await render(
      '<html><head><style>html, body { height: 100%; margin: 0 }' +
        ' .clip { height: 20px; overflow: hidden }</style></head><body>' +
        '<div style="height:700px">tall</div>' +
        '<p><a id="below" href="#b">below the first screen</a></p>' +
        '<div class="clip"><div style="height:20px">top</div>' +
        '<a id="hidden" href="#h">clipped away</a></div></body></html>',
      300,
    );
    const el = view(node);
    await act();
    assert.strictEqual(el.hrefAtPoint(...pointIn(el, 'below')), '#b');
    assert.strictEqual(el.hrefAtPoint(...pointIn(el, 'hidden')), null);
  },
);

metric(
  'a float hanging over the next block is what is under the pointer there',
  async () => {
    // a float is painted after the in-flow blocks around it (CSS 2.1
    // Appendix E): an infobox floated out of a short section, over the
    // next one, keeps its links — and a `position: relative` article
    // around both puts them in one context rather than one layer
    const { node } = await render(
      '<div style="position:relative">' +
        '<div><div style="float:right;width:120px;height:200px">' +
        '<p style="margin:150px 0 0"><a id="f" href="#f">in the float</a></p>' +
        '</div>short</div>' +
        '<div id="next" style="height:300px">the next section</div></div>',
      300,
    );
    const el = view(node);
    await act();
    const link = el.elementRect(findById(el.document, 'f')!)!;
    const next = el.elementRect(findById(el.document, 'next')!)!;
    assert.ok(link.y > next.y, 'the link hangs over the next section');
    assert.strictEqual(el.hrefAtPoint(...pointIn(el, 'f')), '#f');
  },
);

metric(
  'a positioned link escapes the clip of a box its containing block is outside of',
  async () => {
    // the Zen Garden's archive links: absolute `<li>`s in an `overflow:
    // hidden` list with no height of its own, positioned in the box around
    // it — which the list's clip does not reach (CSS 2.1 11.1.1)
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="position:relative;height:100px">' +
        '<ul style="overflow:hidden;margin:0;padding:0">' +
        '<li style="position:absolute;top:20px;left:0;list-style:none">' +
        '<a id="out" href="#out">escapes</a></li></ul>' +
        '<div style="position:relative;height:10px;overflow:hidden">' +
        '<a id="in" href="#in" style="position:absolute;top:40px">clipped</a>' +
        '</div></div>',
      300,
    );
    const el = view(node);
    await act();
    assert.strictEqual(el.hrefAtPoint(...pointIn(el, 'out')), '#out');
    assert.strictEqual(
      el.cursorAt(...pointIn(el, 'out')),
      'pointer',
      'and shows the pointer',
    );
    // positioned in the box that clips it: gone past its edge
    assert.strictEqual(el.hrefAtPoint(...pointIn(el, 'in')), null);

    // and one positioned inside the clip stays clipped where an escaping
    // one takes the clip's reach over it
    const { node: second } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="position:relative;height:100px">' +
        '<div style="overflow:hidden;height:10px">' +
        '<div style="position:relative">' +
        '<a id="under" href="#under" style="position:absolute;top:40px">' +
        'clipped</a></div>' +
        '<a id="over" href="#over" style="position:absolute;top:30px;' +
        'left:0;width:200px;height:50px"></a>' +
        '</div></div>',
      300,
    );
    const el2 = view(second);
    await act();
    assert.strictEqual(
      el2.hrefAtPoint(...pointIn(el2, 'under')),
      '#over',
      'the escaping link over it, not it',
    );
  },
);

metric(
  'of two positioned boxes over a point, the one with the higher z-index is under the pointer',
  async () => {
    // the Zen Garden's `›`, `z-index: 3`, over the bar the "View All
    // Designs" link fills, which comes after it in the document
    const { node } = await render(
      '<style>body{margin:0}</style>' +
        '<div style="position:relative;height:60px">' +
        '<a id="top" href="#top" style="position:absolute;left:0;top:0;' +
        'width:100px;height:40px;z-index:3"></a>' +
        '<div style="position:absolute;left:0;top:0;width:200px;height:40px">' +
        '</div></div>',
      300,
    );
    const el = view(node);
    await act();
    assert.strictEqual(el.hrefAtPoint(...pointIn(el, 'top')), '#top');
  },
);

metric(
  "an inline element's rect is its border box across, padding and all",
  async () => {
    // It was its text alone: a padded link measured as wide as its words,
    // and a link around an inline-block as nothing. An element's client
    // rects are its fragments' border boxes (CSSOM View 6.1). The Zen
    // Garden's second design pads the links in its footer
    const { node } = await render(
      '<style>body{margin:0}p{margin:0}</style>' +
        '<p><span id="bare">word</span> <a id="padded" href="#" style="' +
        'padding:0 6px;border-right:3px solid;margin:0 10px">word</a></p>' +
        '<p><a id="around" href="#"><span style="display:inline-block;' +
        'width:40px;height:10px"></span></a></p>' +
        '<p><a id="outer" href="#"><span style="padding-left:7px">word' +
        '</span></a></p>',
      400,
    );
    const el = view(node);
    await act();
    const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
    const bare = rect('bare');
    const padded = rect('padded');
    // the same word, padded 6px each side and bordered 3px at its end; its
    // margins are outside it
    assert.ok(
      Math.abs(padded.width - (bare.width + 15)) < 0.5,
      `${padded.width} wide for ${bare.width} of text`,
    );
    assert.ok(
      Math.abs(rect('around').width - 40) < 0.5,
      `as wide as what it holds: ${rect('around').width}`,
    );
    assert.ok(
      Math.abs(rect('outer').width - (bare.width + 7)) < 0.5,
      `and the padding of an inline box inside it: ${rect('outer').width}`,
    );
  },
);

metric(
  "a box's end edge stays on the line of the content it closes",
  async () => {
    // A break after a box's last character is after its end edge (CSS
    // Text 3, 5.1). Laid out as spacers in one text layout, the edge was a
    // no-break space after a space, which the engine may break before
    // (UAX #14, LB12a): it began the next line, and the box after it
    // started its margin over. The Zen Garden's third design runs its list
    // of designs inline, `margin-right: 5px` on each
    const { node } = await render(
      '<style>body{margin:0}p{margin:0;width:200px}' +
        '.i{margin-right:20px}</style>' +
        '<p id="p"><span class="i">aaaa </span>' +
        '<span id="long" class="i">ccccccccccccccccccccccccccc</span></p>',
      400,
    );
    const el = view(node);
    await act();
    const lines = linesOf(el, 'p');
    assert.strictEqual(lines.length, 2, `${lines.length} lines`);
    const opening = lines[1].edges?.find(
      (edge) => edge.side === 'end' && edge.x <= lines[1].x + 0.5,
    );
    assert.ok(!opening, "the second line begins with the first box's end");
    const long = el.elementRect(findById(el.document, 'long')!)!;
    assert.ok(long.x < 0.5, `the next box starts the line: at ${long.x}`);
  },
);

test('an abbreviation with a title is underlined dotted, as the HTML standard sets it', async () => {
  // HTML 15.3.4: `abbr[title], acronym[title] { text-decoration: dotted
  // underline }`. The user-agent sheet said `none`, so the Zen Garden's
  // first design had its W3C and WaSP plain where a browser marks them
  const { node } = await render(
    '<p><abbr id="t" title="World Wide Web Consortium">W3C</abbr> ' +
      '<acronym id="a" title="Web Standards Project">WaSP</acronym> ' +
      '<abbr id="n">CSS</abbr></p>',
  );
  const el = view(node);
  const styleOf = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { textDecorationLine: string; textDecorationStyle: string };
      }
    ).style;
  for (const id of ['t', 'a']) {
    assert.strictEqual(styleOf(id).textDecorationLine, 'underline', id);
    assert.strictEqual(styleOf(id).textDecorationStyle, 'dotted', id);
  }
  assert.strictEqual(styleOf('n').textDecorationLine, 'none', 'no title');
});

metric(
  "an inline box of a larger face has its own line height, not a multiple of the block's",
  async () => {
    // A `line-height` length is inherited as that length, and a box that
    // sets its own keeps it (CSS 2.1 10.8.1). The one layout set every run
    // at the block's line height as a multiple of the run's face: a 14px
    // box under `font: 11px/15px` came out 15 × 14/11, 19px, on a line
    // CSS makes its own 16px and the strut's 15. The Zen Garden's third
    // design runs a heading inline under its body's `11px/15px`
    const { node } = await render(
      '<style>body{margin:0}div{font:11px/15px serif}' +
        'span{font:14px/16px serif}</style>' +
        '<div id="d"><span>Archives</span></div>',
      400,
    );
    const el = view(node);
    await act();
    const [line] = linesOf(el, 'd');
    assert.ok(
      line.height >= 16 - 0.01 && line.height < 18,
      `as tall as its boxes, not 19: ${line.height}`,
    );
  },
);
