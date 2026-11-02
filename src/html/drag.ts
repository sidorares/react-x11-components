// A document's HTML drag and drop, over core's: `dragstart`, `drag`,
// `dragenter`, `dragover`, `dragleave`, `drop` and `dragend`, each told to the
// host before what it does, with what is being dragged.
//
// **This is a layer and core is the engine** (AGENTS.md, "A sortable layer over
// core's drag and drop"). Core has the threshold, click suppression, edge
// auto-scroll and XDND; what is here is HTML's half. The root is core's one
// draggable and its one drop target, and which element is being dragged, and
// which is under the pointer, is worked out from the document, since a
// document is one node.
//
// Core takes `dragData` before it dispatches `onDragStart`, so the root's is
// fixed, thunks of the types another application can use, each answering what
// the page wrote into its store at `dragstart`. A drag inside the document
// goes by `active`, which is this process's drag, and reaches a frame's
// `<Html>` the same way. What comes from another application is no store
// anyone can read until it is dropped, as HTML has it: its types are known
// while it is over the document, and its text and its files at the drop, read
// through `onDropFiles`, which a host hands in.
import React from 'react';
import type { DrawnNode } from 'react-x11';

import type { ClipboardEntryWire } from './clipboard.js';
import { attr, flatParentOf, tagOf } from './dom.js';
import type { Element } from './dom.js';
import { documentPoint, fireDomEvent, modifiersOf } from './dom-events.js';
import type { DomEventHandler, HtmlDomEventType } from './dom-events.js';
import type { Embedded } from './embedded.js';
import { resolveUrl } from './url.js';
import type { HtmlFile } from './files.js';
import { isEditingHost } from './focus.js';
import { inputType } from './form.js';
import type { HtmlViewNode } from './node.js';

/** What a drag carries, as a host and a page's realm are told it. */
export interface HtmlDragData {
  /** Its text, a type each. One with no text is a type known and not yet
   *  readable: what another application offers until it is dropped. */
  entries: ClipboardEntryWire[];
  /** Its files, once they can be read. */
  files?: readonly HtmlFile[];
  /** Whether files are in it, which is known before they can be read. */
  hasFiles?: boolean;
  /** `dataTransfer.effectAllowed`. */
  effectAllowed: string;
  /** `dataTransfer.dropEffect`, which a page sets at `dragover`. */
  dropEffect: string;
}

/** Text that cannot be read yet stands for itself: `s` is left out. */
const NAMED_TYPES = ['text/plain', 'text/html', 'text/uri-list'];

/** The drag this process is carrying, whichever `<Html>` it started in. */
let active: HtmlDragData | null = null;

/** What marks a drag as a document's, to `dropAccept`. */
const OWN_TYPE = 'application/x-react-x11-html-drag';

const textOf = (type: string) => (): string =>
  active?.entries.find((entry) => entry.t === type)?.s ?? '';

/** The root's `dragData`: see the head of this file. */
const DRAG_DATA: Record<string, () => string> = {
  [OWN_TYPE]: () => '',
  ...Object.fromEntries(NAMED_TYPES.map((type) => [type, textOf(type)])),
};

/** What dragging starts from, around a press (HTML 6.11.4): an element a
 *  page marked, a link or an image, and nothing past one marked `false`. */
function draggableFrom(at: Element | null): Element | null {
  for (let el = at; el; el = flatParentOf(el)) {
    // what a press edits, or opens, is that press's, in whatever it is in
    if (el === at && (takesText(el) || tagOf(el) === 'select')) return null;
    const said = attr(el, 'draggable')?.trim().toLowerCase();
    if (said === 'true') return el;
    if (said === 'false') return null;
    const tag = tagOf(el);
    if (tag === 'img' || (tag === 'a' && attr(el, 'href') !== undefined)) {
      return el;
    }
  }
  return null;
}

/** What a link or an image brings to a drag before a page says anything. */
function defaultEntries(
  el: Element,
  base: string | null | undefined,
): ClipboardEntryWire[] {
  const tag = tagOf(el);
  const written = tag === 'a' ? attr(el, 'href') : attr(el, 'src');
  if ((tag !== 'a' && tag !== 'img') || !written) return [];
  const url = resolveUrl(written, base ?? null);
  return [
    { t: 'text/uri-list', s: url },
    { t: 'text/plain', s: url },
  ];
}

/** Whether what is under a drag takes text with nothing of a page's say. */
function takesText(el: Element): boolean {
  const tag = tagOf(el);
  if (tag === 'textarea') return attr(el, 'readonly') === undefined;
  if (tag === 'input') {
    return (
      attr(el, 'readonly') === undefined && !NO_TEXT_INPUTS.has(inputType(el))
    );
  }
  for (let at: Element | null = el; at; at = flatParentOf(at)) {
    if (isEditingHost(at)) return true;
  }
  return false;
}
const NO_TEXT_INPUTS = new Set([
  'checkbox',
  'radio',
  'file',
  'hidden',
  'range',
  'color',
  'submit',
  'reset',
  'button',
  'image',
]);

/** The `dropEffect` a drag starts from over an element (HTML 6.11.5). */
function effectFor(allowed: string): string {
  if (allowed === 'none') return 'none';
  if (allowed === 'move') return 'move';
  if (allowed === 'link' || allowed === 'linkMove') return 'link';
  return 'copy';
}

/** Whether a source's `effectAllowed` lets a `dropEffect` be. */
function effectAllows(allowed: string, effect: string): boolean {
  if (effect === 'none') return false;
  if (allowed === 'all' || allowed === 'uninitialized') return true;
  return allowed.toLowerCase().includes(effect);
}

export interface DocumentDragOptions {
  view: React.RefObject<HtmlViewNode | null>;
  baseUrl: string | null | undefined;
  onDomEvent?: DomEventHandler;
  embedded: Embedded;
  /** The element the press was on. */
  pressed(): Element | null;
  /** The control a node is the widget of. */
  controlOf(node: DrawnNode | null): Element | null;
  /** Read what another application dropped. Absent, the document takes
   *  nothing from outside the process. */
  onDropFiles?: (paths: string[]) => Promise<readonly HtmlFile[]>;
}

/** What another application's drop came to, as a host hands it on. */
export interface HtmlDrop {
  /** Where, in the window's logical pixels. */
  x: number;
  y: number;
  /** The types offered. */
  types: readonly string[];
  /** Local paths, at a drop. */
  paths?: readonly string[];
  /** Its text, at a drop. */
  text?: string;
  html?: string;
}

/** What a drag event of core's has, of what is here. */
interface CoreDragEvent {
  target: unknown;
  x: number;
  y: number;
  types: string[];
  source: 'internal' | 'external';
  action: string | null;
  files?: { uri: string; path?: string }[];
  text?: string;
  getData?(type: string): Promise<unknown>;
  preventDefault(): void;
  accept(action?: string): void;
  reject(): void;
}

/** The root's drag props, and what a host that takes drops for the document
 *  hands it: a `<Frame>` pane has no window of its own for one to land on. */
export function useDocumentDrag(options: DocumentDragOptions): {
  rootProps: Record<string, unknown>;
  /** Whether the press under way is on what a drag can start from. */
  pressCanDrag(): boolean;
  external: {
    over(drop: HtmlDrop): boolean;
    leave(): void;
    drop(drop: HtmlDrop): Promise<boolean>;
  };
} {
  const latest = React.useRef(options);
  latest.current = options;
  /** The element the drag started on, while it is this document's. */
  const source = React.useRef<Element | null>(null);
  /** The element under the drag, and the effect its last `dragover` left. */
  const current = React.useRef<Element | null>(null);
  const effect = React.useRef('none');
  /** Whether the drag would land where it is, where core cannot say. */
  const droppable = React.useRef(false);
  /** Whether a point is on the document. */
  const inside = (point: { x: number; y: number }): boolean => {
    const box = originOf();
    return (
      !!box &&
      point.x >= box.x &&
      point.y >= box.y &&
      point.x < box.x + box.width &&
      point.y < box.y + box.height
    );
  };

  const fire = (
    type: HtmlDomEventType,
    target: Element,
    point: { x: number; y: number } | undefined,
    drag: HtmlDragData,
    mods?: unknown,
    relatedTarget?: Element | null,
  ): boolean =>
    fireDomEvent(latest.current.onDomEvent, type, target, {
      ...(point && documentPoint(point, originOf())),
      ...modifiersOf(mods as never),
      relatedTarget,
      drag,
    });
  const originOf = () => latest.current.view.current?.getClientRects()[0];

  const elementUnder = (
    point: { x: number; y: number },
    node: DrawnNode | null,
  ): Element | null => {
    const { view, controlOf } = latest.current;
    return (
      controlOf(node) ?? view.current?.elementAtPoint(point.x, point.y) ?? null
    );
  };

  /** A step over the document, told as `dragleave`, `dragenter` and
   *  `dragover`, and whether what is under it would take the drop. */
  const over = (
    point: { x: number; y: number },
    node: DrawnNode | null,
    drag: HtmlDragData,
    mods?: unknown,
  ): boolean => {
    const el = elementUnder(point, node);
    const was = current.current;
    if (el !== was) {
      current.current = el;
      if (el) {
        fire(
          'dragenter',
          el,
          point,
          { ...drag, dropEffect: effectFor(drag.effectAllowed) },
          mods,
          was,
        );
      }
      if (was) {
        fire(
          'dragleave',
          was,
          point,
          { ...drag, dropEffect: 'none' },
          mods,
          el,
        );
      }
    }
    if (!el) return false;
    const told = { ...drag, dropEffect: effectFor(drag.effectAllowed) };
    const cancelled = !fire('dragover', el, point, told, mods);
    effect.current = cancelled
      ? told.dropEffect
      : drag.entries.some((entry) => entry.t === 'text/plain') && takesText(el)
        ? effectFor(drag.effectAllowed)
        : 'none';
    return (
      (cancelled || effect.current !== 'none') &&
      effectAllows(drag.effectAllowed, effect.current)
    );
  };

  const left = (drag: HtmlDragData) => {
    const was = current.current;
    current.current = null;
    if (was) fire('dragleave', was, undefined, drag);
  };

  /** What another application is offering, while it can only be named. */
  const offered = (types: readonly string[]): HtmlDragData => ({
    entries: types
      .filter((type) => type.startsWith('text/') && type !== 'text/uri-list')
      .map((t) => ({ t })),
    hasFiles: types.includes('text/uri-list'),
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
  });

  const droppedFrom = async (drop: HtmlDrop): Promise<HtmlDragData> => {
    const paths = drop.paths ?? [];
    const files = paths.length
      ? await latest.current.onDropFiles?.([...paths])
      : undefined;
    const entries: ClipboardEntryWire[] = [];
    if (drop.text !== undefined && !paths.length) {
      entries.push({ t: 'text/plain', s: drop.text });
    }
    if (drop.html !== undefined) entries.push({ t: 'text/html', s: drop.html });
    return {
      entries,
      files: files ?? [],
      effectAllowed: 'uninitialized',
      dropEffect: effect.current,
    };
  };

  const external = {
    over: (drop: HtmlDrop): boolean =>
      over({ x: drop.x, y: drop.y }, null, offered(drop.types)),
    leave: () => left(offered([])),
    drop: async (drop: HtmlDrop): Promise<boolean> => {
      const el = current.current;
      current.current = null;
      if (!el) return false;
      const drag = await droppedFrom(drop);
      return !fire('drop', el, { x: drop.x, y: drop.y }, drag);
    },
  };

  const rootProps: Record<string, unknown> = {
    draggable: true,
    dragData: DRAG_DATA,
    dragActions: ['copy', 'move', 'link'],
    dropAccept: (types: string[]) =>
      types.includes(OWN_TYPE) || latest.current.onDropFiles !== undefined,
    onDragStart: (ev: CoreDragEvent) => {
      const { pressed, baseUrl, embedded, onDomEvent } = latest.current;
      const el = embedded.contains(ev.target as DrawnNode)
        ? null
        : draggableFrom(pressed());
      if (!el || !onDomEvent) {
        // the gesture goes on as ordinary mouse events: a selection, a drag
        // of a page's own
        ev.preventDefault();
        return;
      }
      const drag: HtmlDragData = {
        entries: defaultEntries(el, baseUrl),
        effectAllowed: 'uninitialized',
        dropEffect: 'none',
      };
      if (!fire('dragstart', el, ev, drag, ev)) {
        ev.preventDefault();
        return;
      }
      active = drag;
      source.current = el;
    },
    onDrag: (ev: CoreDragEvent) => {
      if (!active || !source.current) return;
      fire('drag', source.current, ev, active, ev);
      // A window with no drop session of core's: a pane on a Mac has none,
      // so core takes the drag for one over another application, wherever
      // it is (react-x11, `_initDnd`). What is inside the document is the
      // document's to answer, and the answer stands for the release.
      if (ev.source === 'external') {
        droppable.current = inside(ev) && over(ev, null, active, ev);
      }
    },
    onDragEnd: (ev: CoreDragEvent) => {
      const el = source.current;
      const drag = active;
      const landed = droppable.current ? current.current : null;
      droppable.current = false;
      source.current = null;
      active = null;
      if (!drag) return;
      if (landed) {
        current.current = null;
        fire('drop', landed, ev, { ...drag, dropEffect: effect.current });
      }
      const dropEffect = landed ? effect.current : (ev.action ?? 'none');
      if (el) fire('dragend', el, ev, { ...drag, dropEffect }, ev);
    },
    onDragOver: (ev: CoreDragEvent) => {
      if (latest.current.embedded.contains(ev.target as DrawnNode)) return;
      const drag = ev.source === 'internal' ? active : offered(ev.types);
      if (!drag) return;
      const yes = over(ev, ev.target as DrawnNode, drag, ev);
      if (!yes) ev.reject();
      else ev.accept(effect.current);
    },
    onDragLeave: (ev: CoreDragEvent) => {
      const drag = ev.source === 'internal' ? active : offered(ev.types);
      if (drag) left(drag);
    },
    onDrop: async (ev: CoreDragEvent) => {
      if (latest.current.embedded.contains(ev.target as DrawnNode)) return;
      const el = current.current;
      current.current = null;
      if (!el) return;
      if (ev.source === 'internal') {
        if (active) {
          fire('drop', el, ev, { ...active, dropEffect: effect.current });
        }
        return;
      }
      const paths = (ev.files ?? []).flatMap((f) => (f.path ? [f.path] : []));
      const html = ev.types.includes('text/html')
        ? await ev.getData?.('text/html')
        : undefined;
      const drag = await droppedFrom({
        x: ev.x,
        y: ev.y,
        types: ev.types,
        paths,
        text: ev.text,
        ...(typeof html === 'string' && { html }),
      });
      fire('drop', el, ev, drag);
    },
  };

  return {
    rootProps,
    pressCanDrag: () => draggableFrom(latest.current.pressed()) !== null,
    external,
  };
}
