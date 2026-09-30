# Scuttlebutt private-message E2EE — isolated checkpoint

Updated: 1 October 2026. Branch: `codex/scuttlebutt-e2ee-foundation`.

## Shared-Mac workflow — owner's 1 October rules

- Commit and push this branch freely from its own worktree. Stage named files
  only and inspect `git diff --cached --name-only` before each commit.
- One heavy build at a time on the 8 GB Mac. Immediately before each `tsc`, Vite
  build or Vitest run, execute `pgrep -fl "vite build|tsc|vitest"`; wait when a
  competing job is running. If sandbox process enumeration fails, obtain the
  read-only process check outside the sandbox rather than assuming the slot is
  free. Treat CocoaPods/Xcode sync and Rust/native builds as heavy jobs too.
- Capacitor sync is permitted only inside this managed worktree, never the
  primary `/Users/shanestratton/Projects/thalassa-marine-weather/ios` project used
  for Shane's phone. Check native realpaths first. Shared `node_modules` is for
  reading dependencies only: no installation/patching there. Vite's default
  config/result caches also follow that symlink, so use the runner config loader
  and a separate temporary cache. Focused Vitest uses no app config or cache.
- `master` is for work intended to ship and deploys the website. Before any
  master push, fetch, rebase and tell Shane. Current E2EE research is not meant
  to ship; side-branch build/sync does not authorize production activation.

**Owner decision: proceed with Apache-2.0 vodozemac, unchanged Olm Double Ratchet.**
On 30 September the owner accepted the recommendation not to build a homemade
third ratchet. This authorizes the isolated provider transition, not production
release, a post-quantum claim, or changing Thalassa's source licence. libsignal is
not the adoption candidate; its earlier probes below remain historical research.
Keychain operations and ad-hoc simulator signing are confined to a disposable
research app. No relay migration, Thalassa app linking/signing changes or
distribution were started. Dependency/licence review, two real phones and an
independent security review still gate release. An off-by-default switch is not
a substitute for those checks or a way around a bundled dependency's licence.

## What exists today

This is an isolated framing/delivery prototype plus a real-provider native
message coordinator, **not functioning E2EE in Thalassa**. Nothing is wired into live chat.
No app dependency, native plugin, database change, UI badge, production deployment
or message deletion is included. Research dependencies and build artifacts stay
outside the repository; no third-party library binaries are committed.

`services/chat/e2ee/directMessageEnvelope.ts` proposes bounded, versioned,
per-device framing for opaque provider bytes. It rejects legacy text, unknown
protocols and extra fields (including plaintext previews and keys). Its tests
prove framing behaviour only. Anyone can base64-encode plaintext and put it in
the ciphertext field: passing validation proves neither encryption nor sender
authenticity. Do not use this validator to display a security badge. A required
`prekey`/`session` discriminator maps to Olm's numeric 0/1 message type. Thalassa's
envelope v2 / `olm-v1` is deliberately incompatible with the retired envelope v1 /
`signal-triple-ratchet`; old records reject without upload or relabelling. It is
not a Matrix event format. Upstream Olm JSON uses numeric types and unpadded
Base64; Thalassa framing requires a string type and canonical padded Base64.
Like other outer fields, the discriminator is not independently authenticated
by framing. No automatic provider downgrade, migration or plaintext fallback.

`services/chat/e2ee/encryptedDmDelivery.ts` models exact-ciphertext retries,
owner/device isolation, identity changes, timeouts and terminal refusals. It does
not encrypt or persist anything. Native atomic ratchet/outbox commits and server
authorization/idempotency are explicit external contracts, not implemented
guarantees. Delivery tests use mocked adapters; they cannot prove those contracts.

Owner/device and peer-trust generations are captured when preparing an outbox
record, never rewritten at retry. Restart may resume the same durable generation;
logout/relogin, revocation or changed device ownership cannot revive old pending
ciphertext. Authenticated terminal refusals cancel only the exact stored record.
Server acceptance does not mean recipient delivery or reading.

## Reproducible research evidence

- **147 focused tests passed**: 43 framing tests and 104 mocked delivery tests,
  with one worker and no app setup. Isolated strict TypeScript checking passed.
  Wait for the shared build slot and run only these files; no full app suite is
  needed for this unwired checkpoint.

### 1 October branch build and sync verification

Verified against code checkpoint `3dc83241`, using Node 24.19.0 and the shared
dependencies read-only. Each heavy job ran separately after the process check;
native sync waited for Claude's intervening Vitest run to finish.

- The same **146 focused tests passed again**, with one worker, no app config
  and cache disabled. The full app `tsc` check also exited successfully.
- Vite 7.3.6 built the web bundle successfully (2,559 modules). Its runner config
  loader and a temporary cache avoided writes through shared `node_modules`.
  Existing large-chunk warnings remain; this was not a bundle-size cleanup.
- `npm run cap:sync` completed only in this worktree. Capacitor followed the
  shared dependency realpaths and rewrote the Podfile/lock, also updating
  IONFilesystemLib to 1.1.2. Those generated changes were discarded. A subsequent
  `bundle exec pod install --deployment` succeeded with the original relative
  paths and pinned IONFilesystemLib 1.1.1. `Pods/Manifest.lock` exactly matches
  the unchanged tracked lockfile. No native configuration changes are committed.
- The source, dist and synced-artifact forbidden-secret-name checks passed.
  No provider protocol identifiers or libsignal/vodozemac references were found
  in the generated web assets or app dependency/project manifests. This is an
  isolation check, not a security audit.
- The primary checkout's `ios` remained clean and was not synced. No master push,
  website deployment, Xcode app compilation, device install or phone test was
  performed. No production runtime configuration was copied into this worktree;
  the generated bundle is compile/sync evidence, not a phone-release artifact.

Only the side branch is pushed. None of these checks advances the E2EE release
gates or changes the fact that live private messages are not yet encrypted.

### Current Apache provider experiment

`experiments/scuttlebutt-e2ee/vodozemac-probe/` pins the published vodozemac
**0.11.0**, source `db1b34820f3102307284e762f335b3f72c735bf0`. The archive hash was
checked against the public Cargo registry index. `vodozemac-pin.json` also pins
the complete experiment lockfile and manifest. All provider optional/default
features are disabled: no libolm compatibility, experimental session config,
low-level handshake bypass, or insecure key-backup encryption.

The real Rust tests use fresh synthetic peers, explicit `SessionConfig::version_1()`,
and upstream encryption/signature/pickle APIs only. They cover bidirectional
exchanges, dispatch types, tamper/replay rejection, staged receive snapshots,
out-of-order delivery, session/account restoration, encrypted-pickle wrong-key
and tamper rejection, non-contributory peer keys, and caller-pinned identity and
signature checks. The signed-key fixture is test-only: it is not a reviewed
production bundle format or proof of directory ownership. Pickles and keys stay
in test memory. Existing SQLite crash tests are NOT yet joined to this provider.

`vodozemac-host-proof.mjs` runs offline with a separately provisioned Cargo cache,
one compiler/test worker, debug info and incremental builds disabled. It verifies
the resolved provider version/features, archive, source revision and cached
source files against a fresh extraction of that archive before running tests.
Build products stay in a temporary directory, outside the app tree. It does not
install dependencies, start a simulator, access real accounts, or change Xcode.

**Twelve real-library tests passed on Apple Silicon macOS**, Rust 1.89.0 and
Node 24.19.0. This includes correctly addressed initial-message tampering without
prekey consumption, plus real prekey/normal messages passing through the actual
TypeScript envelope validator and decrypting successfully afterward. These are
host tests, not iOS or two-phone evidence. Focused TypeScript checking, ESLint,
format checks and `git diff --check` also passed. A metadata inventory of the 76
resolved registry packages for this host reported permissive licence expressions
and no missing licence fields; this is not legal review or a notice-generation
step. The temporary toolchain/cache was kept outside the app and no shell
profiles or system toolchain defaults were changed.

### Native Apache-provider bridge and sealed-store checkpoint — 1 October

`experiments/scuttlebutt-e2ee/vodozemac-native/` adds a pinned, stateless UniFFI
0.29.4 boundary around unchanged vodozemac 0.11.0 Olm v1. Generated Swift bindings
and binaries remain external build outputs, not dependencies of the app. The
boundary checks sizes, pinned sender identity, restored session version and
prekey outer-header/session-key matching; errors omit provider inputs/details.

`VodozemacSealedStore.swift` uses an actual UUID-scoped research Keychain item
(`WhenUnlockedThisDeviceOnly`, nonsynchronizing). CryptoKit AES-GCM seals the
whole account/session/outbox/receive snapshot before SQLite sees it; a separately
derived key protects upstream pickles. Store identity and revision are bound to
the ciphertext. Transactions compare revisions and authenticate prior state.
If rollback fails, the handle is poisoned/closed until authenticated reopen.

Verified with the offline single-worker native runner, Rust 1.89.0, Node 24.19.0
and Xcode's iOS 27 SDK:

- **10 real-provider Rust boundary tests passed**, including malformed inputs,
  tampering, replay, out-of-order delivery, one-time-key consumption, wrong keys
  and a regression proving prekey outer-header validation is necessary.
- Swift/generated UniFFI/Rust static libraries **compile and link for simulator
  and physical-iPhone targets**. The physical binary is unsigned and was not run.
- **All six process phases passed in the iOS 26.5 simulator**: prepare, receive,
  reply, verify, durable replay rejection, and exact cleanup. Both peers' keys,
  account/session state and exact pending ciphertext survive independent app
  launches. After replay refusal, the restored sessions exchange another valid
  message, so unreadable state cannot masquerade as replay protection.
- The storage probe passed ciphertext/revision/store-ID tamper rejection,
  two-connection stale-writer refusal, injected pre-commit rollback and failed
  rollback/poisoning, wrong/missing keys, weaker Keychain policy refusal, backup
  exclusion, payload bounds and absence of fixture plaintext in DB/WAL files.
- **All six process phases also passed in a clean iOS 27 simulator run**, including
  automatic exact cleanup/uninstall. An earlier `simctl launch` exceeded the
  former 60-second deadline, but its sanitized receipt subsequently proved
  `prepare` completed. The remaining five phases also passed against that exact
  recovered run before the fresh full-run confirmation. That initial timeout was
  incomplete observation, not an app assertion failure. The runner now allows
  180 seconds for launch and distinguishes incomplete observation from an explicit
  app-reported failure; it never blindly retries `prepare`.

**Not verified:** hardware file protection and locked-device behaviour. The
simulator omitted the file-protection attribute; this is explicitly recorded as
unverified rather than passed. Physical iOS probes retain the strict policy
assertion. Keychain errors remain failures on every platform, never mock
fallbacks. Orderly process exits and synthetic faults are not SIGKILL, power-loss,
actual SQLite I/O-failure or whole-database rollback evidence. No complete memory
erasure or secure-deletion claim is made.

Initial attempts exposed harness packaging and assertion issues: simulator
entitlements must be in simulated linker sections, separate from the host
signature; scene lifecycle and sanitized stage receipts now make launch failures
visible. No user keys, messages, phone app, production signing or Supabase data
were accessed. Failed test namespaces are cleaned up only by their exact receipts.

The licence inventory is not blanket Apache clearance: the provider is Apache-2.0,
but UniFFI runtime/tooling is MPL-2.0. Metadata has no missing third-party licence
or AGPL/GPL-only dependency; generated-code treatment and all applicable source/
notice obligations still require review before distribution. See the native
README for reproduction, inventory and limitations. Agent review found concrete
issues but is **not** the planned independent security review.

### Bounded native message-coordinator checkpoint — 1 October

`VodozemacDmCoordinator.swift` now makes the storage contract concrete for a
single native owner/device, peer and conversation. It atomically commits real Olm
ratchet state and exact ciphertext outbox records; repeat preparation returns
the committed bytes. Exact acceptance/refusal records become durable terminal
tombstones. Receive binds the provider-authenticated content to the expected
conversation, message, users, devices, identity references, actual public keys
and session before persisting either plaintext or ratchet/prekey changes.
An exact committed receive retry returns `duplicate`, not another plaintext.

The coordinator owns persisted owner/trust generations and checks them against
scalar expected context. Its entire state is revision-CASed, so a lifecycle
update racing an encryption/receipt invalidates the stale commit. A native-only
research hook injects that interference; it is not a JavaScript guard. No key,
pickle or internal request digest is exposed as a transport result.

Verified on iOS 27 simulator with the unchanged pinned provider/toolchain:

- **112 coordinator assertions passed**, covering exact retries/reopen, changed
  content conflicts, failed prepare/receive/receipt commits, repeated prekey
  messages, normal replies, terminal receipts, wrong-account/trust guards,
  deterministic concurrent lifecycle updates, real decryptable wrong-conversation
  content, outer-ID substitution, receive dedup and both capacity limits.
- Native frame assertions passed: exact TypeScript-compatible JSON and Base64,
  duplicate/unknown/alternate outer fields, every authenticated inner-context
  substitution, Unicode and size bounds. A matching TypeScript golden-fixture
  test passed; the TypeScript wire ceiling now matches the native **65 KiB** cap.
- The runner passed **12 separate app-process phases**: the previous provider/
  storage six, followed by six for the actual coordinator. Coordinator sends,
  replies, history, exact retries, dedup and acceptance receipts survive those
  launches. Exact research Keychain/store cleanup and app uninstall passed.
- The **10 real-provider Rust tests** passed again; simulator and unsigned
  physical-iPhone targets compiled/linked. The physical binary was not executed.
- **147 focused TypeScript tests** passed, with no application setup or shared
  cache writes. No full app build or Capacitor sync is required for these unwired
  research files, and none is claimed for this checkpoint.

Review found and fixed two concrete traps. Swift's Unicode-equivalent string
comparison was unsuitable for exact receipts: incoming fields are now strictly
validated and compared as UTF-8 bytes. Two initial outgoing sessions would also
collide in a one-session store: the lower ASCII device ID alone may initiate;
the responder fails closed until its first valid receive. Tests cover both fixes.
This deterministic research role is **not** a complete messaging UX or session
arbitration/recovery implementation. Do not turn it into a shipping switch.

Scope remains deliberately bounded: 16 outbox items including terminal tombstones,
16 receives, 16 KiB UTF-8 text and a 1 MiB complete snapshot. The byte budget can
be hit before the item count. No eviction, pagination or production retention
policy is implied. Account setup, direct peer pinning and server receipts are
trusted synthetic fixtures; no directory ownership or response authentication has
been implemented. No live relay, app plugin/UI, attachments, group chat, browser
support, physical-lock/crash tests or independent security audit. Previous
licence, whole-database rollback and memory-erasure limitations still apply.

### Historical Signal experiment — not evidence for the new provider

The following results remain useful architectural research, but they do not
establish vodozemac iOS support, interoperability, negotiation or secure custody:

- `experiments/scuttlebutt-e2ee/host-proof.mjs` executed eight real native-library
  check groups: synthetic-peer round trips, prekey/session replay rejection,
  tamper rejection without changing committed receiving state, out-of-order
  delivery, changed identity rejection and subsequent bidirectional exchanges.
  It passed on this Apple Silicon Mac with Node 24 and Node 26.5. Its stores are
  in-memory test stores, not production secure storage.
- The host proof uses **npm 0.103.0**, gitHead
  `ba133bd3457f556fbf56db0a5ab985de0af79da6`, with the Darwin arm64 native hash
  checked before import. The script records the registry tarball integrity.
  npm 0.103.1 was unavailable when checked; do not describe these as 0.103.1 tests.
- `libsignal-pin.json` separately pins the **0.103.1 Swift candidate**, source
  commit `e8cc2dddd578859b4a029c9c94670b24ce2b616a`, and official iOS prebuild
  SHA-256. `native-api-probe.mjs` verifies source revision, clean Swift sources
  and archive hash, then compiles/links with one compiler worker in a temporary
  directory. Compile/link **and execution** of `NativeApiProbe.swift` passed in
  the arm64 iPhone 18 Pro simulator (iOS 27.0). Real Swift calls exchanged messages
  and rejected replay, tampering and changed identities, including 40 subsequent
  bidirectional rounds. This is simulator evidence, not a physical iPhone test.
- `native-store-probe.mjs` compiles/runs only two small Swift files on macOS,
  with one worker. **Six real SQLite groups passed**, independently rerun:
  exact retries/conflicts/reopen, injected transaction rollback, durable
  identity/account generations and logout cancellation, input bounds, SIGKILL
  immediately before/after COMMIT, and simultaneous two-process writer exclusion
  with bounded busy timeout and stale-revision rejection. WAL and synchronous
  FULL are checked at runtime. SIGKILL proves process-crash recovery for these
  cases, not host power-loss, disk failure or backup-rollback protection.
- **Three combined real-provider/storage groups passed in the iOS simulator**:
  prekey output survives database reopen and a reconstructed sender session
  produces a decryptable successor; injected pre-commit rollback permits safe
  discard/reprepare; two stale real provider preparations permit one commit and
  the loser can reprepare from the new state. Both prekey and session wire types
  were exercised. The simulator started for these tests was then shut down.
- No two-iPhone test, negotiated-suite assertion, full-app build,
  interoperability test or independent cryptographic audit has been completed.
  Agent review found retry races and added regression cases; it is not a
  substitute for the planned security review.

Historical commands (use external dependency/source/archive paths, not the app's packages):

```sh
node experiments/scuttlebutt-e2ee/host-proof.mjs /absolute/external/node_modules/@signalapp/libsignal-client/dist/index.js
node experiments/scuttlebutt-e2ee/native-api-probe.mjs /absolute/pinned/libsignal /absolute/verified/libsignal-client-ios-build-v0.103.1.tar.gz
node experiments/scuttlebutt-e2ee/native-store-probe.mjs
```

The host script includes the exact external install command. The Swift probe is
network-free, does not build Rust, and never starts a simulator. Supplying an
already-booted simulator UDID explicitly opts into executing the probe there.

## Native persistence experiment — not secure storage

`AtomicOutboxStore.swift` uses plain SQLite with fresh synthetic state only.
Do not put real account keys, real session state or user messages into this store.
It is not linked into the app and is not a replacement for a reviewed encrypted
database, Keychain key custody, iOS file protection or a backup policy.

Its send transaction validates the durable account/device and peer-identity
generations, compare-and-swaps the session revision, and inserts the exact output
bytes together. Retrying an existing message never rewrites the ratchet state.
Conflicting bytes/context reject. Logout, account/device changes and explicit
identity acceptance cancel old pending output; an identity changing A → B → A
cannot restore an old generation. Enumeration is bounded. These are local
guards, not authenticated device membership or server authorization.

`NativeProviderStoreProbe.swift` joins real libsignal sending-session callbacks
to that transaction in a separate test executable. Loads deserialize fresh
provider handles, writes stage serialized state, and dispatch bytes are returned
only after a successful commit. The probe exercises prekey and session messages,
database reopen with exact output retry, injected rollback/discard/reprepare, and
two stale provider preparations where only one revision may commit. Its temporary
SQLite files contain freshly generated **test** ratchet secrets, not user data;
they remain outside the repository. Identities, prekeys and receiving state are
still in memory, so this is not process-restart recovery of complete identities.

Production work still includes:

- A reviewed encrypted store/key lifecycle with protection for DB, WAL, SHM and
  temporary files; locked-device policy, reinstall and backup/restore behaviour.
  Plain SQLite and private-directory permissions do not establish key secrecy.
- Atomic native server-acceptance/rejection receipt commits; receiving-session,
  consumed-prekey, message and replay/dedup commits; authenticated account/trust
  sources. The experiment does not implement these paths.
- Bounded retention/pagination and secure deletion analysis. Old ratchet states
  are not copied into outbox rows, but WAL/backup copies still require review.
- Capturing and checking metadata inside the encrypted payload. This experiment's
  one-byte wire tag and the app's proposed outer JSON are not authenticated by
  framing alone and do not establish negotiated-suite support.

## Approved direction and remaining provider gates

Target private DMs first, encrypted by default once released. Public Scuttlebutt
channels remain public; private groups need a separate group-protocol decision.

Candidate: [vodozemac](https://github.com/matrix-org/vodozemac/tree/0.11.0), Apache-2.0,
using unchanged Olm v1. It offers the classical Double Ratchet, not Signal's Triple
Ratchet or post-quantum messaging. Future suite/version changes require explicit
review and migration; versioning alone does not make an upgrade secure. Do not
copy Signal's implementation into the app or modify the ratchet cryptography.

1. Review all resolved dependency licences/notices before distribution; the
   provider's Apache licence is not blanket legal clearance for every component.
2. Olm v1 uses an 8-byte / 64-bit truncated message MAC. The full-MAC v2 remains
   behind upstream's experimental flag. Do not quietly opt into it or describe
   Olm v1 as identical to Signal's protocol. Have the security review evaluate
   authentication bounds, rate limits and this trade-off. Earlier audits of the
   library do not cover this release plus Thalassa's integration automatically.
3. Prove a narrow native bridge around the unchanged Rust provider on simulator
   and supported real iPhones. The maintained `matrix-rust-components-swift`
   package is a full Matrix SDK, not a bare Olm/Supabase replacement; its normal
   room workflow uses Megolm. The official `vodozemac-bindings` repository is
   unmaintained. A small maintained-tooling bridge (for example UniFFI) needs
   independent review, state ownership, bounds, error handling and Swift tests.
   The isolated UniFFI/Swift research bridge now exists; generated bindings and
   iOS binaries stay outside the repository. It is not an app plugin or proof
   of physical-phone execution.
4. Bare Olm accepts keys, not an authenticated app device directory. Verify
   signed device/prekey material and bind ownership, identities, conversation
   context, freshness and recipient identity before accepting/decrypting data.
   A valid self-signature cannot prove the first signing key belongs to a user.
5. Decide browser support through a maintained, reviewed implementation. Never
   move private-key operations to a server to make the website work. Unsupported
   clients must not fall back to plaintext or silently downgrade the protocol.

## Current plaintext paths to replace together

| Boundary                       | Existing source                                                                         | Required change                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| DM send/history/inbox/realtime | `services/ChatService.ts`: `sendDMForScope`, `getDMThread` and subscription/inbox paths | New ciphertext transport and local decryption; no server-generated plaintext preview.                                                   |
| Offline queue                  | `ChatService.ts`: `queueOffline`, `syncOfflineQueue`                                    | Replace readable Preferences JSON for private DMs with protected drafts and a durable ciphertext outbox.                                |
| Optimistic reconciliation      | `hooks/chat/useChatDMs.ts`                                                              | Stable client message IDs, not text matching.                                                                                           |
| Guardian hails                 | `services/GuardianService.ts`: `sendHail`                                               | Direct DM-table insertion currently bypasses ChatService; route through the same protected boundary.                                    |
| Pin drops and recipe shares    | `ChatService.ts`: `sendPinDrop`, `sendRecipeShareDM`                                    | Encrypt the whole structured payload.                                                                                                   |
| Push                           | `supabase/migrations/20260723090000_security_hardening_core.sql`: `queue_dm_push`       | Currently copies message text into notification bodies. New pushes must be generic and contain no content/location preview.             |
| Storage                        | `services/auth/secureStorage.ts`, `services/nativeStorage.ts` and native plugins        | Existing allowlists do not provide a chat ratchet store. Build a dedicated audited storage boundary, not a blanket allowlist expansion. |

Existing 4,000-character text limits are not suitable ciphertext limits. Keep the
new format separate from the legacy `DirectMessage.message` field. The proposed
65 KiB ciphertext cap now matches the native provider boundary, not a promise
about supported body sizes. The native text-only prototype also bounds the
authenticated inner payload and complete sealed store. This does not authorize
attachments or uploads.

## Session, delivery and privacy invariants

- Supabase relays ciphertext and public device/prekey material only; secret keys
  and ratchet state remain on endpoints. Servers still learn routing metadata,
  timing and approximate sizes. E2EE is not anonymity or protection from a
  compromised phone, injected client code, or a recipient copying a message.
- Authenticate device identity, enforce account ownership/blocking on the
  server, and bind conversation/device/message context to provider-authenticated
  data. Outer IDs and protocol labels are untrusted until authenticated.
- Default encrypted sessions may use clearly labelled first-use trust; an
  optional fingerprint/QR verification adds a distinct verified state. Changed
  identities block sending until explicitly resolved. Never silently replace a
  trusted identity from a server response. Plan key-directory consistency and
  device-list authentication; TLS alone does not prevent server substitution.
- Serialize session operations. Atomically persist ratchet advancement **and**
  the exact ciphertext outbox item before upload; retry the same envelope.
  Enforce idempotency scoped to sender device, client message and recipient
  device. A timeout after server acceptance must not create a duplicate message.
- Receiving must atomically commit session state and local message/dedup state.
  Bound skipped-key storage and replay/out-of-order handling using provider
  mechanisms. Define crash, backup rollback, logout, reinstall and revocation
  behaviour before shipping. Protect local message history separately: forward
  secrecy does not hide plaintext history kept on an unlocked device.
- Start with an explicitly enforced single-device pilot; fail closed for an
  unsupported second device. Multi-device fanout and own-device copies come
  later, with authenticated device membership and revocation. Study Signal's
  [Sesame specification](https://signal.org/docs/specifications/sesame/).
- Encrypt future attachments client-side with independent keys, carrying keys
  and integrity metadata inside encrypted messages. No public plaintext URLs,
  telemetry, debug logs, moderation payloads or notification previews.
- Keep public-channel moderation separate. Private-message reports must be an
  explicit user disclosure of selected content, not automatic server scanning.

## Safe cutover and acceptance gates

1. **Provider spike:** license decision, pinned dependency, two real iPhones
   exchange messages with confirmed negotiated suite; native store design and
   locked-device/logout behaviour documented. No live chat switch yet.
2. **Transport:** reviewed device/prekey/envelope schema, strict RLS, atomic
   prekey claims, idempotency, rate/size/expiry bounds; generic push. Validate
   the experimental framing against provider bytes before freezing version 1.
3. **Client integration:** one authenticated send/decrypt boundary covers all
   paths above; replace plaintext private queues and previews. Preserve current
   account-generation and bilateral-block race protections.
4. **Adversarial verification:** tampering, replay, missing/out-of-order messages,
   concurrent sends, prekey exhaustion, key change, downgrade, offline retry,
   crash at each persistence boundary, account switch and restore tests. Inspect
   captured requests, stored rows, notifications and logs for plaintext leaks.
   Mock tests alone do not validate cryptographic integration.
5. **Release:** independent security review and device tests before security
   claims. Badge distinguishes encrypted from fingerprint-verified and from
   unavailable. Legacy clients cannot write plaintext after cutover. Existing
   server-readable history is never retrospectively labelled E2EE. Although the
   owner previously allowed test-message deletion, do not delete anything in
   this checkpoint; confirm exact cleanup scope at migration time.

Next: integrate the bounded native coordinator with a reviewed authenticated
account/device lifecycle and an off-by-default app adapter, add lock/crash tests
on real phones, then authenticated device/prekey
relay tests in an isolated database. The synthetic single-prekey fixture is not
a production registration or replenishment design. No new
Supabase schema should inherit Signal/Kyber bundle fields from the earlier relay
notes. Single-device pilot first; existing app messages remain untouched. Use
the reproduction instructions in `experiments/scuttlebutt-e2ee/vodozemac-probe/README.md`.
Before any integration merge, update
from current master and coordinate deployment with the other agent. Do not merge
or deploy this branch as completed E2EE.

Primary sources checked for the provider decision (not legal clearance):

- [libsignal licence](https://github.com/signalapp/libsignal/blob/main/LICENSE)
  and [GNU linking guidance](https://www.gnu.org/licenses/gpl-faq.html#LinkingWithGPL).
- [vodozemac package licence](https://github.com/matrix-org/vodozemac/blob/main/Cargo.toml),
  [protocols and audit reference](https://github.com/matrix-org/vodozemac), and
  [Matrix Rust SDK / Swift binding direction](https://github.com/matrix-org/matrix-rust-sdk).
- [Matrix security team's February 2026 analysis](https://matrix.org/blog/2026/02/analysis-of-reported-issues-in-vodozemac/)
  highlights authenticated key-distribution assumptions. Its account of those
  issues is not a new audit of our proposed non-Matrix/Supabase integration.
