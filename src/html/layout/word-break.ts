// Where a line may break in text whose `word-break` or `line-break` moves
// the places UAX #14 gives (CSS Text 3, 5.2 and 5.3): `break-all` adds one
// between any two letters, `keep-all` takes away those between two
// letters, and `line-break: anywhere` puts one between any two grapheme
// clusters. Neither engine reads either property — each breaks where UAX
// #14 says — so a paragraph with one is broken a line at a time from these
// (`layoutOwnBreaks` in inline.ts). Pure: asserted with no display.
import LineBreaker from 'linebreak';

/** How a stretch of the text breaks. */
export interface BreakRule {
  /** Where it starts and ends in the joined text. */
  start: number;
  end: number;
  wordBreak: string;
  anywhere: boolean;
  /** Whether its lines wrap at all: `nowrap` and `pre` text adds none. */
  wraps: boolean;
  /** Whether it keeps its spaces where its lines wrap, `pre-wrap` and
   *  `break-spaces`: a line may then start with one. */
  keepsSpaces?: boolean;
  /** `line-break`'s strictness (CSS Text 3, 5.3). */
  lineBreak?: 'auto' | 'loose' | 'normal' | 'strict';
  /** Whether it keeps them as `break-spaces` does, a place to break after
   *  each (CSS Text 3, 4.1.3). */
  breakSpaces?: boolean;
}

/** A place a line may break: before the character at `at`. */
export interface BreakAt {
  at: number;
  /** A forced break: a line feed or a paragraph separator ends there. */
  required: boolean;
}

/**
 * UAX #14 with the classes `word-break` moves (CSS Text 3, 5.2), as Blink
 * breaks it: `break-all` reads a letter or a number as an ideograph (AL, HL
 * and NU as ID), which UAX #14 then lets a line break between, and
 * `keep-all` an ideograph or a Hangul syllable as a letter, which it does
 * not. Everything else UAX #14 says stands: no break before a full stop,
 * after a prefix such as `\\`, or inside a cluster. `nextCharClass` is the
 * one place the package reads a character's class, and it is a method of
 * the class it exports.
 */
class RemappedBreaker extends LineBreaker {
  constructor(
    text: string,
    private remap: (cls: number, at: number) => number,
  ) {
    super(text);
  }
  nextCharClass(): number {
    const at = (this as unknown as BreakerInternals).pos;
    const read = (LineBreaker.prototype as unknown as BreakerInternals)
      .nextCharClass;
    return this.remap(read.call(this), at);
  }
}

/** What `linebreak` declares nothing of: where it reads next, and the
 *  method that reads a class, which the subclass wraps. */
interface BreakerInternals {
  pos: number;
  nextCharClass(): number;
}

/** The class `linebreak` gives a character, read off the breaker itself so
 *  no number of the package's is written here. */
function classOf(ch: string): number {
  let seen = -1;
  const probe = new RemappedBreaker(ch, (cls) => (seen = cls));
  probe.nextBreak();
  return seen;
}

let classes: {
  letters: Set<number>;
  ideographs: Set<number>;
  ID: number;
  AL: number;
} | null = null;
function classesOf() {
  return (classes ??= {
    // AL, NU, HL
    letters: new Set(['a', '1', '\u05d0'].map(classOf)),
    // ID, H2, H3, JL, JV, JT
    ideographs: new Set(
      ['\u4e2d', '\uac00', '\uac01', '\u1100', '\u1161', '\u11a8'].map(classOf),
    ),
    ID: classOf('\u4e2d'),
    AL: classOf('a'),
  });
}

/** Whether any rule moves the places UAX #14 gives. */
export function movesBreaks(
  rules: readonly BreakRule[],
  text: string,
): boolean {
  // (`break-spaces` alone is `layoutBreakSpaces`'s)
  return rules.some(
    (r) =>
      r.wraps &&
      (r.anywhere ||
        r.wordBreak === 'break-all' ||
        r.wordBreak === 'keep-all' ||
        r.lineBreak === 'loose' ||
        (r.lineBreak !== 'strict' &&
          SMALL_KANA.test(text.slice(r.start, r.end)))),
  );
}

/**
 * UAX #14's CJ: small kana and the prolonged sound marks, which `linebreak`
 * resolves as NS, the strict reading; and the CJK hyphens U+301C and U+30A0.
 * CSS lets a line break before each in `normal` and `loose` (CSS Text 3,
 * 5.3), as every browser does by default, which is reading it as an
 * ideograph.
 */
export const SMALL_KANA =
  /[\u301C\u30A0\u3041\u3043\u3045\u3047\u3049\u3063\u3083\u3085\u3087\u308E\u3095\u3096\u30A1\u30A3\u30A5\u30A7\u30A9\u30C3\u30E3\u30E5\u30E7\u30EE\u30F5\u30F6\u30FC\u31F0-\u31FF\uFF67-\uFF70]/;

/**
 * What `line-break: loose` breaks before besides (CSS Text 3, 5.3): the
 * iteration marks, the inseparable leaders, the centred punctuation, and the postfixes and
 * prefixes Chinese and Japanese set apart, read as ideographs.
 */
const LOOSE =
  /[\u3005\u303B\u309D\u309E\u30FD\u30FE\u2024-\u2026\u30FB\uFF1A\uFF1B\uFF65\u203C\u2047-\u2049\uFF01\uFF1F\u00B0\u2030\u2032\u2033\u2103\uFF05\uFFE0\u00A5\u20AC\u2116\uFF04\uFFE1\uFFE5]/;

/** A letter, a number or a mark: what `keep-all` keeps together. */
const WORD_LETTER = /[\p{L}\p{N}\p{M}]/u;
/** A closing bracket or quote, which `keep-all` keeps with the letter
 *  after it. */
const CLOSES_WORD = /[\p{Pe}\p{Pf}"']/u;

let graphemes: Intl.Segmenter | null = null;

/** The code point that ends before `at`, and the one that starts there. */
function before(text: string, at: number): string {
  const low = text.charCodeAt(at - 1);
  return low >= 0xdc00 && low < 0xe000 && at >= 2
    ? text.slice(at - 2, at)
    : text.charAt(at - 1);
}
function after(text: string, at: number): string {
  return String.fromCodePoint(text.codePointAt(at) ?? 0);
}

/**
 * The places a line may break in `text`, in order. A break between two
 * characters is the call of what holds both (CSS Text 3, 5.1), which for
 * two stretches of other rules is taken as the stricter: a break `break-all`
 * adds stands only where both sides break so.
 */
export function breakOpportunities(
  text: string,
  rules: readonly BreakRule[],
): BreakAt[] {
  const ruleAt = (at: number): BreakRule | null => {
    for (const r of rules) if (at >= r.start && at < r.end) return r;
    return null;
  };
  const out = new Map<number, boolean>();
  const moved = rules.some(
    (r) =>
      r.wordBreak === 'break-all' ||
      r.wordBreak === 'keep-all' ||
      r.lineBreak !== 'strict',
  );
  const c = moved ? classesOf() : null;
  let k = 0;
  // the class the character before was read as
  let last = -1;
  const breaker = c
    ? new RemappedBreaker(text, (cls, at) => (last = remap(cls, at)))
    : new LineBreaker(text);
  function remap(cls: number, at: number): number {
    const c = classesOf();
    while (k < rules.length - 1 && rules[k].end <= at) k += 1;
    const r = rules[k];
    if (!r || !r.wraps || at < r.start) return cls;
    if (r.lineBreak !== 'strict') {
      const ch = text[at];
      if (SMALL_KANA.test(ch)) {
        return r.wordBreak === 'keep-all' ? c.AL : c.ID;
      }
      if (r.lineBreak === 'loose' && LOOSE.test(ch)) return c.ID;
      // and a hyphen after an ideograph, `break-all`'s letters among
      // them (WPT's line-break-loose-hyphens-*)
      if (
        r.lineBreak === 'loose' &&
        (ch === '\u2010' || ch === '\u2013') &&
        last === c.ID
      ) {
        return c.ID;
      }
    }
    if (r.wordBreak === 'break-all' && c.letters.has(cls)) return c.ID;
    if (r.wordBreak === 'keep-all' && c.ideographs.has(cls)) return c.AL;
    return cls;
  }
  for (let bk = breaker.nextBreak(); bk; bk = breaker.nextBreak()) {
    out.set(bk.position, bk.required);
  }
  // keep-all keeps a word whole where a closing bracket or quote is inside
  // it, which UAX #14 breaks after: Chromium, Firefox and WebKit set
  // `（普通席）は` and `"라고` on one line, and still break after `、`
  // (WPT's word-break-keep-all-001 and -002)
  if (rules.some((r) => r.wordBreak === 'keep-all')) {
    for (const [at, required] of out) {
      if (required || at <= 0 || at >= text.length) continue;
      const a = ruleAt(at - 1);
      const b = ruleAt(at);
      if (a?.wordBreak !== 'keep-all' || b?.wordBreak !== 'keep-all') continue;
      if (
        WORD_LETTER.test(after(text, at)) &&
        (WORD_LETTER.test(before(text, at)) ||
          CLOSES_WORD.test(before(text, at)))
      ) {
        out.delete(at);
      }
    }
  }
  // break-spaces: after each space it keeps, a run of them included
  for (const r of rules) {
    if (!r.breakSpaces || !r.wraps) continue;
    for (let at = r.start; at < r.end; at += 1) {
      if (text.charCodeAt(at) === 0x20 && !out.has(at + 1)) {
        out.set(at + 1, false);
      }
    }
  }
  // anywhere: between grapheme clusters
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const anywhere = rules.some((r) => r.anywhere);
  for (const { index } of anywhere ? graphemes.segment(text) : []) {
    if (index <= 0 || out.has(index)) continue;
    const a = ruleAt(index - 1);
    const b = ruleAt(index);
    if (!a || !b || !a.wraps || !b.wraps) continue;
    const prev = before(text, index);
    const next = after(text, index);
    if (a.anywhere && b.anywhere) {
      // a collapsible space a line ends on hangs, so a break before one is
      // the break after it; a line never starts with a line feed
      if (next === '\n' || prev === '\n') continue;
      if (next === ' ' && !b.keepsSpaces) continue;
      out.set(index, false);
    }
  }
  return [...out]
    .map(([at, required]) => ({ at, required }))
    .sort((x, y) => x.at - y.at);
}
