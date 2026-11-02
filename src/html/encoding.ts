// What a label names, and which encoding a document is in. Light on purpose:
// `<Html>` and `form.ts` import it whether or not anything here is ever other
// than UTF-8, so its tables are in `encoding-codecs.ts`, which this reaches by
// a dynamic `import()` that an app showing only UTF-8 never makes.
import type { LegacyDecoder } from './encoding-codecs.js';
import { ENCODING_LABELS } from './encoding-labels.js';

declare const TextDecoder: new (
  label?: string,
  options?: { fatal?: boolean },
) => { decode(bytes?: Uint8Array, options?: { stream?: boolean }): string };

let labels: Map<string, string> | null = null;

/**
 * Encoding's "get an encoding": the name of the encoding a label stands for,
 * or null. ASCII case only, so that no other script's letter folds into a
 * label (`Koi8-r` is none).
 */
export function encodingOf(label: string): string | null {
  if (!labels) {
    labels = new Map();
    for (const [name, list] of Object.entries(ENCODING_LABELS)) {
      for (const each of list.split(' ')) labels.set(each, name);
    }
  }
  const key = label
    .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '')
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
  return labels.get(key) ?? null;
}

/** Encoding's "get an output encoding": what a form or a URL is written in,
 *  which no encoding that does not leave ASCII alone can be. */
export function outputEncoding(name: string): string {
  return name === 'replacement' || name === 'UTF-16BE' || name === 'UTF-16LE'
    ? 'UTF-8'
    : name;
}

/** Encoding's "BOM sniff". */
export function bomEncoding(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'UTF-8';
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'UTF-16BE';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'UTF-16LE';
  return null;
}

/** HTML's "algorithm for extracting a character encoding from a `meta`
 *  element": the label a `content` attribute's value names, or null. */
export function charsetInContent(content: string): string | null {
  const lower = content.toLowerCase();
  for (let at = 0; ;) {
    const found = lower.indexOf('charset', at);
    if (found < 0) return null;
    let i = found + 7;
    while (SPACE.includes(lower[i] ?? 'x')) i += 1;
    if (lower[i] !== '=') {
      at = i;
      continue;
    }
    i += 1;
    while (SPACE.includes(lower[i] ?? 'x')) i += 1;
    const quote = content[i];
    if (quote === '"' || quote === "'") {
      const end = content.indexOf(quote, i + 1);
      return end < 0 ? null : content.slice(i + 1, end);
    }
    if (i >= content.length) return null;
    let end = i;
    while (end < content.length && !STOPS.includes(content[end])) end += 1;
    return content.slice(i, end);
  }
}

const SPACE = '\t\n\f\r ';
const STOPS = '\t\n\f\r ;';

/**
 * HTML's "prescan a byte stream to determine its encoding" over its first
 * kilobyte: the encoding a `<meta>` names, past comments and any other tag,
 * or null. A `<meta>` naming UTF-16 is read as UTF-8, since it was read at
 * all, and `x-user-defined` as windows-1252.
 */
export function metaEncoding(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 1024);
  let text = '';
  for (let i = 0; i < head.length; i += 4096) {
    text += String.fromCharCode.apply(null, [...head.subarray(i, i + 4096)]);
  }
  const lower = text.toLowerCase();
  let i = 0;
  /** HTML's "get an attribute", from `i`. */
  const attribute = (): [string, string] | null => {
    while (i < lower.length && (SPACE + '/').includes(lower[i])) i += 1;
    if (i >= lower.length || lower[i] === '>') return null;
    let name = '';
    for (; ; i += 1) {
      const c = lower[i];
      if (c === undefined) return null;
      if (c === '=' && name) break;
      if (SPACE.includes(c)) {
        while (i < lower.length && SPACE.includes(lower[i])) i += 1;
        if (lower[i] !== '=') return [name, ''];
        break;
      }
      if (c === '/' || c === '>') return [name, ''];
      name += c;
    }
    i += 1;
    while (i < lower.length && SPACE.includes(lower[i])) i += 1;
    const quote = lower[i];
    let value = '';
    if (quote === '"' || quote === "'") {
      const end = lower.indexOf(quote, i + 1);
      if (end < 0) {
        i = lower.length;
        return null;
      }
      value = text.slice(i + 1, end);
      i = end + 1;
      return [name, value];
    }
    if (quote === '>' || quote === undefined) return [name, ''];
    while (i < lower.length && !(SPACE + '>').includes(lower[i])) {
      value += text[i];
      i += 1;
    }
    return [name, value];
  };
  while (i < lower.length) {
    if (lower.startsWith('<!--', i)) {
      const end = lower.indexOf('-->', i + 2);
      if (end < 0) return null;
      i = end + 3;
    } else if (
      lower.startsWith('<meta', i) &&
      (SPACE + '/').includes(lower[i + 5] ?? 'x')
    ) {
      i += 5;
      const seen = new Set<string>();
      let pragma = false;
      let need: boolean | null = null;
      let charset: string | null = null;
      for (let at = attribute(); at; at = attribute()) {
        const [name, value] = at;
        if (seen.has(name)) continue;
        seen.add(name);
        if (name === 'http-equiv') {
          if (value.toLowerCase() === 'content-type') pragma = true;
        } else if (name === 'content') {
          const found = charsetInContent(value);
          if (found !== null && charset === null) {
            charset = encodingOf(found);
            need = true;
          }
        } else if (name === 'charset') {
          charset = encodingOf(value);
          need = false;
        }
      }
      if (need === null || (need && !pragma) || charset === null) continue;
      if (charset === 'UTF-16BE' || charset === 'UTF-16LE') return 'UTF-8';
      return charset === 'x-user-defined' ? 'windows-1252' : charset;
    } else if (/^<\/?[a-z]/.test(lower.slice(i, i + 3))) {
      while (i < lower.length && !(SPACE + '>').includes(lower[i])) i += 1;
      while (attribute());
      i += 1;
    } else if (/^<[!/?]/.test(lower.slice(i, i + 2))) {
      const end = lower.indexOf('>', i + 2);
      if (end < 0) return null;
      i = end + 1;
    } else i += 1;
  }
  return null;
}

/**
 * Whether `bytes`, as far as they go, hold anything but ASCII and are valid
 * UTF-8: what says text with no label is UTF-8 in spite of having none.
 */
function plainlyUtf8(bytes: Uint8Array): boolean {
  if (bytes.every((byte) => byte < 0x80)) return false;
  try {
    // a host streaming a document looks at its first kilobyte or so, which
    // may stop in the middle of a character
    const stream = bytes.length >= 1024;
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream });
    return true;
  } catch {
    return false;
  }
}

/** The encoding an XML document's declaration names, in its first bytes. */
export function xmlEncoding(bytes: Uint8Array): string | null {
  const head = String.fromCharCode(...bytes.subarray(0, 256));
  const named = /^<\?xml[^>]*?\sencoding\s*=\s*["']([^"']+)["']/.exec(head);
  return named ? encodingOf(named[1]) : null;
}

/**
 * HTML's "encoding sniffing algorithm", as a document's bytes are first
 * looked at: a byte order mark, then what the transport named, then a
 * `<meta>`, then the encoding of the document that framed it where there is
 * one, and windows-1252, as a browser falls back. All but one step of that is
 * the standard's: a document with no label that is valid UTF-8 and is not
 * ASCII is UTF-8, where Chrome would show its bytes as windows-1252.
 */
export function sniffEncoding(
  bytes: Uint8Array,
  transport?: string | null,
  parent?: string | null,
): string {
  return (
    bomEncoding(bytes) ??
    (transport ? encodingOf(transport) : null) ??
    metaEncoding(bytes) ??
    (plainlyUtf8(bytes) ? 'UTF-8' : null) ??
    (parent && parent !== 'replacement' ? parent : null) ??
    'windows-1252'
  );
}

type Codecs = typeof import('./encoding-codecs.js');

let codecs: Codecs | null = null;
let loading: Promise<Codecs> | null = null;

/** The legacy decoders and encoders, loaded the first time anything asks. */
export function loadEncodings(): Promise<Codecs> {
  return (loading ??= import('./encoding-codecs.js').then((loaded) => {
    codecs = loaded;
    return loaded;
  }));
}

/** The codecs, where something has loaded them: a page's scripts' chunk does
 *  as it comes in, and a document's host before it decodes. */
export function loadedEncodings(): Codecs | null {
  return codecs;
}

/** Hand over the codecs from what imports them outright, which is the script
 *  runtime's chunk: its ops are synchronous, and have nothing to wait in. */
export function adoptEncodings(loaded: Codecs): void {
  codecs = loaded;
}

/** What has to be loaded before bytes in an encoding can be decoded: nothing
 *  for UTF-8, which the runtime has. */
export function readyFor(charset: string | null | undefined): Promise<unknown> {
  const name = charset ? encodingOf(charset) : null;
  return name && name !== 'UTF-8' ? loadEncodings() : Promise.resolve();
}

/**
 * Bytes as text in an encoding by its label, or as UTF-8 where it names none:
 * the standard's "decode", whose byte order mark wins over the label. Where
 * the label is a legacy encoding and `readyFor` has not been awaited this
 * falls to the runtime's decoder, which is close to the standard's and not
 * the same, or a `RangeError` where it has none, and never UTF-8 in its place.
 */
export function decodeInEncoding(
  bytes: Uint8Array,
  charset: string | null | undefined,
): string {
  const name =
    bomEncoding(bytes) ?? (charset ? encodingOf(charset) : null) ?? 'UTF-8';
  if (name === 'UTF-8') return new TextDecoder('utf-8').decode(bytes);
  const decoder = codecs?.decoderFor(name);
  if (decoder) {
    const start = bomEncoding(bytes) ? 2 : 0;
    return decoder.decode(bytes.subarray(start), false, false) as string;
  }
  return new TextDecoder(name).decode(bytes);
}

/** A decoder a chunk at a time, by the label a document's bytes are in, with
 *  what `decodeInEncoding` does at the start of them. */
export interface HtmlTextDecoder {
  decode(bytes?: Uint8Array, options?: { stream?: boolean }): string;
}

/** A decoder for bytes in `charset` that arrive in pieces, loading what it
 *  needs. Throws a `RangeError` for a label that names no encoding. */
export async function htmlTextDecoder(
  charset: string,
): Promise<HtmlTextDecoder> {
  const name = encodingOf(charset);
  if (!name) throw new RangeError(`${charset} names no encoding.`);
  if (name === 'UTF-8') return new TextDecoder('utf-8');
  const legacy: LegacyDecoder = (await loadEncodings()).decoderFor(
    name,
  ) as LegacyDecoder;
  return {
    decode: (bytes, options) =>
      legacy.decode(
        bytes ?? new Uint8Array(0),
        options?.stream ?? false,
        false,
      ) as string,
  };
}
