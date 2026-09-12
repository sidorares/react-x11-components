// `<Map>`'s handle and events, once for each renderer.
//
// Both renderers answer to one controller (`src/maps/controller.ts`), so the
// camera, the gestures, the marker hit test and the handle mean the same
// thing whichever of them is drawing. Every test here runs against the
// retained renderer and against the GL one. The GL renderer draws nothing in
// the harness unless a test hands its surface a frame — the server has no
// GLX — and almost none of this needs it to: input reaches the pane the
// surface sits in, and the handle is the controller's.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  act,
  cleanup,
  fireEvent,
  renderX11,
  userEvent,
  waitFor,
} from 'react-x11/test';
import type { RenderX11Options } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import { Map as MapView } from '../src/maps/index.js';
import type {
  MapHandle,
  MapMarker,
  MapRenderer,
  MapSource,
} from '../src/maps/index.js';
import { loadGlRenderer } from '../src/maps/renderer.js';

test.afterEach(async () => {
  await cleanup();
});

const LONDON = { lon: -0.1281, lat: 51.508 };
const TOKYO = { lon: 139.7004, lat: 35.69 };
const RENDERERS: readonly MapRenderer[] = ['retained', 'gl'];

type MapProps = Partial<React.ComponentProps<typeof MapView>>;

const kindOf = (node: unknown): string => (node as { kind: string }).kind;

/**
 * Enough of a WebGL-shaped context for a GL frame to run: every call
 * answers, every program links, and the stencil probe finds a stencil.
 */
function stubGl(): unknown {
  let next = 1;
  const constants = new Map<string, number>();
  const target: Record<string, unknown> = {
    backend: 'direct',
    getParameter: () => 0,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => next++,
    readPixels: (...args: unknown[]) => {
      (args[6] as Uint8Array).set([255, 0, 255, 255], 4);
    },
  };
  return new Proxy(target, {
    get(obj, name: string) {
      if (name in obj) return obj[name];
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
        if (!constants.has(name)) constants.set(name, 0x1000 + constants.size);
        return constants.get(name);
      }
      return (...args: unknown[]) =>
        name.startsWith('create') ? next++ : args.length ? undefined : 0;
    },
  });
}

/**
 * A map on one renderer. Mounted into a window that is already up, so the
 * GL surface can be told to wait — the harness's server has no GLX, and a
 * surface that failed would take every frame a test hands it with it.
 */
async function mountMap(
  renderer: MapRenderer,
  props: MapProps = {},
  { driven = false, scale = 1, a11y = false } = {},
) {
  if (renderer === 'gl') await loadGlRenderer();
  const options: RenderX11Options = {
    // Input goes through a real X server, so grabs, focus and crossings
    // happen for real; a `<glarea>` is a window, so GL is always there.
    backend: driven || renderer === 'gl' ? 'xserver' : 'mock',
    width: 640,
    height: 480,
    scale,
    a11y,
  };
  const result = await renderX11(React.createElement('box'), options);
  Object.defineProperty(result.app, 'chooseGLConfig', {
    value: () => new Promise(() => {}),
    configurable: true,
  });
  const ref = React.createRef<MapHandle>();
  const render = (extra: MapProps) =>
    React.createElement(MapView, {
      ref,
      renderer,
      defaultCamera: { center: LONDON, zoom: 12 },
      'data-testname': 'map',
      ...props,
      ...extra,
    });
  await result.rerender(render({}));
  const node = result.getByTestName('map');
  assert.strictEqual(kindOf(node), renderer === 'gl' ? 'mapglpane' : 'mapview');
  /** A GL frame, drawn on a stand-in context; the retained renderer draws
   *  its own. */
  const frame = async (): Promise<void> => {
    const pane = node as unknown as {
      abs: { width: number; height: number };
      children: { kind: string; props: Record<string, unknown> }[];
    };
    const area = pane.children?.find((child) => child.kind === 'glarea');
    await act(async () => {
      (
        area?.props.onDraw as ((gl: unknown, info: object) => void) | undefined
      )?.(stubGl(), {
        width: pane.abs.width,
        height: pane.abs.height,
        node: area,
      });
    });
  };
  return {
    handle: ref.current as MapHandle,
    node,
    frame,
    rerender: (next: MapProps) => result.rerender(render(next)),
  };
}

/** The pointer leaving the map. Called as core calls it: the in-process
 *  server delivers one motion per mount, so a move away produces no
 *  crossing here. */
function leave(node: DrawnNode): void {
  const target = node as unknown as {
    defaultMouseLeave?(): void;
    props?: { onMouseLeave?(): void };
  };
  if (target.defaultMouseLeave) target.defaultMouseLeave();
  else target.props?.onMouseLeave?.();
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 220));

for (const renderer of RENDERERS) {
  test(`${renderer}: the handle reports its camera, and projects around it`, async () => {
    const { handle } = await mountMap(renderer);
    const camera = handle.getCamera();
    assert.strictEqual(camera.zoom, 12);
    const centre = handle.project(camera.center);
    assert.ok(Math.abs(centre.x - 320) < 1, `x ${centre.x}`);
    assert.ok(Math.abs(centre.y - 240) < 1, `y ${centre.y}`);
    const back = handle.unproject(centre.x, centre.y);
    assert.ok(Math.abs(back.lat - LONDON.lat) < 1e-6);
    assert.ok(Math.abs(back.lon - LONDON.lon) < 1e-6);
  });

  test(`${renderer}: zoomIn is about the centre; zoom is clamped; a pan moves the camera against the pointer`, async () => {
    const { handle } = await mountMap(renderer, { minZoom: 4, maxZoom: 16 });
    const before = handle.unproject(320, 240);
    handle.zoomIn(1);
    const after = handle.unproject(320, 240);
    assert.ok(Math.abs(after.lat - before.lat) < 1e-9);
    assert.ok(Math.abs(after.lon - before.lon) < 1e-9);
    assert.strictEqual(handle.getCamera().zoom, 13);
    handle.zoomTo(20);
    assert.strictEqual(handle.getCamera().zoom, 16);
    handle.zoomTo(0);
    assert.strictEqual(handle.getCamera().zoom, 4);
    const lon = handle.getCamera().center.lon;
    handle.panBy(100, 0);
    assert.ok(
      handle.getCamera().center.lon > lon,
      'dragged left, it looks east',
    );
  });

  test(`${renderer}: fitMarkers and fitBounds frame what they are given`, async () => {
    const markers: MapMarker[] = [
      { id: 'a', position: { lon: -0.2, lat: 51.45 } },
      { id: 'b', position: { lon: 0.0, lat: 51.55 } },
    ];
    const { handle } = await mountMap(renderer, { markers });
    handle.fitMarkers();
    let bounds = handle.getBounds();
    assert.ok(bounds.west <= -0.2 && bounds.east >= 0.0);
    assert.ok(bounds.south <= 51.45 && bounds.north >= 51.55);
    handle.fitBounds({ west: 139.6, south: 35.6, east: 139.8, north: 35.8 });
    bounds = handle.getBounds();
    assert.ok(bounds.west <= TOKYO.lon && TOKYO.lon <= bounds.east);
    assert.ok(bounds.south <= TOKYO.lat && TOKYO.lat <= bounds.north);
  });

  test(`${renderer}: a wheel zooms about the pointer, and back out`, async () => {
    const { handle, node } = await mountMap(renderer, {}, { driven: true });
    const point = { x: 320 - 140, y: 240 + 90 };
    const before = handle.unproject(point.x, point.y);
    await userEvent.wheel(node, { dx: -140, dy: 90, deltaY: -4 });
    assert.ok(handle.getCamera().zoom > 12, 'it zoomed in');
    const after = handle.unproject(point.x, point.y);
    assert.ok(Math.abs(after.lat - before.lat) < 1e-6);
    assert.ok(Math.abs(after.lon - before.lon) < 1e-6);
    await userEvent.wheel(node, { deltaY: 12 });
    assert.ok(handle.getCamera().zoom < 12, 'and out');
  });

  test(`${renderer}: a drag pans the map with the pointer, and onMoveEnd follows once it settles`, async () => {
    const ends: number[] = [];
    const { handle, node } = await mountMap(
      renderer,
      { onMoveEnd: (camera) => ends.push(camera.zoom) },
      { driven: true },
    );
    const pressed = handle.unproject(320, 240);
    fireEvent.mouseDown(node);
    fireEvent.mouseMove(node, { dx: 20, dy: 10 });
    fireEvent.mouseMove(node, { dx: 60, dy: 35 });
    fireEvent.mouseUp(node, { dx: 60, dy: 35 });
    await act(async () => {});
    const now = handle.unproject(380, 275);
    assert.ok(
      Math.abs(now.lon - pressed.lon) < 1e-6,
      `${pressed.lon} -> ${now.lon}`,
    );
    assert.ok(
      Math.abs(now.lat - pressed.lat) < 1e-6,
      `${pressed.lat} -> ${now.lat}`,
    );
    await settle();
    assert.deepStrictEqual(ends, [12], 'one move, ended once');
  });

  test(`${renderer}: a click reports where it landed, and on which marker`, async () => {
    const clicks: { lat: number; lon: number; marker: string | null }[] = [];
    const markerClicks: string[] = [];
    const { node } = await mountMap(
      renderer,
      {
        markers: [{ id: 'home', position: LONDON }],
        onMapClick: (event) =>
          clicks.push({
            lat: event.lngLat.lat,
            lon: event.lngLat.lon,
            marker: event.marker?.id ?? null,
          }),
        onMarkerClick: (marker) => markerClicks.push(marker.id),
      },
      { driven: true },
    );
    await userEvent.click(node, { dy: -6 });
    assert.deepStrictEqual(markerClicks, ['home']);
    assert.strictEqual(clicks.length, 1);
    assert.strictEqual(clicks[0].marker, 'home');
    await userEvent.click(node, { dx: -200, dy: 150 });
    assert.strictEqual(markerClicks.length, 1, 'no second marker click');
    assert.strictEqual(clicks.length, 2);
    assert.strictEqual(clicks[1].marker, null);
    assert.ok(clicks[1].lat < clicks[0].lat && clicks[1].lon < clicks[0].lon);
  });

  test(`${renderer}: hovering a marker reports it, and leaving the map reports null`, async () => {
    const seen: (string | null)[] = [];
    const { node } = await mountMap(
      renderer,
      {
        markers: [{ id: 'home', position: LONDON }],
        onMarkerHover: (marker, event) =>
          seen.push(marker ? `${marker.id}${event ? '' : '?'}` : null),
      },
      { driven: true },
    );
    await userEvent.hover(node, { dy: -6 });
    await waitFor(() => assert.deepStrictEqual(seen, ['home']));
    leave(node);
    assert.deepStrictEqual(seen, ['home', null]);
  });

  test(`${renderer}: a double click zooms in about the point, and the keys pan and zoom`, async () => {
    const { handle, node } = await mountMap(renderer, {}, { driven: true });
    const point = { x: 320 + 30, y: 240 - 20 };
    const before = handle.unproject(point.x, point.y);
    fireEvent.doubleClick(node, { dx: 30, dy: -20 });
    await act(async () => {});
    assert.ok(Math.abs(handle.getCamera().zoom - 13) < 1e-9);
    const after = handle.unproject(point.x, point.y);
    assert.ok(Math.abs(after.lat - before.lat) < 1e-6);
    assert.ok(Math.abs(after.lon - before.lon) < 1e-6);
    // The press focused the map; the arrows and plus are its now.
    const lon = handle.getCamera().center.lon;
    await userEvent.key(0xff53); // Right
    assert.ok(handle.getCamera().center.lon > lon, 'Right looks east');
    await userEvent.key(0x002b); // plus
    assert.ok(Math.abs(handle.getCamera().zoom - 14) < 1e-9, 'plus zooms in');
  });

  test(`${renderer}: a controlled camera is the application’s, and a gesture only asks`, async () => {
    const asked: number[] = [];
    const { handle } = await mountMap(renderer, {
      camera: { center: LONDON, zoom: 12 },
      onCameraChange: (next) => asked.push(next.zoom),
    });
    handle.zoomIn(1);
    assert.deepStrictEqual(asked, [13], 'it asked');
    assert.strictEqual(handle.getCamera().zoom, 12, 'and did not move itself');
  });

  test(`${renderer}: interactive={false} freezes the camera and still reports clicks`, async () => {
    const clicks: number[] = [];
    const { handle, node } = await mountMap(
      renderer,
      { interactive: false, onMapClick: () => clicks.push(1) },
      { driven: true },
    );
    await userEvent.wheel(node, { deltaY: -3 });
    assert.strictEqual(handle.getCamera().zoom, 12, 'the wheel did nothing');
    await userEvent.click(node);
    assert.strictEqual(clicks.length, 1, 'the click still arrived');
  });

  test(`${renderer}: markers in view reach the accessibility scene as buttons`, async () => {
    const { node } = await mountMap(
      renderer,
      {
        markers: [
          { id: 'a', position: LONDON, title: 'Trafalgar Square' },
          { id: 'b', position: TOKYO },
          { id: 'c', position: { lon: -0.13, lat: 51.509 } },
        ],
      },
      { a11y: true },
    );
    const scene = (
      node as unknown as {
        a11yScene(): { id: string; role?: string; name?: string }[];
      }
    ).a11yScene();
    assert.deepStrictEqual(
      scene.map((item) => [item.id, item.role]),
      [
        ['marker:a', 'button'],
        ['marker:c', 'button'],
      ],
    );
    assert.strictEqual(scene[0].name, 'Trafalgar Square');
    assert.match(scene[1].name ?? '', /51\.5090, -0\.1300/);
  });

  test(`${renderer}: at scale 2 a click, a marker and a pan land where they do at 1`, async () => {
    const clicks: { lat: number; lon: number }[] = [];
    const hits: string[] = [];
    const distances: number[] = [];
    for (const scale of [1, 2]) {
      const { handle, node } = await mountMap(
        renderer,
        {
          markers: [{ id: 'home', position: LONDON }],
          onMapClick: (event) => {
            if (!event.marker) clicks.push(event.lngLat);
          },
          onMarkerClick: (marker) => hits.push(`${marker.id}@${scale}`),
        },
        { driven: true, scale },
      );
      // `dx`/`dy` are device pixels from the node's centre.
      await userEvent.click(node, { dx: -120 * scale, dy: 90 * scale });
      await userEvent.click(node, { dy: -6 * scale });
      const before = handle.getCamera().center.lon;
      handle.panBy(160, 0);
      distances.push(handle.getCamera().center.lon - before);
      await cleanup();
    }
    assert.strictEqual(clicks.length, 2);
    assert.ok(Math.abs(clicks[0].lat - clicks[1].lat) < 1e-9);
    assert.ok(Math.abs(clicks[0].lon - clicks[1].lon) < 1e-9);
    assert.deepStrictEqual(hits, ['home@1', 'home@2']);
    assert.ok(Math.abs(distances[0] - distances[1]) < 1e-12);
  });

  test(`${renderer}: a tile that fails reaches onTileError and the frame stats`, async () => {
    const seen: string[] = [];
    const source: MapSource = {
      id: 'bad',
      minZoom: 0,
      maxZoom: 14,
      tileSize: 512,
      load: () => {
        throw new Error('unauthorized');
      },
    };
    const { handle, frame } = await mountMap(renderer, {
      sources: [source],
      defaultCamera: { center: LONDON, zoom: 4 },
      onTileError: (error, tile) =>
        seen.push(
          `${tile.sourceId} ${tile.z}/${tile.x}/${tile.y} ${String(error)}`,
        ),
    });
    await frame();
    await act(async () => {});
    await frame();
    await waitFor(() => assert.ok(seen.length > 0, 'the failure was reported'));
    assert.match(seen[0], /bad 4\/\d+\/\d+ Error: unauthorized/);
    await frame();
    const stats = handle.stats();
    assert.ok(stats && stats.errors > 0, 'and counted in the frame stats');
    assert.strictEqual(stats.renderer, renderer);
  });
}
