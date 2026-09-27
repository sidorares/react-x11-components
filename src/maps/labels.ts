// Labels: collected from the symbol layers, placed against each other, and
// drawn into the frame.
//
// Not into the tile surfaces, and the three reasons are each a visible bug
// if it is done the other way. **Collision is global**: two labels in
// different tiles overlap exactly as readily as two in one, so a per-tile
// placement produces clutter at every seam. **Text must not be scaled**: a
// tile surface is composited at up to 2× during a fractional zoom, and text
// is the one thing on a map nobody accepts blurred. And a tile's labels
// would be **clipped at its edge**, which is where half of them sit.
//
// **Where a label can go is the GL renderer's answer too**: both renderers
// take their anchors from `./anchors.ts` — a place name at its point, a
// street's name on a straight stretch of the street, its pieces merged
// first — so a map switched from one renderer to the other names the same
// streets in the same places, at the same angles.
//
// The placement itself is done in **world pixels** rather than screen
// pixels, and that is the load-bearing decision in this file. A placement
// computed against the viewport changes whenever the viewport does, so a
// pan would have to repaint the whole pane rather than blit it — and a
// label that was suppressed by a neighbour would pop in as that neighbour
// scrolled away. Placed in world pixels, whether a label wins depends only
// on the labels near it and the zoom, so a pan is a translation of a
// placement that is already correct, and the blit stands.
import {
  LABEL_STRIDE,
  LEVEL_SNAP,
  LINE_MARGIN,
  LabelField,
  STRAIGHT_FRACTION,
  buildTileLabels,
  estimateWidth,
} from './anchors.js';
import type { GlLabelData } from './anchors.js';
import type { MapCanvas } from './paint.js';
import type { VectorTile } from './mvt.js';
import type { PreparedStyle, PreparedLayer } from './paint.js';
import {
  DEFAULT_ICON_COLOR,
  DEFAULT_ICON_GLYPH_COLOR,
  DEFAULT_ICON_SIZE,
  ICON_GAP,
  isMapIcon,
  traceGlyph,
  tracePlate,
} from './icons.js';
import type { MapIcon } from './icons.js';
import { resolveZoomed } from './style.js';
import type { MapStyleLayer, SymbolLayer, Zoomed } from './style.js';
import type { TileId, Transform } from './proj.js';
import { tileCountAt, tileKey } from './proj.js';

/** ntk's font cache, structurally — the same slice `src/flow/draw.ts`
 *  names, for the same reason. */
export interface FontsLike {
  layout(
    content: string,
    style: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): {
    width: number;
    height: number;
    draw(ctx: unknown, x: number, y: number): void;
  };
}

/** One shaped string, kept between frames. Shaping is the expensive half of
 *  drawing text and a label does not change between frames. */
export interface ShapedLabel {
  width: number;
  height: number;
  layout: { draw(ctx: unknown, x: number, y: number): void };
}

/**
 * A label that could be drawn.
 *
 * `mx`/`my` are normalized mercator, so a candidate outlives every camera
 * move — it is a property of the data, and collected once per tile per
 * zoom. So are the lengths a name along a street is fitted with.
 */
export interface LabelCandidate {
  /** Stable for the life of the tile, which is what lets a placement be
   *  compared frame to frame. */
  id: string;
  /** `layer|text` — what the repeat-distance rule counts as "the same
   *  label". Keyed on the layer as well as the text so that a street and a
   *  place of the same name do not suppress each other. */
  key: string;
  text: string;
  mx: number;
  my: number;
  /** The baseline's direction, radians, y down: `0` for a point label, and
   *  along its street — always upright — for a street name. */
  angle: number;
  /** A street name's room: the straight run either side of the anchor, the
   *  distance to the nearest junction, the run's length and how far it
   *  bends from straight — normalized mercator, so a placement at any zoom
   *  reads them in its own pixels. `Infinity`, `Infinity`, `0`, `0` for a
   *  point label, which fits anywhere. */
  avail: number;
  clear: number;
  length: number;
  dev: number;
  /** Layer-wide priority; higher wins a collision. */
  rank: number;
  /** Importance within the layer — a road's class, a place's population —
   *  which breaks a tie in rank. */
  priority: number;
  /** Logical pixels. */
  size: number;
  color: string;
  halo: string | undefined;
  haloWidth: number;
  /** Pixels within which this text may not repeat. */
  repeat: number;
  /** The icon on the point, where the layer sets one — absent, or null, for
   *  a label that is text alone and for every name along a street. */
  icon?: LabelIcon | null;
}

/** A point label's icon at a zoom: logical pixels across, and colours. */
export interface LabelIcon {
  name: MapIcon;
  size: number;
  color: string;
  glyph: string;
}

/** A candidate that won its place, with the box it occupies in world
 *  pixels at the zoom it was placed for — its turned text's bounding box.
 *  Not shaped: the placement covers every tile loaded, most of it outside
 *  the pane, and a label is shaped when it is first drawn. */
export interface PlacedLabel extends LabelCandidate {
  /** World pixels: `mercator × worldSize`. */
  wx: number;
  wy: number;
  width: number;
  height: number;
  /** How far right of the anchor the box's centre is, in world pixels: half
   *  the icon and the gap, for a name set beside an icon; 0 otherwise. */
  ox?: number;
}

function num<T extends number>(
  value: Zoomed<T> | undefined,
  zoom: number,
  fallback: number,
): number {
  return value === undefined ? fallback : resolveZoomed(value, zoom);
}

/** The tile units anchors are worked out in: the GL buckets', so the two
 *  renderers' anchors are the same numbers. */
const EXTENT = 4096;

/**
 * Anchors, per tile and style. They depend on neither the zoom nor the
 * camera, and merging a tile's street pieces is the one costly step, so a
 * zoom that collects a tile's candidates again does not work them out
 * again.
 */
const anchorCache = new WeakMap<
  VectorTile,
  { prepared: PreparedStyle; data: GlLabelData }
>();

function anchorsOf(
  tile: VectorTile,
  prepared: PreparedStyle,
  id: TileId,
): GlLabelData {
  const hit = anchorCache.get(tile);
  if (hit && hit.prepared === prepared) return hit.data;
  const data = buildTileLabels(tile, prepared, EXTENT, id);
  anchorCache.set(tile, { prepared, data });
  return data;
}

/** A symbol layer's labelling at a zoom, or null where it does not label. */
interface LayerPaint {
  id: string;
  size: number;
  color: string;
  halo: string | undefined;
  haloWidth: number;
  rank: number;
  repeat: number;
  icon: LabelIcon | null;
}

function paintAt(
  layer: MapStyleLayer | undefined,
  zoom: number,
): LayerPaint | null {
  if (!layer || layer.type !== 'symbol' || layer.visible === false) {
    return null;
  }
  if (layer.minZoom !== undefined && zoom < layer.minZoom) return null;
  if (layer.maxZoom !== undefined && zoom >= layer.maxZoom) return null;
  const symbol = layer as SymbolLayer;
  return {
    id: layer.id,
    size: num(symbol.textSize, zoom, 12),
    color: symbol.textColor ? resolveZoomed(symbol.textColor, zoom) : '#000000',
    halo: symbol.textHaloColor
      ? resolveZoomed(symbol.textHaloColor, zoom)
      : undefined,
    haloWidth: num(symbol.textHaloWidth, zoom, 1),
    rank: symbol.rank ?? 0,
    repeat: symbol.repeatDistance ?? 250,
    icon: isMapIcon(symbol.icon)
      ? {
          name: symbol.icon,
          size: num(symbol.iconSize, zoom, DEFAULT_ICON_SIZE),
          color: symbol.iconColor
            ? resolveZoomed(symbol.iconColor, zoom)
            : DEFAULT_ICON_COLOR,
          glyph: symbol.iconGlyphColor
            ? resolveZoomed(symbol.iconGlyphColor, zoom)
            : DEFAULT_ICON_GLYPH_COLOR,
        }
      : null,
  };
}

/**
 * The label candidates one tile contributes: its anchors (`./anchors.ts`),
 * with this zoom's size and colours. A point label anchors at its point,
 * an area's at the middle of its largest ring, and a street's name at the
 * middle of a straight stretch of the street — or of a block of it —
 * turned to lie along it.
 */
export function collectLabels(
  tile: VectorTile,
  id: TileId,
  prepared: PreparedStyle,
  zoom: number,
): LabelCandidate[] {
  const out: LabelCandidate[] = [];
  const data = anchorsOf(tile, prepared, id);
  const n = tileCountAt(id.z);
  const key = tileKey(id);
  // Tile units to normalized mercator.
  const unit = 1 / (EXTENT * n);
  const paints = new Map<number, LayerPaint | null>();
  const a = data.anchors;
  for (let r = 0; r < data.count; r++) {
    const at = r * LABEL_STRIDE;
    const index = a[at + LabelField.layer];
    let paint = paints.get(index);
    if (paint === undefined) {
      paint = paintAt(prepared.layers[index]?.layer, zoom);
      paints.set(index, paint);
    }
    if (!paint) continue;
    const text = data.texts[a[at + LabelField.text]];
    const point = a[at + LabelField.avail] < 0;
    out.push({
      id: `${key}:${paint.id}:${r}`,
      key: `${paint.id}|${text}`,
      text,
      // Tile-local to normalized mercator, the same arithmetic the
      // rasterizer's transform does and for the same precision reason.
      mx: (id.x + a[at + LabelField.x] / EXTENT) / n,
      my: (id.y + a[at + LabelField.y] / EXTENT) / n,
      angle: point ? 0 : a[at + LabelField.angle],
      avail: point ? Infinity : a[at + LabelField.avail] * unit,
      clear: point ? Infinity : a[at + LabelField.clear] * unit,
      length: a[at + LabelField.length] * unit,
      dev: a[at + LabelField.dev] * unit,
      rank: paint.rank,
      priority: a[at + LabelField.priority],
      size: paint.size,
      color: paint.color,
      halo: paint.halo,
      haloWidth: paint.haloWidth,
      repeat: paint.repeat,
      icon: point ? paint.icon : null,
    });
  }
  return out;
}

/** What a string measures, in logical pixels — all placement needs of it. */
interface LabelMetrics {
  width: number;
  height: number;
}

/**
 * A cache bounded in **two generations** rather than by clearing: what was
 * stored since the last turn is the young one, a lookup that finds an entry
 * in the old one brings it back, and a full young generation becomes the
 * old one as the old one is dropped. So what is in use survives the turn,
 * and the bound is twice a generation.
 */
class Generations<V> {
  private _young = new Map<string, V>();
  private _old = new Map<string, V>();
  constructor(private readonly _size: number) {}

  get(key: string): V | undefined {
    const hit = this._young.get(key);
    if (hit !== undefined) return hit;
    const kept = this._old.get(key);
    if (kept !== undefined) this.set(key, kept);
    return kept;
  }

  set(key: string, value: V): void {
    if (this._young.size >= this._size) {
      this._old = this._young;
      this._young = new Map();
    }
    this._young.set(key, value);
  }

  clear(): void {
    this._young = new Map();
    this._old = new Map();
  }
}

/** Shaped strings a generation holds. Each is a layout the text engine
 *  keeps — a native one under CoreText — so this is the bound that
 *  matters, and it is the one the cache always had. */
const SHAPED_GENERATION = 2000;
/** Measurements a generation holds: two numbers each, so many more of
 *  them, enough for every label of a zoom across the levels. */
const MEASURED_GENERATION = 8000;

/**
 * Cache of shaped strings, owned by the element — and of what they
 * measure, which is kept apart and far longer.
 *
 * Placement asks the size of every candidate on the map, most of which
 * are never drawn, and it asks again at every step of a zoom; drawing
 * needs the layouts of the few hundred that won their place. With one
 * cache for both, bounded by clearing it, a wheel zoom through six levels —
 * some 8,000 strings, every label of every level at its own size and in
 * its halo's colour — crossed the bound every few hundred milliseconds and
 * threw away what the next placement needed: 43,000 strings shaped in four
 * seconds, the worst frames of the zoom spent on text it had shaped
 * already. Measurements now outlive the layouts they were read from, and
 * both caches turn over in generations (`Generations`).
 */
export class LabelShaper {
  private readonly _shaped = new Generations<ShapedLabel>(SHAPED_GENERATION);
  private readonly _measured = new Generations<LabelMetrics>(
    MEASURED_GENERATION,
  );
  /** What each placed label was drawn with, text and halo: kept with the
   *  placement, so a pan's frames, which draw one placement over and over,
   *  look nothing up. */
  private _drawn = new WeakMap<PlacedLabel, ShapedLabel>();
  private _haloed = new WeakMap<PlacedLabel, ShapedLabel>();
  private _fonts: FontsLike | null;
  private _family: string;
  /** Device pixels per logical pixel. Text is shaped at the device size the
   *  panel wants, exactly as core shapes a `<text>` — a label on a retina
   *  screen is sharper, not bigger. */
  private _scale: number;

  constructor(fonts: FontsLike | null, family: string, scale: number) {
    this._fonts = fonts;
    this._family = family;
    this._scale = scale;
  }

  /** Re-point at a new font manager, face or scale, dropping what was
   *  shaped for the old one. */
  reconfigure(fonts: FontsLike | null, family: string, scale: number): void {
    if (
      this._fonts === fonts &&
      this._family === family &&
      this._scale === scale
    ) {
      return;
    }
    this._fonts = fonts;
    this._family = family;
    this._scale = scale;
    this._shaped.clear();
    this._measured.clear();
    this._drawn = new WeakMap();
    this._haloed = new WeakMap();
  }

  /** The layout a placed label's text is drawn with — or, with `halo`, its
   *  halo's — or null on a backend with no font manager. */
  drawn(label: PlacedLabel, halo = false): ShapedLabel | null {
    const kept = halo ? this._haloed : this._drawn;
    const hit = kept.get(label);
    if (hit) return hit;
    const color = halo ? label.halo : label.color;
    if (color === undefined) return null;
    const shaped = this.shape(label.text, label.size, color);
    if (shaped) kept.set(label, shaped);
    return shaped;
  }

  /** What one label measures, logical pixels, or null on a backend with no
   *  font manager — shaped only when it has never been measured. A string
   *  measures the same in any colour, so a name and its halo share it.
   *
   *  The layout it was measured from is not kept: most candidates never
   *  win a place, and theirs would push the layouts of the ones that did
   *  out of the cache drawing reads from. */
  measure(text: string, size: number, color: string): LabelMetrics | null {
    const key = `${this._family}|${size}|${text}`;
    const hit = this._measured.get(key);
    if (hit) return hit;
    const shaped = this._shapeNow(text, size, color);
    if (!shaped) return null;
    const metrics = { width: shaped.width, height: shaped.height };
    this._measured.set(key, metrics);
    return metrics;
  }

  /** Shape one label, or null on a backend with no font manager. Widths
   *  come back in **logical** pixels, which is what placement is in. */
  shape(text: string, size: number, color: string): ShapedLabel | null {
    const fonts = this._fonts;
    if (!fonts) return null;
    const key = `${this._family}|${size}|${color}|${text}`;
    const hit = this._shaped.get(key);
    if (hit) return hit;
    const shaped = this._shapeNow(text, size, color);
    if (shaped) this._shaped.set(key, shaped);
    return shaped;
  }

  private _shapeNow(
    text: string,
    size: number,
    color: string,
  ): ShapedLabel | null {
    const fonts = this._fonts;
    if (!fonts) return null;
    const layout = fonts.layout(text, {
      family: this._family,
      size: size * this._scale,
      weight: 400,
      style: 'normal',
      color,
    });
    return {
      width: layout.width / this._scale,
      height: layout.height / this._scale,
      layout,
    };
  }
}

/** A street name is set level — on whole pixels, which is sharper — when
 *  its street is this close to level. */
function levelled(angle: number): number {
  return Math.abs(angle) < LEVEL_SNAP ? 0 : angle;
}

/**
 * Place candidates against each other, in world pixels.
 *
 * Greedy, which is what every map does: sort, and take a label if it fits
 * where it is and nothing already taken overlaps it. The order is the GL
 * renderer's, less what depends on the view: rank, then importance within
 * the layer, then a street name that clears its junctions over one that
 * would cover a crossing street, then the longer straight run. It has to be
 * **total and stable** — the candidate's id last — because a tie broken by
 * array order would flicker as tiles arrived in a different order.
 *
 * A street name fits where the GL renderer says one does: on a stretch
 * straight enough for its size, and long enough for all of it.
 */
export function placeLabels(
  candidates: readonly LabelCandidate[],
  worldSize: number,
  shaper: LabelShaper,
  options?: { padding?: number },
): PlacedLabel[] {
  const padding = options?.padding ?? 2;
  const clean = (c: LabelCandidate): number =>
    c.clear * worldSize >= estimateWidth(c.text, c.size) / 2 ? 1 : 0;
  const sorted = [...candidates]
    .map((c) => ({ c, clean: clean(c) }))
    .sort(
      (a, b) =>
        b.c.rank - a.c.rank ||
        b.c.priority - a.c.priority ||
        b.clean - a.clean ||
        b.c.length - a.c.length ||
        (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0),
    )
    .map((entry) => entry.c);
  const placed: PlacedLabel[] = [];
  // A sparse grid over world pixels. The cell is sized for the labels
  // themselves, so a box touches one or two cells and a collision test is a
  // handful of comparisons rather than a scan of everything placed.
  const CELL = 64;
  const grid = new Map<number, PlacedLabel[]>();
  const cellKey = (cx: number, cy: number): number => cx * 0x40000 + cy;
  /** Where each distinct text has already been placed, for the
   *  repeat-distance rule. */
  const byText = new Map<string, { wx: number; wy: number }[]>();

  for (const candidate of sorted) {
    // Bent under its size at this zoom: not a stretch to set a name on.
    if (candidate.dev * worldSize > candidate.size * STRAIGHT_FRACTION) {
      continue;
    }
    const wx = candidate.mx * worldSize;
    const wy = candidate.my * worldSize;
    // The repeat test first, because it is the cheapest one and because it
    // is what rejects most of a street layer: a long street offers its name
    // every block, none of them overlapping. Ahead of the shaping, which it
    // does not need — a street's every block shaped its name, and a wheel
    // zoom re-places at every step, so that was thousands of strings a
    // frame asked of the cache.
    if (candidate.repeat > 0) {
      const already = byText.get(candidate.key);
      if (already) {
        const limit = candidate.repeat * candidate.repeat;
        let tooClose = false;
        for (const at of already) {
          const dx = at.wx - wx;
          const dy = at.wy - wy;
          if (dx * dx + dy * dy < limit) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;
      }
    }
    const measured = shaper.measure(
      candidate.text,
      candidate.size,
      candidate.color,
    );
    if (!measured) return placed; // no font manager: nothing can be measured
    // Longer than the straight stretch it would sit on, with a margin past
    // each end: it would hang off the street, over whatever the street
    // turns into.
    const need = measured.width / 2 + measured.height * LINE_MARGIN;
    if (candidate.avail * worldSize < need) continue;
    // The turned text's bounding box: what it covers, as far as another
    // label can tell. With an icon, the box around the icon on the point
    // and the text beside it — the two give way as one, or a stop's name
    // would be set with nothing to say it is a stop.
    const angle = levelled(candidate.angle);
    const icon = candidate.icon ?? null;
    let w = measured.width + padding * 2;
    let h = measured.height + padding * 2;
    let ox = 0;
    if (icon) {
      const full = icon.size + ICON_GAP + measured.width;
      ox = (full - icon.size) / 2;
      w = full + padding * 2;
      h = Math.max(icon.size, measured.height) + padding * 2;
    }
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const width = w * cos + h * sin;
    const height = w * sin + h * cos;
    const left = wx + ox - width / 2;
    const top = wy - height / 2;
    const x0 = Math.floor(left / CELL);
    const x1 = Math.floor((left + width) / CELL);
    const y0 = Math.floor(top / CELL);
    const y1 = Math.floor((top + height) / CELL);
    let free = true;
    for (let cx = x0; cx <= x1 && free; cx++) {
      for (let cy = y0; cy <= y1 && free; cy++) {
        const bucket = grid.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const other of bucket) {
          const otherLeft = other.wx + (other.ox ?? 0) - other.width / 2;
          const otherTop = other.wy - other.height / 2;
          if (
            left < otherLeft + other.width &&
            left + width > otherLeft &&
            top < otherTop + other.height &&
            top + height > otherTop
          ) {
            free = false;
            break;
          }
        }
      }
    }
    if (!free) continue;
    const entry: PlacedLabel = {
      ...candidate,
      angle,
      wx,
      wy,
      ox,
      width,
      height,
    };
    placed.push(entry);
    if (candidate.repeat > 0) {
      const already = byText.get(candidate.key);
      if (already) already.push({ wx, wy });
      else byText.set(candidate.key, [{ wx, wy }]);
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const at = cellKey(cx, cy);
        const bucket = grid.get(at);
        if (bucket) bucket.push(entry);
        else grid.set(at, [entry]);
      }
    }
  }
  return placed;
}

/**
 * Draw the placed labels that land in the pane.
 *
 * The halo is the same string shaped a second time in the halo colour and
 * drawn four times around the glyphs, rather than a real outline: ntk has
 * no glyph-outline stroke, and both runs are cached, so a label costs five
 * composites of two shaped runs. That is cheap for the few dozen labels a
 * pane holds and it is the difference between a place name that is
 * readable over a motorway and one that is not.
 *
 * A level label is drawn on whole device pixels. A street name along its
 * street is drawn turned about its centre, where the context can turn —
 * and level where it cannot, on a context with no transform.
 */
export function drawLabels(
  ctx: MapCanvas,
  placed: readonly PlacedLabel[],
  transform: Transform,
  pane: { x: number; y: number; width: number; height: number },
  scale: number,
  clip: { x: number; y: number; width: number; height: number } | null,
  shaper: LabelShaper,
): number {
  let drawn = 0;
  const world = transform.world;
  const originX = pane.x + transform.paneX - transform.centerX * world;
  const originY = pane.y + transform.paneY - transform.centerY * world;
  const turns = typeof ctx.rotate === 'function' && !!ctx.translate;
  for (const label of placed) {
    const cx = originX + label.wx;
    const cy = originY + label.wy;
    // The box's centre, which is right of the point where an icon is on it.
    const bx = cx + (label.ox ?? 0);
    const halfW = label.width / 2;
    const halfH = label.height / 2;
    if (
      bx + halfW < pane.x ||
      cy + halfH < pane.y ||
      bx - halfW > pane.x + pane.width ||
      cy - halfH > pane.y + pane.height
    ) {
      continue;
    }
    if (
      clip &&
      (bx + halfW < clip.x ||
        cy + halfH < clip.y ||
        bx - halfW > clip.x + clip.width ||
        cy - halfH > clip.y + clip.height)
    ) {
      continue;
    }
    // Shaped here, for the labels in the pane: the few hundred a frame
    // draws, where the placement holds every name on the tiles loaded.
    const shaped = shaper.drawn(label);
    if (!shaped) continue;
    const { width, height } = shaped;
    const icon = label.icon ?? null;
    const turned = !icon && label.angle !== 0 && turns;
    const haloed = label.halo !== undefined && label.haloWidth > 0;
    let dx: number;
    let dy: number;
    if (icon) {
      // The icon on the point, and the name level beside it.
      drawIcon(
        ctx,
        icon,
        Math.round(cx * scale),
        Math.round(cy * scale),
        icon.size * scale,
        haloed ? label.halo : undefined,
        Math.max(1, Math.round(label.haloWidth * scale)),
      );
      dx = Math.round((cx + icon.size / 2 + ICON_GAP) * scale);
      dy = Math.round((cy - height / 2) * scale);
    } else if (turned) {
      ctx.save();
      ctx.translate!(cx * scale, cy * scale);
      ctx.rotate!(label.angle);
      dx = (-width * scale) / 2;
      dy = (-height * scale) / 2;
    } else {
      dx = Math.round((cx - width / 2) * scale);
      dy = Math.round((cy - height / 2) * scale);
    }
    if (label.halo !== undefined && label.haloWidth > 0) {
      const halo = shaper.drawn(label, true);
      if (halo) {
        const offset = Math.max(1, Math.round(label.haloWidth * scale));
        halo.layout.draw(ctx, dx - offset, dy);
        halo.layout.draw(ctx, dx + offset, dy);
        halo.layout.draw(ctx, dx, dy - offset);
        halo.layout.draw(ctx, dx, dy + offset);
      }
    }
    shaped.layout.draw(ctx, dx, dy);
    if (turned) ctx.restore();
    drawn++;
  }
  return drawn;
}

/**
 * An icon on its point, in device pixels: the plate, over a plate of the
 * halo's colour a halo wider where the layer has one — the same ground a
 * name's halo gives it over a road — and the glyph on the plate.
 */
function drawIcon(
  ctx: MapCanvas,
  icon: LabelIcon,
  x: number,
  y: number,
  size: number,
  halo: string | undefined,
  reach: number,
): void {
  ctx.save();
  if (halo !== undefined) {
    ctx.fillStyle = halo;
    ctx.beginPath();
    tracePlate(ctx, x, y, size + reach * 2);
    ctx.fill();
  }
  ctx.fillStyle = icon.color;
  ctx.beginPath();
  tracePlate(ctx, x, y, size);
  ctx.fill();
  ctx.fillStyle = icon.glyph;
  ctx.beginPath();
  traceGlyph(ctx, icon.name, x, y, size);
  ctx.fill();
  ctx.restore();
}

export type { PreparedLayer };
