// The user-agent stylesheet — what `<h1>` means before any author says.
//
// Written against the **host theme** rather than against a browser's fixed
// palette, which is the one place this deliberately differs from every UA
// sheet it is modelled on. A document dropped into a dark application should
// not arrive as a white rectangle with black text: `color`, the link colour
// and every rule and border here come from the theme the application is
// already using, so an unstyled document reads as part of the window. An
// author stylesheet still overrides all of it — that is what makes it a UA
// sheet and not a skin.
import { parseStylesheet } from './parse.js';
import type { Stylesheet } from './parse.js';
import type { RootLook } from './style.js';

/** Cache key → parsed sheet. The text depends only on the look, so two
 *  documents in one themed window parse this once between them. */
const CACHE = new Map<string, Stylesheet>();

export function lookKey(look: RootLook): string {
  return [
    look.color,
    look.fontFamily,
    look.fontSize,
    look.monoFamily,
    look.linkColor,
    look.borderColor,
    look.mutedColor,
    look.background,
  ].join('|');
}

export function uaStylesheet(look: RootLook): Stylesheet {
  const key = lookKey(look);
  const hit = CACHE.get(key);
  if (hit) return hit;
  const sheet = parseStylesheet(uaText(look), -1_000_000);
  if (CACHE.size > 8) CACHE.clear();
  CACHE.set(key, sheet);
  return sheet;
}

/**
 * Margins are in `em` throughout, so a document that sets `font-size` on
 * `body` scales its whitespace with its text the way a browser's does.
 */
function uaText(look: RootLook): string {
  const mono = look.monoFamily;
  return `
html, body, div, p, h1, h2, h3, h4, h5, h6, ol, ul, li, dl, dt, dd,
blockquote, pre, hr, table, form, fieldset, figure, figcaption, address,
article, aside, footer, header, hgroup, main, nav, section, details,
summary, dir, menu, center, marquee {
  display: block;
}
head, link, meta, style, script, title, base, template, noscript, param,
source, track, col, colgroup, datalist, area, map, rp { display: none; }

body { margin: 8px; color: ${look.color}; font-family: ${look.fontFamily}; }
html { color: ${look.color}; }

p { margin: 1em 0; }
h1 { font-size: 2em;    font-weight: bold; margin: 0.67em 0; }
h2 { font-size: 1.5em;  font-weight: bold; margin: 0.83em 0; }
h3 { font-size: 1.17em; font-weight: bold; margin: 1em 0; }
h4 { font-size: 1em;    font-weight: bold; margin: 1.33em 0; }
h5 { font-size: 0.83em; font-weight: bold; margin: 1.67em 0; }
h6 { font-size: 0.67em; font-weight: bold; margin: 2.33em 0; }

ul, ol { margin: 1em 0; padding-left: 2.5em; }
ul { list-style-type: disc; }
ol { list-style-type: decimal; }
li { display: list-item; }
ul ul, ol ul { list-style-type: circle; }
ul ul ul, ol ol ul, ul ol ul, ol ul ul { list-style-type: square; }
ul ul, ul ol, ol ul, ol ol { margin: 0; }

dl { margin: 1em 0; }
dd { margin-left: 2.5em; }
dt { font-weight: bold; }

blockquote {
  margin: 1em 0;
  padding-left: 1em;
  border-left: 3px solid ${look.borderColor};
  color: ${look.mutedColor};
}

pre {
  display: block;
  font-family: ${mono};
  font-size: 0.9em;
  white-space: pre;
  margin: 1em 0;
  padding: 0.7em 0.9em;
  overflow-x: auto;
}
code, kbd, samp, tt { font-family: ${mono}; font-size: 0.9em; }
pre code { font-size: 1em; padding: 0; background: transparent; }

b, strong { font-weight: bold; }
i, em, cite, var, dfn, address { font-style: italic; }
u, ins { text-decoration: underline; }
s, strike, del { text-decoration: line-through; }
small { font-size: 0.83em; }
big { font-size: 1.17em; }
sub { vertical-align: sub; font-size: 0.75em; }
sup { vertical-align: super; font-size: 0.75em; }
mark { background-color: #fff2a8; color: #1a1a1a; }
abbr { text-decoration: none; }
center { text-align: center; }
nobr { white-space: nowrap; }

/* Deliberately no 'a:hover' rule, though a browser's sheet has one: a
   document containing any ':hover' selector has to be restyled as the
   pointer moves, and a rule that changes nothing (the link is already
   underlined) would make every plain document pay that. */
a { color: ${look.linkColor}; text-decoration: underline; cursor: pointer; }

hr {
  margin: 0.5em 0;
  border: none;
  border-top: 1px solid ${look.borderColor};
  height: 0;
}

img { display: inline-block; }
figure { margin: 1em 2.5em; }

table { display: table; border-collapse: separate; border-spacing: 2px; }
caption { display: table-caption; text-align: center; }
thead { display: table-header-group; }
tbody { display: table-row-group; }
tfoot { display: table-footer-group; }
tr { display: table-row; }
td { display: table-cell; padding: 1px; vertical-align: middle; }
th {
  display: table-cell;
  padding: 1px;
  font-weight: bold;
  text-align: center;
  vertical-align: middle;
}
colgroup { display: table-column-group; }
col { display: table-column; }

/* The form controls are real widgets rather than drawn boxes, so what the
   UA sheet owes them is a *box* of about the right size in the flow — the
   widget is painted into it by the component above. 'inline-block' is what
   makes a label and its input share a line. */
input, button, select, textarea, meter, progress {
  display: inline-block;
  font-family: ${look.fontFamily};
  font-size: 1em;
  vertical-align: middle;
}
input[type=hidden] { display: none; }
textarea { vertical-align: top; }
fieldset { margin: 0 2px; padding: 0.35em 0.75em 0.6em; border: 1px solid ${look.borderColor}; }
legend { display: block; padding: 0 2px; }
label { cursor: pointer; }

details { margin: 0.5em 0; }
summary { display: block; cursor: pointer; font-weight: bold; }

/* 'hidden' is an attribute, not a style, and a document that uses it expects
   it to win over the display above. */
[hidden] { display: none; }
`;
}
