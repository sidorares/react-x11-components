// What the two model-backed tabs share: driving `experimental_composeSpec`,
// showing its trace, and telling a reader how to put a real model behind it.
// The tabs differ in where their candidates come from — a fixed list in
// "Composition", rows from a search in "Flights" — so that is the one thing
// `useComposer` takes as a function.
import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { experimental_composeSpec } from '@json-render/core';
import type {
  Experimental_CompositionCandidate,
  Experimental_CompositionCatalog,
  Experimental_CompositionStep,
  Spec,
  StateStore,
} from '@json-render/core';
import {
  ActionProvider,
  Renderer,
  StateProvider,
  ValidationProvider,
  VisibilityProvider,
} from '@json-render/react';
import type {
  ActionProviderProps,
  ComponentRegistry,
} from '@json-render/react';

import { chooseEvaluator } from './transport.js';

// --- the composer ----------------------------------------------------------

export interface Run<M = undefined> {
  spec: Spec | null;
  steps: Experimental_CompositionStep[];
  busy: boolean;
  /** 'finish' | 'limit' | 'unavailable', or an error's message. */
  stopReason: string | null;
  elapsedMs: number;
  /** Whatever the tab worked out before composing — see `prepare`. */
  meta: M | null;
}

export interface ComposerOptions<M> {
  catalog: Experimental_CompositionCatalog;
  initialState: Record<string, unknown>;
  /** The budgets are the safety rail, not a performance knob: they bound how
   *  much one request can cost before it gives up. */
  limits: { maxSteps: number; maxElements: number; maxDepth: number };
  /**
   * Guidance appended to the composer's own questions. `next` is the one that
   * matters for selection: core sends it as the "shared guidance" that the
   * membership question — "include only requested content or conventional
   * essentials described by shared guidance" — defers to. Part of every
   * request, so changing it invalidates a recording.
   */
  instructions?: { root?: string; next?: string; parent?: string };
  /** Runs before each composition: the candidates to offer for this prompt,
   *  plus anything the tab wants to show about how it got them. */
  prepare: (prompt: string) => {
    candidates: readonly Experimental_CompositionCandidate[];
    meta: M;
  };
}

export function useComposer<M = undefined>(
  opts: ComposerOptions<M>,
): { run: Run<M>; compose: (prompt: string) => void } {
  const idle: Run<M> = {
    spec: null,
    steps: [],
    busy: false,
    stopReason: null,
    elapsedMs: 0,
    meta: null,
  };
  const [run, setRun] = useState<Run<M>>(idle);
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);

  const compose = (prompt: string): void => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;

    const { candidates, meta } = opts.prepare(prompt);
    setRun({ ...idle, busy: true, meta });

    void (async () => {
      const steps: Experimental_CompositionStep[] = [];
      try {
        for await (const event of experimental_composeSpec({
          catalog: opts.catalog,
          candidates,
          prompt,
          initialState: opts.initialState,
          evaluate: chooseEvaluator().evaluate,
          ...opts.limits,
          instructions: opts.instructions,
          signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(55_000)]),
        })) {
          if (ctl.signal.aborted) return;
          if (event.type === 'step') {
            steps.push(event.step);
            // Snapshots, not patches: each one is a whole spec.
            setRun((r) => ({ ...r, spec: event.spec, steps: [...steps] }));
          } else {
            setRun((r) => ({
              ...r,
              spec: event.spec,
              steps: event.steps,
              busy: false,
              stopReason: event.stopReason,
              elapsedMs: event.elapsedMs,
            }));
          }
        }
      } catch (err) {
        if (ctl.signal.aborted) return;
        // The window has one narrow line for this; the terminal gets the
        // stack, and the transport has already printed any HTTP body.
        console.error('[jev] composition failed:', err);
        // An error keeps whatever snapshot arrived, labelled incomplete —
        // which is what the docs ask for.
        setRun((r) => ({
          ...r,
          busy: false,
          stopReason: err instanceof Error ? err.message : String(err),
        }));
      }
    })();
  };

  return { run, compose };
}

// --- the pieces of a tab ---------------------------------------------------

export function Line(props: {
  children?: ReactNode;
  muted?: boolean;
}): ReactElement {
  return (
    <text
      style={{
        fontSize: 10,
        color: props.muted ? '$textMuted' : '$text',
        fontFamily: '$monoFamily',
      }}
    >
      {props.children}
    </text>
  );
}

export function Heading(props: { children?: ReactNode }): ReactElement {
  return (
    <text style={{ fontSize: 11, color: '$textMuted' }}>{props.children}</text>
  );
}

export function Trace<M>(props: { run: Run<M> }): ReactElement {
  const { run } = props;
  return (
    <box style={{ flexDirection: 'column', gap: 3 }}>
      {run.steps.map((s) => (
        <Line key={s.index} muted>
          {`${s.index}. ${s.choice}` +
            (s.confidence === null ? '' : `  p=${s.confidence.toFixed(2)}`) +
            `  ${Math.round(s.elapsedMs)}ms` +
            (s.inputTokens === null ? '' : `  ${s.inputTokens} tok`)}
        </Line>
      ))}
      {run.busy ? <Line muted>…evaluating</Line> : null}
      {run.stopReason ? (
        <Line>{`stop: ${run.stopReason}  (${Math.round(run.elapsedMs)}ms)`}</Line>
      ) : null}
    </box>
  );
}

/** A column of clickable prompts. A `<box>` rather than a `<Button>`: these
 *  labels are sentences, and a button sizes itself to one line of label. */
export function PromptList(props: {
  prompts: readonly string[];
  busy: boolean;
  onPick: (prompt: string) => void;
}): ReactElement {
  return (
    <box style={{ flexDirection: 'column', gap: 8 }}>
      {props.prompts.map((p) => (
        <box
          key={p}
          onClick={() => {
            if (!props.busy) props.onPick(p);
          }}
          style={{
            padding: 9,
            borderRadius: 4,
            backgroundColor: '$surface',
            borderWidth: 1,
            borderColor: '$border',
          }}
        >
          <text
            style={{
              fontSize: 12,
              color: props.busy ? '$textMuted' : '$text',
            }}
          >
            {p}
          </text>
        </box>
      ))}
    </box>
  );
}

/** The right-hand pane: the composed spec, rendered, or a placeholder. */
export function Preview<M>(props: {
  run: Run<M>;
  store: StateStore;
  registry: ComponentRegistry;
  handlers: ActionProviderProps['handlers'];
  idle: string;
  empty: string;
}): ReactElement {
  const { run } = props;
  return (
    <box
      style={{
        flexDirection: 'column',
        flexGrow: 1,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: '$border',
        overflow: 'scroll',
      }}
    >
      {run.spec ? (
        <StateProvider store={props.store}>
          <VisibilityProvider>
            <ValidationProvider>
              <ActionProvider handlers={props.handlers}>
                {/* Incoming snapshots should not race the user's own edits,
                    so the preview is inert while composing. */}
                <Renderer
                  spec={run.spec}
                  registry={props.registry}
                  loading={run.busy}
                />
              </ActionProvider>
            </ValidationProvider>
          </VisibilityProvider>
        </StateProvider>
      ) : (
        <box style={{ padding: 14 }}>
          <text style={{ fontSize: 12, color: '$textMuted' }}>
            {run.busy
              ? 'Composing…'
              : run.stopReason
                ? props.empty
                : props.idle}
          </text>
        </box>
      )}
    </box>
  );
}

// --- putting a model behind it ---------------------------------------------
//
// Every step below was learned the hard way, and none of them is visible from
// the model's price: Jev is free, and the Gateway still refuses every request
// from an account with no card on file.

const SETUP: { step: string; detail?: string }[] = [
  {
    step: 'Create an AI Gateway API key',
    detail: 'vercel.com → AI Gateway → API Keys',
  },
  {
    step: 'Add a payment method to the Vercel account',
    detail:
      'required even though Jev is free — without one every request answers customer_verification_required',
  },
  {
    step: 'Allow the typesafe-ai provider',
    detail: 'AI Gateway → Provider Allowlist (check the Model Allowlist too)',
  },
  {
    step: 'Export the key and check it',
    detail:
      'export AI_GATEWAY_API_KEY=…   then   npm run examples:json-render-check',
  },
];

/**
 * What evaluator this tab is running on, and — when it is the offline stub —
 * how to get a real one. The stub is a keyword matcher, so a reader who never
 * reads this banner will think Jev cannot tell "cheapest" from "all"; saying
 * so on the tab is the fix.
 */
export function ModelSetup(): ReactElement {
  const { kind, label } = chooseEvaluator();

  if (kind !== 'stub') {
    return (
      <box
        style={{
          flexDirection: 'column',
          gap: 3,
          padding: 8,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: kind === 'jev' ? '$success' : '$border',
        }}
      >
        <Line>{`model: ${label}`}</Line>
        {kind === 'jev' ? (
          <Line muted>
            record with JEV_RECORD=session.jsonl to replay without a key
          </Line>
        ) : null}
      </box>
    );
  }

  return (
    <box
      style={{
        flexDirection: 'column',
        gap: 6,
        padding: 10,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: '$warning',
      }}
    >
      <text style={{ fontSize: 12, color: '$text' }}>
        This tab needs a decision model — running on a keyword stub
      </text>
      <text style={{ fontSize: 10, color: '$textMuted' }}>
        The stub matches words, it does not judge: "cheapest direct" and "all
        flights" look the same to it. For real selection use Jev
        (typesafe-ai/jev) through Vercel AI Gateway, or any evaluator — the
        transport is one function.
      </text>
      {SETUP.map((s, i) => (
        <box key={s.step} style={{ flexDirection: 'column', gap: 1 }}>
          <text style={{ fontSize: 11, color: '$text' }}>
            {`${i + 1}. ${s.step}`}
          </text>
          {s.detail ? <Line muted>{`   ${s.detail}`}</Line> : null}
        </box>
      ))}
      <text style={{ fontSize: 11, color: '$text' }}>
        No key? Replay someone else's session
      </text>
      <Line muted>
        {'   JEV_RECORD=session.jsonl npm run examples:json-render'}
      </Line>
      <Line muted>
        {'   JEV_REPLAY=session.jsonl npm run examples:json-render'}
      </Line>
    </box>
  );
}
