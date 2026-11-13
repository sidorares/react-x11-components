// <Html scripts>' ARIA element references (HTML 2.6.1, reflecting
// `Element?` and `FrozenArray<Element>?`): `ariaActiveDescendantElement`
// and the seven `aria…Elements`, which WPT's
// `html/dom/aria-element-reflection*.html` hold a page to.
import assert from 'node:assert/strict';
import { afterEach, test as nodeTest } from 'node:test';
import { cleanup } from 'react-x11/test';

import { preloadHtmlScripts } from '../../src/html/index.js';
import { SCRIPTS_CONTAINED } from '../../src/html/scripts/engine.js';
import { scriptedPage } from './harness.js';

afterEach(cleanup);
await preloadHtmlScripts();

const test = SCRIPTS_CONTAINED ? nodeTest : nodeTest.skip;

/** What a function of the page's comes to, through JSON. */
async function inPage(body: string, code: string): Promise<unknown> {
  const page = await scriptedPage(
    `${body}<script>console.log("out " + JSON.stringify((function () {${code}})()));</script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

test('a reference is read from the content attribute, or from what was set', async () => {
  const out = await inPage(
    `<div id="box" aria-activedescendant="i1"><div id="i1"></div><div id="i2"></div></div>`,
    `var box = document.getElementById('box');
     var i1 = document.getElementById('i1'), i2 = document.getElementById('i2');
     var out = [box.ariaActiveDescendantElement === i1];
     box.setAttribute('aria-activedescendant', 'i2');
     out.push(box.ariaActiveDescendantElement === i2);
     box.ariaActiveDescendantElement = i1;
     out.push(box.getAttribute('aria-activedescendant'),
       box.ariaActiveDescendantElement === i1);
     box.setAttribute('aria-activedescendant', 'i2');
     out.push(box.ariaActiveDescendantElement === i2);
     box.ariaActiveDescendantElement = null;
     out.push(box.hasAttribute('aria-activedescendant'),
       box.ariaActiveDescendantElement);
     try { box.ariaActiveDescendantElement = 'i1'; } catch (e) {
       out.push(e instanceof TypeError);
     }
     return out;`,
  );
  assert.deepEqual(out, [true, true, '', true, true, false, null, true]);
});

test('a list of references is one frozen array while it holds the same', async () => {
  const out = await inPage(
    `<div id="box" aria-labelledby="a  b missing"></div><span id="a"></span><span id="b"></span>`,
    `var box = document.getElementById('box');
     var a = document.getElementById('a'), b = document.getElementById('b');
     var first = box.ariaLabelledByElements;
     var out = [first.length, first[0] === a, first[1] === b,
       Object.isFrozen(first), box.ariaLabelledByElements === first];
     box.ariaLabelledByElements = [b];
     var second = box.ariaLabelledByElements;
     out.push(second !== first, second[0] === b,
       box.getAttribute('aria-labelledby'), box.ariaDescribedByElements);
     b.remove();
     out.push(box.ariaLabelledByElements.length);
     document.body.append(b);
     out.push(box.ariaLabelledByElements[0] === b);
     return out;`,
  );
  assert.deepEqual(out, [
    2,
    true,
    true,
    true,
    true,
    true,
    true,
    '',
    null,
    0,
    true,
  ]);
});

test('a reference into a shadow tree is not seen, one out of it is', async () => {
  const out = await inPage(
    `<p id="light"></p><span id="host"></span>`,
    `var light = document.getElementById('light');
     var root = document.getElementById('host').attachShadow({ mode: 'open' });
     var link = document.createElement('a');
     root.append(link);
     light.ariaActiveDescendantElement = link;
     link.ariaActiveDescendantElement = light;
     return [light.ariaActiveDescendantElement,
       link.ariaActiveDescendantElement === light];`,
  );
  assert.deepEqual(out, [null, true]);
});
