# MediaPlayer

```jsx
import { MediaPlayer } from '@react-x11/components/media-player';

<MediaPlayer
  src={file}
  aspectRatio="16:9"
  volume={0.8}
  style={{ flexGrow: 1 }}
  onProgress={({ position, duration }) => setScrub(position / duration)}
  onEnded={next}
/>;
```

mpv or VLC, embedded in a react-x11 window, with real transport control
rather than a respawn per action. The same component as
[`<Terminal>`](terminal.md) with different argv — both are built on
[`embed`](embed.md) and core's `<foreign>`.

`backend` defaults to `'auto'`: mpv if it is installed, else VLC. With
neither, `fallback` renders and `onError` gets a `BackendUnavailableError`
naming what was looked for. That is an ordinary state of a healthy machine,
not an exception.

**X11-only.** Both players are embedded by handing them an X window id
(`--wid`, `--drawable-xid`), which is XEmbed's mechanism, and macOS has no
cross-process window embedding at all — react-x11's own
[macOS backend document](https://github.com/sidorares/react-x11/blob/master/docs/macos.md)
names this component among what has no equivalent there.

On that backend the player says so up front, rather than spawning at a
window id that does not exist: `status` is `'unavailable'` from the first
render, `fallback` renders, and
`onError` gets an `EmbedUnsupportedError` saying this backend cannot embed
another program's window. Nothing is looked for on `PATH` and nothing is
spawned. It is the same ordinary state as a machine with no player, told
apart by the error's class, because "install mpv" is the wrong advice there.
Unlike [`<Terminal>`](terminal.md), which has `backend="vt"` to fall to, this
one has no native counterpart: a Cocoa app that needs video wants a
different component than this one.

## Props

### Source and playback

| Prop          | Type                | Notes                                                                                                                                       |
| ------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src`         | `string`            | A path or a URL. **Changing it does not restart the player** — the new source is loaded into the running one, so the window never blinks.   |
| `backend`     | `MediaBackendName`  | `'auto'` (default), `'mpv'`, `'vlc'`.                                                                                                       |
| `autoPlay`    | `boolean`           | Default true.                                                                                                                               |
| `paused`      | `boolean`           | Drive it if you want to. Leave it out and the player is uncontrolled — `autoPlay` decides how it starts and the handle moves it from there. |
| `volume`      | `number`            | 0–1. Default: the player's own.                                                                                                             |
| `muted`       | `boolean`           |                                                                                                                                             |
| `loop`        | `boolean`           |                                                                                                                                             |
| `aspectRatio` | `string`            | `'16:9'`, `'4:3'`. The player letterboxes inside the element's rect.                                                                        |
| `osd`         | `boolean`           | The player's own on-screen controls. Off by default: they are drawn by the player and will not match the app's theme.                       |
| `extraArgs`   | `readonly string[]` | Appended to the player's command line verbatim.                                                                                             |

### Process and layout

| Prop         | Type               | Notes                                                                                                 |
| ------------ | ------------------ | ----------------------------------------------------------------------------------------------------- |
| `enabled`    | `boolean`          | False holds off spawning entirely.                                                                    |
| `stopSignal` | `string`           | Sent on unmount and restart. Default `SIGTERM`.                                                       |
| `processes`  | `ProcessHost`      | Where the process runs. See [embed](embed.md).                                                        |
| `focusable`  | `boolean`          | A video surface is not a control; **default false**, unlike `<Terminal>`.                             |
| `fallback`   | `ReactNode`        | Rendered instead of the surface when no player is installed, or none can be embedded on this backend. |
| `style`      | `Style \| Style[]` |                                                                                                       |

### Events

| Prop              | Type                         | Notes                                                                                             |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `onProgress`      | `(p: MediaProgress) => void` | Position and duration as the player reports them. **mpv only.**                                   |
| `onEnded`         | `(info) => void`             | The file reached its end. Not fired for `stop()` or a new `src`.                                  |
| `onPlayingChange` | `(playing: boolean) => void` |                                                                                                   |
| `onExit`          | `(info: ExitInfo) => void`   | The player process ended.                                                                         |
| `onError`         | `(err: Error) => void`       | Spawn failures, control-channel failures, `BackendUnavailableError`, and `EmbedUnsupportedError`. |

## `MediaPlayerHandle`

```ts
player.current.seek(90);
if (player.current.reportsProgress) showScrubber();
```

`play()`, `pause()`, `seek(seconds)`, `setVolume(0–1)`, `stop()` (playback
stops, the window stays, idle), `restart()`, `signal(sig?)`, plus the
read-only `pid`, `windowId`, `backend`, `status` and `reportsProgress`.

## Live commands, and the VLC asymmetry

`src`, `volume`, `muted` and `paused` are **live commands**, sent over mpv's
JSON IPC socket — changing them does not respawn the player.

Under VLC that channel is write-only: play/pause/seek/volume work and
`onProgress` never fires. `handle.reportsProgress` says which you have, so a
scrubber can be hidden rather than sit at zero.

## The player's window stacks above everything you draw

Same rule `<glarea>` has, and the same one `<Terminal>`'s embedded backends
have. A transport bar cannot be a `<box>` over the video — put it beside the
element, or in a sibling `<popup>`. There is no vt-style native backend here:
decoding video is the player's job.

## Example

```bash
npm run examples:media-player -- <file>
```

Needs a real `$DISPLAY` and mpv or VLC installed.
