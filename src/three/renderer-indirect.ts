// The scene drawn through indirect GLX — GL 1.x commands encoded into the X
// connection. A port of react-x11's `src/scene3d.js` renderer, reading the
// mutable object graph instead of retained-node props.
//
// The rule that shapes everything here is a protocol one: GLX encodes no
// vertex arrays, so geometry can only travel as immediate-mode commands.
// Sending a mesh per frame costs kilobytes per frame, so every geometry is
// compiled into a **server-side display list** once and replayed with a
// single CallList. A frame is then matrices + material state + one CallList
// per mesh, whatever the triangle count — the property the tests assert on
// the encoded command stream.
//
// The GL object is ntk's indirect context: PascalCase OpenGL 1.x, untyped
// because it is a JS façade over the protocol encoder.
/* The one file-wide `any`: the GL façade. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GL = any;

import type { Mat4 } from './math.js';
import { identity, multiply, compose } from './math.js';
import type { BufferGeometry } from './geometries.js';
import type {
  InstanceSpec,
  Light,
  Mesh,
  Object3D,
  Primitive,
  Scene,
  SpotLight,
  PointLight,
  Camera,
} from './objects.js';
import { InstancedMesh } from './objects.js';
import type { Material, TextureImage } from './materials.js';
import { UNLIT_MATERIALS, materialColors } from './materials.js';
import { Color } from './math.js';
import { warn } from './globals.js';

// Fixed-function GL has exactly eight light units. The shader backend has no
// such limit, but keeps the same cap so a scene lights identically on both.
export const MAX_LIGHTS = 8;

export interface FrameCamera {
  projection: Mat4;
  view: Mat4;
  width: number;
  height: number;
}

/** The GL primitive a drawable's vertices are assembled into. */
function BEGIN_MODE(gl: GL, primitive: Primitive): number {
  switch (primitive) {
    case 'points':
      return gl.POINTS;
    case 'lines':
      return gl.LINES;
    case 'lineStrip':
      return gl.LINE_STRIP;
    case 'lineLoop':
      return gl.LINE_LOOP;
    default:
      return gl.TRIANGLES;
  }
}

const asTriple = (
  value: readonly number[] | number | undefined,
  fallback: [number, number, number],
): [number, number, number] => {
  if (value == null) return fallback;
  if (typeof value === 'number') return [value, value, value];
  return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
};

/** One `<instancedMesh>` entry's transform, in the parent's space. */
export function instanceMatrix(
  instance: InstanceSpec,
  out = new Float32Array(16),
): Mat4 {
  return compose(
    asTriple(instance.position, [0, 0, 0]),
    asTriple(instance.rotation, [0, 0, 0]),
    asTriple(instance.scale, [1, 1, 1]),
    out,
  );
}

export interface CollectedLight {
  node: Light;
  world: Mat4;
}

/** Lights with their world matrices, in tree order. */
export function collectLights(
  nodes: Object3D[],
  parentMatrix: Mat4,
  out: CollectedLight[] = [],
): CollectedLight[] {
  for (const node of nodes) {
    if (!node.isObject3D || !node.visible) continue;
    const world = multiply(parentMatrix, node.localMatrix());
    if ((node as Light).isLight) out.push({ node: node as Light, world });
    collectLights(node.children, world, out);
  }
  return out;
}

const scaled = (
  [r, g, b]: [number, number, number] | readonly number[],
  intensity: number,
): [number, number, number, number] => [
  r * intensity,
  g * intensity,
  b * intensity,
  1,
];

const instanceColor = (
  value: InstanceSpec['color'],
): [number, number, number] => {
  const c = new Color(value as never);
  return [c.r, c.g, c.b];
};

interface ListEntry {
  id: number;
  version: number;
}

/**
 * Per-surface GL bookkeeping: the display list of every geometry, and the
 * material state last sent (so an unchanged material costs nothing).
 */
export class IndirectRenderer {
  readonly backend = 'indirect';

  private lists = new Map<BufferGeometry, Map<Primitive, ListEntry>>();
  private nextList = 1;
  private textures = new Map<TextureImage, number>();
  private nextTexture = 1;
  private materialKey: string | null = null;
  private initialized = false;
  private enabledLights = 0;
  private lit = false;
  private warnedLightLimit = false;
  private warnedDirectOnly = false;

  /** The matrices of the frame on screen — what picking rays are cast with. */
  camera: FrameCamera | null = null;

  /** Draw `scene`; false when there is nothing 3D to draw. */
  render(
    gl: GL,
    scene: Scene,
    camera: Camera,
    size: { width: number; height: number },
  ): boolean {
    const roots = scene.children.filter((c) => c.isObject3D);
    if (roots.length === 0) return false;

    if (!this.initialized) {
      this.initialized = true;
      gl.Enable(gl.DEPTH_TEST);
      gl.Enable(gl.NORMALIZE); // scaled meshes keep unit-length normals
      gl.ShadeModel(gl.SMOOTH);
    }
    this.materialKey = null;

    const projection = camera.projectionMatrix(size.width, size.height);
    const view = camera.viewMatrix();
    this.camera = { projection, view, width: size.width, height: size.height };
    gl.MatrixMode(gl.PROJECTION);
    gl.LoadIdentity();
    gl.MultMatrixf(projection);
    gl.MatrixMode(gl.MODELVIEW);
    gl.LoadIdentity();
    gl.MultMatrixf(view);

    // light positions are transformed by the modelview matrix in force when
    // they are sent, and it is the view matrix right now — so world-space
    // positions land in eye space exactly as GL expects
    this.applyLights(gl, collectLights(roots, identity()));

    for (const node of roots) this.drawObject(gl, node, identity());
    return true;
  }

  private drawObject(gl: GL, node: Object3D, parentWorld: Mat4): void {
    if (!node.visible) return;
    // the world matrix is recorded rather than recomputed later: picking
    // rays are transformed by exactly what was drawn
    const world = multiply(parentWorld, node.localMatrix());
    node.__world = world;
    gl.PushMatrix();
    gl.MultMatrixf(node.localMatrix());
    if ((node as Mesh).isMesh) this.drawMesh(gl, node as Mesh);
    for (const child of node.children) {
      if (child.isObject3D) this.drawObject(gl, child, world);
    }
    gl.PopMatrix();
  }

  private drawMesh(gl: GL, mesh: Mesh): void {
    const geometry = mesh.geometry;
    if (!geometry) return;
    const applied = this.applyMaterial(gl, mesh.material);
    const list = this.listFor(gl, geometry, mesh.primitive);
    if (!(mesh instanceof InstancedMesh)) {
      gl.CallList(list);
      return;
    }

    // One list, replayed under each instance's transform. The geometry is
    // compiled once however many instances there are, which is the whole
    // saving; the per-instance cost is a matrix and a CallList.
    //
    // Colour is GL state, and PopMatrix restores the matrix and nothing
    // else — so once any instance has set one, every instance has to say
    // what it wants or it inherits its predecessor's.
    const colored = mesh.instances.some((instance) => instance.color);
    for (const instance of mesh.instances) {
      gl.PushMatrix();
      gl.MultMatrixf(instanceMatrix(instance));
      if (colored) {
        const [r, g, b] = instance.color
          ? instanceColor(instance.color)
          : applied.color;
        gl.Color3f(r, g, b);
      }
      gl.CallList(list);
      gl.PopMatrix();
    }
    // the material's own colour is no longer what is current
    if (colored) this.materialKey = null;
  }

  /**
   * Upload once, bind per frame. Texture pixels are the same problem as
   * geometry — kilobytes that must not cross the wire twice — so an image is
   * uploaded on first use and only rebound afterwards. `map` is an ntk
   * `Image`, or anything with `{ width, height, data }` in RGBA byte order.
   */
  private textureFor(gl: GL, image: TextureImage): number {
    const cached = this.textures.get(image);
    if (cached) return cached;
    const id = this.nextTexture++;
    gl.BindTexture(gl.TEXTURE_2D, id);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.TexImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      image.width,
      image.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      image.data,
    );
    this.textures.set(image, id);
    return id;
  }

  /** Compile once, replay forever — this is the whole point of the design. */
  private listFor(
    gl: GL,
    geometry: BufferGeometry,
    primitive: Primitive,
  ): number {
    // Keyed by primitive as well as by geometry: the same vertices compiled
    // as triangles and as points are two different lists, and a scene can
    // legitimately use one geometry both ways.
    let perPrimitive = this.lists.get(geometry);
    if (!perPrimitive) this.lists.set(geometry, (perPrimitive = new Map()));
    const cached = perPrimitive.get(primitive);
    if (cached && cached.version === geometry.version) return cached.id;
    const id = cached ? cached.id : this.nextList++;

    const shaded = primitive === 'triangles';
    const { positions, normals, uvs, index } = geometry.data({
      normals: shaded,
    });
    // Points ignore any index — every vertex is one dot, and running the
    // triangle index over them would draw the shared ones repeatedly.
    const useIndex = primitive === 'points' ? null : index;
    const count = useIndex ? useIndex.length : positions.length / 3;

    gl.NewList(id, gl.COMPILE);
    gl.Begin(BEGIN_MODE(gl, primitive));
    for (let i = 0; i < count; i++) {
      const v = useIndex ? useIndex[i] : i;
      if (shaded && normals.length > v * 3 + 2) {
        gl.Normal3f(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
      }
      if (shaded && uvs.length > v * 2 + 1) {
        gl.TexCoord2f(uvs[v * 2], uvs[v * 2 + 1]);
      }
      gl.Vertex3f(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    }
    gl.End();
    gl.EndList();

    perPrimitive.set(primitive, { id, version: geometry.version });
    return id;
  }

  /**
   * Fixed-function GL has eight light units. `<ambientLight>` has no unit of
   * its own — its colour is summed into the first light's GL_AMBIENT term
   * (and into a dummy unit when it is the only light in the scene).
   */
  private applyLights(gl: GL, lights: CollectedLight[]): void {
    let ambient: [number, number, number] = [0, 0, 0];
    const units: {
      node: Light;
      intensity: number;
      color: [number, number, number];
      world: Mat4;
    }[] = [];
    for (const light of lights) {
      const { node } = light;
      const intensity = node.intensity;
      const { r, g, b } = node.color;
      if ((node as { isAmbientLight?: boolean }).isAmbientLight) {
        ambient = [
          ambient[0] + r * intensity,
          ambient[1] + g * intensity,
          ambient[2] + b * intensity,
        ];
        continue;
      }
      units.push({ node, intensity, color: [r, g, b], world: light.world });
    }

    if (units.length > MAX_LIGHTS && !this.warnedLightLimit) {
      this.warnedLightLimit = true;
      warn(
        `@react-x11/components: ${units.length} lights in the scene; ` +
          `fixed-function GL has ${MAX_LIGHTS} light units, so the rest ` +
          'are ignored.',
      );
    }
    const used = units.slice(0, MAX_LIGHTS);
    this.lit = used.length > 0 || ambient.some((c) => c > 0);

    if (!this.lit) {
      for (let i = 0; i < this.enabledLights; i++) gl.Disable(gl.LIGHT0 + i);
      this.enabledLights = 0;
      return;
    }

    // ambient-only scenes still need one unit, to carry the ambient term
    const count = Math.max(used.length, 1);
    for (let i = 0; i < count; i++) {
      const unit = gl.LIGHT0 + i;
      gl.Enable(unit);
      gl.Lightfv(unit, gl.AMBIENT, i === 0 ? [...ambient, 1] : [0, 0, 0, 1]);
      const light = used[i];
      if (!light) {
        // the dummy unit for a scene lit only by <ambientLight>
        gl.Lightfv(unit, gl.DIFFUSE, [0, 0, 0, 1]);
        gl.Lightfv(unit, gl.SPECULAR, [0, 0, 0, 1]);
        gl.Lightfv(unit, gl.POSITION, [0, 0, 1, 0]);
        continue;
      }
      const { node, intensity, color, world } = light;
      const position = [world[12], world[13], world[14]];
      gl.Lightfv(unit, gl.DIFFUSE, scaled(color, intensity));
      gl.Lightfv(unit, gl.SPECULAR, scaled(color, intensity));

      if ((node as { isDirectionalLight?: boolean }).isDirectionalLight) {
        // w = 0: a direction, pointing from the scene toward the light
        gl.Lightfv(unit, gl.POSITION, [...position, 0]);
        gl.Lightfv(unit, gl.SPOT_DIRECTION, [0, 0, -1, 0]);
        gl.Lightfv(unit, gl.SPOT_CUTOFF, 180, 0, 0, 0);
      } else {
        gl.Lightfv(unit, gl.POSITION, [...position, 1]);
        const point = node as PointLight;
        const distance = point.distance ?? 0;
        // three.js decay=2 is physical falloff; map it onto GL attenuation
        const decay = point.decay ?? 0;
        gl.Lightfv(unit, gl.CONSTANT_ATTENUATION, 1, 0, 0, 0);
        gl.Lightfv(
          unit,
          gl.LINEAR_ATTENUATION,
          distance > 0 ? 1 / distance : 0,
          0,
          0,
          0,
        );
        gl.Lightfv(
          unit,
          gl.QUADRATIC_ATTENUATION,
          decay > 1 && distance > 0 ? 1 / (distance * distance) : 0,
          0,
          0,
          0,
        );
        if ((node as { isSpotLight?: boolean }).isSpotLight) {
          const spot = node as SpotLight;
          const target = spot.target;
          const dir = [
            target.x - position[0],
            target.y - position[1],
            target.z - position[2],
          ];
          const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
          gl.Lightfv(
            unit,
            gl.SPOT_DIRECTION,
            dir[0] / len,
            dir[1] / len,
            dir[2] / len,
            0,
          );
          gl.Lightfv(
            unit,
            gl.SPOT_CUTOFF,
            Math.min(90, (spot.angle * 180) / Math.PI),
            0,
            0,
            0,
          );
          gl.Lightfv(unit, gl.SPOT_EXPONENT, spot.penumbra * 128, 0, 0, 0);
        } else {
          gl.Lightfv(unit, gl.SPOT_CUTOFF, 180, 0, 0, 0);
        }
      }
    }
    for (let i = count; i < this.enabledLights; i++) gl.Disable(gl.LIGHT0 + i);
    this.enabledLights = count;
    // the material state depends on whether lighting is on
    this.materialKey = null;
  }

  /** Material state is per frame, so one geometry list can serve many
   * meshes. Returns the colour, so `<instancedMesh>` can restore it. */
  private applyMaterial(
    gl: GL,
    material: Material | null,
  ): { color: [number, number, number] } {
    let kind = material?.kind ?? 'meshBasicMaterial';
    // A mesh that reached this renderer with a shader material can only
    // happen if the backend changed under a mounted tree; draw it flat
    // rather than as whatever an unknown kind falls through to.
    if (kind === 'shaderMaterial' || kind === 'rawShaderMaterial') {
      if (!this.warnedDirectOnly) {
        this.warnedDirectOnly = true;
        warn(
          `@react-x11/components: <${kind}> needs direct rendering; ` +
            'drawing it as an unlit material instead.',
        );
      }
      kind = 'meshBasicMaterial';
    }
    const colors = materialColors(material);
    const [r, g, b] = colors.color;
    const alpha = colors.alpha;
    // <meshBasicMaterial> is unlit by definition — and so are the point and
    // line materials, which have no surface to shade. A lit material with no
    // light in the scene would render black, so that falls back to flat too.
    const lit = !UNLIT_MATERIALS.has(kind) && this.lit;
    // texturing is state like everything else here, so it is part of the key
    const map = material?.map ?? null;
    const wireframe = material?.wireframe ?? false;
    const side = material?.side ?? 'front';
    const transparent = material?.transparent ?? false;
    const size = (material as { size?: number } | null)?.size ?? 1;
    const linewidth =
      (material as { linewidth?: number } | null)?.linewidth ?? 1;
    const key = [
      kind,
      lit,
      r,
      g,
      b,
      alpha,
      wireframe,
      side,
      transparent,
      colors.shininess,
      colors.specular.join(','),
      colors.emissive.join(','),
      colors.diffuseScale,
      size,
      linewidth,
      map ? (this.textures.get(map) ?? 'new') : 'none',
    ].join('|');
    if (key === this.materialKey) return { color: [r, g, b] };
    this.materialKey = key;

    const blended = alpha < 1 || transparent;
    if (blended) {
      gl.Enable(gl.BLEND);
      gl.BlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.Disable(gl.BLEND);
    }

    if (lit) {
      gl.Enable(gl.LIGHTING);
      const scale = colors.diffuseScale;
      // colour reaches the shading equation as the surface reflectance
      gl.Materialfv(gl.FRONT_AND_BACK, gl.AMBIENT_AND_DIFFUSE, [
        r * scale,
        g * scale,
        b * scale,
        alpha,
      ]);
      gl.Materialfv(gl.FRONT_AND_BACK, gl.EMISSION, [...colors.emissive, 1]);
      if (kind === 'meshPhongMaterial' || kind === 'meshStandardMaterial') {
        gl.Materialfv(gl.FRONT_AND_BACK, gl.SPECULAR, [...colors.specular, 1]);
        gl.Materialf(gl.FRONT_AND_BACK, gl.SHININESS, colors.shininess);
      } else {
        // Lambert: diffuse only
        gl.Materialfv(gl.FRONT_AND_BACK, gl.SPECULAR, [0, 0, 0, 1]);
        gl.Materialf(gl.FRONT_AND_BACK, gl.SHININESS, 0);
      }
      // both faces are shaded when both are drawn
      gl.LightModelf(gl.LIGHT_MODEL_TWO_SIDE, side === 'double' ? 1 : 0);
    } else {
      gl.Disable(gl.LIGHTING);
      if (blended) gl.Color4f(r, g, b, alpha);
      else gl.Color3f(r, g, b);
    }

    if (map?.width && map?.data) {
      gl.Enable(gl.TEXTURE_2D);
      gl.BindTexture(gl.TEXTURE_2D, this.textureFor(gl, map));
      // MODULATE: the texture is tinted by the colour and the lighting
      gl.TexEnvi(gl.TEXTURE_ENV, gl.TEXTURE_ENV_MODE, gl.MODULATE);
    } else {
      gl.Disable(gl.TEXTURE_2D);
    }

    // three.js's names: `size` on a points material, `linewidth` on a line
    // one. Both are fixed-function state the GLX protocol does encode.
    if (kind === 'pointsMaterial') gl.PointSize(size);
    if (kind === 'lineBasicMaterial') gl.LineWidth(linewidth);

    gl.PolygonMode(gl.FRONT_AND_BACK, wireframe ? gl.LINE : gl.FILL);
    if (side === 'double') {
      gl.Disable(gl.CULL_FACE);
    } else {
      gl.Enable(gl.CULL_FACE);
      gl.CullFace(side === 'back' ? gl.FRONT : gl.BACK);
    }
    return { color: [r, g, b] };
  }

  /** Drop a removed geometry's lists so the ids can be reused. */
  forget(gl: GL, geometry: BufferGeometry): void {
    const perPrimitive = this.lists.get(geometry);
    if (!perPrimitive) return;
    this.lists.delete(geometry);
    for (const { id } of perPrimitive.values()) gl?.DeleteLists?.(id, 1);
  }

  dispose(gl: GL): void {
    for (const perPrimitive of this.lists.values()) {
      for (const { id } of perPrimitive.values()) gl?.DeleteLists?.(id, 1);
    }
    this.lists.clear();
    if (this.textures.size) gl?.DeleteTextures?.([...this.textures.values()]);
    this.textures.clear();
  }
}
