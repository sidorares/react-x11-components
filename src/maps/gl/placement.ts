// Labels, the frame's half: which of the anchors the view's tiles offer are
// drawn, and how visibly.
//
// Placement is **per frame and in screen space** — where the retained
// renderer's is per zoom level and in world pixels, because it blits a pan
// and cannot afford a placement that changes with the viewport. This one
// redraws every frame anyway, and two of the things that make a label
// unobtrusive need the viewport: a label is drawn whole or not at all (never
// cut by the pane's edge), and of a street's candidate places the ones in
// view compete. What keeps a per-frame placement from being a per-frame
// reshuffle is the rest of this file:
//
//  - **A label keeps its place.** What is shown is offered again first, at
//    the ground it was placed on, with a little slack — a smaller margin, a
//    shorter run is enough — so that two labels at a margin's width never
//    trade places frame to frame. It leaves when it has to: it no longer
//    fits its street at this zoom, it would be cut by the edge, or something
//    that outranks it arrives.
//  - **Labels fade**, in and out, over {@link FADE_MS}. A label never pops;
//    one whose raster is still being set waits, invisibly, and fades in
//    when it lands.
//  - **Labels do not slide.** Anchors are fixed ground, so a label moves
//    exactly with the map; when a street's label leaves the view another
//    anchor of it can take over, rather than one label chasing the view.
//
// The order is the map's, and deterministic: a layer's rank, then the
// feature's importance (road class, population), then what is shown, then —
// among one street's anchors — one whose label clears every intersection,
// the longest straight run, the one nearest the middle of the view.
import type { PreparedStyle } from '../paint.js';
import { resolveZoomed } from '../style.js';
import type { SymbolLayer } from '../style.js';
import { TILE_EXTENT } from './buckets.js';
import { parseColor, premultiplied } from './color.js';
import type { Rgba } from './color.js';
import {
  LABEL_STRIDE,
  LEVEL_SNAP,
  LINE_MARGIN,
  LabelField,
  STRAIGHT_FRACTION,
  estimateWidth,
} from '../anchors.js';
import type { GlLabelData } from '../anchors.js';
import { haloReach } from './text.js';
import type { AtlasEntry, LabelAtlas } from './text.js';

/** A rectangle in device pixels. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One tile's anchors, placed on screen as the frame draws the tile — a
 *  frame's `RenderTile` as it is. */
export interface LabelTile {
  data: { labels?: GlLabelData };
  /** The tile square's top-left and edge, device pixels. */
  x: number;
  y: number;
  size: number;
  /** The part of the view the tile stands for. An anchor outside it is
   *  another tile's — how a stand-in ancestor offers no duplicates. */
  clip: Rect;
}

export interface PlacementFrame {
  /** Device pixels. */
  width: number;
  height: number;
  scale: number;
  zoom: number;
  style: PreparedStyle;
  tiles: readonly LabelTile[];
  /** The view's centre, normalised mercator, and the world's width in
   *  device pixels at this zoom. */
  centerX: number;
  centerY: number;
  world: number;
  now: number;
  /** Whether labels not already shown may be placed. `view.ts` says no
   *  while the zoom is changing: what is shown rides along and leaves as it
   *  must, and what the zoom uncovers is named once it stops — not labels
   *  arriving and leaving at every step of it. `true` by default. */
  admit?: boolean;
  /** The camera is moving: a label keeps the raster it has, rather than
   *  asking for one at each size its zoom ramp passes through. */
  moving?: boolean;
}

/** Floats per label instance; the layout `renderer.ts` binds. */
export const LABEL_INSTANCE = 18;

/** The frame's labels, ready to draw. */
export interface LabelBatch {
  atlas: LabelAtlas;
  /** {@link LABEL_INSTANCE} floats per label: centre x, y (device
   *  pixels); cos, sin of the baseline; the atlas rect x, y, w, h; ink
   *  and halo colour, premultiplied and faded; halo radius; `1` to set
   *  the label on whole pixels. */
  instances: Float32Array;
  count: number;
}

export interface PlacementStats {
  /** Anchors considered, labels placed, labels drawn (fading ones too). */
  candidates: number;
  placed: number;
  drawn: number;
  /** Milliseconds this thread spent placing. */
  ms: number;
}

/** Logical pixels between two labels, and the extra a newcomer needs. The
 *  extra is the hysteresis: the label already shown wins a tie by it. */
const PADDING = 4;
const NEW_PADDING = 3;
/** Logical pixels a label keeps from the view's edge. */
const EDGE = 6;
/** How long a label takes to appear or leave. */
export const FADE_MS = 220;
/** How near a new anchor must be, in label heights, to a shown label of
 *  the same name to be that label — across a level change, say. */
const MATCH = 2;
/** The collision grid's cell, device pixels. */
const CELL = 64;

interface LayerLabels {
  id: string;
  rank: number;
  /** Device pixels, whole — the raster's size. */
  size: number;
  repeat: number;
  ink: Rgba;
  halo: Rgba | null;
  haloPx: number;
}

/** A label on screen, or fading. Its ground is mercator, so it outlives
 *  the tile that offered it — a level change keeps it where it was. */
interface Shown {
  key: string;
  text: string;
  layer: number;
  size: number;
  mx: number;
  my: number;
  angle: number;
  point: boolean;
  /** The anchor's run either side, intersection distance, run length and
   *  departure from straight — mercator units, re-judged at each zoom. */
  avail: number;
  clear: number;
  length: number;
  dev: number;
  priority: number;
  opacity: number;
  placed: boolean;
  /** The size it has a raster at — drawn until the current size's lands. */
  drawn: number;
}

interface Candidate {
  key: string;
  text: string;
  layer: number;
  rank: number;
  priority: number;
  size: number;
  point: boolean;
  sx: number;
  sy: number;
  angle: number;
  cos: number;
  sin: number;
  /** Device pixels. */
  avail: number;
  clear: number;
  length: number;
  /** Device pixels per mercator unit's worth of this candidate's lengths:
   *  what turns them back into ground for a {@link Shown}. */
  toMercator: number;
  rawAvail: number;
  rawClear: number;
  rawLength: number;
  rawDev: number;
  mx: number;
  my: number;
  shown: Shown | null;
  clean: number;
  centre: number;
  repeat: number;
}

/**
 * The frame's label state: what is shown, how visibly, and the collision
 * index a pass builds.
 */
export class LabelPlacer {
  private readonly _shown = new Set<Shown>();
  private _style: PreparedStyle | null = null;
  /** The last batch's time; null before the first, which advances no fade. */
  private _last: number | null = null;
  private readonly _grid = new CollisionGrid();
  private readonly _colors = new Map<string, Rgba | null>();
  /** Estimated widths in ems, by text — a street name is asked about
   *  once per anchor per frame. */
  private readonly _ems = new Map<string, number>();
  private _instances = new Float32Array(LABEL_INSTANCE * 64);
  stats: PlacementStats = { candidates: 0, placed: 0, drawn: 0, ms: 0 };

  /** Labels still changing visibility: another frame is worth drawing. */
  get animating(): boolean {
    for (const shown of this._shown) {
      if (shown.placed ? shown.opacity < 1 : shown.opacity > 0) return true;
    }
    return false;
  }

  /** Forget everything shown — the style's layers are not the same ones. */
  reset(): void {
    this._shown.clear();
  }

  /**
   * Choose the frame's labels. Asks `atlas` for each contender's box, as
   * the frame's budget allows, and for each winner's raster.
   */
  place(frame: PlacementFrame, atlas: LabelAtlas): void {
    const started = now();
    const { width, height, scale, zoom, style } = frame;
    if (style !== this._style) {
      this._shown.clear();
      this._style = style;
    }
    const layers = this._layersAt(style, zoom, scale);
    const candidates: Candidate[] = [];
    const halfW = width / 2;
    const halfH = height / 2;

    // What is shown, first — at the ground it was placed on, for as long as
    // the map still names it there: the tile under it must carry the name.
    // A label is not its tile's (a level change keeps it), but it is the
    // data's — a new source, a filter, a text field takes it off the map.
    const named = (text: string, sx: number, sy: number): boolean => {
      let covered = false;
      for (const tile of frame.tiles) {
        const clip = tile.clip;
        if (
          sx < clip.x ||
          sy < clip.y ||
          sx >= clip.x + clip.width ||
          sy >= clip.y + clip.height
        ) {
          continue;
        }
        covered = true;
        const data = tile.data.labels;
        if (data && textsOf(data).has(text)) return true;
      }
      // Nothing drawn there yet: no tile has said otherwise.
      return !covered;
    };
    const byKey = new Map<string, Shown[]>();
    for (const shown of this._shown) {
      const layer = layers[shown.layer];
      if (!layer) continue;
      const list = byKey.get(shown.key);
      if (list) list.push(shown);
      else byKey.set(shown.key, [shown]);
      if (!shown.placed) continue;
      let dx = shown.mx - frame.centerX;
      dx -= Math.round(dx);
      const sx = halfW + dx * frame.world;
      const sy = halfH + (shown.my - frame.centerY) * frame.world;
      if (!named(shown.text, sx, sy)) continue;
      const c = this._candidate(
        shown.key,
        shown.text,
        shown.layer,
        layer,
        shown.priority,
        shown.point,
        sx,
        sy,
        shown.angle,
        shown.avail,
        shown.clear,
        shown.length,
        shown.dev,
        frame.world,
        frame,
      );
      if (c) {
        c.shown = shown;
        candidates.push(c);
      }
    }

    // Every anchor the view's tiles offer — unless nothing new is admitted.
    const offered = frame.admit === false ? [] : frame.tiles;
    for (const tile of offered) {
      const data = tile.data.labels;
      if (!data || data.count === 0) continue;
      const ppu = tile.size / TILE_EXTENT;
      const clip = tile.clip;
      const a = data.anchors;
      for (let i = 0; i < data.count; i++) {
        const at = i * LABEL_STRIDE;
        const index = a[at + LabelField.layer];
        const layer = layers[index];
        if (!layer) continue;
        const sx = tile.x + a[at + LabelField.x] * ppu;
        const sy = tile.y + a[at + LabelField.y] * ppu;
        if (
          sx < clip.x ||
          sy < clip.y ||
          sx >= clip.x + clip.width ||
          sy >= clip.y + clip.height
        ) {
          continue;
        }
        const text = data.texts[a[at + LabelField.text]];
        const avail = a[at + LabelField.avail];
        const c = this._candidate(
          `${layer.id}|${text}`,
          text,
          index,
          layer,
          a[at + LabelField.priority],
          avail < 0,
          sx,
          sy,
          a[at + LabelField.angle],
          avail,
          a[at + LabelField.clear],
          a[at + LabelField.length],
          a[at + LabelField.dev],
          ppu,
          frame,
        );
        if (c) candidates.push(c);
      }
    }

    candidates.sort(compare);

    // Greedy, in that order: a label is placed if it fits its street, is
    // whole inside the view, is not a repeat of one just placed, and
    // overlaps nothing placed before it.
    const grid = this._grid;
    grid.reset();
    const placedAt = new Map<string, number[]>();
    const winners: { c: Candidate; width: number; height: number }[] = [];
    const inset = EDGE * scale;
    for (const c of candidates) {
      const repeatAt = placedAt.get(c.key);
      if (repeatAt) {
        const limit = c.repeat * c.repeat;
        let near = false;
        for (let r = 0; r < repeatAt.length; r += 2) {
          const dx = repeatAt[r] - c.sx;
          const dy = repeatAt[r + 1] - c.sy;
          if (dx * dx + dy * dy < limit) {
            near = true;
            break;
          }
        }
        if (near) continue;
      }
      const box = atlas.measure(c.text, c.size);
      if (!box || box.width === 0) continue;
      const w = box.width;
      const h = box.height;
      if (!c.point) {
        const need = w / 2 + h * LINE_MARGIN;
        if (c.avail < (c.shown ? need * 0.9 : need)) continue;
      }
      const hw = (Math.abs(c.cos) * w + Math.abs(c.sin) * h) / 2;
      const hh = (Math.abs(c.sin) * w + Math.abs(c.cos) * h) / 2;
      if (
        c.sx - hw < inset ||
        c.sy - hh < inset ||
        c.sx + hw > width - inset ||
        c.sy + hh > height - inset
      ) {
        continue;
      }
      const testPad = (PADDING / 2 + (c.shown ? 0 : NEW_PADDING)) * scale;
      if (grid.hits(c, w, h, testPad)) continue;
      grid.insert(c, w, h, (PADDING / 2) * scale);
      winners.push({ c, width: w, height: h });
      if (repeatAt) repeatAt.push(c.sx, c.sy);
      else placedAt.set(c.key, [c.sx, c.sy]);
    }

    // What won becomes what is shown: the label it already was, one of the
    // same name close by that is fading out, or a new one.
    for (const shown of this._shown) shown.placed = false;
    for (const { c, height } of winners) {
      let shown = c.shown;
      if (!shown) {
        const reach = MATCH * height;
        for (const other of byKey.get(c.key) ?? []) {
          if (other.placed) continue;
          let dx = other.mx - c.mx;
          dx -= Math.round(dx);
          const dist = Math.hypot(dx, other.my - c.my) * frame.world;
          if (dist <= reach) {
            shown = other;
            break;
          }
        }
        if (!shown || shown.opacity <= 0) {
          // A label nobody can see moves to the anchor that won; one that
          // can be seen keeps its ground and is judged there next pass.
          const fresh =
            shown ??
            ({
              key: c.key,
              text: c.text,
              layer: c.layer,
              size: c.size,
              opacity: 0,
              placed: false,
              drawn: 0,
            } as Shown);
          fresh.mx = c.mx;
          fresh.my = c.my;
          fresh.angle = c.angle;
          fresh.point = c.point;
          fresh.avail = c.rawAvail * c.toMercator;
          fresh.clear = c.rawClear * c.toMercator;
          fresh.length = c.rawLength * c.toMercator;
          fresh.dev = c.rawDev * c.toMercator;
          fresh.priority = c.priority;
          shown = fresh;
          this._shown.add(shown);
        }
      }
      shown.placed = true;
      shown.size = c.size;
      if (!frame.moving || shown.drawn === 0)
        atlas.entry(shown.text, shown.size);
    }

    this.stats = {
      candidates: candidates.length,
      placed: winners.length,
      drawn: this.stats.drawn,
      ms: now() - started,
    };
  }

  /**
   * The frame's instances: every shown label at its ground's place on
   * screen, faded by where it is in its fade. Advances the fades, and lets
   * go of labels that have faded out.
   */
  batch(frame: PlacementFrame, atlas: LabelAtlas): LabelBatch {
    const dt = this._last === null ? 0 : Math.max(0, frame.now - this._last);
    this._last = frame.now;
    const step = dt / FADE_MS;
    const layers = this._layersAt(frame.style, frame.zoom, frame.scale);
    const reach = haloReach(atlas.pad);
    const halfW = frame.width / 2;
    const halfH = frame.height / 2;
    let count = 0;
    for (const shown of [...this._shown]) {
      const layer = layers[shown.layer];
      let entry: AtlasEntry | null;
      if (frame.moving && shown.drawn > 0 && shown.drawn !== shown.size) {
        // Its zoom ramp has moved on; the size it has serves until the
        // view is still.
        entry = atlas.entry(shown.text, shown.drawn);
      } else {
        entry = atlas.entry(shown.text, shown.size);
        if (entry) shown.drawn = shown.size;
        else if (shown.drawn > 0) entry = atlas.entry(shown.text, shown.drawn);
      }
      // Nothing to show yet: wait at zero rather than fade in unseen.
      if (entry && layer) {
        shown.opacity = shown.placed
          ? Math.min(1, shown.opacity + step)
          : Math.max(0, shown.opacity - step);
      } else if (!shown.placed || !layer) {
        shown.opacity = 0;
      }
      if (!shown.placed && shown.opacity <= 0) {
        this._shown.delete(shown);
        continue;
      }
      if (!entry || !layer || shown.opacity <= 0) continue;
      let dx = shown.mx - frame.centerX;
      dx -= Math.round(dx);
      const sx = halfW + dx * frame.world;
      const sy = halfH + (shown.my - frame.centerY) * frame.world;
      const eased = shown.opacity * shown.opacity * (3 - 2 * shown.opacity);
      if (this._instances.length < (count + 1) * LABEL_INSTANCE) {
        const grown = new Float32Array(this._instances.length * 2);
        grown.set(this._instances);
        this._instances = grown;
      }
      const d = this._instances;
      const at = count * LABEL_INSTANCE;
      const level = shown.angle === 0;
      d[at] = sx;
      d[at + 1] = sy;
      d[at + 2] = level ? 1 : Math.cos(shown.angle);
      d[at + 3] = level ? 0 : Math.sin(shown.angle);
      d[at + 4] = entry.x;
      d[at + 5] = entry.y;
      d[at + 6] = entry.width;
      d[at + 7] = entry.height;
      const ink = premultiplied(layer.ink, eased);
      d[at + 8] = ink[0];
      d[at + 9] = ink[1];
      d[at + 10] = ink[2];
      d[at + 11] = ink[3];
      const halo = layer.halo ? premultiplied(layer.halo, eased) : ZERO;
      d[at + 12] = halo[0];
      d[at + 13] = halo[1];
      d[at + 14] = halo[2];
      d[at + 15] = halo[3];
      d[at + 16] = layer.halo ? Math.min(layer.haloPx, reach) : 0;
      d[at + 17] = level ? 1 : 0;
      count++;
    }
    this.stats.drawn = count;
    return { atlas, instances: this._instances, count };
  }

  // --- internals -------------------------------------------------------------

  /** One anchor as a contender, or null when it cannot be one at all at
   *  this zoom — off the view, or on a run too bent or too short for even
   *  a short name. `unit` is device pixels per unit of the lengths given. */
  private _candidate(
    key: string,
    text: string,
    index: number,
    layer: LayerLabels,
    priority: number,
    point: boolean,
    sx: number,
    sy: number,
    angle: number,
    avail: number,
    clear: number,
    length: number,
    dev: number,
    unit: number,
    frame: PlacementFrame,
  ): Candidate | null {
    if (sx < 0 || sy < 0 || sx >= frame.width || sy >= frame.height)
      return null;
    const size = layer.size;
    let ems = this._ems.get(text);
    if (ems === undefined) {
      if (this._ems.size > 20000) this._ems.clear();
      ems = estimateWidth(text, 1);
      this._ems.set(text, ems);
    }
    const estimate = ems * size;
    if (!point) {
      if (dev * unit > size * STRAIGHT_FRACTION) return null;
      // Well short of even an under-estimate of the name: no need to
      // measure it to know.
      if (avail * unit < estimate * 0.35) return null;
    }
    const level = point || Math.abs(angle) < LEVEL_SNAP;
    const a = level ? 0 : angle;
    const clearPx = clear * unit;
    const mx = frame.centerX + (sx - frame.width / 2) / frame.world;
    const my = frame.centerY + (sy - frame.height / 2) / frame.world;
    const cx = sx - frame.width / 2;
    const cy = sy - frame.height / 2;
    return {
      key,
      text,
      layer: index,
      rank: layer.rank,
      priority,
      size,
      point,
      sx,
      sy,
      angle: a,
      cos: Math.cos(a),
      sin: Math.sin(a),
      avail: point ? Infinity : avail * unit,
      clear: clearPx,
      length: length * unit,
      toMercator: unit / frame.world,
      rawAvail: avail,
      rawClear: clear,
      rawLength: length,
      rawDev: dev,
      mx,
      my,
      shown: null,
      clean: point || clearPx >= estimate / 2 ? 1 : 0,
      centre: cx * cx + cy * cy,
      repeat: layer.repeat,
    };
  }

  /** Each symbol layer's labelling at this zoom, by layer index — null
   *  where it does not label. */
  private _layersAt(
    style: PreparedStyle,
    zoom: number,
    scale: number,
  ): (LayerLabels | null)[] {
    return style.layers.map(({ layer }) => {
      if (layer.type !== 'symbol' || layer.visible === false) return null;
      if (layer.minZoom !== undefined && zoom < layer.minZoom) return null;
      if (layer.maxZoom !== undefined && zoom >= layer.maxZoom) return null;
      const symbol = layer as SymbolLayer;
      const ink = this._color(
        symbol.textColor ? resolveZoomed(symbol.textColor, zoom) : '#000000',
      );
      if (!ink) return null;
      const halo = symbol.textHaloColor
        ? this._color(resolveZoomed(symbol.textHaloColor, zoom))
        : null;
      const haloWidth =
        symbol.textHaloWidth === undefined
          ? 1
          : resolveZoomed(symbol.textHaloWidth, zoom);
      const size = Math.max(
        1,
        Math.round(
          (symbol.textSize === undefined
            ? 12
            : resolveZoomed(symbol.textSize, zoom)) * scale,
        ),
      );
      return {
        id: layer.id,
        rank: symbol.rank ?? 0,
        size,
        repeat: (symbol.repeatDistance ?? 250) * scale,
        ink,
        halo: halo && haloWidth > 0 ? halo : null,
        haloPx: haloWidth * scale,
      };
    });
  }

  private _color(value: string): Rgba | null {
    let color = this._colors.get(value);
    if (color === undefined) {
      color = parseColor(value);
      this._colors.set(value, color);
    }
    return color;
  }
}

const ZERO: Rgba = [0, 0, 0, 0];

/** Every name a tile's label layers carry, made once per tile. */
const texts = new WeakMap<GlLabelData, Set<string>>();
function textsOf(data: GlLabelData): Set<string> {
  let set = texts.get(data);
  if (!set) {
    set = new Set(data.texts);
    texts.set(data, set);
  }
  return set;
}

function compare(a: Candidate, b: Candidate): number {
  return (
    b.rank - a.rank ||
    b.priority - a.priority ||
    (b.shown ? 1 : 0) - (a.shown ? 1 : 0) ||
    b.clean - a.clean ||
    b.length - a.length ||
    a.centre - b.centre ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
    a.sx - b.sx ||
    a.sy - b.sy
  );
}

/**
 * Collision shapes over a grid of cells. A level label is its box; a
 * rotated one is a chain of circles along its baseline, each as tall as
 * the text — which follows a slanted name closely where its box would
 * claim the whole corner-to-corner rectangle around it.
 */
class CollisionGrid {
  /** Five numbers per shape: kind (0 box, 1 circle), then x0, y0, x1, y1
   *  or cx, cy, r, 0. */
  private _shapes: number[] = [];
  private readonly _cells = new Map<number, number[]>();
  private readonly _scratch: number[] = [];

  reset(): void {
    this._shapes.length = 0;
    this._cells.clear();
  }

  hits(c: Candidate, w: number, h: number, pad: number): boolean {
    const shapes = this._shapesOf(c, w, h, pad);
    for (let s = 0; s < shapes.length; s += 5) {
      const [x0, y0, x1, y1] = bounds(shapes, s);
      for (let gx = cell(x0); gx <= cell(x1); gx++) {
        for (let gy = cell(y0); gy <= cell(y1); gy++) {
          const list = this._cells.get(cellKey(gx, gy));
          if (!list) continue;
          for (const other of list) {
            if (overlaps(shapes, s, this._shapes, other)) return true;
          }
        }
      }
    }
    return false;
  }

  insert(c: Candidate, w: number, h: number, pad: number): void {
    const shapes = this._shapesOf(c, w, h, pad);
    for (let s = 0; s < shapes.length; s += 5) {
      const index = this._shapes.length;
      for (let k = 0; k < 5; k++) this._shapes.push(shapes[s + k]);
      const [x0, y0, x1, y1] = bounds(shapes, s);
      for (let gx = cell(x0); gx <= cell(x1); gx++) {
        for (let gy = cell(y0); gy <= cell(y1); gy++) {
          const key = cellKey(gx, gy);
          const list = this._cells.get(key);
          if (list) list.push(index);
          else this._cells.set(key, [index]);
        }
      }
    }
  }

  private _shapesOf(c: Candidate, w: number, h: number, pad: number): number[] {
    const out = this._scratch;
    out.length = 0;
    if (c.angle === 0) {
      out.push(
        0,
        c.sx - w / 2 - pad,
        c.sy - h / 2 - pad,
        c.sx + w / 2 + pad,
        c.sy + h / 2 + pad,
      );
      return out;
    }
    const r = h / 2 + pad;
    const span = Math.max(0, w - h);
    const n = span > 0 ? Math.ceil(span / r) + 1 : 1;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : -span / 2 + (span * i) / (n - 1);
      out.push(1, c.sx + c.cos * t, c.sy + c.sin * t, r, 0);
    }
    return out;
  }
}

function bounds(shapes: readonly number[], s: number): number[] {
  if (shapes[s] === 0)
    return [shapes[s + 1], shapes[s + 2], shapes[s + 3], shapes[s + 4]];
  const r = shapes[s + 3];
  return [
    shapes[s + 1] - r,
    shapes[s + 2] - r,
    shapes[s + 1] + r,
    shapes[s + 2] + r,
  ];
}

function overlaps(
  a: readonly number[],
  i: number,
  b: readonly number[],
  j: number,
): boolean {
  const ka = a[i];
  const kb = b[j];
  if (ka === 0 && kb === 0) {
    return (
      a[i + 1] < b[j + 3] &&
      a[i + 3] > b[j + 1] &&
      a[i + 2] < b[j + 4] &&
      a[i + 4] > b[j + 2]
    );
  }
  if (ka === 1 && kb === 1) {
    const dx = a[i + 1] - b[j + 1];
    const dy = a[i + 2] - b[j + 2];
    const r = a[i + 3] + b[j + 3];
    return dx * dx + dy * dy < r * r;
  }
  const [box, bi, circle, ci] = ka === 0 ? [a, i, b, j] : [b, j, a, i];
  const cx = circle[ci + 1];
  const cy = circle[ci + 2];
  const r = circle[ci + 3];
  const nx = Math.max(box[bi + 1], Math.min(cx, box[bi + 3]));
  const ny = Math.max(box[bi + 2], Math.min(cy, box[bi + 4]));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

const cell = (v: number): number => Math.floor(v / CELL);
const cellKey = (gx: number, gy: number): number =>
  (gx + 4096) * 16384 + (gy + 4096);

const globals = globalThis as { performance?: { now(): number } };
const now = (): number => globals.performance?.now() ?? Date.now();
