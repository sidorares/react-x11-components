// The "Flights" tab of `json-render.tsx`: what it takes for "Book me a flight
// to Melbourne" to work.
//
// In the "Composition" tab Jev answers that prompt `unavailable` — correctly,
// since no candidate there has anything to do with flights. The fix is not a
// better prompt or a bigger model; it is three things the app does *around*
// the model, and this file is those three things.
//
// 1. **Something other than Jev reads "Melbourne".** Jev is a decision
//    model: it picks among candidates, and it cannot copy a word out of the
//    request into a prop. So the entity the search needs — the destination —
//    has to be extracted before composition. Here that is `parseTrip`, a few
//    lines of plain code over a list of known cities. In a real app it is a
//    form, or a structured-output call to a generative model, or a search
//    box; it is never the composer.
//
// 2. **Candidates are built from records, per request.** A static catalog of
//    "a flight card" is useless — every flight card needs a carrier, a time
//    and a price, and Jev cannot invent one. So the app queries its own data
//    for the destination and turns each row into a fully configured
//    candidate. The json-render docs say it directly: "construct candidates
//    from the current records for each request."
//
//    What Jev then does is the part it is good at: *judgement over the
//    results.* Each candidate's description carries the facts that matter —
//    departure, stops, price — because the description is the only thing the
//    evaluator ever sees. "Cheapest direct" and "morning flights" are Jev
//    choosing which rows to keep and in what order; no code here filters.
//
// 3. **Booking is an action, and the composer never runs it.** Each flight
//    carries `on: { press: bookFlight({ flightId }) }`. The composer copies
//    that binding into the spec; the press calls *this file's* handler, which
//    is where authorization and validation belong. A generated UI that can
//    book is one whose handlers were already safe to call with anything.
//
// The boundary moved; it did not vanish. "Book me a hotel in Paris" is still
// `unavailable`, for the same reason the flight used to be.
import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { createStateStore, defineCatalog } from '@json-render/core';
import type { Experimental_CompositionCandidate } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { defineRegistry, useStateStore } from '@json-render/react';
import type { SetState } from '@json-render/react';
import { Button } from 'react-x11';

import {
  Heading,
  Line,
  ModelSetup,
  PromptList,
  Preview,
  Trace,
  useComposer,
} from './compose.js';

// --- the data --------------------------------------------------------------
//
// Stands in for an airline API. The rows are what a real search returns;
// nothing below is invented by the model.

const HOME = 'Sydney';

interface Flight {
  id: string;
  to: string;
  carrier: string;
  number: string;
  depart: string;
  arrive: string;
  stops: number;
  price: number;
}

const FLIGHTS: Flight[] = [
  {
    id: 'qf403',
    to: 'Melbourne',
    carrier: 'Qantas',
    number: 'QF403',
    depart: '06:00',
    arrive: '07:35',
    stops: 0,
    price: 219,
  },
  {
    id: 'va801',
    to: 'Melbourne',
    carrier: 'Virgin Australia',
    number: 'VA801',
    depart: '07:30',
    arrive: '09:05',
    stops: 0,
    price: 189,
  },
  {
    id: 'jq505',
    to: 'Melbourne',
    carrier: 'Jetstar',
    number: 'JQ505',
    depart: '11:10',
    arrive: '12:45',
    stops: 0,
    price: 99,
  },
  {
    id: 'jq9',
    to: 'Melbourne',
    carrier: 'Jetstar',
    number: 'JQ9',
    depart: '13:40',
    arrive: '17:50',
    stops: 1,
    price: 79,
  },
  {
    id: 'qf451',
    to: 'Melbourne',
    carrier: 'Qantas',
    number: 'QF451',
    depart: '18:00',
    arrive: '19:35',
    stops: 0,
    price: 249,
  },
  {
    id: 'qf512',
    to: 'Brisbane',
    carrier: 'Qantas',
    number: 'QF512',
    depart: '06:45',
    arrive: '08:15',
    stops: 0,
    price: 229,
  },
  {
    id: 'va915',
    to: 'Brisbane',
    carrier: 'Virgin Australia',
    number: 'VA915',
    depart: '08:20',
    arrive: '09:50',
    stops: 0,
    price: 179,
  },
  {
    id: 'jq810',
    to: 'Brisbane',
    carrier: 'Jetstar',
    number: 'JQ810',
    depart: '15:30',
    arrive: '17:00',
    stops: 0,
    price: 109,
  },
];

const CITIES = [...new Set(FLIGHTS.map((f) => f.to))];

// --- 1. extraction: not Jev's job ------------------------------------------
//
// The only thing the search needs from the sentence is the destination. A
// substring match over the cities we fly to is crude, and deliberately so:
// the point is *where* this happens — before composition, in code the app
// owns — not how clever it is.

function parseTrip(prompt: string): { to: string | null } {
  const lower = prompt.toLowerCase();
  return { to: CITIES.find((c) => lower.includes(c.toLowerCase())) ?? null };
}

// --- the catalog -----------------------------------------------------------

const catalog = defineCatalog(schema, {
  components: {
    Trip: {
      props: z.object({ title: z.string() }),
      slots: ['default'],
      description: 'The flight search results screen.',
    },
    Summary: {
      props: z.object({ text: z.string() }),
      description: 'A muted line summarising the search.',
    },
    Flight: {
      props: z.object({
        id: z.string(),
        carrier: z.string(),
        number: z.string(),
        depart: z.string(),
        arrive: z.string(),
        stops: z.number(),
        price: z.number(),
      }),
      events: ['press'],
      description: 'One bookable flight, with a Book button.',
    },
  },
  actions: {
    bookFlight: {
      params: z.object({ flightId: z.string() }),
      description: 'Book the given flight for the signed-in traveller.',
    },
  },
});

// --- 2. candidates from records --------------------------------------------
//
// Rebuilt for every request. The description is written for the evaluator:
// it is the only view of a flight Jev gets, so everything a request might
// select on — the time of day, the stops, the price — is spelled out in
// words, not left in props it will never see.

const partOfDay = (hhmm: string): string => {
  const h = Number(hhmm.slice(0, 2));
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
};

function buildCandidates(
  to: string | null,
): Experimental_CompositionCandidate[] {
  const out: Experimental_CompositionCandidate[] = [
    {
      id: 'trip',
      description: to
        ? `Flight search results: flights from ${HOME} to ${to}`
        : `Flight search results`,
      element: {
        type: 'Trip',
        props: { title: to ? `${HOME} → ${to}` : 'Flights' },
      },
    },
  ];
  if (!to) return out;

  const rows = FLIGHTS.filter((f) => f.to === to);
  out.push({
    id: 'summary',
    description: `A line saying how many flights to ${to} were found`,
    root: false,
    element: {
      type: 'Summary',
      props: {
        text: `${rows.length} flights today, cheapest $${Math.min(...rows.map((r) => r.price))}`,
      },
    },
  });

  for (const f of rows) {
    out.push({
      id: f.id,
      description:
        `${f.carrier} ${f.number} to ${to}, departs ${f.depart} (${partOfDay(f.depart)}), ` +
        `arrives ${f.arrive}, ${f.stops === 0 ? 'direct' : `${f.stops} stop`}, $${f.price}`,
      root: false,
      element: {
        type: 'Flight',
        props: {
          id: f.id,
          carrier: f.carrier,
          number: f.number,
          depart: f.depart,
          arrive: f.arrive,
          stops: f.stops,
          price: f.price,
        },
        // 3. the binding. Copied into the spec verbatim; never executed by
        // the composer.
        on: { press: { action: 'bookFlight', params: { flightId: f.id } } },
      },
    });
  }
  return out;
}

// --- the registry, and the action ------------------------------------------

const store = createStateStore({ booked: null as string | null });

const setState: SetState = (updater) => {
  const next = updater(store.getSnapshot());
  store.update(
    Object.fromEntries(Object.keys(next).map((k) => [`/${k}`, next[k]])),
  );
};

const { registry, handlers } = defineRegistry(catalog, {
  components: {
    Trip: ({ props, children }) => (
      <box style={{ flexDirection: 'column', gap: 10, padding: 14 }}>
        <text style={{ fontSize: 17, color: '$text' }}>{props.title}</text>
        {children}
      </box>
    ),

    Summary: ({ props }) => (
      <text style={{ fontSize: 11, color: '$textMuted' }}>{props.text}</text>
    ),

    Flight: ({ props, emit }) => {
      const { get } = useStateStore();
      const booked = get('/booked') === props.id;
      return (
        <box
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 16,
            padding: 12,
            backgroundColor: '$surface',
            borderRadius: 6,
            borderWidth: 1,
            borderColor: booked ? '$success' : '$border',
          }}
        >
          <box
            style={{
              flexDirection: 'column',
              gap: 2,
              minWidth: 130,
              flexShrink: 0,
            }}
          >
            <text style={{ fontSize: 18, color: '$text' }}>
              {`${props.depart} → ${props.arrive}`}
            </text>
            <text style={{ fontSize: 10, color: '$textMuted' }}>
              {`${props.carrier} ${props.number}`}
            </text>
          </box>
          <text
            style={{
              fontSize: 11,
              color: props.stops === 0 ? '$success' : '$warning',
              width: 60,
            }}
          >
            {props.stops === 0 ? 'direct' : `${props.stops} stop`}
          </text>
          <text style={{ fontSize: 18, color: '$text', flexGrow: 1 }}>
            {`$${props.price}`}
          </text>
          {booked ? (
            <text style={{ fontSize: 12, color: '$success' }}>Booked ✓</text>
          ) : (
            <Button size="small" primary onPress={() => emit('press')}>
              Book
            </Button>
          )}
        </box>
      );
    },
  },

  actions: {
    // The only code in this file that has consequences, and so the only
    // place the checks go. A model chose to *offer* this button; it did not
    // decide the booking is allowed. Validate the id against the records,
    // authorize the traveller, price-check — here, every time.
    bookFlight: async (params, set) => {
      const flight = FLIGHTS.find((f) => f.id === params?.flightId);
      if (!flight) {
        console.error(`[flights] refused: no flight ${params?.flightId}`);
        return;
      }
      console.log(
        `[flights] booked ${flight.number} ${flight.depart} for $${flight.price} (demo — nothing was charged)`,
      );
      set((prev) => ({ ...prev, booked: flight.id }));
    },
  },
});

const actionHandlers = handlers(
  () => setState,
  () => store.getSnapshot(),
);

// --- composing -------------------------------------------------------------

const PROMPTS = [
  'Book me a flight to Melbourne',
  'Cheapest direct flight to Melbourne',
  'Morning flights to Brisbane',
  'Book me a hotel in Paris',
];

/** What the tab worked out before composing, shown so the window can say
 *  which half — code or model — did what. */
interface TripMeta {
  to: string | null;
  offered: number;
}

const FLIGHTS_LIMITS = { maxSteps: 12, maxElements: 14, maxDepth: 3 };

/** The "Flights" tab. */
export function FlightsTab(): ReactElement {
  const { run, compose } = useComposer<TripMeta>({
    catalog,
    initialState: { booked: null },
    limits: FLIGHTS_LIMITS,
    // The two halves, in order: code extracts, then candidates are built
    // from the records that extraction selected.
    prepare: (prompt) => {
      const { to } = parseTrip(prompt);
      const candidates = buildCandidates(to);
      store.set('/booked', null);
      return { candidates, meta: { to, offered: candidates.length } };
    },
  });
  const kept = useMemo(
    () => (run.spec ? Object.keys(run.spec.elements).length : 0),
    [run.spec],
  );
  const started = run.busy || run.stopReason !== null;

  return (
    <box style={{ flexDirection: 'row', flexGrow: 1, gap: 14, padding: 14 }}>
      {/* Scrolls: without a key the setup steps alone are most of the
            column's height. */}
      <box
        style={{
          flexDirection: 'column',
          gap: 8,
          width: 300,
          overflow: 'scroll',
        }}
      >
        <text style={{ fontSize: 13, color: '$text' }}>Search flights</text>
        <text style={{ fontSize: 10, color: '$textMuted' }}>
          {`Code finds the destination and pulls today's flights from ${HOME}; the model decides which to show and in what order.`}
        </text>
        <ModelSetup />
        <PromptList prompts={PROMPTS} busy={run.busy} onPick={compose} />

        <Heading>1. extraction (code)</Heading>
        <Line>
          {started ? `destination: ${run.meta?.to ?? 'none found'}` : '—'}
        </Line>
        <Heading>2. composition (model)</Heading>
        <Line>
          {started
            ? `offered ${run.meta?.offered ?? 0} candidates, kept ${kept}`
            : '—'}
        </Line>
        <Trace run={run} />
      </box>
      <Preview
        run={run}
        store={store}
        registry={registry}
        handlers={actionHandlers}
        idle="Pick a search."
        empty="Nothing to show — the request is outside what these candidates can do."
      />
    </box>
  );
}
