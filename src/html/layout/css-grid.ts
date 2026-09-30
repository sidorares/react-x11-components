// `display: grid`, the subset documents are written in (CSS Grid 1).
//
// Tailwind's `grid grid-cols-3 gap-4`, a card list of `repeat(auto-fill,
// minmax(16rem, 1fr))`, a sidebar and a column in `16rem 1fr`, a page of
// `auto 1fr auto` rows: tracks of lengths, percentages, `fr`s, `auto`,
// `minmax()` and `fit-content()`, with `repeat()` by a count or by what
// fits, sized by what is in them as the track sizing algorithm has it
// (`tracks.ts`); items placed by line, span, name or area, or in order into
// the first cell free along the rows or down the columns, `dense` or not
// (the lines and their names are `grid-lines.ts`'s); gaps; the tracks
// placed by `justify-content` and `align-content`; and each item stretched
// to its area or aligned in it. Not here: subgrids, and baseline
// alignment.
//
// A grid container is a flex container to the box tree (`display: grid`
// reads as `flex` and sets `ComputedStyle.grid`): its children are the
// same blockified items, it holds its floats, and `flex.ts` hands it here.
// Unlike flex, the algorithm is written out rather than handed to Yoga,
// which has none; what it needs of an item — its width at no limit and at
// the smallest, and its height at a width — is what tables already ask.
import { AUTO, gapOf, isPct, resolve, resolveOrNull } from '../css/values.js';
import type { Len } from '../css/values.js';
import type {
  ComputedStyle,
  ContentSize,
  GridTemplate,
  GridTrack,
} from '../css/style.js';
import { scrolls } from '../css/style.js';
import { Box, GRID_TRACKS, isBlank } from './boxes.js';
import {
  FLEXED_HEIGHT,
  MIN_CONTENT_PROBE,
  STRETCHED_ACROSS,
  USED_HEIGHT,
  centreButton,
  clampHeight,
  clampWidth,
  exactMinContent,
  heightThroughRatio,
  measureIntrinsicWidth,
  moveTo,
  percentBaseInside,
  percentHeightsIn,
  positionOutOfFlow,
  resolveEdges,
  widthThroughRatio,
} from './block.js';
import type { LayoutContext } from './block.js';
import { gridLines, placement } from './grid-lines.js';
import type { GridLines } from './grid-lines.js';
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
  /** Whether it is a table stretched across its area (`STRETCHED_ACROSS`),
   *  which `layoutItem` decides. */
  across: boolean;
}

/**
 * The first of a grid's items in row-major order: the one furthest to the
 * start of the first row that holds an item, which the grid's baseline is
 * taken from (CSS Grid 1, 10.6).
 */
function firstItem(items: Item[]): Box | null {
  let first: Item | null = null;
  for (const item of items) {
    if (
      first === null ||
      item.row < first.row ||
      (item.row === first.row && item.col < first.col)
    ) {
      first = item;
    }
  }
  return first?.box ?? null;
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
    // While the columns are sized, the area an item is in has no width for
    // the percentages in its margins and its padding to be of, and they
    // are of nothing (CSS Sizing 3, 5.2.1): a column is as wide as what
    // is in the item. They are of the area once it has a width
    // (`layoutItem`). Taken of the grid's width, an item `margin: 0 25%`
    // made its `min-content` column half the grid wide.
    resolveEdges(child, 0);
    boxes.push(child);
  }
  // the gaps: a percentage of the grid's content size along them, and of
  // nothing where that is not known yet (CSS Box Alignment 3, 8.3)
  const colGap = gapOf(style.columnGap, contentWidth);
  let rowGap = gapOf(style.rowGap, percentBaseInside(box));

  // the explicit grid: the templates' tracks, and as many more as the
  // areas need, sized as the ones the placement makes past it are
  const areas = style.gridAreas;
  // a height of the grid's own, which the rows' `repeat()` counts against
  const definite = percentBaseInside(box);
  const template = trackList(style.gridColumns, contentWidth, colGap);
  const rowList = trackList(style.gridRows, definite, rowGap);
  const explicitCols = Math.max(template.tracks.length, areas?.columns ?? 0);
  const explicitRows = Math.max(rowList.tracks.length, areas?.rows ?? 0);
  const colLines = gridLines(explicitCols, template.names, areas, 'columns');
  const rowLines = gridLines(explicitRows, rowList.names, areas, 'rows');
  const items = place(boxes, colLines, rowLines, style.gridAutoFlow);
  // every row the explicit grid has, whether or not an item is in it
  const allRows = items.reduce(
    (n, item) => Math.max(n, item.row + item.rows),
    explicitRows,
  );
  const explicit = rowList.tracks;
  const cols = template.tracks.slice();
  // an item placed past the explicit grid makes tracks of its own
  const widest = items.reduce(
    (n, item) => Math.max(n, item.col + item.cols),
    Math.max(1, explicitCols),
  );
  while (cols.length < widest) cols.push(style.gridAutoColumns);
  // An `auto-fit` repetition no item is in collapses (7.2.3.2): it is out
  // of the sizing and the distribution, and the gaps on either side of it
  // are one. The items are placed in the tracks that stay, and the ones
  // that go are put back as nothing where the lines are read.
  const keepCols = keptTracks(cols.length, template.fit, items, true);
  const keepRows = keptTracks(allRows, rowList.fit, items, false);
  const rowDefs: GridTrack[] = [];
  for (let r = 0; r < allRows; r += 1) {
    if (keepRows?.[r] ?? true) rowDefs.push(explicit[r] ?? style.gridAutoRows);
  }
  if (keepCols) {
    const kept = cols.filter((_, c) => keepCols[c]);
    cols.length = 0;
    cols.push(...kept);
  }
  if (keepCols || keepRows) {
    const colAt = indexOfKept(keepCols);
    const rowAt = indexOfKept(keepRows);
    for (const item of items) {
      if (colAt) item.col = colAt[item.col];
      if (rowAt) item.row = rowAt[item.row];
    }
  }
  const rowCount = rowDefs.length;
  // While the columns are sized, a row whose greatest size is a length is
  // that size, and any other has none (CSS Grid 1, 12.1): what an item's
  // height is then, where it is one — which a ratio makes a width of
  const fixedRows: (number | null)[] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const { max } = sizing(rowDefs[r], definite);
    fixedRows.push(typeof max === 'number' ? max : null);
  }
  const spanBefore = (item: Item): number => {
    let span = rowGap * Math.max(0, item.rows - 1);
    for (let r = item.row; r < item.row + item.rows; r += 1) {
      const fixed = fixedRows[r];
      if (fixed === null || fixed === undefined) return NaN;
      span += fixed;
    }
    return span;
  };
  const heightBefore = (item: Item): number | null =>
    heightBeforeRows(item.box, spanBefore(item));
  // An item's percentage heights are of its area's, which the rows it
  // spans are, rather than the grid's: of that where they are known now,
  // and of nothing — `auto` — where they are not, until they are
  for (const item of items) item.box.percentHeightBase = spanBefore(item);

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
      // A percentage is of an area the columns are still being sized for,
      // and what it comes to depends on what the item makes them: it is
      // `auto` for that (CSS Sizing 3, 5.2.1), and the item's content says
      // how wide it is. Measured at the width a percentage made of the
      // probe's, an item `width: 100%` made its `auto` column nothing.
      const fresh = box.intrinsicMaxContent < 0;
      widest = maxContentOf(box, ctx);
      if (box.intrinsicMinContent < 0) {
        // where its words say it exactly, read from the layout just made —
        // which is the max-content one only if it was made just now
        const exact =
          fresh && ctx.fonts ? exactMinContent(box, ctx.fonts) : null;
        box.intrinsicMinContent = exact ?? minContentOf(box, ctx);
      }
      narrowest = box.intrinsicMinContent;
    }
    // an item with a ratio and a height is as wide as that makes it, its
    // content's sizes both (CSS Sizing 4, 5.1) — and one that is not
    // replaced no narrower for it than its content at its narrowest, where
    // it shows what overflows it (5.2). A scroll container's sizes are
    // none of its content's, and take nothing from its ratio either.
    if (
      typeof style.width !== 'number' &&
      (box.kind === 'replaced' || !scrolls(style))
    ) {
      const tall = heightBefore(item);
      const wide = tall === null ? null : widthThroughRatio(box, tall);
      if (wide !== null) {
        widest = narrowest =
          box.kind === 'replaced' || !showsOverflow(box)
            ? wide
            : Math.max(wide, narrowest);
      }
    }
    // a width of its content's is that at its narrowest and its widest
    if (style.widthKeyword === 'min-content') widest = narrowest;
    else if (style.widthKeyword === 'max-content') narrowest = widest;
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
  for (const item of items) {
    layoutItem(
      item,
      extent(widths, lefts, item.col, item.cols),
      ctx,
      spanBefore(item),
    );
  }

  // a height of the grid's own, or else the least it may be, which the
  // `fr` rows and the `auto` ones fill: its `min-height`, or the height a
  // column it is an item of flexed it to (`USED_HEIGHT`)
  const own = Number.isFinite(definite);
  const least = own ? 0 : Math.max(leastHeight(box), USED_HEIGHT.get(box) ?? 0);
  // the rows against a height: percentages of it, or `auto` without one
  const sizeRows = (base: number, available: number, atLeast: number) => {
    const rowTracks: SizingTrack[] = [];
    for (let r = 0; r < rowCount; r += 1) {
      rowTracks.push(sizing(rowDefs[r], base));
    }
    return sizeTracks(
      rowTracks,
      items.map((item) => rowItem(item, rowTracks, rowGap)),
      {
        available,
        least: atLeast,
        gap: rowGap,
        stretch: style.alignContent === 'stretch',
      },
    );
  };
  let heights = sizeRows(definite, own ? definite : Infinity, least);
  // with no height of its own, the grid is as tall as its rows come to with
  // their percentages `auto`, and the percentages are of that (7.2.1)
  if (!own && [...explicit, style.gridAutoRows].some(percentTrack)) {
    let tall = rowGap * Math.max(0, heights.length - 1);
    for (const h of heights) tall += h;
    tall = Math.max(tall, least);
    heights = sizeRows(tall, tall, 0);
  }
  let height = rowGap * Math.max(0, heights.length - 1);
  for (const h of heights) height += h;
  // with no height of its own, a percentage gap is of the height its rows
  // come to without it, and the rows are placed with it where the grid is
  // that tall
  if (!own && isPct(style.rowGap)) {
    rowGap = gapOf(style.rowGap, Math.max(height, least));
  }
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
  // an item that takes a percentage of its area's height, which is known
  // now, is laid out again with it
  for (const item of items) {
    const child = item.box;
    const tall = extent(heights, tops, item.row, item.rows);
    if (Object.is(child.percentHeightBase, tall) || !percentOwn(child))
      continue;
    child.percentHeightBase = tall;
    layoutItem(item, extent(widths, lefts, item.col, item.cols), ctx, tall);
  }
  GRID_TRACKS.set(box, {
    cols: tracksOf(widths, lefts, keepCols),
    rows: tracksOf(heights, tops, keepRows),
    colLines,
    rowLines,
    first: firstItem(items),
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
      (align === 'stretch' || align === 'normal' || align === 'baseline') &&
      child.style.height === AUTO &&
      !child.style.heightKeyword &&
      (align === 'stretch' ||
        (child.kind !== 'replaced' && !child.style.aspectRatio))
    ) {
      // a stretched item is its area's height, within its own least and
      // greatest (10.3): taller than what it holds, or shorter where its
      // tracks let it be, what it holds then running past it. An image, a
      // control or a box with an `aspect-ratio` keeps its own height under
      // `normal`, which stretches only an item with neither a natural size
      // nor a ratio, and is stretched by `stretch`, the grid's or its own
      // (6.2, and CSS Box Alignment 3, 6.1).
      const stretched = tall - child.marginTop - child.marginBottom;
      const height = clampHeight(
        child,
        Math.max(stretched, child.verticalExtra),
      );
      // and one with a ratio that is not stretched across is as wide as
      // that height makes it (CSS Sizing 4, 5.1)
      const wide =
        child.style.width === AUTO &&
        !child.style.widthKeyword &&
        !(justify === 'stretch' && !left && !right) &&
        height !== child.height
          ? widthThroughRatio(child, height)
          : null;
      const width =
        wide === null ? child.width : clampWidth(child, wide, area, ctx);
      // what is in it takes its percentages of that height, which a
      // stretch makes definite, as it does a flex item's — and an item that
      // is a flex or grid container lays its own items out in it (11.1:
      // "the grid area's width and height are considered definite for this
      // purpose"): a card's `margin-top: auto` takes what its row is taller
      // than the card by, its `flex: 1` grows into it (CSS Flexbox 8.1,
      // 9.7). Its content's own height is the same layout, and kept.
      // A table shares out among its rows what the area is taller than
      // they are (`layoutTable`), and is no shorter than they are however
      // short its area: its rows are the least it can be, as they are
      // where it has a height of its own (CSS 2.1 17.5.3).
      if (
        child.kind !== 'replaced' &&
        (wide !== null ||
          percentHeightsIn(child) ||
          (child.kind === 'flex' && height !== child.height) ||
          (child.kind === 'table' && height > child.height + 0.01))
      ) {
        FLEXED_HEIGHT.set(child, Math.max(0, height - child.verticalExtra));
        try {
          layoutAcross(item, width, area, ctx);
        } finally {
          FLEXED_HEIGHT.delete(child);
        }
      }
      child.width = width;
      child.height =
        child.kind === 'table' ? Math.max(height, child.height) : height;
      centreButton(child);
    }
    moveTo(
      child,
      box.contentX + lefts[item.col] + child.marginLeft + Math.max(0, dx),
      box.contentY + tops[item.row] + child.marginTop + Math.max(0, dy),
    );
  }
  return height;
}

/** An axis's explicit tracks and the names of their lines, a `repeat()`
 *  of what fits counted out against its size where it has one, and once
 *  where it has none (CSS Grid 1, 7.2.3.2). */
function trackList(
  template: GridTemplate | null,
  width: number,
  gap: number,
): {
  tracks: GridTrack[];
  names: string[][];
  /** The tracks an `auto-fit` repeated, from and to. */
  fit: [number, number] | null;
} {
  if (!template) return { tracks: [], names: [[]], fit: null };
  const { repeat } = template;
  if (!repeat) {
    return { tracks: template.tracks, names: template.names, fit: null };
  }
  const outer = template.tracks;
  const unit = repeat.tracks;
  // what one repetition takes: its tracks' maximums where those are
  // lengths, and their minimums where not (7.2.3.2)
  const base = Number.isFinite(width) ? width : 0;
  const fixed = (track: GridTrack): number =>
    lengthOf(track.max, base) ?? lengthOf(track.min, base) ?? 0;
  const others = outer.reduce((sum, t) => sum + fixed(t), 0);
  const each = unit.reduce((sum, t) => sum + fixed(t), 0);
  let count = 1;
  if (Number.isFinite(width) && each > 0) {
    const room = width - others - gap * outer.length;
    count = Math.max(1, Math.floor((room + gap) / (each + gap * unit.length)));
  }
  // the repetitions' lines where they meet carry the names of both sides
  const tracks: GridTrack[] = [];
  const names: string[][] = [];
  for (let i = 0; i < repeat.at; i += 1) {
    names.push(template.names[i]);
    tracks.push(outer[i]);
  }
  let line = [...template.names[repeat.at]];
  for (let k = 0; k < Math.min(count, 1000); k += 1) {
    line.push(...repeat.names[0]);
    for (let j = 0; j < unit.length; j += 1) {
      names.push(line);
      tracks.push(unit[j]);
      line = [...repeat.names[j + 1]];
    }
  }
  line.push(...repeat.after);
  for (let i = repeat.at; i < outer.length; i += 1) {
    names.push(line);
    tracks.push(outer[i]);
    line = [...template.names[i + 1]];
  }
  names.push(line);
  const repeated = Math.min(count, 1000) * unit.length;
  return {
    tracks,
    names,
    fit: repeat.fit ? [repeat.at, repeat.at + repeated] : null,
  };
}

/**
 * Place the items (CSS Grid 1, 8.5): an item with both its lines where it
 * says; one that names only the lines across the flow — its row, where the
 * grid fills its rows — in the first place free along them, past the ones
 * placed there before it; and the rest in order from a cursor that moves
 * along the flow and on to the next line of it — to the next where an
 * item's own line is before it — or, `dense`, from the start each time.
 * `grid-auto-flow: column` is the same with the axes turned round.
 */
function place(
  boxes: Box[],
  cols: GridLines,
  rows: GridLines,
  flow: ComputedStyle['gridAutoFlow'],
): Item[] {
  const byColumn = flow.startsWith('column');
  const dense = flow.endsWith('dense');
  // in the flow's terms: `a` along it, `b` across it
  const taken: boolean[][] = [];
  const free = (b: number, a: number, bs: number, as: number) => {
    for (let r = b; r < b + bs; r += 1) {
      for (let c = a; c < a + as; c += 1) if (taken[r]?.[c]) return false;
    }
    return true;
  };
  const take = (b: number, a: number, bs: number, as: number) => {
    for (let r = b; r < b + bs; r += 1) {
      const line = (taken[r] ??= []);
      for (let c = a; c < a + as; c += 1) line[c] = true;
    }
  };
  const placed = boxes.map((box) => {
    const style = box.style;
    const [col, colSpan] = placement(
      style.gridColumnStart,
      style.gridColumnEnd,
      cols,
    );
    const [row, rowSpan] = placement(
      style.gridRowStart,
      style.gridRowEnd,
      rows,
    );
    return byColumn
      ? { box, a: row ?? -1, as: rowSpan, b: col ?? -1, bs: colSpan }
      : { box, a: col ?? -1, as: colSpan, b: row ?? -1, bs: rowSpan };
  });
  // 1. what says both where it goes
  for (const p of placed) if (p.a >= 0 && p.b >= 0) take(p.b, p.a, p.bs, p.as);
  // 2. what says only which line of the flow
  const past = new Map<number, number>();
  for (const p of placed) {
    if (p.b < 0 || p.a >= 0) continue;
    let a = dense ? 0 : (past.get(p.b) ?? 0);
    while (!free(p.b, a, p.bs, p.as) && a < 10_000) a += 1;
    p.a = a;
    take(p.b, a, p.bs, p.as);
    past.set(p.b, a + p.as);
  }
  // 3. how long a line of the flow is: the explicit grid's, and as long as
  // the items with a place along it and the longest span without one need
  let length = byColumn ? rows.tracks : cols.tracks;
  for (const p of placed)
    length = Math.max(length, p.a >= 0 ? p.a + p.as : p.as);
  // 4. the rest, in order, from the cursor
  let cursorB = 0;
  let cursorA = 0;
  for (const p of placed) {
    if (p.b >= 0) continue;
    if (dense) {
      cursorB = 0;
      cursorA = 0;
    }
    if (p.a >= 0) {
      let b = p.a < cursorA ? cursorB + 1 : cursorB;
      while (!free(b, p.a, p.bs, p.as)) b += 1;
      p.b = b;
    } else {
      let b = cursorB;
      let a = cursorA;
      for (;;) {
        if (a + p.as > length) {
          b += 1;
          a = 0;
          continue;
        }
        if (free(b, a, p.bs, p.as)) break;
        a += 1;
      }
      p.b = b;
      p.a = a;
    }
    take(p.b, p.a, p.bs, p.as);
    cursorB = p.b;
    cursorA = p.a + p.as;
  }
  return placed.map((p) =>
    byColumn
      ? {
          box: p.box,
          row: p.a,
          rows: p.as,
          col: p.b,
          cols: p.bs,
          min: -1,
          max: -1,
          across: false,
        }
      : {
          box: p.box,
          row: p.b,
          rows: p.bs,
          col: p.a,
          cols: p.as,
          min: -1,
          max: -1,
          across: false,
        },
  );
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
 *  box's life, as a table cell's is (`Box.intrinsicMaxContent`). Its
 *  content's, whatever width it has of its own (`minContentOf`). */
function maxContentOf(box: Box, ctx: LayoutContext): number {
  if (box.intrinsicMaxContent < 0) {
    box.intrinsicMaxContent = measureIntrinsicWidth(
      box,
      ctx,
      Infinity,
      box.kind !== 'replaced',
    );
  }
  return box.intrinsicMaxContent;
}

/**
 * An item's min-content width, its border box's. What it is measured for is
 * what it contributes to its columns, and the width a percentage makes of
 * them is not known then: a box that is not replaced is as wide as its
 * content for that, whatever its own `width` says, and a replaced element
 * takes its percentage of nothing (CSS Sizing 3, 5.2.1). A width that is a
 * length is weighed apart (`measure` in `layoutGrid`).
 */
function minContentOf(box: Box, ctx: LayoutContext): number {
  return measureIntrinsicWidth(
    box,
    ctx,
    MIN_CONTENT_PROBE,
    box.kind !== 'replaced',
  );
}

/**
 * Lay an item out in its area: stretched across it where its width is
 * `auto` and it is stretched, or at its content's width, no wider than
 * the area, where it is aligned instead.
 *
 * The area is the item's containing block (CSS Grid 1, 3.3), so it is its
 * width that a percentage in the item's margins, its padding, its
 * `min-width` and its `max-width` is of (6.4, and CSS 2.1 8.3, 8.4 and
 * 10.4), whatever width the item comes to in it. With its own width
 * standing for its area's, an item `width: 50%; max-width: 80%` was four
 * tenths of its column, and one `min-width: 50%` aligned to the start was
 * as wide as its text.
 */
function layoutItem(
  item: Item,
  area: number,
  ctx: LayoutContext,
  /** The height of the rows it spans, where they have one yet. */
  rows: number,
): void {
  const child = item.box;
  const style = child.style;
  const parent = child.parent?.style;
  const justify =
    style.justifySelf === 'auto'
      ? (parent?.justifyItems ?? 'normal')
      : style.justifySelf;
  resolveEdges(child, area);
  // its border box's height before the rows are sized, where it has one
  const tall = heightBeforeRows(child, rows);
  const margins = child.marginLeft + child.marginRight;
  const room = Math.max(0, area - margins);
  // Its content's widths, border box: measured once in its life, with the
  // percentages in its padding of nothing, as they are while the columns
  // are sized, and here with what those come to of its area. Measuring
  // resolves its edges against nothing, and they are put back.
  const padded = percentPadding(child);
  const content = (): [number, number] => {
    let probed = false;
    if (child.intrinsicMaxContent < 0) {
      maxContentOf(child, ctx);
      probed = true;
    }
    if (child.intrinsicMinContent < 0) {
      child.intrinsicMinContent = minContentOf(child, ctx);
      probed = true;
    }
    if (probed) resolveEdges(child, area);
    return [
      child.intrinsicMinContent + padded,
      child.intrinsicMaxContent + padded,
    ];
  };
  const keyword = style.widthKeyword;
  // `stretch` fills its area, and so does `normal` but for a replaced
  // element, which it sizes as a block's is: a box with a ratio is as wide
  // as a block would be where it has no height yet (CSS Grid 1, 6.2)
  const across =
    (justify === 'stretch' ||
      (justify === 'normal' && child.kind !== 'replaced')) &&
    !autoMargins(child, 'x').some(Boolean);
  // a height it has already, through a ratio: its width, whatever its
  // content says, where `stretch` does not fill its area (CSS Sizing 4,
  // 5.1)
  const fills = justify === 'stretch' && !autoMargins(child, 'x').some(Boolean);
  const through =
    style.width === AUTO && !fills && tall !== null
      ? widthThroughRatio(child, tall)
      : null;
  let width: number;
  if (style.width !== AUTO) {
    const extra = style.boxSizing === 'border-box' ? 0 : child.horizontalExtra;
    width = resolve(style.width, area, room - extra) + extra;
  } else if (through !== null) {
    width = clampWidth(child, through, area, ctx);
    // and no narrower than its content where it shows what overflows it
    // (5.2), as a block with a ratio is
    if (child.kind !== 'replaced' && showsOverflow(child) && !keyword) {
      width = Math.max(width, content()[0]);
    }
  } else if (keyword) {
    // a width of its content's is that, whatever aligns it
    const [narrowest, widest] = content();
    const fit =
      typeof keyword === 'object'
        ? resolve(keyword.fit, area, room) + child.horizontalExtra
        : room;
    width =
      keyword === 'stretch'
        ? room
        : keyword === 'min-content'
          ? narrowest
          : keyword === 'max-content'
            ? widest
            : Math.min(widest, Math.max(narrowest, fit));
  } else if (across) {
    width = room;
  } else {
    // fit-content: no wider than its content at its widest, nor narrower
    // than at its narrowest, which may run past its area
    const [narrowest, widest] = content();
    width = Math.min(widest, Math.max(narrowest, room));
  }
  if (child.kind !== 'replaced') {
    // a table stretched across is as wide as its area, which in a block's
    // flow it would shrink from to its columns (`STRETCHED_ACROSS`)
    item.across =
      across &&
      child.kind === 'table' &&
      style.width === AUTO &&
      !keyword &&
      through === null;
    layoutAcross(item, width, area, ctx);
    return;
  }
  // a replaced element sizes itself from its style: then it is given the
  // width it was stretched to, or the one its height makes, and the height
  // its ratio makes of that width where it has none of its own
  ctx.layoutSubtree(child, area);
  if (style.width !== AUTO || keyword) return;
  if (through !== null) {
    child.width = width;
    child.height = tall!;
  } else if (fills) {
    child.width = clampWidth(child, width, area, ctx);
    const down =
      style.height === AUTO ? heightThroughRatio(child, child.width) : null;
    if (down !== null) child.height = clampHeight(child, down);
  }
}

/** Lay an item out at a width: a table stretched across its area at that
 *  width as its own (`STRETCHED_ACROSS`), for this layout alone. */
function layoutAcross(
  item: Item,
  width: number,
  area: number,
  ctx: LayoutContext,
): void {
  const child = item.box;
  if (!item.across) {
    ctx.layoutSubtree(child, width, area);
    return;
  }
  STRETCHED_ACROSS.add(child);
  try {
    ctx.layoutSubtree(child, width, area);
  } finally {
    STRETCHED_ACROSS.delete(child);
  }
}

/** What the percentages in a box's padding come to across it, its edges
 *  resolved: what a width of its content's, measured with them of nothing,
 *  is short of its border box by. */
function percentPadding(box: Box): number {
  const { paddingLeft, paddingRight } = box.style;
  let out = 0;
  if (isPct(paddingLeft)) {
    out += box.padLeft - Math.max(0, resolve(paddingLeft, 0));
  }
  if (isPct(paddingRight)) {
    out += box.padRight - Math.max(0, resolve(paddingRight, 0));
  }
  return out;
}

/** Whether a box's content is its least size through a ratio, which it is
 *  where the box shows what overflows it and its least width is `auto`
 *  (CSS Sizing 4, 5.2). */
function showsOverflow(box: Box): boolean {
  const style = box.style;
  return (
    style.minWidth === AUTO &&
    !style.minWidthKeyword &&
    (style.overflowX === 'visible' || style.overflowX === 'clip') &&
    (style.overflowY === 'visible' || style.overflowY === 'clip')
  );
}

/** Which tracks of an axis stay: all but those of an `auto-fit`
 *  repetition that no item is in, which collapse (CSS Grid 1, 7.2.3.2).
 *  Null where they all stay. */
function keptTracks(
  count: number,
  fit: [number, number] | null,
  items: readonly Item[],
  columns: boolean,
): boolean[] | null {
  if (!fit) return null;
  const used = new Array<boolean>(count).fill(false);
  for (const item of items) {
    const from = columns ? item.col : item.row;
    const span = columns ? item.cols : item.rows;
    for (let t = from; t < Math.min(count, from + span); t += 1) used[t] = true;
  }
  let collapsed = false;
  const keep = used.map((inUse, t) => {
    const stays = inUse || t < fit[0] || t >= fit[1];
    if (!stays) collapsed = true;
    return stays;
  });
  return collapsed ? keep : null;
}

/** Where each track that stays is among those that do. */
function indexOfKept(keep: boolean[] | null): number[] | null {
  if (!keep) return null;
  const at: number[] = [];
  let n = 0;
  for (const stays of keep) {
    at.push(n);
    if (stays) n += 1;
  }
  return at;
}

/** Each track's start and end, the collapsed ones back among the others
 *  as nothing, at the end of the one before. */
function tracksOf(
  sizes: number[],
  at: number[],
  keep: boolean[] | null,
): [number, number][] {
  if (!keep) return sizes.map((size, i) => [at[i], at[i] + size]);
  const out: [number, number][] = [];
  let edge = at.length ? at[0] : 0;
  let k = 0;
  for (const stays of keep) {
    if (stays) {
      out.push([at[k], at[k] + sizes[k]]);
      edge = at[k] + sizes[k];
      k += 1;
    } else out.push([edge, edge]);
  }
  return out;
}

/** Whether a box's own height, least or greatest, is a percentage. */
function percentOwn(box: Box): boolean {
  const style = box.style;
  return (
    isPct(style.height) ||
    isPct(style.minHeight) ||
    (style.maxHeight !== 'none' && isPct(style.maxHeight))
  );
}

/**
 * An item's border-box height before the rows are sized, where it has one
 * then: a height of its own — a percentage of the rows it spans where they
 * have a length for a size — or the rows' where `stretch` stretches it
 * down them, its own `align-self` or the grid's `align-items`. Null where
 * it has none, which is where its height is its content's.
 */
function heightBeforeRows(box: Box, rows: number): number | null {
  const style = box.style;
  const own = resolveOrNull(style.height, rows);
  if (own !== null && Number.isFinite(own)) {
    return clampHeight(
      box,
      style.boxSizing === 'border-box'
        ? Math.max(own, box.verticalExtra)
        : own + box.verticalExtra,
    );
  }
  const align =
    style.alignSelf === AUTO ? box.parent?.style.alignItems : style.alignSelf;
  if (
    style.height === AUTO &&
    !style.heightKeyword &&
    align === 'stretch' &&
    Number.isFinite(rows) &&
    !autoMargins(box, 'y').some(Boolean)
  ) {
    const room = rows - box.marginTop - box.marginBottom;
    return clampHeight(box, Math.max(room, box.verticalExtra));
  }
  return null;
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
  // a scroll container has none; `clip` is not one (CSS Overflow 3, 3.1)
  if (overflow !== 'visible' && overflow !== 'clip') return 0;
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

/** Whether a track's least or greatest size is a percentage. */
function percentTrack(track: GridTrack): boolean {
  const { min, max } = track;
  if (typeof min === 'object' && isPct(min)) return true;
  if (typeof max !== 'object' || max === null) return false;
  if ('fr' in max) return false;
  if ('fit' in max) return typeof max.fit === 'object' && isPct(max.fit);
  return isPct(max);
}
