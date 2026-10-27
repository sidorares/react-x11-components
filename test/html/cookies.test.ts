// The cookie jar (src/html/cookies.ts): RFC 6265bis's parsing, storage
// model and retrieval, with no network and no document.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CookieJar,
  defaultPath,
  domainMatch,
  parseCookieDate,
  parseSetCookie,
  pathMatch,
  publicSuffixList,
} from '../../src/html/cookies.js';
import type { CookieContext, HtmlCookie } from '../../src/html/cookies.js';

const HTTP: CookieContext = { http: true, sameSite: true, topLevel: true };
const SUB: CookieContext = { http: true, sameSite: true };
const CROSS: CookieContext = { http: true, sameSite: false };
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

function jar(options: ConstructorParameters<typeof CookieJar>[0] = {}) {
  let now = NOW;
  const made = new CookieJar({ now: () => now, ...options });
  return Object.assign(made, {
    later(ms: number) {
      now += ms;
    },
  });
}

test('a cookie-date is read in the forms servers write it, and not in others', () => {
  const at = Date.UTC(2037, 9, 21, 7, 28, 0);
  for (const text of [
    'Wed, 21 Oct 2037 07:28:00 GMT',
    'Wednesday, 21-Oct-37 07:28:00 GMT',
    'Wed Oct 21 07:28:00 2037',
    '21 Oct 2037 07:28:00',
    'Wed, 21-Oct-2037 07:28:00 GMT',
  ]) {
    assert.equal(parseCookieDate(text), at, text);
  }
  assert.equal(
    parseCookieDate('Thu, 01 Jan 70 00:00:00 GMT'),
    0,
    'two digits 70 is 1970',
  );
  assert.equal(
    parseCookieDate('Sat, 01 Jan 2000 00:00:00 GMT'),
    Date.UTC(2000, 0, 1),
  );
  for (const bad of [
    'not a date',
    'Wed, 31 Apr 2037 07:28:00 GMT',
    'Wed, 21 Oct 1600 07:28:00 GMT',
    'Wed, 21 Oct 2037 24:28:00 GMT',
    'Wed, 21 Oct 2037',
  ]) {
    assert.equal(parseCookieDate(bad), null, bad);
  }
});

test('a Set-Cookie is parsed: its pair, the last of each attribute, Max-Age over Expires', () => {
  const c = parseSetCookie(
    ' sid = abc ; Path=/a; path=/b; Domain=.Example.COM; Secure; HttpOnly; SameSite=Lax; Max-Age=60; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
    NOW,
  )!;
  assert.equal(c.name, 'sid');
  assert.equal(c.value, 'abc');
  assert.equal(c.path, '/b', 'the last Path');
  assert.equal(c.domain, 'example.com', 'without its dot, lower-cased');
  assert.ok(c.secure && c.httpOnly);
  assert.equal(c.sameSite, 'lax');
  assert.equal(c.expires, NOW + 60_000, 'Max-Age wins over Expires');
  assert.equal(parseSetCookie('x=1; Max-Age=0', NOW)!.expires, -Infinity);
  assert.equal(parseSetCookie('x=1; Path=relative', NOW)!.path, null);
  assert.equal(parseSetCookie('x=1; SameSite=bogus', NOW)!.sameSite, 'default');
  assert.equal(parseSetCookie('novalue', NOW)!.name, '', 'a nameless cookie');
  assert.equal(parseSetCookie('novalue', NOW)!.value, 'novalue');
  assert.equal(parseSetCookie('a=b\u0001c', NOW), null, 'a control character');
  assert.equal(parseSetCookie('=', NOW), null, 'no name and no value');
  assert.equal(parseSetCookie(`a=${'x'.repeat(4096)}`, NOW), null, 'too large');
  // an expiry past 400 days is held to 400 days
  assert.equal(
    parseSetCookie('x=1; Max-Age=999999999', NOW)!.expires,
    NOW + 400 * 24 * 3600 * 1000,
  );
});

test('the matching rules: domain-match, default-path and path-match', () => {
  assert.ok(domainMatch('www.example.com', 'example.com'));
  assert.ok(domainMatch('example.com', 'example.com'));
  assert.ok(!domainMatch('badexample.com', 'example.com'));
  assert.ok(
    !domainMatch('10.0.0.1', '0.0.1'),
    'an address matches itself alone',
  );
  assert.equal(defaultPath('/a/b/c'), '/a/b');
  assert.equal(defaultPath('/a'), '/');
  assert.equal(defaultPath(''), '/');
  assert.ok(pathMatch('/a/b', '/a'));
  assert.ok(pathMatch('/a/b', '/a/'));
  assert.ok(!pathMatch('/ab', '/a'));
  assert.ok(pathMatch('/a', '/a'));
});

test('a cookie is for its host, or with Domain for the domain and below; never for a public suffix', () => {
  const j = jar();
  j.store(
    'https://www.example.com/',
    [
      'host=1',
      'domain=2; Domain=example.com',
      'tld=3; Domain=com',
      'other=4; Domain=other.com',
    ],
    HTTP,
  );
  assert.equal(j.header('https://www.example.com/', SUB), 'host=1; domain=2');
  assert.equal(j.header('https://shop.example.com/', SUB), 'domain=2');
  assert.equal(j.header('https://example.com/', SUB), 'domain=2');
  assert.equal(j.header('https://other.com/', SUB), '');
  assert.equal(
    j.all().length,
    2,
    'the public suffix and the other domain are refused',
  );
  // with a list that knows `co.uk`
  const uk = jar({
    publicSuffix: (host) =>
      /(^|\.)co\.uk$/.test(host) ? 'co.uk' : host.split('.').pop()!,
  });
  uk.store(
    'https://a.example.co.uk/',
    ['x=1; Domain=co.uk', 'y=2; Domain=example.co.uk'],
    HTTP,
  );
  assert.equal(uk.header('https://b.example.co.uk/', SUB), 'y=2');
  assert.equal(uk.site('https://a.example.co.uk/x'), 'https://example.co.uk');
  assert.ok(
    uk.sameSite('https://a.example.co.uk/', 'https://b.example.co.uk/'),
  );
  assert.ok(!uk.sameSite('https://a.example.co.uk/', 'https://other.co.uk/'));
  assert.ok(
    !uk.sameSite('http://example.co.uk/', 'https://example.co.uk/'),
    'schemeful',
  );
});

test('a host that is a public suffix may set a host-only cookie for itself', () => {
  const j = jar({
    publicSuffix: (host) =>
      host === 'github.io' ? host : host.split('.').pop()!,
  });
  j.store('https://github.io/', ['x=1; Domain=github.io'], HTTP);
  assert.equal(j.header('https://github.io/', SUB), 'x=1');
  assert.equal(j.header('https://user.github.io/', SUB), '', 'host-only');
});

test('paths: a cookie goes with its path and below, the longer path first, then the older', () => {
  const j = jar();
  j.store('https://example.com/a/b/page', ['dir=1'], HTTP);
  j.later(1);
  j.store(
    'https://example.com/',
    ['root=2; Path=/', 'deep=3; Path=/a/b/c'],
    HTTP,
  );
  j.later(1);
  j.store('https://example.com/', ['older=0; Path=/a/b'], HTTP);
  assert.equal(
    j.header('https://example.com/a/b/c/d', SUB),
    'deep=3; dir=1; older=0; root=2',
  );
  assert.equal(
    j.header('https://example.com/a/bc', SUB),
    'root=2',
    '/a/b does not cover /a/bc',
  );
  assert.equal(
    j.all().find((c) => c.name === 'dir')!.path,
    '/a/b',
    'the default path',
  );
});

test('Secure: set only over a secure connection, sent only over one; a loopback host counts', () => {
  const j = jar();
  j.store('http://example.com/', ['s=1; Secure'], HTTP);
  assert.equal(j.all().length, 0, 'an insecure origin sets no Secure cookie');
  j.store('https://example.com/', ['s=1; Secure', 'plain=2'], HTTP);
  assert.equal(j.header('http://example.com/', SUB), 'plain=2');
  assert.equal(j.header('https://example.com/', SUB), 's=1; plain=2');
  j.store('http://localhost:8080/', ['local=1; Secure'], HTTP);
  assert.equal(j.header('http://localhost:8080/', SUB), 'local=1');
});

test('leave secure cookies alone: an insecure origin overwrites no Secure cookie', () => {
  const j = jar();
  j.store('https://example.com/', ['sid=good; Secure; Path=/'], HTTP);
  j.store('http://example.com/', ['sid=evil; Path=/'], HTTP);
  assert.equal(j.header('https://example.com/', SUB), 'sid=good');
});

test('HttpOnly: no script reads one, sets one or overwrites one', () => {
  const j = jar();
  j.store('https://example.com/', ['sid=1; HttpOnly', 'theme=dark'], HTTP);
  assert.equal(
    j.documentCookie('https://example.com/', 'https://example.com/'),
    'theme=dark',
  );
  j.setDocumentCookie(
    'https://example.com/',
    'sid=forged',
    'https://example.com/',
  );
  j.setDocumentCookie(
    'https://example.com/',
    'mine=1; HttpOnly',
    'https://example.com/',
  );
  assert.equal(j.header('https://example.com/', SUB), 'sid=1; theme=dark');
  j.setDocumentCookie(
    'https://example.com/',
    'theme=light',
    'https://example.com/',
  );
  assert.equal(j.documentCookie('https://example.com/', null), 'theme=light');
});

test('SameSite: held back from another site, as each enforcement says', () => {
  const j = jar();
  j.store(
    'https://example.com/',
    [
      'strict=1; SameSite=Strict',
      'lax=2; SameSite=Lax',
      'none=3; SameSite=None; Secure',
      'unsaid=4',
    ],
    HTTP,
  );
  assert.equal(
    j.header('https://example.com/', SUB),
    'strict=1; lax=2; none=3; unsaid=4',
  );
  assert.equal(
    j.header('https://example.com/', {
      ...CROSS,
      topLevel: true,
      method: 'GET',
    }),
    'lax=2; none=3; unsaid=4',
    'a link from another site carries Lax',
  );
  assert.equal(
    j.header('https://example.com/', {
      ...CROSS,
      topLevel: true,
      method: 'POST',
    }),
    'none=3; unsaid=4',
    'a form POSTed from another site does not',
  );
  assert.equal(
    j.header('https://example.com/', CROSS),
    'none=3; unsaid=4',
    "another site's image or fetch carries None and the unsaid",
  );
  // a cookie held back from other sites is not set from one, but by a
  // top-level navigation
  j.store('https://example.com/', ['xs=1; SameSite=Lax'], CROSS);
  j.store('https://example.com/', ['xn=1; SameSite=Strict'], {
    ...CROSS,
    topLevel: true,
  });
  assert.ok(!j.all().some((c) => c.name === 'xs'));
  assert.ok(j.all().some((c) => c.name === 'xn'));
  // SameSite=None without Secure is refused
  j.store('https://example.com/', ['insecure=1; SameSite=None'], HTTP);
  assert.ok(!j.all().some((c) => c.name === 'insecure'));
  // with third-party cookies off, a cross-site request carries none
  const strict = jar({ thirdParty: false });
  strict.store('https://example.com/', ['none=3; SameSite=None; Secure'], HTTP);
  assert.equal(strict.header('https://example.com/', CROSS), '');
  assert.equal(
    strict.header('https://example.com/', { ...CROSS, topLevel: true }),
    'none=3',
  );
});

test('a cookie replaced keeps when it was made; an expired one is a deletion', () => {
  const j = jar();
  j.store('https://example.com/', ['a=1', 'b=1'], HTTP);
  const made = j.all().find((c) => c.name === 'a')!.created;
  j.later(1000);
  j.store('https://example.com/', ['a=2'], HTTP);
  const a = j.all().find((c) => c.name === 'a')!;
  assert.equal(a.value, '2');
  assert.equal(a.created, made);
  assert.equal(
    j.header('https://example.com/', SUB),
    'a=2; b=1',
    'in its old place',
  );
  j.store(
    'https://example.com/',
    ['a=gone; Max-Age=0', 'b=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT'],
    HTTP,
  );
  assert.equal(j.header('https://example.com/', SUB), '');
  j.store('https://example.com/', ['soon=1; Max-Age=2'], HTTP);
  assert.equal(j.header('https://example.com/', SUB), 'soon=1');
  j.later(2000);
  assert.equal(j.header('https://example.com/', SUB), '', 'expired');
});

test('the prefixes: __Secure- needs Secure, __Host- Secure, no Domain and the root path', () => {
  const j = jar();
  j.store(
    'https://www.example.com/',
    [
      '__Secure-a=1',
      '__Secure-b=1; Secure',
      '__Host-c=1; Secure; Path=/',
      '__Host-d=1; Secure; Path=/; Domain=example.com',
      '__Host-e=1; Secure; Path=/x',
      '__host-f=1; Path=/',
      '=__Secure-g',
    ],
    HTTP,
  );
  assert.deepEqual(
    j
      .all()
      .map((c) => c.name)
      .sort(),
    ['__Host-c', '__Secure-b'],
  );
});

test('the caps: 180 a domain, the least recently used going first', () => {
  const j = jar();
  for (let i = 0; i < 185; i += 1) {
    j.later(1);
    j.store('https://example.com/', [`c${i}=1`], HTTP);
  }
  const names = new Set(j.all().map((c) => c.name));
  assert.equal(names.size, 180);
  assert.ok(!names.has('c0') && names.has('c184'));
});

test('cookieStore: a list of a document’s cookies, and a cookie set by its init', () => {
  const j = jar();
  const page = 'https://www.example.com/app/';
  j.store(
    page,
    ['sid=1; HttpOnly', 'theme=dark; Path=/; Domain=example.com'],
    HTTP,
  );
  assert.deepEqual(j.list(page, page), [
    {
      name: 'theme',
      value: 'dark',
      domain: 'example.com',
      path: '/',
      expires: null,
      secure: false,
      sameSite: 'none',
      partitioned: false,
    },
  ]);
  assert.ok(j.setFromInit(page, { name: 'k', value: 'v', path: '/app' }, page));
  const k = j.all().find((c) => c.name === 'k')!;
  assert.equal(k.secure, true, 'cookieStore sets Secure');
  assert.equal(k.sameSite, 'strict', 'and Strict by default');
  assert.equal(k.path, '/app');
  assert.equal(j.list(page, page, 'k').length, 1);
});

test('a jar over a store reads it again when another writer changed it', () => {
  const rows = new Map<string, HtmlCookie>();
  let changed = false;
  const store = {
    load: () => [...rows.values()],
    changed: () => {
      const was = changed;
      changed = false;
      return was;
    },
    put: (c: HtmlCookie) => void rows.set(`${c.domain} ${c.path} ${c.name}`, c),
    delete: (c: HtmlCookie) =>
      void rows.delete(`${c.domain} ${c.path} ${c.name}`),
  };
  const a = new CookieJar({ store });
  const b = new CookieJar({ store });
  a.store('https://example.com/', ['sid=1'], HTTP);
  assert.equal(
    b.header('https://example.com/', SUB),
    'sid=1',
    'read at its first use',
  );
  a.store('https://example.com/', ['sid=2'], HTTP);
  assert.equal(
    b.header('https://example.com/', SUB),
    'sid=1',
    'nobody said it changed',
  );
  changed = true;
  assert.equal(b.header('https://example.com/', SUB), 'sid=2');
});

test('the Public Suffix List, from the optional peer tldts, private domains and all', async () => {
  const list = await publicSuffixList();
  assert.ok(list, 'tldts is a devDependency here');
  assert.equal(list('www.example.co.uk'), 'co.uk');
  assert.equal(list('user.github.io'), 'github.io', 'a private domain');
  assert.equal(await publicSuffixList(), list, 'loaded once');
  const j = jar({ publicSuffix: list });
  j.store(
    'https://a.user.github.io/',
    ['wide=1; Domain=github.io', 'mine=1; Domain=user.github.io'],
    HTTP,
  );
  assert.deepEqual(
    j.all().map((c) => c.name),
    ['mine'],
  );
  assert.ok(!j.sameSite('https://alice.github.io/', 'https://bob.github.io/'));
});
