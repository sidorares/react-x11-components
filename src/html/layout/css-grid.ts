// `display: grid`, the subset documents are written in (CSS Grid 1).
//
// Tailwind's `grid grid-cols-3 gap-4`, a card list of `repeat(auto-fill,
// minmax(16rem, 1fr))`, a sidebar and a column in `16rem 1fr`: explicit
// column tracks of lengths, percentages, `fr`s, `auto` and `minmax()`, with
// `repeat()` by a count or by what fits; rows as tall as what is in them, or
// as the rows the template names; items placed by line or span, or in order
// into the first cell free; gaps; and each item stretched to its area or
// aligned in it. Not here: named lines and areas, `dense` and column-first
// placement, subgrids, baseline alignment, and an item spanning an `fr`
// track counting towards its size.
//
// A grid container is a flex container to the box tree (`display: grid`
// reads as `flex` and sets `ComputedStyle.grid`): its children are the
// same blockified items, it holds its floats, and `flex.ts` hands it here.
// Unlike flex, the algorithm is written out rather than handed to Yoga,
// which has none; what it needs of an item — its width at no limit and at
// the smallest, and its height at a width — is what tables already ask.
import { AUTO, isPct, resolve } from '../css/values.js';
import type { GridLine, GridTrack } from '../css/style.js';
import { Box } from './boxes.js';
import {
  MIN_CONTENT_PROBE,
  exactMinContent,
  measureIntrinsicWidth,
  moveTo,
  resolveEdges,
} from './block.js';
import type { LayoutContext } from './block.js';

interface Item {
  box: Box;
  col: number;
  cols: number;
  row: number;
  rows: number;
  /** Min-content and max-content widths, margin box, taken when asked. */
  min: number;
  max: number;
}

/**
 * Lay out a grid container's children. Returns the content height.
 */
export function layoutGrid(
  box: Box,
  ctx: LayoutContext,
  contentWidth: number,
): number {
  const style = box.style;
  const boxes: Box[] = [];
  for (const child of box.children) {
    if (child.kind === 'text' && !child.text.trim()) continue;
    if (child.outOfFlow) {
      ctx.positioned.push({ box: child, containing: box });
      continue;
    }
    resolveEdges(child, Number.isFinite(contentWidth) ? contentWidth : 0);
    boxes.push(child);
  }
  const colGap = style.columnGap;
  const rowGap = style.rowGap;

  const template = columnTracks(box, contentWidth, colGap);
  const items = place(boxes, template.length);
  const cols = template.slice();
  // an item placed past the template's last column makes columns of its own
  const widest = items.reduce(
    (n, item) => Math.max(n, item.col + item.cols),
    0,
  );
  while (cols.length < widest) cols.push(AUTO_TRACK);

  const measure = (item: Item): void => {
    if (item.max >= 0) return;
    const box = item.box;
    const margins = box.marginLeft + box.marginRight;
    // Measured once in the box's life, as a table cell's are: measured for
    // every layout of the grid, a grid in a grid in a grid laid out its
    // innermost three times a level, and twelve levels took two thirds of
    // a second.
    const fresh = box.intrinsicMaxContent < 0;
    item.max = maxContentOf(box, ctx) + margins;
    if (box.intrinsicMinContent < 0) {
      // where its words say it exactly, read from the layout just made —
      // which is the max-content one only if it was made just now
      const exact = fresh && ctx.fonts ? exactMinContent(box, ctx.fonts) : null;
      box.intrinsicMinContent =
        exact ?? measureIntrinsicWidth(box, ctx, MIN_CONTENT_PROBE);
    }
    item.min = box.intrinsicMinContent + margins;
  };
  const widths = sizeColumns(cols, items, contentWidth, colGap, measure);
  const lefts: number[] = [];
  let x = 0;
  for (const w of widths) {
    lefts.push(x);
    x += w + colGap;
  }

  // each item at its area's width, for its height
  for (const item of items)
    layoutItem(item, areaWidth(item, widths, colGap), ctx);

  const rowCount = items.reduce(
    (n, item) => Math.max(n, item.row + item.rows),
    0,
  );
  const heights = sizeRows(box, rowCount, items, rowGap);
  const tops: number[] = [];
  let y = 0;
  for (const h of heights) {
    tops.push(y);
    y += h + rowGap;
  }
  const height = heights.length ? y - rowGap : 0;

  for (const item of items) {
    const child = item.box;
    const area = areaWidth(item, widths, colGap);
    const tall = spanned(heights, item.row, item.rows, rowGap);
    const justify =
      child.style.justifySelf === 'auto'
        ? style.justifyItems
        : child.style.justifySelf;
    const align =
      child.style.alignSelf === AUTO ? style.alignItems : child.style.alignSelf;
    const outerWidth = child.width + child.marginLeft + child.marginRight;
    const outerHeight = child.height + child.marginTop + child.marginBottom;
    let dx = 0;
    if (justify === 'center') dx = (area - outerWidth) / 2;
    else if (justify === 'flex-end') dx = area - outerWidth;
    let dy = 0;
    if (align === 'center') dy = (tall - outerHeight) / 2;
    else if (align === 'flex-end') dy = tall - outerHeight;
    else if (
      (align === 'stretch' || align === 'baseline') &&
      child.style.height === AUTO
    ) {
      // a stretched item fills its area, and its background with it
      const stretched = tall - child.marginTop - child.marginBottom;
      if (stretched > child.height) child.height = stretched;
    }
    moveTo(
      child,
      box.contentX + lefts[item.col] + child.marginLeft + Math.max(0, dx),
      box.contentY + tops[item.row] + child.marginTop + Math.max(0, dy),
    );
  }
  return height;
}

const AUTO_TRACK: GridTrack = { min: AUTO, max: AUTO };

/** The explicit column tracks, a `repeat()` of what fits counted out
 *  against the width (CSS Grid 1, 7.2.3.2). */
function columnTracks(box: Box, width: number, gap: number): GridTrack[] {
  const template = box.style.gridColumns;
  if (!template) return [AUTO_TRACK];
  const tracks = template.tracks.slice();
  if (template.repeat) {
    const { at, tracks: unit } = template.repeat;
    // what one repetition takes: its tracks' maximums where those are
    // lengths, and their minimums where not (7.2.3.2)
    const base = Number.isFinite(width) ? width : 0;
    const fixed = (track: GridTrack): number =>
      lengthOf(track.max, base) ?? lengthOf(track.min, base) ?? 0;
    const others = tracks.reduce((sum, t) => sum + fixed(t), 0);
    const each = unit.reduce((sum, t) => sum + fixed(t), 0);
    let count = 1;
    if (Number.isFinite(width) && each > 0) {
      const room = width - others - gap * tracks.length;
      count = Math.max(
        1,
        Math.floor((room + gap) / (each + gap * unit.length)),
      );
    }
    const repeated: GridTrack[] = [];
    for (let i = 0; i < Math.min(count, 1000); i += 1) repeated.push(...unit);
    tracks.splice(at, 0, ...repeated);
  }
  return tracks.length ? tracks : [AUTO_TRACK];
}

/**
 * Place the items (CSS Grid 1, 8.5): one with a definite column line where
 * it says, the rest in order into the first row with room, a row after
 * another, as `grid-auto-flow: row` has it.
 */
function place(boxes: Box[], columns: number): Item[] {
  const items: Item[] = [];
  const taken: boolean[][] = [];
  const free = (row: number, col: number, rows: number, cols: number) => {
    for (let r = row; r < row + rows; r += 1) {
      for (let c = col; c < col + cols; c += 1) if (taken[r]?.[c]) return false;
    }
    return true;
  };
  const take = (row: number, col: number, rows: number, cols: number) => {
    for (let r = row; r < row + rows; r += 1) {
      const line = (taken[r] ??= []);
      for (let c = col; c < col + cols; c += 1) line[c] = true;
    }
  };
  let cursorRow = 0;
  let cursorCol = 0;
  for (const box of boxes) {
    const style = box.style;
    const [col, width] = span(
      style.gridColumnStart,
      style.gridColumnEnd,
      columns,
    );
    const [row, rows] = span(style.gridRowStart, style.gridRowEnd, Infinity);
    let at: [number, number];
    if (col !== null && row !== null) at = [row, col];
    else if (col !== null) {
      // a definite column: the first row from the cursor with it free
      let r = col < cursorCol ? cursorRow + 1 : cursorRow;
      while (!free(r, col, rows, width)) r += 1;
      at = [r, col];
    } else if (row !== null) {
      let c = 0;
      while (!free(row, c, rows, width) && c < 10_000) c += 1;
      at = [row, c];
    } else {
      let r = cursorRow;
      let c = cursorCol;
      for (;;) {
        if (c + width > Math.max(columns, width)) {
          r += 1;
          c = 0;
          continue;
        }
        if (free(r, c, rows, width)) break;
        c += 1;
      }
      at = [r, c];
    }
    take(at[0], at[1], rows, width);
    if (col === null && row === null) {
      cursorRow = at[0];
      cursorCol = at[1] + width;
    }
    items.push({
      box,
      row: at[0],
      rows,
      col: at[1],
      cols: width,
      min: -1,
      max: -1,
    });
  }
  return items;
}

/** A start and an end line as a zero-based start, or null for auto, and a
 *  span; a negative line counts back from the explicit grid's end. */
function span(
  start: GridLine,
  end: GridLine,
  tracks: number,
): [number | null, number] {
  const line = (l: GridLine): number | null => {
    if (!l || !('line' in l)) return null;
    if (l.line > 0) return l.line - 1;
    return Number.isFinite(tracks) ? Math.max(0, tracks + 1 + l.line) : null;
  };
  const from = line(start);
  const to = line(end);
  const count = (l: GridLine) => (l && 'span' in l ? l.span : null);
  if (from !== null && to !== null) {
    return to > from
      ? [from, to - from]
      : [Math.min(from, to), Math.max(1, from - to)];
  }
  if (from !== null) return [from, count(end) ?? 1];
  if (to !== null) {
    const n = count(start) ?? 1;
    return [Math.max(0, to - n), n];
  }
  return [null, count(start) ?? count(end) ?? 1];
}

/**
 * The columns' widths (CSS Grid 1, 11.5 and 11.7, simplified): a length is
 * itself; a content-sized minimum is the widest min-content of the items in
 * that column alone, and a content-sized maximum the widest max-content,
 * which the tracks grow towards with the room there is; the `fr` tracks
 * share what is left by their factors, none below its minimum; and with no
 * `fr` track, the `auto` tracks share what is left over, as
 * `justify-content: normal` stretches them.
 */
function sizeColumns(
  tracks: GridTrack[],
  items: Item[],
  width: number,
  gap: number,
  measure: (item: Item) => void,
): number[] {
  const finite = Number.isFinite(width);
  const n = tracks.length;
  const alone = (i: number) =>
    items.filter((it) => it.col === i && it.cols === 1);
  const content = (i: number, which: 'min' | 'max'): number => {
    let widest = 0;
    for (const item of alone(i)) {
      measure(item);
      widest = Math.max(widest, which === 'min' ? item.min : item.max);
    }
    return widest;
  };
  const length = (len: GridTrack['min'] | GridTrack['max']): number | null =>
    typeof len === 'number' || finite ? lengthOf(len, width) : null;
  const isFr = (t: GridTrack) =>
    typeof t.max === 'object' && t.max !== null && 'fr' in t.max;
  const base: number[] = [];
  const limit: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = tracks[i];
    const min =
      length(t.min) ??
      (t.min === 'max-content' ? content(i, 'max') : content(i, 'min'));
    let max: number;
    if (isFr(t)) max = finite ? Infinity : content(i, 'max');
    else {
      max =
        length(t.max) ??
        (t.max === 'min-content' ? content(i, 'min') : content(i, 'max'));
    }
    base.push(min);
    limit.push(Math.max(min, max));
  }
  // an item spanning tracks widens the last of them to its min-content
  for (const item of items) {
    if (item.cols < 2) continue;
    measure(item);
    const covered =
      base.slice(item.col, item.col + item.cols).reduce((a, b) => a + b, 0) +
      gap * (item.cols - 1);
    if (item.min > covered)
      base[item.col + item.cols - 1] += item.min - covered;
  }
  const sizes = base.slice();
  if (!finite) {
    return sizes.map((s, i) => (Number.isFinite(limit[i]) ? limit[i] : s));
  }
  let free =
    width - gap * Math.max(0, n - 1) - sizes.reduce((a, b) => a + b, 0);
  // grow the tracks that are not flexible towards their maximums
  const growing = () =>
    sizes
      .map((s, i) => (isFr(tracks[i]) ? 0 : Math.max(0, limit[i] - s)))
      .reduce((a, b) => a + b, 0);
  const want = growing();
  if (want > 0 && free > 0) {
    const share = Math.min(1, free / want);
    for (let i = 0; i < n; i += 1) {
      if (isFr(tracks[i])) continue;
      const grow = Math.max(0, limit[i] - sizes[i]) * share;
      sizes[i] += grow;
      free -= grow;
    }
  }
  const flexible = tracks
    .map((t, i) => (isFr(t) ? i : -1))
    .filter((i) => i >= 0);
  if (flexible.length) {
    // what an `fr` is worth, found again without any track whose minimum
    // is more than its share (11.7.1)
    let pool = free + flexible.reduce((sum, i) => sum + sizes[i], 0);
    let open = flexible.slice();
    for (let pass = 0; pass < n + 1; pass += 1) {
      const factors = open.reduce(
        (sum, i) => sum + (tracks[i].max as { fr: number }).fr,
        0,
      );
      const unit = factors > 0 ? Math.max(0, pool) / Math.max(1, factors) : 0;
      const frozen = open.filter(
        (i) => base[i] > unit * (tracks[i].max as { fr: number }).fr,
      );
      if (!frozen.length) {
        for (const i of open)
          sizes[i] = unit * (tracks[i].max as { fr: number }).fr;
        break;
      }
      for (const i of frozen) {
        sizes[i] = base[i];
        pool -= base[i];
      }
      open = open.filter((i) => !frozen.includes(i));
      if (!open.length) break;
    }
    return sizes;
  }
  // no flexible track: the auto ones stretch into what is left
  if (free > 0) {
    const stretchy = tracks
      .map((t, i) => (t.max === AUTO ? i : -1))
      .filter((i) => i >= 0);
    for (const i of stretchy) sizes[i] += free / stretchy.length;
  }
  return sizes;
}

/** A track's minimum or maximum where it is a length or a percentage of
 *  `base`, never below zero; null where it is content or an `fr`. */
function lengthOf(
  len: GridTrack['min'] | GridTrack['max'],
  base: number,
): number | null {
  if (typeof len === 'number') return Math.max(0, len);
  if (typeof len === 'object' && len !== null && !('fr' in len) && isPct(len)) {
    return Math.max(0, resolve(len, base));
  }
  return null;
}

function areaWidth(item: Item, widths: number[], gap: number): number {
  return spanned(widths, item.col, item.cols, gap);
}

function spanned(sizes: number[], from: number, count: number, gap: number) {
  let sum = 0;
  for (let i = from; i < from + count && i < sizes.length; i += 1)
    sum += sizes[i];
  return sum + gap * Math.max(0, Math.min(count, sizes.length - from) - 1);
}

/** An item's max-content width, its border box's: measured once in the
 *  box's life, as a table cell's is (`Box.intrinsicMaxContent`). */
function maxContentOf(box: Box, ctx: LayoutContext): number {
  if (box.intrinsicMaxContent < 0) {
    box.intrinsicMaxContent = measureIntrinsicWidth(box, ctx, Infinity);
  }
  return box.intrinsicMaxContent;
}

/** Lay an item out in its area: stretched across it where its width is
 *  `auto` and it is stretched, or at its content's width, no wider than
 *  the area, where it is aligned instead. */
function layoutItem(item: Item, area: number, ctx: LayoutContext): void {
  const child = item.box;
  const style = child.style;
  const parent = child.parent?.style;
  const justify =
    style.justifySelf === 'auto'
      ? (parent?.justifyItems ?? 'stretch')
      : style.justifySelf;
  const margins = child.marginLeft + child.marginRight;
  const room = Math.max(0, area - margins);
  let width: number;
  if (style.width !== AUTO) {
    const extra = style.boxSizing === 'border-box' ? 0 : child.horizontalExtra;
    width = resolve(style.width, area, room - extra) + extra;
  } else if (justify === 'stretch') width = room;
  else {
    if (item.max < 0) item.max = maxContentOf(child, ctx) + margins;
    width = Math.min(item.max - margins, room);
  }
  ctx.layoutSubtree(child, width);
}

/**
 * The rows' heights: a length the template gives a row is its height, and
 * an `auto` row is as tall as the tallest item in it alone; an item
 * spanning rows makes the last of them taller by what it needs past them.
 */
function sizeRows(
  box: Box,
  count: number,
  items: Item[],
  gap: number,
): number[] {
  const style = box.style;
  const explicit = style.gridRows?.tracks ?? [];
  const heights: number[] = [];
  for (let r = 0; r < count; r += 1) {
    const track = explicit[r] ?? style.gridAutoRows;
    const fixed = typeof track.min === 'number' ? track.min : 0;
    const max = typeof track.max === 'number' ? track.max : Infinity;
    let tallest = fixed;
    if (!(typeof track.max === 'number' && typeof track.min === 'number')) {
      for (const item of items) {
        if (item.row !== r || item.rows !== 1) continue;
        const b = item.box;
        tallest = Math.max(tallest, b.height + b.marginTop + b.marginBottom);
      }
    }
    heights.push(Math.min(Math.max(tallest, fixed), Math.max(max, fixed)));
  }
  for (const item of items) {
    if (item.rows < 2) continue;
    const b = item.box;
    const need = b.height + b.marginTop + b.marginBottom;
    const have = spanned(heights, item.row, item.rows, gap);
    if (need > have) heights[item.row + item.rows - 1] += need - have;
  }
  return heights;
}
