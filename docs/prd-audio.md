# Audio

Sound in react-x11 apps and in `<Html>`. This covers what the web asks
for, what the three repositories have today, the ladder of platform rungs
that would play it, which repository owns each rung, and the first step:
a page's `<audio>` heard on macOS.

**The first step is built; the rest is design.** react-x11's `<audio>`
(sidorares/react-x11#1019, in 2.56.0) and `<Html>`'s sounds here play a page's
`<audio>` on macOS: see "The first step" for what was built and what was
left. The page that asked was OpenAI's "Working with academic communities
to build scientific understanding", whose "Listen to article" button made
no sound in the example browser.

## What the page does

I probed it in Chrome, with `HTMLMediaElement.prototype.play`, the `src`
setter, `AudioContext`, `MediaSource` and `speechSynthesis` wrapped:

- The button fetches `/backend/tts/<entry>/?locale=en-US`. That is JSON
  naming a voice and a list of MP3 files on a CDN, one for each stretch of
  the article. Each file comes with its duration and the start and end of
  every word in it.
- The page has one `<audio preload="none">` in the document, with no
  `controls`. It sets `src` to the first MP3 and calls `play()`.
- It uses no Web Audio, no `MediaSource` and no speech synthesis.

It reads `currentTime` back to highlight the word being said. The first
file is 9.72 s of an article the button says is 11:03, so the page also
moves from one file to the next, by `ended` or by the durations it was
given. What it needs is sound, and a clock that follows the sound.

## What the web asks for

| API                                                   | What pages use it for                                  | What it needs underneath                                 |
| ----------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| `<audio>`, `new Audio(url)`, a `<video>`'s soundtrack | players, read-aloud, podcasts, a notification's blip   | a player for a URL: fetch, decode, output, a clock       |
| Web Audio (`AudioContext`)                            | games, music tools, synthesised UI sounds, visualisers | a graph rendered into samples, and an output for samples |
| `decodeAudioData`                                     | games and tools that load their own sounds             | a decoder: bytes in, samples out                         |
| `<audio srcObject>` with a WebRTC track               | calls                                                  | an output for samples a peer connection has decoded      |
| Media Source Extensions                               | streaming sites, hls.js where there is no native HLS   | a player fed container bytes by the page                 |
| `speechSynthesis`                                     | rare                                                   | the platform's speech                                    |

The first row is most of the web.

Media Source Extensions are out of scope. `canPlayType` already steers an
HLS player to set the playlist as `src` where the platform plays it
(`network.ts`), and a player the page feeds bytes to is a different design.

Speech is out of scope too. It is a platform service (AVSpeechSynthesizer,
Windows' speech, speech-dispatcher), and core's if it is anyone's.

## What there is today

### `<Html>`: the page's half is done, and nothing is heard

- **The facade has HTMLMediaElement's state machine** (`scripts/dom.ts`):
  source selection, the network and ready states, the play and pause
  steps and their promises, seeking, `timeupdate` four times a second,
  the end, `loop`, and `new Audio()`.
- **The page hears a real duration** where its requests reach a network.
  The host fetches the source only as far as its container says how long
  it is (`_mediaFetch`). `scripts/media.ts` reads ISO BMFF, Matroska and
  WebM, MPEG audio, RIFF WAVE and Ogg.
- **The clock is a model.** `currentTime` is the wall time since the play
  started, times the rate. In AGENTS.md's words: "Nothing comes back from
  the player to the page yet."
- **Only a `<video>` with a box reaches a player.** What a script asks of
  an element — `paused`, `muted`, `volume`, `playbackRate`, a seek — is
  kept for the element (`setMediaState`, `MediaAsked`). The builder lists
  `<video>` boxes alone (`layout/boxes.ts`), `mediaRectsOf` places them,
  and `videos.ts` mounts core's `<video>` over each. An `<audio>` has no
  box, and an element made with `new Audio()` is in no document at all.
- **`play()` is never refused.** There is no autoplay policy, since
  nothing could be heard.
- **Web Audio is the whole API, silent by design** (`scripts/webaudio.ts`).
  The only thing it renders is what reaches a
  `MediaStreamAudioDestinationNode`, as a track's samples.
- **A received WebRTC audio track is decoded and counted, not heard**
  (docs/prd-webrtc.md). `srcObject` is not in the facade.
- **Audio already moves through `<Html>` in one shape:** `MediaAudioData`
  (`media-devices.ts`), planar `Float32Array`s with a sample rate and a
  timestamp in microseconds. The fake microphone, a peer's receiver and the
  synth all speak it.

### The rest of this package

`<MediaPlayer backend="ffmpeg">` runs ffmpeg with `-an`: "a sink is
frames, not sound". Its mpv and VLC backends do play sound, because they
are somebody else's program, embedded on X11.

### react-x11: sound on one platform, as video's side effect

- **On macOS, `<video src>` is an AVPlayer** (`src/cocoa/player.js`, over
  `@windowkit/appkit`'s `player.mm`): the platform's decoders, audio,
  seeking and HLS. Its events are `player-metadata`, `player-state`,
  `player-time` (four times a second), `player-ended` and `player-error`.
- **In a `<Frame>` pane the player is the host's** (`PanePlayer` and
  `HostedPlayer`). A pane runs no NSApplication, so an AVPlayer made there
  never hears from AVFoundation. The picture comes down through a ring of
  IOSurfaces.
- **`<video>` is the only door.** Both use `app.createPlayer(src,
options)`, which is neither declared nor documented.
- **`useSupports('mediaPlayback')`** is true on macOS, and in a pane whose
  host plays. It is false on X11 and Wayland "for good", and on Windows
  today.
- **`<video frames>` takes decoded pictures and has no sound.**
- **There is no output for samples**, on any backend.

### windowkit

`@windowkit/appkit` has the player verbs. `@windowkit/win32` has no media
verbs at all (as of f93d179, the checkout read). Linux needs no bridge for
this: sound there has nothing to do with which display protocol a window
speaks.

## Two doors, as video has

Core's video already draws the line this design keeps. `<video src>` is
the platform's player where there is one. `<video frames>` is a sink an
application feeds with frames it decoded, and it works everywhere. Audio
has the same two doors:

1. **A player for a URL.** The platform fetches, decodes, outputs and
   keeps the clock. Where the platform has one, nothing else is as good:
   it brings hardware decoders, AirPlay and output routing, HLS, and the
   power profile. Where the platform has none, which is Linux, nothing
   pretends to be one.
2. **A sink for samples.** Planar floats go in and a clock comes out. Web
   Audio's output, a call's received audio, ffmpeg's soundtrack, and a
   Linux player built from a decoder all go through it.

The rule that follows is the one video has. Core answers the first door
only where the platform plays, and the second wherever it can open a
device. Decoders, graphs and engines sit above the second door.

## The ladder

|                       | Player (`src`)                      | Sink (samples)                                             | Decoder (bytes → samples)                       |
| --------------------- | ----------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| macOS                 | AVPlayer — **exists**               | AudioQueue, or AVAudioEngine with an `AVAudioSourceNode`   | AudioToolbox (`AudioConverter`, `ExtAudioFile`) |
| `<Frame>` pane, macOS | the host's AVPlayer — **exists**    | the pane's own or the host's (an open question)            | as macOS                                        |
| Windows               | Media Foundation's `IMFMediaEngine` | WASAPI, shared mode                                        | Media Foundation's source reader                |
| Linux, X11 or Wayland | none in the platform                | PulseAudio's protocol, which PipeWire answers; or `pw-cat` | none in the platform: WebAssembly, or ffmpeg    |
| core's mock           | a recording player a test drives    | a recording sink                                           | —                                               |

### macOS

**The player is there.** An audio-only item plays through the same verbs,
and the `AVPlayerLayer` and `AVPlayerItemVideoOutput` it makes go unused.
A `video: false` option to `createPlayer` would skip both. An older bridge
ignores the option, so it saves resources but is not required.

**The sink is new.** It would be a bridge verb that opens an output at a
sample rate and a channel count and keeps a ring of samples, which the
render thread reads. JavaScript writes into the ring from its own thread
and never runs on the audio thread. What it reads back is how many frames
have been played and the output's latency, and that is the clock.
AudioQueue is the smaller API; AVAudioEngine brings choice of output
device later. Neither needs the main thread, which is what may let a pane
open its own.

**A decoder verb** — bytes in, planar floats out, through AudioToolbox —
is what `decodeAudioData` and a short sound need. It reads MP3, AAC,
ALAC, FLAC and WAV. Opus in Ogg is to check.

### Windows

**`IMFMediaEngine` is the platform's player.** It is Media Foundation's
engine made for HTML5's media elements, and its events map onto
`player-*` one for one: `LOADEDMETADATA`, `PLAYING`, `PAUSE`,
`TIMEUPDATE`, `WAITING`, `ENDED`, `ERROR`. It plays audio with no window.
The same verbs plus a frame transfer (`TransferVideoFrame`) are Windows'
`<video src>`, which core lists as missing today, so the audio work and
the video work are one bridge PR.

Its built-in codecs are MP3, AAC, WAV and MP4 with H.264. WebM and Ogg
come through the Store's extensions where those are installed, so
`canPlayType` has to ask the engine (`IMFMediaEngine::CanPlayType`) rather
than a list.

**The sink is WASAPI in shared mode**, on an event-driven thread reading
the same kind of ring.

### Linux

**There is no platform player.** GStreamer's `playbin` is the nearest
thing, and it needs a native binding nobody here wants to maintain. mpv is
somebody else's program, and this package already drives it:
`<MediaPlayer>`'s `connectMpv` observes position, duration and pause,
which is HTMLMediaElement's clock. So core's `mediaPlayback` stays false
on Linux, and a Linux player is this package's: mpv with `--no-video`
where it is installed, or a decoder feeding the sink.

**The sink has two rungs**, cheapest first:

1. **`pw-cat` (PipeWire) or `pacat` (PulseAudio's utilities), spawned**,
   reading raw float samples from a pipe. Both ship with the audio server,
   as `osascript` ships with macOS, which is the rung core's calendar took
   on a Mac with no bridge. The clock is the samples written less a
   latency guessed from the buffer asked for. That is good enough for a
   voice and loose for lip sync.
2. **PulseAudio's native protocol in JavaScript.** It is a socket
   protocol, as X11 and D-Bus are, and PipeWire answers it
   (`pipewire-pulse`) on every desktop that has moved to PipeWire. Samples
   go over the socket in memory blocks where no shared memory is
   negotiated. The server says how much it wants (`REQUEST`) and reports
   its latency, so the clock is the server's. PipeWire's own protocol is
   not an option from Node: it hands buffers over as file descriptors,
   which `net` cannot receive. This client would be a package of its own,
   in the shape of node-x11 and dbus-native, and core would depend on it
   the way it depends on dbus-native.

**No audio server is an ordinary state.** A container or a minimal
machine has none: `useSupports('audioOutput')` is false, and nothing
throws.

**Decoders on Linux** are ffmpeg spawned where it is installed, as
`<MediaPlayer backend="ffmpeg">` does for pictures, or WebAssembly.
libav.js is already an optional peer here for WebRTC's Opus and VP8
(docs/prd-webrtc.md); which of its builds decode MP3 and AAC, and at what
size, is to check. Small single-codec decoders exist for MP3, Opus,
Vorbis and FLAC. AAC is the codec without one, and it matters, since it
is half of what the web serves.

### Web Audio

The graph is the page's (`webaudio.ts` keeps all of it), so rendering it
is this package's work, and it goes out through the sink. There are two
candidates, to be settled by a spike:

- **`node-web-audio-api`** (IRCAM, over Rust's `web-audio-api` crate,
  BSD-3-Clause, prebuilt for macOS, Windows and Linux, with a WPT harness
  of its own). It renders and decodes, but it opens its own output device.
  That would make it a second output beside core's sink, with a clock of
  its own. An `OfflineAudioContext` of it, rendering into the sink a
  quantum at a time, avoids that if it is cheap enough. What it decodes,
  and whether it runs under Bun, are to check.
- **A renderer here**, host-side on a worker thread, over the graph the
  facade already describes to the synth. The node types are a bounded
  list; HRTF panning and the convolver are the big ones. WPT's `webaudio/`
  suite mostly renders an `OfflineAudioContext` and compares, so this
  would score with no device at all.

`AudioWorklet` runs page code on the render thread. In this sandbox that
means a realm on a worker, and it comes last in either plan.

## Who owns what

### Should a UI toolkit play sound at all?

The rule at the top of AGENTS.md answers it rung by rung, as it answered
3D and the user's calendar.

- **The platform rungs fail "built on public API" on macOS.** The player
  belongs to `CocoaApp._native`, which is off core's exports map, and a
  pane's player can only be made by the host process, which only core
  reaches. That is the calendar's argument exactly: when the second clause
  fails on one backend, the whole feature belongs upstream.
- **Core already makes sound.** Every `<video src>` on a Mac is heard.
  Exposing the player without a picture adds a door to something core
  already ships; it does not add a responsibility.
- **Sound is one of the things an app does outside its windows.** Core
  has claimed that family one member at a time: notifications, the tray,
  the file dialog, the Dock, deep links, the calendar. Sound's
  integrations are about the app's identity, which only core knows: the
  name in the volume mixer (WASAPI's session, PulseAudio's
  `application.name`), and media keys and Now Playing
  (`MPNowPlayingInfoCenter` and `MPRemoteCommandCenter`, Windows' system
  media transport controls, MPRIS over the bus core already holds).
- **Engines fail "the vast majority of apps".** A Web Audio renderer,
  codecs beyond the platform's, a mixer and effects are heavy, wanted by
  few, and buildable on a sink. Those belong to this package, or to an
  application.

So the answer is the 3D answer: the boundary runs through the feature.

### windowkit: the verbs

Native code and nothing React:

- `@windowkit/appkit` gets the sink and the decoder, and optionally
  `video: false`.
- `@windowkit/win32` gets the media engine, the sink and the decoder.

A pure-JavaScript PulseAudio client is a sibling package in the node-x11
mould, not a bridge. Nothing at this layer knows about elements.

### react-x11: the doors, and the app's identity

- **`<audio src>`** is `<video src>` without a picture:
  - the same props: `src`, `paused`, `autoPlay`, `loop`, `muted`,
    `volume`, `playbackRate`;
  - the same events: `onLoadedMetadata`, `onPlay`, `onPause`,
    `onTimeUpdate`, `onEnded`, `onError`;
  - the same ref: `play()`, `pause()`, `seek()`, `currentTime`,
    `duration`, `paused`.

  It is a node with no box that draws nothing, so its life is its mount,
  as it is in React DOM. Where `mediaPlayback` is false it reports
  `NoMediaPlaybackError`, as `<video>` does. Its node type needs a name
  other than Web Audio's `AudioNode`.

- **A sink**, `createAudioFrames(app, { sampleRate, channels })`, the
  counterpart of `createVideoFrames`. It takes `MediaAudioData`'s shape,
  `push({ sampleRate, channels: Float32Array[], frames })`, and offers
  `currentTime` (seconds played, by the device's clock), `latency`, how
  much it wants next, and `close()`. `useSupports('audioOutput')` asks
  first. Whether it also hangs off an element (`<audio frames>`) is an
  open question; it needs none.
- **`decodeAudioBytes`**, the audio twin of `decodeImageBytes` on
  `react-x11/ntk`. It uses the platform's decoder where there is one, and
  throws an error naming what to convert to where there is none. A
  WebAssembly rung is an optional dependency's, as the image ladder's
  rungs are.
- **Later: media keys and Now Playing**, and the app's name in the mixer.

Core does not grow a graph, a mixer, effects, or codecs of its own.

### This package: the semantics

- `<Html>`'s HTMLMediaElement on core's `<audio>`, with the clock taken
  back from the player (see "`<Html>`'s half" below).
- The Linux player: mpv without video, or a decoder into the sink.
- Web Audio's renderer; `decodeAudioData` over `decodeAudioBytes` and the
  WebAssembly rung; a received WebRTC track into the sink; `srcObject`.
- `<MediaPlayer backend="ffmpeg">` with its sound: a second ffmpeg output
  of `f32le` into the sink, with the pictures paced by the sink's clock.
- `<audio controls>`'s bar, which pages with sound will ask for.

## `<Html>`'s half

Five changes, in the order they are needed:

1. **A request kind.** `ResourceRequest.kind: 'audio'`, answered
   `{ kind: 'audio', src }` for the platform's player, under the same rules
   as `videoSource`: upgraded on a secure page, and `file:` only for a
   `file:` page. Later it can also be answered `{ kind: 'audio', frames }`
   by a host that decodes. `HtmlNetwork.resources` answers it wherever its
   `video` option says there is a player; that option would be renamed, or
   joined by a `media` one. Asking `kind: 'video'` for an `<audio>` would
   be shorter, and would make every host's answer a lie about what it is
   answering.
2. **Players with no rect.** A `sounds.ts` beside `videos.ts` mounts one
   core `<audio>` for each media element that plays and has no player
   mounted for a picture. That covers:
   - an `<audio>` in the document;
   - an `<audio>` out of it (`new Audio()`), since a media element out of
     a document plays on;
   - a `<video>` with no box, whose soundtrack a browser still plays.

   Players are keyed by element, never by place, as a video's player is,
   and take what `MediaAsked` says as their props. An element out of the
   document is reached through the host by its id, which the `mediaState`
   op already names.

3. **The clock comes back.** Where a player is mounted, its events are the
   page's truth, delivered through a new entry into the realm:
   - `player-metadata` sets the duration over the one read from the
     container's head;
   - `player-time` re-anchors `ask.time` and `ask.since`, so the model
     clock fills in between the player's quarter-second reports;
   - a player that is waiting is ready state 2, which fires `waiting`,
     then `stalled`;
   - `player-ended` runs the end steps;
   - `player-error` becomes a `MediaError`.

   Where nothing plays, the model clock runs as it does now. This also
   closes the same gap for `<video>`. The rule to write down: **the
   facade's clock is a model only where nothing plays.**

4. **An autoplay policy.** With sound, `play()` turns down what Chrome
   turns down. A play that is unmuted, with a volume above 0, before the
   page has had any user activation, rejects with `NotAllowedError`, and
   `autoplay` waits the same way; a muted play goes ahead. This reads
   `stickyActivation` on purpose, which is the one exception to the
   facade's rule that a gesture is transient: Chrome lets a page with
   sound play once the user has interacted with it at all. A host can
   choose otherwise through an option on `scripts`.
5. **The page's policy.** A CSP's `media-src` is held before a source is
   asked for, as `csp.ts` holds `connect-src` today.

The example browser then answers `kind: 'audio'`, marks a tab that is
making sound, and offers a mute in its strip.

Two things to know before building it:

- **The player fetches for itself, with none of the page's cookies or
  headers.** The head was read through the page's network for the
  duration, and the player reads the file again. Public CDN media, the
  case here, is fine. Media behind a session cookie is not, until the
  player is handed headers (`AVURLAssetHTTPHeaderFieldsKey`, an
  undocumented key AVFoundation honours) or the host serves it the bytes.
  `<video>` has the same limitation today.
- **A document that is not fully active plays nothing** (HTML). A host's
  `follow` that keeps a document's `<Html>` mounted in the back-forward
  cache has to pause its sounds, or a page left behind goes on talking.

## The first step: a page's `<audio>` on macOS

**Built**, with these differences from the plan below:

- **No bridge change.** The player is told it has no picture in
  JavaScript (`element: 'audio'` in `createPlayer`'s options), which is
  what a pane's host needs to copy no frames; the `AVPlayerLayer` an
  audio item makes still goes unused.
- **The test player is `fakeMediaPlayers(app)`** on `react-x11/test`,
  installed on any app rather than on the mock backend alone.
- **A waiting player is not ready state 2.** Core reports a player that is
  waiting as playing, so the page cannot be told `waiting`. Instead the
  page's clock runs at most half a second past what the player last said
  (`PLAYER_AHEAD`). On a real Mac, while the player fetched the range a
  seek asked for, the clock ran on a second and a half ahead of it and
  jumped back when it spoke; with the cap it holds and goes on.
- **Not built:** the autoplay policy (item 4), `media-src` (item 5), the
  tab's speaker in the example browser, and a `<video>` with no box,
  whose soundtrack is still not heard. A media element played out of the
  document is paused with the rest when its document goes into the
  back-forward cache.

The goal is the OpenAI button, heard, with each word highlighted as it is
said. It takes a PR in each of three repositories, the first of them
optional:

1. **@windowkit/appkit** (optional): `createPlayer(url, { video: false })`,
   which makes no `AVPlayerLayer` and no video output.
2. **react-x11**:
   - the `<audio>` element over `app.createPlayer`, sharing `<video>`'s
     player handling without the frame pulling or the sprite;
   - in a pane, `PanePlayer` and `HostedPlayer` told the player has no
     picture, so neither process makes a ring or pulls frames;
   - a recording player on the mock backend, whose `player-*` events a
     test sends, with `useSupports('mediaPlayback')` true there when a
     test asks. Without it, a suite with no AVFoundation cannot test the
     next PR;
   - types, and a section in docs/elements.md. The floor here moves with
     it.
3. **This package**: items 1 to 4 of "`<Html>`'s half", and the example
   browser's answer.

It is done when, in the example browser on a Mac:

- the button plays the first file and moves to the next with no audible
  gap and no overlap;
- the highlighted word is the one being said, within a report's quarter
  second;
- pause, play, and the page's scrubber if it has one, do what they say;
- `new Audio(url).play()` from a click plays, and the same from a timer
  before any click is refused;
- a tab that is closed, reloaded or navigated away falls silent.

It does not cover Windows, Linux, Web Audio, `srcObject` or
`<audio controls>`'s bar. The page needs none of them.

## After it

In order, each with its own design where it needs one:

1. **Windows' media engine**: `<audio src>` and `<video src>` together,
   in one bridge PR.
2. **The sink**, on macOS and Windows, and `pw-cat` on Linux. WebRTC's
   received audio is the first customer, since it is already decoded.
3. **The pure-JavaScript PulseAudio client**, replacing `pw-cat`'s
   guessed clock.
4. **`decodeAudioBytes`**, and `decodeAudioData` over it.
5. **Web Audio's renderer**, after the spike.
6. **`<MediaPlayer backend="ffmpeg">` with sound**, paced by the sink.
7. **A Linux `<audio>`** in `<Html>`: mpv where it is installed, and a
   decoder into the sink where it is not.
8. **Media keys and Now Playing.**

## Open questions

- **`<audio frames>`, or a freestanding sink?** A sink needs no element.
  An element gives it a life React can see, and a pane a place to route
  it.
- **A pane's sink: the pane's own device, or the host's?** AudioQueue
  needs no run loop, so a pane can open its own. Going through the host
  would give the app one name in the mixer.
- **One request kind or two?** `'audio'` beside `'video'`, or a single
  `'media'` kind with the element's name in the request.
- **Does the player get the page's cookies?** Today's `<video>` does not.
- **`node-web-audio-api`, or a renderer here?**
- **Does `decodeAudioBytes` belong in core at all?** The alternative is
  that the platform's decoder stays a windowkit verb and core exports only
  a way to reach it.
