// Which tiles a GL frame draws, and where.
//
// The same cover the retained renderer uses (`../proj.ts`'s `tileCover`),
// resolved against what is loaded. The difference is what a stand-in costs:
// the retained renderer scales an ancestor's *bitmap* over a hole, so a
// stand-in is blurry until the real tile lands; here an ancestor is the same
// geometry drawn at a larger scale, so a stand-in is exactly as sharp as its
// data. Overzoom is the same move with no hole in it — a z14 tile at zoom 20
// is the z14 tile, drawn 64 times bigger, with no sub-tiling and nothing
// rasterized — which is why this file has no overzoom code at all. A raster
// tile past its source's depth is the same move again: its data tile, drawn
// whole and stretched over its own square.
//
// **The grid is laid out on the projection's world**, `512 · 2^zoom`, and
// not on the source's tile size. That is react-x11-components#65 again, and
// the proof of concept had it back: a 256-pixel raster source laid out on a
// 256-pixel world lands at half the size of everything placed with the
// projection — markers, overlays, labels, `project()`. `tileCover` reads a
// smaller tile one level deeper instead, which puts every image at its own
// natural size on the one world everything shares.
import {
  BELOW,
  DEFAULT_TILE_SIZE,
  FILL_DEPTH,
  fillFromBelow,
  tileCover,
  transformFor,
} from '../proj.js';
import type { MapCamera, TileId, TilePyramid } from '../proj.js';
import type { GlTileData } from './buckets.js';
import type { RenderTile } from './renderer.js';

/** What the cover asks of a tile store: the tile's data, `null` when the
 *  source has no data there, `undefined` while it is still to come. */
export interface TileLookup {
  get(tile: TileId): GlTileData | null | undefined;
  /**
   * What the store has answered for at or under a tile: `'here'` for the
   * tile itself, `'below'` for only tiles under it — within `FILL_DEPTH`
   * levels — and `undefined` for neither.
   *
   * What lets a hole's search for pieces skip the parts of the pyramid that
   * hold nothing. Without it the search asks `get` for every tile down to
   * that depth — which costs lookups, and stamps a tile still loading as
   * used, so a load the view has left is not cancelled.
   */
  holds?(tile: TileId): 'here' | 'below' | undefined;
}

export interface CoverResult {
  tiles: RenderTile[];
  /** Tiles the view wants and the store has not answered for yet — the
   *  padded ring around the view included, so a pan finds its tiles. */
  missing: TileId[];
  /** The pyramid level the view is drawn from. */
  level: number;
  /** Tiles of the view drawn from their own data, from an ancestor's, and
   *  from their children's — the retained renderer's `ready`,
   *  `fromAncestor` and `fromDescendant`. */
  own: number;
  ancestors: number;
  descendants: number;
  /** Tiles of the view, stand-ins or not: its cover, less the padded ring. */
  inView: TileId[];
}

/** How far up the pyramid a hole looks for a stand-in. */
const MAX_ANCESTOR = 8;

/**
 * The frame's tiles, centre-out, each with its screen square and its clip.
 *
 * A hole — a tile still loading, or one the source has no data for — is
 * covered from whichever side has geometry. Zooming out, that is the tiles
 * under it: each quarter from the nearest level that has it, down to
 * `FILL_DEPTH`. Whatever they leave, and the whole of a hole with nothing
 * under it, is the nearest ancestor's, drawn at its own larger size and
 * clipped to each gap. `AGENTS.md`'s rule for the retained cache holds here
 * too: a pyramid has two neighbours.
 *
 * The first cut tried the ancestor first, and the children only when all
 * four of them were in hand. A zoom out leaves the level it came from in
 * the middle of the view, covering only part of the tiles at the edges, and
 * a quick one leaves it two or three levels down: both were the background,
 * with the sharper tiles in hand.
 */
export function renderCover(
  camera: MapCamera,
  pane: { width: number; height: number },
  scale: number,
  pyramid: TilePyramid,
  lookup: TileLookup,
  options: {
    /**
     * Draw the view from this pyramid level rather than the one its zoom
     * picks — the level being faded out, or a coarser one while adaptive
     * quality is saving work. Holes still borrow from the whole pyramid.
     */
    level?: number;
    /**
     * Logical pixels of tiles to ask for around the view, which are wanted
     * — so they load, and a load in flight for one is not given up — and
     * not drawn. The retained renderer keeps the same ring warm.
     */
    padding?: number;
  } = {},
): CoverResult {
  const transform = transformFor(camera, pane, DEFAULT_TILE_SIZE);
  const forced = options.level;
  const entries = tileCover(
    transform,
    forced === undefined
      ? pyramid
      : { ...pyramid, minZoom: forced, maxZoom: forced },
    options.padding ?? 0,
  );
  const tiles: RenderTile[] = [];
  const missing: TileId[] = [];
  const inView: TileId[] = [];
  const level = entries.length > 0 ? entries[0].tile.z : 0;
  let own = 0;
  let ancestors = 0;
  let descendants = 0;

  for (const entry of entries) {
    const clip = {
      x: entry.x * scale,
      y: entry.y * scale,
      width: entry.size * scale,
      height: entry.size * scale,
    };
    const data = lookup.get(entry.tile);
    if (data === undefined) missing.push(entry.tile);
    const visible =
      entry.x < pane.width &&
      entry.y < pane.height &&
      entry.x + entry.size > 0 &&
      entry.y + entry.size > 0;
    // The padded ring is wanted, and that is all.
    if (!visible) continue;
    inView.push(entry.tile);
    if (data) {
      tiles.push({ data, x: clip.x, y: clip.y, size: clip.width, clip });
      own++;
      continue;
    }
    // Under it: a tile with no data has nothing under it either, and past
    // the pyramid's depth there is nothing to find.
    const { z, x, y } = entry.tile;
    const below = fillFromBelow(
      entry.tile,
      data === null ? 0 : Math.min(FILL_DEPTH, pyramid.maxZoom - z),
      (under) => {
        const held = lookup.holds ? lookup.holds(under) : 'here';
        if (held === undefined) return undefined;
        if (held === 'below') return BELOW;
        const got = lookup.get(under);
        return got === undefined ? BELOW : got;
      },
    );
    for (const piece of below.pieces) {
      const size = clip.width / piece.span;
      const px = clip.x + piece.x * size;
      const py = clip.y + piece.y * size;
      tiles.push({
        data: piece.value,
        x: px,
        y: py,
        size,
        clip: { x: px, y: py, width: size, height: size },
      });
    }
    if (below.covered) descendants++;
    if (below.gaps.length === 0) continue;
    // Over it: an ancestor, the same ground `2^k` times the size, from
    // `sub` cells above and to the left of this entry's square — drawn once
    // for each gap, clipped to it.
    for (let k = 1; k <= MAX_ANCESTOR && z - k >= pyramid.minZoom; k++) {
      const ancestor = { z: z - k, x: x >> k, y: y >> k };
      const stand = lookup.get(ancestor);
      if (!stand) continue;
      const size = clip.width * (1 << k);
      const sx = clip.x - (x - (ancestor.x << k)) * clip.width;
      const sy = clip.y - (y - (ancestor.y << k)) * clip.width;
      for (const gap of below.gaps) {
        const edge = clip.width / gap.span;
        tiles.push({
          data: stand,
          x: sx,
          y: sy,
          size,
          clip: {
            x: clip.x + gap.x * edge,
            y: clip.y + gap.y * edge,
            width: edge,
            height: edge,
          },
        });
      }
      ancestors++;
      break;
    }
  }
  return { tiles, missing, level, own, ancestors, descendants, inView };
}
