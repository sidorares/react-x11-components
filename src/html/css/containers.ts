// Container queries (CSS Conditional 5, 3): a rule under `@container` holds
// for an element where the condition holds of its query container — the
// nearest ancestor that is one, by the name the rule gives if it gives one
// — answered for that container's size, which layout decides, or for its
// custom properties, `style()`.
//
// This module is the query: its prelude read, and its condition answered
// for a container of a size. Which container that is, and the sizes layout
// came to, are the cascade's (`Cascade._containersHold`) and the
// renderer's (`HtmlViewNode._containersMoved`).

import { compare, evaluateCondition, styleQuery } from './conditions.js';
import type { Kleene } from './conditions.js';

/** One query of an `@container` rule's list: the container's name, if it
 *  gives one, and the condition, as written. */
export interface ContainerQuery {
  name: string | null;
  condition: string;
  /** The axes its size features read (`INLINE_AXIS`, `BLOCK_AXIS`): a
   *  container whose type does not size them cannot answer it, and the
   *  next one out is asked. None for a query of `style()` alone, which
   *  any element answers. */
  axes: number;
}

/** A size feature of the inline axis: `width`, `inline-size`. */
export const INLINE_AXIS = 1;
/** …of the block axis: `height`, `block-size`; `aspect-ratio` and
 *  `orientation` read both. */
export const BLOCK_AXIS = 2;

/** A container's content box, in device pixels. */
export interface ContainerSize {
  width: number;
  height: number;
}

/**
 * An `@container` rule's prelude as its queries, any one of which holding
 * is enough (CSS Conditional 5, 3.1): each a name, a condition, or a name
 * and a condition. Null where it is none — a condition that does not read
 * as one, or a name a container cannot have — and the rule is dropped.
 */
export function parseContainerPrelude(
  prelude: string,
): ContainerQuery[] | null {
  const out: ContainerQuery[] = [];
  for (const part of splitTopLevel(prelude, ',')) {
    const text = part.trim();
    if (!text) return null;
    const m = /^(-?[_a-zA-Z\u0080-￿][\w\u0080-￿-]*)(?![\w(-])\s*/.exec(text);
    let name: string | null = null;
    let condition = text;
    if (m && !/^(?:not|and|or)$/i.test(m[1])) {
      if (!validName(m[1])) return null;
      name = m[1];
      condition = text.slice(m[0].length);
    }
    if (!condition) {
      // a name alone: a container of that name holds it
      if (name === null) return null;
      out.push({ name, condition: '', axes: 0 });
      continue;
    }
    let axes = 0;
    let valid = true;
    const read = evaluateCondition(condition, (fn, inner) => {
      if (fn === '') {
        const feature = sizeFeature(inner);
        if (!feature) valid = false;
        else axes |= feature.axes;
      }
      return undefined;
    });
    if (read === null || !valid) return null;
    out.push({ name, condition, axes });
  }
  return out.length ? out : null;
}

/** A `container-name`'s name: no CSS-wide keyword, and none of the words a
 *  query is made of. */
export function validName(name: string): boolean {
  return !/^(?:none|and|or|not|initial|inherit|unset|revert|revert-layer|default)$/i.test(
    name,
  );
}

/**
 * Whether a query holds of a container (CSS Conditional 5, 3.2): of its
 * content box, `size` — null where layout has not said, and a size feature
 * is unknown — and of its custom properties, `custom`. `length` reads a
 * value as device pixels, a relative one against the container's font, as
 * a query's lengths are (3.2); null for one that is none.
 */
export function containerHolds(
  query: ContainerQuery,
  size: ContainerSize | null,
  custom: (name: string) => string | undefined,
  length: (value: string) => number | null,
): boolean {
  if (!query.condition) return true;
  const answer = evaluateCondition(query.condition, (fn, inner) => {
    if (fn === 'style') return styleQuery(inner, custom);
    if (fn !== '') return undefined;
    const feature = sizeFeature(inner);
    if (!feature || !size) return undefined;
    return featureHolds(feature, size, length);
  });
  return answer === true;
}

/** A size feature read: which feature, and the comparisons it makes of
 *  it, each `feature op value`. */
interface SizeFeature {
  feature: string;
  checks: [string, string][];
  axes: number;
}

const FEATURES: Record<string, number> = {
  width: INLINE_AXIS,
  'inline-size': INLINE_AXIS,
  height: BLOCK_AXIS,
  'block-size': BLOCK_AXIS,
  'aspect-ratio': INLINE_AXIS | BLOCK_AXIS,
  orientation: INLINE_AXIS | BLOCK_AXIS,
};

const FEATURE_CACHE = new Map<string, SizeFeature | null>();

/** What is in a feature's brackets: `width`, `min-width: 30em`, `width >
 *  400px`, `400px < width <= 800px`. Null for anything else. */
function sizeFeature(inner: string): SizeFeature | null {
  let hit = FEATURE_CACHE.get(inner);
  if (hit === undefined) {
    hit = readFeature(inner.trim());
    if (FEATURE_CACHE.size > 512) FEATURE_CACHE.clear();
    FEATURE_CACHE.set(inner, hit);
  }
  return hit;
}

function readFeature(text: string): SizeFeature | null {
  const known = (name: string): string | null =>
    FEATURES[name.toLowerCase()] !== undefined ? name.toLowerCase() : null;
  // `width`, a feature in a boolean context
  if (/^[a-z-]+$/i.test(text)) {
    const feature = known(text);
    return feature ? { feature, checks: [], axes: FEATURES[feature] } : null;
  }
  // `min-width: 30em`, `width: 300px`, `orientation: landscape`
  const plain = /^([a-z-]+)\s*:\s*([\s\S]+)$/i.exec(text);
  if (plain) {
    const prefixed = /^(min|max)-(.*)$/i.exec(plain[1]);
    const feature = known(prefixed ? prefixed[2] : plain[1]);
    if (!feature) return null;
    if (prefixed && feature === 'orientation') return null;
    const op = !prefixed
      ? '='
      : prefixed[1].toLowerCase() === 'min'
        ? '>='
        : '<=';
    return {
      feature,
      checks: [[op, plain[2].trim()]],
      axes: FEATURES[feature],
    };
  }
  // a range: `width > 400px`, `400px < width`, `400px <= width < 50em`
  const parts = text.split(/(<=|>=|<|>|=)/).map((part) => part.trim());
  if (parts.length !== 3 && parts.length !== 5) return null;
  const at = parts.findIndex((part, i) => i % 2 === 0 && known(part));
  if (at < 0) return null;
  const feature = known(parts[at])!;
  if (feature === 'orientation') return null;
  const flip: Record<string, string> = {
    '<': '>',
    '<=': '>=',
    '>': '<',
    '>=': '<=',
    '=': '=',
  };
  const checks: [string, string][] = [];
  if (parts.length === 3) {
    if (at === 0) checks.push([parts[1], parts[2]]);
    else checks.push([flip[parts[1]], parts[0]]);
  } else {
    // `a < width < b`, both one way
    if (at !== 2) return null;
    const down = parts[1].startsWith('>');
    if (down !== parts[3].startsWith('>') || parts[1] === '=') return null;
    if (parts[3] === '=') return null;
    checks.push([flip[parts[1]], parts[0]], [parts[3], parts[4]]);
  }
  return { feature, checks, axes: FEATURES[feature] };
}

function featureHolds(
  { feature, checks }: SizeFeature,
  size: ContainerSize,
  length: (value: string) => number | null,
): Kleene {
  if (feature === 'orientation') {
    const value = checks[0]?.[1].toLowerCase();
    // a square is portrait (Media Queries 4, 4.5)
    if (value === 'portrait') return size.height >= size.width;
    if (value === 'landscape') return size.width > size.height;
    return checks.length ? undefined : true;
  }
  const value =
    feature === 'aspect-ratio'
      ? size.height > 0
        ? size.width / size.height
        : Infinity
      : feature === 'width' || feature === 'inline-size'
        ? size.width
        : size.height;
  // in a boolean context, whether it is anything but nought
  if (!checks.length) return value !== 0;
  for (const [op, text] of checks) {
    const against = feature === 'aspect-ratio' ? ratioOf(text) : length(text);
    if (against === null) return undefined;
    if (!compare(value, op, against)) return false;
  }
  return true;
}

/** A ratio, `16/9` or `16 / 9` or `1.5`; null for anything else. */
function ratioOf(text: string): number | null {
  const m = /^\s*(\d*\.?\d+)\s*(?:\/\s*(\d*\.?\d+)\s*)?$/.exec(text);
  if (!m) return null;
  const ratio = Number(m[1]) / (m[2] === undefined ? 1 : Number(m[2]));
  return Number.isFinite(ratio) ? ratio : null;
}

/** `text` cut at each `sep` outside brackets and strings. */
function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') {
      i += 1;
    } else if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      i = end < 0 ? text.length : end;
    } else if (c === '(' || c === '[') {
      depth += 1;
    } else if (c === ')' || c === ']') {
      depth -= 1;
    } else if (c === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}
