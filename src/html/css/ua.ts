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
import type { Declaration, Stylesheet } from './parse.js';
import type { RootLook } from './style.js';

/**
 * The declaration blocks that draw a control as the palette's widget rather
 * than as the web's UA sheet has it. The cascade drops them from an element
 * whose page styles its background or border (`Cascade`'s
 * `dropPaletteChrome`), as Blink drops a control's native appearance
 * (`LayoutTheme::IsControlStyled`), since a page that styles a control
 * builds on the UA values a browser gives it. Keyed by the array, which is
 * what a cascade candidate carries.
 */
export const PALETTE_CHROME = new WeakSet<Declaration[]>();

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
    look.surface,
    look.controlPadY,
    look.controlBorder,
    look.controlRadius,
    look.controlFontSize,
    look.controlFontFamily,
  ].join('|');
}

export function uaStylesheet(look: RootLook): Stylesheet {
  const key = lookKey(look);
  const hit = CACHE.get(key);
  if (hit) return hit;
  const sheet = parseStylesheet(uaText(look), -1_000_000);
  // after the rest, so its values win over theirs while it applies
  const last = sheet.rules[sheet.rules.length - 1];
  const chrome = parseStylesheet(chromeText(look), last.order + 1);
  for (const rule of chrome.rules) {
    PALETTE_CHROME.add(rule.declarations);
    sheet.rules.push(rule);
  }
  if (CACHE.size > 8) CACHE.clear();
  CACHE.set(key, sheet);
  return sheet;
}

/**
 * Margins above and below are in `em`, so a document that sets `font-size`
 * on `body` scales its whitespace with its text the way a browser's does.
 * The indents of lists, definitions and figures are the HTML standard's
 * 40px (15.3.3, 15.3.8), whatever the size: a list in a 10px sidebar is
 * indented as far as one in the body.
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
/* <map> is inline (HTML 15.3.1), so an <area> in it the author gives a
   display of its own is drawn */
head, link, meta, style, script, title, base, template, noscript, param,
source, track, col, colgroup, datalist, area, rp { display: none; }

/* HTML's bidi rules for the two elements that are about it: <bdi> takes
   its first strong letter's direction, and <bdo> overrides. The \`dir\`
   attribute's isolation is a presentational hint (\`hints\`), where the
   attribute is read already, rather than a selector every element tries */
bdi { unicode-bidi: plaintext; }
bdo { unicode-bidi: isolate-override; }

/* the theme's colour and font are the root's (\`initialStyle\`), and the
   body inherits them, from an author's \`html\` rule too */
body { margin: 8px; }
html { color: ${look.color}; }

p { margin: 1em 0; }
h1 { font-size: 2em;    font-weight: bold; margin: 0.67em 0; }
h2 { font-size: 1.5em;  font-weight: bold; margin: 0.83em 0; }
h3 { font-size: 1.17em; font-weight: bold; margin: 1em 0; }
h4 { font-size: 1em;    font-weight: bold; margin: 1.33em 0; }
h5 { font-size: 0.83em; font-weight: bold; margin: 1.67em 0; }
h6 { font-size: 0.67em; font-weight: bold; margin: 2.33em 0; }

ul, ol { margin: 1em 0; padding-left: 40px; }
ul { list-style-type: disc; }
ol { list-style-type: decimal; }
ol, ul, menu, dir { counter-reset: list-item; }
ol[reversed] { counter-reset: reversed(list-item); }
li { display: list-item; }
ul ul, ol ul { list-style-type: circle; }
ul ul ul, ol ol ul, ul ol ul, ol ul ul { list-style-type: square; }
ul ul, ul ol, ol ul, ol ol { margin: 0; }

dl { margin: 1em 0; }
dd { margin-left: 40px; }
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
/* the HTML standard's rendering (15.3.4): an abbreviation with its
   expansion in a title says so */
abbr[title], acronym[title] { text-decoration: dotted underline; }
center { text-align: -webkit-center; }
nobr { white-space: nowrap; }
q::before { content: open-quote; }
q::after { content: close-quote; }

/* Deliberately no 'a:hover' rule, though a browser's sheet has one: a
   document containing any ':hover' selector has to be restyled as the
   pointer moves, and a rule that changes nothing (the link is already
   underlined) would make every plain document pay that. An 'a' with no
   'href' is an anchor, not a link, and is drawn as the text around it. */
a[href] { color: ${look.linkColor}; text-decoration: underline; cursor: pointer; }

hr {
  margin: 0.5em auto;
  border: none;
  border-top: 1px solid ${look.borderColor};
  height: 0;
}

img { display: inline-block; }
/* never loaded: a box of its own size, framed as a browser frames one */
iframe { border: 2px inset; }
/* a poster is drawn within the video's box at its own ratio (HTML 15.4.1) */
video { object-fit: contain; }
figure { margin: 1em 40px; }

table { display: table; border-collapse: separate; border-spacing: 2px; box-sizing: border-box; }
caption { display: table-caption; text-align: center; }
thead { display: table-header-group; }
tbody { display: table-row-group; }
tfoot { display: table-footer-group; }
tr { display: table-row; }
/* HTML's rendering rules: the rows are middle, and a cell takes its row's,
   so a <tr valign="top"> sets its cells at the top */
thead, tbody, tfoot, tr { vertical-align: middle; }
td { display: table-cell; padding: 1px; vertical-align: inherit; }
th {
  display: table-cell;
  padding: 1px;
  font-weight: bold;
  text-align: center;
  vertical-align: inherit;
}
colgroup { display: table-column-group; }
col { display: table-column; }

/* The form controls are real widgets rather than drawn boxes, so what the
   UA sheet owes them is a *box* of about the right size in the flow — the
   widget is painted into it by the component above. 'inline-block' is what
   makes a label and its input share a line. */
input, button, select, textarea, meter, progress {
  display: inline-block;
  vertical-align: middle;
  margin: 3px 2px;
}
/* A control's text is a system font's, not its parent's: Chrome gives these
   four \`font: -webkit-small-control\`, Arial at the default size less 2pt
   (13.33px) whatever the text around it is set in, and Gecko \`-moz-field\`
   the same. The system here is the palette, and its family and size are the
   ones core's widgets are set in — so a document's form is its window's,
   and the box a control is measured into is the size the widget mounted in
   it draws. A <textarea> is then \`monospace\` in Chrome, the sheet's code
   face here; a <meter> and a <progress> keep their parent's font, as they
   do in Chrome. */
input, button, select, textarea {
  font-family: ${look.controlFontFamily ?? look.fontFamily};
  font-size: ${look.controlFontSize ?? look.fontSize}px;
}
textarea { font-family: ${mono}; }
/* Chrome's own UA margins for the checkables, near enough: they are the
   controls that sit hard against their label text otherwise. */
/* HTML's rendering section (15.3.10): a control's text keeps none of the
   spacing, the line height, the case or the indent of the text around it.
   A button in a paragraph of 'line-height: 1.5' is its own font's line
   tall, as it is in a browser. */
input, button, textarea {
  letter-spacing: initial;
  word-spacing: initial;
  line-height: initial;
}
input, select, button, textarea {
  text-transform: initial;
  text-indent: initial;
  text-shadow: initial;
}
input[type=checkbox] { margin: 3px 4px 3px 4px; }
input[type=radio] { margin: 3px 4px 3px 5px; }
input[type=hidden] { display: none; }
/* A <button> is drawn rather than mounted: its content is the document's —
   an icon, a label in spans, a pill of the page's own design, which is what
   most buttons on the web are — and the page restyles it as it restyles
   anything. The edges here are Chrome's, which a page that styles its
   buttons builds on: Codex gives Wikipedia's search button its side padding
   and a 32px min-height, and leaves the 1px above and below the label, and
   the border box the minimum holds, to the browser. One the page left alone
   is the palette's control instead, below the rest of this sheet. */
button {
  vertical-align: baseline;
  box-sizing: border-box;
  padding: 1px 6px;
  border: 2px outset ${look.borderColor};
  background-color: ${look.surface};
  color: ${look.color};
  text-align: center;
  cursor: pointer;
}
button[disabled] { color: ${look.mutedColor}; cursor: default; }
textarea { vertical-align: top; }
fieldset { margin: 0 2px; padding: 0.35em 0.75em 0.6em; border: 1px solid ${look.borderColor}; }
legend { display: block; padding: 0 2px; }
label { cursor: pointer; }

details { margin: 0.5em 0; }
summary { display: list-item; counter-increment: list-item 0; list-style: disclosure-closed inside; cursor: pointer; }
details[open] > summary:first-of-type { list-style-type: disclosure-open; }

/* 'hidden' is an attribute, not a style, and a document that uses it expects
   it to win over the display above. */
[hidden] { display: none; }
`;
}

/**
 * The palette's control, for a `<button>` whose page left its background and
 * border alone: the chrome a mounted widget has, so a form in a document is
 * the size of the window's own. The rules land in `PALETTE_CHROME`, and a
 * page that styles either loses all of them — Blink counts every background
 * and border longhand, radius included — along with the native look it
 * would lose in a browser. Nothing stays half the palette's and half the
 * page's.
 */
function chromeText(look: RootLook): string {
  return `
button {
  padding: ${look.controlPadY}px 0.75em;
  border: ${look.controlBorder}px solid ${look.borderColor};
  border-radius: ${look.controlRadius}px;
}
`;
}
