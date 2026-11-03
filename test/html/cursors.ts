// The `cursor` each element of this document computes to, as Chromium
// 151 reads it, none of them written by hand:
// `scripts/conformance/cursors.ts` writes this file. The page's cursor is
// `wait`, so that an element no rule reaches shows as inheriting it.

export const CURSOR_DOCUMENT = String.raw`<!doctype html><meta charset=utf-8>
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
<input id=input-text type=text>
<input id=input-text-d type=text disabled>
<input id=input-text-r type=text readonly>
<input id=input-search type=search>
<input id=input-search-d type=search disabled>
<input id=input-search-r type=search readonly>
<input id=input-tel type=tel>
<input id=input-tel-d type=tel disabled>
<input id=input-tel-r type=tel readonly>
<input id=input-url type=url>
<input id=input-url-d type=url disabled>
<input id=input-url-r type=url readonly>
<input id=input-email type=email>
<input id=input-email-d type=email disabled>
<input id=input-email-r type=email readonly>
<input id=input-password type=password>
<input id=input-password-d type=password disabled>
<input id=input-password-r type=password readonly>
<input id=input-number type=number>
<input id=input-number-d type=number disabled>
<input id=input-number-r type=number readonly>
<input id=input-checkbox type=checkbox>
<input id=input-checkbox-d type=checkbox disabled>
<input id=input-checkbox-r type=checkbox readonly>
<input id=input-radio type=radio>
<input id=input-radio-d type=radio disabled>
<input id=input-radio-r type=radio readonly>
<input id=input-button type=button>
<input id=input-button-d type=button disabled>
<input id=input-button-r type=button readonly>
<input id=input-submit type=submit>
<input id=input-submit-d type=submit disabled>
<input id=input-submit-r type=submit readonly>
<input id=input-reset type=reset>
<input id=input-reset-d type=reset disabled>
<input id=input-reset-r type=reset readonly>
<input id=input-color type=color>
<input id=input-color-d type=color disabled>
<input id=input-color-r type=color readonly>
<input id=input-file type=file>
<input id=input-file-d type=file disabled>
<input id=input-file-r type=file readonly>
<input id=input-date type=date>
<input id=input-date-d type=date disabled>
<input id=input-date-r type=date readonly>
<input id=input-datetime-local type=datetime-local>
<input id=input-datetime-local-d type=datetime-local disabled>
<input id=input-datetime-local-r type=datetime-local readonly>
<input id=input-month type=month>
<input id=input-month-d type=month disabled>
<input id=input-month-r type=month readonly>
<input id=input-time type=time>
<input id=input-time-d type=time disabled>
<input id=input-time-r type=time readonly>
<input id=input-week type=week>
<input id=input-week-d type=week disabled>
<input id=input-week-r type=week readonly>
<input id=input-range type=range>
<input id=input-range-d type=range disabled>
<input id=input-range-r type=range readonly>
<input id=input-image type=image>
<input id=input-image-d type=image disabled>
<input id=input-image-r type=image readonly>
<input id=input-hidden type=hidden>
<input id=input-hidden-d type=hidden disabled>
<input id=input-hidden-r type=hidden readonly>
`;

/** Each element by its id, a file input's button under the pseudo-element's
 *  name after it, and the cursor it computes to, in the order above. */
export const CHROME_CURSORS: Record<string, string> = {
  a: 'wait',
  'a-href': 'pointer',
  'a-href-in': 'pointer',
  span: 'wait',
  label: 'default',
  'label-span': 'default',
  'label-a': 'pointer',
  'button-in-a': 'default',
  'input-in-a': 'text',
  'label-in-a': 'default',
  button: 'default',
  'button-span': 'default',
  'button-a': 'pointer',
  'button-d': 'default',
  select: 'default',
  option: 'default',
  optgroup: 'default',
  'option-og': 'default',
  'select-d': 'default',
  'option-sd': 'default',
  'select-m': 'default',
  'option-m': 'default',
  'option-md': 'default',
  'select-m-d': 'default',
  textarea: 'text',
  'textarea-d': 'default',
  'textarea-r': 'text',
  details: 'wait',
  summary: 'wait',
  'summary-span': 'wait',
  meter: 'wait',
  progress: 'wait',
  output: 'wait',
  fieldset: 'wait',
  'legend-on': 'wait',
  'fieldset-d': 'wait',
  legend: 'wait',
  'fs-leg-input': 'text',
  'fs-leg-button': 'default',
  'legend-2': 'wait',
  'fs-leg2-input': 'default',
  'fs-input': 'default',
  'fs-check': 'default',
  'fs-image': 'default',
  'fs-button': 'default',
  'fs-textarea': 'default',
  'fs-select': 'default',
  'fs-option': 'default',
  'fs-label': 'default',
  'fs-a': 'pointer',
  'fieldset-outer': 'wait',
  'fieldset-inner': 'wait',
  'fs-inner-input': 'default',
  img: 'wait',
  map: 'wait',
  area: 'pointer',
  'area-n': 'wait',
  dialog: 'wait',
  iframe: 'wait',
  video: 'wait',
  audio: 'wait',
  canvas: 'wait',
  object: 'wait',
  embed: 'wait',
  svg: 'wait',
  'svg-a': 'pointer',
  'svg-text': 'pointer',
  ce: 'wait',
  'input-none': 'text',
  'input-empty': 'text',
  'input-unknown': 'text',
  'input-upper': 'text',
  'input-hidden-upper': 'default',
  'input-check-upper': 'default',
  'input-image-upper': 'pointer',
  'own-text': 'crosshair',
  'own-text-d': 'crosshair',
  'own-check': 'crosshair',
  'own-button': 'crosshair',
  'own-select': 'crosshair',
  'own-textarea': 'crosshair',
  'own-range': 'crosshair',
  'own-file': 'crosshair',
  'own-label': 'crosshair',
  'own-option': 'crosshair',
  'fsb-own': 'default',
  'fsb-webkit': 'default',
  'fsb-disabled': 'default',
  'fsb-text': 'text',
  'input-text': 'text',
  'input-text-d': 'default',
  'input-text-r': 'text',
  'input-search': 'text',
  'input-search-d': 'default',
  'input-search-r': 'text',
  'input-tel': 'text',
  'input-tel-d': 'default',
  'input-tel-r': 'text',
  'input-url': 'text',
  'input-url-d': 'default',
  'input-url-r': 'text',
  'input-email': 'text',
  'input-email-d': 'default',
  'input-email-r': 'text',
  'input-password': 'text',
  'input-password-d': 'default',
  'input-password-r': 'text',
  'input-number': 'text',
  'input-number-d': 'default',
  'input-number-r': 'text',
  'input-checkbox': 'default',
  'input-checkbox-d': 'default',
  'input-checkbox-r': 'default',
  'input-radio': 'default',
  'input-radio-d': 'default',
  'input-radio-r': 'default',
  'input-button': 'default',
  'input-button-d': 'default',
  'input-button-r': 'default',
  'input-submit': 'default',
  'input-submit-d': 'default',
  'input-submit-r': 'default',
  'input-reset': 'default',
  'input-reset-d': 'default',
  'input-reset-r': 'default',
  'input-color': 'default',
  'input-color-d': 'default',
  'input-color-r': 'default',
  'input-file': 'default',
  'input-file-d': 'default',
  'input-file-r': 'default',
  'input-date': 'default',
  'input-date-d': 'default',
  'input-date-r': 'default',
  'input-datetime-local': 'default',
  'input-datetime-local-d': 'default',
  'input-datetime-local-r': 'default',
  'input-month': 'default',
  'input-month-d': 'default',
  'input-month-r': 'default',
  'input-time': 'default',
  'input-time-d': 'default',
  'input-time-r': 'default',
  'input-week': 'default',
  'input-week-d': 'default',
  'input-week-r': 'default',
  'input-range': 'default',
  'input-range-d': 'default',
  'input-range-r': 'default',
  'input-image': 'pointer',
  'input-image-d': 'default',
  'input-image-r': 'pointer',
  'input-hidden': 'default',
  'input-hidden-d': 'default',
  'input-hidden-r': 'default',
  'input-file::file-selector-button': 'default',
  'input-file-d::file-selector-button': 'default',
  'fsb-own::file-selector-button': 'help',
  'fsb-webkit::file-selector-button': 'move',
  'fsb-disabled::file-selector-button': 'not-allowed',
};
