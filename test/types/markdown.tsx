// Type-level test: the declarations compile against react-x11's JSX
// namespace, both as a component and as the raw `<richtext>` element the
// shared module's augmentation adds.
import { linkKind, Markdown, parseMarkdown } from '../../src/index.js';
import type { LinkKinds, MarkdownProps, TextRun } from '../../src/index.js';

export const asComponent = (
  <box style={{ overflow: 'scroll', flexGrow: 1 }}>
    <Markdown
      source="# Hello\n\nstreaming **markdown**"
      partial
      selectable
      fontSize={15}
      monoFamily="'JetBrains Mono', monospace"
      onLink={(href, ev) => {
        void href;
        void ev.x;
      }}
      style={{ padding: 12 }}
    />
  </box>
);

// `import`ing the component teaches JSX the shared element too
const runs: TextRun[] = [
  { text: 'plain ' },
  { text: 'bold', weight: 700 },
  { text: ' code', family: 'monospace', bg: '#eee' },
  { text: ' link', href: 'https://x.dev', underline: '#2980b9' },
];
// The element takes the runs and how to lay them out, and nothing about the
// selection: since react-x11#291 that is `selectable` on an ancestor box,
// and the ranges arrive from core.
export const asElement = (
  <box selectable selectionColor="#2980b955">
    <richtext runs={runs} wrap={false} style={{ lineHeight: 1.25 }} />
  </box>
);

export const props: MarkdownProps = { source: 'hi' };

export const doc = parseMarkdown('# t', { partial: true });

// @ts-expect-error source is required
export const missingSource = <Markdown partial />;

// @ts-expect-error a richtext takes runs, not children
export const withChildren = <richtext>nope</richtext>;

// A link kind: its reference type comes from `match`, and the other
// callbacks are checked against it.
const pullRequest = linkKind({
  match: (href) => /\/pull\/(\d+)$/.exec(href),
  activate: (m, link, ev) => {
    void m[1];
    void link.text;
    void ev.x;
  },
  card: (m, ctx) => <text>{`#${m[1]} ${ctx.text}`}</text>,
  cardDelay: 300,
});
const session = linkKind({
  match: (href) =>
    href.startsWith('claude://session/') ? href.slice(17) : null,
  card: (id: string, ctx) => {
    ctx.close();
    return <text>{id}</text>;
  },
});
// kinds of different references sit in one list
const kinds: LinkKinds = [pullRequest, session];
export const withLinks = (
  <Markdown
    source="[#12](https://github.com/o/r/pull/12)"
    links={kinds}
    styles={{ card: { padding: 12, width: 320 } }}
  />
);

// the reference `match` reads and the one `card` takes have to agree
linkKind({
  // @ts-expect-error a number is no string
  match: (href) => href.length,
  card: (n: string) => <text>{n}</text>,
});
