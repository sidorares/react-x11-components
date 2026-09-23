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
// stay the text engine's business.
//
// **One raster per string, at every size.** The engine sets a string once,
// at the atlas's `base` size, as coverage; what is stored is its signed
// distance field (`src/internal/sdf.ts`), one byte a texel. A name drawn at 11 pixels
// and the same name at 20 are one raster scaled, so a zoom ramp that grows
// the type asks for nothing new, and a halo of any width is a threshold on
// the same distances. Colour and halo are the shader's (see `./shaders.ts`),
// so one raster serves every palette and a light-to-dark switch
// re-rasterizes nothing. What it costs is the engine's hinting — the text
// is its outline, scaled — which at map-label sizes is the right trade:
// one shaping and one readback per name for the life of the atlas.
//
// An icon's two pieces (`../icons.ts`) are fields here too, drawn as
// coverage from the same paths the retained renderer fills, at the same
// base size, and coloured by the same shader.
import { Surface } from 'react-x11/ntk';

import { traceGlyph, tracePlate } from '../icons.js';
import type { IconPathContext, MapIcon } from '../icons.js';
import { SDF_EDGE, distanceField } from '../../internal/sdf.js';

/** A set string's box, in device pixels. */
export interface TextBox {
  width: number;
  height: number;
}

/** Which of an icon's two single-colour rasters. */
export type IconPart = 'plate' | 'glyph';

/** One string to set, at `size` device pixels — or, with `icon`, one piece
 *  of an icon `size` pixels across, and `text` empty. */
export interface TextItem {
  text: string;
  size: number;
  icon?: { name: MapIcon; part: IconPart };
}

/** A rasterized string, `pad` pixels of clear margin included: RGBA as
 *  read back, coverage in alpha — or, with `stride` 1, the text engine's own
 *  coverage, one byte a pixel. */
export interface TextRaster {
  width: number;
  height: number;
  pixels: Uint8Array;
  /** Bytes a pixel: 4 (the default) for a readback, 1 for coverage. */
  stride?: 1 | 4;
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
    /** The engine's own coverage of the layout, one byte a pixel, with
     *  `pad` round its box — where the engine answers it
     *  (sidorares/react-x11#673). */
    coverage?(options?: {
      pad?: number;
    }): { width: number; height: number; data: Uint8Array } | null;
  };
}

interface ImageLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface ContextLike extends Partial<IconPathContext> {
  getImageData(x: number, y: number, w: number, h: number): Promise<ImageLike>;
  destroy?(): void;
  fillStyle?: unknown;
  fill?(): void;
}

/** Whether a context can fill a path — what an icon is drawn with. */
function fills(
  ctx: ContextLike,
): ctx is ContextLike & IconPathContext & { fill(): void } {
  return (
    typeof ctx.beginPath === 'function' &&
    typeof ctx.arc === 'function' &&
    typeof ctx.fill === 'function'
  );
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
  /** Whether the layouts answer their own coverage: unknown until a string
   *  asks, and false for good once one does not. */
  private _coverage: boolean | null = null;

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

  /**
   * Strings the layouts set themselves, where the engine answers a layout's
   * coverage (react-x11#673): no staging surface and no readback. The rest —
   * icons, which are paths, and every string on an engine that cannot — go
   * through the surface.
   */
  async rasterize(
    items: readonly TextItem[],
    pad: number,
  ): Promise<(TextRaster | null | undefined)[]> {
    if (this._coverage === false) return this._stage(items, pad);
    const out: (TextRaster | null | undefined)[] = new Array(items.length);
    const rest: number[] = [];
    items.forEach((item, i) => {
      const coverage =
        !item.icon && this._coverage !== false
          ? (this._layout(item.text, item.size).coverage?.({ pad }) ?? null)
          : null;
      if (!coverage) {
        if (!item.icon && this._coverage === null) this._coverage = false;
        rest.push(i);
        return;
      }
      this._coverage = true;
      out[i] =
        coverage.width > STAGING_WIDTH || coverage.height > STAGING_HEIGHT
          ? null // wider than the surface could set: never drawn, as there
          : {
              width: coverage.width,
              height: coverage.height,
              pixels: coverage.data,
              stride: 1,
            };
    });
    if (rest.length === 0) return out;
    const staged = await this._stage(
      rest.map((i) => items[i]),
      pad,
    );
    rest.forEach((i, k) => (out[i] = staged[k]));
    return out;
  }

  private async _stage(
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
      const box = item.icon
        ? { width: Math.ceil(item.size), height: Math.ceil(item.size) }
        : this.measure(item.text, item.size);
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
      if (item.icon) {
        // White, like the strings: coverage, coloured by the shader.
        if (!fills(ctx)) {
          places[i] = null;
          return;
        }
        const half = item.size / 2;
        const cx = place.x + pad + half;
        const cy = place.y + pad + half;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        if (item.icon.part === 'plate') tracePlate(ctx, cx, cy, item.size);
        else traceGlyph(ctx, item.icon.name, cx, cy, item.size);
        ctx.fill();
      } else {
        this._layout(item.text, item.size).draw(
          ctx,
          place.x + pad,
          place.y + pad,
        );
      }
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
  /** The distance field, one byte a texel — kept to upload again, after a
   *  compaction moves it or into the texture of a new context. */
  pixels: Uint8Array;
  /** In the texture where it is now; only then is it drawn. Set by the
   *  renderer that uploads it. */
  ready: boolean;
  /** The frame it was last asked for — what a compaction keeps. */
  used: number;
}

/** A string's key: the text alone, because one field serves every size. */
const keyOf = (text: string): string => `|${text}`;
/** An icon piece's key: `#` where a string's has `|`, so no string can
 *  be taken for one. */
const iconKey = (name: MapIcon, part: IconPart): string => `#${part}:${name}`;

/**
 * Texels the drawn quad leaves off each side of a field: bilinear samples
 * at its edge then stay inside the field's own margin, never reaching the
 * shelf's unwritten rows or a neighbour.
 */
export const QUAD_INSET = 1;

/**
 * How far past the glyphs' edge a field can see, in its own texels — the
 * widest halo it holds, and the reach of its distances before they
 * saturate — for a field set with `pad` texels of margin and `pad` of
 * spread. Scale by the drawn size over the base for screen pixels.
 */
export const fieldReach = (pad: number): number =>
  Math.max(0, Math.min(pad * SDF_EDGE, pad - QUAD_INSET) - 0.5);

/** The base size a display scale sets fields at, in device pixels: 16 at
 *  1x, 32 at 2x — the size most map labels are drawn at or just under, so
 *  a field is mostly sampled down, where it is sharpest. */
export const fieldBase = (scale: number): number =>
  Math.round(16 * Math.min(2, Math.max(1, scale)));

/** A field's margin and spread at a base size: room for a halo of a
 *  quarter of the type's height. */
export const fieldPad = (base: number): number => Math.ceil(base * 0.375);

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
  /** The device-pixel size every string and icon is set at: a label drawn
   *  at `size` scales its field by `size / base`. */
  readonly base: number;
  /** The margin set around every field, in its texels, which is also the
   *  distance its values span — what a halo grows into. */
  readonly pad: number;
  /** A frame's measuring ran out of budget: there is more to place. */
  starved = false;
  onChange: (() => void) | null = null;
  private _engine: TextEngine | null;
  private readonly _entries = new Map<string, AtlasEntry>();
  /** Entries the texture does not have where they are, oldest first. */
  private _uploads: AtlasEntry[] = [];
  /** Drawable entries a compaction moved: all of them go up in the next
   *  frame, ahead of any cap, before it draws. */
  private _moved: AtlasEntry[] = [];
  private readonly _wanted = new Map<string, TextItem>();
  private readonly _failed = new Set<string>();
  /** Rasters read back and waiting for their fields, oldest first — asked
   *  for as much as anything in `_wanted`, so a frame never asks again. */
  private _fieldQueue: { key: string; raster: TextRaster }[] = [];
  private readonly _queued = new Set<string>();
  private readonly _measured = new Map<string, TextBox>();
  private _busy = false;
  private _shelves: { y: number; height: number; x: number }[] = [];
  private _top = 0;
  private _frame = 0;
  private _deadline = Infinity;
  private _measures = 0;

  constructor(
    engine: TextEngine | null,
    options: { size?: number; base?: number; pad?: number } = {},
  ) {
    this._engine = engine;
    this.size = options.size ?? 2048;
    this.base = options.base ?? fieldBase(1);
    this.pad = options.pad ?? fieldPad(this.base);
  }

  /** Strings asked for and not yet set: waiting, being read back, or
   *  waiting for their fields. */
  get pending(): boolean {
    return this._busy || this._wanted.size > 0 || this._fieldQueue.length > 0;
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

  /** The box a string sets in at `size`, or null when this frame's budget
   *  is spent. Measured once, at the base size, and scaled — the same
   *  arithmetic that scales its field, so the box placement collides and
   *  the quad the frame draws are one size. */
  measure(text: string, size: number): TextBox | null {
    const key = keyOf(text);
    let box = this._measured.get(key);
    if (!box) {
      const engine = this._engine;
      if (!engine) return null;
      if (this._measures >= MIN_MEASURES && now() > this._deadline) {
        this.starved = true;
        return null;
      }
      this._measures++;
      box = engine.measure(text, this.base);
      if (this._measured.size > 20000) this._measured.clear();
      this._measured.set(key, box);
    }
    const k = size / this.base;
    return { width: box.width * k, height: box.height * k };
  }

  /** The string's field, once the texture has it; null until then —
   *  asking is what gets it set. One field whatever size it is drawn at. */
  entry(text: string): AtlasEntry | null {
    return this._lookup(keyOf(text), text, null, 'plate');
  }

  /** One piece of an icon, as {@link entry} answers for a string. */
  icon(name: MapIcon, part: IconPart): AtlasEntry | null {
    return this._lookup(iconKey(name, part), '', name, part);
  }

  private _lookup(
    key: string,
    text: string,
    icon: MapIcon | null,
    part: IconPart,
  ): AtlasEntry | null {
    const entry = this._entries.get(key);
    if (entry) {
      entry.used = this._frame;
      return entry.ready ? entry : null;
    }
    if (
      !this._failed.has(key) &&
      !this._wanted.has(key) &&
      !this._queued.has(key)
    ) {
      const size = this.base;
      this._wanted.set(
        key,
        icon ? { text, size, icon: { name: icon, part } } : { text, size },
      );
    }
    return null;
  }

  /** Whether an icon can never be drawn — the engine has no path to fill
   *  it with. A name set beside it is then set alone. */
  iconFailed(name: MapIcon): boolean {
    return (
      this._failed.has(iconKey(name, 'plate')) ||
      this._failed.has(iconKey(name, 'glyph'))
    );
  }

  /** Start rasterizing what has been asked for, unless a batch is out. */
  pump(): void {
    const engine = this._engine;
    if (!engine || this._busy || this._wanted.size === 0) return;
    const keys: string[] = [];
    const batch: TextItem[] = [];
    for (const [key, item] of this._wanted) {
      keys.push(key);
      batch.push(item);
      if (batch.length >= BATCH) break;
    }
    this._busy = true;
    engine.rasterize(batch, this.pad).then(
      (rasters) => {
        this._busy = false;
        rasters.forEach((raster, i) => {
          if (raster === undefined) return;
          const key = keys[i];
          this._wanted.delete(key);
          // A string with no raster never will have one; a raster with no
          // room is a fact about this moment, and the string is asked for
          // again by the next frame that still shows it.
          if (raster === null) {
            this._failed.add(key);
          } else {
            this._fieldQueue.push({ key, raster });
            this._queued.add(key);
          }
        });
        // The staging surface is free again as soon as the pixels are
        // copied out, so the next batch is read back while this one waits
        // for its fields; and a frame is asked for, to make them.
        this.pump();
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

  /** Rasters for the texture: every one a compaction moved, then up to
   *  `max` new ones, oldest first. The renderer marks each `ready` once it
   *  is uploaded — a moved one already is, because the frame that takes it
   *  draws after taking it. */
  takeUploads(max: number): AtlasEntry[] {
    const moved = this._moved;
    this._moved = [];
    return moved.length > 0
      ? moved.concat(this._uploads.splice(0, max))
      : this._uploads.splice(0, max);
  }

  /** The texture is new, and has none of it: everything goes up again. */
  restart(): void {
    for (const entry of this._entries.values()) entry.ready = false;
    this._uploads = [...this._entries.values()];
    this._moved = [];
  }

  dispose(): void {
    this._engine?.dispose();
    this._engine = null;
    this._fieldQueue = [];
    this._queued.clear();
  }

  /** Read back and waiting for their fields: another frame is worth
   *  drawing, to make them. */
  get fielding(): boolean {
    return this._fieldQueue.length > 0;
  }

  /**
   * Make fields for what has been read back until `deadline` — at least
   * one — in the frame, whose own draw then takes them into the texture.
   *
   * A field is about 0.2 ms. A batch of them made as it landed was 4-9 ms
   * beside the frames, measured as event-loop stalls on a jump to a view
   * whose every name was new; slices on timers of their own each waited
   * behind a frame, and names arrived late. In the frame, on a budget,
   * they are made at a known cost and drawn the frame after.
   */
  makeFields(deadline: number): void {
    if (!this._engine) return;
    let made = 0;
    while (this._fieldQueue.length > 0 && (made === 0 || now() < deadline)) {
      const { key, raster } = this._fieldQueue.shift()!;
      this._queued.delete(key);
      this._add(key, raster.width, raster.height, this._field(raster));
      made++;
    }
  }

  /** A raster's coverage as its distance field. The coverage is the
   *  readback's alpha; the field spans `pad` texels either side of the
   *  edge, which is the margin the engine set it with. */
  private _field(raster: TextRaster): Uint8Array {
    const stride = raster.stride ?? 4;
    return distanceField(
      raster.pixels,
      raster.width,
      raster.height,
      this.pad,
      stride,
      stride === 4 ? 3 : 0,
    );
  }

  private _add(
    key: string,
    width: number,
    height: number,
    pixels: Uint8Array,
  ): boolean {
    let place =
      this._allocate(width, height) ?? this._reuseShelf(width, height);
    if (!place && this._compactable()) {
      this._compact();
      place = this._allocate(width, height);
    }
    if (!place) return false;
    const entry: AtlasEntry = {
      key,
      x: place.x,
      y: place.y,
      width,
      height,
      pixels,
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

  /**
   * Room made in place: the shelf of this height whose rasters were drawn
   * longest ago, emptied and filled again from its left.
   *
   * **Nothing that stays moves.** A compaction moves every raster it keeps,
   * and a moved raster is not drawn until it is in the texture again — at
   * {@link takeUploads}' pace, so every label on screen went out together
   * and came back over the next few frames, at full opacity. A full atlas
   * is the ordinary state of a session (a thousand strings at 1x, a quarter
   * of that at 2x), so that was a flash of the whole label layer at the end
   * of most settles. A shelf any label of the last frame stands on is not
   * taken: what is dropped is off screen, and asked for again if it
   * returns.
   */
  private _reuseShelf(w: number, h: number): { x: number; y: number } | null {
    if (w > this.size) return null;
    const height = Math.ceil(h / 8) * 8;
    const newest = new Map<number, number>();
    for (const entry of this._entries.values()) {
      const seen = newest.get(entry.y);
      if (seen === undefined || entry.used > seen)
        newest.set(entry.y, entry.used);
    }
    let shelf: { y: number; height: number; x: number } | null = null;
    let oldest = this._frame;
    for (const candidate of this._shelves) {
      if (candidate.height !== height) continue;
      const used = newest.get(candidate.y) ?? -Infinity;
      if (used < oldest) {
        oldest = used;
        shelf = candidate;
      }
    }
    if (!shelf) return null;
    const y = shelf.y;
    for (const [key, entry] of this._entries) {
      if (entry.y === y) this._entries.delete(key);
    }
    this._uploads = this._uploads.filter((entry) => entry.y !== y);
    this._moved = this._moved.filter((entry) => entry.y !== y);
    shelf.x = w;
    return { x: 0, y };
  }

  /** Whether a compaction would free anything: something kept past its
   *  last use. One that keeps everything only moves it — every label on
   *  screen out of the texture for the frames its upload takes, for no
   *  room at all. */
  private _compactable(): boolean {
    for (const entry of this._entries.values()) {
      if (entry.used < this._frame - KEEP_FRAMES) return true;
    }
    return false;
  }

  /** Drop what has not been drawn for a while and pack the rest again,
   *  tallest first — the last resort, when no shelf of the height wanted
   *  can be taken in place. What was drawable stays drawable: it is
   *  uploaded where it now is, all of it, by the next frame before that
   *  frame draws ({@link takeUploads}); what was waiting still waits. */
  private _compact(): void {
    const keep = [...this._entries.values()]
      .filter((e) => e.used >= this._frame - KEEP_FRAMES)
      .sort((a, b) => b.height - a.height);
    this._entries.clear();
    this._shelves = [];
    this._top = 0;
    this._uploads = [];
    this._moved = [];
    for (const entry of keep) {
      const place = this._allocate(entry.width, entry.height);
      if (!place) continue;
      entry.x = place.x;
      entry.y = place.y;
      this._entries.set(entry.key, entry);
      if (entry.ready) this._moved.push(entry);
      else this._uploads.push(entry);
    }
  }
}

const globals = globalThis as { performance?: { now(): number } };
const now = (): number => globals.performance?.now() ?? Date.now();
