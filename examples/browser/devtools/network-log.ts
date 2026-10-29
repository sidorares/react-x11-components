// What the Network panel draws: each request the tab's network made while
// the tools were open, put together from what `HtmlNetwork.observe` told
// of it — a request, when it was sent, its response, its body a chunk at a
// time, its end.
//
// A busy page tells of hundreds of chunks a second, so the log changes its
// entries as they come and tells its readers at most ten times a second.
// And it keeps the bodies, for the Preview and Response tabs, only so far:
// past `MOST_BODY` bytes a body is no longer kept, though what arrived is
// still counted, and past `MOST_KEPT` in all the oldest bodies go first.
import type {
  HtmlNetworkActivity,
  HtmlRequestKind,
} from '../../../src/html/index.js';
import { Store } from './model.js';

export interface NetworkEntry {
  id: number;
  kind: HtmlRequestKind;
  url: string;
  method: string;
  requestHeaders: Readonly<Record<string, string>>;
  requestBody: string | Uint8Array | null;
  /** The document it was for, or null for a navigation. */
  page: string | null;
  /** When it was asked for, sent, answered and over, in milliseconds since
   *  the epoch. */
  queued: number;
  sent?: number;
  responded?: number;
  ended?: number;
  status?: number;
  statusText?: string;
  responseHeaders?: readonly [string, string][];
  /** Where a cache answered it with nothing sent. */
  cache?: 'memory' | 'disk';
  redirected?: boolean;
  /** Where it ended up, past its redirects. */
  finalUrl?: string;
  /** How many bytes of body arrived. */
  size: number;
  /** The body as it arrived, while it is kept. */
  body: readonly Uint8Array[];
  /** Some of the body was not kept. */
  truncated: boolean;
  /** Why it did not come; `canceled` where who asked stopped reading. */
  error?: string;
}

/** How many bytes of one body are kept, and of every body together. */
const MOST_BODY = 8 * 1024 * 1024;
const MOST_KEPT = 64 * 1024 * 1024;
/** How many requests the log keeps: the oldest go past it. */
const MOST_ENTRIES = 2000;
/** How often its readers are told, at most. */
const TELL_MS = 100;

export class NetworkLog extends Store<readonly NetworkEntry[]> {
  private readonly _entries = new Map<number, NetworkEntry>();
  private _kept = 0;
  private _timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super([]);
  }

  /** One thing the network told. */
  take(activity: HtmlNetworkActivity): void {
    if (activity.type === 'request') {
      this._entries.set(activity.id, {
        id: activity.id,
        kind: activity.kind,
        url: activity.url,
        method: activity.method,
        requestHeaders: activity.headers,
        requestBody: activity.body,
        page: activity.page,
        queued: activity.time,
        size: 0,
        body: [],
        truncated: false,
      });
      if (this._entries.size > MOST_ENTRIES) {
        const [oldest] = this._entries.keys();
        this._drop(oldest);
      }
      return this._soon();
    }
    const was = this._entries.get(activity.id);
    if (!was) return;
    let next: NetworkEntry;
    switch (activity.type) {
      case 'sent':
        next = { ...was, sent: activity.time };
        break;
      case 'response':
        next = {
          ...was,
          responded: activity.time,
          status: activity.status,
          statusText: activity.statusText,
          responseHeaders: activity.headers,
          redirected: activity.redirected,
          finalUrl: activity.url,
          ...(activity.cache && { cache: activity.cache }),
        };
        break;
      case 'data': {
        const length = activity.chunk.length;
        const keep = !was.truncated && keptOf(was) + length <= MOST_BODY;
        if (keep) this._kept += length;
        next = {
          ...was,
          size: was.size + length,
          body: keep ? [...was.body, activity.chunk] : was.body,
          truncated: was.truncated || !keep,
        };
        break;
      }
      case 'end':
        next = { ...was, ended: activity.time };
        break;
      case 'failed':
        next = { ...was, ended: activity.time, error: activity.error };
        break;
    }
    this._entries.set(activity.id, next);
    while (this._kept > MOST_KEPT) {
      const victim = [...this._entries.values()].find((e) => e.body.length);
      if (!victim) break;
      this._kept -= keptOf(victim);
      this._entries.set(victim.id, { ...victim, body: [], truncated: true });
    }
    this._soon();
  }

  clear(): void {
    this._entries.clear();
    this._kept = 0;
    this.set([]);
  }

  private _drop(id: number): void {
    const gone = this._entries.get(id);
    if (gone) this._kept -= keptOf(gone);
    this._entries.delete(id);
  }

  private _soon(): void {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.set([...this._entries.values()]);
    }, TELL_MS);
  }
}

const keptOf = (entry: NetworkEntry): number =>
  entry.body.reduce((n, chunk) => n + chunk.length, 0);

/** A body as one array of bytes. */
export function bodyBytes(entry: NetworkEntry): Uint8Array {
  const out = new Uint8Array(keptOf(entry));
  let at = 0;
  for (const chunk of entry.body) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** A response's header field, by name. */
export function headerOf(entry: NetworkEntry, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of entry.responseHeaders ?? []) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/** What a response is, by its `Content-Type`, as the panel shows and
 *  previews it. */
export function mimeOf(entry: NetworkEntry): string {
  return (headerOf(entry, 'content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}
