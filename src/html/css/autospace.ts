// `text-autospace` and `text-autospace-size` (CSS Text 4, 6.4): where a
// little room goes between ideographs and the letters and numerals of other
// scripts, and how much. Read here in one canonical form, which is what a
// style holds; the room itself is added by `autospaced` in `layout/inline.ts`.

const CLASSES = ['ideograph-alpha', 'ideograph-numeric', 'punctuation'];

/**
 * A `text-autospace` value as it computes: `normal`, `auto` or
 * `no-autospace` alone, or the classes it names in the order CSS Text 4
 * lists them, then `insert` or `replace`. Undefined for anything else.
 */
export function parseTextAutospace(value: string): string | undefined {
  const words = value.trim().toLowerCase().split(/\s+/);
  if (words.length === 1 && /^(?:normal|auto|no-autospace)$/.test(words[0])) {
    return words[0];
  }
  const classes = new Set<string>();
  let mode: string | null = null;
  for (const word of words) {
    if (CLASSES.includes(word)) {
      if (classes.has(word)) return undefined;
      classes.add(word);
    } else if (word === 'insert' || word === 'replace') {
      if (mode !== null) return undefined;
      mode = word;
    } else return undefined;
  }
  if (!classes.size) return undefined;
  const out = CLASSES.filter((c) => classes.has(c));
  if (mode) out.push(mode);
  return out.join(' ');
}

/** What a computed `text-autospace` spaces: an ideograph beside a letter,
 *  and beside a numeral. `normal` and `auto` are both, as Chrome has them. */
export interface AutospaceFlags {
  alpha: boolean;
  numeric: boolean;
}

const BOTH: AutospaceFlags = { alpha: true, numeric: true };
const NEITHER: AutospaceFlags = { alpha: false, numeric: false };
const FLAGS = new Map<string, AutospaceFlags>();

export function autospaceFlags(value: string): AutospaceFlags {
  if (value === 'normal' || value === 'auto') return BOTH;
  if (value === 'no-autospace') return NEITHER;
  let flags = FLAGS.get(value);
  if (!flags) {
    flags = {
      alpha: value.includes('ideograph-alpha'),
      numeric: value.includes('ideograph-numeric'),
    };
    FLAGS.set(value, flags);
  }
  return flags;
}
