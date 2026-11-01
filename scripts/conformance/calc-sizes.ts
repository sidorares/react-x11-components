// Writes `test/html/calc-sizes.ts`: `calc-size()` as Chromium reads it, and
// the size it makes of a box of each kind, over one document:
//
//   CHROME=<chromium> node --import tsx scripts/conformance/calc-sizes.ts
//
// Blink is the one engine that has `calc-size()`, so Chromium's answers are
// what is held to, none of them written by hand. Nothing in a box is text,
// which a platform's fonts would have another width for, and no value reads
// the viewport, which the suite has another of. A box is here for what it
// came to wrong before this read `calc-size()` as Chromium does: a row that
// comes out right whatever the code does says nothing.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chrome } from '../zengarden/chrome.js';

const FIXTURE = new URL('../../test/html/calc-sizes.ts', import.meta.url);

const SIZES = [
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'flex-basis',
];

/** What each size takes, read on all of them. */
const ON_EVERY_SIZE = `
calc-size(fit-content, size + 10px)
calc-size(auto, size * 2)
calc-size(min-content, size)
calc-size(max-content, size)
calc-size(stretch, size)
calc-size(-webkit-fill-available, size)
calc-size(-webkit-fit-content, size)
calc-size(-webkit-min-content, size)
calc-size(-webkit-max-content, size)
calc-size(-moz-available, size)
calc-size(fit-content(20px), size)
calc-size(none, size)
calc-size(content, size)
calc-size(any, 10px)
calc-size(any, size)
calc-size(any, 10px + 5%)
calc-size(any, 0)
calc-size(auto)
calc-size(fit-content)
calc-size(10px)
calc-size(10px, size)
calc-size(50%, size + 10px)
calc-size(calc-size(auto, size + 1px), size * 2)
calc-size(calc-size(50px, size + 1px), size * 2)
calc-size(calc-size(fit-content, size), size)
calc-size(auto, size, junk)
`;

/** How a calculation serializes, read on `width`. */
const CALCULATIONS = `
size - 10px
10px - size
-1 * size
size * -2
size / 2
size * 0.5 + 10%
50% - size
10px
10%
10px + 5%
0px
0
5
size * 0
size + size
size + 1em
1em + 2px + size
size + 10px + 5%
5% + size + 10px
size - 10px - 5%
-10px + size * 2
size * 1.5
size * 0.1 + 0.25px
size * 1
-1 * size - 10px
(size + 10px) * 2
size * size
size / size
2 / size
min(size, 100px)
max(size, 100px)
clamp(10px, size, 100px)
round(size, 10px)
abs(size)
calc(size + 1px)
sign(size) * 1px
size * sign(size)
-size
0px - size
0px + size
size + 0px
10px + 5px + size
size + 10px + 10px
(size + 10px) + 5px
1em + 1em + size
10px - 5px + size
10px - 10px + size
10px * 2 + size
(size - 10px) * 2
(size + 10px) / 2
-1 * (size + 10px)
2 * (size * 3)
size / 2 * 2
1 * size
2 * 3 * size
min(100px, size)
max(size)
min(size, 10px, 20px)
min(size * 2, 10px)
min(size + 1px, 10px)
min(size, 1em)
min(size, calc(100px + 5%))
calc(size * 2) + 1px
min(10px, 20px) + size
5mm + size
1in + size
1rem + 1em + size
size + 1.123456789px
0.123456789 * size
1000000 * size
1e-7 * size
size + 10
5 * 5
10px * 10px
1deg
pi * size
e * 1px + size
sin(30deg) * size
pow(2, 2) * size
sqrt(4) * size
exp(1) * size
sign(-1px) * size
mod(size, 7px)
rem(size, 7px)
hypot(size, 3px)
round(up, size, 10px)
10px - 2 * size
10% - 2 * size + 5px
10px - (size + 5px)
10px - (size - 5px)
10px - min(size, 1px)
min(size, 1px) - 10px
2 * min(size, 1px)
min(size, 1px) / 2
size / 2 + size / 2
-1 * size + 1px
1 * size * sign(size)
abs(size) * 2
size * (1 + 2)
size * calc(1 + 2)
size * 0 + 1px
-0px
size * -0
1px * size
size * 1px
(size)
((size + 1px))
size+1px
size +1px
size*2
size/2
1px + 1%
1px - 1%
10% + 20%
10% - 10%
2 * 10%
min(10%, 20%)
min(10%, 20%) + size
calc(1px)
max(size, min(size, 1px))
round(size, 1px) + 1px
round(nearest, size, 1px)
round(to-zero, size, 1px)
clamp(1px, 2px, 3px) + size
clamp(size, 1px, 2px)
sign(size) * size
abs(-1px) + size
mod(5px, 3px) + size
hypot(3px, 4px) + size
size / 2px
(size * 2) - size
size - size
`;

/** How a basis serializes, read on `width`. */
const BASES = `
10em
calc(10px + 5%)
-10px
50px + 10px
calc(50px + 10px)
10px * 2
min(10px, 5%)
min(10px, 20px)
max(1em, 10px)
1em + 1px
0
0px
5
size
10%
-10%
10px + 10%
10% - 10px
2 * 1em
0%
min(1px, 2%)
min(1em, 2px)
clamp(1px, 2%, 3px)
`;

const WHOLE = `
calc-size(AUTO, SIZE * 2)
CALC-SIZE(auto, size)
calc-size( auto , size )
calc-size(auto,)
calc-size(,size)
calc-size()
calc(calc-size(auto, size))
calc-size(any, any)
calc-size(auto, auto)
calc-size(auto, min-content)
calc-size(10px, 20%)
calc-size(calc-size(any, 10px), 5px)
calc-size(calc-size(10px, 20px), 30px)
calc-size(any, calc-size(auto, size))
calc-size(auto, calc-size(auto, size))
`;

const lines = (text: string): string[] => text.split('\n').filter(Boolean);

const reads: [string, string][] = [
  ...lines(ON_EVERY_SIZE).flatMap((value) =>
    SIZES.map((size): [string, string] => [size, value]),
  ),
  ...lines(CALCULATIONS).map((sum): [string, string] => [
    'width',
    `calc-size(auto, ${sum})`,
  ]),
  ...lines(BASES).map((basis): [string, string] => [
    'width',
    `calc-size(${basis}, size)`,
  ]),
  ...lines(WHOLE).map((value): [string, string] => ['width', value]),
];

const LIMITS = `
width:calc-size(auto, min(size, 100px))
width:calc-size(auto, max(size, 500px))
width:calc-size(auto, clamp(10px, size, 100px))
width:calc-size(-10px, size)
width:calc-size(calc-size(auto, size * 0.5), size + 10px)
width:calc-size(calc-size(min-content, size + 1px), 2 * size)
width:calc-size(calc-size(any, 10px), size * 3)
width:calc-size(fit-content, round(size, 50px))
width:100px;min-width:calc-size(auto, size + 200px)
width:100px;min-width:calc-size(auto, 300px)
width:100px;min-width:calc-size(fit-content, size + 200px)
width:100px;min-width:calc-size(max-content, size + 200px)
width:100px;min-width:calc-size(min-content, size * 5)
width:100px;min-width:calc-size(any, 300px)
width:100px;min-width:calc-size(300px, size)
width:100px;min-width:calc-size(stretch, size * 0.5)
width:100px;min-width:calc-size(10%, size * 3)
width:100px;min-width:calc-size(any, 50%)
width:100px;min-width:calc-size(fit-content, 150px)
width:100px;min-width:calc-size(fit-content, 50%)
width:300px;max-width:calc-size(fit-content, size + 10px)
width:300px;max-width:calc-size(min-content, size * 2)
width:300px;max-width:calc-size(max-content, size * 2)
width:300px;max-width:calc-size(stretch, size * 0.5)
width:300px;max-width:calc-size(any, 50px)
width:300px;max-width:calc-size(50px, size * 2)
width:300px;max-width:calc-size(fit-content, -10px)
width:300px;max-width:calc-size(any, 10%)
width:300px;max-width:calc-size(fit-content, 10%)
width:300px;max-width:calc-size(-10px, size)
width:300px;max-width:calc-size(fit-content, min(size, 5px))
height:calc-size(stretch, size * 0.5)
height:calc-size(auto, min(size, 5px))
height:calc-size(auto, max(size, 50px))
height:calc-size(auto, min(size, 1%))
height:10px;min-height:calc-size(auto, size + 100px)
height:10px;min-height:calc-size(auto, 100px)
height:10px;min-height:calc-size(fit-content, size + 5px)
height:10px;min-height:calc-size(min-content, size + 5px)
height:10px;min-height:calc-size(max-content, size * 3)
height:10px;min-height:calc-size(stretch, size * 0.5)
height:10px;min-height:calc-size(any, 50px)
height:10px;min-height:calc-size(50px, size * 2)
height:10px;min-height:calc-size(10%, size)
height:10px;min-height:calc-size(10%, 50px)
height:10px;min-height:calc-size(fit-content, 10%)
height:10px;min-height:calc-size(fit-content, size + 10%)
height:10px;min-height:calc-size(any, 10%)
height:10px;min-height:calc-size(auto, 10%)
height:10px;min-height:min-content
height:10px;min-height:fit-content
height:10px;min-height:max-content
min-height:calc-size(fit-content, size * 2)
min-height:calc-size(any, 50px)
height:100px;max-height:calc-size(fit-content, size * 2)
height:100px;max-height:calc-size(min-content, size + 5px)
height:100px;max-height:calc-size(max-content, size * 0.5)
height:100px;max-height:calc-size(any, 50px)
height:100px;max-height:calc-size(50px, size * 0.5)
height:100px;max-height:calc-size(10%, size)
height:100px;max-height:calc-size(10%, 50px)
height:100px;max-height:calc-size(fit-content, 10%)
height:100px;max-height:calc-size(fit-content, size + 10%)
height:100px;max-height:calc-size(fit-content, -5px)
height:100px;max-height:calc-size(-5px, size)
height:100px;max-height:calc-size(any, 10%)
height:100px;max-height:min-content
height:100px;max-height:fit-content
height:100px;max-height:max-content
max-height:calc-size(fit-content, size * 0.5)
box-sizing:border-box;padding:10px;width:100px;min-width:calc-size(fit-content, size + 200px)
box-sizing:border-box;padding:10px;width:300px;max-width:calc-size(fit-content, size + 10px)
box-sizing:border-box;padding:10px;height:10px;min-height:calc-size(fit-content, size * 2)
box-sizing:border-box;padding:10px;height:100px;max-height:calc-size(fit-content, size * 2)
padding:10px;width:100px;min-width:calc-size(fit-content, size + 200px)
padding:10px;height:100px;max-height:calc-size(fit-content, size * 2)
padding:10px;height:10px;min-height:calc-size(fit-content, size * 2)
`;

/** In a box of no height of its own. */
const UNSET = `
width:calc-size(auto, min(size, 100px))
width:calc-size(auto, max(size, 500px))
width:calc-size(auto, clamp(10px, size, 100px))
width:calc-size(-10px, size)
width:calc-size(calc-size(auto, size * 0.5), size + 10px)
width:calc-size(calc-size(min-content, size + 1px), 2 * size)
width:calc-size(calc-size(any, 10px), size * 3)
width:calc-size(fit-content, round(size, 50px))
width:100px;min-width:calc-size(auto, size + 200px)
width:100px;min-width:calc-size(auto, 300px)
width:100px;min-width:calc-size(fit-content, size + 200px)
width:100px;min-width:calc-size(max-content, size + 200px)
width:100px;min-width:calc-size(min-content, size * 5)
width:100px;min-width:calc-size(any, 300px)
width:100px;min-width:calc-size(300px, size)
width:100px;min-width:calc-size(stretch, size * 0.5)
width:100px;min-width:calc-size(10%, size * 3)
width:100px;min-width:calc-size(any, 50%)
width:100px;min-width:calc-size(fit-content, 150px)
width:100px;min-width:calc-size(fit-content, 50%)
width:300px;max-width:calc-size(fit-content, size + 10px)
width:300px;max-width:calc-size(min-content, size * 2)
width:300px;max-width:calc-size(max-content, size * 2)
width:300px;max-width:calc-size(stretch, size * 0.5)
width:300px;max-width:calc-size(any, 50px)
width:300px;max-width:calc-size(50px, size * 2)
width:300px;max-width:calc-size(fit-content, -10px)
width:300px;max-width:calc-size(any, 10%)
width:300px;max-width:calc-size(fit-content, 10%)
width:300px;max-width:calc-size(-10px, size)
width:300px;max-width:calc-size(fit-content, min(size, 5px))
height:calc-size(50%, 10px)
height:calc-size(10px, 20%)
height:calc-size(auto, min(size, 5px))
height:calc-size(auto, max(size, 50px))
height:calc-size(auto, min(size, 1%))
height:10px;min-height:calc-size(auto, size + 100px)
height:10px;min-height:calc-size(auto, 100px)
height:10px;min-height:calc-size(fit-content, size + 5px)
height:10px;min-height:calc-size(min-content, size + 5px)
height:10px;min-height:calc-size(max-content, size * 3)
height:10px;min-height:calc-size(any, 50px)
height:10px;min-height:calc-size(50px, size * 2)
height:10px;min-height:calc-size(10%, 50px)
height:10px;min-height:calc-size(fit-content, size + 10%)
height:10px;min-height:min-content
height:10px;min-height:fit-content
height:10px;min-height:max-content
min-height:calc-size(fit-content, size * 2)
min-height:calc-size(any, 50px)
height:100px;max-height:calc-size(fit-content, size * 2)
height:100px;max-height:calc-size(min-content, size + 5px)
height:100px;max-height:calc-size(max-content, size * 0.5)
height:100px;max-height:calc-size(any, 50px)
height:100px;max-height:calc-size(50px, size * 0.5)
height:100px;max-height:calc-size(fit-content, 10%)
height:100px;max-height:calc-size(fit-content, size + 10%)
height:100px;max-height:calc-size(fit-content, -5px)
height:100px;max-height:calc-size(-5px, size)
height:100px;max-height:calc-size(any, 10%)
height:100px;max-height:min-content
height:100px;max-height:fit-content
height:100px;max-height:max-content
max-height:calc-size(fit-content, size * 0.5)
box-sizing:border-box;padding:10px;width:100px;min-width:calc-size(fit-content, size + 200px)
box-sizing:border-box;padding:10px;width:300px;max-width:calc-size(fit-content, size + 10px)
box-sizing:border-box;padding:10px;height:10px;min-height:calc-size(fit-content, size * 2)
box-sizing:border-box;padding:10px;height:100px;max-height:calc-size(fit-content, size * 2)
padding:10px;width:100px;min-width:calc-size(fit-content, size + 200px)
padding:10px;height:100px;max-height:calc-size(fit-content, size * 2)
padding:10px;height:10px;min-height:calc-size(fit-content, size * 2)
`;

const OF_WORDS = `
width:300px;max-width:calc-size(min-content, size + 1px)
width:300px;max-width:calc-size(max-content, size + 1px)
width:300px;max-width:calc-size(fit-content, size + 1px)
`;

const ABSOLUTE = `
width:calc-size(auto, size + 7px)
width:calc-size(fit-content, size * 2)
width:calc-size(min-content, size + 7px)
width:calc-size(max-content, size + 7px)
width:calc-size(stretch, size * 0.5)
width:calc-size(any, 70px)
width:calc-size(auto, 70px)
width:calc-size(auto, min(size, 45px))
left:0;right:0;width:calc-size(auto, size * 0.5)
top:0;bottom:0;height:calc-size(auto, size * 0.5)
min-width:calc-size(auto, 70px)
min-width:calc-size(auto, size + 70px)
min-width:calc-size(fit-content, size + 7px)
min-width:calc-size(max-content, size + 7px)
min-width:calc-size(any, 170px)
max-width:calc-size(min-content, size + 7px)
max-width:calc-size(fit-content, size - 7px)
max-width:calc-size(any, 7px)
min-height:calc-size(fit-content, size * 2)
max-height:calc-size(fit-content, size * 0.5)
height:100px;max-height:calc-size(fit-content, size * 0.5)
height:5px;min-height:calc-size(fit-content, size * 2)
`;

const FLOATS = `
width:calc-size(auto, size + 7px)
width:calc-size(stretch, size * 0.5)
width:calc-size(any, 70px)
width:calc-size(auto, 70px)
width:calc-size(auto, min(size, 45px))
left:0;right:0;width:calc-size(auto, size * 0.5)
min-width:calc-size(auto, 70px)
min-width:calc-size(auto, size + 70px)
min-width:calc-size(fit-content, size + 7px)
min-width:calc-size(max-content, size + 7px)
min-width:calc-size(any, 170px)
max-width:calc-size(min-content, size + 7px)
max-width:calc-size(fit-content, size - 7px)
max-width:calc-size(any, 7px)
min-height:calc-size(fit-content, size * 2)
max-height:calc-size(fit-content, size * 0.5)
height:100px;max-height:calc-size(fit-content, size * 0.5)
height:5px;min-height:calc-size(fit-content, size * 2)
`;

const INLINE_BLOCKS = `
width:calc-size(auto, size + 7px)
width:calc-size(fit-content, size * 2)
width:calc-size(min-content, size + 7px)
width:calc-size(max-content, size + 7px)
width:calc-size(stretch, size * 0.5)
width:calc-size(any, 70px)
width:calc-size(auto, 70px)
width:calc-size(auto, min(size, 45px))
left:0;right:0;width:calc-size(auto, size * 0.5)
min-width:calc-size(auto, 70px)
min-width:calc-size(auto, size + 70px)
min-width:calc-size(fit-content, size + 7px)
min-width:calc-size(max-content, size + 7px)
min-width:calc-size(any, 170px)
max-width:calc-size(min-content, size + 7px)
max-width:calc-size(fit-content, size - 7px)
max-width:calc-size(any, 7px)
min-height:calc-size(fit-content, size * 2)
max-height:calc-size(fit-content, size * 0.5)
height:100px;max-height:calc-size(fit-content, size * 0.5)
height:5px;min-height:calc-size(fit-content, size * 2)
`;

const ITEMS = `
min-width:calc-size(auto, size + 7px)
min-width:calc-size(auto, size * 2)
min-width:calc-size(auto, 7px)
min-width:calc-size(min-content, size + 7px)
min-width:calc-size(fit-content, size + 7px)
min-width:calc-size(max-content, size + 7px)
min-width:calc-size(any, 70px)
flex-shrink:0;min-width:calc-size(fit-content, size + 7px)
flex-shrink:0;width:calc-size(auto, size + 7px)
flex-shrink:0;width:calc-size(fit-content, size + 7px)
flex-shrink:0;width:calc-size(max-content, size + 7px)
flex-shrink:0;width:calc-size(auto, min(size, 45px))
flex-shrink:0;flex-basis:calc-size(auto, size + 7px)
flex-shrink:0;flex-basis:calc-size(content, size + 7px)
flex-shrink:0;flex-basis:calc-size(fit-content, size + 7px)
flex-shrink:0;flex-basis:calc-size(min-content, size + 7px)
flex-shrink:0;flex-basis:calc-size(max-content, size + 7px)
flex-shrink:0;flex-basis:calc-size(any, 70px)
flex-shrink:0;flex-basis:calc-size(70px, size * 2)
flex-shrink:0;flex-basis:calc-size(auto, size + 7px);width:100px
flex-shrink:0;flex-basis:calc-size(content, size + 7px);width:100px
flex-shrink:0;max-width:calc-size(fit-content, size - 5px)
`;

const COLUMN_ITEMS = `
min-height:calc-size(auto, size + 7px)
min-height:calc-size(fit-content, size + 7px)
max-height:calc-size(fit-content, size - 7px)
flex-basis:calc-size(auto, size + 7px)
flex-basis:calc-size(content, size * 2)
flex-basis:calc-size(any, 70px)
flex-basis:calc-size(70px, size * 2)
width:calc-size(auto, size * 0.5)
width:calc-size(stretch, size * 0.5)
width:calc-size(max-content, size * 0.5)
width:calc-size(fit-content, size + 7px)
max-width:calc-size(fit-content, size - 7px)
`;

const GRID_ITEMS = `
width:calc-size(max-content, size + 7px)
width:calc-size(min-content, size + 7px)
width:calc-size(auto, size + 7px)
min-width:calc-size(max-content, size + 7px)
min-width:calc-size(auto, 70px)
min-width:calc-size(any, 170px)
max-width:calc-size(min-content, size + 7px)
max-width:calc-size(any, 7px)
height:calc-size(auto, size * 2)
min-height:calc-size(fit-content, size * 2)
max-height:calc-size(fit-content, size * 0.5)
`;

/** A box in a flex item, which comes to its narrowest around it. */
const IN_AN_ITEM = `
width:calc-size(min-content, size + 7px)
width:calc-size(max-content, size + 7px)
width:calc-size(auto, size + 7px)
width:calc-size(any, 70px)
min-width:calc-size(min-content, size + 7px)
max-width:calc-size(min-content, size * 0.5)
`;

const ONE = '<div class="c"></div>';
const TWO = '<b class="w"></b><b class="w"></b>';

type Box = (id: number, style: string, holds: string) => string;

const item = (id: number, style: string, holds: string): string =>
  `<div id="b${id}" style="${style}">${holds}</div>`;
const set: Box = (id, style, holds) =>
  `<div class="set">${item(id, style, holds)}</div>`;
const unset: Box = (id, style, holds) =>
  `<div class="unset">${item(id, style, holds)}</div>`;
const absolute: Box = (id, style, holds) =>
  `<div class="set">${item(id, `position:absolute;${style}`, holds)}</div>`;
const inlineBlock: Box = (id, style, holds) =>
  `<div class="set">${item(id, `display:inline-block;${style}`, holds)}</div>`;
const floated: Box = (id, style, holds) =>
  `<div class="set"><div id="o${id}" style="float:left">${item(id, style, holds)}</div></div>`;
const flexRow: Box = (id, style, holds) =>
  `<div style="display:flex;width:400px">${item(id, style, holds)}<div style="flex:0 0 380px;height:5px"></div></div>`;
const flexColumn: Box = (id, style, holds) =>
  `<div style="display:flex;flex-direction:column;width:400px;height:300px">${item(id, style, holds)}</div>`;
const grid: Box = (id, style, holds) =>
  `<div style="display:grid;grid-template-columns:auto 1fr;width:400px">${item(id, style, holds)}<div style="height:5px"></div></div>`;

const inAnItem: Box = (id, style, holds) =>
  `<div style="display:flex;width:10px"><div id="o${id}">${item(id, style, holds)}</div></div>`;

const KINDS: [string, Box, string, string][] = [
  ['set', set, ONE, LIMITS],
  ['unset', unset, ONE, UNSET],
  ['set', set, TWO, OF_WORDS],
  ['absolute', absolute, TWO, ABSOLUTE],
  ['float', floated, TWO, FLOATS],
  ['inline-block', inlineBlock, TWO, INLINE_BLOCKS],
  ['flex', flexRow, TWO, ITEMS],
  ['column', flexColumn, TWO, COLUMN_ITEMS],
  ['grid', grid, TWO, GRID_ITEMS],
  ['in an item', inAnItem, TWO, IN_AN_ITEM],
];

const boxes: { kind: string; style: string; html: string }[] = [];
for (const [kind, box, holds, styles] of KINDS) {
  for (const style of lines(styles)) {
    boxes.push({ kind, style, html: box(boxes.length, style, holds) });
  }
}

const STYLE =
  '<style>html,body{font-size:16px}body{margin:0}' +
  '.set{width:400px;height:300px;position:relative}.unset{width:400px}' +
  '.c{width:30px;height:20px}' +
  '.w{display:inline-block;width:30px;height:20px;vertical-align:top}</style>';
const document =
  STYLE +
  reads
    .map(
      ([size, value], i) => `<span id="r${i}" style="${size}:${value}"></span>`,
    )
    .join('\n') +
  '\n' +
  boxes.map(({ html }) => html).join('\n') +
  '\n';

const page = join(tmpdir(), `calc-sizes-${process.pid}.html`);
writeFileSync(page, `<!doctype html>${document}`);
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
        const sizes = ${JSON.stringify(reads.map(([size]) => size))};
        const size = (id) => {
          const rect = document.getElementById(id)?.getBoundingClientRect();
          return rect ? [rect.width, rect.height] : null;
        };
        const read = () => done(JSON.stringify({
          reads: sizes.map((name, i) => {
            const el = document.getElementById('r' + i);
            return [
              el.style.getPropertyValue(name),
              getComputedStyle(el).getPropertyValue(name),
            ];
          }),
          boxes: ${JSON.stringify(boxes.map((_, i) => i))}.map((i) => [
            size('b' + i),
            size('o' + i),
          ]),
        }));
        // the target starts on a blank page, which is complete already
        const ready = () =>
          document.readyState === 'complete' &&
          document.getElementById('r0')
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
  const measured = JSON.parse(result.value) as {
    reads: [string, string][];
    boxes: [[number, number], [number, number] | null][];
  };
  const { product } = (await chrome.send('Browser.getVersion')) as {
    product: string;
  };
  const version = product.match(/\/(\d+)/)![1];
  const readRows = reads.map(([size, value], i) =>
    JSON.stringify([size, value, ...measured.reads[i]]),
  );
  const boxRows = boxes.map(({ kind, style }, i) =>
    JSON.stringify([kind, style, ...measured.boxes[i]]),
  );
  writeFileSync(
    FIXTURE,
    `// \`calc-size()\` as Chromium ${version} reads it, and the sizes it makes of boxes,
// over this document, none of them written by hand:
// \`scripts/conformance/calc-sizes.ts\` writes this file. Nothing in a box is
// text, which a platform's fonts would have another width for.

export const CALC_SIZE_DOCUMENT = \`${document}\`;

/** A size, a value, what \`el.style\` keeps of it — nothing where the size
 *  does not take it — and what \`getComputedStyle\` reads, of \`r<i>\`. */
export const CALC_SIZE_READS: readonly (readonly [
  string,
  string,
  string,
  string,
])[] = JSON.parse(\`[
${readRows.join(',\n')}
]\`);

/** A kind of box, its style, the width and the height of \`b<i>\`, and those
 *  of \`o<i>\`, what a float was shrunk to fit around it. */
export const CALC_SIZE_BOXES: readonly (readonly [
  string,
  string,
  readonly [number, number],
  readonly [number, number] | null,
])[] = JSON.parse(\`[
${boxRows.join(',\n')}
]\`);
`,
  );
} finally {
  await chrome.close();
}
