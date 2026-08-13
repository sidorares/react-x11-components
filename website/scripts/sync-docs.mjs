// Sync the repo's hand-written reference (docs/) into the website's
// docs/reference/ directory, which is gitignored and regenerated on every
// build (`prebuild`) and on `npm start`.
//
// The point is that there is exactly one copy of the documentation, in the
// repo, next to the code it describes — the site renders it rather than
// restating it. A doc edit lands on the site with no second write, and a page
// deleted from docs/ disappears here too, because the output tree is rebuilt
// from scratch.
//
// This repo's docs/ is README.md (the index), docs/components/ (one page per
// src/<name>/, which Docusaurus turns into a category via the committed
// _category_.json), and topic pages at the top level. For each markdown file
// this script:
//   - adds Docusaurus front matter (title from the first `# heading`, a
//     sidebar_position following the order below, and a custom_edit_url
//     pointing at the real source file, since the synced copy is not
//     committed);
//   - renames README.md -> index.md and rewrites links to it;
//   - keeps relative links to sibling pages and co-located assets intact,
//     and copies the assets through;
//   - rewrites relative links that escape docs/ (../AGENTS.md,
//     ../examples/foo.tsx) as absolute GitHub URLs;
//   - keeps the .md extension, so Docusaurus (with `markdown.format:
//     'detect'`) parses the files as CommonMark rather than MDX — the
//     reference is full of bare element names like <box> and of {braces},
//     neither of which is valid MDX.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoDir = path.dirname(websiteDir);
const srcDir = path.join(repoDir, 'docs');
const outDir = path.join(websiteDir, 'docs', 'reference');

const REPO = 'https://github.com/sidorares/react-x11-components';
const EDIT_BASE = `${REPO}/tree/master/docs/`;
const REPO_BASE = `${REPO}/tree/master/`;

/**
 * Extract the first `# Heading` as the page title. Code spans lose their
 * backticks: front matter is plain text, and the sidebar would otherwise say
 * "a VT backend for `<Terminal>`" with the marks in it.
 */
function extractTitle(markdown, fallback) {
  const m = markdown.match(/^#\s+(.+)$/m);
  if (!m) return fallback;
  return m[1].replace(/`+([^`]*)`+/g, '$1').trim();
}

/**
 * Rewrite one markdown link target for the new layout. `srcRel` is the source
 * file's path relative to the repo's docs/ directory.
 *   - absolute URLs and #anchors pass through;
 *   - *.md links stay relative (they move together); README.md is renamed to
 *     index.md, so links to it are renamed too;
 *   - links to files that exist inside docs/ (images) stay relative — the
 *     assets are copied into the output tree below;
 *   - anything else is a repo file outside docs/ (../AGENTS.md,
 *     ../examples/…): resolve it against the source file's repo location and
 *     point it at GitHub.
 */
function rewriteTarget(target, srcRel) {
  if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return target;
  const [file, anchor = ''] = target.split(/(?=#)/);
  const srcDirRel = path.posix.dirname(srcRel.split(path.sep).join('/'));
  const inDocs = path.posix.normalize(path.posix.join(srcDirRel, file));
  if (file.endsWith('.md') && !inDocs.startsWith('..')) {
    return `${file.replace(/README\.md$/, 'index.md')}${anchor}`;
  }
  if (!inDocs.startsWith('..') && fs.existsSync(path.join(srcDir, inDocs))) {
    return target;
  }
  const repoPath = path.posix.normalize(
    path.posix.join('docs', srcDirRel, file),
  );
  return `${REPO_BASE}${repoPath}${anchor}`;
}

/**
 * Apply `fn` to every line segment outside fenced code blocks and inline code
 * spans — both the link rewriter and the sanitizer must leave examples alone.
 */
function mapOutsideCode(markdown, fn) {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 === 1 ? part : fn(part)))
        .join('');
    })
    .join('\n');
}

function rewriteLinks(markdown, srcRel) {
  return mapOutsideCode(markdown, (text) =>
    text.replace(
      /(!?\]\()([^()\s]+)(\))/g,
      (all, open, target, close) =>
        `${open}${rewriteTarget(target, srcRel)}${close}`,
    ),
  );
}

/**
 * Guard against constructs CommonMark passes through as raw HTML: a bare
 * <box> or <foreign> outside a code span would silently vanish from the
 * rendered page. Wrap it in backticks. This is the single most common hazard
 * in docs that are all about elements named like tags.
 */
function sanitize(markdown) {
  return mapOutsideCode(markdown, (text) =>
    text.replace(
      /<(?!\/?(?:a|b|i|em|strong|code|pre|br|hr|img|sub|sup|table|thead|tbody|tr|td|th|ul|ol|li|p|div|span|details|summary|kbd)\b)(?!https?:)([A-Za-z_][\w.-]*)>/g,
      '`<$1>`',
    ),
  );
}

function frontMatter(fields) {
  const body = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) =>
      typeof v === 'string' ? `${k}: ${JSON.stringify(v)}` : `${k}: ${v}`,
    )
    .join('\n');
  return `---\n${body}\n---\n\n`;
}

function syncFile(srcRel, outRel, { title, sidebarPosition, slug } = {}) {
  const srcPath = path.join(srcDir, srcRel);
  const outPath = path.join(outDir, outRel);
  let markdown = fs.readFileSync(srcPath, 'utf8');
  markdown = sanitize(rewriteLinks(markdown, srcRel));
  const fm = frontMatter({
    title: title ?? extractTitle(markdown, path.basename(srcRel, '.md')),
    sidebar_position: sidebarPosition,
    slug,
    custom_edit_url: EDIT_BASE + srcRel.split(path.sep).join('/'),
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, fm + markdown);
}

/** Copy every non-markdown file in docs/ through: images, _category_.json. */
function copyAssets(dir = '') {
  let n = 0;
  for (const entry of fs.readdirSync(path.join(srcDir, dir), {
    withFileTypes: true,
  })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      n += copyAssets(rel);
    } else if (!entry.name.endsWith('.md')) {
      const outPath = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.copyFileSync(path.join(srcDir, rel), outPath);
      n++;
    }
  }
  return n;
}

// Regenerate from scratch so deletions in docs/ propagate.
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// Sidebar order within each directory. Components first in the order the
// README's tables use — roughly "what most apps reach for" — then the shared
// modules, then anything unlisted, alphabetically, so a new page shows up on
// the site the moment it is committed rather than being dropped.
const ORDER = [
  // docs/components/
  'calendar.md',
  'code.md',
  'code-editor.md',
  'markdown.md',
  'media-player.md',
  'terminal.md',
  'tray-host.md',
  'desktop-calendar.md',
  'richtext.md',
  'codeblock.md',
  'code-language.md',
  'embed.md',
  // docs/
  'prd-vt-terminal.md',
];

syncFile('README.md', 'index.md', {
  title: 'Overview',
  sidebarPosition: 1,
  slug: '/reference',
});

const byOrder = (a, b) => {
  const ia = ORDER.indexOf(a);
  const ib = ORDER.indexOf(b);
  return (
    (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib) ||
    a.localeCompare(b)
  );
};

// Sync one directory's markdown, then recurse. sidebar_position restarts per
// directory, because Docusaurus only compares positions within one category.
function syncDir(dir = '') {
  const entries = fs.readdirSync(path.join(srcDir, dir), {
    withFileTypes: true,
  });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .filter((name) => !(dir === '' && name === 'README.md'))
    .sort(byOrder);
  // The Overview is 1 and docs/components/ is 2 (its `_category_.json` says
  // so), so top-level topic pages start well clear of both.
  const base = dir === '' ? 20 : 2;
  files.forEach((name, i) => {
    const rel = path.join(dir, name);
    syncFile(rel, rel, { sidebarPosition: base + i });
  });
  return entries
    .filter((e) => e.isDirectory())
    .reduce((n, e) => n + syncDir(path.join(dir, e.name)), files.length);
}

const pages = syncDir();
const assets = copyAssets();

console.log(
  `sync-docs: wrote ${1 + pages} reference pages (+ ${assets} assets) to ` +
    path.relative(websiteDir, outDir),
);
