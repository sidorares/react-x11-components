// Ad-hoc: what a cached tile's layers and tags actually contain. A default
// style is only as good as the schema it was written against, and reading
// the real tags beats reading the schema documentation twice.
//
//   npx tsx scripts/bench/inspect.ts 14/9648/6320
import { readFile } from 'node:fs/promises';

import { parseTile } from '../../src/maps/mvt.js';
import { cachePath } from './tiles.js';

const arg = process.argv[2] ?? '14/9648/6320';
const [z, x, y] = arg.split('/').map(Number);
const bytes = new Uint8Array(await readFile(cachePath({ z, x, y })));
const tile = parseTile(bytes);
const kind = ['unknown', 'point', 'line', 'polygon'];
for (const name of tile.order) {
  const layer = tile.layers.get(name)!;
  const tags = new Map<string, Set<string>>();
  const types = new Set<string>();
  const cursor = layer.feature(0);
  for (let i = 0; i < layer.length; i++) {
    layer.seek(i, cursor);
    types.add(kind[cursor.type] ?? '?');
    for (const [key, value] of Object.entries(cursor.properties())) {
      const seen = tags.get(key) ?? new Set<string>();
      if (seen.size < 8) seen.add(String(value));
      tags.set(key, seen);
    }
  }
  process.stdout.write(
    `${name}  (${layer.length} features, extent ${layer.extent}, ${[...types].join('/')})\n`,
  );
  for (const [key, values] of tags) {
    process.stdout.write(`    ${key.padEnd(16)} ${[...values].join(', ')}\n`);
  }
}
