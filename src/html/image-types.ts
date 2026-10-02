// Which image types decode here: the question a `<source type>` and an
// `image-set()` option's `type()` ask before anything is fetched, answered
// as the store decodes (`resources.ts`). A module of its own, with nothing
// imported, because the cascade asks it as an `image-set()` is computed and
// `resources.ts` reaches the cascade through `svg.ts`.

/** The types every runtime decodes: SVG and GIF here (`svg.ts`, `gif.ts`),
 *  and core's ladder the rest — PNG and JPEG in ntk, WebP through the
 *  decoder it loads on the first one. An APNG is a PNG, drawn as its
 *  default image, and Chrome's other names for these are theirs too. */
const DECODED = new Set([
  'image/svg+xml',
  'image/gif',
  'image/png',
  'image/x-png',
  'image/apng',
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/webp',
]);

/** What `Bun.Image` reads besides, on every platform. */
const DECODED_BY_BUN = new Set(['image/bmp', 'image/x-bmp', 'image/x-ms-bmp']);

/** What it reads through the system's codecs: on macOS, ImageIO, which
 *  has all three; on Windows, WIC, whose HEIF and AV1 decoders are Store
 *  extensions a machine may not have, so only TIFF is counted on there. */
const DECODED_BY_IMAGEIO = new Set([
  'image/tiff',
  'image/avif',
  'image/heic',
  'image/heif',
]);

/**
 * Whether bytes of this MIME type decode here, as `_settle` and
 * `decodeImage` in `resources.ts` decode them: a `<source type>`'s
 * question, asked before anything is fetched (`srcset.ts`). The type's essence is compared, case
 * aside and its parameters dropped — `image/webp; codecs=…` is WebP, as it
 * is to every browser — and an empty one is no type, which every browser
 * takes for one it shows.
 *
 * Answered as the ladder decodes, so that a `<picture>` whose AVIF this
 * cannot decode goes on to its WebP or its JPEG, as a browser without AVIF
 * does, where taking it would leave the image declined. Under Bun the
 * runtime's decoder takes everything first (`runtimeDecoder` in core's
 * `imagedecode.js`), and is found the same way, by its constructor; a type
 * claimed here that a machine then fails to decode is a declined image,
 * which is why a type is claimed only where it decodes on every such
 * machine.
 */
export function decodesImageType(type: string): boolean {
  const essence = type.split(';')[0].trim().toLowerCase();
  if (!essence) return true;
  if (DECODED.has(essence)) return true;
  const g = globalThis as {
    Bun?: { Image?: unknown };
    process?: { platform?: string };
  };
  if (typeof g.Bun?.Image !== 'function') return false;
  if (DECODED_BY_BUN.has(essence)) return true;
  const platform = g.process?.platform;
  if (platform === 'darwin') return DECODED_BY_IMAGEIO.has(essence);
  return platform === 'win32' && essence === 'image/tiff';
}
