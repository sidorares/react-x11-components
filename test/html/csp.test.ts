// A document's Content Security Policy (CSP 3): the algorithms of
// `src/html/csp.ts`, pure, with no document — a policy parsed, a URL, a
// nonce, a hash and a string compiled matched — and then a page's policies
// enforced and reported where its scripts run (`scripts/csp-host.ts`,
// `scripts/csp-page.ts`): what it refuses is never run, applied or asked
// for, and is told as a `securitypolicyviolation` and a report.
import { afterEach, test, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectAllowed,
  directiveFor,
  effectiveDirective,
  evalMatches,
  inlineMatches,
  matchesSourceList,
  parseCsp,
  parsePolicyList,
  policiesOfHeaders,
  reportedUrl,
  requestMatches,
  upgradedUrl,
} from '../../src/html/csp.js';
import { createHash } from 'node:crypto';
import React from 'react';
import { act, cleanup, renderX11 } from 'react-x11/test';
import { Html, preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import type { FetchRequest } from '../../src/html/scripts/host.js';
import type { ResourceRequest } from '../../src/html/resources.js';

const SELF = 'https://example.test:8443/page.html';

test('a policy is its directives by `;`, names lower-cased, and the first of a name kept', () => {
  const policy = parseCsp(
    "  Connect-Src 'self'  https://a.test ; default-src 'none';connect-src *;;  ",
  );
  assert.deepEqual([...policy.keys()], ['connect-src', 'default-src']);
  assert.deepEqual(policy.get('connect-src'), ["'self'", 'https://a.test']);
});

test('a source list matches by the standard’s rules', () => {
  const cases: [string[], string, boolean][] = [
    [[], 'https://a.test/', false],
    [["'none'"], 'https://a.test/', false],
    [['*'], 'https://a.test:1/x', true],
    [['*'], 'data:,x', false],
    [["'self'"], 'https://example.test:8443/other', true],
    [["'self'"], 'https://example.test/other', false],
    [["'self'"], 'wss://example.test:8443/', true],
    [['https:'], 'https://anything.test/', true],
    [['http:'], 'https://upgraded.test/', true],
    [['https:'], 'http://downgraded.test/', false],
    [['https://a.test'], 'https://a.test/x', true],
    [['https://a.test'], 'https://a.test:444/x', false],
    [['https://a.test:443'], 'https://a.test/x', true],
    [['https://a.test:*'], 'https://a.test:11000/x', true],
    [['a.test:11000'], 'https://a.test:11000/x', true],
    [['a.test:11000'], 'http://a.test:11000/x', false],
    [['*.a.test'], 'https://b.a.test/', true],
    [['*.a.test'], 'https://a.test/', false],
    [['https://a.test/dir/'], 'https://a.test/dir/x', true],
    [['https://a.test/dir/'], 'https://a.test/other', false],
    [['https://a.test/file'], 'https://a.test/file', true],
    [['https://a.test/file'], 'https://a.test/file/more', false],
    [["'unsafe-inline'", "'nonce-x'"], 'https://a.test/', false],
  ];
  for (const [list, url, want] of cases) {
    assert.equal(
      matchesSourceList(list, url, SELF),
      want,
      `${list.join(' ')} vs ${url}`,
    );
  }
});

test('a connection is held to every policy’s connect-src, or its default-src where it has none', () => {
  const none = parseCsp("connect-src 'none'");
  const origin = parseCsp('connect-src https://wt.test:11000');
  const fallback = parseCsp("default-src 'self'; img-src *");
  const unrelated = parseCsp('img-src *');
  assert.equal(connectAllowed([], 'https://wt.test:11000/', SELF), true);
  assert.equal(connectAllowed([none], 'https://wt.test:11000/', SELF), false);
  assert.equal(connectAllowed([origin], 'https://wt.test:11000/', SELF), true);
  assert.equal(connectAllowed([origin], 'https://wt.test:11001/', SELF), false);
  assert.equal(
    connectAllowed([fallback], 'https://wt.test:11000/', SELF),
    false,
  );
  assert.equal(connectAllowed([fallback], SELF, SELF), true);
  assert.equal(connectAllowed([unrelated], 'https://wt.test/', SELF), true);
  // every policy has to allow it
  assert.equal(
    connectAllowed([origin, none], 'https://wt.test:11000/', SELF),
    false,
  );
});

// --- the policies a document holds, and what they hold to

const digest = (algorithm: string, text: string): string =>
  createHash(algorithm).update(text, 'utf8').digest('base64');

test('a header is a policy a comma, report-only ones reported, and a meta’s says nothing of reports', () => {
  const list = policiesOfHeaders([
    ['Content-Security-Policy', "script-src 'self', img-src 'none'"],
    ['content-security-policy-report-only', "style-src 'none'; report-uri /r"],
    ['x-other', 'script-src *'],
  ]);
  assert.deepEqual(
    list.map((p) => [p.disposition, p.text, [...p.directives.keys()]]),
    [
      ['enforce', "script-src 'self'", ['script-src']],
      ['enforce', "img-src 'none'", ['img-src']],
      [
        'report',
        "style-src 'none'; report-uri /r",
        ['style-src', 'report-uri'],
      ],
    ],
  );
  const meta = parsePolicyList(
    "img-src 'none'; report-uri /r; frame-ancestors 'none'; sandbox",
    'enforce',
    'meta',
  );
  assert.deepEqual([...meta[0].directives.keys()], ['img-src']);
  // a value outside the grammar takes its directive with it, and a name
  // stops at ASCII white space alone
  assert.deepEqual(
    [...parseCsp("img-src 'self' é; script-src 'none'; font-src a").keys()],
    ['font-src'],
  );
});

test('a request is held to its destination’s directive, or the first of its fallbacks a policy has', () => {
  assert.equal(effectiveDirective(''), 'connect-src');
  assert.equal(effectiveDirective('image'), 'img-src');
  assert.equal(effectiveDirective('script'), 'script-src-elem');
  assert.equal(effectiveDirective('worker'), 'worker-src');
  assert.equal(effectiveDirective('iframe'), 'frame-src');
  assert.equal(effectiveDirective('report'), null);
  const policy = parseCsp(
    "default-src 'none'; child-src a.test; script-src b.test",
  );
  assert.deepEqual(directiveFor(policy, 'worker-src'), ['a.test']);
  assert.deepEqual(directiveFor(policy, 'frame-src'), ['a.test']);
  assert.deepEqual(directiveFor(policy, 'script-src-elem'), ['b.test']);
  assert.deepEqual(directiveFor(policy, 'img-src'), ["'none'"]);
  assert.equal(directiveFor(parseCsp('img-src *'), 'font-src'), undefined);
});

test('a script is let through by its nonce, its integrity, or under strict-dynamic by not being the parser’s', () => {
  const nonce = ["'nonce-abc'"];
  const script = { url: 'https://x.test/a.js', destination: 'script' };
  assert.equal(
    requestMatches(nonce, { ...script, nonce: 'abc' }, script.url, SELF),
    true,
  );
  assert.equal(
    requestMatches(nonce, { ...script, nonce: 'abd' }, script.url, SELF),
    false,
  );
  const hash = digest('sha256', 'x');
  const sri = [`'sha256-${hash}'`];
  assert.equal(
    requestMatches(
      sri,
      { ...script, integrity: `sha256-${hash}` },
      script.url,
      SELF,
    ),
    true,
  );
  assert.equal(
    requestMatches(
      sri,
      {
        ...script,
        integrity: `sha256-${hash} sha384-${digest('sha384', 'x')}`,
      },
      script.url,
      SELF,
    ),
    false,
  );
  const dynamic = ["'strict-dynamic'", 'https://x.test'];
  assert.equal(
    requestMatches(
      dynamic,
      { ...script, parserInserted: true },
      script.url,
      SELF,
    ),
    false,
  );
  assert.equal(
    requestMatches(dynamic, script, 'https://elsewhere.test/', SELF),
    true,
  );
  // an image has no nonce to show
  assert.equal(
    requestMatches(
      nonce,
      { url: script.url, destination: 'image', nonce: 'abc' },
      script.url,
      SELF,
    ),
    false,
  );
  // a local scheme is none of the document's own
  assert.equal(
    matchesSourceList(["'self'"], 'blob:https://example.test:8443/1', SELF),
    false,
  );
});

test('inline content is let through by unsafe-inline only where nothing names a nonce or a hash', () => {
  const run = (
    list: string[],
    type: Parameters<typeof inlineMatches>[1],
    nonce = '',
  ) => inlineMatches(list, type, 'alert(1)', nonce, digest);
  const hash = `'sha256-${digest('sha256', 'alert(1)')}'`;
  assert.equal(run(["'unsafe-inline'"], 'script'), true);
  assert.equal(run(["'unsafe-inline'", "'nonce-a'"], 'script'), false);
  assert.equal(run(["'unsafe-inline'", "'nonce-a'"], 'script', 'a'), true);
  assert.equal(run(["'unsafe-inline'", "'strict-dynamic'"], 'script'), false);
  assert.equal(run(["'unsafe-inline'", "'strict-dynamic'"], 'style'), true);
  assert.equal(run([hash], 'script'), true);
  // an attribute shows no nonce, and its hash counts only under
  // 'unsafe-hashes'
  assert.equal(run(["'nonce-a'"], 'script attribute', 'a'), false);
  assert.equal(run([hash], 'script attribute'), false);
  assert.equal(run([hash, "'unsafe-hashes'"], 'script attribute'), true);
  assert.equal(evalMatches(["'self'"], false), false);
  assert.equal(evalMatches(["'unsafe-eval'"], false), true);
  assert.equal(evalMatches(["'wasm-unsafe-eval'"], false), false);
  assert.equal(evalMatches(["'wasm-unsafe-eval'"], true), true);
});

test('a report carries a URL with no fragment or credentials, or a local one’s scheme', () => {
  assert.equal(reportedUrl('https://u:p@a.test/x?y#z'), 'https://a.test/x?y');
  assert.equal(reportedUrl('data:image/png,abc'), 'data');
  assert.equal(reportedUrl('blob:https://a.test/1'), 'blob');
});

// --- a document's policies, enforced and reported

afterEach(cleanup);
await preloadHtmlScripts();
const scripted = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const PAGE_URL = 'https://example.test/page.html';

/** A page with headers and a head of its own, its logs, the requests its
 *  network was asked to make, and the images it was asked for. */
async function policed(
  head: string,
  body: string,
  headers: [string, string][] = [],
): Promise<{
  logs: string[];
  sent: FetchRequest[];
  asked: string[];
  requests: ResourceRequest[];
  until(prefix: string): Promise<string>;
  unmount(): void;
}> {
  const logs: string[] = [];
  const sent: FetchRequest[] = [];
  const asked: string[] = [];
  const requests: ResourceRequest[] = [];
  const result = await renderX11(
    React.createElement(Html, {
      source: `<!doctype html><html><head>${head}</head><body>${body}</body></html>`,
      partial: false,
      baseUrl: PAGE_URL,
      onResource: (request: ResourceRequest) => {
        asked.push(request.url);
        requests.push(request);
        return null;
      },
      scripts: {
        headers,
        log: (level: string, text: string) =>
          void logs.push(`${level}: ${text}`),
        fetch: async (request: FetchRequest) => {
          sent.push(request);
          return {
            url: request.url,
            status: 204,
            statusText: 'No Content',
            redirected: false,
            headers: [],
            body: '',
          };
        },
      },
    }),
    { backend: 'mock' },
  );
  return {
    logs,
    sent,
    asked,
    requests,
    async until(prefix) {
      const end = Date.now() + 5000;
      const found = () => logs.find((l) => l.startsWith(`log: ${prefix}`));
      while (!found() && Date.now() < end) {
        await act(() => new Promise((r) => setTimeout(r, 10)));
      }
      const line = found();
      assert.ok(line, `no "${prefix}" in:\n${logs.join('\n')}`);
      return line.slice(`log: ${prefix}`.length).trim();
    },
    unmount: () => result.unmount(),
  };
}

/** What a listener on the document is told of each violation. */
const LISTEN = `<script nonce="n">
  window.seen = [];
  document.addEventListener('securitypolicyviolation', function (e) {
    seen.push([e.blockedURI, e.effectiveDirective, e.violatedDirective,
      e.disposition, e.target === document ? 'document' : e.target.tagName,
      e.isTrusted, e.bubbles, e.composed, e.sample, e.originalPolicy]);
  });
</script>`;

scripted(
  'an inline script without the nonce does not run, and its violation is told at it',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-n' 'report-sample'">${LISTEN}`,
      `<script>console.log('ran plain')</script>
     <script nonce="n">console.log('ran nonced')</script>
     <script nonce="n">setTimeout(function () {
       console.log('seen ' + JSON.stringify(seen));
     }, 50)</script>`,
    );
    const seen = JSON.parse(await page.until('seen'));
    assert.ok(page.logs.includes('log: ran nonced'));
    assert.ok(!page.logs.includes('log: ran plain'));
    assert.deepEqual(seen, [
      [
        'inline',
        'script-src-elem',
        'script-src-elem',
        'enforce',
        'SCRIPT',
        true,
        true,
        true,
        "console.log('ran plain')",
        "script-src 'nonce-n' 'report-sample'",
      ],
    ]);
    page.unmount();
  },
);

scripted(
  'a policy reported only refuses nothing, and is reported to its report-uri',
  async () => {
    const page = await policed(
      LISTEN,
      `<script>console.log('ran plain')</script>
     <script nonce="n">setTimeout(function () {
       console.log('seen ' + JSON.stringify(seen.map(function (s) { return s[3]; })));
     }, 50)</script>`,
      [
        [
          'Content-Security-Policy-Report-Only',
          "script-src 'nonce-n'; report-uri /csp-report",
        ],
      ],
    );
    assert.deepEqual(JSON.parse(await page.until('seen')), ['report']);
    assert.ok(page.logs.includes('log: ran plain'));
    const report = page.sent.find(
      (r) => r.url === 'https://example.test/csp-report',
    );
    assert.ok(report, 'no report sent');
    assert.equal(report.method, 'POST');
    assert.deepEqual(report.headers, [
      ['content-type', 'application/csp-report'],
    ]);
    const body = JSON.parse(String(report.body))['csp-report'];
    assert.equal(body['document-uri'], PAGE_URL);
    assert.equal(body['blocked-uri'], 'inline');
    assert.equal(body['effective-directive'], 'script-src-elem');
    assert.equal(body.disposition, 'report');
    page.unmount();
  },
);

scripted(
  'a string compiled where no policy allows unsafe-eval throws an EvalError, and a direct eval is direct with no policy',
  async () => {
    const free = await policed(
      '',
      `<script>(function () { var local = 7;
      console.log('direct ' + eval('local')); })()</script>`,
    );
    assert.equal(await free.until('direct'), '7');
    free.unmount();
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-n'">${LISTEN}`,
      `<script nonce="n">
      var out = [];
      try { eval('1'); out.push('ran'); } catch (e) { out.push(e instanceof EvalError); }
      try { new Function('return 1'); out.push('ran'); } catch (e) { out.push(e instanceof EvalError); }
      try { (function () {}).constructor('return 1'); out.push('ran'); } catch (e) { out.push(e instanceof EvalError); }
      out.push(eval(5));
      setTimeout(function () {
        console.log('out ' + JSON.stringify([out, seen.map(function (s) { return s[0] + ' ' + s[1]; })]));
      }, 50);
    </script>`,
    );
    assert.deepEqual(JSON.parse(await page.until('out')), [
      [true, true, true, 5],
      ['eval script-src', 'eval script-src', 'eval script-src'],
    ]);
    page.unmount();
  },
);

scripted(
  'a redirect a policy refuses is refused before its request is sent, and told by the URL first asked for',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="img-src 'self'; script-src 'self' 'nonce-n'">${LISTEN}`,
      `<img id="i" src="https://example.test/a.png">
     <script src="https://example.test/s.js"></script>
     <script nonce="n">setTimeout(function () {
       console.log('seen ' + JSON.stringify(seen.map(function (s) { return [s[0], s[1]]; })));
     }, 500)</script>`,
    );
    const end = Date.now() + 5000;
    while (page.requests.length < 2 && Date.now() < end) {
      await act(() => new Promise((r) => setTimeout(r, 10)));
    }
    const image = page.requests.find((r) => r.kind === 'image');
    const script = page.requests.find((r) => r.kind === 'script');
    assert.ok(image?.nextHop && script?.nextHop, 'asked with nextHop');
    // a hop of its own origin goes on, and one of another is refused
    assert.equal(
      image.nextHop('https://example.test/b.png'),
      'https://example.test/b.png',
    );
    assert.equal(image.nextHop('https://other.test/b.png'), null);
    assert.equal(script.nextHop('https://other.test/s.js'), null);
    // what is told is the URL first asked for, not where it was sent
    assert.deepEqual(JSON.parse(await page.until('seen')), [
      ['https://example.test/a.png', 'img-src'],
      ['https://example.test/s.js', 'script-src-elem'],
    ]);
    page.unmount();
  },
);

scripted(
  'a fetch connect-src refuses is a TypeError, and is never sent',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="connect-src 'self'">${LISTEN}`,
      `<script nonce="n">
      fetch('https://other.test/x').then(function () { console.log('done fetched'); },
        function (e) { console.log('done ' + e.name); });
      setTimeout(function () {
        console.log('seen ' + JSON.stringify(seen.map(function (s) { return [s[0], s[1]]; })));
      }, 100);
    </script>`,
    );
    assert.equal(await page.until('done'), 'TypeError');
    assert.deepEqual(JSON.parse(await page.until('seen')), [
      ['https://other.test/x', 'connect-src'],
    ]);
    assert.ok(!page.sent.some((r) => r.url.startsWith('https://other.test')));
    page.unmount();
  },
);

scripted(
  'an on… attribute is compiled only where script-src-attr lets it',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-n'">${LISTEN}`,
      `<div id="d" onclick="console.log('clicked')"></div>
     <script nonce="n">
      document.getElementById('d').click();
      setTimeout(function () {
        console.log('seen ' + JSON.stringify(seen.map(function (s) { return [s[0], s[1], s[4]]; })));
      }, 50);
    </script>`,
    );
    assert.deepEqual(JSON.parse(await page.until('seen')), [
      ['inline', 'script-src-attr', 'DIV'],
    ]);
    assert.ok(!page.logs.includes('log: clicked'));
    page.unmount();
  },
);

scripted(
  'SecurityPolicyViolationEvent is constructed from its dictionary',
  async () => {
    const page = await policed(
      '',
      `<script>
      var e = new SecurityPolicyViolationEvent('securitypolicyviolation', {
        violatedDirective: 'img-src', statusCode: 200, lineNumber: 3 });
      var threw = false;
      try { new SecurityPolicyViolationEvent('x', { disposition: 'nope' }); } catch (x) { threw = x instanceof TypeError; }
      console.log('out ' + JSON.stringify([e.violatedDirective, e.effectiveDirective,
        e.disposition, e.statusCode, e.lineNumber, e instanceof Event, threw]));
    </script>`,
    );
    assert.deepEqual(JSON.parse(await page.until('out')), [
      'img-src',
      '',
      'enforce',
      200,
      3,
      true,
      true,
    ]);
    page.unmount();
  },
);

scripted(
  'a <style> and a style attribute are held to style-src, and what CSSOM writes is not',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="style-src 'nonce-s'; script-src 'nonce-n'">${LISTEN}
     <style>#a { color: rgb(255, 0, 0); }</style>
     <style nonce="s">#b { color: rgb(0, 128, 0); }</style>`,
      `<p id="a">a</p><p id="b">b</p><p id="c" style="color: rgb(0, 0, 255)">c</p><p id="d">d</p>
     <script nonce="n">
      var d = document.getElementById('d');
      d.style.color = 'rgb(1, 2, 3)';
      setTimeout(function () {
        var c = function (id) { return getComputedStyle(document.getElementById(id)).color; };
        console.log('out ' + JSON.stringify([c('a'), c('b'), c('c'), c('d'),
          seen.map(function (s) { return s[1] + ' ' + s[4]; })]));
      }, 100);
    </script>`,
    );
    const [a, b, c, d, seen] = JSON.parse(await page.until('out'));
    assert.notEqual(a, 'rgb(255, 0, 0)');
    assert.equal(b, 'rgb(0, 128, 0)');
    assert.notEqual(c, 'rgb(0, 0, 255)');
    assert.equal(d, 'rgb(1, 2, 3)');
    assert.deepEqual(seen.sort(), ['style-src-attr P', 'style-src-elem STYLE']);
    page.unmount();
  },
);

scripted(
  'a worker worker-src refuses hears error and starts no thread, and a refused <base> is no base',
  async () => {
    const page = await policed(
      `${LISTEN}<meta http-equiv="Content-Security-Policy" content="worker-src 'none'; base-uri 'self'">
     <base href="https://elsewhere.test/dir/">`,
      `<script nonce="n">
      var w = new Worker('https://example.test/w.js');
      w.onerror = function () { console.log('worker error'); };
      setTimeout(function () {
        console.log('out ' + JSON.stringify([document.baseURI,
          seen.map(function (s) { return s[0] + ' ' + s[1]; }).sort()]));
      }, 100);
    </script>`,
    );
    await page.until('worker error');
    assert.deepEqual(JSON.parse(await page.until('out')), [
      PAGE_URL,
      [
        'https://elsewhere.test/dir/ base-uri',
        'https://example.test/w.js worker-src',
      ],
    ]);
    assert.ok(!page.sent.some((r) => r.url === 'https://example.test/w.js'));
    page.unmount();
  },
);

scripted(
  'a header’s policy hides a nonce from its attribute and keeps it for itself',
  async () => {
    const page = await policed(
      '',
      `<script nonce="n" id="s">
      var s = document.getElementById('s');
      var copy = s.cloneNode(true);
      var made = document.createElement('script');
      made.nonce = 'n';
      made.textContent = "console.log('made ran')";
      document.body.appendChild(made);
      setTimeout(function () {
        console.log('out ' + JSON.stringify([s.getAttribute('nonce'), s.nonce,
          copy.getAttribute('nonce'), copy.nonce]));
      }, 50);
    </script>`,
      [['Content-Security-Policy', "script-src 'nonce-n'"]],
    );
    assert.deepEqual(JSON.parse(await page.until('out')), ['', 'n', '', 'n']);
    await page.until('made ran');
    page.unmount();
  },
);

scripted(
  'a nonced script the parser made in a body under a header’s policy runs, and so does cssText',
  async () => {
    // the body and the script in it are both what the parser made: the
    // script is met twice as nonces are hidden, and keeps its nonce once
    const page = await policed(
      '',
      `<div><script nonce="n">
      var p = document.createElement('p');
      document.body.appendChild(p);
      p.style.cssText = 'width: 7px';
      setTimeout(function () {
        console.log('out ' + getComputedStyle(p).width);
      }, 50);
    </script></div>`,
      [['Content-Security-Policy', "script-src 'nonce-n'; style-src 'self'"]],
    );
    assert.equal(await page.until('out'), '7px');
    page.unmount();
  },
);

scripted(
  'a javascript: URL the document sends itself to runs by its hash under unsafe-hashes',
  async () => {
    const url = "javascript:console.log('went', '*')";
    const hash = digest('sha256', url);
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-hashes' 'nonce-n' 'sha256-${hash}'">`,
      `<span id="e">${url}</span>
     <script nonce="n">location.href = document.getElementById('e').textContent;</script>`,
    );
    assert.equal(await page.until('went'), '*');
    page.unmount();
  },
);

scripted(
  'a string timer a policy refuses is never set, and its handle is 0',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-n'">`,
      `<script nonce="n">
      var errors = 0;
      addEventListener('error', function () { errors += 1; });
      var ids = [setTimeout("console.log('ran')", 0), setInterval("console.log('ran')", 0)];
      setTimeout(function () { console.log('out ' + ids.join(',') + ' ' + errors); }, 50);
    </script>`,
    );
    assert.equal(await page.until('out'), '0,0 0');
    assert.ok(!page.logs.includes('log: ran'));
    page.unmount();
  },
);

scripted(
  'a violation says where in the document it was caused: the running script’s frame, else what it is about',
  async () => {
    const head = `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-n'">
<script nonce="n">
  window.seen = [];
  document.addEventListener('securitypolicyviolation', function (e) {
    seen.push([e.blockedURI, e.sourceFile, e.lineNumber, e.columnNumber]);
  });
</script>`;
    const body = `
<script nonce="n">
  try {
    eval('1');
  } catch (e) {}
</script>
<script id="blocked">console.log('ran');</script>
<script nonce="n">setTimeout(function () {
  console.log('seen ' + JSON.stringify(seen));
}, 100)</script>`;
    const page = await policed(head, body);
    // as the document's lines are numbered, and its columns from 1
    const source = `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
    const place = (index: number): [number, number] => {
      const before = source.slice(0, index).split('\n');
      return [before.length, before.at(-1)!.length + 1];
    };
    const evalAt = place(source.indexOf("eval('1')"));
    const blockedAt = place(
      source.indexOf('<script id="blocked">') + '<script id="blocked">'.length,
    );
    assert.deepEqual(JSON.parse(await page.until('seen')), [
      ['eval', PAGE_URL, ...evalAt],
      ['inline', PAGE_URL, ...blockedAt],
    ]);
    assert.ok(!page.logs.includes('log: ran'));
    page.unmount();
  },
);

scripted(
  'a violation event’s attributes are read off the event alone, and it says what it is',
  async () => {
    const page = await policed(
      '',
      `<script>
      var e = new SecurityPolicyViolationEvent('securitypolicyviolation', { lineNumber: 3 });
      var threw;
      try { SecurityPolicyViolationEvent.prototype.lineNumber; } catch (x) { threw = x.name; }
      console.log('out ' + [e.lineNumber, threw, Object.prototype.toString.call(e),
        Object.getOwnPropertyDescriptor(SecurityPolicyViolationEvent.prototype, 'lineNumber').get.name].join('|'));
    </script>`,
    );
    assert.equal(
      await page.until('out'),
      '3|TypeError|[object SecurityPolicyViolationEvent]|get lineNumber',
    );
    page.unmount();
  },
);

scripted(
  'a <script src> the parser met and a policy refuses is reported by its URL, at no place in the document',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-n'">
<script nonce="n">
  document.addEventListener('securitypolicyviolation', function (e) {
    console.log('out ' + [e.blockedURI, e.lineNumber, e.columnNumber].join('|'));
  });
</script>`,
      `<script src="https://example.test/blocked.js"></script>`,
    );
    assert.equal(
      await page.until('out'),
      'https://example.test/blocked.js|0|0',
    );
    page.unmount();
  },
);

scripted(
  'an image a policy refuses is never asked for, its element hears error, and the violation is told at the document',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="img-src 'none'">${LISTEN}`,
      `<img id="i" src="https://example.test/a.png" onerror="console.log('error')">
     <script nonce="n">setTimeout(function () {
       console.log('seen ' + JSON.stringify(seen.map(function (s) { return [s[0], s[1], s[4]]; })));
     }, 100)</script>`,
    );
    assert.deepEqual(JSON.parse(await page.until('seen')), [
      ['https://example.test/a.png', 'img-src', 'document'],
    ]);
    await page.until('error');
    assert.ok(!page.asked.includes('https://example.test/a.png'));
    page.unmount();
  },
);

scripted(
  'a frame another origin’s policy refuses is told by that origin alone, where an image is told by its URL',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="frame-src 'none'; img-src 'none'">${LISTEN}`,
      `<iframe src="https://other.test/path/frame.html?q"></iframe>
     <img src="https://other.test/path/a.png">
     <script nonce="n">setTimeout(function () {
       console.log('seen ' + JSON.stringify(seen.map(function (s) { return [s[0], s[1]]; }).sort()));
     }, 100)</script>`,
    );
    assert.deepEqual(JSON.parse(await page.until('seen')), [
      ['https://other.test', 'frame-src'],
      ['https://other.test/path/a.png', 'img-src'],
    ]);
    page.unmount();
  },
);

test('an insecure URL is upgraded to its secure scheme, port 80 to 443 and any other as it was', () => {
  assert.equal(upgradedUrl('http://a.test/x?y#z'), 'https://a.test/x?y#z');
  assert.equal(upgradedUrl('http://a.test:80/'), 'https://a.test/');
  assert.equal(upgradedUrl('http://a.test:8080/'), 'https://a.test:8080/');
  assert.equal(upgradedUrl('ws://a.test/s'), 'wss://a.test/s');
  for (const same of [
    'https://a.test/',
    'wss://a.test/',
    'data:,x',
    'blob:x',
  ]) {
    assert.equal(upgradedUrl(same), same);
  }
});

scripted(
  'upgrade-insecure-requests sends a document’s insecure requests securely, and a report-only policy does not',
  async () => {
    for (const [header, upgraded] of [
      ['Content-Security-Policy', true],
      ['Content-Security-Policy-Report-Only', false],
    ] as const) {
      const page = await policed(
        '',
        `<img src="http://example.test/a.png">
       <script>
         fetch('http://example.test/f').then(function () { console.log('done'); },
           function () { console.log('done'); });
       </script>`,
        [[header, 'upgrade-insecure-requests']],
      );
      await page.until('done');
      const scheme = upgraded ? 'https' : 'http';
      // not upgraded, the fetch is sent as it was, or refused as mixed
      // content from this secure page: never over https
      assert.equal(
        page.sent.some((r) => r.url === 'https://example.test/f'),
        upgraded,
        page.sent.map((r) => r.url).join(' '),
      );
      assert.ok(
        page.asked.includes(`${scheme}://example.test/a.png`),
        page.asked.join(' '),
      );
      page.unmount();
    }
  },
);
