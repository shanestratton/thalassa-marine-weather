# Bosun Pi Tool API — Contract for the iPhone Orchestrator

**Status:** Phase 3 shipped on the Pi. Smoke-tested locally. Not yet exercised by the iOS orchestrator.
**Last updated:** 2026-05-02
**From:** Claude B (Pi-side)
**For:** Claude A (Thalassa-side, building the orchestrator)
**Companion design:** [BOSUN_HAIKU_ARCHITECTURE.md](./BOSUN_HAIKU_ARCHITECTURE.md)

This doc is the operational contract between the iPhone orchestrator and the Pi tool host. It supersedes any mental model based on the cascade-era endpoints — those still exist as Tier-D fallback but the new shape is what Haiku invokes when it wants Pi-local data.

---

## Quick start

```bash
PI=192.168.50.150  # Shane's home LAN — eth0; wlan0 is .152

curl -s http://$PI:5000/api/health
# {"ok":true,"service":"bosun-web","version":1}

curl -s -X POST http://$PI:5000/tool/get_vessel_profile | jq .
curl -s -X POST http://$PI:5000/tool/search_manuals \
  -H 'Content-Type: application/json' \
  -d '{"query":"valve clearance","k":3}' | jq '.value[0]'
```

The `value: null` cases are clean returns (sealed-appliance design facing missing sensors), not errors — see envelope rules below.

---

## Discovery

The Pi is discovered via the existing `BoatNetworkService` (Thalassa side) by probing well-known service ports. Once `piHost` is resolved, the orchestrator just hits `http://${piHost}:5000`.

| Path                           | Reality                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bosun.local` mDNS             | **Squatted** by another device on Shane's LAN — do not trust                                                                                                                                      |
| `BoatNetworkService` discovery | Finds Pi via SignalK :3000 / pi-cache :3001 / AvNav :8080                                                                                                                                         |
| `bosun-web` :5000 probe        | **Not yet** in `BoatNetworkService`'s probe list — recommend adding `{name: 'bosun-web', port: 5000, healthPath: '/api/health'}` so the on-boat Bosun status pip is independent of SignalK uptime |
| Tailscale (Tier B)             | Not set up. On the architecture doc's open-decisions list.                                                                                                                                        |

**Current Pi addresses:**

```
eth0 (cabled): 192.168.50.150
wlan0:         192.168.50.152
hostname:      bosun  (resolves on home LAN via DHCP-supplied DNS, not mDNS)
```

---

## Common envelope

Every `/tool/*` response is wrapped in this envelope, per architecture doc §5 design rule "structured JSON with `{value, source, timestamp}` so Haiku can be honest about provenance and freshness":

```json
{
  "value":      <inner shape — see per-tool sections, or null when unavailable>,
  "source":     "signalk" | "modbus" | "bosun.profile" | "sqlite-vec" | "signalk+modbus",
  "timestamp":  "2026-05-02T02:45:48.980+00:00",
  "error":      null | "human-readable reason",
  "latency_ms": 76
}
```

**Error semantics:**

- HTTP **200** with `value: null` + non-null `error` = capability unavailable but the Pi is healthy. **Treat as data, not transport failure.**
  Examples: "No GPS fix on the bus", "Modbus: VICTRON_CERBO_HOST is not set", "cruising-log feature not yet wired on this Pi"
- HTTP **4xx** = caller error (bad JSON, missing required field)
- HTTP **5xx** = Pi is broken; orchestrator should mark Bosun unreachable

**Latency budgets** (architecture doc §5; tools time out at budget × 1.5):

| Tool                  | Budget | Hard cap       |
| --------------------- | ------ | -------------- |
| `get_vessel_position` | 50 ms  | 75 ms          |
| `get_vessel_state`    | 100 ms | 150 ms         |
| `get_vessel_profile`  | 50 ms  | 75 ms (cached) |
| `search_manuals`      | 300 ms | 450 ms         |
| `query_logs`          | 300 ms | 450 ms         |

The hard cap is informational right now — not yet enforced server-side via watchdog. Trust but verify.

---

## Tool reference

### `POST /tool/get_vessel_position`

Body: none.

```json
{
    "value": {
        "lat": 33.7,
        "lon": -118.3,
        "heading_deg_true": 285.0,
        "sog_kt": 6.2,
        "cog_deg_true": 287.5
    },
    "source": "signalk",
    "timestamp": "2026-05-02T02:45:12.605+00:00",
    "error": null,
    "latency_ms": 21
}
```

Backed by SignalK paths `navigation.position`, `navigation.headingTrue`, `navigation.speedOverGround`, `navigation.courseOverGroundTrue`. Returns `value: null` with `error: "No GPS fix on the bus"` if the GPS hasn't reported yet.

> **Deviation from architecture doc:** doc says fields `{heading, sog, cog}`. We return `heading_deg_true`, `sog_kt`, `cog_deg_true` so Haiku doesn't have to guess units. Doc-shape adapter is a 30-min job if the orchestrator prefers terse names.

### `POST /tool/get_vessel_state`

Body: none.

```json
{
    "value": {
        "wind_apparent_speed_kt": 14.0,
        "wind_apparent_angle_deg": 60.0,
        "wind_true_speed_kt": 12.5,
        "wind_true_angle_deg": 45.0,
        "depth_m": 12.4,
        "water_temp_c": 18.3,
        "fuel_pct": 76.0,
        "fresh_water_pct": 80.0,
        "engine_hours": 1247.5,
        "batt_soc_pct": 78.5,
        "batt_voltage_v": 13.2
    },
    "source": "signalk+modbus",
    "timestamp": "2026-05-02T02:45:12.672+00:00",
    "error": null,
    "latency_ms": 39
}
```

Combines SignalK environmental + Modbus battery (via Phase 2 victron tools). Any field missing from a sensor returns `null` for that field; the rest still come back. If both subsystems fail, `error` field summarises both.

> **Deviation from architecture doc:** doc says `{wind_apparent, wind_true, depth, fuel_pct, water_pct, engine_hrs, batt_soc, ts}`. We split each wind field into `_speed_kt` + `_angle_deg`; renamed `water_pct` to `fresh_water_pct` (more specific, since "water" is overloaded marine-side); added `water_temp_c` and `batt_voltage_v` as bonus fields available from the same sensor passes.

### `POST /tool/get_vessel_profile`

Body: none. Returns the static `vessel_profile.json` (mtime-cached on the Pi).

```json
{
  "value": {
    "schema_version": 1,
    "identity": { "name": "Serene Summer", "mmsi": "503101240", "callsign": null },
    "vessel": {
      "make": "Tayana", "model": "55", "year": 1991, "type": "cutter",
      "loa_m": 16.76, "lwl_m": 13.72, "beam_m": 4.42,
      "draft_m": 1.98, "air_draft_m": 22.25,
      "displacement_kg": 22680, "ballast_kg": 9525
    },
    "engine": { "make": "Perkins", "model": "6.3544", "type": "marine diesel, 6-cylinder", "horsepower": 85, "fuel": "diesel" },
    "electrical": { "house_voltage": "12V DC", "ac_voltage": "240V AC", "monitoring": [...], "inverter_charger": "...", "house_bank": "..." },
    "tankage": { "fuel_l": null, "water_l": null, "holding_l": null },
    "sails": [],
    "polars": null,
    "owner": { "name": "Shane Stratton", "address_form": "Cap'n", "experience_level": "bluewater cruiser", "comfort_thresholds": {...} }
  },
  "source": "bosun.profile",
  "timestamp": "...",
  "error": null,
  "latency_ms": 0
}
```

> **Deviation from architecture doc:** doc shows a flat `{make, model, loa, draft, …}`. We went **nested** (`vessel.make`, `vessel.loa_m`, `engine.model`, etc.) because the long-term storage shape needs to scale to sails + polars + tankage + cruising grounds and a flat namespace gets crowded fast. If the orchestrator prefers flat for the Haiku system prompt, easiest path is the orchestrator flattens once on its side rather than the Pi double-shaping.

### `POST /tool/search_manuals`

Body:

```json
{ "query": "valve clearance", "k": 3 }
```

`k` defaults to 5. RAG over the marine corpus (`corpus.db`, sqlite-vec, bge-small-en-v1.5 embeddings).

```json
{
    "value": [
        {
            "chunk": "## Page 47\n\nHow to check valve tip clearances...",
            "source": "boat-systems/engines/perkins-6-3544-manual.md",
            "heading": "Page 47",
            "score": 0.706
        }
    ],
    "source": "sqlite-vec",
    "timestamp": "...",
    "error": null,
    "latency_ms": 76
}
```

`score` is L2 distance from the query embedding — lower is closer. Pre-warmed on Flask boot so first user call doesn't pay the ~9s embedding-model cold start. Marine corpus currently includes:

- Perkins 6.3544 user handbook (74 chunks)
- Victron MultiPlus 3k, MPPT, Orion XS, Cerbo GX manuals (1,070 chunks combined)
- Cerbo Modbus-TCP register reference (23 chunks)
- Enerdrive B-TEC lithium + AS/NZS 3001 fitting guide (37 chunks)
- Thalassa internal docs + sloop-vs-ketch primer

> **Deviation from architecture doc:** doc says `[{chunk, source, page, score}]`. We return `heading` instead of `page` — the markdown-aware chunker stores section anchors which are sometimes page numbers (`Page 47`) and sometimes section names (`## 2.2 Unit-IDs`). The chunker doesn't always know if a heading is a page number. Caller can substring-match if a numeric page is needed.

### `POST /tool/query_logs`

Body: `{ "query": "...", "k": 5, "time_range": {"start": "...", "end": "..."} }` (all optional).

**Stub.** Always returns:

```json
{
    "value": null,
    "source": "bosun.logs",
    "timestamp": "...",
    "error": "cruising-log feature not yet wired on this Pi",
    "latency_ms": 0
}
```

The cruising-log SQLite + embeddings store doesn't exist yet — the orchestrator should treat this as "capability unavailable" and not surface it to Haiku as a usable tool until the journal feature lands. Endpoint shape is locked in for forward-compat.

### `GET /tool/_telemetry?limit=50`

Dev/debug only — not part of the Haiku tool registry. Returns recent tool calls + per-tool p50/p95/error-rate aggregates from the local SQLite ring buffer (10k-row cap).

Useful during orchestrator wiring to confirm calls are landing.

---

## Legacy cascade endpoints (Tier-D fallback)

These still exist on the Pi, running the local Llama 3.2 3B narrating over RAG. Per the new architecture they're only invoked in **Tier D** (offshore, no internet) when Haiku-via-iPhone is unreachable.

| Endpoint                                       | Purpose                                                         |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `POST /api/text/ask` `{text}`                  | Typed-text Tier-D query                                         |
| `POST /api/voice/ask` `{audio_b64, mime_type}` | Voice Tier-D query — Whisper.cpp STT + cascade + ElevenLabs TTS |
| `GET /api/health`                              | Liveness probe                                                  |

Both ask endpoints return `{transcript, answer_text, audio_b64, source: "bosun", tool_calls, timings_ms}` — the cascade-era envelope, distinct from the Phase 3 `{value, source, timestamp, error, latency_ms}` shape.

After the 8B → 3B consolidation + slim-prompt + RAG knob tuning, Tier-D RAG queries on Pi 5 CPU clock at **~80s wall-time** for a typical engine-spec query (was ~430s pre-tuning).

**Tier-D shape support for context/history:** these endpoints don't currently accept a caller-supplied `context` field the way the cloud Edge Function does. Internally they have last-2-turn session memory via `session.py + conversation_log.db`. If the orchestrator wants to push Thalassa-state context into Tier-D queries, easy server-side add — flag if needed.

---

## Open decisions for the orchestrator side

1. **Field-name reconciliation.** Either:
    - The orchestrator's tool descriptions to Haiku match what the Pi actually returns (recommended — Haiku reads the schema text we feed it, doesn't care what any doc said), or
    - We add a doc-shape adapter on the Pi (~2 hours).
2. **Bosun-web in `BoatNetworkService` probe list.** Add `:5000/api/health` so the on-boat status pip is decoupled from SignalK uptime. Pi side is ready.
3. **`tool_calls` reporting.** The new `/tool/*` path doesn't emit a `tool_calls` array because there's nothing further to call. The orchestrator (which IS the caller) knows what it called. If the Tier-D fallback path is hit, the cascade response DOES include `tool_calls` for any victron\_\* tools the local 3B invoked — this is internal cascade telemetry, not part of the new tool contract.
4. **Tier-D STT fallback.** Architecture doc lists this open. Pi has Whisper.cpp + ffmpeg ready; iPhone-side Apple on-device SR is the alternative if compute on the Pi is too slow. No-op until decided.
5. **Auth for off-LAN.** None today. Tailscale on the off-boat path eventually; for now LAN-trust assumption.

---

## Sanity-test script for the orchestrator

```bash
PI=192.168.50.150
H="Content-Type: application/json"

# Liveness
curl -s http://$PI:5000/api/health | jq .

# Profile (instant, mtime-cached)
curl -s -X POST http://$PI:5000/tool/get_vessel_profile | jq '.value.identity, .source, .latency_ms'

# Position — returns null+error when no GPS on the bus, that's correct
curl -s -X POST http://$PI:5000/tool/get_vessel_position | jq .

# State — returns partial nulls if SignalK or Modbus is missing
curl -s -X POST http://$PI:5000/tool/get_vessel_state | jq '.value, .error'

# Manual search — first call ~80ms warm, ~9s cold (pre-warm runs at Flask boot)
curl -s -X POST http://$PI:5000/tool/search_manuals -H "$H" \
  -d '{"query":"valve clearance","k":3}' | jq '.value[0]'

curl -s -X POST http://$PI:5000/tool/search_manuals -H "$H" \
  -d '{"query":"cerbo modbus unit id","k":2}' | jq '.value | map({source, heading, score})'

# Logs (stub)
curl -s -X POST http://$PI:5000/tool/query_logs -H "$H" \
  -d '{"query":"any"}' | jq '.error'

# Telemetry stats
curl -s http://$PI:5000/tool/_telemetry | jq '.stats'
```

Each call should respond in well under a second for everything except an actual cold-cache `search_manuals`. If anything hangs > 5s on the Pi side, that's a Pi bug — open an issue and ping me.

---

## Files of interest on the Pi

```
/mnt/nvme/bosun/
├── bosun_web.py            Flask app, blueprint registration, embedding pre-warm
├── bosun_tools_api.py      The /tool/* blueprint — all 5 endpoints + envelope helpers
├── signalk_client.py       SignalK REST adapter (path lookup + unit conversions)
├── tool_telemetry.py       SQLite ring buffer + p50/p95 aggregates
├── vessel_profile.json     Static profile, mtime-cached
├── modbus_client.py        Phase 2 — Victron Cerbo Modbus client
├── tools/                  Phase 2 — @tool-decorated registry (cascade-era)
├── retrieve.py             RAG over corpus.db (sqlite-vec + bge-small)
├── cascade.py              Tier-D fallback path (3B + RAG, post-8B retirement)
├── corpus.db               sqlite-vec; ingested marine corpus
└── tool_telemetry.db       Ring buffer for tool-call telemetry
```

If B wants to read or hack any of these directly, SSH alias is `bosun` (or `ssh skipper@192.168.50.150`).
