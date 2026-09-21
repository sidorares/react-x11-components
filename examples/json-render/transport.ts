// The evaluator behind the "Composition" and "Flights" tabs: which one to
// use, and how to record and replay what it says. One per process, so both
// tabs share it — a recording made in one tab replays in either.
//
//   AI_GATEWAY_API_KEY set           -> Jev over the Gateway
//     + JEV_RECORD=file              -> …and every exchange written to file
//   JEV_REPLAY=file                  -> that file played back, no network
//   neither                          -> a keyword stub, no network
//
// `Experimental_CompositionEvaluator` is a plain async function: it is handed
// a `state` — the user's request, the candidate descriptions, any `context`
// the app shared — and a set of multiple-choice `questions`, and it must
// answer each with one of the criteria keys it was offered. That is the
// entire contract, which is why a model swap, a router, a recording or the
// stub below all fit in the same slot.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { experimental_createEvaluator } from '@json-render/core';
import type { Experimental_CompositionEvaluator } from '@json-render/core';

// --- the keyword stub ------------------------------------------------------
//
// Emphatically **not** a model: it scores word overlap between the request
// and each candidate's description, includes a candidate when anything
// matches, and answers `unavailable` for the root when nothing does. Enough
// to drive the real composer end to end — both batched evaluations, the
// `resource` exclusions, validation, the streamed snapshots — while the
// prompt still visibly changes the result. It is a harness, not a
// substitute; Jev reads the request.

const STOPWORDS = new Set([
  'the',
  'and',
  'with',
  'for',
  'this',
  'that',
  'show',
  'just',
  'give',
  'make',
  'from',
  'into',
  'their',
  'there',
  'than',
  'then',
  'them',
  'these',
  'those',
  'some',
  'only',
  'also',
  'here',
  'about',
]);

const words = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );

const overlap = (a: Set<string>, b: Set<string>): number => {
  let n = 0;
  for (const w of b) if (a.has(w)) n++;
  return n;
};

export const keywordStub: Experimental_CompositionEvaluator = async ({
  state,
  questions,
}) => {
  await new Promise((r) => setTimeout(r, 350)); // so the stream is watchable
  const asked = words(String(state.user_request ?? ''));
  const answers: Record<string, { choice: string; confidence: number }> = {};

  for (const [name, q] of Object.entries(questions)) {
    const keys = Object.keys(q.criteria);
    // Sibling order: every element claims position 1, so equal positions
    // fall back to catalog order.
    if (keys.every((k) => /^\d+$/.test(k))) {
      answers[name] = { choice: keys[0]!, confidence: 1 };
      continue;
    }
    const scored = keys
      .filter((k) => k !== 'omit' && k !== 'unavailable')
      .map((k) => ({ k, score: overlap(asked, words(q.criteria[k]!)) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    const fallback = keys.includes('omit') ? 'omit' : 'unavailable';
    answers[name] = {
      choice: best && best.score > 0 ? best.k : fallback,
      confidence: best ? Math.min(1, best.score / 3) : 0,
    };
  }
  return { answers };
};

// --- record and replay -----------------------------------------------------
//
// Replay substitutes at the *transport* — `experimental_createEvaluator`'s
// `fetch` option — not at the evaluator, so everything above the socket is
// the real thing: core's response schema, the choice validation, the two
// batched evaluations, the budgets. The only fake is the wire.
//
// Exchanges are keyed by a hash of the URL and request body, so prompts
// replay in any order and an unrecorded one fails loudly rather than
// silently returning somebody else's answer. The request body is built by
// core from the catalog, the candidates and the prompt, so changing any of
// those invalidates a recording — by design.
//
// **Only the URL, the request body, the status and the response body are
// written.** Request headers are never recorded: that is where the bearer
// token is.

interface Exchange {
  key: string;
  url: string;
  request: string;
  status: number;
  response: string;
}

const exchangeKey = (url: string, requestBody: string): string =>
  createHash('sha256')
    .update(`${url}\n${requestBody}`)
    .digest('hex')
    .slice(0, 16);

const readBody = (init?: RequestInit): string =>
  typeof init?.body === 'string' ? init.body : '';

/**
 * Real network, with a failing body printed — core throws
 * `Evaluation request failed (HTTP nnn).` and discards the body that says
 * why — and every exchange optionally written to `recordPath`.
 */
function tapFetch(recordPath: string | undefined): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const res = await globalThis.fetch(input, init);
    // A body is a one-shot stream, so read a clone and leave the original
    // for core.
    const text = await res
      .clone()
      .text()
      .catch(() => '<unreadable>');

    if (!res.ok) {
      console.error(
        `\n[jev] ${res.status} ${res.statusText} from ${url}\n${text}\n`,
      );
    }
    if (recordPath) {
      const line: Exchange = {
        key: exchangeKey(url, readBody(init)),
        url,
        request: readBody(init),
        status: res.status,
        response: text,
      };
      appendFileSync(recordPath, `${JSON.stringify(line)}\n`);
      console.error(
        `[jev] recorded ${line.key} (HTTP ${res.status}) -> ${recordPath}`,
      );
    }
    return res;
  };
}

/** No network at all: a recorded exchange, returned as a real `Response` so
 *  core cannot tell the difference. */
function replayFetch(path: string): typeof globalThis.fetch {
  const byKey = new Map<string, Exchange>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const ex = JSON.parse(line) as Exchange;
    byKey.set(ex.key, ex);
  }
  console.error(`[jev] replaying ${byKey.size} exchanges from ${path}`);

  return async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const key = exchangeKey(url, readBody(init));
    const ex = byKey.get(key);
    if (!ex) {
      // Loud, because the alternative is a plausible answer to a question
      // nobody asked.
      throw new Error(
        `No recorded exchange for ${key}. Record this prompt with JEV_RECORD first.`,
      );
    }
    return new Response(ex.response, {
      status: ex.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// --- the choice ------------------------------------------------------------

export type EvaluatorKind = 'jev' | 'replay' | 'stub';

let chosen:
  | {
      evaluate: Experimental_CompositionEvaluator;
      label: string;
      kind: EvaluatorKind;
    }
  | undefined;

/** Decided once, from the environment, on first use. */
export function chooseEvaluator(): {
  evaluate: Experimental_CompositionEvaluator;
  label: string;
  kind: EvaluatorKind;
} {
  if (chosen) return chosen;
  const key = process.env.AI_GATEWAY_API_KEY;
  const recordPath = process.env.JEV_RECORD;
  const replayPath = process.env.JEV_REPLAY;

  if (!key && !replayPath) {
    chosen = {
      evaluate: keywordStub,
      label: 'keyword stub (no AI_GATEWAY_API_KEY)',
      kind: 'stub',
    };
    return chosen;
  }

  const evaluate = experimental_createEvaluator({
    model: 'typesafe-ai/jev',
    // Replay never reaches the network, but core insists on a non-empty key
    // before it will build an evaluator.
    apiKey: key ?? 'replay',
    timeoutMs: 20_000,
    fetch: replayPath ? replayFetch(replayPath) : tapFetch(recordPath),
  });

  chosen = replayPath
    ? { evaluate, label: `replaying ${replayPath}`, kind: 'replay' }
    : {
        evaluate,
        label: `typesafe-ai/jev via AI Gateway${recordPath ? `, recording to ${recordPath}` : ''}`,
        kind: 'jev',
      };
  return chosen;
}
