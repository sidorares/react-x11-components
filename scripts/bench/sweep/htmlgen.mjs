// Synthetic documents for `htmlsweep.mjs`: each one leans on one part of
// <Html>'s engine, so a cost found in the corpus can be put to its feature
// and a fix measured on the case it is for. Deterministic by seed, like
// docgen.ts; a size is how many units of the feature a document holds, and
// `SIZES` names the everyday one and the stress one for each.

/** A small deterministic generator (mulberry32). */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'the of and to in is that for it as with was on be by this are from at or ' +
  'an have not which but all were when we there can more if will about one ' +
  'layout element style box line text frame paint render width height font ' +
  'block inline float table cell grid flex column row margin padding border ' +
  'selector cascade rule sheet value length percent pixel viewport window ' +
  'document parser token node child parent sibling ancestor descendant'
).split(' ');

function words(next, n) {
  const out = [];
  for (let i = 0; i < n; i += 1)
    out.push(WORDS[Math.floor(next() * WORDS.length)]);
  return out;
}

function sentence(next, n) {
  const w = words(next, n);
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return w.join(' ') + '.';
}

const page = (style, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style>` +
  `</head><body>${body}</body></html>`;

const BASE =
  'body{margin:0;padding:16px;font:16px/1.5 sans-serif;color:#222}' +
  'h2{font-size:20px;margin:16px 0 8px}';

/** Plain paragraphs: block flow and line breaking, nothing else. */
function text(n, next) {
  let body = '';
  for (let i = 0; i < n; i += 1) {
    if (i % 10 === 0) body += `<h2>${sentence(next, 4)}</h2>`;
    body += `<p>${Array.from({ length: 5 }, () => sentence(next, 8 + Math.floor(next() * 10))).join(' ')}</p>`;
  }
  return page(BASE + 'p{margin:0 0 12px}', body);
}

/** Paragraphs thick with inline elements: links, emphasis, code and spans
 *  with borders and padding — the inline box model. */
function inline(n, next) {
  const tags = [
    (w) => `<a href="#x">${w}</a>`,
    (w) => `<b>${w}</b>`,
    (w) => `<em>${w}</em>`,
    (w) => `<code>${w}</code>`,
    (w) => `<span class="chip">${w}</span>`,
  ];
  let body = '';
  for (let i = 0; i < n; i += 1) {
    const w = words(next, 60);
    body +=
      '<p>' +
      w
        .map((x, k) =>
          k % 3 === 1 ? tags[Math.floor(next() * tags.length)](x) : x,
        )
        .join(' ') +
      '</p>';
  }
  return page(
    BASE +
      'p{margin:0 0 12px}a{color:#0645ad}code{font:14px monospace;background:#f3f3f3;padding:1px 3px}' +
      '.chip{border:1px solid #ccd;border-radius:4px;padding:0 4px;background:#eef}',
    body,
  );
}

/** One table of `n` rows and eight columns, sized by its content (the
 *  automatic table layout). */
function table(n, next) {
  let rows =
    '<tr>' +
    Array.from({ length: 8 }, (_, k) => `<th>col ${k}</th>`).join('') +
    '</tr>';
  for (let i = 0; i < n; i += 1) {
    rows +=
      '<tr>' +
      Array.from({ length: 8 }, (_, k) =>
        k === 0
          ? `<td>${i}</td>`
          : `<td>${words(next, 1 + Math.floor(next() * 4)).join(' ')}</td>`,
      ).join('') +
      '</tr>';
  }
  return page(
    BASE +
      'table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 6px;text-align:left}' +
      'tr:nth-child(even){background:#f6f6f6}',
    `<table>${rows}</table>`,
  );
}

/** Cards in nested flex rows, styled the way a utility framework styles
 *  them: many classes an element, each a declaration or two. */
function flex(n, next) {
  const util =
    '.flex{display:flex}.col{flex-direction:column}.wrap{flex-wrap:wrap}.gap-2{gap:8px}.gap-4{gap:16px}' +
    '.grow{flex:1 1 0%}.min-w-0{min-width:0}.items-center{align-items:center}.justify-between{justify-content:space-between}' +
    '.p-2{padding:8px}.p-4{padding:16px}.px-3{padding-left:12px;padding-right:12px}.py-1{padding-top:4px;padding-bottom:4px}' +
    '.rounded{border-radius:6px}.border{border:1px solid #e5e7eb}.bg-white{background:#fff}.bg-gray{background:#f9fafb}' +
    '.text-sm{font-size:14px;line-height:20px}.text-xs{font-size:12px;line-height:16px}.font-bold{font-weight:700}' +
    '.w-64{width:256px}.w-12{width:48px}.h-12{height:48px}.shrink-0{flex-shrink:0}.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.avatar{background:#c7d2fe;border-radius:9999px}.tag{background:#eef2ff;color:#3730a3;border-radius:4px}';
  let body = '<div class="flex wrap gap-4">';
  for (let i = 0; i < n; i += 1) {
    body +=
      '<div class="flex col gap-2 p-4 rounded border bg-white w-64">' +
      '<div class="flex items-center gap-2">' +
      '<div class="w-12 h-12 avatar shrink-0"></div>' +
      `<div class="flex col min-w-0 grow"><div class="font-bold truncate">${sentence(next, 3)}</div>` +
      `<div class="text-xs truncate">${sentence(next, 5)}</div></div></div>` +
      `<div class="text-sm">${sentence(next, 14)}</div>` +
      '<div class="flex wrap gap-2">' +
      words(next, 3)
        .map((w) => `<span class="tag px-3 py-1 text-xs">${w}</span>`)
        .join('') +
      '</div><div class="flex justify-between items-center text-xs">' +
      `<span>${i} items</span><span class="font-bold">${Math.floor(next() * 1000)}</span></div></div>`;
  }
  return page(BASE + util, body + '</div>');
}

/** A grid of cards whose columns fill the width. */
function grid(n, next) {
  let body = '<div class="g">';
  for (let i = 0; i < n; i += 1) {
    body += `<div class="c"><h3>${sentence(next, 3)}</h3><p>${sentence(next, 18)}</p><div class="f"><span>${i}</span><span>${words(next, 2).join(' ')}</span></div></div>`;
  }
  return page(
    BASE +
      '.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}' +
      '.c{display:grid;grid-template-rows:auto 1fr auto;border:1px solid #ddd;border-radius:8px;padding:12px}' +
      'h3{margin:0 0 6px;font-size:16px}p{margin:0;font-size:14px}.f{display:flex;justify-content:space-between;font-size:12px;color:#666}',
    body + '</div>',
  );
}

/** Articles with floated figures the text runs around. */
function float(n, next) {
  let body = '';
  for (let i = 0; i < n; i += 1) {
    const side = i % 2 ? 'r' : 'l';
    body += `<article><div class="fig ${side}" style="height:${60 + Math.floor(next() * 80)}px"></div>`;
    for (let k = 0; k < 3; k += 1)
      body += `<p>${Array.from({ length: 4 }, () => sentence(next, 10)).join(' ')}</p>`;
    body += '</article>';
  }
  return page(
    BASE +
      'article{overflow:hidden;margin-bottom:16px}p{margin:0 0 8px}.fig{width:160px;background:#dde;margin:4px 12px 8px}' +
      '.l{float:left}.r{float:right}',
    body,
  );
}

/** A framework's worth of rules over a document that reads them: classes,
 *  descendants, children, attributes, structural pseudo-classes and
 *  `:is()` — the cascade's matching. */
function selectors(n, next) {
  let css = BASE;
  const names = Array.from({ length: 40 }, (_, k) => `k${k}`);
  for (let r = 0; r < 2000; r += 1) {
    const a = names[r % 40];
    const b = names[(r * 7) % 40];
    const shape = r % 8;
    const sel =
      shape === 0
        ? `.${a}`
        : shape === 1
          ? `.${a} .${b}`
          : shape === 2
            ? `div > .${a}`
            : shape === 3
              ? `[data-k="${r % 50}"] .${b}`
              : shape === 4
                ? `.${a}:nth-child(${(r % 5) + 1})`
                : shape === 5
                  ? `section .${a} span`
                  : shape === 6
                    ? `:is(.${a}, .${b}) > p`
                    : `.${a}:not(.${b}) em`;
    css += `${sel}{margin-left:${r % 3}px}`;
  }
  let body = '';
  for (let i = 0; i < n; i += 1) {
    const cls = (k) =>
      names[Math.floor(next() * 40)] +
      (k ? ' ' + names[Math.floor(next() * 40)] : '');
    body +=
      `<section data-k="${i % 50}"><div class="${cls(1)}"><p class="${cls(0)}">` +
      words(next, 12)
        .map((w, k) =>
          k % 4 === 1 ? `<span class="${cls(0)}"><em>${w}</em></span>` : w,
        )
        .join(' ') +
      `</p><div class="${cls(1)}"><p>${sentence(next, 10)}</p></div></div></section>`;
  }
  return page(css, body);
}

/** Boxes taken out of the flow: positioned cards with z-indexes, each its
 *  own stacking context. */
function positioned(n, next) {
  let body =
    '<div class="stage" style="height:' + Math.ceil(n / 6) * 120 + 'px">';
  for (let i = 0; i < n; i += 1) {
    const x = (i % 6) * 150 + Math.floor(next() * 40);
    const y = Math.floor(i / 6) * 120 + Math.floor(next() * 40);
    body += `<div class="p" style="left:${x}px;top:${y}px;z-index:${Math.floor(next() * 10)}"><b>${i}</b> ${sentence(next, 6)}</div>`;
  }
  return page(
    BASE +
      '.stage{position:relative}.p{position:absolute;width:170px;padding:8px;background:#fff;border:1px solid #bbb;font-size:13px}',
    body + '</div>',
  );
}

/** What costs paint and not layout: rounded corners, shadows, gradients,
 *  borders of several colours. */
function paint(n, next) {
  let body = '<div class="w">';
  for (let i = 0; i < n; i += 1) {
    body += `<div class="card s${i % 4}"><div class="hd">${sentence(next, 3)}</div><p>${sentence(next, 12)}</p><span class="pill">${words(next, 1)}</span></div>`;
  }
  return page(
    BASE +
      '.w{display:flex;flex-wrap:wrap;gap:20px}.card{width:200px;padding:12px;border-radius:12px;background:linear-gradient(135deg,#fff,#eef)}' +
      '.s0{box-shadow:0 2px 8px rgba(0,0,0,.25)}.s1{box-shadow:0 0 0 1px #99a,0 8px 24px rgba(0,0,40,.3)}' +
      '.s2{border:3px solid;border-color:#c33 #3c3 #33c #cc3}.s3{box-shadow:inset 0 0 12px rgba(0,0,0,.3);border:1px dashed #888}' +
      '.hd{font-weight:700;padding-bottom:6px;border-bottom:1px solid rgba(0,0,0,.1)}p{margin:6px 0;font-size:14px}' +
      '.pill{display:inline-block;border-radius:999px;padding:2px 10px;background:radial-gradient(circle,#ffd,#fc9);box-shadow:0 1px 2px #0003}',
    body + '</div>',
  );
}

/** Elements animating on the document's clock: a turn and a fade each. */
function anim(n, next) {
  let body = '<div class="w">';
  for (let i = 0; i < n; i += 1) {
    body += `<div class="a" style="animation-delay:-${Math.floor(next() * 900)}ms">${words(next, 2).join(' ')}</div>`;
  }
  return page(
    BASE +
      '@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{50%{opacity:.4}}' +
      '.w{display:flex;flex-wrap:wrap;gap:12px}.a{width:90px;height:40px;background:#cde;border-radius:6px;' +
      'animation:spin 2s linear infinite,pulse 900ms ease-in-out infinite;font-size:12px}',
    body + '</div>',
  );
}

export const FEATURES = {
  text,
  inline,
  table,
  flex,
  grid,
  float,
  selectors,
  positioned,
  paint,
  anim,
};

/** The everyday size and the stress size of each feature, in its units. */
export const SIZES = {
  text: [40, 1500],
  inline: [30, 1200],
  table: [50, 2000],
  flex: [24, 800],
  grid: [24, 800],
  float: [12, 400],
  selectors: [30, 1000],
  positioned: [30, 1200],
  paint: [24, 600],
  anim: [12, 200],
};

/** The document for `feature` at `size` units, the same for a seed. */
export function generate(feature, size, seed = 1) {
  return FEATURES[feature](size, rng(seed));
}
