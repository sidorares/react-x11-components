// The retained node behind `<codeeditor>`: the text model (lines, caret,
// selection, undo), scrolling, and all painting (gutter, tokens, selection,
// caret, bracket match, diagnostics). `./index.ts` registers it and wires
// input to it.
//
// **How input reaches this node.** Through the default-action seam
// react-x11#266 made public: `defaultKeyDown`, `defaultMouseDown`,
// `defaultMouseDrag`, `defaultMouseUp`, `defaultFocus` and `defaultBlur`
// are methods the EventManager calls on the focused or pressed node, after
// the application's own `onKeyDown`/`onMouseDown` handlers and not at all
// if one of them called `preventDefault()`. So a bare `<codeeditor>` in
// JSX edits, selects and blinks the way `<textinput>` does, with no
// wrapping component required — and an app still vetoes or extends any of
// it without knowing how the element is built.
//
// `<CodeEditor>` is now only the completion popup: it is an ordinary
// `onKeyDown` handler that consumes the keys the popup owns (arrows,
// Return, Tab-accept, Escape-close) and, by consuming them, keeps this
// node's default action from also acting on them.
import { CARET_BLINK_MS, Node } from 'react-x11/node';
import type {
  Context2D,
  MeasureConstraints,
  MeasuredSize,
} from 'react-x11/node';
import type { Style } from 'react-x11/style';
import {
  ctrlChordLetter,
  XK_BACKSPACE,
  XK_DELETE,
  XK_DOWN,
  XK_END,
  XK_ESCAPE,
  XK_HOME,
  XK_KP_ENTER,
  XK_LEFT,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RETURN,
  XK_RIGHT,
  XK_TAB,
  XK_UP,
} from 'react-x11/keysyms';

import { startInterval, stopInterval } from '../code-language/timers.js';
import type { TimerId } from '../code-language/timers.js';
import {
  clampPos,
  comparePos,
  maxPos,
  minPos,
  movePos,
  posEqual,
  tabMap,
  wordBoundary,
  wordRangeAt,
} from './doc.js';
import type { TabMap } from './doc.js';
import {
  DARK_TOKEN_STYLES,
  isDarkBackground,
  LIGHT_TOKEN_STYLES,
  tokenStyleFor,
} from '../code-language/theme.js';
import type {
  Diagnostic,
  Language,
  Position,
  Selection,
  Token,
  TokenStyles,
  Tokenizer,
} from '../code-language/types.js';

/**
 * The element name — registration key, `kind`, and JSX tag, one string.
 * react-x11 rejects a node whose `kind` is not the name it was registered
 * under, because `kind` is what paint order, the test queries and the DEV
 * assertion all match on. One constant, used in all three places.
 */
export const ELEMENT = 'codeeditor';

const UNDO_LIMIT = 200;
const DEFAULT_ROWS = 6;
const PREFERRED_WIDTH = 360;
const GUTTER_PAD = 8; // each side of the line numbers
const CARET_MARGIN = 24; // keep this many px visible beside the caret
const MATCH_SCAN_LIMIT = 20000; // chars examined looking for a bracket match

/**
 * The editor's imperative surface — what `ev.target` and the component's
 * `ref` are typed as. An interface rather than the node class on purpose:
 * the class has private state, which makes its type nominal, and a nominal
 * type inside the exported props would stop `src/` and `dist/` declarations
 * (both live in this repo's typecheck program) merging their JSX
 * augmentations. The full retained node is underneath — cast to
 * {@link CodeEditorNode} for `abs`, `style` and the rest of the `Node`
 * surface.
 */
export interface CodeEditorHandle {
  /** Read the text; assign to set it *without* an `onChange`, the
   * DOM-input contract form libraries rely on. */
  value: string;
  readonly name: string | undefined;
  readonly selection: Selection;
  readonly lines: readonly string[];
  readonly language: Language | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  selectedText(): string;
  replaceRange(from: Position, to: Position, text: string): void;
  insertText(text: string): void;
  moveCaret(pos: Position, extend: boolean): void;
  select(anchor: Position, head: Position): void;
  selectAll(): void;
  undo(): void;
  redo(): void;
  indentSelection(dir: 1 | -1): void;
  toggleLineComment(): void;
  copySelection(selection?: string): void;
  pasteFrom(selection?: string): void;
  scrollBy(dx: number, dy: number): boolean;
  caretRect(): { x: number; y: number; height: number };
  focus(): void;
  blur(): void;
}

/** The value/submit/selection event the component's callbacks receive —
 * the same shape core's `<textinput>` events have, minus dispatch. */
export interface CodeEditorEvent {
  type: 'change' | 'submit' | 'selectionchange';
  value: string;
  name: string | undefined;
  selection: Selection;
  target: CodeEditorHandle;
  currentTarget: CodeEditorHandle;
  nativeEvent: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/** The props `<codeeditor>` takes. The component re-exports this. */
export interface CodeEditorProps {
  /** Controlled text (with `onChange`). */
  value?: string;
  /** Uncontrolled initial text. */
  defaultValue?: string;
  onChange?: (ev: CodeEditorEvent) => void;
  /** Ctrl+Enter. */
  onSubmit?: (ev: CodeEditorEvent) => void;
  /** Caret or selection moved — what completion UIs track. */
  onSelectionChange?: (ev: CodeEditorEvent) => void;
  /** Field name, echoed on events. */
  name?: string;
  /** The language seam. `null`/absent paints plain text. */
  language?: Language | null;
  /** Token type → colour/weight/italic. Default {@link LIGHT_TOKEN_STYLES}. */
  tokenStyles?: TokenStyles;
  /** Ranges to underline (LSP-shaped). */
  diagnostics?: readonly Diagnostic[];
  readOnly?: boolean;
  /** Inert: no default action runs, and the component also stops making it
   * focusable. `readOnly` still navigates and copies; this does neither. */
  disabled?: boolean;
  placeholder?: string;
  placeholderColor?: string;
  /** Preferred height in text lines (default 6). */
  rows?: number;
  /** Tab display width and indent size (default 4). */
  tabSize?: number;
  /** Indent with spaces (default) or a real tab. */
  insertSpaces?: boolean;
  lineNumbers?: boolean;
  /** Tint the caret's line. */
  activeLine?: boolean;
  /** Highlight the bracket pair around the caret (default true). */
  matchBrackets?: boolean;
  selectionColor?: string;
  caretColor?: string;
  gutterColor?: string;
  gutterBackground?: string;
  activeLineColor?: string;
  matchingBracketColor?: string;
  style?: Style | Style[];
}

// --- structural types for runtime surfaces that have no public declarations
//
// Same policy as `desktop-calendar/ical.ts`: describe what is used, locally,
// rather than reaching into another package's internal type graph.

/** The slice of ntk's TextLayout the editor reads. */
interface LayoutLike {
  width: number;
  height: number;
  draw(ctx: unknown, x: number, y: number): void;
  caretPosition(cp: number): { x: number; y: number; height: number };
  indexAt(x: number, y: number): number;
}

interface FontsLike {
  layout(
    content: string | Array<Record<string, unknown>>,
    style: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): LayoutLike;
}

/** ntk's clipboard, reached through the public `app` — write/read are what
 * core's own fields call. Absent on older ntk; every use is optional. */
interface ClipboardLike {
  write(text: string, options?: { selection?: string }): Promise<unknown>;
  read(options?: { selection?: string }): Promise<unknown>;
}

interface HistoryEntry {
  value: string;
  caret: Position;
  anchor: Position;
}

const BRACKETS: Record<string, { match: string; dir: 1 | -1 }> = {
  '(': { match: ')', dir: 1 },
  '[': { match: ']', dir: 1 },
  '{': { match: '}', dir: 1 },
  ')': { match: '(', dir: -1 },
  ']': { match: '[', dir: -1 },
  '}': { match: '{', dir: -1 },
};

/** Token types the bracket matcher must not look inside. */
const OPAQUE_TOKENS = new Set(['string', 'string2', 'comment', 'docComment']);

const SEVERITY_COLORS: Record<string, string> = {
  error: '#e5484d',
  warning: '#d5a021',
  information: '#3b82f6',
  hint: '#8b8f98',
};

function cpToUtf16(text: string, cp: number): number {
  let i = 0;
  for (let n = 0; n < cp && i < text.length; n++) {
    const code = text.codePointAt(i)!;
    i += code > 0xffff ? 2 : 1;
  }
  return i;
}

function utf16ToCp(text: string, index: number): number {
  let cp = 0;
  for (let i = 0; i < index && i < text.length;) {
    const code = text.codePointAt(i)!;
    i += code > 0xffff ? 2 : 1;
    cp++;
  }
  return cp;
}

/** What the component's handlers pass in — the public synthetic event
 * surface (docs/events.md), structurally. */
export interface EditorKeyEvent {
  keysym?: number;
  codepoint?: number;
  key?: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  nativeEvent?: unknown;
  defaultPrevented?: boolean;
  /** Consumes the key: what it suppresses is the default action *after*
   * this one, which for Tab is the focus cycle. */
  preventDefault?(): void;
}

export interface EditorMouseEvent {
  x: number;
  y: number;
  button?: number;
  detail?: number;
  shiftKey: boolean;
  capturePointer?(): void;
  releasePointer?(): void;
  preventDefault?(): void;
}

interface LineCacheEntry {
  display: string;
  tokens: readonly Token[];
  styleKey: string;
  layout: LayoutLike | null;
  map: TabMap;
}

export class CodeEditorNode extends Node implements CodeEditorHandle {
  private _lines: string[];
  /** What `_lines` was last built from — how a controlled `value` that the
   * parent refused to update snaps back on the next read (see `_syncProps`). */
  private _synced: string;
  private _caret: Position = { line: 0, ch: 0 };
  private _anchor: Position = { line: 0, ch: 0 };
  private _scrollX = 0;
  private _scrollY = 0;
  private _focused = false;
  private _caretOn = false;
  private _blinkTimer: TimerId = null;
  private _goalX: number | null = null;
  private _drag: 'char' | 'word' | 'line' | null = null;
  private _dragOrigin: Position = { line: 0, ch: 0 };
  /** Escape was the last key, so the next Tab leaves instead of indenting —
   * the editor's way of not being a keyboard trap (see `defaultKeyDown`). */
  private _tabEscapes = false;
  private _history: HistoryEntry[];
  private _historyIndex = 0;
  private _undoRun: string | null = null;
  private _pendingValue: string | null = null;
  private _keyNative: unknown = null;
  private _tok: Tokenizer | null = null;
  private _tokLanguage: Language | null | undefined;
  private _lineCache = new Map<number, LineCacheEntry>();
  private _metricsKey = '';
  private _lineH = 0;
  private _charW = 0;
  private _widest = 0;

  constructor(props: Record<string, unknown>, app: unknown) {
    super(ELEMENT, props, app as ConstructorParameters<typeof Node>[2]);
    const initial =
      props.value != null
        ? String(props.value)
        : props.defaultValue != null
          ? String(props.defaultValue)
          : '';
    this._lines = initial.split('\n');
    this._synced = initial;
    this._history = [
      { value: initial, caret: this._caret, anchor: this._anchor },
    ];
    // Without this nothing focuses the editor and no key ever reaches it —
    // an app's `focusable`/`tabIndex` prop still overrides either way, which
    // is how `<CodeEditor disabled>` stays out of the tab order.
    this.focusableByDefault = true;
    this.defaultCursor = 'text';
    // The editor's selection is its own (react-x11#291). A `selectable`
    // document around it — a `<Markdown>` with a live editor in it, a form
    // on a selectable pane — skips this subtree whole rather than lighting
    // up half the text somebody is typing in, and a press here never
    // reaches the surface above. That is the same rule `<textinput>` keeps,
    // and the reason the `default*` handlers below can own the gesture
    // without calling `super`.
    this.hasOwnSelection = true;
  }

  /**
   * The editor's own size: a comfortable width, never wider than what is on
   * offer, and `rows` text lines tall. An unbounded axis arrives as
   * `Infinity`, so the `Math.min` is the whole rule. The height comes from a
   * prop rather than from the style, which is what makes the
   * `invalidateMeasure` in `applyProps` necessary.
   */
  override measureContent({ width }: MeasureConstraints): MeasuredSize {
    const rows = Math.max(1, Number(this.props.rows ?? DEFAULT_ROWS));
    return {
      width: Math.min(PREFERRED_WIDTH, width),
      height: Math.ceil(this._lineHeight() * rows),
    };
  }

  // --- value & props sync --------------------------------------------------

  get value(): string {
    if (this._pendingValue !== null) return this._pendingValue;
    if (this.props.value != null) return String(this.props.value);
    return this._lines.join('\n');
  }

  /** Programmatic set, no `onChange` — the DOM-input contract form libraries
   * rely on. On a controlled editor `props.value` wins the next render. */
  set value(next: string) {
    const text = next == null ? '' : String(next);
    if (text === this._lines.join('\n')) return;
    this._setText(text);
    this._noteExternal();
    this._repaint();
  }

  get name(): string | undefined {
    return this.props.name as string | undefined;
  }

  get selection(): Selection {
    return { anchor: { ...this._anchor }, head: { ...this._caret } };
  }

  get lines(): readonly string[] {
    this._syncProps();
    return this._lines;
  }

  get language(): Language | null {
    return (this.props.language as Language | null | undefined) ?? null;
  }

  /**
   * Pull a controlled `value` into the model. Called at the top of every
   * command and paint: a parent that ignored an `onChange` never re-renders,
   * so there is no `applyProps` moment to catch the divergence — the next
   * read is that moment.
   */
  private _syncProps(): void {
    const v = this.props.value;
    if (v == null) return;
    const text = String(v);
    if (text === this._synced) return;
    this._setText(text);
    this._noteExternal();
  }

  private _setText(text: string): void {
    this._lines = text.split('\n');
    this._synced = text;
    this._caret = clampPos(this._lines, this._caret);
    this._anchor = clampPos(this._lines, this._anchor);
    this._lineCache.clear();
    this._widest = 0;
    this._tokenizer()?.setLines(this._lines);
  }

  // --- tokenizer -----------------------------------------------------------

  private _tokenizer(): Tokenizer | null {
    const lang = this.language;
    if (lang !== this._tokLanguage) {
      this._tok?.dispose?.();
      this._tokLanguage = lang;
      this._tok = lang
        ? lang.createTokenizer({
            invalidate: (fromLine) => {
              for (const key of this._lineCache.keys()) {
                if (key >= fromLine) this._lineCache.delete(key);
              }
              this._repaint();
            },
          })
        : null;
      this._tok?.setLines(this._lines);
      this._lineCache.clear();
    }
    return this._tok;
  }

  // --- metrics & style -----------------------------------------------------

  private _textStyle(): Record<string, unknown> {
    const s = this.style as Record<string, unknown>;
    return {
      family: (s.fontFamily as string) ?? 'monospace',
      size: (s.fontSize as number) ?? 13,
      weight: (s.fontWeight as number) ?? 400,
      style: (s.fontStyle as string) ?? 'normal',
      // theme text before hardcoded ink: on a dark desktop the palette's
      // `text` is light, and a near-black fallback would vanish — the
      // component's default style also asks for `color: '$text'`, so this
      // branch is for a bare <codeeditor> under a themeless tree
      color: (s.color as string) ?? this._themeColor('text') ?? '#24292f',
    };
  }

  private _themeColor(token: string): string | undefined {
    const theme = this.theme as Record<string, unknown> | null;
    const v = theme?.[token];
    return typeof v === 'string' ? v : undefined;
  }

  private _fonts(): FontsLike | null {
    return (
      (this.app as { fonts?: FontsLike } | null | undefined)?.fonts ?? null
    );
  }

  private _metrics(): void {
    const s = this._textStyle();
    const key = `${s.family}|${s.size}|${s.weight}`;
    if (key === this._metricsKey && this._lineH > 0) return;
    const fonts = this._fonts();
    this._metricsKey = key;
    if (!fonts) {
      this._lineH = Number(s.size) * 1.4;
      this._charW = Number(s.size) * 0.6;
      return;
    }
    const probe = fonts.layout('Mg', s);
    this._lineH = probe.height || Number(s.size) * 1.4;
    this._charW = fonts.layout('0', s).width || Number(s.size) * 0.6;
  }

  private _lineHeight(): number {
    this._metrics();
    return this._lineH;
  }

  /**
   * The content box: `abs` inset by border and padding, computed from the
   * flattened style. [react-x11 gap] built-in fields read an internal
   * `contentBox()`; a public equivalent would remove this arithmetic —
   * filed as react-x11#254.
   */
  private _contentRect(): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const s = this.style as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const border = num(s.borderWidth);
    const pad = num(s.padding);
    const top = num(s.borderTopWidth ?? border) + num(s.paddingTop ?? pad);
    const right =
      num(s.borderRightWidth ?? border) + num(s.paddingRight ?? pad);
    const bottom =
      num(s.borderBottomWidth ?? border) + num(s.paddingBottom ?? pad);
    const left = num(s.borderLeftWidth ?? border) + num(s.paddingLeft ?? pad);
    const { x, y, width, height } = this.abs;
    return {
      x: x + left,
      y: y + top,
      width: Math.max(0, width - left - right),
      height: Math.max(0, height - top - bottom),
    };
  }

  private _gutterWidth(): number {
    if (!this.props.lineNumbers) return 0;
    this._metrics();
    const digits = Math.max(2, String(this._lines.length).length);
    return Math.ceil(digits * this._charW) + GUTTER_PAD * 2;
  }

  private _tabSize(): number {
    const n = Number(this.props.tabSize ?? 4);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
  }

  // --- per-line layout -----------------------------------------------------

  private _resolveColor(color: string | undefined): string | undefined {
    if (!color) return color;
    if (color.startsWith('$')) return this._themeColor(color.slice(1));
    return color;
  }

  /**
   * The token palette in force: the prop when given, else whichever
   * built-in set reads on this editor's background — the resolved
   * `backgroundColor` when it is a judgeable colour, the theme's
   * `background` otherwise. This is what makes one `<CodeEditor>` legible
   * on a light *and* a dark desktop with no props at all.
   */
  private _tokenStyles(): TokenStyles {
    const explicit = this.props.tokenStyles as TokenStyles | undefined;
    if (explicit) return explicit;
    const s = this.style as Record<string, unknown>;
    const own = isDarkBackground(s.backgroundColor as string | undefined);
    const dark = own ?? isDarkBackground(this._themeColor('background'));
    return dark ? DARK_TOKEN_STYLES : LIGHT_TOKEN_STYLES;
  }

  /** Shared by the paint defaults that need a light/dark answer. */
  private _onDark(): boolean {
    const s = this.style as Record<string, unknown>;
    return (
      (isDarkBackground(s.backgroundColor as string | undefined) ??
        isDarkBackground(this._themeColor('background'))) === true
    );
  }

  private _lineEntry(line: number): LineCacheEntry {
    const raw = this._lines[line];
    const map = tabMap(raw, this._tabSize());
    const tokens = this._tokenizer()?.lineTokens(line) ?? [];
    const styleKey = this._metricsKey;
    const cached = this._lineCache.get(line);
    if (
      cached &&
      cached.display === map.display &&
      cached.tokens === tokens &&
      cached.styleKey === styleKey
    ) {
      return cached;
    }
    const fonts = this._fonts();
    const base = this._textStyle();
    let layout: LayoutLike | null = null;
    if (fonts) {
      const styles = this._tokenStyles();
      const spans: Array<Record<string, unknown>> = [];
      let cursor = 0;
      for (const t of tokens) {
        const from = map.toDisplay(t.from);
        const to = map.toDisplay(t.to);
        if (from > cursor) {
          spans.push({ text: map.display.slice(cursor, from) });
        }
        if (to > from) {
          const st = tokenStyleFor(styles, t.type);
          const span: Record<string, unknown> = {
            text: map.display.slice(from, to),
          };
          if (st) {
            const color = this._resolveColor(st.color);
            if (color) span.color = color;
            if (st.weight) span.weight = st.weight;
            if (st.fontStyle) span.style = st.fontStyle;
          }
          spans.push(span);
        }
        cursor = Math.max(cursor, to);
      }
      if (cursor < map.display.length) {
        spans.push({ text: map.display.slice(cursor) });
      }
      layout = fonts.layout(spans.length > 0 ? spans : [{ text: '' }], base);
    }
    const entry: LineCacheEntry = {
      display: map.display,
      tokens,
      styleKey,
      layout,
      map,
    };
    this._lineCache.set(line, entry);
    if (layout && layout.width > this._widest) this._widest = layout.width;
    return entry;
  }

  /** Caret x (display pixels from the text origin) for a position. */
  private _caretX(pos: Position): number {
    const entry = this._lineEntry(pos.line);
    if (!entry.layout) return 0;
    const disp = entry.map.toDisplay(pos.ch);
    return entry.layout.caretPosition(utf16ToCp(entry.display, disp)).x;
  }

  /** Window coordinates → document position. */
  private _posAt(x: number, y: number): Position {
    this._metrics();
    const content = this._contentRect();
    const textX = content.x + this._gutterWidth();
    const line = Math.max(
      0,
      Math.min(
        this._lines.length - 1,
        Math.floor((y - content.y + this._scrollY) / this._lineH),
      ),
    );
    const entry = this._lineEntry(line);
    if (!entry.layout) return { line, ch: 0 };
    const cp = entry.layout.indexAt(x - textX + this._scrollX, 0);
    const disp = cpToUtf16(entry.display, cp);
    return clampPos(this._lines, { line, ch: entry.map.toRaw(disp) });
  }

  /** Font facts the completion popup sizes itself with. */
  metrics(): {
    lineHeight: number;
    charWidth: number;
    family: string;
    size: number;
  } {
    this._metrics();
    const s = this._textStyle();
    return {
      lineHeight: this._lineH,
      charWidth: this._charW,
      family: String(s.family),
      size: Number(s.size),
    };
  }

  /** Text width in this editor's font. The built-in completion popup no
   * longer needs it — a `<popup anchor>` measures its own rows — but an app
   * laying out its own overlay against the text still does. */
  measureText(text: string): number {
    const fonts = this._fonts();
    if (!fonts) return text.length * this._charW;
    return fonts.layout(text, this._textStyle()).width;
  }

  /** Caret geometry relative to this node's origin — node coordinates, which
   * is exactly what a `<popup anchor={{at}}>` takes, so the completion popup
   * hands this straight through and nothing here has to know where the
   * editor sits on screen. */
  caretRect(): { x: number; y: number; height: number } {
    this._syncProps();
    this._metrics();
    const content = this._contentRect();
    const textX = content.x + this._gutterWidth() - this.abs.x;
    return {
      x: textX + this._caretX(this._caret) - this._scrollX,
      y:
        content.y - this.abs.y + this._caret.line * this._lineH - this._scrollY,
      height: this._lineH,
    };
  }

  // --- scrolling -----------------------------------------------------------

  private _maxScrollY(): number {
    const content = this._contentRect();
    return Math.max(
      0,
      this._lines.length * this._lineHeight() - content.height,
    );
  }

  private _maxScrollX(): number {
    const content = this._contentRect();
    const textW = content.width - this._gutterWidth();
    return Math.max(0, this._widest + CARET_MARGIN - textW);
  }

  /** Wheel notches (deltaX/deltaY arrive as ±1 per notch) → pixels. */
  handleWheel(ev: { deltaX: number; deltaY: number }): boolean {
    const step = this._lineHeight() * 3;
    return this.scrollBy(ev.deltaX * step, ev.deltaY * step);
  }

  /** Returns true when the offset moved (the component consumes the wheel
   * event exactly then, so an unscrollable editor lets the page scroll). */
  scrollBy(dx: number, dy: number): boolean {
    const nx = Math.max(0, Math.min(this._scrollX + dx, this._maxScrollX()));
    const ny = Math.max(0, Math.min(this._scrollY + dy, this._maxScrollY()));
    if (nx === this._scrollX && ny === this._scrollY) return false;
    this._scrollX = nx;
    this._scrollY = ny;
    this.root?.invalidate(false, this.abs, 'scroll');
    return true;
  }

  private _ensureCaretVisible(): void {
    this._metrics();
    const content = this._contentRect();
    const lineTop = this._caret.line * this._lineH;
    if (lineTop < this._scrollY) this._scrollY = lineTop;
    const lineBottom = lineTop + this._lineH;
    if (lineBottom > this._scrollY + content.height) {
      this._scrollY = lineBottom - content.height;
    }
    const textW = content.width - this._gutterWidth();
    const x = this._caretX(this._caret);
    if (x < this._scrollX + CARET_MARGIN) {
      this._scrollX = Math.max(0, x - CARET_MARGIN);
    }
    if (x > this._scrollX + textW - CARET_MARGIN) {
      this._scrollX = x - textW + CARET_MARGIN;
    }
    this._scrollY = Math.max(0, Math.min(this._scrollY, this._maxScrollY()));
    this._scrollX = Math.max(0, this._scrollX);
  }

  // --- events out ----------------------------------------------------------

  private _makeEvent(type: CodeEditorEvent['type']): CodeEditorEvent {
    const self = this;
    const ev: CodeEditorEvent = {
      type,
      value: this.value,
      name: this.name,
      selection: this.selection,
      target: self,
      currentTarget: self,
      nativeEvent: this._keyNative ?? null,
      defaultPrevented: false,
      preventDefault() {
        ev.defaultPrevented = true;
      },
      stopPropagation() {},
    };
    return ev;
  }

  private _fire(
    prop: 'onChange' | 'onSubmit' | 'onSelectionChange',
    value: string,
  ): void {
    const handler = this.props[prop] as
      ((ev: CodeEditorEvent) => void) | undefined;
    if (!handler) return;
    const previous = this._pendingValue;
    this._pendingValue = value;
    try {
      handler(
        this._makeEvent(
          prop === 'onSubmit'
            ? 'submit'
            : prop === 'onSelectionChange'
              ? 'selectionchange'
              : 'change',
        ),
      );
    } finally {
      this._pendingValue = previous;
    }
  }

  private _repaint(): void {
    this._caretOn = true;
    this.root?.invalidate(false, this.abs, 'text');
  }

  // --- history -------------------------------------------------------------

  private _noteExternal(): void {
    this._undoRun = null;
    const value = this._lines.join('\n');
    const top = this._history[this._historyIndex];
    if (top && top.value === value) return;
    this._pushHistory({ value, caret: this._caret, anchor: this._anchor });
  }

  private _pushHistory(entry: HistoryEntry): void {
    this._history.length = this._historyIndex + 1;
    this._history.push(entry);
    if (this._history.length > UNDO_LIMIT) {
      this._history.splice(0, this._history.length - UNDO_LIMIT);
    }
    this._historyIndex = this._history.length - 1;
  }

  breakUndoRun(): void {
    this._undoRun = null;
  }

  get canUndo(): boolean {
    return this._historyIndex > 0;
  }

  get canRedo(): boolean {
    return this._historyIndex < this._history.length - 1;
  }

  undo(): void {
    this._syncProps();
    if (!this.canUndo) return;
    this._historyIndex--;
    this._applyHistory(this._history[this._historyIndex]);
  }

  redo(): void {
    this._syncProps();
    if (!this.canRedo) return;
    this._historyIndex++;
    this._applyHistory(this._history[this._historyIndex]);
  }

  private _applyHistory(entry: HistoryEntry): void {
    this._undoRun = null;
    this._goalX = null;
    this._applyLines(entry.value.split('\n'), null);
    this._caret = clampPos(this._lines, entry.caret);
    this._anchor = clampPos(this._lines, entry.anchor);
    this._afterEdit(entry.value);
  }

  // --- editing core --------------------------------------------------------

  private _selectionRange(): [Position, Position] {
    return [
      minPos(this._anchor, this._caret),
      maxPos(this._anchor, this._caret),
    ];
  }

  private _hasSelection(): boolean {
    return !posEqual(this._anchor, this._caret);
  }

  selectedText(): string {
    this._syncProps();
    const [a, b] = this._selectionRange();
    if (posEqual(a, b)) return '';
    if (a.line === b.line) return this._lines[a.line].slice(a.ch, b.ch);
    const parts = [this._lines[a.line].slice(a.ch)];
    for (let i = a.line + 1; i < b.line; i++) parts.push(this._lines[i]);
    parts.push(this._lines[b.line].slice(0, b.ch));
    return parts.join('\n');
  }

  /**
   * The one place text changes. Replaces `[from, to)` with `text`, moves the
   * caret to the end of the insertion, fires `onChange`, and manages undo —
   * `run` names a coalescable edit kind (`'type'`, `'delete-back'`,
   * `'delete-forward'`); anything else is its own undo step.
   */
  replaceRange(
    from: Position,
    to: Position,
    text: string,
    run: string | null = null,
  ): void {
    this._syncProps();
    if (this.props.readOnly) return;
    const a = clampPos(this._lines, minPos(from, to));
    const b = clampPos(this._lines, maxPos(from, to));
    const insert = String(text).replace(/\r\n?/g, '\n');
    const before = this._lines[a.line].slice(0, a.ch);
    const after = this._lines[b.line].slice(b.ch);
    const inserted = insert.split('\n');
    inserted[0] = before + inserted[0];
    const caretCh = inserted[inserted.length - 1].length;
    inserted[inserted.length - 1] += after;
    const newLines = this._lines.slice();
    newLines.splice(a.line, b.line - a.line + 1, ...inserted);

    const coalesce =
      run !== null &&
      run === this._undoRun &&
      this._historyIndex === this._history.length - 1;
    this._applyLines(newLines, {
      fromLine: a.line,
      removed: b.line - a.line + 1,
      inserted: inserted.length,
    });
    this._caret = clampPos(this._lines, {
      line: a.line + inserted.length - 1,
      ch: caretCh,
    });
    this._anchor = { ...this._caret };
    this._goalX = null;

    const value = this._lines.join('\n');
    if (coalesce) {
      this._history[this._historyIndex] = {
        value,
        caret: this._caret,
        anchor: this._anchor,
      };
    } else {
      this._pushHistory({ value, caret: this._caret, anchor: this._anchor });
    }
    this._undoRun = run;
    this._afterEdit(value);
  }

  private _applyLines(
    newLines: string[],
    edit: { fromLine: number; removed: number; inserted: number } | null,
  ): void {
    if (edit) {
      // A tokenizer keeps the array `setLines` handed it (that is the
      // contract in `Tokenizer`) and is told about changes through `edit()`
      // alone, so an incremental edit has to *mutate* the live array —
      // swapping in a fresh one would leave every engine tokenizing the
      // pre-edit text at the new line numbers, painting a split line with
      // its neighbour's colours. Callers only touch the edited span, so
      // splicing that span across reproduces `newLines` exactly.
      this._lines.splice(
        edit.fromLine,
        edit.removed,
        ...newLines.slice(edit.fromLine, edit.fromLine + edit.inserted),
      );
    } else {
      this._lines = newLines;
    }
    const tok = this._tokenizer();
    if (edit && tok) {
      tok.edit(edit);
      // line indices at and below the edit moved or changed; drop them
      for (const key of [...this._lineCache.keys()]) {
        if (key >= edit.fromLine) this._lineCache.delete(key);
      }
      if (edit.removed !== edit.inserted) this._lineCache.clear();
    } else {
      tok?.setLines(this._lines);
      this._lineCache.clear();
    }
  }

  private _afterEdit(value: string): void {
    this._synced = value;
    this._ensureCaretVisible();
    this._repaint();
    this._fire('onChange', value);
    this._fire('onSelectionChange', value);
  }

  insertText(text: string, run: string | null = null): void {
    const [a, b] = this._selectionRange();
    this.replaceRange(a, b, text, this._hasSelection() ? null : run);
  }

  moveCaret(pos: Position, extend: boolean): void {
    this._syncProps();
    this.breakUndoRun();
    this._caret = clampPos(this._lines, pos);
    if (!extend) this._anchor = { ...this._caret };
    this._ensureCaretVisible();
    this._repaint();
    this._fire('onSelectionChange', this.value);
  }

  select(anchor: Position, head: Position): void {
    this._syncProps();
    this.breakUndoRun();
    this._anchor = clampPos(this._lines, anchor);
    this._caret = clampPos(this._lines, head);
    this._ensureCaretVisible();
    this._repaint();
    this._fire('onSelectionChange', this.value);
  }

  selectAll(): void {
    const last = this._lines.length - 1;
    this.select(
      { line: 0, ch: 0 },
      { line: last, ch: this._lines[last].length },
    );
    this._ownPrimary();
  }

  // --- clipboard -----------------------------------------------------------

  private _clipboard(): ClipboardLike | null {
    const app = this.app as { clipboard?: ClipboardLike } | null | undefined;
    return app?.clipboard ?? null;
  }

  copySelection(selection = 'CLIPBOARD'): void {
    const text = this.selectedText();
    if (!text) return;
    this._clipboard()
      ?.write(text, { selection })
      .catch(() => {});
  }

  private _ownPrimary(): void {
    if (this._hasSelection()) this.copySelection('PRIMARY');
  }

  pasteFrom(selection = 'CLIPBOARD'): void {
    this._clipboard()
      ?.read({ selection })
      .then((text) => {
        if (!this.destroyed && typeof text === 'string' && text) {
          this.insertText(text);
        }
      })
      .catch(() => {});
  }

  // --- indentation & comments ---------------------------------------------

  private _indentUnit(): string {
    return this.props.insertSpaces === false
      ? '\t'
      : ' '.repeat(this._tabSize());
  }

  /** Tab with a multi-line selection (or dir < 0): shift the lines. */
  indentSelection(dir: 1 | -1): void {
    this._syncProps();
    if (this.props.readOnly) return;
    const [a, b] = this._selectionRange();
    const endLine = b.line > a.line && b.ch === 0 ? b.line - 1 : b.line;
    const unit = this._indentUnit();
    const size = this._tabSize();
    const newLines = this._lines.slice();
    for (let i = a.line; i <= endLine; i++) {
      const line = newLines[i];
      if (dir > 0) {
        if (line.length > 0) newLines[i] = unit + line;
      } else {
        if (line.startsWith('\t')) newLines[i] = line.slice(1);
        else {
          let strip = 0;
          while (strip < size && line.charAt(strip) === ' ') strip++;
          newLines[i] = line.slice(strip);
        }
      }
    }
    this._replaceAllPreservingSelection(newLines, a.line, endLine);
  }

  toggleLineComment(): void {
    this._syncProps();
    if (this.props.readOnly) return;
    const marker = this.language?.data?.lineComment;
    if (!marker) return;
    const [a, b] = this._selectionRange();
    const endLine = b.line > a.line && b.ch === 0 ? b.line - 1 : b.line;
    const targets: number[] = [];
    for (let i = a.line; i <= endLine; i++) {
      if (this._lines[i].trim().length > 0) targets.push(i);
    }
    if (targets.length === 0) return;
    const allCommented = targets.every((i) =>
      this._lines[i].trimStart().startsWith(marker),
    );
    const newLines = this._lines.slice();
    for (const i of targets) {
      const line = newLines[i];
      const indent = line.length - line.trimStart().length;
      if (allCommented) {
        const rest = line.slice(indent + marker.length);
        newLines[i] =
          line.slice(0, indent) + (rest.startsWith(' ') ? rest.slice(1) : rest);
      } else {
        newLines[i] = line.slice(0, indent) + marker + ' ' + line.slice(indent);
      }
    }
    this._replaceAllPreservingSelection(newLines, a.line, endLine);
  }

  /** Line-rewriting commands share this: one undo step, selection kept on
   * the same lines (clamped to their new lengths). */
  private _replaceAllPreservingSelection(
    newLines: string[],
    fromLine: number,
    toLine: number,
  ): void {
    const caret = this._caret;
    const anchor = this._anchor;
    this._applyLines(newLines, {
      fromLine,
      removed: toLine - fromLine + 1,
      inserted: toLine - fromLine + 1,
    });
    this._caret = clampPos(this._lines, caret);
    this._anchor = clampPos(this._lines, anchor);
    this._undoRun = null;
    const value = this._lines.join('\n');
    this._pushHistory({ value, caret: this._caret, anchor: this._anchor });
    this._afterEdit(value);
  }

  // --- input: keyboard -----------------------------------------------------

  /**
   * The editor's own key behaviour, run by the EventManager after the app's
   * `onKeyDown` handlers and not at all if one of them called
   * `preventDefault()` — so `<CodeEditor>`'s completion popup vetoes this
   * simply by consuming the key first, and so does an application handler.
   *
   * Tab is an ordinary key here, ahead of focus traversal, which is what
   * lets a bare `<codeeditor>` indent with it. Owning Tab means owning the
   * keyboard user's way out, hence the convention `docs/extending.md` asks
   * elements to converge on: **Escape arms one pass-through Tab**. Escape on
   * its own does nothing visible, the next Tab leaves, and the one after
   * that indents again.
   */
  override defaultKeyDown(ev: EditorKeyEvent): void {
    if (this.props.disabled) return;
    const k = ev.keysym;
    if (k === XK_ESCAPE) {
      this._tabEscapes = true;
      return;
    }
    if (k === XK_TAB && this._tabEscapes) {
      this._tabEscapes = false;
      return; // this one belongs to the focus cycle
    }
    this._tabEscapes = false;
    if (this.handleKeyDown(ev)) ev.preventDefault?.();
  }

  /**
   * The editor's key behaviour as a predicate — true when the key was
   * consumed. Kept apart from {@link defaultKeyDown} because the editing
   * model is also driven directly in tests and by an app that wires the raw
   * element itself; the default action is this plus the Tab/Escape bargain.
   */
  handleKeyDown(ev: EditorKeyEvent): boolean {
    this._syncProps();
    const previousNative = this._keyNative;
    this._keyNative = ev.nativeEvent ?? null;
    try {
      return this._editKey(ev);
    } finally {
      this._keyNative = previousNative;
    }
  }

  private _editKey(ev: EditorKeyEvent): boolean {
    const k = ev.keysym;
    const readOnly = Boolean(this.props.readOnly);
    const [a, b] = this._selectionRange();
    const hasSelection = this._hasSelection();
    const wordChars = this.language?.data?.wordChars ?? '';

    if (k === XK_RETURN || k === XK_KP_ENTER) {
      if (ev.ctrlKey) {
        this._fire('onSubmit', this.value);
        return true;
      }
      if (readOnly) return false;
      const lineText = this._lines[a.line];
      const indentMatch = /^[\t ]*/.exec(lineText)?.[0] ?? '';
      const indent = indentMatch.slice(0, Math.min(indentMatch.length, a.ch));
      const before = lineText.slice(0, a.ch);
      const rule = this.language?.data?.indentAfter;
      const deeper = rule ? rule.test(before) : false;
      const after = this._lines[b.line].slice(b.ch);
      if (deeper && /^[)\]}]/.test(after)) {
        // the caret sits between a fresh pair — `{|}` — so Enter opens it
        // the way every editor does: an indented line for the caret, the
        // closer on its own line at the old depth
        const unit = this._indentUnit();
        this.replaceRange(a, b, '\n' + indent + unit + '\n' + indent);
        this.moveCaret(
          { line: a.line + 1, ch: indent.length + unit.length },
          false,
        );
        return true;
      }
      this.insertText('\n' + indent + (deeper ? this._indentUnit() : ''));
      return true;
    }
    if (k === XK_BACKSPACE) {
      if (readOnly) return true;
      if (hasSelection) this.replaceRange(a, b, '');
      else if (ev.ctrlKey) {
        this.replaceRange(wordBoundary(this._lines, a, -1, wordChars), a, '');
      } else {
        const from = movePos(this._lines, a, -1);
        if (!posEqual(from, a)) this.replaceRange(from, a, '', 'delete-back');
      }
      return true;
    }
    if (k === XK_DELETE) {
      if (readOnly) return true;
      if (hasSelection) this.replaceRange(a, b, '');
      else if (ev.ctrlKey) {
        this.replaceRange(a, wordBoundary(this._lines, a, 1, wordChars), '');
      } else {
        const to = movePos(this._lines, a, 1);
        if (!posEqual(to, a)) this.replaceRange(a, to, '', 'delete-forward');
      }
      return true;
    }
    if (k === XK_LEFT || k === XK_RIGHT) {
      const dir = k === XK_LEFT ? -1 : 1;
      let target: Position;
      if (ev.ctrlKey) {
        target = wordBoundary(this._lines, this._caret, dir, wordChars);
      } else if (!ev.shiftKey && hasSelection) {
        target = dir < 0 ? a : b;
      } else {
        target = movePos(this._lines, this._caret, dir);
      }
      this.moveCaret(target, ev.shiftKey);
      if (ev.shiftKey) this._ownPrimary();
      return true;
    }
    if (k === XK_UP || k === XK_DOWN) {
      this._verticalMove(k === XK_UP ? -1 : 1, ev.shiftKey);
      return true;
    }
    if (k === XK_PAGE_UP || k === XK_PAGE_DOWN) {
      const content = this._contentRect();
      const page = Math.max(
        1,
        Math.floor(content.height / this._lineHeight()) - 1,
      );
      this._verticalMove((k === XK_PAGE_UP ? -1 : 1) * page, ev.shiftKey);
      return true;
    }
    if (k === XK_HOME) {
      if (ev.ctrlKey) {
        this.moveCaret({ line: 0, ch: 0 }, ev.shiftKey);
        return true;
      }
      const text = this._lines[this._caret.line];
      const first = text.length - text.trimStart().length;
      const ch = this._caret.ch === first ? 0 : first;
      this.moveCaret({ line: this._caret.line, ch }, ev.shiftKey);
      return true;
    }
    if (k === XK_END) {
      if (ev.ctrlKey) {
        const last = this._lines.length - 1;
        this.moveCaret(
          { line: last, ch: this._lines[last].length },
          ev.shiftKey,
        );
        return true;
      }
      this.moveCaret(
        { line: this._caret.line, ch: this._lines[this._caret.line].length },
        ev.shiftKey,
      );
      return true;
    }
    if (k === XK_TAB) {
      if (readOnly) return false;
      if (ev.shiftKey) {
        this.indentSelection(-1);
        return true;
      }
      if (a.line !== b.line) {
        this.indentSelection(1);
        return true;
      }
      if (this.props.insertSpaces === false) {
        this.insertText('\t', 'type');
        return true;
      }
      // spaces to the next tab stop, measured in display columns
      const map = tabMap(this._lines[a.line].slice(0, a.ch), this._tabSize());
      const col = map.display.length;
      const size = this._tabSize();
      this.insertText(' '.repeat(size - (col % size)), 'type');
      return true;
    }
    if (k === XK_ESCAPE) {
      return false; // the component owns Escape (completion, then Tab-out)
    }

    if (ev.ctrlKey) {
      const letter = ctrlChordLetter(ev);
      if (letter === 0x61 /* a */) {
        this.selectAll();
        return true;
      }
      if (letter === 0x63 /* c */) {
        this.copySelection();
        return true;
      }
      if (letter === 0x78 /* x */) {
        this.copySelection();
        if (!readOnly && hasSelection) this.replaceRange(a, b, '');
        return true;
      }
      if (letter === 0x76 /* v */) {
        if (!readOnly) this.pasteFrom();
        return true;
      }
      if (letter === 0x7a /* z */) {
        if (!readOnly) {
          if (ev.shiftKey) this.redo();
          else this.undo();
        }
        return true;
      }
      if (letter === 0x79 /* y */) {
        if (!readOnly) this.redo();
        return true;
      }
      if (letter === 0x2f /* / */) {
        this.toggleLineComment();
        return true;
      }
      return false;
    }

    if (
      !readOnly &&
      ev.codepoint != null &&
      ev.codepoint >= 0x20 &&
      ev.codepoint !== 0x7f
    ) {
      const ch = String.fromCodePoint(ev.codepoint);
      this.insertText(ch, 'type');
      if (/\s/.test(ch)) this.breakUndoRun();
      return true;
    }
    return false;
  }

  private _verticalMove(deltaLines: number, extend: boolean): void {
    if (this._goalX == null) this._goalX = this._caretX(this._caret);
    const line = Math.max(
      0,
      Math.min(this._lines.length - 1, this._caret.line + deltaLines),
    );
    if (line === this._caret.line) {
      // pressing against the document's edge: land on its corner, the way
      // every editor does
      const ch = deltaLines < 0 ? 0 : this._lines[line].length;
      this.moveCaret({ line, ch }, extend);
      if (extend) this._ownPrimary();
      return;
    }
    const entry = this._lineEntry(line);
    let ch = 0;
    if (entry.layout) {
      const cp = entry.layout.indexAt(this._goalX, 0);
      ch = entry.map.toRaw(cpToUtf16(entry.display, cp));
    }
    const goal = this._goalX; // moveCaret clears it; this move keeps it
    this.moveCaret({ line, ch }, extend);
    this._goalX = goal;
    if (extend) this._ownPrimary();
  }

  // --- input: mouse --------------------------------------------------------

  /**
   * A press: place the caret, start a drag-selection, or paste PRIMARY on
   * the middle button. The drag and release below are the continuation of
   * *this* press — core vetoes a gesture once, at its press, so an editor
   * whose `defaultMouseDown` never ran hears neither, and needs no
   * `dragging` flag to discover that.
   */
  override defaultMouseDown(ev: EditorMouseEvent): void {
    if (this.props.disabled) return;
    this.focus();
    if (this.handleMouseDown(ev)) ev.preventDefault?.();
  }

  override defaultMouseDrag(ev: EditorMouseEvent): void {
    if (this.handleMouseMove(ev)) ev.preventDefault?.();
  }

  override defaultMouseUp(): void {
    this.handleMouseUp();
  }

  handleMouseDown(ev: EditorMouseEvent): boolean {
    this._syncProps();
    this.breakUndoRun();
    const pos = this._posAt(ev.x, ev.y);
    if (ev.button === 3) {
      const [a, b] = this._selectionRange();
      if (comparePos(pos, a) < 0 || comparePos(pos, b) > 0) {
        this.moveCaret(pos, false);
      }
      return true;
    }
    if (ev.button === 2) {
      this.moveCaret(pos, false);
      if (!this.props.readOnly) this.pasteFrom('PRIMARY');
      return true;
    }
    const detail = ev.detail ?? 1;
    if (detail >= 3) {
      this._drag = 'line';
      this._dragOrigin = pos;
      this._selectLineRange(pos, pos);
    } else if (detail === 2) {
      this._drag = 'word';
      this._dragOrigin = pos;
      this._selectWordRange(pos, pos);
    } else {
      this._drag = 'char';
      this._dragOrigin = pos;
      this.moveCaret(pos, ev.shiftKey);
    }
    ev.capturePointer?.();
    return true;
  }

  handleMouseMove(ev: EditorMouseEvent): boolean {
    if (!this._drag) return false;
    const pos = this._posAt(ev.x, ev.y);
    if (this._drag === 'char') this.moveCaret(pos, true);
    else if (this._drag === 'word')
      this._selectWordRange(this._dragOrigin, pos);
    else this._selectLineRange(this._dragOrigin, pos);
    return true;
  }

  handleMouseUp(): boolean {
    if (!this._drag) return false;
    this._drag = null;
    this._ownPrimary();
    return true;
  }

  private _selectWordRange(origin: Position, to: Position): void {
    const extra = this.language?.data?.wordChars ?? '';
    const w1 = wordRangeAt(this._lines[origin.line], origin.ch, extra);
    const w2 = wordRangeAt(this._lines[to.line], to.ch, extra);
    const start = { line: origin.line, ch: w1.from };
    const end = { line: to.line, ch: w2.to };
    if (comparePos(to, origin) < 0) {
      this.select(
        { line: origin.line, ch: w1.to },
        { line: to.line, ch: w2.from },
      );
    } else {
      this.select(start, end);
    }
  }

  private _selectLineRange(origin: Position, to: Position): void {
    const [first, last] =
      to.line < origin.line ? [to.line, origin.line] : [origin.line, to.line];
    if (last + 1 < this._lines.length) {
      this.select({ line: first, ch: 0 }, { line: last + 1, ch: 0 });
    } else {
      this.select(
        { line: first, ch: 0 },
        { line: last, ch: this._lines[last].length },
      );
    }
  }

  // --- focus ---------------------------------------------------------------

  // `focus()`/`blur()` come from `Node` — declared as well as implemented
  // since react-x11#267, so the forwarding shims this file used to carry are
  // gone. `CodeEditorHandle` keeps promising `void`: the base returns `this`,
  // and widening the handle to the node type would drag the class's nominal
  // type into the exported props (see the note on `CodeEditorHandle`).

  /** Focus is a state, not an event: `onFocus` is where the app hears about
   * it, and this is where the caret starts blinking. The timer is also
   * released in `destroySubtree`, because a node that unmounts while focused
   * is forgotten rather than blurred and this would never run. */
  override defaultFocus(): void {
    this.handleFocus();
  }

  override defaultBlur(): void {
    this.handleBlur();
  }

  handleFocus(): void {
    this._focused = true;
    this._caretOn = true;
    if (this._blinkTimer == null) {
      this._blinkTimer = startInterval(() => {
        this._caretOn = !this._caretOn;
        this.root?.invalidate(false, this.abs, 'text');
      }, CARET_BLINK_MS);
    }
    this._repaint();
  }

  handleBlur(): void {
    this._focused = false;
    this.breakUndoRun();
    stopInterval(this._blinkTimer);
    this._blinkTimer = null;
    this._repaint();
  }

  // --- lifecycle -----------------------------------------------------------

  override applyProps(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): void {
    const before = prevProps ?? this.props;
    super.applyProps(nextProps, prevProps);
    if (nextProps.value != null) this._syncProps();
    if (nextProps.language !== before.language) {
      this._tokenizer(); // re-resolves against the new props
      this._repaint();
    }
    if (nextProps.rows !== before.rows) this.invalidateMeasure('props');
    if (
      nextProps.tokenStyles !== before.tokenStyles ||
      nextProps.diagnostics !== before.diagnostics ||
      nextProps.tabSize !== before.tabSize ||
      nextProps.lineNumbers !== before.lineNumbers
    ) {
      this._lineCache.clear();
      this._repaint();
    }
  }

  override destroySubtree(): void {
    stopInterval(this._blinkTimer);
    this._blinkTimer = null;
    this._tok?.dispose?.();
    this._tok = null;
    super.destroySubtree();
  }

  // --- painting ------------------------------------------------------------

  override paint(ctx: Context2D): void {
    super.paint(ctx);
    this._syncProps();
    this._metrics();
    const c = ctx as {
      fillStyle?: unknown;
      fillRect?(x: number, y: number, w: number, h: number): void;
      save?(): void;
      restore?(): void;
      beginPath?(): void;
      rect?(x: number, y: number, w: number, h: number): void;
      clip?(): void;
      moveTo?(x: number, y: number): void;
      lineTo?(x: number, y: number): void;
      stroke?(): void;
      strokeStyle?: unknown;
      lineWidth?: number;
    };
    if (typeof c.fillRect !== 'function') return; // mock backend: geometry only
    const content = this._contentRect();
    if (content.width <= 0 || content.height <= 0) return;
    const lineH = this._lineH;
    const gutterW = this._gutterWidth();
    const textX = content.x + gutterW - this._scrollX;
    const props = this.props as unknown as CodeEditorProps;
    const styles = this._textStyle();
    const baseColor = styles.color as string;

    const canClip =
      typeof c.save === 'function' &&
      typeof c.beginPath === 'function' &&
      typeof c.rect === 'function' &&
      typeof c.clip === 'function';
    const clipTo = (x: number, y: number, w: number, h: number): boolean => {
      if (!canClip) return false;
      c.save!();
      c.beginPath!();
      c.rect!(x, y, w, h);
      c.clip!();
      return true;
    };
    const dark = this._onDark();

    const first = Math.max(0, Math.floor(this._scrollY / lineH));
    const last = Math.min(
      this._lines.length - 1,
      Math.ceil((this._scrollY + content.height) / lineH),
    );
    const lineY = (i: number): number => content.y + i * lineH - this._scrollY;

    // Everything the editor draws — gutter included — stays inside the
    // content box. The first and last visible rows are partial when
    // scrolled, and without this their overhang (up to a line each way)
    // walks into the padding and past it.
    const outerClip = clipTo(
      content.x,
      content.y,
      content.width,
      content.height,
    );

    // gutter background
    if (gutterW > 0 && props.gutterBackground) {
      c.fillStyle = this._resolveColor(props.gutterBackground) ?? '#00000008';
      c.fillRect(content.x, content.y, gutterW, content.height);
    }

    // the text region clips one step narrower, so a horizontally scrolled
    // line cannot run underneath the line numbers
    const textClip = clipTo(
      content.x + gutterW,
      content.y,
      content.width - gutterW,
      content.height,
    );

    // active line
    if (
      props.activeLine &&
      this._focused &&
      !this._hasSelection() &&
      this._caret.line >= first &&
      this._caret.line <= last
    ) {
      c.fillStyle =
        this._resolveColor(props.activeLineColor) ??
        (dark ? 'rgba(255,255,255,0.06)' : 'rgba(120,140,180,0.10)');
      c.fillRect(
        content.x + gutterW,
        lineY(this._caret.line),
        content.width - gutterW,
        lineH,
      );
    }

    // selection bands
    if (this._hasSelection()) {
      const [a, b] = this._selectionRange();
      c.fillStyle =
        this._resolveColor(props.selectionColor) ??
        (dark ? 'rgba(82,139,255,0.35)' : 'rgba(80,140,255,0.28)');
      for (let i = Math.max(a.line, first); i <= Math.min(b.line, last); i++) {
        const entry = this._lineEntry(i);
        const startX =
          i === a.line && entry.layout
            ? this._caretX({ line: i, ch: a.ch })
            : 0;
        const endX =
          i === b.line
            ? this._caretX({ line: i, ch: b.ch })
            : (entry.layout?.width ?? 0) + this._charW * 0.5; // the newline
        c.fillRect(textX + startX, lineY(i), Math.max(2, endX - startX), lineH);
      }
    }

    // matching brackets
    if (props.matchBrackets !== false && this._focused) {
      const match = this._findBracketMatch();
      if (match) {
        c.fillStyle =
          this._resolveColor(props.matchingBracketColor) ??
          (dark ? 'rgba(90,190,130,0.35)' : 'rgba(80,180,120,0.30)');
        for (const pos of match) {
          if (pos.line < first || pos.line > last) continue;
          const x0 = this._caretX(pos);
          const x1 = this._caretX({ line: pos.line, ch: pos.ch + 1 });
          c.fillRect(textX + x0, lineY(pos.line), Math.max(1, x1 - x0), lineH);
        }
      }
    }

    // text
    const empty =
      this._lines.length === 1 &&
      this._lines[0].length === 0 &&
      props.placeholder;
    if (empty) {
      const fonts = this._fonts();
      if (fonts) {
        const layout = fonts.layout(
          [
            {
              text: String(props.placeholder),
              color:
                this._resolveColor(props.placeholderColor) ??
                this._themeColor('dim') ??
                '#9aa0a6',
            },
          ],
          styles,
        );
        layout.draw(ctx, textX, lineY(0) + (lineH - layout.height) / 2);
      }
    } else {
      for (let i = first; i <= last; i++) {
        const entry = this._lineEntry(i);
        entry.layout?.draw(
          ctx,
          textX,
          lineY(i) + (lineH - (entry.layout.height || lineH)) / 2,
        );
      }
    }

    // diagnostics
    const diagnostics = props.diagnostics ?? [];
    for (const d of diagnostics) {
      const color = SEVERITY_COLORS[d.severity ?? 'error'] ?? '#e5484d';
      const from = clampPos(this._lines, d.from);
      const to = clampPos(this._lines, maxPos(d.from, d.to));
      for (
        let i = Math.max(from.line, first);
        i <= Math.min(to.line, last);
        i++
      ) {
        const x0 = i === from.line ? this._caretX({ line: i, ch: from.ch }) : 0;
        const lineText = this._lines[i];
        const x1 =
          i === to.line
            ? this._caretX({ line: i, ch: to.ch })
            : this._caretX({ line: i, ch: lineText.length });
        // hug the glyphs, not the line box: the text is centred in its
        // band, so a squiggle at the band's bottom floats visibly below
        // short text — measure where the drawn layout actually ends
        const entry = this._lineEntry(i);
        const glyphBottom =
          lineY(i) +
          (lineH - (entry.layout?.height || lineH)) / 2 +
          (entry.layout?.height || lineH);
        const y = Math.min(lineY(i) + lineH - 2, glyphBottom - 1);
        const width = Math.max(this._charW * 0.6, x1 - x0);
        if (
          typeof c.beginPath === 'function' &&
          typeof c.moveTo === 'function' &&
          typeof c.lineTo === 'function' &&
          typeof c.stroke === 'function'
        ) {
          c.beginPath();
          const step = 4;
          let up = true;
          for (let x = 0; x <= width; x += step) {
            const px = textX + x0 + x;
            const py = y + (up ? 0 : 2);
            if (x === 0) c.moveTo(px, py);
            else c.lineTo(px, py);
            up = !up;
          }
          c.strokeStyle = color;
          c.lineWidth = 1;
          c.stroke();
        } else {
          c.fillStyle = color;
          c.fillRect(textX + x0, y + 1, width, 1);
        }
      }
    }

    // caret — 2px, in the (theme-resolved) text colour
    if (this._focused && this._caretOn) {
      const x = this._caretX(this._caret);
      c.fillStyle = this._resolveColor(props.caretColor) ?? baseColor;
      c.fillRect(
        Math.round(textX + x),
        lineY(this._caret.line) + 1,
        2,
        lineH - 2,
      );
    }

    if (textClip) c.restore!();

    // gutter numbers: inside the content clip, outside the text clip
    if (gutterW > 0) {
      const fonts = this._fonts();
      if (fonts) {
        const dim =
          this._resolveColor(props.gutterColor) ??
          this._themeColor('dim') ??
          '#9aa0a6';
        for (let i = first; i <= last; i++) {
          const active = i === this._caret.line;
          const layout = fonts.layout(
            [
              {
                text: String(i + 1),
                color: active ? baseColor : dim,
              },
            ],
            styles,
          );
          layout.draw(
            ctx,
            content.x + gutterW - GUTTER_PAD - layout.width,
            lineY(i) + (lineH - layout.height) / 2,
          );
        }
      }
    }

    // scroll thumbs — minimal, panel-style
    const maxY = this._maxScrollY();
    if (maxY > 0) {
      const trackH = content.height;
      const thumbH = Math.max(
        24,
        (trackH * trackH) / (this._lines.length * lineH),
      );
      const yOff = (this._scrollY / maxY) * (trackH - thumbH);
      c.fillStyle = 'rgba(128,128,128,0.35)';
      c.fillRect(content.x + content.width - 4, content.y + yOff, 3, thumbH);
    }
    const maxX = this._maxScrollX();
    if (maxX > 0) {
      const textW = content.width - gutterW;
      const trackW = textW;
      const thumbW = Math.max(
        24,
        (trackW * trackW) / (this._widest + CARET_MARGIN),
      );
      const xOff = (this._scrollX / maxX) * (trackW - thumbW);
      c.fillStyle = 'rgba(128,128,128,0.35)';
      c.fillRect(
        content.x + gutterW + xOff,
        content.y + content.height - 4,
        thumbW,
        3,
      );
    }

    if (outerClip) c.restore!();
  }

  /** The bracket pair to highlight: the caret sits beside one of them. */
  private _findBracketMatch(): [Position, Position] | null {
    const pos = this._caret;
    const line = this._lines[pos.line];
    const before = pos.ch > 0 ? line.charAt(pos.ch - 1) : '';
    const after = pos.ch < line.length ? line.charAt(pos.ch) : '';
    let at: Position;
    let ch: string;
    if (after in BRACKETS) {
      at = { line: pos.line, ch: pos.ch };
      ch = after;
    } else if (before in BRACKETS) {
      at = { line: pos.line, ch: pos.ch - 1 };
      ch = before;
    } else {
      return null;
    }
    if (this._isOpaqueAt(at)) return null;
    const { match, dir } = BRACKETS[ch];
    let depth = 0;
    let scanned = 0;
    let l = at.line;
    let i = at.ch;
    while (l >= 0 && l < this._lines.length && scanned < MATCH_SCAN_LIMIT) {
      const text = this._lines[l];
      while (dir > 0 ? i < text.length : i >= 0) {
        const cur = text.charAt(i);
        if (
          (cur === ch || cur === match) &&
          !this._isOpaqueAt({ line: l, ch: i })
        ) {
          if (cur === ch) depth++;
          else {
            depth--;
            if (depth === 0) return [at, { line: l, ch: i }];
          }
        }
        i += dir;
        scanned++;
      }
      l += dir;
      if (l >= 0 && l < this._lines.length) {
        i = dir > 0 ? 0 : this._lines[l].length - 1;
      }
    }
    return null;
  }

  private _isOpaqueAt(pos: Position): boolean {
    const tokens = this._tokenizer()?.lineTokens(pos.line);
    if (!tokens) return false;
    for (const t of tokens) {
      if (t.from <= pos.ch && pos.ch < t.to) return OPAQUE_TOKENS.has(t.type);
      if (t.from > pos.ch) break;
    }
    return false;
  }
}
