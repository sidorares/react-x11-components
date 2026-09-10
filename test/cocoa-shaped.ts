// A text layout as react-x11's Cocoa engine (2.3.x) reports one: the same
// geometry, carets and drawing, but every run cut down to
// `{ x, width, start, end }` and no `truncated`. Built from an ntk layout so
// the suite can exercise that shape on the in-process X server, with no
// macOS anywhere — and built as a view over the original rather than by
// mutating it, because ntk's own caret math reads the fields being removed.
//
// And an app as react-x11's Cocoa backend is one where embedding is
// concerned: an `X` with none of the protocol XEmbed is made of.
import type { NtkApp } from 'react-x11';
import { createMockApp } from 'react-x11/test';

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

/**
 * An app whose `X` is the Cocoa backend's: a stub carrying the handful of
 * requests core itself makes there (react-x11 `src/cocoa/app.js`, the
 * `this.X = { … }` block — `InternAtom`, `ConfigureWindow`,
 * `SendClientMessage`, `on`, `emit`) and none of the ones XEmbed needs.
 *
 * Built on core's mock app, whose `X` is that same stub today. The two
 * requests `canHostXEmbed` asks about are deleted anyway, so a mock that
 * grows either one cannot quietly turn these into tests of the X11 path.
 * Render into it with `{ app: cocoaShapedApp(), backend: 'mock' }`.
 */
export function cocoaShapedApp(): NtkApp {
  const app = createMockApp();
  const X = (app as unknown as { X: Record<string, unknown> }).X;
  delete X.SetSelectionOwner;
  delete X.ReparentWindow;
  return app;
}
