// What a run's numbers were measured with. A tree whose node_modules is
// behind its lockfile runs, and says nothing: a master measured on the ntk
// before a bump, beside a branch measured on the one after it, differs by the
// bump.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '../..');

/** The ntk installed, and the one the tree's lockfile names. */
export function ntkVersions(): { loaded: string; locked: string } {
  const version = (file: string) =>
    JSON.parse(readFileSync(file, 'utf8')) as {
      version: string;
      packages?: Record<string, { version: string }>;
    };
  // as react-x11 finds it, which is what draws
  const core = createRequire(import.meta.resolve('react-x11'));
  const loaded = version(core.resolve('ntk/package.json'));
  const lock = version(join(REPO, 'package-lock.json'));
  return {
    loaded: loaded.version,
    locked: lock.packages!['node_modules/ntk'].version,
  };
}

/**
 * Say which ntk a run loads, and stop where the lockfile names another. A run
 * of an ntk that is not the lockfile's on purpose names it in `WPT_NTK`.
 */
export function checkVersions(): void {
  const { loaded, locked } = ntkVersions();
  console.error(`ntk ${loaded}, package-lock.json ${locked}`);
  const wanted = process.env.WPT_NTK ?? locked;
  if (loaded === wanted) return;
  console.error(
    `expected ntk ${wanted}: run npm ci, or name this one in WPT_NTK`,
  );
  process.exit(3);
}
