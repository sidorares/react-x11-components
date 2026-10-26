// What a page's peer connections offer: the codecs and the RTP header
// extensions, as a browser offers them, with Chrome's payload types and
// extension ids. `getCapabilities` is synchronous, so this answers it before
// any stack is loaded; the werift adapter (`./werift.ts`) configures its
// connections from the same table, so the two cannot disagree.
//
// What is here is what the stack can carry and the media pipeline will
// encode (docs/prd-webrtc.md): Opus, G.711 and DTMF's `telephone-event`;
// VP8 and VP9. No H.264, which nothing here encodes or decodes.
//
// Light on purpose: `<Html>` reaches it whether or not a document runs
// scripts.

import type { RTCCapabilitiesLike, RTCCodecLike } from './rtc.js';

/** A codec this offers, with the payload type it is offered at. */
export interface OfferedCodec extends RTCCodecLike {
  payloadType: number;
  /** RTCP feedback, as `a=rtcp-fb` lines name it. */
  rtcpFeedback?: { type: string; parameter?: string }[];
}

/** An RTP header extension this offers, with the id it is offered at. */
export interface OfferedExtension {
  uri: string;
  id: number;
}

const VIDEO_FEEDBACK = [
  { type: 'goog-remb' },
  { type: 'transport-cc' },
  { type: 'ccm', parameter: 'fir' },
  { type: 'nack' },
  { type: 'nack', parameter: 'pli' },
];

/** The codecs of each kind, in the order an offer lists them. */
export const OFFERED_CODECS: Record<'audio' | 'video', OfferedCodec[]> = {
  audio: [
    {
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
      sdpFmtpLine: 'minptime=10;useinbandfec=1',
      payloadType: 111,
      rtcpFeedback: [{ type: 'transport-cc' }],
    },
    { mimeType: 'audio/PCMU', clockRate: 8000, channels: 1, payloadType: 0 },
    { mimeType: 'audio/PCMA', clockRate: 8000, channels: 1, payloadType: 8 },
    {
      mimeType: 'audio/telephone-event',
      clockRate: 8000,
      channels: 1,
      payloadType: 126,
    },
  ],
  video: [
    {
      mimeType: 'video/VP8',
      clockRate: 90000,
      payloadType: 96,
      rtcpFeedback: VIDEO_FEEDBACK,
    },
    {
      mimeType: 'video/VP9',
      clockRate: 90000,
      sdpFmtpLine: 'profile-id=0',
      payloadType: 98,
      rtcpFeedback: VIDEO_FEEDBACK,
    },
  ],
};

const AUDIO_LEVEL = 'urn:ietf:params:rtp-hdrext:ssrc-audio-level';
const ABS_SEND_TIME =
  'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time';
const TRANSPORT_CC =
  'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01';
const MID = 'urn:ietf:params:rtp-hdrext:sdes:mid';
const RID = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id';
const REPAIRED_RID = 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id';

/** The header extensions of each kind, at Chrome's ids. */
export const OFFERED_EXTENSIONS: Record<'audio' | 'video', OfferedExtension[]> =
  {
    audio: [
      { uri: AUDIO_LEVEL, id: 1 },
      { uri: ABS_SEND_TIME, id: 2 },
      { uri: TRANSPORT_CC, id: 3 },
      { uri: MID, id: 4 },
    ],
    video: [
      { uri: ABS_SEND_TIME, id: 2 },
      { uri: TRANSPORT_CC, id: 3 },
      { uri: MID, id: 4 },
      { uri: RID, id: 10 },
      { uri: REPAIRED_RID, id: 11 },
    ],
  };

/** What `RTCRtpSender.getCapabilities` and `RTCRtpReceiver.getCapabilities`
 *  answer for a kind: the same for either side. */
export function offeredCapabilities(
  kind: 'audio' | 'video',
): RTCCapabilitiesLike {
  return {
    codecs: OFFERED_CODECS[kind].map((c) => ({
      mimeType: c.mimeType,
      clockRate: c.clockRate,
      ...(c.channels !== undefined ? { channels: c.channels } : {}),
      ...(c.sdpFmtpLine !== undefined ? { sdpFmtpLine: c.sdpFmtpLine } : {}),
    })),
    headerExtensions: OFFERED_EXTENSIONS[kind].map((e) => ({ uri: e.uri })),
  };
}
