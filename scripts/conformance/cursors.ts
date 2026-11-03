// Writes `test/html/cursors.ts`: the `cursor` each element of one document
// computes to, as Chromium reads it:
//
//   CHROME=<chromium> node --import tsx scripts/conformance/cursors.ts
//
// Every value is Chromium's, none of them written by hand. The page's cursor
// is `wait`, so that an element no rule reaches shows as inheriting it, and
// an element the UA sheet stops it at shows what the sheet gives it.
//
// Firefox and WebKit differ, and `docs/components/html.md` says where: all
// three stop the page's cursor at a control, and WebKit reads `auto` at most
// of them, which its hit test turns into what Chromium's sheet names. Chromium
// is the baseline, as `test/html/control-states.ts` has it.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chrome } from '../zengarden/chrome.js';

const FIXTURE = new URL('../../test/html/cursors.ts', import.meta.url);

const TYPES = [
  'text',
  'search',
  'tel',
  'url',
  'email',
  'password',
  'number',
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'color',
  'file',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
  'range',
  'image',
  'hidden',
];

const inputs = TYPES.flatMap((type) =>
  [
    ['', ''],
    ['-d', ' disabled'],
    ['-r', ' readonly'],
  ].map(
    ([suffix, attribute]) =>
      `<input id=input-${type}${suffix} type=${type}${attribute}>`,
  ),
).join('\n');

const document = String.raw`<!doctype html><meta charset=utf-8>
<style>body { cursor: wait; }
#fsb-own::file-selector-button { cursor: help; }
#fsb-webkit::-webkit-file-upload-button { cursor: move; }
#fsb-disabled:disabled::file-selector-button { cursor: not-allowed; }
.own { cursor: crosshair; }</style>
<body>
<a id=a>x</a><a id=a-href href="#x">x<b id=a-href-in>y</b></a><span id=span>x</span>
<label id=label>x<span id=label-span>y</span><a id=label-a href="#x">z</a></label>
<a href="#x"><button id=button-in-a>x</button><input id=input-in-a><label id=label-in-a>x</label></a>
<button id=button>x<span id=button-span>y</span><a id=button-a href="#x">z</a></button><button id=button-d disabled>x</button>
<select id=select><option id=option>a<optgroup id=optgroup label=g><option id=option-og>b</optgroup></select><select id=select-d disabled><option id=option-sd>a</select>
<select id=select-m multiple><option id=option-m>a<option id=option-md disabled>b</select><select id=select-m-d multiple disabled></select>
<textarea id=textarea></textarea><textarea id=textarea-d disabled></textarea><textarea id=textarea-r readonly></textarea>
<details id=details><summary id=summary>x<span id=summary-span>y</span></summary></details>
<meter id=meter></meter><progress id=progress></progress><output id=output>x</output>
<fieldset id=fieldset>x<legend id=legend-on>l</legend></fieldset>
<fieldset id=fieldset-d disabled><legend id=legend>l<input id=fs-leg-input><button id=fs-leg-button>b</button></legend><legend id=legend-2><input id=fs-leg2-input></legend><input id=fs-input><input id=fs-check type=checkbox><input id=fs-image type=image><button id=fs-button>b</button><textarea id=fs-textarea></textarea><select id=fs-select><option id=fs-option>a</select><label id=fs-label>x</label><a id=fs-a href="#y">x</a></fieldset>
<fieldset id=fieldset-outer disabled><fieldset id=fieldset-inner><legend><input id=fs-inner-input></legend></fieldset></fieldset>
<img id=img usemap=#m src="data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA="><map id=map name=m><area id=area href="#y" shape=rect coords=0,0,1,1><area id=area-n shape=rect coords=0,0,1,1></map>
<dialog id=dialog open>x</dialog><iframe id=iframe></iframe><video id=video controls></video><audio id=audio controls></audio><canvas id=canvas></canvas><object id=object></object><embed id=embed>
<svg id=svg><a id=svg-a href="#z"><text id=svg-text>x</text></a></svg>
<div id=ce contenteditable>x</div>
<input id=input-none><input id=input-empty type=""><input id=input-unknown type=foo><input id=input-upper type=TEXT><input id=input-hidden-upper type=HIDDEN><input id=input-check-upper type=CHECKBOX><input id=input-image-upper type=IMAGE>
<input id=own-text class=own><input id=own-text-d class=own disabled><input id=own-check class=own type=checkbox><button id=own-button class=own>x</button><select id=own-select class=own></select><textarea id=own-textarea class=own></textarea><input id=own-range class=own type=range><input id=own-file class=own type=file><label id=own-label class=own>x</label><option id=own-option class=own>x</option>
<input id=fsb-own type=file><input id=fsb-webkit type=file><input id=fsb-disabled type=file disabled><input id=fsb-text>
${inputs}
`;

/** Each element whose `::file-selector-button` is asked for. */
const BUTTONS = [
  'input-file',
  'input-file-d',
  'fsb-own',
  'fsb-webkit',
  'fsb-disabled',
];

const page = join(tmpdir(), `cursors-${process.pid}.html`);
writeFileSync(page, document);
const chrome = await Chrome.launch();
try {
  const { targetId } = (await chrome.send('Target.createTarget', {
    url: pathToFileURL(page).href,
  })) as { targetId: string };
  const { sessionId } = (await chrome.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  })) as { sessionId: string };
  const expression = `new Promise((done) => {
    const read = () => {
      const table = [];
      for (const el of document.querySelectorAll('[id]')) {
        table.push([el.id, getComputedStyle(el).cursor]);
      }
      for (const id of ${JSON.stringify(BUTTONS)}) {
        const el = document.getElementById(id);
        table.push([
          id + '::file-selector-button',
          getComputedStyle(el, '::file-selector-button').cursor,
        ]);
      }
      done(JSON.stringify(table));
    };
    // the target starts on a blank page, which is complete already
    const ready = () =>
      document.readyState === 'complete' && document.getElementById('input-hidden-r')
        ? read()
        : setTimeout(ready, 10);
    ready();
  })`;
  // and going from it to the document ends what was asked of it
  const evaluate = async (): Promise<{ result: { value: string } }> => {
    for (;;) {
      try {
        return (await chrome.send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
        )) as { result: { value: string } };
      } catch (error) {
        if (!/context|navigated/i.test(String(error))) throw error;
      }
    }
  };
  const { result } = await evaluate();
  const table = JSON.parse(result.value) as [string, string][];
  const { product } = (await chrome.send('Browser.getVersion')) as {
    product: string;
  };
  const version = product.match(/\/(\d+)/)![1];
  writeFileSync(
    FIXTURE,
    `// The \`cursor\` each element of this document computes to, as Chromium
// ${version} reads it, none of them written by hand:
// \`scripts/conformance/cursors.ts\` writes this file. The page's cursor is
// \`wait\`, so that an element no rule reaches shows as inheriting it.

export const CURSOR_DOCUMENT = String.raw\`${document}\`;

/** Each element by its id, a file input's button under the pseudo-element's
 *  name after it, and the cursor it computes to, in the order above. */
export const CHROME_CURSORS: Record<string, string> = {
${table.map(([id, cursor]) => `  ${JSON.stringify(id)}: ${JSON.stringify(cursor)},`).join('\n')}
};
`,
  );
} finally {
  await chrome.close();
}
