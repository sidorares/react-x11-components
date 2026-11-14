// Trusted Types: the policies, the types they make, and the sinks
// require-trusted-types-for holds to them.

import assert from 'node:assert/strict';
import { LISTEN, policed, scripted } from './csp-harness.js';

scripted(
  'Trusted Types: a policy makes each type from its callbacks, a value is told apart by what made it, and trusted-types holds the names',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="trusted-types one 'allow-duplicates' default">${LISTEN}`,
      `<script nonce="n">
      var out = [];
      var p = trustedTypes.createPolicy('one', { createHTML: function (s, x) { return s + x; },
        createScriptURL: function () { return null; } });
      var html = p.createHTML('<b>', '!');
      out.push(p.name, String(html), trustedTypes.isHTML(html), trustedTypes.isScript(html),
        JSON.stringify({ h: html }), String(p.createScriptURL('x')),
        Object.prototype.toString.call(html), trustedTypes.isHTML('<b>!'));
      try { p.createScript('x'); } catch (e) { out.push(e.name); }
      try { new TrustedHTML(); } catch (e) { out.push(e.name); }
      trustedTypes.createPolicy('one', {});
      try { trustedTypes.createPolicy('two', {}); } catch (e) { out.push('two ' + e.name); }
      var d = trustedTypes.createPolicy('default', {});
      out.push(trustedTypes.defaultPolicy === d);
      out.push(trustedTypes.getAttributeType('IMG', 'onerror'), trustedTypes.getAttributeType('script', 'src'),
        trustedTypes.getAttributeType('div', 'data-x'), trustedTypes.getPropertyType('div', 'innerHTML'),
        trustedTypes.emptyHTML === trustedTypes.emptyHTML, String(trustedTypes.emptyScript));
      setTimeout(function () {
        out.push(JSON.stringify(seen.map(function (s) { return [s[0], s[1], s[8]]; })));
        console.log('out ' + out.join('|'));
      }, 50);
    </script>`,
    );
    assert.equal(
      await page.until('out'),
      [
        'one',
        '<b>!',
        'true',
        'false',
        '{"h":"<b>!"}',
        '',
        '[object TrustedHTML]',
        'false',
        'TypeError',
        'TypeError',
        'two TypeError',
        'true',
        'TrustedScript',
        'TrustedScriptURL',
        '',
        'TrustedHTML',
        'true',
        '',
        JSON.stringify([['trusted-types-policy', 'trusted-types', 'two']]),
      ].join('|'),
    );
    page.unmount();
  },
);

scripted(
  'require-trusted-types-for: a sink takes what a policy made, the default policy makes the rest, and a string none made is refused',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'">${LISTEN}`,
      `<div id="d"></div><script nonce="n">
      var out = [], d = document.getElementById('d');
      var p = trustedTypes.createPolicy('p', { createHTML: function (s) { return s; } });
      d.innerHTML = p.createHTML('<b>made</b>');
      out.push(d.innerHTML);
      try { d.innerHTML = '<i>plain</i>'; } catch (e) { out.push(e.name); }
      out.push(d.innerHTML);
      trustedTypes.createPolicy('default', { createHTML: function (s, type, sink) {
        return s.indexOf('bad') < 0 ? s + ' ' + type + ' ' + sink : null; } });
      d.innerHTML = 'ok';
      out.push(d.textContent);
      try { d.insertAdjacentHTML('beforeend', 'bad'); } catch (e) { out.push(e.name); }
      var s = document.createElement('script');
      try { s.text = 'x()'; } catch (e) { out.push('script ' + e.name); }
      var q = trustedTypes.createPolicy('q', { createScript: function (s) { return s; } });
      s.textContent = q.createScript('a()');
      s.innerText = q.createScript('b()');
      out.push(s.textContent);
      try { s.textContent = 'y()'; } catch (e) { out.push('textContent ' + e.name); }
      try { s.setAttribute('src', '/a.js'); } catch (e) { out.push('src ' + e.name); }
      // an empty value toggled on is no sink's, and tells nothing
      d.toggleAttribute('onclick');
      out.push('toggled ' + d.hasAttribute('onclick'));
      setTimeout(function () {
        out.push(JSON.stringify(seen.map(function (v) { return [v[0], v[1], v[8]]; })));
        console.log('out ' + out.join('|'));
      }, 50);
    </script>`,
    );
    assert.equal(
      await page.until('out'),
      [
        '<b>made</b>',
        'TypeError',
        '<b>made</b>',
        'ok TrustedHTML Element innerHTML',
        'TypeError',
        'script TypeError',
        'b()',
        'textContent TypeError',
        'src TypeError',
        'toggled true',
        JSON.stringify([
          [
            'trusted-types-sink',
            'require-trusted-types-for',
            'Element innerHTML|<i>plain</i>',
          ],
          [
            'trusted-types-sink',
            'require-trusted-types-for',
            'Element insertAdjacentHTML|bad',
          ],
          [
            'trusted-types-sink',
            'require-trusted-types-for',
            'HTMLScriptElement text|x()',
          ],
          [
            'trusted-types-sink',
            'require-trusted-types-for',
            'HTMLScriptElement textContent|y()',
          ],
          [
            'trusted-types-sink',
            'require-trusted-types-for',
            'HTMLScriptElement src|/a.js',
          ],
        ]),
      ].join('|'),
    );
    page.unmount();
  },
);

scripted(
  'require-trusted-types-for: eval runs a TrustedScript, and a string only as the default policy makes it, unchanged',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'">`,
      `<script>
      var out = [];
      var p = trustedTypes.createPolicy('p', { createScript: function (s) { return s; } });
      out.push(eval(p.createScript('1 + 1')));
      try { eval('2 + 2'); } catch (e) { out.push(e.name); }
      trustedTypes.createPolicy('default', { createScript: function (s) {
        return s.indexOf('change') < 0 ? s : 'changed'; } });
      out.push(eval('3 + 3'));
      try { eval('"change"'); } catch (e) { out.push(e.name); }
      console.log('out ' + out.join('|'));
    </script>`,
    );
    assert.equal(await page.until('out'), '2|EvalError|6|EvalError');
    page.unmount();
  },
);
