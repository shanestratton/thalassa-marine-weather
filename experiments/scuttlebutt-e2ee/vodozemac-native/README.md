# Isolated native Olm boundary

Research only: not imported or registered by Thalassa, not an enabled private-message
feature, and not independently reviewed. Uses unchanged vodozemac **0.11.0 Olm v1**
with all optional provider features disabled. No custom third or post-quantum
ratchet. Olm v1's 64-bit truncated MAC remains an explicit review trade-off.

UniFFI **0.29.4** generates the typed Swift bridge. No handwritten unsafe FFI.
`tooling` enables UniFFI's bindgen CLI on the host only; it is not needed by the
iOS static library. There are no application/server dependencies in this crate.

## Contract

Every call is stateless and throwing. Encrypted upstream pickles go in; new
encrypted upstream pickles come out only on success. No file, Keychain, network,
directory, trust-on-first-use or durable mutation exists here.

- `new_account`: generate one synthetic account and one public one-time key;
  mark that key published before returning the encrypted account snapshot.
- `start_session`: caller-authenticated peer identity and prekey establish Olm v1.
- `encrypt`: return advanced encrypted session plus exact type-0/type-1 wire.
- `open_session`: explicitly pinned sender identity is required; return consumed
  account, new session, plaintext and session ID together.
- `decrypt`: restore only Olm v1 and verify any prekey's outer session keys match
  before upstream decryption; return advanced encrypted session plus plaintext.
- `sign_public_request`: restore the provider account and sign exact bounded
  bytes with its own Ed25519 identity; return only public signing key/signature.
  Does not advance or return the account pickle. Signing itself is not a request
  policy: the Swift coordinator and server must bind domain, identity and action.

The native caller must authenticate and bind owner, peer identity and session ID
to its snapshot, reject mismatches in the returned session ID, serialize access,
and atomically commit account/session/replay/outbox state before reporting success.
Retry delivery with persisted exact ciphertext, not a second encryption call.
Pickle encryption alone is **not rollback protection** or a complete storage design.
The returned Ed25519 key is public metadata, not evidence of authenticated device
registration. This one-prekey API is deliberately not a production key lifecycle.

## Bounds and memory

Keys must be exactly 32 bytes. Public curve keys must be canonical 43-character
unpadded base64. Plaintext is at most 64 KiB; wire at most 64 KiB + 1024 bytes;
encrypted pickle at most 256 KiB (within the 1 MiB whole-snapshot budget).
Public signing input must be nonempty and at most 100 KiB.
The native caller should reject oversized inbound
data before crossing UniFFI, whose argument conversion can allocate before these
Rust checks. Generic errors contain no raw provider details or caller inputs.

Owned Rust key inputs and intermediate plaintext use `Zeroizing`. This does not
erase every copy: generated FFI, Swift, upstream serialization and returned
plaintext allocations remain outside this guarantee. No complete-memory-zero or
secure-enclave claim is made.

## Verification boundary

`tests/native_boundary.rs` uses real generated provider accounts for round trips,
restores, tamper/replay rejection, out-of-order messages, pinned identity, one-time
key consumption, prekey-header matching and bounds. These are host boundary tests,
not actual two-phone, crash-durability, server-authentication or independent-audit
evidence. The native harness must separately prove its atomic storage contract.

Root coordinator runs builds serially on the shared 8 GB Mac and uses a temporary
target/cache outside the primary app. Do not add this library to the shipping
Xcode project or claim that compiling its iOS target proves phone execution.

## Reproduce the native research harness

Run the sibling `vodozemac-native-proof.mjs` on an Apple Silicon Mac with Xcode.
Supply absolute paths to the isolated Cargo executable, its populated
`CARGO_HOME`, and an existing temporary scratch directory. Set the matching
isolated `RUSTUP_HOME`; the toolchain/cache must already contain the pinned crates
and both `aarch64-apple-ios-sim` and `aarch64-apple-ios` targets. The runner does
not download dependencies or boot a simulator.

```sh
export RUSTUP_HOME=/absolute/isolated-research/rustup
researchScratch="$(mktemp -d /private/tmp/thalassa-native-proof.XXXXXX)"
node /absolute/e2ee-worktree/experiments/scuttlebutt-e2ee/vodozemac-native-proof.mjs \
  /absolute/isolated-research/cargo/bin/cargo \
  /absolute/isolated-research/cargo \
  "$researchScratch"
```

Replace the example paths. To execute the synthetic test, append the UDID of an
explicitly selected, already booted iPhone simulator. Omitting that argument is
compile-only: it cannot establish Keychain or process-restart behaviour.
To add the native-to-relay proof, append `--relay-archive /absolute/path/pglite.tgz`
after that UDID and run Node 24 with `--experimental-strip-types`. Use the pinned
archive described in `../relay/README.md`; there are no automatic downloads.
The scratch directory must not already contain `native-relay`, whose database
is retained for inspection. Never silently reuse or overwrite an earlier proof.

The runner checks manifest/lockfile hashes against `vodozemac-native-pin.json`
and the provider archive/source against `vodozemac-pin.json`; it uses locked,
offline Cargo commands, one worker and the agreed shared-Mac build-slot guard.
It builds the host tests/generator, generates Swift bindings, then compiles and
links simulator and unsigned physical-iPhone targets serially. All output stays
outside the primary Thalassa app; no Capacitor sync or app integration occurs.

The optional simulator run installs a randomly named research app and launches
the original six separate process phases: `prepare`, `receive`, `reply`, `verify`,
`replay`, and `cleanup`, then six `dm-`-prefixed phases for the typed coordinator.
Phase receipts must match the run ID, phase and launched PID.
With the optional relay archive, six more `relay-` phases run. They register
provider-signed native bundles, verify server-reserved public keys against
explicit native fixture pins, send three real Olm messages through the SQL
relay, apply committed receipts, decrypt across process restarts and test exact
retries/tampering/durable deduplication. The bridge uses fresh fixture Auth HTTP
responses, not live Supabase credentials, and filesystem delivery, not network/TLS.
Public signature verification in JS proves the Swift array-domain codec agrees
with the gateway. Neither server nor JS sees native private keys, pickles,
plaintext or decrypted history. This document describes the harness, not a pass.
The final replay attempt reopens the receiver's committed state in another
process and then verifies those sessions can still exchange a new message.
A successful run cleans up its synthetic stores, Keychain items and app;
an unsuccessful run may retain the exact research app and preserves a nonsecret
cleanup receipt for investigation. Launches have a bounded 180-second deadline; a timeout or
missing observation is **incomplete**, not an app assertion failure. The app can
finish after the launcher times out. Reconcile its sanitized run/phase/PID receipt
and saved completed phases before continuing or cleaning up; never blindly replay
`prepare`. This document does not assert that a simulator run has passed.

For an observed app assertion failure, `--recover-receipt /absolute/path/run-UUID.json`
instead of `--relay-archive` can rebuild the same disposable research bundle and
run only exact namespace cleanup. The runner requires matching failed app
run/phase/PID evidence and a receipt in its own temporary directory. Unknown
launch outcomes still require manual reconciliation. Cleanup authenticates every
UUID-bound sealed store before deleting disposable test keys/files, refuses
unexpected contents/links, and never deletes a Keychain prefix or recursively
removes a directory. The original failure receipt and database remain; a separate
recovery receipt records cleanup. This is not a successful encryption rerun.

## Swift storage proof and limits

The sibling `VodozemacSealedStore.swift` is a research caller, not part of this
Rust library. It stores a 32-byte master key in the research app's Keychain with
`WhenUnlockedThisDeviceOnly`, no synchronisation and no interactive fallback.
CryptoKit AES-GCM seals the complete opaque snapshot; a separate HKDF-derived
key encrypts provider pickles. SQLite compare-and-swap transactions persist only
the sealed snapshot, binding its store ID and revision. Failed rollback poisons
and closes that store instance rather than exposing uncertain pending state.

The probes cover synthetic round trips, persisted ciphertext/replay state,
tamper and stale-writer rejection, missing/wrong keys, weaker Keychain policy
rejection, and injected commit/rollback faults. Process relaunches and injected
faults are **not** sudden-power-loss, actual SQLite I/O-failure, locked-phone,
two-physical-device or whole-database rollback evidence. Provider key generation
and transport/device authentication are not a production lifecycle here. There
is no production backend, user traffic or independently reviewed shipping integration.

The simulator may omit `FileAttributeKey.protectionKey`, so absent simulator
metadata is reported as **not verified**, not evidence of hardware protection.
If supplied, a different policy fails the assertion. Physical iOS builds require
the reported policy to be `complete`; actual lock/reboot tests are still needed.
Every run receipt explicitly records `physicalDeviceProtectionVerified: false`.
Keychain errors and weaker Keychain policies remain hard failures on simulator
as well as device; there is no in-memory or file-key fallback.

The disposable app uses scene-based UIKit lifecycle and the normal simulator
entitlement sections, not iOS entitlements in the host macOS signature. See
[Apple's build-system separation of simulated and signed entitlements](https://github.com/swiftlang/swift-build/blob/main/Sources/SWBTaskExecution/TaskActions/ProcessProductEntitlementsTaskAction.swift)
and [Apple's file-protection attribute contract](https://developer.apple.com/documentation/foundation/fileattributekey/protectionkey).

## Bounded native message coordinator

`VodozemacDmCoordinator.swift` owns a typed snapshot rather than treating an
opaque pickle as a complete app protocol. It is still research-only: no Capacitor
registration, live credentials, network call, database migration or chat badge.

Its sealed research state is now version 2 and includes the provider's immutable
public signing key. Old research state refuses rather than silently generating
new keys or migrating account ownership. Native signed-send preparation accepts
only the exact durable pending outbox under current owner/peer generations;
bundle signing is forbidden once a session exists. Every signature is exposed
only after a sealed-state CAS, fencing a concurrent owner/peer change without
advancing the provider ratchet. The signing provider never exports private keys.

- Prepare commits the ratchet and immutable exact-ciphertext outbox together.
  A matching retry returns saved bytes without re-encryption; changed content
  under an existing message ID conflicts. Terminal receipts retain tombstones.
- Acceptance compares the complete record and current native owner/trust
  generations. Rejection compares the exact record and current owner, allowing
  cancellation after a peer block or a new owner generation. Receipt authenticity
  is a caller contract exercised with trusted fixtures, **not proved here**.
- Receive stages decryption, checks all authenticated context, then commits
  prekey/account/session changes, local message and dedup state together. Invalid
  context or a failed commit exposes no plaintext and consumes no durable key.
  Only an exact already-committed envelope is a duplicate, never new plaintext.
- Whole-snapshot revision CAS also covers native owner/trust changes. A test-only
  interference hook injects a competing durable lifecycle update before commit;
  it is not a JavaScript guard or plugin input.

`VodozemacDmFrame.swift` matches TypeScript envelope field order and canonical
padded Base64 byte for byte. It rejects alternate/duplicate JSON framing and uses
the Rust 65 KiB wire ceiling. The provider-authenticated plaintext is a fixed
17-field array: domain, inner schema version, envelope version, suite, content
type, conversation/message IDs, both owner/device IDs, both identity references,
both pinned public keys, provider session ID and text. No plaintext metadata is
trusted merely because it arrived in an outer envelope. This is a Thalassa
research payload, not a Matrix event or a provider protocol modification.

Deliberate bounds and unfinished work:

- One owner/device and one peer/conversation/session per store. Only the lower
  ASCII device ID may start the initial session; the other side returns
  `unavailable` until its first valid receive. This prevents simultaneous initial
  sends from creating irreconcilable sessions; it is **not** a complete messaging
  UX or session arbitration/recovery protocol. No automatic session reset.
- At most 16 outbox entries (including terminal tombstones), 16 received messages,
  16 KiB UTF-8 text, and 1 MiB encoded snapshot. Escaping and state sizes can hit
  the byte budget sooner. Fail closed; no silent history/outbox/tombstone eviction.
  A production store needs bounded pagination and reviewed retention, not these
  prototype capacity limits.
- Native fixture-only account/peer setup, one-time-key lifecycle and generation
  changes are not production ownership, logout, revocation, key rotation or
  server-response authentication. Structured messages, attachments, groups and
  browser support remain excluded. No secure memory erasure, whole-DB rollback
  detection, phone-lock/SIGKILL/power-loss or independent security claim.

The `replay` phase runs the frame/coordinator assertions, including wrong-context
valid ciphertext, repeated prekey messages, commit failure, Unicode-equivalent
receipt substitution, trust/owner races and capacity refusal. The six `dm-`
phases reopen the actual coordinator across independent processes and verify
saved sends, replies, history, exact retries, dedup and terminal receipts. The
runner records the executed coordinator assertion count. Consult the checkpoint
for actual executed results; this contract alone is not a passing test.

## Local sealed store process death proof

From the isolated checkout, run the new local-only simulator proof with an
existing cached native provider and bindings:

```sh
node experiments/scuttlebutt-e2ee/sealedCrashProof.mjs /absolute/path/native-cache
```

If the cache's original completed run receipts are absent, an explicit completed
native HTTPS-exchange receipt is accepted only when its nine phases, cleanup,
pins and every exact cached artifact hash match:

```sh
node experiments/scuttlebutt-e2ee/sealedCrashProof.mjs /absolute/path/native-cache \
  --native-exchange-receipt /absolute/path/exchange-run.json
```

The runner waits for the shared build slot, freezes verified copies and creates
one new simulator using an already installed iOS 26.5 runtime. It never downloads,
uses hosted accounts/relays, trusts a certificate or touches physical devices.
Only the special build defines `THALASSA_SEALED_CRASH_PROBE`; its immutable
exact-store callbacks park before UPDATE, after UPDATE before COMMIT and after
successful COMMIT. Preparation, opening/session receive, accepted/rejected
decisions and logout each run at all three boundaries, for 18 fresh cases.
Baselines and original envelopes stay in a separate native sealed ledger.

The runner checks each parked app's exact launch, nonce, simulator, bundle,
executable hash, UID, start identity and arguments before SIGKILL. Fresh processes
verify complete rollback or committed state, exact retry/dedup, usable provider
accounts and successors; cleanup removes only owned fixture namespaces and the
new simulator. Its receipt records signal dispatch and correlated-process
disappearance, not parent wait status or proven numeric PID reuse. Direct native
fixtures do not establish Auth/facade/remote receipt behavior, phone lock, power
loss, an interruption inside COMMIT, backup rollback or independent review.
See the [checkpoint](../../../docs/SCUTTLEBUTT_E2EE_CHECKPOINT.md) for executed
results and preserved failures.

## Dependency licence inventory

Offline Cargo metadata for the pinned lock resolves 102 packages for the runtime
configuration and 131 with host `tooling`, including this local crate. These are
metadata/all-target resolution sets, not a shipped-binary SBOM.

- vodozemac 0.11.0 declares **Apache-2.0**.
- UniFFI 0.29.4 runtime/scaffolding crates declare **MPL-2.0**; the optional host
  `uniffi_bindgen` and `uniffi_udl` tooling also declares MPL-2.0.
- No third-party package has missing licence metadata, an AGPL declaration or a
  GPL-only declaration. `r-efi` offers `MIT OR Apache-2.0 OR LGPL-2.1-or-later`;
  it is not LGPL-only. This unpublished local research crate has no licence field.

This is a metadata inventory, **not legal clearance**. The complete bridge must
not be described as wholly Apache-licensed. Mozilla's [MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
describes file-level obligations, including source availability for covered code
distributed in binaries. The generated Swift/header output contains UniFFI
template code; no generated-output licence exception was established in this
review. Before any release, confirm the generated-code treatment and applicable
source/notice obligations against the pinned licences with qualified counsel.
