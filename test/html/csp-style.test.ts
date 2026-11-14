// Inline style a document's policy refuses: no sheet and no declarations,
// and only what the parser met after a <meta> policy held back.

import assert from 'node:assert/strict';
import { policed, scripted } from './csp-harness.js';

scripted(
  'inline style a policy refuses makes no sheet and no declarations, and what CSSOM writes after does',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="style-src 'none'">`,
      `<style id="s">p { color: red }</style>
     <div id="d" style="color: red; width: 3px"></div>
     <script>
       var d = document.getElementById('d');
       var out = [document.styleSheets.length, document.getElementById('s').sheet,
         d.style.length, d.getAttribute('style')];
       d.style.color = 'blue';
       out.push(d.style.length, d.style.color);
       console.log('out ' + out.join('|'));
     </script>`,
    );
    assert.equal(await page.until('out'), '0||0|color: red; width: 3px|1|blue');
    page.unmount();
  },
);

scripted(
  'a <meta> policy holds back the inline style the parser meets after it, and none it met before',
  async () => {
    const page = await policed(
      `<title id="t" style="color: red">x</title><style id="early">p { color: red }</style>
      <meta http-equiv="Content-Security-Policy" content="style-src 'none'">
      <style id="late">p { color: blue }</style>`,
      `<p id="p" style="color: green">x</p>
      <script>
        console.log('out ' + [document.getElementById('t').style.length,
          !!document.getElementById('early').sheet, !!document.getElementById('late').sheet,
          document.getElementById('p').style.length].join('|'));
      </script>`,
    );
    assert.equal(await page.until('out'), '1|true|false|0');
    page.unmount();
  },
);
