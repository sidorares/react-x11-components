// A `<canvas>`'s WebGL context, as a page's scripts see it: every
// interface WebGL 1 and 2 define, of the page's own classes, over a context
// that keeps the state a page sets and reads back, and draws nothing unless
// the host handed in something that draws (`HtmlScripts.webgl`, the end of
// this file).
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing, and `installDom` is handed it and calls it.
//
// Why a context that draws nothing rather than none. A browser has WebGL
// wherever it has a canvas — Chrome falls back to a renderer of its own in
// software (SwiftShader) where there is no GPU — so a page is written for a
// context that is there: up.com.au's react-three-fiber scene throws from
// its first commit where `getContext('webgl2')` is null, and React takes
// the whole page down with it, which is what Chrome does too with WebGL
// turned off. Answered, the scene is a transparent box and the page around
// it is the page. What a page cannot tell from a context that draws is
// little: a shader compiles and a program links (with no active uniforms or
// attributes), a framebuffer is complete, `readPixels` reads zeros, a query
// and a fence are done at once, and no extension is offered. The cost is
// the page that tests for WebGL and has a fallback: it shows the empty
// canvas rather than its picture. A 2d context draws a path and text as
// nothing too (`dom.ts`, `CanvasRenderingContext2D`), for the same reason.

/** What `installDom` is handed back: the interfaces, for the global, and a
 *  canvas's context of a kind. */
export interface WebGLInstall {
  classes: Record<string, unknown>;
  context(canvas: unknown, kind: 'webgl' | 'webgl2', options: unknown): unknown;
  /** The canvas took a new size, which is its drawing buffer's. */
  resized(context: unknown): void;
  /** The drawing buffer as an image: top down and straight, or null where
   *  no GL holds any. */
  pixels(
    context: unknown,
  ): { width: number; height: number; data: Uint8ClampedArray } | null;
}

// the page's, as `dom.ts`'s are: this runs in its context
declare const queueMicrotask: (fn: () => void) => void;

/** What a context asks of the realm around it. */
export interface WebGLHost {
  /** Asks the host (`gl…`, `gl.ts`): a primitive each way. */
  call(op: string, a?: unknown, b?: unknown, c?: unknown): unknown;
  base64(bytes: Uint8Array): string;
  bytes(base64: string): Uint8Array;
  /** The canvas as the host numbers it: null for one that is no element. */
  id(canvas: unknown): number | null;
  /** A source's pixels, for `texImage2D`: straight RGBA, or null where the
   *  realm has none of it. */
  pixelsOf(
    source: unknown,
  ): { width: number; height: number; data: Uint8Array } | null;
}

export function installWebGL(Event: unknown, host: WebGLHost): WebGLInstall {
  'use strict';
  type Any = any;

  // --- the constants ----------------------------------------------------------

  // Each interface's constants as Chrome's prototypes have them, in hex:
  // WebGL 1's, which WebGL 2 has as well, and WebGL 2's own.
  const WEBGL1 = [
    'DEPTH_BUFFER_BIT=100 STENCIL_BUFFER_BIT=400 COLOR_BUFFER_BIT=4000',
    'POINTS=0 LINES=1 LINE_LOOP=2 LINE_STRIP=3 TRIANGLES=4 TRIANGLE_STRIP=5',
    'TRIANGLE_FAN=6 ZERO=0 ONE=1 SRC_COLOR=300 ONE_MINUS_SRC_COLOR=301',
    'SRC_ALPHA=302 ONE_MINUS_SRC_ALPHA=303 DST_ALPHA=304',
    'ONE_MINUS_DST_ALPHA=305 DST_COLOR=306 ONE_MINUS_DST_COLOR=307',
    'SRC_ALPHA_SATURATE=308 FUNC_ADD=8006 BLEND_EQUATION=8009',
    'BLEND_EQUATION_RGB=8009 BLEND_EQUATION_ALPHA=883d FUNC_SUBTRACT=800a',
    'FUNC_REVERSE_SUBTRACT=800b BLEND_DST_RGB=80c8 BLEND_SRC_RGB=80c9',
    'BLEND_DST_ALPHA=80ca BLEND_SRC_ALPHA=80cb CONSTANT_COLOR=8001',
    'ONE_MINUS_CONSTANT_COLOR=8002 CONSTANT_ALPHA=8003',
    'ONE_MINUS_CONSTANT_ALPHA=8004 BLEND_COLOR=8005 ARRAY_BUFFER=8892',
    'ELEMENT_ARRAY_BUFFER=8893 ARRAY_BUFFER_BINDING=8894',
    'ELEMENT_ARRAY_BUFFER_BINDING=8895 STREAM_DRAW=88e0 STATIC_DRAW=88e4',
    'DYNAMIC_DRAW=88e8 BUFFER_SIZE=8764 BUFFER_USAGE=8765',
    'CURRENT_VERTEX_ATTRIB=8626 FRONT=404 BACK=405 FRONT_AND_BACK=408',
    'TEXTURE_2D=de1 CULL_FACE=b44 BLEND=be2 DITHER=bd0 STENCIL_TEST=b90',
    'DEPTH_TEST=b71 SCISSOR_TEST=c11 POLYGON_OFFSET_FILL=8037',
    'SAMPLE_ALPHA_TO_COVERAGE=809e SAMPLE_COVERAGE=80a0 NO_ERROR=0',
    'INVALID_ENUM=500 INVALID_VALUE=501 INVALID_OPERATION=502',
    'OUT_OF_MEMORY=505 CW=900 CCW=901 LINE_WIDTH=b21',
    'ALIASED_POINT_SIZE_RANGE=846d ALIASED_LINE_WIDTH_RANGE=846e',
    'CULL_FACE_MODE=b45 FRONT_FACE=b46 DEPTH_RANGE=b70 DEPTH_WRITEMASK=b72',
    'DEPTH_CLEAR_VALUE=b73 DEPTH_FUNC=b74 STENCIL_CLEAR_VALUE=b91',
    'STENCIL_FUNC=b92 STENCIL_FAIL=b94 STENCIL_PASS_DEPTH_FAIL=b95',
    'STENCIL_PASS_DEPTH_PASS=b96 STENCIL_REF=b97 STENCIL_VALUE_MASK=b93',
    'STENCIL_WRITEMASK=b98 STENCIL_BACK_FUNC=8800 STENCIL_BACK_FAIL=8801',
    'STENCIL_BACK_PASS_DEPTH_FAIL=8802 STENCIL_BACK_PASS_DEPTH_PASS=8803',
    'STENCIL_BACK_REF=8ca3 STENCIL_BACK_VALUE_MASK=8ca4',
    'STENCIL_BACK_WRITEMASK=8ca5 VIEWPORT=ba2 SCISSOR_BOX=c10',
    'COLOR_CLEAR_VALUE=c22 COLOR_WRITEMASK=c23 UNPACK_ALIGNMENT=cf5',
    'PACK_ALIGNMENT=d05 MAX_TEXTURE_SIZE=d33 MAX_VIEWPORT_DIMS=d3a',
    'SUBPIXEL_BITS=d50 RED_BITS=d52 GREEN_BITS=d53 BLUE_BITS=d54',
    'ALPHA_BITS=d55 DEPTH_BITS=d56 STENCIL_BITS=d57',
    'POLYGON_OFFSET_UNITS=2a00 POLYGON_OFFSET_FACTOR=8038',
    'TEXTURE_BINDING_2D=8069 SAMPLE_BUFFERS=80a8 SAMPLES=80a9',
    'SAMPLE_COVERAGE_VALUE=80aa SAMPLE_COVERAGE_INVERT=80ab',
    'COMPRESSED_TEXTURE_FORMATS=86a3 DONT_CARE=1100 FASTEST=1101',
    'NICEST=1102 GENERATE_MIPMAP_HINT=8192 BYTE=1400 UNSIGNED_BYTE=1401',
    'SHORT=1402 UNSIGNED_SHORT=1403 INT=1404 UNSIGNED_INT=1405 FLOAT=1406',
    'DEPTH_COMPONENT=1902 ALPHA=1906 RGB=1907 RGBA=1908 LUMINANCE=1909',
    'LUMINANCE_ALPHA=190a UNSIGNED_SHORT_4_4_4_4=8033',
    'UNSIGNED_SHORT_5_5_5_1=8034 UNSIGNED_SHORT_5_6_5=8363',
    'FRAGMENT_SHADER=8b30 VERTEX_SHADER=8b31 MAX_VERTEX_ATTRIBS=8869',
    'MAX_VERTEX_UNIFORM_VECTORS=8dfb MAX_VARYING_VECTORS=8dfc',
    'MAX_COMBINED_TEXTURE_IMAGE_UNITS=8b4d',
    'MAX_VERTEX_TEXTURE_IMAGE_UNITS=8b4c MAX_TEXTURE_IMAGE_UNITS=8872',
    'MAX_FRAGMENT_UNIFORM_VECTORS=8dfd SHADER_TYPE=8b4f DELETE_STATUS=8b80',
    'LINK_STATUS=8b82 VALIDATE_STATUS=8b83 ATTACHED_SHADERS=8b85',
    'ACTIVE_UNIFORMS=8b86 ACTIVE_ATTRIBUTES=8b89',
    'SHADING_LANGUAGE_VERSION=8b8c CURRENT_PROGRAM=8b8d NEVER=200 LESS=201',
    'EQUAL=202 LEQUAL=203 GREATER=204 NOTEQUAL=205 GEQUAL=206 ALWAYS=207',
    'KEEP=1e00 REPLACE=1e01 INCR=1e02 DECR=1e03 INVERT=150a INCR_WRAP=8507',
    'DECR_WRAP=8508 VENDOR=1f00 RENDERER=1f01 VERSION=1f02 NEAREST=2600',
    'LINEAR=2601 NEAREST_MIPMAP_NEAREST=2700 LINEAR_MIPMAP_NEAREST=2701',
    'NEAREST_MIPMAP_LINEAR=2702 LINEAR_MIPMAP_LINEAR=2703',
    'TEXTURE_MAG_FILTER=2800 TEXTURE_MIN_FILTER=2801 TEXTURE_WRAP_S=2802',
    'TEXTURE_WRAP_T=2803 TEXTURE=1702 TEXTURE_CUBE_MAP=8513',
    'TEXTURE_BINDING_CUBE_MAP=8514 TEXTURE_CUBE_MAP_POSITIVE_X=8515',
    'TEXTURE_CUBE_MAP_NEGATIVE_X=8516 TEXTURE_CUBE_MAP_POSITIVE_Y=8517',
    'TEXTURE_CUBE_MAP_NEGATIVE_Y=8518 TEXTURE_CUBE_MAP_POSITIVE_Z=8519',
    'TEXTURE_CUBE_MAP_NEGATIVE_Z=851a MAX_CUBE_MAP_TEXTURE_SIZE=851c',
    'TEXTURE0=84c0 TEXTURE1=84c1 TEXTURE2=84c2 TEXTURE3=84c3 TEXTURE4=84c4',
    'TEXTURE5=84c5 TEXTURE6=84c6 TEXTURE7=84c7 TEXTURE8=84c8 TEXTURE9=84c9',
    'TEXTURE10=84ca TEXTURE11=84cb TEXTURE12=84cc TEXTURE13=84cd',
    'TEXTURE14=84ce TEXTURE15=84cf TEXTURE16=84d0 TEXTURE17=84d1',
    'TEXTURE18=84d2 TEXTURE19=84d3 TEXTURE20=84d4 TEXTURE21=84d5',
    'TEXTURE22=84d6 TEXTURE23=84d7 TEXTURE24=84d8 TEXTURE25=84d9',
    'TEXTURE26=84da TEXTURE27=84db TEXTURE28=84dc TEXTURE29=84dd',
    'TEXTURE30=84de TEXTURE31=84df ACTIVE_TEXTURE=84e0 REPEAT=2901',
    'CLAMP_TO_EDGE=812f MIRRORED_REPEAT=8370 FLOAT_VEC2=8b50',
    'FLOAT_VEC3=8b51 FLOAT_VEC4=8b52 INT_VEC2=8b53 INT_VEC3=8b54',
    'INT_VEC4=8b55 BOOL=8b56 BOOL_VEC2=8b57 BOOL_VEC3=8b58 BOOL_VEC4=8b59',
    'FLOAT_MAT2=8b5a FLOAT_MAT3=8b5b FLOAT_MAT4=8b5c SAMPLER_2D=8b5e',
    'SAMPLER_CUBE=8b60 VERTEX_ATTRIB_ARRAY_ENABLED=8622',
    'VERTEX_ATTRIB_ARRAY_SIZE=8623 VERTEX_ATTRIB_ARRAY_STRIDE=8624',
    'VERTEX_ATTRIB_ARRAY_TYPE=8625 VERTEX_ATTRIB_ARRAY_NORMALIZED=886a',
    'VERTEX_ATTRIB_ARRAY_POINTER=8645',
    'VERTEX_ATTRIB_ARRAY_BUFFER_BINDING=889f',
    'IMPLEMENTATION_COLOR_READ_TYPE=8b9a',
    'IMPLEMENTATION_COLOR_READ_FORMAT=8b9b COMPILE_STATUS=8b81',
    'LOW_FLOAT=8df0 MEDIUM_FLOAT=8df1 HIGH_FLOAT=8df2 LOW_INT=8df3',
    'MEDIUM_INT=8df4 HIGH_INT=8df5 FRAMEBUFFER=8d40 RENDERBUFFER=8d41',
    'RGBA4=8056 RGB5_A1=8057 RGB565=8d62 DEPTH_COMPONENT16=81a5',
    'STENCIL_INDEX8=8d48 DEPTH_STENCIL=84f9 RENDERBUFFER_WIDTH=8d42',
    'RENDERBUFFER_HEIGHT=8d43 RENDERBUFFER_INTERNAL_FORMAT=8d44',
    'RENDERBUFFER_RED_SIZE=8d50 RENDERBUFFER_GREEN_SIZE=8d51',
    'RENDERBUFFER_BLUE_SIZE=8d52 RENDERBUFFER_ALPHA_SIZE=8d53',
    'RENDERBUFFER_DEPTH_SIZE=8d54 RENDERBUFFER_STENCIL_SIZE=8d55',
    'FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE=8cd0',
    'FRAMEBUFFER_ATTACHMENT_OBJECT_NAME=8cd1',
    'FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL=8cd2',
    'FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE=8cd3',
    'COLOR_ATTACHMENT0=8ce0 DEPTH_ATTACHMENT=8d00 STENCIL_ATTACHMENT=8d20',
    'DEPTH_STENCIL_ATTACHMENT=821a NONE=0 FRAMEBUFFER_COMPLETE=8cd5',
    'FRAMEBUFFER_INCOMPLETE_ATTACHMENT=8cd6',
    'FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT=8cd7',
    'FRAMEBUFFER_INCOMPLETE_DIMENSIONS=8cd9 FRAMEBUFFER_UNSUPPORTED=8cdd',
    'FRAMEBUFFER_BINDING=8ca6 RENDERBUFFER_BINDING=8ca7',
    'MAX_RENDERBUFFER_SIZE=84e8 INVALID_FRAMEBUFFER_OPERATION=506',
    'UNPACK_FLIP_Y_WEBGL=9240 UNPACK_PREMULTIPLY_ALPHA_WEBGL=9241',
    'CONTEXT_LOST_WEBGL=9242 UNPACK_COLORSPACE_CONVERSION_WEBGL=9243',
    'BROWSER_DEFAULT_WEBGL=9244 RGB8=8051 RGBA8=8058',
  ];
  const WEBGL2 = [
    'READ_BUFFER=c02 UNPACK_ROW_LENGTH=cf2 UNPACK_SKIP_ROWS=cf3',
    'UNPACK_SKIP_PIXELS=cf4 PACK_ROW_LENGTH=d02 PACK_SKIP_ROWS=d03',
    'PACK_SKIP_PIXELS=d04 COLOR=1800 DEPTH=1801 STENCIL=1802 RED=1903',
    'RGB10_A2=8059 TEXTURE_BINDING_3D=806a UNPACK_SKIP_IMAGES=806d',
    'UNPACK_IMAGE_HEIGHT=806e TEXTURE_3D=806f TEXTURE_WRAP_R=8072',
    'MAX_3D_TEXTURE_SIZE=8073 UNSIGNED_INT_2_10_10_10_REV=8368',
    'MAX_ELEMENTS_VERTICES=80e8 MAX_ELEMENTS_INDICES=80e9',
    'TEXTURE_MIN_LOD=813a TEXTURE_MAX_LOD=813b TEXTURE_BASE_LEVEL=813c',
    'TEXTURE_MAX_LEVEL=813d MIN=8007 MAX=8008 DEPTH_COMPONENT24=81a6',
    'MAX_TEXTURE_LOD_BIAS=84fd TEXTURE_COMPARE_MODE=884c',
    'TEXTURE_COMPARE_FUNC=884d CURRENT_QUERY=8865 QUERY_RESULT=8866',
    'QUERY_RESULT_AVAILABLE=8867 STREAM_READ=88e1 STREAM_COPY=88e2',
    'STATIC_READ=88e5 STATIC_COPY=88e6 DYNAMIC_READ=88e9 DYNAMIC_COPY=88ea',
    'MAX_DRAW_BUFFERS=8824 DRAW_BUFFER0=8825 DRAW_BUFFER1=8826',
    'DRAW_BUFFER2=8827 DRAW_BUFFER3=8828 DRAW_BUFFER4=8829',
    'DRAW_BUFFER5=882a DRAW_BUFFER6=882b DRAW_BUFFER7=882c',
    'DRAW_BUFFER8=882d DRAW_BUFFER9=882e DRAW_BUFFER10=882f',
    'DRAW_BUFFER11=8830 DRAW_BUFFER12=8831 DRAW_BUFFER13=8832',
    'DRAW_BUFFER14=8833 DRAW_BUFFER15=8834',
    'MAX_FRAGMENT_UNIFORM_COMPONENTS=8b49',
    'MAX_VERTEX_UNIFORM_COMPONENTS=8b4a SAMPLER_3D=8b5f',
    'SAMPLER_2D_SHADOW=8b62 FRAGMENT_SHADER_DERIVATIVE_HINT=8b8b',
    'PIXEL_PACK_BUFFER=88eb PIXEL_UNPACK_BUFFER=88ec',
    'PIXEL_PACK_BUFFER_BINDING=88ed PIXEL_UNPACK_BUFFER_BINDING=88ef',
    'SRGB=8c40 SRGB8=8c41 SRGB8_ALPHA8=8c43 COMPARE_REF_TO_TEXTURE=884e',
    'RGBA32F=8814 RGB32F=8815 RGBA16F=881a RGB16F=881b',
    'VERTEX_ATTRIB_ARRAY_INTEGER=88fd MAX_ARRAY_TEXTURE_LAYERS=88ff',
    'MIN_PROGRAM_TEXEL_OFFSET=8904 MAX_PROGRAM_TEXEL_OFFSET=8905',
    'MAX_VARYING_COMPONENTS=8b4b TEXTURE_2D_ARRAY=8c1a',
    'TEXTURE_BINDING_2D_ARRAY=8c1d R11F_G11F_B10F=8c3a',
    'UNSIGNED_INT_10F_11F_11F_REV=8c3b RGB9_E5=8c3d',
    'UNSIGNED_INT_5_9_9_9_REV=8c3e TRANSFORM_FEEDBACK_BUFFER_MODE=8c7f',
    'MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS=8c80',
    'TRANSFORM_FEEDBACK_VARYINGS=8c83 TRANSFORM_FEEDBACK_BUFFER_START=8c84',
    'TRANSFORM_FEEDBACK_BUFFER_SIZE=8c85',
    'TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN=8c88 RASTERIZER_DISCARD=8c89',
    'MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS=8c8a',
    'MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS=8c8b INTERLEAVED_ATTRIBS=8c8c',
    'SEPARATE_ATTRIBS=8c8d TRANSFORM_FEEDBACK_BUFFER=8c8e',
    'TRANSFORM_FEEDBACK_BUFFER_BINDING=8c8f RGBA32UI=8d70 RGB32UI=8d71',
    'RGBA16UI=8d76 RGB16UI=8d77 RGBA8UI=8d7c RGB8UI=8d7d RGBA32I=8d82',
    'RGB32I=8d83 RGBA16I=8d88 RGB16I=8d89 RGBA8I=8d8e RGB8I=8d8f',
    'RED_INTEGER=8d94 RGB_INTEGER=8d98 RGBA_INTEGER=8d99',
    'SAMPLER_2D_ARRAY=8dc1 SAMPLER_2D_ARRAY_SHADOW=8dc4',
    'SAMPLER_CUBE_SHADOW=8dc5 UNSIGNED_INT_VEC2=8dc6 UNSIGNED_INT_VEC3=8dc7',
    'UNSIGNED_INT_VEC4=8dc8 INT_SAMPLER_2D=8dca INT_SAMPLER_3D=8dcb',
    'INT_SAMPLER_CUBE=8dcc INT_SAMPLER_2D_ARRAY=8dcf',
    'UNSIGNED_INT_SAMPLER_2D=8dd2 UNSIGNED_INT_SAMPLER_3D=8dd3',
    'UNSIGNED_INT_SAMPLER_CUBE=8dd4 UNSIGNED_INT_SAMPLER_2D_ARRAY=8dd7',
    'DEPTH_COMPONENT32F=8cac DEPTH32F_STENCIL8=8cad',
    'FLOAT_32_UNSIGNED_INT_24_8_REV=8dad',
    'FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING=8210',
    'FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE=8211',
    'FRAMEBUFFER_ATTACHMENT_RED_SIZE=8212',
    'FRAMEBUFFER_ATTACHMENT_GREEN_SIZE=8213',
    'FRAMEBUFFER_ATTACHMENT_BLUE_SIZE=8214',
    'FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE=8215',
    'FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE=8216',
    'FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE=8217 FRAMEBUFFER_DEFAULT=8218',
    'UNSIGNED_INT_24_8=84fa DEPTH24_STENCIL8=88f0 UNSIGNED_NORMALIZED=8c17',
    'DRAW_FRAMEBUFFER_BINDING=8ca6 READ_FRAMEBUFFER=8ca8',
    'DRAW_FRAMEBUFFER=8ca9 READ_FRAMEBUFFER_BINDING=8caa',
    'RENDERBUFFER_SAMPLES=8cab FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER=8cd4',
    'MAX_COLOR_ATTACHMENTS=8cdf COLOR_ATTACHMENT1=8ce1',
    'COLOR_ATTACHMENT2=8ce2 COLOR_ATTACHMENT3=8ce3 COLOR_ATTACHMENT4=8ce4',
    'COLOR_ATTACHMENT5=8ce5 COLOR_ATTACHMENT6=8ce6 COLOR_ATTACHMENT7=8ce7',
    'COLOR_ATTACHMENT8=8ce8 COLOR_ATTACHMENT9=8ce9 COLOR_ATTACHMENT10=8cea',
    'COLOR_ATTACHMENT11=8ceb COLOR_ATTACHMENT12=8cec',
    'COLOR_ATTACHMENT13=8ced COLOR_ATTACHMENT14=8cee',
    'COLOR_ATTACHMENT15=8cef FRAMEBUFFER_INCOMPLETE_MULTISAMPLE=8d56',
    'MAX_SAMPLES=8d57 HALF_FLOAT=140b RG=8227 RG_INTEGER=8228 R8=8229',
    'RG8=822b R16F=822d R32F=822e RG16F=822f RG32F=8230 R8I=8231 R8UI=8232',
    'R16I=8233 R16UI=8234 R32I=8235 R32UI=8236 RG8I=8237 RG8UI=8238',
    'RG16I=8239 RG16UI=823a RG32I=823b RG32UI=823c',
    'VERTEX_ARRAY_BINDING=85b5 R8_SNORM=8f94 RG8_SNORM=8f95 RGB8_SNORM=8f96',
    'RGBA8_SNORM=8f97 SIGNED_NORMALIZED=8f9c COPY_READ_BUFFER=8f36',
    'COPY_WRITE_BUFFER=8f37 COPY_READ_BUFFER_BINDING=8f36',
    'COPY_WRITE_BUFFER_BINDING=8f37 UNIFORM_BUFFER=8a11',
    'UNIFORM_BUFFER_BINDING=8a28 UNIFORM_BUFFER_START=8a29',
    'UNIFORM_BUFFER_SIZE=8a2a MAX_VERTEX_UNIFORM_BLOCKS=8a2b',
    'MAX_FRAGMENT_UNIFORM_BLOCKS=8a2d MAX_COMBINED_UNIFORM_BLOCKS=8a2e',
    'MAX_UNIFORM_BUFFER_BINDINGS=8a2f MAX_UNIFORM_BLOCK_SIZE=8a30',
    'MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS=8a31',
    'MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS=8a33',
    'UNIFORM_BUFFER_OFFSET_ALIGNMENT=8a34 ACTIVE_UNIFORM_BLOCKS=8a36',
    'UNIFORM_TYPE=8a37 UNIFORM_SIZE=8a38 UNIFORM_BLOCK_INDEX=8a3a',
    'UNIFORM_OFFSET=8a3b UNIFORM_ARRAY_STRIDE=8a3c',
    'UNIFORM_MATRIX_STRIDE=8a3d UNIFORM_IS_ROW_MAJOR=8a3e',
    'UNIFORM_BLOCK_BINDING=8a3f UNIFORM_BLOCK_DATA_SIZE=8a40',
    'UNIFORM_BLOCK_ACTIVE_UNIFORMS=8a42',
    'UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES=8a43',
    'UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER=8a44',
    'UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER=8a46',
    'INVALID_INDEX=ffffffff MAX_VERTEX_OUTPUT_COMPONENTS=9122',
    'MAX_FRAGMENT_INPUT_COMPONENTS=9125 MAX_SERVER_WAIT_TIMEOUT=9111',
    'OBJECT_TYPE=9112 SYNC_CONDITION=9113 SYNC_STATUS=9114 SYNC_FLAGS=9115',
    'SYNC_FENCE=9116 SYNC_GPU_COMMANDS_COMPLETE=9117 UNSIGNALED=9118',
    'SIGNALED=9119 ALREADY_SIGNALED=911a TIMEOUT_EXPIRED=911b',
    'CONDITION_SATISFIED=911c WAIT_FAILED=911d SYNC_FLUSH_COMMANDS_BIT=1',
    'VERTEX_ATTRIB_ARRAY_DIVISOR=88fe ANY_SAMPLES_PASSED=8c2f',
    'ANY_SAMPLES_PASSED_CONSERVATIVE=8d6a SAMPLER_BINDING=8919',
    'RGB10_A2UI=906f INT_2_10_10_10_REV=8d9f TRANSFORM_FEEDBACK=8e22',
    'TRANSFORM_FEEDBACK_PAUSED=8e23 TRANSFORM_FEEDBACK_ACTIVE=8e24',
    'TRANSFORM_FEEDBACK_BINDING=8e25 TEXTURE_IMMUTABLE_FORMAT=912f',
    'MAX_ELEMENT_INDEX=8d6b TEXTURE_IMMUTABLE_LEVELS=82df',
    'TIMEOUT_IGNORED=-1 MAX_CLIENT_WAIT_TIMEOUT_WEBGL=9247',
  ];
  const constantsOf = (lines: string[]): [string, number][] =>
    lines.flatMap((line) =>
      line.split(' ').map((pair): [string, number] => {
        const at = pair.indexOf('=');
        return [pair.slice(0, at), parseInt(pair.slice(at + 1), 16)];
      }),
    );
  const ONE = constantsOf(WEBGL1);
  const TWO = ONE.concat(constantsOf(WEBGL2));
  const K: Record<string, number> = Object.fromEntries(TWO);

  const illegal = (): never => {
    throw new TypeError('Illegal constructor');
  };
  /** An interface a page can name and test for, and not construct. */
  const iface = (name: string, base?: Any): Any => {
    const C: Any = base
      ? class extends base {
          constructor() {
            super();
            illegal();
          }
        }
      : class {
          constructor() {
            illegal();
          }
        };
    Object.defineProperty(C, 'name', { value: name });
    return C;
  };
  /** A made object of an interface, past its constructor, with what this
   *  keeps on it out of a page's enumeration. */
  const make = (C: Any, fields: Any = {}): Any => {
    const o = Object.create(C.prototype);
    for (const [key, value] of Object.entries(fields)) {
      Object.defineProperty(o, key, { value, writable: true });
    }
    return o;
  };
  const constants = (C: Any, list: [string, number][]): void => {
    for (const [name, value] of list) {
      const desc = { value, enumerable: true };
      Object.defineProperty(C, name, desc);
      Object.defineProperty(C.prototype, name, desc);
    }
  };

  // --- the objects --------------------------------------------------------------

  /** What each object starts with: not deleted. */
  const ALIVE = { _deleted: false };

  const WebGLObject = iface('WebGLObject');
  const WebGLBuffer = iface('WebGLBuffer', WebGLObject);
  const WebGLFramebuffer = iface('WebGLFramebuffer', WebGLObject);
  const WebGLProgram = iface('WebGLProgram', WebGLObject);
  const WebGLRenderbuffer = iface('WebGLRenderbuffer', WebGLObject);
  const WebGLShader = iface('WebGLShader', WebGLObject);
  const WebGLTexture = iface('WebGLTexture', WebGLObject);
  const WebGLQuery = iface('WebGLQuery', WebGLObject);
  const WebGLSampler = iface('WebGLSampler', WebGLObject);
  const WebGLSync = iface('WebGLSync', WebGLObject);
  const WebGLTransformFeedback = iface('WebGLTransformFeedback', WebGLObject);
  const WebGLVertexArrayObject = iface('WebGLVertexArrayObject', WebGLObject);
  const WebGLUniformLocation = iface('WebGLUniformLocation');
  const WebGLActiveInfo = iface('WebGLActiveInfo');
  const WebGLShaderPrecisionFormat = iface('WebGLShaderPrecisionFormat');
  const WebGLRenderingContext = iface('WebGLRenderingContext');
  const WebGL2RenderingContext = iface('WebGL2RenderingContext');
  constants(WebGLRenderingContext, ONE);
  constants(WebGL2RenderingContext, TWO);
  class WebGLContextEvent extends (Event as Any) {
    constructor(type: Any, init: Any = {}) {
      super(type, init);
      Object.defineProperty(this, 'statusMessage', {
        value: String(init?.statusMessage ?? ''),
        enumerable: true,
      });
    }
  }

  // --- the context ----------------------------------------------------------

  // The limits a context answers: Chrome's on a Mac.
  const LIMITS: Record<string, Any> = {
    MAX_TEXTURE_SIZE: 8192,
    MAX_CUBE_MAP_TEXTURE_SIZE: 16384,
    MAX_RENDERBUFFER_SIZE: 8192,
    MAX_TEXTURE_IMAGE_UNITS: 32,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 32,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 64,
    MAX_VERTEX_ATTRIBS: 16,
    MAX_VERTEX_UNIFORM_VECTORS: 4096,
    MAX_VARYING_VECTORS: 31,
    MAX_FRAGMENT_UNIFORM_VECTORS: 4096,
    MAX_VIEWPORT_DIMS: () => new Int32Array([8192, 8192]),
    ALIASED_LINE_WIDTH_RANGE: () => new Float32Array([1, 1]),
    ALIASED_POINT_SIZE_RANGE: () => new Float32Array([1, 1023]),
    SUBPIXEL_BITS: 4,
    RED_BITS: 8,
    GREEN_BITS: 8,
    BLUE_BITS: 8,
    ALPHA_BITS: 8,
    DEPTH_BITS: 24,
    STENCIL_BITS: 0,
    SAMPLES: 0,
    SAMPLE_BUFFERS: 0,
    VENDOR: 'WebKit',
    RENDERER: 'WebKit WebGL',
    COMPRESSED_TEXTURE_FORMATS: () => new Uint32Array(0),
    IMPLEMENTATION_COLOR_READ_FORMAT: 0x1908,
    IMPLEMENTATION_COLOR_READ_TYPE: 0x1401,
  };
  const LIMITS2: Record<string, Any> = {
    MAX_SAMPLES: 4,
    MAX_3D_TEXTURE_SIZE: 2048,
    MAX_ARRAY_TEXTURE_LAYERS: 2048,
    MAX_DRAW_BUFFERS: 6,
    MAX_COLOR_ATTACHMENTS: 6,
    MAX_UNIFORM_BUFFER_BINDINGS: 72,
    MAX_UNIFORM_BLOCK_SIZE: 65536,
    MAX_VERTEX_UNIFORM_BLOCKS: 14,
    MAX_FRAGMENT_UNIFORM_BLOCKS: 14,
    MAX_COMBINED_UNIFORM_BLOCKS: 60,
    UNIFORM_BUFFER_OFFSET_ALIGNMENT: 256,
    MAX_VERTEX_UNIFORM_COMPONENTS: 16384,
    MAX_FRAGMENT_UNIFORM_COMPONENTS: 16384,
    MAX_VARYING_COMPONENTS: 124,
    MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS: 1130496,
    MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS: 1130496,
    MAX_ELEMENT_INDEX: 1073741823,
    MAX_ELEMENTS_INDICES: 2147483647,
    MAX_ELEMENTS_VERTICES: 2147483647,
    MAX_TEXTURE_LOD_BIAS: 15,
    MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS: 4,
    MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS: 128,
    MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS: 4,
    MAX_VERTEX_OUTPUT_COMPONENTS: 128,
    MAX_FRAGMENT_INPUT_COMPONENTS: 128,
    MIN_PROGRAM_TEXEL_OFFSET: -8,
    MAX_PROGRAM_TEXEL_OFFSET: 7,
    MAX_SERVER_WAIT_TIMEOUT: 0,
  };

  /** Where `bindX` puts each kind of object, by target, and the
   *  `getParameter` name each is read back by. */
  const BINDINGS: [string, string][] = [
    ['ARRAY_BUFFER', 'ARRAY_BUFFER_BINDING'],
    ['ELEMENT_ARRAY_BUFFER', 'ELEMENT_ARRAY_BUFFER_BINDING'],
    ['COPY_READ_BUFFER', 'COPY_READ_BUFFER_BINDING'],
    ['COPY_WRITE_BUFFER', 'COPY_WRITE_BUFFER_BINDING'],
    ['PIXEL_PACK_BUFFER', 'PIXEL_PACK_BUFFER_BINDING'],
    ['PIXEL_UNPACK_BUFFER', 'PIXEL_UNPACK_BUFFER_BINDING'],
    ['TRANSFORM_FEEDBACK_BUFFER', 'TRANSFORM_FEEDBACK_BUFFER_BINDING'],
    ['UNIFORM_BUFFER', 'UNIFORM_BUFFER_BINDING'],
    ['RENDERBUFFER', 'RENDERBUFFER_BINDING'],
    ['TEXTURE_2D', 'TEXTURE_BINDING_2D'],
    ['TEXTURE_CUBE_MAP', 'TEXTURE_BINDING_CUBE_MAP'],
    ['TEXTURE_3D', 'TEXTURE_BINDING_3D'],
    ['TEXTURE_2D_ARRAY', 'TEXTURE_BINDING_2D_ARRAY'],
  ];
  const BOUND_BY: Record<number, string> = {};
  for (const [target, binding] of BINDINGS) BOUND_BY[K[target]] = binding;

  /** The state a context starts with that `getParameter` reads back. */
  const initialState = (
    width: number,
    height: number,
  ): Record<string, Any> => ({
    VIEWPORT: [0, 0, width, height],
    SCISSOR_BOX: [0, 0, width, height],
    COLOR_CLEAR_VALUE: [0, 0, 0, 0],
    COLOR_WRITEMASK: [true, true, true, true],
    BLEND_COLOR: [0, 0, 0, 0],
    DEPTH_RANGE: [0, 1],
    DEPTH_CLEAR_VALUE: 1,
    STENCIL_CLEAR_VALUE: 0,
    DEPTH_WRITEMASK: true,
    DEPTH_FUNC: K.LESS,
    CULL_FACE_MODE: K.BACK,
    FRONT_FACE: K.CCW,
    LINE_WIDTH: 1,
    POLYGON_OFFSET_FACTOR: 0,
    POLYGON_OFFSET_UNITS: 0,
    SAMPLE_COVERAGE_VALUE: 1,
    SAMPLE_COVERAGE_INVERT: false,
    BLEND_SRC_RGB: K.ONE,
    BLEND_SRC_ALPHA: K.ONE,
    BLEND_DST_RGB: K.ZERO,
    BLEND_DST_ALPHA: K.ZERO,
    BLEND_EQUATION_RGB: K.FUNC_ADD,
    BLEND_EQUATION_ALPHA: K.FUNC_ADD,
    STENCIL_FUNC: K.ALWAYS,
    STENCIL_REF: 0,
    STENCIL_VALUE_MASK: 0x7fffffff,
    STENCIL_WRITEMASK: 0x7fffffff,
    STENCIL_FAIL: K.KEEP,
    STENCIL_PASS_DEPTH_FAIL: K.KEEP,
    STENCIL_PASS_DEPTH_PASS: K.KEEP,
    STENCIL_BACK_FUNC: K.ALWAYS,
    STENCIL_BACK_REF: 0,
    STENCIL_BACK_VALUE_MASK: 0x7fffffff,
    STENCIL_BACK_WRITEMASK: 0x7fffffff,
    STENCIL_BACK_FAIL: K.KEEP,
    STENCIL_BACK_PASS_DEPTH_FAIL: K.KEEP,
    STENCIL_BACK_PASS_DEPTH_PASS: K.KEEP,
    ACTIVE_TEXTURE: K.TEXTURE0,
    CURRENT_PROGRAM: null,
    FRAMEBUFFER_BINDING: null,
    DRAW_FRAMEBUFFER_BINDING: null,
    READ_FRAMEBUFFER_BINDING: null,
    VERTEX_ARRAY_BINDING: null,
    TRANSFORM_FEEDBACK_BINDING: null,
    SAMPLER_BINDING: null,
    PACK_ALIGNMENT: 4,
    UNPACK_ALIGNMENT: 4,
    PACK_ROW_LENGTH: 0,
    PACK_SKIP_PIXELS: 0,
    PACK_SKIP_ROWS: 0,
    UNPACK_ROW_LENGTH: 0,
    UNPACK_IMAGE_HEIGHT: 0,
    UNPACK_SKIP_PIXELS: 0,
    UNPACK_SKIP_ROWS: 0,
    UNPACK_SKIP_IMAGES: 0,
    UNPACK_FLIP_Y_WEBGL: false,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: false,
    UNPACK_COLORSPACE_CONVERSION_WEBGL: K.BROWSER_DEFAULT_WEBGL,
    GENERATE_MIPMAP_HINT: K.DONT_CARE,
    FRAGMENT_SHADER_DERIVATIVE_HINT: K.DONT_CARE,
    READ_BUFFER: K.BACK,
    DRAW_BUFFER0: K.BACK,
    ...Object.fromEntries(BINDINGS.map(([, binding]) => [binding, null])),
  });
  /** Which values `getParameter` hands back as typed arrays. */
  const TYPED: Record<string, Any> = {
    VIEWPORT: Int32Array,
    SCISSOR_BOX: Int32Array,
    COLOR_CLEAR_VALUE: Float32Array,
    BLEND_COLOR: Float32Array,
    DEPTH_RANGE: Float32Array,
  };
  /** A value's name, WebGL 1's where two share it: `DRAW_FRAMEBUFFER_BINDING`
   *  is `FRAMEBUFFER_BINDING`. */
  const NAMES: Record<number, string> = {};
  for (const [name, value] of TWO) NAMES[value] ??= name;

  /** What a context keeps, behind a private field of the page's. */
  const stateOf = new WeakMap<object, Any>();
  const own = (gl: Any): Any => {
    const s = stateOf.get(gl);
    if (!s) throw new TypeError('Illegal invocation');
    return s;
  };

  /** The methods both contexts have, WebGL 1's, by what they answer. */
  const methods: Record<string, (this: Any, ...args: Any[]) => Any> = {
    getContextAttributes() {
      const s = own(this);
      return s.lost ? null : { ...s.attributes };
    },
    isContextLost() {
      return own(this).lost;
    },
    getSupportedExtensions() {
      return own(this).lost ? null : [];
    },
    getExtension() {
      return null;
    },
    getError() {
      return own(this).lost ? K.CONTEXT_LOST_WEBGL : K.NO_ERROR;
    },
    getParameter(pname: Any) {
      const s = own(this);
      const name = NAMES[pname];
      if (s.lost || name === undefined) return null;
      if (name === 'VERSION') {
        return s.two
          ? 'WebGL 2.0 (OpenGL ES 3.0 Chromium)'
          : 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
      }
      if (name === 'SHADING_LANGUAGE_VERSION') {
        return s.two
          ? 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)'
          : 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
      }
      if (name in s.enabled) return s.enabled[name];
      if (name in s.params) {
        const v = s.params[name];
        if (name === 'COLOR_WRITEMASK') return v.slice();
        return TYPED[name] ? new TYPED[name](v) : v;
      }
      const limit =
        name in LIMITS ? LIMITS[name] : s.two ? LIMITS2[name] : undefined;
      if (limit === undefined) return null;
      return typeof limit === 'function' ? limit() : limit;
    },
    getShaderPrecisionFormat(_shaderType: Any, precision: Any) {
      const int = precision >= K.LOW_INT;
      return make(WebGLShaderPrecisionFormat, {
        rangeMin: int ? 31 : 127,
        rangeMax: int ? 30 : 127,
        precision: int ? 0 : 23,
      });
    },
    enable(cap: Any) {
      const name = NAMES[cap];
      if (name in own(this).enabled) own(this).enabled[name] = true;
    },
    disable(cap: Any) {
      const name = NAMES[cap];
      if (name in own(this).enabled) own(this).enabled[name] = false;
    },
    isEnabled(cap: Any) {
      return !!own(this).enabled[NAMES[cap]];
    },
    viewport(x: Any, y: Any, w: Any, h: Any) {
      own(this).params.VIEWPORT = [x, y, w, h].map(Number);
    },
    scissor(x: Any, y: Any, w: Any, h: Any) {
      own(this).params.SCISSOR_BOX = [x, y, w, h].map(Number);
    },
    clearColor(r: Any, g: Any, b: Any, a: Any) {
      own(this).params.COLOR_CLEAR_VALUE = [r, g, b, a].map(Number);
    },
    clearDepth(d: Any) {
      own(this).params.DEPTH_CLEAR_VALUE = Number(d);
    },
    clearStencil(v: Any) {
      own(this).params.STENCIL_CLEAR_VALUE = Number(v);
    },
    colorMask(r: Any, g: Any, b: Any, a: Any) {
      own(this).params.COLOR_WRITEMASK = [r, g, b, a].map(Boolean);
    },
    depthMask(flag: Any) {
      own(this).params.DEPTH_WRITEMASK = !!flag;
    },
    depthFunc(f: Any) {
      own(this).params.DEPTH_FUNC = f;
    },
    depthRange(near: Any, far: Any) {
      own(this).params.DEPTH_RANGE = [Number(near), Number(far)];
    },
    cullFace(mode: Any) {
      own(this).params.CULL_FACE_MODE = mode;
    },
    frontFace(mode: Any) {
      own(this).params.FRONT_FACE = mode;
    },
    lineWidth(w: Any) {
      own(this).params.LINE_WIDTH = Number(w);
    },
    polygonOffset(factor: Any, units: Any) {
      const p = own(this).params;
      p.POLYGON_OFFSET_FACTOR = Number(factor);
      p.POLYGON_OFFSET_UNITS = Number(units);
    },
    sampleCoverage(value: Any, invert: Any) {
      const p = own(this).params;
      p.SAMPLE_COVERAGE_VALUE = Number(value);
      p.SAMPLE_COVERAGE_INVERT = !!invert;
    },
    blendColor(r: Any, g: Any, b: Any, a: Any) {
      own(this).params.BLEND_COLOR = [r, g, b, a].map(Number);
    },
    blendEquation(mode: Any) {
      methods.blendEquationSeparate.call(this, mode, mode);
    },
    blendEquationSeparate(rgb: Any, alpha: Any) {
      const p = own(this).params;
      p.BLEND_EQUATION_RGB = rgb;
      p.BLEND_EQUATION_ALPHA = alpha;
    },
    blendFunc(src: Any, dst: Any) {
      methods.blendFuncSeparate.call(this, src, dst, src, dst);
    },
    blendFuncSeparate(srcRgb: Any, dstRgb: Any, srcAlpha: Any, dstAlpha: Any) {
      const p = own(this).params;
      p.BLEND_SRC_RGB = srcRgb;
      p.BLEND_DST_RGB = dstRgb;
      p.BLEND_SRC_ALPHA = srcAlpha;
      p.BLEND_DST_ALPHA = dstAlpha;
    },
    stencilFunc(func: Any, ref: Any, mask: Any) {
      methods.stencilFuncSeparate.call(this, K.FRONT_AND_BACK, func, ref, mask);
    },
    stencilFuncSeparate(face: Any, func: Any, ref: Any, mask: Any) {
      const p = own(this).params;
      if (face !== K.BACK) {
        p.STENCIL_FUNC = func;
        p.STENCIL_REF = ref;
        p.STENCIL_VALUE_MASK = mask;
      }
      if (face !== K.FRONT) {
        p.STENCIL_BACK_FUNC = func;
        p.STENCIL_BACK_REF = ref;
        p.STENCIL_BACK_VALUE_MASK = mask;
      }
    },
    stencilMask(mask: Any) {
      methods.stencilMaskSeparate.call(this, K.FRONT_AND_BACK, mask);
    },
    stencilMaskSeparate(face: Any, mask: Any) {
      const p = own(this).params;
      if (face !== K.BACK) p.STENCIL_WRITEMASK = mask;
      if (face !== K.FRONT) p.STENCIL_BACK_WRITEMASK = mask;
    },
    stencilOp(fail: Any, zfail: Any, zpass: Any) {
      methods.stencilOpSeparate.call(
        this,
        K.FRONT_AND_BACK,
        fail,
        zfail,
        zpass,
      );
    },
    stencilOpSeparate(face: Any, fail: Any, zfail: Any, zpass: Any) {
      const p = own(this).params;
      if (face !== K.BACK) {
        p.STENCIL_FAIL = fail;
        p.STENCIL_PASS_DEPTH_FAIL = zfail;
        p.STENCIL_PASS_DEPTH_PASS = zpass;
      }
      if (face !== K.FRONT) {
        p.STENCIL_BACK_FAIL = fail;
        p.STENCIL_BACK_PASS_DEPTH_FAIL = zfail;
        p.STENCIL_BACK_PASS_DEPTH_PASS = zpass;
      }
    },
    hint(target: Any, mode: Any) {
      const name = NAMES[target];
      if (name in own(this).params) own(this).params[name] = mode;
    },
    pixelStorei(pname: Any, param: Any) {
      const name = NAMES[pname];
      const p = own(this).params;
      if (!(name in p)) return;
      p[name] = typeof p[name] === 'boolean' ? !!param : Number(param);
    },
    activeTexture(unit: Any) {
      own(this).params.ACTIVE_TEXTURE = unit;
    },

    // objects: made, bound, told apart, and deleted
    createBuffer() {
      return make(WebGLBuffer, ALIVE);
    },
    createFramebuffer() {
      return make(WebGLFramebuffer, ALIVE);
    },
    createRenderbuffer() {
      return make(WebGLRenderbuffer, ALIVE);
    },
    createTexture() {
      return make(WebGLTexture, ALIVE);
    },
    createProgram() {
      return make(WebGLProgram, { _shaders: [] as Any[], _deleted: false });
    },
    createShader(type: Any) {
      if (type !== K.VERTEX_SHADER && type !== K.FRAGMENT_SHADER) return null;
      return make(WebGLShader, { _type: type, _source: '', _deleted: false });
    },
    isBuffer(o: Any) {
      return o instanceof WebGLBuffer && !o._deleted;
    },
    isFramebuffer(o: Any) {
      return o instanceof WebGLFramebuffer && !o._deleted;
    },
    isRenderbuffer(o: Any) {
      return o instanceof WebGLRenderbuffer && !o._deleted;
    },
    isTexture(o: Any) {
      return o instanceof WebGLTexture && !o._deleted;
    },
    isProgram(o: Any) {
      return o instanceof WebGLProgram && !o._deleted;
    },
    isShader(o: Any) {
      return o instanceof WebGLShader && !o._deleted;
    },
    bindBuffer(target: Any, buffer: Any) {
      bind(this, target, buffer);
    },
    bindRenderbuffer(target: Any, buffer: Any) {
      bind(this, target, buffer);
    },
    bindTexture(target: Any, texture: Any) {
      bind(this, target, texture);
    },
    bindFramebuffer(target: Any, framebuffer: Any) {
      const p = own(this).params;
      const fb = framebuffer ?? null;
      if (target !== K.READ_FRAMEBUFFER) p.FRAMEBUFFER_BINDING = fb;
      if (target !== K.DRAW_FRAMEBUFFER) p.READ_FRAMEBUFFER_BINDING = fb;
    },
    useProgram(program: Any) {
      own(this).params.CURRENT_PROGRAM = program ?? null;
    },
    deleteBuffer(o: Any) {
      gone(this, o);
    },
    deleteFramebuffer(o: Any) {
      gone(this, o);
    },
    deleteRenderbuffer(o: Any) {
      gone(this, o);
    },
    deleteTexture(o: Any) {
      gone(this, o);
    },
    deleteProgram(o: Any) {
      gone(this, o);
    },
    deleteShader(o: Any) {
      gone(this, o);
    },
    checkFramebufferStatus() {
      return own(this).lost ? 0 : K.FRAMEBUFFER_COMPLETE;
    },

    // shaders and programs: each compiles and links, and has no active
    // uniform or attribute to report
    shaderSource(shader: Any, source: Any) {
      if (shader instanceof WebGLShader) shader._source = String(source);
    },
    getShaderSource(shader: Any) {
      return shader instanceof WebGLShader ? shader._source : null;
    },
    getShaderParameter(shader: Any, pname: Any) {
      if (!(shader instanceof WebGLShader)) return null;
      if (pname === K.SHADER_TYPE) return shader._type;
      if (pname === K.DELETE_STATUS) return !!shader._deleted;
      if (pname === K.COMPILE_STATUS) return true;
      return null;
    },
    getShaderInfoLog(shader: Any) {
      return shader instanceof WebGLShader ? '' : null;
    },
    attachShader(program: Any, shader: Any) {
      if (
        program instanceof WebGLProgram &&
        !program._shaders.includes(shader)
      ) {
        program._shaders.push(shader);
      }
    },
    detachShader(program: Any, shader: Any) {
      if (program instanceof WebGLProgram) {
        program._shaders = program._shaders.filter((s: Any) => s !== shader);
      }
    },
    getAttachedShaders(program: Any) {
      return program instanceof WebGLProgram ? program._shaders.slice() : null;
    },
    getProgramParameter(program: Any, pname: Any) {
      if (!(program instanceof WebGLProgram)) return null;
      switch (pname) {
        case K.DELETE_STATUS:
          return !!program._deleted;
        case K.LINK_STATUS:
        case K.VALIDATE_STATUS:
          return true;
        case K.ATTACHED_SHADERS:
          return program._shaders.length;
        case K.TRANSFORM_FEEDBACK_BUFFER_MODE:
          return K.SEPARATE_ATTRIBS;
        case K.ACTIVE_ATTRIBUTES:
        case K.ACTIVE_UNIFORMS:
        case K.ACTIVE_UNIFORM_BLOCKS:
        case K.TRANSFORM_FEEDBACK_VARYINGS:
          return 0;
      }
      return null;
    },
    getProgramInfoLog(program: Any) {
      return program instanceof WebGLProgram ? '' : null;
    },
    getActiveAttrib() {
      return null;
    },
    getActiveUniform() {
      return null;
    },
    getAttribLocation() {
      return -1;
    },
    getUniformLocation() {
      return null;
    },
    getUniform() {
      return null;
    },

    // reads of what is drawn, of which there is none
    readPixels(...args: Any[]) {
      const out = args.find((a) => ArrayBuffer.isView(a));
      if (out)
        new Uint8Array(out.buffer, out.byteOffset, out.byteLength).fill(0);
    },
    getBufferParameter() {
      return null;
    },
    getTexParameter() {
      return null;
    },
    getRenderbufferParameter() {
      return null;
    },
    getFramebufferAttachmentParameter() {
      return null;
    },
    getVertexAttrib() {
      return null;
    },
    getVertexAttribOffset() {
      return 0;
    },
  };
  // what draws, uploads or sets what a draw reads: taken, and nothing done
  for (const name of [
    'bindAttribLocation',
    'bufferData',
    'bufferSubData',
    'clear',
    'compileShader',
    'compressedTexImage2D',
    'compressedTexSubImage2D',
    'copyTexImage2D',
    'copyTexSubImage2D',
    'disableVertexAttribArray',
    'drawArrays',
    'drawElements',
    'drawingBufferStorage',
    'enableVertexAttribArray',
    'finish',
    'flush',
    'framebufferRenderbuffer',
    'framebufferTexture2D',
    'generateMipmap',
    'linkProgram',
    'renderbufferStorage',
    'texImage2D',
    'texParameterf',
    'texParameteri',
    'texSubImage2D',
    'validateProgram',
    'vertexAttribPointer',
    'vertexAttrib1f',
    'vertexAttrib1fv',
    'vertexAttrib2f',
    'vertexAttrib2fv',
    'vertexAttrib3f',
    'vertexAttrib3fv',
    'vertexAttrib4f',
    'vertexAttrib4fv',
    ...['1', '2', '3', '4'].flatMap((n) =>
      ['f', 'fv', 'i', 'iv'].map((t) => `uniform${n}${t}`),
    ),
    'uniformMatrix2fv',
    'uniformMatrix3fv',
    'uniformMatrix4fv',
  ]) {
    methods[name] ??= () => {};
  }

  /** WebGL 2's own. */
  const methods2: Record<string, (this: Any, ...args: Any[]) => Any> = {
    createQuery() {
      return make(WebGLQuery, ALIVE);
    },
    createSampler() {
      return make(WebGLSampler, ALIVE);
    },
    createTransformFeedback() {
      return make(WebGLTransformFeedback, ALIVE);
    },
    createVertexArray() {
      return make(WebGLVertexArrayObject, ALIVE);
    },
    fenceSync() {
      return make(WebGLSync, ALIVE);
    },
    isQuery(o: Any) {
      return o instanceof WebGLQuery && !o._deleted;
    },
    isSampler(o: Any) {
      return o instanceof WebGLSampler && !o._deleted;
    },
    isSync(o: Any) {
      return o instanceof WebGLSync && !o._deleted;
    },
    isTransformFeedback(o: Any) {
      return o instanceof WebGLTransformFeedback && !o._deleted;
    },
    isVertexArray(o: Any) {
      return o instanceof WebGLVertexArrayObject && !o._deleted;
    },
    deleteQuery(o: Any) {
      gone(this, o);
    },
    deleteSampler(o: Any) {
      gone(this, o);
    },
    deleteSync(o: Any) {
      gone(this, o);
    },
    deleteTransformFeedback(o: Any) {
      gone(this, o);
    },
    deleteVertexArray(o: Any) {
      gone(this, o);
    },
    bindVertexArray(vao: Any) {
      own(this).params.VERTEX_ARRAY_BINDING = vao ?? null;
    },
    bindTransformFeedback(_target: Any, tf: Any) {
      own(this).params.TRANSFORM_FEEDBACK_BINDING = tf ?? null;
    },
    bindBufferBase(target: Any, _index: Any, buffer: Any) {
      bind(this, target, buffer);
    },
    bindBufferRange(target: Any, _index: Any, buffer: Any) {
      bind(this, target, buffer);
    },
    readBuffer(src: Any) {
      own(this).params.READ_BUFFER = src;
    },
    // a fence is passed, and a query has its answer, at once
    clientWaitSync() {
      return K.ALREADY_SIGNALED;
    },
    getSyncParameter(_sync: Any, pname: Any) {
      switch (pname) {
        case K.OBJECT_TYPE:
          return K.SYNC_FENCE;
        case K.SYNC_STATUS:
          return K.SIGNALED;
        case K.SYNC_CONDITION:
          return K.SYNC_GPU_COMMANDS_COMPLETE;
        case K.SYNC_FLAGS:
          return 0;
      }
      return null;
    },
    getQuery() {
      return null;
    },
    getQueryParameter(_query: Any, pname: Any) {
      if (pname === K.QUERY_RESULT_AVAILABLE) return true;
      if (pname === K.QUERY_RESULT) return 0;
      return null;
    },
    getSamplerParameter() {
      return null;
    },
    getIndexedParameter() {
      return null;
    },
    getInternalformatParameter(_target: Any, _format: Any, pname: Any) {
      return pname === K.SAMPLES ? new Int32Array([4]) : null;
    },
    getFragDataLocation() {
      return -1;
    },
    getUniformBlockIndex() {
      return K.INVALID_INDEX;
    },
    getUniformIndices(_program: Any, names: Any) {
      return Array.from(names ?? [], () => K.INVALID_INDEX);
    },
    getActiveUniforms(_program: Any, indices: Any) {
      return Array.from(indices ?? [], () => 0);
    },
    getActiveUniformBlockName() {
      return null;
    },
    getActiveUniformBlockParameter() {
      return null;
    },
    getTransformFeedbackVarying() {
      return null;
    },
    getBufferSubData(...args: Any[]) {
      const out = args.find((a) => ArrayBuffer.isView(a));
      if (out)
        new Uint8Array(out.buffer, out.byteOffset, out.byteLength).fill(0);
    },
  };
  for (const name of [
    'beginQuery',
    'beginTransformFeedback',
    'bindSampler',
    'blitFramebuffer',
    'clearBufferfi',
    'clearBufferfv',
    'clearBufferiv',
    'clearBufferuiv',
    'compressedTexImage3D',
    'compressedTexSubImage3D',
    'copyBufferSubData',
    'copyTexSubImage3D',
    'drawArraysInstanced',
    'drawBuffers',
    'drawElementsInstanced',
    'drawRangeElements',
    'endQuery',
    'endTransformFeedback',
    'framebufferTextureLayer',
    'invalidateFramebuffer',
    'invalidateSubFramebuffer',
    'pauseTransformFeedback',
    'renderbufferStorageMultisample',
    'resumeTransformFeedback',
    'samplerParameterf',
    'samplerParameteri',
    'texImage3D',
    'texStorage2D',
    'texStorage3D',
    'texSubImage3D',
    'transformFeedbackVaryings',
    'uniformBlockBinding',
    'vertexAttribDivisor',
    'vertexAttribI4i',
    'vertexAttribI4iv',
    'vertexAttribI4ui',
    'vertexAttribI4uiv',
    'vertexAttribIPointer',
    'waitSync',
    ...['1', '2', '3', '4'].flatMap((n) =>
      ['ui', 'uiv'].map((t) => `uniform${n}${t}`),
    ),
    'uniformMatrix2x3fv',
    'uniformMatrix2x4fv',
    'uniformMatrix3x2fv',
    'uniformMatrix3x4fv',
    'uniformMatrix4x2fv',
    'uniformMatrix4x3fv',
  ]) {
    methods2[name] ??= () => {};
  }

  /** A binding point set, by the target's name. */
  const bind = (gl: Any, target: Any, object: Any): void => {
    const binding = BOUND_BY[target];
    if (binding) own(gl).params[binding] = object ?? null;
  };
  /** An object deleted, and unbound wherever the context had it. */
  const gone = (gl: Any, object: Any): void => {
    if (!(object instanceof WebGLObject)) return;
    object._deleted = true;
    const p = own(gl).params;
    for (const key of Object.keys(p)) if (p[key] === object) p[key] = null;
  };

  const install = (C: Any, table: Record<string, Any>): void => {
    for (const [name, fn] of Object.entries(table)) {
      Object.defineProperty(C.prototype, name, {
        value: fn,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
  };
  for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
    install(C, methods);
    const getters: Record<string, (s: Any) => Any> = {
      canvas: (s) => s.canvas,
      drawingBufferWidth: (s) => s.canvas.width,
      drawingBufferHeight: (s) => s.canvas.height,
      drawingBufferFormat: () => K.RGBA8,
    };
    for (const [name, read] of Object.entries(getters)) {
      Object.defineProperty(C.prototype, name, {
        get(this: Any) {
          return read(own(this));
        },
        configurable: true,
        enumerable: true,
      });
    }
    // what a page may set, and reads back as it set it
    for (const name of ['drawingBufferColorSpace', 'unpackColorSpace']) {
      Object.defineProperty(C.prototype, name, {
        get(this: Any) {
          return own(this)[name];
        },
        set(this: Any, v: Any) {
          if (v === 'srgb' || v === 'display-p3') own(this)[name] = v;
        },
        configurable: true,
        enumerable: true,
      });
    }
  }
  install(WebGL2RenderingContext, methods2);

  // --- a context that draws -----------------------------------------------------
  //
  // Where the host has a GL (`HtmlScripts.webgl`) a context's calls go to it
  // as well: the methods above go on keeping the state a page reads back,
  // and what a driver has to answer is asked of it. Calls are queued as JSON
  // and sent where something has to be answered and at the end of a task, so
  // a frame of a few hundred calls is a few crossings, and the bytes a call
  // carries are base64, since a string is what crosses. Nothing here is
  // handed anything of the host's but numbers and strings. What a page reads
  // of a context on the way through may be its own hand in `JSON` or `Array`:
  // these are taken before any page code runs.
  const stringify: Any = JSON.stringify;
  const parse: Any = JSON.parse;
  const isView: Any = ArrayBuffer.isView;
  const classOf: Any = Object.prototype.toString;
  const apply: Any = Reflect.apply;
  const Uint8: Any = Uint8Array;
  const tagOf: Any = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    Symbol.toStringTag,
  )!.get;

  /** What the driver answers, past what a context keeps. */
  const ASKED = new Set([
    'checkFramebufferStatus',
    'getActiveAttrib',
    'getActiveUniform',
    'getAttribLocation',
    'getError',
    'getProgramInfoLog',
    'getProgramParameter',
    'getShaderInfoLog',
    'getShaderParameter',
    'getUniformLocation',
    'readPixels',
  ]);
  /** What draws, and shows where the default framebuffer is bound. */
  const DRAWS = new Set([
    'blitFramebuffer',
    'clear',
    'drawArrays',
    'drawArraysInstanced',
    'drawElements',
    'drawElementsInstanced',
  ]);
  /** A context's own answers, which change nothing a driver holds. */
  const KEPT = /^(?:get|is[A-Z])/;

  let objects = 0;
  /** The contexts with something to send at the end of this task. */
  const waiting = new Set<Any>();
  let flushing = false;

  /** A call's argument as `src/html/webgl.ts` reads it. */
  const written = (arg: Any): Any => {
    if (arg === null || arg === undefined) return null;
    if (typeof arg !== 'object') return arg;
    if (arg instanceof WebGLObject) return ['o', (arg as Any)._live ?? 0];
    if (arg instanceof WebGLUniformLocation) return (arg as Any)._live;
    if (isView(arg)) {
      const bytes = new Uint8(arg.buffer, arg.byteOffset, arg.byteLength);
      return ['b', apply(tagOf, arg, []), host.base64(bytes)];
    }
    if (apply(classOf, arg, []) === '[object ArrayBuffer]') {
      return ['b', 'Uint8Array', host.base64(new Uint8(arg))];
    }
    if (Array.isArray(arg)) return ['a', ...arg];
    return null;
  };
  const send = (s: Any): void => {
    if (!s.queue.length) return;
    const calls = stringify(s.queue);
    s.queue = [];
    host.call('glRun', s.live, calls);
  };
  const flushAll = (): void => {
    flushing = false;
    for (const s of waiting) {
      send(s);
      if (s.drew) {
        s.drew = false;
        host.call('glPresent', s.live, host.id(s.canvas));
      }
    }
    waiting.clear();
  };
  const soon = (s: Any): void => {
    waiting.add(s);
    if (flushing) return;
    flushing = true;
    queueMicrotask(flushAll);
  };
  /** What the driver says, once what was queued has run. */
  const ask = (s: Any, name: string, args: Any[]): Any => {
    s.queue[s.queue.length] = [name, ...args.map(written)];
    const calls = stringify(s.queue);
    s.queue = [];
    const answer = host.call('glAsk', s.live, calls);
    return typeof answer === 'string' ? parse(answer) : null;
  };
  /** A source element or an `ImageData` as `texImage2D`'s long form: its
   *  pixels, turned as `pixelStorei` said to take them. */
  const sourced = (s: Any, args: Any[]): Any[] | null => {
    const [target, level, internal, format, type, source] =
      args.length === 6
        ? args
        : [...args.slice(0, 3), args[6], args[7], args[8]];
    const pixels = host.pixelsOf(source);
    if (!pixels) return null;
    const { width, height } = pixels;
    let { data } = pixels;
    if (s.params.UNPACK_FLIP_Y_WEBGL) {
      const stride = width * 4;
      const turned = new Uint8(data.length);
      for (let y = 0; y < height; y += 1) {
        const from = y * stride;
        turned.set(
          data.subarray(from, from + stride),
          (height - 1 - y) * stride,
        );
      }
      data = turned;
    }
    return [target, level, internal, width, height, 0, format, type, data];
  };
  const SOURCE_FORM = (args: Any[]): boolean =>
    args.length === 6 ||
    (args.length === 9 &&
      args[8] !== null &&
      typeof args[8] === 'object' &&
      !isView(args[8]));

  const liveCall = (
    gl: Any,
    s: Any,
    name: string,
    fn: Any,
    args: Any[],
  ): Any => {
    switch (name) {
      case 'getSupportedExtensions':
        return [...s.extensions];
      case 'getExtension': {
        const wanted = `${args[0]}`;
        s.found ??= {};
        if (!s.extensions.includes(wanted)) return null;
        return (s.found[wanted] ??= {});
      }
      case 'bufferData':
        args = args.slice(0, 3);
        break;
      case 'texImage2D':
        if (SOURCE_FORM(args)) {
          const long = sourced(s, args);
          if (!long) return undefined;
          args = long;
        }
        break;
      case 'drawRangeElements':
        name = 'drawElements';
        args = [args[0], args[3], args[4], args[5]];
        break;
    }
    if (ASKED.has(name)) {
      if (name === 'readPixels') {
        const [x, y, w, h, format, type, into, offset] = args;
        const size = into
          ? into.byteLength - (offset ?? 0) * into.BYTES_PER_ELEMENT
          : 0;
        const b64 = ask(s, name, [x, y, w, h, format, type, size]);
        if (typeof b64 === 'string' && into) {
          new Uint8(into.buffer, into.byteOffset, into.byteLength).set(
            host.bytes(b64),
            (offset ?? 0) * into.BYTES_PER_ELEMENT,
          );
        }
        return undefined;
      }
      const answer = ask(s, name, args);
      if (name === 'getUniformLocation') {
        return answer === null
          ? null
          : make(WebGLUniformLocation, { _live: answer });
      }
      if (name === 'getActiveAttrib' || name === 'getActiveUniform') {
        return answer && make(WebGLActiveInfo, answer);
      }
      return answer;
    }
    // a uniform a shader optimized away has a null location, and setting it
    // does nothing: said to GL it would be location 0, someone else's
    if (args[0] === null && name.startsWith('uniform')) return undefined;
    const out = apply(fn, gl, args);
    if (KEPT.test(name)) return out;
    if (name.startsWith('create') && out) {
      objects += 1;
      Object.defineProperty(out, '_live', { value: objects });
      s.queue[s.queue.length] = [name, objects, ...args.map(written)];
    } else {
      s.queue[s.queue.length] = [name, ...args.map(written)];
    }
    if (DRAWS.has(name) && s.params.FRAMEBUFFER_BINDING === null) {
      s.drew = true;
      s.read = null;
    }
    soon(s);
    return out;
  };
  for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
    for (const name of Object.getOwnPropertyNames(C.prototype)) {
      const fn = Object.getOwnPropertyDescriptor(C.prototype, name)?.value;
      if (typeof fn !== 'function' || name === 'constructor') continue;
      const forward = {
        [name](this: Any, ...args: Any[]) {
          const s = own(this);
          return s.live
            ? liveCall(this, s, name, fn, args)
            : apply(fn, this, args);
        },
      }[name];
      Object.defineProperty(forward, 'length', { value: fn.length });
      Object.defineProperty(C.prototype, name, {
        value: forward,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
  }

  const ATTRIBUTES = {
    alpha: true,
    antialias: true,
    depth: true,
    desynchronized: false,
    failIfMajorPerformanceCaveat: false,
    powerPreference: 'default',
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    stencil: false,
    xrCompatible: false,
  };

  return {
    classes: {
      WebGLObject,
      WebGLBuffer,
      WebGLFramebuffer,
      WebGLProgram,
      WebGLRenderbuffer,
      WebGLShader,
      WebGLTexture,
      WebGLQuery,
      WebGLSampler,
      WebGLSync,
      WebGLTransformFeedback,
      WebGLVertexArrayObject,
      WebGLUniformLocation,
      WebGLActiveInfo,
      WebGLShaderPrecisionFormat,
      WebGLRenderingContext,
      WebGL2RenderingContext,
      WebGLContextEvent,
    },
    context(canvas: Any, kind: 'webgl' | 'webgl2', options: Any) {
      const two = kind === 'webgl2';
      const gl = make(two ? WebGL2RenderingContext : WebGLRenderingContext);
      // the attributes asked for, each as its kind, over the defaults
      const attributes: Any = { ...ATTRIBUTES };
      if (options && typeof options === 'object') {
        for (const key of Object.keys(ATTRIBUTES)) {
          const v = options[key];
          if (v === undefined) continue;
          attributes[key] = key === 'powerPreference' ? String(v) : !!v;
        }
      }
      // a context's state starts at what its canvas measures then, and what
      // three.js and its kin read back before they set it
      const enabled: Record<string, boolean> = {
        BLEND: false,
        CULL_FACE: false,
        DEPTH_TEST: false,
        DITHER: true,
        POLYGON_OFFSET_FILL: false,
        SAMPLE_ALPHA_TO_COVERAGE: false,
        SAMPLE_COVERAGE: false,
        SCISSOR_TEST: false,
        STENCIL_TEST: false,
      };
      if (two) enabled.RASTERIZER_DISCARD = false;
      // a GL of the host's, where it has one and this is an element's: the
      // page can draw on no canvas nothing shows
      const element = host.id(canvas);
      const opened =
        element === null
          ? null
          : parse(
              host.call(
                'glOpen',
                stringify({
                  version: two ? 2 : 1,
                  width: canvas.width,
                  height: canvas.height,
                  alpha: attributes.alpha,
                  depth: attributes.depth,
                  stencil: attributes.stencil,
                  antialias: attributes.antialias,
                  premultipliedAlpha: attributes.premultipliedAlpha,
                }),
              ) as string,
            );
      stateOf.set(gl, {
        canvas,
        two,
        lost: false,
        attributes,
        enabled,
        params: initialState(canvas.width, canvas.height),
        drawingBufferColorSpace: 'srgb',
        unpackColorSpace: 'srgb',
        live: opened?.id ?? 0,
        extensions: opened?.extensions ?? [],
        queue: [],
        drew: false,
        read: null,
      });
      return gl;
    },
    pixels(context: Any) {
      const s = own(context);
      const { width, height } = s.canvas;
      if (!s.live || !width || !height) return null;
      if (s.read) return s.read;
      const bound = s.params.FRAMEBUFFER_BINDING;
      const raw = new Uint8Array(width * height * 4);
      context.bindFramebuffer(0x8d40, null);
      context.readPixels(0, 0, width, height, 0x1908, 0x1401, raw);
      context.bindFramebuffer(0x8d40, bound);
      const data = new Uint8ClampedArray(raw.length);
      const straighten = s.attributes.premultipliedAlpha;
      const row = width * 4;
      // GL's rows go up the picture, and a canvas's down it
      for (let y = 0; y < height; y += 1) {
        const from = (height - 1 - y) * row;
        const to = y * row;
        for (let x = 0; x < row; x += 4) {
          const a = raw[from + x + 3];
          const k = straighten && a > 0 && a < 255 ? 255 / a : 1;
          data[to + x] = raw[from + x] * k;
          data[to + x + 1] = raw[from + x + 1] * k;
          data[to + x + 2] = raw[from + x + 2] * k;
          data[to + x + 3] = a;
        }
      }
      s.read = { width, height, data };
      return s.read;
    },
    resized(context: Any): void {
      const s = own(context);
      s.read = null;
      s.params.VIEWPORT = [0, 0, s.canvas.width, s.canvas.height];
      s.params.SCISSOR_BOX = [0, 0, s.canvas.width, s.canvas.height];
      if (!s.live) return;
      send(s);
      host.call('glResize', s.live, s.canvas.width, s.canvas.height);
      s.drew = true;
      soon(s);
    },
  };
}
