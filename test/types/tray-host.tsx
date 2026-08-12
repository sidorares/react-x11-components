// Type-level test: the props compile against react-x11's JSX namespace, the
// handle is what a `ref` gets, and the ways to get a tray wrong are errors
// rather than runtime surprises.
import { useRef } from 'react';

import { TrayHost } from '../../src/index.js';
import type {
  TrayHostHandle,
  TrayHostProps,
  TrayIcon,
  TrayMessage,
  TrayStatus,
} from '../../src/index.js';

export const asComponent = (
  <box style={{ flexDirection: 'row' }}>
    <TrayHost
      orientation="vertical"
      iconSize={24}
      spacing={4}
      screen={0}
      appName="Panel"
      notify={false}
      sort={(a: TrayIcon, b: TrayIcon) => a.id - b.id}
      onDock={(icon) => icon.id}
      onUndock={(icon) => icon.id}
      onConflict={({ owner, screen }) => [owner, screen]}
      onStatusChange={(status: TrayStatus) => status.length}
      onMessage={(message: TrayMessage) => message.text.length}
      onCancelMessage={({ windowId, id }) => [windowId, id]}
      onError={(err) => err.message}
      fallback={<text>another panel owns the tray</text>}
      style={{ padding: 4 }}
    />
  </box>
);

export function WithHandle(): React.ReactElement {
  const tray = useRef<TrayHostHandle>(null);
  return (
    <box>
      <TrayHost ref={tray} />
      <box onClick={() => tray.current?.icons.length}>count</box>
      <box onClick={() => tray.current?.conflict?.owner}>owner</box>
      <box onClick={() => tray.current?.windowId}>manager window</box>
    </box>
  );
}

export const props: TrayHostProps = { orientation: 'horizontal' };

// @ts-expect-error a tray runs one way or the other, not diagonally
export const badOrientation = <TrayHost orientation="diagonal" />;

// @ts-expect-error icons are docked by applications, not passed in
export const withChildren = <TrayHost>nope</TrayHost>;

export const readOnlyHandle = (h: TrayHostHandle): void => {
  // @ts-expect-error the handle is read-only: docking is the client's move
  h.icons = [];
};
