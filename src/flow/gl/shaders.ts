// The GL renderer's four programs.
//
// GLSL ES 1.00, for the reason `src/maps/gl/shaders.ts` gives: it is the one
// dialect both direct backends compile, Apple's GL 4.1 core through
// ARB_ES2_compatibility and every Linux GLES driver natively.
//
// Every program shares one coordinate contract, and it is the whole of what
// the vertex shaders agree on. Positions arrive in the scene's units —
// **logical window pixels**, what `../scene.ts` builds in — and leave in
// clip space via device pixels:
//
//     device = (logical + u_offset - u_origin) * u_scale
//
// where `u_origin` is where the surface's top-left sits in the window (the
// pane's content box, which the surface covers exactly) and `u_scale` is the
// display scale. `u_offset` is the pan: the graph's world is built at a
// pinned origin and moved here, so a pan is this one uniform and nothing
// else (`./renderer.ts`). The overlay, pinned to the pane, draws with it at
// zero. So the one multiply `../draw.ts` does on the way to the 2D
// context happens here, per vertex, and every antialiasing ramp below is
// measured in device pixels — which is what makes a 1px line one pixel of
// coverage on any panel.

/** Attribute locations, shared so one quad buffer feeds every program. */
export const ATTRIBUTES = {
  a_corner: 0,
  a_i0: 1,
  a_i1: 2,
  a_i2: 3,
  a_i3: 4,
} as const;

const PRELUDE = `precision highp float;
uniform vec2 u_origin;
uniform vec2 u_offset;
uniform float u_scale;
uniform vec2 u_viewport;
vec2 device(vec2 logical) { return (logical + u_offset - u_origin) * u_scale; }
vec4 clip(vec2 d) {
  return vec4(d.x / u_viewport.x * 2.0 - 1.0,
              1.0 - d.y / u_viewport.y * 2.0, 0.0, 1.0);
}
`;

/**
 * A line segment as a capsule: the quad round it, widened by half the line
 * plus a pixel of fringe, shaded by distance to the segment.
 *
 * Clamping the pixel's position along the segment before measuring is what
 * gives round caps and round joins for nothing — two consecutive capsules
 * overlap in exactly the disc a round join is — and the same distance is the
 * antialiasing ramp. The cost of that is a translucent line, which would lay
 * its colour down twice where two capsules overlap; every line a graph draws
 * by default is opaque, and `src/maps/gl/shaders.ts` has the stencil pass
 * that fixes it if one ever is not.
 *
 * Instance: a_i0 = ends, a_i1 = half-width, distance along at the first end,
 * dash on, dash off; a_i2 = dash offset, and 1 where the dash marches — by
 * `u_phase`, the timer's, in logical pixels; a_i3 = colour.
 */
export const LINE_VERTEX = `${PRELUDE}
uniform float u_phase;
attribute vec2 a_corner;
attribute vec4 a_i0;
attribute vec4 a_i1;
attribute vec4 a_i2;
attribute vec4 a_i3;
varying vec2 v_local;
varying float v_len;
varying float v_half;
varying float v_along;
varying vec3 v_dash;
varying vec4 v_color;
void main() {
  vec2 a = device(a_i0.xy);
  vec2 b = device(a_i0.zw);
  vec2 d = b - a;
  float len = length(d);
  vec2 t = len > 0.0001 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  float half_ = a_i1.x * u_scale;
  float e = half_ + 1.0;
  float along = mix(-e, len + e, a_corner.x);
  float across = a_corner.y * e;
  v_local = vec2(along, across);
  v_len = len;
  v_half = half_;
  v_along = a_i1.y * u_scale + along;
  // a marching dash takes the timer's phase from a uniform, so a tick moves
  // every dash on the GPU without a byte uploaded
  v_dash = vec3(a_i1.z, a_i1.w, a_i2.x + a_i2.y * u_phase) * u_scale;
  v_color = a_i3;
  gl_Position = clip(a + t * along + n * across);
}
`;

export const LINE_FRAGMENT = `precision highp float;
varying vec2 v_local;
varying float v_len;
varying float v_half;
varying float v_along;
varying vec3 v_dash;
varying vec4 v_color;
void main() {
  float x = clamp(v_local.x, 0.0, v_len);
  float dist = length(vec2(v_local.x - x, v_local.y));
  float alpha = clamp(v_half - dist + 0.5, 0.0, 1.0);
  float period = v_dash.x + v_dash.y;
  if (period > 0.0) {
    // Where in the pattern this pixel is, the canvas way: the offset shifts
    // the pattern's start along the line. Covered by how far the pixel is
    // inside the nearer end of its dash, so a dash's ends antialias too.
    float m = mod(v_along + v_dash.z, period);
    alpha *= clamp(min(m, v_dash.x - m) + 0.5, 0.0, 1.0);
  }
  if (alpha <= 0.0) discard;
  gl_FragColor = v_color * alpha;
}
`;

/**
 * A rounded box: fill, border and antialiased edge out of one distance.
 *
 * The 2D painter fills the whole box and strokes a border *inset* by half
 * its pen (`../draw.ts`), so the ink band runs from the edge inward by the
 * pen's width with the fill beneath it. This composites the same way — the
 * border *over* the fill across the band, not in place of it — which only
 * differs when the border is translucent, and a hovered card's is.
 *
 * A disc is a box whose side is twice its corner radius, which is why
 * handles are drawn here too.
 *
 * Instance: a_i0 = x, y, width, height; a_i1 = corner radius, border width;
 * a_i2 = fill; a_i3 = border colour.
 */
export const BOX_VERTEX = `${PRELUDE}
attribute vec2 a_corner;
attribute vec4 a_i0;
attribute vec4 a_i1;
attribute vec4 a_i2;
attribute vec4 a_i3;
varying vec2 v_local;
varying vec2 v_half;
varying vec2 v_shape;
varying vec4 v_fill;
varying vec4 v_border;
void main() {
  vec2 corner = vec2(a_corner.x, a_corner.y * 0.5 + 0.5);
  vec2 size = a_i0.zw * u_scale;
  vec2 half_ = size * 0.5;
  // a pixel of fringe all round, for the antialiased edge to fade into
  vec2 local = (corner - 0.5) * (size + 2.0);
  v_local = local;
  v_half = half_;
  v_shape = vec2(a_i1.x, a_i1.y) * u_scale;
  v_fill = a_i2;
  v_border = a_i3;
  gl_Position = clip(device(a_i0.xy) + half_ + local);
}
`;

export const BOX_FRAGMENT = `precision highp float;
varying vec2 v_local;
varying vec2 v_half;
varying vec2 v_shape;
varying vec4 v_fill;
varying vec4 v_border;
void main() {
  float r = min(v_shape.x, min(v_half.x, v_half.y));
  vec2 q = abs(v_local) - (v_half - r);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float outside = clamp(0.5 - d, 0.0, 1.0);
  vec4 color = v_fill * outside;
  if (v_shape.y > 0.0) {
    float inner = clamp(0.5 - (d + v_shape.y), 0.0, 1.0);
    float band = outside - inner;
    color = v_border * band + color * (1.0 - v_border.a * band);
  }
  if (color.a <= 0.0) discard;
  gl_FragColor = color;
}
`;

/** A flat triangle: the fill of a closed arrowhead. Its edge is
 *  antialiased by the hairline `./pack.ts` strokes round it. */
export const TRI_VERTEX = `${PRELUDE}
attribute vec2 a_corner;
attribute vec4 a_i0;
varying vec4 v_color;
void main() {
  v_color = a_i0;
  gl_Position = clip(device(a_corner));
}
`;

export const TRI_FRAGMENT = `precision mediump float;
varying vec4 v_color;
void main() {
  gl_FragColor = v_color;
}
`;

/**
 * The grid, worked out per pixel: no tile, no pattern and no pile of runs —
 * and none of the 2D path's integral-pitch restriction, because nothing here
 * is a pixmap that has to repeat on whole pixels.
 *
 * Distances are to the nearest grid point in each axis, in logical pixels,
 * and each mark's coverage ramps across one *device* pixel, so a dot is as
 * sharp as the panel draws it.
 */
export const GRID_VERTEX = `precision highp float;
attribute vec2 a_corner;
uniform vec2 u_viewport;
varying vec2 v_device;
void main() {
  v_device = vec2(a_corner.x * u_viewport.x,
                  (a_corner.y * 0.5 + 0.5) * u_viewport.y);
  gl_Position = vec4(a_corner.x * 2.0 - 1.0, -a_corner.y, 0.0, 1.0);
}
`;

export const GRID_FRAGMENT = `precision highp float;
uniform vec2 u_origin;
uniform float u_scale;
// the grid's origin (logical window pixels) and its pitch on screen
uniform vec3 u_grid;
// 0 dots, 1 lines, 2 cross; then a mark's size on screen (logical)
uniform vec2 u_mark;
uniform vec4 u_color;
varying vec2 v_device;
float cover(float edge, float dist) {
  return clamp((edge - dist) * u_scale + 0.5, 0.0, 1.0);
}
void main() {
  vec2 logical = v_device / u_scale + u_origin;
  float step = u_grid.z;
  vec2 rel = logical - u_grid.xy;
  vec2 dist = abs(mod(rel + step * 0.5, step) - step * 0.5);
  float a;
  if (u_mark.x < 0.5) {
    float h = u_mark.y * 0.5;
    a = cover(h, dist.x) * cover(h, dist.y);
  } else if (u_mark.x < 1.5) {
    a = max(cover(0.5, dist.x), cover(0.5, dist.y));
  } else {
    float arm = u_mark.y;
    a = max(cover(0.5, dist.x) * cover(arm, dist.y),
            cover(0.5, dist.y) * cover(arm, dist.x));
  }
  if (a <= 0.0) discard;
  gl_FragColor = u_color * a;
}
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GL = any;

/** A linked program and its uniform locations, looked up once. */
export interface Program {
  program: unknown;
  uniforms: Record<string, unknown>;
}

function compile(gl: GL, type: number, source: string): unknown {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`@react-x11/components flow/gl: shader failed: ${log}`);
  }
  return shader;
}

/** Compile, bind the shared locations, link, and look the uniforms up. */
export function linkProgram(
  gl: GL,
  vertex: string,
  fragment: string,
  uniforms: readonly string[],
): Program {
  const program = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  for (const [name, location] of Object.entries(ATTRIBUTES)) {
    gl.bindAttribLocation(program, location, name);
  }
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`@react-x11/components flow/gl: link failed: ${log}`);
  }
  const found: Record<string, unknown> = {};
  for (const name of uniforms) {
    found[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms: found };
}
