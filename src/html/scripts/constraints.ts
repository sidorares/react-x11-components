// Media Capture's constrainable pattern on the host's side: the settings a
// page's constraints come to on a source, or the name of the one they
// cannot meet (Media Capture and Streams 4.3.8, SelectSettings and the
// ApplyConstraints algorithm). `getUserMedia` chooses a device and its
// settings with it, and `applyConstraints` a track's new settings
// (`media-sources.ts`).
//
// Pure: what a source can do in, a settings dictionary or a constraint's
// name out, and nothing of the page's realm. What crosses from the page is
// its constraints as JSON, which are read here as Web IDL would have read
// the dictionaries: `[Clamp] unsigned long` for a size, a sample rate or a
// channel count, a bare value an ideal at the top and exact in `advanced`,
// a name this user agent does not know dropped.
//
// A camera's settings dictionaries are each of its native modes at
// `resizeMode: 'none'`, and anything no larger and no faster than one at
// `'crop-and-scale'`, which 4.3.8 has every `'none'` dictionary come with.
// A candidate here is such a space, a range for each number and a list for
// each string or boolean, and a required constraint narrows it. Which
// required constraint failed is the first that leaves no candidate, in the
// order a device is narrowed to a mode and a mode to its sizes: so
// `{width: {exact: 639}, resizeMode: {exact: 'none'}}` fails on `width`,
// as Chromium's does, where no one constraint fails every dictionary.

import type {
  MediaDeviceCapabilities,
  MediaMode,
  MediaRange,
  MediaSettings,
} from '../media-devices.js';

/** A page's constraint set: `MediaTrackConstraints`, as JSON. */
export type ConstraintSet = Record<string, unknown>;

/** A source as its constraints are fitted to it. */
export interface Constrainable {
  kind: 'audio' | 'video';
  /** Its ids as the page sees them, which only a device's track has. */
  deviceId?: string;
  groupId?: string;
  capabilities: MediaDeviceCapabilities;
  /** What it runs at where nothing asks otherwise. */
  defaults: MediaSettings;
  /** A camera's native modes, the first its default. */
  modes?: MediaMode[];
  /** Settings that cannot change: a source that is no device, whose one
   *  settings dictionary is what it runs at. */
  fixed?: MediaSettings;
}

/** The settings a source's constraints came to. */
export type SelectedSettings = MediaSettings & {
  deviceId?: string;
  groupId?: string;
};

export type Selection =
  | { index: number; settings: SelectedSettings; distance: number }
  | { failed: string };

/** The order a failed constraint is looked for in. */
const ORDER = [
  'deviceId',
  'groupId',
  'facingMode',
  'resizeMode',
  'width',
  'height',
  'aspectRatio',
  'frameRate',
  'sampleRate',
  'sampleSize',
  'channelCount',
  'latency',
  'echoCancellation',
  'autoGainControl',
  'noiseSuppression',
  'voiceIsolation',
] as const;

/** The constrainable properties this user agent knows, which
 *  `getSupportedConstraints()` lists. */
export const SUPPORTED_CONSTRAINTS: readonly string[] = ORDER;

const VIDEO = new Set<string>([
  'width',
  'height',
  'aspectRatio',
  'frameRate',
  'facingMode',
  'resizeMode',
]);
const AUDIO = new Set<string>([
  'sampleRate',
  'sampleSize',
  'channelCount',
  'latency',
  'echoCancellation',
  'autoGainControl',
  'noiseSuppression',
  'voiceIsolation',
]);
/** `[Clamp] unsigned long`, where the others are doubles. */
const INTEGER = new Set<string>([
  'width',
  'height',
  'sampleRate',
  'sampleSize',
  'channelCount',
]);
const NUMBER = new Set<string>([
  'width',
  'height',
  'aspectRatio',
  'frameRate',
  'sampleRate',
  'sampleSize',
  'channelCount',
  'latency',
]);
const BOOLEAN = new Set<string>([
  'autoGainControl',
  'noiseSuppression',
  'voiceIsolation',
]);

type Value = string | boolean;

/** A constraint as read: its required part and its ideal. */
interface Parsed {
  /** For a number. */
  min?: number;
  max?: number;
  /** For a string or a boolean: the values that satisfy it. */
  oneOf?: Value[];
  required: boolean;
  /** A number, or the values any of which is ideal. */
  ideal?: number | Value[];
  /** A bare boolean on a property that is not one: whether it is asked to
   *  exist (4.3.8's "constraintValue is a boolean"). */
  exists?: boolean;
}

/** A candidate: what a source can still be set to. */
interface Space {
  /** The source it is of. */
  of: number;
  nums: Map<string, [number, number]>;
  strs: Map<string, Value[]>;
  /** What a setting is where nothing asks otherwise. */
  prefer: Record<string, number | Value | undefined>;
  /** Width, height and their ratio are one choice. */
  framed: boolean;
}

/** Web IDL's `[Clamp] unsigned long`: rounded half to even, held to
 *  0..2^32 - 1. */
function ulong(v: unknown): number {
  let n = Number(v);
  if (Number.isNaN(n)) return 0;
  n = Math.min(4294967295, Math.max(0, n));
  const floor = Math.floor(n);
  const frac = n - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function number(name: string, v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (INTEGER.has(name)) return ulong(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** A `ConstrainDOMString`'s, a `ConstrainBoolean`'s or echo
 *  cancellation's value as a list; empty is no constraint. */
function values(name: string, v: unknown): Value[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (BOOLEAN.has(name)) return [typeof v === 'boolean' ? v : !!v];
  if (name === 'echoCancellation') {
    if (typeof v === 'boolean') return [v];
    return Array.isArray(v) ? v.map((x) => x as Value) : [String(v)];
  }
  const list = Array.isArray(v) ? v.map(String) : [String(v)];
  return list.length ? list : undefined;
}

/** A constraint as Web IDL has it, bare values `bare`. */
function parse(
  name: string,
  value: unknown,
  bare: 'ideal' | 'exact',
): Parsed | null {
  if (value === undefined || value === null) return null;
  const object =
    typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (NUMBER.has(name)) {
    if (typeof value === 'boolean') {
      return { required: bare === 'exact', exists: value };
    }
    if (!object) {
      const n = number(name, value);
      if (n === undefined) return null;
      return bare === 'exact'
        ? { min: n, max: n, required: true }
        : { ideal: n, required: false };
    }
    const exact = number(name, object.exact);
    const min = number(name, object.min);
    const max = number(name, object.max);
    const ideal = number(name, object.ideal);
    const out: Parsed = { required: false };
    if (exact !== undefined) {
      out.min = exact;
      out.max = exact;
    }
    if (min !== undefined) out.min = Math.max(out.min ?? -Infinity, min);
    if (max !== undefined) out.max = Math.min(out.max ?? Infinity, max);
    out.required = out.min !== undefined || out.max !== undefined;
    if (ideal !== undefined) out.ideal = ideal;
    return out.required || ideal !== undefined ? out : null;
  }
  if (typeof value === 'boolean' && !BOOLEAN.has(name)) {
    if (name !== 'echoCancellation') {
      return { required: bare === 'exact', exists: value };
    }
  }
  if (!object) {
    const list = values(name, value);
    if (!list) return null;
    return bare === 'exact'
      ? { oneOf: list, required: true }
      : { ideal: list, required: false };
  }
  const exact = values(name, object.exact);
  const ideal = values(name, object.ideal);
  if (!exact && !ideal) return null;
  return {
    ...(exact ? { oneOf: exact } : {}),
    ...(ideal ? { ideal } : {}),
    required: !!exact,
  };
}

/** Whether a property is one a source of this kind has at all. */
function applies(name: string, kind: 'audio' | 'video'): boolean {
  return kind === 'video' ? !AUDIO.has(name) : !VIDEO.has(name);
}

const range = (r: MediaRange | undefined, fallback?: number) =>
  r
    ? ([r.min, r.max] as [number, number])
    : fallback !== undefined
      ? ([fallback, fallback] as [number, number])
      : undefined;

/** The candidates of one source. */
function spacesOf(c: Constrainable, of: number): Space[] {
  const ids = (strs: Map<string, Value[]>) => {
    if (c.deviceId !== undefined) strs.set('deviceId', [c.deviceId]);
    if (c.groupId !== undefined) strs.set('groupId', [c.groupId]);
  };
  if (c.fixed) {
    const nums = new Map<string, [number, number]>();
    const strs = new Map<string, Value[]>();
    for (const [key, v] of Object.entries(c.fixed)) {
      if (!applies(key, c.kind) || v === undefined) continue;
      if (typeof v === 'number') nums.set(key, [v, v]);
      else strs.set(key, [v as Value]);
    }
    ids(strs);
    return [{ of, nums, strs, prefer: { ...c.fixed }, framed: false }];
  }
  const caps = c.capabilities;
  const d = c.defaults;
  if (c.kind === 'audio') {
    const nums = new Map<string, [number, number]>();
    const strs = new Map<string, Value[]>();
    for (const key of [
      'sampleRate',
      'sampleSize',
      'channelCount',
      'latency',
    ] as const) {
      const r = range(caps[key], d[key]);
      if (r) nums.set(key, r);
    }
    for (const key of [
      'echoCancellation',
      'autoGainControl',
      'noiseSuppression',
      'voiceIsolation',
    ] as const) {
      const list: Value[] | undefined = caps[key]?.length
        ? caps[key]
        : d[key] !== undefined
          ? [d[key]!]
          : undefined;
      if (list) strs.set(key, list);
    }
    ids(strs);
    return [{ of, nums, strs, prefer: { ...d }, framed: false }];
  }
  const modes: MediaMode[] = c.modes?.length
    ? c.modes
    : [
        {
          width: d.width ?? caps.width?.max ?? 640,
          height: d.height ?? caps.height?.max ?? 480,
          frameRate: d.frameRate ?? caps.frameRate?.max ?? 30,
        },
      ];
  const facing = caps.facingMode?.length
    ? caps.facingMode
    : d.facingMode
      ? [d.facingMode]
      : undefined;
  const out: Space[] = [];
  for (const resize of ['none', 'crop-and-scale'] as const) {
    for (const m of modes) {
      const nums = new Map<string, [number, number]>();
      const strs = new Map<string, Value[]>();
      if (resize === 'none') {
        nums.set('width', [m.width, m.width]);
        nums.set('height', [m.height, m.height]);
        nums.set('frameRate', [m.frameRate, m.frameRate]);
        nums.set('aspectRatio', [m.width / m.height, m.width / m.height]);
      } else {
        const wlo = Math.max(1, caps.width?.min ?? 1);
        const hlo = Math.max(1, caps.height?.min ?? 1);
        const flo = (caps.frameRate?.min ?? 0) > 0 ? caps.frameRate!.min : 1;
        nums.set('width', [Math.min(wlo, m.width), m.width]);
        nums.set('height', [Math.min(hlo, m.height), m.height]);
        nums.set('frameRate', [Math.min(flo, m.frameRate), m.frameRate]);
        nums.set('aspectRatio', [wlo / m.height, m.width / hlo]);
      }
      strs.set('resizeMode', [resize]);
      if (facing) strs.set('facingMode', facing);
      ids(strs);
      out.push({
        of,
        nums,
        strs,
        prefer: {
          width: m.width,
          height: m.height,
          frameRate: m.frameRate,
          aspectRatio: m.width / m.height,
          resizeMode: resize,
          facingMode: d.facingMode ?? facing?.[0],
        },
        framed: true,
      });
    }
  }
  return out;
}

/** A space narrowed to a required constraint, or null where nothing of
 *  it satisfies the constraint. */
function narrow(space: Space, name: string, c: Parsed): Space | null {
  if (!c.required) return space;
  const has = space.nums.has(name) || space.strs.has(name);
  if (c.exists !== undefined) return c.exists === has ? space : null;
  if (!has) return null;
  if (c.oneOf) {
    const list = space.strs.get(name);
    if (!list) return null;
    const kept = list.filter((v) => c.oneOf!.includes(v));
    if (!kept.length) return null;
    const strs = new Map(space.strs);
    strs.set(name, kept);
    return { ...space, strs };
  }
  const r = space.nums.get(name);
  if (!r) return null;
  let lo = Math.max(r[0], c.min ?? -Infinity);
  let hi = Math.min(r[1], c.max ?? Infinity);
  if (INTEGER.has(name)) {
    lo = Math.ceil(lo);
    hi = Math.floor(hi);
  }
  if (lo > hi) return null;
  const nums = new Map(space.nums);
  nums.set(name, [lo, hi]);
  const next = { ...space, nums };
  return fits(next) ? next : null;
}

/** Whether a camera's width, height and ratio can still meet. */
function fits(space: Space): boolean {
  if (!space.framed) return true;
  const [wlo, whi] = space.nums.get('width')!;
  const [hlo, hhi] = space.nums.get('height')!;
  const [alo, ahi] = space.nums.get('aspectRatio')!;
  const eps = 1e-9;
  return whi / hlo >= alo - eps && wlo / hhi <= ahi + eps;
}

const fit = (v: number, r: [number, number], integer: boolean): number => {
  const n = integer ? Math.round(v) : v;
  return Math.min(r[1], Math.max(r[0], n));
};

/** The settings a space comes to: each as near its ideal as it can be, or
 *  else what it runs at where nothing asks. */
function settle(
  space: Space,
  ideals: Map<string, number | Value[]>,
): SelectedSettings {
  const out: Record<string, number | Value> = {};
  for (const [name, r] of space.nums) {
    if (space.framed && (name === 'width' || name === 'height')) continue;
    if (space.framed && name === 'aspectRatio') continue;
    const ideal = ideals.get(name);
    const target =
      typeof ideal === 'number' ? ideal : (space.prefer[name] as number);
    out[name] = fit(target ?? r[0], r, INTEGER.has(name));
  }
  if (space.framed) {
    const wr = space.nums.get('width')!;
    const hr = space.nums.get('height')!;
    const [alo, ahi] = space.nums.get('aspectRatio')!;
    const W = space.prefer.width as number;
    const H = space.prefer.height as number;
    const iw = ideals.get('width') as number | undefined;
    const ih = ideals.get('height') as number | undefined;
    const ia = ideals.get('aspectRatio') as number | undefined;
    let w: number;
    let h: number;
    if (iw !== undefined && ih !== undefined) {
      w = fit(iw, wr, true);
      h = fit(ih, hr, true);
    } else if (iw !== undefined) {
      w = fit(iw, wr, true);
      h = fit(ia !== undefined ? w / ia : (w * H) / W, hr, true);
    } else if (ih !== undefined) {
      h = fit(ih, hr, true);
      w = fit(ia !== undefined ? h * ia : (h * W) / H, wr, true);
    } else if (ia !== undefined) {
      w = fit(W, wr, true);
      h = fit(w / ia, hr, true);
      if (Math.abs(w / h - ia) > 1e-9) w = fit(h * ia, wr, true);
    } else {
      // the mode's own size, or as much of it as a limit leaves, its ratio
      // kept: `width: {max: 30}` is a frame 30 wide, not a strip
      const scale = Math.min(1, wr[1] / W, hr[1] / H);
      w = fit(W * scale, wr, true);
      h = fit(H * scale, hr, true);
    }
    // held to the ratio a required constraint asks for
    if (w / h < alo) {
      h = fit(w / alo, hr, true);
      if (w / h < alo) w = fit(h * alo, wr, true);
    } else if (w / h > ahi) {
      h = fit(w / ahi, hr, true);
      if (w / h > ahi) w = fit(h * ahi, wr, true);
    }
    out.width = w;
    out.height = h;
    out.aspectRatio = w / h;
  }
  for (const [name, list] of space.strs) {
    const ideal = ideals.get(name);
    const wanted = Array.isArray(ideal)
      ? list.find((v) => ideal.includes(v))
      : undefined;
    const prefer = space.prefer[name];
    out[name] =
      wanted ??
      (prefer !== undefined && list.includes(prefer as Value)
        ? (prefer as Value)
        : list[0]);
  }
  return out as SelectedSettings;
}

/** 4.3.8's fitness distance of settings from a set's ideals. */
function distance(
  settings: SelectedSettings,
  set: Map<string, Parsed>,
): number {
  let sum = 0;
  const s = settings as Record<string, number | Value | undefined>;
  for (const [name, c] of set) {
    const actual = s[name];
    if (c.exists !== undefined) {
      sum += c.exists === (actual !== undefined) ? 0 : 1;
      continue;
    }
    if (c.ideal === undefined) continue;
    if (actual === undefined) {
      sum += 1;
      continue;
    }
    if (typeof c.ideal === 'number') {
      const a = Number(actual);
      sum +=
        a === c.ideal
          ? 0
          : Math.abs(a - c.ideal) / Math.max(Math.abs(a), Math.abs(c.ideal));
    } else {
      sum += c.ideal.includes(actual as Value) ? 0 : 1;
    }
  }
  return sum;
}

/** A set's constraints this user agent knows and that apply to the kind,
 *  read with bare values `bare`. */
function read(
  set: ConstraintSet,
  kind: 'audio' | 'video',
  bare: 'ideal' | 'exact',
): Map<string, Parsed> {
  const out = new Map<string, Parsed>();
  for (const name of ORDER) {
    if (!Object.prototype.hasOwnProperty.call(set, name)) continue;
    if (!applies(name, kind)) continue;
    const parsed = parse(name, set[name], bare);
    if (parsed) out.set(name, parsed);
  }
  return out;
}

/**
 * SelectSettings over the sources of one kind — the devices a
 * `getUserMedia` chooses among, or the one source an `applyConstraints`
 * sets — with the settings dictionary of least fitness distance, the
 * source it is of first among equals; or the required constraint that left
 * none.
 */
export function selectSettings(
  sources: Constrainable[],
  constraints: ConstraintSet,
): Selection {
  const kind = sources[0]?.kind ?? 'video';
  const basic = read(constraints, kind, 'ideal');
  let spaces = sources.flatMap((c, i) => spacesOf(c, i));
  for (const [name, c] of basic) {
    if (!c.required) continue;
    spaces = spaces.flatMap((s) => narrow(s, name, c) ?? []);
    if (!spaces.length) return { failed: name };
  }
  const advanced = Array.isArray(constraints.advanced)
    ? constraints.advanced
    : [];
  for (const set of advanced) {
    if (!set || typeof set !== 'object') continue;
    let next = spaces;
    for (const [name, c] of read(set as ConstraintSet, kind, 'exact')) {
      next = next.flatMap((s) => narrow(s, name, c) ?? []);
    }
    if (next.length) spaces = next;
  }
  const ideals = new Map<string, number | Value[]>();
  for (const [name, c] of basic) {
    if (c.ideal !== undefined) ideals.set(name, c.ideal);
  }
  let best: { index: number; settings: SelectedSettings; distance: number } =
    null!;
  for (const space of spaces) {
    const settings = settle(space, ideals);
    const d = distance(settings, basic);
    if (!best || d < best.distance) {
      best = { index: space.of, settings, distance: d };
    }
  }
  return best;
}
