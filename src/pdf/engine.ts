// The seam between the view and whatever reads a PDF.
//
// `PdfEngine` is public for the reason `ProcessHost` and `PtyHost` are: an
// application with an engine of its own, or a document that is not a file,
// should not need a fork. It happens to be what lets a test stand in for
// PDFium, but that is not why it is exported.
//
// Everything crossing it is numbers and typed arrays, so an engine can be a
// thread away and the arrays moved rather than copied. The default,
// `defaultPdfEngine()`, is PDFium on a thread of its own (`thread.ts`).
import type { PageSize } from './layout.js';

/** An opened document, as a number its engine knows it by. */
export type PdfDocumentId = number;

export interface PdfOutlineItem {
  title: string;
  /** The page it goes to, 0-based, or -1 where it goes nowhere in here. */
  page: number;
  /** Where it goes outside the document, when it does. */
  url?: string;
  children: PdfOutlineItem[];
}

export interface PdfInfo {
  handle: PdfDocumentId;
  /** One size a page, in points, the way the page is shown: `/Rotate`'s in
   *  them. A manual's are all read here, once. */
  pages: PageSize[];
  outline: PdfOutlineItem[];
  title: string;
}

/** Part of a page, at a scale. */
export interface TileRequest {
  page: number;
  /** Device pixels a point. */
  level: number;
  /** What it covers, device pixels from the page's top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TilePixels {
  width: number;
  height: number;
  /** `width × height × 4` of straight RGBA, each row `width × 4` long. */
  data: Uint8ClampedArray;
}

/** A page's text, as an engine laid it out. */
export interface PageText {
  /** Every character in content order, `\r\n`s the engine generated in it. */
  text: string;
  /** `left, top, right, bottom` for each UTF-16 unit of `text`, in points
   *  from the page's top-left corner. All 0 for a generated character. */
  boxes: Float32Array;
}

export interface PageLink {
  /** Points from the page's top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where it goes, outside. */
  url?: string;
  /** Or which page it goes to, 0-based. */
  page?: number;
}

/** Why a document did not open. A password is no failure of the file. */
export class PdfOpenError extends Error {
  readonly code: 'password' | 'format' | 'security' | 'file' | 'unknown';
  constructor(code: PdfOpenError['code'], message: string) {
    super(message);
    this.name = 'PdfOpenError';
    this.code = code;
  }
}

export interface PdfEngine {
  /** Copies the bytes: the array stays the caller's, and a render that runs
   *  twice can hand it over twice. */
  open(data: Uint8Array, options?: { password?: string }): Promise<PdfInfo>;
  /** Null where the page could not be drawn. */
  render(handle: PdfDocumentId, tile: TileRequest): Promise<TilePixels | null>;
  text(handle: PdfDocumentId, page: number): Promise<PageText>;
  links(handle: PdfDocumentId, page: number): Promise<PageLink[]>;
  close(handle: PdfDocumentId): void;
  /** Done with everything. An engine handed in is its owner's to dispose. */
  dispose?(): void;
}
