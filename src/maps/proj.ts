// Web Mercator, the slippy-map tile grid, and the camera — the arithmetic
// every other module here stands on, with no display anywhere in it.
//
// Three coordinate spaces, and knowing which one you are in is most of the
// correctness of a map:
//
//  1. **Geographic** — `{ lon, lat }` in WGS84 degrees, what an application
//     says and what a marker is placed at.
//  2. **Mercator** — `{ x, y }` normalized to the unit square, y increasing
//     *south*: the projection every provider's tiles are cut on
//     (EPSG:3857, "Web Mercator"). Kept normalized rather than in metres or
//     in pixels because it is the one space that does not depend on the
//     zoom, so a cached derivation of it stays valid across one.
//  3. **Screen** — logical pixels in the pane, which is where the camera
//     comes in.
//
// The screen conversion is deliberately written as *centre-relative*:
//
//     screenX = paneCentreX + (mx - centreMx) * worldSize
//
// and not as `mx * worldSize - centreMx * worldSize`. The two are the same
// number in exact arithmetic and not in float64: at zoom 20 `worldSize` is
// 5.4e8, so `mx * worldSize` for a point in Melbourne is ~4.1e8 and the
// spacing between representable doubles there is ~6e-8 pixels — fine — but
// the *difference* of two such products loses the low bits of both, and a
// building's wall ends up a wobbling half-pixel from where its neighbour's
// begins. Subtracting first keeps the small quantity small. Everything in
// this file that produces a pixel does it in that order, and
// {@link tileTransform} is the same trick again for a tile's own integers.

/** A geographic position, in WGS84 degrees. */
export interface LngLat {
  lon: number;
  lat: number;
}

/** A geographic rectangle. `west` may exceed `east` for a box that crosses
 *  the antimeridian. */
export interface LngLatBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** A position in normalized Web Mercator: both axes in `[0, 1]`, `y`
 *  increasing south. */
export interface MercatorPoint {
  x: number;
  y: number;
}

/** A tile's address in the slippy-map grid. */
export interface TileId {
  z: number;
  x: number;
  y: number;
}

/** Where the map is looking. `zoom` is fractional — the integer part picks
 *  the tile pyramid level, the fraction scales it. */
export interface MapCamera {
  center: LngLat;
  zoom: number;
}

/** A rectangle in pane-local logical pixels. */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The latitude Web Mercator can represent, `atan(sinh(pi))` in degrees.
 *
 * Not a rounding of 85: it is the exact latitude at which the projection's
 * `y` reaches 1, and clamping to anything larger produces a `y` outside the
 * unit square, which then addresses a tile row that does not exist. Every
 * projection entry point clamps to it.
 */
export const MAX_LATITUDE = 85.0511287798066;

/** WGS84's semi-major axis, in metres — what a scale bar is measured
 *  against. */
export const EARTH_RADIUS = 6378137;

/** The equator, in metres. */
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;

/** The tile size providers overwhelmingly serve vector tiles at. 256 is the
 *  older raster convention and is still common; both are supported per
 *  source, and this is only the default. */
export const DEFAULT_TILE_SIZE = 512;

const DEG = Math.PI / 180;

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Longitude folded into `[-180, 180)`. */
export function wrapLon(lon: number): number {
  if (lon >= -180 && lon < 180) return lon;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return wrapped;
}

// --- the projection --------------------------------------------------------

/** Longitude to normalized mercator `x`. Not wrapped: a caller drawing world
 *  copies wants to know it went past the edge. */
export function mercatorXFromLon(lon: number): number {
  return (180 + lon) / 360;
}

/** Latitude to normalized mercator `y`, clamped to {@link MAX_LATITUDE}. */
export function mercatorYFromLat(lat: number): number {
  const phi = clamp(lat, -MAX_LATITUDE, MAX_LATITUDE);
  return (
    (180 -
      (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + phi * DEG * 0.5))) /
    360
  );
}

export function lonFromMercatorX(x: number): number {
  return x * 360 - 180;
}

export function latFromMercatorY(y: number): number {
  return (360 / Math.PI) * Math.atan(Math.exp((180 - y * 360) * DEG)) - 90;
}

export function project(position: LngLat): MercatorPoint {
  return {
    x: mercatorXFromLon(position.lon),
    y: mercatorYFromLat(position.lat),
  };
}

export function unproject(point: MercatorPoint): LngLat {
  return { lon: lonFromMercatorX(point.x), lat: latFromMercatorY(point.y) };
}

/**
 * How much Mercator stretches distance at this latitude — `1 / cos(lat)`.
 *
 * The reason a scale bar cannot be a constant: one pixel is 156 km at the
 * equator on zoom 0 and 13 km at 85°N, on the same map.
 */
export function mercatorScale(lat: number): number {
  return 1 / Math.cos(clamp(lat, -MAX_LATITUDE, MAX_LATITUDE) * DEG);
}

/** Ground metres one logical pixel covers, at this latitude and zoom. */
export function metresPerPixel(
  lat: number,
  zoom: number,
  tileSize = DEFAULT_TILE_SIZE,
): number {
  return (
    (EARTH_CIRCUMFERENCE *
      Math.cos(clamp(lat, -MAX_LATITUDE, MAX_LATITUDE) * DEG)) /
    (tileSize * Math.pow(2, zoom))
  );
}

/**
 * Great-circle distance in metres, by the haversine formula.
 *
 * On the sphere rather than the WGS84 ellipsoid: the error is under 0.5%,
 * which is well inside what a map at any zoom can draw, and the ellipsoidal
 * form (Vincenty, Karney) is an iteration that a hover readout should not
 * be running per frame.
 */
export function distanceMetres(a: LngLat, b: LngLat): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const sLat = Math.sin(dLat / 2);
  const sLon = Math.sin(dLon / 2);
  const h =
    sLat * sLat + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * sLon * sLon;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

// --- the tile grid ---------------------------------------------------------

/** Tiles across the world at this zoom: `2^z`. */
export function tileCountAt(z: number): number {
  return Math.pow(2, z);
}

/** A tile column folded into `[0, 2^z)`. Longitude wraps and latitude does
 *  not, so this exists for `x` and has no counterpart for `y`. */
export function wrapTileX(x: number, z: number): number {
  const n = tileCountAt(z);
  return ((x % n) + n) % n;
}

/** The tile containing a position. */
export function tileOf(position: LngLat, z: number): TileId {
  const n = tileCountAt(z);
  const x = Math.floor(mercatorXFromLon(position.lon) * n);
  const y = Math.floor(mercatorYFromLat(position.lat) * n);
  return { z, x: wrapTileX(x, z), y: clamp(y, 0, n - 1) };
}

/** A tile's geographic extent. */
export function tileBounds(tile: TileId): LngLatBounds {
  const n = tileCountAt(tile.z);
  return {
    west: lonFromMercatorX(tile.x / n),
    east: lonFromMercatorX((tile.x + 1) / n),
    north: latFromMercatorY(tile.y / n),
    south: latFromMercatorY((tile.y + 1) / n),
  };
}

/** `z/x/y`, the key every cache here is keyed on. */
export function tileKey(tile: TileId): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

/** A tile's parent, or null at the root — how a missing tile is covered by
 *  the coarser one that is already loaded. */
export function parentTile(tile: TileId): TileId | null {
  if (tile.z <= 0) return null;
  return { z: tile.z - 1, x: tile.x >> 1, y: tile.y >> 1 };
}

/** Whether `outer` contains `inner` in the pyramid — the test behind
 *  covering a gap with an ancestor's pixels. */
export function tileContains(outer: TileId, inner: TileId): boolean {
  if (outer.z > inner.z) return false;
  const shift = inner.z - outer.z;
  return inner.x >> shift === outer.x && inner.y >> shift === outer.y;
}

// --- the camera ------------------------------------------------------------

/** Logical pixels across the whole world at this zoom. */
export function worldSize(zoom: number, tileSize = DEFAULT_TILE_SIZE): number {
  return tileSize * Math.pow(2, zoom);
}

/**
 * The camera resolved against a viewport: everything the projection needs,
 * computed once per frame instead of per point.
 *
 * `centerX`/`centerY` are the *mercator* centre and `paneX`/`paneY` the
 * pane-local pixel the camera looks at, which is what makes
 * {@link projectPoint} centre-relative.
 */
export interface Transform {
  centerX: number;
  centerY: number;
  zoom: number;
  tileSize: number;
  /** Pane size in logical pixels. */
  width: number;
  height: number;
  /** Where the centre lands — the middle of the pane. */
  paneX: number;
  paneY: number;
  /** `tileSize * 2^zoom`. */
  world: number;
}

export function transformFor(
  camera: MapCamera,
  size: { width: number; height: number },
  tileSize = DEFAULT_TILE_SIZE,
): Transform {
  const center = project(camera.center);
  return {
    centerX: center.x,
    centerY: center.y,
    zoom: camera.zoom,
    tileSize,
    width: size.width,
    height: size.height,
    paneX: size.width / 2,
    paneY: size.height / 2,
    world: worldSize(camera.zoom, tileSize),
  };
}

/** A mercator point in pane-local logical pixels. */
export function projectPoint(
  t: Transform,
  point: MercatorPoint,
): { x: number; y: number } {
  return {
    x: t.paneX + (point.x - t.centerX) * t.world,
    y: t.paneY + (point.y - t.centerY) * t.world,
  };
}

/** A geographic position in pane-local logical pixels, taking the nearest
 *  copy of the world so a marker just past the antimeridian draws beside the
 *  map rather than a world away from it. */
export function projectLngLat(
  t: Transform,
  position: LngLat,
): { x: number; y: number } {
  let mx = mercatorXFromLon(position.lon);
  // The camera is somewhere in `[0, 1)`; a point more than half a world away
  // in mercator is nearer in the other direction.
  const shift = Math.round(mx - t.centerX);
  mx -= shift;
  return projectPoint(t, { x: mx, y: mercatorYFromLat(position.lat) });
}

/** A pane-local pixel back to a geographic position. */
export function unprojectPoint(t: Transform, x: number, y: number): LngLat {
  const mx = t.centerX + (x - t.paneX) / t.world;
  const my = clamp(t.centerY + (y - t.paneY) / t.world, 0, 1);
  return { lon: wrapLon(lonFromMercatorX(mx)), lat: latFromMercatorY(my) };
}

/** What the pane can see, as geography. `west > east` when the view spans
 *  the antimeridian; a view wider than the world reports the whole of it. */
export function visibleBounds(t: Transform): LngLatBounds {
  const nw = unprojectPoint(t, 0, 0);
  const se = unprojectPoint(t, t.width, t.height);
  if (t.width >= t.world) {
    return { west: -180, east: 180, south: se.lat, north: nw.lat };
  }
  return { west: nw.lon, north: nw.lat, east: se.lon, south: se.lat };
}

// --- the cover -------------------------------------------------------------

/** What a source can serve, and at what size. */
export interface TilePyramid {
  minZoom: number;
  maxZoom: number;
  tileSize: number;
}

/** One tile the pane can see, and where it lands. */
export interface TileCoverEntry {
  /** The tile to load. `x` is wrapped into `[0, 2^z)`, so this is a cache
   *  key and `worldCopy` is what a screen position needs on top of it. */
  tile: TileId;
  /** Which copy of the world this instance is — 0 for the one containing the
   *  camera, ±1 for the repeats either side of the antimeridian. */
  worldCopy: number;
  /** Top-left in pane-local logical pixels. */
  x: number;
  y: number;
  /** Edge length on screen, in logical pixels. `tileSize` exactly when the
   *  zoom is integral and the pyramid is neither over- nor under-zoomed. */
  size: number;
  /** How far this tile is from the pane's centre, in logical pixels — what
   *  the centre-out load and draw order sorts on. */
  distance: number;
}

/** How the raster of a tile is sized, and what compositing it then costs. */
export interface TileRaster {
  /** Edge length of the tile's own surface, in **device** pixels. */
  size: number;
  /** `size / (tileSize * scale)` — the power of two the raster is above the
   *  tile's natural size, for an overzoomed pyramid. */
  factor: number;
}

/**
 * Which pyramid level serves a camera zoom.
 *
 * `floor` rather than `round`, which is the convention every slippy-map
 * client uses: a zoom of 14.9 is served by z14 tiles scaled up, and the
 * moment it crosses 15 the finer level takes over. Rounding instead would
 * load z15 at 14.5 and draw it at 0.7× — more data, downsampled.
 */
export function sourceZoomFor(
  zoom: number,
  pyramid: TilePyramid,
  overzoom = 0,
): number {
  return clamp(
    Math.floor(zoom),
    pyramid.minZoom,
    pyramid.maxZoom + Math.max(0, overzoom),
  );
}

/**
 * The tile whose **data** serves a tile the cover asked for.
 *
 * Itself, until the cover goes deeper than the pyramid does — past that,
 * its ancestor at the deepest level the source cuts. This is what makes
 * overzoom sharp rather than blurry: instead of drawing one z14 tile onto a
 * surface and stretching it sixty-four times, the cover asks for z20 tiles,
 * two hundred and fifty-six of them share that one z14 tile's data, and
 * each is rasterized at its own natural size. One fetch, one parse, and
 * detail limited by the data rather than by a bitmap.
 */
export function dataTileFor(tile: TileId, maxZoom: number): TileId {
  if (tile.z <= maxZoom) return tile;
  const down = tile.z - maxZoom;
  return { z: maxZoom, x: tile.x >> down, y: tile.y >> down };
}

/**
 * Where a tile sits inside the data tile that serves it: cell
 * `(x, y)` of a `span × span` grid, and `span` is 1 when the tile *is* its
 * own data.
 */
export function subTileOf(
  tile: TileId,
  maxZoom: number,
): { x: number; y: number; span: number } {
  if (tile.z <= maxZoom) return { x: 0, y: 0, span: 1 };
  const down = tile.z - maxZoom;
  const span = 1 << down;
  return {
    x: tile.x - ((tile.x >> down) << down),
    y: tile.y - ((tile.y >> down) << down),
    span,
  };
}

/**
 * How large to rasterize a tile whose pyramid level is `z` at camera `zoom`.
 *
 * The rule: **rasterize at the size the tile has at integer zoom, and let
 * the composite carry only the fraction.** `2^(zoom - z)` splits into
 * `2^(floor(zoom) - z)`, a power of two that goes into the raster, times
 * `2^frac(zoom)`, which is in `[1, 2)` and is a `drawImage` away. So a
 * pinch never re-rasterizes — the expensive half of the frame is the same
 * pixels at every zoom inside one level — and a tile is never composited at
 * more than 2× upscale unless the cap below is what stopped it.
 *
 * `maxSize` is that cap, and it is about memory rather than sharpness: an
 * argb32 surface is `4 * size²` bytes, so a 1024-pixel tile is 4 MB and a
 * screenful of them is a real number. Past the cap the raster stays where it
 * is and the composite upscales, which is the same trade a raster tile makes
 * when it is overzoomed.
 */
export function rasterFor(
  zoom: number,
  z: number,
  pyramid: TilePyramid,
  scale: number,
  maxSize: number,
): TileRaster {
  const natural = pyramid.tileSize * scale;
  const steps = Math.floor(zoom) - z;
  let factor = Math.pow(2, clamp(steps, -2, 2));
  while (factor > 1 && natural * factor > maxSize) factor /= 2;
  return { size: Math.max(1, Math.round(natural * factor)), factor };
}

/**
 * Every tile the pane can see, centre-out.
 *
 * `padding` grows the rectangle in logical pixels, which is how a ring of
 * tiles is kept warm so a pan has them before it needs them. The order is
 * the load order and the draw order both: the tile under the pointer is the
 * one whose arrival the user is waiting for.
 */
export function tileCover(
  t: Transform,
  pyramid: TilePyramid,
  padding = 0,
): TileCoverEntry[] {
  const z = sourceZoomFor(t.zoom, pyramid);
  const n = tileCountAt(z);
  // Screen size of one tile of this level. Not `t.tileSize`: an overzoomed
  // pyramid draws its coarse tiles larger, an underzoomed one smaller.
  const size = pyramid.tileSize * Math.pow(2, t.zoom - z);
  // The pane's edges as fractional tile coordinates. `centerX * n` is where
  // the camera sits in this level's grid.
  const fx = t.centerX * n;
  const fy = t.centerY * n;
  const left = fx - (t.paneX + padding) / size;
  const right = fx + (t.width - t.paneX + padding) / size;
  const top = fy - (t.paneY + padding) / size;
  const bottom = fy + (t.height - t.paneY + padding) / size;

  const yMin = Math.max(0, Math.floor(top));
  const yMax = Math.min(n - 1, Math.ceil(bottom) - 1);
  const xMin = Math.floor(left);
  const xMax = Math.ceil(right) - 1;

  const out: TileCoverEntry[] = [];
  // A pane wider than the world would otherwise ask for the same tile
  // hundreds of times over; three copies is what a view at zoom 0 can show.
  const span = Math.min(xMax - xMin, 3 * n - 1);
  for (let ix = xMin; ix <= xMin + span; ix++) {
    for (let iy = yMin; iy <= yMax; iy++) {
      const x = t.paneX + (ix - fx) * size;
      const y = t.paneY + (iy - fy) * size;
      const cx = x + size / 2 - t.paneX;
      const cy = y + size / 2 - t.paneY;
      out.push({
        tile: { z, x: wrapTileX(ix, z), y: iy },
        worldCopy: Math.floor(ix / n),
        x,
        y,
        size,
        distance: Math.sqrt(cx * cx + cy * cy),
      });
    }
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

/**
 * The affine that takes a tile's own integer coordinates to pane pixels:
 * `screenX = ox + local * k`.
 *
 * Two multiplies and an add per vertex, and — the point — the subtraction
 * that could lose precision happened once, here, on the tile's index rather
 * than on every one of its ten thousand vertices.
 */
export function tileTransform(
  entry: TileCoverEntry,
  extent: number,
): { ox: number; oy: number; k: number } {
  return { ox: entry.x, oy: entry.y, k: entry.size / extent };
}

/**
 * The camera that frames `bounds` in a viewport.
 *
 * `padding` is logical pixels kept clear on every side. A degenerate box — a
 * single point, or a set of markers all at one place — has no zoom that
 * frames it, so `maxZoom` is what it lands at rather than infinity.
 */
export function cameraForBounds(
  bounds: LngLatBounds,
  size: { width: number; height: number },
  options?: {
    padding?: number;
    tileSize?: number;
    minZoom?: number;
    maxZoom?: number;
  },
): MapCamera {
  const tileSize = options?.tileSize ?? DEFAULT_TILE_SIZE;
  const padding = options?.padding ?? 0;
  const minZoom = options?.minZoom ?? 0;
  const maxZoom = options?.maxZoom ?? 22;
  const west = mercatorXFromLon(bounds.west);
  let east = mercatorXFromLon(bounds.east);
  // A box written across the antimeridian (west 170, east -170) is 20° wide,
  // not 340°.
  if (east < west) east += 1;
  const north = mercatorYFromLat(bounds.north);
  const south = mercatorYFromLat(bounds.south);
  const dx = Math.max(east - west, 1e-12);
  const dy = Math.max(south - north, 1e-12);
  const usableW = Math.max(1, size.width - padding * 2);
  const usableH = Math.max(1, size.height - padding * 2);
  const zoom = clamp(
    Math.log2(Math.min(usableW / (dx * tileSize), usableH / (dy * tileSize))),
    minZoom,
    maxZoom,
  );
  const mx = (west + east) / 2;
  return {
    center: {
      lon: wrapLon(lonFromMercatorX(mx)),
      lat: latFromMercatorY((north + south) / 2),
    },
    zoom,
  };
}

/** The box that contains every position given, or null for none. Grows east
 *  rather than wrapping, so a set spanning the antimeridian comes back with
 *  `west > east` and {@link cameraForBounds} reads it the same way. */
export function boundsOf(positions: readonly LngLat[]): LngLatBounds | null {
  if (positions.length === 0) return null;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const p of positions) {
    const lon = wrapLon(p.lon);
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }
  // Two points either side of the antimeridian look 340° apart the long way
  // round and 20° apart the short way; the short way is what was meant.
  if (east - west > 180) {
    let w = Infinity;
    let e = -Infinity;
    for (const p of positions) {
      const lon = wrapLon(p.lon);
      const shifted = lon < 0 ? lon + 360 : lon;
      if (shifted < w) w = shifted;
      if (shifted > e) e = shifted;
    }
    if (e - w < east - west)
      return { west: wrapLon(w), east: wrapLon(e), south, north };
  }
  return { west, east, south, north };
}
