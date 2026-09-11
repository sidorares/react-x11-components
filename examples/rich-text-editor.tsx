// Run with: npm run examples:rich-text-editor
//           (an X server / DISPLAY, or REACT_X11_BACKEND=cocoa on a Mac)
//
// The two ends of the rich text editor's ladder, side by side.
//
// Left, a notes pane: markdown in and markdown out, the default toolbar, and
// one ProseMirror plugin written the way it would be for a browser — it finds
// "TODO" and decorates it; the editor draws the decoration, because a
// decoration is state, not DOM. The saved value is shown beside it as it
// changes: that string is what an app would write to disk.
//
// Right, a chat composer: no toolbar, Enter sends and Shift+Enter breaks the
// line, it grows with its text up to a height and then scrolls, and sent
// messages render with `<Markdown>` — the same parser, so what was typed is
// what is shown.
//
// Try: `# ` at the start of a line, `- `, `1. `, `[ ] `, `> `, ``` ``` ```,
// `**bold**`, Ctrl+B / Ctrl+I / Ctrl+K (Cmd on the Mac backend), Tab in a
// list, Ctrl+Z, a right click, copy and paste from a web page.
import { useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';
import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

import { Markdown } from '../src/markdown/index.js';
import { RichTextEditor } from '../src/rich-text-editor/index.js';
import type { RichTextEditorHandle } from '../src/rich-text-editor/index.js';

const NOTE = `# Release notes

The editor keeps **markdown** as its value — type it, or use the toolbar.
Everything below round-trips through the same parser \`<Markdown>\` uses.

## This week

- [x] Move the markdown parser where two components can share it
- [ ] Write the docs page
- [ ] ~~Rewrite everything~~ Ship it

1. Press Ctrl+B for **bold** and Ctrl+I for *italic*.
2. Type \`# \` at the start of a line for a heading, \`- \` for a list.
3. Select a word and press Ctrl+K to [link](https://github.com/sidorares/react-x11) it.

> Quotes nest, and hold \`inline code\` like anything else.

\`\`\`ts
export function greet(name: string): string {
  return \`hello, \${name}\`;
}
\`\`\`

| Shortcut | Does |
| :-- | :-- |
| Ctrl+Z | undo |
| Ctrl+Shift+8 | bulleted list |

TODO: this word is a plugin's decoration — a stock ProseMirror \`Plugin\`.
`;

/** A ProseMirror plugin, unchanged from what a browser editor would run. */
function todoPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const found: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (!node.isText || !node.text) return;
          for (const m of node.text.matchAll(/\bTODO\b/g)) {
            const from = pos + (m.index ?? 0);
            found.push(Decoration.inline(from, from + 4, { class: 'todo' }));
          }
        });
        return DecorationSet.create(state.doc, found);
      },
    },
  });
}

function Label({ children }: { children: string }): ReactElement {
  return (
    <text style={{ fontSize: 12, fontWeight: 'bold', color: '$textMuted' }}>
      {children}
    </text>
  );
}

function App(): ReactElement {
  const [saved, setSaved] = useState(NOTE);
  const [messages, setMessages] = useState<string[]>([
    'Hi! **Enter** sends, `Shift+Enter` makes a new line.',
  ]);
  const plugins = useMemo(() => [todoPlugin()], []);
  const composer = useRef<RichTextEditorHandle>(null);

  return (
    <window
      width={1120}
      height={780}
      title="@react-x11/components — rich text editor"
    >
      <box style={{ flexGrow: 1, flexDirection: 'row', gap: 14, padding: 14 }}>
        <box style={{ flexGrow: 1, flexBasis: 0, gap: 8 }}>
          <Label>Notes — markdown in, markdown out</Label>
          <RichTextEditor
            defaultValue={NOTE}
            onChange={(ev) => setSaved(ev.value)}
            toolbar
            plugins={plugins}
            decorationClasses={{
              todo: { bg: '#ffe08a', color: '#5c4400', weight: 700 },
            }}
            placeholder="Write something…"
            onLink={(href) => console.log('open', href)}
            style={{ flexGrow: 1 }}
          />
        </box>

        <box style={{ width: 400, gap: 8 }}>
          <Label>What is saved</Label>
          <box
            style={{
              flexGrow: 1,
              flexBasis: 0,
              overflow: 'scroll',
              borderWidth: 1,
              borderColor: '$border',
              borderRadius: 6,
              padding: 8,
            }}
          >
            <text
              style={{
                fontFamily: 'monospace',
                fontSize: 11,
                color: '$textMuted',
              }}
            >
              {saved}
            </text>
          </box>

          <Label>Chat — Enter sends, Shift+Enter breaks the line</Label>
          <box
            style={{
              height: 180,
              overflow: 'scroll',
              gap: 8,
              borderWidth: 1,
              borderColor: '$border',
              borderRadius: 6,
              padding: 8,
            }}
          >
            {messages.map((message, i) => (
              <Markdown key={i} source={message} partial={false} />
            ))}
          </box>
          <RichTextEditor
            ref={composer}
            placeholder="Message #general"
            submitOnEnter
            onSubmit={(ev) => {
              const text = ev.value.trim();
              if (text) setMessages((all) => [...all, text]);
              composer.current?.setValue('');
            }}
            style={{ maxHeight: 150 }}
          />
        </box>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
