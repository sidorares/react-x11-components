// One tab's page: its documents, loaded and drawn. The browser runs one of
// these in a process of its own for each tab, through core's `<Frame>`
// (browser.tsx), so a page that throws, wedges its event loop or grows
// without bound costs its own tab and nothing else — the tab shows what
// happened and offers to reload, and the strip, the toolbar and every other
// tab carry on. On a backend with no way to show a pane the same component
// runs in the browser's own process instead.
//
// Everything a page needs lives here and nothing the tab strip does: the
// document and its resources come through this process's own network layer,
// `<Html>` draws them, and the status bubble — a hovered link, a notice, a
// count of resources still in flight — is drawn here, because it sits over
// the page and a host can draw nothing over a pane.
//
// What crosses the boundary is small on purpose. In: which history step to
// show, what to load, the zoom — numbers and strings, so a browser re-render
// that changed none of them sends nothing. Out, through callbacks that
// arrive as one-way messages: a document to make a history step of, its
// title and icon, a link followed. The history is the browser's; the
// documents are this process's, kept by the id the browser gave the
// navigation that loaded each one.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement } from 'react';
import * as DomUtils from 'domutils';
import {
  isFramed,
  matchesShortcut,
  useAccelerator,
  useSupports,
} from 'react-x11';
import type {
  DrawnNode,
  MouseEvent as X11MouseEvent,
  ScrollableNode,
} from 'react-x11';

import { Html, useHtmlHandle } from '../../src/html/index.js';
import type {
  Document,
  Element,
  ResourceRequest,
  ResourceResult,
} from '../../src/html/index.js';
import { decodeIcon, iconCandidates } from './favicon.js';
import { shortcuts } from './keys.js';
import type { Command } from './keys.js';
import type { TabIcon } from './favicon.js';
import { Network, NetworkError, resourceResult, schemeOf } from './network.js';
import type { DocumentResponse } from './network.js';
import {
  BLANK,
  HOME,
  blankPage,
  errorPage,
  fileName,
  homePage,
  imagePage,
  textPage,
  unsupportedPage,
} from './pages.js';

/** One process's network: a tab's own cache, where each tab is a process. */
const network = new Network();

/** Where a followed link goes: this tab, a new one, or one behind this. */
export type LinkTarget = 'here' | 'tab' | 'background';

/** What the browser tells a tab's page, and hears back. */
export interface PageProps {
  /** The history step to show, and the document it shows; 0 before the
   *  tab's first document arrives. A `#fragment` link is a step of its own
   *  that shows the same document. */
  entryId: number;
  doc: number;
  url: string;
  /** The navigation to load, until its document has all arrived — its id
   *  becomes the document's — or 0. */
  loadSeq: number;
  loadUrl: string;
  /** Past the cache: a reload with Shift. */
  loadFresh: boolean;
  zoom: number;
  /** The documents the tab's history still holds, comma-separated. Any
   *  other is let go. */
  docs: string;
  /** A navigation's document started to arrive: a history step for it. */
  onCommit(seq: number, url: string, title: string | null): void;
  /** …and all of it has. */
  onFinish(seq: number): void;
  /** A document's title or icon, as the page learns them; `undefined` is
   *  "no news". */
  onMeta(
    doc: number,
    title: string | null | undefined,
    icon: TabIcon | null | undefined,
  ): void;
  onLink(url: string, target: LinkTarget): void;
  /** The step shown has no document here — this process is newer than the
   *  step, after a crash — so it wants loading again. */
  onLost(entryId: number): void;
  /** One of the browser's own chords, pressed while this page had the key
   *  (`keys.ts`). */
  onCommand(command: Command): void;
}

/** What `<Html>` is given for one document. */
interface Doc {
  source: string;
  /** More source may still arrive — the document is streaming. */
  partial: boolean;
  charset?: string;
  /** What its relative URLs resolve against; null for the browser's own
   *  pages, which name only absolute ones. */
  baseUrl: string | null;
}

export default function Page(props: PageProps): ReactElement {
  const { entryId, doc, url, loadSeq, zoom } = props;
  const cocoa = useSupports('nativeControls');
  const [docs, setDocs] = useState<ReadonlyMap<number, Doc>>(new Map());
  const page = docs.get(doc) ?? null;
  const handle = useHtmlHandle();
  const scroller = useRef<ScrollableNode | null>(null);
  const [hoverLink, setHoverLink] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  /** Where each history step was scrolled to, for Back and Forward. */
  const scrolls = useRef(new Map<number, number>());
  // The latest callbacks, for the effects that outlive a render: across a
  // process they are stubs that may be new ones with every update.
  const live = useRef(props);
  live.current = props;

  // A pane that is a window of its own is sent the keys typed while the
  // pointer is over it, past the browser's handlers: the browser's chords
  // go back to it from here. Elsewhere the browser saw them first.
  const relay = useSupports('embedding') && isFramed();
  const chords = useMemo(() => shortcuts(cocoa ? 'Super' : 'Control'), [cocoa]);
  useAccelerator(
    chords.flatMap(([, shortcut]) => shortcut),
    (ev) => {
      const hit = chords.find(([, shortcut]) => matchesShortcut(ev, shortcut));
      if (hit) live.current.onCommand(hit[0]);
    },
    { enabled: relay },
  );

  const store = useCallback((id: number, next: Doc | null) => {
    setDocs((all) => {
      const out = new Map(all);
      if (next) out.set(id, next);
      else out.delete(id);
      return out;
    });
  }, []);

  // The navigation in progress, loaded; a new one, or none, aborts it. A
  // document cut off mid-stream stays as far as it got — the stop button's
  // meaning — rather than waiting for the rest forever.
  useEffect(() => {
    if (!loadSeq) return;
    const seq = loadSeq;
    const controller = new AbortController();
    void loadDocument(
      { seq, url: props.loadUrl, fresh: props.loadFresh },
      cocoa,
      controller.signal,
      {
        commit: (committed, first, title) => {
          store(seq, first);
          live.current.onCommit(seq, committed, title);
        },
        progress: (next) => store(seq, next),
        finish: () => live.current.onFinish(seq),
      },
    );
    return () => {
      controller.abort();
      setDocs((all) => {
        const cut = all.get(seq);
        if (!cut?.partial) return all;
        return new Map(all).set(seq, { ...cut, partial: false });
      });
    };
  }, [loadSeq]);

  // documents no step of the history shows any more
  useEffect(() => {
    const kept = new Set(props.docs.split(',').filter(Boolean).map(Number));
    setDocs((all) => {
      let out: Map<number, Doc> | null = null;
      for (const id of all.keys()) {
        if (kept.has(id) || id === loadSeq) continue;
        out ??= new Map(all);
        out.delete(id);
      }
      return out ?? all;
    });
  }, [props.docs]);

  // A step this process has no document for: it was loaded by the process
  // before this one, which is gone. Asked for once per step.
  const lost = useRef(0);
  useEffect(() => {
    if (!entryId || page || loadSeq || lost.current === entryId) return;
    lost.current = entryId;
    live.current.onLost(entryId);
  }, [entryId, page, loadSeq]);

  // a document's resources are fetched while it is the one showing
  const pageUrl = withoutHash(url);
  const requests = useMemo(() => new AbortController(), [doc]);
  useEffect(() => () => requests.abort(), [requests]);
  const inFlight = useRef(0);
  const onResource = useCallback(
    (request: ResourceRequest) => {
      inFlight.current += 1;
      setPending(inFlight.current);
      return resource(request, pageUrl, requests.signal).finally(() => {
        inFlight.current -= 1;
        setPending(inFlight.current);
      });
    },
    [pageUrl, requests],
  );

  // the title as the document states it, and its icon once its head is in
  const told = useRef({ doc: 0, title: null as string | null, icon: 0 });
  const onDocument = useCallback(
    (document: Document) => {
      if (!page) return;
      const title = titleOf(document);
      const headDone =
        !page.partial ||
        !!DomUtils.findOne((el) => el.name === 'body', document.children);
      queueMicrotask(() => {
        const was = told.current;
        if (was.doc !== doc) {
          was.doc = doc;
          was.title = null;
        }
        if (title !== was.title) {
          was.title = title;
          live.current.onMeta(doc, title, undefined);
        }
        if (headDone && was.icon !== doc && schemeOf(url) !== 'about') {
          was.icon = doc;
          const id = doc;
          void loadIcon(iconCandidates(document, url), url).then((icon) => {
            if (icon) live.current.onMeta(id, undefined, icon);
          });
        }
      });
    },
    [page, doc, url],
  );

  // scroll: to where this step was left, or to its fragment, or the top
  const fragment = url.split('#')[1] ?? '';
  const finished = !!page && !page.partial;
  useLayoutEffect(() => {
    if (!page) return;
    const saved = scrolls.current.get(entryId);
    if (saved === undefined && fragment) return;
    scroller.current?.scrollTo({ x: 0, y: saved ?? 0 });
  }, [entryId, !!page]);
  useEffect(() => {
    if (!fragment || !finished || scrolls.current.has(entryId)) return;
    // Where the element is is a question for the layout, which runs after
    // this commit rather than in it: asked a macrotask later, a page just
    // built has been laid out at the width it is shown at.
    const timer = setTimeout(() => {
      const document = handle.document;
      const target = document && fragmentTarget(document, fragment);
      const rect = target && handle.elementRect(target);
      if (rect) scroller.current?.scrollTo({ y: rect.y * zoom });
    }, 0);
    return () => clearTimeout(timer);
  }, [fragment, finished, entryId]);

  const onLink = (href: string, ev: X11MouseEvent<DrawnNode>) => {
    if (/^javascript:/i.test(href)) {
      setNotice('Scripts do not run in this browser.');
      return;
    }
    if (!/^(?:https?|file|data|about|view-source):/i.test(href)) {
      setNotice(
        `${schemeOf(href) || 'That'}: links are not something this browser opens.`,
      );
      return;
    }
    const modifier = cocoa ? ev.metaKey : ev.ctrlKey;
    let target = handle.elementAt(ev.x, ev.y);
    while (target && target.name !== 'a' && target.name !== 'area') {
      target =
        target.parent?.type === 'tag' ? (target.parent as Element) : null;
    }
    live.current.onLink(
      href,
      modifier
        ? 'background'
        : target?.attribs.target === '_blank'
          ? 'tab'
          : 'here',
    );
  };

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  // the link under the pointer was the last document's
  useEffect(() => setHoverLink(null), [doc]);

  const busy = !!loadSeq || !!page?.partial;
  const status =
    hoverLink ??
    notice ??
    (busy
      ? 'Loading…'
      : pending > 0
        ? `Loading ${pending} resource${pending === 1 ? '' : 's'}…`
        : null);

  return (
    <box
      style={{
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
        position: 'relative',
        backgroundColor: '$background',
      }}
    >
      <box
        ref={scroller}
        style={{ overflow: 'scroll', flexGrow: 1, flexShrink: 1, minHeight: 0 }}
        onScroll={(ev) => {
          if (entryId) scrolls.current.set(entryId, ev.scrollY);
        }}
        onMouseMove={(ev: X11MouseEvent<DrawnNode>) => {
          const href = handle.hrefAt(ev.x, ev.y);
          if (href !== hoverLink) setHoverLink(href);
        }}
        onMouseLeave={() => setHoverLink(null)}
        onMouseDown={(ev: X11MouseEvent<DrawnNode>) => {
          // a middle click opens the link in a tab behind this one
          if (ev.button !== 2) return;
          const href = handle.hrefAt(ev.x, ev.y);
          if (href) live.current.onLink(href, 'background');
        }}
      >
        {page ? (
          // Zoom is core's `scale`, CSS `zoom` for a subtree. A node's scale
          // is constant for its life by core's contract, and `<Html>` keeps
          // its device-pixel work on that promise, so a new zoom is a new
          // page — built from the source it already has and resources the
          // network layer kept.
          //
          // Both grow: a page shorter than the window is still as tall as
          // it, as a browser's canvas is, so its background reaches the
          // bottom at any size rather than stopping where the text does.
          <box scale={zoom} style={{ flexDirection: 'column', flexGrow: 1 }}>
            <Html
              key={`${doc}@${zoom}`}
              ref={handle.ref}
              // the web's `medium`: every page's `rem` is sixteen pixels in
              // a browser, and a design system spaces a page in them, where
              // the theme's own text size set it all an eighth too tight
              fontSize={16}
              source={page.source}
              partial={page.partial}
              charset={page.charset}
              baseUrl={page.baseUrl}
              onResource={onResource}
              onDocument={onDocument}
              onLink={onLink}
              style={{ flexGrow: 1 }}
            />
          </box>
        ) : null}
      </box>
      {status ? (
        <box
          style={{
            position: 'absolute',
            left: 0,
            bottom: 0,
            maxWidth: '70%',
            paddingLeft: 8,
            paddingRight: 8,
            paddingTop: 3,
            paddingBottom: 3,
            borderTopWidth: 1,
            borderRightWidth: 1,
            borderColor: '$border',
            backgroundColor: '$surface',
          }}
        >
          <text
            style={{
              fontSize: 11,
              color: '$textMuted',
              maxLines: 1,
              textOverflow: 'ellipsis',
            }}
          >
            {status}
          </text>
        </box>
      ) : null}
    </box>
  );
}

const withoutHash = (url: string): string => url.split('#')[0];

// --- loading a document ------------------------------------------------------

/**
 * How soon a streaming document is first handed to `<Html>`, and how that
 * grows. Each hand-over parses what arrived and lays out the whole document
 * so far, which on a long page costs more than the network does: at a
 * steady 120 ms Wikipedia's 540 KB article took 18 seconds to arrive, the
 * layouts starving the stream. Doubling after each one keeps the first
 * screen early and a long page to a handful of layouts.
 */
const STREAM_FIRST = 120;
const STREAM_MOST = 2000;

interface Navigation {
  seq: number;
  url: string;
  fresh: boolean;
}

interface LoadCallbacks {
  /** The document started to arrive, from `url` — where a redirect ended. */
  commit(url: string, first: Doc, title: string | null): void;
  progress(next: Doc): void;
  finish(): void;
}

/**
 * Load a navigation's document: the browser's own pages at once, anything
 * else through the network, an HTML response streamed into the page as it
 * arrives and a response of another kind turned into a page of its own.
 */
async function loadDocument(
  nav: Navigation,
  cocoa: boolean,
  signal: AbortSignal,
  on: LoadCallbacks,
): Promise<void> {
  const own = (source: string, title: string | null, url = nav.url) => {
    on.commit(url, { source, partial: false, baseUrl: null }, title);
    on.finish();
  };
  if (nav.url === HOME) return own(homePage(cocoa), 'New Tab');
  if (nav.url === BLANK) return own(blankPage(), 'about:blank');
  if (schemeOf(nav.url) === 'about') {
    return own(
      errorPage(nav.url, 'There is no such page.', 'ERR_INVALID_URL'),
      nav.url,
    );
  }
  const viewSource = nav.url.startsWith('view-source:');
  const target = viewSource ? nav.url.slice('view-source:'.length) : nav.url;
  if (nav.fresh) network.clear();

  let response: DocumentResponse;
  try {
    response = await network.document(target, signal);
  } catch (error) {
    if (signal.aborted) return;
    const { message, code } =
      error instanceof NetworkError
        ? error
        : {
            message: String((error as Error)?.message ?? error),
            code: 'ERR_FAILED',
          };
    return own(errorPage(target, message, code), null);
  }
  if (signal.aborted) return;

  const kind = viewSource ? 'text' : kindOf(response.type, response.url);
  if (kind !== 'html') {
    const bytes = await readAll(response.body, signal);
    if (signal.aborted) return;
    const url = viewSource ? `view-source:${response.url}` : response.url;
    if (kind === 'image') {
      network.seed({ ...response, bytes });
      return own(imagePage(response.url), fileName(response.url), url);
    }
    if (kind === 'text') {
      const text = decode(bytes, response.charset ?? sniffCharset(bytes));
      return own(textPage(url, text), viewSource ? url : fileName(url), url);
    }
    return own(unsupportedPage(response.url, response.type), null, url);
  }

  // HTML: stream it. The encoding is the response's, or the one a `<meta>`
  // in the first kilobyte names, or UTF-8 — found before a byte is decoded.
  let head: Uint8Array = new Uint8Array(0);
  const iterator = response.body[Symbol.asyncIterator]();
  let ended = false;
  while (head.length < 1024) {
    const { done, value } = await iterator.next();
    if (signal.aborted) return;
    if (done) {
      ended = true;
      break;
    }
    head = concat(head, value);
  }
  const charset = response.charset ?? sniffCharset(head) ?? 'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  let source = decoder.decode(head, { stream: true });
  const first: Doc = {
    source,
    partial: !ended,
    charset,
    baseUrl: response.url,
  };
  on.commit(response.url, first, null);
  let last = Date.now();
  let interval = STREAM_FIRST;
  while (!ended) {
    const { done, value } = await iterator.next();
    if (signal.aborted) {
      void iterator.return?.();
      return;
    }
    if (done) break;
    source += decoder.decode(value, { stream: true });
    if (Date.now() - last >= interval) {
      last = Date.now();
      interval = Math.min(interval * 2, STREAM_MOST);
      on.progress({ ...first, source });
    }
  }
  source += decoder.decode();
  on.progress({ ...first, source, partial: false });
  on.finish();
}

function kindOf(
  type: string,
  url: string,
): 'html' | 'text' | 'image' | 'other' {
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type.startsWith('image/')) return 'image';
  if (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/javascript' ||
    type.endsWith('+xml') ||
    type === 'application/xml'
  ) {
    return 'text';
  }
  // no type at all: what the address says, and HTML where it says nothing
  if (!type) return /\.(txt|md|json|css|js)$/i.test(url) ? 'text' : 'html';
  return 'other';
}

/** The encoding a document names in its first kilobyte: a byte order mark,
 *  or a `<meta charset>` or its `http-equiv` spelling (HTML 13.2.3.2). */
function sniffCharset(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : null;
}

function decode(bytes: Uint8Array, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

async function readAll(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let out: Uint8Array = new Uint8Array(0);
  for await (const chunk of body) {
    if (signal.aborted) break;
    out = concat(out, chunk);
  }
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** The subresource a page asked for, as `<Html>` takes it back. */
async function resource(
  request: ResourceRequest,
  page: string,
  signal: AbortSignal,
): Promise<ResourceResult | null> {
  const fetched = await network.resource(
    request.url,
    request.kind,
    page,
    signal,
  );
  return fetched ? resourceResult(fetched, request.kind) : null;
}

/** Decoded icons by URL, for every document this process shows: a site's
 *  icon is fetched and decoded once. */
const icons = new Map<string, Promise<TabIcon | null>>();

async function loadIcon(
  candidates: string[],
  page: string,
): Promise<TabIcon | null> {
  for (const url of candidates) {
    let pending = icons.get(url);
    if (!pending) {
      pending = network
        .resource(url, 'image', page)
        .then((f) => (f ? decodeIcon(f.bytes, url) : null));
      icons.set(url, pending);
    }
    const icon = await pending;
    if (icon) return icon;
  }
  return null;
}

/** The document's `<title>`, its white space collapsed as a tab shows it. */
function titleOf(doc: Document): string | null {
  const title = DomUtils.findOne((el) => el.name === 'title', doc.children);
  const text = title
    ? DomUtils.textContent(title).replace(/\s+/g, ' ').trim()
    : '';
  return text || null;
}

/** The element a fragment names: an `id`, or an old `<a name>`. */
function fragmentTarget(doc: Document, fragment: string): Element | null {
  const id = decodeURIComponent(fragment);
  if (!id) return null;
  return (
    DomUtils.findOne((el) => el.attribs.id === id, doc.children) ??
    DomUtils.findOne(
      (el) => el.name === 'a' && el.attribs.name === id,
      doc.children,
    )
  );
}
