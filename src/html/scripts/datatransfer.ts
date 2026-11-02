// HTML's drag data store as a page's scripts see it (6.11.3): `DataTransfer`,
// `DataTransferItemList` and `DataTransferItem`, and the events that carry
// one.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the engine
// hands it to the context through `Function.prototype.toString()`, so it
// closes over nothing, and `installDom` is handed it and calls it with what
// it needs of the DOM.
//
// A store is made by the page (`new DataTransfer()`, read/write for as long as
// it holds it) or by the user agent for one event, and that second kind has a
// mode that moves: a `copy` is read/write while it is dispatched, a `paste`
// read-only, and every one is protected from the moment its event is over,
// which is what stops a page keeping a `DataTransfer` to read what was pasted
// after the paste. Nothing of a store is a field of the object: a page reaches
// it only through what the interfaces answer, as the mode has them.

/** What `installDom` hands this. */
export interface DataTransferDeps {
  DOMException: unknown;
  Event: unknown;
  MouseEvent: unknown;
  File: unknown;
  FileList: unknown;
  /** A list of `Proto`'s holding what `read` answers now
   *  (`listMade`). */
  listOf(Proto: unknown, read: () => unknown[]): unknown;
  /** An interface's attributes as Web IDL has them. */
  idlAttributes(Interface: unknown): void;
  /** Run in a task of its own, with the page's own errors reported. */
  task(fn: () => void): void;
}

/** One entry of a drag data store. */
export interface StoreEntry {
  kind: 'text' | 'file';
  type: string;
  /** The text of a text entry, the `File` of a file entry. */
  data: unknown;
}

/** What `installDom` has of this. */
export interface DataTransferInternals {
  /** The interfaces a window exposes, by name. */
  interfaces: Record<string, unknown>;
  /** A store of the user agent's for an event. */
  made(mode: string, entries?: StoreEntry[]): unknown;
  /** Move a store to a mode: its event is over, say. */
  setMode(transfer: unknown, mode: string): void;
  /** What a store holds, whatever its mode. */
  entriesOf(transfer: unknown): StoreEntry[];
  /** Set what a drag allows and what is to happen, as the user agent does. */
  setEffects(transfer: unknown, allowed: string, effect: string): void;
  /** What a page left of them. */
  effectsOf(transfer: unknown): { allowed: string; effect: string };
}

export function installDataTransfer(
  deps: DataTransferDeps,
): DataTransferInternals {
  'use strict';
  type Any = any;
  const D: Any = deps;
  const DOMException: Any = D.DOMException;
  const Event: Any = D.Event;
  const MouseEvent: Any = D.MouseEvent;
  const File: Any = D.File;
  const FileList: Any = D.FileList;
  const listOf: Any = D.listOf;
  const idlAttributes: Any = D.idlAttributes;
  const task: Any = D.task;

  // What is taken before any page code runs.
  const apply: Any = Reflect.apply;
  const freeze: Any = Object.freeze;
  const WM: Any = WeakMap.prototype;
  const wmGet: Any = WM.get;
  const wmSet: Any = WM.set;
  const lower: Any = String.prototype.toLowerCase;
  const split: Any = String.prototype.split;
  const trim: Any = String.prototype.trim;
  const startsWith: Any = String.prototype.startsWith;

  const slots: Any = new WeakMap();
  const state = (self: Any): Any => {
    const s = apply(wmGet, slots, [self]);
    if (!s) throw new TypeError('Illegal invocation');
    return s;
  };
  const made = (self: Any, s: Any): Any => {
    apply(wmSet, slots, [self, s]);
    return self;
  };

  /** A name as HTML compares them (6.11.3.5, "ASCII lowercase"), with the
   *  two legacy names read as the types they stand for. */
  const formatOf = (format: Any): string => {
    const name = apply(trim, apply(lower, `${format}`, []), []);
    return name === 'text'
      ? 'text/plain'
      : name === 'url'
        ? 'text/uri-list'
        : name;
  };
  /** `getData('url')` is the first URL of a list: a line that is no comment
   *  (RFC 2483). */
  const firstUrl = (list: string): string => {
    for (const line of apply(split, list, ['\n'])) {
      const url = apply(trim, line, []);
      if (url && !apply(startsWith, url, ['#'])) return url;
    }
    return '';
  };
  const textEntry = (store: Any, type: string): Any => {
    for (const entry of store.entries) {
      if (entry.kind === 'text' && entry.type === type) return entry;
    }
    return undefined;
  };
  const without = (store: Any, drop: (entry: Any) => boolean): void => {
    const kept: Any[] = [];
    for (const entry of store.entries) {
      if (!drop(entry)) kept[kept.length] = entry;
    }
    if (kept.length === store.entries.length) return;
    store.entries = kept;
    store.generation += 1;
  };
  const added = (store: Any, entry: StoreEntry): void => {
    const next: Any[] = [];
    for (const held of store.entries) next[next.length] = held;
    next[next.length] = entry;
    store.entries = next;
    store.generation += 1;
  };

  /** The item a list hands out for an entry, the same one each time. */
  const itemOf = (store: Any, entry: Any): Any => {
    let item = apply(wmGet, store.items, [entry]);
    if (!item) {
      item = new DataTransferItem(ITEM);
      made(item, { store, entry });
      apply(wmSet, store.items, [entry, item]);
    }
    return item;
  };

  const ITEM = {};
  /** What a store's entry is to a page, as long as it is in the store and
   *  the store may be read (6.11.3.3). */
  class DataTransferItem {
    constructor(key?: Any) {
      if (key !== ITEM) throw new TypeError('Illegal constructor');
    }
    get kind(): string {
      const s = state(this);
      if (s.store.mode === 'disabled' || !s.store.entries.includes(s.entry)) {
        return '';
      }
      return s.entry.kind === 'text' ? 'string' : 'file';
    }
    get type(): string {
      const s = state(this);
      return s.store.mode === 'disabled' || !s.store.entries.includes(s.entry)
        ? ''
        : s.entry.type;
    }
    getAsString(callback: Any): void {
      if (callback === null || callback === undefined) return;
      const s = state(this);
      if (s.store.mode === 'protected' || s.store.mode === 'disabled') return;
      if (s.entry.kind !== 'text' || !s.store.entries.includes(s.entry)) return;
      const text = s.entry.data;
      task(() => {
        apply(callback, undefined, [text]);
      });
    }
    getAsFile(): Any {
      const s = state(this);
      if (s.store.mode === 'protected' || s.store.mode === 'disabled') {
        return null;
      }
      if (!s.store.entries.includes(s.entry)) return null;
      return s.entry.kind === 'file' ? s.entry.data : null;
    }
    /** A dropped file as an entry of the file system it is in (Entries API,
     *  4.1): all a page that takes dropped folders asks of a file. A folder
     *  is no entry here: what is dropped of one is the files in it. */
    webkitGetAsEntry(): Any {
      const s = state(this);
      if (s.store.mode === 'disabled' || s.store.mode === 'protected') {
        return null;
      }
      if (s.entry.kind !== 'file' || !s.entry.data) return null;
      return made(new FileSystemFileEntry(ENTRY), { file: s.entry.data });
    }
  }
  idlAttributes(DataTransferItem);

  const ENTRY = {};
  /** A file of those dropped (Entries API, 6). */
  class FileSystemFileEntry {
    constructor(key?: Any) {
      if (key !== ENTRY) throw new TypeError('Illegal constructor');
    }
    get isFile(): boolean {
      return true;
    }
    get isDirectory(): boolean {
      return false;
    }
    get name(): string {
      return state(this).file.name;
    }
    get fullPath(): string {
      return `/${state(this).file.name}`;
    }
    get filesystem(): Any {
      return null;
    }
    file(success: Any): void {
      const { file } = state(this);
      task(() => {
        apply(success, undefined, [file]);
      });
    }
  }
  idlAttributes(FileSystemFileEntry);

  const LIST = {};
  /** A store's entries (6.11.3.2), as a list a page reads by index. */
  class DataTransferItemList {
    constructor(key?: Any) {
      if (key !== LIST) throw new TypeError('Illegal constructor');
    }
    get length(): number {
      return reachable(state(this).store).length;
    }
    add(data: Any, type?: Any): Any {
      const { store } = state(this);
      if (store.mode !== 'read/write') return null;
      if (data instanceof File) {
        const entry = {
          kind: 'file',
          type: apply(lower, data.type, []),
          data,
        };
        added(store, entry as StoreEntry);
        return itemOf(store, entry);
      }
      if (arguments.length < 2) {
        throw new TypeError(
          "Failed to execute 'add' on 'DataTransferItemList': parameter 1 is not of type 'File'.",
        );
      }
      const name = apply(lower, `${type}`, []);
      if (textEntry(store, name)) {
        throw new DOMException(
          `An item already exists for type '${name}'.`,
          'NotSupportedError',
        );
      }
      const entry = { kind: 'text', type: name, data: `${data}` };
      added(store, entry as StoreEntry);
      return itemOf(store, entry);
    }
    remove(index: Any): void {
      const { store } = state(this);
      if (store.mode !== 'read/write') {
        throw new DOMException(
          'The list is not in read/write mode.',
          'InvalidStateError',
        );
      }
      const entry = store.entries[Number(index) >>> 0];
      if (entry) without(store, (held) => held === entry);
    }
    clear(): void {
      const { store } = state(this);
      if (store.mode !== 'read/write') return;
      without(store, () => true);
    }
  }
  idlAttributes(DataTransferItemList);

  /** The entries a page can see: none of a store that is disabled. */
  const reachable = (store: Any): Any[] =>
    store.mode === 'disabled' ? [] : store.entries;

  const newStore = (mode: string, entries: StoreEntry[]): Any => ({
    mode,
    entries,
    generation: 0,
    items: new WeakMap(),
  });

  /** The ways a store's owner may mean to use a drop (6.11.3.1). */
  const DROP_EFFECTS = ['none', 'copy', 'link', 'move'];
  const ALLOWED_EFFECTS = [
    'none',
    'copy',
    'copyLink',
    'copyMove',
    'link',
    'linkMove',
    'move',
    'all',
    'uninitialized',
  ];

  class DataTransfer {
    constructor() {
      setUp(this, newStore('read/write', []));
    }
    get dropEffect(): string {
      return state(this).dropEffect;
    }
    set dropEffect(value: Any) {
      const name = `${value}`;
      if (DROP_EFFECTS.includes(name)) state(this).dropEffect = name;
    }
    get effectAllowed(): string {
      return state(this).effectAllowed;
    }
    set effectAllowed(value: Any) {
      const name = `${value}`;
      if (ALLOWED_EFFECTS.includes(name)) state(this).effectAllowed = name;
    }
    get items(): Any {
      return state(this).list;
    }
    get types(): Any {
      const s = state(this);
      const { store } = s;
      if (s.typesAt === store.generation && s.typesMode === store.mode) {
        return s.types;
      }
      const out: string[] = [];
      let files = false;
      for (const entry of reachable(store)) {
        if (entry.kind === 'file') files = true;
        else if (!out.includes(entry.type)) out[out.length] = entry.type;
      }
      if (files) out[out.length] = 'Files';
      s.types = freeze(out);
      s.typesAt = store.generation;
      s.typesMode = store.mode;
      return s.types;
    }
    get files(): Any {
      return state(this).files;
    }
    getData(format: Any): string {
      const { store } = state(this);
      if (store.mode === 'protected' || store.mode === 'disabled') return '';
      const named = apply(trim, apply(lower, `${format}`, []), []);
      const entry = textEntry(store, formatOf(named));
      if (!entry) return '';
      return named === 'url' ? firstUrl(entry.data) : entry.data;
    }
    setData(format: Any, data: Any): void {
      const { store } = state(this);
      if (store.mode !== 'read/write') return;
      const type = formatOf(format);
      without(store, (entry) => entry.kind === 'text' && entry.type === type);
      added(store, { kind: 'text', type, data: `${data}` });
    }
    clearData(format?: Any): void {
      const { store } = state(this);
      if (store.mode !== 'read/write') return;
      if (format === undefined) {
        without(store, (entry) => entry.kind === 'text');
        return;
      }
      const type = formatOf(format);
      without(store, (entry) => entry.kind === 'text' && entry.type === type);
    }
    setDragImage(image: Any, x: Any, y: Any): void {
      const s = state(this);
      if (s.store.mode !== 'read/write') return;
      s.image = { image, x: Number(x) || 0, y: Number(y) || 0 };
    }
  }
  idlAttributes(DataTransfer);

  /** A `DataTransfer` over a store. Its `files` hold what the store holds
   *  now, so a list a page kept follows `items`, and hold nothing where the
   *  store is protected (6.11.3, `files`). */
  const setUp = (self: Any, store: Any): Any =>
    made(self, {
      store,
      dropEffect: 'none',
      effectAllowed: 'none',
      image: null,
      types: null,
      typesAt: -1,
      typesMode: '',
      list: made(
        listOf(DataTransferItemList, () => itemsIn(store)),
        { store },
      ),
      files: listOf(FileList, () => filesIn(store)),
    });
  const itemsIn = (store: Any): Any[] => {
    const out: Any[] = [];
    for (const entry of reachable(store)) {
      out[out.length] = itemOf(store, entry);
    }
    return out;
  };
  const filesIn = (store: Any): Any[] => {
    const out: Any[] = [];
    if (store.mode === 'protected') return out;
    for (const entry of reachable(store)) {
      if (entry.kind === 'file') out[out.length] = entry.data;
    }
    return out;
  };

  /** Copying, cutting or pasting (Clipboard API and events, 5.1). */
  class ClipboardEvent extends Event {
    constructor(type: Any, init: Any = {}) {
      super(type, init);
      if (init?.clipboardData !== undefined && init.clipboardData !== null) {
        state(init.clipboardData);
      }
      made(this, { clipboardData: init?.clipboardData ?? null });
    }
    get clipboardData(): Any {
      return state(this).clipboardData;
    }
  }
  idlAttributes(ClipboardEvent);

  /** A drag's events (HTML 6.11.2). */
  class DragEvent extends MouseEvent {
    constructor(type: Any, init: Any = {}) {
      super(type, init);
      if (init?.dataTransfer !== undefined && init.dataTransfer !== null) {
        state(init.dataTransfer);
      }
      made(this, { dataTransfer: init?.dataTransfer ?? null });
    }
    get dataTransfer(): Any {
      return state(this).dataTransfer;
    }
  }
  idlAttributes(DragEvent);

  const interfaces: Record<string, Any> = {
    DataTransfer,
    DataTransferItem,
    DataTransferItemList,
    ClipboardEvent,
    DragEvent,
    FileSystemFileEntry,
  };
  for (const name of Object.getOwnPropertyNames(interfaces)) {
    Object.defineProperty(interfaces[name].prototype, Symbol.toStringTag, {
      value: name,
      configurable: true,
    });
  }

  return {
    interfaces,
    made: (mode, entries = []) =>
      setUp(Object.create(DataTransfer.prototype), newStore(mode, entries)),
    setMode: (transfer, mode) => {
      const { store } = state(transfer);
      store.mode = mode;
    },
    entriesOf: (transfer) => state(transfer).store.entries,
    setEffects: (transfer, allowed, effect) => {
      const s = state(transfer);
      s.effectAllowed = allowed;
      s.dropEffect = effect;
    },
    effectsOf: (transfer) => {
      const s = state(transfer);
      return { allowed: s.effectAllowed, effect: s.dropEffect };
    },
  };
}
