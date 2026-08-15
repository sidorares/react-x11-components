// The slice of KaTeX this package uses, and the loader that finds it.
//
// **`katex` is an `optionalDependency`, and these types are deliberately
// ours rather than the package's.** `import type … from 'katex'` would put
// the module in the type graph, and then an app that did not install it
// could not type-check against this package at all — which is the opposite
// of what "optional" means. So the surface is written out structurally, and
// the value arrives through a dynamic `import()` that is allowed to fail —
// the same call `src/desktop-calendar/ical.ts` makes about `ical.js`.
//
// What this package consumes is KaTeX's **virtual DOM** — the tree
// `__renderToDomTree` builds and a browser would lay out with CSS. The
// `__` prefix marks it "for advanced clients"; it is the documented seam
// every canvas renderer of KaTeX stands on, and the version is pinned by
// the optionalDependency range. `src/formula/layout.ts` is the CSS subset
// that turns that tree into pixel positions.
//
// The KaTeX fonts ride along: `katex/dist/fonts/*.ttf` are resolved
// through the same package and handed to ntk's font manager as bytes
// (`fonts.load`), so the glyphs drawn are the glyphs the metrics in the
// tree describe. A machine that cannot read them (no filesystem) still
// renders — ntk falls back to system fonts — just less beautifully.

/** Inline styles KaTeX writes, always in `em` (numbers serialized with the
 *  unit). Only the properties the layout pass reads are named. */
export interface KatexStyle {
  height?: string;
  width?: string;
  minWidth?: string;
  top?: string;
  verticalAlign?: string;
  marginLeft?: string;
  marginRight?: string;
  paddingLeft?: string;
  borderBottomWidth?: string;
  color?: string;
}

/**
 * One node of KaTeX's virtual DOM. The union of the shapes that occur —
 * spans, symbols, svg, path — told apart structurally: a symbol has `text`,
 * a path has `pathName`, an svg carries a `viewBox` attribute, and
 * everything else is a span.
 */
export interface KatexNode {
  classes?: string[];
  children?: KatexNode[];
  /** Extent above/below the baseline, in em of the context the node sits
   *  in (descendant size changes are already multiplied in). */
  height?: number;
  depth?: number;
  maxFontSize?: number;
  style?: KatexStyle;
  attributes?: Record<string, string>;
  // SymbolNode
  text?: string;
  italic?: number;
  skew?: number;
  /** Advance width from KaTeX's font metrics, em. The layout prefers a
   *  measurement through ntk's shaper, but this is the honest fallback —
   *  same fonts, same numbers. */
  width?: number;
  // PathNode
  pathName?: string;
  /** Runtime-generated path data (tall surds). When absent, the data is
   *  KaTeX's static table, reached through `toMarkup()`. */
  alternate?: string;
  /** Every KaTeX dom-tree node can serialize itself without a DOM. */
  toMarkup?(): string;
}

export interface KatexOptions {
  displayMode?: boolean;
  output?: 'html' | 'mathml' | 'htmlAndMathml';
  throwOnError?: boolean;
  errorColor?: string;
  macros?: Record<string, string>;
}

/** What `import('katex')` gives back, as far as this package is concerned. */
export interface KatexModule {
  __renderToDomTree(tex: string, options: KatexOptions): KatexNode;
}

/** The engine plus its fonts, resolved once per process. */
export interface KatexEngine {
  katex: KatexModule;
  /** `KaTeX_Main-Regular.ttf` → font bytes. `null` when the files could
   *  not be read — an ordinary state (no filesystem), not an error. */
  fonts: ReadonlyMap<string, Uint8Array> | null;
}

/** The faces `layout.ts` can name — every family the class table maps to. */
const FONT_FILES = [
  'KaTeX_AMS-Regular.ttf',
  'KaTeX_Caligraphic-Bold.ttf',
  'KaTeX_Caligraphic-Regular.ttf',
  'KaTeX_Fraktur-Bold.ttf',
  'KaTeX_Fraktur-Regular.ttf',
  'KaTeX_Main-Bold.ttf',
  'KaTeX_Main-BoldItalic.ttf',
  'KaTeX_Main-Italic.ttf',
  'KaTeX_Main-Regular.ttf',
  'KaTeX_Math-BoldItalic.ttf',
  'KaTeX_Math-Italic.ttf',
  'KaTeX_SansSerif-Bold.ttf',
  'KaTeX_SansSerif-Italic.ttf',
  'KaTeX_SansSerif-Regular.ttf',
  'KaTeX_Script-Regular.ttf',
  'KaTeX_Size1-Regular.ttf',
  'KaTeX_Size2-Regular.ttf',
  'KaTeX_Size3-Regular.ttf',
  'KaTeX_Size4-Regular.ttf',
  'KaTeX_Typewriter-Regular.ttf',
];

/** The face a file name describes, for `fonts.load`'s override options —
 *  KaTeX's italic faces mark themselves only in the subfamily name, so
 *  saying it explicitly beats trusting detection. */
export function faceOf(file: string): {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
} {
  const m = /^(.+?)-(\w+)\.ttf$/.exec(file);
  const family = m ? m[1] : file;
  const variant = m ? m[2] : 'Regular';
  return {
    family,
    weight: /Bold/.test(variant) ? 700 : 400,
    style: /Italic/.test(variant) ? 'italic' : 'normal',
  };
}

interface FsLike {
  readFile(path: string): Promise<Uint8Array>;
}

/** `import.meta.resolve` is optional in the field (bundlers, older nodes),
 *  so it is reached structurally and its absence means "no font files". */
function resolveUrl(specifier: string): string | null {
  const meta = import.meta as { resolve?: (s: string) => string };
  if (typeof meta.resolve !== 'function') return null;
  try {
    return meta.resolve(specifier);
  } catch {
    return null;
  }
}

/** file:// URL → path, without importing `node:url` (posix only, which is
 *  what an X11 toolkit runs on). */
function pathOfFileUrl(url: string): string | null {
  if (!url.startsWith('file://')) return null;
  return decodeURIComponent(url.slice('file://'.length));
}

async function readFonts(): Promise<ReadonlyMap<string, Uint8Array> | null> {
  let fs: FsLike;
  try {
    // The specifier is built at run time so a bundler treats this as a
    // genuinely optional import — same shape as `src/embed/host.ts`.
    const specifier = 'node:fs/promises';
    fs = (await import(/* @vite-ignore */ specifier)) as unknown as FsLike;
  } catch {
    return null;
  }
  const fonts = new Map<string, Uint8Array>();
  for (const file of FONT_FILES) {
    const url = resolveUrl(`katex/dist/fonts/${file}`);
    const path = url ? pathOfFileUrl(url) : null;
    if (!path) return fonts.size ? fonts : null;
    try {
      fonts.set(file, await fs.readFile(path));
    } catch {
      // a partial set still helps; whatever is missing falls back
    }
  }
  return fonts.size ? fonts : null;
}

let cached: Promise<KatexEngine> | null = null;

/**
 * Load KaTeX and its fonts, once. Deliberately **not** cached as a
 * rejection: a failed load is almost always "not installed", but retrying
 * costs nothing and a cached rejection would outlive an app that installed
 * it and re-rendered.
 */
export function loadKatex(): Promise<KatexEngine> {
  if (cached) return cached;
  const attempt = (async (): Promise<KatexEngine> => {
    const name = 'katex';
    const mod = (await import(/* @vite-ignore */ name)) as {
      default?: KatexModule;
    } & KatexModule;
    const katex =
      typeof mod.__renderToDomTree === 'function' ? mod : mod.default;
    if (!katex || typeof katex.__renderToDomTree !== 'function') {
      throw new TypeError('katex did not export what was expected');
    }
    return { katex, fonts: await readFonts() };
  })();
  cached = attempt.catch((err: unknown) => {
    cached = null;
    throw err;
  });
  return cached;
}
