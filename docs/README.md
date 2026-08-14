# @react-x11/components

The reference for the components this package ships. The
[README](https://github.com/sidorares/react-x11-components/blob/master/README.md)
is the tour — what the package is for, and why a given component is here
rather than in [react-x11](https://github.com/sidorares/react-x11) core. These
pages are the details: props, handles, events, and the decisions behind them.

Every page is one directory under `src/`, and that is not a coincidence —
`test/docs.test.ts` fails if a component has no page or a page has no
component.

## Components

| Page                                               | Import                                   | What it is                                                   |
| -------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| [Calendar / DatePicker](components/calendar.md)    | `@react-x11/components/calendar`         | A month grid: one date or a range, any day blockable.        |
| [Charts](components/charts.md)                     | `@react-x11/components/charts`           | Cartesian charts; a million points is a normal input.        |
| [Code](components/code.md)                         | `@react-x11/components/code`             | A static code block: highlighted, selectable.                |
| [CodeEditor](components/code-editor.md)            | `@react-x11/components/code-editor`      | Multiline code editing: highlighting, completion.            |
| [Flow](components/flow.md)                         | `@react-x11/components/flow`             | A directed-graph editor: nodes, edges, pan and zoom.         |
| [Markdown](components/markdown.md)                 | `@react-x11/components/markdown`         | Streaming-friendly GFM with cross-block selection.           |
| [MediaPlayer](components/media-player.md)          | `@react-x11/components/media-player`     | mpv or VLC, embedded, with real transport control.           |
| [Table](components/table.md)                       | `@react-x11/components/table`            | A data table: sortable, virtualized, any row height.         |
| [Terminal](components/terminal.md)                 | `@react-x11/components/terminal`         | A real terminal: an embedded emulator, or its own.           |
| [TerminalOutput](components/terminal-output.md)    | `@react-x11/components/terminal-output`  | A captured session, rendered. `<Terminal>`'s static sibling. |
| [Timeline](components/timeline.md)                 | `@react-x11/components/timeline`         | A run of events: a mark per step, a line between.            |
| [TrayHost](components/tray-host.md)                | `@react-x11/components/tray-host`        | The system tray: applications dock their icons in.           |
| [Tree](components/tree.md)                         | `@react-x11/components/tree`             | A disclosure tree: seams throughout, and virtualized.        |
| [Desktop calendar](components/desktop-calendar.md) | `@react-x11/components/desktop-calendar` | The user's real calendar events, over D-Bus. A hook.         |

## Shared modules

These are not components — they register nothing, render nothing at import
time, and exist because more than one component needs them. They have their
own subpaths because an app building a surface of its own needs the same
parts.

| Page                                         | Import                                | What it is                                         |
| -------------------------------------------- | ------------------------------------- | -------------------------------------------------- |
| [ansi](components/ansi.md)                   | `@react-x11/components/ansi`          | A captured terminal session, as a document.        |
| [richtext](components/richtext.md)           | `@react-x11/components/richtext`      | The styled-text element a document selects across. |
| [codeblock](components/codeblock.md)         | `@react-x11/components/codeblock`     | The look of a block of code.                       |
| [code-language](components/code-language.md) | `@react-x11/components/code-language` | The tokenizer seam, the languages, the palettes.   |
| [embed](components/embed.md)                 | `@react-x11/components/embed`         | The spawn, watch and hand-back lifecycle.          |

## Design documents

- [A pure-JS VT backend for `<Terminal>`](prd-vt-terminal.md) — the design
  behind `backend="vt"`.
- [Composable, cost-bounded charts](prd-charts.md) — the decimation
  pyramid, the command-stream/pixel crossover, and the tooltip-popup
  policy behind `/charts`.
- [Rendering a captured session](prd-terminal-output.md) — why a log is a
  document rather than a grid, and what `/ansi` and `<TerminalOutput>` can
  and cannot represent.
- [The data table](prd-table.md) — proposed: the prior-art survey, the
  successor contract with core's `<Table>`, and the variable-height
  virtualization it shares with the tree.

## Conventions these pages follow

- **Props tables list what the component reads**, with the default in the
  description rather than a column of its own — most defaults are a sentence,
  not a value.
- **Styling is `style`, always.** No component invents a `className` or a
  `width` prop; the root box takes react-x11's `style`, and that is where
  width, padding and `flexGrow` go.
- **`data-testname` is on every component** that renders a host element, for
  `react-x11/test`'s queries.
- **Nothing here is a hard dependency.** Where a component needs a program or
  a native module, "it is not installed" is an ordinary state with a
  `fallback` and a `status`, never a throw.
