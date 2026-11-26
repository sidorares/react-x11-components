import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RepaintWatch } from '../../src/html/repaint-watch.js';

// the module reads its limit from the environment once, so the class is
// driven directly; its default limit is 20 paints a second
test('a cell painted twenty times in a second is reported once', () => {
  const watch = new RepaintWatch(20);
  const rect = { x: 10, y: 10, width: 50, height: 50 };
  let said = 0;
  for (let i = 0; i < 40; i += 1) {
    if (watch.note(rect, i * 20)) said += 1;
  }
  assert.equal(said, 1);
});

test('paints spread over a few seconds are not reported', () => {
  const watch = new RepaintWatch(20);
  const rect = { x: 0, y: 0, width: 64, height: 64 };
  for (let i = 0; i < 100; i += 1) {
    assert.equal(watch.note(rect, i * 200), null);
  }
});
