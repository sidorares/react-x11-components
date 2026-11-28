// How much of a text's start has its UAX #9 levels whatever comes after it.
//
// The line at a time lays the rest of a paragraph out for each line of it
// (`linesOf`), and a text engine resolves the levels of all it is handed: a
// paragraph of 100 KB that any of it can reverse was resolved a thousand
// times over, and prepared as often, for the first line of each. The engine
// is handed the start of the rest instead (`startOf`), where what it makes of
// that start's first lines is what it makes of them in the whole. Pure, and
// asserted against bidi-js (`test/html/settled.test.ts`).
import { bidiJs, bidiText } from '../direction.js';

/** The paragraph separators, which bidi resolves nothing across. */
const PARAGRAPH_END = /[\n\r\u001c-\u001e\u0085\u2029]/;

/** What opens and closes an explicit embedding, override or isolate. */
const CONTROL = /[\u202a-\u202e\u2066-\u2069]/;

/** As many brackets as may be open at once, past which UAX #9 pairs no more
 *  of a paragraph (BD16). */
const OPEN_BRACKETS = 63;

/** More controls open at once than this and nothing is said of a text: the
 *  depth UAX #9 stops counting them at is past it. */
const OPEN_CONTROLS = 60;

/** A bracket: where it is in its text, and whether it opens a pair. */
interface Bracket {
  at: number;
  char: string;
  opens: boolean;
}

/** A text's brackets, in its order, and whether it holds an explicit
 *  control: what `settledLevels` reads of it, found once. */
export interface SettledText {
  text: string;
  explicit: boolean;
  brackets: Bracket[];
}

/** Every bracket is punctuation or a symbol past the letters, or one of the
 *  six of ASCII: the rest is not asked about. */
const MAY_BRACKET =
  /[()[\]{}]|[\u0f3a-\u0f3d\u1680-\u169f\u2000-\u303f\ufe00-\uffff]/g;

export function settledText(text: string): SettledText {
  const js = bidiJs();
  const brackets: Bracket[] = [];
  for (const { 0: char, index } of text.matchAll(MAY_BRACKET)) {
    const opens = js.openingToClosingBracket(char) !== null;
    if (opens || js.closingToOpeningBracket(char) !== null) {
      brackets.push({ at: index, char, opens });
    }
  }
  // over the stand-ins its levels are resolved with (`bidiText`), so a
  // right-to-left letter of the planes is one here too
  return { text: bidiText(text), explicit: CONTROL.test(text), brackets };
}

/** Whether two brackets pair, the second of them closing (BD16), canonical
 *  equivalents among them. */
function pair(open: string, close: string): boolean {
  const js = bidiJs();
  const opposite = js.closingToOpeningBracket(close);
  if (open === opposite) return true;
  const closes = js.getCanonicalBracket(close);
  if (closes && js.closingToOpeningBracket(closes) === open) return true;
  const opened = js.getCanonicalBracket(open);
  return opened !== null && js.openingToClosingBracket(opened) === close;
}

/**
 * How many characters from `from` have, in `from` to `cut` resolved alone,
 * the levels they have in `from` to `to` resolved alone, at the least: as
 * far as the last letter (or paragraph's end) there that nothing after the
 * cut can be seen past.
 *
 * A letter's direction is its own, and what is before it looks no further
 * forward than it (W4, W5, N1, N2). What can is a bracket, which is paired
 * with its closing one wherever that is (N0), and an isolate or an embedding
 * open at the letter: so it is a letter outside every one of those, with
 * every pair opened before it closed before the cut.
 */
export function settledLevels(
  settled: SettledText,
  from: number,
  cut: number,
  to: number,
): number {
  const { text } = settled;
  const inside: [number, number][] = [];
  const limit = settled.explicit
    ? openBefore(settled, from, cut, inside)
    : pairedAcross(settled, from, cut, to);
  const js = bidiJs();
  let span = inside.length - 1;
  for (let at = limit - 1; at >= from; at -= 1) {
    while (span >= 0 && inside[span][0] > at) span -= 1;
    if (span >= 0 && at <= inside[span][1]) {
      at = inside[span][0];
      continue;
    }
    switch (js.getBidiCharTypeName(text[at])) {
      case 'L': {
        // half a pair is L to bidi-js, whatever the pair is
        const c = text.charCodeAt(at);
        if (c >= 0xd800 && c < 0xe000) continue;
        return at - from + 1;
      }
      case 'R':
      case 'AL':
      case 'B':
        return at - from + 1;
    }
  }
  return 0;
}

/** The first bracket from `from` that is paired with one at `cut` or past
 *  it, or the cut: a text with no explicit control is one sequence a
 *  paragraph, so its brackets are paired here as bidi-js pairs them. */
function pairedAcross(
  { text, brackets }: SettledText,
  from: number,
  cut: number,
  to: number,
): number {
  let lo = 0;
  let hi = brackets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (brackets[mid].at < from) lo = mid + 1;
    else hi = mid;
  }
  let limit = cut;
  let open: Bracket[] = [];
  /** Where the paragraph the brackets are in ends, once one is open. */
  let end = -1;
  let full = false;
  for (let k = lo; k < brackets.length && brackets[k].at < to; k += 1) {
    const bracket = brackets[k];
    if (end < bracket.at) {
      // in a paragraph of its own
      if (bracket.at >= cut) break;
      open = [];
      full = false;
      end = paragraphEnd(text, bracket.at, to);
    }
    if (full) continue;
    if (bracket.opens) {
      if (open.length < OPEN_BRACKETS) open.push(bracket);
      else full = true;
      continue;
    }
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (!pair(open[i].char, bracket.char)) continue;
      if (bracket.at >= cut) limit = Math.min(limit, open[i].at);
      open.length = i;
      break;
    }
    // none is left that was open at the cut
    if (bracket.at >= cut && !(open.length && open[0].at < limit)) break;
  }
  return limit;
}

function paragraphEnd(text: string, from: number, to: number): number {
  for (let at = from; at < to; at += 1) {
    if (PARAGRAPH_END.test(text[at])) return at;
  }
  return to;
}

/**
 * The first control or bracket between `from` and the cut that is open at
 * the cut, or may be, or the cut; and the stretches inside a control that
 * was closed, for a letter in one is in a sequence of its own. Where the
 * brackets of which sequence pair is not worked out: one that closes no more
 * than the last opened may leave any of those open before it.
 */
function openBefore(
  { text }: SettledText,
  from: number,
  cut: number,
  inside: [number, number][],
): number {
  const js = bidiJs();
  let controls: { at: number; isolate: boolean }[] = [];
  let open: Bracket[] = [];
  for (let at = from; at < cut; at += 1) {
    const char = text[at];
    if (PARAGRAPH_END.test(char)) {
      if (controls.length) inside.push([controls[0].at, at - 1]);
      controls = [];
      open = [];
    } else if (CONTROL.test(char)) {
      const before = controls.length ? controls[0].at : -1;
      const c = char.charCodeAt(0);
      if (c === 0x2069) {
        let k = controls.length - 1;
        while (k >= 0 && !controls[k].isolate) k -= 1;
        if (k >= 0) controls.length = k;
      } else if (c === 0x202c) {
        const last = controls[controls.length - 1];
        if (last && !last.isolate) controls.pop();
      } else {
        if (controls.length >= OPEN_CONTROLS) return from;
        controls.push({ at, isolate: c >= 0x2066 });
      }
      if (before >= 0 && !controls.length) inside.push([before, at]);
    } else if (!controls.length) {
      if (js.openingToClosingBracket(char) !== null) {
        open.push({ at, char, opens: true });
      } else if (open.length && js.closingToOpeningBracket(char) !== null) {
        if (pair(open[open.length - 1].char, char)) open.pop();
      }
    }
  }
  return Math.min(controls[0]?.at ?? cut, open[0]?.at ?? cut);
}
