// What the address bar means by what was typed into it.
//
// A URL with a scheme is taken as it is; a path on this machine opens the
// file; something shaped like a host name gets `https://` in front of it;
// anything else is a search. The search engine is DuckDuckGo's HTML one,
// because it is the one that works without a script engine — set
// `BROWSER_SEARCH` to another URL with `%s` where the query goes.
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEARCH =
  process.env.BROWSER_SEARCH ?? 'https://lite.duckduckgo.com/lite/?q=%s';

const SCHEMES = /^(?:https?|file|about|data|view-source):/i;

/** A host, with an optional port: `example.com`, `localhost:8080`,
 *  `192.168.0.1`. A dot is what tells `news.ycombinator.com` from a word. */
const HOSTISH =
  /^(?:localhost|\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3}|[\w-]+(?:\.[\w-]+)*\.[a-z][\w-]*)(?::\d+)?$/i;

/** The URL to go to for what was typed, or null for nothing. */
export function urlFromInput(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^https?:/i.test(text)) return parsed(text) ?? text;
  if (SCHEMES.test(text)) return text;
  if (text.startsWith('/') || text.startsWith('~/') || text === '~') {
    const path = text.startsWith('~') ? homedir() + text.slice(1) : text;
    return pathToFileURL(resolve(path)).href;
  }
  // what comes before the path is a host, or the whole thing is a search:
  // `example.com/?q=two words` is an address, `two words` is not
  const at = text.search(/[/?#]/);
  const host = at < 0 ? text : text.slice(0, at);
  if (HOSTISH.test(host)) {
    const local = /^(?:localhost|\[|\d)/i.test(host);
    const url = parsed(`${local ? 'http' : 'https'}://${text}`);
    if (url) return url;
  }
  return SEARCH.replace('%s', encodeURIComponent(text));
}

/** A URL as the WHATWG parser writes it — a space in a query encoded, a
 *  host lowercased — or null for one it refuses. */
function parsed(url: string): string | null {
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

/** What a URL is shown as in the address bar: as it is, but a new tab's
 *  page shows an empty bar waiting for an address. */
export function displayUrl(url: string): string {
  return url === 'about:home' ? '' : url;
}
