// Run with: npm run examples:pdf -- <file.pdf>   (needs a display, and
// `@embedpdf/pdfium` installed — it is an optional peer: `npm i @embedpdf/pdfium`)
//
// A PDF, drawn. Wheel to scroll, Ctrl+wheel or Ctrl +/- to zoom, Ctrl+0 to fit
// the width, drag to select and Ctrl+C to copy, click a link. The toolbar shows
// what the document says of itself; the outline is the document's.
//
// The file is read here because `<Pdf>` reads nothing: what it is handed is
// bytes, and a link outside the document goes nowhere until `onLink` sends it.
import { readFileSync } from 'node:fs';
import { useMemo, useRef, useState } from 'react';
import { Button, createRoot } from 'react-x11';

import { Pdf } from '../src/pdf/index.js';
import type { PdfHandle, PdfInfo, PdfOutlineItem } from '../src/pdf/index.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run examples:pdf -- <file.pdf>');
  process.exit(2);
}

function Outline(props: {
  items: readonly PdfOutlineItem[];
  depth: number;
  go: (page: number) => void;
}) {
  return (
    <>
      {props.items.slice(0, 200).map((item, i) => (
        <box key={i} style={{ flexDirection: 'column' }}>
          <box
            style={{
              paddingLeft: 8 + props.depth * 12,
              paddingTop: 3,
              paddingBottom: 3,
            }}
            onClick={() => item.page >= 0 && props.go(item.page)}
          >
            <text style={{ fontSize: 12 }}>{item.title}</text>
          </box>
          {props.depth < 1 ? (
            <Outline
              items={item.children}
              depth={props.depth + 1}
              go={props.go}
            />
          ) : null}
        </box>
      ))}
    </>
  );
}

function App() {
  const data = useMemo(() => new Uint8Array(readFileSync(file!)), []);
  const ref = useRef<PdfHandle>(null);
  const [info, setInfo] = useState<PdfInfo | null>(null);
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  return (
    <window
      width={1100}
      height={820}
      title={info?.title || file!}
      style={{ flexDirection: 'column' }}
    >
      <box
        style={{
          flexDirection: 'row',
          gap: 8,
          padding: 6,
          alignItems: 'center',
        }}
      >
        <text style={{ flexGrow: 1 }}>
          {info
            ? `Page ${page + 1} of ${info.pages.length} · ${Math.round(zoom * 100)}%`
            : 'Opening…'}
        </text>
        <Button onClick={() => ref.current?.zoomTo(zoom / 1.25)}>−</Button>
        <Button onClick={() => ref.current?.zoomTo(zoom * 1.25)}>+</Button>
        <Button onClick={() => ref.current?.fit('width')}>Fit width</Button>
        <Button onClick={() => ref.current?.fit('page')}>Fit page</Button>
      </box>
      <box style={{ flexDirection: 'row', flexGrow: 1 }}>
        {info && info.outline.length > 0 ? (
          <box
            style={{
              width: 240,
              flexShrink: 0,
              flexDirection: 'column',
              overflow: 'scroll',
            }}
          >
            <Outline
              items={info.outline}
              depth={0}
              go={(to) => ref.current?.scrollToPage(to)}
            />
          </box>
        ) : null}
        <Pdf
          ref={ref}
          data={data}
          onLoad={setInfo}
          onPageChange={setPage}
          onZoomChange={setZoom}
          onLink={({ url }) => url && console.log('link:', url)}
          fallback={({ status, error }) => (
            <text style={{ padding: 16 }}>
              {status === 'unavailable'
                ? 'Install @embedpdf/pdfium to read PDFs.'
                : status === 'password'
                  ? 'This document needs a password.'
                  : `Could not read this document: ${error?.message}`}
            </text>
          )}
        />
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
