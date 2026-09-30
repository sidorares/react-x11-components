// One shard of the web-platform-tests reftest run for <Html>: each test and
// its reference rendered through the component in react-x11's in-process X
// server, the 800×600 viewport read back, and the two compared pixel for
// pixel, as WPT's own runner compares a browser's screenshots.
//
//   node --import tsx scripts/conformance/wpt.tsx <wpt root> <list> <out.jsonl>
//
// <list> is a file of test paths relative to the WPT root, one a line;
// `run.ts` writes it and shards it. One JSON line per test on <out.jsonl>.
//
// What the run adapts, and why each is fair to a static HTML renderer:
// - **Fonts are handed over as the suite's server would.** <Html> asks the
//   host for a face its `@font-face` names (`kind: 'font'`), and a test that
//   links `/fonts/ahem.css` gets Ahem's file from the checkout, as WPT's
//   server would send it; Ahem is also registered under its family name,
//   with the system faces the palette names, for a test that names it
//   without the sheet — the way an application brings its fonts.
// - **XHTML is read as HTML.** Most of the CSS 2.1 suite is `.xht`, which a
//   browser parses as XML. Two XML constructs change what an HTML parser
//   sees in a style sheet: the CDATA markers round one, which are removed,
//   and the entities outside them, which XML decodes and HTML reads raw —
//   a selector written `div &gt; span` is a `>` to a browser — so they are
//   decoded first. A third is in the markup: XML closes a `<div/>`, which
//   HTML's parser opens, so each element but a void one written that way
//   is written out closed.
// - **The palette is a browser's**: black text on white, links #0000ee, a
//   16px serif. The rest of the user-agent sheet is <Html>'s own — themed
//   rules for `blockquote` and `pre` included — and costs what it costs.
// - **Nothing runs.** A test with a script — a `<script>`, or a handler
//   such as `onload` on an element — is recorded as `script` and not
//   rendered: the component never executes one, by design.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import React from 'react';
import { createRoot, loadFont, ThemeProvider } from 'react-x11';
import { WindowNode } from 'react-x11/node';
import { act, renderX11 } from 'react-x11/test';
import type { RenderX11Result } from 'react-x11/test';

import { Html } from '../../src/html/index.js';
import type { ResourceRequest, ResourceResult } from '../../src/html/index.js';

const h = React.createElement;

export const WIDTH = 800;
export const HEIGHT = 600;
/** `WPT_BACKEND=cocoa` renders into a real window through core's native
 *  macOS backend; the default is X11, headless. */
const BACKEND = process.env.WPT_BACKEND === 'cocoa' ? 'cocoa' : 'x11';

const [wptRoot, listFile, outFile] = process.argv.slice(2);
if (!wptRoot || !listFile || !outFile) {
  console.error('usage: wpt.tsx <wpt root> <list> <out.jsonl>');
  process.exit(2);
}
const ROOT = resolve(wptRoot);

// The families the suite names, as files on this machine. Every generic a
// test can fall back to has one, so no layout asks fontconfig anything.
const MAC = '/System/Library/Fonts/Supplemental';
const FONTS: Record<string, string> = {
  serif: `${MAC}/Times New Roman.ttf`,
  'sans-serif': `${MAC}/Arial.ttf`,
  monospace: `${MAC}/Courier New.ttf`,
  cursive: `${MAC}/Comic Sans MS.ttf`,
  fantasy: `${MAC}/Impact.ttf`,
  'Times New Roman': `${MAC}/Times New Roman.ttf`,
  Times: `${MAC}/Times New Roman.ttf`,
  Arial: `${MAC}/Arial.ttf`,
  Helvetica: `${MAC}/Arial.ttf`,
  Verdana: `${MAC}/Verdana.ttf`,
  'Courier New': `${MAC}/Courier New.ttf`,
  Courier: `${MAC}/Courier New.ttf`,
  Georgia: `${MAC}/Georgia.ttf`,
  Ahem: join(ROOT, 'fonts/Ahem.ttf'),
};
for (const [family, file] of Object.entries(FONTS)) {
  if (!existsSync(file)) {
    console.error(`no font for ${family}: ${file}`);
    process.exit(2);
  }
}

const PALETTE = {
  text: '#000000',
  accent: '#0000ee',
  background: '#ffffff',
  surface: '#ffffff',
  border: '#808080',
  textMuted: '#000000',
};

export interface Outcome {
  test: string;
  ref?: string;
  kind?: 'match' | 'mismatch';
  result:
    | 'pass'
    | 'pass-blank'
    | 'fail'
    | 'fail-blank'
    | 'script'
    | 'no-ref'
    | 'error';
  diff?: number;
  maxDiff?: number;
  allowed?: { maxDifference: number; totalPixels: number };
  ms?: number;
  error?: string;
}

/** A test's references: `<link rel=match|mismatch href>`. */
function referencesOf(
  source: string,
): Array<{ kind: 'match' | 'mismatch'; href: string }> {
  const out: Array<{ kind: 'match' | 'mismatch'; href: string }> = [];
  for (const tag of source.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?(match|mismatch)\b/i.exec(tag);
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (rel && href) {
      out.push({
        kind: rel[1].toLowerCase() as 'match' | 'mismatch',
        href: href[1].trim(),
      });
    }
  }
  return out;
}

/** `<meta name=fuzzy content="maxDifference=a-b;totalPixels=c-d">`, the
 *  upper bounds of both; with a reference named, only for that one. */
function fuzzyOf(
  source: string,
  refName: string,
): { maxDifference: number; totalPixels: number } {
  let allowed = { maxDifference: 0, totalPixels: 0 };
  for (const tag of source.match(
    /<meta\b[^>]*name\s*=\s*["']fuzzy["'][^>]*>/gi,
  ) ?? []) {
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!content) continue;
    let spec = content;
    const named = /^([^:;=]+):(.*)$/.exec(content);
    if (named && !/=/.test(named[1])) {
      if (!refName.endsWith(named[1].trim())) continue;
      spec = named[2];
    }
    const parts = spec.split(';').map((p) => p.trim());
    const upper = (s: string | undefined) => {
      const m = /(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(s ?? '');
      return m ? Number(m[2] ?? m[1]) : 0;
    };
    const byName = (name: string, index: number) =>
      parts.find((p) => p.startsWith(name + '=')) ?? parts[index];
    allowed = {
      maxDifference: upper(byName('maxDifference', 0)?.replace(/^.*=/, '')),
      totalPixels: upper(byName('totalPixels', 1)?.replace(/^.*=/, '')),
    };
  }
  return allowed;
}

/** A URL as a document wrote it, against the document's own path. */
function fileFor(url: string, docPath: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  const clean = url.split('#')[0].split('?')[0];
  if (!clean) return null;
  const abs = clean.startsWith('/')
    ? join(ROOT, clean)
    : resolve(dirname(docPath), decodeURIComponent(clean));
  return abs.startsWith(ROOT) && existsSync(abs) ? abs : null;
}

function dataUrl(url: string): Uint8Array | string | null {
  const m = /^data:([^,]*?)(;base64)?,(.*)$/is.exec(url);
  if (!m) return null;
  const bytes = m[2]
    ? Buffer.from(m[3], 'base64')
    : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return /^text\/css/i.test(m[1]) ? bytes.toString('utf8') : bytes;
}

function resourcesFor(docPath: string) {
  return (request: ResourceRequest): ResourceResult | null => {
    const data = request.url.startsWith('data:') ? dataUrl(request.url) : null;
    if (request.kind === 'stylesheet') {
      if (typeof data === 'string') return { kind: 'stylesheet', text: data };
      const file = fileFor(request.url, docPath);
      // A sheet served as anything but CSS is not a style sheet, and a
      // browser ignores it in a document in standards mode — every one here
      // (CSS 2.1 errata, `syntax/content-type-*`). The host decides what it
      // loads, and this host is standing in for WPT's server.
      if (file && !servedAsCss(file)) return null;
      // bytes, and the charset the server would send them with: <Html>
      // decodes a stylesheet as CSS says, which is what these tests test
      return file
        ? {
            kind: 'stylesheet',
            bytes: readFileSync(file),
            charset: servedCharset(file),
          }
        : null;
    }
    // `@font-face` loads its face through the host, as a page's does: the
    // suite's `/fonts/ahem.css` names Ahem's file, and handed back as an
    // image it was refused, and every test that links it fell back to the
    // default serif where the harness would have given it Ahem
    let bytes: Uint8Array | null = null;
    if (data instanceof Uint8Array) bytes = data;
    else {
      const file = fileFor(request.url, docPath);
      if (file) bytes = readFileSync(file);
    }
    if (!bytes) return null;
    return request.kind === 'font'
      ? { kind: 'font', bytes }
      : { kind: 'image', bytes };
  };
}

/** A reference that is an empty page. */
const BLANK = 'about:blank';

/** The charset a file's `.headers` has the server send it with, as WPT's
 *  server does, or undefined. */
function servedCharset(file: string): string | undefined {
  const headers = `${file}.headers`;
  if (!existsSync(headers)) return undefined;
  const type = /^content-type:(.*)$/im.exec(readFileSync(headers, 'utf8'));
  return type ? /charset=["']?([^;"'\s]+)/i.exec(type[1])?.[1] : undefined;
}

/** The extensions WPT's server sends as something other than CSS, of the
 *  ones a test links a style sheet from. Any other is taken as CSS. */
const NOT_CSS = new Set([
  '.txt',
  '.html',
  '.htm',
  '.xht',
  '.xhtml',
  '.xml',
  '.js',
  '.png',
]);

/** Whether WPT's server would send a file as CSS: as its `.headers` says,
 *  else as its extension does. */
function servedAsCss(file: string): boolean {
  const headers = `${file}.headers`;
  if (existsSync(headers)) {
    const type = /^content-type:\s*([^;\s]+)/im.exec(
      readFileSync(headers, 'utf8'),
    );
    if (type) return type[1].toLowerCase() === 'text/css';
  }
  return !NOT_CSS.has(extname(file).toLowerCase());
}

/** A page's text and the encoding it was in, found as a browser finds it: a
 *  byte order mark, the charset it is served with, an XML declaration — or,
 *  in HTML, a `<meta>` — naming one, else UTF-8. The host decodes a page;
 *  the encoding is handed on, for the stylesheets that fall back to it. */
function pageOf(path: string): { text: string; charset: string } {
  if (path === BLANK) return { text: '', charset: 'utf-8' };
  const bytes = readFileSync(path);
  const xml = /\.xht(ml)?$/i.test(path);
  const head = bytes.subarray(0, 1024).toString('latin1');
  const bom =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? 'utf-8'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : bytes[0] === 0xff && bytes[1] === 0xfe
          ? 'utf-16le'
          : undefined;
  const declared = xml
    ? /^<\?xml[^>]*\sencoding=["']([^"']+)/.exec(head)?.[1]
    : /<meta[^>]+charset=["']?([^"'\s/>;]+)/i.exec(head)?.[1];
  for (const label of [bom, servedCharset(path), declared, 'utf-8']) {
    if (!label) continue;
    try {
      const decoder = new TextDecoder(label);
      return { text: decoder.decode(bytes), charset: decoder.encoding };
    } catch {
      // a label that names no encoding says nothing
    }
  }
  return { text: bytes.toString('utf8'), charset: 'utf-8' };
}

/** The source <Html> is handed: XHTML's style sheets as XML reads them,
 *  entities decoded outside CDATA, the CDATA markers dropped, and an
 *  element XML closes with `/>` closed. */
function sourceOf(path: string, text = pageOf(path).text): string {
  if (!/\.xht(ml)?$/i.test(path)) return text;
  return text
    .replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
      (_, open: string, body: string, close: string) =>
        open +
        body
          .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
          .map((part, i) => (i % 2 ? part : decodeXml(part)))
          .join('') +
        close,
    )
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(SELF_CLOSING, (all, name: string, attributes: string) =>
      VOID.has(name.toLowerCase()) ? all : `<${name}${attributes}></${name}>`,
    );
}

/** A start tag closed as XML closes one, `<td class="a"/>`. */
const SELF_CLOSING =
  /<([A-Za-z][\w:.-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/>/g;

/** HTML's void elements, which a `/>` closes in either syntax. */
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** XML's five entities, and character references. */
function decodeXml(text: string): string {
  return text.replace(
    /&(?:(lt|gt|amp|quot|apos)|#(\d+)|#x([0-9a-f]+));/gi,
    (
      all,
      name: string | undefined,
      dec: string | undefined,
      hex: string | undefined,
    ) => {
      if (name) return XML_ENTITIES[name.toLowerCase()] ?? all;
      const code = dec ? Number(dec) : parseInt(hex!, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    },
  );
}

const XML_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/** Whether a page's rendering depends on code: a script element, or an
 *  event handler attribute that would have run one. */
function scripted(source: string): boolean {
  return /<script\b/i.test(source) || /<[a-z][^>]*\son[a-z]+\s*=/i.test(source);
}

let serial = 0;

function tree(path: string): React.ReactElement {
  const page = pageOf(path);
  return h(
    ThemeProvider,
    { value: PALETTE, colorScheme: 'light' } as Record<string, unknown>,
    h(
      'box',
      {
        style: {
          width: WIDTH,
          height: HEIGHT,
          overflow: 'hidden',
          backgroundColor: '#ffffff',
          flexDirection: 'column',
        },
      },
      h(Html, {
        key: `${serial++}`,
        source: sourceOf(path, page.text),
        charset: page.charset,
        partial: false,
        selectable: false,
        fontSize: 16,
        fontFamily: 'serif',
        monoFamily: 'monospace',
        onResource: resourcesFor(path),
        // the viewport is the canvas, as a browser's window is
        style: { flexGrow: 1 },
      }),
    ),
  );
}

// Frames the window has painted: a read waits for one after each render,
// because on Cocoa the pump paints, not `act()`.
let frames = 0;
{
  const proto = (
    WindowNode as unknown as {
      prototype: { _flushFrame(...args: unknown[]): unknown };
    }
  ).prototype;
  const inner = proto._flushFrame;
  proto._flushFrame = function (this: unknown, ...args: unknown[]) {
    const painted = inner.apply(this, args);
    if (painted) frames += 1;
    return painted;
  };
}

interface Mounted {
  ctx: {
    getImageData(
      x: number,
      y: number,
      w: number,
      h: number,
      cb: (err: unknown, data: { data: Uint8ClampedArray }) => void,
    ): void;
  };
  /** Device pixels per logical one: what the viewport is read at. */
  scale: number;
  render(element: React.ReactElement): Promise<void>;
}

let mounted: Mounted | null = null;

/** The X11 harness: node-x11's in-process server, the fonts as files. */
async function mountX11(first: React.ReactElement): Promise<Mounted> {
  const result: RenderX11Result = await renderX11(first, {
    width: WIDTH,
    height: HEIGHT,
    fonts: FONTS,
  });
  return {
    // taken once: the harness's `ctx` getter makes a new context on every
    // read, and each subscribes to the window for good
    ctx: result.ctx as Mounted['ctx'],
    scale: 1,
    render: (element) => result.rerender(element),
  };
}

/** A real Cocoa window: CoreText's fonts by name, Ahem registered. */
async function mountCocoa(first: React.ReactElement): Promise<Mounted> {
  const root = await createRoot();
  loadFont(root.app, FONTS.Ahem, { family: 'Ahem' });
  let windowNode: { scale?: number; window: { getContext(k: '2d'): unknown } };
  const render = (element: React.ReactElement) =>
    new Promise<void>((resolve) =>
      root.render(
        h(
          'window',
          { width: WIDTH, height: HEIGHT, x: 60, y: 60, title: 'wpt' },
          element,
        ),
        // the callback is handed the <window>'s live instance, as the
        // harness's own renderX11 reads it; the declaration says nothing
        ((instance: unknown) => {
          windowNode ??= (instance as { _reactX11Node: typeof windowNode })
            ._reactX11Node;
          resolve();
        }) as () => void,
      ),
    );
  await render(first);
  return {
    ctx: windowNode!.window.getContext('2d') as Mounted['ctx'],
    scale: windowNode!.scale ?? 1,
    render,
  };
}

function readViewport(): Promise<Uint8ClampedArray> {
  const { ctx, scale } = mounted!;
  return new Promise((ok, fail) =>
    ctx.getImageData(0, 0, WIDTH * scale, HEIGHT * scale, (err, image) =>
      err ? fail(err) : ok(image.data),
    ),
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Render a document and read the viewport: after a frame has painted it,
 *  once two reads agree — an image decode or a stylesheet settles a frame
 *  or two after the first paint. */
async function shoot(path: string): Promise<Uint8ClampedArray> {
  const before = frames;
  if (!mounted) {
    mounted =
      BACKEND === 'cocoa'
        ? await mountCocoa(tree(path))
        : await mountX11(tree(path));
  } else {
    await mounted.render(tree(path));
  }
  const deadline = performance.now() + 3000;
  while (frames === before && performance.now() < deadline) {
    if (BACKEND === 'x11') await act();
    else await wait(4);
  }
  let last = await readViewport();
  for (let i = 0; i < 8; i++) {
    await wait(i < 2 ? 8 : 30);
    if (BACKEND === 'x11') await act();
    const next = await readViewport();
    if (sameBytes(last, next)) return next;
    last = next;
  }
  return last;
}

function sameBytes(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Pixels that differ at all, and the largest channel difference among
 *  them: the two numbers a fuzzy annotation bounds. */
function compare(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
): { diff: number; maxDiff: number } {
  let diff = 0;
  let maxDiff = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(
      Math.abs(a[i] - b[i]),
      Math.abs(a[i + 1] - b[i + 1]),
      Math.abs(a[i + 2] - b[i + 2]),
    );
    if (d > maxDiff) maxDiff = d;
    if (d > 0) diff++;
  }
  return { diff, maxDiff };
}

/** One colour across the whole viewport. */
function blank(a: Uint8ClampedArray): boolean {
  for (let i = 4; i < a.length; i += 4) {
    if (a[i] !== a[0] || a[i + 1] !== a[1] || a[i + 2] !== a[2]) return false;
  }
  return true;
}

const refShots = new Map<string, Uint8ClampedArray>();

/** WPT_SHOTS=<dir>: the test's and the reference's viewport, side by side
 *  with their difference in red, as one PNG per test. */
async function saveShots(
  test: string,
  shot: Uint8ClampedArray,
  refShot: Uint8ClampedArray,
): Promise<void> {
  // pngjs comes with the dependencies and without declarations; a specifier
  // the compiler does not resolve keeps it out of the type check
  const pngjs = 'pngjs';
  const { PNG } = (await import(pngjs)) as {
    PNG: {
      new (o: { width: number; height: number }): { data: Buffer };
      sync: { write(png: unknown): Buffer };
    };
  };
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const scale = mounted?.scale ?? 1;
  const w = WIDTH * scale;
  const hgt = HEIGHT * scale;
  const png = new PNG({ width: w * 3, height: hgt });
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const same =
        shot[i] === refShot[i] &&
        shot[i + 1] === refShot[i + 1] &&
        shot[i + 2] === refShot[i + 2];
      for (let panel = 0; panel < 3; panel++) {
        const o = (y * w * 3 + panel * w + x) * 4;
        const src = panel === 0 ? shot : refShot;
        png.data[o] = panel < 2 ? src[i] : 255;
        png.data[o + 1] = panel < 2 ? src[i + 1] : same ? 255 : 0;
        png.data[o + 2] = panel < 2 ? src[i + 2] : same ? 255 : 0;
        png.data[o + 3] = 255;
      }
    }
  }
  const dir = process.env.WPT_SHOTS!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, test.replace(/[\\/]/g, '__') + '.png'),
    PNG.sync.write(png),
  );
}

async function run(test: string): Promise<Outcome> {
  const path = join(ROOT, test);
  const source = readFileSync(path, 'utf8');
  const refs = referencesOf(source);
  if (refs.length === 0) return { test, result: 'no-ref' };
  // References a test names side by side are alternatives, as WPT's own
  // runner walks them: the test passes on the first it answers — a test
  // whose right rendering depends on the font's x-height names one for
  // each.
  let first: Outcome | null = null;
  let shot: Uint8ClampedArray | null = null;
  const shotOf = async () => (shot ??= await shoot(path));
  for (const reference of refs) {
    const outcome = await against(test, path, source, reference, shotOf);
    if (outcome.result === 'pass' || outcome.result === 'pass-blank') {
      return outcome;
    }
    first ??= outcome;
    if (outcome.result !== 'fail' && outcome.result !== 'fail-blank') break;
  }
  return first!;
}

async function against(
  test: string,
  path: string,
  source: string,
  { kind, href }: { kind: 'match' | 'mismatch'; href: string },
  shotOf: () => Promise<Uint8ClampedArray>,
): Promise<Outcome> {
  const refPath =
    href === BLANK
      ? BLANK
      : href.startsWith('/')
        ? join(ROOT, href)
        : resolve(dirname(path), href);
  const ref = refPath === BLANK ? BLANK : refPath.slice(ROOT.length + 1);
  if (refPath !== BLANK && !existsSync(refPath)) {
    return { test, ref, kind, result: 'error', error: 'reference missing' };
  }
  const refSource = sourceOf(refPath);
  if (scripted(source) || scripted(refSource)) {
    return { test, ref, kind, result: 'script' };
  }
  const started = performance.now();
  const shot = await shotOf();
  let refShot = refShots.get(refPath);
  if (!refShot) {
    refShot = await shoot(refPath);
    refShots.set(refPath, refShot);
  }
  if (process.env.WPT_SHOTS) await saveShots(test, shot, refShot);
  const allowed = fuzzyOf(source, href);
  const { diff, maxDiff } = compare(shot, refShot);
  // WPT's rule: every pixel within the difference, and no more pixels
  // differing than the count — a pixel far out is a failure however few
  // there are
  const same =
    diff === 0 ||
    (maxDiff <= allowed.maxDifference && diff <= allowed.totalPixels);
  const passed = kind === 'match' ? same : !same;
  const bothBlank = blank(refShot) && blank(shot);
  return {
    test,
    ref,
    kind,
    result: passed
      ? bothBlank
        ? 'pass-blank'
        : 'pass'
      : bothBlank
        ? 'fail-blank'
        : 'fail',
    diff,
    maxDiff,
    allowed: allowed.maxDifference || allowed.totalPixels ? allowed : undefined,
    ms: Math.round(performance.now() - started),
  };
}

const tests = readFileSync(listFile, 'utf8').split('\n').filter(Boolean);
for (const test of tests) {
  let outcome: Outcome;
  try {
    outcome = await run(test);
  } catch (err) {
    outcome = {
      test,
      result: 'error',
      error: String((err as Error)?.stack ?? err).slice(0, 400),
    };
  }
  appendFileSync(outFile, JSON.stringify(outcome) + '\n');
}
process.exit(0);
