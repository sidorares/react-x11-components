// Counter styles (CSS Counter Styles 3): how a counter's value is written.
// The styles the specification predefines, those a document's
// `@counter-style` rules define — over the predefined ones, and extending
// them — and the anonymous ones `symbols()` makes: what `list-style-type`
// names, and `counter()` and `counters()` take. The cascade builds one
// `CounterStyles` from its sheets; the box builder asks it for text.

import { tokenize } from './content.js';
import type { Token } from './content.js';
import type { Declaration } from './parse.js';
import { parseNumber } from './values.js';

type System =
  'cyclic' | 'numeric' | 'alphabetic' | 'symbolic' | 'additive' | 'fixed';

/**
 * A counter style as it is written: what it leaves out is the style's it
 * extends, or the descriptor's initial value. A complex predefined style
 * (7) brings its own algorithm, over the value's absolute value.
 */
export interface CounterStyleRule {
  system?: System;
  /** `fixed`'s first symbol value. */
  first?: number;
  extends?: string;
  symbols?: string[];
  additive?: [number, string][];
  negative?: [string, string];
  prefix?: string;
  suffix?: string;
  /** `auto` is the system's own (3.5). */
  range?: [number, number][] | 'auto';
  pad?: [number, string];
  fallback?: string;
  algorithm?: (n: number) => string;
}

/** A counter style with every descriptor settled. */
interface CounterStyle {
  system: System | 'algorithm';
  first: number;
  symbols: string[];
  additive: [number, string][];
  negative: [string, string];
  prefix: string;
  suffix: string;
  range: [number, number][];
  pad: [number, string];
  fallback: string;
  algorithm?: (n: number) => string;
}

/** The names no `@counter-style` may take (3). */
const FIXED_NAMES = new Set([
  'decimal',
  'disc',
  'square',
  'circle',
  'disclosure-open',
  'disclosure-closed',
]);

/** A representation longer than this is left to the fallback style (2). */
const LONGEST = 60;

/**
 * A counter style's name as a style is looked up by: one the
 * specification defines is lower-cased, and any other keeps its case (3).
 */
export function counterStyleName(name: string): string {
  const lower = name.toLowerCase();
  return PREDEFINED.has(lower) ? lower : name;
}

/**
 * The counter styles of a document: the predefined ones and its
 * `@counter-style` rules', each rule whole over any before it of its name.
 */
export class CounterStyles {
  private readonly _rules: Map<string, CounterStyleRule>;
  private readonly _resolved = new Map<string, CounterStyle>();

  constructor(rules: Map<string, CounterStyleRule> = new Map()) {
    this._rules = rules;
  }

  /** Whether a name names a counter style. */
  has(name: string): boolean {
    return this._rule(name) !== undefined;
  }

  /**
   * A counter's value written in a style (2), as `counter()` writes it:
   * without the style's prefix and suffix. An unknown style is `decimal`,
   * and a value the style cannot write is its fallback's.
   */
  text(n: number, name: string, rtl = false): string {
    return this._represent(n, name, new Set(), rtl);
  }

  /** A list item's marker: its value written in the style, between the
   *  style's own prefix and suffix whichever style wrote it. */
  marker(
    n: number,
    name: string,
    rtl = false,
  ): { prefix: string; text: string; suffix: string } {
    const style = this._resolve(name);
    return {
      prefix: style.prefix,
      text: this._represent(n, name, new Set(), rtl),
      suffix: style.suffix,
    };
  }

  private _rule(name: string): CounterStyleRule | undefined {
    if (name.startsWith('symbols(')) return anonymous(name);
    return this._rules.get(name) ?? PREDEFINED.get(name);
  }

  private _represent(
    n: number,
    name: string,
    tried: Set<string>,
    rtl: boolean,
  ): string {
    const style = this._resolve(name);
    const out = written(n, style, rtl);
    if (out !== null) return out;
    // a loop of fallbacks ends at `decimal` (3.7)
    if (tried.has(name)) return String(n);
    tried.add(name);
    return this._represent(n, style.fallback, tried, rtl);
  }

  /** A style with every descriptor settled: what it extends followed to a
   *  style of its own, and one in a loop of them extending `decimal` (3.1.7). */
  private _resolve(name: string): CounterStyle {
    const known = this._resolved.get(name);
    if (known) return known;
    const rule = this._rule(name);
    let style: CounterStyle;
    if (!rule) style = this._resolve('decimal');
    else if (rule.extends === undefined) style = settle(rule);
    else {
      // the chain of styles it extends, to one that extends nothing or
      // back into itself
      const path: string[] = [name];
      let next = counterStyleName(rule.extends);
      let inLoop = false;
      for (;;) {
        const at = this._rule(next);
        if (!at || at.extends === undefined) break;
        const seen = path.indexOf(next);
        if (seen >= 0) {
          inLoop = path.slice(seen).includes(name);
          break;
        }
        path.push(next);
        next = counterStyleName(at.extends);
      }
      const base =
        inLoop || !this._rule(next) || next === name
          ? this._resolve('decimal')
          : this._resolve(next);
      style = {
        ...base,
        negative: rule.negative ?? base.negative,
        prefix: rule.prefix ?? base.prefix,
        suffix: rule.suffix ?? base.suffix,
        range:
          rule.range === undefined
            ? base.range
            : rule.range === 'auto'
              ? base.system === 'algorithm'
                ? base.range
                : autoRange(base.system)
              : rule.range,
        pad: rule.pad ?? base.pad,
        fallback: rule.fallback ?? base.fallback,
      };
    }
    this._resolved.set(name, style);
    return style;
  }
}

/** A rule's descriptors with their initial values filled in. */
function settle(rule: CounterStyleRule): CounterStyle {
  const system = rule.algorithm ? 'algorithm' : (rule.system ?? 'symbolic');
  return {
    system,
    first: rule.first ?? 1,
    symbols: rule.symbols ?? [],
    additive: rule.additive ?? [],
    negative: rule.negative ?? ['-', ''],
    prefix: rule.prefix ?? '',
    suffix: rule.suffix ?? '. ',
    range:
      rule.range === undefined || rule.range === 'auto'
        ? autoRange(system)
        : rule.range,
    pad: rule.pad ?? [0, ''],
    fallback: rule.fallback ?? 'decimal',
    algorithm: rule.algorithm,
  };
}

/** `range: auto` (3.5): every value, the positive ones, or those from 0. */
function autoRange(system: CounterStyle['system']): [number, number][] {
  if (system === 'alphabetic' || system === 'symbolic') return [[1, Infinity]];
  if (system === 'additive') return [[0, Infinity]];
  return [[-Infinity, Infinity]];
}

/**
 * A value written in one style (2), or null where the style cannot write
 * it: out of its range, a value its system has no representation for, or
 * one longer than there is any use for.
 */
function written(n: number, style: CounterStyle, rtl: boolean): string | null {
  if (!style.range.some(([lo, hi]) => n >= lo && n <= hi)) return null;
  const signed = n < 0 && style.system !== 'cyclic' && style.system !== 'fixed';
  let text = generate(signed ? -n : n, style, rtl);
  if (text === null) return null;
  const [width, symbol] = style.pad;
  let short = width - graphemes(text);
  if (signed) short -= graphemes(style.negative[0] + style.negative[1]);
  if (short > 0 && symbol)
    text = symbol.repeat(Math.min(short, LONGEST)) + text;
  if (signed) text = style.negative[0] + text + style.negative[1];
  return [...text].length > LONGEST ? null : text;
}

let segmenter: Intl.Segmenter | null | undefined;

/** How many grapheme clusters a text is — `pad` counts them (3.6): `ā`
 *  written as an `a` and a combining macron is one. */
function graphemes(text: string): number {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  if (!segmenter) return [...text].length;
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

/** The counter algorithm of a style's system (3.1). */
function generate(n: number, style: CounterStyle, rtl: boolean): string | null {
  const symbols = style.symbols;
  const count = symbols.length;
  switch (style.system) {
    case 'algorithm':
      return style.algorithm!(n);
    case 'cyclic': {
      if (!count) return null;
      const symbol = symbols[(((n - 1) % count) + count) % count];
      // a closed disclosure points the way its text runs (6.3)
      return rtl && symbol === '▸' ? '◂' : symbol;
    }
    case 'fixed': {
      const at = n - style.first;
      return at >= 0 && at < count ? symbols[at] : null;
    }
    case 'symbolic': {
      if (!count || n < 1) return null;
      const times = Math.ceil(n / count);
      return times > LONGEST ? null : symbols[(n - 1) % count].repeat(times);
    }
    case 'alphabetic': {
      if (count < 2 || n < 1) return null;
      let out = '';
      for (let v = n; v > 0; v = Math.floor(v / count)) {
        v -= 1;
        out = symbols[v % count] + out;
      }
      return out;
    }
    case 'numeric': {
      if (count < 2) return null;
      if (n === 0) return symbols[0];
      let out = '';
      for (let v = n; v > 0; v = Math.floor(v / count)) {
        out = symbols[v % count] + out;
      }
      return out;
    }
    case 'additive': {
      const tuples = style.additive;
      if (n === 0) {
        const zero = tuples.find(([weight]) => weight === 0);
        return zero ? zero[1] : null;
      }
      let out = '';
      let v = n;
      for (const [weight, symbol] of tuples) {
        if (weight === 0 || weight > v) continue;
        const reps = Math.floor(v / weight);
        if (reps > LONGEST) return null;
        out += symbol.repeat(reps);
        v -= weight * reps;
        if (v === 0) return out;
      }
      return null;
    }
  }
}

// --- the predefined styles (6, 7) --------------------------------------------------

const range = (lo: number, hi: number): [number, number][] => [[lo, hi]];

/** Ten digits from a zero's code point. */
function digitsFrom(zero: number): string[] {
  return Array.from({ length: 10 }, (_, i) => String.fromCodePoint(zero + i));
}

function numeric(zero: number): CounterStyleRule {
  return { system: 'numeric', symbols: digitsFrom(zero) };
}

/** An additive style from the symbols and their weights, heaviest first. */
function additive(pairs: string): [number, string][] {
  return pairs
    .trim()
    .split(/\s*,\s*/)
    .map((pair) => {
      const [weight, symbol] = pair.split(/\s+/);
      return [Number(weight), symbol];
    });
}

/**
 * A Japanese or Korean longhand style over -9999 to 9999 as its
 * `@counter-style` rule has it (7.1.1): each thousand, hundred and ten a
 * digit and its marker — without the digit where it is one, in the
 * informal styles — and each unit a digit. Past its range a Korean one is
 * written in decimal, as browsers write it, where the rule says
 * `cjk-decimal`.
 */
function longhand(
  digits: string,
  markers: string,
  dropOne: boolean,
  suffix: string,
  negative: string,
  fallback = 'cjk-decimal',
): CounterStyleRule {
  const digit = [...digits];
  const marker = [...markers];
  const tuples: [number, string][] = [];
  for (let place = 3; place >= 1; place -= 1) {
    for (let d = 9; d >= 1; d -= 1) {
      const lead = d === 1 && dropOne ? '' : digit[d];
      tuples.push([d * 10 ** place, lead + marker[place - 1]]);
    }
  }
  for (let d = 9; d >= 0; d -= 1) tuples.push([d, digit[d]]);
  return {
    system: 'additive',
    range: range(-9999, 9999),
    additive: tuples,
    suffix,
    negative: [negative, ''],
    fallback,
  };
}

/**
 * A Chinese longhand style (7.1.2, the extended implementation browsers
 * write): the number in groups of four digits from the right, each group
 * that is not 0 with its group's marker, and in each group each digit that
 * is not 0 with its place's marker. In the informal styles a group of ten
 * to nineteen drops its tens digit; each group drops its zeros at its end,
 * and a run of zeros anywhere else, across groups, is one zero.
 */
function chinese(
  digits: string,
  markers: string,
  groups: string[],
  informal: boolean,
  negative: string,
): CounterStyleRule {
  const digit = [...digits];
  const marker = [...markers];
  return {
    algorithm: (n) => {
      if (n === 0) return digit[0];
      const text = String(n);
      // null for a zero
      const parts: (string | null)[] = [];
      const count = Math.ceil(text.length / 4);
      if (count > 4) return String(n);
      for (let g = count - 1; g >= 0; g -= 1) {
        const end = text.length - g * 4;
        const group = text.slice(Math.max(0, end - 4), end).padStart(4, '0');
        const value = Number(group);
        if (value === 0) {
          parts.push(null);
          continue;
        }
        const own: (string | null)[] = [];
        for (let i = 0; i < 4; i += 1) {
          const d = Number(group[i]);
          const place = 3 - i;
          const mark = place ? marker[place - 1] : '';
          if (d === 0) own.push(null);
          else if (informal && place === 1 && value >= 10 && value <= 19) {
            own.push(mark);
          } else own.push(digit[d] + mark);
        }
        while (own[own.length - 1] === null) own.pop();
        parts.push(...own);
        if (g > 0) parts[parts.length - 1] += groups[g - 1];
      }
      while (parts.length && parts[parts.length - 1] === null) parts.pop();
      let out = '';
      let zero = false;
      for (const part of parts) {
        if (part === null) zero = out !== '';
        else {
          if (zero) out += digit[0];
          zero = false;
          out += part;
        }
      }
      return out;
    },
    // below 10^16 — as near as a double comes to 10^16 - 1
    range: range(-9999999999999998, 9999999999999998),
    suffix: '、',
    negative: [negative, ''],
    fallback: 'cjk-decimal',
  };
}

const SIMP_GROUPS = ['万', '亿', '万亿'];
const TRAD_GROUPS = ['萬', '億', '兆'];

const ETHIOPIC_TENS = ' ፲፳፴፵፶፷፸፹፺';
const ETHIOPIC_UNITS = ' ፩፪፫፬፭፮፯፰፱';

/** `ethiopic-numeric` (7.2): pairs of digits, each marked by its place. */
function ethiopic(n: number): string {
  if (n === 1) return '፩';
  const text = String(n);
  const groups: number[] = [];
  for (let end = text.length; end > 0; end -= 2) {
    groups.push(Number(text.slice(Math.max(0, end - 2), end)));
  }
  let out = '';
  for (let g = groups.length - 1; g >= 0; g -= 1) {
    const value = groups[g];
    const odd = g % 2 === 1;
    const bare =
      value === 0 || (value === 1 && (g === groups.length - 1 || odd));
    if (!bare) {
      const tens = Math.floor(value / 10);
      const units = value % 10;
      if (tens) out += ETHIOPIC_TENS[tens];
      if (units) out += ETHIOPIC_UNITS[units];
    }
    if (odd && value !== 0) out += '፻';
    if (!odd && g !== 0) out += '፼';
  }
  return out;
}

const LATIN = 'abcdefghijklmnopqrstuvwxyz';
const HIRAGANA =
  'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわゐゑをん';
const HIRAGANA_IROHA =
  'いろはにほへとちりぬるをわかよたれそつねならむうゐのおくやまけふこえてあさきゆめみしゑひもせす';
const KATAKANA =
  'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヰヱヲン';
const KATAKANA_IROHA =
  'イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス';

const ARMENIAN_UPPER =
  '9000 Ք, 8000 Փ, 7000 Ւ, 6000 Ց, 5000 Ր, 4000 Տ, 3000 Վ, 2000 Ս, 1000 Ռ, ' +
  '900 Ջ, 800 Պ, 700 Չ, 600 Ո, 500 Շ, 400 Ն, 300 Յ, 200 Մ, 100 Ճ, 90 Ղ, ' +
  '80 Ձ, 70 Հ, 60 Կ, 50 Ծ, 40 Խ, 30 Լ, 20 Ի, 10 Ժ, 9 Թ, 8 Ը, 7 Է, 6 Զ, ' +
  '5 Ե, 4 Դ, 3 Գ, 2 Բ, 1 Ա';
const GEORGIAN =
  '10000 ჵ, 9000 ჰ, 8000 ჯ, 7000 ჴ, 6000 ხ, 5000 ჭ, 4000 წ, 3000 ძ, ' +
  '2000 ც, 1000 ჩ, 900 შ, 800 ყ, 700 ღ, 600 ქ, 500 ფ, 400 ჳ, 300 ტ, ' +
  '200 ს, 100 რ, 90 ჟ, 80 პ, 70 ო, 60 ჲ, 50 ნ, 40 მ, 30 ლ, 20 კ, 10 ი, ' +
  '9 თ, 8 ჱ, 7 ზ, 6 ვ, 5 ე, 4 დ, 3 გ, 2 ბ, 1 ა';
const HEBREW =
  '10000 י׳, 9000 ט׳, 8000 ח׳, 7000 ז׳, 6000 ו׳, 5000 ה׳, 4000 ד׳, 3000 ג׳, ' +
  '2000 ב׳, 1000 א׳, 400 ת, 300 ש, 200 ר, 100 ק, 90 צ, 80 פ, 70 ע, 60 ס, ' +
  '50 נ, 40 מ, 30 ל, 20 כ, 19 יט, 18 יח, 17 יז, 16 טז, 15 טו, 10 י, 9 ט, ' +
  '8 ח, 7 ז, 6 ו, 5 ה, 4 ד, 3 ג, 2 ב, 1 א';
const ROMAN =
  '1000 M, 900 CM, 500 D, 400 CD, 100 C, 90 XC, 50 L, 40 XL, 10 X, 9 IX, ' +
  '5 V, 4 IV, 1 I';

/** The styles the specification defines, by name. */
const PREDEFINED = new Map<string, CounterStyleRule>([
  ['decimal', numeric(0x30)],
  ['decimal-leading-zero', { extends: 'decimal', pad: [2, '0'] }],
  ['arabic-indic', numeric(0x660)],
  [
    'armenian',
    {
      system: 'additive',
      range: range(1, 9999),
      additive: additive(ARMENIAN_UPPER),
    },
  ],
  ['upper-armenian', { extends: 'armenian' }],
  [
    'lower-armenian',
    {
      system: 'additive',
      range: range(1, 9999),
      additive: additive(ARMENIAN_UPPER.toLowerCase()),
    },
  ],
  ['bengali', numeric(0x9e6)],
  ['cambodian', numeric(0x17e0)],
  ['khmer', { extends: 'cambodian' }],
  [
    'cjk-decimal',
    {
      system: 'numeric',
      range: range(0, Infinity),
      symbols: [...'〇一二三四五六七八九'],
      suffix: '、',
    },
  ],
  ['devanagari', numeric(0x966)],
  [
    'georgian',
    {
      system: 'additive',
      range: range(1, 19999),
      additive: additive(GEORGIAN),
    },
  ],
  ['gujarati', numeric(0xae6)],
  ['gurmukhi', numeric(0xa66)],
  [
    'hebrew',
    { system: 'additive', range: range(1, 10999), additive: additive(HEBREW) },
  ],
  ['kannada', numeric(0xce6)],
  ['lao', numeric(0xed0)],
  ['malayalam', numeric(0xd66)],
  ['mongolian', numeric(0x1810)],
  ['myanmar', numeric(0x1040)],
  ['oriya', numeric(0xb66)],
  ['persian', numeric(0x6f0)],
  [
    'lower-roman',
    {
      system: 'additive',
      range: range(1, 3999),
      additive: additive(ROMAN.toLowerCase()),
    },
  ],
  [
    'upper-roman',
    { system: 'additive', range: range(1, 3999), additive: additive(ROMAN) },
  ],
  ['tamil', numeric(0xbe6)],
  ['telugu', numeric(0xc66)],
  ['thai', numeric(0xe50)],
  ['tibetan', numeric(0xf20)],
  ['lower-alpha', { system: 'alphabetic', symbols: [...LATIN] }],
  ['lower-latin', { extends: 'lower-alpha' }],
  ['upper-alpha', { system: 'alphabetic', symbols: [...LATIN.toUpperCase()] }],
  ['upper-latin', { extends: 'upper-alpha' }],
  [
    'lower-greek',
    { system: 'alphabetic', symbols: [...'αβγδεζηθικλμνξοπρστυφχψω'] },
  ],
  ['hiragana', { system: 'alphabetic', symbols: [...HIRAGANA], suffix: '、' }],
  [
    'hiragana-iroha',
    { system: 'alphabetic', symbols: [...HIRAGANA_IROHA], suffix: '、' },
  ],
  ['katakana', { system: 'alphabetic', symbols: [...KATAKANA], suffix: '、' }],
  [
    'katakana-iroha',
    { system: 'alphabetic', symbols: [...KATAKANA_IROHA], suffix: '、' },
  ],
  ['disc', { system: 'cyclic', symbols: ['•'], suffix: ' ' }],
  ['circle', { system: 'cyclic', symbols: ['◦'], suffix: ' ' }],
  ['square', { system: 'cyclic', symbols: ['▪'], suffix: ' ' }],
  ['disclosure-open', { system: 'cyclic', symbols: ['▾'], suffix: ' ' }],
  ['disclosure-closed', { system: 'cyclic', symbols: ['▸'], suffix: ' ' }],
  [
    'cjk-earthly-branch',
    {
      system: 'fixed',
      symbols: [...'子丑寅卯辰巳午未申酉戌亥'],
      suffix: '、',
      fallback: 'cjk-decimal',
    },
  ],
  [
    'cjk-heavenly-stem',
    {
      system: 'fixed',
      symbols: [...'甲乙丙丁戊己庚辛壬癸'],
      suffix: '、',
      fallback: 'cjk-decimal',
    },
  ],
  [
    'japanese-informal',
    longhand('〇一二三四五六七八九', '十百千', true, '、', 'マイナス'),
  ],
  [
    'japanese-formal',
    longhand('零壱弐参四伍六七八九', '拾百阡', false, '、', 'マイナス'),
  ],
  [
    'korean-hangul-formal',
    longhand(
      '영일이삼사오육칠팔구',
      '십백천',
      false,
      ', ',
      '마이너스 ',
      'decimal',
    ),
  ],
  [
    'korean-hanja-informal',
    longhand(
      '零一二三四五六七八九',
      '十百千',
      true,
      ', ',
      '마이너스 ',
      'decimal',
    ),
  ],
  [
    'korean-hanja-formal',
    longhand(
      '零壹貳參四五六七八九',
      '拾百仟',
      false,
      ', ',
      '마이너스 ',
      'decimal',
    ),
  ],
  [
    'simp-chinese-informal',
    chinese('零一二三四五六七八九', '十百千', SIMP_GROUPS, true, '负'),
  ],
  [
    'simp-chinese-formal',
    chinese('零壹贰叁肆伍陆柒捌玖', '拾佰仟', SIMP_GROUPS, false, '负'),
  ],
  [
    'trad-chinese-informal',
    chinese('零一二三四五六七八九', '十百千', TRAD_GROUPS, true, '負'),
  ],
  [
    'trad-chinese-formal',
    chinese('零壹貳參肆伍陸柒捌玖', '拾佰仟', TRAD_GROUPS, false, '負'),
  ],
  [
    'cjk-ideographic',
    chinese('零一二三四五六七八九', '十百千', TRAD_GROUPS, true, '負'),
  ],
  [
    'ethiopic-numeric',
    { algorithm: ethiopic, range: range(1, Infinity), suffix: '/ ' },
  ],
]);

// --- `@counter-style` and `symbols()` ------------------------------------------------

/**
 * An `@counter-style` rule's style (3), or null where the rule defines
 * none: a name that cannot be one, no symbols for its system, too few, or
 * symbols beside `extends`. A descriptor that cannot be read is left out,
 * and the last one read of a name stands.
 */
export function counterStyleRule(
  prelude: string,
  declarations: readonly Declaration[],
): { name: string; rule: CounterStyleRule } | null {
  const words = prelude.trim().split(/\s+/);
  if (words.length !== 1 || !words[0]) return null;
  const name = counterStyleName(words[0]);
  if (
    FIXED_NAMES.has(name) ||
    /^none$/i.test(name) ||
    CSS_WIDE.test(name) ||
    !/^-?[_a-zA-Z\u0080-￿][\w\u0080-￿-]*$/.test(name)
  ) {
    return null;
  }
  const rule: CounterStyleRule = {};
  for (const { prop, value } of declarations) {
    readDescriptor(rule, prop.toLowerCase(), value);
  }
  return valid(rule) ? { name, rule } : null;
}

/** Whether a rule's system has the symbols it needs (3.1, 3.8). */
function valid(rule: CounterStyleRule): boolean {
  if (rule.extends !== undefined) return !rule.symbols && !rule.additive;
  const system = rule.system ?? 'symbolic';
  if (system === 'additive') return !!rule.additive?.length;
  const least = system === 'alphabetic' || system === 'numeric' ? 2 : 1;
  return (rule.symbols?.length ?? 0) >= least;
}

/** One descriptor into a rule, where its value is one. */
function readDescriptor(
  rule: CounterStyleRule,
  prop: string,
  value: string,
): void {
  // the comma-separated ones, which are read a part at a time
  if (prop === 'additive-symbols') {
    const tuples = additiveTuples(integers(value, true));
    if (tuples) rule.additive = tuples;
    return;
  }
  if (prop === 'range') {
    const ranges = parseRanges(integers(value, false));
    if (ranges !== undefined) rule.range = ranges;
    return;
  }
  const tokens = tokenize(
    prop === 'pad' ? integers(value, true) : integers(value, false),
  );
  if (!tokens?.length) return;
  switch (prop) {
    case 'system': {
      const first = tokens[0];
      if (first.kind !== 'ident') return;
      const kind = first.name.toLowerCase();
      if (kind === 'extends') {
        if (tokens.length !== 2 || tokens[1].kind !== 'ident') return;
        rule.extends = tokens[1].name;
        rule.system = undefined;
        rule.first = undefined;
        return;
      }
      if (kind === 'fixed') {
        if (tokens.length > 2) return;
        const n = tokens[1];
        if (n && (n.kind !== 'number' || !Number.isInteger(n.value))) return;
        rule.system = 'fixed';
        rule.first = n?.kind === 'number' ? n.value : 1;
        rule.extends = undefined;
        return;
      }
      if (
        tokens.length === 1 &&
        (kind === 'cyclic' ||
          kind === 'numeric' ||
          kind === 'alphabetic' ||
          kind === 'symbolic' ||
          kind === 'additive')
      ) {
        rule.system = kind;
        rule.extends = undefined;
      }
      return;
    }
    case 'symbols': {
      const symbols = tokens.map(symbolOf);
      if (symbols.every((s): s is string => s !== null)) rule.symbols = symbols;
      return;
    }
    case 'negative': {
      if (tokens.length > 2) return;
      const [a, b] = tokens.map(symbolOf);
      if (a === null || b === null) return;
      rule.negative = [a, b ?? ''];
      return;
    }
    case 'prefix':
    case 'suffix': {
      const symbol = tokens.length === 1 ? symbolOf(tokens[0]) : null;
      if (symbol !== null) rule[prop] = symbol;
      return;
    }
    case 'pad': {
      if (tokens.length !== 2) return;
      const [a, b] = tokens;
      const [n, s] = a.kind === 'number' ? [a, b] : [b, a];
      const symbol = symbolOf(s);
      if (
        n.kind !== 'number' ||
        !Number.isInteger(n.value) ||
        n.value < 0 ||
        symbol === null
      ) {
        return;
      }
      rule.pad = [n.value, symbol];
      return;
    }
    case 'fallback': {
      if (tokens.length === 1 && tokens[0].kind === 'ident') {
        rule.fallback = counterStyleName(tokens[0].name);
      }
      return;
    }
  }
}

/**
 * A value with each `calc()` in it that comes to a number written as the
 * integer it rounds to — and, where the descriptor takes no negative one,
 * as 0 where it is negative: a `calc()` is clamped to what it may be,
 * where the number written as itself is refused.
 */
function integers(value: string, clamp: boolean): string {
  return value.replace(/calc\((?:[^()]|\([^()]*\))*\)/gi, (expr) => {
    const n = parseNumber(expr);
    if (n === null || !Number.isFinite(n)) return expr;
    const whole = Math.round(n);
    return String(clamp ? Math.max(0, whole) : whole);
  });
}

/** A `<symbol>`: a string, or an identifier written as itself — which a
 *  CSS-wide keyword cannot be. Images are not drawn here, and make the
 *  descriptor none. */
function symbolOf(token: Token | undefined): string | null {
  if (!token) return null;
  if (token.kind === 'string') return token.text;
  if (token.kind === 'ident' && !CSS_WIDE.test(token.name)) return token.name;
  return null;
}

const CSS_WIDE = /^(inherit|initial|unset|default|revert|revert-layer)$/i;

/** `additive-symbols`: weights and symbols, in strictly falling weight. */
function additiveTuples(value: string): [number, string][] | null {
  const out: [number, string][] = [];
  for (const part of splitTopLevelCommas(value)) {
    const tokens = tokenize(part);
    if (tokens?.length !== 2) return null;
    const [a, b] = tokens;
    const [n, s] = a.kind === 'number' ? [a, b] : [b, a];
    const symbol = symbolOf(s);
    if (
      n.kind !== 'number' ||
      !Number.isInteger(n.value) ||
      n.value < 0 ||
      symbol === null
    ) {
      return null;
    }
    if (out.length && n.value >= out[out.length - 1][0]) return null;
    out.push([n.value, symbol]);
  }
  return out.length ? out : null;
}

/** `range`: `auto`, or bounds in pairs, `infinite` at either end;
 *  undefined where it is neither. */
function parseRanges(value: string): [number, number][] | 'auto' | undefined {
  if (value.trim().toLowerCase() === 'auto') return 'auto';
  const out: [number, number][] = [];
  for (const part of splitTopLevelCommas(value)) {
    const tokens = tokenize(part);
    if (tokens?.length !== 2) return undefined;
    const bound = (token: Token, low: boolean): number | null => {
      if (token.kind === 'ident' && token.name.toLowerCase() === 'infinite') {
        return low ? -Infinity : Infinity;
      }
      return token.kind === 'number' && Number.isInteger(token.value)
        ? token.value
        : null;
    };
    const lo = bound(tokens[0], true);
    const hi = bound(tokens[1], false);
    if (lo === null || hi === null || lo > hi) return undefined;
    out.push([lo, hi]);
  }
  return out.length ? out : undefined;
}

function splitTopLevelCommas(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}

/**
 * `symbols()` (4) as it is kept, which is a counter style's name: its type
 * and its strings, written again the one way, so that the same function
 * twice is the same style. Null where it is not one.
 */
export function symbolsFunction(token: Token): string | null {
  if (token.kind !== 'function' || token.name.toLowerCase() !== 'symbols') {
    return null;
  }
  if (token.args.length !== 1) return null;
  const parts = token.args[0];
  let type = 'symbolic';
  let i = 0;
  if (parts[0]?.kind === 'ident') {
    type = parts[0].name.toLowerCase();
    if (!/^(cyclic|numeric|alphabetic|symbolic|fixed)$/.test(type)) return null;
    i = 1;
  }
  const strings: string[] = [];
  for (; i < parts.length; i += 1) {
    const part = parts[i];
    if (part.kind !== 'string') return null;
    strings.push(part.text);
  }
  if (!strings.length) return null;
  if ((type === 'alphabetic' || type === 'numeric') && strings.length < 2) {
    return null;
  }
  return `symbols(${type} ${JSON.stringify(strings)})`;
}

const ANONYMOUS = new Map<string, CounterStyleRule>();

/** The style a `symbols()` names, from the form `symbolsFunction` keeps:
 *  its system and symbols, with nothing before it and a space after (4). */
function anonymous(name: string): CounterStyleRule | undefined {
  const known = ANONYMOUS.get(name);
  if (known) return known;
  const m = /^symbols\((\w+) (.*)\)$/.exec(name);
  if (!m) return undefined;
  let symbols: string[];
  try {
    symbols = JSON.parse(m[2]) as string[];
  } catch {
    return undefined;
  }
  const rule: CounterStyleRule = {
    system: m[1] as System,
    symbols,
    prefix: '',
    suffix: ' ',
  };
  ANONYMOUS.set(name, rule);
  return rule;
}
