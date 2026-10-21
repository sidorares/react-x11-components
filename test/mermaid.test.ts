// <Mermaid> — the path parser and the scene reader are tested directly
// (they are pure, and ondine's SVG is their whole input), the widget
// through the harness: mock backend for structure, the fallback states and
// the text accessors, the in-process X server for real metrics, pixels,
// links and the display scale.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import React from 'react';

import { renderX11, cleanup, screen, fireEvent, act } from 'react-x11/test';
import type { RenderX11Options } from 'react-x11/test';
import { drawnKinds, registeredElements } from 'react-x11/host';
import type { DrawnNode } from 'react-x11';

import { Markdown, Mermaid, MermaidNode } from '../src/index.js';
import { MERMAID_ELEMENT, parseScene } from '../src/mermaid/index.js';
import { loadOndine } from '../src/mermaid/ondine.js';
import type { OndineEngine, OndineError } from '../src/mermaid/ondine.js';
import { parsePath, parseTransform, rectSegs } from '../src/mermaid/path.js';
import type { Seg } from '../src/mermaid/path.js';
import { resolveColor, resolveVars } from '../src/mermaid/scene.js';
import type { ScenePath, SceneText } from '../src/mermaid/scene.js';

const h = React.createElement;

afterEach(cleanup);

// ondine is an optional peer and a devDependency here; the guard keeps the
// suite honest on a tree without it.
let engine: OndineEngine | null = null;
try {
  engine = await loadOndine();
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

const FLOW = 'flowchart LR\n  A[Start] --> B{Is it?}\n  B -->|Yes| C[OK]';

/** The component's engine load resolves a tick after mount. */
async function flushEngine(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act();
}

function mermaidNodes(): MermaidNode[] {
  return screen
    .all((n) => n instanceof MermaidNode)
    .map((n) => n as unknown as MermaidNode);
}

function last(segs: Seg[]): { x: number; y: number } {
  const s = segs[segs.length - 1];
  assert.ok(s.c !== 'Z');
  return { x: s.x, y: s.y };
}

// --- path data and transforms, headless --------------------------------------

test('path data: relative forms, shorthands and quadratics', () => {
  const segs = parsePath('M10 10h20v10l-5 5H0zm1 1q10 0 10 10t10 10');
  assert.deepStrictEqual(segs.slice(0, 4), [
    { c: 'M', x: 10, y: 10 },
    { c: 'L', x: 30, y: 10 },
    { c: 'L', x: 30, y: 20 },
    { c: 'L', x: 25, y: 25 },
  ]);
  assert.deepStrictEqual(segs[4], { c: 'L', x: 0, y: 25 });
  assert.deepStrictEqual(segs[5], { c: 'Z' });
  // after a close, a relative move is from the subpath's start
  assert.deepStrictEqual(segs[6], { c: 'M', x: 11, y: 11 });
  assert.deepStrictEqual(last(segs.slice(0, 8)), { x: 21, y: 21 });
  assert.deepStrictEqual(last(segs), { x: 31, y: 31 });
});

test('an arc lands on its endpoint, through cubics, flags packed or not', () => {
  // a half circle of radius 10 from (0,0) to (20,0)
  for (const d of ['M0 0A10 10 0 0 1 20 0', 'M0 0a10 10 0 0120 0']) {
    const segs = parsePath(d);
    assert.ok(segs.length >= 3, `${d}: the arc became cubics`);
    assert.ok(segs.slice(1).every((s) => s.c === 'C'));
    const end = last(segs);
    assert.ok(Math.abs(end.x - 20) < 1e-9 && Math.abs(end.y) < 1e-9, d);
    // sweep 1 from left to right goes through the top, y = -10
    const mid = segs[1] as Extract<Seg, { c: 'C' }>;
    assert.ok(Math.abs(mid.x - 10) < 1e-6 && Math.abs(mid.y + 10) < 1e-6);
  }
  // one ondine's database icon writes: an ellipse, as two arcs
  const icon = parsePath('M4 6a8 3 0 1 0 16 0a8 3 0 1 0-16 0');
  assert.deepStrictEqual(last(icon), { x: 4, y: 6 });
});

test('a malformed tail keeps what was read', () => {
  const segs = parsePath('M0 0L10 10L20');
  assert.deepStrictEqual(segs, [
    { c: 'M', x: 0, y: 0 },
    { c: 'L', x: 10, y: 10 },
  ]);
});

test('transforms compose left to right, rotate about a point', () => {
  const m = parseTransform('translate(10,20) rotate(90 5 5)');
  // (5, 0) turns about (5, 5) to (10, 5), then moves by (10, 20)
  const x = m[0] * 5 + m[2] * 0 + m[4];
  const y = m[1] * 5 + m[3] * 0 + m[5];
  assert.ok(Math.abs(x - 20) < 1e-9 && Math.abs(y - 25) < 1e-9, `${x},${y}`);
});

test('a rect clamps its radii to half its sides', () => {
  const segs = rectSegs(0, 0, 10, 4, 100);
  assert.ok(segs.some((s) => s.c === 'C'));
  const points = segs.filter((s) => s.c !== 'Z') as Array<{
    x: number;
    y: number;
  }>;
  assert.ok(points.every((p) => p.x >= 0 && p.x <= 10 && p.y >= 0 && p.y <= 4));
});

// --- values ------------------------------------------------------------------

test('var() resolves through nesting and fallbacks; color-mix mixes in sRGB', () => {
  const env = new Map([
    ['--_fg', '#000'],
    ['--_bg', '#fff'],
  ]);
  assert.equal(resolveVars('var(--missing, var(--_fg))', env), '#000');
  assert.equal(resolveVars('var(--_bg,red)', env), '#fff');
  assert.equal(resolveVars('var(--missing)', env), '');
  assert.equal(
    resolveColor('color-mix(in srgb,#000 20%,#ffffff)'),
    'rgba(204, 204, 204, 1)',
  );
  assert.equal(resolveColor('#123'), '#123');
});

// --- the scene, from ondine's own output --------------------------------------

test(
  'a flowchart reads into outlines and labels, themed by the vars',
  { skip: !engine },
  () => {
    const { svg, width, height } = engine!.render(FLOW);
    const scene = parseScene(svg, {
      '--ondine-fg': '#112233',
      '--ondine-bg': '#fafafa',
    });
    assert.equal(scene.width, width);
    assert.equal(scene.height, height);
    assert.deepStrictEqual(
      new Set(scene.texts.map((t) => t.text)),
      new Set(['Start', 'Is it?', 'OK', 'Yes']),
    );
    // every outline drew in the theme — nothing fell back to ondine's
    // black-on-white defaults
    const paths = scene.items.filter((i): i is ScenePath => i.kind === 'path');
    assert.ok(paths.length >= 5);
    for (const p of paths) {
      for (const paint of [p.fill, p.stroke]) {
        assert.ok(
          paint === null || !/^(#000|#fff|black|white)$/i.test(paint),
          `a paint resolved past the theme: ${paint}`,
        );
      }
      // and everything is inside the diagram
      assert.ok(p.bounds);
      assert.ok(p.bounds.x >= -1 && p.bounds.x + p.bounds.width <= width + 1);
    }
    const labels = scene.texts;
    assert.ok(labels.every((t) => t.fill === '#112233'));
    // the node groups' translate reached their labels: "Start" is left of
    // "OK" in a left-to-right chart
    const at = (text: string): SceneText =>
      labels.find((t) => t.text === text)!;
    assert.ok(at('Start').matrix[4] < at('OK').matrix[4]);
  },
);

test(
  'every diagram type ondine renders reads with finite geometry',
  { skip: !engine },
  () => {
    const sources = [
      FLOW,
      'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi',
      'classDiagram\n  Animal <|-- Duck\n  class Duck{\n    +swim()\n  }',
      'stateDiagram-v2\n  [*] --> Still\n  Still --> [*]',
      'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
      'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85',
      'gitGraph\n  commit\n  branch dev\n  commit',
      'mindmap\n  root((m))\n    a\n    b',
      'architecture-beta\n  group api(cloud)[API]\n  service db(database)[DB] in api',
      'xychart\n  x-axis [a, b]\n  y-axis "Rev" 0 --> 10\n  bar [1, 5]',
    ];
    for (const source of sources) {
      const scene = parseScene(engine!.render(source, { now: 0 }).svg);
      assert.ok(scene.items.length > 0, source);
      for (const item of scene.items) {
        if (item.kind === 'path') {
          for (const s of item.segs) {
            if (s.c === 'Z') continue;
            assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), source);
          }
        } else {
          assert.ok(item.text.length > 0 && item.size > 0, source);
        }
      }
    }
  },
);

test('a link wraps what it holds', { skip: !engine }, () => {
  const { svg } = engine!.render(
    'flowchart LR\n  a1 --> b1\n  click a1 "https://example.com"',
  );
  const scene = parseScene(svg);
  const a1 = scene.texts.find((t) => t.text === 'a1')!;
  assert.equal(a1.href, 'https://example.com/');
  assert.equal(scene.texts.find((t) => t.text === 'b1')!.href, null);
});

// --- the widget, on the mock backend ------------------------------------------

test('the element is registered and drawn', () => {
  assert.ok(registeredElements().includes(MERMAID_ELEMENT));
  assert.ok(drawnKinds().includes(MERMAID_ELEMENT));
});

test(
  'the labels answer the text accessors in reading order',
  { skip: !engine },
  async () => {
    await renderX11(h(Mermaid, { source: FLOW }), { backend: 'mock' });
    await flushEngine();
    const [node] = mermaidNodes();
    assert.ok(node, 'a diagram rendered');
    const text = node.textContent();
    assert.deepStrictEqual(
      new Set(text.split('\n')),
      new Set(['Start', 'Is it?', 'OK', 'Yes']),
    );
    const start = text.indexOf('Start');
    const rects = node.textRangeRects(start, start + 5);
    assert.equal(rects.length, 1);
    assert.ok(rects[0].width > 0 && rects[0].height > 0);
  },
);

test(
  'while partial, the last diagram that compiled stands in',
  { skip: !engine },
  async () => {
    const r = await renderX11(h(Mermaid, { source: FLOW, partial: true }), {
      backend: 'mock',
    });
    await flushEngine();
    const before = mermaidNodes()[0]?.textContent();
    assert.ok(before?.includes('Start'));
    // a torn tail does not compile: the old diagram keeps rendering
    await act(() =>
      r.rerender(h(Mermaid, { source: FLOW + '\n  C --> ', partial: true })),
    );
    assert.equal(mermaidNodes()[0]?.textContent(), before);
    // ...and the tail takes over the moment it closes
    await act(() =>
      r.rerender(
        h(Mermaid, { source: FLOW + '\n  C --> D[Done]', partial: true }),
      ),
    );
    assert.ok(mermaidNodes()[0]?.textContent().includes('Done'));
  },
);

test(
  'nothing compiled while partial shows the source; final shows the error',
  { skip: !engine },
  async () => {
    const torn = 'flowchart LR\n  A --> ';
    const errors: OndineError[] = [];
    const onError = (e: OndineError): void => {
      errors.push(e);
    };
    const r = await renderX11(
      h(Mermaid, { source: torn, partial: true, onError }),
      { backend: 'mock' },
    );
    await flushEngine();
    assert.equal(mermaidNodes().length, 0);
    assert.ok(screen.getByText(torn.trim(), { exact: false }));
    assert.equal(errors.length, 0, 'a stream is not an error yet');

    await act(() => r.rerender(h(Mermaid, { source: torn, onError })));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'syntax');
    assert.ok(screen.getByText('Parse error', { exact: false }));
  },
);

test(
  'a markdown ```mermaid fence renders through the seam',
  { skip: !engine },
  async () => {
    const fences = {
      mermaid: ({ text, partial }: { text: string; partial: boolean }) =>
        h(Mermaid, { source: text, partial }),
    };
    const source = 'before\n\n```mermaid\n' + FLOW + '\n```\n\nafter';
    await renderX11(h(Markdown, { source, fences }), { backend: 'mock' });
    await flushEngine();
    const [node] = mermaidNodes();
    assert.ok(node, 'the fence rendered a diagram');
    assert.ok(node.textContent().includes('Is it?'));
  },
);

// --- with real metrics: pixels, fit, links, scale ------------------------------

async function pixels(
  ctx: unknown,
  node: MermaidNode,
): Promise<Uint8ClampedArray> {
  const { abs } = node as unknown as DrawnNode;
  const { data } = await (
    ctx as {
      getImageData(
        x: number,
        y: number,
        w: number,
        h: number,
      ): Promise<{ data: Uint8ClampedArray }>;
    }
  ).getImageData(abs.x, abs.y, abs.width, abs.height);
  return data;
}

test(
  'the diagram draws ink in the theme on the real server',
  { skip: !engine || !FONTS },
  async () => {
    const { ctx } = await renderX11(
      h(
        'box',
        { style: { flexGrow: 1, padding: 10, backgroundColor: '#ffffff' } },
        h(Mermaid, {
          source: FLOW,
          vars: { '--ondine-fg': '#ff0000', '--ondine-bg': '#ffffff' },
        }),
      ),
      { fonts: FONTS!, width: 640, height: 240 },
    );
    await flushEngine();
    // the engine's arrival re-rendered; give the frame it asked for time to
    // paint before reading the server back
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const [node] = mermaidNodes();
    assert.ok(node.abs.width > 0 && node.abs.height > 0);
    const data = await pixels(ctx, node);
    let red = 0;
    // RGBA, as the context reads back
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] < 80) red += 1;
    }
    assert.ok(red > 200, `the outlines and labels drew in --ondine-fg: ${red}`);
  },
);

test(
  'a diagram wider than its column shrinks to it',
  { skip: !engine || !FONTS },
  async () => {
    const wide =
      'flowchart LR\n  A[one] --> B[two] --> C[three] --> D[four] --> E[five] --> F[six]';
    const natural = parseScene(engine!.render(wide, { fontSize: 14 }).svg);
    await renderX11(
      h(
        'box',
        { style: { width: 300, flexDirection: 'column' } },
        h(Mermaid, { source: wide, fontSize: 14 }),
      ),
      { fonts: FONTS!, width: 400, height: 300 },
    );
    await flushEngine();
    const [node] = mermaidNodes();
    assert.ok(natural.width > 300, 'the case is a diagram wider than 300');
    assert.ok(node.abs.width <= 300, `fits: ${node.abs.width}`);
    const ratio = node.abs.height / node.abs.width;
    assert.ok(
      Math.abs(ratio - natural.height / natural.width) < 0.02,
      'and keeps its proportions',
    );
  },
);

test(
  'a click link is followed through onLink, with the hand over it',
  { skip: !engine || !FONTS },
  async () => {
    const followed: string[] = [];
    await renderX11(
      h(
        'box',
        { style: { flexGrow: 1, padding: 20 } },
        h(Mermaid, {
          source:
            'flowchart LR\n  a1[go] --> b1[stay]\n  click a1 "https://example.com"',
          onLink: (href: string) => {
            followed.push(href);
          },
        }),
      ),
      { fonts: FONTS!, width: 400, height: 200 },
    );
    await flushEngine();
    const [node] = mermaidNodes();
    const text = node.textContent();
    const go = node.textRangeRects(
      text.indexOf('go'),
      text.indexOf('go') + 2,
    )[0];
    const stay = node.textRangeRects(
      text.indexOf('stay'),
      text.indexOf('stay') + 4,
    )[0];
    const centre = (r: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => ({
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
    });
    assert.equal(
      node.hrefAtPoint(centre(go).x, centre(go).y),
      'https://example.com/',
    );
    assert.equal(node.hrefAtPoint(centre(stay).x, centre(stay).y), null);
    assert.equal(node.cursorAt(centre(go).x, centre(go).y), 'pointer');

    const abs = (node as unknown as DrawnNode).abs;
    const dx = centre(go).x - (abs.x + abs.width / 2);
    const dy = centre(go).y - (abs.y + abs.height / 2);
    await act(async () => {
      fireEvent.click(node as unknown as DrawnNode, { dx, dy });
    });
    assert.deepStrictEqual(followed, ['https://example.com/']);
  },
);

// --- the display scale -------------------------------------------------------
//
// The scene is in logical pixels; `abs`, the paint and the four text
// accessors are device pixels; `hrefAtPoint` takes the logical point a
// mouse event carries. At 1x the three coincide. This mounts the diagram
// inside padding, below a ruler, at 1x and 2x, and holds the numbers to
// `abs` and the ruler rather than to another answer of the diagram's.

test(
  'at a display scale of 2 the diagram and its labels double',
  { skip: !engine || !FONTS },
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
            { style: { fontSize: 14 }, 'data-testname': 'ruler' },
            'Start',
          ),
          h(Mermaid, { source: FLOW, fontSize: 14, onLink: () => {} }),
        ),
        { fonts: FONTS!, width: 640, height: 300, scale } as RenderX11Options,
      );

    await doc(1);
    await flushEngine();
    const ruler1 = screen.getByTestName('ruler').abs.height;
    const [one] = mermaidNodes();
    const box1 = { width: one.abs.width, height: one.abs.height };
    const t1 = one.textContent();
    const band1 = one.textRangeRects(
      t1.indexOf('Start'),
      t1.indexOf('Start') + 5,
    )[0];
    await cleanup();

    await doc(2);
    await flushEngine();
    const ruler2 = screen.getByTestName('ruler').abs.height;
    const [two] = mermaidNodes();
    assert.ok(ruler2 >= ruler1 * 1.8, 'the ruler doubled');
    assert.ok(
      Math.abs(two.abs.width - box1.width * 2) <= 2 &&
        Math.abs(two.abs.height - box1.height * 2) <= 2,
      `the diagram doubled: ${two.abs.width}×${two.abs.height} against ${box1.width}×${box1.height}`,
    );
    const t2 = two.textContent();
    const band2 = two.textRangeRects(
      t2.indexOf('Start'),
      t2.indexOf('Start') + 5,
    )[0];
    assert.ok(
      Math.abs(band2.height / ruler2 - band1.height / ruler1) < 0.15,
      'a label holds its proportion to the text beside it',
    );
    assert.ok(two.abs.x > 0 && two.abs.y > 0);
    // the accessors' device point and the logical one a click carries name
    // the same label
    const mid = { x: band2.x + band2.width / 2, y: band2.y + band2.height / 2 };
    assert.equal(
      two.textIndexAt(mid.x, mid.y) - t2.indexOf('Start') <= 5,
      true,
    );
    assert.ok(two.textIndexAt(mid.x, mid.y) >= t2.indexOf('Start'));
  },
);
