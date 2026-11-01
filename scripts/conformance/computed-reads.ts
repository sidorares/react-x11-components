// Writes `test/html/computed-reads.ts`: what `getComputedStyle` reads of the
// flex, alignment and other longhands a style holds as they are, and of the
// shorthands over them, over two documents:
//
//   CHROME=<chromium> node --import tsx scripts/conformance/computed-reads.ts
//
// Every value is Chromium's, none of them written by hand. Each declaration
// comes after one that sets the property to something else, so that one a
// property refuses reads as that, and what is refused whole shows as much.
//
// What is read and stays apart from Chromium is left out of the tables:
// `column-width: 0`, which is refused here; `text-indent: 10px hanging`, the
// same; `object-position: left top`, whose noughts read as `0px` where they
// are `0%`; and `unicode-bidi` on a block, which the UA sheet leaves `normal`
// and HTML's makes `isolate`, so it is read on a `<span>`.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chrome } from '../zengarden/chrome.js';

const FIXTURE = new URL('../../test/html/computed-reads.ts', import.meta.url);

interface Group {
  /** The property written, whose values these are. */
  name: string;
  /** What is written before it. */
  before?: string;
  /** The properties read of each element, the one written being first. */
  reads?: readonly string[];
  /** The element it is written on, where that is not a `<div>`. */
  tag?: string;
  values: string;
}

const FACTORS = `
0
1
2.5
.5
+3
1e3
1E2
1e-3
0.00001
0.000012345
1e-7
1e20
1e39
100000
999999
1000000
1234567
12345678
0.1234567
1.23456789
123456.7
calc(1 + 1)
calc(2 * 1.5)
calc(1 / 3)
calc(-1)
calc(0 - 1)
min(1, 2)
max(2, 3)
clamp(1, 2, 3)
-1
-0
1px
10%
auto
bogus
1 2
calc(1px)
infinity
calc(infinity)
calc(-infinity)
calc(NaN)
calc(1e308 * 10)
`;

/** What a self-alignment, an `align-items` and a `justify-items` are read
 *  with, a value that is none of the property's among them. */
const ALIGNMENTS = `
normal
stretch
flex-start
flex-end
center
start
end
self-start
self-end
baseline
first baseline
last baseline
baseline first
baseline last
first
last
safe center
unsafe center
center safe
center unsafe
safe start
unsafe start
safe end
safe flex-start
unsafe flex-end
safe self-start
unsafe self-end
safe baseline
safe stretch
safe normal
safe
unsafe
safe unsafe center
anchor-center
safe anchor-center
unsafe anchor-center
left
right
safe left
unsafe right
auto
legacy
legacy left
legacy right
legacy center
left legacy
right legacy
center legacy
legacy start
SAFE  CENTER
FIRST   BASELINE
space-between
space-around
space-evenly
safe space-between
bogus
center center
start end
`;

const PLACES = `
normal
center
center start
start center
stretch
baseline
first baseline
last baseline
baseline center
center baseline
last baseline center
center last baseline
safe center
safe center unsafe end
unsafe start safe end
space-between
space-between center
center space-between
space-around space-evenly
left
left right
center left
left center
normal normal
auto
auto auto
auto center
center auto
legacy
legacy left
center legacy left
center legacy
legacy center
start self-end
self-start self-end
flex-start flex-end
anchor-center
center anchor-center
anchor-center center
bogus
center bogus
bogus center
center start end
`;

const GAPS = `
normal
0
10px
10px 20px
normal 10px
10px normal
5%
5% 10px
calc(5px + 5%)
calc(1px + 2px) 3px
-1px
10px -1px
1px 2px 3px
bogus
10px bogus
`;

const GROUPS: readonly Group[] = [
  {
    name: 'flex',
    before: 'flex:9 8 7px',
    reads: ['flex', 'flex-grow', 'flex-shrink', 'flex-basis'],
    values: `
none
auto
content
0
1
2.5
1 2
1 2 3px
1 2 0
1 2 0px
0 0 0
0 0 0%
0 0 1
1 2 3
3px
3px 1
3px 1 2
1 3px 2
1 3px
1 2 auto
auto 1
auto 1 2
1 auto 2
1 2 content
content 1 2
1 content 2
10%
1 10%
calc(1 + 1)
calc(1 + 1) 3
1 calc(10px + 5%)
calc(10px + 5%) 1 1
1 calc-size(auto, size)
calc-size(auto, size)
1 calc-size(auto, size) 2
2 3 calc-size(fit-content, size + 10px)
calc-size(fit-content, size) 2 3
1 fit-content
fit-content
1 min-content
max-content 2
1 stretch
1 -webkit-fit-content
1 2 -5px
-1
1 -1
-1 1
1 1 1 1
1 1 1px 1
1px 2px
none 1
1 none
auto auto
content auto
auto content
bogus
1 bogus
bogus 1
1 2 bogus
1 2 3px bogus
NONE
AUTO
1 AUTO
0px
0 0px
0%
1e1
1e1 2e0
+1
+1 +2
.5 .5
1px 1
calc(1px + 1%) 1
1 1 calc(2px * 3)
anchor-size(width)
1 anchor-size(width)
1 1 anchor-size(width, 10px)
calc(-1)
calc(0 - 1) 2
1 calc(-1)
1 1 calc(0)
1 1 calc(1 - 1)
calc(0)
1 calc(5px - 10px)
1 calc(10% - 10px)
1 1 calc(-5px)
0 0 calc(0px)
0 0 +0
0 0 -0
0 0 0.0
0 0 0e0
3px 0
3px 0 0
3px 1 0
0 3px
1 2 3 4
1 1 0 0
auto 0
content 0
min-content 1 1
1 1 stretch
fit-content 1 1
1 fit-content 1
0 auto
initial 1
inherit
initial
unset
1 1 1e0px
1 1 1e0
1.5 2.5 3.5px
calc(1) calc(2) calc(3px)
calc(1) calc(2) calc(3)
calc(1) calc(2) calc(0)
1 2 calc(0)
`,
  },
  {
    name: 'flex-basis',
    before: 'flex-basis:7px',
    reads: ['flex-basis', 'flex'],
    values: `
auto
content
0
0px
10px
-10px
5%
-5%
5
calc(5px + 5%)
calc(5px - 10px)
fit-content
min-content
max-content
stretch
-webkit-fit-content
-webkit-fill-available
-moz-available
none
bogus
AUTO
CONTENT
calc-size(auto, size)
anchor-size(width)
anchor-size(width, 3px)
calc(-5px)
calc(5% - 10%)
calc(-5%)
calc(10% - 10px)
1e1px
+5px
0%
0.0
-0
+0
0e0
`,
  },
  {
    name: 'flex-flow',
    before: 'flex-flow:column-reverse wrap-reverse',
    reads: ['flex-flow', 'flex-direction', 'flex-wrap'],
    values: `
row
column
row-reverse
column-reverse
nowrap
wrap
wrap-reverse
row wrap
wrap row
column nowrap
nowrap column
row column
wrap nowrap
row row
wrap wrap
row bogus
bogus wrap
row wrap bogus
row wrap row
COLUMN WRAP
bogus
`,
  },
  {
    name: 'flex-direction',
    before: 'flex-direction:column-reverse',
    reads: ['flex-direction', 'flex-flow'],
    values: `
row
row-reverse
column
column-reverse
COLUMN
bogus
row wrap
`,
  },
  {
    name: 'flex-wrap',
    before: 'flex-wrap:wrap-reverse',
    reads: ['flex-wrap', 'flex-flow'],
    values: `
nowrap
wrap
wrap-reverse
WRAP
bogus
`,
  },
  {
    name: 'flex-grow',
    before: 'flex-grow:9',
    reads: ['flex-grow', 'flex'],
    values: FACTORS,
  },
  {
    name: 'flex-shrink',
    before: 'flex-shrink:9',
    reads: ['flex-shrink', 'flex'],
    values: FACTORS,
  },
  {
    name: 'order',
    before: 'order:9',
    values: `
0
1
-1
+2
-0
1.5
1.0
calc(1 + 2)
calc(1.5 + 1)
calc(-1.5 - 1)
calc(2.5)
calc(-2.5)
calc(0.5)
calc(-0.5)
calc(1.4)
1e3
1E0
2147483647
2147483648
-2147483648
-2147483649
99999999999
-99999999999
bogus
1 2
1px
10%
auto
min(1, 2)
max(1.5, 1)
calc(infinity)
calc(-infinity)
calc(NaN)
1000000
999999
1234567
`,
  },
  {
    name: 'align-items',
    before: 'align-items:end',
    reads: ['align-items', 'place-items'],
    values: ALIGNMENTS,
  },
  {
    name: 'align-self',
    before: 'align-self:end',
    reads: ['align-self', 'place-self'],
    values: ALIGNMENTS,
  },
  {
    name: 'align-content',
    before: 'align-content:end',
    reads: ['align-content', 'place-content'],
    values: ALIGNMENTS,
  },
  {
    name: 'justify-content',
    before: 'justify-content:end',
    reads: ['justify-content', 'place-content'],
    values: ALIGNMENTS,
  },
  {
    name: 'justify-items',
    before: 'justify-items:end',
    reads: ['justify-items', 'place-items'],
    values: ALIGNMENTS,
  },
  {
    name: 'justify-self',
    before: 'justify-self:end',
    reads: ['justify-self', 'place-self'],
    values: ALIGNMENTS,
  },
  {
    name: 'place-items',
    before: 'align-items:end;justify-items:end',
    reads: ['place-items', 'align-items', 'justify-items'],
    values: PLACES,
  },
  {
    name: 'place-content',
    before: 'align-content:end;justify-content:end',
    reads: ['place-content', 'align-content', 'justify-content'],
    values: PLACES,
  },
  {
    name: 'place-self',
    before: 'align-self:end;justify-self:end',
    reads: ['place-self', 'align-self', 'justify-self'],
    values: PLACES,
  },
  {
    name: 'gap',
    before: 'row-gap:7px;column-gap:8px',
    reads: ['gap', 'row-gap', 'column-gap'],
    values: GAPS,
  },
  {
    name: 'grid-gap',
    before: 'row-gap:7px;column-gap:8px',
    reads: ['gap', 'row-gap', 'column-gap'],
    values: GAPS,
  },
  {
    name: 'row-gap',
    before: 'row-gap:7px',
    reads: ['row-gap', 'gap'],
    values: GAPS,
  },
  {
    name: 'column-gap',
    before: 'column-gap:7px',
    reads: ['column-gap', 'gap'],
    values: GAPS,
  },
  {
    name: 'reading-flow',
    values: `
normal
flex-visual
flex-flow
grid-rows
grid-columns
grid-order
source-order
bogus
`,
  },
  { name: 'reading-order', values: '0\n1\n-3\n1.5\nbogus\n' },
  { name: 'backface-visibility', values: 'visible\nhidden\nbogus\n' },
  { name: 'border-collapse', values: 'separate\ncollapse\nbogus\n' },
  { name: 'box-decoration-break', values: 'slice\nclone\nbogus\n' },
  { name: 'caption-side', values: 'top\nbottom\nbogus\n' },
  { name: 'column-count', values: 'auto\n1\n3\n0\n-1\n1.5\nbogus\n' },
  { name: 'column-fill', values: 'balance\nauto\nbalance-all\nbogus\n' },
  { name: 'column-span', values: 'none\nall\n1\nbogus\n' },
  { name: 'column-width', values: 'auto\n10px\n2em\n5%\n-1px\nbogus\n' },
  { name: 'column-rule-style', values: 'none\nsolid\ndashed\nbogus\n' },
  {
    name: 'column-rule-width',
    values: 'medium\nthin\nthick\n2px\n1em\nbogus\n',
  },
  {
    name: 'column-rule-color',
    values: 'red\ncurrentcolor\ntransparent\nbogus\n',
  },
  { name: 'row-rule-style', values: 'none\nsolid\nbogus\n' },
  { name: 'row-rule-width', values: 'medium\n2px\nbogus\n' },
  { name: 'row-rule-color', values: 'red\nbogus\n' },
  { name: 'rule-overlap', values: 'row-over-column\ncolumn-over-row\nbogus\n' },
  { name: 'content-visibility', values: 'visible\nauto\nhidden\nbogus\n' },
  {
    name: 'container-type',
    values: `
normal
size
inline-size
scroll-state
size scroll-state
anchored
bogus
`,
  },
  { name: 'container-name', values: 'none\na\na b\nbogus-1\nNONE\n' },
  { name: 'empty-cells', values: 'show\nhide\nbogus\n' },
  {
    name: 'grid-auto-flow',
    values: `
row
column
row dense
column dense
dense
dense column
bogus
`,
  },
  { name: 'interpolate-size', values: 'numeric-only\nallow-keywords\nbogus\n' },
  { name: 'list-style-position', values: 'inside\noutside\nbogus\n' },
  {
    name: 'object-fit',
    values: 'fill\ncontain\ncover\nnone\nscale-down\nbogus\n',
  },
  {
    name: 'object-position',
    values: `
50% 50%
10px 20px
right 10px bottom 20px
center
bogus
`,
  },
  { name: 'orphans', values: '2\n1\n5\n0\n1.5\nbogus\n' },
  { name: 'widows', values: '2\n1\n5\n0\n1.5\nbogus\n' },
  { name: 'outline-offset', values: '0\n1px\n-2px\n1em\n5%\nbogus\n' },
  { name: 'perspective', values: 'none\n100px\n0\n1em\n-1px\n5%\nbogus\n' },
  { name: 'scroll-snap-stop', values: 'normal\nalways\nbogus\n' },
  {
    name: 'scroll-snap-type',
    values: `
none
x
y
both
block
inline
x mandatory
y proximity
both mandatory
bogus
`,
  },
  {
    name: 'scroll-snap-align',
    values: 'none\nstart\nend\ncenter\nstart end\ncenter start\nbogus\n',
  },
  { name: 'scroll-margin-top', values: '0\n10px\n2em\n-3px\n5%\nbogus\n' },
  {
    name: 'scroll-padding-top',
    values: 'auto\n0\n10px\n2em\n5%\n-1px\nbogus\n',
  },
  { name: 'scrollbar-width', values: 'auto\nthin\nnone\nbogus\n' },
  {
    name: 'tab-size',
    values: '8\n4\n0\n2.5\n10px\n1em\n-1\nbogus\n',
  },
  { name: 'table-layout', values: 'auto\nfixed\nbogus\n' },
  {
    name: 'text-align-last',
    values: 'auto\nleft\nright\ncenter\njustify\nstart\nend\nbogus\n',
  },
  {
    name: 'text-indent',
    values: '0\n10px\n2em\n5%\n-3px\ncalc(5% + 2px)\nbogus\n',
  },
  {
    name: 'text-justify',
    values: 'auto\nnone\ninter-word\ninter-character\ndistribute\nbogus\n',
  },
  {
    name: 'text-overflow',
    values: 'clip\nellipsis\n"x"\nclip ellipsis\nellipsis clip\nbogus\n',
  },
  {
    name: 'unicode-bidi',
    tag: 'span',
    values: `
normal
embed
isolate
bidi-override
isolate-override
plaintext
bogus
`,
  },
  {
    name: 'vertical-align',
    values: `
baseline
top
middle
bottom
sub
super
text-top
text-bottom
10px
-2px
1em
50%
calc(5% + 2px)
bogus
`,
  },
  {
    name: 'word-break',
    values: 'normal\nbreak-all\nkeep-all\nbreak-word\nauto-phrase\nbogus\n',
  },
  {
    name: 'font-stretch',
    values: `
normal
condensed
expanded
50%
75%
110%
200%
ultra-expanded
bogus
`,
  },
  {
    name: 'border-top-left-radius',
    values: '0\n10px\n10px 20px\n5%\nbogus\n',
  },
  {
    name: 'border-radius',
    reads: ['border-radius', 'border-top-left-radius'],
    values: `
0
10px
10px 20px
1px 2px 3px
1px 2px 3px 4px
10px / 20px
1px 2px / 3px 4px
5%
bogus
`,
  },
  {
    name: '-webkit-box-orient',
    values: 'horizontal\nvertical\ninline-axis\nblock-axis\nbogus\n',
  },
  { name: '-webkit-box-direction', values: 'normal\nreverse\nbogus\n' },
  { name: '-webkit-box-flex', values: '0\n1\n2.5\n-1\nbogus\n' },
  {
    name: 'transition-duration',
    before: 'transition-duration:9s',
    values: '0s\n1s\n200ms\n1.5s, 2s\n-1s\nbogus\n',
  },
  {
    name: 'transition-delay',
    before: 'transition-delay:9s',
    values: '0s\n-1s\n200ms\n1s, 2s\nbogus\n',
  },
  {
    name: 'transition-property',
    before: 'transition-property:color',
    values: 'all\nnone\nopacity\nopacity, width\n--x\nbogus\nALL\n',
  },
  {
    name: 'transition-timing-function',
    before: 'transition-timing-function:step-start',
    values: `
ease
linear
ease-in-out
step-end
steps(2, end)
cubic-bezier(0, 0, 1, 1)
bogus
`,
  },
  {
    name: 'transition-behavior',
    before: 'transition-behavior:allow-discrete',
    values: 'normal\nallow-discrete\nnormal, allow-discrete\nbogus\n',
  },
  {
    name: 'transition',
    reads: [
      'transition-property',
      'transition-duration',
      'transition-timing-function',
      'transition-delay',
      'transition-behavior',
    ],
    values: `
none
all
opacity 1s
opacity 1s ease-in 2s
color 1s, opacity 2s linear
1s allow-discrete
`,
  },
];

/** What a page that places an element by another's reads differently, or a
 *  page that writes no flex property at all reads of one, on elements of
 *  every kind: each `<id>` as it comes, with its `::before` too where one
 *  is `:<id>`. */
const PLACED_DOCUMENT = `<style>
html, body { font-size: 16px; color: #000 }
body { margin: 0 }
#cb { position: relative; width: 300px; height: 300px }
#a { anchor-name: --a; position: absolute; left: 100px; top: 260px; width: 20px; height: 20px }
#b { anchor-name: --b; position: absolute; left: 260px; top: 100px; width: 20px; height: 20px }
.t, .u, .v, .w { position: absolute; width: 30px; height: 60px }
.t, .v, .w { position-anchor: --a; position-area: bottom }
.u { position-anchor: --b; position-area: right; width: 60px; height: 30px }
.t { position-try-fallbacks: flip-block }
.u { position-try-fallbacks: flip-inline }
.v { position-try-fallbacks: flip-start; width: 60px; height: 60px }
.w { position-try-fallbacks: flip-block flip-inline }
#p::before { content: ""; order: 2; flex: 1 2 3px; align-self: start; justify-self: safe left }
#q::before { flex-flow: column wrap; place-content: safe center; place-items: last baseline start }
</style>
<div id="cb"><div id="a"></div><div id="b"></div>
<div class="t" id="t1" style="align-self:start;justify-self:start"></div>
<div class="t" id="t2" style="align-self:self-end;justify-self:left"></div>
<div class="t" id="t3" style="align-self:flex-start"></div>
<div class="t" id="t4" style="align-self:safe end;justify-self:unsafe self-start"></div>
<div class="t" id="t5" style="align-self:center;justify-self:right"></div>
<div class="t" id="t6" style="align-self:baseline"></div>
<div class="t" id="t7" style="align-self:last baseline"></div>
<div class="t" id="t8" style="align-self:anchor-center"></div>
<div class="u" id="u1" style="align-self:start;justify-self:start"></div>
<div class="u" id="u2" style="align-self:end;justify-self:left"></div>
<div class="u" id="u3" style="justify-self:safe right"></div>
<div class="u" id="u4" style="justify-self:self-end"></div>
<div class="u" id="u5" style="justify-self:flex-start"></div>
<div class="v" id="v1" style="align-self:start;justify-self:end"></div>
<div class="v" id="v2" style="align-self:baseline;justify-self:left"></div>
<div class="v" id="v3" style="align-self:last baseline;justify-self:right"></div>
<div class="v" id="v4" style="align-self:anchor-center;justify-self:center"></div>
<div class="v" id="v5" style="align-self:self-end;justify-self:safe self-start"></div>
<div class="w" id="w1" style="align-self:start;justify-self:left"></div>
</div>
<div id="wb" style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-box-direction:reverse;flex-direction:column-reverse;flex-wrap:wrap;align-items:center;justify-content:center;-webkit-box-pack:end;-webkit-box-align:end"><div id="wbc" style="-webkit-box-flex:2;flex-grow:3;flex-shrink:4"></div></div>
<div id="wb2" style="display:-webkit-box"><div id="wbc2" style="-webkit-box-flex:2"></div></div>
<div id="wb3" style="display:-webkit-inline-box;-webkit-box-orient:vertical"><div id="wbc3"></div></div>
<div id="wb4" style="display:-webkit-box"><div id="wbc4" style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-box-flex:2"><div id="wbc5"></div></div></div>
<div id="grid" style="display:grid"><div id="gc"></div></div>
<div id="none" style="display:none;flex-grow:2;flex-direction:column;align-items:center;order:3;gap:1px 2px"></div>
<span id="inl" style="flex-grow:2;order:3;align-self:center;align-items:start;row-gap:3px"></span>
<div style="justify-items:legacy center"><div id="l1"></div><div id="l2" style="justify-items:legacy"></div><div id="l3" style="justify-items:normal"><div id="l4"></div></div><div id="l5" style="justify-items:inherit"></div><div id="l6"><div id="l7"></div></div></div>
<div style="justify-items:center"><div id="l8"></div><div id="l9" style="justify-items:legacy"></div><div id="l10" style="justify-items:inherit"></div></div>
<div style="justify-items:legacy left"><div id="l11" style="justify-items:legacy left"><div id="l12"></div></div></div>
<div id="m1" style="flex:1 2 3px;flex-basis:inherit;flex-grow:initial"></div>
<div style="flex:3 4 5px;align-items:start;align-self:start;justify-items:right;gap:1px"><div id="m2" style="flex:inherit;align-items:inherit;align-self:inherit;justify-items:inherit;gap:inherit"></div><div id="m3" style="flex-grow:inherit;flex-shrink:unset;all:unset"></div></div>
<div id="n1" style="flex-flow:wrap;flex-flow:column"></div>
<div id="n2" style="flex:1;flex:bogus;flex-grow:2"></div>
<div id="n3" style="place-items:center;place-self:end;place-content:start;all:initial"></div>
<div id="p" style="display:flex"></div>
<div id="q"></div>`;

/** What is read of each element of `PLACED_DOCUMENT`. */
const PLACED_READS = [
  'flex',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'flex-flow',
  'flex-direction',
  'flex-wrap',
  'order',
  'align-items',
  'align-self',
  'align-content',
  'justify-items',
  'justify-self',
  'justify-content',
  'place-items',
  'place-self',
  'place-content',
  'row-gap',
  'column-gap',
  'gap',
];

const lines = (text: string): string[] => text.split('\n').filter(Boolean);

const rows = GROUPS.flatMap((group) => {
  const reads = group.reads ?? [group.name];
  return lines(group.values).map((value) => ({
    tag: group.tag ?? 'div',
    style: `${group.before ? `${group.before};` : ''}${group.name}:${value}`,
    reads,
  }));
});

const escaped = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

const document =
  '<style>html,body{font-size:16px;color:#000}body{margin:0}</style>' +
  '<div style="display:flex;width:400px;height:100px">\n' +
  rows
    .map(
      ({ tag, style }, i) =>
        `<${tag} id="r${i}" style="${escaped(style)}"></${tag}>`,
    )
    .join('\n') +
  '\n</div>';

/** Reads `expression` of a document opened in a target of its own. */
async function evaluate(
  chrome: Chrome,
  html: string,
  name: string,
  expression: string,
): Promise<string> {
  const page = join(tmpdir(), `computed-reads-${name}-${process.pid}.html`);
  writeFileSync(page, `<!doctype html>${html}`);
  const { targetId } = (await chrome.send('Target.createTarget', {
    url: pathToFileURL(page).href,
  })) as { targetId: string };
  const { sessionId } = (await chrome.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  })) as { sessionId: string };
  const ready = `new Promise((done) => {
    const read = () => done(JSON.stringify(${expression}));
    const wait = () =>
      document.readyState === 'complete' && document.body
        ? requestAnimationFrame(() => requestAnimationFrame(read))
        : setTimeout(wait, 10);
    wait();
  })`;
  // going from the blank page to the document ends what was asked of it
  for (;;) {
    try {
      const { result } = (await chrome.send(
        'Runtime.evaluate',
        { expression: ready, awaitPromise: true, returnByValue: true },
        sessionId,
      )) as { result: { value: string } };
      return result.value;
    } catch (error) {
      if (!/context|navigated/i.test(String(error))) throw error;
    }
  }
}

const chrome = await Chrome.launch();
try {
  const read = (id: string, pseudo: string, names: readonly string[]) =>
    `Object.fromEntries(${JSON.stringify(names)}.map((name) => [name, getComputedStyle(document.getElementById(${JSON.stringify(id)}), ${JSON.stringify(pseudo)}).getPropertyValue(name)]))`;
  const reads = JSON.parse(
    await evaluate(
      chrome,
      document,
      'rows',
      `[${rows.map(({ reads }, i) => read(`r${i}`, '', reads)).join(',')}]`,
    ),
  ) as Record<string, string>[];
  const ids = [...PLACED_DOCUMENT.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const places = ids.flatMap((id) => [
    [id, ''],
    ...(id === 'p' || id === 'q' ? [[id, '::before']] : []),
  ]);
  const placed = JSON.parse(
    await evaluate(
      chrome,
      PLACED_DOCUMENT,
      'placed',
      `[${places.map(([id, pseudo]) => read(id, pseudo, PLACED_READS)).join(',')}]`,
    ),
  ) as Record<string, string>[];
  const { product } = (await chrome.send('Browser.getVersion')) as {
    product: string;
  };
  const version = product.match(/\/(\d+)/)![1];
  const row = (cells: unknown) =>
    JSON.stringify(cells).replaceAll('\\', '\\\\');
  writeFileSync(
    FIXTURE,
    `// What Chromium ${version} reads of the flex, alignment and other longhands a
// style holds as they are, and of the shorthands over them, none of it
// written by hand: \`scripts/conformance/computed-reads.ts\` writes this file.

export const COMPUTED_READS_DOCUMENT = \`${document}\`;

/** A style \`r<i>\` is written with, and what \`getComputedStyle\` reads of it,
 *  by property. */
export const COMPUTED_READS: readonly (readonly [
  string,
  Readonly<Record<string, string>>,
])[] = JSON.parse(\`[
${rows.map(({ style }, i) => row([style, reads[i]])).join(',\n')}
]\`);

export const COMPUTED_PLACED_DOCUMENT = \`${PLACED_DOCUMENT}\`;

/** An element, the pseudo-element read of it or \`''\`, and what
 *  \`getComputedStyle\` reads of it, by property. */
export const COMPUTED_PLACED: readonly (readonly [
  string,
  string,
  Readonly<Record<string, string>>,
])[] = JSON.parse(\`[
${places.map(([id, pseudo], i) => row([id, pseudo, placed[i]])).join(',\n')}
]\`);
`,
  );
} finally {
  await chrome.close();
}
