// <Html> — `<video>`: core's `<video>` mounted over the box layout gave it
// (`src/html/media.ts`, `src/html/videos.ts`), playing what the host answers.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import {
  act,
  cleanup,
  expectPixel,
  renderX11,
  screen,
  waitFor,
} from 'react-x11/test';
import { createVideoFrames, useApp } from 'react-x11';
import type { DrawnNode, NtkApp, VideoFrames } from 'react-x11';
import { Html } from '../../src/html/index.js';
import type { ResourceRequest, ResourceResult } from '../../src/html/index.js';
import { HtmlSource } from '../../src/html/dom.js';
import type { Element } from '../../src/html/dom.js';
import { videoCandidates } from '../../src/html/media.js';
import { FONTS, boxOf, h, view } from './harness.js';

afterEach(cleanup);

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
  }: {
    width?: number;
    height?: number;
    scale?: number;
    asked?: ResourceRequest[];
    wrap?: (doc: ReturnType<typeof h>) => ReturnType<typeof h>;
  } = {},
) {
  function Host() {
    const app = useApp();
    return h(Html, {
      source,
      partial: false,
      'data-testname': 'doc',
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
  assert.deepStrictEqual(videoCandidates(byId('a')), [{ url: 'a.mp4' }]);
  // an empty src is no source, and the <source>s are not looked at
  assert.deepStrictEqual(videoCandidates(byId('b')), []);
  assert.deepStrictEqual(videoCandidates(byId('c')), [
    { url: 'c.webm', type: 'video/webm; codecs=vp9' },
    { url: 'c.mp4', type: 'video/mp4' },
  ]);
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
  const [first, second] = videos();
  assert.deepStrictEqual([first.abs.width, first.abs.height], [64, 32]);
  assert.deepStrictEqual([second.abs.width, second.abs.height], [100, 50]);
});

test('a video something is painted over keeps its poster', async () => {
  // a sibling over the document would hide the caption laid across it
  await renderVideo(
    '<div style="position:relative">' +
      '<video src="a.mp4" style="display:block;width:100px;height:50px"></video>' +
      '<div style="position:absolute;left:0;bottom:0;right:0">caption</div>' +
      '</div>' +
      // and one beside it with nothing over it is mounted
      '<video src="b.mp4" style="display:block;width:100px;height:50px"></video>',
    (request, app) => ({
      kind: 'video',
      frames: createVideoFrames(app, { width: 16, height: 16 }),
    }),
  );
  const mounted = videos();
  assert.strictEqual(mounted.length, 1);
  assert.strictEqual(
    (mounted[0] as unknown as { props: { frames: VideoFrames } }).props.frames
      .width,
    16,
  );
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
