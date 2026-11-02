// <Html scripts> — the mouse and the keyboard as a page hears them: Pointer
// Events and UI Events, in the order a browser tells them, through the real
// input path (the in-process server's pointer and keys, core's dispatch,
// `<Html>`'s root, the realm). `fireEvent` is core's and starts past half of
// that, so nothing here uses it.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, cleanup, renderX11 } from 'react-x11/test';

import {
  Html,
  HtmlViewNode,
  preloadHtmlScripts,
} from '../../src/html/index.js';
import { FONTS } from './harness.js';

afterEach(cleanup);
// the engine is a chunk of its own, and a page's listeners are there only once
// it is: read on a slow runner after the wait below, the first test heard nothing
await preloadHtmlScripts();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A page in a window of 400 by 300, what its `console.log` says, and the
 *  server's pointer and keys. */
async function page(source: string, baseUrl = 'https://example.test/') {
  const log: string[] = [];
  const result = await renderX11(
    React.createElement(
      'box',
      { style: { width: 400, height: 300 } },
      React.createElement(Html, {
        source: `<!DOCTYPE html><html><body>${source}</body></html>`,
        baseUrl,
        partial: false,
        scripts: { log: (_: string, text: string) => log.push(text) },
      } as never),
    ),
    { width: 400, height: 300, fonts: FONTS! },
  );
  const step = async () => {
    await act(async () => {
      await wait(20);
    });
    await wait(10);
  };
  await act(async () => {
    await wait(100);
  });
  const server = (
    result as unknown as {
      server: {
        injectPointerMove(x: number, y: number): void;
        injectButton(button: number, down: boolean): void;
        injectKey(code: number, down: boolean): void;
        keymap: { keycodeForKeysym(sym: number): number };
      };
    }
  ).server;
  return {
    log,
    server,
    step,
    move: async (x: number, y: number) => {
      server.injectPointerMove(x, y);
      await step();
    },
    press: async (button = 1) => {
      server.injectButton(button, true);
      await step();
    },
    release: async (button = 1) => {
      server.injectButton(button, false);
      await step();
    },
    key: async (sym: number) => {
      const code = server.keymap.keycodeForKeysym(sym);
      server.injectKey(code, true);
      await step();
      server.injectKey(code, false);
      await step();
    },
  };
}

const BOXES =
  '<style>body{margin:0}#a{width:100px;height:100px;background:#eee}' +
  '#b{width:100px;height:100px;background:#ddd}#c{width:50px;height:50px}</style>' +
  '<div id="a"><div id="c"></div></div><div id="b"></div>';
const LOGS = (types: string[], at = 'document') =>
  `<script>for (const n of ${JSON.stringify(types)}) ${at}.addEventListener(n, (e) => console.log(n + '@' + (e.target.id || e.target.localName)), true);</script>`;

test('the boundary events go to what is under the pointer, the pointer’s before the mouse’s, and then the move', async () => {
  const p = await page(
    BOXES +
      LOGS([
        'pointerover',
        'pointerenter',
        'pointerout',
        'pointerleave',
        'pointermove',
        'mouseover',
        'mouseenter',
        'mouseout',
        'mouseleave',
        'mousemove',
      ]),
  );
  await p.move(20, 20);
  p.log.length = 0;
  await p.move(20, 150);
  assert.deepEqual(p.log, [
    'pointerout@c',
    'pointerleave@c',
    'pointerleave@a',
    'pointerover@b',
    'pointerenter@b',
    'mouseout@c',
    'mouseleave@c',
    'mouseleave@a',
    'mouseover@b',
    'mouseenter@b',
    'pointermove@b',
    'mousemove@b',
  ]);
});

test('what a press takes out of the document moves the pointer to what held it, and the release is told there', async () => {
  const p = await page(
    BOXES +
      LOGS(['mouseover', 'mouseup', 'mousedown', 'mouseenter']) +
      `<script>document.getElementById('c').addEventListener('mousedown', (e) => e.target.remove());</script>`,
  );
  await p.move(20, 20);
  p.log.length = 0;
  await p.press();
  await p.release();
  // held there all along: over it again and never into it
  assert.deepEqual(p.log, ['mousedown@c', 'mouseover@a', 'mouseup@a']);
});

test('what comes under a pointer that did not move is told as boundary events, and the document’s hover follows', async () => {
  const p = await page(
    BOXES +
      LOGS(['pointerover', 'mouseover', 'pointermove']) +
      `<style>#n{position:absolute;left:0;top:0;width:100px;height:100px;background:red}#n:hover{background:lime}</style>` +
      `<script>document.addEventListener('click', () => { const n = document.createElement('div'); n.id = 'n'; document.body.appendChild(n); window.n = n; });</script>`,
  );
  await p.move(20, 20);
  await p.press();
  p.log.length = 0;
  await p.release();
  await wait(50);
  await p.step();
  await p.step();
  assert.deepEqual(p.log, ['pointerover@n', 'mouseover@n']);
});

test('a move’s samples are its coalesced events, each trusted and adding up to the move, on a secure page alone', async () => {
  const p = await page(
    BOXES +
      `<script>
      document.addEventListener('pointermove', (e) => {
        const list = e.getCoalescedEvents();
        console.log(JSON.stringify({ n: list.length, xs: list.map((c) => c.clientX),
          moved: list.reduce((n, c) => n + c.movementX, 0), by: e.movementX,
          trusted: list.every((c) => c.isTrusted && !c.bubbles && !c.cancelable),
          target: list.every((c) => c.target === e.target), inner: list[0].getCoalescedEvents().length,
          stamps: list.every((c, i) => !i || c.timeStamp >= list[i - 1].timeStamp) }));
      });
    </script>`,
  );
  await p.move(10, 10);
  p.log.length = 0;
  // three samples of the one frame ntk folds them into
  p.server.injectPointerMove(20, 10);
  p.server.injectPointerMove(30, 10);
  p.server.injectPointerMove(45, 10);
  await p.step();
  assert.deepEqual(JSON.parse(p.log[0]), {
    n: 3,
    xs: [20, 30, 45],
    moved: 35,
    by: 35,
    trusted: true,
    target: true,
    inner: 0,
    stamps: true,
  });
  const open = await page(
    `<script>console.log(String('getCoalescedEvents' in PointerEvent.prototype), String('onpointerrawupdate' in window))</script>`,
    'http://example.test/',
  );
  assert.equal(open.log[0], 'false false');
});

test('a pointer’s capture changes hands before its next event, with its boundary events, and a release ends it', async () => {
  const p = await page(
    BOXES +
      LOGS([
        'pointerover',
        'pointerout',
        'gotpointercapture',
        'lostpointercapture',
        'pointerup',
        'pointermove',
      ]) +
      `<script>document.getElementById('b').addEventListener('pointerdown', (e) => document.getElementById('c').setPointerCapture(e.pointerId));</script>`,
  );
  await p.move(50, 150);
  await p.press();
  p.log.length = 0;
  await p.move(55, 155);
  await p.release();
  assert.deepEqual(p.log, [
    'pointerout@b',
    'pointerover@c',
    'gotpointercapture@c',
    'pointermove@c',
    'pointerup@c',
    'lostpointercapture@c',
    'pointerout@c',
    'pointerover@b',
  ]);
});

test('a stroke dragged off the window goes on being told, and its release ends it', async () => {
  const p = await page(
    BOXES +
      LOGS(['pointermove', 'pointerup']) +
      `<script>document.addEventListener('pointerdown', () => {});</script>`,
  );
  await p.move(50, 50);
  await p.press();
  p.log.length = 0;
  await p.move(399, 50);
  await p.move(900, 900);
  await p.release();
  assert.equal(p.log[p.log.length - 1], 'pointerup@html');
  assert.ok(p.log.includes('pointermove@html'));
});

test('a click takes its own button’s press, whatever was pressed since, and the others are an auxclick', async () => {
  const p = await page(
    BOXES +
      `<script>for (const n of ['click', 'auxclick', 'contextmenu', 'dblclick'])
        document.addEventListener(n, (e) => { console.log([n, e.button, e.buttons, e.detail, e.pointerId, e.pointerType, e.constructor.name].join()); e.preventDefault(); });</script>`,
  );
  await p.move(50, 150);
  await p.press(1);
  await p.press(2);
  await p.release(2);
  await p.release(1);
  assert.deepEqual(p.log, [
    'auxclick,1,1,1,1,mouse,PointerEvent',
    'click,0,0,1,1,mouse,PointerEvent',
  ]);
  p.log.length = 0;
  await wait(500);
  await p.press(3);
  await p.release(3);
  assert.deepEqual(p.log, [
    'contextmenu,2,2,0,1,mouse,PointerEvent',
    'auxclick,2,0,1,1,mouse,PointerEvent',
  ]);
});

test('what a press counts is in its events, and a double click is told after its click', async () => {
  const p = await page(
    BOXES +
      `<script>for (const n of ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown'])
        document.addEventListener(n, (e) => console.log(n + ':' + e.detail));</script>`,
  );
  await p.move(50, 150);
  await p.press();
  await p.release();
  await p.press();
  await p.release();
  assert.deepEqual(p.log, [
    'pointerdown:0',
    'mousedown:1',
    'mouseup:1',
    'click:1',
    'pointerdown:0',
    'mousedown:2',
    'mouseup:2',
    'click:2',
    'dblclick:2',
  ]);
});

test('a cancelled pointerdown keeps the mouse’s events back and not the click', async () => {
  const p = await page(
    BOXES +
      LOGS(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) +
      `<script>document.addEventListener('pointerdown', (e) => e.preventDefault());</script>`,
  );
  await p.move(50, 150);
  await p.press();
  await p.release();
  assert.deepEqual(p.log, ['pointerdown@b', 'pointerup@b', 'click@b']);
});

test('a target is retargeted to the host outside a shadow tree, and a slot is on the path', async () => {
  const p = await page(
    `<div id="host"><span id="light">x</span></div><script>
    const host = document.getElementById('host');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<div id="in"><slot id="s"></slot></div>';
    const light = document.getElementById('light');
    const inner = root.getElementById('in');
    const name = (n) => n === window ? 'window' : n.id || n.nodeName;
    inner.addEventListener('x', (e) => console.log('in', name(e.target), e.composedPath().map(name).join()));
    host.addEventListener('x', (e) => console.log('host', name(e.target), e.composedPath().map(name).join()));
    const made = inner.appendChild(document.createElement('b'));
    made.id = 'made';
    made.addEventListener('y', (e) => console.log('made', name(e.target)));
    document.addEventListener('y', (e) => console.log('doc', name(e.target), e.eventPhase, e.composedPath().map(name).join()));
    light.dispatchEvent(new Event('x', { bubbles: true, composed: true }));
    const y = new Event('y', { bubbles: true, composed: true });
    made.dispatchEvent(y);
    console.log('after', String(y.target === null), y.composedPath().length);
    const stay = new Event('z', { bubbles: true });
    document.addEventListener('z', () => console.log('crossed'));
    made.dispatchEvent(stay);
  </script>`,
  );
  assert.deepEqual(p.log, [
    'in light light,s,in,#document-fragment,host,BODY,HTML,#document,window',
    'host light light,host,BODY,HTML,#document,window',
    'made made',
    'doc host 3 host,BODY,HTML,#document,window',
    'after false 0',
  ]);
});

test('a relatedTarget in the same shadow tree as the target is told to nobody outside it', async () => {
  const p = await page(
    `<div id="host"></div><script>
    const host = document.getElementById('host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<i id="p"></i><i id="q"></i>';
    const [a, b] = root.children;
    a.addEventListener('mouseover', (e) => console.log('in', e.relatedTarget.id));
    host.addEventListener('mouseover', () => console.log('outside'));
    a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true, relatedTarget: b }));
  </script>`,
  );
  assert.deepEqual(p.log, ['in q']);
});

test('at a target the capturing listeners run first, and `window.event` is the event a listener is in', async () => {
  const p = await page(
    `<div id="a"></div><script>
    const a = document.getElementById('a');
    a.addEventListener('x', () => console.log('bubble', window.event.type, String(event.eventPhase === event.AT_TARGET)));
    a.addEventListener('x', () => console.log('capture'), true);
    a.dispatchEvent(new Event('x'));
    console.log(String(window.event));
    const stopped = new Event('x');
    stopped.stopPropagation();
    a.dispatchEvent(stopped);
    console.log('end');
  </script>`,
  );
  assert.deepEqual(p.log, ['capture', 'bubble x true', 'undefined', 'end']);
});

test('a move nothing listens for asks the document nothing, and one that comes to listen hears no enter it missed', async () => {
  const p = await page(BOXES + `<script>window.go = () => {};</script>`);
  const original = HtmlViewNode.prototype.elementAtPoint;
  let asked = 0;
  HtmlViewNode.prototype.elementAtPoint = function (x, y) {
    asked += 1;
    return original.call(this, x, y);
  };
  try {
    await p.move(20, 20);
    await p.move(30, 150);
    await p.move(20, 20);
    assert.equal(asked, 0);
  } finally {
    HtmlViewNode.prototype.elementAtPoint = original;
  }
  const late = await page(
    BOXES +
      `<script>setTimeout(() => {
        for (const n of ['pointerover', 'pointerenter', 'mouseover', 'pointermove'])
          document.addEventListener(n, (e) => console.log(n + '@' + e.target.id), true);
      }, 150);</script>`,
  );
  await late.move(20, 20);
  await wait(200);
  await late.step();
  late.log.length = 0;
  await late.move(21, 21);
  assert.deepEqual(late.log, ['pointermove@c']);
});

test('an image’s map is what a pointer over the image is over', async () => {
  const p = await page(
    `<style>body{margin:0}img{display:block;width:100px;height:100px}</style>
    <div id="around"><img id="i" usemap="#m" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><map name="m" id="map">
      <area id="one" shape="rect" coords="0,0,50,50" href="#one">
      <area id="two" shape="circle" coords="75,75,20" href="#two"></map></div>` +
      LOGS(['pointerover', 'pointerenter']),
  );
  await p.move(10, 10);
  assert.deepEqual(p.log.slice(0, 1), ['pointerover@one']);
  assert.ok(p.log.includes('pointerenter@map'));
  assert.ok(!p.log.includes('pointerenter@i'));
  p.log.length = 0;
  await p.move(75, 75);
  assert.equal(p.log[0], 'pointerover@two');
  p.log.length = 0;
  await p.move(95, 10);
  assert.equal(p.log[0], 'pointerover@i');
});

test('offsets are from the target’s padding edge, through what turns it, and held as they were told', async () => {
  const p = await page(
    `<style>body{margin:0}#a{position:absolute;left:40px;top:20px;width:100px;height:100px;border:5px solid red;padding:3px;transform:scale(2);transform-origin:0 0}</style>
    <div id="a"></div><script>
    let kept;
    document.getElementById('a').addEventListener('mousedown', (e) => {
      kept = e;
      console.log([e.clientX, e.pageX, e.offsetX, e.offsetY, e.layerX].join());
      document.getElementById('a').style.left = '80px';
      console.log(String(e.offsetX), String(kept.pageX));
    });
  </script>`,
  );
  await p.move(90, 60);
  await p.press();
  // 50 across at a scale of 2 is 25 in, less the border of 5
  assert.deepEqual(p.log, ['90,90,20,15,50', '20 90']);
});

test('a key in a field is a keydown, a keypress, a beforeinput, a textInput and an input with what it did', async () => {
  const p = await page(
    `<input id="f" value="ab"><script>
    const f = document.getElementById('f');
    for (const n of ['keydown', 'keypress', 'keyup', 'beforeinput', 'textInput', 'input', 'select'])
      f.addEventListener(n, (e) => console.log([n, e.inputType, e.data, e.key, e.code, e.keyCode, e.charCode, e.location, e.isTrusted].join()));
    window.addEventListener('load', () => { f.focus(); f.setSelectionRange(2, 2); });
  </script>`,
  );
  await p.step();
  await p.step();
  await p.key(0x63);
  assert.deepEqual(p.log, [
    'keydown,,,c,KeyC,67,0,0,true',
    'keypress,,,c,KeyC,99,99,0,true',
    'beforeinput,insertText,c,,,,,,true',
    'textInput,,c,,,,,,true',
    'input,insertText,c,,,,,,true',
    'keyup,,,c,KeyC,67,0,0,true',
  ]);
  p.log.length = 0;
  await p.key(0xff08);
  assert.ok(p.log.includes('input,deleteContentBackward,,,,,,,true'));
});

test('a cancelled beforeinput keeps what it was for out of the field', async () => {
  const p = await page(
    `<input id="f"><script>
    const f = document.getElementById('f');
    f.addEventListener('beforeinput', (e) => e.preventDefault());
    f.addEventListener('input', () => console.log('input'));
    window.addEventListener('load', () => f.focus());
    window.read = () => console.log('value:' + f.value);
    document.addEventListener('keyup', () => read());
  </script>`,
  );
  await p.step();
  await p.step();
  await p.key(0x61);
  assert.deepEqual(p.log, ['value:']);
});

test('a script’s selection in a field is told once a task, trusted', async () => {
  const p = await page(
    `<input id="f" value="abcdef"><script>
    const f = document.getElementById('f');
    f.addEventListener('select', (e) => console.log('select', String(e.isTrusted), String(e.bubbles), String(e.cancelable)));
    f.setSelectionRange(1, 2);
    f.setSelectionRange(1, 3);
    console.log('sync');
  </script>`,
  );
  await p.step();
  assert.deepEqual(p.log, ['sync', 'select true true false']);
});

test('a host’s beforeinput says what it will change, for as long as it is on its way', async () => {
  const p = await page(
    `<div id="e" contenteditable>abc</div><script>
    const e = document.getElementById('e');
    let kept;
    e.addEventListener('beforeinput', (ev) => {
      kept = ev;
      const [r] = ev.getTargetRanges();
      console.log(ev.inputType, r.constructor.name, r.startOffset, r.endOffset, r.startContainer.data);
    });
    e.addEventListener('input', () => console.log('after', kept.getTargetRanges().length));
    window.addEventListener('load', () => { e.focus(); getSelection().collapse(e.firstChild, 2); });
  </script>`,
  );
  await p.step();
  await p.step();
  await p.key(0xff08);
  assert.deepEqual(p.log, [
    'deleteContentBackward StaticRange 1 2 abc',
    'after 0',
  ]);
});

test('the interfaces are Web IDL’s: attributes on the prototypes, conversions, constants and the legacy initializers', async () => {
  const p = await page(
    `<script>
    const say = (v) => console.log(String(v));
    say(Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'clientX').enumerable);
    say(Object.getOwnPropertyDescriptor(UIEvent.prototype, 'view').get.name);
    say('clientX' in Object.keys(new MouseEvent('x')));
    say(new MouseEvent('x', { button: 65537 }).button);
    say(new MouseEvent('x', { buttons: -1 }).buttons);
    try { new UIEvent('x', { view: {} }); } catch (e) { say(e.name); }
    try { new MouseEvent('x', { relatedTarget: {} }); } catch (e) { say(e.name); }
    try { new MouseEvent(); } catch (e) { say(e.name); }
    say(Object.getOwnPropertyDescriptor(KeyboardEvent, 'DOM_KEY_LOCATION_LEFT').writable);
    say(new KeyboardEvent('x').DOM_KEY_LOCATION_NUMPAD);
    say(new KeyboardEvent('x', { keyCode: 65 }).which);
    say(new KeyboardEvent('x', { modifierCapsLock: true }).getModifierState('CapsLock'));
    const m = document.createEvent('MouseEvents');
    m.initMouseEvent('t', true, false, window, 3, 1, 2, 3, 4, true, false, false, false, 2, document);
    say([m.type, m.detail, m.clientY, m.ctrlKey, m.button, m.relatedTarget === document, m.which]);
    say(document.createEvent('CompositionEvent') instanceof CompositionEvent);
    const t = document.createEvent('TextEvent');
    t.initTextEvent('foo');
    say(t.data);
    try { new TextEvent('x'); } catch (e) { say(e.name); }
    try { document.createEvent('NoSuchEvent'); } catch (e) { say(e.name); }
    const q = new PointerEvent('pointerdown', { tiltX: 45 });
    say([q.pointerId, q.pointerType, q.isPrimary, q.altitudeAngle === Math.PI / 4, q.azimuthAngle]);
    say(new PointerEvent('x', { altitudeAngle: Math.PI / 4, azimuthAngle: Math.PI / 2 }).tiltY);
    const c = document.createElement('button');
    c.addEventListener('click', (e) => say([e.pointerId, JSON.stringify(e.pointerType), e.isTrusted]));
    c.click();
  </script>`,
  );
  assert.deepEqual(p.log, [
    'true',
    'get view',
    'false',
    '1',
    '65535',
    'TypeError',
    'TypeError',
    'TypeError',
    'false',
    '3',
    '65',
    'true',
    't,3,4,true,2,true,3',
    'true',
    'undefined',
    'TypeError',
    'NotSupportedError',
    '0,,false,true,0',
    '45',
    '-1,"",false',
  ]);
});

test('no lock is to be had, and a page is told so rather than throwing', async () => {
  const p = await page(
    `<script>
    document.addEventListener('pointerlockerror', () => console.log('error'));
    document.addEventListener('pointerlockchange', () => console.log('change'));
    console.log(String(document.pointerLockElement));
    document.exitPointerLock();
    document.body.requestPointerLock().catch((e) => console.log(e.name));
  </script>`,
  );
  await p.step();
  assert.deepEqual(p.log, ['null', 'NotAllowedError', 'error']);
});

test('a selection the reader drags is told as it goes, and a page can turn one down as it starts', async () => {
  const text =
    '<p id="p" style="margin:0;font:20px monospace">hello world again</p>';
  const p = await page(
    text +
      `<script>
      document.addEventListener('selectstart', () => console.log('selectstart'));
      document.addEventListener('selectionchange', () => console.log('change', String(getSelection()).length > 0));
    </script>`,
  );
  await p.move(5, 10);
  await p.press();
  await p.move(60, 10);
  await p.move(120, 10);
  assert.deepEqual([...new Set(p.log)], ['selectstart', 'change true']);
  await p.release();
  const none = await page(
    text +
      `<script>
      document.addEventListener('selectstart', (e) => e.preventDefault());
      document.addEventListener('mouseup', () => console.log(JSON.stringify(String(getSelection()))));
    </script>`,
  );
  await none.move(5, 10);
  await none.press();
  await none.move(120, 10);
  await none.release();
  assert.deepEqual(none.log, ['""']);
});

test('a frame with no realm of its own has its pointer’s events heard in the page, and the page hears the frame’s element go over and out', async () => {
  const p = await page(
    `<style>body{margin:0}</style><div style="height:50px"></div>
    <iframe id="f" style="border:0;width:200px;height:100px" srcdoc='<body style="margin:0"><div id="s" style="width:100px;height:60px"></div>'></iframe>
    <script>
    const f = document.getElementById('f');
    f.addEventListener('load', () => {
      const s = frames[0].document.getElementById('s');
      for (const n of ['pointerdown', 'pointerup', 'click'])
        s.addEventListener(n, (e) => console.log('frame ' + n + ' ' + e.target.id));
      for (const n of ['pointerover', 'pointerout'])
        f.addEventListener(n, (e) => console.log('page ' + n + ' ' + e.target.id));
    });
    </script>`,
  );
  await p.step();
  await p.step();
  await p.move(20, 20);
  await p.move(20, 70);
  assert.deepEqual(p.log, ['page pointerover f']);
  p.log.length = 0;
  await p.press();
  await p.release();
  assert.deepEqual(p.log.slice(-3), [
    'frame pointerdown s',
    'frame pointerup s',
    'frame click s',
  ]);
});
