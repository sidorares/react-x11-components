// Inline AST → the styled runs `<richtext>` renders. Pure: all the colour
// and font decisions arrive in `InlineStyles`, which `index.ts` derives
// from the theme once per render.
import type { InlineNode } from '../internal/markdown/ast.js';
import type { InlineDrawing, TextRun } from '../richtext/node.js';
import { matchLink } from '../richtext/links.js';
import type { LinkKinds, LinkLook } from '../richtext/links.js';

/** The resolved look of inline text, for one block. */
export interface InlineStyles {
  family: string;
  monoFamily: string;
  size: number;
  weight?: number | 'normal' | 'bold';
  style?: 'normal' | 'italic';
  color: string;
  linkColor: string;
  codeColor: string;
  codeBg: string;
}

interface WalkState {
  bold: boolean;
  italic: boolean;
  code: boolean;
  del: boolean;
  href: string | null | undefined; // undefined: not in a link
  /** A link kind's look, over the link's runs. */
  look?: LinkLook;
}

/** Flatten an inline tree to runs. Nested emphasis composes; a code span
 *  inside a link keeps the chip and gains the underline, like HTML. A link
 *  a kind in `links` has a look or a label for is drawn as the kind says. */
export function runsOf(
  nodes: InlineNode[],
  s: InlineStyles,
  links?: LinkKinds,
): TextRun[] {
  const out: TextRun[] = [];
  walk(
    nodes,
    s,
    { bold: false, italic: false, code: false, del: false, href: undefined },
    out,
    links,
  );
  return out;
}

function walk(
  nodes: InlineNode[],
  s: InlineStyles,
  st: WalkState,
  out: TextRun[],
  links: LinkKinds | undefined,
): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        pushRun(node.text, s, st, out);
        break;
      case 'code':
        walk(
          [{ type: 'text', text: node.text }],
          s,
          { ...st, code: true },
          out,
          links,
        );
        break;
      case 'strong':
        walk(node.children, s, { ...st, bold: true }, out, links);
        break;
      case 'em':
        walk(node.children, s, { ...st, italic: true }, out, links);
        break;
      case 'del':
        walk(node.children, s, { ...st, del: true }, out, links);
        break;
      case 'link': {
        const found = node.href ? matchLink(links, node.href) : null;
        const { kind, ref } = found ?? {};
        if (!kind || !node.href || (!kind.look && !kind.label)) {
          walk(node.children, s, { ...st, href: node.href }, out, links);
          break;
        }
        const written = plainTextOf(node.children);
        const look =
          kind.look?.(ref, { href: node.href, text: written }) ?? undefined;
        const label = kind.label?.(ref, written);
        const inner: WalkState = {
          ...st,
          href: node.href,
          ...(look ? { look } : null),
        };
        if (look?.icon) pushIcon(look.icon, look.iconGap ?? 4, s, inner, out);
        walk(
          label !== undefined ? [{ type: 'text', text: label }] : node.children,
          s,
          inner,
          out,
          links,
        );
        break;
      }
      case 'break':
        pushRun('\n', s, st, out);
        break;
      case 'component':
        // reserved for MDX; until a renderer maps the name, its children
        // are ordinary content rather than a hole in the document
        walk(node.children, s, st, out, links);
        break;
    }
  }
}

function pushRun(
  text: string,
  s: InlineStyles,
  st: WalkState,
  out: TextRun[],
): void {
  if (text.length === 0) return;
  // A tab in running text reads as a space, as HTML sets it, and each text
  // engine draws U+0009 as whatever its font has for it: a box in ntk's
  // fonts, CoreText's own stops 28 points apart. It is laid out as the
  // space it reads as, the same length, so every offset holds.
  if (text.includes('\t')) text = text.replace(/\t/g, ' ');
  const inLink = st.href !== undefined;
  const look = st.look;
  const linkColor = look?.color ?? s.linkColor;
  const color = st.code ? s.codeColor : inLink ? linkColor : s.color;
  const run: TextRun = {
    text,
    family: st.code ? s.monoFamily : s.family,
    size: st.code ? Math.round(s.size * 0.9) : s.size,
    weight: st.bold ? 700 : (look?.weight ?? s.weight),
    style: st.italic ? 'italic' : (look?.style ?? s.style),
    color,
  };
  if (st.code) run.bg = s.codeBg;
  else if (look?.bg) {
    run.bg = look.bg;
    if (look.bgFill) run.bgFill = look.bgFill;
  }
  if (inLink) {
    const underline = look?.underline ?? linkColor;
    if (underline !== false) run.underline = underline;
    if (look?.underlineStyle) run.underlineStyle = look.underlineStyle;
    run.href = st.href ?? null;
  }
  if (st.del) run.strike = color;
  const prev = out[out.length - 1];
  if (prev && sameStyle(prev, run)) prev.text += text;
  else out.push(run);
}

/** The icon a link kind's look puts before the label: a run of its own,
 *  never merged, in the link so a click on it follows the link, and with no
 *  underline or chip under it. */
function pushIcon(
  icon: InlineDrawing,
  gap: number,
  s: InlineStyles,
  st: WalkState,
  out: TextRun[],
): void {
  out.push({
    text: ' ',
    family: s.family,
    size: s.size,
    color: s.color,
    href: st.href ?? null,
    inline: spaced(icon, gap),
  });
}

/** An icon with room after it — the same object for the same icon and
 *  gap, since a run's fields are compared by identity. */
function spaced(icon: InlineDrawing, gap: number): InlineDrawing {
  if (gap === 0) return icon;
  let byGap = SPACED.get(icon);
  if (!byGap) SPACED.set(icon, (byGap = new Map()));
  let out = byGap.get(gap);
  if (!out) {
    out = {
      width: icon.width + gap,
      draw: (ctx, box) =>
        icon.draw(ctx, { ...box, width: box.width - gap * box.scale }),
    };
    byGap.set(gap, out);
  }
  return out;
}

const SPACED = new WeakMap<InlineDrawing, Map<number, InlineDrawing>>();

function sameStyle(a: TextRun, b: TextRun): boolean {
  if (a.inline || b.inline) return false;
  return (
    a.family === b.family &&
    a.size === b.size &&
    a.weight === b.weight &&
    a.style === b.style &&
    a.color === b.color &&
    a.bg === b.bg &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.href === b.href &&
    a.underlineStyle === b.underlineStyle &&
    a.bgFill === b.bgFill
  );
}

/** The plain text of an inline tree — table column sizing wants it. */
export function plainTextOf(nodes: InlineNode[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'code':
        out += node.text;
        break;
      case 'break':
        out += '\n';
        break;
      case 'expression':
        // Resolved to text before rendering (`<Markdown>`'s `scope`), so a
        // node reaching here was never evaluated and has no text to give.
        break;
      default:
        out += plainTextOf(node.children);
    }
  }
  return out;
}
