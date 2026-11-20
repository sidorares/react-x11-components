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
}

/** A place a line may break: before the character at `at`. */
export interface BreakAt {
  at: number;
  /** A forced break: a line feed or a paragraph separator ends there. */
  required: boolean;
}

/** A letter, a number or a mark on one: what `break-all` breaks between
 *  and `keep-all` keeps together. Punctuation keeps its own rules. */
const LETTER = /[\p{L}\p{N}\p{M}]/u;

/** Whether any rule moves the places UAX #14 gives. */
export function movesBreaks(rules: readonly BreakRule[]): boolean {
  return rules.some(
    (r) =>
      r.wraps &&
      (r.anywhere || r.wordBreak === 'break-all' || r.wordBreak === 'keep-all'),
  );
}

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
  const breaker = new LineBreaker(text);
  for (let bk = breaker.nextBreak(); bk; bk = breaker.nextBreak()) {
    out.set(bk.position, bk.required);
  }
  // keep-all: no break between two letters it holds
  for (const [at, required] of out) {
    if (required || at <= 0 || at >= text.length) continue;
    const a = ruleAt(at - 1);
    const b = ruleAt(at);
    if (
      a?.wordBreak === 'keep-all' &&
      b?.wordBreak === 'keep-all' &&
      LETTER.test(before(text, at)) &&
      LETTER.test(after(text, at))
    ) {
      out.delete(at);
    }
  }
  // break-all and anywhere: between grapheme clusters
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const { index } of graphemes.segment(text)) {
    if (index <= 0 || out.has(index)) continue;
    const a = ruleAt(index - 1);
    const b = ruleAt(index);
    if (!a || !b || !a.wraps || !b.wraps) continue;
    const prev = before(text, index);
    const next = after(text, index);
    if (a.anywhere && b.anywhere) {
      // a collapsible space a line ends on hangs, so a break before one is
      // the break after it; a line never starts with a line feed
      if (next === ' ' || next === '\n' || prev === '\n') continue;
      out.set(index, false);
    } else if (
      a.wordBreak === 'break-all' &&
      b.wordBreak === 'break-all' &&
      LETTER.test(prev) &&
      LETTER.test(next) &&
      // a mark stays with what it marks
      !/\p{M}/u.test(next)
    ) {
      out.set(index, false);
    }
  }
  return [...out]
    .map(([at, required]) => ({ at, required }))
    .sort((x, y) => x.at - y.at);
}
