// A binary glTF, read as `<Map3D>` needs it: triangles with a texture, in Earth-centred metres.
//
// Google's Map Tiles API answers glTF that has already been through Draco's decoder (its `asset.generator` says
// `draco_decoder`): float accessors, 16- or 32-bit indices, a JPEG in a buffer view, `KHR_materials_unlit`. So
// this reads exactly that and nothing more — no scene-graph library, no mesh decoder. A file that does ask for
// `KHR_draco_mesh_compression` or `EXT_meshopt_compression` is refused with a message that says so, rather
// than read wrongly.
import type { V3 } from './geo.js';

// `src/` is built with no DOM or Node types.
declare const TextDecoder: new () => { decode(b: Uint8Array): string };

export interface GlbPrimitive {
  /** x, y, z in Earth-centred metres, relative to `origin` (kept apart so a float32 holds them) */
  position: Float64Array;
  uv: Float32Array;
  index: Uint32Array;
  /** the encoded image (JPEG or PNG), or null for an untextured primitive */
  image: Uint8Array | null;
}

interface Json {
  asset?: { copyright?: string };
  extensionsRequired?: string[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
  }[];
  bufferViews?: {
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }[];
  images?: { bufferView?: number }[];
  textures?: { source?: number }[];
  materials?: {
    pbrMetallicRoughness?: { baseColorTexture?: { index: number } };
  }[];
  meshes?: {
    primitives: {
      attributes: Record<string, number>;
      indices?: number;
      material?: number;
      mode?: number;
    }[];
  }[];
  nodes?: {
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
}

const COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
};
const BYTES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** column-major a * b */
export function mul4(a: readonly number[], b: readonly number[]): number[] {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++)
        o[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
}

function trs(
  t: number[] = [0, 0, 0],
  q: number[] = [0, 0, 0, 1],
  s: number[] = [1, 1, 1],
): number[] {
  const [x, y, z, w] = q as [number, number, number, number];
  return [
    (1 - 2 * (y * y + z * z)) * s[0]!,
    2 * (x * y + z * w) * s[0]!,
    2 * (x * z - y * w) * s[0]!,
    0,
    2 * (x * y - z * w) * s[1]!,
    (1 - 2 * (x * x + z * z)) * s[1]!,
    2 * (y * z + x * w) * s[1]!,
    0,
    2 * (x * z + y * w) * s[2]!,
    2 * (y * z - x * w) * s[2]!,
    (1 - 2 * (x * x + y * y)) * s[2]!,
    0,
    t[0]!,
    t[1]!,
    t[2]!,
    1,
  ];
}

/**
 * Reads a .glb. `rootMatrix` is applied after each node's own matrix (the tile's transform, if its node in the
 * tileset has one), and `place` takes a point in the tileset's z-up Earth-centred space into whatever the caller
 * draws in. Vertices are handed to `place` one at a time in float64.
 */
export function readGlb(
  bytes: Uint8Array,
  rootMatrix: readonly number[] | null,
  place: (p: V3) => V3,
): { primitives: GlbPrimitive[]; copyright: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67)
    throw new Error('not a glb');
  let json: Json | null = null;
  let bin: Uint8Array | null = null;
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const len = view.getUint32(at, true),
      type = view.getUint32(at + 4, true);
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (type === 0x4e4f534a)
      json = JSON.parse(new TextDecoder().decode(body)) as Json;
    else if (type === 0x004e4942) bin = body;
    at += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json || !bin) throw new Error('glb without JSON or binary chunk');
  const refused = (json.extensionsRequired ?? []).filter(
    (e) =>
      e === 'KHR_draco_mesh_compression' || e === 'EXT_meshopt_compression',
  );
  if (refused.length)
    throw new Error(
      `glb needs ${refused.join(', ')}, which this does not decode`,
    );
  const doc = json,
    data = bin;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const read = (
    index: number,
    want: 'f32' | 'idx',
  ): Float32Array | Uint32Array => {
    const acc = doc.accessors![index]!;
    const bv = doc.bufferViews![acc.bufferView!]!;
    const n = COMPONENTS[acc.type]!;
    const size = BYTES[acc.componentType]!;
    const stride = bv.byteStride || n * size;
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const out =
      want === 'f32'
        ? new Float32Array(acc.count * n)
        : new Uint32Array(acc.count * n);
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < n; c++) {
        const o = base + i * stride + c * size;
        let v: number;
        switch (acc.componentType) {
          case 5126:
            v = dv.getFloat32(o, true);
            break;
          case 5123:
            v = dv.getUint16(o, true);
            break;
          case 5125:
            v = dv.getUint32(o, true);
            break;
          case 5121:
            v = dv.getUint8(o);
            break;
          case 5122:
            v = dv.getInt16(o, true);
            break;
          case 5120:
            v = dv.getInt8(o);
            break;
          default:
            throw new Error(`accessor component type ${acc.componentType}`);
        }
        if (acc.normalized) {
          v =
            acc.componentType === 5123
              ? v / 65535
              : acc.componentType === 5121
                ? v / 255
                : v;
        }
        out[i * n + c] = v;
      }
    }
    return out;
  };

  const out: GlbPrimitive[] = [];
  const visit = (index: number, parent: readonly number[]): void => {
    const node = doc.nodes![index]!;
    const own = node.matrix ?? trs(node.translation, node.rotation, node.scale);
    const m = mul4(parent, own);
    if (node.mesh !== undefined) {
      for (const prim of doc.meshes![node.mesh]!.primitives) {
        if ((prim.mode ?? 4) !== 4 || prim.indices === undefined) continue;
        const pa = prim.attributes.POSITION;
        if (pa === undefined) continue;
        const src = read(pa, 'f32') as Float32Array;
        const n = src.length / 3;
        const position = new Float64Array(n * 3);
        for (let v = 0; v < n; v++) {
          const px = src[v * 3]!,
            py = src[v * 3 + 1]!,
            pz = src[v * 3 + 2]!;
          const x = m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!;
          const y = m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!;
          const z = m[2]! * px + m[6]! * py + m[10]! * pz + m[14]!;
          // glTF is y-up and the tileset z-up: (x, y, z) is the tileset's (x, -z, y)
          const s = place([x, -z, y]);
          position[v * 3] = s[0];
          position[v * 3 + 1] = s[1];
          position[v * 3 + 2] = s[2];
        }
        const ua = prim.attributes.TEXCOORD_0;
        const uv =
          ua === undefined
            ? new Float32Array(n * 2)
            : (read(ua, 'f32') as Float32Array);
        const tex =
          doc.materials?.[prim.material ?? -1]?.pbrMetallicRoughness
            ?.baseColorTexture?.index;
        const source =
          tex === undefined ? undefined : doc.textures?.[tex]?.source;
        const view2 =
          source === undefined
            ? undefined
            : doc.bufferViews?.[doc.images?.[source]?.bufferView ?? -1];
        const image = view2
          ? data.subarray(
              view2.byteOffset ?? 0,
              (view2.byteOffset ?? 0) + view2.byteLength,
            )
          : null;
        out.push({
          position,
          uv,
          index: read(prim.indices, 'idx') as Uint32Array,
          image,
        });
      }
    }
    for (const c of node.children ?? []) visit(c, m);
  };
  const scene = doc.scenes?.[doc.scene ?? 0];
  for (const n of scene?.nodes ?? []) visit(n, rootMatrix ?? IDENTITY);
  return { primitives: out, copyright: doc.asset?.copyright ?? '' };
}
