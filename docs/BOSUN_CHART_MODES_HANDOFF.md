# Bosun ↔ ChartModes — First Integration Handoff

**Status:** Parking-lot design. Do not implement before TestFlight ships
(per [BOSUN_AI_SPEC.md](BOSUN_AI_SPEC.md) § "Why now (post-TestFlight)").
This doc captures the design for the very first Bosun integration so
that when post-TestFlight rolls around, there's a concrete starting
point rather than a blank page.

**Companion docs:**

- [BOSUN_AI_SPEC.md](BOSUN_AI_SPEC.md) — full Bosun architecture + corpus + fine-tuning plan.
- [THALASSA_FOR_BOSUN.md](THALASSA_FOR_BOSUN.md) — Thalassa platform context Bosun has to know about.

This doc is narrower: just the first integration point.

---

## Why ChartModes is the first integration

Three reasons make `ChartModes` (the top-center "Day Sail / Offshore /
Storm Watch / Charts Only / Clear" picker on the chart screen) the
right entry point for Bosun:

1. **Smallest demo with real value.** Today the picker requires a user
   to translate their actual intent ("I'm sailing to Lord Howe Friday
   morning") into one of five hardcoded preset labels. That's the
   exact mismatch Bosun is built to solve.
2. **No sensor wiring required.** Mode synthesis is a pure
   intent-→-config transformation. It doesn't need anchor-watch
   integration, AIS callouts, or voice — those are Phase 2/3 and
   require the iOS-side sensor surface to be stable first.
3. **Fails gracefully.** If Bosun is unreachable, slow, or returns
   garbage, the user falls back to the existing 5-preset picker with
   zero functionality lost. That's the right shape for a first ship.

The existing UI lives in [`components/map/ChartModes.tsx`](../components/map/ChartModes.tsx).

---

## UX shape

### Today

User taps the `[🌅 Day Sail ▾]` chip → vertical dropdown of 5 preset
chips → pick one → `applyMode()` flips a fixed set of layers on/off
and persists to localStorage.

### With Bosun

Same chip, same dropdown. Two changes:

1. **A text input at the top of the dropdown** with placeholder copy
   along the lines of _"Or tell Bosun what you're doing…"_. Submit
   with return key or a mic button (mic is Phase 2).
2. **The 5 preset chips remain below the input as fallbacks.** They
   stay one tap away — they are _not_ replaced.

When the user submits text:

- **Loading state**: chip label changes to `[💭 Asking Bosun…]`,
  spinner replaces the dropdown body.
- **Success**: `applyMode()` runs with a _synthesized_ spec (see data
  contract below), the chip label updates to a Bosun-generated short
  label like `[🧭 Lord Howe → Fri ▾]`, dropdown closes.
- **Failure / Bosun unreachable**: input shows a one-line error
  ("Bosun's offline — pick a preset"), focus stays on the dropdown
  with the 5 presets visible. No modal, no toast.
- **Ambiguity**: Bosun can return a single follow-up question instead
  of a config (e.g. _"Do you mean Lord Howe Island, or Lord Howe
  seamount near NZ?"_). The dropdown shows the question + up to 3
  one-tap answers. One round-trip max for the first ship — no
  open-ended chat thread.

### What stays the same

- `localStorage` persists the _most recent_ synthesized mode the same
  way it persists picked presets today, so the chip survives a
  relaunch.
- The "custom" mode auto-detection in `detectMode()` still works:
  if the user manually toggles a layer after Bosun applies a synthesized
  config, the chip flips to `⚙️ Custom`.
- The cog → `LayerSettings` flow is untouched.
- Coach marks (the "Tap a mode at the top…" first-run hint) are
  untouched.

---

## Data contract

This is the most important part of the doc. Get this contract right
and the rest is easy.

### Request (Thalassa → Bosun)

```jsonc
{
    "intent": "leaving for Lord Howe Friday morning",
    "context": {
        "now": "2026-05-02T13:30:00+10:00",
        "vessel": {
            "id": "shane-tayana-55",
            "lengthM": 16.7,
            "draftM": 2.1,
            "displacementKg": 28000,
            "polars": "tayana55-cruising",
        },
        "position": { "lat": -27.4698, "lon": 153.0251 },
        "currentMode": "day-sail",
        "activeLayers": ["wind"],
        "available": {
            "skyLayers": [
                "wind",
                "rain",
                "pressure",
                "clouds",
                "temperature",
                "currents",
                "waves",
                "sst",
                "chl",
                "seaice",
                "mld",
                "velocity",
                "sea",
            ],
            "tactical": ["ais", "lightning", "cyclone", "squall", "seamark", "tides", "chokepoint", "vesselTracking"],
            "models": ["GFS", "ECMWF", "HRRR", "CMEMS"],
        },
    },
}
```

The `available.*` arrays are critical: they tell Bosun what Thalassa
can actually render. **Bosun must not return a layer name that's not
in this list.** This is a hard schema-validation rule, not a polite
request — see "Honesty rules" below.

### Response (Bosun → Thalassa)

Bosun returns _one of two_ shapes:

**(A) A synthesized mode config:**

```jsonc
{
    "kind": "mode",
    "label": "Lord Howe → Fri",
    "icon": "🧭",
    "summary": "Wind, waves, pressure for Friday departure",
    "confidence": 0.86,
    "reasoning": "Offshore passage with departure 2 days out. ECMWF and GFS agree on a 18-22kt SE window Friday 0600 local; seas 1.8m short period. Squall risk low. Cyclones — none in track radius.",
    "config": {
        "sky": ["wind", "waves", "pressure"],
        "tactical": {
            "ais": true,
            "lightning": false,
            "cyclone": true,
            "squall": false,
            "seamark": true,
            "tides": false,
            "chokepoint": false,
            "vesselTracking": true,
        },
        "mpa": false,
        "timeScrub": "2026-05-09T06:00:00+10:00",
        "centerOn": { "lat": -29.8, "lon": 156.5 },
        "zoom": 6,
    },
    "alerts": [
        { "type": "wind-shift", "threshold": "8kt change at departure window" },
        { "type": "pressure-drop", "threshold": "2hPa/3h within 200nm of route" },
    ],
}
```

The `config` block is _exactly_ the shape that the existing `ModeSpec`
in `ChartModes.tsx` already understands — Bosun is essentially writing
a new entry into `MODE_SPECS` on the fly, plus three new fields the
preset path didn't need:

- `timeScrub` — a moment in time to scrub the chart's time slider to.
- `centerOn` + `zoom` — viewport target for `map.flyTo()`.
- `alerts` — passive watch subscriptions (Phase 2; Phase 1 ignores).

**(B) A clarifying question:**

```jsonc
{
    "kind": "question",
    "text": "Did you mean Lord Howe Island (NSW) or Lord Howe seamount?",
    "options": [
        { "label": "Lord Howe Island", "intent": "leaving for Lord Howe Island Friday morning" },
        { "label": "Lord Howe seamount", "intent": "leaving for Lord Howe seamount Friday morning" },
    ],
}
```

Picking an option re-issues the request with the disambiguated intent.
Hard limit: **one clarification round per top-level intent**. If
Bosun would need to ask a second question, it picks the most-likely
interpretation and returns a `mode` with reduced confidence.

---

## Honesty rules (specific to mode synthesis)

Per [BOSUN_AI_SPEC.md](BOSUN_AI_SPEC.md) § "Risks & open questions"
and the saved `lesson_bosun_honesty_principles` memory, hallucination
in a marine-weather AI is dangerous. Three concrete rules for this
integration:

1. **Bosun does not invent weather data.** It only references models
   Thalassa actually fetched (`available.models`). The `reasoning`
   string can quote actual forecast values, but only if the
   forecast was in the request payload (which Phase 1 doesn't send —
   so Phase 1 reasoning is _qualitative only_: "wind, waves, and
   pressure are the right layers for an offshore passage", not "winds
   are 18-22kt").
2. **Bosun does not invent layer names.** Schema validation rejects
   any `config.sky` entry not in `available.skyLayers`. Same for
   tactical. A returned config that fails validation triggers the
   fallback path (preset picker visible, error shown).
3. **Confidence is shown.** Below 0.7, the chip label is prefixed with
   `~` and the dropdown shows a "low confidence" caveat with a
   one-tap "use a preset instead" link. Below 0.5, Bosun's response is
   discarded entirely and the user sees the preset picker with the
   error "Bosun wasn't sure — pick a preset."

---

## Phased rollout

### Phase 1 — first ship (target: first month after TestFlight stable)

- Text input only (no voice).
- 3-5 well-validated intent classes:
    - "leaving for X [day/time]" → offshore-style synthesized mode
    - "watch for storms near me" → storm-watch with refined alerts
    - "racing window for X this weekend" → meteo-focused, tide-aware
    - "what's the weather doing" → soft fallback to Day Sail
- One clarification round max.
- Synthesized mode applied; `alerts` field returned but **not
  subscribed to yet** (Phase 2).
- Bosun runs on the user's Pi if reachable; Phase 1 has **no
  cloud fallback** — if there's no Pi, the input is hidden and
  only presets are shown. (Cloud fallback is a Phase 2 question
  with cost/privacy tradeoffs to think through.)

### Phase 2

- Voice input via existing speech APIs.
- `alerts` field actually subscribed to → passive watch surface.
- Multi-turn conversation when single-round can't resolve.
- Sensor stream integration (current heading, SOG, AIS) added
  to `context` payload.

### Phase 3

- Hands-free underway mode (voice in, voice out).
- Anchor-watch + drag detection narration.
- Vessel callouts on AIS guard zone.

---

## Architecture sketch

```
┌─────────────────────┐
│  ChartModes input   │
│  "leaving for LHI"  │
└──────────┬──────────┘
           │ HTTP POST
           ▼
┌─────────────────────┐         ┌─────────────────────┐
│  PiCacheService     │ ──TCP──▶│  Bosun on Pi        │
│  (extend with       │         │  - Llama 3.1 8B Q4  │
│   /bosun/intent)    │         │  - SQLite-vec RAG   │
└──────────┬──────────┘         │  - JSON-schema      │
           │                    │    constrained out  │
           │ structured JSON    └─────────────────────┘
           ▼
┌─────────────────────┐
│  ModeSynthesizer    │  validates against available.*,
│  (new module)       │  rejects garbage, applies
│                     │  via existing applyMode()
└─────────────────────┘
```

Three notes:

- **Reuse `PiCacheService` transport, don't add a new service.**
  Pi reachability, mDNS discovery, health-checking, retry, and
  offline detection are already solved there. Bosun gets a new
  endpoint `/bosun/intent` on the Pi side, served from the same
  process or a sibling Node service co-located on the Pi.
- **JSON-schema-constrained generation** (e.g. `outlines`,
  `llama.cpp` grammar) is non-negotiable. The whole "no invented
  layer names" rule depends on it. Free-form output is forbidden
  for the `config` block; the `reasoning` and `label` strings can
  be free-form within reasonable length caps.
- **The `ModeSynthesizer` module** is a thin validator + adapter
  that lives on the Thalassa side. It takes Bosun's response,
  validates against the schema, validates layer names against
  `available.*`, and either calls the existing `applyMode()` or
  returns an error to the dropdown. It's the trust boundary.

---

## Files this would touch

- [`components/map/ChartModes.tsx`](../components/map/ChartModes.tsx) — add text input, loading/error states, Bosun branch in submit handler
- [`services/PiCacheService.ts`](../services/PiCacheService.ts) — add `intentRequest()` method on the same Pi transport
- `services/BosunModeSynthesizer.ts` — _new_ — validator + adapter
- `pi-cache/src/bosun.ts` — _new on the Pi_ — `/bosun/intent` endpoint, prompt assembly, JSON-schema-constrained Llama call
- `pi-cache/install.sh` — pull in Llama runtime, model file, schema config
- [`docs/BOSUN_AI_SPEC.md`](BOSUN_AI_SPEC.md) — cross-reference back to this doc once Phase 1 is real

---

## Explicit non-goals for Phase 1

To prevent scope creep when this work starts, the following are
**deliberately out of scope** for the first ship:

- Multi-turn conversation history (one round-trip + one optional
  clarification).
- Voice input or output.
- Sensor stream integration (anchor watch, AIS, heading, SOG).
- Cloud LLM fallback when Pi is unreachable (Phase 2 decision —
  privacy tradeoffs).
- Per-user fine-tuning loop (Phase 2+).
- Bosun ↔ Scuttlebutt integration (separate workstream).
- Vessel diagnostics / Victron / engine — explicitly out of Bosun's
  domain scope per `feedback_bosun_scope` memory.

---

## Open questions to resolve before Phase 1 starts

1. **Where does the Pi-side Bosun process live?** Same Node process
   as `pi-cache`, or separate? Tradeoff: simpler ops vs. memory
   pressure (Llama 8B Q4 + Node weather cache co-resident on a
   16GB Pi 5).
2. **What's the latency budget?** 3-5s for a synthesized mode is
   probably acceptable on first ship. If Llama 8B inference takes
   8s, the UX needs an "I'm thinking…" state design that doesn't
   feel broken.
3. **How does the chip handle a synthesized mode that the user
   then partially edits?** Currently `detectMode()` flips to
   "Custom" the moment a layer is manually toggled. With Bosun
   modes, that throws away the synthesized intent. Options:
   keep the Bosun label until next mode change, or revert to
   Custom. Decide before Phase 1.
4. **Persistence shape.** `localStorage[STORAGE_KEY]` today stores
   one of 5 preset IDs. With Bosun, what gets persisted — the
   synthesized config, the original intent string, or both? My
   default would be: store the original intent string + the
   synthesized config, and on relaunch, re-apply the config without
   re-asking Bosun. Re-ask only on user request.

---

## Success metric for Phase 1

Single, simple metric: **what fraction of Bosun-synthesized modes
does the user keep using vs. revert to a preset within 60 seconds?**
If users revert >50% of the time, Bosun's not adding value here and
we double-back. If <20% revert, we ship Phase 2.
