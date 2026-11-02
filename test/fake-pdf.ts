// An engine that is no PDF: every pixel of a page says where it is.
//
// A flat page cannot show a shift, so `inkAt` is a function of the point on
// the page, and a test reads a window pixel, works out which point of which
// page the view should be showing there, and holds the two to each other.
// Not a `.test.ts` file, so `tsx --test test/*.test.ts` does not run it.
import type {
  PageLink,
  PageText,
  PdfEngine,
  PdfInfo,
  TilePixels,
  TileRequest,
} from '../src/pdf/index.js';
import type { PageSize } from '../src/pdf/layout.js';

/** How wide a square of the pattern is, in points. */
export const CELL = 16;

export function inkAt(
  page: number,
  x: number,
  y: number,
): [number, number, number] {
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  return [
    (cx * 37 + page * 91 + 40) & 0xff,
    (cy * 53 + 90) & 0xff,
    ((cx ^ cy) * 29 + 17) & 0xff,
  ];
}

export interface FakeOptions {
  text?: (page: number) => PageText;
  links?: (page: number) => PageLink[];
  /** Hold every render until `release()`. */
  hold?: boolean;
}

export class FakePdfEngine implements PdfEngine {
  readonly requests: TileRequest[] = [];
  closed = 0;
  inFlight = 0;
  mostInFlight = 0;
  private _held: Array<() => void> = [];
  private _holding: boolean;

  constructor(
    readonly pages: PageSize[],
    private readonly _options: FakeOptions = {},
  ) {
    this._holding = _options.hold ?? false;
  }

  async open(): Promise<PdfInfo> {
    return { handle: 1, pages: this.pages, outline: [], title: 'fake' };
  }

  async render(_handle: number, tile: TileRequest): Promise<TilePixels | null> {
    this.requests.push(tile);
    this.inFlight++;
    this.mostInFlight = Math.max(this.mostInFlight, this.inFlight);
    if (this._holding) await new Promise<void>((go) => this._held.push(go));
    this.inFlight--;
    const { width, height, level, page } = tile;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = inkAt(
          page,
          (tile.x + x + 0.5) / level,
          (tile.y + y + 0.5) / level,
        );
        const at = (y * width + x) * 4;
        data[at] = r;
        data[at + 1] = g;
        data[at + 2] = b;
        data[at + 3] = 255;
      }
    }
    return { width, height, data };
  }

  /** Let what is held go, and stop holding. */
  release(): void {
    this._holding = false;
    for (const go of this._held.splice(0)) go();
  }

  /** One held render, the oldest. */
  step(): void {
    this._held.shift()?.();
  }

  async text(_handle: number, page: number): Promise<PageText> {
    return (
      this._options.text?.(page) ?? { text: '', boxes: new Float32Array(0) }
    );
  }

  async links(_handle: number, page: number): Promise<PageLink[]> {
    return this._options.links?.(page) ?? [];
  }

  close(): void {
    this.closed++;
  }
}

/** A line of text, each character `width` points wide, for `FakeOptions`. */
export function lineOfText(
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
): PageText {
  const boxes = new Float32Array(text.length * 4);
  for (let i = 0; i < text.length; i++) {
    boxes[i * 4] = x + i * width;
    boxes[i * 4 + 1] = y;
    boxes[i * 4 + 2] = x + (i + 1) * width;
    boxes[i * 4 + 3] = y + height;
  }
  return { text, boxes };
}
