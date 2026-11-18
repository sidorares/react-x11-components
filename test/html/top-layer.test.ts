// A document's top layer as its markup opens and closes it, with no script
// engine running it (`src/html/top-layer.ts`): popovers by `popovertarget`
// and `commandfor`, a modal dialog by `command="show-modal"`, closed by a
// button, a dialog form, a press outside it and Escape, as Chrome does all
// of it with JavaScript off. Alloy CSS's example — one page of an invoicing
// app, no script anywhere — is the page this was found on.
import assert from 'node:assert';
import { act, fireEvent, renderX11, screen } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { XK_ESCAPE } from 'react-x11/keysyms';
import { Html } from '../../src/index.js';
import type { HtmlDomEvent } from '../../src/index.js';
import { isModal, isPopoverOpen } from '../../src/html/dom.js';
import { FONTS, findById, h, metric, view } from './harness.js';
import type { HtmlViewNode } from '../../src/html/index.js';

interface Page {
  el: HtmlViewNode;
  events: string[];
  submitted: unknown[];
  byId(id: string): NonNullable<ReturnType<typeof findById>>;
  press(id: string): Promise<void>;
  pressAt(x: number, y: number): Promise<void>;
  escape(): Promise<void>;
}

/** A page with no script engine, whose events the host is told of. */
async function page(
  body: string,
  props: Record<string, unknown> = {},
): Promise<Page> {
  const events: string[] = [];
  const submitted: unknown[] = [];
  await renderX11(
    h(
      'box',
      { style: { width: 400, height: 400, flexDirection: 'column' } },
      h(Html, {
        source: `<style>body{margin:0;font-size:16px}</style>${body}`,
        partial: false,
        'data-testname': 'doc',
        style: { flexGrow: 1 },
        onSubmit: (s: unknown) => void submitted.push(s),
        onDomEvent: (e: HtmlDomEvent) => {
          if (/^(mouse|key|focus|click|pointer|select|load)/.test(e.type)) {
            return;
          }
          const id = e.target.attribs.id ?? e.target.name;
          const more = [
            e.command,
            e.source?.attribs.id,
            e.oldState && `${e.oldState}>${e.newState}`,
            e.returnValue,
          ].filter((x) => x !== undefined);
          events.push([e.type, id, ...more].join(':'));
        },
        ...props,
      }),
    ),
    { width: 400, height: 400, fonts: FONTS! },
  );
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));
  const pressAt = async (x: number, y: number) => {
    const t = el as unknown as DrawnNode;
    const dx = x - t.abs.width / 2;
    const dy = y - t.abs.height / 2;
    await act(async () => {
      fireEvent.mouseDown(t, { dx, dy });
      fireEvent.mouseUp(t, { dx, dy });
    });
    await settle();
  };
  const byId = (id: string) => {
    const found = findById(el.document, id);
    assert.ok(found, `no #${id}`);
    return found;
  };
  return {
    el,
    events,
    submitted,
    byId,
    pressAt,
    press: async (id) => {
      const rect = el.elementRect(byId(id));
      assert.ok(rect, `#${id} is drawn`);
      await pressAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
    },
    escape: async () => {
      await act(async () => fireEvent.key(XK_ESCAPE));
      await settle();
    },
  };
}

const DIALOG =
  '<style>button:focus-visible{color:#ff0000}</style>' +
  '<button id="open" type="button" commandfor="d" command="show-modal" style="width:80px;height:30px">open</button>' +
  '<style>#d *{display:block;box-sizing:border-box;width:80px;height:30px;margin:0}' +
  '#d #draft{margin-top:40px}#d #pad{height:40px}</style>' +
  '<dialog id="d" style="width:200px;height:200px;padding:0">' +
  '<form method="dialog" style="width:auto;height:auto">' +
  '<button id="x" type="button" commandfor="d" command="close" value="closed">x</button>' +
  '<input id="name" name="name" required>' +
  '<button id="draft" value="draft" formnovalidate>draft</button>' +
  '<button id="send" value="send">send</button>' +
  '<div id="pad"></div>' +
  '</form></dialog>';

metric(
  'a button’s command opens a dialog as a modal one, focused at the first thing Tab reaches, and closes it with its value',
  async () => {
    const p = await page(DIALOG);
    const d = p.byId('d');
    assert.equal(p.el.elementRect(d), null, 'closed, it has no box');
    await p.press('open');
    assert.ok(isModal(d), 'modal');
    assert.equal(d.attribs.open, '');
    const box = p.el.elementRect(d)!;
    // centred in the 400 by 400 viewport, as HTML's `dialog:modal` rule has it
    assert.deepStrictEqual(
      [box.x, box.y, box.width, box.height],
      [97, 97, 206, 206],
    );
    // the first thing in it Tab reaches, with no ring after a press
    assert.equal(p.el.focusedElement, p.byId('x'));
    assert.equal(
      p.el.computedStyle(p.byId('x'))?.color,
      p.el.computedStyle(p.byId('draft'))?.color,
      'no :focus-visible',
    );
    await p.press('x');
    assert.ok(!isModal(d));
    assert.equal(d.attribs.open, undefined);
    assert.deepStrictEqual(p.events, [
      'command:d:show-modal:open',
      'beforetoggle:d:closed>open',
      'toggle:d:closed>open',
      'command:d:close:x',
      'beforetoggle:d:open>closed',
      'toggle:d:open>closed',
      'close:d:closed',
    ]);
  },
);

metric(
  'a dialog form closes its dialog with its submitter’s value once it is valid, and sends nothing',
  async () => {
    const p = await page(DIALOG);
    const d = p.byId('d');
    await p.press('open');
    // a required field left empty keeps it open, and the field is focused
    await p.press('send');
    assert.ok(isModal(d), 'invalid, it stays open');
    assert.equal(p.el.focusedElement?.attribs.id, 'name', p.events.join(' '));
    await p.press('draft');
    assert.ok(!isModal(d));
    assert.equal(d.attribs.open, undefined);
    assert.ok(p.events.includes('close:d:draft'), p.events.join(' '));
    assert.ok(p.events.includes('submit:form'), 'its submit told first');
    assert.deepStrictEqual(p.submitted, [], 'and nothing sent');
  },
);

metric(
  'Escape closes a modal dialog, after a cancel the host may cancel, and closedby="none" keeps it open',
  async () => {
    let keep = true;
    const p = await page(DIALOG, {
      onDomEvent: (e: HtmlDomEvent) => {
        if (e.type === 'cancel' && keep) {
          keep = false;
          return false;
        }
      },
    });
    const d = p.byId('d');
    await p.press('open');
    await p.escape();
    assert.ok(isModal(d), 'the cancel was cancelled');
    await p.escape();
    assert.ok(!isModal(d), 'and the next closes it');

    const none = await page(
      DIALOG.replace('<dialog id="d"', '<dialog id="d" closedby="none"'),
    );
    await none.press('open');
    await none.escape();
    assert.ok(isModal(none.byId('d')), 'closedby="none"');
  },
);

metric(
  'a press on a modal dialog’s backdrop closes it where its closedby is any, and only there',
  async () => {
    const any = await page(
      DIALOG.replace('<dialog id="d"', '<dialog id="d" closedby="any"'),
    );
    await any.press('open');
    // inside it, on no control, it stays
    await any.press('pad');
    assert.ok(isModal(any.byId('d')), 'a press inside');
    await any.pressAt(10, 10);
    assert.ok(!isModal(any.byId('d')), 'a press on the backdrop');
    assert.ok(any.events.includes('cancel:d'), any.events.join(' '));

    const auto = await page(DIALOG);
    await auto.press('open');
    await auto.pressAt(10, 10);
    assert.ok(
      isModal(auto.byId('d')),
      'a modal one closes by a close request alone',
    );

    // one the markup has open is one of the open dialogs, and closes so
    // too where it says `any`, though it is no modal one; and Escape closes
    // none whose `closedby` comes to `none`, as a non-modal one's does
    const parsed = await page(
      '<dialog id="n" open closedby="any" style="position:static;margin:0">n</dialog>' +
        '<dialog id="q" open style="position:static;margin:0">q</dialog>',
    );
    await parsed.escape();
    assert.equal(parsed.byId('q').attribs.open, '', 'Escape: none');
    await parsed.pressAt(300, 300);
    assert.equal(parsed.byId('q').attribs.open, '', 'q is the last opened');
    assert.equal(parsed.byId('n').attribs.open, '', 'and only the last');
    const alone = await page(
      '<dialog id="n" open closedby="any" style="position:static;margin:0">n</dialog>',
    );
    await alone.pressAt(300, 300);
    assert.equal(alone.byId('n').attribs.open, undefined, 'a press outside');
  },
);

const POPOVERS =
  '<style>[popover]{margin:0;inset:auto;left:0;top:200px;width:100px;height:40px;padding:0}</style>' +
  '<button id="a" popovertarget="pa" style="width:60px;height:30px">a</button>' +
  '<button id="b" popovertarget="pb" style="width:60px;height:30px">b</button>' +
  '<button id="m" commandfor="pm" command="toggle-popover" style="width:60px;height:30px">m</button>' +
  '<div id="pa" popover><button id="hide-a" popovertarget="pa" popovertargetaction="hide">x</button></div>' +
  '<div id="pb" popover style="left:150px"></div>' +
  '<div id="pm" popover="manual" style="top:300px"></div>';

metric(
  'popovertarget shows and hides a popover, one auto popover closes the others, and a press outside or Escape closes it',
  async () => {
    const p = await page(POPOVERS);
    const [pa, pb, pm] = ['pa', 'pb', 'pm'].map(p.byId);
    await p.press('a');
    assert.ok(isPopoverOpen(pa), p.events.join(' '));
    // what showed it is its implicit anchor, and it is drawn where its style
    // puts it
    assert.equal(p.el.elementRect(pa)?.y, 200);
    // a button inside it that hides it
    await p.press('hide-a');
    assert.ok(!isPopoverOpen(pa));
    await p.press('a');
    await p.press('b');
    assert.ok(!isPopoverOpen(pa) && isPopoverOpen(pb), 'b in place of a');
    // a manual one, by a command — a press on its button, which no auto
    // popover holds or shows, light dismisses those — stays open past a
    // press outside
    await p.press('m');
    assert.ok(isPopoverOpen(pm) && !isPopoverOpen(pb));
    await p.press('b');
    assert.ok(isPopoverOpen(pm) && isPopoverOpen(pb));
    await p.pressAt(300, 100);
    assert.ok(!isPopoverOpen(pb), 'light dismissed');
    assert.ok(isPopoverOpen(pm), 'a manual one is not');
    await p.press('a');
    await p.escape();
    assert.ok(!isPopoverOpen(pa), 'Escape');
    assert.ok(isPopoverOpen(pm), 'and not a manual one');
    // pressing its button again hides it
    await p.press('m');
    assert.ok(!isPopoverOpen(pm));
    assert.ok(
      p.events.includes('command:pm:toggle-popover:m') &&
        p.events.includes('toggle:pa:closed>open'),
      p.events.join(' '),
    );
  },
);

metric(
  'a press on a button the light dismiss uncovers is that button’s: a closing popover drawn over it on the way out takes no click from it',
  async () => {
    // Alloy's menus: a popover leaving the top layer is still drawn through
    // its exit transition (`overlay` and `display` allow-discrete), where its
    // anchor has let it go — at its place in the flow, over the button next
    // to the one that showed it. Chrome's click goes where the press was.
    const p = await page(
      '<style>#menu{margin:0;inset:auto;padding:0;width:200px;height:60px;' +
        'position:absolute;left:0;top:0;' +
        'transition:display 5s allow-discrete,overlay 5s allow-discrete}' +
        '#menu:popover-open{position:fixed;left:0;top:300px}' +
        '#menu:not(:popover-open){display:none}</style>' +
        '<div style="position:relative;height:100px">' +
        '<button id="show" popovertarget="menu" style="position:absolute;left:250px;top:0;width:60px;height:30px">menu</button>' +
        '<div id="menu" popover></div>' +
        '<button id="open" type="button" commandfor="d" command="show-modal" style="position:absolute;left:0;top:0;width:80px;height:30px">open</button>' +
        '</div><dialog id="d">hi</dialog>',
    );
    await p.press('show');
    assert.ok(isPopoverOpen(p.byId('menu')));
    await p.press('open');
    assert.ok(!isPopoverOpen(p.byId('menu')), 'the menu light dismissed');
    assert.ok(isModal(p.byId('d')), 'and the press under it opened the dialog');
  },
);

metric(
  'a button with a command and no type in a form submits nothing and runs nothing',
  async () => {
    const p = await page(
      '<dialog id="d" open><form id="f">' +
        '<button id="c" commandfor="d" command="close">c</button></form></dialog>',
    );
    await p.press('c');
    assert.equal(p.byId('d').attribs.open, '', 'still open');
    assert.ok(
      !p.events.some((e) => /^(submit|command)/.test(e)),
      p.events.join(' '),
    );
  },
);

metric(
  'where a script engine runs the document, the markup opens nothing itself: the engine’s DOM does',
  async () => {
    const p = await page(POPOVERS, { scripting: true });
    await p.press('a');
    assert.ok(!isPopoverOpen(p.byId('pa')));
  },
);

metric(
  'a closed dialog is in no top layer before anything opens it',
  async () => {
    const p = await page(DIALOG);
    assert.ok(!isModal(p.byId('d')));
  },
);
