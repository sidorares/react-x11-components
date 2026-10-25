# Scripts in the browser example

What it would take for `examples/browser/` to run a page's JavaScript
against a basic DOM: where the engine runs, what Node and Bun give a host
to sandbox it with, the seams `<Html>` would have to grow, and what core
would be asked for. The scope is deliberately small. It covers classic
scripts, a W3C DOM over the document `<Html>` already draws, events, timers
and form controls. It leaves out shadow DOM, modules, workers, canvas and
`document.write`.

Status: investigation, 2026-10-04; phase 0 built, 2026-10-07; phase 1
built, 2026-10-08, and core's pane options released in react-x11 2.46.0;
phase 2 under way (see "Phases"); promoted out of the example, 2026-10-15.
The engine is `src/html/scripts/`, turned on by `<Html scripts>` (see
"Promoted" below), and the browser runs it behind the toolbar's JS switch
and `BROWSER_SCRIPTS=1`. The probes it quotes ran on Node
26.0.0 and Bun 1.4.0 on macOS; they were scratch scripts and are not in the
repository.

## The answer, short

- **The engine is `node:vm`.** Each document gets one context, hardened as
  described below, in the page's own process (the tab's `<Frame>` pane). It
  behaves the same on Node and Bun, once three of Bun's differences are
  worked around (see "What building it found"). ShadowRealm would be the right boundary
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
when a second host wants them. (They were, to `src/html/scripts/` — see
"Promoted" below — as part of `<Html>` rather than a shared module of
their own, behind a `scripts` prop rather than a `ScriptEngine` seam.) That would be a shared module with a
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

### `node:vm`, and the five leaks a DOM binding has to close

A bare `vm.createContext({})` has none of the host's globals: no
`process`, `require`, `fetch`, `setTimeout` or `queueMicrotask`. That is
not the same as being a boundary. Five ways across were found, and every
one is the kind a DOM binding opens by accident:

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
5. **`import()`.** A dynamic import in code with no host loader is
   refused, and the probes stopped there. What it is refused with is the
   host's: `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` is a host-realm
   `TypeError`, so `import('x').catch((e) =>
e.constructor.constructor('return process')())` is the host's `process`,
   on Node and on Bun. Phase 1 shipped with it open (found 2026-10-08,
   building modules). The fix is a host callback,
   `importModuleDynamically`, on every script compiled into the context,
   the facade's own included — a page's `eval`, `new Function`, string
   timers and `on…` attributes all run from inside it and are found from
   it — and on the context itself, rejecting with the context's own
   `TypeError`. Node calls that callback only under
   `--experimental-vm-modules` and refuses with its own error otherwise,
   so without the flag nothing makes `import()` safe: the engine runs no
   script there (`SCRIPTS_CONTAINED`, keyed on `vm.SourceTextModule`,
   which the same flag makes), and the browser starts every pane, and its
   own process, with it. Bun honours the callback with no flag. Node 21 to
   23 honour it and still make the promise `import()` hands the page in
   the host's realm, whatever the callback answers, so
   `import('x').constructor.constructor('return process')()` was the
   host's `process` there: `SCRIPTS_CONTAINED` asks a throwaway context of
   that too (`importStaysInPage`), and a page runs no script on those
   versions.

With those closed, `this.constructor`, `document.constructor`, a caught
bridge error, `prepareStackTrace` and a refused `import()` all stayed
inside, on both runtimes.

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

## What building it found

- **A page's error names the host's frames.** What a page throws is
  captured with the whole stack, and below the context's frames are the
  engine's, with the host's file paths in them. That tells a page where
  the browser is installed and nothing more; filtering a stack is the
  follow-up, and the errors the host makes for a page already carry none
  (`_pageError`).
- **What a module throws is read only by the page.** A module's error, a
  failed link and a timeout reach the host from `evaluate()`, where an
  `instanceof`, a `.code` or a `String()` of a page's thrown proxy, or of
  an error whose prototype's `toString` the page replaced, runs the page's
  code with no timeout. The host tells its own errors apart by walking the
  prototype chain with `util.types.isProxy` at every link, and hands
  anything else to the page through a data slot (`__thrown`), to be read
  and reported under the timeout.
- **A failed `import()` reached the host** (leak 5 above). The escape test
  imported `fs` and checked only that it did not resolve; what the promise
  rejected with went unread. A test that reaches for `process` through
  whatever a refusal hands the page, from every way page code is compiled,
  is what holds it closed now.

Phase 1 was built after the probes above, and running a page in the whole
browser on both runtimes found what they had not:

- **Bun drops a `DONT_CONTEXTIFY` context's `var`s.** `var a = 5; typeof
a` answers `'undefined'` there, so a classic script's globals vanish and
  every script that shares one with the next breaks. A context over an
  object with no prototype keeps them, and closes leak 1 as well. The
  engine asks the runtime once (`createPageContext`) and takes that one
  where `DONT_CONTEXTIFY` loses the `var`, so it moves back the day Bun
  fixes it. Every escape above was checked again over it, on both.
- **Bun's context has a `console` no definition replaces.** It is an own
  property of the global, and a page reads it whatever is defined over it,
  but its methods can be set: the facade sets them.
- **An unhandled rejection in a context reaches `process`**, on both, and
  its default ends the process — the tab. A page's is told apart from the
  host's by its prototype, the context's `Promise.prototype`, read without
  running anything of the page's, and reported in the page; any other is
  thrown again (`engine.ts`). Listening is not enough in a pane: every
  listener hears every rejection, and core's pane registers one, before
  it loads the page's module, that ends the process at the first. So the
  engine takes over the listeners already there (`watchRejections`): a
  page's rejection is the page's, and any other goes to them. Before it,
  any page whose promise went uncaught closed its tab — x.com's refused
  `import()`, react.dev's Sandpack reaching for a frame's `location`.
- **The transpiler's `__name`.** tsx keeps a function's name by calling a
  `__name` helper defined at the module's top, so `toString()` of the
  facade calls a name the context does not have. The engine gives it one.
  Bun's transpiler calls none.
- **A timeout's error is the context's on Node**, so it is no `instanceof
Error` in the host, and the host's on Bun. Its `code` says which it is on
  both, and a page's own `try` cannot catch it.

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
| 9   | The sheets that hold a script back         | a script after a `<link>` reads `getComputedStyle` and layout as that sheet has them                         | **built**: `scriptsUnblocked(script?)` settles once the parser's sheets before a script are in — a link at its `load` or `error`, a `<style>` once its imports are — or all of them for a deferred script or a module                                                            |

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
through as the old one.

Phase 2 needs it to be _cheap_, and it is, where the host says what
changed. A refresh with no argument restyled every element, built every
box and laid out the whole document, and a page that animates with
`setInterval` and `el.style.left` paid that every tick. `refresh(changes)`
takes `MutationRecord`-shaped records (`HtmlChange`) and restyles what a
selector testing the change reaches. The cascade reads every selector once
for where it tests each class, id, attribute and what an element holds
(`MutationRules`). What only inks is restyled in place, as a hover is
(`_restyleInPlace`); a box out of the flow that moved goes through an
animation frame's build (`_rebuildFrame`); anything else is a build keeping
every other element's style, with `follow`. On a page of 600 cards on
X11, a class that colours one paragraph went from 106 ms to 3.5, an
absolute box's `left` from 66 to 38, a class that changes a card's font
size from 59 to 27 and a text from 66 to 21. What is left is layout, which
a build still does whole: the next step for the `left` case is moving an
out-of-flow box whose size does not depend on its offsets, in place, as a
transform is moved. Coalescing is the host's: one `refresh()` per task,
after the microtasks, never per op.

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

**9. Script-blocking sheets.** A browser holds a classic script it meets
until the style sheets the parser met before it are in (HTML, "has a style
sheet that is blocking scripts"), and a deferred script or a module until
all of them are, so a script after a head's `<link>` reads the document as
the sheet styles it. Run at `onParsed` instead, it ran while `<Html>` held
its first rendering for that sheet (`_renderBlocked`): no tree had been
built, and `getComputedStyle` and `getBoundingClientRect` answered nothing.
Found writing the theme switcher's test, whose read had to wait for a
callback. The handle's `scriptsUnblocked(script?)` is the seam, a promise
the runner waits on before each script the parser met. `<Html>` answers it
because it knows which sheets are in, which were read and what they import,
and which media hold. A sheet blocks while it is the parser's, is before
the script, and has its `media` holding: a `<link>` until its `load` or
`error` is told, after the restyle that applied it, and a `<style>` until
its `@import`s are in. So a link's `load` reaches the page before the
script it held runs, as in HTML. A sheet a script inserts holds nothing,
and nor does an `async` script's: the runner asks for no wait there.
`onParsed` keeps its moment. Holding it for the sheets would also hold a
head's theme script that comes before them. That script is written to run
before the first paint, and it still does.

## Promoted

Every application that wanted a document's scripts had to copy the
browser's wiring: the engine, the runner and its hook, the frames, a
network, a viewport read off a pane, a scroll told by hand. So the engine
moved to `src/html/scripts/` and `<Html scripts>` is the wiring, with a
default for every seam (docs/components/html.md, "Scripts"):

- **Off unless turned on.** `scripts={true}` or an object of overrides;
  absent, `<Html>` runs nothing, as it always has, and `onScript` is still
  there for an application with its own engine.
- **What is fetched stays the application's.** A script's source is asked
  for through `onResource` as `kind: 'script'`; a page's own requests go
  through `scripts.fetch`, and fail without one. `HtmlNetwork` and
  `useHtmlNetwork` are `network.ts`, moved from the example, as a policy an
  application hands in.
- **Lazy.** The engine is one chunk behind a dynamic `import()`
  (`scripts/runtime.ts`); what `<Html>` reports before it lands is kept and
  replayed in order (`scripts/hook.ts`).
- **The viewport is the pane around `<Html>`**, its zoom core's `scale`
  between them, and its `scroll` is noticed as the element paints
  (`onViewportScroll`), so a host scrolls nothing by hand.
- **Frames and workers are on**, each a flag away from off; a link or a
  form whose target names a frame loads it before `onLink` or `onSubmit`
  is asked.

The example keeps what is a browser's: its history, its tabs, its chords,
its User-Agent, and the documents it streams in.

## What the example adds

The record below is of the example as it was built; the files it names
are `src/html/scripts/` and `src/html/network.ts` now.

- **`examples/browser/script/`:**
  - `engine.ts`: the hardened context, the timed `Script` entries, the
    notice when one times out.
  - `host.ts`: `DomHost`, the ids, the ops and the dirty set.
  - `dom.ts`: the facade source.
  - `window.ts`: timers, `location`, `history`, `console`, storage, `fetch`.
- **`page.tsx` wiring:**
  - queue `onScript` per document;
  - run scripts in document order once the document is complete, each
    once the sheets before it are in;
  - route `onDomEvent` to `__dispatch`;
  - `refresh()` once per task.
- **`network.ts`:** a request method with a method, headers, a body and
  response headers. Today `Network.document` is the only method that can
  POST, and `load` and `resource` are GET with a fixed `Accept`. Phase 1
  `fetch` was same-origin; phase 2 applies CORS (`_fetchFor` in the
  host): a simple request to another origin is sent and its answer read
  where `Access-Control-Allow-Origin` lets the page, anything else is
  preflighted, a `credentials: 'include'` one needs the origin named and
  `Access-Control-Allow-Credentials`, and a page reads the safelisted and
  exposed headers alone. The cookie string is empty because there is no
  jar.
- **A switch.** `BROWSER_SCRIPTS=1` first, then a per-site toggle in the
  toolbar. Off by default: the browser's header promises that nothing a
  page contains runs, and the switch is what makes that a choice.

Two consequences of the "after parse, in order" rule for phase 1:

- **Every classic script runs as if it were `defer`**, after the parse and
  in order, and `async` scripts run in the same pass. What one waits for
  is still a parser-blocking script's: the style sheets before it, so a
  script ahead of a head's `<link>` runs while the sheet is on its way. A
  deferred script or a module waits for all of them.
- **`document.write` writes where the parser was**, from a script the
  parser met: what it writes goes into the document after the script, and
  after what it wrote before, as the parser would have read it there, and
  a script in it runs, as a parser's does. From anything else — an async
  script, a timer — it is ignored with a warning, as Chrome ignores one
  from an async script. A document of the page's own, a frame's among
  them, takes `open`, `write` and `close` whole: what is written between
  them is its markup at `close`, made a document's tree as HTML's parser
  makes one.

Pages written for parser-blocking scripts mostly still work, because what
they look up exists by the time they run. A page that writes markup as it
loads, as Acid3 writes its frames and its table, gets it where it wrote
it.

Since then the parse yields to the scripts that block it: a classic
script, inline or with a `src` that is neither `async` nor `defer`, runs
where the parser met it, sees nothing after it, and what it writes with
`document.write` goes into the input stream after it and is parsed there,
a script it writes included; an `async` script runs as soon as its source
is here. The rule above still holds for a frame's document, which the
page's realm parses whole. `docs/components/html.md`, "A script the parser
meets runs where it is", has the detail.

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

- custom elements (phase 3 — built, see below); shadow DOM came in phase 2;
- modules: `vm.SourceTextModule` needs a flag on Node (phase 2 — built);
- workers;
- `MutationObserver` (phase 2, from the same dirty set — built);
- `IntersectionObserver`, `ResizeObserver`;
- `XMLHttpRequest` (phase 2 — built, asynchronous only);
- WebSocket, canvas (IndexedDB came in phase 2 — see below).

Be honest about what that reaches. A framework-built application touches
hundreds of these, so phase 1 is for pages that enhance what they already
draw: menus, tabs, disclosure, form validation, a counter, the snippets in
a tutorial.

**Added in phase 2, from what thirty sites' scripts read as they load:**
the window's `name` and its kin, `crypto`, `TextEncoder` and
`TextDecoder`, `Image`, `Option` and `Audio`, `TreeWalker` and
`NodeIterator`, `DOMParser`, performance marks, `MessageChannel` and
`postMessage`, `Blob`, `File` and `FormData`, a structured clone, media
elements at rest, and CSSOM. A `<style>`'s sheet is its rules' text,
which the host keeps as the page edits it and writes back as the
element's text once a flush, so the rules styled-components and emotion
insert with `insertRule` are drawn; a sheet the page constructs and
adopts reaches `<Html>` as its `stylesheet`, after the document's own.
An interface that is not here is absent, never `undefined` under its
name: a page asks with `in`, and takes one that is there for one it can
use.

**And what the app router of Next.js hydrates with:** streams, and
`attachShadow`, through `<Html>`'s own, so a shadow tree a page attaches
is drawn as a declarative one is — its route announcer is one on every
page, and refreshing a document with one whole at every change was what
`refresh(changes)` had to stop doing first — and attribute nodes in a
live `NamedNodeMap`. Markup set as a `<script>`'s or a `<style>`'s
`innerHTML` is its text, as fragment parsing in that context makes it:
`next/script` sets an inline script's source so. And **IndexedDB**, in
memory for the document's life, as an empty profile has it each load:
stores, key paths and generators, indexes, cursors, key ranges, and
transactions that commit once a round leaves no request queued after the
microtasks its callbacks queued, which is where a promise wrapper's next
request comes from.

**And custom elements** (HTML 4.13), which GitHub starts its React apps
from: a `<react-app>`'s `connectedCallback` hydrates the page, and a
Primer page keeps its server-drawn content clipped away until a script
reveals it, so with no registry github.com/features drew its sub-nav and
nothing under it. `customElements` is the window's registry — `define`
checked as a browser checks it, `get`, `getName`, `whenDefined` and
`upgrade` — and a defined name's elements are upgraded in shadow-including
tree order: its constructor run over each, through `HTMLElement`'s own
(`[HTMLConstructor]`), which hands `super()` the element being upgraded, or
a new one for `new` and `createElement`. Customized built-ins are upgraded
from their `is`, and `attachInternals` answers a custom element's
`ElementInternals` once, its states a set and its form value kept, which no
form reads yet. Each element's state, definition and reaction queue are the
facade's, by its wrapper; what happens to it in the tree is the host's to
say, so once a name is defined the host notes each element of a defined
name put into the document, taken out, moved to another document, given
another attribute value, or copied into it, and the facade runs the
callbacks and the upgrades those come to after the op that made them,
before the DOM method returns, as `[CEReactions]` has it. Markup parsed
into an element is upgraded as it is connected, and a copy made into the
document at once — the difference `importNode` and `innerHTML` have in a
browser. `:defined` is `<Html>`'s and holds for an element a page upgraded,
and `querySelector`, `matches` and `closest` answer it, `:target`,
`:focus`, `:focus-within`, `:open`, `:valid` and `:invalid` as the
document stands, where css-select threw on every one.

Upgrading GitHub's `<tool-tip>` brought the first shadow tree of `:host()`
rules to most pages, and `refresh(changes)` restyled the whole document for
any change while a rule crossed a tree's edge: at 300 ms a restyle, React's
work loop ran past the timeout, was stopped half way, and never committed
again. A rule at an edge is read for what it tests now, each key reaching
across the edge below where it is tested (`MutationRules.noteEdge`).

That left three kinds of refresh of everything on
github.com/features/ai/github-app: a class change, since a Primer
`[class*=…]` sat in a `:has(~ …)`; anything coming or going, since a
`:has()` started at a sibling; and a `<link>` an attribute changed on or
put in for a chunk's CSS module before its sheet came. A `:has()` now
reaches the elements its compound finds around the change, an attribute
selector is asked of the old value and the new, and a sheet's element is a
change only where the sheets read otherwise. The page's adopted sheets
were the fourth: `<Html scripts>` made the `stylesheet` prop again at every
render, and the page was styled whole some sixty times a load.

**And a media element that is told to play**, which GitHub's hero is: its
React effect calls `play()` on the tab's video and `pause()` when its button
is pressed, and both did nothing, so the button's icon changed and the video
played on under it. A media element's state is the facade's, by its
wrapper — `paused`, `muted`, `volume`, `playbackRate` and where it was
sought to — and each change goes to the host as one op of primitives
(`mediaState`), which `<Html>` keeps for the element and hands to the
player it mounts over it as core's `<video>` props. The events are the ones
HTML fires as it is asked, in tasks of their own, and `play()`'s promise is
kept in its task or turned down by a `pause()` before it, as Chrome's is.
An `autoplay` video reads as playing until the page says otherwise. Nothing
comes back from the player yet: `currentTime` is where the page sought, and
an end or a press on `controls` is not told to the page — that is a channel
the other way, from core's `onPlay`, `onPause`, `onEnded` and
`onTimeUpdate`.

**And what Acid3 asks of the DOM**, which takes it to 96 of 100, the four
Chrome fails as well (22, 23, 25 and 35, where today's DOM and Selectors
standards moved from what Acid3 expected):

- **Live ranges** (`ranges.ts`): the host keeps each range's boundary
  points, and every insertion, removal and change of a text's data moves
  them as DOM 5 has it, a split text's too; extracting, cloning, deleting,
  inserting and surrounding are the standard's algorithms, step for step,
  and change the tree through the host, so they are recorded, observed and
  drawn as a page's own edits are. A **node iterator**'s place is the
  host's in the same way, moved off a node its own filter takes out, as
  Blink moves it.
- **DOM Core's rules**: DOM's insertion checks — one element in a
  document, a doctype before it, no text — every node's own document,
  adopted with what it holds as it moves between them, `createDocument`,
  `createDocumentType` and `XMLDocument`, elements in a namespace, with a
  prefix and a case of their own, doctypes' ids, `DOMException`'s legacy
  codes and the node constants on every node.
- **HTML's DOM**: a table's caption, head, foot, bodies, rows and cells,
  made and taken; a form's controls by name, wherever the form is; an
  option's `defaultSelected`; a submit button's click submitting its form;
  `initUIEvent`; `cssFloat`. And checkedness a script set is the box's:
  its `checked` attribute is its default from then on (HTML's dirty
  checkedness), kept beside the element, where `<Html>` keeps a box's state
  in the attribute itself.
- **Frames.** A same-origin frame is a document of its own: loaded as it
  goes into the document and again when its `src` changes — a new document
  each time — HTML parsed, XML parsed as XML with its namespaces, and one
  that is not well-formed the error and nothing of it, as Firefox shows it.
  Where the browser draws frames (`drawsFrames`), an HTML one is drawn over
  its box by an `<Html>` of its own, and one with a script in it runs in a
  realm of its own, linked to the page's: its `parent`, `top` and `frameElement`, the page's
  `contentWindow` and `contentDocument` for it, and `postMessage` both
  ways, each message with its `source`. That is how a page talks to a
  runner in a frame, as the react-x11 playground's does. A frame the page
  lays out no box for runs all the same, drawn nowhere, and keeps its realm
  once it has one. Elsewhere — an XML frame, a host that draws none — a
  frame's scripts run in the page's realm, with the frame's window and document
  for the names a script reaches them by, enough for a frame that tells
  its parent it loaded, as Acid3's do. A frame's style asked from the page
  is worked out with `<Html>`'s cascade for the frame's content box, so its
  media queries see the frame's size. What a realm's `MutationObserver`
  sees is what that realm changed: one a frame made does not see the page
  write into the frame's document.
- **A frame's window.** `contentWindow` is a WindowProxy: one for the
  frame, whatever it has gone on to, which is the window of the document
  it holds now, and there for another origin's frame too with only what
  crosses origins (`location` to send it, `postMessage`, its relations;
  the rest a `SecurityError`). Its `location` sends the frame elsewhere
  without its `src` saying so, as Sandpack sends its frame to the bundler.
  A frame with no realm of its own — its first `about:blank`, which a
  page reaches into as it makes it — has a window that holds the page's
  globals as they were before any page code ran: scripts take a "clean" `RegExp`,
  `JSON`, `fetch` or `Node.prototype` accessor from a hidden frame —
  Contentsquare's pure window, Sentry's unwrapped `fetch` — and get the
  page's own, unwrapped, which is what they wanted. What they get is the
  page's, so one that changes a prototype it took from a frame changes the
  page's; core-js's, which would, deletes from it only from a script it
  writes into the frame, and a written script does not run.
- **A target that names a frame sends the frame.** A link, a form or
  `window.open` goes where HTML's rules for choosing a navigable say
  (`navigableFor`, now `src/html/scripts/target.ts`): the keywords, else the
  first frame of that name, else a new tab. A form's POST goes with it,
  and to another origin's frame nothing is sent. Every submission but a
  `_blank` one used to go to the tab, so Facebook's pixel, which posts
  into a hidden frame its form names whenever `sendBeacon` declines, sent
  officeworks.com.au's tab to `facebook.com/tr/`.
- **What a page feature-detects or assigns is the IDL's.** react.dev's
  tutorial found three ways a facade that reads right still fails a page.
  `contentEditable` had a getter alone, and CodeMirror, as strict mode
  code, threw where it set one on every widget. `style.cssText` was the
  attribute as written, with no `;` after its last declaration, so
  CodeMirror's `cssText += "visibility: hidden"` lost both declarations;
  a block is serialized now, as CSSOM serializes one. And the facade had
  `IntersectionObserver` with no `IntersectionObserverEntry`, so Next.js
  installed the W3C polyfill, which measures every target again at every
  mutation of the document, a whole layout a time, and ran without end.
  The window's `[Replaceable]` attributes take what a page assigns, so a
  classic script's top-level `var length` holds its own value.
- **An editing host is typed in as a browser types in one.** A
  `contenteditable` element is a focusable area with a stop of its own,
  `getSelection()` is a real `Selection` over a live range the host keeps,
  and a key or a press no listener cancelled does what a browser's does
  (Input Events 2): a `beforeinput` the page may cancel, the text inserted
  or deleted at the selection, the caret moved after it, and an `input`;
  a press focuses the host and puts the caret at the letter under it. A
  `Range`'s `getClientRects` is where its letters are drawn, a rectangle a
  line, found through the text node each piece of the document's text came
  from (`BoxTree.textNodes`, `dom-text.ts`), and `caretPositionFromPoint`
  the other way. That is all CodeMirror 6 needs: it cancels the keys it
  has a command for, reads every other edit back from the DOM through its
  `MutationObserver`, and finds a position by measuring a letter's range
  at a time. The react-x11 playground's editor was a picture of one: its
  `getSelection()` had no range, and nothing a key did reached the DOM.
  Not yet: a paste or a cut (no `ClipboardEvent`), composition, a
  paragraph split into blocks (Enter is a line feed where white space keeps
  them and a `<br>` elsewhere), a caret drawn for a host whose page draws
  none, and the document's own drag selection, which is apart from the
  page's.
- **The pane's scroll is the page's `scroll`.** Once a frame, at the
  document, bubbling to the window. CodeMirror measures its lines when it
  comes into view, and an editor below the fold kept a 14px default line
  height in its gutter until something told it. Sandpack's editors on
  react.dev updated without end while the bundler they wait for was another
  origin's frame that nothing ran; it runs now (see below).

- **WebAssembly is compiled in the page's context, at once.** The context
  is made with wasm code generation on, and the facade replaces
  `WebAssembly.compile`, `instantiate` and both streaming forms before any
  page code runs. The runtime's asynchronous compile settles its promise
  from a task of the host's, in a context that runs its microtasks only
  when the engine enters it, so a page waited on it until its next timer;
  compiled in the promise, what waits runs before the entry ends. And
  Node's streaming compile is the host's: it takes only its own `Response`,
  and refuses anything else with an error of the host's realm, whose
  `constructor.constructor` is the host's `Function`. Node's timeout stops
  a module that runs away as it stops a script. Bun's does not, and there
  the pane's watchdog (react-x11 2.47.0) ends the tab after 15 seconds.
- **A response's body reaches the page as its bytes.** The browser hands
  the host the bytes as well as the decoded text (`FetchResponse.bytes`),
  and they cross as base64: `arrayBuffer()`, `blob()` and an `arraybuffer`
  XHR read them as they came, and `text()` decodes them as UTF-8, as Fetch
  has it, where every body was text decoded by its charset and a `.wasm`
  or a font came out of `arrayBuffer()` mangled.
- **A `<canvas>`'s pixels are the page realm's.** A 2d context draws on a
  bitmap the facade holds, so `getImageData` reads back what was put at
  once, and the rectangle a task changed goes to the host at its end
  (`canvasPut`), for `<Html>` to draw in the canvas's box as an image
  (`canvasImage`), in its place in the paint order. Pixels in and out,
  another canvas drawn where the transform keeps a rectangle one, and
  paths — the context's and `Path2D`'s, an SVG path's data included —
  filled, stroked, dashed and clipped to, with colours, gradients and
  patterns of a canvas, through every compositing operator and the
  separable blend modes (`raster.ts`), are drawn. A path is rasterized in
  the page's realm, since a host context reads its pixels back a round
  trip late: five lines through each row of pixels, a span's ends covered
  by the part of a pixel they reach. Text and an image are kept as state
  and drawn as nothing: a font's outlines and an image's pixels are the
  host's.
- **A resize observer is told each size its targets come to**: as one is
  observed, where it has a size, and again whenever its content box
  changes, looked at a tenth of a second apart while any observes, since
  nothing tells the page's realm a layout came out otherwise. Rive's React
  component sizes its canvas to its container, which has a size only once
  the stylesheet is in, and was told 0 by 0 for good.
- **A WebGL context answers and draws nothing** (`webgl.ts`, source text
  as `dom.ts` is). Every interface of WebGL 1 and 2 is the page's, with
  Chrome's constants; a context keeps the state a page sets and reads it
  back, a shader compiles and a program links with nothing active in it,
  a framebuffer is complete, a fence and a query are done at once,
  `readPixels` reads zeros and no extension is offered. A browser has
  WebGL wherever it has a canvas — Chrome draws it in software where
  there is no GPU — so a page is written for a context that is there:
  with none, up.com.au's react-three-fiber scene threw from its first
  commit and React took the whole page down, as Chrome does with WebGL
  turned off. The cost is a page that tests for WebGL and has a fallback,
  which shows the empty canvas rather than its picture.
- **A response may be made of a stream**, which its body methods read to
  the end, a `Uint8Array` a chunk. three.js's loaders hand a fetch's body
  on through one to count the download, and a body taken as its text was
  `[object Object]` — up.com.au's phone model with it.
- **The pointer's moves, the wheel and a secondary press are the
  page's.** `<Html>` tells `mousemove`, `wheel` and `contextmenu`
  (`onDomEvent`), and the facade dispatches a move as `pointermove` and
  `mousemove`, with the `over`, `out`, `enter` and `leave` of both where
  the pointer came onto another element. A cancelled `wheel` keeps the
  pane from scrolling. What the browser mounts over a canvas lets the
  pointer through to the element, so the playground's X server, which
  listens on its canvas, is pressed, and its window counts.
- **A press is a pointer's before it is a mouse's, and an element can
  take the pointer.** The facade dispatches a press as `pointerdown`
  then `mousedown` and a release as `pointerup` then `mouseup`, and keeps
  the buttons held from them, since a move's carry none on macOS. An
  element has `setPointerCapture`, `releasePointerCapture` and
  `hasPointerCapture` (Pointer Events 3, 10): while it holds the pointer
  its moves and its release go to it wherever the pointer is, with
  `gotpointercapture` and `lostpointercapture` as the capture changes
  hands, and the release lets it go. A cancelled `pointerdown` keeps the
  mouse's events back until the release, and the press's default with
  them, as Chrome has it. A slider's track that asked
  `hasPointerCapture` at every move threw a `TypeError` at every move
  before it.

- **A dedicated worker is a thread of its own.** `new Worker` starts a
  `worker_threads` thread (`workers.ts`, `worker-thread.ts`) with an engine
  and a host of its own over an empty document, and the same facade made a
  worker's global (`__becomeWorker`): no `window`, no `document`, no
  elements' interfaces, and `postMessage`, `close`, `importScripts`, a
  `WorkerGlobalScope` and its location. A message is serialized in the
  realm that posts it and made again in the one it is posted to, since a
  string is what crosses into a thread and into a realm. A worker's
  network is the page's, asked from the page process. `importScripts` is
  the one call that needs its answer before it returns: the thread asks
  on a port of its own and waits on a shared word (`Atomics.wait`) while
  the page process fetches, then reads the answer off the port
  (`receiveMessageOnPort`), so the thread blocks and the page does not.
  A worker is started from a URL of the page's origin, or from a blob URL
  this realm made (`URL.createObjectURL`), whose script is handed over —
  which is how Parcel starts one, and so Sandpack's bundler.
- **A frame of another origin runs at its own origin.** Where the browser
  draws frames, an HTML frame of another origin is fetched and drawn as a
  same-origin one is, in a realm of its own where it has a script, at its
  own origin. The two realms are linked, but each reaches the other only
  as a window of another origin: `postMessage`, with each message's
  `origin` and `source`, and `targetOrigin` held to the window it is
  posted to; `contentDocument` is null, `frameElement` null, and anything
  else a `SecurityError`. react.dev's Sandpack runs so: its bundler, in a
  frame of `sandpack-bundler-4bw.pages.dev`, compiles in its Babel worker
  and draws the example's preview.

**And what web-platform-tests' own tests take for granted**, found running
the Interop 2026 focus areas through `<Html scripts>`
(`scripts/conformance/interop.ts`):

- **A classic script is a script of its own.** The facade ran each through
  an indirect `eval`, whose declarations are the global's only where it is
  sloppy and they are `var`s and functions: a `'use strict'` script's
  stayed in the `eval`, and so did any script's top-level `let`, `const`
  and `class`, which the next script could not read. WPT's
  `computed-testcommon.js`, strict, defined nothing for the test that
  loaded it. The host compiles the script into the context as a
  `vm.Script` (`ScriptEngine.exec`), so it is evaluated as HTML evaluates
  one, its declarations the global environment's; what it throws, the
  timeout among them, goes to the page through `__thrown` as a module's
  does, and a script that does not parse is the page's `SyntaxError`.
  What it throws is reported once the microtasks it queued have run,
  since the runtime runs them as the script returns
  (`microtaskMode: 'afterEvaluate'`); HTML reports it first. A string
  timer still `eval`s, from inside the page's own call, where a nested
  `vm.Script` would run the page's microtasks before the caller goes on.
  A worker's `importScripts` takes that cost (`ScriptEngine.runNested`):
  its scripts are the worker's helpers, a strict one's declarations were
  lost in the `eval`, and every worker variant of WPT's IndexedDB tests
  failed on one; a worker imports first, with no microtask waiting. What
  an imported script throws is thrown on to its caller, through
  `__thrown`, unread.
- **An element is a global by its `id`** (HTML 7.2.2.3), and an `embed`,
  a `form`, an `img`, an `object` or a frame by its `name`: `target`, as
  WPT's tests that have a `#target` read it. A proxy is the next link of the
  global's chain, so every global, `var` and function shadows it, and is
  asked only for a name nothing above it has — which is every
  `typeof require` a bundle tests — so the host answers from an index of
  the document's names, walked again only once a tree has changed since
  (`DomHost._namesOf`).
- **JSPI is on where the runtime has it behind a flag.** Chrome and
  Firefox ship `WebAssembly.Suspending` and `WebAssembly.promising`; Node
  24's V8 has them behind `--experimental-wasm-jspi`, which the engine sets
  with `v8.setFlagsFromString` as it loads, before any page's context is
  made. It is a flag of the process's, and adds the two to every context
  made after it and nothing else. Bun's JavaScriptCore has neither.
- **A body is extracted once, as Fetch extracts it.** `Request`,
  `Response` and `fetch` read a body through one function
  (`extractBody`), so the three agree on its bytes and its implied
  `Content-Type`: a string's `text/plain;charset=UTF-8`, a form's
  multipart type and boundary, a `Blob`'s type, none for a buffer. A
  stream is read to its end before it is sent, and only where `duplex` is
  `'half'`. A `GET` with a body is a `TypeError`, as an abort is the
  signal's own reason. What crosses to the host is the body as text where
  its bytes are UTF-8 and as base64 where they are not
  (`FetchRequest.bytes`): a `Uint8Array` of `0xFF`s had been sent as its
  `String()`, `"255,255"`. A `blob:` URL answers a `Range` as Fetch's
  blob scheme does, a `data:` URL is answered in the page, and a headers
  object has the guard its owner gives it (Fetch 5.1): a request's drops
  what a page may not set, a `no-cors` one's all but the safelisted few,
  a network response's refuses every change.
- **A response is the page's at its headers.** The facade's `fetch` held
  its promise until the whole body was in, so a page reading a body that
  trickles — WPT's `long-wav.py`, two and a half megabytes at eight
  kilobytes a half second, and every chat UI that streams a model's reply
  — saw nothing until the end, and `HtmlNetwork`'s 30-second timeout ended
  it there. A request asks for its body as it arrives
  (`FetchRequest.stream`); the host settles the page's promise with the
  headers and hands each chunk to the body's stream (`__fetchChunk`,
  `__fetchEnd`, `_pump`), and a worker's crosses its port the same way.
  The timeout bounds the wait for the headers only.
- **A stream's body is sent once.** It has no source to be sent again
  from (Fetch 2.2.5), and the facade, which reads it to its end, had
  handed the host its bytes and no more: Node's `fetch` sent them again
  on a new connection when the server answered 421, as Fetch lets it for
  a body with a source, so WPT's `request-upload.h2.any` counted two
  requests where it wanted the 421 back. The facade marks such a body
  (`FetchRequest.streamedBody`, and not a `Request`'s bytes a page read
  as a stream, which still have theirs), and `HtmlNetwork` hands it to
  the runtime as a stream with its length, which neither Node nor Bun
  sends again — nor follows a redirect with, but a 303's.
- **A page's `load` waits for its frames'** (HTML's "completely loaded"
  holds the document's load event until every child navigable's has
  fired). The runner held `load` for the parse and the subresources only,
  so a test reading a frame's document in the page's `onload` found it at
  `about:blank`, and WPT's navigation tests navigated a frame that had not
  loaded yet: its `navigate('#')` resolved against the page and loaded the
  test page into the frame, which loaded it into its own frame, until the
  process ran out of memory. The host counts the frames it is loading
  (`framesLoading`) and the runner completes the page when the count
  reaches nothing; a frame resolves against its own URL; and a frame
  whose source is the page's own document, its fragment aside, loads
  nothing, as a browser refuses a frame nested in itself.

## Streams and WebTransport

**A page's streams are the standard's algorithms, in the page's realm**
(`streams.ts`, source text as `dom.ts` is). The first ones were enough for
Next.js's flight data and a fetch piped through a decoder: a queue that
counted chunks, a writer never held back, no reader that brought its own
buffer. WebTransport is written against all of it — a datagram writer's
`ready` that waits while `outgoingMaxBufferedDatagrams` are queued, a
receive stream read into the page's own buffer, a send stream errored by
the peer's STOP_SENDING — so the streams were written again, abstract
operation by abstract operation. Their slots are in a `WeakMap` by the
public object, so a page reads and tampers with none of them and an
interface's members brand-check `this`; the promise and array methods they
call are taken before any page code runs, so a page that replaces
`Promise.prototype.then` reaches into no pipe. WPT's `streams/` tests pass
but the tentative `owning` type's: one change against the reference
implementation is that `pipeTo` writes a chunk a microtask after it is
read, which `general-addition.any.js` holds it to, and waits for that
write when it shuts down.

**WebTransport is the facade's, and its network is a seam.** The facade
(`webtransport.ts`, source text) has the W3C API whole over those streams;
the host's half (`transports.ts`) is the `wt…` ops and the `__wt…` entries,
over `HtmlScripts.webTransport`, an `HtmlWebTransport` (`../transport.ts`).
A session and a stream are numbers, bytes are base64, an entry's input is
JSON, as everywhere on the bridge. A stream's bytes are pulled: the
receive stream's `pull` reads what the host has (`wtRead`, answered at
once from the seam's buffer), and waits for `__wtReadable` where there is
none, so a page that reads nothing leaves the bytes in the seam, which is
what gives the peer room to send more. A send stream's write settles when
the seam says the stream will take more. An abort reaches the sink
through its controller's signal, at once, so the write or close in flight
rejects with the reason, as the spec's pending operation does.

**The seam's default opens nothing** (`NO_WEBTRANSPORT`): `ready` rejects a
task later, as a browser's with no network does. `HtmlNetwork.webTransport`
opens real sessions over quico, an optional peer, loaded the first time a
page asks (`quico.ts`). The choice:

| Candidate                        | What it is                                                                      | Why not, or why                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:quic`                      | Node's QUIC over ngtcp2 and nghttp3                                             | Experimental, behind a flag, and in no release build: Node 24.22's `process.versions.ngtcp2` is empty and `node:quic` is no module. No WebTransport layer at all; Bun has none.                                                       |
| `@fails-components/webtransport` | A native addon over Google's libquiche, its binary downloaded as it installs    | A server checked by certificate hashes unless an experimental CA check is on, no `getStats()`, no `reliability`; a native build where no prebuilt binary fits. Bun's N-API is a second question.                                      |
| quico 0.7                        | QUIC, TLS 1.3 (lemon-tls), HTTP/3, QPACK and WebTransport, all of it JavaScript | **Chosen.** The browser's API whole — send groups and orders, datagrams, stats, protocols, CA or hash verification — on `node:dgram` and `node:crypto`, the same on Node and Bun; checked against WPT's aioquic server on both. 3 MB. |

quico takes no request headers on its CONNECT, and a browser's names its
`Origin` (a server may refuse one that does not: WPT's answers 403), so
`quico.ts` adds the page's origin and headers where quico sends it
(`_sendConnect`, through `_h3.sendHeaders`) — the one reach into quico's
insides, made only where both are there to wrap. Three of quico's
behaviours are not a browser's, and are adapted or left: a session the
server ends with no capsule resolves nothing in quico, so the adapter
reads quico's closing of the session's incoming streams for it; a
connection lost under a session resolves quico's `closed` with no code, so
the adapter tells it as a failure where no capsule came; a server's 2xx
other than 200 is refused, which the adapter cannot change.

**What becomes of a session is told, never asked.** The seam answers a
session at once and tells `ready`, `failed`, `closed`, `draining`, a
datagram and an incoming stream through the events it was handed, and a
stream its `readable`, `end`, `reset` and `stopSending`. That shape is
what a proxy across a worker's thread can carry, and what a fake server in
a test can drive (`test/fake-transport.ts`).

## What core would be asked

1. **Options for a pane's process.** `<Frame>` forks its child with the
   browser's own `execArgv`, and the `transport` factory is handed only
   `{ src, display }`. A custom transport has to find `frame/child.js` by
   path, because it is not on core's exports map. Two fixes would do:
   - an `execArgv` and `env` on `<Frame>` (or in the transport's options);
   - `react-x11/frame/child` on the exports map.

   That is how a page gets `--max-old-space-size`, the bound `node:vm`
   cannot give, and later Node's `--permission` flags, without the browser
   taking them too. **Done** in react-x11 2.46.0 (react-x11#923), and the
   browser starts every tab's pane with a heap bound (`PANE_FLAGS`).

2. **A watchdog.** Nothing in `<Frame>` notices a pane whose event loop is
   stuck. It stays `running`, keeps being sent updates it never reads,
   and on X11 swallows the browser's chords while the pointer is over it.
   `browser.tsx`'s header says a page that wedges its event loop "says so,
   and offers to reload". Today it does not. A timed-out script cannot
   wedge the pane, but the engine is not the only thing that can. What is
   wanted is a heartbeat and a `FrameError` phase for a pane that stopped
   answering. **Done** in react-x11 2.47.0 (react-x11#924): a pane is asked
   about once a second, and one that has not answered in 15 seconds fails
   with phase `'unresponsive'` and is ended, which the browser's `fallback`
   shows as it shows a page whose process died, with Reload.
3. **A frame clock a pane can reach.** `requestAnimationFrame` is on
   core's window (`NtkWindow.requestAnimationFrame`). In a pane, though,
   that window is made by core's child bridge, and a `DrawnNode` does not
   expose its window. What is wanted is a hook or a node method that asks
   for the next frame. Until then, rAF is a 16 ms timer, the clock
   `<Html>`'s own animations run on.

4. **A text field's caret and selection, read and set.** A `<textinput>`
   keeps its caret and its selection to itself (`_caret`, `_anchor`), and
   `setSelection`, a selection surface's, does not reach a field's own.
   So `input.select()` and `setSelectionRange()` set what a script reads
   back, and the widget neither shows it nor deletes it on Backspace, and
   `selectionStart` cannot say where a user's caret is. What is wanted is
   the DOM's shape on the node: `selectionStart`, `selectionEnd`,
   `selectionDirection` and `setSelectionRange()` (WPT's
   `user-select-none-on-input` stops there). **Asked** in react-x11#1006,
   with the DOM's names and its UTF-16 offsets. `<Html>` reads it at run
   time (`selectingField` in `widgets.ts`), so the widget shows a script's
   selection, the getters read the user's, and text the user selects is
   told as `select`, once a core with it is installed.

None of the four is needed for a first script to run. The first and the
second are what makes "a page costs its own tab" true for a page that
runs code.

## Threat model

The `vm` boundary decides what a page can _reach_: the ops the bridge
answers, and nothing of the host's. That boundary has been checked against
the escapes listed above on both runtimes. It is not a boundary against a
page that sets out to attack the machine. Node says so of `vm`, and the
leaks above are the reason. The process is the boundary against that, and
today it is a weak one:

- a pane's flags are a heap bound, and Node's `--permission` flags are
  still to come;
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
1. **Classic scripts, basic DOM** (built). Engine
   and facade in the example. In `<Html>`: `scripting`, `onDomEvent`,
   control values, focus, `onParsed`/`onLoaded`, and `computedStyle`, plus
   `activate`, `submitForm`, `reportValidity` and `resetForm` for a
   script's `el.click()` and a form's methods. In the example: `fetch`,
   the switch, and the timeout notice. Core: pane options, for the heap
   bound (react-x11 2.46.0).
2. **Cheap mutation and more of the web:**
   - scoped refresh from attribute and child-list records (built:
     `refresh(changes)`);
   - `MutationObserver`, `XMLHttpRequest` (built: the host records each
     change once, for `refresh` and for the observers watching it);
   - modules (`vm.SourceTextModule`) — built: `<script type="module">` in
     document order, its imports fetched through the browser's network and
     linked, one module a URL, `import.meta.url`, and `import()` from a
     classic script or a module. A `nomodule` script does not run. Bun 1.4
     hands a page's `import()` whatever the host answers, and a module
     answered whole was an object with none of its exports, so the engine
     answers with the module's namespace, which Node takes as well;
   - scripts held for the style sheets that block them, as a browser holds
     them (built: `scriptsUnblocked`);
   - the watchdog;
   - a worker per page for a hard stop and a heap bound, with the mirror
     `docs/prd-html.md` describes.
3. **The rest, each its own question:** canvas over core's context,
   shadow DOM (`<Html>` already draws declarative shadow trees), and
   custom elements (built: the registry, upgrades and reactions, and
   `:defined`).
