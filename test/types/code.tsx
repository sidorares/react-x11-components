// Type-level test: the `<Code>` declarations compile against react-x11's
// JSX namespace.
import { Code, javascript, DARK_TOKEN_STYLES } from '../../src/index.js';
import type { CodeProps } from '../../src/index.js';

export const asComponent = (
  <box style={{ flexGrow: 1 }}>
    <Code
      source={'const x = 1;\n'}
      lang="ts"
      lineNumbers
      wrap={false}
      selectable
      fontSize={13}
      monoFamily="'JetBrains Mono', monospace"
      tokenStyles={DARK_TOKEN_STYLES}
      style={{ maxWidth: 640 }}
    />
  </box>
);

// an explicit Language beats the tag
export const withLanguage = (
  <Code source="let a" language={javascript({ typescript: true })} />
);

export const props: CodeProps = { source: 'x' };

// @ts-expect-error source is required
export const missingSource = <Code lang="js" />;
