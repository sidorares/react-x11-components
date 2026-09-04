# Map

```tsx
import { Map, osmVectorSource } from '@react-x11/components/maps';

// Nothing in this package fetches. You supply the request; the adapter
// supplies the URL, the schema and the attribution.
const source = osmVectorSource({
  fetch: async (url, signal) => {
    const response = await fetch(url, {
      signal: signal as AbortSignal,
      headers: { 'user-agent': 'my-app/1.0 (me@example.com)' },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
});

<Map
  sources={[source]}
  defaultCamera={{ center: { lon: -0.1281, lat: 51.508 }, zoom: 13 }}
  markers={[{ id: 'home', position: { lon: -0.1281, lat: 51.508 } }]}
  onMarkerClick={(marker) => select(marker.id)}
  style={{ height: 400 }}
/>;
```

A 2D slippy map: **Mapbox Vector Tiles** decoded and drawn, panned and
zoomed, with markers, lines, areas and circles over the top. It registers
one host element, `<mapview>`, and draws the whole map into it — the rule
`<Flow>` established and this follows: when the viewport is a transform,
the element draws and does not compose.

`docs/prd-maps.md` is the design record: which formats are actually used,
which providers serve what, what the extra layers (traffic, routes,
transit) really are, and the measurements behind every performance
decision here.

## Sources

`sources` is an array, drawn in order, so a basemap and an overlay pyramid
are two entries. A source is an object with a `load` function:

| field         |                                                                                   |
| ------------- | --------------------------------------------------------------------------------- |
| `load`        | `(request) => TileData \| Promise<TileData>`. The whole seam.                     |
| `id`          | Distinguishes this source's cache entries. Its index by default.                  |
| `minZoom`     | Shallowest level it has data for. 0 by default.                                   |
| `maxZoom`     | Deepest. 14 by default; a view past it **overzooms**, scaling the coarser tiles.  |
| `tileSize`    | Logical pixels per tile edge — 512 for vector, 256 for the older raster services. |
| `attribution` | What the licence requires. Drawn in the corner; see below.                        |

`TileData` is `{ kind: 'vector', data }` for MVT bytes (gzip is unwrapped
for you), `{ kind: 'raster', width, height, data }` for straight RGBA
pixels, or `null` for "there is no tile here" — which is an ordinary
answer, not an error, and is what an ocean tile in a land-only pyramid
returns.

`request.signal` is a **real `AbortSignal`**, so it goes straight to
`fetch`; it is aborted when the tile leaves the view before it arrives. In
TypeScript it needs a cast — `signal as AbortSignal` — because `src/`
compiles with no DOM lib and cannot name the class.

**A `load` that throws is an error, and errors are on a backoff.** The tile
is retried 0.5 s later, then 1, 2, 4 … up to 30 s, rather than on every
frame; `onTileError` fires each time. Wire that prop up early, because
nothing is drawn for a failed tile and **a map whose tiles all fail looks
exactly like a map that is still loading** — an empty background and nothing
else. `MapFrameStats.errors` is the same information per frame.

Two adapters ship, both for OpenStreetMap's own keyless endpoints:
`osmVectorSource()` (the Shortbread schema, which `shortbreadStyle()` is
written against) and `osmRasterSource()` (the classic raster layer).
Anything else — MapTiler, Protomaps, Azure Maps, a local tile server, a
PMTiles archive — is a `load` of your own; `tileUrl()` does the `{z}/{x}/{y}`
substitution.

### Providers that work

`osmVectorSource` and `osmRasterSource` ship because OpenStreetMap's own
endpoints need no key and no signup, but nothing is tied to them. Anything
that serves MVT over `{z}/{x}/{y}` is a `load` of a few lines.

Keyless, no registration, free:

| provider          | schema              | notes                                                                                                                                                                                                                     |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenStreetMap** | Shortbread, z0–14   | What the two adapters point at. Read the tile usage policy before shipping.                                                                                                                                               |
| **VersaTiles**    | Shortbread, z0–14   | `https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}`. Same schema, so `shortbreadStyle()` reads it unchanged — the example has it as a second layer. Its tileset merges ESA WorldCover, which the attribution has to say. |
| **OpenFreeMap**   | OpenMapTiles, z0–14 | No key, no limits. Its tile URL is dated (`…/planet/20260830_080001_pt/…`) and lives in a TileJSON at `https://tiles.openfreemap.org/planet`, so read it at startup — the example does. Pair with `openMapTilesStyle()`.  |

Free tiers behind a key — MapTiler, Stadia, Geoapify, Thunderforest, Azure
Maps, Mapbox, TomTom — are all the same four lines plus an environment
variable; the example carries MapTiler's behind `MAPTILER_KEY`. **Satellite
imagery is only ever one of these**: OpenStreetMap is map data and has
none, so imagery means a provider you have the rights to — Google's
`mapType: 'satellite'` below, Esri, Bing, Maxar, or OpenAerialMap, which is
open (CC BY 4.0) but per-image rather than a global pyramid.

**The schema matters more than the provider**, and there is a style for
each of the two open ones:

- **`shortbreadStyle()`** — OpenStreetMap's own server, VersaTiles.
- **`openMapTilesStyle()`** — MapTiler, Stadia, Geoapify, OpenFreeMap, and
  most self-hosted planets.

Same palette, same layer ids where they mean the same thing, same
casing-then-fill ordering, so moving a source between schemas changes which
style you pass and nothing else about how the map looks. Passing the
_wrong_ one matches no layer names and draws an empty map — no error,
because a style naming a layer a tile does not have is ordinary — and that
is the one failure to expect when pointing this at a new provider.

### Google, and the other closed providers

`googleTileSource()` reads Google's Map Tiles API. It sits apart from
everything above for one reason: **Google publishes no vector tiles and no
schema.** Its own documentation describes roadmap tiles as "image tiles
based on vector topographic data with Google's cartographic styling" — the
vector data is Google's, the rasterizing happens on their servers, and what
crosses the wire is a PNG. So there is nothing for a `mapStyle` to name, and
passing one changes nothing.

What you choose instead is `mapType` — `roadmap`, `satellite` or `terrain`,
optionally with `layerTypes: ['layerRoadmap']` for the hybrid — plus
`language` and `region`, because Google localizes its cartography
server-side. All of it is fixed when the **session** is created, which is
the other thing this API does that no other source here does: one POST
returns a token, good for two weeks, spent on every tile. `googleTileSource`
creates it lazily, shares it between concurrent first tiles, and replaces it
when it expires.

```ts
const google = googleTileSource({
  mapType: 'satellite',
  layerTypes: ['layerRoadmap'],
  createSession: (body) =>
    fetch(`https://tile.googleapis.com/v1/createSession?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  fetch: (url, signal) => fetchBytes(`${url}&key=${KEY}`, signal),
  decode: decodeImage,
});
```

The key lives in those two callbacks and never reaches the component. The
example carries roadmap, satellite and hybrid behind `GOOGLE_MAPS_KEY`.

**Three obligations come with it, and they are the application's**, because
they are about what is on screen rather than what this code does:

- **Attribution is required and specific.** The Google Maps logo, or the
  text "Google Maps" where space is limited, plus the data providers
  ("Map data: Google, Maxar Technologies"), not obscured by anyone else's
  attribution. This component draws attribution as _text_, so the text form
  is what it can satisfy; a logo is an overlay of your own — `<Map>` takes
  `children` for exactly this.
- **The terms restrict caching.** `<Map>` holds decoded tiles and rendered
  surfaces in memory for the session, which is what any renderer must do to
  put a tile on screen. Persisting tiles to disk is a different thing, and
  the policies forbid it — do not point the bench corpus scripts at Google.
- **Showing it beside another map is governed too.** The terms cover
  displaying Google content "on, next to, or in a manner that is visually
  associated with" another map, so a side-by-side comparison or a
  Google basemap under a non-Google overlay is a question for the terms
  rather than for this component.

Apple and Microsoft land in the same place for the same reason. Apple's
MapKit JS is a rendered map rather than a tile service and has no server
tile endpoint to point at. Azure Maps _does_ serve MVT to `{z}/{x}/{y}` in
its own schema — neither Shortbread nor OpenMapTiles — so it needs a style
written against `microsoft.maps.*` layer names, which is a `MapStyle`
literal and no new code here.

Read the terms before shipping any of them:
[Map Tiles API policies](https://developers.google.com/maps/documentation/tile/policies)
and the [Maps Platform terms](https://developers.google.com/maps/terms).

### Nothing here fetches, and that is the feature

A component that fetched by default would decide, on your behalf, whose
servers your application talks to, what its user agent says, and whose
usage policy it is now bound by. So `load` is yours, exactly as
`<Html onResource>` is. Two consequences worth knowing before you go
looking for the missing prop:

- **A raster source needs a decoder.** PNG and JPEG need a codec, and this
  package will not grow one or guess which a provider serves. ntk has one
  and it is already installed:

  ```ts
  import * as ntk from 'react-x11/ntk';

  // A **named** export — `react-x11/ntk` re-exports ntk with `export *`,
  // so it is not a property of the default one — and it is not in the
  // declarations either, hence the structural cast.
  const { decodeImage } = ntk as unknown as {
    decodeImage(b: Uint8Array): {
      width: number;
      height: number;
      data: Uint8Array;
    };
  };

  const decode = (bytes: Uint8Array) => {
    const image = decodeImage(bytes);
    return { width: image.width, height: image.height, data: image.data };
  };
  ```

  **OpenStreetMap has no satellite layer**, and neither does this component:
  OSM is map _data_, and the Foundation serves the vector tiles and the
  standard raster style and nothing else. Aerial imagery in an OSM editor
  comes from third parties — Esri, Bing, Maxar, Mapbox — under terms that
  permit _tracing for OSM_ rather than redisplay, or from OpenAerialMap,
  which is genuinely open (CC BY 4.0) but per-image rather than a global
  pyramid. An imagery layer is a `MapSource` of your own, pointed at
  whichever provider you have the rights to use, carrying their attribution.

- **The attribution is not optional.** For OpenStreetMap-derived tiles it
  is a licence condition, so a source carries it and the map draws it in
  the corner. `attribution=""` says you have put it somewhere else
  yourself; there is no way to say nothing needs saying.

## Props

| prop             |                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources`        | Where tiles come from, drawn in order. Empty draws the style's background, which is what a map with only markers on it wants.                     |
| `mapStyle`       | How to draw them. `shortbreadStyle()` in the theme's light or dark palette by default. Named `mapStyle` so that `style` stays react-x11's.        |
| `camera`         | `{ center: { lon, lat }, zoom }`, controlled. Leave it out and the **element** owns it — see "The camera" below.                                  |
| `defaultCamera`  | Where an element-owned camera starts. Read once.                                                                                                  |
| `onCameraChange` | Every camera move, gesture steps included.                                                                                                        |
| `onMoveEnd`      | Once, after a gesture settles — the moment to fetch what is now on screen.                                                                        |
| `minZoom`        | 0 by default.                                                                                                                                     |
| `maxZoom`        | 22 by default.                                                                                                                                    |
| `markers`        | Points the user can click. See below.                                                                                                             |
| `overlays`       | Lines, areas and circles: a route, a traffic segment, a transit shape, a GeoJSON layer.                                                           |
| `onMapClick`     | A click anywhere, with the position in every space that could be wanted.                                                                          |
| `onMarkerClick`  | …and the marker, when there was one under it.                                                                                                     |
| `onMarkerHover`  | The marker under the pointer, or `null`. The event is `null` for the leave that comes from the pointer leaving the map.                           |
| `interactive`    | `false` freezes the camera — no drag, no wheel, no keys. The map still draws and still reports clicks.                                            |
| `progressive`    | Show a tile as it is drawn rather than when it is finished. `false` by default, which is what every other map client does.                        |
| `rasterBudgetMs` | Milliseconds a frame may spend rasterizing tiles. 8 by default; `0` suspends it. See "Why a map fills in".                                        |
| `rasterScale`    | Device pixels per logical pixel for the tile surfaces. The display's by default; 1 on a retina panel is ~1.6× quicker and correspondingly softer. |
| `surfaceBudget`  | Bytes of rendered tile surfaces to keep. 128 MB by default.                                                                                       |
| `batchVertices`  | The rasterizer's path-flush size, 12,000. A real trade on X11; set it only with a profile in hand.                                                |
| `attribution`    | Overrides what the sources say. `''` removes it.                                                                                                  |
| `onFrame`        | Called once per painted frame with `MapFrameStats` — what it cost, how many tiles are still sharpening, how many failed.                          |
| `onTileError`    | Called per failed tile load, with whatever the source threw. Worth wiring up first: a map whose tiles fail looks identical to one still loading.  |
| `style`          | react-x11's, on the box around the pane. Fills its parent unless you give it a height or a `flexGrow`.                                            |
| `children`       | Anything absolutely positioned over the map — a legend, a control panel.                                                                          |

## Markers

The minimum a map API owes you, and the only thing on the map that is an
_object_ rather than cartography — which is why markers, and only markers,
are what a screen reader meets.

| field               |                                                                                |
| ------------------- | ------------------------------------------------------------------------------ |
| `id`                | Stable across renders. What an event names and what a hit test returns.        |
| `position`          | `{ lon, lat }`.                                                                |
| `shape`             | `'pin'` (the default) **stands on** its position; `'circle'` is centred on it. |
| `size`              | Logical pixels: a pin's width, a circle's diameter. 14 by default.             |
| `color` / `outline` | The theme's accent and background by default.                                  |
| `selected`          | Drawn with the selected ring, and reported to an assistive technology.         |
| `zIndex`            | Higher draws later. Ties break on array order.                                 |
| `interactive`       | `false` skips it in hit testing — for a marker that is decoration.             |
| `title`             | What a screen reader announces. The position, formatted, when there is none.   |
| `data`              | Handed back on an event. Never read here.                                      |

`markers` is diffed into damage: a vehicle moving across a city claims two
marker-sized boxes rather than the pane, so a live feed of a few hundred
markers is a few hundred small rectangles per update and not a full repaint.

## Overlays

One discriminated union, because a route, a traffic segment, a transit
shape and a GeoJSON layer are all the same three shapes underneath:

- `{ kind: 'line', path, color, width, dash, casing }` — `casing` is the
  wider stroke drawn under the line, which is what makes a route readable
  over a road of the same colour.
- `{ kind: 'polygon', rings, fill, outline }` — exterior ring first, every
  ring after it a hole.
- `{ kind: 'circle', center, radiusMetres, fill, outline }` — in **ground
  metres**, so it grows with the zoom the way a real radius does. The
  pixel radius is taken from the projection rather than from a
  metres-per-pixel constant, so it stays right at high latitudes.

Two format helpers come with them, because these are the two shapes real
data actually arrives in:

- **`decodePolyline(encoded, precision = 5)`** — Google's Encoded Polyline
  Algorithm Format, which is what Google Directions, OSRM, Valhalla,
  GraphHopper and Mapbox Directions all answer with. Precision 6 is
  Valhalla's and OSRM's `polyline6`; passing the wrong one puts the route
  in the Atlantic, which is the traditional way to discover this parameter.
- **`geoJsonOverlays(geojson, style?)`** — points become markers,
  everything else becomes an overlay. `style` is asked once per feature, so
  colouring by a property (a traffic feed's congestion, a transit feed's
  route colour) needs no expression language.

## Styling

`mapStyle` is a **subset of the Mapbox/MapLibre GL style specification** —
shaped after that spec because every provider documents their schema in its
terms, so a fragment from Shortbread's, OpenMapTiles' or Azure Maps' docs
reads the same way here.

Four layer types (`fill`, `line`, `circle`, `symbol`), the spec's **legacy
filter syntax** (`['all', ['==', 'kind', 'motorway'], …]`), and `{ stops }`
for anything that varies with zoom. What is deliberately absent is the
expression language: it is a typed interpreter with a cost per feature, and
a dense tile has twelve thousand of those. Everything here is resolved once
per layer per frame.

```ts
const style: MapStyle = {
  background: '#f2efe9',
  layers: [
    {
      id: 'water',
      type: 'fill',
      sourceLayer: 'water_polygons',
      color: '#aad3df',
    },
    {
      id: 'roads',
      type: 'line',
      sourceLayer: 'streets',
      minZoom: 10,
      filter: ['in', 'kind', 'motorway', 'trunk', 'primary'],
      color: '#fff',
      width: {
        stops: [
          [10, 1],
          [14, 3],
          [18, 10],
        ],
      },
    },
  ],
};
```

`SymbolLayer` has one field worth knowing about before you wonder why a
street is labelled once: **`repeatDistance`** (250 px by default) is how far
apart the same text may repeat within a layer. A street is one feature _per
segment_ in every schema there is, so `street_labels` offers "Oxford Street"
a dozen times over for one street, none of them overlapping any other;
without the rule a placement accepts all twelve.

`shortbreadStyle({ dark, palette, nameField, labels, buildings })` is the
default, written against OpenStreetMap's own schema: twenty-six layers, in
paint order, with road **casings as one pass and road fills as another** —
which is what makes a junction look like a junction rather than two roads
crossing.

## The handle

```tsx
const map = useRef<MapHandle>(null);
map.current?.fitMarkers();
```

`getCamera` / `setCamera` / `panBy` / `zoomIn` / `zoomOut` / `zoomTo`,
`fitBounds(bounds, { padding, maxZoom })`, `fitMarkers(ids?)`,
`getBounds()`, `project` / `unproject` (geography ↔ pane-local logical
pixels), `markerAt(x, y)`, `refresh()` (throw away every rendered tile,
after a style you edited in place) and `stats()`.

`fitBounds` called before layout has run — which `fitBounds` in an effect
always is — is remembered and applied at the first paint that has a size.

## The decisions

These are the paragraphs that look like gaps and are not.

**The camera is the element's unless you take it.** With `camera` given,
the element only ever _asks_ to move and your state is the truth. Without
it, the element owns the camera and a pan never reaches React at all —
which is not a convenience but the performance model: a drag step moves two
numbers, blits the band that survives and repaints the strip that was
exposed. Routed through `useState` instead, every pointer step would be a
render, a commit and a full-pane damage claim.

**A tile appears whole, not layer by layer.** Rasterization is resumable a
style layer at a time, so a surface that exists is not a surface that is
done — composited as soon as it exists, a dense tile arrives as water, then
landuse, then road casings, then roads, over a dozen frames. That is honest
about what the renderer is doing and it does not look like a map, so a tile
is shown when it is finished and the coarser one already in the cache is
scaled up until then. `progressive` turns the reveal back on.

**And a tile being _re_-drawn keeps showing the old picture.** Each tile has
up to two renderings — the one on screen and the one being drawn — and they
swap only when the new one is finished. Without that, every re-rasterization
blanks the tile for the several frames a redraw takes, and above a source's
`maxZoom` that is _every_ integer zoom, because the same z14 tile serves 15,
16, 17 and on: a flash per zoom step, and many more of them on a backend
that paints more frames a second.

The cost is memory: a tile being redrawn holds two surfaces, so a viewport
mid-redraw peaks at about twice its resident bytes. `surfaceBudget` counts
both, and eviction never touches a tile the current frame is using.

What none of this helps is a **first** load — a tile nothing has ever drawn
has no old picture of its own to keep. What covers it is whatever _is_
cached nearby, and which direction that lies in says which way the camera
moved:

- **Zooming in**, the tile in hand is the target's **ancestor** — one
  composite, scaled up, blurry but complete.
- **Zooming out**, the tiles in hand are its **descendants** — several
  composites, scaled down, sharp but only as complete as the pieces that
  are cached. Without this a zoom-out shows the background, with the labels
  and markers still drawn over it, until the coarser tile has been fetched,
  rasterized and composited.

Descendants win when they cover the whole square, because they are sharper
and they are the level the camera is coming _from_; the ancestor wins when
they do not, because a complete blurry picture beats a sharp one with holes
in it. A cold map with neither shows its background. `MapFrameStats` counts
both as `fromAncestor` and `fromDescendant`.

**A frame that only continues a redraw claims one pixel.** There is no "call
me next frame" on the element seam — damage is what schedules a paint — so a
rasterization in progress asks for its next frame with a single-pixel claim.
Nothing on screen changes until the tile lands (it is being drawn into a
second surface), and the frame where it does lands claims that tile's box.
Claiming the pane instead repaints the whole map at the refresh rate for the
several frames a redraw takes: invisible work on X11, and a visible burst of
repaints at the end of every zoom on the Cocoa backend, which paints many
more frames a second. `MapFrameStats.damage` is how to see this.

**Why a map fills in.** A dense city tile is 50–140 ms to rasterize (the
PRD has the measurements, on both backends). That is a software rasterizer
drawing a hundred thousand vertices, and no arrangement of this component
makes it free. What it does instead is make sure it is never _in a frame_:
rasterization is resumable by style layer and a frame spends at most
`rasterBudgetMs` on it, so a slow tile is drawn over a dozen frames and no
frame is late. **At least one tile is drawn per frame whatever the budget**,
because a budget smaller than one unit of work is not "do less" but "do
nothing", and a frame that finished nothing asks for another one. While a tile is incomplete the map shows the coarser
ancestor already in the cache, scaled — which is why zooming in sharpens
rather than flashing empty.

**A gesture rasterizes nothing.** The budget is zero for the length of a
drag or a wheel and for a moment after it, so a gesture is composites only.
This is what the per-tile surfaces buy: a pan composites the same surfaces
at new offsets, a fractional zoom composites them scaled, and neither
touches the rasterizer. Only crossing an integer zoom does.

**Labels are not in the tiles.** They are collected from the symbol layers,
placed against each other in **world** pixels, and drawn into the frame.
Collision is global (two labels in different tiles overlap as readily as
two in one), text must not be stretched by a fractional zoom, and a tile's
labels would be clipped at its edge — which is where half of them sit.
Placing in world rather than screen pixels is what lets a pan translate an
existing placement rather than recompute it, which is what keeps the pan a
blit.

**Line labels are placed at a point.** A street name should follow its
street and a country name should sit at the pole of inaccessibility of its
border; both start from an anchor, and the anchor is what is implemented —
the midpoint of the longest part. It is right often enough to be worth
having and it is not the finished thing. See the PRD.

**Rotation and pitch are not here.** This is a north-up 2D map. Both are
real features and neither is a small one — a rotated viewport changes the
tile cover, the label placement and every hit test — and the PRD records
what they would take.

**`maxZoom` on a source is the data, not the map — and past it the map
sub-tiles rather than stretches.** OpenStreetMap cuts Shortbread to z14. A
view at zoom 20 does not draw one z14 tile at sixty-four times its size: the
cover synthesizes z20 tiles, 4,096 of them share that one z14 fetch, and
each is rasterized at its own natural size with the parent's geometry
clipped to it. So a zoom-20 view is drawn at screen resolution from vector
data, not upscaled from a bitmap — 1:1 up to about zoom 21, where the
surface cap finally bites.

What _does_ run out is the data: at zoom 20 one unit of a z14 tile's
4,096-unit grid is already 16 device pixels across, so there is no more
shape in the tile to draw. Six levels of synthesis is the cap, for that
reason rather than for a rendering one.

Cost, measured on a dense central-London tile: the whole z14 tile is 56 ms
to rasterize; one of its four z15 cells is 37 ms, one of 256 z18 cells is
7.7 ms, and one of 4,096 z20 cells is 6 ms — because a feature whose box
misses the cell is skipped before it becomes a path. Deep zoom is _cheaper_
per tile than shallow zoom, and only the handful on screen are ever built.

**A missing tile, a 404 and an empty ocean are the same answer.** `null`
from `load`, and the map draws its background there. Only a `load` that
_throws_ is an error, and it is retried on a backoff rather than on the next
frame — a source that is down would otherwise be asked for every visible
tile sixty times a second, which is a retry storm pointed at somebody
else's servers.

**Everything is clipped to the viewport, and it has to be.** Two separate
limits, both in XRender and both reached in ordinary use:

- **Tile composites are int16.** An overzoomed tile dwarfs the pane — at
  zoom 22 against a pyramid that stops at 14, one tile is `512 · 2^8` =
  131,072 logical pixels across — so a tile that overlaps the pane can start
  73,000 pixels outside it. The destination rectangle is clipped and the
  source rectangle moved to match, which leaves the scale factor exactly
  what it was.
- **Overlay geometry is 16.16 fixed point**, which overflows a signed 32-bit
  word at 32,768.

**Overlay geometry, in particular.** An
overlay is geography, so a route's far end stays where it is when the camera
zooms in on one corner of it — and a world is `512 · 2^zoom` pixels across,
which at zoom 20 is 134 million. ntk hands a stroke's geometry to XRender in
16.16 fixed point, which overflows a signed 32-bit word at 32,768, so an
unclipped overlay is a `RangeError` thrown from inside `paint` a few zoom
steps in. Lines are cut segment by segment, rings are clipped as rings (so a
fill keeps a closed boundary), and a circle too large to draw as an arc
becomes a clipped ring.

## Running it

```bash
npm run examples:maps          # needs a real $DISPLAY and a network
npx tsx scripts/bench/tiles.ts # fetch the profiling corpus (real OSM tiles)
npx tsx scripts/bench/maps.ts  # profile decode and raster on both backends
```
