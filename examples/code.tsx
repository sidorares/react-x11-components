// Run with: npm run examples:code   (needs an X server / DISPLAY)
//
// A static code block: highlighted through the same language seam the
// code editor tokenizes with, selectable through the same element the
// markdown renderer draws. Select some lines and middle-click-paste them
// into a terminal — the gutter numbers stay out of the copy.
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import { Code } from '../src/index.js';

const SNIPPET = `// the language seam at work
export function greet(name: string): string {
  const upper = name.toUpperCase();
  return \`hello, \${upper}!\`; // template literal, nested \${}
}

/* block comment */
const answer = 0x2a; // 42
`;

const SHELL = `#!/bin/sh
for f in *.ts; do
  echo "checking $f"
done
`;

function App(): ReactElement {
  return (
    <window width={560} height={480} title="Code — static blocks">
      <box style={{ flexGrow: 1, padding: 16, gap: 12, overflow: 'scroll' }}>
        <text style={{ fontSize: 14, color: '$text' }}>
          TypeScript, numbered
        </text>
        <Code source={SNIPPET} lang="ts" lineNumbers />
        <text style={{ fontSize: 14, color: '$text' }}>Shell</text>
        <Code source={SHELL} lang="sh" />
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
