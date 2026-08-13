# TrayHost

```jsx
import { TrayHost } from '@react-x11/components/tray-host';

<TrayHost
  orientation="horizontal"
  iconSize={22}
  onDock={(icon) => log(`docked ${icon.id}`)}
  onUndock={(icon) => log(`gone ${icon.id}`)}
/>;
```

The system tray, as a component: applications hand it their icon windows and
it draws them in a row. The same XEmbed protocol
[`<Terminal>`](terminal.md) and [`<MediaPlayer>`](media-player.md) use,
pointed the other way — those spawn a program into a container they own; a
tray is handed windows by applications that were already running. The
[system tray spec](http://specifications.freedesktop.org/systemtray/latest/)
is XEmbed's biggest surviving consumer.

Mounting it takes the `_NET_SYSTEM_TRAY_S<screen>` selection with a real
server timestamp, publishes `_NET_SYSTEM_TRAY_ORIENTATION`, and broadcasts
`MANAGER` to the root — which is what makes applications that started before
the panel go and dock themselves. Each `SYSTEM_TRAY_REQUEST_DOCK` becomes one
`<foreign>`; unmounting gives the selection back and hands every client to
the root untouched.

## Props

| Prop          | Type                                     | Notes                                                                                                                                   |
| ------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `orientation` | `'horizontal'` (default) \| `'vertical'` | Which way the icons run, and what `_NET_SYSTEM_TRAY_ORIENTATION` says so an icon can draw itself to match.                              |
| `iconSize`    | `number`                                 | The square each icon is laid out in, in pixels. Default 22.                                                                             |
| `spacing`     | `number`                                 | Between icons. Default 2.                                                                                                               |
| `screen`      | `number`                                 | Which screen's selection to own. Default 0.                                                                                             |
| `sort`        | `(a: TrayIcon, b: TrayIcon) => number`   | Render order. Icons are otherwise in the order they docked. **A comparator, not a list** — see below.                                   |
| `notify`      | `boolean`                                | False stops balloon messages being forwarded to the notification service. Ignored when `onMessage` is given, which already replaces it. |
| `appName`     | `string`                                 | Who a forwarded balloon message is attributed to. Default `'System Tray'`.                                                              |
| `fallback`    | `ReactNode`                              | Rendered instead of the tray when another host owns the selection.                                                                      |
| `style`       | `Style \| Style[]`                       |                                                                                                                                         |
| `ref`         | `Ref<TrayHostHandle>`                    |                                                                                                                                         |

### Events

| Prop              | Type                             | Notes                                                                                                                              |
| ----------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `onDock`          | `(icon: TrayIcon) => void`       | An application asked to be in the tray, and now is.                                                                                |
| `onUndock`        | `(icon: TrayIcon) => void`       | Its window went away — the ordinary end of a tray icon's life, not an error. Also fires for every icon when the selection is lost. |
| `onConflict`      | `(info: TrayConflict) => void`   | Another tray already owns this screen's selection, so this one embeds nothing.                                                     |
| `onStatusChange`  | `(status: TrayStatus) => void`   | `'starting' \| 'owned' \| 'conflict' \| 'released' \| 'unavailable'`.                                                              |
| `onMessage`       | `(message: TrayMessage) => void` | A balloon message. **Providing this turns off the default**, which is to forward the text to the desktop's notification service.   |
| `onCancelMessage` | `(info) => void`                 | A message was withdrawn before it finished arriving.                                                                               |
| `onError`         | `(err: Error) => void`           | Failures on the wire, and a notification that could not be delivered. Without a handler none of it is reported anywhere.           |

## `TrayHostHandle`

```ts
interface TrayHostHandle {
  readonly status: TrayStatus;
  readonly conflict: TrayConflict | null;
  readonly icons: readonly TrayIcon[];
  readonly windowId: number | null; // the manager selection window
}
```

`windowId` is the address clients send opcodes to — useful for a test, and
for a diagnostic that wants to answer "who is the tray?".

## Four decisions, not gaps

- **One tray per display, and a second one says so.** If the selection is
  already owned, the host reports it through `onConflict`, renders
  `fallback`, and embeds nothing. A second panel is a configuration mistake,
  not an exception to throw. Losing the selection later — another tray
  started — releases every icon, because a panel still drawing icons it no
  longer holds is the failure users report as "my tray is empty".
- **A visual is advertised only when there is one.**
  `_NET_SYSTEM_TRAY_VISUAL` appears only when the window the icons are
  embedded into genuinely carries a 32-bit ARGB visual. Put the tray in a
  `<window transparent>` and icons get real translucency; anywhere else they
  fall back to guessing a background rather than drawing black boxes.
- **Icons are not tab stops.** Every icon is `focusable={false}`: a tray icon
  is a click target, and Tab walking through eleven of them — several of
  which may not have mapped yet — is the worst version of this.
- **Reordering moves nodes, it does not re-embed clients.** `sort` is a
  comparator rather than a list you rebuild, because each `<foreign>` is
  keyed on the window id and its `windowId` never changes. Unmounting one
  node and mounting another with the same id parks the client at the root
  long enough for a window manager to frame it, and the new node then reports
  `onClientGone` for a live window.

## Balloon messages

`SYSTEM_TRAY_BEGIN_MESSAGE` is the pre-notification-daemon way an icon says
something. The text arrives in 20-byte `ClientMessage` chunks; this component
reassembles them, decodes UTF-8 (malformed bytes do not throw), and by
default forwards the result to the desktop's notification service.

```ts
interface TrayMessage {
  readonly windowId: number; // the icon that is talking
  readonly id: number; // the client's own id — what a cancel names
  readonly timeout: number; // ms; 0 means "until dismissed", as the spec means it
  readonly text: string;
}
```

Pass `onMessage` to draw your own bubble instead — that turns the forwarding
off, because a panel that draws its own bubble should not also raise a
notification. Pass `notify={false}` to drop them entirely.

## Lower-level exports

`TrayManager` is the protocol on its own, without React:
selection ownership, `MANAGER` broadcast, dock requests, `SelectionClear`.
`BalloonAssembler` reassembles the chunked messages and `BalloonNotifier`
delivers them. Also exported: `ORIENTATION_HORIZONTAL`,
`ORIENTATION_VERTICAL`, `SYSTEM_TRAY_BEGIN_MESSAGE`,
`SYSTEM_TRAY_CANCEL_MESSAGE`, `SYSTEM_TRAY_REQUEST_DOCK`, `argbVisualOf`,
`orientationValue` and `selectionNameFor`.

## Not in this component

**StatusNotifierItem.** Modern applications publish a tray icon over D-Bus, a
complete panel supports both, and SNI shares nothing with this except intent
— it pairs with core's `dbusmenu.js`, not with `<foreign>`. It belongs beside
`<TrayHost>` rather than inside it, and is planned as its own module.

## Example

`npm run examples:tray-host` is a one-row panel that is the tray for its
display. It needs a real `$DISPLAY` with no tray on it yet.
