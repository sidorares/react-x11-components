// The GL renderer's entry: what `<Flow>` loads, by dynamic import, when it is
// asked to draw through GL — and only then. A static import anywhere under
// `<Flow>` would put the shaders and the packer into every bundle that draws
// a graph; `test/treeshake.test.ts` holds it to that, as it holds `<Map>`.
//
// What is here is the surface: a `<glarea>` laid over the pane, drawing the
// pane's own scene every frame it is asked for one. It owns no graph and no
// input. The `<flowgraph>` element under it keeps both — the hit test skips a
// surface and answers with the node behind it, which is the pane — and asks
// for frames through `setGlRequest`, so every change the 2D renderer would
// have repainted becomes one GL frame.
import React, { useEffect, useMemo } from 'react';
import type { ReactElement } from 'react';

import type { FlowGlFrameStats } from '../types.js';
import { FlowGlRenderer, now } from './renderer.js';
import type { FlowGlFrame } from './renderer.js';

/** What the surface needs of the pane — `FlowGraphNode`, structurally. */
export interface FlowGlSource {
  glFrame(lastKey: string | null): (FlowGlFrame & { key: string }) | null;
  setGlRequest(request: (() => void) | null): void;
}

export interface FlowGlSurfaceProps {
  pane: { readonly current: FlowGlSource | null };
  /** The colour a frame starts from — the palette's background, so the
   *  instant before the first frame is the graph's ground, not black. */
  clearColor: string;
  onFrame?: (stats: FlowGlFrameStats) => void;
  /** The surface could not draw; `<Flow>` goes back to the 2D renderer. */
  onError: (error: Error) => void;
}

interface AreaNode {
  requestFrame?(): void;
}

interface DrawInfoLike {
  width: number;
  height: number;
  scale: number;
  node: { abs: { x: number; y: number } };
}

/** The surface's state across renders: the renderer lives as long as the GL
 *  context it was made for, which is longer than any one props object. */
class Driver {
  props: FlowGlSurfaceProps;
  private area: AreaNode | null = null;
  private renderer: FlowGlRenderer | null = null;
  private context: unknown = null;
  /** The key of the world now on the GPU — null when there is none, which
   *  is what makes the next frame build one. */
  private worldKey: string | null = null;
  private failed = false;

  constructor(props: FlowGlSurfaceProps) {
    this.props = props;
  }

  /** Stable, so the pane can compare it and not repaint on every render. */
  readonly request = (): void => {
    this.area?.requestFrame?.();
  };

  readonly areaRef = (node: AreaNode | null): void => {
    this.area = node;
    this.attach();
  };

  attach(): void {
    this.props.pane.current?.setGlRequest(
      this.area && !this.failed ? this.request : null,
    );
  }

  detach(): void {
    this.props.pane.current?.setGlRequest(null);
  }

  readonly draw = (gl: unknown, info: DrawInfoLike): void => {
    if (this.failed) return;
    try {
      if (this.context !== gl || !this.renderer) {
        // A new context is new everything: programs and buffers belong to
        // the one they were made in.
        this.renderer = new FlowGlRenderer(gl);
        this.context = gl;
        this.worldKey = null;
      }
      const pane = this.props.pane.current;
      if (!pane) return;
      const started = now();
      const frame = pane.glFrame(this.worldKey);
      if (!frame) return;
      const sceneMs = now() - started;
      // The scene is in logical window pixels and the surface is a box of
      // its own in device ones: where that box sits is the one number the
      // vertex shaders need to meet in the middle.
      const s = info.scale;
      const stats = this.renderer.drawFrame(frame, {
        origin: { x: info.node.abs.x / s, y: info.node.abs.y / s },
        scale: s,
        width: info.width,
        height: info.height,
      });
      if (frame.world) this.worldKey = frame.key;
      this.props.onFrame?.({ sceneMs, ...stats });
    } catch (error) {
      this.fail(error);
    }
  };

  readonly surfaceError = (error: Error): void => {
    this.fail(error);
  };

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.detach();
    this.props.onError(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/**
 * Over the pane's box, and **transparent to the pointer**.
 *
 * Core hit-tests a window's surfaces before its tree (`GlAreaNode.hitSurface`
 * in react-x11): a point over a `<glarea>` is over *it*, whatever sits behind
 * in the tree. Everything a graph editor does with the pointer lives on the
 * pane underneath, so without this a press on a card landed on the surface,
 * which has no handlers, and a drag did nothing at all — found by driving
 * a real drag through the Cocoa backend, which moved the node 177 px on the
 * 2D renderer and 0 on this one. `pointerEvents: 'none'` is core's own way
 * to say a node is for looking at, and it lets the pointer through to the
 * pane as it would through any node.
 *
 * It holds while the surface has no children. Node bodies belong inside it
 * as overlay children (`docs/prd-flow-gl.md`), and those do want the
 * pointer — so the day they move in, the surface becomes the pane's child
 * instead, as `<Map>`'s is, and events bubble to the pane from there.
 */
const FILL = {
  position: 'absolute',
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  pointerEvents: 'none',
} as const;

/**
 * The surface. Mounted by `<Flow>` as the pane's sibling, after it, filling
 * the same box: a `<glarea>` is stacked over everything 2D in its window, so
 * it lands on the pane wherever it is in the tree.
 */
export function FlowGlSurface(props: FlowGlSurfaceProps): ReactElement {
  const driver = useMemo(() => new Driver(props), []);
  driver.props = props;
  useEffect(() => {
    driver.attach();
    return () => driver.detach();
  }, [driver]);
  return React.createElement('glarea', {
    ref: driver.areaRef,
    style: FILL,
    clearColor: props.clearColor,
    frameLoop: 'demand',
    onDraw: driver.draw,
    onError: driver.surfaceError,
  });
}
