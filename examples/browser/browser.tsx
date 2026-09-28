// Run with: npm run examples:browser [-- <url>]
//
// Needs a display — an X server, or a Mac with REACT_X11_BACKEND=cocoa — and
// a network for anything past the start page.
//
// A tabbed web browser, made of this package's components and nothing
// else: `<Tabs>` is the strip, `<Html>` draws each page, core's `<textinput>`
// is the address bar. What `<Html>` leaves to its host — every request a
// page makes — is `network.ts`: the document, streamed into `<Html>` as it
// arrives, and each stylesheet, image and `@font-face` font the page asks
// for through `onResource`, resolved against the page's URL by `baseUrl`.
//
// Nothing a page contains runs. `<Html>` hands scripts to `onScript` and
// executes none, and this browser has no engine to give them; a page that
// only draws itself with JavaScript shows what it has without it.
//
// Keys, on the platform's shortcut modifier — Ctrl on X11, Cmd on macOS:
//
//   T  new tab         W  close tab       L / F6  the address bar
//   R  reload (Shift: past the cache)    [ ]  back, forward (and Alt+←/→)
//   1–9  a tab by place    + − 0  zoom    Ctrl+Tab / Ctrl+Shift+Tab  cycle
//
// A middle click, or a click with the modifier held, opens a link in a new
// tab behind this one; a middle click on a tab closes it.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { ReactElement } from 'react';
import * as DomUtils from 'domutils';
import {
  Button,
  Icon,
  ThemeProvider,
  createRoot,
  useAccelerator,
  useSupports,
  useTheme,
} from 'react-x11';
import type {
  DrawnNode,
  MouseEvent as X11MouseEvent,
  ScrollableNode,
  TextInputNode,
} from 'react-x11';
import { XK_ESCAPE } from 'react-x11/keysyms';

import { Html, useHtmlHandle } from '../../src/html/index.js';
import type {
  Document,
  Element,
  ResourceRequest,
  ResourceResult,
} from '../../src/html/index.js';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../src/tabs/index.js';
import { displayUrl, urlFromInput } from './address.js';
import { decodeIcon, iconCandidates } from './favicon.js';
import type { TabIcon } from './favicon.js';
import { Network, NetworkError, schemeOf } from './network.js';
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

const network = new Network();

// --- the model ---------------------------------------------------------------

/** What `<Html>` is given for one page. */
interface Page {
  source: string;
  /** More source may still arrive — the document is streaming. */
  partial: boolean;
  charset?: string;
  /** What its relative URLs resolve against; null for the browser's own
   *  pages, which name only absolute ones. */
  baseUrl: string | null;
}

/** One step of a tab's history. */
interface Entry {
  id: number;
  /** The document it shows. A link to a `#fragment` of the same document
   *  is a step of its own that shows the same one: nothing is loaded, the
   *  page is not built again, and it only scrolls. */
  doc: number;
  url: string;
  page: Page;
  title: string | null;
  icon: TabIcon | null;
}

interface Navigation {
  seq: number;
  url: string;
  /** Push a history entry, or replace this one: a reload replaces. */
  replace: boolean;
  /** Past the cache: a reload with Shift. */
  fresh: boolean;
}

interface Tab {
  id: string;
  entries: Entry[];
  index: number;
  /** The navigation in progress, until its document has all arrived. */
  loading: Navigation | null;
  zoom: number;
  /** Put the caret in the address bar when the tab first shows. */
  focusAddress: boolean;
}

interface State {
  tabs: Tab[];
  active: string;
}

type Action =
  | { type: 'open'; id: string; nav: Navigation; background: boolean }
  | { type: 'close'; id: string; fallback: Tab }
  | { type: 'select'; id: string }
  | { type: 'navigate'; id: string; nav: Navigation }
  | { type: 'commit'; id: string; seq: number; entry: Entry; replace: boolean }
  | { type: 'progress'; id: string; doc: number; page: Page }
  | { type: 'finish'; id: string; seq: number }
  | { type: 'stop'; id: string }
  | { type: 'go'; id: string; delta: number }
  | { type: 'fragment'; id: string; entry: Entry }
  | {
      type: 'meta';
      id: string;
      doc: number;
      title?: string | null;
      icon?: TabIcon | null;
    }
  | { type: 'zoom'; id: string; zoom: number }
  | { type: 'focused'; id: string };

let counter = 0;
const nextId = (): number => ++counter;

function navigation(url: string, replace = false, fresh = false): Navigation {
  return { seq: nextId(), url, replace, fresh };
}

function newTab(url: string, focusAddress = false): Tab {
  return {
    id: `tab-${nextId()}`,
    entries: [],
    index: -1,
    loading: navigation(url),
    zoom: 1,
    focusAddress,
  };
}

function update(state: State, id: string, change: (tab: Tab) => Tab): State {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id ? change(tab) : tab)),
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'open': {
      const tab: Tab = {
        id: action.id,
        entries: [],
        index: -1,
        loading: action.nav,
        zoom: 1,
        focusAddress: !action.background && action.nav.url === HOME,
      };
      const at = state.tabs.findIndex((t) => t.id === state.active);
      const tabs = [...state.tabs];
      tabs.splice(action.background ? at + 1 : tabs.length, 0, tab);
      return { tabs, active: action.background ? state.active : tab.id };
    }
    case 'close': {
      const at = state.tabs.findIndex((t) => t.id === action.id);
      if (at < 0) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      // the last tab closed opens a fresh one rather than an empty window
      if (!tabs.length)
        return { tabs: [action.fallback], active: action.fallback.id };
      const active =
        state.active === action.id
          ? tabs[Math.min(at, tabs.length - 1)].id
          : state.active;
      return { tabs, active };
    }
    case 'select':
      return state.tabs.some((t) => t.id === action.id)
        ? { ...state, active: action.id }
        : state;
    case 'navigate':
      return update(state, action.id, (tab) => ({
        ...tab,
        loading: action.nav,
      }));
    case 'commit':
      return update(state, action.id, (tab) => {
        if (tab.loading?.seq !== action.seq) return tab;
        const kept = tab.entries.slice(
          0,
          action.replace ? Math.max(0, tab.index) : tab.index + 1,
        );
        const entries = [...kept, action.entry];
        return { ...tab, entries, index: entries.length - 1 };
      });
    case 'progress':
      return update(state, action.id, (tab) => ({
        ...tab,
        entries: tab.entries.map((e) =>
          e.doc === action.doc ? { ...e, page: action.page } : e,
        ),
      }));
    case 'finish':
      return update(state, action.id, (tab) =>
        tab.loading?.seq === action.seq ? { ...tab, loading: null } : tab,
      );
    case 'stop':
      return update(state, action.id, (tab) => ({
        ...tab,
        loading: null,
        entries: tab.entries.map((e, i) =>
          i === tab.index && e.page.partial
            ? { ...e, page: { ...e.page, partial: false } }
            : e,
        ),
      }));
    case 'go':
      return update(state, action.id, (tab) => {
        const index = tab.index + action.delta;
        if (index < 0 || index >= tab.entries.length) return tab;
        return { ...tab, index, loading: null };
      });
    case 'fragment':
      return update(state, action.id, (tab) => {
        const entries = [...tab.entries.slice(0, tab.index + 1), action.entry];
        return { ...tab, entries, index: entries.length - 1 };
      });
    case 'meta':
      return update(state, action.id, (tab) => ({
        ...tab,
        entries: tab.entries.map((e) =>
          e.doc === action.doc
            ? {
                ...e,
                title: action.title !== undefined ? action.title : e.title,
                icon: action.icon !== undefined ? action.icon : e.icon,
              }
            : e,
        ),
      }));
    case 'zoom':
      return update(state, action.id, (tab) => ({ ...tab, zoom: action.zoom }));
    case 'focused':
      return update(state, action.id, (tab) => ({
        ...tab,
        focusAddress: false,
      }));
  }
}

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function zoomStep(zoom: number, direction: 1 | -1): number {
  const at = ZOOMS.findIndex((z) => z >= zoom - 0.001);
  const next = Math.max(0, Math.min(ZOOMS.length - 1, at + direction));
  return ZOOMS[next];
}

const withoutHash = (url: string): string => url.split('#')[0];

/**
 * Focus the address bar with its text selected, so what is typed replaces
 * it — what Ctrl+L does in every browser. `<textinput>` has no public call
 * for its own selection: `selectAll()` on a node is a selection surface's,
 * and a field selects all only on Ctrl+A or from its edit menu. So this
 * reaches the method those two share, where the field has it, and is the
 * one place this example leans on core's internals.
 */
function focusField(node: TextInputNode | null | undefined): void {
  if (!node) return;
  node.focus();
  const own = (node as unknown as { _selectAll?: () => void })._selectAll;
  if (typeof own === 'function') own.call(node);
}

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

interface LoadCallbacks {
  commit(entry: Entry): void;
  progress(doc: number, page: Page): void;
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
    const id = nextId();
    on.commit({
      id,
      doc: id,
      url,
      page: { source, partial: false, baseUrl: null },
      title,
      icon: null,
    });
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
  const id = nextId();
  const entry: Entry = {
    id,
    doc: id,
    url: response.url,
    page: { source, partial: !ended, charset, baseUrl: response.url },
    title: null,
    icon: null,
  };
  on.commit(entry);
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
      on.progress(entry.doc, { ...entry.page, source });
    }
  }
  source += decoder.decode();
  on.progress(entry.doc, { ...entry.page, source, partial: false });
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

/** The subresource a page asked for, as `<Html>` takes it back. WebP and
 *  AVIF are declined — nothing here decodes them, and a declined image
 *  keeps its box. */
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
  if (!fetched) return null;
  if (request.kind === 'stylesheet') {
    return {
      kind: 'stylesheet',
      bytes: fetched.bytes,
      charset: fetched.charset ?? undefined,
      url: fetched.url,
    };
  }
  if (request.kind === 'font') return { kind: 'font', bytes: fetched.bytes };
  const b = fetched.bytes;
  const webp =
    b.length > 12 &&
    String.fromCharCode(b[0], b[1], b[2], b[3], b[8], b[9], b[10], b[11]) ===
      'RIFFWEBP';
  if (webp || fetched.type === 'image/avif') return null;
  return { kind: 'image', bytes: b };
}

/** Decoded icons by URL, shared by every tab: a site's icon is fetched and
 *  decoded once. */
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

// --- glyphs ---------------------------------------------------------------
//
// Core's icon set is affordances — chevrons, a close, a plus — and those
// come from it. A globe and a circular arrow are nouns and are drawn here,
// the line AGENTS.md draws for this package. They are drawn on every paint
// rather than through the paint cache: a cached one-colour drawing inside
// a rounded button composites empty (core's docs/elements.md, `mono`), and
// three strokes cost nothing to draw again.

function Globe({ size = 16 }: { size?: number }): ReactElement {
  const theme = useTheme() as unknown as { textMuted?: string };
  return (
    <canvas
      style={{ width: size, height: size, flexShrink: 0 }}
      onDraw={(ctx, info) => {
        const c = info.width / 2;
        const r = c - info.scale;
        ctx.strokeStyle = theme.textMuted ?? '#7f8c8d';
        ctx.lineWidth = 1.2 * info.scale;
        ctx.beginPath();
        ctx.arc(c, c, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(c, c, r * 0.45, r, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(c - r, c);
        ctx.lineTo(c + r, c);
        ctx.stroke();
      }}
    />
  );
}

/** ↻: a circle open at the top, its end an arrowhead turning clockwise. */
function ReloadGlyph({ size = 14 }: { size?: number }): ReactElement {
  const theme = useTheme() as unknown as { text?: string };
  return (
    <canvas
      style={{ width: size, height: size }}
      onDraw={(ctx, info) => {
        const w = info.width;
        const c = w / 2;
        const r = w * 0.34;
        const from = (-35 * Math.PI) / 180;
        const to = (265 * Math.PI) / 180;
        ctx.strokeStyle = theme.text ?? '#2d3436';
        ctx.fillStyle = theme.text ?? '#2d3436';
        ctx.lineWidth = 1.5 * info.scale;
        ctx.beginPath();
        ctx.arc(c, c, r, from, to);
        ctx.stroke();
        // the head, at the end the stroke travels to, along its tangent
        const x = c + r * Math.cos(to);
        const y = c + r * Math.sin(to);
        const dx = -Math.sin(to);
        const dy = Math.cos(to);
        const h = w * 0.3;
        ctx.beginPath();
        ctx.moveTo(x + dx * h * 0.7, y + dy * h * 0.7);
        ctx.lineTo(
          x - dx * h * 0.3 + dy * h * 0.5,
          y - dy * h * 0.3 - dx * h * 0.5,
        );
        ctx.lineTo(
          x - dx * h * 0.3 - dy * h * 0.5,
          y - dy * h * 0.3 + dx * h * 0.5,
        );
        ctx.closePath();
        ctx.fill();
      }}
    />
  );
}

/** A turning arc, while a page loads. */
function Spinner({ size = 16 }: { size?: number }): ReactElement {
  const theme = useTheme() as unknown as { accent?: string };
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setPhase((p) => (p + 1) % 24), 60);
    return () => clearInterval(timer);
  }, []);
  return (
    <canvas
      style={{ width: size, height: size }}
      onDraw={(ctx, info) => {
        const c = info.width / 2;
        const start = (phase / 24) * Math.PI * 2;
        ctx.strokeStyle = theme.accent ?? '#2980b9';
        ctx.lineWidth = 2 * info.scale;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(c, c, c - 2 * info.scale, start, start + Math.PI * 1.4);
        ctx.stroke();
      }}
    />
  );
}

function TabGlyph({
  icon,
  loading,
}: {
  icon: TabIcon | null;
  loading: boolean;
}): ReactElement {
  if (loading) return <Spinner />;
  if (!icon) return <Globe />;
  if (icon.kind === 'svg') {
    return (
      <svg
        source={icon.source}
        style={{ width: 16, height: 16, flexShrink: 0 }}
      />
    );
  }
  return (
    <image
      src={icon.src}
      cacheKey={icon.key}
      style={{ width: 16, height: 16, flexShrink: 0 }}
    />
  );
}

// --- the tab strip -----------------------------------------------------------

function TabLabel({
  tab,
  onClose,
}: {
  tab: Tab;
  onClose: () => void;
}): ReactElement {
  const entry = tab.entries[tab.index];
  const [hover, setHover] = useState(false);
  const title =
    tab.loading && !entry
      ? 'Loading…'
      : (entry?.title ?? (entry ? fileName(entry.url) : 'New Tab'));
  return (
    <box
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, width: 188 }}
      // a middle click closes a tab, as it does in every browser
      onMouseUp={(ev: X11MouseEvent<DrawnNode>) => {
        if (ev.button === 2) onClose();
      }}
    >
      <TabGlyph icon={entry?.icon ?? null} loading={!!tab.loading} />
      <text
        style={{
          flexGrow: 1,
          flexShrink: 1,
          fontSize: 12,
          maxLines: 1,
          textOverflow: 'ellipsis',
        }}
      >
        {title}
      </text>
      <box
        role="button"
        aria-label="Close tab"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={(ev: X11MouseEvent<DrawnNode>) => {
          // the trigger around this selects on a click; closing it must not
          ev.stopPropagation();
          onClose();
        }}
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          flexShrink: 0,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: hover ? '$border' : 'transparent',
        }}
      >
        <Icon name="close" size={8} />
      </box>
    </box>
  );
}

// --- one tab's toolbar and page ----------------------------------------------

interface TabViewProps {
  tab: Tab;
  active: boolean;
  /** The shortcut modifier, as a chord names it: Cmd on macOS. */
  mod: 'Super' | 'Control';
  dispatch: (action: Action) => void;
  open: (url: string, background: boolean) => void;
  register: (id: string, input: TextInputNode | null) => void;
}

function TabView({
  tab,
  active,
  mod,
  dispatch,
  open,
  register,
}: TabViewProps): ReactElement {
  const entry = tab.entries[tab.index] ?? null;
  const handle = useHtmlHandle();
  const scroller = useRef<ScrollableNode | null>(null);
  const input = useRef<TextInputNode | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [hoverLink, setHoverLink] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Where each history entry was scrolled to, for Back and Forward. */
  const scrolls = useRef(new Map<number, number>());
  const [pending, setPending] = useState(0);

  // the navigation in progress, loaded; a new one, or a closed tab, aborts it
  const loading = tab.loading;
  useEffect(() => {
    if (!loading) return;
    const controller = new AbortController();
    const id = tab.id;
    void loadDocument(loading, mod === 'Super', controller.signal, {
      commit: (e) => {
        dispatch({
          type: 'commit',
          id,
          seq: loading.seq,
          entry: e,
          replace: loading.replace,
        });
        setDraft(null);
      },
      progress: (doc, page) => dispatch({ type: 'progress', id, doc, page }),
      finish: () => dispatch({ type: 'finish', id, seq: loading.seq }),
    });
    return () => controller.abort();
    // `seq` is the navigation's identity; the object is rebuilt with the tab
  }, [loading?.seq]);

  // a document's resources are fetched while it is the one showing
  const entryId = entry?.id ?? 0;
  const docId = entry?.doc ?? 0;
  const pageUrl = entry ? withoutHash(entry.url) : '';
  const requests = useMemo(() => new AbortController(), [docId]);
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
  const iconAsked = useRef<number>(0);
  const onDocument = useCallback(
    (doc: Document) => {
      if (!entry) return;
      const title = titleOf(doc);
      const id = entry.doc;
      const url = entry.url;
      queueMicrotask(() => {
        if (title !== entry.title) {
          dispatch({ type: 'meta', id: tab.id, doc: id, title });
        }
        const headDone =
          !entry.page.partial ||
          !!DomUtils.findOne((el) => el.name === 'body', doc.children);
        if (headDone && iconAsked.current !== id && schemeOf(url) !== 'about') {
          iconAsked.current = id;
          void loadIcon(iconCandidates(doc, url), url).then((icon) => {
            if (icon) dispatch({ type: 'meta', id: tab.id, doc: id, icon });
          });
        }
      });
    },
    [entry, tab.id, dispatch],
  );

  // scroll: to where this entry was left, or to its fragment, or the top
  const fragment = entry ? (entry.url.split('#')[1] ?? '') : '';
  const finished = !!entry && !entry.page.partial;
  useLayoutEffect(() => {
    if (!entry) return;
    const saved = scrolls.current.get(entry.id);
    if (saved === undefined && fragment) return;
    scroller.current?.scrollTo({ x: 0, y: saved ?? 0 });
  }, [entryId]);
  useEffect(() => {
    if (!fragment || !finished || scrolls.current.has(entryId)) return;
    // Where the element is is a question for the layout, which runs after
    // this commit rather than in it: asked a macrotask later, a page just
    // built has been laid out at the width it is shown at.
    const timer = setTimeout(() => {
      const doc = handle.document;
      const target = doc && fragmentTarget(doc, fragment);
      const rect = target && handle.elementRect(target);
      if (rect) scroller.current?.scrollTo({ y: rect.y * tab.zoom });
    }, 0);
    return () => clearTimeout(timer);
  }, [fragment, finished, entryId]);

  // the address bar
  useEffect(() => {
    register(tab.id, input.current);
    return () => register(tab.id, null);
  }, [tab.id]);
  useEffect(() => {
    if (!active || !tab.focusAddress) return;
    input.current?.focus();
    dispatch({ type: 'focused', id: tab.id });
  }, [active, tab.focusAddress]);
  const address =
    draft ??
    (tab.loading && !entry ? tab.loading.url : displayUrl(entry?.url ?? ''));
  const go = (text: string) => {
    const url = urlFromInput(text);
    if (!url) return;
    setDraft(null);
    navigate(url);
  };

  const navigate = (url: string) => {
    if (
      entry &&
      withoutHash(url) === withoutHash(entry.url) &&
      url.includes('#')
    ) {
      // the same document: a new history entry, and a scroll, no request
      dispatch({
        type: 'fragment',
        id: tab.id,
        entry: { ...entry, id: nextId(), url },
      });
      return;
    }
    dispatch({ type: 'navigate', id: tab.id, nav: navigation(url) });
  };

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
    const modifier = mod === 'Super' ? ev.metaKey : ev.ctrlKey;
    let target = handle.elementAt(ev.x, ev.y);
    while (target && target.name !== 'a' && target.name !== 'area') {
      target =
        target.parent?.type === 'tag' ? (target.parent as Element) : null;
    }
    if (modifier) open(href, true);
    else if (target?.attribs.target === '_blank') open(href, false);
    else navigate(href);
  };

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  // the link under the pointer was the last document's
  useEffect(() => setHoverLink(null), [docId]);

  const busy = !!tab.loading || !!entry?.page.partial;
  const status =
    hoverLink ??
    notice ??
    (busy
      ? 'Loading…'
      : pending > 0
        ? `Loading ${pending} resource${pending === 1 ? '' : 's'}…`
        : null);

  return (
    // Every box from the panel down to the scroller shrinks, or a page
    // taller than the window makes them all as tall as it is, and nothing
    // scrolls: a flex item's floor is its content until it says otherwise.
    <box
      style={{
        flexDirection: 'column',
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
      }}
    >
      <box
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 2,
          paddingLeft: 8,
          paddingRight: 8,
          paddingTop: 6,
          paddingBottom: 6,
          borderBottomWidth: 1,
          borderColor: '$border',
          backgroundColor: '$surface',
        }}
      >
        <Button
          variant="ghost"
          size="small"
          aria-label="Back"
          disabled={tab.index <= 0}
          onPress={() => dispatch({ type: 'go', id: tab.id, delta: -1 })}
        >
          <Icon name="chevronLeft" size={10} />
        </Button>
        <Button
          variant="ghost"
          size="small"
          aria-label="Forward"
          disabled={tab.index >= tab.entries.length - 1}
          onPress={() => dispatch({ type: 'go', id: tab.id, delta: 1 })}
        >
          <Icon name="chevronRight" size={10} />
        </Button>
        <Button
          variant="ghost"
          size="small"
          aria-label={busy ? 'Stop' : 'Reload'}
          onPress={() =>
            busy
              ? dispatch({ type: 'stop', id: tab.id })
              : entry &&
                dispatch({
                  type: 'navigate',
                  id: tab.id,
                  nav: navigation(entry.url, true),
                })
          }
        >
          {busy ? <Icon name="close" size={9} /> : <ReloadGlyph />}
        </Button>
        <textinput
          ref={input}
          value={address}
          placeholder="Search, or enter an address"
          onChange={(ev) => setDraft(ev.value)}
          onSubmit={(ev) => go(ev.value)}
          onKeyDown={(ev) => {
            // Escape puts back the address the page is at
            if (ev.keysym === XK_ESCAPE) setDraft(null);
          }}
          // the field is the pill, so the focus ring core draws round it
          // follows its corners
          style={{
            flexGrow: 1,
            height: 30,
            marginLeft: 6,
            paddingLeft: 14,
            paddingRight: 14,
            borderRadius: 15,
            borderWidth: 1,
            borderColor: '$border',
            backgroundColor: '$background',
            fontSize: 13,
            color: '$text',
          }}
        />
        {tab.zoom !== 1 ? (
          <Button
            variant="ghost"
            size="small"
            onPress={() => dispatch({ type: 'zoom', id: tab.id, zoom: 1 })}
          >
            {`${Math.round(tab.zoom * 100)}%`}
          </Button>
        ) : null}
      </box>
      <box
        style={{
          flexGrow: 1,
          flexShrink: 1,
          minHeight: 0,
          position: 'relative',
        }}
      >
        <box
          ref={scroller}
          style={{
            overflow: 'scroll',
            flexGrow: 1,
            flexShrink: 1,
            minHeight: 0,
          }}
          onScroll={(ev) => {
            if (entry) scrolls.current.set(entry.id, ev.scrollY);
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
            if (href) open(href, true);
          }}
        >
          {entry ? (
            // Zoom is core's `scale`, CSS `zoom` for a subtree. A node's
            // scale is constant for its life by core's contract, and
            // `<Html>` keeps its device-pixel work on that promise, so a new
            // zoom is a new page — built from the source it already has and
            // resources the network layer kept.
            <box scale={tab.zoom} style={{ flexDirection: 'column' }}>
              <Html
                key={`${entry.doc}@${tab.zoom}`}
                ref={handle.ref}
                source={entry.page.source}
                partial={entry.page.partial}
                charset={entry.page.charset}
                baseUrl={entry.page.baseUrl}
                onResource={onResource}
                onDocument={onDocument}
                onLink={onLink}
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
    </box>
  );
}

// --- the window --------------------------------------------------------------

/** `colorScheme` is a seam for screenshots; by default the browser, and
 *  every page's `prefers-color-scheme`, follow the desktop. */
export function Browser({
  start = HOME,
  colorScheme = 'system',
}: {
  start?: string;
  colorScheme?: 'light' | 'dark' | 'system';
}): ReactElement {
  const [state, dispatch] = useReducer(reducer, start, (url) => {
    const tab = newTab(url, url === HOME);
    return { tabs: [tab], active: tab.id };
  });
  const cocoa = useSupports('nativeControls');
  /** The shortcut modifier, as a chord names it. */
  const mod = cocoa ? 'Super' : 'Control';
  const inputs = useRef(new Map<string, TextInputNode | null>());
  const register = useCallback((id: string, node: TextInputNode | null) => {
    if (node) inputs.current.set(id, node);
    else inputs.current.delete(id);
  }, []);

  const active = state.tabs.find((t) => t.id === state.active) ?? state.tabs[0];
  const entry = active.entries[active.index];

  const open = useCallback((url: string, background: boolean) => {
    dispatch({
      type: 'open',
      id: `tab-${nextId()}`,
      nav: navigation(url),
      background,
    });
  }, []);
  const close = (id: string) =>
    dispatch({ type: 'close', id, fallback: newTab(HOME, true) });
  const focusAddress = () => focusField(inputs.current.get(active.id));
  const reload = (fresh: boolean) => {
    if (entry) {
      dispatch({
        type: 'navigate',
        id: active.id,
        nav: navigation(entry.url, true, fresh),
      });
    }
  };
  const cycle = (by: number) => {
    const at = state.tabs.findIndex((t) => t.id === active.id);
    const next = state.tabs[(at + by + state.tabs.length) % state.tabs.length];
    dispatch({ type: 'select', id: next.id });
  };

  useAccelerator([[mod, 'T']], () => open(HOME, false));
  useAccelerator([[mod, 'W']], () => close(active.id));
  useAccelerator([[mod, 'L'], ['F6'], ['Alt', 'D']], focusAddress);
  useAccelerator([[mod, 'R'], ['F5']], () => reload(false));
  useAccelerator(
    [
      [mod, 'Shift', 'R'],
      ['Shift', 'F5'],
    ],
    () => reload(true),
  );
  useAccelerator(
    [
      ['Alt', 'Left'],
      [mod, 'bracketleft'],
    ],
    () => dispatch({ type: 'go', id: active.id, delta: -1 }),
  );
  useAccelerator(
    [
      ['Alt', 'Right'],
      [mod, 'bracketright'],
    ],
    () => dispatch({ type: 'go', id: active.id, delta: 1 }),
  );
  useAccelerator(
    [
      ['Control', 'Tab'],
      ['Control', 'Page_Down'],
    ],
    () => cycle(1),
  );
  useAccelerator(
    [
      ['Control', 'Shift', 'Tab'],
      ['Control', 'Page_Up'],
    ],
    () => cycle(-1),
  );
  useAccelerator(
    [
      [mod, 'plus'],
      [mod, 'equal'],
    ],
    () =>
      dispatch({ type: 'zoom', id: active.id, zoom: zoomStep(active.zoom, 1) }),
  );
  useAccelerator([[mod, 'minus']], () =>
    dispatch({ type: 'zoom', id: active.id, zoom: zoomStep(active.zoom, -1) }),
  );
  useAccelerator([[mod, '0']], () =>
    dispatch({ type: 'zoom', id: active.id, zoom: 1 }),
  );
  useAccelerator(
    [['Escape']],
    () => dispatch({ type: 'stop', id: active.id }),
    {
      enabled: !!active.loading,
    },
  );
  const selectAt = (n: number) => {
    const tab = n === 9 ? state.tabs[state.tabs.length - 1] : state.tabs[n - 1];
    if (tab) dispatch({ type: 'select', id: tab.id });
  };
  useAccelerator([[mod, '1']], () => selectAt(1));
  useAccelerator([[mod, '2']], () => selectAt(2));
  useAccelerator([[mod, '3']], () => selectAt(3));
  useAccelerator([[mod, '4']], () => selectAt(4));
  useAccelerator([[mod, '5']], () => selectAt(5));
  useAccelerator([[mod, '6']], () => selectAt(6));
  useAccelerator([[mod, '7']], () => selectAt(7));
  useAccelerator([[mod, '8']], () => selectAt(8));
  useAccelerator([[mod, '9']], () => selectAt(9));

  const title = entry?.title ?? (entry ? fileName(entry.url) : 'New Tab');

  return (
    <window title={`${title} — react-x11 browser`} width={1180} height={820}>
      <ThemeProvider
        colorScheme={colorScheme}
        style={{ backgroundColor: '$background', flexGrow: 1 }}
      >
        <Tabs
          value={active.id}
          onValueChange={(e) => dispatch({ type: 'select', id: e.value })}
          variant="outline"
          size="sm"
          ground="$surface"
          style={{ flexGrow: 1 }}
        >
          <TabsList
            style={{
              paddingLeft: 6,
              paddingRight: 6,
              paddingTop: 6,
              backgroundColor: '$surfaceHover',
            }}
          >
            {state.tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                <TabLabel tab={tab} onClose={() => close(tab.id)} />
              </TabsTrigger>
            ))}
            <Button
              variant="ghost"
              size="small"
              aria-label="New tab"
              onPress={() => open(HOME, false)}
            >
              <Icon name="plus" size={10} />
            </Button>
          </TabsList>
          {state.tabs.map((tab) => (
            <TabsContent key={tab.id} value={tab.id} style={{ paddingTop: 0 }}>
              <TabView
                tab={tab}
                active={tab.id === active.id}
                mod={mod}
                dispatch={dispatch}
                open={open}
                register={register}
              />
            </TabsContent>
          ))}
        </Tabs>
      </ThemeProvider>
    </window>
  );
}

export default Browser;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const arg = process.argv[2];
  const start = arg ? (urlFromInput(arg) ?? HOME) : HOME;
  const root = await createRoot();
  root.render(<Browser start={start} />);
}
