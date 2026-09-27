// Run with: npm run examples:json-render   (needs an X server / DISPLAY, or
// REACT_X11_BACKEND=cocoa on a Mac)
//
// json-render (https://json-render.dev) on react-x11, in three tabs that each
// take one step further back from the rendered window:
//
//   Specs        — a hand-written JSON spec, rendered. No model.
//                  (specs.tsx)
//   Composition  — no spec is written: a decision model composes one out of
//                  a fixed set of candidate components. Needs a model.
//                  (composition.tsx)
//   Flights      — candidates built per request from records, so a prompt
//                  the Composition tab has to refuse can work. Needs a model.
//                  (flights.tsx)
//
// The two model-backed tabs run on a keyword stub until given a real
// evaluator, and say so on the tab. The model is Jev (`typesafe-ai/jev`)
// through Vercel AI Gateway, and getting it takes three account-side steps
// that nothing in the model's price warns about — an API key, a payment
// method on file (Jev is free; the Gateway still refuses an account with no
// card, as `customer_verification_required`), and the `typesafe-ai` provider
// allowed for the team. Then:
//
//     export AI_GATEWAY_API_KEY=...
//     npm run examples:json-render-check     # says which step is missing
//     npm run examples:json-render
//
// A session recorded with a key replays without one, through the same core
// code path — the substitution is at the transport (`transport.ts`):
//
//     JEV_RECORD=session.jsonl npm run examples:json-render
//     JEV_REPLAY=session.jsonl npm run examples:json-render
//
// One recording can hold both tabs. Recordings are keyed by what was sent,
// so changing a tab's catalog, candidates or prompts invalidates them.
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../src/tabs/index.js';

import { CompositionTab } from './composition.js';
import { FlightsTab } from './flights.js';
import { SpecsTab } from './specs.js';

function App(): ReactElement {
  return (
    <window
      width={1080}
      height={760}
      title="@react-x11/components — json-render"
    >
      <box
        style={{
          flexDirection: 'column',
          flexGrow: 1,
          backgroundColor: '$background',
        }}
      >
        {/* Hidden panels stay mounted, so a composed result — or a spec
            streaming in — survives a trip to another tab. */}
        <Tabs defaultValue="specs" style={{ flexGrow: 1 }}>
          <TabsList style={{ paddingLeft: 14 }}>
            <TabsTrigger value="specs">Specs</TabsTrigger>
            <TabsTrigger value="composition">Composition</TabsTrigger>
            <TabsTrigger value="flights">Flights</TabsTrigger>
          </TabsList>
          <TabsContent value="specs" style={{ flexGrow: 1 }}>
            <SpecsTab />
          </TabsContent>
          <TabsContent value="composition" style={{ flexGrow: 1 }}>
            <CompositionTab />
          </TabsContent>
          <TabsContent value="flights" style={{ flexGrow: 1 }}>
            <FlightsTab />
          </TabsContent>
        </Tabs>
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
