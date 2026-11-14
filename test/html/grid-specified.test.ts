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

test('grid lanes take their properties as WPT has them', () => {
  valid(
    'grid-lanes',
    'column fill-reverse "a" 10px',
    '"a" 10px column fill-reverse',
  );
  valid('grid-lanes', '10px 20px "a b"', '"a b" 10px 20px column');
  invalid('grid-lanes', '"a a" 1fr row normal extra');
  valid(
    'grid-lanes-direction',
    'row track-reverse fill-reverse',
    'row fill-reverse track-reverse',
  );
  invalid('grid-lanes-direction', 'normal track-reverse');
  valid('grid-lanes-pack', 'dense');
  invalid('grid-lanes-pack', 'normal dense');
  valid('fit-tolerance', '0', '0px');
  valid('fit-tolerance', 'calc(2em + 3ex)');
  for (const value of ['auto', '10', '-1px', '10px 20px', '1fr']) {
    invalid('fit-tolerance', value);
  }
});
