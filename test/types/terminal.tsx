// Type-level test: the props compile against react-x11's JSX namespace, the
// handle is what a `ref` gets, and the two ways to get a terminal wrong are
// errors rather than runtime surprises.
import { useRef } from 'react';

import { Terminal } from '../../src/index.js';
import type { TerminalHandle, TerminalProps } from '../../src/index.js';

export const asComponent = (
  <box style={{ flexGrow: 1 }}>
    <Terminal
      command={['bash', '-lc', 'npm test']}
      cwd="/tmp"
      env={{ TERM: 'xterm-256color' }}
      backend="xterm"
      fontSize={13}
      fontFamily="Fira Code"
      scrollback={5000}
      colors={{ background: '#101014', palette: ['#000', '#f00'] }}
      style={{ flexGrow: 1 }}
      onExit={({ code, signal }) => [code, signal]}
      onTitleChange={(title) => title.length}
      onError={(err) => err.message}
      fallback={<text>install xterm</text>}
    />
  </box>
);

export function WithHandle(): React.ReactElement {
  const terminal = useRef<TerminalHandle>(null);
  return (
    <box>
      <Terminal ref={terminal} />
      <box onClick={() => terminal.current?.restart()}>restart</box>
      <box onClick={() => terminal.current?.signal('SIGINT')}>stop</box>
    </box>
  );
}

/**
 * The ladder the PRD promises: an app that renders `<Terminal>` today gets
 * the vt backend by changing **one prop**, and everything it already passes
 * keeps its meaning.
 */
export const sameProps = (
  <Terminal
    backend="vt"
    command={['bash', '-lc', 'npm test']}
    cwd="/tmp"
    env={{ TERM: 'xterm-256color' }}
    fontSize={13}
    fontFamily="Fira Code"
    scrollback={5000}
    colors={{ background: '#101014', palette: ['#000', '#f00'] }}
    style={{ flexGrow: 1 }}
    onExit={({ code }) => code}
    onTitleChange={(title) => title.length}
    fallback={<text>npm i node-pty</text>}
    // vt-only, and compatible additions rather than a second props type
    cursorStyle="bar"
    cursorBlink={false}
    bell="visual"
    onBell={() => {}}
    allowClipboardWrite
    onSelectionChange={(text) => text.length}
  />
);

export function WithVtHandle(): React.ReactElement {
  const terminal = useRef<TerminalHandle>(null);
  return (
    <box>
      <Terminal backend="vt" ref={terminal} />
      {/* the reserved method, real on this backend */}
      <box onClick={() => terminal.current?.write('ls\r')}>list</box>
      <box onClick={() => terminal.current?.scrollLines(-10)}>back</box>
      <box onClick={() => terminal.current?.clearSelection()}>deselect</box>
    </box>
  );
}

/** The pty seam is a public type, and a fake satisfies it. */
export const withPty = (
  <Terminal
    backend="vt"
    pty={{
      available: async () => true,
      openPty: async () => ({
        write() {},
        resize() {},
        kill: () => true,
        onData() {},
        onExit() {},
        pid: 1,
      }),
    }}
  />
);

export const props: TerminalProps = { command: ['zsh'] };

// A `readonly string[]` is what a `useMemo` over a literal produces, and the
// prop takes it.
const argv: readonly string[] = ['bash', '-l'];
export const readonlyCommand = <Terminal command={argv} />;

// @ts-expect-error the command is argv, not a shell line
export const stringCommand = <Terminal command="npm test" />;

// @ts-expect-error 'kitty' has no embed flag this package knows
export const unknownBackend = <Terminal backend="kitty" />;

// @ts-expect-error a terminal has no children — the client's window covers it
export const withChildren = <Terminal>nope</Terminal>;
