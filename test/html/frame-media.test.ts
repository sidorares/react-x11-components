// A frame sent to a media file (HTML 7.5.6, "read-media"): a document of one
// element that plays it, as Chromium's is, and not the file's bytes as text.
// WPT's navigation-timing/dom-interactive-media-document is the check.
import { afterEach, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html } from '../../src/html/index.js';
import { preloadHtmlScripts } from '../../src/html/scripts/hook.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import type {
  FetchRequest,
  FetchResponse,
} from '../../src/html/scripts/host.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** A page with a frame of each file, and what it logged: what each frame
 *  holds as it hears `load`, and the page's own `load` after them. */
async function framesOf(files: Record<string, string>): Promise<string[]> {
  const logs: string[] = [];
  const names = Object.keys(files);
  await renderX11(
    React.createElement(Html, {
      source:
        '<!doctype html><html><body><script>' +
        'onload = function () { console.log("page") };' +
        'function heard(f) { var b = f.contentDocument.body;' +
        'console.log(f.id + " " + f.contentDocument.readyState + " " +' +
        'Array.from(b.childNodes).map(function (n) {' +
        'var s = n.firstElementChild; return n.nodeName +' +
        '(s ? " " + s.getAttribute("src") + " " + s.type : "") })) }' +
        '</script>' +
        names
          .map((n) => `<iframe id="${n}" src="${n}" onload="heard(this)">`)
          .join('</iframe>') +
        '</iframe></body></html>',
      partial: false,
      baseUrl: 'https://example.test/page.html',
      scripts: {
        log: (level: string, text: string) =>
          void (level === 'log' && logs.push(text)),
        fetch: async (request: FetchRequest): Promise<FetchResponse> => ({
          url: request.url,
          status: 200,
          statusText: 'OK',
          redirected: false,
          headers: [['content-type', files[request.url.split('/').pop()!]]],
          body: '',
          // no character of any encoding, in what a clip's bytes are
          bytes: Uint8Array.from({ length: 4096 }, (_, i) => (i * 73) % 256),
        }),
      },
    }),
    { backend: 'mock' },
  );
  const end = Date.now() + 5000;
  while (logs.length <= names.length && Date.now() < end) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  return logs;
}

test('a frame sent to a video or a sound shows a media document, and the page is loaded', async () => {
  const logs = await framesOf({
    'clip.webm': 'video/webm',
    'clip.mp4': 'video/mp4; codecs="avc1.42E01E"',
    'song.mp3': 'audio/mpeg',
    'song.ogg': 'application/ogg',
  });
  assert.equal(logs.pop(), 'page', 'after its frames');
  const playing = (name: string, type: string): string =>
    `${name} complete VIDEO https://example.test/${name} ${type}`;
  assert.deepEqual(logs.sort(), [
    playing('clip.mp4', 'video/mp4'),
    playing('clip.webm', 'video/webm'),
    playing('song.mp3', 'audio/mpeg'),
    playing('song.ogg', 'application/ogg'),
  ]);
});

test('a frame sent to text is the text still, and to an image the image', async () => {
  const logs = await framesOf({
    'a.txt': 'text/plain',
    'a.json': 'application/json',
    'a.png': 'image/png',
  });
  assert.equal(logs.pop(), 'page');
  assert.deepEqual(logs.sort(), [
    'a.json complete PRE',
    'a.png complete IMG',
    'a.txt complete PRE',
  ]);
});
