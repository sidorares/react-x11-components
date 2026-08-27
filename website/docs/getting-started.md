---
sidebar_position: 2
title: Getting started
---

# Getting started

## Install

```bash
npm install @react-x11/components
```

`react` and `react-x11` are **peer dependencies**, deliberately. Registering a
host element mutates module-level state inside react-x11 — the registry map,
and the set of kinds paint order filters on — so a second copy of the renderer
in one app leaves you with an element that lays out correctly, reports a
sensible rect, and never paints, with no error anywhere.

```bash
npm install react react-x11
```

Core needs to be **2.0.0 or newer** — that is the release the subpaths this
package imports (`react-x11/host`, `/node`, `/style`) arrived in.

TypeScript users also want `@types/react`, since React ships no types of its
own. If you set `skipLibCheck: false`, core's own declarations need
`"lib": ["esnext"]` — they reference `Symbol.asyncDispose`. The default
`skipLibCheck: true` sidesteps it.

## Use a component

```jsx
import { Code } from '@react-x11/components';

function App() {
  return (
    <window width={480} height={240} title="components">
      <box style={{ flexGrow: 1, padding: 16 }}>
        <Code source={source} lang="ts" lineNumbers />
      </box>
    </window>
  );
}
```

**Importing a component is what teaches react-x11 its element**, so there is
no setup call to remember and no registration to run at startup. That is also
what makes the tree-shaking work: registration happens in the module a bundler
keeps only when the component is used.

## Deep imports

Every component has a subpath of its own, for apps without a bundler and for
anyone who would rather be explicit:

```js
import { Code } from '@react-x11/components/code';
import { Terminal } from '@react-x11/components/terminal';
```

The barrel and the subpath are the same module either way.

## Optional dependencies

Nothing below is required to install the package, and nothing below throws
when it is missing — each has a `status` and a `fallback` instead.

| You want                                 | Install                                                          | Without it                                                     |
| ---------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `<Terminal backend="vt">`                | `npm i node-pty` or `@lydell/node-pty` (nothing under Bun ≥ 1.4) | `status` is `'unavailable'`, `fallback` renders                |
| `<Terminal>` on an embedded emulator     | xterm, urxvt or alacritty on `PATH`                              | `backend="auto"` falls through to `vt`                         |
| `<MediaPlayer>`                          | mpv or VLC on `PATH`                                             | `fallback` renders, `onError` names what it looked for         |
| Recurring events in the desktop calendar | `npm i ical.js`                                                  | `status` is `'unavailable'`; the calendar renders without dots |

`@xterm/headless` is an optional **dependency**, not a peer: it is 2 MB and
installs by default, because nothing else would bring it. The pty is an
optional peer because node-pty unpacks to 64 MB and builds a native addon,
which is not something a package a calendar app installed may drag in. Under
Bun 1.4 or newer there is nothing to install at all: the runtime has its own
pty, and the vt backend prefers it over both peers.

## TypeScript

The package is written in TypeScript and ships its own declarations, so there
is no `@types` package to install. Point your compiler at react-x11's JSX
namespace and the host elements type-check:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-x11"
  }
}
```

Importing a component teaches JSX its element too, so `<codeeditor>` is a
typed tag as soon as `CodeEditor` is in scope. Props types are exported under
their component's name:

```ts
import type { CodeEditorProps } from '@react-x11/components';
```

## Testing

react-x11's test harness runs node-x11's pure-JavaScript X server in-process,
so a test that renders one of these components needs **no `$DISPLAY`** and no
xvfb. That is how this repo's own suite covers a terminal, a media player and
a system tray on a CI machine with none of them installed — the
[`ProcessHost`](/docs/reference/components/embed) seam stands in for the
spawn, and assertions are made about what _would_ have run.

## Where to next

The [reference](/docs/reference) is one page per component. Each starts with
the shortest snippet that works and ends with the decisions that look like
gaps and are not.
