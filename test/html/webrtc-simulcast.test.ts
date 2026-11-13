// Simulcast over werift: a sender of several encodings sends a layer for
// each, scaled down as each asks, and what a remote offer's `a=simulcast`
// makes of a sender's encodings, end to end in one page as WPT's
// `webrtc/simulcast/` tests have it. The receiving peer reads the layers
// on m-sections of their own, as WPT's `simulcast.js` makes it: its offer
// has the rid extension where the MID's would be, so each layer arrives on
// the m-section its rid names, with no SSRC a description named.
//
// Skipped where werift, the optional peer, is not installed or does not
// load, and on Node before 22, which werift does not run on.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, renderX11 } from 'react-x11/test';

import { Html, HtmlNetwork, preloadHtmlScripts } from '../../src/html/index.js';
import { codecThreads } from '../../src/html/media-codecs.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
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
const test = SCRIPTS_CONTAINED && werift ? nodeTest : nodeTest.skip;

/** A page's scripts over werift: what they log, once one line starts with
 *  `done` or `failed`. */
async function run(script: string): Promise<string[]> {
  const logs: string[] = [];
  await renderX11(
    h(Html, {
      source:
        '<script>' +
        'function log() { console.log([].slice.call(arguments).join("|")); }' +
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

/** What WPT's `simulcast.js` does to a description, in a page: an offer's
 *  one m-section made one a rid, the rid extension read as the MID's, and
 *  an answer's m-sections folded back into one that receives the rids. */
const MUNGE = `
  var BREAK = '\\r\\n';
  var MID = 'urn:ietf:params:rtp-hdrext:sdes:mid';
  var RID = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id';
  function split(sdp) {
    var parts = sdp.split(BREAK + 'm=');
    return [parts[0] + BREAK].concat(parts.slice(1).map(function (p) { return 'm=' + p; }));
  }
  function lines(text) { return text.split(BREAK).filter(function (l) { return l; }); }
  function rtx(section) {
    var pts = [];
    lines(section).forEach(function (l) { var m = /^a=rtpmap:(\\d+) rtx\\//i.exec(l); if (m) pts.push(m[1]); });
    return pts;
  }
  function media(section, drop) {
    var gone = rtx(section);
    return lines(section).filter(function (l) {
      if (/^a=(mid|rid|simulcast|ssrc|ssrc-group|msid|sendrecv|sendonly|recvonly|inactive)\\b/.test(l)) return false;
      if (drop(l)) return false;
      return !gone.some(function (pt) { return l.indexOf(':' + pt + ' ') > 0 && /^a=(rtpmap|fmtp|rtcp-fb):/.test(l); });
    }).map(function (l) {
      if (l.indexOf('m=') !== 0) return l;
      var p = l.split(' ');
      return p.slice(0, 3).concat(p.slice(3).filter(function (pt) { return gone.indexOf(pt) < 0; })).join(' ');
    });
  }
  function session(text, group) {
    return lines(text).filter(function (l) { return l.indexOf('a=group:') !== 0; }).concat(['a=group:BUNDLE ' + group]).join(BREAK) + BREAK;
  }
  function ridToMid(sdp, rids, direction) {
    var s = split(sdp);
    var body = media(s[1], function (l) { return l.indexOf(MID) > 0; }).map(function (l) {
      return l.replace(RID, MID);
    });
    var out = session(s[0], rids.join(' '));
    rids.forEach(function (rid) {
      out += body.concat(['a=mid:' + rid, 'a=msid:rid-' + rid + ' rid-' + rid, 'a=' + direction]).join(BREAK) + BREAK;
    });
    return out;
  }
  function midToRid(sdp, local, rids) {
    var s = split(sdp);
    var localMid = local ? /a=mid:(\\S+)/.exec(split(local)[1])[1] : '0';
    var midLine = local && lines(split(local)[1]).find(function (l) { return l.indexOf('a=extmap:') === 0 && l.indexOf(MID) > 0; });
    var body = media(s[1], function (l) { return l.indexOf(RID) > 0 || l.indexOf('repaired') > 0; }).map(function (l) {
      return l.replace(MID, RID);
    });
    if (!midLine) {
      // an id nothing else has, as the harness finds one
      for (var id = 1; id < 15; id++) {
        if (!body.some(function (l) { return l.indexOf('a=extmap:' + id + ' ') === 0; })) break;
      }
      midLine = 'a=extmap:' + id + ' ' + MID;
    }
    body.push(midLine);
    body.push('a=mid:' + localMid, 'a=recvonly');
    rids.forEach(function (rid) { body.push('a=rid:' + rid + ' recv'); });
    if (rids.length) body.push('a=simulcast:recv ' + rids.join(';'));
    return session(s[0], localMid) + body.join(BREAK) + BREAK;
  }
  function wait(what, test, ms) {
    var end = Date.now() + (ms || 15000);
    return new Promise(function (resolve, reject) {
      (function look() {
        var got = test();
        if (got) return resolve(got);
        if (Date.now() > end) return reject(new Error('timed out waiting for ' + what));
        setTimeout(look, 20);
      })();
    });
  }
  function canvasStream() {
    var canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    document.documentElement.appendChild(canvas);
    var g = canvas.getContext('2d');
    var n = 0;
    var timer = setInterval(function () {
      n++;
      g.fillStyle = 'rgb(' + (n * 20 % 255) + ',80,120)';
      g.fillRect(0, 0, 320, 240);
      g.fillStyle = 'white';
      g.fillRect(n % 300, 20, 20, 20);
    }, 50);
    var stream = canvas.captureStream();
    stream.stop = function () { clearInterval(timer); };
    return stream;
  }
  async function decoded(pc) {
    return Promise.all(pc.getReceivers().map(async function (r) {
      var found = 0;
      (await r.getStats()).forEach(function (s) { if (s.type === 'inbound-rtp') found = s; });
      return found;
    }));
  }
`;

test('a sender of two encodings sends each as a layer of its own, scaled as it asks, each on the m-section its rid names, and stops one that is not active', async () => {
  assert.equal(codecThreads.running, 0, 'no codec left open by a test before');
  const logs = await run(`
    ${MUNGE}
    var rids = ['0', '1'];
    var stream = canvasStream();
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.onicecandidate = function (e) { pc2.addIceCandidate(e.candidate); };
    pc2.onicecandidate = function (e) { pc1.addIceCandidate(e.candidate); };
    var tracks = [];
    pc2.ontrack = function (e) { tracks.push(e.track); };
    var tx = pc1.addTransceiver(stream.getVideoTracks()[0], {
      streams: [stream],
      sendEncodings: [{ rid: '0', scaleResolutionDownBy: 2 }, { rid: '1' }],
    });
    var offer = await pc1.createOffer();
    log('offer', /a=simulcast:send 0;1/.test(offer.sdp), /a=rid:0 send/.test(offer.sdp));
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription({ type: 'offer', sdp: ridToMid(offer.sdp, rids, 'sendonly') });
    var answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription({ type: 'answer', sdp: midToRid(answer.sdp, pc1.localDescription.sdp, rids) });
    log('tracks', tracks.length);
    var ok = function (s) { return s && s.framesDecoded > 2; };
    var stats;
    for (var end = Date.now() + 15000; Date.now() < end;) {
      stats = await decoded(pc2);
      if (stats.every(ok)) break;
      await new Promise(function (r) { setTimeout(r, 50); });
    }
    log('sizes', stats.map(function (s) { return s && s.frameWidth + 'x' + s.frameHeight; }).join(','));
    var out = [];
    (await tx.sender.getStats()).forEach(function (s) { if (s.type === 'outbound-rtp') out.push(s); });
    out.sort(function (a, b) { return a.encodingIndex - b.encodingIndex; });
    log('outbound', out.map(function (s) { return s.rid + ':' + s.encodingIndex + ':' + (s.framesSent > 0); }).join(','));
    log('ssrcs', new Set(out.map(function (s) { return s.ssrc; })).size);
    var p = tx.sender.getParameters();
    p.encodings[0].active = false;
    await tx.sender.setParameters(p);
    await new Promise(function (r) { setTimeout(r, 300); });
    var before = await decoded(pc2);
    await new Promise(function (r) { setTimeout(r, 800); });
    var after = await decoded(pc2);
    log('inactive', after[0].framesDecoded === before[0].framesDecoded, after[1].framesDecoded > before[1].framesDecoded);
    stream.stop();
    pc1.close(); pc2.close();
    log('done');
  `);
  if (process.env.WERIFT_LOGS) console.log(logs.join('\n'));
  for (const line of [
    'offer|true|true',
    'tracks|2',
    'sizes|160x120,320x240',
    'outbound|0:0:true,1:1:true',
    'ssrcs|2',
    'inactive|true|true',
    'done',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
  const end = Date.now() + 2000;
  while (codecThreads.running && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(codecThreads.running, 0, 'the thread ends with the call');
});

test('a remote offer that receives simulcast gives a sender of one encoding its rids, once each and the first of each choice, which the answer sends, and its rollback takes them away', async () => {
  const logs = await run(`
    ${MUNGE}
    var stream = canvasStream();
    var rids = function (sender) { return sender.getParameters().encodings.map(function (e) { return e.rid; }).join(','); };
    var pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    var sender = pc1.addTrack(stream.getVideoTracks()[0]);
    pc2.addTrack(stream.getVideoTracks()[0]);
    await pc2.setLocalDescription();
    var offer = midToRid(pc2.localDescription.sdp, null, ['foo', 'bar', 'foo']).replace('a=rid:foo recv', 'a=rid:foo recv' + BREAK + 'a=rid:baz recv');
    offer = offer.replace('a=simulcast:recv foo;bar;foo', 'a=simulcast:recv foo,baz;bar;foo');
    await pc1.setRemoteDescription({ type: 'offer', sdp: offer });
    log('proposed', rids(sender), sender.getParameters().encodings.map(function (e) { return e.scaleResolutionDownBy; }).join(','));
    await pc1.setRemoteDescription({ type: 'rollback' });
    log('rolled back', rids(sender) === '');
    await pc1.setRemoteDescription({ type: 'offer', sdp: offer });
    var answer = await pc1.createAnswer();
    log('answer', /a=simulcast:send foo;bar\\r\\n/.test(answer.sdp), /a=rid:foo send/.test(answer.sdp), /a=rid:baz/.test(answer.sdp));
    await pc1.setLocalDescription(answer);
    log('kept', rids(sender));
    var again = await pc1.createOffer();
    log('reoffer', /a=simulcast:send foo;bar\\r\\n/.test(again.sdp));
    stream.stop();
    pc1.close(); pc2.close();
    log('done');
  `);
  if (process.env.WERIFT_LOGS) console.log(logs.join('\n'));
  for (const line of [
    'proposed|foo,bar|2,1',
    'rolled back|true',
    'answer|true|true|false',
    'kept|foo,bar',
    'reoffer|true',
    'done',
  ]) {
    assert.ok(logs.includes(line), `missing ${line}:\n${logs.join('\n')}`);
  }
});
