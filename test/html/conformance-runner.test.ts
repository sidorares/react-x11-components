// The WPT runner for tests that run scripts (`scripts/conformance/testharness.tsx`),
// over a server of its own: what it makes of a page that never comes to rest.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** The faces the runner reads (`FONTS` there), without which it mounts
 *  nothing. */
const HAS_FONTS =
  existsSync('/usr/share/fonts/truetype/liberation') ||
  existsSync('/System/Library/Fonts/Supplemental/Arial.ttf');
const test = SCRIPTS_CONTAINED && HAS_FONTS ? nodeTest : nodeTest.skip;

interface Outcome {
  test: string;
  kind: string;
  status: string;
  message?: string;
}

/** The runner's outcomes of `pages`, by path, each as it is listed; what it
 *  had written, where it did not end within `ms`. */
async function run(
  pages: Record<string, string>,
  ms: number,
): Promise<Outcome[]> {
  const server = createServer((request, response) => {
    const body = pages[(request.url ?? '').slice(1)];
    response.writeHead(body === undefined ? 404 : 200, {
      'content-type': 'text/html',
    });
    response.end(body ?? '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'wpt-runner-'));
  const list = join(dir, 'list.txt');
  const out = join(dir, 'out.jsonl');
  writeFileSync(list, Object.keys(pages).join('\n'));
  const child = spawn(
    process.execPath,
    [
      '--max-old-space-size=1000',
      '--experimental-vm-modules',
      '--no-warnings',
      '--import',
      'tsx',
      join(ROOT, 'scripts/conformance/testharness.tsx'),
      list,
      out,
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: {
        ...process.env,
        REACT_X11_THREADED: '0',
        WPT_HTTP_PORT: String((server.address() as AddressInfo).port),
        WPT_ACT_MS: '500',
      },
    },
  );
  const stop = setTimeout(() => child.kill('SIGKILL'), ms);
  try {
    await new Promise((r) => child.on('exit', r));
    return existsSync(out)
      ? readFileSync(out, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Outcome)
      : [];
  } finally {
    clearTimeout(stop);
    server.close();
    server.closeAllConnections();
    rmSync(dir, { recursive: true, force: true });
  }
}

// `selectall-containing-textarea-and-subscript.html` of WPT's
// `editing/crashtests`: each `selectionchange` edits and so tells another,
// for as long as the page is shown, in a browser too.
const RESTLESS = `<!doctype html>
<script>
addEventListener('DOMContentLoaded', () => {
  document.designMode = 'on';
  document.onselectionchange = () => {
    document.execCommand('undo');
    document.execCommand('subscript');
    document.execCommand('delete');
  };
  document.execCommand('selectAll', false);
}, { once: true });
</script>
<body>
AAAA
<tt>
<style>
*::selection {
  background-origin: border-box, border-box;
}
</style>
</tt>
<textarea></textarea>
</body>`;

test('a page that changes in every task is shown, and leaves the pages after it their turn', async () => {
  const told = await run(
    {
      'restless.html': RESTLESS,
      'still.html': '<!doctype html><p>still</p>',
      'again.html': RESTLESS,
    },
    60000,
  );
  assert.deepEqual(
    told.map((o) => [o.test, o.kind, o.status]),
    [
      ['restless.html', 'crashtest', 'PASS'],
      ['still.html', 'crashtest', 'PASS'],
      ['again.html', 'crashtest', 'PASS'],
    ],
  );
});
