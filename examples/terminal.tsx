// Run with: npm run examples:terminal   (needs an X server / DISPLAY, and a
// terminal emulator installed — xterm, urxvt or alacritty)
//
// A terminal pane with a title bar that follows what the shell says is
// running, and a button that restarts it. Everything interesting is in two
// props: the emulator is spawned into the `<foreign>` this renders, and its
// `_NET_WM_NAME` is what `onTitleChange` reports.
import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import { Terminal } from '../src/index.js';
import type { TerminalHandle } from '../src/index.js';

function App(): ReactElement {
  const terminal = useRef<TerminalHandle>(null);
  const [title, setTitle] = useState('shell');
  const [status, setStatus] = useState('starting…');

  return (
    <window width={720} height={420} title="@react-x11/components — Terminal">
      <box style={{ flexGrow: 1, flexDirection: 'column' }}>
        <box
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            padding: 8,
            backgroundColor: '$surface',
          }}
        >
          <text style={{ fontSize: 13, color: '$text', flexGrow: 1 }}>
            {title}
          </text>
          <text style={{ fontSize: 11, color: '$dim' }}>{status}</text>
          <box
            style={{
              padding: 6,
              borderRadius: 4,
              backgroundColor: '$surfaceHover',
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
          ref={terminal}
          style={{ flexGrow: 1 }}
          onTitleChange={setTitle}
          onExit={({ code, signal }) =>
            setStatus(signal ? `killed (${signal})` : `exited ${code}`)
          }
          onError={(err) => setStatus(err.message)}
          fallback={
            <box style={{ flexGrow: 1, padding: 24 }}>
              <text style={{ fontSize: 13, color: '$dim' }}>
                No terminal emulator found. Install one of xterm, rxvt-unicode
                or alacritty.
              </text>
            </box>
          }
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
