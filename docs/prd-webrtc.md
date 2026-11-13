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
0.2% to 57.0%. Workstream 1's tier-A rounds followed, beside workstream
3's: a canvas's `captureStream()` (#1031), parameters taken from answers
alone (#1034), transceivers stopped and rolled back as WebRTC 1.0 has
them (#1036, #1039), simulcast narrowed by an answer (#1040), Web Audio
(#1041), remote descriptions read as a browser reads them (#1042), and a
rejected m-section's transceiver; with workstream 3's, the area came to
77.6%. A page's real cameras, microphones and screen came next, over
react-x11 2.57's media capture (`coreMediaDevices`), with `getDisplayMedia`
and a stream played in a `<video>` or an `<audio>`: on WPT fea36e4 with
fake devices, `mediacapture-streams` went from 50.7% to 79.9% with the
constraint round beside it, and `screen-capture` from 23.0% to 61.9%.
A facade round then took what
tier A had left that needs neither media nor H.264: `RTCDTMFSender`,
whose tests time the tones and read no RTP (the seam is handed each
tone, and werift's adapter sends none yet), the candidate grammar, the
ICE server URL checks, a certificate's clone and origin, when a sender's
transport is set, and `transceiver.stopped`, which WebRTC 1.0 no longer
has and every browser still ships. Workstream 4's first round makes
media flow: Opus, G.711, VP8 and VP9 both ways through libav.js, a remote
track's mute, its synchronization sources and the RTP stats. On WPT
fea36e4, every `/webrtc*` test wpt.fyi lists, 340 with their variants,
went from 55.3% to 61.9%, and the area's 91 from 78.2% to 85.4%. The
spikes it quotes ran on
Node 24.22.0 and Bun 1.4.3 on an M5 Pro. They were scratch scripts and
are not in the repository.

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

| werift                                                                                                                                                                                                                                                                              | a browser                                                                                                                   | who corrects it                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offers no header extensions, and only Opus, PCMU and VP8                                                                                                                                                                                                                            | Several of each, at its own ids                                                                                             | The adapter: `src/html/rtc-codecs.ts`, which `getCapabilities` answers from                                                                                                                                                                                                       |
| Applies text that is not SDP as an empty description                                                                                                                                                                                                                                | `RTCError` of `sdp-syntax-error`, with the line                                                                             | The adapter (`syntaxErrorLine`); worth filing upstream                                                                                                                                                                                                                            |
| Applies a remote m-section with no `a=rtcp-mux`, or a payload type from 64 to 95                                                                                                                                                                                                    | `InvalidAccessError`                                                                                                        | The adapter (`refusedMedia`); worth filing upstream                                                                                                                                                                                                                               |
| Splits a description's lines on CRLF alone, so one that mixes in bare LFs runs its lines together                                                                                                                                                                                   | Either ending, line by line                                                                                                 | The adapter writes every ending as CRLF first                                                                                                                                                                                                                                     |
| Takes a remote description that moves a negotiated header extension to another id, or an id to another extension                                                                                                                                                                    | `InvalidAccessError` (RFC 8285, JSEP 5.8)                                                                                   | The adapter (`reassignedExtension`); worth filing upstream                                                                                                                                                                                                                        |
| Throws on a remote m-section of a kind it does not read (`m=unicorns`)                                                                                                                                                                                                              | Rejected in the answer with port 0, as its own kind (JSEP 5.3.1)                                                            | The adapter hands werift a rejected audio m-section in its place, and puts the kind back in the answer and the descriptions                                                                                                                                                       |
| `sender.getParameters()` answers only `encodings`                                                                                                                                                                                                                                   | Codecs, header extensions and RTCP too                                                                                      | The adapter, from the transceiver's negotiated codecs and extensions                                                                                                                                                                                                              |
| Throws for an `iceCandidatePoolSize` above 0                                                                                                                                                                                                                                        | A hint it may act on                                                                                                        | The adapter asks for no pool                                                                                                                                                                                                                                                      |
| Its controlled side's transport is `completed` once a pair is nominated                                                                                                                                                                                                             | `connected`, until the remote's candidates have ended too                                                                   | The adapter reports `connected`                                                                                                                                                                                                                                                   |
| Its ICE transport is `completed` once it has gathered, before it has checked anything; its controlled side is connected before it says it is checking; an ICE restart takes a connected transport back to `new` and `checking`                                                      | `new`, `checking`, `connected`, and a restart of a connected transport stays connected                                      | The adapter (`iceStateAfter`); worth filing upstream                                                                                                                                                                                                                              |
| A transport's stats say `iceState: completed` once it has gathered, leave `iceRole`, `dtlsRole` and `selectedCandidatePairChanges` out until it is connected, and name the version `DTLS 1.2` and the SRTP profile `AEAD_AES_128_GCM`                                               | `new`, the roles from the start, the hex of the version field (`FEFD`) and IANA's profile name (`SRTP_AEAD_AES_128_GCM`)    | The adapter (`_transportStats`)                                                                                                                                                                                                                                                   |
| A selected pair's candidates are written without `candidate:`                                                                                                                                                                                                                       | The attribute line                                                                                                          | The adapter adds it                                                                                                                                                                                                                                                               |
| A stopped transceiver keeps its direction, its mid, and its place in `getTransceivers()` once answered                                                                                                                                                                              | `stopped`, then no mid, then gone                                                                                           | The facade                                                                                                                                                                                                                                                                        |
| A rolled-back description's mids stay                                                                                                                                                                                                                                               | Taken back                                                                                                                  | The facade, from the current descriptions                                                                                                                                                                                                                                         |
| A transceiver stopping is negotiated no `currentDirection` by an answer, or `inactive`, and its local description is written again as `inactive`                                                                                                                                    | What the answer as handed negotiated, until an answer takes it out                                                          | The adapter reads it from the answer (`_noteNegotiated`)                                                                                                                                                                                                                          |
| A transceiver a rolled-back remote offer made stays once it has a track, `replaceTrack`'s included                                                                                                                                                                                  | Taken away and stopped, unless `addTrack` gave it a track                                                                   | The facade stops it, and the page never sees it again (`discarded`)                                                                                                                                                                                                               |
| Brings up no transport for a transceiver stopping, so one stopped while its offer was still to be applied answers checks and never connects                                                                                                                                         | The transport stays until a negotiation takes the transceiver out                                                           | The adapter makes it `inactive` and holds werift's `stop()` until the next offer or answer                                                                                                                                                                                        |
| `addIceCandidate` before a remote description is kept for later                                                                                                                                                                                                                     | `InvalidStateError`                                                                                                         | The facade checks first                                                                                                                                                                                                                                                           |
| `bundlePolicy: 'balanced'` is kept as `max-compat`                                                                                                                                                                                                                                  | Kept as given                                                                                                               | The facade keeps the page's configuration                                                                                                                                                                                                                                         |
| A remote offer's rejected m-section (port 0) makes no transceiver                                                                                                                                                                                                                   | A stopped one, which `getTransceivers()` lists                                                                              | The adapter lists a stand-in for it, which the facade stops at once, until the answer takes it out; worth filing upstream                                                                                                                                                         |
| One header extension URI has another id in each bundled m-section, whatever ids it is configured with                                                                                                                                                                               | One id per URI                                                                                                              | Left; worth filing upstream                                                                                                                                                                                                                                                       |
| An answer to an offer of `a=setup:active` is `active` too                                                                                                                                                                                                                           | `passive`                                                                                                                   | werift itself, from 0.26.0, which answers `passive`                                                                                                                                                                                                                               |
| A subsequent offer lists only the codecs negotiated before                                                                                                                                                                                                                          | Every codec it can                                                                                                          | Left; filed as [werift#818](https://github.com/shinyoshiaki/werift-webrtc/issues/818)                                                                                                                                                                                             |
| No `getSynchronizationSources`, no `generateCertificate` (it has `createSelfSignedCertificate`)                                                                                                                                                                                     | Both                                                                                                                        | The adapter, in workstreams 1 and 4                                                                                                                                                                                                                                               |
| Sends no RTCP BYE as a sender stops or its connection closes                                                                                                                                                                                                                        | A BYE, which the far side mutes its track on                                                                                | The adapter mutes a remote track after two seconds with no packet; a sender sends its last frame again each second; worth filing upstream                                                                                                                                         |
| Refuses a local offer that differs from the last it made, in any way                                                                                                                                                                                                                | Takes a description the page changed (SDP munging): Meet adds simulcast layers and header extensions to every offer it sets | The realm takes one with this connection's credentials that is no earlier offer; the adapter writes the header extensions it changed into werift's transceivers and has werift make its offer again, and what else was added is not sent                                          |
| Numbers the header extensions again from 1, audio's then video's, whatever ids it is given                                                                                                                                                                                          | One id for a URI in every section of a bundle                                                                               | The adapter puts the configured ids back (`keepExtensionIds`): Meet adds extensions at ids the sections leave free, which collided                                                                                                                                                |
| Routes RTP by SSRC or rid alone: a stream whose description names no SSRC and whose packets carry no rid is dropped, whatever its mid or payload type                                                                                                                               | Demuxed by mid, then by payload type (RFC 8843, 9.2)                                                                        | Left; worth filing upstream (WPT `protocol/rtp-demuxing`)                                                                                                                                                                                                                         |
| Collects an outbound-rtp from a sender's making, an inbound-rtp from the description naming its SSRC, and either of a stopped transceiver                                                                                                                                           | From the answer that first sends, and the first packet (WebRTC Statistics, 3.2)                                             | The adapter                                                                                                                                                                                                                                                                       |
| Writes no audio level extension on what it sends                                                                                                                                                                                                                                    | Each audio packet's level (RFC 6464)                                                                                        | The adapter puts one on each audio packet it sends                                                                                                                                                                                                                                |
| No `RTCDtlsTransport.getRemoteCertificates`                                                                                                                                                                                                                                         | The peer's certificates, DER                                                                                                | The adapter reads the DTLS socket's `remoteCertificate`                                                                                                                                                                                                                           |
| Asks `stun.l.google.com` where a configuration names no STUN server, and `setLocalDescription` waits up to five seconds for the answer, with no option against either                                                                                                               | Gathering asks only the servers the page named                                                                              | The adapter clears each transport's server before `setLocalDescription` (`_gatherFromNamed`); worth filing upstream                                                                                                                                                               |
| Gathers its host candidates inside `setLocalDescription`, so the local description holds them as its promise settles                                                                                                                                                                | The candidates the page has heard of, each added as its `icecandidate` is fired                                             | The facade (`surfacedOnly`)                                                                                                                                                                                                                                                       |
| Its own `iceConnectionState` can go `completed` before `checking`                                                                                                                                                                                                                   | Never                                                                                                                       | The facade works its own out from the transports                                                                                                                                                                                                                                  |
| A data channel's `close()` resets its stream at once, with what it has queued unsent or unacknowledged; the far side drops what arrives after a reset, doing none of RFC 6525's deferred reset processing (5.2.2)                                                                   | What was sent before the close arrives                                                                                      | The adapter closes once SCTP acknowledged it all (`sentQueue`, a private); worth filing upstream                                                                                                                                                                                  |
| An association that goes closes its channels with no error                                                                                                                                                                                                                          | An `RTCErrorEvent` of `sctp-failure`, then `close`                                                                          | The adapter tells the error                                                                                                                                                                                                                                                       |
| Sends an empty message as nothing: it cuts a message into as many chunks as it has bytes' worth                                                                                                                                                                                     | One byte under payload protocol 56 (an empty string) or 57 (empty bytes), RFC 8831, 6.6                                     | The adapter puts that byte on werift's send queue (`_sendEmpty`), the one place it reaches in; worth filing upstream                                                                                                                                                              |
| Hands on a message that arrives before the far side's DATA_CHANNEL_ACK while its channel still says `connecting`                                                                                                                                                                    | The message is the ACK: the channel opens, then the message (RFC 8832, 6)                                                   | The adapter opens the channel first; worth filing upstream                                                                                                                                                                                                                        |
| Writes candidates into every m-section of a `max-bundle` description                                                                                                                                                                                                                | Only the bundle's first, whose transport the others ride                                                                    | The facade (`surfacedOnly`)                                                                                                                                                                                                                                                       |
| Its agent is `checking` as an answer is applied, with none of the peer's candidates                                                                                                                                                                                                 | `new` until it has one, signalled or peer-reflexive                                                                         | The adapter holds `new` until `connection.remoteCandidates` has one, and looks again while it holds                                                                                                                                                                               |
| Announces a channel the far side opened before it opens it and queues its DCEP ACK, so a page that closes it in `ondatachannel` resets the stream ahead of the ACK; the opener then throws for an ACK of a channel it no longer has, from its UDP handler, where nothing catches it | The ACK goes first; nothing throws                                                                                          | The adapter tells the page a microtask later, holding what arrives meanwhile, and a close waits for the channel's DCEP messages; the throw is worth filing upstream                                                                                                               |
| Gives a channel its id as the association connects and tells it with nothing                                                                                                                                                                                                        | The id as the DTLS role is known, a channel made after that has one at once (6.1)                                           | The adapter tells each id before the transport connected, and answers a new channel's at once (`rtcChannelId`); one before the association is up is left, filed as [werift#815](https://github.com/shinyoshiaki/werift-webrtc/issues/815)                                         |
| Takes a channel's stream id parity from its ICE role                                                                                                                                                                                                                                | From its DTLS role (RFC 8832, 6)                                                                                            | Left; filed as [werift#815](https://github.com/shinyoshiaki/werift-webrtc/issues/815)                                                                                                                                                                                             |
| Pairs a remote offer's m-section with a transceiver `addTransceiver` made                                                                                                                                                                                                           | Only one `addTrack` made, or none (JSEP 5.10)                                                                               | Left; filed as [werift#816](https://github.com/shinyoshiaki/werift-webrtc/issues/816)                                                                                                                                                                                             |
| Takes away on a rollback a transceiver a remote offer made that `addTrack` used, where `replaceTrack(null)` took its track since                                                                                                                                                    | Kept: `addTrack` used it                                                                                                    | Left; filed as [werift#817](https://github.com/shinyoshiaki/werift-webrtc/issues/817)                                                                                                                                                                                             |
| Writes no `msid` for a track it sends in no stream, which a far side reads as the default stream                                                                                                                                                                                    | `a=msid:-`                                                                                                                  | The adapter writes it (`namingNoStream`), and takes it out before a local description reaches werift                                                                                                                                                                              |
| Runs ICE-TCP only with `iceUseTcp`, off by default and off here, yet takes a remote TCP candidate it can pair with nothing, so its transport goes to `checking` for a pair nothing connects                                                                                         | Ignores a candidate it cannot use                                                                                           | The adapter keeps every candidate but UDP's from werift (`overUdp`), so werift's remote description, which the page reads back, has none of them                                                                                                                                  |
| Throws "Failed to parse ICE candidate" for a candidate handed to `addIceCandidate` with its SDP framing's `a=`, which a browser takes                                                                                                                                               | The attribute it frames                                                                                                     | The adapter takes the `a=` off                                                                                                                                                                                                                                                    |
| Tells the page of no STUN or TURN server it could not use                                                                                                                                                                                                                           | `icecandidateerror`, code 701 where no candidate could reach it                                                             | The adapter looks each server's host up and reads the address it comes to (`src/html/ice-servers.ts`), naming a host candidate as Firefox does; a server that resolves and never answers is left, filed as [werift#812](https://github.com/shinyoshiaki/werift-webrtc/issues/812) |
| Reports a peer-reflexive remote candidate's address, related address and ufrag in its stats                                                                                                                                                                                         | None of them until signalling tells the page the address                                                                    | The adapter (`hideLearned`), and the facade for the selected pair, whose remote is then the empty string with a null address (`remoteCandidateFrom`)                                                                                                                              |
| Writes a local certificate's `base64Certificate` as the base64 of its PEM text                                                                                                                                                                                                      | Its DER, which hashes to the fingerprint                                                                                    | The adapter takes the PEM's own base64 (`derCertificate`); worth filing upstream                                                                                                                                                                                                  |
| Keeps its SCTP transport after a rollback of the description that made it                                                                                                                                                                                                           | `sctp` is null again (4.4.1.6)                                                                                              | The facade drops it where no current description has a data m-section                                                                                                                                                                                                             |
| Closes a DTLS transport with no `close_notify`, and fails one whose peer's fingerprint does not match without sending an alert, so the far side hears of neither: its DTLS transport stays `connected`, or `connecting`, though SCTP's own abort closes its channels                | `close_notify`, and a fatal alert the far side fails on as `dtls-failure`                                                   | Left; filed as [werift#811](https://github.com/shinyoshiaki/werift-webrtc/issues/811). It is `dtls-close`, `RTCDtlsTransport-state`, `-onerror` and `dtls-fingerprint-validation`                                                                                                 |
| Answers no connectivity check before it has the remote description                                                                                                                                                                                                                  | Answers, and learns the checker as a peer-reflexive candidate                                                               | Left; filed as [werift#813](https://github.com/shinyoshiaki/werift-webrtc/issues/813) (`getStats-remote-candidate-ufrag`)                                                                                                                                                         |
| Sends a host candidate's checks from whichever local address the route picks, so on a machine with two interfaces they leave from an address it did not advertise, and the far side finds a peer-reflexive candidate where it was told a host one                                   | Each from the address it advertised                                                                                         | Left; filed as [werift#814](https://github.com/shinyoshiaki/werift-webrtc/issues/814). It fails `RTCIceTransport`'s pair check on such a machine, on master as on the branch                                                                                                      |

The close is corrected where the adapter sends. A peer's reset can still
overtake its own retransmission to werift, which drops it, and only werift
can mend that.

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
- `RTCRtpScriptTransform`, and in a worker `RTCRtpScriptTransformer`,
  `RTCTransformEvent` and the encoded frames (`encoded-transform.ts`);
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
    time, transport-wide congestion control, video orientation, and
    abs-capture-time, which starts `stopped`;
- writes each transceiver's header extensions into werift's before an
  offer and an answer (`forOffer`, `forAnswer`), since werift offers all
  it is configured with and answers all an offer has that it knows;
- takes the `a=extmap` lines a page changed in a local description into
  those transceivers, and has werift make its offer again from them;
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
  microphone is the host's to supply, and the host's permission to ask:
  `coreMediaDevices(app)` (`src/html/core-media.ts`) is react-x11 2.57's
  media capture behind the seam — a device a page opens is one core track
  at the settings its constraints came to, Chrome's defaults where they
  leave a setting open — and the example browser hands it, asking in its
  bar. `getDisplayMedia` is the page realm's checks (a press, no `min` or
  `exact`, the options' enums) over the seam's `display(ask, wants)`, the
  picture fitted to its constraints host-side (`displayFit`).
  `canvas.captureStream` comes from the page realm's canvas pixels.
- **Constraints.** `getUserMedia` and `applyConstraints` fit a page's
  constraints on the host with Media Capture's SelectSettings
  (`src/html/scripts/constraints.ts`), over a camera's native `modes` and
  what `'crop-and-scale'` makes of them. What a document's
  `enumerateDevices` shows it is what it has captured, as Firefox and Safari
  have it, not what it is allowed.
- **Frames.** A frame is in the format its source delivers it in — a Mac
  camera's NV12, an X11 screen's BGRA, a canvas's I420 — and `toI420`
  converts it where a reader needs I420, which an encoder will. A source is
  listened to once (`PageSources`); its frames are asked of it only while a
  reader reads them (`read`), by listening again with `video` or `audio`
  in the events, and a source that does not show itself is read for its
  size while a media element plays it.
- **Showing.** A `<video srcObject>` and an `<audio srcObject>` are the
  page realm's media element model played over a stream (Media Capture
  6.2), and `<Html>` mounts what plays it from what the page tells the host
  (`mediaStream`, `HtmlViewNode.showStream`): a source of core's shows
  itself through core's own `<video srcObject>` and `<audio srcObject>`
  (`MediaSourceLike.present`), a camera onto a layer on macOS with no frame
  in JavaScript and what is heard what the echo canceller subtracts; any
  other is a `VideoFrames` sink, or an `AudioFrames` sink, fed from
  `read`. A received track will be the second kind.
- **Sending.** A track's frames are encoded by libav.js in the codec the
  answer negotiated — Opus, VP8 or VP9, and G.711, which is a table
  (`src/html/media-codecs.ts`) — packetized with werift's own packetizers
  and written into the werift track its RTP sender sends from
  (`src/html/werift-media.ts`). The sender reads its frames through a tap
  of the page's source (`PageSources.tap`), one reader among the others,
  since a source has one listener and the page's tracks hold it. The tap
  is the track as a sink sees it, not the source: the page's realm tells
  the host each change of a sender's track (`rtcTrackOutput`), and while
  the track is disabled the tap reads nothing of a video source and hands
  over a black frame a second, and silence in place of an audio source's
  sound; once the track ended it hands over nothing and says `ended`,
  whatever clone of the track still reads the source. So every stack
  sends what its track gives with nothing of its own for it. It encodes
  only while werift can send — a codec negotiated, DTLS connected, the
  direction sending — starts each run with a key frame and makes one where
  the peer asks (PLI or FIR), drops a frame that comes while the last is
  being encoded rather than fall behind, and sends its last frame again
  where none came for a second. Each Opus packet carries its level (RFC
  6464). The codecs run on a worker thread of their own ("A codec's
  thread" below).
- **Receiving.** werift's receiver hands RTP over, and the receiver's
  source (`MediaReceiver`) unmutes on the first packet, keeps the sources
  `getSynchronizationSources` answers from, with each audio packet's level,
  and mutes again once none has come for two seconds: werift sends no RTCP
  BYE, which is what Chrome mutes on. While something reads its frames —
  a `<video srcObject>`, the size its media element waits for — it puts a
  video frame's packets together, decodes it with libav.js, and hands the
  frames on as its source's (`MediaSourceLike.listen`), which a
  `<video srcObject>` already shows through a `VideoFrames` sink. A decoder
  that starts, or that lost a packet, waits for a key frame and asks for
  one. There is no jitter buffer yet: a packet out of order is a loss.
- **Audio.** A received audio track is decoded while a media element plays
  it, and heard where core has an `AudioFrames` sink for it.
- **`videoDetectorTest`** reads a received frame's pixels through a
  canvas. That means bringing decoded frames into the page realm's
  `CanvasState`, which is the most expensive crossing in the design and
  the last thing to build.

### Workers

`RTCDataChannel` is transferable, and `RTCRtpScriptTransform` runs its
transform in a worker. Both cross the thread as a worker's WebTransport
sessions do, over the thread's channel, tagged `{ kind: 'rtc' }`, to a
relay in the page process that drives the page's own seam.

A transform is a number of its window's realm. Made, its options are posted
to its worker as a message of their own (`{ rtx, d }`), which the worker's
realm hears as `rtctransform`. Put on a side, the host tells the worker so
(`tf`, `attach`) and hands the seam a sink for that side
(`RTCTransceiverLike.transform`): from then on `MediaSender` hands each
encoded frame to it rather than packetizing it, and `MediaReceiver` each
frame it put together rather than decoding it. A frame crosses to the
worker as base64 (`tf`, `frame`), and what the worker writes back crosses
again (`tfAsk`, `write`) to `writeFrame`, which packetizes or decodes it.
writeEncodedData's rules are the worker realm's, which knows which
transformer gave a frame and in what order.

A `MediaStreamTrack` is transferable too (Media Capture Extensions), and
crosses differently. Its source stays with the realm that opened it, and the
track made of it reaches the source over a port back, which the page's own
`MessagePort` wires carry across a thread. That keeps the host out of it,
but it also means a transferred track has no source number where it lands,
so its frames reach nothing there until workstream 4 gives such a track a
way to its source's frames.

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

| #   | workstream                                                                                                                                                                                                                                      | needs            | tests it targets             | area after, roughly |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------- | ------------------: |
| 0   | **This document, then the seam's interface** (`HtmlWebRTC`, `HtmlMediaDevices`): its ops and events written down and reviewed, plus the runner's fake devices                                                                                   | —                | —                            |                0.2% |
| 1   | **The facade and the offer/answer layer over werift.** Every class in tier A, the operations chain, the mirror, configuration, SDP as a browser writes it; driven in CI by a fake seam, as WebTransport's fake server drives its tests          | 0                | tier A                       |                ~50% |
| 2   | **`MediaStream`, `MediaStreamTrack`, `mediaDevices`.** Enough for tier A's tests to add tracks, early; `canvas.captureStream` later                                                                                                             | 0                | tier A's track cases, then C |                   — |
| 3   | **The transport.** Candidates, ICE and DTLS states, data channels end to end, SCTP, ICE errors, transport stats, a channel transferred to a worker                                                                                              | 0; runs beside 1 | tier B                       |                ~80% |
| 4   | **The media pipeline.** libav.js encode and decode, RTP both ways, `getSynchronizationSources`, receiver stats, `<video srcObject>` (first round built), the codecs on a worker (built); then a jitter buffer, `jitterBufferTarget`, DTMF's RTP | 1, 2, 3          | most of tier C               |                ~92% |
| 5   | **Simulcast encoders, VP9 scalability, encoded transforms in a worker, screen share, `videoDetectorTest`**                                                                                                                                      | 4                | the rest of C                |                ~97% |

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
- **A codec's thread.** Settled for one thread: the codecs run on a
  `worker_threads` worker of their own (`src/html/media-codec-thread.ts`),
  which holds them by number, is made with the first and ends with the
  last, and holds no process open. What a codec is handed is copied once
  and the copy moved there, and what it hands back is moved back. A
  640×480 canvas sending VP8 cost the page's thread 6 to 10 ms a frame,
  by what it draws, 1.9 ms of it making I420 of the canvas's BGRA, which
  the worker does as well; it costs it 0.35 ms, the copy and the post. In
  a call between two of a page's connections, at 25 frames a second, the
  page's thread went from 470 ms busy a second to 290 (Node 26 on an M1
  Pro, the mock backend, so that no frame is painted). Where
  no worker can be made, a bundle that left the entry behind among them,
  the codecs run on the page's thread, as the first round had them.
  What is still open is the one thread: libav.js runs single-threaded
  there (`nothreads: true`), so every track's codecs take turns on one
  core, and a page with several tracks, or a larger resolution, wants an
  encoder per track. The pool belongs to the media pipeline, not the
  seam.
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
