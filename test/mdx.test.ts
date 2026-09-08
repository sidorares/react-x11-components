// MDX in `<Markdown>` — the M1 rung: components in block position, resolved
// from a map, with nothing evaluated (docs/prd-mdx.md).
//
// The parser is tested directly, as `markdown.test.ts` does, because it is
// exported API and because the interesting half of this feature is what it
// declines to parse. The renderer is tested through the mock backend, which
// is enough for "did the component mount and what was it handed".
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { renderX11, cleanup, screen } from 'react-x11/test';

import { Markdown, parseMarkdown } from '../src/index.js';
import type { BlockNode, ComponentBlock } from '../src/index.js';

const h = React.createElement;

afterEach(cleanup);

const KNOWN = ['Chart', 'Callout', 'Card.Header', 'Card'];
const isComponent = (name: string): boolean => KNOWN.includes(name);

/** Parse as a finished document with the gate on. */
function blocks(source: string, partial = false): BlockNode[] {
  return parseMarkdown(source, { partial, isComponent }).blocks;
}

function only(source: string): ComponentBlock {
  const [block, ...rest] = blocks(source);
  assert.equal(rest.length, 0, 'expected exactly one block');
  assert.equal(block.type, 'component');
  return block as ComponentBlock;
}

/** Attribute values, unwrapped from their tagged form. */
function attrs(block: ComponentBlock): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(block.attributes)) {
    out[k] = v.kind === 'literal' ? v.value : `expr:${v.src}`;
  }
  return out;
}

// --- the gate --------------------------------------------------------------

test('without a gate, a tag is the literal text it has always been', () => {
  const source = '<Chart data={[1,2]} />';
  const [block, ...rest] = parseMarkdown(source, { partial: false }).blocks;
  assert.equal(rest.length, 0);
  assert.equal(block.type, 'paragraph');
  // and byte-identically to a document that never heard of components
  assert.deepEqual(
    parseMarkdown(source, { partial: false }),
    parseMarkdown(source, { partial: false, isComponent: () => false }),
  );
});

test('a name nobody claims stays text, and so does its close tag', () => {
  assert.deepEqual(
    blocks('<Nope foo="1" />').map((b) => b.type),
    ['paragraph'],
  );
  assert.deepEqual(
    blocks('</Chart>').map((b) => b.type),
    ['paragraph'],
  );
});

test('braces in ordinary prose are untouched by the gate', () => {
  const [para] = blocks('a {braces} b and <box> too');
  assert.equal(para.type, 'paragraph');
});

// --- shape -----------------------------------------------------------------

test('a self-closing tag on its own line is a block', () => {
  const block = only('<Chart />');
  assert.equal(block.name, 'Chart');
  assert.deepEqual(block.children, []);
});

test('attributes: strings, bare names, and JSON braces', () => {
  const block = only(
    `<Chart title="Q3" alt='single' flag data={[1,2]} n={240} ` +
      `off={false} obj={{"a":1}} />`,
  );
  assert.deepEqual(attrs(block), {
    title: 'Q3',
    alt: 'single',
    flag: true,
    data: [1, 2],
    n: 240,
    off: false,
    obj: { a: 1 },
  });
});

test('a brace that is not JSON makes the tag text, not an error', () => {
  assert.deepEqual(
    blocks('<Chart data={quarters} />').map((b) => b.type),
    ['paragraph'],
  );
});

test('a tag may span lines, but not a blank one', () => {
  const block = only('<Chart\n  data={[1,2]}\n  height={240}\n/>');
  assert.deepEqual(attrs(block), { data: [1, 2], height: 240 });
  assert.deepEqual(
    blocks('<Chart\n\n  data={[1]} />').map((b) => b.type),
    ['paragraph', 'paragraph'],
  );
});

test('a dotted name resolves flat or by walking', () => {
  assert.equal(only('<Card.Header title="x" />').name, 'Card.Header');
});

test('prose after the tag makes it a paragraph — inline is not this rung', () => {
  assert.deepEqual(
    blocks('<Chart /> and prose').map((b) => b.type),
    ['paragraph'],
  );
});

test('children are markdown, and nest', () => {
  const block = only('<Callout>\n\n# hi\n\n- a\n- b\n\n</Callout>');
  assert.deepEqual(
    block.children.map((b) => b.type),
    ['heading', 'list'],
  );
  const outer = only(
    '<Callout>\n\n<Callout>\n\ninner\n\n</Callout>\n\n</Callout>',
  );
  assert.equal(outer.children.length, 1);
  assert.equal(outer.children[0].type, 'component');
});

test('a component interrupts a paragraph', () => {
  assert.deepEqual(
    blocks('text\n<Chart />\nmore').map((b) => b.type),
    ['paragraph', 'component', 'paragraph'],
  );
});

test('an unclosed element in a final document is text', () => {
  assert.deepEqual(
    blocks('<Callout>\n\nbody').map((b) => b.type),
    ['paragraph', 'paragraph'],
  );
});

// --- streaming -------------------------------------------------------------

test('a tag still arriving is held back, never shown as syntax', () => {
  const whole = 'before\n\n<Chart data={[1,2]} height={240} />';
  for (let n = 'before\n\n'.length; n < whole.length; n += 1) {
    const parsed = blocks(whole.slice(0, n), true);
    const types = parsed.map((b) => b.type);
    assert.deepEqual(
      types.filter((t) => t === 'component'),
      [],
      `partial tag leaked at ${n}`,
    );
    // and no raw `<` reached a paragraph either
    const text = JSON.stringify(parsed);
    assert.ok(!text.includes('<Chart'), `raw tag text leaked at ${n}`);
  }
  const [, done] = blocks(whole, true);
  assert.equal(done.type, 'component');
});

test('an element whose children are still arriving shows the children', () => {
  const parsed = blocks('<Callout>\n\nbody so far', true);
  assert.deepEqual(
    parsed.map((b) => b.type),
    ['paragraph'],
  );
});

// --- rendering -------------------------------------------------------------

function Box({
  label,
  children,
}: {
  label?: unknown;
  children?: React.ReactNode;
}): React.ReactElement {
  return h(
    'box',
    { 'data-testname': `demo-${String(label ?? 'none')}` },
    children ?? null,
  );
}

test('a component mounts and is handed its attributes', async () => {
  await renderX11(
    h(Markdown, {
      source: '<Chart label="one" n={2} />',
      partial: false,
      components: { Chart: Box as never },
    }),
  );
  assert.ok(screen.getByTestName('demo-one'));
});

test('children arrive as rendered markdown', async () => {
  await renderX11(
    h(Markdown, {
      source: '<Callout label="c">\n\n# heading\n\n</Callout>',
      partial: false,
      components: { Callout: Box as never },
    }),
  );
  const host = screen.getByTestName('demo-c');
  assert.ok(host, 'the component mounted');
  // the heading was rendered *inside* it, not beside it
  assert.ok(host.children.length > 0, 'the component received children');
});

test('a document with no components prop renders as it always did', async () => {
  await renderX11(h(Markdown, { source: '<Chart />', partial: false }));
  assert.equal(screen.queryByTestName('demo-none'), null);
});
