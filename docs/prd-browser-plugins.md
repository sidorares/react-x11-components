# Plugins for the example browser

Two questions about `examples/browser/`. First, could it run Chrome
extensions unchanged? Second, since the answer is mostly no, what plugin
system would give its users five things instead:

- blocking at the network;
- blocking in the document;
- automation and productivity tools;
- MCP;
- base styles of their own.

Status: investigation, 2026-10-26. Nothing is built. The code it cites is
as of `46778e99`.

## The answer, short

- **Chrome extensions, unchanged: not as a general capability.** An
  extension expects its browser to be its platform four times over: an
  engine for its HTML pages, a service worker for its logic, isolated
  worlds for its content scripts, and a slice of some seventy `chrome.*`
  namespaces. It also expects its browser to isolate it in a process of
  its own and enforce its permissions, and nothing here can.
  - Electron has Chromium underneath and runs only a subset, meant for
    DevTools extensions.
  - Orion, on WebKit, reports about 70% of the APIs after years of work.
  - Three things are in reach:
    - an MV3 extension's `declarativeNetRequest` rulesets, read as data;
    - blocking `webRequest`, which Chrome removed and our network makes
      free;
    - small content-script extensions, once isolated worlds exist.
- **Unchanged formats instead.** Filter lists, DNR rulesets, userscripts
  and user styles are the parts of the ecosystem that are data or
  page-level script. Each has a large library already written, and
  supporting them is weeks of work rather than years.
- **Plugins are trusted Node modules, in two halves.**
  - A browser half runs once, in the browser's process: the toolbar,
    commands, storage, tabs and the MCP endpoint.
  - A page half runs in each tab's pane, where the requests and the
    documents are.
  - This is Chrome's background/content split. The same process model
    forces it on us; it is not copied.
- **`<Html>` grows six seams and no plugin concept.** Each is one any host
  could use:
  - a request intercept;
  - a user origin;
  - host marks;
  - a change feed;
  - injected scripts;
  - isolated worlds.
- **Four phases**, network blocking first, isolated worlds last.

## Chrome extensions, unchanged

### What an extension expects of its browser

- **Its pages.** The toolbar popup, the options page and the side panel
  are HTML documents under `chrome-extension://<id>/`. They are usually a
  React, Vue or Svelte app.
- **Its background.** In Manifest V3 this is a service worker. It is
  event-driven and woken by `chrome.*` events. It may `fetch` across
  origins where its `host_permissions` allow. There is one per extension,
  however many tabs are open.
- **Its content scripts.** Scripts and CSS are injected into matching
  frames at `document_start`, `document_end` or `document_idle`. Each runs
  in an _isolated world_: the page's nodes, but JavaScript objects of its
  own, so neither side sees the other's globals or prototypes.
- **Its APIs.** `chrome.runtime`, `tabs`, `storage`, `scripting`,
  `declarativeNetRequest`, `action`, `contextMenus`, `commands`, `alarms`,
  `i18n`, `offscreen`, `sidePanel`, `notifications` and some fifty more.
  Every extension uses a different dozen of them.
- **Its isolation.** Chrome runs extension code in processes of its own,
  and enforces the permissions the manifest asked for.

Chrome no longer runs Manifest V2 extensions. Firefox still does,
blocking `webRequest` included, and that matters below.

### Layer by layer

| Layer           | What we have                                                                                                                                                          | What is missing                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package         | Nothing.                                                                                                                                                              | Small. CRX3 is a signed header over a zip. Then the manifest and `_locales`, and `chrome-extension://<id>/` as one more scheme `onResource` and `scripts.fetch` answer from the unpacked directory.                                                                                                                                                                      |
| Network rules   | `HtmlNetwork` sees every request a tab makes, in the tab's pane (`page.tsx`).                                                                                         | Small to medium. No request knows its destination: `FetchRequest` (`scripts/host.ts`) has none, so an XHR, a frame's document and a worker's script look alike. The cache is keyed by URL alone, so a verdict has to come before it.                                                                                                                                     |
| Background      | Worker threads, each with an engine and the facade made a worker's global (`scripts/workers.ts`). A service worker's lifecycle (`WorkerInit.service`).                | Medium. A `chrome` binding over the bridge, cross-origin `fetch` by permission, and a home outside any tab: the browser's process, or a pane of its own.                                                                                                                                                                                                                 |
| Content scripts | `DomShared` (`scripts/host.ts`) lets several realms share one tree of nodes, which is how frames work.                                                                | Large. A document's events enter the one realm that runs it (`DomHost.dispatch`), so a second realm on the same document hears neither the user's clicks nor the page's `dispatchEvent`. A realm's `MutationObserver` sees only what that realm changed, and a content script's must see the page's. And `document_start` needs a hook before the parser's first script. |
| Pages           | `<Html scripts>` can run a page in a `<popup>`.                                                                                                                       | Bound by the engine. There is no `crypto.subtle` (`scripts/dom.ts` says so), no `WebSocket`, no `BroadcastChannel` and no `execCommand`. An options page written in React tests the whole facade.                                                                                                                                                                        |
| Messaging       | `<Frame>` crosses props by structured clone and turns functions into fire-and-forget stubs (core's `docs/frame.md`).                                                  | Medium. `runtime.sendMessage` wants a reply and `connect` wants a port: a request–response protocol to build over two one-way streams.                                                                                                                                                                                                                                   |
| APIs            | None.                                                                                                                                                                 | Open-ended. One missing API breaks the extension that calls it.                                                                                                                                                                                                                                                                                                          |
| Isolation       | `node:vm` decides what a page can reach, and is no boundary against one that sets out to attack ([the threat model](prd-html-scripts.md)). A pane is a weak boundary. | The deal-breaker for arbitrary extensions. An extension's realm holds cross-origin `fetch` and every tab's DOM, and an escape from it in the browser's process is the whole browser.                                                                                                                                                                                     |

### Prior art

- **Electron** has Chromium underneath and still supports "a subset of the
  Chrome Extensions API, primarily to support DevTools extensions and
  Chromium-internal extensions". It loads unpacked directories only, never
  a CRX, and does not remember them across runs
  ([Electron's docs](https://www.electronjs.org/docs/latest/api/extensions)).
- **Orion**, Kagi's browser, is a custom WebKit with the WebExtension APIs
  ported by hand. Its help pages put coverage at about 70%, and say that an
  extension that fails is usually calling an API that is not there
  ([Orion's docs](https://help.kagi.com/orion/browser-extensions/macos-extensions.html)).
- **Firefox and Safari** are the other two implementations of
  WebExtensions, and each is a browser vendor's long-running project.

The lesson is in Orion's sentence. Coverage counted in APIs understates
how far off "unchanged" is, because an extension needs every API it
calls, not most of them.

### What is in reach

1. **DNR rulesets, read as data.** An MV3 blocker's network half is JSON:
   the `declarative_net_request.rule_resources` its manifest names.
   uBlock Origin Lite's lowest filtering mode, Basic, is DNR alone; its
   FAQ says cosmetic filtering and scriptlets need Optimal or Complete
   ([uBOL's FAQ](https://github.com/uBlockOrigin/uBOL-home/wiki/Frequently-asked-questions-%28FAQ%29)).
   Read unchanged, the rulesets of uBOL, AdGuard and Ghostery's MV3 builds
   block at the network with none of the extension's JavaScript run. It is
   nearly free once the network intercept's matcher takes DNR's rule format
   as its own (phase 4).
2. **Blocking `webRequest`.** Chrome's MV3 lets `webRequest` watch a request
   but not block it, except for extensions an enterprise policy installs.
   Firefox's still blocks, and the Firefox build of uBlock Origin is
   written against it. Every request here already awaits the network, so a
   listener that answers with a promise costs nothing. Full uBO also:
   - reads `browser.dns` to uncloak CNAMEs;
   - filters responses (`filterResponseData`);
   - ships a large dashboard.

   So it would be a port of one extension, not a general capability. It is
   the one extension most users would ask for.

3. **Small content-script extensions**, once isolated worlds exist (seam
   6): a site's look changed by CSS and a little script, with a trivial
   background or none.

### Distribution

A CRX3 is a protobuf header, a signature and a zip, so unpacking one is
small. Loading an unpacked directory comes first, as it does in Electron.
The Chrome Web Store serves CRX files to Chrome. Whether to fetch them for
another browser is a question for the store's terms, which this document
does not settle.

### Verdict

Do not promise unchanged extensions. Promise unchanged formats (the next
section). Build isolated worlds for userscripts: they are the piece any
later Chrome compatibility would stand on, so that work is not lost if the
question comes back.

## Unchanged formats instead

| Format                                                     | Where it comes from               | What it is                                      | What runs it here                                                   |
| ---------------------------------------------------------- | --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| Filter lists: EasyList, EasyPrivacy, uBO's, AdGuard's      | the lists' maintainers            | data, plus scriptlet names from a fixed library | `@ghostery/adblocker`, over seams 1–5                               |
| DNR rulesets                                               | an MV3 blocker's `rule_resources` | JSON                                            | the network intercept's matcher (seam 1)                            |
| Userscripts: a `// ==UserScript==` header and `GM.*` calls | Greasy Fork, OpenUserJS           | page-level JavaScript                           | the engine (seam 5); a granted script in an isolated world (seam 6) |
| User styles: UserCSS, as Stylus writes it                  | userstyles.world                  | CSS, with `@-moz-document` scoping it to sites  | the user origin (seam 2)                                            |

A filter list stays data even where it makes code run. A list's
`##+js(name, args)` names a scriptlet from the blocker's own library, and
a list cannot inject code of its own. uBO keeps its "trusted" scriptlets,
the ones that could, to lists it trusts.

## The plugin system

### Principles

1. **A plugin is trusted code, and says so.** It is a Node module the user
   installed, running with the process's privileges, as a VS Code or
   Obsidian plugin does. The engine is no sandbox
   ([the threat model](prd-html-scripts.md)) and a pane is a weak one, so a
   claim to sandbox plugins would be the most dangerous thing in the
   design. A manifest's `permissions` drive the consent screen and decide
   which APIs `activate` is handed. They do not isolate.
2. **What a plugin carries that is not trusted is data or page-level
   script**, in the formats above. A filter list is data. A userscript runs
   with the page's power, in the page's realm or an isolated world, and no
   more.
3. **Two halves, because the browser is two kinds of process.** Each tab's
   page runs in a `<Frame>` pane (`browser.tsx`), and every request and
   every node of its documents lives there:
   - the navigation (`network.document`);
   - the resources (`onResource`);
   - the page's own `fetch` (`scripts.fetch`);
   - even the favicon (`loadIcon` in `page.tsx`).

   The strip, the toolbar and anything shared across tabs live in the
   browser's process. So a plugin has a _browser half_ and a _page half_.
   Under `BROWSER_INLINE=1`, or on a backend with no panes, both halves
   share a process and the channel is a function call.

4. **The host composes `<Html>`'s seams, and `<Html>` learns nothing of
   plugins.** `onResource`, `scripts.fetch`, `stylesheet`, `onDomEvent` and
   the handle are already what a plugin hooks. The six new seams below are
   each useful to a host with no plugins at all. The plugin host starts in
   `examples/browser/plugins/` and moves into `src/` only once a second host
   wants it, the path `HtmlNetwork` took.
5. **Declarative first.** A pattern to block, a selector to hide, CSS for a
   site: these are rules the host evaluates in one place. That makes them
   fast, reorderable, explainable in a "why was this blocked" panel, and
   safe to take from a list. Callbacks cover the rest.

### What a plugin is

A package whose `package.json` says which halves it has and what it needs.
The field's name is to be settled:

```json
{
  "name": "@example/reader",
  "version": "1.0.0",
  "type": "module",
  "browserPlugin": {
    "browser": "./browser.js",
    "page": "./page.js",
    "matches": ["https://*/*"],
    "permissions": ["network", "documents", "scripts", "tabs", "mcp"]
  }
}
```

The browser reads plugins from a directory of the user's at start. The
built-in ones ship with the example.

A page half, as a sketch rather than a final API:

```ts
export function activatePage(page: PageContext): Disposable | void {
  // DNR-shaped rules, which the host evaluates
  page.network.rules(rules);
  page.network.intercept((request) => verdict, { types: ['script'] });
  // a document starts to arrive
  page.documents.onCommit((doc) => {
    doc.userStyles(css); // the user origin
    doc.inject(code, { runAt: 'start' }); // the page's realm
    doc.onChanges((changes) => doc.mark(element, 'hidden'));
    doc.overlay(() => element); // drawn over the page, in the pane
    doc.handle; // the document's `HtmlHandle`
  });
  page.channel.onMessage((message) => {});
}
```

A browser half:

```ts
export function activateBrowser(browser: BrowserContext): Disposable | void {
  browser.toolbar.button({ icon, title, badge, popup: () => element });
  browser.commands.add('reader.toggle', { keys: 'Mod+Shift+R' }, run);
  browser.contextMenu.add({ when: 'link', label, run });
  browser.tabs; // list, open, close, activate, onUpdated
  browser.storage; // JSON, per plugin, on disk
  browser.mcp.tool(name, schema, handler);
  browser.channel.tab(id).send(message);
}
```

A plugin's UI is react-x11 components, not HTML pages. A popup is a
`<popup>` of core's widgets, and the engine's fidelity never enters into
it. That is a second cost an extension's design pays that ours does not.

### The channel

`<Frame>`'s wire is props by structured clone, one message per commit that
changed them, and functions that become fire-and-forget stubs (core's
`docs/frame.md`). The plugin channel is built on that:

- one callback out, `onPluginMessage(plugin, message)`;
- one prop in, a sequence-numbered inbox;
- request and response matched by id.

Core's rule that "the pane owns its data" holds. The browser half hands a
page half a path (a compiled filter engine, a set of user styles), not the
data. What crosses as a pane starts is which plugins are enabled, each
page half's module URL, and its settings.

A pane is 40–70 MB before it holds a page (core's `docs/frame.md`), so a
page half is imported the first time a document matches its `matches`,
not as the pane starts.

## The five features

### 1. Blocking at the network

**Where.** One intercept on `HtmlNetwork` (seam 1), asked before the cache
for every request:

- a navigation, top-level or a frame's (`document`);
- a resource: images, stylesheets, fonts and scripts, and favicons, which
  come the same way (`load`);
- a page's own request: `fetch`, `XMLHttpRequest`, a frame's document, a
  worker's script (`request`);
- a video's `src`, before it is handed to the platform's player, which
  would otherwise fetch the ad itself;
- a WebTransport session.

It goes before the cache because the cache is keyed by URL and a verdict is
not. A script blocked as a third party on one page is the site's own on
another. `load` already has a refusal (`{ refused: true }`, which mixed
content and `file:` use), and a block is one more reason for it.

**What a matcher is told.**

- the URL and the method;
- the type, in DNR's vocabulary: `main_frame`, `sub_frame`, `script`,
  `image`, `stylesheet`, `font`, `media`, `xmlhttprequest`,
  `webtransport`, `other`;
- the document that asked;
- the tab's top-level document.

The type needs `FetchRequest.destination` (seam 1).

**What it can answer.**

- Allow.
- Block. `onResource` declines, which is the document's ordinary path for
  a 404. A page's `fetch` rejects with a `TypeError`, as it does under
  Chrome's `ERR_BLOCKED_BY_CLIENT`. A navigation shows the error page.
- Redirect to a neutered resource: uBO's `noop.js`, a 1×1 GIF, a stand-in
  for an analytics script. These matter: blocking some scripts breaks the
  page that calls them, and a surrogate is what keeps it working.
- Upgrade to https.
- Change headers: take a request's tracking parameters off
  (`$removeparam`), add to a response's CSP (`$csp`).
- Rewrite a document's body as it streams in. uBO's HTML filters
  (`##^script:has-text(…)`) need it, and only Firefox offers it to
  extensions.

**The engine.** `@ghostery/adblocker`, 2.20.1 as this is written:

- pure TypeScript;
- the EasyList and uBO syntax, cosmetic filters and scriptlets included;
- an engine that serializes to a `Uint8Array`;
- MPL-2.0.

It already has adapters for Puppeteer, Playwright and Electron
(`@ghostery/adblocker-puppeteer`, `-playwright`, `-electron`), and ours
would be a fourth of the same shape. Brave's `adblock-rust`, native or
WebAssembly, is the fallback if matching ever shows in a profile.

The lists live in the browser half, and so does compiling them:

- it downloads and compiles the lists;
- it writes the serialized engine to a file;
- each pane reads the file.

The matcher also takes DNR's rule format as its own declarative format, so
a plugin with a handful of rules writes JSON, and an MV3 ruleset loads
unchanged.

**What to expect.** With scripts off, this browser's default, most ad tech
never runs. And the example hands `<Html>` no `renderEmbedded`, so a frame
is an empty box. There, network blocking pays for images, tracking pixels
and fonts. Once a site's JS switch is on it pays for everything. Each tab's
count of blocked requests goes to the toolbar as a badge.

### 2. Blocking in the document

Three tiers, each with a seam of its own.

**CSS hiding** (`example.com##.ad-slot`) goes in a user-origin stylesheet
(seam 2).

- **Why not the `stylesheet` prop.** It is author origin, applied after the
  document's own, so a page's `!important`, or an inline one, beats
  `display: none !important`.
- **Why the user origin.** A user `!important` beats every author
  declaration (CSS Cascade 5, 6.1). That is why blockers inject their CSS
  at the user origin: `cssOrigin: 'user'` in `tabs.insertCSS`, `origin:
'USER'` in `scripting.insertCSS`.
- **What a big sheet costs.** The parser makes a rule of each selector in a
  list (`StyleRule` in `css/parse.ts`), and the index files each under its
  class or id. So a sheet of twenty thousand generic selectors should cost
  an element only the buckets its own names reach. That is to be measured,
  not assumed.
- **How the sheet is written.** One rule per selector, so a selector the
  engine does not know drops only itself.
- **When it is handed over.** A site's own selectors are known from the
  URL, so its sheet is handed over before the first build rather than
  restyling the document after it.

**Procedural filters** (`:has-text()`, `:upward()`, `:matches-css()`,
`:xpath()`, `:min-text-length()`, `:style()`) say things no CSS can.

- They are evaluated in the host, against `handle.document`.
  `@ghostery/adblocker-extended-selectors` is that evaluator.
- They are evaluated again after each change the feed reports (seam 4).
- What they match is marked through a seam a page cannot see (seam 3), and
  the user sheet styles `:-rx-mark(hidden)`.

Writing the result into the DOM, as a `style` or a class, would let the
page's scripts see it, which is how an anti-adblock script finds a
blocker. A page's `getComputedStyle` still reports `display: none`, as it
does in Chrome under uBO.

**Scriptlets** (`example.com##+js(set-constant, …)`, `json-prune`,
`abort-on-property-read`, `no-setTimeout-if`) are code that has to run in
the page's realm before its first script, to change what the page will
find there.

- Seam 5 runs host-supplied code there at `document_start`, in each
  frame's realm too.
- The scriptlet libraries, uBO's and AdGuard's `@adguard/scriptlets`, are
  page JavaScript and run unchanged, as far as the facade carries them.
- They matter only where a site's scripts run.

### 3. Automation and productivity

**What there is.** The handle is already a host-side automation API:

- `document`, `elementAt`, `elementRect`;
- `focus`, `activate`, `setControlValue`, `submitForm`;
- `scrollElementTo`, `computedStyle`, `matchMedia`.

domutils and css-select query the tree. That covers:

- filling a form;
- a page as Markdown, or a table as CSV;
- link hints;
- reloading a page on a timer;
- in the browser half, saving and restoring a set of tabs.

**What it needs.**

- **Overlays.** Nothing a host draws shows over a pane, which is why the
  status bubble is the pane's. A page half's overlay is a React element
  mounted over `<Html>` in `page.tsx` and placed from `elementRect`. It
  lets the pointer through unless it asks not to. Examples: Vimium's hints,
  a highlight, a translation's tooltip.
- **Commands.** A pane already passes the browser's chords back (`keys.ts`,
  `onCommand`). A plugin's commands join the same list, so a chord works
  whether the toolbar or the page has the key.
- **Context menu items**, added to the menu `page.tsx` already opens,
  chosen by what was under the pointer: a link, an image, a selection.
- **Userscripts.**
  - The Greasemonkey header: `@match`, `@include`, `@exclude`, `@run-at`,
    `@grant`, `@require`, `@noframes`.
  - The `GM.*` API: `getValue` and `setValue`, `xmlHttpRequest`,
    `addStyle`, `registerMenuCommand`, `openInTab`, `notification`,
    `setClipboard`.
  - A `@grant none` script is page code, and seam 5 runs it at its
    `@run-at`.
  - A granted script belongs where the page cannot see its `GM.*`
    functions, which is an isolated world (seam 6). Until then it runs in
    the page's realm, as Violentmonkey's "page" mode does, with the leak
    documented.
- **The user's scripts without the page's.** The engine can run the facade
  and the injected scripts and none of the parser's. Then a site whose JS
  switch is off still gets the user's script, and is drawn as with
  JavaScript off, `<noscript>` and all.

### 4. MCP

**The browser as an MCP server.** The browser half holds one endpoint for
every tab and routes each call to the tab's pane, where the documents are.

- **Transports.** Streamable HTTP on `127.0.0.1`, with a token in a file
  only the user can read, for a browser that is already running. Or stdio,
  for an agent that starts the browser itself.
- **The server.** `@modelcontextprotocol/sdk`.

| Tool                                          | Answered from                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `tabs`, `open`, `close`, `activate`           | the browser's tabs                                                                                            |
| `navigate`, `back`, `forward`, `reload`       | the tab's `HtmlSessionHistory`                                                                                |
| `read_page`                                   | the drawn text, in document order, with a ref for each link, button and field; what is not drawn is not there |
| `find`                                        | a selector or a text, answered with refs                                                                      |
| `click`, `type`, `select`, `submit`, `scroll` | `activate`, `setControlValue`, `submitForm`, `scrollElementTo`                                                |
| `screenshot`                                  | the pane's own pixels                                                                                         |
| `network_log`                                 | the intercept, which sees every request                                                                       |
| `wait_for`                                    | a selector, `onParsed`, `onLoaded`                                                                            |
| `evaluate`                                    | the page's realm, only where the site's scripts run                                                           |

**How this differs from Playwright MCP or Chrome DevTools MCP.**

- There is no CDP and no second browser.
- `read_page` comes from the layout, so "visible" means drawn.
- A ref is an `Element` the host holds. Each element of a document has
  one, and it goes when the document does.
- A plugin adds tools of its own (`browser.mcp.tool`), so an automation
  plugin's "this page's recipe as JSON" is something an agent can call.

**Safety.**

- Page text that reaches an agent is untrusted input, a channel for prompt
  injection. Tool results say which text came from the page.
- Some actions can be held for the user's yes in the browser, as a setting:
  - a POST;
  - a navigation to a new origin;
  - turning a site's scripts on.
- The endpoint binds loopback only, and refuses a call without the token.
- A `file:` page cannot be read through it unless the user says so.

The other direction, the browser as an MCP _client_, is an assistant in a
side panel calling the user's MCP servers about the page. That is a plugin
built on these APIs and a model, not part of the system.

### 5. Base styles

**The user origin (seam 2) is CSS's own answer.**

- A normal user rule is a default the page's CSS beats: a font for a page
  that names none, link colours, a reading width.
- A user `!important` rule forces: hide every sticky header, stop every
  animation, set a least line height.
- Per-site sheets are UserCSS's `@-moz-document domain(…)`,
  `url-prefix(…)` and `regexp(…)`. The host reads them and hands each to
  the documents whose URL matches, so userstyles.world's styles work
  unchanged.
- UserCSS's preprocessors, Stylus and Less, are left out.

**Some of what users call base styles is a browser preference, not CSS.**

- Which fonts `serif`, `sans-serif` and `monospace` mean, and the size
  `medium` is. This becomes a prop on `<Html>` (part of seam 2).
- A minimum font size, which Chrome applies as a clamp on computed sizes
  rather than as a rule. Also a prop (part of seam 2).
- The scheme a page that says nothing is drawn in: `defaultColorScheme`,
  already a prop.
- Reduced motion: `reducedMotion`, already a prop.
- Zoom per site: the pane's `zoom`, already there.

**A dark mode for every site** should not be `filter: invert(1)` on the
root. On X11 and Wayland a filter runs over pixels read back
([`filter` in `<Html>`](prd-filter.md)), so every paint would read the
whole document back. The cheap version is a colour transform at paint
time, as Chromium's auto dark mode is. That is a seam to design on its
own, later.

## The seams

What `<Html>` and `HtmlNetwork` would grow, in the order the phases need
them. Each is useful to a host with no plugins.

1. **A request intercept, and a request's destination.**
   - `HtmlNetworkOptions.intercept(request)` answers a verdict, or a
     promise of one.
   - It is asked in `document`, in `load` (before the cache), in `request`,
     in `resources`' video branch and in `webTransport.connect`.
   - A response stage for headers.
   - A transform of a document's body as it streams.
   - `FetchRequest.destination`, in Fetch's vocabulary (`''`, `document`,
     `iframe`, `worker`, `sharedworker`, `serviceworker`, `script`), set by
     the engine where it makes the request.
   - Risk: low. It is the network's own module, and nothing in the cascade
     or the layout sees it.
2. **A user origin.**
   - `Origin.User` below `Presentation`, and `Origin.UserImportant` above
     `InlineImportant` (`css/cascade.ts`). This is Cascade 5's order: a
     normal user rule under every author declaration, an important one
     over every author one.
   - A `userStylesheet` prop beside `stylesheet`.
   - `fonts`: the generic families, the default size, a minimum size.
   - Risk: the style-sharing key and the check for whether the sheets
     changed (`_sheetsKept`) both read the sheets, and a user sheet is one
     more input each has to compare.
3. **Host marks.**
   - A prop of elements and names, `marks: ReadonlyMap<Element, readonly
string[]>`.
   - A pseudo-class, `:-rx-mark(name)`, that matches in the UA and user
     sheets only. It never matches in an author sheet, in `matches()` or in
     `querySelector()`, so a page cannot probe for it.
   - A mark is told to the cascade as a change of an attribute no element
     has, as `:defined` is (`-rx-defined`), so it restyles in place.
4. **A change feed.**
   - `onChanges(changes | null)` after each `refresh`, with the records it
     was told (`HtmlChange`).
   - After each streamed chunk, with the parser's records
     (`takeAppended`).
   - `null` where everything was restyled.
   - A procedural filter and an automation tool evaluate again on it.
5. **Injected scripts.**
   - `HtmlScripts.inject(url, frame)` answers `{ code, url, runAt }[]`,
     run in the document's realm.
   - `start` runs after the facade is installed and before the parser's
     first script, `end` at `DOMContentLoaded`, `idle` after `load`.
   - A way to run them with the page's own scripts off.
   - Risk: the runner's order. A script the parser yields to
     (`onParserBlocked`) must not run before a `start` one.
6. **Isolated worlds.** A realm per document and per world over
   `DomShared`, not linked as a frame is: the same nodes, with wrappers of
   its own. It needs three things frames never did:
   - every world's listeners hear the document's events, the user's and a
     page's `dispatchEvent` alike;
   - each world's `MutationObserver` sees every world's changes;
   - `window.postMessage` reaches across worlds.

   This is the large one. Granted userscripts stand on it, and so would any
   later Chrome compatibility.

What the browser example would grow, none of it in `src/html/`:

- **The loader:** a plugins directory, manifests, turning a plugin on and
  off, and each plugin's settings and storage.
- **The channel** over `<Frame>`.
- **The surfaces:** toolbar buttons with badges and popups, page overlays,
  commands, context menu items.
- **The built-in plugins:** the blocker, user styles, userscripts, MCP.

## Phases

1. **Network blocking and user styles.**
   - Seam 1.
   - The blocker plugin: `@ghostery/adblocker` with EasyList and
     EasyPrivacy, a per-site off switch, and a badge.
   - CSS hiding and user styles through the `stylesheet` prop for now.
     It is the author origin, knowingly the weaker one.
   - The loader and the channel, enough for the built-in plugins.
   - Done when: a list blocks requests on all five paths, a test covers
     each, and the per-request cost and the pane's memory are measured and
     written down here.
2. **Blocking in the document.**
   - Seams 2 to 5.
   - Cosmetic hiding moves to the user origin.
   - Procedural filters and scriptlets.
   - `@grant none` userscripts.
   - Done when: a page's `!important` cannot bring a hidden element back,
     and a page's script cannot find the marks.
3. **Automation and MCP.**
   - The API over the handle, overlays, commands and context menus.
   - Third-party plugins from the directory.
   - The MCP server and its tools.
   - Done when: an agent can read a page, fill in a form and submit it,
     with the confirmation held for the user.
4. **Isolated worlds and what stands on them.**
   - Seam 6.
   - Granted userscripts.
   - DNR rulesets read from an MV3 extension's manifest.
   - Then a decision about content-script extensions and blocking
     `webRequest`, on what phases 1 to 3 found.

## Open decisions

- **Trust.** Trusted plugins (recommended), or sandboxed ones: in
  QuickJS, or in a process of their own started with Node's `--permission`,
  which `<Frame execArgv>` allows since react-x11 2.46.0. A sandbox costs
  the synchronous hooks: a verdict on each request across a process is a
  round trip.
- **When a page half loads.** Lazily, on the first matching URL
  (recommended), or as the pane starts.
- **Where the host lives.** In `examples/browser/plugins/` first
  (recommended), and in `src/` once a second host wants it.
- **The blocker's engine.** `@ghostery/adblocker` (MPL-2.0, which is
  copyleft per file and fine to depend on), or `adblock-rust` if matching
  shows in a profile. Either is the example's devDependency, as `ssh2` is
  the ssh terminal example's, and never a dependency of the published
  package.

## Out of scope

- **An assistant in a side panel**, the browser as an MCP client: a
  plugin, on the APIs above.
- **Password managers.** They need `crypto.subtle`, and a way to fill a
  field without the page seeing the secret before the user acts. That is a
  design of its own.
- **Sync, downloads and cookies.** The network makes no downloads and
  stores no cookies (the header of `src/html/network.ts`), so there is
  nothing for a plugin to reach.
