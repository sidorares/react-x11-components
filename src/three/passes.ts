// `<effectComposer>` and the passes inside it, as scene-graph objects.
//
// Not objects *in* the scene: a composer has no transform and nothing to
// draw, so the render walk steps over it the way it steps over a material.
// What it holds is an ordered list of passes, and the order is the tree's.
//
// There is no `<renderPass>` as in three.js's composer. The surface's own
// scene is always the input — a composer that did not compose *this* scene
// would have nothing to be — so the first pass reads it and the last one
// writes the window. Direct backend only: the GLX protocol encodes no
// framebuffer objects to render into (see `DIRECT_ONLY_KINDS`).
import { Object3D } from './objects.js';
import type { Uniforms } from './materials.js';

export class EffectComposer extends Object3D {
  override readonly isObject3D = false;
  readonly isComposer = true;
  enabled = true;

  get passes(): Pass[] {
    return this.children.filter((child): child is Pass =>
      Boolean((child as Pass).isPass),
    );
  }
}

/** One full-screen pass. */
export class Pass extends Object3D {
  override readonly isObject3D = false;
  readonly isPass: boolean = true;
  readonly kind: string = 'shaderPass';
  enabled = true;
}

/**
 * Your own full-screen GLSL. Declare `uniform sampler2D tDiffuse` for the
 * incoming image and `varying vec2 vUv` yourself, exactly as a three.js
 * `ShaderPass` shader does. `resolution` (pixels), `texelSize` (1/pixels)
 * and `time` (seconds) are set if you declare them, dropped if you do not.
 */
export class ShaderPass extends Pass {
  override readonly kind = 'shaderPass';
  fragmentShader = '';
  /** Replaces the built-in full-screen quad shader; must write `vUv`. */
  vertexShader = '';

  private _uniforms: Uniforms = {};

  get uniforms(): Uniforms {
    return this._uniforms;
  }

  set uniforms(value: Record<string, unknown>) {
    const wrapped: Uniforms = {};
    for (const [name, entry] of Object.entries(value ?? {})) {
      wrapped[name] =
        entry && typeof entry === 'object' && 'value' in entry
          ? (entry as { value: unknown })
          : { value: entry };
    }
    this._uniforms = wrapped;
    this.__dirty?.();
  }
}

/** Bright areas bleed into their surroundings: threshold, separable blur at
 * half resolution, composite — four draws. */
export class BloomPass extends Pass {
  override readonly kind = 'bloomPass';
  /** Luminance above which a pixel blooms. */
  threshold = 0.75;
  /** How much of the blurred result is added back. */
  strength = 0.8;
  /** Blur width, in half-resolution texels. */
  radius = 1;
}

/** Darkens towards the corners. */
export class VignettePass extends Pass {
  override readonly kind = 'vignettePass';
  /** Where the darkening starts: 0 at the centre, 1 in the corners. */
  offset = 0.5;
  darkness = 0.5;
}

/** Antialiasing in one full-screen pass — the only kind a composed scene
 * can get, since an MSAA attachment is an ES 3 feature. */
export class FxaaPass extends Pass {
  override readonly kind = 'fxaaPass';
}
