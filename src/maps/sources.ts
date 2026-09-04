// Where tiles come from — and, deliberately, not how they are fetched.
//
// **Nothing in this package makes a network request.** That is the same
// call `src/html/` makes about `onResource` and `src/desktop-calendar/`
// makes about credentials, and it is the rule rather than an omission: a
// component that quietly fetched would turn "render this map" into "make
// these requests to this company", with the map's own default deciding
// whose servers an application talks to, what its user agent says, and
// whose usage policy it is now bound by. A tile source is a function the
// application supplies, and the adapters below are the *arguments* to it —
// URL templates and a decoder — not a fetch.
//
// {@link osmVectorSource} and {@link osmRasterSource} exist because the two
// keyless, open, canonical OpenStreetMap endpoints are what make
// `<Map source={…} />` a line that works with no signup; both still take
// the application's own `load`, and both carry the attribution the licence
// requires.
import { gunzipIfNeeded } from './gzip.js';
import { parseTile } from './mvt.js';
import type { VectorTile } from './mvt.js';
import { DEFAULT_TILE_SIZE } from './proj.js';
import type { TileId } from './proj.js';

/** Which tile a source is being asked for. */
export interface TileRequest extends TileId {
  /** The source's own id, for an application serving several from one
   *  loader. */
  sourceId: string;
  /**
   * Aborted when the tile leaves the view before it arrives.
   *
   * **This is a real `AbortSignal`** on every runtime that has one, which
   * is what makes `fetch(url, { signal })` work — `fetch` rejects anything
   * that is not an instance of it (`TypeError: Expected signal … to be an
   * instance of AbortSignal`), so a look-alike would fail every load.
   * `undefined` on a runtime with no `AbortController`.
   *
   * It is *typed* structurally because `src/` compiles with no DOM lib and
   * cannot name the class, which is why an application in TypeScript casts:
   * `fetch(url, { signal: signal as AbortSignal })`.
   */
  signal: { readonly aborted: boolean; addEventListener?: unknown } | undefined;
}

/** Raw tile bytes, or pixels, or nothing. */
export type TileData =
  /** Mapbox Vector Tile bytes. Gzip is unwrapped for you, so either the
   *  compressed or the decompressed body is fine. */
  | { kind: 'vector'; data: Uint8Array }
  /**
   * Decoded pixels: straight (non-premultiplied) RGBA, rows top to bottom
   * — the canvas contract, and what ntk's own `decodeImage` produces.
   *
   * Bytes rather than a PNG or a JPEG on purpose. Decoding an image format
   * needs a codec, and this package will not grow one or assume which of
   * them a provider serves; the application already has ntk's, through
   * `react-x11/ntk`, and the docs page has the four-line adapter.
   */
  | { kind: 'raster'; width: number; height: number; data: Uint8Array }
  /** There is no tile here. An ordinary state — an ocean tile in a
   *  land-only pyramid, a 404 — and never an error. */
  | null;

/** A tile source. */
export interface MapSource {
  /** Distinguishes this source's cache entries from another's. Defaults to
   *  the source's position in the `sources` array. */
  id?: string;
  /** Fetch, or answer from a cache, or decline. May be async. */
  load(request: TileRequest): TileData | Promise<TileData>;
  /** The shallowest and deepest levels this source has data for. Outside
   *  the range the nearest level is used and scaled — "overzoom" above,
   *  which is how a z14 pyramid serves a z18 view. Defaults to 0 and 14. */
  minZoom?: number;
  maxZoom?: number;
  /** Edge length of one tile in logical pixels: 512 for most vector
   *  pyramids, 256 for the older raster convention. */
  tileSize?: number;
  /**
   * The attribution this source's licence requires, drawn in the corner of
   * the map.
   *
   * Not optional in practice for open data, which is why it is a field of
   * the source rather than a prop of the map: whoever chose the tiles is
   * who knows what has to be said about them.
   */
  attribution?: string;
}

/** A source's pyramid, with the defaults filled in. */
export function pyramidOf(source: MapSource): {
  minZoom: number;
  maxZoom: number;
  tileSize: number;
} {
  return {
    minZoom: source.minZoom ?? 0,
    maxZoom: source.maxZoom ?? 14,
    tileSize: source.tileSize ?? DEFAULT_TILE_SIZE,
  };
}

/** Substitute `{z}`, `{x}`, `{y}` — and `{s}` from `subdomains`, which the
 *  older raster services still shard on. */
export function tileUrl(
  template: string,
  tile: TileId,
  subdomains?: readonly string[],
): string {
  let url = template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
  if (subdomains && subdomains.length > 0) {
    // Deterministic in the tile, so the same tile always goes to the same
    // host and a browser-style connection cache is not defeated.
    const index = (tile.x + tile.y) % subdomains.length;
    url = url.replace('{s}', subdomains[index]);
  }
  return url;
}

/** What every OpenStreetMap-derived map has to say. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/** Where the OSM Foundation serves Shortbread vector tiles. */
export const OSM_VECTOR_URL =
  'https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt';

/** …and the classic raster layer. */
export const OSM_RASTER_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/** What a ready-made adapter still needs from the application. */
export interface OsmSourceOptions {
  /**
   * Fetch one URL. **Required**, and required on purpose — see the note at
   * the top of this file. The whole of it is usually:
   *
   * ```ts
   * fetch: async (url, signal) => {
   *   const response = await fetch(url, {
   *     signal,
   *     headers: { 'user-agent': 'my-app/1.0 (me@example.com)' },
   *   });
   *   if (response.status === 404) return null;
   *   if (!response.ok) throw new Error(`HTTP ${response.status}`);
   *   return new Uint8Array(await response.arrayBuffer());
   * }
   * ```
   *
   * `null` means "no tile here", which is an ordinary answer.
   */
  fetch: (
    url: string,
    signal: TileRequest['signal'],
    tile: TileId,
  ) => Promise<Uint8Array | null> | Uint8Array | null;
  /** Serve from somewhere else — a mirror, a proxy, a local tile server. */
  url?: string;
  id?: string;
  attribution?: string;
  maxZoom?: number;
}

/**
 * OpenStreetMap's own vector tiles, in the Shortbread schema.
 *
 * Pairs with {@link shortbreadStyle}, which is written against the same
 * schema. z14 is the deepest level cut; a view past it overzooms, which is
 * what every client does with this pyramid.
 *
 * **Read the OSM tile usage policy before shipping.** It asks for a
 * user-agent identifying the application, and it is not a CDN for an
 * application with real traffic — which is exactly why `fetch` is the
 * caller's.
 */
export function osmVectorSource(options: OsmSourceOptions): MapSource {
  const url = options.url ?? OSM_VECTOR_URL;
  return {
    id: options.id ?? 'osm-vector',
    minZoom: 0,
    maxZoom: options.maxZoom ?? 14,
    tileSize: 512,
    attribution: options.attribution ?? OSM_ATTRIBUTION,
    async load(request) {
      const bytes = await options.fetch(
        tileUrl(url, request),
        request.signal,
        request,
      );
      if (!bytes || bytes.length === 0) return null;
      return { kind: 'vector', data: gunzipIfNeeded(bytes) };
    },
  };
}

/**
 * OpenStreetMap's raster tiles — the standard style, as `openstreetmap.org`
 * draws it.
 *
 * `decode` is the second thing the application supplies, because a PNG
 * needs a codec and this package will not grow one. ntk already has one,
 * and it is already installed:
 *
 * ```ts
 * import ntk from 'react-x11/ntk';
 * const decode = (bytes) => {
 *   const image = (ntk as { decodeImage(b: Uint8Array): {
 *     width: number; height: number; data: Uint8Array } }).decodeImage(bytes);
 *   return { width: image.width, height: image.height, data: image.data };
 * };
 * ```
 */
export function osmRasterSource(
  options: OsmSourceOptions & {
    decode: (bytes: Uint8Array) => {
      width: number;
      height: number;
      data: Uint8Array;
    };
    subdomains?: readonly string[];
  },
): MapSource {
  const url = options.url ?? OSM_RASTER_URL;
  return {
    id: options.id ?? 'osm-raster',
    minZoom: 0,
    maxZoom: options.maxZoom ?? 19,
    tileSize: 256,
    attribution: options.attribution ?? OSM_ATTRIBUTION,
    async load(request) {
      const bytes = await options.fetch(
        tileUrl(url, request, options.subdomains),
        request.signal,
        request,
      );
      if (!bytes || bytes.length === 0) return null;
      const image = options.decode(bytes);
      return {
        kind: 'raster',
        width: image.width,
        height: image.height,
        data: image.data,
      };
    },
  };
}

/** Decode vector tile bytes. Exported so an application holding a `.mvt`
 *  of its own can hand the map a parsed tile through a source. */
export function parseVectorTile(bytes: Uint8Array): VectorTile {
  return parseTile(gunzipIfNeeded(bytes));
}

// --- Google Maps ------------------------------------------------------------

/**
 * What Google's Map Tiles API hands back for a session request.
 *
 * Written out structurally rather than imported: this package has no Google
 * dependency and is not about to grow one.
 */
export interface GoogleSession {
  /** The token every tile request carries. */
  session: string;
  /** Usually 256. */
  tileWidth?: number;
  tileHeight?: number;
  /** `'png'` or `'jpeg'`. */
  imageFormat?: string;
  /** Seconds since the epoch, as a string, per the API. */
  expiry?: string;
}

export interface GoogleTileSourceOptions {
  /**
   * Fetch one tile URL. The application's, exactly as every other source
   * here — see the note at the top of this file.
   */
  fetch: (
    url: string,
    signal: TileRequest['signal'],
    tile: TileId,
  ) => Promise<Uint8Array | null> | Uint8Array | null;
  /**
   * Create a session, by POSTing `body` as JSON to
   * `https://tile.googleapis.com/v1/createSession?key=…`, and hand back
   * what it answered.
   *
   * A separate callback from `fetch` because it is a POST with a JSON body
   * and a key in the query, which the tile-fetching shape cannot express —
   * and because it is where the API key lives, which is the application's
   * secret and not something to hand a component.
   *
   * Called lazily on the first tile and again when the session expires;
   * Google's are good for two weeks.
   */
  createSession: (body: Record<string, unknown>) => Promise<GoogleSession>;
  /**
   * Decode the PNG or JPEG. Google's 2D tiles are **raster** — there is no
   * public vector endpoint and no published schema — so a codec is needed
   * exactly as it is for `osmRasterSource`.
   */
  decode: (bytes: Uint8Array) => {
    width: number;
    height: number;
    data: Uint8Array;
  };
  /** `'roadmap'` (the default), `'satellite'` or `'terrain'`. Satellite is
   *  the one thing OpenStreetMap has no answer for at all. */
  mapType?: 'roadmap' | 'satellite' | 'terrain';
  /** `'layerRoadmap'` over satellite or terrain, `'layerStreetview'`. */
  layerTypes?: readonly string[];
  /** IETF language tag and CLDR region — Google's cartography is localized
   *  server-side, which is the other thing you cannot do with a style. */
  language?: string;
  region?: string;
  /** `'scaleFactor1x'`, `'scaleFactor2x'`, `'scaleFactor4x'`. */
  scale?: string;
  highDpi?: boolean;
  id?: string;
  maxZoom?: number;
  /**
   * What is drawn in the corner. **Do not remove it.** Google's Map Tiles
   * API policies require the Google Maps logo, or the text "Google Maps"
   * where space is limited, together with the data providers — and require
   * that it is not obscured by anyone else's attribution. This component
   * draws attribution as text, so the text form is what it can satisfy;
   * a logo is an overlay of your own (`<Map>` takes `children`).
   */
  attribution?: string;
}

/**
 * Google's Map Tiles API, as a `MapSource`.
 *
 * **Raster, and that is not a limitation of this adapter.** Google publishes
 * no vector tile endpoint and no schema, so there is nothing for a
 * `mapStyle` to name: what arrives is Google's own cartography, already
 * drawn. `mapType` and `language` are the styling controls, and they are
 * applied server-side when the session is created.
 *
 * Three things about it that differ from every other source here, and each
 * is the API's rather than this package's:
 *
 * - **A session token comes first.** One POST, reused for every tile,
 *   good for two weeks, and it is what carries the display options — so
 *   changing `mapType` means a new session, which this handles by making a
 *   new source.
 * - **A key is required**, and it is yours: it goes in `createSession` and
 *   in the tile URL, both of which are the application's callbacks.
 * - **The terms restrict caching.** `<Map>` keeps parsed tiles and rendered
 *   surfaces in memory for the session, which is what any renderer does;
 *   writing tiles to disk is a different thing and the policies forbid it.
 *   Read them before shipping — they also govern showing Google's tiles
 *   beside another map's.
 */
export function googleTileSource(options: GoogleTileSourceOptions): MapSource {
  let session: GoogleSession | null = null;
  let pending: Promise<GoogleSession> | null = null;
  let tileSize = 256;

  const ensure = async (): Promise<GoogleSession> => {
    const expiry = Number(session?.expiry ?? 0);
    // A minute of slack, so a token does not expire between being chosen
    // and being used.
    if (session && (!expiry || expiry * 1000 > Date.now() + 60_000)) {
      return session;
    }
    if (!pending) {
      pending = Promise.resolve(
        options.createSession({
          mapType: options.mapType ?? 'roadmap',
          language: options.language ?? 'en-US',
          region: options.region ?? 'US',
          ...(options.layerTypes
            ? { layerTypes: [...options.layerTypes] }
            : {}),
          ...(options.scale ? { scale: options.scale } : {}),
          ...(options.highDpi !== undefined
            ? { highDpi: options.highDpi }
            : {}),
        }),
      )
        .then((answer) => {
          session = answer;
          if (answer.tileWidth && answer.tileWidth > 0) {
            tileSize = answer.tileWidth;
          }
          return answer;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };

  return {
    id: options.id ?? `google-${options.mapType ?? 'roadmap'}`,
    minZoom: 0,
    // Google serves to 22, deeper than any vector pyramid here — and since
    // these are finished images there is nothing to sub-tile past it.
    maxZoom: options.maxZoom ?? 22,
    get tileSize(): number {
      return tileSize;
    },
    attribution: options.attribution ?? 'Google Maps',
    async load(request) {
      const token = await ensure();
      const url =
        `https://tile.googleapis.com/v1/2dtiles/${request.z}/${request.x}/${request.y}` +
        `?session=${encodeURIComponent(token.session)}`;
      const bytes = await options.fetch(url, request.signal, request);
      if (!bytes || bytes.length === 0) return null;
      const image = options.decode(bytes);
      return {
        kind: 'raster',
        width: image.width,
        height: image.height,
        data: image.data,
      };
    },
  };
}
