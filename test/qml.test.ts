// src/qml — the QML engine. Two layers: headless tests pin the language
// semantics (the binding graph, anchors, aliases, binding-breaking
// assignment, states as override layers) with no server at all, and
// rendered tests pin the bridge — that QML documents become ordinary
// react-x11 trees whose pixels, events and transitions are the renderer's
// own. Everything runs on the in-process server; no DISPLAY.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import React from 'react';

import {
  renderX11,
  cleanup,
  screen,
  waitFor,
  userEvent,
  fireEvent,
  act,
  expectPixel,
  pixelAt,
  withFrameClock,
} from 'react-x11/test';
import { Button } from 'react-x11';
import { XK_RETURN } from 'react-x11/keysyms';
import {
  parseQml,
  instantiateDocument,
  flushBindings,
  qmlColor,
  QmlView,
  registerControls,
  registerReactComponent,
  Qt,
  type QmlFacade,
  type QmlViewHandle,
} from '../src/qml/index.js';

const h = React.createElement;

const FONT_CANDIDATES: Array<[string, string]> = [
  [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Monaco.ttf',
  ],
  [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  ],
];
const found = FONT_CANDIDATES.find(
  ([sans, mono]) => existsSync(sans) && existsSync(mono),
);
const FONTS = found ? { 'sans-serif': found[0], monospace: found[1] } : null;

registerControls({ Button });

afterEach(cleanup);

const headless = (src: string) =>
  instantiateDocument(parseQml(src, { fileName: 't.qml' }));

describe('QML language semantics (headless)', () => {
  test('bindings cascade; anchors, aliases and onCompleted hold together', () => {
    const { root, context } = headless(`
      import QtQuick 2.15
      Rectangle {
        id: root
        width: 400; height: 300
        property int clicks: 0
        property alias label: title.text
        readonly property real half: width / 2
        Rectangle {
          id: panel
          width: parent.width / 2
          height: root.height - 20
          anchors.horizontalCenter: parent.horizontalCenter
          Text { id: title; text: "hello " + root.clicks; anchors { fill: parent; margins: 4 } }
        }
        Component.onCompleted: clicks = 1
      }
    `);
    const panel = context.ids.get('panel')!;
    const title = context.ids.get('title')!;
    assert.equal(root.slot('clicks').peek(), 1, 'onCompleted ran');
    assert.equal(title.slot('text').peek(), 'hello 1');
    assert.equal(panel.slot('width').peek(), 200);
    assert.equal(panel.slot('x').peek(), 100, 'horizontalCenter anchor');
    assert.equal(title.slot('width').peek(), 192, 'fill minus margins');
    assert.equal(root.slot('label').peek(), 'hello 1', 'alias reads through');

    root.facade.width = 600;
    flushBindings();
    assert.equal(panel.slot('width').peek(), 300);
    assert.equal(root.slot('half').peek(), 300);
    assert.equal(title.slot('width').peek(), 292);
    root.destroy();
  });

  test('assignment breaks a binding; Qt.binding restores one', () => {
    const { root, context } = headless(`
      import QtQuick 2.15
      Item {
        id: root
        width: 100
        Item { id: child; width: parent.width * 2 }
        function detach() { child.width = 7 }
        function reattach() { child.width = Qt.binding(function() { return root.width * 3 }) }
      }
    `);
    const child = context.ids.get('child')!;
    assert.equal(child.slot('width').peek(), 200);
    root.facade.detach();
    root.facade.width = 500;
    flushBindings();
    assert.equal(
      child.slot('width').peek(),
      7,
      'assignment killed the binding',
    );
    root.facade.reattach();
    flushBindings();
    assert.equal(child.slot('width').peek(), 1500, 'Qt.binding re-bound it');
    root.destroy();
  });

  test('a script-block binding is reactive, not a one-shot', () => {
    const { root, context } = headless(`
      import QtQuick 2.15
      Item {
        id: root
        property bool big: false
        Item { id: c; width: { if (root.big) return 40; return 20 } }
      }
    `);
    const c = context.ids.get('c')!;
    assert.equal(c.slot('width').peek(), 20);
    root.facade.big = true;
    flushBindings();
    assert.equal(c.slot('width').peek(), 40);
    root.destroy();
  });

  test('signal declarations, arrow handlers and change signals fire', () => {
    const seen: string[] = [];
    const { root } = headless(`
      import QtQuick 2.15
      Item {
        id: root
        property int n: 0
        signal submitted(string value)
        onSubmitted: (value) => { root.n = value.length }
        onNChanged: root.mark("n=" + root.n)
        function mark(s) { }
      }
    `);
    root.methods.set('mark', (s) => seen.push(String(s)));
    root.facade.submitted('four');
    flushBindings();
    assert.equal(root.slot('n').peek(), 4);
    assert.deepEqual(seen, ['n=4']);
    root.destroy();
  });

  test('a Timer ticks, stops, and dies with its tree', async () => {
    const { root } = headless(`
      import QtQuick 2.15
      Item {
        id: root
        property int fired: 0
        Timer { interval: 10; running: true; repeat: false; onTriggered: root.fired++ }
      }
    `);
    await new Promise((r) => setTimeout(r, 60));
    flushBindings();
    assert.equal(root.slot('fired').peek(), 1, 'fired once, repeat: false');
    root.destroy();
  });

  test('errors say what to do: unknown types name the registry', () => {
    assert.throws(
      () => headless('import QtQuick 2.15\nFlux { }'),
      /Unknown QML type 'Flux'.*registerQmlModule/s,
    );
    assert.throws(
      () => headless('import QtQuick 2.15\nItem { wobble: 3 }'),
      /Item has no property 'wobble'/,
    );
  });

  test("QML's alpha-first hex becomes CSS's alpha-last", () => {
    assert.equal(qmlColor('#80ff0000'), '#ff000080');
    assert.equal(qmlColor('#8f00'), '#f008');
    assert.equal(qmlColor('#204080'), '#204080');
    assert.equal(Qt.rgba(1, 0, 0, 0.5), 'rgba(255, 0, 0, 0.5)');
  });

  test('states push overrides; leaving restores the binding underneath', () => {
    const { root, context } = headless(`
      import QtQuick 2.15
      Item {
        id: root
        property bool wide: false
        Rectangle {
          id: box
          width: root.wide ? 100 : 50
          color: "green"
        }
        state: ""
        states: [
          State {
            name: "alert"
            PropertyChanges { target: box; color: "red"; width: root.width + 1 }
          }
        ]
        width: 300
      }
    `);
    const box = context.ids.get('box')!;
    assert.equal(box.slot('color').peek(), 'green');
    root.facade.state = 'alert';
    flushBindings();
    assert.equal(box.slot('color').peek(), 'red', 'override applied');
    assert.equal(box.slot('width').peek(), 301, 'override binding is live');
    root.facade.width = 400;
    flushBindings();
    assert.equal(box.slot('width').peek(), 401, 'still live while active');
    root.facade.wide = true;
    flushBindings();
    assert.equal(box.slot('width').peek(), 401, 'base binding stays covered');
    root.facade.state = '';
    flushBindings();
    assert.equal(box.slot('color').peek(), 'green', 'exit restored the value');
    assert.equal(
      box.slot('width').peek(),
      100,
      'exit restored the *binding*, already re-evaluated under the state',
    );
    root.destroy();
  });

  test('a `when` clause drives the state both ways', () => {
    const { root, context } = headless(`
      import QtQuick 2.15
      Item {
        id: root
        property int n: 0
        Rectangle { id: box; color: "white" }
        states: [
          State {
            name: "hot"
            when: root.n > 2
            PropertyChanges { target: box; color: "orange" }
          }
        ]
      }
    `);
    const box = context.ids.get('box')!;
    root.facade.n = 3;
    flushBindings();
    assert.equal(root.slot('state').peek(), 'hot');
    assert.equal(box.slot('color').peek(), 'orange');
    root.facade.n = 0;
    flushBindings();
    assert.equal(root.slot('state').peek(), '');
    assert.equal(box.slot('color').peek(), 'white');
    root.destroy();
  });

  test('the Binding element overrides while `when` holds', () => {
    const { root, context } = headless(`
      import QtQuick 2.15
      Item {
        id: root
        property bool on: false
        property int source: 10
        Item { id: tgt; width: 5 }
        Binding { target: tgt; property: "width"; value: root.source * 2; when: root.on }
      }
    `);
    const tgt = context.ids.get('tgt')!;
    assert.equal(tgt.slot('width').peek(), 5);
    root.facade.on = true;
    flushBindings();
    assert.equal(tgt.slot('width').peek(), 20);
    root.facade.source = 21;
    flushBindings();
    assert.equal(
      tgt.slot('width').peek(),
      42,
      'override value is a live binding',
    );
    root.facade.on = false;
    flushBindings();
    assert.equal(tgt.slot('width').peek(), 5, 'popped back to the base');
    root.destroy();
  });

  test('Connections subscribes handlers, in both syntaxes', () => {
    const seen: string[] = [];
    const { root } = headless(`
      import QtQuick 2.15
      Item {
        id: root
        signal ping(string what)
        property int count: 0
        Connections {
          target: root
          function onPing(what) { root.note("fn:" + what) }
        }
        Connections {
          target: root
          onPing: (what) => root.note("handler:" + what)
        }
        function note(s) { }
      }
    `);
    root.methods.set('note', (s) => seen.push(String(s)));
    root.facade.ping('x');
    flushBindings();
    assert.deepEqual(seen.sort(), ['fn:x', 'handler:x']);
    root.destroy();
  });

  test('ListModel: ListElement rows, roles, and reactive mutation', () => {
    const { root, context } = headless(`
      import QtQuick 2.15
      Item {
        id: root
        ListModel {
          id: contacts
          ListElement { name: "Bill Smith"; number: "555 3264" }
          ListElement { name: "John Brown"; number: "555 8426" }
        }
        Column {
          id: col
          Repeater {
            model: contacts
            Text { text: name + ": " + number }
          }
        }
        property int total: contacts.count
      }
    `);
    const contacts = context.ids.get('contacts')!;
    const col = context.ids.get('col')!;
    assert.equal(root.slot('total').peek(), 2);
    assert.equal(col.visualChildren().length, 2);
    assert.equal(
      col.visualChildren()[0].slot('text').peek(),
      'Bill Smith: 555 3264',
      'roles resolve as context properties',
    );
    const model = contacts.facade;
    model.append({ name: 'Anna Gray', number: '555 0000' });
    flushBindings();
    assert.equal(root.slot('total').peek(), 3, 'count is reactive');
    assert.equal(col.visualChildren().length, 3, 'Repeater rebuilt');
    assert.equal(model.get(2).name, 'Anna Gray');
    model.remove(0);
    flushBindings();
    assert.equal(col.visualChildren().length, 2);
    assert.equal(
      col.visualChildren()[0].slot('text').peek(),
      'John Brown: 555 8426',
    );
    root.destroy();
  });

  test('Loader creates on demand and hands back the item', () => {
    const loadedTimes: number[] = [];
    const { root, context } = headless(`
      import QtQuick 2.15
      Item {
        id: root
        property bool go: false
        Loader {
          id: ld
          active: root.go
          sourceComponent: Rectangle { width: 44; height: 11; color: "teal" }
          onLoaded: root.mark()
        }
        function mark() { }
      }
    `);
    root.methods.set('mark', () => loadedTimes.push(1));
    const ld = context.ids.get('ld')!;
    assert.equal(ld.slot('item').peek(), null);
    assert.equal(ld.visualChildren().length, 0);
    root.facade.go = true;
    flushBindings();
    assert.equal(ld.visualChildren().length, 1, 'instantiated on activation');
    assert.equal(
      (ld.slot('item').peek() as QmlFacade).width,
      44,
      'item facade is live',
    );
    assert.equal(ld.slot('width').peek(), 44, 'Loader takes the item size');
    assert.equal(loadedTimes.length, 1);
    root.facade.go = false;
    flushBindings();
    assert.equal(ld.visualChildren().length, 0, 'destroyed on deactivation');
    assert.equal(ld.slot('item').peek(), null);
    root.destroy();
  });
});

const mountQml = async (source: string, { width = 400, height = 300 } = {}) => {
  const ref = React.createRef<QmlViewHandle>();
  const handle = await renderX11(h(QmlView, { ref, source }), {
    width,
    height,
    fonts: FONTS ?? undefined,
  });
  await waitFor(() => {
    assert.ok(ref.current, 'view mounted');
  });
  return { ...handle, ref };
};

describe('QML rendered through react-x11', () => {
  test(
    'a document becomes boxes and text the server composites',
    { skip: !FONTS },
    async () => {
      const { ctx } = await mountQml(`
        import QtQuick 2.15
        Rectangle {
          width: 300; height: 200; color: "#204080"
          Rectangle { x: 40; y: 40; width: 100; height: 60; color: "#2ecc71" }
          Text { x: 40; y: 120; text: "from qml"; color: "white" }
        }
      `);
      await expectPixel(ctx, 150, 20, '#204080');
      await expectPixel(ctx, 90, 70, '#2ecc71');
      assert.ok(screen.getByText('from qml'), 'text query finds QML text');
    },
  );

  test(
    'a geometry binding moves pixels when the property changes',
    { skip: !FONTS },
    async () => {
      const { ctx, ref } = await mountQml(`
        import QtQuick 2.15
        Rectangle {
          id: root
          width: 300; height: 200; color: "#111111"
          property int slide: 0
          Rectangle { x: 10 + root.slide; y: 10; width: 50; height: 50; color: "#e74c3c" }
        }
      `);
      await expectPixel(ctx, 35, 35, '#e74c3c');
      await act(async () => {
        ref.current!.root.slide = 200;
      });
      await expectPixel(ctx, 35, 35, '#111111', {
        message: 'left the old spot',
      });
      await expectPixel(ctx, 235, 35, '#e74c3c', {
        message: 'arrived at the bound one',
      });
    },
  );

  test(
    'anchors.fill with margins pins to the parent, in pixels',
    { skip: !FONTS },
    async () => {
      const { ctx } = await mountQml(`
        import QtQuick 2.15
        Rectangle {
          width: 200; height: 200; color: "#000000"
          Rectangle {
            x: 50; y: 50; width: 100; height: 100; color: "#333333"
            Rectangle { anchors.fill: parent; anchors.margins: 10; color: "#f1c40f" }
          }
        }
      `);
      await expectPixel(ctx, 100, 100, '#f1c40f', {
        message: 'inside the fill',
      });
      await expectPixel(ctx, 55, 100, '#333333', {
        message: 'the margin shows the parent',
      });
      await expectPixel(ctx, 45, 100, '#000000', {
        message: 'outside the parent',
      });
    },
  );

  test(
    'MouseArea turns synthetic events into QML signals and state',
    { skip: !FONTS },
    async () => {
      const { ctx, ref } = await mountQml(`
        import QtQuick 2.15
        Rectangle {
          id: root
          width: 200; height: 120; color: "#101010"
          property int n: 0
          property int lastX: -1
          Rectangle {
            x: 20; y: 20; width: 120; height: 40
            color: root.n % 2 === 1 ? "#c0392b" : "#27ae60"
            MouseArea { id: area; anchors.fill: parent; onClicked: (mouse) => { root.n++; root.lastX = mouse.x } }
          }
          Text { x: 20; y: 70; color: "white"; text: "n: " + root.n }
        }
      `);
      await expectPixel(ctx, 80, 40, '#27ae60');
      assert.ok(screen.getByText('n: 0'));
      await act(async () => {
        fireEvent.screenClick(180, 110);
      });
      assert.ok(screen.getByText('n: 0'), 'click outside the area did nothing');
      await act(async () => {
        fireEvent.screenClick(80, 40);
      });
      await waitFor(() => assert.ok(screen.getByText('n: 1'), 'click counted'));
      await expectPixel(ctx, 80, 40, '#c0392b');
      assert.equal(
        ref.current!.root.lastX,
        60,
        'mouse.x is MouseArea-relative (80 - 20)',
      );
    },
  );

  test(
    'Repeater + Row: model drives instances; updates rebuild and reflow',
    { skip: !FONTS },
    async () => {
      const { ctx, ref } = await mountQml(`
        import QtQuick 2.15
        Rectangle {
          id: root
          width: 400; height: 120; color: "#000000"
          property var items: ["#e74c3c", "#f1c40f", "#2ecc71"]
          Row {
            x: 10; y: 10; spacing: 10
            Repeater {
              model: root.items
              Rectangle { width: 40; height: 40; color: modelData }
            }
          }
          Text { x: 10; y: 70; color: "white"; text: "count: " + root.items.length }
        }
      `);
      await expectPixel(ctx, 30, 30, '#e74c3c');
      await expectPixel(ctx, 80, 30, '#f1c40f');
      await expectPixel(ctx, 130, 30, '#2ecc71');
      assert.ok(screen.getByText('count: 3'));
      await act(async () => {
        ref.current!.root.items = ['#3498db', '#9b59b6'];
      });
      await expectPixel(ctx, 30, 30, '#3498db');
      await expectPixel(ctx, 80, 30, '#9b59b6');
      await expectPixel(ctx, 130, 30, '#000000', {
        message: 'third instance destroyed',
      });
      assert.ok(screen.getByText('count: 2'));
    },
  );

  test(
    'source swap migrates interactive state by id (hot reload)',
    { skip: !FONTS },
    async () => {
      const v1 = `
        import QtQuick 2.15
        Rectangle {
          id: root
          width: 200; height: 100; color: "#101010"
          property int count: 0
          MouseArea { anchors.fill: parent; onClicked: root.count++ }
          Text { x: 10; y: 10; color: "white"; text: "c=" + root.count }
        }
      `;
      const { ctx, ref, rerender } = await mountQml(v1);
      await act(async () => {
        fireEvent.screenClick(100, 50);
      });
      await act(async () => {
        fireEvent.screenClick(100, 50);
      });
      await waitFor(() => assert.ok(screen.getByText('c=2')));

      // "Edit the file": new colour, same ids — count must survive.
      const v2 = v1.replace('#101010', '#204080');
      await rerender(h(QmlView, { ref, source: v2 }));
      await act(async () => {});
      await expectPixel(ctx, 100, 90, '#204080', {
        message: 'the edit applied',
      });
      await waitFor(() =>
        assert.ok(screen.getByText('c=2'), 'interactive state survived'),
      );
    },
  );

  test(
    'a react-x11 widget lives inside QML: props in, signals out',
    { skip: !FONTS },
    async () => {
      await mountQml(`
        import QtQuick 2.15
        import QtQuick.Controls 2.15
        Rectangle {
          id: root
          width: 300; height: 120; color: "#101010"
          property int n: 5
          Button { x: 10; y: 10; width: 120; height: 36; text: "reset " + root.n; onClicked: root.n = 0 }
          Text { x: 10; y: 60; color: "white"; text: "value: " + root.n }
        }
      `);
      const btn = await screen.findByRole('button');
      assert.ok(screen.getByText('value: 5'));
      await userEvent.click(btn);
      await waitFor(() =>
        assert.ok(screen.getByText('value: 0'), 'signal reached QML'),
      );
      assert.ok(screen.getByText('reset 0'), 'binding re-labelled the widget');
    },
  );

  test(
    'a custom React component registers as a QML type',
    { skip: !FONTS },
    async () => {
      function Badge({
        label,
        tone,
      }: {
        label?: string;
        tone?: string;
      }): React.ReactElement {
        return h(
          'box',
          { style: { backgroundColor: tone, padding: 4 } },
          h('text', { style: { color: 'white' } }, label),
        );
      }
      registerReactComponent(
        'Lab.Widgets',
        'Badge',
        Badge as React.ComponentType<Record<string, unknown>>,
        {
          properties: { label: { default: '' }, tone: { default: '#000000' } },
        },
      );
      await mountQml(`
        import QtQuick 2.15
        import Lab.Widgets 1.0
        Rectangle {
          id: root
          width: 200; height: 100; color: "#101010"
          property string mood: "calm"
          Badge { x: 10; y: 10; width: 140; height: 30; label: "mood: " + root.mood; tone: "#16a085" }
        }
      `);
      assert.ok(screen.getByText('mood: calm'), 'bound property arrived');
    },
  );

  test(
    'Behavior rides the style transition engine, on the frame clock',
    { skip: !FONTS },
    async () => {
      const clock = withFrameClock();
      const { ctx } = await mountQml(`
        import QtQuick 2.15
        Rectangle {
          id: root
          width: 300; height: 100; color: "#000000"
          property bool wide: false
          Rectangle {
            x: 0; y: 20; height: 40
            width: root.wide ? 240 : 60
            color: "#e67e22"
            Behavior on width { NumberAnimation { duration: 200 } }
          }
          MouseArea { anchors.fill: parent; onClicked: root.wide = true }
        }
      `);
      await expectPixel(ctx, 40, 40, '#e67e22');
      await expectPixel(ctx, 200, 40, '#000000');
      await act(async () => {
        fireEvent.screenClick(150, 80);
      });
      // The slot jumped to 240, but the renderer is easing: not there yet.
      const [earlyR] = await pixelAt(ctx, 230, 40);
      assert.ok(
        earlyR < 100,
        `width did not snap - a transition is running (r=${earlyR})`,
      );
      await act(async () => {
        clock.advance(400);
      });
      await expectPixel(ctx, 230, 40, '#e67e22', {
        message: 'transition landed on the bound value',
      });
    },
  );

  test(
    'a state Transition eases the switch through the renderer',
    { skip: !FONTS },
    async () => {
      const clock = withFrameClock();
      const { ctx, ref } = await mountQml(`
        import QtQuick 2.15
        Rectangle {
          id: root
          width: 300; height: 100; color: "#000000"
          Rectangle { id: bar; x: 0; y: 20; width: 60; height: 40; color: "#3498db" }
          states: [
            State { name: "wide"; PropertyChanges { target: bar; width: 240 } }
          ]
          transitions: [
            Transition { NumberAnimation { properties: "width"; duration: 200 } }
          ]
        }
      `);
      await expectPixel(ctx, 40, 40, '#3498db');
      await act(async () => {
        ref.current!.root.state = 'wide';
      });
      const [earlyR, , earlyB] = await pixelAt(ctx, 230, 40);
      assert.ok(
        earlyB < 120 && earlyR < 120,
        'the switch is easing, not snapping',
      );
      await act(async () => {
        clock.advance(400);
      });
      await expectPixel(ctx, 230, 40, '#3498db', {
        message: 'state landed through the transition',
      });
    },
  );

  test(
    "Qt's own ListView example runs from its original source",
    { skip: !FONTS },
    async () => {
      // Verbatim from the Qt 6 ListView documentation ("Example Usage"),
      // ContactModel inlined as the docs page shows it — only the import
      // lines' versions differ.
      await mountQml(`
        import QtQuick 2.15
        ListView {
          width: 180; height: 200

          model: ListModel {
            ListElement { name: "Bill Smith"; number: "555 3264" }
            ListElement { name: "John Brown"; number: "555 8426" }
            ListElement { name: "Sam Wise"; number: "555 0473" }
          }
          delegate: Text {
            text: name + ": " + number
            height: 20
          }
        }
      `);
      await waitFor(() => assert.ok(screen.getByText('Bill Smith: 555 3264')));
      assert.ok(screen.getByText('Sam Wise: 555 0473'));
    },
  );

  test(
    'ListView windows its delegates and scrolls to the rest',
    { skip: !FONTS },
    async () => {
      const { ref } = await mountQml(`
        import QtQuick 2.15
        ListView {
          id: list
          width: 200; height: 200
          spacing: 0
          model: 1000
          delegate: Rectangle {
            width: 200; height: 20
            color: index % 2 === 0 ? "#202830" : "#2a3440"
            Text { x: 4; y: 2; color: "white"; text: "row " + modelData }
          }
        }
      `);
      await waitFor(() => assert.ok(screen.getByText('row 0')));
      const list = ref.current!.instance;
      const live = list.visualChildren().length;
      assert.ok(
        live > 5 && live < 60,
        `windowed: ${live} of 1000 delegates instantiated`,
      );
      assert.equal(
        ref.current!.id('list')!.contentHeight,
        1000 * 20,
        'contentHeight covers the whole model',
      );
      assert.equal(screen.queryByText('row 500'), null, 'far row not built');
      await act(async () => {
        ref.current!.id('list')!.contentY = 500 * 20;
      });
      await waitFor(() => assert.ok(screen.getByText('row 500')));
      const liveAfter = list.visualChildren().length;
      assert.ok(liveAfter < 80, `window moved, did not grow: ${liveAfter}`);
    },
  );

  test(
    'TextInput binds two ways and fires accepted on Return',
    { skip: !FONTS },
    async () => {
      const { ref } = await mountQml(`
        import QtQuick 2.15
        Rectangle {
          id: root
          width: 300; height: 120; color: "#101010"
          property string submitted: ""
          TextInput {
            id: field
            x: 10; y: 10; width: 200; height: 28
            color: "white"
            focus: true
            onAccepted: root.submitted = field.text
          }
          Text { x: 10; y: 60; color: "white"; text: "echo: " + field.text }
        }
      `);
      const field = screen.getByRole('textbox');
      await userEvent.type(field, 'hi qml');
      await waitFor(() => assert.ok(screen.getByText('echo: hi qml')));
      assert.equal(ref.current!.id('field')!.text, 'hi qml');
      await userEvent.key(XK_RETURN);
      await waitFor(() =>
        assert.equal(ref.current!.root.submitted, 'hi qml', 'accepted fired'),
      );
      // The other direction: assignment shows up in the editor.
      await act(async () => {
        ref.current!.id('field')!.text = 'reset';
      });
      await waitFor(() => assert.ok(screen.getByText('echo: reset')));
    },
  );

  test(
    'Keys attached handlers see the focused item’s keys',
    { skip: !FONTS },
    async () => {
      const { ref } = await mountQml(`
        import QtQuick 2.15
        Rectangle {
          id: root
          width: 200; height: 100; color: "#101010"
          property string last: ""
          Rectangle {
            width: 100; height: 40; color: "#334455"
            focus: true
            Keys.onReturnPressed: root.last = "return"
            Keys.onPressed: (event) => { if (event.text === "x") root.last = "x" }
          }
        }
      `);
      await userEvent.key(XK_RETURN);
      await waitFor(() => assert.equal(ref.current!.root.last, 'return'));
      await act(async () => {
        fireEvent.char('x');
      });
      await waitFor(() => assert.equal(ref.current!.root.last, 'x'));
    },
  );

  test(
    'an infinite NumberAnimation loops through the style engine',
    { skip: !FONTS },
    async () => {
      const clock = withFrameClock();
      const { ctx } = await mountQml(`
        import QtQuick 2.15
        Rectangle {
          width: 300; height: 100; color: "#000000"
          Rectangle {
            y: 30; width: 40; height: 40; color: "#e74c3c"
            NumberAnimation on x { from: 0; to: 200; duration: 400; loops: Animation.Infinite }
          }
        }
      `);
      await act(async () => {
        clock.advance(200); // half way, linear
      });
      const [midR] = await pixelAt(ctx, 120, 50);
      assert.ok(midR > 150, `mid-flight the bar is under x=120 (r=${midR})`);
      await expectPixel(ctx, 10, 50, '#000000', {
        message: 'and has left the start',
      });
    },
  );
});
