// WebM written by hand, for the tests of what a page appends to a
// `MediaSource`: the elements `src/html/scripts/webm.ts` reads, and packets
// that are VP9 only as far as their first bytes say. Nothing here is decoded;
// each packet's bytes are its own, so a test can tell them apart.

const vint = (n: number, length: number): number[] => {
  const out: number[] = [];
  let v = n;
  for (let i = 0; i < length; i += 1) {
    out.unshift(v % 256);
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
};

const idBytes = (id: number): number[] => {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
};

const element = (id: number, ...body: (number[] | Uint8Array)[]): number[] => {
  const payload = body.flatMap((b) => [...b]);
  return [...idBytes(id), ...vint(payload.length, 4), ...payload];
};

/** A master that says it does not know how long it is. */
const open = (id: number, ...body: number[][]): number[] => [
  ...idBytes(id),
  0x01,
  ...new Array<number>(7).fill(0xff),
  ...body.flat(),
];

const uint = (id: number, value: number): number[] => {
  const out: number[] = [];
  for (let v = value; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return element(id, out.length ? out : [0]);
};

const float64 = (id: number, value: number): number[] => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value);
  return element(id, bytes);
};

const text = (id: number, value: string): number[] =>
  element(
    id,
    Array.from(value, (c) => c.charCodeAt(0)),
  );

/** A packet with a VP9 header, 8-bit 4:2:0 BT.709 at video range where it is
 *  a key frame, and bytes of its own after it. */
export function sampleOf(index: number, key: boolean): Uint8Array {
  const head = key
    ? // marker, profile 0, not a shown frame, key, shown; the sync code;
      // BT.709 in video range
      [0b10000010, 0x49, 0x83, 0x42, 0b01000000]
    : [0b10000110, 0];
  return new Uint8Array([...head, ...[0, 1, 2].map((i) => (index + i) & 0xff)]);
}

export interface WebmOptions {
  /** How many frames, at thirty a second. */
  count: number;
  /** A key frame every so many. Default 4. */
  every?: number;
  /** Segment and clusters with no size. */
  unknownSizes?: boolean;
  /** Blocks in block groups, not simple blocks. */
  groups?: boolean;
  /** An audio track beside the video, with blocks of its own. */
  audio?: boolean;
  codec?: string;
  /** Blocks marked laced. */
  lacing?: boolean;
}

/** A stream, and the frames it holds as the track has them. */
export function webmStream(options: WebmOptions): {
  bytes: Uint8Array;
  frames: { time: number; data: Uint8Array }[];
} {
  const every = options.every ?? 4;
  const frames = Array.from({ length: options.count }, (_, i) => ({
    time: Math.round((i / 30) * 1000) / 1000,
    data: sampleOf(i, i % every === 0),
  }));
  const block = (track: number, tick: number, data: Uint8Array): number[] => [
    0x80 | track,
    0,
    tick,
    options.lacing ? 0x02 : 0x80,
    ...data,
  ];
  const clusters: number[][] = [];
  const size = 4;
  for (let i = 0; i < frames.length; i += size) {
    const part = frames.slice(i, i + size);
    const base = Math.round(part[0].time * 1000);
    const body = [
      uint(0xe7, base),
      ...part.flatMap((frame) => {
        const tick = Math.round(frame.time * 1000) - base;
        const video = options.groups
          ? element(0xa0, element(0xa1, block(1, tick, frame.data)))
          : element(0xa3, block(1, tick, frame.data));
        return options.audio
          ? [element(0xa3, block(2, tick, new Uint8Array([9, 9, 9]))), video]
          : [video];
      }),
    ];
    clusters.push(
      options.unknownSizes
        ? open(0x1f43b675, ...body)
        : element(0x1f43b675, ...body),
    );
  }
  const head = element(0x1a45dfa3, text(0x4282, 'webm'));
  const info = element(
    0x1549a966,
    uint(0x2ad7b1, 1_000_000),
    float64(0x4489, Math.round((options.count / 30) * 1000)),
  );
  const videoTrack = element(
    0xae,
    uint(0xd7, 1),
    uint(0x83, 1),
    text(0x86, options.codec ?? 'V_VP9'),
    element(
      0xe0,
      uint(0xb0, 320),
      uint(0xba, 180),
      element(
        0x55b0,
        uint(0x55b1, 1),
        uint(0x55b9, 1),
        uint(0x55ba, 13),
        uint(0x55bb, 1),
      ),
    ),
  );
  const audioTrack = element(
    0xae,
    uint(0xd7, 2),
    uint(0x83, 2),
    text(0x86, 'A_OPUS'),
  );
  const tracks = element(
    0x1654ae6b,
    videoTrack,
    ...(options.audio ? [audioTrack] : []),
  );
  const parts = [info, tracks, ...clusters];
  const segment = options.unknownSizes
    ? open(0x18538067, ...parts)
    : element(0x18538067, ...parts);
  return { bytes: new Uint8Array([...head, ...segment]), frames };
}
