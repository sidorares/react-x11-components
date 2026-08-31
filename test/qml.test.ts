// src/qml — the QML engine. Two layers: headless tests pin the language
// semantics (the binding graph, anchors, aliases, binding-breaking
// assignment, states as override layers) with no server at all, and
// rendered tests pin the bridge — that QML documents become ordinary
// react-x11 trees whose pixels, events and transitions are the renderer's
// own. Everything runs on the in-process server; no DISPLAY.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  createFileResolver,
  Qt,
  type QmlFacade,
  type QmlResolver,
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

describe('QML file components (the resolver seam)', () => {
  // A resolver is any object with the QmlResolver shape; tests hand the
  // engine a plain in-memory one — no filesystem, same semantics.
  const mock = (files: Record<string, string>): QmlResolver => ({
    rootDir: '/app',
    load(dir, name) {
      const file = `${dir}/${name}.qml`;
      const source = files[file];
      return source === undefined ? null : { source, fileName: file };
    },
    join(dir, relative) {
      const out: string[] = [];
      for (const part of `${dir}/${relative}`.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') out.pop();
        else out.push(part);
      }
      return `/${out.join('/')}`;
    },
  });

  const headlessWith = (
    files: Record<string, string>,
    main: string,
    extras: Record<string, unknown> | null = null,
  ) =>
    instantiateDocument(parseQml(main, { fileName: '/app/main.qml' }), {
      resolver: mock(files),
      extras,
    });

  test('the implicit same-directory import, with use-site composition', () => {
    const seen: string[] = [];
    const { root, context } = headlessWith(
      {
        '/app/MyBackdrop.qml': `
          import QtQuick 2.15
          Rectangle {
            id: inner
            width: 200; height: 100
            color: "teal"
            property string label: "backdrop"
            signal poked(string what)
            function greet() { return "hi " + label }
          }
        `,
      },
      `
        import QtQuick 2.15
        Item {
          id: root
          property int base: 200
          MyBackdrop {
            id: background
            width: root.base * 2
            onPoked: (what) => root.note(what)
            Text { id: caption; text: "on top of " + background.label }
          }
          function note(s) { }
        }
      `,
    );
    root.methods.set('note', (s) => seen.push(String(s)));
    const background = context.ids.get('background')!;
    // Site members won and evaluated in the *site's* scope.
    assert.equal(background.slot('width').peek(), 400);
    // The component file's own members hold underneath.
    assert.equal(background.slot('height').peek(), 100);
    assert.equal(background.slot('color').peek(), 'teal');
    assert.equal(
      background.typeInfo.name,
      'Rectangle',
      'root type shows through',
    );
    // File internals are private: `inner` is not a site id…
    assert.equal(context.ids.get('inner'), undefined);
    // …while the site child was appended and sees site names.
    const caption = context.ids.get('caption')!;
    assert.equal(caption.slot('text').peek(), 'on top of backdrop');
    assert.equal(caption.parentInst, background);
    // Declared signal, site handler; declared method through the facade.
    background.facade.poked('ouch');
    flushBindings();
    assert.deepEqual(seen, ['ouch']);
    assert.equal(background.facade.greet(), 'hi backdrop');
    // Site bindings stay live.
    root.facade.base = 10;
    flushBindings();
    assert.equal(background.slot('width').peek(), 20);
    root.destroy();
  });

  test('a local <Name>.qml shadows a module type, as in Qt', () => {
    const { root } = headlessWith(
      {
        '/app/Rectangle.qml': `
          import QtQuick 2.15
          Item { property string flavour: "local" }
        `,
      },
      `
        import QtQuick 2.15
        Item { Rectangle { id: r } }
      `,
    );
    assert.equal(root.children[0].facade.flavour, 'local');
    root.destroy();
  });

  test('a quoted directory import, and components nesting components', () => {
    const { root } = headlessWith(
      {
        '/app/widgets/Fancy.qml': `
          import QtQuick 2.15
          Item { property string who: "fancy"; Plain { id: p } }
        `,
        '/app/widgets/Plain.qml': `
          import QtQuick 2.15
          Item { property int depth: 2 }
        `,
      },
      `
        import QtQuick 2.15
        import "./widgets"
        Item { Fancy { id: f } }
      `,
    );
    const f = root.children[0];
    assert.equal(f.facade.who, 'fancy');
    assert.equal(f.children[0].facade.depth, 2, 'components nest');
    root.destroy();
  });

  test('context properties reach inside file components', () => {
    const { root } = headlessWith(
      {
        '/app/Greeting.qml': `
          import QtQuick 2.15
          Item { property string text: "hello " + userName }
        `,
      },
      'import QtQuick 2.15\nItem { Greeting { id: g } }',
      { userName: 'ada' },
    );
    assert.equal(root.children[0].facade.text, 'hello ada');
    root.destroy();
  });

  test('a component cycle fails with the chain in the message', () => {
    assert.throws(
      () =>
        headlessWith(
          {
            '/app/Alpha.qml': 'import QtQuick 2.15\nItem { Beta { } }',
            '/app/Beta.qml': 'import QtQuick 2.15\nItem { Alpha { } }',
          },
          'import QtQuick 2.15\nItem { Alpha { } }',
        ),
      /circular component reference.*Alpha\.qml.*Beta\.qml/s,
    );
  });

  test('Loader.source loads a component document through the resolver', () => {
    const { context } = headlessWith(
      {
        '/app/widgets/Panel.qml': `
          import QtQuick 2.15
          Rectangle { width: 33; height: 7; property string tag: "panel" }
        `,
      },
      `
        import QtQuick 2.15
        Item { Loader { id: ld; source: "widgets/Panel.qml" } }
      `,
    );
    const ld = context.ids.get('ld')!;
    assert.equal((ld.slot('item').peek() as QmlFacade).tag, 'panel');
    assert.equal(ld.slot('width').peek(), 33, 'Loader takes the item size');
    context.root!.destroy();
  });

  test('without a resolver, the unknown-type error says how to get one', () => {
    assert.throws(
      () => headless('import QtQuick 2.15\nMyBackdrop { }'),
      /createFileResolver/,
    );
  });

  test('createFileResolver: the standard filesystem helper, end to end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qml-resolver-'));
    try {
      await writeFile(
        join(dir, 'background.qml'),
        'import QtQuick 2.15\nMyBackdrop {\n  id: background\n}\n',
      );
      await writeFile(
        join(dir, 'MyBackdrop.qml'),
        `import QtQuick 2.15
         import "./widgets"
         Rectangle {
           width: 300; height: 120; color: "#204080"
           property alias meterWidth: m.width
           Meter { id: m }
         }`,
      );
      await mkdir(join(dir, 'widgets'), { recursive: true });
      await writeFile(
        join(dir, 'widgets', 'Meter.qml'),
        'import QtQuick 2.15\nRectangle { width: 55; height: 10; color: "gold" }\n',
      );
      const resolver = await createFileResolver(dir);
      const { root, context } = instantiateDocument(
        parseQml('import QtQuick 2.15\nMyBackdrop {\n  id: background\n}\n', {
          fileName: join(dir, 'background.qml'),
        }),
        { resolver },
      );
      const background = context.ids.get('background')!;
      assert.equal(background.slot('width').peek(), 300);
      assert.equal(background.slot('color').peek(), '#204080');
      assert.equal(
        background.facade.meterWidth,
        55,
        'quoted import resolved from inside the component file',
      );
      root.destroy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(
    'a file component renders: pixels from the component, site child on top',
    { skip: !FONTS },
    async () => {
      const resolver = mock({
        '/app/Card.qml': `
          import QtQuick 2.15
          Rectangle {
            width: 200; height: 120; color: "#16a085"
            Rectangle { x: 10; y: 10; width: 40; height: 40; color: "#0b3d34" }
          }
        `,
      });
      const ref = React.createRef<QmlViewHandle>();
      const { ctx } = await renderX11(
        h(QmlView, {
          ref,
          source: `
            import QtQuick 2.15
            Card {
              id: card
              Rectangle { x: 150; y: 80; width: 30; height: 30; color: "#e67e22" }
            }
          `,
          resolver,
        }),
        { width: 300, height: 200, fonts: FONTS ?? undefined },
      );
      await waitFor(() => assert.ok(ref.current));
      await expectPixel(ctx, 100, 60, '#16a085', {
        message: 'component body painted',
      });
      await expectPixel(ctx, 30, 30, '#0b3d34', {
        message: 'component-internal child painted',
      });
      await expectPixel(ctx, 165, 95, '#e67e22', {
        message: 'use-site child painted on top',
      });
    },
  );
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
    'a root with no declared size fills the app-sized view',
    { skip: !FONTS },
    async () => {
      const ref = React.createRef<QmlViewHandle>();
      const { ctx } = await renderX11(
        h(QmlView, {
          ref,
          source: `
            import QtQuick 2.15
            Rectangle {
              id: root
              color: "#204080"
              Rectangle {
                x: Math.max(0, root.width - 50); y: 0
                width: 50; height: 50; color: "#e67e22"
              }
            }
          `,
          style: { width: 300, height: 220 },
        }),
        { width: 400, height: 300, fonts: FONTS ?? undefined },
      );
      await waitFor(() => {
        // The wrapper's laid-out size fed back into the root's implicit
        // size; the default width binding picked it up.
        assert.equal(ref.current!.root.width, 300);
        assert.equal(ref.current!.root.height, 220);
      });
      await expectPixel(ctx, 150, 110, '#204080', {
        message: 'the root painted at the view size',
      });
      await expectPixel(ctx, 280, 25, '#e67e22', {
        message: 'a binding on root.width placed the corner box',
      });
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

describe('QtQuick.Layouts over yoga', () => {
  test('implicit size of a layout comes from its children (headless)', () => {
    const { context, root } = headless(`
      import QtQuick 2.15
      import QtQuick.Layouts 1.15
      Item {
        RowLayout {
          id: lay
          spacing: 10
          Item { Layout.preferredWidth: 50; Layout.preferredHeight: 20 }
          Item { Layout.preferredWidth: 30; Layout.preferredHeight: 40 }
        }
      }
    `);
    const lay = context.ids.get('lay')!;
    assert.equal(lay.slot('implicitWidth').peek(), 90, '50 + 10 + 30');
    assert.equal(lay.slot('implicitHeight').peek(), 40, 'tallest child');
    assert.equal(lay.slot('width').peek(), 90, 'width tracks the hint');
    root.destroy();
  });

  test(
    'RowLayout places, fills, and reflects geometry back to expressions',
    { skip: !FONTS },
    async () => {
      const { ctx, ref } = await mountQml(`
        import QtQuick 2.15
        import QtQuick.Layouts 1.15
        Rectangle {
          width: 400; height: 130; color: "#000000"
          RowLayout {
            x: 0; y: 0; width: 400; height: 100
            spacing: 10
            Rectangle { id: a; Layout.preferredWidth: 50; Layout.preferredHeight: 40; color: "#e74c3c" }
            Rectangle { id: b; Layout.preferredWidth: 70; Layout.preferredHeight: 40; color: "#2ecc71" }
            Rectangle { id: c; Layout.fillWidth: true; Layout.preferredHeight: 40; color: "#3498db" }
          }
          Text { x: 4; y: 104; color: "white"; text: "cw=" + c.width }
        }
      `);
      // Yoga's placement, in pixels: 50 + 10 + 70 + 10, the rest fills.
      await expectPixel(ctx, 25, 50, '#e74c3c');
      await expectPixel(ctx, 95, 50, '#2ecc71');
      await expectPixel(ctx, 200, 50, '#3498db');
      await expectPixel(ctx, 25, 10, '#000000', {
        message: 'default alignment centers the shorter items',
      });
      // The read-back: expressions see yoga's answers.
      await waitFor(() => {
        assert.equal(ref.current!.id('b')!.x, 60);
        assert.equal(ref.current!.id('a')!.y, 30, 'centered: (100 - 40) / 2');
        assert.equal(ref.current!.id('c')!.width, 260, '400 - 140 fills');
      });
      await waitFor(() => assert.ok(screen.getByText('cw=260')));
    },
  );

  test('nested layouts and Layout.alignment', { skip: !FONTS }, async () => {
    const { ctx, ref } = await mountQml(`
        import QtQuick 2.15
        import QtQuick.Layouts 1.15
        Rectangle {
          width: 300; height: 200; color: "#000000"
          ColumnLayout {
            x: 0; y: 0; width: 300; height: 200
            spacing: 0
            Rectangle { id: badge; Layout.preferredWidth: 60; Layout.preferredHeight: 30; Layout.alignment: Qt.AlignRight; color: "#f1c40f" }
            RowLayout {
              Layout.fillWidth: true
              Layout.preferredHeight: 40
              spacing: 0
              Rectangle { Layout.fillWidth: true; Layout.fillHeight: true; color: "#9b59b6" }
              Rectangle { Layout.preferredWidth: 100; Layout.fillHeight: true; color: "#1abc9c" }
            }
          }
        }
      `);
    await expectPixel(ctx, 270, 15, '#f1c40f', {
      message: 'AlignRight pushed the badge to the edge',
    });
    await expectPixel(ctx, 30, 15, '#000000');
    await expectPixel(ctx, 100, 50, '#9b59b6', {
      message: 'the nested row fills the remaining width',
    });
    await expectPixel(ctx, 250, 50, '#1abc9c');
    await waitFor(() =>
      assert.equal(ref.current!.id('badge')!.x, 240, 'read-back: 300 - 60'),
    );
  });

  test(
    'a Repeater inside a RowLayout: spliced children are flex items',
    { skip: !FONTS },
    async () => {
      const { ctx } = await mountQml(`
        import QtQuick 2.15
        import QtQuick.Layouts 1.15
        Rectangle {
          width: 300; height: 80; color: "#000000"
          RowLayout {
            x: 0; y: 0; width: 300; height: 80
            spacing: 10
            Repeater {
              model: ["#e74c3c", "#2ecc71", "#3498db"]
              Rectangle { Layout.preferredWidth: 40; Layout.preferredHeight: 40; color: modelData }
            }
          }
        }
      `);
      await expectPixel(ctx, 20, 40, '#e74c3c');
      await expectPixel(ctx, 70, 40, '#2ecc71');
      await expectPixel(ctx, 120, 40, '#3498db');
      await expectPixel(ctx, 160, 40, '#000000', {
        message: 'nothing after the third',
      });
    },
  );
});
