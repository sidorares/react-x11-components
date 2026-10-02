// <Html> — the pointer: what is under it, the cursor, and a hover restyled in
// place.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import {
  act,
  cleanup,
  expectPixel,
  fireEvent,
  isNear,
  pixelAt,
  renderX11,
  screen,
  waitFor,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { HtmlViewNode } from '../../src/html/index.js';
import { hoverClock } from '../../src/html/node.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import { holdClock } from '../held-clock.js';
import {
  FONTS,
  boxOf,
  findById,
  h,
  metric,
  render,
  render2x,
  view,
} from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

metric('a click on a link reports its href; a drag does not', async (t) => {
  // Twice: in a document that selects, where a drag leaves a selection behind
  // as well as having travelled, and in one that selects nothing, where how
  // far the pointer went is all that tells the two apart.
  for (const selectable of [true, false]) {
    const clicks: string[] = [];
    const result = await renderX11(
      h(
        'box',
        { style: { width: 400, flexDirection: 'column' } },
        h(Html, {
          source: '<p><a href="https://example.test/x">a link here</a></p>',
          partial: false,
          selectable,
          onLink: (href: string) => clicks.push(href),
          'data-testname': 'doc',
        }),
      ),
      { width: 440, height: 200, fonts: FONTS! },
    );
    const node = screen.getByTestName('doc') as DrawnNode;
    const el = view(node);

    // The press lands on the element, which is what a real pointer hits and
    // what `useLinkClicks` reads `hrefAtPoint` from. The harness places a
    // pointer by offset from the node's centre.
    const target = el as unknown as DrawnNode;
    const at = (index: number) => {
      const caret = el.textCaretRect(index);
      assert.ok(caret, 'the link text is laid out');
      const x = caret.x + 1;
      const y = caret.y + caret.height / 2;
      assert.strictEqual(el.hrefAtPoint(x, y), 'https://example.test/x');
      return {
        dx: x - (target.abs.x + target.abs.width / 2),
        dy: y - (target.abs.y + target.abs.height / 2),
      };
    };

    const click = at(2);
    await act(async () => {
      fireEvent.mouseDown(target, click);
      fireEvent.mouseUp(target, click);
    });
    assert.deepStrictEqual(clicks, ['https://example.test/x']);

    // A press that travelled is a selection gesture, not a click — and two
    // things about the harness decide whether this one travels. `mouseUp`
    // takes no offset: it releases wherever the pointer is, so the pointer
    // is moved first. And a second press within core's double-click
    // distance of the first (4px, with no settings daemon on the harness's
    // server) is a double click for 400ms of the wall clock, which selects
    // a word on the press. Written as a press and a release at one spot,
    // that word was all that kept this gesture from being a click, until a
    // runner slow enough to spend 400ms between the two presses followed
    // the link. So it presses farther away, and moves.
    const drag = at(7);
    assert.ok(
      Math.abs(drag.dx - click.dx) > 4,
      `the second press is not a double click: ${drag.dx - click.dx}px away`,
    );
    await act(async () => {
      fireEvent.mouseDown(target, drag);
    });
    fireEvent.mouseMove(target, { dx: drag.dx + 60, dy: drag.dy });
    await act();
    if (selectable) {
      await waitFor(() =>
        assert.strictEqual(
          node.selectedText(),
          'here',
          'the drag selected what it crossed',
        ),
      );
    }
    await act(async () => {
      fireEvent.mouseUp(target);
    });
    if (!selectable) {
      assert.strictEqual(
        node.selectedText(),
        '',
        'nothing was selected: the travel alone tells it from a click',
      );
    }
    assert.strictEqual(clicks.length, 1, 'the drag did not follow the link');

    if (selectable) {
      // A press that did not travel is not a click either when it selected
      // something, which is the check the travel cannot stand in for: a
      // double click's second press takes the word under it, so its first
      // press follows the link and its second does not. Core counts the
      // presses by `Date.now()`, so the time is held for the pair.
      const now = Date.now();
      const held = t.mock.method(Date, 'now', () => now);
      await act(async () => {
        fireEvent.doubleClick(target, click);
      });
      held.mock.restore();
      assert.strictEqual(
        node.selectedText(),
        'link',
        'the second press took the word',
      );
      assert.strictEqual(
        clicks.length,
        2,
        'the first press followed the link and the second did not',
      );
    }
    await result.unmount();
  }
});

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

/** The box tree, to tell a restyle in place from a document built again. */
const treeOf = (el: HtmlViewNode) =>
  (el as unknown as { _tree: unknown })._tree;

metric(
  'the pointer passes through a box that is hidden, or takes no pointer events',
  async () => {
    // A box that is not visible is no target for the pointer, and neither
    // is one with `pointer-events: none` (CSS UI 4, 5.2): what is under it
    // is. Both are inherited, and what is in such a box may set them back.
    // The hit test named every box that was laid out: a site's closed menu
    // lies over its page, hidden until it is opened, and GitHub's covered
    // its repository's tabs — the pointer over a tab was over the menu, and
    // the tab neither lit up nor took the press.
    const { node } = await render(
      '<style>body{margin:0} .u{height:40px}' +
        '.o{position:absolute;left:0;width:200px;height:40px}</style>' +
        '<div class="u" id="a">under a menu that is closed</div>' +
        '<div class="o" id="h" style="top:0;visibility:hidden">' +
        '<span id="hs">hidden</span></div>' +
        '<div class="u" id="b">under a layer that takes no events</div>' +
        '<div class="o" id="n" style="top:40px;pointer-events:none">' +
        '<span id="ns">none</span><div id="na" style="pointer-events:auto;' +
        'margin-left:150px;width:50px;height:20px"></div></div>' +
        '<div class="u" id="c">under one with something to see in it</div>' +
        '<div class="o" id="v" style="top:80px;visibility:hidden">' +
        '<div id="vv" style="visibility:visible;width:50px;height:40px">' +
        '</div></div>' +
        '<div class="u" id="d">under a transparent one</div>' +
        '<div class="o" id="op" style="top:120px;opacity:0"></div>',
    );
    const el = view(node);
    const { abs } = el as unknown as DrawnNode;
    const at = (x: number, y: number) =>
      el.elementAtPoint(abs.x + x, abs.y + y)?.attribs.id;
    assert.strictEqual(at(100, 20), 'a', 'through a hidden box');
    assert.strictEqual(at(10, 12), 'a', 'and its text');
    assert.strictEqual(at(100, 60), 'b', 'through one with no events');
    assert.strictEqual(at(10, 52), 'b', 'and its text');
    assert.strictEqual(at(170, 70), 'na', 'a box in it that takes them');
    assert.strictEqual(at(100, 100), 'c');
    assert.strictEqual(at(20, 100), 'vv', 'a visible box in a hidden one');
    assert.strictEqual(at(100, 140), 'op', 'a transparent box is a target');
  },
);

metric(
  'the pointer is over the text drawn over an inline-block, in the order the lines paint them',
  async () => {
    // What is under a point is what was painted there last, and a line
    // paints its atomics in their turn among its text, as it paints one
    // line before the next (CSS 2.1 Appendix E, 7.2.1) — as browsers find
    // them with elementFromPoint. Keyed in the lines' layer with nothing to
    // order them by, an inline-block, a layer longer than a word's, took
    // the pointer from every word after it in the document: of its line, of
    // the next, and of a block a negative margin drew up over it.
    const { node } = await render(
      '<style>body{margin:0;font:20px/20px monospace}section{height:60px}' +
        '.a{display:inline-block;vertical-align:top;width:100px;' +
        'height:20px}</style>' +
        // a block after it
        '<section><div class="a" id="a1" style="width:400px;height:40px">' +
        '</div><div style="margin-top:-20px"><span id="t1">text</span>' +
        '</div></section>' +
        // a word after it on its line, over its own text
        '<section><span class="a" id="a2" style="margin-right:-100px">' +
        '<span id="i2">xxxx</span></span><span id="t2">text</span>' +
        '</section>' +
        // the next line, which it hangs into
        '<section><span class="a" id="a3" style="height:40px;' +
        'margin-bottom:-20px"></span><br><span id="t3">text</span></section>' +
        // and a word before it, which it is over
        '<section><span id="t4">text</span><span class="a" id="a4" ' +
        'style="margin-left:-40px"></span></section>',
    );
    const el = view(node);
    const { abs } = el as unknown as DrawnNode;
    const at = (x: number, y: number) =>
      el.elementAtPoint(abs.x + x, abs.y + y)?.attribs.id;
    assert.strictEqual(at(10, 30), 't1', 'a block after it');
    assert.strictEqual(at(10, 70), 't2', 'a word after it');
    assert.strictEqual(at(10, 150), 't3', 'the next line');
    assert.strictEqual(at(20, 190), 'a4', 'a word before it');
    assert.strictEqual(at(80, 70), 'a2', 'and itself, past the word');
  },
);

metric(
  'a flex item is under the pointer in the order the lines paint it',
  async () => {
    // A flex box in the flow paints its items whole among the lines (CSS
    // Flexbox 5.4), in the document's order with their text and over every
    // block's background. Keyed with the blocks, an item went under the
    // background of a block after it that a negative margin drew up over
    // it, and under the text of a block before it it was drawn over; one
    // that clips its overflow is painted so all the same.
    const { node } = await render(
      '<style>body{margin:0;font:20px/20px monospace}section{height:60px}' +
        '.f{display:flex}.f>div{width:100px;height:40px}' +
        '.m{margin-top:-20px}</style>' +
        // the background of a block after it
        '<section><div class="f"><div id="a1"></div></div>' +
        '<div class="m" id="b1" style="height:40px;background:#0000ff">' +
        '</div></section>' +
        // in a flex box that clips
        '<section><div class="f" style="overflow:hidden;height:40px">' +
        '<div id="a2" style="width:200px"></div></div>' +
        '<div class="m" id="b2" style="height:40px"></div></section>' +
        // the text of a block after it, which is over it
        '<section><div class="f"><div id="a3"></div></div>' +
        '<div class="m"><span id="t3">text</span></div></section>' +
        // and the text of a block before it, which it is over
        '<section><div><span id="t4">text</span></div>' +
        '<div class="f m"><div id="a4"></div></div></section>',
    );
    const el = view(node);
    const { abs } = el as unknown as DrawnNode;
    const at = (x: number, y: number) =>
      el.elementAtPoint(abs.x + x, abs.y + y)?.attribs.id;
    assert.strictEqual(at(50, 30), 'a1', 'over a block’s background');
    assert.strictEqual(at(50, 90), 'a2', 'clipped or not');
    assert.strictEqual(at(10, 150), 't3', 'under the text after it');
    assert.strictEqual(at(10, 190), 'a4', 'over the text before it');
  },
);

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
  'a hovered line through takes its thickness and its style in place',
  async () => {
    // a line through's thickness and style are ink, as an underline's are:
    // nothing moves for them, and the paragraph is not laid out again
    const { result, node } = await render(
      '<style>body{margin:0} del{text-decoration-color:#ff0000}' +
        ' del:hover{text-decoration-thickness:4px;' +
        'text-decoration-style:double}</style>' +
        '<p id="p">Some text with <del id="d">a few words</del> struck.</p>' +
        '<p id="q">Another paragraph.</p>',
      300,
    );
    const el = view(node);
    const quiet = await snapshot(result, el);
    const tree = treeOf(el);

    el.setHover(...pointIn(el, 'd'));
    const hovered = await snapshot(result, el);
    assert.strictEqual(treeOf(el), tree, 'the document was built again');
    assert.ok(bytesApart(hovered, quiet) > 0, 'the hover drew nothing');
    assert.strictEqual(
      bytesApart(hovered, await rebuilt(result, el)),
      0,
      'not the pixels a rebuild draws',
    );

    el.setHover(...pointIn(el, 'q'));
    const left = await snapshot(result, el);
    assert.strictEqual(bytesApart(left, quiet), 0, 'not as it was');
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
  'a hover that pauses an animation is restyled in place, and one that starts one takes the frame it ends on',
  async () => {
    // Zen Garden 219 pauses its marquees under the pointer: the lists of an
    // element's animations draw nothing, and what an animation leaves is in
    // the rest of its style. At rest, where the time is no part of it; the
    // same pause with the animations running is `animations.test.ts`'s
    const { node } = await render(
      '<style>body{margin:0} @keyframes in { to { opacity: .5 } }' +
        ' #m { animation: in 9s infinite linear }' +
        ' #m:hover { animation-play-state: paused }' +
        ' #f:hover { animation: in 1s forwards }</style>' +
        '<p id="m">marquee</p><p id="f">fade</p>',
      300,
      { animate: false },
    );
    const el = view(node);
    const style = (id: string) =>
      (boxOf(el, id) as unknown as { style: ComputedStyle }).style;
    const tree = treeOf(el);
    el.setHover(...pointIn(el, 'm'));
    await act();
    assert.strictEqual(treeOf(el), tree, 'the document was built again');
    assert.deepStrictEqual(style('m').animations.playStates, ['paused']);
    assert.strictEqual(style('m').opacity, 1);

    assert.strictEqual(style('f').opacity, 1);
    el.setHover(...pointIn(el, 'f'));
    await act();
    assert.strictEqual(style('f').opacity, 0.5);
  },
);

metric(
  'an inline box a hover gives a background paints it in place, and one it takes it from does not',
  async () => {
    // the text inside a link keeps the list of decorated boxes around it,
    // which a hover that gives the link its first background changes
    const { result, node } = await render(
      '<style>body{margin:0} a{color:#0000ee} a:hover{background:#ffff00}</style>' +
        '<p>Some text with <a href="#x">a <span id="s">link</span> in it that' +
        ' runs on long enough to wrap onto the next line</a> and more.</p>' +
        '<p id="q">Another paragraph.</p>',
      200,
    );
    const el = view(node);
    const quiet = await snapshot(result, el);
    const tree = treeOf(el);

    el.setHover(...pointIn(el, 's'));
    const hovered = await snapshot(result, el);
    assert.strictEqual(treeOf(el), tree, 'the document was built again');
    assert.notDeepStrictEqual(hovered, quiet, 'the hover drew nothing');
    assert.deepStrictEqual(hovered, await rebuilt(result, el));

    // …and off it, from the document built with the background
    const again = treeOf(el);
    el.setHover(...pointIn(el, 'q'));
    const left = await snapshot(result, el);
    assert.strictEqual(treeOf(el), again, 'the document was built again');
    assert.deepStrictEqual(left, quiet);
    assert.deepStrictEqual(left, await rebuilt(result, el));
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

/** A card over which a hover casts a wide shadow, raises it over the box
 *  that overlaps it, and lifts it — the three things a card grid's hover
 *  does (Zen Garden's list of designs), none of which moves anything else. */
const CARD_PAGE =
  '<style>body{margin:0}' +
  ' .c{position:relative;z-index:1;width:120px;height:60px;margin:30px;' +
  'background:#ffffff;border:1px solid #888888;box-shadow:0 1px 2px #00000044}' +
  ' .c:hover{z-index:2;border-color:#ff0000;' +
  'box-shadow:0 0 24px 6px #0000ff;transform:translateY(-6px)}' +
  ' .o{position:relative;z-index:1;width:120px;height:40px;' +
  'margin:-60px 0 0 90px;background:#00aa00}' +
  ' .s{width:100px;height:20px;background:#cccccc}' +
  ' .s:hover{transform:translateY(-4px)}</style>' +
  '<div class="c" id="c"><span id="t">a card</span></div>' +
  '<div class="o" id="o"></div>' +
  '<div class="s" id="s"><span id="u">plain</span></div>' +
  '<p id="away">away from all of them</p>';

/** How many bytes two snapshots differ in. An assertion on the arrays
 *  themselves diffs them when it fails, and a page of pixels diffed runs
 *  the test process out of memory before it says anything. */
function bytesApart(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = Math.abs(a.length - b.length);
  const end = Math.min(a.length, b.length);
  for (let i = 0; i < end; i += 1) if (a[i] !== b[i]) n += 1;
  return n;
}

metric(
  'a hovered card takes its shadow, its z-index and its lift in place, to the pixels a rebuild draws',
  async () => {
    const { result, node } = await render(CARD_PAGE, 300);
    const el = view(node);
    const quiet = await snapshot(result, el);
    const tree = treeOf(el);

    const [, below] = pointIn(el, 't');
    el.setHover(...pointIn(el, 't'));
    const hovered = await snapshot(result, el);
    assert.ok(treeOf(el) === tree, 'the document was built again');
    assert.ok(bytesApart(hovered, quiet) > 0, 'the hover drew nothing');
    // the text went up with its card
    const [, lifted] = pointIn(el, 't');
    assert.ok(lifted < below, 'the text did not move with its card');
    const whole = await rebuilt(result, el);
    assert.strictEqual(
      bytesApart(hovered, whole),
      0,
      'not as a rebuild draws it',
    );

    // …and off it again, in place, to where it was
    const again = treeOf(el);
    el.setHover(...pointIn(el, 'away'));
    const left = await snapshot(result, el);
    assert.ok(treeOf(el) === again, 'built again to leave the card');
    assert.strictEqual(bytesApart(left, quiet), 0, 'not as it was');
  },
);

metric(
  'a box that a transform would make a containing block is built again',
  async () => {
    const { result, node } = await render(CARD_PAGE, 300);
    const el = view(node);
    const tree = treeOf(el);
    el.setHover(...pointIn(el, 'u'));
    const hovered = await snapshot(result, el);
    assert.ok(treeOf(el) !== tree, 'restyled in place');
    const whole = await rebuilt(result, el);
    assert.strictEqual(
      bytesApart(hovered, whole),
      0,
      'not as a rebuild draws it',
    );
  },
);

metric(
  'a hover that turns a transformed box turns it in place, to the pixels a rebuild draws',
  async () => {
    // an accordion's chevron, a card that grows under the pointer: a
    // transform moves nothing but its box (CSS Transforms 1, 3), so a box
    // transformed before and after is turned where it is — and repainted
    // where it was drawn and where it is drawn now, which are not where it
    // was laid out
    const { result, node } = await render(
      '<style>html{background:#ffffff}body{margin:0}' +
        ' .k{margin:40px;width:60px;height:20px;background:#00aa00;' +
        'transform:rotate(10deg)}' +
        ' .k:hover{transform:rotate(90deg) scale(1.5)}</style>' +
        '<div class="k" id="k"></div><p id="away">away from it</p>',
      300,
    );
    const el = view(node);
    const quiet = await snapshot(result, el);
    const tree = treeOf(el);
    el.setHover(...pointIn(el, 'k'));
    const hovered = await snapshot(result, el);
    assert.ok(treeOf(el) === tree, 'the document was built again');
    assert.ok(bytesApart(hovered, quiet) > 0, 'the hover drew nothing');
    // on its side and half as large again: 30 by 90 about (70, 50)
    const k = el.elementRect(findById(el.document, 'k')!)!;
    assert.deepStrictEqual(
      [k.x, k.y, k.width, k.height].map(Math.round),
      [55, 5, 30, 90],
    );
    assert.strictEqual(
      bytesApart(hovered, await rebuilt(result, el)),
      0,
      'not as a rebuild draws it',
    );
    const again = treeOf(el);
    el.setHover(...pointIn(el, 'away'));
    const left = await snapshot(result, el);
    assert.ok(treeOf(el) === again, 'built again to leave it');
    assert.strictEqual(bytesApart(left, quiet), 0, 'not as it was');
  },
);

metric(
  'a link in a turned box is hovered where it is drawn, and repainted there',
  async () => {
    const { result, node } = await render(
      '<style>html{background:#ffffff}body{margin:0}' +
        ' a{color:#0000ee;text-decoration:none}' +
        ' a:hover{color:#ff0000;text-decoration:underline}' +
        ' .r{margin:60px 0 60px 40px;width:160px;transform:rotate(30deg)}' +
        '</style>' +
        '<div class="r">in a turned box, <a id="a" href="#x">a link</a></div>' +
        '<p id="away">away from it</p>',
      300,
    );
    const el = view(node);
    const quiet = await snapshot(result, el);
    const tree = treeOf(el);
    const a = findById(el.document, 'a');
    // the middle of where the link is drawn is the link's
    const [x, y] = pointIn(el, 'a');
    assert.strictEqual(el.elementAtPoint(x, y), a, 'under the pointer');
    assert.strictEqual(el.hrefAtPoint(x, y), '#x');
    el.setHover(x, y);
    const hovered = await snapshot(result, el);
    assert.ok(treeOf(el) === tree, 'the document was built again');
    assert.ok(bytesApart(hovered, quiet) > 0, 'the hover drew nothing');
    assert.strictEqual(
      bytesApart(hovered, await rebuilt(result, el)),
      0,
      'not as a rebuild draws it',
    );
    el.setHover(...pointIn(el, 'away'));
    assert.strictEqual(
      bytesApart(await snapshot(result, el), quiet),
      0,
      'not as it was',
    );
  },
);

metric(
  'a hover in place repaints what it restyled, not the document',
  async () => {
    const { node } = await render(HOVER_PAGE, 300);
    const el = view(node);
    await act();
    const damage: unknown[] = [];
    const invalidate = el.invalidate.bind(el);
    el.invalidate = ((layout?: boolean, rect?: unknown, reason?: string) => {
      damage.push(rect);
      return invalidate(layout, rect as never, reason);
    }) as typeof el.invalidate;
    el.setHover(...pointIn(el, 's'));
    assert.ok(damage.length > 0, 'something is repainted');
    assert.ok(!damage.includes(el), 'not the whole element');
    // the link's paragraph, where its text is drawn, and no further
    const p = el.elementRect(findById(el.document, 'p')!)!;
    const { abs } = el as unknown as DrawnNode;
    for (const r of damage as { y: number; height: number }[]) {
      assert.ok(
        r.y >= abs.y + p.y - 2,
        `a repaint above the paragraph, ${r.y}`,
      );
      assert.ok(
        r.y + r.height <= abs.y + p.y + p.height + 2,
        'a repaint below the paragraph',
      );
    }
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

test("a :hover in a :has() names the element that holds it, and is no rule's nested pointer", async () => {
  const { pointerCompounds } = await import('../../src/html/css/cascade.js');
  // what iana.org writes, which made every hover on the page build it again
  assert.deepStrictEqual(
    pointerCompounds('#rir-map:has(tr[data-rir]:hover) svg .rir'),
    {
      compounds: [],
      siblings: false,
      nested: false,
      has: [{ anchor: '#rir-map', siblings: false }],
      followed: [],
    },
  );
  // an argument that starts at a sibling reaches the siblings before
  assert.deepStrictEqual(pointerCompounds('h2:has(+ p a:hover)').has, [
    { anchor: 'h2', siblings: true },
  ]);
  // with a :hover of its own too, and whatever else is in the compound
  const both = pointerCompounds('li.x:hover:has(> a:hover)');
  assert.deepStrictEqual(both.compounds, ['li.x']);
  assert.deepStrictEqual(both.has, [{ anchor: 'li.x', siblings: false }]);
  // and one a sibling combinator follows reaches the siblings after
  const followed = pointerCompounds('.a:has(:hover) ~ .b');
  assert.deepStrictEqual(followed.followed, ['.a']);
  assert.strictEqual(followed.siblings, true);
  // a :has() inside another function is the compound's all the same
  assert.deepStrictEqual(pointerCompounds(':not(:has(a:hover))').has, [
    { anchor: '*', siblings: false },
  ]);
});

test('a :hover inside :is(), :where() or :not() names the element it tests', async () => {
  const { pointerCompounds } = await import('../../src/html/css/cascade.js');
  const found = (selector: string) => {
    const { compounds, nested, followed } = pointerCompounds(selector);
    return { compounds, nested, followed };
  };
  // Tailwind 4's `group-hover:` and `peer-hover:`, which every hover on a
  // page written with them built the document again for
  assert.deepStrictEqual(
    found('.group-hover\\:underline:is(:where(.group):hover *)'),
    { compounds: [':where(.group)'], nested: false, followed: [] },
  );
  assert.deepStrictEqual(found('.n:is(:where(.peer):hover ~ *)'), {
    compounds: [':where(.peer)'],
    nested: false,
    followed: [':where(.peer)'],
  });
  // an entry of one compound tests the element it is written on, and is
  // kept as what it asks of it besides: its typography's links, which
  // without the `a` were a compound every element matched
  assert.deepStrictEqual(
    found(
      '.prose :where(a:not([data-card]):hover):not(:where(.not-prose,.not-prose *))',
    ).compounds,
    [':is(a:not([data-card])):not(:where(.not-prose,.not-prose *))'],
  );
  assert.deepStrictEqual(found('a:not(:hover)').compounds, ['a']);
  assert.deepStrictEqual(found('a:is(:hover, :focus) > b').compounds, ['a']);
  // what follows the element a nested selector names follows it
  assert.deepStrictEqual(found(':is(.x .a:hover) ~ .b'), {
    compounds: ['.a'],
    nested: false,
    followed: ['.a'],
  });
  // a `:has()` in one is an anchor, as it is outside
  assert.deepStrictEqual(
    pointerCompounds('.t:is(:where(.peer):has(:hover) ~ *)').has,
    [{ anchor: ':where(.peer)', siblings: false }],
  );
  // an escaped `:hover` in a class name is no pointer's
  assert.deepStrictEqual(
    found('.\\[\\&_a\\:hover\\]\\:underline a:hover').compounds,
    ['a'],
  );
  // and a function this reads no selector list in is left nested
  assert.strictEqual(found('li:nth-child(2 of :hover)').nested, true);
});

test('the focus names the elements it can restyle the way the pointer does', async () => {
  const { FOCUS_STATE, pointerCompounds } =
    await import('../../src/html/css/cascade.js');
  const focus = (selector: string) => pointerCompounds(selector, FOCUS_STATE);
  // Primer's field, whose `:focus` and `:focus-visible` are one compound's
  assert.deepStrictEqual(
    focus('.form-control:focus:not(:focus-visible)').compounds,
    ['.form-control'],
  );
  // Wikipedia's skip link, shown while it has the focus
  assert.deepStrictEqual(focus('.mw-jump-link:not(:focus)').compounds, [
    '.mw-jump-link',
  ]);
  assert.deepStrictEqual(focus('.row:focus-within td').compounds, ['.row']);
  assert.deepStrictEqual(focus('form:has(input:focus) label').has, [
    { anchor: 'form', siblings: false },
  ]);
  // either state's pseudo-classes leave a compound, so what is left
  // matches in any state — the hover's no longer asking for a focus it
  // could not see
  assert.deepStrictEqual(focus('a:focus:hover').compounds, ['a']);
  assert.deepStrictEqual(pointerCompounds('a:focus:hover').compounds, ['a']);
  // and neither state is the other's
  assert.deepStrictEqual(focus('a:hover').compounds, []);
  assert.deepStrictEqual(pointerCompounds('a:focus').compounds, []);
});

/** The colour an element's box has. */
const colourOf = (el: HtmlViewNode, id: string) =>
  (boxOf(el, id) as unknown as { style: { color: string } }).style.color;

/**
 * A hover over `id`, which has to be restyled where it is — the tree it had
 * kept — and come out to the pixels the document built again draws. The
 * rebuild leaves a tree of its own, which the next move is held to.
 */
async function hoverInPlace(
  result: Awaited<ReturnType<typeof render>>['result'],
  el: HtmlViewNode,
  id: string,
): Promise<Uint8ClampedArray> {
  const tree = treeOf(el);
  el.setHover(...pointIn(el, id));
  const drawn = await snapshot(result, el);
  assert.ok(treeOf(el) === tree, `the document was built again over #${id}`);
  assert.strictEqual(
    bytesApart(drawn, await rebuilt(result, el)),
    0,
    `#${id} hovered is not as a rebuild draws it`,
  );
  return drawn;
}

metric(
  'a :hover in :is() restyles where it is: a group, a peer and a link among prose',
  async () => {
    // Tailwind 4 writes `group-hover:`, `peer-hover:` and its typography's
    // links this way, and a page of them built its document again on every
    // move of the pointer: nextjs.org's blog, half a second a move
    const { result, node } = await render(
      '<style>body{margin:0} .t,.n{color:#000000} a{color:#0000ee}' +
        ' .t:is(:where(.group):hover *){color:#ff0000}' +
        ' .n:is(:where(.peer):hover ~ *){color:#00aa00}' +
        ' .prose :where(a:hover):not(:where(.not-prose,.not-prose *))' +
        '{color:#aa00aa}</style>' +
        '<div class="group" id="g"><p>in the group, <span class="t" id="t">' +
        'marked</span></p></div>' +
        '<p class="peer" id="peer">the peer</p><p class="n" id="n">after</p>' +
        '<div class="prose"><p>prose with <a id="a" href="#x">a link</a></p>' +
        '<p class="not-prose">and <a id="na" href="#y">one that is not</a>' +
        '</p></div><p id="away">away from all of them</p>',
      300,
    );
    const el = view(node);
    const quiet = await snapshot(result, el);

    let drawn = await hoverInPlace(result, el, 't');
    assert.ok(bytesApart(drawn, quiet) > 0, 'the group drew nothing');
    assert.strictEqual(colourOf(el, 't'), '#ff0000');

    drawn = await hoverInPlace(result, el, 'peer');
    assert.strictEqual(colourOf(el, 't'), '#000000', 'the group kept it');
    assert.strictEqual(colourOf(el, 'n'), '#00aa00');

    drawn = await hoverInPlace(result, el, 'a');
    assert.strictEqual(colourOf(el, 'n'), '#000000', 'the peer kept it');
    assert.strictEqual(colourOf(el, 'a'), '#aa00aa');

    drawn = await hoverInPlace(result, el, 'na');
    assert.strictEqual(colourOf(el, 'na'), '#0000ee', 'not prose');

    drawn = await hoverInPlace(result, el, 'away');
    assert.strictEqual(bytesApart(drawn, quiet), 0, 'not as it was');
  },
);

metric(
  'a sibling combinator after one compound does not make every hover reach the siblings after it',
  async () => {
    // one `.peer:hover ~ *` in a sheet, and a hover over a row of a long
    // list restyled every row after it — past what is restyled in place
    const rows = Array.from(
      { length: 400 },
      (_, i) => `<li id="r${i}">row ${i}</li>`,
    ).join('');
    const { result, node } = await render(
      '<style>body{margin:0} ul{margin:0;list-style:none}' +
        ' li:hover{background:#ffff00} .peer:hover ~ *{color:#00aa00}</style>' +
        `<ul>${rows}</ul>`,
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const tree = treeOf(el);
    el.setHover(...pointIn(el, 'r3'));
    await snapshot(result, el);
    assert.ok(treeOf(el) === tree, 'a row built the document again');
    const reach = (
      el as unknown as {
        _hoverReach(was: unknown[], now: unknown[]): Set<unknown>;
      }
    )._hoverReach([], [findById(el.document, 'r5')]);
    assert.strictEqual(reach.size, 1, 'a row reaches itself');
  },
);

metric(
  'a link made a flex row, its text in an anonymous box, takes its colour in place',
  async () => {
    // nextjs.org's "read more": the text of a flex container is in a box
    // the fix-up made, which takes what the link's style passes on
    const { result, node } = await render(
      '<style>body{margin:0} a{display:flex;justify-content:center;' +
        'color:#666666;background:#eeeeee} a:hover{color:#000000;' +
        'background:#dddddd}</style>' +
        '<a id="a" href="#x">Read more</a><p id="away">away</p>',
      300,
    );
    const el = view(node);
    const quiet = await snapshot(result, el);
    const drawn = await hoverInPlace(result, el, 'a');
    assert.ok(bytesApart(drawn, quiet) > 0, 'the hover drew nothing');
    assert.strictEqual(
      bytesApart(await hoverInPlace(result, el, 'away'), quiet),
      0,
      'not as it was',
    );
  },
);

metric(
  "a ::before and an ::after take their element's hover in place, and their own",
  async () => {
    const { result, node } = await render(
      '<style>body{margin:0} a{color:#0000ee} a:hover{color:#ff0000}' +
        ' a::after{content:" \\2192"}' +
        ' b::before{content:"* ";color:#888888} b:hover::before{color:#00aa00}' +
        ' i:hover::after{content:" !"}</style>' +
        '<p><a id="a" href="#x">a link</a></p>' +
        '<p><b id="b">bold</b></p><p><i id="i">italic</i></p>' +
        '<p id="away">away</p>',
      300,
    );
    const el = view(node);
    const quiet = await snapshot(result, el);
    // the arrow is the link's colour, which it inherits
    const link = await hoverInPlace(result, el, 'a');
    assert.ok(bytesApart(link, quiet) > 0, 'the link drew nothing');
    // the star is its own rule's, which tests its element's hover: the
    // element's style is what it was, and its `::before`'s is not
    const star = await hoverInPlace(result, el, 'b');
    assert.ok(bytesApart(star, quiet) > 0, 'the star drew nothing');
    assert.ok(bytesApart(star, link) > 0, 'the link kept its hover');
    // content a hover gives an element is a box to build
    const tree = treeOf(el);
    el.setHover(...pointIn(el, 'i'));
    const mark = await snapshot(result, el);
    assert.ok(treeOf(el) !== tree, 'a new box was restyled in place');
    assert.strictEqual(bytesApart(mark, await rebuilt(result, el)), 0);
  },
);

metric(
  'a custom property a hover sets is what the elements under it are styled with afterwards',
  async () => {
    // the card's hover changes nothing the card draws, only what `var()`
    // reads under it; a later move inside the card styles a link from its
    // parent's style, which has to be the one with the hovered value in it
    const { result, node } = await render(
      '<style>body{margin:0} .card{--c:#000000} .card:hover{--c:#ff0000}' +
        ' .x{color:var(--c)} a{color:var(--c);text-decoration:none}' +
        ' a:hover{text-decoration:underline}</style>' +
        '<div class="card" id="card"><p class="x" id="x">text, and ' +
        '<span id="s">a span with <a id="a" href="#x">a link</a></span></p>' +
        '</div><p id="away">away</p>',
      300,
    );
    const el = view(node);
    const quiet = await snapshot(result, el);
    await hoverInPlace(result, el, 'x');
    assert.strictEqual(colourOf(el, 'a'), '#ff0000');
    // without the rebuild between: the styles the first move left
    const tree = treeOf(el);
    el.setHover(...pointIn(el, 'away'));
    el.setHover(...pointIn(el, 'x'));
    el.setHover(...pointIn(el, 'a'));
    const drawn = await snapshot(result, el);
    assert.ok(treeOf(el) === tree, 'the document was built again');
    assert.strictEqual(colourOf(el, 'a'), '#ff0000', 'the link lost it');
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
    assert.strictEqual(
      bytesApart(await hoverInPlace(result, el, 'away'), quiet),
      0,
      'not as it was',
    );
  },
);

/** How many styles the cascade computes while `run` runs. */
async function stylesComputed(
  el: HtmlViewNode,
  run: () => Promise<unknown>,
): Promise<number> {
  const cascade = (el as unknown as { _cascade: Record<string, unknown> })
    ._cascade;
  const compute = cascade._computeStyle as (...args: unknown[]) => unknown;
  let n = 0;
  cascade._computeStyle = function (this: unknown, ...args: unknown[]) {
    n += 1;
    return compute.apply(this, args);
  };
  try {
    await run();
  } finally {
    delete cascade._computeStyle;
  }
  return n;
}

metric(
  'a hover that moves something builds the boxes again with the styles it did not reach kept',
  async () => {
    // bold text is another shape, so the document is built and laid out
    // again — but only the hovered paragraph's style is one to work out:
    // matching every element again was most of such a build
    const paragraphs = Array.from(
      { length: 200 },
      (_, i) =>
        `<div class="c"><p id="p${i}">Paragraph ${i} with <b id="b${i}">` +
        `bold</b> and <a id="a${i}" href="#${i}">a link</a>.</p></div>`,
    ).join('');
    const { result, node } = await render(
      '<style>body{margin:0} p{margin:0} a{color:#0000ee}' +
        ' .c:hover a{color:#ff0000} b{font-weight:normal}' +
        ' b:hover{font-weight:bold}</style>' +
        paragraphs,
      300,
    );
    const el = view(node);
    await snapshot(result, el);

    // onto a paragraph's link, in place: the card's link takes its colour
    await hoverInPlace(result, el, 'a3');
    // then onto the bold in the same card, which is built again, under a
    // card whose hover the styles kept around it still carry
    const tree = treeOf(el);
    let drawn: Uint8ClampedArray = new Uint8ClampedArray();
    const computed = await stylesComputed(el, async () => {
      el.setHover(...pointIn(el, 'b3'));
      drawn = await snapshot(result, el);
    });
    assert.ok(treeOf(el) !== tree, 'bold was restyled in place');
    assert.ok(
      computed > 0 && computed < 10,
      `${computed} styles were worked out for one hovered element`,
    );
    assert.strictEqual(colourOf(el, 'a3'), '#ff0000', 'the card lost it');
    assert.strictEqual(colourOf(el, 'a4'), '#0000ee');
    assert.strictEqual(
      bytesApart(drawn, await rebuilt(result, el)),
      0,
      'not as a build of every style draws it',
    );

    // and to another card's bold: both are styled again, and nothing else
    const again = treeOf(el);
    const next = await stylesComputed(el, async () => {
      el.setHover(...pointIn(el, 'b7'));
      drawn = await snapshot(result, el);
    });
    assert.ok(treeOf(el) !== again, 'bold was restyled in place');
    assert.ok(next < 20, `${next} styles were worked out for two cards`);
    assert.strictEqual(colourOf(el, 'a3'), '#0000ee');
    assert.strictEqual(colourOf(el, 'a7'), '#ff0000');
    assert.strictEqual(bytesApart(drawn, await rebuilt(result, el)), 0);
  },
);

metric(
  'a build that keeps styles does not keep them past a new cascade or a viewport they read',
  async () => {
    const { result, node } = await render(
      '<style>body{margin:0} p{margin:0;width:50vw;background:#cccccc}' +
        ' b{font-weight:normal} b:hover{font-weight:bold}</style>' +
        '<p id="p">Some <b id="b">bold</b> text</p><p id="q">more</p>',
      300,
    );
    const el = view(node);
    await snapshot(result, el);
    const width = () => (boxOf(el, 'q') as unknown as LaidBox).width;
    assert.strictEqual(width(), 150);
    // a hover asks for a build that keeps styles, and before it runs the
    // viewport narrows: `50vw` is a number in the style that was kept
    el.setHover(...pointIn(el, 'b'));
    await result.rerender(
      h(
        'box',
        { style: { width: 200, flexDirection: 'column' } },
        h(Html, {
          source: (el as unknown as { props: { source: string } }).props.source,
          partial: false,
          'data-testname': 'doc',
        }),
      ),
    );
    await snapshot(result, el);
    assert.strictEqual(width(), 100, 'a style kept from another viewport');
  },
);

metric(
  'a :hover in a :has() restyles where it is: the element that holds it, and its siblings',
  async () => {
    const { result, node } = await render(
      '<style>body{margin:0} a{color:#0000ee} .m{color:#000000}' +
        ' #box:has(a:hover) .m{color:#00aa00}' +
        ' #t:has(+ p a:hover){color:#aa0000}</style>' +
        '<div id="box"><p><a id="a" href="#x">a link</a></p>' +
        '<p class="m" id="m">marked</p></div>' +
        '<p id="t">title</p><p><a id="b" href="#y">another link</a></p>',
      300,
    );
    const el = view(node);
    const quiet = await snapshot(result, el);
    const tree = treeOf(el);
    const colour = (id: string) =>
      (boxOf(el, id) as unknown as { style: { color: string } }).style.color;

    el.setHover(...pointIn(el, 'a'));
    const inBox = await snapshot(result, el);
    assert.strictEqual(treeOf(el), tree, 'the document was built again');
    assert.notDeepStrictEqual(inBox, quiet, 'the hover drew nothing');
    assert.strictEqual(colour('m'), '#00aa00');
    assert.deepStrictEqual(inBox, await rebuilt(result, el));

    // to the link after the title: the box's mark back, the title marked
    const again = treeOf(el);
    el.setHover(...pointIn(el, 'b'));
    const after = await snapshot(result, el);
    assert.strictEqual(treeOf(el), again, 'the document was built again');
    assert.strictEqual(colour('m'), '#000000');
    assert.strictEqual(colour('t'), '#aa0000');
    assert.deepStrictEqual(after, await rebuilt(result, el));
  },
);

metric(
  'a hover that repaints a shape in a drawing restyles it where it is',
  async () => {
    // `a:hover svg path { fill }`: the rule's subject is in an inline
    // `<svg>`, which has one box for all of it, so no style of the link's or
    // of the drawing's changes with the pointer — what the rules give its
    // shapes does (`Cascade.shapeStyles`), and the drawing is painted again.
    const icon = (id: string) =>
      `<svg id="${id}" width="20" height="20"><rect width="10" height="20"/>` +
      '<rect class="d" x="10" width="10" height="20" fill="#0000ff"/></svg>';
    const { result, node } = await render(
      '<style>body{margin:0} svg{display:block} a{display:block;width:60px}' +
        ' a:hover svg rect{fill:#ff0000} a:hover .d{fill:#00aa00}' +
        ' .t{color:#ff00ff} .t:hover{color:#00aa00}' +
        ' .t rect{fill:color-mix(in srgb, currentColor, currentColor)}' +
        ' b{font-weight:normal} b:hover{font-weight:bold}</style>' +
        `<a id="a" href="#x">${icon('i')}</a>` +
        `<a id="o" href="#y">${icon('j')}</a>` +
        `<div class="t" id="t">${icon('k')}</div>` +
        // the pointer leaves for `#w`: the paragraph's middle is `<b>` in
        // some faces, and a bold `<b>` builds the document again
        '<p id="q"><span id="w">A paragraph with</span> <b id="b">bold</b>' +
        ' in it.</p>',
      300,
    );
    const el = view(node);
    const quiet = await snapshot(result, el);
    const { abs } = el as unknown as DrawnNode;
    const pixel = (x: number, y: number, colour: string, message: string) =>
      expectPixel(result.ctx, abs.x + x, abs.y + y, colour, { message });
    await pixel(5, 10, '#000000', 'no rule yet');
    await pixel(15, 10, '#0000ff', 'its own attribute');
    await pixel(5, 50, '#ff00ff', "the drawing's colour");

    const hovered = await hoverInPlace(result, el, 'i');
    assert.ok(bytesApart(hovered, quiet) > 0, 'the hover drew nothing');
    await pixel(5, 10, '#ff0000', 'the hovered link, any shape');
    await pixel(15, 10, '#00aa00', 'and the one a closer rule names');
    await pixel(5, 30, '#000000', 'the other link is as it was');

    // to the other link, and off both
    await hoverInPlace(result, el, 'j');
    await pixel(5, 10, '#000000', 'the link the pointer left');
    await pixel(15, 10, '#0000ff', 'and its other shape');
    await pixel(5, 30, '#ff0000', 'the one it went to');
    // a drawing whose own colour the hover changes, which its shapes read
    await hoverInPlace(result, el, 'k');
    await pixel(5, 30, '#000000', 'the second link, left');
    await pixel(5, 50, '#00aa00', 'currentColor, hovered');
    const left = await hoverInPlace(result, el, 'w');
    assert.strictEqual(bytesApart(left, quiet), 0, 'not as it was before');

    // A hover that moves something builds the boxes again, and each
    // drawing's shapes are asked for again as its new box is painted.
    await hoverInPlace(result, el, 'i');
    const tree = treeOf(el);
    el.setHover(...pointIn(el, 'b'));
    const bold = await snapshot(result, el);
    assert.ok(treeOf(el) !== tree, 'bold was restyled in place');
    await pixel(5, 10, '#000000', 'the link the pointer left, built again');
    await pixel(5, 50, '#ff00ff', 'a drawing the move did not reach');
    assert.strictEqual(bytesApart(bold, await rebuilt(result, el)), 0);
  },
);

metric(
  "a hover reaches a sprite's icon through what its <use> hands the copy",
  async () => {
    // A copy's tree has nothing above what the `<use>` names (SVG 2,
    // 5.5.3), so `a:hover .p` never reaches a sprite's shape, hovered or
    // not, as in Chrome. What the copy inherits from the `<use>` does, and
    // the `<use>` is in the drawing the hovered link holds.
    const { result, node } = await render(
      '<style>body{margin:0} svg{display:block} a{display:block;width:60px}' +
        ' a:hover .p{fill:#ff0000} .q{fill:inherit} a:hover use{fill:#00aa00}' +
        '</style><svg style="display:none"><symbol id="s" viewBox="0 0 20 20">' +
        '<rect class="p" width="10" height="20" fill="#000000"/>' +
        '<rect class="q" x="10" width="10" height="20"/></symbol></svg>' +
        '<a id="a" href="#x"><svg width="20" height="20"><use href="#s"/></svg></a>' +
        '<p id="w">elsewhere</p>',
      300,
    );
    const el = view(node);
    const quiet = await snapshot(result, el);
    const { abs } = el as unknown as DrawnNode;
    const pixel = (x: number, y: number, colour: string, message: string) =>
      expectPixel(result.ctx, abs.x + x, abs.y + y, colour, { message });
    await pixel(5, 10, '#000000', 'not hovered');
    await pixel(15, 10, '#000000', 'nothing to inherit yet');

    const hovered = await hoverInPlace(result, el, 'a');
    assert.ok(bytesApart(hovered, quiet) > 0, 'the hover drew nothing');
    await pixel(
      5,
      10,
      '#000000',
      "a rule of the link's for the sprite's shape",
    );
    await pixel(15, 10, '#00aa00', 'what the copy inherits from the <use>');
    const left = await hoverInPlace(result, el, 'w');
    assert.strictEqual(bytesApart(left, quiet), 0, 'not as it was before');
  },
);

metric(
  'a hover waits for a scroll to stop, and follows a move of the pointer at once',
  async (t) => {
    // Core asks what is under a still pointer after every frame that moved
    // the content (react-x11#793), which while a document scrolls is every
    // frame: a restyle a frame, and on a page whose hover moves something,
    // the boxes built again a frame — 4 frames a second where 52 were drawn
    // with the pointer off the page. The hover is held until the content
    // has been still a tenth of a second, as a browser holds its own.
    const clock = holdClock(t, hoverClock);
    const rows = Array.from(
      { length: 40 },
      (_, i) => `<p id="r${i}">row ${i}</p>`,
    ).join('');
    const pane = React.createRef<
      DrawnNode & { scrollTo(to: { y: number }): void }
    >();
    await renderX11(
      h(
        'box',
        { ref: pane, style: { width: 400, height: 200, overflow: 'scroll' } },
        h(Html, {
          source:
            '<style>body{margin:0} p{margin:0;height:40px}' +
            ` p:hover{background:#ffff00}</style>${rows}`,
          partial: false,
          'data-testname': 'doc',
        }),
      ),
      { width: 440, height: 240, fonts: FONTS! },
    );
    await act();
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const hovered = () =>
      (el as unknown as { _hovered: { attribs: { id?: string } }[] })
        ._hovered[0]?.attribs.id;
    const under = () => {
      const { abs } = pane.current!;
      return el.elementAtPoint(abs.x + abs.width / 2, abs.y + abs.height / 2)
        ?.attribs.id;
    };
    const frames = async (n: number) => {
      for (let i = 0; i < n; i += 1) await clock.frame();
    };

    // the pointer to the middle of the pane, over the third row
    fireEvent.mouseMove(pane.current!, { dx: 0, dy: 0 });
    await waitFor(() => assert.strictEqual(hovered(), 'r2'));
    assert.ok(!clock.pending, 'a move of the pointer waited');

    // two rows scroll by under it: it is over the fifth, which is not
    // hovered until the scroll has stopped
    await act(async () => pane.current!.scrollTo({ y: 80 }));
    assert.strictEqual(under(), 'r4');
    assert.strictEqual(hovered(), 'r2', 'the hover followed the scroll');
    assert.ok(clock.pending, 'nothing waits to ask again');

    // and two more before the tenth of a second is up, which puts it off
    await frames(3);
    await act(async () => pane.current!.scrollTo({ y: 160 }));
    await frames(4);
    assert.strictEqual(hovered(), 'r2', 'asked while the content moved');
    await frames(3);
    assert.strictEqual(hovered(), 'r6', 'not asked once it had stopped');
    assert.ok(!clock.pending, 'a timer left running');

    // held again by another scroll, a move of the pointer is answered
    await act(async () => pane.current!.scrollTo({ y: 240 }));
    assert.strictEqual(hovered(), 'r6');
    fireEvent.mouseMove(pane.current!, { dx: 0, dy: 40 });
    await waitFor(() => assert.strictEqual(hovered(), 'r9'));
    assert.ok(!clock.pending, 'the held hover outlived the move');

    // and one that leaves takes what it held with it
    await act(async () => pane.current!.scrollTo({ y: 320 }));
    assert.ok(clock.pending);
    (
      el as unknown as { defaultMouseLeave(ev: unknown): void }
    ).defaultMouseLeave({});
    assert.strictEqual(hovered(), undefined);
    assert.ok(!clock.pending, 'a hover held for a pointer that left');
  },
);

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
      // its file again to quote the expression — seconds a try in one
      // this long, so the first try (the motion lands an `act()` later) ran the
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
