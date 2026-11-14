// `text-transform` (CSS Text 3, 2.1, and CSS Text 4's `math-auto`): its
// value read and written in one canonical form, which is what a style
// holds, and the transforms other than the case ones' letters, which
// `transformText` in `layout/boxes.ts` applies after a case transform, in
// the order the specification gives: the case, then `full-width`, then
// `full-size-kana`.

/** `none`, `math-auto`, or the case keyword, `full-width` and
 *  `full-size-kana` each at most once and in that order — the value as it
 *  computes and serializes. Undefined for anything else. */
export function parseTextTransform(value: string): string | undefined {
  const words = value.trim().toLowerCase().split(/\s+/);
  if (words.length === 1 && (words[0] === 'none' || words[0] === 'math-auto')) {
    return words[0];
  }
  let kase: string | null = null;
  let width = false;
  let kana = false;
  for (const word of words) {
    if (word === 'uppercase' || word === 'lowercase' || word === 'capitalize') {
      if (kase) return undefined;
      kase = word;
    } else if (word === 'full-width') {
      if (width) return undefined;
      width = true;
    } else if (word === 'full-size-kana') {
      if (kana) return undefined;
      kana = true;
    } else return undefined;
  }
  const out = [kase, width && 'full-width', kana && 'full-size-kana'].filter(
    Boolean,
  );
  return out.length ? out.join(' ') : undefined;
}

/** What a value does: its case transform, and whether it widens and
 *  enlarges kana. Kept by the value, which a document has few of. */
export interface TransformParts {
  kase: 'uppercase' | 'lowercase' | 'capitalize' | 'math-auto' | null;
  width: boolean;
  kana: boolean;
}

const PARTS = new Map<string, TransformParts>();

export function transformParts(value: string): TransformParts {
  let parts = PARTS.get(value);
  if (!parts) {
    const words = value.split(' ');
    const kase = words.find(
      (w) =>
        w === 'uppercase' ||
        w === 'lowercase' ||
        w === 'capitalize' ||
        w === 'math-auto',
    ) as TransformParts['kase'] | undefined;
    parts = {
      kase: kase ?? null,
      width: words.includes('full-width'),
      kana: words.includes('full-size-kana'),
    };
    PARTS.set(value, parts);
  }
  return parts;
}

/**
 * The language a case transform is tailored for (CSS Text 3, 2.1.1), from
 * an element's `lang`: Turkish and Azeri, whose dotted and dotless i are
 * two letters; Lithuanian, which keeps a dot over an accented i; Greek,
 * whose capitals lose their tonos; Dutch, whose `ij` is one letter at a
 * word's start. Null for any other, which is cased as nobody's.
 */
export function tailoredLanguage(lang: string): string | null {
  const [tag, ...subtags] = lang.trim().toLowerCase().split(/[-_]/);
  const script = TAILORED.get(tag);
  if (!script) return null;
  // a script the tag names that is not the one the rules are for says the
  // text is in another writing system (CSS Text 3, 1.5): Turkish in
  // Cyrillic is cased as nobody's
  const named = subtags.find((sub) => /^[a-z]{4}$/.test(sub));
  return named && named !== script ? null : tag;
}

/** The languages with case rules of their own, and the script each is
 *  for. */
const TAILORED = new Map([
  ['tr', 'latn'],
  ['az', 'latn'],
  ['lt', 'latn'],
  ['nl', 'latn'],
  ['el', 'grek'],
]);

/** Upper case, tailored for `lang` (`tailoredLanguage`). */
export function upperIn(text: string, lang: string | null): string {
  if (!lang || lang === 'nl') return text.toUpperCase();
  try {
    return text.toLocaleUpperCase(lang);
  } catch {
    return text.toUpperCase();
  }
}

/** Lower case, tailored for `lang`. */
export function lowerIn(text: string, lang: string | null): string {
  if (!lang || lang === 'nl' || lang === 'el') return text.toLowerCase();
  try {
    return text.toLocaleLowerCase(lang);
  } catch {
    return text.toLowerCase();
  }
}

/**
 * `full-width` (CSS Text 3, 2.1): each character in its full-width form
 * where it has one — what Unicode decomposes to it as `<wide>`, printable
 * ASCII and a few symbols, a space as an ideographic space — and each
 * half-width form as what it is the `<narrow>` form of, a code unit for a
 * code unit.
 */
export function fullWidth(text: string): string {
  let out = '';
  let changed = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    let w = c;
    if (c === 0x20) w = 0x3000;
    else if (c >= 0x21 && c <= 0x7e) w = c + 0xfee0;
    else if (WIDE_SYMBOLS.has(c)) w = WIDE_SYMBOLS.get(c)!;
    else if (c >= 0xffa0 && c <= 0xffdc) w = HANGUL_WIDE[c - 0xffa0] || c;
    else if ((c >= 0xff61 && c <= 0xff9f) || (c >= 0xffe8 && c <= 0xffee)) {
      // one decomposition, which for these is all NFKC does
      const wide = text[i].normalize('NFKC');
      if (wide.length === 1) w = wide.charCodeAt(0);
    }
    if (w !== c) changed = true;
    out += String.fromCharCode(w);
  }
  return changed ? out : text;
}

/**
 * Half-width Hangul, U+FFA0 on, as the compatibility jamo each is the
 * `<narrow>` form of: NFKC takes those one decomposition further, to the
 * conjoining jamo, which are no full-width forms. Zero where U+FFBF,
 * U+FFC0 and the like are no letter.
 */
const HANGUL_WIDE: readonly number[] = (() => {
  const out: number[] = [0x3164];
  for (let c = 0x3131; c <= 0x314e; c += 1) out.push(c);
  // the vowels, in four runs with unassigned code points before each
  const vowels: [number, number, number][] = [
    [3, 0x314f, 0x3154],
    [2, 0x3155, 0x315a],
    [2, 0x315b, 0x3160],
    [2, 0x3161, 0x3163],
  ];
  for (const [gap, from, to] of vowels) {
    for (let i = 0; i < gap; i += 1) out.push(0);
    for (let c = from; c <= to; c += 1) out.push(c);
  }
  return out;
})();

/** The symbols outside ASCII with a `<wide>` form of their own. */
const WIDE_SYMBOLS = new Map<number, number>([
  [0xa2, 0xffe0],
  [0xa3, 0xffe1],
  [0xac, 0xffe2],
  [0xaf, 0xffe3],
  [0xa6, 0xffe4],
  [0xa5, 0xffe5],
  [0x20a9, 0xffe6],
  [0x2985, 0xff5f],
  [0x2986, 0xff60],
]);

/**
 * `full-size-kana` (CSS Text 3, 2.1, and its appendix of small kana): each
 * small kana as the full-size kana it is a small form of — hiragana,
 * katakana, the katakana phonetic extensions, half-width katakana and the
 * small kana of the Kana Extended and Small Kana Extension blocks, one
 * code point to one.
 */
export function fullSizeKana(text: string): string {
  let out = '';
  let changed = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const full = SMALL_KANA.get(cp);
    if (full === undefined) {
      out += ch;
      continue;
    }
    changed = true;
    out += String.fromCodePoint(full);
  }
  return changed ? out : text;
}

const SMALL_KANA = new Map<number, number>([
  // hiragana
  [0x3041, 0x3042],
  [0x3043, 0x3044],
  [0x3045, 0x3046],
  [0x3047, 0x3048],
  [0x3049, 0x304a],
  [0x3063, 0x3064],
  [0x3083, 0x3084],
  [0x3085, 0x3086],
  [0x3087, 0x3088],
  [0x308e, 0x308f],
  [0x3095, 0x304b],
  [0x3096, 0x3051],
  // katakana
  [0x30a1, 0x30a2],
  [0x30a3, 0x30a4],
  [0x30a5, 0x30a6],
  [0x30a7, 0x30a8],
  [0x30a9, 0x30aa],
  [0x30c3, 0x30c4],
  [0x30e3, 0x30e4],
  [0x30e5, 0x30e6],
  [0x30e7, 0x30e8],
  [0x30ee, 0x30ef],
  [0x30f5, 0x30ab],
  [0x30f6, 0x30b1],
  // katakana phonetic extensions
  [0x31f0, 0x30af],
  [0x31f1, 0x30b7],
  [0x31f2, 0x30b9],
  [0x31f3, 0x30c8],
  [0x31f4, 0x30cc],
  [0x31f5, 0x30cf],
  [0x31f6, 0x30d2],
  [0x31f7, 0x30d5],
  [0x31f8, 0x30d8],
  [0x31f9, 0x30db],
  [0x31fa, 0x30e0],
  [0x31fb, 0x30e9],
  [0x31fc, 0x30ea],
  [0x31fd, 0x30eb],
  [0x31fe, 0x30ec],
  [0x31ff, 0x30ed],
  // half-width katakana
  [0xff67, 0xff71],
  [0xff68, 0xff72],
  [0xff69, 0xff73],
  [0xff6a, 0xff74],
  [0xff6b, 0xff75],
  [0xff6c, 0xff94],
  [0xff6d, 0xff95],
  [0xff6e, 0xff96],
  [0xff6f, 0xff82],
  // kana extended and small kana extension
  [0x1b132, 0x3053],
  [0x1b150, 0x3090],
  [0x1b151, 0x3091],
  [0x1b152, 0x3092],
  [0x1b155, 0x30b3],
  [0x1b164, 0x30f0],
  [0x1b165, 0x30f1],
  [0x1b166, 0x30f2],
  [0x1b167, 0x30f3],
]);

/**
 * `math-auto` (CSS Text 4, 2.1): a text of one letter in its mathematical
 * italic form — a Latin or a Greek letter, a dotless i or j — and any other
 * text as it is.
 */
export function mathAuto(text: string): string {
  if (text.length !== 1) return text;
  const cp = text.charCodeAt(0);
  const italic = mathItalic(cp);
  return italic === null ? text : String.fromCodePoint(italic);
}

function mathItalic(cp: number): number | null {
  if (cp >= 0x41 && cp <= 0x5a) return 0x1d434 + (cp - 0x41);
  if (cp === 0x68) return 0x210e;
  if (cp >= 0x61 && cp <= 0x7a) return 0x1d44e + (cp - 0x61);
  if (cp === 0x131) return 0x1d6a4;
  if (cp === 0x237) return 0x1d6a5;
  if (cp >= 0x391 && cp <= 0x3a9 && cp !== 0x3a2) return 0x1d6e2 + (cp - 0x391);
  if (cp === 0x3f4) return 0x1d6f3;
  if (cp === 0x2207) return 0x1d6fb;
  if (cp >= 0x3b1 && cp <= 0x3c9) return 0x1d6fc + (cp - 0x3b1);
  if (cp === 0x2202) return 0x1d715;
  if (cp === 0x3f5) return 0x1d716;
  if (cp === 0x3d1) return 0x1d717;
  if (cp === 0x3f0) return 0x1d718;
  if (cp === 0x3d5) return 0x1d719;
  if (cp === 0x3f1) return 0x1d71a;
  if (cp === 0x3d6) return 0x1d71b;
  return null;
}
