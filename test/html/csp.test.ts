// A document's Content Security Policy as a connection asks it
// (`src/html/csp.ts`): a policy parsed, and a URL matched against
// `connect-src` and `default-src` as CSP 3 matches it. Pure: no document.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  connectAllowed,
  matchesSourceList,
  parseCsp,
} from '../../src/html/csp.js';

const SELF = 'https://example.test:8443/page.html';

test('a policy is its directives by `;`, names lower-cased, and the first of a name kept', () => {
  const policy = parseCsp(
    "  Connect-Src 'self'  https://a.test ; default-src 'none';connect-src *;;  ",
  );
  assert.deepEqual([...policy.keys()], ['connect-src', 'default-src']);
  assert.deepEqual(policy.get('connect-src'), ["'self'", 'https://a.test']);
});

test('a source list matches by the standard’s rules', () => {
  const cases: [string[], string, boolean][] = [
    [[], 'https://a.test/', false],
    [["'none'"], 'https://a.test/', false],
    [['*'], 'https://a.test:1/x', true],
    [['*'], 'data:,x', false],
    [["'self'"], 'https://example.test:8443/other', true],
    [["'self'"], 'https://example.test/other', false],
    [["'self'"], 'wss://example.test:8443/', true],
    [['https:'], 'https://anything.test/', true],
    [['http:'], 'https://upgraded.test/', true],
    [['https:'], 'http://downgraded.test/', false],
    [['https://a.test'], 'https://a.test/x', true],
    [['https://a.test'], 'https://a.test:444/x', false],
    [['https://a.test:443'], 'https://a.test/x', true],
    [['https://a.test:*'], 'https://a.test:11000/x', true],
    [['a.test:11000'], 'https://a.test:11000/x', true],
    [['a.test:11000'], 'http://a.test:11000/x', false],
    [['*.a.test'], 'https://b.a.test/', true],
    [['*.a.test'], 'https://a.test/', false],
    [['https://a.test/dir/'], 'https://a.test/dir/x', true],
    [['https://a.test/dir/'], 'https://a.test/other', false],
    [['https://a.test/file'], 'https://a.test/file', true],
    [['https://a.test/file'], 'https://a.test/file/more', false],
    [["'unsafe-inline'", "'nonce-x'"], 'https://a.test/', false],
  ];
  for (const [list, url, want] of cases) {
    assert.equal(
      matchesSourceList(list, url, SELF),
      want,
      `${list.join(' ')} vs ${url}`,
    );
  }
});

test('a connection is held to every policy’s connect-src, or its default-src where it has none', () => {
  const none = parseCsp("connect-src 'none'");
  const origin = parseCsp('connect-src https://wt.test:11000');
  const fallback = parseCsp("default-src 'self'; img-src *");
  const unrelated = parseCsp('img-src *');
  assert.equal(connectAllowed([], 'https://wt.test:11000/', SELF), true);
  assert.equal(connectAllowed([none], 'https://wt.test:11000/', SELF), false);
  assert.equal(connectAllowed([origin], 'https://wt.test:11000/', SELF), true);
  assert.equal(connectAllowed([origin], 'https://wt.test:11001/', SELF), false);
  assert.equal(
    connectAllowed([fallback], 'https://wt.test:11000/', SELF),
    false,
  );
  assert.equal(connectAllowed([fallback], SELF, SELF), true);
  assert.equal(connectAllowed([unrelated], 'https://wt.test/', SELF), true);
  // every policy has to allow it
  assert.equal(
    connectAllowed([origin, none], 'https://wt.test:11000/', SELF),
    false,
  );
});
