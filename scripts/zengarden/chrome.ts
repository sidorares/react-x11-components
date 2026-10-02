// Chrome as the reference: headless, JavaScript off, driven over the
// DevTools protocol with Node's own WebSocket — no puppeteer, nothing to
// install but the browser.
//
// What a capture takes, and why each is the reference a static renderer is
// held to:
// - **JavaScript off** (`Emulation.setScriptExecutionDisabled`): <Html>
//   runs none, so a page is compared as a browser shows it without any.
// - **The viewport, not the window**: device metrics are set to the size
//   the bench renders at, one CSS pixel to a device pixel, scrollbars
//   hidden, so both engines lay out in the same room.
// - **A screen the size of the viewport** (`screenWidth`, `screenHeight`):
//   headless Chrome's screen is 800 by 600 whatever its window, smaller
//   than the viewport the bench asks for, which no desktop's is — so a
//   sheet a page keeps for a tablet, `(max-device-width: 1024px)`, was
//   taken 1280 across. <Html> answers the device features from the
//   viewport, and so does the reference.
// - **Every animation at rest, and no transitions**, by a sheet of the
//   inspector's: no duration, no delay and one iteration, so that an
//   animation is over as it starts — one that fills forwards holds its
//   last keyframe, as it does for good once it has run, and any other
//   leaves the style it started from, which is what <Html>, which runs
//   none, draws. Left running, a design that spins a picture for ever was
//   captured at whatever angle it had come to, and differed from itself
//   from one run to the next; switched off outright, one that fades its
//   panels in from nothing and holds them never showed them.
// - **Every element's border box** (`DOMSnapshot.captureSnapshot`): an
//   inline element's is the union of its fragments, as `elementRect` gives
//   it. Taken at the viewport the page was laid out in, before the
//   screenshot.
// - **The page a viewport at a time**, scrolled and stitched, as `ours.tsx`
//   reads its own: a page shot whole beyond the viewport paints a
//   `background-attachment: fixed` image only where the first viewport
//   was, and left the rest of a design's page white. Scrolled with the
//   DevTools' own evaluation, which runs with the page's scripts off.
// - **The light scheme** (`Emulation.setEmulatedMedia`): `ours.tsx` renders
//   under a light palette, and headless Chrome otherwise follows the
//   machine's appearance — so on a Mac in dark mode a page's
//   `prefers-color-scheme` and `light-dark()` answered dark in one engine
//   and light in the other.
// - **No preference for less motion**, in the same call: <Html> answers
//   `prefers-reduced-motion` as a desktop browser on a machine with the
//   setting off, and Chrome otherwise follows the machine's accessibility
//   setting, which would take a page's reduced branch in one engine alone.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PNG } from 'pngjs';

/** The sheet that brings a page to rest: every animation over as it
 *  starts and no transition, on every element and its pseudo-elements,
 *  whatever the page says. */
const STILL =
  '*, *::before, *::after { animation-duration: 0s !important; ' +
  'animation-delay: 0s !important; ' +
  'animation-iteration-count: 1 !important; ' +
  'transition: none !important; }';

/** Put `STILL` on a loaded page, as a sheet the inspector adds: the
 *  document is left as it was, with no element more in it. */
async function holdStill(
  send: (m: string, p?: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  await send('DOM.enable');
  await send('CSS.enable');
  const { frameTree } = (await send('Page.getFrameTree')) as {
    frameTree: { frame: { id: string } };
  };
  const { styleSheetId } = (await send('CSS.createStyleSheet', {
    frameId: frameTree.frame.id,
  })) as { styleSheetId: string };
  await send('CSS.setStyleSheetText', { styleSheetId, text: STILL });
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Set on Chrome's boxes for an element laid out `display: inline`,
   *  whose box is its font's content area where ours is its line's band:
   *  the two are compared across and by their middles, not by their tops
   *  and heights. */
  inline?: boolean;
}

export interface Image {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8Array;
}

export interface Capture {
  /** Every element Chrome laid out, by its path (`elementPath`), with its
   *  border box in document coordinates. */
  boxes: Map<string, Rect>;
  /** The document's height, as the page scrolls. */
  height: number;
  /** The page from the top, as tall as `height` or `maxHeight`. */
  image: Image;
}

const CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => !!p);

type Message = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
};

export class Chrome {
  private _seq = 0;
  private _pending = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
    }
  >();
  private _listeners = new Set<(m: Message) => void>();

  private constructor(
    private readonly _process: ChildProcess,
    private readonly _socket: WebSocket,
    private readonly _profile: string,
  ) {
    _socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Message;
      if (message.id !== undefined) {
        const waiting = this._pending.get(message.id);
        this._pending.delete(message.id);
        if (message.error) waiting?.reject(new Error(message.error.message));
        else waiting?.resolve(message.result ?? {});
        return;
      }
      for (const listener of [...this._listeners]) listener(message);
    });
  }

  static async launch(): Promise<Chrome> {
    const binary = CANDIDATES.find((p) => existsSync(p));
    if (!binary) {
      throw new Error('no Chrome found: set CHROME to its executable');
    }
    const profile = mkdtempSync(join(tmpdir(), 'zengarden-chrome-'));
    // An animated image stays on its first frame, the one ours draws:
    // animating, it showed whichever frame the capture came to. Chrome's
    // accessibility setting for it is a profile preference, which the
    // browser reads into Blink's `ImageAnimationPolicy`
    // (chrome_content_browser_client.cc); there is no switch or DevTools
    // call for it.
    mkdirSync(join(profile, 'Default'));
    writeFileSync(
      join(profile, 'Default', 'Preferences'),
      JSON.stringify({ settings: { a11y: { animation_policy: 'none' } } }),
    );
    const child = spawn(
      binary,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--disable-extensions',
        '--mute-audio',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const endpoint = await new Promise<string>((resolve, reject) => {
      let seen = '';
      const timer = setTimeout(
        () => reject(new Error(`Chrome did not start: ${seen}`)),
        20_000,
      );
      child.stderr!.on('data', (chunk: Buffer) => {
        seen += chunk.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Chrome exited ${code}: ${seen}`));
      });
    });
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('no socket')), {
        once: true,
      });
    });
    return new Chrome(child, socket, profile);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  /** Load a page at a viewport and take what the bench compares. */
  async capture(
    url: string,
    {
      width,
      height,
      maxHeight,
    }: { width: number; height: number; maxHeight: number },
  ): Promise<Capture> {
    const { targetId } = (await this.send('Target.createTarget', {
      url: 'about:blank',
    })) as { targetId: string };
    const { sessionId } = (await this.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    const send = (method: string, params: Record<string, unknown> = {}) =>
      this.send(method, params, sessionId);
    try {
      await send('Page.enable');
      await send('Network.enable');
      await send('Emulation.setScriptExecutionDisabled', { value: true });
      await send('Emulation.setEmulatedMedia', {
        features: [
          { name: 'prefers-color-scheme', value: 'light' },
          { name: 'prefers-reduced-motion', value: 'no-preference' },
        ],
      });
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: width,
        screenHeight: height,
      });
      await this._load(url, sessionId, send);
      await holdStill(send);
      const snapshot = (await send('DOMSnapshot.captureSnapshot', {
        computedStyles: ['display'],
      })) as unknown as Snapshot;
      const boxes = boxesOf(snapshot);
      const metrics = (await send('Page.getLayoutMetrics')) as {
        cssContentSize: { height: number };
      };
      const docHeight = Math.ceil(metrics.cssContentSize.height);
      const shotHeight = Math.min(Math.max(docHeight, height), maxHeight);
      const image = await viewports(send, width, height, shotHeight);
      return { boxes, height: docHeight, image };
    } finally {
      await this.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }

  /** Navigate, then wait for the load event and a network that has been
   *  quiet for a moment: web fonts and background images arrive late. */
  private async _load(
    url: string,
    sessionId: string,
    send: (m: string, p?: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void> {
    const inFlight = new Set<string>();
    let loaded = false;
    let lastActivity = Date.now();
    const listener = (m: Message) => {
      if (m.sessionId !== sessionId) return;
      const id = (m.params as { requestId?: string } | undefined)?.requestId;
      if (m.method === 'Network.requestWillBeSent' && id) inFlight.add(id);
      else if (
        (m.method === 'Network.loadingFinished' ||
          m.method === 'Network.loadingFailed') &&
        id
      ) {
        inFlight.delete(id);
      } else if (m.method === 'Page.loadEventFired') loaded = true;
      else return;
      lastActivity = Date.now();
    };
    this._listeners.add(listener);
    try {
      await send('Page.navigate', { url });
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        if (loaded && inFlight.size === 0 && Date.now() - lastActivity > 800) {
          return;
        }
      }
    } finally {
      this._listeners.delete(listener);
    }
  }

  async close(): Promise<void> {
    try {
      await this.send('Browser.close');
    } catch {
      // already gone
    }
    this._socket.close();
    // the profile is written to until the browser has gone
    if (this._process.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this._process.kill('SIGKILL');
          resolve();
        }, 5000);
        this._process.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    rmSync(this._profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

/** The page from the top to `total`, a viewport at a time: scrolled to
 *  each, shot, and the rows the viewport stopped at copied into place. */
async function viewports(
  send: (m: string, p?: Record<string, unknown>) => Promise<unknown>,
  width: number,
  height: number,
  total: number,
): Promise<Image> {
  const out = new Uint8Array(width * total * 4);
  for (let top = 0; top < total; top += height) {
    const scrolled = (await send('Runtime.evaluate', {
      expression: `window.scrollTo(0, ${top}); window.scrollY`,
      returnByValue: true,
    })) as { result: { value: number } };
    const at = scrolled.result.value;
    const shot = (await send('Page.captureScreenshot', {
      format: 'png',
    })) as { data: string };
    const png = PNG.sync.read(Buffer.from(shot.data, 'base64'));
    // the rows of the page this shot covers, the viewport having stopped
    // at `at` — short of `top` at the bottom of the page
    for (let row = 0; row < Math.min(height, png.height); row += 1) {
      const y = at + row;
      if (y < top || y >= total) continue;
      const from = row * png.width * 4;
      out.set(
        png.data.subarray(from, from + Math.min(width, png.width) * 4),
        y * width * 4,
      );
    }
  }
  return { width, height: total, data: out };
}

interface Snapshot {
  strings: string[];
  documents: {
    nodes: {
      parentIndex: number[];
      nodeType: number[];
      nodeName: number[];
    };
    layout: { nodeIndex: number[]; bounds: number[][]; styles: number[][] };
  }[];
}

/** The border box of every element in the main document, by path. */
function boxesOf(snapshot: Snapshot): Map<string, Rect> {
  const doc = snapshot.documents[0];
  const { parentIndex, nodeType, nodeName } = doc.nodes;
  const names = nodeName.map((i) => snapshot.strings[i].toLowerCase());
  // same-tag sibling indices, in document order
  const paths: (string | null)[] = new Array(names.length).fill(null);
  const counts = new Map<number, Map<string, number>>();
  for (let i = 0; i < names.length; i += 1) {
    // the document is the root every path starts from
    if (nodeType[i] === 9 && parentIndex[i] < 0) paths[i] = '';
    if (nodeType[i] !== 1) continue;
    // a pseudo-element is in the snapshot as a node of its own —
    // `::marker`, `::before` — and no element <Html> has a path to: it is
    // compared in the pixels, with the rest of what is drawn
    if (names[i].startsWith('::')) continue;
    const parent = parentIndex[i];
    let seen = counts.get(parent);
    if (!seen) counts.set(parent, (seen = new Map()));
    const k = seen.get(names[i]) ?? 0;
    seen.set(names[i], k + 1);
    const above = parent >= 0 ? paths[parent] : '';
    if (above === null) continue;
    paths[i] = `${above}/${names[i]}[${k}]`;
  }
  const boxes = new Map<string, Rect>();
  const { nodeIndex, bounds } = doc.layout;
  for (let j = 0; j < nodeIndex.length; j += 1) {
    const i = nodeIndex[j];
    const path = paths[i];
    if (!path || nodeType[i] !== 1) continue;
    const [x, y, width, height] = bounds[j];
    const display = snapshot.strings[doc.layout.styles[j]?.[0] ?? -1];
    boxes.set(path, {
      x,
      y,
      width,
      height,
      ...(display === 'inline' ? { inline: true } : {}),
    });
  }
  return boxes;
}
