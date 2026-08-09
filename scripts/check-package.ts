#!/usr/bin/env tsx
// What the build step does not check.
//
// `tsc` now stands between `src/` and what ships, so it catches the things a
// compiler catches. It has no opinion at all about the exports map: that
// every subpath resolves to a file that is actually in the tarball, that
// every component has a subpath of its own, and that the tree-shaking
// contract (`sideEffects: false`) is still declared.
//
// A broken exports map is the classic component-library bug: it passes every
// test in the repo, because the repo's own tests import through relative
// paths, and fails for the first person who installs the package.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

/** One entry in the exports map: a path, or conditions nesting more of them. */
type ExportsEntry = string | { [condition: string]: ExportsEntry };

interface PackageJson {
  files?: string[];
  sideEffects?: boolean;
  types?: string;
  exports?: Record<string, ExportsEntry>;
}

/** Every file an exports entry points at, whatever the condition. */
function targetsOf(entry: ExportsEntry, out: string[] = []): string[] {
  if (typeof entry === 'string') out.push(entry);
  else if (entry && typeof entry === 'object') {
    for (const value of Object.values(entry)) targetsOf(value, out);
  }
  return out;
}

/**
 * Directories under `src/` that look like a component — one with an index.
 * The source tree is the manifest even though the source tree is not what
 * ships: a component exists because someone wrote it, and the point of the
 * check below is to catch the one that was written and never exported.
 */
function componentDirs(root: string): string[] {
  const src = path.join(root, 'src');
  return readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(src, name, 'index.ts')))
    .sort();
}

export function checkPackage(root: string = ROOT): string[] {
  const pkg: PackageJson = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  const errors: string[] = [];

  // Everything below reads the built tree, so say so plainly rather than
  // reporting every subpath as missing.
  if (!existsSync(path.join(root, 'dist'))) {
    errors.push('dist/ is missing — run `npm run build` first.');
    return errors;
  }

  if (pkg.sideEffects !== false) {
    errors.push(
      '"sideEffects": false is missing. Without it a bundler must assume ' +
        'every module in the package does something at import time, and no ' +
        'component tree-shakes.',
    );
  }

  if (!Array.isArray(pkg.files) || !pkg.files.includes('dist')) {
    errors.push('"files" must include "dist" — that is what ships.');
  }

  // `declarationMap` points into the TypeScript, so the TypeScript has to be
  // there. Without it "go to definition" in a consumer's editor lands on a
  // file that was never published.
  if (!Array.isArray(pkg.files) || !pkg.files.includes('src')) {
    errors.push(
      '"files" must include "src" — the declaration maps in dist/ reference ' +
        'it, and a consumer\'s "go to definition" follows them.',
    );
  }

  if (pkg.types && !existsSync(path.join(root, pkg.types))) {
    errors.push(`"types" -> ${pkg.types} does not exist`);
  }

  for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
    for (const target of targetsOf(entry)) {
      if (!target.startsWith('./')) {
        errors.push(
          `exports["${subpath}"] -> ${target} is not a relative path`,
        );
        continue;
      }
      if (!existsSync(path.join(root, target))) {
        errors.push(`exports["${subpath}"] -> ${target} does not exist`);
      }
      // `files` ships whole directories, so membership is a prefix test
      const shipped = (pkg.files ?? []).some(
        (f) => target === `./${f}` || target.startsWith(`./${f}/`),
      );
      if (!shipped && subpath !== './package.json') {
        errors.push(
          `exports["${subpath}"] -> ${target} is outside "files" and would ` +
            'be missing from the published tarball',
        );
      }
    }
  }

  // Every component gets its own entry point. This is what lets an app pay
  // for one component without a bundler, and what keeps the barrel optional.
  for (const name of componentDirs(root)) {
    const subpath = `./${name}`;
    if (!pkg.exports?.[subpath]) {
      errors.push(
        `src/${name}/ has no "${subpath}" entry in exports — every component ` +
          'is importable on its own (AGENTS.md, "One directory per component")',
      );
    }
  }

  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const errors = checkPackage();
  for (const error of errors) console.error(`✗ ${error}`);
  if (errors.length > 0) process.exit(1);
  console.log('package layout ok');
}
