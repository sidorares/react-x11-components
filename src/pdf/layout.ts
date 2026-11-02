// Where the pages stand, and which tiles show them.
//
// Pure: everything here is arithmetic over page sizes and a rectangle, so it
// is answered with no display and no engine. `node.ts` is the only thing
// that holds a camera.
//
// Three units meet here, and each name says which it is in:
//
// - **points**, a PDF's own unit, 1/72 inch: what an engine reports a page's
//   size in.
// - **logical pixels**, what a style and a synthetic event are written in:
//   where a page stands in the document, and the scroll offsets. Zoom 1 is
//   96 to the inch, as a browser's PDF viewer has it.
// - **device pixels**, what a tile is cut in: `level` is how many of them a
//   point comes to, the display's scale in it.

/** CSS's 96 pixels an inch against a PDF's 72 points. */
export const PX_PER_POINT = 96 / 72;

/** A tile's side in device pixels: a megabyte of surface, some 1.5 ms of
 *  PDFium, and what a whole page at 2x comes to a dozen of. */
export const TILE_SIZE = 512;

/** The furthest a zoom goes, each way. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 16;

export interface PageSize {
  /** In points. */
  width: number;
  height: number;
}

/** A page in the document, at a zoom. */
export interface PlacedPage {
  index: number;
  /** Logical pixels from the document's corner. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentLayout {
  pages: PlacedPage[];
  /** The document's extent, logical pixels, the gaps in it. */
  width: number;
  height: number;
  /** What every `pages[i].y` was placed with. */
  zoom: number;
}

export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * The pages one under another, each centred in the wider of the pane and the
 * widest page. Page tops are whole logical pixels, so a page's corner lands
 * on the device grid at any display scale and a tile is drawn one to one.
 */
export function placePages(
  sizes: readonly PageSize[],
  zoom: number,
  gap: number,
  paneWidth: number,
): DocumentLayout {
  const k = zoom * PX_PER_POINT;
  let widest = 0;
  for (let i = 0; i < sizes.length; i++) {
    widest = Math.max(widest, sizes[i]!.width * k);
  }
  const width = Math.ceil(Math.max(widest + gap * 2, paneWidth));
  const pages: PlacedPage[] = new Array(sizes.length);
  let y = gap;
  for (let i = 0; i < sizes.length; i++) {
    const w = Math.ceil(sizes[i]!.width * k);
    const h = Math.ceil(sizes[i]!.height * k);
    pages[i] = {
      index: i,
      x: Math.floor((width - w) / 2),
      y,
      width: w,
      height: h,
    };
    y += h + gap;
  }
  return { pages, width, height: y, zoom };
}

/**
 * The first page whose bottom edge is below `top`: a binary search, since a
 * paint and every pump of the queue ask, and a manual has thousands of them.
 */
export function firstPageBelow(
  pages: readonly PlacedPage[],
  top: number,
): number {
  let lo = 0;
  let hi = pages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const page = pages[mid]!;
    if (page.y + page.height <= top) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The pages `view` meets, in order. */
export function pagesIn(layout: DocumentLayout, view: ViewRect): PlacedPage[] {
  const out: PlacedPage[] = [];
  const bottom = view.y + view.height;
  for (
    let i = firstPageBelow(layout.pages, view.y);
    i < layout.pages.length;
    i++
  ) {
    const page = layout.pages[i]!;
    if (page.y >= bottom) break;
    if (page.x < view.x + view.width && page.x + page.width > view.x) {
      out.push(page);
    }
  }
  return out;
}

/** The page nearest the top third of the view: the one a reader is on. */
export function currentPage(layout: DocumentLayout, view: ViewRect): number {
  if (layout.pages.length === 0) return 0;
  const reading = view.y + view.height / 3;
  const at = firstPageBelow(layout.pages, reading);
  return Math.min(at, layout.pages.length - 1);
}

/** The key of a level: a scale as a whole number of 1/1024ths, so two zooms
 *  that come to the same pixels share their tiles. */
export function levelKey(level: number): number {
  return Math.round(level * 1024);
}

export function tileKey(
  page: number,
  level: number,
  tx: number,
  ty: number,
): string {
  // A string rather than fields packed in a double: a page, a level to
  // 1/1024, and two tile numbers are more than 53 bits, and packed they
  // collided at a deep zoom. Some thirty of these a frame cost nothing.
  return `${page}/${levelKey(level)}/${tx}/${ty}`;
}

export interface TileAddress {
  page: number;
  level: number;
  tx: number;
  ty: number;
  /** What it covers of the page, device pixels at `level`. */
  x: number;
  y: number;
  width: number;
  height: number;
  key: string;
}

/** A page's size in device pixels at a level. */
export function pagePixels(size: PageSize, level: number) {
  return {
    width: Math.max(1, Math.ceil(size.width * level)),
    height: Math.max(1, Math.ceil(size.height * level)),
  };
}

/**
 * The tiles of one page that meet `rect` (device pixels from the page's
 * corner), the ones nearest `focusY` first: on a page that fills the pane
 * the middle of it is what a reader is looking at.
 */
export function tilesCovering(
  page: number,
  size: PageSize,
  level: number,
  rect: ViewRect,
  focusY: number,
): TileAddress[] {
  const whole = pagePixels(size, level);
  const x0 = Math.max(0, Math.floor(rect.x / TILE_SIZE));
  const y0 = Math.max(0, Math.floor(rect.y / TILE_SIZE));
  const x1 = Math.min(
    Math.ceil(whole.width / TILE_SIZE),
    Math.ceil((rect.x + rect.width) / TILE_SIZE),
  );
  const y1 = Math.min(
    Math.ceil(whole.height / TILE_SIZE),
    Math.ceil((rect.y + rect.height) / TILE_SIZE),
  );
  const out: TileAddress[] = [];
  for (let ty = y0; ty < y1; ty++) {
    for (let tx = x0; tx < x1; tx++) {
      const x = tx * TILE_SIZE;
      const y = ty * TILE_SIZE;
      out.push({
        page,
        level,
        tx,
        ty,
        x,
        y,
        width: Math.min(TILE_SIZE, whole.width - x),
        height: Math.min(TILE_SIZE, whole.height - y),
        key: tileKey(page, level, tx, ty),
      });
    }
  }
  if (out.length > 1) {
    const at = (t: TileAddress) => Math.abs(t.y + t.height / 2 - focusY);
    out.sort((a, b) => at(a) - at(b));
  }
  return out;
}
