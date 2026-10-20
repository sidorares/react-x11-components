// GIFs written for a test: a palette of four colours and the frames given,
// each pixel a colour index. The LZW data is the simplest stream the
// format allows — a clear code before every pixel, so the codes never grow
// past three bits and nothing is ever looked up — which any decoder reads.
//
// Not a `.test.ts` file, so `tsx --test test/*.test.ts` does not run it, but
// `tsconfig.json` does typecheck it.

export interface FixtureFrame {
  /** Colour indices, `width * height` of them, row by row. */
  pixels: number[];
  left?: number;
  top?: number;
  /** The frame's size; the screen's where absent. */
  width?: number;
  height?: number;
  /** Centiseconds, as the file stores it. */
  delay?: number;
  disposal?: number;
  transparent?: number;
}

export interface FixtureGif {
  width: number;
  height: number;
  /** Four RGB colours. */
  palette: [number, number, number][];
  frames: FixtureFrame[];
  /** The NETSCAPE2.0 loop count; no extension where absent. */
  loops?: number;
}

export function gifBytes(gif: FixtureGif): Uint8Array {
  const out: number[] = [];
  const u16 = (n: number) => out.push(n & 0xff, n >> 8);
  out.push(...[...'GIF89a'].map((c) => c.charCodeAt(0)));
  u16(gif.width);
  u16(gif.height);
  out.push(0x81, 0, 0); // a global table of 2^(1+1) colours
  for (const [r, g, b] of gif.palette) out.push(r, g, b);
  if (gif.loops !== undefined) {
    out.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)));
    out.push(3, 1);
    u16(gif.loops);
    out.push(0);
  }
  for (const frame of gif.frames) {
    const transparent = frame.transparent ?? -1;
    out.push(0x21, 0xf9, 4);
    out.push(((frame.disposal ?? 0) << 2) | (transparent >= 0 ? 1 : 0));
    u16(frame.delay ?? 10);
    out.push(Math.max(0, transparent), 0);
    out.push(0x2c);
    u16(frame.left ?? 0);
    u16(frame.top ?? 0);
    u16(frame.width ?? gif.width);
    u16(frame.height ?? gif.height);
    out.push(0, 2); // no local table; a minimum code size of 2
    // clear (4) then the index, three bits each, least significant first;
    // then end (5)
    const codes: number[] = [];
    for (const p of frame.pixels) codes.push(4, p);
    codes.push(5);
    const data: number[] = [];
    let bits = 0;
    let count = 0;
    for (const code of codes) {
      bits |= code << count;
      count += 3;
      while (count >= 8) {
        data.push(bits & 0xff);
        bits >>= 8;
        count -= 8;
      }
    }
    if (count) data.push(bits & 0xff);
    for (let at = 0; at < data.length; at += 255) {
      const block = data.slice(at, at + 255);
      out.push(block.length, ...block);
    }
    out.push(0);
  }
  out.push(0x3b);
  return new Uint8Array(out);
}
