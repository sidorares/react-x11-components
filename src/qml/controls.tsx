// `import QtQuick.Controls` — the beginnings of the Controls story:
// widgets react-x11 already ships, registered as QML types. The widgets
// are passed in rather than imported here, so the family costs nothing
// when Controls are unused and the app decides which widget set answers
// (core's `Button`, or its own).

import type { ComponentType } from 'react';
import { registerQmlModule } from './objects.js';
import { geometryStyle } from './react.js';
import { str } from './view-utils.js';

export interface ControlsWidgets {
  /** A pressable taking `primary`, `disabled`, `onPress` and children —
   * core's `Button` as it stands. Deliberately `ComponentType<any>`:
   * React's `propTypes`/`defaultProps` members make component types
   * near-invariant in their props, so a props-typed seam rejects any
   * richer button; `any` is the honest edge (eslint does not see
   * TypeScript here — AGENTS.md, "Linting").  */
  Button: ComponentType<any>;
}

export function registerControls({ Button }: ControlsWidgets): void {
  registerQmlModule('QtQuick.Controls', {
    version: '2.0',
    types: {
      Button: {
        extends: 'Item',
        properties: {
          text: { default: '' },
          primary: { default: false },
        },
        signals: { clicked: [] },
        view: ({ inst }) => (
          <box style={geometryStyle(inst)}>
            <Button
              primary={inst.slot('primary').peek() === true}
              disabled={inst.slot('enabled').peek() === false}
              onPress={() => inst.emit('clicked')}
            >
              {str(inst.slot('text').peek())}
            </Button>
          </box>
        ),
      },
    },
  });
}
