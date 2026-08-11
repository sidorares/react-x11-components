// Type-level test: the editor's props as a component, the raw element the
// module augmentation adds, and the language seam's shapes — including that
// an adapter for a foreign ecosystem typechecks with no dependency on it.
import { useRef } from 'react';

import {
  CodeEditor,
  DARK_TOKEN_STYLES,
  javascript,
  keywordCompletionSource,
  lezerLanguage,
  sql,
  sqlCompletionSource,
  streamLanguage,
  textMateLanguage,
} from '../../src/index.js';
import type {
  CodeEditorEvent,
  CodeEditorHandle,
  CompletionSource,
  Diagnostic,
  Language,
  Token,
} from '../../src/index.js';

const diagnostics: Diagnostic[] = [
  {
    from: { line: 0, ch: 2 },
    to: { line: 0, ch: 5 },
    severity: 'warning',
    message: 'hm',
  },
];

const mySource: CompletionSource = (ctx) =>
  ctx.word.text.length > 0
    ? { items: [{ label: 'thing', detail: 'mine', boost: 1 }] }
    : null;

export function AsComponent(): React.JSX.Element {
  const ref = useRef<CodeEditorHandle | null>(null);
  return (
    <box style={{ flexGrow: 1 }}>
      <CodeEditor
        ref={ref}
        language={sql({ hashComments: true })}
        defaultValue="select 1"
        onChange={(ev: CodeEditorEvent) => void ev.value.toUpperCase()}
        onSubmit={(ev) => void ev.selection.head.line}
        completionSources={[
          keywordCompletionSource(),
          sqlCompletionSource({ users: ['id'] }),
          mySource,
        ]}
        tokenStyles={DARK_TOKEN_STYLES}
        diagnostics={diagnostics}
        lineNumbers
        activeLine
        rows={8}
        tabSize={2}
        onKeyDown={(ev) => void ev.keysym}
        style={{ flexGrow: 1, fontSize: 14 }}
      />
    </box>
  );
}

// importing the component teaches JSX the raw element too
export const asElement = (
  <codeeditor
    defaultValue="x"
    language={javascript({ typescript: true })}
    style={{ width: 200 }}
  />
);

// a custom language is a plain object — the seam is structural
export const custom: Language = streamLanguage<{ n: number }>({
  name: 'counting',
  startState: () => ({ n: 0 }),
  token(stream, state) {
    state.n++;
    stream.skipToEnd();
    return state.n % 2 ? 'comment' : null;
  },
});

// adapters typecheck against structural fakes — no @lezer/*, no
// vscode-textmate in the type graph
export const viaLezer = lezerLanguage({
  name: 'fake',
  parser: { parse: (input: string) => ({ input }) },
});

export const viaTextMate = textMateLanguage({
  name: 'fake',
  grammar: {
    tokenizeLine: (line: string) => ({
      tokens: [{ startIndex: 0, endIndex: line.length, scopes: ['comment'] }],
      ruleStack: { equals: () => true },
    }),
  },
});

export const token: Token = { from: 0, to: 1, type: 'keyword' };

// @ts-expect-error value is a string, not lines
export const wrongValue = <CodeEditor value={['a', 'b']} />;

// @ts-expect-error diagnostics take positions, not offsets
export const wrongDiag = <CodeEditor diagnostics={[{ from: 0, to: 3 }]} />;

// @ts-expect-error a code editor takes no children
export const withChildren = <CodeEditor>nope</CodeEditor>;
