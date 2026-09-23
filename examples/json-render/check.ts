// Run with: npm run examples:json-render-check   (no display needed)
//
// The pre-flight for the json-render example's model-backed tabs.
//
// `experimental_createEvaluator` throws `Evaluation request failed (HTTP nnn).`
// and drops the response body on the floor, so a rejected request tells you
// nothing about why. This asks the same three questions by hand and prints
// everything the Gateway says back.
//
//   1. Is the key valid at all?          GET  /v1/models
//   2. Can this team see typesafe-ai?    (the same listing, filtered)
//   3. What does the evaluation endpoint say?  POST /v4/ai/evaluation-model
//
// The key is never printed — only whether it is set, how long it is, and the
// prefix before the first underscore, which is enough to spot a truncated
// paste or a key from the wrong place.

const GATEWAY = 'https://ai-gateway.vercel.sh';
const MODEL = process.env.JEV_MODEL ?? 'typesafe-ai/jev';

// The playground uses its own variable; the reusable evaluator takes whatever
// key you hand it. Accept both here so a key set by either set of docs works.
const fromMain = process.env.AI_GATEWAY_API_KEY;
const fromJev = process.env.JEV_AI_GATEWAY_API_KEY;
const key = fromMain ?? fromJev;

function heading(s: string): void {
  console.log(`\n\x1b[1m${s}\x1b[0m`);
}

async function body(res: Response): Promise<string> {
  const text = await res.text().catch(() => '<unreadable>');
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

heading('1. the key');
console.log(`  AI_GATEWAY_API_KEY      ${fromMain ? 'set' : 'not set'}`);
console.log(`  JEV_AI_GATEWAY_API_KEY  ${fromJev ? 'set' : 'not set'}`);
if (!key) {
  console.log('\n  Nothing to test. Set AI_GATEWAY_API_KEY and run again.');
  process.exit(1);
}
const trimmed = key.trim();
console.log(`  length                  ${trimmed.length}`);
console.log(`  prefix                  ${trimmed.split('_')[0]}_…`);
if (trimmed !== key) {
  console.log('  NOTE: the value has leading or trailing whitespace.');
}

const auth = { Authorization: `Bearer ${trimmed}` };

heading('2. GET /v1/models — is the key accepted, and is the model visible?');
try {
  const res = await fetch(`${GATEWAY}/v1/models`, {
    headers: auth,
    cache: 'no-store',
  });
  console.log(`  HTTP ${res.status} ${res.statusText}`);
  if (!res.ok) {
    console.log(await body(res));
  } else {
    const json = (await res.json()) as { data?: { id?: string }[] };
    const ids = (json.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    const typesafe = ids.filter((id) => id.startsWith('typesafe-ai/'));
    console.log(`  ${ids.length} models visible to this key`);
    console.log(
      `  typesafe-ai/*           ${typesafe.length ? typesafe.join(', ') : 'NONE — the provider is not enabled, or is filtered out by a provider/model allowlist'}`,
    );
    console.log(
      `  ${MODEL}      ${ids.includes(MODEL) ? 'present' : 'NOT in the listing'}`,
    );
  }
} catch (err) {
  console.log(`  request threw: ${err instanceof Error ? err.message : err}`);
}

heading('3. POST /v4/ai/evaluation-model — the call the evaluator makes');
// The smallest well-formed evaluation: one choice question, two criteria.
const payload = {
  state: { user_request: 'Show the revenue panel' },
  questions: {
    root: {
      type: 'choice',
      instructions: 'Choose the outermost element for user_request.',
      criteria: {
        panel: 'A revenue dashboard panel',
        unavailable: 'The requested content or capability is unavailable.',
      },
    },
  },
};

try {
  const res = await fetch(`${GATEWAY}/v4/ai/evaluation-model`, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': 'application/json',
      'ai-gateway-protocol-version': '0.0.1',
      'ai-gateway-auth-method': 'api-key',
      'ai-evaluation-model-specification-version': '4',
      'ai-model-id': MODEL,
    },
    body: JSON.stringify(payload),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  console.log(`  HTTP ${res.status} ${res.statusText}`);
  for (const h of ['x-vercel-id', 'x-ratelimit-remaining', 'retry-after']) {
    const v = res.headers.get(h);
    if (v) console.log(`  ${h}: ${v}`);
  }
  const text = await body(res);
  console.log(text);

  if (!res.ok) {
    heading('what that means');
    // The Gateway's `error.type` is more specific than the status — a team
    // with no card on file and a team out of credit can answer alike.
    const byType: Record<string, string> = {
      customer_verification_required:
        "The account has no payment method on file. AI Gateway declines every request until one is added, whatever the model costs — Jev being free does not exempt it, because the card is the anti-abuse gate, not the bill. Adding one also releases the team's free credits.",
      authentication_error:
        'The key was rejected. Wrong key, revoked, or from a different team.',
      rate_limit_exceeded: 'Rate limited. Retry after the delay above.',
    };
    const type = /"type"\s*:\s*"([^"]+)"/.exec(text)?.[1];
    const byStatus: Record<number, string> = {
      400: 'The request shape is wrong — most likely this core version and the Gateway disagree about the evaluation protocol.',
      401: 'The key was rejected. Wrong key, revoked, or from a different team.',
      402: 'Billing: no payment method, no credits, or spend is capped.',
      403: 'The key may be fine but this team may not use typesafe-ai. Check AI Gateway → Provider Allowlist, and the Model Allowlist too.',
      404: 'The endpoint or the model id does not exist for this team. Check step 2 for whether typesafe-ai/jev is listed.',
      429: 'Rate limited. Retry after the delay above.',
    };
    console.log(
      `  ${
        (type && byType[type]) ??
        byStatus[res.status] ??
        'Unmapped — the body above is the authority.'
      }`,
    );
    if (type) console.log(`  (error.type: ${type})`);
  }
} catch (err) {
  console.log(`  request threw: ${err instanceof Error ? err.message : err}`);
}

console.log('');
