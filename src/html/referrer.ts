/**
 * Referrer Policy: what a request's `Referer` says of where it was made, and
 * how much. Pure, as `fetch-metadata.ts` is, and asked by `network.ts` for
 * what it sends and by the host for each hop of a page's request, whose
 * redirects it follows itself.
 */
import { trustworthy } from './fetch-metadata.js';
import type { UrlClass, UrlLike } from './scripts/platform.js';

declare const URL: UrlClass;

/** A referrer policy (Referrer Policy, 3), '' for none said, which is the
 *  default's, `strict-origin-when-cross-origin`. */
export type ReferrerPolicy =
  | ''
  | 'no-referrer'
  | 'no-referrer-when-downgrade'
  | 'same-origin'
  | 'origin'
  | 'strict-origin'
  | 'origin-when-cross-origin'
  | 'strict-origin-when-cross-origin'
  | 'unsafe-url';

const POLICIES = new Set<string>([
  'no-referrer',
  'no-referrer-when-downgrade',
  'same-origin',
  'origin',
  'strict-origin',
  'origin-when-cross-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
]);

/** A policy's name as a request's `referrerPolicy` or an element's
 *  attribute has it: '' for what is none. */
export function referrerPolicyOf(
  value: string | null | undefined,
): ReferrerPolicy {
  const name = (value ?? '').trim().toLowerCase();
  return POLICIES.has(name) ? (name as ReferrerPolicy) : '';
}

/**
 * The policy a `Referrer-Policy` header says (Referrer Policy, 8.1, "parse
 * a referrer policy from a `Referrer-Policy` header"): the last of its
 * tokens that names one, over every field of that name, so a policy a
 * browser does not know yet can be followed by one it does.
 */
export function referrerPolicyOfHeaders(
  headers: Iterable<readonly [string, string]>,
): ReferrerPolicy {
  let policy: ReferrerPolicy = '';
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== 'referrer-policy') continue;
    for (const token of value.split(',')) {
      const known = referrerPolicyOf(token);
      if (known) policy = known;
    }
  }
  return policy;
}

/** What a `<meta name="referrer">` says (HTML 4.2.5.3, the `referrer`
 *  name): a policy, or one of the four words the policies had before. */
export function referrerPolicyOfMeta(content: string): ReferrerPolicy {
  const value = content.trim().toLowerCase();
  const legacy: Record<string, ReferrerPolicy> = {
    never: 'no-referrer',
    default: 'strict-origin-when-cross-origin',
    always: 'unsafe-url',
    'origin-when-crossorigin': 'origin-when-cross-origin',
  };
  return legacy[value] ?? referrerPolicyOf(value);
}

/** A URL as a referrer may carry it (Referrer Policy, 8.4, "strip url for
 *  use as a referrer"): no user, no password, no fragment, and only a URL of
 *  the web's. Null for any other. */
function stripped(url: string, originOnly: boolean): string | null {
  let at: UrlLike;
  try {
    at = new URL(url);
  } catch {
    return null;
  }
  if (at.protocol !== 'http:' && at.protocol !== 'https:') return null;
  if (originOnly) return `${at.origin}/`;
  at.username = '';
  at.password = '';
  at.hash = '';
  return at.href;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * What a request to `target` from `referrer` says in its `Referer`, under
 * `policy` (Referrer Policy, 8.3, "determine request's referrer"), or null
 * for nothing. `referrer` is the URL a request has for its referrer: its
 * client's, one it was given, or what the hop before it came to, which is
 * what keeps a referrer an origin once a hop to another made it one.
 */
export function determineReferrer(
  referrer: string,
  target: string,
  policy: ReferrerPolicy,
): string | null {
  let url = stripped(referrer, false);
  const origin = stripped(referrer, true);
  if (url === null || origin === null) return null;
  // a URL this long goes as its origin (8.3, step 7)
  if (url.length > 4096) url = origin;
  const same = originOf(referrer) === originOf(target);
  const downgrade = trustworthy(url) && !trustworthy(target);
  switch (policy) {
    case 'no-referrer':
      return null;
    case 'origin':
      return origin;
    case 'unsafe-url':
      return url;
    case 'strict-origin':
      return downgrade ? null : origin;
    case 'same-origin':
      return same ? url : null;
    case 'origin-when-cross-origin':
      return same ? url : origin;
    case 'no-referrer-when-downgrade':
      return downgrade ? null : url;
    default:
      // `strict-origin-when-cross-origin`, and what says nothing
      if (same) return url;
      return downgrade ? null : origin;
  }
}

/** The slice of a parsed element this reads, written out so this module
 *  stays one with no DOM. */
interface TreeNode {
  type?: string;
  name?: string;
  attribs?: Record<string, string>;
  parent?: TreeNode | null;
  children?: TreeNode[];
}

/** What a link's navigation is made under (HTML 7.4.2.2, "follow the
 *  hyperlink"): `no-referrer` where its `rel` says `noreferrer`, else its
 *  `referrerpolicy`. '' for none. */
export function linkReferrerPolicy(
  link: TreeNode | null | undefined,
): ReferrerPolicy {
  if (!link?.attribs) return '';
  if (/(^|\s)noreferrer(\s|$)/i.test(link.attribs.rel ?? '')) {
    return 'no-referrer';
  }
  return referrerPolicyOf(link.attribs.referrerpolicy);
}

/**
 * The referrer policy of the document `node` is in, where no script keeps
 * one for it (HTML, a policy container's): the last `<meta
 * name="referrer">` in its head that says one, else what its response said
 * in `Referrer-Policy`.
 */
export function documentReferrerPolicy(
  node: TreeNode | null | undefined,
  headers?: Iterable<readonly [string, string]>,
): ReferrerPolicy {
  let top = node;
  while (top?.parent) top = top.parent;
  const named = (from: TreeNode | undefined, name: string) =>
    from?.children?.find(
      (child) => child.type === 'tag' && child.name === name,
    );
  const head = named(
    named(top?.type === 'root' ? top : undefined, 'html'),
    'head',
  );
  let policy: ReferrerPolicy = '';
  for (const child of head?.children ?? []) {
    if (
      child.type === 'tag' &&
      child.name === 'meta' &&
      (child.attribs?.name ?? '').trim().toLowerCase() === 'referrer'
    ) {
      policy = referrerPolicyOfMeta(child.attribs?.content ?? '') || policy;
    }
  }
  return policy || (headers ? referrerPolicyOfHeaders(headers) : '');
}
