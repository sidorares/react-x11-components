// A browser profile on disk: the cookies, `localStorage`, `sessionStorage`
// and IndexedDB a host keeps past a restart, in one SQLite database that
// every process of the browser opens (docs/prd-browser-profile.md).
//
// The example browser runs each tab's page in a process of its own, and a
// cookie one tab's login set has to be on the next request another tab
// makes. Nothing carries a request's answer back to the browser's process
// in time for that, so the processes share the file instead, which is what
// SQLite in write-ahead-log mode is for: a writer at a time, any number of
// readers, each commit whole or not at all. A process reads a table again
// only where `PRAGMA data_version` says another connection committed since
// it last looked, which costs no read of the file.
//
// The format is this package's own, versioned by `PRAGMA user_version`, and
// not Chrome's — the PRD has why. The cookie table borrows the column names
// of Chrome's where a column means what Chrome's does, so a reader who
// knows one is not misled by the other, and keeps the values in the clear,
// as Firefox's `cookies.sqlite` does: the file is the user's, in a
// directory only they can read.
//
// SQLite is the runtime's: `node:sqlite` (Node 22.13 and later, and Bun),
// or `bun:sqlite`, reached by a dynamic `import()` whose specifier the
// compiler cannot see, their types written out here. A runtime with
// neither — Node 20 — has no profile: `HtmlProfile.open` answers null and a
// host keeps memory. Nothing happens as this module is imported.
//
// The HTTP cache is a second file beside it, `cache.sqlite`
// (`profile.httpCache`): its rows are bodies of up to megabytes, which would
// grow the profile's write-ahead log, and every write to it would move the
// `data_version` that makes every other process read its cookies again.
import type { HtmlCookie, HtmlCookieStore } from './cookies.js';
import type {
  HtmlCachedHead,
  HtmlCachedResponse,
  HtmlHttpCacheStore,
} from './http-cache.js';
import { MemoryStorageArea } from './storage.js';
import type {
  HtmlIdbCommit,
  HtmlIdbSnapshot,
  HtmlIdbStoreSchema,
  HtmlIndexedDB,
  HtmlStorage,
  HtmlStorageArea,
  HtmlStorageChange,
} from './storage.js';
import type { HtmlPermissionState } from './permissions.js';
import { cacheUrlKey } from './cache-storage.js';
import type {
  HtmlCacheAddition,
  HtmlCacheEntry,
  HtmlCacheStore,
} from './cache-storage.js';
import type {
  HtmlServiceWorkerRecord,
  HtmlServiceWorkerScript,
  HtmlServiceWorkerStore,
  HtmlServiceWorkerVersion,
} from './service-workers.js';
import { nodeModule } from './scripts/platform.js';
import type { ClearTimeout, SetTimeout } from './scripts/platform.js';

declare const setInterval: SetTimeout;
declare const clearInterval: ClearTimeout;
declare const crypto: { getRandomValues(array: Uint8Array): Uint8Array };

/** The schema this module writes and reads. A file of a later one is not
 *  opened; an earlier one is brought up to this. */
export const PROFILE_VERSION = 3;

/** The file in a profile's directory. */
export const PROFILE_FILE = 'profile.sqlite';

/** The HTTP cache's file beside it, and the schema it is in. */
export const CACHE_FILE = 'cache.sqlite';
const CACHE_VERSION = 1;

/** What a page's workers and its `caches` keep, a third file beside them,
 *  and the schema it is in. */
export const WORKERS_FILE = 'workers.sqlite';
const WORKERS_VERSION = 1;

/** A prepared statement: the slice `node:sqlite` and `bun:sqlite` share,
 *  with positional parameters alone. */
interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined | null;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
type DatabaseClass = new (path: string) => Database;

interface FsModule {
  mkdirSync(path: string, options: { recursive: true; mode: number }): void;
  chmodSync(path: string, mode: number): void;
}

/** The runtime's SQLite, or null. */
async function sqlite(): Promise<DatabaseClass | null> {
  try {
    const m = await nodeModule<{ DatabaseSync?: DatabaseClass }>('sqlite');
    if (m.DatabaseSync) return m.DatabaseSync;
  } catch {
    // not this runtime's, or not without a flag
  }
  try {
    const specifier = 'bun:sqlite';
    const m = (await import(/* @vite-ignore */ specifier)) as {
      Database: DatabaseClass;
    };
    return m.Database;
  } catch {
    return null;
  }
}

/** What `HtmlProfile.open` is told. */
export interface HtmlProfileOptions {
  /**
   * The tab whose `sessionStorage` this process keeps, by a key the host
   * gives it and keeps across a restart: a tab restored with its key finds
   * its session's items. Absent, `sessionStorage` is memory, gone with the
   * process.
   */
  tab?: string;
  /**
   * How many bytes of responses the HTTP cache keeps (`httpCache`) before
   * it forgets those used longest ago. Default 512 MB; 0 keeps no cache.
   */
  cacheBytes?: number;
  /**
   * How many bytes of bodies an origin may keep in `caches`. A page past it
   * is told `QuotaExceededError`, since what it keeps is its own to give up.
   * Default 2 GB.
   */
  cacheStorageBytes?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS permissions (
  origin TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (origin, name)
);
CREATE TABLE IF NOT EXISTS cookies (
  host_key TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_utc INTEGER,
  is_secure INTEGER NOT NULL,
  is_httponly INTEGER NOT NULL,
  samesite TEXT NOT NULL,
  creation_utc REAL NOT NULL,
  last_access_utc REAL NOT NULL,
  PRIMARY KEY (host_key, path, name)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS local_storage (
  origin TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (origin, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS session_storage (
  tab TEXT NOT NULL,
  origin TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (tab, origin, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS storage_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  key TEXT,
  old_value TEXT,
  new_value TEXT,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS key_secret (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idb_databases (
  origin TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  schema TEXT NOT NULL,
  stamp INTEGER NOT NULL,
  PRIMARY KEY (origin, name)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS idb_records (
  origin TEXT NOT NULL,
  db TEXT NOT NULL,
  store TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (origin, db, store, key)
) WITHOUT ROWID;
`;

/** How long a change stays in `storage_events` for another process to
 *  hear: its poll comes far sooner. */
const EVENT_TTL_MS = 10_000;
/** How often a process that has listeners asks whether another wrote. */
const WATCH_MS = 250;

/**
 * A profile: one SQLite database in a directory, shared by every process
 * that opens it. `cookies` is a jar's store (`CookieJar`'s `store`),
 * `storage` a document's (`HtmlScripts.storage`), its IndexedDB among it.
 */
export class HtmlProfile {
  readonly cookies: HtmlCookieStore;
  readonly storage: HtmlStorage;
  /** What the user said to each origin's questions. */
  readonly permissions: HtmlProfilePermissions;
  /**
   * The HTTP cache's store (`HtmlNetworkOptions.httpCache`), which every
   * process that opens the profile shares; null where it was asked for no
   * bytes, or its file could not be opened.
   */
  readonly httpCache: HtmlProfileHttpCache | null;
  /**
   * What keeps a page's service workers (`HtmlServiceWorkers`' `store`) past
   * a restart, which every process that opens the profile shares; null where
   * its file could not be opened, and they live in memory.
   */
  readonly serviceWorkers: HtmlServiceWorkerStore | null;
  private _cache: ProfileHttpCache | null;
  private _workers: ProfileWorkers | null;
  private _db: Database;
  private _dataVersion: Statement;
  private _lastData = -1;
  /** Counts the times another connection was found to have committed. */
  private _generation = 0;
  private _closed = false;

  /**
   * The profile in `dir`, made where there is none — the directory, then
   * the file, both the user's alone — or null where the runtime has no
   * SQLite, or the file is of a later schema than this reads.
   */
  static async open(
    dir: string,
    options: HtmlProfileOptions = {},
  ): Promise<HtmlProfile | null> {
    const Database = await sqlite();
    if (!Database) return null;
    const fs = await nodeModule<FsModule>('fs');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = `${dir.replace(/[\\/]+$/, '')}/${PROFILE_FILE}`;
    const db = new Database(path);
    try {
      fs.chmodSync(path, 0o600);
    } catch {
      // a file system with no modes
    }
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    const version = Number(
      db.prepare('PRAGMA user_version').get()?.user_version ?? 0,
    );
    if (version > PROFILE_VERSION) {
      db.close();
      return null;
    }
    if (version < PROFILE_VERSION) {
      db.exec('BEGIN IMMEDIATE');
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${PROFILE_VERSION}`);
      db.exec('COMMIT');
    }
    const bytes = options.cacheBytes ?? 512 * 1024 * 1024;
    let cache: ProfileHttpCache | null = null;
    if (bytes > 0) {
      try {
        cache = ProfileHttpCache.open(Database, fs, dir, bytes);
      } catch {
        // a cache that cannot be opened is a profile with none: what it
        // would have kept is asked for again
      }
    }
    let workers: ProfileWorkers | null = null;
    try {
      workers = ProfileWorkers.open(
        Database,
        fs,
        dir,
        options.cacheStorageBytes ?? 2 * 1024 * 1024 * 1024,
      );
    } catch {
      // a store that cannot be opened is memory: a page's `caches` still
      // work, for as long as the process
    }
    return new HtmlProfile(db, options, cache, workers);
  }

  private constructor(
    db: Database,
    options: HtmlProfileOptions,
    cache: ProfileHttpCache | null,
    workers: ProfileWorkers | null,
  ) {
    this._db = db;
    this._dataVersion = db.prepare('PRAGMA data_version');
    this.cookies = new ProfileCookies(this, db);
    this.storage = new ProfileStorage(this, db, options.tab ?? null);
    this.permissions = new ProfilePermissions(db);
    this._cache = cache;
    this.httpCache = cache;
    this._workers = workers;
    this.serviceWorkers = workers;
    if (workers) (this.storage as ProfileStorage).caches = workers;
  }

  /** How many times another connection was found to have committed: a
   *  reader whose last look was at an earlier one reads again. */
  generation(): number {
    if (this._closed) return this._generation;
    const now = Number(this._dataVersion.get()?.data_version ?? 0);
    if (now !== this._lastData) {
      this._lastData = now;
      this._generation += 1;
    }
    return this._generation;
  }

  /**
   * The session ends: what lives only as long as one goes — the session
   * cookies, and the `sessionStorage` of every tab but those in `keepTabs`
   * — and every cookie that expired. A browser calls it as it starts,
   * before any of its documents runs. One that restores its last session
   * keeps its session cookies (`keepSessionCookies`), as a browser that
   * continues where it left off does.
   */
  endSession(
    options: {
      keepTabs?: readonly string[];
      keepSessionCookies?: boolean;
    } = {},
  ): void {
    const keep = options.keepTabs ?? [];
    this.transaction(() => {
      if (!options.keepSessionCookies) {
        this._db.prepare('DELETE FROM cookies WHERE expires_utc IS NULL').run();
      }
      this._db
        .prepare('DELETE FROM cookies WHERE expires_utc <= ?')
        .run(Date.now());
      if (keep.length) {
        this._db
          .prepare(
            `DELETE FROM session_storage WHERE tab NOT IN (${keep.map(() => '?').join(',')})`,
          )
          .run(...keep);
      } else this._db.prepare('DELETE FROM session_storage').run();
      this._db.prepare('DELETE FROM storage_events').run();
    });
  }

  /** Drop what a closed tab kept of its session. */
  forgetTab(tab: string): void {
    this._db.prepare('DELETE FROM session_storage WHERE tab = ?').run(tab);
  }

  /** Let the file go. The profile answers nothing after. */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    (this.storage as ProfileStorage).stop();
    this._db.close();
    this._cache?.close();
    this._workers?.close();
  }

  /** A function run in one transaction, which a throw rolls back. */
  transaction<T>(run: () => T): T {
    this._db.exec('BEGIN IMMEDIATE');
    try {
      const out = run();
      this._db.exec('COMMIT');
      return out;
    } catch (error) {
      this._db.exec('ROLLBACK');
      throw error;
    }
  }
}

// --- the HTTP cache -------------------------------------------------------------

/** The profile's HTTP cache: a store that answers at once, and can be
 *  cleared. */
export interface HtmlProfileHttpCache extends HtmlHttpCacheStore {
  get(key: string): HtmlCachedResponse | null;
  put(key: string, response: HtmlCachedResponse): void;
  refresh(key: string, head: HtmlCachedHead): void;
  delete(key: string): void;
  clear(): void;
}

const CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS responses (
  key TEXT NOT NULL UNIQUE,
  head TEXT NOT NULL,
  body BLOB NOT NULL,
  size INTEGER NOT NULL,
  last_used INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS responses_used ON responses (last_used, size);
`;

/** How stale a response's `last_used` may be before a use writes it again:
 *  the order it is forgotten in needs no finer clock, and a page of a
 *  hundred images read from the cache is not a hundred writes. */
const TOUCH_MS = 60 * 60 * 1000;

/**
 * The HTTP cache on disk (`HtmlProfile.httpCache`): a response a row, its
 * head as JSON and its body as a blob, read straight from the file at each
 * `get` — so a response one tab's process kept is there for the next
 * another makes — and forgotten, used longest ago first, once the rows come
 * to more than `limit` bytes. A rowid table, as SQLite has rows this large
 * kept best.
 */
class ProfileHttpCache implements HtmlProfileHttpCache {
  private _get: Statement;
  private _put: Statement;
  private _refresh: Statement;
  private _touch: Statement;
  private _delete: Statement;
  private _total: Statement;
  private _oldest: Statement;

  static open(
    Database: DatabaseClass,
    fs: FsModule,
    dir: string,
    limit: number,
  ): ProfileHttpCache {
    const path = `${dir.replace(/[\\/]+$/, '')}/${CACHE_FILE}`;
    const db = new Database(path);
    try {
      try {
        fs.chmodSync(path, 0o600);
      } catch {
        // a file system with no modes
      }
      // shorter than the profile's: a cache that is busy is a cache that
      // kept nothing this time, where a cookie that waits is one that is
      // not lost
      db.exec('PRAGMA busy_timeout = 1000');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      const version = (): number =>
        Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      if (version() !== CACHE_VERSION) {
        // a cache is what can be asked for again: one of another schema
        // is started over rather than read — asked again inside the
        // transaction, since another process may have just made it
        db.exec('BEGIN IMMEDIATE');
        if (version() !== CACHE_VERSION) {
          db.exec('DROP TABLE IF EXISTS responses');
          db.exec(CACHE_SCHEMA);
          db.exec(`PRAGMA user_version = ${CACHE_VERSION}`);
        }
        db.exec('COMMIT');
      }
      return new ProfileHttpCache(db, limit);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private constructor(
    private readonly _db: Database,
    private readonly _limit: number,
  ) {
    this._get = _db.prepare(
      'SELECT head, body, last_used FROM responses WHERE key = ?',
    );
    this._put = _db.prepare(
      `INSERT OR REPLACE INTO responses (key, head, body, size, last_used)
         VALUES (?, ?, ?, ?, ?)`,
    );
    this._refresh = _db.prepare(
      'UPDATE responses SET head = ?, last_used = ? WHERE key = ?',
    );
    this._touch = _db.prepare(
      'UPDATE responses SET last_used = ? WHERE key = ?',
    );
    this._delete = _db.prepare('DELETE FROM responses WHERE key = ?');
    this._total = _db.prepare('SELECT total(size) AS total FROM responses');
    this._oldest = _db.prepare(
      'SELECT key, size FROM responses WHERE key != ? ORDER BY last_used LIMIT 64',
    );
  }

  get(key: string): HtmlCachedResponse | null {
    const row = this._get.get(key);
    if (!row) return null;
    let head: HtmlCachedHead;
    try {
      head = JSON.parse(String(row.head)) as HtmlCachedHead;
    } catch {
      this._delete.run(key);
      return null;
    }
    const now = Date.now();
    if (Number(row.last_used) < now - TOUCH_MS) this._touch.run(now, key);
    const body = row.body as Uint8Array;
    return {
      ...head,
      bytes: body instanceof Uint8Array ? body : new Uint8Array(body),
    };
  }

  put(key: string, response: HtmlCachedResponse): void {
    const { bytes, ...head } = response;
    const text = JSON.stringify(head);
    const size = bytes.length + text.length;
    if (size > this._limit) return;
    this._transaction(() => {
      this._put.run(key, text, bytes, size, Date.now());
      let over = Number(this._total.get()?.total ?? 0) - this._limit;
      while (over > 0) {
        const rows = this._oldest.all(key);
        if (!rows.length) break;
        for (const row of rows) {
          if (over <= 0) break;
          this._delete.run(String(row.key));
          over -= Number(row.size);
        }
      }
    });
  }

  refresh(key: string, head: HtmlCachedHead): void {
    this._refresh.run(JSON.stringify(head), Date.now(), key);
  }

  delete(key: string): void {
    this._delete.run(key);
  }

  clear(): void {
    this._db.exec('DELETE FROM responses');
  }

  close(): void {
    this._db.close();
  }

  private _transaction(run: () => void): void {
    this._db.exec('BEGIN IMMEDIATE');
    try {
      run();
      this._db.exec('COMMIT');
    } catch (error) {
      this._db.exec('ROLLBACK');
      throw error;
    }
  }
}

// --- service workers and `caches` -----------------------------------------------

const WORKERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS registrations (
  scope TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  active TEXT,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS registrations_origin ON registrations (origin);
CREATE TABLE IF NOT EXISTS scripts (
  scope TEXT NOT NULL,
  version TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL,
  body BLOB NOT NULL,
  PRIMARY KEY (scope, version, url)
);
CREATE TABLE IF NOT EXISTS caches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (origin, name)
);
CREATE TABLE IF NOT EXISTS cache_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache INTEGER NOT NULL,
  key TEXT NOT NULL,
  request TEXT NOT NULL,
  response TEXT NOT NULL,
  body BLOB NOT NULL,
  size INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cache_entries_key ON cache_entries (cache, key);
`;

/** A record's worker as a row keeps it: its scripts are rows of their own. */
type KeptVersion = Omit<HtmlServiceWorkerVersion, 'scripts'>;
type KeptRecord = Omit<HtmlServiceWorkerRecord, 'active' | 'waiting'> & {
  active: KeptVersion | null;
  waiting: KeptVersion | null;
};

/**
 * What a page's service workers and its `caches` keep on disk, a file of their
 * own for the reasons the HTTP cache has one: a body is up to megabytes, which
 * would grow the log every cookie write goes through, and every write here
 * would move the `data_version` that makes every other process read its
 * cookies again. It is read straight from the file at each call, so what one
 * tab's process kept is there for the next request another makes. Unlike a
 * cache of the network it is what a page was told is kept, so nothing here is
 * forgotten behind its back, and a file of a later schema is left alone.
 */
class ProfileWorkers implements HtmlServiceWorkerStore, HtmlCacheStore {
  private _scopes: Statement;
  private _record: Statement;
  private _scripts: Statement;
  private _saveRecord: Statement;
  private _saveScript: Statement;
  private _dropRecord: Statement;
  private _dropScripts: Statement;
  private _staleScripts: Statement;
  private _cacheId: Statement;
  private _cacheNames: Statement;
  private _makeCache: Statement;
  private _dropCache: Statement;
  private _dropEntries: Statement;
  private _entriesOf: Statement;
  private _entriesAt: Statement;
  private _body: Statement;
  private _dropEntry: Statement;
  private _addEntry: Statement;
  private _used: Statement;

  static open(
    Database: DatabaseClass,
    fs: FsModule,
    dir: string,
    quota: number,
  ): ProfileWorkers | null {
    const path = `${dir.replace(/[\\/]+$/, '')}/${WORKERS_FILE}`;
    const db = new Database(path);
    try {
      try {
        fs.chmodSync(path, 0o600);
      } catch {
        // a file system with no modes
      }
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      const version = Number(
        db.prepare('PRAGMA user_version').get()?.user_version ?? 0,
      );
      if (version > WORKERS_VERSION) {
        db.close();
        return null;
      }
      if (version < WORKERS_VERSION) {
        db.exec('BEGIN IMMEDIATE');
        db.exec(WORKERS_SCHEMA);
        db.exec(`PRAGMA user_version = ${WORKERS_VERSION}`);
        db.exec('COMMIT');
      }
      return new ProfileWorkers(db, quota);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private constructor(
    private readonly _db: Database,
    private readonly _quota: number,
  ) {
    this._scopes = _db.prepare(
      'SELECT scope, active FROM registrations WHERE origin = ?',
    );
    this._record = _db.prepare(
      'SELECT record FROM registrations WHERE scope = ?',
    );
    this._scripts = _db.prepare(
      'SELECT url, type, body FROM scripts WHERE scope = ? AND version = ?',
    );
    this._saveRecord = _db.prepare(
      'INSERT OR REPLACE INTO registrations (scope, origin, active, record) VALUES (?, ?, ?, ?)',
    );
    this._saveScript = _db.prepare(
      'INSERT OR IGNORE INTO scripts (scope, version, url, type, body) VALUES (?, ?, ?, ?, ?)',
    );
    this._dropRecord = _db.prepare('DELETE FROM registrations WHERE scope = ?');
    this._dropScripts = _db.prepare('DELETE FROM scripts WHERE scope = ?');
    this._staleScripts = _db.prepare(
      'DELETE FROM scripts WHERE scope = ? AND version != ? AND version != ?',
    );
    this._cacheId = _db.prepare(
      'SELECT id FROM caches WHERE origin = ? AND name = ?',
    );
    this._cacheNames = _db.prepare(
      'SELECT name FROM caches WHERE origin = ? ORDER BY id',
    );
    this._makeCache = _db.prepare(
      'INSERT OR IGNORE INTO caches (origin, name) VALUES (?, ?)',
    );
    this._dropCache = _db.prepare('DELETE FROM caches WHERE id = ?');
    this._dropEntries = _db.prepare(
      'DELETE FROM cache_entries WHERE cache = ?',
    );
    this._entriesOf = _db.prepare(
      'SELECT id, request, response FROM cache_entries WHERE cache = ? ORDER BY id',
    );
    this._entriesAt = _db.prepare(
      'SELECT id, request, response FROM cache_entries WHERE cache = ? AND key = ? ORDER BY id',
    );
    this._body = _db.prepare(
      'SELECT body FROM cache_entries WHERE id = ? AND cache = ?',
    );
    this._dropEntry = _db.prepare(
      'DELETE FROM cache_entries WHERE id = ? AND cache = ?',
    );
    this._addEntry = _db.prepare(
      'INSERT INTO cache_entries (cache, key, request, response, body, size) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this._used = _db.prepare(
      `SELECT total(size) AS used FROM cache_entries
         WHERE cache IN (SELECT id FROM caches WHERE origin = ?)`,
    );
  }

  // registrations

  scopes(origin: string): { scope: string; active: string | null }[] {
    return this._scopes.all(origin).map((row) => ({
      scope: String(row.scope),
      active: row.active === null ? null : String(row.active),
    }));
  }

  load(scope: string): HtmlServiceWorkerRecord | null {
    const row = this._record.get(scope);
    if (!row) return null;
    let kept: KeptRecord;
    try {
      kept = JSON.parse(String(row.record)) as KeptRecord;
    } catch {
      return null;
    }
    const version = (v: KeptVersion | null): HtmlServiceWorkerVersion | null =>
      v && {
        ...v,
        scripts: this._scripts
          .all(scope, v.id)
          .map((script): HtmlServiceWorkerScript => ({
            url: String(script.url),
            type: String(script.type),
            body: bytesOf(script.body),
          })),
      };
    return {
      ...kept,
      active: version(kept.active),
      waiting: version(kept.waiting),
    };
  }

  save(record: HtmlServiceWorkerRecord): void {
    const bare = (v: HtmlServiceWorkerVersion | null): KeptVersion | null => {
      if (!v) return null;
      const { scripts: _left, ...rest } = v;
      return rest;
    };
    const kept: KeptRecord = {
      ...record,
      active: bare(record.active),
      waiting: bare(record.waiting),
    };
    this._transaction(() => {
      this._saveRecord.run(
        record.scope,
        record.origin,
        record.active?.id ?? null,
        JSON.stringify(kept),
      );
      for (const version of [record.active, record.waiting]) {
        for (const script of version?.scripts ?? []) {
          this._saveScript.run(
            record.scope,
            version!.id,
            script.url,
            script.type,
            script.body,
          );
        }
      }
      this._staleScripts.run(
        record.scope,
        record.active?.id ?? '',
        record.waiting?.id ?? '',
      );
    });
  }

  delete(scope: string): void {
    this._transaction(() => {
      this._dropRecord.run(scope);
      this._dropScripts.run(scope);
    });
  }

  // `caches`

  get caches(): HtmlCacheStore {
    return this;
  }

  private _id(origin: string, name: string): number | null {
    const row = this._cacheId.get(origin, name);
    return row ? Number(row.id) : null;
  }

  names(origin: string): string[] {
    return this._cacheNames.all(origin).map((row) => String(row.name));
  }

  has(origin: string, name: string): boolean {
    return this._id(origin, name) !== null;
  }

  create(origin: string, name: string): void {
    this._makeCache.run(origin, name);
  }

  remove(origin: string, name: string): boolean {
    const id = this._id(origin, name);
    if (id === null) return false;
    this._transaction(() => {
      this._dropEntries.run(id);
      this._dropCache.run(id);
    });
    return true;
  }

  entries(origin: string, name: string, key?: string): HtmlCacheEntry[] {
    const id = this._id(origin, name);
    if (id === null) return [];
    const rows =
      key === undefined
        ? this._entriesOf.all(id)
        : this._entriesAt.all(id, key);
    return rows.map((row) => ({
      id: Number(row.id),
      request: JSON.parse(String(row.request)),
      response: JSON.parse(String(row.response)),
    }));
  }

  body(origin: string, name: string, entry: number): Uint8Array | null {
    const id = this._id(origin, name);
    if (id === null) return null;
    const row = this._body.get(entry, id);
    return row ? bytesOf(row.body) : null;
  }

  commit(
    origin: string,
    name: string,
    remove: readonly number[],
    add: readonly HtmlCacheAddition[],
  ): boolean {
    const id = this._id(origin, name);
    if (id === null) return false;
    let fits = true;
    this._transaction(() => {
      for (const entry of remove) this._dropEntry.run(entry, id);
      let size = 0;
      for (const item of add) {
        size += item.bytes.length;
        this._addEntry.run(
          id,
          cacheUrlKey(item.request.url),
          JSON.stringify(item.request),
          JSON.stringify(item.response),
          item.bytes,
          item.bytes.length,
        );
      }
      if (size > 0 && Number(this._used.get(origin)?.used ?? 0) > this._quota) {
        fits = false;
        throw new Error('quota');
      }
    });
    return fits;
  }

  close(): void {
    this._db.close();
  }

  private _transaction(run: () => void): void {
    this._db.exec('BEGIN IMMEDIATE');
    try {
      run();
      this._db.exec('COMMIT');
    } catch (error) {
      this._db.exec('ROLLBACK');
      if ((error as Error).message !== 'quota') throw error;
    }
  }
}

function bytesOf(body: unknown): Uint8Array {
  return body instanceof Uint8Array
    ? body
    : new Uint8Array(body as ArrayBuffer);
}

// --- cookies --------------------------------------------------------------------

/** `host_key` as Chrome writes it: a domain cookie's with a leading dot. */
/** What a browser keeps of a user's answers: read as often as a page asks,
 *  from whichever process the page is in. */
export interface HtmlProfilePermissions {
  /** What the user said, or null where they have not been asked. */
  get(origin: string, name: string): HtmlPermissionState | null;
  /** Keep what they said. */
  set(origin: string, name: string, state: HtmlPermissionState): void;
  /** Let an origin ask again. Says which names it had answers for. */
  forget(origin: string): string[];
}

class ProfilePermissions implements HtmlProfilePermissions {
  constructor(private readonly _db: Database) {}
  get(origin: string, name: string): HtmlPermissionState | null {
    const row = this._db
      .prepare('SELECT state FROM permissions WHERE origin = ? AND name = ?')
      .get(origin, name);
    return (row?.state as HtmlPermissionState | undefined) ?? null;
  }
  set(origin: string, name: string, state: HtmlPermissionState): void {
    this._db
      .prepare(
        'INSERT OR REPLACE INTO permissions (origin, name, state) VALUES (?, ?, ?)',
      )
      .run(origin, name, state);
  }
  forget(origin: string): string[] {
    const names = this._db
      .prepare('SELECT name FROM permissions WHERE origin = ?')
      .all(origin)
      .map((row) => String(row.name));
    this._db.prepare('DELETE FROM permissions WHERE origin = ?').run(origin);
    return names;
  }
}

const hostKey = (c: { domain: string; hostOnly: boolean }) =>
  c.hostOnly ? c.domain : `.${c.domain}`;

class ProfileCookies implements HtmlCookieStore {
  private _seen = -1;
  private _put: Statement;
  private _delete: Statement;
  private _all: Statement;
  constructor(
    private readonly _profile: HtmlProfile,
    db: Database,
  ) {
    this._put = db.prepare(
      `INSERT OR REPLACE INTO cookies (host_key, name, path, value,
         expires_utc, is_secure, is_httponly, samesite, creation_utc,
         last_access_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this._delete = db.prepare(
      'DELETE FROM cookies WHERE host_key = ? AND path = ? AND name = ?',
    );
    this._all = db.prepare('SELECT * FROM cookies');
  }
  load(): HtmlCookie[] {
    this._seen = this._profile.generation();
    return this._all.all().map((row) => {
      const key = String(row.host_key);
      const sameSite = String(row.samesite);
      return {
        name: String(row.name),
        value: String(row.value),
        domain: key.replace(/^\./, ''),
        hostOnly: !key.startsWith('.'),
        path: String(row.path),
        expires: row.expires_utc === null ? null : Number(row.expires_utc),
        secure: !!row.is_secure,
        httpOnly: !!row.is_httponly,
        sameSite:
          sameSite === 'strict' || sameSite === 'lax' || sameSite === 'none'
            ? sameSite
            : 'default',
        created: Number(row.creation_utc),
        lastAccess: Number(row.last_access_utc),
      };
    });
  }
  changed(): boolean {
    return this._profile.generation() !== this._seen;
  }
  put(c: HtmlCookie): void {
    this._put.run(
      hostKey(c),
      c.name,
      c.path,
      c.value,
      c.expires,
      c.secure ? 1 : 0,
      c.httpOnly ? 1 : 0,
      c.sameSite,
      c.created,
      c.lastAccess,
    );
  }
  delete(c: HtmlCookie): void {
    this._delete.run(hostKey(c), c.path, c.name);
  }
}

// --- localStorage and sessionStorage --------------------------------------------

/**
 * An origin's `localStorage`: the table's rows, read once and kept, and read
 * again where another process wrote since. A write goes to the table at
 * once, a statement each.
 */
class ProfileArea implements HtmlStorageArea {
  private _items: MemoryStorageArea | null = null;
  private _seen = -1;
  constructor(
    private readonly _profile: HtmlProfile,
    private readonly _statements: AreaStatements,
    private readonly _scope: unknown[],
  ) {}
  private _fresh(): MemoryStorageArea {
    const generation = this._profile.generation();
    if (!this._items || generation !== this._seen) {
      this._seen = generation;
      this._items = new MemoryStorageArea(
        this._statements.all
          .all(...this._scope)
          .map((r) => [String(r.key), String(r.value)] as [string, string]),
      );
    }
    return this._items;
  }
  get(key: string): string | null {
    return this._fresh().get(key);
  }
  set(key: string, value: string): boolean {
    if (!this._fresh().set(key, value)) return false;
    this._statements.put.run(...this._scope, key, value);
    return true;
  }
  remove(key: string): void {
    this._fresh().remove(key);
    this._statements.remove.run(...this._scope, key);
  }
  clear(): void {
    this._fresh().clear();
    this._statements.clear.run(...this._scope);
  }
  keys(): string[] {
    return this._fresh().keys();
  }
}

interface AreaStatements {
  all: Statement;
  put: Statement;
  remove: Statement;
  clear: Statement;
}

class ProfileStorage implements HtmlStorage {
  readonly indexedDB: HtmlIndexedDB;
  /** What a page's `caches` keep, where the profile has its file. */
  caches?: HtmlCacheStore;
  private _local = new Map<string, HtmlStorageArea>();
  private _session = new Map<string, HtmlStorageArea>();
  private _localStatements: AreaStatements;
  private _sessionStatements: AreaStatements | null;
  private _listeners = new Set<(change: HtmlStorageChange) => void>();
  private _logEvent: Statement;
  private _prune: Statement;
  private _since: Statement;
  private _lastEvent: Statement;
  private _seq = 0;
  private _seen = -1;
  private _timer: unknown = null;
  private _told = 0;
  /** This connection's token, which its own changes carry in
   *  `storage_events`: its listeners heard them as they were told. */
  private readonly _writer = Math.random().toString(36).slice(2, 10);
  constructor(
    private readonly _profile: HtmlProfile,
    db: Database,
    private readonly _tab: string | null,
  ) {
    this._localStatements = {
      all: db.prepare('SELECT key, value FROM local_storage WHERE origin = ?'),
      put: db.prepare(
        'INSERT OR REPLACE INTO local_storage (origin, key, value) VALUES (?, ?, ?)',
      ),
      remove: db.prepare(
        'DELETE FROM local_storage WHERE origin = ? AND key = ?',
      ),
      clear: db.prepare('DELETE FROM local_storage WHERE origin = ?'),
    };
    this._sessionStatements = _tab
      ? {
          all: db.prepare(
            'SELECT key, value FROM session_storage WHERE tab = ? AND origin = ?',
          ),
          put: db.prepare(
            'INSERT OR REPLACE INTO session_storage (tab, origin, key, value) VALUES (?, ?, ?, ?)',
          ),
          remove: db.prepare(
            'DELETE FROM session_storage WHERE tab = ? AND origin = ? AND key = ?',
          ),
          clear: db.prepare(
            'DELETE FROM session_storage WHERE tab = ? AND origin = ?',
          ),
        }
      : null;
    this._logEvent = db.prepare(
      `INSERT INTO storage_events (origin, key, old_value, new_value, url,
         source, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this._prune = db.prepare('DELETE FROM storage_events WHERE at < ?');
    this._since = db.prepare(
      'SELECT * FROM storage_events WHERE seq > ? ORDER BY seq',
    );
    this._lastEvent = db.prepare('SELECT MAX(seq) AS seq FROM storage_events');
    this.indexedDB = new ProfileIndexedDB(_profile, db);
  }
  local(origin: string): HtmlStorageArea {
    let area = this._local.get(origin);
    if (!area) {
      area = new ProfileArea(this._profile, this._localStatements, [origin]);
      this._local.set(origin, area);
    }
    return area;
  }
  session(origin: string): HtmlStorageArea {
    let area = this._session.get(origin);
    if (!area) {
      area = this._sessionStatements
        ? new ProfileSessionArea(this._sessionStatements, [this._tab, origin])
        : new MemoryStorageArea();
      this._session.set(origin, area);
    }
    return area;
  }
  tell(change: HtmlStorageChange): void {
    for (const listener of [...this._listeners]) listener(change);
    // a session's items are one tab's, and so one process's
    if (change.kind !== 'local') return;
    const now = Date.now();
    this._logEvent.run(
      change.origin,
      change.key,
      change.oldValue,
      change.newValue,
      change.url,
      `${this._writer} ${change.source}`,
      now,
    );
    if (++this._told % 64 === 0) this._prune.run(now - EVENT_TTL_MS);
  }
  watch(listener: (change: HtmlStorageChange) => void): () => void {
    this._listeners.add(listener);
    if (!this._timer) {
      this._seq = Number(this._lastEvent.get()?.seq ?? 0);
      this._seen = this._profile.generation();
      const timer = setInterval(() => this._poll(), WATCH_MS) as {
        unref?(): void;
      };
      // a process is not kept alive to hear of another's writes
      timer.unref?.();
      this._timer = timer;
    }
    return () => {
      this._listeners.delete(listener);
      if (!this._listeners.size) this.stop();
    };
  }
  stop(): void {
    if (this._timer) clearInterval(this._timer as never);
    this._timer = null;
  }
  /** The changes other processes logged since the last look. */
  private _poll(): void {
    const generation = this._profile.generation();
    if (generation === this._seen) return;
    this._seen = generation;
    for (const row of this._since.all(this._seq)) {
      this._seq = Number(row.seq);
      const source = String(row.source);
      if (source.startsWith(`${this._writer} `)) continue;
      const change: HtmlStorageChange = {
        kind: 'local',
        origin: String(row.origin),
        key: row.key === null ? null : String(row.key),
        oldValue: row.old_value === null ? null : String(row.old_value),
        newValue: row.new_value === null ? null : String(row.new_value),
        url: String(row.url),
        source,
      };
      for (const listener of [...this._listeners]) listener(change);
    }
  }
}

/** A tab's `sessionStorage` for an origin: one process's alone, so held in
 *  memory and written through, for the tab restored after a restart. */
class ProfileSessionArea implements HtmlStorageArea {
  private _items: MemoryStorageArea;
  constructor(
    private readonly _statements: AreaStatements,
    private readonly _scope: unknown[],
  ) {
    this._items = new MemoryStorageArea(
      _statements.all
        .all(..._scope)
        .map((r) => [String(r.key), String(r.value)] as [string, string]),
    );
  }
  get(key: string): string | null {
    return this._items.get(key);
  }
  set(key: string, value: string): boolean {
    if (!this._items.set(key, value)) return false;
    this._statements.put.run(...this._scope, key, value);
    return true;
  }
  remove(key: string): void {
    this._items.remove(key);
    this._statements.remove.run(...this._scope, key);
  }
  clear(): void {
    this._items.clear();
    this._statements.clear.run(...this._scope);
  }
  keys(): string[] {
    return this._items.keys();
  }
}

// --- IndexedDB -------------------------------------------------------------------

class ProfileIndexedDB implements HtmlIndexedDB {
  private _secret: Uint8Array | null = null;
  private _makeSecret: Statement;
  private _readSecret: Statement;
  private _list: Statement;
  private _database: Statement;
  private _records: Statement;
  private _stamp: Statement;
  private _upsert: Statement;
  private _put: Statement;
  private _delete: Statement;
  private _storeRecords: Statement;
  private _dropRecords: Statement;
  private _dropDatabase: Statement;
  /** Stamps read, by origin and name, and the generation they were read
   *  at: a transaction asks at its start, and most of the time nobody
   *  else wrote. */
  private _stamps = new Map<string, number>();
  private _seen = -1;
  constructor(
    private readonly _profile: HtmlProfile,
    db: Database,
  ) {
    this._list = db.prepare(
      'SELECT name, version FROM idb_databases WHERE origin = ?',
    );
    this._database = db.prepare(
      'SELECT version, schema, stamp FROM idb_databases WHERE origin = ? AND name = ?',
    );
    this._records = db.prepare(
      'SELECT store, key, value FROM idb_records WHERE origin = ? AND db = ?',
    );
    this._stamp = db.prepare(
      'SELECT stamp FROM idb_databases WHERE origin = ? AND name = ?',
    );
    this._upsert = db.prepare(
      `INSERT INTO idb_databases (origin, name, version, schema, stamp)
         VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (origin, name) DO UPDATE SET version = excluded.version,
         schema = excluded.schema, stamp = stamp + 1`,
    );
    this._put = db.prepare(
      'INSERT OR REPLACE INTO idb_records (origin, db, store, key, value) VALUES (?, ?, ?, ?, ?)',
    );
    this._makeSecret = db.prepare(
      'INSERT OR IGNORE INTO key_secret (id, secret) VALUES (1, ?)',
    );
    this._readSecret = db.prepare('SELECT secret FROM key_secret WHERE id = 1');
    this._delete = db.prepare(
      'DELETE FROM idb_records WHERE origin = ? AND db = ? AND store = ? AND key = ?',
    );
    this._storeRecords = db.prepare(
      'SELECT DISTINCT store FROM idb_records WHERE origin = ? AND db = ?',
    );
    this._dropRecords = db.prepare(
      'DELETE FROM idb_records WHERE origin = ? AND db = ? AND store = ?',
    );
    this._dropDatabase = db.prepare(
      'DELETE FROM idb_databases WHERE origin = ? AND name = ?',
    );
  }
  list(origin: string): { name: string; version: number }[] {
    return this._list.all(origin).map((row) => ({
      name: String(row.name),
      version: Number(row.version),
    }));
  }
  load(origin: string, name: string): HtmlIdbSnapshot | null {
    const row = this._database.get(origin, name);
    if (!row) return null;
    const stamp = Number(row.stamp);
    this._remember(origin, name, stamp);
    return {
      version: Number(row.version),
      stamp,
      stores: JSON.parse(String(row.schema)) as HtmlIdbStoreSchema[],
      records: this._records
        .all(origin, name)
        .map(
          (r) =>
            [String(r.store), String(r.key), String(r.value)] as [
              string,
              string,
              string,
            ],
        ),
    };
  }
  stamp(origin: string, name: string): number {
    const generation = this._profile.generation();
    if (generation !== this._seen) {
      this._seen = generation;
      this._stamps.clear();
    }
    const key = `${origin}\u0000${name}`;
    const kept = this._stamps.get(key);
    if (kept !== undefined) return kept;
    const stamp = Number(this._stamp.get(origin, name)?.stamp ?? 0);
    this._stamps.set(key, stamp);
    return stamp;
  }
  commit(origin: string, name: string, commit: HtmlIdbCommit): number {
    const stamp = this._profile.transaction(() => {
      this._upsert.run(
        origin,
        name,
        commit.version,
        JSON.stringify(commit.stores),
      );
      const kept = new Set(commit.stores.map((s) => s.name));
      for (const row of this._storeRecords.all(origin, name)) {
        const store = String(row.store);
        if (!kept.has(store)) this._dropRecords.run(origin, name, store);
      }
      for (const [store, key] of commit.delete) {
        this._delete.run(origin, name, store, key);
      }
      for (const [store, key, value] of commit.put) {
        this._put.run(origin, name, store, key, value);
      }
      return Number(this._stamp.get(origin, name)?.stamp ?? 0);
    });
    this._remember(origin, name, stamp);
    return stamp;
  }
  /** The first process to ask makes it, and the rest read what that made:
   *  a key is as safe here as a cookie is, as a browser's profile has it. */
  keySecret(): Uint8Array {
    if (this._secret) return this._secret;
    let kept = this._readSecret.get()?.secret;
    if (typeof kept !== 'string') {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      this._makeSecret.run(
        [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''),
      );
      kept = this._readSecret.get()?.secret;
    }
    const hex = String(kept);
    this._secret = Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
      parseInt(hex.slice(i * 2, i * 2 + 2), 16),
    );
    return this._secret;
  }
  delete(origin: string, name: string): void {
    this._profile.transaction(() => {
      this._dropDatabase.run(origin, name);
      for (const row of this._storeRecords.all(origin, name)) {
        this._dropRecords.run(origin, name, String(row.store));
      }
    });
    this._stamps.delete(`${origin}\u0000${name}`);
  }
  private _remember(origin: string, name: string, stamp: number): void {
    // a commit of this connection's moves no generation; another's since
    // the last look makes every other stamp kept stale
    const generation = this._profile.generation();
    if (generation !== this._seen) {
      this._seen = generation;
      this._stamps.clear();
    }
    this._stamps.set(`${origin}\u0000${name}`, stamp);
  }
}
