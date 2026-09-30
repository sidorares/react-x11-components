// <Html> — the pointer: what is under it, the cursor, and a hover restyled in
// place.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
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
  // a :has() inside another function is not the compound's own
  assert.strictEqual(pointerCompounds(':not(:has(a:hover))').nested, true);
  assert.strictEqual(pointerCompounds('a:not(:hover)').nested, true);
});

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
