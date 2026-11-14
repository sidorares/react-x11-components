// The grid properties as `el.style` keeps them (CSSOM 6.7): a value the
// property does not take refused, and one it does in its canonical form —
// keywords in lower case, white space one space, a track list's empty name
// groups dropped, a grid line's number before its name and `span` first,
// `span 1` as `span` — and the placement shorthands set as their
// longhands, and read back from them as short as they can be said. The
// parse is the cascade's own (`style.ts`), so what a style takes and what
// `el.style` takes are one rule.
import { splitCommas, splitValue } from './values.js';
import {
  isLineName,
  lanesDirection,
  lanesShorthand,
  lineNames,
  parseAreas,
  parseGridLine,
  parseGridTemplate,
  parseGridTrack,
  parseSubgrid,
  trackParts,
} from './style.js';
import type { GridLine } from './style.js';
import type { UnitContext } from './values.js';

const CHECK: UnitContext = { em: 16, rem: 16, vw: 1, vh: 1, scale: 1 };

/** The grid properties this answers for. */
export const GRID_SPECIFIED = new Set([
  'grid-template-columns',
  'grid-template-rows',
  'grid-template-areas',
  'grid-auto-columns',
  'grid-auto-rows',
  'grid-auto-flow',
  'grid-row-start',
  'grid-row-end',
  'grid-column-start',
  'grid-column-end',
  'grid-row',
  'grid-column',
  'grid-area',
  'grid-lanes-direction',
  'grid-lanes-pack',
  'fit-tolerance',
]);

/** A grid property's value in its canonical form, or null where the
 *  property does not take it. */
export function gridSpecified(name: string, value: string): string | null {
  const v = value.trim();
  switch (name) {
    case 'grid-template-columns':
    case 'grid-template-rows':
      return templateText(v);
    case 'grid-template-areas':
      return areasSpecified(v);
    case 'grid-auto-columns':
    case 'grid-auto-rows': {
      const parts = splitValue(v);
      if (!parts.length) return null;
      for (const part of parts) if (!parseGridTrack(part, CHECK)) return null;
      return parts.map(trackText).join(' ');
    }
    case 'grid-auto-flow':
      return autoFlowText(v);
    case 'grid-row-start':
    case 'grid-row-end':
    case 'grid-column-start':
    case 'grid-column-end': {
      const line = parseGridLine(v);
      return line === undefined || /\//.test(v) ? null : lineText(line);
    }
    case 'grid-row':
    case 'grid-column': {
      const lines = axisLines(v);
      return lines ? axisText(lines[0], lines[1]) : null;
    }
    case 'grid-area': {
      const lines = areaLines(v);
      return lines ? areaText(lines) : null;
    }
    case 'grid-lanes-direction':
      return lanesDirection(v);
    case 'grid-lanes-pack': {
      const word = v.toLowerCase();
      return word === 'normal' || word === 'dense' ? word : null;
    }
    case 'fit-tolerance':
      return toleranceText(v);
  }
  return null;
}

/** The longhands a placement shorthand sets, from its canonical form. */
export function gridLonghands(
  name: string,
  value: string,
): [string, string][] | null {
  if (name === 'grid-row' || name === 'grid-column') {
    const lines = axisLines(value);
    if (!lines) return null;
    return [
      [`${name}-start`, lineText(lines[0])],
      [`${name}-end`, lineText(lines[1])],
    ];
  }
  if (name === 'grid-area') {
    const lines = areaLines(value);
    if (!lines) return null;
    return AREA_LONGHANDS.map((longhand, i) => [longhand, lineText(lines[i])]);
  }
  if (name === 'grid-lanes') {
    const lanes = lanesShorthand(value, CHECK);
    if (!lanes) return null;
    // the lanes' template, written again from its value as it was given
    const template = lanesTemplateOf(value);
    const rows = lanes.direction.startsWith('row');
    const areas = lanes.areas
      ? areasFrom(lanes.areas.rows, lanes.areas.columns, lanes.areas.areas)
      : 'none';
    return [
      ['grid-template-columns', rows ? 'none' : template],
      ['grid-template-rows', rows ? template : 'none'],
      ['grid-template-areas', areas],
      ['grid-lanes-direction', lanes.direction],
    ];
  }
  return null;
}

/** A placement shorthand read back from its longhands, or '' where they
 *  cannot be said in it; null for no such shorthand. */
export function gridShorthand(
  name: string,
  longhand: (name: string) => string | null,
): string | null {
  if (name === 'grid-row' || name === 'grid-column') {
    const start = lineOf(longhand(`${name}-start`));
    const end = lineOf(longhand(`${name}-end`));
    if (start === undefined || end === undefined) return '';
    return axisText(start, end);
  }
  if (name === 'grid-area') {
    const lines = AREA_LONGHANDS.map((part) => lineOf(longhand(part)));
    if (lines.some((line) => line === undefined)) return '';
    return areaText(lines as GridLine[]);
  }
  if (name === 'grid-lanes') {
    const direction = longhand('grid-lanes-direction');
    const columns = longhand('grid-template-columns');
    const rows = longhand('grid-template-rows');
    const areas = longhand('grid-template-areas');
    if (!direction || !columns || !rows || !areas) return '';
    const byRows = direction.startsWith('row');
    const template = byRows ? rows : columns;
    const parts: string[] = [];
    if (areas !== 'none') {
      const strings = areas.match(/"[^"]*"/g) ?? [];
      const cells = strings.map((s) => s.slice(1, -1).trim().split(/\s+/));
      if (byRows ? cells.some((row) => row.length !== 1) : cells.length !== 1) {
        return '';
      }
      parts.push(
        `"${(byRows ? cells.map((row) => row[0]) : cells[0]).join(' ')}"`,
      );
    }
    if (template !== 'none') parts.push(template);
    parts.push(direction);
    return parts.join(' ');
  }
  return null;
}

const AREA_LONGHANDS = [
  'grid-row-start',
  'grid-column-start',
  'grid-row-end',
  'grid-column-end',
];

/** A longhand's line, undefined where it is none or not one. */
function lineOf(text: string | null): GridLine | undefined {
  if (text === null) return undefined;
  return parseGridLine(text);
}

/** A grid line as it serializes: `auto`, a number before a name, and
 *  `span` first, with no count where it is 1 and a name follows. */
export function lineText(line: GridLine): string {
  if (line === null) return 'auto';
  if ('span' in line) {
    if (!line.name) return `span ${line.span}`;
    return line.span === 1
      ? `span ${line.name}`
      : `span ${line.span} ${line.name}`;
  }
  if ('line' in line) {
    return line.name ? `${line.line} ${line.name}` : String(line.line);
  }
  return line.name;
}

/** A line that is a name alone, which a shorthand copies into a line it
 *  leaves out; auto for any other (CSS Grid 1, 8.4). */
function named(line: GridLine): GridLine {
  return line && !('span' in line) && !('line' in line) ? line : null;
}

/** Whether a shorthand can leave `next` out after `first`. */
function follows(first: GridLine, next: GridLine): boolean {
  return lineText(next) === lineText(named(first));
}

/** A value's parts either side of its slashes, none inside a function. */
function slashParts(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === '/' && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out.map((part) => part.trim());
}

/** `grid-row`'s or `grid-column`'s two lines, the end the start where that
 *  is a name and auto where not. */
function axisLines(value: string): [GridLine, GridLine] | null {
  const parts = slashParts(value);
  if (parts.length > 2 || parts.some((part) => !part)) return null;
  const start = parseGridLine(parts[0]);
  if (start === undefined) return null;
  const end = parts.length > 1 ? parseGridLine(parts[1]) : named(start);
  if (end === undefined) return null;
  return [start, end];
}

function axisText(start: GridLine, end: GridLine): string {
  return follows(start, end)
    ? lineText(start)
    : `${lineText(start)} / ${lineText(end)}`;
}

/** `grid-area`'s four lines, each one left out the one it copies. */
function areaLines(value: string): GridLine[] | null {
  const parts = slashParts(value);
  if (parts.length > 4 || parts.some((part) => !part)) return null;
  const lines: GridLine[] = [];
  for (const part of parts) {
    const line = parseGridLine(part);
    if (line === undefined) return null;
    lines.push(line);
  }
  if (lines.length < 2) lines.push(named(lines[0]));
  if (lines.length < 3) lines.push(named(lines[0]));
  if (lines.length < 4) lines.push(named(lines[1]));
  return lines;
}

/** `grid-area`, its last line left off where it can be, then the one
 *  before it, and so on. */
function areaText(lines: readonly GridLine[]): string {
  const [rowStart, columnStart, rowEnd, columnEnd] = lines;
  let count = 4;
  if (follows(columnStart, columnEnd)) {
    count = 3;
    if (follows(rowStart, rowEnd)) {
      count = 2;
      if (follows(rowStart, columnStart)) count = 1;
    }
  }
  return lines.slice(0, count).map(lineText).join(' / ');
}

/** A track size as written, canonical: keywords and units in lower case,
 *  white space one space, `minmax()`'s and `fit-content()`'s arguments
 *  each canonical too. */
function trackText(part: string): string {
  const fn = /^(minmax|fit-content)\((.*)\)$/is.exec(part.trim());
  if (fn) {
    const args = splitCommas(fn[2]).map((arg) => trackText(arg));
    return `${fn[1].toLowerCase()}(${args.join(', ')})`;
  }
  return part.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A track list's parts, canonical: an empty group of names dropped, a
 *  `repeat()` as `repeat(count, …)`. */
function partsText(parts: readonly string[], keepEmpty: boolean): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part.startsWith('[')) {
      const names = lineNames(part) ?? [];
      if (names.length || keepEmpty) out.push(`[${names.join(' ')}]`);
      continue;
    }
    const repeat = /^repeat\((.*)\)$/is.exec(part);
    if (repeat) {
      const [count, ...rest] = splitCommas(repeat[1]);
      const inner = trackParts(rest.join(',')) ?? [];
      out.push(
        `repeat(${count.trim().toLowerCase()}, ${partsText(inner, keepEmpty)})`,
      );
      continue;
    }
    out.push(trackText(part));
  }
  return out.join(' ');
}

/** `grid-template-columns` or `-rows`: `none`, `subgrid` and its names, or
 *  a track list the cascade takes. */
function templateText(value: string): string | null {
  if (value.toLowerCase() === 'none') return 'none';
  if (/^subgrid\b/i.test(value)) {
    const rest = value.slice('subgrid'.length);
    if (!parseSubgrid(rest)) return null;
    const parts = rest.trim() ? (trackParts(rest) ?? []) : [];
    return parts.length ? `subgrid ${partsText(parts, true)}` : 'subgrid';
  }
  if (!parseGridTemplate(value, CHECK)) return null;
  return partsText(trackParts(value) ?? [], false);
}

/** The lanes' template in a `grid-lanes` value: what is left of it once the
 *  area string and the direction are taken out. */
function lanesTemplateOf(value: string): string {
  const words = new Set([
    'normal',
    'row',
    'column',
    'fill-reverse',
    'track-reverse',
  ]);
  const parts = (trackParts(value) ?? []).filter(
    (part) => !words.has(part.toLowerCase()) && !/^["']/.test(part),
  );
  return parts.length ? partsText(parts, false) : 'none';
}

/** `grid-template-areas`: `none`, or strings that make a grid of
 *  rectangles, each a row, its cells a name or a `.`. */
function areasSpecified(value: string): string | null {
  if (value.toLowerCase() === 'none') return 'none';
  const parts = trackParts(value);
  if (!parts?.length || !parts.every((part) => /^["']/.test(part))) return null;
  const areas = parseAreas(parts);
  if (!areas) return null;
  return parts
    .map((part) => {
      const cells: string[] = [];
      const re = /\s*(?:(\.+)|([\w\u0080-￿-]+))/g;
      const text = part.slice(1, -1);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) && m[0].trim()) cells.push(m[1] ? '.' : m[2]);
      return `"${cells.join(' ')}"`;
    })
    .join(' ');
}

/** Areas as strings from their rectangles, a `.` for a cell none has. */
function areasFrom(
  rows: number,
  columns: number,
  areas: ReadonlyMap<
    string,
    { rows: [number, number]; columns: [number, number] }
  >,
): string {
  const cells: string[][] = [];
  for (let r = 0; r < rows; r += 1)
    cells.push(new Array<string>(columns).fill('.'));
  for (const [name, area] of areas) {
    for (let r = area.rows[0]; r < area.rows[1]; r += 1) {
      for (let c = area.columns[0]; c < area.columns[1]; c += 1) {
        cells[r][c] = name;
      }
    }
  }
  return cells.map((row) => `"${row.join(' ')}"`).join(' ');
}

/** `grid-auto-flow`: `row` or `column`, and `dense`, in either order; `row
 *  dense` as `dense`. */
function autoFlowText(value: string): string | null {
  const words = value.toLowerCase().split(/\s+/);
  const dense = words.filter((w) => w === 'dense').length;
  const axis = words.filter((w) => w !== 'dense');
  if (dense > 1 || axis.length > 1 || words.length > 2) return null;
  if (axis.length && axis[0] !== 'row' && axis[0] !== 'column') return null;
  if (!dense) return axis[0] ?? null;
  return axis[0] === 'column' ? 'column dense' : 'dense';
}

/** `fit-tolerance`: `normal`, `infinite`, or a length or a percentage none
 *  below nought as written. */
function toleranceText(value: string): string | null {
  const v = value.toLowerCase();
  if (v === 'normal' || v === 'infinite') return v;
  if (v === '0') return '0px';
  if (/^-/.test(v) || (/\s/.test(v) && !/^[a-z-]+\(/.test(v))) return null;
  if (/^[\d.]+$/.test(v)) return null;
  // a length, a percentage or a calculation of them, as the cascade takes
  const track = parseGridTrack(v, CHECK);
  if (!track || typeof track.max === 'string' || isLineName(v)) return null;
  if (
    typeof track.max === 'object' &&
    ('fr' in track.max || 'fit' in track.max)
  ) {
    return null;
  }
  return v.replace(/\s+/g, ' ');
}
