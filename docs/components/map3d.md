# Map3D

```tsx
import { Map3D, GOOGLE_3D_TILES } from '@react-x11/components/map3d';

<Map3D
  query={{ key: process.env.GOOGLE_MAPS_API_KEY! }}
  defaultCamera={{
    lat: -37.8136,
    lon: 144.9631,
    heading: 20,
    pitch: 55,
    range: 700,
  }}
  style={{ flexGrow: 1 }}
/>;
```

`<Map3D>` draws an [OGC 3D Tiles](https://github.com/CesiumGS/3d-tiles) tileset — Google's Photorealistic 3D Tiles
by default — in a `<glarea>`, seen from an orbit camera. It registers no host element of its own; it is composition
over core's `<glarea>`.

**Direct GL only, and on both backends where that holds.** It needs the direct GL connection: always on the Cocoa
backend, `glPolicy: 'auto'` on X11. On an indirect connection `onError` is called and nothing is drawn.

## Why it is not a mode of `<Map>`

`<Map>`'s camera is a centre and a zoom over a plane, and its tile pyramid, label placement and hit test are all
that plane's. A tilted camera over a mesh shares none of it, so this is a sibling that shares only the idea of a
place (longitude, latitude).

## Props

| Prop                                              | Description                                                                                                                                                                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultCamera`                                   | `{ lat, lon, height?, heading, pitch, range }`. Read once. `pitch` is degrees down from the horizon (90 is straight down), `range` the metres from target to eye. With no `height` the target follows the ground under it. |
| `query`                                           | Appended to every request: `{ key }` for Google.                                                                                                                                                                           |
| `url`                                             | The tileset's root; `GOOGLE_3D_TILES` by default.                                                                                                                                                                          |
| `maxError`                                        | A tile is refined while its geometric error would span more than this many pixels. 16 by default.                                                                                                                          |
| `sky`                                             | The colour behind the world.                                                                                                                                                                                               |
| `fetch`                                           | Replaces `fetch`, to put your own policy on the requests.                                                                                                                                                                  |
| `onCameraChange`, `onError`, `onStats`, `onFrame` | `onFrame` is handed the GL context after each frame, for read-back or extra drawing.                                                                                                                                       |

Drag turns and tilts, shift-drag (or right-drag) slides the target, the wheel moves closer or away.

## The decisions

- **Google's tiles arrive already decoded.** The Map Tiles API answers plain glTF (floats, 16-bit indices, a JPEG in
  a buffer view). So the glTF reader is 150 lines, there is no scene-graph library and no Draco decoder, and a file
  that does ask for `KHR_draco_mesh_compression` or `EXT_meshopt_compression` is refused with a message that says so.
  JPEGs are decoded by core's `decodeImageBytes`.
- **A tile is the unit of everything.** One buffer pair and one texture per tile, uploaded in the frame that first
  draws it and let go of when the cache evicts it (600 tiles, least recently drawn first). No atlas: a program
  samples one texture at a time here.
- **Refinement waits for the whole of it.** A node is replaced by its children only when every child is loaded; until
  then the node's own, coarser tile stays up, so a view never has a hole in it while it sharpens.
- **Vertices are float64 until the last step.** Earth-centred metres are millions; positions are turned into a local
  frame (east, up, north) at the camera's start point in double precision and only then stored as float32. Move the
  camera far from where it started (tens of kilometres) and precision degrades; mount a new `<Map3D>` there.
- **Attribution is drawn.** Google's terms require its name and each tile's copyright credit to be shown; the
  component draws them over the surface (`glOverlay` backends only — on XQuartz a surface's children cannot be drawn
  over it, so read the credit from `onStats`-time tiles yourself there). Nothing is written to disk.
- **Not here yet:** a keyboard, picking, lighting, labels and overlays over the mesh, and a `<Map>` toggle. They are
  compositions over this component rather than reasons to change it.

`GOOGLE_MAPS_API_KEY=… npm run examples:map3d [lat lon]` runs it; `MAP3D_SHOT=file.png` writes the first complete
frame and exits.
