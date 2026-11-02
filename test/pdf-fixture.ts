// A PDF written out by hand, so that what a test asserts of one is what it
// says here and no tool's idea of it. Base-14 fonts only, which PDFium has
// built in, and no compression. Not a `.test.ts` file.

export interface FixturePage {
  width: number;
  height: number;
  rotate?: number;
  /** The media box's corner, where it is not the origin. */
  origin?: [number, number];
  /** `[x, y, width, height, r, g, b]` in page space, 0–1 colours. */
  rects?: Array<[number, number, number, number, number, number, number]>;
  /** `[x, y, size, text]` in page space, in Helvetica. */
  text?: Array<[number, number, number, string]>;
  /** A link: `[x, y, width, height]` and a URI or a page to go to. */
  links?: Array<{
    rect: [number, number, number, number];
    url?: string;
    page?: number;
  }>;
}

export interface FixtureOptions {
  pages: FixturePage[];
  outline?: Array<{ title: string; page: number }>;
  title?: string;
}

const pdfString = (text: string): string =>
  `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;

export function makePdf(options: FixtureOptions): Uint8Array {
  const { pages, outline = [], title } = options;
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);
  const reserve = (): number => objects.push('');

  const catalog = reserve();
  const tree = reserve();
  const pageIds = pages.map(() => reserve());
  const font = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );

  pages.forEach((page, i) => {
    const [ox, oy] = page.origin ?? [0, 0];
    let stream = '';
    for (const [x, y, w, h, r, g, b] of page.rects ?? []) {
      stream += `${r} ${g} ${b} rg ${x} ${y} ${w} ${h} re f\n`;
    }
    for (const [x, y, size, text] of page.text ?? []) {
      stream += `0 0 0 rg BT /F1 ${size} Tf ${x} ${y} Td ${pdfString(text)} Tj ET\n`;
    }
    const contents = add(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
    const annots = (page.links ?? []).map((link) => {
      const [x, y, w, h] = link.rect;
      const goes =
        link.url !== undefined
          ? `/A << /S /URI /URI ${pdfString(link.url)} >>`
          : `/Dest [${pageIds[link.page ?? 0]} 0 R /Fit]`;
      return add(
        `<< /Type /Annot /Subtype /Link /Rect [${x} ${y} ${x + w} ${y + h}] /Border [0 0 0] ${goes} >>`,
      );
    });
    objects[pageIds[i]! - 1] =
      `<< /Type /Page /Parent ${tree} 0 R ` +
      `/MediaBox [${ox} ${oy} ${ox + page.width} ${oy + page.height}] ` +
      (page.rotate ? `/Rotate ${page.rotate} ` : '') +
      `/Contents ${contents} 0 R ` +
      `/Resources << /Font << /F1 ${font} 0 R >> >> ` +
      (annots.length
        ? `/Annots [${annots.map((a) => `${a} 0 R`).join(' ')}] `
        : '') +
      '>>';
  });

  let outlines = '';
  if (outline.length) {
    const root = reserve();
    const items = outline.map(() => reserve());
    outline.forEach((item, i) => {
      objects[items[i]! - 1] =
        `<< /Title ${pdfString(item.title)} /Parent ${root} 0 R ` +
        `/Dest [${pageIds[item.page]} 0 R /Fit] ` +
        (i > 0 ? `/Prev ${items[i - 1]} 0 R ` : '') +
        (i < items.length - 1 ? `/Next ${items[i + 1]} 0 R ` : '') +
        '>>';
    });
    objects[root - 1] =
      `<< /Type /Outlines /First ${items[0]} 0 R ` +
      `/Last ${items[items.length - 1]} 0 R /Count ${items.length} >>`;
    outlines = `/Outlines ${root} 0 R `;
  }

  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R ${outlines}>>`;
  objects[tree - 1] =
    `<< /Type /Pages /Count ${pages.length} ` +
    `/Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  const info = title ? add(`<< /Title ${pdfString(title)} >>`) : 0;

  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const start = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  out +=
    `trailer << /Size ${objects.length + 1} /Root ${catalog} 0 R ` +
    (info ? `/Info ${info} 0 R ` : '') +
    `>>\nstartxref\n${start}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
  return bytes;
}
