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

export function htmlDoc(secs: Section[], framework = ''): string {
  return (
    `<!doctype html><html><head><title>A generated report</title><style>${framework}${HTML_STYLE}</style></head><body><h1>A generated report</h1>\n` +
    secs.map(htmlSection).join('\n') +
    '\n</body></html>'
  );
}

// --- a framework's stylesheet ---------------------------------------------

const HUES: Record<string, number> = {
  slate: 257,
  gray: 264,
  zinc: 286,
  red: 25,
  orange: 47,
  amber: 70,
  yellow: 86,
  lime: 128,
  green: 149,
  emerald: 163,
  teal: 182,
  cyan: 215,
  sky: 237,
  blue: 259,
  indigo: 277,
  violet: 293,
  purple: 304,
  fuchsia: 322,
  pink: 354,
  rose: 16,
};
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

function theme(): string {
  const out: string[] = [];
  for (const [name, hue] of Object.entries(HUES)) {
    SHADES.forEach((shade, i) => {
      const l = (98 - i * 8.2).toFixed(1);
      const c = (0.01 + Math.sin((i / 10) * Math.PI) * 0.2).toFixed(3);
      out.push(`--color-${name}-${shade}: oklch(${l}% ${c} ${hue});`);
    });
  }
  out.push(
    '--color-white: #fff;',
    '--color-black: #000;',
    '--font-sans: ui-sans-serif, system-ui, sans-serif;',
    '--spacing: 0.25rem;',
    '--text-xs: 0.75rem;',
    '--text-xs--line-height: calc(1 / 0.75);',
    '--text-sm: 0.875rem;',
    '--text-sm--line-height: calc(1.25 / 0.875);',
    '--text-base: 1rem;',
    '--text-base--line-height: calc(1.5 / 1);',
    '--text-lg: 1.125rem;',
    '--text-lg--line-height: calc(1.75 / 1.125);',
    '--text-2xl: 1.5rem;',
    '--text-2xl--line-height: calc(2 / 1.5);',
    '--font-weight-medium: 500;',
    '--font-weight-semibold: 600;',
    '--radius-md: 0.375rem;',
    '--radius-lg: 0.5rem;',
    '--radius-xl: 0.75rem;',
  );
  return `:root, :host { ${out.join(' ')} }`;
}

const PREFLIGHT = `
*, ::after, ::before, ::backdrop { box-sizing: border-box; margin: 0; padding: 0; border: 0 solid; }
html, :host { line-height: 1.5; -webkit-text-size-adjust: 100%; tab-size: 4; font-family: var(--font-sans); }
body { line-height: inherit; }
h1, h2, h3, h4, h5, h6 { font-size: inherit; font-weight: inherit; }
a { color: inherit; text-decoration: inherit; }
b, strong { font-weight: bolder; }
table { text-indent: 0; border-color: inherit; border-collapse: collapse; }
ol, ul, menu { list-style: none; }
img, svg, video { display: block; vertical-align: middle; }
img, video { max-width: 100%; height: auto; }
button, input { font: inherit; color: inherit; background-color: transparent; border-radius: 0; }
`;

const PROPERTIES = `
@supports ((-webkit-hyphens: none) and (not (margin-trim: inline))) or ((-moz-orient: inline) and (not (color: rgb(from red r g b)))) {
  *, ::before, ::after, ::backdrop {
    --tw-border-style: solid; --tw-font-weight: initial; --tw-shadow: 0 0 #0000; --tw-shadow-color: initial;
    --tw-shadow-alpha: 100%; --tw-inset-shadow: 0 0 #0000; --tw-inset-shadow-color: initial;
    --tw-inset-shadow-alpha: 100%; --tw-ring-color: initial; --tw-ring-shadow: 0 0 #0000;
    --tw-inset-ring-color: initial; --tw-inset-ring-shadow: 0 0 #0000; --tw-ring-inset: initial;
    --tw-ring-offset-width: 0px; --tw-ring-offset-color: #fff; --tw-ring-offset-shadow: 0 0 #0000;
    --tw-leading: initial; --tw-tracking: initial; --tw-space-y-reverse: 0; --tw-space-x-reverse: 0;
    --tw-translate-x: 0; --tw-translate-y: 0; --tw-translate-z: 0; --tw-outline-style: solid;
    --tw-gradient-position: initial; --tw-gradient-from: #0000; --tw-gradient-via: #0000;
    --tw-gradient-to: #0000; --tw-gradient-stops: initial; --tw-gradient-from-position: 0%;
    --tw-gradient-via-position: 50%; --tw-gradient-to-position: 100%;
  }
}`;

const SHADOW =
  'box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);';

function utilities(): string {
  const u: string[] = [];
  const sp = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16];
  const key = (n: number) => String(n).replace('.', '\\.');
  for (const n of sp) {
    u.push(`.p-${key(n)} { padding: calc(var(--spacing) * ${n}); }`);
    u.push(`.px-${key(n)} { padding-inline: calc(var(--spacing) * ${n}); }`);
    u.push(`.py-${key(n)} { padding-block: calc(var(--spacing) * ${n}); }`);
    u.push(`.gap-${key(n)} { gap: calc(var(--spacing) * ${n}); }`);
    u.push(`.mt-${key(n)} { margin-top: calc(var(--spacing) * ${n}); }`);
    u.push(
      `.size-${key(n)} { width: calc(var(--spacing) * ${n}); height: calc(var(--spacing) * ${n}); }`,
    );
    u.push(
      `.space-y-${key(n)} { :where(& > :not(:last-child)) { --tw-space-y-reverse: 0; margin-block-start: calc(calc(var(--spacing) * ${n}) * var(--tw-space-y-reverse)); margin-block-end: calc(calc(var(--spacing) * ${n}) * calc(1 - var(--tw-space-y-reverse))); } }`,
    );
  }
  for (const [name] of Object.entries(HUES)) {
    for (const shade of SHADES) {
      u.push(
        `.text-${name}-${shade} { color: var(--color-${name}-${shade}); }`,
      );
      u.push(
        `.bg-${name}-${shade} { background-color: var(--color-${name}-${shade}); }`,
      );
      u.push(
        `.ring-${name}-${shade} { --tw-ring-color: var(--color-${name}-${shade}); }`,
      );
      u.push(
        `.hover\\:bg-${name}-${shade} { &:hover { @media (hover: hover) { background-color: var(--color-${name}-${shade}); } } }`,
      );
    }
  }
  u.push(
    '.flex { display: flex; }',
    '.grid { display: grid; }',
    '.hidden { display: none; }',
    '.flex-1 { flex: 1; }',
    '.flex-col { flex-direction: column; }',
    '.items-center { align-items: center; }',
    '.justify-between { justify-content: space-between; }',
    '.min-w-0 { min-width: calc(var(--spacing) * 0); }',
    '.grid-cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }',
    '.sm\\:grid-cols-2 { @media (width >= 40rem) { grid-template-columns: repeat(2, minmax(0, 1fr)); } }',
    '.lg\\:grid-cols-4 { @media (width >= 64rem) { grid-template-columns: repeat(4, minmax(0, 1fr)); } }',
    '.rounded-md { border-radius: var(--radius-md); }',
    '.rounded-lg { border-radius: var(--radius-lg); }',
    '.rounded-xl { border-radius: var(--radius-xl); }',
    '.rounded-full { border-radius: calc(infinity * 1px); }',
    '.bg-white { background-color: var(--color-white); }',
    '.text-xs { font-size: var(--text-xs); line-height: var(--tw-leading, var(--text-xs--line-height)); }',
    '.text-sm { font-size: var(--text-sm); line-height: var(--tw-leading, var(--text-sm--line-height)); }',
    '.text-lg { font-size: var(--text-lg); line-height: var(--tw-leading, var(--text-lg--line-height)); }',
    '.text-2xl { font-size: var(--text-2xl); line-height: var(--tw-leading, var(--text-2xl--line-height)); }',
    '.font-medium { --tw-font-weight: var(--font-weight-medium); font-weight: var(--font-weight-medium); }',
    '.font-semibold { --tw-font-weight: var(--font-weight-semibold); font-weight: var(--font-weight-semibold); }',
    '.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    `.shadow-sm { --tw-shadow: 0 1px 3px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 1px 2px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1)); ${SHADOW} }`,
    `.ring-1 { --tw-ring-shadow: var(--tw-ring-inset,) 0 0 0 calc(1px + var(--tw-ring-offset-width)) var(--tw-ring-color, currentcolor); ${SHADOW} }`,
    '.ring-inset { --tw-ring-inset: inset; }',
    '.border-b { border-bottom-style: var(--tw-border-style); border-bottom-width: 1px; }',
    '.border-slate-200 { border-color: var(--color-slate-200); }',
    '.bg-linear-to-r { --tw-gradient-position: to right in oklab; background-image: linear-gradient(var(--tw-gradient-stops)); }',
    '.from-sky-500 { --tw-gradient-from: var(--color-sky-500); --tw-gradient-stops: var(--tw-gradient-via-stops, var(--tw-gradient-position), var(--tw-gradient-from) var(--tw-gradient-from-position), var(--tw-gradient-to) var(--tw-gradient-to-position)); }',
    '.to-indigo-500 { --tw-gradient-to: var(--color-indigo-500); --tw-gradient-stops: var(--tw-gradient-via-stops, var(--tw-gradient-position), var(--tw-gradient-from) var(--tw-gradient-from-position), var(--tw-gradient-to) var(--tw-gradient-to-position)); }',
  );
  return u.join('\n');
}

/**
 * A stylesheet shaped the way Tailwind 4's output is — a theme of custom
 * properties in oklch, four layers, preflight, the `@supports` block that
 * sets thirty-five `--tw-*` properties on every element, and utilities in
 * `var()`, `calc()`, nesting and media ranges — for `DOC=tailwind`: the
 * report under a framework's stylesheet, in layers, so its own unlayered
 * rules still win and it looks the same. About 90 KB.
 */
export function tailwindStylesheet(): string {
  return `@layer theme, base, components, utilities;
@layer theme { ${theme()} }
@layer base { ${PREFLIGHT} }
@layer properties { ${PROPERTIES} }
@layer utilities { ${utilities()} }`;
}
