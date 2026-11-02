// What a document's file inputs are given: the seam `<Html>` asks when one is
// pressed.
//
// Nothing reaches the machine's files by itself. A press on `<input
// type=file>`, or a page's `click()` under a user's gesture, asks
// `onPickFiles`, and with none it does nothing: a component that shows a page
// opens no dialog for it. What a host answers with goes in the input, a form
// posts it and a page's script reads it, and nothing else of the disk is
// reachable from either.
//
// `useHtmlFilePicker()` is the host most applications want: core's file dialog
// and `readHtmlFiles`. A `<Frame>` pane on a Mac has no NSApplication to show a
// panel from, so a host that runs its pages in panes shows the dialog in its
// own process and has the pane read what was chosen, as the example browser
// does: what crosses is paths, and `readHtmlFiles` is what reads them.
import { useMemo } from 'react';
import { useFileDialog } from 'react-x11';

import type { Element } from './dom.js';

/** A file a document was given. */
export interface HtmlFile {
  name: string;
  /** Its MIME type, lowercase, or '' where nothing says. */
  type: string;
  /** Milliseconds since the epoch. */
  lastModified: number;
  bytes: Uint8Array;
}

/** What a file input asks for. */
export interface HtmlFileRequest {
  /** The input. */
  element: Element;
  /** Whether it takes more than one (`multiple`). */
  multiple: boolean;
  /** Its `accept`, a token each, lowercase: `.png`, `image/*`, a MIME type. */
  accept: string[];
}

/** Ask the user for files: what was chosen, or null where they cancelled. */
export type HtmlPickFiles = (
  request: HtmlFileRequest,
) => Promise<HtmlFile[] | null>;

/** What `accept`'s wildcards come to in extensions, since no file dialog on
 *  every backend reads `image/*` and a macOS panel reads none. */
const WILDCARDS: Record<string, string[]> = {
  'image/*': [
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'avif',
    'svg',
    'bmp',
    'ico',
    'tif',
    'tiff',
    'heic',
  ],
  'audio/*': ['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba'],
  'video/*': ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv', 'avi'],
};

/** Core's file dialog `filters` for what an input accepts, none where it
 *  names nothing: every file. */
export function acceptFilters(
  accept: readonly string[],
): { name: string; extensions?: string[]; mimeTypes?: string[] }[] {
  const extensions: string[] = [];
  const mimeTypes: string[] = [];
  for (const token of accept) {
    if (token.startsWith('.')) extensions.push(token.slice(1));
    else if (WILDCARDS[token]) extensions.push(...WILDCARDS[token]);
    else if (token.includes('/')) mimeTypes.push(token);
  }
  if (!extensions.length && !mimeTypes.length) return [];
  return [
    {
      name: 'Accepted files',
      ...(extensions.length && { extensions }),
      ...(mimeTypes.length && { mimeTypes }),
    },
  ];
}

/** The MIME types a file is taken for by its name's extension: what a
 *  browser's `File.type` is, since nothing on the disk says. */
const TYPES: Record<string, string> = {
  aac: 'audio/aac',
  avif: 'image/avif',
  bmp: 'image/bmp',
  css: 'text/css',
  csv: 'text/csv',
  flac: 'audio/flac',
  gif: 'image/gif',
  gz: 'application/gzip',
  heic: 'image/heic',
  htm: 'text/html',
  html: 'text/html',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  m4a: 'audio/mp4',
  md: 'text/markdown',
  mjs: 'text/javascript',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  ogv: 'video/ogg',
  opus: 'audio/opus',
  otf: 'font/otf',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  tar: 'application/x-tar',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ttf: 'font/ttf',
  txt: 'text/plain',
  wasm: 'application/wasm',
  wav: 'audio/wav',
  weba: 'audio/webm',
  webm: 'video/webm',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  xml: 'text/xml',
  zip: 'application/zip',
};

/** A file's MIME type by its name, or '' where its extension says none. */
export function fileTypeOf(name: string): string {
  const at = name.lastIndexOf('.');
  return (at > 0 && TYPES[name.slice(at + 1).toLowerCase()]) || '';
}

/** `node:fs`, reached as `src/embed/host.ts` reaches it: `src/` cannot name
 *  a module of node's, and an app that picks no file loads none of it. */
interface FsSlice {
  readFile(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<{ mtimeMs: number }>;
}
const FS = 'node:fs/promises';

/** The files at some paths, as a document takes them. */
export async function readHtmlFiles(
  paths: readonly string[],
): Promise<HtmlFile[]> {
  const fs = (await import(/* @vite-ignore */ FS)) as FsSlice;
  return Promise.all(
    paths.map(async (path) => {
      const name = path.slice(path.lastIndexOf('/') + 1);
      const [bytes, stat] = await Promise.all([
        fs.readFile(path),
        fs.stat(path),
      ]);
      return {
        name,
        type: fileTypeOf(name),
        lastModified: Math.round(stat.mtimeMs),
        bytes,
      };
    }),
  );
}

/**
 * The machine's files, as `onPickFiles` takes them: core's file dialog, on
 * whatever rung this machine has, and the files it answers with read. A host
 * whose documents are in a `<Frame>` pane shows its dialog itself: see the head
 * of this file.
 */
export function useHtmlFilePicker(): HtmlPickFiles {
  const { openFile } = useFileDialog();
  return useMemo(
    () => async (request) => {
      const paths = await openFile({
        multiple: request.multiple,
        filters: acceptFilters(request.accept),
      });
      return paths ? readHtmlFiles(paths) : null;
    },
    [openFile],
  );
}
