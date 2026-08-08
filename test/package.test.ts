// The exports map is the only interface an installed copy has. Tests here
// import through relative paths, so nothing else in the suite would notice
// it going wrong.
import { test } from 'node:test';
import assert from 'node:assert';

import { checkPackage } from '../scripts/check-package.js';

test('the package layout is publishable', () => {
  const errors = checkPackage();
  assert.deepStrictEqual(errors, []);
});

test('every subpath resolves through the exports map', async () => {
  // Node self-references a package by its own name when it has `exports`,
  // so this exercises the real resolution an app gets — the built `dist/`,
  // not a source file a relative path happened to reach.
  const barrel = await import('@react-x11/components');
  assert.strictEqual(typeof barrel.Sparkline, 'function');

  const sparkline = await import('@react-x11/components/sparkline');
  assert.strictEqual(sparkline.Sparkline, barrel.Sparkline);
});
