// `text-box-trim`, `text-box-edge` and the `text-box` shorthand (CSS Inline
// 3, 5): which sides of a block container's first and last formatted lines
// are trimmed, and to which of their root inline box's metrics. The values
// are read and written here in one canonical form, which is what a style
// holds; the trimming itself is `trimTextBox` in `layout/block.ts`.

export type TextBoxTrim = 'none' | 'trim-start' | 'trim-end' | 'trim-both';

const TRIMS = new Set(['none', 'trim-start', 'trim-end', 'trim-both']);

/** The keywords an edge's over side may be, and its under side. */
const OVER = new Set(['text', 'ideographic', 'ideographic-ink', 'cap', 'ex']);
const UNDER = new Set(['text', 'ideographic', 'ideographic-ink', 'alphabetic']);

/** A `text-box-trim` value, or undefined for anything else. */
export function parseTextBoxTrim(value: string): TextBoxTrim | undefined {
  const word = value.trim().toLowerCase();
  return TRIMS.has(word) ? (word as TextBoxTrim) : undefined;
}

/**
 * A `text-box-edge` value as it computes: `auto`, or its over edge and its
 * under edge, written as one keyword where one says both — `cap` is `cap
 * text`, as a single `cap` or `ex` takes `text` for its under edge, and
 * `text text` is `text`. Undefined for anything else.
 */
export function parseTextBoxEdge(value: string): string | undefined {
  const words = value.trim().toLowerCase().split(/\s+/);
  if (words.length === 1 && words[0] === 'auto') return 'auto';
  return edgeOf(words);
}

function edgeOf(words: string[]): string | undefined {
  if (words.length === 1) {
    return OVER.has(words[0]) ? words[0] : undefined;
  }
  if (words.length !== 2) return undefined;
  const [over, under] = words;
  if (!OVER.has(over) || !UNDER.has(under)) return undefined;
  return under === impliedUnder(over) ? over : `${over} ${under}`;
}

/** The under edge a single over keyword stands for. */
function impliedUnder(over: string): string {
  return UNDER.has(over) ? over : 'text';
}

/**
 * The `text-box` shorthand: `normal`, which is `none` and `auto`, or a trim
 * and an edge in either order, either left out — a trim left out is
 * `trim-both`, and an edge `auto`. Undefined for anything else.
 */
export function parseTextBox(
  value: string,
): { trim: TextBoxTrim; edge: string } | undefined {
  const words = value.trim().toLowerCase().split(/\s+/);
  if (words.length === 1 && words[0] === 'normal') {
    return { trim: 'none', edge: 'auto' };
  }
  let trim: TextBoxTrim | null = null;
  const rest: string[] = [];
  for (const [i, word] of words.entries()) {
    if (TRIMS.has(word)) {
      // the trim once, before the edge or after all of it
      if (trim !== null || (rest.length > 0 && i < words.length - 1)) {
        return undefined;
      }
      trim = word as TextBoxTrim;
    } else rest.push(word);
  }
  if (trim === null && rest.length === 0) return undefined;
  let edge = 'auto';
  if (rest.length) {
    const read =
      rest.length === 1 && rest[0] === 'auto' ? 'auto' : edgeOf(rest);
    if (read === undefined) return undefined;
    edge = read;
  }
  return { trim: trim ?? 'trim-both', edge };
}

/** The `text-box` shorthand as it serializes from its two longhands. */
export function textBoxText(trim: TextBoxTrim, edge: string): string {
  if (trim === 'none' && edge === 'auto') return 'normal';
  if (edge === 'auto') return trim;
  return trim === 'trim-both' ? edge : `${trim} ${edge}`;
}

/** The metric an edge's over side is trimmed to. `auto` is `text`, as
 *  `line-fit-edge`, which it copies, is `leading` here. */
export function overEdge(
  edge: string,
): 'text' | 'cap' | 'ex' | 'ideographic' | 'ideographic-ink' {
  if (edge === 'auto') return 'text';
  return edge.split(' ')[0] as ReturnType<typeof overEdge>;
}

/** The metric an edge's under side is trimmed to. */
export function underEdge(
  edge: string,
): 'text' | 'alphabetic' | 'ideographic' | 'ideographic-ink' {
  if (edge === 'auto') return 'text';
  const [over, under] = edge.split(' ');
  return (under ?? impliedUnder(over)) as ReturnType<typeof underEdge>;
}
