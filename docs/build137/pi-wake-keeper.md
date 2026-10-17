# Build 137 Pi wake keeper — core checkpoint

This checkpoint prepares the update 7 keeper. It does not install it, expose a public backend, send push notifications or claim locked-phone delivery. All eight presets begin OFF and physically unselected. Existing AIS, anchor and underway alarms are untouched.

## Ownership and source

`PiWakeKeeper` accepts only the existing trusted pairing identity, current `EncDeviceStore`, private `WakeKeeperStore` and authenticated **cache-only** `selfDocument` callback. It has no fetch client, source URL, Signal K path input or transport credential. Start its owned one-second loop with `await keeper.start()`; call `keeper.stop()` during shutdown. `start(false)` and `tick()` are deterministic test seams.

The server supplies `{ownerId, piDeviceId, pairingId}`. Owner and Pi IDs must be UUIDs; `pairingId` is `wakePairingId(ownerId, piDeviceId, relayId)` using the existing **public relay identifier**, never its token. If no verified current pairing exists, return null. A caller cannot supply or replace that identity.

The opaque feed is `pi:<PiUUID>:<24 lowercase hex SHA256(verified Signal K self UUID)>`. The raw vessel UUID is not returned. A binding adds the actual enrolled phone's UUID and `wakeEnrollmentRevision(device)` (SHA256 of its ID and original enrollment time). Missing identity, revoked/replaced enrollment, changed pairing or changed verified vessel retires old evaluation, catalogue, history and proof. Temporary unreadable enrollment is unknown, not an alarm-clear measurement.

The owned loop reloads the bounded atomic configuration, reads only the shared cache, rechecks its identity/enrollment after asynchronous work and ignores late work across mutations. Endpoint polling never opens a source connection. Paused/missing sources remain unknown. Restart never restores an active alarm or green keeper proof; each enabled input must have a fresh original measurement after this loop's start.

## Wire contract

Types and strict mutation parsers are in `pi-cache/src/wakeKeeper/contract.ts`. A phone may import its **types only**. Runtime canonicalization belongs to the shared `utils/wakeRule.ts` helper:

```
wakeRulesCanonical(rules, draftM)
// JSON.stringify([1, draftM, default-preset-order wakeRuleKey(rule) values])
rulesDigest = SHA256(UTF8(canonical)) // lowercase 64 hex
```

The helper rejects duplicate/missing presets and invalid draft. The mutation parser additionally rejects unknown fields, invalid rules/selection, substituted feed, invalid quiet hours and digest mismatch. Rules are ordered consistently on both sides; null engine/battery thresholds remain null until explicitly set. Draft is null or a confirmed number greater than 0 and at most 20 metres.

Mount at `/api/wake-rules` behind `requireAppApi`:

| Method/path             | Contract                                                                      |
| ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| GET `/status`           | `WakeKeeperStatus`; no query parameters                                       |
| GET `/sensors`          | `WakeSensors`; optional `draftM` confirmed metres, otherwise saved draft/null |
| POST `/configuration`   | `{schema:1,expectedRevision:UUID                                              | null,binding,draftM,rulesDigest,rules}`→`{schema:1,configuration}` |
| DELETE `/configuration` | `{schema:1,expectedRevision:UUID                                              | null,binding,rulesDigest}`→`{schema:1,cleared:true}`               |

Every route independently checks the socket peer against the boat LAN (no gateway, loopback, Pi address or tailnet; forwarded headers confer nothing) and the existing `X-Thalassa-Chart-Device` enrollment token. Observe mode does not exempt any route. No raw source document, caller path or upstream URL is accepted. Responses carry `Cache-Control: no-store` and `Pragma: no-cache`.

**Body parser integration:** let this prefix bypass the server's earlier 64 KiB JSON parser. The router installs strict JSON parsing with a **16,384-byte wire limit**, compression disabled, after its LAN/enrollment checks. It rejects already-parsed mutation bodies. Chunked whitespace is also counted; a semantically small object cannot evade the wire cap. Keep the earlier global parser for all other prefixes.

Configuration is one private 0600 atomic file under `CACHE_DIR/wake-keeper` (0700), using an exclusive writer lock, fsync/rename and revision CAS. Expected revisions are reviewable conflicts (HTTP409); the router never auto-overwrites them. A changed trusted pairing logically starts with no configuration. An offline owner can explicitly stand down its exact saved binding; enabling requires a current qualified catalogue selection. Error responses use fixed text, never raw exceptions. Corrupt/oversized/symlinked storage fails closed and is not silently replaced.

An uncertain lock is never automatically deleted by age/PID. A read-then-unlink stale-lock recovery can race a newer writer. If a process crashes while saving, subsequent changes answer busy; the operator must first stop/quiesce all keeper writers, inspect the private lock and remove it explicitly. Reading the previously atomic configuration remains possible. This recovery limitation must be included in the later installer/runbook; no automatic unsafe recovery is hidden here.

Another currently enrolled phone of this same owner can review, explicitly replace or clear the saved rules. Status/sensor binding identifies the calling phone; saved configuration/proof binding identifies the arming phone. A clear sends the **caller's current binding** plus the saved revision/digest and requires the same owner/Pi/pair/feed. Phone identity/enrollment is verified independently; no cross-owner or cross-feed relaxation applies. A failed CAS preserves existing active/confirmation/history state and withdraws proof until a fresh owned evaluation; it never clears an alarm merely because a save was refused.

Sensors return at most 32 explicit source options. Each has `{preset,selection,label,measuredAt,reading}` with the shared `WakeReading` or null. Clocks and dependent-clock minima are original measurements; no gauge/receipt clock substitutes. The explicit draft query affects only the conservative fixed depth adapter. Engine options require one identified engine; battery banks are explicit and capped at 16. No apparent wind, unknown pressure unit, forecast pressure or ambiguous engine aggregate becomes a measured source.

Pressure offers a real current station sensor while its history is warming, with `reading:null`. History is memory-only, one latest actual sample per minute, at most 2048 samples/four hours and scoped to feed plus physical pressure source. It retains the current leaf and uses the existing observed-tendency algorithm; no made-up baseline or restamped samples. The wire reports `{state:'warming'|'ready'|'unavailable',sampleCount,spanMs}`.

Status separates saved configuration, actual loop state, unknown inputs and fresh proof. Proof includes owner/feed/digest plus exact binding, revision and process instance. It expires at the earlier of 30 seconds or any enabled input's original-clock freshness deadline, and refuses backwards wall time. Unknown input neither fires nor clears an already-active rule. Source retirement/reconfiguration explicitly retires that profile. Quiet hours affect delivery only; source duration confirmation uses strictly advancing measurements. The first checkpoint always reports `push:{state:'unavailable',capability:0}`.

## Server integration (root-owned)

Create one store/keeper from the existing cache directory, `EncDeviceStore`, trusted pairing callback and shared authenticated reader callback. Start it once, mount `createWakeRuleRoutes({keeper,devices})` behind the existing app gate, and stop it with the other owned services. No new environment variable or external connection is required. Register these exact four method/path rows in the Pi command table; reads are read-only and both configuration methods are enrolled LAN writes. Preserve the router's stronger independent gate.

Stage files: `src/wakeKeeper/{contract,store,catalogue,runner}.ts`, `src/routes/wakeRules.ts`, and existing pure mirror `src/wakeRule/{wakeRule,wakeRuleInputs,barometerTendency}.ts` plus its provenance JSON. Existing `encDevices.ts` and portable `signalkProtocol.ts` remain dependencies. No server, installer, telemetry scalar or route-writing change is included here.

## Validation and remaining release work

Local tests use actual private files and Express HTTP, synthetic clocks/identities and cache documents. They exercise raw body bounds, mandatory gates, strict CAS, races/rollback, corrupted storage, source units, original clocks, restart, stale alarms, physical feed changes and multi-hour measured pressure. The real symlink security case is explicitly skipped when Windows denies symlink creation; its unchanged Unix assertion must pass in Linux CI. Pi TypeScript and scoped ESLint pass.

Locked-phone wake remains unfinished until a separately reviewed, fixed-family relay capability, DB checks, send-push policy, durable episode/ack semantics and higher-priority alarm suppression are implemented and deployed. Existing `pi-alarm-relay` accepts only AIS/underway; update number alone cannot prove wake push. No generic Signal K message passthrough is proposed. Preserve anchor > collision/distress > depth > other wake presets, independent higher-priority budgets/leases, and server-generated bounded preset text. Root reviews backend source/migration and isolated proof before any public activation.
