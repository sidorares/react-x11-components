# Developer tools for the example browser

The example browser (`examples/browser/`) has developer tools: Elements,
Console, Sources, Network and Storage panels, docked beside a tab's
page. They are made of react-x11's
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
  an Element in the Page (⇧⌘C or Ctrl+Shift+C), Dock Side and View Page
  Source. It also holds the browser's two settings for a page, which were
  buttons in the toolbar before: **JavaScript**, with Run Scripts on the
  site shown, Use the Default for This Site, and Run Scripts by Default;
  and **User Agent**, the presets as radio items.
  **Inspect**, at the end of the page's own context menu, opens them on
  the element under the pointer.
- **Docking.** The tools dock at the bottom, the right or the left. Three
  buttons at the end of their strip each draw a window with its panel on
  that side, and the side in use is lit. The Develop menu has the same
  choice under Dock Side. The side is the browser's and is kept in its
  preferences, so every tab's tools open where the last were put. The bar
  between the page and the tools resizes them, and each axis keeps its
  own size, so tools moved back to the bottom are as tall as they were.
- **Elements.** The document as a `<Tree>`: tags, attributes and text in a
  browser's colours. An element whose only content is one short line of
  text shows it on its own row. Under the tree is a breadcrumb of the
  chosen element's ancestors. Pointing at a row draws the element's
  margin, border, padding and content over the page, with a caption. The
  picker does the same for the element under the pointer, and a press
  chooses it without the page hearing the press. Beside the tree is a
  sidebar with four tabs, which moves under the tree when the panel is
  narrower than 620 pixels, as it is docked at a side. **Attributes**,
  first, lists the element's attributes: a click on a value edits it in
  place, a row shows copy and remove icons while the pointer is on it, and
  a row at the end adds one, its name and then its value completed. Where
  the element's only child is text, the text is under them in a field,
  applied when the field lets the focus go or on Ctrl+Enter. **Styles**
  starts with the element's own style, edited: each declaration a row
  with a box that switches it off and on — kept in the attribute as a
  comment while it is off — its name and value edited in place, a value of
  a few keywords a drop-down, and a value that is hard to write by hand
  given an editor under its row: a shadow's offsets, blur, spread, colour
  and inset; `flex`'s grow, shrink and basis; grid tracks, with a strip
  that draws their shares; a border's width, style and colour; a
  background's colour, image, position, size and repeat; and a colour
  picker for any colour. Under it are the rules that match the element,
  in the order they win, each declaration that loses to another struck
  through, with each rule's media, specificity and whether it is the user
  agent's. A rule from a sheet has a link on the right of its selector,
  `theme.css:42`, which opens Sources on it, as Chrome's does; Ctrl or Cmd
  and a click does the same on the selector, and on a declaration goes to
  that declaration. **Computed** is the computed style as a filterable `<Table>`,
  with a swatch beside each colour. **Layout** shows the box model
  diagram, the element's rect and offset, and the layout properties that
  apply to it.
- **Console.** It shows what the tab's pages logged, kept from the start
  of the tab's process, so tools opened later still show it. Repeated
  messages fold into one with a count. The prompt is a `<CodeEditor>` with
  JavaScript highlighting. Enter runs a line and Shift+Enter adds a new
  one. Up and Down step through the history. Input and results are
  highlighted with the same tokenizer as the prompt. A result that is an
  object or an array is a tree that opens a level at a time, each level
  read from the page's realm as it opens, a getter left unread. A line
  shows a copy icon while the pointer is on it.
- **Sources.** The page's scripts and style sheets in a tree by where
  they came from: an origin, its folders, and the page's own file, which
  holds what is written in it as `<script>` and `<style>` elements, each
  numbered in the order the page has it. A sheet no element in the
  document is — an `@import`ed one, a shadow tree's, one a page's script
  made — is listed with the rest. A file chosen is shown read-only
  in a `<CodeEditor>`, highlighted as JavaScript or as CSS, with its line
  numbers. A bar over it gives its address, its lines and its size, and a
  `{ }` button that sets it out a line at a time, on by itself where a
  line of the file is longer than 400 characters.
- **Network.** Every request the tab's network makes while the tools are
  open — a document, a stylesheet, a script, an image, a font, a page's
  fetch — in a `<Table>` with its status, type, size, time and a
  waterfall, filtered by its address or its type. A request chosen opens
  a pane beside the table: **Headers**, **Payload** with the query and the
  body sent, **Preview**, which draws an image, an SVG, JSON as a tree and
  an HTML response in an `<Html>` of its own with nothing it asks for
  fetched and no script run, **Response** as text, and **Timing**: the
  wait in the network's queue, the wait for the server, and the download.
  A request the cache answered says which cache.
- **Storage.** The page origin's local storage, session storage,
  IndexedDB databases and their stores, and cookies, in a tree. What the
  one chosen holds is a table, and the entry chosen is under it: a value
  of local or session storage edited in place, JSON drawn as a tree, an
  IndexedDB record decoded from the realm's encoding into the value it
  was. An entry is deleted, and a store or the site's cookies cleared,
  from the toolbar.

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

**The dock side is a row of buttons, not a menu item alone.** It is the
one setting of the tools that changes how the page is laid out, and it is
one press, so the strip shows it, in the same lit-when-on style as the
picker. Chrome keeps it in a kebab menu, and the Develop menu keeps it
too for whoever looks there. The page stays the dock's first child on
every side, and the left is a row the other way round, so a move remounts
no document.

**An attribute's value is completed from what it can mean here**
(`devtools/suggest.ts`). A class is offered only where some rule of the
page's would match the element with it: `HtmlHandle.namesThatStyle` reads
the classes each rule's subject asks for and matches the rule as though the
element carried the class, through an adapter of its own, so nothing the
cascade keeps is touched. A class whose rule needs an ancestor the element
lacks, or another tag, is left out, and a rule's `:hover` counts as a state
the element can be put in. An `id` is offered from the rules that would
style it and the ids other elements name that no element has. An attribute
that names elements by id offers those it may name: a label's `for` the
controls', `aria-labelledby` the elements with text, each with its tag and
text as a hint. `href` offers the document's fragments, `style` the
properties, and the rest what HTML and ARIA enumerate.

**An edit is the host's, not a script's.** It changes the attribute or the
text node where `<Html>` holds it and tells the handle what changed, so
only what a selector testing it reaches is styled again. A page's own
`MutationObserver`s do not hear it, and its custom elements' reactions do
not run; making the edit through the page's realm would, and is a step for
when the tools can name an element to it.

**The network tells, the tools keep.** `HtmlNetwork.observe` reports each
request from the network itself, not from the transport, because only the
network knows what a request is for and whether its cache answered it.
The tab's log subscribes while the tools are open, as a browser's tools
record only then, and keeps the bodies only so far: eight megabytes a
body, sixty-four in all, the oldest let go first. It tells the panel at
most ten times a second, since a busy page reports hundreds of chunks a
second.

**What the console came to stays in the page.** A result is described
across the bridge as a type, a line and an id, and the page's realm keeps
the object under the id, the newest five hundred, until the console is
cleared. Opening a level of the tree asks the realm for that level alone,
so nothing of the page's ever reaches the host, and a getter is never run
behind the reader's back.

**The matched rules are listed by `<Html>`, and which declaration loses
is worked out here.** The cascade knows the rules that match and their
order; which declaration a property's value came from would need the
cascade to record it as it applies them, so the tools work it out from
the order with a table of the shorthands' longhands. A shorthand the
table does not have is taken as its own longhand.

**The Develop menu owns its chords.** A `MenuBar` binds its items'
shortcuts, and on macOS the system menu bar also runs them itself. So the
window's `onKeyDown` skips these commands (`DEVELOP` in `keys.ts`), or
they would run twice. The page still relays them on X11, since a key sent
straight to the page's window never reaches the bar's binding.

**A rule knows where it was written, and the rest is worked out in the
tools.** `matchedRules` says a rule's sheet and the offset of its own
selector in the sheet's text, so `.b` in a list `.a, .b` is at `.b`, as
Chrome's link goes to the first selector that matched. The parser takes
comments out before it reads a sheet and reads each block as a string of
its own, so it carries where each started and puts the comments back. That
one number on a rule costs a page nothing it can measure: a 5.4 MB sheet of
180,000 rules parsed in 240 ms and 215 ms, where it took 253 and 198.
Everything else waits for a click. A line is found when a rule is listed
for a tool that asks, and a declaration's place is read off the text when
it is clicked, by its property and its value, of two alike the one that
reads the value: a parsed rule keeps no places of its declarations, and
keeping one on each would be paid for by every page for a thing the tools
do rarely.

**A jump lands in what the panel shows.** A rule's place counts in the text
the sheet was parsed from. What the panel shows of a sheet written in the
page has its margins taken off, and a minified one is set out a line at a
time, so a place goes through both (`shownRange`): the formatter is told
the offsets and says where they came to. A link names the line of the file
as written, so a minified sheet says `vendor.min.css:1`, as Chrome's does
until its file is pretty-printed, and lands on the rule however it is
shown. What was asked for is selected, its caret at its start and a third
of the way down the pane, once the editor has a height: the panel may only
be shown by the same click, and a place worked out in a hidden pane has
nothing to measure.

**A style sheet is shown as the document read it, not read again.** A
rule's offsets count in that text, and a file read from the network since
could say anything; an imported sheet has no element to read. The document
hands the text over with the sheet (`styleSheets`), so no request is made.

**A script is read from the tab's network, not fetched again.** The
network keeps what a page loaded, so the panel asks it for the file with
the page's address, and the cache answers; the server hears of it only
where the cache let the file go. The read is a request like any other,
so it is in the Network panel, answered from memory. A `<link>` the
document holds no sheet of, one that failed, is read the same way. What is
written in the page is the element's text as the document has it now, a script's
change to it included, which is why the panel reads it again each second
with the rest. The blank lines around it, and the indentation it has from
where it sits in the markup, are left out.

**Setting a minified file out is a formatter, not a parser.** It breaks
lines after `{`, `;` and `}`, indents by the braces, and keeps a string,
a template, a comment and a regular expression whole, telling a regular
expression from a division by what comes before it. A line the source
already broke stays broken, so a file that is set out already comes back
as it was. A source map is not read.

**CSS is a language of `code-language`'s.** No `@lezer/css` is
installed, so a style sheet would have had nothing to be highlighted
with. The stream mode follows where a line is — in a selector, in a
block's declarations, or in a value after its colon — and reads a run in
a block that reaches a `{` before a `;` as a nested rule's selector, as
CSS Nesting's parser does. It is a built-in like `javascript()`, so
`<Code>`, `<CodeEditor>` and `<Markdown>`'s fences have it too.

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
  callback showed `ScriptEngine.call (/Users/…/src/html/scripts/engine.ts…)`.
  The engine now leaves its own frames out of a page's stacks (#1117).
- **`<text>` draws no line through.** Core's text has no decorations, so
  a declaration that loses is struck through with a `<richtext>` run's
  `strike`, the one place this package draws one.
- **A rule at a shadow tree's edge is not listed.** `:host` and
  `::slotted()` rules are kept apart from the indexes under ids of their
  own, so `matchedRules` leaves them out rather than risk naming another
  rule.

## Next

- `console.log`'s objects as trees: the page's `log` seam hands over a
  line of text, and would have to hand over values the way `evaluate` does.
- Inherited styles in Styles, as a browser lists the rules of the
  element's ancestors that set an inherited property.
- Editing a matched rule's declarations, which means writing the page's
  style sheet rather than an attribute.
- The same link in the Computed tab, which needs the winning declaration
  of a property, and jumps from a `var()` or an `animation-name` to what it
  names, which Styles could find from the matched rules.
- Live DOM updates: a change notification from `<Html>` would replace the
  once-a-second read.
- Request headers as sent, the cookie included, from inside the network's
  redirect loop.
- Source maps in Sources, and a search across the files.
- Breakpoints, which need the engine to stop a page's script where it
  runs, through `node:inspector` or an instrumented copy of the source.
- The tools in a window of their own, which needs the remote protocol
  described above.
