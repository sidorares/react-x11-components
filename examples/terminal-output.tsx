// Run with: npm run examples:terminal-output   (needs an X server / DISPLAY)
//
// A captured terminal session, rendered statically — the four shapes a
// capture actually comes in:
//
//  1. a test run, coloured with SGR and nothing else;
//  2. an `npm install` whose progress bar is carriage returns, which is one
//     line here and four hundred in a renderer that treats `\r` as a newline;
//  3. a compiler capture with OSC 8 hyperlinks — click one;
//  4. a `vim` session, which addressed the cursor and therefore reports that
//     it wanted a real screen rather than pretending it did not.
//
// Select across any of them and middle-click-paste into a terminal: the
// escapes are gone, and so is the line numbering.
import { useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import { TerminalOutput } from '../src/index.js';
import type { AnsiDocument } from '../src/index.js';

const ESC = '\u001b';

const TEST_RUN =
  `${ESC}[1m$ npm test${ESC}[0m\n` +
  `\n` +
  `${ESC}[32m✓${ESC}[0m src/parse.test.ts ${ESC}[90m(24 tests) 118ms${ESC}[0m\n` +
  `${ESC}[32m✓${ESC}[0m src/palette.test.ts ${ESC}[90m(9 tests) 12ms${ESC}[0m\n` +
  `${ESC}[31m✗${ESC}[0m src/flow.test.ts ${ESC}[90m(11 tests | 1 failed)${ESC}[0m\n` +
  `\n` +
  `  ${ESC}[41;97m FAIL ${ESC}[0m  ${ESC}[1mcarriage return rewinds inside the line${ESC}[0m\n` +
  `    ${ESC}[31m- expected${ESC}[0m  ${ESC}[32m+ actual${ESC}[0m\n` +
  `    ${ESC}[31m- 100%${ESC}[0m\n` +
  `    ${ESC}[32m+   0%\\r 50%\\r100%${ESC}[0m\n` +
  `\n` +
  `${ESC}[1;38;5;208m Tests ${ESC}[0m ${ESC}[32m43 passed${ESC}[0m | ${ESC}[31m1 failed${ESC}[0m\n` +
  `${ESC}[1;38;5;208m  Time ${ESC}[0m 1.42s\n`;

/** Every frame a progress bar drew, exactly as it was written to the pty. */
const INSTALL = (() => {
  let out = `${ESC}[1m$ npm install${ESC}[0m\n`;
  for (let pct = 0; pct <= 100; pct += 4) {
    const filled = Math.round(pct / 4);
    const bar = '━'.repeat(filled) + `${ESC}[90m` + '━'.repeat(25 - filled);
    out += `\r${ESC}[K${ESC}[36m${bar}${ESC}[0m ${String(pct).padStart(3)}%`;
  }
  return (
    out +
    `\r${ESC}[K${ESC}[32madded 160 packages${ESC}[0m in 4s\n` +
    `\n${ESC}[90m39 packages are looking for funding${ESC}[0m\n`
  );
})();

/** OSC 8: `ESC ] 8 ; ; uri ST  text  ESC ] 8 ; ; ST`. */
const link = (uri: string, text: string): string =>
  `${ESC}]8;;${uri}${ESC}\\${text}${ESC}]8;;${ESC}\\`;

const COMPILE =
  `${ESC}[1m$ cargo build${ESC}[0m\n` +
  `${ESC}[1;32m   Compiling${ESC}[0m termsnap v0.1.0\n` +
  `${ESC}[1;33mwarning${ESC}[0m${ESC}[1m: unused variable: \`cols\`${ESC}[0m\n` +
  `  ${ESC}[1;34m-->${ESC}[0m src/grid.rs:41:9\n` +
  `   ${ESC}[1;34m|${ESC}[0m\n` +
  `${ESC}[1;34m41${ESC}[0m ${ESC}[1;34m|${ESC}[0m     let cols = geometry.width / cell;\n` +
  `   ${ESC}[1;34m|${ESC}[0m         ${ESC}[1;33m^^^^${ESC}[0m ${ESC}[1;33mhelp: prefix it with an underscore${ESC}[0m\n` +
  `   ${ESC}[1;34m|${ESC}[0m\n` +
  `   ${ESC}[1;34m= note:${ESC}[0m see ` +
  link(
    'https://doc.rust-lang.org/rustc/lints/listing/warn-by-default.html',
    '`#[warn(unused_variables)]`',
  ) +
  ` and ` +
  link('https://example.com/termsnap/issues/12', 'issue #12') +
  `\n` +
  `${ESC}[1;32m    Finished${ESC}[0m dev [unoptimized] in 3.11s\n`;

/** A capture that genuinely wanted a grid: absolute addressing throughout. */
const VIM =
  `${ESC}]0;vim src/grid.rs${ESC}\\` +
  `${ESC}[?1049h${ESC}[2J${ESC}[1;1H` +
  `${ESC}[1;1Hfn render(&self) {` +
  `${ESC}[2;1H    let cols = self.width / CELL;` +
  `${ESC}[3;1H}` +
  `${ESC}[24;1H${ESC}[7m src/grid.rs [+]                      3,1  All ${ESC}[0m` +
  `${ESC}[?1049l`;

interface PanelProps {
  title: string;
  data: string;
  terminalColors?: boolean;
  lineNumbers?: boolean;
}

function Panel({
  title,
  data,
  terminalColors,
  lineNumbers,
}: PanelProps): ReactElement {
  const [note, setNote] = useState('');

  return (
    <box style={{ gap: 6 }}>
      <box style={{ flexDirection: 'row', gap: 12, alignItems: 'baseline' }}>
        <text style={{ fontSize: 14, fontWeight: 'bold', color: '$text' }}>
          {title}
        </text>
        <text style={{ fontSize: 12, color: '$textMuted' }}>{note}</text>
      </box>
      <TerminalOutput
        data={data}
        lineNumbers={lineNumbers}
        colors={
          terminalColors
            ? { background: '#101014', foreground: '#e6e6e6' }
            : undefined
        }
        onLink={(href) => setNote(`link: ${href}`)}
        onDocument={(doc: AnsiDocument) => {
          const dropped = Object.entries(doc.dropped)
            .map(([name, n]) => `${name}×${n}`)
            .join(' ');
          setNote(
            doc.needsScreen
              ? `⚠ this capture wanted a real screen — ${dropped}`
              : `${doc.lines.length} lines${doc.title ? ` · ${doc.title}` : ''}`,
          );
        }}
        style={{ maxHeight: 260 }}
      />
    </box>
  );
}

function App(): ReactElement {
  return (
    <window
      width={1120}
      height={560}
      title="TerminalOutput — captured sessions"
    >
      <box
        style={{
          flexGrow: 1,
          flexDirection: 'row',
          padding: 16,
          gap: 16,
          overflow: 'scroll',
        }}
      >
        <box style={{ flex: 1, gap: 18 }}>
          <Panel title="A test run" data={TEST_RUN} lineNumbers />
          <Panel
            title="A progress bar, which is carriage returns"
            data={INSTALL}
          />
        </box>
        <box style={{ flex: 1, gap: 18 }}>
          <Panel
            title="Hyperlinks (OSC 8) — click one"
            data={COMPILE}
            terminalColors
          />
          <Panel title="A full-screen program" data={VIM} />
        </box>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
