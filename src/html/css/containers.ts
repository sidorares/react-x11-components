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
import { fallbackMatches } from './anchor.js';
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
  /** Whether it asks `scroll-state()` (CSS Conditional 5, 3.2.6), which
   *  only a scroll-state container answers. */
  scroll?: true;
  /** Whether it asks `anchored()` (CSS Anchor Positioning 2), which only
   *  an anchored container answers. */
  anchored?: true;
}

/** Edges of a box, as the bits a scroll state is made of. */
export const TOP_EDGE = 1;
export const RIGHT_EDGE = 2;
export const BOTTOM_EDGE = 4;
export const LEFT_EDGE = 8;

/**
 * What a scroll-state container's `scroll-state()` queries are answered
 * for, as edges (`TOP_EDGE`…): where a sticky box is stuck — moved by its
 * sticky offsets towards that edge of its scroll container's — where a
 * scroll container can scroll on to, and which way it was scrolled last.
 * `rtl` is its direction, which an inline edge is read in.
 */
export interface ScrollStates {
  stuck: number;
  scrollable: number;
  scrolled: number;
  rtl: boolean;
  /** For an anchored container, the position option it was placed by
   *  (`ANCHOR_FALLBACK`), null for its own: what `anchored(fallback)`
   *  asks, which layout answers as it answers the rest. */
  fallback: string | null;
}

/** A container no layout has placed, or that is nothing of the three. */
export const NO_SCROLL_STATES: ScrollStates = Object.freeze({
  stuck: 0,
  scrollable: 0,
  scrolled: 0,
  rtl: false,
  fallback: null,
});

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
    const m = /^((?:--|-?[_a-zA-Z\u0080-￿])[\w\u0080-￿-]*)(?![\w(-])\s*/.exec(
      text,
    );
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
    let scroll = false;
    let anchored = false;
    let valid = true;
    const read = evaluateCondition(condition, (fn, inner) => {
      if (fn === '') {
        const feature = sizeFeature(inner);
        if (!feature) valid = false;
        else axes |= feature.axes;
      } else if (fn === 'scroll-state') {
        scroll = true;
        if (scrollStateHolds(inner, NO_SCROLL_STATES) === null) valid = false;
      } else if (fn === 'anchored') {
        anchored = true;
        if (anchoredHolds(inner, null) === null) valid = false;
      }
      return undefined;
    });
    if (read === null || !valid) return null;
    out.push({
      name,
      condition,
      axes,
      ...(scroll ? { scroll: true as const } : null),
      ...(anchored ? { anchored: true as const } : null),
    });
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
  scroll: ScrollStates | null = null,
  /** What a style feature compares with, its `var()`s substituted from
   *  the container's custom properties (CSS Conditional 5, 3.3); absent,
   *  as written. */
  value?: (text: string) => string | null,
  /** A custom property's registration, which a style feature compares
   *  its values by. */
  registered: (name: string) => {
    syntax?: string;
    initial: string | null;
  } | null = () => null,
  /** A colour as the container computes it, which a registered colour
   *  is compared as. */
  color: (text: string) => string | null = () => null,
): boolean {
  if (!query.condition) return true;
  const answer = evaluateCondition(query.condition, (fn, inner) => {
    if (fn === 'style') {
      return styleQuery(inner, custom, value, length, registered, color);
    }
    if (fn === 'scroll-state') {
      return scroll
        ? (scrollStateHolds(inner, scroll) ?? undefined)
        : undefined;
    }
    if (fn === 'anchored') {
      return scroll
        ? (anchoredHolds(inner, scroll.fallback) ?? undefined)
        : undefined;
    }
    if (fn !== '') return undefined;
    const feature = sizeFeature(inner);
    if (!feature || !size) return undefined;
    return featureHolds(feature, size, length);
  });
  return answer === true;
}

/**
 * A `scroll-state()` query's answer for a container in `state` (CSS
 * Conditional 5, 3.2.6), or null for one that is none: a feature, or a
 * condition of them in brackets, `not`, `and` and `or`. `stuck` takes an
 * edge, physical or logical, and `scrollable` and `scrolled` an edge or an
 * axis — `x` either side across, `y` either side down — and each in a
 * boolean context is any; `none` is none of them. `snapped`, which no
 * scroll here snaps, is only ever `none`.
 */
export function scrollStateHolds(
  inner: string,
  state: ScrollStates,
): Kleene | null {
  const text = inner.trim();
  const wrapped =
    text.startsWith('(') || /^not\s/i.test(text) ? text : `(${text})`;
  let valid = true;
  const answer = evaluateCondition(wrapped, (fn, feature) => {
    if (fn !== '') {
      valid = false;
      return undefined;
    }
    const held = scrollFeatureHolds(feature, state);
    if (held === null) valid = false;
    return held ?? undefined;
  });
  return valid && answer !== null ? answer : null;
}

/**
 * An `anchored()` query's answer for an anchored container placed by
 * `applied` — an option's text, null for its own — or null for one that is
 * none: `fallback`, with a value or without, or a condition of it in
 * brackets, `not`, `and` and `or` (`fallbackMatches`).
 */
export function anchoredHolds(
  inner: string,
  applied: string | null,
): Kleene | null {
  const text = inner.trim();
  const wrapped =
    text.startsWith('(') || /^not\s/i.test(text) ? text : `(${text})`;
  let valid = true;
  const answer = evaluateCondition(wrapped, (fn, feature) => {
    const m = /^\s*fallback\s*(?::\s*([\s\S]+?)\s*)?$/i.exec(feature);
    if (fn !== '' || !m) {
      valid = false;
      return undefined;
    }
    const held = fallbackMatches(m[1], applied);
    if (held === null) valid = false;
    return held ?? undefined;
  });
  return valid && answer !== null ? answer : null;
}

/** The edges each word of a scroll-state feature names: physical, logical
 *  in a horizontal writing mode, and the two axes. */
function edgesOf(word: string, rtl: boolean, axes: boolean): number | null {
  switch (word) {
    case 'top':
    case 'block-start':
      return TOP_EDGE;
    case 'bottom':
    case 'block-end':
      return BOTTOM_EDGE;
    case 'left':
      return LEFT_EDGE;
    case 'right':
      return RIGHT_EDGE;
    case 'inline-start':
      return rtl ? RIGHT_EDGE : LEFT_EDGE;
    case 'inline-end':
      return rtl ? LEFT_EDGE : RIGHT_EDGE;
  }
  if (!axes) return null;
  if (word === 'x' || word === 'inline') return LEFT_EDGE | RIGHT_EDGE;
  if (word === 'y' || word === 'block') return TOP_EDGE | BOTTOM_EDGE;
  return null;
}

function scrollFeatureHolds(text: string, state: ScrollStates): Kleene | null {
  const m = /^\s*([a-z-]+)\s*(?::\s*([a-z-]+)\s*)?$/i.exec(text);
  if (!m) return null;
  const feature = m[1].toLowerCase();
  const value = m[2]?.toLowerCase();
  if (feature === 'snapped') {
    if (value === undefined) return false;
    if (value === 'none') return true;
    return ['x', 'y', 'block', 'inline', 'both'].includes(value) ? false : null;
  }
  const bits =
    feature === 'stuck'
      ? state.stuck
      : feature === 'scrollable'
        ? state.scrollable
        : feature === 'scrolled'
          ? state.scrolled
          : null;
  if (bits === null) return null;
  if (value === undefined) return bits !== 0;
  if (value === 'none') return bits === 0;
  const edges = edgesOf(value, state.rtl, feature !== 'stuck');
  if (edges === null) return null;
  return (bits & edges) !== 0;
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
