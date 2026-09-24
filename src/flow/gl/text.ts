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
//  - **The atlas fills.** A world is built for three panes each way round
//    the view, so a big graph zoomed out asks for many more strings than
//    are on screen — 2,000 titles in the 2,000-node lattice at 0.6, where
//    one page holds 660 at 2x. The texture's four channels are four pages,
//    alpha first, so an atlas under the old limit is what it was. Past
//    them, a field is dropped in place for a label nearer the view: first
//    what no pack draws, then what is drawn farthest off screen, never
//    what is on it (`room`). A box drawn from a dropped field is drawn as
//    nothing until its field is back (`slotOf`), with no world packed
//    again; a label that finds no room waits until the view moves.
import { Surface } from 'react-x11/ntk';

import { distanceField } from '../../internal/sdf.js';
import { fitText, shape } from '../draw.js';
import type { PainterOptions } from '../draw.js';
import type { SceneText } from '../scene.js';
import type { FlowRect, TextOptions } from '../types.js';

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
  /** The page its field is on: which channel of the texture holds it. */
  page: number;
  /** Its field's placement (`LabelAtlas.slotOf`); 0 when not ready. */
  slot: number;
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
  /** Where that pack draws it — x, y, width, height, the world's units —
   *  for how far off screen it is when room is wanted. */
  at: number[];
  page: number;
  shelf: Shelf;
  /** Which placement this is: a new one each time a field lands. */
  slot: number;
}

/** A row of one height on a page, filled left to right, with the gaps the
 *  fields dropped from it left. */
interface Shelf {
  page: number;
  y: number;
  height: number;
  /** Where the next field goes, past every gap. */
  end: number;
  gaps: { x: number; w: number }[];
}

interface Place {
  shelf: Shelf;
  x: number;
}

/** A field that may be dropped, and how far from the view it is drawn —
 *  Infinity for one no pack draws. */
interface Victim {
  key: string;
  d: number;
  used: number;
  entry: Entry;
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

/** The atlas texture's side, texels: 16 MB of RGBA, four pages of fields —
 *  some 8,000 titles at 1x and 2,600 at 2x. */
export const ATLAS_SIZE = 2048;
/** Pages in the texture: its four channels, each a field a texel. */
const PAGES = 4;
/** The channel each page is in: alpha first, which is where one page's
 *  fields went before there were pages. */
const CHANNELS = [3, 0, 1, 2];
/** Shelf heights round up to this many texels. */
const SHELF_STEP = 4;
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
  /** Wanted and not yet set: key → what to set it from, and where the
   *  label nearest the view that asks for it is. */
  private readonly missing = new Map<string, Want>();
  /**
   * Wanted, and waiting for room: the atlas is full of fields at least as
   * near the view as these, so nothing is set for them until the view
   * moves (`setView`) or a pack starts. Every key here is in `missing` too;
   * what `wanting` counts is the rest.
   */
  private readonly stalled = new Set<string>();
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
    want: Want;
  }[] = [];
  private readonly queued = new Set<string>();
  /** The pages' shelves, and how far down each page they reach. */
  private shelves: Shelf[] = [];
  private readonly tops: number[];
  /** Pages in the texture: one per channel, alpha first. */
  private readonly pages: number;
  /**
   * The whole texture, four bytes a texel, made when the first field goes
   * on a page past the first. An upload writes every channel of the rect
   * it covers, so from then on a field is uploaded from here, with the
   * fields of the other pages under it. An atlas that never fills its first
   * page never makes it: 16 MB, paid only past the old limit.
   */
  private mirror: Uint8Array | null = null;
  /** The last placement found no room, and nothing has been freed since:
   *  a want that cannot evict is stalled before it is shaped. */
  private full = false;
  /** Fields that may be dropped for a nearer one, farthest from the view
   *  first — made when first needed in a slice, and consumed in order. */
  private victims: Victim[] | null = null;
  private victimAt = 0;
  /** Placements, counted: a field's `slot` changes whenever it lands, so a
   *  box drawn from an old one is found by comparing the two. */
  private nextSlot = 1;
  private staging: SurfaceLike | null = null;
  private stagingCtx: StagingContext | null = null;
  private busy = false;
  /** Whether the layouts answer their own coverage (react-x11#673): unknown
   *  until the first string asks, and false for good once one does not. */
  private coverage: boolean | null = null;
  /** Bumped whenever a field lands or is dropped — the renderer writes in
   *  what landed, and uploads, when it moves. */
  generation = 0;
  /** Bumped whenever a field is dropped: the renderer finds the boxes that
   *  drew from it (`slotOf`) and draws them as nothing until it is back. */
  moves = 0;
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
  /** A field's rect as uploaded: widened to RGBA — the shader reads one
   *  channel, and a one-channel texture is a format GLES 2 and a core
   *  profile do not share. Grown to the largest field. */
  private scratch = new Uint8Array(0);
  /** Counts world packs; an entry stamped with the current one is drawn. */
  private epoch = 0;

  /** The texture's side, texels. */
  private readonly side: number;

  /** `side` and `pages` are for tests, which fill an atlas without setting
   *  thousands of labels. */
  constructor(source: TextSource, side = ATLAS_SIZE, pages = PAGES) {
    this.source = source;
    this.side = side;
    this.pages = Math.max(1, Math.min(PAGES, pages));
    this.tops = new Array<number>(this.pages).fill(0);
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
   * A world pack is starting: the labels it asks for are the ones drawn
   * until the next — and **all** that is wanted. What earlier packs asked
   * for and nothing has set is forgotten here: the strings a pan went past
   * are not worth a batch once it has.
   */
  beginPack(): void {
    this.epoch++;
    this.missing.clear();
    this.stalled.clear();
    this.victims = null;
    this.spent = 0;
    this.measured = 0;
  }

  /**
   * The view's centre, in the world's coordinates. What is wanted is set
   * nearest it first: on a first appearance the labels arrive over a
   * hundred milliseconds or more, and the ones in the middle of the view
   * are the ones being read.
   */
  focus: { x: number; y: number } | null = null;
  /** The view, in the world's coordinates — the surface says where each
   *  frame. Null draws everything as if it were on screen. */
  private view: FlowRect | null = null;

  /**
   * Where the view is now. A field on screen is never dropped for another;
   * one off it is dropped for a label nearer the view, and a move of the
   * view is what can make a stalled label nearer than one that is set.
   */
  setView(view: FlowRect | null): void {
    const v = this.view;
    if (
      v === view ||
      (v &&
        view &&
        v.x === view.x &&
        v.y === view.y &&
        v.width === view.width &&
        v.height === view.height)
    ) {
      return;
    }
    this.view = view;
    if (view) {
      this.focus = { x: view.x + view.width / 2, y: view.y + view.height / 2 };
    }
    this.stalled.clear();
    this.victims = null;
  }

  /** How far a rect is from the view, in the world's units: 0 on it. */
  private far(x: number, y: number, w: number, h: number): number {
    const v = this.view;
    if (!v) return 0;
    const dx = Math.max(v.x - (x + w), x - (v.x + v.width), 0);
    const dy = Math.max(v.y - (y + h), y - (v.y + v.height), 0);
    return dx > dy ? dx + dy / 2 : dy + dx / 2;
  }

  /** How near a label is, for ordering what is wanted: from the view,
   *  then from its middle. */
  private nearness(x: number, y: number): [number, number] {
    const f = this.focus;
    const d = f ? (x - f.x) * (x - f.x) + (y - f.y) * (y - f.y) : 0;
    return [this.far(x, y, 0, 0), d];
  }

  /** A want moved to the label asking for it nearest the view. */
  private nearer(want: Want, t: { x: number; y: number }): void {
    const [a, b] = this.nearness(want.x, want.y);
    const [c, d] = this.nearness(t.x, t.y);
    if (c < a || (c === a && d < b)) {
      want.x = t.x;
      want.y = t.y;
    }
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
        const had = this.missing.get(key);
        if (had) this.nearer(had, t);
        else {
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
          page: 0,
          slot: 0,
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
      if (!this.queued.has(key)) {
        const had = this.missing.get(key);
        if (had) this.nearer(had, t);
        else {
          this.missing.set(key, {
            text: shown,
            weight: t.weight,
            x: t.x,
            y: t.y,
          });
        }
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
        page: 0,
        slot: 0,
        u0: 0,
        v0: 0,
        u1: 0,
        v1: 0,
      };
    }
    const q: GlyphQuad = {
      key,
      ready: true,
      x: t.x + dx,
      y: t.y + dy,
      w: (entry.width - inset * 2) * texel,
      h: (entry.height - inset * 2) * texel,
      margin: (this.pad - inset) * texel,
      texel,
      page: entry.page,
      slot: entry.slot,
      u0: (entry.x + inset) / this.side,
      v0: (entry.y + inset) / this.side,
      u1: (entry.x + entry.width - inset) / this.side,
      v1: (entry.y + entry.height - inset) / this.side,
    };
    // Where it is drawn this pack, for how far from the view it is.
    if (entry.used !== this.epoch) {
      entry.used = this.epoch;
      entry.at.length = 0;
    }
    entry.at.push(q.x - q.margin, q.y - q.margin, q.w, q.h);
    return q;
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

  /** The placement a field is at now — -1 when it is not set — for a box
   *  to tell whether the field it was drawn from is still there. */
  slotOf(key: string): number {
    return this.entries.get(key)?.slot ?? -1;
  }

  /** A field a drawn label lost, wanted again from where that label is. */
  want(key: string, t: SceneText): void {
    if (this.entries.has(key) || this.queued.has(key)) return;
    const had = this.missing.get(key);
    if (had) {
      this.nearer(had, t);
      return;
    }
    const bar = key.indexOf('|');
    this.missing.set(key, {
      text: key.slice(bar + 1),
      weight: t.weight,
      x: t.x,
      y: t.y,
    });
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

  /** No longer wanted: set, or given up on. */
  private unwant(key: string): void {
    this.missing.delete(key);
    this.stalled.delete(key);
  }

  /**
   * A request the pack left unmeasured, measured: its string cut and
   * shaped, and wanted under its field's key from then on. Null when that
   * field is set, being set or waiting for room already — the request is
   * answered, and a frame writes its labels in.
   */
  private resolve(
    key: string,
    want: Want,
  ): { key: string; text: string; want: Want } | null {
    if (want.request === undefined) return { key, text: want.text, want };
    this.unwant(key);
    const shown = this.cut(want.text, want.weight, want.fit);
    this.remember(want.request, shown);
    if (!shown) return null;
    const field = `${want.weight ?? 400}|${shown}`;
    if (
      this.entries.has(field) ||
      this.queued.has(field) ||
      this.stalled.has(field)
    ) {
      return null;
    }
    let wanted = this.missing.get(field);
    if (wanted) this.nearer(wanted, want);
    else {
      wanted = { ...want, text: shown, request: undefined };
      this.missing.set(field, wanted);
    }
    return { key: field, text: shown, want: wanted };
  }

  /** What is wanted and not waiting for room, nearest the view first. */
  private wanted(): [string, Want][] {
    const list: [string, Want, number, number][] = [];
    for (const [key, want] of this.missing) {
      if (this.stalled.has(key)) continue;
      const [a, b] = this.nearness(want.x, want.y);
      list.push([key, want, a, b]);
    }
    if (list.length > 1) list.sort((p, q) => p[2] - q[2] || p[3] - q[3]);
    return list.map(([key, want]) => [key, want]);
  }

  /** Whether any label drawn so far is still waiting for a field that can
   *  be set — not counting those waiting for room. */
  get wanting(): boolean {
    return this.fieldQueue.length > 0 || this.missing.size > this.stalled.size;
  }

  /**
   * Whether a want this far from the view is worth shaping: not when the
   * atlas is full and holds nothing farther to drop for it.
   */
  private hopeful(distance: number): boolean {
    return !this.full || this.victim(distance) !== null;
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
    if (this.fieldQueue.length === 0 && (!this.wanting || !fonts)) {
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
      // what may be dropped is worked out again: the view may have moved
      this.victims = null;
      if (this.fieldQueue.length > 0) return this.makeFields();
      if (!this.wanting) return false;
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
      want: Want;
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
      if (!this.hopeful(this.far(wanted.x, wanted.y, 0, 0))) {
        this.stalled.add(asked);
        continue;
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
        this.unwant(key);
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
      placed.push({ key, want: want.want, x, y, w, h });
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
      this.unwant(p.key);
      // Row by row, as the readback has them; the field reads alpha.
      const rowBytes = p.w * 4;
      const pixels = new Uint8Array(rowBytes * p.h);
      for (let r = 0; r < p.h; r++) {
        const src = ((p.y + r) * image.width + p.x) * 4;
        pixels.set(image.data.subarray(src, src + rowBytes), r * rowBytes);
      }
      this.fieldQueue.push({
        key: p.key,
        width: p.w,
        height: p.h,
        pixels,
        want: p.want,
      });
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
      const distance = this.far(wanted.x, wanted.y, 0, 0);
      if (!this.hopeful(distance)) {
        // Full of fields at least as near: not shaped, and not asked for
        // again until the view moves.
        this.stalled.add(asked);
        continue;
      }
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
      if (coverage.width > STAGING_WIDTH || coverage.height > STAGING_HEIGHT) {
        // wider than a batch could set: never drawn, as there
        this.unwant(key);
        continue;
      }
      const place = this.room(coverage.width, coverage.height, distance);
      if (!place) {
        this.stalled.add(key);
        continue;
      }
      this.unwant(key);
      const field = distanceField(
        coverage.data,
        coverage.width,
        coverage.height,
        this.pad,
        1,
        0,
      );
      landed = true;
      this.put(key, place, coverage.width, coverage.height, field, want.want);
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
      const { key, width, height, pixels, want } = this.fieldQueue.shift()!;
      this.queued.delete(key);
      const place = this.room(width, height, this.far(want.x, want.y, 0, 0));
      if (!place) {
        // no room nearer than it: wanted again once the view moves
        this.missing.set(key, want);
        this.stalled.add(key);
        continue;
      }
      const field = distanceField(pixels, width, height, this.pad);
      landed = true;
      this.put(key, place, width, height, field, want);
    }
    if (landed) this.generation++;
    return landed;
  }

  /**
   * Room for a field of a label this far from the view: free room, or room
   * made by dropping fields — first the ones no pack draws, then the ones
   * drawn farthest from the view, so long as they are farther than it.
   * Nothing on screen is dropped for anything. Null when there is none, and
   * the atlas is `full` until something is freed.
   */
  private room(w: number, h: number, distance: number): Place | null {
    let place = this.allot(w, h) ?? this.squeeze(w, h);
    while (!place) {
      const v = this.victim(distance);
      if (!v) {
        this.full = true;
        return null;
      }
      this.evict(v.key);
      this.victimAt++;
      place = this.allot(w, h) ?? this.squeeze(w, h);
    }
    return place;
  }

  /**
   * Room made by sliding a shelf's fields together over its gaps: fields
   * of one height are not one width — `node 7` and `node 1234` — and a
   * narrow one dropped leaves a gap a wide one does not fit, so gaps apart
   * are room nothing uses. The fields moved are new placements: a box
   * drawn from one is written again from where it is now, in the same
   * frame (`slotOf`).
   */
  private squeeze(w: number, h: number): Place | null {
    const height = Math.ceil(h / SHELF_STEP) * SHELF_STEP;
    const shelf = this.shelves.find(
      (s) =>
        s.height === height &&
        s.gaps.length > 0 &&
        s.gaps.reduce((n, g) => n + g.w, this.side - s.end) >= w,
    );
    if (!shelf) return null;
    const on = [...this.entries]
      .filter(([, e]) => e.shelf === shelf)
      .sort((a, b) => a[1].x - b[1].x);
    let x = 0;
    for (const [key, e] of on) {
      if (e.x !== x) {
        e.x = x;
        e.slot = this.nextSlot++;
        this.pending.add(key);
        if (this.mirror) this.paint(e);
      }
      x += e.width;
    }
    shelf.gaps = [];
    shelf.end = x;
    this.moves++;
    this.generation++;
    return this.allot(w, h);
  }

  /** The next field that may go for a label this far from the view, or
   *  null — skipping the ones already gone, or set again since. */
  private victim(distance: number): Victim | null {
    if (!this.victims) {
      const list: Victim[] = [];
      for (const [key, e] of this.entries) {
        const d = e.used < this.epoch ? Infinity : this.reach(e);
        if (d > 0) list.push({ key, d, used: e.used, entry: e });
      }
      list.sort((a, b) => b.d - a.d || a.used - b.used);
      this.victims = list;
      this.victimAt = 0;
    }
    const list = this.victims;
    while (this.victimAt < list.length) {
      const v = list[this.victimAt];
      if (this.entries.get(v.key) !== v.entry) {
        this.victimAt++;
        continue;
      }
      return v.d > distance ? v : null;
    }
    return null;
  }

  /** How far from the view the nearest label drawn from a field is. */
  private reach(e: Entry): number {
    let d = Infinity;
    for (let i = 0; i < e.at.length && d > 0; i += 4) {
      d = Math.min(d, this.far(e.at[i], e.at[i + 1], e.at[i + 2], e.at[i + 3]));
    }
    return d === Infinity ? 0 : d;
  }

  /** A field into the place made for it — drawn, until a pack says where,
   *  where the label that asked for it is. */
  private put(
    key: string,
    place: Place,
    width: number,
    height: number,
    field: Uint8Array,
    want: Want,
  ): void {
    const entry: Entry = {
      x: place.x,
      y: place.shelf.y,
      width,
      height,
      field,
      // drawn as soon as its labels are written in
      used: this.epoch,
      at: [want.x, want.y, 0, 0],
      page: place.shelf.page,
      shelf: place.shelf,
      slot: this.nextSlot++,
    };
    this.entries.set(key, entry);
    if (entry.page > 0 && !this.mirror) {
      this.mirror = new Uint8Array(this.side * this.side * 4);
      for (const e of this.entries.values()) this.paint(e);
    } else if (this.mirror) {
      this.paint(entry);
    }
    this.pending.add(key);
  }

  /** A field written into its channel of the mirror. */
  private paint(e: Entry): void {
    const m = this.mirror!;
    const channel = CHANNELS[e.page];
    const side = this.side;
    const field = e.field;
    for (let r = 0; r < e.height; r++) {
      let at = ((e.y + r) * side + e.x) * 4 + channel;
      const row = r * e.width;
      for (let c = 0; c < e.width; c++, at += 4) m[at] = field[row + c];
    }
  }

  /** A field dropped, and its room given back to its shelf. */
  private evict(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.pending.delete(key);
    this.free(e);
    this.full = false;
    this.moves++;
    this.generation++;
  }

  /**
   * Shelves by height, in steps: a label's field is as tall as the base
   * size's line and the margin, so nearly every field is one height, and a
   * field dropped leaves a gap the next one fits. The first fit in a gap,
   * then the end of a shelf, then a new shelf — on the first page with
   * room, alpha first.
   */
  private allot(w: number, h: number): Place | null {
    if (w > this.side || h > this.side) return null;
    const height = Math.ceil(h / SHELF_STEP) * SHELF_STEP;
    for (const shelf of this.shelves) {
      if (shelf.height !== height) continue;
      const gaps = shelf.gaps;
      for (let i = 0; i < gaps.length; i++) {
        const gap = gaps[i];
        if (gap.w < w) continue;
        const x = gap.x;
        gap.x += w;
        gap.w -= w;
        if (gap.w === 0) gaps.splice(i, 1);
        return { shelf, x };
      }
    }
    for (const shelf of this.shelves) {
      if (shelf.height !== height || shelf.end + w > this.side) continue;
      const x = shelf.end;
      shelf.end += w;
      return { shelf, x };
    }
    for (let page = 0; page < this.pages; page++) {
      const y = this.tops[page];
      if (y + height > this.side) continue;
      const shelf: Shelf = { page, y, height, end: w, gaps: [] };
      this.tops[page] = y + height;
      this.shelves.push(shelf);
      return { shelf, x: 0 };
    }
    return null;
  }

  /** A field's room back to its shelf, merged with the gaps beside it; a
   *  shelf left empty at the bottom of its page goes back to the page. */
  private free(e: Entry): void {
    const shelf = e.shelf;
    const gaps = shelf.gaps;
    gaps.push({ x: e.x, w: e.width });
    gaps.sort((a, b) => a.x - b.x);
    let n = 0;
    for (const gap of gaps) {
      const last = n > 0 ? gaps[n - 1] : null;
      if (last && last.x + last.w === gap.x) last.w += gap.w;
      else gaps[n++] = gap;
    }
    gaps.length = n;
    const last = gaps[n - 1];
    if (last && last.x + last.w === shelf.end) {
      shelf.end = last.x;
      gaps.pop();
    }
    if (
      shelf.end === 0 &&
      gaps.length === 0 &&
      shelf.y + shelf.height === this.tops[shelf.page]
    ) {
      this.tops[shelf.page] = shelf.y;
      this.shelves.splice(this.shelves.indexOf(shelf), 1);
    }
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
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        this.side,
        this.side,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.mirror,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // the mirror went up whole; without one, every field goes up again
      if (this.mirror) this.pending.clear();
      else for (const key of this.entries.keys()) this.pending.add(key);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.textureGeneration === this.generation && this.pending.size === 0) {
      return;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const side = this.side;
    for (const key of this.pending) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      const texels = entry.width * entry.height;
      if (this.scratch.length < texels * 4) {
        this.scratch = new Uint8Array(texels * 4).fill(255);
      }
      const rgba = this.scratch.subarray(0, texels * 4);
      const mirror = this.mirror;
      if (mirror) {
        // the rect as the mirror has it: this field, and the other pages'
        for (let r = 0; r < entry.height; r++) {
          const src = ((entry.y + r) * side + entry.x) * 4;
          rgba.set(
            mirror.subarray(src, src + entry.width * 4),
            r * entry.width * 4,
          );
        }
      } else {
        // the first page alone: white, the field in alpha
        const field = entry.field;
        for (let i = 0; i < texels; i++) {
          rgba[i * 4] = 255;
          rgba[i * 4 + 1] = 255;
          rgba[i * 4 + 2] = 255;
          rgba[i * 4 + 3] = field[i];
        }
      }
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
