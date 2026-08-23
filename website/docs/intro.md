---
sidebar_position: 1
title: Introduction
---

# @react-x11/components

Components for [react-x11](https://github.com/sidorares/react-x11) that do not
belong in the core package.

Everything here is built on react-x11's public API — the built-in host
elements, or the `registerElement` seam in `react-x11/host`. Nothing here
needs a change to core to exist, and core does not grow to carry it.

:::note Installable now

react-x11 2.0.0 is on npm, so the peer range this package declares resolves
and `npm install` just works. The published release is `0.1.0`; `master`
carries components added since, so use a checkout if you want what is not in
that release yet.

:::

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

## What is in the box

| Component                                                       | What it is                                            |
| --------------------------------------------------------------- | ----------------------------------------------------- |
| [Calendar / DatePicker](/docs/reference/components/calendar)    | A month grid: one date or a range, any day blockable. |
| [Code](/docs/reference/components/code)                         | A static code block: highlighted, selectable.         |
| [CodeEditor](/docs/reference/components/code-editor)            | Multiline code editing: highlighting, completion.     |
| [Markdown](/docs/reference/components/markdown)                 | Streaming-friendly GFM with cross-block selection.    |
| [MediaPlayer](/docs/reference/components/media-player)          | mpv or VLC, embedded, with real transport control.    |
| [Terminal](/docs/reference/components/terminal)                 | A real terminal: an embedded emulator, or its own.    |
| [TrayHost](/docs/reference/components/tray-host)                | The system tray: applications dock their icons in.    |
| [Desktop calendar](/docs/reference/components/desktop-calendar) | The user's real calendar events, over D-Bus.          |

Four shared modules sit underneath and are importable on their own:
[richtext](/docs/reference/components/richtext),
[codeblock](/docs/reference/components/codeblock),
[code-language](/docs/reference/components/code-language) and
[embed](/docs/reference/components/embed).

## Three properties worth knowing up front

**Use one component, pay for one component.** Each is its own module with its
own entry point, the package declares `"sideEffects": false`, and importing
the barrel for nothing at all bundles to nothing. That last property is a test
in the repo, not an aspiration.

**Nothing is a hard dependency.** Where a component needs a program (an
emulator, a media player) or a native module (a pty), "it is not installed" is
an ordinary state of a healthy machine: there is a `status`, there is a
`fallback`, and `onError` names what was looked for. Nothing throws out of
render.

**Selecting text is core's**, not this package's. A `<box selectable>` is a
surface, everything under it that answers for its own text is in the
selection, and the drag, the granularities, Ctrl+A, Ctrl+C and PRIMARY come
with it (react-x11#291). `<Markdown>` and `<Code>` set that prop and say which
parts are chrome; the elements underneath answer four accessors, which is all
an element of your own has to do to join a document.

## Next

[Getting started](/docs/getting-started) is install, peer dependencies and the
TypeScript setup. The [reference](/docs/reference) is one page per component.
