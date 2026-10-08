// The host's half of the bridge: `<Html>`'s DOM, by node id, for the facade
// in the page's context (`dom.ts`). Every op takes primitives and answers
// one; an error is a string the facade throws as a `DOMException`, never a
// host object, whose `constructor.constructor` would be the host's
// `Function` (docs/prd-html-scripts.md, "the five leaks").
//
// The tree is the one `<Html>` draws, so a mutation here is a mutation of
// the page: the ops change domhandler's nodes and record each change, and
// `flush` hands the records to the handle's `refresh(changes)` — once a
// task, after the script that made the changes is done (`ScriptEngine`),
// and before anything asks the layout a question (`rect`, `computed`,
// `at`), which has to answer from the change. The same records are what a
// page's `MutationObserver` is handed.
//
// What the page cannot do here is anything the browser does not let it: a
// `fetch` is the same origin's, through the browser's network; storage is
// memory, per origin, gone with the process; a navigation is a link the
// browser follows.
import { performance } from 'node:perf_hooks';
import * as DomUtils from 'domutils';
import { is, selectAll, selectOne } from 'css-select';
import { Comment, Document, Element, Text } from 'domhandler';
import type { AnyNode, ChildNode, ParentNode } from 'domhandler';

import type {
  HtmlChange,
  HtmlDomEvent,
  HtmlHandle,
} from '../../../src/html/index.js';
import { parseFragment } from '../../../src/html/index.js';
import {
  mediaMatches,
  parseDeclarations,
  parseMediaQuery,
} from '../../../src/html/css/parse.js';
import { isDisabled } from '../../../src/html/form.js';
import type { Bridge, Primitive } from './dom.js';

/** A request a page's `fetch` makes, and what it came to. */
export interface FetchRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body: string | null;
}
export interface FetchResponse {
  url: string;
  status: number;
  statusText: string;
  redirected: boolean;
  headers: [string, string][];
  /** The body, decoded as the response says. */
  body: string;
}

/** What the page around the document gives the host: where it is shown,
 *  where it goes, and what it may fetch. */
export interface HostSeams {
  handle: HtmlHandle;
  /** The pane the document is shown in, in CSS pixels — its size and its
   *  scroll — with the page's zoom and the device's scale, and where its
   *  top left is in the window, in logical pixels. */
  viewport(): {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    zoom: number;
    dpr: number;
    left: number;
    top: number;
  };
  scrollTo(x: number, y: number): void;
  /** A navigation the page asked for: an address assigned, `open`. */
  navigate(url: string, how: 'here' | 'replace' | 'tab'): void;
  reload(): void;
  go(delta: number): void;
  /** What the page writes to its console. */
  log(level: string, text: string): void;
  /** The document's title changed. */
  title(title: string | null): void;
  fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResponse>;
  userAgent: string;
  language: string;
}

/** An error the facade throws by name: `DOMException`'s. */
class DomError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}
const hierarchy = (what: string) => new DomError('HierarchyRequestError', what);

/** The page's storage: memory, by origin, for as long as the process. */
const STORAGE = {
  local: new Map<string, Map<string, string>>(),
  session: new Map<string, Map<string, string>>(),
};

/** A change as an observer is handed it (DOM 4.3.4), by node. */
interface Mutation {
  type: 'attributes' | 'childList' | 'characterData';
  target: AnyNode;
  added: readonly AnyNode[];
  removed: readonly AnyNode[];
  previous: AnyNode | null;
  next: AnyNode | null;
  attributeName: string | null;
  oldValue: string | null;
}

/** What `observe()` asked to see (DOM 4.3.1), its defaults filled in. */
interface ObserveOptions {
  childList: boolean;
  attributes: boolean;
  characterData: boolean;
  subtree: boolean;
  attributeOldValue: boolean;
  characterDataOldValue: boolean;
  attributeFilter: string[] | null;
}

/** A page's `MutationObserver`, as the host keeps it. */
interface Observer {
  on: Map<AnyNode, ObserveOptions>;
  queue: Mutation[];
}

/** How many changes a task may make before `<Html>` is told to restyle
 *  everything rather than what they reach. */
const CHANGES_TOLD = 4000;

/** What an entry into the page answers: the engine's `call`. */
export interface Entries {
  call(entry: string, input: unknown): Primitive;
}

export class DomHost {
  private _ids = new WeakMap<AnyNode, number>();
  private _nodes = new Map<number, AnyNode>();
  private _next = 2;
  private _timers = new Map<number, ReturnType<typeof setTimeout>>();
  private _fetches = new Map<number, AbortController>();
  private _contents = new Map<number, number>();
  /** The changes since `<Html>` was last told, as `refresh` takes them. */
  private _changes: HtmlChange[] = [];
  /** The page's `MutationObserver`s, by id in the order they were made: the
   *  nodes each watches and how, and the records queued for it. */
  private _observers = new Map<number, Observer>();
  /** The address the document is at, which `history.pushState` moves. */
  url: string;
  /** Scripts that are never run: what `innerHTML` and
   *  `insertAdjacentHTML` put in, which HTML does not run either. */
  readonly inert = new WeakSet<Element>();
  /** Where timers and fetches call back into the page. */
  entries: Entries | null = null;
  private _disposed = false;

  constructor(
    readonly document: Document,
    private readonly _seams: HostSeams,
    url: string,
  ) {
    this.url = url;
    this._ids.set(document, 1);
    this._nodes.set(1, document);
  }

  /** The bridge the facade is handed: never throws, never answers an
   *  object. */
  readonly bridge: Bridge = (op, a, b, c, d) => {
    try {
      const out = this._op(op, a, b, c, d);
      return out === undefined || out === null || typeof out !== 'object'
        ? out
        : null;
    } catch (error) {
      const kind = error instanceof DomError ? error.kind : 'Error';
      const message = String((error as Error)?.message ?? error);
      return `\u0001${kind}\u0001${message}`;
    }
  };

  /** A node's id, made the first time it is asked for. */
  idOf(node: AnyNode | null | undefined): number {
    if (!node) return 0;
    let id = this._ids.get(node);
    if (id === undefined) {
      id = this._next++;
      this._ids.set(node, id);
      this._nodes.set(id, node);
    }
    return id;
  }

  /** Hand the tree's changes to `<Html>`: a restyle, a layout and a paint
   *  of the document as the page left it. */
  flush(): void {
    if (!this._changes.length || this._disposed) return;
    const changes = this._changes;
    this._changes = [];
    // past a few thousand, working out what they reach costs what styling
    // everything does
    this._seams.handle.refresh(
      changes.length > CHANGES_TOLD ? undefined : changes,
    );
  }

  /** An event `<Html>` told of, dispatched in the page; whether its default
   *  goes on. */
  dispatch(event: HtmlDomEvent): boolean {
    const answer = this.entries?.call('__event', {
      type: event.type,
      target: this.idOf(event.target),
      x: event.x,
      y: event.y,
      button: event.button,
      detail: event.detail,
      key: event.key,
      code: event.code,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      submitter: event.submitter ? this.idOf(event.submitter) : 0,
      relatedTarget: event.relatedTarget ? this.idOf(event.relatedTarget) : 0,
    });
    return answer !== false;
  }

  dispose(): void {
    this._disposed = true;
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
    for (const fetch of this._fetches.values()) fetch.abort();
    this._fetches.clear();
    this._observers.clear();
    this.entries = null;
  }

  private _node(id: Primitive): AnyNode {
    const node = typeof id === 'number' ? this._nodes.get(id) : undefined;
    if (!node) throw new DomError('NotFoundError', 'No such node.');
    return node;
  }
  private _element(id: Primitive): Element {
    const node = this._node(id);
    if (!(node instanceof Element)) {
      throw new DomError('InvalidNodeTypeError', 'Not an element.');
    }
    return node;
  }
  private _parent(id: Primitive): ParentNode {
    const node = this._node(id);
    if (!(node instanceof Element || node instanceof Document)) {
      throw hierarchy('This node has no children.');
    }
    return node;
  }
  /** A fragment: a `Document` node that is not the document. */
  private _isFragment(node: AnyNode): boolean {
    return node instanceof Document && node !== this.document;
  }

  private _op(
    op: string,
    a: Primitive,
    b: Primitive,
    c: Primitive,
    d: Primitive,
  ): Primitive {
    const text = (v: Primitive): string => (typeof v === 'string' ? v : '');
    switch (op) {
      // --- the tree
      case 'info': {
        const node = this._node(a);
        if (node instanceof Element) return `1|${node.name}`;
        if (node instanceof Text) return '3|#text';
        if (node instanceof Comment) return '8|#comment';
        if (node === this.document) return '9|#document';
        if (node instanceof Document) return '11|#document-fragment';
        if (node.type === 'directive') return '10|html';
        return '3|#text';
      }
      case 'parent': {
        const node = this._node(a);
        return node === this.document ? 0 : this.idOf(node.parent);
      }
      case 'kids': {
        const node = this._node(a);
        if (!('children' in node)) return '';
        const kids =
          b === 'elements'
            ? node.children.filter((k) => k instanceof Element)
            : node.children;
        return kids.map((k) => this.idOf(k)).join(',');
      }
      case 'first':
      case 'last': {
        const node = this._node(a);
        if (!('children' in node) || !node.children.length) return 0;
        return this.idOf(
          op === 'first' ? node.children[0] : node.children.at(-1),
        );
      }
      case 'next':
      case 'prev': {
        let at: AnyNode | null = this._node(a);
        do {
          at = op === 'next' ? at.next : at.prev;
        } while (at && b === 'element' && !(at instanceof Element));
        return this.idOf(at);
      }
      case 'connected': {
        let at: AnyNode = this._node(a);
        while (at.parent) at = at.parent;
        return at === this.document;
      }
      case 'contains': {
        const outer = this._node(a);
        for (let at: AnyNode | null = this._node(b); at; at = at.parent) {
          if (at === outer) return true;
        }
        return false;
      }
      case 'equal':
        return (
          DomUtils.getOuterHTML(this._node(a)) ===
          DomUtils.getOuterHTML(this._node(b))
        );
      case 'position':
        return this._position(this._node(a), this._node(b));
      case 'text': {
        const node = this._node(a);
        if (node instanceof Text || node instanceof Comment) return node.data;
        if (node === this.document) return null;
        return DomUtils.textContent(node);
      }
      case 'setText': {
        const node = this._node(a);
        if (node instanceof Text || node instanceof Comment) {
          const oldValue = node.data;
          node.data = text(b);
          this._changed(node, 'characterData', null, oldValue);
          return null;
        }
        const parent = this._parent(a);
        this._replaceAll(parent, text(b) ? [new Text(text(b))] : []);
        return null;
      }
      case 'create': {
        if (a === 'element') {
          return this.idOf(new Element(text(b).toLowerCase(), {}, []));
        }
        if (a === 'text') return this.idOf(new Text(text(b)));
        if (a === 'comment') return this.idOf(new Comment(text(b)));
        return this.idOf(new Document([]));
      }
      case 'insert':
        this._insert(this._parent(a), this._node(b), c ? this._node(c) : null);
        return null;
      case 'remove': {
        const node = this._node(a) as ChildNode;
        if (node.parent) this._take(node);
        return null;
      }
      case 'clone': {
        const node = this._node(a);
        return this.idOf(node.cloneNode(!!b));
      }

      // --- attributes
      case 'attr':
        return this._element(a).attribs[text(b)] ?? null;
      case 'attrs':
        return Object.keys(this._element(a).attribs).join('\u0000');
      case 'setAttr': {
        const el = this._element(a);
        const name = text(b);
        const oldValue = el.attribs[name] ?? null;
        el.attribs[name] = text(c);
        this._changed(el, 'attributes', name, oldValue);
        return null;
      }
      case 'delAttr': {
        const el = this._element(a);
        const name = text(b);
        if (name in el.attribs) {
          const oldValue = el.attribs[name];
          delete el.attribs[name];
          this._changed(el, 'attributes', name, oldValue);
        }
        return null;
      }
      case 'style':
      case 'stylePriority': {
        const found = this._declarations(this._element(a))
          .filter((d) => d.prop === text(b))
          .at(-1);
        if (op === 'stylePriority') return found?.important ? 'important' : '';
        return found?.value ?? '';
      }
      case 'styleNames':
        return this._declarations(this._element(a))
          .map((d) => d.prop)
          .join(',');
      case 'setStyle': {
        const el = this._element(a);
        const name = text(b);
        const kept = this._declarations(el).filter((d) => d.prop !== name);
        if (text(c)) {
          kept.push({
            prop: name,
            value: text(c),
            important: d === 'important',
          });
        }
        const written = kept
          .map(
            (x) => `${x.prop}: ${x.value}${x.important ? ' !important' : ''}`,
          )
          .join('; ');
        const oldValue = el.attribs.style ?? null;
        if (written) el.attribs.style = written;
        else delete el.attribs.style;
        this._changed(el, 'attributes', 'style', oldValue);
        return null;
      }

      // --- markup
      case 'html': {
        const node = this._node(a);
        return b ? DomUtils.getOuterHTML(node) : DomUtils.getInnerHTML(node);
      }
      case 'setHtml': {
        this._replaceAll(this._parent(a), this._parse(text(b)));
        return null;
      }
      case 'adjacent': {
        const node = this._node(a) as ChildNode;
        const kids = this._parse(text(c));
        const where = text(b);
        if (where === 'beforebegin' || where === 'afterend') {
          if (!node.parent) throw hierarchy('The element has no parent.');
          const before = where === 'beforebegin' ? node : node.next;
          this._put(node.parent, kids, before);
        } else if (where === 'afterbegin' || where === 'beforeend') {
          const parent = this._parent(a);
          const first = where === 'afterbegin' ? parent.children[0] : null;
          this._put(parent, kids, first ?? null);
        } else {
          throw new DomError('SyntaxError', `'${where}' is not a position.`);
        }
        return null;
      }
      case 'content': {
        // a `<template>`'s content: a fragment of what it holds, made once
        const id = Number(a);
        let fragment = this._contents.get(id);
        if (fragment === undefined) {
          const template = this._element(a);
          const holder = new Document(
            template.children.map((k) => k.cloneNode(true) as ChildNode),
          );
          for (const kid of holder.children) kid.parent = holder;
          fragment = this.idOf(holder);
          this._contents.set(id, fragment);
        }
        return fragment;
      }

      // --- selectors
      case 'query': {
        const root = this._node(a);
        try {
          if (c) {
            return selectAll(text(b), root as Element)
              .map((el) => this.idOf(el))
              .join(',');
          }
          return this.idOf(selectOne(text(b), root as Element));
        } catch (error) {
          throw new DomError(
            'SyntaxError',
            `'${text(b)}' is not a valid selector: ${(error as Error).message}`,
          );
        }
      }
      case 'matches':
        try {
          return is(this._element(a), text(b));
        } catch {
          throw new DomError(
            'SyntaxError',
            `'${text(b)}' is not a valid selector.`,
          );
        }
      case 'closest': {
        try {
          for (let at: AnyNode | null = this._element(a); at; at = at.parent) {
            if (at instanceof Element && is(at, text(b))) return this.idOf(at);
          }
        } catch {
          throw new DomError(
            'SyntaxError',
            `'${text(b)}' is not a valid selector.`,
          );
        }
        return 0;
      }
      case 'byId':
        return this.idOf(
          DomUtils.findOne(
            (el) => el.attribs.id === text(a),
            this.document.children,
            true,
          ),
        );
      case 'byTag': {
        const tag = text(b).toLowerCase();
        const root = this._node(a) as ParentNode;
        return DomUtils.findAll(
          (el) => tag === '*' || el.name === tag,
          root.children,
        )
          .map((el) => this.idOf(el))
          .join(',');
      }
      case 'byClass': {
        const wanted = text(b)
          .split(/[\t\n\f\r ]+/)
          .filter(Boolean);
        const root = this._node(a) as ParentNode;
        if (!wanted.length) return '';
        return DomUtils.findAll((el) => {
          const has = (el.attribs.class ?? '').split(/[\t\n\f\r ]+/);
          return wanted.every((w) => has.includes(w));
        }, root.children)
          .map((el) => this.idOf(el))
          .join(',');
      }

      // --- the document
      case 'root':
        return this.idOf(
          this.document.children.find((k) => k instanceof Element) ?? null,
        );
      case 'title': {
        const title = DomUtils.findOne(
          (el) => el.name === 'title',
          this.document.children,
        );
        return title
          ? DomUtils.textContent(title).replace(/\s+/g, ' ').trim()
          : '';
      }
      case 'setTitle': {
        let title = DomUtils.findOne(
          (el) => el.name === 'title',
          this.document.children,
        );
        if (!title) {
          const head =
            DomUtils.findOne(
              (el) => el.name === 'head',
              this.document.children,
            ) ??
            (this.document.children.find((k) => k instanceof Element) as
              Element | undefined);
          if (!head) return null;
          title = new Element('title', {}, []);
          this._put(head, [title], null);
        }
        this._replaceAll(title, [new Text(text(a))]);
        this._seams.title(text(a) || null);
        return null;
      }
      case 'disabled':
        return isDisabled(this._element(a));

      // --- layout, which answers from the tree as the page left it
      case 'rect': {
        this.flush();
        const rect = this._seams.handle.elementRect(this._element(a));
        return rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : '';
      }
      case 'computed': {
        this.flush();
        const pseudo = b === 'before' || b === 'after' ? b : null;
        const style = this._seams.handle.computedStyle(
          this._element(a),
          pseudo,
        );
        return style ? JSON.stringify(style) : '';
      }
      case 'at': {
        this.flush();
        const v = this._seams.viewport();
        const x = Number(a);
        const y = Number(b);
        if (!(x >= 0 && y >= 0 && x < v.width && y < v.height)) return 0;
        return this.idOf(
          this._seams.handle.elementAt(v.left + x * v.zoom, v.top + y * v.zoom),
        );
      }
      case 'viewport': {
        const v = this._seams.viewport();
        return `${v.width},${v.height},${v.scrollX},${v.scrollY},${v.dpr}`;
      }
      case 'scrollTo':
        this._seams.scrollTo(
          Math.max(0, Number(a) || 0),
          Math.max(0, Number(b) || 0),
        );
        return null;
      case 'media': {
        const v = this._seams.viewport();
        try {
          return mediaMatches(
            [parseMediaQuery(text(a))],
            v.width,
            'light',
            v.height,
            v.dpr,
            false,
            true,
          );
        } catch {
          return false;
        }
      }

      // --- controls and the focus, which are `<Html>`'s
      case 'value':
        return this._seams.handle.controlValue(this._element(a));
      case 'setValue':
        return this._seams.handle.setControlValue(
          this._element(a),
          typeof b === 'boolean' ? b : text(b),
        );
      case 'focus': {
        this.flush();
        const el = this._element(a);
        // a control just put in has no widget until the render that the
        // flush asked for: asked again once it has
        if (!this._seams.handle.focus(el)) {
          setTimeout(() => {
            if (!this._disposed) this._seams.handle.focus(el);
          }, 16);
        }
        return null;
      }
      case 'blur':
        this._seams.handle.blur();
        return null;
      case 'active':
        return this.idOf(this._seams.handle.activeElement);
      case 'activate': {
        const node = this._node(a);
        return node instanceof Element && this._seams.handle.activate(node);
      }
      case 'submit':
        this.flush();
        this._seams.handle.submitForm(
          this._element(a),
          b ? this._element(b) : null,
        );
        return null;
      case 'validate':
        return this._seams.handle.reportValidity(
          this._element(a),
          b ? this._element(b) : null,
        );
      case 'reset':
        this._seams.handle.resetForm(this._element(a));
        return null;

      // --- the window
      case 'log':
        this._seams.log(text(a), text(b));
        return null;
      case 'now':
        return performance.now();
      case 'navigator':
        return `${this._seams.userAgent}\u0000${this._seams.language}`;
      case 'base':
        return this._seams.handle.base ?? this.url;
      case 'location':
        return this.url;
      case 'setLocation':
        this.url = text(a);
        return null;
      case 'resolve':
        return this._resolve(text(a));
      case 'url':
        return urlJson(text(a), text(b));
      case 'setUrl': {
        try {
          const url = new URL(text(a));
          (url as unknown as Record<string, string>)[text(b)] = text(c);
          return urlJson(url.href, '');
        } catch {
          return '';
        }
      }
      case 'navigate':
        this._seams.navigate(text(a), b ? 'replace' : 'here');
        return null;
      case 'open':
        this._seams.navigate(text(a), 'tab');
        return null;
      case 'reload':
        this._seams.reload();
        return null;
      case 'go':
        this._seams.go(Number(a) || 0);
        return null;
      case 'storage':
        return this._storage(text(a), text(b), text(c), text(d));
      case 'timer': {
        const id = Number(a);
        const repeat = !!c;
        const ms = Math.max(repeat ? 4 : 0, Number(b) || 0);
        const fire = () => {
          if (!repeat) this._timers.delete(id);
          this.entries?.call('__timer', [id]);
        };
        this._timers.set(
          id,
          repeat ? setInterval(fire, ms) : setTimeout(fire, ms),
        );
        return null;
      }
      case 'clearTimer': {
        const timer = this._timers.get(Number(a));
        if (timer !== undefined) {
          clearTimeout(timer);
          clearInterval(timer);
          this._timers.delete(Number(a));
        }
        return null;
      }
      // --- observers
      case 'observe': {
        let observer = this._observers.get(Number(a));
        if (!observer) {
          observer = { on: new Map(), queue: [] };
          this._observers.set(Number(a), observer);
        }
        const raw = JSON.parse(text(c)) as Partial<ObserveOptions>;
        observer.on.set(this._node(b), {
          childList: !!raw.childList,
          attributes: !!raw.attributes,
          characterData: !!raw.characterData,
          subtree: !!raw.subtree,
          attributeOldValue: !!raw.attributeOldValue,
          characterDataOldValue: !!raw.characterDataOldValue,
          attributeFilter: Array.isArray(raw.attributeFilter)
            ? raw.attributeFilter.map(String)
            : null,
        });
        return null;
      }
      case 'disconnect':
        this._observers.delete(Number(a));
        return null;
      case 'observed':
        // the observers with records, in the order they were made
        return [...this._observers]
          .filter(([, o]) => o.queue.length)
          .map(([id]) => id)
          .join(',');
      case 'takeRecords': {
        const observer = this._observers.get(Number(a));
        if (!observer?.queue.length) return '[]';
        const queue = observer.queue;
        observer.queue = [];
        const ids = (nodes: readonly AnyNode[]) =>
          nodes.map((n) => this.idOf(n));
        return JSON.stringify(
          queue.map((r) => [
            r.type,
            this.idOf(r.target),
            ids(r.added),
            ids(r.removed),
            this.idOf(r.previous),
            this.idOf(r.next),
            r.attributeName,
            r.oldValue,
          ]),
        );
      }

      case 'fetch':
        this._fetch(Number(a), text(b));
        return null;
      case 'abortFetch':
        this._fetches.get(Number(a))?.abort();
        this._fetches.delete(Number(a));
        return null;
      default:
        throw new DomError('NotSupportedError', `No op '${op}'.`);
    }
  }

  /** Put a node, or what a fragment holds, into `parent` before `before`
   *  (DOM 4.2.3, "pre-insert"): never into itself or what it holds. */
  private _insert(
    parent: ParentNode,
    node: AnyNode,
    before: AnyNode | null,
  ): void {
    if (node === this.document)
      throw hierarchy('The document cannot be moved.');
    for (let at: AnyNode | null = parent; at; at = at.parent) {
      if (at === node) {
        throw hierarchy('The new child element contains the parent.');
      }
    }
    if (before && before.parent !== parent) {
      throw new DomError(
        'NotFoundError',
        'The node before which the new node is to be inserted is not a child of this node.',
      );
    }
    if (before === node) return;
    const moving = this._isFragment(node)
      ? (node as Document).children.slice()
      : [node as ChildNode];
    this._put(parent, moving, before as ChildNode | null);
  }

  // --- what changed -----------------------------------------------------------
  //
  // Every change the ops make goes through these, as one record each: told
  // `<Html>` at the next `flush`, which restyles what it reaches
  // (`refresh(changes)`), and queued for the observers that watch it, as
  // DOM 4.3.2's "queue a mutation record" has them.

  /** An attribute's or a text's change, recorded. */
  private _changed(
    target: AnyNode,
    type: 'attributes' | 'characterData',
    name: string | null,
    oldValue: string | null,
  ): void {
    if (type === 'attributes') {
      this._changes.push({
        type,
        target: target as Element,
        attributeName: name!,
        oldValue,
      });
    } else this._changes.push({ type, target });
    if (this._observers.size) {
      this._queue(target, {
        type,
        target,
        added: [],
        removed: [],
        previous: null,
        next: null,
        attributeName: name,
        oldValue,
      });
    }
  }

  /** Nodes put into `parent` before `before`, or at its end, each taken
   *  from wherever it was first: a record of each taking, and one of the
   *  putting. */
  private _put(
    parent: ParentNode,
    nodes: readonly ChildNode[],
    before: ChildNode | null,
  ): void {
    for (const node of nodes) if (node.parent) this._take(node);
    if (!nodes.length) return;
    const previous = before ? before.prev : (parent.children.at(-1) ?? null);
    for (const node of nodes) {
      if (before) DomUtils.prepend(before, node);
      else DomUtils.appendChild(parent, node);
    }
    this._childList(parent, nodes, [], previous, before);
  }

  /** A node taken out of its parent, recorded. */
  private _take(node: ChildNode): void {
    const parent = node.parent!;
    const previous = node.prev;
    const next = node.next;
    DomUtils.removeElement(node);
    this._childList(parent, [], [node], previous, next);
  }

  /** What `parent` holds replaced by `nodes`, as one record (DOM 4.2.3,
   *  "replace all"). */
  private _replaceAll(parent: ParentNode, nodes: readonly ChildNode[]): void {
    for (const node of nodes) if (node.parent) this._take(node);
    const removed = parent.children.slice();
    for (const kid of removed) DomUtils.removeElement(kid);
    for (const node of nodes) DomUtils.appendChild(parent, node);
    if (removed.length || nodes.length) {
      this._childList(parent, nodes, removed, null, null);
    }
  }

  private _childList(
    parent: ParentNode,
    added: readonly AnyNode[],
    removed: readonly AnyNode[],
    previous: AnyNode | null,
    next: AnyNode | null,
  ): void {
    this._changes.push({
      type: 'childList',
      target: parent,
      addedNodes: added,
      removedNodes: removed,
    });
    if (this._observers.size) {
      this._queue(parent, {
        type: 'childList',
        target: parent,
        added,
        removed,
        previous,
        next,
        attributeName: null,
        oldValue: null,
      });
    }
  }

  /** A record queued for each observer interested in it: one watching the
   *  target, or an ancestor with `subtree`, for what it asked to see — with
   *  the old value only where it asked for that (DOM 4.3.2). */
  private _queue(target: AnyNode, record: Mutation): void {
    const interested = new Map<Observer, string | null>();
    for (let at: AnyNode | null = target; at; at = at.parent) {
      for (const observer of this._observers.values()) {
        const options = observer.on.get(at);
        if (!options || (at !== target && !options.subtree)) continue;
        if (record.type === 'attributes') {
          if (!options.attributes) continue;
          const filter = options.attributeFilter;
          if (filter && !filter.includes(record.attributeName!)) continue;
        } else if (record.type === 'characterData') {
          if (!options.characterData) continue;
        } else if (!options.childList) continue;
        const old =
          (record.type === 'attributes' && options.attributeOldValue) ||
          (record.type === 'characterData' && options.characterDataOldValue);
        if (old) interested.set(observer, record.oldValue);
        else if (!interested.has(observer)) interested.set(observer, null);
      }
    }
    for (const [observer, oldValue] of interested) {
      observer.queue.push({ ...record, oldValue });
    }
  }

  /** Markup as `innerHTML` reads it; its scripts never run. */
  private _parse(html: string): ChildNode[] {
    const kids = parseFragment(html);
    for (const el of DomUtils.findAll((e) => e.name === 'script', kids)) {
      this.inert.add(el);
    }
    for (const kid of kids) {
      if (kid instanceof Element && kid.name === 'script') this.inert.add(kid);
    }
    return kids;
  }

  private _declarations(el: Element) {
    const style = el.attribs.style;
    return style ? parseDeclarations(style) : [];
  }

  private _resolve(url: string): string {
    try {
      return new URL(url, this._seams.handle.base ?? this.url).href;
    } catch {
      return url;
    }
  }

  private _origin(): string {
    try {
      return new URL(this.url).origin;
    } catch {
      return 'null';
    }
  }

  private _storage(
    kind: string,
    op: string,
    key: string,
    value: string,
  ): Primitive {
    const all = kind === 'session' ? STORAGE.session : STORAGE.local;
    const origin = this._origin();
    let store = all.get(origin);
    if (!store) all.set(origin, (store = new Map()));
    switch (op) {
      case 'get':
        return store.get(key) ?? null;
      case 'set':
        store.set(key, value);
        return null;
      case 'remove':
        store.delete(key);
        return null;
      case 'clear':
        store.clear();
        return null;
      case 'keys':
        return [...store.keys()].join('\u0000');
      default:
        return null;
    }
  }

  /** A page's `fetch`: its own origin's, through the browser's network,
   *  and its answer handed back through `__fetched`. */
  private _fetch(id: number, json: string): void {
    const answer = (value: FetchResponse | string) => {
      if (!this._fetches.delete(id) || this._disposed) return;
      this.entries?.call('__fetched', [id, value]);
    };
    let request: FetchRequest;
    try {
      const raw = JSON.parse(json) as Partial<FetchRequest>;
      request = {
        url: this._resolve(String(raw.url ?? '')),
        method: String(raw.method ?? 'GET'),
        headers: Array.isArray(raw.headers)
          ? raw.headers.map(([k, v]) => [String(k), String(v)])
          : [],
        body: typeof raw.body === 'string' ? raw.body : null,
      };
    } catch {
      return;
    }
    const controller = new AbortController();
    this._fetches.set(id, controller);
    let origin = '';
    try {
      origin = new URL(request.url).origin;
    } catch {}
    if (origin !== this._origin() || origin === 'null') {
      // no CORS here to let another origin answer
      queueMicrotask(() => answer('Failed to fetch'));
      this._seams.log(
        'error',
        `fetch of ${request.url} refused: this browser fetches only from the page's own origin.`,
      );
      return;
    }
    this._seams.fetch(request, controller.signal).then(
      (response) => answer(response),
      () => answer('Failed to fetch'),
    );
  }

  /** `compareDocumentPosition` (DOM 4.4), by the two nodes' paths. */
  private _position(a: AnyNode, b: AnyNode): number {
    if (a === b) return 0;
    const path = (n: AnyNode): AnyNode[] => {
      const out: AnyNode[] = [];
      for (let at: AnyNode | null = n; at; at = at.parent) out.unshift(at);
      return out;
    };
    const pa = path(a);
    const pb = path(b);
    if (pa[0] !== pb[0]) return 1 | 32 | 2;
    let i = 0;
    while (i < pa.length && i < pb.length && pa[i] === pb[i]) i += 1;
    if (i === pa.length) return 16 | 4; // b is inside a
    if (i === pb.length) return 8 | 2; // a is inside b
    const parent = pa[i - 1] as ParentNode;
    return parent.children.indexOf(pb[i] as ChildNode) >
      parent.children.indexOf(pa[i] as ChildNode)
      ? 4
      : 2;
  }
}

/** A URL's parts, as JSON, or '' where it is none. */
function urlJson(href: string, base: string): string {
  try {
    const u = base ? new URL(href, base) : new URL(href);
    return JSON.stringify({
      href: u.href,
      protocol: u.protocol,
      host: u.host,
      hostname: u.hostname,
      port: u.port,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
      origin: u.origin,
      username: u.username,
      password: u.password,
    });
  } catch {
    return '';
  }
}
