// The resolver seam: how `.qml` files find each other.
//
// The engine never touches a filesystem — it asks a `QmlResolver` for
// component sources and treats directory strings as opaque tokens only the
// resolver interprets. That keeps the engine host-neutral (the headless
// tests hand it plain objects) and makes "where do components come from"
// an app decision: a directory on disk, a bundle, an HTTP cache, a test
// fixture.
//
// Three ways a type name resolves, in Qt's precedence order:
//   1. the *implicit import* — `<Name>.qml` beside the document (no import
//      line at all, and a local `Button.qml` shadows a module's `Button`);
//   2. quoted-path imports — `import "./widgets"` brings in that
//      directory's components;
//   3. registered modules — `import QtQuick 2.15` and anything an app adds
//      with `registerQmlModule`.
// The first two exist only when a resolver is provided.

export interface QmlResolver {
  /** Where the root document lives — the starting directory for its
   * implicit import. Opaque to the engine. */
  rootDir: string;
  /** The source of `<name>.qml` in `dir`, or null when there is no such
   * component. Called often (every type name is probed here first, in
   * Qt's shadowing order) but cached by the engine per instantiation —
   * a plain `existsSync` + `readFileSync` implementation is fine. */
  load(dir: string, name: string): { source: string; fileName: string } | null;
  /** A quoted relative import (`"./widgets"`, `"../shared"`) resolved
   * against a document's directory. */
  join(dir: string, relative: string): string;
}

/** How a document was loaded — carried on `QmlDocument` so the types it
 * names can resolve relative to it. */
export interface DocLoad {
  resolver: QmlResolver;
  dir: string;
}

// --- the standard filesystem resolver --------------------------------------

interface FsModule {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface PathModule {
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
}

/**
 * Load a node builtin without naming it to the compiler — `src/` compiles
 * with `types: []` on purpose, and a literal `import('node:fs')` would
 * need `@types/node` in the build program (the `embed/host.ts` pattern).
 */
const builtins = new Map<string, Promise<unknown>>();
function builtin<T>(name: string): Promise<T> {
  let mod = builtins.get(name);
  if (!mod) {
    const specifier = name;
    mod = import(/* @vite-ignore */ specifier);
    builtins.set(name, mod);
  }
  return mod as Promise<T>;
}

/**
 * The standard filesystem resolver — pass the directory your root document
 * lives in:
 *
 *   const resolver = await createFileResolver(dirname(qmlPath));
 *   <QmlView source={source} file={qmlPath} resolver={resolver} />
 *
 * Async because the node builtins load through a dynamic import (the build
 * has no node types); the resolver it returns is fully synchronous. It
 * reads through on every engine request — no content cache — so a changed
 * sibling file is picked up on the next root reload; the engine's own
 * per-instantiation cache keeps a 1000-delegate ListView from re-reading
 * its component 1000 times.
 */
export async function createFileResolver(
  baseDir: string,
): Promise<QmlResolver> {
  const fs = await builtin<FsModule>('node:fs');
  const path = await builtin<PathModule>('node:path');
  const rootDir = path.resolve(baseDir);
  return {
    rootDir,
    load(dir, name) {
      const file = path.join(dir, `${name}.qml`);
      if (!fs.existsSync(file)) return null;
      return { source: fs.readFileSync(file, 'utf8'), fileName: file };
    },
    join(dir, relative) {
      return path.resolve(dir, relative);
    },
  };
}
