// asciinema recordings, read.
//
// A cast is the standard interchange format for "I ran this in a pty and kept
// it", so a static renderer that cannot open one is a static renderer that
// asks every user to write the same twenty lines. Both published versions are
// read: v2 is JSON Lines (a header object, then `[time, kind, data]` events),
// v1 is one JSON document with relative delays.
//
// **This is a reader, not a player.** `castOutput(cast, { until })` gives the
// bytes up to a moment and `parseAnsi` turns those into a document; scheduling
// the moments is the app's, because a component with a timer inside it never
// settles in a screenshot test. See the PRD.

/** The recording's own metadata: the grid it was made at, and its title. */
export interface AnsiCastHeader {
  version: number;
  width: number;
  height: number;
  title?: string;
  /** Unix seconds, when the recording says. */
  timestamp?: number;
  env?: Readonly<Record<string, string>>;
}

/** One recorded event. `'o'` is output — the only kind that has pixels. */
export interface AnsiCastEvent {
  /** Seconds from the start of the recording. Absolute, v1's deltas
   *  included: a reader should not have to know which version it opened. */
  readonly time: number;
  readonly kind: 'o' | 'i' | 'r' | 'm' | string;
  readonly data: string;
}

export interface AnsiCast {
  readonly header: AnsiCastHeader;
  readonly events: readonly AnsiCastEvent[];
}

/** What `parseCast` refuses. Its own type so an app can tell "not a cast"
 *  from a read error, which is the only distinction a caller acts on. */
export class CastFormatError extends Error {
  constructor(message: string) {
    super(`@react-x11/components: ${message}`);
    this.name = 'CastFormatError';
  }
}

function headerOf(value: unknown): AnsiCastHeader {
  const raw = (value ?? {}) as Record<string, unknown>;
  const num = (v: unknown, dflt: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  const header: AnsiCastHeader = {
    version: num(raw.version, 2),
    width: Math.max(1, num(raw.width, 80)),
    height: Math.max(1, num(raw.height, 24)),
  };
  if (typeof raw.title === 'string') header.title = raw.title;
  if (typeof raw.timestamp === 'number') header.timestamp = raw.timestamp;
  if (raw.env && typeof raw.env === 'object') {
    header.env = raw.env as Record<string, string>;
  }
  return header;
}

/**
 * Read a recording.
 *
 * A malformed *event* line is skipped rather than fatal — a recording still
 * being written has a partial last line, and refusing the whole file over it
 * is the wrong trade. A missing or unreadable *header* throws, because
 * without one there is no recording to read.
 */
export function parseCast(text: string): AnsiCast {
  const trimmed = text.trim();
  if (!trimmed) throw new CastFormatError('the recording is empty');

  // v1 is one JSON document, so it is exactly the case where parsing the
  // whole file succeeds. A v2 file is several JSON values and does not.
  let whole: unknown;
  try {
    whole = JSON.parse(trimmed);
  } catch {
    whole = undefined;
  }
  if (whole && typeof whole === 'object') {
    const raw = whole as Record<string, unknown>;
    if (Array.isArray(raw.stdout)) {
      const header = headerOf(raw);
      const events: AnsiCastEvent[] = [];
      let time = 0;
      for (const entry of raw.stdout) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [delay, data] = entry as [unknown, unknown];
        if (typeof delay !== 'number' || typeof data !== 'string') continue;
        // v1 records the gap since the previous event; every consumer wants
        // the moment, so the conversion happens here rather than in each one.
        time += delay;
        events.push({ time, kind: 'o', data });
      }
      return { header: { ...header, version: 1 }, events };
    }
    // A v2 file whose recording is empty: a header and nothing after it.
    return { header: headerOf(raw), events: [] };
  }

  const lines = trimmed.split('\n');
  let header: AnsiCastHeader | null = null;
  const events: AnsiCastEvent[] = [];
  for (const line of lines) {
    const source = line.trim();
    if (!source) continue;
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      continue;
    }
    if (!header) {
      if (Array.isArray(value)) {
        throw new CastFormatError(
          'the recording starts with an event rather than a header — ' +
            'this does not look like an asciinema cast',
        );
      }
      header = headerOf(value);
      continue;
    }
    if (!Array.isArray(value) || value.length < 3) continue;
    const [time, kind, data] = value as [unknown, unknown, unknown];
    if (typeof time !== 'number' || typeof data !== 'string') continue;
    events.push({ time, kind: typeof kind === 'string' ? kind : 'o', data });
  }
  if (!header) {
    throw new CastFormatError('the recording has no header line');
  }
  return { header, events };
}

/**
 * The recorded output, concatenated — what a terminal received.
 *
 * `until` is a moment in seconds: pass it to render the session as it looked
 * then, which with a slider in the app is a scrubber and without one is a
 * still. Input, resize and marker events are left out, because only output
 * has pixels.
 */
export function castOutput(
  cast: AnsiCast,
  options: { until?: number } = {},
): string {
  const until = options.until ?? Infinity;
  let out = '';
  for (const event of cast.events) {
    if (event.kind !== 'o') continue;
    if (event.time > until) break;
    out += event.data;
  }
  return out;
}
