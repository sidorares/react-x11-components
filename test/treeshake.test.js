// Tree-shaking is a contract this package makes, so it is a test rather
// than an intention. Two things are asserted, and the first is the one that
// actually breaks:
//
//  1. Importing the barrel for *no* exports leaves nothing behind. This is
//     what fails the moment a module does work at import time — a
//     registration hoisted into `src/index.js`, a theme installed eagerly,
//     a feature probe — and it fails long before anyone notices their app
//     grew.
//  2. Naming one component does not drag in the others.
//
// The second is trivially true while there is one component and becomes a
// real guard the moment a second lands, which is why it is written as a
// loop over the manifest rather than a pair of hand-written assertions.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

/** Export name -> a string only that component's modules contain. Element
 * names make good markers: they survive minification because they are data. */
const COMPONENTS = [{ exportName: 'Sparkline', marker: 'sparkline' }];

async function bundle(contents) {
  const result = await esbuild.build({
    stdin: { contents, resolveDir: ROOT, sourcefile: 'entry.js', loader: 'js' },
    bundle: true,
    format: 'esm',
    write: false,
    minify: true,
    treeShaking: true,
    // peers: an app already has these, and what is under test is our code
    external: ['react', 'react-x11', 'react-x11/*'],
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

test('the barrel has no side effects to keep', async () => {
  const out = await bundle("import './src/index.js';\n");
  assert.strictEqual(
    out.trim(),
    '',
    'importing the package for nothing should leave nothing behind:\n' + out,
  );
});

test('naming one component does not pull in the others', async () => {
  for (const { exportName, marker } of COMPONENTS) {
    const out = await bundle(
      `import { ${exportName} } from './src/index.js';\n` +
        `globalThis.__keep = ${exportName};\n`,
    );
    assert.ok(
      out.includes(marker),
      `${exportName} should survive its own import, marker "${marker}" not found`,
    );
    for (const other of COMPONENTS) {
      if (other.exportName === exportName) continue;
      assert.ok(
        !out.includes(other.marker),
        `importing ${exportName} dragged in ${other.exportName}`,
      );
    }
  }
});

test('each component is also importable on its own', async () => {
  for (const { exportName } of COMPONENTS) {
    const subpath = `./src/${exportName.toLowerCase()}/index.js`;
    const out = await bundle(
      `import { ${exportName} } from '${subpath}';\n` +
        `globalThis.__keep = ${exportName};\n`,
    );
    assert.ok(out.length > 0, `${subpath} produced an empty bundle`);
  }
});
