// Saving what a page asked to have saved: where it goes, and writing it.
//
// A download is written by the tab's own process, which has the page's cookies
// and is already reading the response, and is reported to the browser, which
// draws its shelf. A tab closed with one under way ends it with the process,
// and the browser says so: the `.part` file is left, as a browser's would be.
import { rename, unlink, open } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse } from 'node:path';

import type { HtmlDownloadSource } from '../../src/html/index.js';

/** What the browser hears of a download, as it goes. */
export interface DownloadState {
  id: string;
  name: string;
  /** Where it was saved, once it has been. */
  path: string | null;
  received: number;
  size: number | null;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  error?: string;
}

/** Where downloads go: `BROWSER_DOWNLOADS_DIR`, for a run that wants them
 *  somewhere of its own, or the user's own. */
export function downloadsDir(): string {
  const dir = process.env.BROWSER_DOWNLOADS_DIR ?? join(homedir(), 'Downloads');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A path in `dir` nothing is at: `name`, then `name (1)` and on, as a browser
 *  numbers them. */
export function freePath(dir: string, name: string): string {
  const { name: stem, ext } = parse(name);
  for (let n = 0; ; n += 1) {
    const path = join(dir, n ? `${stem} (${n})${ext}` : name);
    if (!existsSync(path) && !existsSync(`${path}.part`)) return path;
  }
}

/** How often a download under way is reported, in milliseconds. */
const REPORT_MS = 150;

/** Write a download, reporting as it goes. A part file holds it until it has
 *  all arrived, so nothing half written goes by its name. */
export async function saveDownload(
  id: string,
  source: HtmlDownloadSource,
  signal: AbortSignal,
  report: (state: DownloadState) => void,
): Promise<void> {
  const path = freePath(downloadsDir(), source.filename);
  const part = `${path}.part`;
  const state: DownloadState = {
    id,
    name: parse(path).base,
    path: null,
    received: 0,
    size: source.size,
    state: 'running',
  };
  report({ ...state });
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(part, 'wx');
    let told = Date.now();
    for await (const chunk of source.body) {
      if (signal.aborted) throw signal.reason;
      await file.write(chunk);
      state.received += chunk.length;
      if (Date.now() - told >= REPORT_MS) {
        told = Date.now();
        report({ ...state });
      }
    }
    await file.close();
    file = null;
    await rename(part, path);
    report({ ...state, path, state: 'done' });
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(part).catch(() => {});
    report({
      ...state,
      state: signal.aborted ? 'cancelled' : 'failed',
      error: String((error as Error)?.message ?? error),
    });
  }
}
