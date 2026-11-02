// A document's HTML drag and drop (`src/html/drag.ts`, over core's), driven by
// real presses and moves in the harness, and drops from another application
// handed in as a host hands them.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, fireEvent, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import {
  Html,
  preloadHtmlScripts,
  useHtmlHandle,
} from '../../src/html/index.js';
import type { HtmlFile, HtmlHandle, HtmlProps } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, findById, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const PAGE = 'https://example.test/page.html';

interface Shown {
  logs: string[];
  until(prefix: string): Promise<string>;
  handle: HtmlHandle;
  node: DrawnNode;
  settle(): Promise<void>;
  /** The middle of an element, in the root's own pixels. */
  at(id: string): { dx: number; dy: number };
  /** Press on one element, move to another, and let go. */
  drag(from: string, to: string, release?: boolean): Promise<void>;
  release(to: string): Promise<void>;
}

const SHEET = `<style>body{margin:0}#a,#b,#c{display:block;width:120px;height:40px;margin:0 0 10px}</style>`;

async function page(
  markup: string,
  props: Partial<HtmlProps> = {},
): Promise<Shown> {
  const logs: string[] = [];
  let handle!: HtmlHandle;
  function Doc() {
    const own = useHtmlHandle();
    handle = own;
    return h(
      'box',
      { style: { flexDirection: 'column', width: 300, height: 240 } },
      h(Html, {
        source: `<!doctype html><html><body>${SHEET}${markup}</body></html>`,
        partial: false,
        baseUrl: PAGE,
        ref: own.ref,
        'data-testname': 'doc',
        ...props,
        scripts: {
          log: (level: string, line: string) =>
            void logs.push(`${level}: ${line}`),
          ...(typeof props.scripts === 'object' ? props.scripts : {}),
        },
      }),
    );
  }
  await renderX11(
    h(Doc),
    FONTS ? { width: 320, height: 260, fonts: FONTS } : { backend: 'mock' },
  );
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      await act(() => new Promise((r) => setTimeout(r, 5)));
    }
  };
  await settle();
  const node = screen.getByTestName('doc') as DrawnNode;
  const at = (id: string) => {
    // a press is aimed from the middle of the node it is on
    const rect = handle.elementRect(findById(handle.document, id)!)!;
    const { width, height } = node.abs;
    return {
      dx: Math.round(rect.x + rect.width / 2 - width / 2),
      dy: Math.round(rect.y + rect.height / 2 - height / 2),
    };
  };
  const shown: Shown = {
    logs,
    handle,
    node,
    settle,
    at,
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
    async drag(from, to, release = true) {
      const start = at(from);
      await act(async () => {
        fireEvent.mouseDown(node, start);
      });
      await act(async () => {
        fireEvent.mouseMove(node, { dx: start.dx + 8, dy: start.dy });
      });
      await settle();
      await act(async () => {
        fireEvent.mouseMove(node, at(to));
      });
      await settle();
      if (release) await shown.release(to);
    },
    async release(to) {
      await act(async () => {
        fireEvent.mouseUp(node, at(to));
      });
      await settle();
    },
  };
  return shown;
}

/** Log every drag event, in order, with what its store shows. */
const WATCH = `<script>
  const seen = [];
  window.seen = seen;
  for (const type of ['dragstart', 'drag', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend']) {
    document.addEventListener(type, (e) => {
      if (type === 'drag') return;
      seen.push(type + ':' + (e.target.id || e.target.localName));
      console.log(type, e.target.id, e.isTrusted, e.composed, e.bubbles, e.cancelable, e.dataTransfer.types.join(), JSON.stringify(e.dataTransfer.getData('text/plain')));
    }, true);
  }
</script>`;

test('a draggable element is dragged to one that takes it, in HTML’s order, with its data readable only at the drop', async () => {
  const shown = await page(
    `<div id=a draggable=true>drag</div><div id=b>drop</div>${WATCH}<script>
      a.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', 'carried');
        e.dataTransfer.setData('application/x-mine', '{"n":1}');
        e.dataTransfer.effectAllowed = 'move';
      });
      b.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
      b.addEventListener('drop', (e) => {
        e.preventDefault();
        console.log('got', e.dataTransfer.getData('application/x-mine'), e.dataTransfer.effectAllowed, e.dataTransfer.dropEffect);
      });
      a.addEventListener('dragend', (e) => console.log('ended', e.dataTransfer.dropEffect, e.buttons));
    </script>`,
  );
  await shown.drag('a', 'b');
  assert.equal(await shown.until('dragstart'), 'a true true true true  ""');
  assert.equal(
    await shown.until('dragover b'),
    'true true true true text/plain,application/x-mine ""',
  );
  assert.equal(
    await shown.until('drop b'),
    'true true true true text/plain,application/x-mine "carried"',
  );
  assert.equal(await shown.until('got'), '{"n":1} move move');
  assert.equal(await shown.until('ended'), 'move 0');
  const order = shown.handle.evaluate?.(
    'seen.filter((s, i, a) => s !== a[i - 1]).join(" ")',
  )?.text;
  assert.match(
    order ?? '',
    /dragstart:a .*dragenter:b (dragleave:\w+ )?dragover:b .*drop:b dragend:a/,
  );
});

test('a target that does not cancel dragover takes no drop', async () => {
  const shown = await page(
    `<div id=a draggable=true>drag</div><div id=b>drop</div>${WATCH}<script>
      a.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'x'));
      a.addEventListener('dragend', (e) => console.log('ended', e.dataTransfer.dropEffect));
    </script>`,
  );
  await shown.drag('a', 'b');
  assert.equal(await shown.until('ended'), 'none');
  assert.ok(
    !shown.logs.some((l) => l.startsWith('log: drop')),
    shown.logs.join('\n'),
  );
});

test('a dragstart a page cancels leaves the gesture a press, and an element nothing marked is no drag', async () => {
  const shown = await page(
    `<div id=a draggable=true>drag</div><div id=c>plain</div><div id=b>drop</div>${WATCH}<script>
      a.addEventListener('dragstart', (e) => e.preventDefault());
      document.addEventListener('mousemove', () => { window.moves = (window.moves ?? 0) + 1; });
    </script>`,
  );
  await shown.drag('a', 'b');
  assert.ok(await shown.until('dragstart'));
  assert.ok(
    !shown.logs.some((l) => l.startsWith('log: dragover')),
    shown.logs.join('\n'),
  );
  shown.logs.length = 0;
  await shown.drag('c', 'b');
  assert.ok(
    !shown.logs.some((l) => l.startsWith('log: drag')),
    shown.logs.join('\n'),
  );
});

test('a link drags its address, and text dropped in a field goes in with insertFromDrop', async () => {
  const shown = await page(
    `<a id=a href="/there">link</a><input id=b value="ab">${WATCH}<script>
      document.getElementById('b').addEventListener('input', (e) => console.log('input', e.inputType, e.target.value));
      document.addEventListener('dragstart', (e) => console.log('types', e.dataTransfer.types.join(), e.dataTransfer.getData('text/uri-list')));
    </script>`,
  );
  await shown.drag('a', 'b');
  assert.equal(
    await shown.until('types'),
    'text/uri-list,text/plain https://example.test/there',
  );
  assert.ok((await shown.until('input')).startsWith('insertFromDrop'));
});

test('the pointer is the drag’s: a pointercancel, and no mouseup or click after it', async () => {
  const shown = await page(
    `<div id=a draggable=true>drag</div><div id=b>drop</div><script>
      for (const type of ['pointercancel', 'mouseup', 'click']) {
        document.addEventListener(type, (e) => console.log('told', type));
      }
      a.addEventListener('dragend', () => console.log('ended'));
    </script>`,
  );
  await shown.drag('a', 'b');
  await shown.until('ended');
  assert.equal(await shown.until('told pointercancel'), '');
  assert.ok(!shown.logs.includes('log: told click'), shown.logs.join('\n'));
});

test('a file a page put in a drag lands as a File, and a kept dataTransfer reads nothing', async () => {
  const shown = await page(
    `<div id=a draggable=true>drag</div><div id=b>drop</div><script>
      a.addEventListener('dragstart', (e) => {
        e.dataTransfer.items.add(new File(['bytes'], 'x.txt', { type: 'text/plain', lastModified: 9 }));
      });
      b.addEventListener('dragover', (e) => {
        e.preventDefault();
        console.log('over', e.dataTransfer.files.length, e.dataTransfer.items[0].getAsFile());
      });
      b.addEventListener('drop', async (e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        const kept = e.dataTransfer;
        const entry = kept.items[0].webkitGetAsEntry();
        console.log('file', f.name, f.lastModified, await f.text());
        console.log('entry', entry.isFile, entry.name, entry.fullPath);
        console.log('after', kept.files.length);
      });
    </script>`,
  );
  await shown.drag('a', 'b');
  assert.equal(await shown.until('over'), '0 null');
  assert.equal(await shown.until('file'), 'x.txt 9 bytes');
  assert.equal(await shown.until('entry'), 'true x.txt /x.txt');
  assert.equal(await shown.until('after'), '0');
});

test('new DragEvent is a page’s, holding what it is given, and not composed by itself', async () => {
  const shown = await page(`<script>
    const dt = new DataTransfer();
    const made = new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, clientX: 3 });
    console.log('made', made.dataTransfer === dt, made.composed, made.clientX, made instanceof MouseEvent, made.isTrusted);
    console.log('plain', new DragEvent('drop').dataTransfer);
    a = document.createElement('div');
    console.log('handler', 'ondrop' in a, 'ondragstart' in document, 'ondragover' in window);
  </script>`);
  assert.equal(await shown.until('made'), 'true false 3 true false');
  assert.equal(await shown.until('plain'), 'null');
  assert.equal(await shown.until('handler'), 'true true true');
});

const FILE: HtmlFile = {
  name: 'a.txt',
  type: 'text/plain',
  lastModified: 5,
  bytes: new TextEncoder().encode('from outside'),
};

test('what another application drags names its types, and its files reach a drop through the host', async () => {
  const asked: string[][] = [];
  const shown = await page(
    `<div id=b>drop</div><script>
      b.addEventListener('dragenter', (e) => console.log('enter', e.dataTransfer.types.join(), e.dataTransfer.files.length));
      b.addEventListener('dragover', (e) => e.preventDefault());
      b.addEventListener('drop', async (e) => {
        e.preventDefault();
        console.log('drop', e.dataTransfer.types.join(), e.dataTransfer.files[0].name, await e.dataTransfer.files[0].text());
      });
    </script>`,
    {
      onDropFiles: (paths) => {
        asked.push(paths);
        return Promise.resolve([FILE]);
      },
    },
  );
  const { dx, dy } = shown.at('b');
  const box = shown.node.abs;
  const point = {
    x: box.x + box.width / 2 + dx,
    y: box.y + box.height / 2 + dy,
  };
  const types = ['text/uri-list'];
  let yes = false;
  await act(async () => {
    yes = shown.handle.dragOver({ ...point, types });
  });
  assert.equal(yes, true);
  assert.equal(await shown.until('enter'), 'Files 0');
  await act(async () => {
    await shown.handle.dropHere({ ...point, types, paths: ['/tmp/a.txt'] });
  });
  assert.deepEqual(asked, [['/tmp/a.txt']]);
  assert.equal(await shown.until('drop'), 'Files a.txt from outside');
});

test('with no host nothing from outside lands on a document, and a drag inside one still works', async () => {
  const shown = await page(
    `<div id=a draggable=true>drag</div><div id=b>drop</div>${WATCH}`,
  );
  const accept = (
    shown.node as unknown as { props: { dropAccept(t: string[]): boolean } }
  ).props.dropAccept;
  assert.equal(accept(['text/uri-list']), false);
  await shown.drag('a', 'b', false);
  assert.ok(await shown.until('dragstart'));
  await shown.release('b');
});

test('a refusal in a drag hands the page what is its own', async () => {
  const shown = await page(`<script>
    const dt = new DataTransfer();
    try { new DragEvent('x', { dataTransfer: {} }); }
    catch (e) { console.log('wrong', e.name, e.constructor === TypeError, e.constructor.constructor('return typeof process')()); }
    dt.items.add('a', 'x/y');
    try { dt.items.add('b', 'x/y'); }
    catch (e) { console.log('twice', e.name, e.constructor.constructor('return typeof process')()); }
  </script>`);
  assert.equal(await shown.until('wrong'), 'TypeError true undefined');
  assert.equal(await shown.until('twice'), 'NotSupportedError undefined');
});
