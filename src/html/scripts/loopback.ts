// The HTTP server a page's media feeds are read from (`feeds.ts`): one for
// the process, on 127.0.0.1 at a port the system picks, started with the
// first feed and closed with the last, each feed's requests under a token of
// its own, of 128 random bits, so that nothing on the machine that has not
// been handed the URL reads what a page appended.
//
// The player is the only client, and it is ours: core's `<video src>`, in
// this process or in a `<Frame>`'s host (react-x11's `paneplayer.js`), which
// is why loopback is enough, and why a `<Frame>` pane's feeds are read from
// another process with nothing more said.
//
// A request may be held — a blocking playlist reload waits for the segment
// it asks for — so a reply is a promise, told when the player goes away
// (`gone`) so that nothing is kept for it.

import { nodeModule } from './platform.js';
import type { FeedReply } from './feeds.js';

interface RequestLike {
  url?: string;
  method?: string;
}

interface ResponseLike {
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
  writeHead(status: number, headers?: Record<string, string | number>): void;
  write(chunk: Uint8Array): boolean;
  end(): void;
  on(event: 'close', listener: () => void): void;
}

interface ServerLike {
  listen(port: number, host: string, callback: () => void): void;
  address(): { port: number } | string | null;
  close(): void;
  closeAllConnections?(): void;
  unref?(): void;
  on(event: 'error', listener: (err: unknown) => void): void;
}

interface HttpModule {
  createServer(
    handler: (req: RequestLike, res: ResponseLike) => void,
  ): ServerLike;
}

export type LoopbackRoute = (
  path: string,
  query: Map<string, string>,
  gone: Promise<void>,
) => FeedReply | Promise<FeedReply>;

const routes = new Map<string, LoopbackRoute>();
let running: Promise<{ server: ServerLike; origin: string }> | null = null;

/** `token`'s requests to `route`, and where the server answers. */
export function serve(token: string, route: LoopbackRoute): Promise<string> {
  routes.set(token, route);
  running ??= start();
  return running.then(({ origin }) => origin);
}

/** `token`'s requests are refused, and with no token left the server
 *  closes, so that it holds nothing open past the last feed. */
export function unserve(token: string): void {
  routes.delete(token);
  if (routes.size || !running) return;
  const was = running;
  running = null;
  void was.then(
    ({ server }) => {
      server.closeAllConnections?.();
      server.close();
    },
    () => {
      // a server that never listened has nothing to close
    },
  );
}

async function start(): Promise<{ server: ServerLike; origin: string }> {
  const http = await nodeModule<HttpModule>('http');
  const server = http.createServer((req, res) => {
    void answer(req, res).catch(() => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  // the process's life is the application's, never a player's
  server.unref?.();
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, origin: `http://127.0.0.1:${port}` };
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

async function answer(req: RequestLike, res: ResponseLike): Promise<void> {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  const path = (q < 0 ? raw : raw.slice(0, q)).replace(/^\/+/, '');
  const query = new Map<string, string>();
  if (q >= 0) {
    for (const pair of raw.slice(q + 1).split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      query.set(
        decode(eq < 0 ? pair : pair.slice(0, eq)),
        eq < 0 ? '' : decode(pair.slice(eq + 1)),
      );
    }
  }
  const slash = path.indexOf('/');
  const route = slash > 0 ? routes.get(path.slice(0, slash)) : undefined;
  const head = req.method === 'HEAD';
  if (!route || (req.method !== 'GET' && !head)) {
    res.writeHead(404, { 'content-length': 0 });
    res.end();
    return;
  }
  let away = (): void => {};
  const gone = new Promise<void>((resolve) => {
    away = resolve;
  });
  res.on('close', () => {
    if (!res.writableEnded) away();
  });
  const reply = await route(path.slice(slash + 1), query, gone);
  if (res.writableEnded || res.destroyed) return;
  const body = reply.body ?? [];
  let length = 0;
  for (const piece of body) length += piece.length;
  res.writeHead(reply.status, {
    'content-type': reply.type ?? 'application/octet-stream',
    'content-length': length,
    'cache-control': 'no-store',
  });
  if (!head) for (const piece of body) res.write(piece);
  res.end();
}
