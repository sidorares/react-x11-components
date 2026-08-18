// Materials: what a surface looks like, spelled with three.js's names.
//
// Mutable objects for the same reason the scene objects are — three-fiber
// code animates a material by writing to it (`material.opacity = t`,
// `material.uniforms.uTime.value = t`) — but the renderers read the *values*
// every frame rather than watching for writes, so there is no version
// counter here: the indirect renderer's material key is built from the
// current values and the direct renderer sets uniforms per draw either way.
//
// The one three.js material family deliberately reshaped is
// `MeshStandardMaterial`. PBR needs an environment and shading neither
// backend has, so `roughness`/`metalness` are *mapped* onto the Blinn-Phong
// terms both backends can draw — through one shared function, so the
// approximation is identical over indirect GLX and over DRI3. Honest edge:
// it will not look like three.js's PBR; it will look like the same material
// on both react-x11 backends.
import { Color } from './math.js';
import type { ColorLike } from './math.js';

/** An ntk `Image`, or anything with `{ width, height, data }` RGBA bytes. */
export interface TextureImage {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export type MaterialSide = 'front' | 'back' | 'double';

/** three.js's `{ value }` wrapper; a bare value is accepted and wrapped. */
export interface UniformEntry {
  value: unknown;
}
export type Uniforms = Record<string, UniformEntry>;

export class Material {
  readonly isMaterial: boolean = true;
  /** The renderer switch key — matches the JSX element name. */
  readonly kind: string = 'meshBasicMaterial';

  readonly color = new Color([1, 1, 1]);
  opacity = 1;
  transparent = false;
  wireframe = false;
  side: MaterialSide = 'front';
  map: TextureImage | null = null;

  /** @internal notified on any change so a demand-mode surface redraws */
  __dirty: (() => void) | null = null;

  constructor(parameters?: Record<string, unknown>) {
    this.color._onChange = () => this.__dirty?.();
    if (parameters) this.setValues(parameters);
  }

  /** three.js's constructor-parameter contract: `{ color: 'hotpink' }`. */
  setValues(parameters: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(parameters)) {
      if (value === undefined) continue;
      const current = (this as Record<string, unknown>)[key];
      if (current instanceof Color) current.set(value as ColorLike);
      else (this as Record<string, unknown>)[key] = value;
    }
    this.__dirty?.();
  }
}

/** Unlit: colour, `opacity`, `map`. */
export class MeshBasicMaterial extends Material {
  override readonly kind: string = 'meshBasicMaterial';
}

/** Diffuse shading. */
export class MeshLambertMaterial extends Material {
  override readonly kind: string = 'meshLambertMaterial';
  readonly emissive = new Color([0, 0, 0]);

  constructor(parameters?: Record<string, unknown>) {
    super();
    this.emissive._onChange = () => this.__dirty?.();
    if (parameters) this.setValues(parameters);
  }
}

/** + Blinn-Phong specular. */
export class MeshPhongMaterial extends MeshLambertMaterial {
  override readonly kind: string = 'meshPhongMaterial';
  readonly specular = new Color([1, 1, 1]);
  shininess = 30;

  constructor(parameters?: Record<string, unknown>) {
    super();
    this.specular._onChange = () => this.__dirty?.();
    if (parameters) this.setValues(parameters);
  }
}

/**
 * `roughness`/`metalness`, approximated. Both renderers draw this through
 * `standardToPhong` below, so a scene written against three.js's most common
 * material renders — the same way on both backends, and not the way a PBR
 * pipeline would. The mapping is the documented contract, not an accident.
 */
export class MeshStandardMaterial extends MeshLambertMaterial {
  override readonly kind: string = 'meshStandardMaterial';
  roughness = 1;
  metalness = 0;

  constructor(parameters?: Record<string, unknown>) {
    super();
    if (parameters) this.setValues(parameters);
  }
}

/**
 * The Blinn-Phong terms a standard material shades with:
 *
 * - shininess falls out of roughness as `(1 - roughness)^4 * 128` — rough 1
 *   is matte (no highlight), rough 0.5 a broad sheen, rough 0 a tight one;
 * - the specular colour runs from a neutral 4% grey (dielectric) toward the
 *   base colour (metal), scaled so a rough surface's highlight also dims;
 * - metals reflect rather than scatter, so the diffuse term shrinks with
 *   metalness.
 */
export function standardToPhong(material: MeshStandardMaterial): {
  shininess: number;
  specular: [number, number, number];
  diffuseScale: number;
} {
  const rough = Math.min(1, Math.max(0, material.roughness));
  const metal = Math.min(1, Math.max(0, material.metalness));
  const gloss = (1 - rough) ** 4;
  const { r, g, b } = material.color;
  const strength = 0.04 + 0.96 * metal;
  return {
    shininess: Math.max(1, gloss * 128),
    specular: [
      (0.04 + (r - 0.04) * metal) * strength * (1 - rough * 0.8) * 4,
      (0.04 + (g - 0.04) * metal) * strength * (1 - rough * 0.8) * 4,
      (0.04 + (b - 0.04) * metal) * strength * (1 - rough * 0.8) * 4,
    ].map((v) => Math.min(1, v)) as [number, number, number],
    diffuseScale: 1 - metal * 0.75,
  };
}

/** Unlit dots; `size` in pixels. */
export class PointsMaterial extends Material {
  override readonly kind: string = 'pointsMaterial';
  size = 1;

  // Subclass fields initialize after super() returns, so parameters must be
  // applied here, not passed up — `super(parameters)` would set `size` and
  // then the field initializer above would put the default back.
  constructor(parameters?: Record<string, unknown>) {
    super();
    if (parameters) this.setValues(parameters);
  }
}

/** Unlit lines; `linewidth` is three.js's spelling, and most drivers only
 * honour 1 — a GL limitation, not a react-x11 one. */
export class LineBasicMaterial extends Material {
  override readonly kind: string = 'lineBasicMaterial';
  linewidth = 1;

  constructor(parameters?: Record<string, unknown>) {
    super();
    if (parameters) this.setValues(parameters);
  }
}

/**
 * Your own GLSL — the **direct** backend only, because the GLX protocol
 * encodes no shader objects. three.js's prelude is injected: attributes
 * `position`/`normal`/`uv`, the matrix uniforms and `cameraPosition`, so a
 * shader copied from an r3f tutorial compiles unchanged.
 *
 * `uniforms` entries are normalized to `{ value }` wrappers on assignment,
 * so `material.uniforms.uTime.value = t` — the r3f animation idiom — works
 * whether the component wrote `{ uTime: 0 }` or `{ uTime: { value: 0 } }`.
 */
export class ShaderMaterial extends Material {
  override readonly kind: string = 'shaderMaterial';
  vertexShader = '';
  fragmentShader = '';

  private _uniforms: Uniforms = {};

  constructor(parameters?: Record<string, unknown>) {
    super();
    if (parameters) this.setValues(parameters);
  }

  get uniforms(): Uniforms {
    return this._uniforms;
  }

  set uniforms(value: Record<string, unknown>) {
    const wrapped: Uniforms = {};
    for (const [name, entry] of Object.entries(value ?? {})) {
      wrapped[name] =
        entry && typeof entry === 'object' && 'value' in entry
          ? (entry as UniformEntry)
          : { value: entry };
    }
    this._uniforms = wrapped;
    this.__dirty?.();
  }
}

/** The same, with nothing declared for you — as in three.js. */
export class RawShaderMaterial extends ShaderMaterial {
  override readonly kind: string = 'rawShaderMaterial';
}

/** Materials with no surface to shade, which lighting never applies to. */
export const UNLIT_MATERIALS = new Set([
  'meshBasicMaterial',
  'pointsMaterial',
  'lineBasicMaterial',
]);

/**
 * The colour reading both renderers share, so a material means the same
 * thing whichever pipeline draws it: `[r, g, b]`, the effective alpha
 * (CSS-spelled alpha times `opacity`), emissive and specular.
 */
export function materialColors(material: Material | null): {
  color: [number, number, number];
  alpha: number;
  emissive: [number, number, number];
  specular: [number, number, number];
  shininess: number;
  diffuseScale: number;
} {
  if (!material) {
    return {
      color: [1, 1, 1],
      alpha: 1,
      emissive: [0, 0, 0],
      specular: [1, 1, 1],
      shininess: 30,
      diffuseScale: 1,
    };
  }
  const { r, g, b, _alpha } = material.color;
  const emissive =
    material instanceof MeshLambertMaterial
      ? material.emissive.toArray()
      : ([0, 0, 0] as [number, number, number]);
  let specular: [number, number, number] = [1, 1, 1];
  let shininess = 30;
  let diffuseScale = 1;
  if (material instanceof MeshStandardMaterial) {
    const phong = standardToPhong(material);
    specular = phong.specular;
    shininess = phong.shininess;
    diffuseScale = phong.diffuseScale;
  } else if (material instanceof MeshPhongMaterial) {
    specular = material.specular.toArray();
    shininess = material.shininess;
  }
  return {
    color: [r, g, b],
    alpha: _alpha * material.opacity,
    emissive,
    specular,
    shininess,
    diffuseScale,
  };
}
