// The `cursor` a control computes to, from the UA sheet csswg-drafts#14251
// settled for `appearance: auto` and the rules the engines add to it, and
// what the window shows over it: a widget mounted for a control is a node of
// core's, and core shows the deepest node's cursor.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { act, cleanup, fireEvent } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import type { HtmlChange } from '../../src/html/index.js';
import { findById, pointIn, render, scriptedPage, view } from './harness.js';
import { CHROME_CURSORS, CURSOR_DOCUMENT } from './cursors.js';

const BUTTON = '::file-selector-button';

// a page left mounted keeps what it runs running: an indeterminate
// <progress> is core's bar, which slides on the window's clock until the
// window goes, and held every test after it, and the process, open
afterEach(cleanup);

test('what an element computes for `cursor` is what Chromium computes', async () => {
  const { node } = await render(CURSOR_DOCUMENT, 800);
  await act();
  const el = view(node);
  const differ: string[] = [];
  for (const [key, want] of Object.entries(CHROME_CURSORS)) {
    const pseudo = key.endsWith(BUTTON);
    const id = pseudo ? key.slice(0, -BUTTON.length) : key;
    const element = findById(el.document, id);
    assert.ok(element, id);
    const got = el.computedStyle(element, pseudo ? BUTTON.slice(2) : null);
    if (got?.cursor !== want) {
      differ.push(`${key}: ${got?.cursor}, where Chromium has ${want}`);
    }
  }
  assert.deepStrictEqual(differ, []);
});

test("a page reads a file input's button's cursor, and its own", async () => {
  const page = await scriptedPage(
    '<style>#f::file-selector-button{cursor:help} #f{cursor:move}</style>' +
      '<input id="f" type="file"><input id="t"><script>' +
      'var f = document.getElementById("f"), t = document.getElementById("t");' +
      'console.log("cursors " + [getComputedStyle(f, "::file-selector-button").cursor,' +
      '  getComputedStyle(f).cursor, getComputedStyle(t, "::file-selector-button").cursor].join(" "));' +
      '</script>',
  );
  assert.strictEqual(await page.until('cursors'), 'help move text');
  page.result.unmount();
});

/** What the window shows as the pointer goes over each of a document's
 *  elements, in turn, by id: over `ref` between two, whose cursor no
 *  control's is, so that every step is a change, which is when core sets
 *  one. */
async function shownOver(source: string, width = 300) {
  const { node } = await render(source, width);
  await act();
  const el = view(node);
  const drawn = el as unknown as DrawnNode;
  const wnd = (
    drawn as unknown as {
      root: { window: { setCursor(name: string | null): void } };
    }
  ).root.window;
  const shown: (string | null)[] = [];
  const set = wnd.setCursor.bind(wnd);
  wnd.setCursor = (name) => {
    shown.push(name);
    set(name);
  };
  /** `left`: that far into the element from its left edge, where it is
   *  not its middle. */
  const move = async (id: string, left?: number) => {
    let [x, y] = pointIn(el, id);
    if (left !== undefined) {
      const rect = el.elementRect(findById(el.document, id)!)!;
      x = drawn.abs.x + rect.x + left;
    }
    const { abs } = drawn;
    fireEvent.mouseMove(drawn, {
      dx: x - (abs.x + abs.width / 2),
      dy: y - (abs.y + abs.height / 2),
    });
    await act();
    await act();
  };
  const over = async (id: string, left?: number) => {
    await move('ref');
    const before = shown.length;
    await move(id, left);
    return shown.length > before ? shown.at(-1) : 'unchanged';
  };
  return { el, over };
}

/** A column of controls, each its own line, under a page whose cursor is
 *  `wait`, and a reference element of a cursor none of them has. */
const COLUMN =
  '<style>body{margin:0;cursor:wait} input,select,textarea,button{display:block;width:120px;height:22px;margin:2px}' +
  '#ref{cursor:crosshair;height:20px} .na{cursor:not-allowed} .help{cursor:help}' +
  '#fp::file-selector-button{cursor:pointer}</style>' +
  '<div id="ref"></div>';

test('over each widget the window shows what its control computes to, and not what core names for it', async () => {
  const { over } = await shownOver(
    COLUMN +
      '<input id="text"><input id="text-d" disabled><input id="text-na" class="na">' +
      '<input id="check" type="checkbox"><input id="check-na" type="checkbox" class="na">' +
      '<input id="btn" type="button" value="b"><input id="btn-d" type="button" value="b" disabled>' +
      '<input id="btn-na" type="button" value="b" class="na">' +
      '<select id="sel"><option>a</option></select><select id="sel-d" disabled><option>a</option></select>' +
      '<textarea id="ta"></textarea><textarea id="ta-d" disabled></textarea><textarea id="ta-help" class="help"></textarea>' +
      '<input id="range" type="range"><input id="range-na" type="range" class="na">',
  );
  const want: Record<string, string> = {
    // an I-beam over what takes text, and the arrow once it is disabled
    text: 'text',
    'text-d': 'default',
    'text-na': 'not-allowed',
    // the arrow over what is clicked or dragged whole, where core names the
    // pointer, and none of the page's `wait` (csswg-drafts#14251)
    check: 'default',
    'check-na': 'not-allowed',
    btn: 'default',
    // a disabled widget names none, and the document's root, past it, is
    // the I-beam a selectable surface shows
    'btn-d': 'default',
    'btn-na': 'not-allowed',
    sel: 'default',
    'sel-d': 'default',
    ta: 'text',
    'ta-d': 'default',
    'ta-help': 'help',
    range: 'default',
    'range-na': 'not-allowed',
  };
  const got: Record<string, string | null | undefined> = {};
  for (const id of Object.keys(want)) got[id] = await over(id);
  assert.deepStrictEqual(got, want);
});

test("over a file input's button the window shows its ::file-selector-button's cursor, and its own beside it", async () => {
  const { over } = await shownOver(
    COLUMN +
      '<input id="f" type="file" style="width:240px"><input id="fp" type="file" style="width:240px">' +
      '<input id="fna" type="file" class="na" style="width:240px">',
  );
  // the button is the input's first few pixels, and the label of what was
  // chosen is the rest
  assert.strictEqual(await over('f', 8), 'default');
  assert.strictEqual(await over('fp', 8), 'pointer');
  assert.strictEqual(
    await over('fna', 8),
    'default',
    'the button’s, not its own',
  );
  assert.strictEqual(await over('fna', 220), 'not-allowed');
  assert.strictEqual(
    await over('fp', 220),
    'default',
    'its own, not the button’s',
  );
});

test("a restyle in place that changes a field's cursor reaches its widget", async () => {
  // Tailwind's `disabled:cursor-not-allowed` is a class or an attribute
  // the page sets, which restyles the field in place and builds nothing
  const { el, over } = await shownOver(COLUMN + '<input id="a">');
  assert.strictEqual(await over('a'), 'text');
  const a = findById(el.document, 'a')!;
  a.attribs.class = 'na';
  const change: HtmlChange = {
    type: 'attributes',
    target: a,
    attributeName: 'class',
    oldValue: null,
  };
  el.touchDocument([change]);
  await act();
  assert.strictEqual(await over('a'), 'not-allowed');
});

test('over what the document draws, the cursor is the computed one, and `auto` is an I-beam only over text a selection can start in', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<p><span id="t">plain text here</span></p>' +
      '<p style="cursor:default"><span id="def">default text</span></p>' +
      '<p style="user-select:none"><span id="none">unselectable text</span></p>' +
      '<p id="none-text" style="user-select:none"><span id="in" style="user-select:text">taken</span></p>' +
      '<label id="label">a label</label>' +
      '<button id="button">a button</button>' +
      '<details><summary><span id="summary">a summary</span></summary></details>' +
      '<input id="image" type="image" alt="go" style="display:block;width:40px;height:20px">',
    300,
  );
  await act();
  const el = view(node);
  const at = (id: string) => el.cursorAt(...pointIn(el, id));
  assert.strictEqual(at('t'), 'text');
  // `cursor: default` over text stays the arrow
  assert.strictEqual(at('def'), 'default');
  // Blink's `ShouldShowIBeamForNode`: no I-beam where no selection starts
  assert.strictEqual(at('none'), 'default');
  assert.strictEqual(at('in'), 'text');
  // the UA sheet's arrow, where this sheet had the pointer: neither a label
  // nor a button is a link (csswg-drafts#14251)
  assert.strictEqual(at('label'), 'default');
  assert.strictEqual(at('button'), 'default');
  // and no rule for a summary, in any engine: its text's I-beam
  assert.strictEqual(at('summary'), 'text');
  assert.strictEqual(at('image'), 'pointer');
});
