// `<Html scripts>` and the clipboard: the data store (`src/html/scripts/
// datatransfer.ts`), the `copy`, `cut` and `paste` a chord is told as, and
// `navigator.clipboard` (`src/html/scripts/clipboard.ts`), over the
// `clipboard` seam, which holds what it is written here (`memoryClipboard`).
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, fireEvent, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import {
  Html,
  memoryClipboard,
  preloadHtmlScripts,
  useHtmlHandle,
} from '../../src/html/index.js';
import type {
  HtmlHandle,
  HtmlClipboard,
  HtmlPermissions,
  HtmlPermissionState,
} from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const PAGE = 'https://example.test/page.html';

/** A page's permissions, each as a test sets it. */
function permissions(
  held: Record<string, HtmlPermissionState> = {},
  answer: HtmlPermissionState = 'denied',
): HtmlPermissions & { asked: string[] } {
  const out = {
    asked: [] as string[],
    state: (name: string) => held[name] ?? 'prompt',
    request(name: string, origin: string) {
      out.asked.push(`${name} ${origin}`);
      held[name] = answer;
      return Promise.resolve(answer);
    },
  };
  return out;
}

interface Shown {
  logs: string[];
  /** The text after a logged prefix, once it has been logged. */
  until(prefix: string): Promise<string>;
  node: DrawnNode;
  handle: HtmlHandle;
  /** A press of the document: a user's gesture. */
  press(): Promise<void>;
  /** A letter with the primary modifier held. */
  chord(letter: string): Promise<void>;
  /** Turns of the page, with nothing waited on. */
  settle(): Promise<void>;
}

/** A page whose scripts run, and what they log. */
async function page(
  markup: string,
  options: {
    clipboard?: HtmlClipboard;
    permissions?: HtmlPermissions;
    url?: string;
    modifier?: 'Control' | 'Super';
  } = {},
): Promise<Shown> {
  const logs: string[] = [];
  let handle!: HtmlHandle;
  function Doc() {
    const own = useHtmlHandle();
    handle = own;
    return h(Html, {
      source: `<!doctype html><html><body>${markup}</body></html>`,
      partial: false,
      baseUrl: options.url ?? PAGE,
      ref: own.ref,
      'data-testname': 'doc',
      scripts: {
        ...(options.clipboard ? { clipboard: options.clipboard } : {}),
        ...(options.permissions ? { permissions: options.permissions } : {}),
        log: (level: string, text: string) =>
          void logs.push(`${level}: ${text}`),
      },
    });
  }
  await renderX11(
    h(Doc),
    FONTS ? { width: 300, height: 200, fonts: FONTS } : { backend: 'mock' },
  );
  const node = screen.getByTestName('doc') as DrawnNode;
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      await act(() => new Promise((r) => setTimeout(r, 5)));
    }
  };
  await settle();
  return {
    logs,
    node,
    handle,
    settle,
    async until(prefix) {
      const end = Date.now() + 5000;
      const found = () => logs.find((l) => l.startsWith(`log: ${prefix}`));
      while (!found() && Date.now() < end) {
        await act(() => new Promise((r) => setTimeout(r, 5)));
      }
      const line = found();
      assert.ok(line, `no "${prefix}" in:\n${logs.join('\n')}`);
      return line.slice(`log: ${prefix}`.length).trim();
    },
    async press() {
      await act(async () => {
        fireEvent.mouseDown(node, {});
        fireEvent.mouseUp(node, {});
      });
      await settle();
    },
    async chord(letter) {
      await act(async () => {
        fireEvent.key(letter.charCodeAt(0), {
          modifiers: [options.modifier ?? 'Control'],
        });
      });
      await settle();
    },
  };
}

// --- the data store ----------------------------------------------------------

test('a DataTransfer holds what HTML says, and its types are a frozen array that changes only with it', async () => {
  const shown = await page(`<script>
    const dt = new DataTransfer();
    console.log('modes', dt.dropEffect, dt.effectAllowed);
    const before = dt.types;
    console.log('same', before === dt.types, Object.isFrozen(before));
    dt.setData('Text', 'hi');
    dt.setData('text/uri-list', '# a comment\\nhttps://a.test/\\nhttps://b.test/');
    console.log('types', dt.types.join(), dt.types === before);
    console.log('read', dt.getData('text/plain'), dt.getData('TEXT'), dt.getData('URL'));
    console.log('list', dt.items.length, dt.items[0].kind, dt.items[0].type);
    dt.items[0].getAsString((s) => console.log('string', s));
    console.log('none', dt.items[0].getAsFile());
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    const files = dt.files;
    const item = dt.items.add(file);
    console.log('files', files.length, files === dt.files, files[0] === file, dt.types.join(), item.getAsFile() === file);
    dt.clearData();
    console.log('cleared', dt.items.length, dt.types.join(), dt.getData('text'));
    try { dt.items.add('a', 'x/y'); dt.items.add('b', 'x/y'); }
    catch (e) { console.log('twice', e.name, e instanceof DOMException); }
    dt.items.remove(0);
    console.log('removed', item.kind === '', dt.files.length);
    dt.items.clear();
    dt.dropEffect = 'wrong';
    dt.effectAllowed = 'copyMove';
    console.log('effects', dt.dropEffect, dt.effectAllowed);
    console.log('indexed', Object.keys(dt.items).length, 0 in dt.items);
  </script>`);
  assert.equal(await shown.until('modes'), 'none none');
  assert.equal(await shown.until('same'), 'true true');
  assert.equal(await shown.until('types'), 'text/plain,text/uri-list false');
  assert.equal(await shown.until('read'), 'hi hi https://a.test/');
  assert.equal(await shown.until('list'), '2 string text/plain');
  assert.equal(await shown.until('none'), 'null');
  assert.equal(
    await shown.until('files'),
    '1 true true text/plain,text/uri-list,Files true',
  );
  assert.equal(await shown.until('cleared'), '1 Files');
  assert.equal(await shown.until('twice'), 'NotSupportedError true');
  assert.equal(await shown.until('removed'), 'true 0');
  assert.equal(await shown.until('effects'), 'none copyMove');
  assert.equal(await shown.until('indexed'), '0 false');
  assert.equal(await shown.until('string'), 'hi');
});

test('a ClipboardEvent a page makes is not composed, and holds what it was given', async () => {
  const shown = await page(`<script>
    const plain = new ClipboardEvent('paste', { bubbles: true });
    console.log('plain', plain.composed, plain.clipboardData, plain instanceof Event);
    const dt = new DataTransfer();
    console.log('given', new ClipboardEvent('copy', { clipboardData: dt }).clipboardData === dt);
    try { new ClipboardEvent('copy', { clipboardData: {} }); }
    catch (e) { console.log('wrong', e.name); }
    console.log('window', 'DataTransfer' in window, 'ClipboardEvent' in window);
  </script>`);
  assert.equal(await shown.until('plain'), 'false null true');
  assert.equal(await shown.until('given'), 'true');
  assert.equal(await shown.until('wrong'), 'TypeError');
});

// --- the chord ---------------------------------------------------------------

test('a page that cancels a copy puts what it wrote on the clipboard, and it is a trusted, composed event', async () => {
  const clipboard = memoryClipboard();
  const shown = await page(
    `<p id=p>text</p><script>
      document.addEventListener('copy', (e) => {
        console.log('copy', e.isTrusted, e.composed, e.cancelable, e.bubbles, e.target.localName, e.clipboardData.types.length);
        e.clipboardData.setData('text/plain', 'from the page');
        e.clipboardData.setData('text/html', '<b>from the page</b>');
        window.kept = e.clipboardData;
        e.preventDefault();
      });
    </script>`,
    { clipboard },
  );
  await shown.press();
  await shown.chord('c');
  assert.equal(await shown.until('copy'), 'true true true true body 0');
  assert.deepEqual(clipboard.data, {
    'text/plain': 'from the page',
    'text/html': '<b>from the page</b>',
  });
});

test('a store outlives its event protected: a page keeps none of what was pasted', async () => {
  const clipboard = memoryClipboard({ 'text/plain': 'secret' });
  const shown = await page(
    `<script>
      document.addEventListener('paste', (e) => {
        console.log('during', e.clipboardData.getData('text/plain'), e.clipboardData.items.length);
        const kept = e.clipboardData;
        setTimeout(() => console.log('after', JSON.stringify(kept.getData('text/plain')), kept.items.length, kept.types.join()), 0);
        e.preventDefault();
      });
    </script>`,
    { clipboard },
  );
  await shown.press();
  await shown.chord('v');
  assert.equal(await shown.until('during'), 'secret 1');
  assert.equal(await shown.until('after'), '"" 1 text/plain');
});

test('a page that cancels a copy and writes nothing leaves the clipboard as it was', async () => {
  const clipboard = memoryClipboard({ 'text/plain': 'before' });
  const shown = await page(
    `<script>
      document.addEventListener('copy', (e) => { e.preventDefault(); console.log('copy'); });
    </script>`,
    { clipboard },
  );
  await shown.press();
  await shown.chord('c');
  await shown.until('copy');
  assert.deepEqual(clipboard.data, { 'text/plain': 'before' });
});

test('a paste no listener takes goes into the field at its selection, with beforeinput and input', async () => {
  const clipboard = memoryClipboard({ 'text/plain': 'pasted\nnext' });
  const shown = await page(
    `<input id=i value="ab"><textarea id=t>xy</textarea><script>
      const i = document.getElementById('i');
      const t = document.getElementById('t');
      for (const el of [i, t]) {
        el.addEventListener('beforeinput', (e) => console.log('before', el.id, e.inputType, JSON.stringify(e.data)));
        el.addEventListener('input', (e) => console.log('input', el.id, e.inputType, JSON.stringify(el.value), el.selectionStart));
      }
      window.go = (el) => { el.focus(); el.setSelectionRange(1, 1); };
      window.go(i);
    </script>`,
    { clipboard },
  );
  await shown.settle();
  await shown.chord('v');
  assert.equal(await shown.until('before i'), 'insertFromPaste "pasted next"');
  assert.equal(
    await shown.until('input i'),
    'insertFromPaste "apasted nextb" 12',
  );
  shown.logs.length = 0;
  shown.handle.evaluate?.(`window.go(t)`);
  await shown.settle();
  await shown.chord('v');
  assert.equal(
    await shown.until('input t'),
    'insertFromPaste "xpasted\\nnexty" 12',
  );
});

test('a paste a listener cancels leaves the field alone', async () => {
  const clipboard = memoryClipboard({ 'text/plain': 'pasted' });
  const shown = await page(
    `<input id=i value="ab"><script>
      const i = document.getElementById('i');
      i.focus();
      i.addEventListener('paste', (e) => { e.preventDefault(); console.log('taken', e.clipboardData.getData('text')); });
      i.addEventListener('input', () => console.log('input'));
    </script>`,
    { clipboard },
  );
  await shown.settle();
  await shown.chord('v');
  assert.equal(await shown.until('taken'), 'pasted');
  await shown.settle();
  assert.ok(!shown.logs.includes('log: input'), shown.logs.join('\n'));
});

test('a paste in an editing host goes in as text with a beforeinput that holds it', async () => {
  const clipboard = memoryClipboard({ 'text/plain': 'one\ntwo' });
  const shown = await page(
    `<div id=e contenteditable>ab</div><script>
      const e = document.getElementById('e');
      e.focus();
      getSelection().collapse(e.firstChild, 1);
      e.addEventListener('beforeinput', (ev) => console.log('before', ev.inputType, ev.data, ev.dataTransfer.getData('text/plain').length));
      e.addEventListener('input', () => console.log('html', e.innerHTML));
    </script>`,
    { clipboard },
  );
  await shown.settle();
  await shown.chord('v');
  assert.equal(await shown.until('before'), 'insertFromPaste null 7');
  assert.equal(await shown.until('html'), 'aone<br>twob');
});

test('a picture on the clipboard reaches a paste as a file', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const clipboard = memoryClipboard({ 'image/png': bytes });
  const shown = await page(
    `<script>
      document.addEventListener('paste', async (e) => {
        const f = e.clipboardData.files[0];
        console.log('kind', e.clipboardData.items[0].kind, e.clipboardData.items[0].type, e.clipboardData.types.join());
        console.log('file', f.name, f.type, f.size, new Uint8Array(await f.arrayBuffer()).join());
      });
    </script>`,
    { clipboard },
  );
  await shown.press();
  await shown.chord('v');
  assert.equal(await shown.until('kind'), 'file image/png Files');
  assert.equal(
    await shown.until('file'),
    'image.png image/png 7 137,80,78,71,1,2,3',
  );
});

test('a cut in an editing host puts the selection on the clipboard and takes it out', async () => {
  const clipboard = memoryClipboard();
  const shown = await page(
    `<div id=e contenteditable>abcd</div><script>
      const e = document.getElementById('e');
      e.focus();
      const r = document.createRange();
      r.setStart(e.firstChild, 1);
      r.setEnd(e.firstChild, 3);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      e.addEventListener('input', (ev) => console.log('input', ev.inputType, e.textContent));
    </script>`,
    { clipboard },
  );
  await shown.settle();
  await shown.chord('x');
  assert.equal(await shown.until('input'), 'deleteByCut ad');
  assert.deepEqual(clipboard.data, { 'text/plain': 'bc' });
});

test('the chord is the primary modifier: Cmd on a backend that says so', async () => {
  const clipboard = memoryClipboard();
  const shown = await page(
    `<script>
      document.addEventListener('copy', () => console.log('copy'));
    </script>`,
    { clipboard, modifier: 'Super' },
  );
  await shown.press();
  await shown.chord('c');
  assert.ok(!shown.logs.includes('log: copy'), 'Super is no chord on X11');
  (
    shown.node as unknown as { app: { primaryModifier?: string } }
  ).app.primaryModifier = 'Super';
  await shown.chord('c');
  await shown.until('copy');
});

test('with no clipboard a page reaches none: nothing is written, nothing is read, and there is no navigator.clipboard', async () => {
  const shown = await page(
    `<input id=i value="field"><script>
      console.log('api', 'clipboard' in navigator, 'Clipboard' in window, 'ClipboardItem' in window);
      console.log('supported', document.queryCommandSupported('copy'), document.queryCommandEnabled('copy'));
      document.addEventListener('copy', (e) => { e.clipboardData.setData('text/plain', 'x'); e.preventDefault(); console.log('copy'); });
      document.addEventListener('paste', (e) => { console.log('paste', e.clipboardData.types.length); });
      document.addEventListener('mousedown', () => {
        console.log('command', document.execCommand('copy'));
      });
    </script>`,
  );
  assert.equal(await shown.until('api'), 'false false false');
  assert.equal(await shown.until('supported'), 'false false');
  await shown.press();
  assert.equal(await shown.until('command'), 'false');
  await shown.chord('c');
  await shown.until('copy');
  await shown.chord('v');
  assert.equal(await shown.until('paste'), '0');
});

// --- navigator.clipboard -----------------------------------------------------

test('navigator.clipboard is a secure context’s alone', async () => {
  const shown = await page(
    `<script>console.log('api', 'clipboard' in navigator, 'Clipboard' in window);</script>`,
    { clipboard: memoryClipboard(), url: 'http://example.test/' },
  );
  assert.equal(await shown.until('api'), 'false false');
});

test('writeText needs a gesture, and what it hands a page that has none is the page’s own', async () => {
  const clipboard = memoryClipboard();
  const shown = await page(
    `<script>
      navigator.clipboard.writeText('no').catch((e) => {
        console.log('refused', e.name, e instanceof DOMException, e instanceof Error);
        // what a refusal hands the page reaches nothing of the host's
        console.log('escape', e.constructor.constructor('return typeof process')());
      });
      window.go = () => navigator.clipboard.writeText('yes').then(() => console.log('wrote'));
      document.addEventListener('mousedown', window.go);
    </script>`,
    { clipboard },
  );
  assert.equal(await shown.until('refused'), 'NotAllowedError true true');
  assert.equal(await shown.until('escape'), 'undefined');
  assert.deepEqual(clipboard.data, {});
  await shown.press();
  await shown.until('wrote');
  assert.deepEqual(clipboard.data, { 'text/plain': 'yes' });
});

test('a write granted needs no gesture, and one denied has none that helps', async () => {
  const granted = memoryClipboard();
  const one = await page(
    `<script>navigator.clipboard.writeText('a').then(() => console.log('wrote'));</script>`,
    {
      clipboard: granted,
      permissions: permissions({ 'clipboard-write': 'granted' }),
    },
  );
  await one.until('wrote');
  assert.deepEqual(granted.data, { 'text/plain': 'a' });
  cleanup();
  const denied = memoryClipboard();
  const two = await page(
    `<script>
      document.addEventListener('mousedown', () =>
        navigator.clipboard.writeText('a').catch((e) => console.log('refused', e.name)));
    </script>`,
    {
      clipboard: denied,
      permissions: permissions({ 'clipboard-write': 'denied' }),
    },
  );
  await two.press();
  assert.equal(await two.until('refused'), 'NotAllowedError');
  assert.deepEqual(denied.data, {});
});

test('a read asks after a gesture, and only then; and with nothing to ask it is refused', async () => {
  const clipboard = memoryClipboard({ 'text/plain': 'on it' });
  const asking = permissions({}, 'granted');
  const shown = await page(
    `<script>
      navigator.clipboard.readText().catch((e) => console.log('early', e.name));
      document.addEventListener('mousedown', () =>
        navigator.clipboard.readText().then((t) => console.log('read', t)));
    </script>`,
    { clipboard, permissions: asking },
  );
  assert.equal(await shown.until('early'), 'NotAllowedError');
  assert.deepEqual(asking.asked, []);
  await shown.press();
  assert.equal(await shown.until('read'), 'on it');
  assert.deepEqual(asking.asked, ['clipboard-read https://example.test']);
  cleanup();
  const none = await page(
    `<script>
      document.addEventListener('mousedown', () =>
        navigator.clipboard.readText().catch((e) => console.log('no', e.name, e.message)));
    </script>`,
    { clipboard },
  );
  await none.press();
  assert.equal(
    await none.until('no'),
    'NotAllowedError Read permission denied.',
  );
});

test('navigator.permissions says what is held, not what it was before anything was asked', async () => {
  const shown = await page(
    `<script>
      (async () => {
        const read = await navigator.permissions.query({ name: 'clipboard-read' });
        const write = await navigator.permissions.query({ name: 'clipboard-write' });
        console.log('states', read.state, write.state);
      })();
    </script>`,
    {
      clipboard: memoryClipboard(),
      permissions: permissions({ 'clipboard-read': 'granted' }),
    },
  );
  assert.equal(await shown.until('states'), 'granted prompt');
});

test('read hands a ClipboardItem, with what it read of HTML made safe', async () => {
  const clipboard = memoryClipboard({
    'text/plain': 'plain',
    'text/html':
      '<p onclick="x()">safe<script>alert(1)</script></p><img src=x onerror=y()>',
    'image/png': new Uint8Array([1, 2]),
  });
  const shown = await page(
    `<script>
      (async () => {
        const [item] = await navigator.clipboard.read();
        console.log('types', item.types.join(), item instanceof ClipboardItem);
        console.log('html', await (await item.getType('text/html')).text());
        console.log('png', (await item.getType('image/png')).size, (await item.getType('image/png')).type);
        const [raw] = await navigator.clipboard.read({ unsanitized: ['text/html'] });
        console.log('raw', (await (await raw.getType('text/html')).text()).includes('onerror'));
        await item.getType('text/nope').catch((e) => console.log('missing', e.name));
      })();
    </script>`,
    {
      clipboard,
      permissions: permissions({ 'clipboard-read': 'granted' }),
    },
  );
  assert.equal(
    await shown.until('types'),
    'text/plain,text/html,image/png true',
  );
  assert.equal(await shown.until('html'), '<p>safe</p><img src="x">');
  assert.equal(await shown.until('png'), '2 image/png');
  assert.equal(await shown.until('raw'), 'true');
  assert.equal(await shown.until('missing'), 'NotFoundError');
});

test('write takes a type at a time, strings and promises alike, and turns down what a clipboard cannot hold', async () => {
  const clipboard = memoryClipboard();
  const shown = await page(
    `<script>
      (async () => {
        console.log('supports', ClipboardItem.supports('text/plain'), ClipboardItem.supports('web x/y'), ClipboardItem.supports('application/abc'));
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': 'text',
          'text/html': Promise.resolve(new Blob(['<b>x</b>'], { type: 'text/html' })),
          'image/png': new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9])], { type: 'image/png' }),
          'web custom/type': 'mine',
        })]);
        console.log('wrote');
        await navigator.clipboard.write([new ClipboardItem({ 'application/abc': 'x' })]).catch((e) => console.log('type', e.name));
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': 'a' }), new ClipboardItem({ 'text/plain': 'b' })]).catch((e) => console.log('two', e.name));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': 'x' })]).catch((e) => console.log('string', e.name));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob(['not one'], { type: 'image/png' }) })]).catch((e) => console.log('image', e.name));
        await navigator.clipboard.write('no').catch((e) => console.log('list', e.name));
        await navigator.clipboard.write(['no']).catch((e) => console.log('item', e.name));
      })();
    </script>`,
    {
      clipboard,
      permissions: permissions({ 'clipboard-write': 'granted' }),
    },
  );
  assert.equal(await shown.until('supports'), 'true true false');
  await shown.until('wrote');
  assert.equal(clipboard.data['text/plain'], 'text');
  assert.equal(clipboard.data['text/html'], '<b>x</b>');
  assert.equal((clipboard.data['image/png'] as Uint8Array).at(-1), 9);
  assert.equal(clipboard.data['web custom/type'], 'mine');
  assert.equal(await shown.until('type'), 'NotAllowedError');
  assert.equal(await shown.until('two'), 'NotAllowedError');
  assert.equal(await shown.until('string'), 'TypeError');
  assert.equal(await shown.until('image'), 'DataError');
  assert.equal(await shown.until('list'), 'TypeError');
  assert.equal(await shown.until('item'), 'TypeError');
});

test('execCommand copies what is selected in a field, under a gesture, after its event', async () => {
  const clipboard = memoryClipboard();
  const shown = await page(
    `<input id=i value="field text"><script>
      const i = document.getElementById('i');
      console.log('early', document.execCommand('copy'));
      document.addEventListener('copy', (e) => console.log('copy', e.isTrusted));
      document.addEventListener('mousedown', () => {
        i.focus();
        i.setSelectionRange(0, 5);
        console.log('command', document.execCommand('copy'), document.queryCommandSupported('copy'));
      });
    </script>`,
    { clipboard },
  );
  assert.equal(await shown.until('early'), 'false');
  await shown.press();
  assert.equal(await shown.until('copy'), 'true');
  assert.equal(await shown.until('command'), 'true true');
  assert.deepEqual(clipboard.data, { 'text/plain': 'field' });
});

test('a clipboard that refuses is a page’s NotAllowedError', async () => {
  const clipboard: HtmlClipboard = {
    read: () => Promise.reject(new Error('host error')),
    write: () => Promise.reject(new Error('host error')),
  };
  const shown = await page(
    `<script>
      (async () => {
        const e = await navigator.clipboard.writeText('x').catch((e) => e);
        console.log('write', e.name, e.message, e.constructor === DOMException);
        const r = await navigator.clipboard.readText().catch((e) => e);
        console.log('read', r.name, r.constructor === DOMException);
      })();
    </script>`,
    {
      clipboard,
      permissions: permissions({
        'clipboard-write': 'granted',
        'clipboard-read': 'granted',
      }),
    },
  );
  assert.equal(
    await shown.until('write'),
    'NotAllowedError Write permission denied. true',
  );
  assert.equal(await shown.until('read'), 'NotAllowedError true');
});
