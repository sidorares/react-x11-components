// A text layout as react-x11's Cocoa engine (2.3.x) reports one: the same
// geometry, carets and drawing, but every run cut down to
// `{ x, width, start, end }` and no `truncated`. Built from an ntk layout so
// the suite can exercise that shape on the in-process X server, with no
// macOS anywhere — and built as a view over the original rather than by
// mutating it, because ntk's own caret math reads the fields being removed.

/** The slice of a layout the components read. */
export interface ShapedLayout {
  width: number;
  height: number;
  truncated?: boolean;
  lines: { runs: object[]; [key: string]: unknown }[];
  draw(ctx: unknown, x?: number, y?: number): void;
  caretPosition(index: number): {
    x: number;
    y: number;
    height: number;
    line: number;
  };
  indexAt(x: number, y: number): number;
}

export function cocoaShapedLayout<T extends ShapedLayout>(layout: T): T {
  const view = {
    ...layout,
    lines: layout.lines.map((line) => ({
      ...line,
      runs: line.runs.map((run) => {
        const { x, width, start, end } = run as {
          x: number;
          width: number;
          start: number;
          end: number;
        };
        return { x, width, start, end };
      }),
    })),
    draw: (ctx: unknown, x?: number, y?: number) => layout.draw(ctx, x, y),
    caretPosition: (index: number) => layout.caretPosition(index),
    indexAt: (x: number, y: number) => layout.indexAt(x, y),
  };
  delete (view as { truncated?: boolean }).truncated;
  return view as T;
}
