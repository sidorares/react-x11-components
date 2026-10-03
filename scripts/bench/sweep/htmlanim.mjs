// A Zen Garden design with its animations running, as a page is looked at:
// frames with the pointer away, then with it on each of TARGETS and off it
// again. `htmlsweep.mjs` holds every animation at rest, which is how the
// corpus compares designs; this is what a design costs while it moves.
//
//   npm run build
//   NODE_ENV=production REACT_X11_BACKEND=x11 DISPLAY=:99 CACHE=… \
//     node --expose-gc scripts/bench/sweep/htmlanim.mjs
//
//   PAGE     the design, by its number (default 219)
//   TARGETS  what the pointer goes to, each a `.class` or a tag name, the
//            first element that is one (default 219's panels:
//            `.wrapper,header,.preamble,.summary`)
//   W, H     the window, logical pixels (default 1440×900, wide enough for
//            219's stylesheet for screens of 1367 and up)
//   PROFILE  a directory: a CPU profile of each phase, for `cpuprofile.ts`
//   ONLY     one target's phases alone
//
// A line a phase: `fps`, frames that painted a second; `frame50`, `frame95`
// and `frameMax`, the window's flush; `cpu`, this process's processor time
// as a share of the phase; `builds`, the box trees built; and calls and the
// mean of `_update`, `paint`, `_restyleInPlace` and `_rebuildFrame`.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';

process.env.REACT_X11_NO_AUTORUN = '1';
const { createRoot, ThemeProvider } = await import('react-x11');
const { WindowNode } = await import('react-x11/node');
const ROOT =
  process.env.BENCH_ROOT ??
  fileURLToPath(new URL('../../../', import.meta.url));
const { Html, HtmlViewNode } = await import(join(ROOT, 'dist/html/index.js'));

const h = React.createElement;
const PAGE = String(process.env.PAGE ?? 219).padStart(3, '0');
const TARGETS = (
  process.env.TARGETS ?? '.wrapper,header,.preamble,.summary'
).split(',');
const W = Number(process.env.W ?? 1440);
const H = Number(process.env.H ?? 900);
const PROFILE = process.env.PROFILE ?? '';
const ONLY = process.env.ONLY ?? '';

// --- the window's frames, and the element's own phases -----------------------

const frames = [];
let windowNode = null;
{
  const inner = WindowNode.prototype._flushFrame;
  WindowNode.prototype._flushFrame = function (...args) {
    windowNode = this;
    const start = performance.now();
    const painted = inner.apply(this, args);
    if (painted) frames.push({ start, end: performance.now() });
    return painted;
  };
}
const spent = {};
const wrap = (proto, name) => {
  const inner = proto[name];
  proto[name] = function (...args) {
    const start = performance.now();
    try {
      return inner.apply(this, args);
    } finally {
      const e = (spent[name] ??= { ms: 0, calls: 0 });
      e.ms += performance.now() - start;
      e.calls += 1;
    }
  };
};
for (const m of ['_update', 'paint', '_restyleInPlace', '_rebuildFrame']) {
  if (typeof HtmlViewNode.prototype[m] === 'function')
    wrap(HtmlViewNode.prototype, m);
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

// --- the design ----------------------------------------------------------------

/** The bench's cache, read whole, as `htmlsweep.mjs` reads it. */
function readCache(dir) {
  const byKey = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const head = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (head.missing) continue;
    const key = name.slice(0, -'.json'.length);
    byKey.set(key, {
      ...head,
      bytes: new Uint8Array(readFileSync(join(dir, `${key}.bin`))),
    });
  }
  return {
    get: (asked) => byKey.get(createHash('sha1').update(asked).digest('hex')),
  };
}
const cache = readCache(process.env.CACHE ?? 'zengarden-results/cache');
const url = `https://csszengarden.com/${PAGE}/`;
const kept =
  cache.get(`document:${url}`) ??
  cache.get(`document:https://www.csszengarden.com/${PAGE}/`);
if (!kept) throw new Error(`no ${url} in the cache`);
const source = new TextDecoder(kept.charset || 'utf-8').decode(kept.bytes);
const resource = (request) => {
  const found = cache.get(request.url);
  if (!found) return null;
  if (request.kind === 'stylesheet') {
    return {
      kind: 'stylesheet',
      bytes: found.bytes,
      charset: found.charset ?? undefined,
      url: found.url,
    };
  }
  if (request.kind === 'font') return { kind: 'font', bytes: found.bytes };
  if (request.kind === 'image') return { kind: 'image', bytes: found.bytes };
  return null;
};

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
const root = await createRoot();
root.render(
  h(
    ThemeProvider,
    { value: PALETTE, colorScheme: 'light' },
    h(
      'window',
      { width: W, height: H, x: 20, y: 40, title: 'htmlanim' },
      h(
        'box',
        { style: { flexGrow: 1, overflow: 'scroll', flexDirection: 'column' } },
        h(Html, {
          source,
          baseUrl: kept.url ?? url,
          partial: false,
          selectable: false,
          animate: true,
          onResource: (request) => Promise.resolve(resource(request)),
        }),
      ),
    ),
  ),
);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(3000);
const findView = (n) => {
  if (!n) return null;
  if (n instanceof HtmlViewNode) return n;
  for (const c of n.children ?? []) {
    const found = findView(c);
    if (found) return found;
  }
  return null;
};
const node = findView(windowNode);
if (!node) throw new Error('no <Html> in the window');
const scale = node.scale > 0 ? node.scale : 1;

/** The first element a `.class` or a tag name picks, in document order. */
const pick = (target) => {
  const test = target.startsWith('.')
    ? (el) => (el.attribs?.class ?? '').split(/\s+/).includes(target.slice(1))
    : (el) => el.name === target;
  const stack = [...(node.document.children ?? [])].reverse();
  while (stack.length) {
    const at = stack.pop();
    if (at.type !== 'tag') continue;
    if (test(at)) return at;
    for (let i = (at.children?.length ?? 0) - 1; i >= 0; i -= 1)
      stack.push(at.children[i]);
  }
  return null;
};

// --- the phases ----------------------------------------------------------------

const q = (xs, p) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
};
const r1 = (v) => Math.round(v * 10) / 10;
async function phase(name, ms, act) {
  for (const k of Object.keys(spent)) delete spent[k];
  builds = 0;
  const from = frames.length;
  let session = null;
  if (PROFILE) {
    session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 200 });
    await session.post('Profiler.start');
  }
  const cpu0 = process.cpuUsage();
  const t = performance.now();
  act?.();
  await wait(ms);
  const wall = performance.now() - t;
  const cpu = process.cpuUsage(cpu0);
  if (session) {
    const { profile } = await session.post('Profiler.stop');
    mkdirSync(PROFILE, { recursive: true });
    writeFileSync(join(PROFILE, `${name}.cpuprofile`), JSON.stringify(profile));
    session.disconnect();
  }
  const run = frames.slice(from).map((f) => f.end - f.start);
  const line = {
    page: PAGE,
    phase: name,
    scale,
    fps: r1(run.length / (wall / 1000)),
    frame50: r1(q(run, 0.5)),
    frame95: r1(q(run, 0.95)),
    frameMax: r1(Math.max(0, ...run)),
    cpu: Math.round(((cpu.user + cpu.system) / 1000 / wall) * 100),
    builds,
  };
  for (const [k, e] of Object.entries(spent))
    line[k] = `${e.calls}×${r1(e.ms / Math.max(1, e.calls))}`;
  console.log('PHASE ' + JSON.stringify(line));
}

await phase('idle', 3000);
for (const target of TARGETS) {
  const name = target.replace(/^\./, '');
  if (ONLY && ONLY !== name) continue;
  const el = pick(target);
  const rect = el && node.elementRect(el);
  if (!rect) {
    console.error(`no ${target} in ${PAGE}`);
    continue;
  }
  const x = node.abs.x / scale + rect.x + rect.width / 2;
  const y = node.abs.y / scale + rect.y + Math.min(rect.height / 2, 120);
  await phase(`${name}-in`, 2600, () => node.setHover(x, y));
  await phase(`${name}-out`, 2600, () => node.clearHover());
}
process.exit(0);
