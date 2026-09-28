// From process start to an app's first painted frame, and where the time
// went: the imports, `createRoot` (the connection, the layout engine, the
// integrations), and the first render and flush. Prints one line:
//
//   RESULT {"suite":"startup","app":"menubar","imports":226.4,"createRoot":372.1,"firstPaint":454.9}
//
// Each value is milliseconds since the process started. Run with plain
// `node`, not tsx: what this measures is module loading, and tsx compiling
// TypeScript on the way would be most of it. `APP=editor` reads the
// components from `dist/`, so it needs `npm run build` first.
//
//   APP   small    a window with a text, a button, a text input, ten labels
//         menubar  the same under a <MenuBar>, whose titles are set in a medium
//         editor   a <CodeEditor> beside a <Markdown> pane
//
// Node's compile cache changes the import time most of all (react-x11
// #742): `NODE_COMPILE_CACHE=<dir>` runs with it, and the first run fills it.
process.env.REACT_X11_NO_AUTORUN = '1';
const APP = process.env.APP ?? 'small';
const marks = {};
const mark = (name) => {
  marks[name] = Math.round(performance.now() * 10) / 10;
};

const React = (await import('react')).default;
const { Button, createRoot, MenuBar } = await import('react-x11');
let editor = null;
if (APP === 'editor') {
  const dist = new URL('../../../dist/', import.meta.url);
  editor = {
    ...(await import(new URL('code-editor/index.js', dist).href)),
    ...(await import(new URL('markdown/index.js', dist).href)),
    ...(await import(new URL('code-language/index.js', dist).href)),
  };
}
mark('imports');

const { WindowNode } = await import('react-x11/node');
const flushFrame = WindowNode.prototype._flushFrame;
WindowNode.prototype._flushFrame = function (...args) {
  const painted = flushFrame.apply(this, args);
  if (painted && marks.firstPaint === undefined) mark('firstPaint');
  return painted;
};

const h = React.createElement;
const root = await createRoot();
mark('createRoot');

const labels = () => [
  h('text', { key: 't', style: { fontSize: 18 } }, 'Hello, startup'),
  h(Button, { key: 'b', onClick() {} }, 'A button'),
  h('textinput', { key: 'i', defaultValue: 'type here' }),
  ...Array.from({ length: 10 }, (_, i) =>
    h('text', { key: i }, `row ${i}: some label text`),
  ),
];
const menus = [
  { label: 'File', items: [{ label: 'Open' }, { label: 'Save' }] },
  { label: 'Edit', items: [{ label: 'Copy' }] },
  { label: 'View', items: [{ label: 'Zoom' }] },
];
const content =
  APP === 'editor'
    ? h(
        'box',
        { style: { flexDirection: 'row', flexGrow: 1 } },
        h(editor.CodeEditor, {
          defaultValue: 'function hello() {\n  return 42;\n}\n'.repeat(20),
          language: editor.javascript(),
          style: { flexGrow: 1 },
        }),
        h(
          'box',
          { style: { flexGrow: 1, overflow: 'scroll' } },
          h(editor.Markdown, {
            source: '# Title\n\nSome *text* with `code`.\n\n- a\n- b\n',
          }),
        ),
      )
    : h('box', { style: { padding: 12, gap: 8 } }, ...labels());
root.render(
  h(
    'window',
    { width: 800, height: 600, title: `startup ${APP}` },
    APP === 'menubar' ? h(MenuBar, { globalMenu: false, menus }) : null,
    content,
  ),
);
for (let i = 0; i < 400 && marks.firstPaint === undefined; i++) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
console.log(
  `RESULT ${JSON.stringify({ suite: 'startup', app: APP, ...marks })}`,
);
root.unmount();
process.exit(0);
