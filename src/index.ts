// The convenience barrel. `import { Calendar } from '@react-x11/components'`
// and `import { Calendar } from '@react-x11/components/calendar'` are the
// same module either way — with `sideEffects: false` and no side effects at
// this level, a bundler drops the components an app does not name.
//
// This file must never do more than re-export. Anything with a side effect
// here (a registration, a theme install, a feature probe) runs for every
// consumer of the barrel and takes the whole package into their bundle.
export {
  Calendar,
  DatePicker,
  CALENDAR_WIDTH,
  CALENDAR_HEIGHT,
  // The day vocabulary the calendar props speak. An app that renders one
  // almost always does a little of the same arithmetic to decide what to
  // block or what to mark, so it comes out through the barrel too.
  addDays,
  addMonths,
  clampDay,
  dayDate,
  dayParts,
  firstOfMonth,
  formatDay,
  formatDayRange,
  formatMonth,
  localeWeekStart,
  monthGrid,
  monthOf,
  toDay,
  toMonth,
  today,
  weekdayLabels,
} from './calendar/index.js';
export type {
  CalendarProps,
  SingleCalendarProps,
  RangeCalendarProps,
  CalendarDayState,
  CalendarHandle,
  DatePickerProps,
  DateRange,
  DateRangeInput,
  CalendarDay,
  CalendarMonth,
  DayInput,
  DayParts,
  WidgetChangeEvent,
} from './calendar/index.js';

// The colour input, the calendar's closest sibling: the same composed shape,
// the same controlled/uncontrolled grammar, and a value that is a CSS colour
// string for the same reason a day is a `'YYYY-MM-DD'` one.
export {
  ColorPicker,
  ColorField,
  COLOR_PICKER_WIDTH,
  colorPickerHeight,
  // The colour vocabulary the props speak — an app rendering a picker ends up
  // measuring a contrast or formatting a value soon enough.
  channelsFromHsl,
  channelsFromHsv,
  channelsFromRgb,
  contrastGrade,
  contrastRatio,
  formatColor,
  formatOf,
  hslOf,
  hsvToRgb,
  opaqueHex,
  parseColor,
  relativeLuminance,
  rgbToHsv,
  wrapHue,
} from './color-picker/index.js';
export type {
  ColorPickerProps,
  ColorPickerHandle,
  ColorPickerPart,
  ColorFieldProps,
  ColorChangeEvent,
  ColorChannels,
  ColorFormat,
  ColorSwatch,
} from './color-picker/index.js';

// Charts: shadcn-shaped composition over one element that paints with cost
// bounded by pixels, not points — docs/prd-charts.md is the design record.
export {
  ChartContainer,
  LineChart,
  AreaChart,
  BarChart,
  ScatterChart,
  LineSeries,
  AreaSeries,
  BarSeries,
  ScatterSeries,
  XAxis,
  YAxis,
  CartesianGrid,
  ChartTooltip,
  ChartLegend,
  ChartData,
  CHARTPLOT_ELEMENT,
} from './charts/index.js';
export type {
  ChartConfig,
  ChartContainerProps,
  CartesianChartProps,
  SeriesProps,
  XAxisProps,
  YAxisProps,
  CartesianGridProps,
  ChartTooltipProps,
  ChartLegendProps,
  ChartPlotHandle,
  TooltipData,
  ChartDataOptions,
  ChartDataChange,
  ChartDataLike,
  ChartRow,
  ColumnarData,
  ChartSourceData,
  ChartFrameStats,
  ChartPlotProps,
  ChartHit,
  ChartFormatters,
} from './charts/index.js';

export { Code } from './code/index.js';
export type { CodeProps } from './code/index.js';

// A captured terminal session, rendered — `<Terminal>`'s static sibling, the
// way `<Code>` is `<CodeEditor>`'s. `docs/prd-terminal-output.md` is the
// design record.
export { TerminalOutput } from './terminal-output/index.js';
export type {
  TerminalOutputProps,
  TerminalOutputSource,
} from './terminal-output/index.js';

// The parser underneath it, which is useful without a terminal anywhere near:
// colouring a build log, or stripping escapes before a diff.
export {
  ANSI_16,
  AnsiState,
  CastFormatError,
  ansiColor,
  ansiPalette,
  castOutput,
  cssColor,
  parseAnsi,
  parseCast,
  resolveAnsiColors,
  rgbColor,
  stripAnsi,
} from './ansi/index.js';
export type {
  AnsiAttrs,
  AnsiCast,
  AnsiCastEvent,
  AnsiCastHeader,
  AnsiColor,
  AnsiDocument,
  AnsiInput,
  AnsiLine,
  AnsiPalette,
  AnsiPaletteOptions,
  AnsiSpan,
  AnsiUnderline,
  ParseAnsiOptions,
  ResolvedAnsiColors,
} from './ansi/index.js';

// The disclosure tree. Successor to react-x11's own `<Tree>`, which is being
// retired — nothing here imports it. `visibleRows` and `branchEdges` come out
// with it because they are the row model the seams are handed, and an app
// that drives a tree from the outside does the same arithmetic.
// `findItem`, `resolveAccessors` and `ResolvedAccessors` are renamed on the
// way out: on `@react-x11/components/tree` those names are unambiguous, in a
// barrel beside a calendar and a terminal they are not.
export {
  Tree,
  branchEdges,
  findItem as findTreeItem,
  resolveAccessors as resolveTreeAccessors,
  visibleRows,
} from './tree/index.js';
export type {
  ResolvedAccessors as ResolvedTreeAccessors,
  TreeAccessors,
  TreeExpandChange,
  TreeGroup,
  TreeGuideState,
  TreeHandle,
  TreeItem,
  TreeItemId,
  TreeProps,
  TreeRow,
  TreeRowState,
  TreeStyles,
  TreeSubtreeState,
  TreeToggleState,
} from './tree/index.js';

export {
  Flow,
  FlowGraphNode,
  FLOW_ELEMENT,
  // the controlled-state protocol: the pane describes a change, the app
  // applies it, and these are what "applies it" means
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  connectedEdges,
  connectionId,
  resolvePalette,
  useEdgesState,
  useNodesState,
} from './flow/index.js';
export type {
  BackgroundOptions,
  BackgroundVariant,
  Connection,
  ConnectionStart,
  ControlsOptions,
  EdgeAppearance,
  EdgeChange,
  EdgeMarker,
  EdgeMouseHandler,
  EdgeType,
  FitViewOptions,
  FlowEdge,
  FlowInstance,
  FlowNode,
  FlowNodeData,
  FlowNodeType,
  FlowPainter,
  FlowPalette,
  FlowProps,
  FlowRect,
  HandleAnchor,
  HandlePosition,
  HandleSpec,
  HandleType,
  MarkerType,
  MiniMapOptions,
  NodeAppearance,
  NodeBodyRect,
  NodeChange,
  NodeMouseHandler,
  NodePaintContext,
  PanePosition,
  Viewport,
  XYPosition,
} from './flow/index.js';

// The data table. Successor to react-x11's own `<Table>`, which may be
// stripped down or removed — nothing here imports it, and core call sites
// migrate by changing the import (docs/prd-table.md is the design record).
// The row/column model comes out with it; the generic names are qualified on
// the way through the barrel, the way the tree's are.
export {
  Table,
  MIN_COLUMN as TABLE_MIN_COLUMN,
  UNSIZED_MIN as TABLE_UNSIZED_MIN,
  columnValue as tableColumnValue,
  defaultCompare as compareTableValues,
  orderRows as orderTableRows,
  resolveGetId as resolveTableGetId,
  resolveWidths as resolveTableWidths,
} from './table/index.js';
export type {
  ResolvedWidths as ResolvedTableWidths,
  TableCellState,
  TableColumn,
  TableHandle,
  TableHeaderCellState,
  TableMultiSelectProps,
  TableProps,
  TableRow,
  TableRowId,
  TableRowState,
  TableSelectChange,
  TableSingleSelectProps,
  TableSort,
  TableStaticProps,
  TableStyles,
} from './table/index.js';

export { Markdown, parse as parseMarkdown } from './markdown/index.js';
export type {
  MarkdownProps,
  MarkdownDocument,
  BlockNode,
  FenceInfo,
  InlineNode,
  ParseOptions,
} from './markdown/index.js';

// TeX mathematics — KaTeX (an optional dependency) parses, the `formula`
// element lays out and draws, and the glyphs answer the text accessors so
// a selectable document (a `<Markdown>` math fence) reads them.
export {
  Formula,
  FORMULA_ELEMENT,
  FormulaNode,
  useKatex,
} from './formula/index.js';
export type {
  FormulaProps,
  FormulaElementProps,
  FormulaLayout,
  KatexEngine,
  KatexNode,
} from './formula/index.js';

// A static HTML + CSS document, selectable, with seams for resources and
// scripts and real widgets for its form controls. Replaces ntk's deprecated
// `HtmlView` and core's `<html>` element; see docs/prd-html.md. The DOM
// helpers are qualified on the way through the barrel — `createElement` and
// `Element` are names an application already has several of.
export { Html, useHtmlHandle } from './html/index.js';
export {
  appendChild as htmlAppendChild,
  createHtmlElement,
  createText as createHtmlText,
  parseFragment as parseHtmlFragment,
  removeNode as removeHtmlNode,
  replaceNode as replaceHtmlNode,
} from './html/index.js';
export type {
  ControlRect as HtmlControlRect,
  Document as HtmlDocument,
  Element as HtmlElement,
  HtmlHandle,
  HtmlProps,
  ResourceRequest as HtmlResourceRequest,
  ResourceResult as HtmlResourceResult,
  ScriptRequest as HtmlScriptRequest,
} from './html/index.js';

// Styled text that a document selects across. The selection itself is
// core's (`selectable` on any box, react-x11#291); what is here is the
// element that paints per-run decoration and answers the text accessors,
// and the read-only edit menu a surface offers on right-click.
export {
  RICHTEXT_ELEMENT,
  registerRichText,
  RichTextNode,
  useLinkClicks,
  useSelectionMenu,
} from './richtext/index.js';
export type {
  LinkHandlers,
  RichTextProps,
  SelectionMenuHandlers,
  TextRun,
} from './richtext/index.js';

// The look of a block of code, shared by `<Code>` and `<Markdown>`'s fences.
export {
  CODE_LINE_HEIGHT,
  codeBlockLook,
  codeBlockRuns,
  codeBlockStyle,
  codeTextStyle,
  themeTokenResolver,
} from './codeblock/index.js';
export type {
  CodeBlockLook,
  CodeBlockLookOptions,
  CodeBlockRunOptions,
} from './codeblock/index.js';

export {
  codeRuns,
  languageForTag,
  tokenizeText,
} from './code-language/index.js';
export type { CodeRun, CodeRunOptions } from './code-language/index.js';

export {
  CodeEditor,
  CodeEditorNode,
  CODE_EDITOR_ELEMENT,
  // the language seam and what plugs into it
  streamLanguage,
  lineModeLanguage,
  StringStream,
  lezerLanguage,
  textMateLanguage,
  sql,
  shell,
  glsl,
  javascript,
  json,
  // completion sources and their ranking
  keywordCompletionSource,
  wordCompletionSource,
  sqlCompletionSource,
  rankCompletions,
  // token themes
  LIGHT_TOKEN_STYLES,
  DARK_TOKEN_STYLES,
  TOKEN_FALLBACK,
  tokenStyleFor,
  autoTokenStyles,
  isDarkBackground,
} from './code-editor/index.js';
export type {
  CodeEditorComponentProps,
  CodeEditorEvent,
  CodeEditorHandle,
  CodeEditorProps,
  CompletionContext,
  CompletionItem,
  CompletionResult,
  CompletionSource,
  Diagnostic,
  JavascriptOptions,
  Language,
  LanguageData,
  LezerLanguageOptions,
  LezerParserLike,
  LineEdit,
  LineMode,
  Position,
  Selection,
  SqlOptions,
  SqlSchema,
  StreamMode,
  TextMateGrammarLike,
  TextMateLanguageOptions,
  Token,
  Tokenizer,
  TokenizerHost,
  TokenStyle,
  TokenStyles,
  TokenType,
} from './code-editor/index.js';

export {
  Terminal,
  TERMINAL_BACKENDS,
  backendsFor as terminalBackendsFor,
  alacritty,
  urxvt,
  xterm,
} from './terminal/index.js';
export type {
  TerminalBackend,
  TerminalBackendName,
  TerminalColors,
  TerminalHandle,
  TerminalLaunch,
  TerminalProps,
} from './terminal/index.js';

// A run of events. Chakra UI's Timeline with the parts spelled flat, which is
// how `/charts` names a composition too — `Timeline.Root` is `<Timeline>`.
export {
  Timeline,
  TimelineConnector,
  TimelineContent,
  TimelineDescription,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
  TimelineTitle,
} from './timeline/index.js';
export type {
  TimelineConnectorProps,
  TimelineContentProps,
  TimelineDescriptionProps,
  TimelineIndicatorProps,
  TimelineItemProps,
  TimelineProps,
  TimelineSeparatorProps,
  TimelineSize,
  TimelineTitleProps,
  TimelineVariant,
} from './timeline/index.js';

// One visible panel at a time. Chakra UI's Tabs with the parts spelled flat,
// like `<Timeline>` — `Tabs.Root` is `<Tabs>`, `Tabs.Trigger` is
// `<TabsTrigger>`. Successor to react-x11's own items-array `<Tabs>`.
export {
  Tabs,
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from './tabs/index.js';
export type {
  TabsContentProps,
  TabsIndicatorProps,
  TabsListProps,
  TabsProps,
  TabsSize,
  TabsTriggerProps,
  TabsValueChange,
  TabsVariant,
} from './tabs/index.js';

export {
  TrayHost,
  TrayManager,
  BalloonAssembler,
  BalloonNotifier,
  ORIENTATION_HORIZONTAL,
  ORIENTATION_VERTICAL,
  SYSTEM_TRAY_BEGIN_MESSAGE,
  SYSTEM_TRAY_CANCEL_MESSAGE,
  SYSTEM_TRAY_REQUEST_DOCK,
  argbVisualOf,
  orientationValue,
  selectionNameFor,
} from './tray-host/index.js';
export type {
  TrayApp,
  TrayConflict,
  TrayHostHandle,
  TrayHostProps,
  TrayIcon,
  TrayManagerHandlers,
  TrayManagerStartOptions,
  TrayMessage,
  TrayOrientation,
  TrayStatus,
} from './tray-host/index.js';

export {
  MediaPlayer,
  MEDIA_BACKENDS,
  mediaBackendsFor,
  mpv,
  vlc,
} from './media-player/index.js';
export type {
  MediaBackend,
  MediaBackendName,
  MediaLaunch,
  MediaPlayerHandle,
  MediaPlayerProps,
  MediaProgress,
  PlayerControl,
  PlayerEvents,
} from './media-player/index.js';

// The lifecycle both XEmbed wrappers are built on. Public because
// `ProcessHost` is the seam for running the child somewhere else, and because
// a third `-into WID` wrapper should not have to reimplement it.
export {
  BackendUnavailableError,
  IpcConnectError,
  connectWhenReady,
  nodeProcessHost,
  resolveBackend,
  useEmbeddedClient,
} from './embed/index.js';
export type {
  EmbedStatus,
  EmbeddedClient,
  ExitInfo,
  IpcSocket,
  LaunchPlan,
  PlanContext,
  PlanFactory,
  ProcessHost,
  ScratchSocket,
  SpawnOptions,
  SpawnedProcess,
  UseEmbeddedClientOptions,
} from './embed/index.js';

export {
  DesktopCalendar,
  IcalUnavailableError,
  byDay,
  parseKeyFile,
  useDesktopCalendarEvents,
} from './desktop-calendar/index.js';
export type {
  DesktopCalendarChange,
  DesktopCalendarError,
  DesktopCalendarInfo,
  DesktopCalendarStatus,
  DesktopEvent,
  EventsResult,
  UseDesktopCalendarEventsOptions,
  UseDesktopCalendarEventsResult,
} from './desktop-calendar/index.js';

// The three-fiber-shaped scene graph. The scene classes come out too —
// `<primitive object>` takes one, and ported code writes `new Vector3()` —
// but the renderers stay on the subpath: a `<Canvas>` picks its own.
export {
  Canvas,
  useFrame,
  useThree,
  extend,
  Color,
  Euler,
  Vector3,
  AmbientLight,
  Camera,
  DirectionalLight,
  Group,
  InstancedMesh,
  Light,
  Line,
  LineLoop,
  LineSegments,
  Mesh,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PointLight,
  Points,
  Scene,
  SpotLight,
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  LineBasicMaterial,
  Material,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  MeshStandardMaterial,
  PointsMaterial,
  RawShaderMaterial,
  ShaderMaterial,
  BloomPass,
  EffectComposer,
  FxaaPass,
  Pass,
  ShaderPass,
  VignettePass,
} from './three/index.js';
export type {
  CanvasProps,
  FrameCallback,
  GeometryData,
  InstanceSpec,
  MaterialSide,
  RayHit,
  RootState,
  TextureImage,
  ThreeElements,
  ThreeEvent,
  ThreeSize,
  ThreeViewport,
} from './three/index.js';
export {
  QmlView,
  QmlNode,
  Qt,
  parseQml,
  instantiateDocument,
  registerQmlModule,
  registerReactComponent,
  registerControls,
  createFileResolver,
  geometryStyle,
  captureNode,
  qmlColor,
} from './qml/index.js';
export type {
  QmlViewProps,
  QmlViewHandle,
  QmlDocument,
  QmlTypeDef,
  QmlFacade,
  QmlInstance,
  QmlResolver,
} from './qml/index.js';
