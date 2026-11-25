// <Html> — where a line may break beside an atomic inline (CSS Text 3,
// 5.1): before and after every one, for the Web's sake, even beside a
// character that would keep two letters together, but for UAX #14's GL, WJ
// and ZWJ classes other than U+00A0 NO-BREAK SPACE. WPT's
// `css/css-text/line-breaking/line-breaking-atomic-*` hold the rest.
import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import { act, cleanup } from 'react-x11/test';

import { findById, metric, render, view } from './harness.js';

afterEach(cleanup);

/** Whether two elements of a page are on one line: their tops meet. */
async function sameLine(source: string): Promise<boolean> {
  const { node } = await render(
    '<style>body{margin:0} div{font:20px monospace;width:2ch}' +
      'i{display:inline-block;font-style:normal}</style>' +
      source,
  );
  const el = view(node);
  await act();
  const top = (id: string) => el.elementRect(findById(el.document, id)!)!.y;
  return Math.abs(top('a') - top('b')) < 1;
}

metric(
  'a word joiner, a narrow no-break space or a zero width joiner keeps an atomic inline beside the text before it',
  async () => {
    for (const glue of ['&#x2060;', '&#x202F;', '&#x200D;', '&#x2011;']) {
      assert.ok(
        await sameLine(
          `<div><span id="a">AB${glue}</span><i id="b">C</i></div>`,
        ),
        `${glue}: no break before the inline-block`,
      );
      cleanup();
    }
    // a no-break space is no such character, and the line breaks after it
    assert.ok(
      !(await sameLine(
        '<div><span id="a">AB&nbsp;</span><i id="b">C</i></div>',
      )),
      'a break after a no-break space',
    );
  },
);

metric(
  'and the text after an atomic inline beside it, where the text starts with one',
  async () => {
    for (const glue of ['&#x2060;', '&#xFEFF;', '&#x2007;']) {
      assert.ok(
        await sameLine(
          `<div><i id="a">AB</i><span id="b">${glue}C</span></div>`,
        ),
        `${glue}: no break after the inline-block`,
      );
      cleanup();
    }
    assert.ok(
      !(await sameLine('<div><i id="a">AB</i><span id="b">C</span></div>')),
      'a break after the inline-block',
    );
  },
);

// A shrink-to-fit box is as wide as its line's content, and the sum of the
// pieces comes to its width only to the last bit: a link's text and the icon
// after it (Docusaurus's navbar "GitHub ↗") wrapped the icon below the text
// on a Mac, where the box was 140.9885154724121 wide and its content the
// same number a bit more. A word fits a line a 64th of a pixel over
// (`FIT_SLACK`), and an atomic inline has to as well.
metric(
  'an atomic inline fits a line it overruns by less than a 64th of a pixel',
  async () => {
    const { node } = await render(
      '<style>body{margin:0} div{width:100px;font:20px monospace}' +
        'i{display:inline-block;width:100.01px;height:10px}</style>' +
        '<div><i id="a"></i></div><div>' +
        '<i id="b" style="width:50px"></i><i id="c" style="width:50.01px"></i>' +
        '</div><div><i id="d" style="width:50px"></i>' +
        '<i id="e" style="width:50.5px"></i></div>',
    );
    const el = view(node);
    await act();
    const top = (id: string) => el.elementRect(findById(el.document, id)!)!.y;
    assert.ok(Math.abs(top('b') - top('c')) < 1, 'within the slack: one line');
    assert.ok(Math.abs(top('d') - top('e')) > 1, 'past it: wraps');
  },
);
