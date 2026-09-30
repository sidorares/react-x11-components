import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mixedContent } from '../examples/browser/network.js';

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
