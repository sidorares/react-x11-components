// `navigator.storage` and the origin private file system, as a page's scripts
// see them: the Storage Standard's `StorageManager`, and the File System
// Standard's `FileSystemHandle`, `FileSystemFileHandle`,
// `FileSystemDirectoryHandle`, `FileSystemWritableFileStream` and, in a
// dedicated worker, `FileSystemSyncAccessHandle`.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the
// engine hands it to the context through `Function.prototype.toString()`,
// so it closes over nothing.
//
// The tree is the host's (`opfs.ts`, the `opfs` op): a handle here is a kind
// and a path from the root, and every op names one. What only a page can say
// wrong — a name with a separator in it, a dictionary with no `type` — is a
// `TypeError` here before the host is asked; what the host finds is a
// `DOMException` the bridge throws. The members and errors are Chrome's,
// `remove()`, `move()` and `getUniqueId()` and the lock modes among them.

/** What `installDom` hands this. */
export interface StorageManagerDeps {
  DOMException: unknown;
  /** The host's op, which throws its error as a `DOMException`. */
  call(op: string, a?: unknown, b?: unknown, c?: unknown, d?: unknown): unknown;
  /** A `File` whose bytes are read the first time something asks. */
  lazyFile(
    name: string,
    lastModified: number,
    size: number,
    read: () => Uint8Array,
  ): unknown;
  /** A blob's bytes, which a lazy one reads as they are asked for. */
  blobBytes(blob: unknown): Uint8Array;
  isBlob(value: unknown): boolean;
  utf8(text: string): Uint8Array;
  base64OfBytes(bytes: Uint8Array): string;
  bytesOfBase64(text: string): Uint8Array;
  streams: {
    INTERNAL: object;
    writable(
      start: () => unknown,
      write: (chunk: unknown) => Promise<unknown>,
      close: () => Promise<unknown>,
      abort: (reason: unknown) => Promise<unknown>,
      highWaterMark?: number,
      size?: (chunk: unknown) => number,
      into?: unknown,
    ): unknown;
  };
  WritableStream: unknown;
  WritableStreamDefaultWriter: unknown;
  /** What else this origin keeps, for `estimate()`: IndexedDB's bytes in
   *  this realm, and the Cache API's in the host. */
  idbUsage(): number;
}

export function installStorageManager(D: StorageManagerDeps): {
  interfaces: Record<string, unknown>;
  /** The navigator's `storage`, made the first time it is asked for. */
  storage(): unknown;
  /** What only a dedicated worker has: the sync access handle. */
  dedicatedWorker(): Record<string, unknown>;
  /** What only a window has: `persist()`. */
  worker(): void;
  /** A handle as a clone carries it, and made again from one. */
  handles: {
    is(value: unknown): boolean;
    data(value: unknown): { k: string; p: string[]; o: string };
    from(data: { k: string; p: string[]; o: string }): unknown;
  };
} {
  type Any = any;
  const DOMException: Any = D.DOMException;
  const call = D.call;
  const S = D.streams;
  const WritableStream: Any = D.WritableStream;
  const Writer: Any = D.WritableStreamDefaultWriter;
  const defineProperty = Object.defineProperty;
  // the realm's own, taken before a page can replace them
  const getWriter = WritableStream.prototype.getWriter;
  const writerWrite = Writer.prototype.write;
  const writerRelease = Writer.prototype.releaseLock;
  const reflectApply = Reflect.apply;
  const JSONparse = JSON.parse;
  const JSONstringify = JSON.stringify;
  const isView = ArrayBuffer.isView;
  const Promise_: PromiseConstructor = Promise;

  const TOKEN = Object.freeze(Object.create(null));
  const illegal = (): Any => new TypeError('Illegal constructor');
  const typeError = (message: string): Any => new TypeError(message);
  const dom = (name: string, message: string): Any =>
    new DOMException(message, name);
  const rejected = (error: Any): Promise<Any> => Promise_.reject(error);
  /** What an op answers, or the error it threw, as a promise a task later:
   *  the work is done as the method is called, so that two calls in a row
   *  take their locks in the order they were made. */
  const settle = <T>(fn: () => T | PromiseLike<T>): Promise<T> => {
    let value: Any;
    let failed = false;
    try {
      value = fn();
    } catch (error) {
      value = error;
      failed = true;
    }
    return new Promise_((resolve, reject) => {
      if (failed) reject(value);
      else resolve(value);
    });
  };
  /** The host's op on the tree, its arguments strings, as the host reads
   *  them. */
  const opfs = (op: string, a?: Any, b?: Any, c?: Any): Any =>
    call(
      'opfs',
      op,
      a === undefined ? undefined : `${a}`,
      b === undefined ? undefined : `${b}`,
      c === undefined ? undefined : `${c}`,
    );

  const failedToExecute = (method: string, iface: string, why: string): Any =>
    typeError(`Failed to execute '${method}' on '${iface}': ${why}`);
  const argumentsRequired = (
    method: string,
    iface: string,
    want: number,
    got: number,
  ): Any =>
    failedToExecute(
      method,
      iface,
      `${want} argument${want === 1 ? '' : 's'} required, but only ${got} present.`,
    );
  /** A name an entry may have (File System, "valid file name"), as Chrome
   *  holds it: no separator, of either platform's. */
  const checkName = (name: string, method: string, iface: string): void => {
    if (
      name === '' ||
      name === '.' ||
      name === '..' ||
      name.includes('/') ||
      name.includes('\\')
    ) {
      throw failedToExecute(method, iface, 'Name is not allowed.');
    }
  };
  /** A USVString: lone surrogates as U+FFFD. */
  const usv = (value: Any): string => {
    const s: Any = `${value}`;
    return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s;
  };
  /** A dictionary member as Web IDL reads it: from anything but null and
   *  undefined, which are the empty dictionary, and a primitive, which is a
   *  `TypeError`. */
  const dictionary = (value: Any, method: string, iface: string): Any => {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' && typeof value !== 'function') {
      throw failedToExecute(
        method,
        iface,
        "The provided value is not of type 'dictionary'.",
      );
    }
    return value;
  };
  const enumOf = (
    value: Any,
    allowed: string[],
    fallback: string,
    type: string,
    method: string,
    iface: string,
  ): string => {
    if (value === undefined) return fallback;
    const s = `${value}`;
    if (!allowed.includes(s)) {
      throw failedToExecute(
        method,
        iface,
        `Failed to read the 'mode' property from 'options': The provided value '${s}' is not a valid enum value of type ${type}.`,
      );
    }
    return s;
  };
  /** `[EnforceRange] unsigned long long` (Web IDL 3.2.4.10). */
  const enforceRange = (value: Any, method: string, iface: string): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw failedToExecute(
        method,
        iface,
        "Value is not of type 'unsigned long long'.",
      );
    }
    const t = Math.trunc(n);
    if (t < 0 || t > Number.MAX_SAFE_INTEGER) {
      throw failedToExecute(
        method,
        iface,
        `Value is outside the 'unsigned long long' value range.`,
      );
    }
    return t;
  };
  /** `unsigned long long` without `[EnforceRange]`: modulo 2^64, as a
   *  number holds it. */
  const unsignedLongLong = (value: Any): number => {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? Math.max(0, 2 ** 64 + n) : n;
  };

  // --- handles ----------------------------------------------------------------------

  interface HandleSlot {
    kind: 'file' | 'directory';
    /** The names from the root to the entry, the root's empty. */
    path: string[];
  }
  const SLOTS = new WeakMap<object, HandleSlot>();
  const slotOf = (self: Any, iface: string, method: string): HandleSlot => {
    const slot = SLOTS.get(self);
    const want = iface === 'FileSystemHandle' ? null : iface;
    if (
      !slot ||
      (want === 'FileSystemFileHandle' && slot.kind !== 'file') ||
      (want === 'FileSystemDirectoryHandle' && slot.kind !== 'directory')
    ) {
      throw failedToExecute(method, iface, 'Illegal invocation');
    }
    return slot;
  };
  const handleOf = (kind: 'file' | 'directory', path: string[]): Any => {
    const obj =
      kind === 'file'
        ? new FileSystemFileHandle(TOKEN)
        : new FileSystemDirectoryHandle(TOKEN);
    SLOTS.set(obj, { kind, path: path.slice() });
    defineProperty(obj, BRAND, { value: () => slotData(obj) });
    return obj;
  };
  /** How a same-origin realm's clone tells one of this realm's handles,
   *  which its own table does not hold: what it reads is a kind and a path,
   *  which name nothing outside the reading realm's own origin's tree, so a
   *  page that forges one forges nothing it could not have. */
  const BRAND = Symbol.for('react-x11 FileSystemHandle');
  const slotData = (obj: object): { k: string; p: string[] } | null => {
    const slot = SLOTS.get(obj);
    return slot ? { k: slot.kind, p: slot.path.slice() } : null;
  };
  const foreignData = (value: Any): { k: string; p: string[] } | null => {
    if (value === null || typeof value !== 'object') return null;
    try {
      const read = value[BRAND];
      const data = typeof read === 'function' ? read() : null;
      return data && typeof data.k === 'string' && Array.isArray(data.p)
        ? { k: String(data.k), p: [...data.p].map(String) }
        : null;
    } catch {
      return null;
    }
  };
  const pathText = (path: string[]): string => JSONstringify(path);
  /** A UUID made from a kind and a path, as Chrome's `getUniqueId()` is the
   *  same for every handle to one entry and another for another kind. */
  const uuidOf = (text: string): string => {
    let h1 = 1779033703,
      h2 = 3144134277,
      h3 = 1013904242,
      h4 = 2773480762;
    for (let i = 0; i < text.length; i++) {
      const k = text.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    const hex = [h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1]
      .map((n) => (n >>> 0).toString(16).padStart(8, '0'))
      .join('');
    const variant = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };

  /** The paths a `move()` or a `remove()` under way holds, as Chrome's do
   *  until they are done: what asks for a lock on one, or on what is in or
   *  around one, in the same task is `NoModificationAllowedError`. A realm's
   *  own, since an op is done before another realm could ask. */
  const ONGOING: string[][] = [];
  const overlaps = (a: string[], b: string[]): boolean => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const checkIdle = (path: string[]): void => {
    if (ONGOING.some((p) => overlaps(p, path))) {
      throw dom(
        'NoModificationAllowedError',
        'An attempt was made to modify an object where modifications are not allowed.',
      );
    }
  };
  /** An op that holds its paths until it is done, a microtask later. */
  const ongoing = <T>(paths: string[][], fn: () => T): Promise<T> => {
    for (const path of paths) checkIdle(path);
    ONGOING.push(...paths);
    return Promise_.resolve().then(() => {
      try {
        return fn();
      } finally {
        for (const path of paths) ONGOING.splice(ONGOING.indexOf(path), 1);
      }
    });
  };

  class FileSystemHandle {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegal();
    }
    get kind(): string {
      return slotOf(this, 'FileSystemHandle', 'kind').kind;
    }
    get name(): string {
      const { path } = slotOf(this, 'FileSystemHandle', 'name');
      return path.length ? path[path.length - 1] : '';
    }
    isSameEntry(other: Any = undefined): Promise<boolean> {
      let me: HandleSlot;
      try {
        me = slotOf(this, 'FileSystemHandle', 'isSameEntry');
      } catch (error) {
        return rejected(error);
      }
      if (arguments.length < 1) {
        return rejected(
          argumentsRequired('isSameEntry', 'FileSystemHandle', 1, 0),
        );
      }
      const them = SLOTS.get(other);
      if (!them) {
        return rejected(
          failedToExecute(
            'isSameEntry',
            'FileSystemHandle',
            "parameter 1 is not of type 'FileSystemHandle'.",
          ),
        );
      }
      return settle(
        () =>
          me.kind === them.kind && pathText(me.path) === pathText(them.path),
      );
    }
    getUniqueId(): Promise<string> {
      return settle(() => {
        const { kind, path } = slotOf(this, 'FileSystemHandle', 'getUniqueId');
        return uuidOf(`${kind}\u0000${pathText(path)}`);
      });
    }
    queryPermission(): Promise<string> {
      return settle(() => {
        slotOf(this, 'FileSystemHandle', 'queryPermission');
        return 'granted';
      });
    }
    requestPermission(): Promise<string> {
      return settle(() => {
        slotOf(this, 'FileSystemHandle', 'requestPermission');
        return 'granted';
      });
    }
    /** The entry removed (Chrome's, File System Access): a directory with
     *  all it holds where `recursive` says so; the root left empty, a fresh
     *  file system. */
    remove(options: Any = undefined): Promise<undefined> {
      return settle(() => {
        const slot = slotOf(this, 'FileSystemHandle', 'remove');
        const { recursive } = dictionary(options, 'remove', 'FileSystemHandle');
        const parent = slot.path.slice(0, -1);
        const name = slot.path[slot.path.length - 1] ?? '';
        const path = slot.path.slice();
        return ongoing([path], () => {
          opfs(
            'remove',
            pathText(parent),
            name,
            `${recursive ? 'recursive' : ''},${slot.kind}`,
          );
          return undefined;
        });
      });
    }
    /** The entry renamed, moved into a directory, or both (Chrome's): the
     *  handle names where it went. */
    move(
      destination: Any = undefined,
      newName: Any = undefined,
    ): Promise<undefined> {
      return settle(() => {
        const slot = slotOf(this, 'FileSystemHandle', 'move');
        if (arguments.length < 1) {
          throw argumentsRequired('move', 'FileSystemHandle', 1, 0);
        }
        let dir: string[];
        let name: string;
        const target = SLOTS.get(destination);
        if (target) {
          if (target.kind !== 'directory') {
            throw failedToExecute(
              'move',
              'FileSystemHandle',
              "parameter 1 is not of type 'FileSystemDirectoryHandle'.",
            );
          }
          dir = target.path;
          name =
            arguments.length > 1 && newName !== undefined
              ? usv(newName)
              : (slot.path[slot.path.length - 1] ?? '');
        } else {
          dir = slot.path.slice(0, -1);
          name = usv(destination);
        }
        checkName(name, 'move', 'FileSystemHandle');
        if (!slot.path.length) {
          throw dom(
            'InvalidModificationError',
            'The root of a file system cannot be moved.',
          );
        }
        const from = slot.path.slice();
        const to = [...dir, name];
        return ongoing(
          from.join('/') === to.join('/') ? [from] : [from, to],
          () => {
            opfs('move', pathText(from), pathText(dir), name);
            slot.path = to;
            return undefined;
          },
        );
      });
    }
  }

  class FileSystemFileHandle extends FileSystemHandle {
    getFile(): Promise<Any> {
      return settle(() => {
        const slot = slotOf(this, 'FileSystemFileHandle', 'getFile');
        const path = pathText(slot.path);
        const told = JSONparse(String(opfs('file', path)));
        const stamp = told.stamp;
        return D.lazyFile(
          slot.path[slot.path.length - 1] ?? '',
          told.modified,
          told.size,
          () => D.bytesOfBase64(String(opfs('bytes', path, String(stamp)))),
        );
      });
    }
    createWritable(options: Any = undefined): Promise<Any> {
      return settle(() => {
        const slot = slotOf(this, 'FileSystemFileHandle', 'createWritable');
        const o = dictionary(options, 'createWritable', 'FileSystemFileHandle');
        const keep = !!o.keepExistingData;
        const mode = enumOf(
          o.mode,
          ['siloed', 'exclusive'],
          'siloed',
          'FileSystemWritableFileStreamMode',
          'createWritable',
          'FileSystemFileHandle',
        );
        checkIdle(slot.path);
        const token = String(
          opfs('wopen', pathText(slot.path), mode, keep ? 'keep' : ''),
        );
        return makeWritable(token, mode);
      });
    }
  }
  /** `createSyncAccessHandle()`, a dedicated worker's alone
   *  (`[Exposed=DedicatedWorker]`). */
  function createSyncAccessHandle(
    this: Any,
    options: Any = undefined,
  ): Promise<Any> {
    return settle(() => {
      const slot = slotOf(
        this,
        'FileSystemFileHandle',
        'createSyncAccessHandle',
      );
      const o = dictionary(
        options,
        'createSyncAccessHandle',
        'FileSystemFileHandle',
      );
      const mode = enumOf(
        o.mode,
        ['readwrite', 'read-only', 'readwrite-unsafe'],
        'readwrite',
        'FileSystemSyncAccessHandleMode',
        'createSyncAccessHandle',
        'FileSystemFileHandle',
      );
      checkIdle(slot.path);
      const token = String(opfs('sopen', pathText(slot.path), mode));
      return makeAccessHandle(token, mode);
    });
  }

  // an async iterable's iterator (Web IDL 3.7.10.1), over what the directory
  // holds as each `next()` asks: an entry added after the iteration began is
  // met if it is not passed already, and one removed is not
  const AsyncIteratorPrototype = Object.getPrototypeOf(
    Object.getPrototypeOf(async function* () {}).prototype,
  );
  const ITERATORS = new WeakMap<object, Any>();
  const DirectoryIteratorPrototype = Object.create(AsyncIteratorPrototype);
  const nextOf = (it: Any): Promise<Any> => {
    if (it.done) return Promise_.resolve({ value: undefined, done: true });
    return settle(() => {
      const listed: [string, 'file' | 'directory'][] = JSONparse(
        String(opfs('list', pathText(it.path))),
      );
      for (const [name, kind] of listed) {
        if (it.seen.has(name)) continue;
        it.seen.add(name);
        const handle = handleOf(kind, [...it.path, name]);
        const value =
          it.kind === 'keys'
            ? name
            : it.kind === 'values'
              ? handle
              : [name, handle];
        return { value, done: false };
      }
      it.done = true;
      return { value: undefined, done: true };
    }).catch((error: Any) => {
      it.done = true;
      throw error;
    });
  };
  defineProperty(DirectoryIteratorPrototype, 'next', {
    value: function next(this: Any): Promise<Any> {
      const it = ITERATORS.get(this);
      if (!it) {
        return rejected(
          typeError(
            "Failed to execute 'next' on 'FileSystemDirectoryHandle AsyncIterator': Illegal invocation",
          ),
        );
      }
      // one at a time, each after the last settled (3.7.10.2)
      const ongoing = it.ongoing
        ? it.ongoing.then(
            () => nextOf(it),
            () => nextOf(it),
          )
        : nextOf(it);
      it.ongoing = ongoing;
      return ongoing;
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });
  defineProperty(DirectoryIteratorPrototype, 'return', {
    value: function (this: Any, value: Any = undefined): Promise<Any> {
      const it = ITERATORS.get(this);
      if (it) it.done = true;
      return Promise_.resolve({ value, done: true });
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });
  defineProperty(DirectoryIteratorPrototype.return, 'name', {
    value: 'return',
  });
  defineProperty(DirectoryIteratorPrototype, Symbol.toStringTag, {
    value: 'FileSystemDirectoryHandle AsyncIterator',
    configurable: true,
  });
  const iterate = (self: Any, kind: string, method: string): Any => {
    const slot = slotOf(self, 'FileSystemDirectoryHandle', method);
    const it = Object.create(DirectoryIteratorPrototype);
    ITERATORS.set(it, {
      path: slot.path.slice(),
      kind,
      seen: new Set<string>(),
      done: false,
      ongoing: null,
    });
    return it;
  };

  const getEntry = (
    self: Any,
    count: number,
    name: Any,
    options: Any,
    kind: 'file' | 'directory',
    method: string,
  ): Promise<Any> =>
    settle(() => {
      const slot = slotOf(self, 'FileSystemDirectoryHandle', method);
      if (count < 1) {
        throw argumentsRequired(method, 'FileSystemDirectoryHandle', 1, 0);
      }
      const n = usv(name);
      const o = dictionary(options, method, 'FileSystemDirectoryHandle');
      checkName(n, method, 'FileSystemDirectoryHandle');
      opfs('get', pathText(slot.path), n, o.create ? `${kind}+` : kind);
      return handleOf(kind, [...slot.path, n]);
    });

  class FileSystemDirectoryHandle extends FileSystemHandle {
    entries(): Any {
      return iterate(this, 'entries', 'entries');
    }
    keys(): Any {
      return iterate(this, 'keys', 'keys');
    }
    values(): Any {
      return iterate(this, 'values', 'values');
    }
    getFileHandle(
      name: Any = undefined,
      options: Any = undefined,
    ): Promise<Any> {
      return getEntry(
        this,
        arguments.length,
        name,
        options,
        'file',
        'getFileHandle',
      );
    }
    getDirectoryHandle(
      name: Any = undefined,
      options: Any = undefined,
    ): Promise<Any> {
      return getEntry(
        this,
        arguments.length,
        name,
        options,
        'directory',
        'getDirectoryHandle',
      );
    }
    removeEntry(
      name: Any = undefined,
      options: Any = undefined,
    ): Promise<undefined> {
      return settle(() => {
        const slot = slotOf(this, 'FileSystemDirectoryHandle', 'removeEntry');
        if (arguments.length < 1) {
          throw argumentsRequired(
            'removeEntry',
            'FileSystemDirectoryHandle',
            1,
            0,
          );
        }
        const n = usv(name);
        const o = dictionary(
          options,
          'removeEntry',
          'FileSystemDirectoryHandle',
        );
        checkName(n, 'removeEntry', 'FileSystemDirectoryHandle');
        opfs(
          'remove',
          pathText(slot.path),
          n,
          o.recursive ? 'recursive,' : ',',
        );
        return undefined;
      });
    }
    resolve(possibleDescendant: Any = undefined): Promise<Any> {
      return settle(() => {
        const slot = slotOf(this, 'FileSystemDirectoryHandle', 'resolve');
        if (arguments.length < 1) {
          throw argumentsRequired('resolve', 'FileSystemDirectoryHandle', 1, 0);
        }
        const them = SLOTS.get(possibleDescendant);
        if (!them) {
          throw failedToExecute(
            'resolve',
            'FileSystemDirectoryHandle',
            "parameter 1 is not of type 'FileSystemHandle'.",
          );
        }
        const mine = slot.path;
        if (them.path.length < mine.length) return null;
        for (let i = 0; i < mine.length; i++) {
          if (them.path[i] !== mine[i]) return null;
        }
        if (them.path.length === mine.length && them.kind !== 'directory') {
          return null;
        }
        return them.path.slice(mine.length);
      });
    }
  }
  defineProperty(FileSystemDirectoryHandle.prototype, Symbol.asyncIterator, {
    value: FileSystemDirectoryHandle.prototype.entries,
    writable: true,
    configurable: true,
  });

  // --- the writable stream -------------------------------------------------------

  const WRITABLES = new WeakMap<object, Any>();
  class FileSystemWritableFileStream extends WritableStream {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegal();
      super(S.INTERNAL);
    }
    /** The lock it holds, as it was asked for (Chrome's). */
    get mode(): string {
      const state = WRITABLES.get(this);
      if (!state) {
        throw failedToExecute(
          'mode',
          'FileSystemWritableFileStream',
          'Illegal invocation',
        );
      }
      return state.mode;
    }
    write(data: Any = undefined): Promise<undefined> {
      if (!WRITABLES.has(this)) {
        return rejected(
          failedToExecute(
            'write',
            'FileSystemWritableFileStream',
            'Illegal invocation',
          ),
        );
      }
      if (arguments.length < 1) {
        return rejected(
          argumentsRequired('write', 'FileSystemWritableFileStream', 1, 0),
        );
      }
      return throughWriter(this, data);
    }
    seek(position: Any = undefined): Promise<undefined> {
      if (!WRITABLES.has(this)) {
        return rejected(
          failedToExecute(
            'seek',
            'FileSystemWritableFileStream',
            'Illegal invocation',
          ),
        );
      }
      if (arguments.length < 1) {
        return rejected(
          argumentsRequired('seek', 'FileSystemWritableFileStream', 1, 0),
        );
      }
      return throughWriter(this, {
        type: 'seek',
        position: unsignedLongLong(position),
      });
    }
    truncate(size: Any = undefined): Promise<undefined> {
      if (!WRITABLES.has(this)) {
        return rejected(
          failedToExecute(
            'truncate',
            'FileSystemWritableFileStream',
            'Illegal invocation',
          ),
        );
      }
      if (arguments.length < 1) {
        return rejected(
          argumentsRequired('truncate', 'FileSystemWritableFileStream', 1, 0),
        );
      }
      return throughWriter(this, {
        type: 'truncate',
        size: unsignedLongLong(size),
      });
    }
  }
  /** A chunk written through a writer of the stream's own, let go at once,
   *  as the stream's `write()` has it (File System, 2.5.2). */
  const throughWriter = (stream: Any, chunk: Any): Promise<Any> => {
    let writer: Any;
    try {
      writer = reflectApply(getWriter, stream, []);
    } catch (error) {
      return rejected(error);
    }
    const result = reflectApply(writerWrite, writer, [chunk]) as Promise<Any>;
    reflectApply(writerRelease, writer, []);
    return result;
  };

  /** A chunk's bytes: a string as UTF-8, a buffer's copied, a blob's read. */
  const chunkBytes = (data: Any): Uint8Array => {
    if (D.isBlob(data)) return D.blobBytes(data).slice();
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (
      typeof SharedArrayBuffer === 'function' &&
      data instanceof SharedArrayBuffer
    ) {
      return new Uint8Array(data).slice();
    }
    if (isView(data)) {
      return new Uint8Array(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      ).slice();
    }
    return D.utf8(usv(data));
  };
  const isBufferOrBlob = (data: Any): boolean =>
    D.isBlob(data) ||
    data instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer === 'function' &&
      data instanceof SharedArrayBuffer) ||
    isView(data);

  const makeWritable = (token: string, mode: string): Any => {
    const stream = new FileSystemWritableFileStream(TOKEN);
    const state = { token, mode, offset: 0, open: true };
    WRITABLES.set(stream, state);
    const letGo = (): void => {
      if (!state.open) return;
      state.open = false;
      try {
        opfs('wabort', token);
      } catch {}
    };
    /** One chunk, as "write a chunk" has it (File System, 2.5.1). */
    const writeChunk = (chunk: Any): void => {
      const isParams =
        !isBufferOrBlob(chunk) &&
        (chunk === null ||
          chunk === undefined ||
          typeof chunk === 'object' ||
          typeof chunk === 'function');
      if (!isParams) {
        const bytes = chunkBytes(chunk);
        opfs('wwrite', token, state.offset, D.base64OfBytes(bytes));
        state.offset += bytes.length;
        return;
      }
      // a `WriteParams` dictionary, `type` required
      const p = chunk ?? {};
      const typeValue = p.type;
      if (typeValue === undefined) {
        throw typeError(
          "Failed to execute 'write' on 'UnderlyingSinkBase': Failed to read the 'type' property from 'WriteParams': Required member is undefined.",
        );
      }
      const type = `${typeValue}`;
      if (!['write', 'seek', 'truncate'].includes(type)) {
        throw typeError(
          `Failed to execute 'write' on 'UnderlyingSinkBase': Failed to read the 'type' property from 'WriteParams': The provided value '${type}' is not a valid enum value of type WriteCommandType.`,
        );
      }
      if (type === 'write') {
        const data = p.data;
        if (data === undefined) {
          throw dom('SyntaxError', 'write requires a data argument');
        }
        if (data === null) {
          throw typeError(
            "Failed to execute 'write' on 'UnderlyingSinkBase': Cannot write null data.",
          );
        }
        if (p.position !== undefined && p.position !== null) {
          state.offset = unsignedLongLong(p.position);
        }
        const bytes = chunkBytes(data);
        opfs('wwrite', token, state.offset, D.base64OfBytes(bytes));
        state.offset += bytes.length;
      } else if (type === 'seek') {
        if (p.position === undefined || p.position === null) {
          throw dom('SyntaxError', 'seek requires a position argument');
        }
        state.offset = unsignedLongLong(p.position);
      } else {
        if (p.size === undefined || p.size === null) {
          throw dom('SyntaxError', 'truncate requires a size argument');
        }
        const size = unsignedLongLong(p.size);
        opfs('wtruncate', token, size);
        if (state.offset > size) state.offset = size;
      }
    };
    S.writable(
      () => undefined,
      (chunk: Any) => {
        try {
          writeChunk(chunk);
          return Promise_.resolve(undefined);
        } catch (error) {
          // an errored stream keeps nothing and holds no lock
          letGo();
          return Promise_.reject(error);
        }
      },
      () => {
        if (!state.open) return Promise_.resolve(undefined);
        state.open = false;
        return settle(() => {
          opfs('wclose', token);
          return undefined;
        });
      },
      () => {
        letGo();
        return Promise_.resolve(undefined);
      },
      1,
      () => 1,
      stream,
    );
    return stream;
  };

  // --- the sync access handle ---------------------------------------------------

  const ACCESS = new WeakMap<object, Any>();
  /** A buffer's bytes in place, which a read writes into. */
  const viewOf = (buffer: Any, method: string): Uint8Array => {
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
    if (
      typeof SharedArrayBuffer === 'function' &&
      buffer instanceof SharedArrayBuffer
    ) {
      return new Uint8Array(buffer);
    }
    if (isView(buffer)) {
      return new Uint8Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      );
    }
    throw failedToExecute(
      method,
      'FileSystemSyncAccessHandle',
      "parameter 1 is not of type '(ArrayBuffer or ArrayBufferView or SharedArrayBuffer)'.",
    );
  };
  const accessOf = (self: Any, method: string): Any => {
    const a = ACCESS.get(self);
    if (!a) {
      throw failedToExecute(
        method,
        'FileSystemSyncAccessHandle',
        'Illegal invocation',
      );
    }
    return a;
  };
  const openOf = (a: Any): void => {
    if (a.closed) {
      throw dom('InvalidStateError', 'The access handle was already closed');
    }
  };
  const writableOf = (a: Any): void => {
    if (a.mode === 'read-only') {
      throw dom(
        'NoModificationAllowedError',
        'Cannot write to access handle in read-only mode',
      );
    }
  };
  const atOf = (options: Any, method: string): number | undefined => {
    const o = dictionary(options, method, 'FileSystemSyncAccessHandle');
    return o.at === undefined
      ? undefined
      : enforceRange(o.at, method, 'FileSystemSyncAccessHandle');
  };
  class FileSystemSyncAccessHandle {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegal();
    }
    get mode(): string {
      return accessOf(this, 'mode').mode;
    }
    read(buffer: Any = undefined, options: Any = undefined): number {
      const a = accessOf(this, 'read');
      if (arguments.length < 1) {
        throw argumentsRequired('read', 'FileSystemSyncAccessHandle', 1, 0);
      }
      const view = viewOf(buffer, 'read');
      const at = atOf(options, 'read');
      openOf(a);
      const start = at ?? a.cursor;
      const bytes = D.bytesOfBase64(
        String(opfs('sread', a.token, start, view.length)),
      );
      view.set(bytes);
      a.cursor = start + bytes.length;
      return bytes.length;
    }
    write(buffer: Any = undefined, options: Any = undefined): number {
      const a = accessOf(this, 'write');
      if (arguments.length < 1) {
        throw argumentsRequired('write', 'FileSystemSyncAccessHandle', 1, 0);
      }
      const view = viewOf(buffer, 'write');
      const at = atOf(options, 'write');
      openOf(a);
      writableOf(a);
      const start = at ?? a.cursor;
      const written = Number(
        opfs('swrite', a.token, start, D.base64OfBytes(view)),
      );
      a.cursor = start + written;
      return written;
    }
    truncate(newSize: Any = undefined): undefined {
      const a = accessOf(this, 'truncate');
      if (arguments.length < 1) {
        throw argumentsRequired('truncate', 'FileSystemSyncAccessHandle', 1, 0);
      }
      const size = enforceRange(
        newSize,
        'truncate',
        'FileSystemSyncAccessHandle',
      );
      openOf(a);
      writableOf(a);
      opfs('struncate', a.token, size);
      if (a.cursor > size) a.cursor = size;
      return undefined;
    }
    getSize(): number {
      const a = accessOf(this, 'getSize');
      openOf(a);
      return Number(opfs('ssize', a.token));
    }
    flush(): undefined {
      const a = accessOf(this, 'flush');
      openOf(a);
      writableOf(a);
      return undefined;
    }
    close(): undefined {
      const a = accessOf(this, 'close');
      if (a.closed) return undefined;
      a.closed = true;
      opfs('sclose', a.token);
      return undefined;
    }
  }
  const makeAccessHandle = (token: string, mode: string): Any => {
    const handle = new FileSystemSyncAccessHandle(TOKEN);
    ACCESS.set(handle, { token, mode, cursor: 0, closed: false });
    return handle;
  };

  // --- StorageManager ---------------------------------------------------------------

  /** Whether the origin is opaque, which has no storage at all. */
  const opaque = (): boolean => opfs('opaque') === true;
  const QUOTA = 10 * 1024 ** 3;
  class StorageManager {
    constructor(token: Any = undefined) {
      if (token !== TOKEN) throw illegal();
    }
    persisted(): Promise<boolean> {
      return settle(() => {
        checkManager(this, 'persisted');
        return false;
      });
    }
    persist(): Promise<boolean> {
      return settle(() => {
        checkManager(this, 'persist');
        return false;
      });
    }
    estimate(): Promise<Any> {
      return settle(() => {
        checkManager(this, 'estimate');
        const fileSystem = Number(opfs('usage')) || 0;
        const indexedDB = D.idbUsage();
        const caches = Number(call('cacheUsage')) || 0;
        const usageDetails: Any = {};
        if (fileSystem) usageDetails.fileSystem = fileSystem;
        if (indexedDB) usageDetails.indexedDB = indexedDB;
        if (caches) usageDetails.caches = caches;
        return {
          quota: QUOTA,
          usage: fileSystem + indexedDB + caches,
          usageDetails,
        };
      });
    }
    getDirectory(): Promise<Any> {
      return settle(() => {
        if (!MANAGERS.has(this)) {
          throw failedToExecute(
            'getDirectory',
            'StorageManager',
            'Illegal invocation',
          );
        }
        if (opaque()) {
          throw dom('SecurityError', 'Storage directory access is denied.');
        }
        return handleOf('directory', []);
      });
    }
  }
  const MANAGERS = new WeakSet<object>();
  const checkManager = (self: Any, method: string): void => {
    if (!MANAGERS.has(self)) {
      throw failedToExecute(method, 'StorageManager', 'Illegal invocation');
    }
    // an opaque origin has no storage key, and every method rejects
    // (Storage, 6: "obtain a storage key" fails)
    if (opaque()) {
      throw typeError(
        `Failed to execute '${method}' on 'StorageManager': Access is denied.`,
      );
    }
  };
  let manager: Any = null;

  // Web IDL's shape: an attribute an accessor, every member enumerable, and
  // the interfaces' names and lengths as their bindings have them
  const webIdl = (Kind: Any): void => {
    const proto = Kind.prototype;
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor' || key.startsWith('_')) continue;
      const d = Object.getOwnPropertyDescriptor(proto, key)!;
      defineProperty(proto, key, { ...d, enumerable: true });
    }
    defineProperty(proto, Symbol.toStringTag, {
      value: Kind.name,
      configurable: true,
    });
    defineProperty(Kind, 'length', { value: 0 });
  };
  const lengths: [Any, string, number][] = [
    [FileSystemHandle, 'isSameEntry', 1],
    [FileSystemHandle, 'move', 1],
    [FileSystemDirectoryHandle, 'getFileHandle', 1],
    [FileSystemDirectoryHandle, 'getDirectoryHandle', 1],
    [FileSystemDirectoryHandle, 'removeEntry', 1],
    [FileSystemDirectoryHandle, 'resolve', 1],
    [FileSystemWritableFileStream, 'write', 1],
    [FileSystemWritableFileStream, 'seek', 1],
    [FileSystemWritableFileStream, 'truncate', 1],
    [FileSystemSyncAccessHandle, 'read', 1],
    [FileSystemSyncAccessHandle, 'write', 1],
    [FileSystemSyncAccessHandle, 'truncate', 1],
  ];
  for (const [Kind, key, length] of lengths) {
    defineProperty(Kind.prototype[key], 'length', { value: length });
  }
  for (const Kind of [
    FileSystemHandle,
    FileSystemFileHandle,
    FileSystemDirectoryHandle,
    FileSystemWritableFileStream,
    FileSystemSyncAccessHandle,
    StorageManager,
  ]) {
    webIdl(Kind);
  }

  return {
    interfaces: {
      StorageManager,
      FileSystemHandle,
      FileSystemFileHandle,
      FileSystemDirectoryHandle,
      FileSystemWritableFileStream,
    },
    storage() {
      if (!manager) {
        manager = new StorageManager(TOKEN);
        MANAGERS.add(manager);
      }
      return manager;
    },
    dedicatedWorker() {
      defineProperty(FileSystemFileHandle.prototype, 'createSyncAccessHandle', {
        value: createSyncAccessHandle,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return { FileSystemSyncAccessHandle };
    },
    worker() {
      delete (StorageManager.prototype as Any).persist;
    },
    handles: {
      is: (value) => SLOTS.has(value as object) || foreignData(value) !== null,
      // a handle names its origin's file system, and no other origin's
      // realm can make one of it (File System, 2.2: a handle's storage key)
      data: (value) => {
        const d = slotData(value as object) ?? foreignData(value)!;
        return { ...d, o: String(opfs('origin')) };
      },
      from: (data) => {
        const here = String(opfs('origin'));
        if (here === 'null' || data.o !== here) {
          throw dom(
            'DataCloneError',
            'A FileSystemHandle cannot be received outside its origin.',
          );
        }
        return handleOf(
          data.k === 'file' ? 'file' : 'directory',
          data.p.map(String),
        );
      },
    },
  };
}
