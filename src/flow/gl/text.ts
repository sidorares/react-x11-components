// Labels on the GPU: strings set by the platform's text engine, read back as
// coverage, kept as signed distance fields in one texture, and drawn as boxes
// that sample it.
//
// A `<glarea>` is stacked over everything 2D in its window, so a label on a
// GL graph has to be *in* the GL frame. The glyphs come from where every other
// string in the app does: `app.fonts.layout()` shapes it (CoreText on Cocoa,
// ntk's shaper on X11, fallback and all), the layout draws into an offscreen
// `Surface`, and the pixels come back — one readback per *batch*, not per
// label. What is kept is not that coverage but its distance field
// (`src/internal/sdf.ts`, the one `<Map>`'s labels are drawn from): a byte a
// texel, each texel's distance to the glyphs' edge, which the shader turns
// back into ink at whatever size the label is drawn (`./shaders.ts`). Shaped
// in white, because the colour is the shader's too, so one field serves
// every palette.
//
// **One field per string, at every size.** A graph zooms continuously and
// every label changes size with it. Coverage is exact for one size, so this
// atlas used to set every label again at each size a zoom came to rest at:
// ~580 strings after an eight-notch wheel zoom over a lattice, 80-120 ms of
// shaping, drawing and readback and 3.6 MB of texture, the labels drawn soft
// from the nearest size until the last batch landed ~170 ms after the wheel
// stopped. A field is set once, at `base`, and sharp at any size — every
// frame of a zoom gesture included — so a zoom asks the atlas for nothing.
// What that costs is the engine's hinting at the drawn size: the type is its
// outline, scaled, antialiased across one device pixel.
//
// So a label is also *measured* once, at the base size, and scaled: its box,
// and where it is cut to fit its card — `fitText`, the 2D painter's own, at
// the width the label's size allows. One string at every zoom is one field;
// a cut that moved by a character between two zooms would be a second.
// Advances are linear in size, so the cut is where the 2D painter makes it.
//
// Three things a graph needs that a map does not:
//
//  - **Strings arrive while nothing moves, and swap in together.** A pan to
//    an unseen part of the graph asks for hundreds at once. `Driver` sets
//    batches until nothing on screen is wanted and repacks the world
//    **once**: a label is a box in the world's stream, so each landing batch
//    was a full world pack, and the labels appeared in waves.
//  - **Nothing new while the zoom moves** (`admit`). A zoom asks for nothing
//    it has drawn before, but zooming out uncovers strings; they are set
//    when it stops, as maps admit labels at rest.
//  - **The atlas fills.** When there is no room, the fields the world on
//    screen does not draw from are dropped and the rest moved together
//    (`compact`), so a full atlas costs a repack, never a label on screen.
import { Surface } from 'react-x11/ntk';

import { distanceField } from '../../internal/sdf.js';
import { fitText, shape } from '../draw.js';
import type { PainterOptions } from '../draw.js';
import type { SceneText } from '../scene.js';
import type { TextOptions } from '../types.js';

/**
 * A label's quad and where its field sits in the atlas, all at the scene's
 * zoom. `x`/`y` are the **text's** top-left, logical pixels in the scene's
 * space — what the shader puts on the device grid, as the 2D painter puts
 * the corner it draws a layout from — and the quad starts `margin` before
 * it in both axes and is `w` by `h`. `texel` is the logical pixels one texel
 * of the field covers; `u0`..`v1` are texture coordinates.
 */
export interface GlyphQuad {
  x: number;
  y: number;
  w: number;
  h: number;
  margin: number;
  texel: number;
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
  /** Place in the atlas, texels, margin included. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The distance field, one byte a texel — kept to upload again, after a
   *  compaction moves it or into the texture of a new context. */
  field: Uint8Array;
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

/** The atlas texture's side, texels: 16 MB of RGBA, a couple of thousand
 *  strings at 1x — a graph's worth. */
export const ATLAS_SIZE = 2048;
/** The surface a batch is set on. A readback has to stay inside it. */
const STAGING_WIDTH = 1024;
const STAGING_HEIGHT = 512;
/** Strings per batch at most, and milliseconds of drawing one may take: a
 *  batch runs between frames. */
const BATCH = 48;
const DRAW_BUDGET_MS = 2;
/** Milliseconds of fields one slice may make — about a dozen strings at
 *  1x — before the frames have the thread back. */
const FIELD_BUDGET_MS = 3;

/**
 * Texels the drawn quad leaves off each side of a field: a bilinear sample
 * at its edge then stays inside the field's own margin, never reaching a
 * neighbour's.
 */
export const QUAD_INSET = 1;

/** The device size a display scale sets fields at: 16 at 1x, 32 at 2x. A
 *  card's title is 13 at zoom 1, so a field is mostly drawn at or under the
 *  size it was set at, where it is sharpest, and at twice it at the
 *  default `maxZoom` of 2.5. */
export const fieldBase = (scale: number): number =>
  Math.round(16 * Math.min(2, Math.max(1, scale)));

/**
 * A field's margin and spread at a base size, texels. A graph's labels have
 * no halo, so the field only has to reach as far as the antialiasing ramp
 * of the smallest label drawn: a handle's 10 at `LABEL_ZOOM`, under a
 * third of the base, is a ramp of about two texels.
 */
export const fieldPad = (base: number): number => Math.ceil(base / 4);

/** The clock, through `globalThis`: `src/` compiles with `types: []`. */
const globals = globalThis as {
  performance?: { now(): number };
  setTimeout?(fn: () => void, ms: number): unknown;
};
const now = (): number => globals.performance?.now() ?? Date.now();

/** The next task: what lets a frame in between two slices of fields. */
const nextTask = (): Promise<void> =>
  new Promise((resolve) => {
    if (globals.setTimeout) globals.setTimeout(resolve, 0);
    else resolve();
  });

export class LabelAtlas {
  private readonly source: TextSource;
  /** Measured and shaped in white, at device size — the scale is 1 here,
   *  and a size is the base in device pixels — and cached apart from the
   *  pane's own text: nothing measured here is a size the pane draws. */
  private readonly white: PainterOptions;
  /** The device size every field is set at: a label drawn at `size`
   *  scales its field by `size / base`. */
  readonly base: number;
  /** The margin set round every field, texels, which is also the distance
   *  its values span — the shader's `u_spread`. */
  readonly pad: number;
  private readonly entries = new Map<string, Entry>();
  /** Wanted and not yet set: key → what to set it from. */
  private readonly missing = new Map<
    string,
    { text: string; weight: SceneText['weight'] }
  >();
  /** Read back and waiting for their fields, oldest first — as wanted as
   *  anything in `missing`, so a pack does not ask for them again. */
  private fieldQueue: {
    key: string;
    width: number;
    height: number;
    pixels: Uint8Array;
  }[] = [];
  private readonly queued = new Set<string>();
  /** Shelf packing into the atlas. */
  private shelfX = 0;
  private shelfY = 0;
  private shelfH = 0;
  private staging: SurfaceLike | null = null;
  private stagingCtx: StagingContext | null = null;
  private busy = false;
  /** Bumped whenever a field lands or the atlas is cleared — the renderer
   *  uploads, and the surface repacks the world, when it moves. */
  generation = 0;
  /** Fields set are uploaded when the renderer next binds the atlas. */
  private readonly pending = new Set<string>();
  /** Whether new strings may be set: false while the zoom is moving. */
  admit = true;
  /** Milliseconds of fields one slice may make, past the first field. */
  fieldBudgetMs = FIELD_BUDGET_MS;
  private texture: unknown = null;
  private textureGeneration = -1;
  /** Fields widened to RGBA for the upload: the shader reads alpha, and a
   *  one-channel texture is a format GLES 2 and a core profile do not
   *  share. Grown to the largest field, and its colour bytes left white. */
  private scratch = new Uint8Array(0);
  /** Counts world packs; an entry stamped with the current one is on screen. */
  private epoch = 0;
  /** Fields have moved since the world was last packed: its texture
   *  coordinates are stale, and it must be packed again before the texture
   *  is drawn from. */
  relocated = false;

  /** The texture's side, texels. */
  private readonly side: number;

  /** `side` is for tests, which fill an atlas without setting thousands of
   *  labels. */
  constructor(source: TextSource, side = ATLAS_SIZE) {
    this.source = source;
    this.side = side;
    this.base = fieldBase(source.options.scale);
    this.pad = fieldPad(this.base);
    this.white = {
      ...source.options,
      color: '#ffffff',
      scale: 1,
      cache: new Map(),
      approximateText: false,
    };
  }

  /**
   * A world pack is starting: the labels it asks for are the ones on screen
   * until the next, what compaction keeps — and **all** that is wanted.
   * What earlier packs asked for and nothing has set is forgotten here: the
   * strings a pan went past are not worth a batch once it has.
   */
  beginPack(): void {
    this.epoch++;
    this.relocated = false;
    this.missing.clear();
  }

  /**
   * A label's quad, or null when there is nothing to draw it from yet —
   * which asks for its field.
   */
  quad(t: SceneText): GlyphQuad | null {
    // Logical pixels, at the scene's zoom, per device pixel at the base
    // size: one texel of the field.
    const texel = t.size / this.base;
    if (!(texel > 0)) return null;
    const style: TextOptions = {
      size: this.base,
      weight: t.weight,
      color: '#ffffff',
    };
    const shown = t.maxWidth
      ? fitText(this.white, t.text, style, t.maxWidth / texel)
      : t.text;
    if (!shown) return null;
    const shaped = shape(this.white, shown, style);
    if (!shaped) return null;
    const width = shaped.width * texel;
    const height = shaped.height * texel;
    // Placed as `Painter.text` places it: anchored by `align` and
    // `baseline`, its top-left put on the device grid — by the shader here,
    // after the pan's offset, which is where the grid is.
    const dx =
      t.align === 'center' ? -width / 2 : t.align === 'right' ? -width : 0;
    const dy = t.baseline === 'middle' ? -height / 2 : 0;
    const key = `${t.weight ?? 400}|${shown}`;
    const entry = this.entries.get(key);
    if (!entry) {
      if (!this.queued.has(key)) {
        this.missing.set(key, { text: shown, weight: t.weight });
      }
      return null;
    }
    entry.used = this.epoch;
    const inset = QUAD_INSET;
    return {
      x: t.x + dx,
      y: t.y + dy,
      w: (entry.width - inset * 2) * texel,
      h: (entry.height - inset * 2) * texel,
      margin: (this.pad - inset) * texel,
      texel,
      u0: (entry.x + inset) / this.side,
      v0: (entry.y + inset) / this.side,
      u1: (entry.x + entry.width - inset) / this.side,
      v1: (entry.y + entry.height - inset) / this.side,
    };
  }

  /** Whether any label drawn so far is still waiting for its field. */
  get wanting(): boolean {
    return this.missing.size > 0 || this.fieldQueue.length > 0;
  }

  /**
   * One slice of setting what was asked for: fields for what was read back
   * already, in a task of their own, or else one batch drawn and read back
   * and the first of its fields. Resolves true when any field landed — the
   * caller repacks then — and does nothing while one is already in flight,
   * while the zoom is moving, or with nothing to set.
   */
  async pump(): Promise<boolean> {
    if (this.busy || !this.admit) return false;
    if (this.fieldQueue.length > 0) {
      this.busy = true;
      try {
        // A frame first, if one is waiting: a batch's fields are several
        // times its budget, and made in one go they held a frame back.
        await nextTask();
        return this.makeFields();
      } finally {
        this.busy = false;
      }
    }
    if (this.missing.size === 0 || !this.source.options.fonts) return false;
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
      const pad = this.pad;
      const placed: {
        key: string;
        x: number;
        y: number;
        w: number;
        h: number;
      }[] = [];
      let x = 0;
      let y = 0;
      let row = 0;
      for (const [key, want] of this.missing) {
        if (placed.length >= BATCH || now() - started > DRAW_BUDGET_MS) break;
        const shaped = shape(this.white, want.text, {
          size: this.base,
          weight: want.weight,
          color: '#ffffff',
        });
        if (!shaped) break;
        const layout = shaped.layout;
        const w = Math.ceil(layout.width) + pad * 2;
        const h = Math.ceil(layout.height || this.base * 1.3) + pad * 2;
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
        layout.draw(ctx, x + pad, y + pad);
        placed.push({ key, x, y, w, h });
        x += w;
        row = Math.max(row, h);
      }
      if (placed.length === 0) return false;
      const used = Math.max(...placed.map((p) => p.y + p.h));
      const image = await ctx.getImageData(0, 0, STAGING_WIDTH, used);
      for (const p of placed) {
        this.missing.delete(p.key);
        // Row by row, as the readback has them; the field reads alpha.
        const rowBytes = p.w * 4;
        const pixels = new Uint8Array(rowBytes * p.h);
        for (let r = 0; r < p.h; r++) {
          const src = ((p.y + r) * image.width + p.x) * 4;
          pixels.set(image.data.subarray(src, src + rowBytes), r * rowBytes);
        }
        this.fieldQueue.push({ key: p.key, width: p.w, height: p.h, pixels });
        this.queued.add(p.key);
      }
      return this.makeFields();
    } finally {
      this.busy = false;
    }
  }

  /**
   * Fields for what was read back, oldest first, until the slice's budget
   * is spent — at least one. A field is 0.1-0.4 ms (more texels at 2x);
   * a batch's worth made as it landed was a frame held back.
   */
  private makeFields(): boolean {
    const started = now();
    let landed = false;
    while (
      this.fieldQueue.length > 0 &&
      (!landed || now() - started < this.fieldBudgetMs)
    ) {
      const { key, width, height, pixels } = this.fieldQueue.shift()!;
      this.queued.delete(key);
      const field = distanceField(pixels, width, height, this.pad);
      landed = true;
      if (!this.add(key, width, height, field)) break;
    }
    if (landed) this.generation++;
    return landed;
  }

  /** A field into the atlas; false when nothing would fit and the atlas
   *  was cleared instead. */
  private add(
    key: string,
    width: number,
    height: number,
    field: Uint8Array,
  ): boolean {
    let place = this.allot(width, height);
    if (!place) {
      // Full: keep what the world on screen draws from, moved together,
      // and make room for the rest in what that frees.
      this.compact();
      place = this.allot(width, height);
    }
    if (!place) {
      // Still full — the screen alone needs more than the atlas holds.
      // Forget everything; the labels on screen are asked for again by the
      // next pack.
      this.clear();
      return false;
    }
    this.entries.set(key, {
      x: place.x,
      y: place.y,
      width,
      height,
      field,
      // on screen as soon as the world is packed with it
      used: this.epoch,
    });
    this.pending.add(key);
    return true;
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
   * Drop every field the world on screen does not draw from and pack the
   * rest again, tallest first. They all move, so the whole texture is
   * uploaded again and the world must be repacked before it is drawn from
   * (`relocated`).
   */
  private compact(): void {
    const kept = [...this.entries].filter(([, e]) => e.used === this.epoch);
    kept.sort((a, b) => b[1].height - a[1].height);
    this.entries.clear();
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
    }
    this.relocated = true;
    this.generation++;
  }

  private clear(): void {
    this.entries.clear();
    this.pending.clear();
    this.shelfX = 0;
    this.shelfY = 0;
    this.shelfH = 0;
    this.relocated = true;
    this.generation++;
  }

  /**
   * The atlas texture, bound to unit 0, with every field set since the last
   * call uploaded into it. Made on first use — and made again for a new
   * context, into which every field is uploaded again from the copies kept
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
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.textureGeneration === this.generation && this.pending.size === 0) {
      return;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const key of this.pending) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      const texels = entry.width * entry.height;
      if (this.scratch.length < texels * 4) {
        this.scratch = new Uint8Array(texels * 4).fill(255);
      }
      const rgba = this.scratch.subarray(0, texels * 4);
      const field = entry.field;
      for (let i = 0; i < texels; i++) rgba[i * 4 + 3] = field[i];
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        entry.x,
        entry.y,
        entry.width,
        entry.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        rgba,
      );
    }
    this.pending.clear();
    this.textureGeneration = this.generation;
  }

  dispose(gl?: GLLike): void {
    if (gl && this.texture) gl.deleteTexture(this.texture);
    this.texture = null;
    this.fieldQueue = [];
    this.queued.clear();
    this.stagingCtx?.destroy?.();
    this.stagingCtx = null;
    this.staging?.destroy();
    this.staging = null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GLLike = any;
