// <Html> — the cascade: inheritance, layers, nesting, logical properties, and
// what a restyle costs.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import {
  act,
  cleanup,
  pixelAt,
  renderX11,
  screen,
  waitFor,
} from 'react-x11/test';
import type { DrawnNode } from 'react-x11';
import { Html } from '../../src/index.js';
import { HtmlViewNode, removeNode } from '../../src/html/index.js';
import type { Element } from '../../src/html/index.js';
import {
  parseStylesheet,
  supportsCondition,
} from '../../src/html/css/parse.js';
import {
  INHERITED,
  ROUND_CORNERS,
  applyDeclaration,
  inherit,
  initialStyle,
} from '../../src/html/css/style.js';
import type { ComputedStyle } from '../../src/html/css/style.js';
import { isTransparent, parseColor } from '../../src/html/css/values.js';
import type { Len } from '../../src/html/css/values.js';
import {
  boxOf,
  edgesOf,
  findById,
  h,
  HAS_ARGUMENTS,
  HAS_MATCHED,
  hasArgumentsDocument,
  metric,
  render,
  renderWithBytes,
  view,
} from './harness.js';
import type { LaidBox } from './harness.js';

afterEach(cleanup);

test('inherit reaches the box model', async () => {
  const { node } = await render(
    '<div style="margin:0 7px;padding:3px"><p id="p" style="margin:inherit;' +
      'padding:inherit">x</p></div>',
  );
  const p = boxOf(view(node), 'p') as LaidBox & {
    marginLeft: number;
    padLeft: number;
  };
  assert.strictEqual(p.marginLeft, 7);
  assert.strictEqual(p.padLeft, 3);
});

test('initial is where a property starts, inherited or not', async () => {
  // `line-height: initial` in a box inside 200px lines was 200px still,
  // which it inherits, and `margin: initial` after a margin was that
  // margin: the keyword is the property's initial value, whatever came
  // before it (CSS Cascade 4, 7.3.1)
  const { node } = await render(
    '<style>#a { margin: 9px } #a { margin: initial }</style>' +
      '<div style="line-height:200px"><p id="p" style="line-height:initial">' +
      'x</p></div><p id="a">x</p>',
  );
  const el = view(node);
  const style = (id: string) =>
    (
      boxOf(el, id) as unknown as {
        style: { lineHeight: unknown; marginTop: number };
      }
    ).style;
  assert.strictEqual(style('p').lineHeight, 'normal');
  assert.strictEqual(style('a').marginTop, 0);
});

metric(
  'the body inherits its colour and font from the root, an html rule too',
  async () => {
    const doc = await renderWithBytes(
      '<html><style>html { color: #00ff00; font-family: serif }</style>' +
        '<body><p id="p">x</p></body></html>',
      {},
    );
    const style = (el: HtmlViewNode) =>
      (boxOf(el, 'p') as unknown as { style: Record<string, unknown> }).style;
    assert.strictEqual(style(doc.el).color, '#00ff00');
    assert.strictEqual(style(doc.el).fontFamily, 'serif');
    cleanup();
    // a fragment's body inherits from the html a browser would imply
    const fragment = await renderWithBytes(
      '<style>html { color: #00ff00 }</style><p id="p">x</p>',
      {},
    );
    assert.strictEqual(style(fragment.el).color, '#00ff00');
    cleanup();
    // and so does a page with a <body> and no <html>, the usual shape of
    // one that starts `<!DOCTYPE html><title>`, where the rule matched
    // nothing and the page came out at the theme's size
    const page = await renderWithBytes(
      '<!DOCTYPE html><title>t</title><style>html { color: #00ff00; ' +
        'font-size: 10px }</style><body><p id="p">x</p></body>',
      {},
    );
    assert.strictEqual(style(page.el).color, '#00ff00');
    assert.strictEqual(style(page.el).fontSize, 10);
  },
);

metric(
  ':root is the html element, not every element at the top of a fragment',
  async () => {
    const { el } = await renderWithBytes(
      '<style>:root { --c: #00ff00; margin-left: 30px } p { color: var(--c) }</style>' +
        '<p id="p">x</p>',
      {},
    );
    const p = boxOf(el, 'p') as unknown as {
      x: number;
      style: Record<string, unknown>;
    };
    // the property reaches the paragraph through the html a browser implies
    assert.strictEqual(p.style.color, '#00ff00');
    // and the paragraph does not take the root's margin as its own
    assert.strictEqual(p.style.marginLeft, 0);
  },
);

test('a longhand that shares a field with its siblings takes only its own part of it, through a var(), inherit and initial', async () => {
  // A declaration with a `var()` is set back to its initial value first, in
  // case what it substitutes is no value, and `inherit` and `initial` copy
  // the property from another style. Taken whole, each undid the siblings
  // before it: GitHub's search box rounds its left side with
  // `border-top-left-radius: var(--borderRadius-medium)` and the same at the
  // bottom left, and its top corner was square. What each case comes to is
  // Chrome's
  const edge = { name: 'entry', offset: { pct: 10 } };
  const end = { name: null, offset: { pct: 100 } };
  const multicol = (s: ComputedStyle) => [
    s.columnCount,
    s.columnWidth,
    s.columns,
  ];
  const radii = (s: ComputedStyle) => s.borderRadius;
  const image = (s: ComputedStyle) => s.borderImage;
  const cases: [string, (s: ComputedStyle) => unknown, unknown][] = [
    [
      'border-top-left-radius:var(--r);border-bottom-left-radius:var(--r)',
      radii,
      [6, 0, 0, 6],
    ],
    ['border-radius:8px;border-top-left-radius:initial', radii, [0, 8, 8, 8]],
    ['border-radius:8px;border-top-left-radius:inherit', radii, [0, 8, 8, 8]],
    ['border-radius:8px;border-top-left-radius:unset', radii, [0, 8, 8, 8]],
    [
      'border-top-left-radius:6px;border-bottom-left-radius:var(--missing)',
      radii,
      [6, 0, 0, 0],
    ],
    // its own part goes back, as the var() that substitutes nothing says
    [
      'border-bottom-left-radius:6px;border-bottom-left-radius:var(--missing)',
      radii,
      [0, 0, 0, 0],
    ],
    // a corner is two radii, in two fields
    [
      'border-top-left-radius:6px 3px;border-bottom-left-radius:var(--r)',
      (s) => [s.borderRadius, s.borderRadiusY],
      [
        [6, 0, 0, 6],
        [3, 0, 0, 6],
      ],
    ],
    [
      'corner-top-left-shape:bevel;corner-bottom-left-shape:var(--bevel)',
      (s) => s.cornerShape,
      [0, 1, 1, 0],
    ],
    [
      'corner-shape:bevel;corner-top-shape:initial',
      (s) => s.cornerShape,
      [1, 1, 0, 0],
    ],
    // all of them round again is the style's one round value, which a
    // paint compares with
    [
      'corner-top-left-shape:bevel;corner-top-left-shape:var(--missing)',
      (s) => s.cornerShape === ROUND_CORNERS,
      true,
    ],
    [
      'border-image-source:var(--image);border-image-slice:var(--slice)',
      (s) => [image(s).source !== null, image(s).slice],
      [true, [10, 10, 10, 10]],
    ],
    [
      'border-image-slice:10 fill;border-image-source:var(--missing)',
      (s) => [image(s).source, image(s).slice, image(s).fill],
      [null, [10, 10, 10, 10], true],
    ],
    [
      'border-image-repeat:round;border-image-slice:10 fill;' +
        'border-image-slice:initial',
      (s) => [image(s).slice[0], image(s).fill, image(s).repeat],
      [{ pct: 100 }, false, ['round', 'round']],
    ],
    [
      'column-rule-width:var(--w);column-rule-style:var(--dashed);' +
        'column-rule-color:var(--c)',
      (s) => [s.columnRule.width, s.columnRule.style, s.columnRule.color],
      [5, 'dashed', '#ff0000'],
    ],
    // `rule-*` is both axes' rule, each keeping the rest of its own
    [
      'row-rule-style:dashed;column-rule-style:dotted;rule-width:var(--w)',
      (s) => [
        s.rowRule.width,
        s.rowRule.style,
        s.columnRule.width,
        s.columnRule.style,
      ],
      [5, 'dashed', 5, 'dotted'],
    ],
    [
      'row-rule-width:5px;row-rule-style:dashed;rule-width:var(--missing)',
      (s) => [s.rowRule.width, s.rowRule.style],
      [3, 'dashed'],
    ],
    [
      'timeline-trigger-name:var(--name);timeline-trigger-source:var(--source)',
      (s) => [s.timelineTriggers.names, s.timelineTriggers.sources[0].kind],
      [['--t'], 'view'],
    ],
    [
      'timeline-trigger-activation-range-start:entry 10%;' +
        'timeline-trigger-activation-range-end:var(--missing)',
      (s) => s.timelineTriggers.activation,
      [[edge, end]],
    ],
    [
      'white-space-collapse:var(--keep);text-wrap-mode:var(--flat)',
      (s) => s.whiteSpace,
      'pre',
    ],
    [
      'text-wrap-mode:nowrap;white-space-collapse:var(--keep)',
      (s) => s.whiteSpace,
      'pre',
    ],
    [
      'white-space-collapse:preserve;text-wrap-mode:inherit',
      (s) => s.whiteSpace,
      'pre-wrap',
    ],
    [
      'white-space-collapse:preserve;text-wrap:var(--missing)',
      (s) => s.whiteSpace,
      'pre-wrap',
    ],
    // `columns` says it is a multicol container, by what either of them says
    [
      'column-width:100px;column-count:var(--missing)',
      multicol,
      [null, 100, 2],
    ],
    ['column-count:3;column-width:initial', multicol, [3, null, 1]],
    // under the name WebKit had it by, a declaration of the same property
    [
      'column-width:100px;-webkit-column-count:3;' +
        '-webkit-column-count:var(--missing)',
      multicol,
      [null, 100, 2],
    ],
  ];
  const { node } = await render(
    '<style>:root{--r:6px;--bevel:bevel;--slice:10;' +
      '--image:linear-gradient(#ff0000,#0000ff);--w:5px;--dashed:dashed;' +
      '--c:#ff0000;--name:--t;--source:view();--keep:preserve;--flat:nowrap}' +
      '</style>' +
      cases.map(([css], i) => `<p id="c${i}" style="${css}">x</p>`).join(''),
  );
  const el = view(node);
  cases.forEach(([css, read, expected], i) => {
    const { style } = boxOf(el, `c${i}`) as unknown as { style: ComputedStyle };
    assert.deepStrictEqual(read(style), expected, css);
  });
});

const PHYSICAL_SIDES = ['top', 'right', 'bottom', 'left'];

/** A flow, and the sides its inline-start, inline-end, block-start and
 *  block-end are. */
const LOGICAL_FLOWS: [string, Record<string, string>][] = (
  [
    ['', 'left', 'right', 'top', 'bottom'],
    ['direction:rtl', 'right', 'left', 'top', 'bottom'],
    ['writing-mode:vertical-rl', 'top', 'bottom', 'right', 'left'],
    ['writing-mode:vertical-lr', 'top', 'bottom', 'left', 'right'],
    [
      'writing-mode:vertical-rl;direction:rtl',
      'bottom',
      'top',
      'right',
      'left',
    ],
    ['writing-mode:sideways-lr', 'bottom', 'top', 'left', 'right'],
  ] as const
).map(([flow, start, end, before, after]) => [
  flow,
  {
    'inline-start': start,
    'inline-end': end,
    'block-start': before,
    'block-end': after,
  },
]);

test('a logical property whose var() has no value goes back as though unset, in every flow', async () => {
  // A declaration with a `var()` goes back before what it substitutes is
  // read, and what took it back knew the physical names alone, so
  // `margin-inline-start: 4px; margin-inline-start: var(--missing)` kept its
  // 4px. Here is each of `LOGICAL`'s names in each flow, and what each case
  // comes to is Chrome's `getComputedStyle`
  const box = 'border:5px solid #ff0000;color:#0000ff';
  const sides = PHYSICAL_SIDES;
  const corners = [
    ['top', 'left'],
    ['top', 'right'],
    ['bottom', 'right'],
    ['bottom', 'left'],
  ];
  const flows = LOGICAL_FLOWS;
  // what sets all four sides, the family's logical name, a side's physical
  // names, and what they read as set and as gone back
  const families: [
    string,
    (part: string) => string,
    (side: string) => string[],
    string[],
    string[],
  ][] = [
    [
      'margin:4px',
      (part) => `margin-${part}`,
      (side) => [`margin-${side}`],
      ['4px'],
      ['0px'],
    ],
    [
      'padding:4px',
      (part) => `padding-${part}`,
      (side) => [`padding-${side}`],
      ['4px'],
      ['0px'],
    ],
    [
      'inset:4px',
      (part) => `inset-${part}`,
      (side) => [side],
      ['4px'],
      ['auto'],
    ],
    [
      box,
      (part) => `border-${part}-width`,
      (side) => [`border-${side}-width`],
      ['5px'],
      ['3px'],
    ],
    [
      box,
      (part) => `border-${part}-style`,
      (side) => [`border-${side}-style`],
      ['solid'],
      ['none'],
    ],
    [
      box,
      (part) => `border-${part}-color`,
      (side) => [`border-${side}-color`],
      ['rgb(255, 0, 0)'],
      ['rgb(0, 0, 255)'],
    ],
    [
      box,
      (part) => `border-${part}`,
      (side) => [
        `border-${side}-width`,
        `border-${side}-style`,
        `border-${side}-color`,
      ],
      ['5px', 'solid', 'rgb(255, 0, 0)'],
      ['0px', 'none', 'rgb(0, 0, 255)'],
    ],
  ];
  // a size's name, its physical name across and down the page, what it goes
  // back to, and what gets its computed value read: a box that shows answers
  // with its used size, and one that is no flex item reads `min-width:
  // auto` as 0
  const sizes = [
    ['inline-size', 'width', 'height', 'auto', 'display:none'],
    ['block-size', 'height', 'width', 'auto', 'display:none'],
    ['min-inline-size', 'min-width', 'min-height', 'auto', ''],
    ['min-block-size', 'min-height', 'min-width', 'auto', ''],
    ['max-inline-size', 'max-width', 'max-height', 'none', 'display:none'],
    ['max-block-size', 'max-height', 'max-width', 'none', 'display:none'],
  ];
  const css = (...parts: string[]) => parts.filter(Boolean).join(';');
  const computed: [string, string[], string[]][] = [
    // what it goes back from need not have been a logical declaration
    [
      'margin-left:4px;margin-inline-start:var(--missing)',
      ['margin-left'],
      ['0px'],
    ],
    // nor need the var() have no value, where what it comes to is none
    [
      'margin-inline:4px;margin-inline:var(--color)',
      ['margin-left', 'margin-right'],
      ['0px', '0px'],
    ],
    [
      'margin-inline:4px;margin-inline:1px var(--missing)',
      ['margin-left', 'margin-right'],
      ['0px', '0px'],
    ],
    [
      'padding-inline:4px;padding-inline:var(--negative)',
      ['padding-left', 'padding-right'],
      ['0px', '0px'],
    ],
    [
      'padding-block:4px;padding-block:var(--color) 1px',
      ['padding-top', 'padding-bottom'],
      ['0px', '0px'],
    ],
    [
      'inset-block:4px;inset-block:var(--color)',
      ['top', 'bottom'],
      ['auto', 'auto'],
    ],
    [
      'color:#0000ff;border-inline-color:#ff0000;border-inline-color:var(--r)',
      ['border-left-color', 'border-right-color'],
      ['rgb(0, 0, 255)', 'rgb(0, 0, 255)'],
    ],
    [
      'border-block:5px solid #ff0000;border-block:var(--r) var(--color) 1px',
      ['border-top-style', 'border-bottom-style'],
      ['none', 'none'],
    ],
    // and under the names WebKit had them by, the cause is the same: the
    // name was looked up as it was written
    [
      '-webkit-writing-mode:vertical-rl;-webkit-writing-mode:var(--missing)',
      ['writing-mode'],
      ['horizontal-tb'],
    ],
    [
      '-webkit-text-orientation:upright;-webkit-text-orientation:var(--missing)',
      ['text-orientation'],
      ['mixed'],
    ],
    [
      '-webkit-user-select:none;-webkit-user-select:var(--missing)',
      ['user-select'],
      ['auto'],
    ],
  ];
  // what the record has no answer for is read from the style: a corner, and
  // a size that is a keyword, which is kept beside its length
  const drawn: [string, (s: ComputedStyle) => unknown, unknown][] = [
    [
      'inline-size:fit-content;inline-size:var(--missing)',
      (s) => s.widthKeyword,
      null,
    ],
    [
      'min-inline-size:min-content;min-inline-size:var(--missing)',
      (s) => s.minWidthKeyword,
      null,
    ],
    [
      'max-block-size:max-content;max-block-size:var(--missing)',
      (s) => s.maxHeightKeyword,
      null,
    ],
  ];
  for (const [flow, of] of flows) {
    for (const [set, name, names, kept, gone] of families) {
      for (const part of ['inline', 'block']) {
        for (const reach of [part, `${part}-start`, `${part}-end`]) {
          const reached = Object.keys(of)
            .filter((logical) => logical.startsWith(reach))
            .map((logical) => of[logical]);
          computed.push([
            css(flow, set, `${name(reach)}:var(--missing)`),
            sides.flatMap(names),
            sides.flatMap((side) => (reached.includes(side) ? gone : kept)),
          ]);
        }
      }
    }
    for (const [name, across, down, gone, shown] of sizes) {
      const physical = flow.includes('writing-mode') ? down : across;
      computed.push([
        css(flow, shown, `${physical}:40px`, `${name}:var(--missing)`),
        [physical],
        [gone],
      ]);
    }
    for (const block of ['start', 'end']) {
      for (const inline of ['start', 'end']) {
        const at = [of[`block-${block}`], of[`inline-${inline}`]];
        const corner = corners.findIndex((c) => c.every((s) => at.includes(s)));
        drawn.push(
          [
            css(
              flow,
              'border-radius:8px',
              `border-${block}-${inline}-radius:var(--missing)`,
            ),
            (s) => s.borderRadius,
            corners.map((_, i) => (i === corner ? 0 : 8)),
          ],
          [
            css(
              flow,
              'corner-shape:bevel',
              `corner-${block}-${inline}-shape:var(--missing)`,
            ),
            (s) => s.cornerShape,
            corners.map((_, i) => (i === corner ? 1 : 0)),
          ],
        );
      }
    }
  }
  // each is a flex item, for its `min-width`
  const page = (
    [
      ...computed.map(([style], i) => [`c${i}`, style]),
      ...drawn.map(([style], i) => [`d${i}`, style]),
    ] as const
  )
    .map(
      ([id, style]) =>
        `<div style="display:flex"><div id="${id}" style="${style}">x</div></div>`,
    )
    .join('');
  const { node } = await render(
    `<style>:root{--r:6px;--color:red;--negative:-3px}</style>${page}`,
  );
  const el = view(node);
  computed.forEach(([style, names, expected], i) => {
    const own = el.computedStyle(findById(el.document, `c${i}`)!)!;
    assert.deepStrictEqual(
      names.map((name) => own[name]),
      expected,
      style,
    );
  });
  drawn.forEach(([style, read, expected], i) => {
    const box = boxOf(el, `d${i}`) as unknown as { style: ComputedStyle };
    assert.deepStrictEqual(read(box.style), expected, style);
  });
});

test('scroll-margin and scroll-padding have logical names, which follow the flow and go back as any does', async () => {
  // Each name was a fixed side, as a left-to-right horizontal flow has it, so
  // `direction:rtl;scroll-margin-inline-start:4px` set the left, and no table
  // had them, so neither a keyword nor a `var()` took one back. The record has
  // none of these properties, so each is read from the style's fields, and
  // what each case comes to is Chrome's `getComputedStyle`
  const css = (...parts: string[]) => parts.filter(Boolean).join(';');
  const families = [
    ['scroll-margin', '0px'],
    ['scroll-padding', 'auto'],
  ] as const;
  const rows: [string, string[]][] = [];
  const row = (
    style: string,
    family: string,
    at: (side: string) => string,
  ): void => {
    rows.push([
      style,
      families.flatMap(([name, gone]) =>
        PHYSICAL_SIDES.map((side) => (name === family ? at(side) : gone)),
      ),
    ]);
  };
  // where the old fixed sides were
  const fixed = LOGICAL_FLOWS[0][1];
  const goneBack = [
    'var(--missing)',
    'var(--color)',
    '1px var(--missing)',
    'var(--missing, revert)',
    'unset',
    'initial',
    'revert',
  ];
  for (const [flow, of] of LOGICAL_FLOWS) {
    for (const [family, gone] of families) {
      for (const axis of ['inline', 'block']) {
        const start = of[`${axis}-start`];
        const end = of[`${axis}-end`];
        for (const reach of [axis, `${axis}-start`, `${axis}-end`]) {
          const reached = Object.keys(of)
            .filter((logical) => logical.startsWith(reach))
            .map((logical) => of[logical]);
          const set = css(flow, `${family}:4px`);
          for (const value of goneBack) {
            row(css(set, `${family}-${reach}:${value}`), family, (side) =>
              reached.includes(side) ? gone : '4px',
            );
          }
          // the parent's, which is 9px
          row(css(set, `${family}-${reach}:inherit`), family, (side) =>
            reached.includes(side) ? '9px' : '4px',
          );
        }
        // the fixed side was right where the flow has it there
        if (start === fixed[`${axis}-start`]) continue;
        const name = `${family}-${axis}`;
        row(css(flow, `${name}:1px 2px`), family, (side) =>
          side === start ? '1px' : side === end ? '2px' : gone,
        );
        row(css(flow, `${name}-start:7px`), family, (side) =>
          side === start ? '7px' : gone,
        );
        row(css(flow, `${name}-end:7px`), family, (side) =>
          side === end ? '7px' : gone,
        );
      }
    }
  }
  const asDeclared: [string, string, (side: string) => string][] = [
    // a physical name goes back by the logical one that stands for it
    [
      'scroll-margin:4px;scroll-margin-left:6px;scroll-margin-inline-start:var(--missing)',
      'scroll-margin',
      (side) => (side === 'left' ? '0px' : '4px'),
    ],
    // the flow is the element's, wherever it is declared
    [
      'scroll-margin-inline-start:7px;writing-mode:vertical-rl',
      'scroll-margin',
      (side) => (side === 'top' ? '7px' : '0px'),
    ],
    [
      'scroll-padding-block-start:7px;writing-mode:vertical-rl',
      'scroll-padding',
      (side) => (side === 'right' ? '7px' : 'auto'),
    ],
    // what scroll-padding takes that scroll-margin does not
    [
      'direction:rtl;scroll-padding-inline:auto 10%',
      'scroll-padding',
      (side) => (side === 'left' ? '10%' : 'auto'),
    ],
  ];
  for (const [style, family, at] of asDeclared) row(style, family, at);
  // what is no value leaves what the cascade reached, all of it
  for (const [family, value] of [
    ['scroll-margin-inline', '1px 2px 3px'],
    ['scroll-margin-block', '1px 10%'],
    ['scroll-margin-inline', 'auto 1px'],
    ['scroll-padding-inline', '1px 2px 3px'],
    ['scroll-padding-block', '1px -2px'],
    ['scroll-padding-inline', '1px red'],
  ]) {
    const name = family.replace(/-(inline|block)$/, '');
    row(`${name}:4px;${family}:${value}`, name, () => '4px');
  }
  const page = rows
    .map(
      ([style], i) =>
        `<div style="scroll-margin:9px;scroll-padding:9px"><div id="c${i}" style="${style}">x</div></div>`,
    )
    .join('');
  const { node } = await render(`<style>:root{--color:red}</style>${page}`);
  const el = view(node);
  const read = (len: Len): string =>
    typeof len === 'number'
      ? `${len}px`
      : typeof len === 'string'
        ? len
        : `${len.pct}%`;
  rows.forEach(([style, expected], i) => {
    const { style: s } = boxOf(el, `c${i}`) as unknown as {
      style: ComputedStyle;
    };
    assert.deepStrictEqual(
      [
        s.scrollMarginTop,
        s.scrollMarginRight,
        s.scrollMarginBottom,
        s.scrollMarginLeft,
        s.scrollPaddingTop,
        s.scrollPaddingRight,
        s.scrollPaddingBottom,
        s.scrollPaddingLeft,
      ].map(read),
      expected,
      style,
    );
  });
});

test('place-content goes back with its two longhands', async () => {
  // No table had it, so `place-content:center` stayed centred under anything
  // that takes a declaration back. The record has neither longhand, so each
  // is read from the style's fields, and what each case comes to is Chrome's
  // `getComputedStyle`, `align-content`'s `normal` being `stretch` in its field
  const rows: [string, string, string][] = [
    ['place-content:center;place-content:unset', 'normal', 'normal'],
    ['place-content:center;place-content:initial', 'normal', 'normal'],
    ['place-content:center;place-content:revert', 'normal', 'normal'],
    ['place-content:center;place-content:var(--missing)', 'normal', 'normal'],
    ['place-content:center;place-content:var(--color)', 'normal', 'normal'],
    [
      'place-content:center;place-content:var(--missing, revert)',
      'normal',
      'normal',
    ],
    [
      'align-content:center;justify-content:end;place-content:var(--missing)',
      'normal',
      'normal',
    ],
    ['place-content:center;place-content:inherit', 'end', 'space-between'],
    [
      'display:grid;place-content:center;place-content:var(--missing)',
      'normal',
      'normal',
    ],
  ];
  const page = rows
    .map(
      ([style], i) =>
        `<div style="place-content:end space-between"><div id="c${i}" style="${style}">x</div></div>`,
    )
    .join('');
  const { node } = await render(`<style>:root{--color:red}</style>${page}`);
  const el = view(node);
  rows.forEach(([style, align, justify], i) => {
    const { style: s } = boxOf(el, `c${i}`) as unknown as {
      style: ComputedStyle;
    };
    assert.deepStrictEqual(
      [
        s.alignContent === 'stretch' ? 'normal' : s.alignContent,
        s.justifyContent,
      ],
      [align, justify],
      style,
    );
  });
});

test('all whose var() has no value goes back as though unset, and a var() that comes to revert leaves what the cascade reached', async () => {
  // `all` was no name a table had either, so it went back nowhere. And a
  // value that substitutes to `revert`, as a fallback can, is the one that
  // has to find the UA sheet's declarations still there: only a fallback
  // can, since `--x: revert` is about `--x`. What each case comes to is
  // Chrome's `getComputedStyle`
  const cases: [string, string, string[], string[]][] = [
    [
      'p',
      'color:#ff0000;margin:4px;all:var(--missing)',
      ['display', 'color', 'margin-top', 'margin-left', 'font-size'],
      ['inline', 'rgb(0, 255, 0)', '0px', '0px', '20px'],
    ],
    [
      'p',
      'all:var(--missing);margin:4px',
      ['display', 'color', 'margin-top', 'margin-left'],
      ['inline', 'rgb(0, 255, 0)', '4px', '4px'],
    ],
    [
      'ul',
      'all:var(--missing)',
      ['display', 'padding-left', 'margin-top', 'list-style-type'],
      ['inline', '0px', '0px', 'disc'],
    ],
    // the size a later `em` reads is the one it went back to
    [
      'p',
      'font-size:30px;all:var(--missing);padding-left:1em',
      ['font-size', 'padding-left'],
      ['20px', '20px'],
    ],
    // what `all` does not name stays: the direction, the custom properties
    [
      'p',
      'direction:rtl;all:var(--missing)',
      ['direction', 'display'],
      ['rtl', 'inline'],
    ],
    [
      'p',
      '--own:7px;all:var(--missing);margin-left:var(--own)',
      ['display', 'margin-left'],
      ['inline', '7px'],
    ],
    ['p', 'margin-top:var(--missing, revert)', ['margin-top'], ['20px']],
    [
      'p',
      'margin-block-start:var(--missing, revert)',
      ['margin-top'],
      ['20px'],
    ],
    [
      'ul',
      'padding-inline-start:var(--missing, revert)',
      ['padding-left'],
      ['40px'],
    ],
    [
      'ul',
      'padding-inline:var(--missing, revert)',
      ['padding-left', 'padding-right'],
      ['40px', '0px'],
    ],
    [
      'p',
      'all:var(--missing, revert)',
      ['display', 'margin-top'],
      ['block', '20px'],
    ],
    [
      'ul',
      'all:var(--missing, revert)',
      ['display', 'padding-left', 'list-style-type'],
      ['block', '40px', 'disc'],
    ],
  ];
  const { node } = await render(
    '<main style="color:#00ff00;font-size:20px">' +
      cases
        .map(([tag, css], i) => `<${tag} id="c${i}" style="${css}">x</${tag}>`)
        .join('') +
      '</main>',
  );
  const el = view(node);
  cases.forEach(([, css, names, expected], i) => {
    const own = el.computedStyle(findById(el.document, `c${i}`)!)!;
    assert.deepStrictEqual(
      names.map((name) => own[name]),
      expected,
      css,
    );
  });
});

test('a property @property registers has its initial value where nothing sets it, and one that does not inherit starts again under what sets it', async () => {
  // CSS Properties and Values 1, 2.4 and 3. A page draws the stops of a
  // gradient from `--blob-core`, registered at `0%` and set only on some
  // elements; unregistered, it was no value on the rest, and they drew no
  // gradient. A rule with no `inherits` registers nothing, and the
  // universal syntax may have no initial value.
  const { node } = await render(
    '<style>' +
      '@property --c { syntax: "<color>"; inherits: false; initial-value: #ff0000 }' +
      '@property --i { syntax: "<color>"; inherits: true; initial-value: #00ff00 }' +
      '@property --bad { syntax: "<color>"; initial-value: #0000ff }' +
      '@property --u { syntax: "*"; inherits: false }' +
      '.c { color: var(--c) } .i { color: var(--i) }' +
      '.bad { color: var(--bad, #123456) } .u { color: var(--u, #abcdef) }' +
      '</style>' +
      '<p id="plain" class="c">x</p><p id="plain-i" class="i">x</p>' +
      '<p id="bad" class="bad">x</p><p id="u" class="u">x</p>' +
      '<div style="--c: #0000ff; --i: #ffff00">' +
      '<p id="under" class="c">x</p><p id="under-i" class="i">x</p>' +
      '<p id="reset" class="c" style="--c: initial">x</p>' +
      '<p id="bogus" class="c" style="--c: var(--nothing)">x</p>' +
      '<p id="inherit" class="c" style="--c: inherit">x</p></div>',
  );
  const el = view(node);
  const color = (id: string) =>
    (boxOf(el, id) as unknown as { style: { color: string } }).style.color;
  assert.deepStrictEqual(
    [
      'plain',
      'plain-i',
      'bad',
      'u',
      'under',
      'under-i',
      'reset',
      'bogus',
      'inherit',
    ].map(color),
    [
      '#ff0000',
      '#00ff00',
      '#123456',
      '#abcdef',
      // not its parent's: it does not inherit
      '#ff0000',
      '#ffff00',
      '#ff0000',
      // invalid where it is computed, and so as though unset: its initial
      // value, as it does not inherit
      '#ff0000',
      '#0000ff',
    ].map((c) => parseColor(c)),
  );
});

test("logical properties are the physical ones of the element's direction", async () => {
  // CSS Logical Properties 1 in the horizontal writing mode: Tailwind 4
  // writes its spacing in them, `px-4` as `padding-inline` and `mx-auto`
  // as `margin-inline: auto`
  const { node } = await render(
    '<style>body{margin:0}.px-4{padding-inline:calc(4px * 4)}' +
      '.py-2{padding-block:8px}.mx-auto{margin-inline:auto}</style>' +
      '<div style="width:400px"><div id="a" class="px-4 py-2 mx-auto" ' +
      'style="inline-size:100px;border-inline-start:3px solid"></div>' +
      '<div id="r" dir="rtl" style="margin-inline-start:10px;' +
      'padding-inline:1px 2px;border-start-end-radius:6px"></div>' +
      '<div id="o" style="padding-left:5px;padding-inline-start:7px;' +
      'margin-inline-end:4px;margin-right:9px"></div>' +
      '<div id="x" style="padding-inline:10px -5px;padding-block:1px 2px 3px">' +
      '</div></div>',
  );
  const el = view(node);
  const a = boxOf(el, 'a');
  const ae = edgesOf(a);
  assert.deepStrictEqual(
    [ae.padLeft, ae.padRight, ae.padTop, ae.padBottom, ae.borderLeft, a.width],
    [16, 16, 8, 8, 3, 135],
  );
  assert.strictEqual(a.x, (400 - 135) / 2, 'centred by its auto margins');
  const r = edgesOf(boxOf(el, 'r'));
  assert.deepStrictEqual(
    [r.marginRight, r.marginLeft, r.padRight, r.padLeft],
    [10, 0, 1, 2],
    'the start is the right, right to left',
  );
  assert.deepStrictEqual(r.style.borderRadius, [6, 0, 0, 0], 'and the corner');
  const o = edgesOf(boxOf(el, 'o'));
  assert.deepStrictEqual(
    [o.padLeft, o.marginRight],
    [7, 9],
    'whichever of the two comes later',
  );
  const x = edgesOf(boxOf(el, 'x'));
  assert.deepStrictEqual(
    [x.padLeft, x.padRight, x.padTop, x.padBottom],
    [0, 0, 0, 0],
    'a part that is no value takes the declaration with it',
  );
});

test('inset sets all four offsets, and a corner its radius', async () => {
  const { node } = await render(
    '<style>body{margin:0}</style>' +
      '<div style="position:relative;width:200px;height:100px">' +
      '<div id="f" style="position:absolute;inset:0"></div>' +
      '<div id="g" style="position:absolute;inset:10px 20px"></div></div>' +
      '<div id="c" style="border-top-left-radius:8px;' +
      'border-bottom-right-radius:4px 2px"></div>',
  );
  const el = view(node);
  const [f, g] = [boxOf(el, 'f'), boxOf(el, 'g')];
  assert.deepStrictEqual([f.x, f.y, f.width, f.height], [0, 0, 200, 100]);
  assert.deepStrictEqual([g.x, g.y, g.width, g.height], [20, 10, 160, 80]);
  assert.deepStrictEqual(
    edgesOf(boxOf(el, 'c')).style.borderRadius,
    [8, 0, 4, 0],
  );
});

test('a later cascade layer wins over an earlier one, and no layer over any', async () => {
  // CSS Cascade 5: Tailwind 4 writes all of its CSS in `@layer theme,
  // base, components, utilities`, which was dropped whole
  const colorOf = async (css: string, markup = '<p id="p" class="x">x</p>') => {
    const { node } = await render(`<style>${css}</style>${markup}`);
    const style = (
      boxOf(view(node), 'p') as unknown as { style: { color: string } }
    ).style;
    cleanup();
    return style.color;
  };
  const red = '#ff0000';
  const blue = '#0000ff';
  // the order the layers are first named in, not their specificity
  assert.strictEqual(
    await colorOf(
      '@layer a, b; @layer b { .x { color: #0000ff } } ' +
        '@layer a { p#p.x { color: #ff0000 } }',
    ),
    blue,
  );
  assert.strictEqual(
    await colorOf(
      '.x { color: #0000ff } @layer a { p#p.x { color: #ff0000 } }',
    ),
    blue,
    'a rule in no layer over one in any',
  );
  assert.strictEqual(
    await colorOf(
      '@layer a { .x { color: #ff0000 !important } } ' +
        '@layer b { .x { color: #0000ff !important } } .x { color: #008000 !important }',
    ),
    red,
    'and the other way round for !important',
  );
  assert.strictEqual(
    await colorOf(
      '@layer a { .x { color: #ff0000 } @layer b { p#p.x { color: #0000ff } } }',
    ),
    red,
    "a layer's own rules over the layers in it",
  );
  assert.strictEqual(
    await colorOf(
      '',
      '<style>@layer b, a;</style><style>@layer a { .x { color: #ff0000 } } ' +
        '@layer b { .x { color: #0000ff } }</style><p id="p" class="x">x</p>',
    ),
    red,
    "the order is the document's, across its sheets",
  );
  assert.strictEqual(
    await colorOf(
      '@layer { .x { color: #ff0000 } } @layer { .x { color: #0000ff } }',
    ),
    blue,
    'a layer with no name is one of its own',
  );
});

test('a nested rule is relative to its parent, and a nested @media holds for it', () => {
  // CSS Nesting 1, as Tailwind 4 writes its variants: `md:flex` is a
  // `@media` inside the rule, and `hover:` is `&:hover`
  const sheet = parseStylesheet(
    '.md\\:flex { @media (width >= 48rem) { display: flex } }\n' +
      '.hover\\:x { &:hover { @media (hover: hover) { color: red } } }\n' +
      '.space { :where(& > :not(:last-child)) { margin: 1px } }\n' +
      '.card { color: blue; .title { color: red } > p { margin: 0 }' +
      ' &.on, &:focus { color: green } }\n' +
      '.a, .b { & + & { margin: 2px } }\n' +
      '.x { --x: { a: b }; div& { color: red } &div { color: red } }',
  );
  assert.deepStrictEqual(
    sheet.rules.map((r) => [r.selector, JSON.stringify(r.media)]),
    [
      ['.md\\:flex', '[[{"min":768}]]'],
      ['.hover\\:x:hover', '[[{"staticPass":true}]]'],
      [':where(:is(.space) > :not(:last-child))', 'null'],
      ['.card', 'null'],
      ['.card .title', 'null'],
      ['.card > p', 'null'],
      ['.card.on', 'null'],
      ['.card:focus', 'null'],
      [':is(.a) + :is(.a)', 'null'],
      [':is(.b) + :is(.b)', 'null'],
      ['.x', 'null'],
      // `&div` has its type after the rest of its compound, which is no
      // selector, and goes; `div&` is the way to write it
      ['div:is(.x)', 'null'],
    ],
  );
  // in the order they are written, after the parent's own declarations
  const orders = sheet.rules.map((r) => r.order);
  assert.deepStrictEqual(
    orders,
    [...orders].sort((a, b) => a - b),
  );
});

test('a nested rule and a media range reach the document', async () => {
  const { node } = await render(
    '<style>body{margin:0}.p { padding-left: 1px; & { padding-top: 2px }' +
      ' @media (width >= 300px) { padding-right: 3px }' +
      ' @media (width < 300px) { padding-bottom: 4px }' +
      ' .c { margin-left: 5px } }</style>' +
      '<div id="p" class="p"><div id="c" class="c"></div></div>',
  );
  const el = view(node);
  const p = edgesOf(boxOf(el, 'p'));
  assert.deepStrictEqual(
    [p.padLeft, p.padTop, p.padRight, p.padBottom],
    [1, 2, 3, 0],
  );
  assert.strictEqual(edgesOf(boxOf(el, 'c')).marginLeft, 5);
});

test('a style takes from its parent the fields INHERITED names, and no others', () => {
  // `inherit` writes them out one by one, where a loop over the list was
  // three quarters of each element's style: the list and the function
  // have to stay the same set
  const look = {
    color: '#010101',
    fontFamily: 'sans-serif',
    fontSize: 14,
    monoFamily: 'monospace',
    linkColor: '#020202',
    borderColor: '#030303',
    mutedColor: '#040404',
    background: '#050505',
    colorScheme: 'light' as const,
    surface: '#060606',
    controlPadY: 4,
    controlBorder: 1,
    controlRadius: 4,
  };
  const initial = initialStyle(look, 1);
  // a parent every field of which differs from the initial style's
  const parent = { ...initial } as Record<string, unknown>;
  for (const key of Object.keys(parent)) parent[key] = { marker: key };
  const out = inherit(
    parent as unknown as ComputedStyle,
    initial,
  ) as unknown as Record<string, unknown>;
  const taken = Object.keys(out)
    .filter((key) => out[key] === parent[key])
    .sort();
  const expected = [
    ...INHERITED,
    'underline',
    'underlineStyle',
    'underlineThickness',
    'underlineOffset',
    'lineThrough',
    'lineThroughStyle',
    'lineThroughThickness',
  ].sort();
  assert.deepStrictEqual(taken, expected);
});

test('all sets every field a property does, and not direction, unicode-bidi or a custom one', () => {
  // CSS Cascade 4, 3.2.1. A field at a time, so this holds it to the whole
  // style: a field added to it is one `all` sets unless it is said not to be
  const look = {
    color: '#010101',
    fontFamily: 'sans-serif',
    fontSize: 14,
    monoFamily: 'monospace',
    linkColor: '#020202',
    borderColor: '#030303',
    mutedColor: '#040404',
    background: '#050505',
    colorScheme: 'light' as const,
    surface: '#060606',
    controlPadY: 4,
    controlBorder: 1,
    controlRadius: 4,
  };
  const initial = initialStyle(look, 1);
  const marked = (tag: string) => {
    const out = { ...initial } as Record<string, unknown>;
    for (const key of Object.keys(out)) out[key] = { [tag]: key };
    return out as unknown as ComputedStyle;
  };
  const parent = marked('parent');
  const ctx = { em: 14, rem: 14, vw: 0, vh: 0, scale: 1, initial };
  const kept = [
    'custom',
    'direction',
    // no property: the zooms from the root down, which `all` cannot undo
    'effectiveZoom',
    // no property: worked out after the declarations, from the parent
    'itemsThrough',
    'lineThrough',
    'lineThroughStyle',
    'lineThroughThickness',
    'overlay',
    'styledControl',
    'underline',
    'underlineOffset',
    'underlineStyle',
    'underlineThickness',
    'unicodeBidi',
  ];
  const from = (value: string) => {
    const style = marked('own');
    applyDeclaration(style, parent, 'all', value, ctx);
    const out = style as unknown as Record<string, unknown>;
    const own = Object.keys(out).filter(
      (key) => (out[key] as { own?: string })?.own === key,
    );
    return { out, own: own.sort() };
  };
  const inherited = from('inherit');
  assert.deepStrictEqual(inherited.own, kept, 'inherit');
  for (const key of Object.keys(initial)) {
    if (kept.includes(key)) continue;
    assert.strictEqual(inherited.out[key], (parent as never)[key], key);
  }
  const initialised = from('INITIAL');
  assert.deepStrictEqual(initialised.own, kept, 'initial');
  for (const key of Object.keys(initial)) {
    if (kept.includes(key)) continue;
    assert.strictEqual(initialised.out[key], (initial as never)[key], key);
  }
  // unset: what a child starts from, an inherited field its parent's and
  // the rest initial
  const unset = from('unset');
  assert.deepStrictEqual(unset.own, kept, 'unset');
  assert.strictEqual(unset.out.color, parent.color);
  assert.strictEqual(unset.out.backgroundColor, initial.backgroundColor);
  // and nothing else is a value of it
  assert.strictEqual(from('red').own.length, Object.keys(initial).length);
  assert.strictEqual(from('revert').own.length, Object.keys(initial).length);
});

metric('a button reset with all: unset draws none of its control', async () => {
  // `button { all: unset }` is the first line of many a reset, and it was
  // no declaration at all: the UA sheet's background stayed on the button,
  // and asteriskmag.com's menu button, three 2px lines down a box 24px
  // tall, was a box filled with the palette's surface round them
  const { result, node } = await render(
    '<style>body { margin: 0; background: #ffffff }' +
      'button, input { all: unset; border: solid 1px #000000 }' +
      '.menu { width: 32px; height: 24px; padding: 0; border: none;' +
      ' display: flex; flex-direction: column; justify-content: space-between }' +
      '.line { display: block; height: 2px; background: #000000 }' +
      '#late { margin-top: 5px; all: unset } #early { all: unset; margin-top: 5px }' +
      '#rtl { all: unset; color: var(--c) }</style>' +
      '<div style="font-size: 20px; color: #00ff00; --c: #0000ff">' +
      '<button id="menu" class="menu"><span class="line"></span>' +
      '<span class="line"></span><span class="line"></span></button>' +
      '<button id="label">Go</button><input id="field">' +
      '<p id="late">x</p><p id="early">x</p><p id="rtl" dir="rtl">x</p></div>',
  );
  const el = view(node);
  await waitFor(() => assert.ok(boxOf(el, 'menu').height > 0));
  const style = (id: string) =>
    (boxOf(el, id) as unknown as { style: ComputedStyle }).style;
  for (const id of ['menu', 'label', 'field']) {
    assert.ok(isTransparent(style(id).backgroundColor), `${id}'s ground`);
  }
  // the parent's size, not a control's
  assert.strictEqual(style('label').fontSize, 20);
  assert.strictEqual(style('label').color, '#00ff00');
  assert.strictEqual(edgesOf(boxOf(el, 'label')).borderLeft, 1);
  // in its place in the cascade
  assert.strictEqual(style('late').marginTop, 0);
  assert.strictEqual(style('early').marginTop, 5);
  // with the direction the element had, and the custom properties it had
  assert.strictEqual(style('rtl').direction, 'rtl');
  assert.strictEqual(style('rtl').color, '#0000ff');
  // the lines with the page's ground between them
  const menu = boxOf(el, 'menu');
  const rows: number[][] = [];
  for (const y of [0, 5, 11, 17, 22]) {
    const [r, g, b] = await pixelAt(result.ctx, menu.x + 16, menu.y + y);
    rows.push([r, g, b]);
  }
  assert.deepStrictEqual(rows, [
    [0, 0, 0],
    [255, 255, 255],
    [0, 0, 0],
    [255, 255, 255],
    [0, 0, 0],
  ]);
});

test('an append to a streamed document keeps its stylesheet parsed', async () => {
  // a framework's stylesheet was parsed and its rules indexed again on
  // every append, and every width across a breakpoint
  const doc = (source: string) =>
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source, 'data-testname': 'doc' }),
    );
  const head = '<style>p { color: #0b0b0b }</style><p>one</p>';
  const result = await renderX11(doc(head), { backend: 'mock' });
  const el = () => view(screen.getByTestName('doc') as DrawnNode);
  const cascadeOf = () => (el() as unknown as { _cascade: unknown })._cascade;
  el().textContent();
  const before = cascadeOf();
  assert.ok(before, 'a cascade');
  await act(() => result.rerender(doc(head + '<p>two</p>')));
  assert.strictEqual(el().textContent(), 'onetwo');
  assert.strictEqual(cascadeOf(), before, 'the same cascade');
  // and the paragraph that arrived is styled by it
  const tree = (
    el() as unknown as {
      _tree: {
        root: { children: { children: { style: { color: string } }[] }[] };
      };
    }
  )._tree;
  const colors: string[] = [];
  const walk = (b: {
    style?: { color: string };
    children?: unknown[];
  }): void => {
    if (b.style && (b as { el?: { name: string } }).el?.name === 'p') {
      colors.push(b.style.color);
    }
    for (const c of (b.children ?? []) as (typeof b)[]) walk(c);
  };
  walk(tree.root as never);
  // each paragraph's box and its text's, the new one's among them
  assert.deepStrictEqual(colors, ['#0b0b0b', '#0b0b0b', '#0b0b0b', '#0b0b0b']);
  // a change to the sheet is a new cascade
  await act(() =>
    result.rerender(
      doc('<style>p { color: #0c0c0c }</style><p>one</p><p>two</p>'),
    ),
  );
  el().textContent();
  assert.notStrictEqual(cascadeOf(), before);
});

test('a cascade made again takes the sheets it parsed, and parses again one whose layers rank otherwise', async () => {
  // GitHub's scripts put in three sheets as its repository page loads, and
  // each made the cascade again from all 3.7 MB of its CSS, parsed again
  const layered =
    '<style>@layer base { p { color: #010101 } } ' +
    '@layer top { p { color: #020202 } }</style>';
  const plain = '<style>p.x { color: #030303 }</style>';
  const body = '<p id="x" class="x">x</p><p id="y">y</p>';
  const doc = (source: string) =>
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source, 'data-testname': 'doc' }),
    );
  const result = await renderX11(doc(layered + plain + body), {
    backend: 'mock',
  });
  const el = () => view(screen.getByTestName('doc') as DrawnNode);
  type Parsed = Map<string, { sheet: object }[]>;
  const parsed = () => (el() as unknown as { _parsed: Parsed })._parsed;
  const cascadeOf = () => (el() as unknown as { _cascade: unknown })._cascade;
  const color = (id: string): string => {
    el().textContent();
    return (boxOf(el(), id) as LaidBox & { style: { color: string } }).style
      .color;
  };
  assert.strictEqual(color('x'), '#030303');
  assert.strictEqual(color('y'), '#020202');
  const sheetOf = (text: string) => {
    const kept = parsed().get(text);
    assert.strictEqual(kept?.length, 1, `one sheet kept for ${text}`);
    return kept[0].sheet;
  };
  const textOf = (style: string) => style.slice(7, -8);
  const first = cascadeOf();
  const layeredSheet = sheetOf(textOf(layered));
  const plainSheet = sheetOf(textOf(plain));

  // a sheet more, after them: a new cascade, made of the same two
  const after = '<style>p { margin: 1px }</style>';
  await act(() => result.rerender(doc(layered + plain + after + body)));
  assert.strictEqual(color('y'), '#020202');
  assert.notStrictEqual(cascadeOf(), first, 'a new cascade');
  assert.strictEqual(sheetOf(textOf(layered)), layeredSheet);
  assert.strictEqual(sheetOf(textOf(plain)), plainSheet);

  // the same sheet twice: two parses, since a rule's order is its place
  await act(() => result.rerender(doc(layered + plain + after + plain + body)));
  assert.strictEqual(parsed().get(textOf(plain))?.length, 2);
  assert.strictEqual(color('x'), '#030303');

  // one before them that ranks the layers the other way round: the layered
  // sheet is parsed again, under the new ranks, and the plain one is not
  const order = '<style>@layer top, base;</style>';
  await act(() => result.rerender(doc(order + layered + plain + body)));
  assert.strictEqual(color('y'), '#010101', 'base ranks over top');
  assert.strictEqual(color('x'), '#030303');
  assert.notStrictEqual(sheetOf(textOf(layered)), layeredSheet);
  assert.strictEqual(sheetOf(textOf(plain)), plainSheet);
  // and back: the ranks the first parse had are not the ones now kept
  await act(() => result.rerender(doc(layered + plain + body)));
  assert.strictEqual(color('y'), '#020202');
});

test(":target is the element the fragment of the document's URL names, and moves with it", async () => {
  const source =
    '<style>p { color: #000000 } :target { color: #00ff00 } ' +
    'section:not(:target) b { color: #0000ff }</style>' +
    '<p id="a">a</p><p><a id="n" name="b">b</a></p>' +
    '<p id="caf\u00e9">c</p><section id="s"><b id="x">x</b></section>' +
    '<img src="i.png" alt="i">';
  const asked: string[] = [];
  const doc = (baseUrl: string | null) =>
    h(
      'box',
      { style: { width: 300 } },
      h(Html, {
        source,
        baseUrl,
        onResource: (request: { url: string }) => {
          asked.push(request.url);
          return null;
        },
        'data-testname': 'doc',
      }),
    );
  const result = await renderX11(doc('https://x.test/page'), {
    backend: 'mock',
  });
  const el = () => view(screen.getByTestName('doc') as DrawnNode);
  const color = (id: string): string => {
    el().textContent();
    return (boxOf(el(), id) as LaidBox & { style: { color: string } }).style
      .color;
  };
  const green = (): string[] =>
    ['a', 'n', 'caf\u00e9', 's'].filter((id) => color(id) === '#00ff00');
  assert.deepStrictEqual(green(), []);
  assert.strictEqual(color('x'), '#0000ff');
  const cascade = (el() as unknown as { _cascade: unknown })._cascade;
  const resources = asked.length;
  // a link the host follows to `#a`: the same document at another fragment
  await act(() => result.rerender(doc('https://x.test/page#a')));
  assert.deepStrictEqual(green(), ['a']);
  // which resolves nothing differently: the same cascade, nothing asked
  assert.strictEqual(
    (el() as unknown as { _cascade: unknown })._cascade,
    cascade,
  );
  assert.strictEqual(asked.length, resources);
  // an id first, and then the `<a>` the fragment is the name of
  await act(() => result.rerender(doc('https://x.test/page#b')));
  assert.deepStrictEqual(green(), ['n']);
  // percent-decoded where it names nothing as written
  await act(() => result.rerender(doc('https://x.test/page#caf%C3%A9')));
  assert.deepStrictEqual(green(), ['caf\u00e9']);
  await act(() => result.rerender(doc('https://x.test/page#s')));
  assert.deepStrictEqual(green(), ['s']);
  assert.notStrictEqual(color('x'), '#0000ff');
  // and a fragment of a document with no URL of its own
  await act(() => result.rerender(doc('#a')));
  assert.deepStrictEqual(green(), ['a']);
  await act(() => result.rerender(doc(null)));
  assert.deepStrictEqual(green(), []);
});

test("a :has() answers the tree as it is now, after a stream's next chunk and after refresh()", async () => {
  // css-select keeps what a :has() answered for an element for as long as
  // the matcher lives, and a tree that changed under the same sheets keeps
  // the cascade and its matchers: the image the next chunk brought in, and
  // the one an application took out, were not seen
  const sheet =
    '<style>div:has(img) { color: #00ff00 } ' +
    'section:has(b) p { color: #0000ff }</style>';
  const doc = (source: string) =>
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source, partial: true, 'data-testname': 'doc' }),
    );
  const head = sheet + '<div id="d"><span>x</span>';
  const result = await renderX11(doc(head), { backend: 'mock' });
  const el = () => view(screen.getByTestName('doc') as DrawnNode);
  const color = (id: string): string => {
    el().textContent();
    return (boxOf(el(), id) as LaidBox & { style: { color: string } }).style
      .color;
  };
  const cascade = (el() as unknown as { _cascade: unknown })._cascade;
  assert.notStrictEqual(color('d'), '#00ff00');
  const more = head + '<img alt="i"></div><section><p id="p">t</p>';
  await act(() => result.rerender(doc(more)));
  assert.strictEqual(color('d'), '#00ff00', 'the image the chunk brought');
  // a descendant combinator under one kept what it found above `p` too
  assert.notStrictEqual(color('p'), '#0000ff');
  await act(() => result.rerender(doc(more + '<b>b</b></section>')));
  assert.strictEqual(color('p'), '#0000ff', 'the <b> after it');
  assert.strictEqual(
    (el() as unknown as { _cascade: unknown })._cascade,
    cascade,
    'all under the one cascade',
  );
  // an application's change, and the refresh it asks for
  const d = boxOf(el(), 'd').el as unknown as Element;
  const img = d.children.find((n) => (n as Element).name === 'img')!;
  removeNode(img);
  el().touchDocument();
  await act();
  assert.notStrictEqual(color('d'), '#00ff00', 'the image taken out');
});

test('a :has() answers the fragment as it is now, as :target itself does: Chrome’s answers', async () => {
  // the element a fragment names is in no tree, and a `:has()`'s answer was
  // dropped only when a tree changed, so `d` kept what it first answered
  // through every fragment after it. Each step is what Chrome 151, Firefox
  // 153 and WebKit 26.5 draw
  const source =
    '<style>div:has(:target) { color: #00ff00 } ' +
    'section:has(:target) p { color: #0000ff } ' +
    '.before:has(+ :target) { color: #ff0000 } ' +
    '.within:has(+ :is(:target)) { color: #ff00ff }</style>' +
    '<div id="d"><span id="a">a</span></div>' +
    '<section id="s"><b id="b">b</b><p id="p">p</p></section>' +
    '<i class="before" id="i">x</i><u id="u">y</u>' +
    '<i class="within" id="j">x</i><u id="v">y</u>';
  const doc = (baseUrl: string | null) =>
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source, baseUrl, 'data-testname': 'doc' }),
    );
  const at = (hash: string) => `https://x.test/page${hash}`;
  const result = await renderX11(doc(at('')), { backend: 'mock' });
  const el = () => view(screen.getByTestName('doc') as DrawnNode);
  const color = (id: string): string => {
    el().textContent();
    return (boxOf(el(), id) as LaidBox & { style: { color: string } }).style
      .color;
  };
  const lit = (): string[] => {
    const on: string[] = [];
    if (color('d') === '#00ff00') on.push('d');
    if (color('p') === '#0000ff') on.push('p');
    if (color('i') === '#ff0000') on.push('i');
    if (color('j') === '#ff00ff') on.push('j');
    return on;
  };
  const cascade = (el() as unknown as { _cascade: unknown })._cascade;
  assert.deepStrictEqual(lit(), []);
  for (const [hash, expected] of [
    ['#a', ['d']],
    ['#zz', []],
    ['#b', ['p']],
    ['#a', ['d']],
    ['#u', ['i']],
    ['#v', ['j']],
    ['', []],
  ] as const) {
    await act(() => result.rerender(doc(at(hash))));
    assert.deepStrictEqual(lit(), expected, hash);
  }
  assert.strictEqual(
    (el() as unknown as { _cascade: unknown })._cascade,
    cascade,
    'all under the one cascade',
  );
});

test('a :has() a first render answered at a fragment lets it go at the next', async () => {
  const source =
    '<style>div:has(:target) { color: #00ff00 }</style>' +
    '<div id="d"><span id="a">a</span></div><span id="b">b</span>';
  const doc = (baseUrl: string) =>
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source, baseUrl, 'data-testname': 'doc' }),
    );
  const result = await renderX11(doc('https://x.test/page#a'), {
    backend: 'mock',
  });
  const el = () => view(screen.getByTestName('doc') as DrawnNode);
  const color = (id: string): string => {
    el().textContent();
    return (boxOf(el(), id) as LaidBox & { style: { color: string } }).style
      .color;
  };
  assert.strictEqual(color('d'), '#00ff00');
  await act(() => result.rerender(doc('https://x.test/page#b')));
  assert.notStrictEqual(color('d'), '#00ff00');
});

test('a rule at a shadow tree’s edge, and :target in any case, follow the fragment: Chrome’s answers', async () => {
  // a fragment restyles only where a rule tests `:target`, and what said so
  // saw neither the rules a tree's edge files outside the indexes nor a
  // name that was not in lower case, so these kept the fragment they were
  // first styled at
  const source =
    '<style>x-p:target::part(p) { color: #0000ff } ' +
    'x-q:has(:target)::part(p) { color: #0000ff } ' +
    'div:has(:TARGET) { color: #00ff00 } u:Target { color: #ff0000 }</style>' +
    '<x-h id="h"><template shadowrootmode="open"><style>' +
    ':host(:target) { color: #ff0000 } ' +
    ':host(:target) .y { color: #00ff00 }</style>' +
    '<i id="hy" class="y">y</i></template></x-h>' +
    '<x-s id="s"><template shadowrootmode="open"><style>' +
    '::slotted(:target) { color: #ff0000 }</style><slot></slot></template>' +
    '<b id="sb">b</b></x-s>' +
    '<x-p id="p"><template shadowrootmode="open">' +
    '<i id="pp" part="p">p</i></template></x-p>' +
    '<x-q id="q"><template shadowrootmode="open"><i id="qp" part="p">p</i>' +
    '<slot></slot></template><b id="qb">b</b></x-q>' +
    '<div id="d"><u id="k">k</u></div><i id="o">o</i>';
  const doc = (baseUrl: string) =>
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source, baseUrl, 'data-testname': 'doc' }),
    );
  const at = (hash: string) => `https://x.test/page${hash}`;
  const result = await renderX11(doc(at('')), { backend: 'mock' });
  const el = () => view(screen.getByTestName('doc') as DrawnNode);
  const WANTS: Record<string, string> = {
    h: '#ff0000',
    hy: '#00ff00',
    sb: '#ff0000',
    pp: '#0000ff',
    qp: '#0000ff',
    d: '#00ff00',
    k: '#ff0000',
  };
  const lit = (): string[] => {
    el().textContent();
    return Object.keys(WANTS).filter(
      (id) =>
        (boxOf(el(), id) as LaidBox & { style: { color: string } }).style
          .color === WANTS[id],
    );
  };
  assert.deepStrictEqual(lit(), []);
  for (const [hash, expected] of [
    ['#h', ['h', 'hy']],
    ['#sb', ['sb']],
    ['#p', ['pp']],
    ['#qb', ['qp']],
    ['#k', ['d', 'k']],
    ['#o', []],
    ['#h', ['h', 'hy']],
    ['', []],
  ] as const) {
    await act(() => result.rerender(doc(at(hash))));
    assert.deepStrictEqual(lit(), expected, hash);
  }
});

test('a function with a combinator in it answers the tree as it is now, wherever a descendant combinator follows it: Chrome’s answers', async () => {
  // css-select rates `:is(.x .a)` as it rates a `:has()`, and a descendant
  // combinator after one keeps what it found above an element for as long
  // as the matcher lives. No `:has()` in the selector said so, and the
  // cascade, with its matchers, outlives a change under the same sheets, so
  // the first answer stood. `>` keeps nothing, and always answered.
  const rows: [string, boolean, boolean][] = [
    [':is(.x .a) .t0', false, true],
    [':where(.x .a) .t1', false, true],
    [':is(.q, .x > .a) .t2', false, true],
    [':is(.x .a) i .t3', false, true],
    ['.a:not(.x .a) .t4', true, false],
    [':not(.x .a) > .t5', true, false],
  ];
  const source =
    `<style>${rows
      .map(([selector]) => `${selector} { color: ${HAS_MATCHED} }`)
      .join(' ')}</style><div id="o"><div class="a">` +
    '<b id="t0" class="t0">0</b><b id="t1" class="t1">1</b>' +
    '<b id="t2" class="t2">2</b><i><b id="t3" class="t3">3</b></i>' +
    '<b id="t4" class="t4">4</b><b id="t5" class="t5">5</b></div></div>';
  await renderX11(
    h(
      'box',
      { style: { width: 300 } },
      h(Html, { source, 'data-testname': 'doc' }),
    ),
    { backend: 'mock' },
  );
  const el = view(screen.getByTestName('doc') as DrawnNode);
  const element = (id: string) => boxOf(el, id).el as unknown as Element;
  const answers = () =>
    rows.map(
      (_, i) => el.computedStyle(element(`t${i}`))?.color === HAS_MATCHED,
    );
  const o = element('o');
  assert.deepStrictEqual(
    answers(),
    rows.map(([, before]) => before),
    'as it was first styled',
  );
  o.attribs.class = 'x';
  el.touchDocument([
    { type: 'attributes', target: o, attributeName: 'class', oldValue: null },
  ]);
  await act();
  assert.deepStrictEqual(
    answers(),
    rows.map(([, , after]) => after),
    'a refresh told of the class',
  );
  delete o.attribs.class;
  el.touchDocument();
  await act();
  assert.deepStrictEqual(
    answers(),
    rows.map(([, before]) => before),
    'a refresh of everything, with the class taken off',
  );
});

test('what a :has() holds is matched as the document’s, wherever its argument starts: Chrome’s answers', async () => {
  // css-select read an `:is()`, a `:where()` or a `:not()` in an argument
  // with a combinator as relative to the `:has()`'s element, so a sibling
  // was never in one, and what such a selector reads above the element was
  // never found; and it took the element for what an entry with a combinator
  // in it starts at, which is inside it
  const { node } = await render(hasArgumentsDocument());
  const el = view(node);
  const colour = (id: string) => el.computedStyle(findById(el.document, id)!);
  HAS_ARGUMENTS.forEach(([selector], i) => {
    assert.strictEqual(colour(`y${i}t`)?.color, HAS_MATCHED, selector);
    assert.notStrictEqual(colour(`n${i}t`)?.color, HAS_MATCHED, selector);
  });
});

test('a sheet that writes the name a :has()’s function is compiled under matches nothing by it', async () => {
  const { node } = await render(
    `<style>.p:has(+ :not(.b)):-rx-hoisted(99) { color: ${HAS_MATCHED} }</style>` +
      '<div class="p" id="t">p</div><div>next</div>',
  );
  const el = view(node);
  assert.notStrictEqual(
    el.computedStyle(findById(el.document, 't')!)?.color,
    HAS_MATCHED,
  );
});

test('two elements alike are styled by what each :has() finds after it, and share no style', async () => {
  const { node } = await render(
    `<style>.p:has(+ .a:not(.b)) { color: ${HAS_MATCHED} }</style><section>` +
      '<p class="p" id="one">1</p><p class="a">a</p>' +
      '<p class="p" id="two">2</p><p class="a b">b</p></section>',
  );
  const el = view(node);
  const colour = (id: string) =>
    el.computedStyle(findById(el.document, id)!)?.color;
  assert.strictEqual(colour('one'), HAS_MATCHED);
  assert.notStrictEqual(colour('two'), HAS_MATCHED);
});

test('a pseudo-element no rule gives a content to is none, whatever reaches it', async () => {
  // Tailwind's `*, ::before, ::after` reaches both of every element's
  const count = async (css: string) => {
    const { node } = await render(
      `<style>${css}</style><p>a</p><p class="x">b</p>`,
    );
    let n = 0;
    const walk = (b: { children?: unknown[] }): void => {
      n += 1;
      for (const c of (b.children ?? []) as (typeof b)[]) walk(c);
    };
    walk((view(node) as unknown as { _tree: { root: object } })._tree.root);
    return n;
  };
  const bare = await count('');
  assert.strictEqual(
    await count('*, ::before, ::after { box-sizing: border-box; --x: 1 }'),
    bare,
  );
  assert.strictEqual(
    await count('.x::before { content: var(--label, "*") }'),
    bare + 2,
    'a ::before box and its text',
  );
});

test('an element of white space is not :empty, and a class name is split at ASCII white space alone', async () => {
  // css-select 7 takes white space for empty, the Selectors 4 draft's
  // reading, which no engine ships; and an em space is part of a class
  // name, which the index split it at (Acid3's tests 38 and 33)
  const { node } = await render(
    '<style>p{margin:0;height:5px}p:empty{height:20px}' +
      '.f\\2003g{height:30px}.a.f\\2003g{height:40px}</style>' +
      '<p id="none"></p><p id="comment"><!-- c --></p><p id="space"> </p>' +
      '<p id="em" class="f\u2003g">x</p><p id="both" class="a f\u2003g">x</p>' +
      '<p id="split" class="a f g">x</p>',
  );
  const el = view(node);
  const height = (id: string): number => boxOf(el, id).height;
  assert.deepStrictEqual(
    ['none', 'comment', 'space'].map(height),
    [20, 20, 5],
    'only no children but comments is empty',
  );
  assert.strictEqual(height('em'), 30, 'the name with an em space in it');
  // a compound goes to css-select, which refuses a `~=` word with `\s`
  // in it, an em space included
  assert.strictEqual(height('both'), 40, 'and with another class beside it');
  assert.strictEqual(height('split'), 5, 'and not two names split at it');
});

test('`:focus` matches no element, and a rule that names it stays in the cascade', async () => {
  // css-select has no `:focus`, and threw on one: every rule naming it was
  // dropped, `:not(:focus)` among them, and Wikipedia's skip link stood in
  // the flow at the top of every page
  const { node } = await render(
    '<style>body,p{margin:0}' +
      '.skip:not(:focus){position:absolute;width:1px;height:1px;' +
      'overflow:hidden}' +
      'a:focus,p:focus-within,p:focus-visible{margin-left:50px}</style>' +
      '<a id="skip" class="skip" href="#p">Jump to content</a>' +
      '<p id="p"><a id="a" href="#">text</a></p>',
  );
  const el = view(node);
  const skip = boxOf(el, 'skip');
  assert.deepStrictEqual([skip.width, skip.height], [1, 1]);
  assert.strictEqual(boxOf(el, 'p').y, 0, 'and takes no room in the flow');
  assert.strictEqual(boxOf(el, 'p').x, 0, 'nothing is focused');
});

test('a @supports test of the mask is answered, and every other is entered', () => {
  // A page keeps a background image under `not` for an engine without
  // masks. Entered as every `@supports` block was, Wikipedia's chevron was
  // that image in black under its mask, over its blue
  assert.strictEqual(
    supportsCondition('not ((-webkit-mask-image:none) or (mask-image:none))'),
    false,
  );
  assert.strictEqual(supportsCondition('(mask-image: none)'), true);
  assert.strictEqual(
    supportsCondition('(mask-image: none) and (-webkit-mask-size: 1px)'),
    true,
  );
  // what it cannot answer it does not: Tailwind 4 keeps its variables'
  // starting values under a test for engines without `@property`
  for (const unknown of [
    '(display: grid)',
    'not (display: grid)',
    'selector(:focus-visible)',
    '(mask-image: none) and (display: grid)',
    '((-webkit-hyphens: none) and (not (margin-trim: inline))) or ' +
      '((-moz-orient: inline) and (not (color:rgb(from red r g b))))',
  ]) {
    assert.strictEqual(supportsCondition(unknown), null, unknown);
  }
  const sheet = parseStylesheet(
    '@supports not (mask-image: none) { .a { color: red } }' +
      '@supports (mask-image: none) { .b { color: red } }' +
      '@supports (display: grid) { .c { color: red } }' +
      '.d { @supports not (mask: none) { color: red } }',
  );
  assert.deepStrictEqual(
    sheet.rules.map((r) => r.selector),
    ['.b', '.c'],
  );
});

test('a @supports test of subgrid is answered', () => {
  // Primer keeps `grid-template-rows: auto` under `not` for an engine
  // without subgrids; entered, it undid the subgrid of every pricing card
  for (const axis of ['rows', 'columns']) {
    assert.strictEqual(
      supportsCondition(`(grid-template-${axis}: subgrid)`),
      true,
    );
    assert.strictEqual(
      supportsCondition(`not (grid-template-${axis}:subgrid [a] [b])`),
      false,
    );
  }
  // and a template it does not name is entered as before
  assert.strictEqual(supportsCondition('(grid-template-rows: masonry)'), null);
});

test('the names that would style an element are the ones some rule would match it with', async () => {
  const { node } = await render(
    '<style>' +
      '.card { color: red } .card.wide { width: 10px }' +
      '.nav .link { color: blue } .menu > .item { color: green }' +
      'li.only-li { color: red } p.on-p { color: red }' +
      '.hover\\:bold:hover { font-weight: bold }' +
      '@media (max-width: 10px) { .tiny { color: red } }' +
      '.box:not(.skipped) { color: red }' +
      '#main { color: red } div#side { color: red } #other p { color: red }' +
      '</style>' +
      '<div class="nav"><p id="t" class="card">text</p></div>',
  );
  const el = view(node);
  const p = findById(el.document, 't')!;
  // a class its own rule asks for alone; one that needs another it has; one
  // whose ancestor it has; one asked only of another tag, or under another
  // parent, or in media that do not hold, is not
  assert.deepStrictEqual(el.namesThatStyle(p, 'class'), [
    'box',
    'hover:bold',
    'link',
    'on-p',
    'wide',
  ]);
  // what it has is not offered again, and nothing about it changed
  assert.strictEqual(p.attribs.class, 'card');
  // an id is in place of its own: one a rule asks of a `<p>`, not a `<div>`
  assert.deepStrictEqual(el.namesThatStyle(p, 'id'), ['main']);
  // the element styles as it did
  assert.strictEqual(el.computedStyle(p)?.color, 'rgb(255, 0, 0)');
});

test('the rules that match an element are listed in the order they win, with their declarations as written', async () => {
  const { node } = await render(
    '<style>' +
      'p { color: blue; margin: 0 }' +
      '#t { color: green }' +
      '.a { color: red !important }' +
      '.b { padding: 2px } .a { padding: 3px }' +
      '@media (min-width: 100px) { .a { font-weight: bold } }' +
      '@media (max-width: 10px) { .a { font-style: italic } }' +
      '.nope { color: black }' +
      '</style>' +
      '<p id="t" class="a b" style="border: 1px solid" align="center">x</p>',
  );
  const el = view(node);
  const p = findById(el.document, 't')!;
  const rules = el.matchedRules(p);
  const shown = rules.map((r) => r.selector ?? r.origin);
  // its own style first; then the author's, the most specific first and, of
  // two alike, the later; the hints; the user agent's last. A rule that
  // does not match, or whose media do not hold, is not there.
  assert.deepStrictEqual(shown.slice(0, 6), [
    'inline',
    '#t',
    '.a',
    '.a',
    '.b',
    '.a',
  ]);
  // of the three `.a`, the one in media came last in the sheet, so first
  assert.strictEqual(rules[2].media, '(min-width: 100px)');
  assert.ok(!shown.includes('.nope'));
  assert.ok(shown.indexOf('p') > shown.indexOf('.b'));
  assert.ok(shown.indexOf('presentation') > shown.indexOf('p'));
  assert.strictEqual(rules[rules.length - 1].origin, 'user-agent');
  assert.deepStrictEqual(rules[0].declarations, [
    { property: 'border', value: '1px solid', important: false },
  ]);
  const media = rules.find((r) => r.media !== null)!;
  assert.strictEqual(media.media, '(min-width: 100px)');
  assert.deepStrictEqual(media.declarations, [
    { property: 'font-weight', value: 'bold', important: false },
  ]);
  const important = rules.find((r) => r.declarations.some((d) => d.important))!;
  assert.strictEqual(important.selector, '.a');
  assert.deepStrictEqual(important.specificity, [0, 1, 0]);
  assert.deepStrictEqual(rules[1].specificity, [1, 0, 0]);
});

test('a rule says where in its sheet it was written, comments and all', () => {
  const text = [
    '/* a { first } */',
    '.a { color: red }',
    '',
    '/* between, with a { brace } */',
    '.b,',
    '  .c /* in a list */ ,',
    '  .d:is(.e, .f) { color: red }',
    '@media (min-width: 1px) {',
    '  /* in a block */',
    '  .g { color: red }',
    '  @supports (display: grid) {',
    '    .h { color: red }',
    '  }',
    '}',
    '@layer one { .i { color: red } }',
    '@container (min-width: 1px) { .j { color: red } }',
    '.k {',
    '  color: red; /* before what is nested */',
    '  .l & { color: red }',
    '  &:hover,',
    '  &:focus { color: red }',
    '  @media (min-width: 1px) { color: blue }',
    '}',
    '.m { color: red } /* unterminated',
  ].join('\n');
  const sheet = parseStylesheet(text);
  const at = (needle: string, from = 0): number => {
    const found = text.indexOf(needle, from);
    assert.ok(found >= 0, needle);
    return found;
  };
  // the first of a selector's rules: `.k` has a second, for its `@media`
  const seen = new Map(
    [...sheet.rules].reverse().map((r) => [r.selector, r.at]),
  );
  for (const selector of ['.a', '.b', '.c', '.g', '.h', '.i', '.j', '.k']) {
    assert.strictEqual(seen.get(selector), at(`${selector}`, 18), selector);
  }
  assert.strictEqual(seen.get('.d:is(.e, .f)'), at('.d:is'));
  assert.strictEqual(seen.get('.l :is(.k)'), at('.l &'));
  // a list of nested selectors, and declarations under a nested `@media`,
  // are where their block is
  assert.strictEqual(seen.get('.k:hover'), at('&:hover'));
  assert.strictEqual(seen.get('.k:focus'), at('&:hover'));
  assert.strictEqual(
    sheet.rules.filter((r) => r.selector === '.k').pop()!.at,
    at('@media (min-width: 1px) { color'),
  );
  // the last one is after a comment the end of the sheet closes
  assert.strictEqual(seen.get('.m'), at('.m'));
});

test('a matched rule points at where it came from, an import among them', async () => {
  const main = 'body { margin: 0 }\n\n#t {\n  color: red;\n}\n';
  const imported = '@import "deep.css";\n/* a comment\n*/\n.a { color: red }\n';
  const deep = '.b { color: red }';
  const sheets: Record<string, string> = {
    'http://x/main.css': main,
    'http://x/imported.css': imported,
    'http://x/deep.css': deep,
  };
  const { node } = await render(
    '<link rel="stylesheet" href="main.css">' +
      '<style>\n  @import "imported.css";\n  .c { color: red }\n</style>' +
      '<p id="t" class="a b c">x</p>',
    400,
    {
      baseUrl: 'http://x/page.html',
      onResource: (r: { url: string; kind: string }) =>
        r.kind === 'stylesheet' && sheets[r.url]
          ? { kind: 'stylesheet' as const, text: sheets[r.url] }
          : null,
    },
  );
  const el = view(node);
  const p = findById(el.document, 't')!;
  const by = (selector: string) =>
    el.matchedRules(p).find((r) => r.selector === selector)!.source!;

  const t = by('#t');
  assert.strictEqual(t.sheet.url, 'http://x/main.css');
  assert.strictEqual(t.sheet.text, main);
  assert.strictEqual(t.offset, main.indexOf('#t'));
  assert.deepStrictEqual([t.line, t.column], [3, 1]);

  const a = by('.a');
  assert.strictEqual(a.sheet.url, 'http://x/imported.css');
  assert.strictEqual(a.sheet.element, null);
  assert.deepStrictEqual([a.line, a.column], [4, 1]);

  const b = by('.b');
  assert.strictEqual(b.sheet.url, 'http://x/deep.css');

  const c = by('.c');
  assert.strictEqual(c.sheet.url, null);
  assert.strictEqual(c.sheet.element?.name, 'style');
  assert.deepStrictEqual([c.line, c.column], [3, 3]);

  // what the document lists is what a rule names, imports before their
  // importers; the user agent's has no place, and neither has a hint
  const listed = el.styleSheets();
  assert.deepStrictEqual(
    listed.map((s) => s.url),
    ['http://x/main.css', 'http://x/deep.css', 'http://x/imported.css', null],
  );
  for (const sheet of [t.sheet, a.sheet, b.sheet, c.sheet]) {
    assert.ok(listed.includes(sheet));
  }
  const ua = el.matchedRules(p).filter((r) => r.origin === 'user-agent');
  assert.ok(ua.length > 0);
  assert.ok(ua.every((r) => r.source === null));
});
