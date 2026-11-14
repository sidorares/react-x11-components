// SMIL in a drawing, as a page's scripts see it (SVG Animations 2, over
// SMIL 3's timing): `<animate>`, `<set>`, `<animateTransform>` and
// `<animateMotion>` run on the document's timeline, which `<svg>`'s
// `pauseAnimations()`, `setCurrentTime()` and their kin drive, and what they
// set is what an attribute's `animVal`, `getComputedStyle()`, `getBBox()`
// and `getCTM()` read.
//
// **This function is source text**, as `installSvgDom` is (`svg-dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing, and `installDom` calls it with what it needs.
//
// Nothing is kept of a timeline but what cannot be worked out again: the
// instance times events and `beginElement()` added, and what each element was
// at the last update, for its events. Everything else — each element's
// intervals, which of them holds the document's time, what the values are —
// is worked out from the attributes as it is asked for, once for a time and
// a count of the tree's changes (`epoch`). So an attribute a script changes
// is in the next read, and a seek is a number.
//
// What an animation sets is handed to the host (`push`), as the text of the
// attribute it animates, so that what `svg-geometry.ts` answers is of the
// animated drawing; a computed style is laid over here (`styleOf`), since a
// style is the host's and inheritance only needs to be followed up.

/** What `installDom` hands this. */
export interface SmilDeps {
  DOMException: unknown;
  Event: unknown;
  /** An event dispatched as the user agent does. */
  fire(target: unknown, event: unknown): void;
  /** A timer of the facade's own, which a page's cannot cancel. */
  later(fn: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
  /** The document whose timeline this is. */
  document(): unknown;
  /** Milliseconds, monotonic. */
  now(): number;
  /** An attribute's value as the tree keeps it, by SVG's spelling. */
  getAttr(el: unknown, name: string): string | null;
  /** What the host computes a property to, without animation: '' where
   *  it answers nothing. */
  computed(el: unknown, property: string): string;
  /** What moves wherever the tree or an attribute may have changed. */
  epoch(): number;
  /** The elements of the document that animate, in tree order. */
  animations(): unknown[];
  /** What one of a relative unit comes to for an element, in CSS pixels. */
  unitSize(el: unknown, unit: string, axis: string): number | null;
  /** A colour as `[r, g, b, a]`, each 0 to 255, or null where it is none. */
  color(text: string): number[] | null;
  /** Hands the host the attributes animation changed, by element: a value,
   *  or null where an attribute is no longer animated. */
  push(changes: Array<[unknown, Record<string, string | null>]>): void;
  /** Whether an element is an SVG element. */
  isSvg(el: unknown): boolean;
  /** Runs `fn` once the document's `load` has been told. */
  onLoad(fn: () => void): void;
  /** The language the user reads, for `systemLanguage`. */
  languages(): string[];
  /** An `on<type>` content attribute's handler, compiled as the facade's
   *  are, or null. */
  attributeHandler(el: unknown, type: string): unknown;
  /** Reports what a handler threw, as an uncaught exception. */
  report(error: unknown): void;
}

/** What `installDom` has of this. */
export interface SmilInstall {
  interfaces: Record<string, unknown>;
  /** `SVGAnimationElement`'s methods and its handlers. */
  animationMembers: Record<string, PropertyDescriptor>;
  /** `SVGSVGElement`'s time container's methods. */
  svgMembers: Record<string, PropertyDescriptor>;
  /** An attribute as animation has it now, or undefined where nothing
   *  animates it. */
  animAttr(el: unknown, name: string): string | undefined;
  /** A computed style's property as animation has it, or undefined. */
  styleOf(el: unknown, property: string, base: string): string | undefined;
  /** What moves wherever an animated value may have. */
  generation(): number;
  /** Whether an `on<type>` handler of an element is SMIL's, which runs for
   *  `<type>Event` and not for `<type>`. */
  ownsHandler(el: unknown, type: string): boolean;
  /** Brings the host up to date with what animation sets now. */
  flush(): void;
  /** Whether anything in the document animates. */
  active(): boolean;
}

export function installSmil(deps: SmilDeps): SmilInstall {
  'use strict';
  type Any = any;
  const DOMException: Any = deps.DOMException;
  const Event: Any = deps.Event;
  const { getAttr } = deps;
  const isFinite = Number.isFinite;
  const floor = Math.floor;
  const min = Math.min;
  const max = Math.max;

  // --- time values ------------------------------------------------------------

  const NUMBER_TEXT = '(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
  const TIMECOUNT = new RegExp(`^(${NUMBER_TEXT})(h|min|s|ms)?$`);
  const FULL_CLOCK = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/;
  const PARTIAL_CLOCK = /^([0-5]\d):([0-5]\d(?:\.\d+)?)$/;
  /** A clock value in seconds (SMIL 3, 5.4.1), or null where it is none. */
  const clockOf = (text: string): number | null => {
    const s = text.trim();
    let m = FULL_CLOCK.exec(s);
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
    m = PARTIAL_CLOCK.exec(s);
    if (m) return +m[1] * 60 + +m[2];
    m = TIMECOUNT.exec(s);
    if (!m) return null;
    const n = +m[1];
    switch (m[2]) {
      case 'h':
        return n * 3600;
      case 'min':
        return n * 60;
      case 'ms':
        return n / 1000;
      default:
        return n;
    }
  };
  /** An offset, `[+-] clock`, or null. */
  const offsetOf = (text: string): number | null => {
    const s = text.trim();
    if (s[0] === '+' || s[0] === '-') {
      const c = clockOf(s.slice(1));
      return c === null ? null : s[0] === '-' ? -c : c;
    }
    return clockOf(s);
  };

  // --- begin and end lists ------------------------------------------------------

  interface Spec {
    kind: 'offset' | 'indefinite' | 'sync' | 'event' | 'repeat' | 'key';
    t: number;
    id?: string | null;
    which?: 'begin' | 'end';
    event?: string;
    n?: number;
    key?: string;
  }
  /** An identifier with SMIL's `\.` taken back. */
  const unescape = (id: string): string => id.replace(/\\(.)/g, '$1');
  /** Where an unescaped `.` last is in a token, or -1. */
  const lastDot = (s: string): number => {
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i] === '.' && s[i - 1] !== '\\') return i;
    }
    return -1;
  };
  const EVENT_NAMES: Record<string, string> = {
    focus: 'focusin',
    blur: 'focusout',
    activate: 'click',
    begin: 'beginEvent',
    end: 'endEvent',
    repeat: 'repeatEvent',
  };
  const specOf = (raw: string): Spec | null => {
    const item = raw.trim();
    if (!item) return null;
    if (item === 'indefinite') return { kind: 'indefinite', t: 0 };
    const t = offsetOf(item);
    if (t !== null) return { kind: 'offset', t };
    if (/^wallclock\(/.test(item)) return null;
    // a token and an offset after it
    let token = item;
    let off = 0;
    const m = /^(.*?[^\s+-])\s*([+-])\s*([^+-]+)$/.exec(item);
    if (m) {
      const c = clockOf(m[3]);
      if (c !== null) {
        token = m[1];
        off = m[2] === '-' ? -c : c;
      }
    }
    token = token.trim();
    const key = /^accessKey\((.)\)$/.exec(token);
    if (key) return { kind: 'key', t: off, key: key[1] };
    const dot = lastDot(token);
    const base = dot >= 0 ? unescape(token.slice(0, dot)) : null;
    const name = dot >= 0 ? token.slice(dot + 1) : token;
    if (!name || /\s/.test(name) || (base !== null && !base)) return null;
    const rep = /^repeat\((\d+)\)$/.exec(name);
    if (rep) return { kind: 'repeat', t: off, id: base, n: +rep[1] };
    if (base !== null && (name === 'begin' || name === 'end')) {
      return { kind: 'sync', t: off, id: base, which: name };
    }
    if (/[()]/.test(name)) return null;
    return {
      kind: 'event',
      t: off,
      id: base,
      event: EVENT_NAMES[name] ?? name,
    };
  };
  /** A begin or end list (SMIL 3, 5.4.3), its items parsed once a text. */
  const SPECS = new Map<string, Spec[]>();
  const specsOf = (raw: string | null): Spec[] => {
    if (raw === null) return [];
    let specs = SPECS.get(raw);
    if (!specs) {
      specs = [];
      for (const part of raw.split(';')) {
        const s = specOf(part);
        if (s) specs.push(s);
      }
      if (SPECS.size > 500) SPECS.clear();
      SPECS.set(raw, specs);
    }
    return specs;
  };

  // --- what is kept of an element -----------------------------------------------

  interface State {
    /** Instance times events and `beginElement()` added. */
    begins: number[];
    ends: number[];
    /** The events listened for, as a key of what is listened to. */
    heard: string;
    unlisten: Array<() => void>;
    /** What it was at the last update: the interval holding the time, by
     *  its begin, and the iteration in it. */
    was: { key: number | null; iteration: number } | null;
  }
  const STATES = new WeakMap<object, State>();
  const stateOf = (el: Any): State => {
    let s = STATES.get(el);
    if (!s) {
      s = { begins: [], ends: [], heard: '', unlisten: [], was: null };
      STATES.set(el, s);
    }
    return s;
  };

  // --- the document's clock -------------------------------------------------------

  /** A time container: every outermost `<svg>` has one, which runs from
   *  the document's `load`, or from when it is first met after that. */
  interface Clock {
    started: boolean;
    paused: boolean;
    /** The time where the clock is paused or not started. */
    at: number;
    /** Where its time 0 is, in `now()`'s milliseconds. */
    origin: number;
    /** Whether the next update follows a seek, which tells only what
     *  changed, not what was passed over. */
    seeked: boolean;
    /** Its time at its last update. */
    last: number;
  }
  const CLOCKS = new WeakMap<object, Clock>();
  const ALL_CLOCKS = new Set<Clock>();
  /** What an animation in no `<svg>` keeps time by. */
  const NO_ROOT = {};
  let loaded = false;
  const clockFor = (root: Any): Clock => {
    let c = CLOCKS.get(root);
    if (!c) {
      c = {
        started: loaded,
        paused: false,
        at: 0,
        origin: deps.now(),
        seeked: false,
        last: -1e-9,
      };
      CLOCKS.set(root, c);
      ALL_CLOCKS.add(c);
    }
    return c;
  };
  /** The outermost `<svg>` around an element, whose clock it keeps. */
  const rootOf = (el: Any): Any => {
    let root: Any = null;
    for (let at = el; at; at = at.parentElement) {
      if (localName(at) === 'svg' && deps.isSvg(at)) root = at;
    }
    return root ?? NO_ROOT;
  };
  const timeOf = (c: Clock): number => {
    if (!c.started || c.paused) return c.at;
    return (deps.now() - c.origin) / 1000;
  };
  const setTime = (c: Clock, t: number): void => {
    if (!c.started || c.paused) c.at = t;
    else c.origin = deps.now() - t * 1000;
  };
  const clockOfEl = (el: Any): Clock => clockFor(rootOf(el));
  const elTime = (el: Any): number => timeOf(clockOfEl(el));

  // --- an element's timing ----------------------------------------------------------

  interface Interval {
    b: number;
    e: number;
  }
  interface Timing {
    el: Any;
    intervals: Interval[];
    /** The simple duration, Infinity where it is indefinite. */
    dur: number;
    /** Whether it is held at its last value past its end. */
    freeze: boolean;
  }

  const ANIMATING = new Set([
    'animate',
    'set',
    'animateMotion',
    'animateTransform',
  ]);
  const localName = (el: Any): string => el?.localName ?? '';
  const isAnimation = (el: Any): boolean =>
    !!el && deps.isSvg(el) && ANIMATING.has(localName(el));

  /** The simple duration (SMIL 3, 5.4.4): Infinity where it is indefinite,
   *  `media`, unparsable or not more than 0. */
  const durOf = (el: Any): number => {
    const raw = getAttr(el, 'dur');
    if (raw === null) return Infinity;
    const d = clockOf(raw);
    return d !== null && d > 0 ? d : Infinity;
  };
  const countOf = (raw: string | null): number | null => {
    if (raw === null) return null;
    const s = raw.trim();
    if (s === 'indefinite') return Infinity;
    if (!new RegExp(`^${NUMBER_TEXT}$`).test(s)) return null;
    const n = +s;
    return n > 0 ? n : null;
  };
  const repeatDurOf = (raw: string | null): number | null => {
    if (raw === null) return null;
    if (raw.trim() === 'indefinite') return Infinity;
    const d = clockOf(raw);
    return d !== null && d > 0 ? d : null;
  };

  /** Whether an element is turned off by conditional processing (SVG 2,
   *  5.8.2). */
  const conditionsFail = (el: Any): boolean => {
    const ext = getAttr(el, 'requiredExtensions');
    if (ext !== null) return true;
    const lang = getAttr(el, 'systemLanguage');
    if (lang !== null) {
      const want = lang
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const have = deps.languages().map((s) => s.toLowerCase());
      if (
        !want.some((w) =>
          have.some(
            (h) => h === w || h.startsWith(`${w}-`) || w.startsWith(`${h}-`),
          ),
        )
      ) {
        return true;
      }
    }
    return false;
  };

  /** Up to when intervals are worked out, past the time asked about. */
  const AHEAD = 100;
  const MOST_INTERVALS = 1000;

  /** One pass over the document at a time: each element's intervals, made
   *  once each, an element in the middle of its own made as having none. */
  class Pass {
    time: number;
    horizon: number;
    timings = new Map<Any, Timing | null>();
    making = new Set<Any>();
    byId: Map<string, Any>;
    order: Map<Any, number>;
    constructor(time: number, els: Any[]) {
      this.time = time;
      this.horizon = time + AHEAD;
      this.byId = new Map();
      this.order = new Map();
      els.forEach((el, i) => {
        this.order.set(el, i);
        const id = el.id;
        if (id && !this.byId.has(id)) this.byId.set(id, el);
      });
    }
    find(id: string): Any {
      const known = this.byId.get(id);
      if (known) return known;
      return (deps.document() as Any)?.getElementById?.(id) ?? null;
    }
    timing(el: Any): Timing | null {
      if (this.timings.has(el)) return this.timings.get(el)!;
      if (this.making.has(el)) return null;
      this.making.add(el);
      const t = conditionsFail(el) ? null : this.make(el);
      this.making.delete(el);
      this.timings.set(el, t);
      return t;
    }
    /** The instance times of a begin or an end list, sorted. */
    times(
      el: Any,
      which: 'begin' | 'end',
    ): {
      times: number[];
      open: boolean;
    } {
      const raw = getAttr(el, which);
      const specs =
        raw === null && which === 'begin' ? DEFAULT_BEGIN : specsOf(raw);
      const out: number[] = [];
      // an end that is an event or indefinite leaves an interval open
      let open = false;
      for (const s of specs) {
        if (s.kind === 'offset') out.push(s.t);
        else if (s.kind === 'indefinite') open = true;
        else if (s.kind === 'event' || s.kind === 'key') open = true;
        else if (s.kind === 'sync') {
          const src = this.find(s.id!);
          const timing = isAnimation(src) ? this.timing(src) : null;
          if (timing) {
            for (const iv of timing.intervals) {
              const at = s.which === 'begin' ? iv.b : iv.e;
              if (isFinite(at)) out.push(at + s.t);
            }
          }
          open = true;
        } else if (s.kind === 'repeat') {
          const src = s.id === null ? el : this.find(s.id!);
          const timing = isAnimation(src) ? this.timing(src) : null;
          if (timing && isFinite(timing.dur)) {
            for (const iv of timing.intervals) {
              const at = iv.b + s.n! * timing.dur;
              if (s.n! > 0 && at < iv.e) out.push(at + s.t);
            }
          }
          open = true;
        }
      }
      const st = STATES.get(el);
      if (st) {
        for (const t of which === 'begin' ? st.begins : st.ends) out.push(t);
      }
      out.sort((a, b) => a - b);
      return { times: out, open };
    }
    make(el: Any): Timing {
      const dur = durOf(el);
      const freeze = getAttr(el, 'fill') === 'freeze';
      const timing: Timing = { el, intervals: [], dur, freeze };
      // made before the lists are read, so a list that reads this one finds
      // no interval rather than going round
      const begins = this.times(el, 'begin').times;
      const hasEnd = getAttr(el, 'end') !== null;
      const ends = hasEnd ? this.times(el, 'end') : { times: [], open: false };
      const rc = countOf(getAttr(el, 'repeatCount'));
      const rd = repeatDurOf(getAttr(el, 'repeatDur'));
      let lo = clockOf(getAttr(el, 'min') ?? '') ?? 0;
      let hi = getAttr(el, 'max');
      let most = hi === null ? Infinity : (clockOf(hi) ?? Infinity);
      if (most <= 0) most = Infinity;
      if (lo > most) {
        lo = 0;
        most = Infinity;
      }
      const restart = getAttr(el, 'restart') ?? 'always';
      // the intermediate active duration (SMIL 3, 5.4.5)
      const iad =
        rc === null && rd === null
          ? dur
          : min(rc === null ? Infinity : rc * dur, rd === null ? Infinity : rd);
      const activeEnd = (b: number, after: number): number | null => {
        let pad = iad;
        if (hasEnd) {
          let e: number | undefined;
          for (const t of ends.times) {
            if (t > b || (t === b && t > after)) {
              e = t;
              break;
            }
          }
          if (e !== undefined) pad = min(iad, e - b);
          else if (!ends.open) return null;
        }
        return b + min(most, max(lo, pad));
      };
      const out = timing.intervals;
      let after = -Infinity;
      let first = true;
      for (let guard = 0; guard < MOST_INTERVALS * 2; guard++) {
        let b: number | undefined;
        for (const t of begins) {
          if (
            first
              ? t >= after
              : t >= after && (out.length === 0 || t > out[out.length - 1].b)
          ) {
            b = t;
            break;
          }
        }
        if (b === undefined || b > this.horizon) break;
        let e = activeEnd(b, first ? -Infinity : after);
        if (e === null) break;
        if (restart === 'always') {
          for (const t of begins) {
            if (t > b && t < e) {
              e = t;
              break;
            }
          }
        }
        if (first && !(e > 0 || (b === 0 && e === 0))) {
          // an interval wholly before the document began is none (SMIL 3,
          // 5.4.5, "getFirstInterval")
          after = e === b ? b + 1e-9 : e;
          if (!isFinite(after)) break;
          continue;
        }
        out.push({ b, e });
        first = false;
        if (
          restart === 'never' ||
          !isFinite(e) ||
          out.length >= MOST_INTERVALS
        ) {
          break;
        }
        after = e;
      }
      return timing;
    }
  }
  const DEFAULT_BEGIN: Spec[] = [{ kind: 'offset', t: 0 }];

  /** Where an element is at a time: the interval holding it, or the last one
   *  before it, and how far into its simple duration. */
  interface Where {
    timing: Timing;
    iv: Interval;
    index: number;
    active: boolean;
    /** How far into the simple duration, 0 to 1, and which repeat. */
    f: number;
    iteration: number;
  }
  const whereAt = (timing: Timing, t: number): Where | null => {
    const ivs = timing.intervals;
    let index = -1;
    for (let i = 0; i < ivs.length; i++) {
      if (ivs[i].b <= t) index = i;
      else break;
    }
    if (index < 0) return null;
    const iv = ivs[index];
    const d = timing.dur;
    if (t < iv.e) {
      const at = t - iv.b;
      if (!isFinite(d)) {
        return { timing, iv, index, active: true, f: 0, iteration: 0 };
      }
      let iteration = floor(at / d);
      let st = at - iteration * d;
      // what rounding put a hair short of the next repeat
      if (d - st < 1e-9) {
        iteration++;
        st = 0;
      }
      return { timing, iv, index, active: true, f: st / d, iteration };
    }
    // past its end: frozen at the end of its active duration
    const ad = iv.e - iv.b;
    if (!isFinite(d)) {
      return { timing, iv, index, active: false, f: 0, iteration: 0 };
    }
    let iteration = floor(ad / d);
    let st = ad - iteration * d;
    if (st < 1e-9 && iteration > 0) {
      iteration--;
      st = d;
    }
    return { timing, iv, index, active: false, f: min(1, st / d), iteration };
  };

  // --- value types ---------------------------------------------------------------

  /** A value an animation works on: numbers in a template of the text
   *  around them, which two values interpolate between where their
   *  templates are one; a colour; or a length in pixels with its unit. */
  interface Val {
    kind: 'nums' | 'color' | 'length' | 'angle' | 'text' | 'transform' | 'path';
    /** For path data: its segments, each a command and its numbers. */
    segs?: Seg[];
    nums: number[];
    template: string[];
    text: string;
    unit?: string;
    /** For a transform function: its type. */
    type?: string;
    /** For lengths: the pixels in one of each one's unit. */
    per?: number[];
  }
  interface Seg {
    c: string;
    a: number[];
  }
  const textVal = (text: string): Val => ({
    kind: 'text',
    nums: [],
    template: [text],
    text,
  });
  const NUM_IN_TEXT = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
  const numsVal = (text: string): Val => {
    const nums: number[] = [];
    const template: string[] = [];
    let last = 0;
    NUM_IN_TEXT.lastIndex = 0;
    for (let m = NUM_IN_TEXT.exec(text); m; m = NUM_IN_TEXT.exec(text)) {
      template.push(text.slice(last, m.index));
      nums.push(+m[0]);
      last = m.index + m[0].length;
    }
    template.push(text.slice(last));
    // separators are spaces and commas, whichever is written
    for (let i = 0; i < template.length; i++) {
      template[i] = template[i].replace(/[\s,]+/g, ' ');
    }
    return { kind: 'nums', nums, template, text };
  };
  const fmt = (n: number): string => {
    if (Object.is(n, -0) || Math.abs(n) < 1e-12) return '0';
    const r = Math.round(n * 1e6) / 1e6;
    return String(r);
  };
  const numsText = (v: Val): string => {
    let out = v.template[0];
    for (let i = 0; i < v.nums.length; i++) {
      out += fmt(v.nums[i]) + v.template[i + 1];
    }
    return out.trim();
  };
  const sameTemplate = (a: Val, b: Val): boolean =>
    a.template.length === b.template.length &&
    a.template.every((t, i) => t.trim() === b.template[i].trim());

  const LENGTH = new RegExp(
    `^\\s*([-+]?${NUMBER_TEXT}(?:[eE][-+]?\\d+)?)(px|pt|pc|in|cm|mm|q|em|ex|ch|rem|vw|vh|vmin|vmax|%)?\\s*$`,
    'i',
  );
  const ABSOLUTE: Record<string, number> = {
    '': 1,
    px: 1,
    pt: 4 / 3,
    pc: 16,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    q: 96 / 101.6,
  };
  /** Pixels in one of a unit, for an element along an axis. */
  const perUnit = (el: Any, unit: string, axis: string): number => {
    const a = ABSOLUTE[unit];
    if (a !== undefined) return a;
    const n = deps.unitSize(el, unit === '%' ? '%' : unit, axis);
    return n ?? (unit === '%' ? 0 : 16);
  };

  const ANGLE = new RegExp(
    `^\\s*([-+]?${NUMBER_TEXT}(?:[eE][-+]?\\d+)?)(deg|rad|grad|turn)?\\s*$`,
    'i',
  );
  const PER_DEGREE: Record<string, number> = {
    '': 1,
    deg: 1,
    rad: 180 / Math.PI,
    grad: 0.9,
    turn: 360,
  };

  /** What kind of value an attribute is, which decides how it animates. */
  const LENGTHS = new Set([
    'x',
    'y',
    'width',
    'height',
    'r',
    'rx',
    'ry',
    'cx',
    'cy',
    'x1',
    'x2',
    'y1',
    'y2',
    'fx',
    'fy',
    'fr',
    'stroke-width',
    'stroke-dashoffset',
    'font-size',
    'refX',
    'refY',
    'markerWidth',
    'markerHeight',
    'startOffset',
    'textLength',
    'letter-spacing',
    'word-spacing',
  ]);
  const LENGTH_LISTS = new Set(['dx', 'dy', 'stroke-dasharray']);
  const COLORS = new Set([
    'fill',
    'stroke',
    'stop-color',
    'flood-color',
    'lighting-color',
    'color',
  ]);
  const INTEGERS = new Set(['numOctaves', 'order', 'targetX', 'targetY']);
  /** What an `SVGAnimatedNumber` reflects, or a property of one number. */
  const NUMBERS = new Set([
    'opacity',
    'fill-opacity',
    'stroke-opacity',
    'stop-opacity',
    'flood-opacity',
    'stroke-miterlimit',
    'pathLength',
    'offset',
    'k1',
    'k2',
    'k3',
    'k4',
    'scale',
    'surfaceScale',
    'specularConstant',
    'specularExponent',
    'diffuseConstant',
    'limitingConeAngle',
    'azimuth',
    'elevation',
    'pointsAtX',
    'pointsAtY',
    'pointsAtZ',
    'divisor',
    'bias',
    'seed',
    'amplitude',
    'exponent',
    'intercept',
    'slope',
  ]);
  const NUMBER_ONLY = new RegExp(
    `^([-+]?${NUMBER_TEXT}(?:[eE][-+]?\\d+)?)(%)?$`,
  );
  const BOOLEANS = new Set(['preserveAlpha']);
  /** A number and an optional second one, which is the first where it is
   *  left out. */
  const PAIRS = new Set([
    'stdDeviation',
    'baseFrequency',
    'radius',
    'kernelUnitLength',
  ]);
  const NUMBER_LISTS = new Set([
    'tableValues',
    'kernelMatrix',
    'values',
    'rotate',
  ]);
  /** Numbers and nothing else, by spaces and commas, or null. */
  const strictNumbers = (s: string): number[] | null => {
    const parts = s.split(/\s*,\s*|\s+/).filter((p) => p !== '');
    const out: number[] = [];
    for (const p of parts) {
      const m = NUMBER_ONLY.exec(p);
      if (!m || m[2]) return null;
      out.push(+m[1]);
    }
    return out;
  };
  const listVal = (nums: number[], text: string): Val => ({
    kind: 'nums',
    nums,
    template: ['', ...nums.map(() => ' ')],
    text,
  });
  const NOT_ADDITIVE = new Set([
    'visibility',
    'display',
    'class',
    'href',
    'xlink:href',
    'preserveAspectRatio',
  ]);
  const AXIS: Record<string, string> = {
    x: 'x',
    x1: 'x',
    x2: 'x',
    cx: 'x',
    fx: 'x',
    rx: 'x',
    width: 'x',
    dx: 'x',
    refX: 'x',
    markerWidth: 'x',
    y: 'y',
    y1: 'y',
    y2: 'y',
    cy: 'y',
    fy: 'y',
    ry: 'y',
    height: 'y',
    dy: 'y',
    refY: 'y',
    markerHeight: 'y',
  };
  /** Text, `x` and `y` on which are lists of lengths. */
  const TEXT_ELEMENTS = new Set(['text', 'tspan']);

  const typeOf = (target: Any, attr: string): string => {
    if (
      TEXT_ELEMENTS.has(localName(target)) &&
      (attr === 'x' || attr === 'y')
    ) {
      return 'lengths';
    }
    if (attr === 'orient') return 'angle';
    if (attr === 'd') return 'path';
    if (LENGTHS.has(attr)) return 'length';
    if (LENGTH_LISTS.has(attr)) return 'lengths';
    if (COLORS.has(attr)) return 'color';
    if (INTEGERS.has(attr)) return 'integer';
    if (NUMBERS.has(attr)) return 'number';
    if (BOOLEANS.has(attr)) return 'boolean';
    if (PAIRS.has(attr)) return 'pair';
    if (NUMBER_LISTS.has(attr)) return 'numbers';
    if (attr === 'points') return 'points';
    if (attr === 'viewBox') return 'rect';
    if (NOT_ADDITIVE.has(attr)) return 'text';
    return 'nums';
  };

  /** A value of a type, as an element has it. Null where it is none. */
  const parse = (
    text: string | null,
    type: string,
    target: Any,
    attr: string,
  ): Val | null => {
    if (text === null) return null;
    const s = text.trim();
    switch (type) {
      case 'length': {
        // a calculation of one length is the length
        const calc = /^calc\(\s*([^()]*?)\s*\)$/i.exec(s);
        const m = LENGTH.exec(calc ? calc[1] : s);
        if (!m) return /^auto$/i.test(s) ? textVal(s) : null;
        const unit = (m[2] ?? '').toLowerCase();
        const per = perUnit(target, unit, AXIS[attr] ?? 'xy');
        return {
          kind: 'length',
          nums: [+m[1] * per],
          template: ['', ''],
          text: s,
          unit,
          per: [per],
        };
      }
      case 'lengths': {
        const parts = s ? s.split(/[\s,]+/) : [];
        const nums: number[] = [];
        const units: string[] = [];
        const pers: number[] = [];
        for (const p of parts) {
          const m = LENGTH.exec(p);
          if (!m) return null;
          const unit = (m[2] ?? '').toLowerCase();
          units.push(unit);
          const per = perUnit(target, unit, AXIS[attr] ?? 'xy');
          pers.push(per);
          nums.push(+m[1] * per);
        }
        return {
          kind: 'length',
          nums,
          template: ['', ...nums.map(() => '')],
          text: s,
          unit: units.join(' '),
          per: pers,
        };
      }
      case 'angle': {
        const m = ANGLE.exec(s);
        if (!m) return textVal(s);
        const unit = (m[2] ?? '').toLowerCase();
        return {
          kind: 'angle',
          nums: [+m[1] * PER_DEGREE[unit]],
          template: ['', ''],
          text: s,
          unit,
        };
      }
      case 'color': {
        // a keyword with CSS's escapes in it is the keyword
        const lower = s.replace(/\\(.)/g, '$1').toLowerCase();
        if (lower === 'currentcolor') {
          const c = deps.color(deps.computed(target, 'color') || 'black');
          return c ? colorVal(c, s) : null;
        }
        if (lower === 'none' || /^url\(/.test(lower)) return textVal(s);
        const c = deps.color(s);
        return c ? colorVal(c, s) : null;
      }
      case 'number': {
        const m = NUMBER_ONLY.exec(s);
        if (!m) return null;
        return {
          kind: 'nums',
          nums: [m[2] ? +m[1] / 100 : +m[1]],
          template: ['', ''],
          text: s,
        };
      }
      case 'path': {
        const segs = pathSegs(s);
        if (!segs) return null;
        return pathVal(segs);
      }
      case 'boolean':
        return s === 'true' || s === 'false' ? textVal(s) : null;
      case 'pair': {
        const n = strictNumbers(s);
        if (!n || n.length < 1 || n.length > 2) return null;
        return listVal(n.length === 1 ? [n[0], n[0]] : n, s);
      }
      case 'numbers': {
        const n = strictNumbers(s);
        return n ? listVal(n, s) : null;
      }
      case 'points': {
        const n = strictNumbers(s);
        return n && n.length % 2 === 0 ? listVal(n, s) : null;
      }
      case 'rect': {
        const n = strictNumbers(s);
        return n && n.length === 4 ? listVal(n, s) : null;
      }
      case 'integer':
      case 'nums': {
        if (!s && type === 'integer') return null;
        const v = numsVal(s);
        // what reflects as numbers is nothing but numbers
        if (type === 'integer' && v.template.some((t) => t.trim())) return null;
        return v;
      }
      default:
        return textVal(s);
    }
  };
  const colorVal = (c: number[], text: string): Val => ({
    kind: 'color',
    nums: c.slice(0, 4),
    template: ['', '', '', '', ''],
    text,
  });

  /** A value written out, for the attribute (`css` false) or for a
   *  computed style. */
  const serialize = (v: Val, css: boolean, type: string): string => {
    switch (v.kind) {
      case 'color': {
        const [r, g, b, a] = v.nums.map((n) => Math.round(min(255, max(0, n))));
        return a >= 255
          ? `rgb(${r}, ${g}, ${b})`
          : `rgba(${r}, ${g}, ${b}, ${fmt(Math.round((a / 255) * 1000) / 1000)})`;
      }
      case 'length': {
        if (css) return v.nums.map((n) => `${fmt(n)}px`).join(' ');
        const units = (v.unit ?? '').split(' ');
        return v.nums
          .map((n, i) => {
            const unit = units[i] ?? '';
            return fmt(n / (v.per?.[i] || 1)) + unit;
          })
          .join(' ');
      }
      case 'angle':
        return fmt(v.nums[0] / PER_DEGREE[v.unit ?? '']) + (v.unit ?? '');
      case 'transform':
        return v.text;
      case 'path': {
        const text = pathText(v.segs!);
        return css ? (text ? `path("${text}")` : 'none') : text;
      }
      case 'nums':
        if (type === 'integer') {
          return numsText({ ...v, nums: v.nums.map((n) => Math.round(n)) });
        }
        return numsText(v);
      default:
        return v.text;
    }
  };

  const interpolable = (a: Val, b: Val): boolean =>
    a.kind === b.kind &&
    (a.kind !== 'path' || samePath(a.segs!, b.segs!)) &&
    a.kind !== 'text' &&
    a.nums.length === b.nums.length &&
    (a.kind !== 'nums' || sameTemplate(a, b)) &&
    (a.kind !== 'transform' || a.type === b.type);
  const lerpVal = (a: Val, b: Val, t: number): Val => {
    if (a.kind === 'path') {
      const from = inModes(a.segs!, b.segs!);
      return pathVal(
        b.segs!.map((seg, i) => ({
          c: seg.c,
          a: seg.a.map((n, k) =>
            seg.c.toUpperCase() === 'A' && (k === 3 || k === 4)
              ? t < 0.5
                ? from[i].a[k]
                : n
              : from[i].a[k] + (n - from[i].a[k]) * t,
          ),
        })),
      );
    }
    const nums = a.nums.map((n, i) => n + (b.nums[i] - n) * t);
    const near = t < 0.5 ? a : b;
    const v: Val = { ...near, nums };
    // a length or an angle is in the unit of the end it is nearer, as
    // Blink has it: `{ ...near }` keeps it
    if (a.kind === 'transform') v.text = transformText(v);
    return v;
  };
  const addVal = (a: Val, b: Val, times = 1): Val | null => {
    if (!interpolable(a, b)) return null;
    if (a.kind === 'path') {
      const base = inModes(a.segs!, b.segs!);
      return pathVal(
        b.segs!.map((seg, i) => ({
          c: seg.c,
          a: seg.a.map((n, k) =>
            seg.c.toUpperCase() === 'A' && (k === 3 || k === 4)
              ? n
              : base[i].a[k] + n * times,
          ),
        })),
      );
    }
    const v: Val = { ...b, nums: a.nums.map((n, i) => n + b.nums[i] * times) };
    if (a.kind === 'transform') v.text = transformText(v);
    return v;
  };
  const distance = (a: Val, b: Val): number => {
    let sum = 0;
    for (let i = 0; i < a.nums.length; i++) {
      const d = (b.nums[i] ?? 0) - a.nums[i];
      sum += d * d;
    }
    return Math.sqrt(sum);
  };
  const zeroOf = (v: Val): Val => {
    if (v.kind === 'path') {
      return pathVal(
        v.segs!.map((seg) => ({ c: seg.c, a: seg.a.map(() => 0) })),
      );
    }
    const z: Val = { ...v, nums: v.nums.map(() => 0) };
    if (v.kind === 'transform') {
      if (v.type === 'scale') z.nums = v.nums.map(() => 0);
      z.text = transformText(z);
    }
    return z;
  };

  // --- path data ---------------------------------------------------------------

  /** How many numbers each command takes. */
  const PATH_ARGS: Record<string, number> = {
    M: 2,
    L: 2,
    H: 1,
    V: 1,
    C: 6,
    S: 4,
    Q: 4,
    T: 2,
    A: 7,
    Z: 0,
  };
  const PATH_NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y;
  /** Path data's segments (SVG 2, 9.3.9), a repeated command written out,
   *  or null where any of it is not path data. */
  const pathSegs = (text: string): Seg[] | null => {
    const segs: Seg[] = [];
    let i = 0;
    const n = text.length;
    const space = (): void => {
      while (i < n && /[\s,]/.test(text[i])) i++;
    };
    const flag = (): number | null => {
      space();
      if (text[i] === '0' || text[i] === '1') return +text[i++];
      return null;
    };
    const number = (): number | null => {
      space();
      PATH_NUMBER.lastIndex = i;
      const m = PATH_NUMBER.exec(text);
      if (!m) return null;
      i += m[0].length;
      return +m[0];
    };
    space();
    let cmd = '';
    while (i < n) {
      const ch = text[i];
      if (/[A-Za-z]/.test(ch)) {
        if (!(ch.toUpperCase() in PATH_ARGS)) return null;
        if (!segs.length && ch !== 'M' && ch !== 'm') return null;
        cmd = ch;
        i++;
      } else if (!cmd || cmd === 'Z' || cmd === 'z') return null;
      const count = PATH_ARGS[cmd.toUpperCase()];
      const a: number[] = [];
      for (let k = 0; k < count; k++) {
        const v =
          cmd.toUpperCase() === 'A' && (k === 3 || k === 4) ? flag() : number();
        if (v === null) return null;
        a.push(v);
      }
      segs.push({ c: cmd, a });
      if (cmd === 'M') cmd = 'L';
      else if (cmd === 'm') cmd = 'l';
      space();
    }
    return segs;
  };
  const pathVal = (segs: Seg[]): Val => ({
    kind: 'path',
    nums: segs.flatMap((s) => s.a),
    template: [],
    text: '',
    segs,
  });
  /** A number as a path's computed value writes it, to six figures. */
  const fmt6 = (n: number): string => {
    const r = Number(n.toPrecision(6));
    return Object.is(r, -0) ? '0' : String(r);
  };
  const pathText = (segs: Seg[]): string =>
    segs
      .map((s) =>
        s.c === 'z' || s.c === 'Z' ? 'Z' : [s.c, ...s.a.map(fmt6)].join(' '),
      )
      .join(' ');
  const samePath = (a: Seg[], b: Seg[]): boolean =>
    a.length === b.length &&
    a.every((s, i) => s.c.toUpperCase() === b[i].c.toUpperCase());
  /** A path's segments in the modes, absolute or relative, of another's of
   *  the same commands, each converted from where its own path is. */
  const inModes = (segs: Seg[], modes: Seg[]): Seg[] => {
    const out: Seg[] = [];
    let x = 0;
    let y = 0;
    let sx = 0;
    let sy = 0;
    segs.forEach((seg, i) => {
      const up = seg.c.toUpperCase();
      const rel = seg.c !== up;
      // the segment's numbers made absolute
      const abs = seg.a.slice();
      if (rel) {
        if (up === 'H') abs[0] += x;
        else if (up === 'V') abs[0] += y;
        else if (up === 'A') {
          abs[5] += x;
          abs[6] += y;
        } else {
          for (let k = 0; k < abs.length; k += 2) {
            abs[k] += x;
            abs[k + 1] += y;
          }
        }
      }
      const wantRel = modes[i].c !== modes[i].c.toUpperCase();
      let a = abs;
      if (wantRel && up !== 'Z') {
        a = abs.slice();
        if (up === 'H') a[0] -= x;
        else if (up === 'V') a[0] -= y;
        else if (up === 'A') {
          a[5] -= x;
          a[6] -= y;
        } else {
          for (let k = 0; k < a.length; k += 2) {
            a[k] -= x;
            a[k + 1] -= y;
          }
        }
      }
      out.push({ c: modes[i].c, a });
      // where the next one starts
      if (up === 'Z') {
        x = sx;
        y = sy;
      } else if (up === 'H') x = abs[0];
      else if (up === 'V') y = abs[0];
      else {
        x = abs[abs.length - 2];
        y = abs[abs.length - 1];
      }
      if (up === 'M') {
        sx = x;
        sy = y;
      }
    });
    return out;
  };

  // --- animateTransform's values -------------------------------------------------

  const transformVal = (text: string | null, type: string): Val | null => {
    if (text === null) return null;
    const nums = (text.match(NUM_IN_TEXT) ?? []).map(Number);
    const rest = text.replace(NUM_IN_TEXT, '').replace(/[\s,]/g, '');
    if (rest) return null;
    let full: number[];
    switch (type) {
      case 'translate':
        if (nums.length < 1 || nums.length > 2) return null;
        full = [nums[0], nums[1] ?? 0];
        break;
      case 'scale':
        if (nums.length < 1 || nums.length > 2) return null;
        full = [nums[0], nums[1] ?? nums[0]];
        break;
      case 'rotate':
        if (nums.length !== 1 && nums.length !== 3) return null;
        full = [nums[0], nums[1] ?? 0, nums[2] ?? 0];
        break;
      case 'skewX':
      case 'skewY':
        if (nums.length !== 1) return null;
        full = [nums[0]];
        break;
      default:
        return null;
    }
    const v: Val = {
      kind: 'transform',
      nums: full,
      template: [],
      text: '',
      type,
    };
    v.text = transformText(v);
    return v;
  };
  const transformText = (v: Val): string => {
    const n = v.nums.map(fmt);
    switch (v.type) {
      case 'translate':
        return `translate(${n[0]} ${n[1]})`;
      case 'scale':
        return `scale(${n[0]} ${n[1]})`;
      case 'rotate':
        return `rotate(${n[0]} ${n[1]} ${n[2]})`;
      default:
        return `${v.type}(${n[0]})`;
    }
  };

  // --- the animation function -----------------------------------------------------

  /** A Bézier timing curve's progress at `x`, by bisection. */
  const spline = (p: number[], x: number): number => {
    const [x1, y1, x2, y2] = p;
    const at = (t: number, a: number, b: number): number =>
      3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t;
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 60; i++) {
      t = (lo + hi) / 2;
      const v = at(t, x1, x2);
      if (Math.abs(v - x) < 1e-9) break;
      if (v < x) lo = t;
      else hi = t;
    }
    return at(t, y1, y2);
  };
  const numberList = (raw: string | null): number[] | null => {
    if (raw === null) return null;
    const parts = raw
      .split(';')
      .map((s) => s.trim())
      .filter((s, i, all) => s || i < all.length - 1);
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    const out: number[] = [];
    for (const p of parts) {
      if (!new RegExp(`^${NUMBER_TEXT}(?:[eE][-+]?\\d+)?$`).test(p))
        return null;
      out.push(+p);
    }
    return out;
  };
  const splinesOf = (raw: string | null): number[][] | null => {
    if (raw === null) return null;
    const parts = raw.split(';').map((s) => s.trim());
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    const out: number[][] = [];
    for (const p of parts) {
      const n = p
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);
      if (n.length !== 4 || n.some((x) => !(x >= 0 && x <= 1))) return null;
      out.push(n);
    }
    return out;
  };

  /** What an animation element animates, and how. */
  interface Plan {
    el: Any;
    target: Any;
    attr: string;
    type: string;
    tag: string;
  }
  /** The element an animation targets (SVG Animations 2, 2.4.1). */
  const targetOf = (el: Any): Any => {
    const href = getAttr(el, 'href') ?? getAttr(el, 'xlink:href');
    if (href !== null) {
      const h = href.trim();
      if (!h.startsWith('#')) return null;
      return (deps.document() as Any)?.getElementById?.(h.slice(1)) ?? null;
    }
    return el.parentElement;
  };
  const planOf = (el: Any): Plan | null => {
    const tag = localName(el);
    const target = targetOf(el);
    if (!target || !deps.isSvg(target)) return null;
    if (tag === 'animateMotion') {
      return { el, target, attr: MOTION, type: 'motion', tag };
    }
    let attr = getAttr(el, 'attributeName');
    if (attr === null) return null;
    attr = attr.trim();
    if (!attr) return null;
    if (attr.startsWith('xlink:')) attr = attr === 'xlink:href' ? 'href' : attr;
    if (attr.includes(':')) return null;
    const attributeType = getAttr(el, 'attributeType');
    if (attributeType === 'CSS' && !CSS_PROPERTIES.has(attr)) return null;
    if (tag === 'animateTransform') {
      if (!TRANSFORM_ATTRS.has(attr)) return null;
      return { el, target, attr, type: 'transform', tag };
    }
    if (TRANSFORM_ATTRS.has(attr)) return null;
    return { el, target, attr, type: typeOf(target, attr), tag };
  };
  const TRANSFORM_ATTRS = new Set([
    'transform',
    'gradientTransform',
    'patternTransform',
  ]);
  /** The attribute `<animateMotion>` sets, which nothing else does: a
   *  matrix applied after the element's `transform`. */
  const MOTION = '\u0000motion';

  /** An animation's value at a point of its simple duration, over what is
   *  under it, or null where it contributes nothing. */
  const valueAt = (plan: Plan, where: Where, under: Val | null): Val | null => {
    const el = plan.el;
    const parseIt = (raw: string | null): Val | null => {
      let text = raw;
      // `inherit` is what the target's parent computes to (SMIL 3, 3.5.2)
      if (text !== null && text.trim() === 'inherit') {
        if (!isStyle(plan.target, plan.attr)) return null;
        const parent = plan.target.parentElement;
        text = parent ? deps.computed(parent, plan.attr) : null;
        if (!text) return null;
      }
      return plan.type === 'transform'
        ? transformVal(text, getAttr(el, 'type') ?? 'translate')
        : parse(text, plan.type, plan.target, plan.attr);
    };
    let f = where.f;
    if (plan.tag === 'set') {
      const to = parseIt(getAttr(el, 'to'));
      return to;
    }
    const valuesRaw = getAttr(el, 'values');
    let vals: Val[] | null = null;
    let toAnimation = false;
    let byAnimation = false;
    if (valuesRaw !== null) {
      const parts = valuesRaw.split(';');
      if (parts.length > 1 && parts[parts.length - 1].trim() === '')
        parts.pop();
      vals = [];
      for (const p of parts) {
        const v = parseIt(p);
        if (!v) return null;
        vals.push(v);
      }
      if (!vals.length) return null;
    } else {
      const fromRaw = getAttr(el, 'from');
      const toRaw = getAttr(el, 'to');
      const byRaw = getAttr(el, 'by');
      const from = fromRaw === null ? null : parseIt(fromRaw);
      if (fromRaw !== null && !from) return null;
      if (toRaw !== null) {
        const to = parseIt(toRaw);
        if (!to) return null;
        if (from) vals = [from, to];
        else {
          if (!under) return null;
          vals = [under, to];
          toAnimation = true;
        }
      } else if (byRaw !== null) {
        const by = parseIt(byRaw);
        if (!by) return null;
        if (from) {
          const sum = addVal(from, by);
          if (!sum) return null;
          vals = [from, sum];
        } else {
          vals = [zeroOf(by), by];
          byAnimation = true;
        }
      } else return null;
    }
    const n = vals.length;
    let mode =
      getAttr(el, 'calcMode') ??
      (plan.tag === 'animateMotion' ? 'paced' : 'linear');
    if (!['discrete', 'linear', 'paced', 'spline'].includes(mode))
      mode = 'linear';
    const canInterpolate = vals.every(
      (v, i) => i === 0 || interpolable(vals![0], v),
    );
    if (
      !canInterpolate &&
      mode !== 'discrete' &&
      valuesRaw === null &&
      n === 2
    ) {
      // what does not interpolate goes from one end to the other at the
      // middle, or is the end at once for a to animation (Blink's
      // `AnimateDiscreteType`)
      return toAnimation || f > 0.5 || f === 1 ? vals[1] : vals[0];
    }
    if (!canInterpolate) mode = 'discrete';
    if (mode === 'paced' && n > 1 && vals[0].kind === 'text') mode = 'discrete';
    let keyTimes =
      mode === 'paced' ? null : numberList(getAttr(el, 'keyTimes'));
    if (keyTimes) {
      if (keyTimes.length !== n) return null;
      for (let i = 0; i < n; i++) {
        if (keyTimes[i] < 0 || keyTimes[i] > 1) return null;
        if (i && keyTimes[i] < keyTimes[i - 1]) return null;
      }
      if (keyTimes[0] !== 0) return null;
      if (mode !== 'discrete' && keyTimes[n - 1] !== 1) return null;
    } else if (getAttr(el, 'keyTimes') !== null && mode !== 'paced')
      return null;
    let splines: number[][] | null = null;
    if (mode === 'spline') {
      splines = splinesOf(getAttr(el, 'keySplines'));
      if (!splines || splines.length !== n - 1) return null;
    }
    let v: Val;
    if (n === 1) v = vals[0];
    else if (mode === 'discrete') {
      let i: number;
      if (keyTimes) {
        i = 0;
        for (let k = 0; k < n; k++) if (keyTimes[k] <= f) i = k;
      } else {
        i = min(n - 1, floor(f * n));
      }
      v = vals[i];
    } else if (mode === 'paced') {
      const d: number[] = [0];
      for (let i = 1; i < n; i++)
        d.push(d[i - 1] + distance(vals[i - 1], vals[i]));
      const total = d[n - 1];
      if (!(total > 0)) v = vals[0];
      else {
        const at = f * total;
        let i = 0;
        while (i < n - 2 && d[i + 1] <= at) i++;
        const span = d[i + 1] - d[i];
        v = lerpVal(vals[i], vals[i + 1], span > 0 ? (at - d[i]) / span : 0);
      }
    } else {
      const kt = keyTimes ?? vals.map((_, i) => i / (n - 1));
      let i = 0;
      while (i < n - 2 && kt[i + 1] <= f) i++;
      const span = kt[i + 1] - kt[i];
      let t = span > 0 ? min(1, max(0, (f - kt[i]) / span)) : 1;
      if (splines) t = spline(splines[i], t);
      v = lerpVal(vals[i], vals[i + 1], t);
    }
    // a repeat adds the value at the end of the simple duration, as many
    // times as it has repeated (SMIL 3, 3.5.3)
    if (
      !toAnimation &&
      where.iteration > 0 &&
      getAttr(el, 'accumulate') === 'sum' &&
      v.kind !== 'text'
    ) {
      v = addVal(v, vals[n - 1], where.iteration) ?? v;
    }
    const additive = getAttr(el, 'additive') === 'sum' || byAnimation;
    if (additive && !toAnimation && under && v.kind !== 'text') {
      if (plan.type === 'transform') {
        return { ...v, text: `${under.text} ${v.text}`.trim() };
      }
      // what cannot be added to what is under it adds nothing
      return addVal(under, v) ?? under;
    }
    return v;
  };

  // --- animateMotion ---------------------------------------------------------------

  /** A path flattened to a polyline, with the length along it of each
   *  point, and the tangent at each of its ends. */
  interface Track {
    pts: number[][];
    lens: number[];
    /** Where each of the path's own points falls along it, for
     *  `keyPoints` and a `values` list. */
  }
  const PATH_TOKEN =
    /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
  const trackOf = (d: string): Track | null => {
    const tokens = d.match(PATH_TOKEN) ?? [];
    const pts: number[][] = [];
    let i = 0;
    let cmd = '';
    let x = 0;
    let y = 0;
    let sx = 0;
    let sy = 0;
    let cx = 0;
    let cy = 0;
    let prev = '';
    const num = (): number => +tokens[i++];
    const add = (px: number, py: number): void => {
      pts.push([px, py]);
    };
    const curve = (x0: number, y0: number, c: number[], steps = 32): void => {
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const u = 1 - t;
        if (c.length === 4) {
          add(
            u * u * x0 + 2 * u * t * c[0] + t * t * c[2],
            u * u * y0 + 2 * u * t * c[1] + t * t * c[3],
          );
        } else {
          add(
            u * u * u * x0 +
              3 * u * u * t * c[0] +
              3 * u * t * t * c[2] +
              t * t * t * c[4],
            u * u * u * y0 +
              3 * u * u * t * c[1] +
              3 * u * t * t * c[3] +
              t * t * t * c[5],
          );
        }
      }
    };
    while (i < tokens.length) {
      const tk = tokens[i];
      if (/[A-Za-z]/.test(tk)) {
        cmd = tk;
        i++;
        if (cmd === 'Z' || cmd === 'z') {
          add(sx, sy);
          x = sx;
          y = sy;
          prev = cmd;
          continue;
        }
      } else if (!cmd) return null;
      const rel = cmd === cmd.toLowerCase();
      const ox = rel ? x : 0;
      const oy = rel ? y : 0;
      switch (cmd.toUpperCase()) {
        case 'M':
          x = ox + num();
          y = oy + num();
          sx = x;
          sy = y;
          add(x, y);
          cmd = rel ? 'l' : 'L';
          break;
        case 'L':
          x = ox + num();
          y = oy + num();
          add(x, y);
          break;
        case 'H':
          x = ox + num();
          add(x, y);
          break;
        case 'V':
          y = oy + num();
          add(x, y);
          break;
        case 'C': {
          const c = [
            ox + num(),
            oy + num(),
            ox + num(),
            oy + num(),
            ox + num(),
            oy + num(),
          ];
          curve(x, y, c);
          cx = c[2];
          cy = c[3];
          x = c[4];
          y = c[5];
          break;
        }
        case 'S': {
          const smooth = /[CcSs]/.test(prev);
          const c1x = smooth ? 2 * x - cx : x;
          const c1y = smooth ? 2 * y - cy : y;
          const c = [c1x, c1y, ox + num(), oy + num(), ox + num(), oy + num()];
          curve(x, y, c);
          cx = c[2];
          cy = c[3];
          x = c[4];
          y = c[5];
          break;
        }
        case 'Q': {
          const c = [ox + num(), oy + num(), ox + num(), oy + num()];
          curve(x, y, c);
          cx = c[0];
          cy = c[1];
          x = c[2];
          y = c[3];
          break;
        }
        case 'T': {
          const smooth = /[QqTt]/.test(prev);
          const c1x = smooth ? 2 * x - cx : x;
          const c1y = smooth ? 2 * y - cy : y;
          const c = [c1x, c1y, ox + num(), oy + num()];
          curve(x, y, c);
          cx = c1x;
          cy = c1y;
          x = c[2];
          y = c[3];
          break;
        }
        case 'A': {
          const rx = Math.abs(num());
          const ry = Math.abs(num());
          const phi = (num() * Math.PI) / 180;
          const large = num() !== 0;
          const sweep = num() !== 0;
          const ex = ox + num();
          const ey = oy + num();
          arcTo(x, y, rx, ry, phi, large, sweep, ex, ey, add);
          x = ex;
          y = ey;
          break;
        }
        default:
          return null;
      }
      if (tokens[i - 1] === undefined || Number.isNaN(x) || Number.isNaN(y)) {
        return null;
      }
      prev = cmd;
    }
    if (!pts.length) return null;
    const lens = [0];
    for (let k = 1; k < pts.length; k++) {
      lens.push(
        lens[k - 1] +
          Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]),
      );
    }
    return { pts, lens };
  };
  /** An elliptical arc as points (SVG 2, B.2.4). */
  const arcTo = (
    x1: number,
    y1: number,
    rx: number,
    ry: number,
    phi: number,
    large: boolean,
    sweep: boolean,
    x2: number,
    y2: number,
    add: (x: number, y: number) => void,
  ): void => {
    if (!rx || !ry) {
      add(x2, y2);
      return;
    }
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (x1 - x2) / 2;
    const dy = (y1 - y2) / 2;
    const px = cos * dx + sin * dy;
    const py = -sin * dx + cos * dy;
    const lambda = (px * px) / (rx * rx) + (py * py) / (ry * ry);
    if (lambda > 1) {
      rx *= Math.sqrt(lambda);
      ry *= Math.sqrt(lambda);
    }
    const num = rx * rx * ry * ry - rx * rx * py * py - ry * ry * px * px;
    let co = Math.sqrt(max(0, num / (rx * rx * py * py + ry * ry * px * px)));
    if (large === sweep) co = -co;
    const cxp = (co * rx * py) / ry;
    const cyp = (-co * ry * px) / rx;
    const ccx = cos * cxp - sin * cyp + (x1 + x2) / 2;
    const ccy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number): number =>
      Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (px - cxp) / rx, (py - cyp) / ry);
    let dt = ang(
      (px - cxp) / rx,
      (py - cyp) / ry,
      (-px - cxp) / rx,
      (-py - cyp) / ry,
    );
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const steps = 32;
    for (let k = 1; k <= steps; k++) {
      const t = t1 + (dt * k) / steps;
      const ex = rx * Math.cos(t);
      const ey = ry * Math.sin(t);
      add(cos * ex - sin * ey + ccx, sin * ex + cos * ey + ccy);
    }
  };
  /** A basic shape's equivalent path (SVG 2, 10.x), or null for what is
   *  none. */
  const shapePath = (el: Any): string | null => {
    const n = (name: string, initial = 0): number => {
      const v = parseFloat(getAttr(el, name) ?? '');
      return Number.isFinite(v) ? v : initial;
    };
    switch (localName(el)) {
      case 'path':
        return getAttr(el, 'd') ?? '';
      case 'line':
        return `M${n('x1')},${n('y1')} L${n('x2')},${n('y2')}`;
      case 'rect': {
        const x = n('x');
        const y = n('y');
        const w = n('width');
        const h = n('height');
        return `M${x},${y} H${x + w} V${y + h} H${x} Z`;
      }
      case 'circle':
      case 'ellipse': {
        const cx = n('cx');
        const cy = n('cy');
        const rx = localName(el) === 'circle' ? n('r') : n('rx');
        const ry = localName(el) === 'circle' ? n('r') : n('ry');
        // from its rightmost point, the way angles go (SVG 2, 10.3, 10.4)
        return (
          `M${cx + rx},${cy} A${rx},${ry} 0 0 1 ${cx},${cy + ry} ` +
          `A${rx},${ry} 0 0 1 ${cx - rx},${cy} A${rx},${ry} 0 0 1 ${cx},${cy - ry} ` +
          `A${rx},${ry} 0 0 1 ${cx + rx},${cy} Z`
        );
      }
      case 'polyline':
      case 'polygon': {
        const pts = (getAttr(el, 'points') ?? '').match(NUM_IN_TEXT) ?? [];
        if (pts.length < 2) return null;
        let d = `M${pts[0]},${pts[1]}`;
        for (let i = 2; i + 1 < pts.length; i += 2)
          d += ` L${pts[i]},${pts[i + 1]}`;
        return localName(el) === 'polygon' ? `${d} Z` : d;
      }
      default:
        return null;
    }
  };
  /** A point at a length along a track, and the direction it goes there. */
  const along = (track: Track, at: number): number[] => {
    const { pts, lens } = track;
    const total = lens[lens.length - 1];
    const l = min(total, max(0, at));
    let k = 1;
    while (k < pts.length - 1 && lens[k] < l) k++;
    if (pts.length === 1) return [pts[0][0], pts[0][1], 0];
    // the direction of a segment of no length is that of the one before
    let j = k;
    while (j > 1 && lens[j] - lens[j - 1] === 0) j--;
    const a = pts[k - 1];
    const b = pts[k];
    const span = lens[k] - lens[k - 1];
    const t = span > 0 ? (l - lens[k - 1]) / span : 1;
    const da = pts[j - 1];
    const db = pts[j];
    const angle = Math.atan2(db[1] - da[1], db[0] - da[0]);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, angle];
  };

  /** `<animateMotion>`'s supplementary transform at a point of its simple
   *  duration, as six numbers, or null where it contributes none. */
  const motionAt = (plan: Plan, where: Where): number[] | null => {
    const el = plan.el;
    let track: Track | null = null;
    let points: number[][] | null = null;
    // an `<mpath>` child, then `path`, then `values`, `from`, `to` and `by`
    let mpath: Any = null;
    for (const c of el.children ?? []) {
      if (localName(c) === 'mpath') {
        mpath = c;
        break;
      }
    }
    if (mpath) {
      const href = getAttr(mpath, 'href') ?? getAttr(mpath, 'xlink:href');
      const ref = href?.trim().startsWith('#')
        ? (deps.document() as Any)?.getElementById?.(href.trim().slice(1))
        : null;
      const d = ref ? shapePath(ref) : null;
      if (d !== null) track = trackOf(d);
      if (!track) return null;
    } else if (getAttr(el, 'path') !== null) {
      track = trackOf(getAttr(el, 'path')!);
      if (!track) return null;
    } else {
      const pair = (t: string | null): number[] | null => {
        if (t === null) return null;
        const n = (t.match(NUM_IN_TEXT) ?? []).map(Number);
        return n.length === 2 ? n : null;
      };
      const values = getAttr(el, 'values');
      if (values !== null) {
        const parts = values.split(';').filter((p) => p.trim());
        points = [];
        for (const p of parts) {
          const v = pair(p);
          if (!v) return null;
          points.push(v);
        }
      } else {
        const from = pair(getAttr(el, 'from'));
        const to = pair(getAttr(el, 'to'));
        const by = pair(getAttr(el, 'by'));
        if (to) points = [from ?? [0, 0], to];
        else if (by) {
          const f0 = from ?? [0, 0];
          points = [f0, [f0[0] + by[0], f0[1] + by[1]]];
        } else return null;
      }
      if (!points.length) return null;
    }
    let mode = getAttr(el, 'calcMode') ?? 'paced';
    const f = where.f;
    let x: number;
    let y: number;
    let angle = 0;
    const keyPoints = numberList(getAttr(el, 'keyPoints'));
    const keyTimes = numberList(getAttr(el, 'keyTimes'));
    // keyTimes that do not run from 0, to 1 where the motion interpolates,
    // are an error, and the motion is none (SVG Animations 2, 3.7.1)
    if (keyTimes && mode !== 'paced') {
      if (
        keyTimes[0] !== 0 ||
        (mode !== 'discrete' && keyTimes[keyTimes.length - 1] !== 1) ||
        keyTimes.some(
          (t, i) => t < 0 || t > 1 || (i > 0 && t < keyTimes[i - 1]),
        )
      ) {
        return null;
      }
    }
    if (track) {
      const total = track.lens[track.lens.length - 1];
      let frac = f;
      if (keyPoints && keyPoints.length) {
        if (!keyTimes || keyTimes.length !== keyPoints.length) return null;
        const n = keyPoints.length;
        if (mode === 'discrete') {
          let i = 0;
          for (let k = 0; k < n; k++) if (keyTimes[k] <= f) i = k;
          frac = keyPoints[i];
        } else {
          let i = 0;
          while (i < n - 2 && keyTimes[i + 1] <= f) i++;
          const span = keyTimes[i + 1] - keyTimes[i];
          let t = span > 0 ? min(1, max(0, (f - keyTimes[i]) / span)) : 1;
          if (mode === 'spline') {
            const sp = splinesOf(getAttr(el, 'keySplines'));
            if (sp?.[i]) t = spline(sp[i], t);
          }
          frac =
            n === 1
              ? keyPoints[0]
              : keyPoints[i] + (keyPoints[i + 1] - keyPoints[i]) * t;
        }
      }
      const p = along(track, frac * total);
      x = p[0];
      y = p[1];
      angle = p[2];
    } else {
      const pts = points!;
      const n = pts.length;
      if (n === 1) {
        x = pts[0][0];
        y = pts[0][1];
      } else {
        if (mode === 'paced') {
          const d = [0];
          for (let i = 1; i < n; i++)
            d.push(
              d[i - 1] +
                Math.hypot(
                  pts[i][0] - pts[i - 1][0],
                  pts[i][1] - pts[i - 1][1],
                ),
            );
          const total = d[n - 1];
          const at = f * total;
          let i = 0;
          while (i < n - 2 && d[i + 1] <= at) i++;
          const span = d[i + 1] - d[i];
          const t = span > 0 ? (at - d[i]) / span : 0;
          x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
          y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
          angle = Math.atan2(
            pts[i + 1][1] - pts[i][1],
            pts[i + 1][0] - pts[i][0],
          );
        } else if (mode === 'discrete') {
          let i = min(n - 1, floor(f * n));
          if (keyTimes && keyTimes.length === n) {
            i = 0;
            for (let k = 0; k < n; k++) if (keyTimes[k] <= f) i = k;
          }
          x = pts[i][0];
          y = pts[i][1];
        } else {
          const kt =
            keyTimes && keyTimes.length === n
              ? keyTimes
              : pts.map((_, i) => i / (n - 1));
          let i = 0;
          while (i < n - 2 && kt[i + 1] <= f) i++;
          const span = kt[i + 1] - kt[i];
          let t = span > 0 ? min(1, max(0, (f - kt[i]) / span)) : 1;
          if (mode === 'spline') {
            const sp = splinesOf(getAttr(el, 'keySplines'));
            if (sp?.[i]) t = spline(sp[i], t);
          }
          x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
          y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
          angle = Math.atan2(
            pts[i + 1][1] - pts[i][1],
            pts[i + 1][0] - pts[i][0],
          );
        }
      }
    }
    const rotate = (getAttr(el, 'rotate') ?? '0').trim();
    let r = 0;
    if (rotate === 'auto') r = angle;
    else if (rotate === 'auto-reverse') r = angle + Math.PI;
    else {
      const m = ANGLE.exec(rotate);
      r = m
        ? (+m[1] * PER_DEGREE[(m[2] ?? '').toLowerCase()] * Math.PI) / 180
        : 0;
    }
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [c, s, -s, c, x, y];
  };
  const multiply = (a: number[], b: number[]): number[] => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];

  // --- sampling --------------------------------------------------------------------

  /** The properties a computed style has, which an animation of their
   *  attribute is laid over. */
  const CSS_PROPERTIES = new Set([
    'fill',
    'fill-opacity',
    'fill-rule',
    'stroke',
    'stroke-width',
    'stroke-opacity',
    'stroke-dasharray',
    'stroke-dashoffset',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-miterlimit',
    'opacity',
    'visibility',
    'display',
    'color',
    'stop-color',
    'stop-opacity',
    'flood-color',
    'flood-opacity',
    'lighting-color',
    'font-size',
    'font-family',
    'font-weight',
    'font-style',
    'text-anchor',
    'dominant-baseline',
    'clip-path',
    'clip-rule',
    'mask',
    'filter',
    'marker-start',
    'marker-mid',
    'marker-end',
    'cursor',
    'pointer-events',
    'overflow',
    'shape-rendering',
    'text-rendering',
    'image-rendering',
    'color-interpolation',
    'color-interpolation-filters',
    'paint-order',
    'vector-effect',
    'letter-spacing',
    'word-spacing',
    'text-decoration',
    'baseline-shift',
    'alignment-baseline',
    'x',
    'y',
    'width',
    'height',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'd',
  ]);
  /** The properties that inherit (SVG 2, Appendix: Property Index). */
  const INHERITED = new Set([
    'fill',
    'fill-opacity',
    'fill-rule',
    'stroke',
    'stroke-width',
    'stroke-opacity',
    'stroke-dasharray',
    'stroke-dashoffset',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-miterlimit',
    'visibility',
    'color',
    'font-size',
    'font-family',
    'font-weight',
    'font-style',
    'text-anchor',
    'dominant-baseline',
    'clip-rule',
    'marker-start',
    'marker-mid',
    'marker-end',
    'cursor',
    'pointer-events',
    'shape-rendering',
    'text-rendering',
    'image-rendering',
    'color-interpolation',
    'color-interpolation-filters',
    'paint-order',
    'letter-spacing',
    'word-spacing',
  ]);
  /** Which geometry properties an element has, of the names that are
   *  attributes elsewhere. */
  const GEOMETRY: Record<string, string[]> = {
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
    circle: ['cx', 'cy', 'r'],
    ellipse: ['cx', 'cy', 'rx', 'ry'],
    image: ['x', 'y', 'width', 'height'],
    foreignObject: ['x', 'y', 'width', 'height'],
    svg: ['x', 'y', 'width', 'height'],
    use: ['x', 'y', 'width', 'height'],
    symbol: ['x', 'y', 'width', 'height'],
    path: ['d'],
  };
  const isStyle = (target: Any, attr: string): boolean => {
    if (!CSS_PROPERTIES.has(attr)) return false;
    if (/^(x|y|width|height|cx|cy|r|rx|ry|d)$/.test(attr)) {
      return GEOMETRY[localName(target)]?.includes(attr) ?? false;
    }
    return true;
  };

  /** What everything animates at a time, by target and attribute: the
   *  value as the attribute's text and as a computed style's. */
  interface Sample {
    sig: string;
    times: Map<Any, number>;
    epoch: number;
    wave: number;
    pass: Pass;
    plans: Map<Any, Plan>;
    values: Map<Any, Map<string, { attr: string; css: string }>>;
    wheres: Map<Any, Where | null>;
  }
  let last: Sample | null = null;
  /** What moves wherever something changes what is sampled without a
   *  change to the tree: an instance time added. */
  let wave = 0;
  let generation = 0;

  const baseText = (target: Any, attr: string, plan: Plan): string | null => {
    if (plan.type === 'transform') return getAttr(target, attr) ?? '';
    // a geometry property is its attribute where it has one
    if (GEOMETRY[localName(target)]?.includes(attr)) {
      const raw = getAttr(target, attr);
      if (raw !== null) return raw;
    }
    if (isStyle(target, attr)) {
      const c = deps.computed(target, attr);
      if (c) return c;
    }
    const raw = getAttr(target, attr);
    if (raw !== null) return raw;
    if (plan.type === 'length') return '0';
    if (plan.type === 'color') return 'black';
    if (plan.type === 'nums' || plan.type === 'integer') return '0';
    if (plan.type === 'number') return NUMBER_DEFAULTS[attr] ?? '0';
    if (plan.type === 'boolean') return 'false';
    return '';
  };

  /** What a number is where nothing sets it. */
  const NUMBER_DEFAULTS: Record<string, string> = {
    opacity: '1',
    'fill-opacity': '1',
    'stroke-opacity': '1',
    'stop-opacity': '1',
    'flood-opacity': '1',
    'stroke-miterlimit': '4',
    scale: '0',
    surfaceScale: '1',
    specularConstant: '1',
    specularExponent: '1',
    diffuseConstant: '1',
    divisor: '1',
    amplitude: '1',
    exponent: '1',
    slope: '1',
  };

  const sample = (): Sample => {
    const epoch = deps.epoch();
    const els: Any[] = deps.animations();
    const times = new Map<Any, number>();
    let sig = '';
    let latest = 0;
    for (const el of els) {
      const t = elTime(el);
      times.set(el, t);
      sig += `${t},`;
      if (t > latest) latest = t;
    }
    if (
      last &&
      last.sig === sig &&
      last.epoch === epoch &&
      last.wave === wave
    ) {
      return last;
    }
    const pass = new Pass(latest, els);
    const plans = new Map<Any, Plan>();
    const wheres = new Map<Any, Where | null>();
    // by target and attribute, what animates it, in priority order
    const sandwiches = new Map<Any, Map<string, Array<[Plan, Where]>>>();
    for (const el of els) {
      const timing = pass.timing(el);
      const where = timing ? whereAt(timing, times.get(el)!) : null;
      wheres.set(el, where);
      if (!where || (!where.active && !timing!.freeze)) continue;
      const plan = planOf(el);
      if (!plan) continue;
      plans.set(el, plan);
      let byAttr = sandwiches.get(plan.target);
      if (!byAttr) sandwiches.set(plan.target, (byAttr = new Map()));
      let list = byAttr.get(plan.attr);
      if (!list) byAttr.set(plan.attr, (list = []));
      list.push([plan, where]);
    }
    const values = new Map<Any, Map<string, { attr: string; css: string }>>();
    for (const [target, byAttr] of sandwiches) {
      const out = new Map<string, { attr: string; css: string }>();
      for (const [attr, list] of byAttr) {
        // the later an interval began the higher it is, and the later in
        // the document among those that began together (SMIL 3, 3.5.4)
        list.sort(
          (a, b) =>
            a[1].iv.b - b[1].iv.b ||
            pass.order.get(a[0].el)! - pass.order.get(b[0].el)!,
        );
        if (attr === MOTION) {
          let m: number[] | null = null;
          for (const [plan, where] of list) {
            const own = motionAt(plan, where);
            if (!own) continue;
            m =
              getAttr(plan.el, 'additive') === 'sum' && m
                ? multiply(m, own)
                : own;
          }
          if (m) {
            const text = `matrix(${m.map(fmt).join(' ')})`;
            out.set(attr, { attr: text, css: text });
          }
          continue;
        }
        const plan0 = list[0][0];
        const baseRaw = baseText(target, attr, plan0);
        let under: Val | null =
          plan0.type === 'transform'
            ? {
                kind: 'transform',
                nums: [],
                template: [],
                text: baseRaw ?? '',
                type: '',
              }
            : parse(baseRaw, plan0.type, target, attr);
        let any = false;
        for (const [plan, where] of list) {
          const v = valueAt(plan, where, under);
          if (!v) continue;
          under = v;
          any = true;
        }
        if (any && under) {
          out.set(attr, {
            attr: serialize(under, false, plan0.type),
            css: serialize(under, true, plan0.type),
          });
        }
      }
      if (out.size) values.set(target, out);
    }
    last = { sig, times, epoch, wave, pass, plans, values, wheres };
    generation++;
    return last;
  };

  // --- the host's copy ---------------------------------------------------------------

  /** What the host was last handed, by element. */
  let pushed = new Map<Any, Map<string, string>>();
  const flush = (): void => {
    if (!any()) {
      if (!pushed.size) return;
    }
    const s = sample();
    const changes: Array<[Any, Record<string, string | null>]> = [];
    const next = new Map<Any, Map<string, string>>();
    for (const [el, vals] of s.values) {
      const was = pushed.get(el);
      const now = new Map<string, string>();
      const change: Record<string, string | null> = {};
      let changed = false;
      for (const [attr, v] of vals) {
        now.set(attr, v.attr);
        if (was?.get(attr) !== v.attr) {
          change[attr] = v.attr;
          changed = true;
        }
      }
      if (was) {
        for (const attr of was.keys()) {
          if (!now.has(attr)) {
            change[attr] = null;
            changed = true;
          }
        }
      }
      next.set(el, now);
      if (changed) changes.push([el, change]);
    }
    for (const [el, was] of pushed) {
      if (next.has(el)) continue;
      const change: Record<string, string | null> = {};
      for (const attr of was.keys()) change[attr] = null;
      changes.push([el, change]);
    }
    pushed = next;
    if (changes.length) deps.push(changes);
  };

  /** Whether the document has an element that animates, worked out once a
   *  change to the tree. */
  let anyAt = -1;
  let anyWas = false;
  const any = (): boolean => {
    const e = deps.epoch();
    if (e !== anyAt) {
      anyAt = e;
      anyWas = deps.animations().length > 0;
    }
    return anyWas;
  };

  // --- events and the clock's ticks ---------------------------------------------------

  /** SMIL's `TimeEvent` (SMIL 3, 5.6.1). */
  class TimeEvent extends Event {
    declare _view: Any;
    declare _detail: number;
    constructor(type: Any, init: Any = undefined) {
      super(type, init);
      this._view = init?.view ?? null;
      this._detail = init?.detail === undefined ? 0 : Number(init.detail) | 0;
    }
    get view(): Any {
      return this._view;
    }
    get detail(): number {
      return this._detail;
    }
    initTimeEvent(type: Any, view: Any = null, detail: Any = 0): void {
      (this as Any).initEvent?.(String(type), false, false);
      this._view = view;
      this._detail = Number(detail) | 0;
    }
  }
  /** What `onbegin`, `onend` and `onrepeat` were set to, by element. */
  const HANDLERS = new WeakMap<object, Record<string, Any>>();
  const handlerOf = (el: Any, short: string): Any => {
    const own = HANDLERS.get(el)?.[short];
    return own !== undefined ? own : deps.attributeHandler(el, short);
  };
  const SHORT_TYPES: Record<string, true> = {
    begin: true,
    end: true,
    repeat: true,
  };
  const SHORT: Record<string, string> = {
    beginEvent: 'begin',
    endEvent: 'end',
    repeatEvent: 'repeat',
  };
  const fire = (el: Any, type: string, detail = 0): void => {
    const view = el?.ownerDocument?.defaultView ?? null;
    const event = new TimeEvent(type, { view, detail });
    deps.fire(el, event);
    // `onbegin` is a handler of `beginEvent` (SVG Animations 2, 2.5)
    const fn = handlerOf(el, SHORT[type]);
    if (typeof fn === 'function') {
      try {
        Reflect.apply(fn, el, [event]);
      } catch (error) {
        deps.report(error);
      }
    }
  };

  /** Listens for the events an element's lists name, once a set of them. */
  const listen = (el: Any, pass: Pass): void => {
    const st = stateOf(el);
    const want: Array<[Any, string, 'begin' | 'end', number, string | null]> =
      [];
    for (const which of ['begin', 'end'] as const) {
      for (const s of specsOf(getAttr(el, which))) {
        if (s.kind === 'event') {
          const base = s.id === null ? targetOf(el) : pass.find(s.id!);
          if (base) want.push([base, s.event!, which, s.t, null]);
        } else if (s.kind === 'key') {
          want.push([
            (deps.document() as Any)?.defaultView,
            'keydown',
            which,
            s.t,
            s.key!,
          ]);
        }
      }
    }
    const key = want
      .map(
        (w) =>
          `${w[1]}|${w[2]}|${w[3]}|${w[4]}|${pass.order.get(w[0]) ?? (w[0] as Any)?.id ?? ''}`,
      )
      .join(';');
    if (key === st.heard && st.unlisten.length === want.length) return;
    for (const off of st.unlisten) off();
    st.unlisten = [];
    st.heard = key;
    for (const [base, type, which, off, char] of want) {
      if (!base?.addEventListener) continue;
      const fn = (e: Any): void => {
        if (char !== null && e?.key !== char) return;
        const t = elTime(el) + off;
        (which === 'begin' ? st.begins : st.ends).push(t);
        wave++;
        schedule(0);
      };
      base.addEventListener(type, fn);
      st.unlisten.push(() => base.removeEventListener(type, fn));
    }
  };

  /** Listens for what every element's lists name, as a page may start
   *  dispatching before the first update. */
  const listenAll = (): void => {
    const els: Any[] = deps.animations();
    if (!els.length) return;
    const s = sample();
    for (const el of els) listen(el, s.pass);
  };
  let timer: Any = null;
  let timerAt = Infinity;
  /** When each element was last updated, by its clock. */
  const LAST_TIMES = new WeakMap<Any, number>();
  const schedule = (ms: number): void => {
    const at = deps.now() + ms;
    if (timer !== null && timerAt <= at) return;
    if (timer !== null) deps.cancel(timer);
    timerAt = at;
    timer = deps.later(update, ms);
  };
  const update = (): void => {
    timer = null;
    timerAt = Infinity;
    if (!loaded) return;
    const els: Any[] = deps.animations();
    if (!els.length) {
      flush();
      return;
    }
    const s = sample();
    for (const el of els) listen(el, s.pass);
    const queue: Array<[number, number, Any, string, number]> = [];
    let n = 0;
    const event = (t: number, el: Any, type: string, detail = 0): void => {
      queue.push([t, n++, el, type, detail]);
    };
    const seekedNow = new Set<Clock>();
    let running = false;
    for (const el of els) {
      const c = clockOfEl(el);
      if (!c.started) continue;
      if (!c.paused) running = true;
      const seeked = c.seeked;
      if (seeked) seekedNow.add(c);
      const now = s.times.get(el)!;
      // an element first met is updated from where its clock last was, or
      // from just before 0
      const before = LAST_TIMES.get(el) ?? c.last;
      LAST_TIMES.set(el, now);
      const st = stateOf(el);
      const timing = s.pass.timing(el);
      const where = timing ? whereAt(timing, now) : null;
      const key = where && where.active ? where.iv.b : null;
      const iteration = where && where.active ? where.iteration : 0;
      const was = st.was;
      const wasKey = was ? was.key : null;
      if (!seeked && timing && before < now) {
        // every interval passed over between the two updates
        for (const iv of timing.intervals) {
          if (iv.b === wasKey || iv.b === key) continue;
          if (iv.b > before && iv.e <= now) {
            event(iv.b, el, 'beginEvent');
            event(iv.e, el, 'endEvent');
          }
        }
      }
      if (wasKey !== null && wasKey !== key) {
        const iv = timing?.intervals.find((i) => i.b === wasKey);
        event(seeked || !iv ? now : min(now, iv.e), el, 'endEvent');
      }
      if (key !== null && key !== wasKey) {
        event(seeked ? now : key, el, 'beginEvent');
      }
      if (
        !seeked &&
        key !== null &&
        key === wasKey &&
        was &&
        iteration > was.iteration
      ) {
        for (let k = was.iteration + 1; k <= iteration; k++) {
          event(where!.iv.b + k * timing!.dur, el, 'repeatEvent', k);
        }
      } else if (!seeked && key !== null && key !== wasKey && iteration > 0) {
        for (let k = 1; k <= iteration; k++) {
          event(where!.iv.b + k * timing!.dur, el, 'repeatEvent', k);
        }
      }
      st.was = { key, iteration };
    }
    for (const c of seekedNow) c.seeked = false;
    for (const el of els) {
      const c = clockOfEl(el);
      if (c.started) c.last = s.times.get(el)!;
    }
    flush();
    // an interval's end before the next one's begin, and its begin before
    // its repeats, at one time
    const RANK: Record<string, number> = {
      endEvent: 0,
      beginEvent: 1,
      repeatEvent: 2,
    };
    queue.sort((a, b) => a[0] - b[0] || RANK[a[3]] - RANK[b[3]] || a[1] - b[1]);
    for (const [, , el, type, detail] of queue) fire(el, type, detail);
    // the next tick, while a clock runs and something may change
    if (running) schedule(16);
  };

  deps.onLoad(() => {
    if (loaded) return;
    loaded = true;
    for (const c of ALL_CLOCKS) {
      c.started = true;
      if (!c.paused) c.origin = deps.now() - c.at * 1000;
    }
    // what an event begins is heard from the first, before the page's own
    // `load` listeners run
    listenAll();
    schedule(0);
  });

  // --- the members -----------------------------------------------------------------

  const method = (fn: (...args: Any[]) => Any): PropertyDescriptor => ({
    value: fn,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  const animationHandlers: Record<string, PropertyDescriptor> = {};
  const svgMembers: Record<string, PropertyDescriptor> = {
    pauseAnimations: method(function (this: Any) {
      const c = clockFor(this);
      if (c.paused) return;
      c.at = timeOf(c);
      c.paused = true;
    }),
    unpauseAnimations: method(function (this: Any) {
      const c = clockFor(this);
      if (!c.paused) return;
      c.paused = false;
      c.origin = deps.now() - c.at * 1000;
      schedule(0);
    }),
    animationsPaused: method(function (this: Any) {
      return clockFor(this).paused;
    }),
    getCurrentTime: method(function (this: Any) {
      return Math.fround(timeOf(clockFor(this)));
    }),
    setCurrentTime: method(function (this: Any, seconds: Any) {
      if (arguments.length < 1) {
        throw new TypeError(
          "Failed to execute 'setCurrentTime' on 'SVGSVGElement': 1 argument required, but only 0 present.",
        );
      }
      let t = Math.fround(Number(seconds));
      if (!isFinite(t)) {
        throw new TypeError(
          "Failed to execute 'setCurrentTime' on 'SVGSVGElement': The provided float value is non-finite.",
        );
      }
      if (t < 0) t = 0;
      const c = clockFor(this);
      setTime(c, t);
      c.seeked = true;
      schedule(0);
    }),
  };

  for (const short of ['begin', 'end', 'repeat']) {
    svgHandler(short);
  }
  function svgHandler(short: string): void {
    animationHandlers[`on${short}`] = {
      get(this: Any) {
        const fn = handlerOf(this, short);
        return typeof fn === 'function' ? fn : null;
      },
      set(this: Any, v: Any) {
        let own = HANDLERS.get(this);
        if (!own) HANDLERS.set(this, (own = {}));
        own[short] =
          typeof v === 'function' || (typeof v === 'object' && v) ? v : null;
        listenAll();
      },
      enumerable: true,
      configurable: true,
    };
  }
  const timingOf = (el: Any): Timing | null => sample().pass.timing(el);
  const animationMembers: Record<string, PropertyDescriptor> = {
    getStartTime: method(function (this: Any) {
      const timing =
        isAnimation(this) && this.isConnected ? timingOf(this) : null;
      const t = elTime(this);
      const ivs = timing?.intervals ?? [];
      let found: Interval | undefined;
      for (const iv of ivs) {
        if (iv.b <= t && t < iv.e) found = iv;
      }
      // the interval that holds the time, or the next to begin: one that
      // has ended is no current interval (Blink)
      found ??= ivs.find((iv) => iv.b > t);
      if (!found) {
        throw new DOMException(
          "Failed to execute 'getStartTime' on 'SVGAnimationElement': No current interval.",
          'InvalidStateError',
        );
      }
      return Math.fround(found.b);
    }),
    getCurrentTime: method(function (this: Any) {
      return Math.fround(elTime(this));
    }),
    getSimpleDuration: method(function (this: Any) {
      const d = durOf(this);
      if (!isFinite(d)) {
        throw new DOMException(
          "Failed to execute 'getSimpleDuration' on 'SVGAnimationElement': No simple duration defined.",
          'NotSupportedError',
        );
      }
      return Math.fround(d);
    }),
    beginElement: method(function (this: Any) {
      stateOf(this).begins.push(elTime(this));
      wave++;
      schedule(0);
    }),
    beginElementAt: method(function (this: Any, offset: Any) {
      const o = Math.fround(Number(offset));
      if (!isFinite(o)) {
        throw new TypeError(
          "Failed to execute 'beginElementAt' on 'SVGAnimationElement': The provided float value is non-finite.",
        );
      }
      stateOf(this).begins.push(elTime(this) + o);
      wave++;
      schedule(0);
    }),
    endElement: method(function (this: Any) {
      stateOf(this).ends.push(elTime(this));
      wave++;
      schedule(0);
    }),
    endElementAt: method(function (this: Any, offset: Any) {
      const o = Math.fround(Number(offset));
      if (!isFinite(o)) {
        throw new TypeError(
          "Failed to execute 'endElementAt' on 'SVGAnimationElement': The provided float value is non-finite.",
        );
      }
      stateOf(this).ends.push(elTime(this) + o);
      wave++;
      schedule(0);
    }),
  };

  // --- what reads it ---------------------------------------------------------------

  const valuesOf = (
    el: Any,
  ): Map<string, { attr: string; css: string }> | undefined => {
    if (!any()) return undefined;
    return sample().values.get(el);
  };
  const animAttr = (el: Any, name: string): string | undefined => {
    const vals = valuesOf(el);
    if (!vals) return undefined;
    const n = name === 'xlink:href' ? 'href' : name;
    return vals.get(n)?.attr;
  };
  const styleOf = (
    el: Any,
    property: string,
    base: string,
  ): string | undefined => {
    if (!any()) return undefined;
    const s = sample();
    const own = s.values.get(el)?.get(property);
    if (own && isStyle(el, property)) return own.css;
    if (!INHERITED.has(property)) return undefined;
    for (let at = el?.parentElement; at; at = at.parentElement) {
      const v = s.values.get(at)?.get(property);
      if (!v) continue;
      // inherited where what the element computes to is its parent's
      return deps.computed(at, property) === base ? v.css : undefined;
    }
    return undefined;
  };

  return {
    interfaces: { TimeEvent },
    animationMembers: { ...animationMembers, ...animationHandlers },
    svgMembers,
    animAttr,
    styleOf,
    ownsHandler: (el: Any, type: string) =>
      type in SHORT_TYPES && isAnimation(el),
    generation: () => {
      if (any()) sample();
      return generation;
    },
    flush: () => {
      if (any() || pushed.size) flush();
    },
    active: any,
  };
}
