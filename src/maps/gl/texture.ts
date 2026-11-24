// `<Map>`'s GL renderer without its `<glarea>`: a map drawn into a texture of
// its own, in a GL context somebody else owns — `<Flow>`'s, for a node whose
// body is a live map (`GlMapLayer`, `../layer.ts`, is the half an app holds).
//
// Nothing about drawing a map changes for it. `GlMapDriver` was written
// against two structural nodes, a pane it asks where it is and an area it
// asks for frames, and `GlMapRenderer.render` draws into whatever framebuffer
// is bound. So this is a framebuffer — a colour texture and a depth-stencil
// renderbuffer, the shape the renderer's own offscreen targets have, since a
// fill is a stencil pass — and the two nodes made of plain objects: the pane
// a box at the origin the texture's size, in the units the host's `scale`
// makes of it, and the area a function that asks the host for a frame.
//
// Loaded with the rest of the GL renderer and never otherwise
// (`../renderer.ts`, `loadGlRenderer`): a `<Map>` that draws through the
// retained renderer, and an app that holds no map layer, bundle none of it.
import type { MapController } from '../controller.js';
import type { MapProps } from '../types.js';
import { GlMapDriver } from './view.js';

const FRAMEBUFFER_BINDING = 0x8ca6;

/** The size a host asks for, and the unit it is in. */
export interface MapTextureFrame {
  /** Device pixels. */
  width: number;
  height: number;
  /** Device pixels per logical pixel of the map: its labels, its line
   *  widths, the distance a drag moves it. */
  scale: number;
}

/** What one frame drew: the texture, and its size. */
export interface MapTexture {
  texture: unknown;
  width: number;
  height: number;
}

export interface MapTextureOptions {
  map: MapProps;
  /** The react-x11 app the host draws in: what the labels are set with. */
  app: unknown;
  theme: unknown;
  /** Ask the host for a frame — a tile landed, a glide stepped, a label is
   *  fading in. */
  request: () => void;
  /** GL failed: the context, a shader, a frame. Called once. */
  onFailure: (error: Error) => void;
}

interface Target {
  gl: unknown;
  fbo: unknown;
  texture: unknown;
  depth: unknown;
  width: number;
  height: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GL = any;

/** A map, drawn on demand into a texture in the host's context. */
export class GlMapTexture {
  private readonly _driver: GlMapDriver;
  private readonly _node: {
    scale: number;
    app: unknown;
    width: number;
    height: number;
    contentBox(): { x: number; y: number; width: number; height: number };
    focus(): void;
  };
  private _target: Target | null = null;
  private _failed = false;

  constructor(controller: MapController, options: MapTextureOptions) {
    // What the driver reads as its pane, and as the node its surface is on:
    // where it is (the origin — input reaches the controller in its own
    // coordinates), how big, at what scale, and in which app.
    const node = {
      scale: 1,
      app: options.app,
      width: 0,
      height: 0,
      contentBox: () => ({
        x: 0,
        y: 0,
        width: node.width,
        height: node.height,
      }),
      focus: () => {},
    };
    this._node = node;
    this._driver = new GlMapDriver(controller, {
      controller,
      map: options.map,
      onFailure: (error) => {
        this._failed = true;
        options.onFailure(error);
      },
    });
    this._driver.theme = options.theme;
    this._driver.attach();
    this._driver.paneRef(node);
    this._driver.areaRef({ requestFrame: options.request });
  }

  /** The map's props from here on, as `<Map>` re-renders its pane with. */
  setProps(map: MapProps): void {
    this._driver.props = { ...this._driver.props, map };
  }

  setTheme(theme: unknown): void {
    this._driver.theme = theme;
  }

  /** A commit landed: what it changed that a frame shows asks for one. */
  committed(): void {
    this._driver.committed();
  }

  /**
   * One frame of the map, into the texture — made, or made again at this
   * size or in this context. The framebuffer bound before is bound again
   * after, whatever the frame did.
   */
  draw(gl: unknown, frame: MapTextureFrame): MapTexture | null {
    if (this._failed) return null;
    const width = Math.max(1, Math.round(frame.width));
    const height = Math.max(1, Math.round(frame.height));
    const node = this._node;
    node.scale = frame.scale > 0 ? frame.scale : 1;
    node.width = width;
    node.height = height;
    const target = this._targetFor(gl as GL, width, height);
    const g = gl as GL;
    const previous = g.getParameter(FRAMEBUFFER_BINDING);
    g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
    try {
      this._driver.draw(gl, { width, height, node });
    } finally {
      g.bindFramebuffer(g.FRAMEBUFFER, previous ?? null);
    }
    if (this._failed) return null;
    return { texture: target.texture, width, height };
  }

  /** Let go of everything: the driver's stores, workers and buffers, and
   *  the framebuffer. A later `draw` starts again. */
  dispose(): void {
    this._driver.dispose();
    this._dropTarget();
  }

  /** A colour texture and a depth-stencil renderbuffer behind one
   *  framebuffer, at this size, in this context. */
  private _targetFor(gl: GL, width: number, height: number): Target {
    const held = this._target;
    if (
      held &&
      held.gl === gl &&
      held.width === width &&
      held.height === height
    )
      return held;
    // another context owns none of the old one's objects
    if (held && held.gl === gl) this._dropTarget();
    this._target = null;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    // Linear: the host stretches it through a zoom gesture, and draws it
    // texel for pixel at rest, where linear and nearest are the same.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, width, height);
    const previous = gl.getParameter(FRAMEBUFFER_BINDING);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.RENDERBUFFER,
      depth,
    );
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.STENCIL_ATTACHMENT,
      gl.RENDERBUFFER,
      depth,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous ?? null);
    this._target = { gl, fbo, texture, depth, width, height };
    return this._target;
  }

  private _dropTarget(): void {
    const target = this._target;
    this._target = null;
    if (!target) return;
    const gl = target.gl as GL;
    try {
      gl.deleteFramebuffer(target.fbo);
      gl.deleteRenderbuffer(target.depth);
      gl.deleteTexture(target.texture);
    } catch {
      // A context that is gone deleted them with it.
    }
  }
}
