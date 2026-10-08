// <Html> over a corpus of real pages and over synthetic documents, on the
// backend REACT_X11_BACKEND names, in one window that holds each document in
// turn. Prints a `RESULT` line per document and, at the end, a `SUMMARY`.
//
//   SUITE    corpus | synthetic (default corpus)
//   CACHE    the corpus: a `CachedNetwork` directory (scripts/zengarden/),
//            every entry of which is read into memory before anything is
//            timed, so a resource is answered at once and no disk read is
//            in a measurement
//   PAGES    which Zen Garden designs, `1-221` or `7,219` (default 1-221)
//   FEATURES which synthetic documents (default all of htmlgen.mjs's), and
//   SCALE    small | large | both (default both): their everyday size and
//            their stress size
//   W, H     the window (default 1280x800, the Zen Garden bench's viewport)
//   REPS     repetitions of each forced phase, the least kept (default 3)
//   BENCH_ROOT  the tree under test, default this checkout; its `dist/` is
//            what runs, so build it first (`npx tsc -p tsconfig.build.json`)
//
// Run it with plain node, in the production build, as an application runs
// (tsx names every function it compiles, and development React times
// every component):
//
//   NODE_ENV=production REACT_X11_BACKEND=x11 DISPLAY=:99 \
//     CACHE=… node scripts/bench/sweep/htmlsweep.mjs
//
// What each document is measured for, all in milliseconds:
//   first    the source handed over to the first frame that drew the
//            document — a frame drawn while the head's stylesheets hold its
//            rendering draws none of it
//   settle   to the last frame of its arrivals — every stylesheet, image
//            and font answered and drawn, and nothing painted for 300 ms
//   cpu      this process's processor time to `settle`
//   parse    a fresh parse of the source (`HtmlSource`)
//   cold     the cascade from its sheets' text, the boxes and the layout
//   restyle  the same with the sheets kept, as a hover that builds does
//   build    the boxes and the layout from kept styles
//   relayout the layout again at the same width
//   resize   the layout at another width, and back
//   paint    the element's paint of a whole viewport, and `frame` the
//            window's flush around it
//   scroll50, scrollMax  a frame of the pane scrolled 120 px at a time,
//            down to two viewports or the document's end
//   hover50, hoverMax    `setHover` at a grid of points, what it restyles;
//            hoverFrames how many of them painted, `hoverFrame50` that
//            frame
//   LATENCY  answer each resource up to this many milliseconds late, a
//            delay fixed by its URL, as a network would spread them over
//            the first frames (default 0: every answer at once)
//   PROFILE  a directory: a CPU profile of each document's mount, from the
//            source handed over to `settle`, for `cpuprofile.ts` — or, with
//            PHASE=cold|restyle|build|relayout|resize, of that phase's
//            repetitions instead
//   SNAPSHOT a directory: a heap snapshot after each document SNAPSHOT_AT
//            names (`001,040`) is gone and collected
// and the counts beside them: elements, boxes, the arrivals' builds, the
// text layouts asked for, and the heap after the document is gone.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import { fileURLToPath } from 'node:url';
import React from 'react';

process.env.REACT_X11_NO_AUTORUN = '1';
const { createRoot, ThemeProvider } = await import('react-x11');
const { WindowNode } = await import('react-x11/node');

const ROOT =
  process.env.BENCH_ROOT ??
  fileURLToPath(new URL('../../../', import.meta.url));
const { Html, HtmlViewNode } = await import(join(ROOT, 'dist/html/index.js'));
const { HtmlSource } = await import(join(ROOT, 'dist/html/dom.js'));
const { generate, FEATURES, SIZES } = await import('./htmlgen.mjs');

const h = React.createElement;
const SUITE = process.env.SUITE ?? 'corpus';
const W = Number(process.env.W ?? 1280);
const H = Number(process.env.H ?? 800);
const REPS = Number(process.env.REPS ?? 3);
const BACKEND = process.env.REACT_X11_BACKEND ?? 'x11';
const LATENCY = Number(process.env.LATENCY ?? 0);
/** A resource's delay, the same every run: its URL hashed into LATENCY. */
const delayOf = (url) => {
  let hash = 2166136261;
  for (let i = 0; i < url.length; i += 1)
    hash = Math.imul(hash ^ url.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 1000) * (LATENCY / 1000);
};

// --- the window's frames, and the element's own phases -----------------------

const frames = [];
let frameWaiters = [];
/** The window the frames flush, whose tree holds the element. */
let windowNode = null;
{
  const inner = WindowNode.prototype._flushFrame;
  WindowNode.prototype._flushFrame = function (...args) {
    windowNode = this;
    const start = performance.now();
    const painted = inner.apply(this, args);
    const end = performance.now();
    if (painted) {
      frames.push({ start, end, drew: drewDocument });
      drewDocument = false;
      const waiting = frameWaiters;
      frameWaiters = [];
      for (const wake of waiting) wake({ start, end });
    }
    return painted;
  };
}

/** Time spent in, and calls of, each wrapped method, since `reset()`. */
const spent = {};
const reset = () => {
  for (const key of Object.keys(spent)) delete spent[key];
};
const wrap = (proto, name, key = name) => {
  const inner = proto[name];
  proto[name] = function (...args) {
    const start = performance.now();
    try {
      return inner.apply(this, args);
    } finally {
      const entry = (spent[key] ??= { ms: 0, calls: 0 });
      entry.ms += performance.now() - start;
      entry.calls += 1;
    }
  };
};
wrap(HtmlViewNode.prototype, '_read');
wrap(HtmlViewNode.prototype, '_restyle');
wrap(HtmlViewNode.prototype, '_update');
wrap(HtmlViewNode.prototype, 'paint');
// whether the frame being flushed drew the document: its paint had a tree
let drewDocument = false;
{
  const inner = HtmlViewNode.prototype.paint;
  HtmlViewNode.prototype.paint = function (...args) {
    try {
      return inner.apply(this, args);
    } finally {
      if (this._tree) drewDocument = true;
    }
  };
}
// a build is a new tree
let builds = 0;
{
  const inner = HtmlViewNode.prototype._update;
  HtmlViewNode.prototype._update = function (...args) {
    const was = this._tree;
    try {
      return inner.apply(this, args);
    } finally {
      if (this._tree && this._tree !== was) builds += 1;
    }
  };
}

/** The next frame that paints, or null when none has within `ms`. */
const PROFILE = process.env.PROFILE ?? '';
// a heap snapshot after each of these documents is gone and collected, for
// what a document leaves behind it
const SNAPSHOT = process.env.SNAPSHOT ?? '';
const SNAPSHOT_AT = (process.env.SNAPSHOT_AT ?? '').split(',');
const PHASE = process.env.PHASE ?? '';
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

const nextFrame = (ms = 1000) =>
  Promise.race([
    new Promise((wake) => frameWaiters.push(wake)),
    new Promise((wake) => setTimeout(() => wake(null), ms)),
  ]);
const trace = process.env.TRACE
  ? (...a) => console.error('[htmlsweep]', ...a)
  : () => {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const quantile = (xs, p) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
};

// --- the documents -----------------------------------------------------------

/** The cache, read whole: its key — the SHA-1 of what was asked for, as
 *  `CachedNetwork` files it — to what the bench's network kept. */
function readCache(dir) {
  const byKey = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const head = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const key = name.slice(0, -'.json'.length);
    if (head.missing) {
      byKey.set(key, null);
      continue;
    }
    const bytes = new Uint8Array(readFileSync(join(dir, `${key}.bin`)));
    byKey.set(key, { ...head, bytes });
  }
  return {
    get: (asked) => byKey.get(createHash('sha1').update(asked).digest('hex')),
  };
}

/** What `examples/browser/network.ts`'s `resourceResult` makes of a kept
 *  response. */
function resultOf(kept, kind) {
  if (!kept) return null;
  if (kind === 'stylesheet') {
    if (kept.type && kept.type !== 'text/css') return null;
    return {
      kind: 'stylesheet',
      bytes: kept.bytes,
      charset: kept.charset ?? undefined,
      url: kept.url,
    };
  }
  if (kind === 'font') return { kind: 'font', bytes: kept.bytes };
  if (kind === 'image') {
    return /^(?:text\/html|text\/plain|text\/xml|application\/xml|application\/xhtml\+xml)$/.test(
      kept.type ?? '',
    )
      ? { kind: 'document' }
      : { kind: 'image', bytes: kept.bytes };
  }
  return null;
}

function* documents() {
  if (SUITE === 'corpus') {
    const cache = readCache(process.env.CACHE ?? 'zengarden-results/cache');
    const spec = process.env.PAGES ?? '1-221';
    const pages = [];
    for (const part of spec.split(',')) {
      const [a, b] = part.split('-').map(Number);
      for (let n = a; n <= (b ?? a); n += 1) pages.push(n);
    }
    for (const n of pages) {
      const id = String(n).padStart(3, '0');
      const url = `https://csszengarden.com/${id}/`;
      const kept =
        cache.get(`document:${url}`) ??
        cache.get(`document:https://www.csszengarden.com/${id}/`);
      if (!kept) {
        console.error(`no ${url} in the cache`);
        continue;
      }
      const source = new TextDecoder(kept.charset || 'utf-8').decode(
        kept.bytes,
      );
      yield {
        name: id,
        source,
        baseUrl: kept.url ?? url,
        animate: false,
        resource: (request) => {
          if (request.kind === 'video') return null;
          return resultOf(cache.get(request.url), request.kind);
        },
      };
    }
    return;
  }
  const scale = process.env.SCALE ?? 'both';
  const features = (
    process.env.FEATURES ?? Object.keys(FEATURES).join(',')
  ).split(',');
  for (const feature of features) {
    const [small, large] = SIZES[feature];
    const sizes =
      scale === 'small'
        ? [small]
        : scale === 'large'
          ? [large]
          : [small, large];
    for (const size of sizes) {
      yield {
        name: `${feature}-${size === small ? 's' : 'l'}`,
        source: generate(feature, size),
        baseUrl: null,
        animate: feature === 'anim',
        resource: () => null,
      };
    }
  }
}

// --- the window ----------------------------------------------------------------

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

let pending = 0;
let lastArrival = 0;
const pane = { current: null };
function view(doc) {
  const onResource = (request) => {
    pending += 1;
    const answer = LATENCY
      ? new Promise((answered) =>
          setTimeout(
            () => answered(doc.resource(request)),
            delayOf(request.url),
          ),
        )
      : Promise.resolve(doc.resource(request));
    return answer.finally(() => {
      pending -= 1;
      lastArrival = performance.now();
    });
  };
  return h(
    ThemeProvider,
    { value: PALETTE, colorScheme: 'light' },
    h(
      'window',
      { width: W, height: H, x: 20, y: 40, title: 'htmlsweep' },
      h(
        'box',
        {
          ref: pane,
          style: { flexGrow: 1, overflow: 'scroll', flexDirection: 'column' },
        },
        doc
          ? h(Html, {
              key: doc.name,
              source: doc.source,
              baseUrl: doc.baseUrl ?? undefined,
              partial: false,
              selectable: false,
              animate: doc.animate,
              reducedMotion: false,
              fontSize: 16,
              fontFamily: 'serif',
              monoFamily: 'monospace',
              onResource,
              style: { flexGrow: 1 },
            })
          : null,
      ),
    ),
  );
}

const root = await createRoot();
root.render(view(null));
await nextFrame();

function findView(node) {
  if (!node) return null;
  if (node instanceof HtmlViewNode) return node;
  for (const child of node.children ?? []) {
    const found = findView(child);
    if (found) return found;
  }
  return null;
}

const countElements = (node) => {
  let n = 0;
  const stack = [node];
  while (stack.length) {
    const at = stack.pop();
    if (at.type === 'tag' || at.type === 'script' || at.type === 'style')
      n += 1;
    for (const child of at.children ?? []) stack.push(child);
  }
  return n;
};
const countBoxes = (box) => {
  let n = 0;
  const stack = [box];
  while (stack.length) {
    const at = stack.pop();
    n += 1;
    for (const child of at.children ?? []) stack.push(child);
  }
  return n;
};

/** The least of `REPS` runs of `fn`, wall and processor time. */
function least(fn) {
  let wall = Infinity;
  let cpu = Infinity;
  for (let i = 0; i < REPS; i += 1) {
    const c = cpuMs();
    const t = performance.now();
    fn();
    wall = Math.min(wall, performance.now() - t);
    cpu = Math.min(cpu, cpuMs() - c);
  }
  return { wall, cpu };
}

async function measure(doc) {
  // the text layouts the app is asked for, whoever asks
  const fonts = root.app?.fonts;
  let textLayouts = 0;
  let textMs = 0;
  const layout = fonts?.layout;
  if (fonts && layout) {
    fonts.layout = function (...args) {
      const t = performance.now();
      try {
        return layout.apply(this, args);
      } finally {
        textLayouts += 1;
        textMs += performance.now() - t;
      }
    };
  }
  try {
    reset();
    builds = 0;
    pending = 0;
    const before = frames.length;
    if (!PHASE) await profileStart();
    const c0 = cpuMs();
    const t0 = performance.now();
    root.render(view(doc));
    trace(doc.name, 'rendered');
    // until nothing is in flight and nothing has painted for a while
    const deadline = t0 + 30_000;
    for (;;) {
      await wait(25);
      const last = frames.length > before ? frames[frames.length - 1].end : t0;
      const now = performance.now();
      if (
        pending === 0 &&
        now - Math.max(last, lastArrival) > 300 &&
        frames.length > before
      )
        break;
      if (now > deadline) break;
      trace(doc.name, 'waiting', { frames: frames.length - before, pending });
    }
    const painted = frames.slice(before);
    if (!PHASE) await profileStop(doc.name);
    const drew = painted.find((f) => f.drew);
    const first = drew ? drew.end - t0 : NaN;
    const settle = painted.length ? painted[painted.length - 1].end - t0 : NaN;
    // the idle tail costs next to no processor time
    const cpu = cpuMs() - c0;
    const mount = {
      first,
      settle,
      cpu,
      frames: painted.length,
      updates: spent._update?.calls ?? 0,
      updateMs: spent._update?.ms ?? 0,
      restyles: spent._restyle?.calls ?? 0,
      restyleMs: spent._restyle?.ms ?? 0,
      paints: spent.paint?.calls ?? 0,
      paintMs: spent.paint?.ms ?? 0,
      builds,
      textLayouts,
      textMs,
    };

    const node = findView(windowNode);
    trace(doc.name, 'settled', { node: !!node, tree: !!node?._tree, ...mount });
    if (!node || !node._tree) return { name: doc.name, failed: true, ...mount };
    const width = node._laidOutWidth;
    const elements = countElements(node.document);
    const boxes = countBoxes(node._tree.root);

    // the phases, forced through the element's own pipeline, each the least
    // of REPS, back to back so that no frame runs between them
    const parse = least(() => new HtmlSource().setSource(doc.source, true));
    if (PHASE) await profileStart();
    const cold = least(() => {
      node._sheetsRead = null;
      node._invalidate(3);
      node._prepare(width);
    });
    const restyle = least(() => {
      node._invalidate(3);
      node._prepare(width);
    });
    const build = least(() => {
      node._invalidate(2);
      node._prepare(width);
    });
    const relayout = least(() => {
      node._invalidate(1);
      node._prepare(width);
    });
    const other = Math.max(320, width - 280);
    const resize = least(() => {
      node._prepare(other);
      node._prepare(width);
    });
    if (PHASE) await profileStop(doc.name);
    textLayouts = 0;
    node._invalidate(2);
    node._prepare(width);
    const buildLayouts = textLayouts;
    await nextFrame();
    await nextFrame();

    // a whole viewport painted again
    const paints = [];
    for (let i = 0; i < REPS; i += 1) {
      reset();
      node.invalidate(false, node, 'htmlsweep');
      const f = await nextFrame();
      paints.push({
        paint: spent.paint?.ms ?? NaN,
        frame: f ? f.end - f.start : NaN,
      });
    }
    const paint = Math.min(...paints.map((p) => p.paint));
    const frame = Math.min(...paints.map((p) => p.frame));

    // the pane scrolled 120 px a step, down as far as two viewports go
    const scrollFrames = [];
    const p = pane.current;
    if (p && typeof p.scrollTo === 'function') {
      for (let y = 120; y <= 2 * H; y += 120) {
        const was = p.scrollY;
        p.scrollTo(y);
        if (p.scrollY === was) break;
        const f = await nextFrame(150);
        if (f) scrollFrames.push(f.end - f.start);
      }
      p.scrollTo(0);
      await nextFrame(150);
    }

    // the pointer at a grid of points: what a hover restyles, to its frame
    const hovers = [];
    const hoverFrames = [];
    const scale = node.scale > 0 ? node.scale : 1;
    const abs = node.abs;
    for (let gy = 1; gy <= 3; gy += 1) {
      for (let gx = 1; gx <= 4; gx += 1) {
        const x = (abs.x + (abs.width * gx) / 5) / scale;
        const y = (abs.y + (Math.min(abs.height, H * scale) * gy) / 4) / scale;
        const t = performance.now();
        node.setHover(x, y);
        hovers.push(performance.now() - t);
        const f = await nextFrame(60);
        if (f) hoverFrames.push(f.end - f.start);
      }
    }
    node.clearHover();
    await nextFrame(60);

    // the animations: a second of frames on the document's clock
    let anim = null;
    if (doc.animate) {
      const from = frames.length;
      reset();
      const t = performance.now();
      await wait(1000);
      const run = frames.slice(from);
      anim = {
        fps: run.length / ((performance.now() - t) / 1000),
        frame50: quantile(
          run.map((f) => f.end - f.start),
          0.5,
        ),
        paint: (spent.paint?.ms ?? 0) / Math.max(1, spent.paint?.calls ?? 1),
      };
    }

    return {
      name: doc.name,
      bytes: doc.source.length,
      elements,
      boxes,
      ...mount,
      parse: parse.cpu,
      cold: cold.cpu,
      restyle: restyle.cpu,
      build: build.cpu,
      relayout: relayout.cpu,
      resize: resize.cpu / 2,
      buildLayouts,
      paint,
      frame,
      scroll50: quantile(scrollFrames, 0.5),
      scrollMax: scrollFrames.length ? Math.max(...scrollFrames) : NaN,
      hover50: quantile(hovers, 0.5),
      hoverMax: hovers.length ? Math.max(...hovers) : NaN,
      hoverFrames: hoverFrames.length,
      hoverFrame50: quantile(hoverFrames, 0.5),
      ...(anim
        ? {
            animFps: anim.fps,
            animFrame50: anim.frame50,
            animPaint: anim.paint,
          }
        : {}),
    };
  } finally {
    if (fonts && layout) fonts.layout = layout;
  }
}

const results = [];
const started = performance.now();
for (const doc of documents()) {
  const result = await measure(doc);
  // gone, and collected, before the heap is read
  root.render(view(null));
  await Promise.race([nextFrame(), wait(200)]);
  globalThis.gc?.();
  result.heap = process.memoryUsage().heapUsed / 2 ** 20;
  if (SNAPSHOT && SNAPSHOT_AT.includes(doc.name)) {
    mkdirSync(SNAPSHOT, { recursive: true });
    writeHeapSnapshot(join(SNAPSHOT, `${doc.name}.heapsnapshot`));
  }
  const line = { suite: 'html', comp: SUITE, backend: BACKEND, ...result };
  for (const [k, v] of Object.entries(line))
    if (typeof v === 'number') line[k] = r2(v);
  results.push(line);
  console.log('RESULT ' + JSON.stringify(line));
}
const ok = results.filter((r) => !r.failed);
const sum = (key) => ok.reduce((s, r) => s + (r[key] ?? 0), 0);
console.log(
  'SUMMARY ' +
    JSON.stringify({
      suite: 'html',
      comp: SUITE,
      backend: BACKEND,
      documents: results.length,
      failed: results.length - ok.length,
      wallSeconds: r2((performance.now() - started) / 1000),
      settleSum: r2(sum('settle')),
      cpuSum: r2(sum('cpu')),
      firstSum: r2(sum('first')),
      coldSum: r2(sum('cold')),
      restyleSum: r2(sum('restyle')),
      buildSum: r2(sum('build')),
      relayoutSum: r2(sum('relayout')),
      paintSum: r2(sum('paint')),
    }),
);
process.exit(0);
