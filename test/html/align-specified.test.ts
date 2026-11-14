// The box alignment, gap and flex properties as `el.style` keeps them
// (`src/html/css/align-specified.ts`): each held to its grammar, kept in
// its canonical form, and a shorthand set as its longhands and read back
// as short as it can be said. WPT's `css/css-align/parsing/`,
// `css-align/*/place-*-shorthand-*.html` and `css-flexbox/parsing/` hold
// the rest.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  composeShorthand,
  expandShorthand,
  specifiedValue,
} from '../../src/html/css/specified.js';

const longhandsOf = (name: string, value: string) => {
  const specified = specifiedValue(name, value);
  assert.ok(specified, `${name}: ${value} is taken`);
  return Object.fromEntries(expandShorthand(name, specified) ?? []);
};

test('an alignment longhand takes its grammar and says first baseline as baseline', () => {
  const cases: [string, string, string | null][] = [
    ['align-content', 'first baseline', 'baseline'],
    ['align-content', 'Safe  FLEX-END', 'safe flex-end'],
    ['align-content', 'auto', null],
    ['align-content', 'left', null],
    ['justify-content', 'unsafe right', 'unsafe right'],
    ['justify-content', 'baseline', null],
    ['align-items', 'self-start', 'self-start'],
    ['align-items', 'auto', null],
    ['justify-items', 'right legacy', 'legacy right'],
    ['justify-items', 'legacy start', null],
    ['align-self', 'auto', 'auto'],
    ['align-self', 'baseline last', null],
    ['align-self', 'center safe', null],
    ['justify-self', 'anchor-center', 'anchor-center'],
    ['justify-self', 'legacy', null],
  ];
  for (const [name, value, expected] of cases) {
    assert.equal(specifiedValue(name, value), expected, `${name}: ${value}`);
  }
});

test('a place shorthand sets its two longhands, the second the first again where it is not given', () => {
  assert.deepEqual(longhandsOf('place-content', 'center'), {
    'align-content': 'center',
    'justify-content': 'center',
  });
  assert.deepEqual(longhandsOf('place-content', 'last baseline'), {
    'align-content': 'last baseline',
    'justify-content': 'start',
  });
  assert.deepEqual(longhandsOf('place-items', 'first baseline unsafe left'), {
    'align-items': 'baseline',
    'justify-items': 'unsafe left',
  });
  assert.equal(specifiedValue('place-self', 'auto auto'), 'auto');
  assert.equal(specifiedValue('place-self', 'right'), null);
  assert.equal(specifiedValue('place-content', 'start baseline'), null);
  assert.deepEqual(longhandsOf('place-items', 'initial'), {
    'align-items': 'initial',
    'justify-items': 'initial',
  });
});

test('a gap is one or two non-negative lengths or normal, and reads back as one where both are the same', () => {
  assert.deepEqual(longhandsOf('gap', '10px normal'), {
    'row-gap': '10px',
    'column-gap': 'normal',
  });
  assert.equal(specifiedValue('gap', '20% 20%'), '20%');
  assert.equal(specifiedValue('row-gap', '0'), '0px');
  assert.equal(specifiedValue('gap', '-10px'), null);
  assert.equal(specifiedValue('grid-row-gap', 'auto'), null);
  assert.equal(
    composeShorthand('gap', (n) => (n === 'row-gap' ? '1px' : '2px')),
    '1px 2px',
  );
});

test('flex is its three longhands, a factor alone a basis of 0% and a basis alone factors of 1', () => {
  const cases: [string, string | null][] = [
    ['none', '0 0 auto'],
    ['1', '1 1 0%'],
    ['6px 4 5', '4 5 6px'],
    ['8 auto', '8 1 auto'],
    ['auto', '1 1 auto'],
    ['content', '1 1 content'],
    ['calc(-1) calc(-1) 0', 'calc(-1) calc(-1) 0px'],
    ['1 1 calc(10em)', '1 1 calc(10em)'],
    ['2 3 4', null],
    ['none 1', null],
    ['1 2 calc(0)', null],
  ];
  for (const [value, expected] of cases) {
    assert.equal(specifiedValue('flex', value), expected, `flex: ${value}`);
  }
  assert.deepEqual(longhandsOf('flex', '7% 8'), {
    'flex-grow': '8',
    'flex-shrink': '1',
    'flex-basis': '7%',
  });
});

test('flex-flow says what is not its initial value, and the flex longhands take their numbers and keywords', () => {
  assert.equal(specifiedValue('flex-flow', 'column nowrap'), 'column');
  assert.equal(
    specifiedValue('flex-flow', 'wrap row-reverse'),
    'row-reverse wrap',
  );
  assert.equal(specifiedValue('flex-flow', 'row wrap'), 'wrap');
  assert.equal(specifiedValue('flex-flow', 'nowrap row nowrap'), null);
  assert.equal(specifiedValue('flex-grow', '23.4e5'), '2340000');
  assert.equal(specifiedValue('flex-grow', '1.'), null);
  assert.equal(specifiedValue('flex-shrink', '-1'), null);
  assert.equal(specifiedValue('order', '-45'), '-45');
  assert.equal(specifiedValue('order', '123.45'), null);
  assert.equal(specifiedValue('flex-basis', 'none'), null);
  assert.equal(specifiedValue('flex-basis', '-2%'), null);
  assert.equal(specifiedValue('flex-basis', 'fit-content'), 'fit-content');
  assert.equal(specifiedValue('flex-direction', 'auto'), null);
  assert.equal(
    specifiedValue('flex-wrap', 'balance wrap-reverse'),
    'wrap-reverse balance',
  );
  assert.equal(specifiedValue('flex-wrap', 'nowrap balance'), null);
  assert.equal(specifiedValue('flex-flow', 'balance wrap row'), 'balance');
  assert.equal(specifiedValue('flex-flow', 'wrap row balance'), null);
  assert.equal(specifiedValue('justify-self', 'safe normal'), 'safe normal');
  assert.equal(
    specifiedValue('justify-content', 'unsafe flow-end'),
    'unsafe flow-end',
  );
  assert.equal(specifiedValue('align-content', 'safe normal'), null);
});
