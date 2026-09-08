// Run with: npm run examples:mdx   (needs an X server / DISPLAY)
//
// Components in the prose (docs/prd-mdx.md, M1). The left pane streams a
// document that puts three of them between its paragraphs; the right pane is
// the same source with the `components` prop taken away, which is the whole
// argument for the gate — every tag is text again, and nothing else about
// the document changed.
//
// Nothing here is evaluated. `data={[…]}` and `tone="warn"` are JSON and a
// string, read at parse time, which is what makes this safe to point at a
// document you did not write.
import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createRoot } from 'react-x11';

import { Markdown } from '../src/index.js';

const DOCUMENT = `# Components in the prose

A markdown document, except that it can put a component between two
paragraphs — and still be markdown either side of it.

<Metric label="merged pull requests" value={586} />

The tag above is a \`component\` block. Its attributes were read as JSON at
parse time; **nothing was evaluated** to render it.

<Callout tone="warn">

### Children are markdown too

So a callout can hold a heading, a list —

- one
- two

— and anything else the parser already knew how to read.

</Callout>

A tag nobody claims is left alone: <Unclaimed /> is the literal text it has
always been, and so is a \`{brace}\` in ordinary prose.
`;

const CHUNK = 4;
const TICK_MS = 16;

function Metric({
  label,
  value,
}: {
  label?: unknown;
  value?: unknown;
}): ReactElement {
  return (
    <box
      style={{
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 8,
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 12,
        paddingRight: 12,
        borderRadius: 8,
        backgroundColor: '$surface',
        borderWidth: 1,
        borderColor: '$border',
      }}
    >
      <text style={{ fontSize: 26, fontWeight: 700, color: '$accent' }}>
        {String(value ?? '')}
      </text>
      <text style={{ fontSize: 12, color: '$textMuted' }}>
        {String(label ?? '')}
      </text>
    </box>
  );
}

function Callout({
  tone,
  children,
}: {
  tone?: unknown;
  children?: ReactNode;
}): ReactElement {
  const accent = tone === 'warn' ? '#e17055' : '$accent';
  return (
    <box
      style={{
        flexDirection: 'row',
        gap: 12,
        padding: 12,
        borderRadius: 8,
        backgroundColor: '$surface',
      }}
    >
      <box style={{ width: 3, borderRadius: 2, backgroundColor: accent }} />
      <box style={{ flexGrow: 1 }}>{children}</box>
    </box>
  );
}

// Module scope, so the map keeps one identity: a new object per render
// re-parses the document and defeats the block cache.
const COMPONENTS = { Metric, Callout };

function Pane({
  title,
  source,
  partial,
  components,
}: {
  title: string;
  source: string;
  partial: boolean;
  components?: typeof COMPONENTS;
}): ReactElement {
  return (
    <box style={{ flexGrow: 1, flexBasis: 0, gap: 8 }}>
      <text style={{ fontSize: 11, color: '$textMuted' }}>{title}</text>
      <box style={{ flexGrow: 1, overflow: 'scroll' }}>
        <Markdown
          source={source}
          partial={partial}
          {...(components ? { components } : null)}
          style={{ padding: 12 }}
        />
      </box>
    </box>
  );
}

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

  const source = DOCUMENT.slice(0, length);
  return (
    <window width={900} height={720} title="MDX — components in the prose">
      <box style={{ flexGrow: 1, flexDirection: 'row', gap: 12, padding: 12 }}>
        <Pane
          title="with components"
          source={source}
          partial={!done}
          components={COMPONENTS}
        />
        <Pane title="without the prop" source={source} partial={!done} />
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
