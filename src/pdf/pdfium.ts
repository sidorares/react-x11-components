// PDFium, compiled to WebAssembly, as a `PdfEngine`.
//
// `@embedpdf/pdfium` is the C API and nothing else, which is why it is this
// package over the friendlier ones: `FPDF_RenderPageBitmapWithMatrix` draws
// part of a page into a buffer we name, and that is the whole of a tile. It
// is an optional peer, as `ondine` is: an app that shows no PDF should not
// pay 7 MB for one, so its types are written out here and it arrives through
// a dynamic `import()` that is allowed to fail (see "Talking to the desktop"
// in AGENTS.md). Absent, `<Pdf>` is `status: 'unavailable'` plus `fallback`.
//
// Everything in this file runs on whichever thread holds the module; it is
// synchronous, as the C API is, and `thread.ts` is what puts it elsewhere.
import { PdfOpenError } from './engine.js';
import type {
  PageLink,
  PageText,
  PdfEngine,
  PdfDocumentId,
  PdfInfo,
  PdfOutlineItem,
  TilePixels,
  TileRequest,
} from './engine.js';

/** The slice of the wrapped C API used here, written out so that an app
 *  which did not install the package can still type-check against this one. */
export interface PdfiumModule {
  pdfium: {
    wasmExports: {
      malloc(size: number): number;
      free(pointer: number): void;
      memory: { buffer: ArrayBuffer };
    };
    HEAPU8?: Uint8Array;
    UTF16ToString(pointer: number): string;
  };
  PDFiumExt_Init(): void;
  FPDF_GetLastError(): number;
  FPDF_LoadMemDocument(data: number, size: number, password: string): number;
  FPDF_CloseDocument(doc: number): void;
  FPDF_GetPageCount(doc: number): number;
  FPDF_GetPageSizeByIndexF(doc: number, page: number, size: number): boolean;
  FPDF_GetMetaText(
    doc: number,
    tag: string,
    buffer: number,
    length: number,
  ): number;
  FPDF_LoadPage(doc: number, page: number): number;
  FPDF_ClosePage(page: number): void;
  FPDF_RenderPageBitmapWithMatrix(
    bitmap: number,
    page: number,
    matrix: number,
    clip: number,
    flags: number,
  ): void;
  FPDFBitmap_CreateEx(
    width: number,
    height: number,
    format: number,
    buffer: number,
    stride: number,
  ): number;
  FPDFBitmap_Destroy(bitmap: number): void;
  FPDFBitmap_FillRect(
    bitmap: number,
    x: number,
    y: number,
    width: number,
    height: number,
    color: number,
  ): boolean;
  FPDFText_LoadPage(page: number): number;
  FPDFText_ClosePage(text: number): void;
  FPDFText_CountChars(text: number): number;
  FPDFText_GetUnicode(text: number, index: number): number;
  FPDFText_GetCharBox(
    text: number,
    index: number,
    left: number,
    right: number,
    bottom: number,
    top: number,
  ): boolean;
  FPDF_GetPageWidthF(page: number): number;
  FPDF_GetPageHeightF(page: number): number;
  FPDF_PageToDevice(
    page: number,
    startX: number,
    startY: number,
    sizeX: number,
    sizeY: number,
    rotate: number,
    pageX: number,
    pageY: number,
    deviceX: number,
    deviceY: number,
  ): boolean;
  FPDFLink_Enumerate(page: number, start: number, link: number): boolean;
  FPDFLink_GetAnnotRect(link: number, rect: number): boolean;
  FPDFLink_GetAction(link: number): number;
  FPDFLink_GetDest(doc: number, link: number): number;
  FPDFAction_GetType(action: number): number;
  FPDFAction_GetDest(doc: number, action: number): number;
  FPDFAction_GetURIPath(
    doc: number,
    action: number,
    buffer: number,
    length: number,
  ): number;
  FPDFDest_GetDestPageIndex(doc: number, dest: number): number;
  FPDFBookmark_GetFirstChild(doc: number, bookmark: number): number;
  FPDFBookmark_GetNextSibling(doc: number, bookmark: number): number;
  FPDFBookmark_GetTitle(
    bookmark: number,
    buffer: number,
    length: number,
  ): number;
  FPDFBookmark_GetDest(doc: number, bookmark: number): number;
  FPDFBookmark_GetAction(bookmark: number): number;
}

/** `FPDF_ANNOT`: annotations' own appearances are the document's. */
const RENDER_ANNOTATIONS = 0x01;
/** `FPDF_REVERSE_BYTE_ORDER`: RGBA, which both contexts' `putImageData` take. */
const REVERSE_BYTE_ORDER = 0x10;
/** `FPDFBitmap_BGRA`: four bytes a pixel, whatever order the flag gives. */
const BITMAP_FOUR_BYTES = 4;
const OPAQUE_WHITE = 0xffffffff;

const ACTION_GOTO = 1;
const ACTION_URI = 3;

/** Pages kept parsed: what a screen can show at once, and the next one. */
const PAGES_KEPT = 8;

/** How far a bookmark tree is walked, across and down: a file can make a
 *  cycle of one, and the walk is a call a level. */
const MAX_OUTLINE = 20000;
const MAX_OUTLINE_DEPTH = 64;

interface Open {
  doc: number;
  /** The bytes, in the module's heap, for as long as the document is open:
   *  `FPDF_LoadMemDocument` keeps reading them. */
  data: number;
  /** The pages last asked about, loaded, oldest first. A tile is 1.5 ms of
   *  a page that is parsed, and two pages side by side in view ask in turn:
   *  with one kept, a dense page was parsed again at every tile. */
  pages: Map<number, number>;
}

/** A `file:` address, as the runtime's `URL` parses one. */
export type FileUrl = { href: string };
declare const URL: new (url: string, base?: string) => FileUrl;

export class PdfiumEngine implements PdfEngine {
  private readonly _m: PdfiumModule;
  private readonly _open = new Map<PdfDocumentId, Open>();
  private _next = 1;

  constructor(module: PdfiumModule) {
    this._m = module;
  }

  private _heap(): Uint8Array {
    const m = this._m.pdfium;
    // The heap grows, and a grown heap is a new buffer: never keep the view.
    const heap = m.HEAPU8;
    return heap && heap.byteLength > 0
      ? heap
      : new Uint8Array(m.wasmExports.memory.buffer);
  }

  private _alloc(size: number): number {
    return this._m.pdfium.wasmExports.malloc(size);
  }

  private _free(pointer: number): void {
    this._m.pdfium.wasmExports.free(pointer);
  }

  private _floats(pointer: number, count: number): Float32Array {
    const heap = this._heap();
    return new Float32Array(heap.buffer, pointer, count);
  }

  private _string(
    read: (buffer: number, length: number) => number,
    utf16 = true,
  ): string {
    const length = read(0, 0);
    if (length <= 0) return '';
    const pointer = this._alloc(length + 2);
    try {
      read(pointer, length);
      if (utf16) return this._m.pdfium.UTF16ToString(pointer);
      const heap = this._heap();
      let text = '';
      for (let i = 0; i < length - 1; i++) {
        text += String.fromCharCode(heap[pointer + i]!);
      }
      return text;
    } finally {
      this._free(pointer);
    }
  }

  async open(
    data: Uint8Array,
    options?: { password?: string },
  ): Promise<PdfInfo> {
    const m = this._m;
    const pointer = this._alloc(data.length);
    this._heap().set(data, pointer);
    const doc = m.FPDF_LoadMemDocument(
      pointer,
      data.length,
      options?.password ?? '',
    );
    if (!doc) {
      const code = m.FPDF_GetLastError();
      this._free(pointer);
      throw openError(code);
    }
    const handle = this._next++;
    this._open.set(handle, { doc, data: pointer, pages: new Map() });

    const count = m.FPDF_GetPageCount(doc);
    const size = this._alloc(8);
    const pages = new Array(count);
    for (let i = 0; i < count; i++) {
      const ok = m.FPDF_GetPageSizeByIndexF(doc, i, size);
      const read = this._floats(size, 2);
      pages[i] = ok
        ? { width: read[0]!, height: read[1]! }
        : { width: 612, height: 792 };
    }
    this._free(size);
    return {
      handle,
      pages,
      outline: this._outline(doc),
      title: this._string((b, l) => m.FPDF_GetMetaText(doc, 'Title', b, l)),
    };
  }

  private _outline(doc: number): PdfOutlineItem[] {
    const m = this._m;
    let budget = MAX_OUTLINE;
    const walk = (parent: number, depth: number): PdfOutlineItem[] => {
      const out: PdfOutlineItem[] = [];
      if (depth >= MAX_OUTLINE_DEPTH) return out;
      let at = m.FPDFBookmark_GetFirstChild(doc, parent);
      while (at && budget-- > 0) {
        const title = this._string((b, l) => m.FPDFBookmark_GetTitle(at, b, l));
        const place = this._goesTo(
          doc,
          m.FPDFBookmark_GetDest(doc, at),
          m.FPDFBookmark_GetAction(at),
        );
        out.push({
          title,
          page: place.page ?? -1,
          ...(place.url ? { url: place.url } : {}),
          children: walk(at, depth + 1),
        });
        at = m.FPDFBookmark_GetNextSibling(doc, at);
      }
      return out;
    };
    return walk(0, 0);
  }

  private _goesTo(
    doc: number,
    dest: number,
    action: number,
  ): { page?: number; url?: string } {
    const m = this._m;
    if (dest) {
      const page = m.FPDFDest_GetDestPageIndex(doc, dest);
      return page >= 0 ? { page } : {};
    }
    if (!action) return {};
    const type = m.FPDFAction_GetType(action);
    if (type === ACTION_URI) {
      const url = this._string(
        (b, l) => m.FPDFAction_GetURIPath(doc, action, b, l),
        false,
      );
      return url ? { url } : {};
    }
    if (type === ACTION_GOTO) {
      const to = m.FPDFAction_GetDest(doc, action);
      const page = to ? m.FPDFDest_GetDestPageIndex(doc, to) : -1;
      return page >= 0 ? { page } : {};
    }
    return {};
  }

  private _page(open: Open, index: number): number {
    const { pages } = open;
    const kept = pages.get(index);
    if (kept) {
      pages.delete(index);
      pages.set(index, kept);
      return kept;
    }
    const page = this._m.FPDF_LoadPage(open.doc, index);
    if (!page) return 0;
    pages.set(index, page);
    if (pages.size > PAGES_KEPT) {
      const [oldest, pointer] = pages.entries().next().value as [
        number,
        number,
      ];
      pages.delete(oldest);
      this._m.FPDF_ClosePage(pointer);
    }
    return page;
  }

  /**
   * Page space to the page as shown, in points from its top-left corner.
   * PDF's y goes up from the bottom of a media box that may start anywhere
   * and that `/Rotate` may turn, so the map is asked of PDFium at three
   * points rather than worked out from the box and the rotation.
   */
  private _shown(page: number): ShownMatrix {
    const m = this._m;
    const width = m.FPDF_GetPageWidthF(page);
    const height = m.FPDF_GetPageHeightF(page);
    // Whole numbers are all `FPDF_PageToDevice` answers, so it is asked at a
    // size that leaves a fraction of a point's worth of room.
    const K = 1024;
    const out = this._alloc(8);
    const at = (x: number, y: number): [number, number] => {
      m.FPDF_PageToDevice(
        page,
        0,
        0,
        width * K,
        height * K,
        0,
        x,
        y,
        out,
        out + 4,
      );
      const read = new Int32Array(this._heap().buffer, out, 2);
      return [read[0]! / K, read[1]! / K];
    };
    const [e, f] = at(0, 0);
    const [ax, ay] = at(1000, 0);
    const [cx, cy] = at(0, 1000);
    this._free(out);
    return {
      a: (ax - e) / 1000,
      b: (ay - f) / 1000,
      c: (cx - e) / 1000,
      d: (cy - f) / 1000,
      e,
      f,
    };
  }

  async render(
    handle: PdfDocumentId,
    tile: TileRequest,
  ): Promise<TilePixels | null> {
    const open = this._open.get(handle);
    if (!open) return null;
    const page = this._page(open, tile.page);
    if (!page) return null;
    const m = this._m;
    const { width, height } = tile;
    const stride = width * 4;
    const pixels = this._alloc(stride * height);
    // FS_MATRIX and then the FS_RECTF the page is clipped to: the bitmap is
    // the tile, so the page is moved to it and the clip is all of it.
    const place = this._alloc(40);
    const bitmap = m.FPDFBitmap_CreateEx(
      width,
      height,
      BITMAP_FOUR_BYTES,
      pixels,
      stride,
    );
    if (!bitmap) {
      this._free(pixels);
      this._free(place);
      return null;
    }
    m.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, OPAQUE_WHITE);
    this._floats(place, 10).set([
      tile.level,
      0,
      0,
      tile.level,
      -tile.x,
      -tile.y,
      0,
      0,
      width,
      height,
    ]);
    m.FPDF_RenderPageBitmapWithMatrix(
      bitmap,
      page,
      place,
      place + 24,
      RENDER_ANNOTATIONS | REVERSE_BYTE_ORDER,
    );
    // One copy, out of the heap: the result has to outlive this call, and a
    // buffer that is the heap's cannot be moved to another thread.
    const data = new Uint8ClampedArray(
      this._heap().buffer.slice(pixels, pixels + stride * height),
    );
    m.FPDFBitmap_Destroy(bitmap);
    this._free(pixels);
    this._free(place);
    return { width, height, data };
  }

  async text(handle: PdfDocumentId, index: number): Promise<PageText> {
    const open = this._open.get(handle);
    const page = open ? this._page(open, index) : 0;
    if (!page) return { text: '', boxes: new Float32Array(0) };
    const m = this._m;
    const text = m.FPDFText_LoadPage(page);
    if (!text) return { text: '', boxes: new Float32Array(0) };
    const count = m.FPDFText_CountChars(text);
    const shown = this._shown(page);
    const boxes = new Float32Array(count * 4);
    const units = new Uint16Array(count);
    const box = this._alloc(32);
    for (let i = 0; i < count; i++) {
      units[i] = m.FPDFText_GetUnicode(text, i);
      if (m.FPDFText_GetCharBox(text, i, box, box + 8, box + 16, box + 24)) {
        const read = new Float64Array(this._heap().buffer, box, 4);
        shownBox(shown, read[0]!, read[3]!, read[1]!, read[2]!, boxes, i * 4);
      }
    }
    this._free(box);
    m.FPDFText_ClosePage(text);
    return { text: stringOfUnits(units), boxes };
  }

  async links(handle: PdfDocumentId, index: number): Promise<PageLink[]> {
    const open = this._open.get(handle);
    const page = open ? this._page(open, index) : 0;
    if (!open || !page) return [];
    const m = this._m;
    const shown = this._shown(page);
    const out: PageLink[] = [];
    const cursor = this._alloc(8);
    const rect = this._alloc(16);
    new Int32Array(this._heap().buffer, cursor, 1)[0] = 0;
    const link = cursor + 4;
    const placed = new Float32Array(4);
    while (m.FPDFLink_Enumerate(page, cursor, link) && out.length < 10000) {
      const annotation = new Int32Array(this._heap().buffer, link, 1)[0]!;
      if (!m.FPDFLink_GetAnnotRect(annotation, rect)) continue;
      const [left, bottom, right, top] = this._floats(rect, 4);
      shownBox(shown, left!, top!, right!, bottom!, placed, 0);
      out.push({
        x: placed[0]!,
        y: placed[1]!,
        width: placed[2]! - placed[0]!,
        height: placed[3]! - placed[1]!,
        ...this._goesTo(
          open.doc,
          m.FPDFLink_GetDest(open.doc, annotation),
          m.FPDFLink_GetAction(annotation),
        ),
      });
    }
    this._free(cursor);
    this._free(rect);
    return out;
  }

  close(handle: PdfDocumentId): void {
    const open = this._open.get(handle);
    if (!open) return;
    this._open.delete(handle);
    for (const page of open.pages.values()) this._m.FPDF_ClosePage(page);
    this._m.FPDF_CloseDocument(open.doc);
    this._free(open.data);
  }

  dispose(): void {
    for (const handle of [...this._open.keys()]) this.close(handle);
  }
}

/** A page's own space to the page as shown. */
interface ShownMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** A box in page space as `left, top, right, bottom` of the page as shown. */
function shownBox(
  m: ShownMatrix,
  left: number,
  top: number,
  right: number,
  bottom: number,
  out: Float32Array,
  at: number,
): void {
  const x0 = m.a * left + m.c * top + m.e;
  const y0 = m.b * left + m.d * top + m.f;
  const x1 = m.a * right + m.c * bottom + m.e;
  const y1 = m.b * right + m.d * bottom + m.f;
  out[at] = Math.min(x0, x1);
  out[at + 1] = Math.min(y0, y1);
  out[at + 2] = Math.max(x0, x1);
  out[at + 3] = Math.max(y0, y1);
}

/** A string of UTF-16 units, past the stack `apply` has. */
function stringOfUnits(units: Uint16Array): string {
  const CHUNK = 8192;
  let text = '';
  for (let i = 0; i < units.length; i += CHUNK) {
    text += String.fromCharCode.apply(
      null,
      units.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return text;
}

/** `FPDF_ERR_*`, as what a host can do about each. */
function openError(code: number): PdfOpenError {
  switch (code) {
    case 2:
      return new PdfOpenError('file', 'The file could not be read');
    case 3:
      return new PdfOpenError('format', 'Not a PDF, or a damaged one');
    case 4:
      return new PdfOpenError('password', 'The document needs a password');
    case 5:
      return new PdfOpenError(
        'security',
        'The document is locked in a way that is not supported',
      );
    default:
      return new PdfOpenError('unknown', `PDFium error ${code}`);
  }
}

/**
 * The package, with its WebAssembly: read from beside its module rather than
 * through `fetch`, which on Node would need a URL of its own and on no
 * runtime here is any faster. Resolves to null where it is not installed,
 * which is an ordinary state of a healthy machine.
 */
export async function loadPdfium(
  /** Reads a file; the thread brings its own `fs`. */
  readFile: (url: FileUrl) => Promise<Uint8Array>,
  resolve: (specifier: string) => string,
): Promise<PdfiumModule | null> {
  const specifier = '@embedpdf/pdfium';
  let init: ((o: unknown) => Promise<PdfiumModule>) | undefined;
  let wasm: string;
  try {
    const module = (await import(/* @vite-ignore */ specifier)) as {
      init?: (o: unknown) => Promise<PdfiumModule>;
    };
    init = module.init;
    wasm = resolve(`${specifier}/pdfium.wasm`);
  } catch {
    return null;
  }
  if (typeof init !== 'function') return null;
  const wasmBinary = await readFile(new URL(wasm));
  const module = await init({ wasmBinary });
  module.PDFiumExt_Init();
  return module;
}
