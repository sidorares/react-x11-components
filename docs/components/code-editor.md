# CodeEditor

```jsx
import {
  CodeEditor,
  sql,
  sqlCompletionSource,
  keywordCompletionSource,
} from '@react-x11/components/code-editor';

<CodeEditor
  language={sql()}
  value={query}
  onChange={(ev) => setQuery(ev.value)}
  completionSources={[
    sqlCompletionSource({ users: ['id', 'name'] }),
    keywordCompletionSource(),
  ]}
  lineNumbers
  style={{ flexGrow: 1 }}
/>;
```

A multiline editor for code-shaped input — a SQL box, a shell one-liner, a
config field, a small IDE pane.

It **registers a host element**, `<codeeditor>` (`CODE_EDITOR_ELEMENT`), at
its own module scope. `CodeEditorNode` owns the text model and the pixels;
the React component owns registration, the wiring from input props to the
node's handlers, and the completion popup — which is plain composition over a
`<popup>`, not part of the element.

## Props

Every prop below is on `CodeEditorComponentProps`, which is the component's
own type; `CodeEditorProps` is the element's half of it, without the
completion and focus props.

### Text

| Prop                | Type                            | Notes                                                                       |
| ------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| `value`             | `string`                        | Controlled text (with `onChange`).                                          |
| `defaultValue`      | `string`                        | Uncontrolled initial text.                                                  |
| `onChange`          | `(ev: CodeEditorEvent) => void` |                                                                             |
| `onSubmit`          | `(ev: CodeEditorEvent) => void` | Ctrl+Enter.                                                                 |
| `onSelectionChange` | `(ev: CodeEditorEvent) => void` | Caret or selection moved — what completion UIs track.                       |
| `name`              | `string`                        | Field name, echoed on every event.                                          |
| `placeholder`       | `string`                        |                                                                             |
| `readOnly`          | `boolean`                       | Still navigates and copies.                                                 |
| `disabled`          | `boolean`                       | Inert: no default action runs, and the component stops making it focusable. |

### Language and diagnostics

| Prop          | Type                    | Notes                                                                      |
| ------------- | ----------------------- | -------------------------------------------------------------------------- |
| `language`    | `Language \| null`      | The [language seam](code-language.md). Absent or `null` paints plain text. |
| `tokenStyles` | `TokenStyles`           | Token type → colour/weight/italic. Default `LIGHT_TOKEN_STYLES`.           |
| `diagnostics` | `readonly Diagnostic[]` | Ranges to underline, LSP-shaped.                                           |

### Layout and chrome

| Prop            | Type      | Notes                                              |
| --------------- | --------- | -------------------------------------------------- |
| `rows`          | `number`  | Preferred height in text lines. Default 6.         |
| `tabSize`       | `number`  | Tab display width and indent size. Default 4.      |
| `insertSpaces`  | `boolean` | Indent with spaces (default) or a real tab.        |
| `lineNumbers`   | `boolean` | A gutter.                                          |
| `activeLine`    | `boolean` | Tint the caret's line.                             |
| `matchBrackets` | `boolean` | Highlight the pair around the caret. Default true. |

Colours: `selectionColor`, `caretColor`, `gutterColor`, `gutterBackground`,
`activeLineColor`, `matchingBracketColor`, `placeholderColor`. Each defaults
from the react-x11 theme.

### Completion, focus and the handle

| Prop                | Type                            | Notes                                                                                     |
| ------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `completionSources` | `readonly CompletionSource[]`   | **Absent turns completion off entirely.**                                                 |
| `autoComplete`      | `boolean`                       | Query sources while typing. Default true when sources are given; Ctrl+Space always works. |
| `focusable`         | `boolean`                       |                                                                                           |
| `autoFocus`         | `boolean`                       |                                                                                           |
| `ref`               | `Ref<CodeEditorHandle \| null>` | See below.                                                                                |
| `style`             | `Style \| Style[]`              |                                                                                           |

`onKeyDown`, `onMouseDown`, `onFocus` and `onBlur` pass through. **User
handlers run first**, exactly core's ordering, so calling `preventDefault()`
suppresses the editor's own action.

## Editing

The full expected set: selection by keyboard and mouse with word and line
variants, undo/redo with coalescing, X11 clipboard including PRIMARY and
middle-click paste, auto-indent, Tab/Shift+Tab indentation, Ctrl+/ comment
toggling, bracket matching, and diagnostics squiggles.

**Escape then Tab leaves the field**, so a multiline editor in a form is not
a keyboard trap. Ctrl+Space asks for completions. Ctrl+Enter submits.

## Long lines

A minified file or a log line of a hundred thousand characters is laid out
in pieces of a few hundred characters placed end to end, cut after a
delimiter the text itself picks out, so that a character typed into one
piece leaves the cuts after it where they were. Every question the editor
asks of a line — where a column is, which column is under the pointer — is
asked of one piece, a keystroke shapes the pieces it changed rather than the
line, and only the pieces in view are drawn. Measured on a 100,000-character
line on macOS, putting the caret at its end took 4.3 s as one layout and
2 ms in pieces; typing at the end of a million-character line answers in
13 ms. On X11 a line wider than 32,767 pixels also stops throwing out of the
paint, since no piece reaches that far. What it gives up is shaping across a
seam: a kerning pair or a ligature that straddles one is set as two.

Tokenizing stops 10,000 characters into a line (`TOKENIZE_LIMIT`, the same
cut CodeMirror makes with `maxHighlightLength`): a line is tokenized again
whole on every edit to it, and the rest of a longer one is drawn unstyled.
A construct that opens past the cut and closes on a later line is coloured
as if it had not.

## `CodeEditorHandle`

```ts
ref.current.value = 'select 1';
ref.current.replaceRange(from, to, text);
ref.current.undo();
ref.current.focus();
```

`value` is assignable, which is the DOM-input contract form libraries rely
on: setting it does **not** fire `onChange`. Read-only members:
`name`, `selection`, `lines`, `language`, `canUndo`, `canRedo`. Methods:
`selectedText()`, `replaceRange()`, `insertText()`, `moveCaret()`,
`select()`, `selectAll()`, `undo()`, `redo()`, `indentSelection(dir)`,
`toggleLineComment()`, `copySelection(sel?)`, `pasteFrom(sel?)`,
`scrollBy(dx, dy)`, `caretRect()`, `focus()`, `blur()`.

Every length the handle takes or answers is in **logical pixels**, the unit
a style is written in: `caretRect()` is the caret in the editor's own
coordinates, which is exactly what a `<popup anchor={{ at }}>` takes, and
`scrollBy(dx, dy)` moves by the same unit a `<box>`'s `scrollBy` does —
and the wheel scrolls it the way it scrolls a `<box>` pane, 48 logical
pixels a notch and a touchpad by what it measured. So
are the node's `metrics()` and `measureText()`, for an app laying out its
own overlay against the text. On a 2x panel the editor shapes, hits and
paints its text on the device grid itself; nothing an app touches changes.

## `CodeEditorEvent`

```ts
interface CodeEditorEvent {
  type: 'change' | 'submit' | 'selectionchange';
  value: string;
  name: string | undefined;
  selection: Selection;
  target: CodeEditorHandle;
  currentTarget: CodeEditorHandle;
  nativeEvent: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}
```

Shaped like a React change event on purpose — a form library that already
knows `ev.target.value` and `ev.target.name` needs no adapter.

## Languages

Three ways in, all through [`code-language`](code-language.md):

- **Built-in, zero dependencies** — `sql()`, `shell()`, `glsl()`,
  `javascript()` (`{ typescript: true }` for TS), `json()`. Hand-written
  stream tokenizers on a CodeMirror-5-style line-state engine, or write your
  own with `streamLanguage(…)` in about fifty lines.
- **The CodeMirror grammar world** — `lezerLanguage({ name, parser })` runs
  any `@lezer/<lang>` parser. Install the grammar you want; nothing lezer
  ships with this package.
- **The VS Code grammar world** — `textMateLanguage({ name, grammar })` runs
  an initialized TextMate grammar (via `vscode-textmate`, or shiki's core).
  Their tokenizer is line-state shaped too, so it drops straight in.

## Completion sources

One async function each, deliberately the shape of an LSP
`textDocument/completion` call, so a language-server client is "just another
source":

```ts
type CompletionSource = (
  ctx: CompletionContext,
) => CompletionResult | null | Promise<CompletionResult | null>;
```

Built in: `keywordCompletionSource()`, `wordCompletionSource()`,
`sqlCompletionSource(schema)`. `rankCompletions` is exported so a source of
your own can rank the same way.

## Token themes

`LIGHT_TOKEN_STYLES`, `DARK_TOKEN_STYLES`, `TOKEN_FALLBACK`,
`tokenStyleFor()`, `autoTokenStyles()` and `isDarkBackground()` are all
exported. `autoTokenStyles(background)` is the one to reach for: it picks the
palette that will actually be legible on the background the editor sits on.

## Example

`npm run examples:code-editor` shows the three input-field use cases side by
side.
