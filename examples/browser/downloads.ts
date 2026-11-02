// Saving what a page asked to have saved: where it goes, and writing it.
//
// **Where a file goes is the user's to say, every time.** A server's name is
// only ever a suggestion, cleaned (`safeFilename`) before it is shown, and the
// path written to is the one the save dialog answered, so nothing a server
// says can choose a folder or a file to replace. Nothing is read of the
// response or written to a disk until then, and a dialog dismissed leaves no
// trace.
//
// A download is written by the tab's own process, which has the page's cookies
// and is already reading the response, and is reported to the browser, which
// draws its shelf. A tab closed with one under way ends it with the process,
// and the browser says so: the `.part` file is left, as a browser's would be.
import { randomUUID } from 'node:crypto';
import { rename, unlink, open } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, parse } from 'node:path';

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

/** Where the save dialog opens: `BROWSER_DOWNLOADS_DIR`, for a run that wants
 *  it somewhere of its own, or the user's own Downloads. */
export function downloadsDir(): string {
  const dir = process.env.BROWSER_DOWNLOADS_DIR ?? join(homedir(), 'Downloads');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A name in `dir` nothing has: `name`, then `name (1)` and on, as a browser
 * numbers them. It is what the save dialog starts on, so that accepting it
 * replaces nothing: the desktop's dialogs ask before they hand back a file
 * that is there, and core's built-in one does not.
 */
export function freeName(dir: string, name: string): string {
  const { name: stem, ext } = parse(name);
  for (let n = 0; ; n += 1) {
    const free = n ? `${stem} (${n})${ext}` : name;
    if (!existsSync(join(dir, free))) return free;
  }
}

/** How often a download under way is reported, in milliseconds. */
const REPORT_MS = 150;

/**
 * Write a download to the path the user chose, reporting as it goes. A part
 * file holds it until it has all arrived, so nothing half written goes by its
 * name, and a file the user chose to replace stays as it was until there is
 * all of what replaces it. The part file's own name is ours: `wx` makes it, or
 * fails, so it follows no link something left there.
 */
export async function saveDownload(
  id: string,
  source: HtmlDownloadSource,
  path: string,
  signal: AbortSignal,
  report: (state: DownloadState) => void,
): Promise<void> {
  const part = join(dirname(path), `download-${randomUUID()}.part`);
  const state: DownloadState = {
    id,
    name: basename(path),
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
