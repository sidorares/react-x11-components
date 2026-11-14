// `<Html scripts>`'s `navigator.storage` and the origin private file system
// (src/html/scripts/storage-manager.ts over the host's opfs.ts): a page's
// handles, writable streams and, in a dedicated worker, sync access handles,
// over a store that is the process's memory and that a window and its workers
// share.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html, useHtmlHandle } from '../../src/html/index.js';
import type { HtmlHandle } from '../../src/html/index.js';
import { preloadHtmlScripts } from '../../src/html/scripts/hook.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FsError, opfsOp, releaseOwner } from '../../src/html/scripts/opfs.js';
import { FONTS, findById, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

interface Page {
  handle: HtmlHandle;
  text(id: string): string;
}

function textOf(node: { children?: unknown[]; data?: string } | null): string {
  if (!node) return '';
  if (typeof node.data === 'string') return node.data;
  return (node.children ?? []).map((n) => textOf(n as never)).join('');
}

/** A document at `url` whose script is `code`, in which `out(text)` is what
 *  the test reads back. Each test has a site of its own, so no two share a
 *  file system. */
async function page(code: string, url: string): Promise<Page> {
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
        'function fail(e) { out("error " + (e && e.name) + ": " + (e && e.message)); }' +
        code +
        '</script>',
      partial: false,
      ref: handle.ref,
      baseUrl: url,
      scripts: {},
    });
  }
  await renderX11(
    h(Doc),
    FONTS ? { width: 440, height: 300, fonts: FONTS } : { backend: 'mock' },
  );
  return out;
}

async function said(doc: Page, ms = 8000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    await act(() => new Promise((r) => setTimeout(r, 15)));
    const text = doc.text('out');
    if (text || Date.now() > deadline) return text;
  }
}

test('navigator.storage is a StorageManager in a secure context', async () => {
  const doc = await page(
    '(async () => {' +
      '  const s = navigator.storage;' +
      '  const e = await s.estimate();' +
      '  const root = await s.getDirectory();' +
      '  out([s instanceof StorageManager, s === navigator.storage,' +
      '    "storage" in Navigator.prototype, typeof e.usage, typeof e.quota,' +
      '    typeof e.usageDetails, await s.persisted(), await s.persist(),' +
      '    root instanceof FileSystemDirectoryHandle, root.kind, JSON.stringify(root.name),' +
      '    typeof FileSystemSyncAccessHandle,' +
      '    "createSyncAccessHandle" in FileSystemFileHandle.prototype].join(" "));' +
      '})().catch(fail);',
    'https://storage-a.test/',
  );
  assert.equal(
    await said(doc),
    'true true true number number object false false true directory "" undefined false',
  );
});

test('navigator.storage is not there in an insecure context', async () => {
  const doc = await page(
    'out([typeof navigator.storage, typeof StorageManager,' +
      ' typeof FileSystemHandle].join(" "));',
    'http://insecure.test/',
  );
  assert.equal(await said(doc), 'undefined undefined undefined');
});

test('handles make, find, list and remove entries, by path', async () => {
  const doc = await page(
    '(async () => {' +
      '  const r = [];' +
      '  const root = await navigator.storage.getDirectory();' +
      '  await root.getFileHandle("nope").catch(e => r.push(e.name));' +
      '  const dir = await root.getDirectoryHandle("d", { create: true });' +
      '  const file = await dir.getFileHandle("f.txt", { create: true });' +
      '  r.push(file.kind, file.name);' +
      '  await root.getFileHandle("d").catch(e => r.push(e.name));' +
      '  await root.getFileHandle("a/b", { create: true }).catch(e => r.push(e.constructor.name));' +
      '  await root.getFileHandle("..").catch(e => r.push(e.constructor.name));' +
      '  const names = [];' +
      '  for await (const [name, h] of root) names.push(name + ":" + h.kind);' +
      '  r.push(names.join(","));' +
      '  r.push(JSON.stringify(await root.resolve(file)), String(await dir.resolve(root)));' +
      '  const again = await root.getDirectoryHandle("d").then(d => d.getFileHandle("f.txt"));' +
      '  r.push(await again.isSameEntry(file), await dir.isSameEntry(file));' +
      '  r.push((await again.getUniqueId()) === (await file.getUniqueId()));' +
      '  await root.removeEntry("d").catch(e => r.push(e.name));' +
      '  await root.removeEntry("d", { recursive: true });' +
      '  await file.getFile().catch(e => r.push(e.name));' +
      '  out(r.join(" "));' +
      '})().catch(fail);',
    'https://storage-b.test/',
  );
  assert.equal(
    await said(doc),
    'NotFoundError file f.txt TypeMismatchError TypeError TypeError d:directory ["d","f.txt"] null true false true InvalidModificationError NotFoundError',
  );
});

test('a writable stream writes atomically, at its close', async () => {
  const doc = await page(
    '(async () => {' +
      '  const r = [];' +
      '  const root = await navigator.storage.getDirectory();' +
      '  const file = await root.getFileHandle("w.txt", { create: true });' +
      '  const text = async () => (await file.getFile()).text();' +
      '  const a = await file.createWritable();' +
      '  await a.write("1234567890");' +
      '  await a.write({ type: "write", position: 2, data: new Blob(["ab"]) });' +
      '  await a.truncate(12);' +
      '  r.push(JSON.stringify(await text()));' +
      '  await root.removeEntry("w.txt").catch(e => r.push(e.name));' +
      '  await a.close();' +
      '  r.push(JSON.stringify(await text()), (await file.getFile()).size);' +
      '  const b = await file.createWritable({ keepExistingData: true });' +
      '  await b.seek(4);' +
      '  await b.write(new Uint8Array([88, 89]));' +
      '  await b.write({ type: "seek" }).catch(e => r.push(e.name));' +
      '  await b.close().catch(e => r.push(e.constructor.name));' +
      '  r.push(JSON.stringify(await text()));' +
      '  const c = await file.createWritable({ mode: "exclusive" });' +
      '  await file.createWritable().catch(e => r.push(e.name));' +
      '  await file.move("moved.txt").catch(e => r.push(e.name));' +
      '  await c.abort();' +
      '  await file.move("moved.txt");' +
      '  r.push(file.name, JSON.stringify(await text()));' +
      '  out(r.join(" "));' +
      '})().catch(fail);',
    'https://storage-c.test/',
  );
  assert.equal(
    await said(doc),
    '"" NoModificationAllowedError "12ab567890\\u0000\\u0000" 12 SyntaxError TypeError "12ab567890\\u0000\\u0000" NoModificationAllowedError NoModificationAllowedError moved.txt "12ab567890\\u0000\\u0000"',
  );
});

test('a File read from a file that changed since is not readable', async () => {
  const doc = await page(
    '(async () => {' +
      '  const r = [];' +
      '  const root = await navigator.storage.getDirectory();' +
      '  const file = await root.getFileHandle("s.txt", { create: true });' +
      '  const w = await file.createWritable();' +
      '  await w.write("old"); await w.close();' +
      '  const snapshot = await file.getFile();' +
      '  const w2 = await file.createWritable();' +
      '  await w2.write("new"); await w2.close();' +
      '  await snapshot.text().then(t => r.push(t), e => r.push(e.name));' +
      '  r.push(await (await file.getFile()).text(), snapshot.name);' +
      '  out(r.join(" "));' +
      '})().catch(fail);',
    'https://storage-d.test/',
  );
  assert.equal(await said(doc), 'NotReadableError new s.txt');
});

test('a dedicated worker reads and writes the file its window made, synchronously', async () => {
  const worker =
    'onmessage = async (e) => {' +
    '  try {' +
    '    const file = e.data;' +
    '    const handle = await file.createSyncAccessHandle();' +
    '    const r = [handle.mode, handle.getSize()];' +
    '    const buf = new Uint8Array(5);' +
    '    r.push(handle.read(buf, { at: 0 }), new TextDecoder().decode(buf));' +
    '    r.push(handle.write(new TextEncoder().encode("XY"), { at: 1 }));' +
    '    handle.truncate(4);' +
    '    r.push(handle.getSize());' +
    '    try { await file.createWritable(); } catch (err) { r.push(err.name); }' +
    '    handle.close(); handle.close();' +
    '    try { handle.getSize(); } catch (err) { r.push(err.name); }' +
    '    postMessage(r.join(" "));' +
    '  } catch (err) { postMessage("error " + err.name + ": " + err.message); }' +
    '};';
  const doc = await page(
    '(async () => {' +
      '  const root = await navigator.storage.getDirectory();' +
      '  const file = await root.getFileHandle("shared.txt", { create: true });' +
      '  const w = await file.createWritable();' +
      '  await w.write("hello"); await w.close();' +
      `  const worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}], { type: "application/javascript" })));` +
      '  worker.onmessage = async (e) => {' +
      '    out(e.data + " | " + await (await file.getFile()).text());' +
      '  };' +
      '  worker.postMessage(file);' +
      '})().catch(fail);',
    'https://storage-e.test/',
  );
  assert.equal(
    await said(doc, 15000),
    'readwrite 5 5 hello 2 4 NoModificationAllowedError InvalidStateError | hXYl',
  );
});

test('a store keeps locks by mode and lets an owner go', () => {
  const origin = 'https://store.test';
  opfsOp(origin, 'a', 'get', '[]', 'f', 'file+');
  const siloed = opfsOp(origin, 'a', 'wopen', '["f"]', 'siloed', '');
  // siloed writables share; anything else does not
  opfsOp(origin, 'b', 'wopen', '["f"]', 'siloed', '');
  assert.throws(
    () => opfsOp(origin, 'b', 'sopen', '["f"]', 'read-only'),
    (e: unknown) =>
      e instanceof FsError && e.kind === 'NoModificationAllowedError',
  );
  assert.throws(
    () => opfsOp(origin, 'b', 'remove', '[]', 'f', ','),
    (e: unknown) =>
      e instanceof FsError && e.kind === 'NoModificationAllowedError',
  );
  opfsOp(origin, 'a', 'wclose', String(siloed));
  releaseOwner('b');
  const shared = opfsOp(origin, 'c', 'sopen', '["f"]', 'read-only');
  opfsOp(origin, 'd', 'sopen', '["f"]', 'read-only');
  assert.throws(
    () => opfsOp(origin, 'd', 'sopen', '["f"]', 'readwrite'),
    (e: unknown) =>
      e instanceof FsError && e.kind === 'NoModificationAllowedError',
  );
  opfsOp(origin, 'c', 'sclose', String(shared));
  releaseOwner('d');
  assert.equal(opfsOp(origin, 'e', 'remove', '[]', 'f', ','), true);
});
