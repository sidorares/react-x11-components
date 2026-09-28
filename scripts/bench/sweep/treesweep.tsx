// One cell of a tree sweep: the tree example's --stress data (100,000 rows,
// fifty to a branch, all expanded, every seventh name long enough to wrap),
// driven four ways. Prints one JSON line; frames are the window's flushes
// that painted.
//   ACTION wheel  a wheel at the tree, 60 notches a second, down
//          fling  10 notches an event, 60 a second
//          thumb  the scrollbar thumb dragged the whole track and back
//          keys   ArrowDown every 16 ms (the cursor walking, the view following)
//   ROWS     rows to generate (default 100,000)
//   FRAMES=1 each painted frame's scroll offset and where the selection
//            sits in it (in, above, below the viewport), the first 40
import { fileURLToPath } from 'node:url';
import React from 'react';
import { createRoot } from 'react-x11';
import { WindowNode } from 'react-x11/node';
import { startTrace } from 'react-x11/debug';
process.env.REACT_X11_NO_AUTORUN = '1';
const ROOT =
  process.env.BENCH_ROOT ??
  fileURLToPath(new URL('../../../', import.meta.url));
const ACTION = process.env.ACTION ?? 'wheel';
const { Tree } = await import(`${ROOT}/src/tree/index.js`);
const h = React.createElement;
const W = 1100,
  H = 720;
const TOTAL = Number(process.env.ROWS ?? 100_000);
function stressEntries(total: number) {
  const items: any[] = [];
  const expanded: string[] = [];
  let made = 0;
  for (let b = 0; made < total; b++) {
    const branchPath = `/stress/branch-${b}`;
    const children: any[] = [];
    for (let i = 0; i < 50 && made < total; i++, made++) {
      children.push({
        id: `${branchPath}/leaf-${i}`,
        label:
          i % 7 === 0
            ? `leaf ${i} of branch ${b}, with a name long enough to wrap once the pane gets narrow`
            : `leaf ${i} of branch ${b}`,
      });
    }
    made++;
    items.push({ id: branchPath, label: `branch ${b}`, children });
    expanded.push(branchPath);
  }
  return { items, expanded };
}
const data = stressEntries(TOTAL);
const mount0 = performance.now();
let firstPaint = -1;
const frames: { t: number; ms: number }[] = [];
let run = false;
let windowNode: any = null;
{
  const inner = (WindowNode as any).prototype._flushFrame;
  (WindowNode as any).prototype._flushFrame = function (
    this: any,
    ...a: any[]
  ) {
    windowNode = this;
    const t0 = performance.now();
    const painted = inner.apply(this, a);
    if (painted && firstPaint < 0) firstPaint = performance.now() - mount0;
    if (run && painted) {
      frames.push({ t: t0, ms: performance.now() - t0 });
      if (process.env.FRAMES === '1' && (globalThis as any).__probe)
        (globalThis as any).__probe();
    }
    return painted;
  };
}
const why: Record<string, number> = {};
if (process.env.DIAG === '1') {
  const floors = await import(
    `${ROOT}/node_modules/react-x11/src/nodes/window/floors.js`
  );
  const inner = (WindowNode as any).prototype._floorsScope;
  const path = (n: any) => {
    const out: string[] = [];
    for (let m = n; m && !m.isWindow; m = m.parent)
      out.push(
        m.kind +
          (m.style?.position === 'absolute' ? '@abs' : '') +
          (m.style?.overflow ? ':' + m.style.overflow : ''),
      );
    return out.slice(0, 7).join('<');
  };
  (WindowNode as any).prototype._floorsScope = function (this: any) {
    const r = inner.call(this);
    if (!run) return r;
    let k = 'scoped';
    if (r === null) {
      const src = this._floorsSources;
      if (this._floorsUnscoped) k = 'unscoped-flag';
      else if (src.size === 0) k = 'no-sources';
      else if (!this._floorsSwept) k = 'not-swept';
      else if (this._layoutHosts.size) k = 'layout-hosts';
      else if (this._containerQueryNodes.size) k = 'container-queries';
      else if (
        this._floorsWidth !== (this.window?.width ?? this._requestedSize?.width)
      )
        k = 'width';
      else {
        k = 'other(dirtyOutside/props)';
        for (const source of src) {
          if (source.destroyed || source.root !== this) continue;
          if (floors.floorBoundaryOf(source, this) === null) {
            k = 'no-boundary: ' + path(source);
            break;
          }
        }
      }
    }
    why[k] = (why[k] ?? 0) + 1;
    return r;
  };
}
const handle: { current: any } = { current: null };
const wref: { current: any } = { current: null };
const root = await createRoot({ glPolicy: 'auto' });
// the table takes the window, as the example's right pane does most of it
root.render(
  h(
    'window',
    { ref: wref, width: W, height: H, x: 20, y: 40, title: 'tablesweep' },
    h(
      'box',
      { style: { flexGrow: 1, padding: 8 } },
      h(Tree, {
        ref: handle,
        items: data.items,
        defaultExpanded: data.expanded,
        defaultSelected: data.items[0].id,
        'aria-label': 'Stress tree',
        style: { flexGrow: 1, minHeight: 0 },
      }),
    ),
  ),
);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
await wait(3000);
const wnd = wref.current;
const cocoa = typeof wnd.app?._route === 'function';
const s = wnd.scale ?? 1;
const tm = () => Date.now() & 0x7fffffff;
const find = (n: any, pred: (n: any) => boolean): any => {
  if (!n) return null;
  if (pred(n)) return n;
  for (const c of n.children ?? []) {
    const f = find(c, pred);
    if (f) return f;
  }
  return null;
};
const body = find(windowNode, (n) => n.props?.role === 'tree');
if (!body) {
  console.log('RESULT ' + JSON.stringify({ failed: 'no tree' }));
  process.exit(0);
}
const b = body.abs;
const cx = (b.x + b.width / 2) / s,
  cy = (b.y + b.height / 2) / s;
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
        time: tm(),
      })
    : wnd.emit(type, {
        x: Math.round(x * s),
        y: Math.round(y * s),
        rootx: 0,
        rooty: 0,
        buttons: 256,
        time: tm(),
        ...extra,
      });
const wheel = (notches: number) =>
  cocoa
    ? wnd.app._route({
        type: 'wheel',
        handle: wnd._key,
        x: cx,
        y: cy,
        gx: cx,
        gy: cy,
        dx: 0,
        dy: -notches,
        precise: false,
        time: tm(),
      })
    : wnd.emit('wheel', {
        name: 'wheel',
        x: Math.round(cx * s),
        y: Math.round(cy * s),
        rootx: 0,
        rooty: 0,
        buttons: 0,
        deltaX: 0,
        deltaY: notches,
        deltaMode: 'line',
        smooth: false,
        source: 'button',
        time: tm(),
      });
const { serverPid, cpuSeconds } = await import('./xserver.js');
const server = !cocoa ? serverPid() : '';
const cpuOf = cpuSeconds;
emit('mousemove', cx, cy, { buttons: 0 });
await wait(100);
const x0 = cpuOf(server);
const c0 = process.cpuUsage();
const trace = !cocoa ? startTrace({ sink: 'summary' }) : null;
const lp0 = windowNode._layoutPasses ?? 0,
  fm0 = windowNode._floorsMeasured ?? 0,
  sp0 = windowNode._scopedFloorPasses ?? 0;
const DUR = 4000;
const t0 = performance.now();
run = true;
let steps = 0;
const every = (ms: number, fn: (u: number) => void) =>
  new Promise<void>((done) => {
    const timer = setInterval(() => {
      const u = (performance.now() - t0) / DUR;
      if (u >= 1) {
        clearInterval(timer);
        done();
        return;
      }
      fn(u);
      steps++;
    }, ms);
  });
const XK_DOWN = 0xff54;
const downCode = (() => {
  const map = wnd.app?.X?.keycode2keysyms ?? {};
  for (const [code, syms] of Object.entries(map))
    if ((syms as any[])?.[0] === XK_DOWN) return Number(code);
  return 116;
})();
const log: string[] = [];
(globalThis as any).__probe = () => {
  const sel = find(body, (n) => n.props?.['aria-selected'] === true);
  const top = body.abs.y,
    bottom = body.abs.y + body.abs.height;
  const where = !sel
    ? 'none'
    : sel.abs.y < top
      ? 'above'
      : sel.abs.y + sel.abs.height > bottom
        ? 'below'
        : 'in';
  if (log.length < 40) log.push(`${Math.round(body.scrollY)}:${where}`);
};
if (ACTION === 'keys') {
  emit('mousedown', cx, cy, { keycode: 1, buttons: 0 });
  emit('mouseup', cx, cy, { keycode: 1 });
  await wait(100);
}
if (ACTION === 'keys')
  await every(16, () =>
    wnd.emit('keydown', {
      keycode: downCode,
      keysym: XK_DOWN,
      buttons: 0,
      time: tm(),
    }),
  );
else if (ACTION === 'wheel') await every(16, () => wheel(1));
else if (ACTION === 'fling') await every(16, () => wheel(10));
else if (ACTION === 'jump') {
  let seed = 7;
  await every(100, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    handle.current.scrollToRow(seed % 100_000);
  });
} else if (ACTION === 'thumb') {
  const bar = body._scrollbars().find((x: any) => x.axis === 'y');
  const bw = 12 * (bar.scale ?? s);
  const tx = (bar.crossStart + bw / 2) / s;
  const ty = (bar.thumbStart + bar.thumbLength / 2) / s;
  const travel = bar.travel / s;
  emit('mousemove', tx, ty, { buttons: 0 });
  await wait(30);
  emit('mousedown', tx, ty, { keycode: 1, buttons: 0 });
  const ys: number[] = [];
  await every(8, (u) => {
    emit('mousemove', tx, ty + travel * Math.sin(Math.PI * u));
    if (ys.length < 12) ys.push(body.scrollY);
  });
  if (process.env.DIAG === '1')
    console.log('SCROLLY during thumb', JSON.stringify(ys));
  emit('mouseup', tx, ty, { keycode: 1 });
  if (process.env.DIAG === '1')
    console.log('SCROLLY after thumb', body.scrollY);
}
run = false;
const dt = (performance.now() - t0) / 1000;
const cu = process.cpuUsage(c0);
const x1 = cpuOf(server);
const wire = trace?.stop();
const q = (xs: number[], p: number) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const iv = frames.slice(1).map((f, i) => f.t - frames[i].t);
const n = frames.length;
const out = {
  suite: 'tree',
  backend: cocoa ? 'cocoa' : 'x11',
  scene: 'stress-' + TOTAL,
  firstPaint: Math.round(firstPaint),
  action: ACTION,
  asked: '2d',
  renderer: 'retained',
  fps: r2(n / dt),
  p50: r2(q(iv, 0.5)),
  p95: r2(q(iv, 0.95)),
  frame50: r2(
    q(
      frames.map((f) => f.ms),
      0.5,
    ),
  ),
  frame95: r2(
    q(
      frames.map((f) => f.ms),
      0.95,
    ),
  ),
  cpu: Math.round((cu.user + cu.system) / 1e4 / dt),
  xcpu: server ? Math.round(((x1 - x0) / dt) * 100) : null,
  req: wire && n ? Math.round(wire.requests / n) : null,
  kb: wire && n ? r2(wire.bytesOut / n / 1024) : null,
  steps: Math.round(steps / dt),
  scrolledRows: Math.round(body.scrollY / s / 22),
};
console.log('RESULT ' + JSON.stringify(out));
if (process.env.FRAMES === '1') console.log('FRAMES ' + log.join(' '));
if (process.env.DIAG === '1') {
  let nodes = 0,
    texts = 0,
    depth = 0;
  const walk = (n: any, d: number) => {
    if (n.yoga) nodes++;
    if (n._measureFn) texts++;
    depth = Math.max(depth, d);
    for (const c of n.children ?? []) walk(c, d + 1);
  };
  walk(windowNode, 0);
  const content = body.children?.[0];
  console.log(
    'TREE ' +
      JSON.stringify({
        nodes,
        texts,
        depth,
        bodyKids: body.children?.length,
        contentKids: content?.children?.length,
        passesPerFrame: r2((windowNode._layoutPasses - lp0) / n),
        measuredPerFrame: r2((windowNode._floorsMeasured - fm0) / n),
        scopedPasses: windowNode._scopedFloorPasses - sp0,
      }),
  );
}
if (process.env.DIAG === '1')
  console.log(
    'WHY ' +
      JSON.stringify(
        Object.entries(why)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12),
        null,
        1,
      ),
  );
process.exit(0);
