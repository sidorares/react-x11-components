// `<Map3D>`: Google's Photorealistic 3D Tiles, seen from an orbit camera.
//
//   GOOGLE_MAPS_API_KEY=… npm run examples:map3d                # Melbourne
//   GOOGLE_MAPS_API_KEY=… npm run examples:map3d -- -33.8568 151.2153   # lat lon
//
// Drag to turn and tilt, shift-drag or right-drag to slide, wheel to move closer or away. Needs direct GL:
// the Cocoa backend always has it, and on X11 `glPolicy: 'auto'` (set below) asks for it.
import { writeFileSync } from 'node:fs';
import { useRef } from 'react';
import { PNG } from 'pngjs';
import { createRoot } from 'react-x11';

import { Map3D } from '../src/map3d/index.js';
import type { Map3DHandle } from '../src/map3d/index.js';

const key = process.env.GOOGLE_MAPS_API_KEY;
if (!key) {
  console.error('set GOOGLE_MAPS_API_KEY (a Map Tiles API key)');
  process.exit(1);
}
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const lat = Number(args[0] ?? -37.8136);
const lon = Number(args[1] ?? 144.9631);
const shot = process.env.MAP3D_STATS === '1';

function App() {
  const handle = useRef<Map3DHandle | null>(null);
  if (shot) {
    setInterval(
      () => console.log(JSON.stringify(handle.current?.stats())),
      1000,
    ).unref();
  }
  return (
    <window title="Map3D" width={1100} height={750}>
      <Map3D
        handleRef={handle}
        query={{ key: key! }}
        defaultCamera={{
          lat,
          lon,
          heading: 20,
          pitch: Number(process.env.MAP3D_PITCH ?? 55),
          range: 700,
        }}
        onFrame={(gl: any, { width, height }, st) => {
          // MAP3D_SHOT=file.png writes the first complete frame and exits
          const out = process.env.MAP3D_SHOT;
          if (
            !out ||
            !(st.complete || st.loaded > Number(process.env.MAP3D_MIN ?? 1e9))
          )
            return;
          const px = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const png = new PNG({ width, height });
          for (let y = 0; y < height; y++)
            png.data.set(
              px.subarray(
                (height - 1 - y) * width * 4,
                (height - y) * width * 4,
              ),
              y * width * 4,
            );
          writeFileSync(out, PNG.sync.write(png));
          process.exit(0);
        }}
        onError={(m) => console.error(m.replace(key!, '<key>'))}
        style={{ flexGrow: 1 }}
      />
    </window>
  );
}

const root = await createRoot({ glPolicy: 'auto' });
root.render(<App />);
