# WebGPU in `<Html scripts>`

> **Status: investigation, 2026-11-09.** No code. This is the feasibility
> half of a PRD: what each of core's backends has to stand a WebGPU on, what
> npm has for an engine and for a WGSL compiler, what each would cost, and
> the design and phases that follow from it. The first phase is a spike that
> runs the chosen engine, which this investigation could not do (see
> "Not measured").

`navigator.gpu`, the ~40 interfaces of WebGPU, and a `<canvas>`'s
`getContext('webgpu')`, in a document `<Html scripts>` runs. Today a page has
none of it: `'gpu' in navigator` is false, which is what Firefox on Linux and
every browser in an insecure context answer, and what pages are written to
survive.

## The answer in short

- **Do not implement WebGPU. Seam it, as WebGL is seamed, and make the seam
  the standard `GPU` interface.** The host hands in an object shaped like
  `navigator.gpu` from an engine in its own realm: Dawn's `webgpu` package
  under Node, `wgpu-bun` under Bun, a runtime's own one day. The page's realm
  gets a facade of its own classes that records what a page does and the host
  replays it on the engine. Nothing new crosses the bridge: numbers, strings,
  bytes as text.
- **None of core's backends has a GPU API WebGPU can stand on**, so the
  engine brings its own device (Metal, Vulkan, D3D12) and the canvas's frame
  is read back into its pixels, as a WebGL canvas's is. The consequence is
  good news: whether a page has WebGPU is a fact about the machine running
  the page's process, not about the display connection. An indirect GLX
  session, a remote X server and the in-process test server all get it where
  the machine has a GPU. Windows gets it before it gets WebGL: `gpuWebGL()`
  is x11-dri's, which has no Windows build.
- **No WGSL compiler is needed on the recommended route.** Dawn carries Tint
  and validates every call, which also makes WebGPU the safer of the two GPU
  seams: WebGL here hands a page's shaders to the driver as written. The one
  usable WGSL compiler on npm is `naga-wasm` (2.05 MB of WebAssembly), and the
  route it opens — WebGPU over core's GL contexts — leads to a render-only
  subset that is not WebGPU, since no GL core hands out has compute.
- **With no seam, a page has no `navigator.gpu`**, which differs from WebGL on
  purpose. Every browser has WebGL, so a page is written for a context that
  is there, and `<Html>` answers with one that draws nothing. WebGPU is still
  missing from Firefox on Linux and Intel Macs and from Chrome on most Linux
  GPUs, so a page that uses it tests for it, and an absent API is the path it
  has.
- **The engine costs 137 MB.** `webgpu` ships all six platform builds in one
  51 MB tarball. It is an optional peer, never installed for anyone, as
  `node-pty` and `werift` are, and still the heaviest thing this package would
  name.

## Who wants it

WebGPU is not an Interop 2026 focus area, and few pages require it. What uses
it:

- **ML in the page**: transformers.js, ONNX Runtime Web and WebLLM run models
  on WebGPU, and WebLLM has no other backend. These are compute only: buffers,
  compute pipelines, `mapAsync`. No canvas.
- **three.js's `WebGPURenderer`**, which falls back to its WebGL 2 backend
  where `navigator.gpu` is missing or `requestAdapter()` answers null, and
  Babylon.js's WebGPU engine, which a page opts into.
- Demos, creative coding, and the WebGPU samples.

So the order of value is compute first, then a canvas.

Where it ships, so the absent state is understood: Chrome since 113 on
Windows, macOS and ChromeOS, and on Linux only on recent Intel and NVIDIA
GPUs since early 2026; Firefox 141 on Windows and 145 on Apple Silicon Macs,
behind a flag on Linux; Safari 26 everywhere it runs.

## What each backend has

The question for each: is there a GPU API in reach that WebGPU could be built
on, and is there a way to get a GPU's frame into the window without passing
it through JavaScript?

| Backend                             | GPU API core hands out                                                                                                                                                         | Compute                                                              | A frame into the window without a read                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **X11 direct, DRI3** (Linux)        | x11-dri's `Gpu`: EGL over GBM on a DRM render node, OpenGL ES 3.0 (2.0 as a fallback)                                                                                          | none bound: no `dispatchCompute`, no storage buffers, no images      | dma-buf: x11-dri already turns GBM buffers into pixmaps with `DRI3.PixmapFromBuffer`                                                                                                                        |
| **X11 direct, Apple-DRI** (XQuartz) | x11-dri's `apple.Context`: CGL, OpenGL 4.1 core on Metal, bound to a WindowServer surface                                                                                      | none: compute is GL 4.3, and macOS stops at 4.1                      | none in the document: XQuartz composites a GL surface above everything the X server draws (`useSupports('glOverlay')` is false)                                                                             |
| **X11 indirect GLX**                | OpenGL 1.x fixed function, encoded on the X connection                                                                                                                         | no shaders at all                                                    | none: pixels go as `PutImage`                                                                                                                                                                               |
| **Wayland**                         | the same x11-dri `Gpu`; the 2D paint itself is GLES into a backing target                                                                                                      | as DRI3                                                              | dma-buf, as `zwp_linux_dmabuf_v1` (`src/wayland/dmabuf.js` in core)                                                                                                                                         |
| **Cocoa**                           | x11-dri's `apple.Context` with `createTarget`: GL 4.1 into IOSurface-backed framebuffers. appkit has no Metal                                                                  | none                                                                 | IOSurface: appkit makes CoreGraphics surfaces over one (`createSurfaceIOSurface`, `surfaceFromIOSurfaceID`), which the document can draw, and shows one as a layer's contents (`setLayerContentsIOSurface`) |
| **Win32**                           | a D3D11 device (hardware, then WARP) behind Direct2D and DirectComposition; WGL ES 3.0, or core 4.6/4.3/3.3 as a fallback, sharing D3D11 textures through `WGL_NV_DX_interop2` | only on the core-profile rung, and the WebGL-shaped table binds none | DXGI shared handles: the bridge's D3D11 device (`BridgeD3DDevice`) can open one, and Direct2D can draw a bitmap from it                                                                                     |
| **mock, in-process X server**       | none                                                                                                                                                                           | none                                                                 | none                                                                                                                                                                                                        |

Read from x11-dri 0.9.1's `index.d.ts`, @windowkit/appkit's and
@windowkit/win32's `main` (0.33.0 and 0.0.9), and core's `docs/gl.md` and
`src/wayland/`.

Three things follow.

**WebGPU cannot stand on core's GL.** WebGPU's core feature level needs
compute shaders and storage buffers, and so does its compatibility mode,
which exists to run on OpenGL ES 3.1. Of core's contexts only Mesa's could
reach 3.1 — x11-dri asks for 3.0, EGL may answer with more, and the binding
has none of 3.1's entry points — and the Mac's never can. A WebGPU on these GL
contexts would be a render-only subset, which is what wgpu calls its
"downlevel WebGL 2" profile and no browser exposes as WebGPU.

**Nor does it need to.** A WebGPU device is not a window's: an engine opens
Metal, Vulkan or D3D12 in the process, draws into textures, and is read back.
None of core's addons exposes those APIs, and none has to for this.

**The window is only needed to skip the read**, and each backend that has a
GPU path has a buffer type an engine can share: IOSurface on macOS, dma-buf on
Linux, a DXGI shared handle on Windows. Dawn imports all three as
`SharedTextureMemory`. That is phase 5, and native work, below.

## Engines on npm

| Package                                       | Engine, by                                         | How it installs                                                                                      | Unpacked                                                                                              | Platforms                                                                              | Notes                                                                                                                                                                  |
| --------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`webgpu`** 0.6.2                            | Dawn's own `dawn.node`, published by the Dawn team | one 51.3 MB tarball holding every build; a postinstall that only clears macOS's quarantine attribute | **137.5 MB**: macOS universal 21.9, Linux x64 21.5, arm64 19.6, Windows x64 34.2 with DXC, arm64 40.1 | macOS (Metal), Linux (Vulkan, GL and GLES through EGL), Windows (D3D12, D3D11, Vulkan) | MIT. 47 versions since 2019, 0.6 in August 2026. No canvas or image integration: textures in, buffers out. The `GPU` it makes keeps the process alive while referenced |
| `native-dawn` 0.1.6, with `webgpu-node` 0.2.0 | Dawn, by one maintainer                            | downloads the platform's archive from GitHub releases at install, and installs anyway if it cannot   | 0.13 MB on npm, then the archive                                                                      | macOS, Linux glibc 2.34+, Windows; Node 22+                                            | Its addon links a shared Dawn, so a C++ addon can be handed the `WGPUDevice` a page made: the shape zero-copy needs. A `NativeSurface` swap chain for windows          |
| `@kmamal/gpu` 0.2.1                           | Dawn, by one maintainer                            | downloads a release at install                                                                       | 0.14 MB, then the release                                                                             | as Dawn                                                                                | SDL windows                                                                                                                                                            |
| `wgpu-bun` 29.1.0                             | wgpu-native (and Dawn), through `bun:ffi`          | platform packages as `optionalDependencies`, no install hook                                         | 6.9 MB macOS arm64, 9.3 Linux x64, 9.6 Windows x64                                                    | Bun ≥ 1.4 only                                                                         | API-compatible with `webgpu`. Its README says `webgpu` segfaults Bun                                                                                                   |
| `bun-webgpu` 0.1.7                            | Dawn, through FFI                                  | platform packages                                                                                    | 9.4 MB macOS arm64, 19.7 Linux x64, 21.8 Windows x64                                                  | Bun only                                                                               |                                                                                                                                                                        |

There is no Node-API binding of wgpu-native worth naming (`@torchjsorg/wgpu-native`
is a 0.0.1 preview), which is a pity: wgpu-native is a third of Dawn's size.

For scale, the optional peers this package names already: `x11-dri` 1.1 MB,
`quico` 3 MB, `werift` 29 MB, `ondine` 46 MB, `node-pty` 64 MB. `webgpu`
would be twice the largest, because it does not split by platform; one
platform's build is 12 to 40 MB. Asking the Dawn team to publish per-platform
packages behind `optionalDependencies` is worth an issue.

**The choice is `webgpu`.** It is Dawn, which is Chrome's WebGPU, published by
the people who write it, from npm alone, with nothing fetched at install. The
seam takes any object shaped like `GPU`, so `wgpu-bun` serves Bun through the
same door, and a runtime that grows `navigator.gpu` needs no change here.

## WGSL compilers on npm

| Package                              | What                                                                                                                                                  | Form                             | Size                                  | Notes                                                                                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`naga-wasm`** 30.2.0               | naga, wgpu's translator: WGSL, GLSL and SPIR-V in; WGSL, GLSL, SPIR-V, HLSL and MSL out; validation; reflection                                       | WebAssembly, wasm-bindgen        | 2.05 MB of wasm; 0.8 MB tarball       | MIT or Apache-2.0, no dependencies, `sideEffects: false`, loads on import under Node. One maintainer, following naga's releases (30, September 2026). GLSL out is ES 300/310 or desktop 330 and up |
| `web-naga` 1.0.1                     | naga, translation                                                                                                                                     | wasm                             | 1.5 MB                                | August 2025, older naga                                                                                                                                                                            |
| `naga-wasi-cli` 0.1.0                | the naga CLI                                                                                                                                          | WASI                             | 2.2 MB                                | a command, not a library                                                                                                                                                                           |
| `naga-js-*` 30.0.1                   | naga                                                                                                                                                  | Node-API, one package a platform | 3.4 MB macOS arm64                    | native: a build per platform for what wasm does everywhere                                                                                                                                         |
| `wgsl-wasm-transpiler-bundler` 0.0.1 | naga-based transpiler                                                                                                                                 | wasm                             | 2.5 MB                                | a 2025 experiment                                                                                                                                                                                  |
| `@forgeax/engine-wgpu-wasm`          | wgpu and naga                                                                                                                                         | wasm                             | 6.1 MB                                | an engine's own build                                                                                                                                                                              |
| **`wgsl_reflect`** 1.6.0             | a WGSL parser, reflection (bind groups, struct layouts, entry points), and a CPU interpreter: compute dispatches, a stepping debugger, fragment quads | JavaScript, no dependencies      | 295 KB bundle (3 MB with source maps) | MIT, Brendan Duncan, behind webgpu_inspector. The only one in plain JavaScript                                                                                                                     |
| Tint                                 | Dawn's compiler                                                                                                                                       | —                                | —                                     | **not on npm** as wasm. Babylon.js serves its own Tint build (`twgsl`, SPIR-V to WGSL only) from its CDN. Tint ships inside Dawn                                                                   |
| `@webgpu/glslang`, Slang             | GLSL to SPIR-V, Slang to WGSL                                                                                                                         | wasm                             | 5 MB and up                           | the wrong direction                                                                                                                                                                                |

Tooling around WGSL — `wesl` and `@use-gpu/shader` (linkers), `typegpu`
(JavaScript to WGSL), `miniray` (a minifier), `wgsl-analyzer-web` — compiles
to nothing a GPU runs.

What a compiler would be for, route by route:

1. **Under Dawn or wgpu: nothing.** Tint or naga inside the engine validates
   and translates, and `getCompilationInfo()` answers from it.
2. **WebGPU over core's GL contexts.** `naga-wasm` turns WGSL into GLSL ES
   3.00, or GLSL 4.10 for a Mac, for vertex and fragment stages, with the
   binding remapping that needs. Compute and storage buffers come out as GLSL
   ES 3.10 or 4.30, which no context here runs. So this is the render-only
   subset of the previous section, and the engine around the compiler —
   WebGPU's validation, its resource model on GL, its synchronization — would
   be ours to write: Dawn's GL backend again, in JavaScript. Months, for an
   adapter that tells a page it has WebGPU and then fails its first
   `createComputePipeline`. **Not recommended.**
3. **A software fallback adapter**, `isFallbackAdapter: true`, from
   `wgsl_reflect`'s interpreter: compute only, a tree-walking interpreter, and
   a rasterizer still to write for render pipelines. Fine for a test of a
   tiny shader, orders of magnitude short of a model or a frame. **Recorded,
   not recommended.**
4. **Reflection in the realm**, for `layout: 'auto'`: the engine answers
   `getBindGroupLayout()` on the host, so nothing here needs it.

## Design

The split is WebCrypto's (`prd-webcrypto.md`), and WebGPU names it itself:
its **content timeline** is the page's realm, and its **device and queue
timelines** are the host.

| Where                                                                | What                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The page's realm (`scripts/webgpu.ts`, source text as `webgl.ts` is) | every interface, of the page's own classes; Web IDL's conversions; what the specification keeps on the content timeline (a buffer's `size`, `usage`, `mapState`, a label, whether it is destroyed); a number for every object a page makes; a queue of commands a device, sent once a task; every promise and every error a page holds |
| The host (`scripts/gpu.ts`, beside `gl.ts`)                          | the seam's `GPU`; the numbers to the engine's objects; replaying a queue in order; settling what is asynchronous through `__gpu`; the canvas's frames                                                                                                                                                                                  |
| `src/html/webgpu.ts`                                                 | `HtmlScripts.webgpu`, the seam's type written out structurally, and `dawnWebGPU()`, which loads `webgpu` by a name the compiler cannot see and answers null where it is not installed, as `gpuWebGL()` does with x11-dri                                                                                                               |

**WebGPU fits the bridge better than WebGL does.** A `create…` call returns
its object at once and reports its validation error later, through an error
scope or `uncapturederror`, so creation needs no round trip: the realm hands
back an object with a number, and the host makes the engine's when it
replays. An error scope is popped in the order it was pushed, which the
queue keeps. What WebGPU reads back is asynchronous by design. What a page
reads at once:

| A page reads, synchronously                                 | Where it comes from                                                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigator.gpu.wgslLanguageFeatures`                        | asked of the seam once, as the realm starts                                                                                                    |
| `getPreferredCanvasFormat()`                                | Chrome's answer for the platform, a constant                                                                                                   |
| an adapter's and a device's `features`, `limits` and `info` | sent with the answer to `requestAdapter()` and `requestDevice()`                                                                               |
| every object a `create…` makes, `getBindGroupLayout(i)`     | the realm's number, resolved on the host as it replays                                                                                         |
| `getMappedRange()`                                          | for reading, the bytes arrive with `mapAsync`'s answer; for writing, the realm's buffer goes back with `unmap()`, as `mappedAtCreation`'s does |
| `getCurrentTexture()`                                       | the realm's number for this frame's texture                                                                                                    |

What a page sends that is bytes — `writeBuffer`, `writeTexture`, a mapped
range — crosses as text, as WebGL's does. That is the first cost to measure:
a model's weights are uploaded once, hundreds of megabytes; a particle system
writes megabytes a frame. If base64 is what shows, a string of a byte a
character (as a canvas's text coverage already crosses) is the next step.
Nothing that is not a primitive crosses: the engine's objects are the host's,
and a page that reached one would have the host's `Function`.

**A frame is read back a frame late.** WebGL reads a canvas as the document
paints it (`PageContexts.settle`), synchronously, and a canvas nobody can see
costs no read. WebGPU's read is a `mapAsync`, which a paint cannot wait for.
So the host keeps the texture each task presented, starts its read when a
paint wants the canvas, paints the frame it has, and marks the canvas drawn
when the read lands: still no read of what nobody sees, one frame behind,
which a browser's compositor is too. The pixels are swizzled from BGRA and
made straight, as `straighten` does for WebGL. `toDataURL`, `drawImage` of a
WebGPU canvas and `createImageBitmap` answer from the last frame read; a
canvas that was never read has no synchronous way to be (see "Open
questions").

**What a page's shader can do is bounded.** Dawn validates every call and Tint
rewrites every shader with robustness checks, which is what Chrome does, in
Chrome's GPU process. Here it is the page's process: a shader that never ends
is stopped by the operating system's GPU watchdog, if at all, and the device
is lost; a driver crash takes the process, which in the example browser is a
tab. That is less than WebGL here hands over, since nothing validates that.
`adapter.info` names the GPU, and a host that cares about fingerprinting
narrows what the realm is told.

**Workers have WebGPU too**, dedicated, shared and service. A worker's realm
is a thread and the engine is the page process's, so a worker's GPU goes
across the thread as a relay, the shape WebRTC's data channels and
WebTransport's sessions already take (`ChannelRelay`, `TransportRelay`). An
`OffscreenCanvas` with a `webgpu` context presents through
`canvasRoutes` as a 2d one does.

**Where it belongs.** The facade, the replay and `dawnWebGPU()` are this
package's, as WebGL's are. The engine is an optional peer. A zero-copy path
for a frame is native, per backend, and so core's, windowkit's or x11-dri's,
filed when wanted. A WebGPU surface for an application's own drawing, a
`<glarea>` for WebGPU, is core's question and not this document's; native-dawn's
`NativeSurface` is the shape it would take on X11.

## Phases

0. **Spike.** Run `webgpu` on a Mac, a Linux box and Windows: import time,
   `requestAdapter()`, a compute dispatch, a 512 by 512 render read back, idle
   processor time with a device open, whether the process exits when the `GPU`
   is let go, and whether it loads under Bun. And whether the published build
   has `backend=null`, which `dawn.node`'s README lists: Dawn's backend that
   validates and draws nothing, for a test of the facade with no GPU.
1. **Compute.** `navigator.gpu`, adapters, devices, buffers, shader modules,
   compute pipelines, bind groups, command encoders, the queue, `mapAsync`,
   error scopes, `device.lost`. Tests over a fake `GPU` (`test/fake-webgpu.ts`,
   as `test/fake-webrtc.ts` is for werift) on every runtime, and one over real
   Dawn behind an environment variable. Measured against transformers.js in
   the example browser.
2. **A canvas.** `GPUCanvasContext`, render pipelines, textures, samplers,
   query sets, the read a frame late. `copyExternalImageToTexture` from an
   `ImageBitmap`, a canvas and an `<img>`, whose pixels the host has.
   `importExternalTexture` from a `<video>` waits for a frame source.
3. **Workers and `OffscreenCanvas`.**
4. **The conformance suite.** WebGPU's CTS is WPT's `webgpu/`, and
   `webgpu` already runs it against `dawn.node` (`npm run cts`): run it
   through the facade as well, and what fails there and not straight on Dawn
   is ours.
5. **No read.** Per backend, upstream: macOS first, since appkit already draws
   IOSurfaces; then dma-buf on X11 and Wayland, which needs ntk's 2D context
   to sample a pixmap or an EGL image; then a DXGI handle on Windows. Each
   needs the engine's device in native code, which `webgpu`'s JavaScript does
   not hand over and native-dawn's does.

## Open questions

- **A synchronous read.** `canvasBitmap` is synchronous, and a page that
  draws a WebGPU canvas into a 2d one, or asks for its data URL, before any
  read has landed needs one. Whether `dawn.node` can wait on a map, or the
  host keeps a read always in flight for canvases a page has read before, is
  the spike's to say.
- **Bun.** `wgpu-bun`'s README says `webgpu` segfaults Bun. If so, Bun gets
  `wgpu-bun`, which answers the same API, and both have to pass the same
  tests.
- **Text over the bridge**: base64 or a byte a character, decided by
  measuring phase 1 on a model's upload.
- **What `adapter.info` a page is told**, and whether `webgpu`'s size earns a
  request upstream for per-platform packages.

## Not measured

The sandbox this was written in would not run the downloaded engine or
compiler, so nothing here is a timing: the sizes are the tarballs', and what
each engine contains was read from its binaries (`dawn.node` on macOS links
Metal and IOSurface; on Linux it loads Vulkan and EGL; on Windows it creates
D3D12, D3D11 and Vulkan devices). Phase 0 is the measurement.
