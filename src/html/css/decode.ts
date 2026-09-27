// A stylesheet's bytes as text.
//
// A host that fetches a stylesheet has bytes and, often, the charset its
// protocol named; a host that decodes them itself hands over text, and this
// is not asked. For the first, CSS says which encoding the bytes are in
// (CSS 2.1 4.4, CSS Syntax 3 3.2), in this order:
//
//   1. a byte order mark, which the Encoding standard lets override the rest;
//   2. the charset the protocol gave, HTTP's `Content-Type` parameter;
//   3. an `@charset "…";` rule at the very start, byte for byte — naming
//      UTF-16 there means UTF-8, since a sheet that could spell the rule in
//      ASCII bytes is not in UTF-16;
//   4. what the referrer says: a `<link charset>`, then the encoding of the
//      document, or of the stylesheet that imported this one;
//   5. UTF-8.
//
// A name that names no encoding is passed over, as a step that says nothing.

/** The `TextDecoder` slice this uses, through `globalThis`: `src/` compiles
 *  with `types: []`, and a runtime without one gets UTF-8 alone. */
type DecoderConstructor = new (label: string) => {
  readonly encoding: string;
  decode(input: Uint8Array): string;
};

function decoderFor(label: string): InstanceType<DecoderConstructor> | null {
  const Decoder = (globalThis as { TextDecoder?: DecoderConstructor })
    .TextDecoder;
  if (!Decoder) return null;
  try {
    return new Decoder(label.trim());
  } catch {
    // an unknown label throws a RangeError, which here means "no answer"
    return null;
  }
}

/** `@charset "` in ASCII bytes, which the rule has to be spelt as exactly. */
const CHARSET_RULE = [
  0x40, 0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74, 0x20, 0x22,
];

/** The label an `@charset` rule at the very start names, or null. It counts
 *  only as exactly `@charset "label";` within the first 1024 bytes. */
function charsetRule(bytes: Uint8Array): string | null {
  if (bytes.length < CHARSET_RULE.length + 2) return null;
  for (let i = 0; i < CHARSET_RULE.length; i += 1) {
    if (bytes[i] !== CHARSET_RULE[i]) return null;
  }
  const end = Math.min(bytes.length - 1, 1024);
  let label = '';
  for (let i = CHARSET_RULE.length; i < end; i += 1) {
    if (bytes[i] === 0x22) return bytes[i + 1] === 0x3b ? label : null;
    label += String.fromCharCode(bytes[i]);
  }
  return null;
}

export interface DecodedStylesheet {
  text: string;
  /** The encoding it was decoded with, canonical — which a stylesheet it
   *  imports falls back to. */
  encoding: string;
}

/**
 * Decode a stylesheet's bytes. `charset` is what the protocol said, and
 * `fallbacks` what the referrer does, most specific first.
 */
export function decodeStylesheet(
  bytes: Uint8Array,
  charset: string | undefined,
  fallbacks: readonly (string | undefined)[],
): DecodedStylesheet {
  // a byte order mark wins, and is not part of the text
  const bom =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? 'utf-8'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : bytes[0] === 0xff && bytes[1] === 0xfe
          ? 'utf-16le'
          : null;
  const labels: (string | null | undefined)[] = [bom, charset];
  const rule = charsetRule(bytes);
  if (rule !== null) {
    const named = decoderFor(rule)?.encoding;
    labels.push(named === 'utf-16be' || named === 'utf-16le' ? 'utf-8' : rule);
  }
  labels.push(...fallbacks, 'utf-8');
  for (const label of labels) {
    if (!label) continue;
    const decoder = decoderFor(label);
    if (decoder)
      return { text: decoder.decode(bytes), encoding: decoder.encoding };
  }
  return { text: utf8(bytes), encoding: 'utf-8' };
}

/** UTF-8 by hand, for a runtime with no `TextDecoder`. */
function utf8(bytes: Uint8Array): string {
  let out = '';
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let code = 0xfffd;
    let size = 1;
    if (b < 0x80) code = b;
    else if (b >= 0xc2 && b < 0xe0 && i + 1 < bytes.length) {
      code = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
      size = 2;
    } else if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) {
      code =
        ((b & 0x0f) << 12) |
        ((bytes[i + 1] & 0x3f) << 6) |
        (bytes[i + 2] & 0x3f);
      size = 3;
    } else if (b >= 0xf0 && b < 0xf5 && i + 3 < bytes.length) {
      code =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      size = 4;
    }
    out += String.fromCodePoint(code);
    i += size;
  }
  return out;
}
