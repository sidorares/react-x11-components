// What a page's peer connections negotiate as codecs, over werift
// (`src/html/werift-codecs.ts`, `src/html/werift.ts`): codec preferences
// held as a browser holds them, a subsequent offer that lists every codec
// again, a remote description read as its m-lines say, and the codec and
// the transaction `getParameters` and `setParameters` share. The first
// tests are of the pure functions; the rest run two connections in a page.
//
// The page tests are skipped where werift is not installed, and on Node
// before 22, which werift does not run on.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html, HtmlNetwork, preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import {
  asWeriftReads,
  narrowToPreferences,
  reofferCodecs,
} from '../../src/html/werift-codecs.js';
import type { WCodecLike } from '../../src/html/werift-codecs.js';
import { loadWerift } from '../../src/html/werift.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const runtime = process as unknown as {
  versions: { node: string; bun?: string };
};
const supported =
  !!runtime.versions.bun || Number(runtime.versions.node.split('.')[0]) >= 22;
const werift = supported ? await loadWerift() : null;
const pageTest = SCRIPTS_CONTAINED && werift ? nodeTest : nodeTest.skip;

const VP8 = { mimeType: 'video/VP8', clockRate: 90000, payloadType: 96 };
const VP9 = {
  mimeType: 'video/VP9',
  clockRate: 90000,
  payloadType: 98,
  parameters: 'profile-id=0',
};
const RTX96 = {
  mimeType: 'video/rtx',
  clockRate: 90000,
  payloadType: 97,
  parameters: 'apt=96',
};
const RTX98 = {
  mimeType: 'video/rtx',
  clockRate: 90000,
  payloadType: 99,
  parameters: 'apt=98',
};
const names = (codecs: WCodecLike[]): string[] =>
  codecs.map((c) =>
    `${c.payloadType} ${c.mimeType} ${c.parameters ?? ''}`.trim(),
  );

nodeTest(
  'preferences take out a codec and the rtx that carries it, whatever rtx werift matched',
  () => {
    // werift's own resolution of "every codec but VP8": VP8 kept through the
    // rtx at apt=96 its preference matching took for both rtx preferences
    const resolved = [VP9, RTX96, VP8, RTX98];
    const preferences = [
      { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=0' },
      { mimeType: 'video/rtx', clockRate: 90000, sdpFmtpLine: 'apt=96' },
      { mimeType: 'video/rtx', clockRate: 90000, sdpFmtpLine: 'apt=98' },
    ];
    assert.deepEqual(names(narrowToPreferences(resolved, preferences)), [
      '98 video/VP9 profile-id=0',
      '99 video/rtx apt=98',
    ]);
    // no rtx among the preferences, no rtx
    assert.deepEqual(
      names(
        narrowToPreferences(
          [VP8, RTX96, VP9, RTX98],
          [preferences[0], { mimeType: 'video/VP8', clockRate: 90000 }],
        ),
      ),
      ['96 video/VP8', '98 video/VP9 profile-id=0'],
    );
    // none at all is werift's
    assert.deepEqual(narrowToPreferences(resolved, []), resolved);
  },
);

nodeTest(
  'a subsequent offer keeps what was negotiated at its payload type and adds what was not',
  () => {
    const remoteVp8 = {
      mimeType: 'video/VP8',
      clockRate: 90000,
      payloadType: 100,
    };
    const made = reofferCodecs(
      [remoteVp8],
      [VP8, VP9, RTX96, RTX98],
      (c, pt, p) => ({
        ...c,
        payloadType: pt,
        ...(p !== undefined ? { parameters: p } : {}),
      }),
    );
    assert.deepEqual(names(made), [
      '100 video/VP8',
      '98 video/VP9 profile-id=0',
      '97 video/rtx apt=100',
      '99 video/rtx apt=98',
    ]);
    // a payload type the negotiation took is not given twice
    const taken = reofferCodecs(
      [{ mimeType: 'video/VP8', clockRate: 90000, payloadType: 98 }],
      [VP8, VP9],
      (c, pt) => ({ ...c, payloadType: pt }),
    );
    assert.deepEqual(names(taken), [
      '98 video/VP8',
      '96 video/VP9 profile-id=0',
    ]);
  },
);

nodeTest(
  'a remote description has an rtpmap for each static payload type, in the m-line’s order',
  () => {
    const sdp = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 121 111 0 101',
      'a=mid:0',
      'a=rtpmap:101 telephone-event/8000/1',
      'a=rtpmap:121 flarglblurp/8000/2',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10',
      '',
    ].join('\r\n');
    assert.deepEqual(asWeriftReads(sdp).split('\r\n'), [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 121 111 0 101',
      'a=mid:0',
      'a=rtpmap:121 flarglblurp/8000/2',
      'a=rtpmap:111 opus/48000/2',
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:101 telephone-event/8000/1',
      'a=fmtp:111 minptime=10',
      '',
    ]);
    // one as werift reads it is the same string
    const chrome =
      'v=0\r\nm=audio 9 X 111 0\r\na=rtpmap:111 opus/48000/2\r\na=rtpmap:0 PCMU/8000\r\n';
    assert.equal(asWeriftReads(chrome), chrome);
  },
);

/** A page's scripts over werift: what they log, once one line starts with
 *  `done` or `failed`. */
async function run(script: string): Promise<string[]> {
  const logs: string[] = [];
  await renderX11(
    h(Html, {
      source:
        '<script>' +
        'function log() { console.log([].slice.call(arguments).join("|")); }' +
        'function rtpmaps(sdp, kind) { var s = sdp.split("m=" + kind)[1] || ""; s = s.split("\\r\\nm=")[0]; return (s.match(/a=rtpmap:\\d+ [^\\r]+/g) || []).map(function (l) { var pt = l.slice(9).split(" ")[0]; var f = s.match(new RegExp("a=fmtp:" + pt + " ([^\\r]+)")); return l.slice(9) + (f ? " " + f[1] : ""); }).join(","); }' +
        'function pair(a, b) { a.onicecandidate = function (e) { if (e.candidate) b.addIceCandidate(e.candidate).catch(function () {}); }; b.onicecandidate = function (e) { if (e.candidate) a.addIceCandidate(e.candidate).catch(function () {}); }; }' +
        `(async function () { try { ${script} } catch (e) { log("failed", e.name, e.message); } })();` +
        '</script>',
      partial: false,
      baseUrl: 'https://page.test/',
      scripts: {
        webRTC: new HtmlNetwork().webRTC,
        timeout: 10000,
        log: (_level: string, text: string) => void logs.push(text),
      },
    }),
    FONTS ? { width: 100, height: 50, fonts: FONTS } : { backend: 'mock' },
  );
  let heard = 0;
  let end = 0;
  while (!logs.some((l) => /^(done|failed)\|?/.test(l))) {
    if (logs.length > heard || !end) {
      heard = logs.length;
      end = Date.now() + 20000;
    }
    if (Date.now() >= end) break;
    await act(() => new Promise((r) => setTimeout(r, 20)));
  }
  return logs;
}

pageTest(
  'an offer with no preferences is the one Meet reads: every codec, each rtx paired in an FID group',
  async () => {
    const logs = await run(`
    var pc = new RTCPeerConnection();
    pc.addTransceiver('video');
    var offer = await pc.createOffer();
    log('video', rtpmaps(offer.sdp, 'video'));
    log('fid', /a=ssrc-group:FID \\d+ \\d+/.test(offer.sdp));
    pc.close();
    log('done');
  `);
    assert.ok(
      logs.includes(
        'video|96 VP8/90000,98 VP9/90000 profile-id=0,97 rtx/90000 apt=96,99 rtx/90000 apt=98',
      ),
      logs.join('\n'),
    );
    assert.ok(logs.includes('fid|true'), logs.join('\n'));
  },
);

pageTest(
  'preferences of every codec but VP8 take VP8 and its rtx out of the answer, and the offerer may not send VP8',
  async () => {
    const logs = await run(`
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    var caps = RTCRtpReceiver.getCapabilities('video').codecs;
    var vp8 = caps.find(function (c) { return c.mimeType === 'video/VP8'; });
    var t = pc1.addTransceiver('video');
    await pc1.setLocalDescription();
    await pc2.setRemoteDescription(pc1.localDescription);
    pc2.getTransceivers()[0].setCodecPreferences(caps.filter(function (c) { return c !== vp8; }));
    await pc2.setLocalDescription();
    log('answer', rtpmaps(pc2.localDescription.sdp, 'video'));
    await pc1.setRemoteDescription(pc2.localDescription);
    var p = t.sender.getParameters();
    log('sends', p.codecs.map(function (c) { return c.mimeType; }).join(','));
    p.encodings[0].codec = vp8;
    try { await t.sender.setParameters(p); log('set'); } catch (e) { log('refused', e.name); }
    pc1.close(); pc2.close();
    log('done');
  `);
    assert.ok(
      logs.includes('answer|98 VP9/90000 profile-id=0,99 rtx/90000 apt=98'),
      logs.join('\n'),
    );
    assert.ok(logs.includes('sends|video/VP9,video/rtx'), logs.join('\n'));
    assert.ok(
      logs.includes('refused|InvalidModificationError'),
      logs.join('\n'),
    );
  },
);

pageTest('preferences with no rtx offer no rtx and no FID group', async () => {
  const logs = await run(`
    var pc = new RTCPeerConnection();
    var t = pc.addTransceiver('video');
    t.setCodecPreferences(RTCRtpReceiver.getCapabilities('video').codecs.filter(function (c) { return c.mimeType !== 'video/rtx'; }));
    var offer = await pc.createOffer();
    log('video', rtpmaps(offer.sdp, 'video'));
    log('fid', /a=ssrc-group:FID/.test(offer.sdp));
    pc.close();
    log('done');
  `);
  assert.ok(
    logs.includes('video|96 VP8/90000,98 VP9/90000 profile-id=0'),
    logs.join('\n'),
  );
  assert.ok(logs.includes('fid|false'), logs.join('\n'));
});

pageTest(
  'an offer after a VP8-only negotiation lists every codec again, and the answer after it narrows it',
  async () => {
    const logs = await run(`
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    var caps = RTCRtpReceiver.getCapabilities('video').codecs;
    var t1 = pc1.addTransceiver('video');
    t1.setCodecPreferences(caps.filter(function (c) { return c.mimeType === 'video/VP8'; }));
    await pc1.setLocalDescription();
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription();
    await pc1.setRemoteDescription(pc2.localDescription);
    log('first', rtpmaps(pc2.localDescription.sdp, 'video'));
    var again = await pc2.createOffer();
    log('again', rtpmaps(again.sdp, 'video'));
    log('still', pc2.getSenders()[0].getParameters().codecs.map(function (c) { return c.mimeType; }).join(','));
    await pc2.setLocalDescription(again);
    await pc1.setRemoteDescription(again);
    await pc1.setLocalDescription();
    await pc2.setRemoteDescription(pc1.localDescription);
    log('then', pc2.getSenders()[0].getParameters().codecs.map(function (c) { return c.mimeType; }).join(','));
    pc1.close(); pc2.close();
    log('done');
  `);
    assert.ok(logs.includes('first|96 VP8/90000'), logs.join('\n'));
    assert.ok(
      logs.includes(
        'again|96 VP8/90000,98 VP9/90000 profile-id=0,97 rtx/90000 apt=96,99 rtx/90000 apt=98',
      ),
      logs.join('\n'),
    );
    assert.ok(logs.includes('still|video/VP8'), logs.join('\n'));
    // pc1 still prefers VP8 alone, so its answer keeps it alone
    assert.ok(logs.includes('then|video/VP8'), logs.join('\n'));
  },
);

pageTest(
  'a remote answer with a static payload type and no rtpmap negotiates it, in the m-line’s order',
  async () => {
    const logs = await run(`
    var pc = new RTCPeerConnection();
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    await pc.setLocalDescription();
    var t = pc.getTransceivers()[0];
    var local = pc.localDescription.sdp;
    var answer = [
      'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 121 111 0 126',
      'c=IN IP4 0.0.0.0',
      'a=ice-ufrag:foobarba', 'a=ice-pwd:AAAA+BBBB+CCCC+DDDD+EE',
      'a=fingerprint:sha-256 ' + local.match(/a=fingerprint:sha-256 (\\S+)/)[1],
      'a=setup:passive', 'a=mid:' + t.mid, 'a=sendrecv', 'a=rtcp-mux',
      'a=rtpmap:126 telephone-event/8000/1',
      'a=rtpmap:121 flarglblurp/8000/2',
      'a=rtpmap:111 opus/48000/2', ''].join('\\r\\n');
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    log('codecs', t.sender.getParameters().codecs.map(function (c) { return c.payloadType + ' ' + c.mimeType; }).join(','));
    pc.close();
    log('done');
  `);
    assert.ok(
      logs.includes(
        'codecs|111 audio/opus,0 audio/PCMU,126 audio/telephone-event',
      ),
      logs.join('\n'),
    );
  },
);

pageTest(
  'getParameters is one transaction for a task, and setParameters after the task is an InvalidStateError',
  async () => {
    const logs = await run(`
    var pc = new RTCPeerConnection();
    var sender = pc.addTransceiver('audio').sender;
    var a = sender.getParameters();
    await undefined;
    var b = sender.getParameters();
    sender.setParameters(b);
    var c = sender.getParameters();
    log('same', a.transactionId === b.transactionId, b.transactionId === c.transactionId);
    await sender.setParameters(c);
    log('used again');
    try { await sender.setParameters(c); log('set'); } catch (e) { log('later', e.name); }
    var d = sender.getParameters();
    log('new', d.transactionId !== a.transactionId);
    var opts = sender.getParameters();
    var video = pc.addTransceiver('video').sender;
    var vp = video.getParameters();
    try { await video.setParameters(vp, { encodingOptions: [{ keyFrame: true }, { keyFrame: true }] }); log('set'); } catch (e) { log('options', e.name); }
    pc.close();
    log('done');
  `);
    assert.ok(logs.includes('same|true|true'), logs.join('\n'));
    assert.ok(logs.includes('used again'), logs.join('\n'));
    assert.ok(logs.includes('later|InvalidStateError'), logs.join('\n'));
    assert.ok(logs.includes('new|true'), logs.join('\n'));
    assert.ok(
      logs.includes('options|InvalidModificationError'),
      logs.join('\n'),
    );
  },
);
