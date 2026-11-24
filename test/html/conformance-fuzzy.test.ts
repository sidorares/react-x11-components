// What a reftest's `fuzzy` annotation allows, as the runners read it
// (`scripts/conformance/fuzzy.ts`).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fuzzyOf } from '../../scripts/conformance/fuzzy.js';

test("a fuzzy annotation is read whether or not its attributes' values are quoted", () => {
  // WPT's css-images/gradient/gradient-powerless-hue-lch writes
  // `name=fuzzy`, which was read as no annotation, and a difference it
  // allows failed the test
  const allows = { maxDifference: 1, totalPixels: 1500 };
  for (const tag of [
    '<meta name="fuzzy" content="maxDifference=1;totalPixels=0-1500">',
    "<meta name='fuzzy' content='maxDifference=1;totalPixels=0-1500'>",
    '<meta name=fuzzy content="maxDifference=1;totalPixels=0-1500">',
    '<meta content="maxDifference=0-1;totalPixels=1500" name=fuzzy>',
    '<meta name=fuzzy content=maxDifference=1;totalPixels=0-1500>',
    '<meta name=fuzzy content="1;0-1500"/>',
  ]) {
    assert.deepStrictEqual(fuzzyOf(tag), allows, tag);
  }
  // a name that only starts so is no fuzzy annotation
  assert.deepStrictEqual(
    fuzzyOf('<meta name=fuzzyish content="maxDifference=1;totalPixels=9">'),
    { maxDifference: 0, totalPixels: 0 },
  );
  // and one for a named reference counts only against it
  const named =
    '<meta name=fuzzy content="a-ref.html:maxDifference=2;totalPixels=7">';
  assert.deepStrictEqual(fuzzyOf(named, 'x/a-ref.html'), {
    maxDifference: 2,
    totalPixels: 7,
  });
  assert.deepStrictEqual(fuzzyOf(named, 'x/b-ref.html'), {
    maxDifference: 0,
    totalPixels: 0,
  });
});
