// `<vtterm>` — the registered element the vt backend draws into.
//
// The division of labour with `./index.ts` mirrors `../../code-editor/`: the
// component owns process things (resolve the optional dependencies, create
// the emulator and the pty, wire them together, flow control, the imperative
// handle), and this node owns pixels and input (cell metrics, layout, the
// renderer and the mirror, cursor blink, selection, key and mouse encoding
// through core's default-action seam, clipboard).
//
// The consequence worth having: the node is drivable with a fake `term` and
// no pty at all, which is what makes the whole renderer testable in CI.
import { CARET_BLINK_MS, Node } from 'react-x11/node';
import type {
  Context2D,
  MeasureConstraints,
  MeasuredSize,
} from 'react-x11/node';
import type { KeyboardEvent, MouseEvent, WheelEvent } from 'react-x11';
import type { Style } from 'react-x11/style';
import { Surface } from 'react-x11/ntk';
import {
  XK_ESCAPE,
  XK_INSERT,
  XK_TAB,
  ctrlChordLetter,
} from 'react-x11/keysyms';

import type { TerminalColors } from '../backends.js';
import { buildPalette } from './colors.js';
import type { Palette } from './colors.js';
import {
  DECO_OVERLINE,
  DECO_STRIKE,
  DECO_UNDERLINE,
  VARIANT_BOLD,
  VARIANT_ITALIC,
} from './colors.js';
import {
  Mirror,
  createSnapshot,
  orderSelection,
  readViewport,
} from './diff.js';
import type { CursorState, GridSnapshot, SelectionRange } from './diff.js';
import { FontSet, variantOf } from './fonts.js';
import type { NtkFonts } from './fonts.js';
import { encodeKey, encodePaste } from './keys.js';
import { ENCODING_MODES, encodeAlternateScroll, encodeMouse } from './mouse.js';
import type { MouseEncoding } from './mouse.js';
import { createRenderer } from './renderer.js';
import type {
  CellContext,
  RendererOps,
  RendererStats,
  SurfaceCtor,
} from './renderer.js';
import { microtask, startInterval, stopInterval } from './timers.js';
import type { TimerId } from './timers.js';
import type { XtermCell, XtermDisposable, XtermTerminal } from './xterm.js';

/** The element name — the registration key, `kind`, and the JSX tag. */
export const ELEMENT = 'vtterm';

const DEFAULT_FAMILY = 'monospace';
const DEFAULT_SIZE = 13;
/** What a bare `<Terminal>` measures to, in cells. */
const PREFERRED_COLS = 80;
const PREFERRED_ROWS = 24;
/** Wheel notches to lines, the way every terminal counts them. */
const WHEEL_LINES = 3;

/**
 * Said once per process: the engine behind `app.fonts` has no glyph-run
 * seams, so this element paints nothing. `process` and `console` come off
 * `globalThis` because `src/` compiles with `types: []` — see `warnVtOnly`
 * in `../index.ts`.
 */
let warnedNoGlyphRuns = false;
function warnNoGlyphRuns(): void {
  if (warnedNoGlyphRuns) return;
  warnedNoGlyphRuns = true;
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    console?: { warn(message: string): void };
  };
  if (g.process?.env?.NODE_ENV === 'production') return;
  g.console?.warn(
    '@react-x11/components: <Terminal backend="vt"> — the text engine behind ' +
      'app.fonts has no glyph-run seams (glyphIdFor/advanceOf on a face, ' +
      'drawGlyphs on the context), so the terminal paints nothing. ' +
      "react-x11's Cocoa backend before 2.4.0 was the known case " +
      '(sidorares/react-x11#432); every backend of react-x11 2.5.0 and ' +
      'later has them, so check which engine app.fonts is.',
  );
}
/** OSC 52 payloads bigger than this are a program misbehaving, not a copy. */
const MAX_OSC52 = 1_000_000;
/** What counts as part of a word for double-click selection. */
const WORD_CHAR = /[\p{L}\p{N}_\-./~+@:]/u;

/** The props `<vtterm>` takes. Everything user-facing is on `<Terminal>`. */
export interface VtTermProps {
  /** The live emulator. Null while the component is still resolving it. */
  term?: XtermTerminal | null;
  /** Bytes the user produced, on their way to the pty. */
  onInput?: (data: string) => void;
  /** The element's box changed size: this many cells now fit. */
  onGridResize?: (cols: number, rows: number) => void;
  onSelectionChange?: (text: string) => void;
  colors?: TerminalColors;
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
  /** OSC 52 writes to CLIPBOARD. Reads are never answered — see `_onOsc52`. */
  allowClipboardWrite?: boolean;
  /** The visual bell, mid-flash: the palette runs inverted for a moment.
   *  Held by the component so the flash is one state change, not a timer in
   *  the node. */
  inverted?: boolean;
  style?: Style | Style[];
}

/** ntk's clipboard, off `app.clipboard`. */
interface ClipboardLike {
  write(text: string, options?: { selection?: string }): Promise<unknown>;
  read(options?: { selection?: string }): Promise<unknown>;
}

type Grid = { col: number; row: number };

export class VtTermNode extends Node {
  private _term: XtermTerminal | null = null;
  private _disposables: XtermDisposable[] = [];
  private _fonts: FontSet | null = null;
  private _fontKey = '';
  private _palette: Palette;
  private _paletteKey = '';
  private _renderer: RendererOps | null = null;
  private _mirror = new Mirror();
  private _snapshot: GridSnapshot | null = null;
  private _workCell: XtermCell | null = null;
  private _cols = 0;
  private _rows = 0;
  private _reportedCols = 0;
  private _reportedRows = 0;
  private _focused = false;
  private _cursorOn = true;
  private _blink: TimerId = null;
  /** Selection anchor and head, in buffer-absolute coordinates. */
  private _anchor: { line: number; col: number } | null = null;
  private _head: { line: number; col: number } | null = null;
  private _selection: SelectionRange | null = null;
  private _dragMode: 'char' | 'word' | 'line' | null = null;
  /** Escape armed one pass-through Tab — the way out of the keyboard trap. */
  private _tabEscapes = false;
  /** Not in `modes`: tracked from DECSET/DECRST (see `_watchModes`). */
  private _mouseEncoding: MouseEncoding = 'default';
  private _alternateScroll = true;

  constructor(props: Record<string, unknown>, app: unknown) {
    super(ELEMENT, props, app as ConstructorParameters<typeof Node>[2]);
    // Without this nothing ever focuses the terminal and no key reaches it.
    // An app's `focusable`/`tabIndex` prop still overrides either way.
    this.focusableByDefault = true;
    this.defaultCursor = 'text';
    // A terminal drags out a selection of its own, over a cell grid nothing
    // outside it can index (react-x11#291). Saying so keeps a `selectable`
    // document around it from walking in, and keeps the two from both
    // claiming to be showing the application's selection — the same
    // declaration `<textinput>` and `<codeeditor>` make.
    this.hasOwnSelection = true;
    this._palette = buildPalette(paletteColors(this._props()));
    this._paletteKey = paletteKey(this._props());
    this._attach(this._props().term ?? null);
  }

  private _props(): VtTermProps {
    return this.props as unknown as VtTermProps;
  }

  // --- props ---------------------------------------------------------------

  override applyProps(
    next: Record<string, unknown>,
    prev: Record<string, unknown>,
  ): void {
    super.applyProps(next, prev);
    const props = this._props();

    if (props.term !== (prev.term as XtermTerminal | null | undefined)) {
      this._attach(props.term ?? null);
    }

    const key = paletteKey(props);
    if (key !== this._paletteKey) {
      this._paletteKey = key;
      this._palette = buildPalette(paletteColors(props));
      // The palette generation is a signature input, so the ordinary diff
      // repaints every cell whose colours actually moved. Nothing else here
      // needs to know a theme changed.
      this._repaint();
    }

    const { family, size } = this._fontStyle();
    if (`${family}|${size}` !== this._fontKey) {
      this._fonts = null;
      this._mirror.invalidate();
      this.invalidateMeasure('measure');
      this._repaint();
    }
    if (props.cursorBlink !== (prev.cursorBlink as boolean | undefined)) {
      this._syncBlink();
    }
  }

  override destroySubtree(): void {
    this._detach();
    stopInterval(this._blink);
    this._blink = null;
    this._renderer?.destroy();
    this._renderer = null;
    super.destroySubtree();
  }

  // --- the emulator --------------------------------------------------------

  /**
   * Subscribe to everything that means "the screen may look different".
   *
   * Only render-relevant events: the component keeps `onData`, `onTitleChange`
   * and `onBell`, which are about the process rather than about pixels.
   */
  private _attach(term: XtermTerminal | null): void {
    this._detach();
    this._term = term;
    this._mirror.invalidate();
    if (!term) return;
    const dirty = (): void => this._repaint();
    this._disposables.push(
      term.onWriteParsed(dirty),
      term.onScroll(dirty),
      term.onCursorMove(dirty),
      term.onResize(() => {
        this._mirror.invalidate();
        this._repaint();
      }),
      term.buffer.onBufferChange(() => {
        // The alternate screen is a different buffer with a different
        // coordinate origin; nothing on the surface survives the switch.
        this._mirror.invalidate();
        this.clearSelection();
        this._repaint();
      }),
    );
    this._watchModes(term);
    this._workCell = term.buffer.active.getNullCell();
    this._repaint();
  }

  private _detach(): void {
    for (const d of this._disposables) {
      try {
        d.dispose();
      } catch {
        // a terminal already disposed
      }
    }
    this._disposables.length = 0;
    this._term = null;
    this._workCell = null;
  }

  /**
   * The two things `modes` does not carry.
   *
   * Mouse *encoding* (SGR 1006, urxvt 1015, UTF-8 1005) and alternate-scroll
   * (1007) are set by DECSET/DECRST and read back nowhere, so a passive CSI
   * observer records them and **returns false** — xterm still processes the
   * sequence itself, and this handler is a listener rather than an
   * implementation. Filed upstream as a request to expose `mouseEncoding`
   * alongside `mouseTrackingMode`.
   */
  private _watchModes(term: XtermTerminal): void {
    const observe = (set: boolean) => (params: (number | number[])[]) => {
      for (const param of params) {
        const value = Array.isArray(param) ? param[0] : param;
        const encoding = ENCODING_MODES[value];
        if (encoding) this._mouseEncoding = set ? encoding : 'default';
        if (value === 1007) this._alternateScroll = set;
      }
      return false;
    };
    try {
      this._disposables.push(
        term.parser.registerCsiHandler(
          { prefix: '?', final: 'h' },
          observe(true),
        ),
        term.parser.registerCsiHandler(
          { prefix: '?', final: 'l' },
          observe(false),
        ),
        term.parser.registerOscHandler(52, (data) => this._onOsc52(data)),
      );
    } catch {
      // a fake terminal in a test that implements only what it needs
    }
  }

  // --- metrics and layout --------------------------------------------------

  /**
   * Device pixels per logical pixel — the display scale (core's
   * `docs/scale.md`).
   *
   * Everything this node computes with is device pixels: `contentBox()`,
   * `this.style.fontSize` (core multiplies a style length before handing it
   * over) and so the cell metrics shaped from it, the paint context and the
   * renderer's surface. Two things are not, and each is converted once where
   * it enters: a synthetic event's `x`/`y` (`_devicePoint`), and the
   * constants below that never pass through a style — `DEFAULT_SIZE` and the
   * cell guesses `measureContent` makes before there is a font.
   */
  private get _scale(): number {
    return this.scale > 0 ? this.scale : 1;
  }

  /**
   * A pointer event in the grid's own pixels.
   *
   * The native X event carries the device position the synthetic `x`/`y`
   * were divided from, so it is the exact answer where there is one — core's
   * own drawn elements read it the same way — and `x * scale` is the answer
   * for an event synthesized without one.
   */
  private _devicePoint(ev: { x: number; y: number; nativeEvent?: unknown }): {
    x: number;
    y: number;
  } {
    const native = ev.nativeEvent as { x?: unknown; y?: unknown } | null;
    const s = this._scale;
    return {
      x: typeof native?.x === 'number' ? native.x : ev.x * s,
      y: typeof native?.y === 'number' ? native.y : ev.y * s,
    };
  }

  /**
   * The font, off the **style** rather than off a prop of its own.
   *
   * `fontFamily` and `fontSize` are style properties, and core throws in
   * development on an element that takes one as a flat prop — for good
   * reason: a terminal inheriting the font from the tree above it is what
   * makes `<box style={{ fontSize: 15 }}>` mean what it says. `<Terminal>`'s
   * `fontFamily`/`fontSize` props are folded into this element's style.
   *
   * The size answered is in device pixels — the unit the glyphs are shaped
   * at. A `fontSize` from the style arrives already multiplied; the default
   * is a logical 13 and is multiplied here, so a bare `<Terminal>` on a 2x
   * panel is the size it is on a 1x one, sharper rather than smaller.
   */
  private _fontStyle(): { family: string; size: number } {
    const style = this.style as { fontFamily?: string; fontSize?: number };
    return {
      family: style.fontFamily ?? DEFAULT_FAMILY,
      size: Number(style.fontSize ?? DEFAULT_SIZE * this._scale),
    };
  }

  /**
   * The faces for the current family and size, or null when there is no
   * engine to build them from.
   *
   * Null is cached per font key when the engine answered but cannot build
   * glyph runs — an `app.fonts` that is not ntk's and has not grown its
   * seams, which react-x11's Cocoa backend was before 2.4.0
   * (sidorares/react-x11#432) — so the probe runs once, not on every
   * measure and paint. A box with no `app.fonts` at all (the mock
   * backend) is not cached: it never had an engine to ask.
   */
  private _fontSet(): FontSet | null {
    const { family, size } = this._fontStyle();
    const key = `${family}|${size}`;
    if (key === this._fontKey) return this._fonts;
    const fonts = (this.app as { fonts?: NtkFonts } | null | undefined)?.fonts;
    if (!fonts) return null;
    const set = new FontSet(fonts, family, size);
    this._fontKey = key;
    this._mirror.invalidate();
    if (!set.glyphRuns) {
      warnNoGlyphRuns();
      this._fonts = null;
      return null;
    }
    this._fonts = set;
    return set;
  }

  /**
   * 80×24, or as much of it as is on offer.
   *
   * A terminal in a dialog with nothing else to size it should be a terminal
   * rather than a sliver; flex owns everything past that.
   */
  override measureContent({ width, height }: MeasureConstraints): MeasuredSize {
    const fonts = this._fontSet();
    // The constraints and the answer are device pixels, like the metrics;
    // the guesses made without a font (the mock backend) are scaled to match.
    const s = this._scale;
    const cellWidth = fonts?.metrics.cellWidth ?? DEFAULT_SIZE * 0.6 * s;
    const cellHeight = fonts?.metrics.cellHeight ?? DEFAULT_SIZE * 1.2 * s;
    return {
      width: Math.min(PREFERRED_COLS * cellWidth, width),
      height: Math.min(PREFERRED_ROWS * cellHeight, height),
    };
  }

  /** Cells that fit the content box right now. */
  gridSize(): { cols: number; rows: number } {
    const fonts = this._fontSet();
    const box = this.contentBox();
    if (!fonts) return { cols: PREFERRED_COLS, rows: PREFERRED_ROWS };
    return {
      cols: Math.max(1, Math.floor(box.width / fonts.metrics.cellWidth)),
      rows: Math.max(1, Math.floor(box.height / fonts.metrics.cellHeight)),
    };
  }

  /**
   * Tell the component the grid changed, off the paint stack.
   *
   * `onGridResize` ends in `term.resize` and `pty.resize`, and both of those
   * can synchronously produce output — running them inside paint would have
   * the emulator writing to a buffer the renderer is halfway through reading.
   */
  resizeToFit(): void {
    const { cols, rows } = this.gridSize();
    if (cols === this._reportedCols && rows === this._reportedRows) return;
    this._reportedCols = cols;
    this._reportedRows = rows;
    const notify = this._props().onGridResize;
    if (notify) microtask(() => !this.destroyed && notify(cols, rows));
  }

  get cols(): number {
    return this._cols;
  }

  get rows(): number {
    return this._rows;
  }

  // --- painting ------------------------------------------------------------

  private _repaint(): void {
    if (this.destroyed) return;
    // The grid rect, not a tighter one: which cells are dirty is not known
    // until the diff runs inside paint. Damage is a clip and a cull bound
    // rather than a promise to redraw everything, and the diff still decides
    // what is *rendered* — which is where the cost is.
    this.invalidate(false, this, 'text');
  }

  override paint(ctx: Context2D): void {
    // background, border, and the clip to this node's rect
    super.paint(ctx);
    const fonts = this._fontSet();
    if (!fonts) return;
    // Before the `term` check on purpose: the component sizes the emulator it
    // is still building from what this reports, so the first layout has to
    // reach it even though there is nothing to draw yet.
    this.resizeToFit();

    const term = this._term;
    if (!term) return;

    const cell = ctx as CellContext;
    const renderer = this._ensureRenderer(cell);
    if (!renderer) return; // mock backend: no pixel API, so nothing to draw

    const box = this.contentBox();
    const { cellWidth, cellHeight } = fonts.metrics;
    const fitCols = Math.max(1, Math.floor(box.width / cellWidth));
    const fitRows = Math.max(1, Math.floor(box.height / cellHeight));
    // The emulator resizes a beat later (through the component, off this
    // stack), so draw the intersection until it catches up.
    const cols = Math.max(1, Math.min(fitCols, term.cols));
    const rows = Math.max(1, Math.min(fitRows, term.rows));
    this._cols = cols;
    this._rows = rows;

    if (!renderer.ensure(cols, rows, fonts.metrics)) this._mirror.invalidate();
    if (
      !this._snapshot ||
      this._snapshot.cols !== cols ||
      this._snapshot.rows !== rows
    ) {
      this._snapshot = createSnapshot(cols, rows);
      this._mirror.invalidate();
    }

    const snapshot = readViewport(
      term,
      this._snapshot,
      {
        palette: this._palette,
        selection: this._selection,
        cursor: this._cursorState(term, rows),
        brightBold: term.options.drawBoldTextInBrightColors !== false,
      },
      this._workCell ?? undefined,
    );

    const result = this._mirror.diff(snapshot);
    renderer.begin(cell, {
      originX: box.x,
      originY: box.y,
      cols,
      rows,
      metrics: fonts.metrics,
    });
    if (result.copy) {
      const { srcRow, dstRow, count } = result.copy;
      if (!renderer.copyRows(srcRow, dstRow, count)) {
        // No buffer to move pixels inside: the mirror already moved, so drop
        // it and take a full repaint on the next frame rather than believing
        // a copy that did not happen.
        this._mirror.invalidate();
        this._repaint();
      }
    }
    for (const span of result.spans) {
      this._drawSpan(renderer, snapshot, span, fonts);
    }
    renderer.end();
  }

  private _ensureRenderer(ctx: CellContext): RendererOps | null {
    if (this._renderer) return this._renderer;
    // `react-x11/ntk` types its re-exports loosely on purpose — ntk ships no
    // types of its own — so the shape this element needs is the structural
    // one in `./renderer.ts`, and this is the one cast that says so.
    this._renderer = createRenderer(
      this.app,
      ctx,
      (Surface ?? null) as unknown as SurfaceCtor | null,
    );
    if (this._renderer?.kind === 'direct') {
      // Nothing is retained between frames: `Node.paint` fills this node's
      // background before we draw, so every frame starts from an empty box.
      this._mirror.invalidate();
    }
    return this._renderer;
  }

  private _cursorState(term: XtermTerminal, rows: number): CursorState {
    const buffer = term.buffer.active;
    const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
    const props = this._props();
    let shape: CursorState['shape'] =
      props.cursorStyle ?? term.options.cursorStyle ?? 'block';
    if (!this._focused) shape = 'hollow';
    else if (!this._cursorOn) shape = 'none';
    if (row < 0 || row >= rows || buffer.cursorX >= term.cols) {
      shape = 'none';
    }
    return { col: buffer.cursorX, row, shape };
  }

  /**
   * One dirty span, as three passes over the same cells: backgrounds merged
   * into runs of one colour, one glyph run per non-blank cell, then the
   * decorations. The renderer batches each pass into a single request per
   * colour, so a span of 80 cells is a handful of requests however many
   * colours it carries.
   */
  private _drawSpan(
    renderer: RendererOps,
    snapshot: GridSnapshot,
    span: { row: number; col: number; count: number },
    fonts: FontSet,
  ): void {
    const { row, col, count } = span;
    const base = row * snapshot.cols;
    const end = col + count;

    let start = col;
    let bg = snapshot.bg[base + col];
    for (let i = col + 1; i < end; i++) {
      const next = snapshot.bg[base + i];
      if (next !== bg) {
        renderer.fillCells(row, start, i - start, bg);
        start = i;
        bg = next;
      }
    }
    renderer.fillCells(row, start, end - start, bg);

    for (let i = col; i < end; i++) {
      const index = base + i;
      // Width 0 is the second half of a wide glyph: its background is part of
      // the run above, and its glyph was drawn at the cell before it.
      if (snapshot.width[index] === 0) continue;
      const chars = snapshot.chars[index];
      if (!chars || chars === ' ') continue;
      const flags = snapshot.flags[index];
      const run = fonts.run(
        chars,
        variantOf((flags & VARIANT_BOLD) !== 0, (flags & VARIANT_ITALIC) !== 0),
      );
      if (run) renderer.drawRun(row, i, run, snapshot.fg[index]);
    }

    this._decorateSpan(renderer, snapshot, row, col, end);
    this._drawCursor(renderer, row, col, end);
  }

  private _decorateSpan(
    renderer: RendererOps,
    snapshot: GridSnapshot,
    row: number,
    col: number,
    end: number,
  ): void {
    const base = row * snapshot.cols;
    const DECO = DECO_UNDERLINE | DECO_STRIKE | DECO_OVERLINE;
    let runStart = -1;
    let runDeco = 0;
    let runFg = 0;
    const flush = (until: number): void => {
      if (runStart < 0 || !runDeco) return;
      const count = until - runStart;
      if (runDeco & DECO_UNDERLINE) {
        renderer.decorate(row, runStart, count, 'underline', runFg);
      }
      if (runDeco & DECO_STRIKE) {
        renderer.decorate(row, runStart, count, 'strike', runFg);
      }
      if (runDeco & DECO_OVERLINE) {
        renderer.decorate(row, runStart, count, 'overline', runFg);
      }
      runStart = -1;
    };
    for (let i = col; i < end; i++) {
      const deco = snapshot.flags[base + i] & DECO;
      const fg = snapshot.fg[base + i];
      if (deco !== runDeco || fg !== runFg) {
        flush(i);
        runDeco = deco;
        runFg = fg;
        runStart = deco ? i : -1;
      }
    }
    flush(end);
  }

  /** The shapes a colour swap cannot express: bar, underline, and the hollow
   *  box an unfocused terminal draws. */
  private _drawCursor(
    renderer: RendererOps,
    row: number,
    col: number,
    end: number,
  ): void {
    const term = this._term;
    if (!term) return;
    const state = this._cursorState(term, this._rows);
    if (state.row !== row || state.col < col || state.col >= end) return;
    switch (state.shape) {
      case 'bar':
        renderer.decorate(row, state.col, 1, 'bar', this._palette.cursor);
        break;
      case 'underline':
        renderer.decorate(
          row,
          state.col,
          1,
          'cursorUnderline',
          this._palette.cursor,
        );
        break;
      case 'hollow':
        renderer.decorate(row, state.col, 1, 'box', this._palette.cursor);
        break;
      default:
        break;
    }
  }

  // --- focus and the cursor blink ------------------------------------------

  override defaultFocus(): void {
    this._focused = true;
    this._cursorOn = true;
    this._syncBlink();
    this._reportFocus(true);
    this._repaint();
  }

  override defaultBlur(): void {
    this._focused = false;
    this._cursorOn = true;
    this._syncBlink();
    this._reportFocus(false);
    this._repaint();
  }

  private _reportFocus(focused: boolean): void {
    if (this._term?.modes.sendFocusMode) {
      this._send(focused ? '\x1b[I' : '\x1b[O');
    }
  }

  private _syncBlink(): void {
    stopInterval(this._blink);
    this._blink = null;
    const blink = this._props().cursorBlink !== false;
    if (!this._focused || !blink) {
      this._cursorOn = true;
      return;
    }
    // Core's own interval, so two carets on one screen are in step.
    this._blink = startInterval(() => {
      this._cursorOn = !this._cursorOn;
      this._repaint();
    }, CARET_BLINK_MS);
  }

  // --- input: keyboard -----------------------------------------------------

  /**
   * The terminal's own key behaviour, run after the application's `onKeyDown`
   * handlers and not at all if one of them called `preventDefault()` — so an
   * app-level chord still beats the terminal, the same bargain the XEmbed
   * path documents.
   *
   * **Tab and the way out.** Core cycles focus on Tab before default actions,
   * and a terminal that consumes Tab owes the keyboard user an exit. The
   * convention `docs/extending.md` asks for is "Escape arms one pass-through
   * Tab", with one terminal-specific twist: Escape is *also* still sent to the
   * program (arming is a side effect, not a swallow), and arming is off while
   * the alternate screen is up — a full-screen vim owns Esc-then-Tab as real
   * input, and a focus-trapped full-screen application is the expected shape.
   * The pointer always leaves.
   */
  override defaultKeyDown(ev: KeyboardEvent): void {
    const term = this._term;
    if (!term) return;

    if (this._clipboardChord(ev)) {
      ev.preventDefault();
      return;
    }

    if (ev.keysym === XK_TAB && this._tabEscapes) {
      this._tabEscapes = false;
      return; // this one belongs to the focus cycle
    }
    this._tabEscapes =
      ev.keysym === XK_ESCAPE && term.buffer.active.type !== 'alternate';

    const bytes = encodeKey(ev, term.modes);
    if (bytes === null) return;
    this._typed();
    this._send(bytes);
    ev.preventDefault();
  }

  /**
   * The clipboard chords, and why a terminal's are not everyone else's.
   *
   * **Ctrl+C and Ctrl+V are not available.** Ctrl+C is SIGINT — the single
   * most-pressed key in a terminal — and Ctrl+V is readline's literal-next.
   * Both have to reach the program, so every terminal since xterm spells the
   * clipboard with Shift: **Ctrl+Shift+C / Ctrl+Shift+V**, which is what
   * gnome-terminal, konsole, kitty and alacritty all use.
   *
   * Three more are accepted because they cost the program nothing:
   *
   * - **Super+C / Super+V** (Command on a Mac keyboard under XQuartz).
   *   `keys.ts` never forwards a Super chord — those belong to the desktop —
   *   so nothing is taken from the program by answering them here, and it is
   *   the chord a Mac user's fingers already know.
   * - **Shift+Insert** pastes PRIMARY and **Ctrl+Insert** copies to
   *   CLIPBOARD: the X convention that predates all of the above and still
   *   works everywhere.
   * - **Ctrl+Shift+A** selects the screen. (Not Ctrl+A: that is
   *   beginning-of-line, and readline wants it.)
   *
   * The letter comes from core's `ctrlChordLetter`, which is public for
   * exactly this and gets the subtlety right — ntk derives `codepoint` from
   * the *shifted* keysym, so Ctrl+Shift+V arrives as `V` and Ctrl+V as `v`,
   * while the keysym does not shift.
   */
  private _clipboardChord(ev: KeyboardEvent): boolean {
    if (ev.keysym === XK_INSERT && (ev.shiftKey || ev.ctrlKey)) {
      if (ev.shiftKey) this.paste('PRIMARY');
      else this.copySelection();
      return true;
    }
    const clipboardModifier = (ev.ctrlKey && ev.shiftKey) || ev.metaKey;
    if (!clipboardModifier) return false;
    switch (ctrlChordLetter(ev)) {
      case 0x63: // c
        this.copySelection();
        return true;
      case 0x76: // v
        this.paste('CLIPBOARD');
        return true;
      case 0x61: // a
        this.selectAll();
        return true;
      default:
        return false;
    }
  }

  /**
   * A dead key or a Compose sequence finishing.
   *
   * Composition stays **on** for this element — unlike `<foreign>`, which
   * turns it off because the embedded client has an input method of its own.
   * Here there is no other side: the keys a composition takes never reach
   * `defaultKeyDown`, so without this the text a Compose sequence produced
   * would be typed into nothing. Only the commit is sent; the preedit is not
   * drawn, which is the honest state of IME support in this component (see
   * the PRD's non-goals).
   */
  override defaultComposition(ev: { type: string; data: string }): void {
    if (ev.type !== 'compositionEnd' || !ev.data) return;
    this._typed();
    this._send(ev.data);
  }

  /** Input scrolls back to the prompt and drops the selection, like every
   *  other terminal. */
  private _typed(): void {
    const term = this._term;
    if (!term) return;
    if (term.buffer.active.viewportY !== term.buffer.active.baseY) {
      term.scrollToBottom();
    }
    if (this._selection) this.clearSelection();
  }

  private _send(data: string): void {
    if (!data) return;
    this._props().onInput?.(data);
  }

  // --- input: pointer ------------------------------------------------------

  /** The cell under a pointer event. `contentBox()` and the cell metrics are
   *  device pixels, so the event is read in the same unit — a synthetic
   *  `x`/`y` is logical, and comparing it directly put a 2x click on the
   *  cell half as far from the corner as the pointer. */
  private _cellAt(ev: { x: number; y: number; nativeEvent?: unknown }): Grid {
    const fonts = this._fontSet();
    const box = this.contentBox();
    const cellWidth = fonts?.metrics.cellWidth ?? 1;
    const cellHeight = fonts?.metrics.cellHeight ?? 1;
    const p = this._devicePoint(ev);
    const col = Math.floor((p.x - box.x) / cellWidth);
    const row = Math.floor((p.y - box.y) / cellHeight);
    return {
      col: Math.max(0, Math.min(this._cols - 1, col)),
      row: Math.max(0, Math.min(this._rows - 1, row)),
    };
  }

  private _absLine(row: number): number {
    return (this._term?.buffer.active.viewportY ?? 0) + row;
  }

  /**
   * Whether this gesture belongs to the program rather than to the user.
   *
   * Shift is the universal override: an application that grabbed the mouse
   * still has to let the user select text, and Shift is how every terminal
   * spells that.
   */
  private _reporting(ev: { shiftKey: boolean }): boolean {
    const tracking = this._term?.modes.mouseTrackingMode ?? 'none';
    return tracking !== 'none' && !ev.shiftKey;
  }

  override defaultMouseDown(ev: MouseEvent): void {
    const term = this._term;
    if (!term) return;
    this.focus();
    const { col, row } = this._cellAt(ev);

    if (ev.button === 2 && !this._reporting(ev)) {
      // The X convention: middle-click pastes PRIMARY, as `<textinput>` and
      // `<codeeditor>` do.
      this.paste('PRIMARY');
      ev.preventDefault();
      return;
    }

    if (this._reporting(ev)) {
      this._send(
        encodeMouse(
          {
            kind: 'down',
            button: ev.button,
            col,
            row,
            shiftKey: ev.shiftKey,
            altKey: ev.altKey,
            ctrlKey: ev.ctrlKey,
            pressed: true,
          },
          {
            tracking: term.modes.mouseTrackingMode,
            encoding: this._mouseEncoding,
          },
        ) ?? '',
      );
      // A program in `drag` or `any` tracking wants the motion that follows,
      // including the part of it that leaves this element — which is what
      // capturing the pointer is for.
      ev.capturePointer();
      ev.preventDefault();
      return;
    }

    if (ev.button !== 1) return;
    const line = this._absLine(row);
    this._dragMode =
      ev.detail >= 3 ? 'line' : ev.detail === 2 ? 'word' : 'char';
    if (ev.shiftKey && this._anchor) {
      this._head = { line, col };
    } else {
      this._anchor = { line, col };
      this._head = { line, col };
    }
    this._updateSelection();
    ev.capturePointer();
    ev.preventDefault();
  }

  override defaultMouseDrag(ev: MouseEvent): void {
    const term = this._term;
    if (!term) return;
    const { col, row } = this._cellAt(ev);
    if (this._dragMode === null) {
      if (this._reporting(ev)) {
        this._send(
          encodeMouse(
            {
              kind: 'move',
              button: ev.button,
              col,
              row,
              shiftKey: ev.shiftKey,
              altKey: ev.altKey,
              ctrlKey: ev.ctrlKey,
              pressed: true,
            },
            {
              tracking: term.modes.mouseTrackingMode,
              encoding: this._mouseEncoding,
            },
          ) ?? '',
        );
      }
      return;
    }
    // Dragging past an edge scrolls the scrollback under the pointer. The
    // box is device pixels; so is the point compared with it.
    const box = this.contentBox();
    const { y } = this._devicePoint(ev);
    if (y < box.y) term.scrollLines(-1);
    else if (y > box.y + box.height) term.scrollLines(1);
    this._head = { line: this._absLine(row), col };
    this._updateSelection();
  }

  override defaultMouseUp(ev: MouseEvent): void {
    const term = this._term;
    if (term && this._dragMode === null && this._reporting(ev)) {
      const { col, row } = this._cellAt(ev);
      this._send(
        encodeMouse(
          {
            kind: 'up',
            button: ev.button,
            col,
            row,
            shiftKey: ev.shiftKey,
            altKey: ev.altKey,
            ctrlKey: ev.ctrlKey,
            pressed: false,
          },
          {
            tracking: term.modes.mouseTrackingMode,
            encoding: this._mouseEncoding,
          },
        ) ?? '',
      );
      ev.releasePointer();
      return;
    }
    if (this._dragMode === null) return;
    this._dragMode = null;
    ev.releasePointer?.();
    const text = this.selectionText();
    if (text) {
      // PRIMARY on selection end, which is what the middle button pastes.
      this._clipboard()
        ?.write(text, { selection: 'PRIMARY' })
        .catch(() => {});
      this._props().onSelectionChange?.(text);
    }
  }

  /**
   * The wheel. No default-action seam exists for it, so the component wires
   * `onWheel` to this — the same shape `<CodeEditor>` uses.
   */
  handleWheel(ev: WheelEvent): boolean {
    const term = this._term;
    if (!term) return false;
    const notches = Math.round(ev.deltaY / 48) || (ev.deltaY > 0 ? 1 : -1);
    const lines = notches * WHEEL_LINES;

    if (this._reporting(ev)) {
      const { col, row } = this._cellAt(ev);
      this._send(
        encodeMouse(
          {
            kind: 'wheel',
            button: 0,
            deltaY: ev.deltaY,
            col,
            row,
            shiftKey: ev.shiftKey,
            altKey: ev.altKey,
            ctrlKey: ev.ctrlKey,
            pressed: false,
          },
          {
            tracking: term.modes.mouseTrackingMode,
            encoding: this._mouseEncoding,
          },
        ) ?? '',
      );
      return true;
    }

    if (term.buffer.active.type === 'alternate') {
      // An alternate-screen application has no scrollback of its own, so the
      // wheel becomes arrow keys — which is what makes `less` and `man`
      // scroll (DECSET 1007).
      if (!this._alternateScroll) return false;
      this._send(
        encodeAlternateScroll(
          Math.abs(lines),
          lines < 0,
          term.modes.applicationCursorKeysMode,
        ),
      );
      return true;
    }
    term.scrollLines(lines);
    this._repaint();
    return true;
  }

  // --- selection -----------------------------------------------------------

  private _updateSelection(): void {
    const term = this._term;
    if (!term || !this._anchor || !this._head) return;
    let { line: aLine, col: aCol } = this._anchor;
    let { line: hLine, col: hCol } = this._head;

    if (this._dragMode === 'line') {
      aCol = 0;
      hCol = term.cols;
    } else if (this._dragMode === 'word') {
      const a = this._wordRange(aLine, aCol);
      const h = this._wordRange(hLine, hCol);
      const forward = hLine > aLine || (hLine === aLine && hCol >= aCol);
      aCol = forward ? a.from : a.to;
      hCol = forward ? h.to : h.from;
    } else {
      // A drag selects up to *and including* the cell the pointer is over
      // when it moved forwards, which is what makes selecting one character
      // possible at all.
      const forward = hLine > aLine || (hLine === aLine && hCol >= aCol);
      if (forward) hCol += 1;
    }
    this._selection = orderSelection(aLine, aCol, hLine, hCol);
    this._repaint();
  }

  private _wordRange(line: number, col: number): { from: number; to: number } {
    const text = this._term?.buffer.active.getLine(line)?.translateToString();
    if (!text) return { from: col, to: col + 1 };
    let from = col;
    let to = col + 1;
    if (!WORD_CHAR.test(text.charAt(col) || ' ')) return { from, to };
    while (from > 0 && WORD_CHAR.test(text.charAt(from - 1))) from--;
    while (to < text.length && WORD_CHAR.test(text.charAt(to))) to++;
    return { from, to };
  }

  /** The selected text, reflow-true: a wrapped line joins with no newline. */
  selectionText(): string | null {
    const term = this._term;
    const selection = this._selection;
    if (!term || !selection) return null;
    const buffer = term.buffer.active;
    let out = '';
    for (let line = selection.startLine; line <= selection.endLine; line++) {
      const buffered = buffer.getLine(line);
      if (!buffered) continue;
      const from = line === selection.startLine ? selection.startCol : 0;
      const to = line === selection.endLine ? selection.endCol : term.cols;
      const next = buffer.getLine(line + 1);
      const wrapped = line < selection.endLine && next?.isWrapped === true;
      out += buffered.translateToString(!wrapped, from, to);
      if (line < selection.endLine && !wrapped) out += '\n';
    }
    return out.length ? out : null;
  }

  // `: this`, matching the base declarations core grew in #294 — a subclass
  // narrowing them to void stops being structurally a DrawnNode.
  override clearSelection(): this {
    if (!this._selection && !this._anchor) return this;
    this._selection = null;
    this._anchor = null;
    this._head = null;
    this._dragMode = null;
    this._repaint();
    return this;
  }

  override selectAll(): this {
    const term = this._term;
    if (!term) return this;
    this._selection = {
      startLine: 0,
      startCol: 0,
      endLine: term.buffer.active.length - 1,
      endCol: term.cols,
    };
    this._repaint();
    return this;
  }

  // --- clipboard -----------------------------------------------------------

  private _clipboard(): ClipboardLike | null {
    return (
      (this.app as { clipboard?: ClipboardLike } | null | undefined)
        ?.clipboard ?? null
    );
  }

  copySelection(selection = 'CLIPBOARD'): void {
    const text = this.selectionText();
    if (!text) return;
    this._clipboard()
      ?.write(text, { selection })
      .catch(() => {});
  }

  paste(selection = 'CLIPBOARD'): void {
    const term = this._term;
    if (!term) return;
    this._clipboard()
      ?.read({ selection })
      .then((text) => {
        if (this.destroyed || typeof text !== 'string' || !text) return;
        this._typed();
        this._send(encodePaste(text, term.modes.bracketedPasteMode));
      })
      .catch(() => {});
  }

  /**
   * OSC 52 — the program asking for the clipboard.
   *
   * **Writes** are honoured (that is how `tmux`, `vim` and `nvim` copy out of
   * an ssh session, and it is the whole point of the sequence), capped, and
   * CLIPBOARD only. **Reads are answered with nothing, always**: replying
   * would hand whatever the user last copied — a password, a token — to a
   * program that merely printed eight bytes, so the answer is the same one
   * kitty and iTerm ship by default.
   */
  private _onOsc52(data: string): boolean {
    if (this._props().allowClipboardWrite === false) return true;
    const semi = data.indexOf(';');
    if (semi < 0) return true;
    const payload = data.slice(semi + 1);
    if (payload === '?' || payload.length > MAX_OSC52) return true;
    const text = decodeBase64(payload);
    if (text === null) return true;
    this._clipboard()
      ?.write(text, { selection: 'CLIPBOARD' })
      .catch(() => {});
    return true;
  }

  // --- the handle's half ---------------------------------------------------

  scrollLines(amount: number): void {
    this._term?.scrollLines(amount);
    this._repaint();
  }

  scrollToBottom(): void {
    this._term?.scrollToBottom();
    this._repaint();
  }

  /** The visible screen as text — "copy all", and what the tests read. */
  serialize(): string | null {
    const term = this._term;
    if (!term) return null;
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < term.rows; row++) {
      lines.push(
        buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '',
      );
    }
    // Trailing blank lines are the empty part of the screen, not content.
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  /** The renderer in use, and what the last frame cost — the draw-op budget
   *  assertions read this. */
  get rendererStats(): {
    kind: string;
    stats: RendererStats;
    totals: RendererStats;
  } {
    const empty: RendererStats = {
      fillRequests: 0,
      glyphRequests: 0,
      copies: 0,
      blits: 0,
      cellsFilled: 0,
      glyphsDrawn: 0,
    };
    const renderer = this._renderer;
    return {
      kind: renderer?.kind ?? 'none',
      stats: renderer?.stats ?? empty,
      totals: renderer?.totals ?? { ...empty },
    };
  }
}

/**
 * The visual bell as a palette, rather than as a second drawing path: the
 * flash is background and foreground swapped, which every cell picks up
 * through the ordinary resolve-and-diff and nothing else has to know about.
 */
function paletteColors(props: VtTermProps): TerminalColors | undefined {
  const colors = props.colors;
  if (!props.inverted) return colors;
  return {
    ...colors,
    background: colors?.foreground ?? '#e6e6e6',
    foreground: colors?.background ?? '#101014',
  };
}

/** Everything about the palette that could change what a cell looks like. */
function paletteKey(props: VtTermProps): string {
  const colors = props.colors;
  return [
    props.inverted ? 'inverted' : '',
    colors?.background ?? '',
    colors?.foreground ?? '',
    colors?.cursor ?? '',
    (colors?.palette ?? []).join(','),
  ].join('|');
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64 to UTF-8, by hand.
 *
 * `atob` and `Buffer` are both globals the build may not name (`types: []`),
 * and reaching for one through `globalThis` for twenty lines of table lookup
 * is more machinery than the table.
 */
function decodeBase64(input: string): string | null {
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    if (char === '=') break;
    const value = B64.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  // UTF-8 by hand too, for the same reason `TextDecoder` is not named here.
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let cp = b;
    let extra = 0;
    if (b >= 0xf0) {
      cp = b & 0x07;
      extra = 3;
    } else if (b >= 0xe0) {
      cp = b & 0x0f;
      extra = 2;
    } else if (b >= 0xc0) {
      cp = b & 0x1f;
      extra = 1;
    }
    i++;
    for (let k = 0; k < extra && i < bytes.length; k++, i++) {
      cp = (cp << 6) | (bytes[i] & 0x3f);
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}
