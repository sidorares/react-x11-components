// Type-level test: every rung of the editor's ladder as a component, the two
// ways of owning the document that must not mix, the raw elements the module
// augmentation adds, and ProseMirror's own types reaching through the seams.
import { useRef, useState } from 'react';
import { EditorState, Plugin } from 'prosemirror-state';
import type { Command, Transaction } from 'prosemirror-state';

import {
  RichTextEditor,
  addColumnBefore,
  addRowAfter,
  columnAlign,
  defaultPlugins,
  deleteColumn,
  deleteRow,
  deleteTable,
  insertTable,
  schema,
  setColumnAlign,
  suggestionState,
  suggestions,
  toolbarItems,
} from '../../src/rich-text-editor/index.js';
import type {
  ColumnAlign,
  DomKeyEvent,
  NodeViewProps,
  RichTextEditorChangeEvent,
  RichTextEditorHandle,
  Suggester,
  SuggestionItem,
  ToolbarEntry,
} from '../../src/rich-text-editor/index.js';

// 1. markdown in and out — a caller who never meets ProseMirror
export function Notes(): React.JSX.Element {
  const [body, setBody] = useState('# Notes');
  return (
    <RichTextEditor
      value={body}
      onChange={(ev: RichTextEditorChangeEvent) => setBody(ev.value)}
      style={{ flexGrow: 1 }}
    />
  );
}

// 2 and 3. chrome, behaviour, what the document is written in and how it looks
const entries: ToolbarEntry[] = [
  'bold',
  'italic',
  '|',
  {
    id: 'clear',
    label: '⌫',
    title: 'Clear',
    run: (state, dispatch) => {
      dispatch?.(state.tr.delete(0, state.doc.content.size));
      return true;
    },
  },
];

function Callout({ children, selected }: NodeViewProps): React.JSX.Element {
  return (
    <box style={{ padding: 8, borderWidth: selected ? 2 : 1 }}>{children}</box>
  );
}

export function Composer(): React.JSX.Element {
  const ref = useRef<RichTextEditorHandle | null>(null);
  return (
    <RichTextEditor
      ref={ref}
      format="html"
      defaultValue="<p>hi</p>"
      placeholder="Message"
      submitOnEnter
      onSubmit={(ev) => void ev.value.trim()}
      onLink={(href, ev) => void [href.length, ev.x]}
      toolbar={entries}
      markStyles={{ strong: { color: '#c00' } }}
      decorationClasses={{ hot: { bg: '#fe0' } }}
      nodeViews={{ blockquote: Callout }}
      renderImage={(image) => <text>{image.alt ?? image.src}</text>}
      styles={{ toolbar: { padding: 2 }, content: { padding: 4 } }}
      history={false}
      typography
    />
  );
}

// a toolbar of the app's own, handed the editor
export const ownToolbar = (
  <RichTextEditor
    defaultValue="x"
    toolbar={(editor) => (
      <box onMouseDown={() => void editor.toggleMark('strong')}>
        <text>{editor.isActive('strong') ? 'B on' : 'B'}</text>
      </box>
    )}
  />
);

// 4. ProseMirror's seams: a plugin as it would be written for a browser,
// view props without a plugin, a schema
const plugin = new Plugin({
  props: {
    handleKeyDown(_view, event) {
      return (event as unknown as DomKeyEvent).key === 'F2';
    },
  },
});

export const withSeams = (
  <RichTextEditor
    schema={schema}
    plugins={[plugin]}
    editorProps={{
      handleTextInput: (view, from, to, text) => {
        if (text !== '!') return false;
        view.dispatch(view.state.tr.insertText('‼', from, to));
        return true;
      },
    }}
  />
);

// 5. the app owns the EditorState outright
export function Owned(): React.JSX.Element {
  const [state, setState] = useState(() =>
    EditorState.create({ schema, plugins: defaultPlugins(schema) }),
  );
  return (
    <RichTextEditor
      state={state}
      dispatchTransaction={(tr: Transaction) => setState((s) => s.apply(tr))}
    />
  );
}

// the handle drives it all without a view in sight
export function drive(editor: RichTextEditorHandle): string {
  editor.toggleMark('strong');
  editor.setBlock('heading', { level: 2 });
  editor.toggleList('bullet_list');
  editor.setValue('# fresh', { addToHistory: true });
  editor.insertContent('<em>x</em>', 'html');
  const pos: number | undefined = editor.view.posAtCoords({
    left: 1,
    top: 1,
  })?.pos;
  void pos;
  return editor.getValue('text');
}

export const boldTitle: string | undefined = toolbarItems(schema).bold?.title;

// importing the component teaches JSX the raw elements too
export const asElement = <richeditor focusable style={{ flexGrow: 1 }} />;
export const asText = <richeditortext runs={[{ text: 'x' }]} />;

export const nodeValue = (
  // @ts-expect-error a value is a string in `format`; a node goes to defaultValue or setValue
  <RichTextEditor value={schema.node('doc', null, [])} />
);

export const twoOwners = (
  // @ts-expect-error an app-owned state and a value would be two owners
  <RichTextEditor
    state={EditorState.create({ schema })}
    dispatchTransaction={() => {}}
    value="x"
  />
);

// @ts-expect-error a state with no dispatchTransaction could never change
export const stuck = <RichTextEditor state={EditorState.create({ schema })} />;

// @ts-expect-error the format is one of three
export const wrongFormat = <RichTextEditor format="rtf" />;

// suggestions: a list the editor filters, a function it asks, a command row —
// and the plugin itself, for an app that owns the state
const people: SuggestionItem[] = [
  { label: 'Ada Lovelace', detail: '@ada', insert: '@ada' },
];
const blockMenu: Suggester = {
  char: '/',
  startOfLine: true,
  items: [
    {
      label: 'Divider',
      command: (state, dispatch) => {
        dispatch?.(state.tr.insertText('---'));
        return true;
      },
    },
  ],
};

export const withSuggestions = (
  <RichTextEditor
    suggestions={[
      { char: '@', items: people },
      {
        char: '#',
        allowSpaces: true,
        items: async ({ query, state }) => [
          { label: query, insert: state.schema.text(`#${query}`) },
        ],
      },
      blockMenu,
    ]}
  />
);

export const listOpen: boolean =
  suggestionState(
    EditorState.create({ schema, plugins: [suggestions([blockMenu])] }),
  ) !== null;

// @ts-expect-error a row needs a label
export const noLabel: SuggestionItem = { insert: '@ada' };

// an app's own row type reaches renderItem, typed
interface Person extends SuggestionItem {
  avatar: string;
}
const crew: Person[] = [{ label: 'Ada', avatar: 'ada.png', insert: '@ada' }];
const crewMentions: Suggester<Person> = {
  char: '@',
  items: crew,
  renderItem: (person, row) => (
    <text style={{ color: row.selected ? '#ffffff' : '#000000' }}>
      {`${person.avatar} ${person.label} ${row.query}`}
    </text>
  ),
};
export const withRows = (
  <RichTextEditor suggestions={[crewMentions, blockMenu]} />
);

// the table commands are commands, for a bar of an app's own
export const tableCommands: Command[] = [
  insertTable(2, 2),
  addRowAfter,
  addColumnBefore,
  deleteRow,
  deleteColumn,
  deleteTable,
  setColumnAlign('center'),
];
export const aligned: ColumnAlign | undefined = columnAlign(
  EditorState.create({ schema }),
);
