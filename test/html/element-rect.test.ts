// <Html> — elementRect: the box an element is measured as.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup } from 'react-x11/test';
import {
  findById,
  linesOf,
  metric,
  render,
  render2x,
  view,
} from './harness.js';

afterEach(cleanup);

metric(
  "an inline element's rect leaves out a positioned box inside it",
  async () => {
    // A positioned box or a float inside an inline box is laid out on lines
    // of its own, none of them the inline box's fragments (CSSOM View
    // 6.1). Design 025 makes its archive list items inline around links
    // placed absolutely, and each item measured as its link
    const { node } = await render(
      '<style>body{margin:0}p{margin:0;position:relative}' +
        'span{padding-right:6px}a{position:absolute;display:block;' +
        'left:200px;top:40px;width:30px;height:18px}</style>' +
        '<p><span id="s"><a id="a" href="#">next</a></span></p>',
      400,
    );
    const el = view(node);
    await act();
    const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
    const s = rect('s');
    assert.ok(
      Math.abs(s.width - 6) < 0.5,
      `its padding alone across: ${s.width}`,
    );
    assert.ok(s.x < 10 && s.y < 30, `and where it is: ${s.x},${s.y}`);
    assert.ok(Math.abs(rect('a').x - 200) < 0.5, 'the link where it is put');
  },
);

metric(
  "an inline element broken around a block takes the block's line in, as a browser does",
  async () => {
    // CSS 2.1 9.2.1.1 breaks an inline box around a block inside it, and a
    // browser reports the inline's box across the lines between its pieces
    // too: Blink's block-in-inline and Gecko's split inline each give it a
    // fragment around the block, across the box the block is in and as
    // tall as its border box. Design 050 makes its archive list items
    // inline around block links, and each measured as the empty edge after
    // its link, nowhere near it
    const { node } = await render(
      '<style>body{margin:0}div{width:120px;padding-left:10px}' +
        'ul{margin:0;padding:40px 0 0}li{display:inline}' +
        'a{display:block;margin:4px 0 4px 5px;height:14px}</style>' +
        '<div><ul><li id="one"><a href="#">first</a></li>' +
        '<li id="two">before <a href="#">second</a> after</li></ul></div>',
      400,
    );
    const el = view(node);
    await act();
    const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
    const one = rect('one');
    assert.deepStrictEqual(
      [one.x, one.y, one.width, one.height],
      [10, 44, 120, 14],
      `a link's line, across the list: ${JSON.stringify(one)}`,
    );
    const two = rect('two');
    assert.ok(
      two.x === 10 && two.width === 120,
      `across the list, the text either side in it: ${JSON.stringify(two)}`,
    );
    assert.ok(
      two.y < one.y + one.height + 10 && two.y + two.height > one.y + 60,
      `from the line before its link to the line after it: ${JSON.stringify(two)}`,
    );
  },
);

metric(
  "an inline element whose text is set at no size is where its block's content starts",
  async () => {
    // Text at `font-size: 0` takes no room and gets no box, so an element
    // of it is on no line; CSS puts it on lines of no height at its block's
    // top (9.4.2), and a browser measures it as nothing there. It measured
    // as where the next text that took room starts: the Zen Garden's 170
    // hides a heading at size 0 and its `<abbr>` was the end of the
    // paragraph above it, 1,700px up the page
    const { node } = await render(
      '<style>body{margin:0}.w{position:relative;height:300px}' +
        'h2{position:absolute;bottom:0;right:28px;width:112px;height:69px;' +
        'font-size:0;line-height:0;margin:0}</style>' +
        '<div class="w"><p>text</p><h2 id="h">So what is this ' +
        '<abbr id="a">CSS</abbr> about?</h2></div>',
      400,
    );
    const el = view(node);
    await act();
    const a = el.elementRect(findById(el.document, 'a')!)!;
    const h = el.elementRect(findById(el.document, 'h')!)!;
    assert.deepStrictEqual(
      [a.x, a.y, a.width, a.height],
      [h.x, h.y, 0, 0],
      `nothing, where the heading's content starts: ${JSON.stringify(a)}`,
    );
  },
);

metric(
  "a relatively positioned inline element's rect is where its offset moves it",
  async () => {
    // CSS 2.1 9.4.3 moves a relatively positioned box and everything in it,
    // and `getBoundingClientRect` reports where it went (CSSOM View 6.1).
    // Design 068 moves its footer links 120px down and 40px right, and each
    // measured on its own line, as wide as from where it was laid out to
    // where it was drawn: its text moved across and not down, its edges
    // not at all
    const { node } = await render(
      '<style>body{margin:0}p{margin:0;font-size:16px;line-height:20px}' +
        '.r{position:relative;top:120px;left:40px}' +
        '.o{position:relative;top:10px;left:5px}</style>' +
        '<p>Text <a id="still" href="#">link</a></p>' +
        '<p>Text <a id="moved" class="r" href="#">link</a></p>' +
        '<p>Text <span class="o" id="outer">outer ' +
        '<a id="inner" class="r" href="#">inner</a></span></p>',
      400,
    );
    const el = view(node);
    await act();
    const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
    const still = rect('still');
    const moved = rect('moved');
    assert.ok(
      Math.abs(moved.x - (still.x + 40)) < 0.5 &&
        Math.abs(moved.y - (still.y + 20 + 120)) < 0.5,
      `40px right and 120px down of where it was laid out: ${JSON.stringify(moved)}, not ${JSON.stringify(still)}`,
    );
    assert.ok(
      Math.abs(moved.width - still.width) < 0.5,
      `as wide as its text: ${moved.width}`,
    );
    const outer = rect('outer');
    const inner = rect('inner');
    assert.ok(
      Math.abs(outer.y - (still.y + 40 + 10)) < 0.5,
      `a box moves by its own offset: ${outer.y}`,
    );
    assert.ok(
      Math.abs(inner.y - (outer.y + 120)) < 0.5,
      `and one inside it by its own and the one around it: ${inner.y}`,
    );
  },
);

metric(
  "an inline element's rect is its border box down, not its line's height",
  async () => {
    // CSSOM View 6.1: a fragment's border box is its font's content area
    // about its baseline, with the padding and border above and below it,
    // which take no room on the line (CSS 2.1 10.6.1). It was the line's
    // band: design 021 pads its sidebar links 10px below, and each measured
    // as tall as its line and no taller
    const { node } = await render(
      '<style>body{margin:0}p{margin:0;font-size:16px;line-height:40px}' +
        '</style><p><span id="bare">word</span> <a id="padded" href="#" ' +
        'style="padding:0 0 10px;border-top:2px solid">word</a></p>',
      400,
    );
    const el = view(node);
    await act();
    const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
    const bare = rect('bare');
    const padded = rect('padded');
    assert.ok(
      bare.height < 30,
      `its font's height, not the line's: ${bare.height}`,
    );
    assert.ok(bare.y > 5, `about its baseline in the 40px line: ${bare.y}`);
    assert.ok(
      Math.abs(padded.height - (bare.height + 12)) < 0.01,
      `${padded.height} tall for ${bare.height} of text`,
    );
    assert.ok(
      Math.abs(padded.y - (bare.y - 2)) < 0.01,
      'its border above its text',
    );
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

metric(
  "a space a link ends on is the link's where the line goes on, and nobody's where the line ends",
  async () => {
    // White space collapses to its first space, which is in the element it
    // is in (CSS Text 3, 4.1.1): a link written `text </a>` before another
    // on its line is that space wider than its letters. A line's end
    // removes the space it ends on (4.1.2), and then no box is wider for
    // it. The Zen Garden's 066 has its resource links so, in list items
    // set inline with a padding: each link before another was a space
    // short, and the item that ended its line a space long, its end edge
    // set after a space that was no longer there
    const item = (id: string, text: string) =>
      `<li id="l${id}"><a id="a${id}" href="#">${text}</a></li> `;
    const { node } = await render(
      '<style>body{margin:0;font-size:16px}ul{margin:0;padding:0;' +
        'list-style:none;width:300px}li{display:inline;padding-left:10px}' +
        '</style><ul>' +
        item('1', 'one ') +
        item('2', 'two') +
        item('3', 'three ') +
        item('4', 'awordtoolongtofitwhatisleftofthefirstline') +
        item('5', 'three') +
        '</ul>',
      300,
    );
    const el = view(node);
    await act();
    const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
    const [a1, l1, a2, l2, a3, l3, l4] = [
      'a1',
      'l1',
      'a2',
      'l2',
      'a3',
      'l3',
      'l4',
    ].map(rect);
    assert.ok(l4.y > l3.y, 'the third item ends the first line');
    // a space is a quarter of an em or so in any face
    const space = l1.x + l1.width - (a2.x - 10);
    assert.ok(
      Math.abs(l2.x - (l1.x + l1.width)) < 0.01 && space < 0.01,
      'the items follow one another',
    );
    assert.ok(
      a1.x + a1.width > a2.x - 10 - 0.01,
      `the first link reaches the next item, its space in it: ${a1.x + a1.width} of ${a2.x - 10}`,
    );
    assert.ok(
      Math.abs(a1.x + a1.width - (l1.x + l1.width)) < 0.01,
      'and ends where its item does',
    );
    // the link with no space ends at its letters, a space short of the
    // next item, which the space between the items is
    assert.ok(
      l3.x - (a2.x + a2.width) > 2,
      `a link with no space in it has none: ${l3.x - (a2.x + a2.width)}`,
    );
    assert.ok(
      Math.abs(l3.x + l3.width - (a3.x + a3.width)) < 0.01,
      `the item that ends the line ends with its link: ${l3.x + l3.width} and ${a3.x + a3.width}`,
    );
    // and its link with its letters: the same word with no space after it
    const bare = rect('a5').width;
    assert.ok(
      Math.abs(a3.width - bare) < 0.01,
      `the space the line ends on is removed: ${a3.width} of ${bare}`,
    );
    assert.ok(
      Math.abs(l3.width - (bare + 10)) < 0.01,
      `from its item as well: ${l3.width} of ${bare + 10}`,
    );
    assert.ok(
      Math.abs(l2.x + l2.width - (a2.x + a2.width)) < 0.01,
      'as one in the middle of it does',
    );
  },
);

test('an inline box around a block that clears a float measures from where clearance moved the block from', async () => {
  // A browser's fragment of an inline box around a block in it is the
  // line that holds the block, and where the block has clearance that line
  // starts where the block would have been without it: Chrome measures a
  // span of a float and a block clearing it from the float's top. Ours
  // started at the block, and the Zen Garden's 214, whose content is an
  // inline box of floats and a footer that clears them, measured 1,700px
  // short. A margin stays outside the fragment, as Chrome has it
  const { node, result } = await render(
    '<style>body{margin:0}.s{display:inline}.f{float:left;width:100px;' +
      'height:80px}.c{clear:both;height:40px}</style>' +
      '<div style="height:10px"></div>' +
      '<div class="s" id="a"><div class="f"></div><div class="c"></div></div>' +
      '<div style="height:10px;clear:both"></div>' +
      '<div class="s" id="b"><div class="c" style="margin-top:15px"></div></div>',
  );
  const el = view(node);
  const rect = (id: string) => el.elementRect(findById(el.document, id)!)!;
  assert.deepStrictEqual(
    [rect('a').y, rect('a').height],
    [10, 120],
    "from the float's top to the cleared block's bottom",
  );
  assert.deepStrictEqual(
    [rect('b').y, rect('b').height],
    [155, 40],
    'and a margin stays outside',
  );
  await result.unmount();
});

/** Where an empty box is, in what a row holds it to. */
type Empty = { x?: number; y?: number; height?: number };
type Rects = (id: string) => {
  x: number;
  y: number;
  width: number;
  height: number;
};

const EMPTY_CSS =
  '<style>body{margin:0;font:16px/20px sans-serif}p{margin:0}</style>';
const IMAGE = '<img width="40" height="40">';

/** Each row is an empty box `#x` and where Chrome measures it. Text widths
 *  and a font's height are the machine's, so what turns on them is held to
 *  `#r`, a span of text on its line, or to `#b`, a box beside it. */
const EMPTY_BOXES: [string, string, (rect: Rects) => Empty][] = [
  [
    'after a paragraph with no text in it',
    '<style>p{height:60px}</style><p>one two</p>' +
      `<p>${IMAGE}</p><p><span id="x"></span><span id="r">|</span></p>`,
    (rect) => ({ x: 0, y: rect('r').y, height: rect('r').height }),
  ],
  [
    'in the paragraph after one of text, which ends where it starts',
    '<style>p{height:60px}</style><p>one two</p>' +
      '<p><span id="x"></span><span id="r">|</span></p>',
    (rect) => ({ x: 0, y: rect('r').y, height: rect('r').height }),
  ],
  [
    'a named anchor that starts a heading',
    '<p>one</p><h2 style="margin:0"><a name="t" id="x"></a>' +
      '<span id="r">Title</span></h2>',
    (rect) => ({ x: 0, y: rect('r').y, height: rect('r').height }),
  ],
  [
    'a named anchor among the words',
    '<p><span id="r">one </span><a name="t" id="x"></a>two</p>',
    (rect) => ({
      x: rect('r').x + rect('r').width,
      y: rect('r').y,
      height: rect('r').height,
    }),
  ],
  [
    'a named anchor before a heading, on a line of no height',
    '<p>one</p><a name="t" id="x"></a><h2 style="margin:0">Title</h2>',
    () => ({ x: 0, y: 20, height: 0 }),
  ],
  [
    'a named anchor in a paragraph of its own',
    '<p>one</p><p><a name="t" id="x"></a></p><p>two</p>',
    () => ({ x: 0, y: 20, height: 0 }),
  ],
  [
    'on the line it ends, where the next word wrapped',
    '<p style="width:min-content"><span id="r">aaaa</span> ' +
      '<span id="x"></span>bbbb</p>',
    (rect) => ({
      x: rect('r').x + rect('r').width,
      y: rect('r').y,
      height: rect('r').height,
    }),
  ],
  [
    'after an image, with no text after it',
    `<p><span id="r">a</span>${IMAGE}<span id="x"></span></p>`,
    (rect) => ({
      x: rect('r').width + 40,
      y: rect('r').y,
      height: rect('r').height,
    }),
  ],
  [
    'before an image, with no text before it',
    `<p><span id="x"></span>${IMAGE}<span id="r">a</span></p>`,
    (rect) => ({ x: 0, y: rect('r').y, height: rect('r').height }),
  ],
  [
    'between two images',
    `<p>${IMAGE}<span id="x"></span>${IMAGE}<span id="r">a</span></p>`,
    (rect) => ({ x: 40, y: rect('r').y, height: rect('r').height }),
  ],
  [
    'before a forced break',
    '<p><span id="r">one</span><span id="x"></span><br>two</p>',
    (rect) => ({
      x: rect('r').x + rect('r').width,
      y: rect('r').y,
      height: rect('r').height,
    }),
  ],
  [
    'on the line a forced break leaves empty',
    '<p>one<br><span id="x"></span><br><span id="r">two</span></p>',
    (rect) => ({ x: 0, y: rect('r').y - 20, height: rect('r').height }),
  ],
  [
    'after a last forced break, on a line of no height',
    '<p>one<br><span id="x"></span></p>',
    () => ({ x: 0, y: 20, height: 0 }),
  ],
  [
    'there, in the middle of a centred paragraph',
    '<p style="text-align:center">one<br><span id="x"></span></p>',
    () => ({ x: 200, y: 20, height: 0 }),
  ],
  [
    'in the middle of a centred paragraph of nothing',
    '<p style="text-align:center"><span id="x"></span></p>',
    () => ({ x: 200, y: 0, height: 0 }),
  ],
  [
    "before a padded box's padding",
    '<p><span id="r">one </span><i id="x"></i>' +
      '<b style="padding:0 10px">two</b></p>',
    (rect) => ({ x: rect('r').x + rect('r').width, y: rect('r').y }),
  ],
  [
    'after the padding of the box it starts',
    '<p>one <b id="b" style="padding:0 10px"><i id="x"></i>two</b></p>',
    (rect) => ({ x: rect('b').x + 10 }),
  ],
  [
    'before the padding of the box it ends',
    '<p><b id="b" style="padding:0 10px">two<i id="x"></i></b> three</p>',
    (rect) => ({ x: rect('b').x + rect('b').width - 10 }),
  ],
  [
    "after a padded box's padding",
    '<p><b id="b" style="padding:0 10px">two</b><i id="x"></i> three</p>',
    (rect) => ({ x: rect('b').x + rect('b').width }),
  ],
  [
    'past its own margin',
    '<p><span id="r">one </span><i id="x" style="margin:0 5px"></i>two</p>',
    (rect) => ({ x: rect('r').x + rect('r').width + 5 }),
  ],
  [
    'in the font of the box it is in',
    '<p>one <small><i id="x"></i><span id="r">two</span></small></p>',
    (rect) => ({ y: rect('r').y, height: rect('r').height }),
  ],
  [
    'raised by its own vertical-align',
    '<p><span id="r">one </span>' +
      '<span id="x" style="vertical-align:10px"></span>two</p>',
    (rect) => ({ y: rect('r').y - 10, height: rect('r').height }),
  ],
  [
    'raised by the vertical-align of the box it is in',
    '<p><b style="vertical-align:10px"><i id="x"></i>' +
      '<span id="r">two</span></b> one</p>',
    (rect) => ({ y: rect('r').y, height: rect('r').height }),
  ],
  [
    'back on the line where the box it is in is lowered as far',
    '<p>zero <b style="vertical-align:10px">one ' +
      '<i style="vertical-align:-10px"><u id="x"></u>' +
      '<span id="r">two</span></i></b></p>',
    (rect) => ({ y: rect('r').y, height: rect('r').height }),
  ],
  [
    'moved by its own relative offset',
    '<p><span id="r">one </span>' +
      '<span id="x" style="position:relative;left:7px;top:9px"></span>' +
      'two</p>',
    (rect) => ({
      x: rect('r').x + rect('r').width + 7,
      y: rect('r').y + 9,
    }),
  ],
  [
    'moved by a relative offset on a line of no height',
    '<p><span id="x" style="position:relative;left:7px"></span></p>',
    () => ({ x: 7, y: 0, height: 0 }),
  ],
  [
    'not moved by a relative offset on the text before it',
    '<p>one <b id="b" style="position:relative;left:5px">two</b>' +
      '<i id="x"></i> three</p>',
    (rect) => ({ x: rect('b').x + rect('b').width - 5 }),
  ],
  [
    'after an image, right to left',
    `<p dir="rtl">${IMAGE}<span id="x"></span>${IMAGE}<span id="r">a</span></p>`,
    (rect) => ({ x: 360, y: rect('r').y, height: rect('r').height }),
  ],
  [
    'before an image, right to left',
    `<p dir="rtl"><span id="x"></span>${IMAGE}<span id="r">a</span></p>`,
    (rect) => ({ x: 400, y: rect('r').y, height: rect('r').height }),
  ],
  [
    'at the end of the line, right to left, whichever way its text reads',
    '<p dir="rtl"><span id="r">two</span><span id="x"></span></p>',
    (rect) => ({ x: rect('r').x, y: rect('r').y, height: rect('r').height }),
  ],
  [
    'after a last forced break, right to left',
    '<p dir="rtl">one<br><span id="x"></span></p>',
    () => ({ x: 400, y: 20, height: 0 }),
  ],
  [
    'through a transform once, where a caret was mapped twice',
    '<div style="transform:translateX(30px) scale(2);transform-origin:0 0">' +
      '<p><span id="r">one </span><span id="x"></span>two</p></div>',
    (rect) => ({
      x: rect('r').x + rect('r').width,
      y: rect('r').y,
      height: rect('r').height,
    }),
  ],
  [
    'after text an absolutely positioned box is in the middle of',
    '<p><span id="r">one</span><span id="x"></span>' +
      '<span style="position:absolute">two</span> three</p>',
    (rect) => ({ x: rect('r').x + rect('r').width, y: rect('r').y }),
  ],
  [
    'after another box as empty',
    '<p><span id="r">one </span><span></span><span id="x"></span>two</p>',
    (rect) => ({ x: rect('r').x + rect('r').width, y: rect('r').y }),
  ],
];

for (const [name, source, expected] of EMPTY_BOXES) {
  metric(`an inline box with nothing in it: ${name}`, async () => {
    const { node } = await render(EMPTY_CSS + source, 400);
    const el = view(node);
    await act();
    const rect: Rects = (id) => el.elementRect(findById(el.document, id)!)!;
    const got = rect('x');
    assert.strictEqual(got.width, 0, 'no wider than nothing');
    const want = expected(rect);
    for (const key of ['x', 'y', 'height'] as const) {
      const value = want[key];
      if (value === undefined) continue;
      assert.ok(
        Math.abs(got[key] - value) < 0.5,
        `${key}: ${got[key]}, where Chrome has ${value}`,
      );
    }
  });
}

metric(
  'offsetLeft and offsetTop find an empty box where its rect does',
  async () => {
    const { node } = await render(
      `${EMPTY_CSS}<p>one two</p><p>${IMAGE}</p>` +
        '<p style="position:relative;padding-left:9px">' +
        '<span id="r">a </span><span id="x"></span>b</p>',
      400,
    );
    const el = view(node);
    await act();
    const ruler = el.offsetRect(findById(el.document, 'r')!)!;
    const empty = el.offsetRect(findById(el.document, 'x')!)!;
    assert.ok(
      Math.abs(empty.x - (ruler.x + ruler.width)) < 0.5,
      `after the text: ${empty.x}`,
    );
    assert.ok(Math.abs(empty.y - ruler.y) < 0.5, `on its line: ${empty.y}`);
    assert.strictEqual(empty.width, 0);
  },
);

metric('an empty box measures in logical pixels on a 2x display', async () => {
  const { node } = await render2x(
    `${EMPTY_CSS}<style>p{height:60px}</style><p>one two</p><p>${IMAGE}</p>` +
      '<p><span id="r">a </span><i id="x" style="margin:0 5px"></i>b</p>',
    400,
  );
  const el = view(node);
  await act();
  const r = el.elementRect(findById(el.document, 'r')!)!;
  const x = el.elementRect(findById(el.document, 'x')!)!;
  assert.ok(Math.abs(x.x - (r.x + r.width + 5)) < 0.5, `across: ${x.x}`);
  assert.ok(Math.abs(x.y - r.y) < 0.5, `on its line: ${x.y}`);
  assert.ok(Math.abs(x.height - r.height) < 0.5, `as tall: ${x.height}`);
  assert.ok(r.y > 120, `three paragraphs down: ${r.y}`);
});
