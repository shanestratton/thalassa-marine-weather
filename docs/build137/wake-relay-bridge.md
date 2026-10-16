# Build 137 wake episode and acknowledgement bridge

Source preparation only. No Pi install, update 7 stage bundle, public migration, Edge deployment, notification or email was sent. The existing server must explicitly receive the optional relay dependency before the keeper can report any wake capability. The fixed backend packet is documented in `wake-relay.md`; it remains held.

## Pi transport and episodes

`WakeEpisodes` owns at most eight memory-only episodes. It hashes the selected physical source/reference/instance and binds each key to the exact owner/Pi/pair/arming-device/enrollment/feed, canonical rules digest, saved configuration revision, process instance and original raise clock. Unknown measurements retain the original episode/source clocks with a null value; only a fresh clear or explicit context retirement ends it. A new process starts unknown and requires postboot source measurements; it does not restore old active/proof/ACK state. Cloud context replacement retires the previous process's events.

`WakeRelay` uses only the existing canonical `pi-alarm-relay` URL, paired credential, public gateway key and Pi internet policy. Requests and streamed responses are capped at 8 KiB, have an eight-second deadline and refuse redirects. It has one owned request flow, never logs credentials/server error bodies, and rejects late replies after owner, credential, session or context changes. Capability requires the real relay's exact schema/delivery support plus registered recipient availability and a successful matching sync. Ready proof expires after 30 seconds. Probes/binds are reused for an unchanged context for at most one minute; complete syncs use the most recent owned snapshot, preserving its original clocks. The relay cannot open a Signal K or forecast connection.

Sync ACK keys apply only to the matching current context/episode. Acknowledgement suppresses that Pi episode's audible flag without claiming the measured condition cleared. Reconfiguration, source/enrollment retirement or stand-down removes readiness synchronously and sends an exact owned CAS retirement when the current credential and internet policy permit. An already accepted APNs request cannot be recalled. If retirement is uncertain or the network policy is off, fresh original-clock and current-context checks remain independent server backstops; no successful retirement is invented.

## Explicit conflict recovery

Automatic startup may resume only the identical saved profile (with a new process instance), or replace a cloud revision already proved in this process after a local configuration CAS. A foreign, retired, changed or uncertain cloud profile stays in conflict. Reads refresh only its bounded summary, never adopt its revision automatically.

The root-owned router/controller can call this exact method after the existing physical boat-LAN, app gate, raw 16 KiB JSON limit and device enrollment checks:

```ts
keeper.reviewRelay(
    {
        schema: 1,
        expectedRevision: currentLocalConfiguration.revision,
        rulesDigest: currentLocalConfiguration.rulesDigest,
        binding: currentCallingPhoneBinding,
        expectedContextRevision: displayedConflict.revision,
    },
    enrolledDevice,
);
// resolves {schema: 1, accepted: true}; return HTTP 202
```

The method independently validates exact fields, owner/Pi/pair/feed, calling phone/enrollment, current saved local revision/digest and cached physical feed, and rechecks storage. The current conflict must have been read within 30 seconds. Another currently enrolled phone of the same owner/pair/feed may request the review; the saved configuration retains its original arming phone. One explicit review authorizes one CAS attempt against exactly that cloud revision. If the remote revision changes before bind, it remains a reviewable conflict. There is no automatic resend/adoption. `accepted` is not a bind or delivery confirmation: the controller must poll fresh status and show uncertainty until the matching context is ready.

`status.push.conflict`, only while capability is zero, contains `{revision, configurationRevision, rulesDigest, feedMatches, retired, rules}`. The eight rules carry only `{preset, enabled, threshold, sourceMatches, quietHours}`. No raw sensor path, token or boat position is exposed. `push.checkedAt` carries the original cloud probe clock; repeated LAN reads never renew it. The phone parser retains the review summary only while that original clock is valid, not in the future, and at most thirty seconds old. Capability remains zero throughout review.

The fixed `POST /api/wake-rules/relay-context` route is registered as a command and uses the same app, physical boat LAN, enrollment, strict raw 16 KiB body and empty-query gates as configuration changes. The controls list the enabled saved Pi thresholds and exact quiet hours, require a fresh unchecked choice after any revision/digest/binding change, and send one CAS request from the calling phone. A 202 clears the retained Pi confirmation and waits for a fresh status. Lost, conflicting, malformed and failed responses cannot retry or assert readiness. Account, pairing, foreground and source changes fence late responses.

## Server mount seam

Add `WakeRelay` beside the existing alarm relay instances, and pass it to the current keeper as `relay`. No new environment value or endpoint is accepted:

```ts
const wakeRelay = new WakeRelay({
    fetchImpl: fetch,
    endpoint: canonicalPiAlarmRelayEndpoint(SUPABASE_ORIGIN),
    anonKey: () => SUPABASE_ANON_KEY,
    credentials: () => diaryRelayOutbox.lendAlarmCredentials(),
    ownerId: () => diaryRelayOutbox.getConfiguration().ownerId,
    internetAllowed: () => diaryRelayOutbox.getConfiguration().allowInternet,
    // Optional cache-only higherPriority callback may additionally suppress.
});
// existing new PiWakeKeeper({... , relay: wakeRelay})
```

The database independently enforces current anchor > collision/distress > depth > other wake presets; the optional Pi callback can only add suppression. Do not treat an ordinary armed anchor watch as an active anchor alarm. The keeper owns evaluation/timing and invokes its optional transport; status/sensor reads never fetch a source. Server shutdown already calls keeper.stop(), which retires local readiness.

Future stage 7 must include `src/wakeKeeper/{contract,store,catalogue,runner,relayProtocol,episodes,relay}.ts`, the root-integrated routes, `src/wakeRule/{wakeRule,wakeRuleInputs,barometerTendency,wakePiContract,syncedFrom}.ts` and their existing dependencies. Run both `sync-wake-rule --check` and `sync-signalk-protocol --check`. No stage bundle is prepared here pending radar integration.

## Phone behavior

APNs foreground/tap handling lazily refreshes wake state through bounded owner-RLS queries; notification words/data never become measured state or an ACK. A tap opens the map. Cloud reads require the current paired Pi, authoritative session, foreground native app state and normal network policy. They re-read the exact context after reading events, reject owner/digest/source/threshold/profile drift and never use a previous account's result. Account changes clear cloud cards synchronously; paired-device changes are fenced before I/O/results and clear retained cards on the bounded local timer. No background or Satellite Mode refresh is permitted.

Cards distinguish a paired-Pi wake from phone sensor alarms. Source values expire locally to unavailable, including after failed/blocked reads; retained alarms never acquire fabricated zero values or receipt timestamps. Depth sorts first among wake cards. Silencing phone audio and acknowledging this Pi episode are separate actions. An explicit ACK uses only `acknowledge_pi_wake_alarm(p_alarm_key,p_rules_digest)` after current owner/session/pair/context validation. It has an eight-second deadline, no offline outbox or automatic retry, and only a confirmed affected count of one reports saved. Old replies cannot confirm a new account's action. Failed/unavailable ACK retains the alarm.

Portable wire interfaces/constants live in app-owned `utils/wakePiContract.ts` and are mirrored by the existing allowlisted wake-rule script. The Pi implementation retains Node crypto/validation and re-exports the mirrored types; web uploads need no `pi-cache` files or Node dependencies. A real isolated TypeScript compile of the canonical wire/rule uses DOM/ES libraries and `types: []`, without repository/Pi files.

Depth cards explicitly distinguish measured below-keel reference, measured transducer offset and conservative full-draft allowance. Cloud rows require one of these depth references and reject a depth basis on another preset. Local and cloud cards retain the basis when their measured value becomes unavailable; a stale local reading is never copied into an unknown card as a current number. Separate focused tests and actual Chrome/WebKit enlarged-text checks cover all three wordings at 300/375 pixels.

## Evidence

The held backend bytes passed 59 Deno tests and 49 PGlite SQL behavior checks. Independent actual PostgreSQL 17.6 run `38916795961` passed 17 checks, including sixteen concurrent alarm transactions giving exactly four queued pushes, two competing binds giving one CAS winner, and old sync/retire/queued-delivery refusal. No product database or notification was used.

Bridge tests exercise actual keeper-to-transport episode/ACK flow, JSONB key-order parity, original clocks, source gaps, identity retirement, explicit cross-phone review and changed-cloud CAS refusal. App tests cover fixed RPC, no auto-ACK/retry, owner/pair/session/timeout fences, context revalidation, stale/null semantics, checked mirrors and the isolated upload compile. Recovery adds 39 app watch/wire checks, 14 actual HTTP/transport checks and the three actual route inventory/command/read checks. Actual Chrome/WebKit recovery controls pass at 300/375 pixels and 130% font, including keyboard action, checkbox retirement, exact threshold direction and quiet hours, retained uncertainty and zero external requests. Alarm-card tests separately cover both sizes and all three depth references. The Windows symlink security case remains explicitly skipped locally and must retain its Unix assertion in Linux CI. End-to-end backend deployment, Pi installation and physical-device APNs behavior remain unproved and must precede a release claim.
