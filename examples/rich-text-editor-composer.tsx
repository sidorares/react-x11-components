// Run with: npm run examples:rich-text-editor-composer
//           (an X server / DISPLAY, or REACT_X11_BACKEND=cocoa on a Mac)
//
// A prompt composer: `<RichTextEditor>` as the box an AI agent's prompt is
// typed in. The value is exactly what was typed — `2 * 3` and `src/**/*.ts`
// go out as they are — and the formatting is drawn over it: a fence's lines
// on one band in the code face, coloured by language; a code span on a tint;
// with "markdown", emphasis and headings too. Every marker stays, dimmed.
//
// Try: ``` ```ts ``` and Enter (a new line, not a send) inside the fence,
// Tab and Shift+Tab on its lines, ``` ``` ``` again to close it and Enter to
// send; `@` for a person or a file (an atom: one thing in the editor, one
// token in the value); paste more than ten lines (an attachment — Shift+
// Ctrl+V, Shift+Cmd+V on the Mac, pastes it as text); Up on the first line
// to recall what was sent, Down to come back to the draft.
import { useState } from 'react';
import type { ReactElement } from 'react';
import { Button, createRoot } from 'react-x11';

import {
  RichTextEditor,
  composerParts,
  composerSchema,
} from '../src/rich-text-editor/index.js';
import type {
  ComposerParts,
  Suggester,
} from '../src/rich-text-editor/index.js';

const DRAFT = [
  'Rename `fetchUser` to `loadUser` in src/**/*.ts, keep 2 * 3 as is:',
  '```ts',
  'export async function loadUser(id: string) {',
  '  const res = await fetch(`/users/${id}`); // snake_case_ok',
  '  return res.json();',
  '}',
  '```',
  'Then **check** the _tests_ and ask ',
].join('\n');

/** `@`: people and files, each inserted as a mention atom of its kind. */
const MENTIONS: Suggester[] = [
  {
    char: '@',
    items: ({ query, state }) =>
      [
        { kind: 'user', id: 'u1', label: 'ada', detail: 'Ada Lovelace' },
        { kind: 'user', id: 'u2', label: 'grace', detail: 'Grace Hopper' },
        {
          kind: 'file',
          id: 'src/user.ts',
          label: 'user.ts',
          detail: 'src/user.ts',
        },
        {
          kind: 'file',
          id: 'test/user.test.ts',
          label: 'user.test.ts',
          detail: 'test/user.test.ts',
        },
      ]
        .filter((m) => m.label.startsWith(query.toLowerCase()))
        .map((m) => ({
          label: m.label,
          detail: m.detail,
          insert: state.schema.nodes.mention.create({
            kind: m.kind,
            id: m.id,
            label: m.label,
          }),
        })),
  },
];

type Markup = 'none' | 'code' | 'markdown';

interface Sent {
  value: string;
  parts: ComposerParts;
}

function Label({ children }: { children: string }): ReactElement {
  return (
    <text style={{ fontSize: 12, fontWeight: 'bold', color: '$textMuted' }}>
      {children}
    </text>
  );
}

function SentMessage({ sent }: { sent: Sent }): ReactElement {
  const { mentions, attachments } = sent.parts;
  return (
    <box
      style={{
        gap: 4,
        padding: 8,
        borderWidth: 1,
        borderColor: '$border',
        borderRadius: 6,
      }}
    >
      <text style={{ fontFamily: 'monospace', fontSize: 12 }}>
        {sent.value}
      </text>
      {mentions.length + attachments.length > 0 ? (
        <text style={{ fontSize: 11, color: '$textMuted' }}>
          {[
            ...mentions.map((m) => `${m.token} → ${m.kind} ${m.id}`),
            ...attachments.map(
              (a) =>
                `${a.token} → ${a.kind}, ${
                  typeof a.data === 'string'
                    ? `${a.data.length} characters`
                    : a.data instanceof Uint8Array
                      ? `${a.data.length} bytes of PNG`
                      : 'no data'
                }`,
            ),
          ].join('   ')}
        </text>
      ) : null}
    </box>
  );
}

function App(): ReactElement {
  const [markup, setMarkup] = useState<Markup>('code');
  const [sent, setSent] = useState<Sent[]>([]);
  const [value, setValue] = useState(DRAFT);

  return (
    <window width={760} height={720} title="@react-x11/components — composer">
      <box style={{ flexGrow: 1, gap: 10, padding: 14 }}>
        <Label>Sent — each value exactly as it was typed</Label>
        <box
          style={{
            flexGrow: 1,
            flexBasis: 0,
            overflow: 'scroll',
            gap: 8,
          }}
        >
          {sent.length === 0 ? (
            <text style={{ color: '$textMuted' }}>
              Nothing yet: Enter sends, Shift+Enter is a new line.
            </text>
          ) : (
            sent.map((s, i) => <SentMessage key={i} sent={s} />)
          )}
        </box>

        <box style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          <Label>markup</Label>
          {(['none', 'code', 'markdown'] as const).map((m) => (
            <Button
              key={m}
              label={m === markup ? `• ${m}` : m}
              onPress={() => setMarkup(m)}
            />
          ))}
        </box>
        <RichTextEditor
          format="text"
          markup={markup}
          schema={composerSchema}
          suggestions={MENTIONS}
          pasteAsAttachment
          recall={sent.map((s) => s.value)}
          submitOnEnter
          autoFocus
          value={value}
          onChange={(ev) => setValue(ev.value)}
          onSubmit={(ev) => {
            if (!ev.value.trim()) return;
            setSent((all) => [
              ...all,
              { value: ev.value, parts: composerParts(ev.state.doc) },
            ]);
            setValue('');
          }}
          placeholder="Ask anything — ``` for code, @ for a file"
          style={{ maxHeight: 320 }}
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
