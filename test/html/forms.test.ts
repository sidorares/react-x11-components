// <Html> — form controls: the widgets mounted beside the document, and the
// ones it draws.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import {
  act,
  cleanup,
  fireEvent,
  pixelAt,
  renderX11,
  screen,
  userEvent,
  waitFor,
} from 'react-x11/test';
import { ThemeProvider } from 'react-x11';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import type { HtmlViewNode } from '../../src/html/index.js';
import {
  FONTS,
  boxOf,
  edgesOf,
  fillsOf,
  findById,
  h,
  linesOf,
  metric,
  render,
  render2x,
  view,
} from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

metric(
  "form controls take Chrome's margins and sit on the baseline",
  async () => {
    // Chrome's UA sheet: no margin round a field, a select or a text area,
    // its own round the checkables and a range, and each on its line's
    // baseline — a field by the text it shows, a checkbox by its border
    // box's bottom, a meter a fifth of an em under it. This had its own
    // margins and set every control `middle`.
    const { node } = await render(
      '<style>body{margin:0}p{margin:0;font-size:16px}</style>' +
        '<p id="p">a <input id="f" size="4"> b <input id="c" type="checkbox">' +
        '<input id="r" type="radio"><input id="g" type="range">' +
        '<meter id="m" value="0.5"></meter></p>',
    );
    const el = view(node);
    const margins = (id: string) => {
      const box = boxOf(el, id) as unknown as {
        marginTop: number;
        marginRight: number;
        marginBottom: number;
        marginLeft: number;
      };
      return [box.marginTop, box.marginRight, box.marginBottom, box.marginLeft];
    };
    assert.deepStrictEqual(margins('f'), [0, 0, 0, 0], 'none round a field');
    assert.deepStrictEqual(margins('c'), [3, 3, 3, 4], "a checkbox's");
    assert.deepStrictEqual(margins('r'), [3, 3, 0, 5], "a radio button's");
    assert.deepStrictEqual(margins('g'), [2, 2, 2, 2], "a range's");
    const [line] = linesOf(el, 'p');
    const baseline = line.y + line.baseline;
    const bottom = (id: string) => boxOf(el, id).y + boxOf(el, id).height;
    const field = boxOf(el, 'f');
    assert.ok(
      field.y < baseline && bottom('f') > baseline + 2,
      `the field's text on the baseline: ${field.y}..${bottom('f')} by ${baseline}`,
    );
    assert.ok(
      Math.abs(bottom('c') - baseline) < 0.5,
      'a checkbox on its bottom',
    );
    assert.ok(Math.abs(bottom('r') - baseline) < 0.5, 'a radio button too');
    assert.ok(
      Math.abs(bottom('m') - (baseline + 3.2)) < 0.5,
      `a meter a fifth of an em under it: ${bottom('m')} by ${baseline}`,
    );
  },
);

metric(
  'a text field the author gave a box is drawn by the document',
  async () => {
    // a browser drops a field's native look for the author's border and
    // background (CSS UI 4 7.1); the widget was mounted over the whole
    // box, with the theme's frame and fill over the author's
    const { result, node } = await render(
      '<style>body{margin:0}</style><input id="f" placeholder="q" ' +
        'style="margin:0;border:10px solid #00ff00;background:#0000ff;' +
        'padding:5px;width:100px;height:20px">',
    );
    const field = await screen.findByPlaceholder('q');
    const at = (node as unknown as { abs: { x: number; y: number } }).abs;
    const inner = (field as unknown as { abs: Record<string, number> }).abs;
    assert.deepStrictEqual(
      [inner.x - at.x, inner.y - at.y, inner.width, inner.height],
      [15, 15, 100, 20],
      'bare in the content box',
    );
    await waitFor(async () => {
      const [r, g, b] = await pixelAt(result.ctx, at.x + 5, at.y + 5);
      assert.ok(g > 200 && r < 60 && b < 60, `a green edge: ${r},${g},${b}`);
      const [r2, g2, b2] = await pixelAt(result.ctx, at.x + 100, at.y + 25);
      assert.ok(
        b2 > 200 && r2 < 60 && g2 < 60,
        `a blue field: ${r2},${g2},${b2}`,
      );
    });
  },
);

metric(
  'a <button> is drawn with its content, and a press on it is reported',
  async () => {
    // A `<button>` was a mounted widget labelled with its text — or with
    // "Button", where its content was an icon or spans, as most buttons on the
    // web are — and the look the page gave it was lost. It is laid out and
    // drawn like any box, and pressing it is reported through
    // `onControlChange`, as pressing a widget is.
    const pressed: [string | undefined, unknown][] = [];
    await renderX11(
      h(
        'box',
        { style: { width: 400, flexDirection: 'column' } },
        h(Html, {
          source:
            '<button id="b" value="go"><span>Search</span></button> ' +
            '<button id="off" disabled><span>Off</span></button>',
          partial: false,
          onControlChange: (
            el: { attribs: Record<string, string> },
            v: unknown,
          ) => void pressed.push([el.attribs.id, v]),
          'data-testname': 'doc',
        }),
      ),
      { width: 440, height: 200, fonts: FONTS! },
    );
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const tree = (el as unknown as { _tree: { controls: unknown[] } })._tree;
    assert.strictEqual(tree.controls.length, 0, 'no widget is mounted for it');
    assert.ok(
      el.textContent().includes('Search'),
      "its text is the document's",
    );
    const press = async (id: string) => {
      const box = boxOf(el, id);
      const target = el as unknown as DrawnNode;
      const dx = box.x + box.width / 2 - target.abs.width / 2;
      const dy = box.y + box.height / 2 - target.abs.height / 2;
      await act(async () => {
        fireEvent.mouseDown(target, { dx, dy });
        fireEvent.mouseUp(target, { dx, dy });
      });
    };
    await press('b');
    assert.deepStrictEqual(pressed, [['b', 'go']]);
    await press('off');
    assert.strictEqual(pressed.length, 1, 'a disabled one is not pressed');
  },
);

test("a field set to appearance: none is the page's to draw", async () => {
  // `appearance: none` says a field's native look is off whether or not
  // the page gave it a border or a background — and it is how a design
  // system writes every field it has: meetup.com's search pill holds two
  // with no background, only one of them with a rule, and the other was
  // framed by the theme inside the pill.
  const { node } = await render(
    '<input id="own" style="appearance:none;margin:0;padding:2px 0;' +
      'border:0;background:transparent">' +
      '<input id="plain">',
  );
  const el = view(node);
  const rects = (
    el as unknown as {
      _controls: {
        element: { attribs: Record<string, string> };
        bare?: { height: number } | null;
      }[];
    }
  )._controls;
  const own = rects.find((r) => r.element.attribs.id === 'own')!;
  const plain = rects.find((r) => r.element.attribs.id === 'plain')!;
  assert.ok(own.bare, 'mounted bare');
  assert.strictEqual(
    own.bare.height,
    boxOf(el, 'own').height - 4,
    'inside its padding',
  );
  assert.ok(!plain.bare, "a field left alone keeps the theme's frame");
});

metric("a select the page styled is the page's to draw", async () => {
  // A `<select>` was the palette's framed dropdown whatever the page did to
  // it, inside the page's padding: melbcss.com's, a background and 8px of
  // padding, came out 64px tall and white-framed where Chrome draws a 34px
  // box in the page's card colour. It is a field like the others now: the
  // document draws its box, and core's `<Select>` goes bare in the content
  // box, restyled through its slots so its value and its arrow are in the
  // element's colour — the arrow left out at `appearance: none`, where the
  // page draws its own.
  const { countPixels } = await import('react-x11/test');
  const { result, node } = await render(
    '<style>body{margin:0}select{display:block;margin:0;width:200px}' +
      '.own{padding:5px;border:10px solid #00ff00;background:#0000ff;' +
      'color:#ff0000;font-size:20px}</style>' +
      '<select id="own" class="own"><option>Wide option</option></select>' +
      '<select id="none" class="own" style="appearance:none">' +
      '<option>x</option></select>' +
      '<select id="plain"><option>y</option></select>',
  );
  const el = view(node);
  const rects = (
    el as unknown as {
      _controls: {
        element: { attribs: Record<string, string> };
        bare?: { chevron?: boolean } | null;
      }[];
    }
  )._controls;
  const rectOf = (id: string) =>
    rects.find((r) => r.element.attribs.id === id)!;
  assert.strictEqual(rectOf('own').bare?.chevron, true, 'bare, with an arrow');
  assert.strictEqual(rectOf('none').bare?.chevron, false, 'bare, no arrow');
  assert.ok(!rectOf('plain').bare, 'a select left alone keeps the frame');

  const own = boxOf(el, 'own');
  assert.strictEqual(
    own.height,
    Math.round(20 * 1.35) + 2 * 5 + 2 * 10,
    'its line of text, and the padding and border around it: no chrome',
  );
  const at = (el as unknown as { abs: { x: number; y: number } }).abs;
  const [trigger] = screen.getAllByRole('combobox') as unknown as {
    abs: Record<string, number>;
  }[];
  assert.deepStrictEqual(
    [trigger.abs.x - at.x, trigger.abs.y - at.y, trigger.abs.width],
    [15, 15, 200],
    'bare in the content box',
  );

  const content = (id: string, from: number, width: number) => {
    const box = boxOf(el, id);
    return {
      x: at.x + box.x + 15 + from,
      y: at.y + box.y + 15,
      width,
      height: box.height - 30,
    };
  };
  const red = (id: string, from: number, width: number) =>
    countPixels(result.ctx, content(id, from, width), '#ff0000', 60);
  await waitFor(async () => {
    assert.ok((await red('own', 0, 100)) > 20, "the value, in the page's ink");
    assert.ok((await red('own', 176, 24)) > 4, 'the arrow, in it too');
    const [r, g, b] = await pixelAt(
      result.ctx,
      at.x + own.x + 15 + 140,
      at.y + own.y + own.height / 2,
    );
    assert.ok(
      b > 200 && r < 60 && g < 60,
      `the page's fill, not the palette's, under the trigger: ${r},${g},${b}`,
    );
  });
  assert.strictEqual(await red('none', 176, 24), 0, 'no arrow');
});

test('a form control or a frame keeps its height when only its width is set', async () => {
  // Only an image has an intrinsic ratio (CSS 2.1 10.3.2). A control's size
  // and a frame's 300 by 150 are defaults, and a text field set to
  // `width: 100%` came out twice its height.
  const { node } = await render(
    '<input id="a"><input id="b" style="width:300px">' +
      '<button id="c">Go</button><button id="d" style="width:200px">Go</button>' +
      '<iframe id="e"></iframe><iframe id="f" style="height:96px"></iframe>',
  );
  const el = view(node);
  const [a, b, c, d, e, f] = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
    boxOf(el, id),
  );
  assert.strictEqual(b.height, a.height, 'a text field');
  assert.strictEqual(d.height, c.height, 'a button');
  assert.strictEqual(f.width, e.width, 'a frame 96px tall is as wide');
});

test("a button the page styled takes the web's UA edges, not the palette's", async () => {
  // Codex gives Wikipedia's search button its side padding and a 32px
  // min-height, and leaves the padding above and below the label to the
  // browser: Chrome's 1px fits under the minimum, and the palette's did
  // not, so the button stood taller than the field beside it and the flex
  // row stretched the field's wrapper to match. The palette's chrome is for
  // a button the page left alone; a background or a border of the page's,
  // a radius among them, or `appearance: none`, drops it, as each drops a
  // control's native look in Blink.
  await renderX11(
    h(
      ThemeProvider,
      // the palette's side padding is 0.75em, and a control's text is at
      // the theme's size, not the document's
      {
        value: { paddingY: 7, borderWidth: 3, radius: 5, fontSize: 16 },
      } as Record<string, unknown>,
      h(
        'box',
        { style: { width: 600, flexDirection: 'column' } },
        h(Html, {
          source:
            '<button id="plain">Go</button>' +
            '<button id="colored" style="color:red;cursor:default">Go</button>' +
            '<button id="codex" style="border-width:1px;border-style:solid;' +
            'padding-left:11px;padding-right:11px;min-height:32px">Go</button>' +
            '<button id="filled" style="background:#eee">Go</button>' +
            '<button id="round" style="border-radius:0">Go</button>' +
            '<button id="bare" style="appearance:none">Go</button>' +
            // a reset the page takes back: the value that wins counts
            '<button id="back" style="appearance:none;appearance:auto">' +
            'Go</button>',
          partial: false,
          'data-testname': 'doc',
        }),
      ),
    ),
    FONTS
      ? { width: 640, height: 200, fonts: FONTS }
      : { backend: 'mock' as const },
  );
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const edges = (id: string) => {
    const box = edgesOf(boxOf(el, id));
    return [box.padTop, box.padLeft, box.borderLeft, box.style.borderRadius[0]];
  };
  assert.deepStrictEqual(edges('plain'), [7, 12, 3, 5], "the palette's");
  assert.deepStrictEqual(
    edges('colored'),
    [7, 12, 3, 5],
    'its colour and cursor are not its chrome',
  );
  assert.deepStrictEqual(edges('codex'), [1, 11, 1, 0], "Chrome's above");
  assert.strictEqual(boxOf(el, 'codex').height, 32, 'its minimum holds it');
  assert.deepStrictEqual(edges('filled'), [1, 6, 2, 0], "Chrome's all round");
  assert.deepStrictEqual(edges('round'), [1, 6, 2, 0], 'a radius is a border');
  assert.deepStrictEqual(edges('bare'), [1, 6, 2, 0], 'and so is appearance');
  assert.deepStrictEqual(edges('back'), [7, 12, 3, 5], 'where it wins');
});

metric("a button's content is centred down a box taller than it", async () => {
  // HTML 15.5.5: a button's content is in an anonymous box of its own, a
  // formatting context, which is "centered vertically" where it "does not
  // overflow in the vertical axis". Blink moves the children down by half
  // the room left, and by none where there is less than none
  // (`AlignBlockContent`). nextjs.org's sidebar pickers are 60px buttons
  // around 36px of content, which sat at the top of the padding, 4px
  // higher than in a browser.
  const { node } = await render(
    '<style>body{margin:0;font:16px/20px sans-serif}' +
      'button{box-sizing:border-box;margin:0;padding:8px;border:1px solid;' +
      'font:16px/20px sans-serif} .c{width:36px;height:36px}</style>' +
      '<div><button id="tall" style="height:60px">' +
      '<span><div id="tall-c" class="c"></div></span></button></div>' +
      '<div><button id="least" style="min-height:60px">' +
      '<div id="least-c" class="c"></div></button></div>' +
      // safe: what overflows the box starts at its top, as in any box
      '<div><button id="short" style="height:30px">' +
      '<div id="short-c" class="c"></div></button></div>' +
      // margins are the content's, in the formatting context it is: they
      // are centred with it, and none collapses through the button
      '<div><button id="block" style="display:block;height:100px;padding:0;' +
      'border:0"><div id="block-c" class="c" style="margin:10px 0"></div>' +
      '</button></div>' +
      // a float is content too
      '<div><button id="float" style="width:100px;height:60px">' +
      '<div id="float-c" style="float:left;width:20px;height:20px"></div>' +
      '</button></div>' +
      // a line of text, as a label is
      '<div><button id="text" style="height:60px">Go</button></div>' +
      // an absolute box with no offsets is where the flow would have put
      // it: in a button with nothing else, at the middle
      '<div><button id="static" style="width:100px;height:60px;' +
      'position:relative"><div id="static-c" style="position:absolute;' +
      'width:10px;height:10px"></div></button></div>' +
      // a button that is a flex box has no such box: its content is
      // where its own alignment puts it
      '<div><button id="flex" style="display:flex;align-items:flex-start;' +
      'height:60px"><div id="flex-c" class="c"></div></button></div>',
    300,
  );
  const el = view(node);
  const down = (id: string) => boxOf(el, `${id}-c`).y - boxOf(el, id).y;
  // the content box is 42px of the 60: 3 above the 36 and 3 below
  assert.strictEqual(down('tall'), 9 + 3, 'in a height');
  assert.strictEqual(down('least'), 9 + 3, 'in a least height');
  assert.strictEqual(down('short'), 9, 'at the top of a box too short');
  assert.strictEqual(down('block'), 22 + 10, 'its margins with it');
  assert.strictEqual(down('float'), 9 + 11, 'a float');
  assert.strictEqual(down('static'), 9 + 21, 'a static position');
  assert.strictEqual(down('flex'), 9, 'not in a flex box');
  const [line] = linesOf(el, 'text');
  assert.strictEqual(line.height, 20, 'a line of its own line height');
  assert.strictEqual(line.y - boxOf(el, 'text').y, 9 + 11, 'a label');
});

test('a button stretched to a height centres its content in it', async () => {
  // The height a flex box or a grid stretches its item to, and the one
  // two offsets leave an absolute box, are given to the box after its
  // layout: the content is centred in the height the box came to, as in
  // one it set. A toolbar's button as tall as the field beside it kept
  // its icon at the top.
  const { node } = await render(
    '<style>body{margin:0}' +
      'button{box-sizing:border-box;margin:0;padding:8px;border:1px solid}' +
      '.c{width:36px;height:36px}</style>' +
      '<div style="display:flex;height:80px"><button id="flex">' +
      '<div id="flex-c" class="c"></div></button></div>' +
      '<div style="display:grid;height:80px"><button id="grid">' +
      '<div id="grid-c" class="c"></div></button></div>' +
      '<div style="position:relative;height:80px">' +
      '<button id="abs" style="position:absolute;top:0;bottom:0">' +
      '<div id="abs-c" class="c"></div></button></div>',
    300,
  );
  const el = view(node);
  for (const id of ['flex', 'grid', 'abs']) {
    const button = boxOf(el, id);
    assert.strictEqual(button.height, 80, `${id}: stretched`);
    // 62px of content box around 36
    assert.strictEqual(boxOf(el, `${id}-c`).y - button.y, 9 + 13, id);
  }
});

test("a control's text keeps none of the spacing, line height, case or indent around it", async () => {
  // HTML's rendering section, 15.3.10. melbcss.com's buttons sit in a body
  // of `line-height: 1.5`, and inherited it: each was half a line taller
  // than Chrome's.
  const { node } = await render(
    '<button id="c">Go</button>' +
      '<div style="line-height:3;letter-spacing:5px;word-spacing:9px;' +
      'text-transform:uppercase;text-indent:40px">' +
      '<button id="a">Go on</button>' +
      '<button id="b" style="line-height:3">Go on</button></div>' +
      '<button id="d">Go on</button>',
  );
  const el = view(node);
  const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
  assert.deepStrictEqual(size('a'), size('d'), 'as it would be anywhere');
  assert.ok(boxOf(el, 'c').width < boxOf(el, 'd').width, 'a wider label');
  assert.ok(
    boxOf(el, 'b').height > boxOf(el, 'a').height,
    'a line height of its own is still its own',
  );
});

test('a block-level button is as wide as its content, not as its containing block', async () => {
  // HTML's rendering section, button layout (15.5.3): "If the computed
  // value of 'inline-size' is 'auto', then the used value is the
  // fit-content inline size" — a button set `display: block`, to stand on
  // a line of its own, is no wider for it, where a block fills its
  // containing block. Blink leaves `<button>` out of the boxes whose
  // `auto` stretches (`ShouldBlockContainerChildStretchAutoInlineSize`),
  // whatever it is inside: a flex box and a grid too.
  const button = (id: string, style: string, width = 36) =>
    `<button id="${id}" style="${style}">` +
    `<div style="width:${width}px;height:36px"></div></button>`;
  const { node } = await render(
    '<style>body{margin:0}' +
      'button{box-sizing:border-box;margin:0;padding:8px;border:1px solid}' +
      '.cb{width:300px;position:relative}</style>' +
      '<div class="cb">' +
      button('block', 'display:block') +
      button('root', 'display:flow-root') +
      button('flex', 'display:flex') +
      button('grid', 'display:grid') +
      button('item', 'display:list-item') +
      // within its limits, and a width of its own is its own
      button('least', 'display:block;min-width:120px') +
      button('half', 'display:block;min-width:50%') +
      button('most', 'display:block;max-width:40px') +
      button('set', 'display:block;width:100%') +
      button('content', 'display:block;box-sizing:content-box') +
      // no wider than the room its margins leave, where its content can
      // be narrower: a label that wraps
      '<button id="long" style="display:block;margin:0 20px">' +
      '<span style="display:inline-block;width:100px;height:9px"></span> '.repeat(
        4,
      ) +
      '</button>' +
      // and `auto` margins have the room its content leaves to share
      button('middle', 'display:block;margin:0 auto') +
      button('end', 'display:block;margin-left:auto') +
      '</div>' +
      '<div class="cb" dir="rtl">' +
      button('rtl', 'display:block') +
      '</div>' +
      // HTML's `align` sets the blocks in it, as it sets a table
      '<div class="cb" align="center">' +
      button('aligned', 'display:block') +
      '</div>' +
      // nor beside a float, where it stands as a formatting context does
      '<div class="cb" style="overflow:hidden">' +
      '<div style="float:left;width:100px;height:60px"></div>' +
      button('beside', 'display:block') +
      '</div>' +
      // in a shrink-to-fit box it is no wider than its own content either
      '<div class="cb"><div id="float" style="float:left">' +
      button('floated', 'display:block') +
      '<div style="width:200px;height:9px"></div></div></div>' +
      // A flex box and a grid size their items, and stretch them; two
      // offsets stretch an absolute one between them, as Blink has it.
      '<div class="cb" style="display:flex;flex-direction:column">' +
      button('column', '') +
      '</div>' +
      '<div class="cb" style="display:grid">' +
      button('cell', '') +
      '</div>' +
      '<div class="cb" style="height:60px">' +
      button('between', 'position:absolute;left:10px;right:10px') +
      '</div>',
    300,
  );
  const el = view(node);
  const width = (id: string) => boxOf(el, id).width;
  // 36px of content, 8px of padding and 1px of border either side
  for (const id of ['block', 'root', 'flex', 'grid', 'item']) {
    assert.strictEqual(width(id), 54, `display of #${id}`);
    assert.strictEqual(boxOf(el, id).x, 0, `#${id} at the start`);
  }
  assert.strictEqual(width('least'), 120, 'a least width');
  assert.strictEqual(width('half'), 150, 'a least width of a percentage');
  assert.strictEqual(width('most'), 40, 'a greatest width');
  assert.strictEqual(width('set'), 300, 'a width of its own');
  assert.strictEqual(width('content'), 54, 'a content box');
  assert.strictEqual(width('long'), 260, 'the room its margins leave');
  assert.strictEqual(boxOf(el, 'long').x, 20, 'inside its margins');
  assert.strictEqual(boxOf(el, 'middle').x, 123, 'auto margins centre it');
  assert.strictEqual(boxOf(el, 'end').x, 246, 'and one puts it at the end');
  assert.strictEqual(boxOf(el, 'rtl').x, 246, 'the start of a line of rtl');
  assert.strictEqual(boxOf(el, 'aligned').x, 123, 'align="center"');
  assert.deepStrictEqual(
    [boxOf(el, 'beside').x, width('beside')],
    [100, 54],
    'beside a float',
  );
  assert.strictEqual(width('float'), 200, 'a float around it');
  assert.strictEqual(width('floated'), 54, 'and the button in it');
  assert.strictEqual(width('column'), 300, 'a flex item is stretched');
  assert.strictEqual(width('cell'), 300, 'a grid item is stretched');
  assert.strictEqual(width('between'), 280, 'and a box between two offsets');
});

metric(
  'a block-level button with a label is as wide as the label',
  async () => {
    const { node } = await render(
      '<style>body{margin:0}button{margin:0}</style>' +
        '<div style="width:300px">' +
        '<button id="line">Save changes</button>' +
        '<button id="block" style="display:block">Save changes</button>' +
        '<button id="table" style="display:table">Save changes</button>' +
        '<button id="bare" style="display:block;appearance:none">' +
        'Save changes</button>' +
        '<button id="empty" style="display:block"></button>' +
        '</div>',
      300,
    );
    const el = view(node);
    const line = boxOf(el, 'line');
    assert.ok(line.width > 40 && line.width < 200, `a label: ${line.width}`);
    assert.strictEqual(boxOf(el, 'block').width, line.width, 'a block');
    assert.strictEqual(boxOf(el, 'table').width, line.width, 'a table');
    // taking the palette's look off does not make it a block like any other
    const bare = boxOf(el, 'bare');
    assert.ok(bare.width > 40 && bare.width < 200, `bare: ${bare.width}`);
    const empty = boxOf(el, 'empty');
    const edges = edgesOf(empty);
    assert.strictEqual(
      empty.width,
      edges.padLeft + edges.padRight + 2 * edges.borderLeft,
      'its edges alone',
    );
  },
);

metric(
  'a button set display: inline is an inline-block, and a table or a list item a block',
  async () => {
    // Button layout again: a `display` "such that the outer display type is
    // 'inline'" behaves as `inline-block`, and anything else but a flex box
    // or a grid as `flow-root`. Chrome computes `inline-block` for `inline`
    // and `inline-table`, and `block` for `table` and `list-item`. Left an
    // inline box, a button around a block was broken in two around it: as
    // wide as the line, its height and its padding on nothing, and its
    // borders drawn above and below the line. A block, its content is
    // centred in it as any button's is.
    const { node } = await render(
      '<style>body{margin:0;font:16px/1 sans-serif}' +
        'button{box-sizing:border-box;margin:0;padding:8px;border:1px solid;' +
        'font:16px/1 sans-serif}' +
        'i{display:inline-block;width:10px;height:10px}</style>' +
        '<div id="a" style="width:300px">' +
        '<button id="g" style="display:inline;height:60px">' +
        '<div id="c" style="width:36px;height:36px"></div></button>' +
        '<i id="i"></i></div>' +
        // one of text is the box an inline-block of it is, its sizes its own
        '<div id="b">x <button id="t" style="display:inline">Go</button> ' +
        '<button id="u" style="display:inline-block">Go</button> ' +
        '<button id="v" style="display:inline-table">Go</button> ' +
        '<button id="w" style="display:inline;width:120px;height:40px">Go' +
        '</button></div>' +
        // and an underline of the text around it is not the button's
        '<div><u>x <button id="d" style="display:inline">Go</button></u>' +
        '</div>' +
        // a list item has no marker, and a table no cell
        '<button id="l" style="display:list-item">' +
        '<div style="width:36px;height:36px"></div></button>' +
        '<button id="m" style="display:table;height:60px">' +
        '<div id="n" style="width:36px;height:36px"></div></button>',
      300,
    );
    const el = view(node);
    const a = boxOf(el, 'a');
    const g = boxOf(el, 'g');
    assert.deepStrictEqual(
      [g.x, g.y - a.y, g.width, g.height],
      [0, 0, 54, 60],
      'its height and its edges are a box of its own',
    );
    assert.strictEqual(a.height, 60, 'and the line is as tall');
    // 42px of content box around 36
    const c = boxOf(el, 'c');
    assert.deepStrictEqual(
      [c.x - g.x, c.y - g.y],
      [9, 9 + 3],
      'its content inside its edges, centred',
    );
    // beside it on its line, on the bottom of the button's content box
    const i = boxOf(el, 'i');
    assert.deepStrictEqual([i.x, i.y - a.y], [54, 60 - 9 - 10], 'on its line');
    const size = (id: string) => [boxOf(el, id).width, boxOf(el, id).height];
    assert.deepStrictEqual(size('t'), size('u'), 'a label');
    assert.deepStrictEqual(size('v'), size('u'), 'an inline table');
    assert.deepStrictEqual(size('w'), [120, 40], 'a width and a height');
    assert.strictEqual(boxOf(el, 't').y, boxOf(el, 'u').y, 'on one baseline');
    const made = (id: string) =>
      boxOf(el, id) as unknown as {
        kind: string;
        marker?: object;
        style: { display: string; underline: string | null };
      };
    assert.strictEqual(made('t').style.display, 'inline-block');
    assert.strictEqual(made('d').style.underline, null, 'no line from above');
    const l = made('l');
    assert.deepStrictEqual(
      [l.kind, l.marker ?? null, l.style.display],
      ['block', null, 'block'],
      'a list item is a block',
    );
    const m = made('m');
    assert.deepStrictEqual(
      [m.kind, m.style.display, boxOf(el, 'n').y - boxOf(el, 'm').y],
      ['block', 'block', 9 + 3],
      'and so is a table, its content centred',
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
  "a form control is drawn at its element's opacity, and a hidden one is not mounted",
  async () => {
    // A CSS-only dropdown lays an invisible checkbox over its label —
    // Wikipedia's language button, `opacity: 0` and as big as the label —
    // and the widget was drawn over the label regardless. A browser draws
    // it at the opacity its element and every ancestor come to, and at 0
    // not at all, while its whole box still takes the press.
    const changes: [string | undefined, unknown][] = [];
    await renderX11(
      h(
        'box',
        { style: { width: 400, flexDirection: 'column' } },
        h(Html, {
          source:
            '<style>body{margin:0}.menu{position:relative;width:160px;' +
            'height:32px}.menu input{position:absolute;top:0;left:0;' +
            'width:100%;height:100%;margin:0;opacity:0}</style>' +
            '<div class="menu"><input type="checkbox" id="c">' +
            '<label for="c">52 languages</label></div>' +
            '<div style="opacity:.5"><p style="opacity:.5">' +
            '<input type="checkbox" id="half"></p></div>' +
            '<p style="visibility:hidden"><input type="checkbox" id="h"></p>',
          partial: false,
          onControlChange: (
            el: { attribs: Record<string, string> },
            v: unknown,
          ) => void changes.push([el.attribs.id, v]),
          'data-testname': 'doc',
        }),
      ),
      { width: 440, height: 200, fonts: FONTS! },
    );
    await act();
    const widgets = screen.getAllByRole('checkbox');
    assert.strictEqual(widgets.length, 2, 'the hidden one is not mounted');
    const opacityOf = (n: DrawnNode) =>
      (n.parent as unknown as { style: { opacity?: number } }).style.opacity;
    const [menu, half] = widgets as DrawnNode[];
    assert.strictEqual(opacityOf(menu), 0, 'the menu checkbox is not seen');
    assert.strictEqual(opacityOf(half), 0.25, 'a faded one is faded twice');
    assert.deepStrictEqual(
      [menu.abs.width, menu.abs.height],
      [160, 32],
      'and it takes the whole of its box',
    );
    // a press over the label's end toggles it, as a browser's does
    const at = { x: menu.abs.x + 150, y: menu.abs.y + 16 };
    await act(async () => {
      fireEvent.mouseDown(menu, {
        dx: at.x - (menu.abs.x + menu.abs.width / 2),
        dy: at.y - (menu.abs.y + menu.abs.height / 2),
      });
      fireEvent.mouseUp(menu, {
        dx: at.x - (menu.abs.x + menu.abs.width / 2),
        dy: at.y - (menu.abs.y + menu.abs.height / 2),
      });
    });
    assert.deepStrictEqual(changes, [['c', true]]);
  },
);

/** The clip each control of a document was reported with, by its id. */
function clipsOf(node: DrawnNode): Record<string, unknown> {
  const rects = (
    view(node) as unknown as {
      _controls: {
        element: { attribs: Record<string, string> };
        clip?: { x: number; y: number; width: number; height: number };
      }[];
    }
  )._controls;
  return Object.fromEntries(
    rects.map((r) => [r.element.attribs.id, r.clip ?? null]),
  );
}

/** The box a control's widget shows through: around the element's. */
function portOf(
  widget: DrawnNode,
): DrawnNode & { style: { overflow?: string } } {
  return widget.parent!.parent as DrawnNode & { style: { overflow?: string } };
}

metric(
  'a control a page hides under clip: rect(0, 0, 0, 0) draws nothing and takes no press',
  async () => {
    // Radix lays a native `<select>` beside each picker it draws, for a
    // form and a screen reader: a pixel square, `overflow: hidden`, `clip:
    // rect(0, 0, 0, 0)`. `clip` leaves none of an absolute box to see (CSS
    // 2.1 11.1.2), and the document drew none of it — but the widget is
    // not the document's to draw, and nothing cut it: nextjs.org's docs
    // had a dropdown reading "Select…" beside each of their two pickers.
    const result = await renderX11(
      h(
        'box',
        { style: { width: 400, flexDirection: 'column' } },
        h(Html, {
          source:
            '<style>body{margin:0;background:#fff}</style>' +
            '<div style="height:120px"></div>' +
            '<select id="sr" aria-hidden="true" tabindex="-1" style="' +
            'position:absolute;top:61px;left:21px;border:0;width:1px;' +
            'height:1px;padding:0;margin:-1px;overflow:hidden;' +
            'clip:rect(0, 0, 0, 0);white-space:nowrap"></select>',
          partial: false,
          'data-testname': 'doc',
        }),
      ),
      { width: 440, height: 200, fonts: FONTS! },
    );
    await act();
    const node = screen.getByTestName('doc') as DrawnNode;
    const el = view(node) as unknown as DrawnNode;
    assert.deepStrictEqual(
      clipsOf(node).sr,
      { x: 20, y: 60, width: 0, height: 0 },
      'none of it shows',
    );
    // mounted all the same: a control hidden this way is still the
    // keyboard's and a screen reader's, which is what it is hidden for
    const [trigger] = screen.getAllByRole('combobox') as DrawnNode[];
    assert.ok(trigger, 'the widget is mounted');
    const port = portOf(trigger);
    assert.deepStrictEqual(
      [port.abs.width, port.abs.height, port.style.overflow],
      [0, 0, 'hidden'],
      'in a box of no area that cuts it',
    );
    const { countPixels } = await import('react-x11/test');
    const around = { x: el.abs.x, y: el.abs.y + 40, width: 200, height: 60 };
    await waitFor(async () => {
      assert.strictEqual(
        await countPixels(result.ctx, around, '#ffffff', 2),
        around.width * around.height,
        'nothing is drawn where the dropdown was',
      );
    });
    const hit = (
      result.windowNode as unknown as {
        hitTest(x: number, y: number): DrawnNode | null;
      }
    ).hitTest(el.abs.x + 30, el.abs.y + 66);
    assert.ok(hit === el, 'and a press there is the document’s');
  },
);

metric(
  'a control with a negative tabindex takes the focus and is no Tab stop',
  async () => {
    // HTML 6.6.3: a negative `tabindex` is focusable and not reached by
    // sequential navigation. None was read, so the native `<select
    // tabindex="-1" aria-hidden="true">` Radix keeps beside the picker it
    // draws — cut to nothing — was a stop the eye could not find, and Space
    // on it opened an empty menu. A positive one is not handed over: it
    // would put a page's control ahead of the application's own.
    const result = await renderX11(
      h(
        'box',
        { style: { width: 400, flexDirection: 'column' } },
        h(Html, {
          source:
            '<input placeholder="first">' +
            '<input placeholder="skipped" tabindex="-1" autofocus>' +
            '<select tabindex="-1" aria-hidden="true"><option>x</option>' +
            '</select>' +
            '<div aria-hidden="TRUE"><input type="checkbox" tabindex=" -1 ">' +
            '</div>' +
            '<input type="submit" value="Go" tabindex="-2px">' +
            '<textarea tabindex="-1"></textarea>' +
            '<input placeholder="late" tabindex="3">' +
            '<input placeholder="last" tabindex="x" aria-hidden="false">',
          partial: false,
          selectable: false,
        }),
      ),
      // Tab is a key press, which only the in-process server takes
      { width: 440, height: 400, fonts: FONTS! },
    );
    await act();
    // a node with the props it was mounted with, which core's type leaves
    // to the element
    type Mounted = DrawnNode & {
      props: { placeholder?: string; role?: string; 'aria-hidden'?: boolean };
    };
    const focused = (): string | undefined => {
      const find = (node: Mounted): Mounted | null => {
        if (node.focused) return node;
        for (const child of node.children as Mounted[]) {
          const hit = find(child);
          if (hit) return hit;
        }
        return null;
      };
      const props = find(result.windowNode as unknown as Mounted)?.props;
      return props && (props.placeholder ?? props.role ?? 'unnamed');
    };
    assert.strictEqual(focused(), 'skipped', 'autofocus reaches it');
    const stops: (string | undefined)[] = [];
    for (let i = 0; i < 4; i += 1) {
      await userEvent.tab();
      stops.push(focused());
    }
    // From the field `autofocus` took, which is no stop, Tab goes on from
    // where it is, as a browser's does; past the last, the window's order
    // brings it round to the first.
    assert.deepStrictEqual(
      stops,
      ['late', 'last', 'first', 'late'],
      'Tab passes the negative ones, and a positive one stays where it is',
    );
    // `aria-hidden` on the element or around it keeps the widget from an
    // assistive technology: on the box it is mounted in, which core leaves
    // out of the accessibility tree with all it holds
    const hidden = (node: DrawnNode): boolean => {
      let at = node as Mounted | null;
      for (; at; at = at.parent as Mounted | null) {
        if (at.props['aria-hidden'] === true) return true;
      }
      return false;
    };
    assert.deepStrictEqual(
      [
        hidden(screen.getByRole('combobox') as DrawnNode),
        hidden(screen.getByRole('checkbox') as DrawnNode),
        hidden(screen.getByPlaceholder('first') as DrawnNode),
        hidden(screen.getByPlaceholder('last') as DrawnNode),
      ],
      [true, true, false, false],
    );
  },
);

/** A laid-out box's computed outline, border colour and shadows. */
type FocusStyled = LaidBox & {
  style: {
    outlineStyle: string;
    outlineWidth: number;
    outlineOffset: number;
    outlineColor: string;
    borderTopColor: string;
    boxShadow: unknown;
    backgroundColor: string;
  };
};

const styleOf = (el: HtmlViewNode, id: string) =>
  (boxOf(el, id) as FocusStyled).style;

metric(
  "a text field's widget holding the focus is its element's :focus, ringed as the page says",
  async () => {
    // github.com/login: Primer's `.form-control:focus` gives the field an
    // accent border and an inset shadow, and takes the outline away.
    // Nothing matched `:focus`, so the border stayed grey — and core drew
    // its own ring round the widget, which is the content box of a field
    // the page draws: a thinner frame inside the page's border.
    const { result, node } = await render(
      '<style>body{margin:0} form{margin:0}' +
        ' input{margin:0 0 10px;padding:5px;width:100px;height:20px;' +
        'border:2px solid #808080;background:#000000;color:#ffffff}' +
        ' input:focus{border-color:#0000ff;' +
        'box-shadow:inset 0 0 0 2px #0000ff;outline:none}' +
        ' form:focus-within{background:#00ff00}</style>' +
        '<form id="form"><input id="a" placeholder="a"></form>' +
        '<input id="b" placeholder="b">',
    );
    const el = view(node);
    const at = (node as unknown as { abs: { x: number; y: number } }).abs;
    const rgb = (id: string, x: number, y: number) => {
      const box = boxOf(el, id);
      return pixelAt(result.ctx, at.x + box.x + x, at.y + box.y + y);
    };
    const is = (want: [number, number, number]) => (got: number[]) =>
      got.slice(0, 3).every((c, i) => Math.abs(c - want[i]) < 40);
    const blue = is([0, 0, 255]);
    const grey = is([128, 128, 128]);
    const black = is([0, 0, 0]);
    const green = is([0, 255, 0]);
    const a = screen.getByPlaceholder('a') as DrawnNode;
    const b = screen.getByPlaceholder('b') as DrawnNode;
    const expect = async (
      what: string,
      checks: [string, number, number, (px: number[]) => boolean][],
    ) => {
      await waitFor(async () => {
        for (const [id, x, y, ok] of checks) {
          const px = await rgb(id, x, y);
          assert.ok(ok(px), `${what}: ${id} at ${x},${y} is ${px}`);
        }
      });
    };

    await expect('nothing focused', [
      ['a', 1, 17, grey],
      ['form', 300, 10, (px) => !green(px)],
    ]);
    await act(async () => {
      a.focus();
    });
    assert.strictEqual(el.focusedElement, findById(el.document, 'a'));
    // and its caret is the text's colour, a browser's `caret-color: auto`
    assert.strictEqual(
      (a as unknown as { props: { caretColor?: string } }).props.caretColor,
      '#ffffff',
    );
    await expect('the first field focused', [
      // the page's border and the shadow inside it
      ['a', 1, 17, blue],
      ['a', 3, 17, blue],
      // where core's ring stood, round the content box: the field's ground
      ['a', 5, 17, black],
      ['a', 20, 5, black],
      ['b', 1, 17, grey],
      ['form', 300, 10, green],
    ]);
    // from one field to the next: the form it leaves loses its
    // `:focus-within`, and the field its `:focus`
    await act(async () => {
      b.focus();
    });
    await expect('the second field focused', [
      ['a', 1, 17, grey],
      ['b', 1, 17, blue],
      ['form', 300, 10, (px) => !green(px)],
    ]);
    await act(async () => {
      b.blur();
    });
    await expect('nothing focused again', [['b', 1, 17, grey]]);
    assert.strictEqual(el.focusedElement, null);
  },
);

metric(
  "a field's focus ring is its element's outline, the palette's where the page says nothing",
  async () => {
    // Chrome's `:focus-visible { outline: auto 1px -webkit-focus-ring-color }`
    // and `auto` the platform's ring, which is the palette's: its colour,
    // its width and its gap. A page's `outline: none` takes it away, as it
    // does in a browser, and the widget draws none of its own either way.
    const { node } = await render(
      '<input id="a" placeholder="a">' +
        '<input id="b" placeholder="b" style="outline:none">' +
        '<textarea id="c" placeholder="c" ' +
        'style="outline:3px auto -webkit-focus-ring-color"></textarea>',
    );
    const el = view(node);
    for (const id of ['a', 'b']) {
      assert.strictEqual(styleOf(el, id).outlineStyle, 'none', id);
    }
    const field = screen.getByPlaceholder('a') as DrawnNode;
    const own = (field as unknown as { props: { style: unknown } }).props.style;
    assert.ok(
      [own]
        .flat(Infinity)
        .some(
          (s) => (s as { outlineWidth?: number } | null)?.outlineWidth === 0,
        ),
      'the widget draws no ring',
    );
    await act(async () => {
      field.focus();
    });
    const a = styleOf(el, 'a');
    assert.deepStrictEqual(
      [a.outlineStyle, a.outlineWidth, a.outlineOffset, a.outlineColor],
      ['auto', 2, 1, '#2980b9'],
      "the palette's ring",
    );
    // drawn round the field's frame, whose corners the palette's are
    const fills = await fillsOf(el);
    assert.ok(
      fills.some((f) => f.style === '#2980b9'),
      'the document draws it',
    );
    await act(async () => {
      (screen.getByPlaceholder('b') as DrawnNode).focus();
    });
    assert.strictEqual(styleOf(el, 'a').outlineStyle, 'none');
    assert.strictEqual(styleOf(el, 'b').outlineStyle, 'none', 'outline: none');
    // a page's own `auto`, and the keyword, are the palette's too
    const c = styleOf(el, 'c');
    assert.deepStrictEqual(
      [c.outlineStyle, c.outlineWidth, c.outlineColor],
      ['auto', 2, '#2980b9'],
    );
  },
);

metric(
  'a field taking the focus is restyled where it is, not built again',
  async () => {
    // a click into a search field is not a restyle of the article around it
    const paragraphs = Array.from(
      { length: 200 },
      (_, i) => `<p>Paragraph ${i} with enough text in it to wrap once.</p>`,
    ).join('');
    const { node } = await render(
      '<style>body{margin:0} .f{border:1px solid #808080;padding:4px}' +
        ' .f:focus{border-color:#0000ff;outline:none}' +
        ' .box:focus-within{background:#eeeeee}</style>' +
        `<div class="box"><input id="q" class="f" placeholder="q"></div>${paragraphs}`,
      300,
    );
    const el = view(node);
    await act();
    const treeOf = () => (el as unknown as { _tree: unknown })._tree;
    const tree = treeOf();
    await act(async () => {
      (screen.getByPlaceholder('q') as DrawnNode).focus();
    });
    assert.strictEqual(styleOf(el, 'q').borderTopColor, '#0000ff');
    assert.ok(treeOf() === tree, 'the document was built again');
    await act(async () => {
      (screen.getByPlaceholder('q') as DrawnNode).blur();
    });
    assert.strictEqual(styleOf(el, 'q').borderTopColor, '#808080');
    assert.ok(treeOf() === tree, 'the document was built again');
  },
);

metric(
  'a field whose widget goes with the focus in it takes its :focus away',
  async () => {
    // core forgets a node that unmounts while focused rather than blurring
    // it, so no blur says the element lost it
    const { node } = await render(
      '<style>input:focus{border:1px solid #0000ff}</style>' +
        '<input id="a" placeholder="a">',
    );
    const el = view(node);
    await act(async () => {
      (screen.getByPlaceholder('a') as DrawnNode).focus();
    });
    const input = findById(el.document, 'a')!;
    assert.strictEqual(el.focusedElement, input);
    await act(async () => {
      input.attribs.style = 'display:none';
      el.touchDocument();
    });
    await waitFor(() =>
      assert.strictEqual(el.focusedElement, null, 'still focused'),
    );
  },
);

test('a control is cut by its own clip and by the boxes that clip it, from its containing block up', async () => {
  // A widget is mounted beside the document, so nothing the document
  // clips with reached it (CSS 2.1 11.1.1): the field of a panel folded
  // to `height: 0; overflow: hidden` — the feedback form at the foot of
  // nextjs.org's docs — was drawn over the page all the same.
  const { node } = await render(
    '<style>body{margin:0}input{margin:0}</style>' +
      '<div style="height:0;overflow:hidden"><input id="folded"></div>' +
      '<div style="width:60px;height:30px;overflow:hidden">' +
      '<input id="half" style="width:150px"></div>' +
      '<div style="width:200px;overflow:hidden">' +
      '<input id="whole" style="width:150px"></div>' +
      // an absolute box is outside a box that clips where its containing
      // block is
      '<div style="position:relative;height:30px">' +
      '<div style="height:0;overflow:hidden">' +
      '<input id="out" style="position:absolute;top:0;left:0"></div></div>' +
      '<div style="position:absolute;top:200px;left:0;' +
      'clip:rect(0,40px,10px,0)"><input id="under"></div>' +
      // a control's own `overflow` cuts a widget that has a size of its
      // own, and not a field, which cuts its own text
      '<input type="checkbox" id="own" style="position:absolute;top:300px;' +
      'left:10px;width:1px;height:1px;overflow:hidden">' +
      '<textarea id="area" style="overflow:auto"></textarea>',
  );
  assert.deepStrictEqual(clipsOf(node), {
    folded: { x: 0, y: 0, width: 400, height: 0 },
    half: { x: 0, y: 0, width: 60, height: 30 },
    whole: null,
    out: null,
    under: { x: 0, y: 200, width: 40, height: 10 },
    own: { x: 10, y: 300, width: 1, height: 1 },
    area: null,
  });
});

test('a control is cut by a clip-path, its own and every one around it', async () => {
  // CSS Masking 1, 5.1. Tailwind 4's `.sr-only` — nextjs.org's sheet has
  // it — hides with `clip-path: inset(50%)` where the older one had
  // `clip: rect(0, 0, 0, 0)`: a control under it was cut to the pixel its
  // own `overflow: hidden` left, which showed, and with no `overflow` was
  // not cut at all. A path cuts all its element holds, a box positioned
  // from outside it too, which a box that clips its overflow lets out.
  const { node } = await render(
    '<style>body{margin:0}input{margin:0}</style>' +
      '<input type="checkbox" id="sr" style="position:absolute;top:50px;' +
      'left:10px;width:1px;height:1px;padding:0;margin:-1px;' +
      'overflow:hidden;clip-path:inset(50%);white-space:nowrap;' +
      'border-width:0">' +
      '<input id="own" style="position:absolute;top:100px;left:0;' +
      'width:100px;clip-path:inset(0 60px 0 0)">' +
      '<div style="height:30px;clip-path:inset(0 0 0 20px)">' +
      '<input id="in" style="width:150px"></div>' +
      '<div style="clip-path:inset(50%)">' +
      '<input id="out" style="position:absolute;top:150px;left:0">' +
      '<input id="fixed" style="position:fixed;top:200px;left:0"></div>' +
      '<div style="width:200px;clip-path:inset(-4px)">' +
      '<input id="whole" style="width:150px"></div>',
  );
  const clips = clipsOf(node) as Record<
    string,
    { x: number; y: number; width: number; height: number } | null
  >;
  assert.deepStrictEqual(
    [clips.sr?.width, clips.sr?.height],
    [0, 0],
    'none of a control hidden for a screen reader alone shows',
  );
  const own = boxOf(view(node), 'own');
  assert.deepStrictEqual(
    clips.own,
    { x: 0, y: 100, width: 40, height: own.height },
    'its own path',
  );
  assert.deepStrictEqual(
    clips.in,
    { x: 20, y: 0, width: 380, height: 30 },
    'the path of a box it is in',
  );
  for (const id of ['out', 'fixed']) {
    assert.deepStrictEqual(
      [clips[id]?.width, clips[id]?.height],
      [0, 0],
      `and of one it is positioned out of (${id})`,
    );
  }
  assert.strictEqual(
    clips.whole,
    null,
    'a path that leaves it whole cuts none',
  );
});

metric(
  'a widget the document cuts is cut on the pixels it is cut at, at a display scale of 2',
  async () => {
    const { node } = await render2x(
      '<style>body{margin:0}input{margin:0}</style>' +
        '<div style="height:12px"></div>' +
        '<div id="cut" style="width:60px;height:20px;overflow:hidden">' +
        '<input id="half" style="width:150px" value="a long value"></div>' +
        '<div style="width:200px;overflow:hidden">' +
        '<input id="whole" style="width:150px"></div>',
    );
    await act();
    const el = view(node);
    const { abs } = el as unknown as DrawnNode;
    const [half, whole] = screen.getAllByRole('textbox') as DrawnNode[];
    const cut = boxOf(el, 'cut');
    const port = portOf(half);
    // The clip is reported in logical pixels, as the rect is: it becomes
    // a style. In device pixels the box sat twice as far from the origin.
    assert.deepStrictEqual(
      [port.abs.x, port.abs.y, port.abs.width, port.abs.height],
      [abs.x + cut.x, abs.y + cut.y, cut.width, cut.height],
      'the box it shows through is the one that clips it',
    );
    assert.strictEqual(port.style.overflow, 'hidden');
    assert.deepStrictEqual(
      [half.abs.x, half.abs.y, half.abs.width],
      [abs.x + cut.x, abs.y + cut.y, 300],
      'and the field in it is where it was, as wide as it was',
    );
    // a widget nothing cuts shows through its own rectangle, uncut: its
    // focus ring is drawn outside it
    const open = portOf(whole);
    assert.deepStrictEqual(
      [open.abs.x, open.abs.y, open.abs.width, open.abs.height],
      [whole.abs.x, whole.abs.y, whole.abs.width, whole.abs.height],
    );
    assert.notStrictEqual(open.style.overflow, 'hidden');
  },
);

metric('a <select> with no options shows nothing', async () => {
  // HTML's `<select>` shows the option it has selected, its first where
  // none is marked, and nothing where it has none. Core's `<Select>` says
  // "Select…" with no value: an application's prompt, not a page's.
  await render(
    '<select id="none"></select><select><option>One</option></select>',
  );
  await act();
  assert.strictEqual(screen.getAllByRole('combobox').length, 2);
  assert.ok(screen.queryByText('One') !== null, 'an option is shown');
  assert.ok(screen.queryByText('Select…') === null, 'and no prompt');
});

test("a control's text is the palette's size, not its parent's", async () => {
  // Chrome gives input, select, button and textarea `font:
  // -webkit-small-control`: the default size less 2pt, 13.33px under any
  // body (Blink's html.css, `LayoutThemeFontProvider::SystemFontSize`). The
  // system here is the palette, whose size core's widgets draw at; at
  // `1em` a control took its parent's, so melbcss.com's select was set at
  // the page's 16px where Chrome's is 13.33, and a select under a 20px
  // body was measured for text the widget in it did not draw. The sheet's
  // pixels are CSS pixels, so a button's palette chrome is too: written from
  // the device look and scaled again by the cascade, it came out doubled.
  // And a text field's widget writes at the size its box was measured for
  const source =
    '<body style="font-size:20px"><span id="t">x</span>' +
    '<input id="i" placeholder="field"><select id="s"><option>a</option></select>' +
    '<button id="b">Go</button><textarea id="a"></textarea>' +
    '<meter id="m"></meter>' +
    '<select id="own" style="font-size:inherit"></select></body>';
  const sizes = async (scale: 1 | 2): Promise<number[][]> => {
    const result = await renderX11(
      h(
        'window',
        { width: 400, height: 200 } as Record<string, unknown>,
        h(
          ThemeProvider,
          { value: { fontSize: 12 } } as Record<string, unknown>,
          h(
            'box',
            { style: { width: 360, flexDirection: 'column' } },
            h(Html, {
              source,
              partial: false,
              fontSize: 16,
              'data-testname': 'doc',
            }),
          ),
        ),
      ),
      {
        ...(FONTS ? { fonts: FONTS } : { backend: 'mock' as const }),
        wrap: false,
        ...(scale === 2 && { scale: 2 }),
      },
    );
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const out = ['t', 'i', 's', 'b', 'a', 'm', 'own'].map(
      (id) =>
        (boxOf(el, id) as unknown as { style: { fontSize: number } }).style
          .fontSize / scale,
    );
    const button = boxOf(el, 'b') as unknown as {
      padTop: number;
      borderTop: number;
    };
    const field = (await screen.findByPlaceholder('field')) as unknown as {
      resolvedTextStyle(): { size: number };
    };
    const written = field.resolvedTextStyle().size / scale;
    await result.unmount();
    return [out, [button.padTop / scale, button.borderTop / scale, written]];
  };
  const [text, chrome] = await sizes(1);
  assert.deepStrictEqual(
    text,
    [20, 12, 12, 12, 12, 20, 20],
    'text, the four controls at the palette size, a meter and a select ' +
      'told to inherit at their parent size',
  );
  assert.deepStrictEqual(
    chrome,
    [12, 1, 12],
    "a button in the palette's chrome, and a field's text at the palette size",
  );
  assert.deepStrictEqual(
    await sizes(2),
    [text, chrome],
    'the same in CSS px at 2x',
  );
});

test("a control's text is the palette's face, not the page's", async () => {
  // Chrome's `-webkit-small-control` is Arial whatever the page is set in
  // (`LayoutThemeFontProvider::DefaultGUIFont`), and a textarea is then
  // `monospace` (Blink's html.css). The system here is the palette, whose
  // face core's widgets draw in: in the document's, the Zen Garden's serif
  // page set its fields in Times where Chrome's are Arial, and a `<Select>`
  // the box was measured for in Times drew its caption in another. A
  // textarea is the code face, as `monospace` is everywhere in the sheet.
  // And a widget draws in the face and at the size its box was measured
  // for, though the provider that names them is inside the window, where
  // the text cascade does not see it
  const faces = FONTS
    ? {
        ...FONTS,
        'Page Face': FONTS.monospace,
        'Palette Face': FONTS['sans-serif'],
        'Code Face': FONTS.monospace,
      }
    : null;
  const source =
    '<body><span id="t">x</span>' +
    '<input id="i" placeholder="field"><select id="s"><option>Opt</option></select>' +
    '<button id="b">Go</button><input id="u" type="submit" value="Send">' +
    '<textarea id="a"></textarea><meter id="m"></meter>' +
    '<select id="own" style="font-family:inherit"></select></body>';
  const families = async (scale: 1 | 2): Promise<string[][]> => {
    const result = await renderX11(
      h(
        'window',
        { width: 500, height: 200 } as Record<string, unknown>,
        h(
          ThemeProvider,
          { value: { fontFamily: 'Palette Face', fontSize: 12 } } as Record<
            string,
            unknown
          >,
          h(
            'box',
            { style: { width: 460, flexDirection: 'column' } },
            h(Html, {
              source,
              partial: false,
              fontFamily: 'Page Face',
              monoFamily: 'Code Face',
              'data-testname': 'doc',
            }),
          ),
        ),
      ),
      {
        ...(faces ? { fonts: faces } : { backend: 'mock' as const }),
        wrap: false,
        ...(scale === 2 && { scale: 2 }),
      },
    );
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const boxes = ['t', 'i', 's', 'b', 'u', 'a', 'm', 'own'].map(
      (id) =>
        (boxOf(el, id) as unknown as { style: { fontFamily: string } }).style
          .fontFamily,
    );
    // what the mounted widgets draw in: the field and the area their own
    // style, the button and the select caption what they inherit
    const drawn = (node: DrawnNode) => {
      const text = (
        node as unknown as {
          resolvedTextStyle(): { family: string; size: number };
        }
      ).resolvedTextStyle();
      return `${text.family} ${text.size / scale}`;
    };
    const widgets = [
      await screen.findByPlaceholder('field'),
      screen.all((n) => n.kind === 'textarea')[0],
      screen.getByText('Send', { selector: 'text', exact: true }),
      screen.getByText('Opt', { selector: 'text', exact: true }),
    ].map(drawn);
    await result.unmount();
    return [boxes, widgets];
  };
  const [boxes, widgets] = await families(1);
  assert.deepStrictEqual(
    boxes,
    [
      'Page Face',
      'Palette Face',
      'Palette Face',
      'Palette Face',
      'Palette Face',
      'Code Face',
      'Page Face',
      'Page Face',
    ],
    "text, four controls in the palette's face, a textarea in the code " +
      'face, a meter and a select told to inherit in the page face',
  );
  assert.deepStrictEqual(
    widgets,
    ['Palette Face 12', 'Code Face 12', 'Palette Face 12', 'Palette Face 12'],
    'each widget draws in the face and at the size its box was measured for',
  );
  assert.deepStrictEqual(await families(2), [boxes, widgets], 'the same at 2x');
});

test('a control the page set in its own font draws in it', async () => {
  // `font` applies to every element (CSS Fonts 4), and the UA sheet only
  // sets a control's default: a reset's `input, select, button, textarea {
  // font: inherit }` puts them in the page's face and size, in Chrome as
  // here. The box was measured in that font, and the widget in it drew in
  // the palette's, which the frame named whatever the element's was: a
  // field's text, a submit button's label and a select's caption at 12px
  // in a hole cut for 20
  const faces = FONTS
    ? {
        ...FONTS,
        'Page Face': FONTS.monospace,
        'Palette Face': FONTS['sans-serif'],
      }
    : null;
  const source =
    '<style>input, select, button, textarea { font: inherit }</style>' +
    '<body style="font-size:20px">' +
    '<input id="i" placeholder="field"><textarea id="a"></textarea>' +
    '<input id="u" type="submit" value="Send">' +
    '<select id="s"><option>Opt</option></select></body>';
  const fonts = async (scale: 1 | 2): Promise<string[][]> => {
    const result = await renderX11(
      h(
        'window',
        { width: 600, height: 200 } as Record<string, unknown>,
        h(
          ThemeProvider,
          { value: { fontFamily: 'Palette Face', fontSize: 12 } } as Record<
            string,
            unknown
          >,
          h(
            'box',
            { style: { width: 560, flexDirection: 'column' } },
            h(Html, {
              source,
              partial: false,
              fontFamily: 'Page Face',
              'data-testname': 'doc',
            }),
          ),
        ),
      ),
      {
        ...(faces ? { fonts: faces } : { backend: 'mock' as const }),
        wrap: false,
        ...(scale === 2 && { scale: 2 }),
      },
    );
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const boxes = ['i', 'a', 'u', 's'].map((id) => {
      const { style } = boxOf(el, id) as unknown as {
        style: { fontFamily: string; fontSize: number };
      };
      return `${style.fontFamily} ${style.fontSize / scale}`;
    });
    // what the widgets draw in: a field's and an area's own text, and the
    // text of a button's label and a select's caption
    const drawn = (node: DrawnNode) => {
      const text = (
        node as unknown as {
          resolvedTextStyle(): { family: string; size: number };
        }
      ).resolvedTextStyle();
      return `${text.family} ${text.size / scale}`;
    };
    const widgets = [
      await screen.findByPlaceholder('field'),
      screen.all((n) => n.kind === 'textarea')[0],
      screen.getByText('Send', { selector: 'text', exact: true }),
      screen.getByText('Opt', { selector: 'text', exact: true }),
    ].map(drawn);
    await result.unmount();
    return [boxes, widgets];
  };
  const [boxes, widgets] = await fonts(1);
  assert.deepStrictEqual(
    boxes,
    ['Page Face 20', 'Page Face 20', 'Page Face 20', 'Page Face 20'],
    "each control's box in the page's face and size",
  );
  assert.deepStrictEqual(
    widgets,
    boxes,
    'each widget draws in the face and at the size its box was measured in',
  );
  assert.deepStrictEqual(await fonts(2), [boxes, widgets], 'the same at 2x');
});
