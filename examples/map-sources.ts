// The tile providers the map examples show — `maps.tsx` (both renderers,
// markers, a route) and `maps-gl.tsx` (the GL renderer's own levers) — in
// one place, so that the two compare the same data under one fetch policy.
//
// The `fetch` here is the whole of what this package will not do for you:
// it is where the user agent, the caching and the error policy live,
// because those are the application's to decide (see
// `docs/components/maps.md`).
import * as ntk from 'react-x11/ntk';

import {
  googleTileSource,
  osmRasterSource,
  osmVectorSource,
} from '../src/maps/index.js';
import type { MapSource } from '../src/maps/index.js';

/**
 * The application's own tile loader.
 *
 * A one-entry-per-tile promise cache in front of it, because React can ask
 * for the same tile twice before the first answer lands, and OSM's usage
 * policy is not something to be casual about. A real application would put
 * a disk cache here too.
 */
const inFlight: Record<string, Promise<Uint8Array | null>> = {};

export const fetching = {
  fetch: (url: string, signal: { readonly aborted: boolean } | undefined) => {
    const hit = inFlight[url];
    if (hit) return hit;
    const request = fetch(url, {
      signal: signal as AbortSignal | undefined,
      headers: {
        // Identifying the application is the first line of OSM's tile usage
        // policy, and a shared default is what gets a whole runtime blocked.
        'user-agent':
          'react-x11-components-example/0.1 (+https://github.com/sidorares/react-x11-components)',
      },
    })
      .then(async (response) => {
        if (response.status === 404 || response.status === 204) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        return new Uint8Array(await response.arrayBuffer());
      })
      .catch((error: unknown) => {
        delete inFlight[url];
        throw error;
      });
    inFlight[url] = request;
    return request;
  },
};

export const osmVector = osmVectorSource(fetching);

/**
 * VersaTiles — a second, keyless source of the **same schema**.
 *
 * Here to answer "does this work with anything but OSM's own server", and
 * it does with no new code at all: VersaTiles cuts Shortbread too, so
 * `shortbreadStyle()` reads it unchanged and the only difference is the
 * URL and the attribution. Zoom 0-14 like OSM's, no key, no registration.
 *
 * Its `osm` tileset is OSM merged with ESA WorldCover, so the attribution
 * has to say both — which is exactly why attribution belongs on the source
 * rather than on the map.
 */
export const versatiles: MapSource = {
  id: 'versatiles',
  minZoom: 0,
  maxZoom: 14,
  tileSize: 512,
  attribution: '© OpenStreetMap contributors · © ESA WorldCover project 2021',
  load: async (request) => {
    const bytes = await fetching.fetch(
      `https://tiles.versatiles.org/tiles/osm/${request.z}/${request.x}/${request.y}`,
      request.signal,
    );
    // Gzip is unwrapped by the decoder, so the compressed body is fine.
    return bytes && bytes.length > 0 ? { kind: 'vector', data: bytes } : null;
  },
};

/**
 * OpenFreeMap — keyless, unlimited, and the **other** open schema.
 *
 * OpenMapTiles rather than Shortbread, so it wants `openMapTilesStyle()`.
 * Between the two schemas the styles here cover nearly every provider worth
 * pointing this at: Shortbread is OSM's own server and VersaTiles,
 * OpenMapTiles is MapTiler, Stadia, Geoapify, OpenFreeMap and most
 * self-hosted planets.
 *
 * Its tile URL is **dated** (`…/planet/20260830_080001_pt/…`) and lives in
 * a TileJSON rather than being a documented constant, so it is read at
 * startup the way MapLibre reads it. A failure here is not fatal: the layer
 * is simply left out of the picker.
 */
async function openFreeMap(): Promise<MapSource | null> {
  try {
    const response = await fetch('https://tiles.openfreemap.org/planet');
    if (!response.ok) return null;
    const tileJson = (await response.json()) as {
      tiles: string[];
      minzoom?: number;
      maxzoom?: number;
    };
    const template = tileJson.tiles?.[0];
    if (!template) return null;
    return {
      id: 'openfreemap',
      minZoom: tileJson.minzoom ?? 0,
      maxZoom: tileJson.maxzoom ?? 14,
      tileSize: 512,
      attribution: 'OpenFreeMap © OpenMapTiles · Data from OpenStreetMap',
      load: async (request) => {
        const bytes = await fetching.fetch(
          template
            .replace('{z}', String(request.z))
            .replace('{x}', String(request.x))
            .replace('{y}', String(request.y)),
          request.signal,
        );
        return bytes && bytes.length > 0
          ? { kind: 'vector', data: bytes }
          : null;
      },
    };
  } catch {
    return null;
  }
}

export const openfreemap = await openFreeMap();

/**
 * …and the keyed ones, which is most of the rest of the industry.
 *
 * MapTiler, Stadia, Geoapify, Thunderforest, Azure Maps, Mapbox and
 * TomTom all have a free tier and all want a key in the URL, so they are a
 * `MapSource` of four lines and an environment variable rather than
 * anything this package has to know about. MapTiler serves OpenMapTiles,
 * so it takes the same style OpenFreeMap does.
 *
 *   MAPTILER_KEY=… npm run examples:maps
 */
const maptilerKey = process.env.MAPTILER_KEY;
export const maptiler: MapSource | null = maptilerKey
  ? {
      id: 'maptiler',
      minZoom: 0,
      maxZoom: 14,
      tileSize: 512,
      attribution: '© MapTiler © OpenStreetMap contributors',
      load: async (request) => {
        const bytes = await fetching.fetch(
          `https://api.maptiler.com/tiles/v3/${request.z}/${request.x}/${request.y}.pbf?key=${maptilerKey}`,
          request.signal,
        );
        return bytes && bytes.length > 0
          ? { kind: 'vector', data: bytes }
          : null;
      },
    }
  : null;

/**
 * OSM's own raster style, which is the other thing the Foundation serves.
 *
 * A raster tile is pixels, so somebody has to decode the PNG — this package
 * will not grow a codec or guess which format a provider serves. ntk has
 * one and every react-x11 application already has ntk.
 *
 * Two things about reaching it that are easy to get wrong: `decodeImage` is
 * a **named** export of `react-x11/ntk` (which re-exports ntk with
 * `export *`), not a property of the default one — and it is not in the
 * declarations, so the namespace is cast structurally, the way this repo
 * works around every other narrow react-x11 declaration.
 */
const { decodeImage } = ntk as unknown as {
  decodeImage(bytes: Uint8Array): {
    width: number;
    height: number;
    data: Uint8Array;
  };
};

export const osmRaster = osmRasterSource({
  ...fetching,
  decode: (bytes) => {
    const image = decodeImage(bytes);
    return { width: image.width, height: image.height, data: image.data };
  },
});

/**
 * Google, which is the one provider here that is *only* raster.
 *
 * Google publishes no vector tile endpoint and no schema — its own docs
 * describe roadmap tiles as "image tiles based on vector topographic data
 * with Google's cartographic styling", meaning it rasterizes server-side —
 * so there is no `style` to pass and no `mapStyle` that could apply. What
 * you choose instead is `mapType`, and it is chosen when the session is
 * created rather than per tile.
 *
 * That session is the one thing this API asks for that no other source
 * here does: a POST that returns a token, reused for two weeks. It is a
 * POST with a JSON body and the key in the query, so it is a callback of
 * its own rather than the tile `fetch`.
 *
 *   GOOGLE_MAPS_KEY=… npm run examples:maps
 *
 * The key never reaches the component: it lives in these two callbacks.
 * Google's attribution and caching terms are the application's to honour —
 * see `docs/components/maps.md` before shipping one of these.
 */
const googleKey = process.env.GOOGLE_MAPS_KEY;

const google = (
  mapType: 'roadmap' | 'satellite',
  layerTypes?: string[],
): MapSource | null =>
  googleKey
    ? googleTileSource({
        mapType,
        layerTypes,
        id: `google-${mapType}${layerTypes ? '-hybrid' : ''}`,
        attribution: 'Google Maps',
        createSession: async (body) => {
          const response = await fetch(
            `https://tile.googleapis.com/v1/createSession?key=${googleKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            },
          );
          if (!response.ok) {
            throw new Error(
              `createSession: ${response.status} ${await response.text()}`,
            );
          }
          return (await response.json()) as { session: string };
        },
        fetch: (url, signal) =>
          fetching.fetch(`${url}&key=${googleKey}`, signal),
        decode: (bytes) => {
          const image = decodeImage(bytes);
          return { width: image.width, height: image.height, data: image.data };
        },
      })
    : null;

export const googleRoadmap = google('roadmap');
export const googleSatellite = google('satellite');
export const googleHybrid = google('satellite', ['layerRoadmap']);

/** Which style a provider's tiles want — none for a raster, whose tiles
 *  arrive already drawn. */
export type TileSchema = 'shortbread' | 'openmaptiles' | 'raster';

export interface TileProvider {
  id: string;
  label: string;
  /** Made once: tiles are cached per source object, so a provider switched
   *  back to finds its tiles still there. */
  sources: MapSource[];
  schema: TileSchema;
}

const provider = (
  id: string,
  label: string,
  source: MapSource | null,
  schema: TileSchema,
): TileProvider[] => (source ? [{ id, label, sources: [source], schema }] : []);

/**
 * Every provider the examples can show: the keyless ones, then a keyed one
 * only when its key is set, and OpenFreeMap only when its TileJSON answered.
 * Two schemas and pixels — the same streets cut by different tools, which
 * is what a renderer is worth comparing across.
 */
export const PROVIDERS: TileProvider[] = [
  ...provider('osm', 'OpenStreetMap — vector', osmVector, 'shortbread'),
  ...provider('versatiles', 'VersaTiles — vector', versatiles, 'shortbread'),
  ...provider(
    'openfreemap',
    'OpenFreeMap — vector',
    openfreemap,
    'openmaptiles',
  ),
  ...provider('maptiler', 'MapTiler — vector', maptiler, 'openmaptiles'),
  ...provider('osm-raster', 'OpenStreetMap — raster', osmRaster, 'raster'),
  ...provider('google', 'Google roadmap — raster', googleRoadmap, 'raster'),
  ...provider(
    'google-satellite',
    'Google satellite — raster',
    googleSatellite,
    'raster',
  ),
  ...provider(
    'google-hybrid',
    'Google hybrid — raster',
    googleHybrid,
    'raster',
  ),
];
