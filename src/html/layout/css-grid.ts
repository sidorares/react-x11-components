// `display: grid`, the subset documents are written in (CSS Grid 1).
//
// Tailwind's `grid grid-cols-3 gap-4`, a card list of `repeat(auto-fill,
// minmax(16rem, 1fr))`, a sidebar and a column in `16rem 1fr`, a page of
// `auto 1fr auto` rows: tracks of lengths, percentages, `fr`s, `auto`,
// `minmax()` and `fit-content()`, with `repeat()` by a count or by what
// fits, sized by what is in them as the track sizing algorithm has it
// (`tracks.ts`); items placed by line or span, or in order into the first
// cell free; gaps; the tracks placed by `justify-content` and
// `align-content`; and each item stretched to its area or aligned in it.
// Not here: named lines and areas, `dense` and column-first placement,
// subgrids, and baseline alignment.
//
// A grid container is a flex container to the box tree (`display: grid`
// reads as `flex` and sets `ComputedStyle.grid`): its children are the
// same blockified items, it holds its floats, and `flex.ts` hands it here.
// Unlike flex, the algorithm is written out rather than handed to Yoga,
// which has none; what it needs of an item — its width at no limit and at
// the smallest, and its height at a width — is what tables already ask.
import { AUTO, isPct, resolve, resolveOrNull } from '../css/values.js';
import type { Len } from '../css/values.js';
import type { ContentSize, GridLine, GridTrack } from '../css/style.js';
import { Box, GRID_TRACKS, isBlank } from './boxes.js';
import {
  MIN_CONTENT_PROBE,
  clampHeight,
  exactMinContent,
  measureIntrinsicWidth,
  moveTo,
  percentBaseInside,
  positionOutOfFlow,
  resolveEdges,
} from './block.js';
import type { LayoutContext } from './block.js';
import { sizeTracks } from './tracks.js';
import type { SizingTrack, TrackItem, TrackMax, TrackMin } from './tracks.js';

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
    if (child.kind === 'text' && isBlank(child.text)) continue;
    if (child.outOfFlow) {
      // where it is as the grid's one item, in an area whose edges are the
      // grid's padding edges (9.1)
      positionOutOfFlow(child, box, ctx, false);
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
  while (cols.length < widest) cols.push(style.gridAutoColumns);

  const measure = (item: Item): void => {
    if (item.max >= 0) return;
    const box = item.box;
    const margins = box.marginLeft + box.marginRight;
    // Measured once in the box's life, as a table cell's are: measured for
    // every layout of the grid, a grid in a grid in a grid laid out its
    // innermost three times a level, and twelve levels took two thirds of
    // a second.
    const style = box.style;
    let widest: number;
    let narrowest: number;
    if (typeof style.width === 'number') {
      // a length for a width is its width at its narrowest and its widest
      // — measured at no limit, it was its content's
      const extra = style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
      widest = narrowest = Math.max(style.width + extra, box.horizontalExtra);
    } else {
      const fresh = box.intrinsicMaxContent < 0;
      widest = maxContentOf(box, ctx);
      if (box.intrinsicMinContent < 0) {
        // where its words say it exactly, read from the layout just made —
        // which is the max-content one only if it was made just now
        const exact =
          fresh && ctx.fonts ? exactMinContent(box, ctx.fonts) : null;
        box.intrinsicMinContent =
          exact ?? measureIntrinsicWidth(box, ctx, MIN_CONTENT_PROBE);
      }
      narrowest = box.intrinsicMinContent;
    }
    // within its own least and greatest widths
    const [least, most] = ownWidths(box, narrowest, widest);
    item.max = Math.min(most, Math.max(least, widest)) + margins;
    item.min = Math.min(most, Math.max(least, narrowest)) + margins;
  };
  const colTracks = cols.map((track) => sizing(track, contentWidth));
  const widths = sizeTracks(
    colTracks,
    items.map((item): TrackItem => ({
      start: item.col,
      span: item.cols,
      minContent: () => (measure(item), item.min),
      maxContent: () => (measure(item), item.max),
      minimum: () => leastWidth(item, colTracks, colGap, measure),
    })),
    {
      available: contentWidth,
      least: 0,
      gap: colGap,
      stretch:
        style.justifyContent === 'normal' || style.justifyContent === 'stretch',
    },
  );
  const lefts = starts(widths, colGap, style.justifyContent, contentWidth);

  // each item at its area's width, for its height
  for (const item of items)
    layoutItem(item, extent(widths, lefts, item.col, item.cols), ctx);

  // every row the template names, whether or not an item is in it
  const rowCount = items.reduce(
    (n, item) => Math.max(n, item.row + item.rows),
    style.gridRows?.tracks.length ?? 0,
  );
  // a height of the grid's own, or else the least it may be, which the
  // `fr` rows and the `auto` ones fill
  const definite = percentBaseInside(box);
  const own = Number.isFinite(definite);
  const least = own ? 0 : leastHeight(box);
  const explicit = style.gridRows?.tracks ?? [];
  const rowTracks: SizingTrack[] = [];
  for (let r = 0; r < rowCount; r += 1) {
    rowTracks.push(sizing(explicit[r] ?? style.gridAutoRows, definite));
  }
  const heights = sizeTracks(
    rowTracks,
    items.map((item) => rowItem(item, rowTracks, rowGap)),
    {
      available: own ? definite : Infinity,
      least,
      gap: rowGap,
      stretch: style.alignContent === 'stretch',
    },
  );
  let height = rowGap * Math.max(0, heights.length - 1);
  for (const h of heights) height += h;
  // the rows are placed in the grid's height — which one from its
  // `aspect-ratio` grows to what it holds (CSS Sizing 4, 5.2) — or with no
  // height of its own, in its least height or its rows'
  const grows =
    own &&
    style.height === AUTO &&
    style.aspectRatio !== null &&
    style.minHeight === AUTO;
  const room =
    own && !grows ? definite : Math.max(own ? definite : least, height);
  const tops = starts(heights, rowGap, style.alignContent, room);
  GRID_TRACKS.set(box, {
    cols: widths.map((w, i) => [lefts[i], lefts[i] + w]),
    rows: heights.map((h, i) => [tops[i], tops[i] + h]),
    explicitCols: template.length,
    explicitRows: style.gridRows?.tracks.length ?? 0,
  });

  for (const item of items) {
    const child = item.box;
    const area = extent(widths, lefts, item.col, item.cols);
    const tall = extent(heights, tops, item.row, item.rows);
    const justify =
      child.style.justifySelf === 'auto'
        ? style.justifyItems
        : child.style.justifySelf;
    const align =
      child.style.alignSelf === AUTO ? style.alignItems : child.style.alignSelf;
    const outerWidth = child.width + child.marginLeft + child.marginRight;
    const outerHeight = child.height + child.marginTop + child.marginBottom;
    // `auto` margins take the free space in the area first (CSS Grid 1,
    // 10.2), and an item with them is not stretched
    const [left, right] = autoMargins(child, 'x');
    const [top, bottom] = autoMargins(child, 'y');
    let dx = 0;
    if (left || right) {
      dx = (area - outerWidth) * (left && right ? 0.5 : left ? 1 : 0);
    } else if (justify === 'center') dx = (area - outerWidth) / 2;
    else if (justify === 'flex-end') dx = area - outerWidth;
    let dy = 0;
    if (top || bottom) {
      dy = (tall - outerHeight) * (top && bottom ? 0.5 : top ? 1 : 0);
    } else if (align === 'center') dy = (tall - outerHeight) / 2;
    else if (align === 'flex-end') dy = tall - outerHeight;
    else if (
      (align === 'stretch' || align === 'baseline') &&
      child.style.height === AUTO &&
      !child.style.heightKeyword &&
      (child.style.alignSelf === 'stretch' ||
        (child.kind !== 'replaced' && !child.style.aspectRatio))
    ) {
      // a stretched item is its area's height, within its own least and
      // greatest (10.3): taller than what it holds, or shorter where its
      // tracks let it be, what it holds then running past it. An image, a
      // control or a box with an `aspect-ratio` keeps its own height, as
      // `normal` has one with a natural size or a ratio — which is what
      // the grid's `stretch` may be, and the item's own may not.
      const stretched = tall - child.marginTop - child.marginBottom;
      child.height = clampHeight(
        child,
        Math.max(stretched, child.verticalExtra),
      );
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
 * Place the items (CSS Grid 1, 8.5), as `grid-auto-flow: row` has it: an
 * item with a definite row and column where it says; one locked to a row
 * in the first columns free in it past the ones placed there before it;
 * and the rest in order from a cursor that moves through the rows — to the
 * next row where an item's definite column is before it, and on past each
 * item it places.
 */
function place(boxes: Box[], columns: number): Item[] {
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
  const items: Item[] = boxes.map((box) => {
    const style = box.style;
    const [col, cols] = span(
      style.gridColumnStart,
      style.gridColumnEnd,
      columns,
    );
    const [row, rows] = span(style.gridRowStart, style.gridRowEnd, Infinity);
    return {
      box,
      row: row ?? -1,
      rows,
      col: col ?? -1,
      cols,
      min: -1,
      max: -1,
    };
  });
  // 1. what says both where it goes
  for (const item of items) {
    if (item.row >= 0 && item.col >= 0) {
      take(item.row, item.col, item.rows, item.cols);
    }
  }
  // 2. what says which row: the first columns free, past the items this
  // step put in the row before it
  const past = new Map<number, number>();
  for (const item of items) {
    if (item.row < 0 || item.col >= 0) continue;
    let c = past.get(item.row) ?? 0;
    while (!free(item.row, c, item.rows, item.cols) && c < 10_000) c += 1;
    item.col = c;
    take(item.row, c, item.rows, item.cols);
    past.set(item.row, c + item.cols);
  }
  // 3. the columns every item with a column needs, and the widest span of
  // the ones without
  let width = columns;
  for (const item of items) {
    width = Math.max(width, item.col >= 0 ? item.col + item.cols : item.cols);
  }
  // 4. the rest, in order, from the cursor
  let cursorRow = 0;
  let cursorCol = 0;
  for (const item of items) {
    if (item.row >= 0) continue;
    if (item.col >= 0) {
      let r = item.col < cursorCol ? cursorRow + 1 : cursorRow;
      while (!free(r, item.col, item.rows, item.cols)) r += 1;
      item.row = r;
    } else {
      let r = cursorRow;
      let c = cursorCol;
      for (;;) {
        if (c + item.cols > width) {
          r += 1;
          c = 0;
          continue;
        }
        if (free(r, c, item.rows, item.cols)) break;
        c += 1;
      }
      item.row = r;
      item.col = c;
    }
    take(item.row, item.col, item.rows, item.cols);
    cursorRow = item.row;
    cursorCol = item.col + item.cols;
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

/** A track's minimum or maximum where it is a length or a percentage of
 *  `base`, never below zero; null where it is content or an `fr`. */
function lengthOf(
  len: GridTrack['min'] | GridTrack['max'],
  base: number,
): number | null {
  if (typeof len === 'number') return Math.max(0, len);
  if (
    typeof len === 'object' &&
    len !== null &&
    !('fr' in len) &&
    !('fit' in len) &&
    isPct(len)
  ) {
    return Math.max(0, resolve(len, base));
  }
  return null;
}

/** The size of the tracks from one to `count` after it, the gaps and the
 *  space distributed between them included. */
function extent(
  sizes: number[],
  at: number[],
  from: number,
  count: number,
): number {
  const last = Math.min(sizes.length, from + count) - 1;
  return last < from ? 0 : at[last] + sizes[last] - at[from];
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
  // its content's widths, border box: measured once in its life
  const content = (): [number, number] => {
    if (child.intrinsicMaxContent < 0) maxContentOf(child, ctx);
    if (child.intrinsicMinContent < 0) {
      child.intrinsicMinContent = measureIntrinsicWidth(
        child,
        ctx,
        MIN_CONTENT_PROBE,
      );
    }
    return [child.intrinsicMinContent, child.intrinsicMaxContent];
  };
  const keyword = style.widthKeyword;
  let width: number;
  if (style.width !== AUTO) {
    const extra = style.boxSizing === 'border-box' ? 0 : child.horizontalExtra;
    width = resolve(style.width, area, room - extra) + extra;
  } else if (keyword) {
    // a width of its content's is that, whatever aligns it
    const [narrowest, widest] = content();
    const fit =
      typeof keyword === 'object'
        ? resolve(keyword.fit, area, room) + child.horizontalExtra
        : room;
    width =
      keyword === 'min-content'
        ? narrowest
        : keyword === 'max-content'
          ? widest
          : Math.min(widest, Math.max(narrowest, fit));
  } else if (justify === 'stretch' && !autoMargins(child, 'x').some(Boolean)) {
    width = room;
  } else {
    // fit-content: no wider than its content at its widest, nor narrower
    // than at its narrowest, which may run past its area
    const [narrowest, widest] = content();
    width = Math.min(widest, Math.max(narrowest, room));
  }
  ctx.layoutSubtree(child, width);
}

/** A track's sizing functions, its lengths resolved against the size of the
 *  axis: a percentage of a size the tracks are still finding is `auto`
 *  (CSS Grid 1, 7.2.1), and `fit-content()` of one its content's widest. */
function sizing(track: GridTrack, base: number): SizingTrack {
  const length = (len: Len): number | null =>
    typeof len === 'number'
      ? Math.max(0, len)
      : len === AUTO || !Number.isFinite(base)
        ? null
        : Math.max(0, resolve(len, base));
  const { min, max } = track;
  const least: TrackMin =
    min === 'min-content' || min === 'max-content'
      ? min
      : (length(min) ?? 'auto');
  let most: TrackMax;
  if (max === 'min-content' || max === 'max-content') most = max;
  else if (typeof max === 'object' && max !== null && 'fr' in max) {
    most = { fr: max.fr };
  } else if (typeof max === 'object' && max !== null && 'fit' in max) {
    const fit = length(max.fit);
    most = fit === null ? 'max-content' : { fit };
  } else most = length(max) ?? 'auto';
  return { min: least, max: most };
}

/** An item's own least and greatest border-box widths, where they are
 *  lengths or its content's: a percentage of the area the tracks are still
 *  being sized for is none (CSS Sizing 3, 5.2.1). */
function ownWidths(
  box: Box,
  narrowest: number,
  widest: number,
): [number, number] {
  const style = box.style;
  const extra = style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
  const keyword = (k: ContentSize | null): number | null =>
    k === 'min-content' ? narrowest : k === 'max-content' ? widest : null;
  const least =
    keyword(style.minWidthKeyword) ??
    (typeof style.minWidth === 'number' ? style.minWidth + extra : 0);
  const most =
    keyword(style.maxWidthKeyword) ??
    (typeof style.maxWidth === 'number' ? style.maxWidth + extra : Infinity);
  return [least, Math.max(least, most)];
}

/**
 * The least an item makes the columns it is in (CSS Grid 1, 11.5, its
 * "minimum contribution"): its narrowest where it has a width of its own,
 * and its own least width where it has one of those.
 */
function leastWidth(
  item: Item,
  tracks: SizingTrack[],
  gap: number,
  measure: (item: Item) => void,
): number {
  const box = item.box;
  const style = box.style;
  const margins = box.marginLeft + box.marginRight;
  measure(item);
  if ((style.width !== AUTO && !isPct(style.width)) || style.widthKeyword) {
    return item.min;
  }
  if (style.minWidthKeyword || style.minWidth !== AUTO) {
    const [least] = ownWidths(
      box,
      box.intrinsicMinContent,
      box.intrinsicMaxContent,
    );
    return least + margins;
  }
  return (
    automaticMinimum(
      item.col,
      item.cols,
      tracks,
      gap,
      style.overflowX,
      margins,
      item.min - margins,
    ) + margins
  );
}

/**
 * An item's automatic least size (CSS Grid 1, 6.6): its content's, where it
 * shows what overflows it and is in an `auto` track — the only track, where
 * one of them is an `fr` — and no larger than the tracks' lengths leave it
 * room for where every one of them has a length for a maximum; else none.
 */
function automaticMinimum(
  start: number,
  count: number,
  tracks: SizingTrack[],
  gap: number,
  overflow: string,
  margins: number,
  content: number,
): number {
  if (overflow !== 'visible') return 0;
  const end = Math.min(tracks.length, start + count);
  let auto = false;
  let flexible = false;
  let fixed = true;
  let room = gap * Math.max(0, end - start - 1) - margins;
  for (let t = start; t < end; t += 1) {
    const { min, max } = tracks[t];
    if (min === 'auto') auto = true;
    if (typeof max === 'object' && 'fr' in max) flexible = true;
    if (typeof max === 'number') room += max;
    else fixed = false;
  }
  if (!auto || (flexible && end - start > 1)) return 0;
  return Math.max(0, fixed ? Math.min(content, room) : content);
}

/** What an item makes of the rows it is in: its height at its area's
 *  width, whichever the constraint, and the least it can be, as a
 *  column's. */
function rowItem(item: Item, tracks: SizingTrack[], gap: number): TrackItem {
  const box = item.box;
  const margins = box.marginTop + box.marginBottom;
  const outer = () => box.height + margins;
  return {
    start: item.row,
    span: item.rows,
    minContent: outer,
    maxContent: outer,
    minimum: () => {
      const style = box.style;
      if (style.height !== AUTO && !isPct(style.height)) return outer();
      if (style.minHeight !== AUTO) {
        const extra = style.boxSizing === 'border-box' ? 0 : box.verticalExtra;
        const least =
          typeof style.minHeight === 'number' ? style.minHeight + extra : 0;
        return least + margins;
      }
      return (
        automaticMinimum(
          item.row,
          item.rows,
          tracks,
          gap,
          style.overflowY,
          margins,
          box.height,
        ) + margins
      );
    },
  };
}

/** A grid's least content height where it has no height of its own: its
 *  `min-height`, a length or a percentage of a height. */
function leastHeight(box: Box): number {
  const style = box.style;
  if (style.minHeight === AUTO) return 0;
  const px = resolveOrNull(style.minHeight, box.percentHeightBase);
  if (px === null || !Number.isFinite(px)) return 0;
  return Math.max(
    0,
    style.boxSizing === 'border-box' ? px - box.verticalExtra : px,
  );
}

/**
 * Where each track starts from the grid's content edge, with the space the
 * tracks leave placed as `justify-content` or `align-content` has it (CSS
 * Box Alignment 3, 5.1): before them, after them, between them or around
 * each — none where the axis has no size of its own. `center` and `end`
 * overflow the start as well, where the tracks are larger than the room;
 * the distributions fall back to the start.
 */
function starts(
  sizes: number[],
  gap: number,
  distribution: string,
  room: number,
): number[] {
  let used = gap * Math.max(0, sizes.length - 1);
  for (const size of sizes) used += size;
  const free = Number.isFinite(room) ? room - used : 0;
  const n = sizes.length;
  let at = 0;
  let between = 0;
  if (n && free !== 0) {
    if (distribution === 'center') at = free / 2;
    else if (
      distribution === 'end' ||
      distribution === 'flex-end' ||
      distribution === 'right'
    ) {
      at = free;
    } else if (free > 0 && distribution === 'space-between') {
      between = n > 1 ? free / (n - 1) : 0;
    } else if (free > 0 && distribution === 'space-around') {
      between = free / n;
      at = between / 2;
    } else if (free > 0 && distribution === 'space-evenly') {
      between = free / (n + 1);
      at = between;
    }
  }
  const out: number[] = [];
  for (const size of sizes) {
    out.push(at);
    at += size + gap + between;
  }
  return out;
}

/** Which of an item's margins on an axis are `auto`, start and end. */
function autoMargins(box: Box, axis: 'x' | 'y'): [boolean, boolean] {
  const style = box.style;
  return axis === 'x'
    ? [style.marginLeft === AUTO, style.marginRight === AUTO]
    : [style.marginTop === AUTO, style.marginBottom === AUTO];
}
