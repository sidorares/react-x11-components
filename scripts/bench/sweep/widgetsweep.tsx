// One cell of the widget sweep on whichever backend REACT_X11_BACKEND names:
// the components the other probes leave out, each driven the way it is used.
// Prints one JSON line; frames are the window's own flushes that painted.
//   COMP term     <Terminal backend="vt"> over a pty that spawns nothing
//        ACTION flood   a program printing coloured lines as fast as it can
//               type    one character echoed every 16 ms, as a shell does
//               scroll  10,000 lines of scrollback, wheeled up through
//   COMP color    <ColorPicker> with its alpha strip
//        ACTION drag    the saturation field dragged round in a circle
//   COMP formula  150 display formulas in a scroll pane
//        ACTION mount   rendered: time to the first painted frame and to idle
//               scroll  wheeled down through them
//   COMP code     <Code>, 3,000 lines of TypeScript with line numbers
//        ACTION mount, scroll  as for formula
//   COMP mermaid  <Mermaid>, compiled by ondine (an optional peer)
//        ACTION mount   30 diagrams of five kinds in a scroll pane
//               scroll  wheeled down through them
//               stream  a 120-node flowchart appended a line every 30 ms,
//                       `partial` while it comes, as a model writes one
//        BIG=1  that flowchart, whole, in place of the 30 diagrams
//   ACTION resize  any of them: the window narrowed 8 px a frame for 40
//                  frames and widened back, each step's frame waited for —
//                  `lat` is from the render to that frame's end. Mermaid's
//                  window starts at 700 px, where most of its diagrams are
//                  wider than the column and shrink with it at every step
import { fileURLToPath } from 'node:url';
import React from 'react';
import { createRoot } from 'react-x11';
import { WindowNode } from 'react-x11/node';
process.env.REACT_X11_NO_AUTORUN = '1';
// The tree under test: this checkout by default, or another one's root
// when the probe is copied into that tree's node_modules/.bench (README).
const ROOT =
  process.env.BENCH_ROOT ??
  fileURLToPath(new URL('../../../', import.meta.url));
const COMP = process.env.COMP ?? 'term';
const ACTION = process.env.ACTION ?? 'flood';
const h = React.createElement;
const W = COMP === 'mermaid' && ACTION === 'resize' ? 700 : 1000,
  H = 720;

const frames: { t: number; ms: number; end: number }[] = [];
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
    const end = performance.now();
    if (painted) frames.push({ t: t0, ms: end - t0, end });
    return painted;
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = async (gap: number, max: number) => {
  const start = performance.now();
  for (;;) {
    await wait(50);
    const last = frames.length ? frames[frames.length - 1].end : start;
    if (performance.now() - last > gap || performance.now() - start > max)
      return;
  }
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const q = (xs: number[], p: number) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
};
const find = (n: any, pred: (n: any) => boolean): any => {
  if (!n) return null;
  if (pred(n)) return n;
  for (const c of n.children ?? []) {
    const f = find(c, pred);
    if (f) return f;
  }
  return null;
};

// --- what each component renders ------------------------------------------

const ESC = '\x1b[';
/** A line as `ls --color` and a test runner print them: a few SGR runs. */
const termLine = (i: number) =>
  `${ESC}32m✔${ESC}0m ${ESC}1m${String(i).padStart(6)}${ESC}0m ` +
  `${ESC}36msrc/component-${i % 97}/index.ts${ESC}0m ` +
  `${ESC}2m(${(i * 7) % 1000} ms)${ESC}0m ` +
  `${ESC}33mwarn${ESC}0m layout pass converged after the viewport report\r\n`;

let host: any = null;
let scene: any;
if (COMP === 'term') {
  const { Terminal } = await import(`${ROOT}/src/terminal/index.js`);
  const { FakePtyHost } = await import(`${ROOT}/test/fake-pty.js`);
  host = new FakePtyHost();
  scene = h(Terminal, {
    backend: 'vt',
    pty: host,
    command: ['bench'],
    scrollback: 10_000,
    fontSize: 13,
    style: { flexGrow: 1 },
  });
} else if (COMP === 'color') {
  const { ColorPicker } = await import(`${ROOT}/src/color-picker/index.js`);
  // controlled, as an app that shows the colour elsewhere holds it
  const Picker = () => {
    const [value, setValue] = React.useState('#3b82f6');
    return h(ColorPicker, {
      value,
      alpha: true,
      onChange: (ev: any) => setValue(ev.target.value),
    });
  };
  scene = h(Picker);
} else if (COMP === 'formula') {
  const { Formula } = await import(`${ROOT}/src/formula/index.js`);
  const sources = [
    String.raw`\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}`,
    String.raw`\sum_{k=1}^{n} k^2 = \frac{n(n+1)(2n+1)}{6}`,
    String.raw`\nabla \times \mathbf{B} = \mu_0 \mathbf{J} + \mu_0\varepsilon_0 \frac{\partial \mathbf{E}}{\partial t}`,
    String.raw`f(x) = \begin{cases} x^2 & x \ge 0 \\ -x & x < 0 \end{cases}`,
    String.raw`\det\begin{pmatrix} a & b \\ c & d \end{pmatrix} = ad - bc`,
  ];
  scene = h(
    'box',
    { style: { flexGrow: 1, overflow: 'scroll', padding: 12, gap: 8 } },
    ...Array.from({ length: 150 }, (_, i) =>
      h(Formula, { key: i, tex: sources[i % sources.length], display: true }),
    ),
  );
} else if (COMP === 'code') {
  const { Code } = await import(`${ROOT}/src/code/index.js`);
  const lines: string[] = [];
  for (let i = 0; lines.length < 3000; i++) {
    lines.push(
      `export function handler${i}(event: Event, ctx: Context<${i}>): Promise<void> {`,
      `  const value = ctx.store.get('key-${i}') ?? computeDefault(${i}, "fallback");`,
      `  if (value > ${i * 3}) return ctx.emit({ type: 'over', at: Date.now() }); // too high`,
      `  for (const item of ctx.items) await item.update(value * ${i % 13} + 0.5);`,
      `}`,
      ``,
    );
  }
  scene = h(
    'box',
    { style: { flexGrow: 1, overflow: 'scroll', padding: 12 } },
    h(Code, { source: lines.join('\n'), lang: 'ts', lineNumbers: true }),
  );
} else if (COMP === 'mermaid') {
  const { Mermaid } = await import(`${ROOT}/src/mermaid/index.js`);
  if (process.env.DIAG === '1') {
    // how often the labels are placed again, and set again, and at what
    // scales the diagrams are drawn
    const { MermaidNode } = await import(`${ROOT}/src/mermaid/node.js`);
    const proto = MermaidNode.prototype as any;
    const place = proto._place;
    const mini = proto._mini;
    const diag = ((globalThis as any).__mermaidDiag = {
      places: 0,
      laid: 0,
      ks: new Set<string>(),
    });
    proto._place = function (this: any) {
      const was = this._placement;
      const r = place.call(this);
      if (r && r !== was) {
        diag.places++;
        diag.ks.add(r.k.toFixed(3));
      }
      return r;
    };
    proto._mini = function (this: any, run: any, size: number) {
      const key = `${run.family}|${run.weight}|${size}|${run.fill}|${run.text}`;
      if (!this._minis.has(key)) diag.laid++;
      return mini.call(this, run, size);
    };
  }
  const kinds = [
    `flowchart LR
  A[Request] --> B{Cached?}
  B -->|yes| C[Serve]
  B -->|no| D[(Database)]
  D --> C
  C --> E([docs])`,
    `sequenceDiagram
  participant App
  participant Server
  App->>Server: GET /tiles/14/8/5
  alt cached
    Server-->>App: 304
  else fresh
    Server-->>App: 200 + body
  end`,
    `classDiagram
  Node <|-- MermaidNode
  Node : +abs Rect
  Node : +paint(ctx)
  class MermaidNode{
    +scene MermaidScene
    +textContent() string
  }`,
    `pie title Where a frame goes
  "layout" : 21
  "paint" : 58
  "compile" : 3`,
    `gitGraph
  commit
  branch feature
  checkout feature
  commit
  commit
  checkout main
  merge feature
  commit`,
  ];
  if (ACTION === 'stream' || process.env.BIG === '1') {
    // the whole chart's lines, handed over a line at a time once mounted
    const lines = ['flowchart TD'];
    for (let i = 1; i < 120; i++) {
      const parent = Math.floor((i - 1) / 2);
      lines.push(`  n${parent}[Step ${parent}] --> n${i}[Step ${i}]`);
    }
    const Stream = () => {
      // whole from the start where it is not streamed (`BIG=1`)
      const [count, setCount] = React.useState(
        ACTION === 'stream' ? 1 : lines.length,
      );
      React.useEffect(() => {
        (globalThis as any).__mermaidStream = () =>
          setCount((c) => Math.min(lines.length, c + 1));
      }, []);
      return h(Mermaid, {
        source: lines.slice(0, count).join('\n'),
        partial: count < lines.length,
      });
    };
    scene = h(
      'box',
      { style: { flexGrow: 1, overflow: 'scroll', padding: 12 } },
      h(Stream),
    );
  } else {
    scene = h(
      'box',
      { style: { flexGrow: 1, overflow: 'scroll', padding: 12, gap: 16 } },
      ...Array.from({ length: 30 }, (_, i) =>
        h(Mermaid, { key: i, source: kinds[i % kinds.length] }),
      ),
    );
  }
} else {
  console.log('RESULT ' + JSON.stringify({ failed: `no COMP ${COMP}` }));
  process.exit(0);
}

const wref: { current: any } = { current: null };
const root = await createRoot({ glPolicy: 'auto' });
const tMount = performance.now();
const cm = process.cpuUsage();
const view = (width: number) =>
  h(
    'window',
    { ref: wref, width, height: H, x: 20, y: 40, title: 'widgetsweep' },
    h('box', { style: { flexGrow: 1, padding: 8 } }, scene),
  );
root.render(view(W));
await quiet(1000, 30_000);
const mountCpu = process.cpuUsage(cm);
const mountFrames = frames.filter((f) => f.t >= tMount);
const mount = {
  firstPaint: r2(mountFrames.length ? mountFrames[0].end - tMount : NaN),
  idle: r2(
    mountFrames.length ? mountFrames[mountFrames.length - 1].end - tMount : NaN,
  ),
  mountCpu: Math.round((mountCpu.user + mountCpu.system) / 1000),
};
const wnd = wref.current;
const cocoa = typeof wnd.app?._route === 'function';
const s = wnd.scale ?? 1;
if (ACTION === 'mount') {
  console.log(
    'RESULT ' +
      JSON.stringify({
        suite: 'widgets',
        comp: COMP,
        action: ACTION,
        backend: cocoa ? 'cocoa' : 'x11',
        ...mount,
      }),
  );
  process.exit(0);
}

// --- input -----------------------------------------------------------------

const tm = () => Date.now() & 0x7fffffff;
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
const wheelAt = (x: number, y: number, notches: number) =>
  cocoa
    ? wnd.app._route({
        type: 'wheel',
        handle: wnd._key,
        x,
        y,
        gx: x,
        gy: y,
        dx: 0,
        dy: -notches,
        precise: false,
        time: tm(),
      })
    : wnd.emit('wheel', {
        name: 'wheel',
        x: Math.round(x * s),
        y: Math.round(y * s),
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
const centre = (n: any) => ({
  x: (n.abs.x + n.abs.width / 2) / s,
  y: (n.abs.y + n.abs.height / 2) / s,
});

let session: any = null;
if (COMP === 'term') {
  session = host.opened[0]?.session;
  if (!session) {
    console.log('RESULT ' + JSON.stringify({ failed: 'no pty session' }));
    process.exit(0);
  }
  if (ACTION === 'scroll') {
    let text = '';
    for (let i = 0; i < 10_000; i++) text += termLine(i);
    session.feed(text);
    await quiet(500, 30_000);
  }
}

const { serverPid, cpuSeconds } = await import('./xserver.js');
const server = !cocoa ? serverPid() : '';
const x0 = cpuSeconds(server);
const c0 = process.cpuUsage();
const DUR = 4000;
const n0 = frames.length;
const t0 = performance.now();
/** Each resize step's wait, from the render to the end of the frame that
 *  painted after it. */
const lats: number[] = [];
let narrowest = Infinity;
const nextFrame = async (max: number): Promise<boolean> => {
  const had = frames.length;
  const start = performance.now();
  while (frames.length === had) {
    if (performance.now() - start > max) return false;
    await new Promise((r) => setImmediate(r));
  }
  return true;
};
let steps = 0;
let fed = 0;
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

if (COMP === 'term' && ACTION === 'flood') {
  let i = 0;
  await every(4, () => {
    let chunk = '';
    for (let k = 0; k < 40; k++) chunk += termLine(i++);
    fed += chunk.length;
    session.feed(chunk);
  });
} else if (COMP === 'term' && ACTION === 'type') {
  let i = 0;
  await every(16, () => {
    const ch = i % 60 === 59 ? '\r\n$ ' : 'abcdefghij'[i % 10];
    i++;
    fed += ch.length;
    session.feed(ch);
  });
} else if (ACTION === 'scroll') {
  const pane =
    COMP === 'term'
      ? find(windowNode, (n) => n.kind === 'vtterm')
      : find(windowNode, (n) => n.style?.overflow === 'scroll');
  if (!pane) {
    console.log('RESULT ' + JSON.stringify({ failed: 'no scroll pane' }));
    process.exit(0);
  }
  const at = centre(pane);
  // up through a terminal's scrollback, down through a document — and back
  // up where a document's pane stops moving: 150 formulas or 30 diagrams
  // are a second of this wheel, and the rest of the run would scroll
  // nothing (the terminal's grid keeps its offset to itself, and 10,000
  // lines outlast the run)
  let dir = COMP === 'term' ? -1 : 1;
  let last = Number.NaN;
  await every(16, () => {
    if (COMP !== 'term') {
      if (pane.scrollY === last) dir = -dir;
      last = pane.scrollY;
    }
    wheelAt(at.x, at.y, 3 * dir);
  });
} else if (ACTION === 'resize') {
  const widths: number[] = [];
  for (let i = 1; i <= 40; i += 1) widths.push(W - i * 8);
  for (let i = 39; i >= 0; i -= 1) widths.push(W - i * 8);
  for (const width of widths) {
    const at = performance.now();
    root.render(view(width));
    if (await nextFrame(1000)) lats.push(frames[frames.length - 1].end - at);
    // what the window came to, which says the resize reached it
    narrowest = Math.min(narrowest, windowNode.abs.width / s);
    steps++;
  }
} else if (COMP === 'mermaid' && ACTION === 'stream') {
  const next = (globalThis as any).__mermaidStream;
  if (!next) {
    console.log('RESULT ' + JSON.stringify({ failed: 'no stream' }));
    process.exit(0);
  }
  await every(30, () => next());
} else if (COMP === 'color' && ACTION === 'drag') {
  const area = find(
    windowNode,
    (n) => n.props?.['aria-label'] === 'Saturation and brightness',
  );
  if (!area) {
    console.log('RESULT ' + JSON.stringify({ failed: 'no colour field' }));
    process.exit(0);
  }
  const c = centre(area);
  const rx = area.abs.width / s / 2.5,
    ry = area.abs.height / s / 2.5;
  emit('mousemove', c.x + rx, c.y, { buttons: 0 });
  await wait(30);
  emit('mousedown', c.x + rx, c.y, { keycode: 1, buttons: 0 });
  await every(8, (u) => {
    const a = u * Math.PI * 6;
    emit('mousemove', c.x + rx * Math.cos(a), c.y + ry * Math.sin(a));
  });
  emit('mouseup', c.x + rx, c.y, { keycode: 1 });
}
await quiet(300, 5000);
const dt = (performance.now() - t0) / 1000;
const cu = process.cpuUsage(c0);
const x1 = cpuSeconds(server);
const run = frames.slice(n0);
const iv = run.slice(1).map((f, i) => f.t - run[i].t);
console.log(
  'RESULT ' +
    JSON.stringify({
      suite: 'widgets',
      comp: COMP,
      action: ACTION,
      backend: cocoa ? 'cocoa' : 'x11',
      fps: r2(run.length / dt),
      p50: r2(q(iv, 0.5)),
      p95: r2(q(iv, 0.95)),
      frame50: r2(
        q(
          run.map((f) => f.ms),
          0.5,
        ),
      ),
      frame95: r2(
        q(
          run.map((f) => f.ms),
          0.95,
        ),
      ),
      cpu: Math.round((cu.user + cu.system) / 1e4 / dt),
      xcpu: server ? Math.round(((x1 - x0) / dt) * 100) : null,
      steps: Math.round(steps / dt),
      ...(fed ? { kbPerSecond: Math.round(fed / 1024 / dt) } : null),
      ...((globalThis as any).__mermaidDiag
        ? {
            places: (globalThis as any).__mermaidDiag.places,
            laid: (globalThis as any).__mermaidDiag.laid,
            scales: (globalThis as any).__mermaidDiag.ks.size,
          }
        : null),
      ...(lats.length
        ? {
            lat50: r2(q(lats, 0.5)),
            lat95: r2(q(lats, 0.95)),
            latMax: r2(Math.max(...lats)),
            missed: 80 - lats.length,
            narrowest: Math.round(narrowest),
          }
        : null),
      ...mount,
    }),
);
process.exit(0);
