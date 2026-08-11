// <MediaPlayer>: the command line each player wants, the JSON that comes back
// over mpv's socket, and the props that are commands rather than restarts.
//
// The third of those is the one worth guarding. `src`, `volume`, `muted` and
// `paused` all reach a *running* player over its control channel — a volume
// slider that respawned mpv would be unusable — so the launch key deliberately
// excludes them, and these tests are what stops one creeping back in.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { renderX11, cleanup, act, screen, waitFor } from 'react-x11/test';
import type { Node as RetainedNode } from 'react-x11/node';

import {
  MediaPlayer,
  mediaBackendsFor,
  mpv,
  vlc,
} from '../src/media-player/index.js';
import type {
  MediaPlayerHandle,
  MediaProgress,
} from '../src/media-player/index.js';
import { lineReader } from '../src/media-player/control.js';
import { FakeHost } from './fake-host.js';
import type { FakeSocket } from './fake-host.js';

const h = React.createElement;

afterEach(cleanup);

function retained(node: unknown): RetainedNode {
  return node as RetainedNode;
}

function foreignNode(): RetainedNode | undefined {
  const [node] = screen.all((n) => retained(n).kind === 'foreign');
  return node ? retained(node) : undefined;
}

/** The commands the component sent, as mpv would parse them. */
function mpvCommands(socket: FakeSocket): unknown[][] {
  return socket
    .lines()
    .map((line) => (JSON.parse(line) as { command: unknown[] }).command);
}

// --- the adapter table -----------------------------------------------------

test('mpv is handed the window and a socket to be driven through', () => {
  const args = mpv.args({
    windowId: 42,
    controlPath: '/tmp/x/sock',
    src: '/video.mkv',
    volume: 0.8,
    aspectRatio: '16:9',
    loop: true,
  });
  assert.ok(args.includes('--wid=42'));
  assert.ok(args.includes('--input-ipc-server=/tmp/x/sock'));
  assert.ok(args.includes('--idle=yes'));
  assert.ok(args.includes('--volume=80'));
  assert.ok(args.includes('--video-aspect-override=16:9'));
  assert.ok(args.includes('--loop-file=inf'));
  // the on-screen controller is the player's own chrome, and cannot be themed
  assert.ok(args.includes('--no-osc'));
  // `--` so a file called `--version` is a file
  assert.deepStrictEqual(args.slice(-2), ['--', '/video.mkv']);
});

test('autoPlay false starts mpv paused rather than not starting it', () => {
  const args = mpv.args({ windowId: 1, controlPath: '/s', autoPlay: false });
  assert.ok(args.includes('--pause=yes'));
  assert.ok(args.includes('--idle=yes'), 'still a live window with no file');
});

test('vlc embeds through --drawable-xid and takes rc on a socket', () => {
  const args = vlc.args({
    windowId: 42,
    controlPath: '/tmp/x/sock',
    src: '/video.mkv',
    aspectRatio: '4:3',
  });
  assert.ok(args.includes('--drawable-xid=42'));
  assert.ok(args.includes('--rc-unix=/tmp/x/sock'));
  assert.deepStrictEqual(
    args.slice(args.indexOf('--extraintf'), args.indexOf('--extraintf') + 2),
    ['--extraintf', 'rc'],
  );
  assert.ok(args.includes('--aspect-ratio=4:3'));
  assert.deepStrictEqual(args.slice(-2), ['--', '/video.mkv']);
});

test('only mpv claims to report progress', () => {
  assert.strictEqual(mpv.reportsProgress, true);
  // VLC's rc replies carry no request id, so they cannot be matched to the
  // question that asked for them — see src/media-player/vlc.ts.
  assert.strictEqual(vlc.reportsProgress, false);
  assert.deepStrictEqual(
    mediaBackendsFor('auto').map((b) => b.name),
    ['mpv', 'vlc'],
  );
});

// --- the line reader -------------------------------------------------------

test('a message split across two reads is still one message', () => {
  const lines: string[] = [];
  const read = lineReader((line) => lines.push(line));
  read('{"event":"start');
  read('-file"}\n{"event":"end-file"}\n{"partial"');
  assert.deepStrictEqual(lines, [
    '{"event":"start-file"}',
    '{"event":"end-file"}',
  ]);
  read(':1}\n');
  assert.strictEqual(lines.length, 3);
});

// --- the component ---------------------------------------------------------

async function mountPlayer(
  props: Record<string, unknown> = {},
): Promise<{ host: FakeHost; socket: FakeSocket }> {
  const host = new FakeHost({ installed: ['mpv'] });
  await renderX11(h(MediaPlayer, { processes: host, ...props }), {
    backend: 'xserver',
  });
  await waitFor(() => {
    assert.strictEqual(host.spawns.length, 1);
    assert.strictEqual(host.sockets.length, 1);
  });
  return { host, socket: host.sockets[0]! };
}

test('the player is spawned into the container and observed over IPC', async () => {
  const { host, socket } = await mountPlayer({ src: '/a.mkv' });

  const args = host.last!.args;
  assert.ok(args.some((a) => a.startsWith('--wid=')));
  assert.ok(args.includes(`--input-ipc-server=${host.scratch[0]!.path}`));
  assert.ok(foreignNode(), 'the surface is a <foreign>');

  // three observe_property calls, which is what makes onProgress events
  const observed = mpvCommands(socket)
    .filter((c) => c[0] === 'observe_property')
    .map((c) => c[2]);
  assert.deepStrictEqual(observed, ['time-pos', 'duration', 'pause']);
});

test('mpv property-changes become onProgress, and eof becomes onEnded', async () => {
  const progress: MediaProgress[] = [];
  let ended = 0;
  const { socket } = await mountPlayer({
    src: '/a.mkv',
    onProgress: (p: MediaProgress) => progress.push(p),
    onEnded: () => {
      ended += 1;
    },
  });

  await act(() => {
    socket.receive(
      '{"event":"property-change","id":2,"name":"duration","data":120}\n',
    );
    socket.receive(
      '{"event":"property-change","id":1,"name":"time-pos","data":12.5}\n',
    );
  });
  assert.deepStrictEqual(progress, [
    { position: 0, duration: 120 },
    { position: 12.5, duration: 120 },
  ]);

  await act(() => socket.receive('{"event":"end-file","reason":"eof"}\n'));
  assert.strictEqual(ended, 1);

  // `stop` is our own stop() and `redirect` is a playlist indirection —
  // neither is the video finishing
  await act(() => socket.receive('{"event":"end-file","reason":"stop"}\n'));
  assert.strictEqual(ended, 1);
});

test('a line that is not JSON is dropped rather than thrown', async () => {
  const { socket } = await mountPlayer({ src: '/a.mkv' });
  await act(() => socket.receive('this is not json\n{"event":"end-file"}\n'));
  // got here without throwing, which is the assertion
  assert.ok(true);
});

test('changing src loads into the running player instead of respawning it', async () => {
  const host = new FakeHost({ installed: ['mpv'] });
  const { rerender } = await renderX11(
    h(MediaPlayer, { processes: host, src: '/a.mkv' }),
    { backend: 'xserver' },
  );
  await waitFor(() => assert.strictEqual(host.sockets.length, 1));
  const socket = host.sockets[0]!;

  // the first source was on the command line, so it must not also be loaded
  assert.strictEqual(
    mpvCommands(socket).filter((c) => c[0] === 'loadfile').length,
    0,
  );

  await rerender(h(MediaPlayer, { processes: host, src: '/b.mkv' }));
  await waitFor(() =>
    assert.deepStrictEqual(
      mpvCommands(socket).filter((c) => c[0] === 'loadfile'),
      [['loadfile', '/b.mkv', 'replace']],
    ),
  );
  assert.strictEqual(host.spawns.length, 1, 'the same process throughout');
});

test('volume, mute and paused are commands, not restarts', async () => {
  const host = new FakeHost({ installed: ['mpv'] });
  const { rerender } = await renderX11(
    h(MediaPlayer, { processes: host, src: '/a.mkv', volume: 0.5 }),
    { backend: 'xserver' },
  );
  await waitFor(() => assert.strictEqual(host.sockets.length, 1));
  const socket = host.sockets[0]!;

  await rerender(
    h(MediaPlayer, {
      processes: host,
      src: '/a.mkv',
      volume: 0.25,
      muted: true,
      paused: true,
    }),
  );
  await waitFor(() => {
    const sets = mpvCommands(socket).filter((c) => c[0] === 'set_property');
    assert.ok(sets.some((c) => c[1] === 'volume' && c[2] === 25));
    assert.ok(sets.some((c) => c[1] === 'mute' && c[2] === true));
    assert.ok(sets.some((c) => c[1] === 'pause' && c[2] === true));
  });
  assert.strictEqual(host.spawns.length, 1);
});

test('a launch-only prop does restart the player', async () => {
  const host = new FakeHost({ installed: ['mpv'] });
  const { rerender } = await renderX11(
    h(MediaPlayer, { processes: host, src: '/a.mkv', aspectRatio: '16:9' }),
    { backend: 'xserver' },
  );
  await waitFor(() => assert.strictEqual(host.spawns.length, 1));

  // the aspect ratio is a command-line option in both players, so it is one
  // of the few things that cannot be changed in place
  await rerender(
    h(MediaPlayer, { processes: host, src: '/a.mkv', aspectRatio: '4:3' }),
  );
  await waitFor(() => assert.strictEqual(host.spawns.length, 2));
  assert.ok(host.spawns[1]!.args.includes('--video-aspect-override=4:3'));
  assert.deepStrictEqual(host.spawns[0]!.process.signals, ['SIGTERM']);
});

test('the handle drives the control channel', async () => {
  const host = new FakeHost({ installed: ['mpv'] });
  const ref = React.createRef<MediaPlayerHandle>();
  await renderX11(h(MediaPlayer, { processes: host, ref, src: '/a.mkv' }), {
    backend: 'xserver',
  });
  await waitFor(() => assert.strictEqual(host.sockets.length, 1));
  const socket = host.sockets[0]!;

  ref.current!.pause();
  ref.current!.play();
  ref.current!.seek(42);
  ref.current!.setVolume(1);
  ref.current!.stop();

  const commands = mpvCommands(socket);
  assert.ok(
    commands.some(
      (c) => c[0] === 'set_property' && c[1] === 'pause' && c[2] === true,
    ),
  );
  assert.ok(
    commands.some(
      (c) => c[0] === 'set_property' && c[1] === 'pause' && c[2] === false,
    ),
  );
  assert.ok(
    commands.some((c) => c[0] === 'seek' && c[1] === 42 && c[2] === 'absolute'),
  );
  assert.ok(commands.some((c) => c[0] === 'stop'));

  assert.strictEqual(ref.current!.backend, 'mpv');
  assert.strictEqual(ref.current!.reportsProgress, true);
});

test('unmounting closes the socket, removes the scratch dir and signals mpv', async () => {
  const { host, socket } = await mountPlayer({ src: '/a.mkv' });
  const child = host.last!.process;

  await cleanup();

  assert.strictEqual(socket.closed, true, 'the control channel is dropped');
  assert.deepStrictEqual(child.signals, ['SIGTERM']);
  assert.strictEqual(host.scratch[0]!.disposed, true, 'no socket left in /tmp');
});

test('a control channel that opens after unmount is still closed', async () => {
  // The socket does not exist until mpv creates it, so the connect can land
  // seconds after the spawn — and after the component has gone. Whoever wins
  // that race, the socket must not survive it.
  const host = new FakeHost({ installed: ['mpv'] });
  host.holdConnect = true;

  await renderX11(h(MediaPlayer, { processes: host, src: '/a.mkv' }), {
    backend: 'xserver',
  });
  await waitFor(() => assert.strictEqual(host.sockets.length, 1));
  const socket = host.sockets[0]!;
  assert.strictEqual(socket.closed, false, 'precondition: still connecting');

  await cleanup();
  await act(() => host.releaseConnects());
  await act();

  assert.strictEqual(socket.closed, true, 'no socket left open');
  assert.strictEqual(host.scratch[0]!.disposed, true);
});

test('no player installed renders the fallback', async () => {
  const host = new FakeHost({ installed: [] });
  const errors: Error[] = [];
  await renderX11(
    h(MediaPlayer, {
      processes: host,
      src: '/a.mkv',
      onError: (err: Error) => errors.push(err),
      fallback: h('text', { 'data-testname': 'no-player' }, 'install mpv'),
    }),
    { backend: 'xserver' },
  );

  await waitFor(() => assert.ok(screen.getByTestName('no-player')));
  assert.strictEqual(foreignNode(), undefined);
  assert.match(errors[0]!.message, /no media player backend is installed/);
  assert.match(errors[0]!.message, /mpv, vlc/);
});

test('the surface is not focusable by default', async () => {
  await mountPlayer({ src: '/a.mkv' });
  // an embedded player that took the focus would swallow the app's keys
  assert.strictEqual(foreignNode()?.props.focusable, false);
});

test('vlc gets write-only control and says so', async () => {
  const host = new FakeHost({ installed: ['vlc'] });
  const ref = React.createRef<MediaPlayerHandle>();
  await renderX11(h(MediaPlayer, { processes: host, ref, src: '/a.mkv' }), {
    backend: 'xserver',
  });
  await waitFor(() => assert.strictEqual(host.sockets.length, 1));
  const socket = host.sockets[0]!;

  assert.strictEqual(ref.current!.reportsProgress, false);

  // `pause` in the rc protocol toggles, so the intended state is tracked and
  // a pause that changes nothing sends nothing
  ref.current!.pause();
  ref.current!.pause();
  ref.current!.play();
  ref.current!.seek(30);
  ref.current!.setVolume(0.5);
  assert.deepStrictEqual(socket.lines(), [
    'pause',
    'play',
    'seek 30',
    'volume 128',
  ]);
});
