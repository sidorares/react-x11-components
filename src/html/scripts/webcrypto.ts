// The Web Cryptography API, as a page's scripts see it: `Crypto`,
// `SubtleCrypto` and `CryptoKey`.
//
// **This function is source text**, as `installDom` is (`dom.ts`): the engine
// hands it to the context through `Function.prototype.toString()`, so it
// closes over nothing, and `installDom` is handed it and calls it with what
// it reaches the host by.
//
// The line between this and the host (`subtle.ts`) is the specification's. A
// method's steps up to "return promise" run here, in the page's realm and in
// its order: arguments converted, algorithms normalized, then buffers copied, so
// a getter on a page's dictionary can still change one. What
// the specification does "in parallel" is the host's, through the runtime's
// own `crypto.subtle`, and is told back through `__crypto`. So what a getter
// on a page's dictionary sees, and when a later change to its buffer stops
// mattering, is as a browser has it, and what a page holds — the promises,
// the keys, the buffers, every rejection — is made here, of the page's own
// classes.
//
// **A key's bytes are never in this realm.** A `CryptoKey` here holds a sealed
// string the host made: its material and everything that says what it may do,
// under a secret no realm has. The page's script may come by that string — a
// page can replace `JSON.stringify` — and it is no use to it: it cannot read
// it, and a change to it fails to open. The string is also the whole of the
// key, which is what lets one cross a thread and reach a disk as text, as
// every other clone does (`serializeClone`). `docs/prd-webcrypto.md` has why.

/** What `installDom` hands this. */
export interface WebCryptoDeps {
  call(op: string, a?: unknown, b?: unknown, c?: unknown, d?: unknown): unknown;
  entry(name: string, fn: () => unknown): void;
  input(): unknown;
  DOMException: unknown;
  QuotaExceededError: unknown;
  bytesOfBase64(text: string): Uint8Array;
  base64OfBytes(bytes: Uint8Array): string;
}

/** What `installDom` has of this. */
export interface WebCryptoInternals {
  /** The realm's `crypto`. */
  crypto: unknown;
  /** The interfaces this context exposes, by name. */
  interfaces: Record<string, unknown>;
  /** Whether a value is a `CryptoKey`. */
  isKey(value: unknown): boolean;
  /** A key of this realm's with what `key` holds: a clone here. */
  copy(key: unknown): unknown;
  /** What a key is as text, for a clone that leaves this realm. */
  sealedOf(key: unknown): string;
  /** A key made here from what `sealedOf` answered, or a `DataCloneError`. */
  fromSealed(sealed: string): unknown;
  /** A random UUID, for the facade's own use: `randomUUID` is the page's to
   *  replace, and a secure context's alone. */
  uuid(): string;
}

export function installWebCrypto(deps: WebCryptoDeps): WebCryptoInternals {
  'use strict';
  type Any = any;
  const D: Any = deps;
  const call: Any = D.call;
  const entry: Any = D.entry;
  const input: Any = D.input;
  const DOMException: Any = D.DOMException;
  const QuotaExceededError: Any = D.QuotaExceededError;
  const bytesOfBase64: Any = D.bytesOfBase64;
  const base64OfBytes: Any = D.base64OfBytes;

  // What is taken before any page code runs: what a page replaces later
  // changes nothing a method here does.
  const P: Any = Promise;
  const rejected: Any = P.reject.bind(P);
  const apply: Any = Reflect.apply;
  const defineProperty: Any = Object.defineProperty;
  const stringify: Any = JSON.stringify;
  const parse: Any = JSON.parse;
  const freeze: Any = Object.freeze;
  const WM: Any = WeakMap.prototype;
  const wmGet: Any = WM.get;
  const wmSet: Any = WM.set;
  const wmHas: Any = WM.has;
  const isArray: Any = Array.isArray;
  const isView: Any = ArrayBuffer.isView;
  const iteratorSymbol: Any = Symbol.iterator;
  const toStringTag: Any = Symbol.toStringTag;
  const Uint8 = Uint8Array;
  const getter = (proto: Any, name: Any): Any =>
    Object.getOwnPropertyDescriptor(proto, name)?.get;
  const typed = Object.getPrototypeOf(Uint8Array.prototype);
  const typedTag = getter(typed, toStringTag);
  const typedBuffer = getter(typed, 'buffer');
  const typedOffset = getter(typed, 'byteOffset');
  const typedLength = getter(typed, 'byteLength');
  const viewBuffer = getter(DataView.prototype, 'buffer');
  const viewOffset = getter(DataView.prototype, 'byteOffset');
  const viewLength = getter(DataView.prototype, 'byteLength');
  const bufferLength = getter(ArrayBuffer.prototype, 'byteLength');
  const bufferResizable = getter(ArrayBuffer.prototype, 'resizable');
  const bufferDetached = getter(ArrayBuffer.prototype, 'detached');

  /** Why no constructor here can be called by a page's script. */
  const INTERNAL = Symbol('internal');
  // `[SecureContext]`: not there at all in a context that is not one
  const secure = call('secureContext') === true;

  const notSupported = (message: string): Any =>
    new DOMException(message, 'NotSupportedError');

  // --- Web IDL ----------------------------------------------------------------

  /** `DOMString`. */
  const text = (v: Any): string => `${v}`;
  /** `AlgorithmIdentifier`, a union of `object` and `DOMString`. */
  const identifier = (v: Any): Any =>
    v !== null && (typeof v === 'object' || typeof v === 'function')
      ? v
      : text(v);
  /** An integer type with `[EnforceRange]`. */
  const enforced = (v: Any, most: number, name: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      throw new TypeError(`${name} is not a finite number.`);
    }
    const whole = Math.trunc(n) + 0;
    if (whole < 0 || whole > most) {
      throw new TypeError(`${name} is outside the range of its type.`);
    }
    return whole;
  };
  /** What a buffer source's bytes are in: an `ArrayBuffer`, or a view on
   *  one, of any realm. A `SharedArrayBuffer` is neither, and neither is a
   *  buffer that can be resized, since the argument is not
   *  `[AllowShared]` or `[AllowResizable]`. */
  const partsOf = (
    v: Any,
  ): { buffer: Any; offset: number; length: number } | null => {
    let parts: { buffer: Any; offset: number; length: number } | null = null;
    if (v === null || typeof v !== 'object') return null;
    if (isView(v)) {
      parts =
        apply(typedTag, v, []) !== undefined
          ? {
              buffer: apply(typedBuffer, v, []),
              offset: apply(typedOffset, v, []),
              length: apply(typedLength, v, []),
            }
          : {
              buffer: apply(viewBuffer, v, []),
              offset: apply(viewOffset, v, []),
              length: apply(viewLength, v, []),
            };
    } else {
      parts = { buffer: v, offset: 0, length: 0 };
    }
    let whole: number;
    try {
      whole = apply(bufferLength, parts.buffer, []);
    } catch {
      return null;
    }
    if (bufferResizable && apply(bufferResizable, parts.buffer, [])) {
      return null;
    }
    if (parts.buffer === v) parts.length = whole;
    return parts;
  };
  /** `BufferSource`: what it is in, or a `TypeError`. */
  const source = (v: Any, name: string): Any => {
    const parts = partsOf(v);
    if (!parts) throw new TypeError(`${name} is not a BufferSource.`);
    return parts;
  };
  /** A copy of what a buffer source holds, as it crosses (Web IDL, "get a
   *  copy of the bytes held by the buffer source"): nothing, if a transfer
   *  took it. */
  const copyOf = (parts: Any): Any => {
    if (bufferDetached && apply(bufferDetached, parts.buffer, [])) {
      return { $b: '' };
    }
    return {
      $b: base64OfBytes(new Uint8(parts.buffer, parts.offset, parts.length)),
    };
  };
  /** `sequence<T>` from an iterable, each element converted. */
  const sequence = (v: Any, name: string, each: (x: Any) => Any): Any[] => {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) {
      throw new TypeError(`${name} is not a sequence.`);
    }
    const method = v[iteratorSymbol];
    if (method === undefined || method === null) {
      throw new TypeError(`${name} is not iterable.`);
    }
    const iterator = apply(method, v, []);
    const next = iterator.next;
    const out: Any[] = [];
    for (;;) {
      const step = apply(next, iterator, []);
      if (step === null || typeof step !== 'object') {
        throw new TypeError('An iterator answered with something else.');
      }
      if (step.done) return out;
      out[out.length] = each(step.value);
    }
  };
  const USAGES: Any = {
    encrypt: 1,
    decrypt: 1,
    sign: 1,
    verify: 1,
    deriveKey: 1,
    deriveBits: 1,
    wrapKey: 1,
    unwrapKey: 1,
    encapsulateKey: 1,
    encapsulateBits: 1,
    decapsulateKey: 1,
    decapsulateBits: 1,
  };
  const usagesOf = (v: Any): string[] =>
    sequence(v, 'keyUsages', (x) => {
      const usage = text(x);
      if (!Object.hasOwn(USAGES, usage)) {
        throw new TypeError(`'${usage}' is not a valid KeyUsage.`);
      }
      return usage;
    });
  const FORMATS: Any = {
    raw: 1,
    spki: 1,
    pkcs8: 1,
    jwk: 1,
  };
  const formatOf = (v: Any): string => {
    const format = text(v);
    if (!Object.hasOwn(FORMATS, format)) {
      throw new TypeError(`'${format}' is not a valid KeyFormat.`);
    }
    return format;
  };

  /** A `JsonWebKey`, its members read in the order Web IDL has them. */
  const JWK_MEMBERS = [
    'alg',
    'crv',
    'd',
    'dp',
    'dq',
    'e',
    'ext',
    'k',
    'key_ops',
    'kty',
    'n',
    'oth',
    'p',
    'q',
    'qi',
    'use',
    'x',
    'y',
  ];
  const jwkOf = (v: Any): Any => {
    const out: Any = {};
    if (v === undefined || v === null) return out;
    if (typeof v !== 'object' && typeof v !== 'function') {
      throw new TypeError('The key data is not a JsonWebKey.');
    }
    for (const name of JWK_MEMBERS) {
      const value = v[name];
      if (value === undefined) continue;
      if (name === 'ext') out.ext = !!value;
      else if (name === 'key_ops') {
        out.key_ops = sequence(value, 'key_ops', text);
      } else if (name === 'oth') {
        out.oth = sequence(value, 'oth', (other) => {
          if (
            other !== undefined &&
            other !== null &&
            typeof other !== 'object' &&
            typeof other !== 'function'
          ) {
            throw new TypeError('oth holds something else.');
          }
          const prime: Any = {};
          for (const part of ['d', 'r', 't']) {
            const value = other?.[part];
            if (value !== undefined) prime[part] = text(value);
          }
          return prime;
        });
      } else out[name] = text(value);
    }
    return out;
  };

  // --- what each operation takes ----------------------------------------------
  //
  // A dictionary is its members in the order Web IDL reads them, what is
  // inherited first and then its own by name: `[name, kind, required]`.
  // `b` is a `BufferSource`, `i` a `BigInteger`, `h` a hash, `k` a `CryptoKey`,
  // `s` a `DOMString`, and `32`, `16` and `8` integers of that many bits with
  // `[EnforceRange]`.

  type Member = [string, string, number];
  type Dictionary = Member[];
  const NONE: Dictionary = [];
  const AES_CBC: Dictionary = [['iv', 'b', 1]];
  const AES_CTR: Dictionary = [
    ['counter', 'b', 1],
    ['length', '8', 1],
  ];
  const AES_GCM: Dictionary = [
    ['additionalData', 'b', 0],
    ['iv', 'b', 1],
    ['tagLength', '8', 0],
  ];
  const RSA_OAEP: Dictionary = [['label', 'b', 0]];
  const RSA_PSS: Dictionary = [['saltLength', '32', 1]];
  const HASHED: Dictionary = [['hash', 'h', 1]];
  const RSA_GEN: Dictionary = [
    ['modulusLength', '32', 1],
    ['publicExponent', 'i', 1],
    ['hash', 'h', 1],
  ];
  const EC: Dictionary = [['namedCurve', 's', 1]];
  const HMAC_PARAMS: Dictionary = [
    ['hash', 'h', 1],
    ['length', '32', 0],
  ];
  const AES_LENGTH: Dictionary = [['length', '16', 1]];
  const ECDH_PARAMS: Dictionary = [['public', 'k', 1]];
  const HKDF_PARAMS: Dictionary = [
    ['hash', 'h', 1],
    ['info', 'b', 1],
    ['salt', 'b', 1],
  ];
  const PBKDF2_PARAMS: Dictionary = [
    ['hash', 'h', 1],
    ['iterations', '32', 1],
    ['salt', 'b', 1],
  ];

  const RSA = ['RSASSA-PKCS1-v1_5', 'RSA-PSS', 'RSA-OAEP'];
  const AES = ['AES-CBC', 'AES-CTR', 'AES-GCM', 'AES-KW'];

  /** An operation's registered algorithms, what it takes of each. */
  const table = (
    ...groups: [string[] | string, Dictionary][]
  ): Map<string, [string, Dictionary]> => {
    const out = new Map<string, [string, Dictionary]>();
    for (const [names, dictionary] of groups) {
      for (const name of isArray(names) ? names : [names]) {
        out.set(asciiLower(name as string), [name as string, dictionary]);
      }
    }
    return out;
  };
  /** ASCII alone: the Kelvin sign is no K (Web Crypto, "normalize an
   *  algorithm"). */
  function asciiLower(name: string): string {
    let out = '';
    for (let i = 0; i < name.length; i += 1) {
      const c = name.charCodeAt(i);
      out += String.fromCharCode(c >= 65 && c <= 90 ? c + 32 : c);
    }
    return out;
  }

  const CIPHERS = table(
    ['RSA-OAEP', RSA_OAEP],
    ['AES-CBC', AES_CBC],
    ['AES-CTR', AES_CTR],
    ['AES-GCM', AES_GCM],
  );
  const SIGNING = table(
    [['RSASSA-PKCS1-v1_5', 'HMAC', 'Ed25519'], NONE],
    ['RSA-PSS', RSA_PSS],
    ['ECDSA', HASHED],
  );
  const DIGESTS = table([['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'], NONE]);
  const GENERATE = table(
    [RSA, RSA_GEN],
    [['ECDSA', 'ECDH'], EC],
    [AES, AES_LENGTH],
    ['HMAC', HMAC_PARAMS],
    [['Ed25519', 'X25519'], NONE],
  );
  const IMPORT = table(
    [RSA, HASHED],
    [['ECDSA', 'ECDH'], EC],
    [AES, NONE],
    ['HMAC', HMAC_PARAMS],
    [['Ed25519', 'X25519'], NONE],
    [['HKDF', 'PBKDF2'], NONE],
  );
  const DERIVE = table(
    [['ECDH', 'X25519'], ECDH_PARAMS],
    ['HKDF', HKDF_PARAMS],
    ['PBKDF2', PBKDF2_PARAMS],
  );
  const WRAP = table(['AES-KW', NONE]);
  const KEY_LENGTH = table(
    [AES, AES_LENGTH],
    ['HMAC', HMAC_PARAMS],
    [['HKDF', 'PBKDF2'], NONE],
  );

  /** An algorithm as the host is handed it (Web Crypto, "normalize an
   *  algorithm"): its name as the operation registers it, and what its
   *  dictionary holds, all read first and then copied. */
  const normalize = (
    registered: Map<string, [string, Dictionary]>,
    algorithm: Any,
  ): Any => {
    if (typeof algorithm !== 'object' && typeof algorithm !== 'function') {
      return normalize(registered, { name: algorithm });
    }
    const name = algorithm.name;
    if (name === undefined) throw new TypeError('An algorithm has no name.');
    const found = registered.get(asciiLower(text(name)));
    if (!found) {
      throw notSupported(`Unrecognized algorithm name '${text(name)}'.`);
    }
    const [canonical, dictionary] = found;
    // the desired type's conversion reads its `name` again
    text(algorithm.name);
    const read: [Member, Any][] = [];
    for (const member of dictionary) {
      const value = algorithm[member[0]];
      if (value === undefined) {
        if (member[2]) {
          throw new TypeError(`The algorithm has no '${member[0]}'.`);
        }
        continue;
      }
      read[read.length] = [member, converted(member, value)];
    }
    const out: Any = { name: canonical };
    for (const [member, value] of read) {
      out[member[0]] =
        member[1] === 'b' || member[1] === 'i'
          ? copyOf(value)
          : member[1] === 'h'
            ? normalize(DIGESTS, value)
            : value;
    }
    return out;
  };
  const converted = ([name, kind]: Member, value: Any): Any => {
    switch (kind) {
      case 'b':
        return source(value, name);
      case 'i':
        // a `BigInteger` is a `Uint8Array`
        if (
          !isView(value) ||
          apply(typedTag, value, []) !== 'Uint8Array' ||
          !partsOf(value)
        ) {
          throw new TypeError(`'${name}' is not a Uint8Array.`);
        }
        return partsOf(value);
      case 'h':
        return identifier(value);
      case 'k':
        return { $k: slotOf(value, name).sealed };
      case 's':
        return text(value);
      case '32':
        return enforced(value, 4294967295, name);
      case '16':
        return enforced(value, 65535, name);
      default:
        return enforced(value, 255, name);
    }
  };

  // --- CryptoKey --------------------------------------------------------------

  /** A key's internal slots: what the host says of it, and the objects
   *  `algorithm` and `usages` answer with, made as they are first asked. */
  interface Slots {
    sealed: string;
    type: string;
    extractable: boolean;
    described: Any;
    usageList: string[];
    algorithm?: Any;
    usages?: Any;
  }
  const slots = new WeakMap();
  /** How a key of another realm of this page says what it is: a frame's
   *  window has its own facade, so a key the page hands one has no slots
   *  there. A page's script may call it, and may put one on anything, which
   *  gets it no further than the string does. */
  const SEALED = Symbol.for('react-x11.sealedKey');
  const foreignSealed = (key: Any): string | null => {
    const read = key[SEALED];
    return typeof read === 'function' ? `${apply(read, key, [])}` : null;
  };
  const slotOf = (key: Any, name: string): Slots => {
    if (key !== null && typeof key === 'object') {
      const found = apply(wmGet, slots, [key]);
      if (found) return found;
      const sealed = foreignSealed(key);
      if (sealed !== null) return apply(wmGet, slots, [fromSealed(sealed)]);
    }
    throw new TypeError(`${name} is not a CryptoKey.`);
  };

  class CryptoKey {
    constructor(...args: Any[]) {
      if (args[0] !== INTERNAL) throw new TypeError('Illegal constructor');
    }
    get type(): string {
      return slotOf(this, 'The receiver').type;
    }
    get extractable(): boolean {
      return slotOf(this, 'The receiver').extractable;
    }
    get algorithm(): Any {
      const key = slotOf(this, 'The receiver');
      return (key.algorithm ??= algorithmOf(key.described));
    }
    get usages(): Any {
      const key = slotOf(this, 'The receiver');
      return (key.usages ??= freeze([...key.usageList]));
    }
  }
  /** What a key's `algorithm` answers with: the page's to change, as
   *  nothing here reads it. */
  const algorithmOf = (described: Any): Any => {
    const out: Any = {};
    for (const name of Object.keys(described)) {
      const value = described[name];
      out[name] =
        value !== null && typeof value === 'object'
          ? '$b' in value
            ? bytesOfBase64(value.$b).slice()
            : algorithmOf(value)
          : value;
    }
    return out;
  };
  const makeKey = (slot: Slots): Any => {
    const key = new CryptoKey(INTERNAL);
    apply(wmSet, slots, [key, slot]);
    return key;
  };
  /** A key the host describes (`keyValue` in `subtle.ts`). */
  const keyFrom = (v: Any): Any =>
    makeKey({
      sealed: v.$k,
      type: v.type,
      extractable: v.extractable,
      described: v.algorithm,
      usageList: v.usages,
    });

  /** A key made here from what `sealedOf` answered. */
  function fromSealed(sealed: string): Any {
    // a `[SecureContext]` interface is no type this realm has
    if (!secure) {
      throw new DOMException(
        'A CryptoKey cannot arrive in a context that is not secure.',
        'DataCloneError',
      );
    }
    return keyFrom(parse(`${call('crypto', 'open', sealed)}`));
  }

  // --- SubtleCrypto -----------------------------------------------------------

  /** What waits for the host, by request. */
  const pending = new Map<number, [Any, Any]>();
  let requests = 0;
  /** The host's answer made this realm's: a buffer of its bytes, a key of
   *  its string, and a pair or a `JsonWebKey` of each of its members. */
  const revived = (v: Any): Any => {
    if (v === null || typeof v !== 'object') return v;
    if (isArray(v)) return v.map(revived);
    if ('$b' in v) {
      const bytes = bytesOfBase64(v.$b);
      return bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer;
    }
    if ('$k' in v) return keyFrom(v);
    const out: Any = {};
    for (const name of Object.keys(v)) out[name] = revived(v[name]);
    return out;
  };
  const errorOf = (v: Any): Any =>
    v.name === 'TypeError'
      ? new TypeError(v.message)
      : new DOMException(v.message, v.name);
  entry('__crypto', () => {
    const [id, ok, value] = input() as [number, boolean, Any];
    const settle = pending.get(id);
    if (!settle) return false;
    pending.delete(id);
    if (ok) settle[0](revived(value));
    else settle[1](errorOf(value));
    return true;
  });
  /** Asks the host, whose steps are the method's "in parallel" ones. */
  const asked = (request: Any): Any =>
    new P((resolve: Any, reject: Any) => {
      const id = ++requests;
      pending.set(id, [resolve, reject]);
      try {
        call('crypto', 'run', id, stringify(request));
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });

  class SubtleCrypto {
    constructor(...args: Any[]) {
      if (args[0] !== INTERNAL) throw new TypeError('Illegal constructor');
    }
  }
  const subtleOf = new WeakSet();
  const wsHas: Any = WeakSet.prototype.has;
  const wsAdd: Any = WeakSet.prototype.add;

  /** One of its operations: an exception in Web IDL's conversions, or in the
   *  method's steps, is a rejected promise. */
  const method = (
    name: string,
    length: number,
    steps: (...args: Any[]) => Any,
  ): void => {
    const fn = {
      [name](this: Any, ...args: Any[]): Any {
        try {
          if (!apply(wsHas, subtleOf, [this])) {
            throw new TypeError('Illegal invocation');
          }
          if (args.length < length) {
            throw new TypeError(
              `${name} takes ${length} arguments, not ${args.length}.`,
            );
          }
          return steps(...args);
        } catch (error) {
          return rejected(error);
        }
      },
    }[name];
    defineProperty(fn, 'length', { value: length, configurable: true });
    defineProperty(SubtleCrypto.prototype, name, {
      value: fn,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  };

  for (const op of ['encrypt', 'decrypt', 'sign'] as const) {
    method(op, 3, (algorithm, key, data) => {
      const id = identifier(algorithm);
      const slot = slotOf(key, 'key');
      const parts = source(data, 'data');
      const normalized = normalize(op === 'sign' ? SIGNING : CIPHERS, id);
      return asked({
        op,
        algorithm: normalized,
        key: slot.sealed,
        data: copyOf(parts),
      });
    });
  }
  method('verify', 4, (algorithm, key, signature, data) => {
    const id = identifier(algorithm);
    const slot = slotOf(key, 'key');
    const signed = source(signature, 'signature');
    const parts = source(data, 'data');
    const normalized = normalize(SIGNING, id);
    return asked({
      op: 'verify',
      algorithm: normalized,
      key: slot.sealed,
      signature: copyOf(signed),
      data: copyOf(parts),
    });
  });
  method('digest', 2, (algorithm, data) => {
    const id = identifier(algorithm);
    const parts = source(data, 'data');
    const normalized = normalize(DIGESTS, id);
    return asked({ op: 'digest', algorithm: normalized, data: copyOf(parts) });
  });
  method('generateKey', 3, (algorithm, extractable, keyUsages) => {
    const id = identifier(algorithm);
    const ext = !!extractable;
    const usages = usagesOf(keyUsages);
    return asked({
      op: 'generateKey',
      algorithm: normalize(GENERATE, id),
      extractable: ext,
      usages,
    });
  });
  /** A derived key's algorithm: as it is imported, with what says how long
   *  it is. */
  const derivedOf = (id: Any): Any => {
    const imported = normalize(IMPORT, id);
    const sized = normalize(KEY_LENGTH, id);
    if (sized.length !== undefined) imported.length = sized.length;
    return imported;
  };
  method(
    'deriveKey',
    5,
    (algorithm, baseKey, derivedKeyType, extractable, keyUsages) => {
      const id = identifier(algorithm);
      const slot = slotOf(baseKey, 'baseKey');
      const derived = identifier(derivedKeyType);
      const ext = !!extractable;
      const usages = usagesOf(keyUsages);
      return asked({
        op: 'deriveKey',
        algorithm: normalize(DERIVE, id),
        key: slot.sealed,
        derived: derivedOf(derived),
        extractable: ext,
        usages,
      });
    },
  );
  method('deriveBits', 2, (algorithm, baseKey, length) => {
    const id = identifier(algorithm);
    const slot = slotOf(baseKey, 'baseKey');
    const bits =
      length === undefined || length === null
        ? null
        : enforced(length, 4294967295, 'length');
    return asked({
      op: 'deriveBits',
      algorithm: normalize(DERIVE, id),
      key: slot.sealed,
      length: bits,
    });
  });
  /** `(BufferSource or JsonWebKey)`. */
  const keyDataOf = (v: Any): Any => {
    if (v !== null && typeof v === 'object') {
      const parts = partsOf(v);
      if (parts) return parts;
      // a shared buffer is a `BufferSource` of no kind this takes, not a
      // dictionary with nothing in it
      if (
        isView(v) ||
        Object.prototype.toString.call(v) === '[object SharedArrayBuffer]'
      ) {
        throw new TypeError('The key data is not a BufferSource.');
      }
    }
    return { jwk: jwkOf(v) };
  };
  method(
    'importKey',
    5,
    (format, keyData, algorithm, extractable, keyUsages) => {
      const kind = formatOf(format);
      const data = keyDataOf(keyData);
      const id = identifier(algorithm);
      const ext = !!extractable;
      const usages = usagesOf(keyUsages);
      const normalized = normalize(IMPORT, id);
      if ((kind === 'jwk') !== 'jwk' in data) {
        throw new TypeError(
          kind === 'jwk'
            ? "The key data of a 'jwk' import is a JsonWebKey."
            : `The key data of a '${kind}' import is a BufferSource.`,
        );
      }
      return asked({
        op: 'importKey',
        format: kind,
        data: kind === 'jwk' ? data.jwk : copyOf(data),
        algorithm: normalized,
        extractable: ext,
        usages,
      });
    },
  );
  method('exportKey', 2, (format, key) => {
    const kind = formatOf(format);
    const slot = slotOf(key, 'key');
    return asked({ op: 'exportKey', format: kind, key: slot.sealed });
  });
  /** A wrapping algorithm: one that wraps, or any that encrypts. */
  const wrapping = (table: Any, id: Any): Any => {
    try {
      return normalize(WRAP, id);
    } catch {
      return normalize(table, id);
    }
  };
  method('wrapKey', 4, (format, key, wrappingKey, wrapAlgorithm) => {
    const kind = formatOf(format);
    const slot = slotOf(key, 'key');
    const wrapper = slotOf(wrappingKey, 'wrappingKey');
    const id = identifier(wrapAlgorithm);
    return asked({
      op: 'wrapKey',
      format: kind,
      key: slot.sealed,
      wrappingKey: wrapper.sealed,
      algorithm: wrapping(CIPHERS, id),
    });
  });
  method(
    'unwrapKey',
    7,
    (
      format,
      wrappedKey,
      unwrappingKey,
      unwrapAlgorithm,
      unwrappedKeyAlgorithm,
      extractable,
      keyUsages,
    ) => {
      const kind = formatOf(format);
      const parts = source(wrappedKey, 'wrappedKey');
      const wrapper = slotOf(unwrappingKey, 'unwrappingKey');
      const id = identifier(unwrapAlgorithm);
      const keyId = identifier(unwrappedKeyAlgorithm);
      const ext = !!extractable;
      const usages = usagesOf(keyUsages);
      const normalized = wrapping(CIPHERS, id);
      const imported = normalize(IMPORT, keyId);
      return asked({
        op: 'unwrapKey',
        format: kind,
        data: copyOf(parts),
        wrappingKey: wrapper.sealed,
        algorithm: normalized,
        imported,
        extractable: ext,
        usages,
      });
    },
  );

  // --- Crypto -----------------------------------------------------------------

  const INTEGER_ARRAYS: Any = {
    Int8Array: 1,
    Uint8Array: 1,
    Uint8ClampedArray: 1,
    Int16Array: 1,
    Uint16Array: 1,
    Int32Array: 1,
    Uint32Array: 1,
    BigInt64Array: 1,
    BigUint64Array: 1,
  };
  const uuid = (): string => `${call('uuid')}`;
  const cryptos = new WeakSet();
  const brand = (receiver: Any): void => {
    if (
      receiver === null ||
      typeof receiver !== 'object' ||
      !apply(wsHas, cryptos, [receiver])
    ) {
      throw new TypeError('Illegal invocation');
    }
  };
  class Crypto {
    constructor(...args: Any[]) {
      if (args[0] !== INTERNAL) throw new TypeError('Illegal constructor');
    }
    getRandomValues(array: Any): Any {
      brand(this);
      if (arguments.length < 1) {
        throw new TypeError('getRandomValues takes 1 argument.');
      }
      if (!isView(array)) {
        throw new TypeError(
          "Failed to execute 'getRandomValues' on 'Crypto': The argument is not an ArrayBufferView.",
        );
      }
      const tag = apply(typedTag, array, []);
      if (tag === undefined || !Object.hasOwn(INTEGER_ARRAYS, tag)) {
        throw new DOMException(
          `Failed to execute 'getRandomValues' on 'Crypto': The provided ArrayBufferView is of type '${tag ?? 'DataView'}', which is not an integer array type.`,
          'TypeMismatchError',
        );
      }
      const length = apply(typedLength, array, []);
      if (length > 65536) {
        throw new QuotaExceededError(
          `Failed to execute 'getRandomValues' on 'Crypto': The ArrayBufferView's byte length (${length}) exceeds the number of bytes of entropy available via this API (65536).`,
        );
      }
      const hex = `${call('random', length)}`;
      const bytes = new Uint8(
        apply(typedBuffer, array, []),
        apply(typedOffset, array, []),
        length,
      );
      for (let i = 0; i < length; i += 1) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return array;
    }
  }

  /** The interface's members as Web IDL has them: enumerable, on a prototype
   *  that names it. */
  const platform = (Class: Any, name: string): void => {
    for (const key of Object.getOwnPropertyNames(Class.prototype)) {
      if (key === 'constructor') continue;
      const found: Any = Object.getOwnPropertyDescriptor(Class.prototype, key);
      found.enumerable = true;
      defineProperty(Class.prototype, key, found);
    }
    defineProperty(Class.prototype, toStringTag, {
      value: name,
      configurable: true,
    });
  };

  const subtle = new SubtleCrypto(INTERNAL);
  apply(wsAdd, subtleOf, [subtle]);
  const crypto = new Crypto(INTERNAL);
  apply(wsAdd, cryptos, [crypto]);
  if (secure) {
    defineProperty(Crypto.prototype, 'subtle', {
      get: Object.getOwnPropertyDescriptor(
        {
          get subtle(): Any {
            brand(this);
            return subtle;
          },
        },
        'subtle',
      )!.get,
      configurable: true,
    });
    defineProperty(Crypto.prototype, 'randomUUID', {
      value: {
        randomUUID(this: Any): string {
          brand(this);
          return uuid();
        },
      }.randomUUID,
      writable: true,
      configurable: true,
    });
  }
  platform(Crypto, 'Crypto');
  platform(CryptoKey, 'CryptoKey');
  platform(SubtleCrypto, 'SubtleCrypto');
  defineProperty(CryptoKey.prototype, SEALED, {
    value(this: Any): string {
      const own = apply(wmGet, slots, [this]);
      if (!own) throw new TypeError('Illegal invocation');
      return own.sealed;
    },
  });

  return {
    crypto,
    interfaces: secure ? { Crypto, CryptoKey, SubtleCrypto } : { Crypto },
    isKey: (value) => {
      if (value === null || typeof value !== 'object') return false;
      if (apply(wmHas, slots, [value])) return true;
      try {
        return typeof (value as Any)[SEALED] === 'function';
      } catch {
        // another origin's window, which answers no name of this kind
        return false;
      }
    },
    copy: (key) => {
      const { sealed, type, extractable, described, usageList } = slotOf(
        key,
        'key',
      );
      return makeKey({ sealed, type, extractable, described, usageList });
    },
    sealedOf: (key) => slotOf(key, 'key').sealed,
    fromSealed,
    uuid,
  };
}
