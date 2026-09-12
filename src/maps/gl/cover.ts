// Which tiles a GL frame draws, and where.
//
// The same cover the retained renderer uses (`../proj.ts`'s `tileCover`),
// resolved against what is loaded. The difference is what a stand-in costs:
// the retained renderer scales an ancestor's *bitmap* over a hole, so a
// stand-in is blurry until the real tile lands; here an ancestor is the same
// geometry drawn at a larger scale, so a stand-in is exactly as sharp as its
// data. Overzoom is the same move with no hole in it — a z14 tile at zoom 20
// is the z14 tile, drawn 64 times bigger, with no sub-tiling and nothing
// rasterized — which is why this file has no overzoom code at all.
import { tileCover, transformFor } from '../proj.js';
import type { MapCamera, TileId, TilePyramid } from '../proj.js';
import type { GlTileData } from './buckets.js';
import type { RenderTile } from './renderer.js';

/** What the cover asks of a tile store: the tile's buckets, `null` when the
 *  source has no data there, `undefined` while it is still to come. */
export interface TileLookup {
  get(tile: TileId): GlTileData | null | undefined;
}

export interface CoverResult {
  tiles: RenderTile[];
  /** Tiles the view wants and the store has not answered for yet. */
  missing: TileId[];
  /** The pyramid level the view is drawn from. */
  level: number;
}

/** How far up the pyramid a hole looks for a stand-in. */
const MAX_ANCESTOR = 8;

/**
 * The frame's tiles, centre-out, each with its screen square and its clip.
 *
 * A hole — a tile still loading, or one the source has no data for — is
 * covered from whichever side has geometry: the nearest ancestor, drawn at
 * its own larger size and clipped to the hole; or, zooming out, the four
 * children, when all of them are in hand. `AGENTS.md`'s rule for the
 * retained cache holds here too: a pyramid has two neighbours.
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
  } = {},
): CoverResult {
  const transform = transformFor(camera, pane, pyramid.tileSize);
  const forced = options.level;
  const entries = tileCover(
    transform,
    forced === undefined
      ? pyramid
      : { ...pyramid, minZoom: forced, maxZoom: forced },
  );
  const tiles: RenderTile[] = [];
  const missing: TileId[] = [];
  const level = entries.length > 0 ? entries[0].tile.z : 0;

  for (const entry of entries) {
    const clip = {
      x: entry.x * scale,
      y: entry.y * scale,
      width: entry.size * scale,
      height: entry.size * scale,
    };
    const own = lookup.get(entry.tile);
    if (own === undefined) missing.push(entry.tile);
    if (own) {
      tiles.push({ data: own, x: clip.x, y: clip.y, size: clip.width, clip });
      continue;
    }
    // An ancestor: the same ground, `2^k` times the size, from `sub` cells
    // above and to the left of this entry's square.
    let found = false;
    const { z, x, y } = entry.tile;
    for (let k = 1; k <= MAX_ANCESTOR && z - k >= pyramid.minZoom; k++) {
      const ancestor = { z: z - k, x: x >> k, y: y >> k };
      const data = lookup.get(ancestor);
      if (!data) continue;
      const span = 1 << k;
      const size = clip.width * span;
      tiles.push({
        data,
        x: clip.x - (x - (ancestor.x << k)) * clip.width,
        y: clip.y - (y - (ancestor.y << k)) * clip.width,
        size,
        clip,
      });
      found = true;
      break;
    }
    if (found || own === null || z + 1 > pyramid.maxZoom) continue;
    // Zooming out: the finer level is what is in hand. Only when all four
    // children have answered, or the hole would be patched with holes.
    const children: (GlTileData | null)[] = [];
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const child = lookup.get({ z: z + 1, x: x * 2 + dx, y: y * 2 + dy });
        if (child === undefined) break;
        children.push(child);
      }
    }
    if (children.length !== 4) continue;
    const half = clip.width / 2;
    children.forEach((data, i) => {
      if (!data) return;
      const cx = clip.x + (i % 2) * half;
      const cy = clip.y + Math.floor(i / 2) * half;
      tiles.push({
        data,
        x: cx,
        y: cy,
        size: half,
        clip: { x: cx, y: cy, width: half, height: half },
      });
    });
  }
  return { tiles, missing, level };
}
