// A large document, generated, in two spellings: the same sections as GFM
// markdown and as HTML with a stylesheet. Deterministic: the same seed and
// size give byte-identical sources, so two runs measure the same document.
//
// A section is what a long technical page is made of — a heading, paragraphs
// with inline bold/italic/code/links, a list (nested every few sections), a
// table every fifth, a fenced code block every third, a quote every seventh.

const WORDS = (
  'the renderer lays each paragraph out against the width it is given and ' +
  'wraps it where the words allow a frame is the unit of work every pass ' +
  'reads what the last one left layout measures content floors before the ' +
  'real pass a scroll blits the surviving band and repaints the strip ' +
  'selection runs across blocks the cascade resolves every rule by ' +
  'specificity a table sizes its columns from their content text is shaped ' +
  'once per width and cached under the paragraph'
).split(' ');

export interface Section {
  title: string;
  paras: {
    text: string;
    spans: [kind: 'b' | 'i' | 'code' | 'a', from: number, to: number][];
  }[];
  list: string[][];
  table: string[][] | null;
  code: string | null;
  quote: string | null;
}

export function sections(count: number, seed = 1): Section[] {
  let s = seed >>> 0 || 1;
  const rand = () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 0x100000000;
  };
  const words = (n: number) =>
    Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]);
  const out: Section[] = [];
  for (let i = 0; i < count; i++) {
    const paras = Array.from({ length: 3 }, () => {
      const w = words(55 + Math.floor(rand() * 40));
      const spans: Section['paras'][number]['spans'] = [];
      for (let k = 0; k < 4; k++) {
        const from = Math.floor(rand() * (w.length - 4));
        const kind = (['b', 'i', 'code', 'a'] as const)[k];
        spans.push([kind, from, from + 1 + Math.floor(rand() * 2)]);
      }
      // non-overlapping, in order
      spans.sort((a, b) => a[1] - b[1]);
      const clean: typeof spans = [];
      let end = -1;
      for (const sp of spans)
        if (sp[1] > end) {
          clean.push(sp);
          end = sp[2];
        }
      return { text: w.join(' '), spans: clean };
    });
    const list = Array.from({ length: 4 + Math.floor(rand() * 3) }, (_, k) =>
      i % 4 === 0 && k === 1
        ? [words(6).join(' '), words(5).join(' ')]
        : [words(8 + Math.floor(rand() * 8)).join(' ')],
    );
    const table =
      i % 5 === 0
        ? [
            ['Metric', 'Before', 'After', 'Note'],
            ...Array.from({ length: 5 }, () => [
              words(2).join(' '),
              `${Math.floor(rand() * 900)} ms`,
              `${Math.floor(rand() * 90)} ms`,
              words(4).join(' '),
            ]),
          ]
        : null;
    const code =
      i % 3 === 0
        ? Array.from(
            { length: 8 },
            (_, k) =>
              `  const ${WORDS[k % WORDS.length]}${k} = measure(node, ${k}); // ${words(4).join(' ')}`,
          ).join('\n')
        : null;
    const quote = i % 7 === 0 ? words(30).join(' ') : null;
    out.push({
      title: `${i + 1}. ${words(4).join(' ')}`,
      paras,
      list,
      table,
      code,
      quote,
    });
  }
  return out;
}

function inline(p: Section['paras'][number], md: boolean): string {
  const w = p.text.split(' ');
  const out: string[] = [];
  let at = 0;
  for (const [kind, from, to] of p.spans) {
    out.push(...w.slice(at, from));
    const t = w.slice(from, to).join(' ');
    if (md)
      out.push(
        kind === 'b'
          ? `**${t}**`
          : kind === 'i'
            ? `*${t}*`
            : kind === 'code'
              ? `\`${t}\``
              : `[${t}](https://example.com/${from})`,
      );
    else
      out.push(
        kind === 'b'
          ? `<strong>${t}</strong>`
          : kind === 'i'
            ? `<em>${t}</em>`
            : kind === 'code'
              ? `<code>${t}</code>`
              : `<a href="https://example.com/${from}">${t}</a>`,
      );
    at = to;
  }
  out.push(...w.slice(at));
  return out.join(' ');
}

export function markdownSection(sec: Section): string {
  const parts: string[] = [`## ${sec.title}`];
  for (const p of sec.paras) parts.push(inline(p, true));
  parts.push(
    sec.list
      .map((item) => `- ${item[0]}` + (item[1] ? `\n  - ${item[1]}` : ''))
      .join('\n'),
  );
  if (sec.table) {
    const [head, ...rows] = sec.table;
    parts.push(
      [
        `| ${head.join(' | ')} |`,
        `| ${head.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${r.join(' | ')} |`),
      ].join('\n'),
    );
  }
  if (sec.code) parts.push('```ts\n' + sec.code + '\n```');
  if (sec.quote) parts.push(`> ${sec.quote}`);
  return parts.join('\n\n');
}

export function htmlSection(sec: Section): string {
  const parts: string[] = [`<h2>${sec.title}</h2>`];
  for (const p of sec.paras) parts.push(`<p>${inline(p, false)}</p>`);
  parts.push(
    '<ul>' +
      sec.list
        .map(
          (item) =>
            `<li>${item[0]}` +
            (item[1] ? `<ul><li>${item[1]}</li></ul>` : '') +
            '</li>',
        )
        .join('') +
      '</ul>',
  );
  if (sec.table) {
    const [head, ...rows] = sec.table;
    parts.push(
      `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
    );
  }
  if (sec.code)
    parts.push(
      `<pre><code class="language-ts">${sec.code.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre>`,
    );
  if (sec.quote) parts.push(`<blockquote><p>${sec.quote}</p></blockquote>`);
  return `<section>${parts.join('\n')}</section>`;
}

export const HTML_STYLE = `
body { font-family: sans-serif; line-height: 1.45; color: #1d1d1f; margin: 16px; }
h1 { font-size: 26px; margin: 0 0 12px; }
h2 { font-size: 19px; margin: 22px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
p { margin: 0 0 10px; }
a { color: #0a64c8; text-decoration: none; }
code { font-family: monospace; background: #f2f2f4; padding: 0 3px; border-radius: 3px; }
pre { background: #f6f6f8; padding: 10px 12px; border-radius: 6px; overflow: hidden; }
pre code { background: transparent; padding: 0; }
ul { margin: 0 0 10px; padding-left: 22px; }
li { margin: 2px 0; }
table { border-collapse: collapse; margin: 8px 0 12px; }
th, td { border: 1px solid #d0d0d6; padding: 4px 8px; text-align: left; }
th { background: #f0f0f3; font-weight: 600; }
blockquote { margin: 8px 0; padding: 4px 12px; border-left: 3px solid #c8c8d0; color: #555; }
section { margin-bottom: 6px; }
`;

export function markdownDoc(secs: Section[]): string {
  return (
    `# A generated report\n\n` + secs.map(markdownSection).join('\n\n') + '\n'
  );
}

export function htmlDoc(secs: Section[]): string {
  return (
    `<!doctype html><html><head><title>A generated report</title><style>${HTML_STYLE}</style></head><body><h1>A generated report</h1>\n` +
    secs.map(htmlSection).join('\n') +
    '\n</body></html>'
  );
}
