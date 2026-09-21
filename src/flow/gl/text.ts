// Labels on the GPU: strings set by the platform's text engine, read back as
// coverage, packed into one texture, and drawn as boxes that sample it.
//
// A `<glarea>` is stacked over everything 2D in its window, so a label on a
// GL graph has to be *in* the GL frame. The glyphs come from where every other
// string in the app does: `app.fonts.layout()` shapes it (CoreText on Cocoa,
// ntk's shaper on X11, fallback and all), the layout draws into an offscreen
// `Surface`, and the pixels come back — one readback per *batch*, not per
// label. What is kept is coverage, shaped in white and read from alpha; the
// colour is the shader's, so one raster serves every palette.
//
// `src/maps/gl/text.ts` is the same idea for a map. This is its own because
// `AGENTS.md` keeps components from importing each other; what the two share
// is a candidate for a module of its own, and is noted as such.
//
// Two things a graph needs that a map does not:
//
//  - **Zoom resizes every label, continuously.** A raster is exact for one
//    size. So a label is drawn from the raster of its exact size when there
//    is one, and otherwise from the *nearest* size the atlas holds for the
//    same string, scaled — soft for the frames it takes to set it again, but
//    never missing and never late. New sizes are only set while the zoom is
//    at rest (`admit`), because setting every label again on every step of a
//    zoom is the cost that made maps admit labels at rest too. And a zoom
//    that stops swaps every label in **one** frame: `Driver` sets batches
//    until nothing on screen is wanted and repacks the world once, rather
//    than once a batch — a label per batch changing raster, frame after
//    frame, is what a settled zoom looked like before, text visibly
//    flickering in waves after the pane stopped moving.
//  - **The atlas fills.** Every size a zoom settles at is every label again.
//    When there is no room left the rasters the world on screen does not
//    draw from are dropped and the rest are moved together (`compact`), so a
//    full atlas costs a repack, never a label: clearing it outright blanked
//    every label with no other size to fall back on until it was set again.
//  - **Truncation.** A card's label is cut to its width with an ellipsis;
//    `fitText` is the 2D painter's own, so both renderers cut at the same
//    character.
import { Surface } from 'react-x11/ntk';

import { fitText, measureText } from '../draw.js';
import type { FontsLike, PainterOptions } from '../draw.js';
import type { SceneText } from '../scene.js';
import type { TextOptions } from '../types.js';

/** A label's quad and where its raster sits in the atlas. `x`/`y`/`w`/`h` are
 *  logical pixels in the scene's space; `u0`..`v1` are texture coordinates. */
export interface GlyphQuad {
  x: number;
  y: number;
  w: number;
  h: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** What the atlas needs of the pane: its app, for the staging surface, and
 *  the options its 2D painter measures with. */
export interface TextSource {
  app: unknown;
  options: PainterOptions;
}

interface Entry {
  /** Place in the atlas, device pixels, margin included. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The device size it was set at. */
  size: number;
  pixels: Uint8Array | null;
  /** The last world pack that drew from it (`LabelAtlas.beginPack`). */
  used: number;
}

interface ImageLike {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

interface StagingContext {
  getImageData(x: number, y: number, w: number, h: number): Promise<ImageLike>;
  destroy?(): void;
}

interface SurfaceLike {
  getContext(name: '2d'): StagingContext;
  clear(): void;
  destroy(): void;
}

/** The atlas texture's side, device pixels: 16 MB of RGBA, a few thousand
 *  labels — a graph's worth at two or three zooms. */
export const ATLAS_SIZE = 2048;
/** Clear pixels round each raster, so a bilinear sample at its edge never
 *  reads a neighbour. */
const PAD = 2;
/** The surface a batch is set on. A readback has to stay inside it. */
const STAGING_WIDTH = 1024;
const STAGING_HEIGHT = 512;
/** Strings per batch at most, and milliseconds of drawing one may take: a
 *  batch runs between frames. */
const BATCH = 48;
const DRAW_BUDGET_MS = 2;

/** The clock, through `globalThis`: `src/` compiles with `types: []`. */
const globals = globalThis as { performance?: { now(): number } };
const now = (): number => globals.performance?.now() ?? Date.now();

/** Sizes are kept to a quarter of a device pixel: finer is the same raster. */
const quantize = (size: number): number => Math.round(size * 4) / 4;

export class LabelAtlas {
  private readonly source: TextSource;
  private readonly white: PainterOptions;
  private readonly entries = new Map<string, Entry>();
  /** Every size set for one string in one weight, for the nearest-size
   *  fallback. */
  private readonly sizes = new Map<string, number[]>();
  /** Wanted and not yet set: key → what to set it from. */
  private readonly missing = new Map<
    string,
    { text: string; weight: SceneText['weight']; size: number }
  >();
  private readonly layouts = new Map<
    string,
    {
      width: number;
      height: number;
      draw(ctx: unknown, x: number, y: number): void;
    }
  >();
  /** Shelf packing into the atlas. */
  private shelfX = 0;
  private shelfY = 0;
  private shelfH = 0;
  private staging: SurfaceLike | null = null;
  private stagingCtx: StagingContext | null = null;
  private busy = false;
  /** Bumped whenever an entry lands or the atlas is cleared — the renderer
   *  uploads, and the surface repacks the world, when it moves. */
  generation = 0;
  /** Set rasters are uploaded when the renderer next binds the atlas. */
  private readonly pending = new Set<string>();
  /** Whether new sizes may be set: false while the zoom is moving. */
  admit = true;
  private texture: unknown = null;
  private textureGeneration = -1;
  private cleared = false;
  /** Counts world packs; an entry stamped with the current one is on screen. */
  private epoch = 0;
  /** Rasters have moved since the world was last packed: its texture
   *  coordinates are stale, and it must be packed again before the texture
   *  is drawn from. */
  relocated = false;

  /** The texture's side, device pixels. */
  private readonly side: number;

  /** `side` is for tests, which fill an atlas without setting thousands of
   *  labels. */
  constructor(source: TextSource, side = ATLAS_SIZE) {
    this.source = source;
    this.side = side;
    // Measured and shaped in one ink, whatever the label's: widths do not
    // depend on colour, and the raster is coverage, coloured by the shader.
    this.white = { ...source.options, color: '#ffffff' };
  }

  /**
   * A world pack is starting: the labels it asks for are the ones on screen
   * until the next, what compaction keeps — and **all** that is wanted.
   * What earlier packs asked for is forgotten here: every step of a zoom
   * asks for its own size, none of them is set while it moves, and set
   * after it stopped they were a thousand rasters at sizes no longer on
   * screen (1275 after one 0.7→1.9 zoom over 400 nodes) — a second of
   * batches, the atlas compacting on each and the world repacked after
   * each, the labels swapping in waves.
   */
  beginPack(): void {
    this.epoch++;
    this.relocated = false;
    this.missing.clear();
  }

  /**
   * A label's quad, or null when there is nothing to draw it from yet. Asks
   * for its exact size whenever that is not what it got.
   */
  quad(t: SceneText): GlyphQuad | null {
    const opts = this.white;
    const options: TextOptions = {
      size: t.size,
      weight: t.weight,
      color: '#ffffff',
    };
    const shown = t.maxWidth
      ? fitText(opts, t.text, options, t.maxWidth)
      : t.text;
    if (!shown) return null;
    const { width, height } = measureText(opts, shown, options);
    // Placed as `Painter.text` places it: anchored by `align` and
    // `baseline`, its top-left put on the device grid — by the shader here,
    // after the pan's offset, which is where the grid is.
    const dx =
      t.align === 'center' ? -width / 2 : t.align === 'right' ? -width : 0;
    const dy = t.baseline === 'middle' ? -height / 2 : 0;
    const scale = opts.scale;
    const size = quantize(t.size * scale);
    const weight = t.weight ?? 400;
    const family = `${weight}|${shown}`;
    const key = `${size}|${family}`;

    let entry = this.entries.get(key);
    let ratio = 1;
    if (!entry) {
      this.missing.set(key, { text: shown, weight: t.weight, size });
      // the nearest size already set, scaled, while the exact one is not
      const sizes = this.sizes.get(family);
      if (!sizes || sizes.length === 0) return null;
      let best = sizes[0];
      for (const s of sizes) {
        if (Math.abs(s - size) < Math.abs(best - size)) best = s;
      }
      entry = this.entries.get(`${best}|${family}`);
      if (!entry) return null;
      ratio = size / best;
    }
    entry.used = this.epoch;
    const pad = (PAD * ratio) / scale;
    return {
      x: t.x + dx - pad,
      y: t.y + dy - pad,
      w: (entry.width * ratio) / scale,
      h: (entry.height * ratio) / scale,
      u0: entry.x / this.side,
      v0: entry.y / this.side,
      u1: (entry.x + entry.width) / this.side,
      v1: (entry.y + entry.height) / this.side,
    };
  }

  /** Whether any label drawn so far is still waiting for its exact size. */
  get wanting(): boolean {
    return this.missing.size > 0;
  }

  private layout(text: string, weight: SceneText['weight'], size: number) {
    const key = `${size}|${weight ?? 400}|${text}`;
    let layout = this.layouts.get(key);
    if (!layout) {
      const fonts = this.source.options.fonts as FontsLike;
      if (this.layouts.size > 8000) this.layouts.clear();
      layout = fonts.layout(text, {
        family: this.source.options.family,
        size,
        weight: weight ?? 400,
        style: 'normal',
        color: '#ffffff',
      });
      this.layouts.set(key, layout);
    }
    return layout;
  }

  /**
   * Set one batch of the labels that were asked for. Resolves true when any
   * landed — the caller repacks then — and does nothing while one is already
   * in flight, while the zoom is moving, or with nothing to set.
   */
  async pump(): Promise<boolean> {
    if (this.busy || !this.admit || this.missing.size === 0) return false;
    if (!this.source.options.fonts) return false;
    this.busy = true;
    try {
      if (!this.staging) {
        this.staging = new Surface(this.source.app as never, {
          width: STAGING_WIDTH,
          height: STAGING_HEIGHT,
        }) as unknown as SurfaceLike;
        this.stagingCtx = this.staging.getContext('2d');
      }
      const staging = this.staging;
      const ctx = this.stagingCtx!;
      staging.clear();
      const started = now();
      const placed: {
        key: string;
        x: number;
        y: number;
        w: number;
        h: number;
        size: number;
        text: string;
        weight: SceneText['weight'];
      }[] = [];
      let x = 0;
      let y = 0;
      let row = 0;
      for (const [key, want] of this.missing) {
        if (placed.length >= BATCH || now() - started > DRAW_BUDGET_MS) break;
        const layout = this.layout(want.text, want.weight, want.size);
        const w = Math.ceil(layout.width) + PAD * 2;
        const h = Math.ceil(layout.height || want.size * 1.3) + PAD * 2;
        if (w > STAGING_WIDTH || h > STAGING_HEIGHT) {
          // wider than anything can set: never drawn, and never asked again
          this.missing.delete(key);
          continue;
        }
        if (x + w > STAGING_WIDTH) {
          x = 0;
          y += row;
          row = 0;
        }
        if (y + h > STAGING_HEIGHT) break;
        layout.draw(ctx, x + PAD, y + PAD);
        placed.push({
          key,
          x,
          y,
          w,
          h,
          size: want.size,
          text: want.text,
          weight: want.weight,
        });
        x += w;
        row = Math.max(row, h);
      }
      if (placed.length === 0) return false;
      const used = Math.max(...placed.map((p) => p.y + p.h));
      const image = await ctx.getImageData(0, 0, STAGING_WIDTH, used);
      for (const p of placed) {
        this.missing.delete(p.key);
        let place = this.allot(p.w, p.h);
        if (!place) {
          // Full: keep what the world on screen draws from, moved together,
          // and make room for the rest of this batch in what that frees.
          this.compact();
          place = this.allot(p.w, p.h);
        }
        if (!place) {
          // Still full — the screen alone needs more than the atlas holds.
          // Forget everything; the labels on screen are asked for again by
          // the next pack.
          this.clear();
          return true;
        }
        const rowBytes = p.w * 4;
        const pixels = new Uint8Array(rowBytes * p.h);
        for (let r = 0; r < p.h; r++) {
          const src = ((p.y + r) * image.width + p.x) * 4;
          pixels.set(image.data.subarray(src, src + rowBytes), r * rowBytes);
        }
        this.entries.set(p.key, {
          x: place.x,
          y: place.y,
          width: p.w,
          height: p.h,
          size: p.size,
          pixels,
          // on screen as soon as the world is packed with it
          used: this.epoch,
        });
        this.pending.add(p.key);
        const family = `${p.weight ?? 400}|${p.text}`;
        const sizes = this.sizes.get(family) ?? [];
        if (!sizes.includes(p.size)) sizes.push(p.size);
        this.sizes.set(family, sizes);
      }
      this.generation++;
      return true;
    } finally {
      this.busy = false;
    }
  }

  private allot(w: number, h: number): { x: number; y: number } | null {
    if (this.shelfX + w > this.side) {
      this.shelfX = 0;
      this.shelfY += this.shelfH;
      this.shelfH = 0;
    }
    if (this.shelfY + h > this.side) return null;
    const place = { x: this.shelfX, y: this.shelfY };
    this.shelfX += w;
    this.shelfH = Math.max(this.shelfH, h);
    return place;
  }

  /**
   * Drop every raster the world on screen does not draw from and pack the
   * rest again from the copies kept here, tallest first. They all move, so
   * the whole texture is uploaded again and the world must be repacked
   * before it is drawn from (`relocated`).
   */
  private compact(): void {
    const kept = [...this.entries].filter(([, e]) => e.used === this.epoch);
    kept.sort((a, b) => b[1].height - a[1].height);
    this.entries.clear();
    this.sizes.clear();
    this.pending.clear();
    this.shelfX = 0;
    this.shelfY = 0;
    this.shelfH = 0;
    for (const [key, entry] of kept) {
      const place = this.allot(entry.width, entry.height);
      if (!place) break;
      entry.x = place.x;
      entry.y = place.y;
      this.entries.set(key, entry);
      this.pending.add(key);
      const bar = key.indexOf('|');
      const family = key.slice(bar + 1);
      const sizes = this.sizes.get(family) ?? [];
      sizes.push(entry.size);
      this.sizes.set(family, sizes);
    }
    this.cleared = true;
    this.relocated = true;
    this.generation++;
  }

  private clear(): void {
    this.entries.clear();
    this.sizes.clear();
    this.pending.clear();
    this.shelfX = 0;
    this.shelfY = 0;
    this.shelfH = 0;
    this.cleared = true;
    this.relocated = true;
    this.generation++;
  }

  /**
   * The atlas texture, bound to unit 0, with every raster set since the
   * last call uploaded into it. Made on first use — and made again for a new
   * context, into which every raster is uploaded again from the copies kept
   * here.
   */
  bind(gl: GLLike, fresh: boolean): void {
    if (!this.texture || fresh) {
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        this.side,
        this.side,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      for (const key of this.entries.keys()) this.pending.add(key);
      this.cleared = false;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.cleared) this.cleared = false;
    if (this.textureGeneration === this.generation && this.pending.size === 0) {
      return;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const key of this.pending) {
      const entry = this.entries.get(key);
      if (!entry?.pixels) continue;
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        entry.x,
        entry.y,
        entry.width,
        entry.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        entry.pixels,
      );
    }
    this.pending.clear();
    this.textureGeneration = this.generation;
  }

  dispose(gl?: GLLike): void {
    if (gl && this.texture) gl.deleteTexture(this.texture);
    this.texture = null;
    this.stagingCtx?.destroy?.();
    this.stagingCtx = null;
    this.staging?.destroy();
    this.staging = null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GLLike = any;
