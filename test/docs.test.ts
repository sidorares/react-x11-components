// Documentation is a contract this package makes, so it is a test rather
// than an intention — the same reasoning as `treeshake.test.ts`.
//
// `docs/components/` is one page per `src/<name>/`, and the documentation
// site renders that directory verbatim. Both halves are checked: a component
// added without a page, and a page left behind by a component that was
// removed. The second is the one that rots quietly — a deleted component
// leaves a page that still describes props nothing has, and the site keeps
// serving it.
import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const SRC = path.join(ROOT, 'src');
const DOCS = path.join(ROOT, 'docs', 'components');

/** Every directory under `src/` with an index — the same manifest
 *  `scripts/check-package.ts` derives the exports map from. */
function componentDirs(): string[] {
  return readdirSync(SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(SRC, name, 'index.ts')))
    .sort();
}

function docPages(): string[] {
  return readdirSync(DOCS)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort();
}

test('every component has a page in docs/components/', () => {
  const missing = componentDirs().filter(
    (name) => !existsSync(path.join(DOCS, `${name}.md`)),
  );
  assert.deepStrictEqual(
    missing,
    [],
    `no docs/components/<name>.md for: ${missing.join(', ')}. ` +
      'AGENTS.md, "Documentation is part of adding a component".',
  );
});

test('every page in docs/components/ has a component', () => {
  const components = new Set(componentDirs());
  const orphans = docPages().filter((name) => !components.has(name));
  assert.deepStrictEqual(
    orphans,
    [],
    `docs/components/ has pages with no src/ directory: ${orphans.join(', ')}`,
  );
});

test('the docs index links every page', () => {
  const index = readFileSync(path.join(ROOT, 'docs', 'README.md'), 'utf8');
  const unlinked = docPages().filter(
    (name) => !index.includes(`components/${name}.md`),
  );
  assert.deepStrictEqual(
    unlinked,
    [],
    `docs/README.md does not link: ${unlinked.join(', ')}`,
  );
});

test('each page opens with a heading, which is what titles it on the site', () => {
  // `website/scripts/sync-docs.mjs` reads the first `# heading` as the page
  // title. Without one the page is titled after its filename, which is how a
  // sidebar ends up saying "tray-host".
  for (const name of docPages()) {
    const text = readFileSync(path.join(DOCS, `${name}.md`), 'utf8');
    assert.match(
      text,
      /^#\s+\S/m,
      `docs/components/${name}.md has no "# Heading"`,
    );
  }
});
