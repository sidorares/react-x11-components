// <Formula> — the layout engine is tested directly (it is pure, and every
// subtle mathematics bug lives there), the widget through the harness:
// mock backend for structure and the text accessors, the in-process X
// server for real metrics and the document selection.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';

import { renderX11, cleanup, screen, fireEvent, act } from 'react-x11/test';
import type { RenderX11Options } from 'react-x11/test';
import { drawnKinds, registeredElements } from 'react-x11/host';
import type { DrawnNode } from 'react-x11';

import { Formula, FormulaNode, Markdown } from '../src/index.js';
import { layoutFormula } from '../src/formula/index.js';
import { loadKatex } from '../src/formula/katex.js';
import type { KatexEngine } from '../src/formula/katex.js';

const h = React.createElement;

afterEach(cleanup);

// katex is an optionalDependency of this package and a regular dependency
// of ntk, so it is present in this repo's checkout; the guard keeps the
// suite honest on a tree that pruned optionals.
let engine: KatexEngine | null = null;
try {
  engine = await loadKatex();
} catch {
  engine = null;
}

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

function tree(tex: string, displayMode = false) {
  return engine!.katex.__renderToDomTree(tex, {
    displayMode,
    output: 'html',
  });
}

/** The component's engine load resolves a tick after mount. */
async function flushEngine(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act();
}

function formulaNodes(): FormulaNode[] {
  return screen
    .all((n) => n instanceof FormulaNode)
    .map((n) => n as unknown as FormulaNode);
}

// --- the layout engine, headless -------------------------------------------

test(
  'a fraction reads numerator first and draws its bar',
  {
    skip: !engine,
  },
  () => {
    const lay = layoutFormula(tree('\\frac{a+b}{2}'), {
      em: 20,
      color: 'black',
      shaper: null,
    });
    assert.equal(lay.text, 'a+b2');
    assert.equal(lay.rules.length, 1);
    const bar = lay.rules[0];
    const numerator = lay.glyphs[0];
    const denominator = lay.glyphs[3];
    assert.ok(
      numerator.baseline < bar.y && bar.y < denominator.baseline,
      'the bar sits between the two baselines',
    );
    assert.ok(bar.width > 0, 'the bar stretched to the stack width');
    // the numerator is centered over the wider... the denominator is the
    // narrow one here, so it starts right of the numerator
    assert.ok(denominator.x > numerator.x, 'the narrow row is centered');
  },
);

test(
  'scripts read superscript first and sit off the baseline',
  {
    skip: !engine,
  },
  () => {
    const lay = layoutFormula(tree('x^2_1'), {
      em: 20,
      color: 'black',
      shaper: null,
    });
    assert.equal(lay.text, 'x21');
    const [base, sup, sub] = lay.glyphs;
    assert.ok(sup.baseline < base.baseline, 'superscript is above');
    assert.ok(sub.baseline > base.baseline, 'subscript is below');
    assert.ok(sup.size < base.size, 'scripts are smaller');
  },
);

test(
  'a matrix reads column-wise top-down; a root draws a surd path',
  {
    skip: !engine,
  },
  () => {
    const matrix = layoutFormula(
      tree('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', true),
      { em: 18, color: 'black', shaper: null },
    );
    assert.equal(matrix.text, '(acbd)');
    const root = layoutFormula(tree('\\sqrt{y}'), {
      em: 18,
      color: 'black',
      shaper: null,
    });
    assert.ok(root.paths.length >= 1, 'the surd is an svg path');
    assert.ok(root.paths[0].segs.length > 2, 'the path parsed into segments');
  },
);

test(
  '\\color reaches the glyphs it wraps and no others',
  {
    skip: !engine,
  },
  () => {
    const lay = layoutFormula(tree('x + {\\color{red} y}'), {
      em: 16,
      color: 'black',
      shaper: null,
    });
    const byText = new Map(lay.glyphs.map((g) => [g.text, g.color]));
    assert.equal(byText.get('x'), 'black');
    assert.equal(byText.get('y'), 'red');
  },
);

// --- the element, on the mock backend --------------------------------------

test(
  'the element registers, joins the paint order, and measures',
  {
    skip: !engine,
  },
  async () => {
    await renderX11(
      h(Formula, { tex: '\\frac{a+b}{2}', 'data-testname': 'f' }),
      { backend: 'mock' },
    );
    await flushEngine();
    assert.ok(registeredElements().includes('formula'));
    assert.ok(
      drawnKinds().includes('formula'),
      'formula must join the paint order',
    );
    const [node] = formulaNodes();
    assert.ok(node, 'the engine resolved and the element mounted');
    // no fonts on the mock backend — geometry comes from KaTeX's metrics
    assert.ok(node.abs.width > 0 && node.abs.height > 0);
  },
);

test(
  'the four text accessors answer over the glyphs',
  {
    skip: !engine,
  },
  async () => {
    await renderX11(h(Formula, { tex: 'x^2 + 1' }), { backend: 'mock' });
    await flushEngine();
    const [node] = formulaNodes();
    assert.equal(node.textContent(), 'x2+1');
    const caret = node.textCaretRect(0);
    assert.ok(caret && caret.height > 0);
    const rects = node.textRangeRects(0, 4);
    assert.ok(rects.length >= 1);
    const total = rects.reduce((w, r) => w + r.width, 0);
    assert.ok(total > 0, 'a full-range selection covers ink');
    // hit-testing round-trips: the point the caret names finds the index
    const mid = node.textIndexAt(caret!.x + 1, caret!.y + caret!.height / 2);
    assert.ok(mid <= 1, `caret x resolves to the first glyph, got ${mid}`);
  },
);

test(
  'while partial, the last good parse stands in for a torn tail',
  {
    skip: !engine,
  },
  async () => {
    const r = await renderX11(
      h(Formula, { tex: '\\frac{a}{2}', partial: true }),
      { backend: 'mock' },
    );
    await flushEngine();
    assert.equal(formulaNodes()[0]?.textContent(), 'a2');
    // the stream appends an unparseable tail: the old tree keeps rendering
    await act(() => {
      r.rerender(h(Formula, { tex: '\\frac{a}{2} + \\frac{b', partial: true }));
    });
    assert.equal(formulaNodes()[0]?.textContent(), 'a2');
    // ...and takes over the moment the tail closes
    await act(() => {
      r.rerender(
        h(Formula, { tex: '\\frac{a}{2} + \\frac{b}{3}', partial: true }),
      );
    });
    assert.equal(formulaNodes()[0]?.textContent(), 'a2+b3');
  },
);

test(
  'a markdown ```math fence renders through the seam',
  {
    skip: !engine,
  },
  async () => {
    const fences = {
      math: ({ text, partial }: { text: string; partial: boolean }) =>
        h(Formula, { tex: text, display: true, partial }),
    };
    const source = 'before\n\n```math\nx^2\n```\n\nafter';
    await renderX11(h(Markdown, { source, partial: false, fences }), {
      backend: 'mock',
    });
    await flushEngine();
    const [node] = formulaNodes();
    assert.ok(node, 'the fence rendered a formula');
    assert.equal(node.textContent(), 'x2');
  },
);

// --- with real metrics: shaping, selection ---------------------------------

test(
  'KaTeX faces register and shape; the document selection reads the math',
  {
    skip: !engine || !FONTS || !engine.fonts,
  },
  async () => {
    const fences = {
      math: ({ text, partial }: { text: string; partial: boolean }) =>
        h(Formula, { tex: text, display: true, partial }),
    };
    const source = 'above\n\n```math\nx = \\sqrt{2}\n```\n\nbelow';
    await renderX11(
      h(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        h(Markdown, { source, fences }),
      ),
      { fonts: FONTS!, width: 420, height: 300 },
    );
    await flushEngine();
    const [node] = formulaNodes();
    assert.ok(node.abs.width > 0);

    // focus the document and take everything
    const surface = screen.all(
      (n) =>
        (n as { props?: { selectable?: boolean } }).props?.selectable === true,
    )[0] as unknown as DrawnNode;
    await act(async () => {
      fireEvent.mouseDown(surface, {});
      fireEvent.mouseUp(surface, {});
    });
    await act(async () => {
      fireEvent.key(0x61 /* a */, { modifiers: ['Control'] });
    });
    const selected = surface.selectedText();
    assert.ok(
      selected.includes('x') &&
        selected.includes('2') &&
        selected.includes('='),
      `the formula's glyphs join the copy, got ${JSON.stringify(selected)}`,
    );
  },
);

// --- the display scale -------------------------------------------------------
//
// react-x11 hands a registered element two units (its docs/scale.md): `abs`,
// the layout and the four text accessors are device pixels, while `size` —
// pixels per em, a length the application wrote — is logical, and nothing
// in core multiplies it on the way in. At 1x, every other test here, the two
// coincide, which is how a layout built at `em: size` drew every formula at
// half the size of the text beside it the day a retina panel reported 2.
// This runs at 2x, holding every number to `abs` and a core-shaped `<text>`
// ruler rather than to another answer of the formula's.

test(
  'at a display scale of 2 the mathematics keeps its size beside body text',
  {
    skip: !engine || !FONTS || !engine.fonts,
  },
  async () => {
    const doc = (scale: number): Promise<unknown> =>
      renderX11(
        h(
          'box',
          {
            style: {
              flexGrow: 1,
              padding: 10,
              flexDirection: 'column',
              gap: 6,
            },
          },
          h(
            'text',
            { style: { fontSize: 20 }, 'data-testname': 'ruler' },
            'x2+1',
          ),
          h(Formula, { tex: 'x^2 + 1', size: 20 }),
        ),
        // A pinned display scale (react-x11's docs/scale.md): the headless
        // server resolves to exactly 1 on its own.
        { fonts: FONTS!, width: 420, height: 200, scale } as RenderX11Options,
      );

    await doc(1);
    await flushEngine();
    const ruler1 = screen.getByTestName('ruler').abs.height;
    const [one] = formulaNodes();
    const box1 = { width: one.abs.width, height: one.abs.height };
    const caret1 = one.textCaretRect(0)!.height;
    await cleanup();

    await doc(2);
    await flushEngine();
    const ruler2 = screen.getByTestName('ruler').abs.height;
    const [two] = formulaNodes();

    // the ruler is core's: a 20-pixel `fontSize` shaped at 40 device pixels
    assert.ok(
      ruler2 >= ruler1 * 1.8,
      `the ruler doubled: ${ruler2} against ${ruler1} at 1x`,
    );
    // ...and 20 logical pixels per em is the same 40 on that grid
    assert.ok(
      two.abs.height >= box1.height * 1.8 && two.abs.width >= box1.width * 1.8,
      `the formula is shaped on the device grid: ${two.abs.width}×${two.abs.height} against ${box1.width}×${box1.height} at 1x`,
    );
    const beside1 = box1.height / ruler1;
    const beside2 = two.abs.height / ruler2;
    assert.ok(
      Math.abs(beside2 - beside1) < 0.1,
      `the mathematics holds its proportion to the text beside it: ${beside2.toFixed(2)} against ${beside1.toFixed(2)} at 1x`,
    );

    // the accessors are core's device-pixel contract: the glyph band
    // doubles, and the box's own edges resolve to its first and last glyphs.
    // The formula sits inside padding and below the ruler — at an `abs`
    // origin of (0, 0) a wrong unit would cancel out. (The mouse-drag path
    // is core's, and stops short at 2x over its own <text> too, so what is
    // held here is the seam the formula answers.)
    assert.ok(two.abs.x > 0 && two.abs.y > 0);
    const first = two.textCaretRect(0)!;
    assert.ok(
      first.height >= caret1 * 1.8,
      `the caret band doubled: ${first.height} against ${caret1} at 1x`,
    );
    const midY = two.abs.y + two.abs.height / 2;
    assert.equal(
      two.textIndexAt(two.abs.x + 1, midY),
      0,
      'the left edge of the box is the first glyph',
    );
    assert.ok(
      two.textIndexAt(two.abs.x + two.abs.width - 1, midY) >= 3,
      'the right edge of the box is the last glyph',
    );
  },
);
