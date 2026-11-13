// <Markdown links>: kinds of link that recognise an href, take its click and
// open a card over it. The in-process X server throughout, for real font
// metrics — a link's rect is the layout's — and the card clock held, so a
// card opens when a test says the time has come rather than when a runner
// got round to it.
import { test, afterEach } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';

import {
  renderX11,
  cleanup,
  screen,
  fireEvent,
  act,
  userEvent,
  waitFor,
} from 'react-x11/test';
import { XK_ESCAPE } from 'react-x11/keysyms';
import type { RenderX11Options } from 'react-x11/test';
import type { DrawnNode } from 'react-x11';

import { Markdown, RichTextNode, linkKind } from '../src/index.js';
import type {
  InlineBox,
  InlineDrawing,
  LinkKinds,
  TextRun,
} from '../src/index.js';
import {
  cardClock,
  CARD_CLOSE_DELAY,
  CARD_OPEN_DELAY,
} from '../src/richtext/links.js';
import { holdClock } from './held-clock.js';
import type { HeldClock } from './held-clock.js';

const h = React.createElement;

afterEach(cleanup);

const FONT_CANDIDATES: Array<[string, string]> = [
  [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Monaco.ttf',
  ],
  [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  ],
];
const found = FONT_CANDIDATES.find(
  ([sans, mono]) => existsSync(sans) && existsSync(mono),
);
const FONTS = found ? { 'sans-serif': found[0], monospace: found[1] } : null;

const PR = 'https://github.com/o/r/pull/12';
const SOURCE = `See [PR **twelve** here](${PR}) and [the docs](https://docs.example) too.`;

/** A pull request link: its number out of the URL. */
const pullRequest = linkKind({
  match: (href: string) => {
    const m = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)$/.exec(href);
    return m ? Number(m[1]) : null;
  },
  card: (n: number, ctx) => h('text', null, `PR ${n} is open · ${ctx.text}`),
});

function paragraph(): RichTextNode {
  const [para] = screen
    .all((n) => n instanceof RichTextNode)
    .map((n) => n as unknown as RichTextNode);
  assert.ok(para, 'the paragraph is drawn');
  return para;
}

function drawn(node: RichTextNode): DrawnNode {
  return node as unknown as DrawnNode;
}

/** The middle of a character, as an offset from the node's centre in
 *  device pixels — what `fireEvent` takes — and the logical window point. */
function at(
  node: RichTextNode,
  index: number,
  scale = 1,
): { dx: number; dy: number; x: number; y: number } {
  const caret = node.textCaretRect(index);
  assert.ok(caret, 'the paragraph is laid out');
  const x = caret.x + 2;
  const y = caret.y + caret.height / 2;
  return {
    dx: x - (node.abs.x + node.abs.width / 2),
    dy: y - (node.abs.y + node.abs.height / 2),
    x: x / scale,
    y: y / scale,
  };
}

/** Motion, given the frame core paces it to. */
async function moveTo(
  node: RichTextNode,
  offset: { dx: number; dy: number },
): Promise<void> {
  fireEvent.mouseMove(drawn(node), offset);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await act();
}

/** The held clock on by `ms`. */
async function wait(held: HeldClock, ms: number): Promise<void> {
  const until = held.time + ms;
  while (held.time < until && (await held.frame()));
}

async function mount(
  props: Record<string, unknown>,
  options: Partial<RenderX11Options> = {},
): Promise<RichTextNode> {
  await renderX11(
    h(
      'box',
      { style: { flexGrow: 1, padding: 10 } },
      h(Markdown, { source: SOURCE, ...props }),
    ),
    { fonts: FONTS!, width: 520, height: 240, ...options } as RenderX11Options,
  );
  return paragraph();
}

test(
  'linkAtPoint answers the whole link, its label across runs, and its rect in logical pixels',
  { skip: !FONTS },
  async () => {
    for (const scale of [1, 2]) {
      const para = await mount({}, { scale } as Partial<RenderX11Options>);
      const text = para.textContent();
      const label = 'PR twelve here';
      const start = text.indexOf(label);
      // the bold word is a run of its own, and the link is still one link
      const p = at(para, start + label.indexOf('twelve') + 1, scale);
      const link = para.linkAtPoint(p.x, p.y);
      assert.ok(link, `a link is under the bold word at ${scale}x`);
      assert.strictEqual(link.href, PR);
      assert.strictEqual(link.text, label);
      assert.deepEqual([link.start, link.end], [start, start + label.length]);
      assert.strictEqual(link.rects.length, 1, 'one line');
      // the rect is logical and from the node's corner: its left edge is the
      // label's first caret
      const first = para.textCaretRect(start)!;
      assert.ok(
        Math.abs(link.rect.x - (first.x - para.abs.x) / scale) < 1,
        `the rect starts where the label does at ${scale}x: ${link.rect.x}`,
      );
      assert.ok(link.rect.width > 0 && link.rect.height > 0);
      const plain = at(para, text.indexOf('See') + 1, scale);
      assert.strictEqual(
        para.linkAtPoint(plain.x, plain.y),
        null,
        'text that is no link',
      );
      await cleanup();
    }
  },
);

test('a link that wraps answers a rect a line', { skip: !FONTS }, async () => {
  const long = 'word '.repeat(30).trim();
  await renderX11(
    h(
      'box',
      { style: { width: 200, padding: 10 } },
      h(Markdown, { source: `[${long}](${PR})` }),
    ),
    { fonts: FONTS!, width: 240, height: 400 },
  );
  const para = paragraph();
  const p = at(para, 1);
  const link = para.linkAtPoint(p.x, p.y);
  assert.ok(link);
  assert.ok(link.rects.length > 2, `${link.rects.length} lines`);
  assert.deepEqual(link.rect, link.rects[0], 'the piece under the point');
  assert.strictEqual(link.text, long);
});

test(
  'a kind that activates takes the click; the rest go to onLink',
  { skip: !FONTS },
  async () => {
    const followed: string[] = [];
    const activated: { n: number; text: string }[] = [];
    const kinds: LinkKinds = [
      linkKind({
        match: pullRequest.match,
        activate: (n: number, link) => activated.push({ n, text: link.text }),
      }),
    ];
    const para = await mount({
      links: kinds,
      onLink: (href: string) => followed.push(href),
    });
    const text = para.textContent();
    const click = async (index: number): Promise<void> => {
      const p = at(para, index);
      await act(async () => {
        fireEvent.mouseDown(drawn(para), p);
        fireEvent.mouseUp(drawn(para), p);
      });
    };
    await click(text.indexOf('twelve'));
    await click(text.indexOf('docs'));
    assert.deepEqual(activated, [{ n: 12, text: 'PR twelve here' }]);
    assert.deepEqual(followed, ['https://docs.example']);
  },
);

test(
  'with no onLink a kind that activates still takes its own links, and the others stay inert',
  { skip: !FONTS },
  async () => {
    const activated: number[] = [];
    const para = await mount({
      links: [
        linkKind({
          match: pullRequest.match,
          activate: (n: number) => activated.push(n),
        }),
      ],
    });
    const text = para.textContent();
    for (const word of ['twelve', 'docs']) {
      const p = at(para, text.indexOf(word));
      await act(async () => {
        fireEvent.mouseDown(drawn(para), p);
        fireEvent.mouseUp(drawn(para), p);
      });
    }
    assert.deepEqual(activated, [12]);
  },
);

test(
  'the pointer shows over a link a click follows, and not where none does',
  { skip: !FONTS },
  async () => {
    const para = await mount({ onLink: () => {} });
    const text = para.textContent();
    const device = (index: number): [number, number] => {
      const caret = para.textCaretRect(index)!;
      return [caret.x + 2, caret.y + caret.height / 2];
    };
    assert.strictEqual(
      para.cursorAt(...device(text.indexOf('docs'))),
      'pointer',
    );
    assert.strictEqual(para.cursorAt(...device(text.indexOf('See'))), null);
    await cleanup();

    // a card alone is no click: the link keeps the text's cursor
    const inert = await mount({ links: [pullRequest] });
    const caret = inert.textCaretRect(inert.textContent().indexOf('twelve'))!;
    assert.strictEqual(
      inert.cursorAt(caret.x + 2, caret.y + caret.height / 2),
      null,
    );
  },
);

/** Hold the card clock and mount a document with the pull request kind. */
async function hovered(
  t: TestContext,
  props: Record<string, unknown> = {},
): Promise<{ para: RichTextNode; held: HeldClock; text: string }> {
  const held = holdClock(t, cardClock);
  const para = await mount({ links: [pullRequest], ...props });
  return { para, held, text: para.textContent() };
}

const CARD = 'PR 12 is open · PR twelve here';

test(
  'a pointer that rests on a link opens its card after the delay, and leaving closes it',
  { skip: !FONTS },
  async (t) => {
    const { para, held, text } = await hovered(t);
    await moveTo(para, at(para, text.indexOf('twelve')));
    await wait(held, CARD_OPEN_DELAY - 50);
    assert.ok(screen.queryByText(CARD) === null, 'not before the delay');
    await wait(held, 60);
    assert.ok(screen.queryByText(CARD), 'the card is up');
    // the card is a window of its own, below the link
    const windows = screen.all((n) => n.kind === 'window');
    assert.strictEqual(windows.length, 2, 'the card is a popup');

    // moving along the link keeps it
    await moveTo(para, at(para, text.indexOf('here')));
    await wait(held, CARD_CLOSE_DELAY * 2);
    assert.ok(screen.queryByText(CARD), 'still up on the same link');

    // off the link, it goes after the close delay
    await moveTo(para, at(para, text.indexOf('See')));
    assert.ok(screen.queryByText(CARD), 'not at once');
    await wait(held, CARD_CLOSE_DELAY + 20);
    assert.ok(screen.queryByText(CARD) === null, 'gone');
  },
);

test(
  'a pointer that only crosses a link opens nothing, and a link with no card opens nothing',
  { skip: !FONTS },
  async (t) => {
    const { para, held, text } = await hovered(t);
    await moveTo(para, at(para, text.indexOf('twelve')));
    await wait(held, CARD_OPEN_DELAY / 2);
    await moveTo(para, at(para, text.indexOf('and')));
    await wait(held, CARD_OPEN_DELAY * 2);
    assert.ok(screen.queryByText(CARD) === null, 'crossed, not rested');

    await moveTo(para, at(para, text.indexOf('docs')));
    await wait(held, CARD_OPEN_DELAY * 2);
    assert.strictEqual(
      screen.all((n) => n.kind === 'window').length,
      1,
      'the docs link is no kind with a card',
    );
  },
);

test(
  'a press closes the card, and a drag that crosses a link opens none',
  { skip: !FONTS },
  async (t) => {
    const { para, held, text } = await hovered(t);
    const on = at(para, text.indexOf('twelve'));
    await moveTo(para, on);
    await wait(held, CARD_OPEN_DELAY + 20);
    assert.ok(screen.queryByText(CARD));
    fireEvent.mouseDown(drawn(para), on);
    await act();
    assert.ok(screen.queryByText(CARD) === null, 'the press took it down');

    // still pressed: a selection drag across the link
    await moveTo(para, at(para, text.indexOf('here')));
    await wait(held, CARD_OPEN_DELAY * 2);
    assert.ok(screen.queryByText(CARD) === null, 'a drag is no hover');
    fireEvent.mouseUp(drawn(para), at(para, text.indexOf('here')));
    await act();
  },
);

test(
  'a card can close itself, and Escape closes it',
  { skip: !FONTS },
  async (t) => {
    let close: (() => void) | null = null;
    const { para, held, text } = await hovered(t, {
      links: [
        linkKind({
          match: pullRequest.match,
          card: (n: number, ctx) => {
            close = ctx.close;
            return h('text', null, `card ${n}`);
          },
        }),
      ],
    });
    const on = at(para, text.indexOf('twelve'));
    await moveTo(para, on);
    await wait(held, CARD_OPEN_DELAY + 20);
    assert.ok(screen.queryByText('card 12'));
    await act(async () => close!());
    assert.ok(screen.queryByText('card 12') === null, 'closed by the card');

    // Escape is a key, so it reaches a document that has the focus: a press
    // on its plain text gives it that
    const plain = at(para, text.indexOf('See'));
    await act(async () => {
      fireEvent.mouseDown(drawn(para), plain);
      fireEvent.mouseUp(drawn(para), plain);
    });
    await moveTo(para, at(para, text.indexOf('here')));
    await wait(held, CARD_OPEN_DELAY + 20);
    assert.ok(screen.queryByText('card 12'), 'open again');
    const [root] = screen.all(
      (n) =>
        (n as { props?: { selectable?: boolean } }).props?.selectable === true,
    );
    await userEvent.key(XK_ESCAPE, { target: root as DrawnNode });
    // the key reaches the document through the server, a moment after
    await waitFor(() =>
      assert.ok(screen.queryByText('card 12') === null, 'Escape closed it'),
    );
  },
);

// --- how a link of a kind is drawn -------------------------------------------

/** The runs a paragraph was handed. */
function runsOf(node: RichTextNode): TextRun[] {
  return (node as unknown as { props: { runs: TextRun[] } }).props.runs;
}

test(
  "a kind's look and label are the link's runs; the document's text is what it was",
  { skip: !FONTS },
  async () => {
    const para = await mount({
      links: [
        linkKind({
          match: pullRequest.match,
          look: () => ({
            color: '#2da44e',
            underline: false,
            bg: '#ddf4e4',
            weight: 700,
          }),
          label: (n: number) => `o/r#${n} · Fix the parser`,
        }),
      ],
    });
    const runs = runsOf(para);
    const link = runs.filter((r) => r.href === PR);
    assert.deepEqual(
      link.map((r) => r.text).join(''),
      'o/r#12 · Fix the parser',
      'the label in place of what the document wrote',
    );
    for (const r of link) {
      assert.strictEqual(r.color, '#2da44e');
      assert.strictEqual(r.underline, undefined, 'no underline');
      assert.strictEqual(r.bg, '#ddf4e4');
      assert.strictEqual(r.weight, 700);
    }
    const docs = runs.find((r) => r.href === 'https://docs.example');
    assert.ok(docs?.underline, 'a link no kind draws keeps the document look');
  },
);

test(
  'an icon takes its width before the label, is drawn there, and a click on it follows the link',
  { skip: !FONTS },
  async () => {
    for (const scale of [1, 2]) {
      const boxes: InlineBox[] = [];
      const icon: InlineDrawing = {
        width: 12,
        draw: (_ctx, box) => boxes.push(box),
      };
      const followed: string[] = [];
      const para = await mount(
        {
          links: [
            linkKind({
              match: pullRequest.match,
              look: () => ({ icon, iconGap: 6 }),
            }),
          ],
          onLink: (href: string) => followed.push(href),
        },
        { scale } as Partial<RenderX11Options>,
      );
      const text = para.textContent();
      const start = text.indexOf('PR twelve');
      // the icon is a run of its own before the label, one character
      const iconRun = runsOf(para).find((r) => r.inline);
      assert.ok(iconRun, 'an icon run');
      assert.strictEqual(iconRun.text.length, 1);
      assert.strictEqual(iconRun.href, PR, 'part of the link');
      assert.strictEqual(text[start - 1], iconRun.text);
      // its room: the label starts the icon and the gap after where it does
      const iconAt = para.textCaretRect(start - 1)!;
      const labelAt = para.textCaretRect(start)!;
      assert.ok(
        Math.abs(labelAt.x - iconAt.x - 18 * scale) < 1,
        `${labelAt.x - iconAt.x} device pixels for 18 logical at ${scale}x`,
      );
      // drawn, at its own width and on its line, in device pixels
      await act();
      assert.ok(boxes.length > 0, `drawn at ${scale}x`);
      const box = boxes[boxes.length - 1];
      assert.ok(Math.abs(box.x - iconAt.x) < 1, 'where its run is');
      assert.ok(Math.abs(box.width - 12 * scale) < 1, 'without the gap');
      assert.strictEqual(box.scale, scale);
      assert.ok(box.baseline > box.y && box.baseline < box.y + box.height);
      // a click on it is a click on the link
      const dx = iconAt.x + 3 * scale - (para.abs.x + para.abs.width / 2);
      const dy =
        iconAt.y + iconAt.height / 2 - (para.abs.y + para.abs.height / 2);
      await act(async () => {
        fireEvent.mouseDown(drawn(para), { dx, dy });
        fireEvent.mouseUp(drawn(para), { dx, dy });
      });
      assert.deepEqual(followed, [PR], 'the icon is the link');
      // and the card's label is the text, not the icon's room
      const p = at(para, start + 1, scale);
      assert.strictEqual(para.linkAtPoint(p.x, p.y)?.text, 'PR twelve here');
      await cleanup();
    }
  },
);

test(
  'a kind that watches draws its links again when told, and only the blocks that hold one',
  { skip: !FONTS },
  async () => {
    const state = { merged: false };
    const listeners = new Map<number, () => void>();
    let stops = 0;
    const kind = linkKind({
      match: pullRequest.match,
      look: () => ({ color: state.merged ? '#8250df' : '#2da44e' }),
      label: (n: number) => (state.merged ? `#${n} merged` : `#${n} open`),
      watch: (n: number, changed) => {
        listeners.set(n, changed);
        return () => {
          stops += 1;
          listeners.delete(n);
        };
      },
    });
    const links: LinkKinds = [kind];
    const source = `Plain words first.\n\nThe fix: [pr](${PR}).`;
    await renderX11(
      h(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        h(Markdown, { source, links }),
      ),
      { fonts: FONTS!, width: 520, height: 240 },
    );
    const nodes = (): RichTextNode[] =>
      screen
        .all((n) => n instanceof RichTextNode)
        .map((n) => n as unknown as RichTextNode);
    const [plain, withLink] = nodes();
    const plainRuns = runsOf(plain);
    assert.ok(listeners.has(12), 'the link is listened to');
    assert.match(withLink.textContent(), /#12 open/);

    state.merged = true;
    await act(async () => listeners.get(12)!());
    const [plainAfter, linkAfter] = nodes();
    assert.match(linkAfter.textContent(), /#12 merged/, 'drawn again');
    assert.strictEqual(
      runsOf(linkAfter).find((r) => r.href === PR)?.color,
      '#8250df',
    );
    assert.strictEqual(
      runsOf(plainAfter),
      plainRuns,
      'the block with no link to it kept its runs',
    );

    await cleanup();
    assert.strictEqual(stops, 1, 'stopped listening as the document went');
  },
);

test(
  'a link that leaves the document stops being listened to',
  { skip: !FONTS },
  async () => {
    const listening = new Set<number>();
    const kind = linkKind({
      match: pullRequest.match,
      look: () => ({ color: '#2da44e' }),
      watch: (n: number) => {
        listening.add(n);
        return () => listening.delete(n);
      },
    });
    const links: LinkKinds = [kind];
    const doc = (source: string) =>
      h('box', { style: { flexGrow: 1 } }, h(Markdown, { source, links }));
    const r = await renderX11(doc(`[a](${PR}) and [b](${PR}/x)`), {
      fonts: FONTS!,
      width: 400,
      height: 120,
    });
    assert.deepEqual([...listening], [12], 'one listener for the one href');
    await act(async () => r.rerender(doc('no links now')));
    assert.deepEqual([...listening], [], 'gone with the link');
  },
);
