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
  import ntk from 'react-x11/ntk';
  const decode = (bytes: Uint8Array) => {
    const image = (
      ntk as {
        decodeImage(b: Uint8Array): {
          width: number;
          height: number;
          data: Uint8Array;
        };
      }
    ).decodeImage(bytes);
    return { width: image.width, height: image.height, data: image.data };
  };
  ```

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
| `rasterBudgetMs` | Milliseconds a frame may spend rasterizing tiles. 8 by default; `0` suspends it. See "Why a map fills in".                                        |
| `rasterScale`    | Device pixels per logical pixel for the tile surfaces. The display's by default; 1 on a retina panel is ~1.6× quicker and correspondingly softer. |
| `surfaceBudget`  | Bytes of rendered tile surfaces to keep. 128 MB by default.                                                                                       |
| `batchVertices`  | The rasterizer's path-flush size. Chosen from the backend by default — set it only with a profile in hand, and read the PRD first.                |
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

**Why a map fills in.** A dense city tile is 50–140 ms to rasterize (the
PRD has the measurements, on both backends). That is a software rasterizer
drawing a hundred thousand vertices, and no arrangement of this component
makes it free. What it does instead is make sure it is never _in a frame_:
rasterization is resumable by style layer and a frame spends at most
`rasterBudgetMs` on it, so a slow tile fills in over a dozen frames and no
frame is late. While a tile is incomplete the map shows the coarser
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

**`maxZoom` on a source is the data, not the map.** OpenStreetMap cuts
Shortbread to z14; a view at z17 draws z14 tiles at eight times their size,
which is what every client does with that pyramid and why street detail
stops sharpening past it.

**A missing tile, a 404 and an empty ocean are the same answer.** `null`
from `load`, and the map draws its background there. Only a `load` that
_throws_ is an error, and it is retried on a backoff rather than on the next
frame — a source that is down would otherwise be asked for every visible
tile sixty times a second, which is a retry storm pointed at somebody
else's servers.

**Overlay geometry is clipped to the viewport, and it has to be.** An
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
