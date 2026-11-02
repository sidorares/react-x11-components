// What a page may have of a script (HTML 8.1.4, Fetch 4.1): whether it runs,
// and whether what it throws is the page's to read. A classic script of
// another origin runs, which is the web's oldest promise, and its errors are
// muted, because they are the one thing that says what is in it: a page that
// points a `<script>` at another site's CSV hears `alice_token is not
// defined`, with that site's cookies having asked for it. A module's exports
// are the page's to read, so another origin's has to let it by CORS.
//
// Pure, and held to the origin the host says the document is of.
import { corsAllows, headerOf, originOf } from './fetch-hops.js';

/** A script's source as a host hands it over (`HtmlScripts.load`), with what
 *  it knows of where it came from (`ScriptOrigin`). */
export type LoadedScript =
  string | { text: string; url?: string; headers?: [string, string][] };

/** What a CORS settings attribute says (HTML 2.5.4): null for none. */
export function corsSetting(
  raw: string | undefined,
): 'anonymous' | 'use-credentials' | null {
  if (raw === undefined) return null;
  return raw.toLowerCase() === 'use-credentials'
    ? 'use-credentials'
    : 'anonymous';
}

const JAVASCRIPT =
  /^(?:application\/(?:x-)?(?:java|ecma)script|text\/(?:x-)?(?:java|ecma)script|text\/javascript1\.[0-5]|text\/jscript|text\/livescript)$/;

/** Whether a response may not be a script, by what it says it is (Fetch
 *  4.?, "should response to request be blocked due to its MIME type", and
 *  `nosniff`): a CSV or an image is never one, and a module has to say it is
 *  one. A response whose head is not known says nothing. */
function blockedByType(
  headers: [string, string][] | undefined,
  module: boolean,
): boolean {
  if (!headers) return false;
  const type = (headerOf(headers, 'content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (JAVASCRIPT.test(type)) return false;
  if (module) return true;
  if (/^(?:audio|image|video)\/|^text\/csv$/.test(type)) return true;
  const sniff = headerOf(headers, 'x-content-type-options') ?? '';
  return sniff.split(',')[0].trim().toLowerCase() === 'nosniff';
}

/**
 * What a document of `origin` may have of a script it asked for at `asked`:
 * null where it may not run, and otherwise its text and whether its errors
 * are muted. `cors` is how it was asked for by CORS, a module's always. A host
 * that does not say what headers it had says nothing of CORS, so a classic
 * script runs muted, and a module of another origin not at all.
 */
export function judgeScript(
  loaded: LoadedScript | null,
  asked: string,
  origin: string,
  cors: 'anonymous' | 'use-credentials' | null,
  module: boolean,
): { text: string; muted: boolean } | null {
  if (loaded === null) return null;
  const { text, url, headers } =
    typeof loaded === 'string'
      ? { text: loaded, url: undefined, headers: undefined }
      : loaded;
  if (blockedByType(headers, module)) return null;
  const final = url ?? asked;
  // what no network answered is the document's own: a `data:` URL, a blob
  const own = /^(?:data|blob|about):/i.test(final)
    ? true
    : origin !== 'null' && originOf(final) === origin;
  if (own) return { text, muted: false };
  if (!cors) return { text, muted: true };
  if (!headers) return module ? null : { text, muted: true };
  return corsAllows(
    headers,
    cors === 'use-credentials' ? 'include' : 'same-origin',
    origin,
  )
    ? { text, muted: false }
    : null;
}
