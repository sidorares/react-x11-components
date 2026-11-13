// A document's render-blocking element set (HTML 3.1.6), as a page whose
// scripts run sees it: what holds its animation frames and its first paint
// timing, and what does not. WPT's html/dom/render-blocking/ is the check;
// these hold the shapes of it a parse can make in the harness, where a
// script the parser waits at is a held promise.
import { afterEach, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { act, cleanup, renderX11, screen } from 'react-x11/test';

import { Html, useHtmlHandle } from '../../src/html/index.js';
import type { ResourceRequest, ResourceResult } from '../../src/html/index.js';
import { preloadHtmlScripts, useScripts } from '../../src/html/scripts/hook.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import type { ScriptsOptions } from '../../src/html/scripts/runner.js';
import { findById, FONTS, h } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const PAGE = 'https://example.test/dir/page.html';

/** A script's source the test lets go when it says. */
class Held {
  private _go = new Map<string, (code: string) => void>();
  readonly asked: string[] = [];
  source(url: string): Promise<string> {
    this.asked.push(url);
    return new Promise((ok) => this._go.set(url, ok));
  }
  async release(url: string, code = 'void 0'): Promise<void> {
    const go = this._go.get(url);
    assert.ok(go, `${url} was asked for`);
    await act(async () => go(code));
    await settle();
  }
}

/** Let the scripts' turns run. */
async function settle(ms = 40) {
  for (let i = 0; i < 4; i += 1) {
    await act(() => new Promise((r) => setTimeout(r, ms / 4)));
  }
}

/** A page whose scripts run: `held` answers the scripts named in it when the
 *  test says, `scripts` the rest at once, `sheets` a stylesheet's text a
 *  moment later, or held until `sheet` is called. */
async function hosted(
  source: string,
  options: {
    held?: Held;
    heldUrls?: string[];
    scripts?: Record<string, string>;
    sheets?: Record<string, string>;
    heldSheets?: Map<string, (r: ResourceResult | null) => void>;
  } = {},
) {
  const logs: string[] = [];
  const out = {
    run: (_code: string) => {},
    logs,
    log: () => '',
  };
  const seams: ScriptsOptions = {
    userAgent: 'test',
    language: 'en-US',
    viewport: () => ({
      width: 400,
      height: 300,
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      dpr: 1,
      left: 0,
      top: 0,
    }),
    scrollTo: () => {},
    navigate: () => {},
    reload: () => {},
    go: () => {},
    log: (level, text) => void logs.push(`${level}: ${text}`),
    title: () => {},
    fetch: async () => {
      throw new Error('no network');
    },
    load: async (url) => {
      if (options.heldUrls?.includes(url)) return options.held!.source(url);
      return options.scripts?.[url] ?? null;
    },
    onTimeout: () => {},
  };
  let handle: ReturnType<typeof useHtmlHandle> | null = null;
  function Page() {
    handle = useHtmlHandle();
    const scripts = useScripts(true, handle, PAGE, seams);
    out.run = (code) => scripts.runner?.()?.engine.exec(code, 'test', 0);
    return h(Html, {
      source,
      partial: false,
      ref: handle.ref,
      baseUrl: PAGE,
      onResource: ({ url, kind }: ResourceRequest) => {
        if (kind !== 'stylesheet') return null;
        const name = url.slice(url.lastIndexOf('/') + 1);
        if (options.heldSheets?.has(name)) {
          return new Promise<ResourceResult | null>((ok) =>
            options.heldSheets!.set(name, ok),
          );
        }
        const text = options.sheets?.[name];
        return text === undefined
          ? null
          : new Promise<ResourceResult>((ok) =>
              setTimeout(() => ok({ kind, text }), 5),
            );
      },
      'data-testname': 'doc',
      ...scripts,
      ...({
        _onCssEventsOwed: scripts.cssEventsOwed,
        _onPaint: scripts.painted,
      } as object),
    });
  }
  await renderX11(
    h('box', { style: { width: 400, flexDirection: 'column' } }, h(Page)),
    FONTS ? { width: 440, height: 400, fonts: FONTS } : { backend: 'mock' },
  );
  await settle();
  void screen;
  out.log = () => {
    const root = handle?.document ? findById(handle.document, 'root') : null;
    return root?.attribs['data-log'] ?? '';
  };
  return out;
}

/** Wait until the page's log holds `done`, or the time is up. */
async function logOf(
  doc: { log(): string },
  done: (log: string) => boolean,
  ms = 3000,
): Promise<string> {
  const end = Date.now() + ms;
  while (!done(doc.log()) && Date.now() < end) await settle(20);
  return doc.log();
}

/** A log kept on `<html id="root">`, which a script in the head can reach. */
const NOTE =
  "function note(s) { var r = document.documentElement; var was = r.getAttribute('data-log'); r.setAttribute('data-log', (was ? was + ' ' : '') + s) }";

/** A note at the next animation frame: whether `#last` is in, and how many
 *  paint timing entries there are. */
const FRAME =
  "requestAnimationFrame(function () { note('raf:' + !!document.getElementById('last') + ':' + performance.getEntriesByType('paint').length) });";

test('an expect link a head script puts in holds frames until its element is parsed', async () => {
  const held = new Held();
  const doc = await hosted(
    '<html id="root"><head><script>' +
      NOTE +
      "var link = document.createElement('link'); link.rel = 'expect';" +
      " link.href = '#last'; link.blocking = 'render'; document.head.appendChild(link);" +
      FRAME +
      '</script></head><body><p id="first">first</p>' +
      '<script src="held.js"></script><p id="last">last</p></body></html>',
    { held, heldUrls: ['https://example.test/dir/held.js'] },
  );
  await settle(100);
  assert.equal(doc.log(), '', 'no frame while #last is still to come');
  await held.release('https://example.test/dir/held.js', "note('ran')");
  assert.equal(
    await logOf(doc, (l) => l.includes('raf')),
    'ran raf:true:2',
    doc.logs.join('\n'),
  );
});

/** A page whose body waits at `held.js` between `#first` and `#last`. */
const WAITS =
  '<p id="first">first</p><script src="held.js"></script><p id="last">last</p>';
const HELD = 'https://example.test/dir/held.js';

test('an expect link the parser meets in the body blocks nothing', async () => {
  const held = new Held();
  const doc = await hosted(
    '<html id="root"><head><script>' +
      NOTE +
      FRAME +
      '</script></head><body>' +
      '<link rel="expect" href="#last" blocking="render">' +
      WAITS +
      '</body></html>',
    { held, heldUrls: [HELD] },
  );
  assert.equal(
    await logOf(doc, (l) => l.includes('raf')),
    'raf:false:2',
    'the frame runs while the parse waits short of #last',
  );
  await held.release(HELD);
});

test('an expect link the head has stops blocking for good as its href goes, even in the body', async () => {
  const held = new Held();
  const doc = await hosted(
    '<html id="root"><head><script>' +
      NOTE +
      FRAME +
      '</script><link id="link" rel="expect" href="#last" blocking="render">' +
      '</head><body><script>link.removeAttribute("href")</script>' +
      WAITS +
      '</body></html>',
    { held, heldUrls: [HELD] },
  );
  assert.equal(await logOf(doc, (l) => l.includes('raf')), 'raf:false:2');
  await held.release(HELD);
});

test('an expect link whose base is another document waits for nothing', async () => {
  const held = new Held();
  const doc = await hosted(
    '<html id="root"><head><base href="other.html"><script>' +
      NOTE +
      FRAME +
      '</script><link rel="expect" href="#last" blocking="render">' +
      '</head><body>' +
      WAITS +
      '</body></html>',
    { held, heldUrls: [HELD] },
  );
  assert.equal(await logOf(doc, (l) => l.includes('raf')), 'raf:false:2');
  await held.release(HELD);
});

test('an expect link waits while an element it found is renamed: found once, it is done', async () => {
  const held = new Held();
  const doc = await hosted(
    '<html id="root"><head><script>' +
      NOTE +
      FRAME +
      '</script><link rel="expect" href="#first" blocking="render">' +
      '</head><body><p id="first">first</p>' +
      '<script>first.id = "was"</script>' +
      '<script src="held.js"></script><p id="last">last</p></body></html>',
    { held, heldUrls: [HELD] },
  );
  assert.equal(await logOf(doc, (l) => l.includes('raf')), 'raf:false:2');
  await held.release(HELD);
});

test('a parser-blocking script in the head holds frames and the first paint until it has run', async () => {
  const held = new Held();
  const doc = await hosted(
    '<html id="root"><head><script>' +
      NOTE +
      FRAME +
      '</script><script src="held.js"></script></head><body><p id="last">last</p></body></html>',
    { held, heldUrls: [HELD] },
  );
  await settle(100);
  assert.equal(doc.log(), '', 'no frame while the body is still to come');
  await held.release(HELD, "note('ran')");
  assert.equal(
    await logOf(doc, (l) => l.includes('raf')),
    'ran raf:true:2',
    doc.logs.join('\n'),
  );
});

test('an inline module with blocking=render holds frames until what it imports has run', async () => {
  const held = new Held();
  const url = 'https://example.test/dir/held.mjs';
  const doc = await hosted(
    '<html id="root"><head><script>' +
      NOTE +
      FRAME +
      '</script><script type="module" blocking="render">' +
      "import './held.mjs'; note('module');" +
      '</script></head><body><p id="last">last</p></body></html>',
    { held, heldUrls: [url] },
  );
  await settle(100);
  assert.equal(doc.log(), '', 'no frame while its import is on its way');
  await held.release(url, "note('imported')");
  assert.equal(
    await logOf(doc, (l) => l.includes('raf')),
    'imported module raf:true:2',
    doc.logs.join('\n'),
  );
});

test('a <style blocking=render> a script puts in hears its load, and holds frames until its import is in', async () => {
  const heldSheets = new Map<string, (r: ResourceResult | null) => void>([
    ['red.css', () => {}],
  ]);
  const doc = await hosted(
    '<html id="root"><head><script>' +
      NOTE +
      "var style = document.createElement('style'); style.blocking = 'render';" +
      ' style.textContent = "@import url(\'red.css\');";' +
      " style.onload = function () { note('load:' + getComputedStyle(document.getElementById('last')).color) };" +
      ' document.head.appendChild(style);' +
      FRAME +
      '</script></head><body><p id="last">last</p></body></html>',
    { heldSheets },
  );
  await settle(100);
  assert.equal(doc.log(), '', 'no frame while the import is on its way');
  await act(async () =>
    heldSheets.get('red.css')!({
      kind: 'stylesheet',
      text: '#last { color: rgb(255, 0, 0) }',
    }),
  );
  assert.equal(
    await logOf(doc, (l) => l.includes('raf')),
    'load:rgb(255, 0, 0) raf:true:2',
    doc.logs.join('\n'),
  );
});
