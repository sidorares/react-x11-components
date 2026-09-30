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
  waitFor,
} from 'react-x11/test';
import { ThemeProvider } from 'react-x11';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import {
  FONTS,
  boxOf,
  edgesOf,
  h,
  metric,
  render,
  render2x,
  view,
} from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

metric('form controls carry default margins from the UA sheet', async () => {
  const { node } = await render('<p>a <input size="4"> b</p>');
  const tree = (
    view(node) as unknown as {
      _tree: {
        root: {
          children: {
            children: {
              replaced: string;
              marginTop: number;
              marginLeft: number;
            }[];
          }[];
        };
      };
    }
  )._tree;
  const input = tree.root.children[0].children.find(
    (c) => c.replaced === 'input',
  );
  assert.ok(input, 'the input box exists');
  assert.ok(
    input.marginTop >= 2,
    `vertical breathing room (${input.marginTop})`,
  );
  assert.ok(
    input.marginLeft >= 1,
    `horizontal breathing room (${input.marginLeft})`,
  );
});

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
            '<button id="bare" style="appearance:none">Go</button>',
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
