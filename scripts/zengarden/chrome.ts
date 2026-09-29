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
// - **Every element's border box** (`DOMSnapshot.captureSnapshot`): an
//   inline element's is the union of its fragments, as `elementRect` gives
//   it. Taken at the viewport the page was laid out in, before the
//   screenshot.
// - **The page a viewport at a time**, scrolled and stitched, as `ours.tsx`
//   reads its own: a page shot whole beyond the viewport paints a
//   `background-attachment: fixed` image only where the first viewport
//   was, and left the rest of a design's page white. Scrolled with the
//   DevTools' own evaluation, which runs with the page's scripts off.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PNG } from 'pngjs';

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
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await this._load(url, sessionId, send);
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
