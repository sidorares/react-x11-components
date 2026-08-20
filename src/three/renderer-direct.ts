// The same scene, drawn through OpenGL ES 2 on the GPU — ntk's direct
// backend, where geometry is a vertex buffer, materials are generated GLSL
// and a frame is a handful of uniform writes and one draw call per mesh.
// A port of react-x11's `src/scene3d-shader.js`, reading the object graph.
//
// Two deliberate differences from the fixed-function path, both improvements
// the hardware makes free — and both identical to what three.js does with
// the same material names:
//
//  - **lighting is per fragment.** Fixed-function GL shades per vertex, so a
//    large triangle lit by a nearby point light bands visibly.
//  - **the shader is generated for the scene it draws.** A program is
//    compiled per (material kind, lit, textured, light count) so a scene
//    with two lights spends two lights' worth of uniforms — ES 2 guarantees
//    very few of those, and a fixed eight-light shader would not fit the
//    minimum.
/* The one file-wide `any`: the GL façade (camelCase ES 2). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GL = any;

import type { Mat4 } from './math.js';
import { identity, invert, multiply, normalMatrix } from './math.js';
import type { BufferGeometry } from './geometries.js';
import type {
  Camera,
  Light,
  Mesh,
  Object3D,
  PointLight,
  Primitive,
  Scene,
  SpotLight,
} from './objects.js';
import { InstancedMesh } from './objects.js';
import type { Material, TextureImage, UniformEntry } from './materials.js';
import {
  ShaderMaterial,
  RawShaderMaterial,
  UNLIT_MATERIALS,
  materialColors,
} from './materials.js';
import {
  collectLights,
  instanceMatrix,
  MAX_LIGHTS,
} from './renderer-indirect.js';
import type { FrameCamera } from './renderer-indirect.js';
import { Color } from './math.js';
import { warn } from './globals.js';

/**
 * The default float precision, injected into **both** stages.
 *
 * GLSL ES requires a uniform declared in the vertex and the fragment shader
 * to carry the same precision, and the default differs between them —
 * `highp` in a vertex shader, nothing at all in a fragment shader — so a
 * `uniform float uTime` used in both fails to *link* unless something says
 * otherwise. three.js injects a default for the same reason.
 */
const PRECISION = 'precision mediump float;\n';

// three.js's attribute and matrix names, so a shader written against r3f —
// or copied out of a tutorial — compiles here unchanged
const COMMON_VERTEX_UNIFORMS = `${PRECISION}
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 modelMatrix;
uniform mat3 normalMatrix;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
`;

interface ProgramSpec {
  kind: string;
  lit: boolean;
  textured: boolean;
  lights: number;
  primitive: Primitive;
}

/** The vertex/fragment pair for one material configuration. */
function materialProgramSource({
  kind,
  lit,
  textured,
  lights,
  primitive,
}: ProgramSpec): { vertex: string; fragment: string } {
  const phong = kind === 'meshPhongMaterial' || kind === 'meshStandardMaterial';
  const points = primitive === 'points';
  const vertex = `${COMMON_VERTEX_UNIFORMS}${points ? 'uniform float pointSize;\n' : ''}
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec2 vUv;
void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  // the direction from the surface toward the eye, which is the origin in
  // view space
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
${points ? '  // ES 2 has no glPointSize: a point sprite is sized by the vertex shader\n  gl_PointSize = pointSize;\n' : ''}}`;

  const lighting = lit
    ? `
uniform vec3 ambientColor;
// w picks the kind: 0 is a direction toward the light, 1 is a position
uniform vec4 lightPosition[${lights}];
uniform vec3 lightColor[${lights}];
uniform vec3 spotDirection[${lights}];
// x = cos(cutoff) or -1 for a light that is not a spot, y = spot exponent,
// z = linear attenuation, w unused
uniform vec4 spotParams[${lights}];
`
    : '';

  const lightingBody = lit
    ? `
  vec3 normal = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 viewDir = normalize(vViewPosition);
  vec3 lit = ambientColor * diffuseColor;
  for (int i = 0; i < ${lights}; i++) {
    vec3 toLight;
    float attenuation = 1.0;
    if (lightPosition[i].w == 0.0) {
      toLight = normalize(lightPosition[i].xyz);
    } else {
      vec3 offset = lightPosition[i].xyz - (-vViewPosition);
      float dist = length(offset);
      toLight = offset / max(dist, 0.0001);
      attenuation = 1.0 / (1.0 + spotParams[i].z * dist);
      if (spotParams[i].x >= -0.5) {
        float aligned = dot(-toLight, normalize(spotDirection[i]));
        attenuation *= aligned < spotParams[i].x
          ? 0.0
          : pow(aligned, spotParams[i].y);
      }
    }
    float diffuse = max(dot(normal, toLight), 0.0);
    lit += diffuseColor * lightColor[i] * diffuse * attenuation;
${
  phong
    ? `    if (diffuse > 0.0) {
      vec3 halfway = normalize(toLight + viewDir);
      float spec = pow(max(dot(normal, halfway), 0.0), max(shininess, 0.0001));
      lit += specularColor * lightColor[i] * spec * attenuation;
    }`
    : ''
}
  }
  vec3 color = lit + emissiveColor;`
    : `
  vec3 color = diffuseColor;`;

  const fragment = `${PRECISION}uniform vec3 diffuse;
uniform float opacity;
uniform vec3 emissive;
${phong ? 'uniform vec3 specular;\nuniform float shininess;\n' : ''}${textured ? 'uniform sampler2D map;\n' : ''}${lighting}
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec2 vUv;
void main() {
  vec4 base = vec4(diffuse, opacity);
${textured ? '  base *= texture2D(map, vUv);\n' : ''}
  vec3 diffuseColor = base.rgb;
  vec3 emissiveColor = ${lit ? 'emissive' : 'vec3(0.0)'};
${phong ? '  vec3 specularColor = specular;\n' : ''}${lightingBody}
  gl_FragColor = vec4(color, base.a);
}`;

  return { vertex, fragment };
}

/** Shader sources for a `<shaderMaterial>`, with three.js's prelude. */
function userProgramSource(
  material: ShaderMaterial,
  raw: boolean,
): { vertex: string; fragment: string } {
  const vertex = raw
    ? material.vertexShader
    : `${COMMON_VERTEX_UNIFORMS}uniform vec3 cameraPosition;
${material.vertexShader}`;
  const fragment = raw
    ? material.fragmentShader
    : `${PRECISION}${material.fragmentShader}`;
  return { vertex, fragment };
}

/** The ES 2 draw mode a drawable's primitive assembles into. */
function PRIMITIVE_MODE(gl: GL, primitive: Primitive): number {
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

const isTypedArray = (v: unknown): v is Float32Array =>
  ArrayBuffer.isView(v) && !(v instanceof DataView);

/**
 * A `<shaderMaterial>` uniform value, sent with whichever setter its
 * JavaScript type implies. Matrices need a typed array or a 9/16-long
 * array, since nothing else says "this is a mat3, not three vec3s".
 */
function setUniform(gl: GL, location: unknown, value: unknown): void {
  if (location === null || location === -1 || value === undefined) return;
  if (typeof value === 'number') return gl.uniform1f(location, value);
  if (typeof value === 'boolean') return gl.uniform1i(location, value ? 1 : 0);
  if (value instanceof Color) {
    return gl.uniform3fv(location, new Float32Array(value.toArray()));
  }
  if (isTypedArray(value) || Array.isArray(value)) {
    const array =
      value instanceof Float32Array
        ? value
        : new Float32Array(value as ArrayLike<number>);
    switch (array.length) {
      case 2:
        return gl.uniform2fv(location, array);
      case 3:
        return gl.uniform3fv(location, array);
      case 4:
        return gl.uniform4fv(location, array);
      case 9:
        return gl.uniformMatrix3fv(location, false, array);
      case 16:
        return gl.uniformMatrix4fv(location, false, array);
      default:
        return gl.uniform1fv(location, array);
    }
  }
}

interface GeometryBuffers {
  version: number;
  position: unknown;
  normal: unknown;
  uv: unknown;
  index: unknown;
  count: number;
  /** Lazily built unique-edge index — how wireframe draws where ES 2 has no
   * `glPolygonMode`. Rides the entry so it releases and rebuilds with it. */
  wire: { index: unknown; count: number } | null;
}

export interface CompiledProgram {
  program: unknown;
  uniform(name: string): unknown;
  attribute(name: string): number;
}

interface LightUniforms {
  count: number;
  ambient: Float32Array;
  position: Float32Array;
  color: Float32Array;
  spotDirection: Float32Array;
  spotParams: Float32Array;
  lit: boolean;
}

/**
 * Per-surface GPU state for the direct backend: one buffer set per geometry,
 * one program per material configuration, one texture per image.
 */
export class DirectRenderer {
  readonly backend = 'direct';

  private geometries = new Map<
    BufferGeometry,
    Map<'shaded' | 'flat', GeometryBuffers>
  >();
  private programs = new Map<string, { program: unknown } | CompiledProgram>();
  private textures = new Map<
    TextureImage,
    { texture: unknown; unit: number }
  >();
  private failed = new Set<string>();
  private wireWarned = new WeakSet<BufferGeometry>();
  private _usable: boolean | undefined;

  camera: FrameCamera | null = null;
  /** A shader that will not build is reported here, once per source. */
  onError: ((err: Error & { code?: string }) => void) | null = null;

  render(
    gl: GL,
    scene: Scene,
    camera: Camera,
    size: { width: number; height: number },
  ): boolean {
    const roots = scene.children.filter((c) => c.isObject3D);
    if (roots.length === 0) return false;
    if (!this.usable(gl)) return false;

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    const projection = camera.projectionMatrix(size.width, size.height);
    const view = camera.viewMatrix();
    this.camera = { projection, view, width: size.width, height: size.height };

    const lights = this.lightUniforms(collectLights(roots, identity()), view);

    for (const node of roots) this.drawObject(gl, node, identity(), lights);
    return true;
  }

  /**
   * Does this context have the GL entry points a material needs? It can
   * genuinely lack them: ntk passes the `x11-dri` addon's table straight
   * through, so the context is only as complete as the addon installed. The
   * failure without this check is a `TypeError` from inside a draw call,
   * which names nothing a consumer could act on.
   */
  private usable(gl: GL): boolean {
    if (this._usable !== undefined) return this._usable;
    const missing = [
      'createBuffer',
      'bufferData',
      'createShader',
      'linkProgram',
      'uniform3fv',
      'uniformMatrix4fv',
      'uniformMatrix3fv',
      'drawElements',
      'blendFunc',
      'depthMask',
    ].filter((name) => typeof gl[name] !== 'function');
    this._usable = missing.length === 0;
    if (!this._usable) {
      this.report(
        'gl-incomplete',
        `this GL context is missing ${missing.join(', ')}, so the 3D scene ` +
          'cannot be drawn. The direct backend exposes whatever the x11-dri ' +
          'addon provides; check with `npm ls x11-dri`.',
        'GL_CONTEXT_INCOMPLETE',
      );
    }
    return this._usable;
  }

  /**
   * Lights as flat arrays in view space, which is where the shader works.
   * Transformed here rather than in the shader for the same reason
   * fixed-function GL transforms them when they are set: once per frame
   * beats once per fragment.
   */
  private lightUniforms(
    lights: { node: Light; world: Mat4 }[],
    view: Mat4,
  ): LightUniforms {
    const ambient = [0, 0, 0];
    const used: {
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
        ambient[0] += r * intensity;
        ambient[1] += g * intensity;
        ambient[2] += b * intensity;
        continue;
      }
      if (used.length >= MAX_LIGHTS) continue;
      used.push({ node, intensity, color: [r, g, b], world: light.world });
    }

    const count = used.length;
    const position = new Float32Array(Math.max(1, count) * 4);
    const color = new Float32Array(Math.max(1, count) * 3);
    const spotDirection = new Float32Array(Math.max(1, count) * 3);
    const spotParams = new Float32Array(Math.max(1, count) * 4);

    used.forEach((light, i) => {
      const { node, intensity, world } = light;
      const wx = world[12];
      const wy = world[13];
      const wz = world[14];
      const directional = (node as { isDirectionalLight?: boolean })
        .isDirectionalLight;
      // view-space position (w = 1) or direction toward the light (w = 0)
      const w = directional ? 0 : 1;
      position[i * 4] =
        view[0] * wx + view[4] * wy + view[8] * wz + view[12] * w;
      position[i * 4 + 1] =
        view[1] * wx + view[5] * wy + view[9] * wz + view[13] * w;
      position[i * 4 + 2] =
        view[2] * wx + view[6] * wy + view[10] * wz + view[14] * w;
      position[i * 4 + 3] = w;
      color[i * 3] = light.color[0] * intensity;
      color[i * 3 + 1] = light.color[1] * intensity;
      color[i * 3 + 2] = light.color[2] * intensity;

      const distance = (node as PointLight).distance ?? 0;
      spotParams[i * 4 + 2] = distance > 0 ? 1 / distance : 0;
      if ((node as { isSpotLight?: boolean }).isSpotLight) {
        const spot = node as SpotLight;
        const dx = spot.target.x - wx;
        const dy = spot.target.y - wy;
        const dz = spot.target.z - wz;
        const length = Math.hypot(dx, dy, dz) || 1;
        // the direction is a vector, so the translation column does not apply
        spotDirection[i * 3] =
          (view[0] * dx + view[4] * dy + view[8] * dz) / length;
        spotDirection[i * 3 + 1] =
          (view[1] * dx + view[5] * dy + view[9] * dz) / length;
        spotDirection[i * 3 + 2] =
          (view[2] * dx + view[6] * dy + view[10] * dz) / length;
        spotParams[i * 4] = Math.cos(Math.min(Math.PI / 2, spot.angle));
        spotParams[i * 4 + 1] = spot.penumbra * 128;
      } else {
        spotParams[i * 4] = -1; // not a spot
        spotParams[i * 4 + 1] = 0;
      }
    });

    return {
      count,
      ambient: new Float32Array(ambient),
      position,
      color,
      spotDirection,
      spotParams,
      lit: count > 0 || ambient.some((c) => c > 0),
    };
  }

  private drawObject(
    gl: GL,
    node: Object3D,
    parentWorld: Mat4,
    lights: LightUniforms,
  ): void {
    if (!node.visible) return;
    const world = multiply(parentWorld, node.localMatrix());
    node.__world = world;
    if ((node as Mesh).isMesh) this.drawMesh(gl, node as Mesh, world, lights);
    for (const child of node.children) {
      if (child.isObject3D) this.drawObject(gl, child, world, lights);
    }
  }

  private drawMesh(
    gl: GL,
    mesh: Mesh,
    world: Mat4,
    lights: LightUniforms,
  ): void {
    const geometry = mesh.geometry;
    if (!geometry) return;
    const primitive = mesh.primitive;
    const buffers = this.geometryFor(gl, geometry, primitive);
    if (!buffers) return;

    const material = mesh.material;
    const program = this.programFor(gl, material, lights, primitive);
    if (!program) return;

    gl.useProgram(program.program);
    const applied = this.applyMaterial(gl, program, material, lights);

    gl.uniformMatrix4fv(
      program.uniform('projectionMatrix'),
      false,
      this.camera!.projection,
    );
    gl.uniformMatrix4fv(
      program.uniform('viewMatrix'),
      false,
      this.camera!.view,
    );
    this.bindAttributes(gl, program, buffers);

    const wire =
      primitive === 'triangles' && material?.wireframe
        ? this.wireframeFor(gl, geometry, buffers)
        : null;

    if (!(mesh instanceof InstancedMesh)) {
      this.drawOne(gl, program, buffers, world, primitive, wire);
      return;
    }

    // One upload, many transforms. Neither backend does GPU instancing —
    // ES 2 guarantees none and GLX encodes none — so what this saves is the
    // geometry, not the draw calls: each instance is a matrix and a draw.
    const diffuse = program.uniform('diffuse');
    for (const instance of mesh.instances) {
      if (instance.color) {
        const c = new Color(instance.color as never);
        gl.uniform3fv(diffuse, new Float32Array([c.r, c.g, c.b]));
      } else if (applied) {
        gl.uniform3fv(diffuse, new Float32Array(applied.color));
      }
      this.drawOne(
        gl,
        program,
        buffers,
        multiply(world, instanceMatrix(instance)),
        primitive,
        wire,
      );
    }
  }

  /** One draw of `buffers` at `world`, as whichever primitive. */
  private drawOne(
    gl: GL,
    program: CompiledProgram,
    buffers: GeometryBuffers,
    world: Mat4,
    primitive: Primitive,
    wire: { index: unknown; count: number } | null = null,
  ): void {
    const modelView = multiply(this.camera!.view, world);
    gl.uniformMatrix4fv(program.uniform('modelViewMatrix'), false, modelView);
    gl.uniformMatrix4fv(program.uniform('modelMatrix'), false, world);
    gl.uniformMatrix3fv(
      program.uniform('normalMatrix'),
      false,
      normalMatrix(modelView),
    );
    if (wire) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wire.index);
      gl.drawElements(gl.LINES, wire.count, gl.UNSIGNED_SHORT, 0);
      return;
    }
    const mode = PRIMITIVE_MODE(gl, primitive);
    if (buffers.index) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index);
      gl.drawElements(mode, buffers.count, gl.UNSIGNED_SHORT, 0);
    } else {
      gl.drawArrays(mode, 0, buffers.count);
    }
  }

  private bindAttributes(
    gl: GL,
    program: CompiledProgram,
    buffers: GeometryBuffers,
  ): void {
    for (const [name, buffer, size] of [
      ['position', buffers.position, 3],
      ['normal', buffers.normal, 3],
      ['uv', buffers.uv, 2],
    ] as const) {
      const location = program.attribute(name);
      if (location < 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    }
  }

  /**
   * Upload a geometry once and keep it on the GPU. The indirect backend
   * compiles geometry into a display list for exactly the same reason —
   * never send the vertices twice — and the cache is keyed the same way, by
   * object identity and version.
   */
  private geometryFor(
    gl: GL,
    node: BufferGeometry,
    primitive: Primitive,
  ): GeometryBuffers | null {
    // Keyed by primitive as well as by node: points and lines want no
    // normals and ignore the triangle index, so the same geometry used both
    // ways is genuinely two uploads.
    const shaded = primitive === 'triangles';
    const key = shaded ? 'shaded' : 'flat';
    let perPrimitive = this.geometries.get(node);
    if (!perPrimitive) this.geometries.set(node, (perPrimitive = new Map()));
    const cached = perPrimitive.get(key);
    if (cached && cached.version === node.version) return cached;
    if (cached) this.releaseGeometry(gl, cached);

    const built = node.data({ normals: shaded });
    const { positions, normals, uvs } = built;
    // points are one dot per vertex; running a triangle index over them
    // would draw every shared vertex again
    const index = primitive === 'points' ? null : built.index;
    const vertexCount = positions.length / 3;
    if (vertexCount === 0) return null;

    const upload = (data: number[], fallbackLength: number) => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const array = data.length
        ? new Float32Array(data)
        : new Float32Array(fallbackLength);
      gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
      return buffer;
    };

    const entry: GeometryBuffers = {
      version: node.version,
      position: upload(positions, vertexCount * 3),
      normal: upload(normals, vertexCount * 3),
      uv: upload(uvs, vertexCount * 2),
      index: null,
      count: vertexCount,
      wire: null,
    };

    if (index && index.length) {
      // ES 2 indices are 16-bit. A geometry with more vertices than that is
      // expanded to a flat triangle soup rather than quietly wrapping —
      // sphereGeometry with enough segments really does get there.
      if (vertexCount > 0xffff) {
        const flat = {
          positions: [] as number[],
          normals: [] as number[],
          uvs: [] as number[],
        };
        for (const i of index) {
          flat.positions.push(
            positions[i * 3],
            positions[i * 3 + 1],
            positions[i * 3 + 2],
          );
          flat.normals.push(
            normals[i * 3],
            normals[i * 3 + 1],
            normals[i * 3 + 2],
          );
          flat.uvs.push(uvs[i * 2], uvs[i * 2 + 1]);
        }
        this.releaseGeometry(gl, entry);
        entry.position = upload(flat.positions, 0);
        entry.normal = upload(flat.normals, 0);
        entry.uv = upload(flat.uvs, 0);
        entry.index = null;
        entry.count = index.length;
      } else {
        entry.index = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, entry.index);
        gl.bufferData(
          gl.ELEMENT_ARRAY_BUFFER,
          new Uint16Array(index),
          gl.STATIC_DRAW,
        );
        entry.count = index.length;
      }
    }

    perPrimitive.set(key, entry);
    return entry;
  }

  private releaseGeometry(gl: GL, entry: GeometryBuffers): void {
    for (const key of ['position', 'normal', 'uv', 'index'] as const) {
      if (entry[key]) gl.deleteBuffer(entry[key]);
      entry[key] = null;
    }
    if (entry.wire) {
      gl.deleteBuffer(entry.wire.index);
      entry.wire = null;
    }
  }

  /**
   * The unique-edge index that draws `node` as a wireframe. The indirect
   * backend flips one server-side switch (`PolygonMode LINE`); ES 2 has no
   * polygon modes, so this backend does what three.js's `WireframeGeometry`
   * does — every triangle edge once, drawn as `LINES` over the same vertex
   * buffers. Built on first use, cached until the geometry rebuilds.
   */
  private wireframeFor(
    gl: GL,
    node: BufferGeometry,
    buffers: GeometryBuffers,
  ): { index: unknown; count: number } | null {
    if (buffers.wire) return buffers.wire;
    // no index means consecutive-triplet triangles (including the >0xffff
    // soup, whose vertices a 16-bit edge index cannot name)
    if (!buffers.index && buffers.count > 0xffff) {
      if (!this.wireWarned.has(node)) {
        this.wireWarned.add(node);
        warn(
          `wireframe needs a 16-bit index and this geometry expanded to ` +
            `${buffers.count} vertices — drawing it filled`,
        );
      }
      return null;
    }
    const source = buffers.index ? node.data({ normals: true }).index : null;
    const seen = new Set<number>();
    const edges: number[] = [];
    const push = (a: number, b: number) => {
      const key = a < b ? a * 0x10000 + b : b * 0x10000 + a;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push(a, b);
    };
    const triangles = source ? source.length / 3 : buffers.count / 3;
    for (let t = 0; t < triangles; t++) {
      const a = source ? source[t * 3] : t * 3;
      const b = source ? source[t * 3 + 1] : t * 3 + 1;
      const c = source ? source[t * 3 + 2] : t * 3 + 2;
      push(a, b);
      push(b, c);
      push(c, a);
    }
    const index = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array(edges),
      gl.STATIC_DRAW,
    );
    buffers.wire = { index, count: edges.length };
    return buffers.wire;
  }

  /** Compile once per material configuration, reuse for every mesh using it. */
  private programFor(
    gl: GL,
    material: Material | null,
    lights: LightUniforms,
    primitive: Primitive,
  ): CompiledProgram | null {
    const kind = material?.kind ?? 'meshBasicMaterial';
    const user = material instanceof ShaderMaterial;

    let signature: string;
    let source: { vertex: string; fragment: string };
    if (user) {
      const shader = material as ShaderMaterial;
      signature = `${kind} ${shader.vertexShader} ${shader.fragmentShader}`;
      source = userProgramSource(shader, material instanceof RawShaderMaterial);
    } else {
      const lit = !UNLIT_MATERIALS.has(kind) && lights.lit && lights.count > 0;
      const map = material?.map;
      const textured = !!(map?.width && map?.data);
      // the primitive is part of the signature because only a points program
      // declares (and writes) gl_PointSize
      signature = `${kind}|${lit}|${textured}|${lights.count}|${primitive}`;
      source = materialProgramSource({
        kind,
        lit,
        textured,
        lights: lights.count,
        primitive,
      });
    }

    const cached = this.programs.get(signature);
    if (cached) return cached.program ? (cached as CompiledProgram) : null;

    const entry = this.compile(gl, source, signature, kind);
    this.programs.set(signature, entry);
    return entry.program ? (entry as CompiledProgram) : null;
  }

  /** Lent to the post-processor, so a pass that will not build is reported
   * exactly the way a material that will not build is. */
  compile(
    gl: GL,
    source: { vertex: string; fragment: string },
    signature: string,
    kind: string,
  ): { program: unknown } | CompiledProgram {
    const shader = (type: number, text: string, what: string) => {
      const object = gl.createShader(type);
      gl.shaderSource(object, text);
      gl.compileShader(object);
      if (gl.getShaderParameter(object, gl.COMPILE_STATUS)) return object;
      this.report(
        signature,
        `${kind}: ${what} failed to compile\n${gl.getShaderInfoLog(object)}`,
      );
      gl.deleteShader(object);
      return null;
    };

    const vertex = shader(gl.VERTEX_SHADER, source.vertex, 'vertex shader');
    const fragment =
      vertex && shader(gl.FRAGMENT_SHADER, source.fragment, 'fragment shader');
    if (!vertex || !fragment) {
      if (vertex) gl.deleteShader(vertex);
      return { program: null };
    }

    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      this.report(
        signature,
        `${kind}: program failed to link\n${gl.getProgramInfoLog(program)}`,
      );
      gl.deleteProgram(program);
      return { program: null };
    }

    const uniforms = new Map<string, unknown>();
    const attributes = new Map<string, number>();
    return {
      program,
      uniform(name: string) {
        if (!uniforms.has(name))
          uniforms.set(name, gl.getUniformLocation(program, name));
        return uniforms.get(name);
      },
      attribute(name: string) {
        if (!attributes.has(name))
          attributes.set(name, gl.getAttribLocation(program, name));
        return attributes.get(name)!;
      },
    };
  }

  /**
   * A shader that will not build is reported once and then skipped.
   * Throwing would take down a render that is otherwise fine, and repeating
   * it every frame would bury the message it came with — the compiler's own
   * log, the only thing that says what to fix.
   */
  report(signature: string, message: string, code = 'GL_SHADER_FAILED'): void {
    if (this.failed.has(signature)) return;
    this.failed.add(signature);
    const err = new Error(`@react-x11/components: ${message}`) as Error & {
      code?: string;
    };
    err.code = code;
    if (this.onError) this.onError(err);
    else warn(err.message);
  }

  /** `<shaderPass uniforms>` reads like a `<shaderMaterial>`'s. */
  setUniform(gl: GL, location: unknown, value: unknown): void {
    setUniform(gl, location, value);
  }

  private applyMaterial(
    gl: GL,
    program: CompiledProgram,
    material: Material | null,
    lights: LightUniforms,
  ): { color: [number, number, number] } | undefined {
    if (material instanceof ShaderMaterial) {
      gl.uniform3fv(program.uniform('cameraPosition'), this.cameraPosition());
      for (const [name, entry] of Object.entries(
        material.uniforms as Record<string, UniformEntry>,
      )) {
        const value = entry.value;
        const image = value as TextureImage | null;
        if (
          image &&
          typeof image === 'object' &&
          'width' in image &&
          'data' in image &&
          image.width &&
          image.data
        ) {
          const unit = this.textureFor(gl, image);
          gl.uniform1i(program.uniform(name), unit);
        } else {
          setUniform(gl, program.uniform(name), value);
        }
      }
      this.applyDrawState(
        gl,
        material,
        material.transparent || material.opacity < 1,
      );
      return undefined;
    }

    const kind = material?.kind ?? 'meshBasicMaterial';
    const colors = materialColors(material);
    const scale = colors.diffuseScale;
    gl.uniform3fv(
      program.uniform('diffuse'),
      new Float32Array([
        colors.color[0] * scale,
        colors.color[1] * scale,
        colors.color[2] * scale,
      ]),
    );
    // three.js's names: `size` on a points material, `linewidth` on a line one
    if (kind === 'pointsMaterial') {
      gl.uniform1f(
        program.uniform('pointSize'),
        (material as { size?: number } | null)?.size ?? 1,
      );
    }
    if (kind === 'lineBasicMaterial') {
      gl.lineWidth((material as { linewidth?: number } | null)?.linewidth ?? 1);
    }
    gl.uniform1f(program.uniform('opacity'), colors.alpha);
    gl.uniform3fv(
      program.uniform('emissive'),
      new Float32Array(colors.emissive),
    );
    if (kind === 'meshPhongMaterial' || kind === 'meshStandardMaterial') {
      gl.uniform3fv(
        program.uniform('specular'),
        new Float32Array(colors.specular),
      );
      gl.uniform1f(program.uniform('shininess'), colors.shininess);
    }

    const map = material?.map;
    if (map?.width && map?.data) {
      gl.uniform1i(program.uniform('map'), this.textureFor(gl, map));
    }

    if (lights.count > 0 || lights.lit) {
      gl.uniform3fv(program.uniform('ambientColor'), lights.ambient);
      if (lights.count > 0) {
        gl.uniform4fv(program.uniform('lightPosition[0]'), lights.position);
        gl.uniform3fv(program.uniform('lightColor[0]'), lights.color);
        gl.uniform3fv(
          program.uniform('spotDirection[0]'),
          lights.spotDirection,
        );
        gl.uniform4fv(program.uniform('spotParams[0]'), lights.spotParams);
      }
    }

    this.applyDrawState(
      gl,
      material,
      colors.alpha < 1 || (material?.transparent ?? false),
    );
    // handed back so <instancedMesh> can restore it between instances that
    // override the colour and instances that do not
    return { color: colors.color };
  }

  /** Blending, culling and depth writes — the state a material implies. */
  private applyDrawState(
    gl: GL,
    material: Material | null,
    blended: boolean,
  ): void {
    if (blended) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      // a translucent surface must not hide what is behind it
      gl.depthMask(false);
    } else {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }
    const side = material?.side ?? 'front';
    if (side === 'double') {
      gl.disable(gl.CULL_FACE);
    } else {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(side === 'back' ? gl.FRONT : gl.BACK);
    }
  }

  private cameraPosition(): Float32Array {
    // the eye is the origin in view space, so its world position is the
    // translation of the inverted view matrix
    const inverse = this.camera ? invert(this.camera.view) : null;
    return inverse
      ? new Float32Array([inverse[12], inverse[13], inverse[14]])
      : new Float32Array(3);
  }

  /**
   * Upload an image once and bind it to a texture unit. `map` is an ntk
   * `Image`, or anything with `{ width, height, data }` in RGBA byte order —
   * the same contract the indirect renderer takes.
   */
  textureFor(gl: GL, image: TextureImage): number {
    const cached = this.textures.get(image);
    if (cached) {
      gl.activeTexture(gl.TEXTURE0 + cached.unit);
      gl.bindTexture(gl.TEXTURE_2D, cached.texture);
      return cached.unit;
    }
    const unit = this.textures.size;
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const data =
      image.data instanceof Uint8Array
        ? image.data
        : new Uint8Array(image.data as ArrayLike<number>);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      image.width,
      image.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // REPEAT needs power-of-two dimensions in ES 2; CLAMP_TO_EDGE always works
    const pot = (n: number) => (n & (n - 1)) === 0;
    const wrap =
      pot(image.width) && pot(image.height) ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    this.textures.set(image, { texture, unit });
    return unit;
  }

  /** A removed geometry's buffers are no longer needed on the GPU. */
  forget(gl: GL, node: BufferGeometry): void {
    const perPrimitive = this.geometries.get(node);
    if (!perPrimitive) return;
    this.geometries.delete(node);
    if (gl)
      for (const entry of perPrimitive.values())
        this.releaseGeometry(gl, entry);
  }

  dispose(gl: GL): void {
    if (gl) {
      for (const perPrimitive of this.geometries.values()) {
        for (const entry of perPrimitive.values()) {
          this.releaseGeometry(gl, entry);
        }
      }
      for (const { program } of this.programs.values()) {
        if (program) gl.deleteProgram(program);
      }
      for (const { texture } of this.textures.values())
        gl.deleteTexture(texture);
    }
    this.geometries.clear();
    this.programs.clear();
    this.textures.clear();
  }
}
