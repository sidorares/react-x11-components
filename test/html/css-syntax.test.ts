// <Html> — the CSS parser: rules, selectors, escapes, and what a broken sheet
// keeps.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup } from 'react-x11/test';
import {
  parseDeclarations,
  parseStylesheet,
  specificityOf,
} from '../../src/html/css/parse.js';
import {
  parseColor,
  parseLength,
  parseNumber,
} from '../../src/html/css/values.js';
import { boxOf, metric, render, renderWithBytes, view } from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

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

test('a pseudo-element ends its selector: a group with one inside is dropped', async () => {
  const { selectorList } = await import('../../src/html/css/parse.js');
  assert.strictEqual(selectorList('p:first-line p, #p1'), null);
  assert.strictEqual(selectorList('p::before.x'), null);
  assert.deepStrictEqual(selectorList('div > p:first-line'), [
    'div > p:first-line',
  ]);
  // the user action pseudo-classes may follow one (Selectors 4)
  assert.deepStrictEqual(selectorList('a::before:hover'), ['a::before:hover']);
});

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
