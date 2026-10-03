// <Html> — selection, the caret and the text accessors.
import { afterEach } from 'node:test';
import assert from 'node:assert';
import {
  act,
  cleanup,
  fireEvent,
  isNear,
  pixelAt,
  renderX11,
  screen,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { HtmlViewNode } from '../../src/html/index.js';
import { cocoaShapedLayout } from '../cocoa-shaped.js';
import type { ShapedLayout } from '../cocoa-shaped.js';
import {
  FONTS,
  boxOf,
  drawnText,
  h,
  linesOf,
  metric,
  render,
  textRunsOf,
  view,
} from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

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

// What a press starts a selection in is what is drawn on top under it, as
// in every browser: Zen Garden 220 draws its preamble over a fixed
// `::before` of "Est. 2003" in letters 500px tall, and a press on a
// paragraph selected from the word behind it.
// An element here, where 220's is generated, whose text no selection takes.
const behind = (extra = '') =>
  '<style>body{margin:0}' +
  '#banner{position:relative;height:20px}' +
  '#big{position:absolute;top:0;left:0;' +
  'font-size:200px;line-height:1;color:rgba(0,0,0,.15)}' +
  '#article{position:relative}p{margin:0 0 20px}' +
  extra +
  '</style><div id="banner"><div id="big">BIG</div></div><div id="article">' +
  '<p id="a">first paragraph words</p>' +
  '<p id="b">second paragraph words</p></div>';

/** Where in the document a press on a letter of a word lands. */
function pressOn(el: HtmlViewNode, word: string): number {
  const caret = el.textCaretRect(el.textContent().indexOf(word) + 2)!;
  return el.textIndexAt(caret.x + 1, caret.y + caret.height / 2);
}

metric(
  'a press on text drawn over larger text starts in the text on top',
  async () => {
    const { node } = await render(behind());
    const el = view(node);
    const text = el.textContent();
    assert.ok(text.startsWith('BIG'), `the word behind is text: ${text}`);
    const second = text.indexOf('second');
    const at = pressOn(el, 'second');
    assert.ok(Math.abs(at - (second + 2)) <= 1, `in "second": ${at}`);
  },
);

metric(
  'a press between paragraphs is in the text of the box on top, not of the word behind it',
  async () => {
    // Blink and Gecko alike: the box the point is over, and the text in it
    // nearest the point
    const { node } = await render(behind());
    const el = view(node);
    const text = el.textContent();
    const a = boxOf(el, 'a');
    const b = boxOf(el, 'b');
    const { abs } = el as unknown as DrawnNode;
    const at = el.textIndexAt(abs.x + 30, abs.y + (a.y + a.height + b.y) / 2);
    assert.ok(at >= text.indexOf('first'), `in the article's: ${at}`);
  },
);

metric('the word drawn on top takes the press where it is on top', async () => {
  // the order is the paint order, not a preference for the later box
  const { node } = await render(behind('#big{z-index:1}'));
  const el = view(node);
  assert.ok(pressOn(el, 'second') <= 3, 'in "BIG", over the paragraph');
});

metric(
  'text the pointer passes through is not where a press starts',
  async () => {
    // `pointer-events: none` (CSS UI 4, 6.2): as if it were not there
    const { node } = await render(behind('#article{pointer-events:none}'));
    const el = view(node);
    assert.ok(pressOn(el, 'second') <= 3, 'in "BIG", under the paragraph');
  },
);

metric(
  'a press on a box with no text drawn over text is where the box stands in the document',
  async () => {
    // Blink's position in the element pressed: no letter of the text it
    // covers, and none of the text nearest it in the document
    const { node } = await render(
      '<style>body{margin:0}p{margin:0}#cover{position:absolute;top:0;' +
        'left:0;width:300px;height:40px}</style>' +
        '<p>one two</p><div id="cover"></div><p>three</p>',
    );
    const el = view(node);
    assert.strictEqual(el.textContent(), 'one twothree');
    assert.strictEqual(pressOn(el, 'two'), 7, 'after the text before it');
  },
);

metric(
  'a press on text fixed to the viewport is where the scroll draws it',
  async () => {
    // "Est. 2003" is fixed: scrolled, the word is drawn down the document
    // from where it was laid out, and the article scrolls up over it
    await renderX11(
      h(
        'box',
        {
          'data-testname': 'pane',
          style: { width: 400, height: 200, overflow: 'scroll' },
        },
        h(Html, {
          source: behind(
            '#big{position:fixed}#article{margin-top:300px}' +
              '#tall{height:1000px}',
          ).replace('</p></div>', '</p><div id="tall"></div></div>'),
          partial: false,
          'data-testname': 'doc',
        }),
      ),
      { width: 440, height: 300, fonts: FONTS! },
    );
    const pane = screen.getByTestName('pane') as DrawnNode & {
      scrollTo(y: number): void;
    };
    await act(async () => pane.scrollTo(250));
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const text = el.textContent();
    // above the article, the word is all the pane draws
    const above = el.textIndexAt(pane.abs.x + 30, pane.abs.y + 30);
    assert.ok(above <= 3, `in "BIG", where the pane draws it: ${above}`);
    const first = text.indexOf('first');
    const caret = el.textCaretRect(first + 2)!;
    assert.ok(
      caret.y > pane.abs.y + 30 && caret.y < pane.abs.y + 150,
      `the paragraph is in view, over the word: ${caret.y - pane.abs.y}`,
    );
    const at = el.textIndexAt(caret.x + 1, caret.y + caret.height / 2);
    assert.ok(Math.abs(at - (first + 2)) <= 1, `in "first": ${at}`);
    // and the word's caret and bands are where the pane draws it, too
    const big = el.textCaretRect(1)!;
    assert.ok(
      Math.abs(big.y - pane.abs.y) < 1,
      `the caret at the viewport's top: ${big.y - pane.abs.y}`,
    );
    // over the glyphs, which reach past a line at `line-height: 1`
    const [band] = el.textRangeRects(0, 3);
    assert.ok(
      band.y <= big.y && big.y - band.y < 20,
      `the band there with it: ${band.y - pane.abs.y}`,
    );
  },
);

// What `user-select: none` keeps out of a selection — and what `auto` is on
// a `::before` or an `::after`, whose text no browser selects or copies
// (CSS UI 4, 6.1) — is no part of the text the selection is made of.

metric(
  'a selection takes no generated text, and none that user-select: none keeps out',
  async () => {
    const { node } = await render(
      '<style>p{margin:0}#n{user-select:none}#w{-webkit-user-select:none}' +
        '#back{user-select:text}#ok::before{content:"[gen] ";' +
        'user-select:text}</style>' +
        '<p><q>quoted</q> plain <span id="n">none <b>inner</b> ' +
        '<i id="back">back</i></span> <span id="w">webkit</span> end</p>' +
        '<p id="ok">opted</p>',
    );
    const el = view(node);
    assert.ok(drawnText(el).includes('\u201cquoted\u201d'), 'drawn, quotes');
    // `<q>`'s quotes are generated; inside `none`, `auto` is none and
    // `text` takes it back; a rule may make a `::before` selectable
    assert.strictEqual(el.textContent(), 'quoted plain back  end[gen] opted');
    await act(async () => {
      fireEvent.mouseDown(node, {});
      fireEvent.mouseUp(node, {});
    });
    await act(async () => {
      fireEvent.key(0x61 /* a */, { modifiers: ['Control'] });
    });
    assert.strictEqual(node.selectedText(), el.textContent(), 'a copy');
  },
);

metric(
  'the highlight leaves out the text a selection cannot take',
  async () => {
    const { node, result } = await render(
      '<style>body{margin:0;font-size:20px}p{margin:0}' +
        'p::before{content:"GEN "}</style><p id="p">text</p>',
      400,
      { selectionColor: '#00ff00' },
    );
    const el = view(node);
    await act(async () => {
      fireEvent.mouseDown(node, {});
      fireEvent.mouseUp(node, {});
    });
    await act(async () => {
      fireEvent.key(0x61 /* a */, { modifiers: ['Control'] });
    });
    assert.strictEqual(node.selectedText(), 'text');
    // the selection's first letter is the paragraph's own, past "GEN "
    const start = el.textCaretRect(0)!;
    const { abs } = el as unknown as DrawnNode;
    assert.ok(start.x - abs.x > 20, `past the generated text: ${start.x}`);
    const lit = (x: number) => pixelAt(result.ctx, x, start.y + 1);
    assert.ok(
      isNear(await lit(start.x + 10), '#00ff00', 40),
      'its text is lit',
    );
    assert.ok(
      !isNear(await lit(abs.x + 4), '#00ff00', 40),
      'the generated text is not',
    );
    const [band] = el.textRangeRects(0, 4);
    assert.ok(band.x >= start.x - 0.5, `nor in its bands: ${band.x}`);
  },
);

metric('selected text no one can see is neither lit nor drawn', async () => {
  // Zen Garden 220 hides its headings under the `::after`s it shows: a
  // selection set each in the `::selection`'s colour over its `::after`
  const { node, result } = await render(
    '<style>body{margin:0;font-size:20px}p{margin:0}#h{visibility:hidden}' +
      '::selection{background:#00ff00;color:#ff0000}</style>' +
      '<p>shown <span id="h">HIDDEN</span> shown</p>',
  );
  const el = view(node);
  await act(async () => {
    fireEvent.mouseDown(node, {});
    fireEvent.mouseUp(node, {});
  });
  await act(async () => {
    fireEvent.key(0x61 /* a */, { modifiers: ['Control'] });
  });
  const text = el.textContent();
  const from = el.textCaretRect(text.indexOf('HIDDEN'))!;
  const to = el.textCaretRect(text.indexOf('HIDDEN') + 6)!;
  const lit = await pixelAt(result.ctx, from.x - 20, from.y + 2);
  assert.ok(isNear(lit, '#00ff00', 40), `the text around it is lit: ${lit}`);
  for (let x = from.x + 1; x < to.x - 1; x += 3) {
    for (let y = from.y + 1; y < from.y + from.height - 1; y += 3) {
      const rgb = await pixelAt(result.ctx, x, y);
      assert.ok(
        !isNear(rgb, '#00ff00', 60) && !isNear(rgb, '#ff0000', 60),
        `nothing of it at ${x},${y}: ${rgb}`,
      );
    }
  }
});

metric(
  'a press on generated text starts no selection, and keeps the one there is',
  async () => {
    // Blink's `CanStartSelection`: a toolbar's button pressed with a
    // paragraph selected leaves the paragraph selected
    const { node } = await render(
      '<style>body{margin:0}p{margin:0 0 20px}' +
        '#g::before{content:"GENERATED "}</style>' +
        '<p>one two three</p><p id="g">four</p>',
    );
    const el = view(node);
    const target = el as unknown as DrawnNode;
    const offset = (x: number, y: number) => ({
      dx: x - (target.abs.x + target.abs.width / 2),
      dy: y - (target.abs.y + target.abs.height / 2),
    });
    const a = el.textCaretRect(0)!;
    const b = el.textCaretRect(7)!;
    const from = offset(a.x + 1, a.y + a.height / 2);
    const to = offset(b.x - 1, b.y + b.height / 2);
    await act(async () => {
      fireEvent.mouseMove(target, from);
      fireEvent.mouseDown(target, from);
      fireEvent.mouseMove(target, to);
      fireEvent.mouseUp(target);
    });
    const selected = node.selectedText();
    assert.ok(selected.startsWith('one tw'), `a drag selects: ${selected}`);
    // a press on "GENERATED ", and a drag from it across "four"
    const four = el.textCaretRect(el.textContent().indexOf('four'))!;
    const y = four.y + four.height / 2;
    const on = offset((target.abs.x + four.x) / 2, y);
    await act(async () => {
      fireEvent.mouseMove(target, on);
      fireEvent.mouseDown(target, on);
      fireEvent.mouseMove(target, offset(four.x + 20, y));
      fireEvent.mouseUp(target);
    });
    assert.strictEqual(node.selectedText(), selected, 'the selection stays');
  },
);

metric(
  'a press nearest text no one can see lands in the text that is seen',
  async () => {
    // Blink passes over a box that is not visible (`IsHitTestCandidate`)
    const { node } = await render(
      '<style>body{margin:0}#box{padding:40px 0}p{margin:0}' +
        '#h{visibility:hidden}</style>' +
        '<div id="box"><p id="h">hidden words</p><p>shown words</p></div>',
    );
    const el = view(node);
    const { abs } = el as unknown as DrawnNode;
    const at = el.textIndexAt(abs.x + 10, abs.y + 5);
    const shown = el.textContent().indexOf('shown');
    assert.ok(at >= shown, `in "shown words": ${at}`);
  },
);

metric(
  'generated text a hidden element shows is under the pointer',
  async () => {
    // Zen Garden 220 hides its headings and shows each one's `::after`
    const { node } = await render(
      '<style>body{margin:0}h3{visibility:hidden;margin:0}' +
        'h3::after{content:" Shown";visibility:visible}</style>' +
        '<h3 id="h">Hidden</h3>',
    );
    const el = view(node);
    const [line] = linesOf(el, 'h');
    const runs = textRunsOf(line);
    const [left, right] = runs[runs.length - 1];
    const { abs } = el as unknown as DrawnNode;
    const x = abs.x + (left + right) / 2;
    const y = abs.y + line.y + line.height / 2;
    assert.strictEqual(el.elementAtPoint(x, y)?.attribs.id, 'h');
    assert.strictEqual(el.cursorAt(x, y), 'text');
    const hidden = abs.x + runs[0][0] + 2;
    assert.strictEqual(
      el.cursorAt(hidden, y),
      'default',
      'not the hidden text before it',
    );
  },
);

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

    const { paintDocument } = await import('../../src/html/paint.js');
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

/** A document of one heading whose glyphs are far taller than its lines —
 *  a 90px face on 20px lines, Zen Garden 215's title — painted straight
 *  into a context that records what it is asked to draw. */
async function tallGlyphs(extra = '') {
  const { node } = await render(
    '<style>body{margin:0}h1{font:bold 90px/20px sans-serif;margin:0}' +
      `${extra}</style><div style="padding-top:100px"><h1 id="t">MMM</h1></div>`,
  );
  const el = view(node);
  const tree = (el as unknown as { _tree: never })._tree as {
    root: LaidBox & {
      lines: { texts: { layout: { draw(): void } }[] }[] | null;
    };
  };
  const inked: number[] = [];
  const patch = (box: typeof tree.root): void => {
    for (const line of box.lines ?? []) {
      for (const text of line.texts) text.layout.draw = () => inked.push(1);
    }
    for (const child of box.children) patch(child as typeof box);
  };
  patch(tree.root);
  const fills: { color: unknown; x: number; y: number; h: number }[] = [];
  let fillStyle: unknown = null;
  const ctx = {
    set fillStyle(v: unknown) {
      fillStyle = v;
    },
    get fillStyle() {
      return fillStyle;
    },
    save() {},
    restore() {},
    fillRect(x: number, y: number, _w: number, h: number) {
      fills.push({ color: fillStyle, x, y, h });
    },
  };
  const { paintDocument } = await import('../../src/html/paint.js');
  const paint = (
    damage: { x: number; y: number; width: number; height: number } | null,
    selection: { start: number; end: number } | null = null,
  ) => {
    inked.length = 0;
    fills.length = 0;
    paintDocument(ctx as never, tree as never, {
      originX: 0,
      originY: 0,
      damage,
      selection,
      selectionColor: selection ? '#ff0000' : null,
      imageFor: () => null,
    });
    return { inked: inked.length, fills: [...fills] };
  };
  return { el, h1: boxOf(el, 't'), paint };
}

metric(
  'glyphs taller than their line are drawn where a repaint meets them',
  async () => {
    // A line box is its line-height, whatever its glyphs are (CSS 2.1
    // 10.8.1), so a 90px face on 20px lines hangs past them by 40px each
    // way. A repaint of the rows over the line — the strip a scroll of a few
    // pixels exposes — met no line and no box, and the tops of Zen Garden
    // 215's title stayed unpainted.
    const { h1, paint } = await tallGlyphs();
    assert.strictEqual(h1.height, 20, 'the line is its line-height');
    assert.ok(paint(null).inked > 0, 'a full paint draws the text');
    const strip = (y: number) => ({ x: 0, y, width: 400, height: 8 });
    assert.ok(paint(strip(h1.y - 30)).inked > 0, 'above the line');
    assert.ok(paint(strip(h1.y + 40)).inked > 0, 'below the line');
    assert.strictEqual(
      paint(strip(h1.y - 90)).inked,
      0,
      'but not past the ascent',
    );
  },
);

metric(
  'glyphs taller than their line are drawn from an inline-block too',
  async () => {
    // the title is an inline-block on its header's line in 215: the header's
    // line holds the block's margin box, and the block its own lines
    const { h1, paint } = await tallGlyphs('h1{display:inline-block}');
    assert.ok(
      paint({ x: 0, y: h1.y - 30, width: 400, height: 8 }).inked > 0,
      'above the line',
    );
  },
);

metric(
  'a selection over glyphs taller than their line covers the glyphs',
  async () => {
    // Blink unites a text's content area with its line box in the block
    // direction (`ExpandSelectionRectToLineHeight`): a band over tall glyphs
    // on a short line covers them, as Chrome's does, where ours was the 20px
    // line through the middle of 90px letters
    const { el, h1, paint } = await tallGlyphs();
    const bands = paint(null, { start: 0, end: 2 }).fills.filter(
      (f) => f.color === '#ff0000',
    );
    assert.strictEqual(bands.length, 1, 'one band');
    assert.ok(
      bands[0].y < h1.y - 30,
      `it starts above the line: ${bands[0].y}`,
    );
    assert.ok(
      bands[0].y + bands[0].h > h1.y + h1.height + 15,
      `and ends below it: ${bands[0].y + bands[0].h}`,
    );
    // and the rects the selection seam reports are the ones painted
    const rects = el.textRangeRects(0, 2);
    const abs = (el as unknown as { abs: { y: number } }).abs;
    assert.strictEqual(rects.length, 1);
    assert.strictEqual(Math.round(rects[0].y - abs.y), bands[0].y);
  },
);

metric(
  'a selection over a line taller than its glyphs fills the line',
  async () => {
    const { node } = await render(
      '<style>body{margin:0}p{font:16px/60px sans-serif;margin:0}</style>' +
        '<p id="p">tall line</p>',
    );
    const el = view(node);
    const p = boxOf(el, 'p');
    const rects = el.textRangeRects(0, 4);
    const abs = (el as unknown as { abs: { y: number } }).abs;
    assert.strictEqual(rects.length, 1);
    // to a hundredth: a line at a fractional top comes back from its own
    // bottom a rounding off its height
    assert.ok(Math.abs(rects[0].y - abs.y - p.y) < 0.01, `at ${rects[0].y}`);
    assert.ok(Math.abs(rects[0].height - 60) < 0.01, `${rects[0].height}`);
  },
);

/** A document painted with its text selected from `start` to `end`, into a
 *  context that records each fill's colour and, for each layout drawn, the
 *  shadow it was cast in — how `drawRecolored` sets selected text in a
 *  `::selection`'s colour. */
async function paintSelected(source: string, start: number, end?: number) {
  const { node } = await render(source);
  const el = view(node);
  const tree = (el as unknown as { _tree: never })._tree as {
    root: LaidBox & {
      lines: { texts: { layout: { draw(): void } }[] }[] | null;
    };
  };
  const state = { fillStyle: null as unknown, shadowColor: '' };
  const fills: string[] = [];
  const casts: string[] = [];
  const patch = (box: typeof tree.root): void => {
    for (const line of box.lines ?? []) {
      for (const text of line.texts) {
        text.layout.draw = () => casts.push(state.shadowColor);
      }
    }
    for (const child of box.children) patch(child as typeof box);
  };
  patch(tree.root);
  const saved: string[] = [];
  const ctx = {
    set fillStyle(v: unknown) {
      state.fillStyle = v;
    },
    get fillStyle() {
      return state.fillStyle;
    },
    set shadowColor(v: string) {
      state.shadowColor = v;
    },
    get shadowColor() {
      return state.shadowColor;
    },
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    save() {
      saved.push(state.shadowColor);
    },
    restore() {
      state.shadowColor = saved.pop() ?? '';
    },
    beginPath() {},
    rect() {},
    clip() {},
    fillRect() {
      fills.push(String(state.fillStyle));
    },
  };
  const { paintDocument } = await import('../../src/html/paint.js');
  const length = (el as unknown as { _tree: { text: string } })._tree.text
    .length;
  paintDocument(ctx as never, tree as never, {
    originX: 0,
    originY: 0,
    damage: null,
    selection: { start, end: end ?? length },
    selectionColor: '#abcdef',
    imageFor: () => null,
  });
  return { fills, casts };
}

metric('a ::selection colours the band under the text it covers', async () => {
  // CSS Pseudo 4, 3.2: its background under the selected text and its
  // colour for the text, where the palette's highlight was all there was.
  // Along the chain of highlights (3.5), as Chrome draws it: the span has
  // no rule and is its div's, and the paragraph's own rule sets a colour
  // and keeps its div's background. A rule that sets only a colour sets no
  // band (3.6, paired defaults), and text no rule reaches is the palette's
  const { fills, casts } = await paintSelected(
    '<style>body{margin:0}div::selection{background:#ff0000;color:#ffffff}' +
      'p::selection{color:#00aa00}section::selection{color:#0000ff}' +
      'p,section,article{margin:0}</style>' +
      '<div>a <span>b</span><p>c</p></div><section>d</section>' +
      '<article>e</article>',
    0,
  );
  const red = fills.filter((f) => /^(#ff0000|rgb\(255, 0, 0\))$/i.test(f));
  assert.strictEqual(red.length, 2, `the div's line and the p's: ${fills}`);
  assert.strictEqual(
    fills.filter((f) => f === '#abcdef').length,
    1,
    `the article's is the palette's: ${fills}`,
  );
  assert.strictEqual(fills.length, 3, `and the section has none: ${fills}`);
  const cast = (re: RegExp) => casts.some((c) => re.test(c));
  assert.ok(cast(/^(#ffffff|#fff|rgb\(255, 255, 255\))$/i), `white: ${casts}`);
  assert.ok(cast(/^(#00aa00|rgb\(0, 170, 0\))$/i), `green: ${casts}`);
  assert.ok(cast(/^(#0000ff|rgb\(0, 0, 255\))$/i), `blue: ${casts}`);
});

metric(
  'text no ::selection reaches is drawn once, in its own colours',
  async () => {
    // a document with no rule for one asks nothing: no clip, no cast
    const { fills, casts } = await paintSelected(
      '<style>body{margin:0}</style><p>plain text</p>',
      0,
    );
    assert.deepStrictEqual(fills, ['#abcdef'], 'the palette band');
    assert.deepStrictEqual(casts, [''], 'one draw, cast in nothing');
  },
);
