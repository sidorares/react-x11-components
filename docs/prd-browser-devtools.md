# Developer tools for the example browser

The example browser (`examples/browser/`) has developer tools: an Elements
panel and a Console, docked under a tab's page. They are made of react-x11's
widgets and this package's components, with no HTML drawn by `<Html>`.
They have two jobs. One is to show where `<Html>` gets a page wrong, from
inside the page. The other is to use the components here in an app the
size of a real one. This page records what was built, the choices that
shaped it, what using it found, and what comes next.

## What there is

- **Opening them.** A Develop menu, Safari's name for it, goes in the
  macOS menu bar or the desktop's panel, and is drawn over the tab strip
  everywhere else (core's `MenuBar`). It holds Developer Tools (⌥⌘I or
  Ctrl+Shift+I, and F12), JavaScript Console (⌥⌘J or Ctrl+Shift+J), Select
  an Element in the Page (⇧⌘C or Ctrl+Shift+C) and View Page Source.
  **Inspect**, at the end of the page's own context menu, opens them on
  the element under the pointer.
- **Elements.** The document as a `<Tree>`: tags, attributes and text in a
  browser's colours. An element whose only content is one short line of
  text shows it on its own row. Under the tree is a breadcrumb of the
  chosen element's ancestors. Pointing at a row draws the element's
  margin, border, padding and content over the page, with a caption. The
  picker does the same for the element under the pointer, and a press
  chooses it without the page hearing the press. Beside the tree is a
  sidebar with two tabs. **Styles** shows the `style` attribute and the
  computed style as a filterable `<Table>`, with a swatch beside each
  colour. **Layout** shows the box model diagram, the element's rect and
  offset, and the layout properties that apply to it.
- **Console.** It shows what the tab's pages logged, kept from the start
  of the tab's process, so tools opened later still show it. Repeated
  messages fold into one with a count. The prompt is a `<CodeEditor>` with
  JavaScript highlighting. Enter runs a line and Shift+Enter adds a new
  one. Up and Down step through the history. Input and results are
  highlighted with the same tokenizer as the prompt.

## The decisions

**The tools live in the page's process, not the browser's.** Each tab's
page runs in its own process, a `<Frame>` pane. The document lives there,
and `<Html>`'s handle answers a rect, a computed style or a line of
JavaScript synchronously. Tools in the browser's process would have to ask
every one of those over the pane's one-way messages. That is a remote
debugging protocol, which is a project of its own. In this design the
browser keeps only what its menu bar needs: whether a tab's tools are open,
and which panel it asked for last. The page tells the browser when its own
Inspect opens them or their close button shuts them. The cost is that a
page that wedges its process takes its tools with it. Real browsers avoid
that, and it is the main reason to revisit this choice.

**The console runs code through one seam, `HtmlHandle.evaluate`.**
`<Html scripts>` keeps a page's objects out of the host. Only primitives
cross the bridge. So evaluation is an engine entry (`__console`, in
`src/html/scripts/dom.ts`). It runs the typed code with the realm's
indirect `eval`, which is taken before any page code runs, so a page that
replaces `eval` does not change what the console runs. The entry then
writes the value out the way the page's `console.log` does and returns
the string. A thrown error's stack is cut at the line that was typed, so
the facade's and the host's frames never reach the console. With scripts
off, a page has no realm, and the prompt says so. It does not pretend to
evaluate.

**The panels load lazily.** `page.tsx` imports only the dock, the
highlight and the two stores (`devtools/dock.tsx`, `devtools/model.ts`).
The panels are a `React.lazy` import of `devtools/index.tsx`, so a tab
that never opens its tools never loads the tree, the table or the editor.

**The stores sit outside React state.** The page component holds every
document in the tab, so a re-render of it re-renders every `<Html>` in it.
The inspected element, the hovered element, the picker and the console's
messages are small subscribable stores (`Store`, `useStore`). Moving the
pointer over the tree re-renders the highlight and nothing else.

**The dock is a box of its own, not a `<SplitPane>`.** The page is always
the dock's first child. Opening the tools adds siblings after it, so each
`<Html>` keeps its node, its scripts and its scroll position. A
`<SplitPane>` that appears only while the tools are open would wrap the
page in a new pane, and React would remount every document in it.

**The Develop menu owns its chords.** A `MenuBar` binds its items'
shortcuts, and on macOS the system menu bar also runs them itself. So the
window's `onKeyDown` skips these commands (`DEVELOP` in `keys.ts`), or
they would run twice. The page still relays them on X11, since a key sent
straight to the page's window never reaches the bar's binding.

**The panels read the document again once a second while they show.**
Nothing tells the host that a page's script changed the DOM. Each second,
the tree reads its open branches again and the sidebar reads the element
again. Flattening only the open branches is cheap however large the
document is.

## What using it found

- **`<SplitPane>` sizes only its first pane.** A sidebar that should keep
  its width while the window grows has to work the first pane's size out
  from the container's width (`ElementsPanel`), and so would a dock.
  Letting the second pane hold the size would be a small core change.
- **A conditional pane re-parents the other.** See the dock above. A
  `<SplitPane>` that can collapse one side, keeping both children mounted,
  would cover the case.
- **A page can read the host's file paths from `error.stack`.** The engine
  runs a timer, a listener or a script through host frames, and V8 puts
  those frames, with absolute paths on the machine, into the stack of any
  error the page creates there. `new Error().stack` in a `setTimeout`
  callback shows `ScriptEngine.call (/Users/…/src/html/scripts/engine.ts…)`.
  The console cuts its own stacks, but a page's stacks are not cut. That
  belongs to the engine, not to the tools.
- **There are no matched rules.** The handle answers a computed style but
  not the rules that produced it, so Styles cannot show a browser's
  cascade view: which rule set what, and what it overrode. The cascade
  already has the matching rules for each element, so a
  `handle.matchedRules(el)` is the seam to add.

## Next

- A network log: the tab's `HtmlNetwork` already logs each request and
  its outcome (`BROWSER_DEBUG`). As a panel it needs a store like the
  console's, fed from the network's `log` seam.
- Storage: the profile's cookies, `localStorage`, `sessionStorage` and
  IndexedDB, read from the database every tab shares
  (`examples/browser/profile.ts`).
- Matched rules in Styles, through the seam above, and editing a value in
  place through `refresh(changes)`.
- Live DOM updates: a change notification from `<Html>` would replace the
  once-a-second read.
- The tools in a window of their own. That needs the remote protocol
  described above.
