// `<Html scripts>`'s Web Cryptography API: `crypto.subtle`, `CryptoKey` and
// what it takes for a key to cross a clone, a thread and a disk while no page
// can read it (src/html/scripts/webcrypto.ts, subtle.ts).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Document } from 'domhandler';

import { Html, HtmlProfile, useHtmlHandle } from '../../src/html/index.js';
import type { HtmlHandle, HtmlScripts } from '../../src/html/index.js';
import { preloadHtmlScripts } from '../../src/html/scripts/hook.js';
import {
  SCRIPTS_CONTAINED,
  ScriptEngine,
} from '../../src/html/scripts/engine.js';
import { DomHost } from '../../src/html/scripts/host.js';
import type { HostSeams } from '../../src/html/scripts/host.js';
import { FONTS, findById, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;
const PAGE = 'https://example.test/dir/page.html';

interface Page {
  handle: HtmlHandle;
  text(id: string): string;
}

function textOf(node: { children?: unknown[]; data?: string } | null): string {
  if (!node) return '';
  if (typeof node.data === 'string') return node.data;
  return (node.children ?? []).map((n) => textOf(n as never)).join('');
}

/** A document whose scripts run, at `url`, its script `code`, in which
 *  `out(text)` is what the test reads back. */
async function page(
  code: string,
  options: { url?: string; scripts?: HtmlScripts } = {},
): Promise<Page> {
  let out!: Page;
  function Doc() {
    const handle = useHtmlHandle();
    out = {
      handle,
      text: (id) => textOf(findById(handle.document, id) as never),
    };
    return h(Html, {
      source:
        '<p id="out"></p><script>' +
        'function out(t) { document.getElementById("out").textContent = t; }' +
        'function hex(b) { return [...new Uint8Array(b)].map(function (x) { return x.toString(16).padStart(2, "0"); }).join(""); }' +
        'function bytes(s) { return new TextEncoder().encode(s); }' +
        code +
        '</script>',
      partial: false,
      ref: handle.ref,
      baseUrl: options.url ?? PAGE,
      scripts: options.scripts ?? {},
    });
  }
  await renderX11(
    h(Doc),
    FONTS ? { width: 440, height: 300, fonts: FONTS } : { backend: 'mock' },
  );
  return out;
}

/** What the page's `out` said, once it said anything. */
async function said(doc: Page, ms = 8000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    await act(() => new Promise((r) => setTimeout(r, 15)));
    const text = doc.text('out');
    if (text || Date.now() > deadline) return text;
  }
}

test('a digest is a PKCE challenge, and a promise of the page', async () => {
  const doc = await page(
    'var p = crypto.subtle.digest("SHA-256", bytes("abc"));' +
      'p.then(function (d) { out([p instanceof Promise, d instanceof ArrayBuffer, hex(d)].join(" ")); });',
  );
  assert.equal(
    await said(doc),
    'true true ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('AES-GCM goes there and back, from a key no script can read', async () => {
  const doc = await page(
    '(async function () {' +
      'var key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);' +
      'var iv = crypto.getRandomValues(new Uint8Array(12));' +
      'var sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, bytes("hello"));' +
      'var opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, sealed);' +
      'var r = [new TextDecoder().decode(opened), key.type, key.extractable, key.algorithm.name, key.algorithm.length, key.usages.join(",")];' +
      'await crypto.subtle.exportKey("raw", key).catch(function (e) { r.push(e.name, e instanceof DOMException); });' +
      'out(r.join(" "));' +
      '})();',
  );
  assert.equal(
    await said(doc),
    'hello secret false AES-GCM 256 encrypt,decrypt InvalidAccessError true',
  );
});

test('a key survives structuredClone, as itself and no copy of the page', async () => {
  const doc = await page(
    '(async function () {' +
      'var key = await crypto.subtle.importKey("raw", new Uint8Array(16), "AES-CBC", true, ["encrypt"]);' +
      'var copy = structuredClone({ key: key }).key;' +
      'out([copy === key, copy instanceof CryptoKey, copy.extractable, hex(await crypto.subtle.exportKey("raw", copy))].join(" "));' +
      '})();',
  );
  assert.equal(
    await said(doc),
    'false true true 00000000000000000000000000000000',
  );
});

test('a refused call hands the page its own error, and no way out', async () => {
  const doc = await page(
    '(async function () {' +
      'var reach = "return typeof process";' +
      'var r = [];' +
      'function own(e) { return [e.name, e instanceof Error, e.constructor.constructor(reach)()].join(":"); }' +
      'await crypto.subtle.digest("no such", bytes("")).catch(function (e) { r.push(own(e)); });' +
      'await crypto.subtle.digest("SHA-256", 1).catch(function (e) { r.push(own(e)); });' +
      'var key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["encrypt"]);' +
      'await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, key, new Uint8Array(32)).catch(function (e) { r.push(own(e)); });' +
      'var ok = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["decrypt"]);' +
      'await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, ok, new Uint8Array(32)).catch(function (e) { r.push(own(e)); });' +
      'var made = [ok, ok.algorithm, ok.usages, await crypto.subtle.digest("SHA-1", new Uint8Array(1)), await crypto.subtle.exportKey("jwk", ok)];' +
      'r.push(made.map(function (o) { return o.constructor.constructor(reach)(); }).join());' +
      'out(r.join(" "));' +
      '})();',
  );
  assert.equal(
    await said(doc),
    'NotSupportedError:true:undefined TypeError:true:undefined InvalidAccessError:true:undefined OperationError:true:undefined undefined,undefined,undefined,undefined,undefined',
  );
});

test('crypto.subtle, CryptoKey and randomUUID are a secure context’s', async () => {
  const code =
    'out([isSecureContext, typeof crypto.subtle, typeof SubtleCrypto, typeof CryptoKey, typeof crypto.randomUUID, typeof Crypto, typeof crypto.getRandomValues].join(" "));';
  for (const [url, expected] of [
    [
      'https://example.test/',
      'true object function function function function function',
    ],
    [
      'http://example.test/',
      'false undefined undefined undefined undefined function function',
    ],
    [
      'http://localhost:3000/',
      'true object function function function function function',
    ],
    [
      'http://127.1.2.3/',
      'true object function function function function function',
    ],
    [
      'http://[::1]:8080/',
      'true object function function function function function',
    ],
    [
      'http://app.localhost/',
      'true object function function function function function',
    ],
    [
      'file:///tmp/page.html',
      'true object function function function function function',
    ],
  ] as const) {
    const doc = await page(code, { url });
    assert.equal(await said(doc), expected, url);
    cleanup();
  }
});

/** A worker from `code`, which `out()` is told what it posts. */
const WORKER =
  'function workerOf(code) {' +
  '  var w = new Worker(URL.createObjectURL(new Blob([code], { type: "application/javascript" })));' +
  '  w.onerror = function (e) { out("worker error " + e.message); };' +
  '  return w;' +
  '}';

test('a key goes to a worker and back, and stays what it was', async () => {
  const doc = await page(
    WORKER +
      '(async function () {' +
      'var key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);' +
      'var worker = workerOf(' +
      '  "onmessage = async function (e) {" +' +
      '  "  var key = e.data, r = [key instanceof CryptoKey, key.extractable, key.algorithm.hash.name, key.usages.join()];" +' +
      '  "  await crypto.subtle.exportKey(\'raw\', key).catch(function (e) { r.push(e.name); });" +' +
      "  \"  var made = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);\" +" +
      '  "  var signature = await crypto.subtle.sign(\'HMAC\', key, new Uint8Array(4));" +' +
      '  "  postMessage({ r: r, signature: signature, made: made, key: key });" +' +
      '  "};");' +
      'worker.onmessage = async function (e) {' +
      '  var d = e.data;' +
      '  var fine = await crypto.subtle.verify("HMAC", key, d.signature, new Uint8Array(4));' +
      '  var back = await crypto.subtle.verify("HMAC", d.key, d.signature, new Uint8Array(4));' +
      '  var mine = await crypto.subtle.sign("HMAC", d.made, new Uint8Array(4));' +
      '  out(d.r.join(" ") + " " + fine + " " + back + " " + mine.byteLength + " " + (d.key === key));' +
      '};' +
      'worker.postMessage(key);' +
      '})();',
  );
  assert.equal(
    await said(doc),
    'true false SHA-256 sign,verify InvalidAccessError true true 32 false',
  );
});

test('a shared worker takes a key each of its connections hands it', async () => {
  const doc = await page(
    '(async function () {' +
      'var key = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);' +
      'var code = "onconnect = function (e) { var port = e.ports[0]; port.onmessage = async function (m) {" +' +
      '  "  port.postMessage(await crypto.subtle.sign(\'HMAC\', m.data, new Uint8Array(1)));" +' +
      '  "}; };";' +
      'var worker = new SharedWorker(URL.createObjectURL(new Blob([code], { type: "application/javascript" })));' +
      'worker.port.onmessage = async function (e) {' +
      '  out(hex(e.data) === hex(await crypto.subtle.sign("HMAC", key, new Uint8Array(1))) ? "same" : "other");' +
      '};' +
      'worker.port.postMessage(key);' +
      '})();',
  );
  assert.equal(await said(doc), 'same');
});

test('what a page changes after a call reaches nothing, and what a getter changes does', async () => {
  const doc = await page(
    '(async function () {' +
      'var data = bytes("abc");' +
      'var after = crypto.subtle.digest("SHA-256", data);' +
      'data[0] = 0;' +
      'var during = crypto.subtle.digest({ get name() { data[0] = 97; return "SHA-256"; } }, data);' +
      'data[0] = 0;' +
      'var a = hex(await after), b = hex(await during);' +
      'out([a === b, a.slice(0, 8)].join(" "));' +
      '})();',
  );
  assert.equal(await said(doc), 'true ba7816bf');
});

test('a dictionary is read in the order Web IDL reads it', async () => {
  const doc = await page(
    '(async function () {' +
      'var seen = [];' +
      'function member(name, value) { return { get: function () { seen.push(name); return value; } }; }' +
      'var algorithm = Object.defineProperties({}, {' +
      '  name: member("name", "AES-GCM"), tagLength: member("tagLength", 128), iv: member("iv", new Uint8Array(12)), additionalData: member("additionalData", undefined),' +
      '});' +
      'var key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, ["encrypt"]);' +
      'await crypto.subtle.encrypt(algorithm, key, new Uint8Array(1));' +
      'out(seen.join(" "));' +
      '})();',
  );
  assert.equal(await said(doc), 'name name additionalData iv tagLength');
});

test('what the page says of a key changes nothing the host does', async () => {
  // a page's `JSON.parse` reads what the host tells it, so it can tell itself
  // anything: `extractable` is believed from what opened
  const doc = await page(
    '(async function () {' +
      'var parse = JSON.parse;' +
      'JSON.parse = function (text) { return parse(text.replace(\'"extractable":false\', \'"extractable":true\')); };' +
      'var key = await crypto.subtle.importKey("raw", new Uint8Array(16), "AES-GCM", false, ["encrypt"]);' +
      'JSON.parse = parse;' +
      'var r = [key.extractable];' +
      'await crypto.subtle.exportKey("raw", key).catch(function (e) { r.push(e.name); });' +
      'var wrapper = await crypto.subtle.generateKey({ name: "AES-KW", length: 128 }, false, ["wrapKey"]);' +
      'await crypto.subtle.wrapKey("raw", key, wrapper, "AES-KW").catch(function (e) { r.push(e.name); });' +
      'out(r.join(" "));' +
      '})();',
  );
  assert.equal(await said(doc), 'true InvalidAccessError InvalidAccessError');
});

test('a key as text is no use to the page that intercepts it', async () => {
  // `history.state` is serialized by the realm, so a page sees the text go
  // past, and sees it come back
  const doc = await page(
    '(async function () {' +
      'var material = bytes("0123456789abcdef");' +
      'var key = await crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt"]);' +
      'var stringify = JSON.stringify, parse = JSON.parse, text = "";' +
      'JSON.stringify = function (v) { var s = stringify(v); if (s.indexOf(\'"t":"Y"\') >= 0) text = s; return s; };' +
      'history.replaceState({ key: key }, "");' +
      'JSON.stringify = stringify;' +
      'var sealed = parse(text).e[0][1].s;' +
      'var raw = atob(sealed);' +
      'var r = [text.length > 0, raw.indexOf("0123456789abcdef"), sealed.indexOf(btoa("0123456789abcdef").slice(0, 8))];' +
      'var last = sealed.length - 8;' +
      'var edited = sealed.slice(0, last) + (sealed[last] === "A" ? "B" : "A") + sealed.slice(last + 1);' +
      'JSON.parse = function (s) { return parse(s.split(sealed).join(edited)); };' +
      'try { history.state; r.push("opened"); } catch (e) { r.push(e.name); }' +
      'JSON.parse = parse;' +
      'r.push(history.state.key instanceof CryptoKey);' +
      'out(r.join(" "));' +
      '})();',
  );
  assert.equal(await said(doc), 'true -1 -1 DataCloneError true');
});

test('crypto is an interface, and a key its own', async () => {
  const doc = await page(
    '(async function () {' +
      'var r = [Object.prototype.toString.call(crypto), Object.prototype.toString.call(crypto.subtle)];' +
      'for (var C of [Crypto, SubtleCrypto, CryptoKey]) { try { new C(); r.push("made"); } catch (e) { r.push(e.name); } }' +
      'var other = Object.getOwnPropertyDescriptor(Crypto.prototype, "subtle");' +
      'try { other.get.call({}); r.push("read"); } catch (e) { r.push(e.name); }' +
      'r.push(other.enumerable);' +
      'try { CryptoKey.prototype.type; r.push("read"); } catch (e) { r.push(e.name); }' +
      'r.push(await SubtleCrypto.prototype.digest.call({}, "SHA-256", new Uint8Array(1)).catch(function (e) { return e.name; }));' +
      'r.push(await crypto.subtle.digest("SHA-256").catch(function (e) { return e.name; }));' +
      'var pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify", "verify"]);' +
      'var key = pair.privateKey;' +
      'r.push(key.algorithm === key.algorithm, key.usages === key.usages, Object.isFrozen(key.usages), pair.publicKey.usages.join(), pair.publicKey.extractable);' +
      'key.algorithm.name = "changed";' +
      'r.push(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(1)).then(function (s) { return s.byteLength; }));' +
      'var u = crypto.randomUUID();' +
      'r.push(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u));' +
      'try { crypto.getRandomValues(new Float32Array(2)); } catch (e) { r.push(e.name); }' +
      'try { crypto.getRandomValues(new Uint8Array(65537)); } catch (e) { r.push(e.name, e instanceof QuotaExceededError, e instanceof DOMException, e.code); }' +
      'out(r.join(" "));' +
      '})();',
  );
  assert.equal(
    await said(doc),
    '[object Crypto] [object SubtleCrypto] TypeError TypeError TypeError TypeError true TypeError TypeError TypeError true true true verify true 64 true TypeMismatchError QuotaExceededError true true 22',
  );
});

test('a key is derived, wrapped and unwrapped as the page may and no further', async () => {
  const doc = await page(
    '(async function () {' +
      'var r = [];' +
      'var base = await crypto.subtle.importKey("raw", bytes("password"), "PBKDF2", false, ["deriveKey", "deriveBits"]);' +
      'var params = { name: "PBKDF2", hash: "SHA-256", salt: bytes("salt"), iterations: 1000 };' +
      'var derived = await crypto.subtle.deriveKey(params, base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);' +
      'var bits = await crypto.subtle.deriveBits(params, base, 256);' +
      'r.push(hex(await crypto.subtle.exportKey("raw", derived)) === hex(bits));' +
      'var hkdf = await crypto.subtle.deriveKey(params, base, "HKDF", false, ["deriveBits"]).catch(function (e) { return e.name; });' +
      'r.push(hkdf);' +
      'await crypto.subtle.exportKey("raw", base).catch(function (e) { r.push(e.name); });' +
      'var wrapper = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["wrapKey", "unwrapKey"]);' +
      'var iv = new Uint8Array(12);' +
      'var wrapped = await crypto.subtle.wrapKey("jwk", derived, wrapper, { name: "AES-GCM", iv: iv });' +
      'var back = await crypto.subtle.unwrapKey("jwk", wrapped, wrapper, { name: "AES-GCM", iv: iv }, "AES-GCM", false, ["decrypt"]);' +
      'r.push(back.extractable, back.usages.join(), back.algorithm.length);' +
      'await crypto.subtle.exportKey("jwk", back).catch(function (e) { r.push(e.name); });' +
      'var c = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, derived, bytes("x"));' +
      'r.push(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, back, c)));' +
      'await crypto.subtle.wrapKey("raw", back, wrapper, { name: "AES-GCM", iv: iv }).catch(function (e) { r.push(e.name); });' +
      'var jwk = await crypto.subtle.exportKey("jwk", derived);' +
      'r.push(jwk.kty, jwk.alg, jwk.ext, Array.isArray(jwk.key_ops), jwk.key_ops.join());' +
      'out(r.join(" "));' +
      '})();',
  );
  assert.equal(
    await said(doc),
    'true OperationError NotSupportedError false decrypt 256 InvalidAccessError x InvalidAccessError oct A256GCM true true encrypt,decrypt',
  );
});

/** Whether this runtime has what a test asks, as the page's host does. */
const runtime = (globalThis.crypto.subtle as unknown as Record<string, unknown>)
  .constructor as { supports?: (op: string, algorithm: string) => boolean };
const has = (op: string, algorithm: string): boolean =>
  !!runtime.supports?.(op, algorithm);

test('what the runtime has of the later methods is there, and what it lacks is not', async () => {
  const doc = await page(
    'out([typeof crypto.subtle.getPublicKey, typeof crypto.subtle.encapsulateBits, typeof SubtleCrypto.supports].join(" "));',
  );
  const subtle = globalThis.crypto.subtle as unknown as Record<string, unknown>;
  assert.equal(
    await said(doc),
    [
      typeof subtle.getPublicKey,
      typeof subtle.encapsulateBits,
      typeof runtime.supports,
    ].join(' '),
  );
});

test('a modern key is sealed as any is, and comes back whole', async (t) => {
  if (!has('generateKey', 'ML-DSA-44')) return t.skip('no ML-DSA here');
  const doc = await page(
    '(async function () {' +
      'var pair = await crypto.subtle.generateKey("ML-DSA-44", false, ["sign", "verify"]);' +
      'var copy = structuredClone(pair.privateKey);' +
      'var signature = await crypto.subtle.sign("ML-DSA-44", copy, bytes("x"));' +
      'var fine = await crypto.subtle.verify("ML-DSA-44", pair.publicKey, signature, bytes("x"));' +
      'var made = await crypto.subtle.getPublicKey(pair.privateKey, ["verify"]);' +
      'var r = [fine, made.type, made.extractable, await crypto.subtle.verify("ML-DSA-44", made, signature, bytes("x"))];' +
      'await crypto.subtle.exportKey("raw-seed", pair.privateKey).catch(function (e) { r.push(e.name); });' +
      'out(r.join(" "));' +
      '})();',
  );
  assert.equal(await said(doc), 'true public true true InvalidAccessError');
});

test('a KEM shares a secret both ends read the same', async (t) => {
  if (!has('generateKey', 'ML-KEM-768')) return t.skip('no ML-KEM here');
  const doc = await page(
    '(async function () {' +
      'var pair = await crypto.subtle.generateKey("ML-KEM-768", false, ["encapsulateBits", "decapsulateBits", "encapsulateKey", "decapsulateKey"]);' +
      'var sent = await crypto.subtle.encapsulateBits("ML-KEM-768", pair.publicKey);' +
      'var got = await crypto.subtle.decapsulateBits("ML-KEM-768", pair.privateKey, sent.ciphertext);' +
      'var key = await crypto.subtle.encapsulateKey("ML-KEM-768", pair.publicKey, "HKDF", false, ["deriveBits"]);' +
      'var back = await crypto.subtle.decapsulateKey("ML-KEM-768", pair.privateKey, key.ciphertext, "HKDF", false, ["deriveBits"]);' +
      'var params = { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(4), info: new Uint8Array(4) };' +
      'var a = await crypto.subtle.deriveBits(params, key.sharedKey, 256);' +
      'var b = await crypto.subtle.deriveBits(params, back, 256);' +
      'out([hex(sent.sharedKey) === hex(got), hex(a) === hex(b), key.sharedKey.algorithm.name].join(" "));' +
      '})();',
  );
  assert.equal(await said(doc), 'true true HKDF');
});

test('SHA-3 and ChaCha20-Poly1305 are there where the runtime has them', async (t) => {
  if (!has('generateKey', 'ChaCha20-Poly1305')) {
    return t.skip('no ChaCha20-Poly1305 here');
  }
  const doc = await page(
    '(async function () {' +
      'var d = await crypto.subtle.digest("SHA3-256", bytes("abc"));' +
      'var key = await crypto.subtle.generateKey("ChaCha20-Poly1305", false, ["encrypt", "decrypt"]);' +
      'var iv = new Uint8Array(12);' +
      'var c = await crypto.subtle.encrypt({ name: "ChaCha20-Poly1305", iv: iv }, key, bytes("hi"));' +
      'var p = await crypto.subtle.decrypt({ name: "ChaCha20-Poly1305", iv: iv }, structuredClone(key), c);' +
      'out([hex(d).slice(0, 8), new TextDecoder().decode(p)].join(" "));' +
      '})();',
  );
  assert.equal(await said(doc), '3a985da7 hi');
});

test('supports answers what a call would, as it is asked', async (t) => {
  if (!runtime.supports) return t.skip('no supports here');
  const doc = await page(
    '(async function () {' +
      'var pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);' +
      'var S = SubtleCrypto;' +
      'out([' +
      '  S.supports("digest", "SHA-256"),' +
      '  S.supports("digest", "no such"),' +
      '  S.supports("no such", "SHA-256"),' +
      '  S.supports("exportKey", "RSA-PSS"),' +
      '  S.supports("deriveBits", { name: "ECDH", public: pair.publicKey }, 256),' +
      '  S.supports("deriveBits", { name: "ECDH", public: pair.publicKey }, 257),' +
      '  S.supports("deriveBits", { name: "HKDF", hash: "SHA-1", salt: new Uint8Array(1), info: new Uint8Array(1) }, 256 * 160),' +
      '].join(" "));' +
      '})();',
  );
  // what a runtime says of this differs: Bun's asks a hash of it
  const exported = has('exportKey', 'RSA-PSS');
  assert.equal(
    await said(doc),
    `true false false ${exported} true false false`,
  );
});

test('what arrives for a frozen document waits for it, and is not lost', async () => {
  const logs: string[] = [];
  const seams = {
    handle: new Proxy({}, { get: () => () => null }),
    viewport: () => ({
      width: 0,
      height: 0,
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      dpr: 1,
      left: 0,
      top: 0,
    }),
    scrollTo() {},
    navigate() {},
    reload() {},
    go() {},
    log: (_level: string, text: string) => logs.push(text),
    title() {},
    fetch: () => Promise.reject(new Error('no network')),
    userAgent: 'test',
    language: 'en-US',
  } as unknown as HostSeams;
  const host = new DomHost(new Document([]), seams, PAGE);
  const engine = new ScriptEngine(host.bridge, {
    timeout: 2000,
    onTimeout() {},
    log: seams.log,
    settled() {},
    load: () => Promise.resolve(null),
    base: () => host.url,
  });
  host.entries = engine;
  // two answers, each its own promise: neither may be held once for the other
  engine.exec(
    'crypto.subtle.digest("SHA-256", new Uint8Array(1)).then(function (d) { console.log("first " + d.byteLength); });' +
      'crypto.subtle.digest("SHA-1", new Uint8Array(1)).then(function (d) { console.log("second " + d.byteLength); });',
    PAGE,
    0,
  );
  engine.freeze();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(logs, [], 'a frozen document hears nothing');
  engine.thaw();
  // each is its own work on the runtime's threads, and either may end first
  assert.deepEqual(logs.sort(), ['first 32', 'second 20']);
  engine.dispose();
  host.dispose();
});

const SQLITE = await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypto-probe-'));
  try {
    const profile = await HtmlProfile.open(dir);
    profile?.close();
    return !!profile;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const both = SQLITE && SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

both(
  'a key that may not be exported is kept in IndexedDB, and works after a restart',
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'crypto-profile-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const first = (await HtmlProfile.open(dir))!;
    const put = await page(
      '(async function () {' +
        'var key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);' +
        'var open = indexedDB.open("keys", 1);' +
        'open.onupgradeneeded = function () { open.result.createObjectStore("k"); };' +
        'open.onsuccess = function () {' +
        '  var tx = open.result.transaction("k", "readwrite");' +
        '  tx.objectStore("k").put(key, "one");' +
        '  tx.oncomplete = async function () { out(hex(await crypto.subtle.sign("HMAC", key, bytes("x")))); };' +
        '};' +
        '})();',
      { scripts: { storage: first.storage } },
    );
    const signed = await said(put);
    assert.match(signed, /^[0-9a-f]{64}$/);
    cleanup();
    first.close();

    const second = (await HtmlProfile.open(dir))!;
    t.after(() => second.close());
    const read = await page(
      '(function () {' +
        'var open = indexedDB.open("keys", 1);' +
        'open.onsuccess = function () {' +
        '  var get = open.result.transaction("k").objectStore("k").get("one");' +
        '  get.onsuccess = async function () {' +
        '    var key = get.result;' +
        '    var r = [key instanceof CryptoKey, key.extractable, key.usages.join(",")];' +
        '    r.push(hex(await crypto.subtle.sign("HMAC", key, bytes("x"))));' +
        '    await crypto.subtle.exportKey("raw", key).catch(function (e) { r.push(e.name); });' +
        '    out(r.join(" "));' +
        '  };' +
        '};' +
        '})();',
      { scripts: { storage: second.storage } },
    );
    assert.equal(
      await said(read),
      `true false sign,verify ${signed} InvalidAccessError`,
    );
  },
);
