// <Html> — painting: order, opacity, masks, the pixel grid, and documents too
// long to draw whole.
import { afterEach, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import {
  act,
  cleanup,
  expectPixel,
  isNear,
  pixelAt,
  renderX11,
  screen,
  waitFor,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { parseColor } from '../../src/html/css/values.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import {
  FONTS,
  SVG_NS,
  atScale2,
  boxOf,
  fillsOf,
  h,
  metric,
  pixelsIn,
  render,
  render2x,
  renderWithBytes,
  svgBytes,
  view,
} from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

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

    const { paintDocument } = await import('../../src/html/paint.js');
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

test('an element at no opacity is not drawn, and at half is drawn faded', async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  // `opacity` was read and never painted, so the control a page keeps at
  // `opacity: 0` until its row is hovered — meetup.com's "Homepage" behind
  // its logo, the share button on each event card — was drawn over what it
  // hides. At 0 nothing in the element is drawn, a positioned child
  // included; between, each thing drawn is multiplied by it.
  const result = await renderX11(
    h(
      'box',
      { style: { width: 200, flexDirection: 'column' } },
      h(Html, {
        source:
          '<body style="margin:0;background:#ffffff">' +
          '<div style="opacity:0;height:20px;background:#ff0000">' +
          '<div style="position:absolute;left:40px;top:0;width:20px;' +
          'height:20px;background:#0000ff"></div></div>' +
          '<div style="opacity:0.5;height:20px;background:#ff0000"></div>' +
          '</body>',
        partial: false,
      }),
    ),
    { width: 240, height: 100, fonts: FONTS },
  );
  await expectPixel(result.ctx, 10, 10, '#ffffff', {
    message: 'the transparent block is not drawn',
  });
  await expectPixel(result.ctx, 50, 10, '#ffffff', {
    message: 'nor its positioned child',
  });
  await expectPixel(result.ctx, 10, 30, '#ff8080', {
    tolerance: 3,
    message: 'the half-opaque block is its colour at half over the page',
  });
});

test('a block inside an inline element is faded with it', async (t) => {
  if (!FONTS) return t.skip('no font files for the in-process server');
  // CSS 2.1 9.2.1.1: the block breaks the inline box in pieces and stands
  // outside it, and is still its content, which the inline box's opacity
  // fades as a group (WPT's stacking-context/opacity-affects-block-in-inline).
  // Around two inline boxes, it takes both.
  const result = await renderX11(
    h(
      'box',
      { style: { width: 200, flexDirection: 'column' } },
      h(Html, {
        source:
          '<body style="margin:0;background:#ffffff">' +
          '<span style="opacity:0.5"><div style="height:20px;' +
          'background:#ff0000"></div></span>' +
          '<span style="opacity:0.5"><b style="opacity:0.5">' +
          '<div style="height:20px;background:#ff0000"></div></b></span>' +
          '</body>',
        partial: false,
      }),
    ),
    { width: 240, height: 100, fonts: FONTS },
  );
  await expectPixel(result.ctx, 10, 10, '#ff8080', {
    tolerance: 3,
    message: 'the block is its colour at half over the page',
  });
  await expectPixel(result.ctx, 10, 30, '#ffc0c0', {
    tolerance: 3,
    message: 'and at a quarter inside two such boxes',
  });
});

/** The surfaces a document draws on for a paint of all of it: the ones it
 *  keeps, and the ones it makes for that paint alone. */
async function surfacesOfRepaint(
  t: TestContext,
  node: DrawnNode,
): Promise<number> {
  const el = view(node) as unknown as {
    _surface(width: number, height: number): unknown;
    _invalidate(stale: number): void;
    _sprites: { size: number } | null;
  };
  const surface = t.mock.method(el, '_surface');
  el._invalidate(0);
  await act();
  return surface.mock.callCount() + (el._sprites?.size ?? 0);
}

metric(
  'an element under full opacity is faded as the group it is',
  async (t) => {
    // CSS Color 4, 3.2: what it holds is drawn whole and faded as one, so
    // the red over its blue background shows no blue through it, where
    // each thing faded on its own did — and two such elements, one in the
    // other, are a group in a group
    const { result, node } = await render(
      '<style>body{margin:0}html{background:#ffffff}</style>' +
        '<div style="opacity:.5;width:60px;height:40px;padding:10px;' +
        'background:#0000ff"><div style="height:40px;background:#ff0000">' +
        '</div></div>' +
        '<div style="opacity:.5;width:60px;height:40px;padding:10px;' +
        'background:#0000ff"><div style="opacity:.5;height:40px;' +
        'padding:10px;box-sizing:border-box;background:#ff0000">' +
        '<div style="height:20px;background:#00ff00"></div></div></div>' +
        '<div style="opacity:.5;width:40px;height:20px;' +
        'border:10px solid #ff0000;background:#0000ff"></div>',
    );
    await expectPixel(result.ctx, 40, 30, '#ff8080', {
      tolerance: 3,
      message: 'the red, half over the page',
    });
    await expectPixel(result.ctx, 5, 5, '#8080ff', {
      tolerance: 3,
      message: 'the blue around it, half over the page',
    });
    // the green over the red, half over the blue, and all of it half over
    // the page
    await expectPixel(result.ctx, 40, 90, '#80bfbf', {
      tolerance: 3,
      message: 'a group in a group',
    });
    // a border over its own background
    await expectPixel(result.ctx, 5, 125, '#ff8080', {
      tolerance: 3,
      message: 'the border, half over the page',
    });
    assert.ok((await surfacesOfRepaint(t, node)) > 0, 'drawn on surfaces');
  },
);

metric(
  'an element under full opacity that draws one thing is faded without a surface, but for text on X11',
  async (t) => {
    // a background alone — the backdrop a dialog dims a page with — or an
    // image alone is the same faded either way
    const backdrop = await render(
      '<style>body{margin:0}html{background:#ffffff}</style>' +
        '<div style="opacity:.5;height:40px;background:#ff0000"></div>',
    );
    await expectPixel(backdrop.result.ctx, 10, 20, '#ff8080', {
      tolerance: 3,
      message: 'the backdrop, half over the page',
    });
    assert.strictEqual(
      await surfacesOfRepaint(t, backdrop.node),
      0,
      'and no surface',
    );
    // ntk's glyphs take no alpha of the context's, and drew a paragraph at
    // `opacity: .5` at full strength: text there is a group, which the
    // composite fades
    const text = await render(
      '<style>body{margin:0}html{background:#ffffff}</style>' +
        '<p style="margin:0;font:bold 48px sans-serif;opacity:.5;color:#000000">MWM</p>',
    );
    const pixels = await pixelsIn(text.result.ctx, {
      x: 0,
      y: 0,
      width: 120,
      height: 50,
    });
    let darkest = 255;
    for (let i = 0; i < pixels.length; i += 4) {
      darkest = Math.min(darkest, pixels[i]);
    }
    assert.ok(
      darkest >= 120 && darkest <= 136,
      `black text at half over white: ${darkest}`,
    );
    assert.ok(
      (await surfacesOfRepaint(t, text.node)) > 0,
      'faded on a surface',
    );
  },
);

test('a native context fades each thing a faded element draws, but where a faded surface is cheap', async () => {
  // react-x11's macOS and Windows contexts drew a surface under an alpha
  // through CoreGraphics' own, which cost a faded card more than drawing it
  // again: no group is asked for there, but of one that says a faded
  // surface costs what an opaque one does (`fadesSurfacesCheaply`,
  // react-x11#810)
  const { node } = await render(
    '<div style="opacity:.5;padding:4px;background:#ff0000"><b>text</b></div>',
  );
  let asked = 0;
  const surface = () => {
    asked += 1;
    return null;
  };
  await fillsOf(view(node), [], { surface });
  assert.ok(asked > 0, 'a group asked for of ntk’s context');
  asked = 0;
  await fillsOf(view(node), [], { surface, scalesText: true });
  assert.strictEqual(asked, 0, 'and none of a native one');
  await fillsOf(view(node), [], {
    surface,
    scalesText: true,
    fadesSurfacesCheaply: true,
  });
  assert.ok(asked > 0, 'but of one whose faded surfaces are cheap');
});

metric(
  'a positioned box that escapes a clip around a faded element is still drawn',
  async () => {
    // painted where the clip ends, outside the group, as it was: a group
    // drawn whole inside the clip would have cut it off
    const { result } = await render(
      '<style>body{margin:0}html{background:#ffffff}</style>' +
        '<div style="position:relative;height:80px">' +
        '<div style="overflow:hidden;height:20px">' +
        '<div style="opacity:.5;height:20px;background:#0000ff">' +
        '<span style="background:#00ff00">x</span>' +
        '<div style="position:absolute;top:40px;left:0;width:20px;' +
        'height:20px;background:#ff0000"></div></div></div></div>',
    );
    const [r, g, b] = await pixelAt(result.ctx, 10, 50);
    assert.ok(
      r > 200 && g < 200 && b < 200,
      `drawn below the clip: ${r},${g},${b}`,
    );
  },
);

metric(
  'a box fixed to the viewport in a faded element is drawn where the viewport is',
  async () => {
    // laid out against the viewport at the document's top and drawn where
    // the viewport is now, past the ink its faded element was laid out
    // with once the document scrolls: a group the size of that ink cut it
    // off, so the element fades each thing it draws
    const pane = React.createRef<DrawnNode & { scrollTo(y: number): void }>();
    const result = await renderX11(
      h(
        'box',
        { ref: pane, style: { width: 200, height: 200, overflow: 'scroll' } },
        h(Html, {
          source:
            '<style>body{margin:0}html{background:#ffffff}</style>' +
            '<div style="opacity:.5;height:50px;background:#0000ff">a' +
            '<div style="position:fixed;bottom:0;left:0;width:100px;' +
            'height:20px;background:#ff0000"></div></div>' +
            '<div style="height:2000px"></div>',
          partial: false,
          'data-testname': 'doc',
        }),
      ),
      { width: 240, height: 240, fonts: FONTS! },
    );
    await act();
    await act(async () => pane.current!.scrollTo(100));
    const el = view(screen.getByTestName('doc') as DrawnNode) as unknown as {
      _invalidate(stale: number): void;
    };
    el._invalidate(0);
    await act();
    await expectPixel(result.ctx, 50, 190, '#ff8080', {
      tolerance: 3,
      message: 'the bar at the viewport’s foot, half over the page',
    });
  },
);

metric(
  'an element under full opacity at a display scale of 2 is faded as a group on the device grid',
  async () => {
    const { result } = await render2x(
      '<style>body{margin:0}html{background:#ffffff}</style>' +
        '<div style="opacity:.5;width:30px;height:20px;padding:5px;' +
        'background:#0000ff"><div style="height:20px;background:#ff0000">' +
        '</div></div>',
    );
    // the document at 40 device pixels in; the red box 5 logical pixels
    // further, 60 by 40 device pixels
    await expectPixel(result.ctx, 80, 70, '#ff8080', {
      tolerance: 3,
      message: 'the red, half over the page',
    });
    await expectPixel(result.ctx, 43, 43, '#8080ff', {
      tolerance: 3,
      message: 'the blue around it',
    });
  },
);

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
    const { queryChildIndex } = await import('../../src/html/paint.js');
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

metric(
  'a mask shows its element where its image is opaque, and nothing before it arrives',
  async () => {
    // CSS Masking 1: the element drawn as a group, and cut by the alpha of
    // its mask layers, placed as a background's are. Wikipedia draws every
    // icon as a `background-color` masked by an SVG, and each was a solid
    // square. A layer whose image has not arrived is transparent black:
    // the element is not drawn at all until it does.
    const half =
      `<svg ${SVG_NS} width="20" height="20">` +
      '<rect width="10" height="20" fill="#000000"/></svg>';
    const { result } = await renderWithBytes(
      '<style>body{margin:0;background:#ffffff}div{width:40px;height:20px;' +
        'background:#ff0000}#m{mask:url(m.svg) no-repeat}' +
        '#w{-webkit-mask-image:url(m.svg);-webkit-mask-repeat:no-repeat;' +
        '-webkit-mask-position:right;-webkit-mask-size:20px}' +
        '#late{mask-image:url(late.svg)}' +
        '#g{mask-image:linear-gradient(#000000,#000000 50%,' +
        'transparent 50%)}#a{background:none}#a::after{content:"";' +
        'display:block;width:20px;height:20px;background:#0000ff;' +
        'mask:url(m.svg)}#f{mask-image:url(#svg-mask)}</style>' +
        '<div id="m"></div><div id="w"></div><div id="late"></div>' +
        '<div id="g"></div><div id="a"></div><div id="f"></div>',
      { 'm.svg': svgBytes(half) },
    );
    const ctx = result.ctx;
    await expectPixel(ctx, 5, 10, '#ff0000', { message: 'under the image' });
    await expectPixel(ctx, 15, 10, '#ffffff', {
      message: 'where it is transparent',
    });
    await expectPixel(ctx, 30, 10, '#ffffff', { message: 'past it' });
    await expectPixel(ctx, 25, 30, '#ff0000', {
      message: 'placed and sized, under its -webkit- names',
    });
    await expectPixel(ctx, 5, 30, '#ffffff', { message: 'and not repeated' });
    await expectPixel(ctx, 5, 50, '#ffffff', {
      message: 'an image that has not arrived shows nothing',
    });
    await expectPixel(ctx, 5, 65, '#ff0000', { message: 'a gradient mask' });
    await expectPixel(ctx, 5, 75, '#ffffff', { message: 'its clear half' });
    await expectPixel(ctx, 5, 90, '#0000ff', { message: 'a pseudo-element' });
    await expectPixel(ctx, 15, 90, '#ffffff', {
      message: "the pseudo-element's mask",
    });
    await expectPixel(ctx, 35, 110, '#ff0000', {
      message:
        'an SVG <mask> named by a fragment is not drawn, nor is its want',
    });
  },
);

metric('a radial gradient is a mask, as a linear one is', async () => {
  // a vignette: `mask-image: radial-gradient(…)` shows its element where
  // the gradient is opaque. It was drawn as nothing, so as no mask, and
  // the element was not drawn at all
  const { result, node } = await render(
    '<style>body{margin:0;background:#ffffff}div{width:200px;height:100px;' +
      'background:#ff0000;mask-image:radial-gradient(closest-side,' +
      '#000000 50%,transparent 50%)}</style><div></div>',
  );
  const at = (node as unknown as { abs: { x: number; y: number } }).abs;
  await waitFor(async () => {
    for (const [x, y, shown] of [
      [100, 50, true],
      [140, 50, true],
      [160, 50, false],
      [100, 70, true],
      [100, 80, false],
      [10, 10, false],
    ] as [number, number, boolean][]) {
      const [r, g] = await pixelAt(result.ctx, at.x + x, at.y + y);
      assert.ok(
        shown ? r > 200 && g < 60 : g > 200,
        `${shown ? 'shown' : 'masked'} at ${x},${y}: ${r},${g}`,
      );
    }
  });
});

metric(
  'a mask is placed and sized in CSS pixels at a display scale of 2',
  async () => {
    // its size and position are lengths, device pixels by the time they are
    // stored, and its image's own size is CSS pixels until it is drawn
    const half =
      `<svg ${SVG_NS} width="20" height="20">` +
      '<rect width="10" height="20" fill="#000000"/></svg>';
    const result = await renderX11(
      h(
        'box',
        { style: { width: 200, flexDirection: 'column' } },
        h(Html, {
          source:
            '<style>body{margin:0;background:#ffffff}div{width:40px;' +
            'height:20px;background:#ff0000;mask:url(m.svg) right / 20px ' +
            'no-repeat}</style><div></div>',
          partial: false,
          onResource: (r: { url: string; kind: string }) =>
            r.kind === 'image' && r.url === 'm.svg'
              ? { kind: 'image' as const, bytes: svgBytes(half) }
              : null,
        }),
      ),
      atScale2({ width: 240, height: 100, fonts: FONTS! }),
    );
    // in device pixels: the image covers 40 to 80, opaque from 40 to 60
    await expectPixel(result.ctx, 50, 20, '#ff0000', { message: 'opaque' });
    await expectPixel(result.ctx, 70, 20, '#ffffff', { message: 'clear' });
    await expectPixel(result.ctx, 30, 20, '#ffffff', { message: 'outside' });
  },
);

test('a mask longhand with a var() in it resets its own list, not the others', async () => {
  // A declaration with a `var()` is set back to its initial value first, in
  // case what it substitutes is no value. The mask's lists are one field,
  // and that put back the whole of it: Wikipedia's `mask-size:
  // calc(var(--x) - 4px)` undid the `mask-repeat: no-repeat` before it,
  // and its chevron repeated
  const { node } = await render(
    '<style>#m{--x:24px;mask-repeat:no-repeat;mask-position:center;' +
      'mask-size:calc(var(--x) - 4px);mask-image:url(m.svg)}' +
      '#i{mask-repeat:no-repeat;mask-size:var(--missing)}</style>' +
      '<p id="m">x</p><p id="i">x</p>',
  );
  const el = view(node);
  const mask = (id: string) =>
    (boxOf(el, id) as unknown as { style: ComputedStyle }).style.mask;
  assert.deepStrictEqual(mask('m').repeats, [['no-repeat', 'no-repeat']]);
  assert.deepStrictEqual(mask('m').positions, [[{ pct: 50 }, { pct: 50 }]]);
  assert.deepStrictEqual(mask('m').sizes, [[20, 'auto']]);
  // a var() that substitutes nothing leaves its own list at the start
  assert.deepStrictEqual(mask('i').sizes, ['auto']);
  assert.deepStrictEqual(mask('i').repeats, [['no-repeat', 'no-repeat']]);
});
