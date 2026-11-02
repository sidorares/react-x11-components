// A page's `crypto.subtle` on the host's side: the steps the specification
// runs "in parallel", through the runtime's own `crypto.subtle`, and what
// comes of each told back through the `__crypto` entry. `webcrypto.ts` is the
// page's half, and has what is and is not done there.
//
// **A page's `CryptoKey` is a sealed string, and nothing here holds a key for
// it.** A string is what crosses the bridge, a thread and a disk, and a key
// has to cross all three: a worker uses the key a page posted it, and an
// application keeps a non-extractable key in IndexedDB across a restart. So
// `seal` puts a key's material, and everything that says what it may do, under
// AES-256-GCM with a secret no realm has, and the string is the key: the host
// that made it, a frame's, a worker's and the next process's all open it the
// same way, and there is no table of keys to keep in step, or to clear when a
// document goes.
//
// A page's script can come by the string, since the realm carries it and can
// replace what the realm calls. It can read none of it and change none of it:
// `extractable` is inside, and an edited string does not open. So what the
// host asks of a key it reads from what it opened, and what the facade says of
// a key is never believed here.
//
// The runtime's key is made from the material for each use, always extractable
// where the runtime allows it, since that is what lets it be sealed: the
// `extractable` a page sees is the record's, and is enforced here.
// `docs/prd-webcrypto.md` has the alternatives.
import { nodeModule } from './platform.js';
import type { BufferClass } from './platform.js';
import type { Primitive } from './dom.js';

declare const Buffer: BufferClass;
declare const TextDecoder: new () => { decode(bytes: Uint8Array): string };
declare const crypto: {
  subtle: RuntimeSubtle;
  getRandomValues(array: Uint8Array): Uint8Array;
};

/** The runtime's `CryptoKey`. */
interface RuntimeKey {
  readonly type: string;
  readonly extractable: boolean;
  readonly algorithm: Record<string, unknown>;
  readonly usages: string[];
}
interface RuntimeSubtle {
  [op: string]: (...args: never[]) => Promise<never>;
  // what a runtime that has `supports` answers it through
  constructor: never;
}
type Subtle = Record<
  string,
  ((...args: unknown[]) => Promise<never>) | undefined
>;

interface Cipher {
  setAAD(aad: Uint8Array): void;
  update(data: Uint8Array): Uint8Array;
  final(): Uint8Array;
  getAuthTag(): Uint8Array;
  setAuthTag(tag: Uint8Array): void;
}
interface CryptoModule {
  createCipheriv(name: string, key: Uint8Array, iv: Uint8Array): Cipher;
  createDecipheriv(name: string, key: Uint8Array, iv: Uint8Array): Cipher;
}
const { createCipheriv, createDecipheriv } =
  await nodeModule<CryptoModule>('crypto');

/** What a key is, sealed. */
interface KeyRecord {
  /** `type`. */
  t: string;
  /** `extractable`, as the page has it. */
  x: boolean;
  /** `algorithm`, as the runtime says it, its bytes as `{ $b }`. */
  a: Algorithm;
  /** `usages`. */
  u: string[];
  /** The format the material is in, and the material: base64, or a
   *  `JsonWebKey`. */
  f: string;
  d: string | Record<string, unknown>;
}
type Algorithm = Record<string, unknown> & { name: string };

/** A key opened: its record, and the runtime's keys made of it. */
interface Opened {
  record: KeyRecord;
  runtime: Map<string, Promise<RuntimeKey>>;
}

/** What is bound to every sealed string: a change to the form is a string
 *  that does not open. */
const AAD = Buffer.from('react-x11 CryptoKey 1', 'utf8');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SECRET_BYTES = 32;

/** The secrets this thread opens with. The first is the one a host with no
 *  store of its own seals with: this process's, made as it is first asked
 *  for and handed to each worker, or the one the page process handed this
 *  worker. */
const secrets: Uint8Array[] = [];
function threadSecret(): Uint8Array {
  if (!secrets.length) {
    secrets.push(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
  }
  return secrets[0]!;
}
/** A secret this thread can open with from now on. A store's is shared by
 *  every process that opens it (`HtmlIndexedDB.keySecret`). */
export function addKeySecret(secret: Uint8Array): void {
  if (secret.length !== SECRET_BYTES) {
    throw new TypeError(`A key secret is ${SECRET_BYTES} bytes.`);
  }
  const same = (other: Uint8Array): boolean =>
    other.every((byte, i) => byte === secret[i]);
  if (!secrets.some(same)) secrets.push(secret);
}
/** The secrets a worker starts with, the page's first (`keySecret`). */
export function keySecrets(sealing?: Uint8Array): Uint8Array[] {
  threadSecret();
  return [
    ...(sealing ? [sealing] : []),
    ...secrets.filter((secret) => secret !== sealing),
  ];
}

/** How many keys stay opened: a page that signs with one key a thousand
 *  times should open it once, and one that makes a thousand keys should not
 *  keep them. */
const KEPT_OPEN = 256;
const opened = new Map<string, Opened>();
function remember(sealed: string, key: Opened): Opened {
  opened.delete(sealed);
  opened.set(sealed, key);
  if (opened.size > KEPT_OPEN) {
    opened.delete(opened.keys().next().value as string);
  }
  return key;
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'base64',
  );
}
function bytesOf(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** A key as a string only a host of this process, or of one that shares its
 *  store, can open. */
function seal(record: KeyRecord, secret: Uint8Array): string {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  cipher.setAAD(AAD);
  const head = cipher.update(Buffer.from(JSON.stringify(record), 'utf8'));
  const tail = cipher.final();
  const tag = cipher.getAuthTag();
  const out = new Uint8Array(IV_BYTES + head.length + tail.length + TAG_BYTES);
  out.set(iv);
  out.set(head, IV_BYTES);
  out.set(tail, IV_BYTES + head.length);
  out.set(tag, IV_BYTES + head.length + tail.length);
  return base64Of(out);
}

/** A sealed string opened, under whichever of the thread's secrets it was
 *  sealed with. One that opens under none was edited, or is of a process
 *  this one shares nothing with. */
function open(sealed: string): Opened {
  const kept = opened.get(sealed);
  if (kept) return remember(sealed, kept);
  threadSecret();
  const bytes = bytesOf(sealed);
  const body = bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES);
  for (const secret of secrets) {
    try {
      const cipher = createDecipheriv(
        'aes-256-gcm',
        secret,
        bytes.subarray(0, IV_BYTES),
      );
      cipher.setAAD(AAD);
      cipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
      const head = cipher.update(body);
      const tail = cipher.final();
      const all = new Uint8Array(head.length + tail.length);
      all.set(head);
      all.set(tail, head.length);
      const record = JSON.parse(new TextDecoder().decode(all)) as KeyRecord;
      return remember(sealed, { record, runtime: new Map() });
    } catch {
      // not this secret's
    }
  }
  throw failure('DataCloneError', 'A CryptoKey could not be read.');
}

/** A key as the page's realm is told of it (`keyFrom` in `webcrypto.ts`). */
function keyValue(sealed: string, record: KeyRecord): unknown {
  return {
    $k: sealed,
    type: record.t,
    extractable: record.x,
    algorithm: record.a,
    usages: record.u,
  };
}

/** What is told of a failure: a name the page's realm makes an error of,
 *  and text. Nothing else of a runtime's error leaves here. */
const ERROR_NAMES = new Set([
  'DataError',
  'InvalidAccessError',
  'NotSupportedError',
  'OperationError',
  'QuotaExceededError',
  'SyntaxError',
  'TypeError',
]);
function failureOf(error: unknown): { name: string; message: string } {
  const e = error as { name?: unknown; message?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : '';
  const message = typeof e?.message === 'string' ? e.message : '';
  return ERROR_NAMES.has(name)
    ? { name, message }
    : { name: 'OperationError', message: 'The operation failed.' };
}
function failure(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** Bytes as they are told to the page. */
function told(buffer: ArrayBuffer | Uint8Array): { $b: string } {
  return {
    $b: base64Of(
      buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer),
    ),
  };
}
/** What crossed as `{ $b }` and `{ $k }`, the runtime's again. */
function revived(value: unknown): Promise<unknown> | unknown {
  if (value === null || typeof value !== 'object') return value;
  const v = value as Record<string, unknown>;
  if (typeof v.$b === 'string') return bytesOf(v.$b);
  if (typeof v.$k === 'string') return runtimeKey(v.$k);
  return (async () => {
    const out: Record<string, unknown> = {};
    for (const name of Object.keys(v)) out[name] = await revived(v[name]);
    return out;
  })();
}
/** The runtime's algorithm as it is told to the page: a plain object. */
function plain(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return told(value);
  if (Array.isArray(value)) return value.map(plain);
  const v = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(v)) out[name] = plain(v[name]);
  return out;
}

/** A key's usages as `CryptoKey.usages` answers them: each once, in the order
 *  the specification lists them. */
const USAGE_ORDER = [
  'encrypt',
  'decrypt',
  'sign',
  'verify',
  'deriveKey',
  'deriveBits',
  'wrapKey',
  'unwrapKey',
  'encapsulateKey',
  'encapsulateBits',
  'decapsulateKey',
  'decapsulateBits',
];
const inOrder = (usages: readonly string[]): string[] =>
  USAGE_ORDER.filter((usage) => usages.includes(usage));

/** Keys the runtime lets nobody export, and whose material is what they were
 *  imported from. */
const NEVER_EXPORTED = /^(HKDF|PBKDF2)$/;

/** The runtime's key for a sealed one, with `usages` in place of its own
 *  where a step asks for what the page's key may do by another name. */
function runtimeKey(sealed: string, usages?: string[]): Promise<RuntimeKey> {
  const key = open(sealed);
  const asked = usages?.join() ?? '';
  let made = key.runtime.get(asked);
  if (!made) {
    const { f: format, d: data, a: algorithm, u } = key.record;
    made = (async () =>
      (crypto.subtle as unknown as Subtle).importKey!(
        format,
        typeof data === 'string' ? bytesOf(data) : data,
        await revived(algorithm),
        !NEVER_EXPORTED.test(algorithm.name),
        usages ?? u,
      ) as Promise<RuntimeKey>)();
    key.runtime.set(asked, made);
  }
  return made;
}

/** The points of order 8 or less on Ed25519 and what encodes them past the
 *  field's end, by their low 31 bytes and 7 bits: the sign is no part of it. */
const SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];
function smallOrder(point: Uint8Array): boolean {
  if (point.length !== 32) return false;
  let hex = '';
  point.forEach((byte, i) => {
    hex += (i === 31 ? byte & 127 : byte).toString(16).padStart(2, '0');
  });
  return SMALL_ORDER.includes(hex);
}
/** An Ed25519 key's point: the end of its `spki`, whatever it came as. */
async function publicPoint(key: RuntimeKey): Promise<Uint8Array> {
  return new Uint8Array(await ask('exportKey', 'spki', key)).subarray(-32);
}

/** A runtime that has what an operation asks. */
function ask(op: string, ...args: unknown[]): Promise<never> {
  const method = (crypto.subtle as unknown as Subtle)[op];
  if (!method) throw failure('NotSupportedError', `${op} is not supported.`);
  return method.apply(crypto.subtle, args);
}

/** A JWK with nothing in it that limits what the key may be imported for:
 *  what the page's import said is the record's, and its checks are behind
 *  it. */
function bareJwk(jwk: Record<string, unknown>): Record<string, unknown> {
  const { ext: _ext, key_ops: _ops, use: _use, ...bare } = jwk;
  return bare;
}

/** A request's fields, as `webcrypto.ts` wrote them. */
interface Request {
  op: string;
  algorithm: Algorithm;
  key: string;
  wrappingKey: string;
  data: { $b: string } | Record<string, unknown>;
  signature: { $b: string };
  format: string;
  length: number | null;
  extractable: boolean;
  usages: string[];
  derived: Algorithm;
  imported: Algorithm;
}

export class PageCrypto {
  /** What keys made here are sealed with. */
  private readonly _secret: Uint8Array;

  constructor(
    /** A store's, where the host keeps keys past the process. */
    secret: Uint8Array | undefined,
    private readonly _tell: (id: number, ok: boolean, value: unknown) => void,
  ) {
    if (secret) addKeySecret(secret);
    this._secret = secret ?? threadSecret();
  }

  /** An op of the facade's (`crypto`). */
  op(kind: string, a: Primitive, b: Primitive): Primitive {
    switch (kind) {
      case 'run':
        void this._run(Number(a), String(b));
        return null;
      case 'open': {
        const sealed = String(a);
        return JSON.stringify(keyValue(sealed, open(sealed).record));
      }
      default:
        return null;
    }
  }

  private async _run(id: number, json: string): Promise<void> {
    let ok = true;
    let value: unknown;
    try {
      value = await this._steps(JSON.parse(json) as Request);
    } catch (error) {
      ok = false;
      value = failureOf(error);
    }
    this._tell(id, ok, value);
  }

  private async _steps(q: Request): Promise<unknown> {
    switch (q.op) {
      case 'digest':
        return told(
          await ask(
            'digest',
            await revived(q.algorithm),
            await revived(q.data),
          ),
        );
      case 'encrypt':
      case 'decrypt':
      case 'sign':
        return told(
          await ask(
            q.op,
            await revived(q.algorithm),
            await runtimeKey(q.key),
            await revived(q.data),
          ),
        );
      case 'verify': {
        const key = await runtimeKey(q.key);
        const signature = (await revived(q.signature)) as Uint8Array;
        // the runtime's check takes these (Web Crypto, Ed25519 "verify")
        if (
          q.algorithm.name === 'Ed25519' &&
          key.type === 'public' &&
          (smallOrder(signature.subarray(0, 32)) ||
            smallOrder(await publicPoint(key)))
        ) {
          return false;
        }
        return ask(
          'verify',
          await revived(q.algorithm),
          key,
          signature,
          await revived(q.data),
        );
      }
      case 'generateKey': {
        const made: RuntimeKey | Record<string, RuntimeKey> = await ask(
          'generateKey',
          await revived(q.algorithm),
          true,
          q.usages,
        );
        if ('privateKey' in made) {
          const { privateKey, publicKey } = made as Record<string, RuntimeKey>;
          return {
            privateKey: await this._seal(privateKey!, q.extractable),
            publicKey: await this._seal(publicKey!, true),
          };
        }
        return this._seal(made as RuntimeKey, q.extractable);
      }
      case 'importKey':
        return this._import(
          q.format,
          q.format === 'jwk'
            ? (q.data as Record<string, unknown>)
            : ((await revived(q.data)) as Uint8Array),
          q.algorithm,
          q.extractable,
          q.usages,
        );
      case 'exportKey': {
        this._exportable(q.key);
        return this._exported(
          await ask('exportKey', q.format, await runtimeKey(q.key)),
        );
      }
      case 'deriveBits':
        return told(
          await ask(
            'deriveBits',
            await revived(q.algorithm),
            await runtimeKey(q.key),
            q.length,
          ),
        );
      case 'deriveKey':
        return this._deriveKey(q);
      case 'wrapKey': {
        const wrapper = open(q.wrappingKey).record;
        if (wrapper.a.name !== q.algorithm.name) {
          throw failure(
            'InvalidAccessError',
            'The wrapping key is not of this algorithm.',
          );
        }
        if (!wrapper.u.includes('wrapKey')) {
          throw failure(
            'InvalidAccessError',
            "The wrapping key's usages do not include wrapKey.",
          );
        }
        this._exportable(q.key);
        return told(
          await ask(
            'wrapKey',
            q.format,
            await runtimeKey(q.key),
            await runtimeKey(q.wrappingKey),
            await revived(q.algorithm),
          ),
        );
      }
      case 'unwrapKey':
        return this._unwrapKey(q);
      default:
        throw failure('NotSupportedError', `${q.op} is not supported.`);
    }
  }

  /** A key the runtime made, sealed: its material read out, in the form the
   *  runtime will take back. */
  private async _seal(key: RuntimeKey, extractable: boolean): Promise<unknown> {
    const format =
      key.type === 'private' ? 'pkcs8' : key.type === 'public' ? 'spki' : 'raw';
    const data: ArrayBuffer = await ask('exportKey', format, key);
    return this._sealed({
      t: key.type,
      x: extractable,
      a: plain(key.algorithm) as Algorithm,
      u: inOrder(key.usages),
      f: format,
      d: base64Of(new Uint8Array(data)),
    });
  }

  private _sealed(record: KeyRecord): unknown {
    const sealed = seal(record, this._secret);
    remember(sealed, { record, runtime: new Map() });
    return keyValue(sealed, record);
  }

  /** The steps of importing a key: the runtime's, with what the page said.
   *  What it was imported from is its material, as it has already been
   *  found good. */
  private async _import(
    format: string,
    data: Uint8Array | Record<string, unknown>,
    algorithm: Algorithm,
    extractable: boolean,
    usages: string[],
  ): Promise<unknown> {
    const key: RuntimeKey = await ask(
      'importKey',
      format,
      data,
      await revived(algorithm),
      extractable,
      usages,
    );
    return this._sealed({
      t: key.type,
      x: key.extractable,
      a: plain(key.algorithm) as Algorithm,
      u: inOrder(key.usages),
      f: format,
      d: data instanceof Uint8Array ? base64Of(data) : bareJwk(data),
    });
  }

  /** The checks of an export, in the order the specification has them: an
   *  algorithm with no export at all, and then a key that may not be. */
  private _exportable(sealed: string): void {
    const { a: algorithm, x: extractable } = open(sealed).record;
    if (NEVER_EXPORTED.test(algorithm.name)) {
      throw failure(
        'NotSupportedError',
        `A ${algorithm.name} key cannot be exported.`,
      );
    }
    if (!extractable) {
      throw failure('InvalidAccessError', 'The key is not extractable.');
    }
  }

  private _exported(value: ArrayBuffer | Record<string, unknown>): unknown {
    return value instanceof ArrayBuffer
      ? told(value)
      : (plain(value) as Record<string, unknown>);
  }

  private async _deriveKey(q: Request): Promise<unknown> {
    const base = open(q.key).record;
    if (base.a.name !== q.algorithm.name) {
      throw failure(
        'InvalidAccessError',
        'The base key is not of this algorithm.',
      );
    }
    if (!base.u.includes('deriveKey')) {
      throw failure(
        'InvalidAccessError',
        "The base key's usages do not include deriveKey.",
      );
    }
    const algorithm = await revived(q.algorithm);
    // a key derived for a derivation has no length of its own, and is read
    // out of no runtime key: its bits are its material
    if (NEVER_EXPORTED.test(q.derived.name)) {
      const bits: ArrayBuffer = await ask(
        'deriveBits',
        algorithm,
        await runtimeKey(q.key, ['deriveBits']),
        null,
      );
      return this._import(
        'raw',
        new Uint8Array(bits),
        q.derived,
        q.extractable,
        q.usages,
      );
    }
    const key: RuntimeKey = await ask(
      'deriveKey',
      algorithm,
      await runtimeKey(q.key),
      await revived(q.derived),
      true,
      q.usages,
    );
    return this._seal(key, q.extractable);
  }

  /**
   * The steps of unwrapping (Web Crypto, `unwrapKey`), by hand: the runtime
   * would hand back a key it will not export where the page's may not be. So
   * the bytes are unwrapped into a key of no consequence, which any bytes
   * can be, and read out of it, and imported as the page asked.
   */
  private async _unwrapKey(q: Request): Promise<unknown> {
    const scratch: RuntimeKey = await ask(
      'unwrapKey',
      'raw',
      await revived(q.data),
      await runtimeKey(q.wrappingKey),
      await revived(q.algorithm),
      { name: 'HMAC', hash: 'SHA-256' },
      true,
      ['sign'],
    );
    const bytes = new Uint8Array(
      (await ask('exportKey', 'raw', scratch)) as ArrayBuffer,
    );
    let data: Uint8Array | Record<string, unknown> = bytes;
    if (q.format === 'jwk') {
      try {
        data = JSON.parse(new TextDecoder().decode(bytes)) as Record<
          string,
          unknown
        >;
      } catch {
        throw failure('DataError', 'The unwrapped key is not a JSON Web Key.');
      }
    }
    return this._import(q.format, data, q.imported, q.extractable, q.usages);
  }
}
