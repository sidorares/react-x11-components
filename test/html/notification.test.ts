// `<Html scripts>` and the desktop: `Notification` (`src/html/scripts/
// notifications.ts`) over the `notifications` seam, which holds what it is
// shown here (`memoryNotifications`), and `navigator.permissions` answering
// what is really granted.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { act, cleanup, fireEvent, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import {
  Html,
  memoryClipboard,
  memoryNotifications,
  preloadHtmlScripts,
  useHtmlHandle,
} from '../../src/html/index.js';
import type {
  HtmlClipboard,
  HtmlNotifications,
  HtmlPermissions,
  HtmlPermissionState,
} from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const PAGE = 'https://example.test/page.html';

/** A page's permissions, each as a test sets it, and how it moves one. */
function permissions(
  held: Record<string, HtmlPermissionState> = {},
  answer: HtmlPermissionState = 'granted',
): HtmlPermissions & {
  asked: string[];
  move(name: string, state: HtmlPermissionState): void;
} {
  const heard = new Set<(name: string) => void>();
  const out = {
    asked: [] as string[],
    state: (name: string) => held[name] ?? 'prompt',
    request(name: string, origin: string) {
      out.asked.push(`${name} ${origin}`);
      held[name] = answer;
      return Promise.resolve(answer);
    },
    watch(listener: (name: string) => void) {
      heard.add(listener);
      return () => heard.delete(listener);
    },
    move(name: string, state: HtmlPermissionState) {
      held[name] = state;
      for (const listener of heard) listener(name);
    },
  };
  return out;
}

/** A page whose scripts run, and what they log. */
async function page(
  markup: string,
  options: {
    notifications?: HtmlNotifications;
    permissions?: HtmlPermissions;
    clipboard?: HtmlClipboard;
    url?: string;
  } = {},
) {
  const logs: string[] = [];
  function Doc() {
    const own = useHtmlHandle();
    return h(Html, {
      source: `<!doctype html><html><body>${markup}</body></html>`,
      partial: false,
      baseUrl: options.url ?? PAGE,
      ref: own.ref,
      'data-testname': 'doc',
      scripts: {
        ...(options.notifications && { notifications: options.notifications }),
        ...(options.permissions && { permissions: options.permissions }),
        ...(options.clipboard && { clipboard: options.clipboard }),
        log: (level: string, text: string) =>
          void logs.push(`${level}: ${text}`),
      },
    });
  }
  await renderX11(
    h(Doc),
    FONTS ? { width: 300, height: 200, fonts: FONTS } : { backend: 'mock' },
  );
  const node = screen.getByTestName('doc') as DrawnNode;
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      await act(() => new Promise((r) => setTimeout(r, 5)));
    }
  };
  await settle();
  return {
    logs,
    settle,
    async until(prefix: string) {
      const end = Date.now() + 5000;
      const found = () => logs.find((l) => l.startsWith(`log: ${prefix}`));
      while (!found() && Date.now() < end) {
        await act(() => new Promise((r) => setTimeout(r, 5)));
      }
      const line = found();
      assert.ok(line, `no "${prefix}" in:\n${logs.join('\n')}`);
      return line.slice(`log: ${prefix}`.length).trim();
    },
    async press() {
      await act(async () => {
        fireEvent.mouseDown(node, {});
        fireEvent.mouseUp(node, {});
      });
      await settle();
    },
  };
}

// --- with nothing to show one with -----------------------------------------------

test('a bare page finds Notification refused, and reaches nothing', async () => {
  const shown = await page(`<script>
    const n = new Notification('hello');
    console.log('permission', Notification.permission);
    n.onshow = () => console.log('shown');
    n.onerror = (e) => console.log('error', e.type, e instanceof Event);
    Notification.requestPermission().then((s) => console.log('asked', s));
  </script>`);
  assert.equal(await shown.until('permission'), 'denied');
  assert.equal(await shown.until('error'), 'error true');
  assert.equal(await shown.until('asked'), 'denied');
  await shown.settle();
  assert.ok(!shown.logs.some((l) => l.includes('shown')));
});

test('a page with no host to ask has been granted nothing, and says so', async () => {
  const shown = await page(`<script>
    (async () => {
      for (const name of ['notifications', 'geolocation', 'camera', 'clipboard-read']) {
        const s = await navigator.permissions.query({ name });
        console.log(name, s.state);
      }
    })();
  </script>`);
  for (const name of [
    'notifications',
    'geolocation',
    'camera',
    'clipboard-read',
  ]) {
    assert.equal(await shown.until(name), 'denied');
  }
});

test('a refusal is the page’s own, and reads nothing of the host', async () => {
  const shown = await page(`<script>
    const out = (label, e) => console.log(label,
      e instanceof TypeError || e instanceof DOMException,
      e.constructor.constructor('return typeof process')());
    try { new Notification(); } catch (e) { out('none', e); }
    try { new Notification('a', { dir: 'sideways' }); } catch (e) { out('dir', e); }
    try { new Notification('a', { actions: [{}] }); } catch (e) { out('actions', e); }
    try { new Notification('a', { data: () => {} }); } catch (e) { out('data', e); }
    Notification.requestPermission(1).catch((e) => out('callback', e));
    navigator.permissions.query({ name: 'nope' }).catch((e) => out('name', e));
    const n = new Notification('x');
    n.onerror = (e) => console.log('event',
      e.constructor.constructor('return typeof process')());
  </script>`);
  for (const label of ['none', 'dir', 'actions', 'data', 'callback', 'name']) {
    assert.equal(await shown.until(label), 'true undefined');
  }
  assert.equal(await shown.until('event'), 'undefined');
});

// --- shown ----------------------------------------------------------------------

test('a notification goes to the host with its origin, and a page hears show', async () => {
  const notifications = memoryNotifications();
  const shown = await page(
    `<script>
    console.log('permission', Notification.permission);
    const n = new Notification('New mail', {
      body: 'from Sam', tag: 'mail', icon: 'i.png', silent: true,
      requireInteraction: true, data: { a: [1] }, lang: 'de-DE', dir: 'rtl',
    });
    n.onshow = (e) => console.log('shown', e.type, n.title, n.body, n.tag, n.icon);
    console.log('fields', n.silent, n.requireInteraction, n.lang, n.dir,
      JSON.stringify(n.data), n.data === n.data, n.renotify, typeof n.timestamp);
  </script>`,
    { notifications },
  );
  assert.equal(await shown.until('permission'), 'granted');
  assert.equal(
    await shown.until('shown'),
    'show New mail from Sam mail https://example.test/i.png',
  );
  assert.equal(
    await shown.until('fields'),
    'true true de-DE rtl {"a":[1]} true false number',
  );
  const [sent] = notifications.shown;
  assert.equal(sent.title, 'New mail');
  assert.equal(sent.origin, 'https://example.test');
  assert.equal(sent.icon, 'https://example.test/i.png');
  assert.equal(sent.silent, true);
});

test('a page cannot say what origin it is from', async () => {
  const notifications = memoryNotifications();
  const shown = await page(
    `<script>
    const n = new Notification('x', { origin: 'https://bank.test' });
    n.onshow = () => console.log('shown');
  </script>`,
    { notifications },
  );
  await shown.until('shown');
  assert.equal(notifications.shown[0].origin, 'https://example.test');
});

test('a click is told, and brings the page forward unless it is cancelled', async () => {
  const notifications = memoryNotifications();
  const shown = await page(
    `<script>
    const kept = new Notification('kept');
    kept.onclick = (e) => { e.preventDefault(); console.log('kept', e.cancelable); };
    const plain = new Notification('plain');
    plain.onclick = () => console.log('plain');
    plain.onshow = () => console.log('both');
  </script>`,
    { notifications },
  );
  await shown.until('both');
  await act(async () => notifications.shown[0].click());
  assert.equal(await shown.until('kept'), 'true');
  assert.equal(notifications.focused, 0);
  await act(async () => notifications.shown[1].click());
  await shown.until('plain');
  assert.equal(notifications.focused, 1);
});

test('close() takes it down, and a host’s close is told once', async () => {
  const notifications = memoryNotifications();
  const shown = await page(
    `<script>
    const a = new Notification('a');
    a.onshow = () => a.close();
    a.onclose = (e) => console.log('closed a', Object.prototype.toString.call(e));
    const b = new Notification('b');
    b.onshow = () => console.log('b up');
    let times = 0;
    b.onclose = () => console.log('closed b', ++times);
    const c = new Notification('c');
    c.close();
    c.onclose = (e) => console.log('closed c', e.type);
  </script>`,
    { notifications },
  );
  assert.equal(await shown.until('closed a'), '[object Event]');
  assert.equal(await shown.until('closed c'), 'close');
  await shown.until('b up');
  assert.deepEqual(
    notifications.shown.map((n) => n.title),
    ['b'],
  );
  await act(async () => {
    notifications.shown[0].close();
    notifications.shown[0].close();
  });
  assert.equal(await shown.until('closed b'), '1');
  await shown.settle();
  assert.equal(shown.logs.filter((l) => l.includes('closed b')).length, 1);
});

test('one of a tag replaces the last, and another tag leaves it', async () => {
  const notifications = memoryNotifications();
  const shown = await page(
    `<script>
    const one = new Notification('one', { tag: 'a' });
    one.onclose = () => console.log('one closed');
    one.onshow = () => {
      const other = new Notification('other', { tag: 'b' });
      other.onshow = () => {
        const two = new Notification('two', { tag: 'a' });
        two.onshow = () => console.log('two up');
      };
    };
  </script>`,
    { notifications },
  );
  await shown.until('two up');
  await shown.until('one closed');
  assert.deepEqual(notifications.shown.map((n) => n.title).sort(), [
    'other',
    'two',
  ]);
});

test('a host that cannot show one is an error at the page’s notification', async () => {
  const shown = await page(
    `<script>
    const n = new Notification('x');
    n.onerror = () => console.log('failed', n.title);
  </script>`,
    {
      notifications: {
        show: () => Promise.reject(new Error('no daemon')),
      },
    },
  );
  assert.equal(await shown.until('failed'), 'x');
});

test('a page that goes takes its notifications with it', async () => {
  const notifications = memoryNotifications();
  const shown = await page(
    `<script>
    const n = new Notification('x');
    n.onshow = () => console.log('up');
  </script>`,
    { notifications },
  );
  await shown.until('up');
  assert.equal(notifications.shown.length, 1);
  cleanup();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(notifications.shown.length, 0);
});

test('what is not a language is not handed on', async () => {
  const shown = await page(`<script>
    for (const lang of ['', 'en', 'de-Latn-DE-1996', 'en-US-x-hixie', 'en-', 'a-fr-lang', 'cocoa-1-bar', 'foöÉ']) {
      console.log('lang', JSON.stringify([lang, new Notification('x', { lang }).lang]));
    }
  </script>`);
  await shown.settle();
  const said = shown.logs
    .filter((l) => l.startsWith('log: lang'))
    .map((l) => JSON.parse(l.slice('log: lang '.length)) as string[]);
  assert.deepEqual(
    said.filter(([given, kept]) => given === kept).map(([given]) => given),
    ['', 'en', 'de-Latn-DE-1996', 'en-US-x-hixie'],
  );
});

test('what the options refuse together, Web IDL’s and the specification’s', async () => {
  const shown = await page(`<script>
    const threw = (options) => { try { new Notification('x', options); return false; } catch (e) { return e.name; } };
    console.log('renotify', threw({ renotify: true }));
    console.log('navigate', threw({ navigate: 'https://[' }));
    console.log('fine', threw({ renotify: true, tag: 'a', navigate: '/next' }));
    console.log('navigate to', new Notification('x', { navigate: '/next' }).navigate);
    console.log('silents', new Notification('x').silent, new Notification('x', { silent: 0 }).silent);
  </script>`);
  assert.equal(await shown.until('renotify'), 'TypeError');
  assert.equal(await shown.until('navigate'), 'TypeError');
  assert.equal(await shown.until('fine'), 'false');
  assert.equal(await shown.until('navigate to'), 'https://example.test/next');
  assert.equal(await shown.until('silents'), 'null false');
});

// --- asking ---------------------------------------------------------------------

test('asking needs a press, and a user’s answer is what a page hears', async () => {
  const notifications = memoryNotifications();
  const asked = permissions();
  const shown = await page(
    `<script>
    Notification.requestPermission().then((s) => console.log('unasked', s));
    document.documentElement.addEventListener('mousedown', async () => {
      const said = await Notification.requestPermission((s) => console.log('callback', s));
      console.log('answer', said, Notification.permission);
    });
  </script>`,
    { notifications, permissions: asked },
  );
  assert.equal(await shown.until('unasked'), 'default');
  assert.deepEqual(asked.asked, []);
  await shown.press();
  assert.equal(await shown.until('callback'), 'granted');
  assert.equal(await shown.until('answer'), 'granted granted');
  assert.deepEqual(asked.asked, ['notifications https://example.test']);
});

test('a refusal stays one: nothing is shown and nobody is asked again', async () => {
  const notifications = memoryNotifications();
  const asked = permissions({ notifications: 'denied' });
  const shown = await page(
    `<script>
    const n = new Notification('x');
    n.onerror = () => console.log('refused', Notification.permission);
    document.documentElement.addEventListener('mousedown', () => {
      Notification.requestPermission().then((s) => console.log('again', s));
    });
  </script>`,
    { notifications, permissions: asked },
  );
  assert.equal(await shown.until('refused'), 'denied');
  await shown.press();
  assert.equal(await shown.until('again'), 'denied');
  assert.deepEqual(asked.asked, []);
  assert.equal(notifications.shown.length, 0);
});

test('nothing is granted in a page that is not secure, whatever the host says', async () => {
  const notifications = memoryNotifications();
  const shown = await page(
    `<script>
    console.log('permission', Notification.permission);
    navigator.permissions.query({ name: 'notifications' }).then((s) => console.log('query', s.state));
    const n = new Notification('x');
    n.onerror = () => console.log('refused');
    Notification.requestPermission().then((s) => console.log('asked', s));
  </script>`,
    {
      notifications,
      permissions: permissions({ notifications: 'granted' }),
      url: 'http://example.test/',
    },
  );
  assert.equal(await shown.until('permission'), 'denied');
  assert.equal(await shown.until('query'), 'denied');
  assert.equal(await shown.until('asked'), 'denied');
  await shown.until('refused');
  assert.equal(notifications.shown.length, 0);
});

test('a permission that moves tells who listens, whichever way they listen', async () => {
  const asked = permissions({ geolocation: 'prompt' });
  const shown = await page(
    `<script>
    navigator.permissions.query({ name: 'geolocation' }).then((s) => {
      s.onchange = () => console.log('handler', s.state);
      console.log('ready', s.state);
    });
    navigator.permissions.query({ name: 'geolocation' }).then((s) => {
      s.addEventListener('change', () => console.log('listener', s.state));
    });
  </script>`,
    { permissions: asked },
  );
  assert.equal(await shown.until('ready'), 'prompt');
  await act(async () => asked.move('geolocation', 'granted'));
  assert.equal(await shown.until('handler'), 'granted');
  assert.equal(await shown.until('listener'), 'granted');
  const told = shown.logs.length;
  await act(async () => asked.move('geolocation', 'granted'));
  await shown.settle();
  assert.equal(shown.logs.length, told, 'no change, no event');
});

test('a permission a page asked for moves its own status as well', async () => {
  const asked = permissions();
  const shown = await page(
    `<script>
    navigator.permissions.query({ name: 'notifications' }).then((s) => {
      s.onchange = () => console.log('moved', s.state);
    });
    document.documentElement.addEventListener('mousedown', () => {
      Notification.requestPermission();
    });
  </script>`,
    { notifications: memoryNotifications(), permissions: asked },
  );
  await shown.settle();
  await shown.press();
  assert.equal(await shown.until('moved'), 'granted');
});

test('a clipboard read is what asks for clipboard-read, and a query follows', async () => {
  const asked = permissions();
  const shown = await page(
    `<script>
    document.documentElement.addEventListener('mousedown', async () => {
      const text = await navigator.clipboard.readText();
      const s = await navigator.permissions.query({ name: 'clipboard-read' });
      console.log('read', text, s.state);
    });
  </script>`,
    {
      clipboard: memoryClipboard({ 'text/plain': 'hi' }),
      permissions: asked,
    },
  );
  await shown.settle();
  await shown.press();
  assert.equal(await shown.until('read'), 'hi granted');
});

test('a worker reads what its page was granted, and hears it move', async () => {
  const notifications = memoryNotifications();
  const asked = permissions({
    notifications: 'granted',
    geolocation: 'prompt',
  });
  const shown = await page(
    `<script>
    const source = \`
      navigator.permissions.query({ name: 'geolocation' }).then((s) => {
        s.onchange = () => postMessage(['moved', s.state]);
        postMessage(['ready', s.state, Notification.permission,
          'requestPermission' in Notification]);
      });
      const n = new Notification('from a worker');
      n.onshow = () => postMessage(['shown', n.title]);
      n.onclose = () => postMessage(['closed']);
      onmessage = () => n.close();
    \`;
    const worker = new Worker(URL.createObjectURL(new Blob([source])));
    worker.onmessage = (e) => {
      console.log(e.data[0], e.data.slice(1).join(' '));
      if (e.data[0] === 'shown') worker.postMessage('close');
    };
  </script>`,
    { notifications, permissions: asked },
  );
  assert.equal(await shown.until('ready'), 'prompt granted false');
  assert.equal(await shown.until('shown'), 'from a worker');
  await shown.until('closed');
  await act(async () => asked.move('geolocation', 'denied'));
  assert.equal(await shown.until('moved'), 'denied');
});
