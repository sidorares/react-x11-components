// <Html> — generated content: ::before and ::after, counters, quotes,
// markers, ::first-letter and ::first-line.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, expectPixel, isNear, pixelAt } from 'react-x11/test';
import {
  CounterStyles,
  counterStyleRule,
} from '../../src/html/css/counter-styles.js';
import type { CounterStyleRule } from '../../src/html/css/counter-styles.js';
import { parseStylesheet } from '../../src/html/css/parse.js';
import { parseColor } from '../../src/html/css/values.js';
import {
  counterText,
  parseContent,
  parseCounterList,
  parseQuotes,
} from '../../src/html/css/content.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import {
  SVG_NS,
  boxOf,
  documentText,
  findById,
  linesOf,
  metric,
  pixelsIn,
  render,
  renderWithBytes,
  renderWithImages,
  svgBytes,
  view,
} from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

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

metric(
  "::first-line's text-transform sets the first line in capitals, and nothing else",
  async () => {
    // CSS 2.1 5.12.1: `text-transform` applies to the first line. Design
    // 030's summary is capitals on its first line in Chrome, which wrap it
    // onto three lines where the lower case made two
    const { el } = await renderWithBytes(
      '<style>body{margin:0}p{margin:0;width:300px;font:16px sans-serif}' +
        '#t::first-line{text-transform:uppercase}</style>' +
        '<p id="t">straße and words</p><p id="u">straße and words</p>' +
        '<p id="w" style="width:60px" class="w">abc def</p>' +
        '<style>#w::first-line{text-transform:uppercase}</style>',
      {},
    );
    const width = (id: string) =>
      (boxOf(el, id) as unknown as { lines: { width: number }[] }).lines[0]
        .width;
    assert.ok(
      width('t') > width('u') * 1.1,
      `capitals are wider: ${width('t')} against ${width('u')}`,
    );
    // the document's text is its own, capitals or not
    assert.ok(el.textContent().startsWith('straße and words'));
    // and a second line is not the first
    const lines = (boxOf(el, 'w') as unknown as { lines: { width: number }[] })
      .lines;
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[1].width < lines[0].width, 'def in lower case');
  },
);

metric(
  '::first-line fonts break the first line, and what is on it inherits them (CSS Pseudo 4, 2.1.2)',
  async () => {
    const { el } = await renderWithBytes(
      '<style>body{margin:0}p{margin:0;width:300px;font:12px/13px monospace}' +
        'p::first-line{font:24px/30px monospace}small{font-size:50%}</style>' +
        '<p id="p"><span id="a">aaaa</span> bbbb <small id="c">cccc</small> ' +
        'dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn</p>',
      {},
    );
    const { lines } = boxOf(el, 'p') as unknown as {
      lines: { height: number; textStart: number; textEnd: number }[];
    };
    // the first line in the pseudo-element's 24px holds what fits in them:
    // in the block's 12px it held some forty letters
    assert.strictEqual(lines.length, 3, 'the text is on three lines');
    assert.ok(lines[0].textEnd <= 25, `line 1 ends at ${lines[0].textEnd}`);
    // at the pseudo-element's line height, the block's strut still on it,
    // and the lines after it at the block's
    assert.ok(lines[0].height >= 30, `line 1 is ${lines[0].height} tall`);
    assert.strictEqual(lines[1].height, 13);
    assert.strictEqual(lines[2].height, 13);
    // an element on the line computes its size from the line's font: the
    // <small> is half of 24px, not half of the block's 12px
    const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
    const ratio = rect('a').width / rect('c').width;
    assert.ok(Math.abs(ratio - 2) < 0.1, `aaaa is ${ratio} times cccc`);
  },
);

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
  const { parseContent } = await import('../../src/html/css/content.js');
  assert.deepStrictEqual(parseContent('url(a.png) "b"'), [
    { kind: 'url', url: 'a.png' },
    { kind: 'string', text: 'b' },
  ]);
  assert.deepStrictEqual(parseContent('url("a b.png")'), [
    { kind: 'url', url: 'a b.png' },
  ]);
  assert.strictEqual(parseContent('url(a b.png)'), null);
});

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

metric(
  "a list marker's image with no size of its own is a square half its face's ascent across",
  async () => {
    // CSS Lists 3 (3.3) sizes it by CSS Images' default sizing in a 1em
    // square, which Blink and Gecko both find too large
    // (w3c/csswg-drafts#4207): Blink's square is half the ascent, rounded
    // first, and what has only a ratio is fitted into it. An SVG with only
    // a `viewBox` came to 0 by 0 and drew no marker, and inside the item
    // to the 300 by 150 a generated image defaults to
    const images = {
      'square.svg': svgBytes(
        `<svg ${SVG_NS} viewBox="0 0 40 40">` +
          '<rect width="40" height="40" fill="#ff0000"/></svg>',
      ),
      'wide.svg': svgBytes(
        `<svg ${SVG_NS} viewBox="0 0 80 40">` +
          '<rect width="80" height="40" fill="#ff0000"/></svg>',
      ),
      'bare.svg': svgBytes(
        `<svg ${SVG_NS}><rect width="100%" height="100%" fill="#ff0000"/>` +
          '</svg>',
      ),
      'narrow.svg': svgBytes(
        `<svg ${SVG_NS} width="30"><rect width="100%" height="100%" ` +
          'fill="#ff0000"/></svg>',
      ),
    };
    const source =
      '<style>body{margin:0}ul{margin:0;padding:0 0 0 80px;' +
      'font:40px/60px sans-serif}li{margin:0;' +
      'list-style-image:url(square.svg)}#b{list-style-image:url(wide.svg)}' +
      '#c{list-style-image:url(bare.svg)}' +
      '#d{list-style-image:url(narrow.svg)}' +
      '#e{list-style-position:inside}</style><ul><li id="a">a</li>' +
      '<li id="b">b</li><li id="c">c</li><li id="d">d</li>' +
      '<li id="e">e</li></ul>';
    const { result, el } = await renderWithBytes(source, images);
    await act();
    const fonts = (
      result as unknown as {
        app: {
          fonts: {
            match(
              family: string,
              opts: { size: number },
            ): { metrics(size: number): { ascent: number } };
          };
        };
      }
    ).app.fonts;
    const sideAt = (size: number) =>
      Math.round(fonts.match('sans-serif', { size }).metrics(size).ascent) / 2;
    const side = sideAt(40);
    // 18 in Arial, whose ascent at 40px is 36.2, as Chrome has it
    assert.ok(side > 15 && side < 20, `half the ascent: ${side}`);
    type Marked = LaidBox & {
      marker: { image?: { width: number; height: number } } | null;
    };
    const imageOf = (id: string) => (boxOf(el, id) as Marked).marker?.image;
    const sizes = Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((id) => [id, imageOf(id)]),
    );
    assert.deepStrictEqual(
      Object.fromEntries(
        Object.entries(sizes).map(([id, image]) => [
          id,
          image && [image.width, image.height],
        ]),
      ),
      {
        a: [side, side],
        // a ratio alone, as large as fits in the square
        b: [side, side / 2],
        // no size and no ratio, the square
        c: [side, side],
        // a width and no ratio, the square's height
        d: [30, side],
      },
    );

    // drawn: the square, its bottom on the first line's baseline and the
    // gap a bullet has between it and the text
    const reach = async (...edges: [number, number, number, number]) => {
      // whole pixels: a box's edge can be a float's residue off one, and a
      // read of 59.99… rows is refused
      const [x0, x1, y0, y1] = edges.map(Math.round);
      const w = x1 - x0;
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
        ).getImageData(x0, y0, w, y1 - y0, (e, d) =>
          e ? fail(e) : ok(d.data),
        ),
      );
      let [left, right, top, bottom] = [Infinity, -Infinity, Infinity, -1];
      for (let i = 0; i < data.length; i += 4) {
        // red over white, more than half covered
        if (data[i] < 200 || data[i + 1] > 127 || data[i + 2] > 127) continue;
        const x = x0 + ((i / 4) % w);
        const y = y0 + Math.floor(i / 4 / w);
        [left, right] = [Math.min(left, x), Math.max(right, x + 1)];
        [top, bottom] = [Math.min(top, y), Math.max(bottom, y + 1)];
      }
      return { width: right - left, height: bottom - top, left, bottom };
    };
    const outside = await reach(0, 80, 0, 60);
    const baseline = linesOf(el, 'a')[0].baseline;
    assert.ok(
      Math.abs(outside.width - side) <= 1 &&
        Math.abs(outside.height - side) <= 1,
      `a ${side}px square: ${outside.width} by ${outside.height}`,
    );
    assert.ok(
      Math.abs(outside.bottom - baseline) <= 1,
      `on the baseline, ${baseline}: ${outside.bottom}`,
    );
    // inside the item, the first thing on its line, and as large
    const e = boxOf(el, 'e');
    const inside = await reach(e.x, e.x + 40, e.y, e.y + 60);
    assert.ok(
      Math.abs(inside.width - side) <= 1 && Math.abs(inside.height - side) <= 1,
      `inside, a ${side}px square: ${inside.width} by ${inside.height}`,
    );
    assert.strictEqual(
      inside.left,
      Math.round(e.x),
      'at the start of the line',
    );

    // the square is device pixels: twice as large at 2x
    cleanup();
    const twice = await renderWithBytes(source, images, 400, 2);
    await act();
    const image = (boxOf(twice.el, 'a') as Marked).marker?.image;
    assert.deepStrictEqual(image && [image.width, image.height], [
      sideAt(80),
      sideAt(80),
    ]);
    assert.ok(
      Math.abs(sideAt(80) - 2 * side) <= 1,
      `twice ${side}: ${sideAt(80)}`,
    );
  },
);

metric(
  "a list item's first line is as tall as its marker's image",
  async () => {
    // CSS 2.1 12.5.1 leaves where an outside marker goes to the user
    // agent; Blink and Gecko set it on the item's first line, its image's
    // bottom on the baseline, and make the line as tall as it. Design 032's
    // bullets are taller than its 10px text, and every item came out
    // shorter than Chrome's
    const { el } = await renderWithBytes(
      '<style>body{margin:0}ul{margin:0;padding:0 0 0 40px;font:10px/12px ' +
        'sans-serif;list-style-image:url(tall.svg)}li{margin:0}</style>' +
        '<ul><li id="a">item one</li><li id="b"></li>' +
        '<li id="c"><div>in a block</div></li></ul>',
      {
        'tall.svg': svgBytes(
          `<svg ${SVG_NS} width="10" height="30">` +
            '<rect width="10" height="30" fill="#ff0000"/></svg>',
        ),
      },
    );
    await act();
    const first = (id: string) => linesOf(el, id)[0];
    for (const id of ['a', 'b']) {
      const line = first(id);
      assert.ok(line, `#${id} has a first line`);
      assert.ok(
        line.baseline >= 30 - 0.01,
        `#${id}: the image's 30px above the baseline: ${line.baseline}`,
      );
    }
    assert.ok(boxOf(el, 'b').height >= 30, 'an empty item holds it too');
    // and one whose first line is in a block inside it, which goes lower
    assert.ok(boxOf(el, 'c').height >= 30, 'an item around a block');
  },
);

metric(
  "a list marker's image is 7px from the content, outside the item and inside it, as Chrome sets it",
  async () => {
    // CSS 2.1 12.5.1 leaves where a marker goes to the user agent. Blink
    // puts an image 7px from the content (`kCMarkerPaddingPx`): outside
    // the item, between the image and the content's edge, and inside it,
    // after the image, where ours was a space. Outside, ours was 0.4em,
    // 16px at 40px text, and Chrome draws the image at x 53 to 72 before
    // content at 80; inside, a space, 11px in 40px Arial, and the
    // content's own space after the image went into it
    const images = {
      'x.svg': svgBytes(
        `<svg ${SVG_NS} width="20" height="20">` +
          '<rect width="20" height="20" fill="#ff0000"/></svg>',
      ),
    };
    const sheet =
      '<style>body{margin:0}ul{margin:0;padding:0 0 0 80px;' +
      'font:40px/50px sans-serif;list-style-image:url(x.svg)}li{margin:0}' +
      'b{display:inline-block;width:10px;height:10px;background:#0000ff}' +
      '.s{font-size:16px;line-height:30px}.in{list-style-position:inside}' +
      '.pre{white-space:pre}.rtl{direction:rtl;padding:0 80px 0 0}</style>';
    // the red image's and the blue box's columns on an item's line, in
    // device pixels, a pixel counted where it is more than half covered;
    // the item's whole rows, since an item a marker made taller ends where
    // the face puts its baseline — 30.15px down, in DejaVu Sans
    const inkOf = async (
      result: { ctx: unknown },
      at: { y: number; height: number },
      width: number,
    ) => {
      const y = Math.ceil(at.y);
      const height = Math.floor(at.y + at.height) - y;
      const data = await pixelsIn(result.ctx, { x: 0, y, width, height });
      const red = [Infinity, -Infinity];
      const blue = [Infinity, -Infinity];
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        const ink =
          r > 200 && g < 128 && b < 128
            ? red
            : b > 200 && r < 128 && g < 128
              ? blue
              : null;
        if (!ink) continue;
        const x = (i / 4) % width;
        [ink[0], ink[1]] = [Math.min(ink[0], x), Math.max(ink[1], x + 1)];
      }
      return { red, blue };
    };
    const { result, el } = await renderWithBytes(
      sheet +
        '<ul><li id="a"><b></b>a</li></ul>' +
        '<ul class="s"><li id="s"><b></b>a</li></ul>' +
        '<ul class="in"><li id="i"><b></b>a</li></ul>' +
        '<ul class="in"><li id="sp"> <b></b>a</li></ul>' +
        '<ul class="in pre"><li id="pre"> <b></b>a</li></ul>' +
        '<ul class="rtl"><li id="r"><b></b>a</li></ul>' +
        '<ul class="rtl in"><li id="ri"><b></b>a</li></ul>',
      images,
    );
    await act();
    const ink = (id: string) => inkOf(result, boxOf(el, id), 440);
    // outside: the image ends 7px before the content, at any text size
    for (const id of ['a', 's']) {
      assert.deepStrictEqual(
        await ink(id),
        { red: [53, 73], blue: [80, 90] },
        `#${id}, outside`,
      );
    }
    // inside: the image at the content's edge, the content 7px after it
    assert.deepStrictEqual(
      await ink('i'),
      { red: [80, 100], blue: [107, 117] },
      'inside',
    );
    // and the content's own space after that, kept as it is after an
    // image, one space whether it collapses or not
    const spaced = (await ink('sp')).blue[0];
    assert.ok(spaced > 107 + 5, `a space after the gap: ${spaced}`);
    assert.strictEqual((await ink('pre')).blue[0], spaced, 'white-space: pre');
    // at the start of a right-to-left line, which is its right
    assert.deepStrictEqual(
      await ink('r'),
      { red: [327, 347], blue: [310, 320] },
      'right to left, outside',
    );
    assert.deepStrictEqual(
      await ink('ri'),
      { red: [300, 320], blue: [283, 293] },
      'right to left, inside',
    );

    // 7 CSS pixels: 14 device pixels at 2x, so the page is the page at 1x
    // doubled. Blink writes its 7 into the marker's margins unzoomed, and
    // Chrome's is 7 device pixels at a device scale of 2
    cleanup();
    const twice = await renderWithBytes(
      sheet +
        '<ul><li id="a"><b></b>a</li></ul>' +
        '<ul class="in"><li id="i"><b></b>a</li></ul>',
      images,
      400,
      2,
    );
    await act();
    const device = (id: string) =>
      inkOf(twice.result, boxOf(twice.el, id), 880);
    assert.deepStrictEqual(
      await device('a'),
      { red: [106, 146], blue: [160, 180] },
      'outside, at 2x',
    );
    assert.deepStrictEqual(
      await device('i'),
      { red: [160, 200], blue: [214, 234] },
      'inside, at 2x',
    );
  },
);

metric(
  "an outside marker that reaches above a block's first baseline moves the block down, and its line keeps its height",
  async () => {
    // CSS 2.1 12.5.1 leaves it to the user agent. Blink aligns the
    // marker's baseline with the first baseline of the item's first block
    // and pushes the block down by what the marker reaches above it
    // (`UnpositionedListMarker::AddToBox`); the block's first line grew
    // instead. Design 196's `display: block` links, under 18px bullets,
    // were 21px tall where Chrome sets them 14px tall and 7px lower
    const { el } = await renderWithBytes(
      '<style>body{margin:0}ul{margin:0;padding:0 0 0 40px;font:10px/12px ' +
        'sans-serif;list-style-image:url(tall.svg)}li,p{margin:0}' +
        'a{display:block}</style><ul><li id="a"><a id="l">in a block</a>' +
        '</li><li id="b"><div><p id="p">two blocks down</p></div></li>' +
        // a float in the block goes down with it, and the next paragraph's
        // line, which only the moved float reaches, is set beside it
        '<li><p><span style="float:left;width:30px;height:25px"></span>x' +
        '</p><p id="after">after</p></li></ul>',
      {
        'tall.svg': svgBytes(
          `<svg ${SVG_NS} width="10" height="30">` +
            '<rect width="10" height="30" fill="#ff0000"/></svg>',
        ),
      },
    );
    await act();
    for (const [item, id] of [
      ['a', 'l'],
      ['b', 'p'],
    ]) {
      const block = boxOf(el, id);
      const [line] = linesOf(el, id);
      assert.ok(line, `#${id} has a line`);
      assert.ok(
        Math.abs(block.height - 12) < 0.01,
        `#${id}'s line keeps its 12px: ${block.height}`,
      );
      const baseline = line.y + line.baseline - block.y;
      assert.ok(
        Math.abs(block.y - boxOf(el, item).y - (30 - baseline)) < 0.01,
        `#${id} is 30px less its baseline, ${baseline}, into #${item}: ` +
          `${block.y - boxOf(el, item).y}`,
      );
    }
    const after = linesOf(el, 'after')[0];
    assert.ok(
      Math.abs(after.x - boxOf(el, 'after').x - 30) < 0.01,
      `the line after the float is beside it: ${after.x}`,
    );

    // a bullet reaches its item's ascent, on a line of the item's height
    const { node, result } = await render(
      '<style>body{margin:0}ul{margin:0;padding:0 0 0 40px;font:20px/30px ' +
        'sans-serif}li,p{margin:0}p{font:10px/12px sans-serif}</style>' +
        '<ul><li id="own">own line</li><li id="i"><p id="q">small</p></li>' +
        '</ul>',
    );
    const text = view(node);
    const ascent = linesOf(text, 'own')[0].baseline;
    const q = boxOf(text, 'q');
    const [line] = linesOf(text, 'q');
    const push = ascent - (line.y + line.baseline - q.y);
    assert.ok(push > 5, `a 20px bullet reaches above 10px text: ${push}`);
    assert.ok(
      Math.abs(q.y - boxOf(text, 'i').y - push) < 0.01,
      `the paragraph goes ${push}px lower: ${q.y - boxOf(text, 'i').y}`,
    );
    await result.unmount();
  },
);
