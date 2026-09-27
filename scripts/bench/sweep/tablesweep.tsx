// One cell of the table sweep on whichever backend REACT_X11_BACKEND names:
// the example's 100,000-row log table — variable-height rows (the message
// wraps), multi-select, sorted by source — scrolled four ways. Prints one
// JSON line; frames are the window's own flushes that painted.
//   ACTION wheel  a wheel at the table, 60 notches a second, down
//          fling  a trackpad-sized burst: 10 notches an event, 60 a second
//          thumb  the scrollbar thumb dragged the whole track and back
//          jump   scrollToRow to a random row every 100 ms (a search)
import { fileURLToPath } from 'node:url';
import React from 'react';
import { createRoot, Icon } from 'react-x11';
import { WindowNode } from 'react-x11/node';
import { startTrace } from 'react-x11/debug';
process.env.REACT_X11_NO_AUTORUN = '1';
// The tree under test: this checkout by default, or another one's root
// when the probe is copied into that tree's node_modules/.bench (README).
const ROOT =
  process.env.BENCH_ROOT ??
  fileURLToPath(new URL('../../../', import.meta.url));
const ACTION = process.env.ACTION ?? 'wheel';
const { Table } = await import(`${ROOT}/src/table/index.js`);
const h = React.createElement;
const W = 1100,
  H = 720;

// the example's generator (examples/table.tsx `makeEntries`), verbatim
const SOURCES = ['renderer', 'compositor', 'dbus', 'net', 'fs'];
const PHRASES = [
  'frame flushed',
  'damage coalesced into one strip after the scroll settled',
  'selection ownership taken',
  'reconnecting after the peer closed the stream mid-reply, backing off',
  'cache warmed',
  'layout pass converged in two rounds after the viewport report arrived late',
];
function makeEntries(n: number, from = 0) {
  const entries: any[] = [];
  let seed = (0x5eed + from) & 0x7fffffff;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < n; i++) {
    const roll = rand();
    const id = from + i;
    entries.push({
      id,
      level: roll < 0.82 ? 'info' : roll < 0.95 ? 'warn' : 'error',
      source: SOURCES[Math.floor(rand() * SOURCES.length)],
      message: `${PHRASES[Math.floor(rand() * PHRASES.length)]} (#${id})`,
    });
  }
  return entries;
}
const LEVEL_COLOR: Record<string, string> = {
  info: '$textMuted',
  warn: '#e5a50a',
  error: '#e01b24',
};
const rows = makeEntries(100_000);
const columns = [
  {
    id: 'level',
    label: '',
    width: 28,
    sortable: false,
    render: (e: any) =>
      h(Icon, { name: 'dot', size: 8, color: LEVEL_COLOR[e.level] }),
  },
  { id: 'source', label: 'Source', width: 96 },
  {
    id: 'message',
    label: 'Message',
    render: (e: any, state: any) =>
      h('text', { style: { color: state.color } }, e.message),
  },
];

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
    if (run && painted) frames.push({ t: t0, ms: performance.now() - t0 });
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
      h(Table, {
        ref: handle,
        rows,
        columns,
        selectionMode: 'multiple',
        defaultSort: { column: 'source', direction: 'asc' },
        'aria-label': 'Log entries',
        ...(process.env.PREFETCH
          ? { prefetch: Number(process.env.PREFETCH) }
          : {}),
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
const table = find(windowNode, (n) => n.props?.role === 'table');
const body = table?.children?.[1];
if (!body) {
  console.log('RESULT ' + JSON.stringify({ failed: 'no table body' }));
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
const { execSync } = await import('node:child_process');
const server = !cocoa
  ? (() => {
      try {
        return execSync('pgrep -x X11.bin').toString().trim().split('\n')[0];
      } catch {
        return '';
      }
    })()
  : '';
const cpuOf = (pid: string) => {
  if (!pid) return NaN;
  const tt = execSync(`ps -o cputime= -p ${pid}`).toString().trim();
  const [m, sec] = tt.split(':');
  return Number(m) * 60 + Number(sec);
};
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
const samples: any[] = [];
const sampler =
  process.env.DIAG === '1'
    ? setInterval(() => {
        const content = body.children?.[0];
        const kids = content?.children ?? [];
        let skel = 0,
          full = 0,
          spacers = 0,
          firstFull = -1;
        kids.forEach((k: any, i: number) => {
          const nk = k.children?.length ?? 0;
          if (String(k.props?.['aria-rowindex'] ?? '') === '' && nk === 0)
            spacers++;
          else if (nk <= 1 && !k.props?.['aria-rowindex']) skel++;
          else {
            full++;
            if (firstFull < 0) firstFull = i;
          }
        });
        samples.push({
          t: Math.round(performance.now() - t0),
          kids: kids.length,
          full,
          other: kids.length - full,
          firstFull,
        });
      }, 250)
    : null;
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
if (ACTION === 'wheel') await every(16, () => wheel(1));
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
if (sampler) clearInterval(sampler);
if (process.env.DIAG === '1') console.log('SAMPLES ' + JSON.stringify(samples));
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
  suite: 'table',
  backend: cocoa ? 'cocoa' : 'x11',
  scene: 'logs-100k',
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
  scrolledRows: Math.round(body.scrollY / s / 24),
};
console.log('RESULT ' + JSON.stringify(out));
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
