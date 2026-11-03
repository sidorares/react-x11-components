// <Html> — what a host mounts over an `<iframe>`, a `<canvas>` or an
// `<embed>` (`renderEmbedded`, `src/html/embedded.ts`): at the element's
// content box, beside the document, held to the rules a video's player is.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { useEffect } from 'react';
import {
  act,
  cleanup,
  expectPixel,
  fireEvent,
  isNear,
  pixelAt,
  renderX11,
  screen,
  userEvent,
  waitFor,
} from 'react-x11/test';
import type { DrawnNode, KeyboardEvent } from 'react-x11';
import { XK_BACKSPACE, XK_LEFT } from 'react-x11/keysyms';
import { parseDocument } from 'htmlparser2';
import { Image } from 'react-x11/ntk';
import { Html, useHtmlHandle } from '../../src/html/index.js';
import type { Element, HtmlViewNode } from '../../src/html/index.js';
import type {
  EmbeddedRect,
  FormSubmission,
  HtmlDomEvent,
  ResourceRequest,
} from '../../src/html/index.js';
import { resourceResult } from '../../src/html/network.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import {
  FONTS,
  PAGE,
  RED_PNG,
  boxOf,
  findById,
  h,
  metric,
  view,
} from './harness.js';

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

test("a frame's document is laid out again at a zoom that changes, drawn at the zooms it is under, at 1x and 2x", async () => {
  // WPT's zoom/iframe-zoom-nested.html: a frame's script sets the zoom of
  // the `<iframe>` it holds once the document in it is laid out. Core lays
  // the document out again under the new scale, at the width it now has
  // in device pixels, and nothing told the document its lengths were
  // device pixels of another scale: laid out with the styles it had, a box
  // 20px wide in a frame zoomed by 3 was 40 device pixels wide, not 60
  for (const scale of [1, 2]) {
    const tree = (zoom: number) =>
      h(
        'box',
        { style: { width: 300, height: 300, flexDirection: 'column' } },
        h(Html, {
          source:
            '<style>body{margin:0}iframe{border:0;display:block;' +
            'width:100px;height:50px}</style>' +
            '<div style="zoom:1.5"><iframe id="f"></iframe></div>',
          stylesheet: `iframe{zoom:${zoom}}`,
          partial: false,
          renderEmbedded: () =>
            h(Html, {
              'data-testname': 'leaf',
              partial: false,
              source:
                '<style>body{margin:0}</style><div id="t" style="' +
                'width:20px;height:10px;margin-left:5px;background:#ff0000">' +
                '</div>',
            }),
        }),
      );
    const result = await renderX11(tree(1), {
      width: 340,
      height: 340,
      scale,
      ...(FONTS && { fonts: FONTS }),
    });
    await act();
    const across = (): number[] => {
      const t = boxOf(view(screen.getByTestName('leaf') as DrawnNode), 't');
      return [t.x, t.width, t.height];
    };
    assert.deepStrictEqual(
      across(),
      [7.5 * scale, 30 * scale, 15 * scale],
      `at the zoom it is drawn at, ${scale}x`,
    );
    await act(async () => result.rerender(tree(2)));
    await act();
    assert.deepStrictEqual(
      across(),
      [15 * scale, 60 * scale, 30 * scale],
      `at the zooms' product once one changes, ${scale}x`,
    );
    // and drawn there: red to 75 across and 30 down, and not past
    await expectPixel(result.ctx, 70 * scale, 25 * scale, '#ff0000');
    await expectPixel(result.ctx, 80 * scale, 25 * scale, '#ffffff');
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

test('a frameborder that says none takes away the border every frame has, and a style wins over it', async () => {
  const { asked } = await renderEmbedded(
    '<style>body{margin:0}iframe{display:block;width:40px;height:10px}</style>' +
      '<iframe id="zero" frameborder="0"></iframe>' +
      '<iframe id="word" frameborder="no"></iframe>' +
      '<iframe id="one" frameborder="1"></iframe>' +
      '<iframe id="none"></iframe>' +
      '<iframe id="styled" frameborder="0" style="border:3px solid #000"></iframe>',
  );
  const edge = Object.fromEntries(
    asked.map((rect) => [rect.element.attribs.id, rect.width]),
  );
  assert.deepStrictEqual(
    {
      zero: edge.zero,
      word: edge.word,
      one: edge.one,
      none: edge.none,
      styled: edge.styled,
    },
    { zero: 40, word: 40, one: 40, none: 40, styled: 40 },
  );
  const left = Object.fromEntries(
    asked.map((rect) => [rect.element.attribs.id, rect.x]),
  );
  assert.deepStrictEqual(
    {
      zero: left.zero,
      word: left.word,
      one: left.one,
      none: left.none,
      styled: left.styled,
    },
    { zero: 0, word: 0, one: 2, none: 2, styled: 3 },
  );
});

test('a frame says the colour scheme of its element, and a document in another is on a canvas of its own', async () => {
  // JSFiddle's page is dark and a fiddle's document says it is light, which
  // a browser shows on white and which was drawn dark on dark
  const { asked } = await renderEmbedded(
    '<style>:root{color-scheme:dark}body{margin:0}iframe{border:0;display:block}</style>' +
      '<iframe id="f" width="50" height="50"></iframe>',
  );
  assert.strictEqual(asked.at(-1)?.colorScheme, 'dark');
  cleanup();
  const inner = (root: string, around?: 'light' | 'dark') =>
    h(
      'box',
      {
        style: {
          width: 60,
          height: 60,
          flexDirection: 'column',
          backgroundColor: '#ff0000',
        },
      },
      h(Html, {
        source: `<style>:root{color-scheme:${root}}</style>`,
        partial: false,
        style: { flexGrow: 1 },
        ...({ _embedderScheme: around } as object),
      }),
    );
  const sizes = { width: 100, height: 100, ...(FONTS && { fonts: FONTS }) };
  const light = await renderX11(inner('light', 'dark'), sizes);
  await expectPixel(light.ctx, 30, 30, '#ffffff', {
    message: 'a light document in a dark frame',
  });
  cleanup();
  const same = await renderX11(inner('dark', 'dark'), sizes);
  await expectPixel(same.ctx, 30, 30, '#ff0000', {
    message: 'and one of its scheme shows what is under it',
  });
});

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

test('a box fixed to the viewport that the document paints before a frame is under it, and one painted after is over it', async () => {
  // joshwcomeau.com's floating like button, fixed beside its article and
  // before a playground in the tree: the playground's frame, positioned,
  // is painted over it, and was hidden whole for it, inside its rect
  const page = (after: boolean) =>
    '<style>body{margin:0}iframe{border:0;display:block;position:absolute;' +
    'top:0;left:0;width:200px;height:100px}' +
    '.like{position:fixed;top:30px;left:80px;width:20px;height:20px;background:#f00}' +
    '.wrap{position:relative;width:200px;height:100px}</style>' +
    (after ? '' : '<div class="like"></div>') +
    '<div class="wrap"><iframe id="f"></iframe></div>' +
    (after ? '<div class="like"></div>' : '');
  const under = await renderEmbedded(page(false));
  assert.ok(mounted('f'), 'mounted');
  assert.ok(!under.asked.at(-1)?.hidden, 'and shown, over the box');
  cleanup();
  const over = await renderEmbedded(page(true));
  const frame = over.asked.at(-1);
  assert.ok(!frame?.hidden, 'and shown under one painted after it');
  assert.deepStrictEqual(
    frame?.over,
    { x: 80, y: 30, width: 20, height: 20 },
    'which is painted over it again',
  );
});

for (const position of ['absolute', 'fixed']) {
  test(`what a page puts ${position} over part of a frame is drawn over its mount, and a press on it is the page's`, async () => {
    // JSFiddle's ad sits in a corner of its result pane, and left no
    // rectangle of the frame to mount, so a page's result was never shown
    const links: string[] = [];
    const presses: string[] = [];
    const source =
      '<style>body{margin:0}iframe{border:0;display:block;width:200px;height:200px}' +
      `.ad{position:${position};left:120px;top:120px;width:60px;height:40px;` +
      'background:rgb(0,0,255)}.wrap{position:relative;width:200px}</style>' +
      '<div class="wrap"><iframe id="f"></iframe>' +
      '<a class="ad" href="https://example.test/close"></a></div>';
    const result = await renderX11(
      h(
        'box',
        { style: { width: 200, height: 200, flexDirection: 'column' } },
        h(Html, {
          source,
          partial: false,
          baseUrl: 'https://example.test/',
          onLink: (href: string) => void links.push(href),

          renderEmbedded: () =>
            h('box', {
              'data-testname': 'in-f',
              style: { flexGrow: 1, backgroundColor: '#ff0000' },
              onMouseDown: () => void presses.push('frame'),
            }),
        }),
      ),
      { width: 240, height: 240, ...(FONTS && { fonts: FONTS }) },
    );
    await act();
    assert.ok(mounted('f'), 'the frame is mounted');
    await expectPixel(result.ctx, 20, 20, '#ff0000', { message: 'the frame' });
    await expectPixel(result.ctx, 190, 190, '#ff0000', {
      message: 'the frame beyond it',
    });
    await expectPixel(result.ctx, 150, 140, '#0000ff', {
      message: 'what is over it',
    });
    // through the server, which finds what is under the point
    const { server } = result as unknown as {
      server: {
        injectPointerMove(x: number, y: number): void;
        injectButton(button: number, down: boolean): void;
      };
    };
    const press = async (x: number, y: number) => {
      server.injectPointerMove(x, y);
      await act();
      server.injectButton(1, true);
      await act();
      server.injectButton(1, false);
      await act();
    };
    await press(20, 20);
    await waitFor(() => assert.deepStrictEqual(presses, ['frame']));
    await press(150, 140);
    await waitFor(() =>
      assert.deepStrictEqual(links, ['https://example.test/close']),
    );
    assert.deepStrictEqual(presses, ['frame'], 'and the frame heard no more');
  });
}

test('a box fixed to the viewport that draws nothing where it reaches a frame hides none of it', async () => {
  // joshwcomeau.com's popup, fixed over its article: a wrapper with nothing
  // of its own around a card at an opacity of 0. A playground's divider
  // dragged left brought the frame's edge under the card, and the frame
  // was hidden whole for the wrapper's ink
  const { result, asked } = await renderEmbedded(
    '<style>body{margin:0}iframe{border:0;display:block;margin-left:100px}' +
      '.popup{position:fixed;top:20px;left:40px;pointer-events:none}' +
      '.card{opacity:0;width:120px;height:40px;background:#000}</style>' +
      '<iframe id="f" width="120" height="80"></iframe>' +
      '<div class="popup"><div class="card"></div></div>',
  );
  const frame = asked.at(-1);
  assert.ok(frame, 'the frame was asked about');
  assert.ok(!frame.hidden, 'shown');
  assert.strictEqual(frame.clip, undefined, 'and uncut');
  await expectPixel(result.ctx, 130, 40, '#ff0000', {
    message: 'what is mounted for it is drawn, under the card',
  });
});

test('a sticky header the viewport holds cuts a frame where it draws over it, however far the frame is scrolled under it, at 1x and 2x', async () => {
  // joshwcomeau.com's header: its links, sticky at the top, and under them
  // a white bar, sticky with them. A playground's frame scrolled up under
  // it was refused its mount, and was blank. The links' box reaches past
  // the bar for a label hung off its right, which draws nothing over the
  // frame, and the links alone leave no rectangle of it
  const source =
    '<style>body{margin:0}iframe{border:0;display:block}' +
    '.links{position:sticky;top:0;z-index:3;height:30px}' +
    '.links a{display:inline-block;margin-left:20px;width:40px;height:20px;' +
    'background:#00f}' +
    '.links span{position:absolute;right:0;top:30px;width:10px;height:30px;' +
    'background:#0f0}' +
    '.bar{position:sticky;top:0;z-index:2;height:30px;margin-top:-30px;' +
    'background:#fff}</style>' +
    '<div class="links"><a></a><span></span></div><div class="bar"></div>' +
    '<div style="height:100px"></div>' +
    '<iframe id="f" width="120" height="100"></iframe>' +
    '<div style="height:2000px"></div>';
  for (const scale of [1, 2]) {
    const asked: EmbeddedRect[] = [];
    let pane: (DrawnNode & { scrollTo(y: number): void }) | null = null;
    const result = await renderX11(
      h(
        'box',
        {
          ref: (node: typeof pane) => {
            pane = node;
          },
          style: { width: 300, height: 200, overflow: 'scroll' },
        },
        h(Html, {
          source,
          partial: false,
          renderEmbedded: (rect: EmbeddedRect) => {
            asked.push(rect);
            return h('box', {
              'data-testname': 'in-f',
              style: { flexGrow: 1, backgroundColor: '#ff0000' },
            });
          },
        }),
      ),
      { width: 340, height: 240, scale, ...(FONTS && { fonts: FONTS }) },
    );
    await act();
    const shown = () => {
      const rect = asked.at(-1);
      assert.ok(rect, `asked, ${scale}x`);
      assert.ok(!rect.hidden, `shown, ${scale}x`);
      return rect.clip && [rect.clip.y, rect.clip.height];
    };
    assert.strictEqual(shown(), undefined, `clear of the header, ${scale}x`);
    // the bar over the frame's top 20px; and then over 30px of its middle,
    // its top 50px scrolled away above it
    for (const [y, clip] of [
      [120, [150, 80]],
      [180, [210, 20]],
    ] as const) {
      await act(async () => pane!.scrollTo(y));
      await act();
      assert.deepStrictEqual(shown(), clip, `scrolled to ${y}, ${scale}x`);
      assert.ok(mounted('f'), `mounted, ${y}, ${scale}x`);
    }
    await expectPixel(result.ctx, 10 * scale, 20 * scale, '#ffffff', {
      message: `the bar, over the frame, ${scale}x`,
    });
    await expectPixel(result.ctx, 30 * scale, 10 * scale, '#0000ff', {
      message: `a link, over the bar, ${scale}x`,
    });
    await expectPixel(result.ctx, 10 * scale, 40 * scale, '#ff0000', {
      message: `what is mounted for the frame, under the header, ${scale}x`,
    });
    cleanup();
  }
});

test('what is mounted for an element in a sticky box stays with the box in every frame the pane scrolls, at 1x and 2x', async () => {
  // A frame in a sticky sidebar was mounted at the box's rect, which the
  // pane's scroll moved with the text while the box stayed: it left the box
  // by a step of the scroll at every frame, and the report at the paint put
  // it back. Core moves it with the box in the pass a scroll runs, and a
  // scroll asks `renderEmbedded` nothing
  const source =
    '<style>body{margin:0}iframe{border:0;display:block}#wrap{height:700px}' +
    '#side{position:sticky;top:10px;height:60px}' +
    '#cut{overflow:hidden;width:60px;height:20px}</style>' +
    '<div style="height:40px"></div><div id="wrap"><div id="side">' +
    '<iframe id="f" width="120" height="20"></iframe>' +
    '<div id="cut"><iframe id="g" width="120" height="50"></iframe></div>' +
    '</div></div><iframe id="h" width="120" height="20"></iframe>' +
    '<div style="height:2000px"></div>';
  for (const scale of [1, 2]) {
    const asked: EmbeddedRect[] = [];
    let pane: (DrawnNode & { scrollTo(y: number): void }) | null = null;
    const result = await renderX11(
      h(
        'box',
        {
          ref: (node: typeof pane) => {
            pane = node;
          },
          style: { width: 300, height: 200, overflow: 'scroll' },
        },
        h(Html, {
          source,
          partial: false,
          'data-testname': 'doc',
          renderEmbedded: (rect: EmbeddedRect) => {
            asked.push(rect);
            return h('box', {
              'data-testname': `in-${rect.element.attribs.id}`,
              style: { flexGrow: 1 },
            });
          },
        }),
      ),
      { width: 340, height: 240, scale, ...(FONTS && { fonts: FONTS }) },
    );
    await act();
    const el = view(screen.getByTestName('doc') as DrawnNode);
    const inBox = ['f', 'g'].map((id) => mounted(id)!);
    const flowing = mounted('h')!;
    const onScreen = (node: DrawnNode) => (node.abs.y - pane!.abs.y) / scale;
    const held = asked
      .slice(-3)
      .map((rect) => [rect.element.attribs.id, rect.held]);
    assert.deepStrictEqual(
      held,
      [
        ['f', true],
        ['g', true],
        ['h', undefined],
      ],
      `the ones in the sticky box, ${scale}x`,
    );
    // every paint of the scroll, the frame that scrolled the first of them
    const paint = el.paint;
    let painted = 0;
    let expected: number[] = [];
    el.paint = function (this: HtmlViewNode, ctx) {
      painted += 1;
      assert.deepStrictEqual(
        inBox.map(onScreen),
        expected,
        `a paint sees them where the box is, ${scale}x`,
      );
      return paint.call(this, ctx);
    };
    // the box starts 40px down, stops 10px down, and leaves with the end of
    // the box around it, 680px down the page
    const boxAt = (y: number) => Math.min(Math.max(40 - y, 10), 680 - y);
    const before = asked.length;
    for (const y of [20, 30, 45, 60, 500, 660, 670, 690, 600, 0]) {
      expected = [boxAt(y), boxAt(y) + 20];
      await act(async () => pane!.scrollTo(y));
      assert.deepStrictEqual(
        inBox.map(onScreen),
        expected,
        `scrolled to ${y}, they are where the box is, ${scale}x`,
      );
      assert.strictEqual(
        onScreen(flowing),
        740 - y,
        `and one in the flow scrolls with the text, ${scale}x`,
      );
    }
    assert.ok(painted > 0, `the document was painted, ${scale}x`);
    el.paint = paint;
    assert.strictEqual(
      asked.length,
      before,
      `a scroll asks nothing, ${scale}x`,
    );
    await result.unmount();
  }
});

test('what is mounted in a sticky box under a scale moves as far as the box is drawn to, at 1x and 2x', async () => {
  // A slide scaled to fit its stage, with a sticky box on it or around it.
  // A sticky offset moves a box in the coordinates it is laid out in, so a
  // scale around the sticky box draws the move at its factor, and one in
  // it or of the box itself leaves it as it was
  const page = (around: string, side: string, inner: string) =>
    '<style>body{margin:0}iframe{border:0;display:block}</style>' +
    `<div style="height:800px;${around}">` +
    '<div style="height:40px"></div><div style="height:700px">' +
    `<div style="position:sticky;top:10px;height:60px;${side}">` +
    `<div style="${inner}">` +
    '<iframe id="f" width="120" height="20"></iframe></div>' +
    '</div></div></div><div style="height:2000px"></div>';
  const half = 'transform-origin:0 0;transform:scale(0.5)';
  // where the box is laid out with the page scrolled to `y`: stickiness is
  // measured as though no transform had it, 40px down at rest, and 10px
  // from the viewport's top until the box around it ends, 680px down
  const laidAt = (y: number) => Math.min(Math.max(40, y + 10), 680);
  for (const scale of [1, 2]) {
    for (const [name, source, at] of [
      // the page at half size, so the box is drawn at half that
      ['around the sticky box', page(half, '', ''), 0.5],
      ['in the sticky box', page('', '', half), 1],
      ['on the sticky box', page('', half, ''), 1],
    ] as const) {
      let pane: (DrawnNode & { scrollTo(y: number): void }) | null = null;
      const asked: EmbeddedRect[] = [];
      const result = await renderX11(
        h(
          'box',
          {
            ref: (node: typeof pane) => {
              pane = node;
            },
            style: { width: 300, height: 200, overflow: 'scroll' },
          },
          h(Html, {
            source,
            partial: false,
            'data-testname': 'doc',
            renderEmbedded: (rect: EmbeddedRect) => {
              asked.push(rect);
              return h('box', {
                'data-testname': 'in-f',
                style: { flexGrow: 1 },
              });
            },
          }),
        ),
        { width: 340, height: 240, scale, ...(FONTS && { fonts: FONTS }) },
      );
      await act();
      const el = view(screen.getByTestName('doc') as DrawnNode);
      const node = mounted('f')!;
      const onScreen = () => (node.abs.y - pane!.abs.y) / scale;
      assert.strictEqual(asked.at(-1)?.held, true, `${name}, ${scale}x`);
      const paint = el.paint;
      let expected = 0;
      el.paint = function (this: HtmlViewNode, ctx) {
        assert.strictEqual(
          onScreen(),
          expected,
          `a paint sees it where it is drawn, ${name}, ${scale}x`,
        );
        return paint.call(this, ctx);
      };
      const before = asked.length;
      for (const y of [20, 30, 60, 120, 300, 60]) {
        expected = at * laidAt(y) - y;
        await act(async () => pane!.scrollTo(y));
        assert.strictEqual(
          onScreen(),
          expected,
          `scrolled to ${y}, ${name}, ${scale}x`,
        );
      }
      el.paint = paint;
      assert.strictEqual(
        asked.length,
        before,
        `a scroll asks nothing, ${name}, ${scale}x`,
      );
      await result.unmount();
    }
  }
});

test('what is mounted stays the node it was as a page makes its box sticky, fixed or neither', async () => {
  // A new node is a new document in an `<iframe>`, its scripts started
  // again, so the boxes a mount is kept in do not come and go with the
  // position of the box it is in. Each of these is a page's breakpoint
  let gone = 0;
  function Content() {
    useEffect(
      () => () => {
        gone += 1;
      },
      [],
    );
    return h('box', { 'data-testname': 'in-f', style: { flexGrow: 1 } });
  }
  let pane: (DrawnNode & { scrollTo(y: number): void }) | null = null;
  await renderX11(
    h(
      'box',
      {
        ref: (node: typeof pane) => {
          pane = node;
        },
        style: { width: 300, height: 200, overflow: 'scroll' },
      },
      h(Html, {
        source:
          '<style>body{margin:0}iframe{border:0;display:block}</style>' +
          '<div style="height:40px"></div><div style="height:700px">' +
          '<div id="side" style="position:sticky;top:10px">' +
          '<iframe id="f" width="120" height="20"></iframe></div></div>' +
          '<div style="height:2000px"></div>',
        partial: false,
        'data-testname': 'doc',
        renderEmbedded: () => h(Content),
      }),
    ),
    { width: 340, height: 240, ...(FONTS && { fonts: FONTS }) },
  );
  await act();
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const side = findById(el.document!, 'side')!;
  const node = mounted('f')!;
  const onScreen = () => node.abs.y - pane!.abs.y;
  await act(async () => pane!.scrollTo(100));
  assert.strictEqual(onScreen(), 10, 'sticky, and held');
  for (const [style, top, name] of [
    ['', -60, 'in the flow'],
    ['position:fixed;top:30px', 30, 'fixed'],
    ['position:sticky;top:10px', 10, 'sticky again'],
  ] as const) {
    side.attribs.style = style;
    await act(() => el.touchDocument(null));
    await act();
    assert.strictEqual(mounted('f'), node, `the same node, ${name}`);
    assert.strictEqual(onScreen(), top, `where the box is, ${name}`);
  }
  assert.strictEqual(gone, 0, 'and nothing was unmounted');
});

test('a sticky header cuts a frame where its mask shows it, not as far as the masked box reaches', async () => {
  // joshwcomeau.com's frosted header: a layer of glass in the bar that
  // reaches past it, for its blur to catch what comes up under it, masked
  // to the bar. Cut as far as the glass reached, the frame under it was
  // blank for the 40px below the bar it draws nothing in
  const source =
    '<style>body{margin:0}iframe{border:0;display:block}' +
    '.bar{position:sticky;top:0;z-index:2;height:30px}' +
    '.glass{position:absolute;inset:0;bottom:-40px;background:#fff;' +
    'mask-image:linear-gradient(to bottom,#000 0,#000 calc(100% - 40px),' +
    'transparent calc(100% - 40px))}</style>' +
    '<div class="bar"><div class="glass"></div></div>' +
    '<div style="height:100px"></div>' +
    '<iframe id="f" width="120" height="100"></iframe>' +
    '<div style="height:2000px"></div>';
  for (const scale of [1, 2]) {
    const asked: EmbeddedRect[] = [];
    let pane: (DrawnNode & { scrollTo(y: number): void }) | null = null;
    const result = await renderX11(
      h(
        'box',
        {
          ref: (node: typeof pane) => {
            pane = node;
          },
          style: { width: 300, height: 200, overflow: 'scroll' },
        },
        h(Html, {
          source,
          partial: false,
          renderEmbedded: (rect: EmbeddedRect) => {
            asked.push(rect);
            return h('box', {
              'data-testname': 'in-f',
              style: { flexGrow: 1, backgroundColor: '#ff0000' },
            });
          },
        }),
      ),
      { width: 340, height: 240, scale, ...(FONTS && { fonts: FONTS }) },
    );
    await act();
    // the bar over the frame's top 20px; and then over 30px of its middle,
    // its top 50px scrolled away above it
    for (const [y, clip] of [
      [120, [150, 80]],
      [180, [210, 20]],
    ] as const) {
      await act(async () => pane!.scrollTo(y));
      await act();
      const rect = asked.at(-1);
      assert.ok(rect && !rect.hidden, `shown, ${y}, ${scale}x`);
      assert.deepStrictEqual(
        rect.clip && [rect.clip.y, rect.clip.height],
        clip,
        `cut at the bar, scrolled to ${y}, ${scale}x`,
      );
    }
    await expectPixel(result.ctx, 10 * scale, 20 * scale, '#ffffff', {
      message: `the glass, in the bar, ${scale}x`,
    });
    await expectPixel(result.ctx, 10 * scale, 40 * scale, '#ff0000', {
      message: `the frame, where the mask leaves the glass out, ${scale}x`,
    });
    cleanup();
  }
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

test("a press an iframe's document cancels leaves the focus in the page around it, as one it does not cancel does not", async () => {
  // what all three engines do with a field focused in the page and a press
  // in a frame: the frame's own `mousedown` decides it
  await renderX11(
    h(
      'box',
      { style: { width: 300, height: 200, flexDirection: 'column' } },
      h(Html, {
        source:
          '<style>body{margin:0}iframe{border:0;display:block}' +
          'input{display:block;width:150px;height:24px;margin-bottom:12px}' +
          '</style><input id="t"><iframe id="f" width="200" height="120"></iframe>',
        partial: false,
        baseUrl: 'https://page.test/',
        renderEmbedded: () =>
          h(Html, {
            'data-testname': 'inner',
            partial: false,
            baseUrl: 'https://frame.test/',
            source:
              '<style>body{margin:0}p{margin:0;height:40px}</style>' +
              '<p id="kept">kept</p><p id="free">free</p>',
            onDomEvent: (e: HtmlDomEvent) =>
              e.type === 'mousedown' && e.target.attribs.id === 'kept'
                ? false
                : undefined,
          }),
      }),
    ),
    { width: 340, height: 240, ...(FONTS && { fonts: FONTS }) },
  );
  await waitFor(() => screen.getByTestName('inner'));
  const field = screen.getByRole('textbox') as DrawnNode;
  await userEvent.click(field);
  assert.strictEqual(field.focused, true);
  const inner = view(screen.getByTestName('inner') as DrawnNode);
  const press = async (id: string) => {
    const doc = inner.document as unknown as Element;
    const rect = inner.elementRect(byId(doc, id))!;
    const node = inner as unknown as DrawnNode;
    const at = {
      dx: rect.x + rect.width / 2 - node.abs.width / 2,
      dy: rect.y + rect.height / 2 - node.abs.height / 2,
    };
    await act(async () => {
      fireEvent.mouseDown(node, at);
      fireEvent.mouseUp(node, at);
    });
    await act();
  };
  await press('kept');
  assert.strictEqual(field.focused, true, 'a cancelled press keeps it');
  await press('free');
  assert.strictEqual(field.focused, false, 'and any other takes it away');
});

test("a press in an iframe's document is that document's: its summary opens once, and the embedding page follows none of its links or forms", async () => {
  // A press in the frame bubbles out of the frame's own `<Html>` to the
  // page's, and the page's node is not the one the press landed on — but the
  // frame's answers `elementAtPoint` as well. The page took the press for
  // its own too: the summary of joshwcomeau.com's interpolate-size
  // playground was opened by the frame and shut again by the page, so a
  // click did nothing, and a link or a form in a frame would have been
  // followed by the page as well.
  const page: string[] = [];
  const frame: string[] = [];
  const tell = (into: string[]) => ({
    onLink: (href: string) => void into.push(`link ${href}`),
    onSubmit: (s: FormSubmission) => void into.push(`submit ${s.url}`),
    onDomEvent: (e: HtmlDomEvent) => {
      if (e.type === 'click' || e.type === 'toggle') {
        into.push(`${e.type} ${e.target.attribs.id}`);
      }
      return undefined;
    },
  });
  await renderX11(
    h(
      'box',
      { style: { width: 300, height: 200, flexDirection: 'column' } },
      h(Html, {
        source:
          '<style>body{margin:0}iframe{border:0;display:block}</style>' +
          '<iframe id="f" width="200" height="120"></iframe>',
        partial: false,
        baseUrl: 'https://page.test/',
        ...tell(page),
        renderEmbedded: () =>
          h(Html, {
            'data-testname': 'inner',
            partial: false,
            baseUrl: 'https://frame.test/',
            source:
              '<style>body{margin:0}summary,a{display:block;height:20px}' +
              'p{margin:0}button{display:block;width:80px;height:20px}</style>' +
              '<details id="d"><summary id="s">more</summary><p>inside</p>' +
              '</details><a id="l" href="/next">next</a>' +
              '<form id="form" action="/sent"><button id="b">go</button></form>',
            ...tell(frame),
          }),
      }),
    ),
    { width: 340, height: 240, ...(FONTS && { fonts: FONTS }) },
  );
  await act();
  const inner = view(screen.getByTestName('inner') as DrawnNode);
  const click = async (id: string) => {
    const doc = inner.document as unknown as Element;
    const rect = inner.elementRect(byId(doc, id))!;
    const node = inner as unknown as DrawnNode;
    // a third of the way in, the link and the button below the summary's
    // middle: two presses at one point are a double click
    const at = {
      dx: rect.x + rect.width / 3 - node.abs.width / 2,
      dy: rect.y + rect.height / 2 - node.abs.height / 2,
    };
    await act(async () => {
      fireEvent.mouseDown(node, at);
      fireEvent.mouseUp(node, at);
    });
  };
  await click('s');
  const details = byId(inner.document as unknown as Element, 'd');
  assert.strictEqual(details.attribs.open, '', 'the details is open');
  await click('l');
  await click('b');
  assert.deepStrictEqual(frame, [
    'click s',
    'toggle d',
    'click l',
    'link https://frame.test/next',
    'click b',
    'submit https://frame.test/sent?',
  ]);
  assert.deepStrictEqual(page, [], 'the page is told of none of it');
});

const scripted = SCRIPTS_CONTAINED ? test : test.skip;

const SVG_TYPE = 'image/svg+xml';
const XHTML_TYPE = 'application/xhtml+xml';
const SVG = 'xmlns="http://www.w3.org/2000/svg"';
const XHTML = 'xmlns="http://www.w3.org/1999/xhtml"';

/** What a frame's address is answered with. */
interface Served {
  type: string;
  body?: string;
  bytes?: Uint8Array;
  status?: number;
  /** Asked for, and never answered. */
  hangs?: boolean;
  /** Answered once this has settled. */
  held?: Promise<unknown>;
}

/**
 * A page with its scripts on, framing what `files` holds as a host with a
 * network loads it: a frame's document through `scripts.fetch`, and what an
 * `<object>` or an `<embed>` asks for as an image through the answer such a
 * host gives (`resourceResult`), so a drawing is an image, and a page a
 * document, as they are in a browser.
 */
async function framing(
  markup: string,
  files: Record<string, Served>,
  {
    scale,
    width = 400,
    height = 400,
    frames,
    serviceWorkers,
  }: {
    scale?: number;
    width?: number;
    height?: number;
    frames?: boolean;
    serviceWorkers?: boolean;
  } = {},
) {
  const logs: string[] = [];
  const fetched: string[] = [];
  const requested: string[] = [];
  const named = (url: string): Served | undefined =>
    files[url.slice(url.lastIndexOf('/') + 1)];
  const result = await renderX11(
    h(
      'box',
      { style: { width, height, flexDirection: 'column' } },
      h(Html, {
        source:
          '<!doctype html><style>body{margin:0}' +
          'iframe,object,embed{display:block;border:0}</style>' +
          markup,
        partial: false,
        baseUrl: PAGE,
        onResource: async ({ url, kind }: ResourceRequest) => {
          const file = named(url);
          requested.push(url.slice(url.lastIndexOf('/') + 1));
          if (file?.hangs) return new Promise<null>(() => {});
          await file?.held;
          if (!file || (file.status ?? 200) >= 400) return null;
          const bytes = file.bytes ?? new TextEncoder().encode(file.body ?? '');
          return resourceResult(
            { url, status: 200, type: file.type, charset: null, bytes },
            kind as Parameters<typeof resourceResult>[1],
          );
        },
        scripts: {
          ...(frames !== undefined && { frames }),
          ...(serviceWorkers !== undefined && { serviceWorkers }),
          log: (_level: string, text: string) => void logs.push(text),
          fetch: async (request: { url: string }) => {
            const file = named(request.url);
            if (!file) throw new Error(`no ${request.url}`);
            fetched.push(request.url.slice(request.url.lastIndexOf('/') + 1));
            return {
              url: request.url,
              status: file.status ?? 200,
              statusText: '',
              redirected: false,
              headers: [['content-type', file.type]] as [string, string][],
              body: file.body ?? '',
            };
          },
        },
      }),
    ),
    {
      width: width + 40,
      height: height + 40,
      ...(FONTS && { fonts: FONTS }),
      ...(scale && { scale }),
    },
  );
  // a realm nothing draws runs in a view of no size (`FrameHolder`)
  const views = (node: unknown): number => {
    const { kind, abs, children } = node as {
      kind?: string;
      abs?: { width: number; height: number };
      children?: unknown[];
    };
    const shown = kind === 'htmlview' && !!abs?.width && !!abs.height;
    return (
      (shown ? 1 : 0) +
      (children ?? []).reduce<number>((n, c) => n + views(c), 0)
    );
  };
  return {
    result,
    logs,
    fetched,
    /** What the page and its frames' views asked the host for. */
    requested,
    /** How many frames' documents are drawn: every view but the page's. */
    drawn: () => views(result.windowNode) - 1,
    /** Wait for a line of what the page's scripts logged. */
    async until(line: string): Promise<void> {
      const end = Date.now() + 5000;
      while (!logs.includes(line) && Date.now() < end) {
        await act(() => new Promise((go) => setTimeout(go, 10)));
      }
      assert.ok(logs.includes(line), `no "${line}" in ${logs.join(' | ')}`);
    },
    /** Wait for a colour at a device pixel, and hold the test to it. */
    async paints(x: number, y: number, want: string, message: string) {
      const end = Date.now() + 5000;
      while (
        !isNear(await pixelAt(result.ctx, x, y), want, 8) &&
        Date.now() < end
      ) {
        await act(() => new Promise((go) => setTimeout(go, 10)));
      }
      await expectPixel(result.ctx, x, y, want, { message });
    },
  };
}

/** A page logs what it hears of its frames, and how each came out. */
const HEARS = `<script>
  addEventListener('message', (e) => console.log(e.data));
  addEventListener('load', () => {
    console.log('loaded');
    for (const f of document.querySelectorAll('[id]')) {
      const r = f.getBoundingClientRect();
      console.log(f.id + ' ' + r.width + 'x' + r.height);
    }
  });
</script>`;

for (const scale of [1, 2]) {
  scripted(
    `an iframe's drawing fills it where it says no size, and is cut to a size it says, at ${scale}x`,
    async () => {
      const { paints, until } = await framing(
        `<iframe id="a" src="fills.svg"></iframe>
       <iframe id="b" src="sized.svg"></iframe>${HEARS}`,
        {
          'fills.svg': {
            type: SVG_TYPE,
            body: `<svg ${SVG} viewBox="0 0 10 10"><rect width="10" height="10" fill="#00ff00"/></svg>`,
          },
          'sized.svg': {
            type: SVG_TYPE,
            body: `<svg ${SVG} width="50" height="50"><rect width="200" height="200" fill="#0000ff"/></svg>`,
          },
        },
        { scale },
      );
      await until('a 300x150');
      // HTML's default frame, and a square as tall as it, in its middle
      await paints(150 * scale, 75 * scale, '#00ff00', 'the middle');
      await paints(80 * scale, 5 * scale, '#00ff00', 'its top, 75 in');
      await paints(70 * scale, 75 * scale, '#ffffff', 'beside the square');
      await paints(25 * scale, 175 * scale, '#0000ff', 'the sized drawing');
      await paints(60 * scale, 175 * scale, '#ffffff', 'past what it says');
    },
  );
}

scripted("an iframe's XHTML is read by XML's rules", async () => {
  const { paints, until } = await framing(
    `<iframe id="f" src="page.xhtml"></iframe>${HEARS}`,
    {
      'page.xhtml': {
        type: XHTML_TYPE,
        body: `<html ${XHTML}><head>
          <style><!-- body { background: #ff0000 } --></style>
          <style>div { height: 40px; background: #00ff00 } DIV { background: #ff0000 }</style>
        </head><body style="margin:0"><div/></body></html>`,
      },
    },
  );
  await until('loaded');
  await paints(10, 10, '#00ff00', 'its div, no rule of another case');
  await paints(10, 100, '#ffffff', 'no sheet in a comment');
});

scripted(
  'an XML frame runs its scripts in a realm of its own, its source and all, before its load',
  async () => {
    const { paints, until } = await framing(
      `<iframe id="f" src="run.svg"></iframe>${HEARS}<script>
      addEventListener('load', () =>
        console.log('reads ' + document.getElementById('f').contentWindow.mine));
    </script>`,
      {
        'run.svg': {
          type: SVG_TYPE,
          body: `<svg ${SVG} width="100" height="50">
          <rect id="r" width="100" height="50" fill="#ff0000"/>
          <script href="set.js"/>
          <script>
            var mine = document.getElementById('r').getAttribute('fill');
            parent.postMessage('ran ' + window.mine + ' ' + document.contentType, '*');
          </script>
        </svg>`,
        },
        'set.js': {
          type: 'text/javascript',
          body: "document.getElementById('r').setAttribute('fill', '#00ff00');",
        },
      },
    );
    // read in the page's `load`, which waited for the frame's scripts; what
    // it posted is a task of its own, which may come after
    await until('reads #00ff00');
    await until('ran #00ff00 image/svg+xml');
    await paints(10, 10, '#00ff00', 'what its script drew');
  },
);

scripted(
  'what is no script in an XML document runs nothing, and a frame of one is drawn in the page realm',
  async () => {
    const { drawn, logs, until } = await framing(
      `<iframe id="f" src="plain.xml"></iframe>${HEARS}<script>
      addEventListener('load', () => console.log(
        'same ' + (document.getElementById('f').contentWindow.top === window)));
    </script>`,
      {
        'plain.xml': {
          type: 'application/xml',
          body: `<root><script>parent.postMessage('ran', '*')</script></root>`,
        },
      },
    );
    await until('same true');
    assert.strictEqual(drawn(), 1, 'it is drawn');
    assert.ok(!logs.includes('ran'), logs.join(' | '));
  },
);

scripted(
  'a frame of another origin that is XML runs at its own origin and is drawn',
  async () => {
    const { logs, paints, until } = await framing(
      `<iframe id="f" src="https://other.test/run.svg"></iframe>${HEARS}<script>
      addEventListener('load', () => console.log(
        'reads ' + document.getElementById('f').contentDocument));
    </script>`,
      {
        'run.svg': {
          type: SVG_TYPE,
          body: `<svg ${SVG} width="100" height="50">
          <rect id="r" width="100" height="50" fill="#ff0000"/>
          <script>
            document.getElementById('r').setAttribute('fill', '#00ff00');
            parent.postMessage('at ' + location.origin + ' ' + origin, '*');
          </script>
        </svg>`,
        },
      },
    );
    await until('reads null');
    assert.ok(
      logs.includes('at https://other.test https://other.test'),
      logs.join(' | '),
    );
    await paints(10, 10, '#00ff00', 'what its script drew');
  },
);

scripted(
  "a frame whose document runs nothing hears its load once that document's images have come to something, and the page after it",
  async () => {
    let answer!: () => void;
    const held = new Promise<void>((go) => (answer = go));
    const { logs, requested, until } = await framing(
      `<iframe id="f" src="pics.html"></iframe><script>
      const f = document.getElementById('f');
      const said = (what) => {
        const [a, b] = f.contentDocument.images;
        console.log(what + ' ' + [a, b].map((img) =>
          img.complete + ':' + img.currentSrc.slice(img.currentSrc.lastIndexOf('/') + 1)));
      };
      f.addEventListener('load', () => said('frame'));
      addEventListener('load', () => said('page'));
    </script>`,
      {
        'pics.html': {
          type: 'text/html',
          body: '<img id="a" src="pic.png"><img id="b" src="gone.png">',
        },
        'pic.png': { type: 'image/png', bytes: RED_PNG, held },
        'gone.png': { type: 'image/png', status: 404, held },
      },
    );
    const end = Date.now() + 5000;
    while (!requested.includes('gone.png') && Date.now() < end) {
      await act(() => new Promise((go) => setTimeout(go, 10)));
    }
    assert.ok(requested.includes('pic.png'), requested.join(' | '));
    // a while with both images on their way: nothing heard of the frame
    await act(() => new Promise((go) => setTimeout(go, 100)));
    assert.ok(
      !logs.some((line) => /^(?:frame|page) /.test(line)),
      logs.join(' | '),
    );
    answer();
    await until('frame true:pic.png,true:gone.png');
    await until('page true:pic.png,true:gone.png');
    assert.ok(
      logs.indexOf('frame true:pic.png,true:gone.png') <
        logs.indexOf('page true:pic.png,true:gone.png'),
      logs.join(' | '),
    );
  },
);

scripted(
  'a frame the page lays out no box for hears its load, though nothing asks for its images',
  async () => {
    const { requested, until } = await framing(
      `<iframe id="f" src="pics.html" style="display:none"></iframe><script>
      document.getElementById('f').addEventListener('load', () =>
        console.log('frame'));
      addEventListener('load', () => console.log('page'));
    </script>`,
      {
        'pics.html': { type: 'text/html', body: '<img src="pic.png">' },
        'pic.png': { type: 'image/png', hangs: true },
      },
    );
    await until('frame');
    await until('page');
    assert.ok(!requested.includes('pic.png'), requested.join(' | '));
  },
);

scripted(
  "a frame's XML that is not well-formed is drawn as the error, and runs nothing",
  async () => {
    const { drawn, logs, until } = await framing(
      `<iframe id="f" src="bad.svg"></iframe>${HEARS}<script>
      addEventListener('load', () => console.log(
        'root ' + document.getElementById('f').contentDocument.documentElement.localName));
    </script>`,
      {
        'bad.svg': {
          type: SVG_TYPE,
          body: `<svg ${SVG}><script>parent.postMessage('ran', '*')</script><rect></svg>`,
        },
      },
    );
    await until('root parsererror');
    assert.strictEqual(drawn(), 1, 'the error is drawn');
    assert.ok(!logs.includes('ran'), logs.join(' | '));
  },
);

for (const [name, type, body] of [
  [
    'page.xhtml',
    XHTML_TYPE,
    `<html ${XHTML}><body style="margin:0;background:#00ff00"/></html>`,
  ],
  [
    'other.html',
    'text/html',
    '<!doctype html><body style="margin:0;background:#00ff00">',
  ],
] as const) {
  scripted(
    `an object and an embed of ${name} show it as an iframe does, at a frame's size`,
    async () => {
      const { paints, until } = await framing(
        `<object id="o" data="${name}"></object>
       <embed id="e" src="${name}">${HEARS}`,
        { [name]: { type, body } },
      );
      await until('o 300x150');
      await until('e 300x150');
      await paints(5, 5, '#00ff00', 'the object');
      await paints(295, 145, '#00ff00', 'the corner of the object');
      await paints(5, 155, '#00ff00', 'the embed');
      await paints(305, 5, '#ffffff', 'past them');
    },
  );
}

scripted(
  "a drawing that is a service worker's client stays a picture, though it has a realm of its own",
  async () => {
    const { drawn, paints, until } = await framing(
      `<object id="o" data="still.svg"
         style="width:200px;height:100px;object-fit:contain"></object>${HEARS}`,
      {
        'still.svg': {
          type: SVG_TYPE,
          body: `<svg ${SVG} width="100" height="100"><rect width="100" height="100" fill="#00ff00"/></svg>`,
        },
      },
      { serviceWorkers: true },
    );
    await until('loaded');
    await paints(100, 50, '#00ff00', 'in the middle');
    await paints(25, 50, '#ffffff', 'beside what is fitted');
    assert.strictEqual(drawn(), 0, 'no frame is mounted');
  },
);

scripted(
  'a drawing nothing can change stays the picture of it, which object-fit reaches',
  async () => {
    const { drawn, paints, until } = await framing(
      `<object id="o" data="still.svg"
       style="width:200px;height:100px;object-fit:contain"></object>
     <embed id="e" src="still.svg"
       style="width:200px;height:100px;object-fit:contain">${HEARS}<script>
       // their boxes built again once their documents are in, as a restyle
       // or a breakpoint builds them
       addEventListener('load', () => setTimeout(() => {
         for (const el of document.querySelectorAll('object, embed')) {
           el.setAttribute('title', 'built again');
         }
         setTimeout(() => console.log('built again'), 20);
       }, 20));
     </script>`,
      {
        'still.svg': {
          type: SVG_TYPE,
          body: `<svg ${SVG} width="100" height="100"><rect width="100" height="100" fill="#00ff00"/></svg>`,
        },
      },
    );
    await until('built again');
    await paints(100, 50, '#00ff00', 'in the middle of the object');
    await paints(25, 50, '#ffffff', 'beside what is fitted in the object');
    await paints(100, 150, '#00ff00', 'in the middle of the embed');
    await paints(25, 150, '#ffffff', 'beside what is fitted in the embed');
    assert.strictEqual(drawn(), 0, 'no frame is mounted');
  },
);

for (const scale of [1, 2]) {
  for (const [tag, attribute] of [
    ['object', 'data'],
    ['embed', 'src'],
  ] as const) {
    scripted(
      `a drawing with a script in an ${tag} is drawn as it stands, at the size of its picture, at ${scale}x`,
      async () => {
        const { drawn, paints, until } = await framing(
          `<${tag} id="f" ${attribute}="run.svg"></${tag}>${HEARS}`,
          {
            'run.svg': {
              type: SVG_TYPE,
              body: `<svg ${SVG} width="100" height="50">
              <rect id="r" width="100" height="50" fill="#ff0000"/>
              <script>
                document.getElementById('r').remove();
                parent.postMessage('ran', '*');
              </script>
            </svg>`,
            },
          },
          { scale },
        );
        await until('f 100x50');
        await until('ran');
        assert.strictEqual(drawn(), 1, 'it is mounted');
        // taken out by its script: the picture that shows it would still
        // show under a mount, as it would in place of one
        await paints(
          10 * scale,
          10 * scale,
          '#ffffff',
          'what its script took out',
        );
      },
    );
  }
}

scripted(
  'an object and an embed a script gives an address once they are in load it',
  async () => {
    const { drawn, paints, until } = await framing(
      `${HEARS}<script>
        addEventListener('DOMContentLoaded', () => {
          const o = document.createElement('object');
          const e = document.createElement('embed');
          document.body.append(o, e);
          o.onload = () => console.log('object');
          e.onload = () => console.log('embed');
          o.data = 'feed.atom';
          e.src = 'page.xhtml';
          console.log(e.getAttribute('src'));
        });
      </script>`,
      {
        // an XML type nothing names, which is a document all the same
        'feed.atom': {
          type: 'application/atom+xml',
          body: `<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>`,
        },
        'page.xhtml': {
          type: XHTML_TYPE,
          body: `<html ${XHTML}><body style="margin:0;background:#00ff00"/></html>`,
        },
      },
    );
    await until('page.xhtml');
    await until('object');
    await until('embed');
    await paints(5, 155, '#00ff00', 'the embed');
    assert.strictEqual(drawn(), 2, 'each is mounted');
  },
);

scripted(
  'an embed loads only while it is rendered, and nothing shows something else in its place',
  async () => {
    const still = `<svg ${SVG} width="20" height="20"><rect width="20" height="20" fill="#00ff00"/></svg>`;
    const { fetched, until } = await framing(
      `<div hidden><embed id="a" src="hidden.svg"></div>
       <video><embed id="b" src="video.svg"></video>
       <audio><embed id="c" src="audio.svg"></audio>
       <object id="o" data="still.svg"><embed id="d" src="object.svg"></object>
       <div style="content-visibility:hidden"><embed id="e" src="skipped.svg"></div>
       ${HEARS}<script>
         addEventListener('load', () =>
           setTimeout(() => console.log('waited'), 50));
       </script>`,
      Object.fromEntries(
        [
          'hidden.svg',
          'video.svg',
          'audio.svg',
          'object.svg',
          'skipped.svg',
          'still.svg',
        ].map((name) => [name, { type: SVG_TYPE, body: still }]),
      ),
    );
    await until('waited');
    assert.deepStrictEqual(
      fetched.filter((name) => name !== 'still.svg').sort(),
      ['skipped.svg'],
      'what content-visibility skips is rendered, and none of the rest is',
    );
  },
);

scripted(
  'an embed the parser reaches after a script has the style it was given by then',
  async () => {
    const { fetched, until } = await framing(
      `<script src="first.js"></script>
       <style>#target { display: none }</style>
       <body>
         <script>var waited = 1;</script>
         <embed id="target" src="hidden.svg">
         ${HEARS}<script>
           addEventListener('load', () =>
             setTimeout(() => console.log('waited'), 50));
         </script>
       </body>`,
      {
        'first.js': { type: 'text/javascript', body: 'var first = 1;' },
        'hidden.svg': { type: SVG_TYPE, body: `<svg ${SVG}/>` },
      },
    );
    await until('waited');
    assert.deepStrictEqual(fetched, []);
  },
);

scripted(
  "an embed waits for the sheets that say whether it is rendered, as the page's first rendering does",
  async () => {
    let arrive = (): void => {};
    const held = new Promise<void>((go) => (arrive = go));
    const { fetched, result } = await framing(
      `<link rel="stylesheet" href="sheet.css">
       <embed id="target" src="shown.svg">`,
      {
        'sheet.css': { type: 'text/css', body: 'body { margin: 0 }', held },
        'shown.svg': {
          type: SVG_TYPE,
          body: `<svg ${SVG} width="10" height="10"/>`,
        },
      },
    );
    // nothing says yet what it is: laid out by no sheet, it might be hidden
    for (let turn = 0; turn < 20; turn += 1) {
      await act(() => new Promise((go) => setTimeout(go, 5)));
    }
    assert.deepStrictEqual(fetched, [], 'held while the sheet is');
    assert.ok(result.ctx);
    arrive();
    const end = Date.now() + 5000;
    while (!fetched.length && Date.now() < end) {
      await act(() => new Promise((go) => setTimeout(go, 10)));
    }
    assert.deepStrictEqual(fetched, ['shown.svg'], 'and it is rendered');
  },
);

scripted(
  'an object given its address as the page is parsed loads with the frames the markup has, after its scripts',
  async () => {
    const { until } = await framing(
      `<object id="o" type="image/svg+xml"></object>
       <script>document.getElementById('o').data = 'still.svg';</script>
       <script src="later.js"></script>
       ${HEARS}`,
      {
        'later.js': {
          type: 'text/javascript',
          body: `document.getElementById('o').onload = () => console.log('heard');`,
        },
        'still.svg': {
          type: SVG_TYPE,
          body: `<svg ${SVG} width="100" height="50"/>`,
        },
      },
    );
    // a script after it hears its load, as one after an object in the
    // markup does
    await until('heard');
  },
);

scripted('an embed a script comes to show loads from then on', async () => {
  const { logs, until } = await framing(
    `<div id="later" style="display:none">
       <embed id="s" src="shown.svg" onload="console.log('embed loaded')">
     </div>${HEARS}<script>
       addEventListener('load', () => setTimeout(() => {
         console.log('showing');
         document.getElementById('later').style.display = 'block';
       }, 20));
     </script>`,
    {
      'shown.svg': {
        type: SVG_TYPE,
        body: `<svg ${SVG} width="20" height="20"/>`,
      },
    },
  );
  await until('embed loaded');
  assert.ok(
    logs.indexOf('showing') >= 0 &&
      logs.indexOf('showing') < logs.indexOf('embed loaded'),
    logs.join(' | '),
  );
});

scripted('a javascript: embed does nothing, and hears no load', async () => {
  const { logs, until } = await framing(
    `<embed id="j" src="javascript:'x'" onload="console.log('heard')">${HEARS}<script>
       addEventListener('load', () =>
         setTimeout(() => console.log('waited'), 50));
     </script>`,
    {},
  );
  await until('waited');
  assert.ok(!logs.includes('heard'), logs.join(' | '));
});

for (const [tag, attribute] of [
  ['object', 'data'],
  ['embed', 'src'],
] as const) {
  for (const file of ['still.svg', 'run.svg']) {
    scripted(`an ${tag} of ${file} hears one load`, async () => {
      const { logs, until } = await framing(
        `<${tag} id="f" ${attribute}="${file}"
           onload="console.log('heard')"></${tag}>${HEARS}<script>
           addEventListener('load', () =>
             setTimeout(() => console.log('waited'), 100));
         </script>`,
        {
          'still.svg': {
            type: SVG_TYPE,
            body: `<svg ${SVG} width="10" height="10"/>`,
          },
          'run.svg': {
            type: SVG_TYPE,
            body: `<svg ${SVG} width="10" height="10"><script>var x = 1;</script></svg>`,
          },
        },
      );
      await until('waited');
      assert.strictEqual(
        logs.filter((line) => line === 'heard').length,
        1,
        logs.join(' | '),
      );
    });
  }
}

scripted(
  "an object's document with a realm of its own is the one its window has",
  async () => {
    const { logs, until } = await framing(
      `<object id="o" data="run.svg"></object>${HEARS}<script>
        addEventListener('load', () => {
          const o = document.getElementById('o');
          console.log('same ' + (o.contentDocument === o.contentWindow.document));
        });
      </script>`,
      {
        'run.svg': {
          type: SVG_TYPE,
          body: `<svg ${SVG}><script>var mine = 1;</script></svg>`,
        },
      },
    );
    await until('loaded');
    await until('same true');
    assert.ok(!logs.includes('same false'), logs.join(' | '));
  },
);

scripted(
  'a drawing goes live as it comes, whatever is still holding its load',
  async () => {
    const { drawn, logs, paints, until } = await framing(
      `<object id="f" data="slow.svg"></object>${HEARS}`,
      {
        'slow.svg': {
          type: SVG_TYPE,
          body: `<svg ${SVG} width="100" height="50">
            <rect id="r" width="100" height="50" fill="#ff0000"/>
            <script>document.getElementById('r').remove();</script>
            <script href="never.js"/>
          </svg>`,
        },
        'never.js': { type: 'text/javascript', hangs: true },
      },
    );
    // nothing it does reaches the page, so nothing the page does flushes:
    // it posts no message, and its `load` is held
    await until('f 100x50').catch(() => {});
    await paints(10, 10, '#ffffff', 'what its script took out');
    assert.strictEqual(drawn(), 1, 'it is mounted');
    assert.ok(!logs.includes('loaded'), 'its load is still held');
  },
);

scripted(
  "what a page writes into a drawing with no script shows, and an object's document is its window's",
  async () => {
    const { drawn, logs, paints, until } = await framing(
      `<object id="o" data="still.svg"></object>
     <embed id="e" src="still.svg">
     <embed id="x" src="page.xhtml">${HEARS}<script>
       addEventListener('load', () => {
         const o = document.getElementById('o');
         console.log('same ' + (o.contentDocument === o.contentWindow.document));
         o.contentDocument.getElementById('r').setAttribute('fill', '#00ff00');
         const e = document.getElementById('e');
         e.getSVGDocument().getElementById('r').setAttribute('fill', '#0000ff');
         console.log('page ' + document.getElementById('x').getSVGDocument());
         console.log('wrote');
       });
     </script>`,
      {
        'still.svg': {
          type: SVG_TYPE,
          body: `<svg ${SVG} width="100" height="50"><rect id="r" width="100" height="50" fill="#ff0000"/></svg>`,
        },
        'page.xhtml': { type: XHTML_TYPE, body: `<html ${XHTML}/>` },
      },
    );
    await until('wrote');
    assert.ok(logs.includes('same true'), logs.join(' | '));
    assert.ok(logs.includes('page null'), 'getSVGDocument is for a drawing');
    await paints(10, 10, '#00ff00', 'what it wrote in the object');
    await paints(10, 60, '#0000ff', 'what it wrote in the embed');
    assert.strictEqual(drawn(), 3, 'each is mounted');
  },
);

scripted('an XML frame in an XML frame is drawn in it', async () => {
  const { paints, until } = await framing(
    `<iframe id="f" src="outer.xhtml"></iframe>${HEARS}`,
    {
      'outer.xhtml': {
        type: XHTML_TYPE,
        body: `<html ${XHTML}><head><script>var outer = 1;</script></head>
          <body style="margin:0"><object data="inner.svg" style="display:block"/>
        </body></html>`,
      },
      'inner.svg': {
        type: SVG_TYPE,
        body: `<svg ${SVG} width="100" height="50">
          <rect id="r" width="100" height="50" fill="#ff0000"/>
          <script>document.getElementById('r').setAttribute('fill', '#00ff00');</script>
        </svg>`,
      },
    },
  );
  await until('loaded');
  await paints(10, 10, '#00ff00', "what the inner drawing's script drew");
});

scripted(
  'an object that could not be had shows its fallback and hears an error',
  async () => {
    const { drawn, logs, paints, until } = await framing(
      `<object id="o" data="gone.xhtml"
       onerror="console.log('error')" onload="console.log('load')">
       <p style="margin:0;height:40px;background:#00ff00"></p>
     </object>${HEARS}`,
      {
        'gone.xhtml': {
          type: XHTML_TYPE,
          status: 404,
          body: `<html ${XHTML}><head><script>parent.postMessage('ran', '*')</script></head>
          <body style="background:#ff0000"/></html>`,
        },
      },
    );
    await until('error');
    await until('loaded');
    assert.ok(!logs.includes('load'), logs.join(' | '));
    assert.ok(!logs.includes('ran'), 'nothing of the error page runs');
    await paints(10, 10, '#00ff00', 'the fallback');
    assert.strictEqual(drawn(), 0, 'nothing is mounted');
  },
);

scripted(
  'an embed of what is no document holds none, and hears its load',
  async () => {
    const { drawn, logs, paints, until } = await framing(
      `<embed id="i" src="pic.png" onload="console.log('image')"
       style="width:20px;height:20px">
     <embed id="p" src="film.swf" onload="console.log('plugin')">${HEARS}`,
      {
        'pic.png': { type: 'image/png', bytes: RED_PNG },
        'film.swf': { type: 'application/x-shockwave-flash', body: 'FWS' },
      },
    );
    await until('image');
    await until('plugin');
    await paints(10, 10, '#ff0000', 'the picture');
    assert.strictEqual(drawn(), 0, `nothing is mounted: ${logs.join(' | ')}`);
  },
);

scripted(
  "where frames are off, a frame's XHTML runs in the page's realm, and nothing is loaded for an embed",
  async () => {
    const { drawn, fetched, logs, until } = await framing(
      `<iframe id="f" src="run.xhtml"></iframe>
     <embed id="e" src="run.xhtml">${HEARS}<script>
       addEventListener('load', () => {
         document.getElementById('f').contentDocument;
         // put in by a script, it would load as it goes in
         document.body.append(document.getElementById('e'));
         setTimeout(() => console.log('waited'), 50);
       });
     </script>`,
      {
        'run.xhtml': {
          type: XHTML_TYPE,
          body: `<html ${XHTML}><body><script>parent.postMessage('ran', '*')</script></body></html>`,
        },
      },
      { frames: false },
    );
    await until('ran');
    await until('waited');
    assert.deepStrictEqual(fetched, ['run.xhtml'], 'one, the iframe');
    assert.strictEqual(drawn(), 0, logs.join(' | '));
  },
);

test('a host is given an object of a document, and no object or embed that shows an image', async () => {
  const asked: EmbeddedRect[] = [];
  const svg = `<svg ${SVG} width="10" height="10"/>`;
  await renderX11(
    h(
      'box',
      { style: { width: 300, height: 400, flexDirection: 'column' } },
      h(Html, {
        source:
          '<object id="doc" data="page.xhtml"></object>' +
          '<object id="pic" data="still.svg"></object>' +
          '<embed id="shown" src="still.svg">' +
          '<embed id="none" src="unknown.bin">',
        partial: false,
        baseUrl: PAGE,
        onResource: ({ url }: ResourceRequest) =>
          url.endsWith('.xhtml')
            ? { kind: 'document' as const }
            : url.endsWith('.svg')
              ? { kind: 'image' as const, bytes: new TextEncoder().encode(svg) }
              : null,
        renderEmbedded: (rect: EmbeddedRect) => {
          asked.push(rect);
          return null;
        },
      }),
    ),
    { width: 340, height: 440, ...(FONTS && { fonts: FONTS }) },
  );
  await act();
  assert.deepStrictEqual(
    [...new Set(asked.map((r) => `${r.kind} ${r.element.attribs.id}`))],
    ['object doc', 'embed none'],
  );
});
