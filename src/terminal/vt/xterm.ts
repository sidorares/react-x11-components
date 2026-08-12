// `@xterm/headless`, as an interface.
//
// The emulator core is an **optional dependency**: it installs by default
// (nothing else would bring it, and the terminal is a flagship), but an app
// that ran `npm install --no-optional` must still type-check against this
// package. `import type { Terminal } from '@xterm/headless'` would put the
// package in the type graph and break exactly that app, so the slice we use
// is written out structurally here — the rule `../../desktop-calendar/ical.ts`
// established for `ical.js`, for the same reason.
//
// Everything below is public API in the 6.0.0 typings. Nothing here reaches
// into `term._core`: xterm.js internals churn between majors, and a renderer
// that depends on them is a renderer that breaks on an upgrade nobody made.

/** What every xterm listener registration hands back. */
export interface XtermDisposable {
  dispose(): void;
}

/** xterm's event shape: call it with a listener, get a disposable. */
export type XtermEvent<T> = (listener: (arg: T) => void) => XtermDisposable;

/**
 * One cell of the buffer.
 *
 * The `is*` predicates return numbers rather than booleans (the attribute
 * bits, unshifted) — `isUnderline()` in particular carries the *style*
 * variant, which is why it is read as a number here too.
 */
export interface XtermCell {
  getWidth(): number;
  getChars(): string;
  getCode(): number;
  getFgColor(): number;
  getBgColor(): number;
  getFgColorMode(): number;
  getBgColorMode(): number;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isOverline(): number;
}

export interface XtermLine {
  readonly isWrapped: boolean;
  readonly length: number;
  /**
   * `cell` is the reuse slot the diff loop depends on: one work cell for the
   * whole viewport instead of an object per cell per frame. The API documents
   * the reuse, so this is the intended shape rather than a trick.
   */
  getCell(x: number, cell?: XtermCell): XtermCell | undefined;
  translateToString(
    trimRight?: boolean,
    startColumn?: number,
    endColumn?: number,
  ): string;
}

export interface XtermBuffer {
  readonly type: 'normal' | 'alternate';
  readonly cursorX: number;
  readonly cursorY: number;
  /** Buffer-absolute index of the line at the top of the viewport. */
  readonly viewportY: number;
  /** Buffer-absolute index of the top of the bottom page. */
  readonly baseY: number;
  readonly length: number;
  getLine(y: number): XtermLine | undefined;
  getNullCell(): XtermCell;
}

export interface XtermBuffers {
  readonly active: XtermBuffer;
  readonly normal: XtermBuffer;
  readonly alternate: XtermBuffer;
  readonly onBufferChange: XtermEvent<XtermBuffer>;
}

/** The modes the encoders branch on. All public in `IModes`. */
export interface XtermModes {
  readonly applicationCursorKeysMode: boolean;
  readonly applicationKeypadMode: boolean;
  readonly bracketedPasteMode: boolean;
  readonly insertMode: boolean;
  readonly mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  readonly originMode: boolean;
  readonly reverseWraparoundMode: boolean;
  readonly sendFocusMode: boolean;
  readonly wraparoundMode: boolean;
}

export interface XtermFunctionIdentifier {
  prefix?: string;
  intermediates?: string;
  final: string;
}

export interface XtermParser {
  registerCsiHandler(
    id: XtermFunctionIdentifier,
    callback: (params: (number | number[])[]) => boolean,
  ): XtermDisposable;
  registerOscHandler(
    ident: number,
    callback: (data: string) => boolean,
  ): XtermDisposable;
}

/** The options we set. A subset — xterm has many more, none of them ours. */
export interface XtermOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
  drawBoldTextInBrightColors?: boolean;
  allowProposedApi?: boolean;
  convertEol?: boolean;
  windowsPty?: unknown;
}

/**
 * The emulator itself: bytes in, screen state out, and the events that say
 * something changed.
 *
 * `onData` is the *reply* channel — DA, DSR, focus reports, mouse reports the
 * core encodes itself — and it has to reach the pty, or an application that
 * asks the terminal a question waits forever.
 */
export interface XtermTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: XtermBuffers;
  readonly parser: XtermParser;
  readonly modes: XtermModes;
  options: XtermOptions;

  readonly onBell: XtermEvent<void>;
  readonly onBinary: XtermEvent<string>;
  readonly onCursorMove: XtermEvent<void>;
  readonly onData: XtermEvent<string>;
  readonly onLineFeed: XtermEvent<void>;
  readonly onResize: XtermEvent<{ cols: number; rows: number }>;
  readonly onScroll: XtermEvent<number>;
  readonly onTitleChange: XtermEvent<string>;
  readonly onWriteParsed: XtermEvent<void>;

  write(data: string | Uint8Array, callback?: () => void): void;
  input(data: string, wasUserInput?: boolean): void;
  resize(cols: number, rows: number): void;
  scrollLines(amount: number): void;
  scrollToBottom(): void;
  scrollToTop(): void;
  clear(): void;
  reset(): void;
  dispose(): void;
}

/** The module's shape: one constructor. */
export interface XtermModule {
  Terminal: new (options?: XtermOptions) => XtermTerminal;
}

/**
 * Load `@xterm/headless`, or answer `null` if it is not installed.
 *
 * A dynamic `import()` that is allowed to fail, exactly like
 * `../../desktop-calendar/ical.ts`: "the optional dependency is missing" is an
 * ordinary state of a healthy machine, and the component reports it as
 * `status: 'unavailable'` plus the `fallback`, never as a throw.
 */
let cached: Promise<XtermModule | null> | null = null;
export function loadXterm(): Promise<XtermModule | null> {
  cached ??= import('@xterm/headless')
    .then((mod) => {
      const m = mod as unknown as Partial<XtermModule>;
      return typeof m.Terminal === 'function' ? (m as XtermModule) : null;
    })
    .catch(() => null);
  return cached;
}
