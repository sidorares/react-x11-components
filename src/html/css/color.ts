// CSS Color 4's functional colours: read here, and written back in the one
// form every drawing context reads — `#rrggbb`, or `rgba(r, g, b, a)` with
// channels from 0 to 255.
//
// They used to be handed to the context as written, since ntk's context
// parses a CSS colour for `fillStyle` itself. It reads less than CSS has: the
// comma forms of `rgb()` and `hsl()` and nothing else — no space-separated
// `rgb(59 130 246 / 1)`, which Tailwind 3's utilities are written in, no
// `oklch()`, which Tailwind 4's palette is, no `lab()`, `hwb()` or `color()`
// — and it read `rgb()`'s percentages as numbers from 0 to 255, so
// `rgb(0%, 50%, 0%)` was nearly black. Reading the value here also leaves a
// document one reading of a colour on both backends.
//
// A colour outside sRGB is clipped into it channel by channel, which is what
// an sRGB drawing context can show.

/** The value of a colour function, or null where it is not one. */
export function functionalColor(value: string): string | null {
  let hit = CACHE.get(value);
  if (hit === undefined) {
    hit = readFunction(value);
    // a document repeats its colours, a utility stylesheet most of all
    if (CACHE.size >= 1024) CACHE.clear();
    CACHE.set(value, hit);
  }
  return hit;
}

const CACHE = new Map<string, string | null>();

type Unit = '' | '%' | 'deg' | 'grad' | 'rad' | 'turn' | 'none';

interface Component {
  value: number;
  unit: Unit;
}

const NUMBER = /^([+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)(%|deg|grad|rad|turn)?$/i;

function component(token: string): Component | null {
  if (token.toLowerCase() === 'none') return { value: 0, unit: 'none' };
  const m = NUMBER.exec(token);
  if (!m) return null;
  return {
    value: parseFloat(m[1]),
    unit: (m[2] ?? '').toLowerCase() as Unit,
  };
}

function readFunction(value: string): string | null {
  const open = value.indexOf('(');
  if (open < 0) return null;
  const name = value.slice(0, open).toLowerCase();
  let body = value.slice(open + 1);
  // the end of a style sheet closes whatever is still open (CSS 2.1 4.2):
  // `rgb(0, 128, 0` as a sheet's last words is green
  if (body.endsWith(')')) body = body.slice(0, -1);
  // `calc()`, `var()`, a relative colour's channel keywords: not read here,
  // and a declaration this cannot read is dropped
  if (body.includes('(') || body.includes(')')) return null;

  let channels: Component[];
  let alpha: Component | null = null;
  let space = '';
  if (body.includes(',')) {
    // the legacy comma form, which only these four have
    if (!LEGACY.has(name)) return null;
    const parts = body.split(',');
    if (parts.length !== 3 && parts.length !== 4) return null;
    const read: Component[] = [];
    for (const part of parts) {
      const token = part.trim();
      if (!token || /\s/.test(token)) return null;
      const c = component(token);
      if (!c || c.unit === 'none') return null;
      read.push(c);
    }
    channels = read.slice(0, 3);
    alpha = read[3] ?? null;
    if (name === 'rgb' || name === 'rgba') {
      // all numbers or all percentages
      const unit = channels[0].unit;
      if (unit !== '' && unit !== '%') return null;
      if (channels[1].unit !== unit || channels[2].unit !== unit) return null;
    } else if (channels[1].unit !== '%' || channels[2].unit !== '%') {
      return null;
    }
  } else {
    const slash = body.split('/');
    if (slash.length > 2) return null;
    const tokens = slash[0].trim().split(/\s+/);
    if (name === 'color') space = (tokens.shift() ?? '').toLowerCase();
    if (tokens.length !== 3) return null;
    const read: Component[] = [];
    for (const token of tokens) {
      const c = component(token);
      if (!c) return null;
      read.push(c);
    }
    channels = read;
    if (slash.length === 2) {
      const token = slash[1].trim();
      if (!token || /\s/.test(token)) return null;
      alpha = component(token);
      if (!alpha) return null;
    }
  }

  let a = 1;
  if (alpha) {
    if (alpha.unit !== '' && alpha.unit !== '%' && alpha.unit !== 'none') {
      return null;
    }
    a = clamp01(alpha.unit === '%' ? alpha.value / 100 : alpha.value);
  }
  const rgb = toSrgb(name, space, channels);
  return rgb ? serialize(rgb, a) : null;
}

const LEGACY = new Set(['rgb', 'rgba', 'hsl', 'hsla']);

/** A channel as a number, or null where its unit is not one it takes:
 *  `pct` is what 100% means for it. */
function amount(c: Component, pct: number): number | null {
  if (c.unit === '') return c.value;
  if (c.unit === 'none') return 0;
  if (c.unit === '%') return (c.value / 100) * pct;
  return null;
}

function hue(c: Component): number | null {
  switch (c.unit) {
    case '':
    case 'deg':
      return c.value;
    case 'grad':
      return c.value * 0.9;
    case 'rad':
      return (c.value * 180) / Math.PI;
    case 'turn':
      return c.value * 360;
    case 'none':
      return 0;
    default:
      return null;
  }
}

type Triple = [number, number, number];

/** The colour in gamma-encoded sRGB, each channel from 0 to 1 (before
 *  clipping), or null where a channel is not one its function takes. */
function toSrgb(name: string, space: string, c: Component[]): Triple | null {
  switch (name) {
    case 'rgb':
    case 'rgba': {
      const r = amount(c[0], 255);
      const g = amount(c[1], 255);
      const b = amount(c[2], 255);
      if (r === null || g === null || b === null) return null;
      return [r / 255, g / 255, b / 255];
    }
    case 'hsl':
    case 'hsla': {
      const h = hue(c[0]);
      const s = amount(c[1], 100);
      const l = amount(c[2], 100);
      if (h === null || s === null || l === null) return null;
      return hslToRgb(h, clamp01(s / 100), clamp01(l / 100));
    }
    case 'hwb': {
      const h = hue(c[0]);
      const w = amount(c[1], 100);
      const b = amount(c[2], 100);
      if (h === null || w === null || b === null) return null;
      return hwbToRgb(h, clamp01(w / 100), clamp01(b / 100));
    }
    case 'lab':
    case 'lch': {
      const l = amount(c[0], 100);
      if (l === null) return null;
      let a: number | null;
      let b: number | null;
      if (name === 'lab') {
        a = amount(c[1], 125);
        b = amount(c[2], 125);
      } else {
        const chroma = amount(c[1], 150);
        const h = hue(c[2]);
        if (chroma === null || h === null) return null;
        [a, b] = polar(Math.max(0, chroma), h);
      }
      if (a === null || b === null) return null;
      // the gamut mapping CSS draws with takes a lightness at either end to
      // white or black, whatever its chroma (CSS Color 4 13.2)
      if (l >= 100) return [1, 1, 1];
      if (l <= 0) return [0, 0, 0];
      const xyz = labToXyzD50(l, a, b);
      return gamma(multiply(XYZ_TO_LINEAR_SRGB, multiply(D50_TO_D65, xyz)));
    }
    case 'oklab':
    case 'oklch': {
      const l = amount(c[0], 1);
      if (l === null) return null;
      let a: number | null;
      let b: number | null;
      if (name === 'oklab') {
        a = amount(c[1], 0.4);
        b = amount(c[2], 0.4);
      } else {
        const chroma = amount(c[1], 0.4);
        const h = hue(c[2]);
        if (chroma === null || h === null) return null;
        [a, b] = polar(Math.max(0, chroma), h);
      }
      if (a === null || b === null) return null;
      if (l >= 1) return [1, 1, 1];
      if (l <= 0) return [0, 0, 0];
      return gamma(oklabToLinearSrgb(l, a, b));
    }
    case 'color': {
      const v: number[] = [];
      for (const channel of c) {
        const x = amount(channel, 1);
        if (x === null) return null;
        v.push(x);
      }
      return predefined(space, v as Triple);
    }
    default:
      return null;
  }
}

/** One of `color()`'s predefined spaces, in gamma-encoded sRGB. */
function predefined(space: string, v: Triple): Triple | null {
  switch (space) {
    case 'srgb':
      return v;
    case 'srgb-linear':
      return gamma(v);
    case 'display-p3':
      return fromXyzD65(multiply(P3_TO_XYZ, v.map(srgbLinear) as Triple));
    case 'display-p3-linear':
      return fromXyzD65(multiply(P3_TO_XYZ, v));
    case 'a98-rgb':
      return fromXyzD65(
        multiply(
          A98_TO_XYZ,
          v.map((x) => Math.sign(x) * Math.abs(x) ** (563 / 256)) as Triple,
        ),
      );
    case 'prophoto-rgb':
      return fromXyzD65(
        multiply(
          D50_TO_D65,
          multiply(PROPHOTO_TO_XYZ_D50, v.map(prophotoLinear) as Triple),
        ),
      );
    case 'rec2020':
      return fromXyzD65(
        multiply(REC2020_TO_XYZ, v.map(rec2020Linear) as Triple),
      );
    case 'xyz':
    case 'xyz-d65':
      return fromXyzD65(v);
    case 'xyz-d50':
      return fromXyzD65(multiply(D50_TO_D65, v));
    default:
      return null;
  }
}

function serialize(rgb: Triple, a: number): string {
  const [r, g, b] = rgb.map((x) => Math.round(clamp01(x) * 255));
  if (a === 1) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function polar(chroma: number, h: number): [number, number] {
  const rad = (h * Math.PI) / 180;
  return [chroma * Math.cos(rad), chroma * Math.sin(rad)];
}

// --- the conversions: CSS Color 4's sample code (§18) -----------------------

function hslToRgb(h: number, s: number, l: number): Triple {
  const hue = ((h % 360) + 360) % 360;
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function hwbToRgb(h: number, w: number, b: number): Triple {
  if (w + b >= 1) {
    const gray = w / (w + b);
    return [gray, gray, gray];
  }
  const rgb = hslToRgb(h, 1, 0.5);
  return rgb.map((x) => x * (1 - w - b) + w) as Triple;
}

const KAPPA = 24389 / 27;
const EPSILON = 216 / 24389;
const D50_WHITE: Triple = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

function labToXyzD50(l: number, a: number, b: number): Triple {
  const f1 = (l + 16) / 116;
  const f0 = a / 500 + f1;
  const f2 = f1 - b / 200;
  const x = f0 ** 3 > EPSILON ? f0 ** 3 : (116 * f0 - 16) / KAPPA;
  const y = l > KAPPA * EPSILON ? f1 ** 3 : l / KAPPA;
  const z = f2 ** 3 > EPSILON ? f2 ** 3 : (116 * f2 - 16) / KAPPA;
  return [x * D50_WHITE[0], y * D50_WHITE[1], z * D50_WHITE[2]];
}

function oklabToLinearSrgb(l: number, a: number, b: number): Triple {
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1,
    -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1,
    -0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1,
  ];
}

function fromXyzD65(xyz: Triple): Triple {
  return gamma(multiply(XYZ_TO_LINEAR_SRGB, xyz));
}

function srgbLinear(x: number): number {
  const abs = Math.abs(x);
  return abs <= 0.04045
    ? x / 12.92
    : Math.sign(x) * ((abs + 0.055) / 1.055) ** 2.4;
}

function gamma(rgb: Triple): Triple {
  return rgb.map((x) => {
    const abs = Math.abs(x);
    return abs > 0.0031308
      ? Math.sign(x) * (1.055 * abs ** (1 / 2.4) - 0.055)
      : 12.92 * x;
  }) as Triple;
}

function prophotoLinear(x: number): number {
  const abs = Math.abs(x);
  return abs <= 16 / 512 ? x / 16 : Math.sign(x) * abs ** 1.8;
}

function rec2020Linear(x: number): number {
  const alpha = 1.09929682680944;
  const beta = 0.018053968510807;
  const abs = Math.abs(x);
  return abs < beta * 4.5
    ? x / 4.5
    : Math.sign(x) * ((abs + alpha - 1) / alpha) ** (1 / 0.45);
}

function multiply(m: readonly Triple[], v: Triple): Triple {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

// Each takes its space's white to its white point's XYZ, which the tests
// check by sending white through every space.

const XYZ_TO_LINEAR_SRGB: readonly Triple[] = [
  [12831 / 3959, -329 / 214, -1974 / 3959],
  [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
  [705 / 12673, -2585 / 12673, 705 / 667],
];

const D50_TO_D65: readonly Triple[] = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];

const P3_TO_XYZ: readonly Triple[] = [
  [608311 / 1250200, 189793 / 714400, 198249 / 1000160],
  [35783 / 156275, 247089 / 357200, 198249 / 2500400],
  [0, 32229 / 714400, 5220557 / 5000800],
];

const A98_TO_XYZ: readonly Triple[] = [
  [573536 / 994567, 263643 / 1420810, 187206 / 994567],
  [591459 / 1989134, 6239551 / 9945670, 374412 / 4972835],
  [53769 / 1989134, 351524 / 4972835, 4929758 / 4972835],
];

const PROPHOTO_TO_XYZ_D50: readonly Triple[] = [
  [0.7977666449006423, 0.13518129740053308, 0.0313477341283922],
  [0.2880748288194013, 0.711835234241873, 0.00008993693872564],
  [0, 0, 0.8251046025104602],
];

const REC2020_TO_XYZ: readonly Triple[] = [
  [63426534 / 99577255, 20160776 / 139408157, 47086771 / 278816314],
  [26158966 / 99577255, 472592308 / 697040785, 8267143 / 139408157],
  [0, 19567812 / 697040785, 295819943 / 278816314],
];
