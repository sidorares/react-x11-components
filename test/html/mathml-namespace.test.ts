// <Html scripts>' elements of MathML as the HTML parser makes them (HTML
// 13.2.6.5): a `<math>` and what it holds are MathML's, a `MathMLElement`,
// but where an HTML integration point holds HTML; and an `<svg>` is SVG's
// from its own tag. WPT's `mathml/relations/html5-tree/` and the html5lib
// tree-construction tests that spell out each element's namespace.
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
    `${body}<script>
     var out;
     try { out = (function () {${code}})(); } catch (e) { out = 'threw ' + e; }
     console.log('out ' + JSON.stringify(out));
     </script>`,
  );
  const out = JSON.parse(await page.until('out'));
  page.result.unmount();
  return out;
}

const MATHML = 'http://www.w3.org/1998/Math/MathML';

test('what the parser makes in a <math> is MathML’s, but HTML at an integration point', async () => {
  const out = await inPage(
    `<math id="m"><mi id="mi">x</mi><mtext><b id="b">t</b></mtext>
       <annotation-xml encoding="text/html"><p id="p">h</p></annotation-xml>
       <annotation-xml><mi id="inner"></mi></annotation-xml></math>
     <svg id="s"><circle id="c"/></svg>`,
    `var ns = function (id) {
       var el = document.getElementById(id);
       return [el.namespaceURI, el.constructor.name];
     };
     return [ns('m'), ns('mi'), ns('b'), ns('p'), ns('inner'), ns('s'), ns('c')];`,
  );
  assert.deepEqual(out, [
    [MATHML, 'MathMLElement'],
    [MATHML, 'MathMLElement'],
    ['http://www.w3.org/1999/xhtml', 'HTMLElement'],
    ['http://www.w3.org/1999/xhtml', 'HTMLParagraphElement'],
    [MATHML, 'MathMLElement'],
    ['http://www.w3.org/2000/svg', 'SVGSVGElement'],
    ['http://www.w3.org/2000/svg', 'SVGCircleElement'],
  ]);
});

test('a MathMLElement has a style, a dataset, focus and its handlers', async () => {
  const out = await inPage(
    `<math id="m" data-x="1" onclick="window.clicked = true"></math>`,
    `var m = document.getElementById('m');
     var made = document.createElementNS('${MATHML}', 'mrow');
     m.style.color = 'red';
     m.dispatchEvent(new Event('click'));
     return [made instanceof MathMLElement, m.style.color, m.dataset.x,
       typeof m.focus, m.tabIndex, made.onclick, typeof m.onclick,
       window.clicked === true, 'onclick' in Element.prototype,
       m instanceof HTMLElement, document.createElement('math').namespaceURI];`,
  );
  assert.deepEqual(out, [
    true,
    'red',
    '1',
    'function',
    -1,
    null,
    'function',
    true,
    false,
    false,
    'http://www.w3.org/1999/xhtml',
  ]);
});
