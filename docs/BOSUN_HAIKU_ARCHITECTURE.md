# Bosun + Haiku Architecture

**Status:** Design — not yet implemented.
**Last updated:** 2026-05-02
**Scope:** How the Bosun marine assistant (Pi-based) and the Thalassa iOS app integrate with Claude Haiku 4.5 (cloud) to deliver a "knows your boat" voice/text assistant, with graceful degradation when offline.

---

## 1. Principles

1. **Speed over privacy.** Cloud Haiku is the brain. The Pi is a context server, not a parallel LLM. The local model exists only for offline fallback.
2. **Sealed appliance.** The Pi ships as a closed product. No customer-facing config of model, prompts, or internals. Updates ship via OTA.
3. **Honesty over fluency.** Tools return structured, time-stamped data; Haiku narrates. The system prompt enforces "call tools before guessing" and "say I don't know when you don't."
4. **Graceful degradation, never silent.** The user always knows which brain is answering and what capabilities are currently available.

## 2. Three Layers

| Layer         | Hardware                | Role                                                                       |
| ------------- | ----------------------- | -------------------------------------------------------------------------- |
| **Thalassa**  | iPhone / iPad           | UI, mic, GPS, speaker, orchestration                                       |
| **Bosun**     | Pi 5 16GB on the vessel | Context server (vessel profile, NMEA, manuals, logs), local fallback brain |
| **Haiku 4.5** | Cloud (Anthropic API)   | Primary reasoning + tool orchestration                                     |

**Why orchestration lives on the phone, not the Pi:** the phone goes everywhere. The Pi doesn't. Off-boat queries (Tier C below) require the orchestrator to be reachable.

## 3. Request Flow

```
User holds PTT → mic captures audio (MediaRecorder)
  → STT (ElevenLabs Scribe, server-side)
  → Thalassa orchestrator builds Haiku request:
     • Cached system prompt (vessel profile + honesty rules)
     • Cached state snapshot (position, conditions)
     • User transcript
     • Tool registry
  → Anthropic API
  → Haiku reasons → calls tools in parallel
     • Pi-local tools: vessel state, manuals, logs
     • Cloud tools: weather, routing, web search
  → Haiku composes structured answer with tool citations
  → TTS (ElevenLabs cloud, Apple on-device TTS fallback when offline)
  → Audio out
```

**Latency budget:** under 3s to first audio, under 6s to finish, on cellular.

## 4. Connectivity Tiers

| Tier  | Situation                            | Brain                | Status indicator                  |
| ----- | ------------------------------------ | -------------------- | --------------------------------- |
| **A** | Boat + internet                      | Haiku                | Green pip — "Bosun"               |
| **B** | Off-boat, internet, Pi via Tailscale | Haiku                | Green pip — "Bosun · remote"      |
| **C** | Off-boat, internet, no Pi            | Haiku                | Yellow pip — "Bosun · cloud only" |
| **D** | On boat, no internet                 | Llama 3.2 3B (local) | Orange pip — "Bosun · offline"    |

The status pip is always visible. Tap → modal explains current capabilities.

### Tier transitions

- **A → B:** silent (orchestrator already on the phone)
- **A → C** (lost Pi): tone + "Lost connection to the boat — weather and routing still available, no logs or manuals"
- **A → D** (lost internet): tone + "Offline mode — running locally, slower, will keep answers conservative"
- **D → A** (back online): tone + "Back online — full Bosun"
- **Flapping connection:** debounce 60s before announcing transitions

### Capability matrix

| Capability          | A   | B   | C   | D              |
| ------------------- | --- | --- | --- | -------------- |
| Weather forecast    | ✅  | ✅  | ✅  | ⚠️ cached only |
| Route planning      | ✅  | ✅  | ✅  | ❌             |
| Search manuals      | ✅  | ✅  | ❌  | ✅             |
| Vessel state (NMEA) | ✅  | ✅  | ❌  | ✅             |
| Cruising log search | ✅  | ✅  | ❌  | ✅             |
| Web search          | ✅  | ✅  | ✅  | ❌             |

When a request needs a capability the current tier lacks, Bosun says so directly. No silence. No confabulation.

## 5. Tool Registry (v1)

Eleven tools. Every tool returns structured JSON with `{value, source, timestamp}` so Haiku can be honest about provenance and freshness. Every tool can return `unavailable` cleanly.

### Vessel & state — Pi (LAN/Tailscale)

| Tool                  | Returns                                                                            | Latency        |
| --------------------- | ---------------------------------------------------------------------------------- | -------------- |
| `get_vessel_position` | `{lat, lon, heading, sog, cog, ts}`                                                | <50ms          |
| `get_vessel_state`    | `{wind_apparent, wind_true, depth, fuel_pct, water_pct, engine_hrs, batt_soc, ts}` | <100ms         |
| `get_vessel_profile`  | `{make, model, loa, draft, air_draft, sails[], polars, tankage, owner_prefs}`      | <50ms (cached) |

### Knowledge — Pi (RAG)

| Tool                                  | Returns                          | Latency |
| ------------------------------------- | -------------------------------- | ------- |
| `search_manuals(query, k=5)`          | `[{chunk, source, page, score}]` | <300ms  |
| `query_logs(query, k=5, time_range?)` | `[{entry, date, score}]`         | <300ms  |

### Weather & routing — cloud (existing Thalassa APIs)

| Tool                                              | Returns                                       | Latency |
| ------------------------------------------------- | --------------------------------------------- | ------- |
| `get_forecast(lat, lon, hours)`                   | `{hours[], wind, sea, precip, source, model}` | <800ms  |
| `get_weather_along_route(route, departure_ts)`    | `[{waypoint, ts, wind, sea}]`                 | <1.5s   |
| `plan_route(destination, departure_ts?)`          | `{waypoints[], distance_nm, eta_hrs}`         | <500ms  |
| `find_weather_window(destination, max_wait_days)` | `[{depart_ts, score, summary}]`               | <2s     |
| `get_marine_warnings(area)`                       | `[{area, type, valid_until, text}]`           | <500ms  |

### External — cloud

| Tool                | Notes                                |
| ------------------- | ------------------------------------ |
| `web_search(query)` | Already wired in current Haiku stack |

### Design rules

1. Structured output, never prose. Tools return data; Haiku narrates.
2. Timestamps and provenance on every payload.
3. No tool calls another tool. Haiku orchestrates.
4. Tools time out at their stated budget +50%; over that they return `unavailable`.

## 6. System Prompt & Caching

The "knows your boat" feel comes from a layered, cached context structure.

### Three context tiers per request

**Tier 1 — Static profile (cache breakpoint 1):** refreshed only on vessel-profile edit

- Identity: "You are Bosun, the AI assistant for s/v Thalassa"
- Vessel: 1991 Tayana 55, Perkins 6.3544, full sail inventory, polars, tankage, draft, air-draft
- Owner: name, sailing style, cruising grounds, experience level
- Honesty rules
- Tool descriptions
- Voice/tone: terse, marine vocabulary, never patronizing

≈ 3000–5000 tokens. Cached.

**Tier 2 — Current state (cache breakpoint 2):** refreshed every 5 min or on material change

- Position, recent NMEA snapshot, conditions
- Active route if any
- Last few cruising-log entries

≈ 500–1500 tokens. Cached separately so it can refresh independently.

**Tier 3 — Live turn (no cache):**

- User message
- Tool results from current turn

### Cache structure

```
[CACHE BREAKPOINT 1 — static profile]
You are Bosun, the AI assistant for s/v Thalassa,
a 1991 Tayana 55 cutter owned by Shane Stratton...
[full spec, owner prefs, honesty rules, tool descriptions]

[CACHE BREAKPOINT 2 — current state, refresh ~5min]
Snapshot at 2026-05-02 14:23 UTC:
Position: 33.7°N 118.3°W
Heading: 285°, SOG 6.2 kt
Wind: 14 kt apparent at 60° starboard
[recent log entries, active route]

[NO CACHE — current turn]
User: What's the wind looking like for tomorrow morning's run to Catalina?
```

### Cost economics

Anthropic prompt cache: 5-min TTL, hits cost ~10% of base, writes cost 1.25x.

| Scenario                                         | Cost factor         |
| ------------------------------------------------ | ------------------- |
| Cold call (first after >5min idle)               | 1.25x — cache write |
| Warm call (within 5min)                          | 0.10x — cache hit   |
| App heartbeat keeps cache warm during active use | —                   |

After ~3 queries in a session, caching has paid for itself. After 10, it's saved >80% of the system-prompt cost. This is what makes "ask Bosun anything" actually feel free for the user.

### Refresh strategy

- Profile cache (BP1): refreshed only when vessel profile changes — could last days
- State cache (BP2): refreshed at conversation start, plus 5-min keepalive ping during active sessions
- App tells Pi "user is active" → Pi refreshes state and signals app to send a no-op heartbeat to keep cache warm

### Honesty rules baked into BP1

These are non-negotiable instructions in the static system prompt:

- "If asked about vessel state (position, conditions, fuel, etc.), always call `get_vessel_state` rather than estimating from prior context."
- "If a tool returns `unavailable`, tell the user that capability is offline rather than guessing."
- "Mark estimates explicitly: 'roughly,' 'about,' 'I'd guess.' Do not assert numbers you didn't get from a tool."
- "If you don't know the answer and no tool would help, say so. Do not invent."
- "When narrating tool output, cite the source: 'Per your masthead unit 90 seconds ago…'"

## 7. Tier Handoff UX

**Critical principle: never silently degrade.** The user must always know what brain is answering.

### Status pip

Persistent indicator at top of Thalassa, always visible. Tap → modal explains current capabilities.

### Audible cues on tier change

| Transition            | Cue                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| A → B                 | silent (orchestrator already on phone)                                                         |
| A → C (lost Pi)       | tone + "Lost connection to the boat — weather and routing still available, no logs or manuals" |
| A → D (lost internet) | tone + "Offline mode — running locally, slower, will keep answers conservative"                |
| D → A (back online)   | tone + "Back online — full Bosun"                                                              |

### Failure modes to design against

- **Flapping connectivity** (LTE coming and going): debounce 60s of stable state before announcing.
- **Partial Pi reachability** (LAN OK, internet dead): that's Tier D — Pi is reachable but Haiku isn't. Local model handles it.
- **Slow responses mistaken for hangs**: progressive feedback — "Working..." within 1s, "Still thinking..." at 5s, fail at 15s with clear reason.

### Voice persona consistency

Same name (Bosun), same ElevenLabs voice across all online tiers. In Tier D (offline), TTS falls back to Apple on-device — different timbre but same name and speaking style. The user shouldn't feel like they're talking to a different assistant offline — just one with fewer powers and a slightly different voice. The honesty layer is what makes this work: degraded Bosun says "I don't have that right now" instead of inventing.

## 8. OTA Update Path

Sealed-appliance design makes OTA load-bearing. Pattern: A/B partitions with atomic switch and watchdog rollback.

### Storage layout

```
Pi 5 NVMe:
  ├── boot         FAT, signed bootloader
  ├── rootfs-A     active OS + services
  ├── rootfs-B     update target
  ├── data         vessel profile, logs, manuals (survives updates)
  └── models       LLM, embeddings, Whisper, Piper (large, survives unless model update)
```

### Update flow

1. CI builds Pi image (OS + services + models + assets), signs with controlled key, uploads to CDN with signed manifest.
2. Pi polls manifest endpoint daily.
3. Background fetch to inactive partition. Resumable, bandwidth-capped.
4. Verify signature; preflight (free space, model integrity, schema compatibility).
5. Schedule for low-activity window. Notify Thalassa: "Update ready — applying tonight at 03:00, or tap to apply now."
6. Atomic switch: bootloader pointer → B. Reboot.
7. Watchdog: if B doesn't bring up the API within 60s, auto-revert to A and report to telemetry.
8. After 24h stable on B, A becomes next update target.

### Channels

- **stable** — default for all customers
- **beta** — opt-in via Thalassa app

This is one of the very few customer-facing toggles, scoped to the vessel (not infra), so it passes the sealed-appliance rule.

### Recommended stack

**Mender** (hosted) for v1. ~$1–3/device/month. A/B updates, rollback, fleet management built in. Skip the year of OTA infra work.

Alternatives:

- **RAUC** — open source, automotive-grade, more work, no hosted backend
- **Balena** — container-based, good fleet UI, overhead the Pi 5 doesn't need for one workload

## 9. Telemetry

Sealed-appliance principle means the Pi must phone home — customer can't crack open the box to debug.

What ships:

- Firmware version, last successful update, last failed update + reason
- Service heartbeats (Bosun API, Whisper, Piper, vector DB)
- Query metrics: count, p50/p95 latency, retrieval miss rate, tool failure rate
- Disk free, RAM pressure, thermal events, reboot count
- Crash reports with stack trace (anonymized — vessel ID only, no user data)

Endpoint: `telemetry.bosun.example/v1/ingest`. Buffered locally when offline, drained on reconnect.

## 10. RAM Budget — Pi 5 16GB

With Llama 3.2 3B (not 8B), allocate freed memory deliberately:

| Component                                  | Allocation |
| ------------------------------------------ | ---------- |
| Llama 3.2 3B (Q4)                          | ~2 GB      |
| BGE-M3 or e5-large embeddings              | ~1.5 GB    |
| Whisper-medium (vs -small)                 | ~500 MB    |
| SQLite-vec hot cache                       | ~500 MB    |
| OS + services + headroom                   | ~3 GB      |
| Available for OS file cache, query buffers | ~8.5 GB    |

(TTS is cloud-side via ElevenLabs, not resident on the Pi.)

Every byte does visible customer work.

## 11. Open Decisions

To be resolved before implementation:

1. **Tier D STT.** ElevenLabs Scribe is the chosen STT for online tiers (already shipped). Open question: in Tier D (offline), what does STT fall back to? Apple on-device SR is the obvious answer but has marine-vocab weakness. Alternative: text-only input mode in Tier D, no voice.
2. **Off-boat → Pi connectivity.** Tailscale is the obvious answer. One-time setup at first boot.
3. **ElevenLabs voice ID.** Pick the default voice that fits the brand. Don't expose voice selection to customers (sealed-appliance rule). Decide per-character cost ceiling and what happens when ElevenLabs is unreachable mid-utterance (mid-stream cutoff vs. text-only display).
4. **Vessel ID & telemetry consent flow.** GDPR-style consent at first boot — for legal cover, even though privacy is deprioritized.
5. **Pricing model.** Hardware sale + subscription, or hardware sale + included service window? Sealed appliance opens both options.

---

## Appendix A — Why the local model is 3B not 8B

Decided 2026-05-02. Llama 3.2 3B replaces 3.1 8B as the on-Pi model.

In the Haiku-as-brain architecture, the local model only fires in Tier D (offshore, no internet). In that tier, queries collapse to:

- Manual lookup → RAG does the work, LLM rephrases
- Log retrieval → structured query + thin narration
- Vessel state question → tool call + read-back

Narration over retrieval, not novel reasoning. 3B handles it at 2–3x the speed (12–17s for a 200-token answer vs. 25–40s on 8B), while freeing 3 GB for embeddings, vector cache, and bigger Whisper.

The honest counterpoint: offshore is exactly when you'd want a smarter model. Mitigation: aggressive RAG quality, structured response templates, and "I don't know — ask Haiku when you're back online" defaults baked into the offline-mode system prompt.

## Appendix B — Sealed appliance: what this rules out

For clarity, the sealed-appliance principle (decided 2026-05-02) explicitly rules out:

- Customer-facing model selection
- Customer-facing prompt editing
- Advanced settings panels for AI/infra layer
- SSH/admin access on the Pi
- Per-customer config divergence

Customer configuration is **vessel-data scoped only**: boat name, sail inventory, owner preferences, beta-channel opt-in. Everything else is shipped via OTA, identical across the fleet.
