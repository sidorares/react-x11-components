// HTTP/2 for `HtmlNetwork` (`src/html/undici.ts`), on the loopback: a
// `node:http2` server that also speaks HTTP/1.1, a certificate made for the
// run and trusted for it, and the network's requests over https. What WPT's
// `request-upload.h2` holds of a page, this holds of the network: the
// request goes over HTTP/2 where undici is installed, a page's stream is
// sent as it is, an empty body ends its request, and `http2: false` keeps
// to HTTP/1.1.
//
// Skipped where the run cannot make a certificate (no `openssl`), cannot
// trust one (`tls.setDefaultCACertificates`, Node 22.19 and 24.5), or has
// no undici, the optional peer, or runs on Bun, which loads none of it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createSecureServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import tls from 'node:tls';

import { HtmlNetwork } from '../../src/html/network.js';
import { fixedVersion, loadHttp2Fetch } from '../../src/html/undici.js';

/** A key and a certificate for localhost, good for ten days. */
function certificate(): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'h2-cert-'));
  try {
    const made = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '10',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    if (made.status !== 0) return null;
    return {
      key: readFileSync(join(dir, 'key.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
    };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const trusting = tls as typeof tls & {
  setDefaultCACertificates?(certs: string[]): void;
  getCACertificates?(kind: string): string[];
};
const canTrust =
  typeof trusting.setDefaultCACertificates === 'function' &&
  typeof trusting.getCACertificates === 'function';
const http2 = await loadHttp2Fetch();
const certs = canTrust && http2 ? certificate() : null;
const test = certs ? nodeTest : nodeTest.skip;

nodeTest(
  'an undici before 8.3.0, which leaves a request with an empty body open over HTTP/2, is not used',
  () => {
    for (const version of ['7.30.1', '8.0.0', '8.2.0', '', undefined, 'x']) {
      assert.equal(fixedVersion(version), false, String(version));
    }
    for (const version of ['8.3.0', '8.12.3', '9.0.0', '10.1.0-rc.1']) {
      assert.equal(fixedVersion(version), true, version);
    }
  },
);

/** A server that answers each request with the HTTP version it came in,
 *  and echoes its body; and the URL it is at, its certificate trusted for
 *  the test. */
async function serve(t: { after(fn: () => void): void }): Promise<string> {
  const server = createSecureServer(
    { ...certs!, allowHTTP1: true },
    (req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (part: Buffer) => parts.push(part));
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'text/plain',
          'x-version': req.httpVersion,
        });
        res.end(Buffer.concat(parts));
      });
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const roots = trusting.getCACertificates!('default');
  trusting.setDefaultCACertificates!([...roots, certs!.cert]);
  t.after(() => {
    trusting.setDefaultCACertificates!(roots);
    server.close();
  });
  return `https://localhost:${(server.address() as AddressInfo).port}`;
}

const send = (
  network: HtmlNetwork,
  url: string,
  init: { method: string; body?: string; streamedBody?: boolean },
) =>
  network.request(
    { url, headers: [], body: null, ...init },
    `${new URL(url).origin}/`,
    new AbortController().signal,
  );

const versionOf = (response: { headers: [string, string][] }) =>
  response.headers.find(([name]) => name === 'x-version')?.[1];

test('a request over https goes over HTTP/2 where the server takes it', async (t) => {
  const base = await serve(t);
  const network = new HtmlNetwork();
  const got = await send(network, `${base}/`, { method: 'GET' });
  assert.equal(got.status, 200);
  assert.equal(versionOf(got), '2.0');
  const html = await network.html(`${base}/page`);
  assert.ok(html, 'a document comes over it too');
});

test("a page's stream is sent as it is over HTTP/2, and an empty one ends its request", async (t) => {
  const base = await serve(t);
  const network = new HtmlNetwork();
  const full = await send(network, `${base}/echo`, {
    method: 'POST',
    body: 'Test',
    streamedBody: true,
  });
  assert.equal(new TextDecoder().decode(full.bytes), 'Test');
  assert.equal(versionOf(full), '2.0');
  // undici's fetch over HTTP/2 left a request whose body it knew was empty
  // open before 8.3.0, and the server waited for the rest of it for good
  for (const streamedBody of [true, false]) {
    const empty = await send(network, `${base}/echo`, {
      method: 'POST',
      body: '',
      streamedBody,
    });
    assert.equal(empty.status, 200, `streamed: ${streamedBody}`);
    assert.equal(empty.bytes.length, 0);
    assert.equal(versionOf(empty), '2.0');
  }
});

test("a network made with http2: false leaves the request to the runtime's own fetch", async (t) => {
  const base = await serve(t);
  const network = new HtmlNetwork({ http2: false });
  const got = await send(network, `${base}/`, { method: 'GET' });
  // HTTP/1.1, unless the runtime's fetch offers HTTP/2 itself, as Node 26's
  // does
  const own = await fetch(`${base}/`);
  assert.equal(versionOf(got), own.headers.get('x-version'));
});
