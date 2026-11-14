/**
 * A document's render-blocking element set (HTML 3.1.6, "render-blocking
 * mechanism"), kept on the host, which sees every element go in — the
 * parser's and a script's — and every attribute change, as it happens.
 *
 * An element is added only while its document "allows adding
 * render-blocking elements": an HTML document whose `body` is still null.
 * It is taken out when what it fetches settles, when it leaves the
 * document, or when an attribute change makes it no longer blocking, and
 * it is never put back once the body is there. The document is
 * render-blocked while the set has anything in it or adding is still
 * allowed, so a page's animation frames, and its first paint timing, wait
 * for the end of its head as well as for what is in the set.
 *
 * This had been worked out again at every frame from whatever was in the
 * tree, which blocked for a `<link rel=expect blocking=render>` in the
 * body, or one changed there, and held nothing for a parser-blocking
 * script, since nothing was in the tree to say so.
 *
 * The parser's elements are decided by where they are rather than when
 * the host first hears of them (`_scanHead`): what stands before the
 * `<body>` the parser made before the body was there. A script's are
 * decided as they go in (`connected`).
 */

import { isTag } from 'domhandler';
import type { ChildNode, Document, Element } from 'domhandler';

import { indicatedElement, isForeign, tagOf } from '../dom.js';

declare const URL: new (url: string) => {
  origin: string;
  pathname: string;
  search: string;
  hash: string;
};

/** What the set asks of the host it is kept by. */
export interface RenderBlockingHost {
  /** The document the set is of. */
  document(): Document;
  /** The document's address, as `location` has it. */
  url(): string;
  /** Whether the document is an XML one, which allows adding nothing. */
  xml(): boolean;
  /** An `href` resolved against the document's base. */
  resolve(href: string, el: Element): string;
  /** Whether a media query holds for the document. */
  mediaMatches(query: string): boolean;
  /** Whether a script was put in by a script rather than by the parser. */
  scriptMade(el: Element): boolean;
  /** Whether an element is in the document. */
  connected(el: Element): boolean;
}

/** The script types the runner runs, which settle by running or failing. */
const CLASSIC = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

/** Whether a `blocking` attribute names `render`. */
const blocksRender = (el: Element): boolean =>
  /(?:^|\s)render(?:\s|$)/i.test(el.attribs.blocking ?? '');

const hasToken = (value: string | undefined, token: string): boolean =>
  new RegExp(`(?:^|\\s)${token}(?:\\s|$)`, 'i').test(value ?? '');

/** The attributes whose change makes a link or a script blocking or not. */
const RELEVANT = new Set([
  'blocking',
  'href',
  'rel',
  'media',
  'src',
  'type',
  'async',
  'defer',
  'nomodule',
]);

export class RenderBlocking {
  /** The render-blocking element set. */
  private readonly _set = new Set<Element>();
  /** The elements decided: once decided, nothing but an attribute change
   *  while adding is still allowed adds one. */
  private readonly _decided = new WeakSet<Element>();
  /** The parse has ended: nothing more is added, and what an expectation
   *  waits for has come or never will. */
  private _over = false;
  /** A scan reached the body: nothing the parser makes is before it now. */
  private _scanned = false;
  /** The stylesheets the parser put before the body: implicitly potentially
   *  render-blocking (HTML 4.2.4.3, 4.2.6), which is what their fetches,
   *  and their imports', say of themselves (`blocksFetch`). The set itself
   *  holds only what `blocking` names. */
  private readonly _implicit = new WeakSet<Element>();
  /** What a script put in, which no scan may take for the parser's. */
  private readonly _inserted = new WeakSet<Element>();

  constructor(private readonly _host: RenderBlockingHost) {}

  /** The document's `<body>` (HTML's "the body element"): the first
   *  `<body>` or `<frameset>` child of its `<html>`. */
  private _body(): Element | null {
    for (const root of this._host.document().children) {
      if (!isTag(root) || tagOf(root) !== 'html') continue;
      for (const kid of root.children) {
        if (!isTag(kid) || isForeign(kid)) continue;
        const tag = tagOf(kid);
        if (tag === 'body' || tag === 'frameset') return kid;
      }
      return null;
    }
    return null;
  }

  /** Whether the document allows adding render-blocking elements. */
  private _allows(): boolean {
    return !this._over && !this._host.xml() && this._body() === null;
  }

  /**
   * Whether an element is potentially render-blocking (HTML 3.1.6): its
   * `blocking` names `render`, or it is implicitly so — a classic script
   * the parser met, with a source and neither `async` nor `defer`. Only
   * what settles is counted: a script of a type nothing runs, a stylesheet
   * with nothing to fetch, would hold the document for good.
   */
  private _potentially(el: Element): boolean {
    if (isForeign(el)) return false;
    const tag = tagOf(el);
    if (tag === 'script') {
      const { attribs } = el;
      const type = (attribs.type ?? attribs.language ?? '')
        .trim()
        .toLowerCase();
      const classic = CLASSIC.has(type);
      if (!classic && type !== 'module') return false;
      if (classic && attribs.nomodule !== undefined) return false;
      const src = (attribs.src ?? '').trim();
      // an inline classic script has run by the time a frame can ask
      if (classic && !src) return false;
      if (blocksRender(el)) return true;
      return (
        classic &&
        !this._host.scriptMade(el) &&
        attribs.async === undefined &&
        attribs.defer === undefined
      );
    }
    if (!blocksRender(el)) return false;
    // a `<style>` of a type that makes no sheet hears no `load`
    if (tag === 'style') {
      const type = (el.attribs.type ?? '').trim().toLowerCase();
      return type === '' || type === 'text/css';
    }
    if (tag !== 'link') return false;
    const { rel, href, media } = el.attribs;
    if (media && media.trim() && !this._host.mediaMatches(media)) return false;
    if (hasToken(rel, 'expect')) return this._fragment(el) !== '';
    // nor does a sheet nothing fetches
    return (
      hasToken(rel, 'stylesheet') &&
      !hasToken(rel, 'alternate') &&
      el.attribs.disabled === undefined &&
      !!href?.trim()
    );
  }

  /**
   * The fragment an expect link waits for, or '' where it waits for none:
   * its `href`, resolved against the document's base, names another
   * document, or no part of this one (HTML, the "expect" link type's
   * "process internal resource link"): under `<base href="other.html">`,
   * `#x` is another document's.
   */
  private _fragment(el: Element): string {
    try {
      const url = new URL(this._host.resolve(el.attribs.href ?? '', el));
      const doc = new URL(this._host.url());
      const same =
        url.origin === doc.origin &&
        url.pathname === doc.pathname &&
        url.search === doc.search;
      return same ? url.hash.slice(1) : '';
    } catch {
      return '';
    }
  }

  /** Whether an expect link's expectation is over: the element its href
   *  names is in the document, or the parse ended without it. */
  private _expected(el: Element): boolean {
    if (this._over) return true;
    const fragment = this._fragment(el);
    return (
      !fragment || indicatedElement(this._host.document(), fragment) !== null
    );
  }

  private _isExpect(el: Element): boolean {
    return tagOf(el) === 'link' && hasToken(el.attribs.rel, 'expect');
  }

  /** Decide an element: added where adding is allowed and it is
   *  potentially render-blocking. */
  private _decide(el: Element, allowed: boolean): void {
    if (this._decided.has(el)) return;
    this._decided.add(el);
    if (!allowed || !this._potentially(el)) return;
    if (this._isExpect(el) && this._expected(el)) return;
    this._set.add(el);
  }

  /** Decide what the parser put before the body: it stood there before the
   *  body did. */
  private _scanHead(): void {
    if (this._over || this._scanned) return;
    const xml = this._host.xml();
    const body = this._body();
    if (body) this._scanned = true;
    const walk = (nodes: readonly ChildNode[]): void => {
      for (const node of nodes) {
        if (!isTag(node)) continue;
        const el = node;
        if (el === body) return;
        const tag = tagOf(el);
        if (tag === 'template') continue;
        if (tag === 'script' || tag === 'link' || tag === 'style') {
          this._decide(el, !xml);
          if (!xml && !this._inserted.has(el) && this._sheetLike(el)) {
            this._implicit.add(el);
          }
        }
        walk(el.children);
      }
    };
    walk(this._host.document().children);
  }

  /** A `<link rel=stylesheet>` or a `<style>` that makes a sheet this
   *  document's media applies. */
  private _sheetLike(el: Element): boolean {
    if (isForeign(el)) return false;
    const tag = tagOf(el);
    const { media } = el.attribs;
    if (media && media.trim() && !this._host.mediaMatches(media)) return false;
    if (tag === 'style') {
      const type = (el.attribs.type ?? '').trim().toLowerCase();
      return type === '' || type === 'text/css';
    }
    const { rel, href } = el.attribs;
    return (
      tag === 'link' &&
      hasToken(rel, 'stylesheet') &&
      !hasToken(rel, 'alternate') &&
      el.attribs.disabled === undefined &&
      !!href?.trim()
    );
  }

  /** Whether a fetch an element makes now is render-blocking (Resource
   *  Timing 2's `renderBlockingStatus`): it is in the head, and is
   *  potentially render-blocking — what its `blocking` says, or a script or
   *  a stylesheet the parser put there — whether or not the document still
   *  allows adding to the set. */
  blocksFetch(el: Element): boolean {
    this._scanHead();
    let head = false;
    for (let at = el.parent; at; at = at.parent) {
      if (isTag(at) && !isForeign(at) && tagOf(at) === 'head') {
        head = isTag(at.parent!) && tagOf(at.parent) === 'html';
        break;
      }
    }
    // a `<style>` the parser made blocks wherever it is, as Chromium has
    // it: the one exception to the head
    if (tagOf(el) === 'style') {
      return (
        this._potentially(el) ||
        (!this._inserted.has(el) && this._sheetLike(el))
      );
    }
    return head && (this._implicit.has(el) || this._potentially(el));
  }

  /** Take out what is over: an expectation met, an element gone. */
  private _prune(): void {
    for (const el of this._set) {
      if (!this._host.connected(el)) this._set.delete(el);
      else if (this._isExpect(el) && this._expected(el)) this._set.delete(el);
    }
  }

  /** The parser put nodes in (`DomHost.parserInserted`). */
  parsed(): void {
    this._scanHead();
    if (this._set.size) this._prune();
  }

  /** A script put nodes into the document: each link, script and style
   *  among them blocks where adding is allowed now. */
  connected(elements: readonly Element[]): void {
    for (const el of elements) this._inserted.add(el);
    this._scanHead();
    const allowed = this._allows();
    for (const el of elements) {
      const tag = tagOf(el);
      if (tag !== 'script' && tag !== 'link' && tag !== 'style') continue;
      if (!this._host.connected(el)) continue;
      // one that went in again goes back in no set it left
      if (this._decided.has(el) && !this._set.has(el)) {
        if (!allowed) continue;
        this._decided.delete(el);
      }
      this._decide(el, allowed);
    }
    if (this._set.size) this._prune();
  }

  /** Nodes went out of the document: what they hold blocks no more. */
  removed(): void {
    if (this._set.size) this._prune();
  }

  /**
   * An attribute changed. One whose change makes it no longer potentially
   * render-blocking is taken out; a link given another `href`, `rel` or
   * `media` is taken out, and its fetch goes again, as HTML processes the
   * link again; either is put back only where adding is still allowed.
   * An `id` or a `name` may be what an expectation waits for.
   */
  changed(el: Element, name: string): void {
    const tag = tagOf(el);
    if (tag === 'script' || tag === 'link' || tag === 'style') {
      if (RELEVANT.has(name)) {
        this._scanHead();
        const was = this._set.has(el);
        const keeps =
          was &&
          name !== 'href' &&
          name !== 'rel' &&
          name !== 'media' &&
          this._potentially(el);
        if (!keeps) {
          this._set.delete(el);
          if (this._allows() && this._host.connected(el)) {
            this._decided.delete(el);
            this._decide(el, true);
          }
        }
      }
    }
    if ((name === 'id' || name === 'name') && this._set.size) this._prune();
  }

  /** What an element fetches settled, or it ran: it blocks no more. */
  unblock(el: Element): void {
    this._set.delete(el);
  }

  /**
   * Whether the document is render-blocked: what the set holds, or that
   * adding is still allowed. `loading` is the realm's word for whether the
   * parse is still going on; once it is not, nothing more is added.
   */
  blocked(loading: boolean): boolean {
    this._scanHead();
    if (!loading) this._over = true;
    if (this._set.size) this._prune();
    return this._set.size > 0 || this._allows();
  }
}
