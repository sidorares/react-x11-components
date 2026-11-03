// The editing commands, `document.execCommand` and its queries, through a
// page's scripts (`src/html/scripts/editing.ts`): what each does to the tree
// and the selection, what it answers, what it tells, and what undoes it.
import { afterEach, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { act, cleanup, fireEvent, renderX11 } from 'react-x11/test';
import { XK_BACKSPACE, XK_DELETE, XK_RETURN } from 'react-x11/keysyms';
import { ThemeProvider } from 'react-x11';

import { Html, useHtmlHandle } from '../../src/html/index.js';
import type { HtmlHandle } from '../../src/html/index.js';
import { preloadHtmlScripts, useScripts } from '../../src/html/scripts/hook.js';
import type {
  ScriptRunner,
  ScriptsOptions,
} from '../../src/html/scripts/runner.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { FONTS } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

/** Skipped where this runtime runs no page's scripts (`SCRIPTS_CONTAINED`). */
const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

const PAGE = 'https://example.test/page.html';

async function settle(ms = 20) {
  for (let i = 0; i < 4; i += 1) {
    await act(() => new Promise((r) => setTimeout(r, ms / 4)));
  }
}

interface Page {
  /** Run a script in the page, and what it then wrote to `#out`, as JSON. */
  run(code: string): Promise<unknown>;
  /** Keys typed at what has the focus, each a letter, `Enter`,
   *  `Backspace` or `Delete`, after the modifiers it is a chord of:
   *  `Control+z`. */
  type(...keys: string[]): Promise<void>;
  logs: string[];
}

/** The modifiers a chord in these tests is typed with. */
type Modifier = 'Control' | 'Shift';

const KEYSYMS: Record<string, number> = {
  Enter: XK_RETURN,
  Backspace: XK_BACKSPACE,
  Delete: XK_DELETE,
};

/** A page whose scripts run, `source` after a `#out` its scripts write
 *  JSON to, in a window keys can be typed in. */
async function open(source: string): Promise<Page> {
  const logs: string[] = [];
  let handle: HtmlHandle | null = null;
  let runner: (() => ScriptRunner | null) | null = null;
  const seams: ScriptsOptions = {
    userAgent: 'test',
    language: 'en-US',
    viewport: () => ({
      width: 400,
      height: 300,
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      dpr: 1,
      left: 0,
      top: 0,
    }),
    scrollTo: () => {},
    navigate: () => {},
    reload: () => {},
    go: () => {},
    log: (level, text) => void logs.push(`${level}: ${text}`),
    title: () => {},
    fetch: async () => {
      throw new Error('no network');
    },
    load: async () => null,
    onTimeout: () => {},
  };
  function Page() {
    const held = useHtmlHandle();
    handle = held;
    const scripts = useScripts(true, held, PAGE, seams);
    runner = () => scripts.runner?.() ?? null;
    return h(Html, {
      source: `<!doctype html><p id=out></p>${source}`,
      partial: false,
      ref: held.ref,
      baseUrl: PAGE,
      ...scripts,
    });
  }
  await renderX11(
    h(
      ThemeProvider,
      { colorScheme: 'light' } as Record<string, unknown>,
      h('box', { style: { width: 400, flexDirection: 'column' } }, h(Page)),
    ),
    FONTS
      ? { width: 440, height: 400, fonts: FONTS }
      : { width: 440, height: 400 },
  );
  await settle();
  const read = (): unknown => {
    const out = findText(handle!.document as unknown as Node, 'out');
    if (!out) throw new Error(`nothing written: ${logs.join('\n')}`);
    return JSON.parse(out);
  };
  return {
    logs,
    async run(code) {
      if (code) {
        await act(async () => runner!()?.engine.exec(code, 'test', 0));
        await settle();
      }
      return read();
    },
    async type(...keys) {
      for (const typed of keys) {
        const parts = typed.length > 1 ? typed.split('+') : [typed];
        const key = parts.pop()!;
        const modifiers = parts as Modifier[];
        const sym = KEYSYMS[key];
        await act(async () =>
          sym === undefined
            ? fireEvent.char(key, { modifiers })
            : fireEvent.key(sym, { modifiers }),
        );
        await settle();
      }
    },
  };
}

interface Node {
  attribs?: Record<string, string>;
  children?: Node[];
  data?: string;
}
function textOf(node: Node): string {
  if (typeof node.data === 'string') return node.data;
  return (node.children ?? []).map(textOf).join('');
}
function findText(node: Node, id: string): string {
  if (node.attribs?.id === id) return textOf(node);
  for (const kid of node.children ?? []) {
    const found = findText(kid, id);
    if (found) return found;
  }
  return '';
}

/** A page with an editing host, `#e`, holding `html`, and two helpers for
 *  its scripts: `report(...)` writes what it is handed to `#out`, and
 *  `select(a, ao, b, bo)` selects from one point to another. */
function editor(html: string, attrs = 'contenteditable'): Promise<Page> {
  return open(
    `<div id=e ${attrs}>${html}</div><p>after</p><script>
      const e = document.getElementById('e');
      function report(...xs) { document.getElementById('out').textContent = JSON.stringify(xs); }
      function select(a, ao, b, bo) { getSelection().setBaseAndExtent(a, ao, b ?? a, bo ?? ao); }
      report();
    </script>`,
  );
}

test('queryCommandIndeterm is the name the standard and every engine give it, and says whether what is selected is mixed', async () => {
  const p = await editor('a<b>b</b>');
  assert.deepEqual(
    await p.run(`
      select(e, 0, e, 2);
      const all = [document.queryCommandIndeterm('bold'), document.queryCommandState('bold')];
      select(e.lastChild.firstChild, 0, e.lastChild.firstChild, 1);
      report(all, [document.queryCommandIndeterm('bold'), document.queryCommandState('bold')],
        'queryCommandIndeterminate' in document);`),
    [[true, false], [false, true], false],
  );
});

test('bold, italic, a link and a colour wrap what is selected as the editing specification has it, and the queries say so after', async () => {
  const p = await editor('foobarbaz');
  assert.deepEqual(
    await p.run(`
      select(e.firstChild, 3, e.firstChild, 6);
      const out = [document.execCommand('bold'), e.innerHTML, document.queryCommandState('bold')];
      document.execCommand('italic');
      out.push(e.innerHTML);
      document.execCommand('bold');
      out.push(e.innerHTML, document.queryCommandState('bold'), document.queryCommandState('italic'));
      document.execCommand('createLink', false, 'https://example.test/');
      out.push(e.innerHTML);
      document.execCommand('unlink');
      out.push(e.innerHTML);
      document.execCommand('styleWithCSS', false, 'true');
      document.execCommand('foreColor', false, '#ff0000');
      out.push(
        e.innerHTML.replace(/ style="[^"]*"/, ''),
        getComputedStyle(e.querySelector('span')).color,
        document.queryCommandValue('foreColor'),
      );
      report(...out);`),
    [
      true,
      'foo<b>bar</b>baz',
      true,
      // the new style outside what was there, as Firefox has it: Chromium
      // nests it inside, `foo<b><i>bar</i></b>baz`
      'foo<i><b>bar</b></i>baz',
      'foo<i>bar</i>baz',
      false,
      true,
      'foo<a href="https://example.test/"><i>bar</i></a>baz',
      'foo<i>bar</i>baz',
      'foo<span><i>bar</i></span>baz',
      'rgb(255, 0, 0)',
      'rgb(255, 0, 0)',
    ],
  );
});

test("lists, blocks, indentation and alignment are the editing specification's", async () => {
  const p = await editor('<p>one</p><p>two</p>');
  assert.deepEqual(
    await p.run(`
      select(e, 0, e, 2);
      const out = [];
      document.execCommand('insertUnorderedList');
      out.push(e.innerHTML, document.queryCommandState('insertUnorderedList'));
      document.execCommand('insertOrderedList');
      out.push(e.innerHTML);
      document.execCommand('insertOrderedList');
      out.push(e.innerHTML);
      select(e.firstChild.firstChild, 1);
      document.execCommand('formatBlock', false, '<h1>');
      out.push(e.innerHTML, document.queryCommandValue('formatBlock'));
      document.execCommand('indent');
      out.push(e.innerHTML);
      document.execCommand('outdent');
      document.execCommand('justifyCenter');
      out.push(e.innerHTML, document.queryCommandState('justifyCenter'));
      report(...out);`),
    [
      '<ul><li>one</li><li>two</li></ul>',
      true,
      '<ol><li>one</li><li>two</li></ol>',
      // out of a list, each item a line of the default container's
      '<div>one</div><div>two</div>',
      '<h1>one</h1><div>two</div>',
      'h1',
      '<blockquote><h1>one</h1></blockquote><div>two</div>',
      // the specification's: a div of the alignment around the block,
      // and the div after, which has no alignment, left as it is
      '<div style="text-align: center;"><h1>one</h1></div><div>two</div>',
      true,
    ],
  );
});

test('a font size is read in the legacy sizes of the document, whose medium is its own', async () => {
  // the palette's font size is the document's medium, which is no 16px, so a
  // table of a browser's pixels would read every size one too small
  const p = await editor('<font size=4>big</font><font size=+2>bigger</font>');
  assert.deepEqual(
    await p.run(`
      const [big, bigger] = e.children;
      select(big.firstChild, 1);
      const out = [document.queryCommandValue('fontSize')];
      select(bigger.firstChild, 1);
      out.push(document.queryCommandValue('fontSize'));
      select(e.firstChild.firstChild, 0, e.firstChild.firstChild, 3);
      document.execCommand('fontSize', false, '6');
      out.push(e.firstChild.outerHTML, document.queryCommandValue('fontSize'));
      report(...out);`),
    ['4', '5', '<font size="6">big</font>', '6'],
  );
});

test('a <font size> is a size keyword, a step up or down from 3 where it has a sign, as HTML parses a legacy font size', async () => {
  const p = await open(`<div id=m style="font-size: medium">
      <font size=1>a</font><font size=+1>b</font><font size=-1>c</font>
      <font size=7>d</font><font size=" 5x">e</font><font size=0>f</font>
      <span style="font-size: xxx-large">g</span></div>
    <script>
      const sizes = [...document.getElementById('m').children].map((el) => getComputedStyle(el).fontSize);
      const medium = parseFloat(getComputedStyle(document.getElementById('m')).fontSize);
      document.getElementById('out').textContent = JSON.stringify(sizes.map((s) => +(parseFloat(s) / medium).toFixed(4)));
    </script>`);
  assert.deepEqual(
    await p.run(''),
    // x-small, large, small, xxx-large, x-large, x-small, xxx-large
    [0.625, 1.125, 0.8125, 3, 1.5, 0.625, 3],
  );
});

test('a colour an attribute names is read as HTML reads a legacy colour value, which needs no #', async () => {
  // what the editing commands read back of a `<font color>` a page wrote
  const p = await open(`<div id=m>
      <font color=0000ff>a</font><font color=chucknorris>b</font>
      <font color=transparent>c</font><font color="#abc">d</font>
      <span bgcolor=ff0000>e</span><table bgcolor=00ff00><tr><td>f</table></div>
    <script>
      const m = document.getElementById('m');
      document.getElementById('out').textContent = JSON.stringify([
        ...[...m.querySelectorAll('font')].map((el) => getComputedStyle(el).color),
        getComputedStyle(m.querySelector('table')).backgroundColor,
        getComputedStyle(m).color,
      ]);
    </script>`);
  const colors = (await p.run('')) as string[];
  const inherited = colors.pop();
  if (colors[2] === inherited) colors[2] = 'inherited';
  assert.deepEqual(colors, [
    'rgb(0, 0, 255)',
    'rgb(192, 0, 0)',
    // no colour, so the text's own
    'inherited',
    'rgb(170, 187, 204)',
    'rgb(0, 255, 0)',
  ]);
});

test('innerHTML writes a no-break space as &nbsp; and every letter past ASCII as itself, as HTML serializes a fragment', async () => {
  const p = await open(`<div id=m title="日本 é ">a ö 日本語</div>
    <script>
      document.getElementById('out').textContent = JSON.stringify(document.getElementById('m').outerHTML);
    </script>`);
  assert.equal(
    await p.run(''),
    '<div id="m" title="日本 é&nbsp;">a&nbsp;ö 日本語</div>',
  );
});

test('an edit a command makes is told as an input alone, its inputType and its data as Chromium tells them', async () => {
  const p = await editor('abc');
  assert.deepEqual(
    await p.run(`
      const told = [];
      e.addEventListener('beforeinput', (ev) => told.push('before:' + ev.inputType));
      e.addEventListener('input', (ev) => told.push(ev.inputType + ':' + ev.data + ':' + ev.cancelable));
      select(e.firstChild, 0, e.firstChild, 3);
      document.execCommand('bold');
      document.execCommand('foreColor', false, '#FF0000');
      document.execCommand('fontName', false, 'monospace');
      document.execCommand('createLink', false, 'x.html');
      getSelection().collapseToEnd();
      document.execCommand('insertText', false, 'd');
      // a caret that makes nothing bold changes nothing, and tells nothing
      document.execCommand('bold');
      report(told);`),
    [
      [
        'formatBold:null:false',
        'formatFontColor:rgb(255, 0, 0):false',
        'formatFontName:monospace:false',
        'insertLink:x.html:false',
        'insertText:d:false',
      ],
    ],
  );
});

test('a bold or a colour the caret holds is carried over to what is typed next, by key or by command', async () => {
  const p = await editor('ab');
  await p.run(`
    e.focus();
    select(e.firstChild, 1);
    document.execCommand('bold');
    report(e.innerHTML, document.queryCommandState('bold'));`);
  await p.type('x');
  assert.deepEqual(
    await p.run(`
      const keyed = e.innerHTML;
      document.execCommand('foreColor', false, 'blue');
      document.execCommand('insertText', false, 'y');
      report(keyed, e.innerHTML);`),
    ['a<b>x</b>b', 'a<b>x<font color="#0000ff">y</font></b>b'],
  );
});

test('typed white space stays visible: a space where it would collapse is a no-break one, and goes back to a space once a letter follows it', async () => {
  const p = await editor('a');
  await p.run('e.focus(); select(e.firstChild, 1);');
  await p.type(' ');
  const one = await p.run('report(e.innerHTML)');
  await p.type(' ', 'b');
  assert.deepEqual(
    [one, await p.run('report(e.innerHTML)')],
    [['a&nbsp;'], ['a&nbsp; b']],
  );
});

test('Enter puts in a paragraph, Backspace at its start joins it to the one before, and Delete at an end the one after', async () => {
  const p = await editor('<p>abc</p>');
  await p.run('e.focus(); select(e.firstChild.firstChild, 1);');
  await p.type('Enter');
  const split = await p.run('report(e.innerHTML)');
  await p.type('Backspace');
  const joined = await p.run('report(e.innerHTML)');
  await p.run('select(e.firstChild.firstChild, 1); report()');
  await p.type('Enter');
  await p.run('select(e.firstChild.firstChild, 1); report()');
  await p.type('Delete');
  assert.deepEqual(
    [split, joined, await p.run('report(e.innerHTML)')],
    [['<p>a</p><p>bc</p>'], ['<p>abc</p>'], ['<p>abc</p>']],
  );
});

test('undo puts an edit back and redo makes it again, keeping each node the node it was; typing is one step until something else is done', async () => {
  const p = await editor('<p id=p>foo</p>');
  assert.deepEqual(
    await p.run(`
      const held = document.getElementById('p');
      const out = [document.queryCommandSupported('undo'), document.queryCommandEnabled('undo')];
      const told = [];
      e.addEventListener('input', (ev) => told.push(ev.inputType));
      select(held.firstChild, 0, held.firstChild, 3);
      document.execCommand('bold');
      out.push(e.innerHTML, document.queryCommandEnabled('undo'));
      out.push(document.execCommand('undo'), e.innerHTML, e.firstChild === held, getSelection().toString());
      out.push(document.queryCommandEnabled('redo'), document.execCommand('redo'), e.innerHTML);
      out.push(document.execCommand('undo'), document.execCommand('undo'), e.innerHTML, told);
      e.focus();
      select(held.firstChild, 3);
      report(...out);`),
    [
      true,
      false,
      '<p id="p"><b>foo</b></p>',
      true,
      true,
      '<p id="p">foo</p>',
      true,
      'foo',
      true,
      true,
      '<p id="p"><b>foo</b></p>',
      true,
      // nothing left to undo
      false,
      '<p id="p">foo</p>',
      ['formatBold', 'historyUndo', 'historyRedo', 'historyUndo'],
    ],
  );
  await p.type('x', 'y', 'z', 'Enter', 'w');
  const typed = await p.run('report(e.innerHTML)');
  // the paragraph and what was typed after it, then the typing before it
  await p.type('Control+z', 'Control+z');
  const undone = await p.run('report(e.innerHTML)');
  await p.type('Control+z');
  const all = await p.run('report(e.innerHTML)');
  await p.type('Control+Shift+z');
  assert.deepEqual(
    [typed, undone, all, await p.run('report(e.innerHTML)')],
    [
      ['<p id="p">fooxyz</p><p>w</p>'],
      ['<p id="p">fooxyz</p>'],
      ['<p id="p">foo</p>'],
      ['<p id="p">fooxyz</p>'],
    ],
  );
});

test('insertHTML leaves the caret after what it put in, where the next edit goes', async () => {
  const p = await editor('foobar');
  assert.deepEqual(
    await p.run(`
      select(e.firstChild, 3);
      document.execCommand('insertHTML', false, 'ab<b>c</b>d');
      document.execCommand('insertText', false, 'X');
      report(e.innerHTML);`),
    ['fooab<b>c</b>dXbar'],
  );
});

test('a focused editing host takes the caret, an empty one takes a rule, and one last in the document is edited as any', async () => {
  const p = await open(`<div id=e contenteditable></div>
    <script>
      const e = document.getElementById('e');
      e.focus();
      const out = [document.execCommand('insertText', false, 'abc'), e.innerHTML];
      e.innerHTML = '';
      document.execCommand('insertHorizontalRule');
      out.push(e.innerHTML);
      const last = document.createElement('div');
      last.contentEditable = 'true';
      last.innerHTML = '<div>abc</div>';
      document.documentElement.appendChild(last);
      last.focus();
      getSelection().collapse(last.firstChild.firstChild, 3);
      out.push(document.execCommand('delete'), last.innerHTML);
      document.getElementById('out').textContent = JSON.stringify(out);
    </script>`);
  assert.deepEqual(await p.run(''), [
    true,
    'abc',
    '<hr>',
    true,
    '<div>ab</div>',
  ]);
});

test('with nothing selected the queries answer and nothing is edited, and a plaintext-only host takes text and no formatting', async () => {
  const p = await editor(
    '<div>A</div><div>B</div>',
    'contenteditable=plaintext-only',
  );
  assert.deepEqual(
    await p.run(`
      getSelection().removeAllRanges();
      const none = [
        document.queryCommandState('bold'), document.queryCommandValue('foreColor'),
        document.queryCommandIndeterm('bold'), document.execCommand('bold'),
      ];
      select(e.firstChild.firstChild, 0, e.firstChild.firstChild, 1);
      const plain = [document.queryCommandEnabled('bold'), document.execCommand('bold'), e.innerHTML];
      select(e.firstChild.firstChild, 1);
      plain.push(document.execCommand('forwardDelete'), e.innerHTML);
      report(none, plain);`),
    [
      [false, '', false, false],
      [false, false, '<div>A</div><div>B</div>', true, '<div>AB</div>'],
    ],
  );
});

test('a host that cannot hold a paragraph breaks its line, and white space that keeps line feeds is broken with one', async () => {
  const span = await open(`<span id=e contenteditable>ab</span><script>
      const e = document.getElementById('e');
      function report(...xs) { document.getElementById('out').textContent = JSON.stringify(xs); }
      report();
    </script>`);
  assert.deepEqual(
    await span.run(`
      getSelection().collapse(e.firstChild, 1);
      document.execCommand('insertParagraph');
      report(e.innerHTML);`),
    ['a<br>b'],
  );
  const pre = await editor('<div style="white-space: pre-wrap">ab</div>');
  assert.deepEqual(
    await pre.run(`
      select(e.firstChild.firstChild, 1);
      document.execCommand('insertLineBreak');
      const middle = e.innerHTML;
      select(e.firstChild.lastChild, e.firstChild.lastChild.length);
      document.execCommand('insertLineBreak');
      report(middle, e.innerHTML);`),
    [
      '<div style="white-space: pre-wrap">a\nb</div>',
      '<div style="white-space: pre-wrap">a\nb\n\n</div>',
    ],
  );
});

test('what a select holds and a contenteditable=false island are taken whole, and text typed at a select goes after it', async () => {
  const p = await editor(
    '<p>abc</p><select><option>def</option></select><p>jkl</p>',
  );
  assert.deepEqual(
    await p.run(`
      const s = e.querySelector('select');
      select(s, 0, s, 1);
      document.execCommand('insertText', false, 'XY');
      const typed = e.innerHTML;
      select(e, 1, e, 2);
      document.execCommand('delete');
      report(typed, e.innerHTML);`),
    [
      '<p>abc</p><select><option>def</option></select>XY<p>jkl</p>',
      '<p>abc</p>XY<p>jkl</p>',
    ],
  );
  const island = await editor('a<span contenteditable=false>b</span>c');
  assert.deepEqual(
    await island.run(`
      const span = e.querySelector('span');
      select(e.firstChild, 0, e.lastChild, 1);
      document.execCommand('delete');
      report(span.isConnected, e.textContent);`),
    [false, ''],
  );
});

test('designMode makes the document the editing host, and an empty paragraph deleted in it leaves the body', async () => {
  const p = await open(`<p id=x>ab</p><script>
      function report(...xs) { document.getElementById('out').textContent = JSON.stringify(xs); }
      report();
    </script>`);
  assert.deepEqual(
    await p.run(`
      const x = document.getElementById('x');
      const before = [document.designMode, x.isContentEditable];
      document.designMode = 'ON';
      const on = [document.designMode, x.isContentEditable];
      const out = document.getElementById('out');
      document.head.remove();
      const left = [];
      for (const command of ['delete', 'forwardDelete']) {
        for (const n of [...document.body.childNodes]) n.remove();
        const p = document.body.appendChild(document.createElement('p'));
        getSelection().collapse(p, 0);
        document.execCommand(command);
        left.push(document.documentElement.outerHTML);
      }
      document.designMode = 'off';
      document.body.append(out);
      report(before, on, left, document.designMode, x.isContentEditable);`),
    [
      ['off', false],
      ['on', true],
      ['<html><body></body></html>', '<html><body><p><br></p></body></html>'],
      'off',
      false,
    ],
  );
});

test('a letter typed at the edge of a link goes outside it, and one typed over what the link holds stays in it', async () => {
  const p = await editor('<p><a href="about:blank">abc</a></p>');
  assert.deepEqual(
    await p.run(`
      e.focus();
      const a = e.querySelector('a');
      select(a.firstChild, 3);
      report()`),
    [],
  );
  await p.type('X', 'Y');
  const atEnd = await p.run('report(e.innerHTML)');
  await p.run(`
    e.innerHTML = '<p><a href="about:blank">abc</a></p>';
    const t = e.querySelector('a').firstChild;
    select(t, 2, t, 3);
    report()`);
  await p.type('X', 'Y');
  const over = await p.run('report(e.innerHTML)');
  const scripted = await p.run(`
    e.innerHTML = '<p><a href="about:blank">abc</a></p>';
    select(e.querySelector('a').firstChild, 3);
    document.execCommand('insertText', false, 'Z');
    report(e.innerHTML)`);
  assert.deepEqual(
    [atEnd, over, scripted],
    [
      ['<p><a href="about:blank">abc</a>XY</p>'],
      ['<p><a href="about:blank">abXY</a></p>'],
      ['<p><a href="about:blank">abcZ</a></p>'],
    ],
  );
});

test('a focused host whose selection a page took away keeps none when it is focused again, and a key edits nothing', async () => {
  const p = await editor('<br>');
  await p.run(`
    window.told = [];
    addEventListener('beforeinput', (x) => told.push(x.inputType));
    e.focus();
    getSelection().removeAllRanges();
    e.focus();
    report()`);
  await p.type('a');
  assert.deepEqual(
    await p.run('report(getSelection().rangeCount, told, e.innerHTML)'),
    [0, [], '<br>'],
  );
});
