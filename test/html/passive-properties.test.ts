// The properties a style holds and reads back that nothing here lays out or
// paints by yet (`src/html/css/passive-properties.ts`): `el.style` takes
// each only as its grammar does, an inherited one passes to the children,
// and `getComputedStyle` and Typed OM read them. WPT's
// `css-typed-om/the-stylepropertymap/properties/` holds the rest.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { specifiedValue } from '../../src/html/css/specified.js';
import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

nodeTest(
  'each passive property takes its grammar, in its canonical form',
  () => {
    const cases: [string, string, string | null][] = [
      ['resize', 'Both', 'both'],
      ['resize', 'up', null],
      ['text-underline-position', 'right under', 'under right'],
      ['scrollbar-gutter', 'both-edges stable', 'stable both-edges'],
      [
        'white-space-trim',
        'discard-inner discard-before',
        'discard-before discard-inner',
      ],
      ['background-blend-mode', 'multiply, SCREEN', 'multiply, screen'],
      ['background-blend-mode', 'multiply, up', null],
      ['column-height', '-1px', null],
      ['offset-rotate', 'reverse 30deg', 'reverse 30deg'],
      ['page', 'default', null],
    ];
    for (const [name, value, expected] of cases) {
      assert.equal(specifiedValue(name, value), expected, `${name}: ${value}`);
    }
  },
);

test('a passive property computes as it was set, an inherited one in the children, and reads at its initial value otherwise', async () => {
  const page = await scriptedPage(
    `<div id="a" style="hyphens: auto; resize: both"><p id="b"></p></div><script>
    var a = document.getElementById('a'), b = document.getElementById('b');
    console.log('out ' + JSON.stringify([
      getComputedStyle(a).hyphens, getComputedStyle(b).hyphens,
      getComputedStyle(a).resize, getComputedStyle(b).resize,
      getComputedStyle(b).scrollBehavior,
      b.computedStyleMap().get('hyphens').toString(),
      (b.style.resize = 'nonsense', b.style.resize),
    ]));
    </script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  assert.deepEqual(out, ['auto', 'auto', 'both', 'none', 'auto', 'auto', '']);
});
