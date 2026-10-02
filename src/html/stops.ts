// The keyboard's way through a document: the boxes that take the focus for
// what the document draws, and Tab in the document's order.
//
// A form control's widget takes the focus itself (`widgets.ts`). A link, a
// `<button>`, a summary, an element a `tabindex` makes focusable is drawn,
// and a drawing takes no focus — so each is given a **stop**: a `<box>` over
// the element with no paint and no hit area, which core focuses as it does
// any node. Its ring, `:focus` and `:focus-visible`, is the document's to
// draw, round the element as the page styles it (`HtmlViewNode.setFocus`);
// core scrolls it into view as it scrolls any node it focuses; an assistive
// technology hears a link or a button, named.
//
// **Only a few are mounted.** A page of links is thousands of them, and a
// box each is a node core walks for every hit test and every paint. The
// ones mounted are where Tab can come into the document — its first and its
// last — and the one focused with the ones either side of it: Tab goes from
// one to the next itself (`onKeyDown`), in the order the markup has them,
// widgets and stops alike, and a stop it goes to that is not mounted yet is
// mounted and then focused. Where Tab runs off the end, nothing here takes
// the key, and the window's order goes on from the stop or the widget
// focused, which is the last of the document's in tree order — the boxes
// and the widgets are mounted in the document's order — so it leaves the
// document as it would leave any subtree.
import React from 'react';
import type { ReactNode } from 'react';
import { useClipboard } from 'react-x11';
import type {
  DrawnNode,
  KeyboardEvent as X11KeyboardEvent,
  MouseEvent as X11MouseEvent,
} from 'react-x11';
import {
  XK_KP_ENTER,
  XK_RETURN,
  XK_SPACE,
  XK_TAB,
  ctrlChordLetter,
} from 'react-x11/keysyms';

import type {} from 'react-x11/jsx-runtime';

import { hx } from './hx.js';
import { attr, childrenOf, isElement, isText, tagOf } from './dom.js';
import type { Element } from './dom.js';
import { stepFrom } from './focus.js';
import type { FocusStop } from './focus.js';
import type { HtmlViewNode } from './node.js';
import type { Forms } from './widgets.js';

export interface StopsOptions {
  view: React.RefObject<HtmlViewNode | null>;
  /** The component's root, the selection's surface. */
  root: React.RefObject<DrawnNode | null>;
  forms: Forms;
  selectable: boolean;
  onLink?: (href: string, ev: X11MouseEvent<DrawnNode>) => void;
}

export interface Stops {
  /** The element's `onFocusStops` and `watchStops`. */
  onFocusStops: (stops: readonly FocusStop[]) => void;
  watch: readonly Element[];
  /** The boxes mounted, in the document's order, each with its element. */
  render(): { element: Element; node: ReactNode }[];
  /** Where an element stands among the document's focusable areas. */
  orderOf(el: Element): number | undefined;
  /** The root's: Tab, and where a press leaves Tab to go on from. */
  onKeyDown: (ev: X11KeyboardEvent<DrawnNode>) => void;
  onMouseDown: (ev: X11MouseEvent<DrawnNode>) => void;
  /** Whether the document has stops of its own, which Tab goes to rather
   *  than to the document's surface; null until it has been laid out. */
  hasStops: boolean | null;
}

const NONE: readonly FocusStop[] = [];
const NO_ELEMENTS: readonly Element[] = [];

export function useFocusStops(options: StopsOptions): Stops {
  const { view, root, forms, selectable, onLink } = options;
  const clipboard = useClipboard();
  const [stops, setStops] = React.useState<readonly FocusStop[]>(NONE);
  const reported = stops !== NONE;
  // the element whose stop or widget Tab last went to, or that took the
  // focus — what the boxes mounted are around
  const [anchor, setAnchor] = React.useState<Element | null>(null);
  // a stop Tab went to before its box was mounted
  const [pending, setPending] = React.useState<Element | null>(null);
  // where a press in the document last landed, which Tab goes on from
  const start = React.useRef<Element | null>(null);
  const boxes = React.useMemo(
    () =>
      new StopBoxes((el) => {
        // core forgets a node that unmounts with the focus, and tells no
        // one: the document is told here
        const node = view.current;
        if (node?.focusedElement === el) node.setFocus(null);
      }),
    [view],
  );

  const index = React.useMemo(() => {
    const map = new Map<Element, number>();
    stops.forEach((s, i) => map.set(s.element, i));
    return map;
  }, [stops]);

  const shown = React.useMemo(
    () => mountedStops(stops, index, anchor, pending),
    [stops, index, anchor, pending],
  );
  // where the one at full size is, for it to follow its element
  const watch = React.useMemo(
    () =>
      anchor && shown.some((s) => s.element === anchor)
        ? [anchor]
        : NO_ELEMENTS,
    [anchor, shown],
  );
  const hasStops = React.useMemo(
    () => (reported ? stops.some((s) => s.tabbable) : null),
    [stops, reported],
  );

  React.useLayoutEffect(() => {
    if (!pending) return;
    setPending(null);
    boxes.node(pending)?.focus();
  }, [pending, boxes]);

  /** Tab arrives at a stop, or at a control's widget. */
  const go = (stop: FocusStop) => {
    setAnchor(stop.element);
    if (stop.widget) {
      forms.focusControl(stop.element);
      return;
    }
    const node = boxes.node(stop.element);
    if (node) node.focus();
    else setPending(stop.element);
  };

  const onKeyDown = (ev: X11KeyboardEvent<DrawnNode>) => {
    if (ev.defaultPrevented || ev.keysym !== XK_TAB) return;
    // Ctrl+Tab and its kin are the application's chords, not traversal
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const node = view.current;
    if (!node || !stops.length) return;
    const target = ev.target as DrawnNode;
    let from = boxes.elementOf(target) ?? forms.controlOf(target);
    if (!from) {
      // the document itself, focused by a press: on from where it landed
      if (target !== root.current && target !== (node as unknown)) return;
      from = start.current;
    }
    const next = stepFrom(stops, from, ev.shiftKey);
    // off the end: the window's order takes it on out of the document
    if (!next) return;
    ev.preventDefault();
    go(next);
  };

  const onMouseDown = (ev: X11MouseEvent<DrawnNode>) => {
    if (ev.button !== 1) return;
    const node = view.current;
    if (!node || ev.target !== (node as unknown)) return;
    start.current = node.elementAtPoint(ev.x, ev.y);
  };

  /** A key on a stop: Enter follows a link, Enter or Space presses a
   *  button, and the selection's chords reach the document's selection. */
  const keyDown = (el: Element, ev: X11KeyboardEvent<DrawnNode>) => {
    if (ev.defaultPrevented) return;
    // Core runs Ctrl+A and Ctrl+C as the surface's own default action, on
    // the surface focused (`TextSelection.keyDown`, by the same rule); a
    // stop inside it is focused instead, and the document's selection is
    // still what they are for.
    if (selectable && ev.ctrlKey) {
      const letter = ctrlChordLetter(ev);
      const surface = root.current;
      if (letter === 0x61 /* a */ && surface) {
        surface.selectAll();
        ev.preventDefault();
        return;
      }
      if (letter === 0x63 /* c */ && surface) {
        const text = surface.selectedText();
        if (text) clipboard.writeText(text).catch(() => {});
        ev.preventDefault();
        return;
      }
    }
    const enter = ev.keysym === XK_RETURN || ev.keysym === XK_KP_ENTER;
    const space = ev.keysym === XK_SPACE || ev.codepoint === 32;
    const node = view.current;
    if (!node || !(enter || space)) return;
    const href = node.hrefOf(el);
    if (href !== null) {
      // a link is followed by Enter alone: Space is the page's
      if (!enter) return;
      ev.preventDefault();
      onLink?.(href, keyboardClick(ev, node, root.current, el));
      return;
    }
    if (forms.activate(el)) ev.preventDefault();
  };

  const render = () => {
    const node = view.current;
    if (!node) return [];
    const out: { element: Element; node: ReactNode }[] = [];
    for (const stop of shown) {
      const el = stop.element;
      const rect = node.stopRect(el);
      if (!rect) continue;
      // The one Tab is at is as big as its element, which is what core
      // scrolls into view; the rest are a point at its corner, where
      // mounting one damages nothing and costs the document no repaint.
      const sized = el === anchor;
      const link = node.hrefOf(el) !== null;
      const role = link ? 'link' : BUTTONS.has(tagOf(el)) ? 'button' : null;
      out.push({
        element: el,
        node: hx('box', {
          key: `stop:${boxes.idOf(el)}`,
          ref: boxes.refOf(el),
          tabIndex: stop.tabbable ? 0 : -1,
          selectable: false,
          ...(role && { role }),
          'aria-label': nameOf(el),
          style: {
            position: 'absolute',
            left: rect.x,
            top: rect.y,
            width: sized ? rect.width : 0,
            height: sized ? rect.height : 0,
            // nothing to see and nothing to press: the document draws the
            // element, its ring included, and takes its presses
            pointerEvents: 'none',
            outlineWidth: 0,
          },
          onFocus: () => {
            setAnchor(el);
            forms.focused(el, true);
          },
          onBlur: () => forms.focused(el, false),
          onKeyDown: (ev: X11KeyboardEvent<DrawnNode>) => keyDown(el, ev),
        } as Record<string, unknown>),
      });
    }
    return out;
  };

  return {
    onFocusStops: setStops,
    watch,
    render,
    orderOf: (el) => index.get(el),
    onKeyDown,
    onMouseDown,
    hasStops,
  };
}

/** Markup that can make a focusable area (`focusableElement`): a superset,
 *  read from a source before it is laid out. */
const FOCUSABLE_MARKUP =
  /<(?:a|area)\b[^>]*?\shref\b|<(?:button|summary|input|select|textarea)\b|\stabindex\s*=/i;

/**
 * Whether a source can have stops of its own, as it is handed over: what
 * the root's place in the Tab order is decided from until the document has
 * been laid out and says which it has, so that it is right in the first
 * render. Said in the second, it was a prop of the root's that changed, and
 * the whole document painted again. A source that grows is read on from
 * the last `<` before where it was read to (`useCodeFamily`, index.ts).
 */
export function useFocusableMarkup(source: string): boolean {
  const read = React.useRef({ source: '', found: false });
  const seen = read.current;
  if (!seen.found && source !== seen.source) {
    const from = source.startsWith(seen.source)
      ? Math.max(0, source.lastIndexOf('<', seen.source.length))
      : 0;
    seen.found = FOCUSABLE_MARKUP.test(from ? source.slice(from) : source);
    seen.source = source;
  }
  return seen.found;
}

/** The tags whose stop an assistive technology hears as a button. */
const BUTTONS = new Set(['button', 'summary', 'input']);

/**
 * The stops whose boxes are mounted, in the document's order: the first and
 * the last tabbable ones, where Tab comes into the document from either
 * side; the one focused, and the tabbable ones before and after it, which
 * Tab goes to next; and one Tab went to that is still to be mounted. A
 * widget's is none of them: it is mounted whatever has the focus.
 */
function mountedStops(
  stops: readonly FocusStop[],
  index: ReadonlyMap<Element, number>,
  anchor: Element | null,
  pending: Element | null,
): FocusStop[] {
  const picked = new Set<number>();
  const tabbable = (from: number, step: number): number => {
    for (let i = from; i >= 0 && i < stops.length; i += step) {
      if (stops[i].tabbable) return i;
    }
    return -1;
  };
  picked.add(tabbable(0, 1));
  picked.add(tabbable(stops.length - 1, -1));
  const at = anchor ? index.get(anchor) : undefined;
  if (at !== undefined) {
    picked.add(at);
    picked.add(tabbable(at - 1, -1));
    picked.add(tabbable(at + 1, 1));
  }
  const waiting = pending ? index.get(pending) : undefined;
  if (waiting !== undefined) picked.add(waiting);
  return [...picked]
    .filter((i) => i >= 0 && !stops[i].widget)
    .sort((a, b) => a - b)
    .map((i) => stops[i]);
}

/**
 * The click a link is followed with from the keyboard, as a browser's
 * keyboard activation is one (HTML 6.5.6): a `MouseEvent` with `detail` 0,
 * the key's modifiers — Ctrl+Enter opens a link in the background where
 * Ctrl+click does — and its point on the link, the middle of its first
 * fragment, so a handler asking what is under the click (`elementAt`)
 * finds the link.
 */
function keyboardClick(
  ev: X11KeyboardEvent<DrawnNode>,
  node: HtmlViewNode,
  root: DrawnNode | null,
  el: Element,
): X11MouseEvent<DrawnNode> {
  const origin = node.getClientRects()[0];
  const point = node.focusPoint(el);
  const x = (origin?.x ?? 0) + (point?.x ?? 0);
  const y = (origin?.y ?? 0) + (point?.y ?? 0);
  const scale = node.scale;
  let defaultPrevented = false;
  let propagationStopped = false;
  return {
    type: 'click',
    // where a click on the link is heard, and what it lands on
    target: node as unknown as DrawnNode,
    currentTarget: root,
    x,
    y,
    localX: x - (origin?.x ?? 0),
    localY: y - (origin?.y ?? 0),
    nativeEvent: { ...ev.nativeEvent, x: x * scale, y: y * scale },
    shiftKey: ev.shiftKey,
    ctrlKey: ev.ctrlKey,
    altKey: ev.altKey,
    metaKey: ev.metaKey,
    button: 1,
    detail: 0,
    get defaultPrevented() {
      return defaultPrevented;
    },
    get propagationStopped() {
      return propagationStopped;
    },
    preventDefault() {
      defaultPrevented = true;
    },
    stopPropagation() {
      propagationStopped = true;
    },
    capturePointer() {},
    releasePointer() {},
  };
}

/**
 * What an assistive technology calls a stop: the element's `aria-label`,
 * or its text, or the `alt` of the images in it — a preview that is a link
 * round a picture — or its `title`; an image button's `alt`. Not the whole of the accessible name
 * computation, which is more than a stop needs to be heard by.
 */
function nameOf(el: Element): string | undefined {
  const label = attr(el, 'aria-label')?.trim();
  if (label) return label;
  // an image button, which is its picture
  if (tagOf(el) === 'input') {
    return attr(el, 'alt')?.trim() || attr(el, 'value')?.trim() || undefined;
  }
  const parts: string[] = [];
  const walk = (node: Element) => {
    for (const child of childrenOf(node)) {
      if (isText(child)) parts.push(child.data);
      else if (isElement(child)) {
        if (tagOf(child) === 'img') parts.push(attr(child, 'alt') ?? '');
        else walk(child);
      }
    }
  };
  walk(el);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  return attr(el, 'title')?.trim() || attr(el, 'value')?.trim() || undefined;
}

/** Each stop's box, by element: the key it is mounted under, and the node
 *  to focus. */
class StopBoxes {
  private _ids = new WeakMap<Element, number>();
  private _next = 0;
  private _nodes = new Map<Element, DrawnNode>();
  private _elements = new WeakMap<DrawnNode, Element>();
  private _refs = new WeakMap<Element, (node: DrawnNode | null) => void>();

  /** `gone` hears of each element whose box unmounted. */
  constructor(private readonly _gone: (el: Element) => void) {}

  idOf(el: Element): number {
    let id = this._ids.get(el);
    if (id === undefined) this._ids.set(el, (id = ++this._next));
    return id;
  }

  refOf(el: Element): (node: DrawnNode | null) => void {
    let ref = this._refs.get(el);
    if (!ref) {
      ref = (node) => {
        if (node) {
          this._nodes.set(el, node);
          this._elements.set(node, el);
        } else if (this._nodes.get(el)) {
          this._nodes.delete(el);
          this._gone(el);
        }
      };
      this._refs.set(el, ref);
    }
    return ref;
  }

  node(el: Element): DrawnNode | null {
    return this._nodes.get(el) ?? null;
  }

  elementOf(node: DrawnNode | null): Element | null {
    const el = node ? this._elements.get(node) : undefined;
    return el && this._nodes.get(el) === node ? el : null;
  }
}
