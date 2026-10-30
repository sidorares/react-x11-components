// The example browser's developer tools: from a rule in the Styles tab to
// where it was written, in the Sources panel. The tools are an example, and
// this is the one test of them: a jump crosses `<Html>`'s seam, the panels
// and `<CodeEditor>`, and a place off by a line draws no error.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import {
  act,
  cleanup,
  renderX11,
  screen,
  userEvent,
  waitFor,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import { DevTools } from '../examples/browser/devtools/index.js';
import { ConsoleLog, Inspection } from '../examples/browser/devtools/model.js';
import { NetworkLog } from '../examples/browser/devtools/network-log.js';
import {
  declarationTarget,
  formatCss,
  inlineText,
  placeName,
  ruleTarget,
  sheetFile,
  shownRange,
  sourcesOf,
} from '../examples/browser/devtools/source-files.js';
import type { SourceFile } from '../examples/browser/devtools/source-files.js';
import { CookieJar, Html, useHtmlHandle } from '../src/html/index.js';
import type {
  Element,
  HtmlHandle,
  HtmlRuleSource,
  HtmlSheetSource,
} from '../src/html/index.js';
import { FONTS, findById, metric } from './html/harness.js';

afterEach(cleanup);

const h = React.createElement;

/** A node, with the props the queries here read. */
type Rendered = DrawnNode & { props: Record<string, unknown> };

/** A rule's place, as `matchedRules` hands it over. */
function ruleIn(text: string, selector: string): HtmlRuleSource {
  const sheet: HtmlSheetSource = { url: 'http://x/a.css', element: null, text };
  return { sheet, offset: text.indexOf(selector), line: 1, column: 1 };
}

test('a rule shows as far as its selector goes, one of a list alone', () => {
  const text = '.a,\n.b:is(.c, .d)  ,\n.e {\n  color: red;\n}';
  const target = ruleTarget(ruleIn(text, '.b'));
  assert.strictEqual(text.slice(target.from, target.to), '.b:is(.c, .d)');
  const last = ruleTarget(ruleIn(text, '.e'));
  assert.strictEqual(text.slice(last.from, last.to), '.e');
});

test('a declaration is found in its own rule, by its property and its value', () => {
  const text = [
    '.a {',
    '  /* color: gold; */',
    '  --brace: { color: gold };',
    '  &:hover { color: green; }',
    '  @media (min-width: 1px) { color: teal; }',
    '  display: -webkit-box;',
    '  display: flex;',
    '  COLOR: red !important;',
    '  background: url("a;b}.png")',
    '}',
    '.b { color: blue }',
  ].join('\n');
  const source = ruleIn(text, '.a');
  const shown = (property: string, value: string) => {
    const { from, to } = declarationTarget(source, property, value);
    return text.slice(from, to);
  };
  assert.strictEqual(shown('color', 'red'), 'COLOR: red !important;');
  assert.strictEqual(
    shown('--brace', '{ color: gold }'),
    '--brace: { color: gold };',
  );
  // of two alike, the one that reads the value; failing that, the last
  assert.strictEqual(shown('display', '-webkit-box'), 'display: -webkit-box;');
  assert.strictEqual(shown('display', 'flex'), 'display: flex;');
  assert.strictEqual(shown('display', 'grid'), 'display: flex;');
  // the last declaration has no `;`
  assert.strictEqual(
    shown('background', 'url("a;b}.png")'),
    'background: url("a;b}.png")',
  );
  // one the block does not have is the rule
  assert.strictEqual(shown('margin', '0'), '.a');
});

test("a target lands where the panel shows it: a page's margins off, or set out a line at a time", () => {
  const raw =
    '\n\n    .a { color: red }\n\n    .b {\n      color: blue;\n    }\n';
  const element = { name: 'style' } as unknown as Element;
  const inline: SourceFile = {
    id: 'inline:style:1',
    kind: 'stylesheet',
    url: null,
    name: '<style> 1',
    folders: [],
    element,
  };
  const sheet: HtmlSheetSource = { url: null, element, text: raw };
  const source: HtmlRuleSource = {
    sheet,
    offset: raw.indexOf('.b'),
    line: 5,
    column: 5,
  };
  // what the panel numbers its lines by, without the two blank ones
  assert.strictEqual(placeName(inline, source).label, '<style> 1:3');

  const target = ruleTarget(source);
  const plain = '.a { color: red }\n\n.b {\n  color: blue;\n}';
  assert.deepStrictEqual(shownRange(inline, target, plain, false), [
    { line: 2, ch: 0 },
    { line: 2, ch: 2 },
  ]);

  const minified = '.a{color:red}@media (min-width:1px){.b,.c{color:blue}}';
  const file: SourceFile = { ...inline, url: 'http://x/m.css', element: null };
  const min: HtmlRuleSource = {
    sheet: { ...sheet, url: file.url, element: null, text: minified },
    offset: minified.indexOf('.c'),
    line: 1,
    column: 1,
  };
  const [from, to] = shownRange(file, ruleTarget(min), minified, true);
  const lines = formatCss(minified).split('\n');
  assert.strictEqual(lines[from.line].slice(from.ch, to.ch), '.c');
  assert.strictEqual(from.line, to.line);
});

test('a name past what a link holds keeps its ends', () => {
  const name = `${'a'.repeat(30)}-theme-with-a-long-name.min.css`;
  const file: SourceFile = {
    id: name,
    kind: 'stylesheet',
    url: `http://x/${name}`,
    name,
    folders: [],
    element: null,
  };
  const { label, title } = placeName(file, ruleIn('.a {}', '.a'));
  assert.ok(label.length < name.length);
  assert.ok(label.endsWith('.min.css:1'), label);
  assert.ok(title.startsWith(`http://x/${name}:1:1`), title);
});

const MAIN = `body { margin: 0 }

/* a comment of two lines,
   which a rule's line counts */
#t {
  color: red;
  padding: 1px;
}
${'\n'.repeat(300)}
p {
  margin: 2px;
}
${'\n'.repeat(300)}`;
const IMPORTED = '.a { color: blue }\n';
const SHEETS: Record<string, string> = {
  'http://x/main.css': MAIN,
  'http://x/imported.css': IMPORTED,
};
const PAGE =
  '<link rel="stylesheet" href="main.css">' +
  '<style>\n  @import "imported.css";\n</style>' +
  '<p id="t" class="a">x</p>';

/** A page, and its tools docked under it. */
function Tab({
  inspection,
  onHandle,
}: {
  inspection: Inspection;
  onHandle: (handle: HtmlHandle) => void;
}): React.ReactElement {
  const handle = useHtmlHandle();
  onHandle(handle);
  const [log] = React.useState(() => new ConsoleLog());
  const [network] = React.useState(() => new NetworkLog());
  const [cookies] = React.useState(() => new CookieJar());
  return h(
    'box',
    { style: { width: 800, height: 600 } },
    h(Html, {
      source: PAGE,
      baseUrl: 'http://x/page.html',
      partial: false,
      ref: handle.ref,
      style: { height: 100 },
      onResource: (r: { url: string; kind: string }) =>
        r.kind === 'stylesheet' && SHEETS[r.url]
          ? { kind: 'stylesheet' as const, text: SHEETS[r.url] }
          : null,
    }),
    h(
      'box',
      { style: { flexGrow: 1, minHeight: 0 } },
      h(DevTools, {
        handle,
        docKey: 1,
        inspection,
        log,
        network,
        loadSource: () => Promise.resolve(null),
        url: 'http://x/page.html',
        cookies,
        storage: null,
        panel: 'elements',
        ask: 0,
        dock: 'bottom',
        onDock: () => {},
        onClose: () => {},
      }),
    ),
  );
}

interface EditorNode extends DrawnNode {
  kind: 'codeeditor';
  selection: { anchor: { line: number }; head: { line: number; ch: number } };
  selectedText(): string;
  lines: readonly string[];
  caretRect(): { y: number };
}

const shownEditors = (): EditorNode[] =>
  screen
    .all((n: DrawnNode) => n.kind === 'codeeditor' && n.abs.height > 60)
    .map((n) => n as EditorNode);

async function openStyles(): Promise<{
  inspection: Inspection;
  handle: () => HtmlHandle;
}> {
  const inspection = new Inspection();
  let current: HtmlHandle | null = null;
  await renderX11(
    h(Tab, { inspection, onHandle: (next) => (current = next) }),
    { width: 800, height: 600, fonts: FONTS! },
  );
  const handle = () => current!;
  await waitFor(() => assert.ok(handle().document));
  await act(async () => {
    inspection.selected.set(findById(handle().document, 't')!);
  });
  const styles = screen.getByRole('tab', { name: 'Styles' }) as DrawnNode;
  await userEvent.click(styles);
  return { inspection, handle };
}

metric(
  "a rule's link opens the Sources panel on the rule, its file chosen",
  async () => {
    await openStyles();
    const links = await waitFor(() => {
      const found = screen.getAllByRole('link') as Rendered[];
      assert.ok(found.length >= 2);
      return found;
    });
    const names = links.map((n) => n.props['aria-label']);
    assert.ok(
      names.includes('Show http://x/main.css:5:1 in Sources'),
      String(names),
    );
    assert.ok(
      names.includes('Show http://x/imported.css:1:1 in Sources'),
      String(names),
    );
    const main = links.find((n) =>
      String(n.props['aria-label']).includes('main.css'),
    )!;
    await userEvent.click(main);
    const editor = await waitFor(() => {
      const [found] = shownEditors();
      assert.ok(found);
      assert.strictEqual(found.selectedText(), '#t');
      return found;
    });
    assert.strictEqual(editor.selection.head.line, 4);
    assert.strictEqual(editor.lines[4], '#t {');

    // back to the rules, and to another in the same file, far down it: the
    // file is open already, in a panel that was hidden when it was asked
    await userEvent.click(
      screen.getByRole('tab', { name: 'Elements' }) as DrawnNode,
    );
    const line = MAIN.slice(0, MAIN.indexOf('\np {') + 1).split('\n').length;
    const far = (screen.getAllByRole('link') as Rendered[]).find((n) =>
      String(n.props['aria-label']).includes(`main.css:${line}:`),
    )!;
    assert.ok(far, 'a link to the rule at the end');
    await userEvent.click(far);
    await waitFor(() => assert.strictEqual(editor.selectedText(), 'p'));
    assert.strictEqual(editor.selection.head.line, line - 1);
    // set a third of the way down rather than on the edge of the pane
    await waitFor(() => {
      const { y } = editor.caretRect();
      assert.ok(
        y > editor.abs.height / 6 && y < editor.abs.height / 2,
        String(y),
      );
    });
  },
);

metric(
  'an imported sheet is a file of its own, and read as the document read it',
  async () => {
    const { handle } = await openStyles();
    const files = sourcesOf(
      handle().document!,
      handle().base,
      handle().styleSheets(),
    );
    const imported = files.find((f) => f.url === 'http://x/imported.css')!;
    assert.ok(imported, 'listed');
    assert.strictEqual(imported.element, null);
    assert.strictEqual(imported.sheet?.text, IMPORTED);
    const main = files.find((f) => f.url === 'http://x/main.css')!;
    assert.strictEqual(main.sheet?.text, MAIN);
    // the `<style>` that imports it is a file too, its margins off
    const style = files.find((f) => f.name === '<style> 1')!;
    assert.strictEqual(inlineText(style), '@import "imported.css";');
    // each rule's sheet finds its file
    const p = findById(handle().document, 't')!;
    for (const rule of handle().matchedRules(p)) {
      if (rule.source) assert.ok(sheetFile(files, rule.source.sheet));
    }
  },
);

metric(
  'a Ctrl+click on a declaration opens the Sources panel on the declaration',
  async () => {
    await openStyles();
    const declaration = await waitFor(() => {
      const [found] = screen.all(
        (n: DrawnNode) =>
          n.kind === 'richtext' &&
          ((n as Rendered).props.runs as { text: string }[])?.[0]?.text ===
            'padding',
      );
      assert.ok(found);
      return found as Rendered;
    });
    // a click alone selects text, as it does anywhere
    await userEvent.click(declaration);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepStrictEqual(shownEditors(), []);
    await userEvent.click(declaration, { modifiers: ['Control'] });
    const editor = await waitFor(() => {
      const [found] = shownEditors();
      assert.ok(found);
      assert.strictEqual(found.selectedText(), 'padding: 1px;');
      return found;
    });
    assert.strictEqual(editor.selection.head.line, 6);
  },
);
