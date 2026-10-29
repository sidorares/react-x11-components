// The browser's profile: where its cookies, `localStorage`,
// `sessionStorage`, IndexedDB and HTTP cache are kept across a restart, and
// the tabs it had open (docs/prd-browser-profile.md).
//
// The cookies and the storage are one SQLite database, `HtmlProfile`'s,
// which every tab's process opens for itself: a cookie one tab's login set
// is on the next request another tab makes, without passing through this
// process. The HTTP cache is a second database beside it, which every tab's
// process opens the same way: a stylesheet one tab fetched is not fetched
// again by the next tab, or the next run, while it is fresh. The tabs, their histories and the sites whose scripts run are
// this process's alone, and are JSON files it writes as they change.
//
//   BROWSER_PROFILE=<dir>   the profile in that directory
//   BROWSER_PROFILE=temp    a fresh one, deleted when the browser exits
//                           (also `--temp-profile`)
//   BROWSER_PROFILE=none    none: memory, a tab's process's alone
//   BROWSER_RESTORE=0       start without the last session's tabs, its
//                           session cookies and its `sessionStorage`
//
// Unset, the profile is the platform's place for an application's data:
// `~/Library/Application Support/react-x11-browser` on a Mac,
// `%LOCALAPPDATA%\react-x11-browser` on Windows, and
// `$XDG_DATA_HOME/react-x11-browser` (`~/.local/share/…`) elsewhere.
//
// The browser works the directory out as it starts and hands it to each
// tab's process as `BROWSER_PROFILE_DIR`, with the tab's own key as
// `BROWSER_TAB_KEY`, which its `sessionStorage` is kept by.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFramed } from 'react-x11';

import { HtmlProfile } from '../../src/html/index.js';

/** The profile's directory, or '' for none. A tab's process is told it;
 *  the browser's works it out, once, as this module is first imported. */
export const PROFILE_DIR: string = (() => {
  if (isFramed() || process.env.BROWSER_PROFILE_DIR !== undefined) {
    return process.env.BROWSER_PROFILE_DIR ?? '';
  }
  const asked = process.argv.includes('--temp-profile')
    ? 'temp'
    : (process.env.BROWSER_PROFILE ?? '');
  let dir: string;
  if (asked === 'none') dir = '';
  else if (asked === 'temp') {
    dir = mkdtempSync(join(tmpdir(), 'react-x11-browser-'));
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  } else dir = asked || defaultDir();
  // what each tab's process starts with (`PANE_ENV` keeps `BROWSER_*`)
  process.env.BROWSER_PROFILE_DIR = dir;
  return dir;
})();

/** Whether this run is one whose profile goes when it ends. */
export const THROWAWAY =
  process.argv.includes('--temp-profile') ||
  process.env.BROWSER_PROFILE === 'temp';

function defaultDir(): string {
  const name = 'react-x11-browser';
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', name);
  }
  if (process.platform === 'win32') {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
      name,
    );
  }
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
    name,
  );
}

let opened: Promise<HtmlProfile | null> | null = null;
let warned = false;

/**
 * The profile's database, for this process: opened once, the first time it
 * is asked for, or null where there is no profile or this runtime has no
 * SQLite — Node before 22.13 — which says so once and keeps memory.
 */
export function openProfile(): Promise<HtmlProfile | null> {
  opened ??= PROFILE_DIR
    ? HtmlProfile.open(PROFILE_DIR, {
        tab: process.env.BROWSER_TAB_KEY || undefined,
      }).then(
        (profile) => {
          if (!profile && !warned && !isFramed()) {
            warned = true;
            console.error(
              '[browser] this runtime has no SQLite (Node 22.13 or later, or Bun, has): cookies and storage are kept in memory for this run.',
            );
          }
          return profile;
        },
        (error: unknown) => {
          console.error('[browser] the profile could not be opened:', error);
          return null;
        },
      )
    : Promise.resolve(null);
  return opened;
}

/** A tab as the session keeps it: its key, which its `sessionStorage` is
 *  kept by, its history as its page told it (`History`, as JSON), and the
 *  address it was loading where it had no history yet. */
export interface SavedTab {
  key: string;
  history: string;
  url: string;
  zoom: number;
}

/** The tabs open as the browser last saw them, and which was shown. */
export interface SavedSession {
  version: 1;
  tabs: SavedTab[];
  active: number;
}

/** What the browser remembers that is not a session's: the sites whose
 *  scripts someone switched on or off, and the User-Agent preset chosen
 *  for every tab. */
export interface Preferences {
  version: 1;
  scripts: [site: string, on: boolean][];
  /** The chosen User-Agent preset, by id (see `useragents.ts`); absent
   *  means the browser's own default. */
  userAgent?: string;
  /** Whether a site nobody switched either way runs its scripts; absent
   *  means it does not. */
  scriptsByDefault?: boolean;
  /** The side the developer tools dock on; absent means the bottom. */
  devtoolsDock?: 'bottom' | 'right' | 'left';
}

const SESSION = 'session.json';
const PREFERENCES = 'preferences.json';

function readJson<T extends { version: number }>(name: string): T | null {
  if (!PROFILE_DIR) return null;
  const path = join(PROFILE_DIR, name);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as T;
    return value?.version === 1 ? value : null;
  } catch {
    return null;
  }
}

/** Written whole and renamed into place, so a crash mid-write leaves the
 *  last one. */
function writeJson(name: string, value: unknown): void {
  if (!PROFILE_DIR) return;
  try {
    mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
    const path = join(PROFILE_DIR, name);
    writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  } catch (error) {
    console.error(`[browser] ${name} could not be written:`, error);
  }
}

/** The last session's tabs, where the browser restores them. */
export function readSession(): SavedSession | null {
  if (THROWAWAY || process.env.BROWSER_RESTORE === '0') return null;
  const session = readJson<SavedSession>(SESSION);
  return session?.tabs.length ? session : null;
}

let pendingSession: SavedSession | null = null;
let sessionTimer: ReturnType<typeof setTimeout> | null = null;

/** The session as it stands, written a moment after it stops changing, and
 *  as the browser exits. */
export function saveSession(session: SavedSession): void {
  if (THROWAWAY) return;
  pendingSession = session;
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(flushSession, 500);
}

function flushSession(): void {
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = null;
  if (!pendingSession) return;
  writeJson(SESSION, pendingSession);
  pendingSession = null;
}
process.on('exit', flushSession);

export function readPreferences(): Preferences | null {
  return readJson<Preferences>(PREFERENCES);
}

export function savePreferences(preferences: Preferences): void {
  writeJson(PREFERENCES, preferences);
}

/** A new tab's key: what its `sessionStorage` is kept by, across a
 *  restart. */
export function tabKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
