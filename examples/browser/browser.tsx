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
// Each tab's page runs in a process of its own, through core's `<Frame>`:
// `page.tsx` is that pane, and everything a page needs is in it. A page that
// throws, or grows past its heap (`PANE_FLAGS`), costs its own tab — which
// says so, and offers to reload — and never the strip, the toolbar or
// another tab. One that wedges its event loop is not noticed yet: nothing
// in `<Frame>` asks a pane whether it is still answering. This file is the rest: the history, the strip, the toolbar
// and the keys. Where no pane can be shown, the same page runs in this
// process instead, and `BROWSER_INLINE=1` asks for that anywhere.
//
// Nothing a page contains runs unless you say so. `<Html>` hands scripts to
// `onScript` and executes none; this browser has an engine to give them
// (`script/`, docs/prd-html-scripts.md) and runs it only on a site whose JS
// switch, in the toolbar, is on — every site with `BROWSER_SCRIPTS=1`. The
// engine keeps a page's scripts in a `vm` context of their own and stops
// one that runs away, but it is no boundary against a page that sets out
// to attack the machine: the tab's process is, and it is a weak one. A page
// that only draws itself with JavaScript shows what it has without it.
//
// Keys, on the platform's shortcut modifier — Ctrl on X11, Cmd on macOS:
//
//   T  new tab         W  close tab       L / F6  the address bar
//   R  reload (Shift: past the cache)    [ ]  back, forward (and Alt+←/→)
//   1–9  a tab by place    + − 0  zoom    Ctrl+Tab / Ctrl+Shift+Tab  cycle
//
// A middle click, or a click with the modifier held, opens a link in a new
// tab behind this one; a middle click on a tab closes it.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
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
} from 'react-x11';
import type {
  DrawnNode,
  FrameComponentProps,
  FrameError,
  FrameProps,
  KeyboardEvent as X11KeyboardEvent,
  LayoutEvent,
  MouseEvent as X11MouseEvent,
  TextInputNode,
} from 'react-x11';
import { XK_ESCAPE } from 'react-x11/keysyms';

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../src/tabs/index.js';
import { displayUrl, urlFromInput } from './address.js';
import type { TabIcon } from './favicon.js';
import Page from './page.js';
import type { LinkTarget, PageProps } from './page.js';
import type { PostData } from './network.js';
import { shortcuts } from './keys.js';
import type { Command } from './keys.js';
import { HOME, fileName } from './pages.js';

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
  '--experimental-vm-modules',
  '--disable-warning=ExperimentalWarning',
];

// --- the model ---------------------------------------------------------------

/** One step of a tab's history. */
interface Entry {
  id: number;
  /** The document it shows, by the id of the navigation that loaded it —
   *  the page keeps it under that id. A link to a `#fragment` of the same
   *  document is a step of its own that shows the same one: nothing is
   *  loaded, the page is not built again, and it only scrolls. */
  doc: number;
  url: string;
  /** The form data its document answered, where a POST loaded it: a
   *  reload sends it again. */
  post: PostData | null;
  title: string | null;
  icon: TabIcon | null;
}

interface Navigation {
  seq: number;
  url: string;
  /** This step again rather than a new one: a reload. */
  replace: boolean;
  /** Past the cache: a reload with Shift. */
  fresh: boolean;
  /** A form's POST, or null for a GET. */
  post: PostData | null;
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
  | {
      type: 'commit';
      id: string;
      seq: number;
      url: string;
      title: string | null;
      posted: boolean;
    }
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

function navigation(
  url: string,
  replace = false,
  fresh = false,
  post: PostData | null = null,
): Navigation {
  return { seq: nextId(), url, replace, fresh, post };
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
        const nav = tab.loading;
        if (nav?.seq !== action.seq) return tab;
        const entry: Entry = {
          id: nav.seq,
          doc: nav.seq,
          url: action.url,
          post: action.posted ? nav.post : null,
          title: action.title,
          icon: null,
        };
        // a reload is this step again, in place: the steps after it stay
        if (nav.replace && tab.index >= 0) {
          return {
            ...tab,
            entries: tab.entries.map((e, i) => (i === tab.index ? entry : e)),
          };
        }
        const entries = [...tab.entries.slice(0, tab.index + 1), entry];
        return { ...tab, entries, index: entries.length - 1 };
      });
    case 'finish':
      return update(state, action.id, (tab) =>
        tab.loading?.seq === action.seq ? { ...tab, loading: null } : tab,
      );
    case 'stop':
      return update(state, action.id, (tab) => ({ ...tab, loading: null }));
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

/** Go to `url` in `tab`: a new step, and a `#fragment` of the document the
 *  tab shows is one that loads nothing — the page only scrolls. A POST
 *  always loads. */
function navigateIn(
  tab: Tab,
  url: string,
  dispatch: (action: Action) => void,
  post: PostData | null = null,
): void {
  const entry = tab.entries[tab.index];
  if (
    entry &&
    !post &&
    url.includes('#') &&
    withoutHash(url) === withoutHash(entry.url)
  ) {
    dispatch({
      type: 'fragment',
      id: tab.id,
      entry: { ...entry, id: nextId(), url },
    });
    return;
  }
  dispatch({
    type: 'navigate',
    id: tab.id,
    nav: navigation(url, false, false, post),
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

// --- one tab's toolbar ---------------------------------------------------------

interface ToolbarProps {
  tab: Tab;
  active: boolean;
  dispatch: (action: Action) => void;
  register: (id: string, input: TextInputNode | null) => void;
  /** Whether the page's site runs its scripts, and a flip of that. */
  scripts: boolean;
  onScripts: (on: boolean) => void;
}

function Toolbar({
  tab,
  active,
  dispatch,
  register,
  scripts,
  onScripts,
}: ToolbarProps): ReactElement {
  const entry = tab.entries[tab.index] ?? null;
  const input = useRef<TextInputNode | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  // a document that arrived replaces what was being typed
  useEffect(() => setDraft(null), [entry?.id]);

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
                nav: navigation(entry.url, true, false, entry.post),
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
  inline,
  transport,
  dispatch,
  open,
  onCommand,
}: TabPageProps): ReactElement {
  const id = tab.id;
  const entry = tab.entries[tab.index] ?? null;
  const latest = useRef(tab);
  latest.current = tab;

  const onCommit = useCallback(
    (seq: number, url: string, title: string | null, posted: boolean) =>
      dispatch({ type: 'commit', id, seq, url, title, posted }),
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
  const onLink = useCallback(
    (url: string, target: LinkTarget, post: PostData | null) => {
      if (target === 'here') navigateIn(latest.current, url, dispatch, post);
      else open(url, target === 'background', post);
    },
    [dispatch, open],
  );
  const onLost = useCallback(
    (entryId: number) => {
      // loaded again as the same step, where it still is the one showing
      const now = latest.current;
      const shown = now.entries[now.index];
      if (shown?.id !== entryId || now.loading) return;
      dispatch({
        type: 'navigate',
        id,
        nav: navigation(shown.url, true, false, shown.post),
      });
    },
    [id, dispatch],
  );

  const props: PageProps = {
    entryId: entry?.id ?? 0,
    doc: entry?.doc ?? 0,
    url: entry?.url ?? '',
    loadSeq: tab.loading?.seq ?? 0,
    loadUrl: tab.loading?.url ?? '',
    loadFresh: tab.loading?.fresh ?? false,
    loadPost: tab.loading?.post ?? null,
    zoom: tab.zoom,
    scripts,
    docs: [...new Set(tab.entries.map((e) => e.doc))].join(','),
    onCommit,
    onFinish,
    onMeta,
    onLink,
    onLost,
    onCommand,
  };

  if (inline) return <Page {...props} />;
  return (
    <Frame
      src={PAGE}
      props={props as unknown as FrameProps}
      transport={transport}
      execArgv={PANE_FLAGS}
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
}

export function Browser({
  start = HOME,
  colorScheme = 'system',
  inline = false,
  paneTransport,
  scripts = process.env.BROWSER_SCRIPTS === '1',
}: BrowserProps): ReactElement {
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
  const [settled, onAreaLayout] = useSettledSize();

  // Which sites run their scripts: each site's switch, where someone
  // flipped it, and `scripts` for the rest. A site is an origin, as a
  // browser's site settings are kept.
  const [sites, setSites] = useState<ReadonlyMap<string, boolean>>(new Map());
  const scriptsFor = (url: string): boolean =>
    sites.get(siteOf(url)) ?? scripts;

  const open = useCallback(
    (url: string, background: boolean, post: PostData | null = null) => {
      dispatch({
        type: 'open',
        id: `tab-${nextId()}`,
        nav: navigation(url, false, false, post),
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
    if (entry) {
      dispatch({
        type: 'navigate',
        id: active.id,
        nav: navigation(entry.url, true, fresh, entry.post),
      });
    }
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
        return focusField(inputs.current.get(active.id));
      case 'reload':
        return reload(false);
      case 'reloadFresh':
        return reload(true);
      case 'back':
        return dispatch({ type: 'go', id: active.id, delta: -1 });
      case 'forward':
        return dispatch({ type: 'go', id: active.id, delta: 1 });
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

  const title = entry?.title ?? (entry ? fileName(entry.url) : 'New Tab');

  return (
    <window
      title={`${title} — react-x11 browser`}
      width={1180}
      height={820}
      onKeyDown={onKeyDown}
    >
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
                  const shown = tab.entries[tab.index];
                  if (!shown) return;
                  setSites((all) => new Map(all).set(siteOf(shown.url), on));
                  // a document's scripts are run or not as it is made: the
                  // switch takes on the page loaded again
                  dispatch({
                    type: 'navigate',
                    id: tab.id,
                    nav: navigation(shown.url, true, false, shown.post),
                  });
                }}
              />
            </TabsContent>
          ))}
        </Tabs>
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
  const arg = process.argv[2];
  const start = arg ? (urlFromInput(arg) ?? HOME) : HOME;
  const root = await createRoot();
  root.render(
    <Browser start={start} inline={process.env.BROWSER_INLINE === '1'} />,
  );
}
