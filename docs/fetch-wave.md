# Fetch: where `<Html scripts>` stands, and the next wave

Measured on master at d7785b9c (0.35.0), Node 24.22, against wptserve with
`scripts/conformance/interop.ts` (8 jobs, 4G a job).

| Run                                              | Tests | Score                          |
| ------------------------------------------------ | ----: | ------------------------------ |
| Interop 2026 `fetch` (META.yml label)            |    23 | **82.6** (226 of 230 subtests) |
| All of WPT `fetch/` (every test in the manifest) |   957 | **58.4** (7,745 of 13,055)     |

A score is the mean of each test's passing fraction, as interop.ts has it,
so a group's points below are the test-equivalents it loses over 957, times 100. They add up to the 41.6 lost.

## The Interop area is one cause

Nineteen of the 23 tests pass whole. The other four are
`fetch/api/basic/request-upload.h2.any{,.worker,.sharedworker,.serviceworker}.html`,
and each errors before a subtest runs: the harness serves `.h2.` tests on
the HTTP/2 port, and the page's network speaks HTTP/1.1 only, so undici
answers `Response does not match the HTTP/1.1 protocol`. With HTTP/2 the
area is **100**.

What that takes was probed, not assumed:

- Node's `fetch` is undici 7.29 inside the runtime, HTTP/1.1 unless it is
  handed a dispatcher with `allowH2`. Bun 1.4's `fetch` is HTTP/1.1 too
  (`UnexpectedData` from the h2 port).
- The runtime's own `Agent`, reached through undici's global-dispatcher
  symbol, does it: streaming upload, `duplex: 'half'`, `200 Test`. That is
  reaching into the runtime, which "uses public API alone" rules out.
- The npm package's `Agent` (8.12) handed to the runtime's `fetch` fails:
  `InvalidArgumentError: invalid onRequestStart method`, the two undicis'
  handler APIs differing. The package's **own** `fetch` with its own
  `Agent({ allowH2: true })` works.

So the shape is `undici` as an **optional peer**, as `quico` and `werift`
are: loaded the first time the network sends over https, and where it is
there, the transport is its `fetch` over an `Agent` that negotiates h2 by
ALPN; absent, the runtime's `fetch` as now. Its types written out. A caret
on one major, since the handler API is what moves between them. Unverified:
undici's fetch under Bun.

## The rest of `fetch/`, by cause

| Group                                | Lost (pts) | Tests | Where the fix lives                              |
| ------------------------------------ | ---------: | ----: | ------------------------------------------------ |
| Fetch Metadata (`Sec-Fetch-*`)       |        6.4 |    90 | `network.ts`: `_headers`, `request`, `document`  |
| HTTP cache for a page's `fetch`      |        5.3 |    74 | `network.ts` `request()`, `http-cache.ts`        |
| Request / Headers / Response IDL     |        4.8 |    85 | facade (`dom.ts` 19893–21000)                    |
| Body as a stream                     |        4.6 |    67 | facade `Response`/`Request` over `streams.ts`    |
| `fetchLater` and keepalive at unload |        4.6 |    45 | new: realm + host, at `__unload`                 |
| ORB, CORB, CORP, `nosniff`           |        3.5 |    53 | `network.ts`, `resources.ts`, `script-origin.ts` |
| Compression dictionaries             |        2.6 |    27 | tentative, Chromium only                         |
| HTTP/1.1 strictness of the transport |        2.6 |    46 | the transport (undici/llhttp)                    |
| Referrer policy                      |        1.6 |    21 | `referrerFor`, the facade's `referrer`           |
| HTTP/2                               |        1.3 |    12 | the transport (above)                            |
| CORS and redirects                   |        1.2 |    23 | `fetch-hops.ts`, navigation                      |
| Everything else                      |        3.1 |    61 | small, listed at the end                         |

### Fetch Metadata — 6.4

No request carries `Sec-Fetch-Site`, `-Mode`, `-Dest` or `-User`: nothing
in `src/html/` names them. 476 subtests say `sec-fetch-site` is missing, and
the 66 `metadata/generated` tests are the whole of their file's loss. The
headers go only to a potentially trustworthy URL, which the `http:` twins
check the other way (88 subtests find `sec-fetch-mode` where there must be
none). What is needed is a request's destination and mode by
`ResourceKind`, its site from its initiator and every URL its redirects
went through, and `Sec-Fetch-User` on a navigation the user activated.
Some of it will not move: 76 subtests time out waiting for a request a
worklet (`addModule` is undefined), a `<link rel=prefetch>` or a report
would make. Expect **4.5 to 5**.

### The HTTP cache for a page's `fetch` — 5.3, and 0.7 more

`HtmlNetwork.request()` says it in its comment: "Not cached". What
`<Html>` asks for goes through `http-cache.ts` (RFC 9111); what a page's
script fetches does not, so 212 subtests read "does not come from cache"
and the `Request.cache` modes do nothing (`request-cache-*`, 0.7 in the
IDL row). The work is `request()` through `load`'s cache with the mode
honoured — `no-store`, `reload`, `no-cache`, `force-cache`,
`only-if-cached` — and the parts of 9111 the subresource path never
needed: a 304 updating the stored headers, a POST or PATCH invalidating,
partial content, `stale-while-revalidate`, and a conditional request the
page wrote itself passed through untouched (`conditional-get`). Expect
**5**, more than any other group per line of code.

### Request, Headers and Response — 4.8

The facade's own classes, and each loss a rule the constructors do not
check yet. All in `dom.ts`, nothing on the host:

- methods: `CONNECT`, `TRACE` and `TRACK` throw (`forbidden-method`, 4.0),
  and only the six standard names are upper-cased (`patch` stays `patch`);
- `RequestInit` errors (`request-error`, 2.2): a `window` that is not null,
  `mode: 'navigate'`, `no-cors` with a method or `cache` it cannot have,
  a `priority` outside its enum;
- `Headers`: a `record<ByteString, ByteString>` read as WebIDL reads one,
  through a proxy's `ownKeys` and with symbols refused
  (`headers-record`, 3.4); `null` refused; values checked for NUL, CR and
  LF and above U+00FF; `getSetCookie()` and the sorted combined list
  (`header-setcookie`, 2.0); the forbidden request headers and the
  `X-HTTP-Method-Override` family (`headers-forbidden-override`, 3.2,
  `request-forbidden-headers`, 1.8);
- read-only attributes and the IDL's shape (`request-structure`, 2.5,
  `idlharness`, 2.3: 93 members not enumerable, arities);
- `Content-Type` only where there is a body, and `Origin` only where Fetch
  sends one (`request-headers`, 1.8);
- `referrer` reads `about:client` where it should read the URL.

Expect **3.5 to 4**, in small commits, each holdable by its own WPT file.

### Body as a stream — 4.6, and 0.6 more

A `Response` keeps its body as a string or bytes and makes a stream when
asked (`_body`, `_raw`, `_stream`), so the body and `bodyUsed` come apart:
reading or piping `response.body` leaves `bodyUsed` false
(`response-stream-disturbed-*`, 9.3), a stream given to a constructor is not
locked against (`response-from-stream`, `request-init-stream`, 5.7), a
null-body status still has a stream (`response-null-body`, 3.6), a clone
shares its chunks' buffers (`response-clone`, 2.9), and `body` is no byte
stream, so a BYOB reader cannot be had (`response-consume-stream`, and the
big gzip, br and zstd bodies under `content-encoding/`, 6 more tests).
`streams.ts` already has byte streams. The fix is Fetch's model: a body
is a byte `ReadableStream` with a source, `bodyUsed` is its disturbed
flag, every reader "fully reads" it, a clone tees it. Add
`textStream()` while there (2.9). Expect **5**.

### `fetchLater` — 4.6

Not defined. Deferred fetching sends at `pagehide` or after
`activateAfter`, inside a quota delegated to frames by permissions policy.
The unload path it needs exists (`__unload`, the back-forward cache's
freeze). Chromium alone ships it, so it waits behind the cross-browser
groups. `keepalive` bodies sent as a document goes are the same work
(`keepalive.any`, `cors-keepalive`: 0.4).

### ORB, CORB, CORP, `nosniff` — 3.5

A `no-cors` response is handed to an `<img>` or a `<script>` whatever it
is. `Cross-Origin-Resource-Policy` (`fetch.https`, `scheme-restriction`,
`image-loads`, `iframe-loads`: some 7 tests) and `X-Content-Type-Options:
nosniff` for scripts and styles are every browser's; ORB is tentative.
Do CORP and `nosniff` first.

### The transport's HTTP/1.1 — 2.6, and 0.4 more

undici's llhttp turns down what browsers read: a status outside 100–999
(`h1-parsing/status-code`), `Content-Length: 42,42` and duplicates
(`content-length/parsing`), control bytes in a header value, sent
(`header-values-normalize`, \x01 refused as `invalid val1 header`) or
received (`header-value-combining`), duplicate `Content-Disposition`.
Node's `insecureHTTPParser` was tried and refuses the same. It also writes
header names in lower case, where `request-headers-case` wants them as the
page wrote them. Only a client of our own, over `net` and `tls` with
`node:http2` for h2, would pass these, and that is a large thing to own for
3 points. **Parked**; if it is ever done, it replaces the undici peer above.

### Referrer policy — 1.6

`referrerFor(client, url)` makes every `Referer`; neither the request's
`referrer` nor its `referrerPolicy` reaches it, nor does a redirect's
`Referrer-Policy` (`request-referrer`, 3.5 tests, `redirect-referrer`,
`-override`, `cors-preflight-referrer`, `policies/referrer-*`).

### Everything else — 3.1

Each under a test-equivalent unless said: `data:` URL processing and
`base64` (1.3), `Content-Type` sniffing of a response and a script's
charset (1.4), `fetch-destination` through a service worker (2.8, partly
`prefetch`), `redirect-navigate` fragments and `302-found-post` (2.2),
`redirect-location-escape` (3.2), `scheme-blob` (0.8), `origin/assorted`
(1.0, `Origin` rules), `abort` (1.5: a request's own signal, the order a
consumed body rejects in), `integrity` (0.8). `huge-fetch` is killed at the
4G cap.

One harness gap, not the product's: `scripts/conformance/wpt-hosts.ts`
resolves `web-platform.test` and not `web-platform.test.`, so the four
`metadata/trailing-dot` tests fail at DNS. Its pattern wants `\.?$`.

## The wave, in order

| PR  | What                                    | fetch/ | Interop fetch | Size         |
| --- | --------------------------------------- | -----: | ------------: | ------------ |
| 1   | HTTP/2 over an optional `undici` peer   |   +1.3 |    82.6 → 100 | small        |
| 2   | Request / Headers / Response IDL rules  | +3.5–4 |             — | small–med    |
| 3   | Body as a byte stream, `textStream()`   |     +5 |             — | medium       |
| 4   | `Sec-Fetch-*`                           | +4.5–5 |             — | medium       |
| 5   | A page's `fetch` through the HTTP cache |     +5 |             — | medium–large |
| 6   | Referrer policy end to end              |   +1.5 |             — | small–med    |
| 7   | CORP and `nosniff`                      |     +1 |             — | medium       |

Then, if wanted: `fetchLater` (+4.6, Chromium only), ORB (+2), the tail.
Not planned: compression dictionaries (tentative, Chromium only, a Brotli
with shared dictionaries Node's zlib does not have) and a transport of our
own (above). Through PR 7 `fetch/` comes to about **80**.

PR 1 first: it is the one that moves Interop, it is small, and it touches
nothing the others do. PR 2 and 3 are the facade's and can run beside 4
and 5, which are the network's.

## How it was run

```bash
cd ~/wpt-history/wpt && _venv3/bin/python wpt serve --config ../wpt-config.json --webtransport-h3
WPT_HTTP_PORT=8100 WPT_HTTPS_PORT=8543 WPT_H2_PORT=9000 \
NODE_EXTRA_CA_CERTS=~/wpt-history/wpt/tools/certs/cacert.pem \
npx tsx scripts/conformance/interop.ts --only fetch --jobs 8 --out <dir>
```

The whole directory went through the same runner with a scratch metadata
root whose `meta/fetch/META.yml` labels every `fetch/` test in the
manifest `interop-2026-fetch`; 957 tests take 7.8 minutes at 8 jobs.
