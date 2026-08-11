// Run with: npm run examples:code-editor   (needs an X server / DISPLAY)
//
// The input-field use cases side by side: a SQL box with schema-aware
// completion, a shell one-liner box, and a TSX editor with line numbers, an
// active-line tint and a demo diagnostic. Ctrl+Space asks for completions;
// Ctrl+/ toggles comments; Escape then Tab leaves a field.
//
// Nothing here picks token colours. The editors follow the desktop theme —
// light or dark — and the TSX one shows the other layer: give an editor its
// own `backgroundColor` and the palette follows *that* instead.
import { useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import {
  CodeEditor,
  javascript,
  keywordCompletionSource,
  shell,
  sql,
  sqlCompletionSource,
  wordCompletionSource,
} from '../src/index.js';
import type { Diagnostic } from '../src/index.js';

const SCHEMA = {
  users: ['id', 'name', 'email', 'created_at'],
  orders: ['id', 'user_id', 'total', 'placed_at'],
  products: ['id', 'title', 'price'],
};

const TSX_SAMPLE = `// TSX: tags, attributes, expression containers.
type Row = { id: number; title: string };

export function List({ rows }: { rows: Row[] }): ReactElement {
  const [active, setActive] = useState<number | null>(null);
  return (
    <box style={{ flexGrow: 1, gap: 4 }}>
      {rows.map((row) => (
        <text key={row.id} color={active === row.id ? '$accent' : '$text'}>
          {row.title.toUpperCase()} {/* shouty on purpose */}
        </text>
      ))}
      <StatusLine count={rows.length} />
    </box>
  );
}
`;

const DIAGNOSTICS: readonly Diagnostic[] = [
  {
    from: { line: 4, ch: 9 },
    to: { line: 4, ch: 15 },
    severity: 'warning',
    message: 'active is never read',
  },
];

function Label({ children }: { children: string }): ReactElement {
  return (
    <text style={{ fontSize: 12, fontWeight: 'bold', color: '$dim' }}>
      {children}
    </text>
  );
}

function App(): ReactElement {
  const [query, setQuery] = useState(
    "select u.name, count(*)\nfrom users u\njoin orders o on o.user_id = u.id\nwhere u.created_at > '2026-01-01'\ngroup by u.name;",
  );
  const [submitted, setSubmitted] = useState<string | null>(null);

  return (
    <window
      width={900}
      height={680}
      title="@react-x11/components — code editor"
    >
      <box style={{ flexGrow: 1, padding: 16, gap: 14 }}>
        <Label>SQL — schema-aware completion (try “u.” or Ctrl+Space)</Label>
        <CodeEditor
          language={sql()}
          value={query}
          onChange={(ev) => setQuery(ev.value)}
          onSubmit={(ev) => setSubmitted(ev.value)}
          completionSources={[
            sqlCompletionSource(SCHEMA),
            keywordCompletionSource(),
          ]}
          rows={5}
          placeholder="select …"
          style={{ borderRadius: 4 }}
        />
        <text style={{ fontSize: 11, color: '$dim' }}>
          {submitted
            ? `Ctrl+Enter ran: ${submitted.split('\n')[0]}…`
            : 'Ctrl+Enter “runs” the query.'}
        </text>

        <Label>Shell one-liner</Label>
        <CodeEditor
          language={shell()}
          defaultValue={
            'for f in *.log; do\n  gzip -9 "$f" && echo "packed $f"\ndone'
          }
          completionSources={[
            keywordCompletionSource(),
            wordCompletionSource(),
          ]}
          rows={3}
          style={{ borderRadius: 4 }}
        />

        <Label>TSX — own dark background, palette picked automatically</Label>
        <CodeEditor
          language={javascript({ typescript: true, jsx: true })}
          defaultValue={TSX_SAMPLE}
          completionSources={[
            keywordCompletionSource(),
            wordCompletionSource(),
          ]}
          diagnostics={DIAGNOSTICS}
          lineNumbers
          activeLine
          rows={12}
          style={{
            backgroundColor: '#282c34',
            color: '#abb2bf',
            borderColor: '#1b1f27',
            borderRadius: 4,
          }}
        />
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
