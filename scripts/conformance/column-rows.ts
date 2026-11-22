// Generated rows of a grid, or of a flex box, in columns, with items of every
// kind: laid out by `<Html>` and by Chromium, and compared. A check to run by
// hand on a change to how columns break a row, and no test of the suite.
//
//   node --import tsx scripts/conformance/column-rows.ts lay <out.jsonl> \
//     [from] [to]        # <Html>, of the tree at the working directory
//   node --import tsx scripts/conformance/column-rows.ts chrome <out.jsonl> \
//     [from] [to]        # Chromium (CHROME, or the one installed)
//   node --import tsx scripts/conformance/column-rows.ts judge \
//     <chrome.jsonl> <before.jsonl> <after.jsonl>
//
// `lay` takes a range of a couple of thousand at a time, as the harness keeps
// what it rendered: all 10,000 in one process ran out of memory at 8,602. The
// parts are put together with `cat`, and `judge` refuses a file that has not
// every case Chromium's has.
//
// A case is made from its seed, 0 to 9,999 unless it is said otherwise: two to
// six items of forty kinds — blocks, replaced elements, overflow of every
// kind, containment, tables, flex boxes and grids, floats, writing modes,
// transforms, forced and avoided breaks — from a fifth of a column's height
// to more than three of them, in two to four columns, filled or balanced.
// `lay` run from the root of another checkout lays out that checkout's, with
// this file named by its path, which is how two commits are compared.
//
// What a change is held to, in order:
//
// 1. nothing throws, and nothing newly takes more than five seconds;
// 2. no case that matched Chromium comes not to, within 0.6px: its container,
//    its grid, each item's pieces and the block after;
// 3. what is drawn, which nothing here says. THERE IS NO TEXT IN A CASE, and
//    nothing is painted: a paragraph's lines, its `orphans` and `widows`, and
//    where its ink lands are a test of pixels', and a change that passes here
//    has not passed that (`docs/prd-html-grid-rows.md`).
//
// Chromium's own answer is not the same every time for seeds 800 and 2000,
// each of which has an item of `content-visibility: auto`; they match at none
// of the commits below, and another such case may do the same.
//
// Measured on seeds 0 to 9,999 against Chromium 157, as the count of cases
// that match and of cases that throw:
//
//   41e331b39, before a grid's row was broken an item at a time  2,243    0
//   550f071b5, which broke it so (#1828)                         2,122   27
//   738b61e28, with #1848                                        2,122   27
//   the revert of both                                           2,243    0
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chrome } from '../zengarden/chrome.js';

/** A seeded generator of numbers: the same on every machine. The seeds above
 *  are of this one, whose start is the seed's own. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;
const pick = <T>(r: Random, from: readonly T[]): T =>
  from[Math.floor(r() * from.length)];
const box = (height: number, width: number | 'auto' = 'auto'): string =>
  `<div style="height:${height}px;width:${width === 'auto' ? 'auto' : `${width}px`}"></div>`;
const PNG = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
const inlineBlock = (height: number): string =>
  `<div style="display:inline-block;width:20px;height:${height}px;vertical-align:top"></div>`;

/** What an item of plain flow holds, for columns `H` tall. */
function content(r: Random, H: number): string {
  const n = 1 + Math.floor(r() * 3);
  let out = '';
  for (let i = 0; i < n; i += 1) {
    out += pick(r, [
      () => box(10 + Math.floor(r() * H)),
      () => inlineBlock(10 + Math.floor(r() * H)),
      () => box(Math.floor(r() * 30)),
      () =>
        `<div style="float:left;width:10px;height:${Math.floor(r() * H)}px"></div>`,
    ])();
  }
  return out;
}

const KINDS = [
  'plain',
  'plain',
  'plain',
  'block',
  'img',
  'video',
  'canvas',
  'iframe',
  'ovhidden',
  'ovauto',
  'ovscroll',
  'ovclip',
  'csize',
  'clayout',
  'cpaint',
  'cstrict',
  'ccontent',
  'cinline',
  'ib',
  'table',
  'flex',
  'flexcol',
  'grid',
  'float',
  'wmrl',
  'wmlr',
  'transform',
  'avoid',
  'multicol',
  'svg',
  'button',
  'abs',
  'sticky',
  'rel',
  'opacity',
  'cvhidden',
  'cvauto',
  'aspect',
  'before',
  'after',
] as const;

/** One item, under an id. */
function item(r: Random, H: number, id: string): string {
  const tall = pick(r, [0.2, 0.5, 0.9, 1, 1.01, 1.3, 2, 3.4]) * H;
  const h = Math.round(tall);
  const kind = pick(r, KINDS);
  const aligned = pick(r, [
    '',
    '',
    '',
    'align-self:start',
    'align-self:end',
    'align-self:center',
    'margin-top:13px',
    'padding:7px 0',
    'border-top:3px solid',
  ]);
  const style = (css: string): string => `style="${css};${aligned}"`;
  const open = (css: string, inner: string): string =>
    `<div id="${id}" ${style(css)}>${inner}</div>`;
  const held = (css: string): string => open(css, content(r, H));
  const replaced = (tag: string, css = 'display:block'): string =>
    `<${tag} id="${id}" width="30" height="${h}" ${style(css)}></${tag}>`;
  switch (kind) {
    case 'plain':
      return held('');
    case 'block':
      return open(`height:${h}px`, '');
    case 'img':
      return `<img id="${id}" src="${PNG}" width="30" height="${h}" ${style('display:block')}>`;
    case 'video':
    case 'canvas':
      return replaced(kind);
    case 'iframe':
      return replaced(kind, 'display:block;border:0');
    case 'ovhidden':
      return held(`overflow:hidden;height:${h}px`);
    case 'ovauto':
      return held(`overflow:auto;height:${h}px`);
    case 'ovscroll':
      return held(`overflow:scroll;height:${h}px`);
    case 'ovclip':
      return held(`overflow:clip;height:${h}px`);
    case 'csize':
      return held(`contain:size;height:${h}px`);
    case 'clayout':
      return held('contain:layout');
    case 'cpaint':
      return held('contain:paint');
    case 'cstrict':
      return held(`contain:strict;height:${h}px;width:30px`);
    case 'ccontent':
      return held('contain:content');
    case 'cinline':
      return held('contain:inline-size');
    case 'ib':
      return open('', inlineBlock(h));
    case 'table':
      return open(
        '',
        `<table style="border-spacing:0"><tr><td style="height:${h}px;padding:0;width:20px"></td></tr><tr><td style="height:20px;padding:0"></td></tr></table>`,
      );
    case 'flex':
      return open('display:flex', box(h, 10) + box(Math.round(h / 2), 10));
    case 'flexcol':
      return open('display:flex;flex-direction:column', box(h) + box(20));
    case 'grid':
      return open(
        'display:grid;grid-template-columns:10px 10px',
        box(h) + box(20) + box(Math.round(h / 2)),
      );
    case 'float':
      return open(
        '',
        `<div style="float:left;height:${h}px;width:20px"></div>` +
          content(r, H),
      );
    case 'wmrl':
      return open(`writing-mode:vertical-rl;height:${h}px`, box(20, 10));
    case 'wmlr':
      return open('writing-mode:vertical-lr', box(h, 10));
    case 'transform':
      return held('transform:rotate(3deg)');
    case 'avoid':
      return held('break-inside:avoid');
    case 'multicol':
      return open('columns:2;column-gap:0', box(h) + box(30));
    case 'svg':
      return `<svg id="${id}" width="20" height="${h}" ${style('display:block')}></svg>`;
    case 'button':
      return `<button id="${id}" ${style(`height:${h}px;padding:0;border:0`)}></button>`;
    case 'abs':
      return open(
        'position:relative',
        `<div style="position:absolute;top:10px;width:10px;height:${h}px"></div>` +
          content(r, H),
      );
    case 'sticky':
      return held('position:sticky;top:0');
    case 'rel':
      return held('position:relative;top:5px');
    case 'opacity':
      return held('opacity:.5');
    case 'cvhidden':
      return held(`content-visibility:hidden;height:${h}px`);
    case 'cvauto':
      return held('content-visibility:auto');
    case 'aspect':
      return open(`aspect-ratio:1/${1 + Math.floor(r() * 6)};width:30px`, '');
    case 'before':
      return held('break-before:column');
    case 'after':
      return held('break-after:column');
  }
}

/** A case: its markup, and the ids of its items. */
export function make(seed: number): { ids: string[]; html: string } {
  const r = mulberry32(seed);
  for (let i = 0; i < 5; i += 1) r();
  const H = pick(r, [60, 100, 140]);
  const n = 2 + Math.floor(r() * 5);
  const tracks = pick(r, [2, 2, 3]);
  const grid = r() < 0.8;
  const ids: string[] = [];
  let items = '';
  for (let i = 0; i < n; i += 1) {
    ids.push(`i${i}`);
    items += item(r, H, `i${i}`);
  }
  const css = grid
    ? `display:grid;grid-template-columns:repeat(${tracks},1fr)${pick(r, ['', ';gap:8px', ';align-items:start', ';grid-auto-rows:min-content', ';padding-top:9px'])}`
    : `display:flex${pick(r, ['', ';flex-wrap:wrap', ';align-items:flex-start'])}`;
  const fill = pick(r, ['auto', 'auto', 'balance']);
  const height =
    fill === 'auto'
      ? `height:${H}px`
      : pick(r, ['', `max-height:${H}px`, `height:${H}px`]);
  const lead = pick(r, [0, 0, 20, 40, Math.round(H * 0.8)]);
  return {
    ids,
    html:
      `<div id="mc" style="columns:${pick(r, [2, 3, 4])};column-gap:10px;column-fill:${fill};${height};width:400px">` +
      `${lead ? box(lead) : ''}<div id="g" style="${css}">${items}</div>${r() < 0.5 ? box(30) : ''}</div>` +
      '<div id="after" style="height:10px"></div>',
  };
}

type Rect = [number, number, number, number];
/** What a case came to, its rects from its container's corner: the grid's
 *  pieces, each item's, the block's after and the container's. */
interface Laid {
  s: number;
  g?: Rect[];
  i?: Rect[][];
  a?: Rect[];
  m?: Rect[];
  threw?: string;
  slow?: number;
}

const STYLE = 'body{margin:0;font:10px/10px monospace}';
const rounded = (r: readonly number[]): Rect =>
  r.map((v) => Math.round(v * 100) / 100) as Rect;

/** Lay the cases out with the `<Html>` of the tree at the working directory. */
async function lay(out: string, from: number, to: number): Promise<void> {
  const at = (path: string) =>
    import(pathToFileURL(join(process.cwd(), path)).href);
  const { render, view, boxOf } = await at('test/html/harness.ts');
  const { COLUMN_PIECES } = await at('src/html/layout/boxes.ts');
  const { HtmlViewNode } = await at('src/html/node.ts');
  const { cleanup } = await import('react-x11/test');
  // what `<Html>` catches and leaves a document blank for
  let threw: string | null = null;
  const fail = HtmlViewNode.prototype._fail;
  HtmlViewNode.prototype._fail = function (e: unknown, ...rest: unknown[]) {
    const stack = (e as Error)?.stack ?? String(e);
    threw ??= stack.split('\n').slice(0, 2).join(' ');
    return fail.call(this, e, ...rest);
  };
  console.error = () => {};
  console.warn = () => {};
  writeFileSync(out, '');
  let buffer = '';
  for (let s = from; s < to; s += 1) {
    threw = null;
    const { ids, html } = make(s);
    const started = performance.now();
    let laid: Laid;
    try {
      const { node } = await render(
        `<!DOCTYPE html><style>${STYLE}</style>${html}`,
        420,
      );
      const el = view(node);
      const mc = boxOf(el, 'mc');
      const rects = (id: string): Rect[] => {
        const b = boxOf(el, id);
        const pieces: {
          x: number;
          y: number;
          width: number;
          height: number;
        }[] = COLUMN_PIECES.get(b) ?? [b];
        return pieces
          .filter((p) => p.width > 0 && p.height > 0)
          .map((p) => rounded([p.x - mc.x, p.y - mc.y, p.width, p.height]));
      };
      laid = threw
        ? { s, threw }
        : {
            s,
            g: rects('g'),
            i: ids.map(rects),
            a: rects('after'),
            m: rects('mc'),
          };
    } catch (e) {
      laid = { s, threw: threw ?? `outside: ${String(e).slice(0, 120)}` };
    }
    const ms = performance.now() - started;
    if (ms > 5000) laid.slow = Math.round(ms);
    buffer += JSON.stringify(laid) + '\n';
    if (buffer.length > 60000) {
      appendFileSync(out, buffer);
      buffer = '';
    }
    await cleanup();
  }
  appendFileSync(out, buffer);
}

/** Lay them out with Chromium, two hundred to a page. */
async function inChrome(out: string, from: number, to: number): Promise<void> {
  const chrome = await Chrome.launch();
  writeFileSync(out, '');
  try {
    for (let start = from; start < to; start += 200) {
      const page = join(tmpdir(), `column-rows-${process.pid}-${start}.html`);
      let html = `<!DOCTYPE html><meta charset=utf-8><style>${STYLE}section{width:420px;position:relative;margin-bottom:5000px}</style>`;
      for (let s = start; s < Math.min(to, start + 200); s += 1) {
        const c = make(s);
        html += `<section data-s="${s}" data-i="${c.ids.join(',')}">${c.html}</section>\n`;
      }
      writeFileSync(page, html);
      const { targetId } = (await chrome.send('Target.createTarget', {
        url: pathToFileURL(page).href,
      })) as { targetId: string };
      const { sessionId } = (await chrome.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      })) as { sessionId: string };
      // the page itself, and not the blank one a target starts on
      const loaded = `location.protocol === 'file:' && document.readyState === 'complete'`;
      for (let tries = 0; ; tries += 1) {
        const { result } = (await chrome.send(
          'Runtime.evaluate',
          { expression: loaded, returnByValue: true },
          sessionId,
        )) as { result: { value: boolean } };
        if (result.value) break;
        if (tries > 300) throw new Error(`the page at ${start} did not load`);
        await new Promise((go) => setTimeout(go, 100));
      }
      const { result } = (await chrome.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const out = [];
            for (const e of document.querySelectorAll('section')) {
              const of = (id) => e.querySelector('#' + id);
              const mc = of('mc').getBoundingClientRect();
              const rects = (n) => !n ? [] : [...n.getClientRects()]
                .filter((q) => q.width > 0 && q.height > 0)
                .map((q) => [q.x - mc.x, q.y - mc.y, q.width, q.height]
                  .map((v) => Math.round(v * 100) / 100));
              out.push({ s: +e.dataset.s, g: rects(of('g')),
                i: e.dataset.i.split(',').map((id) => rects(of(id))),
                a: rects(of('after')), m: rects(of('mc')) });
            }
            return JSON.stringify(out);
          })()`,
          returnByValue: true,
        },
        sessionId,
      )) as { result: { value: string } };
      const laid = JSON.parse(result.value) as Laid[];
      const count = Math.min(to, start + 200) - start;
      if (laid.length !== count) {
        throw new Error(`${laid.length} of ${count} cases read at ${start}`);
      }
      appendFileSync(out, laid.map((c) => JSON.stringify(c) + '\n').join(''));
      await chrome.send('Target.closeTarget', { targetId });
    }
  } finally {
    await chrome.close();
  }
}

/** Hold one tree's to another's and to Chromium's, and say where the second
 *  threw, was slow, or came to match or not to. */
function judge(chrome: string, before: string, after: string): void {
  const read = (file: string): Map<number, Laid> =>
    new Map(
      readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Laid)
        .map((c) => [c.s, c]),
    );
  const near = (p?: Rect[], q?: Rect[]): boolean =>
    !!p &&
    !!q &&
    p.length === q.length &&
    p.every((r, i) => r.every((v, j) => Math.abs(v - q[i][j]) < 0.6));
  const matches = (c: Laid | undefined, want: Laid): boolean =>
    !!c &&
    !c.threw &&
    near(c.g, want.g) &&
    near(c.a, want.a) &&
    near(c.m, want.m) &&
    c.i?.length === want.i?.length &&
    c.i!.every((r, k) => near(r, want.i![k]));
  const want = read(chrome);
  const a = read(before);
  const b = read(after);
  for (const [file, laid] of [
    [before, a],
    [after, b],
  ] as const) {
    const missing = [...want.keys()].filter((s) => !laid.has(s));
    if (missing.length) {
      throw new Error(
        `${file} has not ${missing.length} of ${want.size} cases, ${missing[0]} the first`,
      );
    }
  }
  const threw = [...b.values()].filter((c) => c.threw);
  const slow = [...b.values()].filter((c) => c.slow && !a.get(c.s)?.slow);
  const plain = ({ slow: _, ...c }: Laid): string => JSON.stringify(c);
  let was = 0;
  let is = 0;
  let better = 0;
  let same = 0;
  const worse: number[] = [];
  for (const [s, c] of want) {
    const x = matches(a.get(s), c);
    const y = matches(b.get(s), c);
    if (x) was += 1;
    if (y) is += 1;
    if (x && !y) worse.push(s);
    if (!x && y) better += 1;
    const [p, q] = [a.get(s), b.get(s)];
    if (p && q && plain(p) === plain(q)) same += 1;
  }
  console.log(`${want.size} cases of Chromium's, ${a.size} and ${b.size}`);
  console.log(`match Chromium: ${was}, then ${is}`);
  console.log(
    `better ${better}, worse ${worse.length}`,
    worse.slice(0, 20).join(' '),
  );
  console.log(`laid out alike to the hundredth: ${same}`);
  console.log(
    `throw: ${[...a.values()].filter((c) => c.threw).length}, then ${threw.length}`,
    threw
      .slice(0, 5)
      .map((c) => `${c.s} ${c.threw}`)
      .join('; '),
  );
  console.log(`newly over 5 s: ${slow.length}`, slow.map((c) => c.s).join(' '));
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'judge' && rest.length === 3) {
  judge(rest[0], rest[1], rest[2]);
} else if ((mode === 'lay' || mode === 'chrome') && rest[0]) {
  const [from, to] = [Number(rest[1] ?? 0), Number(rest[2] ?? 10000)];
  await (mode === 'lay' ? lay : inChrome)(rest[0], from, to);
  process.exit(0);
} else if (mode) {
  throw new Error('lay, chrome or judge: see the head of this file');
}
