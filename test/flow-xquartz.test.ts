// `<Flow renderer="gl">` on a server where nothing can be drawn over a GL
// surface — XQuartz, which core recognises by its Apple-DRI extension and
// answers `useSupports('glOverlay')` false for (sidorares/react-x11#653).
// There the mounted node bodies, which are the surface's children, would
// never be seen: a graph whose node types mount bodies draws with the 2D
// renderer instead — a graph with such a node, not a registry with such a
// type. node-x11's in-process server is made to advertise the
// extension; the same server without it is the control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';

import { createRoot } from 'react-x11';

import { Flow } from '../src/flow/index.js';
import type { FlowFrameStats, FlowNodeType } from '../src/flow/types.js';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const xserver = require('x11/lib/xserver/index.js') as any;
const { createClient } = require('ntk') as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const h = React.createElement;

/** Present, and nothing more: core only asks whether it is there. */
const appleDri = {
  name: 'Apple-DRI',
  eventsCount: 0,
  errorsCount: 0,
  handleRequest() {},
};

const form: FlowNodeType = {
  size: { width: 200, height: 120 },
  headerHeight: 20,
  render: () => h('text', null, 'body'),
};

async function run(
  xquartz: boolean,
  type: string | null = 'form',
): Promise<{
  renderers: Set<string>;
  glareas: number;
  errors: string[];
}> {
  const server = xserver.createServer({ width: 640, height: 480 });
  if (xquartz) server.registerExtension('Apple-DRI', appleDri);
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  // no font source: ntk finds the system's, as react-x11/test's harness does
  const app = await createClient({ stream: clientEnd });
  const root = await createRoot({ app });
  const renderers = new Set<string>();
  const errors: string[] = [];
  let glareas = 0;
  try {
    await new Promise<void>((resolve) =>
      root.render(
        h(
          'window',
          { width: 640, height: 480 },
          h(Flow, {
            defaultNodes: [
              { id: 'a', type: type ?? undefined, position: { x: 40, y: 40 } },
            ],
            defaultEdges: [],
            nodeTypes: { form } as Record<string, FlowNodeType<unknown>>,
            // the bare client has none of what the grid's tile pattern needs
            background: false,
            renderer: 'gl',
            onFrame: (s: FlowFrameStats) => void renderers.add(s.renderer),
            onError: (e: Error) => void errors.push(e.message),
            style: { flexGrow: 1 },
          }),
        ),
        resolve,
      ),
    );
    // the GL module is loaded by dynamic import; give it, and a frame, time
    const count = (): number => {
      let n = 0;
      const walk = (node: { kind?: string; children?: unknown[] }) => {
        if (node.kind === 'glarea') n++;
        for (const c of node.children ?? []) walk(c as typeof node);
      };
      for (const w of (
        root as unknown as {
          app: { _windows?: Map<unknown, { _reactX11Node?: object }> };
        }
      ).app._windows?.values() ?? [])
        if (w._reactX11Node) walk(w._reactX11Node);
      return n;
    };
    for (let i = 0; i < 40; i++) {
      glareas = Math.max(glareas, count());
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    root.unmount?.();
    app.close?.();
  }
  return { renderers, glareas, errors };
}

test('on XQuartz, a graph that mounts bodies draws with the 2D renderer', async () => {
  const { renderers, glareas, errors } = await run(true);
  assert.equal(glareas, 0, 'no GL surface is made');
  assert.deepEqual([...renderers], ['retained'], 'every frame is the 2D one');
  assert.deepEqual(errors, [], 'and nothing failed to get there');
});

test('elsewhere the same graph asks for a GL surface', async () => {
  // The control: this server has no GLX, so the surface is attempted and
  // fails — which it would not be, under the rule above.
  const { glareas, errors } = await run(false);
  assert.ok(
    glareas > 0 || errors.length > 0,
    `a GL surface was attempted (glareas ${glareas}, errors ${JSON.stringify(errors)})`,
  );
});

test('on XQuartz, a body type no node uses does not cost the graph its GL surface', async () => {
  // The registry is an app's whole vocabulary: the stress example registers
  // its widget types for every scene, and its lattices of plain cards drew
  // in 2D on XQuartz — a node dragged at 20 fps where GL drags it at 75.
  const { renderers, glareas, errors } = await run(true, null);
  assert.ok(
    glareas > 0 || errors.length > 0,
    `a GL surface was attempted (glareas ${glareas}, errors ${JSON.stringify(errors)}, frames ${[...renderers]})`,
  );
});
