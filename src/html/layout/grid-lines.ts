// A grid's lines by number and by name (CSS Grid 1, 8.3): what a grid
// item's placement properties come to as line indices. Shared by the
// placement of the grid's items (`css-grid.ts`) and by the grid area an
// absolutely positioned box takes for its containing block (`block.ts`),
// which must read a name as the placement does.
import type { GridAreas, GridLine } from '../css/style.js';

/** One axis of a grid: how many tracks its explicit grid has, and which of
 *  its lines — from 0, before the first track — carry each name. */
export interface GridLines {
  tracks: number;
  named: Map<string, number[]>;
}

/**
 * An axis's lines from the names its track list gives them, and those
 * `grid-template-areas` gives the edges of its areas: `a-start` and
 * `a-end` (7.3.2). `names[i]` is the line before track `i`.
 */
export function gridLines(
  tracks: number,
  names: readonly (readonly string[])[],
  areas: GridAreas | null,
  axis: 'rows' | 'columns',
): GridLines {
  const named = new Map<string, number[]>();
  const add = (name: string, line: number) => {
    const list = named.get(name);
    if (!list) named.set(name, [line]);
    else if (!list.includes(line)) list.push(line);
  };
  names.forEach((group, line) => {
    for (const name of group) add(name, line);
  });
  if (areas) {
    for (const [name, area] of areas.areas) {
      add(`${name}-start`, area[axis][0]);
      add(`${name}-end`, area[axis][1]);
    }
  }
  for (const list of named.values()) list.sort((a, b) => a - b);
  return { tracks, named };
}

/**
 * The `n`th line named `name` from the start of the explicit grid, or from
 * its end where `n` is negative: where there are not so many, the implicit
 * lines past that end all count as having the name (8.3).
 */
export function namedLine(lines: GridLines, name: string, n: number): number {
  const list = lines.named.get(name) ?? [];
  if (n > 0) {
    return n <= list.length ? list[n - 1] : lines.tracks + (n - list.length);
  }
  const k = -n;
  return k <= list.length ? list[list.length - k] : -(k - list.length);
}

/**
 * The line a placement property names, or null for `auto` and a span. A
 * name alone is the edge of the area of that name, the first line called
 * `<name>-start` or `<name>-end`, and else the first line called `<name>`.
 */
export function lineOf(
  lines: GridLines,
  line: GridLine,
  side: 'start' | 'end',
): number | null {
  if (!line || 'span' in line) return null;
  if ('line' in line) {
    if (line.name !== undefined) return namedLine(lines, line.name, line.line);
    return line.line > 0 ? line.line - 1 : lines.tracks + 1 + line.line;
  }
  const edge = lines.named.get(`${line.name}-${side}`);
  if (edge?.length) return edge[0];
  return namedLine(lines, line.name, 1);
}

/**
 * Where a span of a name ends, counting `count` lines of that name on from
 * `from` (forward) or back from it: the implicit lines past the grid's
 * ends all count as having the name.
 */
export function spanToName(
  lines: GridLines,
  name: string,
  count: number,
  from: number,
  forward: boolean,
): number {
  const list = lines.named.get(name) ?? [];
  if (forward) {
    const after = list.filter((l) => l > from);
    if (count <= after.length) return after[count - 1];
    return Math.max(from, lines.tracks) + (count - after.length);
  }
  const before = list.filter((l) => l < from);
  if (count <= before.length) return before[before.length - count];
  return Math.min(from, 0) - (count - before.length);
}

/**
 * An item's start line and how many tracks it spans on one axis (8.3.1):
 * the start null where the auto placement is to find it. Two lines the
 * wrong way round are swapped, and one line twice spans a track; a span of
 * a name with nothing to count it from spans one.
 */
export function placement(
  start: GridLine,
  end: GridLine,
  lines: GridLines,
): [number | null, number] {
  let from = lineOf(lines, start, 'start');
  let to = lineOf(lines, end, 'end');
  const spanOf = (l: GridLine) => (l && 'span' in l ? l : null);
  if (from !== null && to !== null) {
    if (to < from) [from, to] = [to, from];
    if (to === from) to = from + 1;
  } else if (from !== null) {
    const s = spanOf(end);
    to =
      s?.name !== undefined
        ? spanToName(lines, s.name, s.span, from, true)
        : from + (s?.span ?? 1);
  } else if (to !== null) {
    const s = spanOf(start);
    from =
      s?.name !== undefined
        ? spanToName(lines, s.name, s.span, to, false)
        : to - (s?.span ?? 1);
  } else {
    const s = spanOf(start) ?? spanOf(end);
    return [null, s && s.name === undefined ? s.span : 1];
  }
  // the grid here has no tracks before its first line
  if (from < 0) {
    to = Math.max(1, to + -from);
    from = 0;
  }
  return [from, Math.max(1, to - from)];
}
