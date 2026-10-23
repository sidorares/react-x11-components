// <Html> with its scripts on, doing what a page's scripts do to a document:
// each workload is a page whose own script changes its DOM a step at a
// time — rows of a table made, updated, swapped and cleared as
// js-framework-benchmark does them, a feed that grows, a list that churns,
// classes toggled, a layout property and a transform animated from a
// script, layout read straight after a write, text that ticks, a route
// swapped with innerHTML — and the time from each step's start to the end
// of the frame that shows it is what a user waits for.
//
//   WORKLOADS  which (default all): rows, feed, churn, toggle, width,
//              transform, thrash, text, route
//   W, H       the window (default 1280x800)
//   PROFILE    a directory: a CPU profile of each workload, for
//              cpuprofile.ts
//   BENCH_ROOT the tree under test (default this checkout's `dist/`)
//
//   NODE_ENV=production REACT_X11_BACKEND=x11 DISPLAY=:99 \
//     node --expose-gc --experimental-vm-modules \
//     scripts/bench/sweep/htmljs.mjs > js.jsonl
//
// A step is marked by the page: `console.log('OP <name>')` as it begins,
// and the step after waits two animation frames, so each is shown before
// the next begins. Each line is a workload: per kind of step its count,
// the median and the longest latency (`lat50`, `latMax`, the step's start
// to the end of the first frame that drew the document after it), the
// script's own time (`js50`), and for the whole workload the processor
// time, the collector's, what was allocated, the frames that ran past a
// 60 Hz frame, and the longest the event loop was held.
import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { GCProfiler } from 'node:v8';
import { fileURLToPath } from 'node:url';
import React from 'react';

process.env.REACT_X11_NO_AUTORUN = '1';
const { createRoot, ThemeProvider } = await import('react-x11');
const { WindowNode } = await import('react-x11/node');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = process.env.BENCH_ROOT ?? join(HERE, '../../../');
const { Html, HtmlViewNode } = await import(join(ROOT, 'dist/html/index.js'));

const h = React.createElement;
const W = Number(process.env.W ?? 1280);
const H = Number(process.env.H ?? 800);
const BACKEND = process.env.REACT_X11_BACKEND ?? 'x11';
const PROFILE = process.env.PROFILE ?? '';
const FRAME = 1000 / 60;

// --- the workloads -------------------------------------------------------------

/** The page's side: run each step, mark it, and wait for it to be shown. */
const HARNESS = `
const steps = [];
const step = (name, fn) => steps.push([name, fn]);
let at = 0;
function next() {
  if (at >= steps.length) { console.log('DONE'); return; }
  const [name, fn] = steps[at++];
  console.log('OP ' + name);
  const t = performance.now();
  fn();
  console.log('JS ' + name + ' ' + (performance.now() - t));
  requestAnimationFrame(() => requestAnimationFrame(next));
}
addEventListener('load', () => setTimeout(() => requestAnimationFrame(next), 50));
`;

/** js-framework-benchmark's table, in vanilla DOM calls. */
const ROWS = `
const A = ['pretty','large','big','small','tall','short','long','handsome','plain','quaint','clean','elegant','easy','angry','crazy','helpful','mushy','odd','unsightly','adorable','important','inexpensive','cheap','expensive','fancy'];
const C = ['red','yellow','blue','green','pink','brown','purple','brown','white','black','orange'];
const N = ['table','chair','house','bbq','desk','car','pony','cookie','sandwich','burger','pizza','mouse','keyboard'];
let seed = 1;
const rnd = (n) => { seed = (seed * 16807) % 2147483647; return seed % n; };
let id = 1;
const tbody = document.getElementById('tbody');
let selected = null;
function row() {
  const tr = document.createElement('tr');
  const td1 = document.createElement('td'); td1.className = 'col-md-1'; td1.textContent = String(id++);
  const td2 = document.createElement('td'); td2.className = 'col-md-4';
  const a = document.createElement('a'); a.className = 'lbl';
  a.textContent = A[rnd(A.length)] + ' ' + C[rnd(C.length)] + ' ' + N[rnd(N.length)];
  td2.appendChild(a);
  const td3 = document.createElement('td'); td3.className = 'col-md-1';
  const r = document.createElement('a'); r.className = 'remove';
  const s = document.createElement('span'); s.className = 'glyphicon glyphicon-remove'; s.setAttribute('aria-hidden', 'true');
  r.appendChild(s); td3.appendChild(r);
  const td4 = document.createElement('td'); td4.className = 'col-md-6';
  tr.append(td1, td2, td3, td4);
  return tr;
}
const create = (n) => { const f = document.createDocumentFragment(); for (let i = 0; i < n; i++) f.appendChild(row()); tbody.appendChild(f); };
const clear = () => { tbody.textContent = ''; selected = null; };
for (let k = 0; k < 3; k++) {
  step('create1k', () => { clear(); create(1000); });
  step('replace1k', () => { clear(); create(1000); });
  step('update10th', () => { const rows = tbody.children; for (let i = 0; i < rows.length; i += 10) rows[i].children[1].firstChild.textContent += ' !!!'; });
  step('select', () => { if (selected) selected.className = ''; selected = tbody.children[5 + k]; selected.className = 'danger'; });
  step('swap', () => { const rows = tbody.children; const a = rows[1], b = rows[998]; const after = b.nextSibling; tbody.insertBefore(b, a); tbody.insertBefore(a, after); });
  step('remove', () => { tbody.children[4].remove(); });
  step('append1k', () => create(1000));
  step('clear', clear);
}
step('create10k', () => { clear(); create(10000); });
step('clear10k', clear);
`;

const WORKLOADS = {
  rows: {
    style:
      'body{font:14px sans-serif;margin:8px}table{border-collapse:collapse;width:100%}' +
      'td{padding:4px 8px;border-top:1px solid #ddd}tr:nth-child(odd){background:#f9f9f9}' +
      'tr:hover{background:#f0f0f0}tr.danger{background:#f2dede}.lbl{color:#337ab7}' +
      '.col-md-1{width:8%}.col-md-4{width:33%}.col-md-6{width:50%}.glyphicon-remove::before{content:"x"}',
    body: '<table><tbody id="tbody"></tbody></table>',
    script: ROWS,
  },
  feed: {
    style:
      'body{font:14px sans-serif;margin:0}.card{display:flex;gap:12px;padding:12px;' +
      'border-bottom:1px solid #eee}.avatar{width:40px;height:40px;border-radius:20px;' +
      'background:#ccd}.who{font-weight:bold}.when{color:#888;font-size:12px}',
    body: '<main id="feed"></main>',
    script: `
const feed = document.getElementById('feed');
let n = 0;
for (let k = 0; k < 50; k++) step('append20', () => {
  const f = document.createDocumentFragment();
  for (let i = 0; i < 20; i++, n++) {
    const card = document.createElement('article'); card.className = 'card';
    card.innerHTML = '<div class="avatar"></div><div><div class="who">User ' + n +
      ' <span class="when">' + (n % 59) + 'm</span></div><p>Post number ' + n +
      ' with a few words of text that wrap onto a second line in a narrow column, and a <a href="#">link</a>.</p></div>';
    f.appendChild(card);
  }
  feed.appendChild(f);
});
`,
  },
  churn: {
    style:
      'body{font:14px sans-serif;margin:0}li{padding:6px 10px;border-bottom:1px solid #eee}' +
      'li:nth-child(even){background:#fafafa}',
    body: '<ul id="list"></ul>',
    script: `
const list = document.getElementById('list');
let n = 0;
for (let i = 0; i < 500; i++) { const li = document.createElement('li'); li.textContent = 'item ' + n++; list.appendChild(li); }
for (let k = 0; k < 60; k++) step('shift10', () => {
  for (let i = 0; i < 10; i++) list.firstElementChild.remove();
  for (let i = 0; i < 10; i++) { const li = document.createElement('li'); li.textContent = 'item ' + n++; list.appendChild(li); }
});
`,
  },
  toggle: {
    style:
      'body{font:14px sans-serif;margin:0}.tab{display:inline-block;padding:6px 10px}' +
      '.item{padding:4px 8px}.item.active{background:#def;font-weight:bold}' +
      '.list .item:not(.active){color:#444}',
    body: '<div class="list" id="list"></div>',
    script: `
const list = document.getElementById('list');
for (let i = 0; i < 500; i++) { const d = document.createElement('div'); d.className = 'item'; d.textContent = 'row ' + i; list.appendChild(d); }
let active = null;
for (let k = 0; k < 60; k++) step('toggle', () => {
  if (active) active.classList.remove('active');
  active = list.children[(k * 37) % 500];
  active.classList.add('active');
});
for (let k = 0; k < 10; k++) step('theme', () => document.body.classList.toggle('dark'));
`,
  },
  width: {
    style:
      'body{font:14px sans-serif;margin:0}.bar{height:16px;margin:4px;background:#48c}' +
      'p{margin:4px 8px}',
    body:
      '<div id="bars"></div>' +
      Array.from(
        { length: 200 },
        (_, i) =>
          `<p>Paragraph ${i} below the bars, pushed down when they grow.</p>`,
      ).join(''),
    script: `
const bars = document.getElementById('bars');
const els = [];
for (let i = 0; i < 20; i++) { const d = document.createElement('div'); d.className = 'bar'; bars.appendChild(d); els.push(d); }
for (let k = 0; k < 60; k++) step('width', () => {
  for (let i = 0; i < els.length; i++) els[i].style.width = (100 + ((k * 13 + i * 7) % 400)) + 'px';
});
for (let k = 0; k < 30; k++) step('height', () => {
  for (let i = 0; i < els.length; i++) els[i].style.height = (10 + ((k + i) % 8)) + 'px';
});
`,
  },
  transform: {
    style:
      'body{font:14px sans-serif;margin:0}.dot{position:absolute;width:20px;height:20px;' +
      'border-radius:10px;background:#c44}p{margin:4px 8px}',
    body:
      '<div id="dots"></div>' +
      Array.from(
        { length: 200 },
        (_, i) => `<p>Text under the dots, ${i}.</p>`,
      ).join(''),
    script: `
const dots = document.getElementById('dots');
const els = [];
for (let i = 0; i < 20; i++) { const d = document.createElement('div'); d.className = 'dot'; d.style.left = (i * 50) + 'px'; d.style.top = '20px'; dots.appendChild(d); els.push(d); }
for (let k = 0; k < 60; k++) step('transform', () => {
  for (let i = 0; i < els.length; i++) els[i].style.transform = 'translate(' + ((k * 5 + i) % 200) + 'px,' + ((k * 3) % 100) + 'px)';
});
for (let k = 0; k < 30; k++) step('opacity', () => {
  for (let i = 0; i < els.length; i++) els[i].style.opacity = String(0.3 + ((k + i) % 7) / 10);
});
`,
  },
  thrash: {
    style:
      'body{font:14px sans-serif;margin:0}.box{margin:2px 8px;background:#eef}',
    body: '<div id="boxes"></div>',
    script: `
const boxes = document.getElementById('boxes');
const els = [];
for (let i = 0; i < 100; i++) { const d = document.createElement('div'); d.className = 'box'; d.textContent = 'box ' + i; boxes.appendChild(d); els.push(d); }
for (let k = 0; k < 20; k++) step('thrash100', () => {
  let sum = 0;
  for (let i = 0; i < els.length; i++) { els[i].style.height = (20 + ((k + i) % 10)) + 'px'; sum += els[i].offsetHeight; }
  window.__sum = sum;
});
for (let k = 0; k < 20; k++) step('batched100', () => {
  for (let i = 0; i < els.length; i++) els[i].style.height = (20 + ((k + i) % 10)) + 'px';
  let sum = 0;
  for (let i = 0; i < els.length; i++) sum += els[i].offsetHeight;
  window.__sum = sum;
});
`,
  },
  text: {
    style:
      'body{font:13px monospace;margin:0}table{border-collapse:collapse}' +
      'td{padding:2px 6px;border:1px solid #ddd;text-align:right;width:60px}',
    body: '<table id="grid"></table>',
    script: `
const grid = document.getElementById('grid');
const cells = [];
for (let r = 0; r < 40; r++) { const tr = grid.insertRow(); for (let c = 0; c < 10; c++) { const td = tr.insertCell(); td.textContent = '0.00'; cells.push(td); } }
for (let k = 0; k < 60; k++) step('tick200', () => {
  for (let i = (k % 2); i < cells.length; i += 2) cells[i].textContent = ((k * 31 + i * 17) % 10000 / 100).toFixed(2);
});
`,
  },
  route: {
    style:
      'body{font:14px sans-serif;margin:0}nav a{margin:8px}section{padding:8px}' +
      'h2{margin:8px 0}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}' +
      '.tile{border:1px solid #ddd;padding:8px;border-radius:4px}',
    body: '<nav><a href="#">Home</a><a href="#">Docs</a></nav><div id="view"></div>',
    script: `
const view = document.getElementById('view');
const page = (k) => { let s = '<section><h2>Route ' + k + '</h2><div class="grid">'; for (let i = 0; i < 300; i++) s += '<div class="tile"><b>Tile ' + i + '</b><p>Some text for tile ' + i + ' of route ' + k + '.</p></div>'; return s + '</div></section>'; };
for (let k = 0; k < 10; k++) step('route', () => { view.innerHTML = page(k); });
`,
  },
};

const source = (w) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>bench</title>` +
  `<style>${w.style}</style></head><body>${w.body}` +
  `<script>${HARNESS}${w.script}</script></body></html>`;

// --- the window and its frames ------------------------------------------------

const frames = [];
let frameWaiters = [];
let drewDocument = false;
{
  const inner = WindowNode.prototype._flushFrame;
  WindowNode.prototype._flushFrame = function (...args) {
    const start = performance.now();
    const painted = inner.apply(this, args);
    const end = performance.now();
    if (painted) {
      frames.push({ start, end, drew: drewDocument });
      drewDocument = false;
      const waiting = frameWaiters;
      frameWaiters = [];
      for (const wake of waiting) wake();
    }
    return painted;
  };
  const paint = HtmlViewNode.prototype.paint;
  HtmlViewNode.prototype.paint = function (...args) {
    try {
      return paint.apply(this, args);
    } finally {
      if (this._tree) drewDocument = true;
    }
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};
const quantile = (xs, p) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
};
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

let session = null;
async function profileStart() {
  if (!PROFILE) return;
  if (!session) {
    mkdirSync(PROFILE, { recursive: true });
    session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 200 });
  }
  await session.post('Profiler.start');
}
async function profileStop(name) {
  if (!session) return;
  const { profile } = await session.post('Profiler.stop');
  writeFileSync(join(PROFILE, `${name}.cpuprofile`), JSON.stringify(profile));
}

const PALETTE = {
  text: '#000000',
  accent: '#0000ee',
  background: '#ffffff',
  surface: '#ffffff',
  border: '#808080',
  textMuted: '#000000',
  fontFamily: 'Arial',
  fontSize: 16 - (2 / 72) * 96,
};

/** What the page logged, as it logged it. */
let marks = [];
let done = null;
let mounts = 0;
const scripts = {
  timeout: 30_000,
  log: (level, text) => {
    const now = performance.now();
    if (text === 'DONE') done?.();
    else if (text.startsWith('OP '))
      marks.push({ name: text.slice(3), at: now, frame: frames.length });
    else if (text.startsWith('JS ')) {
      const mark = marks[marks.length - 1];
      if (mark) mark.js = Number(text.slice(3).split(' ')[1]);
    } else if (level === 'error') console.error('[page]', text);
  },
};
function view(doc) {
  return h(
    ThemeProvider,
    { value: PALETTE, colorScheme: 'light' },
    h(
      'window',
      { width: W, height: H, x: 20, y: 40, title: 'htmljs' },
      h(
        'box',
        { style: { flexGrow: 1, overflow: 'scroll', flexDirection: 'column' } },
        doc
          ? h(Html, {
              key: `${mounts}`,
              source: doc,
              baseUrl: 'https://bench.test/',
              partial: false,
              selectable: true,
              scripts,
              fontSize: 16,
              fontFamily: 'serif',
              monoFamily: 'monospace',
              style: { flexGrow: 1 },
            })
          : null,
      ),
    ),
  );
}

const root = await createRoot();
root.render(view(null));
await wait(200);

const names = (process.env.WORKLOADS ?? Object.keys(WORKLOADS).join(','))
  .split(',')
  .filter((n) => WORKLOADS[n]);
for (const name of names) {
  marks = [];
  mounts += 1;
  const finished = new Promise((resolve) => (done = resolve));
  await profileStart();
  const gc = new GCProfiler();
  const delay = monitorEventLoopDelay({ resolution: 1 });
  const used0 = process.memoryUsage().heapUsed;
  const from = frames.length;
  gc.start();
  delay.enable();
  const c0 = cpuMs();
  const t0 = performance.now();
  root.render(view(source(WORKLOADS[name])));
  const timedOut = await Promise.race([
    finished.then(() => false),
    wait(180_000).then(() => true),
  ]);
  // the last step's frame
  await wait(100);
  const wall = performance.now() - t0;
  const cpu = cpuMs() - c0;
  delay.disable();
  const used1 = process.memoryUsage().heapUsed;
  const { statistics } = gc.stop();
  await profileStop(name);
  let alloc = 0;
  let last = used0;
  let gcMs = 0;
  for (const s of statistics) {
    alloc += Math.max(0, s.beforeGC.heapStatistics.usedHeapSize - last);
    last = s.afterGC.heapStatistics.usedHeapSize;
    gcMs += s.cost / 1000;
  }
  alloc += Math.max(0, used1 - last);
  const ms = frames.slice(from).map((f) => f.end - f.start);

  // each step: from its start to the end of the first frame that drew the
  // document after it
  const steps = {};
  for (const mark of marks) {
    const shown = frames
      .slice(mark.frame)
      .find((f) => f.drew && f.end > mark.at);
    const entry = (steps[mark.name] ??= { lat: [], js: [], frame: [] });
    if (shown) {
      entry.lat.push(shown.end - mark.at);
      entry.frame.push(shown.end - shown.start);
    }
    if (Number.isFinite(mark.js)) entry.js.push(mark.js);
  }
  const line = {
    suite: 'htmljs',
    backend: BACKEND,
    name,
    timedOut,
    wall: r2(wall),
    cpu: r2(cpu),
    gc: r2(gcMs),
    alloc: r2(alloc / 2 ** 20),
    block: r2(delay.max / 1e6),
    frames: ms.length,
    long: ms.filter((x) => x > FRAME).length,
    steps: Object.fromEntries(
      Object.entries(steps).map(([k, v]) => [
        k,
        {
          n: v.lat.length,
          lat50: r2(quantile(v.lat, 0.5)),
          latMax: r2(v.lat.length ? Math.max(...v.lat) : NaN),
          js50: r2(quantile(v.js, 0.5)),
          frame50: r2(quantile(v.frame, 0.5)),
        },
      ]),
    ),
  };
  console.log('RESULT ' + JSON.stringify(line));
  root.render(view(null));
  await wait(300);
  globalThis.gc?.();
}
process.exit(0);
