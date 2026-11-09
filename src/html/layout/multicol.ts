/**
 * Multi-column layout (CSS Multi-column 1), over the layout the block pass
 * makes of a container's content as one column: a strip a column wide and
 * as tall as it all comes to. What is here decides where the strip breaks,
 * and moves each piece of it to its column.
 *
 * Moved rather than laid out again, because a break changes nothing about a
 * box but where it is: every column is the same width, so a paragraph's
 * lines are the ones the strip gave it, and a box that a break misses is the
 * same box in another place. A box a break falls inside keeps one rect,
 * which takes in all its pieces as a browser's bounding rect of it does, and
 * its pieces beside it (`COLUMN_PIECES`); the lines of a paragraph go each to
 * its column (`COLUMN_LINES`).
 *
 * Where the breaks go is CSS Fragmentation 3's: between the lines of a block
 * and between sibling boxes, never inside a line, a replaced element, a
 * table, a flex box or a grid, a box that clips or scrolls, or one that
 * says `break-inside: avoid` (4.1); `orphans` and `widows` lines of a block
 * kept together at either side of one (4.3), and a margin next to one
 * dropped where the break was not forced (5.2). A box with a height and
 * nothing in it has no line or box for a break to fall inside, and is cut
 * wherever a column ends; so is the room clearance leaves above a box or a
 * line, which is no margin. How tall the columns are is left to the user
 * agent where they balance (Multi-column 1, 7), and this does as Blink
 * does: the content's height over the number of columns, no less than the
 * tallest thing that cannot break, and then, while that many columns do not
 * hold it, taller by the least amount that lets one more thing into a
 * column — the smallest "space shortage" any break left
 * (`NGColumnLayoutAlgorithm`, `StretchColumnBlockSize`).
 *
 * What this cannot do for having laid the content out once: a float that
 * cannot be cut stays with the lines that were set beside it, where a
 * browser takes it to the next column and sets those lines again, wider;
 * and a table, a flex box and a grid go to a column whole, where a browser
 * breaks them between their rows.
 */
import { CONTAIN_SIZE, scrolls } from '../css/style.js';
import { gapOf } from '../css/values.js';
import { contained, establishesBFC, moveTo, transformed } from './block.js';
import {
  CLEARED_FROM,
  COLUMN_BOXES,
  COLUMN_LINES,
  COLUMN_PIECES,
  COLUMN_ROWS,
  columned,
} from './boxes.js';
import type { Box, ColumnPiece, LineBox, LineText } from './boxes.js';

/** A multicol container's columns: how many, how wide, and the gap. */
export interface Columns {
  count: number;
  width: number;
  gap: number;
}

/** Slack for sums of fractions of a pixel that should have come out even. */
const EPS = 1 / 128;

/** How far past the rows of its column a text's layout is left to draw at
 *  an end no other column's rows are beyond: a glyph taller than its line. */
const REACH = 2048;

/**
 * The columns a multicol container's content box of a width is set in (CSS
 * Multi-column 1, 3.4): as many as `column-count` says, or as many
 * `column-width` wide as fit, or the fewer of the two, and each as wide as
 * leaves a gap between them. Null for a box that is none, and for one laid
 * out at no width limit, whose content is one column as wide as it likes.
 */
export function columnsOf(box: Box, available: number): Columns | null {
  const style = box.style;
  if (!style.columns || box.kind !== 'block') return null;
  if (!Number.isFinite(available)) return null;
  // `normal` is an em between columns (4.1)
  const gap = style.columnGapNormal
    ? style.fontSize
    : gapOf(style.columnGap, available);
  let count: number;
  if (style.columnWidth === null) count = style.columnCount ?? 1;
  else {
    const fit = Math.max(
      1,
      Math.floor((available + gap) / (style.columnWidth + gap)),
    );
    count = style.columnCount === null ? fit : Math.min(style.columnCount, fit);
  }
  return {
    count,
    gap,
    width: Math.max(0, (available - (count - 1) * gap) / count),
  };
}

/** Something a break may come before and not inside: a line, or a box that
 *  is not broken. */
interface Unit {
  top: number;
  bottom: number;
  /** The block it is a line of. */
  block: Box | null;
  /** Whether it is a box with nothing in it, which a break may fall
   *  anywhere in: there is no line or box there for it to fall inside. */
  sliced: boolean;
  /** Its own height, before the edges of the boxes it starts and ends were
   *  added to it, and where it ends without those it ends. */
  size: number;
  end: number;
  group: Group;
}

/** The units that overlap down the strip, which go together: one alone, or
 *  a float and the lines beside it. */
interface Group {
  top: number;
  bottom: number;
  /** The block it is a line of, where it is one line and nothing else. */
  block: Box | null;
  /** Whether it is one box a break may fall anywhere in. */
  sliced: boolean;
  /** Whether nothing in it has a height: the edges of boxes, at most. */
  empty: boolean;
  /** Where it ends, without the bottom edges of the boxes it ends. */
  end: number;
  /** The column it starts in, and the one it ends in: the same, unless it
   *  is sliced. */
  column: number;
  last: number;
}

interface Gathered {
  units: Unit[];
  lines: Map<LineBox, Unit>;
  /** The boxes that go whole. */
  boxes: Map<Box, Unit>;
  /** The boxes a break may fall inside: the first and the last unit in
   *  each. */
  spans: Map<Box, [Unit, Unit]>;
  /** The boxes with a float in them that is set in a column on its own
   *  account: they do not move as one with what they hold. */
  loose: Set<Box>;
}

const NO_GROUP: Group = {
  top: 0,
  bottom: 0,
  block: null,
  sliced: false,
  empty: true,
  end: 0,
  column: 0,
  last: 0,
};

/** Whether no break may fall inside a box, whatever it holds: it is
 *  monolithic, or says so. It goes to a column with all that is in it. */
function whole(box: Box): boolean {
  if (box.kind !== 'block') return true;
  if (box.style.breakInside === 'avoid') return true;
  // a transform makes no box monolithic (CSS Fragmentation 3, 4.1): a
  // positioned box's containing block made by one is broken as any block
  // is, though its pieces are drawn through the matrix of the whole
  return establishesBFC(box);
}

/**
 * Whether a box that holds nothing to break between may be cut anywhere: a
 * block with a height and nothing in it, floated or not, which a browser
 * carries on from one column to the next (CSS Fragmentation 3, 4.1 makes
 * only what cannot be cut monolithic: replaced content, and a box that
 * scrolls or clips).
 */
function sliceable(box: Box): boolean {
  if (box.kind !== 'block' || box.marker) return false;
  const style = box.style;
  if (style.breakInside === 'avoid' || scrolls(style)) return false;
  if (transformed(style) || style.columns) return false;
  // size containment makes a box monolithic (CSS Containment 2, 3.1)
  if (contained(box, CONTAIN_SIZE)) return false;
  if (box.lines?.length) return false;
  for (const child of box.children) {
    if (flows(child)) return false;
  }
  return true;
}

/** Whether a block's child is a box in its flow. */
function flows(child: Box): boolean {
  switch (child.kind) {
    case 'text':
    case 'break':
    case 'inline':
    case 'marker':
      return false;
    default:
      return !child.outOfFlow && !child.isFloat;
  }
}

/** The floats and the out-of-flow boxes in a block's inline content, at
 *  any depth of inline box. */
function eachAside(box: Box, visit: (aside: Box) => void): void {
  for (const child of box.children) {
    if (child.isFloat || child.outOfFlow) visit(child);
    else if (child.kind === 'inline') eachAside(child, visit);
  }
}

/** How far down a box that goes whole reaches: its own bottom, and the
 *  floats that hang out of it where it does not hold them. */
function reachOf(box: Box): number {
  let bottom = box.y + box.height;
  if (box.kind !== 'block' || establishesBFC(box)) return bottom;
  const walk = (node: Box): void => {
    for (const child of node.children) {
      if (child.outOfFlow) continue;
      if (child.isFloat) {
        bottom = Math.max(
          bottom,
          child.y + child.height + Math.max(0, child.marginBottom),
        );
      } else if (child.kind === 'inline' || child.kind === 'block') walk(child);
    }
  };
  walk(box);
  return bottom;
}

/**
 * A float that goes whole, as a unit with the lines and the boxes beside
 * it, which it is set in a column with. One that can be cut anywhere is
 * none: it stands beside the flow, which breaks as it would without it,
 * and is cut where the columns end (`cutFloat`).
 */
function floatUnit(float: Box, from: Box, into: Gathered): void {
  if (columned.any) COLUMN_PIECES.delete(float);
  into.loose.add(from);
  if (sliceable(float)) return;
  const unit: Unit = {
    top: float.y - Math.max(0, float.marginTop),
    bottom: float.y + float.height + Math.max(0, float.marginBottom),
    block: null,
    sliced: false,
    size: 0,
    end: 0,
    group: NO_GROUP,
  };
  into.units.push(made(unit));
  into.boxes.set(float, unit);
}

/**
 * Room in the flow that nothing stands in and no margin makes: what
 * clearance moved a box or a line down by. A break drops a margin beside
 * it (CSS Fragmentation 3, 5.2) and not this, which the columns take as
 * they would a box with nothing in it, cut wherever one ends.
 */
function space(
  top: number,
  bottom: number,
  /** The block whose lines it is between. */
  block: Box | null,
  into: Gathered,
): Unit {
  const unit: Unit = {
    top,
    bottom,
    block,
    sliced: true,
    size: 0,
    end: 0,
    group: NO_GROUP,
  };
  into.units.push(made(unit));
  return unit;
}

/**
 * The units of a box's content, in the strip, and which box or line each
 * is: a line for each line, a box for each box that goes whole, and the
 * content of any other block in its turn — whose own top edge goes with its
 * first and whose bottom with its last, since no break comes between a box's
 * edge and what it holds. Answers the first and the last in the flow.
 */
function gather(box: Box, into: Gathered): [Unit, Unit] | null {
  let first: Unit | null = null;
  let last: Unit | null = null;
  const lines = box.lines;
  if (lines?.length) {
    let under = box.contentY;
    for (const line of lines) {
      // room a line was set below — a `<br clear>`, a line that did not
      // fit beside a float — is no margin for a break to drop
      if (line.y - under > EPS) {
        const room = space(under, line.y, box, into);
        first ??= room;
      }
      under = line.y + line.height;
      const unit: Unit = {
        top: line.y,
        bottom: line.y + line.height,
        block: box,
        sliced: false,
        size: 0,
        end: 0,
        group: NO_GROUP,
      };
      into.units.push(made(unit));
      into.lines.set(line, unit);
      first ??= unit;
      last = unit;
    }
    eachAside(box, (aside) => {
      if (aside.isFloat) floatUnit(aside, box, into);
    });
    return first && last ? [first, last] : null;
  }
  for (const child of box.children) {
    if (child.isFloat && !child.outOfFlow) {
      floatUnit(child, box, into);
      continue;
    }
    if (!flows(child)) continue;
    if (columned.any) COLUMN_PIECES.delete(child);
    // the room clearance set it down by, which is none of its margin
    const clear = CLEARED_FROM.get(child);
    if (clear !== undefined && child.y - clear > EPS) {
      const room = space(clear, child.y, null, into);
      first ??= room;
    }
    if (whole(child)) {
      const unit: Unit = {
        top: child.y,
        bottom: reachOf(child),
        block: null,
        sliced: sliceable(child),
        size: 0,
        end: 0,
        group: NO_GROUP,
      };
      into.units.push(made(unit));
      into.boxes.set(child, unit);
      first ??= unit;
      last = unit;
      continue;
    }
    const span = gather(child, into);
    if (into.loose.has(child)) into.loose.add(box);
    if (!span) {
      // nothing in its flow to break between: it goes whole, or is cut
      const unit: Unit = {
        top: child.y,
        bottom: child.y + child.height,
        block: null,
        sliced: sliceable(child),
        size: 0,
        end: 0,
        group: NO_GROUP,
      };
      into.units.push(made(unit));
      into.boxes.set(child, unit);
      first ??= unit;
      last = unit;
      continue;
    }
    span[0].top = Math.min(span[0].top, child.y);
    span[1].bottom = Math.max(span[1].bottom, child.y + child.height);
    into.spans.set(child, span);
    first ??= span[0];
    last = span[1];
  }
  return first && last ? [first, last] : null;
}

/** The units in groups, down the strip: each group what a break may come
 *  before. Units that overlap are one group, which no break divides. */
/** Note a unit's own extent, as it is made. */
function made(unit: Unit): Unit {
  unit.size = unit.bottom - unit.top;
  unit.end = unit.bottom;
  return unit;
}

function groupsOf(units: Unit[]): Group[] {
  // in the order of their tops, which is the document's but for a float
  const sorted = units.slice().sort((a, b) => a.top - b.top);
  const groups: Group[] = [];
  let group: Group | null = null;
  for (const unit of sorted) {
    if (group && unit.top < group.bottom - EPS) {
      group.bottom = Math.max(group.bottom, unit.bottom);
      group.block = null;
      group.sliced = false;
      group.empty &&= unit.size <= EPS;
      group.end = Math.max(group.end, unit.end);
    } else {
      group = {
        top: unit.top,
        bottom: unit.bottom,
        block: unit.block,
        sliced: unit.sliced,
        empty: unit.size <= EPS,
        end: unit.end,
        column: 0,
        last: 0,
      };
      groups.push(group);
    }
    unit.group = group;
  }
  return groups;
}

interface Filled {
  /** The group each column starts with, where the column starts down the
   *  strip, and whether it starts inside that group, which the column
   *  before cut. */
  starts: number[];
  tops: number[];
  cut: boolean[];
  /** The least any break missed fitting what came after it by. */
  shortage: number;
  /** Whether something stands in a column it is taller than. */
  over: boolean;
}

/** The most columns content is set in: past it, the rest stays in the
 *  last. A column a fraction of a pixel tall would make one for every such
 *  fraction of a box that can be cut anywhere. */
const MOST_COLUMNS = 2000;

/**
 * The groups set in columns of a height: each column filled until the next
 * group does not fit, and broken there — or before there, where that would
 * leave fewer lines of a block than `orphans` at the foot of the column, or
 * fewer than `widows` at the head of the next: `orphans` first, and then as
 * many of `widows` as that leaves, which is how Blink weighs the two (a
 * block of four lines with `widows: 3` breaks two and two; CSS says only
 * that both are to be honoured, 4.3). What stands
 * first in a column stays there however tall, and the first `orphans` lines
 * of a block with it. A box that can be cut anywhere is cut at the foot of
 * the column, and goes on at the head of the next.
 */
function fill(
  groups: Group[],
  top: number,
  height: number,
  /** Whether the columns can be no taller: the container's own height, or
   *  its `max-height`, is what they are. */
  fixed: boolean,
): Filled {
  const starts = [0];
  const tops = [top];
  const cut = [false];
  let shortage = Infinity;
  let over = false;
  let head = 0;
  let columnTop = top;
  /** Whether the group at the column's head is one the column before
   *  cut: it goes on from the column's top. */
  let goesOn = false;
  let i = 0;
  const missed = (index: number): void => {
    const by = groups[index].bottom - columnTop - height;
    if (by > EPS && by < shortage) shortage = by;
  };
  /** Whether nothing with a height has been set in the column before a
   *  group: the top edges of the boxes it starts, at most — or, `blank`,
   *  not even those. */
  const bare = (index: number, blank: boolean): boolean => {
    for (let k = head; k < index; k += 1) {
      const before = groups[k];
      if (blank ? before.bottom - before.top > EPS : !before.empty) {
        return false;
      }
    }
    return !goesOn;
  };
  const next = (at: number, from: number, inside: boolean): void => {
    starts.push(at);
    tops.push(from);
    cut.push(inside);
    head = at;
    columnTop = from;
    goesOn = inside;
    i = at;
  };
  while (i < groups.length) {
    const group = groups[i];
    if (
      group.bottom - columnTop <= height + EPS ||
      // nothing at all, which takes no room wherever it is
      group.bottom - group.top <= EPS ||
      starts.length >= MOST_COLUMNS
    ) {
      i += 1;
      goesOn = false;
      continue;
    }
    missed(i);
    if (group.sliced && height >= 1) {
      // what fits of it stays, and the rest goes on; none of it fits where
      // it starts at the column's foot, and then all of it goes on
      const from = goesOn ? columnTop : group.top;
      const foot = columnTop + height;
      if (foot - from > EPS) next(i, foot, true);
      else next(i, group.top, false);
      continue;
    }
    if (
      i === head ||
      bare(i, true) ||
      (group.end - columnTop <= height + EPS && bare(i, false))
    ) {
      // first in its column, or after nothing that takes any room, where
      // it stays however tall; or all of it fits but the bottom edge of a
      // box it ends, and nothing with a height has been set in the column
      // to break before it: the edge hangs out (where Blink breaks before
      // the edge, as a last resort)
      over = true;
      i += 1;
      goesOn = false;
      continue;
    }
    let at = i;
    const block = group.block;
    if (block) {
      // the lines of its block this one is among, and which of them it is
      const run = linesAbout(groups, i);
      const k = run.indexOf(i);
      const count = run.length;
      const orphans = Math.min(block.style.orphans, count);
      const widows = Math.min(block.style.widows, count);
      const a = run[0];
      if (a >= head && k > 0 && k < orphans) {
        if (a === head && !fixed) {
          // at the head of the column already: they stay, and hang out,
          // for a taller column to take them in
          missed(run[orphans - 1]);
          over = true;
          i = run[orphans - 1] + 1;
          goesOn = false;
          continue;
        }
        // too few would stay: the block goes to the next column whole —
        // or, at the head of a column that can be no taller, breaks where
        // it must, with fewer
        missed(run[orphans - 1]);
        if (a !== head) at = a;
      } else if (k > 0 && count - k < widows) {
        // Too few would go: more go with them, as many as leave `orphans`
        // behind, which may be fewer than `widows` asks for. Of the lines
        // set from this column on, where the block goes on from a column
        // before — and there, where not even all of them are enough, it
        // breaks where it would (as Blink breaks each: seven lines, three
        // to a column, under `widows: 5` are two, three and two).
        const lo = a >= head ? 0 : run.findIndex((line) => line >= head);
        const keep = count - lo - Math.min(block.style.widows, count - lo);
        if (lo === 0 || keep > 0) {
          const stay = Math.max(orphans, keep);
          if (stay < k - lo) at = run[lo + stay];
        }
      }
    }
    next(at, groups[at].top, false);
  }
  return { starts, tops, cut, shortage, over };
}

/** The lines of a block that a line is among, in order: the groups about
 *  it that are lines of its block, past the room between them. */
function linesAbout(groups: Group[], i: number): number[] {
  const block = groups[i].block;
  const run = [i];
  for (let k = i - 1; k >= 0 && groups[k].block === block; k -= 1) {
    if (!groups[k].sliced) run.unshift(k);
  }
  for (let k = i + 1; k < groups.length && groups[k].block === block; k += 1) {
    if (!groups[k].sliced) run.push(k);
  }
  return run;
}

/**
 * The tallest thing in the strip no break may fall inside, which a column
 * is no shorter than: a box that goes whole, a line, and the lines of a
 * block that `orphans` keeps together at its start and `widows` at its end
 * (as Blink's initial balancing pass takes them,
 * `PropagateTallestUnbreakableBlockSize`).
 */
function tallestOf(groups: Group[]): number {
  let tallest = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const block = group.block;
    if (group.sliced) continue;
    if (!block) {
      tallest = Math.max(tallest, group.bottom - group.top);
      continue;
    }
    const run = linesAbout(groups, i);
    const count = run.length;
    const orphans = Math.min(block.style.orphans, count);
    const widows = Math.min(block.style.widows, count);
    tallest = Math.max(
      tallest,
      groups[run[orphans - 1]].bottom - group.top,
      groups[run[count - 1]].bottom - groups[run[count - widows]].top,
    );
    i = run[count - 1];
  }
  return tallest;
}

/**
 * Set a multicol container's content, laid out as one strip at its content
 * box's top, in its columns, and answer their height — the container's
 * content height, where it has none of its own.
 *
 * `strip` is the strip's height, its first and last margins in it, and
 * `limit` the tallest a column may be: the container's own height, or its
 * `max-height`. Past it the content goes on in columns beyond the
 * container's edge (8.2). Under `column-fill: auto` the columns are that
 * tall, each filled before the next is started, and where nothing limits
 * them the first holds everything (7.1).
 */
export function layoutColumns(
  box: Box,
  columns: Columns,
  strip: number,
  limit: number,
  /** Where the strip starts: the content box's top, or under a box that
   *  spans the columns (`spansColumns`). */
  top = box.contentY,
  /** Whether a spanner comes after it: columns before one are balanced,
   *  whatever `column-fill` says (CSS Multi-column 1, 7.1). */
  beforeSpanner = false,
  /** A row of columns among others about spanners (`layoutRows`): where
   *  its content was laid out down a strip that goes on from the row
   *  before's, and the geometry of all the rows it adds its columns to. */
  row?: { from: number; into: ColumnGeometry },
): number {
  // where the strip it is cut from starts, which the columns are set from
  // `top`
  const from = row ? row.from : top;
  const gathered: Gathered = {
    units: [],
    lines: new Map(),
    boxes: new Map(),
    spans: new Map(),
    loose: new Set(),
  };
  gather(box, gathered);
  const groups = groupsOf(gathered.units);
  // as far down as the content goes, past a box with a height it overflows:
  // what stands out of a box takes room in a column as what is in it does
  for (const group of groups) strip = Math.max(strip, group.bottom - from);
  let height: number;
  let filled: Filled;
  // how tall a column is that what is out of the flow is cut into, which
  // a container with less than a column of content is no shorter than
  let columnHeight: number;
  if (box.style.columnFill === 'auto' && !beforeSpanner) {
    height = Number.isFinite(limit) ? limit : strip;
    columnHeight = height;
    filled = fill(groups, from, height, height >= limit);
    // a container with a `max-height` and less than a column of content
    // is as tall as its content
    if (filled.starts.length === 1) height = Math.min(height, strip);
  } else {
    // balanced: the strip shared out, and no shorter than the tallest
    // thing that cannot break; then as much taller as lets the next thing
    // in, until the columns there are hold it all
    height = Math.min(
      limit,
      Math.max(strip / columns.count, tallestOf(groups)),
    );
    filled = fill(groups, from, height, height >= limit);
    for (let pass = 0; pass < 4096; pass += 1) {
      if (filled.starts.length <= columns.count && !filled.over) break;
      if (height >= limit || !Number.isFinite(filled.shortage)) break;
      height = Math.min(limit, height + filled.shortage);
      filled = fill(groups, from, height, height >= limit);
    }
    columnHeight = height;
  }
  // the row of columns this is, for the rules between them: each column
  // that holds something, from the start of the line
  const rtl = box.style.direction === 'rtl';
  const step = columns.width + columns.gap;
  const across = (c: number): number => (rtl ? -c * step : c * step);
  const origin = rtl ? box.contentWidth - columns.width : 0;
  const used = groups.length ? filled.starts.length : 0;
  let rows = COLUMN_BOXES.get(box);
  if (!rows) COLUMN_BOXES.set(box, (rows = []));
  rows.push({
    top: top - box.contentY,
    height,
    lefts: Array.from({ length: used }, (_, c) => origin + across(c)),
    width: columns.width,
  });
  // where each column is, for what is out of the flow inside it, which is
  // laid out after all of this, in the strip (`stripOf`, `cutIntoColumns`)
  const own: ColumnGeometry = {
    container: box,
    tops: [...filled.tops],
    height: columnHeight,
    dx: (c) => origin + across(c),
    dy: (c) => top - (filled.tops[c] ?? filled.tops[0] + c * columnHeight),
  };
  const geometry = row ? joinGeometry(row.into, own) : own;
  GEOMETRY.set(box, geometry);
  columnsSet.any = true;
  // all in one column where it started, and nothing to move — but a float
  // that is cut where the column ends, which may reach past it
  if (
    from === top &&
    !gathered.loose.size &&
    (!groups.length || filled.starts.length === 1)
  ) {
    return height;
  }

  // the column each group starts in, and the one it ends in
  const { starts, tops, cut } = filled;
  let c = 0;
  for (let i = 0; i < groups.length; i += 1) {
    while (
      c + 1 < starts.length &&
      starts[c + 1] <= i &&
      !(starts[c + 1] === i && cut[c + 1])
    ) {
      c += 1;
    }
    groups[i].column = c;
    while (c + 1 < starts.length && starts[c + 1] === i && cut[c + 1]) c += 1;
    groups[i].last = c;
  }
  // the first column at the start of the line: the right, right to left
  place(box, null, {
    gathered,
    tops,
    height,
    dx: (c) => origin + across(c),
    dy: (c) => top - tops[c],
    geometry,
  });
  return height;
}

/**
 * A multicol container's columns as its last layout set them: where each
 * starts down the strip, how tall they are, and how far a piece of the
 * strip is moved to each — past the last column, more of the same height,
 * as content past the container's columns goes on in more of them (8.2).
 */
export interface ColumnGeometry {
  container: Box;
  tops: number[];
  /** Where each column ends down the strip, where they are not all
   *  `height` tall: the rows of columns a spanner parts. */
  ends?: number[];
  height: number;
  dx(column: number): number;
  dy(column: number): number;
}

/** Move where a multicol container's columns are with it, down by `dy`:
 *  what is out of the flow in it is cut into them after the flow, which a
 *  frame of a vertical writing mode moves its content in place before. */
export function moveColumns(box: Box, dy: number): void {
  const geometry = GEOMETRY.get(box);
  if (!geometry) return;
  for (let i = 0; i < geometry.tops.length; i += 1) geometry.tops[i] += dy;
  const ends = geometry.ends;
  if (ends) for (let i = 0; i < ends.length; i += 1) ends[i] += dy;
}

/** Whether a layout has set any columns, which a positioned box asks
 *  before it looks for any (`stripOf`). */
export const columnsSet = { any: false };

/** Each multicol container's columns, as its last layout set them. */
const GEOMETRY = new WeakMap<Box, ColumnGeometry>();

/**
 * The columns of the rows a multicol container's spanners part (CSS
 * Multi-column 1, 6), as one geometry: each row's content was laid out
 * down a strip that goes on from the row before's (`layoutRows`), as
 * Blink's flow thread goes on past a spanner, so a block a spanner breaks
 * is one block down it, and what is positioned in it is laid out against
 * all of it and cut into the columns of both rows (`cutIntoColumns`).
 * Each column where its row's strip had it and as tall as its row's are,
 * and past the last, more of the last row's.
 */
export function joinedGeometry(container: Box): ColumnGeometry {
  const parts: { from: number; geometry: ColumnGeometry }[] = [];
  const at = (c: number): [ColumnGeometry, number] | null => {
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (c >= parts[i].from || i === 0) {
        return [parts[i].geometry, c - parts[i].from];
      }
    }
    return null;
  };
  const geometry: ColumnGeometry = {
    container,
    tops: [],
    ends: [],
    height: 0,
    dx: (c) => {
      const found = at(c);
      return found ? found[0].dx(found[1]) : 0;
    },
    dy: (c) => {
      const found = at(c);
      return found ? found[0].dy(found[1]) : 0;
    },
  };
  JOINED.set(geometry, parts);
  return geometry;
}

const JOINED = new WeakMap<
  ColumnGeometry,
  { from: number; geometry: ColumnGeometry }[]
>();

/** Add a row's columns to the geometry of all the rows (`joinedGeometry`),
 *  and answer that. */
function joinGeometry(
  into: ColumnGeometry,
  own: ColumnGeometry,
): ColumnGeometry {
  const parts = JOINED.get(into);
  if (!parts) return own;
  parts.push({ from: into.tops.length, geometry: own });
  for (const top of own.tops) {
    into.tops.push(top);
    into.ends!.push(top + own.height);
  }
  into.height = own.height;
  return into;
}

/** How far columns moved a box from where the strip had it, and where it
 *  was — what is out of the flow inside the columns is laid out against
 *  (CSS Anchor Positioning 1, 2: a box inside the fragmentation context
 *  sees what is in it unfragmented). */
interface StripPlace {
  geometry: ColumnGeometry;
  dx: number;
  dy: number;
  width: number;
  height: number;
}
const STRIP = new WeakMap<Box, StripPlace>();

/** Note where the strip of `geometry`'s columns had a box the columns took
 *  apart some other way than `place` does: a block a spanner breaks, its
 *  rows one after another down the strip (`layoutRows`). */
export function setStripPlace(
  box: Box,
  geometry: ColumnGeometry,
  dx: number,
  dy: number,
  width: number,
  height: number,
): void {
  STRIP.set(box, { geometry, dx, dy, width, height });
}

/** Where an out-of-flow box's static position was from the corner of the
 *  box it is from, in the strip, before columns moved it (`place`). */
const STRIP_STATIC = new WeakMap<
  Box,
  { x: number; y: number; right: number }
>();

/**
 * Where a box inside a multicol container's columns is in the strip they
 * were cut from — its border box, unfragmented — and those columns; null
 * for a box in no columns. A multicol container is in the columns around
 * it, and not in its own, and a box that spans them, and what is in it, in
 * none.
 */
export function stripOf(box: Box): {
  geometry: ColumnGeometry;
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  let place: StripPlace | null = null;
  let placed: Box | null = null;
  // the nearest multicol container strictly above, and the nearest box
  // between that the columns moved, the box itself among them
  let geometry: ColumnGeometry | null = null;
  for (let at: Box | null = box; at; at = at.parent) {
    // a spanner, and what is in it, is across the columns and in none
    if (at.style.columnSpan && isSpanner(at)) return null;
    if (at !== box) {
      const g = GEOMETRY.get(at);
      if (g) {
        geometry = g;
        break;
      }
    }
    if (!place) {
      const p = STRIP.get(at);
      if (p) {
        place = p;
        placed = at;
      }
    }
  }
  if (!geometry) return null;
  if (!place || place.geometry !== geometry) {
    return {
      geometry,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    };
  }
  const own = placed === box;
  return {
    geometry,
    x: box.x - place.dx,
    y: box.y - place.dy,
    width: own ? place.width : box.width,
    height: own ? place.height : box.height,
  };
}

/** Where a box's static position is in the strip (`stripOf`), from the
 *  box it is from: its corner there, and the position from it. */
export function stripStatic(box: Box): {
  fromX: number;
  fromY: number;
  x: number;
  y: number;
  right: number;
} | null {
  const at = box.staticPosition;
  if (!at || at.inside) return null;
  const from = stripOf(at.from);
  const kept = STRIP_STATIC.get(box);
  if (!from) return null;
  const o = kept ?? at;
  return { fromX: from.x, fromY: from.y, x: o.x, y: o.y, right: o.right };
}

/**
 * Set an out-of-flow box laid out in the strip of `geometry`'s columns in
 * them (CSS Fragmentation 3): moved whole to the column its top is in where
 * it fits there, and otherwise cut where each column ends, its pieces kept
 * beside it as a block's are (`COLUMN_PIECES`). Its strip place is kept for
 * what is positioned against it, and for an anchor reference to it.
 * `move` moves it, and what it holds, but for `stays`.
 */
export function cutIntoColumns(
  box: Box,
  geometry: ColumnGeometry,
  move: (box: Box, dx: number, dy: number) => void,
): void {
  const { tops, height, ends } = geometry;
  if (!(height >= 1)) return;
  const topOf = (c: number) =>
    c < tops.length
      ? tops[c]
      : tops[tops.length - 1] + (c - tops.length + 1) * height;
  const endOf = (c: number) =>
    ends && c < ends.length ? ends[c] : topOf(c) + height;
  let c = 0;
  while (c + 1 < MOST_COLUMNS && topOf(c + 1) <= box.y + EPS) c += 1;
  // a box of no height where a column ends stays in it, as Blink keeps
  // one at the end of a row of columns a spanner ends rather than in the
  // row after it
  if (c > 0 && !(box.height > 0) && Math.abs(endOf(c - 1) - box.y) <= EPS) {
    c -= 1;
  }
  const was = { x: box.x, y: box.y, width: box.width, height: box.height };
  if (was.y + was.height <= endOf(c) + EPS) {
    const dx = geometry.dx(c);
    const dy = geometry.dy(c);
    STRIP.set(box, { geometry, dx, dy, width: was.width, height: was.height });
    if (dx || dy) move(box, dx, dy);
    return;
  }
  const pieces: ColumnPiece[] = [];
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (let k = c; topOf(k) < was.y + was.height - EPS; k += 1) {
    const from = Math.max(was.y, topOf(k));
    const until = Math.min(was.y + was.height, endOf(k));
    const piece: ColumnPiece = {
      x: was.x + geometry.dx(k),
      y: from + geometry.dy(k),
      width: was.width,
      height: Math.max(0, until - from),
      wholeY: was.y + geometry.dy(k),
      wholeHeight: was.height,
    };
    pieces.push(piece);
    x1 = Math.min(x1, piece.x);
    y1 = Math.min(y1, piece.y);
    x2 = Math.max(x2, piece.x + piece.width);
    y2 = Math.max(y2, piece.y + piece.height);
    if (pieces.length >= MOST_COLUMNS) break;
  }
  // what it holds cut as it is, each piece in the column it reaches down
  // the strip: its in-flow boxes, and its lines a line at a time (what is
  // out of the flow in it is laid out after it, and cut by itself)
  for (const line of box.lines ?? []) {
    let k = 0;
    while (k + 1 < MOST_COLUMNS && topOf(k + 1) <= line.y + EPS) k += 1;
    shiftLine(line, geometry.dx(k), geometry.dy(k));
  }
  for (const child of box.children) {
    if (child.outOfFlow || child.kind === 'text' || child.kind === 'break') {
      continue;
    }
    cutIntoColumns(child, geometry, move);
  }
  COLUMN_PIECES.set(box, pieces);
  columned.any = true;
  box.x = x1;
  box.y = y1;
  box.width = x2 - x1;
  box.height = y2 - y1;
  STRIP.set(box, {
    geometry,
    dx: x1 - was.x,
    dy: y1 - was.y,
    width: was.width,
    height: was.height,
  });
}

interface Placing {
  geometry: ColumnGeometry;
  gathered: Gathered;
  /** Where each column starts, down the strip. */
  tops: number[];
  height: number;
  dx(column: number): number;
  dy(column: number): number;
}

function shift(box: Box, column: number, to: Placing): void {
  const dx = to.dx(column);
  const dy = to.dy(column);
  STRIP.set(box, {
    geometry: to.geometry,
    dx,
    dy,
    width: box.width,
    height: box.height,
  });
  moveTo(box, box.x + dx, box.y + dy);
}

function shiftLine(line: LineBox, dx: number, dy: number): void {
  line.x += dx;
  line.y += dy;
  for (const text of line.texts) {
    text.drawX += dx;
    text.drawY += dy;
  }
  for (const placed of line.atomics) {
    placed.x += dx;
    placed.y += dy;
    moveTo(placed.box, placed.box.x + dx, placed.box.y + dy);
  }
  for (const edge of line.edges ?? []) edge.x += dx;
}

/** The column a point down the strip is in, between boxes: at a break it
 *  is in the column the break ends, which is where Blink leaves what is out
 *  of the flow and stood before the box the next column starts with. */
function columnAt(y: number, tops: number[]): number {
  let c = 0;
  while (c + 1 < tops.length && tops[c + 1] < y - EPS) c += 1;
  return c;
}

/**
 * Move what a box holds to its columns: the container's content, with no
 * `span`, or that of a box a break falls inside, which is then its pieces.
 */
function place(box: Box, span: [Unit, Unit] | null, to: Placing): void {
  const { gathered } = to;
  const first = span ? span[0].group.column : 0;
  const last = span ? span[1].group.last : to.tops.length - 1;
  if (span && first === last && !gathered.loose.has(box)) {
    shift(box, first, to);
    return;
  }
  const was = { x: box.x, y: box.y, width: box.width, height: box.height };
  const lines = box.lines;
  // what is out of the flow goes from where it would have stood, which is
  // kept from this box's corner: in the column of the line it would have
  // been on, or of the boxes it would have been between
  const asides: [Box, number][] = [];
  const aside = (child: Box): void => {
    const at = child.staticPosition;
    if (!child.outOfFlow || !at || at.from !== box) return;
    const y = was.y + at.y;
    let c = columnAt(y, to.tops);
    if (lines?.length) {
      let on = lines[0];
      for (const line of lines) {
        if (line.y > y + EPS) break;
        on = line;
      }
      c = gathered.lines.get(on)!.group.column;
    }
    asides.push([child, Math.min(last, Math.max(first, c))]);
  };
  if (lines?.length) eachAside(box, aside);
  else for (const child of box.children) aside(child);
  if (lines?.length) {
    for (const line of lines) {
      const c = gathered.lines.get(line)!.group.column;
      shiftLine(line, to.dx(c), to.dy(c));
    }
    if (first !== last) {
      COLUMN_LINES.add(lines);
      rowsOf(lines, gathered);
      columned.any = true;
    }
    eachAside(box, (aside) => {
      const unit = gathered.boxes.get(aside);
      if (unit) place(aside, [unit, unit], to);
      else if (aside.isFloat && !aside.outOfFlow) cutFloat(aside, to);
    });
  } else {
    for (const child of box.children) {
      // a box that goes whole, or is cut where it holds nothing
      const unit = gathered.boxes.get(child);
      const inner = unit ? ([unit, unit] as [Unit, Unit]) : undefined;
      const range = inner ?? gathered.spans.get(child);
      if (range) place(child, range, to);
      else if (child.isFloat && !child.outOfFlow) cutFloat(child, to);
    }
  }
  if (span && first === last) {
    // in one column, with a float in it that went its own way: the box
    // itself, which what it holds was moved without
    STRIP.set(box, {
      geometry: to.geometry,
      dx: to.dx(first),
      dy: to.dy(first),
      width: box.width,
      height: box.height,
    });
    box.x += to.dx(first);
    box.y += to.dy(first);
    if (box.marker) {
      box.marker.x += to.dx(first);
      box.marker.y += to.dy(first);
    }
  } else if (span) {
    const pieces: ColumnPiece[] = [];
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    const end = was.y + was.height;
    for (let c = first; c <= last; c += 1) {
      // no further than the box goes: what is gathered of one that holds
      // nothing of its own runs to the next unit of the flow, which may be
      // a column on
      if (c > first && to.tops[c] >= end - EPS) break;
      const from = c === first ? was.y : to.tops[c];
      const until = c === last ? end : Math.min(end, to.tops[c] + to.height);
      const piece: ColumnPiece = {
        x: was.x + to.dx(c),
        y: from + to.dy(c),
        width: was.width,
        height: Math.max(0, until - from),
        wholeY: was.y + to.dy(c),
        wholeHeight: was.height,
      };
      pieces.push(piece);
      x1 = Math.min(x1, piece.x);
      y1 = Math.min(y1, piece.y);
      x2 = Math.max(x2, piece.x + piece.width);
      y2 = Math.max(y2, piece.y + piece.height);
    }
    COLUMN_PIECES.set(box, pieces);
    columned.any = true;
    STRIP.set(box, {
      geometry: to.geometry,
      dx: x1 - was.x,
      dy: y1 - was.y,
      width: was.width,
      height: was.height,
    });
    if (box.marker) {
      box.marker.x += to.dx(first);
      box.marker.y += to.dy(first);
    }
    box.x = x1;
    box.y = y1;
    box.width = x2 - x1;
    box.height = y2 - y1;
  }
  for (const [child, c] of asides) {
    const at = child.staticPosition!;
    STRIP_STATIC.set(child, { x: at.x, y: at.y, right: at.right });
    const width = at.right - at.x;
    at.x = was.x + at.x + to.dx(c) - box.x;
    at.right = at.x + width;
    at.y = was.y + at.y + to.dy(c) - box.y;
  }
}

/**
 * A float that can be cut anywhere, set in the columns it reaches: from
 * where it starts to the foot of that column, and then down each column
 * after it from the top, as much of it as is left. By how much of it each
 * column has taken, and not by where the strip has it: the flow beside it
 * drops a margin at a break, and the float has none there to drop.
 */
function cutFloat(float: Box, to: Placing): void {
  const { tops, height } = to;
  let c = 0;
  while (c + 1 < tops.length && tops[c + 1] <= float.y + EPS) c += 1;
  // past the foot of its column, in the margin a break dropped: at the
  // head of the next
  let at = float.y - tops[c];
  if (at >= height - EPS && c + 1 < tops.length) {
    c += 1;
    at = 0;
  }
  const was = {
    x: float.x,
    y: float.y,
    width: float.width,
    height: float.height,
  };
  if (at + was.height <= height + EPS || !(height >= 1)) {
    moveTo(float, was.x + to.dx(c), tops[0] + at);
    return;
  }
  const pieces: ColumnPiece[] = [];
  let taken = 0;
  let x1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  const head = tops[0];
  for (let k = c; taken < was.height - EPS; k += 1) {
    const from = k === c ? at : 0;
    const part = Math.min(was.height - taken, height - from);
    const x = was.x + to.dx(k);
    pieces.push({
      x,
      y: head + from,
      width: was.width,
      height: part,
      wholeY: head + from - taken,
      wholeHeight: was.height,
    });
    x1 = Math.min(x1, x);
    x2 = Math.max(x2, x + was.width);
    y2 = Math.max(y2, head + from + part);
    taken += part;
    if (pieces.length >= MOST_COLUMNS) break;
  }
  COLUMN_PIECES.set(float, pieces);
  columned.any = true;
  float.x = x1;
  float.y = Math.min(head + at, head);
  float.width = x2 - x1;
  float.height = y2 - float.y;
}

/**
 * The rows each text's layout has in each column, for the layouts whose
 * lines columns took apart (`COLUMN_ROWS`).
 */
function rowsOf(lines: LineBox[], gathered: Gathered): void {
  const byLayout = new Map<LineText['layout'], Map<number, LineText[]>>();
  for (const line of lines) {
    const c = gathered.lines.get(line)!.group.column;
    for (const text of line.texts) {
      let columns = byLayout.get(text.layout);
      if (!columns) byLayout.set(text.layout, (columns = new Map()));
      const texts = columns.get(c);
      if (texts) texts.push(text);
      else columns.set(c, [text]);
    }
  }
  for (const [layout, columns] of byLayout) {
    if (columns.size < 2) continue;
    const end = layout.lines.length - 1;
    for (const texts of columns.values()) {
      let top = Infinity;
      let bottom = -Infinity;
      let open = 0;
      for (const text of texts) {
        const natural = layout.lines[text.layoutLine];
        if (!natural) continue;
        top = Math.min(top, natural.y);
        bottom = Math.max(bottom, natural.y + natural.height);
        if (text.layoutLine === 0) open |= 1;
        if (text.layoutLine === end) open |= 2;
      }
      if (top === Infinity) continue;
      const rows = {
        top: open & 1 ? top - REACH : top,
        bottom: open & 2 ? bottom + REACH : bottom,
      };
      for (const text of texts) COLUMN_ROWS.set(text, rows);
    }
  }
}

/**
 * Whether a box is set across all the columns of the multicol container it
 * is a child of (`column-span: all`, CSS Multi-column 1, 6): a block-level
 * box in its flow.
 */
export function spansColumns(box: Box): boolean {
  return (
    box.style.columnSpan &&
    flows(box) &&
    // block-level: on an inline-block it does nothing
    !box.style.display.startsWith('inline')
  );
}

/**
 * Whether a box spans the columns of a multicol container it is in, at any
 * depth (CSS Multi-column 1, 6): `spansColumns`, and every box between it
 * and the container a block in the container's flow and formatting
 * context. One in a formatting context of its own — a flex item, a box that
 * scrolls, a float — is set in its column as it would be without, as all
 * three engines have it.
 */
export function isSpanner(box: Box): boolean {
  if (!spansColumns(box)) return false;
  for (let at = box.parent; at; at = at.parent) {
    if (at.kind !== 'block') return false;
    if (at.style.columns) return true;
    if (!flows(at) || establishesBFC(at)) return false;
  }
  return false;
}

/**
 * The next box up a chain of containing blocks: the parent, but for a
 * spanner, whose containing block is the multicol container it spans (CSS
 * Multi-column 1, 6), past the boxes it is laid out through. What is
 * positioned in a spanner and not in it is positioned in the container,
 * and an anchor in one is in none of those boxes.
 */
export function containingParent(box: Box): Box | null {
  if (box.style.columnSpan && isSpanner(box)) {
    for (let at = box.parent; at; at = at.parent) {
      if (at.style.columns) return at;
    }
  }
  return box.parent;
}

/** Whether a block in a multicol container's flow is one a spanner is laid
 *  out through: what its content is, in its turn, is the container's. */
function spannedThrough(box: Box): boolean {
  return (
    box.kind === 'block' &&
    flows(box) &&
    !box.style.columns &&
    !establishesBFC(box)
  );
}

/**
 * A multicol container's content cut about the boxes that span its columns
 * (CSS Multi-column 1, 6): the rows of columns there are, one more than the
 * spanners, and what each box a spanner is in holds of each row it is in.
 * Null where no spanner is in it. A box a spanner is in is in each row from
 * the one before the first spanner in it to the one after the last, its
 * top edges in the first and its bottom ones in the last.
 */
export interface SpannedRows {
  spanners: Box[];
  /** The container and each box a spanner is in: what it holds of each
   *  row, by the row's index, and the first and the last it is in. */
  slices: Map<Box, { rows: Box[][]; first: number; last: number }>;
}

export function spannedRows(box: Box): SpannedRows | null {
  const spanners: Box[] = [];
  const slices: SpannedRows['slices'] = new Map();
  const holds = new Map<Box, boolean>();
  const hasSpanner = (b: Box, depth: number): boolean => {
    let found = holds.get(b);
    if (found !== undefined) return found;
    found = false;
    if (depth < 64) {
      for (const child of b.children) {
        if (spansColumns(child)) found = true;
        else if (spannedThrough(child) && hasSpanner(child, depth + 1)) {
          found = true;
        }
      }
    }
    holds.set(b, found);
    return found;
  };
  if (!hasSpanner(box, 0)) return null;
  const split = (b: Box, from: number): number => {
    const rows: Box[][] = [[]];
    let r = from;
    const row = (): Box[] => (rows[r - from] ??= []);
    row();
    for (const child of b.children) {
      if (spansColumns(child)) {
        spanners.push(child);
        r += 1;
        row();
      } else if (spannedThrough(child) && holds.get(child)) {
        const end = split(child, r);
        for (let i = r; i <= end; i += 1) {
          (rows[i - from] ??= []).push(child);
        }
        r = end;
      } else {
        row().push(child);
      }
    }
    const all: Box[][] = [];
    for (let i = 0; i < from; i += 1) all.push([]);
    for (let i = from; i <= r; i += 1) all.push(rows[i - from] ?? []);
    slices.set(b, { rows: all, first: from, last: r });
    return r;
  };
  split(box, 0);
  return { spanners, slices };
}

/** Forget the pieces an earlier layout broke a box's content in, where
 *  this one sets it in one column. */
export function forgetColumns(box: Box): void {
  if (!columned.any) return;
  for (const child of box.children) {
    if (!flows(child) || child.kind !== 'block') continue;
    if (COLUMN_PIECES.delete(child) || !whole(child)) forgetColumns(child);
  }
}
