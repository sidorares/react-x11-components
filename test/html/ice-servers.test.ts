// The page's STUN and TURN servers no candidate could reach
// (`src/html/ice-servers.ts`), each told as an `icecandidateerror`: read off
// a server's URL, its host looked up, and the address it comes to. Nothing
// here needs werift or a network: the lookup is the test's.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  neverReachable,
  serverOf,
  unreachableServers,
} from '../../src/html/ice-servers.js';
import type { HostLookup } from '../../src/html/ice-servers.js';

test('a server URL is read for its host, and a TCP one says so as a browser names it', () => {
  assert.deepEqual(serverOf('stun:stun.example.net'), {
    url: 'stun:stun.example.net',
    kind: 'STUN',
    host: 'stun.example.net',
  });
  assert.deepEqual(serverOf('turn:turn1.invalid:3478'), {
    url: 'turn:turn1.invalid:3478',
    kind: 'TURN',
    host: 'turn1.invalid',
  });
  // a turns: or a stuns: URL is TCP's, which the event's URL says
  assert.equal(
    serverOf('turns:turn3.invalid:5349')?.url,
    'turns:turn3.invalid:5349?transport=tcp',
  );
  assert.equal(
    serverOf('turn:turn2.invalid:3478?transport=tcp')?.url,
    'turn:turn2.invalid:3478?transport=tcp',
  );
  assert.equal(serverOf('turn:123')?.host, '123');
  assert.equal(serverOf('stun:[2001:db8::1]:3478')?.host, '2001:db8::1');
  assert.equal(serverOf('stun:'), null);
  assert.equal(serverOf('https://example.net'), null);
});

test('an address no packet can be sent to is never reachable, and an ordinary one may be', () => {
  for (const address of [
    '0.0.0.123',
    '0.0.0.0',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    'ff02::1',
  ]) {
    assert.equal(neverReachable(address), true, address);
  }
  for (const address of [
    '127.0.0.1',
    '192.168.0.1',
    '203.0.113.7',
    '223.255.255.255',
    '::1',
    '2001:db8::1',
    'fe80::1',
  ]) {
    assert.equal(neverReachable(address), false, address);
  }
});

test('each server that does not resolve, or resolves only where nothing reaches, is a 701 in the order the page named it', async () => {
  const asked: string[] = [];
  const lookup: HostLookup = async (host) => {
    asked.push(host);
    if (host.endsWith('.invalid')) throw new Error('ENOTFOUND');
    if (host === '123') return [{ address: '0.0.0.123', family: 4 }];
    if (host === 'both.test') {
      return [
        { address: '0.0.0.1', family: 4 },
        { address: '2001:db8::1', family: 6 },
      ];
    }
    if (host === 'none.test') return [];
    return [{ address: host, family: host.includes(':') ? 6 : 4 }];
  };
  const failures = await unreachableServers(
    [
      { urls: ['turn:123'], username: 'u', credential: 'p' },
      {
        urls: ['turn:turn1.invalid:3478', 'turns:turn3.invalid:5349'],
        username: 'u',
        credential: 'p',
      },
      { urls: ['stun:127.0.0.1:3478'] },
      { urls: ['stun:both.test'] },
      { urls: ['stun:none.test'] },
    ],
    lookup,
  );
  assert.deepEqual(
    failures.map((f) => [f.url, f.errorCode, f.family]),
    [
      ['turn:123', 701, 4],
      ['turn:turn1.invalid:3478', 701, null],
      ['turns:turn3.invalid:5349?transport=tcp', 701, null],
      ['stun:none.test', 701, null],
    ],
  );
  assert.match(failures[0].errorText, /^TURN /);
  assert.deepEqual(asked, [
    '123',
    'turn1.invalid',
    'turn3.invalid',
    '127.0.0.1',
    'both.test',
    'none.test',
  ]);
  assert.deepEqual(await unreachableServers([], lookup), []);
});
