// SVG 2's DOM types (4, "Basic data types and interfaces"), as a page's
// scripts see them: the values an attribute is reflected as — `SVGLength`,
// `SVGNumber`, `SVGAngle`, `SVGPoint`, `SVGRect`, `SVGMatrix`, `SVGTransform`
// and `SVGPreserveAspectRatio` —, the live lists of them, the `SVGAnimated…`
// objects an element's attributes are, and the element interfaces' tables of
// which attribute is which.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing, and `installDom` is handed it and calls it with
// what it needs of the DOM.
//
// d3, draw.io and every chart library read a drawing's geometry through
// these — `rect.x.baseVal.value`, `svg.viewBox.baseVal`,
// `g.transform.baseVal.consolidate()` — and set it through them, so an
// attribute and the object reflecting it are one value: a write through
// `baseVal` sets the attribute, and an attribute set any other way shows in
// a `baseVal` a page holds. An `animVal` reads what SMIL animation sets
// (`smil.ts`, through `animAttr`), and is read-only.
//
// What each object holds is in a `WeakMap` by the object, as Web IDL keeps
// an interface's internal slots, so its attributes are accessors on its
// prototype. An object reflecting an attribute reads it again only where the
// count `epoch()` moved since it last did — that count moves at every op
// that can change an attribute and at every task — and parses it again only
// where its text changed. A list does the same, and keeps the objects it
// holds across a change of its attribute as SVG 2 has it (4.5.4,
// "synchronizing a list"): a held item takes the new value at its index, and
// only an item past the new end is detached.
//
// `SVGPoint`, `SVGRect` and `SVGMatrix` are interfaces of their own, as every
// engine ships them and as svgwg#706 resolved, and not the geometry
// interfaces' other names: their numbers are `float`s, which a non-finite
// value is a `TypeError` for.
//
// Where the engines differ, this is the answer two of the three give, and
// Chromium's where all three differ; `test/html/svg-dom.test.ts` holds each
// to them.

/** What `installDom` hands this. */
export interface SvgDomDeps {
  DOMException: unknown;
  /** An attribute's value as the tree keeps it, by the name it is kept
   *  under, or null. */
  getAttr(el: unknown, name: string): string | null;
  /** An attribute as animation has it now (`smil.ts`), or undefined where
   *  nothing animates it: what an `animVal` reads. */
  animAttr?(el: unknown, name: string): string | undefined;
  /** What moves wherever an animated value may have. */
  animEpoch?(): number;
  /** An attribute set by the name it is kept under, as `setAttribute`. */
  setAttr(el: unknown, name: string, value: string): void;
  /** What moves wherever an attribute may have changed since. */
  epoch(): number;
  /** What one of a relative unit comes to for an element, in CSS pixels:
   *  `%` as a percentage of its viewport along `axis` ('x', 'y' or 'xy').
   *  An element of null answers for no element; null where there is no
   *  answer, an element in no document. */
  unitSize(el: unknown, unit: string, axis: string): number | null;
  /** A live list of `Proto`'s holding what `read` answers now
   *  (`listMade`), and its state. */
  listOf(Proto: unknown, read: () => unknown[]): unknown;
  listState(list: unknown): Record<string, unknown>;
  /** A `DOMMatrix2DInit`'s six numbers, validated (Geometry 1, 6.2). */
  values2D(init: unknown, fail: string): number[];
  /** An interface's attributes as Web IDL has them. */
  idlAttributes(Interface: unknown): void;
  /** The facade's element interfaces, by name. */
  elements: Record<string, unknown>;
  /** The document interface, for `rootElement`. */
  Document: unknown;
}

/** What `installDom` has of this. */
export interface SvgDomInstall {
  /** The interfaces a window exposes, by name: the types, and the element
   *  interfaces this adds. */
  interfaces: Record<string, unknown>;
  /** The element interfaces this adds, by the local name they are made
   *  for. */
  tags: Record<string, unknown>;
  /** A new `SVGPoint`, `SVGRect` or `SVGMatrix`, for what an element
   *  answers with one. */
  point(x: number, y: number): unknown;
  rect(x: number, y: number, width: number, height: number): unknown;
  matrix(values: ArrayLike<number>): unknown;
}

export function installSvgDom(deps: SvgDomDeps): SvgDomInstall {
  'use strict';
  type Any = any;
  const DOMException: Any = deps.DOMException;
  const { setAttr, epoch, unitSize, listOf, listState, values2D } = deps;
  /** Whether what reads an attribute now is an `animVal`, which reads it as
   *  animation has it. */
  let animReading = false;
  const getAttr = (el: Any, name: string): string | null => {
    if (animReading && deps.animAttr) {
      const v = deps.animAttr(el, name);
      if (v !== undefined) return v;
    }
    return deps.getAttr(el, name);
  };
  /** Reads as an `animVal` does. */
  const asAnimated = <T>(anim: boolean, read: () => T): T => {
    if (!deps.animAttr) return read();
    const was = animReading;
    animReading = anim;
    try {
      return read();
    } finally {
      animReading = was;
    }
  };
  /** The count an object reflecting an attribute is fresh for: an
   *  `animVal`'s moves with animation too. */
  const epochFor = (anim: boolean): number | string =>
    anim && deps.animEpoch ? `${epoch()}|${deps.animEpoch()}` : epoch();
  const E: Any = deps.elements;
  const create = Object.create;
  const defineProperty = Object.defineProperty;
  const fround = Math.fround;
  const isFinite = Number.isFinite;
  const apply: Any = Reflect.apply;
  const wmGet = WeakMap.prototype.get;
  const wmSet = WeakMap.prototype.set;

  // --- slots ------------------------------------------------------------------

  /** Every object's internal slots, by the object. */
  const SLOTS = new WeakMap<object, Any>();
  const slotOf = (o: Any, kind: string): Any => {
    const s =
      typeof o === 'object' && o !== null
        ? apply(wmGet, SLOTS, [o])
        : undefined;
    if (!s || s.kind !== kind) throw new TypeError('Illegal invocation');
    return s;
  };
  const made = (Kind: Any, slots: Any): Any => {
    const o = create(Kind.prototype);
    apply(wmSet, SLOTS, [o, slots]);
    slots.self = o;
    return o;
  };
  const isA = (o: Any, kind: string): boolean => {
    const s =
      typeof o === 'object' && o !== null
        ? apply(wmGet, SLOTS, [o])
        : undefined;
    return !!s && s.kind === kind;
  };
  const illegal = function (): never {
    throw new TypeError('Illegal constructor');
  };
  const readOnly = (what: string): never => {
    throw new DOMException(
      `Failed to set ${what}: The object is read-only.`,
      'NoModificationAllowedError',
    );
  };
  const required = (n: number, got: number, what: string): void => {
    if (got < n) {
      throw new TypeError(
        `Failed to execute '${what}': ${n} argument${n > 1 ? 's' : ''} required, but only ${got} present.`,
      );
    }
  };

  // --- Web IDL's numbers ----------------------------------------------------------

  /** A `float` (Web IDL 3.2.5): a non-finite one is a `TypeError`. */
  const toFloat = (v: Any): number => {
    const n = +v;
    const f = fround(n);
    if (!isFinite(f)) {
      throw new TypeError('The provided float value is non-finite.');
    }
    return f;
  };
  const toUShort = (v: Any): number => {
    const n = +v;
    if (!isFinite(n)) return 0;
    return ((Math.trunc(n) % 65536) + 65536) % 65536;
  };
  const toLong = (v: Any): number => {
    const n = +v;
    return isFinite(n) ? Math.trunc(n) | 0 : 0;
  };
  const toULong = (v: Any): number => {
    const n = +v;
    return isFinite(n) ? Math.trunc(n) >>> 0 : 0;
  };

  /** A number as an SVG value is serialized: six significant digits, as
   *  C's `%g` writes them, which Chromium and Firefox both do. */
  const fmt = (x: number): string => {
    if (x === 0 || !isFinite(x)) return x === 0 ? '0' : String(x);
    const parts = x.toExponential(5).split('e');
    const exp = +parts[1];
    if (exp < -4 || exp >= 6) {
      let m = parts[0];
      if (m.includes('.')) m = m.replace(/0+$/, '').replace(/\.$/, '');
      const e = Math.abs(exp);
      return `${m}e${exp < 0 ? '-' : '+'}${e < 10 ? '0' : ''}${e}`;
    }
    const s = x.toPrecision(6);
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  };

  // --- what an attribute's text says -----------------------------------------------

  const NUMBER_SRC = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
  const NUMBER = new RegExp(`^\\s*(${NUMBER_SRC})\\s*$`);
  const NUMBER_AT = new RegExp(NUMBER_SRC, 'y');
  /** A number an attribute holds, or null. A float's largest stands for
   *  one past it, as Chromium reads `1e40`. */
  const numberOf = (text: string | null): number | null => {
    if (text === null) return null;
    const m = NUMBER.exec(text);
    return m ? clampFloat(+m[1]) : null;
  };
  const FLT_MAX = 3.4028234663852886e38;
  const clampFloat = (n: number): number =>
    fround(n > FLT_MAX ? FLT_MAX : n < -FLT_MAX ? -FLT_MAX : n);

  /** The numbers of a list of them, separated by white space and a comma
   *  at most between two, or null where something else is in it. */
  const numbersOf = (text: string): number[] | null => {
    const out: number[] = [];
    let i = 0;
    const space = (): void => {
      while (i < text.length && /[\s]/.test(text[i])) i += 1;
    };
    space();
    while (i < text.length) {
      NUMBER_AT.lastIndex = i;
      const m = NUMBER_AT.exec(text);
      if (!m) return null;
      out.push(clampFloat(+m[0]));
      i += m[0].length;
      space();
      if (text[i] === ',') {
        i += 1;
        space();
        if (i >= text.length) return null;
      }
    }
    return out;
  };

  /** The units a length takes (CSS Values 4), and the ten SVG names. */
  const UNIT_TYPES: Record<string, number> = {
    '': 1,
    '%': 2,
    em: 3,
    ex: 4,
    px: 5,
    cm: 6,
    mm: 7,
    in: 8,
    pt: 9,
    pc: 10,
  };
  const UNIT_NAMES = [
    '',
    '',
    '%',
    'em',
    'ex',
    'px',
    'cm',
    'mm',
    'in',
    'pt',
    'pc',
  ];
  const OTHER_UNITS = new Set([
    'q',
    'rem',
    'ch',
    'rch',
    'rex',
    'cap',
    'rcap',
    'ic',
    'ric',
    'lh',
    'rlh',
    'vw',
    'vh',
    'vi',
    'vb',
    'vmin',
    'vmax',
    'svw',
    'svh',
    'svi',
    'svb',
    'svmin',
    'svmax',
    'lvw',
    'lvh',
    'lvi',
    'lvb',
    'lvmin',
    'lvmax',
    'dvw',
    'dvh',
    'dvi',
    'dvb',
    'dvmin',
    'dvmax',
    'cqw',
    'cqh',
    'cqi',
    'cqb',
    'cqmin',
    'cqmax',
  ]);
  /** User units, which are CSS pixels, to one of each absolute unit. */
  const ABSOLUTE: Record<string, number> = {
    '': 1,
    px: 1,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    pt: 4 / 3,
    pc: 16,
    q: 96 / 101.6,
  };
  const LENGTH = new RegExp(`^\\s*(${NUMBER_SRC})([a-zA-Z]+|%)?\\s*$`);
  const LENGTH_AT = new RegExp(`(${NUMBER_SRC})([a-zA-Z]+|%)?`, 'y');
  /** A length's number and unit, or null. */
  const lengthOf = (text: string | null): [number, string] | null => {
    if (text === null) return null;
    const m = LENGTH.exec(text);
    if (!m) return null;
    const unit = (m[2] ?? '').toLowerCase();
    if (!(unit in UNIT_TYPES) && !OTHER_UNITS.has(unit)) return null;
    return [clampFloat(+m[1]), unit];
  };
  const lengthsOf = (text: string): Array<[number, string]> | null => {
    const out: Array<[number, string]> = [];
    let i = 0;
    const space = (): void => {
      while (i < text.length && /\s/.test(text[i])) i += 1;
    };
    space();
    while (i < text.length) {
      LENGTH_AT.lastIndex = i;
      const m = LENGTH_AT.exec(text);
      if (!m) return null;
      const unit = (m[2] ?? '').toLowerCase();
      if (!(unit in UNIT_TYPES) && !OTHER_UNITS.has(unit)) return null;
      out.push([clampFloat(+m[1]), unit]);
      i += m[0].length;
      if (i < text.length && !/[\s,]/.test(text[i])) return null;
      space();
      if (text[i] === ',') {
        i += 1;
        space();
        if (i >= text.length) return null;
      }
    }
    return out;
  };

  // --- reflection ---------------------------------------------------------------

  /**
   * An object reflecting an attribute holds `ref`: the element, the
   * attribute's name, what it read last and when. `fresh` reads the
   * attribute again where the count moved, and hands the slots to their
   * `load` where its text changed; `store` writes what the slots now say.
   * A list's item holds `list` instead, which its list keeps fresh; and an
   * `SVGMatrix` of a transform, `owner`, the transform's slots.
   */
  const fresh = (s: Any): void => {
    if (s.owner) fresh(s.owner);
    else if (s.list) syncList(s.list);
    else if (s.ref) {
      const r = s.ref;
      const anim = !!s.ro;
      const now = epochFor(anim);
      if (r.at === now) return;
      r.at = now;
      const raw = asAnimated(anim, () => getAttr(r.el, r.attr));
      if (raw === r.raw) return;
      r.raw = raw;
      s.load(s, raw);
    }
  };
  /** What a write through an object does to what it reflects. */
  const wrote = (s: Any): void => {
    if (s.synced) s.synced(s);
    if (s.owner) {
      wrote(s.owner);
    } else if (s.list) {
      writeList(s.list);
    } else if (s.ref) {
      const r = s.ref;
      const text = s.text(s);
      setAttr(r.el, r.attr, text);
      r.raw = text;
      r.at = epoch();
    }
  };
  /** Whether an object may be written, and fresh before it is. */
  const writable = (s: Any, what: string): void => {
    if (s.ro || s.owner?.ro) readOnly(what);
    fresh(s);
  };
  const reflecting = (el: Any, attr: string): Any => ({
    el,
    attr,
    at: -1,
    raw: undefined,
  });

  // --- SVGNumber ------------------------------------------------------------------

  class SVGNumber {
    constructor() {
      illegal();
    }
    get value(): number {
      const s = slotOf(this, 'number');
      fresh(s);
      return s.n;
    }
    set value(v: Any) {
      const s = slotOf(this, 'number');
      const n = toFloat(v);
      writable(s, "the 'value' property on 'SVGNumber'");
      s.n = n;
      wrote(s);
    }
  }
  const numberMade = (n: number): Any =>
    made(SVGNumber, { kind: 'number', n, ro: false, list: null });

  // --- SVGLength ------------------------------------------------------------------

  /** What one of a length's unit comes to, in user units: none for a length
   *  of no element is a percentage of 100 and the initial font's. */
  const unitIn = (s: Any, unit: string): number => {
    const absolute = ABSOLUTE[unit];
    if (absolute !== undefined) return absolute;
    const el = s.ref?.el ?? s.list?.el ?? null;
    if (el === null && unit === '%') return 1;
    const size = unitSize(el, unit, s.axis ?? 'xy');
    if (size === null || !isFinite(size)) {
      throw new DOMException(
        'Could not resolve relative length.',
        'NotSupportedError',
      );
    }
    return size;
  };
  /** A length attribute's value, as the property it stands for takes it:
   *  a geometry property's size is no negative length (SVG 2, 9.4, which
   *  WPT holds Firefox to, where Chromium and WebKit keep it), and a
   *  corner's radius `auto` is the number 0, as all three read it. */
  const loadLength = (s: Any, raw: string | null): void => {
    let got = lengthOf(raw);
    if (got && s.positive && got[0] < 0) got = null;
    got ??= lengthOf(s.initial);
    s.n = got ? got[0] : 0;
    s.unit = got ? got[1] : '';
  };
  const lengthText = (s: Any): string => fmt(s.n) + s.unit;
  const lengthMade = (n: number, unit: string, axis: string): Any =>
    made(SVGLength, {
      kind: 'length',
      n,
      unit,
      axis,
      ro: false,
      list: null,
      ref: null,
      initial: '0',
      load: loadLength,
      text: lengthText,
    });
  const LENGTH_WHAT = (name: string) => `the '${name}' property on 'SVGLength'`;
  class SVGLength {
    constructor() {
      illegal();
    }
    get unitType(): number {
      const s = slotOf(this, 'length');
      fresh(s);
      return UNIT_TYPES[s.unit] ?? 0;
    }
    get value(): number {
      const s = slotOf(this, 'length');
      fresh(s);
      return fround(s.n * unitIn(s, s.unit));
    }
    set value(v: Any) {
      const s = slotOf(this, 'length');
      const n = toFloat(v);
      writable(s, LENGTH_WHAT('value'));
      const per = unitIn(s, s.unit);
      s.n = per ? fround(n / per) : 0;
      wrote(s);
    }
    get valueInSpecifiedUnits(): number {
      const s = slotOf(this, 'length');
      fresh(s);
      return s.n;
    }
    set valueInSpecifiedUnits(v: Any) {
      const s = slotOf(this, 'length');
      const n = toFloat(v);
      writable(s, LENGTH_WHAT('valueInSpecifiedUnits'));
      s.n = n;
      wrote(s);
    }
    get valueAsString(): string {
      const s = slotOf(this, 'length');
      fresh(s);
      return lengthText(s);
    }
    set valueAsString(v: Any) {
      const s = slotOf(this, 'length');
      const text = `${v}`;
      writable(s, LENGTH_WHAT('valueAsString'));
      const got = lengthOf(text);
      if (!got) {
        throw new DOMException(
          `Failed to set the 'valueAsString' property on 'SVGLength': The value provided ('${text}') is invalid.`,
          'SyntaxError',
        );
      }
      s.n = got[0];
      s.unit = got[1];
      wrote(s);
    }
    newValueSpecifiedUnits(unitType: Any, valueInSpecifiedUnits: Any): void {
      const s = slotOf(this, 'length');
      required(2, arguments.length, 'newValueSpecifiedUnits');
      const type = toUShort(unitType);
      const n = toFloat(valueInSpecifiedUnits);
      writable(s, LENGTH_WHAT('valueInSpecifiedUnits'));
      if (!(type >= 1 && type <= 10)) {
        throw new DOMException(
          "Failed to execute 'newValueSpecifiedUnits' on 'SVGLength': Cannot set value with unknown or invalid units.",
          'NotSupportedError',
        );
      }
      s.n = n;
      s.unit = UNIT_NAMES[type];
      wrote(s);
    }
    convertToSpecifiedUnits(unitType: Any): void {
      const s = slotOf(this, 'length');
      required(1, arguments.length, 'convertToSpecifiedUnits');
      const type = toUShort(unitType);
      writable(s, LENGTH_WHAT('value'));
      if (!(type >= 1 && type <= 10)) {
        throw new DOMException(
          "Failed to execute 'convertToSpecifiedUnits' on 'SVGLength': Cannot convert to unknown or invalid units.",
          'NotSupportedError',
        );
      }
      const absolute = fround(s.n * unitIn(s, s.unit));
      const unit = UNIT_NAMES[type];
      const per = unitIn(s, unit);
      s.n = per ? fround(absolute / per) : 0;
      s.unit = unit;
      wrote(s);
    }
  }
  const LENGTH_CONSTANTS = {
    SVG_LENGTHTYPE_UNKNOWN: 0,
    SVG_LENGTHTYPE_NUMBER: 1,
    SVG_LENGTHTYPE_PERCENTAGE: 2,
    SVG_LENGTHTYPE_EMS: 3,
    SVG_LENGTHTYPE_EXS: 4,
    SVG_LENGTHTYPE_PX: 5,
    SVG_LENGTHTYPE_CM: 6,
    SVG_LENGTHTYPE_MM: 7,
    SVG_LENGTHTYPE_IN: 8,
    SVG_LENGTHTYPE_PT: 9,
    SVG_LENGTHTYPE_PC: 10,
  };

  // --- SVGAngle -------------------------------------------------------------------

  const ANGLE_TYPES: Record<string, number> = {
    '': 1,
    deg: 2,
    rad: 3,
    grad: 4,
  };
  const ANGLE_NAMES = ['', '', 'deg', 'rad', 'grad'];
  /** Degrees to one of each unit. */
  const DEGREES: Record<string, number> = {
    '': 1,
    deg: 1,
    rad: 180 / Math.PI,
    grad: 0.9,
    turn: 360,
  };
  const ANGLE = new RegExp(
    `^\\s*(${NUMBER_SRC})(deg|rad|grad|turn)?\\s*$`,
    'i',
  );
  const angleOf = (text: string | null): [number, string] | null => {
    if (text === null) return null;
    const m = ANGLE.exec(text);
    return m ? [clampFloat(+m[1]), (m[2] ?? '').toLowerCase()] : null;
  };
  const angleText = (s: Any): string => fmt(s.n) + s.unit;
  const angleMade = (): Any =>
    made(SVGAngle, { kind: 'angle', n: 0, unit: '', ro: false, owner: null });
  const ANGLE_WHAT = (name: string) => `the '${name}' property on 'SVGAngle'`;
  class SVGAngle {
    constructor() {
      illegal();
    }
    get unitType(): number {
      const s = slotOf(this, 'angle');
      fresh(s);
      return ANGLE_TYPES[s.unit] ?? 0;
    }
    get value(): number {
      const s = slotOf(this, 'angle');
      fresh(s);
      return clampFloat(s.n * DEGREES[s.unit]);
    }
    set value(v: Any) {
      const s = slotOf(this, 'angle');
      const n = toFloat(v);
      writable(s, ANGLE_WHAT('value'));
      s.n = fround(n / DEGREES[s.unit]);
      wroteAngle(s);
    }
    get valueInSpecifiedUnits(): number {
      const s = slotOf(this, 'angle');
      fresh(s);
      return s.n;
    }
    set valueInSpecifiedUnits(v: Any) {
      const s = slotOf(this, 'angle');
      const n = toFloat(v);
      writable(s, ANGLE_WHAT('valueInSpecifiedUnits'));
      s.n = n;
      wroteAngle(s);
    }
    get valueAsString(): string {
      const s = slotOf(this, 'angle');
      fresh(s);
      return angleText(s);
    }
    set valueAsString(v: Any) {
      const s = slotOf(this, 'angle');
      const text = `${v}`;
      writable(s, ANGLE_WHAT('valueAsString'));
      const got = angleOf(text);
      if (!got) {
        throw new DOMException(
          `Failed to set the 'valueAsString' property on 'SVGAngle': The value provided ('${text}') is invalid.`,
          'SyntaxError',
        );
      }
      s.n = got[0];
      s.unit = got[1];
      wroteAngle(s);
    }
    newValueSpecifiedUnits(unitType: Any, valueInSpecifiedUnits: Any): void {
      const s = slotOf(this, 'angle');
      required(2, arguments.length, 'newValueSpecifiedUnits');
      const type = toUShort(unitType);
      const n = toFloat(valueInSpecifiedUnits);
      writable(s, ANGLE_WHAT('valueInSpecifiedUnits'));
      if (!(type >= 1 && type <= 4)) {
        throw new DOMException(
          "Failed to execute 'newValueSpecifiedUnits' on 'SVGAngle': Cannot set value with unknown or invalid units.",
          'NotSupportedError',
        );
      }
      s.n = n;
      s.unit = ANGLE_NAMES[type];
      wroteAngle(s);
    }
    convertToSpecifiedUnits(unitType: Any): void {
      const s = slotOf(this, 'angle');
      required(1, arguments.length, 'convertToSpecifiedUnits');
      const type = toUShort(unitType);
      writable(s, ANGLE_WHAT('value'));
      if (!(type >= 1 && type <= 4)) {
        throw new DOMException(
          "Failed to execute 'convertToSpecifiedUnits' on 'SVGAngle': Cannot convert to unknown or invalid units.",
          'NotSupportedError',
        );
      }
      const degrees = s.n * DEGREES[s.unit];
      s.unit = ANGLE_NAMES[type];
      s.n = fround(degrees / DEGREES[s.unit]);
      wroteAngle(s);
    }
  }
  /** A write through a marker's angle sets its `orient` to the angle. */
  const wroteAngle = (s: Any): void => {
    if (s.marker) {
      s.marker.type = 2;
      wrote(s.marker);
    }
  };
  const ANGLE_CONSTANTS = {
    SVG_ANGLETYPE_UNKNOWN: 0,
    SVG_ANGLETYPE_UNSPECIFIED: 1,
    SVG_ANGLETYPE_DEG: 2,
    SVG_ANGLETYPE_RAD: 3,
    SVG_ANGLETYPE_GRAD: 4,
  };

  // --- SVGPoint, SVGRect, SVGMatrix ---------------------------------------------

  const pointMade = (x: number, y: number): Any =>
    made(SVGPoint, { kind: 'point', x, y, ro: false, list: null });
  class SVGPoint {
    constructor() {
      illegal();
    }
    get x(): number {
      const s = slotOf(this, 'point');
      fresh(s);
      return s.x;
    }
    set x(v: Any) {
      const s = slotOf(this, 'point');
      const n = toFloat(v);
      writable(s, "the 'x' property on 'SVGPoint'");
      s.x = n;
      wrote(s);
    }
    get y(): number {
      const s = slotOf(this, 'point');
      fresh(s);
      return s.y;
    }
    set y(v: Any) {
      const s = slotOf(this, 'point');
      const n = toFloat(v);
      writable(s, "the 'y' property on 'SVGPoint'");
      s.y = n;
      wrote(s);
    }
    matrixTransform(matrix: Any = undefined): Any {
      const s = slotOf(this, 'point');
      fresh(s);
      const m = matrix2DOf(matrix, 'matrixTransform', 'SVGPoint');
      return pointMade(
        fround(m[0] * s.x + m[2] * s.y + m[4]),
        fround(m[1] * s.x + m[3] * s.y + m[5]),
      );
    }
  }

  const rectMade = (x: number, y: number, w: number, h: number): Any =>
    made(SVGRect, { kind: 'rect', x, y, w, h, ro: false, ref: null });
  const RECT_FIELDS: Array<[string, string]> = [
    ['x', 'x'],
    ['y', 'y'],
    ['width', 'w'],
    ['height', 'h'],
  ];
  class SVGRect {
    constructor() {
      illegal();
    }
  }
  for (const [name, field] of RECT_FIELDS) {
    defineProperty(SVGRect.prototype, name, {
      get(this: Any) {
        const s = slotOf(this, 'rect');
        fresh(s);
        return s[field];
      },
      set(this: Any, v: Any) {
        const s = slotOf(this, 'rect');
        const n = toFloat(v);
        writable(s, `the '${name}' property on 'SVGRect'`);
        s[field] = n;
        wrote(s);
      },
      configurable: true,
    });
  }

  /** A `DOMMatrix2DInit`'s six numbers, an `SVGMatrix`'s own among them. */
  const matrix2DOf = (init: Any, op: string, on: string): number[] =>
    isA(init, 'matrix')
      ? numbersOfMatrix(apply(wmGet, SLOTS, [init]))
      : values2D(init, `Failed to execute '${op}' on '${on}'`);
  const numbersOfMatrix = (s: Any): number[] => {
    fresh(s);
    const m = s.m;
    return [m[0], m[1], m[2], m[3], m[4], m[5]];
  };
  const matrixMade = (m: ArrayLike<number>): Any =>
    made(SVGMatrix, {
      kind: 'matrix',
      m: [m[0], m[1], m[2], m[3], m[4], m[5]],
      owner: null,
    });
  /** `a × b`, each six numbers of a 2D matrix. */
  const multiply = (a: number[], b: number[]): number[] => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  const rad = (degrees: number): number => (degrees * Math.PI) / 180;
  const MATRIX_FIELDS = ['a', 'b', 'c', 'd', 'e', 'f'];
  class SVGMatrix {
    constructor() {
      illegal();
    }
    multiply(secondMatrix: Any = undefined): Any {
      const s = slotOf(this, 'matrix');
      const b = matrix2DOf(secondMatrix, 'multiply', 'SVGMatrix');
      return matrixMade(multiply(numbersOfMatrix(s), b));
    }
    inverse(): Any {
      const m = numbersOfMatrix(slotOf(this, 'matrix'));
      const det = m[0] * m[3] - m[1] * m[2];
      if (!det || !isFinite(det)) {
        throw new DOMException(
          "Failed to execute 'inverse' on 'SVGMatrix': The matrix is not invertible.",
          'InvalidStateError',
        );
      }
      return matrixMade([
        m[3] / det,
        -m[1] / det,
        -m[2] / det,
        m[0] / det,
        (m[2] * m[5] - m[3] * m[4]) / det,
        (m[1] * m[4] - m[0] * m[5]) / det,
      ]);
    }
    translate(x: Any, y: Any): Any {
      const m = numbersOfMatrix(slotOf(this, 'matrix'));
      required(2, arguments.length, 'translate');
      return matrixMade(multiply(m, [1, 0, 0, 1, toFloat(x), toFloat(y)]));
    }
    scale(scaleFactor: Any): Any {
      const m = numbersOfMatrix(slotOf(this, 'matrix'));
      required(1, arguments.length, 'scale');
      const k = toFloat(scaleFactor);
      return matrixMade(multiply(m, [k, 0, 0, k, 0, 0]));
    }
    scaleNonUniform(scaleFactorX: Any, scaleFactorY: Any): Any {
      const m = numbersOfMatrix(slotOf(this, 'matrix'));
      required(2, arguments.length, 'scaleNonUniform');
      return matrixMade(
        multiply(m, [toFloat(scaleFactorX), 0, 0, toFloat(scaleFactorY), 0, 0]),
      );
    }
    rotate(angle: Any): Any {
      const m = numbersOfMatrix(slotOf(this, 'matrix'));
      required(1, arguments.length, 'rotate');
      const r = rad(toFloat(angle));
      const c = Math.cos(r);
      const sn = Math.sin(r);
      return matrixMade(multiply(m, [c, sn, -sn, c, 0, 0]));
    }
    rotateFromVector(x: Any, y: Any): Any {
      const m = numbersOfMatrix(slotOf(this, 'matrix'));
      required(2, arguments.length, 'rotateFromVector');
      const vx = toFloat(x);
      const vy = toFloat(y);
      if (!vx || !vy) {
        throw new DOMException(
          "Failed to execute 'rotateFromVector' on 'SVGMatrix': Arguments cannot be zero.",
          'InvalidAccessError',
        );
      }
      const r = Math.atan2(vy, vx);
      const c = Math.cos(r);
      const sn = Math.sin(r);
      return matrixMade(multiply(m, [c, sn, -sn, c, 0, 0]));
    }
    flipX(): Any {
      const m = numbersOfMatrix(slotOf(this, 'matrix'));
      return matrixMade(multiply(m, [-1, 0, 0, 1, 0, 0]));
    }
    flipY(): Any {
      const m = numbersOfMatrix(slotOf(this, 'matrix'));
      return matrixMade(multiply(m, [1, 0, 0, -1, 0, 0]));
    }
    skewX(angle: Any): Any {
      const m = numbersOfMatrix(slotOf(this, 'matrix'));
      required(1, arguments.length, 'skewX');
      return matrixMade(
        multiply(m, [1, 0, Math.tan(rad(toFloat(angle))), 1, 0, 0]),
      );
    }
    skewY(angle: Any): Any {
      const m = numbersOfMatrix(slotOf(this, 'matrix'));
      required(1, arguments.length, 'skewY');
      return matrixMade(
        multiply(m, [1, Math.tan(rad(toFloat(angle))), 0, 1, 0, 0]),
      );
    }
  }
  MATRIX_FIELDS.forEach((name, i) => {
    defineProperty(SVGMatrix.prototype, name, {
      get(this: Any) {
        const s = slotOf(this, 'matrix');
        fresh(s);
        return s.m[i];
      },
      set(this: Any, v: Any) {
        const s = slotOf(this, 'matrix');
        const n = toFloat(v);
        // a transform's matrix written is a matrix transform (SVG 2, 8.14.3)
        const t = s.owner;
        if (t) {
          writable(t, `the '${name}' property on 'SVGMatrix'`);
          t.type = 1;
          t.angle = 0;
        }
        s.m[i] = n;
        if (t) wrote(t);
      },
      configurable: true,
    });
  });

  // --- SVGTransform ---------------------------------------------------------------

  const IDENTITY = [1, 0, 0, 1, 0, 0];
  /** A transform's slots, of a type and the six numbers it makes. */
  const transformSlots = (): Any => ({
    kind: 'transform',
    type: 1,
    m: IDENTITY.slice(),
    angle: 0,
    cx: 0,
    cy: 0,
    ro: false,
    list: null,
    matrix: null,
  });
  const transformMade = (): Any => made(SVGTransform, transformSlots());
  /** Set a transform's slots, keeping the array its matrix reads. */
  const setTransform = (
    s: Any,
    type: number,
    m: number[],
    angle: number,
    cx = 0,
    cy = 0,
  ): void => {
    s.type = type;
    for (let i = 0; i < 6; i++) s.m[i] = m[i];
    s.angle = angle;
    s.cx = cx;
    s.cy = cy;
  };
  const rotation = (angle: number, cx: number, cy: number): number[] => {
    const r = rad(angle);
    const c = Math.cos(r);
    const sn = Math.sin(r);
    return [c, sn, -sn, c, cx - c * cx + sn * cy, cy - sn * cx - c * cy];
  };
  /** A transform as a transform list writes it, which Chromium and WebKit
   *  agree on: its numbers apart by a space, and every one the type has. */
  const transformText = (s: Any): string => {
    const m = s.m;
    switch (s.type) {
      case 1:
        return `matrix(${m.map(fmt).join(' ')})`;
      case 2:
        return `translate(${fmt(m[4])} ${fmt(m[5])})`;
      case 3:
        return `scale(${fmt(m[0])} ${fmt(m[3])})`;
      case 4:
        return s.cx || s.cy
          ? `rotate(${fmt(s.angle)} ${fmt(s.cx)} ${fmt(s.cy)})`
          : `rotate(${fmt(s.angle)})`;
      case 5:
        return `skewX(${fmt(s.angle)})`;
      case 6:
        return `skewY(${fmt(s.angle)})`;
      default:
        return '';
    }
  };
  /** A transform list's functions (SVG 2, 8.5), each a type, the matrix
   *  it makes, its angle and its centre; null where anything is wrong. */
  const transformsOf = (text: string): Any[] | null => {
    const out: Any[] = [];
    let i = 0;
    const space = (): void => {
      while (i < text.length && /\s/.test(text[i])) i += 1;
    };
    space();
    while (i < text.length) {
      const name = /^(matrix|translate|scale|rotate|skewX|skewY)\s*\(/.exec(
        text.slice(i),
      );
      if (!name) return null;
      i += name[0].length;
      const close = text.indexOf(')', i);
      if (close < 0) return null;
      const args = numbersOf(text.slice(i, close));
      i = close + 1;
      if (!args) return null;
      const n = args.length;
      const s = transformSlots();
      switch (name[1]) {
        case 'matrix':
          if (n !== 6) return null;
          setTransform(s, 1, args, 0);
          break;
        case 'translate':
          if (n !== 1 && n !== 2) return null;
          setTransform(s, 2, [1, 0, 0, 1, args[0], args[1] ?? 0], 0);
          break;
        case 'scale':
          if (n !== 1 && n !== 2) return null;
          setTransform(s, 3, [args[0], 0, 0, args[1] ?? args[0], 0, 0], 0);
          break;
        case 'rotate':
          if (n !== 1 && n !== 3) return null;
          setTransform(
            s,
            4,
            rotation(args[0], args[1] ?? 0, args[2] ?? 0),
            args[0],
            args[1] ?? 0,
            args[2] ?? 0,
          );
          break;
        case 'skewX':
          if (n !== 1) return null;
          setTransform(s, 5, [1, 0, Math.tan(rad(args[0])), 1, 0, 0], args[0]);
          break;
        default:
          if (n !== 1) return null;
          setTransform(s, 6, [1, Math.tan(rad(args[0])), 0, 1, 0, 0], args[0]);
      }
      out.push(s);
      space();
      if (text[i] === ',') {
        i += 1;
        space();
        if (i >= text.length) return null;
      }
    }
    return out;
  };
  const TRANSFORM_WHAT = "the 'matrix' property on 'SVGTransform'";
  class SVGTransform {
    constructor() {
      illegal();
    }
    get type(): number {
      const s = slotOf(this, 'transform');
      fresh(s);
      return s.type;
    }
    get matrix(): Any {
      const s = slotOf(this, 'transform');
      fresh(s);
      return (s.matrix ??= made(SVGMatrix, {
        kind: 'matrix',
        m: s.m,
        owner: s,
      }));
    }
    get angle(): number {
      const s = slotOf(this, 'transform');
      fresh(s);
      return s.angle;
    }
    setMatrix(matrix: Any = undefined): void {
      const s = slotOf(this, 'transform');
      const m = matrix2DOf(matrix, 'setMatrix', 'SVGTransform');
      writable(s, TRANSFORM_WHAT);
      setTransform(s, 1, m, 0);
      wrote(s);
    }
    setTranslate(tx: Any, ty: Any): void {
      const s = slotOf(this, 'transform');
      required(2, arguments.length, 'setTranslate');
      const x = toFloat(tx);
      const y = toFloat(ty);
      writable(s, TRANSFORM_WHAT);
      setTransform(s, 2, [1, 0, 0, 1, x, y], 0);
      wrote(s);
    }
    setScale(sx: Any, sy: Any): void {
      const s = slotOf(this, 'transform');
      required(2, arguments.length, 'setScale');
      const x = toFloat(sx);
      const y = toFloat(sy);
      writable(s, TRANSFORM_WHAT);
      setTransform(s, 3, [x, 0, 0, y, 0, 0], 0);
      wrote(s);
    }
    setRotate(angle: Any, cx: Any, cy: Any): void {
      const s = slotOf(this, 'transform');
      required(3, arguments.length, 'setRotate');
      const a = toFloat(angle);
      const x = toFloat(cx);
      const y = toFloat(cy);
      writable(s, TRANSFORM_WHAT);
      setTransform(s, 4, rotation(a, x, y), a, x, y);
      wrote(s);
    }
    setSkewX(angle: Any): void {
      const s = slotOf(this, 'transform');
      required(1, arguments.length, 'setSkewX');
      const a = toFloat(angle);
      writable(s, TRANSFORM_WHAT);
      setTransform(s, 5, [1, 0, Math.tan(rad(a)), 1, 0, 0], a);
      wrote(s);
    }
    setSkewY(angle: Any): void {
      const s = slotOf(this, 'transform');
      required(1, arguments.length, 'setSkewY');
      const a = toFloat(angle);
      writable(s, TRANSFORM_WHAT);
      setTransform(s, 6, [1, Math.tan(rad(a)), 0, 1, 0, 0], a);
      wrote(s);
    }
  }
  const TRANSFORM_CONSTANTS = {
    SVG_TRANSFORM_UNKNOWN: 0,
    SVG_TRANSFORM_MATRIX: 1,
    SVG_TRANSFORM_TRANSLATE: 2,
    SVG_TRANSFORM_SCALE: 3,
    SVG_TRANSFORM_ROTATE: 4,
    SVG_TRANSFORM_SKEWX: 5,
    SVG_TRANSFORM_SKEWY: 6,
  };

  // --- SVGPreserveAspectRatio ---------------------------------------------------

  const ALIGNS = [
    '',
    'none',
    'xMinYMin',
    'xMidYMin',
    'xMaxYMin',
    'xMinYMid',
    'xMidYMid',
    'xMaxYMid',
    'xMinYMax',
    'xMidYMax',
    'xMaxYMax',
  ];
  const loadAspect = (s: Any, raw: string | null): void => {
    s.align = 6;
    s.meet = 1;
    const words = raw === null ? [] : raw.trim().split(/\s+/);
    const align = ALIGNS.indexOf(words[0] ?? '');
    const meet = words.length > 1 ? ['', 'meet', 'slice'].indexOf(words[1]) : 1;
    if (align > 0 && meet > 0 && words.length <= 2) {
      s.align = align;
      s.meet = meet;
    }
  };
  const aspectText = (s: Any): string =>
    `${ALIGNS[s.align]} ${s.meet === 2 ? 'slice' : 'meet'}`;
  class SVGPreserveAspectRatio {
    constructor() {
      illegal();
    }
    get align(): number {
      const s = slotOf(this, 'aspect');
      fresh(s);
      return s.align;
    }
    set align(v: Any) {
      const s = slotOf(this, 'aspect');
      const n = toUShort(v);
      writable(s, "the 'align' property on 'SVGPreserveAspectRatio'");
      if (!(n >= 1 && n <= 10)) {
        throw new DOMException(
          "Failed to set the 'align' property on 'SVGPreserveAspectRatio': The alignment provided is invalid.",
          'NotSupportedError',
        );
      }
      s.align = n;
      wrote(s);
    }
    get meetOrSlice(): number {
      const s = slotOf(this, 'aspect');
      fresh(s);
      return s.meet;
    }
    set meetOrSlice(v: Any) {
      const s = slotOf(this, 'aspect');
      const n = toUShort(v);
      writable(s, "the 'meetOrSlice' property on 'SVGPreserveAspectRatio'");
      if (n !== 1 && n !== 2) {
        throw new DOMException(
          "Failed to set the 'meetOrSlice' property on 'SVGPreserveAspectRatio': The meetOrSlice provided is invalid.",
          'NotSupportedError',
        );
      }
      s.meet = n;
      wrote(s);
    }
  }
  const ASPECT_CONSTANTS: Record<string, number> = {
    SVG_PRESERVEASPECTRATIO_UNKNOWN: 0,
    SVG_PRESERVEASPECTRATIO_NONE: 1,
    SVG_PRESERVEASPECTRATIO_XMINYMIN: 2,
    SVG_PRESERVEASPECTRATIO_XMIDYMIN: 3,
    SVG_PRESERVEASPECTRATIO_XMAXYMIN: 4,
    SVG_PRESERVEASPECTRATIO_XMINYMID: 5,
    SVG_PRESERVEASPECTRATIO_XMIDYMID: 6,
    SVG_PRESERVEASPECTRATIO_XMAXYMID: 7,
    SVG_PRESERVEASPECTRATIO_XMINYMAX: 8,
    SVG_PRESERVEASPECTRATIO_XMIDYMAX: 9,
    SVG_PRESERVEASPECTRATIO_XMAXYMAX: 10,
    SVG_MEETORSLICE_UNKNOWN: 0,
    SVG_MEETORSLICE_MEET: 1,
    SVG_MEETORSLICE_SLICE: 2,
  };

  // --- lists ----------------------------------------------------------------------

  /**
   * What a kind of list holds: the slots kind its items are, how an
   * attribute's text comes to values, how an item takes a value and is made
   * of one, and how an item is written. A string list's items are strings.
   */
  interface ListKind {
    item: string;
    parse(text: string, state: Any): Any[] | null;
    take(s: Any, value: Any): void;
    make(value: Any, state: Any): Any;
    copy(s: Any, state: Any): Any;
    text(s: Any): string;
  }
  const LENGTHS: ListKind = {
    item: 'length',
    parse: (text) => lengthsOf(text),
    take: (s, [n, unit]) => {
      s.n = n;
      s.unit = unit;
    },
    make: ([n, unit], state) => lengthMade(n, unit, state.axis),
    copy: (s, state) => lengthMade(s.n, s.unit, state.axis),
    text: lengthText,
  };
  const NUMBERS: ListKind = {
    item: 'number',
    parse: (text) => numbersOf(text),
    take: (s, n) => {
      s.n = n;
    },
    make: (n) => numberMade(n),
    copy: (s) => numberMade(s.n),
    text: (s) => fmt(s.n),
  };
  const POINTS: ListKind = {
    item: 'point',
    parse: (text) => pointsOf(text),
    take: (s, [x, y]) => {
      s.x = x;
      s.y = y;
    },
    make: ([x, y]) => pointMade(x, y),
    copy: (s) => pointMade(s.x, s.y),
    // as Chromium and WebKit write them, where SVG 2 has a comma in each
    text: (s) => `${fmt(s.x)} ${fmt(s.y)}`,
  };
  const TRANSFORMS: ListKind = {
    item: 'transform',
    parse: (text) => transformsOf(text),
    take: (s, t) => setTransform(s, t.type, t.m, t.angle, t.cx, t.cy),
    make: (t) => {
      const o = transformMade();
      const s = apply(wmGet, SLOTS, [o]);
      setTransform(s, t.type, t.m, t.angle, t.cx, t.cy);
      return o;
    },
    copy: (s) => TRANSFORMS.make(s, null),
    text: transformText,
  };
  /** A points list's pairs: an odd number at the end is left out, and
   *  anything that is no number empties it (SVG 2, 10.10). */
  const pointsOf = (text: string): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    let i = 0;
    const space = (): void => {
      while (i < text.length && /[\s,]/.test(text[i])) i += 1;
    };
    const number = (): number | null => {
      NUMBER_AT.lastIndex = i;
      const m = NUMBER_AT.exec(text);
      if (!m) return null;
      i += m[0].length;
      return clampFloat(+m[0]);
    };
    for (;;) {
      space();
      if (i >= text.length) return out;
      const x = number();
      if (x === null) return [];
      space();
      if (i >= text.length) return out;
      const y = number();
      if (y === null) return [];
      out.push([x, y]);
    }
  };

  /**
   * A list's state: the element and attribute it reflects, whether it is an
   * `animVal`'s, its items, and when it last read the attribute. `syncList`
   * brings the items to what the attribute says (SVG 2, 4.5.4); a write
   * through the list or an item in it sets the attribute (`writeList`).
   */
  const listMade = (
    Proto: Any,
    kind: ListKind | null,
    el: Any,
    attr: string,
    ro: boolean,
    extra: Any = {},
  ): Any => {
    const state: Any = {
      kind: 'list',
      of: kind,
      el,
      attr,
      ro,
      items: [],
      at: -1,
      raw: undefined,
      ...extra,
    };
    const list = listOf(Proto, () => {
      syncList(state);
      return state.items;
    });
    state.self = list;
    apply(wmSet, SLOTS, [list, state]);
    listState(list).setItem = (index: number, value: Any): void => {
      replaceItem(state, value, index);
    };
    return list;
  };
  const syncList = (state: Any): void => {
    const anim = !!state.ro;
    const now = epochFor(anim);
    if (state.at === now) return;
    state.at = now;
    const raw = asAnimated(anim, () => getAttr(state.el, state.attr));
    if (raw === state.raw) return;
    state.raw = raw;
    const kind: ListKind | null = state.of;
    const values =
      raw === null
        ? []
        : kind
          ? (kind.parse(raw, state) ?? [])
          : stringsOf(raw, state);
    if (!kind) {
      state.items = values;
      return;
    }
    const items = state.items;
    while (items.length > values.length) detach(items.pop());
    for (let i = 0; i < values.length; i++) {
      if (i < items.length)
        kind.take(apply(wmGet, SLOTS, [items[i]]), values[i]);
      else items.push(attach(state, kind.make(values[i], state)));
    }
  };
  const writeList = (state: Any): void => {
    const kind: ListKind | null = state.of;
    const text = kind
      ? state.items
          .map((o: Any) => kind.text(apply(wmGet, SLOTS, [o])))
          .join(' ')
      : state.items.join(state.separator === ',' ? ',' : ' ');
    setAttr(state.el, state.attr, text);
    state.raw = text;
    state.at = epoch();
  };
  const attach = (state: Any, o: Any): Any => {
    const s = apply(wmGet, SLOTS, [o]);
    s.list = state;
    s.ro = state.ro;
    return o;
  };
  const detach = (o: Any): void => {
    const s = apply(wmGet, SLOTS, [o]);
    if (s) {
      s.list = null;
      s.ro = false;
    }
  };
  const stringsOf = (raw: string, state: Any): string[] =>
    state.separator === ','
      ? raw
          .split(',')
          .map((w) => w.trim())
          .filter(Boolean)
      : raw.split(/\s+/).filter(Boolean);
  /** An item a list is handed, as the list holds it: a copy where it is
   *  anything's already (SVG 2, 4.5.5, "newItem" steps). */
  const itemFor = (state: Any, value: Any, op: string): Any => {
    const kind: ListKind | null = state.of;
    if (!kind) return `${value}`;
    if (!isA(value, kind.item)) {
      throw new TypeError(
        `Failed to execute '${op}' on '${state.name}': parameter 1 is not of type '${state.itemName}'.`,
      );
    }
    const s = apply(wmGet, SLOTS, [value]);
    if (s.list || s.ref || s.ro || s.marker) {
      fresh(s);
      return kind.copy(s, state);
    }
    return value;
  };
  const mutable = (state: Any): void => {
    if (state.ro) {
      throw new DOMException(
        `Failed to modify '${state.name}': The object is read-only.`,
        'NoModificationAllowedError',
      );
    }
    syncList(state);
  };
  const indexIn = (state: Any, index: number, op: string): void => {
    if (index >= state.items.length) {
      throw new DOMException(
        `Failed to execute '${op}' on '${state.name}': The index provided (${index}) is greater than the maximum bound (${state.items.length}).`,
        'IndexSizeError',
      );
    }
  };
  const placed = (state: Any, o: Any): Any => (state.of ? attach(state, o) : o);
  const replaceItem = (state: Any, newItem: Any, index: number): Any => {
    const item = itemFor(state, newItem, 'replaceItem');
    mutable(state);
    indexIn(state, index, 'replaceItem');
    if (state.of) detach(state.items[index]);
    state.items[index] = placed(state, item);
    writeList(state);
    return item;
  };
  /** What every SVG list has (SVG 2, 4.5.5). */
  const listClass = (name: string, itemName: string): Any => {
    const Kind = class {
      constructor() {
        illegal();
      }
      get length(): number {
        const state = slotOf(this, 'list');
        syncList(state);
        return state.items.length;
      }
      get numberOfItems(): number {
        const state = slotOf(this, 'list');
        syncList(state);
        return state.items.length;
      }
      clear(): void {
        const state = slotOf(this, 'list');
        mutable(state);
        if (state.of) for (const o of state.items) detach(o);
        state.items = [];
        writeList(state);
      }
      initialize(newItem: Any): Any {
        const state = slotOf(this, 'list');
        required(1, arguments.length, 'initialize');
        const item = itemFor(state, newItem, 'initialize');
        mutable(state);
        if (state.of) for (const o of state.items) detach(o);
        state.items = [placed(state, item)];
        writeList(state);
        return item;
      }
      getItem(index: Any): Any {
        const state = slotOf(this, 'list');
        required(1, arguments.length, 'getItem');
        const i = toULong(index);
        syncList(state);
        indexIn(state, i, 'getItem');
        return state.items[i];
      }
      insertItemBefore(newItem: Any, index: Any): Any {
        const state = slotOf(this, 'list');
        required(2, arguments.length, 'insertItemBefore');
        const item = itemFor(state, newItem, 'insertItemBefore');
        const i = toULong(index);
        mutable(state);
        state.items.splice(
          Math.min(i, state.items.length),
          0,
          placed(state, item),
        );
        writeList(state);
        return item;
      }
      replaceItem(newItem: Any, index: Any): Any {
        const state = slotOf(this, 'list');
        required(2, arguments.length, 'replaceItem');
        return replaceItem(state, newItem, toULong(index));
      }
      removeItem(index: Any): Any {
        const state = slotOf(this, 'list');
        required(1, arguments.length, 'removeItem');
        const i = toULong(index);
        mutable(state);
        indexIn(state, i, 'removeItem');
        const [item] = state.items.splice(i, 1);
        if (state.of) detach(item);
        writeList(state);
        return item;
      }
      appendItem(newItem: Any): Any {
        const state = slotOf(this, 'list');
        required(1, arguments.length, 'appendItem');
        const item = itemFor(state, newItem, 'appendItem');
        mutable(state);
        state.items.push(placed(state, item));
        writeList(state);
        return item;
      }
    };
    defineProperty(Kind, 'name', { value: name });
    defineProperty(Kind.prototype, Symbol.iterator, {
      value: Array.prototype.values,
      writable: true,
      configurable: true,
    });
    (Kind as Any).itemName = itemName;
    return Kind;
  };
  const SVGNumberList = listClass('SVGNumberList', 'SVGNumber');
  const SVGLengthList = listClass('SVGLengthList', 'SVGLength');
  const SVGPointList = listClass('SVGPointList', 'SVGPoint');
  const SVGStringList = listClass('SVGStringList', 'DOMString');
  const SVGTransformList = listClass('SVGTransformList', 'SVGTransform');
  for (const [key, fn] of Object.entries({
    createSVGTransformFromMatrix(this: Any, matrix: Any = undefined): Any {
      slotOf(this, 'list');
      const m = matrix2DOf(
        matrix,
        'createSVGTransformFromMatrix',
        'SVGTransformList',
      );
      const o = transformMade();
      setTransform(apply(wmGet, SLOTS, [o]), 1, m, 0);
      return o;
    },
    /** The list as one matrix transform, which its attribute is set to as
     *  well, as Firefox and WebKit do it. */
    consolidate(this: Any): Any {
      const state = slotOf(this, 'list');
      mutable(state);
      if (!state.items.length) return null;
      let m = IDENTITY;
      for (const o of state.items) {
        m = multiply(m, apply(wmGet, SLOTS, [o]).m);
        detach(o);
      }
      const t = transformMade();
      setTransform(apply(wmGet, SLOTS, [t]), 1, m, 0);
      state.items = [attach(state, t)];
      writeList(state);
      return t;
    },
  })) {
    defineProperty(SVGTransformList.prototype, key, {
      value: fn,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  const LIST_KINDS = new Map<Any, [ListKind | null, string, string]>([
    [SVGNumberList, [NUMBERS, 'SVGNumberList', 'SVGNumber']],
    [SVGLengthList, [LENGTHS, 'SVGLengthList', 'SVGLength']],
    [SVGPointList, [POINTS, 'SVGPointList', 'SVGPoint']],
    [SVGTransformList, [TRANSFORMS, 'SVGTransformList', 'SVGTransform']],
    [SVGStringList, [null, 'SVGStringList', 'DOMString']],
  ]);
  const reflectedList = (
    Proto: Any,
    el: Any,
    attr: string,
    ro: boolean,
    extra: Any = {},
  ): Any => {
    const [kind, name, itemName] = LIST_KINDS.get(Proto)!;
    return listMade(Proto, kind, el, attr, ro, { name, itemName, ...extra });
  };

  // --- the animated values ------------------------------------------------------

  /** What an element's attributes are as objects, made once each
   *  (`[SameObject]`), by the element and the attribute's IDL name. */
  const ANIMATED = new WeakMap<object, Map<string, Any>>();
  const animatedOf = (el: Any, key: string, make: () => Any): Any => {
    let own = apply(wmGet, ANIMATED, [el]);
    if (!own) {
      own = new Map();
      apply(wmSet, ANIMATED, [el, own]);
    }
    let o = own.get(key);
    if (!o) {
      o = make();
      own.set(key, o);
    }
    return o;
  };

  /** A pair of values reflecting one attribute, a `baseVal` and an
   *  `animVal`, made as they are first read. */
  const pairClass = (name: string): Any => {
    const Kind = class {
      constructor() {
        illegal();
      }
      get baseVal(): Any {
        const s = slotOf(this, name);
        return (s.base ??= s.make(false));
      }
      get animVal(): Any {
        const s = slotOf(this, name);
        return (s.anim ??= s.make(true));
      }
    };
    defineProperty(Kind, 'name', { value: name });
    return Kind;
  };
  const SVGAnimatedLength = pairClass('SVGAnimatedLength');
  const SVGAnimatedAngle = pairClass('SVGAnimatedAngle');
  const SVGAnimatedRect = pairClass('SVGAnimatedRect');
  const SVGAnimatedPreserveAspectRatio = pairClass(
    'SVGAnimatedPreserveAspectRatio',
  );
  const SVGAnimatedLengthList = pairClass('SVGAnimatedLengthList');
  const SVGAnimatedNumberList = pairClass('SVGAnimatedNumberList');
  const SVGAnimatedTransformList = pairClass('SVGAnimatedTransformList');
  const pairMade = (Kind: Any, make: (ro: boolean) => Any): Any =>
    made(Kind, { kind: Kind.name, make, base: null, anim: null });

  const animatedLength = (
    el: Any,
    attr: string,
    initial: string,
    axis: string,
    rule: Any,
  ): Any =>
    pairMade(SVGAnimatedLength, (ro) => {
      const o = lengthMade(0, '', axis);
      const s = apply(wmGet, SLOTS, [o]);
      s.ref = reflecting(el, attr);
      s.initial = initial;
      s.ro = ro;
      s.positive = rule.positive;
      loadLength(s, null);
      return o;
    });
  const loadRect = (s: Any, raw: string | null): void => {
    const n = raw === null ? null : numbersOf(raw);
    const ok = n && n.length === 4;
    s.x = ok ? n[0] : 0;
    s.y = ok ? n[1] : 0;
    s.w = ok ? n[2] : 0;
    s.h = ok ? n[3] : 0;
  };
  const animatedRect = (el: Any, attr: string): Any =>
    pairMade(SVGAnimatedRect, (ro) => {
      const o = rectMade(0, 0, 0, 0);
      const s = apply(wmGet, SLOTS, [o]);
      s.ref = reflecting(el, attr);
      s.ro = ro;
      s.load = loadRect;
      s.text = (r: Any) => [r.x, r.y, r.w, r.h].map(fmt).join(' ');
      return o;
    });
  const animatedAspect = (el: Any): Any =>
    pairMade(SVGAnimatedPreserveAspectRatio, (ro) => {
      const o = made(SVGPreserveAspectRatio, {
        kind: 'aspect',
        align: 6,
        meet: 1,
        ro,
        ref: reflecting(el, 'preserveAspectRatio'),
        load: loadAspect,
        text: aspectText,
      });
      return o;
    });
  const animatedList = (
    el: Any,
    Proto: Any,
    attr: string,
    axis = 'xy',
  ): Any => {
    const Pair =
      Proto === SVGLengthList
        ? SVGAnimatedLengthList
        : Proto === SVGNumberList
          ? SVGAnimatedNumberList
          : SVGAnimatedTransformList;
    return pairMade(Pair, (ro) => reflectedList(Proto, el, attr, ro, { axis }));
  };

  /** The animated values whose `baseVal` is a number, a string or a
   *  boolean: read from the attribute at each read, which is one look at
   *  the tree, and written straight to it. */
  const primitiveClass = (
    name: string,
    settable: (s: Any, v: Any) => void,
  ): Any => {
    const Kind = class {
      constructor() {
        illegal();
      }
      get baseVal(): Any {
        const s = slotOf(this, name);
        return s.read(s);
      }
      set baseVal(v: Any) {
        settable(slotOf(this, name), v);
      }
      get animVal(): Any {
        const s = slotOf(this, name);
        return asAnimated(true, () => s.read(s));
      }
    };
    defineProperty(Kind, 'name', { value: name });
    return Kind;
  };
  /** The one of two numbers an attribute holds that an IDL attribute is,
   *  `stdDeviationX` of `stdDeviation`: one number is both. */
  const pairOf = (
    raw: string | null,
    read: (t: string) => number | null,
  ): number[] | null => {
    if (raw === null) return null;
    const parts = raw.trim().split(/\s*,\s*|\s+/);
    if (parts.length === 1) {
      const n = read(parts[0]);
      return n === null ? null : [n, n];
    }
    if (parts.length !== 2) return null;
    const a = read(parts[0]);
    const b = read(parts[1]);
    return a === null || b === null ? null : [a, b];
  };
  const numberRead = (s: Any): number => {
    const raw = getAttr(s.el, s.attr);
    if (s.pair !== undefined)
      return pairOf(raw, numberOf)?.[s.pair] ?? s.initial;
    if (s.percent && raw !== null) {
      const m = /^\s*(\S+)%\s*$/.exec(raw);
      const n = m ? numberOf(m[1]) : null;
      if (n !== null) return fround(n / 100);
    }
    return numberOf(raw) ?? s.initial;
  };
  /** Both of a pair's numbers written, the other as it reads now. */
  const writePair = (
    s: Any,
    n: number,
    text: (n: number) => string,
    read: (s: Any) => number,
  ): void => {
    const other = read({ ...s, pair: 1 - s.pair });
    const both = s.pair === 0 ? [n, other] : [other, n];
    setAttr(s.el, s.attr, `${text(both[0])} ${text(both[1])}`);
  };
  const SVGAnimatedNumber = primitiveClass('SVGAnimatedNumber', (s, v) => {
    const n = toFloat(v);
    if (s.pair !== undefined) writePair(s, n, fmt, numberRead);
    else setAttr(s.el, s.attr, fmt(n));
  });
  const INTEGER = /^\s*([+-]?\d+)\s*$/;
  const integerOf = (text: string): number | null => {
    const m = INTEGER.exec(text);
    return m ? toLong(m[1]) : null;
  };
  const integerRead = (s: Any): number => {
    const raw = getAttr(s.el, s.attr);
    if (s.pair !== undefined)
      return pairOf(raw, integerOf)?.[s.pair] ?? s.initial;
    return raw === null ? s.initial : (integerOf(raw) ?? s.initial);
  };
  const SVGAnimatedInteger = primitiveClass('SVGAnimatedInteger', (s, v) => {
    const n = toLong(v);
    if (s.pair !== undefined) writePair(s, n, String, integerRead);
    else setAttr(s.el, s.attr, String(n));
  });
  const SVGAnimatedBoolean = primitiveClass('SVGAnimatedBoolean', (s, v) => {
    setAttr(s.el, s.attr, v ? 'true' : 'false');
  });
  const booleanRead = (s: Any): boolean => getAttr(s.el, s.attr) === 'true';
  const SVGAnimatedString = primitiveClass('SVGAnimatedString', (s, v) => {
    s.write(s, `${v}`);
  });
  const stringRead = (s: Any): string => getAttr(s.el, s.attr) ?? '';
  const stringWrite = (s: Any, v: string): void => setAttr(s.el, s.attr, v);
  /** An `href`, or SVG 1.1's `xlink:href` where there is no `href`; one
   *  written goes where it would be read from (SVG 2, 5.15). */
  const hrefRead = (s: Any): string =>
    getAttr(s.el, 'href') ?? getAttr(s.el, 'xlink:href') ?? '';
  const hrefWrite = (s: Any, v: string): void =>
    setAttr(
      s.el,
      getAttr(s.el, 'href') === null && getAttr(s.el, 'xlink:href') !== null
        ? 'xlink:href'
        : 'href',
      v,
    );
  const SVGAnimatedEnumeration = primitiveClass(
    'SVGAnimatedEnumeration',
    (s, v) => {
      const n = toUShort(v);
      if (s.special) {
        s.special(s, n);
        return;
      }
      const word = s.words[n - 1];
      if (!(n >= 1) || word === undefined) {
        throw new TypeError(
          "Failed to set the 'baseVal' property on 'SVGAnimatedEnumeration': The enumeration value provided is invalid.",
        );
      }
      setAttr(s.el, s.attr, word);
    },
  );
  const enumRead = (s: Any): number => {
    const raw = getAttr(s.el, s.attr);
    const i = raw === null ? -1 : s.words.indexOf(raw);
    return i >= 0 ? i + 1 : s.initial;
  };
  const primitive = (Kind: Any, read: (s: Any) => Any, slots: Any): Any =>
    made(Kind, { kind: Kind.name, read, ...slots });

  // --- a marker's orientation ----------------------------------------------------

  /** A marker's `orient` (SVG 2, 11.6.2): `auto`, `auto-start-reverse` or an
   *  angle, which its `orientType` and `orientAngle` both reflect. */
  const markerOf = (el: Any, anim = false): Any =>
    animatedOf(el, anim ? '\u0000orientAnim' : '\u0000orient', () => ({
      kind: 'orient',
      type: 2,
      // the animVal's reads what animation sets (`smil.ts`)
      ro: anim,
      ref: reflecting(el, 'orient'),
      angles: [] as Any[],
      load: (m: Any, raw: string | null) => {
        const angle =
          raw === 'auto' || raw === 'auto-start-reverse' ? null : angleOf(raw);
        m.type = raw === 'auto' ? 1 : raw === 'auto-start-reverse' ? 0 : 2;
        for (const a of m.angles) {
          a.n = angle ? angle[0] : 0;
          a.unit = angle ? angle[1] : '';
        }
      },
      text: (m: Any) =>
        m.type === 1
          ? 'auto'
          : m.type === 0
            ? 'auto-start-reverse'
            : m.angles.length
              ? angleText(markerAngle(m))
              : '0',
      // what the angle that wrote says, its siblings say too
      synced: (m: Any) => {
        const base = m.angles.length ? markerAngle(m) : null;
        for (const a of m.angles) {
          if (m.type !== 2) {
            a.n = 0;
            a.unit = '';
          } else if (a !== base) {
            a.n = base.n;
            a.unit = base.unit;
          }
        }
      },
    }));
  const orientAngle = (el: Any): Any => {
    return pairMade(SVGAnimatedAngle, (ro) => {
      const m = markerOf(el, ro);
      const o = angleMade();
      const s = apply(wmGet, SLOTS, [o]);
      s.ro = ro;
      s.owner = m;
      s.marker = ro ? null : m;
      m.angles.push(s);
      // the angles read as the marker last loaded them
      m.at = -1;
      m.raw = undefined;
      m.ref.at = -1;
      m.ref.raw = undefined;
      return o;
    });
  };
  /** A marker's angle slots first, its own baseVal's, for what it writes. */
  const markerAngle = (m: Any): Any =>
    m.angles.find((a: Any) => !a.ro) ?? m.angles[0];

  // --- the element interfaces' attributes -----------------------------------------

  const accessor = (Kind: Any, name: string, get: (this: Any) => Any): void => {
    if (!Kind) return;
    defineProperty(Kind.prototype, name, {
      get,
      enumerable: true,
      configurable: true,
    });
  };
  const lengthAttr = (
    Kind: Any,
    name: string,
    initial = '0',
    attr = name,
    rule: Any = {},
  ): void => {
    const axis =
      /^(x|x1|x2|cx|fx|dx|rx|width|refX|markerWidth|textLength|startOffset)$/.test(
        name,
      )
        ? 'x'
        : /^(y|y1|y2|cy|fy|dy|ry|height|refY|markerHeight)$/.test(name)
          ? 'y'
          : 'xy';
    accessor(Kind, name, function () {
      return animatedOf(this, name, () =>
        animatedLength(this, attr, initial, axis, rule),
      );
    });
  };
  const numberAttr = (
    Kind: Any,
    name: string,
    initial = 0,
    attr = name,
    extra: Any = {},
  ): void => {
    accessor(Kind, name, function () {
      return animatedOf(this, name, () =>
        primitive(SVGAnimatedNumber, numberRead, {
          el: this,
          attr,
          initial,
          ...extra,
        }),
      );
    });
  };
  const integerAttr = (
    Kind: Any,
    name: string,
    initial = 0,
    attr = name,
    extra: Any = {},
  ): void => {
    accessor(Kind, name, function () {
      return animatedOf(this, name, () =>
        primitive(SVGAnimatedInteger, integerRead, {
          el: this,
          attr,
          initial,
          ...extra,
        }),
      );
    });
  };
  const enumAttr = (
    Kind: Any,
    name: string,
    words: string[],
    initial: number,
    attr = name,
  ): void => {
    accessor(Kind, name, function () {
      return animatedOf(this, name, () =>
        primitive(SVGAnimatedEnumeration, enumRead, {
          el: this,
          attr,
          words,
          initial,
        }),
      );
    });
  };
  const stringAttr = (Kind: Any, name: string, attr = name): void => {
    accessor(Kind, name, function () {
      return animatedOf(this, name, () =>
        primitive(SVGAnimatedString, stringRead, {
          el: this,
          attr,
          write: stringWrite,
        }),
      );
    });
  };
  const listAttr = (Kind: Any, name: string, Proto: Any, attr = name): void => {
    const axis = /^(x|dx)$/.test(name)
      ? 'x'
      : /^(y|dy)$/.test(name)
        ? 'y'
        : 'xy';
    accessor(Kind, name, function () {
      return animatedOf(this, name, () =>
        animatedList(this, Proto, attr, axis),
      );
    });
  };
  const transformAttr = (Kind: Any, name: string, attr = name): void =>
    listAttr(Kind, name, SVGTransformList, attr);
  const hrefAttr = (Kind: Any): void => {
    accessor(Kind, 'href', function () {
      return animatedOf(this, 'href', () =>
        primitive(SVGAnimatedString, hrefRead, { el: this, write: hrefWrite }),
      );
    });
  };
  /** SVG's `SVGFitToViewBox` (SVG 2, 8.8), copied onto its interfaces. */
  const fitToViewBox = (Kind: Any): void => {
    accessor(Kind, 'viewBox', function () {
      return animatedOf(this, 'viewBox', () => animatedRect(this, 'viewBox'));
    });
    accessor(Kind, 'preserveAspectRatio', function () {
      return animatedOf(this, 'preserveAspectRatio', () =>
        animatedAspect(this),
      );
    });
  };
  /** `SVGTests` (SVG 2, 5.11.4): string lists, which nothing animates. */
  const tests = (Kind: Any): void => {
    for (const [name, separator] of [
      ['requiredExtensions', ' '],
      ['systemLanguage', ','],
    ]) {
      accessor(Kind, name, function () {
        return animatedOf(this, name, () =>
          reflectedList(SVGStringList, this, name, false, { separator }),
        );
      });
    }
  };

  const UNITS = ['userSpaceOnUse', 'objectBoundingBox'];
  const define = (Kind: Any, constants: Record<string, number>): void => {
    for (const [key, value] of Object.entries(constants)) {
      for (const target of [Kind, Kind.prototype]) {
        defineProperty(target, key, { value, enumerable: true });
      }
    }
  };

  // SVGElement: its `class` as an animated string, which a page sets
  // through `baseVal`; assigning to it does nothing, as it does in a
  // browser, and is a `TypeError` in strict code
  accessor(E.SVGElement, 'className', function () {
    return animatedOf(this, 'className', () =>
      primitive(SVGAnimatedString, stringRead, {
        el: this,
        attr: 'class',
        write: stringWrite,
      }),
    );
  });
  transformAttr(E.SVGGraphicsElement, 'transform');
  tests(E.SVGGraphicsElement);
  numberAttr(E.SVGGeometryElement, 'pathLength');
  for (const name of ['x', 'y', 'width', 'height']) {
    for (const Kind of [
      E.SVGSVGElement,
      E.SVGRectElement,
      E.SVGImageElement,
      E.SVGUseElement,
      E.SVGForeignObjectElement,
      E.SVGPatternElement,
    ]) {
      lengthAttr(
        Kind,
        name,
        Kind === E.SVGSVGElement && name.length > 1 ? '100%' : '0',
        name,
        // a box's size is a geometry property's, but a pattern's tile
        { positive: name.length > 1 && Kind !== E.SVGPatternElement },
      );
    }
  }
  fitToViewBox(E.SVGSVGElement);
  fitToViewBox(E.SVGSymbolElement);
  fitToViewBox(E.SVGViewElement);
  const radius = { positive: true };
  for (const name of ['rx', 'ry']) {
    lengthAttr(E.SVGRectElement, name, '0', name, radius);
    lengthAttr(E.SVGEllipseElement, name, '0', name, radius);
  }
  for (const name of ['cx', 'cy']) {
    lengthAttr(E.SVGCircleElement, name);
    lengthAttr(E.SVGEllipseElement, name);
  }
  lengthAttr(E.SVGCircleElement, 'r', '0', 'r', { positive: true });
  for (const name of ['x1', 'y1', 'x2', 'y2'])
    lengthAttr(E.SVGLineElement, name);
  for (const Kind of [E.SVGPolylineElement, E.SVGPolygonElement]) {
    accessor(Kind, 'points', function () {
      return animatedOf(this, 'points', () =>
        reflectedList(SVGPointList, this, 'points', false),
      );
    });
    accessor(Kind, 'animatedPoints', function () {
      return animatedOf(this, 'animatedPoints', () =>
        reflectedList(SVGPointList, this, 'points', true),
      );
    });
  }
  // text
  define(E.SVGTextContentElement, {
    LENGTHADJUST_UNKNOWN: 0,
    LENGTHADJUST_SPACING: 1,
    LENGTHADJUST_SPACINGANDGLYPHS: 2,
  });
  lengthAttr(E.SVGTextContentElement, 'textLength');
  enumAttr(
    E.SVGTextContentElement,
    'lengthAdjust',
    ['spacing', 'spacingAndGlyphs'],
    1,
  );
  for (const name of ['x', 'y', 'dx', 'dy']) {
    listAttr(E.SVGTextPositioningElement, name, SVGLengthList);
  }
  listAttr(E.SVGTextPositioningElement, 'rotate', SVGNumberList);
  define(E.SVGTextPathElement, {
    TEXTPATH_METHODTYPE_UNKNOWN: 0,
    TEXTPATH_METHODTYPE_ALIGN: 1,
    TEXTPATH_METHODTYPE_STRETCH: 2,
    TEXTPATH_SPACINGTYPE_UNKNOWN: 0,
    TEXTPATH_SPACINGTYPE_AUTO: 1,
    TEXTPATH_SPACINGTYPE_EXACT: 2,
    TEXTPATH_SIDETYPE_UNKNOWN: 0,
    TEXTPATH_SIDETYPE_LEFT: 1,
    TEXTPATH_SIDETYPE_RIGHT: 2,
  });
  lengthAttr(E.SVGTextPathElement, 'startOffset');
  enumAttr(E.SVGTextPathElement, 'method', ['align', 'stretch'], 1);
  enumAttr(E.SVGTextPathElement, 'spacing', ['auto', 'exact'], 2);
  enumAttr(E.SVGTextPathElement, 'side', ['left', 'right'], 1);
  // what refers by `href`
  for (const Kind of [
    E.SVGUseElement,
    E.SVGImageElement,
    E.SVGAElement,
    E.SVGTextPathElement,
    E.SVGGradientElement,
    E.SVGPatternElement,
    E.SVGScriptElement,
  ]) {
    hrefAttr(Kind);
  }
  stringAttr(E.SVGAElement, 'target');
  accessor(E.SVGImageElement, 'preserveAspectRatio', function () {
    return animatedOf(this, 'preserveAspectRatio', () => animatedAspect(this));
  });
  // paint servers
  define(E.SVGGradientElement, {
    SVG_SPREADMETHOD_UNKNOWN: 0,
    SVG_SPREADMETHOD_PAD: 1,
    SVG_SPREADMETHOD_REFLECT: 2,
    SVG_SPREADMETHOD_REPEAT: 3,
  });
  enumAttr(E.SVGGradientElement, 'gradientUnits', UNITS, 2);
  transformAttr(E.SVGGradientElement, 'gradientTransform');
  enumAttr(
    E.SVGGradientElement,
    'spreadMethod',
    ['pad', 'reflect', 'repeat'],
    1,
  );
  lengthAttr(E.SVGLinearGradientElement, 'x1', '0%');
  lengthAttr(E.SVGLinearGradientElement, 'y1', '0%');
  lengthAttr(E.SVGLinearGradientElement, 'x2', '100%');
  lengthAttr(E.SVGLinearGradientElement, 'y2', '0%');
  for (const name of ['cx', 'cy', 'r', 'fx', 'fy']) {
    lengthAttr(E.SVGRadialGradientElement, name, '50%');
  }
  lengthAttr(E.SVGRadialGradientElement, 'fr', '0%');
  numberAttr(E.SVGStopElement, 'offset', 0, 'offset', { percent: true });
  enumAttr(E.SVGPatternElement, 'patternUnits', UNITS, 2);
  enumAttr(E.SVGPatternElement, 'patternContentUnits', UNITS, 1);
  transformAttr(E.SVGPatternElement, 'patternTransform');
  fitToViewBox(E.SVGPatternElement);
  // clipping and masking
  enumAttr(E.SVGClipPathElement, 'clipPathUnits', UNITS, 1);
  transformAttr(E.SVGClipPathElement, 'transform');
  enumAttr(E.SVGMaskElement, 'maskUnits', UNITS, 2);
  enumAttr(E.SVGMaskElement, 'maskContentUnits', UNITS, 1);
  lengthAttr(E.SVGMaskElement, 'x', '-10%');
  lengthAttr(E.SVGMaskElement, 'y', '-10%');
  lengthAttr(E.SVGMaskElement, 'width', '120%');
  lengthAttr(E.SVGMaskElement, 'height', '120%');
  // markers
  define(E.SVGMarkerElement, {
    SVG_MARKERUNITS_UNKNOWN: 0,
    SVG_MARKERUNITS_USERSPACEONUSE: 1,
    SVG_MARKERUNITS_STROKEWIDTH: 2,
    SVG_MARKER_ORIENT_UNKNOWN: 0,
    SVG_MARKER_ORIENT_AUTO: 1,
    SVG_MARKER_ORIENT_ANGLE: 2,
  });
  lengthAttr(E.SVGMarkerElement, 'refX');
  lengthAttr(E.SVGMarkerElement, 'refY');
  lengthAttr(E.SVGMarkerElement, 'markerWidth', '3');
  lengthAttr(E.SVGMarkerElement, 'markerHeight', '3');
  enumAttr(
    E.SVGMarkerElement,
    'markerUnits',
    ['userSpaceOnUse', 'strokeWidth'],
    2,
  );
  fitToViewBox(E.SVGMarkerElement);
  accessor(E.SVGMarkerElement, 'orientAngle', function () {
    return animatedOf(this, 'orientAngle', () => orientAngle(this));
  });
  accessor(E.SVGMarkerElement, 'orientType', function () {
    return animatedOf(this, 'orientType', () =>
      primitive(
        SVGAnimatedEnumeration,
        (s: Any) => {
          const m = markerOf(s.el, animReading);
          fresh(m);
          return m.type;
        },
        {
          el: this,
          special: (s: Any, n: number) => {
            if (n !== 1 && n !== 2) {
              throw new TypeError(
                "Failed to set the 'baseVal' property on 'SVGAnimatedEnumeration': The enumeration value provided is invalid.",
              );
            }
            const m = markerOf(s.el);
            fresh(m);
            m.type = n;
            wrote(m);
          },
        },
      ),
    );
  });
  if (E.SVGMarkerElement) {
    const proto = E.SVGMarkerElement.prototype;
    defineProperty(proto, 'orient', {
      get(this: Any) {
        return getAttr(this, 'orient') ?? '';
      },
      set(this: Any, v: Any) {
        setAttr(this, 'orient', `${v}`);
      },
      enumerable: true,
      configurable: true,
    });
    defineProperty(proto, 'setOrientToAuto', {
      value: function setOrientToAuto(this: Any): void {
        setAttr(this, 'orient', 'auto');
      },
      writable: true,
      enumerable: true,
      configurable: true,
    });
    defineProperty(proto, 'setOrientToAngle', {
      value: function setOrientToAngle(this: Any, angle: Any): void {
        required(1, arguments.length, 'setOrientToAngle');
        if (!isA(angle, 'angle')) {
          throw new TypeError(
            "Failed to execute 'setOrientToAngle' on 'SVGMarkerElement': parameter 1 is not of type 'SVGAngle'.",
          );
        }
        const s = apply(wmGet, SLOTS, [angle]);
        fresh(s);
        setAttr(this, 'orient', angleText(s));
      },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  // --- filters ------------------------------------------------------------------

  const tags: Record<string, Any> = {};
  /** An element interface this adds, made for `tag`. */
  const element = (name: string, Base: Any, tag: string | null): Any => {
    const Kind = class extends Base {};
    defineProperty(Kind, 'name', { value: name });
    if (tag) tags[tag] = Kind;
    return Kind;
  };
  const interfaces: Record<string, Any> = {};
  const SVGElement = E.SVGElement;
  enumAttr(E.SVGFilterElement, 'filterUnits', UNITS, 2);
  enumAttr(E.SVGFilterElement, 'primitiveUnits', UNITS, 1);
  lengthAttr(E.SVGFilterElement, 'x', '-10%');
  lengthAttr(E.SVGFilterElement, 'y', '-10%');
  lengthAttr(E.SVGFilterElement, 'width', '120%');
  lengthAttr(E.SVGFilterElement, 'height', '120%');
  /** `SVGFilterPrimitiveStandardAttributes` (Filter Effects 1, 9.3), copied
   *  onto each primitive. */
  const primitiveElement = (name: string, tag: string): Any => {
    const Kind = element(name, SVGElement, tag);
    lengthAttr(Kind, 'x', '0%');
    lengthAttr(Kind, 'y', '0%');
    lengthAttr(Kind, 'width', '100%');
    lengthAttr(Kind, 'height', '100%');
    stringAttr(Kind, 'result');
    interfaces[name] = Kind;
    return Kind;
  };
  const in1 = (Kind: Any): void => stringAttr(Kind, 'in1', 'in');
  const in2 = (Kind: Any): void => stringAttr(Kind, 'in2');
  const EDGE = {
    SVG_EDGEMODE_UNKNOWN: 0,
    SVG_EDGEMODE_DUPLICATE: 1,
    SVG_EDGEMODE_WRAP: 2,
    SVG_EDGEMODE_NONE: 3,
  };
  const EDGES = ['duplicate', 'wrap', 'none'];
  const stdDeviation = (Kind: Any, initial: number): void => {
    numberAttr(Kind, 'stdDeviationX', initial, 'stdDeviation', { pair: 0 });
    numberAttr(Kind, 'stdDeviationY', initial, 'stdDeviation', { pair: 1 });
    defineProperty(Kind.prototype, 'setStdDeviation', {
      value: function setStdDeviation(this: Any, x: Any, y: Any): void {
        required(2, arguments.length, 'setStdDeviation');
        setAttr(this, 'stdDeviation', `${fmt(toFloat(x))} ${fmt(toFloat(y))}`);
      },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  };
  const kernelUnitLength = (Kind: Any): void => {
    numberAttr(Kind, 'kernelUnitLengthX', 0, 'kernelUnitLength', { pair: 0 });
    numberAttr(Kind, 'kernelUnitLengthY', 0, 'kernelUnitLength', { pair: 1 });
  };

  const BLEND_MODES = [
    'normal',
    'multiply',
    'screen',
    'darken',
    'lighten',
    'overlay',
    'color-dodge',
    'color-burn',
    'hard-light',
    'soft-light',
    'difference',
    'exclusion',
    'hue',
    'saturation',
    'color',
    'luminosity',
  ];
  const feBlend = primitiveElement('SVGFEBlendElement', 'feBlend');
  define(
    feBlend,
    Object.fromEntries(
      [
        'UNKNOWN',
        ...BLEND_MODES.map((m) => m.toUpperCase().replace('-', '_')),
      ].map((m, i) => [`SVG_FEBLEND_MODE_${m}`, i]),
    ),
  );
  in1(feBlend);
  in2(feBlend);
  enumAttr(feBlend, 'mode', BLEND_MODES, 1);

  const feColorMatrix = primitiveElement(
    'SVGFEColorMatrixElement',
    'feColorMatrix',
  );
  define(feColorMatrix, {
    SVG_FECOLORMATRIX_TYPE_UNKNOWN: 0,
    SVG_FECOLORMATRIX_TYPE_MATRIX: 1,
    SVG_FECOLORMATRIX_TYPE_SATURATE: 2,
    SVG_FECOLORMATRIX_TYPE_HUEROTATE: 3,
    SVG_FECOLORMATRIX_TYPE_LUMINANCETOALPHA: 4,
  });
  in1(feColorMatrix);
  enumAttr(
    feColorMatrix,
    'type',
    ['matrix', 'saturate', 'hueRotate', 'luminanceToAlpha'],
    1,
  );
  listAttr(feColorMatrix, 'values', SVGNumberList);

  const feComponentTransfer = primitiveElement(
    'SVGFEComponentTransferElement',
    'feComponentTransfer',
  );
  in1(feComponentTransfer);
  const transferFunction = element(
    'SVGComponentTransferFunctionElement',
    SVGElement,
    null,
  );
  interfaces.SVGComponentTransferFunctionElement = transferFunction;
  define(transferFunction, {
    SVG_FECOMPONENTTRANSFER_TYPE_UNKNOWN: 0,
    SVG_FECOMPONENTTRANSFER_TYPE_IDENTITY: 1,
    SVG_FECOMPONENTTRANSFER_TYPE_TABLE: 2,
    SVG_FECOMPONENTTRANSFER_TYPE_DISCRETE: 3,
    SVG_FECOMPONENTTRANSFER_TYPE_LINEAR: 4,
    SVG_FECOMPONENTTRANSFER_TYPE_GAMMA: 5,
  });
  enumAttr(
    transferFunction,
    'type',
    ['identity', 'table', 'discrete', 'linear', 'gamma'],
    1,
  );
  listAttr(transferFunction, 'tableValues', SVGNumberList);
  numberAttr(transferFunction, 'slope', 1);
  numberAttr(transferFunction, 'intercept', 0);
  numberAttr(transferFunction, 'amplitude', 1);
  numberAttr(transferFunction, 'exponent', 1);
  numberAttr(transferFunction, 'offset', 0);
  for (const c of ['R', 'G', 'B', 'A']) {
    interfaces[`SVGFEFunc${c}Element`] = element(
      `SVGFEFunc${c}Element`,
      transferFunction,
      `feFunc${c}`,
    );
  }

  const feComposite = primitiveElement('SVGFECompositeElement', 'feComposite');
  define(feComposite, {
    SVG_FECOMPOSITE_OPERATOR_UNKNOWN: 0,
    SVG_FECOMPOSITE_OPERATOR_OVER: 1,
    SVG_FECOMPOSITE_OPERATOR_IN: 2,
    SVG_FECOMPOSITE_OPERATOR_OUT: 3,
    SVG_FECOMPOSITE_OPERATOR_ATOP: 4,
    SVG_FECOMPOSITE_OPERATOR_XOR: 5,
    SVG_FECOMPOSITE_OPERATOR_ARITHMETIC: 6,
    // Filter Effects 2's, which Chromium and WebKit have
    SVG_FECOMPOSITE_OPERATOR_LIGHTER: 7,
  });
  in1(feComposite);
  in2(feComposite);
  enumAttr(
    feComposite,
    'operator',
    ['over', 'in', 'out', 'atop', 'xor', 'arithmetic', 'lighter'],
    1,
  );
  for (const k of ['k1', 'k2', 'k3', 'k4']) numberAttr(feComposite, k);

  const feConvolveMatrix = primitiveElement(
    'SVGFEConvolveMatrixElement',
    'feConvolveMatrix',
  );
  define(feConvolveMatrix, EDGE);
  in1(feConvolveMatrix);
  integerAttr(feConvolveMatrix, 'orderX', 3, 'order', { pair: 0 });
  integerAttr(feConvolveMatrix, 'orderY', 3, 'order', { pair: 1 });
  listAttr(feConvolveMatrix, 'kernelMatrix', SVGNumberList);
  numberAttr(feConvolveMatrix, 'divisor', 1);
  numberAttr(feConvolveMatrix, 'bias', 0);
  integerAttr(feConvolveMatrix, 'targetX');
  integerAttr(feConvolveMatrix, 'targetY');
  enumAttr(feConvolveMatrix, 'edgeMode', EDGES, 1);
  kernelUnitLength(feConvolveMatrix);
  accessor(feConvolveMatrix, 'preserveAlpha', function () {
    return animatedOf(this, 'preserveAlpha', () =>
      primitive(SVGAnimatedBoolean, booleanRead, {
        el: this,
        attr: 'preserveAlpha',
      }),
    );
  });

  const feDiffuseLighting = primitiveElement(
    'SVGFEDiffuseLightingElement',
    'feDiffuseLighting',
  );
  in1(feDiffuseLighting);
  numberAttr(feDiffuseLighting, 'surfaceScale', 1);
  numberAttr(feDiffuseLighting, 'diffuseConstant', 1);
  kernelUnitLength(feDiffuseLighting);

  const feDistantLight = element(
    'SVGFEDistantLightElement',
    SVGElement,
    'feDistantLight',
  );
  interfaces.SVGFEDistantLightElement = feDistantLight;
  numberAttr(feDistantLight, 'azimuth');
  numberAttr(feDistantLight, 'elevation');
  const fePointLight = element(
    'SVGFEPointLightElement',
    SVGElement,
    'fePointLight',
  );
  interfaces.SVGFEPointLightElement = fePointLight;
  const feSpotLight = element(
    'SVGFESpotLightElement',
    SVGElement,
    'feSpotLight',
  );
  interfaces.SVGFESpotLightElement = feSpotLight;
  for (const Kind of [fePointLight, feSpotLight]) {
    for (const k of ['x', 'y', 'z']) numberAttr(Kind, k);
  }
  for (const k of [
    'pointsAtX',
    'pointsAtY',
    'pointsAtZ',
    'limitingConeAngle',
  ]) {
    numberAttr(feSpotLight, k);
  }
  numberAttr(feSpotLight, 'specularExponent', 1);

  const feDisplacementMap = primitiveElement(
    'SVGFEDisplacementMapElement',
    'feDisplacementMap',
  );
  define(feDisplacementMap, {
    SVG_CHANNEL_UNKNOWN: 0,
    SVG_CHANNEL_R: 1,
    SVG_CHANNEL_G: 2,
    SVG_CHANNEL_B: 3,
    SVG_CHANNEL_A: 4,
  });
  in1(feDisplacementMap);
  in2(feDisplacementMap);
  numberAttr(feDisplacementMap, 'scale');
  enumAttr(feDisplacementMap, 'xChannelSelector', ['R', 'G', 'B', 'A'], 4);
  enumAttr(feDisplacementMap, 'yChannelSelector', ['R', 'G', 'B', 'A'], 4);

  const feDropShadow = primitiveElement(
    'SVGFEDropShadowElement',
    'feDropShadow',
  );
  in1(feDropShadow);
  numberAttr(feDropShadow, 'dx', 2);
  numberAttr(feDropShadow, 'dy', 2);
  stdDeviation(feDropShadow, 2);

  primitiveElement('SVGFEFloodElement', 'feFlood');

  const feGaussianBlur = primitiveElement(
    'SVGFEGaussianBlurElement',
    'feGaussianBlur',
  );
  define(feGaussianBlur, EDGE);
  in1(feGaussianBlur);
  stdDeviation(feGaussianBlur, 0);
  enumAttr(feGaussianBlur, 'edgeMode', EDGES, 3);

  const feImage = primitiveElement('SVGFEImageElement', 'feImage');
  hrefAttr(feImage);
  stringAttr(feImage, 'crossOrigin');
  accessor(feImage, 'preserveAspectRatio', function () {
    return animatedOf(this, 'preserveAspectRatio', () => animatedAspect(this));
  });

  primitiveElement('SVGFEMergeElement', 'feMerge');
  const feMergeNode = element(
    'SVGFEMergeNodeElement',
    SVGElement,
    'feMergeNode',
  );
  interfaces.SVGFEMergeNodeElement = feMergeNode;
  in1(feMergeNode);

  const feMorphology = primitiveElement(
    'SVGFEMorphologyElement',
    'feMorphology',
  );
  define(feMorphology, {
    SVG_MORPHOLOGY_OPERATOR_UNKNOWN: 0,
    SVG_MORPHOLOGY_OPERATOR_ERODE: 1,
    SVG_MORPHOLOGY_OPERATOR_DILATE: 2,
  });
  in1(feMorphology);
  enumAttr(feMorphology, 'operator', ['erode', 'dilate'], 1);
  numberAttr(feMorphology, 'radiusX', 0, 'radius', { pair: 0 });
  numberAttr(feMorphology, 'radiusY', 0, 'radius', { pair: 1 });

  const feOffset = primitiveElement('SVGFEOffsetElement', 'feOffset');
  in1(feOffset);
  numberAttr(feOffset, 'dx');
  numberAttr(feOffset, 'dy');

  const feSpecularLighting = primitiveElement(
    'SVGFESpecularLightingElement',
    'feSpecularLighting',
  );
  in1(feSpecularLighting);
  numberAttr(feSpecularLighting, 'surfaceScale', 1);
  numberAttr(feSpecularLighting, 'specularConstant', 1);
  numberAttr(feSpecularLighting, 'specularExponent', 1);
  kernelUnitLength(feSpecularLighting);

  const feTile = primitiveElement('SVGFETileElement', 'feTile');
  in1(feTile);

  const feTurbulence = primitiveElement(
    'SVGFETurbulenceElement',
    'feTurbulence',
  );
  define(feTurbulence, {
    SVG_TURBULENCE_TYPE_UNKNOWN: 0,
    SVG_TURBULENCE_TYPE_FRACTALNOISE: 1,
    SVG_TURBULENCE_TYPE_TURBULENCE: 2,
    SVG_STITCHTYPE_UNKNOWN: 0,
    SVG_STITCHTYPE_STITCH: 1,
    SVG_STITCHTYPE_NOSTITCH: 2,
  });
  numberAttr(feTurbulence, 'baseFrequencyX', 0, 'baseFrequency', { pair: 0 });
  numberAttr(feTurbulence, 'baseFrequencyY', 0, 'baseFrequency', { pair: 1 });
  integerAttr(feTurbulence, 'numOctaves', 1);
  numberAttr(feTurbulence, 'seed');
  enumAttr(feTurbulence, 'stitchTiles', ['stitch', 'noStitch'], 2);
  enumAttr(feTurbulence, 'type', ['fractalNoise', 'turbulence'], 2);

  // --- what animates, which is drawn as it is at rest --------------------------

  /** SMIL's elements (SVG Animations 2, 6.1): what runs them, and their
   *  methods, are `smil.ts`'s, laid over these. */
  const SVGAnimationElement = element('SVGAnimationElement', SVGElement, null);
  interfaces.SVGAnimationElement = SVGAnimationElement;
  tests(SVGAnimationElement);
  for (const [key, fn] of Object.entries({
    getStartTime(): never {
      throw new DOMException(
        "Failed to execute 'getStartTime' on 'SVGAnimationElement': No current interval.",
        'InvalidStateError',
      );
    },
    getCurrentTime(): number {
      return 0;
    },
    getSimpleDuration(): never {
      throw new DOMException(
        "Failed to execute 'getSimpleDuration' on 'SVGAnimationElement': No simple duration defined.",
        'NotSupportedError',
      );
    },
    beginElement(): void {},
    beginElementAt(): void {},
    endElement(): void {},
    endElementAt(): void {},
  })) {
    defineProperty(SVGAnimationElement.prototype, key, {
      value: fn,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  accessor(SVGAnimationElement, 'targetElement', function () {
    const href = getAttr(this, 'href') ?? getAttr(this, 'xlink:href');
    if (href?.startsWith('#')) {
      return this.ownerDocument?.getElementById(href.slice(1)) ?? null;
    }
    return href === null ? this.parentElement : null;
  });
  for (const [name, tag] of [
    ['SVGAnimateElement', 'animate'],
    ['SVGSetElement', 'set'],
    ['SVGAnimateMotionElement', 'animateMotion'],
    ['SVGAnimateTransformElement', 'animateTransform'],
  ]) {
    interfaces[name] = element(name, SVGAnimationElement, tag);
  }
  const mpath = element('SVGMPathElement', SVGElement, 'mpath');
  interfaces.SVGMPathElement = mpath;
  hrefAttr(mpath);

  // --- what an <svg> makes -------------------------------------------------------

  if (E.SVGSVGElement) {
    const proto = E.SVGSVGElement.prototype;
    const methods: Record<string, (this: Any, ...args: Any[]) => Any> = {
      createSVGNumber: () => numberMade(0),
      createSVGLength: () => lengthMade(0, '', 'xy'),
      createSVGAngle: () => angleMade(),
      createSVGPoint: () => pointMade(0, 0),
      createSVGMatrix: () => matrixMade(IDENTITY),
      createSVGRect: () => rectMade(0, 0, 0, 0),
      createSVGTransform: () => transformMade(),
      createSVGTransformFromMatrix(matrix: Any = undefined) {
        const m = matrix2DOf(
          matrix,
          'createSVGTransformFromMatrix',
          'SVGSVGElement',
        );
        const o = transformMade();
        setTransform(apply(wmGet, SLOTS, [o]), 1, m, 0);
        return o;
      },
      deselectAll(this: Any) {
        this.ownerDocument?.defaultView?.getSelection?.()?.removeAllRanges();
      },
    };
    for (const [key, fn] of Object.entries(methods)) {
      defineProperty(proto, key, {
        value: fn,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    accessor(E.SVGSVGElement, 'currentTranslate', function () {
      return animatedOf(this, 'currentTranslate', () => pointMade(0, 0));
    });
  }
  // the document's `<svg>`, where it is one (SVG 2, 5.15)
  defineProperty((deps.Document as Any).prototype, 'rootElement', {
    get(this: Any) {
      const root = this.documentElement;
      return root instanceof E.SVGSVGElement ? root : null;
    },
    enumerable: true,
    configurable: true,
  });

  // --- the interfaces -----------------------------------------------------------

  const SVGUnitTypes = function SVGUnitTypes(): void {
    illegal();
  } as Any;
  define(SVGUnitTypes, {
    SVG_UNIT_TYPE_UNKNOWN: 0,
    SVG_UNIT_TYPE_USERSPACEONUSE: 1,
    SVG_UNIT_TYPE_OBJECTBOUNDINGBOX: 2,
  });
  define(SVGLength, LENGTH_CONSTANTS);
  define(SVGAngle, ANGLE_CONSTANTS);
  define(SVGTransform, TRANSFORM_CONSTANTS);
  define(SVGPreserveAspectRatio, ASPECT_CONSTANTS);
  const types: Record<string, Any> = {
    SVGNumber,
    SVGLength,
    SVGAngle,
    SVGPoint,
    SVGRect,
    SVGMatrix,
    SVGTransform,
    SVGPreserveAspectRatio,
    SVGNumberList,
    SVGLengthList,
    SVGPointList,
    SVGStringList,
    SVGTransformList,
    SVGAnimatedLength,
    SVGAnimatedAngle,
    SVGAnimatedRect,
    SVGAnimatedPreserveAspectRatio,
    SVGAnimatedLengthList,
    SVGAnimatedNumberList,
    SVGAnimatedTransformList,
    SVGAnimatedNumber,
    SVGAnimatedInteger,
    SVGAnimatedBoolean,
    SVGAnimatedString,
    SVGAnimatedEnumeration,
    SVGUnitTypes,
  };
  /** An interface's members as Web IDL has them: an attribute an
   *  accessor that checks what it is called on, and every member
   *  enumerable. */
  const webIdl = (Kind: Any): void => {
    if (!Kind?.prototype) return;
    deps.idlAttributes(Kind);
    const proto = Kind.prototype;
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor' || key.startsWith('_')) continue;
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (d && typeof d.value === 'function' && !d.enumerable) {
        defineProperty(proto, key, { ...d, enumerable: true });
      }
    }
  };
  for (const Kind of Object.values(types)) {
    if (Kind !== SVGUnitTypes) webIdl(Kind);
  }
  for (const Kind of Object.values(interfaces)) webIdl(Kind);
  for (const Kind of Object.values(E)) webIdl(Kind);
  // an interface with only constants has a prototype no one writes
  defineProperty(SVGUnitTypes, 'prototype', { writable: false });
  return {
    interfaces: { ...types, ...interfaces },
    tags,
    point: (x, y) => pointMade(fround(x), fround(y)),
    rect: (x, y, width, height) =>
      rectMade(fround(x), fround(y), fround(width), fround(height)),
    matrix: (values) => matrixMade(values),
  };
}
