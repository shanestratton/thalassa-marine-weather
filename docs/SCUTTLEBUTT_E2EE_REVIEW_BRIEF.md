# Scuttlebutt private message E2EE review brief

Updated 6 October 2026 for an independent security assessor and Thalassa's owner. This brief requests review of a proposed native, text-only private-message pilot using unchanged vodozemac 0.11.0 Olm v1. It supports engagement scoping now; the implementation selected for assessment must be frozen and identified before code review. Production activation, distribution and security claims are not authorized by this research work.

The installed isolated Research candidate is `0cde17c21c68e0bba9dff6fe07eef41b5dfad00c` on `codex/scuttlebutt-e2ee-foundation`. It passed 1,069 tests across 15 isolated suites, focused strict TypeScript, named lint, formatting and separate web/unsigned physical-iOS builds before local signing and in-place installation on both devices. Research entitlements match the previous candidate, and identical 11-file metadata inventories were retained across each update. Normal Thalassa's compared bundle/version/build metadata is unchanged. Launch requests succeeded; the owner subsequently reported signing into both. These are fixture/build/update checks and an owner report; the later bounded new-candidate message observations below are separate, not a full acceptance pass or an audit.

On the preceding candidate `4005833a0e3ce208ca8f7d8394ced9876a89184b`, whose local checks passed 979 tests, the owner reported opening/reply messages, history restoration after each independent restart, successors delivered both ways and offline catch-up with a single displayed copy after repeat scans in both directions. One iPhone capture shows an accepted outgoing row and an incoming row committed to native history. That supplies partial D01/D02 and bounded catch-up/rescan evidence, not complete correlated native/relay ciphertext receipts, exact pending-send continuity, durable generation/key equality or a full device matrix. Those observations cannot be transferred automatically to the newly installed candidate. Independent PostgreSQL, lifecycle/recovery, dependency and external review gates remain open. Neither candidate is approved for release; the authoritative execution record is [the checkpoint](SCUTTLEBUTT_E2EE_CHECKPOINT.md). Freeze the assessment commit separately and review any subsequent diff.

The new candidate adds explicit prepare-without-upload and exact saved-envelope
hash projection, with no provider or persistence migration. Owner-supplied iPhone
captures before and after the instructed restart show the same pending ID,
timestamp and full envelope hash; a later iPad capture shows that ID/hash received
into native history with unresolved 0. Retry success and once-only peer display
are owner-reported; a repeat scan capture shows stored 0 and duplicates 6.
Process termination/retry were not independently instrumented and no sender
terminal acceptance or direct relay receipt was inspected. The mirrored iPad
check now has matching pending before/after and iPhone-received ID/hash captures,
a sender relay-acceptance notice without its target row, and owner-confirmed
once-only display. The owner resolved an initial message-identification concern
by confirming target prefix `f96e0b8b`; the checkpoint retains that sequence.
The subsequent isolated native regression passed all five new hash-equality
probe assertions within 288 native bridge assertions, plus all prior native
fixture groups and nine simulator phases. The full Research suite passed 1,069
tests in 15 suites again; the separate overlapping app pilot suite passed 190
tests in seven suites and focused TypeScript passed. The committed
[regression manifest](../experiments/scuttlebutt-e2ee/review/regression-2026-10-05.json)
records clean source commit `9bf49af4`, exact source/cache/receipt hashes and
evidence categories. Scoped bridge replies are synthetic and bridge reopen is
within one process; the separate four-message HTTPS/local-SQL exchange exercises
the legacy native client across processes. Neither is a controlled crash-boundary
test or a new physical/hosted exchange. The disposable simulator and its CA were
removed; no human devices or hosted services changed.
The 6 October direct-native crash regression subsequently passed 18 cases and
731 assertions at before-UPDATE, after-UPDATE/pre-COMMIT and post-COMMIT boundaries
for prepare, opening/session receive, accepted/rejected decisions and logout.
Exact parked-process SIGKILL dispatch and disappearance were correlated; parent
wait status, interruption inside COMMIT and physical-device behavior are outside
that evidence. Recovery checked complete snapshots, exact ciphertext, real
provider account/prekey controls, successors and logout fencing. The same native
subset typechecked without the test flag, and Research tests/typecheck passed
again. All fixtures and the disposable simulator were removed. See the
[crash manifest](../experiments/scuttlebutt-e2ee/review/crash-regression-2026-10-06.json)
for the exact source/artifact hashes and initial prebuild refusal. These direct
coordinator fixtures do not establish actual Auth/facade/Capacitor cutover or
server-authenticated receipts. Cached-provider provenance, the full physical
matrix, recovery policy and independent review remain release gates. The checkpoint retains
the initial screen-fixture failures, their correction, the corrected Mac launch-command
failure and the exact build/signing/update receipts. No private data contents
were inspected, no reset or re-enrollment occurred, and no primary build/sync,
production or server changes accompanied the update.

## Current integration candidate

The active development branch is `codex/scuttlebutt-e2ee-integration-2026-10-06`,
rebased onto master `7e0b27a4` without rewriting the published foundation branch.
The new ordinary text-only native port shares the existing Research Auth host,
requires a complete confirmed native peer snapshot, and preserves original-owner
publication checks. Its explicit screen performs one bounded scan on Refresh,
retains authenticated local history with a clear notice when the scan refuses,
and retries exact native pending IDs without caller plaintext or replacement
ciphertext. Unknown content/time and terminal decisions remain honest. No new
code was installed on the human devices.

The [integration manifest](../experiments/scuttlebutt-e2ee/review/private-message-integration-2026-10-06.json)
records 363 new native adapter fixture assertions, ten completed simulator phases,
1,193 Research tests in 18 suites, 240 overlapping app-pilot tests in eight suites,
focused strict TypeScript and the separate web/unsigned physical-iOS build. Native
adapter fixtures use real provider/Keychain/sealed storage with synthetic Auth
and relay; the four-message real HTTPS/local-SQL exchange remains a separate
legacy-client path. Five privacy-cover tests inspect Swift source only. Native
cover compilation is not actual app-switcher/device-snapshot evidence. Retained
compiler, harness-deadline and TypeScript failures remain in the manifest.

The later main-app extraction separates the native hook/page/literal view from
the lazy legacy page. Explicit selected-native failures never load legacy. Its
26 import-isolation cases passed inside 285 pilot tests in 11 suites; 1,193
Research tests, focused types, named lint and isolated full-app Vite compilation
also passed. These are overlapping fixture/compile results, not new device or
encryption evidence. The [import-isolation manifest](../experiments/scuttlebutt-e2ee/review/import-isolation-2026-10-06.json)
preserves exact checks, source/build hashes and the initially failed legacy fixture
run. The legacy component body remains byte-for-byte unchanged. Native inputs
still match the previous proof and were not rebuilt by this extraction.

The later process-local client cutover guards cover ChatService private operations,
Guardian hails, old queue replay, unread polling and recognized private foreground
push/taps. Explicit native selection denies legacy for that account for the process
lifetime; aggregate private operations are conservatively denied after any latch.
Owned request cancellation and the actual Supabase fetch-dispatch gate close the
SDK token-wait gap. Native private SDK traffic uses Capacitor's preserved browser
fetch directly, because patched HTTP ignores abort signals; missing transport
refuses without fallback. Physical browser/CORS/lock/network evidence is required.
The [client cutover manifest](../experiments/scuttlebutt-e2ee/review/client-cutover-2026-10-06.json)
records 576 fixture tests in 29 suites, strict types, named lint and isolated app
compilation, plus corrections and exact source hashes. No native/provider/hosted
rerun or human-device update accompanied that slice.

This is not durable server enforcement. A cold process can still start in legacy
mode, old clients can still submit, existing server push previews remain plaintext,
and dispatched writes/APNs cannot be recalled. Old queued plaintext is held, not
encrypted or deleted; mixed public queue maintenance may rewrite its container
without changing private object fields. No shipping switch or security claim is
authorized by these local cancellation results.
The fixed 16-outgoing/16-incoming budgets,
scan-from-zero cursor and immutable one-device/prekey registration are research
limits, not production retention, renewal or recovery policies. No review or
release gate is completed by this integration slice.

## User problem and intended pilot

Private DM content should be readable only at the intended endpoints, with ciphertext and public device material relayed by the service. An uncertain send must retry the same committed ciphertext; authentication, identity, storage or delivery failures must stop protected messaging visibly. Existing server-readable history must retain its accurate status.

The proposed first pilot enforces one registered device per account and text-only DMs. The current coordinator is narrower still: one peer, conversation and session per store. Multi-peer support must have its own implementation and evidence before the pilot admits it. Attachments, groups, browser encryption and multi-device fanout are outside this initial scope. Unsupported clients must show private messaging as unavailable without plaintext fallback.

Routing metadata, timing and approximate sizes remain visible to the relay. Protection against a compromised endpoint, injected application code, recipient disclosure or traffic analysis is not promised. First-use trust and fingerprint verification must be described separately; a self-signed bundle and TLS do not independently prove that a first peer key belongs to the intended person.

## Completed evidence and its limits

The earlier baseline reports 20 real-provider Rust boundary tests, 211 native Auth fixture assertions and 474 TypeScript tests. The later slice passed 111 screen/SDK tests and a focused TypeScript check, then ran nine simulator process phases exchanging four actual native encrypted messages over ordinary URLSession HTTPS into on-disk SQL. That run passed 266 Auth fixture assertions and 181 account-directory fixture assertions, including competing native logout/selection races and pre-SDK credential reservations. It exercised exact retry after a lost response, poisoned inbox recovery and SQL reopen. These counts are separate suites and evidence categories, not numbers of live encrypted exchanges. Auth response fixtures do not prove live Supabase sign-in. A fresh Cargo metadata attempt timed out; cached provider binaries were used and no new Rust test pass is claimed.

The 3 October frozen native rerun passed four actual encrypted messages across nine simulator phases, 266 Auth and 247 directory/facade fixture assertions. The exact sources compiled/linked for physical iOS, unsigned and never installed or executed. Both logical clients still shared one simulator; the screen and SDK event bridge passed injected mocks only. Focused relay tests passed 568 cases; screen/SDK fixtures passed 111. The actual hosted Deno entrypoint and focused pilot TypeScript check passed.

Separately, the isolated Supabase host passed real Auth, signed device registration, reciprocal prekey claims, exact retries and bidirectional relay/inbox checks with disposable actors. Privilege readbacks confirmed the restricted edge login, signed-RPC-only gateway, closed table access and enabled RLS. Those payloads were synthetic one-byte ciphertext, not Olm messages or human-device registrations. Sequential hosted transactions do not prove adversarial concurrency, availability or native-to-hosted encrypted exchange. The two-connection pilot budget is deliberately bounded, not a production capacity policy.

At that earlier checkpoint, the separate account-authentication plugin, real SDK wiring and generated Capacitor project compiled and linked unsigned for physical iOS. Screen/SDK fixtures passed 151 tests, including 40 auth-only cases; they were not rerun for the later native-only changes. No plugin login or messaging had then executed on a physical device. The host pairs a device-only Keychain locator with protected directory files and refuses partial state; both locator and files absent is treated as first installation, not proven detection of every reinstall/restore. The current physical observations are summarized above; no shipping private-message port, full device-matrix pass, production migration or independent security audit is claimed. Internal agent review is development evidence, not an independent external audit.

The later native-only slice passed 65 messaging-authority and 103 pairing/history assertions using fixture Auth, real provider/Keychain/sealed storage and synthetic trusted terminal decisions. Closed synchronous commands hold native account authority through store mutation/commit; canonical fingerprints pin all public keys, including the signing key. New outgoing text/time is sealed with the ratchet and ciphertext, with exact retries and current-generation history. The nine-phase legacy research exchange also passed; it does not exercise the new facade for networking. At that earlier checkpoint, messaging commands remained unwired to Capacitor/hosted relay. Grouped thread order, absent incoming times, bounded historical capacity and cold-launch generation quarantine still need a usable history policy, scoped enrollment/claim integration, plugin wiring and physical evidence. See the checkpoint for receipts and failed attempts.

The scoped native relay slice passed 81 additional assertions with synthetic Auth/relay responses and real provider, Directory, facade, Keychain and sealed state. Wire preparation and exact receipt/inbox commits use the original native snapshot across await; no authority locks cross the network. It tests lost/malformed replies, independently checked request signatures, terminal idempotency, stale refresh/logout completion, cancellation and complete inbox structural prevalidation with per-row commits. The nine-phase HTTPS/local-SQL exchange and prior native suites passed again, and all 25 exact sources compiled unsigned for physical iOS without device execution. A fixture-envelope failure and its corrected rerun are both retained in the checkpoint. These results do not complete the private-message port or any release gate.

The 4 October native control-plane changes passed 188 scoped-enrollment assertions with synthetic Auth/relay and real provider/Directory/facade/Keychain/sealed SQLite. They add scoped registration acknowledgement and complete sealed-pin peer claims, with stable reservation IDs, exact retries and original-snapshot completion. The saved signed bundle is bound to its owner/peer generations and confirmed fingerprint; monotonic elapsed time floors in-flight expiry checks. A backdated native-only start seam with a positive control is not actual system-clock rollback evidence. These are historical facts, not current server permission. Cached expiry labels depend on device wall time; they are not trusted-time evidence across restart. At that earlier checkpoint, prepare/send/inbox still lacked readiness gates. The plugin was auth-only at that earlier checkpoint.

The later 4 October slice passed 709 native readiness assertions with synthetic Auth/policy/receipt transport and real provider/Directory/facade/Keychain/sealed state. Closed messaging now requires acknowledged registration, a complete confirmed peer pin and a memory-only current-policy permit, with an unexpired full-pin claim for initial outgoing sessions. Native signs the policy request; HTTPS authenticates its response, which is not independently signed. The exact derived permit expires five seconds after its original monotonic start and is rechecked at mutation/commit and result publication; refresh invalidates prior permission. An exact authenticated terminal refusal alone may settle through the original owner-only lease after peer/policy changes, never acceptance or replacement Auth. Fixture races include positive controls and independent native-request signature verification. Snapshot equality demonstrates no durable mutation, not zero cryptographic computation. Review the freshness/latency policy and its separation from SQL's authoritative current-action checks.

That rerun passed all nine simulator phases, four legacy-client native encrypted HTTPS/local-SQL messages and the existing native suites; 28 exact sources compiled unsigned for physical iOS. The separate auth-only app compiled 16 sources, with 13 shared runtime hashes matching the simulator receipt. Focused TypeScript tests passed 592 cases and the strict relay typecheck passed; 31 PGlite SQL scenario groups include current policy on exact replay without consuming nonce capacity. The new scoped policy path had not exchanged against local SQL or the hosted relay, and its SQL/gateway changes were not deployed at that checkpoint. No fresh provider build, screen/SDK rerun, device installation/execution, live native login, primary sync or external audit occurred. At that checkpoint, concrete messaging plugin/screens were still missing. Native controls, physical exchange and independent review remain release gates. See the checkpoint for receipts, two failed harness compile attempts and evidence limits.

The enrollment-retry slice seals exact first registration bytes and separates a stable prekey-claim reservation from expiring outer request IDs. A fresh nine-phase simulator rerun passed 40 enrollment-intent assertions, 266 Auth and 247 directory/facade assertions, plus four actual encrypted messages over local HTTPS/SQL. This exercises native fixture code, not the Capacitor UI or native-to-hosted delivery.

The current one-peer research bridge shares the exact native Auth host/facade,
derives all messaging authority natively and accepts only bounded public inputs
plus the expected Auth binding. Result publication rechecks the original
account/full-peer snapshot; fact-only acceptance/inbox outputs do not renew
policy permission. JavaScript checks exact DTO shapes/binding and view revision
after every awaited phase. Its private scheduling barrier prevents a hidden
unfinished preparation from admitting replacement ciphertext. Pending retries
reconcile the same committed native ID; plaintext rendering uses text nodes.
The checkpoint records executed counts and frozen artifact hashes, including
the first failed source-tripwire fixture and its corrected rerun.

This integration is isolated, not a shipping private-message port. The later
4 October hosted policy update and Edge revision 26 passed preservation checks
and four negative HTTP canaries; at that checkpoint no positive signed policy or
native-to-hosted exchange had executed. Later owner-operated Capacitor exchange
and restart observations are summarized above; external review remains unrun.
A later bounded continuation permits only an exact sealed,
selected and active owner after fresh same-account Auth. It restores neither
bearers nor policy; explicit logout still quarantines the old generation.
Do not infer physical restart or usable recovery from close/reopen fixtures. Native
block/revoke controls, device/prekey lifecycle, sync/retention and app cutover
need separate implementation and assessment.

The earlier 4 October signing slice passed 811 focused tests, including 37 pure
signing validator/command fixtures. The owner approved a separate development
profile for exactly the selected endpoints. Strict local signatures and four
minimal research-only entitlements passed on a fresh private app copy; all
unsigned inputs remained unchanged. Both devices accepted installation and
process launch. The first certificate-extraction failure and initial launch
argument failures are retained beside corrected receipts. CMS decoding and
local/cached verification of the selected development certificate do not prove
independent Apple CMS profile authority or fresh revocation status. Device
installation is separate platform acceptance, not a cryptographic audit or a
passed messaging test. Normal Thalassa's bundle/version/build metadata remained
unchanged; its private files were not inspected. No D01–D17 case is passed by
these operations.

The subsequent send-setup UI slice passed 874 isolated tests, named lint and the
strict pilot TypeScript check. New sends require fresh native setup facts before
reserving an attempt; refusal preserves the draft, and responder receiving is
independent of that UI hint. No native crypto/server implementation changed.
A fresh web/native candidate was signed and updated over the existing research
app on both endpoints, preserving normal Thalassa's compared metadata. Both new
launch requests were refused while the devices were locked. At that checkpoint,
native login, human pairing and physical exchange still needed evidence. Read-only pilot
checks confirmed unused human device slots and the existing deployed policy;
there was no server deployment or data reset. See the checkpoint for receipts.

The earlier restart-continuity rerun passed 795 focused tests across 12 suites, 282 native
directory/facade assertions and 283 native bridge assertions, with all prior
native suites and nine simulator phases passing. New continuity cases close and
reopen endpoints within one process using real provider/Keychain/sealed state
and synthetic Auth/relay responses; they preserve pending ciphertext and decrypt
successor messages both ways. All 30 exact Swift sources compiled unsigned for
physical iOS, and the separate 17-source Capacitor app compiled with matching
shared hashes. These are not force-kill, power-loss, live hosted or physical
exchange results. That checkpoint had 21 pure signing-validator cases and no
matching profile or signed artifact; the later signing/installation slice above
supersedes those blocks. Inspect the checkpoint's precise receipts
and remaining Keychain/install, account/device and prekey recovery gaps.

## Review scope

| Boundary                             | Questions the assessor should answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider and dependency provenance   | Confirm the pinned vodozemac 0.11.0 source, archive, features and Olm v1 session policy reach the built artifact unchanged. Review parameter and API use, non-contributory keys, malformed inputs, error classification and the Olm v1 64-bit message MAC trade-off with rate and abuse controls. Assess the narrow Rust, UniFFI and Swift boundary rather than assuming an upstream audit covers it.                                                                                                  |
| App SDK and native Auth authority    | Review trusted project configuration, fresh `/auth/v1/user` verification, canonical native account/device selection, initial provisioning and SDK token/event delivery. Test refresh, expiry, suspension, logout, account switch, stale callbacks and competing native authorities. Bearer claims and JavaScript labels must not select a native scope. Review the bounded verified lease and distinguish local deactivation from remote token revocation.                                             |
| Account directory and sealed storage | Review directory selection, file names, installation namespace, Keychain accessibility, nonsynchronizing device-only keys, AES-GCM associated data, pickle key separation and state versioning. Cover missing/orphaned keys or files, two writers, commit failure, failed rollback, full-database restore, backup, reinstall and install persistence. Existing snapshot authentication/CAS does not establish whole-database rollback detection.                                                       |
| Peer trust and device lifecycle      | Review account binding of signed bundles, first-use trust, optional fingerprint verification, immutable pins and changes or revocations. Cover device replacement, one-device enforcement, expiry, prekey claims/consumption/replenishment, abandoned reservations and exhaustion. The current relay permits one immutable lifetime device and one prekey; recovery, rotation and replenishment are absent.                                                                                            |
| Relay SQL and operational host       | Review gateway credential/signature checks, canonical requests, expiry/replay ledgers, exact receipts, `SECURITY DEFINER` ownership checks, RLS, roles, grants, search paths and the trusted actor argument. Test independent PostgreSQL connections, transaction/lock ordering, timeouts after commitment and distributed gateways. Review TLS termination, duplicate headers, deadlines, quotas and abuse controls. PGlite's single connection cannot prove production concurrency.                  |
| Inbox and durable messaging          | Review atomic ratchet/outbox and receive/history/dedup commits, exact ciphertext retries, context binding, stale generations and terminal tombstones. Test out-of-order messages, legitimate gaps, structural poison, unresolved recovery and conflicts. Resolve blocked-sender cursor reconciliation, per-peer state, retention and capacity; bounded rescans and no-eviction research limits are not a production sync policy.                                                                       |
| Native bridge and content exposure   | Trace all returned plaintext, native errors, JavaScript state, SQLite/WAL/SHM/temporary files, Preferences, caches, backups, app-switcher snapshots, crash reports, telemetry, logs and notifications. Private keys and pickles must never cross into JavaScript or relay storage. Review the SDK's existing token acquisition and handoff; native operations must not return or persist bearers. Review intended plaintext display/history access separately from claims about secure memory erasure. |
| App cutover and fail closed behavior | Trace ordinary text, pin drops, recipe shares, Guardian hails, optimistic reconciliation, thread/inbox/realtime and push paths. Cover the readable legacy offline queue and direct DM inserts. Pilot failure must never enter the old send path; old clients and queued plaintext must have an explicit cutover policy. Badges must distinguish encrypted, verified and unavailable.                                                                                                                   |
| Recovery and rollout                 | Review loss/reinstall/account recovery, old snapshot migration, historical ciphertext and existing plaintext history. Define what remains unrecoverable before user onboarding. Review isolated pilot gating, deployment rollback, incident response, generic pushes and safe disablement while pending ciphertext exists. No migration may silently recreate identity or relabel old history.                                                                                                         |

## Materials to provide

The final review packet should contain a named commit plus dirty-tree status, threat model, protocol/state schemas, native plugin API, auth and trust state transitions, actual production-host configuration proposed for deployment, dependency lockfiles/notices, build commands and artifact/source hashes. Provide test-only accounts and a segregated relay; live credentials and existing private messages do not belong in a shared review document.

Use the repository sources below to reproduce the completed baseline and identify where the integrated candidate differs:

- [Provider manifest and lock](../experiments/scuttlebutt-e2ee/vodozemac-probe/README.md), [provider pin](../experiments/scuttlebutt-e2ee/vodozemac-pin.json) and [native bridge pin](../experiments/scuttlebutt-e2ee/vodozemac-native-pin.json).
- [Native provider and licence inventory](../experiments/scuttlebutt-e2ee/vodozemac-native/README.md), `VodozemacSealedStore.swift`, `VodozemacDmCoordinator.swift`, `VodozemacDmFrame.swift`, `VodozemacSupabaseAuth.swift` and `VodozemacAuthSession.swift` in `experiments/scuttlebutt-e2ee/`.
- [Relay contract and reproduction](../experiments/scuttlebutt-e2ee/relay/README.md), including `relay.sql`, `signedGateway.ts`, `supabaseAuth.ts`, `hostedGateway.ts`, `nativeExchangeProof.mjs`, `hosted/` deployment/fixture runners and their source/artifact receipts.
- [Research adapter](../experiments/scuttlebutt-e2ee/bridge-native/ResearchMessagingAdapter.swift), [plugin](../experiments/scuttlebutt-e2ee/bridge-native/ScuttlebuttResearchAuthPlugin.swift), [web controller and literal renderer](../experiments/scuttlebutt-e2ee/bridge-web/messaging.ts), native bridge fixtures and `tests/E2eePilotBridgeMessaging.test.ts`. These are separate from the shipping private-message port; include both native and JavaScript publication fences in the assessment.
- `services/chat/e2ee/directMessageEnvelope.ts`, `encryptedDmDelivery.ts`, their seven research suites and the actual integrated app diff when ready.
- [Physical device test plan](SCUTTLEBUTT_E2EE_DEVICE_TEST_PLAN.md), with completed run receipts and explicit failed, blocked and unrun cases.
- [5 October regression manifest](../experiments/scuttlebutt-e2ee/review/regression-2026-10-05.json), with exact source and cached-input hashes and separately labelled fixture, local HTTPS/SQL and mocked-screen results. It contains no credentials or private message content. Local temporary receipts are references, not a portable complete audit packet; reproduce or preserve them in the assessor's restricted environment.
- [6 October crash regression manifest](../experiments/scuttlebutt-e2ee/review/crash-regression-2026-10-06.json) and [local runner](../experiments/scuttlebutt-e2ee/sealedCrashProof.mjs), covering 18 direct-provider/store process-death cases with the test-only callback and sealed baseline ledger. Keys, pickles, plaintext baselines and original envelopes never enter its public receipts.
- [6 October private-message integration manifest](../experiments/scuttlebutt-e2ee/review/private-message-integration-2026-10-06.json), [native adapter](../experiments/scuttlebutt-e2ee/bridge-native/ResearchPrivateMessageAdapter.swift), [port](../experiments/scuttlebutt-e2ee/bridge-web/privateMessagePort.ts) and [literal view](../experiments/scuttlebutt-e2ee/bridge-web/privateMessageView.ts). Review native issuance/publication, JS reentrancy/alias fences, exact-ID recovery, explicit receive refresh and the inactive-scene cover separately from the older device candidate.

Retain machine-readable run receipts, sanitized assertion summaries and reproducible failure instructions. Record each evidence item's exact source/build hash and fixture/live/device category. The simulator cleanup and recorded hashes establish only the stated run; they do not independently attest binary provenance. Never replace a failed attempt with a later pass without retaining its outcome and understood limits.

## Dependency and upstream review limits

The provider pin declares Apache-2.0; the bridge's UniFFI 0.29.4 runtime/tooling declares MPL-2.0. The native metadata inventory covers 102 runtime-resolution packages and 131 including host tooling, not a shipped-binary SBOM or legal clearance. Generated Swift/header treatment, applicable source availability and notices need separate qualified licence review before distribution. Adopting this dependency does not change Thalassa's source licence.

The pinned [Olm session configuration](https://github.com/matrix-org/vodozemac/blob/0.11.0/src/olm/session_config.rs) is relevant to the protocol review. The [Matrix security team's February 2026 analysis](https://matrix.org/blog/2026/02/analysis-of-reported-issues-in-vodozemac/) describes authenticated key-distribution assumptions and the truncated-MAC trade-off. Its conclusions concern Matrix's model; the assessor must evaluate Thalassa's separate device directory and Supabase integration. An audited upstream library is not an audited Thalassa release. This design makes no Triple Ratchet or post-quantum claim.

## External assessor shortlist

Official pages were checked on 2 October 2026. These are evidence-backed candidates for scoping discussions, not endorsements, selected suppliers or evidence that any firm has reviewed Thalassa. Public expertise supports a possible fit; the proposed team, current availability, scope, price and retest terms remain unknown.

| Candidate     | Verified official evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Fit inference and question to resolve                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cure53        | Its [Nym audit report](https://cure53.de/audit-report_nym.pdf), introduction and scope on pages 3–5, covers mobile apps including iOS, backend API, infrastructure and cryptography. Execution was July 2024; the report is dated November 2025.                                                                                                                                                                                                                                                                                                    | The combined mobile, backend and crypto scope is a close match. Confirm a team can review Rust/UniFFI/Swift custody and the non-Matrix key-directory model as one engagement.                                           |
| Trail of Bits | Its [cryptography service](https://trailofbits.com/services/cryptography/) describes protocol and implementation review. Its [Voatz assessment account](https://blog.trailofbits.com/2020/03/13/our-full-report-on-the-voatz-mobile-voting-platform/) documents mobile-platform code review and threat modeling, including cryptography, credentials, client validation and logging. Its [application security service](https://trailofbits.com/services/application-security/) covers frontend, backend, APIs and SDKs.                            | This supports considering a combined protocol, native boundary and backend review. Confirm current iOS/Keychain and Rust/Swift staffing; the older Voatz engagement does not establish today's assigned team.           |
| NCC Group     | Its [cryptography service](https://www.nccgroup.com/technical-assurance/cryptography-encryption/) covers design and implementation validation. Its [application assessment service](https://www.nccgroup.com/technical-assurance/application-security/application-penetration-testing-security-assessments/) explicitly covers iOS, web and native applications. Its official [WhatsApp Contacts assessment](https://www.nccgroup.com/media/3ckm2llr/ncc_group_metaplatforms_2024-10-11_v11.pdf) spans protocol, client and attestation components. | The documented mix is relevant to endpoint identity, local custody and relay authorization. Confirm the engagement joins its cryptography and mobile/backend specialists and includes adversarial database concurrency. |

Compare proposals on named reviewer skills, explicit coverage/exclusions, reproducible findings, retest of fixes, final reviewed hashes and disclosure/report terms. No prices, schedules or availability have been inferred from unrelated engagements. No firm has been contacted, paid or given repository access.

## Draft contact brief

Subject: Independent review of Thalassa native private message E2EE pilot

We are preparing a text-only, one-device-per-account private-message pilot for Thalassa. It uses unchanged vodozemac 0.11.0 Olm v1 through a narrow Rust/UniFFI/Swift boundary, Keychain-backed sealed native state and an account-authorized ciphertext relay. Existing research includes real provider and simulator HTTPS/SQL exchanges, but live app integration and physical-device acceptance are still in progress. We will provide a frozen source/build packet and segregated test environment.

We seek a review covering cryptographic integration and authenticated key distribution, native Auth and Keychain/file lifecycle, atomic messaging persistence, relay authorization/concurrency, plaintext exposure, fail-closed UI/cutover and recovery/rollout. Please propose the team, coverage and exclusions, information needed before starting, deliverables, retest process, availability and commercial terms. Please explicitly address the Olm v1 authentication margin and the distinction between first-use trust and independently verified identities.

This draft is unsent. The owner must authorize outreach and any source/account sharing separately.

## Review completion and release decision

Require a report identifying exact reviewed source/build hashes, threat assumptions, findings with reproducible evidence, exclusions, unresolved risks and retest results. Remediation must be linked to a new frozen commit; a report on an earlier revision cannot cover later integration changes automatically.

Release remains gated on integrated-path evidence, the physical-device plan, independent PostgreSQL tests, device/prekey and recovery policy, dependency obligations, independent external review and a separate owner release decision. An off-by-default switch, successful compile or lack of findings from internal agent review cannot satisfy those gates.
