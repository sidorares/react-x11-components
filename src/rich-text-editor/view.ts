// The editor view: ProseMirror's `EditorView` contract, drawn with react-x11.
//
// ProseMirror splits an editor in two. The *state* — the document, the
// selection, the plugins' state fields and every transformation of them — is
// plain data and runs anywhere. The *view* turns it into DOM, reads the DOM's
// geometry and events back, and is the only half that assumes a browser. So
// this file is a second view: the same contract, the same props, the same
// plugin hooks, over react-x11 elements instead of a DOM. A plugin written
// for ProseMirror — prosemirror-history, -inputrules, -keymap, -commands,
// y-prosemirror's sync — is written against the state and that contract, and
// runs here unchanged. What it cannot have is `view.dom` as a DOM node; the
// ledger of what is and is not answered is in docs/prd-rich-text-editor.md.
//
// How the work divides:
//
// - **dispatch → state → keys → render.** A transaction is applied, the
//   block keys are carried through its mapping (`./keys.ts`), and React is
//   asked to render only when the document changed. A selection change
//   renders nothing: the caret and the selection bands belong to the text
//   nodes and are set from here (`syncBlock`).
// - **Geometry is asked of the nodes.** `posAtCoords`, `coordsAtPos`, line
//   motion and hit testing read the mounted text blocks' layouts through
//   core's text accessors — device pixels, divided on the way out, because a
//   pointer event and everything ProseMirror's API speaks are logical pixels
//   (react-x11 docs/scale.md; AGENTS.md "know which unit you are in").
// - **What a browser does natively is done here**: caret motion, deleting a
//   character or a word, inserting typed text, the clipboard. It runs only
//   when no plugin's `handleKeyDown` claimed the key first — the same order a
//   contenteditable gives ProseMirror.
import { splitBlock } from 'prosemirror-commands';
import { redo, redoDepth, undo, undoDepth } from 'prosemirror-history';
import type { Node as PMNode, Slice } from 'prosemirror-model';
import {
  AllSelection,
  NodeSelection,
  Selection,
  TextSelection,
} from 'prosemirror-state';
import type {
  Command,
  EditorState,
  PluginView,
  Transaction,
} from 'prosemirror-state';
import { Mapping } from 'prosemirror-transform';
import type {
  Decoration,
  DecorationSource,
  DirectEditorProps,
  EditorProps,
  EditorView,
} from 'prosemirror-view';
import { closeEditMenu, editMenuOpen, openEditMenu } from 'react-x11';
import type {
  Clipboard,
  DrawnNode,
  MouseEvent as X11MouseEvent,
  ScrollableNode,
} from 'react-x11';
import { CARET_BLINK_MS } from 'react-x11/node';
import type { A11yTextState } from 'react-x11/node';

import { startInterval, stopInterval } from '../code-language/timers.js';
import type { TimerId } from '../code-language/timers.js';
import { afterLayout, cancelAfterLayout } from '../internal/timers.js';
import type { LayoutTick } from '../internal/timers.js';
import { scaleOf } from '../internal/units.js';
import { parseFromClipboard, serializeForClipboard } from './clipboard.js';
import type { ClipboardView } from './clipboard.js';
import type { InlineDecoration, InlineWidget, RunStyle } from './inline.js';
import { BlockKeys } from './keys.js';
import { primaryModifierOf, toDomKeyEvent } from './keymap.js';
import type { DomKeyEvent, PrimaryModifier } from './keymap.js';
import { styleFromCSS } from './look.js';
import type { EditorHost, EditorTextNode, RichEditorNode } from './nodes.js';
import { KeyedStore } from './store.js';

type KeyEvent = Parameters<EditorHost['keyDown']>[0];
type ComposeEvent = Parameters<EditorHost['composition']>[0];

/** ProseMirror's direct props, less the state — the view holds that. */
export type ViewProps = Omit<DirectEditorProps, 'state'>;

/** What the component tells the view that is not ProseMirror's to say. */
export interface ViewConfig {
  /** The document changed: React has blocks to render. */
  onRender(): void;
  /** Every state change, with the transactions that made it. */
  onUpdate?(prev: EditorState, transactions: readonly Transaction[]): void;
  onFocusChange?(focused: boolean): void;
  clipboard: Clipboard | null;
  /** Shown, muted, in an empty document. */
  placeholder?: string;
  colors: {
    selection: string;
    selectionBlurred: string;
    caret: string;
    placeholder: string;
    preedit: string;
  };
  /** How a decoration's `class` looks — the one part of a DOM decoration
   *  this view cannot read off the decoration itself. */
  decorationClasses?: Readonly<Record<string, RunStyle>>;
}

/** One block's decorations, as its renderer reads them. `sig` is what makes
 *  "the same decorations" the same object, so a block whose decorations did
 *  not move does not re-render. */
export interface BlockDecorations {
  inline: readonly InlineDecoration[];
  widgets: readonly InlineWidget[];
  /** A node decoration's look for the block's own box. */
  box: { background?: string; border?: string } | null;
  sig: string;
}

export type MoveUnit =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'wordBackward'
  | 'wordForward'
  | 'lineStart'
  | 'lineEnd'
  | 'docStart'
  | 'docEnd'
  | 'pageUp'
  | 'pageDown';

interface Drag {
  anchor: number;
  unit: 'char' | 'word' | 'block';
  origin: { from: number; to: number };
}

interface Coords {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Hit {
  pos: number;
  inside: number;
  atom: boolean;
}

const XK_TAB = 0xff09;
const XK_ISO_LEFT_TAB = 0xfe20;
const XK_ESCAPE = 0xff1b;

// --- text helpers ----------------------------------------------------------

/** A textblock's text with every inline leaf as one character — so offsets
 *  into it are ProseMirror's offsets into the block. */
function blockText(node: PMNode): string {
  return node.textBetween(0, node.content.size, undefined, '￼');
}

let graphemes: Intl.Segmenter | null = null;
let words: Intl.Segmenter | null = null;

function segmenter(kind: 'grapheme' | 'word'): Intl.Segmenter | null {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function')
    return null;
  if (kind === 'grapheme')
    return (graphemes ??= new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    }));
  return (words ??= new Intl.Segmenter(undefined, { granularity: 'word' }));
}

/** One user-perceived character from `offset`: a flag, a family emoji, an
 *  accent on its letter — never half of any of them. */
function graphemeStep(text: string, offset: number, dir: -1 | 1): number {
  const seg = segmenter('grapheme');
  if (seg) {
    if (dir > 0) {
      const s = seg.segment(text).containing(offset);
      return s ? s.index + s.segment.length : text.length;
    }
    if (offset <= 0) return 0;
    const s = seg.segment(text).containing(offset - 1);
    return s ? s.index : 0;
  }
  if (dir > 0)
    return Math.min(
      text.length,
      offset + ((text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1),
    );
  const low = text.charCodeAt(offset - 1);
  return Math.max(0, offset - (low >= 0xdc00 && low <= 0xdfff ? 2 : 1));
}

interface WordSeg {
  start: number;
  end: number;
  word: boolean;
}

function wordSegments(text: string): WordSeg[] {
  const seg = segmenter('word');
  if (seg) {
    return [...seg.segment(text)].map((s) => ({
      start: s.index,
      end: s.index + s.segment.length,
      word: !!s.isWordLike,
    }));
  }
  const out: WordSeg[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu)) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      word: /[\p{L}\p{N}_]/u.test(m[0]),
    });
  }
  return out;
}

/** Ctrl+Arrow: over any run of spaces and punctuation, then the word. */
function wordStep(text: string, offset: number, dir: -1 | 1): number {
  const segs = wordSegments(text);
  if (dir < 0) {
    let i = segs.length - 1;
    while (i >= 0 && segs[i].start >= offset) i--;
    while (i >= 0 && !segs[i].word) i--;
    return i >= 0 ? segs[i].start : 0;
  }
  let i = 0;
  while (i < segs.length && segs[i].end <= offset) i++;
  while (i < segs.length && !segs[i].word) i++;
  return i < segs.length ? segs[i].end : text.length;
}

/** The word a double click lands on, or the run of spaces or punctuation
 *  it lands on when that is what is there. */
function wordRange(text: string, offset: number): [number, number] {
  const segs = wordSegments(text);
  const at = offset < text.length ? offset : offset - 1;
  for (const s of segs)
    if (at >= s.start && at < s.end) return [s.start, s.end];
  return [offset, offset];
}

function isEmptyDoc(doc: PMNode): boolean {
  return (
    doc.childCount === 1 &&
    !!doc.firstChild?.isTextblock &&
    doc.firstChild.content.size === 0
  );
}

/** What an assistive technology reads a leaf as. */
function leafText(node: PMNode): string {
  const own = node.type.spec.leafText?.(node);
  if (own !== undefined) return own;
  const name = node.type.name;
  if (name === 'hard_break' || name === 'hardBreak') return '\n';
  if (name === 'image') return String(node.attrs.alt ?? '') || '￼';
  return '￼';
}

function mappingOf(trs: readonly Transaction[], doc: PMNode): Mapping | null {
  if (trs.length === 0 || trs[0].before !== doc) return null;
  const mapping = new Mapping();
  for (const tr of trs) mapping.appendMapping(tr.mapping);
  return mapping;
}

function collectDecorations(source: DecorationSource, out: Decoration[]): void {
  const s = source as unknown as {
    find?: () => Decoration[];
    members?: readonly DecorationSource[];
  };
  if (typeof s.find === 'function') out.push(...s.find());
  else if (Array.isArray(s.members))
    for (const m of s.members) collectDecorations(m, out);
}

function sliceSingleNode(slice: Slice): PMNode | null {
  return slice.openStart === 0 &&
    slice.openEnd === 0 &&
    slice.content.childCount === 1
    ? slice.content.firstChild
    : null;
}

// --- the view ----------------------------------------------------------------

export class RichEditorView implements EditorHost, ClipboardView {
  state: EditorState;
  private direct: ViewProps;
  private config: ViewConfig;
  /** The block keys React renders under — see `./keys.ts`. */
  readonly keys: BlockKeys;
  /** Per-block decorations, for the block's own renderer to subscribe to. */
  readonly decorations = new KeyedStore<BlockDecorations>();
  /** Which block a node selection has selected, for its renderer. */
  readonly selectedBlocks = new KeyedStore<boolean>();

  private root: RichEditorNode | null = null;
  private texts = new Map<string, EditorTextNode>();
  /** Block atoms — a rule, an image block, an atom node view — by key: what
   *  a press can land on that is not text. */
  private boxes = new Map<string, DrawnNode>();
  private scroller: ScrollableNode | null = null;
  private pluginViews: PluginView[] = [];
  private focused = false;
  private preedit: string | null = null;
  private goalX: number | null = null;
  private keepGoal = false;
  private drag: Drag | null = null;
  private dragScroll: TimerId = null;
  private pointer: { x: number; y: number } | null = null;
  private tabEscapes = false;
  /** Above zero while user input is being handled — a read-only editor
   *  drops the document changes that input would make, and only those. */
  private userInput = 0;
  private pending: Transaction[] = [];
  private caretKey: string | null = null;
  private bandKeys = new Set<string>();
  private selectedKey: string | null = null;
  private blinkTimer: TimerId = null;
  private scrollTick: LayoutTick = null;
  private lastCopy: { text: string; slice: Slice } | null = null;
  private a11yCache: { state: EditorState; value: A11yTextState } | null = null;
  private destroyedFlag = false;
  private primary: PrimaryModifier = 'ctrl';

  constructor(state: EditorState, props: ViewProps, config: ViewConfig) {
    this.state = state;
    this.direct = props;
    this.config = config;
    this.keys = new BlockKeys(state.doc);
    this.recomputeDecorations();
    this.createPluginViews();
  }

  // --- the EditorView surface ----------------------------------------------

  /** This object, typed as what a plugin's callbacks are handed. */
  get asEditorView(): EditorView {
    return this as unknown as EditorView;
  }

  get props(): DirectEditorProps {
    return { ...this.direct, state: this.state } as DirectEditorProps;
  }

  get editable(): boolean {
    return !this.someProp('editable', (f) => f(this.state) === false);
  }

  get composing(): boolean {
    return this.preedit !== null;
  }

  get isDestroyed(): boolean {
    return this.destroyedFlag;
  }

  /** The root element — not a DOM node, which is the one thing a plugin
   *  written for a browser may not be given here. */
  get dom(): DrawnNode | null {
    return this.root as unknown as DrawnNode | null;
  }

  get dragging(): null {
    return null;
  }

  /** The backend's shortcut modifier — Cmd on macOS, Ctrl on X11. */
  get primaryModifier(): PrimaryModifier {
    return this.primary;
  }

  hasFocus(): boolean {
    return this.focused;
  }

  focus(): void {
    this.root?.focus();
  }

  setProps(props: Partial<ViewProps>): void {
    this.update({ ...this.direct, ...props });
  }

  update(props: ViewProps): void {
    const pluginsChanged = props.plugins !== this.direct.plugins;
    this.direct = props;
    if (pluginsChanged) this.resetPluginViews();
    this.recomputeDecorations();
    this.syncSelection();
  }

  /** The component's half: callbacks, the clipboard, the colours. Called on
   *  every render, so it only acts on what changed. */
  configure(config: ViewConfig): void {
    const prev = this.config;
    this.config = config;
    const c = config.colors;
    const p = prev.colors;
    const redraw =
      config.placeholder !== prev.placeholder ||
      config.decorationClasses !== prev.decorationClasses ||
      c.placeholder !== p.placeholder ||
      c.preedit !== p.preedit;
    if (redraw) this.recomputeDecorations();
    if (
      redraw ||
      c.selection !== p.selection ||
      c.selectionBlurred !== p.selectionBlurred ||
      c.caret !== p.caret
    ) {
      this.syncSelection();
    }
  }

  /**
   * ProseMirror's prop lookup, in its order: the view's own props, then its
   * direct plugins, then the state's plugins — the first to give a truthy
   * answer wins.
   */
  someProp<K extends keyof EditorProps, R>(
    name: K,
    f: (value: NonNullable<EditorProps[K]>) => R,
  ): R | undefined {
    const own = this.direct[name];
    if (own != null) {
      const r = f(own as NonNullable<EditorProps[K]>);
      if (r) return r;
    }
    for (const plugin of this.direct.plugins ?? []) {
      const prop = plugin.props[name];
      if (prop != null) {
        const r = f(prop as NonNullable<EditorProps[K]>);
        if (r) return r;
      }
    }
    for (const plugin of this.state.plugins) {
      const prop = plugin.props[name];
      if (prop != null) {
        const r = f(prop as NonNullable<EditorProps[K]>);
        if (r) return r;
      }
    }
    return undefined;
  }

  readonly dispatch = (tr: Transaction): void => {
    if (this.destroyedFlag) return;
    if (this.userInput > 0 && tr.docChanged && !this.editable) return;
    const own = this.direct.dispatchTransaction;
    if (own) {
      // the app applies it, and hands the state back through updateState
      this.pending.push(tr);
      own.call(this.asEditorView, tr);
      return;
    }
    const { state, transactions } = this.state.applyTransaction(tr);
    this.apply(state, transactions);
  };

  /** Replace the state — what an app owning it calls with the result of a
   *  transaction this view dispatched. */
  updateState(state: EditorState): void {
    const trs = this.pending;
    this.pending = [];
    this.apply(state, trs);
  }

  /** Run a command against the current state. */
  run(command: Command): boolean {
    return command(this.state, this.dispatch, this.asEditorView);
  }

  private apply(state: EditorState, trs: readonly Transaction[]): void {
    const prev = this.state;
    if (state === prev) return;
    this.state = state;
    const docChanged = prev.doc !== state.doc;
    if (docChanged) this.keys.update(state.doc, mappingOf(trs, prev.doc));
    if (prev.plugins !== state.plugins) this.resetPluginViews();
    if (!this.keepGoal) this.goalX = null;
    this.keepGoal = false;
    this.recomputeDecorations();
    if (docChanged) this.config.onRender();
    this.syncSelection();
    for (const view of this.pluginViews) view.update?.(this.asEditorView, prev);
    if (
      docChanged &&
      this.root &&
      editMenuOpen(this.root as unknown as DrawnNode)
    ) {
      closeEditMenu(this.root as unknown as DrawnNode);
    }
    this.a11yCache = null;
    this.root?.notifyA11yTextChanged();
    this.config.onUpdate?.(prev, trs);
    if (trs.some((tr) => tr.scrolledIntoView)) this.scheduleScroll();
  }

  private createPluginViews(): void {
    for (const plugin of [
      ...(this.direct.plugins ?? []),
      ...this.state.plugins,
    ]) {
      const make = plugin.spec.view;
      if (make) this.pluginViews.push(make(this.asEditorView));
    }
  }

  private resetPluginViews(): void {
    for (const view of this.pluginViews) view.destroy?.();
    this.pluginViews = [];
    this.createPluginViews();
  }

  destroy(): void {
    if (this.destroyedFlag) return;
    this.destroyedFlag = true;
    for (const view of this.pluginViews) view.destroy?.();
    this.pluginViews = [];
    this.stopBlink();
    stopInterval(this.dragScroll);
    this.dragScroll = null;
    cancelAfterLayout(this.scrollTick);
  }

  // --- the elements ----------------------------------------------------------

  attachRoot(node: RichEditorNode): void {
    this.root = node;
    this.primary = primaryModifierOf(node.app);
  }

  detachRoot(node: RichEditorNode): void {
    if (this.root !== node) return;
    this.root = null;
    this.stopBlink();
  }

  attachText(key: string, node: EditorTextNode): void {
    this.texts.set(key, node);
    this.syncBlock(key);
  }

  detachText(key: string, node: EditorTextNode): void {
    if (this.texts.get(key) !== node) return;
    this.texts.delete(key);
    this.bandKeys.delete(key);
    if (this.caretKey === key) {
      this.caretKey = null;
      this.stopBlink();
    }
  }

  textUpdated(key: string, node: EditorTextNode): void {
    if (this.texts.get(key) === node) this.syncBlock(key);
  }

  /** A block atom's box, or null when it unmounts. */
  attachBox(key: string, node: DrawnNode | null): void {
    if (node) this.boxes.set(key, node);
    else this.boxes.delete(key);
  }

  /** The scrolling viewport the document is in. */
  attachScroller(node: ScrollableNode | null): void {
    this.scroller = node;
  }

  // --- selection, painted ------------------------------------------------------

  private selectionColor(): string {
    const menu = this.root && editMenuOpen(this.root as unknown as DrawnNode);
    return this.focused || menu
      ? this.config.colors.selection
      : this.config.colors.selectionBlurred;
  }

  /** The block the caret is drawn in, if there is one to draw. */
  private caretBlock(): string | null {
    const sel = this.state.selection;
    if (!this.focused || !sel.empty || !(sel instanceof TextSelection))
      return null;
    const $head = sel.$head;
    if (!$head.parent.isTextblock || $head.depth === 0) return null;
    return this.keys.keyAt($head.before()) ?? null;
  }

  /**
   * Place whatever of the selection falls in one block: its band, and the
   * caret if the caret is there. A block whose element still shows an older
   * node is skipped — the render bringing the new one calls back.
   */
  private syncBlock(key: string): void {
    const text = this.texts.get(key);
    const node = this.keys.nodeOf(key);
    const pos = this.keys.posOf(key);
    if (!text || !node || pos === undefined) return;
    const shown = text.props.node;
    if (shown !== undefined && shown !== node) return;
    const map = text.map;
    if (!map) return;
    const sel = this.state.selection;
    const start = pos + 1;
    const end = start + node.content.size;

    let band: { start: number; end: number } | null = null;
    const blockSelected = sel instanceof NodeSelection && !sel.node.isInline;
    if (!sel.empty && !blockSelected && sel.from <= end && sel.to >= start) {
      const a = map.toDisplay(Math.max(sel.from, start) - start);
      const b = map.toDisplay(Math.min(sel.to, end) - start);
      if (b > a) band = { start: a, end: b };
      else if (sel.from < start && sel.to > end)
        band = { start: 0, end: map.length }; // an empty block the selection runs through
    }
    text.setBand(band, this.selectionColor());
    if (band) this.bandKeys.add(key);
    else this.bandKeys.delete(key);

    if (this.caretBlock() === key) {
      text.setCaret(map.toDisplay(sel.head - start), this.config.colors.caret);
      this.caretKey = key;
      this.restartBlink();
    } else {
      text.setCaret(null, '');
      if (this.caretKey === key) {
        this.caretKey = null;
        this.stopBlink();
      }
    }
  }

  /** Place the whole selection: every block it touches, every block it
   *  touched before, the caret, and a selected block's highlight. */
  syncSelection(): void {
    const keys = new Set<string>(this.bandKeys);
    if (this.caretKey) keys.add(this.caretKey);
    const sel = this.state.selection;
    if (!sel.empty) {
      this.state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
        if (!node.isTextblock) return true;
        const key = this.keys.keyAt(pos);
        if (key) keys.add(key);
        return false;
      });
    }
    const caret = this.caretBlock();
    if (caret) keys.add(caret);
    for (const key of keys) this.syncBlock(key);
    if (!caret && this.caretKey) {
      this.texts.get(this.caretKey)?.setCaret(null, '');
      this.caretKey = null;
      this.stopBlink();
    }
    const selected =
      sel instanceof NodeSelection && !sel.node.isInline
        ? (this.keys.keyAt(sel.from) ?? null)
        : null;
    if (selected !== this.selectedKey) {
      if (this.selectedKey)
        this.selectedBlocks.set(this.selectedKey, undefined);
      if (selected) this.selectedBlocks.set(selected, true);
      this.selectedKey = selected;
    }
  }

  private restartBlink(): void {
    stopInterval(this.blinkTimer);
    this.blinkTimer = null;
    if (!this.caretKey || !this.focused || this.destroyedFlag) return;
    let on = true;
    this.blinkTimer = startInterval(() => {
      on = !on;
      const key = this.caretKey;
      if (key) this.texts.get(key)?.blink(on);
    }, CARET_BLINK_MS);
  }

  private stopBlink(): void {
    stopInterval(this.blinkTimer);
    this.blinkTimer = null;
  }

  // --- decorations -------------------------------------------------------------

  private decorationStyle(deco: Decoration): RunStyle | null {
    const attrs =
      (deco as unknown as { type?: { attrs?: Record<string, string> } }).type
        ?.attrs ?? {};
    const spec = deco.spec as { run?: RunStyle } | undefined;
    let style: RunStyle = {};
    if (attrs.class) {
      for (const cls of attrs.class.split(/\s+/)) {
        const s = this.config.decorationClasses?.[cls];
        if (s) style = { ...style, ...s };
      }
    }
    if (attrs.style) style = { ...style, ...styleFromCSS(attrs.style, {}) };
    if (spec?.run) style = { ...style, ...spec.run };
    return Object.keys(style).length ? style : null;
  }

  /**
   * Every plugin's decorations, bucketed by the block they fall in, plus the
   * view's own two widgets — the placeholder and a composition's preedit.
   * Only a block whose bucket changed is told; returns whether any was.
   *
   * What a DOM view would draw that this one cannot: a widget whose only
   * description is a `toDOM` function. A widget draws here when its spec
   * carries `text` (and, optionally, a `run` style) — see the docs page.
   */
  private recomputeDecorations(): boolean {
    const { doc } = this.state;
    type Bucket = {
      inline: InlineDecoration[];
      widgets: InlineWidget[];
      box: BlockDecorations['box'];
    };
    const buckets = new Map<string, Bucket>();
    const bucket = (key: string): Bucket => {
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { inline: [], widgets: [], box: null }));
      return b;
    };
    const found: Decoration[] = [];
    this.someProp('decorations', (f) => {
      const source = f(this.state);
      if (source) collectDecorations(source, found);
      return undefined;
    });

    for (const deco of found) {
      const typed = deco as unknown as {
        widget?: boolean;
        inline?: boolean;
        type?: { side?: number; attrs?: Record<string, string> };
      };
      if (typed.widget) {
        const spec = deco.spec as
          { text?: unknown; run?: RunStyle; side?: number } | undefined;
        if (typeof spec?.text !== 'string' || spec.text === '') continue;
        const $pos = doc.resolve(deco.from);
        if (!$pos.parent.isTextblock || $pos.depth === 0) continue;
        const key = this.keys.keyAt($pos.before());
        if (!key) continue;
        bucket(key).widgets.push({
          pos: $pos.parentOffset,
          side: typed.type?.side ?? spec.side ?? 0,
          text: spec.text,
          ...(spec.run ? { style: spec.run } : null),
        });
      } else if (typed.inline) {
        const style = this.decorationStyle(deco);
        if (!style) continue;
        doc.nodesBetween(deco.from, deco.to, (node, pos) => {
          if (!node.isTextblock) return true;
          const key = this.keys.keyAt(pos);
          if (key) {
            const start = pos + 1;
            bucket(key).inline.push({
              from: Math.max(0, deco.from - start),
              to: Math.min(node.content.size, deco.to - start),
              style,
            });
          }
          return false;
        });
      } else {
        const key = this.keys.keyAt(deco.from);
        if (!key) continue;
        const style = this.decorationStyle(deco);
        if (style?.bg) bucket(key).box = { background: style.bg };
      }
    }

    const placeholder = this.config.placeholder;
    if (placeholder && isEmptyDoc(doc)) {
      const key = this.keys.keyAt(0);
      if (key) {
        bucket(key).widgets.push({
          pos: 0,
          side: 0,
          text: placeholder,
          style: { color: this.config.colors.placeholder },
        });
      }
    }
    if (this.preedit) {
      const $head = this.state.selection.$head;
      if ($head.parent.isTextblock && $head.depth > 0) {
        const key = this.keys.keyAt($head.before());
        if (key) {
          bucket(key).widgets.push({
            pos: $head.parentOffset,
            side: -1,
            text: this.preedit,
            style: { underline: this.config.colors.preedit },
          });
        }
      }
    }

    let changed = false;
    for (const [key, b] of buckets) {
      const sig = JSON.stringify([b.inline, b.widgets, b.box]);
      if (this.decorations.get(key)?.sig === sig) continue;
      this.decorations.set(key, { ...b, sig });
      changed = true;
    }
    for (const key of [...this.decorations.keys()]) {
      if (!buckets.has(key)) {
        this.decorations.set(key, undefined);
        changed = true;
      }
    }
    return changed;
  }

  // --- geometry ----------------------------------------------------------------

  /** The logical rect of a node — `abs`, already divided (AGENTS.md: ask for
   *  the rect, and the arithmetic stays in one unit). */
  private rectOf(
    node: DrawnNode | EditorTextNode,
  ): { x: number; y: number; width: number; height: number } | null {
    const r = (node as DrawnNode).getClientRects()[0];
    return r && (r.width > 0 || r.height > 0) ? r : null;
  }

  /** The nearest block to a point: the one it is in, or the one closest
   *  vertically, then horizontally. Text blocks win ties with atoms. */
  private hit(x: number, y: number): Hit | null {
    let best: {
      key: string;
      node: DrawnNode | EditorTextNode;
      text: boolean;
      r: { x: number; y: number; width: number; height: number };
    } | null = null;
    let bestScore = Infinity;
    const consider = (
      key: string,
      node: DrawnNode | EditorTextNode,
      text: boolean,
    ): void => {
      const r = this.rectOf(node);
      if (!r) return;
      const dy =
        y < r.y
          ? r.y - y
          : y >= r.y + r.height
            ? y - (r.y + r.height) + 0.001
            : 0;
      const dx =
        x < r.x ? r.x - x : x >= r.x + r.width ? x - (r.x + r.width) : 0;
      const score = dy * 1e6 + dx;
      if (score < bestScore || (score === bestScore && text && !best?.text)) {
        bestScore = score;
        best = { key, node, text, r };
      }
    };
    for (const [key, node] of this.texts) consider(key, node, true);
    for (const [key, node] of this.boxes) consider(key, node, false);
    return best ? this.hitIn(best, x, y) : null;
  }

  private hitIn(
    best: {
      key: string;
      node: DrawnNode | EditorTextNode;
      text: boolean;
      r: { x: number; y: number; width: number; height: number };
    },
    x: number,
    y: number,
  ): Hit | null {
    const pos = this.keys.posOf(best.key);
    if (pos === undefined) return null;
    if (!best.text) return { pos, inside: pos, atom: true };
    const text = best.node as EditorTextNode;
    const map = text.map;
    if (!map) return null;
    const s = scaleOf(text);
    const { r } = best;
    const cx = Math.min(Math.max(x, r.x), r.x + r.width - 0.5);
    const cy = Math.min(Math.max(y, r.y), r.y + r.height - 0.5);
    const cp = text.textIndexAt(cx * s, cy * s);
    return { pos: pos + 1 + map.toDoc(cp), inside: pos, atom: false };
  }

  /** ProseMirror's `posAtCoords`, in window logical pixels — the space a
   *  pointer event's `x`/`y` are in. */
  posAtCoords(coords: {
    left: number;
    top: number;
  }): { pos: number; inside: number } | null {
    const hit = this.hit(coords.left, coords.top);
    return hit && { pos: hit.pos, inside: hit.inside };
  }

  /** ProseMirror's `coordsAtPos`: where a caret at `pos` is drawn, in window
   *  logical pixels. */
  coordsAtPos(pos: number, _side = 1): Coords {
    const { doc } = this.state;
    let $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
    if (!$pos.parent.isTextblock) {
      const near = Selection.near($pos);
      if (near instanceof NodeSelection && !near.node.isInline) {
        const key = this.keys.keyAt(near.from);
        const box = key ? this.boxes.get(key) : undefined;
        const r = box && this.rectOf(box);
        if (r)
          return {
            left: r.x,
            right: r.x + r.width,
            top: r.y,
            bottom: r.y + r.height,
          };
      }
      $pos = near.$head;
    }
    if ($pos.parent.isTextblock && $pos.depth > 0) {
      const key = this.keys.keyAt($pos.before());
      const text = key ? this.texts.get(key) : undefined;
      if (text?.map) {
        const r = text.textCaretRect(text.map.toDisplay($pos.parentOffset));
        if (r) {
          const s = scaleOf(text);
          return {
            left: r.x / s,
            right: r.x / s,
            top: r.y / s,
            bottom: (r.y + r.height) / s,
          };
        }
      }
    }
    const r = this.root?.getClientRects()[0];
    return r
      ? { left: r.x, right: r.x, top: r.y, bottom: r.y }
      : { left: 0, right: 0, top: 0, bottom: 0 };
  }

  /**
   * The textblock element that draws `pos`, and where a caret there is in
   * that element's own logical coordinates — what a `<popup anchor>` hangs
   * off, so it moves with the text when the document scrolls and unmaps
   * when the text scrolls out of view. Null when no mounted block draws it.
   */
  anchorAt(pos: number): {
    node: DrawnNode;
    at: { x: number; y: number; width: number; height: number };
  } | null {
    const { doc } = this.state;
    const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
    if (!$pos.parent.isTextblock || $pos.depth === 0) return null;
    const key = this.keys.keyAt($pos.before());
    const text = key ? this.texts.get(key) : undefined;
    const box = text?.map ? this.rectOf(text) : null;
    if (!text || !box) return null;
    const caret = this.coordsAtPos(pos);
    return {
      node: text as unknown as DrawnNode,
      at: {
        x: caret.left - box.x,
        y: caret.top - box.y,
        width: 1,
        height: Math.max(1, caret.bottom - caret.top),
      },
    };
  }

  /** ProseMirror's `endOfTextblock`: would moving `dir` from the selection
   *  leave its textblock? Up and down ask the layout which line it is on. */
  endOfTextblock(
    dir: 'up' | 'down' | 'left' | 'right' | 'forward' | 'backward',
    state: EditorState = this.state,
  ): boolean {
    const $head = state.selection.$head;
    if (!$head.parent.isTextblock) return true;
    const atStart = $head.parentOffset === 0;
    const atEnd = $head.parentOffset === $head.parent.content.size;
    if (dir === 'backward' || dir === 'left') return atStart;
    if (dir === 'forward' || dir === 'right') return atEnd;
    const key =
      state === this.state && $head.depth > 0
        ? this.keys.keyAt($head.before())
        : undefined;
    const text = key ? this.texts.get(key) : undefined;
    const line = text?.map
      ? text.lineRange(text.map.toDisplay($head.parentOffset))
      : null;
    if (!line) return dir === 'up' ? atStart : atEnd;
    return dir === 'up' ? line.start === 0 : line.last;
  }

  /** The nearest line that way: blocks whose band holds `y` first, then the
   *  first block past the caret's line. For line motion and paging. */
  private near(x: number, y: number, dir: -1 | 1, from: Coords): Hit | null {
    type Cand = {
      key: string;
      node: DrawnNode | EditorTextNode;
      text: boolean;
      r: { x: number; y: number; width: number; height: number };
    };
    let inBand: Cand | null = null;
    let inBandDx = Infinity;
    let beyond: Cand | null = null;
    let beyondScore = Infinity;
    const consider = (
      key: string,
      node: DrawnNode | EditorTextNode,
      text: boolean,
    ): void => {
      const r = this.rectOf(node);
      if (!r) return;
      const dx =
        x < r.x ? r.x - x : x >= r.x + r.width ? x - (r.x + r.width) : 0;
      if (y >= r.y && y < r.y + r.height) {
        if (dx < inBandDx) {
          inBandDx = dx;
          inBand = { key, node, text, r };
        }
        return;
      }
      const gap = dir < 0 ? from.top - (r.y + r.height) : r.y - from.bottom;
      if (gap < -0.5) return;
      const reach = dir < 0 ? y - (r.y + r.height) : r.y - y;
      const score = Math.abs(reach) * 1e6 + dx;
      if (score < beyondScore) {
        beyondScore = score;
        beyond = { key, node, text, r };
      }
    };
    for (const [key, node] of this.texts) consider(key, node, true);
    for (const [key, node] of this.boxes) consider(key, node, false);
    const pick = (inBand ?? beyond) as Cand | null;
    if (!pick) return null;
    const ty = inBand
      ? y
      : dir < 0
        ? pick.r.y + pick.r.height - 1
        : pick.r.y + 1;
    return this.hitIn(pick, x, ty);
  }

  private viewportHeight(): number {
    return this.scroller?.getClientRects()[0]?.height ?? 400;
  }

  // --- motion ----------------------------------------------------------------------

  /**
   * Move the caret — or, with `extend`, the head of the selection — by a
   * unit. Always answers true: a motion key that could not move (Up on the
   * first line of the document) is still the editor's key.
   */
  move(unit: MoveUnit, extend: boolean): boolean {
    const { doc, selection: sel } = this.state;
    let target: Selection | null = null;
    let head: number | null = null;
    let atom = false;
    switch (unit) {
      case 'left':
      case 'right':
        target = this.horizontal(unit === 'left' ? -1 : 1, extend);
        break;
      case 'wordBackward':
      case 'wordForward':
        head = this.wordTarget(unit === 'wordBackward' ? -1 : 1);
        break;
      case 'up':
      case 'down':
      case 'pageUp':
      case 'pageDown': {
        const dir = unit === 'up' || unit === 'pageUp' ? -1 : 1;
        const page =
          unit === 'pageUp' || unit === 'pageDown'
            ? this.viewportHeight() * 0.9
            : 0;
        const coords = this.coordsAtPos(sel.head);
        if (this.goalX === null) this.goalX = coords.left;
        const lineHeight = Math.max(1, coords.bottom - coords.top);
        const y = page
          ? dir < 0
            ? coords.top - page
            : coords.bottom + page
          : dir < 0
            ? coords.top - lineHeight / 2
            : coords.bottom + lineHeight / 2;
        const hit = this.near(this.goalX, y, dir, coords);
        if (hit) {
          head = hit.pos;
          atom = hit.atom;
        } else {
          // no line that way: the start (or the end) of the document
          head =
            dir < 0 ? Selection.atStart(doc).head : Selection.atEnd(doc).head;
        }
        this.keepGoal = true;
        break;
      }
      case 'lineStart':
      case 'lineEnd':
        head = this.lineEdge(sel.head, unit === 'lineStart' ? -1 : 1);
        break;
      case 'docStart':
        head = Selection.atStart(doc).head;
        break;
      case 'docEnd':
        head = Selection.atEnd(doc).head;
        break;
    }
    if (head !== null) {
      if (
        atom &&
        !extend &&
        NodeSelection.isSelectable(doc.nodeAt(head) ?? doc)
      ) {
        target = NodeSelection.create(doc, head);
      } else if (extend) {
        target = TextSelection.between(sel.$anchor, doc.resolve(head));
      } else {
        target = Selection.near(doc.resolve(head));
      }
    }
    if (target && !target.eq(sel))
      this.dispatch(this.state.tr.setSelection(target).scrollIntoView());
    else if (target) this.scheduleScroll();
    return true;
  }

  private horizontal(dir: -1 | 1, extend: boolean): Selection | null {
    const { doc, selection: sel } = this.state;
    if (!extend && !sel.empty) {
      if (sel instanceof NodeSelection) {
        return (
          Selection.findFrom(doc.resolve(dir < 0 ? sel.from : sel.to), dir) ??
          sel
        );
      }
      return TextSelection.create(doc, dir < 0 ? sel.from : sel.to);
    }
    const $head = sel.$head;
    if ($head.parent.isTextblock) {
      const offset = $head.parentOffset;
      if (dir < 0 ? offset > 0 : offset < $head.parent.content.size) {
        const pos =
          $head.start() + graphemeStep(blockText($head.parent), offset, dir);
        return extend
          ? TextSelection.create(doc, sel.anchor, pos)
          : TextSelection.create(doc, pos);
      }
      if ($head.depth === 0) return null;
      // out of the block: to the next place a caret can be — or, when not
      // extending, onto a block atom beside it (a rule), selected whole
      const next = Selection.findFrom(
        doc.resolve(dir < 0 ? $head.before() : $head.after()),
        dir,
        extend,
      );
      if (!next) return null;
      return extend ? TextSelection.create(doc, sel.anchor, next.head) : next;
    }
    const next = Selection.findFrom($head, dir, extend);
    if (!next) return null;
    return extend ? TextSelection.create(doc, sel.anchor, next.head) : next;
  }

  private wordTarget(dir: -1 | 1): number {
    const { doc, selection: sel } = this.state;
    const $head = sel.$head;
    if (!$head.parent.isTextblock || $head.depth === 0) return sel.head;
    const offset = $head.parentOffset;
    if (dir < 0 ? offset > 0 : offset < $head.parent.content.size) {
      return $head.start() + wordStep(blockText($head.parent), offset, dir);
    }
    const next = Selection.findFrom(
      doc.resolve(dir < 0 ? $head.before() : $head.after()),
      dir,
      true,
    );
    return next ? next.head : sel.head;
  }

  /** Where Home or End goes from `pos`: the visual line's edge, read off the
   *  layout — so a wrapped paragraph's End stops where the line does. */
  private lineEdge(pos: number, dir: -1 | 1): number {
    const $pos = this.state.doc.resolve(pos);
    if (!$pos.parent.isTextblock || $pos.depth === 0) return pos;
    const key = this.keys.keyAt($pos.before());
    const text = key ? this.texts.get(key) : undefined;
    const map = text?.map;
    const line =
      text && map ? text.lineRange(map.toDisplay($pos.parentOffset)) : null;
    if (!map || !line) return dir < 0 ? $pos.start() : $pos.end();
    return $pos.start() + map.toDoc(dir < 0 ? line.start : line.end);
  }

  private deleteBy(dir: -1 | 1, unit: 'char' | 'word' | 'line'): boolean {
    const { state } = this;
    const sel = state.selection;
    if (!sel.empty) {
      this.dispatch(state.tr.deleteSelection().scrollIntoView());
      return true;
    }
    const $head = sel.$head;
    if (!$head.parent.isTextblock) return true;
    const offset = $head.parentOffset;
    // at the block's edge a join is the keymap's (joinBackward), and it
    // declined — nothing is left to delete here
    if (dir < 0 ? offset === 0 : offset === $head.parent.content.size)
      return true;
    let target: number;
    if (unit === 'line') target = this.lineEdge($head.pos, dir);
    else {
      const text = blockText($head.parent);
      target =
        $head.start() +
        (unit === 'word'
          ? wordStep(text, offset, dir)
          : graphemeStep(text, offset, dir));
    }
    const from = Math.min(target, $head.pos);
    const to = Math.max(target, $head.pos);
    if (from !== to) this.dispatch(state.tr.delete(from, to).scrollIntoView());
    return true;
  }

  /** Typed text, as ProseMirror's DOM view inserts it: `handleTextInput`
   *  first (input rules live there), then the insertion. */
  insertText(text: string): void {
    const { from, to } = this.state.selection;
    const insert = (): Transaction => this.state.tr.insertText(text, from, to);
    if (
      this.someProp('handleTextInput', (f) =>
        f(this.asEditorView, from, to, text, insert),
      )
    )
      return;
    this.dispatch(insert().scrollIntoView());
  }

  // --- keys ----------------------------------------------------------------------

  keyDown(ev: KeyEvent): void {
    if (ev.composing || this.destroyedFlag) return;
    const k = ev.keysym;
    // Escape arms one Tab that leaves: an editor that keeps Tab for lists,
    // tables and code owes the keyboard user a way out (react-x11
    // docs/extending.md, "Behaviour of your own")
    if ((k === XK_TAB || k === XK_ISO_LEFT_TAB) && this.tabEscapes) {
      this.tabEscapes = false;
      return;
    }
    this.tabEscapes = false;
    const dom = toDomKeyEvent(ev, this.primary);
    this.userInput++;
    try {
      if (
        this.someProp('handleKeyDown', (f) =>
          f(this.asEditorView, dom as unknown as KeyboardEvent),
        )
      ) {
        ev.preventDefault();
        return;
      }
      // only an Escape nothing claimed: one a plugin took — a suggestion
      // list closing — was spent, and the next Escape arms the Tab instead
      this.tabEscapes = k === XK_ESCAPE;
      if (this.fallbackKey(ev, dom)) ev.preventDefault();
    } finally {
      this.userInput--;
    }
  }

  /** What a browser's contenteditable does with a key no plugin claimed. */
  private fallbackKey(ev: KeyEvent, dom: DomKeyEvent): boolean {
    const mac = this.primary === 'meta';
    const shift = ev.shiftKey;
    const word = mac ? ev.altKey : ev.ctrlKey;
    const line = mac && ev.metaKey;
    const primaryDown = mac ? ev.metaKey : ev.ctrlKey;
    switch (dom.key) {
      case 'ArrowLeft':
        return this.move(
          line ? 'lineStart' : word ? 'wordBackward' : 'left',
          shift,
        );
      case 'ArrowRight':
        return this.move(
          line ? 'lineEnd' : word ? 'wordForward' : 'right',
          shift,
        );
      case 'ArrowUp':
        return this.move(line ? 'docStart' : 'up', shift);
      case 'ArrowDown':
        return this.move(line ? 'docEnd' : 'down', shift);
      case 'Home':
        return this.move(primaryDown ? 'docStart' : 'lineStart', shift);
      case 'End':
        return this.move(primaryDown ? 'docEnd' : 'lineEnd', shift);
      case 'PageUp':
        return this.move('pageUp', shift);
      case 'PageDown':
        return this.move('pageDown', shift);
      case 'Backspace':
        return this.deleteBy(-1, line ? 'line' : word ? 'word' : 'char');
      case 'Delete':
        if (shift && !mac) {
          this.copy(true);
          return true;
        }
        return this.deleteBy(1, line ? 'line' : word ? 'word' : 'char');
      case 'Insert':
        if (shift) {
          void this.paste(false);
          return true;
        }
        if (ev.ctrlKey) {
          this.copy(false);
          return true;
        }
        return false;
      case 'Enter':
        // nothing claimed Enter: a state without the base keymap still splits
        return this.run(splitBlock);
    }
    if (primaryDown && !ev.altKey) {
      const letter =
        ev.keysym !== undefined && ev.keysym < 0x80
          ? String.fromCharCode(ev.keysym).toLowerCase()
          : '';
      switch (letter) {
        case 'c':
          this.copy(false);
          return true;
        case 'x':
          this.copy(true);
          return true;
        case 'v':
          void this.paste(shift);
          return true;
        case 'a':
          this.dispatch(
            this.state.tr.setSelection(new AllSelection(this.state.doc)),
          );
          return true;
      }
      return false;
    }
    const text = ev.key;
    const cp = ev.codepoint;
    if (
      text &&
      cp !== undefined &&
      cp >= 0x20 &&
      cp !== 0x7f &&
      !ev.ctrlKey &&
      !ev.metaKey &&
      (mac || !ev.altKey)
    ) {
      if (
        this.someProp('handleKeyPress', (f) =>
          f(this.asEditorView, dom as unknown as KeyboardEvent),
        )
      ) {
        return true;
      }
      this.insertText(text);
      return true;
    }
    return false;
  }

  composition(ev: ComposeEvent): void {
    if (ev.type === 'compositionEnd') {
      this.setPreedit(null);
      if (ev.data) {
        this.userInput++;
        try {
          this.insertText(ev.data);
        } finally {
          this.userInput--;
        }
      }
      return;
    }
    this.setPreedit(ev.data ?? '');
  }

  private setPreedit(text: string | null): void {
    if (text === this.preedit) return;
    this.preedit = text;
    this.recomputeDecorations();
    this.syncSelection();
  }

  focusChanged(focused: boolean): void {
    if (focused === this.focused) return;
    this.focused = focused;
    if (!focused) {
      this.drag = null;
      this.tabEscapes = false;
      if (this.preedit !== null) this.setPreedit(null);
    }
    this.syncSelection();
    if (!focused) this.stopBlink();
    this.config.onFocusChange?.(focused);
  }

  // --- the pointer -----------------------------------------------------------------

  /** A press, from the root's `onMouseDown`. Returns whether the editor
   *  took it — the component then prevents core's default action. */
  mouseDown(ev: X11MouseEvent): boolean {
    this.goalX = null;
    const hit = this.hit(ev.x, ev.y);
    if (!hit) return false;
    const { doc } = this.state;
    const sel = this.state.selection;
    if (ev.button === 3) {
      // a right press outside the selection moves the caret there first, so
      // the menu it opens acts on what is under the pointer
      if (hit.pos < sel.from || hit.pos > sel.to) {
        this.dispatch(
          this.state.tr.setSelection(Selection.near(doc.resolve(hit.pos))),
        );
      }
      return false;
    }
    if (ev.button === 2) {
      this.dispatch(
        this.state.tr.setSelection(Selection.near(doc.resolve(hit.pos))),
      );
      void this.paste(false, 'PRIMARY');
      return true;
    }
    if (ev.button !== 1) return false;
    const detail = ev.detail || 1;
    if (this.clickHandlers(hit, ev, detail)) return true;
    if (hit.atom) {
      const node = doc.nodeAt(hit.pos);
      if (node && NodeSelection.isSelectable(node)) {
        this.dispatch(
          this.state.tr.setSelection(NodeSelection.create(doc, hit.pos)),
        );
      }
      return true;
    }
    let anchor = hit.pos;
    let head = hit.pos;
    let unit: Drag['unit'] = 'char';
    if (detail >= 3) {
      unit = 'block';
      [anchor, head] = this.blockAround(hit.pos);
    } else if (detail === 2) {
      unit = 'word';
      [anchor, head] = this.wordAround(hit.pos);
    } else if (ev.shiftKey) {
      anchor = sel.anchor;
    }
    this.drag = { anchor, unit, origin: { from: anchor, to: head } };
    this.dispatch(
      this.state.tr.setSelection(
        TextSelection.between(doc.resolve(anchor), doc.resolve(head)),
      ),
    );
    ev.capturePointer?.();
    return true;
  }

  /** ProseMirror's click props, innermost node first: `handleClickOn` for
   *  each node around the position, then `handleClick`. */
  private clickHandlers(hit: Hit, ev: X11MouseEvent, detail: number): boolean {
    const [on, plain] =
      detail >= 3
        ? (['handleTripleClickOn', 'handleTripleClick'] as const)
        : detail === 2
          ? (['handleDoubleClickOn', 'handleDoubleClick'] as const)
          : (['handleClickOn', 'handleClick'] as const);
    const event = {
      clientX: ev.x,
      clientY: ev.y,
      button: ev.button - 1,
      detail,
      shiftKey: ev.shiftKey,
      ctrlKey: ev.ctrlKey,
      altKey: ev.altKey,
      metaKey: ev.metaKey,
      preventDefault() {},
      stopPropagation() {},
    } as unknown as MouseEvent;
    const $pos = this.state.doc.resolve(hit.pos);
    for (let d = $pos.depth; d >= 0; d--) {
      const node = $pos.node(d);
      const nodePos = d > 0 ? $pos.before(d) : -1;
      const direct = d === $pos.depth;
      const handled = this.someProp(on, (f) =>
        (
          f as (
            v: EditorView,
            p: number,
            n: PMNode,
            np: number,
            e: MouseEvent,
            dr: boolean,
          ) => boolean | void
        )(this.asEditorView, hit.pos, node, nodePos, event, direct),
      );
      if (handled) return true;
    }
    return !!this.someProp(plain, (f) =>
      (f as (v: EditorView, p: number, e: MouseEvent) => boolean | void)(
        this.asEditorView,
        hit.pos,
        event,
      ),
    );
  }

  /** Motion while pressed, from the root's `onMouseMove`. */
  mouseMove(ev: X11MouseEvent): boolean {
    if (!this.drag) return false;
    this.pointer = { x: ev.x, y: ev.y };
    this.extendDrag(ev.x, ev.y);
    this.autoScroll();
    return true;
  }

  mouseUp(): void {
    if (!this.drag) return;
    this.drag = null;
    stopInterval(this.dragScroll);
    this.dragScroll = null;
    this.ownPrimary();
  }

  private extendDrag(x: number, y: number): void {
    const drag = this.drag;
    const hit = drag && this.hit(x, y);
    if (!drag || !hit || hit.atom) return;
    const { doc } = this.state;
    let anchor = drag.anchor;
    let head = hit.pos;
    if (drag.unit !== 'char') {
      const [a, b] =
        drag.unit === 'word'
          ? this.wordAround(hit.pos)
          : this.blockAround(hit.pos);
      if (hit.pos < drag.origin.from) {
        anchor = drag.origin.to;
        head = a;
      } else {
        anchor = drag.origin.from;
        head = b;
      }
    }
    const next = TextSelection.between(doc.resolve(anchor), doc.resolve(head));
    if (!next.eq(this.state.selection))
      this.dispatch(this.state.tr.setSelection(next));
  }

  /** A drag held past the viewport's edge keeps scrolling, and keeps
   *  extending, until the pointer comes back or the button comes up. */
  private autoScroll(): void {
    const outside = (): number => {
      const p = this.pointer;
      const box = this.scroller?.getClientRects()[0];
      if (!p || !box) return 0;
      if (p.y < box.y) return p.y - box.y;
      if (p.y > box.y + box.height) return p.y - (box.y + box.height);
      return 0;
    };
    if (!outside()) {
      stopInterval(this.dragScroll);
      this.dragScroll = null;
      return;
    }
    if (this.dragScroll !== null) return;
    this.dragScroll = startInterval(() => {
      const o = outside();
      if (!o || !this.drag || !this.scroller) return;
      this.scroller.scrollBy({
        y: Math.sign(o) * Math.min(40, Math.max(4, Math.abs(o))),
      });
      const p = this.pointer;
      if (p) this.extendDrag(p.x, p.y);
    }, 50);
  }

  private wordAround(pos: number): [number, number] {
    const $pos = this.state.doc.resolve(pos);
    if (!$pos.parent.isTextblock) return [pos, pos];
    const [a, b] = wordRange(blockText($pos.parent), $pos.parentOffset);
    return [$pos.start() + a, $pos.start() + b];
  }

  private blockAround(pos: number): [number, number] {
    const $pos = this.state.doc.resolve(pos);
    if (!$pos.parent.isTextblock) return [pos, pos];
    return [$pos.start(), $pos.end()];
  }

  /** Right-click: core's standard edit menu, with the verbs this editor has.
   *  A read-only editor offers Copy and Select All and nothing else — a verb
   *  left out is a row that is not there (react-x11 docs/extending.md). */
  contextMenu(ev: X11MouseEvent): void {
    const root = this.root as unknown as DrawnNode | null;
    if (!root) return;
    const sel = this.state.selection;
    const editable = this.editable;
    openEditMenu(
      root,
      { x: ev.x, y: ev.y },
      {
        hasSelection: !sel.empty,
        ...(editable
          ? {
              canUndo: undoDepth(this.state) > 0,
              undo: () => this.run(undo),
              canRedo: redoDepth(this.state) > 0,
              redo: () => this.run(redo),
              cut: () => this.copy(true),
              paste: () => void this.paste(false),
            }
          : null),
        copy: () => this.copy(false),
        canSelectAll: !(sel instanceof AllSelection),
        selectAll: () =>
          this.dispatch(
            this.state.tr.setSelection(new AllSelection(this.state.doc)),
          ),
      },
    );
  }

  // --- the clipboard -----------------------------------------------------------------

  /** Copy (or cut) the selection: HTML, plain text, and the slice kept in
   *  this process for a paste back — see `./clipboard.ts`. */
  copy(cut: boolean): void {
    const sel = this.state.selection;
    if (sel.empty) return;
    const { html, text, slice } = serializeForClipboard(this, sel.content());
    this.lastCopy = { text, slice };
    this.config.clipboard
      ?.write({
        'text/html': html,
        'text/plain;charset=utf-8': text,
        'text/plain': text,
        UTF8_STRING: text,
        STRING: text,
      })
      .catch(() => {});
    if (cut && this.editable) {
      this.dispatch(
        this.state.tr
          .deleteSelection()
          .scrollIntoView()
          .setMeta('uiEvent', 'cut'),
      );
    }
  }

  /** Paste from the clipboard (or from X11's PRIMARY): its HTML when it has
   *  some and the paste is not plain, its text otherwise. */
  async paste(plain: boolean, selection?: 'PRIMARY'): Promise<void> {
    const clipboard = this.config.clipboard;
    if (!clipboard || !this.editable) return;
    const options = selection ? { selection } : undefined;
    const [html, text] = await Promise.all([
      plain ? null : clipboard.read('text/html', options).catch(() => null),
      clipboard.read('text', options).catch(() => null),
    ]);
    if (this.destroyedFlag) return;
    this.pasteContent(
      typeof text === 'string' ? text : null,
      typeof html === 'string' && html ? html : null,
      plain,
    );
  }

  /** ProseMirror's `pasteText`. */
  pasteText(text: string): boolean {
    return this.pasteContent(text, null, true);
  }

  /** ProseMirror's `pasteHTML`. */
  pasteHTML(html: string): boolean {
    return this.pasteContent(null, html, false);
  }

  private pasteContent(
    text: string | null,
    html: string | null,
    plain: boolean,
  ): boolean {
    const own = this.lastCopy;
    const slice =
      own && text !== null && text === own.text && !plain
        ? own.slice
        : parseFromClipboard(
            this,
            text,
            html,
            plain,
            this.state.selection.$from,
          );
    if (!slice) return false;
    const event = {
      clipboardData: {
        getData: (type: string) =>
          type === 'text/html'
            ? (html ?? '')
            : type === 'text/plain' || type === 'text'
              ? (text ?? '')
              : '',
        types: [
          ...(html ? ['text/html'] : []),
          ...(text !== null ? ['text/plain'] : []),
        ],
      },
      preventDefault() {},
    } as unknown as ClipboardEvent;
    this.userInput++;
    try {
      if (
        this.someProp('handlePaste', (f) => f(this.asEditorView, event, slice))
      )
        return true;
      const single = sliceSingleNode(slice);
      const tr = single
        ? this.state.tr.replaceSelectionWith(single, plain)
        : this.state.tr.replaceSelection(slice);
      this.dispatch(
        tr.scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'),
      );
    } finally {
      this.userInput--;
    }
    return true;
  }

  /** X11's PRIMARY: whatever is selected is pasteable with the middle
   *  button, anywhere. */
  private ownPrimary(): void {
    const sel = this.state.selection;
    if (sel.empty || !this.config.clipboard) return;
    const { text } = serializeForClipboard(this, sel.content());
    this.config.clipboard.write(text, { selection: 'PRIMARY' }).catch(() => {});
  }

  // --- scrolling -------------------------------------------------------------------

  private scheduleScroll(): void {
    cancelAfterLayout(this.scrollTick);
    this.scrollTick = afterLayout(() => {
      this.scrollTick = null;
      this.scrollToSelection();
    });
  }

  /** Bring the selection's head into the viewport — after the layout the
   *  change caused, which is the first moment it has a place. */
  scrollToSelection(): void {
    if (this.destroyedFlag) return;
    if (this.someProp('handleScrollToSelection', (f) => f(this.asEditorView)))
      return;
    const box = this.scroller;
    const viewport = box?.getClientRects()[0];
    if (!box || !viewport) return;
    const r = this.coordsAtPos(this.state.selection.head);
    const margin = 8;
    let dy = 0;
    if (r.top < viewport.y + margin) dy = r.top - viewport.y - margin;
    else if (r.bottom > viewport.y + viewport.height - margin) {
      dy = r.bottom - (viewport.y + viewport.height) + margin;
    }
    if (dy) box.scrollBy({ y: dy });
  }

  // --- accessibility -----------------------------------------------------------------

  private textOffset(doc: PMNode, pos: number): number {
    return [
      ...doc.textBetween(
        0,
        Math.max(0, Math.min(pos, doc.content.size)),
        '\n',
        leafText,
      ),
    ].length;
  }

  /** The document as a screen reader reads it: one text, a line per block,
   *  the caret and selection in code points of it. */
  a11yText(): A11yTextState | null {
    const { state } = this;
    if (this.a11yCache?.state === state) return this.a11yCache.value;
    const { doc, selection } = state;
    const value: A11yTextState = {
      value: doc.textBetween(0, doc.content.size, '\n', leafText),
      caret: this.textOffset(doc, selection.head),
      selectionStart: this.textOffset(doc, selection.from),
      selectionEnd: this.textOffset(doc, selection.to),
      editable: this.editable,
      multiline: true,
    };
    this.a11yCache = { state, value };
    return value;
  }

  /** The document position at a code-point offset of `a11yText().value`. */
  private posAtTextOffset(offset: number): number {
    const { doc } = this.state;
    let remaining = offset;
    let result: number | null = null;
    let first = true;
    doc.descendants((node, pos) => {
      if (result !== null) return false;
      if (!node.isTextblock) return true;
      if (!first) {
        if (remaining === 0) {
          result = pos - 1 >= 0 ? pos - 1 : pos;
          return false;
        }
        remaining -= 1; // the line break between blocks
      }
      first = false;
      let inner = pos + 1;
      node.forEach((child) => {
        if (result !== null) return;
        const text = child.isText ? (child.text ?? '') : leafText(child);
        const cps = [...text];
        if (remaining <= cps.length) {
          result = child.isText
            ? inner + cps.slice(0, remaining).join('').length
            : inner + (remaining > 0 ? child.nodeSize : 0);
          return;
        }
        remaining -= cps.length;
        inner += child.nodeSize;
      });
      if (result === null && remaining === 0)
        result = pos + 1 + node.content.size;
      return false;
    });
    return result ?? doc.content.size;
  }

  a11ySelect(start: number, end: number): boolean {
    const { doc } = this.state;
    const from = this.posAtTextOffset(start);
    const to = this.posAtTextOffset(end);
    this.dispatch(
      this.state.tr.setSelection(
        TextSelection.between(doc.resolve(from), doc.resolve(to)),
      ),
    );
    return true;
  }

  a11yReplace(start: number, end: number, text: string): boolean {
    if (!this.editable) return false;
    const from = this.posAtTextOffset(start);
    const to = this.posAtTextOffset(end);
    this.dispatch(this.state.tr.insertText(text, from, to).scrollIntoView());
    return true;
  }
}
