// What leaves a document as a file: the seam `<Html>` asks when a page wants
// one saved, and the names one goes by.
//
// **Nothing is saved by construction.** An `<a download>`, a link to a `blob:`
// a page made, is handed to `onDownload`, and with none it is a link like any
// other. A component that shows a page writes nothing to a disk for it. A host
// that does decides where, and asks `HtmlNetwork.download` for the bytes, which
// reach it as they arrive, so a large file is not held in memory, and a host
// with a network of its own asks that.
//
// A navigation can come to the same thing: a response that says
// `Content-Disposition: attachment`, or is of a type no document can show. What
// `HtmlNetwork.document` answers says so (`disposition`), the host decides, and
// `download` on the response has the body with no limit on it, where the body
// of a document has one.

declare const URL: new (url: string) => { protocol: string; pathname: string };

/** What a page asked to have saved. */
export interface HtmlDownloadRequest {
  /** Where it is: resolved, and `blob:` or `data:` where a page made it. */
  url: string;
  /** What the `download` attribute said it should be called, '' for
   *  nothing. A name a response gives wins over the attribute's only where
   *  the attribute says nothing. */
  filename: string;
  /** Its bytes, where the page has them: a `blob:`'s, which no network can
   *  reach. */
  bytes?: Uint8Array;
  /** Their type. */
  type?: string;
}

/** `onDownload`: a page asked for something to be saved. */
export type HtmlDownloadHandler = (request: HtmlDownloadRequest) => void;

/** What a download reads from. */
export interface HtmlDownloadSource {
  url: string;
  /** What it should be called: safe to join to a directory. */
  filename: string;
  type: string;
  /** Its length, where the server said. */
  size: number | null;
  body: AsyncIterable<Uint8Array>;
}

/** What a `Content-Disposition` header says (RFC 6266). */
export interface Disposition {
  attachment: boolean;
  /** The name it gives, decoded; `filename*` wins over `filename`. */
  filename: string | null;
}

/** A `filename*`'s value: `charset'lang'percent-encoded` (RFC 8187). */
function extendedValue(value: string): string | null {
  const m = /^(utf-8|iso-8859-1)'[^']*'(.*)$/i.exec(value);
  if (!m) return null;
  try {
    if (m[1].toLowerCase() === 'utf-8') return decodeURIComponent(m[2]);
    return m[2].replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  } catch {
    return null;
  }
}

/** A header's parameters, quoted strings unquoted. */
function parameters(header: string): Map<string, string> {
  const out = new Map<string, string>();
  const pattern = /;\s*([^\s=;]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  for (const m of header.matchAll(pattern)) {
    const name = m[1].toLowerCase();
    if (out.has(name)) continue;
    const value = m[2].trim();
    out.set(
      name,
      value.startsWith('"')
        ? value.slice(1, -1).replace(/\\(.)/g, '$1')
        : value,
    );
  }
  return out;
}

/** Read a `Content-Disposition` header. An unknown type is an attachment,
 *  as RFC 6266 has it, and no header is none. */
export function dispositionOf(header: string | null | undefined): Disposition {
  if (!header) return { attachment: false, filename: null };
  const kind = /^\s*([^\s;]+)/.exec(header)?.[1]?.toLowerCase() ?? 'inline';
  const params = parameters(header);
  const extended = params.get('filename*');
  return {
    attachment: kind !== 'inline',
    filename:
      (extended && extendedValue(extended)) ?? params.get('filename') ?? null,
  };
}

/** Names a machine keeps for itself, on the one that has any. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * A name a server or a page gave, as one a host can join to a directory: no
 * path, no control characters, nothing that hides it or runs off the end of
 * the name a filesystem takes. Empty where nothing of it is left.
 */
export function safeFilename(name: string): string {
  const leaf = name.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let clean = leaf.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').trim();
  clean = clean.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (RESERVED.test(clean)) clean = `_${clean}`;
  // keep the extension of a name past what a filesystem holds
  if (clean.length > 200) {
    const dot = clean.lastIndexOf('.');
    const extension =
      dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : '';
    clean = clean.slice(0, 200 - extension.length) + extension;
  }
  return clean;
}

/** The extensions a download without a name of its own takes from its type. */
const EXTENSIONS: Record<string, string> = {
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/plain': 'txt',
};

/** The last part of a URL's path, decoded, or '' for none. */
function lastSegment(url: string): string {
  try {
    const { protocol, pathname } = new URL(url);
    if (protocol === 'blob:' || protocol === 'data:') return '';
    return decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1));
  } catch {
    return '';
  }
}

/**
 * What a download should be called, in the order the browsers ask: the
 * response's name, the `download` attribute, the end of the URL, and failing
 * those `download` with the extension its type has. A server's name beats the
 * attribute in all three, and WebKit alone sets it aside where the disposition
 * is `inline`.
 */
export function downloadName(
  url: string,
  suggested: string,
  disposition: string | null | undefined,
  type: string,
): string {
  const named =
    safeFilename(dispositionOf(disposition).filename ?? '') ||
    safeFilename(suggested) ||
    safeFilename(lastSegment(url));
  if (named) return named;
  const extension = EXTENSIONS[type.split(';')[0].trim().toLowerCase()];
  return extension ? `download.${extension}` : 'download';
}
