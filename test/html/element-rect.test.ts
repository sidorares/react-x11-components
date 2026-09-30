// <Html> — elementRect: the box an element is measured as.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup } from 'react-x11/test';
import { findById, linesOf, metric, render, view } from './harness.js';

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
