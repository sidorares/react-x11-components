// Run with: npm run examples:tray   (needs an X server / DISPLAY)
//
// A panel strip that is the display's system tray. Start it, then start
// something with a tray icon and watch it appear:
//
//   yad --notification --text "hello"
//   nm-applet
//   blueman-applet
//
// **One tray per display.** If a real panel is already running — most desktops
// have one — this reports `conflict` and embeds nothing rather than fighting
// it for the selection. Try it inside a nested server to see it host for real:
//
//   Xephyr :9 -screen 900x60 & DISPLAY=:9 npm run examples:tray
//
// The balloon-message half is wired to the panel rather than to the desktop's
// notification service, which is what `onMessage` is for: without it the
// message would be forwarded to `org.freedesktop.Notifications` instead.
import { useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import { TrayHost } from '../src/index.js';
import type { TrayHostStatus, TrayMessage } from '../src/index.js';

const EXPLANATION: Record<TrayHostStatus, string> = {
  starting: 'taking the selection…',
  hosting: 'this is the tray',
  conflict: 'another tray owns the selection',
  replaced: 'another tray took over',
  unavailable: 'no tray to be had on this display',
};

function App(): ReactElement {
  const [status, setStatus] = useState<TrayHostStatus>('starting');
  const [icons, setIcons] = useState<number[]>([]);
  const [balloon, setBalloon] = useState<TrayMessage | null>(null);

  return (
    // A `<window transparent>` here is what would make the host advertise
    // `_NET_SYSTEM_TRAY_VISUAL`, so icons could draw themselves with real
    // translucency. It is left off because without a compositor running the
    // transparent parts of the panel come out black.
    <window width={900} height={56} title="@react-x11/components — TrayHost">
      <box
        style={{
          flexGrow: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          padding: 8,
          backgroundColor: '$surfaceHover',
        }}
      >
        <text style={{ fontSize: 13, color: '$text' }}>System tray</text>

        <TrayHost
          iconSize={22}
          spacing={4}
          onStatusChange={setStatus}
          onDock={({ windowId }) =>
            setIcons((prev) => [...new Set([...prev, windowId])])
          }
          onUndock={({ windowId }) =>
            setIcons((prev) => prev.filter((id) => id !== windowId))
          }
          onMessage={setBalloon}
          onMessageCancel={() => setBalloon(null)}
          style={{ paddingLeft: 8, paddingRight: 8 }}
          fallback={
            <text style={{ fontSize: 11, color: '$dim' }}>
              {EXPLANATION[status]}
            </text>
          }
        />

        <box style={{ flexGrow: 1 }} />

        {balloon ? (
          <box
            style={{
              padding: 6,
              borderRadius: 4,
              backgroundColor: '$surfaceActive',
              cursor: 'pointer',
            }}
            onClick={() => setBalloon(null)}
          >
            <text style={{ fontSize: 11, color: '$text' }}>{balloon.text}</text>
          </box>
        ) : null}

        <text style={{ fontSize: 11, color: '$dim' }}>
          {`${icons.length} icon${icons.length === 1 ? '' : 's'} — ${
            EXPLANATION[status]
          }`}
        </text>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
