# Scuttlebutt private-message E2EE — isolated checkpoint

Updated: 30 September 2026. Branch: `codex/scuttlebutt-e2ee-foundation`.

## What exists today

This is an isolated framing/delivery prototype plus a real-library research
spike, **not functioning E2EE in Thalassa**. Nothing is wired into live chat.
No app dependency, native plugin, database change, UI badge, production deployment
or message deletion is included. Research dependencies and build artifacts stay
outside the repository; no third-party library binaries are committed.

`services/chat/e2ee/directMessageEnvelope.ts` proposes bounded, versioned,
per-device framing for opaque provider bytes. It rejects legacy text, unknown
protocols and extra fields (including plaintext previews and keys). Its tests
prove framing behaviour only. Anyone can base64-encode plaintext and put it in
the ciphertext field: passing validation proves neither encryption nor sender
authenticity. Do not use this validator to display a security badge. A required
`prekey`/`session` message discriminator selects the provider's decrypt API;
libsignal serialization alone does not provide that dispatch value. Like other
outer fields, the discriminator is not independently authenticated by framing.

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

- **136 focused tests passed**: 37 framing tests and 99 mocked delivery tests,
  with one worker and no app setup. Isolated strict TypeScript checking passed.
  Run only these files while other agents are building; no full app suite is
  needed for this unwired checkpoint.
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
  directory. That compile/link passed for arm64 iOS Simulator with this Mac's
  Xcode toolchain. **The Swift executable was not run; no simulator was booted.**
  `NativeApiProbe.swift` is an executable test candidate, not runtime evidence.
- No two-iPhone test, crash/persistence test, negotiated-suite assertion,
  full-app build, interoperability test or independent cryptographic audit has
  been completed. Agent review found retry races and added regression cases;
  it is not a substitute for the planned security review.

Commands (use external dependency/source/archive paths, not the app's packages):

```sh
node experiments/scuttlebutt-e2ee/host-proof.mjs /absolute/external/node_modules/@signalapp/libsignal-client/dist/index.js
node experiments/scuttlebutt-e2ee/native-api-probe.mjs /absolute/pinned/libsignal /absolute/verified/libsignal-client-ios-build-v0.103.1.tar.gz
```

The host script includes the exact external install command. The Swift probe is
network-free, does not build Rust, and never starts a simulator. Supplying an
already-booted simulator UDID explicitly opts into executing the probe there.

## Direction and unresolved provider gate

Target private DMs first, encrypted by default once released. Public Scuttlebutt
channels remain public; private groups need a separate group-protocol decision.

Signal's [Triple Ratchet specification](https://signal.org/docs/specifications/doubleratchet/)
combines its classical Double Ratchet with a Sparse Post-Quantum Ratchet. PQXDH
can establish the initial session. AES-256 alone is not that protocol; we will
not implement the ratchets or select replacement primitives ourselves.

Candidate: [libsignal](https://github.com/signalapp/libsignal), whose Rust core
has Swift, Java and TypeScript wrappers. Its repository lists AGPL-3.0 and says
external use is unsupported. Its npm distribution uses native Node libraries,
not a drop-in browser/WebView implementation. **Do not add it to the app yet.**
Temporary, isolated research does not resolve these adoption gates:

1. Resolve licensing/distribution suitability before adoption; this document is
   not a legal conclusion or permission to change Thalassa's licensing.
2. Prove the pinned Swift API's required Triple Ratchet negotiation and message
   processing on supported iPhones. Reviewed source initializes fresh sessions
   with SPQR V1 minimum V1, but Swift's `hasCurrentState` is not a negotiated-suite
   getter: it can accept an unacknowledged outgoing session. Do not infer a green
   security badge from it or from message version 4. A reviewed native capability
   boundary and executable negotiation tests are still needed. The upstream
   Swift README recommends CocoaPods for consumers; SwiftPM consumer support is
   not an established integration path.
3. Decide browser support through a maintained, reviewed implementation. Never
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
256 KiB ciphertext cap is an abuse bound pending provider measurement, not a promise
about supported payload sizes. It does not authorize attachments or uploads.

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

Next: execute the isolated Swift probe when shared Mac resources permit; settle
licensing/distribution and the native negotiated-suite boundary, then design the
atomic secure store and two-device spike. Before any integration merge, update
from current master and coordinate deployment with the other agent. Do not merge
or deploy this branch as completed E2EE.
