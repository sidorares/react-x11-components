// <Html> — what a host mounts over an `<iframe>`, a `<canvas>` or an
// `<embed>` (`renderEmbedded`, `src/html/embedded.ts`): at the element's
// content box, beside the document, held to the rules a video's player is.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { act, cleanup, expectPixel, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { parseDocument } from 'htmlparser2';
import { Image } from 'react-x11/ntk';
import { Html, useHtmlHandle } from '../../src/html/index.js';
import type { Element, HtmlViewNode } from '../../src/html/index.js';
import type { EmbeddedRect } from '../../src/html/index.js';
import { FONTS, h, metric } from './harness.js';

afterEach(cleanup);

/** A document whose host fills each embedded element with a box of its
 *  own, named for the element's id, and keeps what it was asked about. */
async function renderEmbedded(
  source: string,
  { width = 300, height = 300 }: { width?: number; height?: number } = {},
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
  const port = (mounted('f') as unknown as { parent: { parent: DrawnNode } })
    .parent.parent;
  assert.deepStrictEqual(
    [port.abs.x, port.abs.y, port.abs.width, port.abs.height],
    [0, 10, 80, 50],
  );
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
