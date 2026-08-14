// UTF-8, decoded across chunk boundaries.
//
// Hand-rolled rather than reached through `TextDecoder` on `globalThis`, for
// the two reasons `../tray-host/protocol.ts` gives for its own copy — it is
// twenty lines, it is pure, and it keeps the tests independent of whichever
// runtime the suite happens to run on — plus one that is this module's alone:
// **the decode has to be streaming**. A capture arrives in whatever chunks
// the reader chose, and `String.fromCharCode`-ing each one separately cuts a
// multi-byte character in half at every boundary. That is the same rule
// `PtyHost.onData` carries for the live terminal, and it is why this holds
// the tail rather than replacing it.
//
// It is not shared with the tray host's copy: a component and a shared module
// do not import each other's internals, and that one is not streaming.

/** How many bytes a UTF-8 lead byte promises, or 1 for anything invalid. */
function sizeOf(b0: number): number {
  if (b0 < 0x80) return 1;
  if (b0 >= 0xc2 && b0 <= 0xdf) return 2;
  if (b0 >= 0xe0 && b0 <= 0xef) return 3;
  if (b0 >= 0xf0 && b0 <= 0xf4) return 4;
  return 1;
}

/**
 * A decoder that survives a chunk boundary.
 *
 * Malformed input degrades to U+FFFD rather than throwing: a log with one
 * latin-1 byte in it is still a log, and refusing the whole capture over a
 * byte is the wrong trade for a renderer.
 */
export class Utf8Decoder {
  /** The head of a sequence the last chunk ended in the middle of. */
  private _held: number[] = [];

  decode(chunk: Uint8Array | readonly number[]): string {
    const held = this._held;
    const total = held.length + chunk.length;
    const at = (i: number): number =>
      (i < held.length ? held[i]! : chunk[i - held.length]!) & 0xff;

    let out = '';
    let i = 0;
    while (i < total) {
      const b0 = at(i);
      let size = sizeOf(b0);
      let code =
        size === 1
          ? b0 < 0x80
            ? b0
            : 0xfffd
          : b0 & (size === 2 ? 0x1f : size === 3 ? 0x0f : 0x07);

      if (size > 1) {
        // The whole point of this class: a sequence cut by the boundary is
        // carried to the next chunk, not replaced with a replacement char.
        if (i + size > total) break;
        for (let k = 1; k < size; k++) {
          const cont = at(i + k);
          if ((cont & 0xc0) !== 0x80) {
            code = 0xfffd;
            size = 1;
            break;
          }
          code = (code << 6) | (cont & 0x3f);
        }
      }
      out += String.fromCodePoint(code > 0x10ffff ? 0xfffd : code);
      i += size;
    }

    const rest: number[] = [];
    for (let k = i; k < total; k++) rest.push(at(k));
    this._held = rest;
    return out;
  }

  /** No more bytes are coming: whatever is still held was truncated. */
  flush(): string {
    const had = this._held.length > 0;
    this._held = [];
    return had ? '�' : '';
  }
}
