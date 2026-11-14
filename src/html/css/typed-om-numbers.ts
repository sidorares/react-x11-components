// What numbers a property takes as all of its value, as Typed OM sets one
// (CSS Typed OM 1, 5.4, "create an internal representation"): by kind —
// a length, a percentage, a number, an angle, a time, a flexible length —
// and whether the property's range holds a negative one, which is set in a
// `calc()` that keeps it out of range. A property this has no entry for is
// none it can say, and one written `-` takes no number at all: a keyword,
// a colour, a list of positions.

/** Each property's kinds: `l` a length, `p` a percentage, `n` a number,
 *  `a` an angle, `t` a time, `f` a flexible length, each in upper case
 *  where the property takes none below nought. */
const TABLE = `
accent-color:- alignment-baseline:- all:- anchor-scope:- animation-delay:t
animation-direction:- animation-duration:t animation-fill-mode:-
animation-iteration-count:N animation-name:- animation-play-state:-
animation-timing-function:- backdrop-filter:- backface-visibility:-
background:- background-attachment:- background-blend-mode:-
background-clip:- background-color:- background-image:-
background-origin:- background-position:- background-repeat:-
background-size:LP baseline-shift:lp block-size:LP border-bottom-color:-
border-bottom-left-radius:LP border-bottom-right-radius:LP
border-bottom-style:- border-bottom-width:L border-collapse:-
border-image-outset:LN border-image-repeat:- border-image-slice:NP
border-image-source:- border-image-width:LNP border-left-color:-
border-left-style:- border-left-width:L border-right-color:-
border-right-style:- border-right-width:L border-top-color:-
border-top-left-radius:LP border-top-right-radius:LP border-top-style:-
border-top-width:L bottom:lp box-shadow:- box-sizing:- break-after:-
break-before:- break-inside:- caption-side:- caret-color:- clear:- clip:-
clip-path:- clip-rule:- color:- color-interpolation:- column-count:n
column-gap:LP column-height:L column-rule-color:- column-rule-style:-
column-rule-width:L column-span:- column-width:L contain:-
container-name:- container-type:- counter-increment:- counter-reset:-
counter-set:- cursor:- cx:lp cy:lp d:- direction:- display:-
dominant-baseline:- empty-cells:- fill-color:- fill-opacity:np fill-rule:-
filter:- flex-basis:LP flex-direction:- flex-grow:N flex-shrink:N
flex-wrap:- float:- flood-color:- flood-opacity:np font-feature-settings:-
font-kerning:- font-language-override:- font-optical-sizing:-
font-palette:- font-presentation:- font-size:LP font-size-adjust:N
font-stretch:P font-style:- font-synthesis-small-caps:-
font-synthesis-style:- font-synthesis-weight:- font-variant-alternates:-
font-variant-caps:- font-variant-east-asian:- font-variant-emoji:-
font-variant-ligatures:- font-variant-numeric:- font-variation-settings:-
font-weight:n grid-auto-columns:LPf grid-auto-flow:- grid-auto-rows:LPf
grid-column-start:- grid-column-end:- grid-row-start:- grid-row-end:- grid-template-areas:-
grid-template-columns:FLP grid-template-rows:FLP height:LP hyphens:-
image-rendering:- inline-size:LP isolation:- left:lp letter-spacing:lp
lighting-color:- line-break:- line-height:LNP list-style-image:-
list-style-position:- list-style-type:- margin:- margin-bottom:lp
margin-left:lp margin-right:lp margin-top:lp marker-end:- marker-mid:-
marker-start:- mask-image:- mask-type:- max-block-size:LP max-height:LP
max-inline-size:LP max-width:LP min-block-size:LP min-height:LP
min-inline-size:LP min-width:LP mix-blend-mode:- object-fit:-
object-position:- offset-anchor:- offset-distance:lp offset-path:-
offset-position:- offset-rotate:a opacity:np order:n orphans:n
outline-color:- outline-offset:l outline-style:- outline-width:L
overflow-anchor:- overflow-clip-margin:l overflow-wrap:- overflow-x:-
overflow-y:- overscroll-behavior-x:- overscroll-behavior-y:-
padding-bottom:LP padding-left:LP padding-right:LP padding-top:LP page:-
paint-order:- perspective:L perspective-origin:- pointer-events:-
position:- position-visibility:- quotes:- r:LP resize:- right:lp
row-gap:LP rx:LP ry:LP scroll-behavior:- scroll-margin-block-end:l
scroll-margin-block-start:l scroll-margin-bottom:l
scroll-margin-inline-end:l scroll-margin-inline-start:l
scroll-margin-left:l scroll-margin-right:l scroll-margin-top:l
scroll-padding-block-end:LP scroll-padding-block-start:LP
scroll-padding-bottom:LP scroll-padding-inline-end:LP
scroll-padding-inline-start:LP scroll-padding-left:LP
scroll-padding-right:LP scroll-padding-top:LP scroll-snap-align:-
scroll-snap-stop:- scroll-snap-type:- scrollbar-gutter:- scrollbar-width:-
shape-image-threshold:n shape-margin:LP shape-outside:- shape-rendering:-
speak:- stop-color:- stop-opacity:np stroke-dasharray:LNP
stroke-dashoffset:lnp stroke-linecap:- stroke-linejoin:-
stroke-miterlimit:N stroke-opacity:np stroke-width:LNP tab-size:L
table-layout:- text-align:- text-align-last:- text-anchor:-
text-autospace:- text-box-trim:- text-combine-upright:-
text-decoration-color:- text-decoration-line:- text-decoration-skip:-
text-decoration-skip-ink:- text-decoration-style:-
text-decoration-thickness:lp text-emphasis-color:-
text-emphasis-position:- text-indent:lp text-justify:- text-orientation:-
text-overflow:- text-rendering:- text-shadow:- text-size-adjust:p
text-transform:- text-underline-offset:lp text-underline-position:-
text-wrap-mode:- text-wrap-style:- top:lp touch-action:- transform:-
transform-box:- transform-style:- transition-delay:t transition-duration:t
transition-property:- transition-timing-function:- unicode-bidi:-
user-select:- vector-effect:- visibility:- white-space-collapse:-
white-space-trim:- widows:n width:LP will-change:- word-break:-
word-spacing:lp word-wrap:- writing-mode:- x:lp y:lp z-index:n
`;

const KINDS: Map<string, string> = new Map(
  TABLE.trim()
    .split(/\s+/)
    .map((item) => {
      const at = item.lastIndexOf(':');
      return [item.slice(0, at), item.slice(at + 1)] as [string, string];
    }),
);

/**
 * Whether a property takes a numeric value of the kinds given — `l`, `p`,
 * `n`, `a`, `t`, `f`, a length and a percentage together `lp`, or `x` for
 * any other type — as Typed OM sets it: `'yes'`, `'no'`, `'calc'` where it
 * takes the kinds but no negative one, which `negative` says this is, and
 * null for a property this has no entry for.
 */
export function numericTaken(
  prop: string,
  kinds: string,
  negative: boolean,
): 'yes' | 'no' | 'calc' | null {
  const taken = KINDS.get(prop.toLowerCase());
  if (taken === undefined) return null;
  if (kinds === 'x' || taken === '-') return 'no';
  const lower = taken.toLowerCase();
  for (const k of kinds) if (!lower.includes(k)) return 'no';
  if (negative && [...kinds].some((k) => taken.includes(k.toUpperCase()))) {
    return 'calc';
  }
  return 'yes';
}
