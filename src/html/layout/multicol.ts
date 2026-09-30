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
  column: 0,
  last: 0,
};

/** Whether no break may fall inside a box, whatever it holds: it is
 *  monolithic, or says so. It goes to a column with all that is in it. */
function whole(box: Box): boolean {
  if (box.kind !== 'block') return true;
  if (box.style.breakInside === 'avoid') return true;
  return establishesBFC(box) || transformed(box.style);
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
    group: NO_GROUP,
  };
  into.units.push(unit);
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
    group: NO_GROUP,
  };
  into.units.push(unit);
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
        group: NO_GROUP,
      };
      into.units.push(unit);
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
        group: NO_GROUP,
      };
      into.units.push(unit);
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
        group: NO_GROUP,
      };
      into.units.push(unit);
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
    } else {
      group = {
        top: unit.top,
        bottom: unit.bottom,
        block: unit.block,
        sliced: unit.sliced,
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
function fill(groups: Group[], top: number, height: number): Filled {
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
    if (i === head) {
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
        if (a === head) {
          // at the head of the column already: they stay, and hang out
          missed(run[orphans - 1]);
          over = true;
          i = run[orphans - 1] + 1;
          goesOn = false;
          continue;
        }
        // too few would stay: the block goes to the next column whole
        missed(run[orphans - 1]);
        at = a;
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
): number {
  const gathered: Gathered = {
    units: [],
    lines: new Map(),
    boxes: new Map(),
    spans: new Map(),
    loose: new Set(),
  };
  gather(box, gathered);
  const groups = groupsOf(gathered.units);
  const top = box.contentY;
  // as far down as the content goes, past a box with a height it overflows:
  // what stands out of a box takes room in a column as what is in it does
  for (const group of groups) strip = Math.max(strip, group.bottom - top);
  let height: number;
  let filled: Filled;
  if (box.style.columnFill === 'auto') {
    height = Number.isFinite(limit) ? limit : strip;
    filled = fill(groups, top, height);
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
    filled = fill(groups, top, height);
    for (let pass = 0; pass < 4096; pass += 1) {
      if (filled.starts.length <= columns.count && !filled.over) break;
      if (height >= limit || !Number.isFinite(filled.shortage)) break;
      height = Math.min(limit, height + filled.shortage);
      filled = fill(groups, top, height);
    }
  }
  // all in one column where it started, and nothing to move — but a float
  // that is cut where the column ends, which may reach past it
  if (!gathered.loose.size && (!groups.length || filled.starts.length === 1)) {
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
  const step = columns.width + columns.gap;
  // the first column at the start of the line: the right, right to left
  const rtl = box.style.direction === 'rtl';
  const across = (c: number): number => (rtl ? -c * step : c * step);
  const origin = rtl ? box.contentWidth - columns.width : 0;
  place(box, null, {
    gathered,
    tops,
    height,
    dx: (c) => origin + across(c),
    dy: (c) => top - tops[c],
  });
  return height;
}

interface Placing {
  gathered: Gathered;
  /** Where each column starts, down the strip. */
  tops: number[];
  height: number;
  dx(column: number): number;
  dy(column: number): number;
}

function shift(box: Box, column: number, to: Placing): void {
  moveTo(box, box.x + to.dx(column), box.y + to.dy(column));
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
    for (let c = first; c <= last; c += 1) {
      const from = c === first ? was.y : to.tops[c];
      const until = c === last ? was.y + was.height : to.tops[c] + to.height;
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

/** Forget the pieces an earlier layout broke a box's content in, where
 *  this one sets it in one column. */
export function forgetColumns(box: Box): void {
  if (!columned.any) return;
  for (const child of box.children) {
    if (!flows(child) || child.kind !== 'block') continue;
    if (COLUMN_PIECES.delete(child) || !whole(child)) forgetColumns(child);
  }
}
