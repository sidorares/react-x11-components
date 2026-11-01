// `calc-size()` (CSS Values 5, 9): a size worked out from the one a keyword
// gives a box, or from a length, and how a page reads it. Its text is the
// calculation's tree (`calc-tree.ts`), which keeps what a page wrote the
// shape of — `size + size` stays two terms — and its value is two numbers
// where the calculation is a sum of `size` and lengths, which is what
// layout and an interpolation want, and the calculation itself where a
// function has `size` in it, which layout works out for each size it comes
// to (`sizeAt`).
//
// Blink is the one engine that has this, so what it takes is Blink's: a
// third argument and what follows a calculation that has ended are left,
// as they are there, and a `calc-size()` of `anchor-size()` is refused,
// which is not (docs/components/html.md).

import { HAS_SIZE, serializeCalculation } from './calc-tree.js';
import type { ContentSize, SizeOf } from './style.js';
import { AUTO, isPct, parseLength, splitCommas } from './values.js';
import type { Len, UnitContext } from './values.js';
import { closingParen } from './vars.js';

export const CALC_SIZE = /^\s*calc-size\(/i;

const SIZE_WORD = new RegExp(HAS_SIZE.source, 'gi');

/** The sizes a basis may name, each with what it is as a size. */
const BASIS_KEYWORDS = new Map<string, ContentSize>([
  ['min-content', 'min-content'],
  ['-webkit-min-content', 'min-content'],
  ['max-content', 'max-content'],
  ['-webkit-max-content', 'max-content'],
  ['fit-content', 'fit-content'],
  ['-webkit-fit-content', 'fit-content'],
  ['stretch', 'stretch'],
  ['-webkit-fill-available', 'stretch'],
]);

type Basis = ContentSize | 'auto' | 'content';

/** A `calc-size()` as it was read. */
interface Read {
  /** The size it is worked out from, or null where it needs none. */
  basis: Basis | null;
  /** Its calculation, a basis that needs no box written in for `size`, so
   *  that `size` in it is `basis`'s and a nesting is one calculation. */
  flat: string;
  /** As a page reads it. */
  text: string;
  /** Whether its basis is a percentage, which all of it waits for. */
  percent: boolean;
}

/** A `calc-size()` as a computed style holds it. */
export interface CalcSize {
  /** What `size` is, where it is a keyword's. */
  keyword: ContentSize | 'content' | null;
  /** The length it comes to on every box, where it does. */
  len: Len | null;
  sized: SizeOf;
}

function readCalcSize(
  value: string,
  prop: string,
  dimension: (token: string) => number | null,
  check: UnitContext,
): Read | null {
  const v = value.trim();
  const open = v.indexOf('(') + 1;
  if (closingParen(v, open) !== v.length - 1) return null;
  const [basisText, calculationText] = splitCommas(v.slice(open, -1));
  if (!basisText || !calculationText) return null;
  const calculation = serializeCalculation(calculationText, dimension);
  if (calculation === null) return null;
  const word = basisText.toLowerCase();
  const text = (basis: string) => `calc-size(${basis}, ${calculation})`;
  if (word === 'any') {
    if (HAS_SIZE.test(calculation)) return null;
    return {
      basis: null,
      flat: calculation,
      text: text(word),
      percent: false,
    };
  }
  // `flex-basis` has `content`, and none of the prefixed sizes, and the
  // greatest sizes have no `auto`
  const basisProperty = prop === 'flex-basis';
  const keyword =
    basisProperty && word.startsWith('-') ? null : BASIS_KEYWORDS.get(word);
  if (
    keyword ||
    (word === 'auto' && !prop.startsWith('max-')) ||
    (word === 'content' && basisProperty)
  ) {
    return {
      basis: keyword ?? (word as Basis),
      flat: calculation,
      text: text(word),
      percent: false,
    };
  }
  const flat = (of: string) => calculation.replace(SIZE_WORD, `(${of})`);
  if (CALC_SIZE.test(basisText)) {
    const inner = readCalcSize(basisText, prop, dimension, check);
    if (!inner) return null;
    return { ...inner, flat: flat(inner.flat), text: text(inner.text) };
  }
  const sum = serializeCalculation(basisText, dimension);
  if (sum === null || HAS_SIZE.test(sum) || at(sum, 0, check) === null) {
    return null;
  }
  return {
    basis: null,
    flat: flat(sum),
    text: text(sum),
    percent: sum.includes('%'),
  };
}

/** A calculation at a size in CSS pixels; null where it is no length. */
function at(flat: string, size: number, ctx: UnitContext): Len | null {
  const of = flat.replace(SIZE_WORD, `(${size}px)`);
  const len = parseLength(`calc(${of})`, ctx);
  return len === AUTO ? null : len;
}

/** What a computed value's lengths are worked out with: none are left. */
function pixelsOnly(scale: number): UnitContext {
  return { em: 0, rem: 0, vw: 0, vh: 0, scale };
}

/** A declaration's `calc-size()` as it computes for `prop`; null where the
 *  property does not take it, or it is none. */
export function calcSizeOf(
  value: string,
  prop: string,
  ctx: UnitContext,
): CalcSize | null {
  const { scale } = ctx;
  const units = pixelsOnly(scale);
  const read = readCalcSize(
    value,
    prop,
    (token) => {
      const len = parseLength(token, ctx);
      return typeof len === 'number' ? len / scale : null;
    },
    units,
  );
  if (!read) return null;
  const { flat, percent } = read;
  const none = at(flat, 0, units);
  const some = at(flat, 1000, units);
  if (none === null || some === null) return null;
  const px = (len: Len) =>
    typeof len === 'number' ? len : isPct(len) ? (len.px ?? 0) : 0;
  const sized: SizeOf = /[a-z]\(/i.test(flat)
    ? { size: 1, plus: 0, text: read.text, calc: flat, scale }
    : {
        size: (px(some) - px(none)) / (1000 * scale),
        plus: none,
        text: read.text,
      };
  const tall = prop.endsWith('height');
  const least = prop.startsWith('min-');
  if (!HAS_SIZE.test(flat)) {
    // A percentage of a height that is not there is none here, where
    // `height: 10%` is `auto`, but for one of a basis, which all of it
    // waits for: that is a percentage however the calculation came out
    if (tall && !least && !percent && isPct(none)) {
      return { keyword: null, len: null, sized: { ...sized, size: 0 } };
    }
    const len =
      typeof none !== 'number'
        ? none
        : percent
          ? { pct: 0, px: none }
          : Math.max(0, none);
    return { keyword: null, len, sized };
  }
  // `auto` as a least size is none, but on a flex item, which asks `sized`
  if (read.basis === 'auto') {
    return { keyword: null, len: least ? none : null, sized };
  }
  return { keyword: read.basis, len: null, sized };
}

/** A size past any a box comes to, which stands for an unbounded one. */
const UNBOUNDED = 1e9;

/** What a calculation no sum says comes to at a basis in device pixels:
 *  at an unbounded one, as a shrink-to-fit probe's is, unbounded where it
 *  follows the basis there, and what holds it where it does not. */
export function sizeAt(sized: SizeOf, basis: number): Len {
  const scale = sized.scale!;
  const ctx = pixelsOnly(scale);
  if (Number.isFinite(basis)) return at(sized.calc!, basis / scale, ctx) ?? 0;
  const len = at(sized.calc!, UNBOUNDED, ctx) ?? 0;
  return typeof len === 'number' && len >= UNBOUNDED * scale ? Infinity : len;
}

/** A `calc-size()` as a declaration keeps it, its relative lengths as
 *  they were written; null where `prop` does not take it, or it is none. */
export function calcSizeSpecified(value: string, prop: string): string | null {
  const check = { em: 16, rem: 16, vw: 1, vh: 1, scale: 1 };
  const read = readCalcSize(
    value,
    prop,
    (token) => {
      // an absolute length comes to pixels, which is one whatever the
      // context; a relative one is 16 here or 1 there
      const len = parseLength(token, check);
      const other = parseLength(token, { ...check, em: 1, rem: 1, vw: 2 });
      return typeof len === 'number' && len === other ? len : null;
    },
    check,
  );
  if (!read) return null;
  const { flat } = read;
  if (at(flat, 0, check) === null || at(flat, 1000, check) === null) {
    return null;
  }
  return read.text;
}
