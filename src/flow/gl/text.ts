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
//  - **Strings arrive a slice at a time, nearest the middle first.** A pan
//    to an unseen part of the graph asks for hundreds at once. The world
//    packs a box for every label, the ones still being set drawn as
//    nothing (`GlyphQuad.ready`), and each frame writes in the fields that
//    landed since the last (`FlowGlRenderer.landLabels`) — where the labels
//    used to wait for the last of them and a world packed again.
//  - **Nothing new while a zoom gesture moves** (`admit`). A zoom asks for
//    nothing it has drawn before, but zooming out uncovers strings; they
//    are set when it stops, as maps admit labels at rest. A single step —
//    `setCenter`, a button — is not a gesture, and its labels are set at
//    once.
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
 *
 * A label whose field is still being set is a quad too, `ready` false and
 * no place in the atlas: its size is known from the measurement before its
 * field exists, so it is packed where it will be drawn, and its field is
 * written in when it lands (`landed`) — without packing the world again.
 */
export interface GlyphQuad {
  /** The field it draws from: its weight and the string, as cut. */
  key: string;
  ready: boolean;
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
/** Milliseconds of measuring new strings a world pack may spend, past the
 *  first: what is left is measured between frames. */
const SHAPE_BUDGET_MS = 4;

/** What is wanted: the string to set, where the first label to ask for it
 *  is — and, for a request the pack did not measure, the request, and the
 *  width its string is cut to. */
interface Want {
  text: string;
  weight: SceneText['weight'];
  x: number;
  y: number;
  request?: string;
  fit?: number;
}

/**
 * A label's request: its weight, its string, and the width it is cut to in
 * device pixels at the base size — the same at every zoom, since a card's
 * width and its label's size scale together, so one request resolves once.
 */
function requestOf(
  t: SceneText,
  texel: number,
): { key: string; fit: number | undefined } {
  const fit = t.maxWidth
    ? Math.round((t.maxWidth / texel) * 64) / 64
    : undefined;
  return { key: `${t.weight ?? 400}|${fit ?? ''}|${t.text}`, fit };
}

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
 * third of the base, is a ramp of 2.3 texels, and a sixth of the base
 * reaches three. A quarter, which the first cut used, drew the same pixels
 * to within 5/255 from fields 12% larger, whose every texel was made.
 */
export const fieldPad = (base: number): number => Math.ceil(base / 6);

/** The clock, through `globalThis`: `src/` compiles with `types: []`. */
const globals = globalThis as {
  performance?: { now(): number };
  setTimeout?(fn: () => void, ms: number): unknown;
  setImmediate?(fn: () => void): unknown;
};
const now = (): number => globals.performance?.now() ?? Date.now();

/**
 * The next task: what lets a frame in between two slices. `setImmediate`,
 * after the loop has polled for what came in — a frame's callback among it
 * — where a timeout of 0 is a millisecond at least, idle, between every
 * slice of a first appearance.
 */
const nextTask = (): Promise<void> =>
  new Promise((resolve) => {
    if (globals.setImmediate) globals.setImmediate(resolve);
    else if (globals.setTimeout) globals.setTimeout(resolve, 0);
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
  /** Wanted and not yet set: key → what to set it from, and where the first
   *  label to ask for it is. */
  private readonly missing = new Map<string, Want>();
  /**
   * Requests measured: request → the string as cut. Measuring is what a
   * label's first appearance costs the frame that packs it — 60-80 µs a
   * string, on DirectWrite and on ntk alike, so a view of three hundred new
   * labels was one frame 20 ms long before any of them could arrive. A pack
   * measures for `shapeBudgetMs` and leaves the rest to the slices between
   * frames; the ones it measured no pack measures again.
   */
  private readonly resolved = new Map<string, string>();
  /**
   * What the pack under way has spent measuring, and how many strings it
   * has measured — at least one a pack. Measuring alone is charged: a pack
   * writes every edge before its first label, and a deadline from its start
   * put off, after a zoom, labels whose cut had moved a fraction of a pixel
   * and whose every measurement was cached.
   */
  private spent = 0;
  private measured = 0;
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
  /** Whether the layouts answer their own coverage (react-x11#673): unknown
   *  until the first string asks, and false for good once one does not. */
  private coverage: boolean | null = null;
  /** Bumped whenever a field lands or the atlas is cleared — the renderer
   *  uploads, and the surface repacks the world, when it moves. */
  generation = 0;
  /** Fields set are uploaded when the renderer next binds the atlas. */
  private readonly pending = new Set<string>();
  /** Whether new strings may be set: false while the zoom is moving. */
  admit = true;
  /** Milliseconds of fields one slice may make, past the first field. */
  fieldBudgetMs = FIELD_BUDGET_MS;
  /** Milliseconds of measuring new strings a world pack may spend. */
  shapeBudgetMs = SHAPE_BUDGET_MS;
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
    this.spent = 0;
    this.measured = 0;
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
    const request = requestOf(t, texel);
    let shown = this.resolved.get(request.key);
    if (shown === undefined) {
      if (this.measured > 0 && this.spent > this.shapeBudgetMs) {
        // Past the pack's budget: measured between frames, and the whole
        // quad written in once its field lands (`landing`).
        const key = `?${request.key}`;
        if (!this.missing.has(key)) {
          this.missing.set(key, {
            text: t.text,
            weight: t.weight,
            x: t.x,
            y: t.y,
            request: request.key,
            fit: request.fit,
          });
        }
        return {
          key,
          ready: false,
          x: t.x,
          y: t.y,
          w: 0,
          h: 0,
          margin: 0,
          texel,
          u0: 0,
          v0: 0,
          u1: 0,
          v1: 0,
        };
      }
      this.measured++;
      const started = now();
      shown = this.cut(t.text, t.weight, request.fit);
      this.remember(request.key, shown);
      if (shown) {
        shape(this.white, shown, {
          size: this.base,
          weight: t.weight,
          color: '#ffffff',
        });
      }
      this.spent += now() - started;
    }
    if (!shown) return null;
    const style: TextOptions = {
      size: this.base,
      weight: t.weight,
      color: '#ffffff',
    };
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
    const inset = QUAD_INSET;
    if (!entry) {
      if (!this.queued.has(key) && !this.missing.has(key)) {
        this.missing.set(key, {
          text: shown,
          weight: t.weight,
          x: t.x,
          y: t.y,
        });
      }
      // Its field will be the layout box in whole pixels and the margin,
      // which is known now: packed where it will be drawn, and drawn once
      // its field lands.
      return {
        key,
        ready: false,
        x: t.x + dx,
        y: t.y + dy,
        w: (Math.ceil(shaped.width) + (this.pad - inset) * 2) * texel,
        h: (Math.ceil(shaped.height) + (this.pad - inset) * 2) * texel,
        margin: (this.pad - inset) * texel,
        texel,
        u0: 0,
        v0: 0,
        u1: 0,
        v1: 0,
      };
    }
    entry.used = this.epoch;
    return {
      key,
      ready: true,
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

  /**
   * The quad a label packed before its field existed draws from, now that
   * it can be drawn — null until then. One the pack did not measure (a `?`
   * key) is placed now, from the string its request resolved to: the pack
   * gave it a box of no size, and this is its whole quad.
   */
  landing(key: string, t: SceneText): GlyphQuad | null {
    if (key.startsWith('?')) {
      const shown = this.resolved.get(key.slice(1));
      if (shown === undefined) return null;
      if (!this.entries.has(`${t.weight ?? 400}|${shown}`)) return null;
    } else if (!this.entries.has(key)) {
      return null;
    }
    // measured and set: `quad` does no work but place it, and marks it
    const q = this.quad(t);
    return q?.ready ? q : null;
  }

  /** A string cut to the width it fits, measured at the base size. */
  private cut(
    text: string,
    weight: SceneText['weight'],
    fit: number | undefined,
  ): string {
    if (fit === undefined) return text;
    const style: TextOptions = { size: this.base, weight, color: '#ffffff' };
    return fitText(this.white, text, style, fit);
  }

  private remember(request: string, shown: string): void {
    if (this.resolved.size > 20000) this.resolved.clear();
    this.resolved.set(request, shown);
  }

  /**
   * A request the pack left unmeasured, measured: its string cut and
   * shaped, and wanted under its field's key from then on. Null when that
   * field is set, or being set, already — the request is answered, and a
   * frame writes its labels in.
   */
  private resolve(
    key: string,
    want: Want,
  ): { key: string; text: string } | null {
    if (want.request === undefined) return { key, text: want.text };
    this.missing.delete(key);
    const shown = this.cut(want.text, want.weight, want.fit);
    this.remember(want.request, shown);
    if (!shown) return null;
    const field = `${want.weight ?? 400}|${shown}`;
    if (this.entries.has(field) || this.queued.has(field)) return null;
    if (!this.missing.has(field)) {
      this.missing.set(field, { ...want, text: shown, request: undefined });
    }
    return { key: field, text: shown };
  }

  /**
   * The view's centre, in the world's coordinates — the surface says where
   * each frame. What is wanted is set nearest it first: on a first
   * appearance the labels arrive over a hundred milliseconds or more, and
   * the ones in the middle of the view are the ones being read.
   */
  focus: { x: number; y: number } | null = null;

  /** What is wanted, nearest the focus first. */
  private wanted(): [string, Want][] {
    const list = [...this.missing];
    const f = this.focus;
    if (f && list.length > 1) {
      const d = (w: { x: number; y: number }) =>
        (w.x - f.x) * (w.x - f.x) + (w.y - f.y) * (w.y - f.y);
      list.sort((a, b) => d(a[1]) - d(b[1]));
    }
    return list;
  }

  /** Whether any label drawn so far is still waiting for its field. */
  get wanting(): boolean {
    return this.missing.size > 0 || this.fieldQueue.length > 0;
  }

  /**
   * One slice of setting what was asked for: fields for what was read back
   * already, in a task of their own, or else one batch drawn and read back
   * and the first of its fields. Resolves true when any field landed — the
   * caller asks for a frame then, which draws what landed — and does
   * nothing while one is already in flight,
   * while the zoom is moving, or with nothing to set.
   */
  async pump(): Promise<boolean> {
    if (this.busy || !this.admit) return false;
    const fonts = this.source.options.fonts;
    if (this.fieldQueue.length === 0 && (this.missing.size === 0 || !fonts)) {
      return false;
    }
    this.busy = true;
    try {
      // A frame first, if one is waiting: every slice is a task of its own.
      // A readback can answer at once (the Windows surface does), so a
      // batch that set its fields in the same slice left nothing to wait
      // on, and a whole appearance ran as one task — every label at the
      // end of it, and no frame in between.
      await nextTask();
      if (this.fieldQueue.length > 0) return this.makeFields();
      if (this.missing.size === 0) return false;
      if (this.coverage !== false) {
        const landed = this.coverageSlice();
        if (landed !== null) return landed;
      }
      return await this.readBack();
    } finally {
      this.busy = false;
    }
  }

  /**
   * One batch drawn onto the staging surface and read back, and the first
   * of its fields: the way a string is set on an engine whose layouts do not
   * answer their own coverage.
   */
  private async readBack(): Promise<boolean> {
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
    // Drawing and measuring are budgeted apart: a batch read back costs
    // what it costs however few strings are in it, so measuring the ones
    // the pack left out of the drawing's budget made the batches small and
    // the readbacks many.
    let drawing = 0;
    let measuring = 0;
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
    let answered = false;
    for (const [asked, wanted] of this.wanted()) {
      if (
        placed.length >= BATCH ||
        drawing > DRAW_BUDGET_MS ||
        measuring > this.shapeBudgetMs
      ) {
        break;
      }
      const measured = now();
      const want = this.resolve(asked, wanted);
      if (!want) {
        measuring += now() - measured;
        answered = true;
        continue;
      }
      const key = want.key;
      const shaped = shape(this.white, want.text, {
        size: this.base,
        weight: wanted.weight,
        color: '#ffffff',
      });
      measuring += now() - measured;
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
      const drawn = now();
      layout.draw(ctx, x + pad, y + pad);
      drawing += now() - drawn;
      placed.push({ key, x, y, w, h });
      x += w;
      row = Math.max(row, h);
    }
    if (placed.length === 0) {
      if (!answered) return false;
      this.generation++;
      return true;
    }
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
    if (this.makeFields()) return true;
    if (!answered) return false;
    this.generation++;
    return true;
  }

  /**
   * One slice of strings set from their layouts' own coverage, where the
   * engine answers it: no staging surface and no readback, so a string
   * shaped this slice is a field this slice, until the budget is spent — at
   * least one. Null when the layouts cannot answer, and the batches read
   * back instead from then on.
   */
  private coverageSlice(): boolean | null {
    const started = now();
    let landed = false;
    let answered = false;
    for (const [asked, wanted] of this.wanted()) {
      if ((landed || answered) && now() - started >= this.fieldBudgetMs) break;
      const want = this.resolve(asked, wanted);
      if (!want) {
        answered = true;
        continue;
      }
      const key = want.key;
      const shaped = shape(this.white, want.text, {
        size: this.base,
        weight: wanted.weight,
        color: '#ffffff',
      });
      const coverage = shaped?.layout.coverage?.({ pad: this.pad }) ?? null;
      if (!coverage) {
        if (landed || answered || this.coverage) break;
        this.coverage = false;
        return null;
      }
      this.coverage = true;
      this.missing.delete(key);
      if (coverage.width > STAGING_WIDTH || coverage.height > STAGING_HEIGHT) {
        // wider than a batch could set: never drawn, as there
        continue;
      }
      const field = distanceField(
        coverage.data,
        coverage.width,
        coverage.height,
        this.pad,
        1,
        0,
      );
      landed = true;
      if (!this.add(key, coverage.width, coverage.height, field)) break;
    }
    if (landed || answered) this.generation++;
    return landed || answered;
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
