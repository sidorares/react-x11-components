// Type-level test: the declarations compile against react-x11's JSX
// namespace, both as a component and as the raw `<htmlview>` element the
// component's augmentation adds.
import { Html, useHtmlHandle } from '../../src/index.js';
import { createHtmlElement, parseHtmlFragment } from '../../src/index.js';
import type {
  HtmlControlRect,
  HtmlDocument,
  HtmlElement,
  HtmlProps,
  HtmlResourceRequest,
  HtmlResourceResult,
  HtmlScriptRequest,
} from '../../src/index.js';

export const asComponent = (
  <box style={{ overflow: 'scroll', flexGrow: 1 }}>
    <Html
      source="<h1>Hello</h1><p>a <em>document</em></p>"
      partial={false}
      selectable
      stylesheet="p { margin: 0 }"
      fontSize={15}
      monoFamily="'JetBrains Mono', monospace"
      onLink={(href, ev) => {
        void href;
        void ev.x;
      }}
      onScript={(script) => {
        // Handed over, never run: the text is a string like any other.
        void script.text.length;
        void script.src;
        void script.type;
      }}
      onResource={(request) => {
        if (request.kind === 'stylesheet')
          return { kind: 'stylesheet', text: '' };
        return null;
      }}
      onControlChange={(element, value) => {
        void element.attribs.name;
        void value;
      }}
      style={{ padding: 12 }}
    />
  </box>
);

// A resource handler may be async, and may hand back an image it decoded.
const resource = async (
  request: HtmlResourceRequest,
): Promise<HtmlResourceResult | null> => {
  if (request.kind === 'image') {
    return { kind: 'image', bytes: new Uint8Array(0) };
  }
  return { kind: 'stylesheet', text: 'body { margin: 0 }' };
};
void resource;

// The stylesheet prop takes one or several.
const sheets: HtmlProps['stylesheet'] = ['a { color: red }', 'p { margin: 0 }'];
export const withSheets = <Html source="<p>x</p>" stylesheet={sheets} />;

// The handle exposes the live DOM, and the DOM helpers speak it.
export function WithHandle(): React.ReactElement {
  const handle = useHtmlHandle();
  const doc: HtmlDocument | null = handle.document;
  if (doc) {
    const inserted: HtmlElement = createHtmlElement('p', { class: 'note' });
    void inserted.attribs.class;
    void parseHtmlFragment('<b>bold</b>').length;
    void handle.title;
    void handle.elementAt(0, 0);
    handle.refresh();
  }
  return <Html source="<p>x</p>" ref={handle.ref} />;
}

// The rects the element reports for its form controls.
const rect: HtmlControlRect = {
  element: createHtmlElement('input'),
  kind: 'input',
  x: 0,
  y: 0,
  width: 100,
  height: 24,
};
void rect;

const script: HtmlScriptRequest['type'] = 'text/javascript';
void script;
