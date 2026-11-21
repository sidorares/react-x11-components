// Where the rules in a container's gaps go (CSS Gap Decorations 1, 3): the
// pieces of each gap a rule is drawn along, what each of its ends meets —
// another gap, or the container's edge — and which gap it is, which a list
// of rules gives a value by. Drawing them is `paint.ts`'s.
import type { GapRule } from './css/style.js';
import { Box, COLUMN_BOXES, GRID_TRACKS } from './layout/boxes.js';
import type { ColumnRow } from './layout/boxes.js';
import { ROWS_MIRRORED } from './layout/writing.js';
import { lanesAreRows } from './layout/css-grid.js';

/** An end of a piece of a rule. A junction is where it meets a gap that
 *  crosses its own, `size` across, which a percentage inset is of and an
 *  `overlap-join` reaches into; that gap is `cross` of `crossOf` the other
 *  way, whose rule's width an `overlap-join` reaches past half of. Any
 *  other end is a cap, of no size. */
export interface RuleEnd {
  junction: boolean;
  size: number;
  cross: number;
  crossOf: number;
}

/** A piece of a gap's rule: along its gap's middle, `at` across, from
 *  `from` to `to`, in document coordinates; its two ends; the gap it is,
 *  `gap` of `of`, which a rule's lists are read at. */
export interface RuleSegment {
  at: number;
  from: number;
  to: number;
  start: RuleEnd;
  end: RuleEnd;
  gap: number;
  of: number;
  /** Whether `start` is at `to`: a piece drawn mirrored, which runs from
   *  its far physical end, as a rule in a right-to-left grid's rows does. */
  flipped?: boolean;
  /** How far across the gap itself reaches, where it is wider than the
   *  rule: a break that falls anywhere in it takes the rule away (CSS Gap
   *  Decorations 1, 3.6), not only one that falls in the rule's width. */
  span?: readonly [number, number];
}

const CAP: RuleEnd = { junction: false, size: 0, cross: -1, crossOf: 0 };

/** A piece's end at a gap crossing it, or a cap where there is none. */
function junction(
  exists: boolean,
  size: number,
  cross: number,
  crossOf: number,
): RuleEnd {
  return exists ? { junction: true, size, cross, crossOf } : CAP;
}

/** The pieces of a container's column rules, down its column gaps, and of
 *  its row rules, across its row gaps; null for a box with no gaps. */
export function gapSegments(
  box: Box,
  frame?: FlexFrame,
): { columns: RuleSegment[]; rows: RuleSegment[] } | null {
  // a grid reads as `flex` and says it is a grid
  const grid = box.style.grid ? GRID_TRACKS.get(box) : undefined;
  if (grid) {
    if (box.style.gridLanes) return laneSegments(box);
    const { cols, rows, areas } = grid.lanes;
    const columns = gridRuleSegments(
      cols,
      rows,
      areas,
      box.style.columnRule,
      box.style.rowRule,
      box.contentX,
      box.contentY,
    );
    const across = gridRuleSegments(
      rows,
      cols,
      areas.map(([c, cs, r, rs]) => [r, rs, c, cs]),
      box.style.rowRule,
      box.style.columnRule,
      box.contentY,
      box.contentX,
    );
    mirrored(box, grid.mirror, columns, across);
    return { columns, rows: across };
  }
  if (box.style.columns) return multicolSegments(box);
  if (isFlex(box.style.display)) return flexRuleSegments(box, frame);
  return null;
}

/** Columns that run right to left are from the grid's right: each piece is
 *  worked out from there and drawn mirrored, its two ends swapped; and rows
 *  put back across a `vertical-lr` frame from its bottom the same way. */
function mirrored(
  box: Box,
  mirror: number | undefined,
  columns: RuleSegment[],
  rows: RuleSegment[],
): void {
  const flipAll = (
    along: RuleSegment[],
    across: RuleSegment[],
    flip: (v: number) => number,
  ) => {
    for (const piece of along) piece.at = flip(piece.at);
    for (const piece of across) {
      [piece.from, piece.to] = [flip(piece.to), flip(piece.from)];
      piece.flipped = !piece.flipped;
    }
  };
  if (mirror !== undefined) {
    flipAll(columns, rows, (x) => 2 * box.contentX + mirror - x);
  }
  const down = ROWS_MIRRORED.get(box);
  if (down !== undefined) {
    flipAll(rows, columns, (y) => 2 * box.contentY + down - y);
  }
}

function isFlex(display: string): boolean {
  return display === 'flex' || display === 'inline-flex';
}

/** A rule's `normal` visibility in a grid: next to every area. */
function shown(
  rule: GapRule,
  fallback: 'all' | 'between',
): 'all' | 'around' | 'between' {
  return rule.visibility === 'normal' ? fallback : rule.visibility;
}

/**
 * The pieces of a grid's rules down the gaps between `lanes` — its columns
 * for its column rules, and its rows, the two axes swapped, for its row
 * rules — over `across`, the tracks the other way; `areas` are its items',
 * each its first lane, how many, its first track across and how many.
 * A gap is drawn along each track across that `*-rule-visibility-items`
 * draws it beside (3.4); a track where an item spans the gap is no part of
 * it, but under `none`. Under `none` the tracks a gap is drawn along run
 * on as one piece. Under `normal` too, so a rule goes on through a + and
 * along the bar of a T, whose stem stops at it. Under `intersection` it is
 * broken at every gap it meets, but one items span on both sides of. A
 * piece broken at a gap stops where the gap starts and the next starts
 * where it ends. Its end there is a junction where the gap across is drawn
 * beside it, by the crossing rule's own visibility — `other`'s — and a cap
 * where it is not; a percentage is of the gap's size at either.
 */
function gridRuleSegments(
  lanes: readonly [number, number][],
  across: readonly [number, number][],
  areas: readonly (readonly [number, number, number, number])[],
  rule: GapRule,
  other: GapRule,
  laneOrigin: number,
  acrossOrigin: number,
  /** What `normal` visibility is: `all` in a grid, `between` in rows of
   *  columns. */
  fallback: 'all' | 'between' = 'all',
): RuleSegment[] {
  const out: RuleSegment[] = [];
  const n = across.length;
  if (!n) return out;
  const brk = rule.break;
  const visibility = shown(rule, fallback);
  const crossing = shown(other, fallback);
  const gaps = lanes.length - 1;
  /** Whether an item covers lane `lane` from track `t` to `t + more`. */
  const covers = (lane: number, t: number, more: number): boolean =>
    areas.some(
      ([l, ls, r, rs]) =>
        l <= lane && l + ls - 1 >= lane && r <= t && r + rs - 1 >= t + more,
    );
  /** Whether an item covers lanes `a` and `a + 1` across track `t`. */
  const spans = (lane: number, t: number): boolean =>
    areas.some(
      ([l, ls, r, rs]) =>
        l <= lane && l + ls - 1 >= lane + 1 && r <= t && r + rs - 1 >= t,
    );
  /** Whether a gap is drawn beside two areas by a visibility. */
  const beside = (
    shownBy: 'all' | 'around' | 'between',
    a: boolean,
    b: boolean,
  ): boolean =>
    shownBy === 'all' ? true : shownBy === 'around' ? a || b : a && b;
  for (let lane = 0; lane < gaps; lane += 1) {
    const at = laneOrigin + (lanes[lane][1] + lanes[lane + 1][0]) / 2;
    const drawn = (t: number): boolean =>
      (brk === 'none' || !spans(lane, t)) &&
      beside(visibility, covers(lane, t, 0), covers(lane + 1, t, 0));
    /** The gap across between tracks `t` and `t + 1`, at each side. */
    const crossBefore = (t: number) => !covers(lane, t, 1);
    const crossAfter = (t: number) => !covers(lane + 1, t, 1);
    /** Whether the gap across is drawn in lane `l` there. */
    const crossDrawn = (l: number, t: number) =>
      !covers(l, t, 1) &&
      beside(crossing, covers(l, t, 0), covers(l, t + 1, 0));
    const endAt = (t: number): RuleEnd => {
      const size = across[t + 1][0] - across[t][1];
      return crossDrawn(lane, t) || crossDrawn(lane + 1, t)
        ? { junction: true, size, cross: t, crossOf: n - 1 }
        : { junction: false, size, cross: t, crossOf: n - 1 };
    };
    const push = (first: number, last: number) => {
      out.push({
        at,
        from: acrossOrigin + across[first][0],
        to: acrossOrigin + across[last][1],
        start: first === 0 ? CAP : endAt(first - 1),
        end: last === n - 1 ? CAP : endAt(last),
        gap: lane,
        of: gaps,
        span: [laneOrigin + lanes[lane][1], laneOrigin + lanes[lane + 1][0]],
      });
    };
    let start: number | null = null;
    for (let t = 0; t < n; t += 1) {
      if (!drawn(t)) {
        start = null;
        continue;
      }
      if (start === null) start = t;
      // where the piece goes on to the next track, or stops
      let goesOn = false;
      if (t < n - 1 && drawn(t + 1)) {
        goesOn = brk !== 'intersection' || (!crossBefore(t) && !crossAfter(t));
      }
      if (!goesOn) {
        push(start, t);
        start = null;
      }
    }
  }
  return out;
}

type Span = [number, number];

/** Intervals sorted and run together where they overlap or touch. */
function merged(list: Span[], slack = 0): Span[] {
  const sorted = list.slice().sort((x, y) => x[0] - y[0]);
  const out: Span[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + slack + 1e-6) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function intersected(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      const lo = Math.max(a0, b0);
      const hi = Math.min(a1, b1);
      if (hi > lo) out.push([lo, hi]);
    }
  }
  return merged(out);
}

/**
 * The pieces of a grid lanes container's rules (3.1.1), its lanes `rows`
 * or columns. In the stacking axis each lane has its own rules: one in the
 * stacking gap before each item placed after another in the lane — before
 * a spanner in every lane it spans, where any of them has an item before
 * it — across the lane; each lane's take its own list's values from its
 * placement start, and an end of one is a junction at a gap between lanes
 * and a cap at the container's edge. In the grid axis a gap between two
 * lanes runs the stacking range. The stacking gaps of the lanes on either
 * side are its junctions, those that overlap one, and it is broken around
 * each item that spans it, from a stacking gap before it to one after,
 * where its ends are caps. `normal` runs it on through its junctions, and
 * `intersection` breaks it at each. Its visibility goes by where the items
 * on each side are, a stacking gap between two of a lane's counting as
 * filled and the space an item is aligned in not: `around` draws a piece
 * between two junctions beside any of it, and `between` where both sides
 * are filled.
 */
function laneSegments(box: Box): {
  columns: RuleSegment[];
  rows: RuleSegment[];
} {
  const grid = GRID_TRACKS.get(box)!;
  const style = box.style;
  const rows = lanesAreRows(style);
  const lanes = rows ? grid.lanes.rows : grid.lanes.cols;
  const laneOrigin = rows ? box.contentY : box.contentX;
  const stackOrigin = rows ? box.contentX : box.contentY;
  const stack = grid.lanes.stack;
  const d = stack?.gap ?? 0;
  const physical = (v: number): number => {
    if (!stack) return v;
    let p = (stack.reverse ? stack.range - v : v) + stack.shift;
    if (stack.mirror !== undefined) p = stack.mirror - p;
    return p;
  };
  const span = ([a, b]: Span): Span => {
    const x = physical(a);
    const y = physical(b);
    return x <= y ? [x, y] : [y, x];
  };
  // a grid-axis gap runs the stacking track, which stretches to the
  // content box under `normal` and `stretch` alignment, as a grid's auto
  // track does, and is the range where it is aligned
  const content = (
    rows ? style.justifyContentText : style.alignContentText
  ).trim();
  const stretched = content === 'normal' || content === 'stretch';
  const range: Span = stretched
    ? [
        0,
        Math.max(
          rows ? box.contentWidth : box.contentHeight,
          span([0, stack?.range ?? 0])[1],
        ),
      ]
    : span([0, stack?.range ?? 0]);
  const items = grid.lanes.items.map((item, i) => {
    const [c, cs, r, rs] = grid.lanes.areas[i];
    const lead = rows
      ? item.x - item.marginLeft - box.contentX
      : item.y - item.marginTop - box.contentY;
    const extent = rows
      ? item.width + item.marginLeft + item.marginRight
      : item.height + item.marginTop + item.marginBottom;
    const area = stack?.areas[i] ?? [lead, lead + extent];
    return {
      lane: rows ? r : c,
      span: rows ? rs : cs,
      box: [lead, lead + Math.max(0, extent)] as Span,
      pos: area[0],
      // the stacking gap before it, where it is
      gutter: span([area[0] - d, area[0]]),
    };
  });
  const inLane = (lane: number) =>
    items
      .filter((it) => it.lane <= lane && it.lane + it.span - 1 >= lane)
      .sort((x, y) => x.pos - y.pos);
  const gridRule = rows ? style.rowRule : style.columnRule;
  const gaps = lanes.length - 1;
  // with `track-reverse` the lanes are placed from the last, and their
  // gaps take a list's values in that order
  const laneIndex = (g: number) =>
    style.gridLanesDirection.includes('track-reverse') ? gaps - 1 - g : g;
  // each item placed after another in any lane it spans has a gutter
  // before it in all of them
  const follows = new Set<(typeof items)[number]>();
  for (let lane = 0; lane < lanes.length; lane += 1) {
    inLane(lane).forEach((it, k) => k > 0 && follows.add(it));
  }
  /** Each lane's gutters, in placement order, with their index. */
  const gutters: { span: Span; index: number; of: number }[][] = [];
  for (let lane = 0; lane < lanes.length; lane += 1) {
    const list = inLane(lane).filter((it) => follows.has(it));
    gutters.push(
      list.map((it, k) => ({ span: it.gutter, index: k, of: list.length })),
    );
  }

  const stacked: RuleSegment[] = [];
  for (let lane = 0; lane < lanes.length; lane += 1) {
    const before =
      lane > 0
        ? junction(true, lanes[lane][0] - lanes[lane - 1][1], lane - 1, gaps)
        : CAP;
    const after =
      lane < gaps
        ? junction(true, lanes[lane + 1][0] - lanes[lane][1], lane, gaps)
        : CAP;
    for (const g of gutters[lane]) {
      stacked.push({
        at: stackOrigin + (g.span[0] + g.span[1]) / 2,
        from: laneOrigin + lanes[lane][0],
        to: laneOrigin + lanes[lane][1],
        start: before,
        end: after,
        gap: g.index,
        of: g.of,
      });
    }
  }

  const along: RuleSegment[] = [];
  const visibility = shown(gridRule, 'all');
  /** Where a lane is filled: its items, and its gutters between them. */
  const filled = (lane: number): Span[] =>
    merged([
      ...inLane(lane).map((it) => it.box),
      ...gutters[lane].map((g) => g.span),
    ]);
  for (let g = 0; g < gaps; g += 1) {
    const at = laneOrigin + (lanes[g][1] + lanes[g + 1][0]) / 2;
    const none = gridRule.break === 'none';
    // around each spanner, from a stacking gap before it to one after
    const blocked = none
      ? []
      : merged(
          items
            .filter((it) => it.lane <= g && it.lane + it.span - 1 >= g + 1)
            .map((it) => [it.box[0] - d, it.box[1] + d] as Span),
        );
    // the junctions: the gutters on either side, one where they overlap,
    // each with the gutter it came from first
    const marks = [...gutters[g], ...gutters[g + 1]]
      .map((x) => ({ span: [...x.span] as Span, index: x.index, of: x.of }))
      .sort((x, y) => x.span[0] - y.span[0]);
    const joins: typeof marks = [];
    for (const m of marks) {
      const last = joins[joins.length - 1];
      if (last && m.span[0] <= last.span[1] + 1e-6) {
        last.span[1] = Math.max(last.span[1], m.span[1]);
      } else joins.push(m);
    }
    // the gap's segments: between the range's ends, the spanners'
    // intervals and the junctions
    type Piece = { from: number; to: number; start: RuleEnd; end: RuleEnd };
    const pieces: Piece[] = [];
    let from = range[0];
    let startEnd: RuleEnd = CAP;
    const stops = [
      ...blocked.map((b) => ({ span: b, end: CAP, join: false })),
      ...joins.map((j) => ({
        span: j.span,
        end: junction(true, j.span[1] - j.span[0], j.index, j.of),
        join: true,
      })),
    ].sort((x, y) => x.span[0] - y.span[0]);
    for (const stop of stops) {
      if (stop.span[1] <= from + 1e-6) {
        if (!stop.join) {
          from = Math.max(from, stop.span[1]);
          startEnd = CAP;
        }
        continue;
      }
      if (stop.span[0] > from) {
        pieces.push({ from, to: stop.span[0], start: startEnd, end: stop.end });
      }
      if (stop.span[1] > from) {
        from = stop.span[1];
        startEnd = stop.end;
      }
    }
    if (range[1] > from) {
      pieces.push({ from, to: range[1], start: startEnd, end: CAP });
    }
    // what visibility draws of each
    const sideA = filled(g);
    const sideB = filled(g + 1);
    const both = intersected(sideA, sideB);
    const drawn: Piece[] = [];
    for (const piece of pieces) {
      if (visibility === 'all') drawn.push(piece);
      else if (visibility === 'around') {
        const meets = (list: Span[]) =>
          list.some(([a, b]) => b > piece.from && a < piece.to);
        if (meets(sideA) || meets(sideB)) drawn.push(piece);
      } else {
        for (const [a, b] of both) {
          const lo = Math.max(a, piece.from);
          const hi = Math.min(b, piece.to);
          if (hi <= lo) continue;
          drawn.push({
            from: lo,
            to: hi,
            start: lo > piece.from ? { ...CAP } : piece.start,
            end: hi < piece.to ? { ...CAP } : piece.end,
          });
        }
      }
    }
    // run on through junctions where the break says, and where nothing
    // was left out between
    const runs: Piece[] = [];
    for (const piece of drawn) {
      const last = runs[runs.length - 1];
      if (
        last &&
        last.end.junction &&
        gridRule.break !== 'intersection' &&
        piece.from - last.to <= last.end.size + 1e-6 &&
        piece.start.junction
      ) {
        last.to = piece.to;
        last.end = piece.end;
      } else runs.push({ ...piece });
    }
    for (const run of runs) {
      along.push({
        at,
        from: stackOrigin + run.from,
        to: stackOrigin + run.to,
        start: run.start,
        end: run.end,
        gap: laneIndex(g),
        of: gaps,
      });
    }
  }
  const columns = rows ? stacked : along;
  const rowsOut = rows ? along : stacked;
  const mirror = grid.mirror;
  if (mirror !== undefined && !rows) {
    const flip = (x: number) => 2 * box.contentX + mirror - x;
    for (const piece of columns) piece.at = flip(piece.at);
    for (const piece of rowsOut) {
      [piece.from, piece.to] = [flip(piece.to), flip(piece.from)];
      piece.flipped = !piece.flipped;
    }
  }
  return { columns, rows: rowsOut };
}

/**
 * The pieces of a multicol container's column rules: down each gap between
 * two columns of a row, as tall as the row. Which gaps is the rule's
 * visibility, whose `normal` is `between` here (3.4): between two columns
 * that hold something, beside one for `around`, every gap for `all`. A row
 * ends at a box that spans the columns, which breaks the rule there under
 * its `normal`, which is `intersection` here (3.2); `none` runs a gap's
 * rule on from the first row to the last.
 */
function multicolSegments(box: Box): {
  columns: RuleSegment[];
  rows: RuleSegment[];
} {
  const rule = box.style.columnRule;
  const visibility = shown(rule, 'between');
  const rtl = box.style.direction === 'rtl';
  const all = COLUMN_BOXES.get(box) ?? [];
  // rows `column-wrap` set, a row gap apart, are a grid of columns: their
  // column rules and row rules are a grid's (CSS Gap Decorations 1, 3.1.3)
  const rows: typeof all = [];
  const wrapped: RuleSegment[] = [];
  const across: RuleSegment[] = [];
  for (let i = 0; i < all.length;) {
    let j = i + 1;
    while (j < all.length && all[i].wrap && all[j].wrap === all[i].wrap) {
      j += 1;
    }
    if (j - i < 2) {
      rows.push(all[i]);
    } else {
      // right to left, the columns are counted from the right, which a
      // rule's lists go by: worked out from there and drawn mirrored, as a
      // right-to-left grid's are
      const mirror = rtl ? box.contentWidth : undefined;
      const grid = gridOfRows(all.slice(i, j), mirror);
      const { lanes, tracks, areas } = grid;
      // a column rule stops at a row gap under `normal`, which is
      // `intersection` here, as it does at a spanner: the row gap is no
      // part of the column gap (WPT's multicol-column-rule-final-row-overflow)
      const down: GapRule =
        rule.break === 'normal' ? { ...rule, break: 'intersection' } : rule;
      const down2 = gridRuleSegments(
        lanes,
        tracks,
        areas,
        down,
        box.style.rowRule,
        box.contentX,
        box.contentY,
        'between',
      );
      const across2 = gridRuleSegments(
        tracks,
        lanes,
        areas.map(([c, cs, r, rs]) => [r, rs, c, cs]),
        box.style.rowRule,
        rule,
        box.contentY,
        box.contentX,
        'between',
      );
      if (mirror !== undefined) mirrored(box, mirror, down2, across2);
      wrapped.push(...down2);
      across.push(...across2);
    }
    i = j;
  }
  type Piece = { at: number; from: number; to: number; gap: number };
  const pieces: Piece[] = [];
  let most = 0;
  // the gaps between the columns there are in any row, which a rule shown
  // between every column, under `all`, is drawn in through each row
  let exist = 0;
  for (const row of rows) {
    exist = Math.max(exist, row.exists ?? (row.every ?? row.lefts).length);
  }
  // the columns of the last row, past a spanner or of the only one, are as
  // tall as what is left of the content box, where the content is shorter
  // than the container: Blink's column boxes there reach its foot (WPT's
  // multicol-gap-decorations-026 and -visibility-all-empty-columns). Not
  // rows `column-wrap` sets, which are as tall as they say.
  const last = all[all.length - 1]?.wrap ? null : all[all.length - 1];
  const foot = box.contentY + box.contentHeight;
  for (const row of rows) {
    const every = (row.every ?? row.lefts)
      .slice(0, Math.max(exist, row.lefts.length))
      .sort((a, b) => a - b);
    const holds = new Set(row.lefts.map((l) => Math.round(l * 64)));
    const filled = (l: number) => holds.has(Math.round(l * 64));
    most = Math.max(most, every.length - 1);
    const top = box.contentY + row.top;
    for (let c = 0; c + 1 < every.length; c += 1) {
      const a = filled(every[c]);
      const b = filled(every[c + 1]);
      const drawn =
        visibility === 'all' || (visibility === 'around' ? a || b : a && b);
      if (!drawn) continue;
      pieces.push({
        at: box.contentX + (every[c] + row.width + every[c + 1]) / 2,
        from: top,
        to: row === last ? Math.max(top + row.height, foot) : top + row.height,
        gap: rtl ? every.length - 2 - c : c,
      });
    }
  }
  const columns: RuleSegment[] = [];
  for (const piece of pieces) {
    const last = columns.find(
      (p) => rule.break === 'none' && Math.abs(p.at - piece.at) < 0.5,
    );
    if (last) {
      last.from = Math.min(last.from, piece.from);
      last.to = Math.max(last.to, piece.to);
      continue;
    }
    columns.push({
      at: piece.at,
      from: piece.from,
      to: piece.to,
      start: CAP,
      end: CAP,
      gap: piece.gap,
      of: most,
    });
  }
  if (rule.break !== 'none' || !wrapped.length) {
    return downward(box, { columns: [...columns, ...wrapped], rows: across });
  }
  // under `none` a gap's rule runs on from the first row to the last, across
  // a spanner, rows of columns `column-wrap` set among the rest
  const runs: RuleSegment[] = [];
  for (const piece of [...columns, ...wrapped]) {
    const run = runs.find((p) => Math.abs(p.at - piece.at) < 0.5);
    if (!run) {
      runs.push({ ...piece });
      continue;
    }
    if (piece.from < run.from) {
      run.from = piece.from;
      run.start = piece.start;
    }
    if (piece.to > run.to) {
      run.to = piece.to;
      run.end = piece.end;
    }
  }
  return downward(box, { columns: runs, rows: across });
}

/** A multicol container's rules put back across a `vertical-lr` frame, as
 *  its rows of columns were (`ROWS_MIRRORED`): worked out down the frame,
 *  as `vertical-rl`'s are, and drawn mirrored. */
function downward(
  box: Box,
  pieces: { columns: RuleSegment[]; rows: RuleSegment[] },
): { columns: RuleSegment[]; rows: RuleSegment[] } {
  mirrored(box, undefined, pieces.columns, pieces.rows);
  return pieces;
}

/** Rows of columns as a grid's tracks, from the content box's corner: the
 *  columns across, the rows down, and a one-cell area for each column that
 *  holds something. */
function gridOfRows(
  rows: readonly ColumnRow[],
  /** Where the columns are counted from the right: the content box's
   *  width, which each left is taken from. */
  mirror?: number,
): {
  lanes: [number, number][];
  tracks: [number, number][];
  areas: [number, number, number, number][];
} {
  const width = rows[0].width;
  const from = (l: number): number =>
    mirror === undefined ? l : mirror - l - width;
  const every = (rows[0].every ?? rows[0].lefts)
    .map(from)
    .sort((a, b) => a - b);
  const lanes = every.map((l): [number, number] => [l, l + width]);
  const tracks = rows.map((r): [number, number] => [r.top, r.top + r.height]);
  const areas: [number, number, number, number][] = [];
  rows.forEach((row, r) => {
    for (const left of row.lefts.map(from)) {
      const c = every.findIndex((l) => Math.abs(l - left) < 1 / 64);
      if (c >= 0) areas.push([c, 1, r, 1]);
    }
  });
  return { lanes, tracks, areas };
}

/**
 * The pieces of a flex container's rules (3.1): its lines found from where
 * its items are — a new one where an item starts past every item of the one
 * before across the main axis — a rule between each two items on a line, as
 * tall as the line, and one between each two lines, as long as the
 * container's content box. In a row the rules between items are its column
 * rules and those between lines its row rules; in a column, the other way
 * round. A container of one line has that line as tall as its content box.
 * The gaps are counted from the main start of each line and the cross start
 * of the lines, on through every line (4.6), and an end of a rule between
 * items that meets a gap between lines is a junction there, as is a piece
 * of a rule between lines that `intersection` breaks at a gap between items.
 */
/** Where a flex container's content box is, and each item, where they are
 *  not where the boxes say: a container columns broke, whose items stand
 *  in the columns, worked out back to where they are in the container. */
export interface FlexFrame {
  contentX: number;
  contentY: number;
  place: (item: Box) => [number, number, number, number];
}

function flexRuleSegments(
  box: Box,
  frame: FlexFrame = {
    contentX: box.contentX,
    contentY: box.contentY,
    place: (b) => [b.x, b.y, b.width, b.height],
  },
): {
  columns: RuleSegment[];
  rows: RuleSegment[];
} {
  const style = box.style;
  const row = !style.flexDirection.startsWith('column');
  const mainReversed =
    style.flexDirection.endsWith('-reverse') !==
    (row && style.direction === 'rtl');
  const crossReversed = style.flexWrap === 'wrap-reverse';
  const items = box.children.filter(
    (child) => !child.outOfFlow && child.kind !== 'text',
  );
  type Span = {
    start: number;
    end: number;
    crossStart: number;
    crossEnd: number;
  };
  const spanOf = (b: Box): Span => {
    const [x, y, width, height] = frame.place(b);
    return row
      ? {
          start: x - b.marginLeft,
          end: x + width + b.marginRight,
          crossStart: y - b.marginTop,
          crossEnd: y + height + b.marginBottom,
        }
      : {
          start: y - b.marginTop,
          end: y + height + b.marginBottom,
          crossStart: x - b.marginLeft,
          crossEnd: x + width + b.marginRight,
        };
  };
  const spans = items.map(spanOf).sort((a, b) => a.crossStart - b.crossStart);
  const lines: { items: Span[]; crossStart: number; crossEnd: number }[] = [];
  for (const span of spans) {
    const line = lines[lines.length - 1];
    if (line && span.crossStart < line.crossEnd - 0.01) {
      line.items.push(span);
      line.crossStart = Math.min(line.crossStart, span.crossStart);
      line.crossEnd = Math.max(line.crossEnd, span.crossEnd);
    } else {
      lines.push({
        items: [span],
        crossStart: span.crossStart,
        crossEnd: span.crossEnd,
      });
    }
  }
  const mainStart = row ? frame.contentX : frame.contentY;
  const mainEnd = mainStart + (row ? box.contentWidth : box.contentHeight);
  if (lines.length === 1) {
    lines[0].crossStart = row ? frame.contentY : frame.contentX;
    lines[0].crossEnd =
      lines[0].crossStart + (row ? box.contentHeight : box.contentWidth);
  }
  // lines in the order they are counted, and each line's gaps
  const ordered = crossReversed ? lines.slice().reverse() : lines;
  const betweenOf = ordered.map((line) => {
    const sorted = line.items.slice().sort((a, b) => a.start - b.start);
    const gaps: [number, number][] = [];
    for (let k = 0; k + 1 < sorted.length; k += 1) {
      gaps.push([sorted[k].end, sorted[k + 1].start]);
    }
    return mainReversed ? gaps.reverse() : gaps;
  });
  const total = betweenOf.reduce((n, g) => n + g.length, 0);
  const lineGaps = lines.length - 1;
  // the gap between line `i` and the next, in counted order
  const lineGap = (i: number): [number, number] => {
    const a = ordered[i];
    const b = ordered[i + 1];
    return crossReversed
      ? [b.crossEnd, a.crossStart]
      : [a.crossEnd, b.crossStart];
  };
  const between: RuleSegment[] = [];
  const across: RuleSegment[] = [];
  let index = 0;
  const firstOfLine: number[] = [];
  ordered.forEach((line, i) => {
    firstOfLine.push(index);
    // the line's cross start and end, and the gaps between lines there
    const low = crossReversed ? i + 1 : i - 1;
    const high = crossReversed ? i - 1 : i + 1;
    const near = (other: number, before: boolean): RuleEnd => {
      if (other < 0 || other >= ordered.length) return CAP;
      const g = before
        ? crossReversed
          ? i
          : i - 1
        : crossReversed
          ? i - 1
          : i;
      const [a, b] = lineGap(g);
      return junction(true, b - a, g, lineGaps);
    };
    for (const [a, b] of betweenOf[i]) {
      between.push({
        at: (a + b) / 2,
        from: line.crossStart,
        to: line.crossEnd,
        start: near(low, true),
        end: near(high, false),
        gap: index++,
        of: total,
      });
    }
  });
  for (let i = 0; i < lineGaps; i += 1) {
    const [a, b] = lineGap(i);
    const at = (a + b) / 2;
    const rule = row ? style.rowRule : style.columnRule;
    if (rule.break !== 'intersection') {
      across.push({
        at,
        from: mainStart,
        to: mainEnd,
        start: CAP,
        end: CAP,
        gap: i,
        of: lineGaps,
      });
      continue;
    }
    // broken at each gap between items that meets it, from either line
    const meets: { from: number; to: number; gap: number }[] = [];
    for (const line of [i, i + 1]) {
      betweenOf[line].forEach(([x, y], k) =>
        meets.push({ from: x, to: y, gap: firstOfLine[line] + k }),
      );
    }
    meets.sort((p, q) => p.from - q.from);
    // gaps of the two lines that overlap are one junction, their union
    for (let k = 1; k < meets.length;) {
      if (meets[k].from <= meets[k - 1].to) {
        meets[k - 1].to = Math.max(meets[k - 1].to, meets[k].to);
        meets.splice(k, 1);
      } else k += 1;
    }
    let from = mainStart;
    let startEnd: RuleEnd = CAP;
    for (const m of meets) {
      if (m.from > from) {
        across.push({
          at,
          from,
          to: m.from,
          start: startEnd,
          end: junction(true, m.to - m.from, m.gap, total),
          gap: i,
          of: lineGaps,
        });
      }
      from = Math.max(from, m.to);
      startEnd = junction(true, m.to - m.from, m.gap, total);
    }
    if (mainEnd > from) {
      across.push({
        at,
        from,
        to: mainEnd,
        start: startEnd,
        end: CAP,
        gap: i,
        of: lineGaps,
      });
    }
  }
  for (const piece of across) piece.span = lineGap(piece.gap);
  // a horizontal piece's start is the inline start, its right end in a
  // right-to-left container
  if (style.direction === 'rtl') {
    for (const piece of row ? across : between) piece.flipped = true;
  }
  return row
    ? { columns: between, rows: across }
    : { columns: across, rows: between };
}
