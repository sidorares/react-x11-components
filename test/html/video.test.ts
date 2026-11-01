// <Html> — `<video>`: core's `<video>` mounted over the box layout gave it
// (`src/html/media.ts`, `src/html/videos.ts`), playing what the host answers.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import {
  act,
  cleanup,
  expectPixel,
  fireEvent,
  pixelAt,
  renderX11,
  screen,
  waitFor,
  waitForPixel,
} from 'react-x11/test';
import { createVideoFrames, useApp } from 'react-x11';
import type { DrawnNode, NtkApp, VideoFrames } from 'react-x11';
import { Html } from '../../src/html/index.js';
import type { ResourceRequest, ResourceResult } from '../../src/html/index.js';
import { HtmlSource } from '../../src/html/dom.js';
import type { Element } from '../../src/html/dom.js';
import { videoCandidates } from '../../src/html/media.js';
import { FONTS, boxOf, findById, h, view } from './harness.js';

afterEach(cleanup);

/** A player's rect, as far as these read it. */
interface MediaRectLike {
  hidden?: boolean;
  over?: unknown;
}

type Answer = (
  request: ResourceRequest,
  app: NtkApp,
) => ResourceResult | null | Promise<ResourceResult | null>;

/** A document whose host answers `kind: 'video'` with `answer`, given the
 *  app a sink is made on, and declines everything else. */
async function renderVideo(
  source: string,
  answer: Answer,
  {
    width = 300,
    height = 300,
    scale,
    asked = [],
    wrap = (doc) => doc,
    canvasOpaque,
  }: {
    width?: number;
    height?: number;
    scale?: number;
    asked?: ResourceRequest[];
    wrap?: (doc: ReturnType<typeof h>) => ReturnType<typeof h>;
    canvasOpaque?: () => boolean;
  } = {},
) {
  function Host() {
    const app = useApp();
    return h(Html, {
      source,
      partial: false,
      'data-testname': 'doc',
      canvasOpaque,
      onResource: (request: ResourceRequest) => {
        if (request.kind !== 'video') return null;
        asked.push(request);
        return answer(request, app);
      },
    });
  }
  const result = await renderX11(
    h(
      'box',
      { style: { width, height, flexDirection: 'column' } },
      wrap(h(Host)),
    ),
    {
      width: width + 40,
      height: height + 40,
      ...(FONTS && { fonts: FONTS }),
      ...(scale && { scale }),
    },
  );
  await act();
  const doc = screen.getByTestName('doc') as DrawnNode;
  return { result, doc, el: view(doc) };
}

/** A BGRA sink of one colour, pushed once. */
function solid(
  app: NtkApp,
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
): VideoFrames {
  const sink = createVideoFrames(app, { width, height, format: 'BGRA' });
  const bytes = new Uint8Array(width * height * 4);
  for (let i = 0; i < bytes.length; i += 4) {
    bytes[i] = b;
    bytes[i + 1] = g;
    bytes[i + 2] = r;
    bytes[i + 3] = 255;
  }
  sink.push(bytes);
  return sink;
}

const videos = (): DrawnNode[] => screen.all((n) => n.kind === 'video');

/** A mounted node as the tests read it. */
type Mounted = DrawnNode & {
  parent: Mounted;
  style: Record<string, unknown>;
  props: Record<string, unknown>;
};

/** The box a video is mounted in, which its port is. */
const portOf = (video: DrawnNode): Mounted => (video as Mounted).parent.parent;

/** The box a video fills, its content box. */
const frameOf = (video: DrawnNode): Mounted => (video as Mounted).parent;

test('a video plays its src, and its <source>s in order where it has none', () => {
  const source = new HtmlSource();
  source.setSource(
    '<video id="a" src=" a.mp4 "><source src="x.mp4"></video>' +
      '<video id="b" src=""><source src="x.mp4"></video>' +
      '<video id="c"><source src="c.webm" type="video/webm; codecs=vp9">' +
      '<source><p>fallback</p><source src="c.mp4" type="video/mp4"></video>',
    true,
  );
  const byId = (id: string): Element => {
    const find = (nodes: readonly unknown[]): Element | null => {
      for (const node of nodes as Element[]) {
        if (node.attribs?.id === id) return node;
        const inner = node.children ? find(node.children) : null;
        if (inner) return inner;
      }
      return null;
    };
    return find(source.document.children)!;
  };
  const all = () => true;
  assert.deepStrictEqual(videoCandidates(byId('a'), all), [{ url: 'a.mp4' }]);
  // an empty src is no source, and the <source>s are not looked at
  assert.deepStrictEqual(videoCandidates(byId('b'), all), []);
  assert.deepStrictEqual(videoCandidates(byId('c'), all), [
    { url: 'c.webm', type: 'video/webm; codecs=vp9' },
    { url: 'c.mp4', type: 'video/mp4' },
  ]);
});

test('a <source> whose media does not hold is passed over, and the choice is kept as the window narrows', async () => {
  // GitHub's heroes: a portrait recording for a phone, a landscape one for
  // anything wider
  const asked: ResourceRequest[] = [];
  const source =
    '<style>body{margin:0}</style>' +
    '<video style="display:block;width:100%;height:50px">' +
    '<source src="phone.mp4" media="(max-width: 199px)">' +
    '<source src="still.mp4" media="(prefers-reduced-motion: reduce)">' +
    '<source src="wide.mp4"></video>';
  function Host({ width, still }: { width: number; still: boolean }) {
    const app = useApp();
    return h(
      'box',
      { style: { width, flexDirection: 'column' } },
      h(Html, {
        source,
        partial: false,
        reducedMotion: still,
        onResource: (request: ResourceRequest) => {
          if (request.kind !== 'video') return null;
          asked.push(request);
          return {
            kind: 'video' as const,
            frames: createVideoFrames(app, { width: 16, height: 16 }),
          };
        },
      }),
    );
  }
  const result = await renderX11(h(Host, { width: 300, still: false }), {
    width: 340,
    height: 120,
    ...(FONTS && { fonts: FONTS }),
  });
  await act();
  assert.deepStrictEqual(
    asked.map((r) => r.url),
    ['wide.mp4'],
  );
  const [video] = videos();
  assert.ok(video, 'a player is mounted');
  // HTML's resource selection runs once, and Chrome keeps what it chose:
  // neither the phone's width nor a preference for less motion now
  // changes the video
  await act(() => result.rerender(h(Host, { width: 150, still: true })));
  await act();
  await waitFor(() => assert.strictEqual(videos()[0]?.abs.width, 150));
  assert.strictEqual(videos()[0], video, 'the same player');
  assert.deepStrictEqual(
    asked.map((r) => r.url),
    ['wide.mp4'],
  );
});

test('with no host, a video is its poster, and no player is mounted', async () => {
  await renderX11(
    h(
      'box',
      { style: { width: 300, flexDirection: 'column' } },
      h(Html, { source: '<video src="a.mp4"></video>', partial: false }),
    ),
    { backend: 'mock' },
  );
  await act();
  assert.strictEqual(videos().length, 0);
});

test("a sink the host answers with is core's <video>, over the video's content box", async () => {
  const asked: ResourceRequest[] = [];
  const { el } = await renderVideo(
    '<style>body{margin:0}</style><p style="margin:0;height:20px"></p>' +
      '<video id="v" src="clip.mp4" autoplay muted loop title="A clip" ' +
      'style="display:block;width:120px;height:60px;padding:4px;' +
      'border:2px solid red;margin-left:10px"></video>',
    (_, app) => ({
      kind: 'video',
      frames: createVideoFrames(app, { width: 64, height: 32 }),
    }),
    { asked },
  );
  assert.deepStrictEqual(
    asked.map((r) => [r.url, r.kind, r.type]),
    [['clip.mp4', 'video', undefined]],
    'asked once, as a video',
  );
  const [video] = videos();
  assert.ok(video, 'a player is mounted');
  const box = boxOf(el, 'v');
  // the content box: inside the border and the padding
  assert.deepStrictEqual(
    [video.abs.x - el.abs.x, video.abs.y - el.abs.y],
    [box.x + 6, box.y + 6],
  );
  assert.deepStrictEqual([video.abs.width, video.abs.height], [120, 60]);
  const props = (video as unknown as { props: Record<string, unknown> }).props;
  assert.strictEqual(props.autoPlay, true);
  assert.strictEqual(props.muted, true);
  assert.strictEqual(props.loop, true);
  assert.strictEqual(props['aria-label'], 'A clip');
  assert.strictEqual(
    (props.style as { objectFit: string }).objectFit,
    'contain',
    "the UA sheet's object-fit",
  );
  // a press goes through to the document: no `controls`
  assert.strictEqual(portOf(video).style.pointerEvents, 'none');
});

test('at a display scale of 2 the player is placed in logical pixels', async () => {
  const { el } = await renderVideo(
    // half a CSS pixel down and across: an odd device pixel, which a
    // logical rect rounded again moved a device pixel off the box
    '<style>body{margin:0}</style><p style="margin:0;height:20.5px"></p>' +
      '<video id="v" src="clip.mp4" ' +
      'style="display:block;width:120px;height:60px;margin-left:10.5px">' +
      '</video>',
    (_, app) => ({
      kind: 'video',
      frames: createVideoFrames(app, { width: 64, height: 32 }),
    }),
    { scale: 2 },
  );
  const [video] = videos();
  assert.ok(video);
  const box = boxOf(el, 'v');
  // both device pixels: the box laid out at 2x, the node placed at half
  assert.deepStrictEqual([box.x, box.y], [21, 41]);
  assert.deepStrictEqual(
    [video.abs.x - el.abs.x, video.abs.y - el.abs.y],
    [box.x, box.y],
  );
  assert.deepStrictEqual([video.abs.width, video.abs.height], [240, 120]);
});

test('a source the host declines is the next one asked for, by its type', async () => {
  const asked: ResourceRequest[] = [];
  await renderVideo(
    '<video><source src="a.webm" type="video/webm">' +
      '<source src="b.mp4" type="video/mp4"></video>',
    (request, app) =>
      request.type === 'video/webm'
        ? null
        : {
            kind: 'video',
            frames: createVideoFrames(app, { width: 16, height: 16 }),
          },
    { asked },
  );
  assert.deepStrictEqual(
    asked.map((r) => [r.url, r.type]),
    [
      ['a.webm', 'video/webm'],
      ['b.mp4', 'video/mp4'],
    ],
  );
  assert.strictEqual(videos().length, 1);
});

test('a source the player fails on is the next one played, and none left is the poster', async () => {
  // The in-process X server has no platform player: core's <video src>
  // refuses each `src` with an error, and the document moves on to the next
  const asked: ResourceRequest[] = [];
  await renderVideo(
    '<video><source src="a.mp4"><source src="b.mp4"></video>',
    (request) => ({ kind: 'video', src: request.url }),
    { asked },
  );
  await waitFor(() => assert.strictEqual(asked.length, 2));
  await act();
  assert.deepStrictEqual(
    asked.map((r) => r.url),
    ['a.mp4', 'b.mp4'],
  );
  assert.strictEqual(videos().length, 0, 'none mounted');
});

test('a source answered later mounts its player then', async () => {
  let answer!: (result: ResourceResult) => void;
  let made: VideoFrames | null = null;
  const { result } = await renderVideo(
    '<video src="a.mp4"></video>',
    (_, app) => {
      made = createVideoFrames(app, { width: 16, height: 16 });
      return new Promise((resolve) => (answer = resolve));
    },
  );
  assert.strictEqual(videos().length, 0, 'not while it is being answered');
  await act(async () => answer({ kind: 'video', frames: made! }));
  await act();
  assert.strictEqual(videos().length, 1);
  void result;
});

test("the video takes its stream's size once the player knows it", async () => {
  const { el } = await renderVideo(
    '<style>body{margin:0}</style>' +
      '<video id="a" src="a.mp4"></video>' +
      '<video id="b" src="b.mp4" style="display:block;width:100px"></video>',
    (_, app) => ({
      kind: 'video',
      frames: createVideoFrames(app, { width: 64, height: 32 }),
    }),
  );
  await waitFor(() => {
    // HTML's 300x150 until it is known
    const a = boxOf(el, 'a');
    assert.deepStrictEqual([a.width, a.height], [64, 32]);
  });
  // a side the style sets is held, and the other is the stream's ratio
  const b = boxOf(el, 'b');
  assert.deepStrictEqual([b.width, b.height], [100, 50]);
  // The players are a commit behind the boxes: the frame that sized the
  // boxes reported them (`onMedia`), and the frame that lays the players
  // out at that size comes on the window's clock after the commit — inside
  // the act the wait ended on, or after it, as the clock's phase falls. A
  // warm process ran the boxes' frame in that act's last flush, every time.
  await act();
  const [first, second] = videos();
  assert.deepStrictEqual([first.abs.width, first.abs.height], [64, 32]);
  assert.deepStrictEqual([second.abs.width, second.abs.height], [100, 50]);
});

test('a video its own flow paints something over keeps its poster', async () => {
  // a sibling over the document would hide the caption pulled up across
  // it, which is painted with the video, after it, and is no box a
  // sibling after the player can paint again
  const asked: ResourceRequest[] = [];
  await renderVideo(
    '<div style="position:relative">' +
      '<video src="a.mp4" style="display:block;width:100px;height:50px"></video>' +
      '<p style="margin:-14px 0 0;height:14px">caption</p>' +
      '</div>' +
      // and one beside it with nothing over it is mounted
      '<video src="b.mp4" style="display:block;width:100px;height:50px"></video>',
    (request, app) => ({
      kind: 'video',
      frames: createVideoFrames(app, { width: 16, height: 16 }),
    }),
    { asked },
  );
  assert.deepStrictEqual(
    asked.map((r) => r.url),
    ['b.mp4'],
  );
  const mounted = videos();
  assert.strictEqual(mounted.length, 1);
  assert.strictEqual(
    (mounted[0] as unknown as { props: { frames: VideoFrames } }).props.frames
      .width,
    16,
  );
});

test('a video in the flow of a box has what is painted after the box painted over its player', async () => {
  // diabrowser.com's hero: a video in a box its scroll moves, a box with
  // a z-index around both, and the dock with a higher one over its foot
  const asked: ResourceRequest[] = [];
  const { result } = await renderVideo(
    '<style>body{margin:0;background:#fff}</style>' +
      '<div style="position:relative;z-index:1;width:80px">' +
      '<div style="position:relative">' +
      '<video src="a.mp4" style="display:block;width:80px;height:40px">' +
      '</video></div></div>' +
      '<div style="position:relative;z-index:3;margin-top:-16px;' +
      'width:80px;height:16px;background:#f00"></div>',
    (_, app) => ({ kind: 'video', frames: solid(app, 16, 8, [0, 255, 0]) }),
    { asked },
  );
  assert.deepStrictEqual(
    asked.map((r) => r.url),
    ['a.mp4'],
  );
  assert.strictEqual(videos().length, 1, 'a player is mounted');
  const over = screen.all((n) => n.kind === 'canvas');
  assert.strictEqual(over.length, 1, 'and a canvas after it');
  assert.deepStrictEqual(
    [over[0].abs.x, over[0].abs.y, over[0].abs.width, over[0].abs.height],
    [0, 24, 80, 16],
    'over the foot the dock reaches',
  );
  await act();
  await expectPixel(result.ctx, 40, 10, '#00ff00', { message: 'the frame' });
  await expectPixel(result.ctx, 40, 32, '#ff0000', {
    message: 'the dock over it',
  });
});

test('a player in a sticky box, and what is painted over it, stay with the box in every frame the pane scrolls, at 1x and 2x', async () => {
  // The pane's scroll moved the player with the text while the box stayed,
  // and the report at the paint put it back. Core moves it with the box in
  // the pass a scroll runs, and the `<canvas>` of what the document paints
  // over it, a play button here, with it
  const source =
    '<style>body{margin:0;background:#fff}#wrap{height:700px}' +
    '#side{position:sticky;top:10px;height:60px}' +
    '#play{position:absolute;left:4px;top:4px;width:10px;height:10px;' +
    'background:#f00}</style>' +
    '<div style="height:40px"></div><div id="wrap"><div id="side">' +
    '<video src="a.mp4" style="display:block;width:80px;height:40px"></video>' +
    '<div id="play"></div></div></div><div style="height:2000px"></div>';
  for (const scale of [1, 2]) {
    let pane: (DrawnNode & { scrollTo(y: number): void }) | null = null;
    const { result, el } = await renderVideo(
      source,
      (_, app) => ({ kind: 'video', frames: solid(app, 16, 8, [0, 255, 0]) }),
      {
        scale,
        height: 200,
        wrap: (doc) =>
          h(
            'box',
            {
              ref: (node: typeof pane) => {
                pane = node;
              },
              style: { width: 300, height: 200, overflow: 'scroll' },
            },
            doc,
          ),
      },
    );
    const player = videos()[0];
    const over = screen.all((n) => n.kind === 'canvas')[0];
    assert.ok(player && over, `a player and a canvas over it, ${scale}x`);
    const onScreen = (node: DrawnNode) => (node.abs.y - pane!.abs.y) / scale;
    const told = (el as unknown as { _media: { held?: true }[] })._media;
    assert.strictEqual(told[0].held, true, `in the sticky box, ${scale}x`);
    // every paint of the scroll, the frame that scrolled the first of them
    const paint = el.paint;
    let painted = 0;
    let expected: number[] = [];
    el.paint = function (this: typeof el, ctx) {
      painted += 1;
      assert.deepStrictEqual(
        [onScreen(player), onScreen(over)],
        expected,
        `a paint sees them where the box is, ${scale}x`,
      );
      return paint.call(this, ctx);
    };
    // the box starts 40px down, stops 10px down, and leaves with the end of
    // the box around it, 680px down the page
    const boxAt = (y: number) => Math.min(Math.max(40 - y, 10), 680 - y);
    for (const y of [20, 30, 45, 60, 500, 660, 670, 690, 600, 300]) {
      expected = [boxAt(y), boxAt(y) + 4];
      await act(async () => pane!.scrollTo(y));
      assert.deepStrictEqual(
        [onScreen(player), onScreen(over)],
        expected,
        `scrolled to ${y}, they are where the box is, ${scale}x`,
      );
    }
    assert.ok(painted > 0, `the document was painted, ${scale}x`);
    el.paint = paint;
    assert.strictEqual(
      (el as unknown as { _media: unknown })._media,
      told,
      `a scroll tells the players nothing, ${scale}x`,
    );
    await act();
    await expectPixel(result.ctx, 40 * scale, 30 * scale, '#00ff00', {
      message: `the frame, in the box, ${scale}x`,
    });
    await expectPixel(result.ctx, 8 * scale, 18 * scale, '#ff0000', {
      message: `the button over it, ${scale}x`,
    });
    await result.unmount();
  }
});

test('a player stays the player it was as a page makes its box sticky or not', async () => {
  // A new player is a video from its start, so the boxes it is kept in do
  // not come and go with the position of the box it is in
  const asked: ResourceRequest[] = [];
  let pane: (DrawnNode & { scrollTo(y: number): void }) | null = null;
  const { el } = await renderVideo(
    '<style>body{margin:0}</style>' +
      '<div style="height:40px"></div><div style="height:700px">' +
      '<div id="side" style="position:sticky;top:10px">' +
      '<video src="a.mp4" style="display:block;width:80px;height:40px">' +
      '</video></div></div><div style="height:2000px"></div>',
    (_, app) => ({ kind: 'video', frames: solid(app, 16, 8, [0, 255, 0]) }),
    {
      asked,
      height: 200,
      wrap: (doc) =>
        h(
          'box',
          {
            ref: (node: typeof pane) => {
              pane = node;
            },
            style: { width: 300, height: 200, overflow: 'scroll' },
          },
          doc,
        ),
    },
  );
  const player = videos()[0];
  const onScreen = () => player.abs.y - pane!.abs.y;
  await act(async () => pane!.scrollTo(100));
  assert.strictEqual(onScreen(), 10, 'sticky, and held');
  const side = findById(el.document!, 'side')!;
  for (const [style, top, name] of [
    ['', -60, 'in the flow'],
    ['position:sticky;top:10px', 10, 'sticky again'],
  ] as const) {
    side.attribs.style = style;
    await act(() => el.touchDocument(null));
    await act();
    assert.strictEqual(videos()[0], player, `the same player, ${name}`);
    assert.strictEqual(onScreen(), top, `where the box is, ${name}`);
  }
  assert.strictEqual(asked.length, 1, 'and its source was asked for once');
});

test('a box over a video that draws nothing there leaves it mounted', async () => {
  // github.com/features/ai/github-app's hero: an empty box laid over the
  // video for a script to draw a gradient where it is, and a header whose
  // hidden menu is as tall as the hero under it
  const asked: ResourceRequest[] = [];
  await renderVideo(
    '<style>body{margin:0}</style>' +
      '<header style="position:relative;z-index:32;height:20px">' +
      '<div style="position:absolute;top:20px;left:0;width:200px;' +
      'height:200px;visibility:hidden;opacity:0;background:#fff">menu</div>' +
      '</header>' +
      '<div style="position:relative;overflow:hidden">' +
      '<video src="a.mp4" style="display:block;width:100px;height:50px;' +
      'position:relative"></video>' +
      '<div style="position:absolute;top:0;left:0;width:100%;height:100%">' +
      '</div></div>',
    (_, app) => ({
      kind: 'video',
      frames: createVideoFrames(app, { width: 16, height: 16 }),
    }),
    { asked },
  );
  assert.deepStrictEqual(
    asked.map((r) => r.url),
    ['a.mp4'],
  );
  assert.strictEqual(videos().length, 1);
});

for (const scale of [1, 2]) {
  test(`a box the document paints over a video is painted over its player again, at a scale of ${scale}`, async () => {
    // GitHub's hero: a play button in the corner of a positioned video, in
    // a box that clips them both
    const { result, el } = await renderVideo(
      '<style>body{margin:0;background:#fff}</style>' +
        '<div style="position:relative;overflow:hidden;width:80px">' +
        '<video src="a.mp4" style="display:block;position:relative;' +
        'width:80px;height:40px"></video>' +
        '<div id="b" style="position:absolute;z-index:1;right:4px;' +
        'bottom:4px;width:24px;height:24px;background:#f00"></div></div>',
      // the box's ratio, which the picture fills
      (_, app) => ({ kind: 'video', frames: solid(app, 16, 8, [0, 255, 0]) }),
      { scale },
    );
    const [video] = videos();
    assert.ok(video, 'a player is mounted');
    const over = screen.all((n) => n.kind === 'canvas');
    assert.strictEqual(over.length, 1, 'and a canvas after it');
    // device pixels, both: the box laid out at the scale, the canvas
    // placed at it
    const button = boxOf(el, 'b');
    assert.deepStrictEqual(
      [
        over[0].abs.x - el.abs.x,
        over[0].abs.y - el.abs.y,
        over[0].abs.width,
        over[0].abs.height,
      ],
      [button.x, button.y, 24 * scale, 24 * scale],
    );
    await act();
    await expectPixel(result.ctx, 10 * scale, 10 * scale, '#00ff00', {
      message: 'the frame',
    });
    await expectPixel(
      result.ctx,
      button.x + 12 * scale,
      button.y + 12 * scale,
      '#ff0000',
      { message: 'the box over it' },
    );
  });
}

/** A positioned 80 by 40 video with `over` after it in a box as wide. */
const videoUnder = (src: string, over: string, video = ''): string =>
  '<div style="position:relative;width:80px">' +
  `<video src="${src}" style="display:block;position:relative;` +
  `width:80px;height:40px;${video}"></video>${over}</div>`;

/** A 24px square laid over a video at (`left`, 8), as positioned. */
const square = (left: number, style: string): string =>
  `<div style="position:absolute;z-index:1;left:${left}px;top:8px;` +
  `width:24px;height:24px;${style}"></div>`;

for (const scale of [1, 2]) {
  test(`a box scaled or turned over a video is painted over its player through its matrix, at a scale of ${scale}`, async () => {
    const { result } = await renderVideo(
      '<style>body{margin:0;background:#fff}</style>' +
        videoUnder(
          'a.mp4',
          // a half of it about its middle, 10 to 22 across and 14 to 26
          // down, and a diamond about 56, 20 reaching 17 each way
          square(4, 'background:#f00;transform:scale(.5)') +
            square(44, 'background:#00f;transform:rotate(45deg)'),
        ),
      (_, app) => ({ kind: 'video', frames: solid(app, 16, 8, [0, 255, 0]) }),
      { scale },
    );
    assert.strictEqual(videos().length, 1, 'a player is mounted');
    await act();
    const at = (x: number, y: number, want: string, message: string) =>
      expectPixel(result.ctx, x * scale, y * scale, want, {
        tolerance: 2,
        message,
      });
    await at(16, 20, '#ff0000', 'the middle of the box scaled');
    await at(6, 10, '#00ff00', 'the frame, where it was laid out');
    await at(56, 20, '#0000ff', 'the middle of the box turned');
    await at(45, 9, '#00ff00', 'the frame, past a corner turned away');
    await at(71, 20, '#0000ff', 'a corner turned past where it was laid out');
  });
}

test('a faded box over a video is painted over its player at its opacity, and a faded video fades nothing over it', async () => {
  const { result } = await renderVideo(
    '<style>body{margin:0;background:#fff}</style>' +
      videoUnder('a.mp4', square(4, 'background:#f00;opacity:.5')) +
      videoUnder('b.mp4', square(4, 'background:#f00'), 'opacity:.5'),
    (_, app) => ({ kind: 'video', frames: solid(app, 16, 8, [0, 255, 0]) }),
  );
  assert.strictEqual(videos().length, 2, 'both are mounted');
  await act();
  await expectPixel(result.ctx, 16, 20, [128, 128, 0], {
    tolerance: 3,
    message: 'red at half over the frame',
  });
  await expectPixel(result.ctx, 50, 60, [128, 255, 128], {
    tolerance: 3,
    message: 'the second frame at half over the page',
  });
  await expectPixel(result.ctx, 16, 60, '#ff0000', {
    message: 'and the box over it, whole',
  });
});

test('a filtered box over a video is painted over its player through its filter, and a blur past its edge', async () => {
  const { result } = await renderVideo(
    '<style>body{margin:0;background:#fff}</style>' +
      videoUnder(
        'a.mp4',
        square(4, 'background:#00f;filter:invert(1)') +
          square(48, 'background:#f00;filter:blur(2px)'),
      ),
    (_, app) => ({ kind: 'video', frames: solid(app, 16, 8, [0, 255, 0]) }),
  );
  assert.strictEqual(videos().length, 1, 'a player is mounted');
  // drawn from a read of what the box paints, where the context runs no
  // filter itself
  await waitForPixel(result.ctx, 16, 20, '#ffff00', {
    message: 'blue inverted',
  });
  await waitForPixel(result.ctx, 60, 20, '#ff0000', {
    tolerance: 2,
    message: 'the middle of the box blurred',
  });
  // a pixel and a half past its left edge, a fifth of the way to red: the
  // blur reaches over the frame, which shows under it
  const [r, g, b] = await pixelAt(result.ctx, 46, 20);
  assert.ok(
    r > 20 && r < 120 && g > 130 && g < 240 && b < 10,
    `the blur over the frame, past the box: ${[r, g, b]}`,
  );
});

test('a sticky box the viewport holds over a video is painted over its player where the scroll has it', async () => {
  // diabrowser.com's dock, held at the foot of the viewport over the hero
  const pane = { current: null as null | { scrollTo(y: number): void } };
  const { result } = await renderVideo(
    '<style>body{margin:0;background:#fff}</style>' +
      '<div style="position:relative;z-index:1;width:80px">' +
      '<div style="position:relative">' +
      '<video src="a.mp4" style="display:block;width:80px;height:300px">' +
      '</video></div></div>' +
      '<div style="position:sticky;bottom:0;z-index:3;margin-top:-40px;' +
      'width:80px;height:40px;background:#f00"></div>' +
      '<div style="height:600px"></div>',
    (_, app) => ({ kind: 'video', frames: solid(app, 8, 30, [0, 255, 0]) }),
    {
      height: 200,
      wrap: (doc) =>
        h(
          'box',
          {
            style: { flexGrow: 1, overflow: 'scroll' },
            ref: (node: unknown) => {
              pane.current = node as typeof pane.current;
            },
          },
          doc,
        ),
    },
  );
  const [video] = videos();
  assert.ok(video, 'a player is mounted');
  await act();
  await expectPixel(result.ctx, 40, 150, '#00ff00', { message: 'the frame' });
  await expectPixel(result.ctx, 40, 180, '#ff0000', {
    message: 'the dock at the foot of the viewport',
  });
  await act(async () => pane.current!.scrollTo(50));
  await act();
  await waitFor(() => {
    const [over] = screen.all((n) => n.kind === 'canvas');
    assert.deepStrictEqual(
      [over.abs.y, over.abs.height],
      [160, 40],
      'the canvas where the dock is held',
    );
  });
  assert.strictEqual(videos()[0], video, 'the same player');
  await expectPixel(result.ctx, 40, 150, '#00ff00', { message: 'the frame' });
  await expectPixel(result.ctx, 40, 180, '#ff0000', {
    message: 'the dock, held there as the video scrolled under it',
  });
});

test('a video wholly under an opaque canvas is hidden, and nothing is painted over it again', async () => {
  const source = (canvasStyle: string) =>
    '<div style="position:relative;width:200px;height:100px">' +
    '<video src="v.mp4" style="display:block;width:200px;height:100px"></video>' +
    `<canvas id="c" style="position:absolute;left:0;top:0;width:200px;height:100px;${canvasStyle}"></canvas>` +
    '</div>';
  const mediaOf = async (
    style: string,
    opaque: boolean,
  ): Promise<MediaRectLike> => {
    const { el } = await renderVideo(
      source(style),
      (_request, app) => ({
        kind: 'video',
        frames: solid(app, 40, 20, [10, 20, 30]),
      }),
      { canvasOpaque: () => opaque },
    );
    await waitFor(() => assert.equal(videos().length, 1));
    const [rect] = (el as unknown as { _media: MediaRectLike[] })._media;
    cleanup();
    return rect;
  };
  const covered = await mediaOf('', true);
  assert.equal(covered.hidden, true);
  assert.equal(covered.over, undefined, 'and nothing is painted over it');
  // a canvas a page's context says has alpha may show what is under it
  const clear = await mediaOf('', false);
  assert.equal(clear.hidden, undefined);
  assert.ok(clear.over, 'so it goes on being painted over the player');
  // and an opaque canvas shows what is under it where it is faded, or only
  // reaches part of the video
  const faded = await mediaOf('opacity:0.5', true);
  assert.equal(faded.hidden, undefined);
  const part = await mediaOf('width:100px', true);
  assert.equal(part.hidden, undefined);
});

test('a video under a box it cannot be painted again over keeps its poster', async () => {
  const asked: ResourceRequest[] = [];
  await renderVideo(
    // faded with the box over it: the document fades the two as one
    // group, which a player and a paint over it are two of
    '<div style="opacity:.5">' +
      videoUnder('a.mp4', square(4, 'background:#f00')) +
      '</div>' +
      // cut by a rounded box around it, where the canvas clips to a
      // rectangle
      videoUnder(
        'b.mp4',
        '<div style="position:absolute;left:4px;top:8px;width:24px;' +
          'height:24px;overflow:hidden;border-radius:8px">' +
          square(0, 'background:#f00') +
          '</div>',
      ) +
      // more of them than are painted again
      videoUnder(
        'c.mp4',
        [0, 12, 24, 36, 48].map((x) => square(x, 'background:#f00')).join(''),
      ) +
      // scaled with the box over it, which is painted again where it is
      // laid out
      '<div style="transform:scale(.5);transform-origin:0 0">' +
      videoUnder('d.mp4', square(4, 'background:#f00')) +
      '</div>',
    (_, app) => ({
      kind: 'video',
      frames: createVideoFrames(app, { width: 16, height: 16 }),
    }),
    { asked },
  );
  assert.deepStrictEqual(asked, [], 'a host is not asked');
  assert.strictEqual(videos().length, 0);
});

test('a video turned, cut to a path or fixed to the viewport keeps its poster', async () => {
  const asked: ResourceRequest[] = [];
  await renderVideo(
    '<div style="transform:rotate(10deg)">' +
      '<video src="a.mp4" style="display:block;width:60px;height:30px"></video></div>' +
      '<video src="b.mp4" style="display:block;width:60px;height:30px;' +
      'clip-path:circle(40%)"></video>' +
      '<video src="c.mp4" style="position:fixed;bottom:0;width:60px;height:30px">' +
      '</video>' +
      // a translation is layout's, and moves the box
      '<div style="transform:translate(5px, 5px)">' +
      '<video src="d.mp4" style="display:block;width:60px;height:30px"></video></div>',
    (_, app) => ({
      kind: 'video',
      frames: createVideoFrames(app, { width: 16, height: 16 }),
    }),
    { asked },
  );
  assert.deepStrictEqual(
    asked.map((r) => r.url),
    ['d.mp4'],
    'a host is not asked for a video nothing would show',
  );
  assert.strictEqual(videos().length, 1);
});

test('a video in a box scaled the same both ways plays where the box draws it, at 1x and 2x', async () => {
  for (const scale of [1, 2]) {
    await renderVideo(
      '<style>body{margin:0}</style>' +
        '<div style="height:10px"></div>' +
        '<div style="transform-origin:0 0;transform:scale(0.5)">' +
        '<video src="a.mp4" style="display:block;width:120px;height:60px">' +
        '</video></div>',
      (_, app) => ({
        kind: 'video',
        frames: createVideoFrames(app, { width: 16, height: 16 }),
      }),
      { scale },
    );
    const [video, ...rest] = videos();
    assert.strictEqual(rest.length, 0, `${scale}x: one player`);
    assert.deepStrictEqual(
      [video.abs.x, video.abs.y, video.abs.width, video.abs.height],
      [0, 10 * scale, 60 * scale, 30 * scale],
      `${scale}x: at half its size`,
    );
    cleanup();
  }
});

test('a video in a box that clips it is cut where the box cuts it, and rounded where it is', async () => {
  const { el } = await renderVideo(
    '<style>body{margin:0}</style>' +
      '<div id="c" style="overflow:hidden;width:80px;height:40px">' +
      '<video id="v" src="a.mp4" style="display:block;width:120px;height:60px">' +
      '</video></div>' +
      // past where what the box cuts off would be: a box is over a video
      // where its ink is, cut or not
      '<div style="height:30px"></div>' +
      '<video id="r" src="b.mp4" style="display:block;width:120px;height:60px;' +
      'border-radius:12px"></video>' +
      // corners that are not one circle are nothing a box rounds
      '<video src="c.mp4" style="display:block;width:120px;height:60px;' +
      'border-radius:12px 0 0 0"></video>' +
      // and a card with round corners that cuts it is the port's corners
      '<div style="margin-top:10px;width:120px;border-radius:16px;' +
      'overflow:hidden"><video src="d.mp4" style="display:block;' +
      'width:120px;height:60px"></video></div>',
    (_, app) => ({
      kind: 'video',
      frames: createVideoFrames(app, { width: 16, height: 16 }),
    }),
  );
  const [cut, round, card, ...rest] = videos();
  assert.strictEqual(rest.length, 0);
  const cardPort = portOf(card);
  assert.deepStrictEqual(
    [
      cardPort.abs.width,
      cardPort.abs.height,
      cardPort.style.borderRadius,
      cardPort.style.overflow,
    ],
    [120, 60, 16, 'hidden'],
  );
  const port = portOf(cut);
  assert.deepStrictEqual(
    [port.abs.width, port.abs.height, port.style.overflow],
    [80, 40, 'hidden'],
  );
  assert.deepStrictEqual([cut.abs.width, cut.abs.height], [120, 60]);
  const frame = frameOf(round);
  assert.deepStrictEqual(
    [frame.style.borderRadius, frame.style.overflow],
    [12, 'hidden'],
  );
  assert.strictEqual(boxOf(el, 'r').width, 120);
});

test('a press on a video with controls is the video’s, and on one without the document’s', async () => {
  await renderVideo(
    '<video src="a.mp4" controls style="display:block;width:60px;height:30px">' +
      '</video>',
    (_, app) => ({
      kind: 'video',
      frames: createVideoFrames(app, { width: 16, height: 16 }),
    }),
  );
  const [video] = videos();
  assert.strictEqual(portOf(video).style.pointerEvents, 'box-none');
  assert.strictEqual(
    typeof (video as unknown as { props: { onClick?: unknown } }).props.onClick,
    'function',
  );
});

/** A player's own state, as a test stands in for it: `src`'s player is
 *  the platform's, and a sink plays what it is pushed and is never paused
 *  or playing. */
function standIn(video: DrawnNode): { calls: string[] } {
  const calls: string[] = [];
  let playing = true;
  Object.assign(video, {
    play: () => void (calls.push('play'), (playing = true)),
    pause: () => void (calls.push('pause'), (playing = false)),
    seek: (t: number) => void calls.push(`seek ${t}`),
  });
  Object.defineProperty(video, 'paused', { get: () => !playing });
  return { calls };
}

test('what a script asks of a video is its player’s props, kept for the element so a player mounted later is told it', async () => {
  const { el } = await renderVideo(
    '<video id="a" src="a.mp4" autoplay muted ' +
      'style="display:block;width:60px;height:30px"></video>' +
      '<video id="b" src="b.mp4" style="display:none;width:60px;height:30px">' +
      '</video>',
    (_, app) => ({
      kind: 'video',
      frames: createVideoFrames(app, { width: 16, height: 16 }),
    }),
  );
  const a = findById(el.document, 'a')!;
  const b = findById(el.document, 'b')!;
  const [video] = videos();
  const props = (video as Mounted).props;
  // nothing asked: the markup's, and `paused` left to `autoPlay`
  assert.strictEqual(props.autoPlay, true);
  assert.strictEqual(props.muted, true);
  assert.ok(!('paused' in props), 'not controlled until something says');
  const { calls } = standIn(video);
  await act(async () => {
    el.setMediaState(a, { paused: true, muted: false, volume: 0.5 });
    el.setMediaState(a, { playbackRate: 2, currentTime: 3 });
    // and one with no player yet
    el.setMediaState(b, { paused: true, currentTime: 0 });
  });
  const after = (videos()[0] as Mounted).props;
  assert.strictEqual(videos()[0], video, 'the same player, told');
  assert.deepStrictEqual(
    [after.paused, after.muted, after.volume, after.playbackRate],
    [true, false, 0.5, 2],
  );
  assert.strictEqual(after.autoPlay, true, 'the markup as it was');
  assert.deepStrictEqual(calls, ['seek 3'], 'sought once');
  // the same props again: no seek
  await act(async () => el.setMediaState(a, { paused: true }));
  assert.deepStrictEqual(calls, ['seek 3']);

  // shown, the second is mounted as it was asked to be, and sought where
  // its first player is
  const seeks: number[] = [];
  const seek = Object.getPrototypeOf(video).seek;
  Object.getPrototypeOf(video).seek = function (t: number) {
    seeks.push(t);
  };
  try {
    b.attribs.style = 'display:block;width:60px;height:30px';
    await act(async () => el.touchDocument());
    await waitFor(() => assert.strictEqual(videos().length, 2));
    const shown = (videos()[1] as Mounted).props;
    assert.strictEqual(shown.paused, true);
    assert.deepStrictEqual(seeks, [0]);
  } finally {
    Object.getPrototypeOf(video).seek = seek;
  }
});

test('a press on a video with controls plays or pauses it at once, and is kept as a script’s ask is', async () => {
  const { el } = await renderVideo(
    '<video id="v" src="a.mp4" controls autoplay ' +
      'style="display:block;width:60px;height:30px"></video>',
    (_, app) => ({
      kind: 'video',
      frames: createVideoFrames(app, { width: 16, height: 16 }),
    }),
  );
  const [video] = videos();
  const { calls } = standIn(video);
  await act(async () => fireEvent.click(video));
  assert.deepStrictEqual(calls, ['pause']);
  assert.strictEqual((videos()[0] as Mounted).props.paused, true);
  // a script plays it again: a change of the prop, which tells the player
  await act(async () =>
    el.setMediaState(findById(el.document, 'v')!, { paused: false }),
  );
  assert.strictEqual((videos()[0] as Mounted).props.paused, false);
  await act(async () => fireEvent.click(video));
  assert.deepStrictEqual(calls, ['pause', 'play']);
});

test('over a video with controls the window shows the arrow, not the document’s I-beam', async () => {
  await renderVideo(
    '<p>text before</p>' +
      '<video src="a.mp4" controls style="display:block;width:60px;height:30px">' +
      '</video>',
    (_, app) => ({
      kind: 'video',
      frames: createVideoFrames(app, { width: 16, height: 16 }),
    }),
  );
  const [video] = videos();
  const wnd = (
    video as unknown as {
      root: { window: { setCursor(name: string | null): void } };
    }
  ).root.window;
  const shown: (string | null)[] = [];
  const set = wnd.setCursor.bind(wnd);
  wnd.setCursor = (name) => {
    shown.push(name);
    set(name);
  };
  fireEvent.mouseMove(video);
  await act();
  await waitFor(() => assert.ok(shown.length > 0, 'a cursor'));
  assert.strictEqual(shown.at(-1), 'default');
});

test('a box fixed to the viewport cuts the player where the scroll brings it over', async () => {
  const pane = { current: null as null | { scrollTo(y: number): void } };
  const { el } = await renderVideo(
    '<style>body{margin:0}</style>' +
      '<div style="position:fixed;top:0;left:0;right:0;height:30px;' +
      'background:#00f"></div>' +
      '<div style="height:60px"></div>' +
      '<video id="v" src="a.mp4" style="display:block;width:100px;height:50px">' +
      '</video><div style="height:600px"></div>',
    (_, app) => ({
      kind: 'video',
      frames: createVideoFrames(app, { width: 16, height: 16 }),
    }),
    {
      height: 200,
      wrap: (doc) =>
        h(
          'box',
          {
            style: { flexGrow: 1, overflow: 'scroll' },
            ref: (node: unknown) => {
              pane.current = node as typeof pane.current;
            },
          },
          doc,
        ),
    },
  );
  const [video] = videos();
  assert.ok(video);
  assert.strictEqual(portOf(video).abs.height, 50, 'clear of the header');
  // the header's 30px over the video's top 10
  await act(async () => pane.current!.scrollTo(40));
  await act();
  await waitFor(() => {
    const port = portOf(videos()[0]);
    assert.deepStrictEqual(
      [port.abs.height, port.style.overflow],
      [40, 'hidden'],
    );
  });
  assert.strictEqual(videos()[0], video, 'the same player');
  assert.strictEqual(boxOf(el, 'v').height, 50);
});

test('a frame the host pushes is drawn where the video is', async () => {
  const { result } = await renderVideo(
    '<style>body{margin:0;background:#fff}</style>' +
      '<video src="a.mp4" style="display:block;width:40px;height:40px"></video>',
    (_, app) => ({ kind: 'video', frames: solid(app, 8, 8, [0, 255, 0]) }),
  );
  await act();
  await expectPixel(result.ctx, 20, 20, '#00ff00', {
    message: "the frame, in the video's box",
  });
  await expectPixel(result.ctx, 20, 60, '#ffffff', {
    message: 'and the document past it',
  });
});
