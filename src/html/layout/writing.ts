// Vertical writing modes (CSS Writing Modes 4), as a frame turned on its
// side.
//
// A box whose writing mode is vertical inside one that is horizontal is the
// root of an orthogonal flow (7.3). Everything it holds is laid out by the
// horizontal layout this engine has — block flow, lines, floats, tables —
// in a frame whose x is the flow's inline axis and whose y its block axis,
// and the frame is painted turned a quarter, clockwise for `vertical-rl`,
// `vertical-lr` and `sideways-rl` and the other way for `sideways-lr`. The
// frame is an anonymous block box, the root's only child, carrying the turn
// as its transform, so every walk that already goes through a transform —
// paint, the hit test, the damage, a rect read back — goes through this
// one. The root itself is laid out by its parent as any box, in the page's
// own axes, and sizes itself from what its frame came to (`layoutFramed` in
// `block.ts`).
//
// What makes the boxes in the frame lay out in its axes is their styles:
// each is its style turned (`framedStyle`), its physical sides and sizes
// handed to the frame's — the box's right margin is the frame's top in
// `vertical-rl` — so that the horizontal layout reads the flow's block and
// inline sides where it reads top and left. The element's own style, the
// one the cascade keeps and a script reads, is the page's.
//
// `vertical-lr` stacks its lines left to right, which a turn clockwise does
// not: the frame is laid out as `vertical-rl`'s is and its lines and blocks
// put back in the other order down the frame afterwards (`reflectFrame`),
// each moved and none mirrored, so that its glyphs stay the right way up.
import type { Box, LineBox, TextLayoutLike } from './boxes.js';
import type { BoxShadow, ComputedStyle, WritingMode } from '../css/style.js';
import { copyStyle } from '../css/style.js';
import type { TransformFunction } from '../css/transform.js';
import { mapAnchorCalls } from '../css/anchor.js';
import type {
  AnchorInset,
  AnchorSize,
  AnchorSizeRef,
  InsetSide,
} from '../css/anchor.js';
import type { AnchorSizeField } from '../css/style.js';
import type { TextRun } from '../../richtext/index.js';

/** Each orthogonal flow root's frame, by the root. */
export const FRAMES = new WeakMap<Box, Box>();

/** Each frame's root, by the frame. */
export const FRAME_ROOTS = new WeakMap<Box, Box>();

/** Whether the tree being laid out or painted holds a frame
 *  (`BoxTree.vertical`), set as a layout or a paint of a tree begins: what
 *  the layout's and the paint's questions of each box ask first, so a
 *  document in no vertical writing mode asks a boolean and no more. */
export const framed = { any: false };

/** The quarter turn a frame is drawn through: clockwise, as `rotate(90deg)`
 *  turns it, and the other way. Written as matrices, which are exact where
 *  a turn's cosine is not quite 0. */
const CLOCKWISE: TransformFunction[] = [{ matrix: [0, 1, -1, 0, 0, 0] }];
const ANTICLOCKWISE: TransformFunction[] = [{ matrix: [0, -1, 1, 0, 0, 0] }];

/** Whether a writing mode's frame is turned the other way: `sideways-lr`'s
 *  lines run up the page. */
export function turnsUp(mode: WritingMode): boolean {
  return mode === 'sideways-lr';
}

/** Whether a writing mode stacks its lines left to right while its glyphs
 *  are turned clockwise, which the frame is laid out the other way for and
 *  put back (`reflectFrame`). */
export function reflects(mode: WritingMode): boolean {
  return mode === 'vertical-lr';
}

/**
 * Make `box`, a block container in a vertical writing mode inside a
 * horizontal one, the root of an orthogonal flow: what it holds goes into
 * an anonymous block, its frame, turned a quarter, and every box in the
 * frame takes its style turned into the frame's axes. `frameStyle` is the
 * frame's own, an anonymous block's style under the root's.
 */
export function makeFrame(box: Box, frameStyle: ComputedStyle): Box {
  const mode = box.style.writingMode;
  const style = copyStyle(frameStyle);
  style.display = 'block';
  style.transform = turnsUp(mode) ? ANTICLOCKWISE : CLOCKWISE;
  style.transformOrigin = [0, 0];
  const frame = new (box.constructor as typeof Box)('block', null, style);
  // a list item's marker goes beside its first line, which is the frame's
  // and turned with it: none is drawn for it yet
  box.marker = null;
  const children = box.children;
  box.children = [];
  box.append(frame);
  frame.children = children;
  for (const child of children) child.parent = frame;
  const turned = new Map<ComputedStyle, ComputedStyle>();
  const stack: Box[] = [...children];
  while (stack.length) {
    const at = stack.pop()!;
    let own = turned.get(at.style);
    if (!own) {
      own = framedStyle(at.style, mode);
      turned.set(at.style, own);
    }
    at.style = own;
    for (const child of at.children) stack.push(child);
  }
  FRAMES.set(box, frame);
  FRAME_ROOTS.set(frame, box);
  return frame;
}

type Side = 'Top' | 'Right' | 'Bottom' | 'Left';

/** Which physical side each of the frame's — top, right, bottom, left —
 *  is: a turn clockwise puts the frame's top at the page's right, and one
 *  the other way at its left. */
const CLOCKWISE_SIDES: readonly Side[] = ['Right', 'Bottom', 'Left', 'Top'];
const ANTICLOCKWISE_SIDES: readonly Side[] = ['Left', 'Top', 'Right', 'Bottom'];
/** `vertical-lr`'s margins: laid out as `vertical-rl`'s and its blocks put
 *  back in the other order across (`reflectFrame`), the margin a block has
 *  before it in the frame is the one after it on the page. */
const REFLECTED_MARGINS: readonly Side[] = ['Left', 'Bottom', 'Right', 'Top'];
const FRAME_SIDES: readonly Side[] = ['Top', 'Right', 'Bottom', 'Left'];

/**
 * A style as the frame of a writing mode lays it out: its physical sides
 * each handed to the side of the frame that is drawn there, its widths to
 * its heights, its corners to the corners they are drawn at and its
 * shadows' offsets turned back — so that a box laid out in the frame and
 * drawn turned with it has its right margin on the page's right.
 */
export function framedStyle(
  style: ComputedStyle,
  mode: WritingMode,
): ComputedStyle {
  const out = copyStyle(style);
  const up = turnsUp(mode);
  const sides = up ? ANTICLOCKWISE_SIDES : CLOCKWISE_SIDES;
  const margins = reflects(mode) ? REFLECTED_MARGINS : sides;
  const from = style as unknown as Record<string, unknown>;
  const to = out as unknown as Record<string, unknown>;
  for (let i = 0; i < 4; i += 1) {
    const side = FRAME_SIDES[i];
    const page = sides[i];
    to[`padding${side}`] = from[`padding${page}`];
    to[`border${side}Width`] = from[`border${page}Width`];
    to[`border${side}Style`] = from[`border${page}Style`];
    to[`border${side}Color`] = from[`border${page}Color`];
    to[`margin${side}`] = from[`margin${margins[i]}`];
    to[side.toLowerCase()] = from[page.toLowerCase()];
  }
  out.width = style.height;
  out.height = style.width;
  out.minWidth = style.minHeight;
  out.minHeight = style.minWidth;
  out.maxWidth = style.maxHeight;
  out.maxHeight = style.maxWidth;
  out.widthKeyword = style.heightKeyword;
  out.heightKeyword = style.widthKeyword;
  out.minWidthKeyword = style.minHeightKeyword;
  out.minHeightKeyword = style.minWidthKeyword;
  out.maxWidthKeyword = style.maxHeightKeyword;
  out.maxHeightKeyword = style.maxWidthKeyword;
  out.widthSize = style.heightSize;
  out.heightSize = style.widthSize;
  out.minWidthSize = style.minHeightSize;
  out.minHeightSize = style.minWidthSize;
  out.maxWidthSize = style.maxHeightSize;
  out.maxHeightSize = style.maxWidthSize;
  out.containIntrinsicWidth = style.containIntrinsicHeight;
  out.containIntrinsicHeight = style.containIntrinsicWidth;
  out.overflowX = style.overflowY;
  out.overflowY = style.overflowX;
  out.borderSpacing = style.borderSpacingY;
  out.borderSpacingY = style.borderSpacing;
  if (style.aspectRatio) {
    out.aspectRatio = {
      ...style.aspectRatio,
      ratio: 1 / style.aspectRatio.ratio,
    };
  }
  // the corners, from the one the frame's top left is drawn at round, each
  // radius across the frame its radius down the page
  const shift = up ? 3 : 1;
  const across = style.borderRadius;
  const down = style.borderRadiusY ?? across;
  const at = (list: readonly unknown[], i: number) => list[(i + shift) % 4];
  out.borderRadius = [0, 1, 2, 3].map((i) =>
    at(down, i),
  ) as ComputedStyle['borderRadius'];
  const radiiY = [0, 1, 2, 3].map((i) =>
    at(across, i),
  ) as ComputedStyle['borderRadiusY'] & object;
  out.borderRadiusY = radiiY.every((r, i) => r === out.borderRadius[i])
    ? null
    : radiiY;
  if (style.cornerShape.some((k) => k !== 1)) {
    out.cornerShape = [0, 1, 2, 3].map((i) =>
      at(style.cornerShape, i),
    ) as unknown as ComputedStyle['cornerShape'];
  }
  if (style.boxShadow)
    out.boxShadow = style.boxShadow.map((s) => turned(s, up));
  if (style.textShadow) {
    out.textShadow = style.textShadow.map((s) => turned(s, up));
  }
  turnAnchoring(style, out, mode);
  return out;
}

/**
 * What places a box against its anchor, in the frame's axes: each
 * `anchor()` inset at the frame's side drawn where the page's is, reading
 * the anchor's side drawn where it reads, and each `anchor-size()` the
 * frame's size the page's is — the logical sides and sizes as they are,
 * which the layout reads against the writing modes there — and the
 * `@position-try` rules' styles turned as the box's is.
 */
function turnAnchoring(
  style: ComputedStyle,
  out: ComputedStyle,
  mode: WritingMode,
): void {
  const insets = style.anchorInsets;
  if (insets) {
    const turnedInsets: Partial<Record<InsetSide, AnchorInset>> = {};
    for (const [side, inset] of Object.entries(insets) as [
      InsetSide,
      AnchorInset,
    ][]) {
      turnedInsets[frameSideOf(side, mode)] = mapAnchorCalls(inset, (ref) =>
        typeof ref.side === 'string' && PHYSICAL.has(ref.side)
          ? { ...ref, side: frameSideOf(ref.side as PhysicalSide, mode) }
          : ref,
      );
    }
    out.anchorInsets = turnedInsets;
  }
  const sizes = style.anchorSizes;
  if (sizes) {
    const across = (ref: AnchorSizeRef): AnchorSizeRef =>
      ref.size === 'width'
        ? { ...ref, size: 'height' }
        : ref.size === 'height'
          ? { ...ref, size: 'width' }
          : ref;
    // each field at the frame's the page's is laid out at, as
    // `framedStyle` hands the box's own over: a margin as its margins are
    const sides = turnsUp(mode) ? ANTICLOCKWISE_SIDES : CLOCKWISE_SIDES;
    const margins = reflects(mode) ? REFLECTED_MARGINS : sides;
    const to: Record<string, AnchorSizeField> = {
      width: 'height',
      height: 'width',
      minWidth: 'minHeight',
      minHeight: 'minWidth',
      maxWidth: 'maxHeight',
      maxHeight: 'maxWidth',
    };
    for (let i = 0; i < 4; i += 1) {
      const frame = FRAME_SIDES[i];
      to[sides[i].toLowerCase()] = frame.toLowerCase() as AnchorSizeField;
      to[`margin${margins[i]}`] = `margin${frame}` as AnchorSizeField;
    }
    const turnedSizes: Partial<Record<AnchorSizeField, AnchorSize>> = {};
    for (const [field, size] of Object.entries(sizes) as [
      AnchorSizeField,
      AnchorSize,
    ][]) {
      turnedSizes[to[field] ?? field] = mapAnchorCalls(size, across);
    }
    out.anchorSizes = turnedSizes;
  }
  if (style.positionTryStyles) {
    out.positionTryStyles = style.positionTryStyles.map(
      (tried) => tried && framedStyle(tried, mode),
    );
  }
}

const PHYSICAL = new Set<string>(['top', 'right', 'bottom', 'left']);

/** A shadow's offset in the frame's axes: the one the turn takes to the
 *  offset written. */
function turned(shadow: BoxShadow, up: boolean): BoxShadow {
  return up
    ? { ...shadow, x: -shadow.y, y: shadow.x }
    : { ...shadow, x: shadow.y, y: -shadow.x };
}

/**
 * Whether a character stands upright in a vertical line where its
 * `text-orientation` is `mixed`: the scripts and symbols Unicode's
 * Vertical_Orientation gives `U` or `Tu` (UAX #50) — Han, kana, Hangul,
 * Yi, Bopomofo, the CJK symbols and punctuation, fullwidth forms and the
 * enclosed and pictographic symbols — where the rest of the text is set
 * turned on its side. `Tr` (a bracket, a long vowel mark) is upright too,
 * since its vertical form is the face's to give (`vert`).
 */
export function uprightInMixed(cp: number): boolean {
  if (cp < 0x1100) {
    return (
      cp === 0xa7 ||
      cp === 0xa9 ||
      cp === 0xae ||
      cp === 0xb1 ||
      cp === 0xbc ||
      cp === 0xbd ||
      cp === 0xbe ||
      cp === 0xd7 ||
      cp === 0xf7
    );
  }
  if (cp <= 0x11ff) return true; // Hangul Jamo
  if (cp >= 0x2460 && cp <= 0x24ff) return true; // enclosed alphanumerics
  if (cp >= 0x25a0 && cp <= 0x27bf) return true; // shapes, symbols, dingbats
  if (cp >= 0x2e80 && cp <= 0xa4cf) return true; // CJK through Yi
  if (cp >= 0xa960 && cp <= 0xa97f) return true; // Hangul Jamo Extended-A
  if (cp >= 0xac00 && cp <= 0xd7ff) return true; // Hangul
  if (cp >= 0xe000 && cp <= 0xfaff) return true; // private use, compatibility
  if (cp >= 0xfe10 && cp <= 0xfe1f) return true; // vertical forms
  if (cp >= 0xfe30 && cp <= 0xfe6f) return true; // compatibility, small forms
  if (cp >= 0xff00 && cp <= 0xff60) return true; // fullwidth forms
  if (cp >= 0xffe0 && cp <= 0xffe7) return true;
  if (cp >= 0x1f000 && cp <= 0x1faff) return true; // pictographs, emoji
  return cp >= 0x20000 && cp <= 0x3fffd; // the CJK supplementary planes
}

/**
 * A run a vertical line sets upright, one character of it, carries the
 * layout that character is drawn from, upright, under this key: a laid run
 * hands its run back as its `span`, and a copy of the run made on the way
 * to the engine — `{ ...run, nowrap }` — keeps it, as it would not keep
 * the run's identity. No engine reads it, and no cache compares it: the
 * run's spacing has a hair in it no horizontal run's has
 * (`uprightItems`).
 *
 * Upright text is laid out in the frame as a horizontal line, each upright
 * character a run of its own spaced to an em, which is how far a vertical
 * line advances over an upright glyph, and the run is left out of what the
 * frame draws and drawn after the frame, upright, at where the turn puts
 * its cell's middle (`paintUpright` in `paint.ts`). So no engine is asked
 * to turn a glyph back, and ntk, which turns none, draws it as it draws
 * any.
 */
const UPRIGHT = Symbol('upright');

/** Mark a run as set upright, drawn from `glyph`. */
export function setUpright(run: TextRun, glyph: TextLayoutLike): void {
  (run as unknown as Record<symbol, TextLayoutLike>)[UPRIGHT] = glyph;
}

/** The glyph a run set upright is drawn from, or undefined for any other
 *  run. */
export function uprightGlyphOf(
  run: TextRun | undefined,
): TextLayoutLike | undefined {
  return run && (run as unknown as Record<symbol, TextLayoutLike>)[UPRIGHT];
}

/** One upright character on a layout's line, from the layout's origin: its
 *  cell across, the middle of its em box down, and its glyph's layout. */
export interface UprightCell {
  x: number;
  width: number;
  /** Where its middle is down the frame, from the layout's origin. */
  middle: number;
  glyph: TextLayoutLike;
}

/** A layout's upright cells, a list for each of its lines — null for a
 *  layout with none — worked out once for the layout, which is kept across
 *  passes (`TextLayoutCache`). */
const CELLS = new WeakMap<TextLayoutLike, UprightCell[][] | null>();

/** The cells of a layout's lines that are set upright, or null where none
 *  is (`setUpright`). */
export function uprightCells(layout: TextLayoutLike): UprightCell[][] | null {
  let cells = CELLS.get(layout);
  if (cells !== undefined) return cells;
  cells = null;
  for (let i = 0; i < layout.lines.length; i += 1) {
    const line = layout.lines[i];
    for (const run of line.runs) {
      const glyph = uprightGlyphOf(run.span);
      if (!glyph || run.end <= run.start) continue;
      cells ??= layout.lines.map(() => []);
      const own = glyph.lines[0];
      cells[i].push({
        x: line.x + run.x,
        width: run.width,
        middle: own
          ? line.baseline + (own.descent - own.ascent) / 2
          : line.y + line.height / 2,
        glyph,
      });
    }
  }
  CELLS.set(layout, cells);
  return cells;
}

/** Whether every run of a layout that draws a glyph is set upright: what
 *  the frame need not draw at all. */
export function allUpright(layout: TextLayoutLike): boolean {
  for (const line of layout.lines) {
    for (const run of line.runs) {
      if (run.end <= run.start) continue;
      if (!uprightGlyphOf(run.span)) return false;
    }
  }
  return true;
}

/** The lines of each box `reflectFrame` put back in the other order, by
 *  the box and the pass of it, so that a box no layout has laid out again
 *  since is not put back twice. */
const REFLECTED = new WeakMap<Box, number>();

/**
 * Put a `vertical-lr` frame's lines and blocks back in the order its block
 * axis runs, left to right: laid out down the frame as `vertical-rl`'s,
 * which the turn draws right to left, each line and each block in flow is
 * moved to where it would be laid out from the other end — moved whole,
 * and nothing in it mirrored — and what is in each block put back so
 * within it. A block no layout has laid out since it was put back
 * (`layoutSerial`) is left as it is.
 */
export function reflectFrame(
  frame: Box,
  /** How far across the root's content box is: what the frame's own
   *  blocks are put back across, whatever they come to. */
  extent: number,
  move: (box: Box, dx: number, dy: number) => void,
  moveLine: (line: LineBox, dy: number) => void,
): void {
  const stack: Box[] = [frame];
  while (stack.length) {
    const box = stack.pop()!;
    // a block container's lines and blocks: a flex box's items, a table's
    // rows and an inline box's text are where their own layout put them,
    // and only what is in them is put back
    const container =
      box.kind === 'block' ||
      box.kind === 'table-cell' ||
      box.kind === 'table-caption';
    if (container && REFLECTED.get(box) !== box.layoutSerial) {
      REFLECTED.set(box, box.layoutSerial);
      const top = box.contentY;
      const bottom = top + (box === frame ? extent : box.contentHeight);
      if (box.lines) {
        // what is on a line is moved with it (`moveLine`)
        for (const line of box.lines) {
          moveLine(line, top + bottom - 2 * line.y - line.height);
        }
      } else {
        for (const child of box.children) {
          if (child.outOfFlow || child.isFloat) continue;
          move(child, 0, top + bottom - 2 * child.y - child.height);
        }
      }
    }
    for (const child of box.children) {
      if (
        child.kind !== 'text' &&
        child.kind !== 'break' &&
        child.kind !== 'replaced'
      ) {
        stack.push(child);
      }
    }
  }
}

/** The writing mode of the frame a box is laid out in (`makeFrame`), or
 *  null for a box in none. */
export function frameModeOf(box: Box): WritingMode | null {
  const frame = frameOf(box);
  return frame ? FRAME_ROOTS.get(frame)!.style.writingMode : null;
}

/** The frame a box is laid out in, the nearest, or null for a box in
 *  none. */
export function frameOf(box: Box): Box | null {
  for (let at = box.parent; at; at = at.parent) {
    if (FRAME_ROOTS.has(at)) return at;
  }
  return null;
}

/** Whether a box is laid out in a frame: a grid or a flex box in a vertical
 *  writing mode makes none, and is laid out level with its text, whatever
 *  else the document holds (`BoxTree.vertical`). */
export function inFrame(box: Box): boolean {
  return FRAME_ROOTS.has(box) || frameOf(box) !== null;
}

export type PhysicalSide = 'top' | 'right' | 'bottom' | 'left';

const LOWER: readonly PhysicalSide[] = ['top', 'right', 'bottom', 'left'];

/** The side of a frame of `mode` that a side of the page is laid out at:
 *  the page's right is the frame's top, in the modes turned clockwise. */
export function frameSideOf(
  side: PhysicalSide,
  mode: WritingMode,
): PhysicalSide {
  const sides = turnsUp(mode) ? ANTICLOCKWISE_SIDES : CLOCKWISE_SIDES;
  return LOWER[sides.indexOf(capital(side))];
}

/** The side of the page a side of a frame of `mode` is drawn at. */
export function pageSideOf(
  side: PhysicalSide,
  mode: WritingMode,
): PhysicalSide {
  const sides = turnsUp(mode) ? ANTICLOCKWISE_SIDES : CLOCKWISE_SIDES;
  return sides[LOWER.indexOf(side)].toLowerCase() as PhysicalSide;
}

function capital(side: PhysicalSide): Side {
  return (side[0].toUpperCase() + side.slice(1)) as Side;
}

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle laid out in a frame of `mode` as the page has it, through
 *  the turn about the frame's corner (`makeFrame`). */
export function pageRectOf(
  frame: Box,
  rect: FrameRect,
  mode: WritingMode,
): FrameRect {
  const ox = frame.x;
  const oy = frame.y;
  // across the frame is down the page; down the frame is across it, to the
  // left where the frame is turned clockwise
  return turnsUp(mode)
    ? {
        x: ox + (rect.y - oy),
        y: oy - (rect.x + rect.width - ox),
        width: rect.height,
        height: rect.width,
      }
    : {
        x: ox - (rect.y + rect.height - oy),
        y: oy + (rect.x - ox),
        width: rect.height,
        height: rect.width,
      };
}

/** A rectangle laid out where `box` is as the page has it: through the
 *  turn of each frame around the box, the nearest first. */
export function onPage(box: Box, rect: FrameRect): FrameRect {
  let out = rect;
  for (let frame = frameOf(box); frame; frame = frameOf(frame)) {
    out = pageRectOf(frame, out, FRAME_ROOTS.get(frame)!.style.writingMode);
  }
  return out;
}

/** A rectangle of the page as a frame of `mode` lays it out: the turn
 *  `pageRectOf` draws the frame through, undone. */
export function frameRectOf(
  frame: Box,
  rect: FrameRect,
  mode: WritingMode,
): FrameRect {
  const ox = frame.x;
  const oy = frame.y;
  return turnsUp(mode)
    ? {
        x: ox + (oy - (rect.y + rect.height)),
        y: oy + (rect.x - ox),
        width: rect.height,
        height: rect.width,
      }
    : {
        x: ox + (rect.y - oy),
        y: oy + (ox - (rect.x + rect.width)),
        width: rect.height,
        height: rect.width,
      };
}

/** The four values of a framed box's sides, the frame's top first, as the
 *  page's sides they are drawn at, its top first: what a box laid out in
 *  a frame came to, as `getComputedStyle` reads it. */
export function pageSides<T>(
  frame: readonly [T, T, T, T],
  mode: WritingMode,
): [T, T, T, T] {
  return drawnAt(frame, turnsUp(mode) ? ANTICLOCKWISE_SIDES : CLOCKWISE_SIDES);
}

/** A framed box's margins as `pageSides` has its other sides, which
 *  `vertical-lr` hands its frame in another order (`REFLECTED_MARGINS`). */
export function pageMargins<T>(
  frame: readonly [T, T, T, T],
  mode: WritingMode,
): [T, T, T, T] {
  return reflects(mode)
    ? drawnAt(frame, REFLECTED_MARGINS)
    : pageSides(frame, mode);
}

function drawnAt<T>(
  frame: readonly [T, T, T, T],
  sides: readonly Side[],
): [T, T, T, T] {
  const out = [...frame] as [T, T, T, T];
  for (let i = 0; i < 4; i += 1) out[FRAME_SIDES.indexOf(sides[i])] = frame[i];
  return out;
}
