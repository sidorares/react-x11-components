// `GlMapLayer` — a map that draws into a GL context somebody else owns: a
// live map as the body of a `<Flow>` node, drawn by the graph's own surface
// in the graph's own paint order (`FlowNodeType.glBody`).
//
// Why it exists, rather than `<Map renderer="gl">` mounted in the node: that
// gets a `<glarea>` of its own, among the graph's surface's children, and
// core does not stack a surface among another surface's children — on macOS
// every GL layer shares one depth, under the overlay that holds the node
// bodies, and on X11 it is a child window that nothing orders against the
// bodies' panes. A body drawn into the graph's context is in the graph.
//
// **The shape is `<Flow>`'s, and nothing here imports it.** `attach`,
// `detach`, `draw` and `pointer` are `FlowGlBody`, written out structurally
// (AGENTS.md, "No component imports another component"); the app joins the
// two, by returning the layer from a node type's `glBody`.
//
// **Everything that is not drawing is `<Map>`'s.** The camera, the gestures,
// the settle window, `onCameraChange`, `onMoveEnd`, the markers' hit test and
// the handle are the map's one `MapController` (`./controller.ts`), as they
// are under both of `<Map>`'s renderers; the drawing is its GL renderer's
// driver, drawn into a framebuffer of the layer's own (`./gl/texture.ts`).
//
// **The GL half is loaded when the layer is first drawn**, by the dynamic
// import `<Map>` loads its GL renderer with (`./renderer.ts`), so this module
// costs a bundle the controller and nothing else — and the first frame or two
// a layer is asked for, it answers with nothing while the chunk arrives, and
// asks for a frame once it has.
import { useEffect, useLayoutEffect, useState } from 'react';
import { useApp, useScreens, useTheme } from 'react-x11';

import { DEFAULT_CAMERA, MapController, fastestRefresh } from './controller.js';
import type { MapPointerInput } from './controller.js';
import { glRendererModule, loadGlRenderer } from './renderer.js';
import type { MapHandle, MapProps } from './types.js';

/** What `<Map>` reads that a layer does not: there is no pane of its own to
 *  style, no renderer to choose, no children to put over it. */
export type GlMapLayerProps = Omit<
  MapProps,
  | 'style'
  | 'children'
  | 'ref'
  | 'renderer'
  | 'onRendererChange'
  | 'role'
  | 'aria-label'
  | 'data-testname'
>;

/** The size a host wants a frame at, and the unit it is in — `<Flow>`'s
 *  `FlowGlBodyFrame`, structurally. */
export interface GlMapLayerFrame {
  /** Device pixels. */
  width: number;
  height: number;
  /** Device pixels per logical pixel of the map. Under `<Flow>`, a graph
   *  unit: the display's scale times the zoom, so the map zooms with the
   *  graph as a mounted body does. */
  scale: number;
}

/** What a frame drew — `<Flow>`'s `FlowGlTexture`, structurally. */
export interface GlMapLayerTexture {
  texture: unknown;
  width: number;
  height: number;
}

/** How a layer asks its host for a frame. */
export interface GlMapLayerHost {
  requestFrame(): void;
}

/** Pointer input from the host, in the map's own logical pixels with its
 *  top-left corner at (0, 0) — `<Flow>`'s `FlowGlBodyPointer`. */
export interface GlMapLayerPointer {
  type: 'down' | 'drag' | 'up' | 'move' | 'leave' | 'wheel';
  x: number;
  y: number;
  button?: number;
  detail?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  deltaX?: number;
  deltaY?: number;
  smooth?: boolean;
}

type GlModule = NonNullable<ReturnType<typeof glRendererModule>>;
type MapTextureObject = InstanceType<GlModule['GlMapTexture']>;

const globals = globalThis as {
  process?: { env?: Record<string, string | undefined> };
  console?: { warn(message: string): void };
};

/**
 * A map drawn on demand into a texture in its host's GL context.
 *
 * Made once per map and kept as long as the map is — `useGlMapLayer` holds
 * one for a component — and handed to one host at a time. Its `handle` is
 * `<Map ref>`'s: the same object for the layer's whole life.
 */
export class GlMapLayer {
  /** What `<Map ref>` hands out: the camera, fits, projection. */
  readonly handle: MapHandle;
  private readonly _controller: MapController;
  private _props: GlMapLayerProps;
  private _app: unknown;
  private _theme: unknown;
  private _host: GlMapLayerHost | null = null;
  private _texture: MapTextureObject | null = null;
  private _loading = false;
  private _failure: Error | null = null;

  constructor(
    props: GlMapLayerProps,
    options: { app?: unknown; theme?: unknown } = {},
  ) {
    this._props = props;
    this._app = options.app ?? null;
    this._theme = options.theme ?? null;
    this._controller = new MapController(props.defaultCamera ?? DEFAULT_CAMERA);
    this._controller.setProps(props);
    this.handle = this._controller.handle;
  }

  /** The props from here on — read at event and frame time, as `<Map>`'s
   *  are, so a new object per render costs an assignment. */
  setProps(props: GlMapLayerProps): void {
    this._props = props;
    this._controller.setProps(props);
    this._texture?.setProps(props);
  }

  setTheme(theme: unknown): void {
    this._theme = theme;
    this._texture?.setTheme(theme);
  }

  /** The display's refresh rate, which a wheel's glide steps at — as
   *  `<Map>` hands its controller the fastest screen's (`useGlMapLayer`
   *  does). Null leaves it at a 60Hz frame. */
  setFrameRate(hz: number | null): void {
    this._controller.setFrameRate(hz);
  }

  /** A commit landed: a frame for what it changed that the map shows. */
  committed(): void {
    this._texture?.committed();
  }

  /** The GL renderer failed for this layer, or `null`. A failed layer
   *  draws nothing again: the host shows what it shows without one. */
  get failure(): Error | null {
    return this._failure;
  }

  // --- the host's half: `FlowGlBody` ----------------------------------------

  attach(host: GlMapLayerHost): void {
    this._host = host;
  }

  /** The host let go: no more frames asked for, and the GL half let go of
   *  what it made in the host's context. The next `attach` starts again. */
  detach(): void {
    this._host = null;
    this._release();
  }

  draw(gl: unknown, frame: GlMapLayerFrame): GlMapLayerTexture | null {
    if (this._failure) return null;
    if (!this._texture) {
      const gl$ = glRendererModule();
      if (!gl$) {
        this._load();
        return null;
      }
      this._texture = new gl$.GlMapTexture(this._controller, {
        map: this._props,
        app: this._app,
        theme: this._theme,
        request: this._request,
        onFailure: this._fail,
      });
    }
    return this._texture.draw(gl, frame);
  }

  /**
   * Input from the host, as `<Map>`'s pane hands it to the controller: a
   * press pans or presses a marker, a wheel zooms about the pointer, motion
   * hovers the markers. False for a press on a map that does not move and a
   * wheel it does not take — the host's to have, as over anything else.
   */
  pointer(event: GlMapLayerPointer): boolean {
    const c = this._controller;
    const input: MapPointerInput = {
      x: event.x,
      y: event.y,
      button: event.button,
      detail: event.detail,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    };
    switch (event.type) {
      case 'down':
        return c.pointerDown(input) !== 'frozen';
      case 'drag':
        c.pointerDrag(input);
        return true;
      case 'up':
        c.pointerUp(input);
        return true;
      case 'move':
        c.pointerMove(input);
        return true;
      case 'leave':
        c.pointerLeave();
        return true;
      case 'wheel':
        return c.wheel(input, event.deltaY ?? 0, event.smooth === true);
    }
  }

  /** Let go of everything, the timers too. The layer still works: a later
   *  frame brings the GL half back, and the camera is where it was. */
  dispose(): void {
    this._release();
    this._controller.dispose();
  }

  private _release(): void {
    const texture = this._texture;
    this._texture = null;
    try {
      texture?.dispose();
    } catch {
      // A context that has gone took its objects with it.
    }
  }

  private readonly _request = (): void => {
    this._host?.requestFrame();
  };

  private readonly _fail = (error: Error): void => {
    if (this._failure) return;
    this._failure = error;
    this._props.onError?.(error);
    if (globals.process?.env?.NODE_ENV !== 'production') {
      globals.console?.warn(
        `@react-x11/components: a GL map layer stopped drawing: ${error.message}`,
      );
    }
  };

  private _load(): void {
    if (this._loading) return;
    this._loading = true;
    loadGlRenderer().then(
      () => {
        this._loading = false;
        this._request();
      },
      (error: unknown) => {
        this._loading = false;
        this._fail(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }
}

/**
 * A {@link GlMapLayer} for the life of a component, kept in step with the
 * props it is handed on every render — `<Map>`'s props, less what only a
 * pane of its own reads.
 *
 * ```tsx
 * const london = useGlMapLayer({ sources, mapStyle, defaultCamera });
 * const nodeTypes = useMemo(() => ({
 *   map: { glBody: () => london, headerHeight: 26 },
 * }), [london]);
 * <Flow renderer="gl" nodeTypes={nodeTypes} … />
 * ```
 */
export function useGlMapLayer(props: GlMapLayerProps): GlMapLayer {
  const app = useApp();
  const theme = useTheme();
  const [layer] = useState(() => new GlMapLayer(props, { app, theme }));
  layer.setProps(props);
  layer.setTheme(theme);
  layer.setFrameRate(fastestRefresh(useScreens().screens));
  useEffect(() => layer.committed());
  // A layout effect, so the GL half goes in the commit that takes the
  // component away — as `<Map>`'s own GL pane lets go of its buffers.
  useLayoutEffect(() => () => layer.dispose(), [layer]);
  return layer;
}
