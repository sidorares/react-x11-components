// The grid track sizing algorithm (CSS Grid 1, 11.3 to 11.8), the same for
// a grid's columns and for its rows: arithmetic over each track's sizing
// functions and what each item in the tracks contributes, with no layout in
// it. `css-grid.ts` measures the items and resolves the percentages; this
// decides what the tracks come to.
//
// A track keeps a base size, which only grows, and a growth limit, the most
// it wants. The items in one track alone set both (11.5.2); an item that
// spans several shares what it needs past their sizes out among the ones
// its sizing functions let grow — equally, as far as each one's limit, and
// past the limits only to the ones sized by their content — a span at a
// time, the fewest first (11.5.3), and the items that cross an `fr` track
// out to those alone, by their factors (11.5.4). The free space then grows
// every track equally towards its limit (11.6), the `fr` tracks share what
// is left by their factors (11.7), and the `auto` ones stretch into what
// remains (11.8).

/** A track's least size: a length, or its content's. */
export type TrackMin = number | 'min-content' | 'max-content' | 'auto';

/** A track's greatest size: a length, its content's, a share of the space
 *  left, or its content's no larger than `fit-content()`'s argument. */
export type TrackMax =
  | number
  | 'min-content'
  | 'max-content'
  | 'auto'
  | { fr: number }
  | { fit: number };

export interface SizingTrack {
  min: TrackMin;
  max: TrackMax;
}

/** An item's place along the axis, and its margin box's size at its
 *  narrowest, at its widest, and the least it can be (the "minimum
 *  contribution"), each asked for only when a track needs it. */
export interface TrackItem {
  start: number;
  span: number;
  minContent(): number;
  maxContent(): number;
  minimum(): number;
}

export interface TrackSpace {
  /**
   * The grid's content size along the axis: `Infinity` where it has none
   * and is as large as its tracks want to be (a max-content constraint),
   * 0 where it is as small as they can be (a min-content one).
   */
  available: number;
  /** A least content size where `available` is infinite — a grid's
   *  `min-height` — which its `fr` and `auto` tracks fill. */
  least: number;
  gap: number;
  /** Whether the `auto` tracks stretch into the space left, as a content
   *  distribution of `normal` or `stretch` has them. */
  stretch: boolean;
}

const EPS = 1e-6;

const frOf = (max: TrackMax): number | null =>
  typeof max === 'object' && 'fr' in max ? max.fr : null;
const fitOf = (max: TrackMax): number | null =>
  typeof max === 'object' && 'fit' in max ? max.fit : null;
/** A maximum its content sizes: `min-content`, `max-content`, `auto` and
 *  `fit-content()`. */
const intrinsicMax = (max: TrackMax): boolean =>
  typeof max === 'string' || fitOf(max) !== null;
/** A maximum its content's widest sizes, which `auto` is as a maximum. */
const maxContentMax = (max: TrackMax): boolean =>
  max === 'max-content' || max === 'auto' || fitOf(max) !== null;

/** The largest of what the items say, and no less than nothing. */
function most(items: TrackItem[], size: (item: TrackItem) => number): number {
  let out = 0;
  for (const item of items) out = Math.max(out, size(item));
  return out;
}

const minContentOf = (item: TrackItem) => item.minContent();
const maxContentOf = (item: TrackItem) => item.maxContent();
const minimumOf = (item: TrackItem) => item.minimum();

/**
 * Share `room` out equally among `list`, freezing each track as its share
 * reaches its headroom, and growing the rest on: what each gets is added to
 * `inc`. Answers what is left once every track is frozen.
 */
function share(
  room: number,
  list: number[],
  headroom: (track: number) => number,
  inc: number[],
): number {
  let open = list.filter((t) => headroom(t) - inc[t] > EPS);
  while (room > EPS && open.length) {
    let step = room / open.length;
    for (const t of open) step = Math.min(step, headroom(t) - inc[t]);
    for (const t of open) inc[t] += step;
    room -= step * open.length;
    open = open.filter((t) => headroom(t) - inc[t] > EPS);
  }
  return room;
}

/**
 * The tracks' sizes, in order. An item past the last track is not counted,
 * and one that runs past it is counted in the tracks it is in.
 */
export function sizeTracks(
  tracks: readonly SizingTrack[],
  items: readonly TrackItem[],
  space: TrackSpace,
): number[] {
  const n = tracks.length;
  const { gap } = space;
  const base: number[] = new Array<number>(n);
  const limit: number[] = new Array<number>(n);
  // 11.4: a track with a length for a minimum starts at it, and one with a
  // length for a maximum stops at it
  for (let t = 0; t < n; t += 1) {
    const { min, max } = tracks[t];
    base[t] = typeof min === 'number' ? min : 0;
    limit[t] = typeof max === 'number' ? Math.max(max, base[t]) : Infinity;
  }

  const alone: TrackItem[][] = [];
  const spans = new Map<number, TrackItem[]>();
  const flexing: TrackItem[] = [];
  for (const item of items) {
    if (item.start >= n || item.span < 1) continue;
    const end = Math.min(n, item.start + item.span);
    let flexible = false;
    for (let t = item.start; t < end; t += 1) {
      if (frOf(tracks[t].max) !== null) flexible = true;
    }
    if (flexible) flexing.push(item);
    else if (end - item.start === 1) (alone[item.start] ??= []).push(item);
    else {
      const group = spans.get(end - item.start);
      if (group) group.push(item);
      else spans.set(end - item.start, [item]);
    }
  }

  // 11.5.2: the items in one track alone, which is not an `fr` one
  for (let t = 0; t < n; t += 1) {
    const list = alone[t];
    if (!list) continue;
    const { min, max } = tracks[t];
    if (min === 'min-content')
      base[t] = Math.max(base[t], most(list, minContentOf));
    else if (min === 'max-content') {
      base[t] = Math.max(base[t], most(list, maxContentOf));
    } else if (min === 'auto')
      base[t] = Math.max(base[t], most(list, minimumOf));
    const fit = fitOf(max);
    if (max === 'min-content') limit[t] = most(list, minContentOf);
    else if (max === 'max-content' || max === 'auto') {
      limit[t] = most(list, maxContentOf);
    } else if (fit !== null) limit[t] = Math.min(fit, most(list, maxContentOf));
    if (limit[t] < base[t]) limit[t] = base[t];
  }

  // a growth limit counts as its base size while it is infinite
  const sizeOf = (t: number, limits: boolean): number =>
    limits && Number.isFinite(limit[t]) ? limit[t] : base[t];
  // a growth limit set in the step before, from infinite, grows on freely
  const growable: boolean[] = new Array<boolean>(n).fill(false);
  const planned: number[] = new Array<number>(n).fill(0);
  const inc: number[] = new Array<number>(n).fill(0);
  const affected: number[] = [];

  /**
   * 11.5.1: grow the base sizes, or the growth limits, of the tracks
   * `affects` picks by what the items need past the sizes of all the
   * tracks they span — each track by the most any one item asks of it.
   * `past` names the tracks that take what is left once the others reach
   * their limits: those whose maximums are content's (`intrinsic`), whose
   * maximums are their content's widest (`max-content`), or all of them.
   */
  const grow = (
    group: TrackItem[],
    limits: boolean,
    affects: (t: number) => boolean,
    size: (item: TrackItem) => number,
    past: 'intrinsic' | 'max-content' | 'all',
    flexible: boolean,
    fitted = false,
  ): void => {
    planned.fill(0);
    for (const item of group) {
      const end = Math.min(n, item.start + item.span);
      affected.length = 0;
      let taken = gap * (end - item.start - 1);
      for (let t = item.start; t < end; t += 1) {
        taken += sizeOf(t, limits);
        if (affects(t)) affected.push(t);
      }
      if (!affected.length) continue;
      let room = size(item) - taken;
      if (!(room > EPS)) continue;
      for (const t of affected) inc[t] = 0;
      if (flexible) {
        // across `fr` tracks, by their factors — the rest of the room
        // equally where the factors come to less than one
        let factors = 0;
        for (const t of affected) factors += frOf(tracks[t].max)!;
        for (const t of affected) {
          const fr = frOf(tracks[t].max)!;
          inc[t] =
            factors >= 1
              ? (room * fr) / factors
              : room * fr + (room * (1 - factors)) / affected.length;
        }
      } else {
        // equally, as far as each track's limit: a base size's is its
        // growth limit, or `fit-content()`'s argument; a growth limit's is
        // itself, but where it is infinite or has just stopped being
        room = share(
          room,
          affected,
          (t) => {
            const fit = fitOf(tracks[t].max);
            let cap: number;
            if (!limits)
              cap = fit === null ? limit[t] : Math.min(limit[t], fit);
            else {
              cap =
                growable[t] || !Number.isFinite(limit[t]) ? Infinity : limit[t];
              if (fitted && fit !== null) cap = Math.min(cap, fit);
            }
            return cap - sizeOf(t, limits);
          },
          inc,
        );
        if (room > EPS) {
          // and past the limits, to the tracks whose maximums let them
          let beyond = affected.slice();
          if (past !== 'all') {
            const kind = past === 'intrinsic' ? intrinsicMax : maxContentMax;
            const picked = beyond.filter((t) => kind(tracks[t].max));
            if (picked.length) beyond = picked;
          }
          share(
            room,
            beyond,
            (t) => {
              const fit = fitOf(tracks[t].max);
              return fitted && fit !== null
                ? fit - sizeOf(t, limits)
                : Infinity;
            },
            inc,
          );
        }
      }
      for (const t of affected) if (inc[t] > planned[t]) planned[t] = inc[t];
    }
    for (let t = 0; t < n; t += 1) {
      if (!(planned[t] > 0)) continue;
      if (limits) limit[t] = sizeOf(t, true) + planned[t];
      else base[t] += planned[t];
    }
  };

  /** 11.5.3 and 11.5.4, for one group of items. */
  const accommodate = (group: TrackItem[], flexible: boolean): void => {
    // an item crossing an `fr` track grows the `fr` tracks alone
    const may = (t: number) => !flexible || frOf(tracks[t].max) !== null;
    grow(
      group,
      false,
      (t) => may(t) && typeof tracks[t].min !== 'number',
      minimumOf,
      'intrinsic',
      flexible,
    );
    grow(
      group,
      false,
      (t) =>
        may(t) &&
        (tracks[t].min === 'min-content' || tracks[t].min === 'max-content'),
      minContentOf,
      'intrinsic',
      flexible,
    );
    grow(
      group,
      false,
      (t) => may(t) && tracks[t].min === 'max-content',
      maxContentOf,
      'max-content',
      flexible,
    );
    for (let t = 0; t < n; t += 1) if (limit[t] < base[t]) limit[t] = base[t];
    // an `fr` track's maximum is not its content's
    if (flexible) return;
    const infinite = limit.map((l) => !Number.isFinite(l));
    grow(
      group,
      true,
      (t) => intrinsicMax(tracks[t].max),
      minContentOf,
      'all',
      false,
    );
    for (let t = 0; t < n; t += 1) {
      growable[t] = infinite[t] && Number.isFinite(limit[t]);
    }
    grow(
      group,
      true,
      (t) => maxContentMax(tracks[t].max),
      maxContentOf,
      'all',
      false,
      true,
    );
    growable.fill(false);
  };

  for (const s of [...spans.keys()].sort((a, b) => a - b)) {
    accommodate(spans.get(s)!, false);
  }
  if (flexing.length) accommodate(flexing, true);
  for (let t = 0; t < n; t += 1) {
    if (!Number.isFinite(limit[t])) limit[t] = base[t];
  }

  const used = (): number => {
    let sum = gap * Math.max(0, n - 1);
    for (let t = 0; t < n; t += 1) sum += base[t];
    return sum;
  };

  // 11.6: the free space grows every track equally towards its limit, and
  // with no end to it, all the way
  if (!Number.isFinite(space.available)) {
    for (let t = 0; t < n; t += 1) base[t] = Math.max(base[t], limit[t]);
  } else {
    const free = space.available - used();
    if (free > EPS) {
      inc.fill(0);
      const all = tracks.map((_, t) => t);
      share(free, all, (t) => limit[t] - base[t], inc);
      for (let t = 0; t < n; t += 1) base[t] += inc[t];
    }
  }

  // 11.7: the `fr` tracks, at what one `fr` comes to
  const flex: number[] = [];
  for (let t = 0; t < n; t += 1) if (frOf(tracks[t].max) !== null) flex.push(t);
  if (flex.length) {
    /** 11.7.1: what an `fr` is worth filling `fill` with `list`, found
     *  again without any `fr` track its base size is more than its share. */
    const frSize = (list: number[], fill: number): number => {
      const flexible = new Set(
        list.filter((t) => frOf(tracks[t].max) !== null),
      );
      for (;;) {
        let leftover = fill - gap * Math.max(0, list.length - 1);
        let factors = 0;
        for (const t of list) {
          if (flexible.has(t)) factors += frOf(tracks[t].max)!;
          else leftover -= base[t];
        }
        const unit = Math.max(0, leftover) / Math.max(1, factors);
        let frozen = false;
        for (const t of flexible) {
          if (unit * frOf(tracks[t].max)! < base[t]) {
            flexible.delete(t);
            frozen = true;
          }
        }
        if (!frozen) return unit;
      }
    };
    const all = tracks.map((_, t) => t);
    let unit: number;
    if (Number.isFinite(space.available)) unit = frSize(all, space.available);
    else {
      // with no size of its own, the axis takes the `fr` that holds every
      // track's base size and every item across `fr` tracks at its widest
      unit = 0;
      for (const t of flex) {
        const fr = frOf(tracks[t].max)!;
        unit = Math.max(unit, fr > 1 ? base[t] / fr : base[t]);
      }
      for (const item of flexing) {
        const list: number[] = [];
        for (
          let t = item.start;
          t < Math.min(n, item.start + item.span);
          t += 1
        ) {
          list.push(t);
        }
        unit = Math.max(unit, frSize(list, item.maxContent()));
      }
      // and fills a least size it has
      if (space.least > 0) {
        let total = gap * Math.max(0, n - 1);
        for (let t = 0; t < n; t += 1) {
          const fr = frOf(tracks[t].max);
          total += fr === null ? base[t] : Math.max(base[t], unit * fr);
        }
        if (total < space.least) unit = frSize(all, space.least);
      }
    }
    for (const t of flex) {
      const size = unit * frOf(tracks[t].max)!;
      if (size > base[t]) base[t] = size;
    }
  }

  // 11.8: the `auto` tracks stretch into what is left, where the axis has
  // a size, or a least size
  if (space.stretch) {
    const room = Number.isFinite(space.available)
      ? space.available
      : space.least;
    const free = room - used();
    if (free > EPS) {
      const stretchy: number[] = [];
      for (let t = 0; t < n; t += 1)
        if (tracks[t].max === 'auto') stretchy.push(t);
      for (const t of stretchy) base[t] += free / stretchy.length;
    }
  }
  return base;
}
