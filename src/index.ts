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

export { Markdown, parse as parseMarkdown } from './markdown/index.js';
export type {
  MarkdownProps,
  MarkdownDocument,
  BlockNode,
  InlineNode,
  ParseOptions,
} from './markdown/index.js';

// Styled text that a document selects across. The selection itself is
// core's (`selectable` on any box, react-x11#291); what is here is the
// element that paints per-run decoration and answers the text accessors,
// and the read-only edit menu a surface offers on right-click.
export {
  RICHTEXT_ELEMENT,
  registerRichText,
  RichTextNode,
  useSelectionMenu,
} from './richtext/index.js';
export type {
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
