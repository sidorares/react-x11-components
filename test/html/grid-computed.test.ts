// <Html> — a grid's properties as `getComputedStyle` reads them: the track
// lists resolved to what a layout came to (CSS Grid 1, 7.2.6), and the rest
// as they compute.
import { afterEach } from 'node:test';
import assert from 'node:assert';
import { cleanup } from 'react-x11/test';
import { findById, metric, render, view } from './harness.js';

afterEach(cleanup);

/** `#t`'s computed style, in a document of `body`. */
async function computed(body: string): Promise<Record<string, string>> {
  const { node } = await render(
    '<style>body{margin:0;font:16px/20px sans-serif}</style>' + body,
    600,
  );
  const el = view(node);
  const style = el.computedStyle(findById(el.document, 't')!);
  assert.ok(style, '#t has a style');
  return style;
}

metric(
  "a grid's track lists read as its tracks laid out, with their lines' names",
  async () => {
    const style = await computed(
      '<div id="t" style="display:grid;width:400px;' +
        'grid-template-columns:[a] 100px repeat(2, [b] 1fr) [c]">' +
        '<div style="height:20px"></div><div style="height:30px"></div>' +
        '<div></div><div></div></div>',
    );
    // a repetition by a count is its tracks, each line with its names
    assert.strictEqual(
      style['grid-template-columns'],
      '[a] 100px [b] 150px [b] 150px [c]',
    );
    // and the implicit rows the items made, which have no names
    assert.strictEqual(style['grid-template-rows'], '30px 0px');
  },
);

metric('an auto-fit track no item is in reads as nought', async () => {
  const style = await computed(
    '<div id="t" style="display:grid;width:300px;' +
      'grid-template-columns:repeat(auto-fit, 100px)"><div></div></div>',
  );
  assert.strictEqual(style['grid-template-columns'], '100px 0px 0px');
});

metric(
  'an element that is no grid reads its track lists as written, lengths in pixels',
  async () => {
    const style = await computed(
      '<div id="t" style="font-size:10px;' +
        'grid-template-columns:[a] 2em repeat(2, [b] minmax(10px, 1fr)) [c];' +
        'grid-template-rows:repeat(auto-fill, fit-content(20%) 1fr)"></div>',
    );
    assert.strictEqual(
      style['grid-template-columns'],
      '[a] 20px repeat(2, [b] minmax(10px, 1fr)) [c]',
    );
    assert.strictEqual(
      style['grid-template-rows'],
      'repeat(auto-fill, fit-content(20%) 1fr)',
    );
  },
);

metric(
  'the areas, the implicit tracks and the placement read as they compute',
  async () => {
    const style = await computed(
      "<div style=\"display:grid;grid-template-areas:'a a' 'b ...';" +
        'grid-auto-rows:minmax(calc(10px - 1em), auto) 20px">' +
        '<div id="t" style="grid-row:2 / span 3;grid-column:a"></div></div>',
    );
    assert.strictEqual(style['grid-row-start'], '2');
    assert.strictEqual(style['grid-row-end'], 'span 3');
    assert.strictEqual(style['grid-column-start'], 'a');
    assert.strictEqual(style['grid-column-end'], 'a');
    const grid = await computed(
      "<div id=\"t\" style=\"display:grid;grid-template-areas:'a a' 'b ...';" +
        'grid-auto-rows:minmax(calc(10px - 1em), auto) 20px"></div>',
    );
    assert.strictEqual(grid['grid-template-areas'], '"a a" "b ."');
    // a calculation below nought is nought
    assert.strictEqual(grid['grid-auto-rows'], 'minmax(0px, auto) 20px');
    assert.strictEqual(grid['grid-auto-columns'], 'auto');
  },
);

metric(
  'grid lanes read their lanes as laid out, and the shorthand as it computes',
  async () => {
    const lanes = await computed(
      '<div id="t" style="display:grid-lanes;width:300px;' +
        'grid-template-columns:repeat(3, 1fr)"><div></div></div>',
    );
    assert.strictEqual(lanes['grid-template-columns'], '100px 100px 100px');
    // the stacking axis has no tracks of its own
    assert.strictEqual(lanes['grid-template-rows'], 'none');
    assert.strictEqual(lanes['grid-lanes'], '100px 100px 100px normal');
    const block = await computed(
      '<div id="t" style="grid-lanes:\'a b\' 1fr 2fr row"></div>',
    );
    assert.strictEqual(block['grid-lanes'], '"a b" 1fr 2fr row');
    assert.strictEqual(block['grid-template-areas'], '"a" "b"');
  },
);

metric(
  "a subgrid's axis reads as its own names for each line it spans",
  async () => {
    // CSS Grid 2, 7.2.6: four tracks are five lines, an auto-fill repeated
    // into the room its other groups leave, the rest empty
    const style = await computed(
      '<div style="display:grid;grid-template-columns:repeat(6, 10px)">' +
        '<div id="t" style="display:grid;grid-column:2 / span 4;' +
        'grid-template-columns:subgrid [a] repeat(auto-fill, [b]) [c] [d]">' +
        '</div></div>',
    );
    assert.strictEqual(
      style['grid-template-columns'],
      'subgrid [a] [b] [b] [c] [d]',
    );
  },
);

metric(
  'subgrid is none on a grid with no grid around it, and as written on what is no grid',
  async () => {
    const grid = await computed(
      '<div id="t" style="display:grid;' +
        'grid-template-rows:subgrid repeat(2, [a] [b])"></div>',
    );
    assert.strictEqual(grid['grid-template-rows'], 'none');
    // and with nothing in it, its columns, whose template is none, have no
    // track, as the `none` read back sets them
    assert.strictEqual(grid['grid-template-columns'], 'none');
    // a box with layout containment keeps its layout apart from the grid
    // around it, and so subgrids nothing either
    const contained = await computed(
      '<div style="display:grid;grid-template-columns:10px 10px">' +
        '<div id="t" style="display:grid;contain:layout;grid-column:span 2;' +
        'grid-template-columns:subgrid"></div></div>',
    );
    assert.strictEqual(contained['grid-template-columns'], 'none');
    const block = await computed(
      '<div id="t" style="grid-template-rows:subgrid [a] repeat(2, [c] [d e])"></div>',
    );
    assert.strictEqual(
      block['grid-template-rows'],
      'subgrid [a] repeat(2, [c] [d e])',
    );
  },
);
