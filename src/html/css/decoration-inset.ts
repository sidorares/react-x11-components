// `text-decoration-inset` (CSS Text Decoration 4, 2.6): how far in from a
// decorating box's start and end the lines it sets begin and end. Read here
// and not in `style.ts`, since `el.style`'s check of a value
// (`specified.ts`) reads it too; drawn by `insetOf` in `paint.ts`.

import { AUTO, parseLength, splitValue } from './values.js';
import type { Len, UnitContext } from './values.js';

/** The initial value, shared: nothing in at either end. */
export const NO_DECORATION_INSET: readonly [Len, Len] = [0, 0];

/** `auto` as it computes: still `auto`, read back as itself, with the
 *  length it comes to where it runs between it and a length, worked out from
 *  the element's rule thickness (`autoInset`). */
export interface AutoInset {
  auto: number;
}

/** Whether an inset is `auto`. */
export function isAutoInset(
  inset: readonly [Len, Len] | AutoInset,
): inset is AutoInset {
  return !Array.isArray(inset);
}

/**
 * The length `auto` comes to: half the rule's thickness, one CSS pixel at
 * the least and two at most, which is what Chrome draws and what its
 * computed value is in the middle of an animation to a length — 1px at 10px
 * and at 16px, and 2px for a rule four pixels thick or more.
 */
export function autoInsetLength(thickness: number, scale: number): number {
  return Math.min(Math.max(thickness / 2, scale), 2 * scale);
}

/** `auto`, with the length it comes to for a rule `thickness` thick. */
export function autoInset(thickness: number, scale: number): AutoInset {
  return { auto: autoInsetLength(thickness, scale) };
}

let insetsSeen = false;

/**
 * The value: `auto`, or one or two lengths or percentages, the start's and
 * the end's, one for both; undefined for anything else. A value with an
 * inset in it notes so (`decorationInsetsSeen`).
 */
export function parseDecorationInset(
  value: string,
  ctx: UnitContext,
): readonly [Len, Len] | 'auto' | undefined {
  const parts = splitValue(value.trim());
  if (parts.length === 1 && parts[0].toLowerCase() === 'auto') {
    insetsSeen = true;
    return 'auto';
  }
  if (!parts.length || parts.length > 2) return undefined;
  const lens: Len[] = [];
  for (const part of parts) {
    const len = parseLength(part, ctx);
    if (len === null || len === AUTO) return undefined;
    lens.push(len);
  }
  const [start, end = start] = lens;
  if (start === 0 && end === 0) return NO_DECORATION_INSET;
  insetsSeen = true;
  return [start, end];
}

/** Whether any value this process read had an inset in it: until one has,
 *  paint draws every rule as it always did and asks no rule whose it is. */
export function decorationInsetsSeen(): boolean {
  return insetsSeen;
}
