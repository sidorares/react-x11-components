// <Html> — the grid properties as `el.style` keeps them: refused where the
// property does not take a value, and kept in their canonical form (CSSOM
// 6.7). The rows are WPT's `css/css-grid/parsing` cases.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  composeShorthand,
  expandShorthand,
  specifiedValue,
} from '../../src/html/css/specified.js';

const valid = (name: string, value: string, expected = value) =>
  assert.strictEqual(
    specifiedValue(name, value),
    expected,
    `${name}: ${value}`,
  );
const invalid = (name: string, value: string) =>
  assert.strictEqual(specifiedValue(name, value), null, `${name}: ${value}`);

test('a track list is refused where the grammar refuses it, and kept as written', () => {
  valid('grid-template-columns', 'none');
  valid('grid-template-columns', 'minmax(calc(0.5em + 10px), 5fr)');
  valid('grid-template-columns', 'repeat(1, [] 10px [])', 'repeat(1, 10px)');
  valid(
    'grid-template-columns',
    'repeat(2, fit-content(20%) [three four] 30px 40px [five six])',
  );
  valid('grid-template-rows', 'subgrid [a] [] [b]');
  for (const value of [
    '-10px',
    '-20%',
    'minmax(5fr, calc(0.5em + 10px))',
    'minmax(-10px, auto)',
    'fit-content(-10px)',
    '[one]',
    '[one] 10px [two] [three]',
    'repeat(auto-fill, -10px)',
    'repeat(auto-fill, 10px) repeat(auto-fit, 20%)',
    '[auto] 1px',
    'auto repeat(auto-fill, auto) auto',
    'repeat(auto-fill, minmax(fit-content(200px), auto))',
    'repeat(2, 50px repeat(2, 100px))',
    '100px repeat(2, [a])',
  ]) {
    invalid('grid-template-columns', value);
  }
});

test('the areas, the implicit tracks and the flow', () => {
  valid('grid-template-areas', '"  a  \t  b  "', '"a b"');
  valid('grid-template-areas', '"first ..."', '"first ."');
  for (const value of ['auto', '""', '"first" ""', 'none "first"']) {
    invalid('grid-template-areas', value);
  }
  valid('grid-auto-rows', 'minmax(1px, 5fr) 2px');
  valid('grid-auto-rows', 'auto /**/', 'auto');
  for (const value of [
    'none',
    '-1px',
    'minmax(1px)',
    'auto, 10%',
    '[] 1px []',
  ]) {
    invalid('grid-auto-rows', value);
  }
  valid('grid-auto-flow', 'dense row', 'dense');
  valid('grid-auto-flow', 'dense column', 'column dense');
  invalid('grid-auto-flow', 'row dense column');
});

test('a grid line has its number before its name and span first', () => {
  valid('grid-row-start', 'AuTo', 'auto');
  valid('grid-column-start', '+90', '90');
  valid('grid-column-start', 'Z -44', '-44 Z');
  valid('grid-column-start', 'SpAn i 2', 'span 2 i');
  valid('grid-area', 'span 1 i', 'span i');
  valid('grid-area', '--a');
  valid('grid-row', 'i / i', 'i');
  valid('grid-area', '1 / i  / auto / i', '1 / i');
  valid('grid-area', '1 / auto / i / auto', '1 / auto / i');
  for (const value of ['0', 'span 0', 'i 2 i', '1 / 2 / 3 / 4 / 5']) {
    invalid('grid-area', value);
  }
});

test('the placement shorthands set their longhands and read back from them', () => {
  assert.deepStrictEqual(expandShorthand('grid-row', '10'), [
    ['grid-row-start', '10'],
    ['grid-row-end', 'auto'],
  ]);
  assert.deepStrictEqual(expandShorthand('grid-area', 'a / b'), [
    ['grid-row-start', 'a'],
    ['grid-column-start', 'b'],
    ['grid-row-end', 'a'],
    ['grid-column-end', 'b'],
  ]);
  const longhands = new Map([
    ['grid-row-start', '1'],
    ['grid-column-start', 'auto'],
    ['grid-row-end', '2'],
    ['grid-column-end', 'auto'],
  ]);
  assert.strictEqual(
    composeShorthand('grid-area', (part) => longhands.get(part) ?? null),
    '1 / auto / 2',
  );
});

test('grid-template takes two lists, or rows of strings and a list', () => {
  valid('grid-template', 'none / none', 'none');
  valid('grid-template', '[] 10px [] / [] auto []', '10px / auto');
  valid('grid-template', '"a" auto', '"a"');
  valid('grid-template', '"a" [a] [b] "b"', '"a" [a b] "b"');
  valid('grid-template', '"a" / 0', '"a" / 0px');
  valid(
    'grid-template',
    '"a" auto [a] "b" auto [b] / 10px',
    '"a" [a] "b" [b] / 10px',
  );
  for (const value of [
    'auto',
    '10px',
    '[a] 10px',
    '[] [] "a"',
    '10px "a"',
    '"a" none',
    '"a" 10px 10px',
    '"a" [a] 10px',
    '[a] "a" [a] [a]',
    '"a" / none',
    'none / "a"',
    '"a" / repeat(2, 10px)',
  ]) {
    invalid('grid-template', value);
  }
  assert.deepStrictEqual(
    expandShorthand(
      'grid-template',
      '[header-top] "a a a" [header-bottom] [main-top] "b b b" 1fr [main-bottom] / auto 1fr auto',
    ),
    [
      [
        'grid-template-rows',
        '[header-top] auto [header-bottom main-top] 1fr [main-bottom]',
      ],
      ['grid-template-columns', 'auto 1fr auto'],
      ['grid-template-areas', '"a a a" "b b b"'],
    ],
  );
});

test('grid is a template, or one axis and the other flowing', () => {
  valid(
    'grid',
    '100px / dense auto-flow 100px',
    '100px / auto-flow dense 100px',
  );
  valid('grid', 'dense auto-flow 1fr / 100px', 'auto-flow dense 1fr / 100px');
  valid('grid', 'none / auto-flow 100px');
  valid('grid', 'auto-flow 1fr / none');
  valid('grid', '"a" [a] "b" [a] / 0', '"a" [a] "b" [a] / 0px');
  for (const value of [
    'auto-flow 100px',
    'auto-flow / auto-flow',
    'dense auto-flow / dense auto-flow',
    'auto / auto-flow foo()',
    'auto-flow 10px dense / 1px',
  ]) {
    invalid('grid', value);
  }
  assert.deepStrictEqual(
    expandShorthand('grid', 'auto-flow dense 30px / 40px'),
    [
      ['grid-template-rows', 'none'],
      ['grid-template-columns', '40px'],
      ['grid-template-areas', 'none'],
      ['grid-auto-rows', '30px'],
      ['grid-auto-columns', 'auto'],
      ['grid-auto-flow', 'dense'],
    ],
  );
  // read back from longhands set one at a time: as a template where the
  // flow and the implicit tracks are their initial values, as a flow where
  // the other axis has no template, and '' where it is neither
  const from = (set: Record<string, string>) => {
    const all: Record<string, string> = {
      'grid-template-rows': 'none',
      'grid-template-columns': 'none',
      'grid-template-areas': 'none',
      'grid-auto-rows': 'auto',
      'grid-auto-columns': 'auto',
      'grid-auto-flow': 'row',
      ...set,
    };
    return composeShorthand('grid', (part) => all[part] ?? null);
  };
  assert.strictEqual(from({ 'grid-template-columns': '10px' }), 'none / 10px');
  assert.strictEqual(
    from({ 'grid-auto-flow': 'dense', 'grid-template-columns': '2px' }),
    'auto-flow dense / 2px',
  );
  assert.strictEqual(
    from({ 'grid-auto-rows': '1px', 'grid-auto-columns': '3px' }),
    '',
  );
  assert.strictEqual(from({ 'grid-auto-flow': 'inherit' }), '');
  assert.strictEqual(
    from({
      'grid-template-areas': '"one two" "three four"',
      'grid-template-columns': '100px 100px',
    }),
    '',
    'two strings and no rows',
  );
});

test('grid lanes take their properties as WPT has them', () => {
  valid(
    'grid-lanes',
    'column fill-reverse "a" 10px',
    '"a" 10px column fill-reverse',
  );
  valid('grid-lanes', '10px 20px "a b"', '"a b" 10px 20px column');
  invalid('grid-lanes', '"a a" 1fr row normal extra');
  // kept in the order written, which only the computed value is not
  valid('grid-lanes-direction', 'row track-reverse fill-reverse');
  valid('grid-lanes-direction', 'Column  FILL-reverse', 'column fill-reverse');
  invalid('grid-lanes-direction', 'normal track-reverse');
  valid('grid-lanes-pack', 'dense');
  invalid('grid-lanes-pack', 'normal dense');
  valid('fit-tolerance', '0', '0px');
  valid('fit-tolerance', 'calc(2em + 3ex)');
  for (const value of ['auto', '10', '-1px', '10px 20px', '1fr']) {
    invalid('fit-tolerance', value);
  }
});
