import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  mixedContent,
  Network,
  readDataUrl,
} from '../examples/browser/network.js';

test('a secure page has none of its stylesheets or fonts over an insecure connection, and its images over a secure one', () => {
  // W3C Mixed Content: a stylesheet or a font is blockable, an image is
  // upgradeable. The Zen Garden's older designs import Google Fonts over
  // http from an https page, and Chrome draws them in their fallbacks
  const page = 'https://example.com/a/';
  assert.equal(
    mixedContent('http://fonts.example/css?family=X', 'stylesheet', page),
    null,
    'an insecure stylesheet is not asked for',
  );
  assert.equal(
    mixedContent('http://fonts.example/x.ttf', 'font', page),
    null,
    'nor an insecure font',
  );
  assert.equal(
    mixedContent('http://img.example/a.png', 'image', page),
    'https://img.example/a.png',
    'an insecure image is asked for over https',
  );
  assert.equal(
    mixedContent('https://fonts.example/x.ttf', 'font', page),
    'https://fonts.example/x.ttf',
    'a secure one as it is',
  );
  for (const local of [
    'http://localhost:8080/a.css',
    'http://127.0.0.1/a.css',
    'http://dev.localhost/a.css',
  ]) {
    assert.equal(
      mixedContent(local, 'stylesheet', page),
      local,
      `a loopback host is trustworthy: ${local}`,
    );
  }
  for (const insecure of ['http://example.com/', 'file:///tmp/a.html']) {
    assert.equal(
      mixedContent('http://fonts.example/css', 'stylesheet', insecure),
      'http://fonts.example/css',
      `an insecure page asks for what it names: ${insecure}`,
    );
  }
});

test("a data: URL is read as Fetch's data: URL processor reads it", () => {
  const text = (url: string) => {
    const read = readDataUrl(url);
    return read && new TextDecoder().decode(read.bytes);
  };
  // Zen Garden 215's robot: a space after the comma, which forgiving-base64
  // drops, and which Bun's fetch refused
  const svg = readDataUrl('data:image/svg+xml;base64, PHN2Zz48L3N2Zz4=');
  assert.equal(svg?.type, 'image/svg+xml');
  assert.equal(new TextDecoder().decode(svg?.bytes), '<svg></svg>');
  assert.equal(
    text('data:image/svg+xml;BASE64,PHN2Zz48%0AL3N2Zz4'),
    '<svg></svg>',
    'white space anywhere in it, and no padding',
  );
  assert.equal(
    readDataUrl('data:image/png;base64,PH$N'),
    null,
    'a body that is not base64 is none',
  );
  const html = readDataUrl(
    'data:text/html;charset=UTF-8,%3Cp%3Eh%C3%AF%3C/p%3E',
  );
  assert.equal(html?.type, 'text/html');
  assert.equal(html?.charset, 'utf-8');
  assert.equal(new TextDecoder().decode(html?.bytes), '<p>hï</p>');
  assert.equal(text('data:text/plain,a#b'), 'a', 'a fragment is no body');
  const plain = readDataUrl('data:,Hello');
  assert.deepEqual(
    [plain?.type, plain?.charset],
    ['text/plain', 'us-ascii'],
    'no type is text/plain in US-ASCII',
  );
  assert.equal(readDataUrl('data:;charset=utf-8,x')?.type, 'text/plain');
  assert.equal(readDataUrl('data:nonsense,x')?.type, 'text/plain');
  assert.equal(readDataUrl('data:text/plain'), null, 'no comma, no body');
  assert.equal(readDataUrl('https://example.com/,x'), null);
});

test('the network reads a data: URL itself, for a resource and a page', async () => {
  const network = new Network();
  const real = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('asked the network'));
  try {
    const image = await network.resource(
      'data:image/svg+xml;base64, PHN2Zz48L3N2Zz4=',
      'image',
      'https://example.com/',
    );
    assert.equal(new TextDecoder().decode(image?.bytes), '<svg></svg>');
    const page = await network.document(
      'data:text/html,%3Cp%3Ehi',
      new AbortController().signal,
    );
    assert.equal(page.type, 'text/html');
    const chunks: Uint8Array[] = [];
    for await (const chunk of page.body) chunks.push(chunk);
    assert.equal(new TextDecoder().decode(chunks[0]), '<p>hi');
  } finally {
    globalThis.fetch = real;
  }
});
