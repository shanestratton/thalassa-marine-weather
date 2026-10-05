# Scuttlebutt private message E2EE device test plan

Updated 6 October 2026 for execution with the owner's iPhone 15 Pro Max and iPad 9th generation, using different test-project accounts. This plan defines evidence for an isolated native pilot. The owner reports an opening message, reply and post-restart successors on both devices, plus offline-recipient catch-up and repeat scans with one displayed copy in both directions, on candidate `4005833a`. An iPhone screenshot captures a committed incoming row. **D01 and D02 have partial physical evidence; no full acceptance case is passed, and the remaining controlled procedures are unrun.** The new installed candidate is `0cde17c21c68e0bba9dff6fe07eef41b5dfad00c`; the [checkpoint](SCUTTLEBUTT_E2EE_CHECKPOINT.md) separates its source/signing/in-place update checks and owner-reported sign-ins from the earlier candidate's message observations.

Two independent physical endpoints can expose custody, lifecycle and transport failures that one simulator cannot. The iPad provides iPadOS coverage, not a substitute for testing every supported iPhone/OS combination. Read-only checks on 4 October found iOS 27.0.1 on the iPhone and iPadOS 26.5 on the iPad, both paired with Developer Mode enabled. This is device inventory, not supported-build eligibility or research-app execution evidence.

## Prerequisites and current blocks

The table below preserves the 4 October prerequisite snapshot. On 5 October,
actual sign-ins and registration preceded the owner-operated pairing and
two-way exchange. The latest checkpoint supersedes the snapshot's unverified
login, unused-slot and unrun-delivery statements; it does not remove the
remaining lifecycle, fault-injection or instrumentation gaps. Do not enroll or
replace the already registered human devices to repeat this setup.

| Requirement                   | Current evidence or block                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Isolated installable artifact | Separate Capacitor research messaging app with 17 Swift sources and bundle `app.thalassa.research.scuttlebutt-auth` is signed and installed as 0.1.0 build 1 on both devices. Process launch succeeds; UI/plugin initialization remains unverified. Normal Thalassa's bundle/version/build metadata is unchanged on both; its private data files were not inspected.                                                                                                                                   |
| Actual app authority          | One shared native Auth host/facade now backs the explicit messaging plugin and memory-only SDK/controller. Original account and full-peer snapshots guard native publication; JavaScript checks binding and view revision after every await. Fixture success is not actual login, background/lock or device messaging evidence.                                                                                                                                                                        |
| Test relay and accounts       | Segregated pilot `kmtupdvwdgbhtssqqova` has prior real Supabase Auth and signed-relay checks with synthetic ciphertext actors. The 4 October policy-only SQL update and Edge revision 26 passed definition/permission/data preservation and four negative HTTP checks; positive signed policy remains unrun. Two human accounts were provisioned, not enrolled by this slice. Recheck allowlist/device slots before physical enrollment; do not reset them. Native Olm-to-hosted delivery is unrun.    |
| Peer and device lifecycle     | Explicit native registration, canonical public-card inspection, full other-device fingerprint confirmation and lower-device prekey claim are implemented in the research app. They still need actual Capacitor and human-device execution. Native block/revoke UI, replacement, rotation and replenishment remain missing. Never improvise recovery by deleting directory rows.                                                                                                                        |
| App send and receive paths    | Research plugin/screens expose explicit policy, prepare/send, exact-ID retry, receive and guarded local history. Cold launch now permits only exact active-owner continuation after fresh same-account login; no bearer, Auth lease or policy survives. Real-provider close/reopen fixtures preserve pending ciphertext, not physical restart evidence. Explicit logout quarantines the old generation. Recovery, usable chronology, scalable sync, notifications and shipping cutover remain missing. |
| Controlled fault hooks        | Need test-only methods for response loss, delayed/reordered delivery, exact replay, poison, capacity and storage faults, with no production exposure. Key/file loss and reinstall tests require a disposable test namespace with a recorded recovery procedure.                                                                                                                                                                                                                                        |
| Evidence instrumentation      | Need sanitized native state/event receipts and relay inspection that can prove exact retry, state generations, message counts and absence of chosen test canaries without logging content, bearer tokens, private keys or pickles.                                                                                                                                                                                                                                                                     |

Freeze and record the actual candidate commit and build hashes when these prerequisites are met. Do not label concurrent implementation as tested by carrying forward this baseline's counts. Keep one heavy build at a time under the checkpoint's shared-Mac rule; this document does not start any build, sync, install or server migration.

The current source artifact receipt is `thalassa-messaging-build-CWifTU/build-receipt.json`; its signed receipt is `thalassa-research-sign-hvqv4A/signing-receipt.json` and its device receipt is `/private/tmp/thalassa-pending-update.6AL1Sp/update-receipt.json`. Both devices accepted and launched the owner-approved in-place Research update, retaining their identical 11-file metadata inventories with unchanged Research entitlements and no reset. The owner then reported signing into both. These facts do not prove restored message content, native Keychain equality or the new controls' functionality. See the checkpoint for exact paths and the corrected Mac launch-command failure. Normal Thalassa remains version 1.2.0 build 119 on both; never use its bundle ID or shared Keychain groups for this test.

Read-only pilot checks confirmed the participant allowlist metadata and unused human device slots on 4 October. On 5 October, read-only slot counts and function logs supported registration for both participants. These devices are now registered; immutable device/prekey rows cannot serve as a recovery mechanism.

## Setup and run record

Use iPhone/account A and iPad/account B, then reverse initiation after a fresh test namespace if the documented initial-session role requires it. The research coordinator permits only the lower ASCII device ID to initiate; ordinary UX must explain the wait/refusal rather than silently resetting a session. A third account or additional peer is needed for multi-peer isolation; two accounts cannot prove it.

Choose unique nonpersonal canary text for each case and record its hash in the shared receipt. Keep the canary list and any privileged inspection artifacts in a restricted test packet. Record plaintext search coverage explicitly: a scan of chosen DB/WAL files or selected logs cannot establish absence from every server or OS artifact. Obtain device log exports through the documented test workflow, not by weakening Keychain or TLS controls.

Each case receipt needs:

- Case ID, outcome (`pass`, `fail`, `blocked`, `unrun`), operator, local time/timezone and duration.
- Commit, dirty-tree state, app version, bundle ID, build/artifact hashes, provider/bridge pins and configuration identity.
- Device model, actual iOS/iPadOS version, account alias, native device/store alias, and network/lock state.
- Exact procedure and fault-injection point, expected result, observed result, message IDs and sanitized owner/peer/credential generations before and after.
- Receipt/log/capture paths and hashes; wire/ciphertext hashes for equality checks; relay accepted/refused/duplicate counts; state revision or payload hashes where relevant.
- Whether Auth, HTTPS, SQL and plugin calls were actual or fixtures; missing evidence, reproduction steps and defect link for every failure.

Do not store access/refresh tokens, private keys, pickles, real account passwords, device secrets or existing message content in repository receipts. Screenshots should use only the disposable test conversation. A manual visual check alone cannot prove ratchet or transaction behavior.

## Prepared but unsent restart experiment

Installed Research candidate `0cde17c2` adds an explicit **Check policy & prepare
only** control and a saved-envelope SHA-256 diagnostic. Its local validation,
signing and in-place update are recorded in the checkpoint. The owner reports
restored history on both devices. iPhone captures before and after the instructed
restart show pending ID `b37ff5d0-dc1b-475f-81ee-7ae0aab79dc5`, unchanged local
time and the same full saved-envelope hash. A subsequent iPad capture shows that
exact ID/hash received into native history, with unresolved 0. The owner reports
the exact-ID retry result was identical and the peer displays one copy. A repeat
scan capture shows stored 0 and duplicates 6; its target card is cropped, so it
does not independently establish target uniqueness. The checkpoint records the
correlated captures, hashes and private observation receipt. Process termination
and retry were not independently instrumented; sender terminal acceptance and
direct relay receipts were not captured. This supplies bounded manual evidence,
not a full acceptance case.

The mirrored iPad captures now show pending ID
`f96e0b8b-5ada-4fb0-b93c-43a23ac3325d` with unchanged timestamp and full hash
before/after the instructed restart, then the matching received row on the
iPhone. The sender capture shows relay acceptance, not its target terminal row.
The receive scan stored 2 batch rows with unresolved 0; the owner reports no
duplicate on the repeat check. The owner explicitly identified this target after
an initial message-identification concern. The checkpoint/private receipt retains
the captures and clarification. This completes the bounded manual check both
ways, without supplying process/SQL instrumentation or a full device-case pass.

1. With fresh same-account verification, current setup and no existing pending
   attempt, prepare one disposable canary while online. This refreshes policy
   and commits native preparation but does not call message-send upload.
2. Capture its pending message ID, local timestamp and full envelope hash.
   Preparation consumes a bounded outbox slot; the experiment must settle it.
3. Restart only that Research process, without Log out or replacement setup.
   Sign into the same account and read committed local history.
4. Require the same pending ID, timestamp and envelope hash. Do not prepare a
   replacement if any field is missing, uncertain or changed.
5. Use **Retry same pending ID**. Require relay acceptance on that ID with the
   original hash, then explicitly receive it at the peer and compare its hash.
6. Repeat receive, require one displayed copy, then test a small successor if
   native capacity permits. Keep all captures confined to the test conversation.

The hash is computed from exact saved serialized-envelope UTF-8 bytes, not
plaintext, keys, pickles or the changing signed HTTP wrapper. It is equality
diagnostics under the native implementation's integrity assumptions, not peer
authentication, send permission or delivery evidence by itself. This experiment
checks an unsent committed pending record, not response loss after relay commit,
crash-boundary atomicity, power loss or the complete D02/D07/D14 procedures.

## Physical test matrix

The 5 October automated regression passed all five saved-envelope hash checks
within 288 native bridge assertions, plus nine simulator process phases and
four legacy-client encrypted HTTPS/local-SQL messages. The checkpoint and
[regression manifest](../experiments/scuttlebutt-e2ee/review/regression-2026-10-05.json)
separate synthetic Auth/scoped-relay fixtures, real provider/sealed storage and
local SQL from physical observations. No phone or iPad was changed by that run.
No physical case below is upgraded to passed. The 6 October simulator regression
subsequently passed 18 direct-native cases at before-UPDATE, pre-COMMIT and
post-COMMIT boundaries, with fresh-process exact ciphertext/state comparisons,
provider controls and logout fencing. The runner correlated each parked process,
sent SIGKILL and observed its original process identity disappear; it has no
parent wait-status evidence. This closes the direct coordinator/store simulator
gap, not physical D14, actual Auth/facade/Capacitor paths, power-loss or
hardware-lock behavior. Exact receipts and remaining gates are in the checkpoint.

D01 has owner-reported opening-message, reply and successor coverage, with one captured endpoint. D02 has owner-reported history restoration and a successful successor after each endpoint restarted independently. Offline catch-up/repeat-scan observations are recorded below, but no full case is passed; D03–D17 controlled procedures remain unrun. Run retry/lifecycle cases before destructive test-namespace faults. Execute applicable cases in both endpoint roles and repeat affected cases after a fix using the new frozen artifact.

Bounded same-owner restart continuation passes native close/reopen fixtures. The later prepare-only experiment above adds captured pending continuity and matching peer receipt in both directions; the earlier D02 history/successor observations alone did not exercise a pending send. Controlled D07 response loss and full D14 generation/ciphertext receipts remain unrun. Require fresh same-account login and policy, then compare the original pending ciphertext before exact-ID retry. Observe explicit logout's quarantine separately. Neither re-enrollment nor a fresh generation may stand in for continuity or recovery evidence.

The owner reports offline-recipient catch-up followed by repeat scans displaying
one copy in both directions. This is not a full D07 or D08 run. Taking the sender offline before
pressing Send cannot reliably prepare a pending row: fresh policy is fetched
first. Do not substitute a network-toggle race for controlled post-prepare
response loss. A repeat scan may count older incoming rows as duplicates;
require the new message to remain displayed once, no additional stored rows
and no unresolved rows.

| ID and case                            | Procedure                                                                                                                                                                                                                                                                                 | Required outcome and evidence                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01 Enrollment and first exchange      | Sign in A on iPhone and B on iPad through the actual SDK; enroll each native device, obtain signed public material and establish the supported trust state. Send an opening message, reply and successor in each supported direction.                                                     | Both endpoints display the intended canaries once. Record actual Auth, directory/prekey claim, native decrypt/commit and relay ciphertext receipts. Confirm Olm v1/envelope v2 and distinguish first-use trust from fingerprint verification.                                                                                                                                     |
| D02 Independent restart                | Force-close and reopen each app independently with a pending send and received history. Reverify Auth before messaging; send a successor after reopen.                                                                                                                                    | Identity/store remains the same, no bearer/readiness survives construction, and the successor decrypts. Same-generation exact pending ciphertext remains unchanged; reopening does not create keys, duplicate content or relabel history.                                                                                                                                         |
| D03 Logout and account isolation       | Queue a pending ciphertext, log out locally, reopen, and attempt history/send/receive. Sign back into the same account, then switch to the other test account in a separate scoped setup. Delay an earlier Auth or send callback across logout.                                           | Local authority becomes unusable immediately; durable logout success/failure is visible. Same-account resume advances owner generation without reviving old pending sends/history. Wrong account cannot select/rebind the store, and delayed results cannot publish stale plaintext or credentials. Already-dispatched SQL may commit; capture that separately from local logout. |
| D04 Token renewal and expiry           | Trigger actual SDK refresh with a pending send; delay competing refreshes and Auth responses. Let the native verified lease expire and suspend/background across the deadline.                                                                                                            | Accepted same-account renewal preserves owner generation and exact pending ciphertext while changing credential epoch. Expired/refused/cancelled verification does not restore an old lease. Stale callbacks and epoch requests fail closed; capture actual SDK/native events rather than only decoded JWT claims.                                                                |
| D05 Peer block and revocation          | With messages accepted and pending, block/unblock B from A and revoke B's device using test-only account controls. Retry old requests and attempt new sends/reads.                                                                                                                        | Current policy blocks new actions as specified. Exact terminal receipts remain immutable; old owner/trust generations cannot be rebound. Old saved rows may be classified historical without restoring plaintext. Record block/unblock cursor reconciliation and any unsupported recovery clearly.                                                                                |
| D06 Identity change and trust          | Present changed peer identity/public material, including an A→B→A key sequence, via the controlled directory. Attempt sends, receive, retry and history access before resolution.                                                                                                         | Changed keys stop the affected session visibly and do not overwrite pins or resurrect a previous generation. If fingerprint verification is implemented, compare both physical displays; otherwise record it as unsupported, not verified.                                                                                                                                        |
| D07 Offline and lost response          | Disable network before send; separately allow relay commit then drop only its response. Reopen the sender, restore network and retry after the old request signature expires.                                                                                                             | Outbox and ratchet commit together before upload. Retries use the same ciphertext/message ID; a renewed signature has a new nonce. Exactly one terminal relay decision exists and the recipient displays once. No timeout becomes a fabricated refusal or triggers plaintext fallback.                                                                                            |
| D08 Out of order and duplicate         | Hold three real encrypted messages at the test relay, deliver in a different order, duplicate each, then deliver a normal successor. Use a separate controlled gap test if the artifact supports it.                                                                                      | Supported out-of-order messages decrypt once and successors remain usable. Beyond-limit messages remain exact unresolved ciphertext without consuming speculative state; an ordinary rescan does not retry/evict them. Explicit same-generation recovery needs a separate success receipt.                                                                                        |
| D09 Malformed and poisoned inbox       | Return a page with a malformed final row, then a canonical cryptographically invalid row before a valid successor. Repeat the exact page and restart.                                                                                                                                     | Structural validation rejects the full page before payload mutations. Typed unresolved failure retains the exact row and permits the documented valid continuation; key/storage/configuration errors stay hard failures. No failed row creates plaintext, a read receipt or silent deletion.                                                                                      |
| D10 Inbox and outbox capacity          | In a fresh namespace, fill inbox plus unresolved to the 16-row research budget, outbox including tombstones to its 16-row budget, and separately hit the 1 MiB snapshot or byte budget.                                                                                                   | Capacity fails visibly with no silent eviction, new plaintext or ratchet advancement. Exact retries of existing records remain defined. Record the actual first limiting budget; these prototype limits are not acceptance of production retention.                                                                                                                               |
| D11 Lock and background                | Prepare pending state unlocked, lock both devices and attempt the documented receive/history/signing workflow. Inspect push and app-switcher exposure. Unlock and continue; repeat after reboot before first unlock if the test artifact permits it.                                      | `WhenUnlockedThisDeviceOnly` Keychain and complete file protection enforce the documented policy on physical hardware. Locked access fails closed without weaker-key fallback or key recreation; unlock resumes valid state. Push is generic and content-free. Do not infer memory erasure from a blank UI or successful lock.                                                    |
| D12 Missing key or database            | Only in an identified disposable store, remove its Keychain item while retaining files; separately retain a key but remove/corrupt the directory/database. Reopen and attempt all operations.                                                                                             | Missing/corrupt/orphaned state is diagnosed and stays unavailable. No silent identity recreation, store rebind, plaintext fallback or old-generation send. Preserve before/after inventory and exact namespace to prove the primary app was untouched.                                                                                                                            |
| D13 Reinstall and restore              | Export a test-namespace inventory, uninstall/reinstall the disposable build, then exercise retained Keychain versus lost application files. Test supported backup/restore and an older complete DB snapshot with its surviving key separately.                                            | Record observed installation persistence; do not assume uninstall deletes Keychain. Reinstall/recovery requires an explicit supported policy, otherwise refusal is the result. Whole-DB rollback must be evaluated explicitly; per-snapshot authentication/CAS alone cannot demonstrate detection. No prior plaintext history is relabeled encrypted.                             |
| D14 Crash at persistence boundary      | Use controlled test hooks to terminate the research process immediately before and after native send/receive commit, receipt settlement and logout commit; reopen and reconcile.                                                                                                          | No committed ciphertext is re-encrypted and no uncommitted plaintext/ratchet change is exposed. Either old or new authenticated state is recovered according to the boundary, with exact dedup/receipt evidence. Forced process termination is not power-loss or disk-failure proof.                                                                                              |
| D15 Plaintext exposure and cutover     | Exercise text, legacy offline queue, Guardian hail, pin/recipe sharing, history/inbox/realtime and notifications under pilot active, unavailable and unsupported-client states. Search chosen canaries in relay rows, app Preferences/cache/files and selected logs/crash/push artifacts. | Every admitted private path uses the protected boundary; unsupported content is refused or clearly unavailable. Pilot errors do not call legacy plaintext send or drain old queued text. Generic push has no content/location preview. Record inspected artifacts and remaining gaps; security badges match actual trust and history state.                                       |
| D16 TLS and network changes            | Move between Wi-Fi/mobile or another available network, interrupt body delivery, stall a response and use an untrusted/wrong-host certificate on the isolated relay. Retry a committed uncertain send afterward.                                                                          | Normal system TLS rejects invalid trust/hostname with no bypass or ATS exception. Bounded whole-operation deadlines hold across suspension/chunks; errors remain unresolved until exact reconciliation. Record whether socket-level faults were actual or fixtures.                                                                                                               |
| D17 Second device and additional peers | Attempt a second device for A under the one-device policy. When multi-peer support exists, add an independent third account and interleave sends, blocks and restarts across peers.                                                                                                       | The second device refuses without key replacement or weakening one-device enforcement. Additional peers must not share ratchet, trust, history, outbox or cursor state. The available A/B pair cannot establish the multi-peer result; mark that part blocked until a third account is available.                                                                                 |

Independent PostgreSQL connection races, gateway deployment configuration, full server artifact inspection, production quotas and licence/external audit work belong in [the review brief](SCUTTLEBUTT_E2EE_REVIEW_BRIEF.md). Passing this device matrix does not prove those separate boundaries.

## Completion criteria

Attach receipts for both physical endpoints and each applicable case. A skipped unsupported feature needs a documented refusal and exclusion; a blocked required case keeps the gate open. Summarize failures and fixes with their original outcomes, then rerun affected paths on the final candidate. Device successes must match the artifact reviewed by the external assessor or have an assessed diff.

The owner can judge success by selecting a pending message ID from D07 and tracing its unchanged ciphertext hash through native reopen, relay commitment and single recipient display. That evidence is stronger than another agent agreeing that retry code looks correct.

Signing, installation, process launch and partial human-operated exchange evidence are recorded in the checkpoint, not as a passed D01–D17 device case. No complete messaging integration acceptance or audit pass is claimed by this plan. Isolated hosted deployment is separate evidence too. Production release remains a separate authorized decision after the evidence and review gates are met.
