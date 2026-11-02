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
origin's frame is a realm in the page's process, linked as another origin, and
kept to what crosses origins (`crossLinked`). It also answers the question
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

- **Cross-Origin-Opener-Policy.** A provider that sends `same-origin` severs the
  opener in a browser, and does not here. Login flows that work in a browser
  send `same-origin-allow-popups`, which this already behaves as.
- **`sandbox`'s `allow-popups`.** A frame's `sandbox` is read for what it
  supports and enforced nowhere, so a sandboxed frame opens a window.
- **A window opened from a realm-less frame** opens as its page: such a frame
  has no script of its own to call it, only the page reaching in.
- **`resizeTo` and `moveTo`** on a popup, and `screenX` and `screenY`: a popup
  takes its size and place from its features, and neither moves after.
- **`document.write` into a popup after its first document.** It is the
  engine's general rule: only a script the parser met writes into its document.
- **A frame's own session across documents** is unchanged, and a window's first
  document is pushed as an entry where a browser replaces the initial
  `about:blank`, which no entry stands for either way.
