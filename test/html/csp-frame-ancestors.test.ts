// A document its frame-ancestors refuses, reported through its own policies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PageCsp } from '../../src/html/scripts/csp-host.js';

test('a document framed where its frame-ancestors refuses it reports through its own report-uri, a report-only policy too', () => {
  const sent: [string, string][] = [];
  const csp = new PageCsp({
    url: () => 'https://framed.test/doc.html',
    origin: () => 'https://framed.test',
    referrer: () => '',
    status: () => 200,
    tell: () => {},
    send: (url, body) => void sent.push([url, body]),
  });
  csp.addHeaders([
    ['content-security-policy', "frame-ancestors 'self'; report-uri /r"],
    [
      'content-security-policy-report-only',
      "frame-ancestors 'self' https://other.test; report-uri /ro",
    ],
  ]);
  assert.equal(
    csp.refusedAncestors(
      ['https://framed.test'],
      'https://framed.test/doc.html',
    ),
    false,
  );
  assert.equal(
    csp.refusedAncestors(['https://evil.test'], 'https://framed.test/doc.html'),
    true,
  );
  const reports = sent.map(([url, body]) => [
    url,
    JSON.parse(body)['csp-report']['violated-directive'],
    JSON.parse(body)['csp-report']['blocked-uri'],
  ]);
  // the first ancestor is the document's own origin, which both name
  assert.deepEqual(reports, [
    [
      'https://framed.test/r',
      'frame-ancestors',
      'https://framed.test/doc.html',
    ],
    [
      'https://framed.test/ro',
      'frame-ancestors',
      'https://framed.test/doc.html',
    ],
  ]);
});
