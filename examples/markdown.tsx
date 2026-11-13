// Run with: npm run examples:markdown   (needs an X server / DISPLAY)
//
// A document streams in a few characters at a time — the way model output
// arrives — and the component renders each instant without flashing raw
// syntax. Select with the mouse (double-click a word, triple-click a
// block), Ctrl+A / Ctrl+C, middle-click-paste the PRIMARY selection into a
// terminal. When the stream finishes, `partial` flips off and the tail is
// re-read under final-document rules.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import { Formula } from '../src/formula/index.js';
import { linkKind, Markdown } from '../src/markdown/index.js';
import type { InlineDrawing, LinkKinds } from '../src/markdown/index.js';
import { Mermaid } from '../src/mermaid/index.js';
import type { FenceInfo } from '../src/markdown/index.js';

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

## Mathematics

A \`\`\`math fence renders through \`<Formula>\` — registered below via the
\`fences\` seam, streamed like everything else, and selectable with the rest
of the document:

\`\`\`math
x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}
\`\`\`

## A diagram

A \`\`\`mermaid fence renders through \`<Mermaid>\` the same way — ondine
compiles it (an optional peer: without it the fence stays code), and while
it streams the last diagram that compiled holds the place:

\`\`\`mermaid
flowchart LR
  A[chunk] --> B{parses?}
  B -->|yes| C[render]
  B -->|not yet| D[last good]
\`\`\`

## Links that know what they point at

Rest the pointer on [the parser fix](https://github.com/sidorares/react-x11-components/pull/1476)
or on [the docs session](agent-session://docs-pass): each is an ordinary
link, and a \`links\` kind opens a card with the thing's state as it is now —
which the document never holds.

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

// Module scope, so the map keeps one identity — a new object per render
// would invalidate the block cache. While the fence is still streaming
// (`partial`), the formula and the diagram render their last good state.
const FENCES = {
  math: ({ text, partial }: FenceInfo) => (
    <Formula tex={text} display partial={partial} />
  ),
  mermaid: ({ text, partial }: FenceInfo) => (
    <Mermaid source={text} partial={partial} />
  ),
};

// A stand-in for the application's own state: what a pull request's checks
// and an agent session are doing right now. The cards read it while they are
// up, so it moves under a card that is open.
function useTicking(states: readonly string[], ms: number): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % states.length), ms);
    return () => clearInterval(id);
  }, [states, ms]);
  return states[i];
}

const CHECKS = ['checks running', 'checks passed', 'merged'] as const;
const SESSION = ['in progress', 'waiting on you', 'stopped'] as const;

function PullRequestCard(props: { repo: string; n: number }): ReactElement {
  const state = useTicking(CHECKS, 1500);
  return (
    <box style={{ flexDirection: 'column', gap: 4, width: 260 }}>
      <text style={{ fontWeight: 'bold' }}>{`${props.repo} #${props.n}`}</text>
      <text>{state}</text>
    </box>
  );
}

// A session's state as an application would hold it: outside React, with a
// way to hear it change — which the link's status dot reads through `look`
// and hears through `watch`, and the card reads as it is drawn.
const sessions = (() => {
  let i = 0;
  const heard = new Set<() => void>();
  setInterval(() => {
    i = (i + 1) % SESSION.length;
    for (const f of heard) f();
  }, 1200).unref();
  return {
    get: (): (typeof SESSION)[number] => SESSION[i],
    subscribe(f: () => void): () => void {
      heard.add(f);
      return () => heard.delete(f);
    },
  };
})();

const SESSION_COLOUR: Record<(typeof SESSION)[number], string> = {
  'in progress': '#2da44e',
  'waiting on you': '#bf8700',
  stopped: '#8c959f',
};

// An icon is a drawing a run makes room for. One object per picture: a
// run's fields are compared by identity.
const DOTS = new Map<string, InlineDrawing>();
function dot(colour: string): InlineDrawing {
  let icon = DOTS.get(colour);
  if (!icon) {
    icon = {
      width: 8,
      draw: (ctx, box) => {
        const r = 4 * box.scale;
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(box.x + r, box.baseline - r * 1.1, r, 0, Math.PI * 2);
        ctx.fill();
      },
    };
    DOTS.set(colour, icon);
  }
  return icon;
}

// A pull request's glyph: two branches and the line between them.
const PR_ICON: InlineDrawing = {
  width: 12,
  draw: (ctx, box) => {
    const s = box.scale;
    const x = box.x;
    const top = box.baseline - 11 * s;
    ctx.strokeStyle = '#2da44e';
    ctx.lineWidth = 1.5 * s;
    const ring = (cx: number, cy: number): void => {
      ctx.beginPath();
      ctx.arc(x + cx * s, top + cy * s, 1.8 * s, 0, Math.PI * 2);
      ctx.stroke();
    };
    ring(2.5, 2.5);
    ring(2.5, 10);
    ring(9.5, 10);
    ctx.beginPath();
    ctx.moveTo(x + 2.5 * s, top + 4.3 * s);
    ctx.lineTo(x + 2.5 * s, top + 8.2 * s);
    ctx.moveTo(x + 9.5 * s, top + 8.2 * s);
    ctx.lineTo(x + 9.5 * s, top + 4.5 * s);
    ctx.lineTo(x + 7 * s, top + 2.5 * s);
    ctx.stroke();
  },
};

function SessionCard(props: { id: string; title: string }): ReactElement {
  const state = useSyncExternalStore(sessions.subscribe, sessions.get);
  return (
    <box style={{ flexDirection: 'column', gap: 4, width: 220 }}>
      <text style={{ fontWeight: 'bold' }}>{props.title}</text>
      <text>{`session ${props.id} · ${state}`}</text>
    </box>
  );
}

// Module scope too: a stable list.
const LINKS: LinkKinds = [
  linkKind({
    match: (href) =>
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(href),
    look: () => ({ icon: PR_ICON, underline: false }),
    label: (m, text) => `${m[1]}#${m[2]} · ${text}`,
    card: (m) => <PullRequestCard repo={m[1]} n={Number(m[2])} />,
  }),
  linkKind({
    match: (href) =>
      href.startsWith('agent-session://')
        ? href.slice('agent-session://'.length)
        : null,
    activate: (id) => console.log('open session:', id),
    look: () => ({
      icon: dot(SESSION_COLOUR[sessions.get()]),
      underlineStyle: 'dotted',
    }),
    watch: (_id, changed) => sessions.subscribe(changed),
    card: (id, { text }) => <SessionCard id={id} title={text} />,
  }),
];

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
          fences={FENCES}
          links={LINKS}
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
