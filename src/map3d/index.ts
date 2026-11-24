// <Map3D> — Google's Photorealistic 3D Tiles (or any OGC 3D Tiles 1.0 tileset of textured glTF) in a `<glarea>`,
// seen through an orbit camera.
//
// `<Map>` is a 2D map: its camera is a centre and a zoom, and everything under it — the tile pyramid, the
// label placement, the hit test — is a plane. A tilted camera over a mesh is a different renderer, not a mode
// of that one, so this is the sibling: it shares `<Map>`'s idea of a place (longitude, latitude) and nothing
// of its pipeline. See docs/components/map3d.md.
//
// What is here: the tileset walker (`tileset.ts`, pure), the glTF reader (`glb.ts`, pure), the frame and the
// camera (`geo.ts`, pure) and this file, which owns the GL context: one program, one buffer pair and one texture
// per tile, uploaded in the frame that first draws it and let go of when the cache lets the tile go.
import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ReactElement } from 'react';
import type { ReactX11Elements } from 'react-x11';
import * as ntk from 'react-x11/ntk';

import { eyeOf, frameAt, viewProjection, add, scale, geodetic } from './geo.js';
import type { Frame, Orbit, V3 } from './geo.js';
import { readGlb } from './glb.js';
import { Tileset } from './tileset.js';
import type { TilesetOptions } from './tileset.js';

export { ecef, geodetic, frameAt, viewProjection, eyeOf } from './geo.js';
export { readGlb } from './glb.js';
export { Tileset } from './tileset.js';
export type { Orbit, V3, Frame } from './geo.js';
export type {
  TileNode,
  TilesetOptions,
  Selection,
  SelectOptions,
} from './tileset.js';

/** Google's tileset. It needs a Map Tiles API key, and the terms ask for the attribution this draws. */
export const GOOGLE_3D_TILES =
  'https://tile.googleapis.com/v1/3dtiles/root.json';

export interface Camera3D {
  lon: number;
  lat: number;
  /** metres above the ellipsoid; unset follows the ground under the target */
  height?: number;
  /** degrees clockwise from north */
  heading: number;
  /** degrees down from the horizon: 90 looks straight down */
  pitch: number;
  /** metres from the target to the eye */
  range: number;
}

export interface Map3DStats {
  drawn: number;
  loaded: number;
  pending: number;
  visited: number;
  complete: boolean;
  frameMs: number;
}

export interface Map3DProps {
  /** The tileset's root, `GOOGLE_3D_TILES` by default. */
  url?: string;
  /** Appended to every request: `{ key }` for Google. */
  query?: Record<string, string>;
  /** Where the camera starts. Read once; the element owns it from then on. */
  defaultCamera: Camera3D;
  onCameraChange?: (camera: Camera3D) => void;
  /** A tile is refined while its error would span more than this many pixels. 16 by default. */
  maxError?: number;
  /** The colour behind the world. */
  sky?: string;
  /** Replaces `fetch`, for a tileset behind your own policy. */
  fetch?: TilesetOptions['fetch'];
  onError?: (message: string) => void;
  onStats?: (stats: Map3DStats) => void;
  /** Called at the end of each frame with the GL context, for read-back (screenshots) or extra drawing. */
  onFrame?: (
    gl: unknown,
    size: { width: number; height: number },
    stats: Map3DStats,
  ) => void;
  style?: ReactX11Elements['box']['style'];
}

declare const performance: { now(): number };
type GL = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const VERTEX = `precision highp float;
attribute vec3 a_pos;
attribute vec2 a_uv;
uniform mat4 u_vp;
varying vec2 v_uv;
void main() { v_uv = a_uv; gl_Position = u_vp * vec4(a_pos, 1.0); }`;
const FRAGMENT = `precision mediump float;
uniform sampler2D u_tex;
varying vec2 v_uv;
void main() { gl_FragColor = vec4(texture2D(u_tex, v_uv).rgb, 1.0); }`;

interface Chunk {
  vertices: Float32Array; // x y z u v, interleaved
  index: Uint16Array;
  image: { width: number; height: number; data: Uint8Array } | null;
  gpu?: { vbo: unknown; ibo: unknown; tex: unknown | null; count: number };
}
interface Tile {
  chunks: Chunk[];
  copyright: string;
  /** lowest vertex near the frame's origin, the ground there, or null */
  ground: number | null;
}

/** Splits a primitive at 65,535 vertices: 16-bit indices are the portable ones. */
function chunksOf(
  pos: Float32Array,
  uv: Float32Array,
  index: Uint32Array,
  image: Chunk['image'],
): Chunk[] {
  const out: Chunk[] = [];
  const n = pos.length / 3;
  if (n <= 65535) {
    const v = new Float32Array(n * 5);
    for (let i = 0; i < n; i++) {
      v[i * 5] = pos[i * 3]!;
      v[i * 5 + 1] = pos[i * 3 + 1]!;
      v[i * 5 + 2] = pos[i * 3 + 2]!;
      v[i * 5 + 3] = uv[i * 2]!;
      v[i * 5 + 4] = uv[i * 2 + 1]!;
    }
    return [{ vertices: v, index: Uint16Array.from(index), image }];
  }
  let map = new Map<number, number>();
  let V: number[] = [],
    I: number[] = [];
  const flush = () => {
    if (I.length)
      out.push({
        vertices: Float32Array.from(V),
        index: Uint16Array.from(I),
        image,
      });
    map = new Map();
    V = [];
    I = [];
  };
  for (let t = 0; t + 2 < index.length; t += 3) {
    if (map.size + 3 > 65535) flush();
    for (let k = 0; k < 3; k++) {
      const v = index[t + k]!;
      let m = map.get(v);
      if (m === undefined) {
        m = map.size;
        map.set(v, m);
        V.push(
          pos[v * 3]!,
          pos[v * 3 + 1]!,
          pos[v * 3 + 2]!,
          uv[v * 2]!,
          uv[v * 2 + 1]!,
        );
      }
      I.push(m);
    }
  }
  flush();
  return out;
}

class Driver {
  props: Map3DProps;
  readonly orbit: Orbit;
  frame: Frame;
  private _tileset: Tileset<Tile>;
  private _area: { requestFrame?(): void } | null = null;
  private _program: { program: unknown; u_vp: unknown; u_tex: unknown } | null =
    null;
  private _gl: GL = null;
  private _groundHeight: number | null = null;
  private _lastStats: Map3DStats | null = null;
  attribution = '';
  onAttribution: ((text: string) => void) | null = null;
  private _drag: { x: number; y: number; pan: boolean } | null = null;
  height: number;
  disposed = false;

  constructor(props: Map3DProps) {
    this.props = props;
    const c = props.defaultCamera;
    this.height = c.height ?? 0;
    this.frame = frameAt(c.lat, c.lon, 0);
    this.orbit = {
      heading: c.heading,
      pitch: c.pitch,
      range: c.range,
      fov: 40,
      target: [0, c.height ?? 0, 0],
    };
    this._tileset = new Tileset<Tile>({
      url: props.url ?? GOOGLE_3D_TILES,
      query: props.query,
      fetch: props.fetch,
      onChange: () => this.request(),
      onError: (m) => props.onError?.(m),
    });
    this._tileset.decode = (_uri, bytes) => this._decode(bytes);
    this._tileset.onEvict = (_u, tile) => this._release(tile);
  }

  attach(area: { requestFrame?(): void } | null): void {
    this._area = area;
  }
  request = (): void => {
    if (!this.disposed) this._area?.requestFrame?.();
  };

  private async _decode(bytes: Uint8Array): Promise<Tile> {
    const f = this.frame;
    const { primitives, copyright } = readGlb(bytes, null, (p) => f.toScene(p));
    const chunks: Chunk[] = [];
    let ground: number | null = null;
    for (const p of primitives) {
      let image: Chunk['image'] = null;
      if (p.image) {
        const img = (await ntk.decodeImageBytes(p.image)) as {
          width: number;
          height: number;
          data: Uint8Array;
        };
        image = { width: img.width, height: img.height, data: img.data };
      }
      const pos = Float32Array.from(p.position);
      for (let v = 0; v < pos.length; v += 3) {
        if (Math.hypot(pos[v]!, pos[v + 2]!) < 4)
          ground =
            ground === null ? pos[v + 1]! : Math.min(ground, pos[v + 1]!);
      }
      chunks.push(...chunksOf(pos, p.uv, p.index, image));
    }
    return { chunks, copyright, ground };
  }

  private _release(tile: Tile): void {
    const gl = this._gl;
    for (const c of tile.chunks) {
      if (c.gpu && gl) {
        gl.deleteBuffer(c.gpu.vbo);
        gl.deleteBuffer(c.gpu.ibo);
        if (c.gpu.tex) gl.deleteTexture(c.gpu.tex);
      }
      c.gpu = undefined;
    }
  }

  private _build(gl: GL): void {
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(`map3d shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(program, 0, 'a_pos');
    gl.bindAttribLocation(program, 1, 'a_uv');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`map3d link: ${gl.getProgramInfoLog(program)}`);
    this._program = {
      program,
      u_vp: gl.getUniformLocation(program, 'u_vp'),
      u_tex: gl.getUniformLocation(program, 'u_tex'),
    };
    this._gl = gl;
  }

  private _upload(gl: GL, c: Chunk): NonNullable<Chunk['gpu']> {
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, c.vertices, gl.STATIC_DRAW);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, c.index, gl.STATIC_DRAW);
    let tex: unknown = null;
    if (c.image) {
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        c.image.width,
        c.image.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        c.image.data,
      );
      const pot = (n: number) => (n & (n - 1)) === 0;
      if (pot(c.image.width) && pot(c.image.height)) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          gl.LINEAR_MIPMAP_LINEAR,
        );
      } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    const gpu = { vbo, ibo, tex, count: c.index.length };
    c.gpu = gpu;
    // the CPU copies are done with: the buffers own the data now
    c.image = null;
    return gpu;
  }

  readonly draw = (gl: GL, info: { width: number; height: number }): void => {
    const t0 = performance.now();
    if (!this._program || this._gl !== gl) this._build(gl);
    const p = this._program!;
    const o = this.orbit;
    const { eye, forward, right, up } = eyeOf(o);
    const dir = (v: V3): V3 => {
      const f = this.frame;
      return [
        f.east[0] * v[0] + f.up[0] * v[1] - f.north[0] * v[2],
        f.east[1] * v[0] + f.up[1] * v[1] - f.north[1] * v[2],
        f.east[2] * v[0] + f.up[2] * v[1] - f.north[2] * v[2],
      ];
    };
    const aspect = info.width / Math.max(1, info.height);
    const sel = this._tileset.select({
      orbit: o,
      height: info.height,
      aspect,
      maxError: this.props.maxError,
      far: Math.max(5000, o.range * 40),
      eye: this.frame.toEcef(eye),
      axes: { forward: dir(forward), right: dir(right), up: dir(up) },
    });

    // the ground under the target: the lowest surface the drawn tiles have at the frame's origin
    if (this.props.defaultCamera.height === undefined) {
      let g: number | null = null;
      for (const uri of sel.draw) {
        const t = this._tileset.tile(uri);
        if (t?.ground != null)
          g = g === null ? t.ground : Math.min(g, t.ground);
      }
      if (g !== null && g !== this._groundHeight) {
        this._groundHeight = g;
        o.target = [o.target[0], g, o.target[2]];
        this.request();
      }
    }

    // near and far follow the eye's height: nothing nearer than a tenth of the range, nothing past the horizon
    const near = Math.max(1, o.range * 0.05);
    const far = Math.max(5000, o.range * 40);
    const vp = viewProjection(o, aspect, near, far);

    gl.viewport(0, 0, info.width, info.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.u_vp, false, vp);
    gl.uniform1i(p.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    const credits = new Set<string>();
    for (const uri of sel.draw) {
      const tile = this._tileset.tile(uri);
      if (!tile) continue;
      for (const part of tile.copyright.split(';'))
        if (part.trim()) credits.add(part.trim());
      for (const c of tile.chunks) {
        const gpu = c.gpu ?? this._upload(gl, c);
        gl.bindBuffer(gl.ARRAY_BUFFER, gpu.vbo);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.ibo);
        if (gpu.tex) gl.bindTexture(gl.TEXTURE_2D, gpu.tex);
        gl.drawElements(gl.TRIANGLES, gpu.count, gl.UNSIGNED_SHORT, 0);
      }
    }
    const text = ['Google', ...credits].join(' · ');
    if (text !== this.attribution) {
      this.attribution = text;
      this.onAttribution?.(text);
    }
    this._lastStats = {
      drawn: sel.draw.length,
      loaded: this._tileset.loaded,
      pending: this._tileset.pending,
      visited: sel.visited,
      complete: sel.complete,
      frameMs: performance.now() - t0,
    };
    this.props.onStats?.(this._lastStats);
    this.props.onFrame?.(gl, info, this._lastStats);
    // refinement arrives as tiles land and each landing asks for a frame; nothing to poll
  };

  stats(): Map3DStats | null {
    return this._lastStats;
  }

  // --- the camera ---------------------------------------------------------------------

  private _changed(): void {
    const g = geodetic(this.frame.toEcef(this.orbit.target));
    this.props.onCameraChange?.({
      lon: g.lon,
      lat: g.lat,
      height: g.h,
      heading: this.orbit.heading,
      pitch: this.orbit.pitch,
      range: this.orbit.range,
    });
    this.request();
  }

  readonly handlers = {
    onMouseDown: (ev: {
      x: number;
      y: number;
      button?: number;
      shiftKey?: boolean;
      capturePointer?(): void;
    }) => {
      this._drag = {
        x: ev.x,
        y: ev.y,
        pan: ev.button === 2 || ev.shiftKey === true,
      };
      ev.capturePointer?.();
    },
    onMouseMove: (ev: { x: number; y: number }) => {
      const d = this._drag;
      if (!d) return;
      const dx = ev.x - d.x,
        dy = ev.y - d.y;
      d.x = ev.x;
      d.y = ev.y;
      const o = this.orbit;
      if (d.pan) {
        // slide the target over the ground, as far as the pointer would on a plane at the target
        const k = (o.range * 2 * Math.tan((o.fov * Math.PI) / 360)) / 600;
        const h = (o.heading * Math.PI) / 180;
        const right: V3 = [Math.cos(h), 0, Math.sin(h)];
        const fwd: V3 = [Math.sin(h), 0, -Math.cos(h)];
        o.target = add(
          add(o.target, scale(right, -dx * k)),
          scale(fwd, dy * k),
        );
      } else {
        o.heading = (((o.heading + dx * 0.4) % 360) + 360) % 360;
        o.pitch = Math.max(5, Math.min(89, o.pitch + dy * 0.3));
      }
      this._changed();
    },
    onMouseUp: () => {
      this._drag = null;
    },
    onWheel: (ev: { deltaY?: number; preventDefault?(): void }) => {
      const o = this.orbit;
      o.range = Math.max(
        20,
        Math.min(2e6, o.range * Math.exp((ev.deltaY ?? 0) * 0.002)),
      );
      ev.preventDefault?.();
      this._changed();
    },
  };

  getCamera(): Camera3D {
    const g = geodetic(this.frame.toEcef(this.orbit.target));
    return {
      lon: g.lon,
      lat: g.lat,
      height: g.h,
      heading: this.orbit.heading,
      pitch: this.orbit.pitch,
      range: this.orbit.range,
    };
  }

  dispose(): void {
    this.disposed = true;
    this._tileset.dispose();
  }
}

/** Handle for tests and tools. */
export interface Map3DHandle {
  getCamera(): Camera3D;
  stats(): Map3DStats | null;
}

export function Map3D(
  props: Map3DProps & {
    handleRef?: React.MutableRefObject<Map3DHandle | null>;
  },
): ReactElement {
  const driver = useMemo(() => new Driver(props), []);
  driver.props = props;
  const area = useRef<{ requestFrame?(): void } | null>(null);
  const [credit, setCredit] = React.useState('');
  useLayoutEffect(() => {
    driver.attach(area.current);
    driver.onAttribution = setCredit;
    if (props.handleRef)
      props.handleRef.current = {
        getCamera: () => driver.getCamera(),
        stats: () => driver.stats(),
      };
    return () => driver.dispose();
  }, [driver]);
  useEffect(() => driver.request());
  const h = React.createElement as (...a: unknown[]) => ReactElement;
  return h(
    'box',
    {
      style: [{ flexGrow: 1 }, props.style],
      focusable: true,
      ...driver.handlers,
    },
    h(
      'glarea',
      {
        ref: (a: unknown) => {
          area.current = a as typeof area.current;
          driver.attach(area.current);
        },
        style: { flexGrow: 1 },
        clearColor: props.sky ?? '#9fc4e8',
        frameLoop: 'demand',
        onDraw: driver.draw,
        onError: (e: unknown) =>
          props.onError?.(e instanceof Error ? e.message : String(e)),
      },
      h(
        'text',
        {
          style: {
            position: 'absolute',
            left: 6,
            bottom: 4,
            fontSize: 11,
            color: '#ffffff',
          },
        },
        credit,
      ),
    ),
  );
}
