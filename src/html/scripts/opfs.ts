// The origin private file system (WHATWG File System), the host's half: one
// tree of directories and files an origin, held in this process's memory, and
// the locks a writable stream and a sync access handle take on a file.
//
// **Nothing is stored by construction** (AGENTS.md): what a page writes here
// lasts as long as the process does and reaches no disk. A window and its
// workers share one store, since a worker's thread asks the page process
// (`PageWorkers`, the `opfs` ask), which is what lets a file a window writes be
// opened by a sync access handle in a worker.
//
// A handle is a path from the root, as Chrome's is: an entry removed and made
// again at the same path is the same entry to a handle that names it, and a
// handle to an entry that is gone answers `NotFoundError`.
//
// Every op is synchronous and answers a primitive, or throws an `FsError` the
// host hands the page as a `DOMException` of its kind.

type Primitive = string | number | boolean | null | undefined;

/** An error the page is handed as a `DOMException` of this kind. */
export class FsError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

interface FsFile {
  kind: 'file';
  bytes: Uint8Array;
  size: number;
  modified: number;
  /** Moves with every change, which a `File` read from it is checked by. */
  stamp: number;
  /** The locks on it, by token. */
  locks: Map<string, Lock>;
}
interface FsDir {
  kind: 'directory';
  children: Map<string, Entry>;
}
type Entry = FsFile | FsDir;

/** What a lock is, `wfs:` a writable stream's and `sah:` an access handle's,
 *  by its mode. Two locks on one file go together only where they are of one
 *  mode and that mode shares: a siloed writable's, a read-only handle's and an
 *  unsafe one's do. */
type LockType = string;
const SHARED = new Set(['wfs:siloed', 'sah:read-only', 'sah:readwrite-unsafe']);

interface Lock {
  token: string;
  type: LockType;
  owner: string;
  file: FsFile;
  /** A writable's swap file, which its close commits. */
  swap?: { bytes: Uint8Array; size: number };
}

const SYSTEMS = new Map<string, FsDir>();
const LOCKS = new Map<string, Lock>();
let tokens = 0;
let stamps = 0;

const notFound = (
  what = 'A requested file or directory could not be found at the time an operation was processed.',
) => new FsError('NotFoundError', what);
const locked = () =>
  new FsError(
    'NoModificationAllowedError',
    'An attempt was made to modify an object where modifications are not allowed.',
  );
const mismatch = () =>
  new FsError(
    'TypeMismatchError',
    'The path supplied exists, but was not an entry of requested type.',
  );

const rootOf = (origin: string): FsDir => {
  let root = SYSTEMS.get(origin);
  if (!root) {
    root = { kind: 'directory', children: new Map() };
    SYSTEMS.set(origin, root);
  }
  return root;
};

const pathOf = (json: string): string[] => {
  const path = JSON.parse(json || '[]');
  return Array.isArray(path) ? path.map(String) : [];
};

/** The entry at a path, or null. */
const find = (root: FsDir, path: string[]): Entry | null => {
  let at: Entry = root;
  for (const name of path) {
    if (at.kind !== 'directory') return null;
    const next = at.children.get(name);
    if (!next) return null;
    at = next;
  }
  return at;
};
const dirAt = (root: FsDir, path: string[]): FsDir => {
  const dir = find(root, path);
  if (!dir) throw notFound();
  if (dir.kind !== 'directory') throw mismatch();
  return dir;
};
const fileAt = (root: FsDir, path: string[]): FsFile => {
  const file = find(root, path);
  if (!file) throw notFound();
  if (file.kind !== 'file') throw mismatch();
  return file;
};

/** Whether an entry, or anything in it, holds a lock. */
const holdsLock = (entry: Entry): boolean => {
  if (entry.kind === 'file') return entry.locks.size > 0;
  for (const child of entry.children.values())
    if (holdsLock(child)) return true;
  return false;
};

const sizeOf = (entry: Entry): number => {
  if (entry.kind === 'file') return entry.size;
  let size = 0;
  for (const child of entry.children.values()) size += sizeOf(child);
  return size;
};

const newFile = (): FsFile => ({
  kind: 'file',
  bytes: new Uint8Array(0),
  size: 0,
  modified: Date.now(),
  stamp: ++stamps,
  locks: new Map(),
});

/** Bytes with room for `size`, the old ones kept. */
const room = (bytes: Uint8Array, size: number): Uint8Array => {
  if (size <= bytes.length) return bytes;
  const grown = new Uint8Array(Math.max(size, bytes.length * 2, 64));
  grown.set(bytes);
  return grown;
};

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
};
const fromBase64 = (text: string): Uint8Array => {
  const s = atob(text || '');
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
};
declare const btoa: (s: string) => string;
declare const atob: (s: string) => string;

const writeInto = (
  target: { bytes: Uint8Array; size: number },
  at: number,
  data: Uint8Array,
): void => {
  const end = at + data.length;
  target.bytes = room(target.bytes, end);
  if (at > target.size) target.bytes.fill(0, target.size, at);
  target.bytes.set(data, at);
  target.size = Math.max(target.size, end);
};
const truncateTo = (
  target: { bytes: Uint8Array; size: number },
  size: number,
): void => {
  if (size > target.size) {
    target.bytes = room(target.bytes, size);
    target.bytes.fill(0, target.size, size);
  }
  target.size = size;
};

const touched = (file: FsFile): void => {
  file.modified = Math.max(Date.now(), file.modified + 1);
  file.stamp = ++stamps;
};

const take = (file: FsFile, type: LockType, owner: string): Lock => {
  for (const lock of file.locks.values()) {
    if (lock.type !== type || !SHARED.has(type)) throw locked();
  }
  const token = `l${++tokens}`;
  const lock: Lock = { token, type, owner, file };
  file.locks.set(token, lock);
  LOCKS.set(token, lock);
  return lock;
};
const lockOf = (token: string): Lock => {
  const lock = LOCKS.get(token);
  if (!lock) {
    throw new FsError('InvalidStateError', 'The handle is closed.');
  }
  return lock;
};
const release = (token: string): void => {
  const lock = LOCKS.get(token);
  if (!lock) return;
  LOCKS.delete(token);
  lock.file.locks.delete(token);
};

/** Every lock an owner holds let go: a worker that ended, a document that went. */
export function releaseOwner(owner: string): void {
  for (const [token, lock] of LOCKS) if (lock.owner === owner) release(token);
}

/** How much an origin's file system holds, in bytes. */
export function fileSystemUsage(origin: string): number {
  const root = SYSTEMS.get(origin);
  return root ? sizeOf(root) : 0;
}

/**
 * One op of a page's. `owner` is who holds what it locks: a document's host,
 * or a worker of one. The arguments are strings: paths as JSON arrays of
 * names, `c` what else the op takes.
 */
export function opfsOp(
  origin: string,
  owner: string,
  op: string,
  a = '',
  b = '',
  c = '',
): Primitive {
  const root = rootOf(origin);
  switch (op) {
    // an entry of a directory, `c` its kind, made where `c` ends in `+`
    case 'get': {
      const dir = dirAt(root, pathOf(a));
      const create = c.endsWith('+');
      const [name, kind] = [b, create ? c.slice(0, -1) : c];
      const found = dir.children.get(name);
      if (found) {
        if (found.kind !== kind) throw mismatch();
        return true;
      }
      if (!create) throw notFound();
      dir.children.set(
        name,
        kind === 'file'
          ? newFile()
          : { kind: 'directory', children: new Map() },
      );
      return true;
    }
    // whether an entry of that kind is at the path
    case 'is': {
      const entry = find(root, pathOf(a));
      if (!entry) throw notFound();
      if (entry.kind !== b) throw mismatch();
      return true;
    }
    case 'list': {
      const dir = dirAt(root, pathOf(a));
      return JSON.stringify(
        [...dir.children].map(([name, e]) => [name, e.kind]),
      );
    }
    case 'remove': {
      // `a` the directory, `b` the name in it, or no name for the root; `c`
      // says whether it goes with all it holds, and what kind the handle
      // that removes itself is of
      const path = pathOf(a);
      const [how, kind] = c.split(',');
      const recursive = how === 'recursive';
      if (!b && !path.length) {
        if (holdsLock(root)) throw locked();
        root.children.clear();
        return true;
      }
      const dir = dirAt(root, path);
      const entry = dir.children.get(b);
      if (!entry) throw notFound();
      if (kind && entry.kind !== kind) throw notFound();
      if (holdsLock(entry)) throw locked();
      if (entry.kind === 'directory' && entry.children.size && !recursive) {
        throw new FsError(
          'InvalidModificationError',
          'The object can not be modified in this way.',
        );
      }
      dir.children.delete(b);
      return true;
    }
    case 'move': {
      // `a` the entry, `b` the directory it goes to, `c` its name there
      const from = pathOf(a);
      const name = from[from.length - 1];
      const parent = dirAt(root, from.slice(0, -1));
      const entry = parent.children.get(name);
      if (!entry) throw notFound();
      const toPath = pathOf(b);
      const to = dirAt(root, toPath);
      if (to === parent && name === c) return JSON.stringify(toPath);
      if (holdsLock(entry)) throw locked();
      // a directory goes into nothing it holds
      if (
        entry.kind === 'directory' &&
        toPath.length >= from.length &&
        from.every((part, i) => toPath[i] === part)
      ) {
        throw new FsError(
          'InvalidModificationError',
          'A directory cannot be moved into itself.',
        );
      }
      const there = to.children.get(c);
      if (there) {
        if (there.kind === 'directory' || entry.kind === 'directory') {
          throw new FsError(
            'InvalidModificationError',
            'The object can not be modified in this way.',
          );
        }
        if (holdsLock(there)) throw locked();
      }
      parent.children.delete(name);
      to.children.set(c, entry);
      return true;
    }
    case 'file': {
      const file = fileAt(root, pathOf(a));
      return JSON.stringify({
        size: file.size,
        modified: file.modified,
        stamp: file.stamp,
      });
    }
    // a file's bytes, as a `File` read from it at `b` reads them
    case 'bytes': {
      const file = fileAt(root, pathOf(a));
      if (b && Number(b) !== file.stamp) {
        throw new FsError(
          'NotReadableError',
          'The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.',
        );
      }
      return toBase64(file.bytes.subarray(0, file.size));
    }
    // a writable stream: `b` its mode, `c` whether it starts from what the
    // file holds
    case 'wopen': {
      const file = fileAt(root, pathOf(a));
      const lock = take(file, `wfs:${b || 'siloed'}`, owner);
      lock.swap =
        c === 'keep'
          ? { bytes: file.bytes.slice(0, file.size), size: file.size }
          : { bytes: new Uint8Array(0), size: 0 };
      return lock.token;
    }
    case 'wwrite': {
      const lock = lockOf(a);
      writeInto(lock.swap!, Number(b) || 0, fromBase64(c));
      return lock.swap!.size;
    }
    case 'wtruncate': {
      const lock = lockOf(a);
      truncateTo(lock.swap!, Number(b) || 0);
      return true;
    }
    case 'wclose': {
      const lock = lockOf(a);
      release(a);
      const file = lock.file;
      const swap = lock.swap!;
      file.bytes = swap.bytes;
      file.size = swap.size;
      touched(file);
      return true;
    }
    case 'wabort':
      release(a);
      return true;
    // an access handle in `b`'s mode
    case 'sopen': {
      const file = fileAt(root, pathOf(a));
      const lock = take(file, `sah:${b || 'readwrite'}`, owner);
      return lock.token;
    }
    case 'sread': {
      const file = lockOf(a).file;
      const at = Number(b) || 0;
      const length = Number(c) || 0;
      if (at >= file.size) return '';
      return toBase64(
        file.bytes.subarray(at, Math.min(file.size, at + length)),
      );
    }
    case 'swrite': {
      const file = lockOf(a).file;
      const data = fromBase64(c);
      writeInto(file, Number(b) || 0, data);
      touched(file);
      return data.length;
    }
    case 'ssize':
      return lockOf(a).file.size;
    case 'struncate': {
      const file = lockOf(a).file;
      truncateTo(file, Number(b) || 0);
      touched(file);
      return true;
    }
    case 'sclose':
      release(a);
      return true;
    case 'usage':
      return fileSystemUsage(origin);
    default:
      return null;
  }
}
