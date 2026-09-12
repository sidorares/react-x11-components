// Labels, the text half: strings set by the platform's own text engine,
// read back as coverage, and packed into one GL texture.
//
// A `<glarea>` is stacked over every 2D thing in its window, so a label on a
// GL map has to be *in* the GL frame — there is no drawing text over it
// afterwards. The glyphs come from where every other string in the app
// comes from: `app.fonts.layout()` shapes it (CoreText on the Cocoa
// backend, ntk's own shaper on X11, font fallback and all), and the layout
// draws into an offscreen {@link Surface} whose pixels are read back. That
// is one readback per *batch* of labels, not per label, and each label is
// set once and drawn every frame after.
//
// A label is rasterized **whole**, not glyph by glyph: placement sets every
// line label on a straight stretch, so a label is one rigid piece of type —
// one textured quad, rotated as a unit — and shaping, kerning and scripts
// stay the text engine's business. What is stored is **coverage**, drawn in
// white and read from the alpha channel; colour and halo are the shader's
// (see `./shaders.ts`), so one raster serves every palette and a
// light-to-dark switch re-rasterizes nothing.
import { Surface } from 'react-x11/ntk';

/** A set string's box, in device pixels. */
export interface TextBox {
  width: number;
  height: number;
}

/** One string to set, at `size` device pixels. */
export interface TextItem {
  text: string;
  size: number;
}

/** A rasterized string: RGBA as read back, coverage in alpha, `pad`
 *  pixels of clear margin included. */
export interface TextRaster {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** What the atlas asks of a text engine. */
export interface TextEngine {
  /** The box `text` sets in, synchronously — placement needs it now. */
  measure(text: string, size: number): TextBox;
  /**
   * Rasterize as many of `items` as fit one batch. Answers per item: a
   * raster; `null` for one that can never be drawn (wider than the engine
   * can set); `undefined` for one left for the next batch.
   */
  rasterize(
    items: readonly TextItem[],
    pad: number,
  ): Promise<(TextRaster | null | undefined)[]>;
  dispose(): void;
}

/** ntk's font cache, structurally — `../labels.ts`' `FontsLike`. */
interface FontsLike {
  layout(
    content: string,
    style: Record<string, unknown>,
  ): {
    width: number;
    height: number;
    draw(ctx: unknown, x: number, y: number): void;
  };
}

interface ImageLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface ContextLike {
  getImageData(x: number, y: number, w: number, h: number): Promise<ImageLike>;
  destroy?(): void;
}

interface SurfaceLike {
  getContext(name: '2d'): ContextLike;
  clear(): void;
  destroy(): void;
}

/** The offscreen surface a batch is set on, in device pixels. A readback
 *  has to stay inside it — X answers a GetImage past a pixmap's edge with
 *  BadMatch — so a batch is whatever fits. */
const STAGING_WIDTH = 1024;
const STAGING_HEIGHT = 512;
/** Milliseconds of drawing one batch may take. A batch runs between two
 *  frames, and at 75 Hz the gap between them is a few milliseconds. */
const DRAW_BUDGET_MS = 1.5;

/** The text engine over an app's fonts and an offscreen surface. */
export class SurfaceTextEngine implements TextEngine {
  private readonly _app: unknown;
  private readonly _fonts: FontsLike;
  private readonly _family: string;
  private readonly _layouts = new Map<
    string,
    ReturnType<FontsLike['layout']>
  >();
  private _surface: SurfaceLike | null = null;
  private _ctx: ContextLike | null = null;

  constructor(app: unknown, fonts: FontsLike, family: string) {
    this._app = app;
    this._fonts = fonts;
    this._family = family;
  }

  /** The engine for the app a node belongs to, or null where there is
   *  nothing to set text with. */
  static forApp(app: unknown, family: string): SurfaceTextEngine | null {
    const fonts = (app as { fonts?: FontsLike } | null | undefined)?.fonts;
    if (!fonts || typeof fonts.layout !== 'function') return null;
    return new SurfaceTextEngine(app, fonts, family);
  }

  private _layout(text: string, size: number): ReturnType<FontsLike['layout']> {
    const key = `${size}|${text}`;
    let layout = this._layouts.get(key);
    if (!layout) {
      // Bounded like the retained renderer's shaper: cleared wholesale, and
      // what is on screen is set again once.
      if (this._layouts.size > 8000) this._layouts.clear();
      layout = this._fonts.layout(text, {
        family: this._family,
        size,
        weight: 400,
        style: 'normal',
        color: '#ffffff',
      });
      this._layouts.set(key, layout);
    }
    return layout;
  }

  measure(text: string, size: number): TextBox {
    const layout = this._layout(text, size);
    return { width: Math.ceil(layout.width), height: Math.ceil(layout.height) };
  }

  async rasterize(
    items: readonly TextItem[],
    pad: number,
  ): Promise<(TextRaster | null | undefined)[]> {
    const places: (
      { x: number; y: number; w: number; h: number } | null | undefined
    )[] = [];
    let x = 0;
    let y = 0;
    let row = 0;
    for (const item of items) {
      const box = this.measure(item.text, item.size);
      const w = box.width + pad * 2;
      const h = box.height + pad * 2;
      if (w > STAGING_WIDTH || h > STAGING_HEIGHT) {
        places.push(null);
        continue;
      }
      if (x + w > STAGING_WIDTH) {
        x = 0;
        y += row;
        row = 0;
      }
      if (y + h > STAGING_HEIGHT) {
        places.push(undefined);
        continue;
      }
      places.push({ x, y, w, h });
      x += w;
      row = Math.max(row, h);
    }
    if (!places.some((p) => p)) {
      return places.map((p) => (p === null ? null : undefined));
    }

    if (!this._surface) {
      this._surface = new Surface(this._app as never, {
        width: STAGING_WIDTH,
        height: STAGING_HEIGHT,
      }) as unknown as SurfaceLike;
      this._ctx = this._surface.getContext('2d');
    }
    const surface = this._surface;
    const ctx = this._ctx!;
    surface.clear();
    const started = now();
    // The rows drawn into: what is read back, and no more.
    let used = 0;
    items.forEach((item, i) => {
      const place = places[i];
      if (!place) return;
      // Drawing is this thread's time; past the budget the rest wait for
      // the next batch.
      if (now() - started > DRAW_BUDGET_MS) {
        places[i] = undefined;
        return;
      }
      this._layout(item.text, item.size).draw(
        ctx,
        place.x + pad,
        place.y + pad,
      );
      used = Math.max(used, place.y + place.h);
    });
    const image = await ctx.getImageData(0, 0, STAGING_WIDTH, used);
    return places.map((place) => {
      if (!place) return place;
      // Row by row, as the readback has them: a copy, not a pass over the
      // pixels, and uploaded as it is — the shader reads alpha alone.
      const rowBytes = place.w * 4;
      const pixels = new Uint8Array(rowBytes * place.h);
      for (let r = 0; r < place.h; r++) {
        const src = ((place.y + r) * image.width + place.x) * 4;
        pixels.set(image.data.subarray(src, src + rowBytes), r * rowBytes);
      }
      return { width: place.w, height: place.h, pixels };
    });
  }

  dispose(): void {
    this._ctx?.destroy?.();
    this._ctx = null;
    this._surface?.destroy();
    this._surface = null;
    this._layouts.clear();
  }
}

/** A rasterized label's place in the atlas: its whole padded raster. */
export interface AtlasEntry {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The raster, kept to upload again — after a compaction moves it, or
   *  into the texture of a new context. */
  pixels: Uint8Array;
  /** In the texture where it is now; only then is it drawn. Set by the
   *  renderer that uploads it. */
  ready: boolean;
  /** The frame it was last asked for — what a compaction keeps. */
  used: number;
}

const keyOf = (text: string, size: number): string => `${size}|${text}`;

/**
 * The widest halo a raster's margin holds, in pixels. The drawn quad sits
 * {@link quadInset} inside the margin and a halo samples up to this far
 * past the quad, so its samples stay a texel inside the raster's own clear
 * margin and never reach a neighbour's.
 */
export const haloReach = (pad: number): number =>
  Math.max(0, Math.floor((pad - 2) / 2));

export const quadInset = (pad: number): number => pad - haloReach(pad) - 1;

/** Strings a frame measures however little budget it has left, so a frame
 *  that starts late still makes progress. One: on X11 a string's first
 *  measurement can cost milliseconds, and a floor of several put a pan
 *  frame 27 ms over. */
const MIN_MEASURES = 1;
/** Strings per rasterization batch at most — a few rows of the staging
 *  surface, so the readback and the copies out of it stay small too. */
const BATCH = 32;
/** Frames an unused entry survives a compaction for. */
const KEEP_FRAMES = 120;

/**
 * Every label raster, packed into one texture's worth of shelves, with the
 * uploads the renderer owes it.
 *
 * The atlas is CPU-side and outlives any one GL context: it keeps each
 * entry's raster, so a renderer that is new — the surface was recreated —
 * uploads it again from here ({@link restart}), and asks nothing of the text
 * engine. What it holds is bounded by the texture it packs into: 16 MB for
 * the default 2048², whatever is panned past.
 *
 * **Measuring is budgeted, drawing is asynchronous, uploading is metered.**
 * Placement needs a label's box the frame it is considered, which is a
 * synchronous shaping call — tens of microseconds on the Cocoa backend, but
 * milliseconds each the first time on X11, where fonts load and glyphs
 * rasterize in JS — so a frame measures until its deadline and leaves the
 * rest for the next. A raster is asked for only once a label has won a
 * place, and arrives a batch at a time, a readback later; the renderer
 * takes a few dozen a frame into the texture, and a label fades in once its
 * raster is there.
 */
export class LabelAtlas {
  readonly size: number;
  /** Clear margin rasterized around every string, in pixels — what a halo
   *  grows into, and what keeps it from sampling a neighbour. */
  readonly pad: number;
  /** A frame's measuring ran out of budget: there is more to place. */
  starved = false;
  onChange: (() => void) | null = null;
  private _engine: TextEngine | null;
  private readonly _entries = new Map<string, AtlasEntry>();
  /** Entries the texture does not have where they are, oldest first. */
  private _uploads: AtlasEntry[] = [];
  private readonly _wanted = new Map<string, TextItem>();
  private readonly _failed = new Set<string>();
  private readonly _measured = new Map<string, TextBox>();
  private _busy = false;
  private _shelves: { y: number; height: number; x: number }[] = [];
  private _top = 0;
  private _frame = 0;
  private _deadline = Infinity;
  private _measures = 0;

  constructor(
    engine: TextEngine | null,
    options: { size?: number; pad: number },
  ) {
    this._engine = engine;
    this.size = options.size ?? 2048;
    this.pad = options.pad;
  }

  /** Strings asked for and not yet rasterized, or a batch in flight. */
  get pending(): boolean {
    return this._busy || this._wanted.size > 0;
  }

  /** Rasters waiting for the texture. */
  get uploading(): boolean {
    return this._uploads.length > 0;
  }

  get entries(): number {
    return this._entries.size;
  }

  /** A new frame, whose measuring stops at `deadline` (after one). */
  beginFrame(deadline: number): void {
    this._frame++;
    this._deadline = deadline;
    this._measures = 0;
    this.starved = false;
  }

  /** The box a string sets in, or null when this frame's budget is spent. */
  measure(text: string, size: number): TextBox | null {
    const key = keyOf(text, size);
    const hit = this._measured.get(key);
    if (hit) return hit;
    const engine = this._engine;
    if (!engine) return null;
    if (this._measures >= MIN_MEASURES && now() > this._deadline) {
      this.starved = true;
      return null;
    }
    this._measures++;
    const box = engine.measure(text, size);
    if (this._measured.size > 20000) this._measured.clear();
    this._measured.set(key, box);
    return box;
  }

  /** The string's raster, once the texture has it; null until then —
   *  asking is what gets it rasterized. */
  entry(text: string, size: number): AtlasEntry | null {
    const key = keyOf(text, size);
    const entry = this._entries.get(key);
    if (entry) {
      entry.used = this._frame;
      return entry.ready ? entry : null;
    }
    if (!this._failed.has(key) && !this._wanted.has(key)) {
      this._wanted.set(key, { text, size });
    }
    return null;
  }

  /** Start rasterizing what has been asked for, unless a batch is out. */
  pump(): void {
    const engine = this._engine;
    if (!engine || this._busy || this._wanted.size === 0) return;
    const batch: TextItem[] = [];
    for (const item of this._wanted.values()) {
      batch.push(item);
      if (batch.length >= BATCH) break;
    }
    this._busy = true;
    engine.rasterize(batch, this.pad).then(
      (rasters) => {
        this._busy = false;
        rasters.forEach((raster, i) => {
          if (raster === undefined) return;
          const key = keyOf(batch[i].text, batch[i].size);
          this._wanted.delete(key);
          if (raster === null || !this._add(key, raster)) this._failed.add(key);
        });
        this.onChange?.();
      },
      () => {
        // A readback that fails once fails every time (no surface, a
        // backend without one): stop asking, and draw no labels.
        this._busy = false;
        this._engine = null;
        this._wanted.clear();
        this.onChange?.();
      },
    );
  }

  /** Up to `max` rasters for the texture, oldest first. The renderer marks
   *  each `ready` once it is uploaded. */
  takeUploads(max: number): AtlasEntry[] {
    return this._uploads.splice(0, max);
  }

  /** The texture is new, and has none of it: everything goes up again. */
  restart(): void {
    for (const entry of this._entries.values()) entry.ready = false;
    this._uploads = [...this._entries.values()];
  }

  dispose(): void {
    this._engine?.dispose();
    this._engine = null;
  }

  private _add(key: string, raster: TextRaster): boolean {
    let place = this._allocate(raster.width, raster.height);
    if (!place) {
      this._compact();
      place = this._allocate(raster.width, raster.height);
    }
    if (!place) return false;
    const entry: AtlasEntry = {
      key,
      x: place.x,
      y: place.y,
      width: raster.width,
      height: raster.height,
      pixels: raster.pixels,
      ready: false,
      used: this._frame,
    };
    this._entries.set(key, entry);
    this._uploads.push(entry);
    return true;
  }

  /** A shelf packer: rows of one height class (rounded up to 8 pixels),
   *  filled left to right, a new row below the last when none has room. */
  private _allocate(w: number, h: number): { x: number; y: number } | null {
    if (w > this.size || h > this.size) return null;
    const height = Math.ceil(h / 8) * 8;
    for (const shelf of this._shelves) {
      if (shelf.height === height && shelf.x + w <= this.size) {
        const at = { x: shelf.x, y: shelf.y };
        shelf.x += w;
        return at;
      }
    }
    if (this._top + height > this.size) return null;
    const shelf = { y: this._top, height, x: w };
    this._shelves.push(shelf);
    this._top += height;
    return { x: 0, y: shelf.y };
  }

  /** Drop what has not been drawn for a while and pack the rest again,
   *  tallest first. Everything kept has moved, so none of it is drawn
   *  until the renderer has uploaded it where it now is. */
  private _compact(): void {
    const keep = [...this._entries.values()]
      .filter((e) => e.used >= this._frame - KEEP_FRAMES)
      .sort((a, b) => b.height - a.height);
    this._entries.clear();
    this._shelves = [];
    this._top = 0;
    this._uploads = [];
    for (const entry of keep) {
      const place = this._allocate(entry.width, entry.height);
      if (!place) continue;
      entry.x = place.x;
      entry.y = place.y;
      entry.ready = false;
      this._entries.set(entry.key, entry);
      this._uploads.push(entry);
    }
  }
}

const globals = globalThis as { performance?: { now(): number } };
const now = (): number => globals.performance?.now() ?? Date.now();
