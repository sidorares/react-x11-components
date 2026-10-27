// <Html> — `<audio>`: core's `<audio>` mounted for each audio element a page
// plays (`src/html/sounds.ts`, `HtmlViewNode._publishSounds`), playing what
// the host answers for `kind: 'audio'`, over the player core's test kit
// gives an app that has none (`fakeMediaPlayers`); and a page's media
// element whose clock and end follow what that player says.
import { afterEach, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  cleanup,
  createMockApp,
  fakeMediaPlayers,
  renderX11,
  screen,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import { Html, useHtmlHandle } from '../../src/html/index.js';
import type {
  HtmlHandle,
  ResourceRequest,
  ResourceResult,
} from '../../src/html/index.js';
import type { Element as DocElement } from '../../src/html/dom.js';
import { preloadHtmlScripts, useScripts } from '../../src/html/scripts/hook.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import type { ScriptsOptions } from '../../src/html/scripts/runner.js';
import { findById, h } from './harness.js';

afterEach(cleanup);

await preloadHtmlScripts();

const scriptedTest = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;
const test = nodeTest;

const PAGE = 'https://example.test/dir/page.html';

/** Let the page's turns run, and the renders after them. */
async function settle(ms = 20) {
  for (let i = 0; i < 4; i += 1) {
    await act(() => new Promise((r) => setTimeout(r, ms / 4)));
  }
}

/** Until `done` holds, or three seconds. */
async function until(done: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await settle();
}

type AudioNode = DrawnNode & { props: Record<string, unknown> };

const audios = () =>
  screen.all((n) => n.kind === 'audio') as unknown as AudioNode[];

function textOf(node: { children?: unknown[]; data?: string }): string {
  if (typeof node.data === 'string') return node.data;
  return (node.children ?? []).map((n) => textOf(n as never)).join('');
}

/**
 * `source` in an `<Html>` over a mock app with a player that plays
 * nothing, its scripts run where `scripts` says, and each `kind: 'audio'`
 * request answered with its URL — or, by `answer`, declined.
 */
async function mount(
  source: string,
  {
    scripts = false,
    answer = (url: string): string | null => url,
  }: { scripts?: boolean; answer?: (url: string) => string | null } = {},
) {
  const app = createMockApp();
  const players = fakeMediaPlayers(app);
  const asked: ResourceRequest[] = [];
  const out = {
    handle: null as unknown as HtmlHandle,
    exec: (_code: string): void => {},
  };
  const seams: ScriptsOptions = {
    userAgent: 'test',
    language: 'en-US',
    viewport: () => ({
      width: 400,
      height: 300,
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      dpr: 1,
      left: 0,
      top: 0,
    }),
    scrollTo: () => {},
    navigate: () => {},
    reload: () => {},
    go: () => {},
    log: () => {},
    title: () => {},
    fetch: async () => {
      throw new Error('no network');
    },
    load: async () => null,
    onTimeout: () => {},
  };
  function Page() {
    const handle = useHtmlHandle();
    out.handle = handle;
    const run = useScripts(scripts, handle, PAGE, seams);
    out.exec = (code) => void run.runner?.()?.engine.exec(code, 'test', 0);
    return h(Html, {
      source,
      partial: false,
      ref: handle.ref,
      baseUrl: PAGE,
      onResource: (request: ResourceRequest): ResourceResult | null => {
        if (request.kind !== 'audio') return null;
        asked.push(request);
        const src = answer(request.url);
        return src === null ? null : { kind: 'audio', src };
      },
      ...run,
      // as `useScriptedHtml` hands it to `<Html>`, an internal prop
      ...({ _onMediaEvent: run.mediaEvent } as object),
    });
  }
  await renderX11(h('box', { style: { width: 400 } }, h(Page)), {
    app,
    backend: 'mock',
  });
  await settle();
  const byId = (id: string) => findById(out.handle.document, id) as DocElement;
  return {
    players,
    asked,
    handle: out.handle,
    byId,
    text: (id: string) => textOf(byId(id) as never),
    /** Runs `code` in the page's realm. */
    exec: (code: string) => act(() => out.exec(code)),
  };
}

test('an <audio> asks for its source once a page plays it, and is played by core’s <audio>', async () => {
  const doc = await mount(
    '<audio id="a" src="voice.mp3" loop></audio><p>read aloud</p>',
  );
  // a length, as an empty `deepEqual` would leave `asked` a `never[]`
  assert.equal(doc.asked.length, 0, 'nothing asked for before it plays');
  assert.equal(audios().length, 0);
  const el = doc.byId('a');
  await act(() => doc.handle.setMediaState(el, { paused: false, volume: 0.5 }));
  await until(() => audios().length === 1);
  assert.deepEqual(
    doc.asked.map((r) => [r.kind, r.url, r.element === el]),
    [['audio', 'https://example.test/dir/voice.mp3', true]],
  );
  const [node] = audios();
  assert.equal(node.props.src, 'https://example.test/dir/voice.mp3');
  assert.equal(node.props.paused, false);
  assert.equal(node.props.volume, 0.5);
  assert.equal(node.props.loop, true);
  const player = doc.players.last!;
  assert.equal(player.options.element, 'audio');
  assert.equal(player.options.autoPlay, true);
  // what a script asks next goes to the player that is playing
  await act(() => doc.handle.setMediaState(el, { paused: true }));
  await act(() => doc.handle.setMediaState(el, { currentTime: 3 }));
  await settle();
  assert.equal(doc.players.players.length, 1, 'the same player');
  assert.deepEqual(player.calls, [
    ['set', { paused: true }],
    ['seek', 3],
  ]);
});

test('its end lets the player go, and a play after it is a new player from the start', async () => {
  const doc = await mount('<audio id="a" src="voice.mp3"></audio>');
  const el = doc.byId('a');
  await act(() => doc.handle.setMediaState(el, { paused: false }));
  await until(() => audios().length === 1);
  const first = doc.players.last!;
  await act(() => first.end());
  await settle();
  assert.equal(audios().length, 0, 'unmounted');
  assert.equal(first.released, true);
  await act(() => doc.handle.setMediaState(el, { paused: true }));
  assert.equal(audios().length, 0, 'a pause plays nothing again');
  await act(() => doc.handle.setMediaState(el, { paused: false }));
  await until(() => audios().length === 1);
  assert.equal(doc.players.players.length, 2);
  assert.equal(doc.players.last!.options.autoPlay, true);
});

test('a source the host declines is no player, and one the player fails on is the next source’s turn', async () => {
  const declined = await mount('<audio id="a" src="voice.ogg"></audio>', {
    answer: () => null,
  });
  await act(() =>
    declined.handle.setMediaState(declined.byId('a'), { paused: false }),
  );
  await settle();
  assert.equal(declined.asked.length, 1);
  assert.equal(audios().length, 0, 'nothing to play');
  await cleanup();

  const doc = await mount(
    '<audio id="a"><source src="one.m4a" type="audio/mp4">' +
      '<source src="two.mp3" type="audio/mpeg"></audio>',
  );
  await act(() => doc.handle.setMediaState(doc.byId('a'), { paused: false }));
  await until(() => audios().length === 1);
  assert.equal(doc.players.last!.src, 'https://example.test/dir/one.m4a');
  await act(() => doc.players.last!.fail('no decoder'));
  await until(() => doc.players.players.length === 2);
  assert.equal(doc.players.last!.src, 'https://example.test/dir/two.mp3');
  assert.equal(doc.players.players[0].released, true);
});

scriptedTest(
  'a page’s new Audio() is heard, and its clock and its end are the player’s',
  async () => {
    const doc = await mount(
      '<p id="out"></p><p id="now"></p><script>' +
        'var a = new Audio("voice.mp3"), r = [];' +
        '["loadedmetadata", "play", "pause", "ended"].forEach(function (t) {' +
        '  a.addEventListener(t, function () { r.push(t) }) });' +
        'a.addEventListener("ended", function () {' +
        '  r.push(a.ended, a.paused, a.currentTime);' +
        '  document.getElementById("out").textContent = r.join(",") });' +
        'window.at = function () {' +
        '  document.getElementById("now").textContent =' +
        '    a.duration + "/" + a.currentTime.toFixed(1) + "/" + a.ended };' +
        'a.play();' +
        '</script>',
      { scripts: true },
    );
    await until(() => audios().length === 1);
    const player = doc.players.last!;
    assert.equal(player.src, 'https://example.test/dir/voice.mp3');
    /** What the page reads: its duration, its time and whether it ended. */
    const now = async () => {
      await doc.exec('at()');
      await settle();
      return doc.text('now');
    };
    // nothing loads it here, so the player's metadata is what readies it
    await act(() => player.ready({ duration: 9.72 }));
    await act(() => player.state(true));
    await act(() => player.time(4.5));
    assert.equal(await now(), '9.72/4.5/false', 'the time the player said');
    // a player silent for longer than it reports is waiting, and so is the
    // clock, half a second on
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(await now(), '9.72/5.0/false', 'held where the player is');
    await act(() => player.time(9.7));
    await settle();
    // the clock, past the length by now on its own, waits for the player
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    assert.equal(doc.text('out'), '', 'not ended before the player says');
    await act(() => player.end());
    await until(() => doc.text('out') !== '');
    assert.equal(
      doc.text('out'),
      ['play', 'loadedmetadata', 'pause', 'ended', 'true', 'true', '9.72'].join(
        ',',
      ),
    );
    await settle();
    assert.equal(player.released, true, 'and the player let go');
  },
);
