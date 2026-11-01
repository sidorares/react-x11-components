// What a form control and its kin answer to the pseudo-classes that read
// their state, as Chromium 151 answers them: every expected value below is
// its `matches()` over this document, and none is written by hand. Firefox and
// WebKit differ in a few, and those are decisions (`docs/components/html.md`).

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
</body></html>
`;

/** Each element, by its id, and what it matched, in the order above. */
export const CHROME_CONTROL_STATES: Record<string, string> = {
  plain: ':read-only :dir(ltr)',
  italic: ':read-only :dir(ltr)',
  text: ':valid :read-write :dir(ltr)',
  'text-empty-ph': ':valid :placeholder-shown :read-write :dir(ltr)',
  'text-ph': ':valid :placeholder-shown :read-write :dir(ltr)',
  'text-ph-val': ':valid :read-write :dir(ltr)',
  'hidden-ph': ':read-only :dir(ltr)',
  'date-ph': ':valid :in-range :read-write :dir(ltr)',
  'num-ph': ':valid :placeholder-shown :in-range :read-write :dir(ltr)',
  'check-ph': ':valid :read-only :dir(ltr)',
  'pass-ph': ':valid :placeholder-shown :read-write :dir(ltr)',
  'search-ph': ':valid :placeholder-shown :read-write :dir(ltr)',
  'url-ph': ':valid :placeholder-shown :read-write :dir(ltr)',
  'tel-ph': ':valid :placeholder-shown :read-write :dir(ltr)',
  'email-ph': ':valid :placeholder-shown :read-write :dir(ltr)',
  'ro-ph': ':placeholder-shown :read-only :dir(ltr)',
  'dis-ph': ':placeholder-shown :read-only :dir(ltr)',
  'bad-num-ph': ':valid :placeholder-shown :in-range :read-write :dir(ltr)',
  'nl-ph': ':valid :placeholder-shown :read-write :dir(ltr)',
  'sp-ph': ':valid :placeholder-shown :read-write :dir(ltr)',
  'ta-ph': ':valid :placeholder-shown :read-write :dir(ltr)',
  'ta-ph-val': ':valid :read-write :dir(ltr)',
  'ta-ph-nl': ':valid :read-write :dir(ltr)',
  ta: ':valid :read-write :dir(ltr)',
  req: ':invalid :read-write :dir(ltr)',
  'req-val': ':valid :read-write :dir(ltr)',
  'req-ro': ':read-only :dir(ltr)',
  'req-dis': ':read-only :dir(ltr)',
  'email-bad': ':invalid :read-write :dir(ltr)',
  'email-ok': ':valid :read-write :dir(ltr)',
  'url-bad': ':invalid :read-write :dir(ltr)',
  'url-ok': ':valid :read-write :dir(ltr)',
  'pat-bad': ':invalid :read-write :dir(ltr)',
  'pat-ok': ':valid :read-write :dir(ltr)',
  minlen: ':valid :read-write :dir(ltr)',
  maxlen: ':valid :read-write :dir(ltr)',
  'ta-req': ':invalid :read-write :dir(ltr)',
  'ta-req-val': ':valid :read-write :dir(ltr)',
  'num-low': ':invalid :out-of-range :read-write :dir(ltr)',
  'num-high': ':invalid :out-of-range :read-write :dir(ltr)',
  'num-in': ':valid :in-range :read-write :dir(ltr)',
  'num-empty': ':valid :in-range :read-write :dir(ltr)',
  'num-nolimit': ':valid :read-write :dir(ltr)',
  'num-nolimit-empty': ':valid :in-range :read-write :dir(ltr)',
  'num-step': ':valid :read-write :dir(ltr)',
  'num-step-ok': ':valid :read-write :dir(ltr)',
  'num-frac': ':valid :read-write :dir(ltr)',
  'num-any': ':valid :read-write :dir(ltr)',
  'num-stepbase': ':valid :in-range :read-write :dir(ltr)',
  'num-stepbase-bad': ':invalid :in-range :read-write :dir(ltr)',
  'num-tenth': ':valid :read-write :dir(ltr)',
  'num-badstep': ':valid :read-write :dir(ltr)',
  'num-valuebase': ':valid :read-write :dir(ltr)',
  'num-zero-step': ':valid :read-write :dir(ltr)',
  'num-neg-step': ':valid :read-write :dir(ltr)',
  'num-minmax-rev': ':invalid :out-of-range :read-write :dir(ltr)',
  'num-ro-low': ':read-only :dir(ltr)',
  'num-dis-low': ':read-only :dir(ltr)',
  range: ':valid :in-range :read-only :dir(ltr)',
  'range-lim': ':valid :in-range :read-only :dir(ltr)',
  'range-rev': ':valid :in-range :read-only :dir(ltr)',
  'date-low': ':invalid :out-of-range :read-write :dir(ltr)',
  'date-high': ':invalid :out-of-range :read-write :dir(ltr)',
  'date-in': ':valid :in-range :read-write :dir(ltr)',
  'date-empty': ':valid :in-range :read-write :dir(ltr)',
  'date-bad': ':valid :in-range :read-write :dir(ltr)',
  'date-nolimit': ':valid :read-write :dir(ltr)',
  'date-req-bad': ':invalid :in-range :read-write :dir(ltr)',
  'date-step': ':valid :read-write :dir(ltr)',
  'date-step-min': ':invalid :in-range :read-write :dir(ltr)',
  'month-low': ':invalid :out-of-range :read-write :dir(ltr)',
  'month-in': ':valid :in-range :read-write :dir(ltr)',
  'week-low': ':invalid :out-of-range :read-write :dir(ltr)',
  'week-in': ':valid :in-range :read-write :dir(ltr)',
  'week-step': ':valid :read-write :dir(ltr)',
  'time-low': ':invalid :out-of-range :read-write :dir(ltr)',
  'time-in': ':valid :in-range :read-write :dir(ltr)',
  'time-sec': ':valid :read-write :dir(ltr)',
  'time-sec-any': ':valid :read-write :dir(ltr)',
  'time-rev-in': ':valid :in-range :read-write :dir(ltr)',
  'time-rev-out': ':invalid :out-of-range :read-write :dir(ltr)',
  'dtl-low': ':invalid :out-of-range :read-write :dir(ltr)',
  'dtl-in': ':valid :in-range :read-write :dir(ltr)',
  color: ':valid :read-only :dir(ltr)',
  'color-req': ':valid :read-only :dir(ltr)',
  check: ':valid :read-only :dir(ltr)',
  'check-checked': ':valid :default :read-only :dir(ltr)',
  'check-req': ':invalid :read-only :dir(ltr)',
  'check-req-on': ':valid :default :read-only :dir(ltr)',
  'radio-lone': ':valid :indeterminate :read-only :dir(ltr)',
  'radio-lone-on': ':valid :default :read-only :dir(ltr)',
  'radio-a': ':valid :indeterminate :read-only :dir(ltr)',
  'radio-b': ':valid :indeterminate :read-only :dir(ltr)',
  'radio-c': ':valid :read-only :dir(ltr)',
  'radio-d': ':valid :default :read-only :dir(ltr)',
  'radio-req': ':invalid :indeterminate :read-only :dir(ltr)',
  'radio-req2': ':invalid :indeterminate :read-only :dir(ltr)',
  'f-a': ':valid :read-only :dir(ltr)',
  'radio-e': ':valid :indeterminate :read-only :dir(ltr)',
  file: ':valid :read-only :dir(ltr)',
  'file-req': ':invalid :read-only :dir(ltr)',
  btn: ':read-only :dir(ltr)',
  rst: ':read-only :dir(ltr)',
  sub: ':valid :read-only :dir(ltr)',
  img: ':read-only :dir(ltr)',
  hidden: ':read-only :dir(ltr)',
  'hidden-req': ':read-only :dir(ltr)',
  button: ':valid :read-only :dir(ltr)',
  'button-b': ':read-only :dir(ltr)',
  'button-r': ':read-only :dir(ltr)',
  sel: ':valid :read-only :dir(ltr)',
  'opt-a': ':read-only :dir(ltr)',
  'opt-b': ':read-only :dir(ltr)',
  'sel-req': ':invalid :read-only :dir(ltr)',
  'opt-ph': ':read-only :dir(ltr)',
  'opt-c': ':read-only :dir(ltr)',
  'sel-req-ok': ':valid :read-only :dir(ltr)',
  'opt-d': ':read-only :dir(ltr)',
  'sel-def': ':valid :read-only :dir(ltr)',
  'opt-e': ':read-only :dir(ltr)',
  'opt-f': ':default :read-only :dir(ltr)',
  'sel-multi': ':invalid :read-only :dir(ltr)',
  'opt-g': ':read-only :dir(ltr)',
  'sel-dis': ':read-only :dir(ltr)',
  og: ':read-only :dir(ltr)',
  prog: ':indeterminate :read-only :dir(ltr)',
  'prog-v': ':read-only :dir(ltr)',
  'prog-bad': ':read-only :dir(ltr)',
  meter: ':read-only :dir(ltr)',
  out: ':read-only :dir(ltr)',
  obj: ':read-only :dir(ltr)',
  'fs-empty': ':valid :read-only :dir(ltr)',
  lbl: ':read-only :dir(ltr)',
  leg: ':read-only :dir(ltr)',
  dl: ':read-only :dir(ltr)',
  'fs-bad': ':invalid :read-only :dir(ltr)',
  'fs-bad-in': ':invalid :read-write :dir(ltr)',
  'fs-ok': ':valid :read-only :dir(ltr)',
  'fs-ok-in': ':valid :read-write :dir(ltr)',
  'fs-dis': ':invalid :read-only :dir(ltr)',
  'fs-dis-in': ':read-only :dir(ltr)',
  'fs-leg': ':read-only :dir(ltr)',
  'fs-leg-in': ':invalid :read-write :dir(ltr)',
  'fs-dis2': ':invalid :read-only :dir(ltr)',
  'fs-first-leg-in': ':invalid :read-write :dir(ltr)',
  'fs-second-leg-in': ':read-only :dir(ltr)',
  'fs-nest': ':invalid :read-only :dir(ltr)',
  'fs-nest-in': ':invalid :read-only :dir(ltr)',
  'fs-sel': ':invalid :read-only :dir(ltr)',
  'fs-sel-in': ':invalid :read-only :dir(ltr)',
  'fs-btn': ':valid :read-only :dir(ltr)',
  'fs-btn-in': ':valid :read-only :dir(ltr)',
  'f-bad': ':invalid :read-only :dir(ltr)',
  'f-ok': ':valid :read-only :dir(ltr)',
  'f-empty': ':invalid :read-only :dir(ltr)',
  'f-nov': ':invalid :read-only :dir(ltr)',
  'f-ext': ':invalid :read-only :dir(ltr)',
  'ext-in': ':invalid :read-write :dir(ltr)',
  'f-owned-away': ':valid :read-only :dir(ltr)',
  'f-def': ':valid :read-only :dir(ltr)',
  'd-text': ':valid :read-write :dir(ltr)',
  'd-b0': ':read-only :dir(ltr)',
  'd-dis': ':default :read-only :dir(ltr)',
  'd-first': ':valid :read-only :dir(ltr)',
  'd-second': ':valid :read-only :dir(ltr)',
  'd-img': ':read-only :dir(ltr)',
  'f-def2': ':valid :read-only :dir(ltr)',
  'd2-img': ':default :read-only :dir(ltr)',
  'd2-sub': ':valid :read-only :dir(ltr)',
  'f-def3': ':valid :read-only :dir(ltr)',
  'd3-a': ':valid :read-only :dir(ltr)',
  'd3-b': ':valid :default :read-only :dir(ltr)',
  'd-out': ':valid :default :read-only :dir(ltr)',
  'f-def4': ':valid :read-only :dir(ltr)',
  'd4-in': ':valid :read-only :dir(ltr)',
  'def-check': ':valid :default :read-only :dir(ltr)',
  'def-radio': ':valid :default :read-only :dir(ltr)',
  ce: ':read-write :dir(ltr)',
  'ce-p': ':read-write :dir(ltr)',
  'ce-no': ':read-only :dir(ltr)',
  'ce-no-in': ':read-only :dir(ltr)',
  'ce-in': ':read-only :dir(ltr)',
  'ce-plain': ':read-write :dir(ltr)',
  'ce-false': ':read-only :dir(ltr)',
  'ce-foo': ':read-only :dir(ltr)',
  'ce-true': ':read-write :dir(ltr)',
  'rw-ro': ':read-only :dir(ltr)',
  'rw-dis': ':read-only :dir(ltr)',
  'rw-ta-ro': ':read-only :dir(ltr)',
  'rw-ta-dis': ':read-only :dir(ltr)',
  'rw-check': ':valid :read-only :dir(ltr)',
  'rw-range': ':valid :in-range :read-only :dir(ltr)',
  'rw-color': ':valid :read-only :dir(ltr)',
  'rw-file': ':valid :read-only :dir(ltr)',
  'rw-date': ':valid :in-range :read-write :dir(ltr)',
  'rw-num': ':valid :in-range :read-write :dir(ltr)',
  'rw-hidden': ':read-only :dir(ltr)',
  'rw-btn': ':valid :read-only :dir(ltr)',
  'rw-upper': ':valid :read-write :dir(ltr)',
  'rw-unknown': ':valid :read-write :dir(ltr)',
  'rw-fs': ':read-only :dir(ltr)',
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
  'dir-input-tel': ':valid :read-write :dir(ltr)',
  'dir-input-tel-dir': ':valid :read-write :dir(rtl)',
  'dir-upper': ':read-only :dir(rtl)',
  'dir-input-auto-ar': ':valid :read-write :dir(rtl)',
  'dir-input-auto-en': ':valid :read-write :dir(ltr)',
  'dir-ta-auto-ar': ':valid :read-write :dir(rtl)',
  'dir-input-auto-empty': ':valid :read-write :dir(ltr)',
  lnk: ':read-only :dir(ltr)',
  'dir-svg': ':dir(ltr)',
  'dir-svg-g': ':dir(ltr)',
  det: ':read-only :dir(ltr)',
  sum: ':read-only :dir(ltr)',
};
