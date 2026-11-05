# Popups: `window.open`, `opener` and the windows of a page

`window.open` answered null and `opener` was always null. In the last survey
of web-platform-tests that was the largest single gap in Windows and
navigation, and it stops every popup login: the page opens a window at a
provider, and the provider's redirect comes home to a page that posts to
`window.opener` and closes itself. This is the design that was built, and
what it leaves out.

## What was asked

- `window.open`, `window.opener`, `close()`, `closed`, named targets and
  `target=_blank` with an opener, in `<Html scripts>` and the example browser.
- Nothing opens by construction: with no host answering, `window.open` stays
  null.
- The popup login round trip, against a local fake provider: a click, another
  origin, a redirect home, `opener.postMessage`, `close()`. And the older
  pattern, an opener that polls `popup.closed` and reads `popup.location.href`
  once the popup is same-origin again.

## Where a popup runs

This is the only real decision here, because the example browser runs each tab
in a process of its own (`<Frame>`), and an opener and its popup have to reach
each other.

A same-origin page reads `popup.document` in the same task that opened the
popup:

```js
const w = window.open('', 'report');
w.document.write('<title>Report</title>');
w.document.title; // 'Report', synchronously
```

No process boundary can answer that. A `<Frame>` pane's props are one-way
messages, and nothing shared lets one process read another's DOM.

So **a window with an opener runs in its opener's process**, as a realm of its
own, whatever its origin. That is what browsers do for a browsing context
group's same-site windows, and it is what a frame here already does: another
origin's frame is a realm in the page's process, which the page has by a
number, and what crosses origins goes through the host. It also answers the
question
site isolation has to answer with a process swap: whether a window stays
same-origin is not known until it has gone somewhere, and a popup login crosses
twice. Here nothing moves. The opener's object stands for the same window
through the provider's pages, and reads through to it again the moment it is
home.

The alternative, a proxy across processes, was turned down. It can carry
`postMessage`, `closed` and `location =`, and it cannot carry `popup.document`,
`w.document.write` or a listener on another window, which are the same-origin
half of what pages do. Doing it would mean two paths, one for a window that
happens to be remote, with a page finding out which by what stops working.

A window with no opener goes the other way: `noopener`, `noreferrer` and a plain
`target=_blank` are tabs, each a process, as they always were. That is what
makes the rule safe to live with: a page that asks for isolation gets it, and
HTML's default for links is to ask.

### What it costs

- **A popup goes with its opener's process.** Closing a tab closes what it
  opened, and a crash takes both. In a browser a popup outlives its opener's
  tab. Keeping the pane alive for it, hidden, is a thing the browser could do;
  it does not yet.
- **A popup is a window, never a tab.** A tab is a pane, a pane is a process,
  and this window has to share one. So `window.open(url)` with no features,
  which Chrome makes a tab, is a window in the example browser, with an address
  bar a user cannot edit. A site that uses it for "open in a new tab" gets that
  window. It can be turned into a real tab by a page doing the honest thing,
  `noopener`.
- **A page's scripts in a popup share a thread with its opener**, as same-origin
  frames do. A popup that loops stops its opener, under the same timeout.

## The model: a window is a slot

Three things have to outlive a document:

- the proxy a page holds, through every document the window shows;
- the window's name, its opener and its `closed`;
- the opener link, through every document the _opener_ shows: a page that opens
  a report and navigates itself keeps the report open.

So a window is a `WindowSlot` (`src/html/scripts/popups.ts`): a number in a
`WindowGroup`, which is a browsing context group, holding the `ScriptRunner` of
the document it shows now. A document comes into its slot as its runner is made
(`adopt`), and every other window of the group is linked to it then. In each
realm a window is that number and a proxy over it (`src/html/scripts/windows.ts`):
the window's global where it is of this realm's origin, what crosses origins
where it is not, and what is left of a window where it has gone.

A slot is found again by what a window's documents share (`windowKey`): the
host's `session`, which is one object a tab, or a frame's element. A window that
never opened anything and was opened by nothing has no slot at all, so a page
that never calls `window.open` pays one boolean.

A frame can be an opener. A sign-in button in an iframe opens the popup, and
the popup posts to `window.opener`, which is the iframe. That is why a slot is a
window of any kind, and the group hangs off `DomShared`, the tree of nodes every
realm of a page shares.

### Another origin is a number

Being in one process is only safe if a realm never holds another origin's
global, or any object of that realm. The facade runs in the page's realm, so a
page can replace what it calls, down to `String` and `Map.prototype.get`: an
origin compared there can be made to come out the same, and an object kept there
can be read as the facade reads it. So nothing in the facade decides this.

`WindowSlot.adopt` and `ScriptEngine.link` ask the host whether two documents
are of one origin, and an opaque origin is no other's. Of one, each realm is
handed the other's global. Of two, each has the other by a number, and every
thing that crosses is an op on it: `closed`, `length`, `close`, `focus`, a
`location` set, and `postMessage` and a port's messages as strings the host
delivers by entering the other realm. The host says who a message is from and
holds it to the origin it is meant for, so `event.origin` and `targetOrigin` are
out of a page's hands. A window that goes between origins links or unlinks as
each document comes in, which is why the object a page holds can stand for it
through a login.

What reaches another document is refused on the host as well, whatever the
facade checked: a frame's document, its address and its element, and a node handed
between realms. And what an origin is read from cannot be moved by a page: a
document's history stays in its origin, a frame's origin is where it landed after
its redirects, and an `about:blank` is the only document that is of what made it.

### A window is born with a realm

`window.open` answers at once, and what it answers has a document. The page
may write it, listen on it or send it elsewhere before anything else happens,
so the initial `about:blank` is made inside the op that opened it: a `Document`
and a `ScriptRunner`, before React has heard of the window. The seams it runs
with are its opener's until the host mounts an `<Html>` for it, and that view's
after (`Popup.seams`), the shape a frame's document has (`bindFrame`).

The first document after it comes in as HTML's "initialize the document object"
has it: of the same origin, it **is** that window, so what a page put on it, a
handler or a property, is on the new realm (`__reuseWindow`). Each document's
realm is new here, where a browser reuses the object, so this copies the page's
expandos and its listeners across. `w.onload = f` set straight after
`window.open` depends on it.

### Writing into it

`w.document.write(...)` into a popup is the classic print window, and there is
no parser to write into: `<Html>` has not mounted. What is written is read back
at once, by parsing all of it into the document, and the scripts in it run at
`close()` or at the end of the task, once (`writeWindow`). A second `write` makes
new nodes, so an element a page took between two writes goes stale, which a
browser's parser would keep. Nobody found that to matter.

### Nodes across realms

A same-origin popup is a realm of its own, and a page moves its own nodes into
it: `w.document.body.appendChild(el)`. A node's id is its realm's, so an op in
the popup's realm was handed the opener's number for it and took some other
node, with no error. `idOf` in the facade now knows a node of another realm and
asks the host to hand it across (`__handOver`, `takeNode`). This fixed
same-origin frames as well, which had the same bug.

## What a window reference answers

| reached                 | same origin                       | another origin                                  | gone                 |
| ----------------------- | --------------------------------- | ----------------------------------------------- | -------------------- |
| any property            | the window's own                  | `SecurityError`                                 | `undefined`          |
| `closed`                | true from `close()`               | true from `close()`                             | true                 |
| `postMessage`           | delivered, source and origin kept | delivered, `targetOrigin` held to that window's | nothing              |
| `location` (read)       | its `Location`                    | a `Location` that throws on any read            | as another origin    |
| `location =`, `replace` | navigates                         | navigates                                       | nothing              |
| `close()`, `focus()`    | its own                           | through the host                                | nothing              |
| `opener`, `length`      | its own                           | through the host                                | null, 0              |
| `window`, `self`, `top` | this proxy                        | this proxy                                      | this proxy, top null |

**One object for a window.** `popup.opener === window` has to hold, and a proxy
is per realm, since a cross-origin check depends on who asks. So what reads as a
window through a proxy is translated to this realm's name for it (`seen`):
`G` for this window, this realm's proxy for any other.

`closed` is sync because every realm is told as `close()` is called
(`__windowClosing`), and the discard is a task of its own, as HTML's "close a
browsing context" has it: `closed` is true at once, and `opener` reads null only
after the window has gone.

## `noopener`, `noreferrer` and names

- **`noopener`** is a tab through `navigate(url, 'tab')`, and `window.open`
  answers null. It does not stop a name from finding what it names: WPT holds
  that `window.open(url, name, 'noopener')` sends the existing window there, and
  hands nothing back.
- **`noreferrer`** implies `noopener`, and `document.referrer` is empty.
- **A sandbox's window with no opener is no tab.** A document with flags to hand
  on, a sandbox with `allow-popups` and no `allow-popups-to-escape-sandbox`,
  opens a window that keeps them, and `navigate(url, 'tab')` carries nothing of
  who asked, so such a window goes to `popups.open` in a group of its own, its
  flags in its slot (`openApart`): `noopener`, `noreferrer`, a plain
  `target=_blank` and a form's, whether the user or a script followed it, and
  whether the document has a realm or not. With no `popups`, or where it says
  no, nothing opens. Handed to the tab, such a window was the page at its own
  origin with none of the sandbox's flags, which was COOP's first escape and was
  on master after it.
- **A link or a form** has an opener where its `target` is a name, and for
  `_blank` only with `rel=opener` (`linkOpener`). A plain `target=_blank` has
  none, and goes to the host's `onLink` as it did. A form's `target` carries its
  POST into the window (`HtmlPopup.post`, the third argument of `navigate`).
- **What a name finds**, in order: this window, `_parent`, `_top`, a frame of its
  document, then any window of its group, by `window.name`. Closing a window
  takes its name away at once. A name never reaches another tab: that is what a
  browsing context group means, and here it is a process as well.

## Blocking a popup

A popup needs a press or a key behind it, read from the realm's activation
(`hasTransientActivation`), and opening one spends it (`consumeActivation`), so
one press opens one window. With none, `window.open` answers null and
`popups.blocked` is told, which the example browser shows as a notice. A host
that has its own policy sets `popups.unblocked`, as the WPT runner does, since
wptrunner runs a browser with its blocker off.

A window's opener is told nothing of it: null is all HTML gives a page.

## The seam

Default: none. `window.open` answers null and hands the address on as a tab, as
it did; nothing opens by construction.

```ts
scripts: {
  popups: {
    open(popup) {
      setWindows((all) => [...all, popup]);
      return true;
    },
  },
}
```

The host shows a window by mounting `<Html>` for each of its documents, with
`scripts.popup` set to the `HtmlPopup` it was handed. The first is
`<Html source="" baseUrl="about:blank">`, which draws the document `window.open`
made. It loads `popup.url` as it would any navigation, so everything a top-level
document has, its session history, cookies and redirects, comes from where the
host keeps it, and `navigate` answers what the page does next. `popup.onClose`
says the page closed it, `popup.close()` says the user did, and `popup.onFocus`
is a script asking for it.

The seam is about **where a window is drawn**, and that is all it could be about,
because the realm has to exist before the host answers anything that matters.
Everything else is the same seams a tab uses, which is why a window is no more
work for a host than a tab.

## Service workers

A window with an opener is a client of whatever controls its address, as any
document is, and its `frameType` is `auxiliary`, by the HTML the window was
opened with rather than by whether it still has an opener: `opener = null` leaves
it auxiliary. It runs in its opener's process, so it shares that process's
`HtmlServiceWorkers` and the worker thread in it, and a worker controlling the
opener's origin hears what the popup asks for.

Its `about:blank` is under its opener's worker too. It has the origin of what made
it, so it is a secure context where that is, it has `navigator.serviceWorker`, and
a worker's `clients` lists it, by the origin it was given and not the one its
address says. It takes its controller from its opener's client, as a frame's local
document takes its parent's.

`clients.openWindow` goes to `navigate(url, 'tab')`, whichever client it is told
through: a worker has no window to be an opener, and a tab is what has none.

## `Cross-Origin-Opener-Policy`

A document says what it will share a browsing context group with
(`Cross-Origin-Opener-Policy`, HTML 7.1.3), and a window whose next document
disagrees with the one it shows leaves its group. The opener's reference reads
`closed`, the window's `opener` and `name` are empty, and nothing crosses between
them from then on. To the host it is the same window: `HtmlPopup` lives on, and
closes when the user or a page closes it.

### How a window leaves a group

**A window leaves by being a new one.** The slot it had is discarded to every
window of the group, as a closed window's is, and the window goes on in a slot of
a new `WindowGroup` over a new `DomShared` (`WindowSlot.arrives`).

This looked like the hard part, because a group and its tree are one to one and
everything finds a window through the tree: `adopt`, `slotById`, `find` and
`follow` all read `shared.windows`. It seemed a severed window had to go on over
the tree it was in while leaving the group that hangs off it, which would have
meant two groups on a tree and a question at each of those four. It does not. A
window leaves as a document comes in, and that document is parsed by a new
`<Html>` and has no node of the old tree. What a tree is shared for is realms
handing each other nodes, and a window that has just left has nobody to hand a
node to. So a new tree costs nothing, and all four are right as they were.

What had to change is the number. Each group counted its own, so a window that
left would come to share one with a window of its new group, and a host mounts its
windows by that number. Numbers are the process's now, and a realm can reach
nothing by one outside its group, since `slotById` asks only its own.

The document the window showed may outlive the leaving, for as long as the host
takes to let it go. Its slot says `severed`, and from then on its ops find no
window. It is told every other window has gone, as they are told it has.

### What decides it

The host, in the `ScriptRunner`'s constructor, before the document has a realm:
`WindowSlot.arrives` reads `scripts.headers` and `scripts.redirects`, holds them to
what the slot says the window shows (`active`), and answers the slot the document
comes into. A page cannot reach any of it, since the decision is made before it
has a line of script running. A host that hands in no headers is a host of no
policies, which is every host before this. `coop.ts` is the rules, and pure.

- **Each response is held to the one before it.** A redirect's policy counts,
  whatever the last response says, and once a response has taken the window out
  nothing puts it back. So `HtmlNetwork.document` follows a document's redirects
  itself where it did not already, jar or no jar, to read what each one said:
  `fetch` shows none of them.
- **The window's first document has a rule of its own.** It has the policy of the
  document that made it, if that is of its top-level document's origin. An opener
  of `same-origin-allow-popups` lets it go to a document with no policy, and that
  is the rule a popup login stands on: `same-origin-allow-popups` behaves as it did
  before any of this, through the provider's pages and home, unless the callback
  has a policy of its own, which a provider with none does not match. A browser
  ends that login too. `document.write` ends it being the first, as it does in
  HTML.
- **A frame's document says nothing.** Only a top-level document's response is
  read. What a frame opens is another matter: one of another origin than a page of
  `same-origin` opens windows with no opener, as tabs, and `window.open` answers it
  null. That is decided on the host too, in `open` and `follow`, and only for a new
  window, since a name still finds the window it names. HTML's text says the
  document's own policy here, which a frame has none of, and its note and WPT say
  the top's. A frame that has sandboxing flags to hand on opens a window here
  instead, in a group of its own: a tab carries no flags, so as a tab it would
  have left its sandbox.
- **Over no secure context a policy says nothing**, by the address of each
  response, so a window can go from `http:` to `https:` and be taken out there.

Two answers go by what browsers do rather than by HTML's text, and each is what
WPT holds:

- **A local document has its policy from who sent the window there.** HTML gives
  `about:blank` no policy and enforces none, and Chrome and Safari take the policy
  of the document that navigated, or of the top of its frames where it is of that
  origin, and hold the window to it. So `slot.initiator` notes who sent the window
  somewhere by a path the host cannot see, and a `blob:` document does the same.
- **A document's own `sandbox` is no refusal.** A response with a policy, where
  the window has sandboxing flags, is a network error: nothing of it runs or is
  drawn, since a document cannot be given a clean slate and be sandboxed at once.
  HTML's text counts the response's own `Content-Security-Policy: sandbox` among
  those flags, and Chrome and Safari do not: such a document loads, with an opaque
  origin, which is enough to take it from its opener.

### What it does not give

**A window that left is still in this process.** Its opener cannot reach it, and
that is what COOP says to a page. It says more to a browser, which puts the two in
processes of their own to keep Spectre from reading across, and here the two realms
share a thread, as every window with an opener does. So this is a reference cut,
not an isolation: `window.crossOriginIsolated` is false wherever it is asked, which
is HTML's "logical" cross-origin isolation mode, kept for a user agent that cannot
give the capability, and `SharedArrayBuffer` is not held to it.

**Nothing is reported.** `Cross-Origin-Opener-Policy-Report-Only` and `report-to`
are parsed past and do nothing: there is no Reporting API here to tell, and
`html/cross-origin-opener-policy/reporting/` stays where it was.

**`Cross-Origin-Embedder-Policy` only names a policy.** `same-origin` with one is
`same-origin-plus-COEP`, a policy `same-origin` alone does not match, which is all
it is read for: nothing enforces it on what the document loads.

**A window that left and goes back** comes back to a document of its own origin
with no opener, as in a browser. What the session kept of it is let go as it leaves
(`forgetKept`): it has a slot in the group the window left, which nothing can come
back to, so a browser's back-forward cache keeps it where this loads it again.

**A same-origin window sent to `about:blank` through its `location`** goes by what
it showed, not by who sent it: the setter runs in that window's realm, and nothing
there says which realm called it. `window.open(url, name)` and a window of another
origin do say.

### Scores

`html/cross-origin-opener-policy/`, against the same checkout and the same runner.
The runner had been dropping a test's own headers on its way to `<Html>`, and could
not load `about:blank`; both are fixed here, so what is below is the engine's.

| directory    | tests | subtests             | before | after |
| ------------ | ----- | -------------------- | ------ | ----- |
| all but this | 111   | 207 to 486 of 520    | 32.5%  | 85.7% |
| `reporting/` | 51    | no reporting to tell | 13.4%  | 13.4% |

Of the 111, 91 pass whole and none scored lower. Of the 20 that do not, none is a
decision of `coop.ts`:

- `javascript-url`, nine variants: a top-level `javascript:` URL makes no document
  of what it answers.
- `blob-popup` and `coep-blob-popup`: no host can load a `blob:` document, as
  nothing hands it the bytes.
- `coep-with-*`, three: each passes but for `crossOriginIsolated`, which is false
  here on purpose.
- `coop-navigated-popup`: a relative address set on another window's `location` is
  resolved against that window, where HTML resolves it against the page that set it.
- `coop-same-origin-allow-popups-document-write`: `<meta http-equiv=refresh>` does
  nothing.
- `header-parsing-failures?1-4`: the HTTP client refuses a response with a vertical
  tab in a header, so no popup loads to be asked.
- `coop-csp-sandbox-navigate`: a window that has gone answers `undefined` for
  `document`, where a browser keeps the object it last had.
- `coop-sandbox` and `coop-coep-sandbox`: three of four pass, and the frame with
  `sandbox` and COOP times out as it did before, which this did not look into.

## The example browser

A popup is a managed `<popup>`, a real window on X11, Cocoa and win32, in the
process of the tab that opened it (`examples/browser/popup-window.tsx`). In it is
a `Page`, the same component a tab's pane mounts, so a popup has the page's
keys, its menu, its downloads and its history. It has an address bar a user
cannot edit, as any browser's popup does, and it takes its size and place from
the features. The tab's page draws them, so a window a popup opened outlives the
popup.

## The WPT runner

`scripts/conformance/testharness.tsx` answers the seam: its `Tab` is the same
window it opened tabs in, given `scripts.popup` and laid out beside the test's at
the size the features ask for, and its `popups` is `unblocked`, as wptrunner's
is. Scores of the directories this reaches, against the same checkout and the
same runner:

| directory                                     | tests | before | after |
| --------------------------------------------- | ----- | ------ | ----- |
| `html/browsers/windows`                       | 57    | 14.3%  | 68.6% |
| `html/browsers/the-window-object`             | 104   | 28.8%  | 73.8% |
| `html/browsers/the-windowproxy-exotic-object` | 8     | 12.5%  | 32.8% |

No test scored lower. What is left there is mostly no popup's: named access on
the prototype, frames nested in frames, `document.domain`, and a window's
`WindowProxy` traps a `node:vm` global cannot be made to have.

## Left out

- **A window opened from a realm-less frame** opens as its page, where the page
  reaches in: such a frame has no script of its own to call it. A link a user
  follows in it is its own, and a sandbox's keeps its flags (`openFor`).
- **`moveTo`** on a popup, and `screenX` and `screenY`: a popup takes its
  place from its features and does not move after. `resizeTo` / `resizeBy`
  resize its content (and skip a view transition under way); the host hears
  them through `HtmlPopup.onResize`.
- **`document.write` into a popup after its first document.** It is the
  engine's general rule: only a script the parser met writes into its document.
- **A frame's own session across documents** is unchanged, and a window's first
  document is pushed as an entry where a browser replaces the initial
  `about:blank`, which no entry stands for either way.
