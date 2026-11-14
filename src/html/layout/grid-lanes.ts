// `display: grid-lanes` (CSS Grid 3), which is masonry by its standard name:
// a grid in one axis, the grid axis, whose tracks are the lanes, and a flow
// in the other, the stacking axis, down each lane. Pinterest's board, a
// photo wall of `repeat(auto-fill, minmax(12rem, 1fr))` columns, a brick
// wall of `grid-template-rows` that grows sideways.
//
// The grid axis is a grid's: its tracks are the template's, `repeat()` and
// `auto-fit` and line names and areas all read as `css-grid.ts` reads them,
// and they are sized by the track sizing algorithm (`tracks.ts`) — but an
// item with no line of its own sizes every track it could go in, at every
// start it could have (3.4), since where it goes is only known once the
// items before it are laid out. Then each item, in order-modified document
// order, goes in the lane that leaves it highest: the start whose spanned
// tracks have the lowest running position, or the first at or after the
// cursor among those within `fit-tolerance` of it (4.4). It is laid out in
// its area there, and the running positions of its tracks move past it and
// the stacking gap. `grid-lanes-pack: dense` puts an item back in a hole a
// spanning item left, where the tracks there are as wide as its own.
//
// `grid-lanes-direction` says which axis is the grid's — `normal` reads it
// from the templates (2.3) — and turns the placement round: `track-reverse`
// fills the tracks from the last, and `fill-reverse` stacks from the far
// edge, the stacking range mirrored in itself and the container's
// `normal` alignment putting it at that edge.
//
// A grid lanes container is a grid container to everything else: `grid`
// is set on its style beside `gridLanes`, the box tree blockifies its
// items, and `flex.ts` hands it here. What it leaves in `GRID_TRACKS` is the
// grid axis's tracks and, in the stacking axis, one track from the start of
// the stacking range to its end, which is what an absolutely positioned
// box's lines 1 and 2 are there (8), and what the container's width at no
// limit is read from where the lanes are rows.
//
// Subgrids go both ways. An item that is a grid with `subgrid` on the lanes'
// axis takes the lanes it spans (`laneSubgrid`). And a grid lanes container
// that is an item of a grid, or of grid lanes, subgrids its parent's tracks
// on its lanes' axis and never its stacking one (3.2): its lanes are those
// tracks, sized by the parent (`subgridAxisOf`), and its items size them
// as a subgrid's do, one with no line at every start it could have
// (`lanesSubgridItems`).
//
// Not here: baseline alignment down a lane, and fragmentation.
import { gapOf, isPct, resolve } from '../css/values.js';
import type { GridTrack } from '../css/style.js';
import { AUTO } from '../css/values.js';
import { Box, GRID_TRACKS, inOrder, isBlank } from './boxes.js';
import {
  FLEXED_HEIGHT,
  USED_HEIGHT,
  centreButton,
  clampHeight,
  clampWidth,
  itemsTakeHeight,
  moveTo,
  percentBaseInside,
  percentHeightsIn,
  percentOwn,
  positionOutOfFlow,
  resolveEdges,
  trackContributions,
  wholeAgain,
} from './block.js';
import type { LayoutContext } from './block.js';
import {
  autoMargins,
  extent,
  fromParent,
  indexOfKept,
  inherited,
  laneSubgrid,
  laneSubgridItems,
  laneSubgridPlaced,
  lanesAreRows,
  lanesSubgridItems,
  layoutAcross,
  layoutItem,
  leastHeight,
  leastWidth,
  leastWidthInside,
  rowItem,
  percentTrack,
  sizing,
  starts,
  subgridAxisOf,
  trackList,
  tracksOf,
} from './css-grid.js';
import type { Item } from './css-grid.js';
import { gridLines, placement } from './grid-lines.js';
import { sizeTracks } from './tracks.js';
import type { SizingTrack, TrackItem } from './tracks.js';

/** How near two places in the stacking axis may be and still be one. */
const EPS = 1e-3;

/** An item where the placement put it: its first track and how many, and
 *  where its margin box starts down its lanes, from the stacking range's
 *  fill start, and how long it is there, floored at nought. */
interface Placed {
  item: Item;
  start: number;
  span: number;
  pos: number;
  outer: number;
}

/**
 * Lay out a grid lanes container's children. Returns the content height.
 */
export function layoutGridLanes(
  box: Box,
  ctx: LayoutContext,
  contentWidth: number,
): number {
  const style = box.style;
  const boxes: Box[] = [];
  for (const child of wholeAgain(box, ctx)) {
    if (child.kind === 'text' && isBlank(child.text)) continue;
    if (child.outOfFlow) {
      // where it is as the container's one item, turned round with the
      // lanes (`staticAlignment`)
      positionOutOfFlow(child, box, ctx, false);
      continue;
    }
    boxes.push(child);
  }
  // the percentages in an item's margins and padding are of nothing while
  // the tracks are sized, and of its area once it is laid out in it
  for (const child of boxes) resolveEdges(child, 0);
  // placed, and painted, in `order`
  inOrder(box, boxes);

  const rows = lanesAreRows(style);
  const direction = style.gridLanesDirection;
  const fillReverse = direction.includes('fill-reverse');
  const trackReverse = direction.includes('track-reverse');
  const definite = percentBaseInside(box);
  const own = Number.isFinite(definite);
  const least = own ? 0 : Math.max(leastHeight(box), USED_HEIGHT.get(box) ?? 0);
  // A subgrid's lanes are its parent's tracks over its span, the parent's
  // lines and their names, and its gap where its own is `normal` (CSS Grid
  // 2, 9; CSS Grid 3, 3.2): a grid's, or the lanes of grid lanes.
  const axis = rows ? 'rows' : 'cols';
  const sub = subgridAxisOf(box, axis);
  const colGap =
    !rows && sub && style.columnGapNormal
      ? sub.gap
      : gapOf(style.columnGap, contentWidth);
  const rowGap =
    rows && sub && style.rowGapNormal ? sub.gap : gapOf(style.rowGap, definite);
  // the grid axis: its size, where it has one, and its gap; and the
  // stacking axis's gap
  const gridSize = rows ? definite : contentWidth;
  let gridGap = rows ? rowGap : colGap;
  const stackGap = rows ? colGap : rowGap;

  // What each item makes of the grid axis's tracks: for columns its widths,
  // measured once; for rows its height at its content's width across, the
  // container's content box (4.4.1), where it is laid out first.
  const widths = new Map<Box, [number, number]>();
  const measure = (item: Item): void => {
    if (item.max >= 0) return;
    let pair = widths.get(item.box);
    if (!pair) {
      pair = trackContributions(item.box, ctx);
      widths.set(item.box, pair);
    }
    // and the margin, border and padding of a subgrid it is in at its edges
    item.min = pair[0] + item.before + item.after;
    item.max = pair[1] + item.before + item.after;
  };
  const layOutAcross = (only?: (child: Box) => boolean) => {
    if (!rows) return;
    for (const child of boxes) {
      if (only && !only(child)) continue;
      child.percentHeightBase = NaN;
      const area = Number.isFinite(contentWidth)
        ? contentWidth
        : trackContributions(child, ctx)[1];
      layoutItem(itemOf(child, 0, 1, true), area, ctx, NaN, true);
    }
  };
  const single = (
    item: Item,
    start: number,
    span: number,
    tracks: SizingTrack[],
  ): TrackItem => {
    if (rows) return rowItem({ ...item, row: start, rows: span }, tracks, 0);
    const placed = { ...item, col: start, cols: span };
    return {
      start,
      span,
      minContent: () => (measure(placed), placed.min),
      maxContent: () => (measure(placed), placed.max),
      minimum: () => leastWidth(placed, tracks, gridGap, measure, ctx),
    };
  };
  /** What sizes the tracks (3.4): an item where its line puts it, and one
   *  with none at every start it could have — those of a span as one
   *  virtual item, as large as the largest of them (3.4.2). */
  const contributions = (
    tracks: SizingTrack[],
    starts: (number | null)[],
  ): TrackItem[] => {
    const n = tracks.length;
    const out: TrackItem[] = [];
    const groups = new Map<number, Item[]>();
    const auto = (item: Item, span: number) => {
      const group = groups.get(span);
      if (group) group.push(item);
      else groups.set(span, [item]);
    };
    items.forEach((item, i) => {
      const span = Math.min(spanOf(item), n);
      const start = starts[i];
      if (subgridded[i]) {
        // A subgrid sizes them by its items, and not as itself (CSS Grid 2,
        // 9): where it has a line, in the lanes it spans; where it has
        // none, each where it could be in any of them (3.4.1)
        const inner = laneSubgridItems(item.box, start ?? 0, span, axis);
        for (const one of inner) {
          const at = rows ? one.row : one.col;
          const across = Math.min(rows ? one.rows : one.cols, n);
          if (start === null) auto(one, across);
          else if (at < n) out.push(single(one, at, across, tracks));
        }
        return;
      }
      if (start !== null) out.push(single(item, start, span, tracks));
      else auto(item, span);
    });
    for (const [span, group] of groups) {
      for (let p = 0; p + span <= n; p += 1) {
        const each = group.map((item) => single(item, p, span, tracks));
        const most = (size: (one: TrackItem) => number) => () => {
          let largest = 0;
          for (const one of each) largest = Math.max(largest, size(one));
          return largest;
        };
        out.push({
          start: p,
          span,
          minContent: most((one) => one.minContent()),
          maxContent: most((one) => one.maxContent()),
          minimum: most((one) => one.minimum()),
        });
      }
    }
    return out;
  };

  // the grid axis's tracks: the template's, as many as the areas need, and
  // as many more as the items placed past them and the widest span need
  const source = rows ? style.gridRows : style.gridColumns;
  const areas = style.gridAreas;
  const items: Item[] = [];
  /** Each item's first line in the grid axis, null where it is placed. */
  const given: (number | null)[] = [];
  const spanOf = (item: Item) => (rows ? item.rows : item.cols);
  const lay = (repetitions?: number) => {
    const template = sub
      ? inherited(sub)
      : trackList(source, gridSize, gridGap, repetitions);
    const explicit = sub
      ? sub.lines.tracks
      : Math.max(
          template.tracks.length,
          (rows ? areas?.rows : areas?.columns) ?? 0,
        );
    const lines =
      sub?.lines ??
      gridLines(explicit, template.names, areas, rows ? 'rows' : 'columns');
    items.length = 0;
    given.length = 0;
    for (const child of boxes) {
      const s = child.style;
      let [start, span] = rows
        ? placement(s.gridRowStart, s.gridRowEnd, lines)
        : placement(s.gridColumnStart, s.gridColumnEnd, lines);
      if (sub) {
        // a subgrid has the tracks it spans and no more, and an item past
        // them is pulled back into them (CSS Grid 2, 9)
        span = Math.min(span, Math.max(1, explicit));
        if (start !== null) start = Math.min(start, explicit - span);
      }
      given.push(start);
      items.push(itemOf(child, start ?? 0, span, rows));
    }
    return { template, explicit, lines };
  };
  let { template, explicit, lines } = lay();
  // The items that subgrid the lanes, given them where they were placed —
  // an item placed by the lanes takes no names from them (3.2) — with
  // their tracks' sizing functions; their items are planned in them.
  const subgridded: boolean[] = [];
  const setUpSubgrids = (explicitNow: number, tracksNow: GridTrack[]) => {
    const autoTrack = rows ? style.gridAutoRows : style.gridAutoColumns;
    items.forEach((item, i) => {
      const start = given[i];
      const span = spanOf(item);
      const total = Math.max(explicitNow, (start ?? 0) + span, 1);
      const defsNow = tracksNow.slice(0, total);
      while (defsNow.length < total) defsNow.push(autoTrack);
      const bare = gridLines(
        total,
        Array.from({ length: total + 1 }, () => []),
        null,
        rows ? 'rows' : 'columns',
      );
      subgridded[i] = laneSubgrid(
        item.box,
        start === null ? bare : lines,
        defsNow,
        start ?? 0,
        span,
        gridGap,
        axis,
      );
    });
  };
  setUpSubgrids(explicit, template.tracks);
  layOutAcross();
  // and down row lanes, a subgrid's items as tall as they came to across,
  // which its parent's rows are sized with
  if (sub && rows) sub.items = lanesSubgridItems(box, sub, 'rows', true);
  // A repetition whose tracks its content sizes repeats as many times as
  // tracks as large as its hypothetical ones fit (3.1.1): the template with
  // the repetition as many times as the widest span needs, every item at
  // every start it could have, and each entry of it the largest of its
  // copies.
  const repeat = sub ? undefined : source?.repeat;
  if (
    repeat &&
    Number.isFinite(gridSize) &&
    repeat.tracks.some((track) => lengthOfTrack(track) === null)
  ) {
    const k = repeat.tracks.length;
    let widest = 1;
    for (const item of items) widest = Math.max(widest, spanOf(item));
    const times = Math.max(1, 2 + Math.floor((widest - 2) / k));
    const listing = trackList(source, gridSize, gridGap, times);
    const tracks = listing.tracks.map((track) => sizing(track, gridSize));
    const hypothetical = sizeTracks(
      tracks,
      contributions(
        tracks,
        items.map(() => null),
      ),
      { available: Infinity, least: 0, gap: gridGap, stretch: false },
    );
    const entries = new Array<number>(k).fill(0);
    for (let r = 0; r < times; r += 1) {
      for (let j = 0; j < k; j += 1) {
        entries[j] = Math.max(entries[j], hypothetical[repeat.at + r * k + j]);
      }
    }
    let others = 0;
    hypothetical.forEach((size, t) => {
      if (t < repeat.at || t >= repeat.at + times * k) others += size;
    });
    const outer = source!.tracks.length;
    let each = gridGap * k;
    for (const size of entries) each += size;
    const room = gridSize - others - gridGap * outer;
    const count =
      each > 0 ? Math.max(1, Math.floor((room + gridGap) / each)) : 1;
    ({ template, explicit, lines } = lay(count));
    setUpSubgrids(explicit, template.tracks);
    layOutAcross((child) => subgridded[boxes.indexOf(child)]);
  }
  let count = Math.max(1, explicit);
  items.forEach((item, i) => {
    const start = given[i];
    count = Math.max(count, (start ?? 0) + spanOf(item));
  });
  const defs: GridTrack[] = template.tracks.slice();
  const autoTrack = rows ? style.gridAutoRows : style.gridAutoColumns;
  while (defs.length < count) defs.push(autoTrack);

  // `auto-fit`: the repetitions no item is in collapse (3.3.1). What an
  // item has a line in is in use, and so is every track before the one the
  // spans of the items with none add up to: counted by track, as Chromium
  // counts them, and not by the tracks left over.
  let keep: boolean[] | null = null;
  if (template.fit) {
    const used = new Array<boolean>(count).fill(false);
    let autoSpans = 0;
    items.forEach((item, i) => {
      const start = given[i];
      if (start === null) {
        autoSpans += spanOf(item);
        return;
      }
      for (let t = start; t < Math.min(count, start + spanOf(item)); t += 1) {
        used[t] = true;
      }
    });
    for (let t = 0; t < Math.min(count, autoSpans); t += 1) used[t] = true;
    const [from, to] = template.fit;
    let collapsed = false;
    keep = used.map((inUse, t) => {
      const stays = inUse || t < from || t >= to;
      if (!stays) collapsed = true;
      return stays;
    });
    if (!collapsed) keep = null;
  }
  const at = indexOfKept(keep);
  const kept = keep ? defs.filter((_, t) => keep![t]) : defs;
  const n = kept.length;
  if (at) {
    items.forEach((_, i) => {
      const start = given[i];
      if (start !== null) given[i] = at[Math.min(start, at.length - 1)];
    });
  }
  const sizeLanes = (base: number, available: number, atLeast: number) => {
    const tracks = kept.map((track) => sizing(track, base));
    return sizeTracks(tracks, contributions(tracks, given), {
      available,
      least: atLeast,
      gap: gridGap,
      stretch: rows
        ? style.alignContent === 'stretch'
        : style.justifyContent === 'normal' ||
          style.justifyContent === 'stretch',
    });
  };
  // a subgrid's lanes are where its parent sized them, where it has yet
  const fromAbove = sub
    ? fromParent(sub, gridGap, box, rows ? 'y' : 'x')
    : null;
  let sizes = fromAbove
    ? fromAbove.sizes
    : rows
      ? sizeLanes(definite, own ? definite : Infinity, least)
      : sizeLanes(gridSize, contentWidth, leastWidthInside(box));
  const sum = (list: number[], gap: number) => {
    let out = gap * Math.max(0, list.length - 1);
    for (const size of list) out += size;
    return out;
  };
  let used = sum(sizes, gridGap);
  // Row lanes with no height of their own are as tall as their rows come
  // to with their percentages `auto`, and the percentages are of that, as
  // a grid's are (CSS Grid 1, 7.2.1); and so is a percentage gap between
  // them
  let content = fromAbove ? fromAbove.size : used;
  if (rows && !own && !fromAbove) {
    const tall = Math.max(used, least);
    if (kept.some(percentTrack)) {
      sizes = sizeLanes(tall, tall, 0);
      used = sum(sizes, gridGap);
    }
    if (isPct(style.rowGap)) {
      gridGap = gapOf(style.rowGap, tall);
      used = sum(sizes, gridGap);
    }
    content = tall;
  }
  // where each track starts, the space it leaves placed as the content
  // distribution of the grid axis has it
  // A height from an `aspect-ratio` grows to what is in the box (CSS Sizing
  // 4, 5.2), as a grid's does
  const grows =
    own &&
    style.height === AUTO &&
    style.aspectRatio !== null &&
    style.minHeight === AUTO;
  const gridRoom = rows
    ? own && !grows
      ? definite
      : Math.max(own ? definite : least, used)
    : gridSize;
  const lefts = fromAbove
    ? fromAbove.at
    : starts(
        sizes,
        gridGap,
        flowContent(
          rows ? style.alignContentText : style.justifyContentText,
          rows ? style.alignContent : style.justifyContent,
          trackReverse,
        ),
        gridRoom,
      );

  // the tie threshold: `normal` is 1em here, a percentage is of the grid
  // axis's content size (4.2)
  const fit = style.fitTolerance;
  const tolerance =
    fit === 'infinite'
      ? Infinity
      : fit === 'normal'
        ? style.fontSize
        : Math.max(
            0,
            isPct(fit)
              ? resolve(fit, Number.isFinite(gridSize) ? gridSize : 0)
              : typeof fit === 'number'
                ? fit
                : 0,
          );
  const dense = style.gridLanesPack === 'dense';

  // Placement (4.4), in the order the tracks are filled: from the last
  // with `track-reverse`, where a track's place in that order is `logical`.
  const physical = (start: number, span: number) =>
    trackReverse ? n - start - span : start;
  const running = new Array<number>(n).fill(0);
  /** What each track holds, by where it starts and ends with the gap after
   *  it, in the order placed: the holes between them are what `dense`
   *  goes back for. */
  const held: [number, number][][] = [];
  for (let t = 0; t < n; t += 1) held.push([]);
  const placed: Placed[] = [];
  let cursor = 0;
  const highest = (start: number, span: number): number => {
    let at = 0;
    for (let t = start; t < start + span; t += 1) at = Math.max(at, running[t]);
    return at;
  };
  items.forEach((item, i) => {
    const span = Math.min(spanOf(item), n);
    const own = given[i];
    const cursorWas = cursor;
    let start: number;
    if (own !== null) {
      start = Math.max(0, physical(Math.min(own, n - span), span));
    } else {
      let best = Infinity;
      const maxes: number[] = [];
      for (let p = 0; p + span <= n; p += 1) {
        maxes.push(highest(p, span));
        best = Math.min(best, maxes[p]);
      }
      const tied: number[] = [];
      maxes.forEach((m, p) => {
        if (m <= best + tolerance + EPS) tied.push(p);
      });
      start = tied.find((p) => p >= cursor) ?? tied[0] ?? 0;
      cursor = start + span;
    }
    const from = physical(start, span);
    // laid out in its area, which is its containing block across, and the
    // container's content box along the lanes (4.4.1)
    const area = extent(sizes, lefts, from, span);
    const child = item.box;
    if (rows) {
      item.row = from;
      item.rows = span;
    } else {
      item.col = from;
      item.cols = span;
      child.percentHeightBase = definite;
      // a subgrid is laid out in the lanes it spans, sized
      if (subgridded[i]) {
        laneSubgridPlaced(
          child,
          'cols',
          sizes,
          lefts,
          kept,
          from,
          span,
          gridGap,
        );
      }
      layoutItem(item, area, ctx, NaN);
    }
    // Its margin box's length down the lanes, which a negative margin can
    // make less than nothing: the running position of a track never goes
    // back for it, and a gap it takes back is taken (4.4) — the space the
    // engines leave, which a size floored at nought before the gap would
    // not.
    const outer = rows
      ? child.width + child.marginLeft + child.marginRight
      : child.height + child.marginTop + child.marginBottom;
    let pos = highest(start, span);
    let moved = false;
    if (dense) {
      // a hole above it, in tracks as wide as its own, that it fits
      const hole = holeFor(
        held,
        start,
        span,
        Math.max(0, outer),
        stackGap,
        tolerance,
        n,
        {
          own: own !== null,
          size: area,
          sizeAt: (p) => extent(sizes, lefts, physical(p, span), span),
          below: pos,
        },
      );
      if (hole) {
        // the running positions and the cursor as they were before it
        start = hole.start;
        pos = hole.pos;
        moved = true;
        cursor = cursorWas;
      }
    }
    const end = Math.max(pos, pos + outer + stackGap);
    for (let t = start; t < start + span; t += 1) {
      insertHeld(held[t], [pos, end]);
      if (!moved) running[t] = Math.max(running[t], end);
    }
    if (rows) {
      item.row = physical(start, span);
    } else {
      item.col = physical(start, span);
    }
    placed.push({ item, start, span, pos, outer });
  });

  // the stacking range: from the fill start to the far edge of the last
  // item in any track
  let range = 0;
  for (const p of placed) range = Math.max(range, p.pos + p.outer);
  // the container's size along the lanes, and where the range sits in it
  const stackRoom = rows
    ? Number.isFinite(contentWidth)
      ? contentWidth
      : range
    : own && !grows
      ? definite
      : Math.max(own ? definite : least, range);
  const shift = stackingShift(
    rows ? style.justifyContentText : style.alignContentText,
    stackRoom - range,
    fillReverse,
  );

  // Each item where it goes: in its area across, aligned in it, and down
  // its lanes at its place, aligned in the hole after it where there is one
  // (6.4).
  // The last item in a lane has the hole after it out to the container's
  // far edge, from the fill start, and not only to the stacking range's, as
  // the engines have it: a `stretch` fills the container's height
  const lastEnd = Math.max(
    range,
    fillReverse ? shift + range : stackRoom - shift,
  );
  const holesAfter = gapsAfter(placed, n, lastEnd, stackGap);
  placed.forEach((p, k) => {
    const { item, pos } = p;
    const child = item.box;
    const from = physical(p.start, p.span);
    const area = extent(sizes, lefts, from, p.span);
    // across: aligned in its area
    const [crossStart, crossEnd] = rows
      ? autoMargins(child, 'y')
      : autoMargins(child, 'x');
    const crossOuter = rows
      ? child.height + child.marginTop + child.marginBottom
      : child.width + child.marginLeft + child.marginRight;
    const selfAcross = rows
      ? child.style.alignSelf === AUTO
        ? style.alignItems
        : child.style.alignSelf
      : child.style.justifySelf === 'auto'
        ? style.justifyItems
        : child.style.justifySelf;
    const textAcross = rows
      ? child.style.alignSelf === AUTO
        ? style.alignItemsText
        : child.style.alignSelfText
      : child.style.justifySelf === 'auto'
        ? style.justifyItemsText
        : child.style.justifySelfText;
    // a row lane's item takes the percentages of its height of its row,
    // which is known now (4.4.1)
    const index = items.indexOf(item);
    if (rows && subgridded[index]) {
      // A subgrid of row lanes is as tall as the rows it spans, whatever its
      // own height says, and laid out again in them, its rows theirs (CSS
      // Grid 2, 9)
      laneSubgridPlaced(
        child,
        'rows',
        sizes,
        lefts,
        kept,
        from,
        p.span,
        gridGap,
      );
      const height = Math.max(
        child.verticalExtra,
        area - child.marginTop - child.marginBottom,
      );
      FLEXED_HEIGHT.set(child, height - child.verticalExtra);
      try {
        layoutAcross(
          item,
          child.width,
          Number.isFinite(contentWidth) ? contentWidth : child.width,
          ctx,
        );
      } finally {
        FLEXED_HEIGHT.delete(child);
      }
      child.height = height;
    } else if (rows && percentOwn(child) && child.kind !== 'replaced') {
      child.percentHeightBase = area;
      layoutAcross(
        item,
        child.width,
        Number.isFinite(contentWidth) ? contentWidth : child.width,
        ctx,
      );
    }
    let across = 0;
    if (subgridded[index]) {
      // a subgrid fills the lanes it spans, whatever aligns it (CSS Grid 2,
      // 9)
    } else if (crossStart || crossEnd) {
      // `auto` margins take the free space in the area first (CSS Grid 1,
      // 10.2)
      across = crossStart ? (area - crossOuter) * (crossEnd ? 0.5 : 1) : 0;
    } else {
      const flow = flowAlign(textAcross, trackReverse);
      const kind = flow ?? selfAcross;
      if (kind === 'center') across = (area - crossOuter) / 2;
      else if (kind === 'flex-end') across = area - crossOuter;
      else if (
        rows &&
        !subgridded[index] &&
        flow === null &&
        (kind === 'stretch' || kind === 'normal') &&
        child.style.height === AUTO &&
        !child.style.heightKeyword &&
        (kind === 'stretch' ||
          (child.kind !== 'replaced' && !child.style.aspectRatio))
      ) {
        stretchDown(
          item,
          area,
          Number.isFinite(contentWidth) ? contentWidth : child.width,
          ctx,
        );
      }
    }
    // down its lanes: in the hole after it, where its alignment puts it
    let along = 0;
    const hole = holesAfter[k];
    if (hole > EPS) {
      const selfAlong = rows
        ? child.style.justifySelf === 'auto'
          ? style.justifyItemsText
          : child.style.justifySelfText
        : child.style.alignSelf === AUTO
          ? style.alignItemsText
          : child.style.alignSelfText;
      const last = selfAlong.split(/\s+/).pop();
      if (
        last === 'stretch' &&
        stretchAlong(item, hole, rows ? contentWidth : area, rows, ctx)
      ) {
        along = 0;
      } else along = stackingSelf(selfAlong, hole, fillReverse);
    }
    // from the fill start, its leading margin first: its far one where the
    // lanes fill from their far edge
    const lead = rows
      ? fillReverse
        ? child.marginRight
        : child.marginLeft
      : fillReverse
        ? child.marginBottom
        : child.marginTop;
    const size = rows ? child.width : child.height;
    const fromStart = pos + along + lead;
    const stack = fillReverse ? range - fromStart - size : fromStart;
    const crossLead = rows ? child.marginTop : child.marginLeft;
    const at = shift + stack;
    const x = rows
      ? box.contentX + at
      : box.contentX + lefts[from] + crossLead + Math.max(0, across);
    const y = rows
      ? box.contentY + lefts[from] + crossLead + Math.max(0, across)
      : box.contentY + at;
    moveTo(child, x, y);
  });

  // what is left of the layout for an absolutely positioned box's area, the
  // container's width at no limit, and the gap rules
  const laneTracks = tracksOf(sizes, lefts, keep);
  const stacking: [number, number][] = [[shift, shift + range]];
  const first = placed.length ? placed[0].item.box : null;
  // the first in each lane, by where the placement put it, not where a
  // margin or an offset moved it (6.5)
  const firsts = new Set<Box>();
  for (let t = 0; t < n; t += 1) {
    let top: Placed | null = null;
    for (const p of placed) {
      if (t < p.start || t >= p.start + p.span) continue;
      if (top === null || p.pos < top.pos) top = p;
    }
    if (top) firsts.add(top.item.box);
  }
  GRID_TRACKS.set(box, {
    cols: rows ? stacking : laneTracks,
    rows: rows ? laneTracks : stacking,
    colLines: rows ? gridLines(1, [[], []], null, 'columns') : lines,
    rowLines: rows ? lines : gridLines(1, [[], []], null, 'rows'),
    first,
    firsts: [...firsts],
    atNarrowest: 0,
    lanes: {
      cols: rows
        ? stacking
        : sizes.map((w, i) => [lefts[i], lefts[i] + w] as [number, number]),
      rows: rows
        ? sizes.map((h, i) => [lefts[i], lefts[i] + h] as [number, number])
        : stacking,
      areas: placed.map((p) => {
        const from = physical(p.start, p.span);
        return rows ? [0, 1, from, p.span] : [from, p.span, 0, 1];
      }),
      items: placed.map((p) => p.item.box),
    },
  });

  // what is in it, which its own height, its least and its ratio are
  // weighed against around it, as a grid's rows are
  return rows ? content : range;
}

/** A fresh item of a grid lanes container, at a start and a span in the
 *  grid axis: its columns where the lanes are columns, its rows where they
 *  are rows. */
function itemOf(box: Box, start: number, span: number, rows: boolean): Item {
  return {
    box,
    col: rows ? 0 : start,
    cols: rows ? 1 : span,
    row: rows ? start : 0,
    rows: rows ? span : 1,
    min: -1,
    max: -1,
    across: false,
    before: 0,
    after: 0,
    height: NaN,
  };
}

/** A track's size where it is a length, at least or at most: null where
 *  its content sizes it either way, as in a repetition grid lanes sizes by
 *  its items (CSS Grid 3, 3.1.1). */
function lengthOfTrack(track: GridTrack): number | null {
  const fixed = (len: GridTrack['min'] | GridTrack['max']): boolean =>
    typeof len === 'number' ||
    (typeof len === 'object' &&
      len !== null &&
      !('fr' in len) &&
      !('fit' in len) &&
      isPct(len));
  return fixed(track.max) || fixed(track.min) ? 0 : null;
}

/**
 * Stretch an item of a row lane down its row, as a grid item is stretched
 * down its area (CSS Grid 1, 10.3), and lay out again what takes a
 * percentage of that height.
 */
function stretchDown(
  item: Item,
  area: number,
  /** The width its percentages are of: the container's content box. */
  across: number,
  ctx: LayoutContext,
): void {
  const child = item.box;
  child.percentHeightBase = area;
  const stretched = area - child.marginTop - child.marginBottom;
  const height = clampHeight(child, Math.max(stretched, child.verticalExtra));
  if (
    child.kind !== 'replaced' &&
    (percentHeightsIn(child) ||
      itemsTakeHeight(child, height, ctx) ||
      (child.kind === 'flex' && height !== child.height))
  ) {
    FLEXED_HEIGHT.set(child, Math.max(0, height - child.verticalExtra));
    try {
      layoutAcross(item, child.width, across, ctx);
    } finally {
      FLEXED_HEIGHT.delete(child);
    }
  }
  child.height = height;
  centreButton(child);
}

/**
 * Stretch an item into the hole after it down its lanes (CSS Grid 3, 6.4),
 * where its size along them is `auto`: as much taller, or wider for row
 * lanes, within its own limits, and laid out again at it. Whether it was.
 */
function stretchAlong(
  item: Item,
  hole: number,
  /** The width its percentages are of: its lanes' for column lanes, the
   *  container's content box for row lanes. */
  across: number,
  rows: boolean,
  ctx: LayoutContext,
): boolean {
  const child = item.box;
  const style = child.style;
  if (child.kind === 'replaced') return false;
  if (rows) {
    if (style.width !== AUTO || style.widthKeyword) return false;
    const base = Number.isFinite(across) ? across : child.width;
    const width = clampWidth(child, child.width + hole, base, ctx);
    if (width === child.width) return true;
    layoutAcross(item, width, base, ctx);
    child.width = width;
    return true;
  }
  if (style.height !== AUTO || style.heightKeyword) return false;
  const height = clampHeight(child, child.height + hole);
  if (height === child.height) return true;
  if (
    percentHeightsIn(child) ||
    itemsTakeHeight(child, height, ctx) ||
    child.kind === 'flex' ||
    child.kind === 'table'
  ) {
    FLEXED_HEIGHT.set(child, Math.max(0, height - child.verticalExtra));
    try {
      layoutAcross(item, child.width, across, ctx);
    } finally {
      FLEXED_HEIGHT.delete(child);
    }
  }
  child.height = height;
  centreButton(child);
  return true;
}

/**
 * `flow-start` and `flow-end` in the grid axis, which follow the order the
 * tracks are filled in (CSS Grid 3, 6.2): the far end where they are filled
 * from the last. Null for any other alignment, which reads as it does in a
 * grid.
 */
function flowAlign(
  text: string,
  trackReverse: boolean,
): 'flex-start' | 'flex-end' | null {
  const words = text.split(/\s+/);
  const last = words[words.length - 1];
  if (last === 'flow-start') return trackReverse ? 'flex-end' : 'flex-start';
  if (last === 'flow-end') return trackReverse ? 'flex-start' : 'flex-end';
  return null;
}

/**
 * Where the stacking range starts in the container (CSS Grid 3, 6.3): it is
 * the one alignment subject, so `align-content` or `justify-content` comes
 * down to its start, its centre or its end, a distribution to its fallback.
 * `normal`, `stretch` and the flow keywords follow the fill, to the far edge
 * where the lanes fill from there.
 */
function stackingShift(
  text: string,
  free: number,
  fillReverse: boolean,
): number {
  const words = text.split(/\s+/);
  const safe = words[0] === 'safe';
  const last = words[words.length - 1];
  let at: number;
  switch (last) {
    case 'start':
    case 'left':
    case 'self-start':
      at = 0;
      break;
    case 'end':
    case 'right':
    case 'self-end':
      at = free;
      break;
    case 'center':
      at = free / 2;
      break;
    case 'space-around':
    case 'space-evenly':
      at = Math.max(0, free / 2);
      if (fillReverse) at = free - at;
      break;
    case 'flex-end':
    case 'flow-end':
      at = fillReverse ? 0 : free;
      break;
    default:
      // `normal`, `stretch`, `flex-start`, `flow-start`, `space-between`
      at = fillReverse ? free : 0;
  }
  if (safe && free < 0) at = 0;
  return at;
}

/** How far into the hole after it an item sits, from the fill start, by its
 *  self-alignment along the lanes (6.4): its centre, or its end. `start` and
 *  `end` are the container's edges, which `fill-reverse` puts the other way
 *  round from the fill; `flow-start` and `flow-end` follow the fill, and so
 *  do `normal`, `stretch` and the baselines, to its start. */
function stackingSelf(
  text: string,
  hole: number,
  fillReverse: boolean,
): number {
  const words = text.split(/\s+/);
  const last = words[words.length - 1];
  switch (last) {
    case 'center':
      return hole / 2;
    case 'start':
    case 'self-start':
    case 'left':
      return fillReverse ? hole : 0;
    case 'end':
    case 'self-end':
    case 'right':
      return fillReverse ? 0 : hole;
    case 'flex-end':
    case 'flow-end':
      return hole;
    default:
      return 0;
  }
}

/** A content distribution in the grid axis, with `flow-start` and
 *  `flow-end` the ends the lanes are filled from and to (6.2): the far end
 *  first where they are filled from the last. Anything else as it reads. */
function flowContent(
  text: string,
  keyword: string,
  trackReverse: boolean,
): string {
  const words = text.split(/\s+/);
  const last = words[words.length - 1];
  if (last === 'flow-start') return trackReverse ? 'flex-end' : 'flex-start';
  if (last === 'flow-end') return trackReverse ? 'flex-start' : 'flex-end';
  return keyword;
}

/**
 * The hole after each item down its lanes (6.4): to the next item in any of
 * its tracks, less the gap before that one, or for the last in a track to
 * `end`, the far edge of the container or of the stacking range.
 */
function gapsAfter(
  placed: Placed[],
  n: number,
  end: number,
  gap: number,
): number[] {
  /** The items each track holds, by where they start, in order. */
  const byTrack: number[][] = [];
  for (let t = 0; t < n; t += 1) byTrack.push([]);
  placed.forEach((p, k) => {
    for (let t = p.start; t < p.start + p.span; t += 1) byTrack[t].push(k);
  });
  for (const list of byTrack)
    list.sort((a, b) => placed[a].pos - placed[b].pos);
  const out: number[] = [];
  placed.forEach((p, k) => {
    let until = Infinity;
    for (let t = p.start; t < p.start + p.span; t += 1) {
      const list = byTrack[t];
      const i = list.indexOf(k);
      const next = list[i + 1];
      until = Math.min(
        until,
        next === undefined ? end : placed[next].pos - gap,
      );
    }
    out.push(Math.max(0, until - (p.pos + p.outer)));
  });
  return out;
}

/** Put what a track holds where it goes among the rest, by its start. */
function insertHeld(list: [number, number][], span: [number, number]): void {
  let i = list.length;
  while (i > 0 && list[i - 1][0] > span[0]) i -= 1;
  list.splice(i, 0, span);
}

/**
 * Where `dense` puts an item back (CSS Grid 3, 4.4): the highest hole above
 * where it was placed — between two things a track holds, in every track of
 * its span — that it fits with the gap after it, in tracks as wide as its
 * own; among those within the tie threshold of the highest, the first. An
 * item with a line of its own looks in its own tracks alone. Null where
 * there is none.
 */
function holeFor(
  held: [number, number][][],
  start: number,
  span: number,
  outer: number,
  gap: number,
  tolerance: number,
  n: number,
  how: {
    own: boolean;
    size: number;
    sizeAt: (start: number) => number;
    below: number;
  },
): { start: number; pos: number } | null {
  const need = outer + gap;
  const fitsAt = (p: number): number | null => {
    // where the holes of each track of the span start
    const candidates = new Set<number>();
    for (let t = p; t < p + span; t += 1) {
      let edge = 0;
      for (const [top, bottom] of held[t]) {
        if (top - edge >= need - EPS) candidates.add(edge);
        edge = Math.max(edge, bottom);
      }
    }
    const sorted = [...candidates].sort((a, b) => a - b);
    for (const y of sorted) {
      if (y >= how.below - EPS) break;
      let fits = true;
      for (let t = p; t < p + span && fits; t += 1) {
        fits = inHole(held[t], y, need);
      }
      if (fits) return y;
    }
    return null;
  };
  const found: { start: number; pos: number }[] = [];
  const from = how.own ? start : 0;
  const to = how.own ? start : n - span;
  for (let p = from; p <= to; p += 1) {
    if (Math.abs(how.sizeAt(p) - how.size) > 0.01) continue;
    const y = fitsAt(p);
    if (y !== null) found.push({ start: p, pos: y });
  }
  if (!found.length) return null;
  let best = Infinity;
  for (const f of found) best = Math.min(best, f.pos);
  return found.find((f) => f.pos <= best + tolerance + EPS) ?? null;
}

/** Whether a track has room from `y` for `need`, between two things it
 *  holds: a hole, and not the open end past the last. */
function inHole(list: [number, number][], y: number, need: number): boolean {
  let edge = 0;
  for (const [top, bottom] of list) {
    if (edge <= y + EPS && y + need <= top + EPS) return true;
    if (top < y + need - EPS && bottom > y + EPS) return false;
    edge = Math.max(edge, bottom);
  }
  return false;
}
