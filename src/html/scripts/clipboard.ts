// The Async Clipboard API as a page's scripts see it: `navigator.clipboard`,
// `Clipboard` and `ClipboardItem` (Clipboard API and events, 7).
//
// **This function is source text**, as `installDom` is (`dom.ts`).
//
// What a page asks goes to the host's `scripts.clipboard` through the
// `clipboard` op and is told back through `__clipboard`, as text: bytes are
// base64, and nothing but a string crosses. What a page holds — the promises,
// the items, the blobs, every rejection — is made here, of the page's own
// classes. `navigator.clipboard` is there only in a secure context whose host
// handed a clipboard: `in` is how a page asks, and one that finds it takes it
// for one it can use.
//
// The gates are the realm's. A write needs a user's press or key behind it
// that is recent enough (`hasTransientActivation`), or `clipboard-write`
// granted; a read needs that and the host's word, which a browser gets by
// asking its user, since a page that reads the clipboard after any click
// reads what was copied in every other application. A frame of another origin
// has neither unless its element's `allow` names the feature.

/** What `installDom` hands this. */
export interface ClipboardDeps {
  call(op: string, a?: unknown, b?: unknown, c?: unknown): unknown;
  entry(name: string, fn: () => unknown): void;
  input(): unknown;
  DOMException: unknown;
  EventTarget: unknown;
  Blob: unknown;
  bytesOfBase64(text: string): Uint8Array;
  base64OfBytes(bytes: Uint8Array): string;
  /** Bytes as text. */
  textOf(bytes: Uint8Array): string;
  /** Whether a press or a key of the user's is behind this. */
  hasTransientActivation(): boolean;
  /** Whether the document can use a feature: no frame of another origin
   *  without an `allow` for it, and no document that has gone. */
  allowed(feature: string): boolean;
  /** Whether the document is still in its frame. */
  fullyActive(): boolean;
  /** HTML with what would run taken out, as a read hands it to a page. */
  sanitize(html: string): string;
}

/** One type of what is on the clipboard, as it crosses the bridge. */
export interface ClipboardWireEntry {
  /** Its MIME type. */
  t: string;
  /** Text. */
  s?: string;
  /** Bytes, as base64. */
  b?: string;
}

/** What `installDom` has of this. */
export interface ClipboardInternals {
  /** The interfaces a secure context's window exposes, by name. */
  interfaces: Record<string, unknown>;
  /** The realm's `navigator.clipboard`. */
  clipboard: unknown;
  /** Write what a `copy` left, or a selection: told nothing of how it went. */
  write(entries: ClipboardWireEntry[]): void;
}

export function installClipboard(deps: ClipboardDeps): ClipboardInternals {
  'use strict';
  type Any = any;
  const D: Any = deps;
  const call: Any = D.call;
  const entry: Any = D.entry;
  const input: Any = D.input;
  const DOMException: Any = D.DOMException;
  const EventTarget: Any = D.EventTarget;
  const Blob: Any = D.Blob;
  const bytesOfBase64: Any = D.bytesOfBase64;
  const base64OfBytes: Any = D.base64OfBytes;
  const textOf: Any = D.textOf;
  const hasTransientActivation: Any = D.hasTransientActivation;
  const allowed: Any = D.allowed;
  const fullyActive: Any = D.fullyActive;
  const sanitize: Any = D.sanitize;

  // What is taken before any page code runs.
  const P: Any = Promise;
  const rejected: Any = P.reject.bind(P);
  const resolved: Any = P.resolve.bind(P);
  const apply: Any = Reflect.apply;
  const freeze: Any = Object.freeze;
  const stringify: Any = JSON.stringify;
  const parse: Any = JSON.parse;
  const keysOf: Any = Object.keys;
  const isArray: Any = Array.isArray;
  const WM: Any = WeakMap.prototype;
  const wmGet: Any = WM.get;
  const wmSet: Any = WM.set;
  const then: Any = Promise.prototype.then;

  /** The types a write takes (7.2.1, "mandatory data types" and Chrome's
   *  optional ones). */
  const WRITABLE = [
    'text/plain',
    'text/html',
    'text/uri-list',
    'image/png',
    'image/svg+xml',
  ];
  /** The signature a PNG starts with. */
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const WEB = 'web ';
  /** A type's name and its parameters, or null where it is no MIME type. */
  const parseType = (text: string): string | null => {
    const m = /^\s*([^\s/;]+\/[^\s/;]+)\s*(;.*)?$/.exec(text);
    if (!m) return null;
    const [, essence, rest] = m;
    return /^[\w!#$%&'*+.^`|~-]+\/[\w!#$%&'*+.^`|~-]+$/.test(essence)
      ? `${essence.toLowerCase()}${rest ?? ''}`
      : null;
  };
  /** A key of a `ClipboardItem`: `web ` and a type, or a type. */
  const normalized = (key: string): string | null => {
    const custom = key.startsWith(WEB);
    const type = parseType(custom ? key.slice(WEB.length) : key);
    return type === null ? null : custom ? `${WEB}${type}` : type;
  };

  const slots: Any = new WeakMap();
  const state = (self: Any): Any => {
    const s = apply(wmGet, slots, [self]);
    if (!s) throw new TypeError('Illegal invocation');
    return s;
  };
  const textBlob = (text: string, type: string): Any =>
    new Blob([text], { type });

  const STYLES = ['unspecified', 'inline', 'attachment'];
  /** A thing that might be put on the clipboard, in one or more types. */
  class ClipboardItem {
    constructor(items: Any, options: Any = {}) {
      if (
        arguments.length === 0 ||
        items === null ||
        typeof items !== 'object' ||
        items instanceof Blob
      ) {
        throw new TypeError(
          "Failed to construct 'ClipboardItem': parameter 1 is not of type 'object'.",
        );
      }
      const keys = keysOf(items);
      if (!keys.length) {
        throw new TypeError(
          "Failed to construct 'ClipboardItem': At least one item is required.",
        );
      }
      const style = `${options?.presentationStyle ?? 'unspecified'}`;
      if (!STYLES.includes(style)) {
        throw new TypeError(
          `Failed to construct 'ClipboardItem': The provided value '${style}' is not a valid enum value.`,
        );
      }
      const types: string[] = [];
      const data: Any = new Map();
      for (const key of keys) {
        const type = normalized(key);
        if (type === null) {
          throw new TypeError(
            `Failed to construct 'ClipboardItem': Invalid type '${key}'.`,
          );
        }
        if (data.has(type)) {
          throw new TypeError(
            `Failed to construct 'ClipboardItem': Duplicate type '${key}'.`,
          );
        }
        types[types.length] = type;
        data.set(type, resolved(items[key]));
      }
      apply(wmSet, slots, [
        this,
        { types: freeze(types), data, presentationStyle: style },
      ]);
    }
    get presentationStyle(): string {
      return state(this).presentationStyle;
    }
    get types(): Any {
      return state(this).types;
    }
    getType(type: Any): Any {
      const s = state(this);
      return new P((resolve: Any, reject: Any) => {
        const name = normalized(`${type}`);
        if (name === null) {
          reject(new TypeError(`Invalid type '${type}'.`));
          return;
        }
        if (!s.data.has(name)) {
          reject(
            new DOMException(
              `The type '${type}' was not found`,
              'NotFoundError',
            ),
          );
          return;
        }
        apply(then, s.data.get(name), [
          (value: Any) => {
            resolve(value instanceof Blob ? value : textBlob(`${value}`, name));
          },
          reject,
        ]);
      });
    }
    static supports(type: Any): boolean {
      const name = normalized(`${type}`);
      if (name === null) return false;
      return name.startsWith(WEB)
        ? !name.includes(';')
        : WRITABLE.includes(name);
    }
  }

  /** A read or a write under way, by the number the host tells it back
   *  under. */
  const asked: Any = new Map();
  let nextAsk = 1;
  const ask = (what: string, payload?: string): Any =>
    new P((resolve: Any, reject: Any) => {
      const id = nextAsk;
      nextAsk += 1;
      asked.set(id, { resolve, reject });
      call('clipboard', what, id, payload);
    });
  entry('__clipboard', () => {
    const [id, ok, payload] = input() as Any[];
    const waiting = asked.get(id);
    if (!waiting) return false;
    asked.delete(id);
    if (ok) waiting.resolve(payload);
    else waiting.reject(notAllowed(payload));
    return true;
  });

  /** What is refused, made here. */
  const notAllowed = (message: Any): Any =>
    new DOMException(`${message}`, 'NotAllowedError');

  /** Why the document cannot reach the clipboard, or null where it can. */
  const refusal = (feature: string): string | null => {
    if (!fullyActive()) return 'The document is no longer active.';
    if (!allowed(feature)) {
      return 'The Clipboard API has been blocked because of a permissions policy applied to the current document.';
    }
    return null;
  };
  const writeRefusal = (): string | null => {
    const no = refusal('clipboard-write');
    if (no) return no;
    const state = call('permission', 'clipboard-write');
    if (state === 'granted') return null;
    return state !== 'denied' && hasTransientActivation()
      ? null
      : 'Write permission denied.';
  };

  /** What crosses for an entry's text or bytes. */
  const wireOf = async (
    type: string,
    value: Any,
  ): Promise<ClipboardWireEntry> => {
    const name = type.startsWith(WEB) ? type : type.replace(/;.*$/, '');
    if (!(value instanceof Blob)) {
      if (name === 'image/png') {
        throw new TypeError('An image cannot be written as a string.');
      }
      return { t: name, s: `${value}` };
    }
    const bytes = (value as Any)._bytes;
    if (name === 'image/png' && PNG.some((byte, i) => bytes[i] !== byte)) {
      throw new DOMException('Failed to decode the image.', 'DataError');
    }
    return name.startsWith('text/') || name === 'image/svg+xml'
      ? { t: name, s: textOf(bytes) }
      : { t: name, b: base64OfBytes(bytes) };
  };

  /** Read what the host has, as what crossed: where `clipboard-read` is
   *  still to be decided, after a press or a key, by asking. */
  const readWire = async (): Promise<ClipboardWireEntry[]> => {
    const no = refusal('clipboard-read');
    if (no) throw notAllowed(no);
    let state = call('permission', 'clipboard-read');
    if (state !== 'granted') {
      if (state === 'prompt' && hasTransientActivation()) {
        state = await ask('request', 'clipboard-read');
      }
      if (state !== 'granted') throw notAllowed('Read permission denied.');
    }
    return parse(await ask('read'));
  };

  /** Access to the clipboard (7.2). */
  class Clipboard extends EventTarget {
    constructor(key?: Any) {
      super();
      if (key !== CLIPBOARD) throw new TypeError('Illegal constructor');
    }
    read(formats?: Any): Any {
      const unsanitized = formats?.unsanitized;
      if (unsanitized !== undefined && !isArray(unsanitized)) {
        return rejected(
          new TypeError(
            "Failed to execute 'read' on 'Clipboard': The provided value cannot be converted to a sequence.",
          ),
        );
      }
      for (const type of unsanitized ?? []) {
        if (`${type}` !== 'text/html') {
          return rejected(
            new DOMException(
              `Type ${type} is not supported for unsanitized read.`,
              'NotAllowedError',
            ),
          );
        }
      }
      const raw = (unsanitized ?? []).length > 0;
      return apply(then, readWire(), [
        (wire: ClipboardWireEntry[]) => {
          const items: Any = {};
          for (const e of wire) {
            items[e.t] =
              e.b !== undefined
                ? new Blob([bytesOfBase64(e.b)], { type: e.t })
                : textBlob(
                    e.t === 'text/html' && !raw
                      ? sanitize(e.s ?? '')
                      : (e.s ?? ''),
                    e.t,
                  );
          }
          return keysOf(items).length ? [new ClipboardItem(items)] : [];
        },
      ]);
    }
    readText(): Any {
      return apply(then, readWire(), [
        (wire: ClipboardWireEntry[]) => {
          for (const e of wire) {
            if (e.t === 'text/plain') return e.s ?? '';
          }
          return '';
        },
      ]);
    }
    write(data: Any): Any {
      if (arguments.length === 0) {
        return rejected(
          new TypeError(
            "Failed to execute 'write' on 'Clipboard': 1 argument required, but only 0 present.",
          ),
        );
      }
      if (!isArray(data)) {
        return rejected(
          new TypeError(
            "Failed to execute 'write' on 'Clipboard': The provided value cannot be converted to a sequence.",
          ),
        );
      }
      for (const item of data) {
        if (!apply(wmGet, slots, [item])) {
          return rejected(
            new TypeError(
              "Failed to execute 'write' on 'Clipboard': Failed to convert value to 'ClipboardItem'.",
            ),
          );
        }
      }
      const no = writeRefusal();
      if (no) return rejected(notAllowed(no));
      if (data.length > 1) {
        return rejected(
          notAllowed('Support for multiple ClipboardItems is not implemented.'),
        );
      }
      if (!data.length) return resolved(undefined);
      return (async () => {
        const s = state(data[0]);
        const out: ClipboardWireEntry[] = [];
        for (const type of s.types) {
          if (
            !type.startsWith(WEB) &&
            !WRITABLE.includes(type.replace(/;.*$/, ''))
          ) {
            throw notAllowed(`Type ${type} not supported on write.`);
          }
          out[out.length] = await wireOf(type, await s.data.get(type));
        }
        await ask('write', stringify(out));
      })();
    }
    writeText(data: Any): Any {
      if (arguments.length === 0) {
        return rejected(
          new TypeError(
            "Failed to execute 'writeText' on 'Clipboard': 1 argument required, but only 0 present.",
          ),
        );
      }
      const text = `${data}`;
      const no = writeRefusal();
      if (no) return rejected(notAllowed(no));
      return ask('write', stringify([{ t: 'text/plain', s: text }]));
    }
  }

  const CLIPBOARD = {};
  const clipboard = new Clipboard(CLIPBOARD);
  for (const Kind of [Clipboard, ClipboardItem]) {
    Object.defineProperty(Kind.prototype, Symbol.toStringTag, {
      value: Kind.name,
      configurable: true,
    });
  }

  return {
    interfaces: { Clipboard, ClipboardItem },
    clipboard,
    write: (entries) => {
      call('clipboard', 'write', 0, stringify(entries));
    },
  };
}
