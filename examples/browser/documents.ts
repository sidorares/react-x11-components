// What a response is to this browser, and what it is shown with. HTML goes to
// `<Html>`, and so does what a little HTML can wrap (`pages.ts`): plain text
// and an image. JSON and XML are a tree, a PDF is `<Pdf>`, and a video or a
// sound a player (`viewers.tsx`), each what this package has for it. What none
// of them can show is offered to be saved, as a browser offers it, and so is
// what says it is a file whatever it is (`Content-Disposition: attachment`).
//
// Nothing here draws, so the chunk the viewers are in is loaded the first time
// a tab shows one.
import { parseDocument } from 'htmlparser2';
import type { Document as XmlDocument } from 'domhandler';

import { decodesImageType } from '../../src/html/image-types.js';
import { NetworkError } from '../../src/html/index.js';

/** What a response is shown as. */
export type DocumentKind =
  | 'html'
  | 'text'
  | 'image'
  | 'json'
  | 'xml'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'other';

/** A document that is not `<Html>`'s to draw. */
export type Viewer =
  | { kind: 'json'; value: unknown }
  | { kind: 'xml'; document: XmlDocument }
  | { kind: 'pdf'; bytes: Uint8Array }
  | { kind: 'video'; src: string; type: string }
  | { kind: 'audio'; src: string; type: string; name: string };

/**
 * The most of a PDF held to show it. It is held here and again in PDFium's
 * WebAssembly memory, which a pane bounds (`--wasm-max-mem-pages`): past this
 * it is offered to be saved, as a type nothing here shows is.
 */
export const MOST_PDF = 256 * 1024 * 1024;

export function kindOf(type: string, url: string): DocumentKind {
  // a drawing a window goes to is a document, whose scripts run, as a
  // browser's is, and no image: it answers `isXmlType`, and `<Html>` reads it
  if (
    type === 'text/html' ||
    type === 'application/xhtml+xml' ||
    type === 'image/svg+xml'
  ) {
    return 'html';
  }
  if (type === 'application/pdf' || type === 'application/x-pdf') return 'pdf';
  if (type.startsWith('image/')) {
    return decodesImageType(type) ? 'image' : 'other';
  }
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (
    type === 'application/json' ||
    type === 'text/json' ||
    type.endsWith('+json')
  ) {
    return 'json';
  }
  if (
    type === 'application/xml' ||
    type === 'text/xml' ||
    type.endsWith('+xml')
  ) {
    return 'xml';
  }
  if (type.startsWith('text/') || type === 'application/javascript') {
    return 'text';
  }
  // no type at all: what the address says, and HTML where it says nothing
  if (!type) {
    const path = url.split(/[?#]/)[0];
    if (/\.json$/i.test(path)) return 'json';
    if (/\.xml$/i.test(path)) return 'xml';
    if (/\.pdf$/i.test(path)) return 'pdf';
    if (/\.(mp4|m4v|mov|webm|mkv)$/i.test(path)) return 'video';
    if (/\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|aiff?)$/i.test(path)) {
      return 'audio';
    }
    return /\.(txt|md|css|js)$/i.test(path) ? 'text' : 'html';
  }
  return 'other';
}

/** JSON as a viewer has it, or null for text that says it is JSON and is not,
 *  which is shown as the text it is. */
export function readJson(text: string): Viewer | null {
  try {
    return { kind: 'json', value: JSON.parse(text) };
  } catch {
    return null;
  }
}

/**
 * Whether XML says how it is to look, and so is a document and no data for the
 * tree viewer (as Chrome's, `HasNoStyleInformation`): something in a language a
 * browser draws, or a style sheet of its own.
 */
export function drawsItself(text: string): boolean {
  return (
    /<\?xml-stylesheet\s/.test(text) ||
    /\sxmlns(?::[\w.-]+)?\s*=\s*["']http:\/\/www\.w3\.org\/(?:1999\/xhtml|2000\/svg|1998\/Math\/MathML)["']/.test(
      text,
    )
  );
}

/**
 * XML as a viewer has it, or null for what is not a document: htmlparser2
 * reads anything, so one root element and no text around it is what is asked.
 * It expands no entity it was not born knowing and reads no DTD, so a document
 * cannot grow as it is read or reach for a file.
 */
export function readXml(text: string): Viewer | null {
  const document = parseDocument(text, { xmlMode: true });
  const roots = document.children.filter((node) => node.type === 'tag');
  const loose = document.children.some(
    (node) => node.type === 'text' && node.data.trim(),
  );
  return roots.length === 1 && !loose ? { kind: 'xml', document } : null;
}

/** A body, whole. Past `limit` bytes it throws, as the network's does. */
export async function readAll(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  limit = Infinity,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    if (signal.aborted) break;
    size += chunk.length;
    if (size > limit) {
      throw new NetworkError(
        `The response is larger than ${limit} bytes.`,
        'ERR_FILE_TOO_BIG',
      );
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
