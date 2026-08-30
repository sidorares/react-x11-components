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
and `TextEdit` (two-way over core's editors), `Loader`
(`sourceComponent`), `Connections`, `Binding`, `ListModel`/`ListElement`,
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

## `<QmlView>`

### Props

| Prop        | Type                                | Notes                                                                                                                                               |
| ----------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`    | `string`                            | The QML document. When it changes, the tree is rebuilt and interactive state is migrated (see "Hot reload").                                        |
| `file`      | `string`                            | Shown in parse and binding errors. Pass the path when the source came from a file.                                                                  |
| `context`   | `Record<string, unknown>`           | Context properties — names visible to every binding in the document. Updated values ride ordinary commits.                                          |
| `onSignal`  | `Record<string, (...args) => void>` | Subscriptions to the root object's signals, by name.                                                                                                |
| `hotReload` | `boolean`                           | Default true: a `source` swap carries assigned property values across by id. `false` rebuilds cold.                                                 |
| `style`     | `Style \| Style[]`                  | The wrapper box. When the root object declares its own `width`/`height` the wrapper takes that size; otherwise the app sizes it and the root fills. |

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
  core's `<image>`), inline `component` declarations and `Loader.source`
  URLs (both land with directory imports), `SequentialAnimation`/
  `ParallelAnimation`, and `mouse.accepted`-driven re-propagation. Each
  fails loudly or warns once rather than pretending.

The design record — why an interpreter and a compiler are one system, the
measured costs, the full semantic map against Qt — is react-x11's QML RFC
(`docs/qml.md` in the react-x11 repository).

```bash
npm run examples:qml   # needs a real $DISPLAY; edit examples/qml-demo.qml live
```
