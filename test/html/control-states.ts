// What a form control and its kin answer to the pseudo-classes that read
// their state, as Chromium 151 answers them: every expected value below is
// its `matches()` over this document, and none is written by hand:
// `scripts/conformance/control-states.ts` writes the table from the document.
// Firefox and WebKit differ in a few, and those are decisions
// (`docs/components/html.md`).

export const CONTROL_STATE_PSEUDOS = [
  ':valid',
  ':invalid',
  ':placeholder-shown',
  ':in-range',
  ':out-of-range',
  ':indeterminate',
  ':default',
  ':read-write',
  ':read-only',
  ':dir(ltr)',
  ':dir(rtl)',
  ':dir(foo)',
  ':disabled',
  ':enabled',
];

export const CONTROL_STATE_SOURCE = String.raw`<!doctype html><html lang=en><head><title>t</title></head><body>
<div id=plain>x</div><i id=italic>x</i>
<input id=text><input id=text-empty-ph placeholder=""><input id=text-ph placeholder=hi><input id=text-ph-val placeholder=hi value=x>
<input id=hidden-ph type=hidden placeholder=hi><input id=date-ph type=date placeholder=hi><input id=num-ph type=number placeholder=hi><input id=check-ph type=checkbox placeholder=hi>
<input id=pass-ph type=password placeholder=hi><input id=search-ph type=search placeholder=hi><input id=url-ph type=url placeholder=hi><input id=tel-ph type=tel placeholder=hi><input id=email-ph type=email placeholder=hi>
<input id=ro-ph readonly placeholder=hi><input id=dis-ph disabled placeholder=hi>
<input id=bad-num-ph type=number placeholder=hi value=abc>
<input id=nl-ph placeholder="&#10;"><input id=sp-ph placeholder=" ">
<textarea id=ta-ph placeholder=hi></textarea><textarea id=ta-ph-val placeholder=hi>x</textarea><textarea id=ta-ph-nl placeholder=hi>

</textarea><textarea id=ta></textarea>
<input id=req required><input id=req-val required value=x><input id=req-ro required readonly><input id=req-dis required disabled>
<input id=email-bad type=email value=x><input id=email-ok type=email value=a@b.c><input id=url-bad type=url value=x><input id=url-ok type=url value=http://a.b>
<input id=pat-bad pattern="a+" value=b><input id=pat-ok pattern="a+" value=aa><input id=minlen minlength=5 value=ab><input id=maxlen maxlength=1 value=abc>
<textarea id=ta-req required></textarea><textarea id=ta-req-val required>x</textarea>
<input id=num-low type=number min=5 value=1><input id=num-high type=number max=5 value=9><input id=num-in type=number min=0 max=9 value=5><input id=num-empty type=number min=0 max=9><input id=num-nolimit type=number value=5><input id=num-nolimit-empty type=number>
<input id=num-step type=number step=2 value=3><input id=num-step-ok type=number step=2 value=4><input id=num-frac type=number value=1.5><input id=num-any type=number step=any value=1.5><input id=num-stepbase type=number min=1 step=2 value=3><input id=num-stepbase-bad type=number min=1 step=2 value=4><input id=num-tenth type=number step=0.1 value=0.3><input id=num-badstep type=number step=abc value=1.5><input id=num-valuebase type=number step=2 value=3><input id=num-zero-step type=number step=0 value=1.5><input id=num-neg-step type=number step=-1 value=1.5>
<input id=num-minmax-rev type=number min=9 max=1 value=5>
<input id=num-ro-low type=number min=5 value=1 readonly><input id=num-dis-low type=number min=5 value=1 disabled>
<input id=range type=range><input id=range-lim type=range min=0 max=10 value=50><input id=range-rev type=range min=10 max=0 value=5>
<input id=date-low type=date min=2020-01-01 value=2019-01-01><input id=date-high type=date max=2020-01-01 value=2021-01-01><input id=date-in type=date min=2020-01-01 max=2021-01-01 value=2020-06-01><input id=date-empty type=date min=2020-01-01><input id=date-bad type=date value=foo min=2020-01-01><input id=date-nolimit type=date value=2020-01-01><input id=date-req-bad type=date required value=foo>
<input id=date-step type=date step=2 value=2020-01-02><input id=date-step-min type=date min=2020-01-01 step=2 value=2020-01-02>
<input id=month-low type=month min=2020-01 value=2019-12><input id=month-in type=month min=2020-01 value=2020-02><input id=week-low type=week min=2020-W10 value=2020-W09><input id=week-in type=week min=2020-W10 value=2020-W11><input id=week-step type=week step=2 value=2020-W02>
<input id=time-low type=time min=10:00 value=09:00><input id=time-in type=time min=10:00 value=11:00><input id=time-sec type=time value=10:00:30><input id=time-sec-any type=time step=any value=10:00:30><input id=time-rev-in type=time min=22:00 max=02:00 value=23:00><input id=time-rev-out type=time min=22:00 max=02:00 value=12:00>
<input id=dtl-low type=datetime-local min=2020-01-01T10:00 value=2020-01-01T09:00><input id=dtl-in type=datetime-local min=2020-01-01T10:00 value=2020-01-01T11:00>
<input id=color type=color value=abc><input id=color-req type=color required>
<input id=check type=checkbox><input id=check-checked type=checkbox checked><input id=check-req type=checkbox required><input id=check-req-on type=checkbox required checked>
<input id=radio-lone type=radio><input id=radio-lone-on type=radio checked>
<input id=radio-a type=radio name=g><input id=radio-b type=radio name=g>
<input id=radio-c type=radio name=h><input id=radio-d type=radio name=h checked>
<input id=radio-req type=radio name=r required><input id=radio-req2 type=radio name=r>
<form id=f-a><input id=radio-e type=radio name=g></form>
<input id=file type=file><input id=file-req type=file required>
<input id=btn type=button value=x><input id=rst type=reset><input id=sub type=submit><input id=img type=image><input id=hidden type=hidden><input id=hidden-req type=hidden required>
<button id=button>x</button><button id=button-b type=button>x</button><button id=button-r type=reset>x</button>
<select id=sel><option id=opt-a>a<option id=opt-b>b</select>
<select id=sel-req required><option value="" id=opt-ph>p<option id=opt-c>c</select>
<select id=sel-req-ok required><option id=opt-d>d</select>
<select id=sel-def><option id=opt-e>e<option id=opt-f selected>f</select>
<select id=sel-multi multiple required><option id=opt-g>g</select>
<select id=sel-dis disabled required><option value="">p</select>
<optgroup id=og></optgroup>
<progress id=prog></progress><progress id=prog-v value=1></progress><progress id=prog-bad value=abc></progress><meter id=meter></meter>
<output id=out>x</output><object id=obj></object><fieldset id=fs-empty></fieldset><label id=lbl>x</label><legend id=leg>x</legend><datalist id=dl></datalist>
<fieldset id=fs-bad><input required id=fs-bad-in></fieldset><fieldset id=fs-ok><input id=fs-ok-in></fieldset><fieldset id=fs-dis disabled><input id=fs-dis-in required><legend id=fs-leg><input id=fs-leg-in required></legend></fieldset>
<fieldset id=fs-dis2 disabled><legend><input id=fs-first-leg-in required></legend><legend><input id=fs-second-leg-in required></legend></fieldset>
<fieldset id=fs-nest><fieldset id=fs-nest-in><input required></fieldset></fieldset>
<fieldset id=fs-sel><select required id=fs-sel-in><option value="">p</select></fieldset>
<fieldset id=fs-btn><button id=fs-btn-in>x</button></fieldset>
<form id=f-bad><input required></form><form id=f-ok><input></form><form id=f-empty></form><form id=f-nov novalidate><input required></form>
<form id=f-ext></form><input id=ext-in required form=f-ext>
<form id=f-owned-away><input required form=f-empty></form>
<form id=f-def><input id=d-text><button id=d-b0 type=button>x</button><input id=d-dis type=submit disabled><button id=d-first>x</button><input id=d-second type=submit><input id=d-img type=image></form>
<form id=f-def2><input id=d2-img type=image><button id=d2-sub>x</button></form>
<form id=f-def3><button id=d3-a form=f-none>x</button><button id=d3-b>x</button></form>
<button id=d-out form=f-def4>x</button><form id=f-def4><button id=d4-in>x</button></form>
<input id=def-check type=checkbox checked><input id=def-radio type=radio name=z checked>
<div contenteditable id=ce><p id=ce-p>x<span contenteditable=false id=ce-no>y<b id=ce-no-in>z</b></span></p><input id=ce-in disabled></div>
<div contenteditable=plaintext-only id=ce-plain>x</div><div contenteditable=FALSE id=ce-false>x</div><div contenteditable=foo id=ce-foo>x</div><div contenteditable=TRUE id=ce-true>x</div>
<input id=rw-ro readonly><input id=rw-dis disabled><textarea id=rw-ta-ro readonly></textarea><textarea id=rw-ta-dis disabled></textarea><input id=rw-check type=checkbox><input id=rw-range type=range><input id=rw-color type=color><input id=rw-file type=file><input id=rw-date type=date><input id=rw-num type=number><input id=rw-hidden type=hidden><button id=rw-btn>x</button><input id=rw-upper type=TEXT><input id=rw-unknown type=foo><fieldset disabled><input id=rw-fs></fieldset>
<div dir=rtl id=dir-rtl><p id=dir-rtl-in>x</p><div dir=ltr id=dir-ltr-in>y</div><div dir=foo id=dir-foo>z</div></div>
<div dir=auto id=dir-auto-ar>مرحبا</div><div dir=auto id=dir-auto-en>hello</div><div dir=auto id=dir-auto-none>123</div><div dir=auto id=dir-auto-nested><span>مرحبا</span></div><div dir=auto id=dir-auto-bdi><bdi>مرحبا</bdi>hello</div><div dir=auto id=dir-auto-script><script>مرحبا</script>hello</div>
<div dir=rtl><div dir=auto id=dir-auto-empty-in-rtl></div><bdi id=dir-bdi-en>hello</bdi><bdi id=dir-bdi-ar>مرحبا</bdi><bdi id=dir-bdi-none>123</bdi><input id=dir-input-tel type=tel><input id=dir-input-tel-dir type=tel dir=rtl></div>
<div dir=RTL id=dir-upper>x</div>
<input dir=auto id=dir-input-auto-ar value=مرحبا><input dir=auto id=dir-input-auto-en value=hello><textarea dir=auto id=dir-ta-auto-ar>مرحبا</textarea><div dir=rtl><input dir=auto id=dir-input-auto-empty></div>
<a href=#x id=lnk>x</a>
<svg id=dir-svg><g id=dir-svg-g></g></svg>
<details id=det><summary id=sum>x</summary></details>
<fieldset disabled id=ds-a><fieldset id=ds-b><legend><input id=ds-b-leg-in></legend><input id=ds-b-in></fieldset></fieldset>
<fieldset disabled id=ds-c><legend id=ds-c-leg><fieldset id=ds-d><input id=ds-d-in></fieldset></legend><legend id=ds-c-leg2><input id=ds-c-leg2-in></legend></fieldset>
<fieldset disabled><div><legend><input id=ds-nested-leg-in></legend></div><legend><button id=ds-real-leg-in>x</button></legend></fieldset>
<fieldset disabled><legend><fieldset disabled id=ds-own><legend><input id=ds-own-leg-in></legend><input id=ds-own-in></fieldset></legend></fieldset>
<fieldset disabled><select id=ds-sel><optgroup id=ds-og label=g><option id=ds-og-opt>a</optgroup><option id=ds-opt>b</select><textarea id=ds-ta></textarea><button id=ds-btn>x</button><a href=#x id=ds-lnk>x</a><div id=ds-div>x</div><label id=ds-lbl>x</label><output id=ds-out>x</output><object id=ds-obj></object><meter id=ds-meter></meter><progress id=ds-prog></progress></fieldset>
<select disabled id=ds-own-sel><option id=ds-sel-opt>a<optgroup id=ds-sel-og label=g><option id=ds-sel-og-opt>b</select>
<select><optgroup disabled id=ds-og-off label=g><option id=ds-og-off-opt>a<option disabled id=ds-og-off-own>b</optgroup><option disabled id=ds-opt-off>c</select>
<optgroup disabled id=ds-lone-og></optgroup><option disabled id=ds-lone-opt>a</option><option id=ds-lone-opt-on>a</option>
<div disabled id=ds-attr-div>x</div><a disabled href=#x id=ds-attr-lnk>x</a><label disabled id=ds-attr-lbl>x</label><my-el disabled id=ds-attr-custom>x</my-el><legend disabled id=ds-attr-leg>x</legend>
<svg><input disabled id=ds-svg-in></input></svg>
</body></html>
`;

/** Each element, by its id, and what it matched, in the order above. */
export const CHROME_CONTROL_STATES: Record<string, string> = {
  plain: ':read-only :dir(ltr)',
  italic: ':read-only :dir(ltr)',
  text: ':valid :read-write :dir(ltr) :enabled',
  'text-empty-ph': ':valid :placeholder-shown :read-write :dir(ltr) :enabled',
  'text-ph': ':valid :placeholder-shown :read-write :dir(ltr) :enabled',
  'text-ph-val': ':valid :read-write :dir(ltr) :enabled',
  'hidden-ph': ':read-only :dir(ltr) :enabled',
  'date-ph': ':valid :in-range :read-write :dir(ltr) :enabled',
  'num-ph':
    ':valid :placeholder-shown :in-range :read-write :dir(ltr) :enabled',
  'check-ph': ':valid :read-only :dir(ltr) :enabled',
  'pass-ph': ':valid :placeholder-shown :read-write :dir(ltr) :enabled',
  'search-ph': ':valid :placeholder-shown :read-write :dir(ltr) :enabled',
  'url-ph': ':valid :placeholder-shown :read-write :dir(ltr) :enabled',
  'tel-ph': ':valid :placeholder-shown :read-write :dir(ltr) :enabled',
  'email-ph': ':valid :placeholder-shown :read-write :dir(ltr) :enabled',
  'ro-ph': ':placeholder-shown :read-only :dir(ltr) :enabled',
  'dis-ph': ':placeholder-shown :read-only :dir(ltr) :disabled',
  'bad-num-ph':
    ':valid :placeholder-shown :in-range :read-write :dir(ltr) :enabled',
  'nl-ph': ':valid :placeholder-shown :read-write :dir(ltr) :enabled',
  'sp-ph': ':valid :placeholder-shown :read-write :dir(ltr) :enabled',
  'ta-ph': ':valid :placeholder-shown :read-write :dir(ltr) :enabled',
  'ta-ph-val': ':valid :read-write :dir(ltr) :enabled',
  'ta-ph-nl': ':valid :read-write :dir(ltr) :enabled',
  ta: ':valid :read-write :dir(ltr) :enabled',
  req: ':invalid :read-write :dir(ltr) :enabled',
  'req-val': ':valid :read-write :dir(ltr) :enabled',
  'req-ro': ':read-only :dir(ltr) :enabled',
  'req-dis': ':read-only :dir(ltr) :disabled',
  'email-bad': ':invalid :read-write :dir(ltr) :enabled',
  'email-ok': ':valid :read-write :dir(ltr) :enabled',
  'url-bad': ':invalid :read-write :dir(ltr) :enabled',
  'url-ok': ':valid :read-write :dir(ltr) :enabled',
  'pat-bad': ':invalid :read-write :dir(ltr) :enabled',
  'pat-ok': ':valid :read-write :dir(ltr) :enabled',
  minlen: ':valid :read-write :dir(ltr) :enabled',
  maxlen: ':valid :read-write :dir(ltr) :enabled',
  'ta-req': ':invalid :read-write :dir(ltr) :enabled',
  'ta-req-val': ':valid :read-write :dir(ltr) :enabled',
  'num-low': ':invalid :out-of-range :read-write :dir(ltr) :enabled',
  'num-high': ':invalid :out-of-range :read-write :dir(ltr) :enabled',
  'num-in': ':valid :in-range :read-write :dir(ltr) :enabled',
  'num-empty': ':valid :in-range :read-write :dir(ltr) :enabled',
  'num-nolimit': ':valid :read-write :dir(ltr) :enabled',
  'num-nolimit-empty': ':valid :in-range :read-write :dir(ltr) :enabled',
  'num-step': ':valid :read-write :dir(ltr) :enabled',
  'num-step-ok': ':valid :read-write :dir(ltr) :enabled',
  'num-frac': ':valid :read-write :dir(ltr) :enabled',
  'num-any': ':valid :read-write :dir(ltr) :enabled',
  'num-stepbase': ':valid :in-range :read-write :dir(ltr) :enabled',
  'num-stepbase-bad': ':invalid :in-range :read-write :dir(ltr) :enabled',
  'num-tenth': ':valid :read-write :dir(ltr) :enabled',
  'num-badstep': ':valid :read-write :dir(ltr) :enabled',
  'num-valuebase': ':valid :read-write :dir(ltr) :enabled',
  'num-zero-step': ':valid :read-write :dir(ltr) :enabled',
  'num-neg-step': ':valid :read-write :dir(ltr) :enabled',
  'num-minmax-rev': ':invalid :out-of-range :read-write :dir(ltr) :enabled',
  'num-ro-low': ':read-only :dir(ltr) :enabled',
  'num-dis-low': ':read-only :dir(ltr) :disabled',
  range: ':valid :in-range :read-only :dir(ltr) :enabled',
  'range-lim': ':valid :in-range :read-only :dir(ltr) :enabled',
  'range-rev': ':valid :in-range :read-only :dir(ltr) :enabled',
  'date-low': ':invalid :out-of-range :read-write :dir(ltr) :enabled',
  'date-high': ':invalid :out-of-range :read-write :dir(ltr) :enabled',
  'date-in': ':valid :in-range :read-write :dir(ltr) :enabled',
  'date-empty': ':valid :in-range :read-write :dir(ltr) :enabled',
  'date-bad': ':valid :in-range :read-write :dir(ltr) :enabled',
  'date-nolimit': ':valid :read-write :dir(ltr) :enabled',
  'date-req-bad': ':invalid :in-range :read-write :dir(ltr) :enabled',
  'date-step': ':valid :read-write :dir(ltr) :enabled',
  'date-step-min': ':invalid :in-range :read-write :dir(ltr) :enabled',
  'month-low': ':invalid :out-of-range :read-write :dir(ltr) :enabled',
  'month-in': ':valid :in-range :read-write :dir(ltr) :enabled',
  'week-low': ':invalid :out-of-range :read-write :dir(ltr) :enabled',
  'week-in': ':valid :in-range :read-write :dir(ltr) :enabled',
  'week-step': ':valid :read-write :dir(ltr) :enabled',
  'time-low': ':invalid :out-of-range :read-write :dir(ltr) :enabled',
  'time-in': ':valid :in-range :read-write :dir(ltr) :enabled',
  'time-sec': ':valid :read-write :dir(ltr) :enabled',
  'time-sec-any': ':valid :read-write :dir(ltr) :enabled',
  'time-rev-in': ':valid :in-range :read-write :dir(ltr) :enabled',
  'time-rev-out': ':invalid :out-of-range :read-write :dir(ltr) :enabled',
  'dtl-low': ':invalid :out-of-range :read-write :dir(ltr) :enabled',
  'dtl-in': ':valid :in-range :read-write :dir(ltr) :enabled',
  color: ':valid :read-only :dir(ltr) :enabled',
  'color-req': ':valid :read-only :dir(ltr) :enabled',
  check: ':valid :read-only :dir(ltr) :enabled',
  'check-checked': ':valid :default :read-only :dir(ltr) :enabled',
  'check-req': ':invalid :read-only :dir(ltr) :enabled',
  'check-req-on': ':valid :default :read-only :dir(ltr) :enabled',
  'radio-lone': ':valid :indeterminate :read-only :dir(ltr) :enabled',
  'radio-lone-on': ':valid :default :read-only :dir(ltr) :enabled',
  'radio-a': ':valid :indeterminate :read-only :dir(ltr) :enabled',
  'radio-b': ':valid :indeterminate :read-only :dir(ltr) :enabled',
  'radio-c': ':valid :read-only :dir(ltr) :enabled',
  'radio-d': ':valid :default :read-only :dir(ltr) :enabled',
  'radio-req': ':invalid :indeterminate :read-only :dir(ltr) :enabled',
  'radio-req2': ':invalid :indeterminate :read-only :dir(ltr) :enabled',
  'f-a': ':valid :read-only :dir(ltr)',
  'radio-e': ':valid :indeterminate :read-only :dir(ltr) :enabled',
  file: ':valid :read-only :dir(ltr) :enabled',
  'file-req': ':invalid :read-only :dir(ltr) :enabled',
  btn: ':read-only :dir(ltr) :enabled',
  rst: ':read-only :dir(ltr) :enabled',
  sub: ':valid :read-only :dir(ltr) :enabled',
  img: ':read-only :dir(ltr) :enabled',
  hidden: ':read-only :dir(ltr) :enabled',
  'hidden-req': ':read-only :dir(ltr) :enabled',
  button: ':valid :read-only :dir(ltr) :enabled',
  'button-b': ':read-only :dir(ltr) :enabled',
  'button-r': ':read-only :dir(ltr) :enabled',
  sel: ':valid :read-only :dir(ltr) :enabled',
  'opt-a': ':read-only :dir(ltr) :enabled',
  'opt-b': ':read-only :dir(ltr) :enabled',
  'sel-req': ':invalid :read-only :dir(ltr) :enabled',
  'opt-ph': ':read-only :dir(ltr) :enabled',
  'opt-c': ':read-only :dir(ltr) :enabled',
  'sel-req-ok': ':valid :read-only :dir(ltr) :enabled',
  'opt-d': ':read-only :dir(ltr) :enabled',
  'sel-def': ':valid :read-only :dir(ltr) :enabled',
  'opt-e': ':read-only :dir(ltr) :enabled',
  'opt-f': ':default :read-only :dir(ltr) :enabled',
  'sel-multi': ':invalid :read-only :dir(ltr) :enabled',
  'opt-g': ':read-only :dir(ltr) :enabled',
  'sel-dis': ':read-only :dir(ltr) :disabled',
  og: ':read-only :dir(ltr) :enabled',
  prog: ':indeterminate :read-only :dir(ltr)',
  'prog-v': ':read-only :dir(ltr)',
  'prog-bad': ':read-only :dir(ltr)',
  meter: ':read-only :dir(ltr)',
  out: ':read-only :dir(ltr)',
  obj: ':read-only :dir(ltr)',
  'fs-empty': ':valid :read-only :dir(ltr) :enabled',
  lbl: ':read-only :dir(ltr)',
  leg: ':read-only :dir(ltr)',
  dl: ':read-only :dir(ltr)',
  'fs-bad': ':invalid :read-only :dir(ltr) :enabled',
  'fs-bad-in': ':invalid :read-write :dir(ltr) :enabled',
  'fs-ok': ':valid :read-only :dir(ltr) :enabled',
  'fs-ok-in': ':valid :read-write :dir(ltr) :enabled',
  'fs-dis': ':invalid :read-only :dir(ltr) :disabled',
  'fs-dis-in': ':read-only :dir(ltr) :disabled',
  'fs-leg': ':read-only :dir(ltr)',
  'fs-leg-in': ':invalid :read-write :dir(ltr) :enabled',
  'fs-dis2': ':invalid :read-only :dir(ltr) :disabled',
  'fs-first-leg-in': ':invalid :read-write :dir(ltr) :enabled',
  'fs-second-leg-in': ':read-only :dir(ltr) :disabled',
  'fs-nest': ':invalid :read-only :dir(ltr) :enabled',
  'fs-nest-in': ':invalid :read-only :dir(ltr) :enabled',
  'fs-sel': ':invalid :read-only :dir(ltr) :enabled',
  'fs-sel-in': ':invalid :read-only :dir(ltr) :enabled',
  'fs-btn': ':valid :read-only :dir(ltr) :enabled',
  'fs-btn-in': ':valid :read-only :dir(ltr) :enabled',
  'f-bad': ':invalid :read-only :dir(ltr)',
  'f-ok': ':valid :read-only :dir(ltr)',
  'f-empty': ':invalid :read-only :dir(ltr)',
  'f-nov': ':invalid :read-only :dir(ltr)',
  'f-ext': ':invalid :read-only :dir(ltr)',
  'ext-in': ':invalid :read-write :dir(ltr) :enabled',
  'f-owned-away': ':valid :read-only :dir(ltr)',
  'f-def': ':valid :read-only :dir(ltr)',
  'd-text': ':valid :read-write :dir(ltr) :enabled',
  'd-b0': ':read-only :dir(ltr) :enabled',
  'd-dis': ':default :read-only :dir(ltr) :disabled',
  'd-first': ':valid :read-only :dir(ltr) :enabled',
  'd-second': ':valid :read-only :dir(ltr) :enabled',
  'd-img': ':read-only :dir(ltr) :enabled',
  'f-def2': ':valid :read-only :dir(ltr)',
  'd2-img': ':default :read-only :dir(ltr) :enabled',
  'd2-sub': ':valid :read-only :dir(ltr) :enabled',
  'f-def3': ':valid :read-only :dir(ltr)',
  'd3-a': ':valid :read-only :dir(ltr) :enabled',
  'd3-b': ':valid :default :read-only :dir(ltr) :enabled',
  'd-out': ':valid :default :read-only :dir(ltr) :enabled',
  'f-def4': ':valid :read-only :dir(ltr)',
  'd4-in': ':valid :read-only :dir(ltr) :enabled',
  'def-check': ':valid :default :read-only :dir(ltr) :enabled',
  'def-radio': ':valid :default :read-only :dir(ltr) :enabled',
  ce: ':read-write :dir(ltr)',
  'ce-p': ':read-write :dir(ltr)',
  'ce-no': ':read-only :dir(ltr)',
  'ce-no-in': ':read-only :dir(ltr)',
  'ce-in': ':read-only :dir(ltr) :disabled',
  'ce-plain': ':read-write :dir(ltr)',
  'ce-false': ':read-only :dir(ltr)',
  'ce-foo': ':read-only :dir(ltr)',
  'ce-true': ':read-write :dir(ltr)',
  'rw-ro': ':read-only :dir(ltr) :enabled',
  'rw-dis': ':read-only :dir(ltr) :disabled',
  'rw-ta-ro': ':read-only :dir(ltr) :enabled',
  'rw-ta-dis': ':read-only :dir(ltr) :disabled',
  'rw-check': ':valid :read-only :dir(ltr) :enabled',
  'rw-range': ':valid :in-range :read-only :dir(ltr) :enabled',
  'rw-color': ':valid :read-only :dir(ltr) :enabled',
  'rw-file': ':valid :read-only :dir(ltr) :enabled',
  'rw-date': ':valid :in-range :read-write :dir(ltr) :enabled',
  'rw-num': ':valid :in-range :read-write :dir(ltr) :enabled',
  'rw-hidden': ':read-only :dir(ltr) :enabled',
  'rw-btn': ':valid :read-only :dir(ltr) :enabled',
  'rw-upper': ':valid :read-write :dir(ltr) :enabled',
  'rw-unknown': ':valid :read-write :dir(ltr) :enabled',
  'rw-fs': ':read-only :dir(ltr) :disabled',
  'dir-rtl': ':read-only :dir(rtl)',
  'dir-rtl-in': ':read-only :dir(rtl)',
  'dir-ltr-in': ':read-only :dir(ltr)',
  'dir-foo': ':read-only :dir(rtl)',
  'dir-auto-ar': ':read-only :dir(rtl)',
  'dir-auto-en': ':read-only :dir(ltr)',
  'dir-auto-none': ':read-only :dir(ltr)',
  'dir-auto-nested': ':read-only :dir(rtl)',
  'dir-auto-bdi': ':read-only :dir(ltr)',
  'dir-auto-script': ':read-only :dir(ltr)',
  'dir-auto-empty-in-rtl': ':read-only :dir(ltr)',
  'dir-bdi-en': ':read-only :dir(ltr)',
  'dir-bdi-ar': ':read-only :dir(rtl)',
  'dir-bdi-none': ':read-only :dir(ltr)',
  'dir-input-tel': ':valid :read-write :dir(ltr) :enabled',
  'dir-input-tel-dir': ':valid :read-write :dir(rtl) :enabled',
  'dir-upper': ':read-only :dir(rtl)',
  'dir-input-auto-ar': ':valid :read-write :dir(rtl) :enabled',
  'dir-input-auto-en': ':valid :read-write :dir(ltr) :enabled',
  'dir-ta-auto-ar': ':valid :read-write :dir(rtl) :enabled',
  'dir-input-auto-empty': ':valid :read-write :dir(ltr) :enabled',
  lnk: ':read-only :dir(ltr)',
  'dir-svg': ':dir(ltr)',
  'dir-svg-g': ':dir(ltr)',
  det: ':read-only :dir(ltr)',
  sum: ':read-only :dir(ltr)',
  'ds-a': ':valid :read-only :dir(ltr) :disabled',
  'ds-b': ':valid :read-only :dir(ltr) :disabled',
  'ds-b-leg-in': ':read-only :dir(ltr) :disabled',
  'ds-b-in': ':read-only :dir(ltr) :disabled',
  'ds-c': ':valid :read-only :dir(ltr) :disabled',
  'ds-c-leg': ':read-only :dir(ltr)',
  'ds-d': ':valid :read-only :dir(ltr) :enabled',
  'ds-d-in': ':valid :read-write :dir(ltr) :enabled',
  'ds-c-leg2': ':read-only :dir(ltr)',
  'ds-c-leg2-in': ':read-only :dir(ltr) :disabled',
  'ds-nested-leg-in': ':read-only :dir(ltr) :disabled',
  'ds-real-leg-in': ':valid :read-only :dir(ltr) :enabled',
  'ds-own': ':valid :read-only :dir(ltr) :disabled',
  'ds-own-leg-in': ':valid :read-write :dir(ltr) :enabled',
  'ds-own-in': ':read-only :dir(ltr) :disabled',
  'ds-sel': ':read-only :dir(ltr) :disabled',
  'ds-og': ':read-only :dir(ltr) :disabled',
  'ds-og-opt': ':read-only :dir(ltr) :disabled',
  'ds-opt': ':read-only :dir(ltr) :disabled',
  'ds-ta': ':read-only :dir(ltr) :disabled',
  'ds-btn': ':read-only :dir(ltr) :disabled',
  'ds-lnk': ':read-only :dir(ltr)',
  'ds-div': ':read-only :dir(ltr)',
  'ds-lbl': ':read-only :dir(ltr)',
  'ds-out': ':read-only :dir(ltr)',
  'ds-obj': ':read-only :dir(ltr)',
  'ds-meter': ':read-only :dir(ltr)',
  'ds-prog': ':indeterminate :read-only :dir(ltr)',
  'ds-own-sel': ':read-only :dir(ltr) :disabled',
  'ds-sel-opt': ':read-only :dir(ltr) :disabled',
  'ds-sel-og': ':read-only :dir(ltr) :disabled',
  'ds-sel-og-opt': ':read-only :dir(ltr) :disabled',
  'ds-og-off': ':read-only :dir(ltr) :disabled',
  'ds-og-off-opt': ':read-only :dir(ltr) :disabled',
  'ds-og-off-own': ':read-only :dir(ltr) :disabled',
  'ds-opt-off': ':read-only :dir(ltr) :disabled',
  'ds-lone-og': ':read-only :dir(ltr) :disabled',
  'ds-lone-opt': ':read-only :dir(ltr) :disabled',
  'ds-lone-opt-on': ':read-only :dir(ltr) :enabled',
  'ds-attr-div': ':read-only :dir(ltr)',
  'ds-attr-lnk': ':read-only :dir(ltr)',
  'ds-attr-lbl': ':read-only :dir(ltr)',
  'ds-attr-custom': ':read-only :dir(ltr)',
  'ds-attr-leg': ':read-only :dir(ltr)',
  'ds-svg-in': ':dir(ltr)',
};
