// Four DOM names ProseMirror's declarations use and this repository's program
// does not otherwise have.
//
// `lib` here has no `DOM`, on purpose, and `skipLibCheck` is off, on purpose
// (tsconfig.json) — so a dependency's declarations are checked against what
// this program declares. @types/react already stubs most of the DOM with
// empty interfaces for exactly this situation; ProseMirror reaches four names
// past those. None of them is used by anything here at run time: the view is
// ours and draws no DOM (docs/prd-rich-text-editor.md).
//
// A script file (no imports, no exports), so these are global — and a
// declaration file in `src/`, so the build reads it and emits nothing: it
// does not ship into an app's program. That is also why the editor is not in
// the barrel (`src/index.ts`): an app that imports anything from the barrel
// must not inherit ProseMirror's DOM-typed declarations; one that imports
// `@react-x11/components/rich-text-editor` brings the DOM lib, these four
// lines, or `skipLibCheck` — the editor's docs page says which.

interface ShadowRoot {}
interface MutationRecord {}
interface HTMLElementEventMap {}
/** Only ever read as `InstanceType<typeof window.Node>`. */
declare var window: { readonly Node: new () => object };
