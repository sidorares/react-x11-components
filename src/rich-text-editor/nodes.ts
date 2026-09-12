// The two elements the editor registers.
//
// **`<richeditor>`** is the editor's root, and the reason it is an element
// rather than a `<box>` is the default-action seam (react-x11#266): keys,
// composition, focus and blur arrive at the focused node's `default*`
// methods *after* the application's handlers and not at all if one of them
// called `preventDefault()` — so `<RichTextEditor onKeyDown>` can veto or
// extend any editing key without knowing how the editor is built, exactly as
// `<textinput onKeyDown>` can. A `<box>` has no such methods to give. It is
// also what an assistive technology reads: the root answers
// `a11yTextState()` for the whole document, which is one text to a screen
// reader however many blocks draw it.
//
// Presses are the exception, and on purpose: a press lands on whatever is
// under the pointer — a paragraph, a list marker, the gap between two blocks —
// and core runs the default action of *that* node, not of the root. So the
// component takes presses in an ordinary bubbling `onMouseDown` on the root
// and `preventDefault()`s them, which also keeps core's drag-and-drop from
// arming on a press that is placing a caret.
//
// **`<richeditortext>`** is one textblock: `<richtext>` — its layout cache,
// its run decoration, its four text accessors — plus a selection band and a
// caret the editor owns and sets imperatively. Neither goes through React: a
// caret that blinks twice a second, or a drag that extends a selection sixty
// times a second, re-rendering anything would be the cost the retained node
// exists to avoid. The view says where they are; the node paints them and
// damages only what moved.
import { registerElement, registeredElements } from 'react-x11/host';
import { Node } from 'react-x11/node';
import type { A11yTextState } from 'react-x11/node';
import type { Rect } from 'react-x11';

import { RichTextNode } from '../richtext/node.js';
import type { NtkApp } from '../richtext/node.js';
import type { FillContext } from '../richtext/runs.js';
import { codeUnitOffsets, codePointAtOffset } from '../internal/text.js';
import type { InlineMap } from './inline.js';

/** The root element's name — registration key, `kind`, JSX tag. */
export const ROOT_ELEMENT = 'richeditor';
/** The textblock element's name. */
export const TEXT_ELEMENT = 'richeditortext';

type KeyEvent = Parameters<NonNullable<Node['defaultKeyDown']>>[0];
type ComposeEvent = Parameters<NonNullable<Node['defaultComposition']>>[0];

/** What a listener `view.dom.addEventListener` took is handed: a focus
 *  event, DOM-named, from the root element. */
export interface DomFocusEvent {
  readonly type: 'focus' | 'blur' | 'focusin' | 'focusout';
  readonly target: RichEditorNode;
}

/**
 * What the elements report to — the editor view (`./view.ts`). An interface
 * so the nodes and the view can each be read, and tested, without the
 * other.
 */
export interface EditorHost {
  attachRoot(node: RichEditorNode): void;
  detachRoot(node: RichEditorNode): void;
  attachText(key: string, node: EditorTextNode): void;
  detachText(key: string, node: EditorTextNode): void;
  /** A mounted block drew something new — runs, a map, a node: whatever of
   *  the selection is in it has to be placed again. */
  textUpdated(key: string, node: EditorTextNode): void;
  keyDown(ev: KeyEvent): void;
  composition(ev: ComposeEvent): void;
  focusChanged(focused: boolean): void;
  a11yText(): A11yTextState | null;
  a11ySelect(start: number, end: number): boolean;
  a11yReplace(start: number, end: number, text: string): boolean;
}

/** Register both elements. Called at `./index.ts`'s module scope — never
 *  here — so importing this module registers nothing. Idempotent, for the
 *  same lockfile-skew reason `registerRichText` is. */
export function registerEditorElements(): void {
  if (!registeredElements().includes(ROOT_ELEMENT)) {
    registerElement(ROOT_ELEMENT, {
      create: (props, app) => new RichEditorNode(props, app),
      semanticNames: ['host'],
    });
  }
  if (!registeredElements().includes(TEXT_ELEMENT)) {
    registerElement(TEXT_ELEMENT, {
      create: (props, app) => new EditorTextNode(props, app),
      semanticNames: ['runs', 'wrap', 'map', 'blockKey', 'host', 'node'],
      childrenAllowed: false,
    });
  }
}

function hostOf(props: Record<string, unknown> | undefined): EditorHost | null {
  return (props?.host as EditorHost | undefined) ?? null;
}

export class RichEditorNode extends Node {
  constructor(props: Record<string, unknown>, app: unknown) {
    super(ROOT_ELEMENT, props, app as NtkApp);
    // Nothing focuses an element that has not said it can be focused, and
    // nothing types into one that is not focused. An app's `focusable`
    // still overrides it, which is how `disabled` leaves the tab order.
    this.focusableByDefault = true;
    this.defaultCursor = 'text';
    // The selection is the editor's own: a `selectable` document around it
    // skips this subtree rather than lighting up half of what is being
    // typed, and leaves its presses alone.
    this.hasOwnSelection = true;
    this.a11yRole = 'textbox';
    hostOf(props)?.attachRoot(this);
  }

  get host(): EditorHost | null {
    return hostOf(this.props);
  }

  override applyProps(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): void {
    const before = hostOf(prevProps ?? this.props);
    super.applyProps(nextProps, prevProps);
    const after = hostOf(nextProps);
    if (after !== before) {
      before?.detachRoot(this);
      after?.attachRoot(this);
    }
  }

  override destroySubtree(): void {
    this.host?.detachRoot(this);
    super.destroySubtree();
  }

  /**
   * Listeners a plugin written for a browser put on `view.dom` —
   * y-prosemirror's cursor plugin listens for `focusin` and `focusout` to
   * publish and withdraw the local caret. The focus family is all that is
   * sent: `focus`, `blur`, `focusin`, `focusout`, after the view has heard
   * the change, so `view.hasFocus()` already agrees with the event.
   */
  private domEventListeners = new Map<
    string,
    Set<(ev: DomFocusEvent) => void>
  >();

  addEventListener(type: string, listener: (ev: DomFocusEvent) => void): void {
    let set = this.domEventListeners.get(type);
    if (!set) this.domEventListeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(
    type: string,
    listener: (ev: DomFocusEvent) => void,
  ): void {
    this.domEventListeners.get(type)?.delete(listener);
  }

  private sendDomEvent(type: DomFocusEvent['type']): void {
    const set = this.domEventListeners.get(type);
    if (!set) return;
    for (const listener of [...set]) listener({ type, target: this });
  }

  override defaultKeyDown(ev: KeyEvent): void {
    this.host?.keyDown(ev);
  }

  override defaultComposition(ev: ComposeEvent): void {
    this.host?.composition(ev);
  }

  override defaultFocus(): void {
    this.host?.focusChanged(true);
    this.sendDomEvent('focus');
    this.sendDomEvent('focusin');
  }

  override defaultBlur(): void {
    this.host?.focusChanged(false);
    this.sendDomEvent('blur');
    this.sendDomEvent('focusout');
  }

  override a11yTextState(): A11yTextState | null {
    return this.host?.a11yText() ?? null;
  }

  override a11ySetSelection(start: number, end: number): boolean {
    return this.host?.a11ySelect(start, end) ?? false;
  }

  override a11yReplaceText(start: number, end: number, text: string): boolean {
    return this.host?.a11yReplace(start, end, text) ?? false;
  }
}

function sameBand(
  a: { start: number; end: number } | null,
  b: { start: number; end: number } | null,
): boolean {
  return a === b || (!!a && !!b && a.start === b.start && a.end === b.end);
}

export class EditorTextNode extends RichTextNode {
  /** The selection band, in drawn code points, or null. */
  private editorBand: { start: number; end: number } | null = null;
  private editorBandColor = '';
  /** The caret, as a drawn code point index, or null when it is elsewhere. */
  private editorCaret: number | null = null;
  private editorCaretColor = '';
  private editorCaretOn = true;
  /** Collaborators' carets in this block, in drawn code points. */
  private remoteCarets: readonly { index: number; color: string }[] = [];

  constructor(props: Record<string, unknown>, app: unknown) {
    super(props, app as NtkApp, TEXT_ELEMENT);
    hostOf(props)?.attachText(String(props.blockKey ?? ''), this);
  }

  get host(): EditorHost | null {
    return hostOf(this.props);
  }

  /** The block this node draws — the view's key for it. */
  get blockKey(): string {
    return String(this.props.blockKey ?? '');
  }

  /** How the drawn string maps back to the document. */
  get map(): InlineMap | null {
    return (this.props.map as InlineMap | undefined) ?? null;
  }

  override applyProps(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): void {
    const before = prevProps ?? this.props;
    const beforeHost = hostOf(before);
    const beforeKey = String(before.blockKey ?? '');
    super.applyProps(nextProps, prevProps);
    const afterHost = hostOf(nextProps);
    const afterKey = String(nextProps.blockKey ?? '');
    if (afterHost !== beforeHost || afterKey !== beforeKey) {
      beforeHost?.detachText(beforeKey, this);
      afterHost?.attachText(afterKey, this);
    } else if (
      nextProps.map !== before.map ||
      nextProps.runs !== before.runs ||
      nextProps.node !== before.node
    ) {
      afterHost?.textUpdated(afterKey, this);
    }
  }

  override destroySubtree(): void {
    this.host?.detachText(this.blockKey, this);
    super.destroySubtree();
  }

  // --- what the view sets ----------------------------------------------------

  /** The selection band over this block, in drawn code points. */
  setBand(band: { start: number; end: number } | null, color: string): void {
    if (sameBand(band, this.editorBand) && color === this.editorBandColor)
      return;
    this.editorBand = band;
    this.editorBandColor = color;
    this.root?.invalidate(false, this, 'text');
  }

  /** Where the caret is in this block, or null to take it away. */
  setCaret(index: number | null, color: string): void {
    if (index === this.editorCaret && color === this.editorCaretColor) return;
    this.damageCaret();
    this.editorCaret = index;
    this.editorCaretColor = color;
    this.editorCaretOn = true;
    this.damageCaret();
  }

  /** One blink. Damages the caret's own rectangle and nothing else. */
  blink(on: boolean): void {
    if (this.editorCaret === null || on === this.editorCaretOn) return;
    this.editorCaretOn = on;
    this.damageCaret();
  }

  private caretBox(): Rect | null {
    if (this.editorCaret === null) return null;
    const r = this.textCaretRect(this.editorCaret);
    if (!r) return null;
    const w = Math.max(1, Math.round(this.scale));
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: w,
      height: Math.ceil(r.height),
    };
  }

  private damageCaret(): void {
    const box = this.caretBox();
    if (!box) return;
    const pad = Math.ceil(this.scale);
    this.root?.invalidate(
      false,
      {
        x: box.x - pad,
        y: box.y,
        width: box.width + pad * 2,
        height: box.height,
      },
      'caret',
    );
  }

  /** Collaborators' carets in this block — set by the view like the
   *  editor's own, and drawn beside it without blinking. */
  setRemoteCarets(carets: readonly { index: number; color: string }[]): void {
    const was = this.remoteCarets;
    if (
      carets.length === was.length &&
      carets.every(
        (c, i) => c.index === was[i].index && c.color === was[i].color,
      )
    )
      return;
    this.damageRemoteCarets();
    this.remoteCarets = carets;
    this.damageRemoteCarets();
  }

  /** The collaborators' carets this block draws. */
  get collaboratorCarets(): readonly { index: number; color: string }[] {
    return this.remoteCarets;
  }

  /** A collaborator's caret: a bar two pixels wide, and a flag beside
   *  its top — inside the line, so nothing paints outside the block. */
  private remoteCaretBoxes(index: number): { bar: Rect; flag: Rect } | null {
    const r = this.textCaretRect(index);
    if (!r) return null;
    const s = Math.max(1, Math.round(this.scale));
    const bar = {
      x: Math.round(r.x) - s,
      y: Math.round(r.y),
      width: 2 * s,
      height: Math.ceil(r.height),
    };
    const flag = {
      x: bar.x + bar.width,
      y: bar.y,
      width: 3 * s,
      height: 3 * s,
    };
    return { bar, flag };
  }

  private damageRemoteCarets(): void {
    for (const caret of this.remoteCarets) {
      const boxes = this.remoteCaretBoxes(caret.index);
      if (!boxes) continue;
      const { bar, flag } = boxes;
      this.root?.invalidate(
        false,
        {
          x: bar.x - 1,
          y: bar.y,
          width: bar.width + flag.width + 2,
          height: bar.height,
        },
        'caret',
      );
    }
  }

  // --- painting ----------------------------------------------------------------

  protected override paintSelection(ctx: FillContext): void {
    const band = this.editorBand;
    if (!band || band.end <= band.start || !this.editorBandColor) return;
    ctx.fillStyle = this.editorBandColor;
    for (const r of this.textRangeRects(band.start, band.end)) {
      ctx.fillRect(
        Math.round(r.x),
        Math.round(r.y),
        Math.ceil(r.width),
        Math.ceil(r.height),
      );
    }
  }

  protected override paintOverlay(ctx: FillContext): void {
    for (const caret of this.remoteCarets) {
      const boxes = this.remoteCaretBoxes(caret.index);
      if (!boxes) continue;
      ctx.fillStyle = caret.color;
      const { bar, flag } = boxes;
      ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
      ctx.fillRect(flag.x, flag.y, flag.width, flag.height);
    }
    if (!this.editorCaretOn) return;
    const box = this.caretBox();
    if (!box || !this.editorCaretColor) return;
    ctx.fillStyle = this.editorCaretColor;
    ctx.fillRect(box.x, box.y, box.width, box.height);
  }

  // --- lines -------------------------------------------------------------------

  /**
   * The drawn code points of the visual line holding `index`: where Home and
   * End go. Read off the same layout the glyphs came from, so a wrapped line
   * ends where it is seen to end. Null on the mock backend, which lays
   * nothing out.
   */
  lineRange(
    index: number,
  ): { start: number; end: number; last: boolean } | null {
    const layout = this.paintLayout();
    if (!layout || layout.lines.length === 0) return null;
    const text = this.textContent();
    const offsets = codeUnitOffsets(text);
    const unit = offsets[Math.max(0, Math.min(index, offsets.length - 1))];
    const lines = layout.lines;
    let at = lines.length - 1;
    for (let i = 0; i < lines.length; i++) {
      if (unit < lines[i].end || i === lines.length - 1) {
        at = i;
        break;
      }
    }
    const line = lines[at];
    const last = at === lines.length - 1;
    let end = line.end;
    // a wrapped line's trailing space belongs to it but the caret after it
    // is drawn on the next line — End stops before it
    if (!last && end > line.start && /\s/.test(text[end - 1] ?? '')) end -= 1;
    return {
      start: codePointAtOffset(offsets, line.start),
      end: codePointAtOffset(offsets, end),
      last,
    };
  }
}
