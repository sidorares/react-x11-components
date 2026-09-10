// The exports map is the only interface an installed copy has. Tests here
// import through relative paths, so nothing else in the suite would notice
// it going wrong.
import { test } from 'node:test';
import assert from 'node:assert';

import { checkDependencies, checkPackage } from '../scripts/check-package.js';
import type { PackageJson } from '../scripts/check-package.js';

test('the package layout is publishable', () => {
  const errors = checkPackage();
  assert.deepStrictEqual(errors, []);
});

test('every subpath resolves through the exports map', async () => {
  // Node self-references a package by its own name when it has `exports`,
  // so this exercises the real resolution an app gets — the built `dist/`,
  // not a source file a relative path happened to reach.
  const barrel = await import('@react-x11/components');
  assert.strictEqual(typeof barrel.Calendar, 'function');

  const calendar = await import('@react-x11/components/calendar');
  assert.strictEqual(calendar.Calendar, barrel.Calendar);
});

// The dependency half, on manifests written out here: the real manifest
// passing says today's package.json is right, and these say the check would
// notice it going wrong.
const peers = { react: '^19.0.0', 'react-x11': '^2.9.1' };
const dev = { react: '^19.2.8', 'react-x11': '^2.9.1' };

test('the dependency check accepts peers and one react-x11 range', () => {
  assert.deepStrictEqual(
    checkDependencies({ peerDependencies: peers, devDependencies: dev }),
    [],
  );
});

test('the dependency check fails a react-x11 range moved on one side', () => {
  // PR #53's shape is the devDependency ahead; the peer ahead is as wrong
  const devAhead = checkDependencies({
    peerDependencies: peers,
    devDependencies: { ...dev, 'react-x11': '^2.10.0' },
  });
  const peerAhead = checkDependencies({
    peerDependencies: { ...peers, 'react-x11': '^2.10.0' },
    devDependencies: dev,
  });
  for (const errors of [devAhead, peerAhead]) {
    assert.strictEqual(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /\^2\.10\.0/);
  }
});

test('the dependency check fails react-x11 or React outside peerDependencies', () => {
  for (const name of ['react-x11', 'react'] as const) {
    for (const field of ['dependencies', 'optionalDependencies'] as const) {
      const pkg: PackageJson = {
        peerDependencies: peers,
        devDependencies: dev,
      };
      pkg[field] = { [name]: peers[name] };
      const errors = checkDependencies(pkg);
      assert.strictEqual(errors.length, 1, errors.join('\n'));
      assert.match(errors[0], new RegExp(`"${name}" is in ${field}`));
    }

    const without: Record<string, string> = { ...peers };
    delete without[name];
    const missing = checkDependencies({
      peerDependencies: without,
      devDependencies: dev,
    });
    assert.strictEqual(missing.length, 1, missing.join('\n'));
    assert.match(
      missing[0],
      new RegExp(`"${name}" is not in peerDependencies`),
    );
  }
});
