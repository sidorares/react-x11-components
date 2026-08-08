#!/usr/bin/env node
// The build step this package does not have.
//
// Nothing here is compiled — `src/` is what ships — so the things a build
// would have caught are checked directly instead: that every subpath in the
// exports map resolves to a file that is actually in the tarball, that every
// component has a subpath of its own, and that the tree-shaking contract
// (`sideEffects: false`) is still declared.
//
// A broken exports map is the classic component-library bug: it passes every
// test in the repo, because the repo's own tests import through relative
// paths, and fails for the first person who installs the package.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

/** Every file an exports entry points at, whatever the condition. */
function targetsOf(entry, out = []) {
  if (typeof entry === 'string') out.push(entry);
  else if (entry && typeof entry === 'object') {
    for (const value of Object.values(entry)) targetsOf(value, out);
  }
  return out;
}

/** Directories under src/ that look like a component — one with an index. */
function componentDirs(root) {
  const src = path.join(root, 'src');
  return readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(src, name, 'index.js')))
    .sort();
}

export function checkPackage(root = ROOT) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const errors = [];

  if (pkg.sideEffects !== false) {
    errors.push(
      '"sideEffects": false is missing. Without it a bundler must assume ' +
        'every module in the package does something at import time, and no ' +
        'component tree-shakes.',
    );
  }

  if (!Array.isArray(pkg.files) || !pkg.files.includes('src')) {
    errors.push('"files" must include "src" — that is what ships.');
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
