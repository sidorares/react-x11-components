// Type-level test: the props, the handle, and the shape of the two seams a
// panel reaches for — reordering the strip, and taking the balloon messages.
import { useRef } from 'react';

import { TrayHost } from '../../src/index.js';
import type {
  TrayHostHandle,
  TrayHostProps,
  TrayMessage,
  TrayOrientation,
} from '../../src/index.js';

export const asComponent = (
  <box style={{ flexDirection: 'row' }}>
    <TrayHost
      orientation="horizontal"
      iconSize={22}
      spacing={4}
      screen={0}
      appName="Panel"
      onDock={({ windowId }) => windowId}
      onUndock={({ windowId }) => windowId}
      onMessage={(message: TrayMessage) => message.text}
      onMessageCancel={({ windowId, id }) => windowId + id}
      onConflict={({ owner }) => owner}
      onReplaced={() => undefined}
      onStatusChange={(status) => status === 'hosting'}
      onError={(err) => err.message}
      fallback={<text>another tray is running</text>}
      style={{ paddingLeft: 6, paddingRight: 6 }}
    />
  </box>
);

export function WithHandle(): React.ReactElement {
  const tray = useRef<TrayHostHandle>(null);
  return (
    <box>
      <TrayHost ref={tray} orientation="vertical" />
      <text>{String(tray.current?.icons.length ?? 0)}</text>
    </box>
  );
}

/** The reorder seam: ids in, ids out. */
export const sorted: TrayHostProps['order'] = (icons) =>
  [...icons].sort((a, b) => a - b);

export const orientation: TrayOrientation = 'vertical';

export const props: TrayHostProps = { iconSize: 16 };

// @ts-expect-error 'diagonal' is not an orientation
export const badOrientation = <TrayHost orientation="diagonal" />;

// @ts-expect-error iconSize is a number of pixels, not a CSS length
export const cssIconSize = <TrayHost iconSize="22px" />;

// @ts-expect-error the strip draws the icons it is given; there is no slot
export const withChildren = <TrayHost>nope</TrayHost>;
