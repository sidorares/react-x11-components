// ondine's SVG, read into something a 2D context draws.
//
// ondine answers with an SVG document string, and nothing in this package
// draws SVG as such: ntk's `SvgView` (core's `<svg>`) has no custom
// properties, and every colour ondine writes is one — `fill="var(--_s)"`,
// themed through `--ondine-*` on the root, mixed with `color-mix()`. It
// would also draw the diagram as one opaque picture, which is what retired
// ntk's `<tex>` in favour of `<Formula>`: nothing in it selects.
//
// So this reads the document once, here, into a **scene**: paths already
// through every transform around them, in the diagram's own units, with
// their paint resolved against the theme; and text runs with a position,
// an anchor and a face. `node.ts` draws the scene and answers core's text
// accessors from it. The SVG ondine writes is small and regular — `g`,
// `path`, `rect`, `circle`, `polygon`, `text`/`tspan`, `a`, `title`, a
// nested `svg` for an architecture icon — and that is what is read; an
// element outside it is passed over, children and all, rather than drawn
// wrongly.
//
// Pure, and with no display: the parse is asserted in `test/mermaid.test.ts`
// against ondine's real output.
import { Parser } from 'htmlparser2';
import { interpolate } from 'react-x11/style';

import {
  IDENTITY,
  apply,
  ellipseSegs,
  isTranslation,
  lengthScale,
  multiply,
  parsePath,
  parseTransform,
  pointsSegs,
  rectSegs,
  segBounds,
  transformSegs,
} from './path.js';
import type { Matrix, Seg } from './path.js';

export type { Matrix, Seg } from './path.js';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A filled and/or stroked outline, in diagram units. */
export interface ScenePath {
  kind: 'path';
  segs: Seg[];
  /** `null` is `none`. */
  fill: string | null;
  stroke: string | null;
  /** Already scaled by the transform the shape was drawn under. */
  strokeWidth: number;
  dash: number[] | null;
  cap: 'butt' | 'round' | 'square';
  join: 'miter' | 'round' | 'bevel';
  fillOpacity: number;
  strokeOpacity: number;
  /** The link the shape is inside, if any. */
  href: string | null;
  bounds: Bounds | null;
}

/** One run of text — a `<text>`, or one `<tspan>` of it. */
export interface SceneText {
  kind: 'text';
  text: string;
  /** The anchor point, in the coordinates `matrix` maps from. */
  x: number;
  /** The baseline. */
  y: number;
  anchor: 'start' | 'middle' | 'end';
  /** Pixels per em, in the coordinates `matrix` maps from. */
  size: number;
  weight: number;
  family: string;
  fill: string;
  opacity: number;
  /** Local to diagram units. A translation for nearly every label; an
   *  axis title is turned. */
  matrix: Matrix;
  href: string | null;
}

export type SceneItem = ScenePath | SceneText;

export interface MermaidScene {
  /** The diagram's size in its own units — logical pixels at the
   *  `fontSize` it was compiled at. */
  width: number;
  height: number;
  /** Everything drawn, in paint order. */
  items: SceneItem[];
  /** The text runs in reading order: top to bottom, then left to right. */
  texts: SceneText[];
}

/** The custom properties a scene resolves `var()` against — the
 *  `--ondine-*` theme names, and anything else a caller wants seen. */
export type SceneVars = Readonly<Record<string, string>>;

// --- values --------------------------------------------------------------------

/** Where the parenthesised group starting at `open` ends. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `text` split at its top-level commas. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** Every `var()` in `value` substituted, fallbacks and nesting included. An
 *  unset name with no fallback is the empty string, which every reader
 *  below takes as "not given". */
export function resolveVars(
  value: string,
  env: ReadonlyMap<string, string>,
  depth = 0,
): string {
  if (depth > 16 || !value.includes('var(')) return value;
  let out = '';
  let i = 0;
  for (;;) {
    const at = value.indexOf('var(', i);
    if (at < 0) break;
    const end = closing(value, at + 3);
    if (end < 0) break;
    out += value.slice(i, at);
    const [name, ...rest] = splitArgs(value.slice(at + 4, end));
    const own = env.get(name.trim());
    if (own !== undefined && own.trim() !== '') {
      out += own;
    } else if (rest.length) {
      out += resolveVars(rest.join(',').trim(), env, depth + 1);
    }
    i = end + 1;
  }
  return out + value.slice(i);
}

const MIX = /^color-mix\(\s*in\s+srgb\s*,(.*)\)$/i;
const PERCENT = /\s+(-?[\d.]+)%\s*$/;

/** `color-mix(in srgb, a p%, b q%)` worked out; any other colour as it is.
 *  The only colour space ondine mixes in is sRGB. */
export function resolveColor(value: string): string {
  const v = value.trim();
  const m = MIX.exec(v);
  if (!m) return v;
  const args = splitArgs(m[1]);
  if (args.length !== 2) return v;
  const read = (arg: string): [string, number | null] => {
    const p = PERCENT.exec(arg);
    return p
      ? [resolveColor(arg.slice(0, p.index)), Number(p[1]) / 100]
      : [resolveColor(arg), null];
  };
  const [a, pa] = read(args[0]);
  const [b, pb] = read(args[1]);
  const wa = pa ?? (pb !== null ? 1 - pb : 0.5);
  const wb = pb ?? 1 - wa;
  const total = wa + wb;
  if (!(total > 0)) return a;
  // `interpolate(from, to, t)` is t of the way from `from` to `to`
  const mixed = interpolate(b, a, wa / total);
  return typeof mixed === 'string' ? mixed : a;
}

function number(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function weightOf(value: string, inherited: number): number {
  const v = value.trim();
  if (v === 'bold' || v === 'bolder') return 700;
  if (v === 'normal') return 400;
  if (v === 'lighter') return 300;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : inherited;
}

/** A `style` attribute's declarations, in order. */
function declarations(style: string | undefined): Array<[string, string]> {
  if (!style) return [];
  const out: Array<[string, string]> = [];
  for (const part of splitDeclarations(style)) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (name) out.push([name, value]);
  }
  return out;
}

/** `;`-separated, but not inside a parenthesis — a `var()` fallback may
 *  hold one in principle. */
function splitDeclarations(style: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < style.length; i++) {
    const ch = style[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ';' && depth === 0) {
      out.push(style.slice(start, i));
      start = i + 1;
    }
  }
  out.push(style.slice(start));
  return out;
}

// --- the inherited state ---------------------------------------------------------

interface State {
  env: Map<string, string>;
  matrix: Matrix;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  dash: number[] | null;
  cap: ScenePath['cap'];
  join: ScenePath['join'];
  fillOpacity: number;
  strokeOpacity: number;
  /** Group opacity, multiplied down — exact for what does not overlap. */
  opacity: number;
  color: string;
  fontSize: number;
  fontWeight: number;
  fontFamily: string;
  anchor: SceneText['anchor'];
  href: string | null;
  preserve: boolean;
  /** CSS-only properties a shape reads: `rx`/`ry` from a style. */
  rx?: string;
  ry?: string;
}

/** Properties an element sets for itself and its descendants, presentation
 *  attributes first and its `style` over them, as CSS has it. */
const PRESENTATION = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'fill-opacity',
  'stroke-opacity',
  'opacity',
  'color',
  'font-size',
  'font-weight',
  'font-family',
  'text-anchor',
];

function paintValue(value: string, state: State): string | null {
  const v = value.trim();
  if (v === '' || v === 'none' || v === 'transparent') return null;
  if (v === 'currentColor' || v === 'currentcolor') return state.color;
  return resolveColor(v);
}

function setProperty(
  state: State,
  name: string,
  raw: string,
  own: { rx?: string; ry?: string },
): void {
  if (name.startsWith('--')) {
    state.env.set(name, resolveVars(raw, state.env));
    return;
  }
  const value = resolveVars(raw, state.env).trim();
  if (value === '') return;
  switch (name) {
    case 'fill':
      state.fill = paintValue(value, state);
      break;
    case 'stroke':
      state.stroke = paintValue(value, state);
      break;
    case 'stroke-width':
      state.strokeWidth = number(value, state.strokeWidth);
      break;
    case 'stroke-dasharray': {
      if (value === 'none') {
        state.dash = null;
        break;
      }
      const parts = value
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);
      state.dash =
        parts.length && parts.every((n) => n >= 0 && Number.isFinite(n))
          ? parts.length % 2
            ? [...parts, ...parts]
            : parts
          : null;
      break;
    }
    case 'stroke-linecap':
      if (value === 'butt' || value === 'round' || value === 'square') {
        state.cap = value;
      }
      break;
    case 'stroke-linejoin':
      if (value === 'miter' || value === 'round' || value === 'bevel') {
        state.join = value;
      }
      break;
    case 'fill-opacity':
      state.fillOpacity = number(value, 1);
      break;
    case 'stroke-opacity':
      state.strokeOpacity = number(value, 1);
      break;
    case 'opacity':
      state.opacity *= Math.max(0, Math.min(1, number(value, 1)));
      break;
    case 'color':
      state.color = resolveColor(value);
      break;
    case 'font-size':
      state.fontSize = number(value, state.fontSize);
      break;
    case 'font-weight':
      state.fontWeight = weightOf(value, state.fontWeight);
      break;
    case 'font-family':
      state.fontFamily = value;
      break;
    case 'font': {
      // the shorthand ondine writes on its root: `16px monospace`
      const size = /(-?[\d.]+)px/.exec(value);
      if (size) state.fontSize = Number(size[1]);
      if (/\bbold\b/.test(value)) state.fontWeight = 700;
      break;
    }
    case 'text-anchor':
      if (value === 'start' || value === 'middle' || value === 'end') {
        state.anchor = value;
      }
      break;
    case 'rx':
      own.rx = value;
      break;
    case 'ry':
      own.ry = value;
      break;
  }
}

/** The state an element's children see, and what it says of itself. */
function enter(
  parent: State,
  attribs: Record<string, string>,
): { state: State; own: { rx?: string; ry?: string } } {
  const state: State = {
    ...parent,
    env: parent.env,
    rx: undefined,
    ry: undefined,
  };
  const own: { rx?: string; ry?: string } = {};
  const style = declarations(attribs.style);
  if (style.some(([name]) => name.startsWith('--'))) {
    state.env = new Map(parent.env);
  }
  // custom properties first, so a presentation attribute that reads one —
  // ondine's root writes `fill="var(--_fg)"` beside the `style` that sets
  // it — sees it
  for (const [name, value] of style) {
    if (name.startsWith('--')) setProperty(state, name, value, own);
  }
  for (const name of PRESENTATION) {
    const v = attribs[name];
    if (v !== undefined) setProperty(state, name, v, own);
  }
  for (const [name, value] of style) {
    if (!name.startsWith('--')) setProperty(state, name, value, own);
  }
  if (attribs['xml:space'] === 'preserve') state.preserve = true;
  const t = attribs.transform;
  if (t) state.matrix = multiply(state.matrix, parseTransform(t));
  return { state, own };
}

// --- the walk --------------------------------------------------------------------

/** Elements that draw nothing themselves and whose content is not drawn
 *  where it stands. */
const SKIPPED = new Set([
  'title',
  'desc',
  'metadata',
  'defs',
  'style',
  'script',
  'clipPath',
  'mask',
  'marker',
  'pattern',
  'symbol',
  'linearGradient',
  'radialGradient',
  'filter',
  'foreignObject',
]);

/** Where a nested `<svg>`'s viewBox lands in its parent: SVG's default
 *  `xMidYMid meet`. */
function viewportMatrix(attribs: Record<string, string>): Matrix {
  const x = number(attribs.x, 0);
  const y = number(attribs.y, 0);
  const box = (attribs.viewBox ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (box.length !== 4 || !box.every(Number.isFinite)) {
    return [1, 0, 0, 1, x, y];
  }
  const [vx, vy, vw, vh] = box;
  const w = number(attribs.width, vw);
  const h = number(attribs.height, vh);
  if (!(vw > 0) || !(vh > 0)) return [1, 0, 0, 1, x, y];
  const s = Math.min(w / vw, h / vh);
  const tx = x + (w - vw * s) / 2 - vx * s;
  const ty = y + (h - vh * s) / 2 - vy * s;
  return [s, 0, 0, s, tx, ty];
}

/** Text as SVG lays it out without `xml:space="preserve"`: line breaks gone,
 *  white space collapsed, the ends trimmed. */
function collapse(text: string): string {
  return text
    .replace(/[\r\n]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read ondine's SVG into a scene. `vars` are custom properties set before
 * the root's own — `--ondine-fg` and its kin, which the root reads with
 * fallbacks of black on white.
 */
export function parseScene(svg: string, vars: SceneVars = {}): MermaidScene {
  const items: SceneItem[] = [];
  const texts: SceneText[] = [];
  let width = 0;
  let height = 0;

  const base: State = {
    env: new Map(Object.entries(vars)),
    matrix: IDENTITY,
    fill: 'black',
    stroke: null,
    strokeWidth: 1,
    dash: null,
    cap: 'butt',
    join: 'miter',
    fillOpacity: 1,
    strokeOpacity: 1,
    opacity: 1,
    color: 'black',
    fontSize: 16,
    fontWeight: 400,
    fontFamily: 'monospace',
    anchor: 'start',
    href: null,
    preserve: false,
  };

  // one frame per open element; `skip` counts the depth inside an element
  // whose content is not drawn
  const stack: State[] = [base];
  let skip = 0;
  let root = true;

  // the `<text>` being read, and its runs
  interface Run {
    state: State;
    x: number;
    y: number;
    text: string;
  }
  let textRuns: Run[] | null = null;
  const runStack: Run[] = [];

  const shape = (state: State, segs: Seg[]): void => {
    if (!segs.length) return;
    const fill = state.fill;
    const stroke = state.stroke;
    if (!fill && !stroke) return;
    const m = state.matrix;
    const placed = transformSegs(segs, m);
    const k = lengthScale(m);
    items.push({
      kind: 'path',
      segs: placed,
      fill,
      stroke,
      strokeWidth: state.strokeWidth * k,
      dash: state.dash ? state.dash.map((d) => d * k) : null,
      cap: state.cap,
      join: state.join,
      fillOpacity: state.fillOpacity * state.opacity,
      strokeOpacity: state.strokeOpacity * state.opacity,
      href: state.href,
      bounds: segBounds(placed),
    });
  };

  const handler = {
    onopentag(name: string, attribs: Record<string, string>): void {
      if (skip) {
        skip += 1;
        return;
      }
      const parent = stack[stack.length - 1];
      if (SKIPPED.has(name) || attribs.display === 'none') {
        skip = 1;
        return;
      }
      const { state, own } = enter(parent, attribs);
      stack.push(state);

      switch (name) {
        case 'svg': {
          if (root) {
            root = false;
            const box = (attribs.viewBox ?? '')
              .split(/[\s,]+/)
              .filter(Boolean)
              .map(Number);
            if (box.length === 4 && box.every(Number.isFinite)) {
              width = box[2];
              height = box[3];
              state.matrix = multiply(state.matrix, [
                1,
                0,
                0,
                1,
                -box[0],
                -box[1],
              ]);
            } else {
              width = number(attribs.width, 0);
              height = number(attribs.height, 0);
            }
          } else {
            state.matrix = multiply(state.matrix, viewportMatrix(attribs));
          }
          break;
        }
        case 'a':
          state.href = attribs.href ?? attribs['xlink:href'] ?? state.href;
          break;
        case 'path':
          shape(state, parsePath(attribs.d ?? ''));
          break;
        case 'rect':
          shape(
            state,
            rectSegs(
              number(attribs.x, 0),
              number(attribs.y, 0),
              number(attribs.width, 0),
              number(attribs.height, 0),
              own.rx !== undefined
                ? number(own.rx, 0)
                : attribs.rx !== undefined
                  ? number(attribs.rx, 0)
                  : undefined,
              own.ry !== undefined
                ? number(own.ry, 0)
                : attribs.ry !== undefined
                  ? number(attribs.ry, 0)
                  : undefined,
            ),
          );
          break;
        case 'circle': {
          const r = number(attribs.r, 0);
          shape(
            state,
            ellipseSegs(number(attribs.cx, 0), number(attribs.cy, 0), r, r),
          );
          break;
        }
        case 'ellipse':
          shape(
            state,
            ellipseSegs(
              number(attribs.cx, 0),
              number(attribs.cy, 0),
              number(attribs.rx, 0),
              number(attribs.ry, 0),
            ),
          );
          break;
        case 'line':
          shape({ ...state, fill: null }, [
            { c: 'M', x: number(attribs.x1, 0), y: number(attribs.y1, 0) },
            { c: 'L', x: number(attribs.x2, 0), y: number(attribs.y2, 0) },
          ]);
          break;
        case 'polygon':
          shape(state, pointsSegs(attribs.points, true));
          break;
        case 'polyline':
          shape(state, pointsSegs(attribs.points, false));
          break;
        case 'text': {
          textRuns = [];
          const run: Run = {
            state,
            x: number(attribs.x, 0),
            y: number(attribs.y, 0),
            text: '',
          };
          textRuns.push(run);
          runStack.push(run);
          break;
        }
        case 'tspan': {
          if (!textRuns) break;
          const outer = runStack[runStack.length - 1];
          const run: Run = {
            state,
            x: attribs.x !== undefined ? number(attribs.x, 0) : outer.x,
            y: attribs.y !== undefined ? number(attribs.y, 0) : outer.y,
            text: '',
          };
          textRuns.push(run);
          runStack.push(run);
          break;
        }
      }
    },
    ontext(data: string): void {
      if (skip || !runStack.length) return;
      runStack[runStack.length - 1].text += data;
    },
    onclosetag(name: string): void {
      if (skip) {
        skip -= 1;
        return;
      }
      stack.pop();
      if (name === 'tspan' && textRuns) {
        runStack.pop();
      } else if (name === 'text' && textRuns) {
        runStack.length = 0;
        for (const run of textRuns) {
          const text = run.state.preserve ? run.text : collapse(run.text);
          if (!text || !run.state.fill) continue;
          const item: SceneText = {
            kind: 'text',
            text,
            x: run.x,
            y: run.y,
            anchor: run.state.anchor,
            size: run.state.fontSize,
            weight: run.state.fontWeight,
            family: run.state.fontFamily,
            fill: run.state.fill,
            opacity: run.state.fillOpacity * run.state.opacity,
            matrix: run.state.matrix,
            href: run.state.href,
          };
          items.push(item);
          texts.push(item);
        }
        textRuns = null;
      }
    },
  };

  const parser = new Parser(handler, { xmlMode: true, decodeEntities: true });
  parser.write(svg);
  parser.end();

  return { width, height, items, texts: readingOrder(texts) };
}

/** Where a run's baseline lands in diagram units, and how big it is there. */
export function placedAnchor(t: SceneText): {
  x: number;
  y: number;
  size: number;
  upright: boolean;
} {
  const [x, y] = apply(t.matrix, t.x, t.y);
  const m = t.matrix;
  // a run drawn upright and unskewed needs no transform of its own
  const upright = m[1] === 0 && m[2] === 0 && m[0] > 0 && m[3] > 0;
  return {
    x,
    y,
    size: t.size * (isTranslation(m) ? 1 : lengthScale(m)),
    upright,
  };
}

/** Top to bottom, then left to right: two runs whose baselines are within
 *  half a line of each other read as one row. ondine writes edges before
 *  nodes and a label wherever its group is, so the document's own order
 *  reads as noise. */
function readingOrder(texts: SceneText[]): SceneText[] {
  const keyed = texts.map((t, i) => ({ t, i, at: placedAnchor(t) }));
  keyed.sort((a, b) => a.at.y - b.at.y || a.i - b.i);
  const rows: (typeof keyed)[] = [];
  for (const k of keyed) {
    const row = rows[rows.length - 1];
    if (
      row &&
      Math.abs(k.at.y - row[0].at.y) < 0.5 * Math.max(1, row[0].at.size)
    ) {
      row.push(k);
    } else {
      rows.push([k]);
    }
  }
  return rows.flatMap((row) =>
    row.sort((a, b) => a.at.x - b.at.x || a.i - b.i).map((k) => k.t),
  );
}
