// Tree-shaking is a contract this package makes, so it is a test rather
// than an intention. Two things are asserted, and the first is the one that
// actually breaks:
//
//  1. Importing the barrel for *no* exports leaves nothing behind. This is
//     what fails the moment a module does work at import time — a
//     registration hoisted into `src/index.ts`, a theme installed eagerly,
//     a feature probe — and it fails long before anyone notices their app
//     grew.
//  2. Naming one component does not drag in the others.
//
// The second is trivially true while there is one component and becomes a
// real guard the moment a second lands, which is why it is written as a
// loop over the manifest rather than a pair of hand-written assertions.
//
// These bundle `dist/`, not `src/`: what an app installs is the compiler's
// output, and TypeScript is perfectly capable of emitting something that
// does not shake — a downlevelled class, a namespace, an `enum`. `pretest`
// builds, so the artifact under test is always current.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

/**
 * One entry per component: an export to pull, the subpath it also lives at,
 * and a string only that component's modules contain. Good markers are data
 * rather than identifiers — an element name, an aria-label, a D-Bus name —
 * because data survives minification and identifiers do not.
 */
const COMPONENTS = [
  { exportName: 'Sparkline', dir: 'sparkline', marker: 'sparkline' },
  { exportName: 'CodeEditor', dir: 'code-editor', marker: 'codeeditor' },
  { exportName: 'Calendar', dir: 'calendar', marker: 'Previous month' },
  {
    exportName: 'DesktopCalendar',
    dir: 'desktop-calendar',
    marker: 'org.gnome.evolution.dataserver',
  },
  // `<Markdown>`, `<Code>` and `<CodeEditor>` share `src/richtext/` and
  // `src/code-language/`, so their markers name what is theirs alone: the
  // autolink scheme only the markdown parser writes, the gutter label only
  // the code block draws.
  { exportName: 'Markdown', dir: 'markdown', marker: 'mailto:' },
  { exportName: 'Code', dir: 'code', marker: 'Code block' },
];

async function bundle(contents: string): Promise<string> {
  const result = await esbuild.build({
    stdin: { contents, resolveDir: ROOT, sourcefile: 'entry.js', loader: 'js' },
    bundle: true,
    format: 'esm',
    write: false,
    minify: true,
    treeShaking: true,
    // peers: an app already has these, and what is under test is our code.
    // `ical.js` and `@lezer/highlight` are optional (the app installs them
    // or does not), each reached through a dynamic import — bundling a copy
    // here would measure their size rather than ours.
    external: [
      'react',
      'react-x11',
      'react-x11/*',
      'ical.js',
      '@lezer/highlight',
    ],
    logLevel: 'silent',
  });
  const [output] = result.outputFiles ?? [];
  assert.ok(output, 'esbuild wrote no output to read');
  return output.text;
}

test('the barrel has no side effects to keep', async () => {
  const out = await bundle("import './dist/index.js';\n");
  assert.strictEqual(
    out.trim(),
    '',
    'importing the package for nothing should leave nothing behind:\n' + out,
  );
});

test('naming one component does not pull in the others', async () => {
  for (const { exportName, marker } of COMPONENTS) {
    const out = await bundle(
      `import { ${exportName} } from './dist/index.js';\n` +
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
  for (const { exportName, dir } of COMPONENTS) {
    const subpath = `./dist/${dir}/index.js`;
    const out = await bundle(
      `import { ${exportName} } from '${subpath}';\n` +
        `globalThis.__keep = ${exportName};\n`,
    );
    assert.ok(out.length > 0, `${subpath} produced an empty bundle`);
  }
});
