// Un-gzip a tile body, when it is one.
//
// Tile servers serve `Content-Encoding: gzip` — which a `fetch` undoes —
// and a good number of them *also* store the tile gzipped inside that, so
// the body an application hands over may still have the magic on it. That
// is a transport detail rather than the decoder's business, so it is
// unwrapped once, here, and `parseTile` only ever sees protobuf.
//
// `node:zlib` is reached the way `src/embed/host.ts` reaches `child_process`
// and for the same reason: `tsconfig.build.json` sets `types: []`, so `src/`
// may not name a Node module, and a package that did would stop resolving
// on a runtime that has no such module. So the module is found on
// `globalThis` if the host put it there and otherwise not at all — and a
// runtime with no zlib gets a clear error naming the one line of
// application code that fixes it, rather than a protobuf parse failure
// twenty frames away.

/** The two bytes every gzip member starts with. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

interface Zlib {
  gunzipSync(data: Uint8Array): Uint8Array;
}

let zlib: Zlib | null | undefined;

/**
 * Teach this package how to un-gzip, for a runtime where it cannot find out
 * by itself.
 *
 * ```ts
 * import { gunzipSync } from 'node:zlib';
 * setGunzip((data) => gunzipSync(data));
 * ```
 */
export function setGunzip(gunzipSync: (data: Uint8Array) => Uint8Array): void {
  zlib = { gunzipSync };
}

function findZlib(): Zlib | null {
  if (zlib !== undefined) return zlib;
  // Node and Bun both expose it on `globalThis` under a `require` that a
  // bundler will not follow, which is what keeps this out of a browser
  // bundle. Anything else: no zlib, and `setGunzip` is the way in.
  const g = globalThis as {
    process?: { getBuiltinModule?(name: string): unknown };
  };
  const module = g.process?.getBuiltinModule?.('node:zlib') as Zlib | undefined;
  zlib = module && typeof module.gunzipSync === 'function' ? module : null;
  return zlib;
}

/** The bytes, un-gzipped if they were. */
export function gunzipIfNeeded(bytes: Uint8Array): Uint8Array {
  if (!isGzip(bytes)) return bytes;
  const found = findZlib();
  if (!found) {
    throw new Error(
      'a gzipped tile arrived and this runtime has no zlib — ' +
        'un-gzip it in your source, or call setGunzip() once at startup',
    );
  }
  return found.gunzipSync(bytes);
}
