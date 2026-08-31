# QML

```jsx
import { QmlView } from '@react-x11/components/qml';

<QmlView
  source={`
    import QtQuick 2.15
    Rectangle {
      width: 300; height: 120; color: "#101418"
      property int count: 0
      Text { anchors.centerIn: parent; color: "white"; text: "clicks: " + count }
      MouseArea { anchors.fill: parent; onClicked: count++ }
    }
  `}
/>;
```

A QML engine: Qt's declarative UI language as an authoring layer over
react-x11. The parser, the reactive binding graph and the object model are
this package's own (zero dependencies, no Qt anywhere); everything visible
is an ordinary `<box>`/`<text>`/`<image>` committed through the renderer,
so theming, damage tracking, accessibility and the test harness all apply
to QML content unchanged.

No host element is registered. Importing the family has one import-time
side effect, the same shape as a component registering its element: it
populates the **family's own** QtQuick type registry — no core state is
touched, and a bundler that shakes the family drops it.

The engine half (`parseQml`, `instantiateDocument`, the slot graph) is
renderer-free and runs headless — that is how the language-semantics tests
run with no server at all.

## What the QtQuick subset covers

`Item`, `Rectangle`, `Text`, `Image`, `MouseArea` (click, double-click,
press state, hover, wheel), `Row`/`Column`, `Repeater`, `Timer`,
`QtObject`, `Flickable`, `ListView` (windowed — see below), `TextInput`
and `TextEdit` (two-way over core's editors), `Loader` (`sourceComponent`,
and `source` paths through the resolver), `Connections`, `Binding`,
`ListModel`/`ListElement`,
`states` + `PropertyChanges` + `Transition`, `Behavior`,
`NumberAnimation`/`ColorAnimation` (as value sources and inside
Behaviors/Transitions), the `Keys` attached handlers, `focus`/
`activeFocus`, `property`/`readonly`/`alias`/`signal`/`function`
declarations, grouped properties (`font.pixelSize`, `anchors { … }`),
`Component.onCompleted`/`onDestruction`, `Qt.rgba` and friends, and
`Qt.binding()`.

The language semantics are the fidelity that matters and each is pinned by
a test: **assignment breaks a binding** (`x = 5` in a handler kills
`x: parent.width / 2`; `Qt.binding()` restores), ids outrank the scope
object's own properties, script-block bindings re-evaluate, an unset
`width` tracks `implicitWidth`, delegates see `index`/`modelData` and
ListModel roles as context properties, and `Component.onCompleted` runs
leaf-first.

## Imports and the resolver seam

The import statement parses in every form — versioned and version-less
modules, `as` aliases, quoted paths. What a name _resolves to_ comes in
three tiers, in Qt's precedence order:

1. **The implicit same-directory import** — `<Name>.qml` beside the
   document, no import line at all. A local `Button.qml` shadows a
   module's `Button`, as in Qt.
2. **Quoted-path imports** — `import "./widgets"` brings in that
   directory's components.
3. **Registered modules** — `import QtQuick 2.15` and anything an app
   adds with `registerQmlModule`. (Versions are parsed and ignored.)

The first two exist only when a **resolver** is provided — the engine
never touches a filesystem itself. A resolver is three members
(`rootDir`, `load(dir, name)`, `join(dir, relative)`); the standard
filesystem one ships here:

```jsx
import { QmlView, createFileResolver } from '@react-x11/components/qml';
import { dirname } from 'node:path';

const resolver = await createFileResolver(dirname(qmlPath));

<QmlView source={source} file={qmlPath} resolver={resolver} />;
```

`createFileResolver` is async (the node builtins load through a dynamic
import — `src/` builds with no node types); the resolver it returns is
synchronous, and any object with the same shape works — the tests hand
the engine an in-memory map.

What a file-backed component means, precisely: its internals are private
(ids and root properties resolve within its own file, and its own
imports), `QmlView` context properties reach inside, and the use site's
members — bindings, children, handlers, `states` — evaluate in the _use
site's_ scope and win over the file's own, Qt's instantiator rule.
`Loader { source: "widgets/Panel.qml" }` loads through the same seam.
Component sources are cached per instantiation — a 1000-delegate
ListView reads its component file once — and re-read on the next root
reload, so editing a _sibling_ file needs one more thing: bump
`reloadToken` (the example watches the directory and does exactly that),
and the rebuild migrates interactive state like any hot reload.

A component cycle (`A.qml` using `B.qml` using `A.qml`) fails with the
chain in the message; an unknown type without a resolver says
`createFileResolver` is how to get one.

## `<QmlView>`

### Props

| Prop          | Type                                | Notes                                                                                                                                               |
| ------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`      | `string`                            | The QML document. When it changes, the tree is rebuilt and interactive state is migrated (see "Hot reload").                                        |
| `file`        | `string`                            | Shown in parse and binding errors. Pass the path when the source came from a file.                                                                  |
| `context`     | `Record<string, unknown>`           | Context properties — names visible to every binding in the document. Updated values ride ordinary commits.                                          |
| `onSignal`    | `Record<string, (...args) => void>` | Subscriptions to the root object's signals, by name.                                                                                                |
| `hotReload`   | `boolean`                           | Default true: a `source` swap carries assigned property values across by id. `false` rebuilds cold.                                                 |
| `resolver`    | `QmlResolver`                       | Enables `.qml`-file resolution (the section above). `createFileResolver(dir)` is the standard one; fixed for the view's lifetime.                   |
| `reloadToken` | `unknown`                           | Rebuild (with state migration) when this changes — how a watcher of sibling `.qml` files triggers the reload an unchanged root source cannot.       |
| `style`       | `Style \| Style[]`                  | The wrapper box. When the root object declares its own `width`/`height` the wrapper takes that size; otherwise the app sizes it and the root fills. |

### The handle

`ref` exposes `{ root, id(name), instance }`. `root` and `id()` return
**facades** — objects as QML expressions see them: live property reads,
assignment (which breaks bindings, exactly as inside the document),
callable signals and methods. `view.id('meter').width = 40` is the
imperative escape hatch and behaves like the same line in a handler.

## Extending: the registry is the parity plan

A QML type is a property table, a signal table, optional enums and a view.
The QtQuick subset itself is just a registry module — there is no
privileged path.

```jsx
import {
  registerReactComponent,
  registerControls,
} from '@react-x11/components/qml';
import { Button } from 'react-x11';

// A React component as a QML type: bindings arrive as props, signals
// come back as QML signals.
registerReactComponent('Shop.Widgets', 'PriceTag', PriceTag, {
  properties: { amount: { default: 0 } },
  signals: { activated: [] },
});

// `import QtQuick.Controls` — core's Button, instantiable from QML.
registerControls({ Button });
```

Unknown types fail with the registered-module list and the
`registerQmlModule` call to fix it; unknown properties name the type. Both
messages are pinned by tests.

## The decisions

- **Motion is visual-only, deliberately.** `Behavior`, `Transition` and
  the animations lower onto react-x11's own `transition`/`animation` style
  engines: the renderer eases on the frame clock (deterministic under
  `withFrameClock` in tests), while the _property_ jumps to its target.
  An expression reading an animated property mid-flight sees the target —
  the one divergence from Qt, chosen so every animation is the renderer's
  own. Graph-side interpolation is planned as an opt-in once core exposes
  a frame tick.
- **QML hex is alpha-first.** `#AARRGGBB` is converted to CSS's
  `#RRGGBBAA` at the style boundary; every ported document with a
  translucent colour silently needs this.
- **Hot reload keeps what you did, not what you wrote.** The slot graph
  distinguishes assignment from binding, so "interactive state" needs no
  annotations: assigned values (counters, toggles, typed text) survive a
  source swap by id; everything bound re-derives from the edited source.
  Qt's own live preview resets state; this keeps it.
- **ListView windows by the first delegate's height.** Uniform-height rows
  (the overwhelmingly common case) get true virtualization: ~a viewport
  plus a buffer of live delegates out of any model size, repositioned as
  `contentY` moves. Rows without a measurable height fall back to full
  instantiation with stacked heights.
- **A state is an override layer, not a mutation.** `PropertyChanges`
  pushes live bindings above the document's own; leaving the state pops
  them and the originals — still tracked underneath — are current
  immediately. The `Binding` element is the same mechanism with a `when`.
- **Not there yet, on purpose:** `opacity`/`rotation`/`scale` (need
  offscreen composition / a transform path in core — declared, warned
  once, ignored), `Image.fillMode` beyond Stretch (needs a fit mode on
  core's `<image>`), inline `component` declarations (put the component
  in its own `<Name>.qml` — the implicit import picks it up — or define
  it in JavaScript), `SequentialAnimation`/`ParallelAnimation`, and
  `mouse.accepted`-driven re-propagation. Each fails loudly or warns
  once rather than pretending.

The design record — why an interpreter and a compiler are one system, the
measured costs, the full semantic map against Qt — is react-x11's QML RFC
(`docs/qml.md` in the react-x11 repository).

```bash
npm run examples:qml   # needs a real $DISPLAY
```

The example (`examples/qml/`) shows all the resolution paths side by
side — `Backdrop.qml` implicit, `widgets/Meter.qml` through
`import "./widgets"`, a `Gauge` from `registerQmlModule`, the button
from `registerControls` — and watches every `.qml` file for live edits.
