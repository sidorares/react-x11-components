// <Html> as a page is lived with, a document at a time, in one window on the
// backend REACT_X11_BACKEND names: loaded, loaded again, scrolled from top to
// bottom, its window's edge dragged narrower and back, and the pointer moved
// over it. What a user waits for and what they feel, beside what the
// process paid for it — the garbage collector's share, what was allocated,
// and the longest the event loop was held.
//
//   SUITE    pages | corpus | synthetic (default pages)
//   CACHE    the disk cache `htmlfetch.ts` filled (a `CachedNetwork`
//            directory), read whole into memory before anything is timed
//   LIST     the pages, a file of URLs (default pages.txt beside this); or
//   PAGES    which Zen Garden designs, for SUITE=corpus (`1-221`, `7,219`)
//   FEATURES, SCALE  which of htmlgen.mjs's documents, for SUITE=synthetic
//   ONLY     a substring of a page's URL or name: only those
//   W, H     the window (default 1280x800)
//   STEPS    what to do after the load: any of reload,scroll,resize,hover
//            (default all four)
//   SCROLL_STEP  pixels a scroll step (default 100, a wheel notch's);
//   SCROLL_MAX   the most steps (default 300)
//   DRAG_STEP    pixels a step of the drag (default 8); DRAG_STEPS each
//            way (default 40)
//   SCRIPTS  1: the page's scripts run, as the browser example's JS
//            switch has them, their sources and their requests answered
//            from what `htmlfetch.ts --scripts` kept (node needs
//            `--experimental-vm-modules`); a request it did not keep is a
//            404
//   PROFILE  a directory: a CPU profile of each step of each page,
//            <name>-<step>.cpuprofile, for cpuprofile.ts
//   ALLOC    a directory: an allocation sampling profile of each step,
//            <name>-<step>.heapprofile (Chrome DevTools' Memory panel, or
//            cpuprofile.ts's `alloc`)
//   BENCH_ROOT  the tree under test, default this checkout's `dist/`
//
//   NODE_ENV=production REACT_X11_BACKEND=x11 DISPLAY=:99 CACHE=… \
//     node --expose-gc scripts/bench/sweep/htmlpage.mjs > pages.jsonl
//
// What each line holds, times in milliseconds:
//   load.first   the source handed over to the first frame that drew the
//                document; load.settle to the last frame of its arrivals,
//                nothing painted for 300 ms after — and with SCRIPTS=1,
//                after the document's `load`, nothing arriving for 1.5 s
//   *.cpu        this process's processor time over the step
//   *.gc         the collector's time over it (GCProfiler), *.majors its
//                mark-compacts, *.alloc megabytes allocated
//   *.block      the longest the event loop was held: the most a 1 ms
//                timer was late
//   *.frame50/95/max, *.long  the window's flushes over the step, and how
//                many took longer than a 60 Hz frame
//   reload.*     the same document mounted again, as a reload is: what was
//                kept from the first — fonts, shaped text, decoded images
//                — is what it saves
//   scroll.*     the pane scrolled a step a frame from the top to the end
//   resize.*     the window narrowed a step a frame and widened back,
//                each step laid out and painted before the next;
//                resize.rest the layout once it holds still
//   hover.*      the pointer at a grid of points, each restyle to its frame
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const { generate, FEATURES, SIZES } = await import('./htmlgen.mjs');

const h = React.createElement;
const SUITE = process.env.SUITE ?? 'pages';
const W = Number(process.env.W ?? 1280);
const H = Number(process.env.H ?? 800);
const BACKEND = process.env.REACT_X11_BACKEND ?? 'x11';
const STEPS = new Set(
  (process.env.STEPS ?? 'reload,scroll,resize,hover').split(','),
);
const SCROLL_STEP = Number(process.env.SCROLL_STEP ?? 100);
const SCROLL_MAX = Number(process.env.SCROLL_MAX ?? 300);
const DRAG_STEP = Number(process.env.DRAG_STEP ?? 8);
const DRAG_STEPS = Number(process.env.DRAG_STEPS ?? 40);
const ONLY = process.env.ONLY ?? '';
const SCRIPTS = process.env.SCRIPTS === '1';
const PROFILE = process.env.PROFILE ?? '';
const ALLOC = process.env.ALLOC ?? '';
const FRAME = 1000 / 60;

// --- the window's frames -----------------------------------------------------

const frames = [];
let frameWaiters = [];
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

const nextFrame = (ms = 1000) =>
  Promise.race([
    new Promise((wake) => frameWaiters.push(wake)),
    new Promise((wake) => setTimeout(() => wake(null), ms)),
  ]);
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

// --- what a step cost the process --------------------------------------------

let session = null;
async function profileStart() {
  if (!PROFILE && !ALLOC) return;
  if (!session) {
    session = new Session();
    session.connect();
    if (PROFILE) {
      mkdirSync(PROFILE, { recursive: true });
      await session.post('Profiler.enable');
      await session.post('Profiler.setSamplingInterval', { interval: 200 });
    }
    if (ALLOC) {
      mkdirSync(ALLOC, { recursive: true });
      await session.post('HeapProfiler.enable');
    }
  }
  if (PROFILE) await session.post('Profiler.start');
  if (ALLOC)
    await session.post('HeapProfiler.startSampling', {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
}
async function profileStop(step) {
  if (!session) return;
  const name = step.replace(/[^\w.-]+/g, '_');
  if (PROFILE) {
    const { profile } = await session.post('Profiler.stop');
    writeFileSync(join(PROFILE, `${name}.cpuprofile`), JSON.stringify(profile));
  }
  if (ALLOC) {
    const { profile } = await session.post('HeapProfiler.stopSampling');
    writeFileSync(join(ALLOC, `${name}.heapprofile`), JSON.stringify(profile));
  }
}

/** Start counting a step's cost; the function returned stops and answers. */
async function costOf(name) {
  await profileStart();
  const gc = new GCProfiler();
  const delay = monitorEventLoopDelay({ resolution: 1 });
  const from = frames.length;
  const builtFrom = builds;
  const used0 = process.memoryUsage().heapUsed;
  gc.start();
  delay.enable();
  const c0 = cpuMs();
  const t0 = performance.now();
  return async () => {
    const cpu = cpuMs() - c0;
    const wall = performance.now() - t0;
    delay.disable();
    const used1 = process.memoryUsage().heapUsed;
    const { statistics } = gc.stop();
    await profileStop(name);
    // what was allocated: each collection's heap before it, less what the
    // one before left, and what is in the heap now less what the last left
    let alloc = 0;
    let last = used0;
    let gcMs = 0;
    let majors = 0;
    for (const s of statistics) {
      alloc += Math.max(0, s.beforeGC.heapStatistics.usedHeapSize - last);
      last = s.afterGC.heapStatistics.usedHeapSize;
      gcMs += s.cost / 1000;
      if (s.gcType === 'MarkSweepCompact') majors += 1;
    }
    alloc += Math.max(0, used1 - last);
    const ms = frames.slice(from).map((f) => f.end - f.start);
    return {
      from,
      t0,
      step: {
        wall,
        cpu,
        gc: gcMs,
        majors,
        alloc: alloc / 2 ** 20,
        block: delay.max / 1e6,
        frames: ms.length,
        frame50: quantile(ms, 0.5),
        frame95: quantile(ms, 0.95),
        frameMax: ms.length ? Math.max(...ms) : NaN,
        long: ms.filter((x) => x > FRAME).length,
        builds: builds - builtFrom,
      },
    };
  };
}

// --- the documents -----------------------------------------------------------

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

/** What `src/html/network.ts`'s `resourceResult` makes of a kept
 *  response. */
function resultOf(kept, kind) {
  if (!kept) return null;
  if (kind === 'stylesheet' || kind === 'script') {
    if (kind === 'stylesheet' && kept.type && kept.type !== 'text/css')
      return null;
    return {
      kind,
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

/** A page's request answered from the cache, as `htmlfetch.ts` keeps it
 *  (`fetchKey`), or a 404. */
function fetchFrom(cache) {
  return async (request) => {
    const key = `fetch:${request.method.toUpperCase()} ${request.url}\n${request.body ?? ''}`;
    const kept = cache.get(key);
    if (!kept)
      return {
        url: request.url,
        status: 404,
        statusText: 'Not Found',
        redirected: false,
        headers: [],
        body: '',
      };
    const { bytes, ...head } = kept;
    return { ...head, bytes, body: new TextDecoder().decode(bytes) };
  };
}

function cachedPage(cache, name, urls) {
  for (const url of urls) {
    const kept = cache.get(`document:${url}`);
    if (!kept) continue;
    return {
      name,
      source: new TextDecoder(kept.charset || 'utf-8').decode(kept.bytes),
      baseUrl: kept.url ?? url,
      animate: false,
      resource: (request) =>
        request.kind === 'video'
          ? null
          : resultOf(cache.get(request.url), request.kind),
      fetch: fetchFrom(cache),
    };
  }
  console.error(`no ${urls[0]} in the cache`);
  return null;
}

function* documents() {
  if (SUITE === 'pages' || SUITE === 'corpus') {
    const cache = readCache(process.env.CACHE ?? 'zengarden-results/cache');
    if (SUITE === 'pages') {
      const list = process.env.LIST ?? join(HERE, 'pages.txt');
      for (const line of readFileSync(list, 'utf8').split('\n')) {
        const url = line.replace(/#.*/, '').trim();
        if (!url || (ONLY && !url.includes(ONLY))) continue;
        const name = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
        const doc = cachedPage(cache, name, [url]);
        if (doc) yield doc;
      }
      return;
    }
    const pages = [];
    for (const part of (process.env.PAGES ?? '1-221').split(',')) {
      const [a, b] = part.split('-').map(Number);
      for (let n = a; n <= (b ?? a); n += 1) pages.push(n);
    }
    for (const n of pages) {
      const id = String(n).padStart(3, '0');
      if (ONLY && !id.includes(ONLY)) continue;
      const doc = cachedPage(cache, id, [
        `https://csszengarden.com/${id}/`,
        `https://www.csszengarden.com/${id}/`,
      ]);
      if (doc) yield doc;
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
      const name = `${feature}-${size === small ? 's' : 'l'}`;
      if (ONLY && !name.includes(ONLY)) continue;
      yield {
        name,
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
/** When the document's `load` was told (`onLoaded`), 0 until it is: with
 *  its scripts on, a page settles only after it, since a page whose first
 *  frame is long, and whose scripts' engine is still loading, is quiet for
 *  300 ms before anything of its scripts has run. */
let loadedAt = 0;
/** How long nothing may arrive before a page is settled, beside 300 ms
 *  with no frame: with its scripts on, longer, since a page's ad and
 *  analytics scripts start on a timer after `load` — the Guardian's header
 *  bidding a second after it. A page with nothing late pays only the wait:
 *  `settle` is its last frame, and the processor time is the work done. */
const QUIET_MS = SCRIPTS ? 1500 : 300;
const pane = { current: null };
let mounts = 0;
function view(doc, width = W) {
  const onResource = (request) => {
    pending += 1;
    return Promise.resolve(doc.resource(request)).finally(() => {
      pending -= 1;
      lastArrival = performance.now();
    });
  };
  return h(
    ThemeProvider,
    { value: PALETTE, colorScheme: 'light' },
    h(
      'window',
      { width, height: H, x: 20, y: 40, title: 'htmlpage' },
      h(
        'box',
        {
          ref: pane,
          style: { flexGrow: 1, overflow: 'scroll', flexDirection: 'column' },
        },
        doc
          ? h(Html, {
              key: `${doc.name}#${mounts}`,
              source: doc.source,
              baseUrl: doc.baseUrl ?? undefined,
              partial: false,
              selectable: true,
              animate: doc.animate,
              reducedMotion: false,
              fontSize: 16,
              fontFamily: 'serif',
              monoFamily: 'monospace',
              scripts: SCRIPTS
                ? {
                    timeout: 10_000,
                    fetch: (request) => {
                      pending += 1;
                      return doc.fetch(request).finally(() => {
                        pending -= 1;
                        lastArrival = performance.now();
                      });
                    },
                  }
                : false,
              onResource,
              onLoaded: () => {
                loadedAt = performance.now();
              },
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

/** Mount `doc` and wait for it to settle: nothing in flight and nothing
 *  painted for 300 ms. */
async function load(doc, name) {
  pending = 0;
  loadedAt = 0;
  mounts += 1;
  const stop = await costOf(name);
  root.render(view(doc));
  const deadline = performance.now() + 60_000;
  for (;;) {
    await wait(25);
    const since = frames.length > 0 ? frames[frames.length - 1].end : 0;
    const now = performance.now();
    // a frame a caret's blink paints is no news; an arrival, or the load,
    // may be the start of what a page's scripts do next
    const quiet =
      now - since > 300 && now - Math.max(lastArrival, loadedAt) > QUIET_MS;
    if (pending === 0 && quiet && (!SCRIPTS || loadedAt > 0)) break;
    if (now > deadline) break;
  }
  const { from, t0, step } = await stop();
  const painted = frames.slice(from);
  const drew = painted.find((f) => f.drew);
  delete step.wall;
  return {
    first: drew ? drew.end - t0 : NaN,
    settle: painted.length ? painted[painted.length - 1].end - t0 : NaN,
    ...step,
  };
}

async function unload() {
  root.render(view(null));
  await Promise.race([nextFrame(), wait(200)]);
  globalThis.gc?.();
}

async function measure(doc) {
  const result = { name: doc.name, bytes: doc.source.length };
  result.load = await load(doc, `${doc.name}-load`);
  const node = findView(windowNode);
  if (!node || !node._tree) return { ...result, failed: true };
  result.elements = countElements(node.document);
  result.boxes = countBoxes(node._tree.root);
  result.height = Math.round(node.abs.height / (node.scale || 1));

  if (STEPS.has('scroll')) {
    const p = pane.current;
    await nextFrame(100);
    const stop = await costOf(`${doc.name}-scroll`);
    let steps = 0;
    for (let y = SCROLL_STEP; steps < SCROLL_MAX; y += SCROLL_STEP) {
      const was = p.scrollY;
      p.scrollTo(y);
      if (p.scrollY === was) break;
      steps += 1;
      await nextFrame(150);
    }
    const { step } = await stop();
    result.scroll = { steps, ...step };
    p.scrollTo(0);
    await nextFrame(150);
  }

  if (STEPS.has('resize')) {
    await nextFrame(100);
    const stop = await costOf(`${doc.name}-resize`);
    const widths = [];
    for (let i = 1; i <= DRAG_STEPS; i += 1) widths.push(W - i * DRAG_STEP);
    for (let i = DRAG_STEPS - 1; i >= 0; i -= 1) widths.push(W - i * DRAG_STEP);
    for (const width of widths) {
      root.render(view(doc, width));
      await nextFrame(500);
    }
    const dragged = performance.now();
    // the layout once the width holds still
    for (let i = 0; i < 20; i += 1) {
      const f = await nextFrame(400);
      if (!f) break;
    }
    const { step } = await stop();
    result.resize = {
      steps: widths.length,
      rest: performance.now() - dragged,
      ...step,
    };
  }

  if (STEPS.has('hover')) {
    await nextFrame(100);
    const stop = await costOf(`${doc.name}-hover`);
    const restyles = [];
    const scale = node.scale > 0 ? node.scale : 1;
    const abs = node.abs;
    for (let gy = 1; gy <= 4; gy += 1) {
      for (let gx = 1; gx <= 5; gx += 1) {
        const x = (abs.x + (abs.width * gx) / 6) / scale;
        const y = (abs.y + (Math.min(abs.height, H * scale) * gy) / 5) / scale;
        const t = performance.now();
        node.setHover(x, y);
        restyles.push(performance.now() - t);
        await nextFrame(60);
      }
    }
    node.clearHover();
    await nextFrame(60);
    const { step } = await stop();
    result.hover = {
      restyle50: quantile(restyles, 0.5),
      restyleMax: Math.max(...restyles),
      ...step,
    };
  }

  if (STEPS.has('reload')) {
    await unload();
    result.reload = await load(doc, `${doc.name}-reload`);
  }
  return result;
}

const round = (value) => {
  if (typeof value === 'number') return r2(value);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, round(v)]),
    );
  return value;
};

const results = [];
const started = performance.now();
for (const doc of documents()) {
  const result = await measure(doc);
  await unload();
  result.heap = process.memoryUsage().heapUsed / 2 ** 20;
  const line = round({ suite: 'htmlpage', backend: BACKEND, ...result });
  results.push(line);
  console.log('RESULT ' + JSON.stringify(line));
}
const ok = results.filter((r) => !r.failed);
const sum = (path) =>
  ok.reduce(
    (s, r) => s + (path.split('.').reduce((o, k) => o?.[k], r) ?? 0),
    0,
  );
console.log(
  'SUMMARY ' +
    JSON.stringify(
      round({
        suite: 'htmlpage',
        backend: BACKEND,
        documents: results.length,
        failed: results.length - ok.length,
        wallSeconds: (performance.now() - started) / 1000,
        loadSettle: sum('load.settle'),
        loadCpu: sum('load.cpu'),
        loadGc: sum('load.gc'),
        loadAlloc: sum('load.alloc'),
        reloadSettle: sum('reload.settle'),
        reloadCpu: sum('reload.cpu'),
        scrollCpu: sum('scroll.cpu'),
        scrollLong: sum('scroll.long'),
        resizeCpu: sum('resize.cpu'),
        resizeLong: sum('resize.long'),
        hoverCpu: sum('hover.cpu'),
      }),
    ),
);
process.exit(0);
