// Fills a disk cache with everything a list of pages asks for, so that
// htmlsweep.mjs can mount them with no network: each page is mounted once
// in react-x11's in-process X server through the browser example's network
// (`CachedNetwork`, scripts/zengarden/ours.tsx), and every document,
// stylesheet, font and image it asks for is kept, with what a server said
// it has none of.
//
//   npx tsx scripts/bench/sweep/htmlfetch.ts <cache dir> [list]
//
// `list` is a file of URLs, one a line, `#` a comment (default
// scripts/bench/sweep/pages.txt), or `zengarden` for the CSS Zen Garden's
// 221 designs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CachedNetwork, capture } from '../../zengarden/ours.js';

const [dir, list = fileURLToPath(new URL('pages.txt', import.meta.url))] =
  process.argv.slice(2);
if (!dir) throw new Error('usage: htmlfetch.ts <cache dir> [list]');

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

const network = new CachedNetwork(dir);
for (const url of urls) {
  const t = performance.now();
  try {
    const page = await capture(network, url, {
      width: 1280,
      height: 800,
      maxHeight: 800,
    });
    const dropped = network.takeDropped();
    console.log(
      `${page ? 'ok' : 'none'} ${url} ${Math.round(performance.now() - t)} ms` +
        (dropped.length ? ` (${dropped.length} dropped)` : ''),
    );
  } catch (err) {
    console.log(`fail ${url} ${(err as Error).message}`);
  }
}
process.exit(0);
