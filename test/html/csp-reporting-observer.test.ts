// A document's violations as reports a ReportingObserver hears.

import assert from 'node:assert/strict';
import { PAGE_URL, policed, scripted } from './csp-harness.js';

scripted(
  'a violation is a report every ReportingObserver of its type hears, its body a plain object, and a buffered one hears what came before it',
  async () => {
    const page = await policed(
      `<meta http-equiv="Content-Security-Policy" content="img-src 'none'">`,
      `<script>
       var out = [];
       new ReportingObserver(function (reports, observer) {
         var r = reports[0];
         out.push(reports.length, r.type, r.url, Object.keys(r.body).join(','),
           r.body.blockedURL, r.body.sourceFile, r.body.lineNumber,
           Object.getPrototypeOf(r.body) === Object.prototype, observer instanceof ReportingObserver);
         new ReportingObserver(function (later) { out.push('buffered ' + later.length);
           console.log('out ' + out.join('|')); }, { buffered: true }).observe();
       }, { types: ['csp-violation'] }).observe();
       new ReportingObserver(function () { out.push('other type'); }, { types: ['deprecation'] }).observe();
     </script>
     <img src="https://example.test/a.png">`,
    );
    assert.equal(
      await page.until('out'),
      [
        1,
        'csp-violation',
        PAGE_URL,
        'blockedURL,columnNumber,disposition,documentURL,effectiveDirective,lineNumber,originalPolicy,referrer,sample,sourceFile,statusCode',
        'https://example.test/a.png',
        '',
        '',
        'true',
        'true',
        'buffered 1',
      ].join('|'),
    );
    page.unmount();
  },
);
