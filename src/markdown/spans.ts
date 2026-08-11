// Inline AST → the styled runs `<richtext>` renders. Pure: all the colour
// and font decisions arrive in `InlineStyles`, which `index.ts` derives
// from the theme once per render.
import type { InlineNode } from './ast.js';
import type { TextRun } from '../richtext/node.js';

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
}

/** Flatten an inline tree to runs. Nested emphasis composes; a code span
 *  inside a link keeps the chip and gains the underline, like HTML. */
export function runsOf(nodes: InlineNode[], s: InlineStyles): TextRun[] {
  const out: TextRun[] = [];
  walk(
    nodes,
    s,
    { bold: false, italic: false, code: false, del: false, href: undefined },
    out,
  );
  return out;
}

function walk(
  nodes: InlineNode[],
  s: InlineStyles,
  st: WalkState,
  out: TextRun[],
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
        );
        break;
      case 'strong':
        walk(node.children, s, { ...st, bold: true }, out);
        break;
      case 'em':
        walk(node.children, s, { ...st, italic: true }, out);
        break;
      case 'del':
        walk(node.children, s, { ...st, del: true }, out);
        break;
      case 'link':
        walk(node.children, s, { ...st, href: node.href }, out);
        break;
      case 'break':
        pushRun('\n', s, st, out);
        break;
      case 'component':
        // reserved for MDX; until a renderer maps the name, its children
        // are ordinary content rather than a hole in the document
        walk(node.children, s, st, out);
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
  const inLink = st.href !== undefined;
  const color = st.code ? s.codeColor : inLink ? s.linkColor : s.color;
  const run: TextRun = {
    text,
    family: st.code ? s.monoFamily : s.family,
    size: st.code ? Math.round(s.size * 0.9) : s.size,
    weight: st.bold ? 700 : s.weight,
    style: st.italic ? 'italic' : s.style,
    color,
  };
  if (st.code) run.bg = s.codeBg;
  if (inLink) {
    run.underline = s.linkColor;
    run.href = st.href ?? null;
  }
  if (st.del) run.strike = color;
  const prev = out[out.length - 1];
  if (prev && sameStyle(prev, run)) prev.text += text;
  else out.push(run);
}

function sameStyle(a: TextRun, b: TextRun): boolean {
  return (
    a.family === b.family &&
    a.size === b.size &&
    a.weight === b.weight &&
    a.style === b.style &&
    a.color === b.color &&
    a.bg === b.bg &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.href === b.href
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
      default:
        out += plainTextOf(node.children);
    }
  }
  return out;
}
