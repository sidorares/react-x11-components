# A map worth having

The design record behind [`<Map>`](components/maps.md): what the formats
actually are, who serves them, what the "extra layers" everyone asks for
turn out to be, and the measurements that produced the rendering
architecture. The reference page is the API; this is why it has that shape.

Status: **implemented**, for 2D, north-up, vector and raster tiles.

## The survey

### Tile formats

Two formats matter, and one of them is the whole open half of the industry.

**Mapbox Vector Tile (MVT)**, currently at spec 2.1, is a Protocol Buffers
message: a tile is layers, a layer is features plus a deduplicated table of
keys and values, and a feature's geometry is a stream of packed `uint32`
commands — `MoveTo`, `LineTo`, `ClosePath` — with zigzag-encoded deltas from
a cursor. Coordinates are integers in a per-layer `extent` (4096 by
convention) that divides the tile's own square, and geometry is allowed to
run past that square, which is the buffer that makes a road's join right
where two tiles meet. Mapbox, MapTiler, Protomaps, Esri, TomTom, Azure Maps
and OpenStreetMap's own tile server all serve it. The specification is
short, and `src/maps/mvt.ts` implements it whole.

Three details in it are where a decoder goes quietly wrong, so they are
called out in the code and pinned by tests: the geometry cursor **persists
across parts**, so a multi-part feature whose second `MoveTo` resets it
draws in the wrong place; a ring's last point is **not repeated** before
`ClosePath`, so the closing edge has to be supplied; and an exterior ring
is defined as one with **positive** area by the surveyor's formula in tile
coordinates, where y increases downward — which is what lets a whole
multipolygon be filled with the non-zero rule and get its holes for free.

**Raster tiles** are PNG or JPEG or WebP over the same `{z}/{x}/{y}` slippy
scheme (or WMTS, or the older TMS with its flipped y). There is nothing to
decode but the image, which is why `<Map>` takes raster tiles as pixels and
leaves the codec to the application.

Two container formats are worth knowing about and are not implemented:
**PMTiles** (a single file with a 127-byte header, addressed by HTTP range
requests, which is how Protomaps ships a whole-planet basemap with no
server) and **MBTiles** (the same tiles in SQLite). Both are ways of
_getting_ tiles, so both are a `MapSource` an application writes; neither
needs anything from this component.

### Schemas

The format says how bytes are laid out; a **schema** says which layers exist
and what their fields mean, and they are not interchangeable.

- **Shortbread** — OpenStreetMap's own, at version 1.1, served from
  `vector.openstreetmap.org` since 2025. Deliberately lean and
  general-purpose. This is what `shortbreadStyle()` is written against,
  because it is the one open schema with an open, keyless, canonical server
  behind it.
- **OpenMapTiles** — the older open schema, what MapTiler serves and what
  most self-hosted planet extracts use.
- **Mapbox Streets v8**, **Protomaps basemap**, **Azure Maps**,
  **TomTom Orbis** — each a vendor's own, each documented, each different.

Nothing about the component is tied to a schema: a style names source
layers and fields, so a second schema is a second style.

### Providers

| provider                                       | 2D tiles                                                 | usable here                                                                                                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenStreetMap**                              | Shortbread vector, and the classic raster style          | **Yes**, keyless, open licence. Both adapters ship.                                                                                                                                                                             |
| **MapTiler, Stadia, Protomaps, Thunderforest** | OpenMapTiles or their own MVT                            | Yes — a URL template and a key, which is a `MapSource` of five lines.                                                                                                                                                           |
| **Microsoft Azure Maps**                       | MVT (`microsoft.base`, `.labels`, `.hybrid`) plus raster | Yes, with a subscription key. Documents its schema.                                                                                                                                                                             |
| **Google Maps**                                | Map Tiles API: 2D raster and vector "roadmap" tiles      | Only through their API, under their terms: a session token per set of display options, valid two weeks, and tiles that may not be cached or re-served. The vector schema is not published, so a style cannot be written for it. |
| **Apple**                                      | MapKit / MapKit JS only                                  | **No.** There is no documented tile endpoint, and their terms forbid scraping one.                                                                                                                                              |

The two closed ones are recorded here so the question is not reopened:
Google's tiles are reachable but their vector schema is not documented, and
Apple's are not reachable at all.

### The layers everyone asks for

The useful finding is that "traffic", "routes" and "transit" are not three
features. They are the same two or three geometric shapes arriving in
different envelopes.

- **Traffic** — TomTom serves flow and incidents as **MVT** (layers
  `Traffic incidents flow` and `Traffic incidents POI`) and as raster;
  Azure Maps serves both `png` and `pbf`; HERE and Google serve a raster
  overlay. So: either another tile source over the basemap, or a set of
  coloured line overlays. Both work today, and the standards behind the
  data (TPEG, DATEX II, TMC location codes) never reach the renderer.
- **Routes** — every routing engine on the open web (Google Directions,
  OSRM, Valhalla, GraphHopper, Mapbox Directions) answers with an
  **encoded polyline**, which is why `decodePolyline` is in the package
  rather than in the example. A route is then one `line` overlay, and the
  `casing` field is what makes it readable over a road of the same colour.
- **Transit** — **GTFS** static gives shapes as encoded polylines in
  `shapes.txt` and stops as points; **GTFS-Realtime** is a protobuf feed of
  vehicle positions, each a latitude and longitude with an optional
  bearing. So: a line overlay per shape, and a marker per vehicle, updated
  as the feed arrives. That last case is why `markers` diffs into
  marker-sized damage rather than repainting the pane.
- **Terrain** — Terrarium and Mapbox Terrain-RGB encode elevation in a PNG's
  channels. Reachable as a raster source, but nothing here interprets it;
  hillshading is a renderer feature, not a format one, and is not
  implemented.
- **Everything else an application has** — GeoJSON, and `geoJsonOverlays`
  turns it into markers and overlays. TopoJSON, WKT, Shapefile,
  FlatGeobuf and GeoPackage are all conversions an application does before
  it gets here.

## The shape of the component

### It draws; it does not compose

`AGENTS.md` states the rule: **ask whether the feature's viewport is a
transform.** A map's is. This renderer's style vocabulary has no transform,
so a composed map would have to re-render every road through React and
re-lay-out every road through yoga on every pointer step of a pan. So
`<mapview>` is one registered element that draws the whole map, which is
`<Flow>`'s shape.

What a map adds to `<Flow>`'s case is that the scene **arrives a tile at a
time** and costs tens of milliseconds a tile to draw. That is what the rest
of this document is about.

### Nothing fetches

`<Html onResource>`'s rule, for the same reason: a component whose default
made requests would decide, on the application's behalf, whose servers it
talks to, what its user agent says, and whose usage policy it is now bound
by. So a `MapSource` is a `load` function the application supplies, and the
OSM adapters supply the URL, the schema and the attribution around it.

The attribution is the part that is not merely tidy. For OpenStreetMap-derived
tiles it is a licence condition, so a source carries it, the map draws it,
and `attribution=""` is how an application says it has put it elsewhere.

Two things the first cut of this seam got wrong, both found by running the
example against the real network rather than against the test corpus, and
both now pinned by tests. The `signal` handed to `load` was a plain object
with an `aborted` getter; `fetch` checks `instanceof AbortSignal` and throws
`TypeError` on anything else, so **every load failed** in exactly the way the
documentation told people to write. And there was no way to see that: a
failed tile draws nothing, so a map whose every tile fails is pixel-identical
to one that is still loading. `onTileError` and `MapFrameStats.errors` exist
because of that, and the retry is on a backoff (0.5 s doubling to 30 s)
because the same bug had every visible tile re-asked once a frame.

### The style is a subset of the GL style spec

Shaped after Mapbox/MapLibre's specification because every provider
documents their schema in its terms, so a fragment of Shortbread's or Azure
Maps' documentation reads the same way here. Four layer types, the spec's
**legacy filter syntax**, and `{ stops }` for zoom ramps.

The expression language is deliberately absent. It is a small typed
interpreter with a cost _per feature_, and a dense tile has twelve thousand
features and eighteen layers — so anything computed per layer is free and
anything computed per feature is the frame. Filters compile to closures
once per style; paint values resolve once per layer per frame.

The one place this bites is symbol ranking. A schema's own importance field
looks like the obvious input for "which label wins" and is not usable as
one: Shortbread carries `population`, which is 8,000,000 for London and 500
for Soho, and normalizing that against a rank that also has to order
against street names is a guess. Splitting by `filter` — a layer for
cities, a layer for suburbs — is exact, and is what the ordering wanted
anyway.

## The rendering architecture

Three caches, layered, and the whole performance argument is the layering.

1. **Tile data**, keyed on `source/z/x/y`, valid forever: a tile's contents
   do not depend on where the camera is.
2. **Up to two rendered `Surface`s per tile** — the one on screen and the
   one being drawn — each valid for a zoom _level_ and a style but not for a
   camera position. So a **pan** composites the same surfaces at new
   offsets, and a **fractional zoom** composites them scaled. Neither
   rasterizes anything. Only crossing an integer zoom does, and while it
   redraws, the previous picture stays up.
3. **A label placement in world pixels**, valid for a zoom and a set of
   loaded tiles — so a pan translates it rather than recomputing it.

Around them:

- **A pan is a blit.** `scrollContents` (react-x11#303) claims the pane,
  arms the frame to shift the band that survives inside the backing store,
  and narrows the claim to the strip that was exposed — which
  `paintDamage()` then hands to the paint. The attribution strip is carved
  out of the shifted region and claimed the ordinary way, because it is
  pinned to the pane and must not ride the blit.
- **The uncontrolled camera lives on the element**, not in a `useState`
  above it. This is the difference between a drag step costing two numbers
  and a strip, and costing a render, a commit and a full-pane damage claim.
  A controlled camera puts the application back in the loop, which is its
  right, and `selfDamagedProps` keeps the commit from claiming the pane.
- **Rasterization is budgeted and resumable**, by style layer. A frame
  spends at most `rasterBudgetMs` (8 by default) on it and remembers where
  it stopped — but **always draws at least one tile**, because a budget
  smaller than one unit of work is not "do less" but "do nothing", and a
  frame that finished nothing asks for another one, forever. The budget is
  measured on `performance.now()`: `Date.now()` counts whole milliseconds,
  which is 12% of error on an 8 ms budget and rounds anything under 1 ms to
  a deadline that has already passed.
- **A tile is composited when it is finished**, not while it is being drawn.
  Composited as soon as its surface exists, a dense tile arrives as water,
  then landuse, then casings, then roads, across a dozen frames — honest
  about the renderer and unlike any other map. `progressive` opts back in.
  What waiting costs is a transition that invalidates every surface at once
  (a style change, `refresh()`, a scale change): no finished tile _and_ no
  finished ancestor, so the map shows its background until the new tiles
  land. Holding the old picture through that needs a second surface per
  tile — draw into a draft, swap on completion — which doubles the surface
  memory of every tile being redrawn and is deliberately not done here.
- **A gesture rasterizes nothing.** Any camera move sets the budget to zero
  for 140 ms, so a drag or a wheel is composites only and the map sharpens
  when it stops.
- **A hole is covered by an ancestor.** A tile with no surface yet borrows
  the nearest coarser one that has, scaled up, which is why zooming in
  sharpens rather than flashing empty.

### Labels

Collected from the symbol layers, placed greedily by rank, and drawn into
the frame rather than into the tiles. Three reasons, each a visible bug if
it is done the other way: collision is global, so per-tile placement is
clutter at every seam; a tile surface is composited at up to 2× during a
fractional zoom, and text is the one thing nobody accepts blurred; and a
tile's labels would be clipped at its edge, which is where half of them
sit.

Placement is computed in **world** pixels rather than screen pixels. That
is what makes it survive a pan — whether a label wins depends only on the
labels near it and the zoom — and therefore what keeps the pan a blit.

## The profile

Everything below is measured on the corpus `scripts/bench/tiles.ts`
fetches: real OpenStreetMap Shortbread tiles for Manhattan, central London,
Tokyo and a mid-Pacific control, 103 tiles over zooms 0–14. Reproduce with
`npx tsx scripts/bench/maps.ts`.

The corpus is worth stating, because the numbers only mean anything against
it:

```
 z  tiles  features/tile  vertices/tile  KB/tile  layers
 0      1              1          22231       51  1
 6      4           9474          55376      324  7
 8      4          13049         154091      603  8
10     16           6534          95456      344  9
12     35           4258          31077      162  18
14     36           5474          43840      233  23
```

The decoder runs the whole of it — 541,051 features, 5,185,205 vertices —
with **zero anomalies**: no polygon without an exterior ring, no empty
geometry, and `extent` values of 2048 and 4096 in the same tile, which is
what taught the renderer to read extent per layer rather than per tile.

### Decoding

0.7–11 ms per tile, protobuf plus geometry, identical on both backends. Not
the bottleneck, and the reason the decoder reads into caller-owned typed
arrays rather than returning arrays of `{x, y}` objects: the convenient
shape would allocate about 100,000 objects per dense tile, for one
rasterization.

### Rasterizing one tile

Median of 7, a 512-logical-pixel tile at display scale 2 (a 1024-pixel
surface). "First draft" is the straightforward implementation; "tuned" is
what shipped.

| zoom | tile         | x11 first | x11 tuned | cocoa first | cocoa tuned |
| ---- | ------------ | --------: | --------: | ----------: | ----------: |
| 0    | 0/0/0        |       7.4 |       7.4 |         4.8 |         2.8 |
| 6    | 6/18/24      |      88.4 |        62 |       210.7 |          54 |
| 8    | 8/227/100    |     161.9 |       121 |       475.7 |         134 |
| 10   | 10/511/340   |     127.4 |       115 |       309.5 |         140 |
| 12   | 12/3638/1612 |     137.7 |       122 |       263.9 |         101 |
| 14   | 14/8185/5447 |      58.9 |        49 |       426.9 |          77 |

What produced the difference, in the order the profiler found it:

1. **A CPU profile said 42% of active time was in ntk's software
   rasterizer** (`toAlpha` and `edge` in `rasterize.js`), with another 60%
   of wall-clock idle uploading megabyte coverage masks. Forcing ntk's
   server-side trapezoid path instead — the obvious next thought — is
   **catastrophically slower**: a single zoom-12 tile did not finish in 280
   seconds, on XQuartz and on X.Org's Xvfb alike. ntk's heuristic is right,
   and there is no escape hatch here to reach for.
2. **Per-_part_ culling, not per-feature.** OSM's `land` layer at zoom 8 is
   a _single feature_ whose geometry is thousands of separate rings, most of
   them a fraction of a pixel across. Culled as one feature it is never
   culled.
3. **Simplification against the target grid** — a radial test and then a
   perpendicular one, both in the same vertex loop. The perpendicular test
   is the one that matters on real data: a generalized coastline's vertices
   are about a pixel apart, which the radial test keeps, and nearly
   collinear, which this drops.
4. **One seek pass per run of style layers over one source layer.** A road
   network is fourteen style layers over `streets` (seven classes, casings
   and fills), so a layer-at-a-time walk parses each of 8,488 features'
   headers and tags fourteen times over.
5. **A tag cache on the feature cursor**, so those fourteen filters read
   decoded integers rather than re-decoding varints.
6. **The path flush size is per backend, and the two want opposite
   things.** On X11 a fill becomes an a8 coverage mask uploaded with one
   `PutImage`, so a bigger path is fewer uploads over the same pixels:
   12,000 vertices measured best, and 500 measured 25% worse. On the Cocoa
   backend the path goes to `CGContextStrokePath`, whose cost is
   superlinear in the number of subpaths: 512 measured best, and 12,000
   measured **three times worse**. `batchVertices` is the prop, and
   `app.nativeBezels` — core's own probe for the Cocoa backend — is the
   default.
7. **The flush has to be able to interrupt a single feature.** The finding
   that fixed Cocoa's zoom 14: `buildings` in a central London tile is _one_
   feature with 26,314 vertices, and flushing only between features left it
   as one 347 ms `CGContextStrokePath`. Flushing inside the part loop
   brought that layer to a fraction of it — but only at a **polygon**
   boundary, which is what `areas` is for: flushing between an exterior
   ring and its interior ones fills the hole in.

### A whole frame

1200×800 at scale 2, on the densest zoom-12 city block in the corpus.

| backend | phase  |       frames | draw median / p95 | raster median / max |
| ------- | ------ | -----------: | ----------------: | ------------------: |
| x11     | settle | 28 (1877 ms) |      3.5 / 5.0 ms |          13 / 55 ms |
| x11     | pan    |           16 |     6.0 / 11.0 ms |        **0 / 0 ms** |
| x11     | zoom   |            4 |      1.5 / 5.0 ms |        **0 / 0 ms** |
| cocoa   | settle | 64 (1302 ms) |      8.0 / 9.0 ms |           8 / 44 ms |
| cocoa   | pan    |          119 |      0.0 / 1.0 ms |        **0 / 0 ms** |
| cocoa   | zoom   |            9 |     6.0 / 22.0 ms |        **0 / 0 ms** |

The zeroes are the point. A pan and a fractional zoom rasterize _nothing_;
they composite surfaces that already exist. A cold dense city view fills in
over one to two seconds, in frames that are individually cheap.

Before the budget could interrupt a run, the same settle measured a median
of 47 ms and a **maximum of 192 ms** per frame on x11 — one style layer,
uninterruptible. The remaining 44–55 ms maximum is the same shape one level
down: a single layer that is one enormous multipolygon. Splitting inside a
layer is the next thing to do if it matters.

## One gap, upstream

Found by the profile, core's rather than this package's, and not worked
around here — which is the rule `AGENTS.md` states as "no escape hatches".

**`CGContextStrokePath` is superlinear in the number of subpaths**
([react-x11#456](https://github.com/sidorares/react-x11/issues/456)). One path
holding a zoom-14 tile's `buildings` layer — a _single_ MVT feature with
26,314 vertices in about two thousand rings — measured **347 ms**; the same
rings flushed in batches of 512 vertices measured a fifth of that. A CPU
profile of the Cocoa raster stage put **76.2%** of all samples inside that
one native call. Reported so the backend can chunk on the _native_ side,
where it can pick the size rather than having every caller guess it.

**And a thing that looks like a second gap and is not**, recorded because it
was the first hypothesis and the measurement refuted it. The Cocoa 2d
context makes one napi call per path operation — `moveTo`, `lineTo` and
`closePath` each cross the boundary
(`react-x11/src/cocoa/context2d.js`) — so a 45,000-vertex path is 45,000
crossings, and batching them looked like the obvious fix. It is not where
the time goes: in the same profile `lineTo` is **18 ms of 3,143**, 0.6%, and
flushing the path in batches — which does not reduce the number of `lineTo`
calls at all — still gave a five-fold improvement. The crossings are cheap;
the stroke is not.

## Three bugs the test corpus could not have found

Recorded because each was invisible to a suite that passed, and each was
found by running the thing.

- **The `signal` handed to a source was not an `AbortSignal`.** It was a
  plain object with an `aborted` getter, and `fetch` checks
  `instanceof AbortSignal` and throws `TypeError` on anything else — so
  every load failed in exactly the way the documentation prescribed. The
  headless tests never saw it because their sources answer synchronously
  and never call `fetch`.
- **Nothing reported that.** A failed tile draws nothing, so a map whose
  every tile fails is pixel-identical to one that is still loading. There
  was no signal at any layer — no callback, no counter, no log — and the
  first report was a screenshot of an empty map. `onTileError` and
  `MapFrameStats.errors` exist because of it, and the retry moved to a
  backoff because the same bug had every visible tile re-asked once a frame.
- **Nothing was clipped to the viewport**, and it turned out to be two bugs
  with two different limits, both thrown from inside `paint` where no
  application can catch them.

  Three or four zoom steps in, an **overlay** overflowed: an overlay is
  geography, a world is `512 · 2^zoom` pixels (134 million at zoom 20), and
  ntk hands a stroke to XRender in 16.16 fixed point, which overflows a
  signed 32-bit word at 32,768. Lines are now cut segment by segment, rings
  clipped as rings, and an over-large circle drawn as a clipped ring.

  Past zoom 20 the **tile composite** overflowed, on a different limit:
  XRender takes composite coordinates as int16, and an overzoomed tile
  dwarfs the pane — at zoom 22 against a pyramid that stops at 14 a tile is
  131,072 logical pixels across, so one that overlaps the pane starts
  73,000 pixels outside it. The destination is clipped and the source
  rectangle moved to match, which leaves `sw/dw` exactly what it was.

  Every headless test framed its content, so none of them had anything far
  enough out — which is the lesson rather than the fix. **A test that only
  ever looks at what it is drawing cannot find a coordinate-range bug**,
  and both regressions now zoom until they would have thrown.

## What is not here

Recorded so the questions are not reopened as bugs.

- **Rotation and pitch.** A north-up 2D map. Both are real features and
  neither is small: a rotated viewport changes the tile cover (an
  axis-aligned rectangle in screen space is a rotated one in tile space),
  the label placement, and every hit test. Pitch additionally needs
  per-vertex perspective, which is a different rasterizer.
- **Line and area label placement.** Labels are placed at a point; a street
  name should follow its street and a country name should sit at its
  polygon's pole of inaccessibility. The anchor is implemented and the
  curve is not.
- **Icons in symbol layers.** Text only. Sprites are a second asset
  pipeline (a sheet, an index, a scale factor), and the same thing is
  reachable today by putting a marker where the label would be.
- **Clustering.** A `markers` array of ten thousand points is ten thousand
  markers. Supercluster-shaped grouping is a pure function over positions
  and a zoom, which makes it an application's to run and a `markers` array
  to pass in — and it is a candidate for `src/maps/` if two applications
  write it.
- **Terrain, hillshading and 3D buildings.** Out of scope for "2D only".
- **A style-spec parser.** `mapStyle` is a typed object. Reading a real
  `style.json` from a provider means the expression language, sprites,
  glyphs (PBF SDF fonts) and the rest of the spec; it is a plausible
  separate module and not this one.
