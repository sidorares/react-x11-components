// One cell of the flow-and-map comparison: MODE × ACTION, on whichever
// backend REACT_X11_BACKEND names (one with direct GL: `cocoa`, or X11 with
// DRI3). `examples/flow-map.tsx`'s graph — two cards that are live maps of
// London — in a 1100 × 720 window. Prints one JSON line.
//   MODE   gl-body  the maps drawn by `<Flow>`'s own surface, in its paint
//                   order (`FlowNodeType.glBody` + `GlMapLayer`)
//          glarea   each map a `<Map renderer="gl">` mounted through
//                   `render`: a second `<glarea>`, among the pane's
//                   surface's children — what an app writes without the seam
//   ACTION pan       the graph panned, a step a Flow frame (`setViewport`)
//          zoom      a wheel over the empty pane, 30 notches a second,
//                    turning back every 15 — a user's zoom of the graph
//          mapdrag   the pointer dragging inside the London map at 125 Hz
//          mapwheel  a wheel inside the London map, 30 notches a second
//   SHOT=path  a screenshot of the window after the warm-up (macOS);
//              PRESHOT=overlap drags one map card over the other first
// Tiles come from the maps sweep's disk cache (BENCH_TILES).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { createRoot } from 'react-x11';
process.env.REACT_X11_NO_AUTORUN = '1';
const ROOT =
  process.env.BENCH_ROOT ??
  fileURLToPath(new URL('../../../', import.meta.url));
const { FlowMapApp } = await import(`${ROOT}/examples/flow-map.tsx`);
const MODE = process.env.MODE ?? 'gl-body';
const ACTION = process.env.ACTION ?? 'pan';
const W = 1100,
  H = 720,
  WX = 40,
  WY = 80;
const flowFrames: number[] = [];
const mapFrames: Record<string, number[]> = { london: [], westminster: [] };
const flowDraw: number[] = [];
let run = false;
const handle: { current: any } = { current: null };
const wref: { current: any } = { current: null };
let dx = 2;
const step = () => {
  const h = handle.current;
  const v = h?.getViewport();
  if (!v) return;
  if (v.x < home.x - 400 || v.x > home.x + 400) dx = -dx;
  h.setViewport({ x: v.x + dx });
};
let home = { x: 0, y: 0, zoom: 1 };
const root = await createRoot({ glPolicy: 'auto' });
root.render(
  React.createElement(
    'window',
    { ref: wref, width: W, height: H, x: WX, y: WY, title: 'flowmapsweep' },
    React.createElement(FlowMapApp, {
      mode: MODE,
      flowRef: handle,
      onFrame: (s: any) => {
        if (!run) return;
        flowFrames.push(performance.now());
        flowDraw.push(s.drawMs + s.sceneMs + s.packMs);
        if (ACTION === 'pan') setImmediate(step);
      },
      onMapFrame: (id: string) => {
        if (run) mapFrames[id]?.push(performance.now());
      },
    }),
  ),
);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
await wait(Number(process.env.BENCH_WARM ?? 7000));
const wnd = wref.current;
const cocoa = typeof wnd.app?._route === 'function';
home = handle.current.getViewport();
const s = wnd.scale ?? 1;
const t = () => Date.now() & 0x7fffffff;
const emit = (type: string, x: number, y: number, extra: any = {}) =>
  cocoa
    ? wnd.app._route({
        type,
        handle: wnd._key,
        x,
        y,
        gx: x,
        gy: y,
        button: extra.keycode ?? 0,
        time: t(),
      })
    : wnd.emit(type, {
        x: Math.round(x * s),
        y: Math.round(y * s),
        rootx: 0,
        rooty: 0,
        buttons: 256,
        time: t(),
        ...extra,
      });
const notch = (x: number, y: number, dir: number) =>
  cocoa
    ? wnd.app._route({
        type: 'wheel',
        handle: wnd._key,
        x,
        y,
        gx: x,
        gy: y,
        dx: 0,
        dy: -dir,
        precise: false,
        time: t(),
      })
    : wnd.emit('wheel', {
        name: 'wheel',
        x: Math.round(x * s),
        y: Math.round(y * s),
        rootx: 0,
        rooty: 0,
        buttons: 0,
        deltaX: 0,
        deltaY: dir,
        deltaMode: 'line',
        smooth: false,
        source: 'button',
        time: t(),
      });
// A point in the London map's body clear of its markers — a press on a pin
// is the pin's, and drags nothing — and a point of empty pane: window
// coordinates.
const flow = handle.current;
const inMap = flow.flowToScreenPosition({ x: 260 + 110, y: 26 + 190 });
const empty = flow.flowToScreenPosition({ x: 120, y: 200 });
if (process.env.PRESHOT === 'overlap') {
  // Westminster dragged up by its title bar until it covers the bottom of
  // London: a card over a map, and an edge across one, in the graph's order.
  const from = flow.flowToScreenPosition({ x: 300, y: 330 + 13 });
  emit('mousemove', from.x, from.y, { buttons: 0 });
  await wait(50);
  emit('mousedown', from.x, from.y, { keycode: 1, buttons: 0 });
  for (let i = 1; i <= 20; i++) {
    await wait(16);
    emit('mousemove', from.x + i * 6, from.y - i * 8);
  }
  emit('mouseup', from.x + 120, from.y - 160, { keycode: 1 });
  await wait(1500);
}
if (process.env.SHOT && process.platform === 'darwin') {
  // The window by its number, which the window server draws whole whatever
  // is over it; the region it was put at where there is none.
  const id = wnd.windowNumber;
  execFileSync('screencapture', [
    '-x',
    '-o',
    ...(typeof id === 'number' ? [`-l${id}`] : ['-R', `${WX},${WY},${W},${H}`]),
    process.env.SHOT,
  ]);
}
const c0 = process.cpuUsage();
const t0 = performance.now();
const DUR = 4000;
run = true;
let steps = 0;
if (ACTION === 'pan') {
  step();
  await wait(DUR);
} else if (ACTION === 'zoom' || ACTION === 'mapwheel') {
  const at = ACTION === 'zoom' ? empty : inMap;
  emit('mousemove', at.x, at.y, { buttons: 0 });
  let dir = 1;
  await new Promise<void>((done) => {
    const timer = setInterval(() => {
      notch(at.x, at.y, dir);
      steps++;
      if (steps % 15 === 0) dir = -dir;
      if (performance.now() - t0 > DUR) {
        clearInterval(timer);
        done();
      }
    }, 33);
  });
} else if (ACTION === 'mapdrag') {
  emit('mousemove', inMap.x, inMap.y, { buttons: 0 });
  await wait(50);
  emit('mousedown', inMap.x, inMap.y, { keycode: 1, buttons: 0 });
  await wait(30);
  let x = inMap.x,
    dir = -1;
  await new Promise<void>((done) => {
    const timer = setInterval(() => {
      x += 2 * dir;
      steps++;
      if (Math.abs(x - inMap.x) > 120) dir = -dir;
      emit('mousemove', x, inMap.y + (steps % 40) / 4);
      if (performance.now() - t0 > DUR) {
        clearInterval(timer);
        done();
      }
    }, 8);
  });
  emit('mouseup', x, inMap.y, { keycode: 1 });
}
run = false;
const dt = (performance.now() - t0) / 1000;
const cu = process.cpuUsage(c0);
const q = (xs: number[], p: number) => {
  const v = [...xs].filter((x) => !isNaN(x)).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const gaps = (at: number[]) => at.slice(1).map((v, i) => v - at[i]);
const london = mapFrames.london;
const shown = ACTION === 'pan' || ACTION === 'zoom' ? flowFrames : london;
const out = {
  suite: 'flowmap',
  backend: cocoa ? 'cocoa' : 'x11',
  mode: MODE,
  action: ACTION,
  // frames a second of what the action moves: the graph for a pan or a
  // zoom, the London map for a gesture inside it
  fps: r2(shown.length / dt),
  p50: r2(q(gaps(shown), 0.5)),
  p95: r2(q(gaps(shown), 0.95)),
  flowFps: r2(flowFrames.length / dt),
  mapFps: r2(london.length / dt),
  otherMapFps: r2(mapFrames.westminster.length / dt),
  flowMs50: r2(q(flowDraw, 0.5)),
  cpu: Math.round((cu.user + cu.system) / 1e4 / dt),
  steps: Math.round(steps / dt),
  zoom: r2(handle.current.getViewport().zoom),
};
console.log('RESULT ' + JSON.stringify(out));
process.exit(0);
