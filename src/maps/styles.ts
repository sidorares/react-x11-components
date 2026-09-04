// A default style, so that `<Map>` with a source and nothing else looks
// like a map.
//
// Written against **Shortbread 1.1**, the schema OpenStreetMap's own vector
// tiles are cut in (`vector.openstreetmap.org`) — chosen because it is the
// one open schema with an open, keyless, canonical server behind it, which
// is what makes `<Map source={osmVectorSource()} />` a line that works.
//
// The cartography is deliberately close to a familiar one (OSM Carto's
// hues for the light palette, a desaturated dark counterpart), because a
// map that looks unlike every other map reads as broken rather than as
// styled. Both palettes are here rather than derived from the theme: a
// map's colours are a *scheme* — water against land against parkland
// against six classes of road — and interpolating that out of an
// application's accent colour produces mud. What the theme does decide is
// which of the two is used, and the ink and halo of the labels, so labels
// on a map agree with text beside it.
//
// Every layer's `id` is stable, because that is what an application filters
// on to hide one (`style.layers.filter((l) => l.id !== 'buildings')`) and
// what a `<Map>` event names.
import type { MapStyle, MapStyleLayer, Zoomed } from './style.js';

/** The tags Shortbread puts a road's class in, grouped as a style wants
 *  them rather than as the schema lists them. */
const MOTORWAY = ['motorway'] as const;
const TRUNK = ['trunk'] as const;
const PRIMARY = ['primary'] as const;
const SECONDARY = ['secondary'] as const;
const TERTIARY = ['tertiary'] as const;
const MINOR = [
  'unclassified',
  'residential',
  'living_street',
  'pedestrian',
  'busway',
] as const;
const SERVICE = ['service', 'track', 'ford'] as const;
const PATH = ['path', 'footway', 'cycleway', 'steps', 'bridleway'] as const;
const RAIL = [
  'rail',
  'narrow_gauge',
  'light_rail',
  'subway',
  'tram',
  'monorail',
  'funicular',
] as const;

/** Landuse kinds that read as green space. */
const GREEN = [
  'park',
  'garden',
  'grass',
  'meadow',
  'forest',
  'wood',
  'scrub',
  'heath',
  'orchard',
  'vineyard',
  'village_green',
  'recreation_ground',
  'golf_course',
  'cemetery',
  'allotments',
  'farmland',
  'farmyard',
] as const;

/** …and the ones that read as built-up. */
const BUILT = [
  'residential',
  'commercial',
  'retail',
  'industrial',
  'brownfield',
  'greenfield',
  'railway',
  'garages',
  'quarry',
  'construction',
  'landfill',
] as const;

/** One palette. Every colour a {@link shortbreadStyle} layer uses comes
 *  from here, so a third palette is a literal rather than a fork. */
export interface MapPalette {
  land: string;
  ocean: string;
  water: string;
  green: string;
  built: string;
  site: string;
  building: string;
  buildingEdge: string;
  motorway: string;
  motorwayCasing: string;
  trunk: string;
  primary: string;
  secondary: string;
  minor: string;
  minorCasing: string;
  path: string;
  rail: string;
  boundary: string;
  pier: string;
  text: string;
  textMinor: string;
  halo: string;
}

/** OSM Carto's hues, near enough that a user's eye reads the map as the one
 *  they already know. */
export const LIGHT_PALETTE: MapPalette = {
  land: '#f2efe9',
  ocean: '#aad3df',
  water: '#aad3df',
  green: '#cfe8b4',
  built: '#e8e2dc',
  site: '#f0e7db',
  building: '#dfd7cd',
  buildingEdge: '#cec4b8',
  motorway: '#f9b29c',
  motorwayCasing: '#d97f63',
  trunk: '#fcd6a4',
  primary: '#fcd6a4',
  secondary: '#f7fabf',
  minor: '#ffffff',
  minorCasing: '#cfcdca',
  path: '#d4b8a8',
  rail: '#b0aeab',
  boundary: '#a4a1ae',
  pier: '#f2efe9',
  text: '#33322e',
  textMinor: '#6b6862',
  halo: 'rgba(255,255,255,0.85)',
};

/** The dark counterpart. Desaturated rather than inverted: an inverted map
 *  puts white water under dark land, which reads as a negative. */
export const DARK_PALETTE: MapPalette = {
  land: '#191b1f',
  ocean: '#0f1c28',
  water: '#12222f',
  green: '#1a2620',
  built: '#1f2126',
  site: '#20232a',
  building: '#23262c',
  buildingEdge: '#2b2f36',
  motorway: '#5d4b38',
  motorwayCasing: '#7a6244',
  trunk: '#4c4232',
  primary: '#43403a',
  secondary: '#3b3a35',
  minor: '#33363c',
  minorCasing: '#22242a',
  path: '#3a352f',
  rail: '#33363c',
  boundary: '#4a4757',
  pier: '#22252b',
  text: '#d3d7de',
  textMinor: '#9299a3',
  halo: 'rgba(12,14,18,0.85)',
};

/** How wide a road class is, at each zoom. */
function width(stops: readonly (readonly [number, number])[]): Zoomed<number> {
  return { stops };
}

export interface ShortbreadStyleOptions {
  /** `false` (the default) for the light palette. */
  dark?: boolean;
  /** Swap individual colours without forking the layer list. */
  palette?: Partial<MapPalette>;
  /**
   * Which name tag labels read.
   *
   * Shortbread carries `name` (the local name) plus `name_<lang>` for the
   * languages a feature has one in. `'name'` is the honest default —
   * Tokyo's streets are labelled in Japanese on a Japanese map — and an
   * application that knows its user's locale passes `name_en`, `name_de`
   * and so on. A missing translation falls back to `name`.
   */
  nameField?: string;
  /** Leave the label layers out — for a map an application labels itself,
   *  or a background under a heavy data overlay. */
  labels?: boolean;
  /** Leave building footprints out. They are the densest polygon layer at
   *  high zoom and the first thing to drop on a slow machine. */
  buildings?: boolean;
}

/**
 * The default style for Shortbread tiles.
 *
 * Twenty-six layers, in paint order. The order is the cartography: sea,
 * then landuse, then water, then sites and buildings, then road *casings*
 * as one pass and road *fills* as another — which is what makes a junction
 * look like a junction rather than two roads crossing — then rail,
 * boundaries, and labels last.
 */
export function shortbreadStyle(
  options: ShortbreadStyleOptions = {},
): MapStyle {
  const p: MapPalette = {
    ...(options.dark ? DARK_PALETTE : LIGHT_PALETTE),
    ...options.palette,
  };
  const name = options.nameField ?? 'name';
  const layers: MapStyleLayer[] = [
    { id: 'ocean', type: 'fill', sourceLayer: 'ocean', color: p.ocean },
    {
      id: 'landuse-green',
      type: 'fill',
      sourceLayer: 'land',
      filter: ['in', 'kind', ...GREEN],
      color: p.green,
    },
    {
      id: 'landuse-built',
      type: 'fill',
      sourceLayer: 'land',
      filter: ['in', 'kind', ...BUILT],
      color: p.built,
    },
    {
      id: 'sites',
      type: 'fill',
      sourceLayer: 'sites',
      color: p.site,
      minZoom: 13,
    },
    {
      id: 'water-polygons',
      type: 'fill',
      sourceLayer: 'water_polygons',
      color: p.water,
    },
    {
      id: 'water-lines',
      type: 'line',
      sourceLayer: 'water_lines',
      color: p.water,
      width: width([
        [6, 0.5],
        [10, 1.2],
        [14, 3],
        [18, 8],
      ]),
    },
    {
      id: 'dams',
      type: 'fill',
      sourceLayer: 'dam_polygons',
      color: p.built,
      minZoom: 13,
    },
    {
      id: 'piers',
      type: 'fill',
      sourceLayer: 'pier_polygons',
      color: p.pier,
      minZoom: 13,
    },
  ];

  if (options.buildings !== false) {
    layers.push({
      id: 'buildings',
      type: 'fill',
      sourceLayer: 'buildings',
      minZoom: 14,
      color: p.building,
      // The edge only once a footprint is big enough for it to be an edge
      // rather than a darkening of the whole polygon.
      outlineColor: p.buildingEdge,
    });
  }

  // Casings first, every class in one pass, so that the fills above them
  // knit together at every junction. This is the one thing that separates a
  // road network from a pile of coloured lines.
  const roadClasses: {
    id: string;
    kinds: readonly string[];
    fill: string;
    casing: string;
    fillWidth: Zoomed<number>;
    minZoom?: number;
  }[] = [
    {
      id: 'motorway',
      kinds: MOTORWAY,
      fill: p.motorway,
      casing: p.motorwayCasing,
      fillWidth: width([
        [5, 0.6],
        [8, 1.4],
        [10, 2.4],
        [13, 5],
        [16, 12],
        [20, 40],
      ]),
    },
    {
      id: 'trunk',
      kinds: TRUNK,
      fill: p.trunk,
      casing: p.motorwayCasing,
      fillWidth: width([
        [6, 0.5],
        [9, 1.2],
        [12, 2.6],
        [16, 9],
        [20, 30],
      ]),
    },
    {
      id: 'primary',
      kinds: PRIMARY,
      fill: p.primary,
      casing: p.minorCasing,
      fillWidth: width([
        [7, 0.5],
        [10, 1.3],
        [13, 3],
        [16, 8],
        [20, 26],
      ]),
      minZoom: 7,
    },
    {
      id: 'secondary',
      kinds: SECONDARY,
      fill: p.secondary,
      casing: p.minorCasing,
      fillWidth: width([
        [9, 0.5],
        [12, 1.6],
        [15, 5],
        [20, 20],
      ]),
      minZoom: 9,
    },
    {
      id: 'tertiary',
      kinds: TERTIARY,
      fill: p.minor,
      casing: p.minorCasing,
      fillWidth: width([
        [11, 0.6],
        [14, 2.4],
        [17, 7],
        [20, 18],
      ]),
      minZoom: 11,
    },
    {
      id: 'minor',
      kinds: MINOR,
      fill: p.minor,
      casing: p.minorCasing,
      fillWidth: width([
        [12, 0.5],
        [14, 1.8],
        [17, 6],
        [20, 16],
      ]),
      minZoom: 12,
    },
    {
      id: 'service',
      kinds: SERVICE,
      fill: p.minor,
      casing: p.minorCasing,
      fillWidth: width([
        [14, 0.8],
        [17, 3],
        [20, 9],
      ]),
      minZoom: 14,
    },
  ];

  for (const road of roadClasses) {
    layers.push({
      id: `${road.id}-casing`,
      type: 'line',
      sourceLayer: 'streets',
      minZoom: road.minZoom,
      filter: ['all', ['in', 'kind', ...road.kinds], ['!=', 'rail', true]],
      color: road.casing,
      // A casing is the fill plus two logical pixels, which is what makes
      // the outline a constant width at every zoom rather than a ratio that
      // disappears when the road is thin.
      width: scaleWidth(road.fillWidth, 2),
      cap: 'round',
      join: 'round',
    });
  }
  for (const road of roadClasses) {
    layers.push({
      id: road.id,
      type: 'line',
      sourceLayer: 'streets',
      minZoom: road.minZoom,
      filter: ['all', ['in', 'kind', ...road.kinds], ['!=', 'rail', true]],
      color: road.fill,
      width: road.fillWidth,
      cap: 'round',
      join: 'round',
    });
  }

  layers.push(
    {
      id: 'paths',
      type: 'line',
      sourceLayer: 'streets',
      minZoom: 15,
      filter: ['in', 'kind', ...PATH],
      color: p.path,
      width: width([
        [15, 0.8],
        [18, 1.6],
        [20, 3],
      ]),
      dash: [3, 2],
    },
    {
      id: 'rail',
      type: 'line',
      sourceLayer: 'streets',
      minZoom: 9,
      filter: ['in', 'kind', ...RAIL],
      color: p.rail,
      width: width([
        [9, 0.5],
        [13, 1],
        [17, 2],
        [20, 3],
      ]),
    },
    {
      id: 'ferries',
      type: 'line',
      sourceLayer: 'ferries',
      minZoom: 9,
      color: p.boundary,
      width: 1,
      dash: [4, 3],
    },
    {
      id: 'boundaries-country',
      type: 'line',
      sourceLayer: 'boundaries',
      color: p.boundary,
      filter: ['<=', 'admin_level', 2],
      width: width([
        [2, 0.6],
        [6, 1.1],
        [12, 1.6],
      ]),
      dash: [5, 3],
    },
    {
      // Regional borders only once there is room for them to mean
      // something — at zoom 3 they are noise over the country outlines.
      id: 'boundaries-region',
      type: 'line',
      sourceLayer: 'boundaries',
      minZoom: 6,
      color: p.boundary,
      filter: ['>', 'admin_level', 2],
      width: width([
        [6, 0.5],
        [12, 1],
      ]),
      dash: [3, 3],
    },
  );

  if (options.labels !== false) {
    layers.push(
      // Places, split by kind rather than ranked by a field — see
      // `SymbolLayer.rank` for why. The split is also what lets each class
      // have its own size and its own zoom, which is most of what makes a
      // label layer read as cartography.
      {
        id: 'place-labels-city',
        type: 'symbol',
        sourceLayer: 'place_labels',
        filter: ['in', 'kind', 'capital', 'city'],
        textField: name,
        textColor: p.text,
        textHaloColor: p.halo,
        textHaloWidth: 1.5,
        textSize: {
          stops: [
            [3, 12],
            [8, 15],
            [12, 18],
            [16, 20],
          ],
        },
        rank: 100,
      },
      {
        id: 'place-labels-town',
        type: 'symbol',
        sourceLayer: 'place_labels',
        minZoom: 7,
        filter: ['in', 'kind', 'town', 'borough'],
        textField: name,
        textColor: p.text,
        textHaloColor: p.halo,
        textHaloWidth: 1.5,
        textSize: {
          stops: [
            [7, 11],
            [12, 14],
            [16, 16],
          ],
        },
        rank: 80,
      },
      {
        id: 'place-labels-suburb',
        type: 'symbol',
        sourceLayer: 'place_labels',
        minZoom: 11,
        filter: ['in', 'kind', 'suburb', 'quarter', 'neighbourhood', 'village'],
        textField: name,
        textColor: p.textMinor,
        textHaloColor: p.halo,
        textHaloWidth: 1.2,
        textSize: {
          stops: [
            [11, 10],
            [15, 13],
          ],
        },
        rank: 60,
      },
      {
        id: 'place-labels-locality',
        type: 'symbol',
        sourceLayer: 'place_labels',
        minZoom: 13,
        filter: [
          'in',
          'kind',
          'hamlet',
          'locality',
          'isolated_dwelling',
          'farm',
          'island',
          'islet',
        ],
        textField: name,
        textColor: p.textMinor,
        textHaloColor: p.halo,
        textHaloWidth: 1.2,
        textSize: 10,
        rank: 40,
      },
      {
        id: 'water-labels',
        type: 'symbol',
        sourceLayer: 'water_polygons_labels',
        minZoom: 9,
        textField: name,
        textColor: p.textMinor,
        textHaloColor: p.halo,
        textHaloWidth: 1,
        textSize: 11,
        rank: 30,
      },
      {
        id: 'street-labels',
        type: 'symbol',
        sourceLayer: 'street_labels',
        minZoom: 14,
        filter: ['!in', 'kind', ...RAIL],
        textField: name,
        textColor: p.textMinor,
        textHaloColor: p.halo,
        textHaloWidth: 1,
        textSize: 11,
        // Under every place name: a suburb's name is what orients someone,
        // a street's name is what they read once they are oriented.
        rank: 20,
      },
      {
        id: 'transport-labels',
        type: 'symbol',
        sourceLayer: 'public_transport',
        minZoom: 15,
        textField: name,
        textColor: p.textMinor,
        textHaloColor: p.halo,
        textHaloWidth: 1,
        textSize: 10,
        rank: 10,
      },
    );
  }

  return { background: p.land, layers };
}

/** A width ramp plus a constant — how a casing is derived from its fill so
 *  the two cannot drift apart when one of them is retuned. */
function scaleWidth(base: Zoomed<number>, add: number): Zoomed<number> {
  if (typeof base === 'number') return base + add;
  return { stops: base.stops.map(([z, v]) => [z, v + add] as const) };
}

// --- OpenMapTiles -----------------------------------------------------------

/**
 * Road classes as **OpenMapTiles** names them.
 *
 * Not the same words as Shortbread's, which is the whole reason this second
 * style exists: `transportation.class` is `minor` where Shortbread says
 * `residential`, `unclassified` and `living_street`, and rail lives in the
 * same layer under `class: 'rail'` rather than beside the roads. Point
 * {@link shortbreadStyle} at an OpenMapTiles source and it matches nothing
 * and draws an empty map.
 */
const OMT_RAIL = ['rail', 'transit'] as const;

/** Landcover classes that read as green space. */
const OMT_GREEN = ['wood', 'grass', 'farmland', 'wetland'] as const;

/** Landuse classes that read as built-up. */
const OMT_BUILT = [
  'residential',
  'commercial',
  'industrial',
  'retail',
  'railway',
  'cemetery',
  'quarry',
] as const;

/** Landuse classes for an institutional site. */
const OMT_SITES = [
  'hospital',
  'school',
  'university',
  'college',
  'kindergarten',
  'stadium',
  'pitch',
  'playground',
] as const;

export interface OpenMapTilesStyleOptions extends ShortbreadStyleOptions {}

/**
 * The same cartography over the **OpenMapTiles** schema.
 *
 * OpenMapTiles is the other open schema, and between them the two cover
 * nearly every provider worth pointing this at: Shortbread is what
 * OpenStreetMap's own server and VersaTiles cut, OpenMapTiles is what
 * MapTiler, Stadia, Geoapify, OpenFreeMap and most self-hosted planets cut.
 *
 * Deliberately the same palette, the same layer ids where they mean the
 * same thing, and the same casing-then-fill ordering, so switching a source
 * between the two schemas changes which style you pass and nothing else
 * about how the map looks.
 */
export function openMapTilesStyle(
  options: OpenMapTilesStyleOptions = {},
): MapStyle {
  const p: MapPalette = {
    ...(options.dark ? DARK_PALETTE : LIGHT_PALETTE),
    ...options.palette,
  };
  const name = options.nameField ?? 'name';
  const layers: MapStyleLayer[] = [
    // One `water` layer for everything wet, with `class` telling the sea
    // from a lake — where Shortbread has `ocean` and `water_polygons`.
    { id: 'ocean', type: 'fill', sourceLayer: 'water', color: p.water },
    {
      id: 'landuse-green',
      type: 'fill',
      sourceLayer: 'landcover',
      filter: ['in', 'class', ...OMT_GREEN],
      color: p.green,
    },
    { id: 'park', type: 'fill', sourceLayer: 'park', color: p.green },
    {
      id: 'landuse-built',
      type: 'fill',
      sourceLayer: 'landuse',
      filter: ['in', 'class', ...OMT_BUILT],
      color: p.built,
    },
    {
      id: 'sites',
      type: 'fill',
      sourceLayer: 'landuse',
      minZoom: 13,
      filter: ['in', 'class', ...OMT_SITES],
      color: p.site,
    },
    {
      id: 'water-lines',
      type: 'line',
      sourceLayer: 'waterway',
      color: p.water,
      width: width([
        [6, 0.5],
        [10, 1.2],
        [14, 3],
        [18, 8],
      ]),
    },
  ];

  if (options.buildings !== false) {
    layers.push({
      id: 'buildings',
      type: 'fill',
      sourceLayer: 'building',
      minZoom: 14,
      color: p.building,
      outlineColor: p.buildingEdge,
    });
  }

  const roads: {
    id: string;
    classes: readonly string[];
    fill: string;
    casing: string;
    fillWidth: Zoomed<number>;
    minZoom?: number;
  }[] = [
    {
      id: 'motorway',
      classes: ['motorway'],
      fill: p.motorway,
      casing: p.motorwayCasing,
      fillWidth: width([
        [5, 0.6],
        [8, 1.4],
        [10, 2.4],
        [13, 5],
        [16, 12],
        [20, 40],
      ]),
    },
    {
      id: 'trunk',
      classes: ['trunk'],
      fill: p.trunk,
      casing: p.motorwayCasing,
      fillWidth: width([
        [6, 0.5],
        [9, 1.2],
        [12, 2.6],
        [16, 9],
        [20, 30],
      ]),
    },
    {
      id: 'primary',
      classes: ['primary'],
      fill: p.primary,
      casing: p.minorCasing,
      minZoom: 7,
      fillWidth: width([
        [7, 0.5],
        [10, 1.3],
        [13, 3],
        [16, 8],
        [20, 26],
      ]),
    },
    {
      id: 'secondary',
      classes: ['secondary'],
      fill: p.secondary,
      casing: p.minorCasing,
      minZoom: 9,
      fillWidth: width([
        [9, 0.5],
        [12, 1.6],
        [15, 5],
        [20, 20],
      ]),
    },
    {
      id: 'tertiary',
      classes: ['tertiary'],
      fill: p.minor,
      casing: p.minorCasing,
      minZoom: 11,
      fillWidth: width([
        [11, 0.6],
        [14, 2.4],
        [17, 7],
        [20, 18],
      ]),
    },
    {
      // `minor` is OpenMapTiles' one word for residential, unclassified and
      // living_street, which Shortbread keeps apart.
      id: 'minor',
      classes: ['minor'],
      fill: p.minor,
      casing: p.minorCasing,
      minZoom: 12,
      fillWidth: width([
        [12, 0.5],
        [14, 1.8],
        [17, 6],
        [20, 16],
      ]),
    },
    {
      id: 'service',
      classes: ['service', 'track'],
      fill: p.minor,
      casing: p.minorCasing,
      minZoom: 14,
      fillWidth: width([
        [14, 0.8],
        [17, 3],
        [20, 9],
      ]),
    },
  ];

  for (const road of roads) {
    layers.push({
      id: `${road.id}-casing`,
      type: 'line',
      sourceLayer: 'transportation',
      minZoom: road.minZoom,
      filter: ['in', 'class', ...road.classes],
      color: road.casing,
      width: scaleWidth(road.fillWidth, 2),
      cap: 'round',
      join: 'round',
    });
  }
  for (const road of roads) {
    layers.push({
      id: road.id,
      type: 'line',
      sourceLayer: 'transportation',
      minZoom: road.minZoom,
      filter: ['in', 'class', ...road.classes],
      color: road.fill,
      width: road.fillWidth,
      cap: 'round',
      join: 'round',
    });
  }

  layers.push(
    {
      id: 'paths',
      type: 'line',
      sourceLayer: 'transportation',
      minZoom: 15,
      filter: ['in', 'class', 'path', 'pedestrian'],
      color: p.path,
      width: width([
        [15, 0.8],
        [18, 1.6],
        [20, 3],
      ]),
      dash: [3, 2],
    },
    {
      id: 'rail',
      type: 'line',
      sourceLayer: 'transportation',
      minZoom: 9,
      filter: ['in', 'class', ...OMT_RAIL],
      color: p.rail,
      width: width([
        [9, 0.5],
        [13, 1],
        [17, 2],
        [20, 3],
      ]),
    },
    {
      id: 'ferries',
      type: 'line',
      sourceLayer: 'transportation',
      minZoom: 9,
      filter: ['==', 'class', 'ferry'],
      color: p.boundary,
      width: 1,
      dash: [4, 3],
    },
    {
      id: 'boundaries-country',
      type: 'line',
      sourceLayer: 'boundary',
      filter: ['<=', 'admin_level', 2],
      color: p.boundary,
      width: width([
        [2, 0.6],
        [6, 1.1],
        [12, 1.6],
      ]),
      dash: [5, 3],
    },
    {
      id: 'boundaries-region',
      type: 'line',
      sourceLayer: 'boundary',
      minZoom: 6,
      filter: ['>', 'admin_level', 2],
      color: p.boundary,
      width: width([
        [6, 0.5],
        [12, 1],
      ]),
      dash: [3, 3],
    },
  );

  if (options.labels !== false) {
    layers.push(
      {
        id: 'place-labels-city',
        type: 'symbol',
        sourceLayer: 'place',
        filter: ['in', 'class', 'city'],
        textField: name,
        textColor: p.text,
        textHaloColor: p.halo,
        textHaloWidth: 1.5,
        textSize: {
          stops: [
            [3, 12],
            [8, 15],
            [12, 18],
            [16, 20],
          ],
        },
        rank: 100,
      },
      {
        id: 'place-labels-town',
        type: 'symbol',
        sourceLayer: 'place',
        minZoom: 7,
        filter: ['in', 'class', 'town'],
        textField: name,
        textColor: p.text,
        textHaloColor: p.halo,
        textHaloWidth: 1.5,
        textSize: {
          stops: [
            [7, 11],
            [12, 14],
            [16, 16],
          ],
        },
        rank: 80,
      },
      {
        id: 'place-labels-suburb',
        type: 'symbol',
        sourceLayer: 'place',
        minZoom: 11,
        filter: [
          'in',
          'class',
          'suburb',
          'quarter',
          'neighbourhood',
          'village',
        ],
        textField: name,
        textColor: p.textMinor,
        textHaloColor: p.halo,
        textHaloWidth: 1.2,
        textSize: {
          stops: [
            [11, 10],
            [15, 13],
          ],
        },
        rank: 60,
      },
      {
        id: 'place-labels-locality',
        type: 'symbol',
        sourceLayer: 'place',
        minZoom: 13,
        filter: ['in', 'class', 'hamlet', 'isolated_dwelling', 'island'],
        textField: name,
        textColor: p.textMinor,
        textHaloColor: p.halo,
        textHaloWidth: 1.2,
        textSize: 10,
        rank: 40,
      },
      {
        id: 'water-labels',
        type: 'symbol',
        sourceLayer: 'water_name',
        minZoom: 9,
        textField: name,
        textColor: p.textMinor,
        textHaloColor: p.halo,
        textHaloWidth: 1,
        textSize: 11,
        rank: 30,
      },
      {
        id: 'street-labels',
        type: 'symbol',
        sourceLayer: 'transportation_name',
        minZoom: 14,
        textField: name,
        textColor: p.textMinor,
        textHaloColor: p.halo,
        textHaloWidth: 1,
        textSize: 11,
        rank: 20,
      },
    );
  }

  return { background: p.land, layers };
}
