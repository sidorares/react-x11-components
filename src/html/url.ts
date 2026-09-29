// URLs, resolved against a base — when there is one.
//
// A document has no base of its own: `<Html>` is handed a string, not a
// response. The host knows where the string came from, and says so with the
// `baseUrl` prop; a `<base href>` in the document moves it, as HTML's does.
// Without either every URL goes to `onResource` and `onLink` exactly as the
// document wrote it, which is what a host rendering mail or a help page wants
// and what this component did before it had a base to resolve against.
//
// A stylesheet is the other base. `url(../img/a.png)` in `/css/site.css`
// names `/img/a.png` whichever page linked the sheet, and nothing downstream
// of the parse knows which sheet a computed value came from — so a sheet
// whose own URL is known has its `url()`s made absolute as it is parsed
// (`absoluteUrls` in css/parse.ts), and everything after sees an absolute URL
// that resolving again leaves as it is.
//
// The resolving is WHATWG's, through the runtime's own `URL`: Node, Bun and
// every browser have one. `types: []` keeps node's declarations out of the
// build, so it is reached structurally, as `TextDecoder` is in svg.ts.

interface UrlLike {
  readonly href: string;
}

type UrlConstructor = new (url: string, base?: string) => UrlLike;

/**
 * `url` against `base`, or `url` untouched where there is no base, the
 * runtime has no `URL`, or the pair makes no URL. A `data:` URL is returned
 * as it is rather than put through the parser: it can be a font or an image
 * hundreds of kilobytes long, and it is absolute already.
 */
export function resolveUrl(
  url: string,
  base: string | null | undefined,
): string {
  if (!base) return url;
  // read when asked rather than at import: nothing here runs on load
  const URLClass = (globalThis as { URL?: UrlConstructor }).URL;
  if (!URLClass) return url;
  // HTML strips an attribute's URL of the ASCII white space around it
  const trimmed = url.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  if (/^data:/i.test(trimmed)) return trimmed;
  try {
    return new URLClass(trimmed, base).href;
  } catch {
    return url;
  }
}

/**
 * Resolutions against one base, remembered. The paint asks for every image
 * it draws by the URL the markup wrote, on every frame, and a WHATWG parse
 * per image per frame is work for nothing: the answer changes only when the
 * base does, and then the whole memo goes.
 */
export class UrlResolver {
  private _base: string | null = null;
  private _memo = new Map<string, string>();

  get base(): string | null {
    return this._base;
  }

  /** Set the base. True when it changed — everything resolved before is
   *  stale then, and so is anything keyed by what it resolved to. */
  setBase(base: string | null): boolean {
    if (base === this._base) return false;
    this._base = base;
    this._memo.clear();
    return true;
  }

  resolve(url: string): string {
    if (this._base === null) return url;
    let out = this._memo.get(url);
    if (out === undefined) {
      out = resolveUrl(url, this._base);
      // a document names a bounded number of URLs; a stream of generated
      // ones (a cache-busting query per frame) must not grow this forever
      if (this._memo.size > 4096) this._memo.clear();
      this._memo.set(url, out);
    }
    return out;
  }
}
