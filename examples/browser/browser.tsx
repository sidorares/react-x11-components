// Run with: npm run examples:browser [-- <url>]
//
// Needs a display — an X server, or a Mac with REACT_X11_BACKEND=cocoa — and
// a network for anything past the start page.
//
// A tabbed web browser, made of this package's components and nothing
// else: `<Tabs>` is the strip, `<Html>` draws each page, core's `<textinput>`
// is the address bar. What `<Html>` leaves to its host — every request a
// page makes — is `HtmlNetwork` (`src/html/network.ts`), with this
// browser's User-Agent: the document, streamed into `<Html>` as it
// arrives, and each stylesheet, image and `@font-face` font the page asks
// for through `onResource`, resolved against the page's URL by `baseUrl`.
//
// Each tab's page runs in a process of its own, through core's `<Frame>`:
// `page.tsx` is that pane, and everything a page needs is in it. A page that
// throws, or grows past its heap (`PANE_FLAGS`), costs its own tab — which
// says so, and offers to reload — and never the strip, the toolbar or
// another tab. So does one that wedges its event loop: `<Frame>` asks its
// pane about once a second, and ends one that has not answered in 15
// seconds. This file is the rest: the history, the strip, the toolbar and
// the keys. Where no pane can be shown, the same page runs in this
// process instead, and `BROWSER_INLINE=1` asks for that anywhere.
//
// Nothing a page contains runs unless you say so. `<Html>` runs a page's
// scripts only with `scripts` (`src/html/scripts/`, docs/prd-html-scripts.md),
// and this browser turns it on only on a site whose JS switch, in the
// toolbar, is on — every site with `BROWSER_SCRIPTS=1`. The
// engine keeps a page's scripts in a `vm` context of their own and stops
// one that runs away, but it is no boundary against a page that sets out
// to attack the machine: the tab's process is, and it is a weak one. A page
// that only draws itself with JavaScript shows what it has without it.
//
// What a browser keeps between two runs it keeps in its profile
// (`profile.ts`): the cookies, `localStorage`, `sessionStorage` and
// IndexedDB of every site, in one database every tab's process shares, the
// HTTP cache in a second beside it, and the tabs it had open, which come back with their histories when it starts
// again. `BROWSER_PROFILE=temp` (or `--temp-profile`) runs with a profile
// that goes when the browser does, `BROWSER_PROFILE=<dir>` with another, and
// `BROWSER_RESTORE=0` without the last session's tabs.
//
// Keys, on the platform's shortcut modifier — Ctrl on X11, Cmd on macOS:
//
//   T  new tab         W  close tab       L / F6  the address bar
//   R  reload (Shift: past the cache)    [ ]  back, forward (and Alt+←/→)
//   1–9  a tab by place    + − 0  zoom    Ctrl+Tab / Ctrl+Shift+Tab  cycle
//
// A middle click, or a click with the modifier held, opens a link in a new
// tab behind this one; a middle click on a tab closes it.
//
// Full screen — the green button on a Mac, the window manager's on X11 —
// gives the page the whole screen: the strip and the toolbar come back while
// the pointer is at the top edge or over them, and while the address bar has
// the focus.
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { ReactElement } from 'react';
import {
  Button,
  Frame,
  Icon,
  ThemeProvider,
  createRoot,
  matchesShortcut,
  useSupports,
  useTheme,
  useWindowState,
} from 'react-x11';
import type {
  DrawnNode,
  FrameComponentProps,
  FrameError,
  FrameProps,
  KeyboardEvent as X11KeyboardEvent,
  LayoutEvent,
  MouseEvent as X11MouseEvent,
  NtkWindow,
  TextInputNode,
} from 'react-x11';
import { XK_DOWN, XK_ESCAPE, XK_RETURN, XK_UP } from 'react-x11/keysyms';

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../src/tabs/index.js';
import { displayUrl, urlFromInput } from './address.js';
import { presetFor, userAgentPresets } from './useragents.js';
import type { UserAgentPreset } from './useragents.js';
import type { TabIcon } from './favicon.js';
import Page from './page.js';
import type {
  History,
  HistoryEntry,
  LinkTarget,
  LoadHow,
  PageProps,
} from './page.js';
import type { PostData } from '../../src/html/index.js';
import { shortcuts } from './keys.js';
import type { Command } from './keys.js';
import { HOME, fileName } from './pages.js';
import {
  openProfile,
  readPreferences,
  readSession,
  savePreferences,
  saveSession,
  tabKey,
} from './profile.js';
import type { SavedSession } from './profile.js';

/** The pane each tab's page runs in: `page.tsx`'s default export. */
const PAGE = new URL('./page.tsx', import.meta.url);

/**
 * How a page's process is started, after the browser's own flags, so these
 * win where the two disagree:
 *
 *  - `--max-old-space-size`: what it may hold, in megabytes of V8's old
 *    space. A page whose script allocates without end — which no `node:vm`
 *    context bounds — ends its own tab there, and not the machine's
 *    memory. Node enforces it; Bun 1.4 passes the flag on and enforces
 *    nothing (core's `docs/frame.md`). `BROWSER_PANE_HEAP_MB` sets it.
 *  - `--wasm-max-mem-pages`: how much `WebAssembly.Memory` a page may
 *    grow, in 64 KiB pages — the old-space bound does not count it, so a
 *    page could hold a half-gigabyte of wasm memory under a small heap
 *    cap. `BROWSER_PANE_WASM_MB` sets it, in megabytes. (ArrayBuffers are
 *    out of every flag; the pane watches its own resident size for those,
 *    `page.tsx`.)
 *  - `--experimental-vm-modules`: what makes Node call the host for a
 *    page's `import()`, which fails there with the page's own error, and
 *    `vm.SourceTextModule`, which its module scripts run on; without it
 *    Node refuses an `import()` with an error of the host's, which reaches
 *    the host's `Function`, and the engine runs no script
 *    (`SCRIPTS_CONTAINED`). Bun needs no flag. The warning the flag prints
 *    in every pane is left out.
 */
const PANE_FLAGS = [
  `--max-old-space-size=${Number(process.env.BROWSER_PANE_HEAP_MB) || 1024}`,
  // in 64 KiB pages: megabytes × 16
  `--wasm-max-mem-pages=${(Number(process.env.BROWSER_PANE_WASM_MB) || 512) * 16}`,
  '--experimental-vm-modules',
  '--disable-warning=ExperimentalWarning',
];

/**
 * The environment a page's pane starts with, cut to what a windowed Node
 * process needs. A pane inherits the browser's environment (core's
 * `paneEnv` starts from `process.env`), which on a developer's machine
 * carries tokens, cloud credentials and `npm_config_*` secrets a page's
 * scripts have no business near. `<Frame env>` takes `undefined` to mean
 * "drop this one", so everything outside the allow-list below is dropped;
 * what stays is the display, the locale, the paths and this example's own
 * `BROWSER_*`/`REACT_X11_*` switches. It is a policy, not a boundary — the
 * `node:vm` sandbox does not read the environment either way — and it is
 * deliberately generous, so widen it rather than let the pane fail to
 * start.
 */
const PANE_ENV: Record<string, string | undefined> = (() => {
  const keep =
    /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|TMPDIR|LANG|LC_[A-Z]+|LANGUAGE|TZ|TERM|DISPLAY|XAUTHORITY|WAYLAND_DISPLAY|XDG_[A-Z_]+|NODE_[A-Z_]*|BROWSER_[A-Z_]+|REACT_X11_[A-Z_]+)$/;
  const out: Record<string, string | undefined> = {};
  for (const name of Object.keys(process.env)) {
    if (!keep.test(name)) out[name] = undefined;
  }
  return out;
})();

// --- the model ---------------------------------------------------------------

/**
 * One entry of a tab's history. The history is the page's process's — one
 * `HtmlSessionHistory` a tab, which a page's own `pushState` and fragments
 * write to as well as every document shown — and the page tells the browser
 * of it as it changes (`PageProps.onHistory`), so the address bar follows a
 * single-page app from route to route, and Back goes back one of them. This
 * is that history, mirrored: an entry's document, by the id of the
 * navigation that loaded it, is what its title, icon and POST are kept by.
 */
type Entry = HistoryEntry;

/** What the browser keeps of a document a navigation loaded. */
interface DocInfo {
  title: string | null;
  icon: TabIcon | null;
  /** The form data it answered, where a POST loaded it: a reload sends it
   *  again. */
  post: PostData | null;
}

interface Navigation {
  seq: number;
  url: string;
  /** How its document comes into the history (`LoadHow`), and for a step
   *  to a document the page has let go, the entry's key. */
  how: LoadHow;
  key: string;
  /** Past the cache: a reload with Shift. */
  fresh: boolean;
  /** A form's POST, or null for a GET. */
  post: PostData | null;
}

/** A step the page is asked to take in the history: Back or Forward, or a
 *  fragment of the document shown, typed. */
interface Step {
  seq: number;
  delta: number;
  url: string;
}

interface Tab {
  id: string;
  /** What its `sessionStorage` is kept by in the profile, kept across a
   *  restart with the tab. */
  key: string;
  /** The history as the page last told it, and as it told it (JSON), which
   *  a page process that is new to the tab starts from. */
  entries: Entry[];
  index: number;
  history: string;
  /** What is kept of each document an entry is of, by its id. */
  docs: ReadonlyMap<number, DocInfo>;
  /** The document that arrived last, kept until the history has it. */
  last: number;
  /** The navigation in progress, until its document has all arrived. */
  loading: Navigation | null;
  /** The last step the page was asked to take. */
  step: Step | null;
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
  | {
      type: 'commit';
      id: string;
      seq: number;
      title: string | null;
      posted: boolean;
    }
  | { type: 'finish'; id: string; seq: number }
  | { type: 'stop'; id: string }
  | { type: 'history'; id: string; history: string }
  | { type: 'step'; id: string; step: Step }
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

function navigation(
  url: string,
  how: LoadHow = 'push',
  fresh = false,
  post: PostData | null = null,
  key = '',
): Navigation {
  return { seq: nextId(), url, how, key, fresh, post };
}

function emptyTab(
  id: string,
  nav: Navigation | null,
  focusAddress: boolean,
): Tab {
  return {
    id,
    key: tabKey(),
    entries: [],
    index: -1,
    history: '',
    docs: new Map(),
    last: 0,
    loading: nav,
    step: null,
    zoom: 1,
    focusAddress,
  };
}

function newTab(url: string, focusAddress = false): Tab {
  return emptyTab(`tab-${nextId()}`, navigation(url), focusAddress);
}

/**
 * The tabs a session kept, open again: each with its key and its history,
 * which its page's process starts from and loads the entry it shows from
 * (`Page`'s "the entry shown has no document here"), or the address it was
 * loading where it had no history yet.
 */
function restoredState(saved: SavedSession, start: string | null): State {
  const tabs = saved.tabs.map((kept) => {
    let history: History | null = null;
    try {
      history = kept.history ? (JSON.parse(kept.history) as History) : null;
    } catch {
      history = null;
    }
    const tab = emptyTab(
      `tab-${nextId()}`,
      history?.entries.length ? null : navigation(kept.url || HOME),
      false,
    );
    return history?.entries.length
      ? {
          ...tab,
          key: kept.key,
          entries: history.entries,
          index: history.index,
          history: kept.history,
          zoom: kept.zoom,
        }
      : { ...tab, key: kept.key, zoom: kept.zoom };
  });
  let active = tabs[Math.min(Math.max(saved.active, 0), tabs.length - 1)].id;
  // an address on the command line opens in a tab of its own, shown
  if (start) {
    const tab = newTab(start);
    tabs.push(tab);
    active = tab.id;
  }
  return { tabs, active };
}

/** The tabs as a session keeps them. */
function savedOf(state: State): SavedSession {
  return {
    version: 1,
    tabs: state.tabs.map((tab) => ({
      key: tab.key,
      history: tab.history,
      url: tab.loading?.url ?? tab.entries[tab.index]?.url ?? '',
      zoom: tab.zoom,
    })),
    active: Math.max(
      0,
      state.tabs.findIndex((tab) => tab.id === state.active),
    ),
  };
}

/** What is kept of the document an entry is of. */
function infoOf(tab: Tab, entry: Entry | undefined): DocInfo | undefined {
  return entry && tab.docs.get(entry.doc);
}

/** The entry shown, loaded again: a reload, sending the POST that loaded
 *  it again where one did. */
function reloadOf(tab: Tab, fresh = false): Navigation | null {
  const entry = tab.entries[tab.index];
  if (!entry) return null;
  return navigation(
    entry.url,
    'reload',
    fresh,
    infoOf(tab, entry)?.post ?? null,
  );
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
      const tab = emptyTab(
        action.id,
        action.nav,
        !action.background && action.nav.url === HOME,
      );
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
      // a document arrived, which the history will say where it is in
      return update(state, action.id, (tab) => {
        const nav = tab.loading;
        if (nav?.seq !== action.seq) return tab;
        const docs = new Map(tab.docs).set(nav.seq, {
          title: action.title,
          icon: null,
          post: action.posted ? nav.post : null,
        });
        return { ...tab, docs, last: nav.seq };
      });
    case 'history':
      return update(state, action.id, (tab) => {
        const { entries, index } = JSON.parse(action.history) as History;
        // what is kept of documents no entry is of any more is let go
        const kept = new Set(entries.map((e) => e.doc));
        kept.add(tab.last);
        if (tab.loading) kept.add(tab.loading.seq);
        const docs = new Map([...tab.docs].filter(([doc]) => kept.has(doc)));
        return { ...tab, entries, index, history: action.history, docs };
      });
    case 'finish':
      return update(state, action.id, (tab) =>
        tab.loading?.seq === action.seq ? { ...tab, loading: null } : tab,
      );
    case 'stop':
      return update(state, action.id, (tab) => ({ ...tab, loading: null }));
    case 'step':
      // Back or Forward stops what is loading, and goes from where the
      // history is
      return update(state, action.id, (tab) => {
        const index = tab.index + action.step.delta;
        if (index < 0 || index >= tab.entries.length) return tab;
        return {
          ...tab,
          step: action.step,
          loading: action.step.delta ? null : tab.loading,
        };
      });
    case 'meta':
      return update(state, action.id, (tab) => {
        const was = tab.docs.get(action.doc);
        if (!was) return tab;
        const docs = new Map(tab.docs).set(action.doc, {
          ...was,
          title: action.title !== undefined ? action.title : was.title,
          icon: action.icon !== undefined ? action.icon : was.icon,
        });
        return { ...tab, docs };
      });
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

/** Go to a typed `url` in `tab`: a new entry, and a `#fragment` of the
 *  document the tab shows one the page takes without loading anything. */
function navigateIn(
  tab: Tab,
  url: string,
  dispatch: (action: Action) => void,
): void {
  const entry = tab.entries[tab.index];
  if (
    entry &&
    url.includes('#') &&
    withoutHash(url) === withoutHash(entry.url)
  ) {
    dispatch({
      type: 'step',
      id: tab.id,
      step: { seq: nextId(), delta: 0, url },
    });
    return;
  }
  dispatch({ type: 'navigate', id: tab.id, nav: navigation(url) });
}

/** Back or Forward, in `tab`'s history. */
function stepIn(
  tab: Tab,
  delta: number,
  dispatch: (action: Action) => void,
): void {
  dispatch({
    type: 'step',
    id: tab.id,
    step: { seq: nextId(), delta, url: '' },
  });
}

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
  const info = infoOf(tab, entry);
  const [hover, setHover] = useState(false);
  const title =
    tab.loading && !entry
      ? 'Loading…'
      : (info?.title ?? (entry ? fileName(entry.url) : 'New Tab'));
  return (
    <box
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, width: 188 }}
      // a middle click closes a tab, as it does in every browser
      onMouseUp={(ev: X11MouseEvent<DrawnNode>) => {
        if (ev.button === 2) onClose();
      }}
    >
      <TabGlyph icon={info?.icon ?? null} loading={!!tab.loading} />
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

// --- the User-Agent menu -------------------------------------------------------

/** How wide the User-Agent menu's sheet is: a full agent string is long, so
 *  the rows show the preset's name, not the string itself. */
const UA_MENU_WIDTH = 200;

/**
 * The toolbar's User-Agent menu — a button that names the agent in force and
 * a `<popup>` of the presets (`useragents.ts`). The choice is the browser's,
 * not one tab's, so picking one here changes `BROWSER_USER_AGENT` for every
 * pane; a change of that environment respawns each pane (`<Frame env>`), so
 * the tabs reload under the new agent, the way a browser's UA override
 * applies on the next load.
 *
 * Shaped like `examples/terminal-vt.tsx`' frame-rate menu: the popup grabs
 * the pointer so a press anywhere else dismisses it, and the button keeps
 * the keyboard while it is open — Down/Up walk, Enter commits, Escape shuts
 * — rather than handing focus to a window the next click destroys.
 */
function UserAgentMenu({
  presets,
  current,
  onChoose,
}: {
  presets: readonly UserAgentPreset[];
  /** The id of the preset in force. */
  current: string;
  onChoose: (id: string) => void;
}): ReactElement {
  const theme = useTheme();
  const trigger = useRef<DrawnNode>(null);
  const [open, setOpen] = useState(false);
  // -1 is "nothing yet": a menu dropped with the mouse lights no row until
  // the pointer or the arrows have said which, so Enter cannot commit a row
  // nobody chose.
  const [active, setActive] = useState(-1);

  const chosen = presets.findIndex((p) => p.id === current);
  const label = presets[chosen]?.short ?? 'UA';
  const close = (): void => setOpen(false);

  const commit = (index: number): void => {
    const preset = presets[index];
    if (!preset) return;
    close();
    onChoose(preset.id);
  };

  const onKeyDown = (ev: X11KeyboardEvent): void => {
    if (ev.keysym === XK_ESCAPE) {
      if (!open) return;
      close();
    } else if (ev.keysym === XK_DOWN || ev.keysym === XK_UP) {
      const step = ev.keysym === XK_DOWN ? 1 : -1;
      if (!open) {
        // opened from the keyboard, so it opens on the row that is current
        setActive(chosen);
        setOpen(true);
      } else {
        setActive((at) => {
          const from = at < 0 ? chosen : at;
          const n = presets.length;
          return (((from + step) % n) + n) % n;
        });
      }
    } else if (ev.keysym === XK_RETURN || ev.codepoint === 32) {
      if (!open) {
        setActive(chosen);
        setOpen(true);
      } else commit(active < 0 ? chosen : active);
    } else return;
    ev.preventDefault();
    ev.stopPropagation();
  };

  return (
    <box
      ref={trigger}
      role="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`User agent: ${presets[chosen]?.label ?? 'default'}`}
      focusable
      tabIndex={0}
      onMouseDown={() => {
        setActive(-1);
        setOpen((was) => !was);
      }}
      onKeyDown={onKeyDown}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        height: 24,
        paddingLeft: 8,
        paddingRight: 6,
        borderRadius: 6,
        backgroundColor: open ? '$surfaceHover' : 'transparent',
        cursor: 'pointer',
      }}
    >
      <text style={{ fontSize: 12, color: '$text' }}>{label}</text>
      <Icon name="chevronDown" size={8} />

      {open && (
        <popup
          // A popup is a window of its own and inherits no palette, so the
          // `$token` values in its subtree need the theme handed over.
          theme={theme as Record<string, string | number>}
          width={UA_MENU_WIDTH}
          anchor={{ to: trigger, placement: 'bottom', align: 'end' }}
          grab
          onDismiss={close}
          style={{ backgroundColor: '$background' }}
        >
          <box
            role="menu"
            style={{
              flexGrow: 1,
              padding: 4,
              gap: 2,
              borderWidth: 1,
              borderColor: '$border',
              backgroundColor: '$background',
            }}
          >
            {presets.map((preset, index) => (
              <box
                key={preset.id}
                role="menuitemradio"
                aria-checked={index === chosen}
                onMouseEnter={() => setActive(index)}
                onClick={() => commit(index)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  paddingLeft: 8,
                  paddingRight: 8,
                  paddingTop: 5,
                  paddingBottom: 5,
                  borderRadius: 5,
                  cursor: 'pointer',
                  ...(index === active && { backgroundColor: '$surfaceHover' }),
                }}
              >
                {/* a fixed-width slot so the labels line up whether or not a
                    row carries the check */}
                <box style={{ width: 12, alignItems: 'center' }}>
                  {index === chosen ? <Icon name="check" size={10} /> : null}
                </box>
                <text
                  style={{
                    fontSize: 13,
                    color: '$text',
                    fontWeight: index === chosen ? 'bold' : 'normal',
                  }}
                >
                  {preset.label}
                </text>
              </box>
            ))}
          </box>
        </popup>
      )}
    </box>
  );
}

// --- one tab's toolbar ---------------------------------------------------------

interface ToolbarProps {
  tab: Tab;
  active: boolean;
  dispatch: (action: Action) => void;
  register: (id: string, input: TextInputNode | null) => void;
  /** Whether the page's site runs its scripts, and a flip of that. */
  scripts: boolean;
  onScripts: (on: boolean) => void;
  /** The User-Agent presets, the id in force, and a change of it — the
   *  browser's one setting, shown in every tab's toolbar. */
  userAgents: readonly UserAgentPreset[];
  userAgentId: string;
  onUserAgent: (id: string) => void;
  /** The address bar took the focus, or gave it up. */
  onAddressFocus: (focused: boolean) => void;
}

function Toolbar({
  tab,
  active,
  dispatch,
  register,
  scripts,
  onScripts,
  userAgents,
  userAgentId,
  onUserAgent,
  onAddressFocus,
}: ToolbarProps): ReactElement {
  const entry = tab.entries[tab.index] ?? null;
  const input = useRef<TextInputNode | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  // a document that arrived replaces what was being typed — but not a page
  // moving to another of its routes, which would take the words from under
  // someone's fingers
  useEffect(() => setDraft(null), [entry?.doc]);

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
    navigateIn(tab, url, dispatch);
  };
  const busy = !!tab.loading;

  return (
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
        onPress={() => stepIn(tab, -1, dispatch)}
      >
        <Icon name="chevronLeft" size={10} />
      </Button>
      <Button
        variant="ghost"
        size="small"
        aria-label="Forward"
        disabled={tab.index >= tab.entries.length - 1}
        onPress={() => stepIn(tab, 1, dispatch)}
      >
        <Icon name="chevronRight" size={10} />
      </Button>
      <Button
        variant="ghost"
        size="small"
        aria-label={busy ? 'Stop' : 'Reload'}
        onPress={() => {
          if (busy) return dispatch({ type: 'stop', id: tab.id });
          const nav = reloadOf(tab);
          if (nav) dispatch({ type: 'navigate', id: tab.id, nav });
        }}
      >
        {busy ? <Icon name="close" size={9} /> : <ReloadGlyph />}
      </Button>
      <textinput
        ref={input}
        value={address}
        placeholder="Search, or enter an address"
        onChange={(ev) => setDraft(ev.value)}
        onSubmit={(ev) => go(ev.value)}
        onFocus={() => onAddressFocus(true)}
        onBlur={() => onAddressFocus(false)}
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
      {entry && /^(https?|file):/.test(entry.url) ? (
        // the site's switch: its scripts run where it is on
        <Button
          variant={scripts ? 'solid' : 'ghost'}
          size="small"
          aria-label={
            scripts
              ? 'Scripts run on this site: turn them off'
              : 'Scripts do not run on this site: turn them on'
          }
          onPress={() => onScripts(!scripts)}
        >
          JS
        </Button>
      ) : null}
      <UserAgentMenu
        presets={userAgents}
        current={userAgentId}
        onChoose={onUserAgent}
      />
    </box>
  );
}

/** A site, as its scripts' switch is kept: the origin of its pages. */
function siteOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

// --- one tab's page ------------------------------------------------------------

type PaneTransport = FrameComponentProps['transport'];

interface TabPageProps {
  tab: Tab;
  /** Whether it is the tab showing, the only one whose page Tab goes to. */
  active: boolean;
  /** Whether the page's scripts run (`PageProps.scripts`). */
  scripts: boolean;
  /** The User-Agent the pane sends and names, or `null` for the default.
   *  A change respawns the pane, so the tab reloads under the new agent. */
  userAgent: string | null;
  /** Run the page in this process rather than a pane of its own. */
  inline: boolean;
  transport?: PaneTransport;
  dispatch: (action: Action) => void;
  open: (url: string, background: boolean, post?: PostData | null) => void;
  onCommand: (command: Command) => void;
}

/**
 * A tab's page: `page.tsx` in a pane of its own, told which step of the
 * history to show and what to load, and telling the history what arrived.
 * The callbacks it is handed keep their identity for the tab's life, so a
 * render of the browser that changed nothing the page shows sends it
 * nothing (`<Frame>` compares the bag value by value).
 */
function TabPage({
  tab,
  active,
  scripts,
  userAgent,
  inline,
  transport,
  dispatch,
  open,
  onCommand,
}: TabPageProps): ReactElement {
  const id = tab.id;
  const latest = useRef(tab);
  latest.current = tab;
  // the tab's own key, which its process keeps its `sessionStorage` by. The
  // User-Agent goes in the props bag, not here: in the env it would respawn
  // the pane on every change (`<Frame env>`), where as a prop it reaches the
  // running process, which sets it on its network and reloads in place.
  const env = useMemo(
    () => ({ ...PANE_ENV, BROWSER_TAB_KEY: tab.key }),
    [tab.key],
  );

  const onCommit = useCallback(
    (seq: number, _url: string, title: string | null, posted: boolean) =>
      dispatch({ type: 'commit', id, seq, title, posted }),
    [id, dispatch],
  );
  const onHistory = useCallback(
    (history: string) => dispatch({ type: 'history', id, history }),
    [id, dispatch],
  );
  const onFinish = useCallback(
    (seq: number) => dispatch({ type: 'finish', id, seq }),
    [id, dispatch],
  );
  const onMeta = useCallback(
    (
      doc: number,
      title: string | null | undefined,
      icon: TabIcon | null | undefined,
    ) => dispatch({ type: 'meta', id, doc, title, icon }),
    [id, dispatch],
  );
  // what the page goes to — a link, a form, `location` — is its own
  // navigation, which the history takes as the page planned it
  const onLink = useCallback(
    (url: string, target: LinkTarget, post: PostData | null) => {
      if (target !== 'here') return open(url, target === 'background', post);
      dispatch({
        type: 'navigate',
        id,
        nav: navigation(url, 'page', false, post),
      });
    },
    [id, dispatch, open],
  );
  // and an entry whose document the page no longer has, loaded again with
  // the POST that loaded it where one did
  const onLoad = useCallback(
    (url: string, how: LoadHow, key: string, doc: number) => {
      const post = latest.current.docs.get(doc)?.post ?? null;
      dispatch({
        type: 'navigate',
        id,
        nav: navigation(url, how, false, post, key),
      });
    },
    [id, dispatch],
  );

  const props: PageProps = {
    loadSeq: tab.loading?.seq ?? 0,
    loadUrl: tab.loading?.url ?? '',
    loadHow: tab.loading?.how ?? 'push',
    loadKey: tab.loading?.key ?? '',
    loadFresh: tab.loading?.fresh ?? false,
    loadPost: tab.loading?.post ?? null,
    stepSeq: tab.step?.seq ?? 0,
    stepDelta: tab.step?.delta ?? 0,
    stepUrl: tab.step?.url ?? '',
    history: tab.history,
    zoom: tab.zoom,
    scripts,
    userAgent,
    onCommit,
    onFinish,
    onHistory,
    onMeta,
    onLink,
    onLoad,
    onCommand,
  };

  if (inline) return <Page {...props} />;
  return (
    <Frame
      src={PAGE}
      props={props as unknown as FrameProps}
      transport={transport}
      execArgv={PANE_FLAGS}
      env={env}
      // A tab aside is still in the window, so its pane would be a stop in
      // the window's order, between the page showing and the tab strip:
      // Tab off the end of a page went on into the next tab's, off screen.
      focusable={active}
      style={{ flexGrow: 1, backgroundColor: '$background' }}
      // A backend with no way to show a pane says so before anything is
      // spawned, as an `embed` failure: the page runs here instead. Any
      // other failure is the page's process ending under it.
      fallback={({ error, restart }) =>
        error?.phase === 'embed' ? (
          <Page {...props} />
        ) : (
          <Stopped error={error} onReload={restart} />
        )
      }
      onExit={({ expected }) => {
        // a navigation the process was loading is not arriving
        if (!expected) dispatch({ type: 'stop', id });
      }}
    />
  );
}

/** A tab whose page's process ended. Reloading starts a new one, which
 *  finds it has no document for the step it is shown and asks for it. */
function Stopped({
  error,
  onReload,
}: {
  error: FrameError | null;
  onReload: () => void;
}): ReactElement {
  return (
    <box
      style={{
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        backgroundColor: '$background',
      }}
    >
      <text style={{ fontSize: 20, color: '$text' }}>
        This tab’s page stopped
      </text>
      <text
        style={{
          fontSize: 12,
          color: '$textMuted',
          maxWidth: 560,
          maxLines: 4,
          textOverflow: 'ellipsis',
        }}
      >
        {error?.message ?? 'Its process ended.'}
      </text>
      <Button onPress={onReload}>Reload</Button>
    </box>
  );
}

/**
 * Where a tab that is not showing keeps its page: its process, its
 * document and where it was scrolled all stay, so the pane stays mounted —
 * at its full size, off to the side of the window, where the window clips
 * it away whole. Hidden the way `<TabsContent>` hides a panel,
 * `display: 'none'`, a `<foreign>` stays mapped and is squeezed to a pixel,
 * and the page inside would lay its whole document out again at that width
 * on every switch of tab, and again on the way back. X carries a window's
 * position in 16 bits, which is what bounds how far aside.
 *
 * Its full size is the size the window last held still at, not the size
 * it is now (`useSettledSize`). A pane that followed the window would lay
 * its page out again at every step of a drag — and on macOS draw it into a
 * new set of surfaces — as much work for each tab aside as for the one
 * showing, for pixels nobody sees. Brought to the window's size once the
 * window stops, the tab shown next is that size already, and showing it
 * lays nothing out.
 */
const ASIDE = -30000;

/** How long the window's size holds still before the tabs aside are
 *  brought to it. */
const SETTLE_MS = 200;

interface Size {
  width: number;
  height: number;
}

/** The size the tabs' area last held still at — null until it has — and
 *  the `onLayout` that watches the area. */
function useSettledSize(): [Size | null, (ev: LayoutEvent) => void] {
  const [size, setSize] = useState<Size | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onLayout = useCallback((ev: LayoutEvent) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setSize({ width: ev.width, height: ev.height }),
      SETTLE_MS,
    );
  }, []);
  return [size, onLayout];
}

// --- the window --------------------------------------------------------------

export interface BrowserProps {
  start?: string;
  /** A seam for screenshots; by default the browser, and every page's
   *  `prefers-color-scheme`, follow the desktop. */
  colorScheme?: 'light' | 'dark' | 'system';
  /** Run every page in this process rather than a pane of its own. */
  inline?: boolean;
  /** How a page's pane is started — `<Frame transport>`, the seam a test
   *  runs panes through without forking. */
  paneTransport?: PaneTransport;
  /** Whether a site's scripts run where nobody switched them on or off for
   *  it. Default: `BROWSER_SCRIPTS=1`. */
  scripts?: boolean;
  /** The last session's tabs, to open again in place of `start`'s alone:
   *  `start`, where given, opens beside them. */
  restore?: SavedSession | null;
  /** Told the tabs as they change, for the next run to restore. */
  onSession?: (session: SavedSession) => void;
  /** A tab closed, whose `sessionStorage` the profile can let go. */
  onTabClosed?: (key: string) => void;
  /** The sites whose scripts someone switched on or off, as last kept. */
  sites?: [site: string, on: boolean][];
  /** Told the sites' switches as they change. */
  onSites?: (sites: [site: string, on: boolean][]) => void;
  /** The User-Agent preset in force, by id, as last kept (`useragents.ts`);
   *  absent means the default. */
  userAgent?: string;
  /** Told when the chosen User-Agent preset changes, to keep for next run. */
  onUserAgent?: (id: string) => void;
}

/**
 * Whether the strip and the toolbar show. Always, but in full screen, where
 * they step aside for the page as a browser's do and come back while the
 * pointer is at the window's top edge or over them, or while the address bar
 * has the focus. Leaving them hides them a moment later, so a pointer that
 * crosses a gap on its way between the two does not make them flicker.
 *
 * `fullscreen` turns as the transition begins, before the animation, so the
 * chrome goes while the window grows rather than after it.
 */
function useChrome(fullscreen: boolean) {
  const [hover, setHover] = useState(false);
  const [typing, setTyping] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  // out of full screen, a hover from before it does not hold them open
  useEffect(() => {
    if (!fullscreen) setHover(false);
  }, [fullscreen]);
  return {
    shown: !fullscreen || hover || typing,
    enter: () => {
      cancel();
      setHover(true);
    },
    leave: () => {
      cancel();
      timer.current = setTimeout(() => setHover(false), CHROME_LINGER_MS);
    },
    setTyping,
  };
}

/** How long the chrome stays after the pointer leaves it in full screen. */
const CHROME_LINGER_MS = 400;

export function Browser({
  start = HOME,
  colorScheme = 'system',
  inline = false,
  paneTransport,
  scripts = process.env.BROWSER_SCRIPTS === '1',
  restore = null,
  onSession,
  onTabClosed,
  sites: keptSites,
  onSites,
  userAgent: keptUserAgent,
  onUserAgent,
}: BrowserProps): ReactElement {
  const [state, dispatch] = useReducer(reducer, start, (url) => {
    if (restore?.tabs.length) {
      return restoredState(restore, url === HOME ? null : url);
    }
    const tab = newTab(url, url === HOME);
    return { tabs: [tab], active: tab.id };
  });
  // the tabs as they change, for the next run; and a closed tab's session
  // let go
  const sessionNow = useRef(onSession);
  sessionNow.current = onSession;
  useEffect(() => sessionNow.current?.(savedOf(state)), [state]);
  const keys = useRef(new Set(state.tabs.map((tab) => tab.key)));
  useEffect(() => {
    const now = new Set(state.tabs.map((tab) => tab.key));
    for (const key of keys.current) if (!now.has(key)) onTabClosed?.(key);
    keys.current = now;
  }, [state.tabs]);
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
  const [settled, onAreaLayout] = useSettledSize();

  const windowRef = useRef<NtkWindow | null>(null);
  const { fullscreen } = useWindowState(windowRef);
  const chrome = useChrome(fullscreen);
  // a tab that opens on its address bar shows the bar to type in
  const chromeShown = chrome.shown || active.focusAddress;
  // Ctrl+L in full screen: the field is focused once it is shown again
  const [addressWanted, setAddressWanted] = useState(false);
  useEffect(() => {
    if (!addressWanted || !chromeShown) return;
    setAddressWanted(false);
    focusField(inputs.current.get(active.id));
  }, [addressWanted, chromeShown]);

  // Which sites run their scripts: each site's switch, where someone
  // flipped it, and `scripts` for the rest. A site is an origin, as a
  // browser's site settings are kept.
  const [sites, setSites] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(keptSites ?? []),
  );
  const sitesTold = useRef(sites);
  useEffect(() => {
    if (sitesTold.current === sites) return;
    sitesTold.current = sites;
    onSites?.([...sites]);
  }, [sites]);
  const scriptsFor = (url: string): boolean =>
    sites.get(siteOf(url)) ?? scripts;

  // The User-Agent every tab sends and names: the browser's one setting,
  // not a tab's. The presets name the host's OS, so they are worked out
  // once from `process.platform`. The chosen string is a prop every page
  // reads (`TabPage`), so a change reaches each running pane, which sets it
  // on its network for the next request; the active tab reloads so the agent
  // shows on the page in view at once, the way a browser's UA override
  // applies on the next load. Other tabs take it on their next navigation.
  const userAgents = useMemo(() => userAgentPresets(process.platform), []);
  const [userAgentId, setUserAgentId] = useState(
    () => presetFor(userAgents, keptUserAgent).id,
  );
  const userAgentValue = presetFor(userAgents, userAgentId).value;
  const chooseUserAgent = (nextId: string): void => {
    if (nextId === userAgentId) return;
    setUserAgentId(nextId);
    onUserAgent?.(nextId);
    const nav = reloadOf(active);
    if (nav) dispatch({ type: 'navigate', id: active.id, nav });
  };

  const open = useCallback(
    (url: string, background: boolean, post: PostData | null = null) => {
      dispatch({
        type: 'open',
        id: `tab-${nextId()}`,
        nav: navigation(url, 'push', false, post),
        background,
      });
    },
    [],
  );
  const close = (id: string) =>
    dispatch({ type: 'close', id, fallback: newTab(HOME, true) });
  // A page a form's POST loaded is loaded by sending the POST again — the
  // browser would otherwise show what a GET of its URL gets, which is
  // usually a different page. Browsers ask before they do; this one sends
  // what the person sent a moment ago, to the site they sent it to.
  const reload = (fresh: boolean) => {
    const nav = reloadOf(active, fresh);
    if (nav) dispatch({ type: 'navigate', id: active.id, nav });
  };
  const cycle = (by: number) => {
    const at = state.tabs.findIndex((t) => t.id === active.id);
    const next = state.tabs[(at + by + state.tabs.length) % state.tabs.length];
    dispatch({ type: 'select', id: next.id });
  };
  const selectAt = (n: number) => {
    const tab = n === 9 ? state.tabs[state.tabs.length - 1] : state.tabs[n - 1];
    if (tab) dispatch({ type: 'select', id: tab.id });
  };
  const zoom = (to: number) =>
    dispatch({ type: 'zoom', id: active.id, zoom: to });

  const run = (command: Command) => {
    switch (command) {
      case 'newTab':
        return open(HOME, false);
      case 'closeTab':
        return close(active.id);
      case 'address':
        if (chromeShown) return focusField(inputs.current.get(active.id));
        chrome.setTyping(true);
        return setAddressWanted(true);
      case 'reload':
        return reload(false);
      case 'reloadFresh':
        return reload(true);
      case 'back':
        return stepIn(active, -1, dispatch);
      case 'forward':
        return stepIn(active, 1, dispatch);
      case 'nextTab':
        return cycle(1);
      case 'previousTab':
        return cycle(-1);
      case 'zoomIn':
        return zoom(zoomStep(active.zoom, 1));
      case 'zoomOut':
        return zoom(zoomStep(active.zoom, -1));
      case 'zoomReset':
        return zoom(1);
      case 'stop':
        return dispatch({ type: 'stop', id: active.id });
      default:
        return selectAt(Number(command.slice(3)));
    }
  };
  // Checked in the window's `onKeyDown` rather than bound as accelerators.
  // While a page has the focus a key is on its way into the page's pane,
  // and an accelerator runs only after the focused element's own default
  // action — a pane's is to forward the key — so it would never see one. A
  // handler on the window sees every key first, and a key it takes
  // (`preventDefault`) goes no further. A page the pointer rests on is sent
  // keys past all of this on X11, and passes the chords back (`keys.ts`).
  const chords = shortcuts(mod);
  const onKeyDown = (ev: X11KeyboardEvent) => {
    for (const [command, shortcut] of chords) {
      if (!matchesShortcut(ev, shortcut)) continue;
      // Escape is the page's, or the address bar's, unless there is a load
      // to stop
      if (command === 'stop' && !active.loading) return;
      ev.preventDefault();
      run(command);
      return;
    }
  };
  // what a page passes back is the same command, from the tab it is in
  const latestRun = useRef(run);
  latestRun.current = run;
  const onCommand = useCallback(
    (command: Command) => latestRun.current(command),
    [],
  );

  const title =
    infoOf(active, entry)?.title ?? (entry ? fileName(entry.url) : 'New Tab');

  return (
    <window
      ref={windowRef}
      title={`${title} — react-x11 browser`}
      width={1180}
      height={820}
      onKeyDown={onKeyDown}
    >
      <ThemeProvider
        colorScheme={colorScheme}
        style={{ backgroundColor: '$background', flexGrow: 1 }}
      >
        {chromeShown ? null : (
          // in full screen, the edge the pointer reaches for to get the
          // chrome back
          <box
            style={{ height: 3, flexShrink: 0 }}
            onMouseEnter={chrome.enter}
          />
        )}
        {/* Hidden rather than unmounted, so an address half typed and the
            field that holds it are there when the chrome comes back. */}
        <box
          style={{ flexShrink: 0, display: chromeShown ? 'flex' : 'none' }}
          onMouseEnter={chrome.enter}
          onMouseLeave={chrome.leave}
        >
          <Tabs
            value={active.id}
            onValueChange={(e) => dispatch({ type: 'select', id: e.value })}
            variant="outline"
            size="sm"
            ground="$surface"
            // the strip and the toolbar; the page below takes the rest
            style={{ flexGrow: 0, flexShrink: 0 }}
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
              <TabsContent
                key={tab.id}
                value={tab.id}
                style={{ paddingTop: 0, flexGrow: 0 }}
              >
                <Toolbar
                  tab={tab}
                  active={tab.id === active.id}
                  dispatch={dispatch}
                  register={register}
                  scripts={scriptsFor(tab.entries[tab.index]?.url ?? '')}
                  onScripts={(on) => {
                    const nav = reloadOf(tab);
                    if (!nav) return;
                    setSites((all) => new Map(all).set(siteOf(nav.url), on));
                    // a document's scripts are run or not as it is made: the
                    // switch takes on the page loaded again
                    dispatch({ type: 'navigate', id: tab.id, nav });
                  }}
                  userAgents={userAgents}
                  userAgentId={userAgentId}
                  onUserAgent={chooseUserAgent}
                  onAddressFocus={chrome.setTyping}
                />
              </TabsContent>
            ))}
          </Tabs>
        </box>
        {/* Every box from here to the page's scroller shrinks, or a page
            taller than the window makes them all as tall as it is, and
            nothing scrolls: a flex item's floor is its content until it
            says otherwise. */}
        <box
          style={{
            flexGrow: 1,
            flexShrink: 1,
            minHeight: 0,
            position: 'relative',
          }}
          onLayout={onAreaLayout}
        >
          {state.tabs.map((tab) => (
            <box
              key={tab.id}
              style={{
                position: 'absolute',
                top: 0,
                left: tab.id === active.id ? 0 : ASIDE,
                ...(tab.id === active.id || !settled
                  ? { bottom: 0, width: '100%' }
                  : settled),
                flexDirection: 'column',
              }}
            >
              <TabPage
                tab={tab}
                active={tab.id === active.id}
                scripts={scriptsFor(
                  tab.loading?.url ?? tab.entries[tab.index]?.url ?? '',
                )}
                userAgent={userAgentValue}
                inline={inline}
                transport={paneTransport}
                dispatch={dispatch}
                open={open}
                onCommand={onCommand}
              />
            </box>
          ))}
        </box>
      </ThemeProvider>
    </window>
  );
}

export default Browser;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const start = arg ? (urlFromInput(arg) ?? HOME) : HOME;
  // The profile is opened before any tab's process is started: what the
  // last session left that lives only as long as one — its session cookies,
  // the `sessionStorage` of tabs not coming back — goes first, unless its
  // tabs do come back, as a browser that continues where it left off keeps
  // them.
  const profile = await openProfile();
  const restore = readSession();
  profile?.endSession({
    keepTabs: restore?.tabs.map((tab) => tab.key) ?? [],
    keepSessionCookies: !!restore,
  });
  const root = await createRoot();
  root.render(
    <Browser
      start={start}
      inline={process.env.BROWSER_INLINE === '1'}
      restore={restore}
      onSession={saveSession}
      onTabClosed={(key) => profile?.forgetTab(key)}
      sites={readPreferences()?.scripts}
      onSites={(scripts) =>
        savePreferences({
          version: 1,
          scripts,
          userAgent: readPreferences()?.userAgent,
        })
      }
      userAgent={readPreferences()?.userAgent}
      onUserAgent={(userAgent) =>
        savePreferences({
          version: 1,
          scripts: readPreferences()?.scripts ?? [],
          userAgent,
        })
      }
    />,
  );
}
