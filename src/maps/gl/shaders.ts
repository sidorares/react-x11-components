// The GL renderer's four programs, and the one decision they share.
//
// Everything is **GLSL ES 1.00**: it is the one dialect both direct backends
// compile — Apple's GL 4.1 core accepts it through ARB_ES2_compatibility
// (x11-dri prepends the `#version 100` a core profile insists on), and every
// Linux GLES driver speaks it — so one source serves the Cocoa backend,
// XQuartz's Apple-DRI flavor and DRI3 alike.
//
// The shared decision is the vertex layout. Every program binds its
// attributes to the same five locations, so one vertex array object per
// *range of records* can feed whichever program draws that range:
//
//   0  a_corner  the static quad corner — `(0|1, -1|1)`, per vertex
//   1  a_p0      record i:     x, y                       (int16 × 2)
//   2  a_p1      record i + 1: x, y                       (int16 × 2)
//   3  a_x       record i:     the fan apex (fill stream, int16 × 2)
//                              or the distance along the line (float)
//   4  a_d1      record i + 1: the distance along the line (float)
//
// Locations 1-4 advance once per *instance* (divisor 1), so instance i is
// segment i of the stream and a polyline costs no memory beyond its points.
// A segment that touches a sentinel collapses to a point outside the clip
// volume — see `buckets.ts` for why sentinels beat an index buffer.

/** Where each attribute lives, shared by every program. Locations 5-9 are
 *  the label program's, one label per instance (see {@link LABEL_VERTEX}). */
export const ATTRIBUTES = {
  a_corner: 0,
  a_p0: 1,
  a_p1: 2,
  a_x: 3,
  a_d1: 4,
  a_anchor: 5,
  a_rect: 6,
  a_ink: 7,
  a_halo: 8,
  a_params: 9,
} as const;

const PRELUDE = `precision highp float;
attribute vec2 a_corner;
attribute vec2 a_p0;
attribute vec2 a_p1;
attribute vec2 a_x;
attribute float a_d1;
// device pixels per tile unit, then the tile's origin in device pixels
uniform vec3 u_tile;
uniform vec2 u_viewport;
vec4 clip(vec2 p) {
  return vec4(p.x / u_viewport.x * 2.0 - 1.0, 1.0 - p.y / u_viewport.y * 2.0, 0.0, 1.0);
}
bool broken() {
  return a_p0.x < -32767.5 || a_p1.x < -32767.5;
}
`;

/**
 * A segment as a capsule: the quad around it, widened by half the line
 * width plus a pixel of fringe, and shaded by distance to the segment.
 *
 * The distance function is what makes this worth doing on the GPU rather
 * than extruding on the CPU: clamping the pixel's position along the
 * segment before measuring gives **round caps and round joins for free** —
 * two consecutive capsules overlap in exactly the disc a round join is —
 * and the same number is the antialiasing ramp. Nothing about a join is
 * computed anywhere, so a road network costs its points and nothing else.
 *
 * What that costs is a translucent line: where two capsules overlap at a
 * join the colour would be laid down twice, a darker bead at every vertex.
 * So a translucent stroke is drawn a pixel at a time under the stencil, in
 * two parts (`u_part`): the pixels a capsule covers wholly, the first
 * capsule to reach one taking it, and then the antialiased fringe where
 * nothing has been drawn yet.
 */
export const LINE_VERTEX = `${PRELUDE}
uniform float u_half;
varying vec2 v_local;
varying float v_len;
varying float v_dist;
void main() {
  if (broken()) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 a = a_p0 * u_tile.x + u_tile.yz;
  vec2 b = a_p1 * u_tile.x + u_tile.yz;
  vec2 d = b - a;
  float len = length(d);
  vec2 t = len > 0.0001 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  float e = u_half + 1.0;
  float along = mix(-e, len + e, a_corner.x);
  float across = a_corner.y * e;
  v_local = vec2(along, across);
  v_len = len;
  v_dist = a_x.x * u_tile.x + along;
  gl_Position = clip(a + t * along + n * across);
}
`;

export const LINE_FRAGMENT = `precision highp float;
uniform vec4 u_color;
uniform float u_half;
// up to four dashes, on and off in turn, and the pattern's length — device
// pixels; a length of 0 is a solid line
uniform vec4 u_dash_a;
uniform vec4 u_dash_b;
uniform float u_period;
// 0: every pixel; 1: only those the capsule covers wholly; 2: only the rest
uniform float u_part;
varying vec2 v_local;
varying float v_len;
varying float v_dist;
// How much of the pixel at \`m\` along the pattern the dash from \`s\`, \`on\`
// long, covers — or its copy a pattern later, which the last pixels of a
// pattern are nearest to.
float dash(float m, float s, float on) {
  if (on <= 0.0) return 0.0;
  float here = min(m - s, s + on - m);
  float next = min(m - u_period - s, s + on - m + u_period);
  return clamp(max(here, next) + 0.5, 0.0, 1.0);
}
void main() {
  float x = clamp(v_local.x, 0.0, v_len);
  float dist = length(vec2(v_local.x - x, v_local.y));
  float alpha = clamp(u_half - dist + 0.5, 0.0, 1.0);
  if (u_period > 0.0) {
    float m = mod(v_dist, u_period);
    float s1 = u_dash_a.x + u_dash_a.y;
    float s2 = s1 + u_dash_a.z + u_dash_a.w;
    float s3 = s2 + u_dash_b.x + u_dash_b.y;
    alpha *= max(
      max(dash(m, 0.0, u_dash_a.x), dash(m, s1, u_dash_a.z)),
      max(dash(m, s2, u_dash_b.x), dash(m, s3, u_dash_b.z))
    );
  }
  if (u_part > 0.5 && (alpha < 1.0) == (u_part < 1.5)) discard;
  if (alpha <= 0.0) discard;
  gl_FragColor = u_color * alpha;
}
`;

/**
 * A fill edge as one triangle of its ring's fan: apex, p0, p1.
 *
 * Drawn into the stencil buffer only. A fan per ring, apex anywhere, covers
 * each pixel as many times as the ring winds around it, so incrementing on
 * one facing and decrementing on the other leaves the winding number behind
 * — non-zero is inside, which is a polygon with its holes cut, with no
 * triangulation anywhere. The quad corner picks the vertex: `(0,-1)` is the
 * apex, `(1,-1)` is p0 and `(0,1)` is p1.
 */
export const FAN_VERTEX = `${PRELUDE}
void main() {
  if (broken()) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float which = a_corner.x + a_corner.y + 1.0;
  vec2 q = which < 0.5 ? a_x : (which < 1.5 ? a_p0 : a_p1);
  gl_Position = clip(q * u_tile.x + u_tile.yz);
}
`;

export const FAN_FRAGMENT = `precision mediump float;
void main() {
  gl_FragColor = vec4(0.0);
}
`;

/** The viewport, filled where the stencil says a polygon is. */
export const COVER_VERTEX = `precision highp float;
attribute vec2 a_corner;
void main() {
  gl_Position = vec4(a_corner.x * 2.0 - 1.0, a_corner.y, 0.0, 1.0);
}
`;

export const COVER_FRAGMENT = `precision mediump float;
uniform vec4 u_color;
void main() {
  gl_FragColor = u_color;
}
`;

/** The offscreen frame, copied to the surface — only where the surface has
 *  no stencil buffer of its own. */
export const BLIT_VERTEX = `precision highp float;
attribute vec2 a_corner;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_corner.x, a_corner.y * 0.5 + 0.5);
  gl_Position = vec4(a_corner.x * 2.0 - 1.0, a_corner.y, 0.0, 1.0);
}
`;

export const BLIT_FRAGMENT = `precision mediump float;
uniform sampler2D u_image;
// 1 copies the frame; below 1 it is a level fading in over the one leaving,
// premultiplied for the ONE, ONE_MINUS_SRC_ALPHA blend
uniform float u_alpha;
varying vec2 v_uv;
void main() {
  gl_FragColor = texture2D(u_image, v_uv) * u_alpha;
}
`;

/**
 * A label: its raster from the atlas as one quad, centred on the anchor and
 * turned to the baseline — which is all a label needs, because placement
 * only ever sets a line label on a straight stretch.
 *
 * A level label is set on **whole pixels**, texel for pixel, so the text is
 * exactly as crisp as the text engine made it; a slanted one is sampled
 * bilinearly, as rotated type always is. The quad is the raster less an
 * inset (`u_inset`): the raster's clear margin is wide enough for a halo to
 * grow into, and the inset is what keeps the halo's samples from reaching
 * past the margin into a neighbouring label.
 */
export const LABEL_VERTEX = `precision highp float;
attribute vec2 a_corner;
// centre (device pixels), then cos and sin of the baseline
attribute vec4 a_anchor;
// the raster in the atlas: x, y, width, height in texels, margin included
attribute vec4 a_rect;
attribute vec4 a_ink;
attribute vec4 a_halo;
// halo radius in pixels, and 1 to set the label on whole pixels
attribute vec2 a_params;
uniform vec2 u_viewport;
uniform vec2 u_atlas;
uniform float u_inset;
varying vec2 v_uv;
varying vec4 v_ink;
varying vec4 v_halo;
varying float v_radius;
void main() {
  vec2 corner = vec2(a_corner.x, a_corner.y * 0.5 + 0.5);
  vec2 size = a_rect.zw - 2.0 * u_inset;
  vec2 p;
  if (a_params.y > 0.5) {
    p = floor(a_anchor.xy - size * 0.5 + 0.5) + corner * size;
  } else {
    vec2 local = (corner - 0.5) * size;
    vec2 axis = a_anchor.zw;
    p = a_anchor.xy + vec2(local.x * axis.x - local.y * axis.y,
                           local.x * axis.y + local.y * axis.x);
  }
  v_uv = (a_rect.xy + u_inset + corner * size) / u_atlas;
  v_ink = a_ink;
  v_halo = a_halo;
  v_radius = a_params.x;
  gl_Position = vec4(p.x / u_viewport.x * 2.0 - 1.0, 1.0 - p.y / u_viewport.y * 2.0, 0.0, 1.0);
}
`;

/**
 * Coverage in, colour out: the ink where the glyphs are, and under it a
 * halo — the coverage *dilated* by the halo's radius, as the greatest
 * coverage on two rings of samples around the pixel. Dilating here rather
 * than when rasterizing is what lets one raster serve every halo width and
 * colour a style asks for; the samples cost nothing next to the few
 * thousand pixels a frame's labels cover.
 */
export const LABEL_FRAGMENT = `precision highp float;
uniform sampler2D u_image;
uniform vec2 u_atlas;
varying vec2 v_uv;
varying vec4 v_ink;
varying vec4 v_halo;
varying float v_radius;
void main() {
  float ink = texture2D(u_image, v_uv).a;
  float halo = ink;
  if (v_radius > 0.0) {
    vec2 reach = vec2(v_radius) / u_atlas;
    for (int i = 0; i < 16; i++) {
      float a = float(i) * 0.3926991;
      vec2 d = vec2(cos(a), sin(a)) * reach;
      halo = max(halo, texture2D(u_image, v_uv + d).a);
      halo = max(halo, texture2D(u_image, v_uv + d * 0.5).a);
    }
  }
  vec4 color = v_ink * ink + v_halo * (halo * (1.0 - ink));
  if (color.a <= 0.0) discard;
  gl_FragColor = color;
}
`;

/**
 * A marker: a quad around it, instanced. Its outline is computed per pixel
 * (`MARKER_FRAGMENT`), so the quad is only big enough to hold the shape, its
 * ring and a pixel of coverage.
 */
export const MARKER_VERTEX = `precision highp float;
attribute vec2 a_corner;
// the point marked (device pixels) — a pin's tip, a disc's centre — the
// head's radius, and how far above the point the head's centre is: 0 for a
// disc
attribute vec4 a_anchor;
// the fill and the ring, premultiplied
attribute vec4 a_ink;
attribute vec4 a_halo;
// the ring's width in pixels
attribute vec2 a_params;
uniform vec2 u_viewport;
varying vec2 v_local;
varying vec4 v_fill;
varying vec4 v_ring;
varying vec3 v_shape;
void main() {
  float r = a_anchor.z;
  float d = a_anchor.w;
  vec2 centre = a_anchor.xy - vec2(0.0, d);
  float m = a_params.x * 0.5 + 1.0;
  vec2 lo = centre - vec2(r + m);
  vec2 hi = centre + vec2(r + m, max(r, d) + m);
  vec2 p = mix(lo, hi, vec2(a_corner.x, a_corner.y * 0.5 + 0.5));
  v_local = p - centre;
  v_fill = a_ink;
  v_ring = a_halo;
  v_shape = vec3(r, d, a_params.x * 0.5);
  gl_Position = vec4(p.x / u_viewport.x * 2.0 - 1.0, 1.0 - p.y / u_viewport.y * 2.0, 0.0, 1.0);
}
`;

/**
 * A marker's pixels: the signed distance to its outline, and from it the
 * fill inside and the ring over it — a stroke centred on the outline, which
 * is how the retained renderer fills its path and then strokes it. The
 * outline is a disc, or a pin's teardrop: the hull of the head and a point
 * below it, which is Inigo Quilez's uneven capsule with a second radius of
 * zero — its straight sides tangent to the head where the retained
 * renderer's are.
 */
export const MARKER_FRAGMENT = `precision highp float;
varying vec2 v_local;
varying vec4 v_fill;
varying vec4 v_ring;
varying vec3 v_shape;
float outline(vec2 p, float r, float d) {
  if (d <= r) return length(p) - r;
  p.x = abs(p.x);
  float b = r / d;
  float a = sqrt(1.0 - b * b);
  float k = dot(p, vec2(-b, a));
  if (k < 0.0) return length(p) - r;
  if (k > a * d) return length(p - vec2(0.0, d));
  return dot(p, vec2(a, b)) - r;
}
void main() {
  float dist = outline(v_local, v_shape.x, v_shape.y);
  float fill = clamp(0.5 - dist, 0.0, 1.0);
  float ring = clamp(v_shape.z + 0.5 - abs(dist), 0.0, 1.0);
  vec4 stroke = v_ring * ring;
  vec4 color = stroke + v_fill * (fill * (1.0 - stroke.a));
  if (color.a <= 0.0) discard;
  gl_FragColor = color;
}
`;

/**
 * A circle layer's point as a disc: a quad around it, instanced over the
 * layer's records. Only `a_p0` is read — a point is one record, and the
 * sentinel after a range's last point is `a_p1` of nothing drawn.
 */
export const CIRCLE_VERTEX = `${PRELUDE}
uniform float u_radius;
uniform float u_stroke;
varying vec2 v_local;
void main() {
  if (a_p0.x < -32767.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 centre = a_p0 * u_tile.x + u_tile.yz;
  float e = u_radius + u_stroke * 0.5 + 1.0;
  v_local = vec2(a_corner.x * 2.0 - 1.0, a_corner.y) * e;
  gl_Position = clip(centre + v_local);
}
`;

/** The disc's pixels: the fill inside, and a stroke centred on the edge
 *  over it — `paint.ts` fills a circle's path and then strokes it. */
export const CIRCLE_FRAGMENT = `precision highp float;
uniform vec4 u_color;
uniform vec4 u_stroke_color;
uniform float u_radius;
uniform float u_stroke;
varying vec2 v_local;
void main() {
  float dist = length(v_local) - u_radius;
  float fill = clamp(0.5 - dist, 0.0, 1.0);
  float ring = u_stroke > 0.0
    ? clamp(u_stroke * 0.5 + 0.5 - abs(dist), 0.0, 1.0)
    : 0.0;
  vec4 stroke = u_stroke_color * ring;
  vec4 color = stroke + u_color * (fill * (1.0 - stroke.a));
  if (color.a <= 0.0) discard;
  gl_FragColor = color;
}
`;

/**
 * A raster tile: its image over its square — the data tile's, which past
 * the source's depth is larger than the cell it is drawn for — and a
 * scissor clipping it to that cell. A pixel past every edge, so two squares
 * that share an edge leave no gap; the scissor crops it and the image
 * clamps to it.
 */
export const RASTER_VERTEX = `precision highp float;
attribute vec2 a_corner;
// the square's size, then its top-left corner — device pixels
uniform vec3 u_tile;
uniform vec2 u_viewport;
varying vec2 v_uv;
void main() {
  vec2 corner = vec2(a_corner.x, a_corner.y * 0.5 + 0.5);
  vec2 p = u_tile.yz - 1.0 + corner * (u_tile.x + 2.0);
  v_uv = (p - u_tile.yz) / u_tile.x;
  gl_Position = vec4(p.x / u_viewport.x * 2.0 - 1.0, 1.0 - p.y / u_viewport.y * 2.0, 0.0, 1.0);
}
`;

/** An image as a source decodes one — not premultiplied — onto a frame
 *  that is. */
export const RASTER_FRAGMENT = `precision mediump float;
uniform sampler2D u_image;
varying vec2 v_uv;
void main() {
  vec4 c = texture2D(u_image, v_uv);
  gl_FragColor = vec4(c.rgb * c.a, c.a);
}
`;

/* The GL table is WebGL-shaped (x11-dri's camelCase), typed loosely on
 * purpose — the same reason `src/three/renderer-direct.ts` gives. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GL = any;

/** A linked program and its uniform locations, looked up once. */
export interface Program {
  program: unknown;
  uniforms: Record<string, unknown>;
}

function compileShader(gl: GL, type: number, source: string): unknown {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`@react-x11/components maps/gl: shader failed: ${log}`);
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
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertex);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragment);
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
    throw new Error(`@react-x11/components maps/gl: link failed: ${log}`);
  }
  const found: Record<string, unknown> = {};
  for (const name of uniforms)
    found[name] = gl.getUniformLocation(program, name);
  return { program, uniforms: found };
}
