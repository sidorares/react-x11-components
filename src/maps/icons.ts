// Icons: the pictogram a symbol layer can set beside a point's name — the
// bus on a bus stop, so that "Lyons Ave/Yuille St" reads as a stop and not
// as a street.
//
// An icon is two pieces, each one colour: a rounded **plate** in the layer's
// colour and a **glyph** over it, white by default. Two single-colour pieces
// rather than one picture because that is what both renderers already draw
// text as: the retained renderer fills a path, and the GL renderer keeps a
// coverage raster in its label atlas and colours it in the shader — so an
// icon is two more of those, and one raster serves every palette.
//
// Both renderers trace the same paths from here, the way both take their
// label anchors from `./anchors.ts`: a map switched from one renderer to the
// other draws the same bus.

/** The pictograms a symbol layer can name. */
export type MapIcon = 'bus' | 'tram' | 'train' | 'ferry' | 'airport';

/** Every {@link MapIcon}, for a style editor's picker. */
export const MAP_ICONS: readonly MapIcon[] = [
  'bus',
  'tram',
  'train',
  'ferry',
  'airport',
];

/** Logical pixels across a plate, where the layer does not say. */
export const DEFAULT_ICON_SIZE = 14;
export const DEFAULT_ICON_COLOR = '#2a6fb8';
export const DEFAULT_ICON_GLYPH_COLOR = '#ffffff';
/** Logical pixels between an icon's plate and the name set beside it. */
export const ICON_GAP = 3;

/** The slice of a 2D context an icon is traced with — `MapCanvas`'s, and
 *  the offscreen surface's the GL atlas rasterizes on. */
export interface IconPathContext {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, from: number, to: number): void;
  closePath(): void;
}

/** The grid a glyph is drawn on: a plate is this many units across. */
const GRID = 16;

/**
 * Each glyph as polygons on the {@link GRID}, `[x0, y0, x1, y1, …]`.
 *
 * Solid shapes only, and a window is where no shape is: a glyph is filled
 * with the non-zero rule, where a hole would take a second winding, and
 * {@link wound} turns every polygon the same way so that two that touch
 * fill as one rather than cancelling.
 */
const GLYPHS: Record<MapIcon, readonly (readonly number[])[]> = {
  // Head on: a roof, the windscreen between two pillars, the lower panel,
  // wheels and mirrors.
  bus: [
    [4, 3.5, 5, 2.5, 11, 2.5, 12, 3.5, 12, 4.6, 4, 4.6],
    rect(4, 4.6, 1.2, 4),
    rect(10.8, 4.6, 1.2, 4),
    rect(4, 8.6, 8, 3.6),
    rect(4.6, 12.2, 2, 1.4),
    rect(9.4, 12.2, 2, 1.4),
    rect(2.9, 5, 0.8, 2),
    rect(12.3, 5, 0.8, 2),
  ],
  // A car under its pantograph, on rails.
  tram: [
    rect(5.4, 1.4, 5.2, 0.8),
    rect(7.6, 2.2, 0.8, 1.4),
    [4.5, 4.6, 5.5, 3.6, 10.5, 3.6, 11.5, 4.6, 11.5, 5.4, 4.5, 5.4],
    rect(4.5, 5.4, 1.1, 3.6),
    rect(10.4, 5.4, 1.1, 3.6),
    rect(4.5, 9, 7, 3),
    [5.6, 12, 6.9, 12, 5.8, 14.2, 4.5, 14.2],
    [9.1, 12, 10.4, 12, 11.5, 14.2, 10.2, 14.2],
  ],
  // A locomotive's rounded nose, with its rails splayed wider than a tram's.
  train: [
    [4, 5, 4.6, 3, 6, 2.2, 10, 2.2, 11.4, 3, 12, 5, 12, 5.6, 4, 5.6],
    rect(4, 5.6, 1.2, 3),
    rect(10.8, 5.6, 1.2, 3),
    rect(4, 8.6, 8, 3),
    [5, 11.6, 6.4, 11.6, 4.8, 14.2, 3.4, 14.2],
    [9.6, 11.6, 11, 11.6, 12.6, 14.2, 11.2, 14.2],
  ],
  // Side on: a hull, a deckhouse, a funnel.
  ferry: [
    [2, 9, 14, 9, 12.2, 12.6, 3.8, 12.6],
    rect(4.4, 6, 6.8, 3),
    rect(6.2, 3.6, 2.2, 2.4),
  ],
  // An aircraft from above, nose up.
  airport: [
    [
      8, 1.8, 8.9, 2.8, 8.9, 6.6, 14, 9.6, 14, 10.8, 8.9, 9.3, 8.9, 12.3, 10.6,
      13.6, 10.6, 14.4, 8, 13.7, 5.4, 14.4, 5.4, 13.6, 7.1, 12.3, 7.1, 9.3, 2,
      10.8, 2, 9.6, 7.1, 6.6, 7.1, 2.8,
    ],
  ],
};

function rect(x: number, y: number, w: number, h: number): number[] {
  return [x, y, x + w, y, x + w, y + h, x, y + h];
}

/** The polygon wound clockwise on screen (y down) — positive shoelace
 *  area — whichever way it was written. */
function wound(points: readonly number[]): readonly number[] {
  let area = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area +=
      points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  if (area >= 0) return points;
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(points[i * 2], points[i * 2 + 1]);
  return out;
}

const WOUND = {} as Record<MapIcon, readonly (readonly number[])[]>;
for (const name of MAP_ICONS) WOUND[name] = GLYPHS[name].map(wound);

/** Whether `name` is an icon this module draws — a style is data, and may
 *  come from a file that names one this version does not have. */
export function isMapIcon(name: unknown): name is MapIcon {
  return (
    typeof name === 'string' &&
    Object.prototype.hasOwnProperty.call(GLYPHS, name)
  );
}

/**
 * Trace a plate `size` across, centred on `cx, cy`: a square with corners
 * rounded by a fifth of it. Adds to the current path; the caller begins it
 * and fills it.
 */
export function tracePlate(
  ctx: IconPathContext,
  cx: number,
  cy: number,
  size: number,
): void {
  const x = cx - size / 2;
  const y = cy - size / 2;
  const r = size * 0.2;
  const e = size - r;
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + e, y);
  ctx.arc(x + e, y + r, r, -Math.PI / 2, 0);
  ctx.lineTo(x + size, y + e);
  ctx.arc(x + e, y + e, r, 0, Math.PI / 2);
  ctx.lineTo(x + r, y + size);
  ctx.arc(x + r, y + e, r, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

/** Trace `icon`'s glyph over a plate `size` across, centred on `cx, cy`.
 *  Adds to the current path, as {@link tracePlate} does. */
export function traceGlyph(
  ctx: IconPathContext,
  icon: MapIcon,
  cx: number,
  cy: number,
  size: number,
): void {
  const unit = size / GRID;
  const x = cx - size / 2;
  const y = cy - size / 2;
  for (const shape of WOUND[icon]) {
    ctx.moveTo(x + shape[0] * unit, y + shape[1] * unit);
    for (let i = 2; i < shape.length; i += 2) {
      ctx.lineTo(x + shape[i] * unit, y + shape[i + 1] * unit);
    }
    ctx.closePath();
  }
}
