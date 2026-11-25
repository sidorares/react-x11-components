// <Html> — what is painted over a canvas that changes at every frame is kept
// on a surface and drawn from it (`retainedForeground`, `src/html/paint.ts`),
// where the paint of a frame reached every box over the canvas and drew each
// again. The pixels are what the paint of every box gives; the surface is
// made on the second frame that changes nothing but the canvas, and a part
// of the document claimed for a repaint is made again in it.
import { afterEach, test } from 'node:test';
import {
  act,
  cleanup,
  expectPixel,
  fireEvent,
  renderX11,
  screen,
} from 'react-x11/test';
import { Image } from 'react-x11/ntk';
import { Html } from '../../src/html/index.js';
import type { Element, HtmlViewNode } from '../../src/html/index.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);

/** A picture 2 by 1: its left half `left`, its right half nothing. */
const picture = (left: number[]) =>
  new Image({
    width: 2,
    height: 1,
    data: new Uint8Array([...left, 255, 0, 0, 0, 0]),
  });

function byId(node: Element, id: string): Element {
  const found = (n: Element): Element | null => {
    if (n.attribs?.id === id) return n;
    for (const child of (n.children ?? []) as Element[]) {
      const at = found(child);
      if (at) return at;
    }
    return null;
  };
  const el = found(node);
  if (!el) throw new Error(`no #${id}`);
  return el;
}

const SOURCE =
  '<style>body{margin:0;background:#ffffff}' +
  '#under{position:absolute;left:0;top:0;width:300px;height:300px;background:#00ff00}' +
  'canvas{position:absolute;left:0;top:0;width:300px;height:300px}' +
  '#over{position:absolute;left:150px;top:0;width:150px;height:300px;' +
  'background:rgba(255,0,0,.5)}#over:hover{background:rgba(0,0,255,.5)}</style>' +
  '<div id="under"></div><canvas id="c" width="2" height="1"></canvas>' +
  '<div id="over"></div>';

test('what is over a canvas that changes at every frame is kept, and made again where the document changes', async () => {
  let image = picture([0, 0, 255]);
  const result = await renderX11(
    h(
      'box',
      { style: { width: 320, height: 320 } },
      h(Html, {
        source: SOURCE,
        partial: false,
        'data-testname': 'doc',
        canvasImage: () => image,
      }),
    ),
    { width: 340, height: 340, ...(FONTS && { fonts: FONTS }) },
  );
  await act();
  const node = (
    screen.getByTestName('doc') as unknown as { children: HtmlViewNode[] }
  ).children[0];
  const canvas = byId(node.document as unknown as Element, 'c');
  const kept = () =>
    (node as unknown as { _retained: { kept: unknown } })._retained.kept;
  const check = async (left: string, message: string) => {
    await expectPixel(result.ctx, 50, 150, left, {
      message: `${message}: the canvas`,
    });
    // green under the canvas's empty half, red over it at half strength
    await expectPixel(result.ctx, 270, 150, overGreen, {
      message: `${message}: what is under it and over it`,
    });
  };
  let overGreen = '#808000';
  const frame = async (rgb: number[]) => {
    image = picture(rgb);
    await act(async () => node.canvasChanged(canvas));
  };
  await check('#0000ff', 'the first');
  // the frames that change nothing but the canvas
  const colours: [number[], string][] = [
    [[255, 255, 0], '#ffff00'],
    [[0, 255, 255], '#00ffff'],
    [[255, 0, 255], '#ff00ff'],
    [[0, 0, 255], '#0000ff'],
  ];
  for (const [rgb, hex] of colours) {
    await frame(rgb);
    await check(hex, 'a frame');
  }
  if (kept() === null) {
    throw new Error('what is over the canvas is not kept after four frames');
  }
  // a part of what is over it restyled where it is, which claims its place
  // and no more: made again in the surface
  const shown = screen.getByTestName('doc') as unknown as object;
  await act(async () =>
    fireEvent.mouseMove(shown as never, { dx: 110, dy: -10 }),
  );
  overGreen = '#008080';
  await frame([255, 255, 0]);
  await check('#ffff00', 'with the pointer over what is over it');
  if (kept() === null) throw new Error('and it is still kept');
  await act(async () => fireEvent.mouseLeave(shown as never));
  overGreen = '#808000';
  await frame([0, 255, 255]);
  await check('#00ffff', 'and with the pointer off it');
  // what is over it changes: made again in the surface, as the document has it
  const over = byId(node.document as unknown as Element, 'over');
  over.attribs.style = 'background:rgba(0,0,255,.5)';
  await act(async () => node.touchDocument());
  overGreen = '#008080';
  await frame([255, 255, 0]);
  await check('#ffff00', 'after what is over it changed');
  await frame([0, 255, 255]);
  await check('#00ffff', 'and a frame after');
  // what is under it changes, which is drawn live in any case
  const under = byId(node.document as unknown as Element, 'under');
  under.attribs.style = 'background:#ff0000';
  await act(async () => node.touchDocument());
  overGreen = '#800080';
  await frame([255, 0, 255]);
  await check('#ff00ff', 'after what is under it changed');
  await frame([0, 0, 255]);
  await check('#0000ff', 'and a frame after');
});
