// `<input type=file>`: its control, what a host gives it (`onPickFiles`), what
// a form posts of it, and what a page's scripts read.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import {
  act,
  cleanup,
  fireEvent,
  renderX11,
  screen,
  userEvent,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import {
  Html,
  acceptFilters,
  fileTypeOf,
  preloadHtmlScripts,
  useHtmlHandle,
} from '../../src/html/index.js';
import type {
  FormSubmission,
  HtmlFile,
  HtmlFileRequest,
  HtmlHandle,
  HtmlPickFiles,
  HtmlProps,
} from '../../src/html/index.js';
import { formSubmission } from '../../src/html/form.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, findById, h, metric, render, view } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const PAGE = 'https://example.test/page.html';

const text = (s: string) => new TextEncoder().encode(s);
const FILE: HtmlFile = {
  name: 'notes.txt',
  type: 'text/plain',
  lastModified: 1700000000000,
  bytes: text('héllo'),
};
const PICTURE: HtmlFile = {
  name: 'a "b".png',
  type: 'image/png',
  lastModified: 1700000000001,
  bytes: new Uint8Array([0x89, 0x50, 0, 255, 10, 13]),
};

/** What a host answers, with each request it had. */
function picker(answer: HtmlFile[] | null): HtmlPickFiles & {
  asked: HtmlFileRequest[];
} {
  const asked: HtmlFileRequest[] = [];
  const pick = ((request: HtmlFileRequest) => {
    asked.push(request);
    return Promise.resolve(answer);
  }) as HtmlPickFiles & { asked: HtmlFileRequest[] };
  pick.asked = asked;
  return pick;
}

interface Shown {
  logs: string[];
  until(prefix: string): Promise<string>;
  handle: HtmlHandle;
  node: DrawnNode;
  settle(): Promise<void>;
  press(): Promise<void>;
}

async function page(
  markup: string,
  props: Partial<HtmlProps> = {},
): Promise<Shown> {
  const logs: string[] = [];
  let handle!: HtmlHandle;
  function Doc() {
    const own = useHtmlHandle();
    handle = own;
    return h(Html, {
      source: `<!doctype html><html><body>${markup}</body></html>`,
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
    });
  }
  await renderX11(
    h(Doc),
    FONTS ? { width: 420, height: 200, fonts: FONTS } : { backend: 'mock' },
  );
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      await act(() => new Promise((r) => setTimeout(r, 5)));
    }
  };
  await settle();
  const node = screen.getByTestName('doc') as DrawnNode;
  return {
    logs,
    handle,
    node,
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
  };
}

/** The file input's button, and a press on it. */
async function pressChoose(label = 'Choose File'): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: label }));
  for (let i = 0; i < 4; i += 1) {
    await act(() => new Promise((r) => setTimeout(r, 5)));
  }
}

metric(
  'a file input is a button and what it holds, as wide as Blink’s',
  async () => {
    const { node } = await render('<input type=file id=f>', 500, {
      onPickFiles: picker(null),
    });
    const box = view(node).elementRect(
      findById(view(node).document, 'f') as never,
    );
    assert.ok(box && box.width > 180 && box.width < 320, `width ${box?.width}`);
    assert.ok(screen.getByRole('button', { name: 'Choose File' }));
    assert.ok(screen.getByText('No file chosen'));
  },
);

metric(
  'a press asks the host, with what the input accepts, and what it answers goes in the input',
  async () => {
    const pick = picker([FILE]);
    const shown = await page(
      `<input id=f type=file accept=".PNG, image/*,text/plain"><script>
      const f = document.getElementById('f');
      for (const type of ['click', 'input', 'change', 'cancel']) {
        f.addEventListener(type, (e) => console.log(type, e.bubbles, e.isTrusted, f.files.length, f.value));
      }
    </script>`,
      { onPickFiles: pick },
    );
    await pressChoose();
    assert.deepEqual(pick.asked[0].accept, ['.png', 'image/*', 'text/plain']);
    assert.equal(pick.asked[0].multiple, false);
    assert.equal(pick.asked[0].element.attribs.id, 'f');
    assert.equal(await shown.until('click'), 'true true 0');
    assert.equal(
      await shown.until('input'),
      'true true 1 C:\\fakepath\\notes.txt',
    );
    assert.equal(
      await shown.until('change'),
      'true true 1 C:\\fakepath\\notes.txt',
    );
    assert.ok(screen.getByText('notes.txt'), 'it says what it holds');
  },
);

metric(
  'a dialog cancelled tells cancel and leaves the input as it was',
  async () => {
    const pick = picker(null);
    const shown = await page(
      `<input id=f type=file><script>
      const f = document.getElementById('f');
      f.addEventListener('cancel', (e) => console.log('cancel', e.bubbles, f.files.length));
      f.addEventListener('change', () => console.log('change'));
    </script>`,
      { onPickFiles: pick },
    );
    await pressChoose();
    assert.equal(await shown.until('cancel'), 'true 0');
    assert.ok(!shown.logs.includes('log: change'));
  },
);

metric('a click the page cancels opens nothing', async () => {
  const pick = picker([FILE]);
  await page(
    `<input id=f type=file><script>
      document.getElementById('f').addEventListener('click', (e) => e.preventDefault());
    </script>`,
    { onPickFiles: pick },
  );
  await pressChoose();
  assert.equal(pick.asked.length, 0);
});

metric(
  'with no host a file input opens nothing and holds nothing',
  async () => {
    const shown = await page(
      `<input id=f type=file><script>
      const f = document.getElementById('f');
      f.addEventListener('click', () => console.log('click', f.files.length));
      f.addEventListener('change', () => console.log('change'));
    </script>`,
    );
    await pressChoose();
    assert.equal(await shown.until('click'), '0');
    assert.ok(!shown.logs.includes('log: change'));
  },
);

test('a page’s File is the page’s, read as it asks, and the same one each time', async () => {
  const shown = await page(
    `<input id=f type=file multiple><script>
      const f = document.getElementById('f');
      console.log('empty', f.files.length, f.files === f.files, f.files instanceof FileList);
      console.log('other', document.createElement('input').files);
      f.addEventListener('change', async () => {
        const list = f.files;
        console.log('list', list.length, list === f.files, list[0] instanceof File, list[0] instanceof Blob);
        console.log('one', list[0].name, list[0].type, list[0].size, list[0].lastModified);
        console.log('text', await list[0].text());
        console.log('bytes', new Uint8Array(await list[1].arrayBuffer()).join());
        console.log('slice', await list[0].slice(0, 1).text());
        console.log('realm', list[0].constructor === File, list[0].constructor.constructor('return typeof process')());
        const data = new FormData();
        data.append('f', list[1]);
        console.log('data', data.get('f') === list[1]);
        const read = new FileReader();
        read.onload = () => console.log('reader', read.result);
        read.readAsText(list[0]);
      });
      document.addEventListener('mousedown', () => f.click());
    </script>`,
    { onPickFiles: picker([FILE, PICTURE]) },
  );
  assert.equal(await shown.until('empty'), '0 true true');
  assert.equal(await shown.until('other'), 'null');
  await shown.press();
  assert.equal(await shown.until('list'), '2 true true true');
  assert.equal(
    await shown.until('one'),
    'notes.txt text/plain 6 1700000000000',
  );
  assert.equal(await shown.until('text'), 'héllo');
  assert.equal(await shown.until('bytes'), '137,80,0,255,10,13');
  assert.equal(await shown.until('slice'), 'h');
  assert.equal(await shown.until('realm'), 'true undefined');
  assert.equal(await shown.until('data'), 'true');
  assert.equal(await shown.until('reader'), 'héllo');
});

test('a script’s click needs a gesture behind it, and showPicker says so', async () => {
  const pick = picker([FILE]);
  const shown = await page(
    `<input id=f type=file style="display:none"><script>
      const f = document.getElementById('f');
      f.click();
      try { f.showPicker(); } catch (e) { console.log('picker', e.name, e.constructor === DOMException); }
      console.log('ran');
      document.addEventListener('mousedown', () => f.showPicker());
    </script>`,
    { onPickFiles: pick },
  );
  assert.equal(await shown.until('picker'), 'NotAllowedError true');
  await shown.until('ran');
  assert.equal(pick.asked.length, 0);
  await shown.press();
  assert.equal(pick.asked.length, 1);
});

test('a file input is hidden from nothing: a page’s own button asks through one with no box', async () => {
  const pick = picker([FILE]);
  const shown = await page(
    `<input id=f type=file style="display:none"><script>
      const f = document.getElementById('f');
      f.addEventListener('change', () => console.log('change', f.files[0].name));
      document.addEventListener('mousedown', () => f.click());
    </script>`,
    { onPickFiles: pick },
  );
  await shown.press();
  assert.equal(await shown.until('change'), 'notes.txt');
});

test('value is its filename mode: read as a fake path, and set only to nothing', async () => {
  const shown = await page(
    `<input id=f type=file><script>
      const f = document.getElementById('f');
      f.addEventListener('change', () => {
        console.log('held', f.value);
        try { f.value = 'x'; } catch (e) { console.log('set', e.name); }
        f.value = '';
        console.log('cleared', f.files.length, JSON.stringify(f.value));
      });
      document.addEventListener('mousedown', () => f.click());
    </script>`,
    { onPickFiles: picker([FILE]) },
  );
  await shown.press();
  assert.equal(await shown.until('held'), 'C:\\fakepath\\notes.txt');
  assert.equal(await shown.until('set'), 'InvalidStateError');
  assert.equal(await shown.until('cleared'), '0 ""');
});

test('a required input is valid once it holds a file, and a form’s FormData has its files', async () => {
  const shown = await page(
    `<form id=form><input id=f name=up type=file required multiple><input id=e name=empty type=file></form><script>
      const f = document.getElementById('f');
      const form = document.getElementById('form');
      console.log('before', f.checkValidity(), f.matches(':invalid'));
      const none = new FormData(form).getAll('empty');
      console.log('none', none.length, none[0] instanceof File, JSON.stringify(none[0].name), none[0].type);
      f.addEventListener('change', () => {
        console.log('after', f.checkValidity(), f.matches(':valid'));
        const all = new FormData(form).getAll('up');
        console.log('form', all.length, all[0] === f.files[0], all[1].name);
      });
      document.addEventListener('mousedown', () => f.click());
    </script>`,
    { onPickFiles: picker([FILE, PICTURE]) },
  );
  assert.equal(await shown.until('before'), 'false true');
  assert.equal(await shown.until('none'), '1 true "" application/octet-stream');
  await shown.press();
  assert.equal(await shown.until('after'), 'true true');
  assert.equal(await shown.until('form'), '2 true a "b".png');
});

test('a reset empties it, and files takes another input’s list with no event', async () => {
  const shown = await page(
    `<form id=form><input id=f name=up type=file></form><input id=g type=file><script>
      const f = document.getElementById('f');
      const g = document.getElementById('g');
      g.addEventListener('change', () => console.log('told'));
      f.addEventListener('change', () => {
        const file = f.files[0];
        g.files = f.files;
        console.log('moved', g.files.length, g.files[0] === file);
        g.files = null;
        console.log('kept', g.files.length);
        try { g.files = []; } catch (e) { console.log('list', e.name); }
        document.getElementById('form').reset();
        console.log('reset', f.files.length, JSON.stringify(f.value), g.files.length);
      });
      document.addEventListener('mousedown', () => f.click());
    </script>`,
    { onPickFiles: picker([FILE]) },
  );
  await shown.press();
  assert.equal(await shown.until('moved'), '1 true');
  assert.equal(await shown.until('kept'), '1');
  assert.equal(await shown.until('list'), 'TypeError');
  assert.equal(await shown.until('reset'), '0 "" 1');
  assert.ok(!shown.logs.includes('log: told'));
});

const decode = (body: FormSubmission['body']) =>
  typeof body === 'string' ? body : new TextDecoder('latin1').decode(body!);

test('a form posts its files as multipart/form-data, each with its name, its type and its bytes', async () => {
  const sent: FormSubmission[] = [];
  const shown = await page(
    `<form id=form enctype=multipart/form-data method=post action=/up>
      <input name=title value=x>
      <input id=f name=up type=file multiple>
      <input id=e name=empty type=file>
     </form><script>
      const f = document.getElementById('f');
      f.addEventListener('change', () => document.getElementById('form').requestSubmit());
      document.addEventListener('mousedown', () => f.click());
    </script>`,
    {
      onPickFiles: picker([FILE, PICTURE]),
      onSubmit: (s) => void sent.push(s),
    },
  );
  await shown.press();
  await shown.settle();
  await act(() => new Promise((r) => setTimeout(r, 30)));
  assert.equal(sent.length, 1);
  const [submission] = sent;
  assert.ok(submission.body instanceof Uint8Array);
  const boundary = /boundary=(.*)$/.exec(submission.contentType!)![1];
  assert.equal(
    decode(submission.body),
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="title"',
      '',
      'x',
      `--${boundary}`,
      'Content-Disposition: form-data; name="up"; filename="notes.txt"',
      'Content-Type: text/plain',
      '',
      new TextDecoder('latin1').decode(FILE.bytes),
      `--${boundary}`,
      'Content-Disposition: form-data; name="up"; filename="a %22b%22.png"',
      'Content-Type: image/png',
      '',
      new TextDecoder('latin1').decode(PICTURE.bytes),
      `--${boundary}`,
      'Content-Disposition: form-data; name="empty"; filename=""',
      'Content-Type: application/octet-stream',
      '',
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n'),
  );
});

test('with no files a multipart form stays text, and a GET names the file', async () => {
  const sent: FormSubmission[] = [];
  const shown = await page(
    `<form id=form enctype=multipart/form-data method=post action=/up><input name=up type=file></form>
     <form id=get action=/search><input id=g name=up type=file></form><script>
      const g = document.getElementById('g');
      g.addEventListener('change', () => document.getElementById('get').requestSubmit());
      document.addEventListener('mousedown', () => g.click());
    </script>`,
    {
      onPickFiles: picker([FILE]),
      onSubmit: (s) => void sent.push(s),
      scripts: {
        navigate: (url: string) => void sent.push({ url } as FormSubmission),
      },
    },
  );
  await shown.press();
  await shown.settle();
  await act(() => new Promise((r) => setTimeout(r, 30)));
  const gone = sent.at(-1)?.url ?? '';
  assert.ok(gone.endsWith('/search?up=notes.txt'), gone);
  const doc = shown.handle.document!;
  const form = findById(doc, 'form') as never;
  const empty = formSubmission(form, null, {
    base: PAGE,
    documentUrl: PAGE,
    live: () => undefined,
    boundary: 'b',
  });
  assert.equal(typeof empty?.body, 'string');
  assert.ok(String(empty?.body).includes('filename=""'));
});

test('a preload a script puts in hears load or error, which a page’s loader waits on before it adds the script', async () => {
  const shown = await page(
    `<script>
      for (const [name, href] of [['ok', '/app.js'], ['missing', '/gone.js'], ['failed', '/down.js']]) {
        const link = document.createElement('link');
        link.rel = 'preload';
        link.as = 'script';
        link.href = href;
        link.onload = () => console.log(name, 'load');
        link.onerror = () => console.log(name, 'error');
        document.head.appendChild(link);
      }
    </script>`,
    {
      scripts: {
        fetch: (request) =>
          request.url.endsWith('/down.js')
            ? Promise.reject(new Error('no network'))
            : Promise.resolve({
                url: request.url,
                status: request.url.endsWith('/gone.js') ? 404 : 200,
                statusText: '',
                headers: [],
                body: '',
                redirected: false,
              } as never),
      },
    },
  );
  assert.equal(await shown.until('ok'), 'load');
  assert.equal(await shown.until('missing'), 'error');
  assert.equal(await shown.until('failed'), 'error');
});

/** The smallest PNG there is: a pixel, by a harness of its own. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('an image shows a File the page was given, through a blob URL, before anything is uploaded', async () => {
  const shown = await page(
    `<script>
      (async () => {
        const bytes = Uint8Array.from(atob('${PIXEL}'), (c) => c.charCodeAt(0));
        const file = new File([bytes], 'p.png', { type: 'image/png' });
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => console.log('load', img.naturalWidth, img.complete);
        img.onerror = () => console.log('load failed');
        img.src = url;
        await img.decode();
        console.log('decoded');
        const other = URL.createObjectURL(file);
        URL.revokeObjectURL(other);
        const gone = new Image();
        gone.onerror = () => console.log('revoked');
        gone.src = other;
      })();
    </script>`,
  );
  assert.equal(await shown.until('load'), '1 true');
  await shown.until('decoded');
  await shown.until('revoked');
});

test('a File stays one, and an ImageData clones, across a worker', async () => {
  const shown = await page(
    `<script>
      const copy = structuredClone(new ImageData(new Uint8ClampedArray([1, 2, 3, 4]), 1, 1));
      console.log('clone', copy instanceof ImageData, copy.data.join(), copy.width);
      const source = 'onmessage = (e) => postMessage([e.data.file.name, e.data.file.lastModified, e.data.file instanceof File, e.data.image.data.join(), e.data.image.width, e.data.when.getTime()])';
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      worker.onmessage = (e) => console.log('worker', e.data.join(' '));
      worker.postMessage({
        file: new File(['x'], 'a.txt', { lastModified: 5 }),
        image: new ImageData(new Uint8ClampedArray([9, 8, 7, 6]), 1, 1),
        when: new Date(7),
      });
    </script>`,
  );
  assert.equal(await shown.until('clone'), 'true 1,2,3,4 1');
  assert.equal(await shown.until('worker'), 'a.txt 5 true 9,8,7,6 1 7');
});

nodeTest('what an input accepts is what a dialog is asked to show', () => {
  assert.deepEqual(acceptFilters([]), []);
  const [filter] = acceptFilters(['.pdf', 'image/*', 'application/json']);
  assert.ok(filter.extensions?.includes('pdf'));
  assert.ok(filter.extensions?.includes('png'));
  assert.deepEqual(filter.mimeTypes, ['application/json']);
});

nodeTest(
  'a file’s type goes by its extension, and is nothing where it says none',
  () => {
    assert.equal(fileTypeOf('a.PNG'), 'image/png');
    assert.equal(fileTypeOf('a.tar.gz'), 'application/gzip');
    assert.equal(fileTypeOf('a.unknown'), '');
    assert.equal(fileTypeOf('.png'), '');
    assert.equal(fileTypeOf('plain'), '');
  },
);
