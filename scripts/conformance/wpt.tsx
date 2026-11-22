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
// - **A document is read as what WPT's server would serve it as.** `.xht`,
//   `.xhtml`, `.svg` and `.xml` are XML, so <Html> is handed the type and
//   reads them by XML's rules, with nothing rewritten first.
// - **The palette is a browser's**: black text on white, links #0000ee, a
//   16px serif. The rest of the user-agent sheet is <Html>'s own — themed
//   rules for `blockquote` and `pre` included — and costs what it costs.
// - **Nothing runs.** A test with a script — a `<script>`, or a handler
//   such as `onload` on an element — is recorded as `script` and not
//   rendered: the component never executes one, by design.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import React from 'react';
import { createRoot, loadFont, ThemeProvider } from 'react-x11';
import { WindowNode } from 'react-x11/node';
import { act, cleanup, renderX11 } from 'react-x11/test';
import type { RenderX11Result } from 'react-x11/test';

import { Html } from '../../src/html/index.js';
import type {
  EmbeddedRect,
  ResourceRequest,
  ResourceResult,
} from '../../src/html/index.js';
import { HtmlViewNode } from '../../src/html/node.js';
import { checkVersions } from './versions.js';

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
checkVersions();
const ROOT = resolve(wptRoot);

// Where each file is served from, as WPT's server serves the checkout: the
// document's `baseUrl`, so `<Html>` resolves what a page names as a browser
// does — a stylesheet's `url()`s against the stylesheet, which a font
// stylesheet under `/fonts/` names its files relative to. Handed none,
// `<Html>` passes each URL on as written, and a relative one was found
// against the document's directory: `baseline-diagnostic-font.css` named
// `./BaselineDiagnostic.ttf`, which no test's directory has, and every test
// linking it was measured in the default serif.
const ORIGIN = 'http://web-platform.test:8000';

/** The URL a file of the checkout is served at. */
function urlOf(file: string): string {
  return `${ORIGIN}/${encodeURI(relative(ROOT, file).split(sep).join('/'))}`;
}

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
  /** URLs of a network scheme off the checkout's origin, and paths outside
   *  the checkout, that the test or its reference asked for, each answered
   *  with nothing (`resourcesFor`, `inCheckout`). */
  outside?: string[];
}

/** A test's references: `<link rel=match|mismatch href>`, under a prefix
 *  in a drawing, `<html:link>`. */
function referencesOf(
  source: string,
): Array<{ kind: 'match' | 'mismatch'; href: string }> {
  const out: Array<{ kind: 'match' | 'mismatch'; href: string }> = [];
  for (const tag of source.match(/<(?:[\w.-]+:)?link\b[^>]*>/gi) ?? []) {
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
    /<(?:[\w.-]+:)?meta\b[^>]*name\s*=\s*["']fuzzy["'][^>]*>/gi,
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

/** A path of the checkout, and one there is a file at, or null: the
 *  checkout itself or something in it. A sibling whose name starts as the
 *  checkout's does is neither. */
function inCheckout(abs: string): string | null {
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) {
    outside.push(abs);
    return null;
  }
  return existsSync(abs) ? abs : null;
}

/** A URL's path with its escapes read, or null where one is malformed. */
function decoded(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/** A URL as a document wrote it, against the document's own path. */
function fileFor(url: string, docPath: string): string | null {
  // what `<Html>` resolved against a `baseUrl` (`urlOf`), and nothing else
  // of that origin's or any other
  if (url.startsWith(`${ORIGIN}/`)) {
    const path = decoded(url.slice(ORIGIN.length).split('#')[0].split('?')[0]);
    return path === null ? null : inCheckout(join(ROOT, path));
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  const clean = url.split('#')[0].split('?')[0];
  if (!clean) return null;
  if (clean.startsWith('/')) return inCheckout(join(ROOT, clean));
  const path = decoded(clean);
  return path === null ? null : inCheckout(resolve(dirname(docPath), path));
}

/** The file a test's `<link rel=match>` names, as it wrote it, where it is
 *  one of the checkout's. */
function referenceFile(href: string, path: string): string | null {
  return inCheckout(
    href.startsWith('/') ? join(ROOT, href) : resolve(dirname(path), href),
  );
}

/** The bytes of a URL's text, as the URL standard percent-decodes it: a `%`
 *  with no two hexadecimal digits after it is a `%`, as in an SVG's
 *  `width='100%'` written straight into a `data:` URL, which every browser
 *  draws and `decodeURIComponent` throws for. */
function percentDecoded(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  const out = Buffer.alloc(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const pair =
      bytes[i] === 0x25 ? bytes.toString('latin1', i + 1, i + 3) : '';
    if (/^[0-9a-f]{2}$/i.test(pair)) {
      out[n++] = parseInt(pair, 16);
      i += 2;
    } else out[n++] = bytes[i];
  }
  return out.subarray(0, n);
}

function dataUrl(url: string): Uint8Array | string | null {
  const m = /^data:([^,]*?)(;base64)?,(.*)$/is.exec(url);
  if (!m) return null;
  const body = percentDecoded(m[3]);
  const bytes = m[2] ? Buffer.from(body.toString('latin1'), 'base64') : body;
  return /^text\/css/i.test(m[1]) ? bytes.toString('utf8') : bytes;
}

/** What a test asked for outside the checkout: a URL of a network scheme off
 *  its origin (`ORIGIN`), or a path that is none of its own
 *  (`inCheckout`). Each is answered with nothing, and noted on the test's
 *  outcome (`outside`), so a run can show that nothing was reached for. */
let outside: string[] = [];

function resourcesFor(docPath: string) {
  return (request: ResourceRequest): ResourceResult | null => {
    if (
      /^(?:https?|wss?|ftp):/i.test(request.url) &&
      !request.url.startsWith(`${ORIGIN}/`)
    ) {
      outside.push(request.url);
    }
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
      // a page where an image was asked for is a document, which an
      // `<object>` or an `<embed>` shows as a frame and not as its fallback,
      // as `HtmlNetwork` answers one (`renderEmbedded` draws it)
      if (
        file &&
        request.kind === 'image' &&
        (/\.(?:html?|xht|xhtml|xml)$/i.test(file) ||
          existsSync(`${file}.headers`))
      ) {
        const type = servedType(file);
        if (
          type === 'text/html' ||
          type === 'application/xhtml+xml' ||
          (type.endsWith('xml') && type !== 'image/svg+xml')
        ) {
          return { kind: 'document' };
        }
      }
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
  const xml = servedType(path) !== 'text/html';
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

/** The type WPT's server sends a document with: as its `.headers` says, else
 *  as its extension does (`tools/serve`'s table, the ones a document has). */
function servedType(file: string): string {
  const headers = `${file}.headers`;
  if (existsSync(headers)) {
    const type = /^content-type:\s*([^;\s]+)/im.exec(
      readFileSync(headers, 'utf8'),
    );
    if (type) return type[1].toLowerCase();
  }
  return DOCUMENT_TYPES[extname(file).toLowerCase()] ?? 'text/html';
}

const DOCUMENT_TYPES: Record<string, string> = {
  '.xht': 'application/xhtml+xml',
  '.xhtml': 'application/xhtml+xml',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
};

/** Whether a page's rendering depends on code: a script element, or an
 *  event handler attribute that would have run one. */
function scripted(source: string): boolean {
  return (
    /<(?:[\w.-]+:)?script\b/i.test(source) ||
    /<[a-z][^>]*\son[a-z]+\s*=/i.test(source)
  );
}

let serial = 0;

/** Whether the page being shot has told its `load`: everything it asked
 *  for has arrived or failed, its images decoded. An image of 8 KB or more
 *  decodes on a worker thread, which outlasts a few quiet frames, and a
 *  shot taken before it showed the image's empty box on both sides of a
 *  test — a pass of nothing, or a fail of a reference with no image. */
let loaded = false;

/** A file a frame shows as an image document. */
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

/** How deep frames in frames are drawn: past it, an empty box. */
const FRAME_DEPTH = 4;

/**
 * What the runner shows in a document's `<iframe>`, `<object>` and
 * `<embed>`: another `<Html>` with the file it names, resolved against the
 * document that names it, or its `srcdoc`, as WPT's server would serve
 * them. `<Html>` loads and draws nothing for one itself (`renderEmbedded`),
 * so the 55 or so reftests that put a document in a frame drew an empty box
 * on one side. A `<canvas>` and a frame of no file stay empty, as before.
 */
function embeddedFor(path: string, depth: number) {
  return (rect: EmbeddedRect): React.ReactNode => {
    if (rect.kind === 'canvas' || depth >= FRAME_DEPTH) return null;
    const attribs = rect.element.attribs;
    const srcdoc = rect.kind === 'iframe' ? attribs.srcdoc : undefined;
    const src = rect.kind === 'object' ? attribs.data : attribs.src;
    const file = srcdoc === undefined && src ? fileFor(src, path) : null;
    if (srcdoc === undefined && !file) return null;
    // a frame of an image is an image document, as a browser makes one:
    // the image alone, at its size, its EXIF orientation applied (WPT's
    // image-orientation-none-image-document)
    const image = file !== null && IMAGE_FILE.test(file);
    const page = image
      ? {
          text:
            '<!DOCTYPE html><body style="margin:0">' +
            `<img src="${encodeURI(basename(file))}" style="display:block"></body>`,
          charset: 'utf-8',
        }
      : file
        ? pageOf(file)
        : { text: srcdoc!, charset: 'utf-8' };
    // a frame's document is resolved against its own file, or, as srcdoc,
    // against the document around it
    const base = file ?? path;
    return h(Html, {
      source: page.text,
      contentType: file && !image ? servedType(file) : 'text/html',
      charset: page.charset,
      partial: false,
      selectable: false,
      fontSize: 16,
      fontFamily: 'serif',
      monoFamily: 'monospace',
      baseUrl: urlOf(file ?? path),
      onResource: resourcesFor(base),
      renderEmbedded: embeddedFor(base, depth + 1),
      style: { flexGrow: 1 },
    });
  };
}

function tree(path: string): React.ReactElement {
  const page = pageOf(path);
  loaded = false;
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
        source: page.text,
        contentType: servedType(path),
        charset: page.charset,
        partial: false,
        selectable: false,
        fontSize: 16,
        fontFamily: 'serif',
        monoFamily: 'monospace',
        baseUrl: urlOf(path),
        onResource: resourcesFor(path),
        renderEmbedded: embeddedFor(path, 0),
        onLoaded: () => {
          loaded = true;
        },
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

/** What `<Html>` could not lay out or paint of the page being shot: it
 *  leaves the document blank and says so once, on the console. */
let failure: string | null = null;

/** Whether the page shot before this one failed. */
let failedLast = false;
{
  const proto = HtmlViewNode.prototype as unknown as {
    _fail(error: unknown, ...more: unknown[]): void;
  };
  const inner = proto._fail;
  proto._fail = function (error, ...more) {
    failure ??= String((error as Error)?.stack ?? error);
    return inner.call(this, error, ...more);
  };
}

/** The shots `<Html>` failed in, with what it threw. A page left blank, or
 *  half drawn, is no rendering of it, whatever the other side drew: a test
 *  and a reference that both threw were alike, and a pass. */
const FAILURES = new WeakMap<Uint8ClampedArray, string>();

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
  dispose(): Promise<void>;
}

let mounted: Mounted | null = null;

/** The X11 harness: node-x11's in-process server, the fonts as files. */
async function mountX11(first: React.ReactElement): Promise<Mounted> {
  const result: RenderX11Result = await renderX11(h('box'), {
    width: WIDTH,
    height: HEIGHT,
    fonts: FONTS,
  });
  // One mount serves every page of a shard. A face a page registers stays
  // in the font manager, under a name of the page's own (`src/html/fonts.ts`),
  // and since ntk 8.29.2 a fallback takes a registered face only where the
  // family list names it, so no later page draws a glyph from it.
  await result.rerender(first);
  return {
    // taken once: the harness's `ctx` getter makes a new context on every
    // read, and each subscribes to the window for good
    ctx: result.ctx as Mounted['ctx'],
    scale: 1,
    render: (element) => result.rerender(element),
    dispose: () => cleanup(),
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
    dispose: async () => root.unmount(),
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
  failedLast = failure !== null;
  failure = null;
  const shot = await drawn(path);
  if (failure) FAILURES.set(shot, failure);
  return shot;
}

async function drawn(path: string): Promise<Uint8ClampedArray> {
  const before = frames;
  // A page `<Html>` failed on may have left its clip on the window's picture
  // (ntk's glyph draw takes it off again only where it did not throw), and
  // every later page of the shard would be drawn inside it.
  if (mounted && failedLast) {
    await mounted.dispose();
    mounted = null;
  }
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
  // and its `load`, which waits for its images to decode
  const loading = performance.now() + 5000;
  while (!loaded && performance.now() < loading) {
    if (BACKEND === 'x11') await act();
    await wait(4);
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
  const refPath = href === BLANK ? BLANK : referenceFile(href, path);
  if (refPath === null) {
    return {
      test,
      ref: href,
      kind,
      result: 'error',
      error: 'reference missing',
    };
  }
  const ref = refPath === BLANK ? BLANK : refPath.slice(ROOT.length + 1);
  const refSource = pageOf(refPath).text;
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
  const threw = FAILURES.get(shot) ?? FAILURES.get(refShot);
  if (threw) {
    const on = FAILURES.has(shot) ? 'the test' : 'the reference';
    return {
      test,
      ref,
      kind,
      result: 'error',
      error: `<Html> failed on ${on}: ${threw}`.slice(0, 400),
      diff,
      maxDiff,
      ms: Math.round(performance.now() - started),
    };
  }
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
  outside = [];
  try {
    outcome = await run(test);
  } catch (err) {
    outcome = {
      test,
      result: 'error',
      error: String((err as Error)?.stack ?? err).slice(0, 400),
    };
  }
  if (outside.length) outcome.outside = [...new Set(outside)];
  appendFileSync(outFile, JSON.stringify(outcome) + '\n');
}
process.exit(0);
