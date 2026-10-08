// <Html> — what a host that runs a page's scripts needs of it, none of which
// runs anything: `scripting`, the events told before their defaults
// (`onDomEvent`), a control's live value, the focus, a link or a button
// activated, a form sent, validated or reset, the parse and the load, and
// an element's computed style. docs/prd-html-scripts.md is the design.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import {
  act,
  cleanup,
  fireEvent,
  renderX11,
  screen,
  userEvent,
} from 'react-x11/test';
import { ThemeProvider } from 'react-x11';
import type { DrawnNode } from 'react-x11';
import { XK_RETURN } from 'react-x11/keysyms';
import { appendChild, findOne } from 'domutils';
import { Element as DomElement } from 'domhandler';
import { Html, useHtmlHandle } from '../../src/html/index.js';
import type {
  FormSubmission,
  HtmlDomEvent,
  HtmlHandle,
  HtmlViewNode,
  ResourceRequest,
  ResourceResult,
} from '../../src/html/index.js';
import type { Element as DocElement } from '../../src/html/dom.js';
import { FONTS, boxOf, findById, h, metric, render, view } from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

/** A document whose events are recorded, and cancelled where `cancel`
 *  says; its form submissions and its links recorded too. */
async function hosted(source: string, props: Record<string, unknown> = {}) {
  const events: HtmlDomEvent[] = [];
  const links: string[] = [];
  const submitted: FormSubmission[] = [];
  const state = { cancel: (_e: HtmlDomEvent) => false };
  const { result, node } = await render(source, 400, {
    onDomEvent: (e: HtmlDomEvent) => {
      events.push(e);
      return state.cancel(e) ? false : undefined;
    },
    onLink: (href: string) => void links.push(href),
    onSubmit: (s: FormSubmission) => void submitted.push(s),
    baseUrl: 'https://example.test/page',
    ...props,
  });
  await act();
  const el = view(node);
  const byId = (id: string) => findById(el.document, id) as DocElement;
  /** Each event as `type:id`, or its tag where it has no id. */
  const told = (types?: string[]) =>
    events
      .filter((e) => !types || types.includes(e.type))
      .map((e) => `${e.type}:${e.target.attribs.id ?? e.target.name}`);
  return { result, el, events, links, submitted, state, byId, told };
}

/** A press and a release in an element, as a click is: in its middle, or
 *  `across` its width. */
async function clickOn(el: HtmlViewNode, target: DocElement, across = 0.5) {
  const node = el as unknown as DrawnNode;
  const rect = el.elementRect(target)!;
  const dx = rect.x + rect.width * across - node.abs.width / 2;
  const dy = rect.y + rect.height / 2 - node.abs.height / 2;
  await act(async () => {
    fireEvent.mouseDown(node, { dx, dy });
    fireEvent.mouseUp(node, { dx, dy });
  });
}

const textbox = () => screen.getByRole('textbox') as DrawnNode;

// --- scripting ---------------------------------------------------------------

test('with scripting on, a <noscript> is nothing: drawn as none, asked for nothing, its scripts no scripts', async () => {
  const asked: string[] = [];
  const scripts: string[] = [];
  const source =
    '<style>@media (scripting: enabled) { #s { color: #00ff00 } }' +
    ' @media (scripting: none) { #s { color: #ff0000 } }</style>' +
    '<p id="s">s</p><noscript><p id="n">no</p><img src="ns.png">' +
    '<script src="inner.js"></script></noscript><img src="shown.png">';
  const props = (scripting: boolean) => ({
    scripting,
    onResource: (r: { url: string }) => {
      asked.push(r.url);
      return null;
    },
    onScript: (s: { src: string | null }) => void scripts.push(s.src ?? ''),
  });
  const on = await render(source, 300, props(true));
  const el = view(on.node);
  const color = (id: string) =>
    (boxOf(el, id) as LaidBox & { style: { color: string } }).style.color;
  assert.strictEqual(color('s'), '#00ff00', '(scripting: enabled) holds');
  assert.throws(() => boxOf(el, 'n'), 'nothing in the noscript is drawn');
  assert.deepStrictEqual(asked, ['shown.png']);
  assert.deepStrictEqual(scripts, []);
  cleanup();
  asked.length = 0;
  const off = await render(source, 300, props(false));
  const without = view(off.node);
  assert.strictEqual(
    (boxOf(without, 's') as LaidBox & { style: { color: string } }).style.color,
    '#ff0000',
    'and without it, (scripting: none)',
  );
  assert.ok(boxOf(without, 'n'), 'a noscript is drawn');
  assert.deepStrictEqual(asked.sort(), ['ns.png', 'shown.png']);
});

test('a noscript the page shows again stays hidden where scripts run', async () => {
  const { node } = await render(
    '<style>noscript { display: block !important }</style>' +
      '<noscript><p id="n">no</p></noscript>',
    300,
    { scripting: true },
  );
  assert.throws(() => boxOf(view(node), 'n'));
});

// --- pointer events ----------------------------------------------------------

metric(
  'a click is told after its press and its release, and a cancelled one follows no link',
  async () => {
    const doc = await hosted(
      '<style>body{margin:0}</style><p><a id="a" href="/next">a <b id="b">link</b></a></p>',
    );
    await clickOn(doc.el, doc.byId('b'));
    assert.deepStrictEqual(doc.told(), ['mousedown:b', 'mouseup:b', 'click:b']);
    assert.deepStrictEqual(doc.links, ['https://example.test/next']);
    const click = doc.events.find((e) => e.type === 'click')!;
    assert.strictEqual(click.button, 0, "the DOM's numbering");
    assert.strictEqual(click.detail, 1);
    assert.strictEqual(click.cancelable, true);
    const rect = doc.el.elementRect(doc.byId('b'))!;
    assert.ok(
      Math.abs(click.x! - (rect.x + rect.width / 2)) < 1 &&
        Math.abs(click.y! - (rect.y + rect.height / 2)) < 1,
      "in the document's coordinates",
    );
    doc.state.cancel = (e) => e.type === 'click';
    // elsewhere in it: two at one point are a double click, which selects
    // a word, and a link with text selected is not followed either way
    await clickOn(doc.el, doc.byId('b'), 0.9);
    assert.deepStrictEqual(doc.told(['click', 'dblclick']), [
      'click:b',
      'click:b',
    ]);
    assert.strictEqual(doc.links.length, 1, 'cancelled: no link followed');
  },
);

metric(
  'a cancelled click on a button the document draws submits nothing',
  async () => {
    const doc = await hosted(
      '<form action="/go"><input type="hidden" name="q" value="1">' +
        '<button id="b">Go</button></form>',
    );
    doc.state.cancel = (e) => e.type === 'click';
    await clickOn(doc.el, doc.byId('b'));
    assert.deepStrictEqual(doc.told(['click', 'submit']), ['click:b']);
    assert.strictEqual(doc.submitted.length, 0);
    doc.state.cancel = () => false;
    await clickOn(doc.el, doc.byId('b'));
    assert.deepStrictEqual(doc.submitted.length, 1);
  },
);

metric(
  'a box is ticked, then its click is asked about, and a cancelled one puts it back',
  async () => {
    const doc = await hosted(
      '<form><input id="c" type="checkbox" name="c"></form>',
    );
    const box = screen.getByRole('checkbox') as DrawnNode;
    const seen: boolean[] = [];
    doc.state.cancel = (e) => {
      if (e.type === 'click')
        seen.push(doc.el.interactive!.controlValue(e.target) as boolean);
      return e.type === 'click';
    };
    await userEvent.click(box);
    assert.deepStrictEqual(seen, [true], 'ticked as the click is told');
    assert.strictEqual(
      doc.byId('c').attribs.checked,
      undefined,
      'and put back',
    );
    assert.deepStrictEqual(doc.told(['click', 'input', 'change']), ['click:c']);
    doc.state.cancel = () => false;
    doc.events.length = 0;
    await userEvent.click(box);
    assert.strictEqual(doc.byId('c').attribs.checked, '');
    assert.deepStrictEqual(doc.told(['click', 'input', 'change']), [
      'click:c',
      'input:c',
      'change:c',
    ]);
  },
);

metric('a click on a label is a click on its control', async () => {
  const doc = await hosted(
    '<label id="l"><input id="c" type="checkbox"> agree</label>',
  );
  const rect = doc.el.elementRect(doc.byId('l'))!;
  const node = doc.el as unknown as DrawnNode;
  await act(async () => {
    const dx = rect.x + rect.width - 10 - node.abs.width / 2;
    const dy = rect.y + rect.height / 2 - node.abs.height / 2;
    fireEvent.mouseDown(node, { dx, dy });
    fireEvent.mouseUp(node, { dx, dy });
  });
  assert.deepStrictEqual(doc.told(['click', 'change']), [
    'click:l',
    'click:c',
    'change:c',
  ]);
  assert.strictEqual(doc.byId('c').attribs.checked, '');
});

metric('a summary opens its details after its click, and says so', async () => {
  const doc = await hosted(
    '<details id="d"><summary id="s">more</summary><p>inside</p></details>',
  );
  doc.state.cancel = (e) => e.type === 'click';
  await clickOn(doc.el, doc.byId('s'));
  assert.strictEqual(doc.byId('d').attribs.open, undefined);
  doc.state.cancel = () => false;
  // somewhere else in it: two at one point are a double click, which
  // selects a word, and a summary's text selected is being read
  await clickOn(doc.el, doc.byId('s'), 0.9);
  assert.strictEqual(doc.byId('d').attribs.open, '');
  assert.deepStrictEqual(doc.told(['click', 'toggle']), [
    'click:s',
    'click:s',
    'toggle:d',
  ]);
});

// --- forms -------------------------------------------------------------------

metric(
  'a submit is told after validation and before the entries are built',
  async () => {
    const doc = await hosted(
      '<form id="f" action="/s"><input id="t" name="t" type="hidden">' +
        '<input id="r" name="r" required><input id="go" type="submit"></form>',
    );
    const go = screen.getByRole('button') as DrawnNode;
    await userEvent.click(go);
    assert.deepStrictEqual(
      doc.told(['submit']),
      [],
      'an invalid form is not submitted, so says no submit',
    );
    await userEvent.type(textbox(), 'x');
    doc.state.cancel = (e) => {
      // what a handler fills in is sent
      if (e.type === 'submit') {
        assert.strictEqual(e.submitter?.attribs.id, 'go');
        doc.byId('t').attribs.value = 'filled';
      }
      return false;
    };
    await userEvent.click(go);
    assert.deepStrictEqual(doc.told(['click', 'submit']).slice(-2), [
      'click:go',
      'submit:f',
    ]);
    assert.deepStrictEqual(
      doc.submitted.map((s) => s.url),
      ['https://example.test/s?t=filled&r=x'],
    );
    doc.state.cancel = (e) => e.type === 'submit';
    await userEvent.click(go);
    assert.strictEqual(
      doc.submitted.length,
      1,
      'a cancelled submit sends nothing',
    );
  },
);

metric(
  'typing is input as it goes, and a change once it is left or sent',
  async () => {
    const doc = await hosted(
      '<form id="f" action="/s"><input id="a" name="a"><input id="b" name="b">' +
        '<input type="submit"></form>',
    );
    const [a, b] = screen.getAllByRole('textbox') as DrawnNode[];
    await userEvent.type(a, 'hi');
    assert.deepStrictEqual(doc.told(['input', 'change']), [
      'input:a',
      'input:a',
    ]);
    await userEvent.click(b);
    await act();
    assert.deepStrictEqual(doc.told(['change', 'focusout', 'focusin']), [
      'focusin:a',
      'change:a',
      'focusout:a',
      'focusin:b',
    ]);
    const into = doc.events.filter((e) => e.type === 'focusin').at(-1)!;
    assert.strictEqual(into.relatedTarget?.attribs.id, 'a');
    doc.events.length = 0;
    await userEvent.type(b, 'yo', { skipClick: true });
    await userEvent.key(XK_RETURN, { target: b });
    assert.deepStrictEqual(doc.told(['change', 'submit']), [
      'change:b',
      'submit:f',
    ]);
  },
);

metric('a keydown the host cancels is never typed', async () => {
  const doc = await hosted('<input id="a">');
  doc.state.cancel = (e) => e.type === 'keydown' && e.key === 'x';
  await userEvent.type(textbox(), 'axb');
  assert.strictEqual(doc.el.interactive!.controlValue(doc.byId('a')), 'ab');
  const keys = doc.events.filter((e) => e.type === 'keydown');
  assert.deepStrictEqual(
    keys.map((e) => [e.key, e.code, e.target.attribs.id]),
    [
      ['a', 'KeyA', 'a'],
      ['x', 'KeyX', 'a'],
      ['b', 'KeyB', 'a'],
    ],
  );
});

metric(
  "a field's value is what was typed, and its value attribute stays its default",
  async () => {
    const doc = await hosted(
      '<p id="p">p</p><input id="a" value="start"><input id="c" type="checkbox">' +
        '<select id="s"><option value="1">one</option><option value="2">two</option></select>',
    );
    const api = doc.el.interactive!;
    const field = textbox();
    await userEvent.type(field, '!', { skipClick: false });
    assert.strictEqual(api.controlValue(doc.byId('a')), 'start!');
    assert.strictEqual(doc.byId('a').attribs.value, 'start', 'the default');
    // set as a script sets it: in the widget there is, its focus kept, and
    // nothing told
    doc.events.length = 0;
    assert.ok(field.focused);
    assert.strictEqual(api.setControlValue(doc.byId('a'), 'set'), true);
    assert.strictEqual((field as unknown as { value: string }).value, 'set');
    assert.strictEqual(textbox(), field, 'the same widget');
    assert.ok(field.focused, 'still focused');
    assert.strictEqual(api.controlValue(doc.byId('a')), 'set');
    assert.deepStrictEqual(doc.told(), []);
    assert.strictEqual(api.controlValue(doc.byId('c')), false);
    api.setControlValue(doc.byId('c'), true);
    assert.strictEqual(api.controlValue(doc.byId('c')), true);
    assert.strictEqual(api.controlValue(doc.byId('s')), '1');
    api.setControlValue(doc.byId('s'), '2');
    assert.strictEqual(api.controlValue(doc.byId('s')), '2');
    assert.strictEqual(api.controlValue(doc.byId('p')), null, 'no control');
  },
);

metric('forms are sent, checked and put back as a script asks', async () => {
  const doc = await hosted(
    '<form id="f" action="/s"><input id="r" name="r" required value="">' +
      '<input id="x" name="x" value="orig"></form>',
  );
  const api = doc.el.interactive!;
  assert.strictEqual(api.reportValidity(doc.byId('f'), null), false);
  await act();
  assert.ok(screen.queryByText('Please fill out this field.'));
  // `submit()` asks no question and tells no submit
  api.submit(doc.byId('f'), null);
  assert.deepStrictEqual(
    doc.submitted.map((s) => s.url),
    ['https://example.test/s?r=&x=orig'],
  );
  assert.deepStrictEqual(doc.told(['submit']), []);
  api.setControlValue(doc.byId('x'), 'changed');
  api.reset(doc.byId('f'));
  assert.strictEqual(api.controlValue(doc.byId('x')), 'orig');
});

// --- focus and activation ----------------------------------------------------

metric(
  'focus goes where a script sends it, and activeElement says where it is',
  async () => {
    const doc = await hosted(
      '<p><a id="a" href="/a">a</a> <span id="t" tabindex="-1">t</span></p>' +
        '<input id="i"><p id="plain">plain</p>',
    );
    const api = doc.el.interactive!;
    assert.strictEqual(api.activeElement(), null);
    assert.strictEqual(api.focus(doc.byId('a')), true);
    await act();
    assert.strictEqual(api.activeElement()?.attribs.id, 'a');
    assert.strictEqual(doc.el.focusedElement?.attribs.id, 'a', ':focus');
    api.focus(doc.byId('i'));
    await act();
    assert.strictEqual(api.activeElement()?.attribs.id, 'i');
    assert.ok(textbox().focused);
    assert.strictEqual(
      api.focus(doc.byId('t')),
      true,
      'a tabindex of -1 takes it',
    );
    await act();
    assert.strictEqual(api.activeElement()?.attribs.id, 't');
    assert.strictEqual(
      api.focus(doc.byId('plain')),
      false,
      'plain text takes none',
    );
    api.blur();
    await act();
    assert.strictEqual(api.activeElement(), null);
    assert.deepStrictEqual(doc.told(['focusin', 'focusout']), [
      'focusin:a',
      'focusout:a',
      'focusin:i',
      'focusout:i',
      'focusin:t',
      'focusout:t',
    ]);
  },
);

metric('Enter on a link is a click, which the host may cancel', async () => {
  const doc = await hosted('<a id="a" href="/a">a</a>');
  doc.el.interactive!.focus(doc.byId('a'));
  await act();
  doc.state.cancel = (e) => e.type === 'click';
  await userEvent.key(XK_RETURN);
  assert.deepStrictEqual(doc.links, []);
  const click = doc.events.find((e) => e.type === 'click')!;
  assert.strictEqual(click.detail, 0, 'a click the keyboard made');
  doc.state.cancel = () => false;
  await userEvent.key(XK_RETURN);
  assert.deepStrictEqual(doc.links, ['https://example.test/a']);
});

metric('activate runs what a click does, and tells no click', async () => {
  const doc = await hosted(
    '<a id="a" href="/a">a</a><form id="f" action="/s">' +
      '<input name="q" value="1"><button id="b">go</button></form>' +
      '<details id="d"><summary id="s">s</summary></details><p id="p">p</p>',
  );
  const api = doc.el.interactive!;
  assert.strictEqual(api.activate(doc.byId('a')), true);
  assert.deepStrictEqual(doc.links, ['https://example.test/a']);
  assert.strictEqual(api.activate(doc.byId('b')), true);
  assert.deepStrictEqual(doc.told(['click', 'submit']), ['submit:f']);
  assert.strictEqual(doc.submitted.length, 1);
  api.activate(doc.byId('s'));
  assert.strictEqual(doc.byId('d').attribs.open, '');
  assert.strictEqual(api.activate(doc.byId('p')), false);
});

// --- the parse and the load --------------------------------------------------

test('onParsed is once the parse ends, and onLoaded once what it asked for has come', async () => {
  const seen: string[] = [];
  let answer!: (r: null) => void;
  const doc = (source: string, partial: boolean) =>
    h(
      'box',
      { style: { width: 300 } },
      h(Html, {
        source,
        partial,
        onResource: () => new Promise<null>((ok) => (answer = ok)),
        onParsed: () => seen.push('parsed'),
        onLoaded: () => seen.push('loaded'),
      }),
    );
  const head = '<p>a</p>';
  const result = await renderX11(doc(head, true), { backend: 'mock' });
  await act();
  assert.deepStrictEqual(seen, [], 'still parsing');
  await act(() => result.rerender(doc(`${head}<img src="i.png">`, false)));
  await act();
  assert.deepStrictEqual(seen, ['parsed'], 'the image is on its way');
  await act(async () => answer(null));
  await act();
  assert.deepStrictEqual(seen, ['parsed', 'loaded']);
  await act(() => result.rerender(doc(`${head}<img src="i.png">`, false)));
  await act();
  assert.deepStrictEqual(seen, ['parsed', 'loaded'], 'once a document');
});

test("a <link>'s sheet is told as a load once it and what it imports are applied, and as an error where it is not to be had", async () => {
  // each sheet answered when the test says, by its file's name
  const answers = new Map<string, (r: ResourceResult | null) => void>();
  const onResource = (r: ResourceRequest) =>
    new Promise<ResourceResult | null>((ok) =>
      answers.set(r.url.slice(r.url.lastIndexOf('/') + 1), ok),
    );
  const sheet = (name: string, text: string | null) =>
    answers.get(name)!(text === null ? null : { kind: 'stylesheet', text });
  const doc = await hosted(
    '<html><head><link id="a" rel="stylesheet" href="a.css">' +
      '<link id="b" rel="stylesheet" href="b.css">' +
      '<link id="c" rel="stylesheet" href="c.css"></head>' +
      '<body><p id="p">x</p></body></html>',
    { onResource },
  );
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await act();
  };
  const sheets = () => doc.told(['load', 'error']);
  assert.deepStrictEqual(sheets(), [], 'all three on their way');
  // what the document is drawn in when it hears a sheet loaded: a page
  // takes the sheet before out then, and must not show neither
  let drawnAtLoad: string | null = null;
  doc.state.cancel = (e) => {
    if (e.type === 'load' && e.target.attribs.id === 'a') {
      const drawn = (doc.el as unknown as { _tree: unknown })._tree;
      drawnAtLoad = drawn
        ? (boxOf(doc.el, 'p') as unknown as { style: { color: string } }).style
            .color
        : 'nothing drawn';
    }
    return false;
  };

  await act(async () => {
    sheet('a.css', '@import "i.css"; #p { color: #ff0000 }');
    sheet('b.css', null);
    sheet('c.css', '');
  });
  await settle();
  assert.deepStrictEqual(
    sheets(),
    ['error:b', 'load:c'],
    'a declined sheet is an error and an empty one is in; one whose import is on its way is not',
  );

  await act(async () => sheet('i.css', '#p { background: #00ff00 }'));
  await settle();
  assert.deepStrictEqual(sheets(), ['error:b', 'load:c', 'load:a']);
  assert.strictEqual(drawnAtLoad, '#ff0000', 'told once its rules are drawn');
  const p = doc.el.computedStyle(doc.byId('p'))!;
  assert.strictEqual(p.color, 'rgb(255, 0, 0)');
  assert.strictEqual(p['background-color'], 'rgb(0, 255, 0)');

  doc.el.touchDocument();
  await settle();
  assert.strictEqual(sheets().length, 3, 'each told once');

  // A link put in for a sheet the document has already is told once a
  // restyle reads it, with nothing asked; one whose import fails is an
  // error; and one given another `href` is told again, for that one.
  const head = findOne((e) => e.name === 'head', doc.el.document.children)!;
  appendChild(
    head,
    new DomElement('link', { id: 'd', rel: 'stylesheet', href: 'a.css' }),
  );
  appendChild(
    head,
    new DomElement('link', { id: 'e', rel: 'stylesheet', href: 'e.css' }),
  );
  doc.el.touchDocument();
  await settle();
  assert.deepStrictEqual(sheets().slice(3), ['load:d']);
  await act(async () => sheet('e.css', '@import "gone.css";'));
  await settle();
  await act(async () => sheet('gone.css', null));
  await settle();
  assert.deepStrictEqual(sheets().slice(3), ['load:d', 'error:e']);
  doc.byId('b').attribs.href = 'c.css';
  doc.el.touchDocument();
  await settle();
  assert.deepStrictEqual(sheets().slice(3), ['load:d', 'error:e', 'load:b']);
  assert.ok(
    doc.events.every((e) => !e.cancelable),
    'told after the fact: nothing to cancel',
  );
});

test('scriptsUnblocked settles once the sheets the parser met before a script are in, after their load; one under a media query that does not hold, and one a script put in, hold nothing', async () => {
  const answers = new Map<string, (r: ResourceResult | null) => void>();
  const onResource = (r: ResourceRequest) =>
    new Promise<ResourceResult | null>((ok) =>
      answers.set(r.url.slice(r.url.lastIndexOf('/') + 1), ok),
    );
  const sheet = (name: string, text: string | null) =>
    answers.get(name)!(text === null ? null : { kind: 'stylesheet', text });
  const doc = await hosted(
    '<html><head><script id="s0"></script>' +
      '<link id="a" rel="stylesheet" href="a.css">' +
      '<link id="m" rel="stylesheet" href="m.css" media="(max-width: 10px)">' +
      '<style>@import "i.css";</style><script id="s1"></script></head>' +
      '<body><link id="b" rel="stylesheet" href="b.css">' +
      '<p id="p">x</p><script id="s2"></script></body></html>',
    { onResource },
  );
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await act();
  };
  // the sheets told of and the scripts let go, in the order they were
  const log: string[] = [];
  doc.state.cancel = (e) => {
    if (e.type === 'load' || e.type === 'error') {
      log.push(`${e.type}:${e.target.attribs.id}`);
    }
    return false;
  };
  const wait = (id: string | null) =>
    doc.el
      .scriptsUnblocked(id === null ? null : doc.byId(id))
      .then(() => void log.push(`run:${id ?? 'deferred'}`));
  void wait('s0');
  void wait('s1');
  void wait('s2');
  void wait(null);
  await settle();
  assert.deepStrictEqual(log, ['run:s0'], 'no sheet before the first');

  await act(async () => sheet('a.css', '#p { color: #ff0000 }'));
  await settle();
  assert.deepStrictEqual(
    log,
    ['run:s0', 'load:a'],
    'what a <style> imports holds what is after it as well',
  );
  await act(async () => sheet('i.css', '#p { background: #00ff00 }'));
  await settle();
  assert.deepStrictEqual(log, ['run:s0', 'load:a', 'run:s1']);
  const p = doc.el.computedStyle(doc.byId('p'))!;
  assert.strictEqual(p.color, 'rgb(255, 0, 0)');
  assert.strictEqual(p['background-color'], 'rgb(0, 255, 0)');

  // a sheet a script puts in, before the script still waiting, holds
  // nothing; the body's link it comes after does
  const head = findOne((e) => e.name === 'head', doc.el.document.children)!;
  appendChild(
    head,
    new DomElement('link', { id: 'x', rel: 'stylesheet', href: 'x.css' }),
  );
  doc.el.touchDocument();
  await settle();
  assert.deepStrictEqual(log.slice(3), []);
  await act(async () => sheet('b.css', null));
  await settle();
  assert.deepStrictEqual(
    log.slice(3),
    ['error:b', 'run:s2', 'run:deferred'],
    'a sheet that failed holds nothing, and is told before what it held',
  );

  // a parser's link given another sheet holds a script until it comes,
  // and a waiting host hears when the document goes
  doc.byId('a').attribs.href = 'z.css';
  doc.el.touchDocument();
  await settle();
  let gone = false;
  void doc.el.scriptsUnblocked(doc.byId('s1')).then(() => (gone = true));
  await settle();
  assert.strictEqual(gone, false);
  await cleanup();
  await settle();
  assert.strictEqual(gone, true);
});

// --- computed style ----------------------------------------------------------

test('computedStyle answers in CSS pixels and rgb(), the box as laid out', async () => {
  const { node } = await renderX11(
    h(
      'box',
      { style: { width: 300 } },
      h(Html, {
        source:
          '<style>body{margin:0} #b{width:50%;padding:4px;margin:3px 10%;' +
          'color:#ff0000;background:rgba(0,0,255,.5);border:2px solid}' +
          ' #b::before{content:"x";color:#00ff00} .h{display:none}</style>' +
          '<div id="b">box</div><div class="h"><span id="in">in</span></div>',
        partial: false,
        'data-testname': 'doc',
      }),
    ),
    { backend: 'mock', scale: 2 },
  ).then(() => ({ node: screen.getByTestName('doc') as DrawnNode }));
  const el = view(node);
  const style = el.computedStyle(findById(el.document, 'b') as DocElement)!;
  assert.strictEqual(style.color, 'rgb(255, 0, 0)');
  assert.strictEqual(style['background-color'], 'rgba(0, 0, 255, 0.5)');
  assert.strictEqual(style.width, '150px', 'used, in CSS pixels at 2x');
  assert.strictEqual(style['padding-left'], '4px');
  assert.strictEqual(style['margin-left'], '30px', 'a percentage resolved');
  assert.strictEqual(style['border-top-width'], '2px');
  assert.strictEqual(style.display, 'block');
  const before = el.computedStyle(
    findById(el.document, 'b') as DocElement,
    'before',
  );
  assert.strictEqual(before?.color, 'rgb(0, 255, 0)');
  const inside = el.computedStyle(findById(el.document, 'in') as DocElement);
  assert.strictEqual(inside?.display, 'inline', 'one with no box has one');
});

test('computedStyle reads color-scheme as Chrome does: the schemes as written, inherited, and normal where none is', async () => {
  const { node } = await render(
    '<style>#a { color-scheme: Light   DARK } #b { color-scheme: only dark }' +
      ' #c { color-scheme: dark Foo }</style>' +
      '<div id="a"><span id="in">x</span></div><div id="b"></div>' +
      '<div id="c"></div><div id="n"></div>',
  );
  const el = view(node);
  const scheme = (id: string) =>
    el.computedStyle(findById(el.document, id) as DocElement)?.['color-scheme'];
  assert.strictEqual(scheme('a'), 'light dark');
  assert.strictEqual(scheme('in'), 'light dark', 'inherited');
  assert.strictEqual(scheme('b'), 'dark only', '`only` last');
  assert.strictEqual(scheme('c'), 'dark Foo', 'a name as written');
  assert.strictEqual(scheme('n'), 'normal');
});

test("a <meta name=color-scheme> draws the page in its scheme and leaves the root's color-scheme normal", async () => {
  const { node } = await render(
    '<html><head><meta name="color-scheme" content="dark">' +
      '<style>p { color: light-dark(#000000, #ffffff) }</style></head>' +
      '<body><p id="p">x</p></body></html>',
  );
  const el = view(node);
  const root = findOne((e) => e.name === 'html', el.document.children)!;
  assert.strictEqual(el.computedStyle(root)?.['color-scheme'], 'normal');
  const p = el.computedStyle(findById(el.document, 'p') as DocElement)!;
  assert.strictEqual(p['color-scheme'], 'normal');
  assert.strictEqual(p.color, 'rgb(255, 255, 255)', 'drawn in dark');
});

// --- the handle ---------------------------------------------------------------

test("matchMedia answers as the document's @media rules do: its width in CSS pixels, the palette's scheme, the motion it is asked for, and scripting", async () => {
  let handle!: HtmlHandle;
  function App() {
    const own = useHtmlHandle();
    handle = own;
    return h(
      ThemeProvider,
      { colorScheme: 'dark' } as Record<string, unknown>,
      h(
        'box',
        { style: { width: 400, flexDirection: 'column' } },
        h(Html, {
          source: '<p>x</p>',
          partial: false,
          ref: own.ref,
          reducedMotion: true,
          scripting: true,
        }),
      ),
    );
  }
  await renderX11(h(App), { backend: 'mock', scale: 2 });
  await act();
  const holds = (query: string) => handle.matchMedia(query);
  assert.strictEqual(holds('(prefers-color-scheme: dark)'), true);
  assert.strictEqual(holds('(prefers-color-scheme: light)'), false);
  assert.strictEqual(holds('(prefers-reduced-motion: reduce)'), true);
  assert.strictEqual(holds('(scripting: enabled)'), true);
  assert.strictEqual(holds('(min-width: 400px)'), true, 'CSS pixels at 2x');
  assert.strictEqual(holds('(min-width: 401px)'), false);
  assert.strictEqual(holds('(min-resolution: 2dppx)'), true);
  assert.strictEqual(holds('screen and (max-width: 500px)'), true);
});

metric('the handle reaches all of it', async () => {
  let handle!: HtmlHandle;
  function App() {
    const h2 = useHtmlHandle();
    handle = h2;
    return h(Html, {
      source: '<input id="i" value="v"><a id="a" href="#">a</a>',
      partial: false,
      ref: h2.ref,
    });
  }
  await renderX11(h('box', { style: { width: 300 } }, h(App)), {
    width: 340,
    height: 200,
    fonts: FONTS!,
  });
  await act();
  const input = findById(handle.document, 'i') as DocElement;
  assert.strictEqual(handle.controlValue(input), 'v');
  assert.strictEqual(handle.setControlValue(input, 'w'), true);
  assert.strictEqual(handle.controlValue(input), 'w');
  assert.strictEqual(handle.focus(input), true);
  await act();
  assert.strictEqual(handle.activeElement, input);
  assert.ok(handle.computedStyle(input));
  handle.blur();
  await act();
  assert.strictEqual(handle.activeElement, null);
});
