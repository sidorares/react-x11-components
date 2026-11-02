// The WHATWG Encoding Standard's legacy decoders and encoders, each written
// from its handler in the standard and read off its indexes. This is the heavy
// half of `encoding.ts`, which reaches it by a dynamic `import()` and which the
// script runtime's chunk imports outright: nothing here runs until an encoding
// other than UTF-8 is asked for, and an app that shows none never loads it.
//
// They are here rather than being the runtime's for two reasons. No runtime
// encodes anything but UTF-8, so a form or a URL in a legacy encoding needs an
// encoder in any case. And a runtime's decoders are not the standard's: Node's
// are ICU's, whose `euc-kr` has no UHC and whose `big5` has no HKSCS, and Bun's
// are its own. So a page reads the same on every runtime.
import {
  BIG5,
  EUC_KR,
  GB18030,
  GB18030_RANGES,
  ISO_2022_JP_KATAKANA,
  JIS0208,
  JIS0212,
  SINGLE_BYTE,
} from './encoding-tables.js';

declare const URL: new (
  url: string,
  base?: string,
) => { href: string; protocol: string; search: string };

/** A pointer an index has nothing for reads as 0, which no index maps to. */
type Index = Uint32Array;

const INDEXES = new Map<string, Index>();

/** An index, expanded the first time it is read: a table a page never asks
 *  for stays one string. A run of pointers with nothing at them is U+FFFF and
 *  the run's length, as `scripts/encoding-tables.mjs` writes it. */
function indexOf(text: string, size: number): Index {
  let index = INDEXES.get(text);
  if (index) return index;
  index = new Uint32Array(size);
  let pointer = 0;
  for (let i = 0; i < text.length;) {
    const code = text.codePointAt(i) as number;
    i += code > 0xffff ? 2 : 1;
    if (code === 0xffff) pointer += text.charCodeAt(i++);
    else index[pointer++] = code;
  }
  INDEXES.set(text, index);
  return index;
}

const jis0208 = (): Index => indexOf(JIS0208, 11280);
const jis0212 = (): Index => indexOf(JIS0212, 8836);
const eucKr = (): Index => indexOf(EUC_KR, 23750);
const big5 = (): Index => indexOf(BIG5, 19782);
const gb18030 = (): Index => indexOf(GB18030, 23940);
const katakana = (): Index => indexOf(ISO_2022_JP_KATAKANA, 63);

const POINTERS = new Map<string, Map<number, number>>();

/** The first pointer each code point has in an index, which is the standard's
 *  "index pointer", from `from` on and past `gap` where it is given. Made the
 *  first time something is encoded, and kept. */
function pointersOf(
  key: string,
  index: Index,
  from = 0,
  gap?: [number, number],
): Map<number, number> {
  let map = POINTERS.get(key);
  if (map) return map;
  map = new Map();
  for (let p = index.length - 1; p >= from; p--) {
    if (gap && p >= gap[0] && p <= gap[1]) continue;
    if (index[p]) map.set(index[p], p);
  }
  POINTERS.set(key, map);
  return map;
}

/** "Index gb18030 ranges code point". */
function rangesCodePoint(pointer: number): number {
  if ((pointer > 39419 && pointer < 189000) || pointer > 1237575) return 0;
  if (pointer === 7457) return 0xe7c7;
  let low = 0;
  let high = GB18030_RANGES.length / 2 - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (GB18030_RANGES[middle * 2] <= pointer) low = middle;
    else high = middle - 1;
  }
  return GB18030_RANGES[low * 2 + 1] + pointer - GB18030_RANGES[low * 2];
}

/** "Index gb18030 ranges pointer". */
function rangesPointer(code: number): number {
  if (code === 0xe7c7) return 7457;
  let low = 0;
  let high = GB18030_RANGES.length / 2 - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (GB18030_RANGES[middle * 2 + 1] <= code) low = middle;
    else high = middle - 1;
  }
  return GB18030_RANGES[low * 2] + code - GB18030_RANGES[low * 2 + 1];
}

// --- decoders -----------------------------------------------------------------

/** What a handler returns where it is not a code point. */
const CONTINUE = -1;
const ERROR = -2;
const FINISHED = -3;
/** The end of the queue, as a byte. */
const END = -1;

const isAscii = (byte: number): boolean => byte >= 0 && byte < 0x80;

/** A decoder of the standard's: a handler, what it restores to the queue, and
 *  a second code point where a pointer stands for two. */
abstract class Handler {
  readonly restored: number[] = [];
  second = 0;
  /** A code point, or `CONTINUE`, `ERROR` or `FINISHED`. */
  abstract step(byte: number): number;

  /** Put bytes back at the front of the queue, in their order. */
  protected restore(...bytes: number[]): void {
    for (let i = bytes.length - 1; i >= 0; i--) this.restored.push(bytes[i]);
  }
}

class SingleByte extends Handler {
  constructor(private readonly _index: Index) {
    super();
  }
  step(byte: number): number {
    if (byte === END) return FINISHED;
    if (byte < 0x80) return byte;
    return this._index[byte - 0x80] || ERROR;
  }
}

class Gb18030 extends Handler {
  private _first = 0;
  private _second = 0;
  private _third = 0;
  step(byte: number): number {
    if (byte === END) {
      if (!this._first && !this._second && !this._third) return FINISHED;
      this._first = this._second = this._third = 0;
      return ERROR;
    }
    if (this._third) {
      if (byte < 0x30 || byte > 0x39) {
        this.restore(this._second, this._third, byte);
        this._first = this._second = this._third = 0;
        return ERROR;
      }
      const code = rangesCodePoint(
        (this._first - 0x81) * (10 * 126 * 10) +
          (this._second - 0x30) * (10 * 126) +
          (this._third - 0x81) * 10 +
          byte -
          0x30,
      );
      this._first = this._second = this._third = 0;
      return code || ERROR;
    }
    if (this._second) {
      if (byte >= 0x81 && byte <= 0xfe) {
        this._third = byte;
        return CONTINUE;
      }
      this.restore(this._second, byte);
      this._first = this._second = 0;
      return ERROR;
    }
    if (this._first) {
      if (byte >= 0x30 && byte <= 0x39) {
        this._second = byte;
        return CONTINUE;
      }
      const leading = this._first;
      this._first = 0;
      const offset = byte < 0x7f ? 0x40 : 0x41;
      const code =
        (byte >= 0x40 && byte <= 0x7e) || (byte >= 0x80 && byte <= 0xfe)
          ? gb18030()[(leading - 0x81) * 190 + byte - offset]
          : 0;
      if (code) return code;
      if (isAscii(byte)) this.restore(byte);
      return ERROR;
    }
    if (isAscii(byte)) return byte;
    if (byte === 0x80) return 0x20ac;
    if (byte >= 0x81 && byte <= 0xfe) {
      this._first = byte;
      return CONTINUE;
    }
    return ERROR;
  }
}

class Big5 extends Handler {
  private _leading = 0;
  step(byte: number): number {
    if (byte === END) {
      if (!this._leading) return FINISHED;
      this._leading = 0;
      return ERROR;
    }
    if (this._leading) {
      const leading = this._leading;
      this._leading = 0;
      const offset = byte < 0x7f ? 0x40 : 0x62;
      const pointer =
        (byte >= 0x40 && byte <= 0x7e) || (byte >= 0xa1 && byte <= 0xfe)
          ? (leading - 0x81) * 157 + byte - offset
          : -1;
      // an index holds one code point, and these four pointers are two
      if (pointer === 1133 || pointer === 1135) {
        this.second = pointer === 1133 ? 0x304 : 0x30c;
        return 0xca;
      }
      if (pointer === 1164 || pointer === 1166) {
        this.second = pointer === 1164 ? 0x304 : 0x30c;
        return 0xea;
      }
      const code = pointer < 0 ? 0 : big5()[pointer];
      if (code) return code;
      if (isAscii(byte)) this.restore(byte);
      return ERROR;
    }
    if (isAscii(byte)) return byte;
    if (byte >= 0x81 && byte <= 0xfe) {
      this._leading = byte;
      return CONTINUE;
    }
    return ERROR;
  }
}

class EucJp extends Handler {
  private _jis0212 = false;
  private _leading = 0;
  step(byte: number): number {
    if (byte === END) {
      if (!this._leading) return FINISHED;
      this._leading = 0;
      return ERROR;
    }
    if (this._leading === 0x8e && byte >= 0xa1 && byte <= 0xdf) {
      this._leading = 0;
      return 0xff61 - 0xa1 + byte;
    }
    if (this._leading === 0x8f && byte >= 0xa1 && byte <= 0xfe) {
      this._jis0212 = true;
      this._leading = byte;
      return CONTINUE;
    }
    if (this._leading) {
      const leading = this._leading;
      this._leading = 0;
      const code =
        leading >= 0xa1 && leading <= 0xfe && byte >= 0xa1 && byte <= 0xfe
          ? (this._jis0212 ? jis0212() : jis0208())[
              (leading - 0xa1) * 94 + byte - 0xa1
            ]
          : 0;
      this._jis0212 = false;
      if (code) return code;
      if (isAscii(byte)) this.restore(byte);
      return ERROR;
    }
    if (isAscii(byte)) return byte;
    if (byte === 0x8e || byte === 0x8f || (byte >= 0xa1 && byte <= 0xfe)) {
      this._leading = byte;
      return CONTINUE;
    }
    return ERROR;
  }
}

const JP_ASCII = 0;
const JP_ROMAN = 1;
const JP_KATAKANA = 2;
const JP_LEADING = 3;
const JP_TRAILING = 4;
const JP_ESCAPE_START = 5;
const JP_ESCAPE = 6;

class Iso2022Jp extends Handler {
  private _state = JP_ASCII;
  private _outputState = JP_ASCII;
  private _leading = 0;
  private _output = false;

  private _text(byte: number): number {
    this._output = false;
    return byte;
  }

  step(byte: number): number {
    switch (this._state) {
      case JP_ASCII:
        if (byte === 0x1b) return this._escape();
        if (byte === END) return FINISHED;
        if (byte < 0x80 && byte !== 0x0e && byte !== 0x0f) {
          return this._text(byte);
        }
        this._output = false;
        return ERROR;
      case JP_ROMAN:
        if (byte === 0x1b) return this._escape();
        if (byte === END) return FINISHED;
        if (byte === 0x5c) return this._text(0xa5);
        if (byte === 0x7e) return this._text(0x203e);
        if (byte < 0x80 && byte !== 0x0e && byte !== 0x0f) {
          return this._text(byte);
        }
        this._output = false;
        return ERROR;
      case JP_KATAKANA:
        if (byte === 0x1b) return this._escape();
        if (byte === END) return FINISHED;
        if (byte >= 0x21 && byte <= 0x5f) {
          return this._text(0xff61 - 0x21 + byte);
        }
        this._output = false;
        return ERROR;
      case JP_LEADING:
        if (byte === 0x1b) return this._escape();
        if (byte === END) return FINISHED;
        this._output = false;
        if (byte >= 0x21 && byte <= 0x7e) {
          this._leading = byte;
          this._state = JP_TRAILING;
          return CONTINUE;
        }
        return ERROR;
      case JP_TRAILING: {
        if (byte === 0x1b) {
          this._state = JP_ESCAPE_START;
          return ERROR;
        }
        this._state = JP_LEADING;
        if (byte < 0x21 || byte > 0x7e) return ERROR;
        return jis0208()[(this._leading - 0x21) * 94 + byte - 0x21] || ERROR;
      }
      case JP_ESCAPE_START:
        if (byte === 0x24 || byte === 0x28) {
          this._leading = byte;
          this._state = JP_ESCAPE;
          return CONTINUE;
        }
        if (byte !== END) this.restore(byte);
        this._output = false;
        this._state = this._outputState;
        return ERROR;
      default: {
        const leading = this._leading;
        this._leading = 0;
        let state = -1;
        if (leading === 0x28 && byte === 0x42) state = JP_ASCII;
        else if (leading === 0x28 && byte === 0x4a) state = JP_ROMAN;
        else if (leading === 0x28 && byte === 0x49) state = JP_KATAKANA;
        else if (leading === 0x24 && (byte === 0x40 || byte === 0x42)) {
          state = JP_LEADING;
        }
        if (state >= 0) {
          this._state = this._outputState = state;
          const output = this._output;
          this._output = true;
          return output ? ERROR : CONTINUE;
        }
        if (byte === END) this.restore(leading);
        else this.restore(leading, byte);
        this._output = false;
        this._state = this._outputState;
        return ERROR;
      }
    }
  }

  private _escape(): number {
    this._state = JP_ESCAPE_START;
    return CONTINUE;
  }
}

class ShiftJis extends Handler {
  private _leading = 0;
  step(byte: number): number {
    if (byte === END) {
      if (!this._leading) return FINISHED;
      this._leading = 0;
      return ERROR;
    }
    if (this._leading) {
      const leading = this._leading;
      this._leading = 0;
      const offset = byte < 0x7f ? 0x40 : 0x41;
      const leadingOffset = leading < 0xa0 ? 0x81 : 0xc1;
      const pointer =
        (byte >= 0x40 && byte <= 0x7e) || (byte >= 0x80 && byte <= 0xfc)
          ? (leading - leadingOffset) * 188 + byte - offset
          : -1;
      // interoperable legacy from Windows, known as EUDC
      if (pointer >= 8836 && pointer <= 10715) {
        return 0xe000 - 8836 + pointer;
      }
      const code = pointer < 0 ? 0 : jis0208()[pointer];
      if (code) return code;
      if (isAscii(byte)) this.restore(byte);
      return ERROR;
    }
    if (isAscii(byte) || byte === 0x80) return byte;
    if (byte >= 0xa1 && byte <= 0xdf) return 0xff61 - 0xa1 + byte;
    if ((byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc)) {
      this._leading = byte;
      return CONTINUE;
    }
    return ERROR;
  }
}

class EucKr extends Handler {
  private _leading = 0;
  step(byte: number): number {
    if (byte === END) {
      if (!this._leading) return FINISHED;
      this._leading = 0;
      return ERROR;
    }
    if (this._leading) {
      const leading = this._leading;
      this._leading = 0;
      const code =
        byte >= 0x41 && byte <= 0xfe
          ? eucKr()[(leading - 0x81) * 190 + byte - 0x41]
          : 0;
      if (code) return code;
      if (isAscii(byte)) this.restore(byte);
      return ERROR;
    }
    if (isAscii(byte)) return byte;
    if (byte >= 0x81 && byte <= 0xfe) {
      this._leading = byte;
      return CONTINUE;
    }
    return ERROR;
  }
}

class Replacement extends Handler {
  private _returned = false;
  step(byte: number): number {
    if (byte === END || this._returned) return FINISHED;
    this._returned = true;
    return ERROR;
  }
}

class Utf16 extends Handler {
  private _byte = -1;
  private _surrogate = 0;
  constructor(private readonly _big: boolean) {
    super();
  }
  step(byte: number): number {
    if (byte === END) {
      if (this._byte < 0 && !this._surrogate) return FINISHED;
      this._byte = -1;
      this._surrogate = 0;
      return ERROR;
    }
    if (this._byte < 0) {
      this._byte = byte;
      return CONTINUE;
    }
    const unit = this._big
      ? (this._byte << 8) + byte
      : (byte << 8) + this._byte;
    this._byte = -1;
    if (this._surrogate) {
      const leading = this._surrogate;
      this._surrogate = 0;
      if (unit >= 0xdc00 && unit <= 0xdfff) {
        return 0x10000 + ((leading - 0xd800) << 10) + (unit - 0xdc00);
      }
      const high = unit >> 8;
      const low = unit & 0xff;
      if (this._big) this.restore(high, low);
      else this.restore(low, high);
      return ERROR;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      this._surrogate = unit;
      return CONTINUE;
    }
    return unit >= 0xdc00 && unit <= 0xdfff ? ERROR : unit;
  }
}

class UserDefined extends Handler {
  step(byte: number): number {
    if (byte === END) return FINISHED;
    return byte < 0x80 ? byte : 0xf780 + byte - 0x80;
  }
}

/** A single-byte encoding's index, which ISO-8859-8-I shares with
 *  ISO-8859-8: the two differ in how text is ordered, not in its bytes. */
const singleByte = (name: string): string | undefined =>
  SINGLE_BYTE[name === 'ISO-8859-8-I' ? 'iso-8859-8' : name.toLowerCase()];

function handlerFor(name: string): Handler | null {
  switch (name) {
    case 'GBK':
    case 'gb18030':
      return new Gb18030();
    case 'Big5':
      return new Big5();
    case 'EUC-JP':
      return new EucJp();
    case 'ISO-2022-JP':
      return new Iso2022Jp();
    case 'Shift_JIS':
      return new ShiftJis();
    case 'EUC-KR':
      return new EucKr();
    case 'replacement':
      return new Replacement();
    case 'UTF-16BE':
      return new Utf16(true);
    case 'UTF-16LE':
      return new Utf16(false);
    case 'x-user-defined':
      return new UserDefined();
  }
  const text = singleByte(name);
  return text === undefined ? null : new SingleByte(indexOf(text, 128));
}

/** A decoder of one encoding, which keeps what a chunk left unfinished. */
export interface LegacyDecoder {
  /** The text of what has arrived, or null at the first error where `fatal`
   *  asks for that. `stream` says more is coming. */
  decode(bytes: Uint8Array, stream: boolean, fatal: boolean): string | null;
}

/** The decoder of an encoding by its name, or null for one that has none
 *  here: UTF-8, which every caller has already. */
export function decoderFor(name: string): LegacyDecoder | null {
  const handler = handlerFor(name);
  if (!handler) return null;
  return {
    decode(bytes, stream, fatal) {
      const units: number[] = [];
      let text = '';
      const flush = (): void => {
        text += String.fromCharCode.apply(null, units);
        units.length = 0;
      };
      const put = (code: number): void => {
        if (code > 0xffff) {
          const c = code - 0x10000;
          units.push(0xd800 + (c >> 10), 0xdc00 + (c & 1023));
        } else units.push(code);
        if (units.length > 8192) flush();
      };
      const { restored } = handler;
      for (let i = 0; ;) {
        let byte: number;
        if (restored.length) byte = restored.pop() as number;
        else if (i < bytes.length) byte = bytes[i++];
        else if (stream) break;
        else byte = END;
        const result = handler.step(byte);
        if (result === FINISHED) break;
        if (result === CONTINUE) continue;
        if (result === ERROR) {
          if (fatal) {
            // what was not read stays in the queue for a stream's next call
            for (let k = bytes.length - 1; k >= i; k--) restored.push(bytes[k]);
            return null;
          }
          put(0xfffd);
          continue;
        }
        put(result);
        if (handler.second) {
          put(handler.second);
          handler.second = 0;
        }
      }
      flush();
      return text;
    },
  };
}

// --- encoders -----------------------------------------------------------------

/** What an encoder's handler returns where a code point went out. */
const DONE = -1;

interface Encoder {
  /** `DONE`, or the code point it has no bytes for. */
  step(code: number, out: number[]): number;
  /** The end of the queue. */
  end(out: number[]): void;
}

const NO_END = (): void => {};

function singleByteEncoder(text: string): Encoder {
  const pointers = pointersOf(text, indexOf(text, 128));
  return {
    step(code, out) {
      if (code < 0x80) {
        out.push(code);
        return DONE;
      }
      const pointer = pointers.get(code);
      if (pointer === undefined) return code;
      out.push(pointer + 0x80);
      return DONE;
    },
    end: NO_END,
  };
}

/** The bytes gb18030's encoder writes where they are no index's: this
 *  asymmetry keeps it compatible with GB18030-2005. */
const GB18030_ASYMMETRIC = new Map<number, number>([
  [0xe78d, 0xa6d9],
  [0xe78e, 0xa6da],
  [0xe78f, 0xa6db],
  [0xe790, 0xa6dc],
  [0xe791, 0xa6dd],
  [0xe792, 0xa6de],
  [0xe793, 0xa6df],
  [0xe794, 0xa6ec],
  [0xe795, 0xa6ed],
  [0xe796, 0xa6f3],
  [0xe81e, 0xfe59],
  [0xe826, 0xfe61],
  [0xe82b, 0xfe66],
  [0xe82c, 0xfe67],
  [0xe832, 0xfe6d],
  [0xe843, 0xfe7e],
  [0xe854, 0xfe90],
  [0xe864, 0xfea0],
]);

function gb18030Encoder(isGbk: boolean): Encoder {
  const pointers = pointersOf('gb18030', gb18030());
  return {
    step(code, out) {
      if (code < 0x80) {
        out.push(code);
        return DONE;
      }
      if (code === 0xe5e5) return code;
      if (isGbk && code === 0x20ac) {
        out.push(0x80);
        return DONE;
      }
      const pair = GB18030_ASYMMETRIC.get(code);
      if (pair !== undefined) {
        out.push(pair >> 8, pair & 0xff);
        return DONE;
      }
      const pointer = pointers.get(code);
      if (pointer !== undefined) {
        const trailing = pointer % 190;
        out.push(
          Math.floor(pointer / 190) + 0x81,
          trailing + (trailing < 0x3f ? 0x40 : 0x41),
        );
        return DONE;
      }
      if (isGbk) return code;
      let rest = rangesPointer(code);
      const byte1 = Math.floor(rest / (10 * 126 * 10));
      rest %= 10 * 126 * 10;
      const byte2 = Math.floor(rest / (10 * 126));
      rest %= 10 * 126;
      const byte3 = Math.floor(rest / 10);
      out.push(byte1 + 0x81, byte2 + 0x30, byte3 + 0x81, (rest % 10) + 0x30);
      return DONE;
    },
    end: NO_END,
  };
}

/** Where a code point is two pointers, the six the standard takes the last
 *  of, past what is only in Big5's extension for Hong Kong. */
const BIG5_LAST = [0x2550, 0x255e, 0x2561, 0x256a, 0x5341, 0x5345];

function big5Encoder(): Encoder {
  const index = big5();
  let pointers = POINTERS.get('Big5');
  if (!pointers) {
    pointers = pointersOf('Big5', index, (0xa1 - 0x81) * 157);
    for (const code of BIG5_LAST) pointers.set(code, index.lastIndexOf(code));
  }
  const map = pointers;
  return {
    step(code, out) {
      if (code < 0x80) {
        out.push(code);
        return DONE;
      }
      const pointer = map.get(code);
      if (pointer === undefined) return code;
      const trailing = pointer % 157;
      out.push(
        Math.floor(pointer / 157) + 0x81,
        trailing + (trailing < 0x3f ? 0x40 : 0x62),
      );
      return DONE;
    },
    end: NO_END,
  };
}

function eucJpEncoder(): Encoder {
  const pointers = pointersOf('jis0208', jis0208());
  return {
    step(code, out) {
      if (code < 0x80) out.push(code);
      else if (code === 0xa5) out.push(0x5c);
      else if (code === 0x203e) out.push(0x7e);
      else if (code >= 0xff61 && code <= 0xff9f) {
        out.push(0x8e, code - 0xff61 + 0xa1);
      } else {
        const pointer = pointers.get(code === 0x2212 ? 0xff0d : code);
        if (pointer === undefined) return code;
        out.push(Math.floor(pointer / 94) + 0xa1, (pointer % 94) + 0xa1);
      }
      return DONE;
    },
    end: NO_END,
  };
}

const TO_ASCII = 0;
const TO_ROMAN = 1;
const TO_JIS0208 = 2;

function iso2022JpEncoder(): Encoder {
  const pointers = pointersOf('jis0208', jis0208());
  let state = TO_ASCII;
  const toAscii = (out: number[]): void => {
    state = TO_ASCII;
    out.push(0x1b, 0x28, 0x42);
  };
  const step = (given: number, out: number[]): number => {
    let code = given;
    if (
      state !== TO_JIS0208 &&
      (code === 0x0e || code === 0x0f || code === 0x1b)
    ) {
      // U+FFFD rather than the code point, which would be an attack
      return 0xfffd;
    }
    if (state === TO_ASCII && code < 0x80) {
      out.push(code);
      return DONE;
    }
    if (state === TO_ROMAN) {
      if (code < 0x80 && code !== 0x5c && code !== 0x7e) {
        out.push(code);
        return DONE;
      }
      if (code === 0xa5 || code === 0x203e) {
        out.push(code === 0xa5 ? 0x5c : 0x7e);
        return DONE;
      }
    }
    if (code < 0x80) {
      toAscii(out);
      return step(code, out);
    }
    if (code === 0xa5 || code === 0x203e) {
      state = TO_ROMAN;
      out.push(0x1b, 0x28, 0x4a);
      return step(code, out);
    }
    if (code === 0x2212) code = 0xff0d;
    if (code >= 0xff61 && code <= 0xff9f) code = katakana()[code - 0xff61];
    const pointer = pointers.get(code);
    if (pointer === undefined) {
      if (state === TO_JIS0208) {
        toAscii(out);
        return step(code, out);
      }
      return code;
    }
    if (state !== TO_JIS0208) {
      state = TO_JIS0208;
      out.push(0x1b, 0x24, 0x42);
      return step(code, out);
    }
    out.push(Math.floor(pointer / 94) + 0x21, (pointer % 94) + 0x21);
    return DONE;
  };
  return {
    step,
    end(out) {
      if (state !== TO_ASCII) toAscii(out);
    },
  };
}

function shiftJisEncoder(): Encoder {
  // the index's duplicates: left out, a later pointer is the one taken
  const pointers = pointersOf('Shift_JIS', jis0208(), 0, [8272, 8835]);
  return {
    step(code, out) {
      if (code <= 0x80) out.push(code);
      else if (code === 0xa5) out.push(0x5c);
      else if (code === 0x203e) out.push(0x7e);
      else if (code >= 0xff61 && code <= 0xff9f) {
        out.push(code - 0xff61 + 0xa1);
      } else {
        const pointer = pointers.get(code === 0x2212 ? 0xff0d : code);
        if (pointer === undefined) return code;
        const leading = Math.floor(pointer / 188);
        const trailing = pointer % 188;
        out.push(
          leading + (leading < 0x1f ? 0x81 : 0xc1),
          trailing + (trailing < 0x3f ? 0x40 : 0x41),
        );
      }
      return DONE;
    },
    end: NO_END,
  };
}

function eucKrEncoder(): Encoder {
  const pointers = pointersOf('EUC-KR', eucKr());
  return {
    step(code, out) {
      if (code < 0x80) {
        out.push(code);
        return DONE;
      }
      const pointer = pointers.get(code);
      if (pointer === undefined) return code;
      out.push(Math.floor(pointer / 190) + 0x81, (pointer % 190) + 0x41);
      return DONE;
    },
    end: NO_END,
  };
}

const USER_DEFINED: Encoder = {
  step(code, out) {
    if (code < 0x80) out.push(code);
    else if (code >= 0xf780 && code <= 0xf7ff) out.push(code - 0xf780 + 0x80);
    else return code;
    return DONE;
  },
  end: NO_END,
};

function encoderFor(name: string): Encoder | null {
  switch (name) {
    case 'GBK':
      return gb18030Encoder(true);
    case 'gb18030':
      return gb18030Encoder(false);
    case 'Big5':
      return big5Encoder();
    case 'EUC-JP':
      return eucJpEncoder();
    case 'ISO-2022-JP':
      return iso2022JpEncoder();
    case 'Shift_JIS':
      return shiftJisEncoder();
    case 'EUC-KR':
      return eucKrEncoder();
    case 'x-user-defined':
      return USER_DEFINED;
  }
  const text = singleByte(name);
  return text === undefined ? null : singleByteEncoder(text);
}

/**
 * `text`'s scalar values through an encoding's encoder: `byte` is told each
 * byte, and `unmappable` each code point the encoding has none for, which may
 * answer with text to encode in its place. The encoder is one for all of it,
 * since ISO-2022-JP's holds its state across an error.
 */
function encode(
  name: string,
  text: string,
  byte: (value: number) => void,
  unmappable: (code: number) => string | void,
): void {
  const encoder = encoderFor(name);
  if (!encoder) throw new RangeError(`${name} has no encoder.`);
  const out: number[] = [];
  const flush = (): void => {
    for (const value of out) byte(value);
    out.length = 0;
  };
  const run = (input: string): void => {
    for (const char of input) {
      let code = char.codePointAt(0) as number;
      if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
      const error = encoder.step(code, out);
      flush();
      if (error !== DONE) {
        const instead = unmappable(error);
        if (instead) run(instead);
      }
    }
  };
  run(text);
  encoder.end(out);
  flush();
}

/** `text` as bytes, what the encoding cannot hold written as `&#NNN;`
 *  (Encoding's "encode", error mode `html`): a form's values where they go
 *  as they are. */
export function encodeForForm(name: string, text: string): Uint8Array {
  const bytes: number[] = [];
  encode(
    name,
    text,
    (value) => bytes.push(value),
    (code) => `&#${code};`,
  );
  return new Uint8Array(bytes);
}

const HEX = '0123456789ABCDEF';
const percent = (byte: number): string => `%${HEX[byte >> 4]}${HEX[byte & 15]}`;

/**
 * URL's "percent-encode after encoding": a byte of `text` in the encoding as
 * it is where `keep` says so, a space as `+` where `plus` does, anything else
 * percent-encoded, and what the encoding cannot hold as `%26%23NNN%3B`.
 */
export function percentEncoded(
  name: string,
  text: string,
  keep: (byte: number) => boolean,
  plus: boolean,
): string {
  let out = '';
  encode(
    name,
    text,
    (byte) => {
      if (plus && byte === 0x20) out += '+';
      else out += keep(byte) ? String.fromCharCode(byte) : percent(byte);
    },
    (code) => {
      out += `%26%23${code}%3B`;
    },
  );
  return out;
}

/** The query percent-encode set's complement, for a URL whose scheme is
 *  special. */
const inQuery = (byte: number): boolean =>
  byte > 0x20 &&
  byte < 0x7f &&
  byte !== 0x22 &&
  byte !== 0x23 &&
  byte !== 0x3c &&
  byte !== 0x3e &&
  byte !== 0x27;

/** A special scheme's, but for a WebSocket's, whose query is always UTF-8
 *  (URL's basic parser, its first step for `query state`). */
const QUERY_ENCODED = /^(?:http|https|ftp|file):$/;

/**
 * `input` parsed against `base` where the document's encoding is `name`:
 * URL's parser with an encoding. A query is the only part of a URL an encoding
 * reaches, so the query as written is encoded and set on what the runtime's
 * parser made of the rest, which leaves ASCII as it is.
 */
export function urlInEncoding(
  name: string,
  input: string,
  base: string | undefined,
): string {
  const url = new URL(input, base);
  // ISO-2022-JP cannot hold three of ASCII's, which would write an escape
  const moved =
    name === 'ISO-2022-JP' ? /[^\x00-\x7f]|[\x0e\x0f\x1b]/ : /[^\x00-\x7f]/;
  if (!moved.test(input) || !QUERY_ENCODED.test(url.protocol)) return url.href;
  const hash = input.indexOf('#');
  const head = hash < 0 ? input : input.slice(0, hash);
  const start = head.indexOf('?');
  if (start < 0) return url.href;
  // what the parser takes off before it reads anything
  const written = head.slice(start + 1);
  const query = (
    hash < 0 ? written.replace(/[\x00-\x20]+$/, '') : written
  ).replace(/[\t\n\r]/g, '');
  url.search = `?${percentEncoded(name, query, inQuery, false)}`;
  return url.href;
}
