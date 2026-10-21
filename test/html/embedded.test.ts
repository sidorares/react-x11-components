// <Html> — what a host mounts over an `<iframe>`, a `<canvas>` or an
// `<embed>` (`renderEmbedded`, `src/html/embedded.ts`): at the element's
// content box, beside the document, held to the rules a video's player is.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import {
  act,
  cleanup,
  expectPixel,
  fireEvent,
  renderX11,
  screen,
  userEvent,
} from 'react-x11/test';
import type { DrawnNode, KeyboardEvent } from 'react-x11';
import { XK_BACKSPACE, XK_LEFT } from 'react-x11/keysyms';
import { parseDocument } from 'htmlparser2';
import { Image } from 'react-x11/ntk';
import { Html, useHtmlHandle } from '../../src/html/index.js';
import type { Element, HtmlViewNode } from '../../src/html/index.js';
import type { EmbeddedRect, HtmlDomEvent } from '../../src/html/index.js';
import { FONTS, h, metric } from './harness.js';

afterEach(cleanup);

/** A document whose host fills each embedded element with a box of its
 *  own, named for the element's id, and keeps what it was asked about. */
async function renderEmbedded(
  source: string,
  {
    width = 300,
    height = 300,
    scale,
  }: { width?: number; height?: number; scale?: number } = {},
) {
  const asked: EmbeddedRect[] = [];
  const doc = (src: string) =>
    h(Html, {
      source: src,
      partial: false,
      'data-testname': 'doc',
      renderEmbedded: (rect: EmbeddedRect) => {
        asked.push(rect);
        const id = rect.element.attribs.id;
        if (id === 'declined') return null;
        return h('box', {
          'data-testname': `in-${id}`,
          style: { flexGrow: 1, backgroundColor: '#ff0000' },
        });
      },
    });
  const tree = (src: string, w = width) =>
    h(
      'box',
      { style: { width: w, height, flexDirection: 'column' } },
      doc(src),
    );
  const result = await renderX11(tree(source), {
    width: width + 40,
    height: height + 40,
    ...(FONTS && { fonts: FONTS }),
    ...(scale && { scale }),
  });
  await act();
  return {
    result,
    asked,
    rerender: (src: string, w?: number) =>
      act(() => result.rerender(tree(src, w))),
  };
}

/** An element of a document, by its id. */
function byId(node: Element, id: string): Element {
  const all = (n: Element): Element[] => [
    n,
    ...((n.children ?? []) as Element[]).flatMap(all),
  ];
  const found = all(node).find((n) => n.attribs?.id === id);
  assert.ok(found, `#${id}`);
  return found;
}

/** The box a mount shows through: the host's node is in the box that
 *  carries its scale, which is in the frame, which is in the port. */
const portOf = (node: DrawnNode): DrawnNode =>
  (node as unknown as { parent: { parent: { parent: DrawnNode } } }).parent
    .parent.parent;

const mounted = (id: string): DrawnNode | null => {
  try {
    return screen.getByTestName(`in-${id}`) as DrawnNode;
  } catch {
    return null;
  }
};

test('an iframe, a canvas and an embed are each given what the host returns, at the content box', async () => {
  const { asked } = await renderEmbedded(
    '<style>body{margin:0}iframe{border:3px solid;padding:2px}</style>' +
      '<iframe id="f" width="120" height="60"></iframe>' +
      '<canvas id="c" width="50" height="40"></canvas>' +
      '<embed id="e" width="30" height="20">' +
      '<video id="v" width="30" height="20"></video>' +
      '<iframe id="gone" style="display:none"></iframe>' +
      '<iframe id="declined" width="10" height="10"></iframe>',
  );
  // a video is a player's, a box with no layout is none, and the host may
  // answer nothing for one
  assert.deepStrictEqual(
    asked.map((r) => `${r.element.attribs.id}:${r.kind}`).sort(),
    ['c:canvas', 'declined:iframe', 'e:embed', 'f:iframe'].sort(),
  );
  const frame = asked.find((r) => r.element.attribs.id === 'f')!;
  // inside the border and the padding
  assert.deepStrictEqual(
    [frame.x, frame.y, frame.width, frame.height],
    [5, 5, 120, 60],
  );
  const node = mounted('f')!;
  assert.deepStrictEqual(
    [node.abs.x, node.abs.y, node.abs.width, node.abs.height],
    [5, 5, 120, 60],
  );
  assert.ok(mounted('c') && mounted('e'), 'the canvas and the embed');
  assert.strictEqual(mounted('declined'), null, 'nothing for a null');
});

test('a mount is cut where the document clips the element', async () => {
  const { asked } = await renderEmbedded(
    '<style>body{margin:0}#clip{overflow:hidden;width:80px;height:200px}</style>' +
      '<div style="height:10px"></div>' +
      '<div id="clip"><iframe id="f" width="150" height="50" style="border:0"></iframe></div>',
  );
  const rect = asked.at(-1)!;
  assert.deepStrictEqual(rect.clip, { x: 0, y: 10, width: 80, height: 50 });
  // the host's node, in the box that scales it, in the frame, in the port
  const port = portOf(mounted('f')!);
  assert.deepStrictEqual(
    [port.abs.x, port.abs.y, port.abs.width, port.abs.height],
    [0, 10, 80, 50],
  );
});

for (const scale of [1, 2]) {
  test(`a frame in a scaled box is mounted where it is drawn, cut where it is drawn, and laid out at its own size, at ${scale}x`, async () => {
    // a slide deck fits each slide to the window with a scale on its stage,
    // and a frame on a slide was refused for being drawn through a matrix:
    // its document ran, and nothing of it was drawn
    const { asked } = await renderEmbedded(
      '<style>body{margin:0}iframe{border:0;display:block}' +
        '#stage{width:400px;height:200px;transform-origin:0 0;' +
        'transform:scale(0.5) translate(20px, 10px)}' +
        '#clip{overflow:hidden;width:300px;height:200px}</style>' +
        '<div style="height:10px"></div>' +
        '<div id="stage"><div id="clip">' +
        '<iframe id="f" width="400" height="100"></iframe></div></div>',
      { scale },
    );
    const rect = asked.at(-1);
    assert.ok(rect, 'the frame was asked about');
    // the stage moves by the translation, scaled: 10 across, 5 down from
    // where it is laid out, and draws everything in it at half its size
    assert.deepStrictEqual(
      [rect.x, rect.y, rect.width, rect.height, rect.zoom],
      [10, 15, 200, 50, 0.5],
    );
    // the box that clips it is 300 wide, 150 where it is drawn
    assert.deepStrictEqual(rect.clip, { x: 10, y: 15, width: 150, height: 50 });
    const node = mounted('f');
    assert.ok(node, 'mounted');
    // what the host returned is drawn at the rect, in device pixels...
    assert.deepStrictEqual(
      [node.abs.x, node.abs.y, node.abs.width, node.abs.height],
      [10 * scale, 15 * scale, 200 * scale, 50 * scale],
    );
    // ...laid out at the frame's own size, under core's scale
    assert.strictEqual(
      (node as unknown as { scale: number }).scale,
      0.5 * scale,
    );
    const port = portOf(node);
    assert.deepStrictEqual(
      [port.abs.x, port.abs.y, port.abs.width, port.abs.height],
      [10 * scale, 15 * scale, 150 * scale, 50 * scale],
    );
  });
}

test('a frame in a box fixed to the viewport stays where the viewport is as the pane scrolls, scaled, at 1x and 2x', async () => {
  // a slide deck: fixed over the window, its stage scaled to fit it, a
  // frame on the slide. Mounted at its rect beside the document, the frame
  // would scroll away from the slide; it is kept where the viewport is, as
  // a widget in a fixed header is (`AT_VIEWPORT`)
  const source =
    '<style>body{margin:0}iframe{border:0;display:block}' +
    '#deck{position:fixed;inset:0}' +
    '#stage{transform-origin:0 0;transform:scale(0.5)}</style>' +
    '<div id="deck"><div id="stage"><div style="height:40px"></div>' +
    '<iframe id="f" width="400" height="100"></iframe></div></div>' +
    '<div style="height:2000px"></div>';
  for (const scale of [1, 2]) {
    const asked: EmbeddedRect[] = [];
    let pane: (DrawnNode & { scrollTo(y: number): void }) | null = null;
    await renderX11(
      h(
        'box',
        {
          ref: (node: typeof pane) => {
            pane = node;
          },
          style: { width: 400, height: 200, overflow: 'scroll' },
        },
        h(Html, {
          source,
          partial: false,
          renderEmbedded: (rect: EmbeddedRect) => {
            asked.push(rect);
            return h('box', {
              'data-testname': 'in-f',
              style: { flexGrow: 1 },
            });
          },
        }),
      ),
      { width: 440, height: 240, scale, ...(FONTS && { fonts: FONTS }) },
    );
    await act();
    const rect = asked.at(-1);
    assert.ok(rect, `asked, ${scale}x`);
    assert.deepStrictEqual(
      [rect.x, rect.y, rect.width, rect.height, rect.zoom, rect.atViewport],
      [0, 20, 200, 50, 0.5, true],
      `${scale}x`,
    );
    const node = mounted('f')!;
    const onScreen = () => (node.abs.y - pane!.abs.y) / scale;
    assert.strictEqual(onScreen(), 20, `where the slide draws it, ${scale}x`);
    const reports = asked.length;
    for (const y of [500, 120, 0]) {
      await act(async () => pane!.scrollTo(y));
      assert.strictEqual(onScreen(), 20, `scrolled to ${y}, ${scale}x`);
    }
    assert.strictEqual(asked.length, reports, 'a scroll asks nothing again');
    cleanup();
  }
});

test('a press on a scaled mount reaches the point of its document it is drawn over, at 1x and 2x', async () => {
  // the frame's document is laid out at 400 by 100 and drawn at half that:
  // a link 30px tall over one 70px tall meet 15px down where it is drawn,
  // so a press 19px down is in the second, and in the first were the
  // press read in the document's own pixels
  for (const scale of [1, 2]) {
    const clicks: string[] = [];
    await renderX11(
      h(
        'box',
        { style: { width: 300, height: 300, flexDirection: 'column' } },
        h(Html, {
          source:
            '<style>body{margin:0}iframe{border:0;display:block}</style>' +
            '<div style="height:10px"></div>' +
            '<div style="transform-origin:0 0;transform:scale(0.5)">' +
            '<iframe width="400" height="100"></iframe></div>',
          partial: false,
          renderEmbedded: () =>
            h(Html, {
              'data-testname': 'inner',
              partial: false,
              source:
                '<style>body{margin:0}a{display:block;height:30px}' +
                '#two{height:70px}</style>' +
                '<a href="#one">one</a><a id="two" href="#two">two</a>',
              onLink: (href: string) => clicks.push(href),
            }),
        }),
      ),
      { width: 340, height: 340, scale, ...(FONTS && { fonts: FONTS }) },
    );
    await act();
    const inner = screen.getByTestName('inner') as DrawnNode;
    // from the middle of what is drawn, 25px down: 19px and 11px down
    for (const dy of [-6, -14]) {
      const at = { dx: 0, dy: dy * scale };
      await act(async () => {
        fireEvent.mouseDown(inner, at);
        fireEvent.mouseUp(inner, at);
      });
    }
    assert.deepStrictEqual(clicks, ['#two', '#one'], `${scale}x`);
    cleanup();
  }
});

test('a frame in a box that turns, skews, flips, scales one way more than the other or turns out of the plane is still refused', async () => {
  const transforms = [
    'rotate(10deg)',
    'skewX(10deg)',
    'scale(0.5, 0.6)',
    'scale(-1)',
    'perspective(400px) rotateY(20deg)',
  ];
  const { asked } = await renderEmbedded(
    '<style>body{margin:0}iframe{border:0;display:block}</style>' +
      transforms
        .map(
          (t, i) =>
            `<div style="transform:${t}"><iframe id="t${i}" width="40" height="20"></iframe></div>`,
        )
        .join('') +
      '<div style="transform:scale(2)"><iframe id="ok" width="40" height="20"></iframe></div>',
  );
  assert.deepStrictEqual(
    [...new Set(asked.map((r) => r.element.attribs.id))],
    ['ok'],
    'only the even scale',
  );
  assert.strictEqual(asked.at(-1)!.zoom, 2);
});

test('a mount and a focus stop a scroll container holds out of sight make the document no taller', async () => {
  // up.com.au: the whole page in a `main` a viewport tall that scrolls,
  // with a canvas in a section that clips it and a link at the end, far
  // below; mounted at their own places beside the document, the box that
  // scrolls it reached down to them
  const asked: EmbeddedRect[] = [];
  await renderX11(
    h(
      'box',
      {
        'data-testname': 'pane',
        style: { width: 300, height: 200, overflow: 'scroll' },
      },
      h(Html, {
        source:
          '<style>body{margin:0}main{height:150px;overflow-y:scroll}' +
          'section{overflow:hidden;height:80px}</style>' +
          '<main><div style="height:400px"></div>' +
          '<section><canvas id="c" width="50" height="40"></canvas></section>' +
          '<div style="height:400px"></div><a href="#end">end</a></main>',
        partial: false,
        renderEmbedded: (rect: EmbeddedRect) => {
          asked.push(rect);
          return h('box', { style: { flexGrow: 1 } });
        },
      }),
    ),
    { width: 340, height: 240, ...(FONTS && { fonts: FONTS }) },
  );
  await act();
  const rect = asked.at(-1)!;
  assert.deepStrictEqual(
    [rect.y, rect.height],
    [400, 40],
    'the canvas, where it is laid out',
  );
  assert.ok(rect.clip, 'cut');
  assert.deepStrictEqual(
    [rect.clip.width, rect.clip.height],
    [0, 0],
    'to nothing',
  );
  assert.ok(
    rect.clip.y >= 0 && rect.clip.y <= 150,
    `inside the main that clips it: ${JSON.stringify(rect.clip)}`,
  );
  const pane = screen.getByTestName('pane') as unknown as {
    contentHeight: number;
  };
  assert.ok(
    pane.contentHeight <= 150,
    `the pane reaches as far as the main: ${pane.contentHeight}`,
  );
});

test('a focus stop a clip holds out of sight is placed inside the clip at 2x as well', async () => {
  // the Zen Garden's 214: a link a clipping box hides had its stop placed
  // by the clip's device pixels as though they were logical ones, twice as
  // far out, and the pane around the document scrolled sideways into
  // nothing to reach it
  await renderX11(
    h(
      'box',
      {
        'data-testname': 'pane',
        style: { width: 300, height: 200, overflow: 'scroll' },
      },
      h(Html, {
        source:
          '<style>body{margin:0}main{height:150px;overflow:hidden}' +
          'nav{width:200px;overflow:hidden;white-space:nowrap}</style>' +
          '<main><nav><span style="display:inline-block;width:400px"></span>' +
          '<a href="#side">side</a></nav>' +
          '<div style="height:400px"></div><a href="#end">end</a></main>',
        partial: false,
      }),
    ),
    { width: 340, height: 240, scale: 2, ...(FONTS && { fonts: FONTS }) },
  );
  await act();
  const pane = screen.getByTestName('pane') as unknown as {
    contentWidth: number;
    contentHeight: number;
  };
  assert.ok(
    pane.contentWidth <= 300 * 2,
    `the pane reaches across no further than the page: ${pane.contentWidth}`,
  );
  assert.ok(
    pane.contentHeight <= 150 * 2,
    `the pane reaches down as far as the main: ${pane.contentHeight}`,
  );
});

test('what reaches a mount only where nothing of it is drawn takes nothing from it', async () => {
  // a pane beside the frame whose content runs on under a box that clips
  // it, as an editor's does, and a menu's backdrop fixed over the whole
  // viewport, hidden, as Docusaurus keeps one: the frame is mounted, uncut
  const { asked } = await renderEmbedded(
    '<style>body{margin:0}.row{display:flex}' +
      '.pane{width:100px;height:60px;overflow:hidden}' +
      '.wide{width:600px;height:10px;background:#00f}' +
      '.backdrop{position:fixed;inset:0;visibility:hidden;opacity:0;background:#000}' +
      'iframe{border:0;margin-left:50px}</style>' +
      '<div class="backdrop"></div>' +
      '<div class="row"><div class="pane"><div class="wide"></div></div>' +
      '<iframe id="f" width="120" height="60"></iframe></div>',
  );
  const frame = asked.at(-1);
  assert.ok(frame, 'the frame was asked about');
  assert.deepStrictEqual(
    [frame.x, frame.y, frame.width, frame.height],
    [150, 0, 120, 60],
  );
  assert.strictEqual(frame.clip, undefined, 'nothing cuts it');
  assert.ok(!frame.hidden, 'nor hides it');
  assert.ok(mounted('f'), 'mounted');
});

metric(
  'a canvas the host has a picture of is drawn in its box, in its place in the paint order, and again when it changes',
  async () => {
    // a 4 by 1 picture, red then blue, stretched over a canvas 40 by 20,
    // under a box positioned over its right half
    const picture = (left: number[], right: number[]) =>
      new Image({
        width: 4,
        height: 1,
        data: new Uint8Array([
          ...left,
          255,
          ...left,
          255,
          ...right,
          255,
          ...right,
          255,
        ]),
      });
    let image = picture([255, 0, 0], [0, 0, 255]);
    const result = await renderX11(
      h(
        'box',
        { style: { width: 200, height: 100 } },
        h(Html, {
          source:
            '<style>body{margin:0}canvas{display:block;width:40px;height:20px}' +
            '#over{position:absolute;left:30px;top:0;width:20px;height:20px;background:#00ff00}</style>' +
            '<canvas id="c" width="4" height="1"></canvas><div id="over"></div>',
          partial: false,
          'data-testname': 'doc',
          canvasImage: () => image,
        }),
      ),
      { width: 240, height: 140, ...(FONTS && { fonts: FONTS }) },
    );
    await act();
    await expectPixel(result.ctx, 10, 10, '#ff0000', { message: 'its left' });
    await expectPixel(result.ctx, 25, 10, '#0000ff', { message: 'its right' });
    await expectPixel(result.ctx, 35, 10, '#00ff00', {
      message: 'and what the document paints after it, over it',
    });
    image = picture([255, 255, 0], [0, 0, 255]);
    const view = (
      screen.getByTestName('doc') as unknown as { children: HtmlViewNode[] }
    ).children[0];
    const canvas = byId(view.document as unknown as Element, 'c');
    await act(async () => view.canvasChanged(canvas));
    await expectPixel(result.ctx, 10, 10, '#ffff00', {
      message: 'drawn again as it changes',
    });
  },
);

test('a box over the viewport that draws nothing of its own keeps no frame from being mounted under it', async () => {
  // up.com.au's menu overlay: fixed over the whole viewport, transparent
  // until the menu opens, with the menu's button inside it at its foot
  const { asked } = await renderEmbedded(
    '<style>body{margin:0}iframe{border:0}' +
      '.overlay{position:fixed;inset:0;z-index:10;background:transparent;pointer-events:none}' +
      '.overlay button{position:absolute;bottom:0;left:0}</style>' +
      '<iframe id="f" width="120" height="60"></iframe>' +
      '<div class="overlay"><button>Menu</button></div>',
  );
  assert.ok(mounted('f'), 'mounted');
  assert.ok(!asked.at(-1)?.hidden, 'and shown');
});

test('a mount stays the same node as a layout moves its element', async () => {
  // a new node would be a new document in an iframe, its scripts started
  // again; a new source is a new document, and a new node is right there
  const page =
    '<style>body{margin:0;text-align:center}</style>' +
    '<iframe id="f" width="100" height="50" style="border:0"></iframe>';
  const { rerender } = await renderEmbedded(page, { width: 300 });
  const first = mounted('f')!;
  assert.strictEqual(first.abs.x, 100);
  await rerender(page, 200);
  assert.strictEqual(mounted('f'), first, 'the same node');
  assert.strictEqual(first.abs.x, 50, 'moved with the element');
});

metric(
  'what is mounted is drawn over the box the document leaves empty',
  async () => {
    const { result } = await renderEmbedded(
      '<style>body{margin:0}</style>' +
        '<iframe id="f" width="100" height="50" style="border:0"></iframe>',
    );
    await expectPixel(result.ctx, 50, 25, '#ff0000', {
      message: 'the host’s red in the frame',
    });
  },
);

metric(
  'a document handed over is drawn in place of the source, and drawn again as the host changes it',
  async () => {
    // a frame's document, which a browser holds and a page's scripts write
    // into: drawn as it is, and told of a change through the handle
    const document = parseDocument(
      '<style>body{margin:0}div{width:100px;height:50px}</style>' +
        '<div id="d" style="background:#00ff00"></div>',
    );
    let handle: ReturnType<typeof useHtmlHandle> | null = null;
    function Frame() {
      handle = useHtmlHandle();
      return h(Html, {
        source: '<p>not read</p>',
        document,
        partial: false,
        ref: handle.ref,
      });
    }
    const result = await renderX11(
      h('box', { style: { width: 200, height: 100 } }, h(Frame)),
      { width: 200, height: 100, ...(FONTS && { fonts: FONTS }) },
    );
    await act();
    assert.strictEqual(handle!.document, document, 'the tree it was handed');
    await expectPixel(result.ctx, 50, 25, '#00ff00');
    const div = (document.children as Element[])
      .flatMap((n) => (n.type === 'tag' ? [n] : []))
      .find((n) => n.attribs.id === 'd')!;
    div.attribs.style = 'background:#0000ff';
    await act(() => handle!.refresh());
    await expectPixel(result.ctx, 50, 25, '#0000ff', {
      message: 'the change drawn',
    });
  },
);

test("a key typed in an iframe's document is that document's: the embedding page neither hears it nor cancels it", async () => {
  const told: string[] = [];
  const heard: [number, boolean][] = [];
  await renderX11(
    h(
      'box',
      { style: { width: 300, height: 200, flexDirection: 'column' } },
      h(Html, {
        source:
          '<style>body{margin:0}iframe{border:0;display:block}</style>' +
          '<input id="a"><iframe id="f" width="200" height="100"></iframe>',
        partial: false,
        // a page that takes every key for its own, as a slide deck's
        // arrows are
        onDomEvent: (e: HtmlDomEvent) => {
          if (e.type !== 'keydown') return undefined;
          told.push(`${e.key}:${e.target.attribs.id ?? e.target.name}`);
          return false;
        },
        renderEmbedded: () =>
          h('box', {
            'data-testname': 'in-f',
            tabIndex: 0,
            style: { flexGrow: 1 },
            onKeyDown: (ev: KeyboardEvent<DrawnNode>) =>
              void heard.push([ev.keysym!, ev.defaultPrevented]),
          }),
      }),
    ),
    { width: 340, height: 240, ...(FONTS && { fonts: FONTS }) },
  );
  await act();
  const inner = screen.getByTestName('in-f') as DrawnNode;
  await act(() => inner.focus());
  await userEvent.key(XK_LEFT, { target: inner });
  await userEvent.key(XK_BACKSPACE, { target: inner });
  assert.deepStrictEqual(
    heard,
    [
      [XK_LEFT, false],
      [XK_BACKSPACE, false],
    ],
    'the frame has each key, none cancelled',
  );
  assert.deepStrictEqual(told, [], 'the page is told of none');
  // and the page's own keys are still the page's
  await userEvent.type(screen.getByRole('textbox') as DrawnNode, 'x');
  assert.deepStrictEqual(told, ['x:a']);
});
