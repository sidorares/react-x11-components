// Where a page's `localStorage`, `sessionStorage` and IndexedDB are kept:
// the seam `<Html scripts>` asks (`HtmlScripts.storage`), shaped so that
// memory and a profile several processes share (`./profile.ts`) answer it
// alike.
//
// **Nothing is stored by construction**, so the default is memory
// (`memoryStorage()`): an origin's items for as long as the process, which
// is the tab in the example browser, and IndexedDB for as long as the
// document, as a private window's are. A host that keeps a profile hands
// one in.
//
// Every method is synchronous, because `localStorage` is, and because an
// IndexedDB transaction commits between two tasks with nothing to wait on.
// Keys and values cross as strings: the page's realm encodes an IndexedDB
// value (a structured clone, `serializeClone`) and a key, and a store keeps
// the text without reading it.
//
// Light on purpose: `<Html>` reaches it whether or not a document runs
// scripts.

/** One origin's `localStorage` or `sessionStorage` (HTML 12.2). */
export interface HtmlStorageArea {
  get(key: string): string | null;
  /** False where the item would take the origin past its quota, and it is
   *  not set: the page's `setItem` throws `QuotaExceededError`. */
  set(key: string, value: string): boolean;
  remove(key: string): void;
  clear(): void;
  /** Its keys, in the order `key(n)` hands them out. */
  keys(): string[];
}

/** A change one document made to its origin's storage, as the others are
 *  told of it (HTML 12.2.4, the `storage` event). */
export interface HtmlStorageChange {
  kind: 'local' | 'session';
  origin: string;
  /** The key, or null where the area was cleared. */
  key: string | null;
  oldValue: string | null;
  newValue: string | null;
  /** The address of the document that made it. */
  url: string;
  /** Who made it, which hears nothing of its own change: a token the host
   *  makes for each document. */
  source: string;
}

/** An object store's shape, as IndexedDB keeps it across transactions. */
export interface HtmlIdbStoreSchema {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  /** The key generator's next number. */
  current: number;
  indexes: {
    name: string;
    keyPath: string | string[];
    unique: boolean;
    multiEntry: boolean;
  }[];
}

/** A database as it was last committed. Keys and values are the realm's
 *  encodings, kept as text. */
export interface HtmlIdbSnapshot {
  version: number;
  /** How many commits it has had: what tells a document that another one
   *  committed since it read it. */
  stamp: number;
  stores: HtmlIdbStoreSchema[];
  /** Each record: its store, its key, its value. */
  records: [store: string, key: string, value: string][];
}

/** What a transaction changed, committed whole. */
export interface HtmlIdbCommit {
  version: number;
  /** Every store the database has after it: a store no longer named here
   *  is gone with its records. */
  stores: HtmlIdbStoreSchema[];
  put: [store: string, key: string, value: string][];
  delete: [store: string, key: string][];
}

/**
 * Where an origin's IndexedDB databases are kept, where a host keeps them
 * past the document (`HtmlStorage.indexedDB`). The page's realm still holds
 * each database it opened, orders its keys and runs its transactions; this
 * is what it reads a database from as it opens it and writes each
 * committed transaction to.
 */
export interface HtmlIndexedDB {
  /** The origin's databases, by name, and their versions. */
  list(origin: string): { name: string; version: number }[];
  /** A database as it was last committed, or null for none. */
  load(origin: string, name: string): HtmlIdbSnapshot | null;
  /** Its stamp, or 0 for none: a document reads the database again where
   *  another committed since. */
  stamp(origin: string, name: string): number;
  /** A transaction's changes: the stamp the database has after them. */
  commit(origin: string, name: string, commit: HtmlIdbCommit): number;
  delete(origin: string, name: string): void;
}

/** A page's storage (`HtmlScripts.storage`). */
export interface HtmlStorage {
  /** An origin's `localStorage`, which every document of the origin
   *  shares. */
  local(origin: string): HtmlStorageArea;
  /** An origin's `sessionStorage`, which the documents of one tab share. */
  session(origin: string): HtmlStorageArea;
  /** A change a document made, for the others to hear: each listener
   *  `watch` was given hears it, and so does every other process that
   *  shares the storage. */
  tell?(change: HtmlStorageChange): void;
  /** Told of each change a document made, here or in another process that
   *  shares the storage, until the function it answers is called. */
  watch?(listener: (change: HtmlStorageChange) => void): () => void;
  /** Where IndexedDB is kept past the document. Absent, a database lives
   *  as long as the document that opened it. */
  indexedDB?: HtmlIndexedDB;
}

/** How much an origin may keep in `localStorage` or `sessionStorage`, in
 *  UTF-16 code units of its keys and values: 5 MiB, as Firefox and Safari
 *  allow. */
export const STORAGE_QUOTA = 5 * 1024 * 1024;

/** An area in memory, which counts what it holds against the quota. */
export class MemoryStorageArea implements HtmlStorageArea {
  private _items = new Map<string, string>();
  private _size = 0;
  constructor(entries?: Iterable<[string, string]>) {
    for (const [k, v] of entries ?? []) {
      this._items.set(k, v);
      this._size += k.length + v.length;
    }
  }
  get(key: string): string | null {
    return this._items.get(key) ?? null;
  }
  set(key: string, value: string): boolean {
    const old = this._items.get(key);
    const size =
      this._size -
      (old === undefined ? 0 : key.length + old.length) +
      key.length +
      value.length;
    if (size > STORAGE_QUOTA && size > this._size) return false;
    this._items.set(key, value);
    this._size = size;
    return true;
  }
  remove(key: string): void {
    const old = this._items.get(key);
    if (old === undefined) return;
    this._items.delete(key);
    this._size -= key.length + old.length;
  }
  clear(): void {
    this._items.clear();
    this._size = 0;
  }
  keys(): string[] {
    return [...this._items.keys()];
  }
}

/**
 * Storage in memory, for as long as the process, per origin: the default.
 * Its listeners hear the changes the documents of this process make — a
 * frame's, beside the page that holds it.
 */
export function memoryStorage(): HtmlStorage {
  const local = new Map<string, MemoryStorageArea>();
  const session = new Map<string, MemoryStorageArea>();
  const listeners = new Set<(change: HtmlStorageChange) => void>();
  const area = (all: Map<string, MemoryStorageArea>, origin: string) => {
    let found = all.get(origin);
    if (!found) all.set(origin, (found = new MemoryStorageArea()));
    return found;
  };
  return {
    local: (origin) => area(local, origin),
    session: (origin) => area(session, origin),
    tell(change) {
      for (const listener of [...listeners]) listener(change);
    },
    watch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let shared: HtmlStorage | null = null;

/** The storage a document is given where its host hands none: memory, one
 *  a process, made the first time it is asked for. */
export function defaultStorage(): HtmlStorage {
  return (shared ??= memoryStorage());
}
