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

| Prop                | Type                                     | Notes                                                                                                                    |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `placeholder`       | `string`                                 | Drawn in an empty document, after the caret. Also the accessible name when there is no `aria-label`.                     |
| `readOnly`          | `boolean`                                | Focusable, selectable and copyable; nothing edits.                                                                       |
| `disabled`          | `boolean`                                | Inert, out of the tab order, dimmed.                                                                                     |
| `autoFocus`         | `boolean`                                |                                                                                                                          |
| `onSubmit`          | `(ev: RichTextEditorEvent) => void`      | Mod-Enter — or plain Enter, with `submitOnEnter`.                                                                        |
| `submitOnEnter`     | `boolean`                                | Enter submits and Shift+Enter breaks the line: a chat composer. Inside a list or a code block Enter still edits.         |
| `onSelectionChange` | `(ev: RichTextEditorEvent) => void`      |                                                                                                                          |
| `onLink`            | `(href: string, ev: MouseEvent) => void` | A link was activated — Mod-click while editing, a plain click when read-only. The editor never opens anything by itself. |

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

| Keys                                          | Does                                                                                                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mod-B, Mod-I, Mod-\`, Shift-Mod-X             | Bold, italic, inline code, strikethrough                                                                                                                                   |
| Mod-K                                         | Link the selection: a field at the selection asks for the target, Enter applies, Escape cancels, an empty target unlinks                                                   |
| Mod-Z; Shift-Mod-Z or Mod-Y                   | Undo; redo                                                                                                                                                                 |
| Mod-Alt-0; Mod-Alt-1 … 6; Mod-Alt-C           | Paragraph; heading 1–6; code block                                                                                                                                         |
| Shift-Mod-8, Shift-Mod-7, Shift-Mod-9         | Bulleted, numbered, task list                                                                                                                                              |
| Ctrl->                                        | Quote                                                                                                                                                                      |
| Mod-\_                                        | Divider                                                                                                                                                                    |
| Shift-Enter, Mod-Enter                        | Line break (Mod-Enter submits instead when there is an `onSubmit`)                                                                                                         |
| Enter                                         | New paragraph; in a list a new item, and on an empty item the end of the list                                                                                              |
| Tab, Shift-Tab                                | In a list, nest and un-nest the item; in a code block, indent and dedent; in a table, the next and previous cell. Anywhere else Tab is not the editor's and moves focus on |
| Escape, then Tab                              | Leave the editor, from anywhere                                                                                                                                            |
| Arrows, Home/End, PageUp/PageDown             | Move, by grapheme and by visual line; Home and End go to the ends of the _line_ as it wraps. Shift extends                                                                 |
| Ctrl-arrows, Ctrl-Home/End (X11)              | By word; to the ends of the document                                                                                                                                       |
| Alt-arrows, Cmd-arrows (macOS)                | By word; to the ends of the line, or of the document                                                                                                                       |
| Backspace, Delete                             | By grapheme; with Ctrl (X11) or Alt (macOS) by word, with Cmd (macOS) to the line's start                                                                                  |
| Mod-A, Mod-C, Mod-X, Mod-V, Shift-Mod-V       | Select all, copy, cut, paste, paste as plain text                                                                                                                          |
| Shift-Delete, Ctrl-Insert, Shift-Insert (X11) | Cut, copy, paste                                                                                                                                                           |

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
or `posAtDOM`, because there is no DOM to answer with.

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
`DEFAULT_TOOLBAR` and `toolbarItems`; and the types `DomKeyEvent`,
`NodeViewProps`, `ImageInfo`, `MarkStyle`, `RunStyle`, `ToolbarEntry`,
`ToolbarItem` and `MarkdownCodec`.

## Example

`npm run examples:rich-text-editor` shows a notes pane — toolbar, markdown
source beside it, and a stock ProseMirror decoration plugin — next to a chat
composer that grows as it is typed in and sends on Enter.
