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
  { exportName: 'ChartContainer', dir: 'charts', marker: 'chartplot' },
  // The QML engine's marker is the unknown-type error only its registry
  // throws.
  { exportName: 'QmlView', dir: 'qml', marker: 'Unknown QML type' },
  { exportName: 'CodeEditor', dir: 'code-editor', marker: 'codeeditor' },
  { exportName: 'Calendar', dir: 'calendar', marker: 'Previous month' },
  // `<Markdown>`, `<Code>` and `<CodeEditor>` share `src/richtext/` and
  // `src/code-language/`, so their markers name what is theirs alone: the
  // warning only `<Markdown>`'s expression evaluator writes (its parser is
  // shared with the rich text editor now, from `src/internal/markdown/`, so
  // the autolink scheme it writes is no longer one component's), and the
  // gutter label only the code block draws.
  {
    exportName: 'Markdown',
    dir: 'markdown',
    marker: 'markdown expression did not evaluate',
  },
  // `<Code>`'s marker is its accessible name *as an attribute*: the rich
  // text editor's toolbar has a "Code block" button too, whose name is a
  // `title` until it is drawn — so the string alone no longer says whose
  // module is in the bundle, and the pair does.
  { exportName: 'Code', dir: 'code', marker: '"aria-label":"Code block"' },
  // `<TerminalOutput>` shares `src/richtext/` and `src/codeblock/` with the
  // two above and shares nothing at all with `<Terminal>` — the name is the
  // only thing the two terminals have in common — so its marker is the label
  // only it writes.
  {
    exportName: 'TerminalOutput',
    dir: 'terminal-output',
    marker: 'Terminal output',
  },
  // `<Terminal>` and `<MediaPlayer>` share `src/embed/`, so their markers name
  // what is theirs alone: an X resource only the xterm adapter writes, and the
  // flag only mpv is given.
  { exportName: 'Terminal', dir: 'terminal', marker: 'XTerm*color' },
  {
    exportName: 'MediaPlayer',
    dir: 'media-player',
    marker: '--input-ipc-server=',
  },
  // `<TrayHost>` shares `<foreign>` with the two above but none of their
  // modules, so its marker is the atom nothing else in the package names.
  { exportName: 'TrayHost', dir: 'tray-host', marker: '_NET_SYSTEM_TRAY_S' },
  // `<Tree>` shares core's chevron with `<Calendar>` but no module here; the
  // role is the one string only it writes.
  { exportName: 'Tree', dir: 'tree', marker: 'treeitem' },
  // the element name rather than `flow`, which "overflow" contains
  { exportName: 'Flow', dir: 'flow', marker: 'flowgraph' },
  // `<Map>` shares nothing with anything here; the element name is a string
  // no other module writes.
  { exportName: 'Map', dir: 'maps', marker: 'mapview' },
  // `<Formula>` reaches katex only through a dynamic import, so the marker
  // is a face name only its own font table writes
  { exportName: 'Formula', dir: 'formula', marker: 'KaTeX_Size4' },
  // `<Html>` shares `src/richtext/`'s run decorations and `src/internal/`'s
  // code-point helpers with `<Markdown>` and `<Code>`, so its marker is a
  // string only its user-agent stylesheet writes.
  { exportName: 'Html', dir: 'html', marker: 'table-header-group' },
  // `<Timeline>` is box-and-text composition and shares nothing at all, which
  // leaves it short of a marker: the export pulled is the *item* rather than
  // the root, because the root shakes so well that nothing distinctive
  // survives it, and the string is the guard message rather than the item's
  // `listitem` role — `<Flow>` gives its scene items that role too.
  {
    exportName: 'TimelineItem',
    dir: 'timeline',
    marker: 'inside a <Timeline>',
  },
  // `<Tabs>` is box-and-text composition like `<Timeline>`; the marker is
  // the `tablist` role, which nothing else in this package writes.
  { exportName: 'TabsList', dir: 'tabs', marker: 'tablist' },
  // `<Table>` shares the internal height index with `<Tree>`
  // (src/internal/ — shared code, not a component import); the role is the
  // one string only the table writes, and this loop is what proves the
  // sharing keeps the two bundles separate.
  { exportName: 'Table', dir: 'table', marker: 'columnheader' },
  // `<ReorderList>` is box-and-popup composition over core's drag and drop
  // and shares nothing here; the marker is the payload type only it offers.
  {
    exportName: 'ReorderList',
    dir: 'reorder',
    marker: 'application/x-react-x11-reorder',
  },
  // `<RichTextEditor>` is the one component not in the barrel — its index.ts
  // says why (ProseMirror's DOM-typed declarations) — so it is pulled from
  // its subpath. It shares the markdown parser with `<Markdown>` and the
  // `<richtext>` element with three others; its root element's name is its
  // alone.
  {
    exportName: 'RichTextEditor',
    dir: 'rich-text-editor',
    marker: 'richeditor',
    from: './dist/rich-text-editor/index.js',
  },
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
  for (const { exportName, marker, from } of COMPONENTS) {
    const out = await bundle(
      `import { ${exportName} } from '${from ?? './dist/index.js'}';\n` +
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

/**
 * The same bundle with code splitting on — what a real bundler does with a
 * dynamic `import()`. Returns every chunk, entry first.
 */
async function bundleChunks(
  contents: string,
): Promise<Array<{ path: string; text: string }>> {
  const result = await esbuild.build({
    stdin: { contents, resolveDir: ROOT, sourcefile: 'entry.js', loader: 'js' },
    bundle: true,
    format: 'esm',
    splitting: true,
    outdir: 'chunks',
    write: false,
    minify: true,
    treeShaking: true,
    external: [
      'react',
      'react-x11',
      'react-x11/*',
      'ical.js',
      '@lezer/highlight',
    ],
    logLevel: 'silent',
  });
  const files = (result.outputFiles ?? []).map((f) => ({
    path: f.path,
    text: f.text,
  }));
  assert.ok(files.length, 'esbuild wrote no output to read');
  return files.sort((a, b) =>
    a.path.includes('entry') ? -1 : b.path.includes('entry') ? 1 : 0,
  );
}

/**
 * `<Terminal>` must not cost the emulator.
 *
 * The vt backend is a `registerElement` side effect plus `@xterm/headless` —
 * about 2 MB unpacked — behind a dynamic `import()` taken only when
 * `backend="vt"` is actually selected. Split, that is a chunk an XEmbed app
 * never fetches; unsplit, esbuild inlines it (which is the bundler's call,
 * not ours), so this is the split build, which is what any app that cares
 * about the size is doing anyway.
 */
test('the vt backend is a lazy chunk, not part of <Terminal>', async () => {
  const chunks = await bundleChunks(
    "import { Terminal } from './dist/terminal/index.js';\n" +
      'globalThis.__keep = Terminal;\n',
  );
  const [entry] = chunks;
  assert.ok(
    !entry.text.includes('vtterm'),
    'the terminal entry chunk should not contain the vt element',
  );
  assert.ok(
    chunks.slice(1).some((chunk) => chunk.text.includes('vtterm')),
    'and the vt element should still be reachable, in a chunk of its own',
  );
  assert.ok(
    chunks.some((chunk) => /xterm/i.test(chunk.path)),
    'the emulator core is its own chunk too',
  );
});

/**
 * `<Map>` must not cost the GL renderer.
 *
 * The GL renderer — its shaders, the bucket builder, the label atlas — is
 * brought in by dynamic `import()` when a map chooses it
 * (`src/maps/renderer.ts`). Split, that is a chunk an application drawing
 * every map through the retained renderer never fetches; a static import
 * anywhere under `<Map>` would put all of it into every bundle that names a
 * map. The markers are the pane element only the GL renderer registers, and
 * a word only its shaders write.
 */
test('the GL map renderer is a lazy chunk, not part of <Map>', async () => {
  const chunks = await bundleChunks(
    "import { Map } from './dist/maps/index.js';\n" +
      'globalThis.__keep = Map;\n',
  );
  const [entry] = chunks;
  for (const marker of ['mapglpane', 'gl_FragColor']) {
    assert.ok(
      !entry.text.includes(marker),
      `the map entry chunk should not contain the GL renderer (${marker})`,
    );
  }
  assert.ok(
    chunks.slice(1).some((chunk) => chunk.text.includes('mapglpane')),
    'and the GL renderer should still be reachable, in a chunk of its own',
  );
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
