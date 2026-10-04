// Our side of the comparison on react-x11's native backend — the window the
// browser example opens on Windows or a Mac — where `ours.tsx` renders in
// the in-process X server. `npm run bench:zengarden -- --native`.
//
// The page goes through <Html> exactly as `ours.tsx` takes it: a scroll pane
// the viewport's size, the document in it, its resources through the
// browser example's network over the same disk cache. What changes is the
// text engine — DirectWrite or CoreText instead of ntk — and so what a
// browser on that platform sets text in:
// - **The generic families are Chrome's on the platform**: on Windows,
//   Times New Roman, Arial, Consolas, Comic Sans MS and Impact
//   (`IDS_STANDARD_FONT_FAMILY` and the rest, chrome/app/resources); on a
//   Mac the faces `ours.tsx` names.
// - **On a Mac, a face's line metrics are Blink's**, the 15% and the
//   rounding `ours.tsx` describes. Not on Windows, where DirectWrite
//   sets a line from its own metrics rather than from the face's answer:
//   <Html> hands it a line height as a multiple of the face's line, and
//   rounded here and not there that multiple came out long, 15px for 14.
//   Scaling each layout's multiple back (rounded over unrounded, for the
//   paragraph's face) was tried and measured: over designs 1–30 it
//   differed from Chrome in 2.07% of blocks and 6.4px of page height on
//   average, where DirectWrite's own line metrics differ in 1.38% and
//   4.2px. So `line-height: normal` is DirectWrite's, a fraction of a
//   pixel a line from Blink's whole pixels.
// - **Text is set at Blink's size** (`blinkSize`).
// - **A layout's families are Chrome's too.** The Windows engine resolves
//   a run's family list itself rather than through `match`, so the
//   generics are swapped in the runs as well, or `sans-serif` was Segoe UI.
//
// The window is read back as the platform shows it (`getImageData`, which
// on Windows is the window's own pixels through PrintWindow, so a window
// behind another reads the same). One window a page, on one connection.
import React from 'react';
import { ThemeProvider, createRoot } from 'react-x11';
import type { Root } from 'react-x11';

import { Html } from '../../src/html/index.js';
import type { ResourceRequest, ResourceResult } from '../../src/html/index.js';
import { resourceResult } from '../../examples/browser/network.js';
import type { Capture, Image, Rect } from './chrome.js';
import {
  blinkMetrics,
  blinkSize,
  chromeGenerics,
  elementPaths,
} from './ours.js';
import type { CachedNetwork } from './ours.js';

const h = React.createElement;

const WINDOWS = process.platform === 'win32';

/** Chrome's generic families on Windows. */
const WINDOWS_GENERICS: Record<string, string> = {
  serif: 'Times New Roman',
  'sans-serif': 'Arial',
  monospace: 'Consolas',
  cursive: 'Comic Sans MS',
  fantasy: 'Impact',
};

/** A family list with each unquoted generic Chrome's face on this
 *  platform. */
function generics(list: string): string {
  if (!WINDOWS) return chromeGenerics(list);
  let changed = false;
  const names = list.split(',').map((name) => {
    const face = WINDOWS_GENERICS[name.trim().toLowerCase()];
    if (!face) return name;
    changed = true;
    return face;
  });
  return changed ? names.join(',') : list;
}

const blink = WINDOWS ? (face: unknown) => face : blinkMetrics;

/** The palette `ours.tsx` renders under: a browser's. */
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

interface FontManagerLike {
  match(family?: string, opts?: unknown): unknown;
  fallbackFor?(codepoint: number, family?: string, opts?: unknown): unknown;
  layout(content: unknown, style: unknown, options: unknown): unknown;
}

/** A run, or a layout's base style, at Blink's size and in Chrome's
 *  generic families. */
function asChrome<T>(run: T): T {
  const r = run as { size?: unknown; family?: unknown } | null;
  if (!r) return run;
  const size = typeof r.size === 'number' ? blinkSize(r.size) : r.size;
  const family = typeof r.family === 'string' ? generics(r.family) : r.family;
  return size === r.size && family === r.family
    ? run
    : { ...run, size, family };
}

interface NodeLike {
  kind?: string;
  abs: Rect;
  parent?: NodeLike | null;
  children?: NodeLike[];
  scale?: number;
  window?: { getContext(): ContextLike } | null;
}
interface ContextLike {
  getImageData(
    x: number,
    y: number,
    w: number,
    h: number,
    cb: (
      err: unknown,
      image: { data: Uint8ClampedArray; width: number; height: number },
    ) => void,
  ): void;
}
interface HtmlViewLike extends NodeLike {
  document: unknown;
  elementRect(element: unknown): Rect | null;
}
interface PaneLike extends NodeLike {
  scrollTo(y: number): void;
  scrollY: number;
}

let shared: Root | null = null;

/** The connection every page's window is opened on, its font manager
 *  set to Chrome's families, metrics and sizes once. */
async function rootOf(): Promise<Root> {
  if (shared) return shared;
  const root = await createRoot();
  const fonts = (root.app as unknown as { fonts: FontManagerLike }).fonts;
  const match = fonts.match.bind(fonts);
  const fallbackFor = fonts.fallbackFor?.bind(fonts);
  const layout = fonts.layout.bind(fonts);
  fonts.match = (family = 'sans-serif', opts) =>
    blink(match(generics(family), opts));
  fonts.layout = (content, style, options) =>
    layout(
      Array.isArray(content) ? content.map(asChrome) : content,
      asChrome(style),
      options,
    );
  if (fallbackFor) {
    fonts.fallbackFor = (codepoint, family = 'sans-serif', opts) =>
      blink(fallbackFor(codepoint, generics(family), opts));
  }
  shared = root;
  return root;
}

/** Close the connection the pages were drawn on. */
export async function closeNative(): Promise<void> {
  const root = shared;
  shared = null;
  await root?.unmount();
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Load a page and take what the bench compares. */
export async function captureNative(
  network: CachedNetwork,
  url: string,
  {
    width,
    height,
    maxHeight,
  }: { width: number; height: number; maxHeight: number },
): Promise<Capture | null> {
  const page = await network.document(url);
  if (!page) return null;
  const root = await rootOf();
  let pending = 0;
  let lastSettled = Date.now();
  const onResource = (
    request: ResourceRequest,
  ): Promise<ResourceResult | null> => {
    if (request.kind === 'video') return Promise.resolve(null);
    const kind = request.kind;
    pending += 1;
    return network
      .resource(request.url, kind, page.url)
      .then((fetched) => (fetched ? resourceResult(fetched, kind) : null))
      .finally(() => {
        pending -= 1;
        lastSettled = Date.now();
      });
  };

  let pane: PaneLike | null = null;
  root.render(
    h(
      'window',
      { key: url, title: `zengarden ${url}`, width, height },
      h(
        ThemeProvider,
        { value: PALETTE, colorScheme: 'light' } as Record<string, unknown>,
        h(
          'box',
          {
            ref: (node: unknown) => {
              pane = node as PaneLike | null;
            },
            style: {
              width,
              height,
              overflow: 'scroll',
              flexDirection: 'column',
              backgroundColor: '#ffffff',
            },
          },
          h(Html, {
            source: page.source,
            baseUrl: page.url,
            charset: page.charset,
            partial: false,
            selectable: false,
            animate: false,
            reducedMotion: false,
            fontSize: 16,
            fontFamily: 'serif',
            monoFamily: 'monospace',
            onResource,
            style: { flexGrow: 1 },
          }),
        ),
      ),
    ),
  );
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      await wait(50);
      if (pane && pending === 0 && Date.now() - lastSettled > 400) break;
      if (Date.now() > deadline) break;
    }
    await wait(300);
    const scrolled = pane as PaneLike | null;
    if (!scrolled) throw new Error('the window never mounted');
    let top: NodeLike = scrolled;
    while (top.parent) top = top.parent;
    const view = findView(scrolled);
    if (!view) throw new Error('no <Html> element in the tree');
    const scale = top.scale ?? 1;
    const paths = elementPaths(view.document);
    const boxes = new Map<string, Rect>();
    for (const [element, path] of paths) {
      const rect = view.elementRect(element);
      if (rect) boxes.set(path, rect);
    }
    const docHeight = Math.ceil(Math.max(height, view.abs.height / scale));
    const ctx = top.window?.getContext();
    if (!ctx) throw new Error('the window has no context to read');
    const image = await readPage(
      ctx,
      scrolled,
      width,
      height,
      scale,
      Math.min(docHeight, maxHeight),
    );
    return { boxes, height: docHeight, image };
  } finally {
    root.render(null);
    await wait(100);
  }
}

function findView(node: NodeLike): HtmlViewLike | null {
  if (node.kind === 'htmlview') return node as HtmlViewLike;
  for (const child of node.children ?? []) {
    const found = findView(child);
    if (found) return found;
  }
  return null;
}

/** The page from the top, a viewport at a time, the window read back in
 *  device pixels and taken a logical pixel at a time. */
async function readPage(
  ctx: ContextLike,
  pane: PaneLike,
  width: number,
  height: number,
  scale: number,
  total: number,
): Promise<Image> {
  const out = new Uint8Array(width * total * 4);
  const dw = Math.round(width * scale);
  const dh = Math.round(height * scale);
  const read = () =>
    new Promise<{ data: Uint8ClampedArray; width: number }>((ok, fail) =>
      ctx.getImageData(0, 0, dw, dh, (err, image) =>
        err ? fail(err) : ok(image),
      ),
    );
  for (let top = 0; top < total; top += height) {
    pane.scrollTo(top);
    await wait(250);
    const at = pane.scrollY;
    const image = await read();
    for (let row = 0; row < height; row += 1) {
      const y = at + row;
      if (y < top || y >= total) continue;
      const sy = Math.min(dh - 1, Math.floor(row * scale));
      for (let x = 0; x < width; x += 1) {
        const sx = Math.min(dw - 1, Math.floor(x * scale));
        const from = (sy * image.width + sx) * 4;
        const to = (y * width + x) * 4;
        out[to] = image.data[from];
        out[to + 1] = image.data[from + 1];
        out[to + 2] = image.data[from + 2];
        out[to + 3] = 255;
      }
    }
  }
  return { width, height: total, data: out };
}
