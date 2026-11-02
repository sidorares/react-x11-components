// The example browser's documents that are no page: what a response is shown
// as, the trees and viewers that show it, and what it saves and where. The
// viewers are an example, and this is their test: a type read wrongly sends a
// file to a disk that should have been shown, or a stranger's bytes to a
// player, and neither says so.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import React from 'react';
import {
  act,
  cleanup,
  createMockApp,
  fakeMediaPlayers,
  renderX11,
  screen,
  textOf,
  userEvent,
  waitFor,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { parseDocument } from 'htmlparser2';

import {
  ValueTree,
  jsonValue,
  xmlValue,
} from '../examples/browser/devtools/value-tree.js';
import type { ValueNode } from '../examples/browser/devtools/value-tree.js';
import {
  MOST_PDF,
  kindOf,
  readAll,
  readJson,
  readXml,
} from '../examples/browser/documents.js';
import type { Viewer } from '../examples/browser/documents.js';
import {
  downloadsDir,
  freeName,
  saveDownload,
} from '../examples/browser/downloads.js';
import type { DownloadState } from '../examples/browser/downloads.js';
import DocumentViewer, {
  Refusal,
  timeOf,
} from '../examples/browser/viewers.js';
import type { ViewerProps } from '../examples/browser/viewers.js';
import type { HtmlDownloadSource } from '../src/html/index.js';
import { FakeHost } from './fake-host.js';
import type { FakeSocket } from './fake-host.js';
import { FakePdfEngine } from './fake-pdf.js';
import { FONTS } from './html/harness.js';

afterEach(cleanup);

const h = React.createElement;

/** A node, with what the queries here read. */
type Shown = DrawnNode & {
  props: Record<string, unknown>;
  style: Record<string, unknown>;
};

const nodes = (where: (node: Shown) => boolean) =>
  screen.all((n) => where(n as Shown)) as Shown[];
const buttonOf = (label: string) =>
  nodes(
    (n) => n.props?.role === 'button' && (textOf(n) as string).trim() === label,
  )[0];
/** All the text there is, as `<Html>`'s tools read a tree. */
const allText = (result: { windowNode: DrawnNode }) =>
  (textOf(result.windowNode) as string).replace(/\u200b/g, '');

/** A viewer at a pane's size, with what it was told of. */
async function viewer(
  shown: Viewer,
  extra: Partial<ViewerProps> = {},
  options: Record<string, unknown> = {},
) {
  const told = { saves: 0, links: [] as string[], titles: [] as string[] };
  const element = (zoom: number) =>
    h(
      'box',
      { style: { width: 800, height: 600 } },
      h(DocumentViewer, {
        viewer: shown,
        zoom,
        onSave: () => (told.saves += 1),
        onLink: (url: string) => told.links.push(url),
        onTitle: (title: string) => told.titles.push(title),
        ...extra,
      }),
    );
  const result = await renderX11(element(1), {
    fonts: FONTS,
    width: 800,
    height: 600,
    ...options,
  } as never);
  return { told, result, element };
}

// --- what a response is ------------------------------------------------------

test('a response is shown as what its type says, and the rest is offered to be saved', () => {
  const cases: [string, string][] = [
    ['text/html', 'html'],
    ['application/xhtml+xml', 'html'],
    ['application/json', 'json'],
    ['text/json', 'json'],
    ['application/ld+json', 'json'],
    ['application/manifest+json', 'json'],
    ['application/xml', 'xml'],
    ['text/xml', 'xml'],
    ['application/rss+xml', 'xml'],
    ['application/atom+xml', 'xml'],
    ['application/pdf', 'pdf'],
    ['video/mp4', 'video'],
    ['video/webm', 'video'],
    ['audio/mpeg', 'audio'],
    ['audio/ogg', 'audio'],
    ['audio/flac', 'audio'],
    ['image/png', 'image'],
    // an image, though its type ends as XML's do
    ['image/svg+xml', 'image'],
    ['text/plain', 'text'],
    ['text/csv', 'text'],
    ['application/javascript', 'text'],
    // nothing here shows these, and none is sniffed for what it may hold
    ['application/octet-stream', 'other'],
    ['binary/octet-stream', 'other'],
    ['application/zip', 'other'],
    ['application/x-msdownload', 'other'],
    ['font/woff2', 'other'],
  ];
  for (const [type, kind] of cases) {
    assert.equal(kindOf(type, 'https://x.test/file'), kind, type);
  }
});

test('an image nothing here decodes is offered to be saved, and is no broken picture', () => {
  assert.equal(kindOf('image/x-unheard-of', 'https://x.test/a'), 'other');
});

test('with no type the address says, past its query, and HTML where it says nothing', () => {
  const cases: [string, string][] = [
    ['https://x.test/a.json?v=1', 'json'],
    ['https://x.test/a.XML#top', 'xml'],
    ['https://x.test/a.pdf?download', 'pdf'],
    ['https://x.test/a.mp3?v=1', 'audio'],
    ['https://x.test/a.FLAC', 'audio'],
    ['https://x.test/a.mp4', 'video'],
    ['https://x.test/a.txt', 'text'],
    ['https://x.test/a', 'html'],
    ['https://x.test/', 'html'],
  ];
  for (const [url, kind] of cases) assert.equal(kindOf('', url), kind, url);
});

test('text that says it is JSON or XML and is not is left to be shown as text', () => {
  assert.equal(readJson('{ not json'), null);
  assert.equal(readXml('plain words'), null);
  assert.equal(readXml('<a/><b/>'), null, 'two roots');
  assert.equal(readXml('text <a/>'), null, 'text around its root');
  assert.deepEqual(readJson('null'), { kind: 'json', value: null });
  assert.ok(readXml('<?xml version="1.0"?>\n<!-- x -->\n<a/>\n'));
});

test('XML reads no DTD, so a document cannot grow as it is read or reach for a file', () => {
  const entities = `<!DOCTYPE lolz [
    <!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
    <!ENTITY file SYSTEM "file:///etc/passwd">
  ]><root>&b;&file;</root>`;
  assert.equal(readXml(entities), null, 'it is shown as the text it is');
  const read = readXml('<root>&b;&file;</root>');
  assert.ok(read?.kind === 'xml');
  const root = read.document.children.find((n) => n.type === 'tag');
  assert.ok(root);
  assert.equal(
    xmlValue(root).text,
    '<root>&b;&file;</root>',
    'no name it is not born knowing means anything',
  );
});

test('a body is joined in order, and past its limit is refused', async () => {
  async function* body() {
    yield new Uint8Array([1, 2]);
    yield new Uint8Array([3]);
    yield new Uint8Array([4, 5, 6]);
  }
  const { signal } = new AbortController();
  assert.deepEqual([...(await readAll(body(), signal))], [1, 2, 3, 4, 5, 6]);
  await assert.rejects(readAll(body(), signal, 5), {
    code: 'ERR_FILE_TOO_BIG',
  });
  assert.ok(MOST_PDF > 32 * 1024 * 1024, 'more than a document may be');
});

// --- the trees ---------------------------------------------------------------

/** Every node of a tree, opened all the way down. */
function allOf(root: ValueNode): ValueNode[] {
  const out = [root];
  for (const node of out) out.push(...(node.load?.() ?? []));
  return out;
}

test('two properties whose paths read alike are two rows', () => {
  const nodes = allOf(jsonValue({ 'a.b': 1, a: { b: 2 } }));
  const keys = nodes.map((n) => n.key);
  assert.equal(new Set(keys).size, keys.length, keys.join(' '));
});

test('an XML element is its tag and attributes, opening on what it holds', () => {
  const document = parseDocument(
    '<feed lang="en"><!-- note --><title>A &amp; B</title> <entry id="1"><![CDATA[<raw>]]></entry><empty/></feed>',
    { xmlMode: true },
  );
  const root = xmlValue(document.children[0]);
  assert.equal(root.text, '<feed lang="en">');
  assert.deepEqual(
    root.load?.().map((n) => n.text),
    ['<!-- note -->', '<title>A & B</title>', '<entry id="1">', '<empty/>'],
    'the white space between them is nothing to show',
  );
  const entry = root.load?.()[2];
  assert.deepEqual(
    entry?.load?.().map((n) => n.text),
    ['<raw>'],
  );
});

test('a document’s tree opens as far as a screenful goes, and its long values wrap in the pane', async () => {
  const run = 'x'.repeat(5000);
  const result = await renderX11(
    h(
      'box',
      { style: { width: 500, height: 400 } },
      h(ValueTree, {
        root: jsonValue({ small: [1, 2], run, more: { a: 1 } }),
        fills: true,
      }),
    ),
    { fonts: FONTS, width: 500, height: 400 } as never,
  );
  await waitFor(() => assert.match(allText(result), /small/));
  assert.match(allText(result), /0: 1/, 'a level down is open');
  assert.match(allText(result), /a: 1/);
  assert.match(allText(result), /x…/, 'and a long one is cut short');
  const pane = nodes((n) => n.style?.overflow === 'scroll')[0];
  const label = nodes(
    (n) => n.kind === 'text' && (textOf(n) as string).length > 4000,
  )[0];
  assert.ok(pane && label);
  await waitFor(() => {
    assert.ok(
      label.abs.width <= pane.abs.width,
      `${label.abs.width} wide in a pane of ${pane.abs.width}`,
    );
    assert.ok(label.abs.height > 40, 'it took lines to say');
  });
});

test('a large array is opened and not walked: its rows are built as they are shown', async () => {
  const value = Array.from({ length: 50_000 }, (_, i) => ({ i }));
  const result = await renderX11(
    h(
      'box',
      { style: { width: 500, height: 400 } },
      h(ValueTree, { root: jsonValue(value), fills: true }),
    ),
    { fonts: FONTS, width: 500, height: 400 } as never,
  );
  await waitFor(() => assert.match(allText(result), /0: \{i: 0\}/));
  assert.ok(allText(result).length < 20_000, 'a window of the rows, no more');
});

// --- the viewers -------------------------------------------------------------

test('what cannot be shown says so, and can still be saved', async () => {
  let saves = 0;
  await renderX11(
    h(
      'box',
      { style: { width: 400, height: 300 } },
      h(Refusal, { message: 'No.', onSave: () => (saves += 1) }),
    ),
    { fonts: FONTS, width: 400, height: 300 } as never,
  );
  await userEvent.click(buttonOf('Save…'));
  assert.equal(saves, 1);
});

test('a PDF takes the browser’s zoom from its fit, and says what it is called', async () => {
  const engine = new FakePdfEngine([{ width: 400, height: 500 }]);
  const { told, result, element } = await viewer(
    { kind: 'pdf', bytes: new Uint8Array(4) },
    { engine },
  );
  const node = () =>
    nodes((n) => n.kind === 'pdfview')[0] as unknown as { _zoom: number };
  await waitFor(() => assert.ok(node()));
  await waitFor(() => assert.deepEqual(told.titles, ['fake']));
  await waitFor(() => assert.ok(node()._zoom > 1, 'fitted to the pane'));
  const fit = node()._zoom;
  await result.rerender(element(1.5));
  await waitFor(() => {
    assert.ok(Math.abs(node()._zoom - fit * 1.5) < 0.01, `${node()._zoom}`);
  });
  await result.rerender(element(1));
  await waitFor(() => assert.ok(Math.abs(node()._zoom - fit) < 0.01));
});

test('a PDF that cannot be read offers to be saved', async () => {
  const engine = new FakePdfEngine([]);
  engine.open = () => Promise.reject(new Error('no'));
  const { told, result } = await viewer(
    { kind: 'pdf', bytes: new Uint8Array(4) },
    { engine },
  );
  await waitFor(() => assert.ok(buttonOf('Save…')));
  assert.match(allText(result), /could not be read/);
  await userEvent.click(buttonOf('Save…'));
  assert.equal(told.saves, 1);
});

test('the platform’s player plays at once, and its bar moves it', async () => {
  const app = createMockApp();
  const players = fakeMediaPlayers(app);
  const { result } = await viewer(
    { kind: 'video', src: 'https://x.test/a.mp4', type: 'video/mp4' },
    {},
    { app, backend: 'mock' },
  );
  await waitFor(() => assert.ok(players.last));
  const player = players.last as NonNullable<typeof players.last> & {
    calls: [string, unknown][];
    options: { autoPlay?: boolean };
  };
  assert.equal(player.src, 'https://x.test/a.mp4');
  await act(async () => {
    player.ready({ duration: 120 });
    player.state(true);
    player.time(61);
  });
  await waitFor(() => assert.match(allText(result), /1:01 \/ 2:00/));
  // the mock has no server to press on, and a press is this
  await act(async () => (buttonOf('Pause').props.onClick as () => void)());
  await act(async () => player.state(false));
  await waitFor(() => assert.ok(buttonOf('Play')));
});

test('a video the platform’s player fails on says so, and can still be saved', async () => {
  const app = createMockApp();
  const players = fakeMediaPlayers(app);
  const { told, result } = await viewer(
    { kind: 'video', src: 'https://x.test/a.mp4', type: 'video/mp4' },
    {},
    { app, backend: 'mock' },
  );
  await waitFor(() => assert.ok(players.last));
  await act(async () => players.last!.fail());
  await waitFor(() => assert.ok(buttonOf('Save…')));
  assert.match(allText(result), /could not be played/);
  await act(async () => (buttonOf('Save…').props.onClick as () => void)());
  assert.equal(told.saves, 1);
});

test('a container the platform’s player does not read goes to a program', async () => {
  const app = createMockApp();
  const players = fakeMediaPlayers(app);
  await viewer(
    { kind: 'video', src: 'https://x.test/a.webm', type: 'video/webm' },
    { processes: new FakeHost() },
    { app, backend: 'mock' },
  );
  await waitFor(() => assert.ok(buttonOf('Play')));
  assert.equal(players.last, null, 'and the platform is asked nothing');
});

test('a program is started by a press, and never by a link being followed', async () => {
  const processes = new FakeHost({ installed: ['ffmpeg', 'ffprobe'] });
  await viewer(
    { kind: 'video', src: 'https://x.test/a.webm', type: 'video/webm' },
    { processes },
  );
  await waitFor(() => assert.ok(buttonOf('Play')));
  await act(() => new Promise<void>((go) => setTimeout(go, 50)));
  assert.deepEqual(
    processes.spawns,
    [],
    'a stranger’s file reaches no decoder',
  );
  await userEvent.click(buttonOf('Play'));
  await waitFor(() => assert.ok(processes.spawns.length));
  const { args } = processes.spawns[0] as unknown as { args: string[] };
  assert.ok(args.includes('https://x.test/a.webm'), args.join(' '));
});

test('a video with no player says so when it is asked to play, and can still be saved', async () => {
  const { told, result } = await viewer(
    { kind: 'video', src: 'https://x.test/a.mkv', type: 'video/x-matroska' },
    { processes: new FakeHost() },
  );
  await waitFor(() => assert.ok(buttonOf('Play')));
  await userEvent.click(buttonOf('Play'));
  await waitFor(() => assert.ok(buttonOf('Save…')));
  assert.match(allText(result), /needs mpv, VLC or ffmpeg/);
  assert.equal(buttonOf('Play'), undefined, 'and leaves nothing to press');
  await userEvent.click(buttonOf('Save…'));
  assert.equal(told.saves, 1);
});

// --- a sound ---------------------------------------------------------------

const MP3: Viewer = {
  kind: 'audio',
  src: 'https://x.test/song.mp3',
  type: 'audio/mpeg',
  name: 'song.mp3',
};
const OGG: Viewer = {
  ...MP3,
  src: 'https://x.test/song.ogg',
  type: 'audio/ogg',
};

/** What mpv says on its socket. */
const tell = (socket: FakeSocket, message: unknown) =>
  socket.receive(`${JSON.stringify(message)}\n`);

test('a sound is heard at once, and shows what it is called over its bar', async () => {
  const app = createMockApp();
  const players = fakeMediaPlayers(app);
  const { result } = await viewer(MP3, {}, { app, backend: 'mock' });
  await waitFor(() => assert.ok(players.last));
  const player = players.last!;
  assert.equal(player.src, 'https://x.test/song.mp3');
  assert.equal(nodes((n) => n.kind === 'video').length, 0, 'it has no picture');
  assert.equal(nodes((n) => n.kind === 'audio').length, 1);
  await act(async () => {
    player.ready({ duration: 200 });
    player.state(true);
    player.time(61);
  });
  await waitFor(() => assert.match(allText(result), /song\.mp3/));
  await waitFor(() => assert.match(allText(result), /1:01 \/ 3:20/));
  await act(async () => (buttonOf('Pause').props.onClick as () => void)());
  await act(async () => player.state(false));
  await waitFor(() => assert.ok(buttonOf('Play')));
  await act(async () => player.state(true));
  await act(async () => player.end());
  await waitFor(() => assert.ok(buttonOf('Play')));
});

test('a zoom draws a player’s bar larger, and leaves it playing', async () => {
  const app = createMockApp();
  const players = fakeMediaPlayers(app);
  const { result, element } = await viewer(MP3, {}, { app, backend: 'mock' });
  await waitFor(() => assert.ok(players.last));
  const before = players.last!;
  await act(async () => {
    before.ready({ duration: 200 });
    before.time(61);
  });
  const height = () => buttonOf('Pause').abs.height;
  const at1 = height();
  await result.rerender(element(2));
  await waitFor(() => assert.ok(height() > at1, `${height()} at ${at1}`));
  assert.equal(players.players.length, 1, 'and opens no other');
  assert.equal(before.released, false);
  assert.match(allText(result), /1:01 \/ 3:20/);
});

test('a live stream has no length to move through', async () => {
  const app = createMockApp();
  const players = fakeMediaPlayers(app);
  const { result } = await viewer(MP3, {}, { app, backend: 'mock' });
  await waitFor(() => assert.ok(players.last));
  await act(async () => {
    players.last!.ready({ duration: Infinity });
    players.last!.time(75);
  });
  await waitFor(() => assert.match(allText(result), /1:15/));
  assert.doesNotMatch(allText(result), /\//, 'it says how far, and of nothing');
  assert.equal(
    nodes((n) => n.props?.role === 'slider')[0].props.disabled,
    true,
  );
});

test('the platform’s player is asked of a type it is not known to read, and of none', async () => {
  for (const type of ['audio/flac', '']) {
    const app = createMockApp();
    const players = fakeMediaPlayers(app);
    await viewer({ ...MP3, type }, {}, { app, backend: 'mock' });
    await waitFor(() => assert.ok(players.last, type));
    await cleanup();
  }
});

test('a sound the platform’s player fails on says so, and can still be saved', async () => {
  const app = createMockApp();
  const players = fakeMediaPlayers(app);
  const { told, result } = await viewer(MP3, {}, { app, backend: 'mock' });
  await waitFor(() => assert.ok(players.last));
  await act(async () => players.last!.fail());
  await waitFor(() => assert.ok(buttonOf('Save…')));
  assert.match(allText(result), /could not be played/);
  await act(async () => (buttonOf('Save…').props.onClick as () => void)());
  assert.equal(told.saves, 1);
});

test('a container the platform’s player does not read, where nothing can be embedded, is offered to be saved', async () => {
  const app = createMockApp();
  const players = fakeMediaPlayers(app);
  const processes = new FakeHost({ installed: ['mpv'] });
  const { result } = await viewer(OGG, { processes }, { app, backend: 'mock' });
  await waitFor(() => assert.ok(buttonOf('Save…')));
  assert.match(allText(result), /no player for this audio/);
  assert.equal(players.last, null, 'and the platform is asked nothing');
  assert.deepEqual(
    processes.probed,
    [],
    'nor is PATH, for what cannot be used',
  );
});

test('a sound is no job for ffmpeg, which is silent', async () => {
  const processes = new FakeHost({ installed: ['ffmpeg', 'ffprobe'] });
  const { told, result } = await viewer(MP3, { processes });
  await waitFor(() => assert.ok(buttonOf('Save…')));
  assert.match(allText(result), /needs mpv or VLC/);
  assert.equal(buttonOf('Play'), undefined, 'and leaves nothing to press');
  assert.deepEqual(processes.spawns, []);
  await userEvent.click(buttonOf('Save…'));
  assert.equal(told.saves, 1);
});

test('a sound goes to mpv by a press, with no picture, and its bar moves it', async () => {
  const processes = new FakeHost({ installed: ['mpv', 'vlc'] });
  const { result } = await viewer(MP3, { processes });
  await waitFor(() => assert.ok(buttonOf('Play')));
  assert.match(allText(result), /song\.mp3/);
  await act(() => new Promise<void>((go) => setTimeout(go, 50)));
  assert.deepEqual(processes.spawns, [], 'a link reaches no decoder');

  await userEvent.click(buttonOf('Play'));
  await waitFor(() => assert.ok(processes.sockets.length));
  const { command, args } = processes.spawns[0] as unknown as {
    command: string;
    args: string[];
  };
  assert.match(command, /mpv$/);
  assert.ok(args.includes('--no-video'), args.join(' '));
  assert.ok(args.includes('https://x.test/song.mp3'), args.join(' '));
  await waitFor(() => assert.ok(buttonOf('Pause')));

  await act(async () => {
    tell(processes.sockets[0], { event: 'property-change', id: 2, data: 200 });
    tell(processes.sockets[0], { event: 'property-change', id: 1, data: 61 });
  });
  await waitFor(() => assert.match(allText(result), /1:01 \/ 3:20/));
});

test('a sound played to its end plays again, where mpv sits idle', async () => {
  const processes = new FakeHost({ installed: ['mpv'] });
  await viewer(MP3, { processes });
  await waitFor(() => assert.ok(buttonOf('Play')));
  await userEvent.click(buttonOf('Play'));
  await waitFor(() => assert.ok(processes.sockets.length));
  await waitFor(() => assert.ok(buttonOf('Pause')));
  await act(async () =>
    tell(processes.sockets[0], { event: 'end-file', reason: 'eof' }),
  );
  await waitFor(() => assert.ok(buttonOf('Play')));
  await userEvent.click(buttonOf('Play'));
  await waitFor(() => assert.equal(processes.spawns.length, 2));
});

test('VLC, which says nothing of having started, can be paused', async () => {
  const processes = new FakeHost({ installed: ['vlc'] });
  await viewer(MP3, { processes });
  await waitFor(() => assert.ok(buttonOf('Play')));
  await userEvent.click(buttonOf('Play'));
  await waitFor(() => assert.ok(processes.sockets.length));
  await waitFor(() => assert.ok(buttonOf('Pause')));
  await userEvent.click(buttonOf('Pause'));
  await waitFor(() => assert.ok(buttonOf('Play')));
  assert.ok(processes.sockets[0].lines().includes('pause'));
});

test('a time reads as a player’s does', () => {
  assert.equal(timeOf(0), '0:00');
  assert.equal(timeOf(65.9), '1:05');
  assert.equal(timeOf(3661), '1:01:01');
  assert.equal(timeOf(Number.NaN), '0:00');
  assert.equal(timeOf(Infinity), '0:00');
});

// --- what is saved -----------------------------------------------------------

async function folder(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'browser-documents-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function source(
  body: AsyncIterable<Uint8Array>,
  filename = 'x.bin',
): HtmlDownloadSource {
  return { url: 'https://x.test/x', filename, type: '', size: null, body };
}

const bytes = (text: string) => new TextEncoder().encode(text);

test('the dialog starts on a name that replaces nothing', async (t) => {
  const dir = await folder(t);
  assert.equal(freeName(dir, 'a.txt'), 'a.txt');
  await writeFile(join(dir, 'a.txt'), '');
  assert.equal(freeName(dir, 'a.txt'), 'a (1).txt');
  await writeFile(join(dir, 'a (1).txt'), '');
  assert.equal(freeName(dir, 'a.txt'), 'a (2).txt');
});

test('a download goes to the path the user chose, under the name that path has', async (t) => {
  const dir = await folder(t);
  const path = join(dir, 'chosen name.bin');
  const states: DownloadState[] = [];
  async function* body() {
    yield bytes('hello ');
    yield bytes('world');
  }
  await saveDownload(
    '1',
    source(body(), 'what-the-server-said.exe'),
    path,
    new AbortController().signal,
    (state) => states.push(state),
  );
  assert.equal(await readFile(path, 'utf8'), 'hello world');
  assert.deepEqual(await readdir(dir), ['chosen name.bin'], 'no part left');
  const last = states.at(-1);
  assert.equal(last?.state, 'done');
  assert.equal(last?.name, 'chosen name.bin');
  assert.equal(last?.path, path);
  assert.equal(last?.received, 11);
});

test('a file the user chose to replace stands until all of what replaces it is in', async (t) => {
  const dir = await folder(t);
  const path = join(dir, 'kept.txt');
  await writeFile(path, 'as it was');
  async function* body() {
    yield bytes('new');
    assert.equal(await readFile(path, 'utf8'), 'as it was', 'half way');
    yield bytes('er');
  }
  await saveDownload(
    '1',
    source(body()),
    path,
    new AbortController().signal,
    () => {},
  );
  assert.equal(await readFile(path, 'utf8'), 'newer');
});

test('a download that fails or is cancelled leaves the file there was, and no part', async (t) => {
  const dir = await folder(t);
  const path = join(dir, 'kept.txt');
  await writeFile(path, 'as it was');
  async function* fails() {
    yield bytes('new');
    throw new Error('the connection dropped');
  }
  const states: DownloadState[] = [];
  await saveDownload(
    '1',
    source(fails()),
    path,
    new AbortController().signal,
    (state) => states.push(state),
  );
  assert.equal(states.at(-1)?.state, 'failed');
  assert.equal(states.at(-1)?.error, 'the connection dropped');
  assert.equal(await readFile(path, 'utf8'), 'as it was');
  assert.deepEqual(await readdir(dir), ['kept.txt']);

  const stop = new AbortController();
  async function* cancelled() {
    yield bytes('new');
    stop.abort(new Error('stopped'));
    yield bytes('er');
  }
  await saveDownload('2', source(cancelled()), path, stop.signal, (state) =>
    states.push(state),
  );
  assert.equal(states.at(-1)?.state, 'cancelled');
  assert.equal(await readFile(path, 'utf8'), 'as it was');
  assert.deepEqual(await readdir(dir), ['kept.txt']);
});

test('the dialog opens where a run says, and makes that folder', async (t) => {
  const dir = await folder(t);
  const made = join(dir, 'made', 'here');
  const was = process.env.BROWSER_DOWNLOADS_DIR;
  process.env.BROWSER_DOWNLOADS_DIR = made;
  t.after(() => {
    if (was === undefined) delete process.env.BROWSER_DOWNLOADS_DIR;
    else process.env.BROWSER_DOWNLOADS_DIR = was;
  });
  assert.equal(downloadsDir(), made);
  assert.deepEqual(await readdir(made), []);
});
