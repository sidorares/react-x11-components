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
  assert.strictEqual(parseColor('rgb(0, 128, 0)'), 'rgb(0, 128, 0)');
  // the end of a style sheet closes what is open (CSS 2.1 4.2)
  assert.strictEqual(parseColor('rgb(0, 128, 0'), 'rgb(0, 128, 0)');
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
  // an image is dropped and the rest stands; what cannot be read drops all
  assert.deepStrictEqual(parseContent('url(x.png) "a"'), [
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
}

interface PlacedLine {
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
  | { op: 'clip'; x: number; y: number; w: number; h: number }
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
      if (path)
        ops?.push({ op: 'clip', x: path.x, y: path.y, w: path.w, h: path.h });
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
    assert.strictEqual(line.texts.length, 3, 'before, inside and after it');
    const [ab, cd, ef] = line.texts.map(extentOf);
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
    const [word] = lines[1].texts.map(extentOf);
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
    const [left, right] = extentOf(text);
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

test('html and body at 100% stay as tall as what they hold', async () => {
  // The element sizes to its content, so the initial containing block has
  // no height to give: a message with the usual reset is not cut off at a
  // window's height.
  const { node } = await render(
    '<html style="height:100%"><body style="height:100%;margin:0">' +
      '<div id="tall" style="height:900px"></div></body></html>',
  );
  assert.ok(
    boxOf(view(node), 'tall').height === 900 &&
      (view(node) as unknown as { _tree: { root: LaidBox } })._tree.root
        .height >= 900,
    'the document holds all 900px',
  );
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
    [[Math.floor(o.x) + 3, Math.floor(o.y) + 3, 54, 24]],
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

metric("a list item's marker goes where its item is moved", async () => {
  // a table cell is laid out at the origin and then placed; the marker was
  // left behind, a bullet at the document's corner
  const { node } = await render(
    '<table style="margin-left:60px"><tr><td>' +
      '<ul style="margin:0"><li id="li">item</li></ul></td></tr></table>',
  );
  const el = view(node);
  const li = boxOf(el, 'li') as LaidBox & { markerX: number; markerY: number };
  assert.ok(
    li.markerX < li.x + 40 && li.markerX > li.x - 40,
    `beside its item: ${li.markerX} by ${li.x}`,
  );
  assert.ok(li.markerY >= li.y - 2 && li.markerY < li.y + li.height);
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
