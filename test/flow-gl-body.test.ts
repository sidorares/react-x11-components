// `FlowNodeType.glBody` — a node body drawn through the pane's own GL
// context: asked for a texture the size of the body's box, drawn as a quad
// in the card in the graph's order, moved by a pan for nothing, and handed
// the pointer over it.
//
// There is no GL here: indirect GLX has no shaders, and the harness's server
// has no GLX at all. So a frame is the surface's driver called by hand
// against a context that records every call — the way `maps-gl.test.ts`
// drives `GlMapDriver` — over a real pane on the in-process X server, whose
// geometry and gestures are the ones a window has.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { act, cleanup, fireEvent, renderX11, screen } from 'react-x11/test';
import type { RenderX11Options } from 'react-x11/test';
import type { Node as RetainedNode } from 'react-x11/node';
import type { DrawnNode } from 'react-x11';

import { Flow, FLOW_ELEMENT } from '../src/index.js';
import type {
  FlowGlBody,
  FlowGlBodyFrame,
  FlowGlBodyHost,
  FlowGlBodyPointer,
  FlowNode,
  FlowNodeData,
  FlowNodeType,
  NodeChange,
} from '../src/index.js';
import { FlowGlDriver } from '../src/flow/gl/index.js';
import type { FlowGlSource } from '../src/flow/gl/index.js';
import { ScenePacker } from '../src/flow/gl/pack.js';
import { buildScene } from '../src/flow/scene.js';
import { flowClock } from '../src/flow/node.js';
import { FRAME_MS, holdClock } from './held-clock.js';

const h = React.createElement;

/** {@link Flow} with its node-data parameter fixed, as `flow.test.ts` has. */
const TypedFlow = Flow<FlowNodeData, unknown>;

afterEach(cleanup);

const FRAMEBUFFER_BINDING = 0x8ca6;

/** A GL table that records every call, answers the rest with numbers, and
 *  keeps the framebuffer bound — what the pane hands back after a body. */
function recordingGl() {
  const log: { name: string; args: unknown[] }[] = [];
  let next = 1;
  let framebuffer: unknown = 'the surface’s framebuffer';
  const constants = new Map<string, number>();
  const target: Record<string, unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: (_p: unknown, name: string) => name,
    getParameter: (p: number) => (p === FRAMEBUFFER_BINDING ? framebuffer : 0),
    bindFramebuffer: (_t: unknown, fbo: unknown) => {
      log.push({ name: 'bindFramebuffer', args: [_t, fbo] });
      framebuffer = fbo;
    },
  };
  return {
    log,
    framebuffer: () => framebuffer,
    gl: new Proxy(target, {
      get(obj, name: string) {
        if (name in obj) return obj[name];
        if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
          if (!constants.has(name))
            constants.set(name, 0x1000 + constants.size);
          return constants.get(name);
        }
        return (...args: unknown[]) => {
          log.push({ name, args });
          return name.startsWith('create') ? next++ : undefined;
        };
      },
    }),
  };
}

/** A body that records what it is asked, and draws a texture named for the
 *  frame it was asked at. */
function fakeBody(take = true) {
  const frames: FlowGlBodyFrame[] = [];
  const events: FlowGlBodyPointer[] = [];
  let attached = 0;
  let detached = 0;
  let host: FlowGlBodyHost | null = null;
  const body: FlowGlBody = {
    attach(h) {
      attached++;
      host = h;
    },
    detach() {
      detached++;
      host = null;
    },
    draw(gl, frame) {
      frames.push(frame);
      // what a body leaves bound is its own business
      (gl as { bindFramebuffer(t: number, f: unknown): void }).bindFramebuffer(
        0,
        'the body’s framebuffer',
      );
      return {
        texture: 'body texture',
        width: frame.width,
        height: frame.height,
      };
    },
    pointer(ev) {
      events.push(ev);
      return take;
    },
  };
  return {
    body,
    frames,
    events,
    attached: () => attached,
    detached: () => detached,
    host: () => host,
  };
}

/** One map-shaped node 200×120 at (100, 100) and a plain card beside it. */
function graph(): FlowNode[] {
  return [
    {
      id: 'map',
      type: 'map',
      position: { x: 100, y: 100 },
      width: 200,
      height: 120,
      data: { label: 'London' },
    },
    {
      id: 'b',
      position: { x: 400, y: 100 },
      width: 120,
      height: 40,
      data: { label: 'B' },
    },
  ];
}

function typesFor(body: FlowGlBody | null): Record<string, FlowNodeType> {
  return {
    map: { headerHeight: 20, glBody: () => body },
  };
}

function pane(): RetainedNode {
  const [node] = screen.all(
    (n) => (n as unknown as RetainedNode).kind === FLOW_ELEMENT,
  );
  assert.ok(node, 'the pane is in the retained tree');
  return node as unknown as RetainedNode;
}

interface Pane extends FlowGlSource {
  setViewport(v: object): void;
  contentBox(): { x: number; y: number; width: number; height: number };
}

/**
 * The raw element on the GL renderer, and the surface's driver over it,
 * drawn by hand. Labels are left out (`glText`): the atlas sets strings on a
 * surface of the app's, which is a story of its own (`flow-gl-text.test.ts`).
 */
async function glPane(
  body: FlowGlBody | null,
  props: Record<string, unknown> = {},
  options: RenderX11Options = {},
) {
  const element = (more: Record<string, unknown> = {}) =>
    h(FLOW_ELEMENT, {
      nodes: graph(),
      edges: [],
      nodeTypes: typesFor(body),
      renderer: 'gl',
      style: { flexGrow: 1 },
      ...props,
      ...more,
    });
  const { rerender } = await renderX11(element(), options);
  const node = pane() as unknown as Pane;
  const source: FlowGlSource = {
    glFrame: (a, b) => node.glFrame(a, b),
    setGlRequest: (r) => node.setGlRequest(r),
    bodyBudget: () => node.bodyBudget(),
    glBodyOf: (id) => node.glBodyOf!(id),
  };
  let asked = 0;
  const driver = new FlowGlDriver({
    pane: { current: source },
    clearColor: '#ffffff',
    onError: (error) => {
      throw error;
    },
  });
  driver.areaRef({ requestFrame: () => void asked++ });
  await act();
  const recording = recordingGl();
  const box = node.contentBox();
  const scale = (node as unknown as { scale?: number }).scale ?? 1;
  const draw = (): void =>
    driver.draw(recording.gl, {
      width: box.width,
      height: box.height,
      scale,
      node: { abs: { x: box.x, y: box.y } },
    });
  return {
    node,
    driver,
    draw,
    recording,
    asked: () => asked,
    rerender: (more: Record<string, unknown>) =>
      act(() => rerender(element(more))),
  };
}

/** The body quads a frame drew: each `u_rect` and the texture bound for it. */
function quads(log: { name: string; args: unknown[] }[]) {
  const out: { rect: number[]; zoom: number; texture: unknown }[] = [];
  let zoom = 1;
  let texture: unknown = null;
  for (const call of log) {
    if (call.name === 'uniform1f' && call.args[0] === 'u_zoom') {
      zoom = call.args[1] as number;
    }
    if (call.name === 'bindTexture') texture = call.args[1];
    if (call.name === 'uniform4f' && call.args[0] === 'u_rect') {
      out.push({ rect: call.args.slice(1) as number[], zoom, texture: null });
    }
    if (
      call.name === 'drawArrays' &&
      out.length &&
      out.at(-1)!.texture === null
    )
      out.at(-1)!.texture = texture;
  }
  return out;
}

test('a GL body is drawn between its card and the card’s title, in a range of its own', () => {
  const nodes = graph();
  const scene = buildScene({
    viewport: { x: 0, y: 0, zoom: 1 },
    pane: { x: 0, y: 0, width: 800, height: 600 },
    clip: null,
    palette: {
      background: '#fff',
      grid: '#ddd',
      text: '#111',
      dim: '#666',
      nodeBackground: '#fff',
      nodeBorder: '#999',
      accent: '#36f',
      edge: '#888',
      edgeSelected: '#36f',
      handle: '#888',
      surface: '#fff',
      surfaceBorder: '#ccc',
      selection: 'rgba(0,0,255,0.1)',
    },
    background: { variant: 'none', gap: 20, size: 1 },
    nodes: nodes.map((node) => ({
      node,
      rect: {
        x: node.position.x,
        y: node.position.y,
        width: node.width!,
        height: node.height!,
      },
      specs: [],
      type: (node.type === 'map' ? typesFor(null).map : undefined) as
        FlowNodeType<unknown> | undefined,
      header: node.type === 'map' ? 20 : 0,
      mounted: false,
      glBody: node.type === 'map',
      connectable: false,
      grips: [],
    })),
    all: [],
    edges: [],
    dashPhase: 0,
    hover: { nodeId: null, handle: null, edgeId: null },
    connection: null,
    selection: null,
    miniMap: null,
    controls: [],
    scale: 1,
    measure: (text) => ({ width: text.length * 7, height: 14 }),
  });
  const packed = new ScenePacker().pack(scene, 'world');
  assert.deepStrictEqual(packed.bodies, [
    {
      id: 'map',
      // the card less its 20-unit header and a 5-unit inset round the rest
      rect: { x: 105, y: 120, width: 190, height: 95 },
    },
  ]);
  const kinds = packed.ranges
    .slice(packed.nodesAt)
    .map((r) => (r.kind === 'body' ? 'body' : r.kind));
  const at = kinds.indexOf('body');
  assert.ok(at > 0, `after the card’s own box: ${kinds}`);
  assert.strictEqual(
    kinds[at + 1],
    'box',
    'and the title and the next card after',
  );
  // the card's title is a box of its own range, after the body
  const first = packed.ranges[packed.nodesAt + at + 1];
  assert.ok(first.first > packed.ranges[packed.nodesAt].first);
});

test('the surface asks a body for its box at the display’s scale, and draws the texture where the node is', async () => {
  for (const scale of [1, 2]) {
    const fake = fakeBody();
    const { draw, recording } = await glPane(fake.body, {}, { scale });
    draw();
    assert.strictEqual(fake.attached(), 1, 'attached by the frame it is in');
    assert.deepStrictEqual(fake.frames, [
      {
        // 190 × 95 graph units at zoom 1
        width: 190 * scale,
        height: 95 * scale,
        scale,
        zoom: 1,
      },
    ]);
    const drawn = quads(recording.log);
    assert.strictEqual(drawn.length, 1, 'one quad');
    assert.deepStrictEqual(drawn[0].rect, [105, 120, 190, 95]);
    assert.strictEqual(drawn[0].texture, 'body texture');
    assert.strictEqual(
      recording.framebuffer(),
      'the surface’s framebuffer',
      'the surface’s framebuffer is bound again after the body',
    );
    cleanup();
  }
});

test('a pan draws the texture somewhere else and asks the body for nothing', async () => {
  const fake = fakeBody();
  const { node, draw, recording } = await glPane(fake.body);
  draw();
  assert.strictEqual(fake.frames.length, 1);
  draw();
  assert.strictEqual(fake.frames.length, 1, 'nothing new, nothing drawn');
  recording.log.length = 0;
  node.setViewport({ x: 30, y: 10, zoom: 1 });
  draw();
  assert.strictEqual(fake.frames.length, 1, 'a pan draws no body');
  assert.strictEqual(quads(recording.log).length, 1, 'and still draws it');
  // the offset the quad was drawn at: the last set before its rect
  let offset: unknown[] = [];
  for (const c of recording.log) {
    if (c.name === 'uniform2f' && c.args[0] === 'u_offset') offset = c.args;
    if (c.name === 'uniform4f' && c.args[0] === 'u_rect') break;
  }
  assert.deepStrictEqual(offset.slice(1), [30, 10], 'moved by the pan');
});

test('a body that asks for a frame gets one, and draws in it', async () => {
  const fake = fakeBody();
  const { draw, asked } = await glPane(fake.body);
  draw();
  const before = asked();
  fake.host()!.requestFrame();
  assert.strictEqual(asked(), before + 1, 'the surface asked for a frame');
  draw();
  assert.strictEqual(fake.frames.length, 2, 'and the body drew in it');
});

test('a body out of view is asked for nothing, and its asking asks for no frame', async () => {
  const fake = fakeBody();
  const { node, draw, asked } = await glPane(fake.body);
  draw();
  // far enough that the node is out of the view and of the world
  node.setViewport({ x: -2000, y: 0, zoom: 1 });
  draw();
  const before = asked();
  fake.host()!.requestFrame();
  assert.strictEqual(asked(), before, 'nothing on screen would change');
  // back in view, it is drawn: it asked
  node.setViewport({ x: 0, y: 0, zoom: 1 });
  draw();
  assert.strictEqual(fake.frames.length, 2);
  assert.strictEqual(fake.detached(), 0, 'kept all the while');
});

test('a zoom gesture stretches the texture, and the body is drawn at the new size once it rests', async (t) => {
  const clock = holdClock(t, flowClock);
  const fake = fakeBody();
  const { node, draw, recording, asked } = await glPane(fake.body);
  draw();
  // a jump: drawn at once at its size
  node.setViewport({ x: 0, y: 0, zoom: 1.2 });
  draw();
  assert.deepStrictEqual(fake.frames.at(-1), {
    width: 228,
    height: 114,
    scale: 1.2,
    zoom: 1.2,
  });
  const drawn = fake.frames.length;
  // the steps after it are a gesture: the world scaled, the body with it
  node.setViewport({ x: 0, y: 0, zoom: 1.5 });
  recording.log.length = 0;
  draw();
  assert.strictEqual(fake.frames.length, drawn, 'no body drawn mid-gesture');
  const [quad] = quads(recording.log);
  assert.ok(
    Math.abs(quad.zoom - 1.5 / 1.2) < 1e-9,
    `stretched by what the world is: ${quad.zoom}`,
  );
  // a body asking for a frame mid-gesture waits for the rest as well
  fake.host()!.requestFrame();
  draw();
  assert.strictEqual(fake.frames.length, drawn, 'held through the gesture');
  // the rest asks for the frame that draws it again
  const before = asked();
  let waited = 0;
  while (asked() === before && (await clock.frame())) waited += FRAME_MS;
  assert.ok(asked() > before);
  draw();
  assert.deepStrictEqual(fake.frames.at(-1), {
    width: 285,
    height: 143,
    scale: 1.5,
    zoom: 1.5,
  });
});

test('a body is let go when its node goes, and when its type stops naming it', async () => {
  const fake = fakeBody();
  const { draw, rerender, recording } = await glPane(fake.body);
  draw();
  assert.strictEqual(fake.attached(), 1);
  // the type names none: let go, and the card drawn without one
  await rerender({ nodeTypes: typesFor(null) });
  recording.log.length = 0;
  draw();
  assert.strictEqual(fake.detached(), 1, 'let go');
  assert.strictEqual(quads(recording.log).length, 0, 'no quad');
  // named again, and then its node removed
  await rerender({ nodeTypes: typesFor(fake.body) });
  draw();
  assert.strictEqual(fake.attached(), 2, 'attached again');
  await rerender({
    nodeTypes: typesFor(fake.body),
    nodes: graph().filter((n) => n.id !== 'map'),
  });
  draw();
  assert.strictEqual(fake.detached(), 2, 'let go with its node');
});

test('the surface going lets go of every body', async () => {
  const fake = fakeBody();
  const { draw, driver } = await glPane(fake.body);
  draw();
  driver.detach();
  assert.strictEqual(fake.detached(), 1);
});

test('a press below the header is the body’s, and its drag and release; the header still drags the node', async () => {
  const fake = fakeBody();
  const changes: NodeChange[][] = [];
  const { draw } = await glPane(fake.body, {
    onNodesChange: (c: NodeChange[]) => void changes.push(c),
  });
  draw();
  const node = pane() as unknown as DrawnNode;
  const at = (x: number, y: number) => {
    const { abs } = pane();
    return {
      dx: x - (abs.x + abs.width / 2),
      dy: y - (abs.y + abs.height / 2),
    };
  };
  // the body is (105, 120) to (295, 215) in the window
  await act(() => {
    fireEvent.mouseDown(node, at(155, 160));
    fireEvent.mouseMove(node, at(175, 170));
    fireEvent.mouseUp(node, at(175, 170));
  });
  const types = fake.events.map((e) => e.type);
  assert.deepStrictEqual(
    types.filter((t) => t !== 'move'),
    ['down', 'drag', 'up'],
  );
  const down = fake.events.find((e) => e.type === 'down')!;
  assert.deepStrictEqual([down.x, down.y], [50, 40], 'in the body’s units');
  const up = fake.events.find((e) => e.type === 'up')!;
  assert.deepStrictEqual([up.x, up.y], [70, 50]);
  assert.ok(
    !changes.flat().some((c) => c.type === 'position'),
    'the node did not move',
  );
  // the header: the node's
  await act(() => {
    fireEvent.mouseDown(node, at(155, 110));
    fireEvent.mouseMove(node, at(195, 130));
    fireEvent.mouseUp(node, at(195, 130));
  });
  const moved = changes
    .flat()
    .filter((c) => c.type === 'position' && c.dragging === false);
  assert.ok(moved.length > 0, 'the header drags the node');
});

test('a wheel over a body that takes it does not zoom the pane', async () => {
  const fake = fakeBody();
  const { node, draw } = await glPane(fake.body);
  draw();
  const before = (node as unknown as { getViewport(): object }).getViewport();
  const { abs } = pane();
  await act(() => {
    fireEvent.wheel(pane() as unknown as DrawnNode, {
      dx: 155 - (abs.x + abs.width / 2),
      dy: 160 - (abs.y + abs.height / 2),
      deltaY: -48,
    });
  });
  const wheel = fake.events.find((e) => e.type === 'wheel');
  assert.ok(wheel, 'the body heard it');
  assert.deepStrictEqual(
    (node as unknown as { getViewport(): object }).getViewport(),
    before,
    'and the pane did not zoom',
  );
});

test('a body that does not take a press leaves it to the node', async () => {
  const fake = fakeBody(false);
  const changes: NodeChange[][] = [];
  const { draw } = await glPane(fake.body, {
    onNodesChange: (c: NodeChange[]) => void changes.push(c),
  });
  draw();
  const node = pane() as unknown as DrawnNode;
  const { abs } = pane();
  const at = (x: number, y: number) => ({
    dx: x - (abs.x + abs.width / 2),
    dy: y - (abs.y + abs.height / 2),
  });
  await act(() => {
    fireEvent.mouseDown(node, at(155, 160));
    fireEvent.mouseMove(node, at(195, 180));
    fireEvent.mouseUp(node, at(195, 180));
  });
  assert.ok(
    changes.flat().some((c) => c.type === 'position' && c.dragging === false),
    'the node was dragged by its body',
  );
});

test('on the 2D renderer a type’s render is its GL body’s fallback', async () => {
  const fake = fakeBody();
  const type: FlowNodeType = {
    headerHeight: 20,
    glBody: () => fake.body,
    render: () => h('text', null, 'fallback'),
  };
  await renderX11(
    h(TypedFlow, {
      nodes: graph(),
      edges: [],
      nodeTypes: { map: type },
      style: { flexGrow: 1 },
    }),
  );
  await act();
  assert.ok(screen.queryByText('fallback'), 'the render body is mounted');
  assert.strictEqual(fake.attached(), 0, 'and the GL body is nobody’s');
});

test('under GL the pane mounts no render body for a type with a GL body', async () => {
  const type: FlowNodeType = {
    headerHeight: 20,
    glBody: () => null,
    render: () => h('text', null, 'fallback'),
  };
  const told = (glBodies: boolean | undefined) => {
    const ids: string[][] = [];
    return {
      ids,
      element: h(FLOW_ELEMENT, {
        nodes: graph(),
        edges: [],
        nodeTypes: { map: type },
        glBodies,
        onNodeBodies: (bodies: readonly { id: string }[]) =>
          void ids.push(bodies.map((b) => b.id)),
        style: { flexGrow: 1 },
      }),
    };
  };
  const twoD = told(false);
  await renderX11(twoD.element);
  await act();
  assert.deepStrictEqual(twoD.ids.at(-1), ['map'], '2D: its render body');
  cleanup();
  const gl = told(true);
  await renderX11(gl.element);
  await act();
  assert.ok(
    gl.ids.every((ids) => !ids.includes('map')),
    `GL: none — ${JSON.stringify(gl.ids)}`,
  );
});
