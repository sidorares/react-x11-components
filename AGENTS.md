# AGENTS.md

Guidance for AI agents (and new contributors) working on
`@react-x11/components`.

## What this package is

A collection of components for
[react-x11](https://github.com/sidorares/react-x11) that do **not** belong in
the core package. Everything here is built on react-x11's public API — the
built-in host elements, or the `registerElement` seam in `react-x11/host` —
so nothing here needs a change to core to exist, and core does not grow to
carry it.

Read react-x11's own `AGENTS.md` first for how the renderer works. This file
only covers what is different about living out here.

## What belongs here, and what belongs in core

This is the governing decision for the whole repository. When a change
arrives that adds something, the first question is not "how" but "where".

**It belongs in react-x11 (core) when any one of these holds:**

- the vast majority of UI apps use it; or
- it depends on react-x11 internals — implementing it externally would mean
  exposing details that should not be public, or compromising performance; or
- it needs enough standards compliance that the behaviour is hard to agree on
  or to implement piecemeal.

**It belongs in `@react-x11/components` when all of these hold:**

- a smaller fraction of apps need it;
- it can be built on the public react-x11 API — core host elements, or the
  "register a custom element" path;
- it is big enough that core would pay for it, in install closure or in
  maintenance.

### The boundary can run _through_ a feature

The most useful worked example is 3D, because the line does not fall between
two features but inside one:

- **`<glarea>` stays in core.** It is a real child X window on a GLX visual,
  created top-down in the commit phase. That is renderer internals; there is
  no public API it could be built on.
- **The scene graph over it does not.** `<mesh>`, `<group>`, geometry and
  material nodes, a Three.js / react-three-fiber-shaped layer, `Canvas3D` —
  all of that is composition over a public element, wanted by a small
  fraction of apps, and heavy. That is this package.

Apply the same cut before assuming a whole subsystem moves or stays. Ask
which part is standing on internals and which part is standing on the
element.

## Layout

- `src/<component>/` — **one directory per component.** Each has an
  `index.js` (the React component, and the `registerElement` call if it has
  one), `index.d.ts` (hand-written; nothing here is compiled), and whatever
  private modules it needs. No component imports another component.
- `src/index.js` — the convenience barrel. Re-exports only. Never put
  anything with a side effect here.
- `test/` — `node --test` files, one per component plus the repo-wide
  guards (`treeshake.test.js`, `package.test.js`).
- `test/types/` — type-level tests, compiled by `npm run typecheck`.
- `scripts/check-package.mjs` — the exports-map/publishability check that
  stands in for a build step.
- `examples/` — one runnable file per component. These need a real
  `$DISPLAY`; CI does not run them.

`src/sparkline/` is the worked example of all of the above, and deliberately
small. It is also the element react-x11's own `docs/extending.md` uses to
illustrate `registerElement`, now shipped for real.

## Tree-shaking is a constraint, not a nice-to-have

An app that uses one component and a bundler must pay for one component.
That is a promise the package makes, so it is enforced by
`test/treeshake.test.js` rather than left to good intentions.

What that means in practice:

1. **`"sideEffects": false` stays true.** Every module must be safe to drop
   when nothing imports its exports.
2. **A component registers its element in its own `index.js`, at module
   scope.** That is the one side effect the design relies on, and it is fine
   precisely because it lives in the module a bundler keeps only when the
   component is used. Hoisting a registration into `src/index.js` is the
   single edit that would drag every component into every bundle.
3. **Every component gets its own subpath export.** `check-package.mjs`
   fails the build if a `src/<name>/index.js` has no `./<name>` entry — the
   no-bundler and the deep-import cases both need it.
4. **No component imports another component.** Shared code goes in a shared
   module that both import; a lateral import makes two components one unit.
5. **No side effects at import time anywhere else.** No eager theme install,
   no feature probe, no registry warm-up.

The first tree-shaking test is the one that actually catches regressions:
importing the barrel for _no_ exports must bundle to nothing.

## react-x11 is a peer dependency, and it has to be

`react-x11` and `react` are `peerDependencies`, never regular ones. This is
not style. `registerElement` mutates module-level state inside react-x11 —
the registry `Map`, and the `DRAWN_KINDS` set that `paintOrder()` filters
on. Two copies of react-x11 in one app means the registration lands in one
copy and the render happens in the other, and the symptom is an element that
lays out correctly, reports a sensible rect, and never paints, with no error
anywhere.

### Current status: core is unreleased

The subpaths this package imports — `react-x11/host`, `/node`, `/style`,
`/test` — do not exist in the published react-x11 1.2.0. They are on
`master`, unreleased. So:

- `peerDependencies.react-x11` is `^2.0.0` — the version core will cut next
  (there are breaking changes queued on master, so release-please will go to
  2.0.0, not 1.3.0).
- `devDependencies.react-x11` is `github:sidorares/react-x11#master`, which
  is what makes the suite runnable and CI green today.

**When core publishes 2.0.0, change the devDependency to `^2.0.0` and drop
the git URL.** Nothing else should need touching.

## Commands

```bash
npm test              # node --test — no X server, no $DISPLAY needed
npm run lint          # eslint
npm run format        # prettier --write
npm run format:check  # what CI runs
npm run typecheck     # tsc over src/**/*.d.ts and test/types/
npm run check:package # exports map + tree-shaking contract; the "build"
npm run examples:sparkline   # needs a real $DISPLAY
```

Tests are headless: react-x11's harness runs node-x11's pure-JavaScript X
server in-process. Use `{ backend: 'mock' }` unless a test genuinely needs
real pixels — the mock context has no path API, which is why a component's
`paint` should skip drawing rather than throw when it is missing.

## Adding a component

1. Check it against the split criteria above. If it belongs in core, say so
   and stop.
2. `src/<name>/` with `index.js` and `index.d.ts`.
3. Add the `./<name>` subpath to `exports`, and the re-export to
   `src/index.js` and `src/index.d.ts`.
4. Add its entry to `COMPONENTS` in `test/treeshake.test.js` — export name
   plus a string only that component's modules contain. The "one component
   does not drag in the others" test is a loop over that list, so a missing
   entry silently drops the component out of the guard.
5. Tests in `test/<name>.test.js`, type tests in `test/types/<name>.tsx`, an
   example in `examples/<name>.jsx`.
6. If it registers an element, declare it to JSX in the component's
   `index.d.ts` — the `declare module 'react-x11/jsx-runtime'` augmentation.

## Incoming: what is planned to move here

Nothing below has moved yet. The table is the running decision record, so
that "should this move?" is not re-litigated from scratch each time.

| Candidate                                        | Where it is now                                          | Status                                                                                                                                                |
| ------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<markdown>`, `<html>`                           | react-x11 `src/richnodes.js`, over ntk's widgets         | **Candidate.** Small fraction of apps, large closure. See react-x11's `RICH_CONTENT.md` and [ntk#106](https://github.com/sidorares/ntk/issues/106).   |
| `<svg>`, `<tex>`                                 | ntk (`SvgView`, `layoutTex`), wrapped in react-x11       | **Staying in ntk**, per ntk#106. Recorded here so it is not reopened.                                                                                 |
| mermaid                                          | nowhere — dropped from ntk                               | **Dropped**, not extracted: 155 MB of install closure for a grammar. If it comes back, it comes back here, as its own subpath, and it stays optional. |
| `<Tabs>`                                         | react-x11 `src/components/Tabs.js`                       | **Open.** May stay in core. Undecided — do not move it on a hunch.                                                                                    |
| 3D scene graph, Three.js / r3f layer, `Canvas3D` | react-x11 `src/scene3d.js`, `src/components/Canvas3D.js` | **Candidate**, with `<glarea>` staying in core. See "The boundary can run through a feature".                                                         |
| react-flow clone                                 | prototype, not yet in any repo                           | **Incoming.** A node/edge graph editor: big, pure composition, small fraction of apps — this package's shape exactly.                                 |

Verified against ntk 7.2.0 on 2026-08-09: `MarkdownView`, `HtmlView`,
`SvgView` and `layoutTex` are all still exported; only mermaid is gone.

A note on precedent: react-x11's `NEXT_STEPS.md` §10 records an earlier
decision that the widget set stays in core and siblings live in that repo as
workspaces. That is still true of the _core widget set_ — it is not what
this package is. This package exists for the things that fail the "vast
majority of apps" test, which the core widgets pass.

## Conventions

Inherited from react-x11, and worth keeping identical so moving code between
the two repos stays mechanical:

- **ESM, no build step.** `src/` is what ships. `"type": "module"`.
- **No JSX in library source.** `React.createElement` (aliased to `h`) —
  consumers should not need a build step. JSX is fine in `examples/` and
  `test/types/`.
- **Hand-written `.d.ts`** next to each module. `skipLibCheck` is off.
- Prettier with `singleQuote`, eslint flat config. Both match core's.
- **Conventional commits** — release-please reads them. `feat:` for a new
  component, `fix:` for a bug, `feat!:`/`BREAKING CHANGE:` for a prop or
  export that changes shape.
- Comments explain _why_, especially where getting it wrong fails far from
  the cause. Both traps in "Gotchas" are that shape.

## Releases

release-please on `master` opens the release PR; merging it tags, and the
workflow publishes with npm trusted publishing (OIDC), so there is no token
secret in this repo.

Two one-time setup steps, neither of which the workflow can do:

1. **The first publish must be manual.** Trusted publishing binds to a
   package that already exists on the registry, so `npm publish
--access public` has to be run once by hand before the automation works.
2. The `@react-x11` npm scope must exist and this repo + workflow must be
   configured as a trusted publisher for `@react-x11/components`.

Do not publish before react-x11 2.0.0 is on npm — the peer range cannot be
satisfied until then.

## Gotchas

Both of these are inherited from `registerElement`, and both fail a long way
from the cause:

- **`drawn` decides whether the element paints at all.** `paintOrder()`
  filters children on `DRAWN_KINDS`; a kind missing from it lays out
  correctly, reports a sensible `abs` rect, and never appears on screen, with
  no error anywhere. `registerElement` opts you in unless you say otherwise —
  so the failure mode is passing `drawn: false` without meaning it. Assert
  membership in a test, the way `test/sparkline.test.js` does.
- **`semanticNames` is the difference between DEV and production.** react-x11
  throws in development on a style property written as a flat prop
  (`<sparkline color="red">`), because that is usually a real mistake. An
  element whose own vocabulary overlaps the style vocabulary — `color`,
  `width`, `opacity`, `stroke` — must declare those names, or it throws on
  its own props in development and works in production. Check a name with
  `isStyleProp` from `react-x11/style` before you rely on it.

One more, specific to here:

- **`node.kind` must equal the registered element name.** react-x11 rejects
  the node otherwise, and the reason it bothers is that `kind` is what paint
  order, the test queries and the DEV assertion all match on. Keep the name
  in one exported constant per component and use it in all three places.
