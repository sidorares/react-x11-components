// Drag and drop: the document's half — what a drag out of the editor
// carries, what a drop of files becomes, and where a drop goes in.
//
// The gesture is core's (react-x11 docs/dnd.md): the editor's root element is
// a drag source and a drop target, and `./view.ts` answers its events. A drag
// out of the editor carries what a copy carries — HTML and text, for another
// application — and, for a drop in this app, the slice itself, live, under
// `SLICE_TYPE`: another editor, or this one, takes it whole, with no trip
// through HTML. A drop from anywhere else is read the way a paste is
// (./clipboard.ts). Either way it goes in where prosemirror-transform's
// `dropPoint` says it fits, and a move out of this same editor comes out of
// where it was first — `dropTransaction`, which is prosemirror-view's own
// drop, step for step.
import { Fragment, Slice } from 'prosemirror-model';
import type { Node as PMNode, ResolvedPos, Schema } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import type { EditorState, Transaction } from 'prosemirror-state';
import { dropPoint } from 'prosemirror-transform';
import type { EditorProps } from 'prosemirror-view';

/** The in-app payload: the slice a drag out of an editor carries. */
export const SLICE_TYPE = 'application/x-react-x11-richtext-slice';

/** What `SLICE_TYPE` carries: the slice, and the view it came out of. */
export interface DragPayload {
  readonly slice: Slice;
  readonly view: unknown;
  /** The copy modifier, as the drag's source last saw it: an in-app
   *  drop has none of its own. */
  readonly copy?: boolean;
}

/** What the editor takes a drop of: an editor's slice, HTML, text, links
 *  and files — core's names and groups (react-x11 `DropAccept`). */
export const DROP_TYPES: string[] = [
  SLICE_TYPE,
  'text/html',
  'text',
  'uris',
  'files',
];

/** A dropped file or link: a URI, and a local path when it is a file. */
export interface DroppedFile {
  uri: string;
  path?: string;
}

/** The part of core's `DropEvent` a drop is read from. */
export interface DropLike {
  x: number;
  y: number;
  types: string[];
  files: DroppedFile[];
  text?: string;
  items?: Record<string, unknown>;
  getData(type: string): Promise<Uint8Array | string>;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** What a drop tells its source it did, or null for a drop not taken. */
export type DropAnswer = 'move' | 'copy' | null;

/** What a drop's `getData` answered, as text. `TextDecoder` is reached
 *  through `globalThis`, the way src/maps/mvt.ts reaches it: `src/`
 *  compiles with no runtime's types (`types: []`), and every runtime
 *  react-x11 runs on has one. */
export function textOf(data: Uint8Array | string): string {
  if (typeof data === 'string') return data;
  const g = globalThis as {
    TextDecoder?: new (label?: string) => {
      decode(input: Uint8Array): string;
    };
  };
  return g.TextDecoder
    ? new g.TextDecoder('utf-8').decode(data)
    : String.fromCharCode(...data);
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

/** What a dropped file is called: the last part of its path, or of a
 *  `file:` URI; a link to anywhere else is its URI. */
function nameOf(file: DroppedFile): string {
  if (!file.path && !file.uri.startsWith('file:')) return file.uri;
  const tail = (file.path ?? file.uri).split(/[\\/]/).pop() || file.uri;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

/**
 * Files, or links, dropped from another application, as content: an image
 * as an image node — drawn by `renderImage` when there is one; the editor
 * fetches nothing — and anything else as its name linked to it, a space
 * between them. A schema without images or links says the name plainly.
 */
export function filesSlice(
  schema: Schema,
  files: readonly DroppedFile[],
  $at: ResolvedPos,
): Slice {
  const { image } = schema.nodes;
  const { link } = schema.marks;
  const marks = $at.marks().filter((m) => m.type !== link);
  const nodes: PMNode[] = [];
  files.forEach((file, i) => {
    const name = nameOf(file);
    if (i > 0) nodes.push(schema.text(' ', marks));
    if (image && IMAGE.test(name)) {
      nodes.push(image.create({ src: file.uri, alt: name }));
    } else {
      nodes.push(
        schema.text(
          name,
          link ? [...marks, link.create({ href: file.uri })] : marks,
        ),
      );
    }
  });
  return new Slice(Fragment.from(nodes), 0, 0);
}

/**
 * prosemirror-view's drop, as a transaction: `slice` put in where it fits
 * nearest `at` — after, for a move, the selection it was dragged out of is
 * taken out — and the selection set around what went in, or on it, when it
 * is one node that can be selected. Null when nothing would change.
 */
export function dropTransaction(
  state: EditorState,
  slice: Slice,
  at: number,
  move: boolean,
): Transaction | null {
  const insertAt = dropPoint(state.doc, at, slice) ?? at;
  const tr = state.tr;
  if (move) tr.deleteSelection();
  const pos = tr.mapping.map(insertAt);
  const node =
    slice.openStart === 0 &&
    slice.openEnd === 0 &&
    slice.content.childCount === 1
      ? slice.content.firstChild
      : null;
  const before = tr.doc;
  if (node) tr.replaceRangeWith(pos, pos, node);
  else tr.replaceRange(pos, pos, slice);
  if (tr.doc.eq(before)) return null;
  const $pos = tr.doc.resolve(pos);
  if (
    node &&
    NodeSelection.isSelectable(node) &&
    $pos.nodeAfter?.sameMarkup(node)
  ) {
    tr.setSelection(new NodeSelection($pos));
  } else {
    let end = tr.mapping.map(insertAt);
    tr.mapping.maps[tr.mapping.maps.length - 1].forEach(
      (_from, _to, _newFrom, newTo) => {
        end = newTo;
      },
    );
    tr.setSelection(TextSelection.between($pos, tr.doc.resolve(end)));
  }
  return tr.setMeta('uiEvent', 'drop');
}

type DomDragEvent = Parameters<NonNullable<EditorProps['handleDrop']>>[1];

/**
 * The DOM-shaped drop a `handleDrop` prop is handed: `clientX`/`clientY`
 * (logical window pixels, as `posAtCoords` takes them), the modifiers, and a
 * `dataTransfer` whose `getData` answers what was read — HTML, text, the
 * URI list — and whose `files` are the dropped `{ name, path, uri }`: paths
 * to read, not the DOM's `File`s.
 */
export function domDrop(
  ev: DropLike,
  html: string | null,
  text: string | null,
): DomDragEvent {
  const uris = ev.files.map((f) => f.uri).join('\r\n');
  return {
    clientX: ev.x,
    clientY: ev.y,
    shiftKey: ev.shiftKey,
    ctrlKey: ev.ctrlKey,
    altKey: ev.altKey,
    metaKey: ev.metaKey,
    dataTransfer: {
      types: [...ev.types],
      files: ev.files.map((f) => ({ name: nameOf(f), ...f })),
      getData: (type: string) =>
        type === 'text/html'
          ? (html ?? '')
          : type === 'text/uri-list'
            ? uris
            : type === 'text/plain' || type === 'text'
              ? (text ?? '')
              : '',
    },
    preventDefault() {},
    stopPropagation() {},
  } as unknown as DomDragEvent;
}
