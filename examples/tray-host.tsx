// Run with: npm run examples:tray-host   (needs a real $DISPLAY, and no
// other panel already owning _NET_SYSTEM_TRAY_S0 — stop the desktop's tray,
// or run this in a nested server: Xephyr :2 -screen 900x120 & DISPLAY=:2 …)
//
// A one-row panel that is the system tray for its display. Start anything
// with a tray icon afterwards — `nm-applet`, `blueman-applet`, `pidgin`,
// `volumeicon` — and it docks itself into the row; quit it and the icon
// goes. Balloon messages an icon sends are forwarded to the desktop's
// notification service, which is the default; this one intercepts them so
// the status line can show what was said.
import { useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import { TrayHost } from '../src/index.js';
import type { TrayStatus } from '../src/index.js';

function App(): ReactElement {
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState<TrayStatus>('starting');
  const [said, setSaid] = useState('');

  const label =
    status === 'conflict'
      ? 'another panel owns the tray'
      : status === 'owned'
        ? `${count} icon${count === 1 ? '' : 's'}`
        : status;

  return (
    <window width={640} height={56} title="@react-x11/components — TrayHost">
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
        <text style={{ fontSize: 12, color: '$text' }}>tray</text>

        <TrayHost
          orientation="horizontal"
          iconSize={22}
          spacing={4}
          style={{ paddingLeft: 4, paddingRight: 4 }}
          onDock={() => setCount((n) => n + 1)}
          onUndock={() => setCount((n) => Math.max(0, n - 1))}
          onStatusChange={setStatus}
          // Remove this and the same message goes to the desktop's
          // notification daemon instead, which is what a panel usually wants.
          onMessage={(message) => setSaid(message.text)}
          onError={(err) => setSaid(err.message)}
          fallback={
            <text style={{ fontSize: 11, color: '$textMuted' }}>
              tray taken — stop the desktop panel and restart
            </text>
          }
        />

        <box style={{ flexGrow: 1 }} />
        <text style={{ fontSize: 11, color: '$textMuted' }}>
          {said || label}
        </text>
      </box>
    </window>
  );
}

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
