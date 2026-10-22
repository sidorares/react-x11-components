// Scroll-triggered animations (CSS Animation Triggers 1): an animation that
// waits for a trigger, and the timeline triggers that say when — each a
// range of a scroll or view progress timeline, active from when its
// timeline enters its activation range until it leaves its active range.
//
// What is here is the values as the cascade reads them and the arithmetic
// of a range, with no tree and no layout: which element's trigger an
// animation hears, and where its subject is in its scroller, are the
// element's (`HtmlViewNode._evaluateTriggers`), and what an action does to
// an animation's time is the timeline's (`AnimationTimeline.applyTriggers`).

import {
  AUTO,
  parseLength,
  resolve,
  splitCommas,
  splitValue,
} from './values.js';
import type { Len, UnitContext } from './values.js';

/** What an animation does as a trigger it hears activates or deactivates
 *  (`<animation-action>`). */
export type AnimationAction =
  | 'none'
  | 'play'
  | 'play-forwards'
  | 'play-backwards'
  | 'play-once'
  | 'pause'
  | 'reset'
  | 'replay';

const ACTIONS = new Set<string>([
  'none',
  'play',
  'play-forwards',
  'play-backwards',
  'play-once',
  'pause',
  'reset',
  'replay',
]);

/** A trigger an animation hears, by name, and what it does as the trigger
 *  activates and, where there is a second, as it deactivates. */
export interface AnimationTrigger {
  name: string;
  actions: readonly AnimationAction[];
}

/**
 * One entry of `animation-trigger`'s list: null for `none`, which is an
 * animation no trigger holds, and otherwise each trigger it hears with its
 * actions; undefined for anything else.
 */
export function parseAnimationTrigger(
  value: string,
): AnimationTrigger[] | null | undefined {
  const tokens = splitValue(value);
  if (tokens.length === 1 && tokens[0].toLowerCase() === 'none') return null;
  const out: { name: string; actions: AnimationAction[] }[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (token.startsWith('--') && token.length > 2) {
      out.push({ name: token, actions: [] });
    } else if (ACTIONS.has(lower) && out.length) {
      out[out.length - 1].actions.push(lower as AnimationAction);
    } else {
      return undefined;
    }
  }
  if (!out.length || out.some((t) => !t.actions.length)) return undefined;
  return out;
}

/** The axis a timeline runs along. */
export type TimelineAxis = 'block' | 'inline' | 'x' | 'y';

/** Where a timeline trigger's timeline comes from: a view progress
 *  timeline of the element (`view()`, and `auto`), a scroll progress
 *  timeline of a scroller (`scroll()`), or none this reads — `none`, or a
 *  named timeline, which nothing here defines. */
export type TriggerSource =
  | {
      kind: 'view';
      axis: TimelineAxis;
      /** How far in from the scrollport's start and end it is seen. */
      inset: readonly [Len, Len];
    }
  | {
      kind: 'scroll';
      axis: TimelineAxis;
      scroller: 'nearest' | 'root' | 'self';
    }
  | { kind: 'none' };

/** The parts of a view progress timeline a range is named by. */
export type RangeName =
  'cover' | 'contain' | 'entry' | 'exit' | 'entry-crossing' | 'exit-crossing';

const RANGE_NAMES = new Set<string>([
  'cover',
  'contain',
  'entry',
  'exit',
  'entry-crossing',
  'exit-crossing',
]);

/** One end of a range: a distance into a named range, or into the whole
 *  timeline where `name` is null (`normal`, or a length alone). */
export interface RangeEdge {
  name: RangeName | null;
  offset: Len;
}

export const RANGE_START: RangeEdge = { name: null, offset: 0 };
export const RANGE_END: RangeEdge = { name: null, offset: { pct: 100 } };
const START = RANGE_START;
const END = RANGE_END;

/**
 * An element's timeline triggers, each longhand's list as computed: as many
 * as `names` has, the other lists repeating. `active` null is `auto`, the
 * activation range.
 */
export interface TimelineTriggers {
  readonly names: readonly string[];
  readonly sources: readonly TriggerSource[];
  readonly activation: readonly (readonly [RangeEdge, RangeEdge])[];
  readonly active: readonly (readonly [RangeEdge, RangeEdge] | null)[];
}

const VIEW: TriggerSource = { kind: 'view', axis: 'block', inset: [0, 0] };

/** None, which every element without one shares. */
export const NO_TIMELINE_TRIGGERS: TimelineTriggers = {
  names: [],
  sources: [VIEW],
  activation: [[START, END]],
  active: [null],
};

/** One timeline trigger, its lists read at its index. */
export interface TimelineTrigger {
  name: string;
  source: TriggerSource;
  activation: readonly [RangeEdge, RangeEdge];
  active: readonly [RangeEdge, RangeEdge];
}

/** Each of an element's timeline triggers, the last of a name repeated
 *  standing for it. */
export function timelineTriggersOf(t: TimelineTriggers): TimelineTrigger[] {
  const out = new Map<string, TimelineTrigger>();
  t.names.forEach((name, i) => {
    const activation = t.activation[i % t.activation.length];
    out.delete(name);
    out.set(name, {
      name,
      source: t.sources[i % t.sources.length],
      activation,
      active: t.active[i % t.active.length] ?? activation,
    });
  });
  return [...out.values()];
}

/** `timeline-trigger-name`: `none`, or names. */
function parseNames(value: string): string[] | undefined {
  if (/^\s*none\s*$/i.test(value)) return [];
  const names: string[] = [];
  for (const item of splitCommas(value)) {
    const name = item.trim();
    if (!name.startsWith('--') || name.length < 3 || /\s/.test(name)) {
      return undefined;
    }
    names.push(name);
  }
  return names;
}

function axisOf(word: string): TimelineAxis | null {
  const w = word.toLowerCase();
  return w === 'block' || w === 'inline' || w === 'x' || w === 'y' ? w : null;
}

/** One trigger's source: `auto`, `none`, a timeline's name, `view()` or
 *  `scroll()`; undefined for anything else. */
function parseSource(
  value: string,
  ctx: UnitContext,
): TriggerSource | undefined {
  const v = value.trim();
  const lower = v.toLowerCase();
  if (lower === 'auto') return VIEW;
  if (lower === 'none') return { kind: 'none' };
  if (v.startsWith('--') && !/\s/.test(v)) return { kind: 'none' };
  const m = /^(view|scroll)\(([\s\S]*)\)$/i.exec(v);
  if (!m) return undefined;
  const parts = splitValue(m[2].trim());
  if (m[1].toLowerCase() === 'scroll') {
    let axis: TimelineAxis | null = null;
    let scroller: 'nearest' | 'root' | 'self' | null = null;
    for (const part of parts) {
      const p = part.toLowerCase();
      const a = axisOf(p);
      if (a && !axis) axis = a;
      else if ((p === 'nearest' || p === 'root' || p === 'self') && !scroller) {
        scroller = p;
      } else return undefined;
    }
    return {
      kind: 'scroll',
      axis: axis ?? 'block',
      scroller: scroller ?? 'nearest',
    };
  }
  let axis: TimelineAxis | null = null;
  const inset: Len[] = [];
  for (const part of parts) {
    const a = axisOf(part);
    if (a && !axis && !inset.length) {
      axis = a;
      continue;
    }
    if (inset.length === 2) return undefined;
    const len = part.toLowerCase() === 'auto' ? 0 : parseLength(part, ctx);
    if (len === null || len === AUTO) return undefined;
    inset.push(len);
  }
  return {
    kind: 'view',
    axis: axis ?? 'block',
    inset: [inset[0] ?? 0, inset[1] ?? inset[0] ?? 0],
  };
}

/** `timeline-trigger-source`'s list. */
function parseSources(
  value: string,
  ctx: UnitContext,
): TriggerSource[] | undefined {
  const out: TriggerSource[] = [];
  for (const item of splitCommas(value)) {
    const source = parseSource(item, ctx);
    if (!source) return undefined;
    out.push(source);
  }
  return out;
}

/**
 * The edges a range is written with, from `tokens` at `at`: `normal`, a
 * length or a percentage, or a range's name and a length or a percentage
 * into it — 0% where it has none at a start and 100% at an end. Null
 * where none is there.
 */
function readEdge(
  tokens: readonly string[],
  at: number,
  end: boolean,
  ctx: UnitContext,
): { edge: RangeEdge; next: number; named: boolean } | null {
  const token = tokens[at];
  if (token === undefined) return null;
  const lower = token.toLowerCase();
  if (lower === 'normal') {
    return { edge: end ? END : START, next: at + 1, named: false };
  }
  if (RANGE_NAMES.has(lower)) {
    const after = tokens[at + 1];
    const len = after === undefined ? null : parseLength(after, ctx);
    if (len !== null && len !== AUTO) {
      return {
        edge: { name: lower as RangeName, offset: len },
        next: at + 2,
        named: true,
      };
    }
    return {
      edge: { name: lower as RangeName, offset: end ? { pct: 100 } : 0 },
      next: at + 1,
      named: true,
    };
  }
  const len = parseLength(token, ctx);
  if (len === null || len === AUTO) return null;
  return { edge: { name: null, offset: len }, next: at + 1, named: false };
}

/**
 * A range, as `animation-range` writes one: its start, and its end, which
 * where it is left out is the end of the start's named range or the
 * timeline's end. Undefined for anything else.
 */
function parseRange(
  value: string,
  ctx: UnitContext,
): [RangeEdge, RangeEdge] | undefined {
  const tokens = splitValue(value.trim());
  const start = readEdge(tokens, 0, false, ctx);
  if (!start) return undefined;
  const end = readEdge(tokens, start.next, true, ctx);
  if (end) {
    if (end.next !== tokens.length) return undefined;
    return [start.edge, end.edge];
  }
  if (start.next !== tokens.length) return undefined;
  return [
    start.edge,
    start.named ? { name: start.edge.name, offset: { pct: 100 } } : END,
  ];
}

/** `animation-range` (Scroll-driven Animations 1, 5.1): a list of ranges,
 *  each a start and an end; undefined for anything else. */
export function parseAnimationRanges(
  value: string,
  ctx: UnitContext,
): [RangeEdge, RangeEdge][] | undefined {
  const out: [RangeEdge, RangeEdge][] = [];
  for (const item of splitCommas(value)) {
    const range = parseRange(item, ctx);
    if (!range) return undefined;
    out.push(range);
  }
  return out;
}

/** A list of one end of a range (`…-range-start`, `…-range-end`). */
export function parseEdges(
  value: string,
  end: boolean,
  ctx: UnitContext,
): RangeEdge[] | undefined {
  const out: RangeEdge[] = [];
  for (const item of splitCommas(value)) {
    const tokens = splitValue(item.trim());
    const read = readEdge(tokens, 0, end, ctx);
    if (!read || read.next !== tokens.length) return undefined;
    out.push(read.edge);
  }
  return out;
}

/**
 * `timeline-trigger` and its longhands, applied to `t`: the shorthand a
 * list of a name, a source — in either order — and an activation range
 * and an active range after a `/`, each optional; or `none`. Undefined
 * for a value that is none, which leaves the property as it was.
 */
export function applyTimelineTrigger(
  t: TimelineTriggers,
  property: string,
  value: string,
  ctx: UnitContext,
): TimelineTriggers | undefined {
  switch (property) {
    case 'timeline-trigger-name': {
      const names = parseNames(value);
      return names && { ...t, names };
    }
    case 'timeline-trigger-source': {
      const sources = parseSources(value, ctx);
      return sources && { ...t, sources };
    }
    case 'timeline-trigger-activation-range':
    case 'timeline-trigger-active-range':
    case 'timeline-trigger-range': {
      const activation: [RangeEdge, RangeEdge][] = [];
      const active: ([RangeEdge, RangeEdge] | null)[] = [];
      for (const item of splitCommas(value)) {
        const halves = item.split('/');
        if (halves.length > (property === 'timeline-trigger-range' ? 2 : 1)) {
          return undefined;
        }
        const first =
          property === 'timeline-trigger-active-range' &&
          /^\s*auto\s*$/i.test(halves[0])
            ? null
            : parseRange(halves[0], ctx);
        if (first === undefined) return undefined;
        if (property === 'timeline-trigger-active-range') {
          active.push(first);
          continue;
        }
        activation.push(first!);
        if (halves[1] !== undefined) {
          const second = parseRange(halves[1], ctx);
          if (!second) return undefined;
          active.push(second);
        } else active.push(null);
      }
      if (property === 'timeline-trigger-active-range') return { ...t, active };
      if (property === 'timeline-trigger-activation-range') {
        return { ...t, activation };
      }
      return { ...t, activation, active };
    }
    case 'timeline-trigger-activation-range-start':
    case 'timeline-trigger-activation-range-end':
    case 'timeline-trigger-active-range-start':
    case 'timeline-trigger-active-range-end': {
      const end = property.endsWith('-end');
      const activeRange = property.startsWith('timeline-trigger-active-');
      const auto = activeRange && /^\s*auto\s*$/i.test(value);
      const edges = auto ? [] : parseEdges(value, end, ctx);
      if (!edges) return undefined;
      const was = activeRange ? t.active : t.activation;
      const n = Math.max(edges.length, 1);
      const ranges = Array.from({ length: n }, (_, i) => {
        const range =
          was[i % was.length] ?? t.activation[i % t.activation.length];
        const edge = edges[i] ?? (end ? END : START);
        return (end ? [range[0], edge] : [edge, range[1]]) as [
          RangeEdge,
          RangeEdge,
        ];
      });
      if (activeRange) return { ...t, active: auto ? [null] : ranges };
      return { ...t, activation: ranges };
    }
    case 'timeline-trigger': {
      if (/^\s*none\s*$/i.test(value)) return NO_TIMELINE_TRIGGERS;
      const names: string[] = [];
      const sources: TriggerSource[] = [];
      const activation: [RangeEdge, RangeEdge][] = [];
      const active: ([RangeEdge, RangeEdge] | null)[] = [];
      for (const item of splitCommas(value)) {
        const [head, after] = splitRangeHalf(item);
        if (head === null) return undefined;
        const tokens = splitValue(head.trim());
        let name: string | null = null;
        let source: TriggerSource | null = null;
        let at = 0;
        while (at < tokens.length && (name === null || source === null)) {
          const token = tokens[at];
          if (name === null && token.startsWith('--') && token.length > 2) {
            // a second name is the source's, a timeline's
            name = token;
          } else if (source === null) {
            const s = parseSource(token, ctx);
            if (!s) break;
            source = s;
          } else break;
          at += 1;
        }
        if (name === null) return undefined;
        const rest = tokens.slice(at).join(' ');
        const range = rest ? parseRange(rest, ctx) : ([START, END] as const);
        if (!range) return undefined;
        let second: [RangeEdge, RangeEdge] | null = null;
        if (after !== null) {
          const read = parseRange(after, ctx);
          if (!read) return undefined;
          second = read;
        }
        names.push(name);
        sources.push(source ?? VIEW);
        activation.push([range[0], range[1]]);
        active.push(second);
      }
      return { names, sources, activation, active };
    }
  }
  return undefined;
}

/** An item split at a `/` outside parentheses: what is before it, and what
 *  is after, null where there is none. */
function splitRangeHalf(item: string): [string | null, string | null] {
  let depth = 0;
  let at = -1;
  for (let i = 0; i < item.length; i += 1) {
    const c = item[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === '/' && depth === 0) {
      if (at >= 0) return [null, null];
      at = i;
    }
  }
  return at < 0 ? [item, null] : [item.slice(0, at), item.slice(at + 1)];
}

/** `trigger-scope`: `none`, `all`, or the names it scopes. */
export type TriggerScope = 'none' | 'all' | readonly string[];

export function parseTriggerScope(value: string): TriggerScope | undefined {
  const v = value.trim().toLowerCase();
  if (v === 'none' || v === 'all') return v;
  return parseNames(value);
}

/**
 * Where a subject is along a view progress timeline's axis, in the
 * scrollport it is seen in, as the scroll is now: its border box's start
 * and end, and the start and end of the part of the scrollport it is seen
 * through, all from the scrollport's start.
 */
export interface ViewPlace {
  start: number;
  end: number;
  portStart: number;
  portEnd: number;
}

/**
 * How far past where the scroll is now — negative where it is short of it
 * — a scroller has to scroll for its view timeline to be at `edge`, for a
 * subject at `place`: so a range is under way where its start is no more
 * than 0 and its end no less. A range's percentage is of the named range,
 * and a length from its start; `normal` and a length alone are into
 * `cover`, the whole timeline (CSS Scroll-driven Animations 1, 3.2).
 */
export function viewEdgeAt(edge: RangeEdge, place: ViewPlace): number {
  const { start, end, portStart, portEnd } = place;
  // where each of the subject's edges crosses each of the scrollport's
  const enters = start - portEnd;
  const leaves = end - portStart;
  const a = start - portStart;
  const b = end - portEnd;
  let from: number;
  let to: number;
  switch (edge.name ?? 'cover') {
    case 'cover':
      from = enters;
      to = leaves;
      break;
    case 'contain':
      from = Math.min(a, b);
      to = Math.max(a, b);
      break;
    case 'entry':
      from = enters;
      to = Math.min(a, b);
      break;
    case 'exit':
      from = Math.max(a, b);
      to = leaves;
      break;
    case 'entry-crossing':
      from = enters;
      to = b;
      break;
    default:
      from = a;
      to = leaves;
  }
  return from + resolve(edge.offset, to - from);
}

/** Where a scroll progress timeline's range's edge is, as an offset of its
 *  scroller: a percentage of how far it scrolls, a length from its start.
 *  A name is no part of a scroll timeline's range, which is all of it. */
export function scrollEdgeAt(edge: RangeEdge, max: number): number {
  return resolve(edge.offset, max);
}

/**
 * Whether a trigger is active now, from whether it was: an inactive one
 * activates where its timeline is in its activation range, `[a0, a1]`,
 * and an active one stays so while it is in its active range, `[b0, b1]` —
 * each where `at` is, in the same coordinates.
 */
export function triggerActive(
  was: boolean,
  at: number,
  activation: readonly [number, number],
  active: readonly [number, number],
): boolean {
  const [a0, a1] = activation;
  if (!was) return at >= a0 && at <= a1;
  const b0 = Math.min(active[0], a0);
  const b1 = Math.max(active[1], a1);
  return at >= b0 && at <= b1;
}
