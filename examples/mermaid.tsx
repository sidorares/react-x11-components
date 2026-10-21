// Run with: npm run examples:mermaid   (needs a display, and `ondine`
// installed — it is an optional peer: `npm i ondine`)
//
// Mermaid diagrams compiled by ondine and drawn natively, themed from the
// palette: drag across the labels (or Ctrl+A) and middle-click what you
// copied into a terminal; click "docs" in the flowchart to follow its
// link. Inside a `<Markdown>` document a ```mermaid fence renders the same
// way (see examples/markdown.tsx).
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import { Mermaid } from '../src/mermaid/index.js';

const SAMPLES: Array<{ label: string; source: string }> = [
  {
    label: 'A flowchart, with a click link',
    source: `flowchart LR
  A[Request] --> B{Cached?}
  B -->|yes| C[Serve]
  B -->|no| D[(Database)]
  D --> C
  C --> E([docs])
  click E "https://ondine.sh"`,
  },
  {
    label: 'A sequence diagram',
    source: `sequenceDiagram
  participant App
  participant Server
  App->>Server: GET /tiles/14/8/5
  alt cached
    Server-->>App: 304
  else fresh
    Server-->>App: 200 + body
  end`,
  },
  {
    label: 'A class diagram',
    source: `classDiagram
  Node <|-- MermaidNode
  Node : +abs Rect
  Node : +paint(ctx)
  class MermaidNode{
    +scene MermaidScene
    +textContent() string
  }`,
  },
  {
    label: 'A pie chart',
    source: `pie title Where a frame goes
  "layout" : 21
  "paint" : 58
  "compile" : 3`,
  },
  {
    label: 'A git graph — the commit ids are turned 45°',
    source: `gitGraph
  commit
  branch feature
  checkout feature
  commit
  commit
  checkout main
  merge feature
  commit`,
  },
];

function App(): ReactElement {
  return (
    <window width={720} height={760} title="Mermaid — diagrams by ondine">
      <box style={{ flexGrow: 1, overflow: 'scroll' }}>
        <box style={{ flexDirection: 'column', gap: 22, padding: 20 }}>
          {SAMPLES.map((s) => (
            <box key={s.label} style={{ flexDirection: 'column', gap: 8 }}>
              <text style={{ fontSize: 12, color: '$textMuted' }}>
                {s.label}
              </text>
              <Mermaid
                source={s.source}
                selectable
                onLink={(href) => console.log('link:', href)}
              />
            </box>
          ))}
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
