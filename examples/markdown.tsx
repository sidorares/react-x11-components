// Run with: npm run examples:markdown   (needs an X server / DISPLAY)
//
// A document streams in a few characters at a time — the way model output
// arrives — and the component renders each instant without flashing raw
// syntax. Select with the mouse (double-click a word, triple-click a
// block), Ctrl+A / Ctrl+C, middle-click-paste the PRIMARY selection into a
// terminal. When the stream finishes, `partial` flips off and the tail is
// re-read under final-document rules.
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import { Markdown } from '../src/index.js';

const DOCUMENT = `# Streaming markdown

This document arrives a few characters at a time, with **bold**, *italics*,
~~corrections~~, \`inline code\` and [links](https://github.com/sidorares/react-x11)
rendered the moment they can be read — never as raw markers.

## A list, growing

- selection works **across** blocks
- double-click selects a word
- [x] tasks render too

## Code

\`\`\`js
function greet(name) {
  // strings, keywords and comments take their colours from the theme
  return \`hello, \${name}\`;
}
\`\`\`

## And a table

| feature | status | notes |
| :------ | :----: | ----- |
| selection | done | PRIMARY on release |
| streaming | done | per-block caching |
| MDX | planned | see the roadmap |

> Watch the tail of the document while it streams: an unclosed \`**\` or a
> half-arrived link never leaks its syntax onto the screen.
`;

const CHUNK = 3;
const TICK_MS = 16;

function App(): ReactElement {
  const [length, setLength] = useState(0);
  const done = length >= DOCUMENT.length;

  useEffect(() => {
    if (done) return;
    const id = setTimeout(
      () => setLength((n) => Math.min(n + CHUNK, DOCUMENT.length)),
      TICK_MS,
    );
    return () => clearTimeout(id);
  }, [length, done]);

  return (
    <window width={560} height={640} title="Markdown — streaming">
      <box style={{ flexGrow: 1, overflow: 'scroll' }}>
        <Markdown
          source={DOCUMENT.slice(0, length)}
          partial={!done}
          onLink={(href) => console.log('link:', href)}
          style={{ padding: 16 }}
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
