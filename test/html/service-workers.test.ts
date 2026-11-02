// Service workers, end to end: a real server on the loopback, which a page
// served from is a secure context of, an `HtmlNetwork` and an
// `HtmlServiceWorkers` as a browser's tab holds them, and each worker a real
// thread. A test takes the server away to see what a worker kept.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test as nodeTest } from 'node:test';

import React from 'react';
import { act, cleanup, renderX11 } from 'react-x11/test';

import {
  Html,
  HtmlNetwork,
  HtmlProfile,
  HtmlServiceWorkers,
  useHtmlHandle,
  useHtmlNetwork,
} from '../../src/html/index.js';
import type { HtmlHandle, HtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { preloadHtmlScripts } from '../../src/html/scripts/hook.js';

const h = React.createElement;
const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

await preloadHtmlScripts();

afterEach(() => cleanup());

/** A site, as a test writes it: each path's type and body, or a function of
 *  the request for one that answers by what it was asked. */
type Page = string | [type: string, body: string | Uint8Array];

interface Site {
  url(path: string): string;
  /** What was asked for, in order. */
  asked: string[];
  /** The headers each path was last asked for with. */
  headers: Map<string, IncomingMessage['headers']>;
  pages: Map<string, Page>;
  /** The server gone, as a network that is off. */
  down(): Promise<void>;
}

const TYPES: Record<string, string> = {
  html: 'text/html',
  js: 'text/javascript',
  css: 'text/css',
};

async function serve(
  pages: Record<string, Page>,
  t: { after(fn: () => unknown): void },
): Promise<Site> {
  const site: Site = {
    url: (path) => `http://localhost:${port}${path}`,
    asked: [],
    headers: new Map(),
    pages: new Map(Object.entries(pages)),
    down: () =>
      new Promise((done) => {
        if (!server.listening) {
          done();
          return;
        }
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
  const server: Server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const path = (request.url ?? '/').split('?')[0];
      site.asked.push(path);
      site.headers.set(path, request.headers);
      const page = site.pages.get(path);
      if (page === undefined) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('no such page');
        return;
      }
      const [type, body] =
        typeof page === 'string'
          ? [TYPES[path.split('.').pop() ?? 'html'] ?? 'text/html', page]
          : page;
      response.writeHead(200, { 'content-type': type });
      response.end(body);
    },
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  t.after(() => site.down());
  return site;
}

interface Shown {
  handle: HtmlHandle;
  logs: string[];
  /** The text of an element, once `ready` holds of it. */
  text(id: string, ready?: (text: string) => boolean): Promise<string>;
}

function textOf(node: unknown): string {
  const n = node as { type?: string; data?: string; children?: unknown[] };
  if (n.type === 'text') return n.data ?? '';
  return (n.children ?? []).map(textOf).join('');
}

function byId(node: unknown, id: string): unknown {
  const n = node as { attribs?: Record<string, string>; children?: unknown[] };
  if (n.attribs?.id === id) return n;
  for (const child of n.children ?? []) {
    const found = byId(child, id);
    if (found) return found;
  }
  return null;
}

/** A document, as a tab shows one: its network's answer, whoever gave it, in
 *  an `<Html>` with its worker's keeper. */
async function show(
  url: string,
  network: HtmlNetwork,
  keeper: HtmlServiceWorkers,
  extra: HtmlScripts = {},
): Promise<Shown> {
  const doc = await network.html(url);
  const logs: string[] = [];
  let shownHandle: HtmlHandle;
  function Page() {
    const handle = useHtmlHandle();
    shownHandle = handle;
    const net = useHtmlNetwork(doc.url, network);
    return h(Html, {
      source: doc.source,
      baseUrl: doc.url,
      ref: handle.ref,
      onResource: net.onResource,
      scripts: {
        fetch: net.fetch,
        serviceWorkers: keeper,
        log: (level, text) => void logs.push(`${level}: ${text}`),
        ...extra,
      } as HtmlScripts,
    });
  }
  await renderX11(h(Page), { backend: 'mock', width: 400, height: 300 });
  return {
    get handle() {
      return shownHandle;
    },
    logs,
    async text(id, ready = (text) => text !== '') {
      const until = Date.now() + 15000;
      for (;;) {
        await act(async () => {
          await new Promise((go) => setTimeout(go, 10));
        });
        const el = byId(shownHandle.document, id);
        const text = el ? textOf(el) : '';
        if (ready(text)) return text;
        assert.ok(
          Date.now() < until,
          `#${id} read '${text}'\n${logs.join('\n')}`,
        );
      }
    },
  };
}

const SHELL = `<!doctype html>
<link rel="stylesheet" href="/style.css">
<p id="out"></p><p id="state"></p>
<script src="/app.js"></script>`;
/** The page's script: it says it ran, and registers. */
const APP = `
document.getElementById('out').textContent = 'app ' + (navigator.serviceWorker.controller ? 'controlled' : 'free');
navigator.serviceWorker.register('/sw.js').then(function (r) {
  return navigator.serviceWorker.ready;
}).then(function () {
  document.getElementById('state').textContent = 'ready';
});`;
/** Caches its shell as it installs, and answers from there. */
const OFFLINE_WORKER = `
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open('shell').then(function (c) {
    return c.addAll(['/', '/app.js', '/style.css']);
  }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(clients.claim());
});
self.addEventListener('fetch', function (e) {
  e.respondWith(caches.match(e.request).then(function (hit) {
    return hit || fetch(e.request);
  }));
});`;

test('a page that caches its shell as its worker installs loads it again with the network off', async (t) => {
  const site = await serve(
    {
      '/': SHELL,
      '/app.js': APP,
      '/style.css': 'p { color: red }',
      '/sw.js': OFFLINE_WORKER,
    },
    t,
  );
  const keeper = new HtmlServiceWorkers();
  const network = new HtmlNetwork({ serviceWorkers: keeper });
  const first = await show(site.url('/'), network, keeper);
  assert.equal(await first.text('out'), 'app free');
  await first.text('state', (text) => text === 'ready');
  cleanup();
  await site.down();
  network.clear();
  const second = await show(site.url('/'), network, keeper);
  assert.equal(await second.text('out'), 'app controlled');
});

/** A page that says what its worker said back. */
const ANSWERED = `<!doctype html><p id="out"></p><script>
fetch('/made').then(function (r) { return r.text(); }).then(function (text) {
  document.getElementById('out').textContent = text;
});
</script>`;

/** Registers a worker, and has its scope ready for the page after it. */
async function installed(
  site: Site,
  keeper: HtmlServiceWorkers,
  network: HtmlNetwork,
): Promise<void> {
  const page = await show(site.url('/register'), network, keeper);
  await page.text('state', (text) => text === 'ready');
  cleanup();
}

const REGISTER = `<!doctype html><p id="state"></p><script>
navigator.serviceWorker.register('/sw.js').then(function () {
  return navigator.serviceWorker.ready;
}).then(function () {
  document.getElementById('state').textContent = 'ready';
});
</script>`;

test("a worker's answer takes the network's place, and one it leaves alone goes to the network", async (t) => {
  const site = await serve(
    {
      '/register': REGISTER,
      '/page': ANSWERED,
      '/made': ['text/plain', 'the network'],
      '/sw.js': `self.addEventListener('fetch', function (e) {
        if (new URL(e.request.url).search === '?left') return;
        if (new URL(e.request.url).pathname === '/made') {
          e.respondWith(new Response('the worker: ' + e.request.mode + ' ' + e.request.destination + ' ' + (e.clientId ? 'a client' : 'none')));
        }
      });`,
    },
    t,
  );
  const keeper = new HtmlServiceWorkers();
  const network = new HtmlNetwork({ serviceWorkers: keeper });
  await installed(site, keeper, network);
  const page = await show(site.url('/page'), network, keeper);
  assert.equal(await page.text('out'), 'the worker: cors  a client');
  assert.ok(!site.asked.includes('/made'), 'the network never heard');
});

test('what a frame left behind as it was taken out asks the registry nothing, and posts nothing', async (t) => {
  const site = await serve(
    {
      '/register': REGISTER,
      '/frame': '<!doctype html><p>frame</p>',
      '/page': `<!doctype html><p id="out"></p><script>
        const frame = document.createElement('iframe');
        frame.onload = () => {
          const w = frame.contentWindow;
          const made = w.DOMException;
          w.navigator.serviceWorker.getRegistration('/').then((registration) => {
            const worker = registration.active;
            frame.remove();
            let answered = 0;
            registration.update().then(() => (answered += 1), () => {});
            registration.unregister().then(() => (answered += 1), () => {});
            let thrown = 'none';
            try {
              worker.postMessage('');
            } catch (e) {
              thrown = e.name + ' ' + (e instanceof made);
            }
            setTimeout(() => {
              navigator.serviceWorker.getRegistration('/').then((still) => {
                document.getElementById('out').textContent =
                  answered + ' ' + thrown + ' ' + !!still;
              });
            }, 100);
          });
        };
        frame.src = '/frame';
        document.body.appendChild(frame);
      </script>`,
      '/sw.js': '',
    },
    t,
  );
  const keeper = new HtmlServiceWorkers();
  const network = new HtmlNetwork({ serviceWorkers: keeper });
  await installed(site, keeper, network);
  const page = await show(site.url('/page'), network, keeper);
  assert.equal(await page.text('out'), '0 InvalidStateError true true');
});

test('what a worker hands back whole or as it comes reaches an image and a sheet', async (t) => {
  const pixel = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const site = await serve(
    {
      '/register': REGISTER,
      '/page': `<!doctype html><link rel="stylesheet" href="/sheet.css">
        <img id="i" src="/pixel.png"><p id="out"></p><script>
        var i = document.getElementById('i');
        function say() {
          var w = getComputedStyle(document.getElementById('out')).color;
          document.getElementById('out').textContent = i.naturalWidth + ' ' + w;
        }
        if (i.complete) say(); else i.onload = say;
        </script>`,
      '/pixel.png': ['image/png', pixel],
      '/sw.js': `self.addEventListener('fetch', function (e) {
        var path = new URL(e.request.url).pathname;
        if (path === '/sheet.css') {
          e.respondWith(new Response(new ReadableStream({
            start: function (c) {
              c.enqueue(new TextEncoder().encode('p { color: '));
              c.enqueue(new TextEncoder().encode('rgb(1, 2, 3) }'));
              c.close();
            },
          }), { headers: { 'content-type': 'text/css' } }));
        } else if (path === '/pixel.png') e.respondWith(fetch(e.request));
      });`,
    },
    t,
  );
  const keeper = new HtmlServiceWorkers();
  const network = new HtmlNetwork({ serviceWorkers: keeper });
  await installed(site, keeper, network);
  const page = await show(site.url('/page'), network, keeper);
  assert.equal(await page.text('out'), '1 rgb(1, 2, 3)');
  assert.ok(!site.asked.includes('/sheet.css'), 'the network never heard');
});

test('a hard reload asks past the worker, and what it brings is uncontrolled', async (t) => {
  const site = await serve(
    {
      '/register': REGISTER,
      '/page': `<!doctype html><p id="out"></p><script>
        document.getElementById('out').textContent =
          navigator.serviceWorker.controller ? 'controlled' : 'free';
        </script>`,
      '/sw.js': `self.addEventListener('fetch', function (e) {
        e.respondWith(fetch(e.request));
      });`,
    },
    t,
  );
  const keeper = new HtmlServiceWorkers();
  const network = new HtmlNetwork({ serviceWorkers: keeper });
  await installed(site, keeper, network);
  const soft = await show(site.url('/page'), network, keeper);
  assert.equal(await soft.text('out'), 'controlled');
  cleanup();
  await network.document(
    site.url('/page'),
    new AbortController().signal,
    null,
    {
      serviceWorkers: 'bypass',
    },
  );
  const hard = await show(site.url('/page'), network, keeper);
  assert.equal(await hard.text('out'), 'free');
});

test('a worker and what it cached outlive the process, and answer the first navigation of the next', async (t) => {
  const site = await serve(
    {
      '/': SHELL,
      '/app.js': APP,
      '/style.css': 'p { color: red }',
      '/sw.js': OFFLINE_WORKER,
    },
    t,
  );
  const dir = mkdtempSync(join(tmpdir(), 'service-workers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = async () => {
    const profile = await HtmlProfile.open(dir);
    if (!profile?.serviceWorkers) return null;
    const keeper = new HtmlServiceWorkers({ store: profile.serviceWorkers });
    const network = new HtmlNetwork({ serviceWorkers: keeper });
    return { profile, keeper, network };
  };
  const first = await open();
  if (!first) {
    t.skip('this runtime has no SQLite');
    return;
  }
  const page = await show(site.url('/'), first.network, first.keeper, {
    storage: first.profile.storage,
  });
  await page.text('state', (text) => text === 'ready');
  cleanup();
  first.keeper.dispose();
  first.profile.close();
  await site.down();

  // the next run: a new registry, nothing in memory, and no network
  const next = await open();
  t.after(() => {
    next!.keeper.dispose();
    next!.profile.close();
  });
  const again = await show(site.url('/'), next!.network, next!.keeper, {
    storage: next!.profile.storage,
  });
  assert.equal(await again.text('out'), 'app controlled');
});

test('a page looking for what is not here finds nothing it can trip on', async (t) => {
  const site = await serve(
    {
      '/register': `<!doctype html><p id="state"></p><p id="out"></p><script>
        navigator.serviceWorker.register('/sw.js').then(function (r) {
          document.getElementById('out').textContent = [
            'PushManager' in window, 'SyncManager' in window,
            'PeriodicSyncManager' in window, 'pushManager' in r, 'sync' in r,
            'periodicSync' in r].join(' ');
          return navigator.serviceWorker.ready;
        }).then(function () {
          document.getElementById('state').textContent = 'ready';
        });</script>`,
      '/sw.js': '',
    },
    t,
  );
  const keeper = new HtmlServiceWorkers();
  const network = new HtmlNetwork({ serviceWorkers: keeper });
  const page = await show(site.url('/register'), network, keeper);
  assert.equal(await page.text('out'), 'false false false false false false');
});

test('a worker with nothing to do gives its thread up, and comes back for what it hears', async (t) => {
  const site = await serve(
    {
      '/register': REGISTER,
      '/page': ANSWERED,
      '/sw.js': `var runs = (self.runs || 0) + 1;
        self.addEventListener('fetch', function (e) {
          if (new URL(e.request.url).pathname === '/made') {
            e.respondWith(new Response('up ' + runs));
          }
        });`,
    },
    t,
  );
  const keeper = new HtmlServiceWorkers({ idleMs: 20 });
  const network = new HtmlNetwork({ serviceWorkers: keeper });
  await installed(site, keeper, network);
  const { registryOf } = await import('../../src/html/scripts/sw-registry.js');
  const registry = registryOf(keeper);
  const until = Date.now() + 5000;
  while (registry.running > 0 && Date.now() < until) {
    await new Promise((go) => setTimeout(go, 10));
  }
  assert.equal(registry.running, 0, 'the thread went');
  const page = await show(site.url('/page'), network, keeper);
  assert.equal(await page.text('out'), 'up 1');
});

test('a worker whose script changed waits for the pages of the one before, unless it skips waiting and claims them', async (t) => {
  const site = await serve(
    {
      '/register': REGISTER,
      '/page': `<!doctype html><p id="out"></p><script>
        navigator.serviceWorker.addEventListener('controllerchange', function () {
          fetch('/made').then(function (r) { return r.text(); }).then(function (text) {
            document.getElementById('out').textContent = text;
          });
        });
        navigator.serviceWorker.getRegistration().then(function (r) { r.update(); });
        </script>`,
      '/sw.js': `self.addEventListener('fetch', function (e) {
        if (new URL(e.request.url).pathname === '/made') {
          e.respondWith(new Response('first'));
        }
      });`,
    },
    t,
  );
  const keeper = new HtmlServiceWorkers();
  const network = new HtmlNetwork({ serviceWorkers: keeper });
  await installed(site, keeper, network);
  site.pages.set(
    '/sw.js',
    `self.addEventListener('install', function () { skipWaiting(); });
     self.addEventListener('activate', function (e) { e.waitUntil(clients.claim()); });
     self.addEventListener('fetch', function (e) {
       if (new URL(e.request.url).pathname === '/made') {
         e.respondWith(new Response('second'));
       }
     });`,
  );
  const page = await show(site.url('/page'), network, keeper);
  assert.equal(await page.text('out'), 'second');
});

test("a frame the scope of a worker holds is that worker's client", async (t) => {
  const site = await serve(
    {
      '/register': REGISTER,
      '/sw.js': '',
      '/framed': `<!doctype html><p id="out"></p><script>
        var f = document.createElement('iframe');
        f.src = '/inner';
        f.onload = function () {
          var w = f.contentWindow;
          document.getElementById('out').textContent =
            w.navigator.serviceWorker.controller.scriptURL;
        };
        document.body.appendChild(f);
        </script>`,
      '/inner': '<!doctype html><title>nothing runs here</title>',
    },
    t,
  );
  const keeper = new HtmlServiceWorkers();
  const network = new HtmlNetwork({ serviceWorkers: keeper });
  await installed(site, keeper, network);
  const page = await show(site.url('/framed'), network, keeper);
  assert.equal(await page.text('out'), site.url('/sw.js'));
});

test("another origin's image goes through a worker, into its cache and out again, with no script reading a byte of it", async (t) => {
  const pixel = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const images = await serve({ '/pixel.png': ['image/png', pixel] }, t);
  const other = images.url('/pixel.png').replace('localhost', '127.0.0.1');
  const site = await serve(
    {
      '/register': REGISTER,
      '/page': `<!doctype html><p id="out"></p><script>
        var i = new Image();
        i.onload = function () { document.getElementById('out').textContent = 'drawn ' + i.naturalWidth; };
        i.onerror = function () { document.getElementById('out').textContent = 'failed'; };
        i.src = ${JSON.stringify(other)};
        </script>`,
      '/sw.js': `self.addEventListener('fetch', function (e) {
        if (e.request.url.indexOf('pixel') < 0) return;
        e.respondWith(caches.open('images').then(function (c) {
          return c.match(e.request).then(function (hit) {
            if (hit) return hit;
            return fetch(e.request).then(function (r) {
              self.seen = r.type + ' ' + r.status;
              return c.put(e.request, r.clone()).then(function () { return r; });
            });
          });
        }));
      });`,
    },
    t,
  );
  const keeper = new HtmlServiceWorkers();
  const network = new HtmlNetwork({ serviceWorkers: keeper });
  await installed(site, keeper, network);
  const page = await show(site.url('/page'), network, keeper);
  assert.equal(await page.text('out'), 'drawn 1');
  cleanup();
  await images.down();
  const again = await show(site.url('/page'), network, keeper);
  assert.equal(await again.text('out'), 'drawn 1');
});

test("a page cannot read another origin's opaque body by writing the number it is held by", async (t) => {
  const images = await serve({ '/secret': ['text/plain', 'the secret'] }, t);
  const other = images.url('/secret').replace('localhost', '127.0.0.1');
  const site = await serve(
    {
      '/page': `<!doctype html><p id="out"></p><script>
        var out = document.getElementById('out');
        fetch(${JSON.stringify(other)}, { mode: 'no-cors' }).then(function (r) {
          var forged = new Response('');
          forged._held = r._held;
          return caches.open('c').then(function (c) {
            return c.put('/mine', forged).then(function () {
              return c.match('/mine');
            });
          });
        }).then(function (r) {
          return r.text().then(function (text) {
            out.textContent = r.type + ':' + text + ':' + r.status;
          });
        }).catch(function (e) { out.textContent = 'threw ' + e; });
        </script>`,
    },
    t,
  );
  const keeper = new HtmlServiceWorkers();
  const network = new HtmlNetwork({ serviceWorkers: keeper });
  const page = await show(site.url('/page'), network, keeper);
  assert.equal(await page.text('out'), 'opaque::0');
});

test('a second process finds what the first registered, in the same profile, and each runs its own worker', async (t) => {
  const site = await serve(
    {
      '/register': REGISTER,
      '/page': ANSWERED,
      '/sw.js': `self.addEventListener('fetch', function (e) {
        if (new URL(e.request.url).pathname === '/made') {
          e.respondWith(caches.open('c').then(function (c) {
            return c.match('/note');
          }).then(function (hit) {
            return hit || new Response('nothing kept');
          }));
        }
      });
      self.addEventListener('activate', function (e) {
        e.waitUntil(caches.open('c').then(function (c) {
          return c.put('/note', new Response('kept by the first'));
        }));
      });`,
    },
    t,
  );
  const dir = mkdtempSync(join(tmpdir(), 'service-workers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = async () => {
    const profile = await HtmlProfile.open(dir);
    if (!profile?.serviceWorkers) return null;
    const keeper = new HtmlServiceWorkers({ store: profile.serviceWorkers });
    const network = new HtmlNetwork({ serviceWorkers: keeper });
    t.after(() => {
      keeper.dispose();
      profile.close();
    });
    return { profile, keeper, network };
  };
  const first = await open();
  const second = await open();
  if (!first || !second) {
    t.skip('this runtime has no SQLite');
    return;
  }
  const registering = await show(
    site.url('/register'),
    first.network,
    first.keeper,
    { storage: first.profile.storage },
  );
  await registering.text('state', (text) => text === 'ready');
  cleanup();
  const page = await show(site.url('/page'), second.network, second.keeper, {
    storage: second.profile.storage,
  });
  assert.equal(await page.text('out'), 'kept by the first');
});
