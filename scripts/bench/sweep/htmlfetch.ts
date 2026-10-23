// Fills a disk cache with everything a list of pages asks for, so that
// htmlsweep.mjs and htmlpage.mjs can mount them with no network: each page
// is mounted once in react-x11's in-process X server through the browser
// example's network (`CachedNetwork`, scripts/zengarden/ours.tsx), and every
// document, stylesheet, font and image it asks for is kept, with what a
// server said it has none of.
//
//   npx tsx --experimental-vm-modules scripts/bench/sweep/htmlfetch.ts \
//     <cache dir> [list] [--scripts]
//
// `list` is a file of URLs, one a line, `#` a comment (default
// scripts/bench/sweep/pages.txt), or `zengarden` for the CSS Zen Garden's
// 221 designs. With `--scripts` the pages' scripts run as they are mounted,
// and their sources and every request they make through `fetch` and
// `XMLHttpRequest` are kept too, each by its method, address and body
// (`fetchKey`), for htmlpage.mjs's `SCRIPTS=1` to answer from.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { ThemeProvider } from 'react-x11';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html } from '../../../src/html/index.js';
import type { ResourceRequest } from '../../../src/html/index.js';
import { HtmlNetwork, resourceResult } from '../../../src/html/network.js';
import type {
  FetchRequest,
  FetchResponse,
} from '../../../src/html/scripts/host.js';
import { CachedNetwork, capture } from '../../zengarden/ours.js';

const args = process.argv.slice(2);
const scripts = args.includes('--scripts');
const [dir, list = fileURLToPath(new URL('pages.txt', import.meta.url))] =
  args.filter((a) => !a.startsWith('--'));
if (!dir) throw new Error('usage: htmlfetch.ts <cache dir> [list] [--scripts]');

const urls =
  list === 'zengarden'
    ? Array.from(
        { length: 221 },
        (_, i) => `https://csszengarden.com/${String(i + 1).padStart(3, '0')}/`,
      )
    : readFileSync(list, 'utf8')
        .split('\n')
        .map((line) => line.replace(/#.*/, '').trim())
        .filter(Boolean);

/** Where a page's request is kept: its method, its address and its body. */
export function fetchKey(request: {
  method: string;
  url: string;
  body: string | null;
}): string {
  return createHash('sha1')
    .update(
      `fetch:${request.method.toUpperCase()} ${request.url}\n${request.body ?? ''}`,
    )
    .digest('hex');
}

const network = new CachedNetwork(dir);
const live = new HtmlNetwork();

/** A page's request, from the cache or the network, kept as it came. */
async function fetchKept(
  request: FetchRequest,
  page: string,
  signal: Parameters<HtmlNetwork['request']>[2],
): Promise<FetchResponse> {
  const key = fetchKey(request);
  const meta = join(dir, `${key}.json`);
  const body = join(dir, `${key}.bin`);
  if (existsSync(meta)) {
    const head = JSON.parse(readFileSync(meta, 'utf8'));
    const bytes = new Uint8Array(readFileSync(body));
    return { ...head, bytes, body: new TextDecoder().decode(bytes) };
  }
  const answer = await live.request(
    { ...request, stream: false },
    page,
    signal,
  );
  const { bytes, charset: _charset, chunks: _chunks, ...head } = answer;
  writeFileSync(body, bytes);
  writeFileSync(meta, JSON.stringify(head));
  return { ...head, bytes, body: new TextDecoder().decode(bytes) };
}

/** A page mounted with its scripts running, until nothing it asks for is
 *  in flight and nothing has arrived for two seconds, or thirty pass. */
async function captureScripted(url: string): Promise<boolean> {
  const page = await network.document(url);
  if (!page) return false;
  let pending = 0;
  let settled = Date.now();
  const track = <T>(p: Promise<T>): Promise<T> => {
    pending += 1;
    return p.finally(() => {
      pending -= 1;
      settled = Date.now();
    });
  };
  const onResource = (request: ResourceRequest) => {
    if (request.kind === 'video') return null;
    const kind = request.kind;
    return track(
      network
        .resource(request.url, kind, page.url)
        .then((fetched) => (fetched ? resourceResult(fetched, kind) : null)),
    );
  };
  const h = React.createElement;
  await renderX11(
    h(
      ThemeProvider,
      {
        value: { background: '#ffffff', text: '#000000' },
        colorScheme: 'light',
      } as Record<string, unknown>,
      h(
        'box',
        { style: { width: 1280, height: 800, flexDirection: 'column' } },
        h(
          'box',
          {
            style: { flexGrow: 1, overflow: 'scroll', flexDirection: 'column' },
          },
          h(Html, {
            source: page.source,
            baseUrl: page.url,
            charset: page.charset,
            partial: false,
            animate: false,
            onResource,
            scripts: {
              timeout: 10_000,
              fetch: (request, signal) =>
                track(fetchKept(request, page.url, signal)),
            },
            style: { flexGrow: 1 },
          }),
        ),
      ),
    ),
    { width: 1280, height: 800 } as never,
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    await act();
    if (pending === 0 && Date.now() - settled > 2000) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await cleanup();
  return true;
}

for (const url of urls) {
  const t = performance.now();
  try {
    const ok = scripts
      ? await captureScripted(url)
      : !!(await capture(network, url, {
          width: 1280,
          height: 800,
          maxHeight: 800,
        }));
    const dropped = network.takeDropped();
    console.log(
      `${ok ? 'ok' : 'none'} ${url} ${Math.round(performance.now() - t)} ms` +
        (dropped.length ? ` (${dropped.length} dropped)` : ''),
    );
  } catch (err) {
    console.log(`fail ${url} ${(err as Error).message}`);
  }
}
process.exit(0);
