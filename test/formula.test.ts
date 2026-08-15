// <Formula> — the layout engine is tested directly (it is pure, and every
// subtle mathematics bug lives there), the widget through the harness:
// mock backend for structure and the text accessors, the in-process X
// server for real metrics and the document selection.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';

import { renderX11, cleanup, screen, fireEvent, act } from 'react-x11/test';
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
