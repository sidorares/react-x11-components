// Type-level test: the declarations compile against react-x11's JSX
// namespace, both as a component and as the raw `<mdtext>` element the
// module augmentation adds.
import { Markdown, MarkdownSelection, parseMarkdown } from '../../src/index.js';
import type { MarkdownProps, MdRun } from '../../src/index.js';

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

// `import`ing the component teaches JSX the element too
const runs: MdRun[] = [
  { text: 'plain ' },
  { text: 'bold', weight: 700 },
  { text: ' code', family: 'monospace', bg: '#eee' },
  { text: ' link', href: 'https://x.dev', underline: '#2980b9' },
];
const selection = new MarkdownSelection();
export const asElement = (
  <mdtext runs={runs} order={0} registry={selection} joiner={'\n'} />
);

export const props: MarkdownProps = { source: 'hi' };

export const doc = parseMarkdown('# t', { partial: true });

// @ts-expect-error source is required
export const missingSource = <Markdown partial />;

// @ts-expect-error an mdtext takes runs, not children
export const withChildren = <mdtext>nope</mdtext>;
