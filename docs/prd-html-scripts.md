# Scripts in the browser example

What it would take for `examples/browser/` to run a page's JavaScript
against a basic DOM: where the engine runs, what Node and Bun give a host
to sandbox it with, the seams `<Html>` would have to grow, and what core
would be asked for. The scope is deliberately small. It covers classic
scripts, a W3C DOM over the document `<Html>` already draws, events, timers
and form controls. It leaves out shadow DOM, modules, workers, canvas and
`document.write`.

Status: investigation, 2026-10-04; phase 0 built, 2026-10-07, and phase
1's seams in `<Html>` (see "Phases"). The engine in the example is not
built yet. The probes it quotes ran on Node
26.0.0 and Bun 1.4.0 on macOS; they were scratch scripts and are not in the
repository.

## The answer, short

- **The engine is `node:vm`.** Each document gets one context, hardened as
  described below, in the page's own process (the tab's `<Frame>` pane). It
  behaves the same on Node and Bun. ShadowRealm would be the right boundary
  and is unusable today: it sits behind a flag on Node, and on Bun the
  realm carries the host's whole global, `process` included. Workers are
  phase 2.
- **There is one tree.** The DOM a script sees is `<Html>`'s domhandler tree.
  A facade evaluated _inside_ the context reaches it by node id over a
  bridge that carries only primitives. There is no mirror, which keeps
  `dom.ts`'s promise that "the DOM is the app's API".
- **`<Html>` still runs nothing.** It grows seams that any host driving
  the DOM needs, not only a script engine, and none of them evaluates
  anything. The main ones are:
  - an event hook that can cancel the default action;
  - control values;
  - focus;
  - a lifecycle;
  - a `scripting` flag;
  - correct `refresh()` after mutation.
- **Core is asked for three things, none of them for the engine:**
  - per-pane process options on `<Frame>`;
  - a liveness watchdog for panes;
  - a frame clock a pane can reach.

## Where the line falls

`<Html>`'s posture is that it fetches nothing and executes nothing, and
that this is a property of the design rather than a setting
(`src/html/index.ts`, the header; `docs/prd-html.md`, "The seams"). This
investigation keeps that posture. A script engine is a policy: which pages
may run, with what reach, for how long. A policy belongs to the host, the
same call `<Markdown>`'s `scope` makes about expressions (`docs/prd-mdx.md`).
What the component grows is seams that happen to be what a script host
needs, and are just as useful to an app that wires behaviour onto a
document with `domutils`:

- an event it can cancel;
- a control's live value;
- programmatic focus;
- "the document finished parsing".

The engine, the facade and the bridge go in the example first, as
`examples/browser/script/`. They would be promoted to `src/html-script/`
when a second host wants them. That would be a shared module with a
`ScriptEngine` seam shaped like `ProcessHost` and `PtyHost`, because "run
the page's scripts in a worker, in QuickJS, over a remote engine" is a real
thing to want. That is the promotion path AGENTS.md describes for
`src/internal/`, one level up.

Core gets nothing for the engine: `node:vm` is the runtime's. What core is
asked for is about the pane a page already runs in (see "What core would be
asked").

## The sandbox: what Node and Bun have

| Mechanism             | Node 26                                                                                    | Bun 1.4                                                    | What it gives                                                                         | What it does not                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `node:vm` context     | yes                                                                                        | yes, same behaviour in every probe below                   | own globals; a timeout per entry, microtasks included; `codeGeneration` switches      | a heap limit; a thread of its own; "not a security mechanism" (Node's docs)              |
| `ShadowRealm`         | `--experimental-shadow-realm`; a clean realm                                               | unflagged, **and the realm has `process`, `Bun`, `fetch`** | the callable boundary, enforced by the engine: only primitives and functions cross    | a timeout; anything at all on Bun, where the realm reads files                           |
| `worker_threads`      | separate isolate; `resourceLimits` enforced                                                | separate isolate; `resourceLimits` **not enforced**        | a hard stop (`terminate()` ends a `while (true)` in ~8 ms on both); a heap of its own | synchronous DOM access (needs `Atomics.wait`, and a mirrored tree); Node's API is inside |
| A process (pane)      | `--permission`: fs read/write, child process, worker, addons; `--allow-net` (experimental) | no permission model                                        | crash containment per tab, which the browser already has                              | a watchdog (none today); flags per pane (inherits the browser's `execArgv`)              |
| `vm.SourceTextModule` | `--experimental-vm-modules`                                                                | built in                                                   | ES modules in a context, for phase 2                                                  | —                                                                                        |

### `node:vm`, and the four leaks a DOM binding has to close

A bare `vm.createContext({})` has none of the host's globals: no
`process`, `require`, `fetch`, `setTimeout` or `queueMicrotask`. A dynamic
`import()` with no loader is refused (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`)
on both runtimes. That is not the same as being a boundary. Four ways
across were found, and every one is the kind a DOM binding opens by
accident:

1. **The sandbox object.** `this.constructor.constructor('return process')()`
   reaches the host on both runtimes. `createContext({})` makes the
   context's global forward to a host-realm `{}`, so the global's
   `constructor` is the host's `Object`. The fix is
   `vm.createContext(vm.constants.DONT_CONTEXTIFY)` (current Node, and
   Bun), which makes the global an ordinary object of the context's own.
   `Object.create(null)` closes it too, for an older Node.
2. **Any host object handed in.** A host function, its return value, or an
   `Error` it throws is host-realm, so its `constructor.constructor` is
   the host's `Function`. All three were confirmed on both runtimes. This
   is why the facade cannot be host-side objects passed in. It has to be
   built from the context's own classes, and the bridge must catch every
   host error and answer a primitive.
3. **Stack frames.** A context may set its own `Error.prepareStackTrace`,
   and the call sites it is handed answer `getFunction()`. On Node they
   answer `undefined` for strict code and the host function for sloppy
   code (`new Function`, sloppy CommonJS). On **Bun they also hand over
   the host's `runInContext` itself**, from strict code. The fix is to
   lock `Error.prepareStackTrace` (non-writable, non-configurable) in the
   context before any page code runs. With that in place, no call site
   reached a host function on either runtime.
4. **`caller`.** A context function called by a sloppy host function can
   read it through `listener.caller`, and get out. The rule is that host
   code that calls into the context is strict: ESM, which everything this
   package and the example emit already is. It also means calling page
   functions only through a `vm.Script`, never directly.

With those closed, `this.constructor`, `document.constructor`, a caught
bridge error, `prepareStackTrace` and `import()` all stayed inside, on both
runtimes.

**Timeouts cover what matters.** `runInContext(..., { timeout })` stops a
`while (true)` in the time asked for, on both runtimes. Calling a stored
handler through a precompiled `vm.Script('__dispatch(...)')` with a
timeout stops a runaway event listener as well. That is the shape every
entry from the host into the page must take. With `microtaskMode:
'afterEvaluate'` the timeout covers a promise loop too. The other side of
that mode is that a promise the host settles (a `fetch` response) runs its
callbacks only at the context's next evaluation. Every host-to-page entry
is a `Script` run, so this costs nothing, but a host that resolves a page
promise and returns will see nothing happen.

**Nothing bounds the heap.** `vm.measureMemory` can observe it, and
nothing can stop it. The process is the bound, which is the first thing
core is asked for below.

### ShadowRealm

On Node, behind `--experimental-shadow-realm`, the realm holds the
ECMAScript built-ins and a `console`, and nothing of the host's. Objects
cannot cross: passing one throws a `TypeError`, functions arrive wrapped,
and a wrapped host function's `constructor` is the realm's own. The
engine enforces, by construction, exactly the membrane the facade below
builds by discipline. It has no timeout, and it is experimental.

On Bun 1.4 `ShadowRealm` is unflagged, and the realm is a copy of Bun's
global: 158 own properties against Node's 98. It has the host's `process`
(same pid, the real `env`), `Bun`, `fetch`, and
`process.getBuiltinModule('fs')`, which read `/etc/hosts` from inside the
realm. It is not a boundary on Bun, and the facade should not be written
to need one. If Node unflags it and Bun's realm stops carrying the host
global, the facade can move into a realm unchanged, because its bridge
already speaks only primitives.

### Workers

A worker is the only built-in that stops a runaway page _hard_ and bounds
its heap. On Node, `resourceLimits: { maxOldGenerationSizeMb: 32 }` ended
an allocating worker with `ERR_WORKER_OUT_OF_MEMORY` in about 100 ms. Bun
does not enforce `resourceLimits`: the same worker was still running
after 8 s. The rest of the cost is the DOM:

- **The tree is in the other thread.** A worker would own a mirrored DOM
  and ship an operation log to the renderer. That is the isolated mode's
  mirror in `docs/prd-html.md`.
- **Reads are synchronous.** `getBoundingClientRect`, `offsetHeight` and
  `input.value` must answer _now_. `Atomics.wait` on a shared buffer while
  the main thread answers works: 132 µs a round trip on Node and 15 µs on
  Bun, so a page that reads layout in a loop of 1,000 waits 130 ms on Node.
- **Defaults are synchronous the other way.** `<Html>` has to know whether
  a click was cancelled before it follows the link. Either the main thread
  blocks on the worker's dispatch, or the default becomes "ask, then act"
  later. Off-main-thread DOM libraries make the second choice, and that
  breaks `preventDefault` on navigation.

A worker still has Node's API inside it, so the page would still run in a
`vm` context there. Workers are phase 2: the isolation is real, but phase 1
would pay for a mirror before there is anything to mirror.

### A process, and the permission model

Each tab's page is already a process (`<Frame>`), so a crash or a heap
blow-up costs one tab. Node's permission model was checked in a child.
Under `--permission --allow-fs-read=<dir>`:

- reading `/etc/hosts`, any write, `child_process` and `Worker` were all
  `ERR_ACCESS_DENIED`;
- a Unix socket connect — an X11 connection's shape — was denied without
  `--allow-net`;
- `--allow-net` lets it and `fetch` through, with an experimental warning.

Two things stop this being phase 1:

- **Panes cannot be given flags of their own.** A pane inherits the
  browser's `execArgv` (react-x11 `src/frame/index.js`, `forkTransport`).
- **The page process needs most of what the flags would take away.** It
  needs the network for its pages and the X socket, addons for the Cocoa
  backend, and reads under `node_modules`, plus the user's files for a
  `file:` page.

Bun has no permission model. Defence in depth is worth having later. It is
not the boundary.

### Not built in, for the record

- **`quickjs-emscripten`** is a real boundary on both runtimes: wasm,
  memory and interrupt limits, the same build on Node and Bun. The cost is
  speed and a second JavaScript engine's semantics.
- **`isolated-vm`** is a V8 isolate as a native addon, so Node only.
- **SES/Hardened JS** locks down a shared realm rather than separating one.
- **jsdom** runs page scripts through `node:vm` too, behind `runScripts:
'dangerously'`. The name is its own assessment.

None of these is needed for phase 1. The first is the answer if the
browser ever has to hold hostile pages.

## The shape: a facade in the context, the tree in the host

```
 page process (the tab's <Frame> pane)
 ┌───────────────────────────────────────────────────────────────────────┐
 │  vm context (DONT_CONTEXTIFY)          │  host                         │
 │                                        │                               │
 │  window, document, Element, Event,     │  DomHost: id ⇄ domhandler node│
 │  listeners, timers' callbacks          │  css-select, parseFragment,   │
 │      │                                 │  dom-serializer, <Html>'s CSS │
 │      └── bridge(op, a, b, c) ──────────┼─▶ parser; the dirty set       │
 │            primitives in, one out      │      │                        │
 │                                        │      ▼                        │
 │  __dispatch(id, type, …) ◀─ vm.Script ─┼─ <Html> onDomEvent,           │
 │     (timeout, drains microtasks)       │  timers, fetch responses      │
 │                                        │      │ refresh() per task     │
 │                                        │      ▼                        │
 │                                        │  <Html>: style, box, lay out  │
 └───────────────────────────────────────────────────────────────────────┘
```

**The facade is source text evaluated in the context.** It is one
self-contained function, `installDom(bridge)`. It closes over nothing, is
written in the example's TypeScript, and is handed to the context through
`Function.prototype.toString()`. So every object a page touches —
`document`, an `Element`, an `Event`, the listener lists — is the
context's, and leak 2 cannot happen by construction. The bridge is captured
in the facade's closure and is not on the global.

**The bridge carries primitives.** An op is a name and up to three
strings or numbers. A node is an id, and a list of nodes is a string of
ids. A host error comes back as a coded string that the facade rethrows as
its own `DOMException`. The host keeps `WeakMap<node, id>` and
`Map<id, node>`. The facade keeps one wrapper per id, so
`getElementById('a') === getElementById('a')`. A context lives as long as
one document and is dropped with it, so the id table needs no collector in
phase 1.

**The host does the heavy work, with what is already installed.**
Selectors are css-select over the live tree (`querySelector`, `matches`,
`closest`). `innerHTML` is `parseFragment` and dom-serializer. A `style`
property is `<Html>`'s own declaration parser, so a page and the cascade
agree on what `el.style.color = …` wrote. Geometry is the handle's.

**The spike.** It is about 300 lines: a facade with `Node`, `Element`,
`Document`, `EventTarget` and `Event`, `classList`, a `style` over the
attribute, `innerHTML`, `on*` attributes, and capture and bubble.

- It ran a page's inline script that builds list items, styles a heading
  and adds listeners. A host-side "click" then reached the listener with
  its coordinates and mutated the tree.
- A click on a link whose listener called `preventDefault()` came back
  `false` to the host, which is the cancelled navigation.
- A `for (;;)` listener timed out and left the page usable.
- The bridge costs about a microsecond a call:

  | 20,000 iterations                               | Node 26 | Bun 1.4 |
  | ----------------------------------------------- | ------- | ------- |
  | `getElementById` + `getAttribute`, facade       | 7.2 ms  | 9.3 ms  |
  | the same on domhandler directly                 | 5.5 ms  | 3.9 ms  |
  | `createElement` + `textContent` + `appendChild` | 23 ms   | 19 ms   |

  That is noise next to one `refresh()`, which is the number that matters
  (see "Refresh" below).

**The op set is phase 2's protocol.** The same `bridge(op, …)` calls are
what a worker would send over a channel, and what `docs/prd-html.md`'s
isolated mode calls the operation log. Phase 1 does not paint phase 2
into a corner: the facade stays the same, and the bridge either calls the
host or posts to it.

## The seams `<Html>` needs

In priority order. The first three are correctness and are worth doing
whether or not scripts land.

| #   | Seam                                       | Why a script host needs it                                                                                   | Today                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A script handed over whole, `src` resolved | the text it runs has to be the script                                                                        | **fixed**: a streaming `<script>` was handed over before its end tag, truncated, and never again; it now waits for its end tag. `src` is resolved against the document's base, as `onResource`'s and `onLink`'s URLs are                                                         |
| 2   | `refresh()` that sees every mutation       | a page changes classes and attributes, and `:has()` rules have to follow                                     | **fixed**: `:has()` matchers recompile once a tree changed; `PRAGMA_LANGUAGE` is found again then too, and `ATTRIBUTE_VARS` and the inline drawings (`SvgView` reads a root's `viewBox` and ids once) once an application says it changed one                                    |
| 3   | `scripting`                                | with scripts on, `<noscript>` is not drawn, and what is in it is not fetched                                 | **built**: the prop draws a `<noscript>` as nothing (a UA `!important` rule under `@media (scripting: enabled)`), keeps the scan out of it, and answers the media feature live                                                                                                   |
| 4   | `onDomEvent`, cancellable, before defaults | `click` → `preventDefault()` on a link, `submit` handlers, `input`/`change`, `keydown`, `focusin`/`focusout` | **built**, in `dom-events.ts`: the root's capture phase tells pointer and key events first, a widget tells its own click, a cancelled click puts a box back, and a submit is told before the entry list is built. Checkbox, select and button widgets tell no focus (a core ask) |
| 5   | A control's live value, read and written   | `input.value`, `textarea.value`, `value` versus `defaultValue`                                               | **built**: `controlValue` and `setControlValue` on the handle; a set value goes to the mounted field in place, and typing no longer writes `attribs.value`                                                                                                                       |
| 6   | `focus(el)`, `blur()`, `activeElement`     | `el.focus()`, `autofocus` on a drawn element, `document.activeElement`                                       | **built**: `focus`, `blur` and `activeElement` on the handle; `activeElement` is read from the window's focus, so it answers for every widget                                                                                                                                    |
| 7   | Geometry and style on demand               | `getBoundingClientRect` after a mutation, `elementFromPoint`, `getComputedStyle`                             | **built**: `elementRect` and `elementAtPoint` lay out first, and `computedStyle(el, pseudo?)` serializes the properties a script reads (`computed.ts`)                                                                                                                           |
| 8   | `onParsed`, `onLoaded`                     | `DOMContentLoaded`, `load`, `readyState`                                                                     | **built**: each once a document; `onLoaded` waits for the first complete layout, the store's pending requests and the faces loading                                                                                                                                              |

**1. Scripts handed over whole.** Done: `_sweep` skips a `<script>` the
parser still has open (`HtmlSource.isOpen`), so it is handed over at its
end tag, or at the end of the parse for one still open, and its `src` is
resolved against the document's base, as `onResource` and `onLink` see
absolute URLs. An empty `src` is handed over empty: it names no script, and
resolved it would be the page. Keep the element:
the host reads `async`, `defer`, `nomodule` and `type` off it. `onScript`
is called inside `applyProps` and inside `refresh()`, so a host must queue
the run rather than evaluate in the callback.

**2. Refresh.** Phase 1 needs `refresh()` to be _right_. The matchers are
done: one that keeps answers (`:has()`, `:contains()`) is compiled again,
when next asked, once a tree has changed (`compileSelector`, over
`treeGeneration`). That was a bug without scripts too: a streamed chunk
that brought an `<img>` in left `div:has(img)` answering as before. So
are the per-element caches. Two clocks drop them, by what can make each
stale. `treeGeneration` moves at every change to a tree, a stream's chunk
included: the document's pragma language is found again at it, since a
chunk may bring the `<meta>`. `mutationGeneration` moves only at
`HtmlSource.touch`, an application's `refresh()`: the `var()`s in a
shape's attributes and the inline drawings go at it. The parser sets no
attribute of an element it made before, and an inline drawing sees for
itself what a chunk added to it, so throwing them away at every chunk
would buy nothing. A drawing has to be made again rather than handed its
tree: `SvgView` reads a root's `viewBox` and the ids its `url()`s name as
it is handed the tree, so a `viewBox` changed and refreshed was drawn
through as the old one. Phase 2 needs it to be _cheap_. Today a refresh is a restyle of
every element, a box build and a whole-document layout (`touchDocument`,
`node.ts:4120`, to `Stale.Style`). A page that animates with `setInterval`
and `el.style.left` pays that every tick. The machinery for less is there:

- `_restyleInPlace` takes an attribute change that only inks;
- kept styles with a restyle set, and `follow`, take one that moves
  layout;
- `Cascade.crossed` is the worked example of building the restyle set from
  the rules a change can reach.

What is missing is a rule index keyed on the class, the id and the
attribute a rule tests. The host already has the input for it: the
facade's dirty set, split into attribute records and child-list records.
Coalescing is the host's in either phase: one `refresh()` per task, after
the microtasks, never per op.

**3. `scripting`.** One boolean prop. When it is true:

- `noscript { display: none }` joins the UA sheet;
- `@media (scripting: enabled)` matches;
- the scan does not look inside a `<noscript>`, so its images and sheets
  are not asked for;
- `inImpliedHead` stops keeping a head noscript's links.

HTML's parser also reads noscript's content as raw text when scripting is
on. With the content undrawn and unswept, that difference no longer shows.

**4. `onDomEvent`.** One synchronous callback, asked before every default
action `<Html>` performs. Returning `false` cancels the action:

```ts
interface HtmlDomEvent {
  type:
    | 'click' | 'mousedown' | 'mouseup' | 'dblclick'
    | 'keydown' | 'keyup'
    | 'input' | 'change' | 'submit' | 'reset'
    | 'focusin' | 'focusout' | 'toggle';
  target: Element;
  /** document coordinates, logical pixels: elementRect's space */
  x?: number; y?: number; button?: number;
  key?: string; code?: string;
  shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean;
  submitter?: Element | null;
}
onDomEvent?: (event: HtmlDomEvent) => boolean | void;
```

The order is the HTML spec's, and three places need care:

- **Submit.** Validation runs, then `submit` is asked, then the entry list
  is built. Today the list is built before `onSubmit`, so a handler that
  fills a hidden field would not be sent (`widgets.ts:163`).
- **Checkboxes and radios.** These change first, then `click` is asked,
  and a cancelled click puts the state back.
- **Keys** reach core's text widgets before the document. The seam needs
  the root to see a key in the capture phase, mapped from the widget node
  to its element, and able to keep the key from the widget. Whether core's
  capture phase can withhold a key from a `<textinput>` is untested.

**5. Values.** Add `controlValue(el)` and `setControlValue(el, v)` on the
handle. A write sets the typed text and remounts that one widget: widgets
are keyed by element and a reset generation, so a per-element generation
would do. `value` and `defaultValue` have to stop being one attribute for
`<input>`, which a script can tell apart.

**6. Focus.** Add `focus(el)` and `blur()` on the handle, through the
paths `useFocusStops` and `useForms` already have (`go`, `focusControl`).
Add `activeElement`, which needs core's checkbox, select and button
widgets to report focus as text fields do.

**7. Geometry and style.** `elementAtPoint` lays out first, as
`elementRect` does (done). The hover does not: it hit-tests the tree the
last frame drew (`_drawnAt`), because laid out first, every pointer move
between two frames on a page whose hover builds the boxes would build
them, where the restyles of all of them are one build at the frame. Core
asks the hover again after a frame that laid out (react-x11#793), which
brings it up to date. A `computedStyle(el, pseudo?)` accessor is needed, laid
out first and in CSS's units: the computed style holds device pixels. The
viewport and the scroll are the host's scroller's (`page.tsx`), and the
page's zoom multiplies every rectangle.

**8. Lifecycle.** `onParsed` fires once the parse has ended, which is when
phase 1 runs scripts. `onLoaded` fires once every request the document has
made has settled, counted after the first complete layout, since
backgrounds, fonts and `srcset` choices are asked for late. Without it,
the host has to approximate `load` from its own `onResource` count, which
is what the status bubble does now.

## What the example adds

- **`examples/browser/script/`:**
  - `engine.ts`: the hardened context, the timed `Script` entries, the
    notice when one times out.
  - `host.ts`: `DomHost`, the ids, the ops and the dirty set.
  - `dom.ts`: the facade source.
  - `window.ts`: timers, `location`, `history`, `console`, storage, `fetch`.
- **`page.tsx` wiring:**
  - queue `onScript` per document;
  - run scripts in document order once the document is complete;
  - route `onDomEvent` to `__dispatch`;
  - `refresh()` once per task.
- **`network.ts`:** a request method with a method, headers, a body and
  response headers. Today `Network.document` is the only method that can
  POST, and `load` and `resource` are GET with a fixed `Accept`. Phase 1
  `fetch` is same-origin, since there is no CORS to apply. The cookie
  string is empty because there is no jar.
- **A switch.** `BROWSER_SCRIPTS=1` first, then a per-site toggle in the
  toolbar. Off by default: the browser's header promises that nothing a
  page contains runs, and the switch is what makes that a choice.

Two consequences of the "after parse, in order" rule for phase 1:

- **Every classic script runs as if it were `defer`.** `async` scripts
  run in the same pass.
- **`document.write` is ignored, with a console warning**, as Chrome
  ignores one from an async script.

Pages written for parser-blocking scripts mostly still work, because what
they look up exists by the time they run. Pages that write their own
markup do not.

## The DOM in phase 1

**In:**

- `Node`, `Element`, `Text`, `Comment`, `Document`, `DocumentFragment`:
  - tree navigation, `textContent`, `innerHTML`, `outerHTML`;
  - `append`, `prepend`, `before`, `after`, `remove`, `replaceWith`;
  - `insertBefore`, `appendChild`, `removeChild`, `replaceChild`,
    `cloneNode`.
- Attributes, `id`, `className`, `classList`, `dataset`, `hidden`, and
  `style` over the attribute.
- `getElementById`, `getElementsByClassName`, `getElementsByTagName`,
  `querySelector(All)`, `matches`, `closest`.
- `EventTarget`, and the event classes `Event`, `MouseEvent`,
  `KeyboardEvent`, `InputEvent`, `FocusEvent`, `SubmitEvent` and
  `CustomEvent`. Also `on*` attributes and properties, and
  `click()`/`focus()`/`blur()`.
- Form controls: `value`, `checked`, `disabled`, `form`, `elements`,
  `submit()`, `requestSubmit()`, `reset()`.
- `getBoundingClientRect`, `offset*` and `client*` (a subset),
  `scrollIntoView`.
- `window`:
  - timers: `setTimeout` and `setInterval` and their clears,
    `requestAnimationFrame`, `queueMicrotask`;
  - `console`, `location` (a read, and `assign`/`replace`/`reload` through
    `onLink`), `history.back`/`forward`;
  - `navigator.userAgent`/`language`, `innerWidth`/`innerHeight`,
    `scrollX`/`scrollY`/`scrollTo`;
  - `getComputedStyle` (a subset), `matchMedia`, `fetch`;
  - `localStorage` and `sessionStorage`, in memory, per origin, per
    process;
  - `document.title`, `readyState`, `currentScript`, `cookie` (empty).
- `DOMContentLoaded` and `load`.

**Out:**

- shadow DOM and custom elements;
- modules: `vm.SourceTextModule` needs a flag on Node;
- workers;
- `MutationObserver` (phase 2, from the same dirty set);
- `IntersectionObserver`, `ResizeObserver`;
- `XMLHttpRequest` (phase 2);
- WebSocket, IndexedDB, canvas, `document.write`.

Be honest about what that reaches. A framework-built application touches
hundreds of these, so phase 1 is for pages that enhance what they already
draw: menus, tabs, disclosure, form validation, a counter, the snippets in
a tutorial.

## What core would be asked

1. **Options for a pane's process.** `<Frame>` forks its child with the
   browser's own `execArgv`, and the `transport` factory is handed only
   `{ src, display }`. A custom transport has to find `frame/child.js` by
   path, because it is not on core's exports map. Two fixes would do:
   - an `execArgv` and `env` on `<Frame>` (or in the transport's options);
   - `react-x11/frame/child` on the exports map.

   That is how a page gets `--max-old-space-size`, the bound `node:vm`
   cannot give, and later Node's `--permission` flags, without the browser
   taking them too.

2. **A watchdog.** Nothing in `<Frame>` notices a pane whose event loop is
   stuck. It stays `running`, keeps being sent updates it never reads,
   and on X11 swallows the browser's chords while the pointer is over it.
   `browser.tsx`'s header says a page that wedges its event loop "says so,
   and offers to reload". Today it does not. A timed-out script cannot
   wedge the pane, but the engine is not the only thing that can. What is
   wanted is a heartbeat and a `FrameError` phase for a pane that stopped
   answering. Until then, the header should say what is true.
3. **A frame clock a pane can reach.** `requestAnimationFrame` is on
   core's window (`NtkWindow.requestAnimationFrame`). In a pane, though,
   that window is made by core's child bridge, and a `DrawnNode` does not
   expose its window. What is wanted is a hook or a node method that asks
   for the next frame. Until then, rAF is a 16 ms timer, the clock
   `<Html>`'s own animations run on.

None of the three is needed for a first script to run. The first and the
second are what makes "a page costs its own tab" true for a page that
runs code.

## Threat model

The `vm` boundary decides what a page can _reach_: the ops the bridge
answers, and nothing of the host's. That boundary has been checked against
the escapes listed above on both runtimes. It is not a boundary against a
page that sets out to attack the machine. Node says so of `vm`, and the
leaks above are the reason. The process is the boundary against that, and
today it is a weak one:

- a pane has no flags of its own;
- under `BROWSER_INLINE=1`, and wherever no pane can be shown, every tab
  shares the browser's process;
- Bun has no permission model.

So scripts are off by default, and the example says what turning them on
means. A browser meant for hostile pages would run them in QuickJS, or in
a worker in a pane started with `--permission`. The op set is written so
that either is a change to the bridge and not to the facade.

## Phases

0. **Seams that are correctness anyway** (done):
   - scripts handed over whole, with `src` resolved;
   - `refresh()` with no stale caches: `:has()`, the pragma language, a
     shape's attribute `var()`s and the inline drawings;
   - `elementAtPoint` laying out first.
1. **Classic scripts, basic DOM.** Engine and facade in the example. In
   `<Html>` (built): `scripting`, `onDomEvent`, control values, focus,
   `onParsed`/`onLoaded`, and `computedStyle`, plus `activate`,
   `submitForm`, `reportValidity` and `resetForm` for a script's
   `el.click()` and a form's methods. In the example: `fetch`, the
   switch, and the timeout notice. Core: pane options (for the heap
   bound).
2. **Cheap mutation and more of the web:**
   - scoped refresh from attribute and child-list records;
   - `MutationObserver`, `XMLHttpRequest`;
   - modules (`vm.SourceTextModule`);
   - the watchdog;
   - a worker per page for a hard stop and a heap bound, with the mirror
     `docs/prd-html.md` describes.
3. **The rest, each its own question:** canvas over core's context,
   shadow DOM (`<Html>` already draws declarative shadow trees), and
   custom elements.
