// The page's STUN and TURN servers no candidate could reach, found before a
// stack asks them anything: each server's host looked up, and an address
// that can never be a packet's destination taken as none. A page hears of
// each as an `icecandidateerror` of code 701 (WebRTC 1.0, 4.8.6), which
// werift tells of none of its servers: it skips a server whose name does not
// resolve, and swallows the error a send to an address with no route comes
// back with.
//
// What this cannot see is a server that resolves and never answers, which
// only the agent's own transactions time out on: that one is werift's to
// tell, and is filed for it (docs/prd-webrtc.md, "Where werift differs").
// Nothing here sends a packet.

import type { RTCIceServerLike } from './rtc.js';

/** A server a page named that no candidate could reach. */
export interface IceServerFailure {
  /** Its URL as a browser names it in the event: a `turns:` or a `stuns:`
   *  URL with no transport says it is TCP's. */
  url: string;
  errorCode: number;
  errorText: string;
  /** The address family it resolved to, 4 or 6, or null where it did not
   *  resolve: the family of the host candidate the event names. */
  family: 4 | 6 | null;
}

/** What looks a host up: `node:dns`'s `lookup`, every address. */
export type HostLookup = (
  host: string,
) => Promise<{ address: string; family: number }[]>;

interface ServerUrl {
  /** As the event names it. */
  url: string;
  kind: 'STUN' | 'TURN';
  host: string;
}

/** A STUN or TURN URL's host (RFC 7064, RFC 7065), or null for one that
 *  names none. The page's realm has checked its scheme and form already. */
export function serverOf(url: string): ServerUrl | null {
  const m = /^(stuns?|turns?):(\[[^\]]*\]|[^:?]*)(?::\d+)?(\?.*)?$/i.exec(url);
  if (!m || !m[2]) return null;
  const scheme = m[1].toLowerCase();
  const secure = scheme.endsWith('s');
  return {
    url: secure && !m[3] ? `${url}?transport=tcp` : url,
    kind: scheme.startsWith('stun') ? 'STUN' : 'TURN',
    host: m[2].replace(/^\[|\]$/g, ''),
  };
}

/**
 * Whether no packet can ever be sent to an address: IPv4's "this network"
 * (0.0.0.0/8, RFC 1122, 3.2.1.3), its multicast and reserved blocks
 * (224.0.0.0/4 and 240.0.0.0/4, the limited broadcast among them), and
 * IPv6's unspecified address and its multicast block. A send to one comes
 * back `EHOSTUNREACH` or `EINVAL`, where a UDP `connect()` to one succeeds
 * on macOS, so the address is read rather than tried.
 */
export function neverReachable(address: string): boolean {
  const v4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(address);
  if (v4) {
    const first = Number(v4[1]);
    return first === 0 || first >= 224;
  }
  const v6 = address.toLowerCase();
  return /^(::|0*:(0*:)*:?0*)$/.test(v6) || v6.startsWith('ff');
}

/** `node:dns`'s lookup, where the runtime has it; null where it has none,
 *  which leaves every server as one that may be reached. */
async function nodeLookup(): Promise<HostLookup | null> {
  try {
    const specifier = 'node:dns';
    const dns = (await import(/* @vite-ignore */ specifier)) as {
      promises: {
        lookup(
          host: string,
          options: { all: true },
        ): Promise<{ address: string; family: number }[]>;
      };
    };
    return (host) => dns.promises.lookup(host, { all: true });
  } catch {
    return null;
  }
}

/** Each of the page's servers no candidate could reach, in the order the
 *  page named them. */
export async function unreachableServers(
  servers: readonly RTCIceServerLike[],
  lookup?: HostLookup,
): Promise<IceServerFailure[]> {
  const urls = servers
    .flatMap((s) => s.urls)
    .map(serverOf)
    .filter((u): u is ServerUrl => u !== null);
  if (urls.length === 0) return [];
  const resolve = lookup ?? (await nodeLookup());
  if (!resolve) return [];
  const failures = await Promise.all(
    urls.map(async (u): Promise<IceServerFailure | null> => {
      let addresses: { address: string; family: number }[] = [];
      try {
        addresses = await resolve(u.host);
      } catch {}
      if (addresses.length === 0) {
        return {
          url: u.url,
          errorCode: 701,
          errorText: `${u.kind} host lookup failed.`,
          family: null,
        };
      }
      if (addresses.some((a) => !neverReachable(a.address))) return null;
      return {
        url: u.url,
        errorCode: 701,
        errorText: `${u.kind} server address cannot be reached.`,
        family: addresses[0]?.family === 6 ? 6 : 4,
      };
    }),
  );
  return failures.filter((f): f is IceServerFailure => f !== null);
}
