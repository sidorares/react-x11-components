// The order Tab reaches a document's focusable areas in where a container's
// `reading-flow` says it is not the document's (CSS Display 4, 4.1): a flex
// container's items as they are seen or along its flex flow, a grid's by
// its rows or its columns, either by `order`, or any of these in the
// document's order with each item's `reading-order` read first. What an
// item holds is reached in the document's order, inside where the item is
// reached — and a container inside it orders its own items again.
//
// It needs the boxes as layout left them, since what is seen and what a
// grid placed where are layout's, so it is asked of the stops a build made
// (`focusCandidates`) each time they are reported, and only of a tree a
// `reading-flow` is in (`BoxTree.readingFlow`).
import { GRID_TRACKS, PAINT_ORDER } from './layout/boxes.js';
import type { Box } from './layout/boxes.js';
import type { FocusStop } from './focus.js';

/**
 * `stops`, each the focusable area of the box beside it in `boxes`, in the
 * document's order, put in their reading order: two in different items of
 * a reading flow container both are in go as those items go — the outermost
 * such container deciding — and two in the same item of every one they
 * share go as the document has them.
 */
export function inReadingOrder(
  stops: readonly FocusStop[],
  boxes: readonly Box[],
): { stops: FocusStop[]; boxes: Box[] } {
  const orders = new Map<Box, Map<Box, number> | null>();
  const orderOf = (container: Box): Map<Box, number> | null => {
    let order = orders.get(container);
    if (order === undefined) {
      order = itemOrder(container);
      orders.set(container, order);
    }
    return order;
  };
  // for each stop, from the outermost: each reading flow container it is
  // in, and where the item it is in comes in it
  const keyed = boxes.map((box, i) => {
    const path: [Box, number][] = [];
    for (let at: Box = box; at.parent; at = at.parent) {
      const order = orderOf(at.parent);
      const index = order?.get(at);
      if (index !== undefined) path.push([at.parent, index]);
    }
    return { i, path: path.reverse() };
  });
  keyed.sort((a, b) => {
    const n = Math.min(a.path.length, b.path.length);
    for (let k = 0; k < n; k += 1) {
      const [ca, ia] = a.path[k];
      const [cb, ib] = b.path[k];
      if (ca !== cb) break;
      if (ia !== ib) return ia - ib;
    }
    return a.i - b.i;
  });
  return {
    stops: keyed.map(({ i }) => stops[i]),
    boxes: keyed.map(({ i }) => boxes[i]),
  };
}

/**
 * Where each of a reading flow container's items comes in its reading
 * order, or null for a box that is none: one whose `reading-flow` is
 * `normal`, or a value of it that is not its kind of container's — the
 * `flex-` ones a flex container's, the `grid-` ones a grid's, and
 * `source-order` any of the three's. Its items are its children; one out
 * of the flow comes after those in it, in the document's order.
 */
function itemOrder(container: Box): Map<Box, number> | null {
  const style = container.style;
  const flow = style.readingFlow;
  if (flow === 'normal') return null;
  const grid = style.grid;
  const flex =
    !grid && (style.display === 'flex' || style.display === 'inline-flex');
  const block = !grid && !flex && container.kind === 'block';
  const kids = container.children;
  let ordered: readonly Box[];
  switch (flow) {
    case 'flex-visual':
      if (!flex) return null;
      ordered = asSeen(container, kids);
      break;
    case 'flex-flow':
      if (!flex) return null;
      ordered = PAINT_ORDER.get(container) ?? kids;
      break;
    case 'grid-rows':
    case 'grid-columns': {
      if (!grid) return null;
      ordered = byArea(container, kids, flow === 'grid-rows');
      break;
    }
    case 'grid-order':
      if (!grid) return null;
      ordered = PAINT_ORDER.get(container) ?? kids;
      break;
    case 'source-order':
      if (!grid && !flex && !block) return null;
      ordered = kids;
      break;
  }
  // in flow first, then what is out of it, as the document has it
  const placed = ordered.filter((kid) => !kid.outOfFlow);
  for (const kid of kids) if (kid.outOfFlow) placed.push(kid);
  // and `reading-order` over that, its equals kept in that order
  const ranked = placed
    .map((kid, at) => ({ kid, at }))
    .sort(
      (a, b) =>
        a.kid.style.readingOrder - b.kid.style.readingOrder || a.at - b.at,
    );
  const out = new Map<Box, number>();
  ranked.forEach(({ kid }, at) => out.set(kid, at));
  return out;
}

/**
 * A flex container's items as they are seen (`flex-visual`): its lines
 * across, and along each one, in reading order — down a row container's
 * lines and across each from the start of the line, a column container's
 * lines from the start of the line and down each — found from where its
 * items are, as `flexRuleSegments` finds them.
 */
function asSeen(container: Box, kids: readonly Box[]): Box[] {
  const row = !container.style.flexDirection.startsWith('column');
  const rtl = container.style.direction === 'rtl';
  const items = kids.filter((kid) => !kid.outOfFlow);
  // across the lines, and along them, as positions that grow the way it
  // is read
  const across = (b: Box) =>
    row
      ? b.y - b.marginTop
      : rtl
        ? -(b.x + b.width + b.marginRight)
        : b.x - b.marginLeft;
  const acrossEnd = (b: Box) =>
    row
      ? b.y + b.height + b.marginBottom
      : rtl
        ? -(b.x - b.marginLeft)
        : b.x + b.width + b.marginRight;
  const along = (b: Box) => (row ? (rtl ? -(b.x + b.width) : b.x) : b.y);
  const sorted = items.slice().sort((a, b) => across(a) - across(b));
  const lines: Box[][] = [];
  let end = -Infinity;
  for (const item of sorted) {
    if (lines.length && across(item) < end - 0.01) {
      lines[lines.length - 1].push(item);
      end = Math.max(end, acrossEnd(item));
    } else {
      lines.push([item]);
      end = acrossEnd(item);
    }
  }
  return lines.flatMap((line) => line.sort((a, b) => along(a) - along(b)));
}

/** A grid's items by their areas (`grid-rows`, `grid-columns`): by the row
 *  each starts in and then the column, or the other way round. */
function byArea(container: Box, kids: readonly Box[], rows: boolean): Box[] {
  const lanes = GRID_TRACKS.get(container)?.lanes;
  if (!lanes) return kids.slice();
  const area = new Map<Box, [number, number]>();
  lanes.items.forEach((item, i) => {
    const [col, , row] = lanes.areas[i];
    area.set(item, rows ? [row, col] : [col, row]);
  });
  const placed = kids.filter((kid) => area.has(kid));
  placed.sort((a, b) => {
    const [a0, a1] = area.get(a)!;
    const [b0, b1] = area.get(b)!;
    return a0 - b0 || a1 - b1;
  });
  return placed.concat(kids.filter((kid) => !area.has(kid)));
}
