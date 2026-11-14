// The borders' properties as `el.style` keeps them
// (src/html/css/borders-specified.ts): a longhand in canonical form or not
// at all, a shorthand as its longhands, and the shorthand read back from
// them as short as it goes. What each case expects is what Chromium answers;
// WPT's `css/css-borders/` and `css/css-backgrounds/parsing/` hold the rest.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  composeShorthand,
  expandShorthand,
  specifiedValue,
} from '../../src/html/css/specified.js';
import {
  borderDeclared,
  collapseBorders,
} from '../../src/html/css/borders-specified.js';

/** What a shorthand reads back as once it is set, or what a longhand is
 *  kept as; '' for a value the property does not take. */
function kept(prop: string, value: string): string {
  const specified = specifiedValue(prop, value);
  if (specified === null) return '';
  if (specified === undefined) return value;
  const longhands = expandShorthand(prop, specified);
  if (!longhands) return specified;
  const set = new Map(longhands);
  return composeShorthand(prop, (n) => set.get(n) ?? null) ?? '';
}

test('a border is its width, its style and its colour, initial ones left out', () => {
  assert.equal(kept('border', 'green double thin'), 'thin double green');
  assert.equal(kept('border', 'none'), 'medium');
  assert.equal(kept('border-top', '0 solid'), '0px solid');
  assert.equal(kept('border', 'currentColor'), 'medium');
  for (const bad of [
    'auto',
    'red red',
    '1px 2px',
    'solid dotted',
    '-1px',
    'thin double green 1px',
  ]) {
    assert.equal(kept('border', bad), '', bad);
  }
  const sets = new Map(expandShorthand('border', 'thin')!);
  assert.equal(sets.get('border-image-slice'), '100%');
  assert.equal(sets.get('border-left-style'), 'none');
});

test('four sides are kept as few as say them', () => {
  assert.equal(
    kept('border-width', '0 thin 1em medium'),
    '0px thin 1em medium',
  );
  assert.equal(kept('border-width', '1px 2px 1px 2px'), '1px 2px');
  assert.equal(kept('border-style', 'dotted dashed dotted'), 'dotted dashed');
  assert.equal(
    kept('border-color', '#00FF00 currentColor'),
    'rgb(0, 255, 0) currentcolor',
  );
  assert.equal(
    kept('border-color', 'hsl(120 100% 50% / 50%)'),
    'rgba(0, 255, 0, 0.5)',
  );
  assert.equal(kept('background-color', '#0F08'), 'rgba(0, 255, 0, 0.533)');
  assert.equal(kept('border-top-width', 'calc(1px + 2px)'), 'calc(3px)');
  for (const [prop, bad] of [
    ['border-width', '-1px'],
    ['border-width', '1px 1px 1px 1px 1px'],
    ['border-width', '10%'],
    ['border-style', 'auto'],
    ['border-top-color', 'red blue'],
  ]) {
    assert.equal(kept(prop, bad), '', `${prop}: ${bad}`);
  }
});

test('a radius is up to four across and four down, the second left out where it is the first', () => {
  assert.equal(kept('border-radius', '1px 2px / 3px'), '1px 2px / 3px');
  assert.equal(kept('border-radius', '1px 2px / 1px 2px'), '1px 2px');
  assert.equal(
    kept('border-radius', '10% 1em 2px 3px / 4px 5px 6px 7px'),
    '10% 1em 2px 3px / 4px 5px 6px 7px',
  );
  assert.equal(kept('border-radius', 'calc(10% + 1px)'), 'calc(10% + 1px)');
  assert.equal(kept('border-top-left-radius', '1px 1px'), '1px');
  assert.equal(kept('-webkit-border-radius', '1px 2px'), '1px / 2px');
  for (const bad of [
    '1px /',
    '/ 1px',
    '-1px',
    '1px 2px 3px 4px 5px',
    '1px / 2px / 3px',
    'auto',
  ]) {
    assert.equal(kept('border-radius', bad), '', bad);
  }
});

/** A block's declarations as `cssText` writes them. */
function cssText(declarations: [string, string][]): string {
  return collapseBorders(
    declarations.map(([prop, value]) => ({ prop, value, important: false })),
  )
    .map((d) => `${d.prop}: ${d.value};`)
    .join(' ');
}
const set = (prop: string, value: string): [string, string][] =>
  expandShorthand(prop, specifiedValue(prop, value) as string)!;

test('cssText has a shorthand where the block declares all its longhands', () => {
  assert.equal(
    cssText(set('border', '1px solid #fff')),
    'border: 1px solid rgb(255, 255, 255);',
  );
  assert.equal(
    cssText(set('border-top', '1px solid')),
    'border-top: 1px solid;',
  );
  const changed = set('border', '1px solid').map(([n, v]): [string, string] =>
    n === 'border-top-width' ? [n, '2px'] : [n, v],
  );
  assert.equal(
    cssText(changed),
    'border-width: 2px 1px 1px; border-style: solid; border-color: currentcolor; border-image: none;',
  );
  const radius = set('border-radius', '10px').map(([n, v]): [string, string] =>
    n === 'border-top-left-radius' ? [n, '20px'] : [n, v],
  );
  assert.equal(cssText(radius), 'border-radius: 20px 10px 10px;');
  assert.equal(
    cssText([
      ['border-top-width', 'inherit'],
      ['border-right-width', 'inherit'],
      ['border-bottom-width', 'inherit'],
      ['border-left-width', '1px'],
    ]),
    'border-top-width: inherit; border-right-width: inherit; border-bottom-width: inherit; border-left-width: 1px;',
  );
  // and a block that says a shorthand is read as its longhands again
  assert.deepEqual(borderDeclared('border-width', '1px 2px'), [
    ['border-top-width', '1px'],
    ['border-right-width', '2px'],
    ['border-bottom-width', '1px'],
    ['border-left-width', '2px'],
  ]);
  assert.equal(borderDeclared('border-width', 'var(--w)'), null);
});
