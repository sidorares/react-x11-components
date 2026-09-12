# RichTextEditor

```jsx
import { RichTextEditor } from '@react-x11/components/rich-text-editor';

<RichTextEditor
  defaultValue={note.body}
  onChange={(ev) => save(ev.value)}
  placeholder="Write something…"
  toolbar
  style={{ flexGrow: 1 }}
/>;
```

A WYSIWYG editor — notes, comments, a chat composer, a document pane — whose
value is markdown unless `format` says otherwise.

It is **ProseMirror's model with a view of this package's own.** The schema,
the document, transactions, commands and the plugin system are
[ProseMirror](https://prosemirror.net)'s modules, unmodified. The view — in a
browser, prosemirror-view's `EditorView` over `contenteditable` — is
`RichEditorView`, which draws with react-x11 and is shaped like `EditorView`,
so a plugin, a command or an input rule is handed what it was written to
expect. [The PRD](../prd-rich-text-editor.md) has the survey behind that and
the full ledger of what a plugin can count on.

It **registers two host elements** at its module scope: `<richeditor>`
(`RICH_EDITOR_ELEMENT`), the root — focus, keys, composition, and the one text
a screen reader reads — and `<richeditortext>` (`RICH_EDITOR_TEXT_ELEMENT`),
one per textblock: [`<richtext>`](richtext.md) plus a caret and a selection
band the view sets directly, so a blink or a drag re-renders nothing.

**Imported from its subpath only.** Every other component is also exported
from `@react-x11/components`; this one is not, because ProseMirror's
declarations name DOM globals, and an app that imports anything from the
barrel loads every re-exported module's declarations. With `skipLibCheck`
(most templates' default) or `"dom"` in `lib` there is nothing to do;
otherwise declare the four names in `src/rich-text-editor/dom-globals.d.ts`,
which ships in the package.

## Props

The props are one ladder on one element: each group below is an opt-in on
top of the one before, and none of them replaces another.

### The document

| Prop           | Type                                      | Notes                                                                                                                                                                                                                               |
| -------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultValue` | `string \| Node`                          | Uncontrolled initial document: a string in `format`, or a ProseMirror node.                                                                                                                                                         |
| `value`        | `string`                                  | Controlled. A value different from the one the editor last reported replaces the document — a reset: not undoable, the caret kept near where it was. Handing back what `onChange` reported changes nothing, and costs a comparison. |
| `onChange`     | `(ev: RichTextEditorChangeEvent) => void` | Every change to the document; the selection moving is `onSelectionChange`. `ev.value` is serialized the first time it is read.                                                                                                      |
| `format`       | `'markdown' \| 'html' \| 'text'`          | What `value`, `defaultValue` and `ev.value` are written in. Default `'markdown'`.                                                                                                                                                   |
| `name`         | `string`                                  | Echoed on every event.                                                                                                                                                                                                              |

### Behaviour

| Prop                | Type                                     | Notes                                                                                                                                                |
| ------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `placeholder`       | `string`                                 | Drawn in an empty document, after the caret. Also the accessible name when there is no `aria-label`.                                                 |
| `readOnly`          | `boolean`                                | Focusable, selectable and copyable; nothing edits.                                                                                                   |
| `disabled`          | `boolean`                                | Inert, out of the tab order, dimmed.                                                                                                                 |
| `autoFocus`         | `boolean`                                |                                                                                                                                                      |
| `onSubmit`          | `(ev: RichTextEditorEvent) => void`      | Mod-Enter — or plain Enter, with `submitOnEnter`.                                                                                                    |
| `submitOnEnter`     | `boolean`                                | Enter submits and Shift+Enter breaks the line: a chat composer. Inside a list or a code block Enter still edits.                                     |
| `onSelectionChange` | `(ev: RichTextEditorEvent) => void`      |                                                                                                                                                      |
| `onLink`            | `(href: string, ev: MouseEvent) => void` | A link was activated — Mod-click while editing, a plain click when read-only. The editor never opens anything by itself.                             |
| `suggestions`       | `Suggester[]`                            | Lists that open at a trigger character as its word is typed — `@` for people, `#` for issues, `/` for a block menu. See [Suggestions](#suggestions). |

### Chrome and looks

| Prop                | Type                                                                       | Notes                                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolbar`           | `boolean \| ToolbarEntry[] \| (editor: RichTextEditorHandle) => ReactNode` | `true` for `DEFAULT_TOOLBAR`, less whatever the schema cannot do; an array to pick and order built-in names, `'\|'` separators and `ToolbarItem`s of your own; a function to render your own bar, handed the editor. |
| `fontSize`          | `number`                                                                   | Base text size. Default: the theme's.                                                                                                                                                                                |
| `fontFamily`        | `string`                                                                   | Default `'sans-serif'`.                                                                                                                                                                                              |
| `monoFamily`        | `string`                                                                   | Inline code and fences. Default `'monospace'`.                                                                                                                                                                       |
| `markStyles`        | `Record<string, MarkStyle>`                                                | How a mark looks, by mark name: a run style merged over the built-in look, or a function of the mark and the style under it.                                                                                         |
| `decorationClasses` | `Record<string, RunStyle>`                                                 | How a decoration's `class` looks — see [Decorations](#decorations).                                                                                                                                                  |
| `highlight`         | `boolean`                                                                  | Syntax colouring in fenced code. Default true.                                                                                                                                                                       |
| `resolveLanguage`   | `(tag: string) => Language \| null`                                        | A tokenizer for a fence tag the built-ins do not cover — the same seam as [`<Markdown>`](markdown.md)'s.                                                                                                             |
| `renderImage`       | `(image: ImageInfo) => ReactNode`                                          | An image alone in its paragraph, drawn by you. Without it an image is its alt text: the editor fetches nothing.                                                                                                      |
| `style`             | `Style \| Style[]`                                                         | The frame: width, height, `maxHeight`, `flexGrow`, border, background. Given no height the editor is as tall as its content up to `maxHeight`, and scrolls past it — a composer grows as it is typed in.             |
| `styles`            | `{ toolbar?: Style; content?: Style }`                                     | The parts inside the frame.                                                                                                                                                                                          |

### ProseMirror's seams

| Prop                  | Type                                           | Notes                                                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`              | `Schema`                                       | The document model. Default: `schema` from this module — GFM, in ProseMirror's reference names.                                                                                                                             |
| `markdown`            | `MarkdownCodec`                                | A markdown codec for a schema the built-in one cannot read or write.                                                                                                                                                        |
| `plugins`             | `Plugin[]`                                     | Ahead of the editor's own, so a keymap here wins over the defaults. Give the array a stable identity: a new one is a reconfigure — cheap, and every plugin instance still in it keeps its state, the undo history included. |
| `history`             | `boolean`                                      | The undo history. Default true.                                                                                                                                                                                             |
| `inputRules`          | `boolean`                                      | The markdown shortcuts. Default true.                                                                                                                                                                                       |
| `keymap`              | `boolean`                                      | The formatting shortcuts. Default true.                                                                                                                                                                                     |
| `typography`          | `boolean`                                      | Smart quotes, `…` and `—` as they are typed. Default false.                                                                                                                                                                 |
| `editorProps`         | `EditorProps`                                  | ProseMirror's view props — `handleKeyDown`, `handlePaste`, `decorations`, `transformPasted`… — without a plugin to hold them. See [What a plugin can count on](#what-a-plugin-can-count-on).                                |
| `nodeViews`           | `Record<string, ComponentType<NodeViewProps>>` | A React component per node type.                                                                                                                                                                                            |
| `state`               | `EditorState`                                  | The top rung: the app owns the state, instead of `value`/`defaultValue`. The editor's default plugins are then the app's to include — `defaultPlugins(schema)`.                                                             |
| `dispatchTransaction` | `(tr: Transaction) => void`                    | With `state`: every transaction, for the app to apply and pass back — ProseMirror's own contract.                                                                                                                           |

### Focus and the rest

| Prop                               | Type                          | Notes                                                                                                    |
| ---------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ref`                              | `Ref<RichTextEditorHandle>`   |                                                                                                          |
| `onKeyDown`                        | `(ev: KeyboardEvent) => void` | Runs before the editor does anything with the key; `preventDefault()` keeps it from the editor entirely. |
| `onMouseDown`, `onFocus`, `onBlur` |                               |                                                                                                          |
| `aria-label`                       | `string`                      | Default: the placeholder.                                                                                |
| `data-testname`                    | `string`                      | For `react-x11/test`'s queries.                                                                          |

## `RichTextEditorHandle`

The `ref`. Everything the toolbar does, it does through this.

| Member                                        | Notes                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `view`                                        | The `EditorView`-shaped view: `dispatch`, `state`, `someProp`, `posAtCoords`… — what a ProseMirror command is handed.      |
| `state`, `schema`                             | Current.                                                                                                                   |
| `getValue(format?)`                           | The document, in `format` or the editor's own.                                                                             |
| `setValue(value, { format?, addToHistory? })` | Replace the document with a string or a node. Not undoable unless `addToHistory` says so, the way a form reset is not.     |
| `insertContent(value, format?)`               | Insert markdown, HTML, text or a node at the selection; a single paragraph joins the one the caret is in.                  |
| `run(command)`, `can(command)`                | Run a ProseMirror command, or ask whether it could run now — what greys a toolbar button.                                  |
| `isActive(name, attrs?)`                      | A mark on the selection, or a node (with attributes) around it: `isActive('strong')`, `isActive('heading', { level: 2 })`. |
| `toggleMark(name, attrs?)`                    |                                                                                                                            |
| `setBlock(name, attrs?)`                      | A textblock type — back to a paragraph when it already is one.                                                             |
| `toggleList(name)`, `toggleWrap(name)`        | `toggleList('bullet_list')`, `toggleWrap('blockquote')`.                                                                   |
| `undo()`, `redo()`                            |                                                                                                                            |
| `editLink()`                                  | Open the link editor on the selection — what Mod-K does.                                                                   |
| `focus()`, `blur()`                           |                                                                                                                            |

## Events

`onChange` hears a `RichTextEditorChangeEvent`: `type: 'change'`, `value` (the
document in `format`, serialized when first read — a listener that only needs
to know _that_ something changed never pays for it), `doc`, `state`, the
`transactions` that made the change, `name` and `target` (the handle).

`onSubmit` and `onSelectionChange` hear a `RichTextEditorEvent`:
`type: 'submit' | 'selectionchange'`, `value`, `state`, `name`, `target`.

## Keys

Mod is **Ctrl** on the X11 backend and **Cmd** on the macOS one — the
backend's convention, whatever host the process runs on.

| Keys                                          | Does                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mod-B, Mod-I, Mod-\`, Shift-Mod-X             | Bold, italic, inline code, strikethrough                                                                                                                                                                     |
| Mod-K                                         | Link the selection: a field at the selection asks for the target, Enter applies, Escape cancels, an empty target unlinks                                                                                     |
| Mod-Z; Shift-Mod-Z or Mod-Y                   | Undo; redo                                                                                                                                                                                                   |
| Mod-Alt-0; Mod-Alt-1 … 6; Mod-Alt-C           | Paragraph; heading 1–6; code block                                                                                                                                                                           |
| Shift-Mod-8, Shift-Mod-7, Shift-Mod-9         | Bulleted, numbered, task list                                                                                                                                                                                |
| Ctrl->                                        | Quote                                                                                                                                                                                                        |
| Mod-\_                                        | Divider                                                                                                                                                                                                      |
| Shift-Enter, Mod-Enter                        | Line break (Mod-Enter submits instead when there is an `onSubmit`)                                                                                                                                           |
| Enter                                         | New paragraph; in a list a new item, and on an empty item the end of the list                                                                                                                                |
| Tab, Shift-Tab                                | In a list, nest and un-nest the item; in a code block, indent and dedent; in a table, the next and previous cell (Tab in the last cell adds a row). Anywhere else Tab is not the editor's and moves focus on |
| Escape, then Tab                              | Leave the editor, from anywhere. An Escape that closes a [suggestion list](#suggestions) closes only the list                                                                                                |
| Arrows, Home/End, PageUp/PageDown             | Move, by grapheme and by visual line; Home and End go to the ends of the _line_ as it wraps. Shift extends                                                                                                   |
| Ctrl-arrows, Ctrl-Home/End (X11)              | By word; to the ends of the document                                                                                                                                                                         |
| Alt-arrows, Cmd-arrows (macOS)                | By word; to the ends of the line, or of the document                                                                                                                                                         |
| Backspace, Delete                             | By grapheme; with Ctrl (X11) or Alt (macOS) by word, with Cmd (macOS) to the line's start                                                                                                                    |
| Mod-A, Mod-C, Mod-X, Mod-V, Shift-Mod-V       | Select all, copy, cut, paste, paste as plain text                                                                                                                                                            |
| Shift-Delete, Ctrl-Insert, Shift-Insert (X11) | Cut, copy, paste                                                                                                                                                                                             |

With the pointer: a press places the caret, Shift extends, a double press
selects a word and a triple one the block, a drag selects (and scrolls at the
edges), a press on a divider — any block that is a leaf — selects it whole,
a press on a task's box toggles it, and the right button opens core's edit menu (Copy and
Select All only, when read-only). On X11 a selection is offered as PRIMARY
and the middle button pastes PRIMARY at the pointer.

## Markdown shortcuts

Typed at the start of a paragraph: `# ` to `###### ` (headings), `> `
(quote), `- `, `* ` or `+ ` (bulleted list), `1. ` (numbered list, starting
where the number says), `[ ] ` or `[x] ` (a task — in a list item too),
` ``` ` or ` ```lang ` and a space (a code block), and `---` (a divider).
Anywhere: `**bold**`, `__bold__`, `*italic*`, `_italic_`, `` `code` `` and
`~~strike~~` take their mark as the closing delimiter is typed. Backspace
straight after any of them gives the characters back. `inputRules={false}`
turns them all off.

## Suggestions

`suggestions` opens a list at a trigger character as its word is typed — the
`@` of a mention, the `#` of an issue, the `/` of a block menu:

```tsx
<RichTextEditor
  suggestions={[
    { char: '@', items: people }, // an array: filtered as the name is typed
    { char: '#', items: ({ query }) => searchIssues(query) }, // a function: asked
    { char: '/', startOfLine: true, items: blockMenu }, // rows that are commands
  ]}
/>
```

A `Suggester` is a trigger, its rows, and three options:

| Field         | Notes                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `char`        | The trigger. It opens a list at the start of a word — after a space, an opening bracket or quote, or at the start of a block — so `ada@example.com` is an address. Never in code.                                                                                                                                                                                        |
| `items`       | An array of `SuggestionItem`s, which the editor filters as the word is typed: labels that start with the query first, then labels with a word that does, then any that contain it. Or a function, handed `{ query, char, state }`, whose rows are shown as it returns them; it may return a promise, and an answer that arrives after the query has moved on is dropped. |
| `startOfLine` | Only at the start of a textblock — a block menu.                                                                                                                                                                                                                                                                                                                         |
| `allowSpaces` | The query may hold spaces — a full name. Two spaces in a row end it either way.                                                                                                                                                                                                                                                                                          |
| `renderItem`  | `(item, { selected, query }) => ReactNode`: a row of your own — an avatar, a presence dot, a shortcut drawn as keys. The editor still draws the highlight behind it (`selected` says which row sits on the accent) and takes a press on it, and an array is still filtered on `label`. `Suggester<Item>` takes your own row type, so `renderItem` is handed it typed.    |

A `SuggestionItem` is a row, and what taking it does:

| Field     | Notes                                                                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`   | The row — and what an array is filtered on.                                                                                                                                                                            |
| `detail`  | Muted text after the label: a handle, a description, a shortcut.                                                                                                                                                       |
| `insert`  | What replaces the trigger and its word: text, or a node of the schema — text carrying a link mark, a mention node of your own schema. Default: the trigger and the label. A space follows it, unless one already does. |
| `command` | Run instead of inserting anything, where the trigger and its word were: a block menu's "Heading 1". It is one undo step with the deletion.                                                                             |

The list hangs below the trigger and follows its text as the document
scrolls. It takes plain keys, and only while it has rows: **Up** and
**Down** move the highlight, **PageUp** and **PageDown** by a page, **Enter**
and **Tab** take the row — so a `submitOnEnter` composer takes the mention
rather than sending the message — and **Escape** closes the list. A press on
a row takes it, and the caret stays where it was. One undo straight after a
choice gives back what was typed.

**A list opens as its trigger's word is typed, never when the caret merely
moves into one.** The value is markdown, so a mention stays text — `@ada` —
and a document soon holds many words that start with a trigger: clicking
into one opens nothing, typing in it does. A list closed with Escape, or by a
choice, stays closed for that trigger until its character is deleted. While
the word is typed it carries the decoration class `suggestion`, drawn in the
accent colour; `decorationClasses={{ suggestion: … }}` restyles it.

**A mention is text, or text with a mark.** The default schema is GFM, and
markdown has no mention — GitHub keeps `@ada` as text too. For a mention
that links, `insert: schema.text('@ada', [schema.marks.link.create({ href })])`;
for a mention node, hand the editor a schema that has one and insert that.

**The list is plugin state.** The prop installs `suggestions(suggesters)` —
one plugin per editor, holding every trigger — and the popup is drawn from
nothing but `suggestionState(state)`: `{ char, query, from, to, items,
selected }`. An app that owns the `EditorState` puts the same plugin in its
plugins, ahead of the defaults so a row takes Enter before the keymap does,
and gets the same list:

```ts
EditorState.create({
  schema,
  plugins: [
    suggestions([{ char: '@', items: people }]),
    ...defaultPlugins(schema),
  ],
});
```

The list's commands are exported for a toolbar, a test, or a list of your
own: `acceptSuggestion(index?)`, `selectSuggestion(index)` and
`dismissSuggestion`; `filterSuggestions(items, query)` is the editor's own
filter, and `suggesterFor(state)` is the suggester whose list is open.

## Tables

A table is typed in like any text — Tab and Shift-Tab go to the next and
the previous cell, and Tab in the last cell adds a row — and its rows and
columns go in and out from the toolbar. **Table** puts a table where the
caret is, a header row and two more of three cells, with the caret in its
first cell; while the caret is in a table the bar also shows **Row
above**, **Row below**, **Column before**, **Column after**, **Delete
row**, **Delete column** and **Delete table**, and hides them again when
it leaves. `alignLeft`, `alignCenter` and `alignRight` are there by name,
for a bar of your own: they set a column's alignment, and pressed again
take it off. An item of your own can come and go the same way, with
`visible(state)`.

The commands are prosemirror-tables' own, exported for a toolbar of your
own and for `handle.run`: `insertTable(rows?, cols?)`, `addRowBefore`,
`addRowAfter`, `addColumnBefore`, `addColumnAfter`, `deleteRow`,
`deleteColumn`, `deleteTable`, `setColumnAlign(align)`, and — to light an
alignment button — `columnAlign(state)`.

**A markdown table keeps markdown's shape.** Markdown's table has one
header row, and it is the first; its alignment belongs to a column, not to
a cell. So a row added above the header becomes the header, deleting the
header hands it to the row below, and a new cell takes its column's
alignment: what the editor shows is what the markdown reads back as. A
table of another shape — a header column pasted from HTML, say — is left
the way prosemirror-tables leaves it. `tableRepair()`, one of the default
plugins, keeps every table rectangular, which a paste can break.

**Columns are as wide as their content**, capped so that one long cell
cannot starve the rest, and a table narrower than the document stays
narrow — the way `<Markdown>` sizes the same table. Wider than the
document, every column gives up the same share and its text wraps. A cell
is measured when it changes and not otherwise, so typing in a large table
costs what typing in a paragraph does.

## Collaboration

The editor runs y-prosemirror — the binding a Yjs-backed ProseMirror
editor uses — as it is: its sync plugin binds the document to a
`Y.XmlFragment`, its undo plugin takes the place of the editor's own
history with one that takes back only this user's edits, and its cursor
plugin shows where everyone else is. The one piece that is this editor's is
`remoteCaret`, the cursor builder:

```tsx
import {
  ySyncPlugin,
  yCursorPlugin,
  yUndoPlugin,
  undo,
  redo,
} from 'y-prosemirror';
import { keymap } from 'prosemirror-keymap';
import {
  RichTextEditor,
  remoteCaret,
} from '@react-x11/components/rich-text-editor';

const plugins = [
  ySyncPlugin(ydoc.getXmlFragment('prosemirror')),
  yCursorPlugin(provider.awareness, { cursorBuilder: remoteCaret }),
  yUndoPlugin(),
  keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo }),
];

<RichTextEditor plugins={plugins} history={false} />;
```

Give the plugins a stable identity, and turn `history` off: two undo
histories over one document fight. The document is the fragment's — the
sync plugin replaces whatever the editor started with — so `value` and
`defaultValue` have nothing to say here, and `onChange` still hears every
change, a collaborator's included.

A collaborator's caret is a bar and a small flag in their awareness colour
(`user.color`, a `#rrggbb`), drawn beside the editor's own caret and set
the same way, re-rendering nothing; their selection is lit by the cursor
plugin's own decoration. y-prosemirror's default cursor builder makes a DOM
element, which has nothing to draw it here — `remoteCaret` is the builder
this editor reads. The name is not drawn beside the caret yet.

## The document model

`schema` is GFM in the names of ProseMirror's reference schemas, so commands
written against prosemirror-schema-basic and -list work unchanged:

- **Nodes:** `doc`, `paragraph`, `heading` (`level`), `blockquote`,
  `code_block` (`params`, the fence's info string), `horizontal_rule`,
  `bullet_list` and `ordered_list` (`order`; both `tight`), `list_item`
  (`checked`: `null` for an ordinary item, a boolean for a task), `table`,
  `table_row`, `table_header` and `table_cell` (prosemirror-tables' cell
  attributes, plus `align`), `text`, `image` (`src`, `alt`, `title`), and
  `hard_break`.
- **Marks:** `link` (`href`, `title`; not inclusive, so typing at a link's
  end does not extend it), `em`, `strong`, `strike`, `code`.

`nodes` and `marks` are exported as specs, to build a schema of your own from.
The markdown codec and the renderer also know TipTap's names for the same
things (`bulletList`, `listItem`, `codeBlock`, `bold`, `italic`…), so a schema
built from TipTap's extension specs reads and writes markdown too; anything
else is drawn from what its own `toDOM` says it is, and `markdown` takes a
codec for what the built-in one cannot say.

Markdown out is written to be read back as the same document — the model
test round-trips a generated corpus and fails on any document that loses
text or changes on a second trip. What markdown cannot express at all is
dropped rather than mangled.

## Decorations

A plugin's `decorations` are drawn, because a decoration is state rather than
DOM — with one limit, which is a widget:

- **Inline** decorations style the text they cover: their `class` through
  `decorationClasses`, their `style` attribute's CSS (colour, background,
  weight, style, decoration), and `spec.run`, a `RunStyle`, when a plugin
  written for this editor wants to say it directly.
- **Node** decorations colour the block's background the same three ways.
- **Widgets** are drawn when their spec carries `text` (styled by
  `spec.run`, placed by `side`); a widget described only by a `toDOM`
  function has nothing to draw it with and is skipped. The placeholder and a
  composition's preedit are widgets of the view's own.

```ts
new Plugin({
  props: {
    decorations: (state) =>
      DecorationSet.create(state.doc, [
        Decoration.inline(from, to, { class: 'todo' }),
        Decoration.widget(pos, () => document.createElement('span'), {
          text: '@',
          run: { color: '#888' },
        }),
      ]),
  },
});
```

## What a plugin can count on

The view a plugin is handed is `RichEditorView`. It has `state`, `dispatch`,
`props`, `someProp` (ProseMirror's order: direct props, then direct plugins,
then the state's), `setProps`, `update`, `updateState`, `editable`,
`composing`, `hasFocus`, `focus`, `destroy`, `posAtCoords`, `coordsAtPos`,
`endOfTextblock`, `pasteText` and `pasteHTML`. `dom` is the root element — a
react-x11 node, not an `HTMLElement` — and there is no `domAtPos`, `nodeDOM`
or `posAtDOM`, because there is no DOM to answer with. It does answer
`addEventListener` for the focus events — `focus`, `blur`, `focusin` and
`focusout`, what y-prosemirror's cursor plugin listens for — and `docView`
is truthy while the editor is mounted. Plugin views are made once the
editor is mounted, so a plugin view finds `view.dom` from its first call.

View props honoured: `handleKeyDown`, `handleKeyPress`, `handleTextInput`,
`handleClickOn`/`handleClick` and their double and triple forms,
`handlePaste`, `handleScrollToSelection`, `decorations`, `editable`,
`dispatchTransaction`, and the whole clipboard family — `transformCopied`,
`clipboardSerializer`, `clipboardTextSerializer`, `transformPastedHTML`,
`transformPastedText`, `clipboardParser`, `clipboardTextParser`, `domParser`
and `transformPasted`. Not honoured: `handleDOMEvents`, `handleDrop`,
DOM `nodeViews` (use the component's `nodeViews`), `markViews`,
`attributes` and `createSelectionBetween`.

An event a prop receives is DOM-_shaped_: `handleKeyDown` gets a
`DomKeyEvent` — `key`, `code`, `keyCode` and the modifiers, named from the
keysym, so `Mod-b` matches Ctrl+B whatever layout typed it — and a click
handler gets `clientX`/`clientY` in the same logical window coordinates as
`posAtCoords`. TypeScript still calls them `KeyboardEvent` and `MouseEvent`;
cast to `DomKeyEvent` to read one.

## Node views

A node view here is a React component, handed `NodeViewProps`: `node`,
`getPos()` (a function — positions move with every edit before the node, and
the view is not re-rendered for that), `selected`, `children` (the node's
content, rendered — editable text for a textblock, blocks for a container;
place it where it goes), `updateAttributes(attrs)`, `editable` and `view`.

```tsx
function Fence({ node, children, updateAttributes }: NodeViewProps) {
  return (
    <box style={{ flexDirection: 'column' }}>
      <text onMouseDown={() => updateAttributes({ params: 'py' })}>
        {node.attrs.params || 'plain'}
      </text>
      {children}
    </box>
  );
}

<RichTextEditor nodeViews={{ code_block: Fence }} />;
```

## Decisions

- **The value is markdown**, because the apps this is for — notes, comments,
  chat — store markdown, and because this package already reads it: the
  parser is `<Markdown>`'s own, so what an editor wrote is what a
  `<Markdown>` beside it shows. `format="html"` is there for mail and CMS
  fields; `state` for anything that stores ProseMirror's JSON.
- **A reset is not an edit.** A new `value`, or `setValue`, replaces the
  document outside the undo history, so Undo never resurrects the draft the
  app just cleared.
- **The toolbar never takes focus.** Its buttons are not focusable and stop
  the press before the editor sees it, so the caret stays put and the command
  runs on the selection that is visible.
- **Links and images reach nothing by themselves.** A link is `onLink`'s to
  open and an image is `renderImage`'s to draw — the line `<Markdown>` holds,
  for the same reason: a document is not a licence to make requests.
- **Tab is the editor's only where it means something** — lists, code,
  tables — and Escape then Tab leaves from anywhere, the rule
  [`<CodeEditor>`](code-editor.md) keeps too.
- **A copy keeps its structure on every backend.** A copy offers HTML and
  text, and keeps the slice itself in the process; a paste whose text is
  exactly that copy takes the slice back. That matters on macOS, where
  react-x11's clipboard carries text only for now: without it, copy and
  paste inside one editor would flatten every list.
- **Every block is mounted.** Only the blocks an edit touched re-render, but
  nothing is virtualized — right for notes and documents, not for a book.
- **A suggestion list opens as its word is typed**, never as the caret moves
  into one — the rule GitHub's comment box keeps, and
  [`<CodeEditor>`](code-editor.md)'s completion. A markdown document keeps
  its mentions as text, so it is soon full of words that start with a
  trigger, and a click into one of them should place a caret, not open a
  list.
- **A markdown table keeps markdown's shape** through every table
  command — one header row, first, and alignment by column — so the value
  never reads back as a different table from the one on screen.
- **Table actions live in the toolbar, not the right-click menu.** The
  edit menu is core's, with a fixed set of verbs; the bar shows a table's
  own buttons only while the caret is in one.
- **Collaboration is y-prosemirror's, run as it is.** The editor adds a
  cursor builder, `remoteCaret`, because the default one builds a DOM
  element, and everything else — sync, undo, awareness — is the binding
  every Yjs-backed ProseMirror editor runs.

## Backends

Both. Mod follows the backend (Ctrl on X11, Cmd on macOS), and so do word
motion and the other chords above. PRIMARY and the middle-button paste are
X11's. On macOS react-x11's clipboard is text-only today, so HTML copied in
another application arrives as its text (react-x11's docs/clipboard.md,
"Limits").

## Also exported

`RichEditorView`; `schema`, `nodes`, `marks`; `defaultPlugins`,
`editingKeymap`, `markdownInputRules`; the commands the toolbar is built on
(`toggleBlockType`, `toggleList`, `toggleTaskList`, `toggleWrap`, `setLink`,
`setTaskChecked`, `splitItem`, `insertHorizontalRule`, `indentCode`,
`dedentCode`, `goToCell`, `isMarkActive`, `isBlockActive`, `markAttrs`); the
codecs (`docFromMarkdown`, `markdownFromDoc`, `markdownCodec`,
`docFromHTML`, `htmlFromContent`, `docFromText`, `textFromDoc`);
`DEFAULT_TOOLBAR` and `toolbarItems`; the suggestion plugin and its commands
(`suggestions`, `suggestionState`, `suggesterFor`, `acceptSuggestion`,
`selectSuggestion`, `dismissSuggestion`, `filterSuggestions`); the table
commands (`insertTable`, `addRowBefore`, `addRowAfter`, `addColumnBefore`,
`addColumnAfter`, `deleteRow`, `deleteColumn`, `deleteTable`,
`setColumnAlign`, `columnAlign`, `isInTable`) and `tableRepair`;
`remoteCaret`, y-prosemirror's cursor builder for this editor; and the
types `DomKeyEvent`,
`NodeViewProps`, `ImageInfo`, `MarkStyle`, `RunStyle`, `ToolbarEntry`,
`ToolbarItem`, `MarkdownCodec`, `Suggester`, `SuggestionItem`,
`SuggestionQuery`, `SuggestionRow`, `SuggestionState`, `ColumnAlign`,
`RemoteCaret` and `DomFocusEvent`.

## Example

`npm run examples:rich-text-editor` shows a notes pane — toolbar, markdown
source beside it, a stock ProseMirror decoration plugin, and a `/` block
menu with a Table row — next to a chat composer that grows as it is typed
in, sends on Enter, mentions people with `@` — each row drawn by the app,
a badge of initials beside the name — and names channels with `#`.
