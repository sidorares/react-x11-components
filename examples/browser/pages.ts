// The pages the browser makes itself: the new-tab page, the ones that say a
// page could not be shown, and the wrappers that turn a response that is not
// HTML — plain text, an image, a page's own source — into a document `<Html>`
// can render. Every one is HTML handed to the same component as a page from
// the web, so it is styled with CSS like one, including the dark scheme,
// which `<Html>` answers from the palette in force.
import { escapeHtml } from './network.js';

export const HOME = 'about:home';
export const BLANK = 'about:blank';

/** The sites the start page offers — ones that read well with no script
 *  running, which is most of what this browser is. */
const SITES: { name: string; url: string; note: string }[] = [
  {
    name: 'Hacker News',
    url: 'https://news.ycombinator.com/',
    note: 'tables, a GIF spacer, an SVG logo',
  },
  {
    name: 'Wikipedia',
    url: 'https://en.wikipedia.org/wiki/X_Window_System',
    note: 'a long article, floats, infoboxes',
  },
  {
    name: 'DuckDuckGo Lite',
    url: 'https://lite.duckduckgo.com/lite/',
    note: 'search, with no script at all',
  },
  {
    name: 'CSS Zen Garden',
    url: 'https://www.csszengarden.com/',
    note: 'one document, all CSS',
  },
  {
    name: 'NPR text',
    url: 'https://text.npr.org/',
    note: 'news, text only',
  },
  {
    name: 'CNN Lite',
    url: 'https://lite.cnn.com/',
    note: 'news, lightweight',
  },
  {
    name: 'Components docs',
    url: 'https://sidorares.github.io/react-x11-components/',
    note: 'the documentation for this',
  },
  {
    name: 'Example Domain',
    url: 'https://example.com/',
    note: 'the smallest page there is',
  },
];

const PAGE_STYLE = `
  body { margin: 0; font: 15px/1.5 sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 56px 32px; }
  h1 { font-size: 30px; font-weight: 600; margin: 0 0 6px; }
  .lead { color: #5f6b76; margin: 0 0 32px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 12px; }
  .grid a { display: block; padding: 12px 14px; border-radius: 10px;
            border: 1px solid #d8dde3; background: #f7f9fb;
            text-decoration: none; color: inherit; }
  .grid a:hover { border-color: #4a90d9; }
  .grid b { display: block; color: #2f6fb3; }
  .grid span { font-size: 13px; color: #6b7682; }
  kbd { font: 12px monospace; padding: 1px 5px; border: 1px solid #c9d0d7;
        border-radius: 4px; background: #f3f5f7; }
  footer { margin-top: 40px; font-size: 13px; color: #6b7682; }
  @media (prefers-color-scheme: dark) {
    .lead, .grid span, footer { color: #9aa5b1; }
    .grid a { border-color: #3a434d; background: #22282f; }
    .grid a:hover { border-color: #5aa4e6; }
    .grid b { color: #7db7ee; }
    kbd { border-color: #4a535d; background: #2a3038; }
  }
`;

/** The new-tab page. `cocoa` spells the shortcuts as macOS does — ⌘T —
 *  rather than as X11 desktops do, Ctrl+T. */
export function homePage(cocoa: boolean): string {
  const key = (k: string) => `<kbd>${cocoa ? `⌘${k}` : `Ctrl+${k}`}</kbd>`;
  const cards = SITES.map(
    (s) =>
      `<a href="${escapeHtml(s.url)}"><b>${escapeHtml(s.name)}</b>` +
      `<span>${escapeHtml(s.note)}</span></a>`,
  ).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8">
<title>New Tab</title><style>${PAGE_STYLE}</style></head><body><main>
<h1>A browser in react-x11</h1>
<p class="lead">Every page here is drawn by <code>&lt;Html&gt;</code> and
fetched by the example that hosts it: the document, its stylesheets, its
images and its fonts. Nothing on a page runs — there is no script engine.</p>
<div class="grid">
${cards}
</div>
<footer>
<p>Type an address or a search into the bar above.
${key('T')} opens a tab, ${key('W')} closes one, ${key('L')} goes to the
address bar, ${key('R')} reloads, and ${key(cocoa ? '+' : 'Plus')} and
${key(cocoa ? '−' : 'Minus')} zoom.</p>
<p>A middle click, or a click with <kbd>${cocoa ? '⌘' : 'Ctrl'}</kbd> held,
opens a link in a tab behind this one.</p>
</footer>
</main></body></html>`;
}

export function blankPage(): string {
  return '<!doctype html><html><head><title>about:blank</title></head><body></body></html>';
}

/** Why there is no page: no such host, a refused connection, a scheme this
 *  does not open. */
export function errorPage(url: string, message: string, code: string): string {
  let host = url;
  try {
    host = new URL(url).host || url;
  } catch {
    // an address that does not parse is shown as it was typed
  }
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(host)}</title><style>${PAGE_STYLE}
  main { padding-top: 96px; }
  h1 { font-size: 24px; }
  code { font-size: 12px; color: #8a96a3; }
</style></head><body><main>
<h1>This page could not be shown</h1>
<p>${escapeHtml(message)}</p>
<p class="lead"><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>
<p><code>${escapeHtml(code)}</code></p>
</main></body></html>`;
}

/** A response of a kind this browser does not render. */
export function unsupportedPage(url: string, type: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(fileName(url))}</title><style>${PAGE_STYLE}
  main { padding-top: 96px; }
</style></head><body><main>
<h1>Nothing to show</h1>
<p>This is <code>${escapeHtml(type || 'something with no type')}</code>, which
this browser does not display, and it does not download files.</p>
<p class="lead">${escapeHtml(url)}</p>
</main></body></html>`;
}

/** Plain text, as a browser shows it: preformatted, in the document's own
 *  lines. */
export function textPage(url: string, text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(fileName(url))}</title>
<style>body { margin: 8px; } pre { white-space: pre-wrap;
font: 13px/1.45 monospace; margin: 0; }</style></head>
<body><pre>${escapeHtml(text)}</pre></body></html>`;
}

/** An image on its own, centred on a dark ground as browsers show one. */
export function imagePage(url: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(fileName(url))}</title>
<style>html { background: #0e1012; height: 100%; }
body { margin: 0; min-height: 100%; display: flex; align-items: center;
justify-content: center; }
img { max-width: 100%; }</style></head>
<body><img src="${escapeHtml(url)}" alt=""></body></html>`;
}

/** The last path segment of a URL, which is what a tab with no `<title>`
 *  is named. */
export function fileName(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : parsed.host || url;
  } catch {
    return url;
  }
}
