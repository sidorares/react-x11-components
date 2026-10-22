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

A video surface with real transport control, on one of three backends:

- **mpv or VLC, embedded** — the player's own window inside a react-x11 one,
  with audio, subtitles and every codec the player has. The same component
  as [`<Terminal>`](terminal.md) with different argv: both are built on
  [`embed`](embed.md) and core's `<foreign>`. **X11 only.**
- **ffmpeg, decoded** — an `ffmpeg` child process decoding the file into a
  core `<video frames>` sink. **Every react-x11 backend** that has
  `<video>` — X11, Wayland, macOS — and a drawn node in the paint order.
  **Silent: there is no audio.**

`backend` defaults to `'auto'`:

| The app…                                   | `'auto'` tries, in order |
| ------------------------------------------ | ------------------------ |
| can embed a window (X11)                   | mpv, VLC, ffmpeg         |
| cannot (Wayland, the native macOS backend) | ffmpeg                   |

With none installed, `fallback` renders and `onError` gets a
`BackendUnavailableError` naming everything that was looked for. That is an
ordinary state of a healthy machine, not an exception.

Ask for one by name and you get that one or nothing. `backend="mpv"` or
`"vlc"` on a backend that cannot embed — Wayland, macOS — is
`'unavailable'` from the first render, with `fallback` and an
`EmbedUnsupportedError` saying this backend cannot embed another program's
window; nothing is looked for on `PATH` and nothing is spawned, because
"install mpv" is the wrong advice there. `backend="ffmpeg"` is ffmpeg even on
an X11 desktop that has mpv — the choice to make when the video has to sit
_under_ something.

## Props

### Source and playback

| Prop          | Type                | Notes                                                                                                                                                                         |
| ------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src`         | `string`            | A path or a URL. **Changing it does not restart the player** — the new source is loaded into the running one. Under ffmpeg the old clip plays on until the new one is probed. |
| `backend`     | `MediaBackendName`  | `'auto'` (default), `'mpv'`, `'vlc'`, `'ffmpeg'`.                                                                                                                             |
| `autoPlay`    | `boolean`           | Default true. False shows the first frame and holds it.                                                                                                                       |
| `paused`      | `boolean`           | Drive it if you want to. Leave it out and the player is uncontrolled — `autoPlay` decides how it starts and the handle moves it from there.                                   |
| `volume`      | `number`            | 0–1. Default: the player's own. **Nothing under ffmpeg**, which is silent.                                                                                                    |
| `muted`       | `boolean`           | Nothing under ffmpeg.                                                                                                                                                         |
| `loop`        | `boolean`           |                                                                                                                                                                               |
| `aspectRatio` | `string`            | `'16:9'`, `'4:3'`. The player letterboxes inside the element's rect.                                                                                                          |
| `osd`         | `boolean`           | The player's own on-screen controls. Off by default: they are drawn by the player and will not match the app's theme. ffmpeg has none.                                        |
| `extraArgs`   | `readonly string[]` | Appended to the player's command line verbatim. Under ffmpeg they are **input** options, before `-i`: `['-hwaccel', 'vaapi']`.                                                |

### Process and layout

| Prop         | Type               | Notes                                                                                                        |
| ------------ | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `enabled`    | `boolean`          | False holds off spawning entirely.                                                                           |
| `stopSignal` | `string`           | Sent on unmount and restart — and under ffmpeg to each decoder a seek replaces. Default `SIGTERM`.           |
| `processes`  | `ProcessHost`      | Where the process runs. See [embed](embed.md). ffmpeg needs one that pipes output (`SpawnOptions.output`).   |
| `focusable`  | `boolean`          | A video surface is not a control; **default false**, unlike `<Terminal>`.                                    |
| `fallback`   | `ReactNode`        | Rendered instead of the surface when no player is installed, or none that can run on this react-x11 backend. |
| `style`      | `Style \| Style[]` |                                                                                                              |

### Events

| Prop              | Type                         | Notes                                                                                                                                            |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `onProgress`      | `(p: MediaProgress) => void` | Position and duration. **mpv and ffmpeg**, never VLC. ffmpeg's is a few times a second, as HTML's `timeupdate` is.                               |
| `onEnded`         | `(info) => void`             | The file reached its end. Not fired for `stop()` or a new `src`.                                                                                 |
| `onPlayingChange` | `(playing: boolean) => void` |                                                                                                                                                  |
| `onExit`          | `(info: ExitInfo) => void`   | The player process ended. Under ffmpeg, only when it ended on its own other than at the end of the file — a seek's replaced decoder is not news. |
| `onError`         | `(err: Error) => void`       | Spawn failures, control-channel failures, `BackendUnavailableError`, `EmbedUnsupportedError`, and under ffmpeg `MediaProbeError`.                |

## `MediaPlayerHandle`

```ts
player.current.seek(90);
if (player.current.reportsProgress) showScrubber();
```

`play()`, `pause()`, `seek(seconds)`, `setVolume(0–1)`, `stop()`,
`restart()`, `signal(sig?)`, plus the read-only `pid`, `windowId`,
`backend`, `status` and `reportsProgress`.

`stop()` stops playback without stopping an embedded player: its window
stays, idle. Under ffmpeg the picture goes, and `play()` starts from the
top. `windowId` is null under ffmpeg, which has no window; `pid` and
`signal()` are the decoder running now, and a seek starts a new one.

## Live commands, and the VLC asymmetry

`src`, `volume`, `muted` and `paused` are **live commands**, sent over mpv's
JSON IPC socket — changing them does not respawn the player.

Under VLC that channel is write-only: play/pause/seek/volume work and
`onProgress` never fires. `handle.reportsProgress` says which you have, so a
scrubber can be hidden rather than sit at zero.

## The ffmpeg backend

```jsx
<MediaPlayer src={file} backend="ffmpeg" style={{ flexGrow: 1 }} />
```

`ffprobe` reads the clip's size and colour, a core `<video frames>` sink is
made in the display's cheapest format, and `ffmpeg` decodes the file to
`rawvideo` in that format on a pipe, each frame pushed into the sink. **It
needs both `ffmpeg` and `ffprobe` on `PATH`** — every distribution packages
them together — and it is `'unavailable'` without them.

**It is silent.** A sink is frames, not sound: there is no audio path, so
`volume` and `muted` do nothing and there is no A/V sync to speak of. A
video that needs its soundtrack wants mpv.

What it has that an embedded player does not is a place in the paint order.
The picture is a drawn node like an `<image>`, so a header scrolls over it, a
dialog's scrim dims it, a rounded card clips it, and a transport bar can be a
sibling `<box>` laid over the picture rather than a `<popup>`.

How the transport is made, since ffmpeg has no control channel:

- **Pacing is ffmpeg's** (`-re`): frames reach the pipe when they are due,
  and the sink shows the newest one.
- **`pause()` is SIGSTOP and `play()` is SIGCONT**, to the same process; the
  frame on screen stays. On ffmpeg 8.1 a resumed `-re` carries on at the
  frame rate. An older ffmpeg that caught up with the wall clock after a
  long pause would show the missed stretch fast — upgrade, or seek on
  resume.
- **`seek()` restarts the decoder** with `-ss` before `-i`: an input seek to
  the keyframe before, decoded forward from there. A seek while paused shows
  the new position's frame and holds it.
- **`loop`** is `-stream_loop -1`, a launch option, so changing it restarts.
- **Position is counted**: frames since the last start over the probed frame
  rate. Exact for a constant-rate file, close for a variable-rate one.

The format is the first of the display's `preferredFormats` (core's
`VideoFrames`), which is what makes this cheap or not — nothing here picks
it, so a react-x11 that grows a faster path is faster here with no change:

| react-x11 backend     | ffmpeg emits | and then                                                          |
| --------------------- | ------------ | ----------------------------------------------------------------- |
| macOS                 | NV12         | a layer of its own, no window frame per video frame               |
| Wayland ¹             | NV12         | uploaded as textures, converted in a shader                       |
| X11 with an Xv port ¹ | NV12         | converted by the server's GPU                                     |
| everywhere else       | BGRA         | drawn into the element's surface — the cost a profile shows first |

¹ With react-x11's Linux video paths, which are newer than 2.52.0; on 2.52.0
both are the last row.

Colour: the clip's own matrix and range as `ffprobe` reports them, named to
ffmpeg's scaler on both sides so the bytes are what the sink was told; an
untagged clip is taken as BT.601 below 720 lines and BT.709 from there, which
is what players assume. The frame is decoded at the clip's display shape —
non-square pixels made square, a phone's rotation applied — and
`aspectRatio` reshapes it, its width following its height.

A file `ffprobe` cannot read is a `MediaProbeError` through `onError`,
carrying ffprobe's own complaint (`No such file or directory`), and
`status: 'exited'`. A decoder that fails part way is an `Error` with ffmpeg's
last line of stderr, and `onExit`.

## The embedded player's window stacks above everything you draw

Same rule `<glarea>` has, and the same one `<Terminal>`'s embedded backends
have. Under mpv or VLC a transport bar cannot be a `<box>` over the video —
put it beside the element, or in a sibling `<popup>` — or play the file
through `backend="ffmpeg"`, whose picture is drawn and can be overlapped like
anything else.

## Example

```bash
npm run examples:media-player -- <file>
```

Needs mpv or VLC on X11, or ffmpeg anywhere.
