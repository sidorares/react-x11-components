// `text-wrap: pretty` (CSS Text 4, 6.2), as Chrome breaks a paragraph's
// lines for it.
//
// CSS asks for a layout better than the greedy one and leaves how to the
// user agent, so the one to match is Blink's `ScoreLineBreaker`
// (`third_party/blink/renderer/core/layout/inline/score_line_breaker.cc`,
// Chrome 117 on), which is Android Minikin's optimal line breaker run over
// the end of a paragraph. What it does, and so what this does:
//
// - It reconsiders the last four lines of a paragraph — of a block, or of
//   the part of one a forced break ends — and none of the lines before.
// - Only where the greedy lines end on a short line of one word: under a
//   third of the line's width, with no place to break inside it. Every
//   other paragraph keeps the lines `auto` gave it, which is most of them,
//   and is why this costs next to nothing where it changes nothing: one
//   comparison a line, and the text of a short last line read.
// - Every place a line may break in those lines is a candidate, and the
//   breaks chosen are the ones that score least, as Minikin scores them: a
//   line's slack squared, a penalty for each line, and ten thousand more
//   for breaking before the paragraph's last word — counted once where the
//   line before it ends, and four times again as where the last line
//   starts.
// - It keeps the number of lines the greedy breaking made. Where the best
//   breaks make another number, the greedy ones stand.
// - A paragraph a line overflowed in — a word wider than its line, or one
//   cut to fit — is left as it is: Blink turns the score off for it.
//
// What is left out, and why. Blink also scores a paragraph whose last two
// lines before its last both end in a hyphen; this renderer hyphenates no
// word, so it never has one. And a soft hyphen a line breaks at draws no
// hyphen here, so a break there is scored without one's width.
//
// The scoring is pure and asks the text engine nothing but how wide the
// pieces between the places to break are (`PrettyMeasure`), so it is
// answered with no display. The places themselves are UAX #14's, from the
// `linebreak` package — the breaker ntk breaks every line with, and the
// one react-x11's CoreText engine measures a paragraph's least width with
// — so this breaks where the engines would, and is no third opinion.

import LineBreaker from 'linebreak';

import type { TextRun } from '../../richtext/index.js';

/** Blink's `kMaxLinesForOptimal`: the most lines at a paragraph's end it
 *  reconsiders. */
const PRETTY_LINES = 4;

/** `kShortLineDenominator`: a last line is short under a third of its
 *  room. */
const SHORT_LINE = 3;

/** `kMinCandidates`: with fewer places to break in the lines than this
 *  there is nothing worth choosing between. */
const MIN_CANDIDATES = 3;

/** `kOrphansPenalty`, on the last place to break before the paragraph's
 *  end. */
const ORPHANS_PENALTY = 10000;

/** `kLastLinePenaltyMultiplier`: how many times over the last line counts
 *  the penalty of the place it starts at. */
const LAST_LINE_PENALTY = 4;

/** `kScoreOverfull`: what a line wider than its room scores. */
const OVERFULL = 1e12;

/** `LayoutUnit::Epsilon()`: how far past its room Blink lets a line's
 *  content reach and still fit it (`AvailableWidthToFit`). */
const FIT = 1 / 64;

/** A greedy line, as the scoring reads it: where its text starts and ends
 *  in the paragraph's, in code units, and how wide it is. */
export interface PrettyLine {
  start: number;
  end: number;
  width: number;
}

/** What the scoring needs of the block. */
export interface PrettySetting {
  /** The room each line has. */
  width: number;
  /** The block's font size: a line's penalty is in proportion to it. */
  fontSize: number;
  /** `text-align: justify`, under which a line costs nothing and a break
   *  after a hyphen less (`SetupParameters`). */
  justified: boolean;
  /** Device pixels to a CSS pixel. The lengths are device ones, and so is
   *  Blink's zoom, which scales every score alike — so the same breaks
   *  win at any display scale. */
  zoom: number;
  /** Whether a word may be cut to fit its line (`overflow-wrap`): a line
   *  ending inside one then shows it was. */
  cuts: boolean;
}

/** How far along the text each of `offsets` is — ascending code units, the
 *  first the lines' start and the last their end — on one line, from the
 *  first: what Blink reads off the shaped text, kerning and all. Null
 *  where the engine could not say. */
export type PrettyMeasure = (offsets: readonly number[]) => number[] | null;

/** Whether a line after the first is short enough to be a paragraph's
 *  last that is scored: Blink's first test, and all that most paragraphs
 *  are asked — before their text is read. */
export function endsShort(
  lines: readonly { width: number }[],
  width: number,
): boolean {
  for (let i = 1; i < lines.length; i += 1) {
    if (shortLine(lines[i].width, width)) return true;
  }
  return false;
}

/** Whether a line is short enough to be a paragraph's last that is
 *  scored (`kShortLineDenominator`). */
export function shortLine(width: number, room: number): boolean {
  return width < room / SHORT_LINE;
}

/**
 * The code units to make line separators so that the lines break as
 * `text-wrap: pretty` breaks them, each a space a line ends on: none
 * where it changes no line. `lines` are a layout's greedy lines of
 * `text`, `runs` its runs.
 */
export function prettyBreaks(
  text: string,
  runs: readonly TextRun[],
  lines: readonly PrettyLine[],
  setting: PrettySetting,
  measure: PrettyMeasure,
): number[] | null {
  const held = noWrapGroups(runs);
  let out: number[] | null = null;
  for (let last = 1; last < lines.length; last += 1) {
    if (!shortLine(lines[last].width, setting.width)) continue;
    // the last line of a paragraph: the text's, or one a forced break ends
    if (last < lines.length - 1 && !forcedBefore(text, lines[last + 1].start)) {
      continue;
    }
    let first = last;
    while (first > 0 && !forcedBefore(text, lines[first].start)) first -= 1;
    if (first === last) continue;
    const breaks = paragraphBreaks(
      text,
      held,
      lines,
      first,
      last,
      setting,
      measure,
    );
    if (breaks) (out ??= []).push(...breaks);
  }
  return out;
}

/** Whether a line starts after a forced break. */
function forcedBefore(text: string, at: number): boolean {
  return at > 0 && text.charCodeAt(at - 1) === 10;
}

/**
 * The separators for one paragraph, its lines `first` to `last`: Blink's
 * `OptimalBreakPoints` and `ShouldOptimize`, over the lines it would have
 * in its list as it reached the paragraph's end.
 */
function paragraphBreaks(
  text: string,
  held: NoWrapGroups | null,
  lines: readonly PrettyLine[],
  first: number,
  last: number,
  setting: PrettySetting,
  measure: PrettyMeasure,
): number[] | null {
  const { width } = setting;
  const end = contentEnd(text, lines[last].start, lines[last].end);
  // a last line of one word: one with a place to break in it is left
  // (`CanBreakInside`) — and one with a space between two letters or
  // digits has one (UAX #14, LB18), which is most, and is left unasked
  if (spacedWords(text, lines[last].start, end)) return null;
  const inLast = breaksIn(text, held, lines[last].start, end);
  if (inLast === null || inLast.length) return null;
  for (let i = first; i <= last; i += 1) {
    if (lines[i].width > width + FIT) return null;
  }
  const from = Math.max(first, last - PRETTY_LINES + 1);
  const start = lines[from].start;
  // A line ending inside a word was cut to fit, which only a paragraph
  // whose words may be cut can have — so only there are its lines before
  // the four read for one. A word that may not be cut overflows its line.
  const checked = setting.cuts ? first : from;
  const places = breaksIn(text, held, lines[checked].start, end);
  if (places === null) return null;
  for (let i = checked + 1; i <= last; i += 1) {
    if (!sortedHas(places, lines[i].start)) return null;
  }
  const inside: number[] = [];
  for (const at of places) if (at > start) inside.push(at);
  if (inside.length < MIN_CANDIDATES) return null;

  const candidates = candidatesOf(text, start, inside, end, setting, measure);
  if (!candidates) return null;
  const chosen = bestBreaks(candidates, setting);
  // as many lines as the greedy breaking made, or that breaking stands
  if (chosen.length !== last - from + 1) return null;
  const separators: number[] = [];
  for (let k = 0; k + 1 < chosen.length; k += 1) {
    const at = candidates[chosen[k]].at;
    // a line that starts and ends where it did is made again as it was
    const started =
      k === 0 || candidates[chosen[k - 1]].at === lines[from + k].start;
    if (started && at === lines[from + k + 1].start) continue;
    // A break is made where it is asked for by a line separator in place
    // of the space the line ends on, as long as the space. A place to
    // break that is no space — after a hyphen, between two ideographs —
    // has none to take, and the engine would break where it likes.
    const c = text.charCodeAt(at - 1);
    if (c !== 0x20 && c !== 0x200b) return null;
    separators.push(at - 1);
  }
  return separators.length ? separators : null;
}

/** A place a line may break, scored as Blink scores it: `at` is the code
 *  unit after it, `noBreak` how far along the text it is where the line
 *  runs on through it, `ifBreak` where a line it ends ends — its spaces
 *  left off — and `penalty` what breaking there costs. */
interface Candidate {
  at: number;
  noBreak: number;
  ifBreak: number;
  penalty: number;
  hyphen: boolean;
}

/**
 * The candidates from `start` to `end`, the places to break between them
 * `inside` (`ComputeCandidates`): the first and the last are the lines'
 * ends, and the penalties are `SetupParameters`' and the orphans'.
 */
function candidatesOf(
  text: string,
  start: number,
  inside: readonly number[],
  end: number,
  setting: PrettySetting,
  measure: PrettyMeasure,
): Candidate[] | null {
  const bounds = [start, ...inside, end];
  // where the text before each place to break ends but for its spaces
  const inks = bounds.map((at, k) =>
    k ? contentEnd(text, bounds[k - 1], at) : at,
  );
  // both, the two ends of every line that could be made, measured at once
  const offsets: number[] = [];
  for (let k = 0; k < bounds.length; k += 1) {
    for (const at of [inks[k], bounds[k]]) {
      if (!offsets.length || at > offsets[offsets.length - 1]) {
        offsets.push(at);
      }
    }
  }
  const measured = measure(offsets);
  if (!measured || measured.length !== offsets.length) return null;
  const along = new Map<number, number>();
  offsets.forEach((at, i) => along.set(at, measured[i]));
  const { hyphen: hyphenPenalty } = penaltiesOf(setting);
  const candidates: Candidate[] = [];
  for (let k = 0; k < bounds.length; k += 1) {
    const ink = inks[k];
    const hyphen = k > 0 && text.charCodeAt(ink - 1) === 0xad;
    candidates.push({
      at: bounds[k],
      noBreak: along.get(bounds[k])!,
      ifBreak: along.get(ink)!,
      penalty: hyphen ? hyphenPenalty : 0,
      hyphen,
    });
  }
  // The orphans' penalty, on the last place to break before the end, and
  // on each before it while they end in a hyphen
  for (let i = candidates.length - 2; i >= 0; i -= 1) {
    candidates[i].penalty += ORPHANS_PENALTY * setting.zoom;
    if (!candidates[i].hyphen) break;
  }
  return candidates;
}

/** Minikin's `computePenalties`, as Blink sets them up: a break after a
 *  hyphen, and a line, each in proportion to the room and the font size —
 *  both zoomed, and so unzoomed once. */
function penaltiesOf(setting: PrettySetting): { hyphen: number; line: number } {
  const { width, fontSize, justified, zoom } = setting;
  const widthTimesSize = (Math.max(0, width) * fontSize) / zoom;
  return justified
    ? { hyphen: widthTimesSize / 2, line: 0 }
    : { hyphen: widthTimesSize * 2, line: widthTimesSize * 4 };
}

/**
 * The candidates the lines end at, the end's included, that score least
 * (`ComputeScores`, `ComputeBreakPoints`). Each candidate's score is the
 * best of a line ending there from any before it: the line's slack
 * squared where it is not the last, four times its start's penalty where
 * it is, and an overfull line all but ruled out — plus the end's penalty
 * and the line's. `active` is the first start whose line still fits, and
 * `hope` the least a later start can add, which is what keeps the search
 * from going back over the whole text for every end.
 */
function bestBreaks(c: readonly Candidate[], setting: PrettySetting): number[] {
  const { width, justified, zoom } = setting;
  const linePenalty = penaltiesOf(setting).line;
  const room = width + FIT;
  const n = c.length;
  const score = new Float64Array(n);
  const prev = new Int32Array(n);
  let active = 0;
  for (let end = 1; end < n; end += 1) {
    const last = end === n - 1;
    const edge = c[end].ifBreak - room;
    let best = Infinity;
    let bestPrev = 0;
    let hope = 0;
    for (let start = active; start < end; start += 1) {
      const from = score[start];
      if (from + hope >= best) continue;
      const delta = c[start].noBreak - edge;
      let fit = 0;
      let extra = 0;
      if ((last || !justified) && delta < 0) fit = OVERFULL;
      else if (last) extra = LAST_LINE_PENALTY * c[start].penalty;
      else if (delta < 0) fit = OVERFULL;
      else fit = (delta * delta) / zoom;
      if (delta < 0) active = start + 1;
      else hope = fit;
      const total = from + fit + extra;
      if (total <= best) {
        best = total;
        bestPrev = start;
      }
    }
    score[end] = best + c[end].penalty + linePenalty;
    prev[end] = bestPrev;
  }
  const out: number[] = [];
  for (let i = n - 1; i > 0; i = prev[i]) out.push(i);
  return out.reverse();
}

/** Whether a space stands between two ASCII letters or digits in
 *  `[from, to)`: a place a line may break, whatever else is around. */
export function spacedWords(text: string, from: number, to: number): boolean {
  for (let at = text.indexOf(' ', from + 1); at > 0 && at < to - 1;) {
    if (alnum(text.charCodeAt(at - 1)) && alnum(text.charCodeAt(at + 1))) {
      return true;
    }
    at = text.indexOf(' ', at + 1);
  }
  return false;
}

function alnum(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a)
  );
}

/** Where a line's text ends but for the white space it ends on: the
 *  spaces a break takes, and the line feed that forces one. */
function contentEnd(text: string, from: number, to: number): number {
  let end = to;
  while (end > from) {
    const c = text.charCodeAt(end - 1);
    if (c !== 0x20 && c !== 10) break;
    end -= 1;
  }
  return end;
}

/**
 * The places a line may break inside `(from, to)` of the text, in order:
 * UAX #14's, and none between two characters of one `nowrap` element's
 * text, which ntk keeps together. Null where a break is forced in there —
 * a line separator the text spells out — which no paragraph scored here
 * has inside it.
 */
function breaksIn(
  text: string,
  held: NoWrapGroups | null,
  from: number,
  to: number,
): number[] | null {
  const out: number[] = [];
  if (to - from < 2) return out;
  const breaker = new LineBreaker(text.slice(from, to));
  for (let bk = breaker.nextBreak(); bk; bk = breaker.nextBreak()) {
    const at = from + bk.position;
    if (at >= to) break;
    if (bk.required) return null;
    if (held?.holds(at)) continue;
    if (!asciiBreaks(text, at)) continue;
    out.push(at);
  }
  return out;
}

/**
 * Whether Blink breaks between two printable ASCII characters where UAX #14
 * lets a line break: its own table decides those, not ICU's rules
 * (`LineBreakData::FillAscii`, kept from WebKit for what other browsers
 * did) — after a hyphen or a question mark, and before an opening bracket
 * after punctuation, and nowhere else. So `and/or` and a URL do not break
 * at their slashes in Chrome, where UAX #14 breaks them; and the scoring
 * offers no break Chrome would not make. Everything else is UAX #14's.
 */
function asciiBreaks(text: string, at: number): boolean {
  const a = text.charCodeAt(at - 1);
  const b = text.charCodeAt(at);
  if (a < 0x21 || a > 0x7e || b < 0x21 || b > 0x7e) return true;
  // what no break follows, and what none comes before
  if (NO_BREAK_AFTER.test(text[at - 1]) || NO_BREAK_BEFORE.test(text[at])) {
    return false;
  }
  if (a === 0x2d) {
    // a hyphen before a digit is a minus sign but between two numbers or
    // words: `ABCD-1234` and `1234-5678` break, `-5` does not
    if (b >= 0x30 && b <= 0x39) {
      return at >= 2 && /[0-9A-Za-z]/.test(text[at - 2]);
    }
    return b !== 0x24;
  }
  if (a === 0x3f) return b !== 0x22 && b !== 0x27;
  return b === 0x28 || b === 0x3c || b === 0x5b || b === 0x7b;
}

/** Blink's printable ASCII that no break follows: letters, digits, the
 *  backtick and `$ ' ( / < @ [ ^ _ {`. */
const NO_BREAK_AFTER = /[$'(/0-9<@A-Z[^_`a-z{]/;

/** And that none comes before: `!),./:;?]}`. */
const NO_BREAK_BEFORE = /[!),./:;?\]}]/;

/** Whether a sorted list holds a number. */
function sortedHas(list: readonly number[], value: number): boolean {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] === value) return true;
    if (list[mid] < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** Where the runs of `nowrap` elements are, to ask whether a break falls
 *  inside one's text. */
interface NoWrapGroups {
  holds(at: number): boolean;
}

function noWrapGroups(runs: readonly TextRun[]): NoWrapGroups | null {
  if (!runs.some((run) => run.nowrap)) return null;
  const starts: number[] = [];
  let at = 0;
  for (const run of runs) {
    starts.push(at);
    at += run.text.length;
  }
  const groupAt = (offset: number): unknown => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return runs[lo].nowrap;
  };
  return {
    holds(offset) {
      const before = groupAt(offset - 1);
      return !!before && before === groupAt(offset);
    },
  };
}
