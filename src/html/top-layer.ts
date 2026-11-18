// What opens and closes a document's top layer from its markup alone, where
// no script engine runs the document: a button's `popovertarget` and its
// `commandfor` and `command` (HTML 4.10.6 and 6.12), a `<form
// method="dialog">` sent, a press outside an auto popover or a dialog whose
// `closedby` is `any`, and Escape. A browser does all of it with JavaScript
// off, and pages are written to need nothing else: Alloy CSS's menus,
// drawer, toast and dialog are popovers and a modal dialog that buttons
// open and close.
//
// Where a script engine runs the document its DOM does this instead —
// `scripts/dom.ts`'s popovers and dialogs, which a page's `showModal()` and
// `showPopover()` reach as well — and none of this is made. Which elements
// are in the top layer, and as what, is `dom.ts`'s either way (`setModal`,
// `setPopoverOpen`); what reads it is `:modal`, `:popover-open`, the
// cascade's top layer and the focus. This is the order things go in and
// out of it in, and the events the host is told of on the way.
//
// Two things are simpler than a browser's. A hint popover is in the one
// stack an auto popover is in, where HTML keeps a second for hints: a hint
// shown hides the auto popovers it is not in. And an event is told as it
// happens, where HTML tells `toggle` and `close` in a task of their own.
import {
  attr,
  flatChildrenOf,
  flatParentOf,
  isElement,
  isModal,
  isPopoverOpen,
  setModal,
  setPopoverOpen,
  ShadowRoot,
  tagOf,
  treeGeneration,
} from './dom.js';
import type { AnyNode, Element, HtmlChange } from './dom.js';
import type { DomEventInit, HtmlDomEventType } from './dom-events.js';
import { focusableElement, isSummaryOf, isTabbable } from './focus.js';
import { buttonType, formOwner, isDisabled } from './form.js';

/** A popover's type, as its `popover` attribute says (HTML 6.12): `auto`
 *  for the empty string, `manual` for anything that is no keyword, and
 *  null where it has none. */
export function popoverType(el: Element): 'auto' | 'manual' | 'hint' | null {
  const value = attr(el, 'popover');
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  return v === '' || v === 'auto' ? 'auto' : v === 'hint' ? 'hint' : 'manual';
}

/** The commands a `command` attribute names (HTML 4.10.6): one of HTML's,
 *  or a custom one, which starts with two dashes and is kept as written. */
export type ButtonCommand =
  | 'toggle-popover'
  | 'show-popover'
  | 'hide-popover'
  | 'close'
  | 'request-close'
  | 'show-modal'
  | `--${string}`;

const COMMANDS = new Set<string>([
  'toggle-popover',
  'show-popover',
  'hide-popover',
  'close',
  'request-close',
  'show-modal',
]);

/** A button's `command`, or null for none, or one in the Unknown state. */
export function commandOf(el: Element): ButtonCommand | null {
  const value = attr(el, 'command');
  if (value === undefined) return null;
  if (value.startsWith('--')) return value as ButtonCommand;
  const v = value.toLowerCase();
  return COMMANDS.has(v) ? (v as ButtonCommand) : null;
}

/** Whether an element is a button a press activates (HTML 4.10.6 and
 *  4.10.5.1.18): a `<button>`, or an `<input>` that is one. */
function isButton(el: Element): boolean {
  const tag = tagOf(el);
  if (tag === 'button') return true;
  if (tag !== 'input') return false;
  const type = (attr(el, 'type') ?? '').trim().toLowerCase();
  return (
    type === 'submit' ||
    type === 'reset' ||
    type === 'button' ||
    type === 'image'
  );
}

/** The element with an id, in the tree `from` is in: its document, or
 *  the shadow tree it is in, as an IDREF is looked up (DOM 4.2.4). */
function byIdInTree(from: Element, id: string): Element | null {
  let top: AnyNode = from;
  while (top.parent) top = top.parent;
  const stack: AnyNode[] = [top];
  while (stack.length) {
    const node = stack.pop()!;
    if (isElement(node) && node !== top && attr(node, 'id') === id) return node;
    const kids = (node as { children?: AnyNode[] }).children;
    if (kids) for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return null;
}

/** The element a `<button>`'s `commandfor` names (HTML 2.6.1, "get the
 *  attr-associated element"), where it names one: an `<input>` has no
 *  `commandfor`. */
export function commandForElement(el: Element): Element | null {
  if (tagOf(el) !== 'button') return null;
  const id = attr(el, 'commandfor');
  return id ? byIdInTree(el, id) : null;
}

/** HTML's "popover target element": the popover a button that is not
 *  disabled, nor its form's submit button, shows and hides. */
export function popoverTargetOf(el: Element): Element | null {
  if (!isButton(el) || isDisabled(el)) return null;
  if (buttonType(el) === 'submit' && formOwner(el)) return null;
  const id = attr(el, 'popovertarget');
  const target = id ? byIdInTree(el, id) : null;
  return target && popoverType(target) ? target : null;
}

/** What a dialog's `closedby` comes to (HTML 4.11.4): `any`, `closerequest`
 *  or `none` as it says, and where it says none of them, `closerequest`
 *  for a modal dialog and `none` for another. */
export function closedByOf(dialog: Element): 'any' | 'closerequest' | 'none' {
  const v = (attr(dialog, 'closedby') ?? '').trim().toLowerCase();
  if (v === 'any' || v === 'closerequest' || v === 'none') return v;
  return isModal(dialog) ? 'closerequest' : 'none';
}

/** The document's half of the top layer that `TopLayer` asks for. */
export interface TopLayerDeps {
  /** The document now: what an element has to be in to be shown. */
  document(): AnyNode | null;
  /** Restyle and lay out again, told what changed. */
  touch(changes: readonly HtmlChange[]): void;
  /** Tell the host, and answer whether the default goes on; `cancelable`
   *  is the event's own, where its type does not say. */
  fire(
    type: HtmlDomEventType,
    target: Element,
    init?: DomEventInit,
    cancelable?: boolean,
  ): boolean;
  /** Give an element the focus, as a script's `focus()` does: owed until
   *  its widget or its stop is mounted, which a dialog's controls are only
   *  once it is drawn. */
  focus(el: Element): void;
  /** What has the document's focus, or null. */
  activeElement(): Element | null;
  /** Where an element's border box is, in the document's coordinates in
   *  logical pixels — `elementRect`'s — or null where it has none. */
  rectOf(
    el: Element,
  ): { x: number; y: number; width: number; height: number } | null;
}

/** A point in the document, in logical pixels: `elementRect`'s space. */
export interface DocumentPoint {
  x: number;
  y: number;
}

/**
 * The top layer of a document no script engine runs: its auto popovers in
 * the order they were shown, its open dialogs in the order they opened, and
 * what each had the focus before it. One for each `<Html>`.
 */
export class TopLayer {
  /** The showing auto and hint popovers, the first shown first (HTML's
   *  "showing auto popover list"). */
  private _autos: Element[] = [];
  /** The open dialogs, modal or not, the first opened first. */
  private _dialogs: Element[] = [];
  /** When each popover and dialog was shown, counted across both: Escape
   *  is a close request at the last of them. */
  private _openedAt = new WeakMap<Element, number>();
  private _opened = 0;
  /** What had the focus as each was shown, given it back as it goes. */
  private _previous = new WeakMap<Element, Element | null>();
  /** What a press started a light dismiss at (HTML's popover pointerdown
   *  target and its dialog pointerdown target); undefined for none. */
  private _pressedPopover: Element | null | undefined = undefined;
  private _pressedDialog: Element | null | undefined = undefined;

  constructor(private readonly _deps: TopLayerDeps) {}

  /** Whether an element is in the document now. */
  private _connected(el: Element): boolean {
    const doc = this._deps.document();
    let at = el as AnyNode;
    for (;;) {
      const up: AnyNode | null =
        at.parent ?? (at instanceof ShadowRoot ? at.host : null);
      if (!up) return at === doc;
      at = up;
    }
  }

  /** The lists as the document has them: what was taken out of it, or
   *  closed under them, is in them no more, and a dialog the markup has
   *  open is in the open dialogs ahead of those opened since. */
  private _sync(): void {
    this._autos = this._autos.filter(
      (p) => isPopoverOpen(p) && this._connected(p),
    );
    this._dialogs = this._dialogs.filter(
      (d) => attr(d, 'open') !== undefined && this._connected(d),
    );
    const parsed = this._openInMarkup().filter(
      (d) => attr(d, 'open') !== undefined && !this._dialogs.includes(d),
    );
    if (parsed.length) this._dialogs.unshift(...parsed);
  }

  /** The dialogs open in the document, by a walk of it made again only once
   *  the tree has changed (`treeGeneration`): a press asks on every page. */
  private _openWalked: {
    doc: AnyNode;
    generation: number;
    dialogs: Element[];
  } | null = null;
  private _openInMarkup(): Element[] {
    const doc = this._deps.document();
    if (!doc) return [];
    const kept = this._openWalked;
    const generation = treeGeneration();
    if (kept?.doc === doc && kept.generation === generation) {
      return kept.dialogs;
    }
    const dialogs: Element[] = [];
    const walk = (node: AnyNode) => {
      for (const child of flatChildrenOf(node)) {
        if (!isElement(child)) continue;
        if (tagOf(child) === 'dialog' && attr(child, 'open') !== undefined) {
          dialogs.push(child);
        }
        walk(child);
      }
    };
    walk(doc);
    this._openWalked = { doc, generation, dialogs };
    return dialogs;
  }

  // --- a button -------------------------------------------------------------

  /**
   * A button's activation behaviour past its form's (HTML 4.10.6, steps 4
   * to 6), once its click was not cancelled: the command its `commandfor`
   * and `command` name run at their target, or else the popover its
   * `popovertarget` names shown, hidden or toggled. `pressed` is what the
   * click was on, which may be inside the button. Whether it did anything.
   */
  activate(button: Element, pressed: Element = button): boolean {
    if (!isButton(button) || isDisabled(button)) return false;
    // a button that is no submit button and no reset button, in a form,
    // with no `type`, does nothing (step 3.3): a `<button commandfor>`
    // that says no `type`
    if (
      formOwner(button) &&
      tagOf(button) === 'button' &&
      !/^(submit|reset|button)$/i.test((attr(button, 'type') ?? '').trim()) &&
      (attr(button, 'commandfor') !== undefined ||
        attr(button, 'command') !== undefined)
    ) {
      return false;
    }
    const target = commandForElement(button);
    if (target) return this._command(button, target);
    const popover = popoverTargetOf(button);
    if (!popover) return false;
    // a press inside the popover on a button around it is the popover's
    if (
      contains(popover, pressed) &&
      button !== popover &&
      contains(button, popover)
    ) {
      return false;
    }
    const action = (attr(button, 'popovertargetaction') ?? '')
      .trim()
      .toLowerCase();
    const showing = isPopoverOpen(popover);
    if (action === 'show' && showing) return false;
    if (action === 'hide' && !showing) return false;
    if (showing) return this.hidePopover(popover, true, true);
    return this.showPopover(popover, button);
  }

  /** A command at its target (HTML 4.10.6, step 5): told first, as
   *  `command`, which the host may cancel; a custom one is no more than
   *  that. */
  private _command(button: Element, target: Element): boolean {
    const command = commandOf(button);
    if (!command) return false;
    const popover = popoverType(target) !== null;
    const custom = command.startsWith('--');
    const dialog = tagOf(target) === 'dialog';
    if (!popover && !custom) {
      if (!dialog) return false;
      if (
        command !== 'close' &&
        command !== 'request-close' &&
        command !== 'show-modal'
      ) {
        return false;
      }
    }
    if (
      !this._deps.fire('command', target, { command, source: button }, true)
    ) {
      return true;
    }
    if (!this._connected(target) || custom) return true;
    switch (command) {
      case 'hide-popover':
        return isPopoverOpen(target) && this.hidePopover(target, true, true);
      case 'show-popover':
        return !isPopoverOpen(target) && this.showPopover(target, button);
      case 'toggle-popover':
        return isPopoverOpen(target)
          ? this.hidePopover(target, true, true)
          : this.showPopover(target, button);
    }
    if (!dialog || isPopoverOpen(target)) return false;
    const open = attr(target, 'open') !== undefined;
    const value = attr(button, 'value') ?? null;
    if (command === 'close') return open && this.closeDialog(target, value);
    if (command === 'request-close')
      return open && this.requestClose(target, value);
    return !open && this.showModal(target);
  }

  // --- popovers ---------------------------------------------------------------

  /** Whether a popover can be shown (`showing` false) or hidden (true):
   *  HTML's "check popover validity", which throws in a script and here
   *  only says no. */
  private _popoverValid(el: Element, showing: boolean): boolean {
    if (!popoverType(el) || !this._connected(el)) return false;
    if (isPopoverOpen(el) !== showing) return false;
    // a dialog open as a dialog is no popover to show
    if (!showing && tagOf(el) === 'dialog' && attr(el, 'open') !== undefined) {
      return false;
    }
    return !isModal(el);
  }

  /** The nearest showing auto popover around a node, or itself. */
  private _openAround(node: Element | null): Element | null {
    for (let at = node; at; at = flatParentOf(at)) {
      if (this._autos.includes(at)) return at;
    }
    return null;
  }

  /** The popover a button around a node targets, where it is a showing
   *  auto one (HTML's "nearest inclusive target popover"). */
  private _targetedAround(node: Element | null): Element | null {
    for (let at = node; at; at = flatParentOf(at)) {
      const target = commandForElement(at) ?? popoverTargetOf(at);
      if (target && this._autos.includes(target)) return target;
    }
    return null;
  }

  /** The later in the stack of two popovers, either of which may be none. */
  private _later(a: Element | null, b: Element | null): Element | null {
    return this._autos.indexOf(a!) >= this._autos.indexOf(b!) ? a : b;
  }

  /** HTML's "topmost popover ancestor": what a popover shown from `invoker`
   *  is shown inside, which showing it leaves open. */
  private _ancestorOf(el: Element, invoker: Element | null): Element | null {
    const parent = flatParentOf(el);
    return this._later(
      this._openAround(parent),
      invoker ? this._openAround(invoker) : null,
    );
  }

  /** HTML's "hide all popovers until": every auto popover shown after
   *  `endpoint`, the last first — all of them, given none. */
  hidePopoversUntil(endpoint: Element | null, focusPrevious: boolean): void {
    this._sync();
    const keep = endpoint ? this._autos.indexOf(endpoint) + 1 : 0;
    while (this._autos.length > keep) {
      const top = this._autos[this._autos.length - 1];
      if (!this.hidePopover(top, focusPrevious, true)) {
        // a popover that would not go keeps none above it from going
        this._autos.pop();
      }
    }
  }

  /** HTML's "show popover": told as `beforetoggle`, which the host may
   *  cancel, the auto popovers it is not in hidden, then in the top layer,
   *  and `toggle`. `source` is what showed it, its implicit anchor. */
  showPopover(el: Element, source: Element | null = null): boolean {
    this._sync();
    if (!this._popoverValid(el, false)) return false;
    const toggle = { oldState: 'closed', newState: 'open' } as const;
    if (!this._deps.fire('beforetoggle', el, toggle, true)) return false;
    if (!this._popoverValid(el, false)) return false;
    const type = popoverType(el);
    if (type === 'auto' || type === 'hint') {
      this.hidePopoversUntil(this._ancestorOf(el, source), false);
      // a popover hidden by that may have been this one's ancestor, or it
      if (!this._popoverValid(el, false)) return false;
    }
    const previous = this._deps.activeElement();
    if (!setPopoverOpen(el, true, source)) return false;
    if (type === 'auto' || type === 'hint') this._autos.push(el);
    this._openedAt.set(el, (this._opened += 1));
    this._previous.set(el, previous);
    this._deps.touch([
      { type: 'attributes', target: el, attributeName: '-rx-popover-open' },
    ]);
    // HTML's "popover focusing steps": only where something in it asks
    const control = autofocusIn(el);
    if (control) this._deps.focus(control);
    this._deps.fire('toggle', el, toggle);
    return true;
  }

  /** HTML's "hide popover": the auto popovers shown after it hidden first,
   *  told as `beforetoggle` and then `toggle`, out of the top layer, and the
   *  focus given back where it was in it. */
  hidePopover(
    el: Element,
    focusPrevious: boolean,
    fireEvents: boolean,
  ): boolean {
    this._sync();
    if (!this._popoverValid(el, true)) return false;
    const at = this._autos.indexOf(el);
    if (at >= 0) {
      this.hidePopoversUntil(el, focusPrevious);
      if (!isPopoverOpen(el)) return false;
    }
    const toggle = { oldState: 'open', newState: 'closed' } as const;
    if (fireEvents) this._deps.fire('beforetoggle', el, toggle, false);
    if (!isPopoverOpen(el)) return false;
    const active = this._deps.activeElement();
    setPopoverOpen(el, false);
    const i = this._autos.indexOf(el);
    if (i >= 0) this._autos.splice(i, 1);
    this._deps.touch([
      { type: 'attributes', target: el, attributeName: '-rx-popover-open' },
    ]);
    if (fireEvents) this._deps.fire('toggle', el, toggle);
    const previous = this._previous.get(el) ?? null;
    this._previous.delete(el);
    if (
      focusPrevious &&
      previous &&
      previous !== el &&
      active &&
      contains(el, active) &&
      this._connected(previous)
    ) {
      this._deps.focus(previous);
    }
    return true;
  }

  // --- dialogs ----------------------------------------------------------------

  /** HTML's "show a modal dialog": told as `beforetoggle`, which the host
   *  may cancel, then open, modal, over the popovers it is not in, which
   *  close, and focused (the dialog focusing steps). */
  showModal(dialog: Element): boolean {
    this._sync();
    if (attr(dialog, 'open') !== undefined) return false;
    if (!this._connected(dialog) || isPopoverOpen(dialog)) return false;
    const toggle = { oldState: 'closed', newState: 'open' } as const;
    if (!this._deps.fire('beforetoggle', dialog, toggle, true)) return false;
    if (attr(dialog, 'open') !== undefined || !this._connected(dialog)) {
      return false;
    }
    const previous = this._deps.activeElement();
    dialog.attribs.open = '';
    setModal(dialog, true);
    this._dialogs = this._dialogs.filter((d) => d !== dialog);
    this._dialogs.push(dialog);
    this._openedAt.set(dialog, (this._opened += 1));
    this._previous.set(dialog, previous);
    this._deps.touch([
      {
        type: 'attributes',
        target: dialog,
        attributeName: 'open',
        oldValue: null,
      },
      { type: 'attributes', target: dialog, attributeName: '-rx-modal' },
    ]);
    this.hidePopoversUntil(this._openAround(flatParentOf(dialog)), false);
    this._deps.focus(dialogFocusTarget(dialog));
    this._deps.fire('toggle', dialog, toggle);
    return true;
  }

  /** HTML's "close the dialog": told as `beforetoggle`, then not drawn, not
   *  modal, the focus given back, and `toggle` and `close` told, the last
   *  with the dialog's return value where it was given one. */
  closeDialog(dialog: Element, result: string | null): boolean {
    if (attr(dialog, 'open') === undefined) return false;
    const toggle = { oldState: 'open', newState: 'closed' } as const;
    this._deps.fire('beforetoggle', dialog, toggle, false);
    if (attr(dialog, 'open') === undefined) return false;
    const wasModal = isModal(dialog);
    const active = this._deps.activeElement();
    delete dialog.attribs.open;
    const changes: HtmlChange[] = [
      {
        type: 'attributes',
        target: dialog,
        attributeName: 'open',
        oldValue: '',
      },
    ];
    if (setModal(dialog, false)) {
      changes.push({
        type: 'attributes',
        target: dialog,
        attributeName: '-rx-modal',
      });
    }
    this._dialogs = this._dialogs.filter((d) => d !== dialog);
    this._deps.touch(changes);
    const previous = this._previous.get(dialog) ?? null;
    this._previous.delete(dialog);
    if (
      previous &&
      previous !== dialog &&
      this._connected(previous) &&
      (wasModal || (active && contains(dialog, active)))
    ) {
      this._deps.focus(previous);
    }
    this._deps.fire('toggle', dialog, toggle);
    this._deps.fire(
      'close',
      dialog,
      result === null ? {} : { returnValue: result },
    );
    return true;
  }

  /** HTML's "request close": `cancel` first, which the host may cancel,
   *  then closed. */
  requestClose(dialog: Element, result: string | null): boolean {
    if (attr(dialog, 'open') === undefined || !this._connected(dialog)) {
      return false;
    }
    if (!this._deps.fire('cancel', dialog, {}, true)) return true;
    return this.closeDialog(dialog, result);
  }

  /**
   * A `<form method="dialog">` sent, past its validation and its `submit`
   * (HTML 4.10.21.3, step 11): the dialog around it closed, its return
   * value the submitter's value — an image button's, where it was pressed.
   * Whether the form was a dialog's to close, which a form with none
   * around it is not, and sends nothing all the same.
   */
  submitted(
    form: Element,
    submitter: Element | null,
    point?: DocumentPoint,
  ): boolean {
    if (!this.sendsToDialog(form, submitter)) return false;
    let dialog: Element | null = null;
    for (let at = form.parent; at; at = at.parent) {
      if (isElement(at) && tagOf(at) === 'dialog') {
        dialog = at;
        break;
      }
    }
    if (!dialog) return true;
    let result: string | null = null;
    if (
      submitter &&
      tagOf(submitter) === 'input' &&
      (attr(submitter, 'type') ?? '').trim().toLowerCase() === 'image'
    ) {
      result = point ? `${Math.round(point.x)},${Math.round(point.y)}` : '0,0';
    } else if (submitter) result = attr(submitter, 'value') ?? '';
    this.closeDialog(dialog, result);
    return true;
  }

  /** Whether a form sent by `submitter` is a dialog's, by its method —
   *  the submitter's `formmethod`, else the form's `method`. */
  sendsToDialog(form: Element, submitter: Element | null): boolean {
    const method =
      (submitter ? attr(submitter, 'formmethod') : undefined) ??
      attr(form, 'method') ??
      '';
    return method.trim().toLowerCase() === 'dialog';
  }

  // --- light dismiss and close requests ----------------------------------------

  /** The open dialog a press is in: none for a modal one's backdrop, which
   *  is around its box (HTML's "nearest clicked dialog"). */
  private _clickedDialog(
    target: Element | null,
    point: DocumentPoint,
  ): Element | null {
    if (target && tagOf(target) === 'dialog' && isModal(target)) {
      const box = this._deps.rectOf(target);
      if (
        !box ||
        point.x < box.x ||
        point.x > box.x + box.width ||
        point.y < box.y ||
        point.y > box.y + box.height
      ) {
        return null;
      }
    }
    for (let at = target; at; at = flatParentOf(at)) {
      if (tagOf(at) === 'dialog' && attr(at, 'open') !== undefined) return at;
    }
    return null;
  }

  /**
   * A press, or its release, at `target` (HTML 6.12 and 4.11.4, "light
   * dismiss"): a release where the press was hides the auto popovers that
   * neither it is in nor a button it is on shows, and closes the last open
   * dialog where its `closedby` is `any` and the press was outside it.
   */
  pointer(
    type: 'down' | 'up',
    target: Element | null,
    point: DocumentPoint,
  ): void {
    this._sync();
    if (this._autos.length) {
      const ancestor = this._later(
        this._openAround(target),
        this._targetedAround(target),
      );
      if (type === 'down') this._pressedPopover = ancestor;
      else {
        const same = ancestor === this._pressedPopover;
        this._pressedPopover = undefined;
        if (same) this.hidePopoversUntil(ancestor, false);
      }
    }
    if (!this._dialogs.length) return;
    const clicked = this._clickedDialog(target, point);
    if (type === 'down') {
      this._pressedDialog = clicked;
      return;
    }
    const same = clicked === this._pressedDialog;
    this._pressedDialog = undefined;
    const top = this._dialogs[this._dialogs.length - 1];
    if (!same || clicked === top || closedByOf(top) !== 'any') return;
    this.requestClose(top, null);
  }

  /**
   * A close request — Escape, which nothing cancelled (HTML 7.7.2) — at the
   * last open dialog or showing auto popover: a popover hidden, or the
   * dialog's request close where its `closedby` lets one close it. Whether
   * there was anything to take it, which keeps it from going further.
   */
  closeRequest(): boolean {
    this._sync();
    const dialog = this._dialogs[this._dialogs.length - 1] ?? null;
    const popover = this._autos[this._autos.length - 1] ?? null;
    const at = (el: Element | null) =>
      el ? (this._openedAt.get(el) ?? 0) : -1;
    if (popover && at(popover) > at(dialog)) {
      this.hidePopover(popover, true, true);
      return true;
    }
    if (!dialog) return false;
    // one `closedby` says nothing closes takes the request all the same
    if (closedByOf(dialog) !== 'none') this.requestClose(dialog, null);
    return true;
  }
}

/** Whether `inner` is `outer` or in it, in the flat tree. */
function contains(outer: Element, inner: Element): boolean {
  for (let at: Element | null = inner; at; at = flatParentOf(at)) {
    if (at === outer) return true;
  }
  return false;
}

/** What a walk of a subtree for the focus passes over: what is not
 *  rendered by its markup — `hidden`, `inert`, a closed details' content —
 *  and a dialog or popover in it that is not showing. */
function passedOver(el: Element): boolean {
  if (attr(el, 'hidden') !== undefined || attr(el, 'inert') !== undefined) {
    return true;
  }
  const tag = tagOf(el);
  if (tag === 'dialog' && attr(el, 'open') === undefined) return true;
  return popoverType(el) !== null && !isPopoverOpen(el);
}

/** The descendants of `root` in flat tree order that `want` takes, walked
 *  as far as the first. */
function firstIn(
  root: Element,
  want: (el: Element) => boolean,
): Element | null {
  const walk = (node: Element): Element | null => {
    const closedDetails =
      tagOf(node) === 'details' && attr(node, 'open') === undefined;
    for (const child of flatChildrenOf(node)) {
      if (!isElement(child) || passedOver(child)) continue;
      if (closedDetails && !isSummaryOf(child)) continue;
      if (want(child)) return child;
      const inner = walk(child);
      if (inner) return inner;
    }
    return null;
  };
  return walk(root);
}

/** The first focusable area in a subtree that says `autofocus`. */
function autofocusIn(root: Element): Element | null {
  if (attr(root, 'autofocus') !== undefined) return root;
  return firstIn(
    root,
    (el) => attr(el, 'autofocus') !== undefined && focusableElement(el),
  );
}

/** HTML's "dialog focusing steps" (4.11.4.2): the dialog where it says
 *  `autofocus`, else what in it does, else the first thing in it Tab
 *  reaches, else the dialog. */
function dialogFocusTarget(dialog: Element): Element {
  return (
    autofocusIn(dialog) ??
    firstIn(dialog, (el) => focusableElement(el) && isTabbable(el)) ??
    dialog
  );
}
