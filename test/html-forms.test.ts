// <Html>'s forms: what a submission carries and where it goes, asked of a
// DOM with no display (src/html/form.ts), and the widgets that start one —
// Enter in a field, a press on a submit button — through the harness.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';

import {
  act,
  cleanup,
  fireEvent,
  renderX11,
  screen,
  userEvent,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { XK_RETURN, XK_SPACE } from 'react-x11/keysyms';

import { Html } from '../src/html/index.js';
import type { FormSubmission, HtmlViewNode } from '../src/html/index.js';
import { HtmlSource } from '../src/html/dom.js';
import type { Element } from '../src/html/dom.js';
import {
  FormState,
  firstInvalid,
  formOwner,
  formSubmission,
  implicitSubmission,
  labeledControl,
  radioGroup,
  validationMessage,
} from '../src/html/form.js';

const h = React.createElement;

afterEach(cleanup);

/** A parsed document, and its elements by id — as getElementById finds
 *  them, so never one inside a <template>. */
function parse(html: string): (id: string) => Element {
  const source = new HtmlSource();
  source.setSource(html, true);
  const doc = source.document;
  return (id: string) => {
    const stack = [...doc.children];
    while (stack.length) {
      const node = stack.shift()!;
      if (node.type !== 'tag') continue;
      const el = node as Element;
      if (el.attribs.id === id) return el;
      if (el.name !== 'template') stack.unshift(...el.children);
    }
    throw new Error(`no #${id}`);
  };
}

const BASE = 'https://example.test/dir/page.html';

function submit(
  html: string,
  submitter: string | null,
  extra: Partial<Parameters<typeof formSubmission>[2]> = {},
  form = 'f',
): FormSubmission {
  const byId = parse(html);
  const out = formSubmission(
    byId(form),
    submitter === null ? null : byId(submitter),
    { base: BASE, boundary: 'BOUNDARY', ...extra },
  );
  assert.ok(out, 'a submission');
  return out;
}

// --- the entry list and the request ----------------------------------------

test("DuckDuckGo Lite's search is a POST of its one named field", () => {
  const s = submit(
    '<form id="f" action="/lite/" method="post">' +
      '<input class="query" type="text" size="40" name="q" value="react x11">' +
      '<input id="go" class="submit" type="submit" value="Search"></form>',
    'go',
  );
  assert.strictEqual(s.method, 'post');
  assert.strictEqual(s.url, 'https://example.test/lite/');
  assert.strictEqual(s.enctype, 'application/x-www-form-urlencoded');
  assert.strictEqual(s.contentType, 'application/x-www-form-urlencoded');
  // the submit button has no name, so it adds nothing
  assert.deepStrictEqual(s.entries, [['q', 'react x11']]);
  assert.strictEqual(s.body, 'q=react+x11');
  assert.strictEqual(s.target, '');
});

test('a GET puts the entries in the query, in place of the one there, and keeps the fragment', () => {
  const s = submit(
    '<form id="f" action="search?old=1#top">' +
      '<input name="q" value="a b&c=d/é"><input name="n" value="1"></form>',
    null,
  );
  assert.strictEqual(s.method, 'get');
  assert.strictEqual(
    s.url,
    'https://example.test/dir/search?q=a+b%26c%3Dd%2F%C3%A9&n=1#top',
  );
  assert.strictEqual(s.body, null);
  assert.strictEqual(s.contentType, null);
  // with nothing to send, the query is there and empty, as a browser's is
  assert.strictEqual(
    submit('<form id="f" action="/x"></form>', null).url,
    'https://example.test/x?',
  );
});

test('an empty action is the document it is in, not its base', () => {
  const html = '<form id="f"><input name="q" value="1"></form>';
  assert.strictEqual(
    submit(html, null, { documentUrl: 'https://example.test/here?x=2' }).url,
    'https://example.test/here?q=1',
  );
  assert.strictEqual(
    submit(html, null).url,
    `${BASE}?q=1`,
    'the base, where that is all it has',
  );
});

test('the urlencoded serializer spares only letters, digits and *-._', () => {
  const s = submit(
    `<form id="f" method="post"><input name="k" value="*-._ !'()~+&amp;=%"></form>`,
    null,
  );
  assert.strictEqual(s.body, 'k=*-._+%21%27%28%29%7E%2B%26%3D%25');
});

test('checked boxes and radios go, with "on" where they have no value; unchecked ones do not', () => {
  const s = submit(
    '<form id="f" method="post">' +
      '<input type="checkbox" name="a" checked>' +
      '<input type="checkbox" name="b" value="yes" checked>' +
      '<input type="checkbox" name="c" value="no">' +
      '<input type="radio" name="r" value="1">' +
      '<input type="radio" name="r" value="2" checked>' +
      '</form>',
    null,
  );
  assert.deepStrictEqual(s.entries, [
    ['a', 'on'],
    ['b', 'yes'],
    ['r', '2'],
  ]);
});

test('a <select> sends what it has selected: the first option by default, every marked one when multiple', () => {
  const s = submit(
    '<form id="f" method="post">' +
      '<select name="one"><option disabled>x</option><option>First</option>' +
      '<option value="2">Second</option></select>' +
      '<select name="marked"><option value="a" selected>A</option>' +
      '<option value="b" selected>B</option></select>' +
      '<select name="many" multiple><option value="a" selected>A</option>' +
      '<optgroup label="g"><option value="b">B</option>' +
      '<option value="c" selected>C</option></optgroup></select>' +
      '<select name="none" multiple><option>A</option></select>' +
      '</form>',
    null,
  );
  assert.deepStrictEqual(s.entries, [
    ['one', 'First'],
    // the parser leaves the last one marked selected
    ['marked', 'b'],
    ['many', 'a'],
    ['many', 'c'],
  ]);
});

test('disabled controls, and those in a disabled fieldset outside its first legend, are left out', () => {
  const s = submit(
    '<form id="f" method="post">' +
      '<input name="off" value="1" disabled>' +
      '<fieldset disabled><legend><input name="legend" value="2"></legend>' +
      '<input name="inside" value="3">' +
      '<legend><input name="second" value="4"></legend></fieldset>' +
      '<fieldset><input name="live" value="5"></fieldset>' +
      '<input value="unnamed"><input name="" value="empty name">' +
      '</form>',
    null,
  );
  assert.deepStrictEqual(s.entries, [
    ['legend', '2'],
    ['live', '5'],
  ]);
});

test('a form owns the controls that name it, and not those that name another', () => {
  const s = submit(
    '<input name="before" value="1" form="f">' +
      '<form id="f" method="post"><input name="in" value="2">' +
      '<input name="away" value="3" form="other">' +
      // (htmlparser2 closes a <datalist> at an <input>, so the markup
      // cannot put one in it; a <template>'s content is inert the same way)
      '<template><input name="inert" value="4"></template></form>' +
      '<form id="other"></form>' +
      '<input name="after" value="6" form="f">' +
      '<input name="stray" value="7" form="missing">',
    null,
  );
  assert.deepStrictEqual(s.entries, [
    ['before', '1'],
    ['in', '2'],
    ['after', '6'],
  ]);
});

test('a form attribute names its form by an id outside a <template>', () => {
  // a <template>'s content is no part of the document, so getElementById
  // never finds an element in it: the first `f` below is the form's
  const html =
    '<template><div id="f"></div></template>' +
    '<form id="f" method="post"></form>' +
    '<input id="in" name="a" value="1" form="f">';
  assert.deepStrictEqual(submit(html, null).entries, [['a', '1']]);
  assert.strictEqual(formOwner(parse(html)('in'))?.name, 'form');
});

test('only the button that submitted goes, and its form* attributes win over the form', () => {
  const html =
    '<base target="named">' +
    '<form id="f" action="/a" method="get">' +
    '<input name="q" value="x">' +
    '<button id="b1" name="go" value="one">One</button>' +
    '<button id="b2" name="go" value="two" formaction="/b" formmethod="post"' +
    ' formenctype="text/plain" formtarget="_blank">Two</button>' +
    '<input id="reset" type="reset" name="r">' +
    '<input type="button" name="plain" value="p">' +
    '</form>';
  const one = submit(html, 'b1');
  assert.deepStrictEqual(one.entries, [
    ['q', 'x'],
    ['go', 'one'],
  ]);
  assert.strictEqual(one.url, 'https://example.test/a?q=x&go=one');
  assert.strictEqual(
    one.target,
    'named',
    "<base target>'s, where it names one",
  );
  const two = submit(html, 'b2');
  assert.strictEqual(two.method, 'post');
  assert.strictEqual(two.url, 'https://example.test/b');
  assert.strictEqual(two.enctype, 'text/plain');
  assert.strictEqual(two.body, 'q=x\r\ngo=two\r\n');
  assert.strictEqual(two.contentType, 'text/plain;charset=UTF-8');
  assert.strictEqual(two.target, '_blank');
});

test("a <base target> inside a <template> is not the document's", () => {
  const s = submit(
    '<template><base target="inert"></template><base target="named">' +
      '<form id="f" action="/a"><input name="q" value="x"></form>',
    null,
  );
  assert.strictEqual(s.target, 'named');
});

test('an image button is the point it was pressed at', () => {
  const html =
    '<form id="f" method="post"><input name="q" value="x">' +
    '<input id="named" type="image" name="map" src="m.png">' +
    '<input id="bare" type="image" src="m.png"></form>';
  assert.deepStrictEqual(
    submit(html, 'named', { point: { x: 12.4, y: 7 } }).entries,
    [
      ['q', 'x'],
      ['map.x', '12'],
      ['map.y', '7'],
    ],
  );
  assert.deepStrictEqual(submit(html, 'bare').entries, [
    ['q', 'x'],
    ['x', '0'],
    ['y', '0'],
  ]);
});

test('multipart/form-data: a part per entry, names escaped, line breaks as CRLF', () => {
  const s = submit(
    '<form id="f" method="post" enctype="MULTIPART/form-data">' +
      '<input name=\'say "hi"\' value="one">' +
      '<textarea name="t">\na\nb</textarea>' +
      '<input type="file" name="upload"></form>',
    null,
  );
  assert.strictEqual(s.contentType, 'multipart/form-data; boundary=BOUNDARY');
  assert.strictEqual(
    s.body,
    '--BOUNDARY\r\nContent-Disposition: form-data; name="say %22hi%22"\r\n\r\none\r\n' +
      '--BOUNDARY\r\nContent-Disposition: form-data; name="t"\r\n\r\na\r\nb\r\n' +
      '--BOUNDARY\r\nContent-Disposition: form-data; name="upload"; filename=""\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n\r\n' +
      '--BOUNDARY--\r\n',
  );
});

test('typed text wins over the markup, sanitized as its type says', () => {
  const byId = parse(
    '<form id="f" method="post">' +
      '<input id="t" name="t" value="markup">' +
      '<input id="e" type="email" name="e">' +
      '<input id="n" type="number" name="n">' +
      '<input type="hidden" name="h" value=" keep\n ">' +
      '<input type="hidden" name="_charset_">' +
      '<textarea id="a" name="a">markup</textarea>' +
      '<input id="d" name="d" dirname="d.dir"></form>',
  );
  const typed = new Map<Element, string>([
    [byId('t'), 'line\none'],
    [byId('e'), '  me@example.test '],
    [byId('n'), '1.'],
    [byId('a'), 'x\ny'],
  ]);
  const s = formSubmission(byId('f'), null, {
    base: BASE,
    live: (el) => typed.get(el),
  })!;
  assert.deepStrictEqual(s.entries, [
    ['t', 'lineone'],
    ['e', 'me@example.test'],
    ['n', ''],
    ['h', ' keep\n '],
    ['_charset_', 'UTF-8'],
    ['a', 'x\ny'],
    ['d', ''],
    ['d.dir', 'ltr'],
  ]);
  assert.strictEqual(
    s.body,
    't=lineone&e=me%40example.test&n=&h=+keep%0D%0A+&_charset_=UTF-8' +
      '&a=x%0D%0Ay&d=&d.dir=ltr',
  );
});

test('method="dialog" submits nothing, and neither does a button from another form', () => {
  const byId = parse(
    '<form id="f" method="dialog"><button id="b">x</button></form>' +
      '<form id="g"><button id="c">y</button></form>',
  );
  assert.strictEqual(
    formSubmission(byId('f'), byId('b'), { base: BASE }),
    null,
  );
  assert.strictEqual(
    formSubmission(byId('f'), byId('c'), { base: BASE }),
    null,
  );
});

// --- Enter in a field ----------------------------------------------------------

test('Enter submits by the default button, or with none when the form has one field', () => {
  const byId = parse(
    '<form id="one"><input id="only"><input type="checkbox" name="c"></form>' +
      '<form id="two"><input id="first"><input id="second" type="email"></form>' +
      '<form id="btn"><input id="a"><input id="b">' +
      '<button type="button">no</button><input id="go" type="submit">' +
      '<button id="later">later</button></form>' +
      '<form id="off"><input id="c"><button disabled>x</button>' +
      '<button id="on">y</button></form>' +
      '<input id="loose">',
  );
  assert.deepStrictEqual(implicitSubmission(byId('only')), {
    form: byId('one'),
    submitter: null,
  });
  assert.strictEqual(
    implicitSubmission(byId('first')),
    null,
    'two fields and no button: Enter is ambiguous',
  );
  assert.deepStrictEqual(implicitSubmission(byId('b')), {
    form: byId('btn'),
    submitter: byId('go'),
  });
  assert.strictEqual(
    implicitSubmission(byId('c')),
    null,
    'a disabled default button is not passed over',
  );
  assert.strictEqual(implicitSubmission(byId('loose')), null, 'no form');
});

// --- the live state --------------------------------------------------------------

test('a reset puts back what the markup said, and only in its own form', () => {
  const byId = parse(
    '<form id="f"><input id="t" value="orig">' +
      '<input id="c" type="checkbox" checked>' +
      '<select id="s"><option id="o1">a</option><option id="o2" selected>b</option></select>' +
      '</form><form id="g"><input id="u" value="other"></form>',
  );
  const state = new FormState();
  state.setTyped(byId('t'), 'typed');
  byId('t').attribs.value = 'typed';
  state.remember(byId('c'));
  delete byId('c').attribs.checked;
  state.remember(byId('s'));
  delete byId('o2').attribs.selected;
  byId('o1').attribs.selected = '';
  state.setTyped(byId('u'), 'kept');

  assert.strictEqual(state.reset(byId('f')), true);
  assert.strictEqual(state.value(byId('t')), 'orig');
  assert.strictEqual(byId('t').attribs.value, 'orig');
  assert.strictEqual(byId('c').attribs.checked, '');
  assert.strictEqual(byId('o1').attribs.selected, undefined);
  assert.strictEqual(byId('o2').attribs.selected, '');
  assert.strictEqual(state.value(byId('u')), 'kept', 'the other form is left');
  assert.strictEqual(state.reset(byId('f')), false, 'nothing left to put back');
});

test("a radio's group is its name in its form, or in no form", () => {
  const byId = parse(
    '<form id="f"><input id="a" type="radio" name="r">' +
      '<input id="b" type="radio" name="r"><input id="x" type="radio" name="s">' +
      '</form><form id="g"><input id="c" type="radio" name="r"></form>' +
      '<input id="d" type="radio" name="r"><input id="e" type="radio" name="r">' +
      '<input id="linked" type="radio" name="r" form="f">',
  );
  assert.deepStrictEqual(radioGroup(byId('a')), [byId('b'), byId('linked')]);
  assert.deepStrictEqual(radioGroup(byId('d')), [byId('e')]);
});

test('a radio inside a <template> is in no group of the document', () => {
  const byId = parse(
    '<input id="a" type="radio" name="r">' +
      '<template><input id="t" type="radio" name="r"></template>' +
      '<input id="b" type="radio" name="r">' +
      '<form id="f"><input id="c" type="radio" name="s">' +
      '<template><input id="u" type="radio" name="s"></template>' +
      '<input id="d" type="radio" name="s"></form>',
  );
  const ids = (radio: string) =>
    radioGroup(byId(radio)).map((el) => el.attribs.id);
  assert.deepStrictEqual(ids('a'), ['b'], 'in no form');
  assert.deepStrictEqual(ids('c'), ['d'], 'in a form');
});

// --- labels and validation --------------------------------------------------------

test('a label is for the control its `for` names, or else the first inside it', () => {
  const byId = parse(
    '<label id="l1" for="t">Name</label><input id="t">' +
      '<label id="l2">Agree <input id="c" type="checkbox"></label>' +
      '<label id="l3" for="h">Hidden</label><input id="h" type="hidden">' +
      '<label id="l4" for="p">Para</label><p id="p">x</p>' +
      '<label id="l5">Nothing</label>' +
      '<label id="l6" for="t"><input id="inner"></label>',
  );
  assert.strictEqual(labeledControl(byId('l1')), byId('t'));
  assert.strictEqual(labeledControl(byId('l2')), byId('c'));
  assert.strictEqual(labeledControl(byId('l3')), null, 'a hidden input');
  assert.strictEqual(labeledControl(byId('l4')), null, 'not a control');
  assert.strictEqual(labeledControl(byId('l5')), null);
  assert.strictEqual(labeledControl(byId('l6')), byId('t'), '`for` wins');
});

test('a label is never for a control inside a <template>', () => {
  // neither the one its `for` would name nor one inside it: a template's
  // content is no part of the document, and no descendant of the label
  const byId = parse(
    '<template><input id="t" name="inert"></template>' +
      '<label id="l1" for="t">Name</label><input id="t" name="named">' +
      '<label id="l2">Agree <template><input type="checkbox" name="inert">' +
      '</template><input type="checkbox" name="inside"></label>',
  );
  assert.strictEqual(labeledControl(byId('l1'))?.attribs.name, 'named');
  assert.strictEqual(labeledControl(byId('l2'))?.attribs.name, 'inside');
});

test("the constraints a document states, in a browser's words", () => {
  const byId = parse(
    '<form id="f">' +
      '<input id="req" required>' +
      '<input id="ok" required value="x">' +
      '<input id="ro" required readonly>' +
      '<input id="off" required disabled>' +
      '<input id="box" type="checkbox" required>' +
      '<input id="r1" type="radio" name="g" required><input id="r2" type="radio" name="g">' +
      '<select id="sel" required><option value="">Choose</option><option>A</option></select>' +
      '<select id="sel2" required><option value="">Choose</option><option selected>A</option></select>' +
      '<input id="mail" type="email" value="not an address">' +
      '<input id="mails" type="email" multiple value="a@b.c, d@e.f">' +
      '<input id="url" type="url" value="example.com">' +
      '<input id="pat" pattern="[0-9]{3}" title="Three digits" value="12">' +
      '<input id="num" type="number" min="1" max="10" value="11">' +
      '<input id="short" minlength="4">' +
      '<textarea id="area" required></textarea>' +
      '</form>',
  );
  const typed = new Map<Element, string>([[byId('short'), 'abc']]);
  const live = (el: Element) => typed.get(el);
  const message = (id: string) => validationMessage(byId(id), live);
  assert.strictEqual(message('req'), 'Please fill out this field.');
  assert.strictEqual(message('ok'), null);
  assert.strictEqual(message('ro'), null, 'readonly is not validated');
  assert.strictEqual(message('off'), null, 'nor is disabled');
  assert.strictEqual(
    message('box'),
    'Please check this box if you want to proceed.',
  );
  assert.strictEqual(message('r1'), 'Please select one of these options.');
  assert.strictEqual(message('r2'), 'Please select one of these options.');
  assert.strictEqual(message('sel'), 'Please select an item in the list.');
  assert.strictEqual(message('sel2'), null);
  assert.strictEqual(message('mail'), 'Please enter an email address.');
  assert.strictEqual(message('mails'), null);
  assert.strictEqual(message('url'), 'Please enter a URL.');
  assert.strictEqual(
    message('pat'),
    'Please match the requested format:\nThree digits',
  );
  assert.strictEqual(message('num'), 'Value must be less than or equal to 10.');
  assert.strictEqual(
    message('short'),
    'Please lengthen this text to 4 characters or more (you are currently using 3 characters).',
  );
  assert.strictEqual(message('area'), 'Please fill out this field.');

  assert.strictEqual(firstInvalid(byId('f'), null, live)?.element, byId('req'));
  typed.set(byId('req'), 'filled');
  byId('box').attribs.checked = '';
  byId('r2').attribs.checked = '';
  assert.strictEqual(message('r1'), null, 'one of the group is checked');
  assert.strictEqual(firstInvalid(byId('f'), null, live)?.element, byId('sel'));
});

test('novalidate and formnovalidate let an invalid form go', () => {
  const byId = parse(
    '<form id="f" novalidate><input required></form>' +
      '<form id="g"><input required><button id="b" formnovalidate>x</button>' +
      '<button id="c">y</button></form>',
  );
  assert.strictEqual(firstInvalid(byId('f'), null), null);
  assert.strictEqual(firstInvalid(byId('g'), byId('b')), null);
  assert.ok(firstInvalid(byId('g'), byId('c')));
});

// --- the widgets -----------------------------------------------------------------

const FONT_CANDIDATES: Array<[string, string]> = [
  [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Monaco.ttf',
  ],
  [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  ],
  [
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSansMono.ttf',
  ],
];
const found = FONT_CANDIDATES.find(([a, b]) => existsSync(a) && existsSync(b));
const FONTS = found ? { 'sans-serif': found[0], monospace: found[1] } : null;
const metric = FONTS ? test : test.skip;

async function renderForm(
  source: string,
  props: Record<string, unknown> = {},
): Promise<{ submitted: FormSubmission[]; doc: HtmlViewNode }> {
  const submitted: FormSubmission[] = [];
  await renderX11(
    h(
      'box',
      { style: { width: 500, flexDirection: 'column' } },
      h(Html, {
        source,
        partial: false,
        baseUrl: 'https://lite.example.test/lite/',
        onSubmit: (s: FormSubmission) => void submitted.push(s),
        'data-testname': 'doc',
        ...props,
      }),
    ),
    { width: 540, height: 300, fonts: FONTS! },
  );
  await act();
  const root = screen.getByTestName('doc') as unknown as {
    children: HtmlViewNode[];
  };
  return { submitted, doc: root.children[0] };
}

/** The button widget that says `label`. */
const button = (label: string) =>
  screen.getByRole('button', { name: label, exact: true }) as DrawnNode;

const DDG =
  '<form action="/lite/" method="post">' +
  '<input class="query" type="text" size="40" name="q" value="" autofocus>' +
  '<input class="submit" type="submit" value="Search"></form>';

metric('typing a query and pressing Enter submits the form', async () => {
  const { submitted } = await renderForm(DDG);
  const field = screen.getByRole('textbox') as DrawnNode;
  await userEvent.type(field, 'react x11');
  await userEvent.key(XK_RETURN, { target: field });
  assert.strictEqual(submitted.length, 1, 'one submission');
  const [s] = submitted;
  assert.strictEqual(s.method, 'post');
  assert.strictEqual(s.url, 'https://lite.example.test/lite/');
  assert.strictEqual(s.body, 'q=react+x11');
  assert.strictEqual(s.submitter?.attribs.value, 'Search');
});

metric('pressing the submit button submits what was typed', async () => {
  const { submitted } = await renderForm(DDG);
  await userEvent.type(screen.getByRole('textbox') as DrawnNode, 'hello');
  await userEvent.click(screen.getByRole('button') as DrawnNode);
  assert.deepStrictEqual(
    submitted.map((s) => s.body),
    ['q=hello'],
  );
});

metric(
  'a <button> the document draws submits its form when pressed',
  async () => {
    const changes: unknown[] = [];
    const { submitted, doc } = await renderForm(
      '<form action="find"><input name="q" value="x">' +
        '<button id="b" name="go" value="1">Go</button>' +
        '<button id="n" type="button">Nothing</button></form>',
      { onControlChange: (_el: unknown, v: unknown) => void changes.push(v) },
    );
    const press = async (id: string) => {
      const target = doc as unknown as DrawnNode;
      const el = doc.document!;
      const button = (function find(nodes: unknown[]): Element | null {
        for (const node of nodes as Element[]) {
          if (node.type !== 'tag') continue;
          if (node.attribs.id === id) return node;
          const inner = find(node.children);
          if (inner) return inner;
        }
        return null;
      })(el.children)!;
      const rect = doc.elementRect(button)!;
      const dx = rect.x + rect.width / 2 - target.abs.width / 2;
      const dy = rect.y + rect.height / 2 - target.abs.height / 2;
      await act(async () => {
        fireEvent.mouseDown(target, { dx, dy });
        fireEvent.mouseUp(target, { dx, dy });
      });
    };
    await press('n');
    assert.strictEqual(submitted.length, 0, 'type=button submits nothing');
    await press('b');
    assert.deepStrictEqual(
      submitted.map((s) => s.url),
      ['https://lite.example.test/lite/find?q=x&go=1'],
    );
    assert.deepStrictEqual(changes, ['', '1'], 'and both presses are reported');
  },
);

metric('a reset button puts the typed text back to the markup', async () => {
  const { submitted } = await renderForm(
    '<form method="post"><input name="q" value="orig">' +
      '<input type="reset" value="Clear"><input type="submit" value="Go"></form>',
  );
  await userEvent.type(screen.getByRole('textbox') as DrawnNode, ' more');
  await userEvent.click(button('Clear'));
  await act();
  assert.strictEqual(
    (screen.getByRole('textbox') as unknown as { value: string }).value,
    'orig',
    'the field shows its markup again',
  );
  // asked for where it is pressed, not held from before the reset: a node a
  // render replaced is nowhere on screen to press
  await userEvent.click(button('Go'));
  assert.deepStrictEqual(
    submitted.map((s) => s.body),
    ['q=orig'],
  );
});

metric(
  'a reset puts the text back in place, and every widget keeps its node and the focus',
  async () => {
    // A reset was in the key every widget was mounted under, so it mounted
    // every control in the document again: the button pressed lost the
    // focus, every field its caret, its scroll and its undo — a field in
    // another form too, which a reset does not touch.
    const { submitted } = await renderForm(
      '<form method="post"><input name="q" value="orig">' +
        '<textarea name="t">start</textarea>' +
        '<input type="reset" value="Clear"><input type="submit" value="Go">' +
        '</form><form><input name="other"></form>',
    );
    const fields = screen.getAllByRole('textbox') as DrawnNode[];
    const buttons = screen.getAllByRole('button') as DrawnNode[];
    const [field, area, other] = fields;
    await userEvent.type(field, ' more');
    await userEvent.type(area, '!');
    await userEvent.type(other, 'kept');
    // from the keyboard, as a browser's reset button is pressed with the
    // focus on it, and keeps it
    const clear = button('Clear');
    await act(() => clear.focus());
    await userEvent.key(XK_SPACE, { target: clear });
    await act();
    const same = (now: DrawnNode[], before: DrawnNode[]) =>
      now.length === before.length && now.every((n, i) => n === before[i]);
    assert.ok(
      same(screen.getAllByRole('textbox') as DrawnNode[], fields),
      'the fields are the widgets they were',
    );
    assert.ok(
      same(screen.getAllByRole('button') as DrawnNode[], buttons),
      'and so are the buttons',
    );
    assert.ok(clear.focused, 'the reset button keeps the focus');
    assert.deepStrictEqual(
      fields.map((node) => (node as unknown as { value: string }).value),
      ['orig', 'start', 'kept'],
      'its own form back to the markup, and the other left as it was',
    );
    await userEvent.click(button('Go'));
    assert.deepStrictEqual(
      submitted.map((s) => s.body),
      ['q=orig&t=start'],
    );
  },
);

metric(
  'a field that layout moves is the same widget, and keeps its focus',
  async () => {
    // Widgets were keyed by where they were, so a stylesheet landing while
    // someone typed — which moves every field on a page — mounted a new
    // one, and the text, the caret and the focus went with the old.
    const doc = (stylesheet: string) =>
      h(
        'box',
        { style: { width: 500, flexDirection: 'column' } },
        h(Html, {
          source: '<form><input name="q"></form>',
          partial: false,
          stylesheet,
          'data-testname': 'doc',
        }),
      );
    const result = await renderX11(doc(''), {
      width: 540,
      height: 200,
      fonts: FONTS!,
    });
    await act();
    const before = screen.getByRole('textbox') as DrawnNode;
    await userEvent.type(before, 'abc');
    const x = before.abs.x;
    await result.rerender(doc('form{margin-left:80px}'));
    await act();
    const after = screen.getByRole('textbox') as DrawnNode;
    assert.ok(after.abs.x > x + 40, 'the field moved');
    assert.ok(after === before, 'and is the widget it was');
    assert.ok(after.focused, 'still focused');
    assert.strictEqual((after as unknown as { value: string }).value, 'abc');
  },
);

metric(
  'typed text in a <textarea> survives the widget mounting again',
  async () => {
    // A textarea's typed text lived nowhere but the widget, so one mounted
    // again — hidden and shown — came back with its markup's text. Checking
    // the box hides this one.
    const { submitted } = await renderForm(
      '<style>#c:checked ~ textarea{display:none}</style>' +
        '<form method="post"><input type="checkbox" id="c">' +
        '<textarea name="t">start</textarea><input type="submit"></form>',
    );
    const area = () => screen.queryByRole('textbox') as DrawnNode | null;
    const before = area()!;
    await userEvent.type(before, '!');
    const typed = (before as unknown as { value: string }).value;
    assert.match(typed, /!/);
    const box = screen.getByRole('checkbox') as DrawnNode;
    await userEvent.click(box);
    await act();
    assert.ok(area() === null, 'hidden, the textarea is not mounted');
    await userEvent.click(screen.getByRole('checkbox') as DrawnNode);
    await act();
    assert.ok(area() !== null && area() !== before, 'mounted again');
    assert.strictEqual(
      (area() as unknown as { value: string }).value,
      typed,
      'with the text typed into the last one',
    );
    await userEvent.click(screen.getByRole('button') as DrawnNode);
    assert.strictEqual(submitted.length, 1);
    assert.strictEqual(
      submitted[0].entries.find(([name]) => name === 't')?.[1],
      typed,
    );
  },
);

metric('without onSubmit, submitting does nothing', async () => {
  await renderX11(
    h(Html, { source: DDG, partial: false, 'data-testname': 'doc' }),
    { width: 540, height: 200, fonts: FONTS! },
  );
  await act();
  const field = screen.getByRole('textbox') as DrawnNode;
  await userEvent.type(field, 'x');
  await userEvent.key(XK_RETURN, { target: field });
  await userEvent.click(screen.getByRole('button') as DrawnNode);
});

/** A press, and its release, on an element the document draws. */
async function pressOn(
  doc: HtmlViewNode,
  id: string,
  at?: { x: number; y: number },
) {
  const target = doc as unknown as DrawnNode;
  const el = (function find(nodes: unknown[]): Element | null {
    for (const node of nodes as Element[]) {
      if (node.type !== 'tag') continue;
      if (node.attribs.id === id) return node;
      const inner = find(node.children);
      if (inner) return inner;
    }
    return null;
  })(doc.document!.children)!;
  const rect = doc.elementRect(el)!;
  const x = rect.x + (at ? at.x : rect.width / 2);
  const y = rect.y + (at ? at.y : rect.height / 2);
  const dx = x - target.abs.width / 2;
  const dy = y - target.abs.height / 2;
  await act(async () => {
    fireEvent.mouseDown(target, { dx, dy });
    fireEvent.mouseUp(target, { dx, dy });
  });
}

metric(
  'a required field that is empty stops the submission, and says why',
  async () => {
    const { submitted } = await renderForm(
      '<form method="post"><input name="q" required>' +
        '<input type="submit" value="Go"></form>',
    );
    await userEvent.click(screen.getByRole('button') as DrawnNode);
    assert.strictEqual(submitted.length, 0, 'nothing is sent');
    const field = screen.getByRole('textbox') as DrawnNode;
    assert.ok(field.focused, 'the field that stopped it has the focus');
    assert.ok(
      screen.queryByText('Please fill out this field.'),
      'and the reason is shown',
    );
    await userEvent.type(field, 'x', { skipClick: true });
    assert.ok(
      !screen.queryByText('Please fill out this field.'),
      'typing into it lets the message go',
    );
    await userEvent.key(XK_RETURN, { target: field });
    assert.deepStrictEqual(
      submitted.map((s) => s.body),
      ['q=x'],
    );
  },
);

metric('a press on a label is one on its control', async () => {
  const { submitted, doc } = await renderForm(
    '<form method="post">' +
      '<label id="agree"><input type="checkbox" name="agree"> I agree</label>' +
      '<label id="for-name" for="name">Name</label> <input id="name" name="n">' +
      '<label id="bare">Labels nothing</label>' +
      '<label id="for-ra" for="ra">A</label>' +
      '<input type="radio" name="r" value="a" id="ra">' +
      '<label id="for-rb" for="rb">B</label>' +
      '<input type="radio" name="r" value="b" id="rb" checked>' +
      '<label id="send">Send <input type="submit" value="Go"></label>' +
      '</form>',
  );
  await pressOn(doc, 'agree', { x: 40, y: 5 });
  const box = screen.getByRole('checkbox') as unknown as { checked: boolean };
  const field = screen.getByRole('textbox') as DrawnNode;
  assert.ok(!field.focused);
  await pressOn(doc, 'for-name');
  assert.ok(field.focused, 'the field is focused');
  await pressOn(doc, 'bare');
  await pressOn(doc, 'for-ra');
  assert.strictEqual(
    submitted.length,
    0,
    'a label for a radio submits nothing',
  );
  await pressOn(doc, 'send', { x: 5, y: 8 });
  assert.strictEqual(submitted.length, 1, 'the button in it was pressed');
  assert.strictEqual(
    submitted[0].body,
    'agree=on&n=&r=a',
    'the box is ticked, and the radio its label is for checked',
  );
  void box;
});

const RED_PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAIUlEQVR4AX3BAQEAAAiDMKR/' +
      '59uA7UaRJEmSJEmSJEmS9EEsAROhAw00AAAAAElFTkSuQmCC',
    'base64',
  ),
);

metric('an image button submits the point it was pressed at', async () => {
  const { submitted, doc } = await renderForm(
    '<form><input name="q" value="x">' +
      '<input id="map" type="image" name="map" src="m.png" alt="Map" width="40" height="20">' +
      '</form>',
    {
      onResource: (r: { kind: string }) =>
        r.kind === 'image' ? { kind: 'image' as const, bytes: RED_PNG } : null,
    },
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  // No widget: it is drawn. The one button an assistive technology finds
  // is the box that takes the keyboard's focus for it, which draws nothing.
  const buttons = screen.queryAllByRole('button') as unknown as {
    props: Record<string, unknown>;
    children: unknown[];
  }[];
  assert.deepStrictEqual(
    buttons.map((b) => [b.props['aria-label'], b.children.length]),
    [['Map', 0]],
    'no widget: it is drawn',
  );
  await pressOn(doc, 'map', { x: 12, y: 7 });
  assert.strictEqual(submitted.length, 1);
  const [q, x, y] = submitted[0].entries;
  assert.deepStrictEqual(q, ['q', 'x']);
  assert.deepStrictEqual([x[0], y[0]], ['map.x', 'map.y']);
  // the harness puts the pointer at a node's centre plus an offset, which
  // rounds to the pixel
  assert.ok(Math.abs(Number(x[1]) - 12) <= 1, `x ${x[1]}`);
  assert.ok(Math.abs(Number(y[1]) - 7) <= 1, `y ${y[1]}`);
});

metric(
  'an image button with no image is a button saying what it is for',
  async () => {
    const { submitted } = await renderForm(
      '<form><input type="image" name="go" src="m.png" alt="Search"></form>',
    );
    const button = screen.getByRole('button') as DrawnNode;
    assert.ok(screen.queryByText('Search'), 'labelled with its alt');
    await userEvent.click(button);
    assert.deepStrictEqual(
      submitted.map((s) => s.url),
      ['https://lite.example.test/lite/?go.x=0&go.y=0'],
    );
  },
);

metric(
  'autofocus takes the focus, where nothing else in the window has it',
  async () => {
    await renderForm(
      DDG.replace('<input class="query"', '<input autofocus class="query"'),
    );
    await act();
    assert.ok((screen.getByRole('textbox') as DrawnNode).focused, 'focused');
    cleanup();
    // a field of the application's own, focused first, keeps it
    await renderX11(
      h(
        'box',
        { style: { width: 500, flexDirection: 'column' } },
        // focused as it mounts, before the page's controls are laid out
        h('textinput', {
          'data-testname': 'own',
          ref: (node: DrawnNode | null) => void node?.focus(),
        } as never),
        h(Html, {
          source: DDG.replace(
            '<input class="query"',
            '<input autofocus class="query"',
          ),
          partial: false,
        }),
      ),
      { width: 540, height: 300, fonts: FONTS! },
    );
    await act();
    const own = screen.getByTestName('own') as DrawnNode;
    const [, page] = screen.getAllByRole('textbox') as DrawnNode[];
    assert.ok(own.focused, "the application's field keeps the focus");
    assert.ok(!page.focused);
  },
);

metric(
  'maxlength holds a field to its length as it is typed into',
  async () => {
    const { submitted } = await renderForm(
      '<form method="post"><input name="q" maxlength="3"></form>',
    );
    const field = screen.getByRole('textbox') as DrawnNode;
    await userEvent.type(field, 'abcdef');
    await userEvent.key(XK_RETURN, { target: field });
    assert.deepStrictEqual(
      submitted.map((s) => s.body),
      ['q=abc'],
    );
  },
);
