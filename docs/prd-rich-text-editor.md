# A rich text editor

**Status: implemented** — `src/rich-text-editor/`,
[the reference](components/rich-text-editor.md). This is the design record:
what else was looked at, what the component is for, why the model is
ProseMirror's and the view is this package's, and what a plugin written for
a browser can and cannot expect of it.

## What it is for

The use cases decided the shape, so they come first. Each needs one more rung
of the API than the one above it.

| Use case                                   | What it needs                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| A notes app that keeps markdown files      | Markdown in and out, a toolbar, undo, the clipboard. Never ProseMirror.                    |
| A comment box, an issue tracker's field    | The same, a placeholder, `readOnly` for display, a height that follows the text.           |
| A chat composer                            | Enter sends and Shift+Enter breaks the line; grows to a height, then scrolls; no toolbar.  |
| A mail or CMS field                        | HTML in and out, and a paste from a web page or a word processor that keeps its structure. |
| A knowledge base with blocks of its own    | Custom node types drawn as components — a callout, an embed — and looks per mark.          |
| An app with an editor platform of its own  | ProseMirror plugins, schemas and commands, as written for the browser.                     |
| Collaborative editing, history, versioning | The app owns the `EditorState` and sees every transaction.                                 |

Two things all of them share, which is why this is one component rather
than several: a document with structure (lists, quotes, code, tables), and
the editing conventions of the desktop it runs on.

## Prior art

| Editor                                    | Model                                                              | View                                | What was taken, or why not                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **ProseMirror**                           | Schema-checked tree; integer positions; invertible, mappable steps | `EditorView` over `contenteditable` | **The model, wholesale.** Everything but the view runs without a DOM, and its plugins are data and functions.                |
| **TipTap**                                | ProseMirror, plus an extension layer                               | ProseMirror's                       | The handle's vocabulary: `isActive`, `can`, `insertContent`, `updateAttributes` for node views. Its node names are read.     |
| **Remirror**, **Milkdown**, **BlockNote** | ProseMirror, wrapped                                               | ProseMirror's                       | Evidence that ProseMirror is the model an ecosystem forms around. Milkdown's markdown-first stance matches the default here. |
| **Lexical**                               | Keyed node classes; immutable editor state                         | Its own DOM reconciler              | Stable node keys — this editor's block keys are the same idea. Its plugins are React components over the DOM.                |
| **Slate** (and **Plate**)                 | Schema-less nested JSON; operations                                | slate-react over the DOM            | Rendering as a function of node type (`renderElement`) — `nodeViews` here. No schema means no validated document.            |
| **Quill**                                 | Delta, a flat op list                                              | Parchment blots in the DOM          | The toolbar as a declarative list of names. A flat model cannot say a list inside a quote.                                   |
| **Draft.js**                              | Blocks and entities                                                | React DOM                           | Archived by its authors; nothing taken.                                                                                      |
| **CKEditor 5**                            | Its own model, view and conversion                                 | Its own DOM layer                   | The bar for pasting from Word and Google Docs. GPL or commercial — not a dependency an MIT package can take.                 |
| **Editor.js**                             | A list of JSON blocks, each a tool                                 | One DOM island per block            | Blocks are not a document: no selection across them.                                                                         |
| **MDXEditor**                             | Lexical, with mdast in and out                                     | Lexical's                           | Confirms markdown as the value people want from a WYSIWYG field.                                                             |
| **Typora**, **Obsidian**                  | Markdown source                                                    | Source with the markup hidden       | The markdown shortcuts. Editing the source itself was rejected: lists and tables are harder, not easier, that way.           |
| **Qt** `QTextDocument`                    | Blocks, fragments, frames, lists, tables                           | `QTextEdit`                         | The desktop's conventions, and the evidence: a native toolkit's editor reads and writes HTML and, since 5.14, markdown.      |
| **GTK** `GtkTextBuffer`                   | Text with tags, marks and iterators                                | `GtkTextView`                       | Marks — positions that survive edits — are what the block keys are for blocks. No structure beyond styled runs.              |
| **AppKit** `NSTextView`                   | An attributed string, paragraph styles, text lists                 | TextKit                             | The macOS conventions: Alt for words, Cmd for lines, one text for VoiceOver.                                                 |

## Why ProseMirror's model, and nothing else of it

`<CodeEditor>` wrote its own model, and for code that was right: code is
lines of text. A rich document is a tree whose validity is a question — can a
list hold a table, can a heading hold an image — and whose edits have to map
positions (for undo, for collaboration, for a decoration that must follow
text as it moves). ProseMirror is a decade of answers to exactly that:
`prosemirror-model` validates against a schema, `-transform` makes every edit
an invertible, mappable step, `-state` makes the editor's state one immutable
value with plugin state inside it, and `-commands`, `-history`, `-keymap`,
`-inputrules` and `-schema-list` are the editing behaviour people expect,
already argued over. **None of those modules touches a DOM.**

The one that does is `prosemirror-view`, and it is the part this package
would have to replace under any library: a view over `contenteditable` is a
view over a browser. So the design is to keep everything else and write the
view — shaped like `EditorView`, so the ecosystem's code, which is written
against that shape, has somewhere to land.

The alternatives fail on that same question. Lexical's and Slate's models can
run headless, but their plugins are React components rendering DOM, so their
ecosystems do not come along. Quill's modules are DOM modules. CKEditor's
licence rules it out before its architecture does.

## The ladder

One element, and each rung is an opt-in on top of the one below — never a
second API that has to be migrated to (the continuity rule `<Table>`'s PRD
set):

```tsx
// 1. markdown in and out
<RichTextEditor value={body} onChange={(ev) => setBody(ev.value)} />

// 2. the behaviours an app would otherwise wire by hand
<RichTextEditor toolbar placeholder="Reply…" submitOnEnter onSubmit={send} suggestions={[mentions]} />

// 3. what the document is written in, and how its parts look
<RichTextEditor format="html" markStyles={{ code: { bg: '#eef' } }} nodeViews={{ image: Figure }} />

// 4. ProseMirror's own seams
<RichTextEditor plugins={[mentions, spellcheck]} editorProps={{ handlePaste }} schema={mySchema} />

// 5. the app owns the EditorState
<RichTextEditor state={state} dispatchTransaction={(tr) => setState((s) => s.apply(tr))} />
```

The contract that makes it a ladder: **what a rung adds, the rung above it
keeps.** A `state`-owning app still gets the toolbar, the looks and the node
views; a plugin passed at rung 4 still sees the value flow of rung 1; the
handle (`ref`) is the same object at every rung.

## How it is built

**The view** (`view.ts`) is `RichEditorView`. It holds the `EditorState`,
dispatches, runs `someProp` in ProseMirror's order, keeps plugin views, and
answers the geometry questions (`posAtCoords`, `coordsAtPos`,
`endOfTextblock`) from the laid-out text. It turns react-x11's keys, presses,
composition and focus into what a browser's `contenteditable` would have done
— after offering each to the plugins' props first.

**Rendering** (`render.ts`) is composition, by the rule AGENTS.md sets: the
viewport scrolls rather than transforms, and a document's block flow is what
flexbox already lays out, the way `<Markdown>` draws the same content. A
block is a memoized component keyed by node identity; ProseMirror shares
every node an edit did not touch, so typing re-renders one paragraph and the
containers above it.

**Each textblock is a retained element**, `<richeditortext>`: `<richtext>`
plus a selection band and a caret that the view sets directly. A caret that
blinks twice a second and a drag that extends sixty times a second never
re-render anything.

**Block keys** (`keys.ts`) are what a block is known by. Positions move on
every keystroke before them, so a block never receives one: its key is
mapped through each transaction's steps, and it asks the view for its
position when it needs it — which is what makes `getPos()` a function in a
node view.

**`InlineMap`** (`inline.ts`) is the bridge between ProseMirror's positions
(UTF-16 units, an inline leaf counting one) and what `<richtext>` draws (code
points, an image as its alt text, a hard break as a line feed, widgets with
no document width, the space an empty block is drawn with). It is total and
monotonic in both directions and pure — the same role `<CodeEditor>`'s tab
map plays, and the part to get right once.

**The clipboard** (`clipboard.ts`) is prosemirror-view's own copy and paste,
ported: `data-pm-slice` on the way out, the context-aware parse on the way
in, and every clipboard prop in the same order. HTML is read through a DOM
shim over htmlparser2 and css-select (`html.ts`) — enough for
`DOMParser.fromSchema` and a schema's `parseDOM` rules, so a paste from a web
page is read by the schema's own rules.

**Markdown** is `<Markdown>`'s parser, moved to `src/internal/markdown/` so
both components share it, and a serializer written for it
(`stringify.ts`). A round trip is asserted over a generated corpus: no
document may lose text or change on a second trip. Building it found four
parser bugs `<Markdown>` had been rendering all along — a blank line inside
a fence in a list item ended the item, a fence opened on a task item's line
was missed, an escaped entity was decoded anyway, and emphasis beside an
emoji read half of it as punctuation — and they are fixed for both. The AST
also keeps two things it used to drop, so a document survives a save: a
fence's whole info string and a link's title.

**Keys** are named the way prosemirror-keymap expects. `toDomKeyEvent`
builds a DOM-shaped event from the keysym, with the Latin key a chord was
pressed on — Ctrl+B under a Russian layout is still `Mod-b` — and swaps Ctrl
and Meta when the backend's primary modifier and the host's disagree:
prosemirror-keymap reads `navigator.platform`, which under Node on a Mac says
Mac even when the app is drawing to an X server.

**Suggestions** (`suggest.ts`) are a plugin whose state is the open list —
the trigger, the word typed after it, the rows and the highlighted one — and
whose `handleKeyDown` takes the list's keys while it has rows. Its plugin
view asks for the rows as the query changes and drops an answer to a query
already typed past, `<CodeEditor>`'s completion rule. The component draws a
`<popup>` from nothing but that state, hung off the textblock the trigger is
in (`anchorAt`), so an app that owns the state gets the list by putting the
plugin in it. A list opens as its trigger's word is typed, never as the
caret moves into one: the value is markdown, so a mention stays text, and a
document soon holds many words that start with `@`.

**Tables** (`tables.ts`) are prosemirror-tables' commands, wrapped so a
table in markdown's shape — one header row, first, alignment by column —
stays in it; `TableView` sizes each column to its widest cell the way
`<Markdown>` does, measuring a cell again only when its node changed; and
the table's own buttons are in the toolbar only with the caret in a
table.

**Collaborators' carets** (`collab.ts`) are y-prosemirror's cursor widgets
made drawable. Its cursor plugin builds each with a `cursorBuilder`, which
by default makes a DOM element; `remoteCaret` makes a description instead,
and the view, asking a text-less widget's `toDOM` once, draws what comes
back as a bar beside the editor's own caret. The plugin views that need
`view.dom` — y-prosemirror's listens on it for focus — are made once the
root element exists, not in the view's constructor.

**Drag and drop** (`drag.ts`) is core's gesture over the root element,
which is a drag source and a drop target. A press on the selection is the
one press the view leaves unclaimed, so that core can arm a drag; a drag
carries a copy's HTML and text and, for a drop in the app, the slice
itself. A drop is read like a paste and put in where `dropPoint` says it
fits — prosemirror-view's own drop, step for step.

## What a plugin can count on

The ledger, so "does my plugin work?" has an answer short of trying it.

| `EditorView` member                                                           | Here                                                                                                                                               |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`, `dispatch`, `props`, `someProp`, `setProps`, `update`, `updateState` | Yes. `someProp` in ProseMirror's order.                                                                                                            |
| `editable`, `composing`, `hasFocus()`, `focus()`, `isDestroyed`, `destroy()`  | Yes.                                                                                                                                               |
| `posAtCoords`, `coordsAtPos`, `endOfTextblock`                                | Yes, in logical window coordinates.                                                                                                                |
| `pasteText`, `pasteHTML`                                                      | Yes, through the same props a real paste goes through.                                                                                             |
| `dom`                                                                         | The root element — a react-x11 node, not an `HTMLElement` — with `addEventListener` for the focus events; `docView` is truthy while it is mounted. |
| `dragging`                                                                    | The slice a drag out of this editor carries, and whether a drop back in here moves it.                                                             |
| `root`, `domAtPos`, `nodeDOM`, `posAtDOM`, `domSelection()`                   | No. There is no DOM to answer with.                                                                                                                |

| View prop                                                                                                                             | Here                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `handleKeyDown`, `handleKeyPress`, `handleTextInput`                                                                                  | Yes. The event is a `DomKeyEvent`; composition commits go through `handleTextInput`.                                   |
| `handleClickOn`, `handleClick`, and the double and triple forms                                                                       | Yes. The event has `clientX`/`clientY` (logical), `button`, `detail`, the modifiers.                                   |
| `handlePaste`, `transformPasted`, `transformPastedHTML`, `transformPastedText`, `clipboardParser`, `clipboardTextParser`, `domParser` | Yes.                                                                                                                   |
| `transformCopied`, `clipboardSerializer`, `clipboardTextSerializer`                                                                   | Yes.                                                                                                                   |
| `decorations`                                                                                                                         | Inline and node decorations; widgets whose spec carries `text`.                                                        |
| `editable`, `handleScrollToSelection`, `dispatchTransaction`                                                                          | Yes.                                                                                                                   |
| `nodeViews`                                                                                                                           | Not as DOM constructors: the component's `nodeViews` take React components.                                            |
| `handleDrop`                                                                                                                          | Yes. The event is DOM-shaped: `dataTransfer.getData` answers what was read, and its `files` are `{ name, path, uri }`. |
| `handleDOMEvents`, `markViews`, `attributes`, `createSelectionBetween`                                                                | No.                                                                                                                    |

What that means for the plugins people reach for:

- **prosemirror-history, -keymap, -inputrules, -commands, -schema-list** run
  in every editor — they are the default plugins, and the tests drive them
  through real key events.
- **A decoration plugin** — highlighting, search results, spellcheck
  underlines, a collaborator's selection — is drawn, as long as a widget
  says what it draws with `text`. The example's TODO highlighter is one,
  unchanged from what a browser would run.
- **prosemirror-tables' commands** run here: they are the editor's own
  table commands (`tables.ts`). Its `tableEditing()` plugin's cell selection
  listens to DOM mouse events and does not arm, so there is no selecting a
  block of cells yet.
- **y-prosemirror** is verified (`test/rich-text-editor-collab.test.ts`):
  its sync, undo and cursor plugins run unchanged over two relayed editors,
  and a collaborator's caret is drawn when the cursor plugin is handed
  `remoteCaret` for its cursor builder — the default one makes a DOM
  element. **prosemirror-collab** is state and steps by construction.

## Decisions

- **Markdown is the default value.** It is what the apps in the first table
  store, and this package already reads it: what an editor wrote is what a
  `<Markdown>` beside it shows, by the same parser.
- **A reset is not undoable.** `value` changing and `setValue` replace the
  document outside the history — a form reset, not an edit — so Undo never
  brings back the draft an app just cleared.
- **The toolbar is a caller of the API, not a second one.** Its buttons run
  the exported commands and ask the state whether they are on, as an app's
  own toolbar would; they are not focusable, so the caret stays where it was.
- **The editor opens nothing.** Links go to `onLink`, images to
  `renderImage`: a document is not a licence to make requests.
- **Tab belongs to lists, code and tables, and Escape frees it.** Anywhere
  else Tab moves focus on, as it does from a browser's `contenteditable`;
  after Escape it leaves from anywhere.
- **The copy is kept in process.** react-x11's clipboard is text-only on
  macOS for now, so a copy also keeps its slice, and a paste of exactly that
  text takes the slice back — or copy and paste within one editor would
  flatten every list on a Mac.
- **Subpath only.** ProseMirror's declarations name DOM globals; exported
  from the barrel, they would be every app's problem, including apps that
  want a calendar.
- **No virtualization.** Blocks re-render only when their node changed, but
  every block is mounted. Right for the use cases above; not for a book.
- **A suggestion opens as its word is typed, never as the caret moves.** The
  value is markdown and a mention stays text, so a document is soon full of
  words that start with `@`, and a click into one places a caret. GitHub's
  comment box and `<CodeEditor>`'s completion keep the same rule.
- **A mention is text unless a row says otherwise.** Markdown has no mention
  syntax — GitHub stores `@ada` as text too. A row's `insert` can be a node:
  text with a link mark, or a mention node of an app's own schema. A chip
  waits on inline widgets.
- **An Escape a plugin claims is the plugin's.** Escape arms one Tab that
  leaves the editor unless a plugin's `handleKeyDown` took it — a suggestion
  list closing. The next Escape arms the Tab: while a list is open the way
  out is one key longer, never gone.

## Follow-ups

- **IME tiers** (react-x11#272) — the preedit is drawn and committed; the
  candidate window's placement and the preedit's own cursor and segments
  are core's to deliver.
- **Inline widgets as components** — the same gate as MDX's inline half: a
  `<richtext>` run that reserves advance width for an element. A mention
  drawn as a chip, avatar and all, waits on the same run; until then a
  mention is text, or text with a mark.
- **Virtualization**, for long documents.
- **Images in text** — `renderImage` draws an image alone in its paragraph;
  one inside a line needs the same inline-widget run.
