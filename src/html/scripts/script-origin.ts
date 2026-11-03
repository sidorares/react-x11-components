// What a page may have of a script (HTML 8.1.4, Fetch 4.1): whether it runs,
// and whether what it throws is the page's to read. A classic script of
// another origin runs, which is the web's oldest promise, and its errors are
// muted, because they are the one thing that says what is in it: a page that
// points a `<script>` at another site's CSV hears `alice_token is not
// defined`, with that site's cookies having asked for it. A module's exports
// are the page's to read, so another origin's has to let it by CORS.
//
// Pure, and held to the origin the host says the document is of.
import {
  corsAllows,
  headerOf,
  originOf,
  redirectTainted,
} from './fetch-hops.js';

/** What a host says of where a resource came from (`ScriptOrigin`). */
interface CameFrom {
  url?: string;
  headers?: [string, string][];
  redirects?: string[];
}

/** A script's source as a host hands it over (`HtmlScripts.load`), with what
 *  it knows of where it came from (`ScriptOrigin`). */
export type LoadedScript = string | ({ text: string } & CameFrom);

/** The addresses a resource came by, the one asked for first: what a host
 *  says of the way, or where it says only where it landed, that. */
function wayOf(asked: string, came: CameFrom): string[] {
  const final = came.url ?? asked;
  if (came.redirects?.length) return [...came.redirects, final];
  return final === asked ? [asked] : [asked, final];
}

/** Whether every address a resource came by is the document's own: a
 *  `data:` URL and a blob are, which no network answered, and an opaque
 *  origin is no address's. */
function cameOwn(way: string[], origin: string): boolean {
  const final = way[way.length - 1];
  if (/^(?:data|blob|about):/i.test(final)) return true;
  return origin !== 'null' && way.every((url) => originOf(url) === origin);
}

/**
 * Whether a document of `origin` may use a font it asked for by CORS (CSS
 * Fonts 4, 4.8.2: `cors` mode, `same-origin` credentials) — a font of another
 * origin's, which the page could otherwise draw text in and measure. Held to
 * where it landed and the way it came there, as a script is; a host that says
 * nothing of its headers says nothing of CORS, and it is let through.
 */
export function fontAllowed(
  came: CameFrom,
  asked: string,
  origin: string,
): boolean {
  if (!came.headers) return true;
  const way = wayOf(asked, came);
  if (cameOwn(way, origin)) return true;
  const named = redirectTainted(way, origin) ? 'null' : origin;
  return corsAllows(came.headers, 'same-origin', named);
}

/** What a CORS settings attribute says (HTML 2.5.4): null for none. */
export function corsSetting(
  raw: string | undefined,
): 'anonymous' | 'use-credentials' | null {
  if (raw === undefined) return null;
  return raw.toLowerCase() === 'use-credentials'
    ? 'use-credentials'
    : 'anonymous';
}

/** What a module is (HTML's module type of a module script): a
 *  script, or what an import's `type` attribute names, a JSON document or
 *  text (the Import Text proposal), whose value is its default export. */
export type ModuleType = 'javascript' | 'json' | 'text';

/** What a JSON and a text module are asked for with (HTML's "fetch a
 *  single module script"; the Import Text proposal): `Accept`. */
export const MODULE_ACCEPT = {
  json: 'application/json,*/*;q=0.5',
  text: 'text/plain,*/*;q=0.5',
} as const;

const JAVASCRIPT =
  /^(?:application\/(?:x-)?(?:java|ecma)script|text\/(?:x-)?(?:java|ecma)script|text\/javascript1\.[0-5]|text\/jscript|text\/livescript)$/;

/** A JSON MIME type's essence (MIME Sniffing 4.6): `application/json`,
 *  `text/json`, or any type and subtype of HTTP token code points whose
 *  subtype ends in `+json`. */
const JSON_TYPE =
  /^(?:application\/json|text\/json|[!#$%&'*+\-.^_`|~0-9a-z]+\/[!#$%&'*+\-.^_`|~0-9a-z]*\+json)$/;

/** A `Content-Type`'s essence: its type and subtype, lower-cased. */
function essenceOf(contentType: string): string {
  return contentType
    .split(';')[0]
    .replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '')
    .toLowerCase();
}

/** Whether a response is what a JSON or a text module is imported as, by its
 *  `Content-Type`: a JSON module's has to be JSON, and a text module's may
 *  be anything at all. */
export function moduleTypeAllows(
  contentType: string,
  type: 'json' | 'text',
): boolean {
  return type === 'text' || JSON_TYPE.test(essenceOf(contentType));
}

/** Whether a response may not be a script, by what it says it is (Fetch
 *  4.?, "should response to request be blocked due to its MIME type", and
 *  `nosniff`): a CSV or an image is never one, and a module has to say it is
 *  one, or what it was imported as (`moduleTypeAllows`). A response whose
 *  head is not known says nothing. */
function blockedByType(
  headers: [string, string][] | undefined,
  module: boolean,
  type: ModuleType,
): boolean {
  if (!headers) return false;
  const contentType = headerOf(headers, 'content-type') ?? '';
  if (type !== 'javascript') return !moduleTypeAllows(contentType, type);
  const essence = essenceOf(contentType);
  if (JAVASCRIPT.test(essence)) return false;
  if (module) return true;
  if (/^(?:audio|image|video)\/|^text\/csv$/.test(essence)) return true;
  const sniff = headerOf(headers, 'x-content-type-options') ?? '';
  return sniff.split(',')[0].trim().toLowerCase() === 'nosniff';
}

/**
 * What a document of `origin` may have of a script it asked for at `asked`:
 * null where it may not run, and otherwise its text and whether its errors
 * are muted. `cors` is how it was asked for by CORS, a module's always, and
 * `type` what a module was imported as. A host that does not say what
 * headers it had says nothing of CORS, so a classic script runs muted, and a
 * module of another origin not at all.
 */
export function judgeScript(
  loaded: LoadedScript | null,
  asked: string,
  origin: string,
  cors: 'anonymous' | 'use-credentials' | null,
  module: boolean,
  type: ModuleType = 'javascript',
): { text: string; muted: boolean } | null {
  if (loaded === null) return null;
  const came: { text: string } & CameFrom =
    typeof loaded === 'string' ? { text: loaded } : loaded;
  const { text, headers } = came;
  if (blockedByType(headers, module, type)) return null;
  // what no network answered is the document's own, and what came by
  // another origin's address is no longer, wherever it landed
  const way = wayOf(asked, came);
  if (cameOwn(way, origin)) return { text, muted: false };
  if (!cors) return { text, muted: true };
  if (!headers) return module ? null : { text, muted: true };
  // asked for in nobody's name, where the way left the origin through
  // another (Fetch 3.1.5, "redirect-tainted origin")
  return corsAllows(
    headers,
    cors === 'use-credentials' ? 'include' : 'same-origin',
    redirectTainted(way, origin) ? 'null' : origin,
  )
    ? { text, muted: false }
    : null;
}
