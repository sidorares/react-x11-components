# WebRTC in `<Html scripts>`

What it would take for a page's scripts to open WebRTC connections in
`<Html scripts>`, the `node:vm` page engine under `src/html/scripts/`:

- what the Interop 2026 tests ask for;
- what can be reused from npm;
- how the work fits the engine's rules;
- the order to build it in.

Status: design, 2026-10-26. Workstream 0 is built: the two seams
(`src/html/rtc.ts`, `src/html/media-devices.ts`), the fake devices
(`src/html/fake-media.ts`), and the WPT runner's devices and
`set_permission`. Workstream 1's foundation round is built (#1030): the
page's `RTCPeerConnection` over werift (`src/html/werift.ts`), with the
first slices of workstreams 2 and 3 beside it, and the area went from
0.2% to 57.0%. Workstream 1's next rounds are under way: a canvas's
`captureStream()` (57.6%). Media does not flow yet. The spikes it quotes ran on Node
24.22.0 and Bun 1.4.3 on an M5 Pro. They were scratch scripts and are not
in the repository.

## The answer, short

The `webrtc` focus area is the largest gap left in Interop 2026. Its 91
tests score **0.2%** at the twelfth run, about 5 of the 16.3 points the
total has left. Two tests score anything: `historical.html`, one subtest
of five, and one `idlharness` subset, two of 141. There is no
`RTCPeerConnection`, `MediaStream`, `getUserMedia` or `<video>.srcObject`
in the engine at all.

The stack to build on is all JavaScript and WebAssembly:

- **werift** (MIT, pure TypeScript) carries the connection. Its
  `RTCPeerConnection` is the engine behind a new seam: ICE, DTLS, SCTP data
  channels, SRTP, and the offer/answer state. Its transports are also
  published apart: `werift-ice`, `werift-dtls`, `werift-sctp` and
  `werift-rtp`.
- **libav.js's `webm-vp9` build** (LGPL-2.1, FFmpeg compiled to
  WebAssembly) encodes and decodes VP8, VP9 and Opus.
- Both are **optional peers**, loaded the first time a page asks and
  installed for no one, as `quico` is for WebTransport. Their types are
  written out structurally.

The engine's half follows WebTransport's layout:

- The W3C API is the facade's, as source text in the page's realm. It
  enforces the specification's semantics: argument checks, exceptions,
  the operations chain, the order events are told in.
- The network is a seam, `HtmlScripts.webRTC`, whose default connects
  nothing. `HtmlNetwork.webRTC` supplies one over werift.
- Media devices are a seam too, `HtmlScripts.mediaDevices`, whose default
  has no device. The WPT runner supplies fake ones.
- A received track plays in `<video srcObject>` through core's
  `<video frames>`, the path `<MediaPlayer backend="ffmpeg">` already uses.

Native libwebrtc, through `@roamhq/wrtc`, was considered and is not the
plan. "Native libwebrtc, considered" below has why. The seam is shaped so
that a native backend could stand behind it later.

## What the tests ask for

WPT's WebRTC tests connect **two `RTCPeerConnection`s in one page**, both
ours, over loopback (`exchangeIceCandidates`, `exchangeOfferAnswer` in
`webrtc/RTCPeerConnection-helper.js`).

They make media with `getNoiseStream`: an `AudioContext` oscillator into a
`MediaStreamAudioDestinationNode`, and a canvas drawn every 100 ms into
`canvas.captureStream()`. Where a page has neither, `getNoiseStream` falls
back to `navigator.mediaDevices.getUserMedia`. So fake devices behind
`getUserMedia` are all the media the tests need to start with. Web Audio
and canvas capture can come later, and no camera or microphone is involved.

The 91 tests fall into three tiers by what they need. An area is the mean
of its tests, so the share is by test, not by subtest.

| tier                                 | tests | share of the area | what they need                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ----: | ----------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. API and offer/answer**          |    49 |               54% | The constructor and `RTCConfiguration`, transceivers and their directions and mids, `setLocalDescription`/`setRemoteDescription` with rollback, `pranswer` and no argument, the operations chain, `RTCRtpParameters` (codecs, encodings, header extensions, `rtcp`, `transactionId`), `setCodecPreferences`, `stop` and stopping, simulcast's rid negotiation, `ontrack` from a description, `RTCError`, `toJSON` and the IDL. Media tracks to add, but nothing sent. |
| **B. Connections and data channels** |    28 |               31% | Candidate gathering and `addIceCandidate`, `RTCIceTransport` and `RTCDtlsTransport` with their states and the remote certificates, data channels end to end (send, close and `bufferedAmount` over strings, blobs and array buffers, negotiated or not), `RTCSctpTransport`, ICE error events from an unreachable server, bundle, DTLS setup roles and crypto suites, handover, transport stats, and a data channel transferred to a worker.                          |
| **C. Media flowing**                 |    14 |               15% | RTP sent and received (`getSynchronizationSources`, `jitterBufferTarget`, receiver and mandatory `getStats`, stats lifetimes, RTP demuxing, header extension support), DTMF, a remote track's `currentTime` in a `<video>`, `videoDetectorTest` (which reads a received frame's pixels), simulcast with H.264 and VP9 scalability modes, screen share, and an encoded transform's `generateKeyFrame`.                                                                 |

Each tier stands on the one above it. A is about 2.7 points of the total,
B about 1.5 and C about 0.8.

## What the engine has, and has not

These carry over from WebTransport (`docs/prd-html-scripts.md`, "Streams
and WebTransport"):

- the bridge's conventions: numbers for objects, base64 for bytes, JSON for
  an entry's input, events told and never asked;
- a seam whose default refuses (`NO_WEBTRANSPORT`), and a network policy
  that supplies the real one (`HtmlNetwork.webTransport`);
- a worker's sessions carried across its thread (`transport-relay.ts`);
- streams written to the standard;
- the escape tests.

`<Html>` also mounts core's `<video>` over each `<video>` element it can
(`media.ts`, `videos.ts`), and a page's canvas pixels are the page realm's
(`CanvasState`).

What is missing is the whole of the media model: `MediaStream`,
`MediaStreamTrack`, `navigator.mediaDevices`, `canvas.captureStream`, Web
Audio, WebCodecs and `<video>.srcObject`.

## The spikes

### werift's peer connection

Two werift `RTCPeerConnection`s in one process, connected as WPT's helpers
connect two of a page's:

- **A data channel opens in 201 ms** (Node) and 181 ms (Bun), and a message
  sent on it arrives. ICE over loopback, DTLS and SCTP all work.
- **The offer/answer cases WPT checks mostly behave as JSEP has them**:
  - rolling back a local offer returns to `stable`;
  - a `setLocalDescription()` with no argument makes the offer;
  - a `pranswer` leaves `have-local-pranswer`;
  - a second offer keeps the first one's mids and adds the new;
  - bundle groups every section.
- **The API is mostly there**: `currentDirection`, `stop` and stopping,
  `setCodecPreferences`, `getParameters`/`setParameters`, `restartIce`,
  `getConfiguration`/`setConfiguration`, `canTrickleIceCandidates`, and
  `getStats` (peer-connection, outbound-rtp, transport, certificate).
- **What differs from a browser:**
  - The default offer has **no RTP header extensions**, where Chrome's
    offers several in each section (mid, rid, repaired rid, audio level,
    transport-wide congestion control, …).
  - Its codecs are **Opus and PCMU, and VP8**, with no `telephone-event`
    (which DTMF needs), G.722, RED, RTX, VP9 or H.264.
  - Codec names are upper case (`OPUS`), where a browser's `mimeType` is
    `audio/opus`.
  - There is no `getSynchronizationSources()` and no static
    `generateCertificate()`.
  - Events are subscriptions (`onIceCandidate.subscribe`), not DOM events.

  werift takes its codecs and header extensions as options, with helpers
  for each (`useOPUS`, `useVP8`, `useVP9`, `useH264`, `useSdesMid`,
  `useSdesRTPStreamId`, `useTransportWideCC`, `useAudioLevelIndication`,
  …), so most of this is configuration in the adapter rather than a
  fork. Its `generateCertificate`
  equivalent is `createSelfSignedCertificate`.

So werift's own peer connection is the engine, not just its transports
under an offer/answer layer written here. Writing JSEP from RFC 8829 is the
fallback for whatever its semantics cannot be adapted to. It is not the
plan, since what werift has already covers most of tier A's state
machines.

### libav.js's codecs

| build                         | encoders                               | decoders       | installed |
| ----------------------------- | -------------------------------------- | -------------- | --------: |
| `@libav.js/variant-webcodecs` | Opus, FLAC                             | Opus           |     16 MB |
| `@libav.js/variant-webm-vp9`  | **VP8, VP9 (libvpx 1.16), Opus**, FLAC | VP8, VP9, Opus |     19 MB |

No published build has H.264.

Encoding with `webm-vp9`, single-threaded WebAssembly, `deadline=realtime`,
`cpu-used=8`:

- **VP8 at 640×480 takes 3.8 ms a frame**, about 11% of a core at 30 fps;
- VP9 at 640×480 takes 18.7 ms a frame;
- **Opus takes 0.14 ms for a 20 ms frame**.

Bun gives the same: 3.9 ms for VP8. The module loads in 12 ms.

### Size

In a scratch install, werift and its dependencies came to 29 MB, about
11 MB of it `mediabunny`, and libav.js's `webm-vp9` to 19 MB. That is
nearly 50 MB, which an application that shows no WebRTC page must never
pay, and why both are optional peers.

### Where werift differs, case by case

Workstream 1's first round ran werift 0.25.2 against what WPT's tier-A
tests check, and the whole area through it. Each difference is corrected
on one side, or left for werift:

| werift                                                                                                                                       | a browser                                                 | who corrects it                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| Offers no header extensions, and only Opus, PCMU and VP8                                                                                     | Several of each, at its own ids                           | The adapter: `src/html/rtc-codecs.ts`, which `getCapabilities` answers from |
| Applies text that is not SDP as an empty description                                                                                         | `RTCError` of `sdp-syntax-error`, with the line           | The adapter (`syntaxErrorLine`); worth filing upstream                      |
| Applies a remote m-section with no `a=rtcp-mux`, or a payload type from 64 to 95                                                             | `InvalidAccessError`                                      | The adapter (`refusedMedia`); worth filing upstream                         |
| `sender.getParameters()` answers only `encodings`                                                                                            | Codecs, header extensions and RTCP too                    | The adapter, from the transceiver's negotiated codecs and extensions        |
| Throws for an `iceCandidatePoolSize` above 0                                                                                                 | A hint it may act on                                      | The adapter asks for no pool                                                |
| Its controlled side's transport is `completed` once a pair is nominated                                                                      | `connected`, until the remote's candidates have ended too | The adapter reports `connected`                                             |
| A selected pair's candidates are written without `candidate:`                                                                                | The attribute line                                        | The adapter adds it                                                         |
| A stopped transceiver keeps its direction, its mid, and its place in `getTransceivers()` once answered                                       | `stopped`, then no mid, then gone                         | The facade                                                                  |
| A rolled-back description's mids stay                                                                                                        | Taken back                                                | The facade, from the current descriptions                                   |
| `addIceCandidate` before a remote description is kept for later                                                                              | `InvalidStateError`                                       | The facade checks first                                                     |
| `bundlePolicy: 'balanced'` is kept as `max-compat`                                                                                           | Kept as given                                             | The facade keeps the page's configuration                                   |
| A remote offer's rejected m-section (port 0) makes no transceiver                                                                            | A stopped one, which `getTransceivers()` lists            | Left; worth filing upstream                                                 |
| One header extension URI has another id in each bundled m-section, whatever ids it is configured with                                        | One id per URI                                            | Left; worth filing upstream                                                 |
| An answer to an offer of `a=setup:active` is `active` too                                                                                    | `passive`                                                 | Left; worth filing upstream (a rewrite would desynchronise its DTLS role)   |
| A subsequent offer lists only the codecs negotiated before                                                                                   | Every codec it can                                        | Left; worth filing upstream                                                 |
| No `getSynchronizationSources`, no `RTCDtlsTransport.getRemoteCertificates`, no `generateCertificate` (it has `createSelfSignedCertificate`) | All three                                                 | The adapter, in workstreams 3 and 4                                         |
| Its own `iceConnectionState` can go `completed` before `checking`                                                                            | Never                                                     | The facade works its own out from the transports                            |

werift's polyfill (`werift/polyfill`) saves the facade nothing: it is a
W3C-shaped `RTCPeerConnection` over werift's own, which the page's realm
cannot hold, so the facade is written against the seam instead.

## Candidates

| candidate                         | what it is                                                                                    | why not, or why                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **werift 0.25**                   | ICE (with TURN), DTLS, SCTP, SRTP/RTP/RTCP, simulcast, an `RTCPeerConnection`, all TypeScript | **Chosen** for the connection. Active (0.25.2, 2026-10-24), MIT, the same on Node and Bun, nothing to build.                             |
| node-datachannel                  | Bindings to libdatachannel (C++), with a W3C polyfill                                         | A native addon with prebuilt binaries, data channels and RTP passthrough only, no codecs; its polyfill's semantics are libdatachannel's. |
| `@roamhq/wrtc`                    | node-webrtc, maintained by Roam: libwebrtc M106 in an N-API addon                             | See below.                                                                                                                               |
| `wrtc`                            | The original node-webrtc                                                                      | Unmaintained since 2023.                                                                                                                 |
| `@livekit/rtc-node`               | LiveKit's Rust SDK over libwebrtc                                                             | LiveKit's rooms API, not `RTCPeerConnection`.                                                                                            |
| **libav.js `webm-vp9`**           | FFmpeg's libavcodec with libvpx and libopus, in WebAssembly                                   | **Chosen** for codecs. VP8, VP9 and Opus both ways; memory-safe; the same everywhere.                                                    |
| `node-av`                         | Native FFmpeg bindings, a binary downloaded at install                                        | A download at install, and native code parsing what a peer sends. Reasonable as an opt-in faster backend later.                          |
| `opus-decoder`, `@discordjs/opus` | Opus alone (WebAssembly decoder; native encoder and decoder)                                  | Narrower than libav.js, and the native one is a build.                                                                                   |
| `sdp-transform`                   | SDP parsed and written, no dependencies                                                       | Useful in the adapter and its tests, wherever werift's SDP has to be read or adjusted.                                                   |

### Native libwebrtc, considered

libwebrtc is Google's C++ WebRTC library, the engine in Chrome and Safari.
It has everything a call needs: ICE, DTLS, SRTP, SCTP, JSEP, Opus, VP8,
VP9, AV1 and H.264, echo cancellation, noise suppression and gain control,
jitter buffers, congestion control, simulcast and SVC, and complete stats.
From Node it is reached through an N-API addon. `@roamhq/wrtc` 0.10.0
(2026-03) is the maintained one:

- prebuilt for macOS, Linux and Windows, about 25 MB each;
- the W3C API, with nonstandard sources and sinks for raw frames.

It is not the plan, for four reasons:

1. **It is libwebrtc M106, from 2022.** Releases come about once a year,
   and the branch has not moved. APIs Interop 2026 tests came after it or
   were never exposed: `jitterBufferTarget`, encoded transforms, a data
   channel transferred to a worker. Its README says WPT testing will come
   "eventually".
2. **Native code would parse what an untrusted peer sends**, inside the
   page process, four years of Chrome's security fixes behind. That is the
   wrong trade for an engine that renders arbitrary pages.
   werift is JavaScript, and libav.js runs in WebAssembly's sandbox.
3. **It goes only where a prebuilt binary does**, and it is untested under
   Bun.
4. **It saves less than it looks.** The engine's rule that only primitives
   cross the bridge means the facade, its events, state and errors, the
   worker relays, the media devices and `<video srcObject>` are ours either
   way. A native backend would replace only what sits behind the seam.

Where it would win is a real call's audio and bandwidth: echo cancellation
and Google's congestion control. That is a reason to keep the seam open to
a second backend, ideally a fresher libwebrtc than M106. It is not a reason
to start there.

## The shape

### The facade

These classes go in the page's realm, as source text beside
`webtransport.ts`, in a module of its own (`webrtc.ts`):

- `RTCPeerConnection`, `RTCSessionDescription`, `RTCIceCandidate`,
  `RTCPeerConnectionIceEvent` and `RTCPeerConnectionIceErrorEvent`;
- `RTCRtpTransceiver`, `RTCRtpSender`, `RTCRtpReceiver`;
- `RTCDataChannel` and `RTCDataChannelEvent`;
- `RTCDtlsTransport`, `RTCIceTransport`, `RTCSctpTransport`;
- `RTCDTMFSender` and `RTCDTMFToneChangeEvent`;
- `RTCCertificate`, `RTCStatsReport`, `RTCError` and `RTCErrorEvent`,
  `RTCTrackEvent`;
- later, `RTCRtpScriptTransform`;
- `MediaStream`, `MediaStreamTrack` and `MediaStreamTrackEvent`;
- `navigator.mediaDevices`, with `getUserMedia`, `enumerateDevices` and
  later `getDisplayMedia`.

**The facade owns the specification's semantics; the seam owns the
protocol.** Most of tier A's subtests are about conditions, not packets:

- which argument throws a `TypeError` and which state an
  `InvalidStateError`;
- that operations queue on the connection's operations chain;
- that `negotiationneeded` waits for the chain to empty;
- that `signalingstatechange` is told before the promise resolves;
- what a getter answers between two operations.

Those are written here, against the specification, whatever werift does.
The bridge is synchronous within the process, so a getter like
`signalingState` or `getTransceivers()` reads the facade's mirror, which
the seam's events keep current. The facade does not wait on the host for
it.

### The seam

`HtmlScripts.webRTC` is an `HtmlWebRTC` (`src/html/rtc.ts`), and
`HtmlScripts.mediaDevices` an `HtmlMediaDevices`
(`src/html/media-devices.ts`). Across the bridge, a connection and its
objects are numbers, as WebTransport's are. The facade asks for operations
(`rtcCreateOffer`, `rtcSetLocal`, `rtcAddTransceiver`, `rtcSend`, …) and
the host tells it what becomes of them, through `__rtc…` entries:

- an offer made;
- a candidate gathered;
- a state changed;
- a channel opened;
- a message, a track, an error.

Behind the host, the seam names an object for what the host calls methods
on: a connection, a transceiver, a data channel, a media source. It names
a number for what is only told of: a transport, a certificate. That is
WebTransport's split too, whose seam has stream objects and send groups by
number.

These are the decisions the interface made, which workstreams 1 to 4
stand on:

- **An operation is answered with state.** `setLocalDescription` and
  `setRemoteDescription` answer every transceiver as the description left
  it (`RTCTransceiverState`):
  - its mid, direction and current direction;
  - the direction the remote's m-section has;
  - whether it is stopped;
  - its sender's and receiver's negotiated parameters and transports;
  - the streams the remote's `msid` names.

  They also answer the SCTP transport. The facade compares that with its
  mirror and tells the page's events in WebRTC 1.0's order.

- **A transport's state is told whole** (`RTCTransportStateLike`): its
  ICE and DTLS states, role, selected pair, parameters and the remote's
  certificates, as one object whenever any of it changes.
- **What WebRTC 1.0 works out from state the realm has is the realm's**:
  - the connection's `iceConnectionState`, `connectionState` and
    `iceGatheringState`, from its transports';
  - whether negotiation is needed;
  - a `track` event;
  - `bufferedAmount`, from what was sent and what the seam says left;
  - each DTMF tone's timing, the seam sending one tone at a time.
- **The descriptions are read from the stack** (`descriptions()`), since
  a local description holds the candidates gathered since it was set.
- **`getCapabilities` is answered at once**, from what the stack is
  configured with. It is synchronous, so the adapter's codec table lives
  in a light module, and werift loads with the first connection.
- **A track is a source** (`MediaSourceLike`), whoever makes its frames:
  a device, a screen or a receiver. A clone is another track of the same
  source, which the host counts. Video is I420, which core's `VideoFrames`
  and libvpx take as they are. Audio is 10 ms of planar floats, Web
  Audio's and WebCodecs' `f32-planar`, and a peer connection's frame.
- **A device's id is the seam's, and the page sees a digest of it** with
  its origin. Its label is hidden until the kind is allowed; both are the
  realm's rules to keep.
- **What a seam rejects with is named** (`rtcError`, `mediaError`): a
  `DOMException`'s name, or `RTCError` with its detail, which the realm
  makes into its own error.

**Its default connects nothing** (`NO_WEBRTC`):

- the constructor works, and transceivers and data channels are made;
- an operation that needs the engine rejects with a `NotSupportedError`
  that names the missing seam;
- no candidate is gathered and no socket is opened;
- `getCapabilities` answers null.

`HtmlNetwork.webRTC` supplies a seam over werift (`src/html/werift.ts`),
loaded the first time a page constructs a connection.

What the adapter does:

- maps werift's subscriptions to the seam's told events;
- configures werift's codecs and header extensions as a browser offers
  them:
  - audio: Opus, G.722, PCMU, PCMA, `telephone-event`;
  - video: VP8, VP9, RTX;
  - header extensions: mid, rid, repaired rid, audio level, absolute send
    time, transport-wide congestion control;
- writes codec names as browsers do;
- makes `generateCertificate` from `createSelfSignedCertificate`;
- answers `getSynchronizationSources` from the RTP it receives.

Anything werift cannot be configured into is adapted, and filed upstream
where it is werift's to fix, as quico's three behaviours were
(colocohen/quico#8, #9, #10).

### Media

- **Sources.** `getUserMedia` goes through `HtmlScripts.mediaDevices`,
  whose default has no device: `NotFoundError`, as on a machine with none.
  The WPT runner's seam gives fake devices (`fakeMediaDevices`): a test
  pattern and a tone, as wptrunner runs Chrome with fake media devices,
  and its `test_driver.set_permission` sets what they answer. A real camera or
  microphone is the host's to supply, and the host's permission to ask.
  `canvas.captureStream` comes in tier C, from the page realm's canvas
  pixels.
- **Sending.** A track's frames are encoded by libav.js, VP8 or Opus, on a
  worker thread of the host's so a frame's encode never holds the page.
  They are packetized and sent by werift's RTP sender.
- **Receiving.** werift's receiver hands RTP over, libav.js decodes it, and
  the frames feed the `VideoFrames` sink of a core `<video frames>` that
  `<Html>` mounts over a `<video srcObject>`. That needs `srcObject` in the
  facade and a kind of media rect that `videos.ts` mounts from a stream
  rather than from `onResource`.
- **Audio.** Core has no audio output, so a received audio track is
  decoded and counted, which its stats and `currentTime` need, and not
  heard. That is a gap of core's to file, not this design's to fill.
- **`videoDetectorTest`** reads a received frame's pixels through a
  canvas. That means bringing decoded frames into the page realm's
  `CanvasState`, which is the most expensive crossing in the design and
  the last thing to build.

### Workers

`RTCDataChannel` is transferable, and `RTCRtpScriptTransform` runs its
transform in a worker. Both cross the thread as a worker's WebTransport
sessions do, over the thread's channel, tagged `{ kind: 'rtc' }`, to a
relay in the page process that drives the page's own seam.

## Threat model

- **Only primitives cross the bridge, as everywhere.** A message's bytes
  are base64. A rejection and an error hand the page the page realm's own
  objects, and the escape tests (`test/html/scripts.test.ts`) gain WebRTC
  cases. They read what a refused operation rejects with, not only that it
  was refused.
- **What a peer sends is parsed in JavaScript and WebAssembly**, never in
  native code: SRTP, RTCP, SCTP and the codecs' bitstreams.
- **ICE reaches whatever addresses a remote description names.** A page
  can use that to probe a local network, which browsers bound with ICE
  consent and rate limits. The network policy decides what the seam may
  connect to, and the default connects to nothing.
- **A page learns local addresses from its own candidates.** Chrome hides
  them behind mDNS `.local` names until the page is granted media. The
  policy here is the host's, and `HtmlNetwork.webRTC` hides them by
  default. werift resolves a remote `.local` candidate (`MdnsLookup`, over
  `multicast-dns`) but answers no query for names of its own, so offering
  its host addresses that way is the adapter's to add, or werift's
  (below).

## The work, split

Each workstream after the first is a loop:

1. measure the area (`scripts/conformance/interop.ts --only webrtc`);
2. fix the biggest honest gap;
3. open a PR, and merge it on green;
4. repeat.

| #   | workstream                                                                                                                                                                                                                             | needs            | tests it targets             | area after, roughly |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------- | ------------------: |
| 0   | **This document, then the seam's interface** (`HtmlWebRTC`, `HtmlMediaDevices`): its ops and events written down and reviewed, plus the runner's fake devices                                                                          | —                | —                            |                0.2% |
| 1   | **The facade and the offer/answer layer over werift.** Every class in tier A, the operations chain, the mirror, configuration, SDP as a browser writes it; driven in CI by a fake seam, as WebTransport's fake server drives its tests | 0                | tier A                       |                ~50% |
| 2   | **`MediaStream`, `MediaStreamTrack`, `mediaDevices`.** Enough for tier A's tests to add tracks, early; `canvas.captureStream` later                                                                                                    | 0                | tier A's track cases, then C |                   — |
| 3   | **The transport.** Candidates, ICE and DTLS states, data channels end to end, SCTP, ICE errors, transport stats, a channel transferred to a worker                                                                                     | 0; runs beside 1 | tier B                       |                ~80% |
| 4   | **The media pipeline.** libav.js encode and decode on a worker, RTP both ways, `getSynchronizationSources`, receiver stats, `jitterBufferTarget`, DTMF, `<video srcObject>`                                                            | 1, 2, 3          | most of tier C               |                ~92% |
| 5   | **Simulcast encoders, VP9 scalability, encoded transforms in a worker, screen share, `videoDetectorTest`**                                                                                                                             | 4                | the rest of C                |                ~97% |

Workstreams 1 and 3 can run in parallel once 0 has fixed the seam. 2 is
small and goes first inside 1. 4 and 5 are serial.

For scale, WebTransport (API, seam, streams, workers and CSP) took three
PRs. This is five to ten times as much work. Most of it is in 1 and 4.

## Open questions

- **H.264.** No published libav.js build encodes it. RFC 7742 asks a
  browser for VP8 and H.264 both, and one test needs H.264 simulcast.
  - A custom libav.js build with OpenH264 is possible. Cisco's patent
    coverage applies only to Cisco's own binaries, though, so building it
    ourselves is a licensing question, not a technical one.
  - Until it is settled, H.264 is negotiated in SDP only where that is
    honest (receive-only nowhere, since nothing decodes it), and its tests
    are left.
- **werift's semantics, case by case.** Listed in "Where werift differs,
  case by case" above, with which side corrects each. The ones left for
  werift are upstream issues to file.
- **mDNS host candidates.** werift resolves `.local` names and publishes
  none. Answering queries for a host candidate's name, as Chrome does, is
  a responder on `multicast-dns`, in the adapter or as a werift change
  filed upstream.
- **A codec's thread.** libav.js runs on one thread here
  (`nothreads: true`). VP8 at 640×480 fits in a frame's budget on one core,
  but a page with several tracks, or a larger resolution, wants an encoder
  per track on a worker. The worker pool belongs to the media pipeline,
  not the seam.
- **Audio output** is core's to grow before a received track is heard.

## Measuring it

The area is measured with the interop runner as every other area is:

```bash
npx tsx scripts/conformance/interop.ts wpt wpt-metadata --only webrtc
```

That uses a full WPT checkout and `./wpt serve`, as `docs/interop-2026.md`
says.

On a Mac without `systemd-run`, the runner watches each child's memory
(#1023).

A connection between two of the page's own peers needs no STUN or TURN
server. The ICE error tests name STUN and TURN servers under `.invalid`,
which never resolve, so a seam that reports a failed lookup as an
`icecandidateerror` is all they need.
