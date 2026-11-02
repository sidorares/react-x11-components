// What leaves a document as a file: `onDownload`, the realm's `<a download>`,
// the names one goes by, and `HtmlNetwork` handing a host what it saves.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, fireEvent, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import {
  Html,
  HtmlNetwork,
  dispositionOf,
  downloadName,
  preloadHtmlScripts,
  safeFilename,
} from '../../src/html/index.js';
import type { HtmlDownloadRequest, HtmlProps } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, h, metric } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const PAGE = 'https://example.test/dir/page.html';

interface Shown {
  saved: HtmlDownloadRequest[];
  followed: string[];
  node: DrawnNode;
  logs: string[];
  until(prefix: string): Promise<string>;
  press(): Promise<void>;
}

async function page(
  markup: string,
  props: Partial<HtmlProps> & { noHost?: boolean } = {},
): Promise<Shown> {
  const saved: HtmlDownloadRequest[] = [];
  const followed: string[] = [];
  const logs: string[] = [];
  const { noHost, ...rest } = props;
  await renderX11(
    h(
      'box',
      { style: { width: 300, height: 200, flexDirection: 'column' } },
      h(Html, {
        source: `<!doctype html><html><body style="margin:0">${markup}</body></html>`,
        partial: false,
        baseUrl: PAGE,
        'data-testname': 'doc',
        onLink: (href: string) => void followed.push(href),
        ...(!noHost && {
          onDownload: (request: HtmlDownloadRequest) =>
            void saved.push(request),
        }),
        ...rest,
      }),
    ),
    FONTS ? { width: 320, height: 220, fonts: FONTS } : { backend: 'mock' },
  );
  const node = screen.getByTestName('doc') as DrawnNode;
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      await act(() => new Promise((r) => setTimeout(r, 5)));
    }
  };
  await settle();
  return {
    saved,
    followed,
    node,
    logs,
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
        fireEvent.mouseDown(node, { dy: -90, dx: -140 });
        fireEvent.mouseUp(node, { dy: -90, dx: -140 });
      });
      await settle();
    },
  };
}

const LINK = (attrs: string) =>
  `<style>a{display:block;height:40px}</style><a ${attrs}>link</a>`;

metric(
  'a link that says to save what it names goes to the host, with no script',
  async () => {
    const shown = await page(LINK('href="report.pdf" download="out.pdf"'));
    await shown.press();
    assert.deepEqual(shown.saved, [
      { url: 'https://example.test/dir/report.pdf', filename: 'out.pdf' },
    ]);
    assert.deepEqual(shown.followed, []);
  },
);

metric('with no host a download link is a link', async () => {
  const shown = await page(LINK('href="report.pdf" download'), {
    noHost: true,
  });
  await shown.press();
  assert.deepEqual(shown.followed, ['https://example.test/dir/report.pdf']);
});

metric('another origin’s download attribute says nothing', async () => {
  const shown = await page(
    LINK('href="https://other.test/x.pdf" download="y.pdf"'),
  );
  await shown.press();
  assert.deepEqual(shown.saved, []);
  assert.deepEqual(shown.followed, ['https://other.test/x.pdf']);
});

const logged = (logs: string[]) => ({
  scripts: {
    log: (level: string, line: string) => void logs.push(`${level}: ${line}`),
  },
});

test('a blob a page made goes to the host with its bytes, from a link that is in no document', async () => {
  const logs: string[] = [];
  const shown = await page(
    `<script>
      const blob = new Blob(['saved bytes'], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'notes.txt';
      a.click();
      console.log('clicked');
    </script>`,
    logged(logs),
  );
  shown.logs.push(...logs);
  for (let i = 0; i < 20 && !shown.saved.length; i += 1) {
    await act(() => new Promise((r) => setTimeout(r, 5)));
  }
  assert.equal(shown.saved.length, 1);
  const [{ url, filename, bytes, type }] = shown.saved;
  assert.match(url, /^blob:/);
  assert.equal(filename, 'notes.txt');
  assert.equal(type, 'text/plain');
  assert.equal(new TextDecoder().decode(bytes), 'saved bytes');
});

test('a data: URL and a page’s own file are saved, and a click a page cancels saves nothing', async () => {
  const shown = await page(
    `<a id=d href="data:text/plain,hi" download="d.txt"></a>
     <a id=c href="own.bin" download></a>
     <a id=n href="never.bin" download></a><script>
      n.addEventListener('click', (e) => e.preventDefault());
      d.click();
      c.click();
      n.click();
    </script>`,
    { scripts: {} },
  );
  for (let i = 0; i < 20 && shown.saved.length < 2; i += 1) {
    await act(() => new Promise((r) => setTimeout(r, 5)));
  }
  assert.deepEqual(
    shown.saved.map((s) => [s.url, s.filename]),
    [
      ['data:text/plain,hi', 'd.txt'],
      ['https://example.test/dir/own.bin', ''],
    ],
  );
});

nodeTest('Content-Disposition reads as RFC 6266 has it', () => {
  assert.deepEqual(dispositionOf(null), { attachment: false, filename: null });
  assert.deepEqual(dispositionOf('inline'), {
    attachment: false,
    filename: null,
  });
  assert.deepEqual(dispositionOf('inline; filename="a.pdf"'), {
    attachment: false,
    filename: 'a.pdf',
  });
  assert.deepEqual(dispositionOf('attachment; filename="a b.pdf"'), {
    attachment: true,
    filename: 'a b.pdf',
  });
  assert.equal(
    dispositionOf('ATTACHMENT; FileName=plain.txt').filename,
    'plain.txt',
  );
  assert.equal(
    dispositionOf(
      `attachment; filename="plain.txt"; filename*=UTF-8''%e2%82%ac%20rates.txt`,
    ).filename,
    '€ rates.txt',
  );
  assert.equal(
    dispositionOf(`attachment; filename*=iso-8859-1''%A3.txt`).filename,
    '£.txt',
  );
  assert.equal(
    dispositionOf('attachment; filename="say \\"hi\\".txt"').filename,
    'say "hi".txt',
  );
  // an unknown type is one to save
  assert.equal(dispositionOf('weird').attachment, true);
});

nodeTest('a name a server gives can do nothing but name a file', () => {
  assert.equal(safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeFilename('..\\..\\autoexec.bat'), 'autoexec.bat');
  assert.equal(safeFilename('.bashrc'), 'bashrc');
  assert.equal(safeFilename('a\u0000b\nc.txt'), 'a_b_c.txt');
  assert.equal(safeFilename('name. . '), 'name');
  assert.equal(safeFilename('...'), '');
  assert.equal(safeFilename('CON.txt'), '_CON.txt');
  const long = safeFilename(`${'x'.repeat(300)}.tar`);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('.tar'));
});

nodeTest(
  'a download goes by the response, the attribute, the URL and its type, in that order',
  () => {
    const url = 'https://example.test/files/report%201.pdf?x=1';
    const header = 'attachment; filename="from-server.pdf"';
    // as Chrome, Firefox and Safari have it
    assert.equal(downloadName(url, 'mine.pdf', header, ''), 'from-server.pdf');
    assert.equal(downloadName(url, '', header, ''), 'from-server.pdf');
    assert.equal(downloadName(url, 'mine.pdf', 'attachment', ''), 'mine.pdf');
    assert.equal(downloadName(url, 'mine.pdf', null, ''), 'mine.pdf');
    assert.equal(downloadName(url, '', null, ''), 'report 1.pdf');
    assert.equal(
      downloadName('https://example.test/', '', null, 'image/png'),
      'download.png',
    );
    assert.equal(
      downloadName('blob:https://example.test/1234', '', null, 'text/plain'),
      'download.txt',
    );
    assert.equal(
      downloadName(
        'data:application/zip;base64,AA',
        '',
        null,
        'application/zip',
      ),
      'download.zip',
    );
    assert.equal(
      downloadName('https://example.test/', '', null, ''),
      'download',
    );
  },
);

nodeTest(
  'a network hands over what is saved as it arrives, past a document’s limit, by the response’s name',
  async (t) => {
    const piece = Buffer.alloc(2 ** 20, 7);
    const count = 40;
    const server = createServer((request, response) => {
      response.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': piece.length * count,
        'content-disposition': `attachment; filename="big.zip"`,
      });
      for (let i = 0; i < count; i += 1) response.write(piece);
      response.end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    t.after(() => server.close());
    const { port } = server.address() as AddressInfo;
    const network = new HtmlNetwork();
    const source = await network.download(
      { url: `http://127.0.0.1:${port}/get`, filename: '' },
      new AbortController().signal,
    );
    assert.equal(source.filename, 'big.zip');
    assert.equal(source.size, piece.length * count);
    assert.equal(source.type, 'application/zip');
    let total = 0;
    for await (const chunk of source.body) total += chunk.length;
    assert.equal(total, piece.length * count);
  },
);

nodeTest('a page’s bytes need no network', async () => {
  const network = new HtmlNetwork();
  const source = await network.download(
    {
      url: 'blob:https://example.test/1',
      filename: 'made.txt',
      bytes: new TextEncoder().encode('made'),
      type: 'text/plain',
    },
    new AbortController().signal,
  );
  assert.equal(source.filename, 'made.txt');
  assert.equal(source.size, 4);
  const chunks: Uint8Array[] = [];
  for await (const chunk of source.body) chunks.push(chunk);
  assert.equal(new TextDecoder().decode(chunks[0]), 'made');
});
