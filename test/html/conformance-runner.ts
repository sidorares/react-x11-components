// The WPT runner for tests that run scripts (`scripts/conformance/testharness.tsx`)
// over a server of its own, as a process: the tests a file names, and what
// the runner made of each.
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
/** Whether the runner runs here: where a page's scripts are run, and the
 *  faces it reads are (`FONTS` there), without which it mounts nothing. */
export const RUNNER_RUNS =
  SCRIPTS_CONTAINED &&
  (existsSync('/usr/share/fonts/truetype/liberation') ||
    existsSync('/System/Library/Fonts/Supplemental/Arial.ttf'));

export interface Outcome {
  test: string;
  kind: string;
  status: string;
  message?: string;
  subtests?: { name: string; status: string; message?: string | null }[];
}

/** The runner's outcomes of `tests`, which `pages` are served with, `env` in
 *  its environment; what it had written, where it did not end within `ms`. */
export async function runTests(
  tests: string[],
  pages: Record<string, string>,
  ms: number,
  env: Record<string, string> = {},
): Promise<Outcome[]> {
  const server = createServer((request, response) => {
    const body = pages[(request.url ?? '').slice(1)];
    response.writeHead(body === undefined ? 404 : 200, {
      'content-type': request.url?.endsWith('.js')
        ? 'text/javascript'
        : 'text/html',
    });
    response.end(body ?? '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'wpt-runner-'));
  const list = join(dir, 'list.txt');
  const out = join(dir, 'out.jsonl');
  writeFileSync(list, tests.join('\n'));
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
        ...env,
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
