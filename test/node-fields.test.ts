// Core's `Node` keeps its state in fields on every instance, and every
// element this package registers extends it. A field on the instance shadows
// a method of the same name further down the prototype chain, so a field core
// adds in a minor release can take a method away from an element here with no
// type error and no test in core to notice: react-x11 2.12 began setting
// `_host` on every node, `<Chart>`'s plot node had a `_host()` method, and
// every chart threw in `paint` on a fresh install.
//
// So this asks core for the fields a node has, and every element here for the
// methods it defines, and fails on a name that is both.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { cleanup, renderX11 } from 'react-x11/test';
import { Node } from 'react-x11/node';

import { ChartPlotNode } from '../src/charts/node.js';
import { CodeEditorNode } from '../src/code-editor/node.js';
import { FlowGraphNode } from '../src/flow/node.js';
import { FormulaNode } from '../src/formula/node.js';
import { HtmlViewNode } from '../src/html/node.js';
import { GlPaneNode } from '../src/maps/gl/pane.js';
import { MapViewNode } from '../src/maps/node.js';
import {
  EditorTextNode,
  RichEditorNode,
} from '../src/rich-text-editor/nodes.js';
import { RichTextNode } from '../src/richtext/node.js';
import { VtTermNode } from '../src/terminal/vt/node.js';

test.afterEach(async () => {
  await cleanup();
});

/** Every node class an element here is made of. */
const ELEMENTS: { name: string; prototype: object }[] = [
  ChartPlotNode,
  CodeEditorNode,
  EditorTextNode,
  FlowGraphNode,
  FormulaNode,
  GlPaneNode,
  HtmlViewNode,
  MapViewNode,
  RichEditorNode,
  RichTextNode,
  VtTermNode,
];

test('no element here defines a method under the name of a field core keeps on every node', async () => {
  const { app } = await renderX11(React.createElement('box'), {
    backend: 'mock',
    width: 10,
    height: 10,
  });
  const fields = new Set(
    Object.getOwnPropertyNames(new Node('probe', {}, app as never)),
  );
  assert.ok(
    fields.has('props') && fields.has('parent'),
    'a node, as core makes one',
  );
  const clashes: string[] = [];
  for (const element of ELEMENTS) {
    for (
      let proto: object | null = element.prototype;
      proto !== null && proto !== Node.prototype;
      proto = Object.getPrototypeOf(proto) as object | null
    ) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name !== 'constructor' && fields.has(name)) {
          clashes.push(`${element.name}.${name}`);
        }
      }
    }
  }
  assert.deepStrictEqual(clashes, []);
});
