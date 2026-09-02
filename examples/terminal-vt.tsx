// Run with: npm run examples:terminal-vt   (needs an X server / DISPLAY. It
// needs no terminal emulator installed, which is the whole point of this
// backend, and the pty it does need is already a devDependency here —
// `@lydell/node-pty`, 220 KB.)
//
// **On macOS, run it as `REACT_X11_BACKEND=x11 …` under XQuartz.** react-x11
// 2.3 picks its native Cocoa backend there by default, and that backend's
// text engine has no glyph-run seams yet (sidorares/react-x11#432): the
// terminal paints nothing on it and says so once in the console, rather than
// throwing from inside paint.
//
// **`npm install node-pty` in this repo installs nothing**, and exits 0 while
// doing it: this package *declares* node-pty as an optional peer dependency,
// so npm treats the request as already satisfied by the declaration and
// writes only the lockfile. In an app that consumes this package it is an
// ordinary `npm i node-pty`; in here, use `npm i --save-dev node-pty` (and do
// not commit it — 64 MB) if you want to test against that provider rather
// than the fork.
//
// The same component as `terminal.tsx` with one prop changed, and three
// things that only work this way:
//
//  - **`write()` is real.** The pty is ours, so the buttons below type into
//    the shell rather than pretending to.
//  - **The selection is ours too**, so `onSelectionChange` fires and the text
//    lands on PRIMARY for a middle-click paste anywhere else.
//  - **Theme colours apply exactly**, palette and all — this renderer is the
//    one resolving them — and because this is a drawn element rather than a
//    child X window, a `<popup>` would composite *above* it, which over an
//    embedded xterm is impossible.
import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import { Terminal } from '../src/index.js';
import type { TerminalHandle } from '../src/index.js';

function App(): ReactElement {
  const terminal = useRef<TerminalHandle>(null);
  const [title, setTitle] = useState('shell');
  const [status, setStatus] = useState('starting…');
  const [selected, setSelected] = useState('');

  return (
    <window
      width={840}
      height={520}
      title="@react-x11/components — vt Terminal"
    >
      <box style={{ flexGrow: 1, flexDirection: 'column' }}>
        <box
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            padding: 8,
            backgroundColor: '$surfaceHover',
          }}
        >
          <text style={{ fontSize: 13, color: '$text', flexGrow: 1 }}>
            {title}
          </text>
          <text style={{ fontSize: 11, color: '$textMuted' }}>{status}</text>
          {[
            ['ls -la\r', 'ls'],
            ['git status\r', 'git status'],
            ['\x03', 'Ctrl+C'],
          ].map(([bytes, label]) => (
            <box
              key={label}
              style={{
                padding: 6,
                borderRadius: 4,
                backgroundColor: '$surfaceActive',
                cursor: 'pointer',
              }}
              // The reserved method, real at last: straight into the pty.
              onClick={() => terminal.current?.write(bytes)}
            >
              <text style={{ fontSize: 11, color: '$text' }}>{label}</text>
            </box>
          ))}
          <box
            style={{
              padding: 6,
              borderRadius: 4,
              backgroundColor: '$surfaceActive',
              cursor: 'pointer',
            }}
            onClick={() => {
              setStatus('restarting…');
              terminal.current?.restart();
            }}
          >
            <text style={{ fontSize: 11, color: '$text' }}>restart</text>
          </box>
        </box>

        <Terminal
          backend="vt"
          ref={terminal}
          fontFamily="monospace"
          fontSize={14}
          scrollback={5000}
          cursorStyle="block"
          bell="visual"
          style={{ flexGrow: 1, padding: 6 }}
          onTitleChange={setTitle}
          onSelectionChange={setSelected}
          onExit={({ code, signal }) =>
            setStatus(signal ? `killed (${signal})` : `exited ${code}`)
          }
          onError={(err) => setStatus(err.message)}
          fallback={
            // `status` is whatever `onError` last said, which separates "no
            // pty module here" from "there is one and it would not load" —
            // printing a fixed "install node-pty" would be a lie in the
            // second case, and the second case is the confusing one.
            <box style={{ flexGrow: 1, padding: 24, gap: 8 }}>
              <text style={{ fontSize: 13, color: '$text' }}>
                The vt backend is unavailable.
              </text>
              <text style={{ fontSize: 12, color: '$textMuted' }}>
                {status}
              </text>
            </box>
          }
        />

        <box
          style={{
            flexDirection: 'row',
            gap: 8,
            padding: 6,
            backgroundColor: '$surfaceHover',
          }}
        >
          <text style={{ fontSize: 11, color: '$textMuted', flexGrow: 1 }}>
            {selected
              ? `selected ${selected.length} chars — also on PRIMARY`
              : 'drag to select; middle-click pastes; Ctrl+Shift+C/V for the clipboard'}
          </text>
          <text style={{ fontSize: 11, color: '$textMuted' }}>
            Escape then Tab leaves the terminal
          </text>
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
