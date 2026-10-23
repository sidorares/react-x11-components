// Text fragments (WICG Scroll To Text Fragment, and HTML's "fragment
// directive"): a URL whose fragment holds `:~:text=…` names text in the
// document rather than an element. It is what Google's results and a
// browser's "copy link to highlight" hand out, so it arrives with every
// kind of page. The document finds the text, paints it in `::target-text`
// and says where it is (`HtmlViewNode.indicatedPart`); the directive itself
// is no part of the document's URL, so `location.hash` and `:target` read
// the fragment without it.
//
// What is matched is the text the document draws (`BoxTree.text`), as
// Chrome's find buffer is, rather than the DOM's data, which the spec
// reads: white space collapsed, a `text-transform` applied, a line break
// a space. A term is matched within one block, case and accents aside
// (the spec's "primary level" of UTS #10), on word boundaries where the
// directive asks for them. Pure but for the box tree it reads.
import type { Box, BoxTree } from './layout/boxes.js';

/** What a fragment's directive starts after (HTML 7.4.2.3.4). */
export const FRAGMENT_DIRECTIVE_DELIMITER = ':~:';

/**
 * A URL's fragment split at its fragment directive: the part before it,
 * which names an element as any fragment does, and the directive after
 * it, or null where it has none.
 */
export function splitFragment(fragment: string): {
  fragment: string;
  directive: string | null;
} {
  const at = fragment.indexOf(FRAGMENT_DIRECTIVE_DELIMITER);
  if (at < 0) return { fragment, directive: null };
  return {
    fragment: fragment.slice(0, at),
    directive: fragment.slice(at + FRAGMENT_DIRECTIVE_DELIMITER.length),
  };
}

/**
 * A URL with its fragment directive taken out, as a document's URL has it
 * (HTML, "remove the fragment directive"): `#sec:~:text=a` is `#sec`, and
 * `#:~:text=a` an empty fragment, `#`. A URL with no directive is itself.
 */
export function withoutFragmentDirective(url: string): string {
  const hash = url.indexOf('#');
  if (hash < 0) return url;
  const { fragment, directive } = splitFragment(url.slice(hash + 1));
  return directive === null ? url : `${url.slice(0, hash + 1)}${fragment}`;
}

/** A parsed `text=` directive: the text to find, from `start` to `end`
 *  where it has an end, between a `prefix` and a `suffix` where it says. */
export interface TextDirective {
  prefix: string | null;
  start: string;
  end: string | null;
  suffix: string | null;
}

/**
 * The `text=` directives of a fragment directive, in the order written: it
 * is a list of directives joined by `&`, and those of another kind, or
 * that do not parse, are passed over.
 */
export function parseTextDirectives(directive: string): TextDirective[] {
  const out: TextDirective[] = [];
  for (const part of directive.split('&')) {
    if (!part.startsWith('text=')) continue;
    const parsed = parseTextDirective(part.slice(5));
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * A `text=` directive's value (`[prefix-,]start[,end][,-suffix]`), each
 * term percent-decoded, or null where it is none: no terms, an empty one,
 * or more than four.
 */
export function parseTextDirective(value: string): TextDirective | null {
  const tokens = value.split(',');
  if (tokens.length < 1 || tokens.length > 4) return null;
  if (tokens.some((t) => t === '')) return null;
  let prefix: string | null = null;
  let suffix: string | null = null;
  if (tokens[0].endsWith('-')) {
    prefix = percentDecode(tokens.shift()!.slice(0, -1));
  }
  const last = tokens[tokens.length - 1];
  if (last !== undefined && last.startsWith('-')) {
    suffix = percentDecode(tokens.pop()!.slice(1));
  }
  if (tokens.length !== 1 && tokens.length !== 2) return null;
  const start = percentDecode(tokens[0]);
  const end = tokens.length === 2 ? percentDecode(tokens[1]) : null;
  // a term that was only a dash, or decodes to nothing, finds nothing
  if (!start || prefix === '' || suffix === '' || end === '') return null;
  return { prefix, start, end, suffix };
}

/** URL percent-decoding, read as UTF-8: a sequence that is no UTF-8 is
 *  left as written, as `%zz` is. */
function percentDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

// --- the text searched ---------------------------------------------------

/** A block's text, folded as a query is: what one term is matched in. */
interface Run {
  /** Its text with case and marks folded away and white space one space. */
  folded: string;
  /** Where in the document's text each unit of `folded` came from: the
   *  first unit of its character, and the unit after its last. */
  from: Int32Array;
  to: Int32Array;
  /** Where a word starts or ends in `folded`, made when first asked. */
  bounds: Uint8Array | null;
}

/** The document's text as text directives are matched in it: each block's
 *  run of text, in document order. */
export interface SearchText {
  runs: Run[];
}

/** Whether a code unit is white space, a line break or a no-break space. */
const isSpace = (c: number): boolean =>
  c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x3000;

/** A character as matching compares it: lower case, its marks taken
 *  off. Empty for a mark alone, which goes with what it marks. */
function fold(char: string): string {
  if (char.length === 1) {
    const c = char.charCodeAt(0);
    if (c < 128) return c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : char;
  }
  let out = FOLDED.get(char);
  if (out === undefined) {
    out = char.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    FOLDED.set(char, out);
  }
  return out;
}

/** What each character past ASCII folds to, as it was first folded. */
const FOLDED = new Map<string, string>();

/** A query folded as the text it is matched in is. */
export function foldQuery(query: string): string {
  let out = '';
  for (const char of query) {
    const c = char.charCodeAt(0);
    if (isSpace(c)) {
      if (!out.endsWith(' ')) out += ' ';
      continue;
    }
    out += fold(char);
  }
  return out;
}

/** The box a text box's text is a block of: its nearest container that is
 *  block-level — not an inline box, and not an inline-block, whose text
 *  runs on with the line's, as the spec's "block-level display" has it. */
function blockOf(box: Box): Box | null {
  let at = box.parent;
  while (
    at &&
    (at.kind === 'inline' || at.style.display.startsWith('inline'))
  ) {
    at = at.parent;
  }
  return at;
}

/**
 * The text of a box tree as directives are matched in it: a run a block,
 * of the text that came from the document's text nodes and is visible —
 * not generated content, and none under `visibility: hidden` — where a
 * line break between two pieces of a block is a space.
 */
export function searchTextOf(tree: BoxTree): SearchText {
  const text = tree.text;
  const covered = new Uint8Array(text.length);
  for (const s of tree.textNodes ?? []) {
    covered.fill(1, s.start, Math.min(s.end, text.length));
  }
  const runs: Run[] = [];
  // the run's text a piece at a time, joined once: a string grown a
  // character at a time and asked how it ends is flattened at every ask
  let pieces: string[] = [];
  let spaced = false;
  let from: number[] = [];
  let to: number[] = [];
  let block: Box | null | undefined;
  let last = -1;
  const finish = () => {
    if (from.length) {
      runs.push({
        folded: pieces.join(''),
        from: Int32Array.from(from),
        to: Int32Array.from(to),
        bounds: null,
      });
    }
    pieces = [];
    spaced = false;
    from = [];
    to = [];
  };
  const space = (at: number, end: number) => {
    if (spaced) {
      to[to.length - 1] = end;
      return;
    }
    pieces.push(' ');
    spaced = true;
    from.push(at);
    to.push(end);
  };
  for (const box of tree.textBoxes) {
    if (box.style.visibility !== 'visible') continue;
    const container = blockOf(box);
    if (container !== block) {
      finish();
      block = container;
      last = -1;
    }
    const start = box.textStart;
    const end = Math.min(box.textEnd, text.length);
    // what is between this piece and the last of the block: a `<br>`'s
    // line feed is a space, generated content nothing
    if (last >= 0 && last < start && /\s/.test(text.slice(last, start))) {
      space(last, start);
    }
    for (let i = start; i < end;) {
      const code = text.codePointAt(i)!;
      const width = code > 0xffff ? 2 : 1;
      if (covered[i]) {
        if (isSpace(code)) space(i, i + width);
        else {
          const out = fold(text.slice(i, i + width));
          if (!out && to.length) to[to.length - 1] = i + width;
          for (let k = 0; k < out.length; k += 1) {
            from.push(i);
            to.push(i + width);
          }
          if (out) {
            pieces.push(out);
            spaced = false;
          }
        }
      }
      i += width;
    }
    last = end;
  }
  finish();
  return { runs };
}

type SegmenterLike = {
  segment(text: string): Iterable<{ index: number; segment: string }>;
};

let segmenter: SegmenterLike | null | undefined;

/** Where words start and end in a run's folded text (UAX #29, through
 *  `Intl.Segmenter` where the runtime has one). */
function boundsOf(run: Run): Uint8Array {
  if (run.bounds) return run.bounds;
  const text = run.folded;
  const bounds = new Uint8Array(text.length + 1);
  bounds[0] = 1;
  bounds[text.length] = 1;
  if (segmenter === undefined) {
    const Segmenter = (
      Intl as unknown as {
        Segmenter?: new (
          locale: string | undefined,
          options: { granularity: 'word' },
        ) => SegmenterLike;
      }
    ).Segmenter;
    segmenter = Segmenter
      ? new Segmenter(undefined, { granularity: 'word' })
      : null;
  }
  if (segmenter) {
    for (const { index, segment } of segmenter.segment(text)) {
      bounds[index] = 1;
      bounds[index + segment.length] = 1;
    }
  } else {
    const word = (c: string) => /[\p{L}\p{N}_]/u.test(c);
    for (let i = 1; i < text.length; i += 1) {
      if (word(text[i - 1]) !== word(text[i]) || !word(text[i])) bounds[i] = 1;
    }
  }
  run.bounds = bounds;
  return bounds;
}

/** A match: the code units of the document's text it covers. */
export type TextMatch = [start: number, end: number];

/** The first index in a run whose character starts at or after `unit`. */
function indexAt(run: Run, unit: number): number {
  let lo = 0;
  let hi = run.from.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (run.from[mid] < unit) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The first run that holds text at or after `unit`. */
function runAt(text: SearchText, unit: number): number {
  let lo = 0;
  let hi = text.runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const run = text.runs[mid];
    if (run.to[run.to.length - 1] <= unit) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Whether a match from folded `i` to `j` in a run is bounded as asked. */
function bounded(
  run: Run,
  i: number,
  j: number,
  startBounded: boolean,
  endBounded: boolean,
): boolean {
  if (!startBounded && !endBounded) return true;
  const bounds = boundsOf(run);
  return (!startBounded || !!bounds[i]) && (!endBounded || !!bounds[j]);
}

/**
 * The first match of a folded query that starts at or after `from` and
 * ends by `to`, in document units, within one block (the spec's "find a
 * string in range"); null for none.
 */
function findIn(
  text: SearchText,
  query: string,
  from: number,
  to: number,
  startBounded: boolean,
  endBounded: boolean,
): TextMatch | null {
  const first = runAt(text, from);
  for (let r = first; r < text.runs.length; r += 1) {
    const run = text.runs[r];
    if (run.from[0] >= to) return null;
    let at = r === first ? indexAt(run, from) : 0;
    for (;;) {
      const i = run.folded.indexOf(query, at);
      if (i < 0) break;
      const j = i + query.length;
      const end = run.to[j - 1];
      if (end > to) return null;
      if (bounded(run, i, j, startBounded, endBounded)) {
        return [run.from[i], end];
      }
      at = i + 1;
    }
  }
  return null;
}

/**
 * Whether a folded query is matched right at `unit` — the first character
 * of text there — within one block, ending by `to`; the match, or null.
 */
function matchAt(
  text: SearchText,
  query: string,
  unit: number,
  to: number,
  endBounded: boolean,
): TextMatch | null {
  const r = runAt(text, unit);
  const run = text.runs[r];
  if (!run) return null;
  const i = indexAt(run, unit);
  if (i >= run.from.length || run.from[i] !== unit) return null;
  if (!run.folded.startsWith(query, i)) return null;
  const j = i + query.length;
  const end = run.to[j - 1];
  if (end > to || !bounded(run, i, j, false, endBounded)) return null;
  return [unit, end];
}

/** The first unit at or after `unit` of text that is no white space, or
 *  null where there is none (the spec's "next non-whitespace position"):
 *  across blocks, and past what is not searched. */
function nextNonSpace(text: SearchText, unit: number): number | null {
  for (let r = runAt(text, unit); r < text.runs.length; r += 1) {
    const run = text.runs[r];
    for (let i = indexAt(run, unit); i < run.folded.length; i += 1) {
      if (run.folded.charCodeAt(i) !== 32) return run.from[i];
    }
  }
  return null;
}

/** Whether a folded query is found anywhere: a term that is not ends the
 *  search at once, where the steps would go on to the end. */
function anywhere(text: SearchText, query: string): boolean {
  return text.runs.some((run) => run.folded.includes(query));
}

/**
 * Where a text directive's text is in the document, in code units of its
 * text, or null where it is nowhere (the spec's "find a range from a text
 * directive"): the first place its start is, preceded by its prefix and
 * followed by its suffix, with only white space between, each where the
 * directive asks, and on to the first place its end is after that.
 */
export function findTextDirective(
  text: SearchText,
  directive: TextDirective,
): TextMatch | null {
  const start = foldQuery(directive.start);
  const end = directive.end === null ? null : foldQuery(directive.end);
  const prefix = directive.prefix === null ? null : foldQuery(directive.prefix);
  const suffix = directive.suffix === null ? null : foldQuery(directive.suffix);
  if (!start.trim() || end === ' ' || prefix === ' ' || suffix === ' ') {
    return null;
  }
  for (const q of [start, end, prefix, suffix]) {
    if (q !== null && !anywhere(text, q)) return null;
  }
  const last = text.runs[text.runs.length - 1];
  if (!last) return null;
  const docEnd = last.to[last.to.length - 1];
  // where the search goes on from, the spec's search range's start
  let from = 0;
  const startEndsAtWord = end !== null || suffix === null;
  while (from < docEnd) {
    let match: TextMatch | null;
    if (prefix !== null) {
      const found = findIn(text, prefix, from, docEnd, true, false);
      if (!found) return null;
      from = found[0] + 1;
      const after = nextNonSpace(text, found[1]);
      if (after === null) return null;
      match = matchAt(text, start, after, docEnd, startEndsAtWord);
      if (!match) continue;
    } else {
      match = findIn(text, start, from, docEnd, true, startEndsAtWord);
      if (!match) return null;
      from = match[0] + 1;
    }
    // on to its end, and its suffix right after: where the suffix is not
    // there, the next place the end is, or with no end the next start
    let endFrom = match[1];
    for (;;) {
      if (end !== null) {
        if (endFrom >= docEnd) return null;
        const found = findIn(text, end, endFrom, docEnd, true, suffix === null);
        if (!found) return null;
        match = [match[0], found[1]];
      }
      if (suffix === null) return match;
      const after = nextNonSpace(text, match[1]);
      if (after === null) return null;
      if (matchAt(text, suffix, after, docEnd, true)) return match;
      if (end === null) break;
      endFrom = match[1];
    }
  }
  return null;
}
