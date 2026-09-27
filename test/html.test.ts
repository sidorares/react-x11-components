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
import { hungSpaces } from '../src/html/layout/inline.js';
import { cocoaShapedLayout } from './cocoa-shaped.js';
import type { ShapedLayout } from './cocoa-shaped.js';
import {
  mediaMatches,
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
  assert.deepStrictEqual(
    [at(7, 'decimal-leading-zero'), at(-3, 'decimal-leading-zero')],
    ['07', '-03'],
  );
  assert.deepStrictEqual([at(5, 'none'), at(5, 'square')], ['', '▪']);
});

/** The text a document's boxes hold, generated content included. */
async function documentText(source: string): Promise<string> {
  const { node } = await render(source, 300);
  return (view(node) as unknown as { _tree: { text: string } })._tree.text;
}

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
  | { op: 'restore' };

/** What painting the document fills, in order. The glyphs are left out:
 *  the recorder has nowhere to draw them. `ops`, when given, gets the fills
 *  and the clips around them. */
async function fillsOf(el: HtmlViewNode, ops?: PaintOp[]): Promise<Fill[]> {
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
  const ctx = {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(v: unknown) {
      fillStyle = v;
    },
    save() {
      ops?.push({ op: 'save' });
    },
    restore() {
      ops?.push({ op: 'restore' });
    },
    fillRect(x: number, y: number, w: number, h: number) {
      const fill = { style: fillStyle, x, y, w, h, radii: null };
      fills.push(fill);
      ops?.push({ op: 'fill', ...fill });
    },
    beginPath() {},
    rect(x: number, y: number, w: number, h: number) {
      path = { x, y, w, h, radii: null };
    },
    roundRect(x: number, y: number, w: number, h: number, radii: number[]) {
      path = { x, y, w, h, radii };
    },
    fill() {
      if (path) {
        const fill = { style: fillStyle, ...path };
        fills.push(fill);
        ops?.push({ op: 'fill', ...fill });
      }
      path = null;
    },
    clip() {
      if (path) {
        const { x, y, w, h, radii } = path;
        ops?.push({ op: 'clip', x, y, w, h, radii });
      }
      path = null;
    },
  };
  for (const layout of layouts) {
    (layout as { draw: unknown }).draw = () => {};
  }
  try {
    paintDocument(ctx as never, tree as never, {
      originX: 0,
      originY: 0,
      damage: null,
      selection: null,
      selectionColor: null,
      imageFor: () => null,
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

/** The clips standing when a fill of this colour was made, innermost last. */
function clipsAround(ops: PaintOp[], color: string): PaintOp[][] {
  const stack: (PaintOp | null)[] = [];
  const out: PaintOp[][] = [];
  for (const op of ops) {
    if (op.op === 'save') stack.push(null);
    else if (op.op === 'restore') stack.pop();
    else if (op.op === 'clip') stack[stack.length - 1] = op;
    else if (op.style === parseColor(color)) {
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
      await waitFor(() => assert.ok(el.textContent().includes('other')));
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
      await waitFor(() => assert.ok(el.textContent().includes('two')));
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
  // a scheme is not a width: the only breakpoint is the width test's
  assert.deepStrictEqual(sheet.breakpoints, [521]);

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
    assert.strictEqual(e.backgroundRepeat, 'no-repeat');
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
    // one fragment: nothing raised starts or ends between them
    const t = all.find((f) => f.text === 'tB')!;
    // the big letter's ascent, not the box's own small font's, from the top
    assert.ok(t.at - line.y > 20, `${t.at - line.y} below the line's top`);
    assert.ok(t.at < all.find((f) => f.text.startsWith('x'))!.at);
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
    const own = await rules('text-decoration:underline');
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

// --- an inline box's own line height -------------------------------------------------

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
