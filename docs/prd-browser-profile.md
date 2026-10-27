# A browser profile: cookies, storage and a cache that outlive a restart

The example browser (`examples/browser/`) kept nothing between two runs, and
little between two tabs. `HtmlNetwork` sent no cookie and kept none, so no
site that logs in by cookie could be used. `localStorage` and
`sessionStorage` were a map in each tab's process, gone when the process
went, and each tab is a process of its own (`<Frame>`). IndexedDB lived in
the page's realm, gone with the document. This record is the survey of what
a profile needs, what Chrome keeps one in, the decision not to use Chrome's
formats, and the design that was built. The HTTP cache came after, on the
same profile (see "The HTTP cache").

## What was asked

- Cookies, as RFC 6265bis has them: `Set-Cookie` parsed, every attribute
  honoured, the public suffix list where it can be had, a request sending
  what its credentials mode lets it, and `document.cookie` (and
  `cookieStore`) from a page's scripts without ever showing an `HttpOnly`
  cookie.
- `localStorage` and IndexedDB kept across a restart and shared by every
  tab of an origin; `sessionStorage` a tab's own, back with the tab when a
  session is restored; the `storage` event across tabs.
- All of it behind seams whose default is the old behaviour, because
  `<Html>` stores nothing by construction (AGENTS.md, "Nothing is fetched,
  by construction").
- A profile directory for the browser, a throwaway one on request, and the
  tabs back after a restart.

## Chrome's profile, part by part

| What            | Where in a Chrome profile                | Format                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cookies         | `Cookies` (`Network/Cookies` lately)     | SQLite. A `cookies` table and a `meta` table whose `version` Chrome moves every few releases. Times in microseconds since 1601. The value is in `encrypted_value`, prefixed `v10` or `v11`: AES-128-CBC under a key derived (PBKDF2, salt `saltysalt`) from a password in the macOS Keychain ("Chrome Safe Storage") or libsecret/KWallet, or a fixed one on Linux without either; on Windows a DPAPI-wrapped AES-GCM key in `Local State`, and app-bound encryption (`v20`) since 2024. Since schema version 24 the plaintext starts with a SHA-256 of the host. |
| Local Storage   | `Local Storage/leveldb`                  | LevelDB. Keys are `_` + origin + `\0` + the key, values carry an encoding byte (UTF-16 or Latin-1), and `META:` records per origin.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| IndexedDB       | `IndexedDB/<origin>.indexeddb.leveldb`   | LevelDB opened with Chromium's own comparator (`idb_cmp1`) and Blink's key encoding; values in V8's serializer inside Blink's envelope, compressed past a size, blobs as files beside it. Chromium has been building an SQLite backing store for IndexedDB, so this layout is itself on its way out.                                                                                                                                                                                                                                                              |
| Session Storage | `Session Storage/`                       | LevelDB, maps by namespace and origin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Cache Storage   | `Service Worker/CacheStorage/`           | An index and Chromium's disk cache ("simple" backend) entries per cache.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Service workers | `Service Worker/Database`, `ScriptCache` | LevelDB, and the scripts in the disk cache.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

And over all of it, Chrome locks a profile while it runs (`SingletonLock`),
so two browsers never have one open at once.

## What each would need

- **SQLite** is in both runtimes, with no dependency: `node:sqlite` from
  Node 22.5 (behind a flag until 22.13 and 23.4), and in Bun both
  `bun:sqlite` and — in Bun 1.4 — `node:sqlite`. Node 20 has neither.
- **LevelDB** has no reader or writer in either runtime. The bindings
  (`classic-level`) are native modules, a build or a prebuilt binary per
  platform and runtime, and none of them takes a custom comparator, so none
  can open Chrome's IndexedDB at all: LevelDB refuses a database whose
  comparator name is not its own. Pure-JavaScript LevelDB readers exist;
  no writer that keeps Chrome's table format and compaction does.
- **Chrome's cookie values** are encrypted, so reading them means asking
  the Keychain or libsecret for Chrome's key — a system prompt on a Mac —
  and on Windows is closed to anything but Chrome since app-bound
  encryption. Writing them so Chrome would read them back needs the same.

## What matching Chrome would buy, and what it would cost

The one thing it could buy is **interoperation with a real Chrome
profile**, and that comes apart on inspection:

- Sharing a live profile is impossible: Chrome holds it locked while it
  runs, and writing into its files while it is closed is how a user's real
  profile gets corrupted, or migrated by Chrome to a schema this browser
  does not know.
- Reading a Chrome profile — "log in once in Chrome, then use the session
  here" — is an import, not a storage format. It needs Chrome's key from the
  OS (a prompt), and only the cookie file is practical; it can be written
  as a one-way importer into any format, and nothing about storing our own
  data in Chrome's layout makes it easier.

What it would cost:

- A native LevelDB dependency for Local Storage, which no other part of
  this package needs, and which still could not open IndexedDB.
- **A half-compatible format is the worst outcome.** A file called
  `Cookies` with Chrome's schema but no encryption, our partition keys and
  our version is one Chrome would migrate, reject or misread, and one a
  tool written for Chrome's files (yt-dlp's `--cookies-from-browser`, a
  forensics script) would read wrongly without saying so. Chrome changes
  the schema every few releases; we would chase it or fork it.

## The decision

**A format of this package's own: one SQLite database, versioned, in a
profile directory.** Not Chrome's for any part.

- One file, `profile.sqlite`, in write-ahead-log mode, with `PRAGMA
user_version` as the schema version (1). A file of a later version is not
  opened; the profile is then null and the browser keeps memory, rather than
  writing a database it does not understand.
- The cookie table **borrows Chrome's column names where a column means
  what Chrome's means** — `host_key` (a domain cookie's with its leading
  dot, which is what makes host-only cookies and domain cookies two keys),
  `name`, `path`, `value`, `expires_utc`, `is_secure`, `is_httponly`,
  `samesite`, `creation_utc`, `last_access_utc` — so that someone who knows
  Chrome's file is not misled by this one. Times are milliseconds since
  1970, and `samesite` is a word. Nothing else of Chrome's is there.
- **Values are in the clear**, as Firefox keeps `cookies.sqlite`. The
  directory is made `0700` and the file `0600`. Encrypting them under an OS
  key would buy protection against another user on the machine, which the
  modes already give, at the price of a Keychain prompt on every run.
- An **importer from Chrome** (cookies only, with the OS prompt) is a
  possible follow-up, and is not built.

## The design

### Who owns the jar: the processes share the file

Each tab's page runs in a process of its own, and makes its own requests.
The browser's process could own the jar — Chrome's network service does —
but `<Frame>`'s props are fire-and-forget (core's `docs/frame.md`): a pane
cannot ask the browser for a request's `Cookie` header and wait for the
answer, so owning it there means a private channel per pane. SQLite in
write-ahead-log mode already is a store several processes share: one writer
at a time (`busy_timeout` waits), readers never blocked, every commit whole.
So **every process opens the database**, and a reader reads a table again
only where `PRAGMA data_version` — which moves when another connection
commits, and costs no read of the file — says one did. A cookie a login sets
in one tab is on the next request any tab makes.

### Seams, and their defaults

- **`CookieJar`** (`src/html/cookies.ts`) is the storage model and the
  retrieval, pure, over an `HtmlCookieStore` (`load`, `changed`, `put`,
  `delete`), memory by default. `HtmlNetwork({ cookies })` sends and stores
  through it; with none, a network keeps no cookie, as before.
- **`HtmlScripts.cookies`** (`HtmlDocumentCookies`, which a jar is) is what
  `document.cookie`, `navigator.cookieEnabled` and `cookieStore` read; with
  none, a document has no cookies, as before.
- **`HtmlScripts.storage`** (`HtmlStorage`, `src/html/storage.ts`) is
  `localStorage`, `sessionStorage`, the `storage` event's channel and,
  optionally, IndexedDB's store; with none, memory per process, as before —
  and IndexedDB stays the document's.
- **`HtmlNetworkOptions.httpCache`** (`HtmlHttpCacheStore`,
  `src/html/http-cache.ts`) is where a network keeps responses past its own
  memory; with none, the HTTP cache is the network's memory alone, gone
  with the process.
- **`HtmlProfile`** (`src/html/profile.ts`) answers all of them from the
  database: `profile.cookies` is a jar's store, `profile.storage` a
  document's storage, and `profile.httpCache` a network's cache, in a file
  of its own beside the database.

### Cookies

RFC 6265bis's storage model (5.7) and retrieval (5.8.3) as written, with
these choices:

- **A cookie that names no `SameSite` is `None`'s**, as Firefox and Safari
  treat it, not Chrome's "Lax by default". It is the reading that breaks no
  login flow that posts back across sites, and it is what the WPT cookie
  tests that are not about Lax-by-default expect.
- **Third-party cookies are sent**, as 6265bis has it and Chrome does;
  `CookieJar({ thirdParty: false })` holds every cross-site request to none.
  `Partitioned` (CHIPS) is read as an ordinary cookie.
- **The public suffix list** comes from the optional peer `tldts`
  (`publicSuffixList()`, loaded once, its types written out), private
  domains included, as browsers use it. Without it, the last label is the
  suffix: `Domain=com` is refused, and `Domain=co.uk` is not.
- **The caps** are Chrome's: 180 cookies a domain, 3000 in all, the least
  recently used first; an expiry at most 400 days ahead (6265bis).
- **A `Secure` cookie** may be set and sent over `https:` and on a loopback
  host (Secure Contexts, "potentially trustworthy"), and an insecure origin
  overwrites none ("leave secure cookies alone"). The `__Secure-` and
  `__Host-` prefixes are held to, case-insensitively.

`HtmlNetwork` decides what each request is to the jar:

- A navigation is top-level, same-site with its destination where the
  document that started it is (`document(…, { initiator })`, a form's
  `from`), or where nothing did — an address typed, a bookmark. A request
  that left the site on the way, through a redirect, is not same-site.
- A subresource carries its cookies (`include`), same-site where it is with
  the document; a page's `fetch` carries them as its credentials mode says
  (`FetchRequest.credentials`, `same-origin` by default; a preflight none).
- **A network with a jar follows redirects itself** (`redirect: 'manual'`):
  the runtime's `fetch` would follow them out of sight, and a login's
  session is set on the 302 or 303 it answers with. Each hop's `Set-Cookie`
  is stored and each hop's cookies sent; the method rules (a POST's 301,
  302 or 303 is a GET), the twenty-hop limit and a page's streamed body
  (sent once) are Fetch's. Without a jar the transport follows them, as
  before.

### `localStorage` and `sessionStorage`

An origin's `localStorage` is a table's rows, read once into the process and
kept, read again where another connection committed, written through a
statement at a time. Each origin is held to 5 MiB of keys and values (UTF-16
code units, as Firefox and Safari count), and `setItem` past it throws
`QuotaExceededError` — memory and profile alike.

`sessionStorage` is the tab's, which is one process's, so it is memory,
written through to the profile under the tab's key where the browser gave
one (`HtmlProfile.open(dir, { tab })`). A restored tab gets its key back
and finds its items.

The `storage` event (HTML 12.2.4) is told for a change that changed
something — not a key set to what it held, nor an empty area cleared — to
every other document of the origin: in the process through
`HtmlStorage.watch`, which memory has too, so a frame hears its page; and
across processes through a small `storage_events` table, polled every
250 ms by a connection that has listeners, again only where `data_version`
moved. A change to `sessionStorage` is the tab's, and goes to no other
process.

### IndexedDB

The page's realm keeps running IndexedDB as it did — every database it
opened in memory, its keys ordered, its transactions run there — so the
Interop area that is at 100% is not touched where the host keeps nothing.
Where it does (`HtmlStorage.indexedDB`):

- A database is read from the host as the realm first opens it: its schema,
  and each record's key (a tagged JSON form, one text for one key) and value
  (the structured clone the realm already serializes for a worker).
- A committed `readwrite` or `versionchange` transaction writes its
  difference — the records written and the keys gone, found against the
  copy of each store it already kept to undo itself — and the schema, in one
  SQLite transaction, before `complete` fires. Each commit moves the
  database's **stamp**.
- A transaction that starts where another document committed since — its
  stamp moved — reads the database again first, unless one of this realm's
  is under way on it. So two tabs see each other's commits at their next
  transaction. What is not done is holding a transaction in one tab back for
  another's, as a browser does: a read-modify-write across tabs is the later
  commit's, record by record. An upgrade in another tab is seen by the next
  `open`, not by connections already open, which hear no `versionchange`.
- A worker's IndexedDB is the worker's realm's and is not kept: the worker's
  thread has no storage seam yet.

### The HTTP cache

A page's static resources were asked for again by every tab, and by every
run. `HtmlNetwork` kept a cache keyed by URL, but in the process's memory,
and each tab is a process; and it read none of a response's caching
headers, so what it did keep it kept for the process's life, `no-store`
included, and never asked whether a copy still held.

The cache is RFC 9111's now, as a private cache keeps it
(`src/html/http-cache.ts`, pure, its clock passed in):

- **What is kept** is a 200 or a 203 with no `no-store`, a `Vary` that can
  be answered, and something to be used again by — a freshness lifetime,
  or a validator (`ETag`, `Last-Modified`). One with neither could answer
  nothing later, so it is not kept. A `Vary: *`, and a `Vary: Cookie`, are
  not: the cookies go on a request inside the network, after the cache is
  asked. `Accept-Encoding` is left out of `Vary`, since the runtime's
  `fetch` sends the same one each time and the body is kept decoded. Of the
  header fields, `Set-Cookie` and those about the connection and the
  coding are left out.
- **Fresh** is `max-age`, else `Expires` less `Date`, else a tenth of the
  time since `Last-Modified`, at most a week; `no-cache` (or a `Pragma:
no-cache` with no `Cache-Control`, as Chrome reads one) is fresh for no
  time, and so is freshness written wrong. A private cache reads no
  `s-maxage`. Age is 4.2.3's: the `Age` it came with, the time it took to
  come, and the time since.
- **A stale response is asked about** with `If-None-Match` and
  `If-Modified-Since`; a 304's fields replace the kept ones, and a `Date`
  or an `Age` it does not have goes, rather than age the response by the
  time it was kept. A 200 replaces it.
- **Keyed by the site of the document that asked** and the URL without its
  fragment, as browsers have keyed theirs since 2020, so a page cannot tell
  what another site's pages loaded by how soon a resource comes. It is the
  site of the document, not the top-level one's, which `load` is not told.
- **A hard reload** (`HtmlNetwork.clear()`, Shift+R in the browser) uses
  nothing asked for before it and asks about nothing: the next request for
  each goes with `Cache-Control: no-cache` and `Pragma: no-cache` (Fetch's
  cache mode `reload`), and what comes back is kept in its place.

Where it is kept is two layers. The network's memory holds every resource
it has, bounded by bytes as before, and shares a request still on its way.
Behind it is a store it is handed (`HtmlNetworkOptions.httpCache`), and
`profile.httpCache` is one: **a second SQLite file, `cache.sqlite`**, beside
`profile.sqlite`, a row a response with its head as JSON and its body as a
blob. Not a table in the profile's file, for two reasons: a body is up to
megabytes, which would grow the write-ahead log every cookie write goes
through, and every write to it would move the `data_version` that makes
every other process read its cookies and storage again. It is read straight
from the file at each `get` — there is nothing to mirror — so a stylesheet
one tab kept is there for the next tab's request, and the next run's. It
forgets the responses used longest ago once its rows come to more than
`HtmlProfileOptions.cacheBytes` (512 MB by default), and a use writes
`last_used` again only once it is an hour old, so a page of a hundred
images read from the cache is not a hundred writes. A file of another
schema is started over rather than read: a cache is what can be asked for
again. Its `busy_timeout` is a second where the profile's is five: a cache
that is busy is a response not kept this time, and the page has it all the
same — a store that throws or rejects is one that kept nothing.

### Tabs and a restart

The browser (`examples/browser/profile.ts`) keeps the tabs in
`session.json` and the sites' script switches in `preferences.json` beside
the database, written whole and renamed into place. As it starts it opens
the profile before any tab's process exists, and ends the last session:
where it restores the tabs, it keeps the session cookies and the
`sessionStorage` of the tabs coming back, as Chrome does when it continues
where it left off; where it does not (`BROWSER_RESTORE=0`), both go. Each
restored tab starts its page's process with its saved history, which loads
the entry it shows (the same path a crashed tab takes).

`BROWSER_PROFILE` picks the directory — the platform's place for an
application's data by default, `temp` for a throwaway one that is deleted as
the browser exits (or `--temp-profile`), `none` for memory alone — and the
browser hands it to each tab's process as `BROWSER_PROFILE_DIR`, with the
tab's key as `BROWSER_TAB_KEY`.

### Not done

- Cache Storage, and service-worker registrations past a restart: service
  workers are off by default and keep no `caches` (`HtmlScripts`'
  `serviceWorkers`), so there is nothing to keep yet.
- `cookieStore`'s `change` event: nothing tells a realm of a cookie a
  response, or another tab, set.
- Importing a Chrome profile's cookies.
- What the HTTP cache does not keep: a document — a navigation is asked
  for whole, as before — a page's own `fetch`, `XMLHttpRequest` and a
  worker's scripts (`HtmlNetwork.request`), and a redirect, which is
  followed each time while where it led is kept under its own URL. Nor
  does it serve a stale response while it asks about it
  (`stale-while-revalidate`), or when the server cannot be reached.
- A worker's IndexedDB, and `localStorage` from a frame realm's document in
  another origin's tab, are as described above.

## Verification

- `test/html/cookies.test.ts` holds the jar to 6265bis: dates, attributes,
  domains and the suffix list, paths and their order, `Secure`, `HttpOnly`,
  `SameSite` in each context, the prefixes, the caps, `cookieStore`'s
  shapes, and a store another writer changed.
- `test/html/network.test.ts` logs in to a local server whose 303 sets the
  session, and checks the cookies on every request after, the credentials
  modes, a redirect's `Set-Cookie`, a loop, a Strict cookie and a link from
  another site, and a network with no jar keeping none.
- `test/html/http-cache.test.ts` holds the rules to RFC 9111 — the
  directives, freshness from each source, age, what is kept, the
  validators and a 304's fields — and runs networks against a local server
  whose paths each answer one way: a fresh response asked for once across
  two networks sharing a store, a 304 answering with the kept body and a
  200 replacing it, `no-store` and a response with nothing to be used
  again by asked for each time, `Vary: Accept`, a page of another site, a
  redirect, a hard reload's `no-cache`, a failing store, and the profile's
  file open in two connections at once, again after a restart, and past
  its bytes.
- `test/html/storage.test.ts` opens one profile from two connections and
  again after closing both, hears a `storage` event across them, commits
  and reads IndexedDB, and runs pages through `<Html scripts>`:
  `document.cookie` and `cookieStore` over a jar, `storage` events between
  documents, the quota, and an IndexedDB database written by one document
  and read by the next after a restart, then changed by another connection
  and read again in the document that has it open.
- Interop 2026's `indexeddb` and `fetch` areas, through
  `scripts/conformance/interop.ts` against WPT's server, score the same on
  this branch as on the master it was cut from — IndexedDB 640/640 subtests,
  fetch 230/274 — and the 47 tests' results match subtest by subtest. The
  runner hands `<Html scripts>` no jar and no store, which is the path every
  host without a profile takes.
