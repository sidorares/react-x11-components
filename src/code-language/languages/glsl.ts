// GLSL (OpenGL Shading Language), as a stream mode — the shader-editor use
// case. C-family surface: preprocessor lines, `//` and `/* */` comments,
// numbers with GLSL suffixes, the type zoo, storage qualifiers, and the
// built-in function set that makes a shader readable at a glance.
import { streamLanguage } from '../stream.js';
import type { StringStream } from '../stream.js';
import type { Language } from '../types.js';

const KEYWORDS = new Set(
  (
    'break case const continue default discard do else for if precision ' +
    'return struct switch while'
  ).split(' '),
);

const QUALIFIERS = new Set(
  (
    'attribute buffer centroid coherent flat highp in inout invariant layout ' +
    'lowp mediump noperspective out patch readonly restrict sample shared ' +
    'smooth uniform varying volatile writeonly'
  ).split(' '),
);

const TYPES = new Set(
  (
    'bool bvec2 bvec3 bvec4 dmat2 dmat3 dmat4 double dvec2 dvec3 dvec4 float ' +
    'int isampler2D isampler3D isamplerCube ivec2 ivec3 ivec4 mat2 mat2x2 ' +
    'mat2x3 mat2x4 mat3 mat3x2 mat3x3 mat3x4 mat4 mat4x2 mat4x3 mat4x4 ' +
    'sampler1D sampler2D sampler2DArray sampler2DShadow sampler3D samplerCube ' +
    'samplerCubeShadow uint usampler2D usampler3D usamplerCube uvec2 uvec3 ' +
    'uvec4 vec2 vec3 vec4 void'
  ).split(' '),
);

const BUILTINS = new Set(
  (
    'abs acos asin atan ceil clamp cos cross dFdx dFdy degrees distance dot ' +
    'exp exp2 faceforward floor fract fwidth inversesqrt length log log2 max ' +
    'min mix mod normalize pow radians reflect refract sign sin smoothstep ' +
    'sqrt step tan texelFetch texture texture2D textureCube textureLod'
  ).split(' '),
);

const ATOMS = new Set(['true', 'false']);

/** gl_Position, gl_FragColor, gl_FragCoord and friends. */
const GL_VAR = /^gl_\w+/;

interface GlslState {
  comment: boolean;
}

function token(stream: StringStream, state: GlslState): string | null {
  if (state.comment) {
    if (stream.match(/^.*?\*\//)) state.comment = false;
    else stream.skipToEnd();
    return 'comment';
  }
  // a preprocessor line: #version, #define, #ifdef … — checked before
  // whitespace is consumed, because `#` must be first on its line and
  // `eatSpace` would make `sol()` false for the check that follows it
  if (stream.sol() && stream.match(/^\s*#/)) {
    stream.skipToEnd();
    return 'meta';
  }
  if (stream.eatSpace()) return null;
  if (stream.match('//')) {
    stream.skipToEnd();
    return 'comment';
  }
  if (stream.match('/*')) {
    state.comment = true;
    if (stream.match(/^.*?\*\//)) state.comment = false;
    else stream.skipToEnd();
    return 'comment';
  }

  if (
    stream.match(/^\d+\.\d*([eE][+-]?\d+)?(lf|LF|f|F)?/) ||
    stream.match(/^\.\d+([eE][+-]?\d+)?(lf|LF|f|F)?/) ||
    stream.match(/^0[xX][0-9a-fA-F]+[uU]?/) ||
    stream.match(/^\d+([eE][+-]?\d+)?(lf|LF|f|F|u|U)?/)
  ) {
    return 'number';
  }

  if (stream.match(GL_VAR)) return 'atom';

  if (stream.match(/^[A-Za-z_]\w*/)) {
    const word = stream.current();
    if (KEYWORDS.has(word)) return 'keyword';
    if (QUALIFIERS.has(word)) return 'modifier';
    if (TYPES.has(word)) return 'typeName';
    if (ATOMS.has(word)) return 'bool';
    if (BUILTINS.has(word) && stream.match(/^\s*\(/, false)) return 'function';
    return null;
  }

  if (stream.match(/^\.[xyzwrgbastpq]{1,4}\b/)) return 'propertyName'; // swizzle

  if (stream.eat(/[{}()[\]]/)) return 'bracket';
  if (stream.eat(/[;,]/)) return 'punctuation';
  if (stream.eatWhile(/[+\-*/%<>=!&|^~?:.]/)) return 'operator';
  stream.next();
  return null;
}

/** GLSL. */
export function glsl(): Language {
  return streamLanguage<GlslState>({
    name: 'glsl',
    languageData: {
      lineComment: '//',
      completions: [...KEYWORDS, ...QUALIFIERS, ...TYPES, ...BUILTINS].sort(),
      indentAfter: /[([{]\s*$/,
    },
    startState: () => ({ comment: false }),
    token,
  });
}
