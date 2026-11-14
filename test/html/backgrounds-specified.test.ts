// The background layers' properties as `el.style` keeps them
// (src/html/css/backgrounds-specified.ts): a list a layer at a time, each in
// canonical form or none of it kept. What each case expects is what
// Chromium answers; WPT's `css/css-backgrounds/parsing/` holds the rest.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { specifiedValue } from '../../src/html/css/specified.js';

const kept = (prop: string, value: string): string | null | undefined =>
  specifiedValue(prop, value);

test('a layer list is kept a layer at a time, or not at all', () => {
  assert.equal(
    kept('background-attachment', 'scroll, FIXED, local'),
    'scroll, fixed, local',
  );
  assert.equal(kept('background-attachment', 'local, none'), null);
  assert.equal(kept('background-origin', 'fill-box'), null);
  assert.equal(kept('background-clip', 'text border-area'), 'border-area text');
  assert.equal(kept('background-clip', 'border-box text'), null);
  assert.equal(kept('background-clip', 'border'), null);
  assert.equal(kept('background-attachment', 'inherit'), undefined);
});

test('a repeat and a size are as short as they go', () => {
  assert.equal(kept('background-repeat', 'repeat repeat'), 'repeat');
  assert.equal(kept('background-repeat', 'repeat no-repeat'), 'repeat-x');
  assert.equal(kept('background-repeat', 'no-repeat repeat'), 'repeat-y');
  assert.equal(
    kept('background-repeat', 'space round, repeat-x'),
    'space round, repeat-x',
  );
  assert.equal(kept('background-repeat', 'repeat repeat-x'), null);
  assert.equal(kept('background-size', '1px'), '1px auto');
  assert.equal(kept('background-size', 'auto auto'), 'auto');
  assert.equal(
    kept('background-size', 'auto 1px, 2% 3%, contain'),
    'auto 1px, 2% 3%, contain',
  );
  assert.equal(kept('background-size', '2% -3%'), null);
  assert.equal(kept('background-size', '1px 2px 3px'), null);
});

test('a position is across then down, a side before its offset', () => {
  for (const [value, want] of [
    ['1px', '1px center'],
    ['center left', 'left center'],
    ['top left', 'left top'],
    ['bottom', 'center bottom'],
    ['center right 7%', 'right 7% center'],
    ['top 17px right 18px', 'right 18px top 17px'],
    ['bottom 16% left', 'left bottom 16%'],
    ['-0px .5%', '0px 0.5%'],
  ] as const) {
    assert.equal(kept('background-position', value), want, value);
  }
  for (const bad of [
    'left right',
    '1% center 2px',
    'right 7% 50%',
    '50% top 8px',
  ]) {
    assert.equal(kept('background-position', bad), null, bad);
  }
  assert.equal(
    kept('background-position-x', 'calc(10px - 0.5em), left -20%'),
    'calc(-0.5em + 10px), left -20%',
  );
  assert.equal(kept('background-position-x', 'x-start'), 'x-start');
  assert.equal(kept('background-position-x', 'top'), null);
  assert.equal(kept('background-position-y', 'center 10px'), null);
  assert.equal(
    kept('background-position-y', 'bottom 10px, y-end'),
    'bottom 10px, y-end',
  );
});
