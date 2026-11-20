// The lists a gap's rule is written with (CSS Gap Decorations 1, 4): a
// comma-separated list of values for each gap in turn, `repeat(n, …)` that
// many times over, and at most one `repeat(auto, …)` that fills the gaps
// the values before and after it leave. And what each gap takes of one.
import { AUTO, parseLength, splitCommas } from './values.js';
import type { Len, UnitContext } from './values.js';

/**
 * A list of a rule's values with its integer repeats expanded: `lead`, the
 * values before an auto repeat, the auto repeat's own and `trail`, those
 * after it. With no auto repeat the gaps take `lead` in turn, over and over.
 */
export interface RuleList<T> {
  lead: readonly T[];
  auto: readonly T[] | null;
  trail: readonly T[];
}

/** An end of a rule moved along its gap (`*-rule-inset-*`): a length or a
 *  percentage of the gap it ends in, or `overlap-join`, written `'join'`. */
export type RuleInset = Len | 'join';

const REPEAT = /^repeat\(\s*([^,]*?)\s*,([\s\S]*)\)$/i;

/**
 * A list of a rule's values, each entry read by `item`; null where any
 * entry is none, a repeat's count is none, or there are two auto repeats.
 */
export function ruleList<T>(
  value: string,
  item: (text: string) => T | null,
): RuleList<T> | null {
  const lead: T[] = [];
  const trail: T[] = [];
  let auto: T[] | null = null;
  for (const entry of splitCommas(value.trim())) {
    const text = entry.trim();
    if (!text) return null;
    const at = auto ? trail : lead;
    const repeat = REPEAT.exec(text);
    if (repeat) {
      const count = repeat[1].toLowerCase();
      const inner: T[] = [];
      for (const part of splitCommas(repeat[2])) {
        const one = part.trim();
        if (!one || /^repeat\(/i.test(one)) return null;
        const v = item(one);
        if (v === null) return null;
        inner.push(v);
      }
      if (!inner.length) return null;
      if (count === 'auto') {
        if (auto) return null;
        auto = inner;
        continue;
      }
      if (!/^\d+$/.test(count) || Number(count) < 1) return null;
      for (let k = 0; k < Number(count); k += 1) at.push(...inner);
      continue;
    }
    const v = item(text);
    if (v === null) return null;
    at.push(v);
  }
  if (!lead.length && !auto) return null;
  return { lead, auto, trail };
}

/** Whether a list is one value and nothing else, which a style keeps as
 *  that value. */
export function single<T>(list: RuleList<T>): boolean {
  return !list.auto && list.lead.length === 1;
}

/** The first value of a list, which is what a style reads it as. */
export function firstOf<T>(list: RuleList<T>): T {
  return list.lead[0] ?? list.auto![0];
}

/** The list each entry's member makes, in the same shape. */
export function mapList<T, U>(list: RuleList<T>, f: (v: T) => U): RuleList<U> {
  return {
    lead: list.lead.map(f),
    auto: list.auto ? list.auto.map(f) : null,
    trail: list.trail.map(f),
  };
}

/**
 * What gap `i` of `n` takes of a list (4.6): with no auto repeat, the list
 * in turn; with one, the values before it for the first gaps, those after
 * it for the last — the first of them, where there are fewer gaps — and
 * the auto repeat's in turn for those between.
 */
export function ruleValue<T>(list: RuleList<T>, i: number, n: number): T {
  const { lead, auto, trail } = list;
  if (!auto) return lead[i % lead.length];
  const leading = Math.min(lead.length, n);
  if (i < leading) return lead[i];
  const trailing = Math.min(trail.length, n - leading);
  const firstTrailing = n - trailing;
  if (i >= firstTrailing) return trail[i - firstTrailing];
  return auto[(i - leading) % auto.length];
}

/** One end's inset: a length or a percentage, or `overlap-join`. */
export function ruleInset(text: string, ctx: UnitContext): RuleInset | null {
  const v = text.trim().toLowerCase();
  if (v === 'overlap-join') return 'join';
  const len = parseLength(text, ctx);
  return len === null || len === AUTO ? null : len;
}
