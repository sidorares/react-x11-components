// Type-level test: the `<TerminalOutput>` declarations compile against
// react-x11's JSX namespace, and the parser's types are usable on their own.
import {
  TerminalOutput,
  castOutput,
  parseAnsi,
  parseCast,
} from '../../src/index.js';
import type {
  AnsiDocument,
  TerminalOutputProps,
  TerminalOutputSource,
} from '../../src/index.js';

const LOG = '[32mok[0m\n';

export const asComponent = (
  <box style={{ flexGrow: 1 }}>
    <TerminalOutput
      data={LOG}
      mode="flow"
      colors={{
        background: '#101014',
        foreground: '#e6e6e6',
        palette: ['#000'],
      }}
      tabWidth={4}
      maxLines={5000}
      wrap={false}
      lineNumbers
      selectable
      fontSize={13}
      monoFamily="'JetBrains Mono', monospace"
      onLink={(href: string) => href.length}
      onDocument={(doc: AnsiDocument) => doc.needsScreen}
      style={{ maxWidth: 720 }}
    />
  </box>
);

// bytes, and an array of chunks, are both captures
export const fromBytes = <TerminalOutput data={new Uint8Array([0x6f, 0x6b])} />;
export const fromChunks = <TerminalOutput data={[LOG, new Uint8Array([10])]} />;

// so is a document parsed off the render path
const parsed: AnsiDocument = parseAnsi(LOG);
export const fromDocument = <TerminalOutput data={parsed} />;

// a recording, rendered at a moment
const cast = parseCast('{"version":2,"width":80,"height":24}\n[0.5,"o","hi"]');
export const atAMoment = (
  <TerminalOutput data={castOutput(cast, { until: 1 })} />
);

export const props: TerminalOutputProps = { data: LOG };
export const source: TerminalOutputSource = LOG;

// @ts-expect-error data is required
export const missingData = <TerminalOutput lineNumbers />;

// @ts-expect-error 'screen' is phase 2 — see docs/prd-terminal-output.md
export const noScreenYet = <TerminalOutput data={LOG} mode="screen" />;
