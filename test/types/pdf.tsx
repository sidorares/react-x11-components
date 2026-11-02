// Type-level test: the declarations compile against react-x11's JSX
// namespace, both as a component and as the raw `<pdfview>` element the
// component's augmentation adds.
import { createRef } from 'react';

import { Pdf, PdfOpenError } from '../../src/index.js';
import type {
  PageLink,
  PageText,
  PdfEngine,
  PdfFit,
  PdfHandle,
  PdfInfo,
  PdfOutlineItem,
  PdfStatus,
  PdfViewStats,
} from '../../src/index.js';

const data = new Uint8Array(0);
const ref = createRef<PdfHandle>();

export const asComponent = (
  <box style={{ flexGrow: 1 }}>
    <Pdf
      ref={ref}
      data={data}
      password="secret"
      defaultZoom="width"
      ground="#333333"
      thumb="#888888"
      gap={8}
      cacheBytes={64 * 1024 * 1024}
      onLoad={(info: PdfInfo) => console.log(info.pages.length, info.title)}
      onError={(error: Error) => console.log(error.message)}
      onStatus={(status: PdfStatus) => console.log(status)}
      onPageChange={(page: number) => console.log(page)}
      onZoomChange={(zoom: number) => console.log(zoom)}
      onLink={({ url, page }) => console.log(url, page)}
      fallback={({ status, error }) => (
        <text>
          {status} {error?.message}
        </text>
      )}
      style={{ margin: 4 }}
    />
  </box>
);

// the minimal form: `null` while the application is still reading the file
export const minimal = <Pdf data={null} />;

// the raw element the component registers
export const asElement = (
  <pdfview defaultZoom={1.5} ground="#333333" style={{ flexGrow: 1 }} />
);

// the handle
export async function handle(pdf: PdfHandle): Promise<string> {
  const fit: PdfFit = 'page';
  pdf.fit(fit);
  pdf.zoomTo(pdf.pageCount > 10 ? 0.5 : 1);
  pdf.scrollToPage(pdf.outline[0]?.page ?? 0);
  const stats: PdfViewStats | undefined = pdf.node?.stats;
  console.log(stats?.tilesDrawn);
  return pdf.selectedText();
}

// an engine of one's own is a value of the interface, nothing more
export const engine: PdfEngine = {
  open: async (): Promise<PdfInfo> => ({
    handle: 1,
    pages: [{ width: 612, height: 792 }],
    outline: [] satisfies PdfOutlineItem[],
    title: '',
  }),
  render: async () => null,
  text: async (): Promise<PageText> => ({
    text: '',
    boxes: new Float32Array(0),
  }),
  links: async (): Promise<PageLink[]> => [],
  close: () => {},
};

export const refused = new PdfOpenError('password', 'needs one').code;
