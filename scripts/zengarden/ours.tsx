// Our side of the comparison: a page through <Html> in react-x11's
// in-process X server, laid out the way the browser example lays it out —
// a scroll pane the size of the viewport, the document in it — with its
// resources through the example's network (examples/browser/network.ts),
// the seams the browser has. A disk cache sits under the network, so a
// rerun asks the site for nothing and a page compares against the bytes it
// was first compared against.
//
// Two things are set as a browser on a Mac sets them, because neither is
// CSS and both would otherwise differ on every page:
// - **The generic families are Chrome's.** fontconfig answers `serif` and
//   `monospace` on a Mac with PT Serif and Andale Mono; Chrome sets them in
//   Times and Menlo. Each generic in a family list is the face Chrome gives
//   it, in its place — a user agent's own choice (CSS Fonts 4, 4.1.1) —
//   rewritten on the way into this app's font manager. Registering the faces
//   under the generic names would not do: ntk tries registered families
//   ahead of installed ones across the whole list, and `georgia, serif`
//   came out in Times.
// - **The palette is a browser's**: black text on white, links #0000ee, a
//   16px serif — what a page that says nothing about them is drawn in.
// - **A face's line metrics are Blink's** (`blinkMetrics`): its ascent,
//   descent and line gap each rounded to a whole pixel, and Times,
//   Helvetica and Courier given 15% more ascent, which Blink does on a Mac
//   to set them as Windows sets their Microsoft counterparts. `line-height:
//   normal` is the user agent's to choose from the font (CSS 2.1 10.8.1),
//   and these are that choice, not CSS: <Html> takes the font's own, and
//   without this every line of Times drifted two pixels from Chrome's.
// - **Text is set at Blink's size** (`blinkSize`): a font size down to the
//   hundredth of a pixel, which Blink's font cache makes a face at — 10pt
//   is 13.333px to `em` and 13.33px to its glyphs. A paragraph of 10pt
//   Trebuchet was a tenth of a pixel wider a line than Chrome's, which
//   wrapped a word that fitted Chrome's line exactly.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import React from 'react';
import { ThemeProvider } from 'react-x11';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html } from '../../src/html/index.js';
import type { ResourceRequest, ResourceResult } from '../../src/html/index.js';
import {
  mixedContent,
  Network,
  resourceResult,
} from '../../examples/browser/network.js';
import type { Fetched, ResourceKind } from '../../examples/browser/network.js';
import type { Capture, Image, Rect } from './chrome.js';

const h = React.createElement;

const PALETTE = {
  text: '#000000',
  accent: '#0000ee',
  background: '#ffffff',
  surface: '#ffffff',
  border: '#808080',
  textMuted: '#000000',
  // the size a form control's text is set at: Chrome's
  // `-webkit-small-control`, the 16px default less 2pt
  // (`LayoutThemeFontProvider::SystemFontSize`)
  fontSize: 16 - (2 / 72) * 96,
};

/** Chrome's generic families on macOS. */
const GENERICS: Record<string, string> = {
  serif: 'Times',
  monospace: 'Menlo',
  cursive: 'Apple Chancery',
  fantasy: 'Papyrus',
};

/** A family list with each unquoted generic Chrome's face; a quoted name
 *  is a family's own, whatever it spells. */
export function chromeGenerics(list: string): string {
  let changed = false;
  const names = list.split(',').map((name) => {
    const face = GENERICS[name.trim().toLowerCase()];
    if (!face) return name;
    changed = true;
    return face;
  });
  return changed ? names.join(',') : list;
}

interface FontManagerLike {
  match(family?: string, opts?: unknown): unknown;
  fallbackFor(codepoint: number, family?: string, opts?: unknown): unknown;
  layout(content: unknown, style: unknown, options: unknown): unknown;
}

/**
 * A font size as Blink sets glyphs at it: down to the hundredth of a pixel,
 * its font cache's key (`FontCacheKey`), which the face is made at. Chrome
 * measures 13.33px, 13.333px, 13.3399px and 10pt alike, and 13.34px apart.
 */
export function blinkSize(size: number): number {
  return Math.floor(size * 100 + 1e-6) / 100;
}

/** A run, or a layout's base style, at Blink's size. */
function atBlinkSize<T>(run: T): T {
  const size = (run as { size?: unknown } | null)?.size;
  if (typeof size !== 'number') return run;
  const set = blinkSize(size);
  return set === size ? run : { ...run, size: set };
}

interface Metrics {
  ascent: number;
  descent: number;
  lineGap: number;
  lineHeight: number;
}

interface FaceLike {
  fk?: { familyName?: string };
  metrics(size: number): Metrics;
}

/** The families Blink pads on a Mac (`SimpleFontData::PlatformInit`). */
const PADDED = new Set(['Times', 'Helvetica', 'Courier']);
const BLINKED = new WeakSet<object>();

/**
 * A face's line metrics as Blink on a Mac takes them: ascent, descent and
 * line gap each rounded to a whole pixel, and for Times, Helvetica and
 * Courier, 15% of the two added to the ascent. Measured against Chrome
 * over ten faces at six sizes, `line-height: normal` agreed at every one.
 */
export function blinkMetrics(face: unknown): unknown {
  const f = face as FaceLike | null;
  if (!f || typeof f.metrics !== 'function' || BLINKED.has(f)) return face;
  BLINKED.add(f);
  const own = f.metrics.bind(f);
  const padded = PADDED.has(f.fk?.familyName ?? '');
  f.metrics = (size: number) => {
    const m = own(blinkSize(size));
    let ascent = Math.round(m.ascent);
    const descent = Math.round(m.descent);
    const lineGap = Math.round(m.lineGap);
    if (padded) ascent += Math.floor((ascent + descent) * 0.15 + 0.5);
    return {
      ...m,
      ascent,
      descent,
      lineGap,
      lineHeight: ascent + descent + lineGap,
    };
  };
  return face;
}

/** The browser's network, over a cache on disk. */
export class CachedNetwork {
  private _network = new Network();
  constructor(private readonly _dir: string) {
    mkdirSync(_dir, { recursive: true });
  }

  private _paths(url: string): { meta: string; body: string } {
    const key = createHash('sha1').update(url).digest('hex');
    return {
      meta: join(this._dir, `${key}.json`),
      body: join(this._dir, `${key}.bin`),
    };
  }

  private _read(url: string): Fetched | null | undefined {
    // a local file is read fresh: it is the one a reduction is edited in
    if (/^(document:)?file:/.test(url)) return undefined;
    const { meta, body } = this._paths(url);
    if (!existsSync(meta)) return undefined;
    const head = JSON.parse(readFileSync(meta, 'utf8')) as Omit<
      Fetched,
      'bytes'
    > & { missing?: boolean };
    if (head.missing) return null;
    return { ...head, bytes: new Uint8Array(readFileSync(body)) };
  }

  private _write(url: string, fetched: Fetched | null): void {
    if (/^(document:)?file:/.test(url)) return;
    const { meta, body } = this._paths(url);
    if (!fetched) {
      writeFileSync(meta, JSON.stringify({ url, missing: true }));
      return;
    }
    const { bytes, ...head } = fetched;
    writeFileSync(body, bytes);
    writeFileSync(meta, JSON.stringify(head));
  }

  async resource(
    url: string,
    kind: ResourceKind,
    page: string,
  ): Promise<Fetched | null> {
    // the browser's policy on what a secure page may have, before the
    // cache, which answers for any page
    const allowed = mixedContent(url, kind, page);
    if (allowed === null) return null;
    if (allowed !== url) return this.resource(allowed, kind, page);
    const kept = this._read(url);
    if (kept !== undefined) return kept;
    const fetched = await this._network.resource(url, kind, page);
    this._write(url, fetched);
    return fetched;
  }

  /** A document, whole, as the example reads one: its bytes decoded in the
   *  charset the server named, or the one its head names, or UTF-8. */
  async document(
    url: string,
  ): Promise<{ source: string; url: string; charset: string } | null> {
    let kept = this._read(`document:${url}`);
    if (kept === undefined) {
      try {
        const response = await this._network.document(
          url,
          new AbortController().signal,
        );
        const chunks: Uint8Array[] = [];
        for await (const chunk of response.body) chunks.push(chunk);
        kept =
          response.status >= 200 && response.status < 300
            ? {
                url: response.url,
                status: response.status,
                type: response.type,
                charset: response.charset,
                bytes: new Uint8Array(Buffer.concat(chunks)),
              }
            : null;
      } catch {
        kept = null;
      }
      this._write(`document:${url}`, kept);
    }
    if (!kept) return null;
    const head = new TextDecoder('latin1').decode(kept.bytes.subarray(0, 1024));
    const named = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
    const charset = kept.charset ?? named?.[1]?.toLowerCase() ?? 'utf-8';
    let source: string;
    try {
      source = new TextDecoder(charset).decode(kept.bytes);
    } catch {
      source = new TextDecoder('utf-8').decode(kept.bytes);
    }
    return { source, url: kept.url, charset };
  }
}

interface HtmlViewLike {
  kind: string;
  document: unknown;
  elementRect(element: unknown): Rect | null;
  abs: Rect;
  children?: HtmlViewLike[];
}

interface PaneLike {
  scrollTo(y: number): void;
  scrollY: number;
}

interface Harness {
  app: {
    fonts: { load(file: string, opts: Record<string, unknown>): unknown };
  };
  ctx: {
    getImageData(
      x: number,
      y: number,
      w: number,
      h: number,
      cb: (err: unknown, image: { data: Uint8ClampedArray }) => void,
    ): void;
  };
  rerender(element: React.ReactElement): Promise<void>;
  windowNode: unknown;
}

/** The path `chrome.ts` gives the same element: tag names and same-tag
 *  sibling indices from the document down. */
export function elementPaths(document: unknown): Map<unknown, string> {
  const paths = new Map<unknown, string>();
  type Node = { type?: string; name?: string; children?: Node[] };
  const walk = (node: Node, path: string) => {
    const seen = new Map<string, number>();
    for (const child of node.children ?? []) {
      if (
        child.type !== 'tag' &&
        child.type !== 'script' &&
        child.type !== 'style'
      ) {
        continue;
      }
      const name = (child.name ?? '').toLowerCase();
      const k = seen.get(name) ?? 0;
      seen.set(name, k + 1);
      const own = `${path}/${name}[${k}]`;
      paths.set(child, own);
      walk(child, own);
    }
  };
  walk(document as Node, '');
  return paths;
}

/** Load a page and take what the bench compares. */
export async function capture(
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
  let pending = 0;
  let lastSettled = Date.now();
  const onResource = (
    request: ResourceRequest,
  ): Promise<ResourceResult | null> => {
    pending += 1;
    return network
      .resource(request.url, request.kind, page.url)
      .then((fetched) =>
        fetched ? resourceResult(fetched, request.kind) : null,
      )
      .finally(() => {
        pending -= 1;
        lastSettled = Date.now();
      });
  };

  let pane: PaneLike | null = null;
  const tree = (withPage: boolean) =>
    h(
      ThemeProvider,
      { value: PALETTE, colorScheme: 'light' } as Record<string, unknown>,
      h(
        'box',
        {
          style: {
            width,
            height,
            flexDirection: 'column',
            backgroundColor: '#ffffff',
          },
        },
        h(
          'box',
          {
            ref: (node: unknown) => {
              pane = node as PaneLike | null;
            },
            style: { flexGrow: 1, overflow: 'scroll', flexDirection: 'column' },
          },
          withPage
            ? h(Html, {
                source: page.source,
                baseUrl: page.url,
                charset: page.charset,
                partial: false,
                selectable: false,
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

  const result = (await renderX11(tree(false), {
    width,
    height,
  } as never)) as unknown as Harness;
  try {
    const fonts = result.app.fonts as unknown as FontManagerLike;
    const match = fonts.match.bind(fonts);
    const fallbackFor = fonts.fallbackFor.bind(fonts);
    const layout = fonts.layout.bind(fonts);
    fonts.layout = (content, style, options) =>
      layout(
        Array.isArray(content) ? content.map(atBlinkSize) : content,
        atBlinkSize(style),
        options,
      );
    fonts.match = (family = 'sans-serif', opts) =>
      blinkMetrics(match(chromeGenerics(family), opts));
    fonts.fallbackFor = (codepoint, family = 'sans-serif', opts) =>
      blinkMetrics(fallbackFor(codepoint, chromeGenerics(family), opts));
    await result.rerender(tree(true));
    // until nothing is in flight, and nothing has landed for a moment: a
    // stylesheet's @import and its fonts arrive after the sheet does
    const deadline = Date.now() + 60_000;
    for (;;) {
      await act();
      if (pending === 0 && Date.now() - lastSettled > 400) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    for (let i = 0; i < 6; i += 1) await act();

    const view = findView(result.windowNode);
    if (!view) throw new Error('no <Html> element in the tree');
    const paths = elementPaths(view.document);
    const boxes = new Map<string, Rect>();
    for (const [element, path] of paths) {
      const rect = view.elementRect(element);
      if (rect) boxes.set(path, rect);
    }
    // as tall as the pane scrolls: the document's scrollable overflow, which
    // is what Chrome's content size is — not the bottom of every box in it,
    // which takes in the text a box scrolls inside itself
    const docHeight = Math.ceil(Math.max(height, view.abs.height));
    const image = await readPage(
      result,
      pane!,
      width,
      height,
      Math.min(docHeight, maxHeight),
    );
    return { boxes, height: docHeight, image };
  } finally {
    await cleanup();
  }
}

function findView(node: unknown): HtmlViewLike | null {
  const n = node as HtmlViewLike | null;
  if (!n) return null;
  if (n.kind === 'htmlview') return n;
  for (const child of n.children ?? []) {
    const found = findView(child);
    if (found) return found;
  }
  return null;
}

/** The page from the top, a viewport at a time: the pane is scrolled and
 *  the window read back, as tall as the document or `total`. */
async function readPage(
  result: Harness,
  pane: PaneLike,
  width: number,
  height: number,
  total: number,
): Promise<Image> {
  const out = new Uint8Array(width * total * 4);
  const read = () =>
    new Promise<Uint8ClampedArray>((ok, fail) =>
      result.ctx.getImageData(0, 0, width, height, (err, image) =>
        err ? fail(err) : ok(image.data),
      ),
    );
  for (let top = 0; top < total; top += height) {
    pane.scrollTo(top);
    for (let i = 0; i < 3; i += 1) await act();
    const at = pane.scrollY;
    const data = await read();
    // rows of the page this read covers, the pane having stopped at `at`
    for (let row = 0; row < height; row += 1) {
      const y = at + row;
      if (y < top || y >= total) continue;
      for (let x = 0; x < width; x += 1) {
        const from = (row * width + x) * 4;
        const to = (y * width + x) * 4;
        out[to] = data[from];
        out[to + 1] = data[from + 1];
        out[to + 2] = data[from + 2];
        out[to + 3] = 255;
      }
    }
  }
  return { width, height: total, data: out };
}
