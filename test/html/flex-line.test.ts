// `LineNode` against Yoga: a box of one line is laid out on the first, and what
// it answers has to be what the second does. So each generated row and column
// goes through both, a call at a time, and each layout is held to the other's:
// every place and size, and every question a measure function was asked.
import assert from 'node:assert/strict';
import { env } from 'node:process';
import test from 'node:test';

import { Yoga as Y, loadLayout } from 'react-x11/yoga';

import { LineNode } from '../../src/html/layout/flex-line.js';
import type { FlexNode } from '../../src/html/layout/flex-line.js';
import { lineNodesOn, yogaNodesMade } from '../../src/html/layout/flex.js';
import { mulberry32 } from '../mulberry32.js';
import { render, treeLines, treeOf, view } from './harness.js';

await loadLayout();

type Target = number;
const ROOT: Target = -1;
/** A call on a node: which, what, and its arguments. */
type Call = [Target, string, ...number[]];

interface Content {
  /** How wide it is on one line, and how tall a line of it is. */
  wide: number;
  tall: number;
}

interface Asked {
  item: number;
  args: [number, number, number, number];
}

interface Tree {
  root: FlexNode;
  items: FlexNode[];
  asked: Asked[];
}

const AUTO = -Infinity;

function apply(tree: Tree, calls: readonly Call[]): void {
  for (const [target, method, ...args] of calls) {
    const node = target === ROOT ? tree.root : tree.items[target];
    if (method === 'setMargin' && args[1] === AUTO) {
      node.setMarginAuto(args[0]);
    } else {
      (node as unknown as Record<string, (...a: number[]) => void>)[method](
        ...args,
      );
    }
  }
}

function make(
  create: () => FlexNode,
  contents: readonly Content[],
  calls: readonly Call[],
): Tree {
  const root = create();
  const asked: Asked[] = [];
  const items = contents.map((content, item) => {
    const node = create();
    node.setMeasureFunc((width, widthMode, height, heightMode) => {
      asked.push({ item, args: [width, widthMode, height, heightMode] });
      const fitted =
        widthMode === Y.MEASURE_MODE_EXACTLY
          ? width
          : widthMode === Y.MEASURE_MODE_AT_MOST
            ? Math.min(content.wide, width)
            : content.wide;
      const down = Math.ceil(content.wide / Math.max(fitted, 1)) * content.tall;
      return {
        width: fitted,
        height:
          heightMode === Y.MEASURE_MODE_EXACTLY
            ? height
            : heightMode === Y.MEASURE_MODE_AT_MOST
              ? Math.min(down, height)
              : down,
      };
    });
    root.insertChild(node, item);
    return node;
  });
  const tree = { root, items, asked };
  apply(tree, calls);
  return tree;
}

/** Each number a layout came to, named for a failure to say which it is. */
function answers(tree: Tree): [string, number][] {
  const out: [string, number][] = [
    ['root width', tree.root.getComputedWidth()],
    ['root height', tree.root.getComputedHeight()],
  ];
  tree.items.forEach((node, i) => {
    out.push(
      [`item ${i} left`, node.getComputedLeft()],
      [`item ${i} top`, node.getComputedTop()],
      [`item ${i} width`, node.getComputedWidth()],
      [`item ${i} height`, node.getComputedHeight()],
    );
  });
  return out;
}

function compare(
  line: Tree,
  yoga: Tree,
  what: string,
  questions: boolean,
): void {
  const ours = answers(line);
  const theirs = answers(yoga);
  ours.forEach(([name, value], i) => {
    assert.ok(
      Object.is(value, theirs[i][1]),
      `${what}: ${name} is ${value} where Yoga has ${theirs[i][1]}`,
    );
  });
  if (!questions) return;
  const said = (a: Asked): string => `item ${a.item}: ${a.args.join(' ')}`;
  const list = (t: Tree): string => t.asked.map(said).join(', ');
  const alike =
    line.asked.length === yoga.asked.length &&
    line.asked.every((a, i) => {
      const b = yoga.asked[i];
      return (
        a.item === b.item && a.args.every((n, k) => Object.is(n, b.args[k]))
      );
    });
  assert.ok(
    alike,
    `${what}: asked ${list(line)} where Yoga asked ${list(yoga)}`,
  );
}

/** A generated box: what is set on its nodes, and what they are asked in. */
function generate(next: () => number): {
  contents: Content[];
  calls: Call[];
  width: number;
  height: number;
} {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const length = (most: number): number =>
    pick([0.25, 1, 0.5, 0.1, 1 / 3]) * Math.round(next() * most * 4);
  const chance = (p: number): boolean => next() < p;
  const calls: Call[] = [];

  const row = chance(0.6);
  if (row) calls.push([ROOT, 'setFlexDirection', Y.FLEX_DIRECTION_ROW]);
  calls.push(
    [
      ROOT,
      'setJustifyContent',
      pick([
        Y.JUSTIFY_FLEX_START,
        Y.JUSTIFY_CENTER,
        Y.JUSTIFY_FLEX_END,
        Y.JUSTIFY_SPACE_BETWEEN,
        Y.JUSTIFY_SPACE_AROUND,
        Y.JUSTIFY_SPACE_EVENLY,
      ]),
    ],
    [
      ROOT,
      'setAlignItems',
      pick([
        Y.ALIGN_STRETCH,
        Y.ALIGN_STRETCH,
        Y.ALIGN_FLEX_START,
        Y.ALIGN_CENTER,
        Y.ALIGN_FLEX_END,
      ]),
    ],
  );
  if (chance(0.3)) calls.push([ROOT, 'setGap', Y.GUTTER_ROW, length(12)]);
  if (chance(0.3)) calls.push([ROOT, 'setGap', Y.GUTTER_COLUMN, length(12)]);

  // laid out in a width, in none, or in nothing, as a probe is
  const width = pick([length(600), length(300), NaN, 0]);
  if (Number.isFinite(width)) calls.push([ROOT, 'setWidth', width]);
  // and of a height, or as tall as its items, within limits
  let height = NaN;
  if (chance(0.4)) {
    height = length(400);
    calls.push([ROOT, 'setHeight', height]);
  } else {
    if (chance(0.3)) calls.push([ROOT, 'setMinHeight', length(200) + 0.25]);
    if (chance(0.3)) calls.push([ROOT, 'setMaxHeight', length(300) + 0.25]);
  }

  const contents: Content[] = [];
  const count = pick([0, 1, 1, 2, 2, 3, 3, 4, 6]);
  for (let i = 0; i < count; i += 1) {
    contents.push({
      wide: pick([0, length(50), length(200), length(400)]),
      tall: pick([0, 16, 20, 18.5]),
    });
    for (const edge of [Y.EDGE_LEFT, Y.EDGE_TOP, Y.EDGE_RIGHT, Y.EDGE_BOTTOM]) {
      if (chance(0.2)) {
        const margin = chance(0.3) ? AUTO : length(20) - (chance(0.2) ? 30 : 0);
        calls.push([i, 'setMargin', edge, margin]);
      }
      if (chance(0.15)) calls.push([i, 'setPadding', edge, length(12)]);
      if (chance(0.1)) calls.push([i, 'setBorder', edge, length(3)]);
    }
    if (chance(0.5)) {
      calls.push([i, 'setFlexGrow', pick([1, 1, 2, 0.5, 0.25, 3])]);
    }
    if (chance(0.5)) {
      calls.push([i, 'setFlexShrink', pick([1, 1, 2, 0.5, 0.25, 3])]);
    }
    if (chance(0.3)) {
      calls.push([
        i,
        'setAlignSelf',
        pick([
          Y.ALIGN_STRETCH,
          Y.ALIGN_FLEX_START,
          Y.ALIGN_CENTER,
          Y.ALIGN_FLEX_END,
          Y.ALIGN_AUTO,
        ]),
      ]);
    }
    if (chance(0.4)) {
      if (chance(0.25)) calls.push([i, 'setWidthPercent', length(100)]);
      else calls.push([i, 'setWidth', length(200) - (chance(0.1) ? 300 : 0)]);
    }
    if (chance(0.3)) {
      if (chance(0.25)) calls.push([i, 'setHeightPercent', length(100)]);
      else calls.push([i, 'setHeight', length(120)]);
    }
    if (chance(0.35)) {
      if (chance(0.25)) calls.push([i, 'setFlexBasisPercent', length(100)]);
      else calls.push([i, 'setFlexBasis', pick([0, length(200), 10])]);
    }
    const minWidth = chance(0.25) ? length(100) : NaN;
    const maxWidth = chance(0.25)
      ? chance(0.2)
        ? minWidth
        : length(160)
      : NaN;
    const minHeight = chance(0.2) ? length(100) : NaN;
    const maxHeight = chance(0.2)
      ? chance(0.2)
        ? minHeight
        : length(160)
      : NaN;
    if (!Number.isNaN(minWidth)) calls.push([i, 'setMinWidth', minWidth]);
    if (!Number.isNaN(maxWidth)) calls.push([i, 'setMaxWidth', maxWidth]);
    if (!Number.isNaN(minHeight)) calls.push([i, 'setMinHeight', minHeight]);
    if (!Number.isNaN(maxHeight)) calls.push([i, 'setMaxHeight', maxHeight]);
  }
  return { contents, calls, width, height };
}

/** What `layoutFlex` does to a box between layouts. */
function changes(
  next: () => number,
  contents: readonly Content[],
  yoga: Tree,
  row: boolean,
): Call[] {
  const calls: Call[] = [];
  const kind = Math.floor(next() * 4);
  contents.forEach((_, i) => {
    const node = yoga.items[i];
    const size = row ? node.getComputedWidth() : node.getComputedHeight();
    if (kind === 0) {
      // frozen at the sizes the line came to (`freezeLine`), or the sizes
      // told to be measured again (the sizing step)
      calls.push(
        [i, 'setFlexGrow', 0],
        [i, 'setFlexShrink', 0],
        [i, 'setFlexBasis', size],
        [i, 'markDirty'],
      );
    } else if (kind === 1 && next() < 0.5) {
      // held at its least (`holdAt`, `freezeAt`)
      const least = size + Math.round(next() * 40);
      calls.push(
        [i, row ? 'setMinWidth' : 'setMinHeight', least],
        [i, 'setFlexGrow', 0],
        [i, 'setFlexShrink', 0],
        [i, 'setFlexBasis', least],
      );
    } else if (kind === 2 && next() < 0.5) {
      // lined up by baselines (`baselineLines`)
      calls.push([i, 'setMargin', Y.EDGE_TOP, Math.round(next() * 12)]);
    }
  });
  // or asked for its bases, with nothing flexing and no limits (`askBases`)
  if (kind === 3) {
    contents.forEach((_, i) => {
      calls.push([i, 'setFlexGrow', 0], [i, 'setFlexShrink', 0]);
    });
  }
  return calls;
}

test('a line of leaves comes to what Yoga makes of it, and asks what Yoga asks', () => {
  // LINE_SEEDS sweeps more of them, and LINE_FROM starts at the one a sweep
  // failed at
  const seeds = Number(env.LINE_SEEDS ?? 4000);
  const config = Y.Config.create();
  config.setPointScaleFactor(0);
  let flexed = 0;
  for (let seed = Number(env.LINE_FROM ?? 1); seed <= seeds; seed += 1) {
    const next = mulberry32(seed * 104729);
    const { contents, calls, width, height } = generate(next);
    const row = calls.some(
      ([target, method]) => target === ROOT && method === 'setFlexDirection',
    );
    const line = make(() => new LineNode(), contents, calls);
    const yoga = make(() => Y.Node.create(config), contents, calls);
    const rounds = 1 + Math.floor(next() * 3);
    for (let round = 0; round < rounds; round += 1) {
      line.root.calculateLayout(width, height, Y.DIRECTION_LTR);
      yoga.root.calculateLayout(width, height, Y.DIRECTION_LTR);
      compare(line, yoga, `seed ${seed}, layout ${round}`, true);
      line.asked.length = 0;
      yoga.asked.length = 0;
      const more = changes(next, contents, yoga, row);
      if (more.length) flexed += 1;
      apply(line, more);
      apply(yoga, more);
    }
    yoga.root.free();
    for (const node of yoga.items) node.free();
  }
  assert.ok(flexed > seeds / 4, 'the layouts after the first were asked for');
});

/** A generated document of flex boxes, one inside another. */
function flexDocument(next: () => number): string {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const chance = (p: number): boolean => next() < p;
  const px = (most: number): string =>
    `${(Math.round(next() * most * 3) / 3).toFixed(2)}px`;
  const words = (): string =>
    Array.from({ length: 1 + Math.floor(next() * 14) }, () =>
      pick(['a', 'word', 'longer', 'flexbox', 'x', 'unbreakablelonger']),
    ).join(' ');
  const item = (depth: number): string => {
    const css = [
      chance(0.5)
        ? pick([
            'flex:1',
            'flex:none',
            'flex:0 1 auto',
            'flex:1 1 0',
            'flex:2 1 40px',
            'flex:1 0 30%',
            'flex:0 0 auto',
            'flex-grow:.4',
            'flex-shrink:.3',
            `flex-basis:${px(120)}`,
          ])
        : '',
      chance(0.25)
        ? `width:${pick([px(200), '50%', '100%', 'calc(100% - 20px)', 'fit-content', 'max-content', 'min-content'])}`
        : '',
      chance(0.15) ? `height:${pick([px(80), '50%', '100%'])}` : '',
      chance(0.2)
        ? `min-width:${pick(['0', px(100), '30%', 'min-content'])}`
        : '',
      chance(0.15) ? `max-width:${pick([px(160), '60%', 'max-content'])}` : '',
      chance(0.1) ? `min-height:${px(60)}` : '',
      chance(0.1) ? `max-height:${px(60)}` : '',
      chance(0.2)
        ? `margin:${pick([px(8), 'auto', '0 auto', 'auto 0', `${px(6)} auto 0 ${px(4)}`, `-${px(6)}`])}`
        : '',
      chance(0.3)
        ? `padding:${pick([px(10), `${px(6)} ${px(12)}`, '4%'])}`
        : '',
      chance(0.15) ? `border:${px(3)} solid` : '',
      chance(0.2)
        ? `align-self:${pick(['flex-start', 'center', 'flex-end', 'stretch', 'baseline', 'auto'])}`
        : '',
      chance(0.1) ? 'box-sizing:border-box' : '',
      chance(0.1) ? `overflow:${pick(['hidden', 'auto'])}` : '',
      chance(0.05) ? 'aspect-ratio:2' : '',
      chance(0.05) ? `order:${pick([-1, 1, 2])}` : '',
    ]
      .filter(Boolean)
      .join(';');
    if (depth > 0 && chance(0.55)) return box(depth - 1, css);
    const body = chance(0.1)
      ? `<svg width="${pick([20, 60])}" height="${pick([10, 40])}" viewBox="0 0 2 1"></svg>`
      : chance(0.08)
        ? '<table><tr><td>a cell</td><td>another cell</td></tr></table>'
        : chance(0.08)
          ? '<input value="x"><button>go</button>'
          : chance(0.1)
            ? ''
            : words();
    return `<div style="${css}">${body}</div>`;
  };
  const box = (depth: number, own: string): string => {
    const css = [
      own,
      'display:flex',
      chance(0.4)
        ? `flex-direction:${pick(['column', 'column', 'row', 'row-reverse', 'column-reverse'])}`
        : '',
      chance(0.08) ? 'flex-wrap:wrap' : '',
      chance(0.05) ? 'direction:rtl' : '',
      chance(0.4)
        ? `justify-content:${pick(['center', 'flex-end', 'space-between', 'space-around', 'space-evenly', 'start', 'end'])}`
        : '',
      chance(0.4)
        ? `align-items:${pick(['center', 'flex-start', 'flex-end', 'baseline', 'stretch'])}`
        : '',
      chance(0.3) ? `gap:${pick([px(12), `${px(8)} ${px(4)}`, '2%'])}` : '',
      chance(0.1) ? `height:${pick([px(160), '100%'])}` : '',
      chance(0.1) ? `min-height:${px(120)}` : '',
      chance(0.08) ? `max-height:${px(120)}` : '',
    ]
      .filter(Boolean)
      .join(';');
    const count = pick([0, 1, 2, 2, 3, 3, 4, 6]);
    const items = Array.from({ length: count }, () => item(depth)).join('');
    return `<div style="${css}">${items}</div>`;
  };
  return `<style>body{margin:0;font:13px sans-serif}</style>${box(3, '')}${chance(0.4) ? box(2, 'width:60%') : ''}`;
}

test('a document comes to what it comes to on Yoga, over generated flex boxes', async (t) => {
  t.after(() => lineNodesOn(true));
  // DOCUMENT_SEEDS sweeps more of them, and DOCUMENT_FROM starts at one
  const seeds = Number(env.DOCUMENT_SEEDS ?? 60);
  for (let seed = Number(env.DOCUMENT_FROM ?? 1); seed <= seeds; seed += 1) {
    const source = flexDocument(mulberry32(seed * 7919));
    const width = 200 + (seed % 7) * 90;
    const lines = async (on: boolean): Promise<string[]> => {
      lineNodesOn(on);
      const { node } = await render(source, width);
      return treeLines(treeOf(view(node)) as Parameters<typeof treeLines>[0]);
    };
    const yoga = await lines(false);
    const line = await lines(true);
    assert.deepEqual(line, yoga, `seed ${seed}`);
  }
});

test('a box of one line makes no Yoga node, and one that wraps does', async () => {
  lineNodesOn(true);
  const row = '<p style="flex:1">words</p><p>more</p>';
  const madeFor = async (css: string): Promise<number> => {
    const before = yogaNodesMade();
    await render(`<div style="display:flex;${css}">${row}</div>`, 300);
    return yogaNodesMade() - before;
  };
  assert.equal(await madeFor(''), 0);
  assert.equal(await madeFor('flex-direction:column'), 0);
  // a root and two items, as many times as a probe asks
  assert.ok((await madeFor('flex-wrap:wrap')) >= 3);
  assert.ok((await madeFor('direction:rtl')) >= 3);
  assert.ok((await madeFor('flex-direction:row-reverse')) >= 3);
  assert.ok((await madeFor('flex-direction:column-reverse')) >= 3);
});
