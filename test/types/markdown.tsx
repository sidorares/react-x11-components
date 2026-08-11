// Type-level test: the declarations compile against react-x11's JSX
// namespace, both as a component and as the raw `<richtext>` element the
// shared module's augmentation adds.
import { Markdown, TextSelection, parseMarkdown } from '../../src/index.js';
import type { MarkdownProps, TextRun } from '../../src/index.js';

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
const selection = new TextSelection();
export const asElement = (
  <richtext runs={runs} order={0} registry={selection} joiner={'\n'} />
);

export const props: MarkdownProps = { source: 'hi' };

export const doc = parseMarkdown('# t', { partial: true });

// @ts-expect-error source is required
export const missingSource = <Markdown partial />;

// @ts-expect-error a richtext takes runs, not children
export const withChildren = <richtext>nope</richtext>;
