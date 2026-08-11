// The convenience barrel. `import { Sparkline } from '@react-x11/components'`
// and `import { Sparkline } from '@react-x11/components/sparkline'` are the
// same module either way — with `sideEffects: false` and no side effects at
// this level, a bundler drops the components an app does not name.
//
// This file must never do more than re-export. Anything with a side effect
// here (a registration, a theme install, a feature probe) runs for every
// consumer of the barrel and takes the whole package into their bundle.
export { Sparkline, SPARKLINE_ELEMENT } from './sparkline/index.js';
export type { SparklineProps } from './sparkline/index.js';

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

export {
  RICHTEXT_ELEMENT,
  registerRichText,
  RichTextNode,
  TextSelection,
  useSelectionGestures,
} from './richtext/index.js';
export type {
  RichTextProps,
  TextRun,
  SelectableBlock,
  SelectionRegistry,
  SelectionGestureHandlers,
  SelectionGestureOptions,
} from './richtext/index.js';

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
