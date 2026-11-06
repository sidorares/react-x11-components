// A composer's document: lines of literal text, and two atoms — a mention and
// an attachment — that are each one thing in the editor and one token in the
// value.
//
// `<RichTextEditor format="text" schema={composerSchema}>` is the editor a
// chat box, a comment box or an agent's prompt is written in. The value is
// the text as typed (`format="text"`), so nothing is escaped or normalised on
// its way out, and the atoms write themselves into it as their `leafText`:
// `@label` for a mention, `[label]` for an attachment, which is what a model
// or a reader sees when nobody looks closer. `composerParts` is the closer
// look — the same text, and each atom's attributes, and where its token is.
//
// Pure: no React and no react-x11, so the schema and the parts are asserted
// with no display (test/rich-text-editor-model.test.ts).
import { Schema } from 'prosemirror-model';
import type { DOMOutputSpec, Node as PMNode } from 'prosemirror-model';

/** What an attachment holds: a long paste, an image, a file. */
export type AttachmentKind = 'paste' | 'image' | 'file';

interface ElementLike {
  getAttribute(name: string): string | null;
  readonly textContent?: string | null;
}

/**
 * Lines and two atoms. `mention` — `kind` (`'user'` by default: a person,
 * a file, a symbol, whatever the app's `@` list offers), `id`, `label` and
 * `data`, the app's own — is written into the value as `@label`.
 * `attachment` — `kind`, `id`, `label` and `data` (a paste's text, an image's
 * bytes, a file's path) — is written as `[label]`. Neither has marks, and
 * the document has none: a composer's formatting is drawn over its text
 * (`markup`), never stored beside it.
 */
export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: (): DOMOutputSpec => ['p', 0],
    },
    text: { group: 'inline' },
    mention: {
      inline: true,
      group: 'inline',
      atom: true,
      selectable: true,
      attrs: {
        kind: { default: 'user' },
        id: { default: null },
        label: { default: '' },
        data: { default: null },
      },
      leafText: (node) => `@${String(node.attrs.label)}`,
      parseDOM: [
        {
          tag: 'span[data-mention]',
          getAttrs: (dom) => {
            const e = dom as unknown as ElementLike;
            return {
              kind: e.getAttribute('data-mention') || 'user',
              id: e.getAttribute('data-id'),
              label: (e.textContent ?? '').replace(/^@/, ''),
            };
          },
        },
      ],
      toDOM: (node): DOMOutputSpec => [
        'span',
        {
          'data-mention': String(node.attrs.kind),
          ...(node.attrs.id != null
            ? { 'data-id': String(node.attrs.id) }
            : null),
        },
        `@${String(node.attrs.label)}`,
      ],
    },
    attachment: {
      inline: true,
      group: 'inline',
      atom: true,
      selectable: true,
      attrs: {
        kind: { default: 'file' },
        id: { default: null },
        label: { default: '' },
        data: { default: null },
      },
      leafText: (node) => `[${String(node.attrs.label)}]`,
      parseDOM: [
        {
          tag: 'span[data-attachment]',
          getAttrs: (dom) => {
            const e = dom as unknown as ElementLike;
            return {
              kind: e.getAttribute('data-attachment') || 'file',
              id: e.getAttribute('data-id'),
              label: (e.textContent ?? '').replace(/^\[|\]$/g, ''),
            };
          },
        },
      ],
      toDOM: (node): DOMOutputSpec => [
        'span',
        {
          'data-attachment': String(node.attrs.kind),
          ...(node.attrs.id != null
            ? { 'data-id': String(node.attrs.id) }
            : null),
        },
        `[${String(node.attrs.label)}]`,
      ],
    },
  },
  marks: {},
});

/** A mention or an attachment, as `composerParts` reads it. */
export interface ComposerAtom {
  type: 'mention' | 'attachment';
  kind: string;
  id: string | null;
  label: string;
  /** The app's own: a paste's text, an image's bytes, a person's record. */
  data: unknown;
  /** What the atom is in `text` as: `@label`, `[label]`. */
  token: string;
  /** Where `token` starts in `text`. */
  at: number;
}

/** A document, read on submit. */
export interface ComposerParts {
  /** The value, as `format="text"` writes it: each atom its token. */
  text: string;
  mentions: ComposerAtom[];
  attachments: ComposerAtom[];
}

/**
 * The text and the atoms of a document, for an app to send: `text` is the
 * value exactly as `format="text"` writes it, and each mention and
 * attachment says what it is and where its token is in that text — so an
 * app can send the pasted text in its place, or the image beside it.
 * Atoms of another schema's own are in the text as their `leafText`, and in
 * neither list.
 */
export function composerParts(doc: PMNode): ComposerParts {
  // ProseMirror's `textBetween`, followed step by step so that each atom's
  // place in the text is known: a line feed before every textblock but the
  // first, and a leaf's text where it is
  let text = '';
  let first = true;
  const mentions: ComposerAtom[] = [];
  const attachments: ComposerAtom[] = [];
  doc.nodesBetween(0, doc.content.size, (node) => {
    let own = '';
    if (node.isText) own = node.text ?? '';
    else if (node.isLeaf) {
      own =
        node.type.name === 'hard_break' || node.type.name === 'hardBreak'
          ? '\n'
          : (node.type.spec.leafText?.(node) ?? '');
    }
    if (node.isBlock && ((node.isLeaf && own) || node.isTextblock)) {
      if (first) first = false;
      else text += '\n';
    }
    const name = node.type.name;
    if (name === 'mention' || name === 'attachment') {
      const atom: ComposerAtom = {
        type: name,
        kind: String(node.attrs.kind ?? ''),
        id: node.attrs.id == null ? null : String(node.attrs.id),
        label: String(node.attrs.label ?? ''),
        data: node.attrs.data ?? null,
        token: own,
        at: text.length,
      };
      (name === 'mention' ? mentions : attachments).push(atom);
    }
    text += own;
    return true;
  });
  return { text, mentions, attachments };
}

/** When a paste is long enough to be an attachment: more lines than
 *  `lines`, or more characters than `chars`. */
export interface PasteAsAttachment {
  lines?: number;
  chars?: number;
  /** An image on the clipboard with no text beside it is an attachment —
   *  its PNG bytes the `data`. Default true. */
  images?: boolean;
}

/** `pasteAsAttachment={true}`: ten lines, or two thousand characters. */
export const PASTE_DEFAULTS = { lines: 10, chars: 2000 } as const;

/** How many lines a paste is: its line feeds, and one more unless it ends
 *  on one. */
function lineCount(text: string): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

/** The next number for an attachment of `kind`: one past the highest the
 *  document holds, so a deleted one's number is not given twice. */
function nextNumber(doc: PMNode, kind: AttachmentKind): number {
  let top = 0;
  doc.descendants((node) => {
    if (node.type.name === 'attachment' && node.attrs.kind === kind) {
      const n = Number(node.attrs.id);
      if (Number.isFinite(n) && n > top) top = n;
    }
  });
  return top + 1;
}

/**
 * The attachment a paste becomes, or null when it is pasted as text: a
 * paste past `options`' size — `[Pasted text #1 +312 lines]` — or an image
 * with no text. A plain paste (Shift-Mod-V) of text is always text. Null too
 * where the schema has no `attachment` node.
 */
export function pasteAttachment(
  doc: PMNode,
  paste: { text: string | null; image: Uint8Array | null; plain: boolean },
  options: PasteAsAttachment,
): PMNode | null {
  const type = doc.type.schema.nodes.attachment;
  if (!type) return null;
  const { text, image, plain } = paste;
  if (text) {
    if (plain) return null;
    const lines = lineCount(text);
    const tooManyLines = options.lines !== undefined && lines > options.lines;
    const tooLong = options.chars !== undefined && text.length > options.chars;
    if (!tooManyLines && !tooLong) return null;
    const n = nextNumber(doc, 'paste');
    return type.create({
      kind: 'paste',
      id: String(n),
      label: `Pasted text #${n} +${lines} line${lines === 1 ? '' : 's'}`,
      data: text,
    });
  }
  if (image && options.images !== false) {
    const n = nextNumber(doc, 'image');
    return type.create({
      kind: 'image',
      id: String(n),
      label: `Image #${n}`,
      data: image,
    });
  }
  return null;
}
