// <Html scripts>' text tracks (HTML 4.8.11.11, WebVTT;
// `src/html/scripts/text-tracks.ts`): what `addTextTrack` makes, the cues a
// page adds and their order, a `<track>`'s WebVTT file parsed into cues, and
// a `default` track chosen. Nothing draws a cue; these are what a page
// reads. WPT's `html/semantics/embedded-content/media-elements/track/`
// holds the rest, played against real media.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html, preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, PAGE, h, scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** What a function of the page's comes to, through JSON. */
async function inPage(body: string, code: string): Promise<unknown> {
  const page = await scriptedPage(
    `${body}<script>console.log("out " + JSON.stringify((function () {${code}})()));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

test('addTextTrack makes a hidden track whose cues keep their order', async () => {
  const out = await inPage(
    '',
    `var v = document.createElement('video');
     var t = v.addTextTrack('captions', 'English', 'en');
     t.addCue(new VTTCue(8, 9, 'c'));
     t.addCue(new VTTCue(2, 5, 'a'));
     t.addCue(new VTTCue(2, 3, 'b'));
     var order = Array.from(t.cues).map(function (c) { return c.text; });
     // a cue added again is the last of those that start and end with it
     var first = t.cues[0];
     t.removeCue(first);
     t.addCue(first);
     var threw = '';
     try { t.removeCue(new VTTCue(0, 1, 'x')); } catch (e) { threw = e.name; }
     t.mode = 'disabled';
     return [v.textTracks.length, v.textTracks[0] === t, t.kind, t.label,
       t.language, order, threw, t.cues, t instanceof TextTrack];`,
  );
  assert.deepEqual(out, [
    1,
    true,
    'captions',
    'English',
    'en',
    ['a', 'b', 'c'],
    'NotFoundError',
    null,
    true,
  ]);
});

test("VTTCue's settings take what they may and refuse the rest", async () => {
  const out = await inPage(
    '',
    `var c = new VTTCue(0, 1, 'x');
     var out = [c.line, c.position, c.size, c.align, c.vertical];
     c.vertical = 'bogus';
     c.line = 3;
     c.align = 'end';
     var errors = [];
     try { c.size = 101; } catch (e) { errors.push(e.name); }
     try { c.line = 'nope'; } catch (e) { errors.push(e.name); }
     try { new TextTrackCue(0, 1); } catch (e) { errors.push(e.name); }
     c.endTime = Infinity;
     out.push(c.vertical, c.line, c.align, errors, c.endTime === Infinity);
     return out;`,
  );
  assert.deepEqual(out, [
    'auto',
    'auto',
    100,
    'center',
    '',
    '',
    3,
    'end',
    ['IndexSizeError', 'TypeError', 'TypeError'],
    true,
  ]);
});

test("a <track>'s WebVTT file is parsed into cues, and a default track is chosen", async () => {
  const vtt = [
    '﻿WEBVTT header text',
    '',
    'NOTE a comment',
    '',
    'one',
    '00:01.000 --> 00:02.500 align:start line:10%',
    'Hello <b>there</b> &amp; you',
    '',
    '00:00:03.000\t-->\t00:00:04.000',
    'Second',
    '00:05.000 --> 00:06.000',
    'Third, after no blank line',
  ].join('\n');
  const logs: string[] = [];
  const result = await renderX11(
    h(Html, {
      source: `<!doctype html><video><track id="t" src="cues.vtt" default></video><script>
        var t = document.getElementById('t');
        var mode = t.track.mode;
        t.onload = function () {
          var cues = Array.from(t.track.cues);
          console.log('out ' + JSON.stringify({
            before: mode,
            mode: t.track.mode,
            ready: t.readyState,
            cues: cues.map(function (c) {
              return [c.id, c.startTime, c.endTime, c.text, c.align, c.line, c.snapToLines];
            }),
            html: cues[0].getCueAsHTML().childNodes.length,
          }));
        };
        t.onerror = function () { console.log('out "error"'); };
      </script>`,
      partial: false,
      baseUrl: PAGE,
      onResource: () => null,
      scripts: {
        log: (level: string, text: string) => void logs.push(text),
        fetch: async (request: { url: string }) => ({
          url: request.url,
          status: request.url.endsWith('cues.vtt') ? 200 : 404,
          statusText: '',
          redirected: false,
          headers: [['content-type', 'text/vtt']] as [string, string][],
          body: request.url.endsWith('cues.vtt') ? vtt : '',
        }),
      },
    }),
    FONTS ? { width: 200, height: 120, fonts: FONTS } : { backend: 'mock' },
  );
  const end = Date.now() + 5000;
  while (!logs.some((l) => l.startsWith('out ')) && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  const line = logs.find((l) => l.startsWith('out '));
  assert.ok(line, `no answer in:\n${logs.join('\n')}`);
  // chosen a task after the track came, as the selection is queued
  assert.deepEqual(JSON.parse(line.slice(4)), {
    before: 'disabled',
    mode: 'showing',
    ready: 2,
    cues: [
      ['one', 1, 2.5, 'Hello <b>there</b> &amp; you', 'start', 10, false],
      ['', 3, 4, 'Second', 'center', 'auto', true],
      ['', 5, 6, 'Third, after no blank line', 'center', 'auto', true],
    ],
    html: 3,
  });
  result.unmount();
});
