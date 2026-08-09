# @react-x11/components

Components for [react-x11](https://github.com/sidorares/react-x11) that do
not belong in the core package.

Everything here is built on react-x11's public API — the built-in host
elements, or the `registerElement` seam in `react-x11/host`. Nothing here
needs a change to core to exist, and core does not grow to carry it.

> **Not published yet.** This package needs react-x11 2.0.0, which is not on
> npm — the subpath exports it imports (`react-x11/host`, `/node`, `/style`,
> `/test`) are on core's `master`, unreleased. Until then, use it from a
> checkout.

## What is here, and what is in core

react-x11 itself carries an element or component when **any** of these hold:

- the vast majority of UI apps use it;
- it depends on renderer internals — implementing it outside would mean
  exposing details that should not be public, or giving up performance;
- it needs enough standards compliance that the behaviour is hard to agree on
  or implement piecemeal.

This package carries it when **all** of these hold:

- a smaller fraction of apps need it;
- it can be built on the public react-x11 API;
- it is big enough that core would pay for it, in install closure or in
  maintenance.

So `<box>`, `<text>`, `<window>`, buttons, menus, dialogs and the rest of the
widget set are core. Heavier, more specialised things live here.

The line can also fall inside a single feature. `<glarea>` is core — it is a
real X window on a GLX visual, which is renderer internals. A Three.js-shaped
scene graph drawn into it is not: that is composition over a public element,
and it belongs here.

## Install

```bash
npm install @react-x11/components
```

`react` and `react-x11` are peer dependencies — deliberately. Registering a
host element mutates state inside react-x11, so a second copy of the renderer
would leave you with an element that lays out correctly and never paints.

## Usage

```jsx
import { Sparkline } from '@react-x11/components';

function App() {
  return (
    <window width={360} height={160} title="components">
      <box style={{ flexGrow: 1, padding: 16 }}>
        <Sparkline
          data={[3, 7, 4, 9, 6, 11, 8]}
          color="#c0392b"
          strokeWidth={2}
          style={{ width: 320, height: 80 }}
        />
      </box>
    </window>
  );
}
```

Importing a component is what teaches react-x11 its element, so there is no
setup call to remember and no registration to run at startup.

## Tree-shaking

Use one component, pay for one component. Each is its own module with its own
entry point, the package declares `"sideEffects": false`, and importing the
barrel for nothing at all bundles to nothing. That last property is a test in
this repo, not an aspiration.

Deep imports work too, for apps without a bundler:

```js
import { Sparkline } from '@react-x11/components/sparkline';
```

## TypeScript

The package is written in TypeScript and ships its own declarations, so
there is no `@types` package to install. Point your compiler at react-x11's
JSX namespace and the host elements type-check:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-x11"
  }
}
```

Importing a component teaches JSX its element too, so `<sparkline>` is a
typed tag as soon as `Sparkline` is in scope. Props types are exported
under their component's name:

```ts
import type { SparklineProps } from '@react-x11/components';
```

## Components

| Component   | Import                            |                                                |
| ----------- | --------------------------------- | ---------------------------------------------- |
| `Sparkline` | `@react-x11/components/sparkline` | A bare line chart. Needs a width and a height. |

## Roadmap

Candidates to move here, none of them moved yet:

- `<markdown>` and `<html>`, currently in react-x11 over ntk's document
  widgets. `<svg>` and `<tex>` stay in ntk. Mermaid was dropped rather than
  extracted — 155 MB of install closure for a grammar.
- The 3D scene graph and a Three.js / react-three-fiber-shaped layer, with
  `<glarea>` itself staying in core.
- A react-flow-style node/edge graph editor.
- `<Tabs>`, undecided — it may well stay in core.

## Contributing

[AGENTS.md](AGENTS.md) is the contributor guide: the rule for what belongs
here, the layout, the tree-shaking constraints, and the two ways a registered
element fails silently.

## License

MIT
