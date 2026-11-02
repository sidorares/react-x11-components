// Whether a document lets itself be framed where it is being framed: its
// `Content-Security-Policy`'s `frame-ancestors` (CSP 3, 6.4.2) and its
// `X-Frame-Options` (HTML 7.4.5), which is what a site that holds a signed-in
// user has against being laid under another page and clicked on through it.
// Both are about every document around the frame, not the one it is in: a
// page of the site's own origin in a frame of another's is as framed as any.
//
// Pure, read from the response alone, and asked before anything of the
// document is parsed.
import { matchesSourceList, parseCsp } from '../csp.js';
import { headerList } from './sandbox.js';

/** The source lists of `frame-ancestors`, of each policy a response carries. */
function frameAncestorsOf(headers: [string, string][]): string[][] {
  const lists: string[][] = [];
  const text = headerList(headers, 'content-security-policy');
  for (const policy of (text ?? '').split(',')) {
    const list = parseCsp(policy).get('frame-ancestors');
    if (list) lists.push(list);
  }
  return lists;
}

/** What `get, decode and split` strips (Fetch 2.2.2): a tab or a space, and
 *  not the rest of what `trim` would. */
const unspaced = (value: string): string =>
  value.replace(/^[\t ]+|[\t ]+$/g, '');

/** The values of a header split as `get, decode and split` has them: at
 *  commas outside quotes, each stripped. */
function splitValues(value: string): string[] {
  const out: string[] = [];
  let at = '';
  let quoted = false;
  for (const c of value) {
    if (c === '"') quoted = !quoted;
    if (c === ',' && !quoted) {
      out.push(unspaced(at));
      at = '';
    } else at += c;
  }
  out.push(unspaced(at));
  return out;
}

/**
 * Whether a response refuses the frame it came to, and which of the two says
 * so. `url` is where it landed, `origin` the origin it would have, and
 * `ancestors` the origin of each document around the frame, nearest first,
 * `null` for one that has none.
 */
export function framingRefused(
  headers: [string, string][],
  url: string,
  origin: string,
  ancestors: readonly string[],
): 'frame-ancestors' | 'x-frame-options' | null {
  // a document of no address has no policy of its own to read (CSP 3, 6.4.2)
  if (!/^https?:/i.test(url)) return null;
  const lists = frameAncestorsOf(headers);
  if (lists.length) {
    for (const list of lists) {
      for (const ancestor of ancestors) {
        if (ancestor === 'null' || !matchesSourceList(list, ancestor, url)) {
          return 'frame-ancestors';
        }
      }
    }
    // `frame-ancestors` is the newer word, and `X-Frame-Options` steps aside
    return null;
  }
  const raw = headerList(headers, 'x-frame-options');
  if (raw === null) return null;
  const values = new Set(splitValues(raw).map((v) => v.toLowerCase()));
  if (values.size > 1) {
    return values.has('deny') ||
      values.has('allowall') ||
      values.has('sameorigin')
      ? 'x-frame-options'
      : null;
  }
  if (values.has('deny')) return 'x-frame-options';
  if (values.has('sameorigin')) {
    return origin !== 'null' && ancestors.every((a) => a === origin)
      ? null
      : 'x-frame-options';
  }
  return null;
}
