// A box's margins, paddings and insets as `el.style` keeps them
// (`src/html/css/box-specified.ts`): each side held to what it takes, a
// shorthand set as its longhands and read back as few as say them. WPT's
// `css-box/parsing/`, `css-position/parsing/` and `css-logical/parsing/`
// hold the rest.
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

test('scale is one to three numbers or percentages, written as numbers and as few as say them', () => {
  // CSS Transforms 2, 4.2, as Chromium serializes it
  for (const bad of ['100px', '100 200 300 400', '1 junk']) {
    assert.strictEqual(specifiedValue('scale', bad), null, bad);
  }
  assert.strictEqual(specifiedValue('scale', '100%'), '1');
  assert.strictEqual(specifiedValue('scale', '-100 -100 1'), '-100');
  assert.strictEqual(specifiedValue('scale', '100% 200% 1'), '1 2');
  assert.strictEqual(specifiedValue('scale', '1 2 3'), '1 2 3');
});

test('rotate is an angle and an axis either side of it, written axis first and by name where it can be', () => {
  // CSS Transforms 2, 4.1, as Chromium serializes it: an axis along x or y
  // named, one the other way the angle turned back, z left out
  for (const bad of [
    '100px',
    '100 400deg',
    'x y 45deg',
    '45deg x y',
    'z',
    '1 2 3',
  ]) {
    assert.strictEqual(specifiedValue('rotate', bad), null, bad);
  }
  assert.strictEqual(specifiedValue('rotate', '400grad x'), 'x 400grad');
  assert.strictEqual(
    specifiedValue('rotate', '0 -0.5 0 400grad'),
    'y -400grad',
  );
  assert.strictEqual(specifiedValue('rotate', '400grad z'), '400grad');
  assert.strictEqual(
    specifiedValue('rotate', '400grad 100 200 300'),
    '100 200 300 400grad',
  );
});

test('a side takes a length, a percentage and auto where its kind does', () => {
  const cases: [string, string, string | null][] = [
    ['margin-top', '0', '0px'],
    ['margin-left', '-1.50PX', '-1.5px'],
    ['margin-block-start', 'auto', 'auto'],
    ['padding-top', '-1px', null],
    ['padding-right', 'auto', null],
    ['padding-inline-end', '10%', '10%'],
    ['top', 'auto', 'auto'],
    ['inset-inline-start', '10deg', null],
    ['left', '1px 2px', null],
  ];
  for (const [name, value, expected] of cases) {
    assert.equal(specifiedValue(name, value), expected, `${name}: ${value}`);
  }
});

test('margin, padding and inset set their four sides, and read back as few as say them', () => {
  assert.deepEqual(longhandsOf('margin', '1px 2px 3px 4px'), {
    'margin-top': '1px',
    'margin-right': '2px',
    'margin-bottom': '3px',
    'margin-left': '4px',
  });
  assert.deepEqual(longhandsOf('inset', '1px auto'), {
    top: '1px',
    right: 'auto',
    bottom: '1px',
    left: 'auto',
  });
  assert.equal(specifiedValue('padding', '1px 2px 1px 2px'), '1px 2px');
  assert.equal(specifiedValue('margin', '1px 1px 1px'), '1px');
  assert.equal(specifiedValue('padding', '1px -2px'), null);
  assert.equal(specifiedValue('margin', '1px 2px 3px 4px 5px'), null);
  assert.equal(
    composeShorthand('margin', (n) => (n === 'margin-left' ? '2px' : '1px')),
    '1px 1px 1px 2px',
  );
  assert.equal(
    composeShorthand('padding', (n) =>
      n === 'padding-top' ? 'inherit' : '1px',
    ),
    '',
  );
});

test('an axis shorthand sets its two sides, the second the first again', () => {
  assert.deepEqual(longhandsOf('margin-inline', '1px'), {
    'margin-inline-start': '1px',
    'margin-inline-end': '1px',
  });
  assert.deepEqual(longhandsOf('inset-block', 'auto 2%'), {
    'inset-block-start': 'auto',
    'inset-block-end': '2%',
  });
  assert.equal(specifiedValue('padding-block', '3px 3px'), '3px');
  assert.deepEqual(longhandsOf('margin', 'initial'), {
    'margin-top': 'initial',
    'margin-right': 'initial',
    'margin-bottom': 'initial',
    'margin-left': 'initial',
  });
});

test('transition-property takes property names, or none alone, and nothing else', () => {
  // CSS Transitions 1, 2.1: `<single-transition-property>#`, `none` the
  // whole value, and no CSS-wide keyword or `default` among the names
  for (const bad of [
    'one two three',
    '1, 2, 3',
    'none, one',
    'top, initial',
    'inherit, top',
    'default, top',
  ]) {
    assert.strictEqual(specifiedValue('transition-property', bad), null, bad);
  }
  for (const good of ['none', 'all', 'top, left', '--x, opacity', 'inherit']) {
    assert.notStrictEqual(specifiedValue('transition-property', good), null);
  }
});

test("a 3D transform's viewer is none or a length no less than nought, and where it stands a <position>", () => {
  // CSS Transforms 2, 7.1 and 7.2, and CSS Values 4's <position>, which has
  // no three-value form; written back across first, as Chromium writes it
  for (const bad of ['1000', '-1px', '80%', 'auto']) {
    assert.strictEqual(specifiedValue('perspective', bad), null, bad);
  }
  assert.strictEqual(specifiedValue('perspective', '0'), '0px');
  assert.notStrictEqual(specifiedValue('perspective', '10em'), null);
  assert.strictEqual(
    specifiedValue('perspective-origin', 'center left 1px'),
    null,
  );
  assert.strictEqual(specifiedValue('perspective-origin', 'left right'), null);
  assert.strictEqual(specifiedValue('perspective-origin', 'top'), 'center top');
  assert.strictEqual(
    specifiedValue('perspective-origin', 'bottom 10% right 20%'),
    'right 20% bottom 10%',
  );
  assert.strictEqual(specifiedValue('backface-visibility', 'auto'), null);
  assert.strictEqual(specifiedValue('backface-visibility', 'HIDDEN'), 'hidden');
});

test('a filter list and a corner shape that the cascade would refuse are refused by a style', () => {
  // Filter Effects 1, 5 and CSS Borders 4, 3.9: kept as written where they
  // are values, and a math function left to the cascade, which clamps it
  for (const bad of [
    'blur(-1px)',
    'brightness(30px)',
    'opacity(0.5 0.5)',
    'auto',
  ]) {
    assert.strictEqual(specifiedValue('filter', bad), null, bad);
    assert.strictEqual(specifiedValue('backdrop-filter', bad), null, bad);
  }
  for (const good of [
    'none',
    'blur(2px) grayscale(50%)',
    'brightness(calc(-10%))',
  ]) {
    assert.notStrictEqual(specifiedValue('filter', good), null, good);
  }
  assert.strictEqual(specifiedValue('corner-shape', '10px'), null);
  assert.strictEqual(
    specifiedValue('corner-shape', 'round round round round round'),
    null,
  );
  assert.strictEqual(
    specifiedValue('corner-top-left-shape', 'round bevel'),
    null,
  );
  assert.notStrictEqual(
    specifiedValue('corner-shape', 'bevel superellipse(2)'),
    null,
  );
  assert.notStrictEqual(
    specifiedValue('corner-top-shape', 'scoop notch'),
    null,
  );
});

test('transform-origin is a point and a depth, written across first', () => {
  // CSS Transforms 1, 6, as Chromium writes it back
  for (const bad of [
    '1px 2px 3%',
    '1px 2px left',
    '1px 2px 3px 4px',
    '1px left',
    'top 1px',
    'right left',
    'bottom 10% right 20%',
  ]) {
    assert.strictEqual(specifiedValue('transform-origin', bad), null, bad);
  }
  assert.strictEqual(specifiedValue('transform-origin', 'top'), 'center top');
  assert.strictEqual(specifiedValue('transform-origin', '-4%'), '-4% center');
  assert.strictEqual(
    specifiedValue('transform-origin', 'bottom right 7px'),
    'right bottom 7px',
  );
  assert.strictEqual(
    specifiedValue('transform-origin', '-1px -2px -3px'),
    '-1px -2px -3px',
  );
});

test('translate takes lengths and percentages, its depth a length, and drops what moves nowhere at its end', () => {
  // CSS Transforms 2, 4.3
  for (const bad of ['100deg', '100px 200px 300%', '100px junk']) {
    assert.strictEqual(specifiedValue('translate', bad), null, bad);
  }
  assert.strictEqual(specifiedValue('translate', '0'), '0px');
  assert.strictEqual(specifiedValue('translate', '100px 0px 0px'), '100px');
  assert.strictEqual(specifiedValue('translate', '100px 0%'), '100px 0%');
  assert.strictEqual(
    specifiedValue('translate', '100px 0px 300px'),
    '100px 0px 300px',
  );
});

test('a transform list is written as Chromium writes it', () => {
  // CSS Transforms 1, 9: names in lower case, a scale's percentages as
  // numbers, a bare nought angle in degrees
  assert.strictEqual(
    specifiedValue('transform', 'scaleX(720%)'),
    'scalex(7.2)',
  );
  assert.strictEqual(
    specifiedValue('transform', 'scale3d(50%, 250%, 300%)'),
    'scale3d(0.5, 2.5, 3)',
  );
  assert.strictEqual(
    specifiedValue('transform', 'skew(0, -90deg)'),
    'skew(0deg, -90deg)',
  );
  assert.strictEqual(
    specifiedValue('transform', 'translateX(1px) rotate(0)'),
    'translateX(1px) rotate(0deg)',
  );
  assert.strictEqual(specifiedValue('transform', 'scale(1px)'), null);
});

test('animation-range sets its two ends, and each is written as Chromium writes it', () => {
  // Scroll-driven Animations 1, 5.3: a lone name runs to its own end
  assert.deepStrictEqual(expandShorthand('animation-range', 'cover'), [
    ['animation-range-start', 'cover'],
    ['animation-range-end', 'cover'],
  ]);
  assert.deepStrictEqual(
    expandShorthand('animation-range', 'normal entry 100%'),
    [
      ['animation-range-start', 'normal'],
      ['animation-range-end', 'entry'],
    ],
  );
  assert.strictEqual(
    specifiedValue('animation-range', 'entry 0% exit 0%'),
    'entry exit 0%',
  );
  assert.strictEqual(specifiedValue('animation-range', '10% normal'), '10%');
  assert.strictEqual(specifiedValue('animation-range', '1s'), null);
  assert.strictEqual(
    specifiedValue('animation-range-end', 'cover 100%'),
    'cover',
  );
  assert.strictEqual(
    composeShorthand('animation-range', (p) =>
      p === 'animation-range-start' ? 'entry' : 'entry',
    ),
    'entry',
  );
});

test('a transition sets its five longhands, and is written back from them', () => {
  // CSS Transitions 1, 2 and 2, 2.1: what the cascade refuses is refused
  for (const bad of ['1s 2s 3s', 'none, top', '-1s']) {
    assert.strictEqual(specifiedValue('transition', bad), null, bad);
  }
  assert.strictEqual(specifiedValue('transition-duration', '-1s'), null);
  assert.strictEqual(
    specifiedValue('transition-timing-function', 'steps(2, end)'),
    'steps(2)',
  );
  assert.strictEqual(
    specifiedValue('transition', 'allow-discrete display 3s'),
    'display 3s allow-discrete',
  );
  assert.deepStrictEqual(
    Object.fromEntries(
      expandShorthand('transition', '1s -3s, cubic-bezier(0, -2, 1, 3) top') ??
        [],
    ),
    {
      'transition-property': 'all, top',
      'transition-duration': '1s, 0s',
      'transition-timing-function': 'ease, cubic-bezier(0, -2, 1, 3)',
      'transition-delay': '-3s, 0s',
      'transition-behavior': 'normal, normal',
    },
  );
});
