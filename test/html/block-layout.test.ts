// <Html> — block layout: margins and how they collapse, sizes, and the width
// content gives a box.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { cleanup } from 'react-x11/test';
import type { FontsLike } from '../../src/html/layout/inline.js';
import { boxOf, metric, render, renderWithBytes, view } from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

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

test("a last child's margin collapses through a percentage height of an auto height, and not a definite one", async () => {
  // a percentage of a height that depends on content computes to `auto`
  // (CSS 2.1 10.5), and a last child's bottom margin collapses through a
  // parent of `auto` height (8.3.1): a `height: 100%` page wrapper in an
  // `auto` body kept its last child's margin inside it, a design 100px
  // taller than a browser sets it
  const { node } = await render(
    '<style>body{margin:0}p{margin:0 0 30px;height:10px}' +
      '.w{height:100%}</style>' +
      '<div class="w" id="w"><p></p><p></p></div><div id="n">next</div>' +
      '<div style="height:200px"><div class="w" id="d"><p></p></div></div>',
  );
  const el = view(node);
  const box = (id: string) => boxOf(el, id);
  assert.strictEqual(box('w').height, 50, 'the margin collapses through');
  assert.strictEqual(box('n').y, 80, 'and is after the wrapper');
  assert.strictEqual(box('d').height, 200, 'a definite 100% is the height');
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
    const { buildBoxes } = await import('../../src/html/layout/boxes.js');
    const { layoutDocument } = await import('../../src/html/layout/block.js');
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
