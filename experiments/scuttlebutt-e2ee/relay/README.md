# Isolated device-directory and ciphertext-relay research

This directory prototypes a device-signed, account-authorized, single-device relay boundary.
It includes a Fetch HTTP handler, native networking research client and explicitly
isolated hosted Supabase pilot. It is not a production service/migration or shipping
app adapter. It
does not encrypt messages and is not connected to Thalassa chat, push notifications
or production accounts. An optional simulator bridge exercises it with the real
native provider and sealed stores; existing app messages are untouched.

`deviceBundle.ts` defines canonical public bundle framing and verifies real
Ed25519 signatures. `signedGateway.ts` exposes signed dispatch and registration;
the older `gateway.ts` is internal/legacy research, not a public unsigned endpoint.
`supabaseAuth.ts` implements fresh server-side Auth HTTP verification. `relay.sql` owns the
bounded directory, prekey reservations, block state and immutable message
decisions. `proof.mjs` runs those files against an on-disk PGlite database with
synthetic account credentials and payloads. A test existing in the runner is not
a claim that it passed; use the completed run output and checkpoint record for
observed results.

## Local durable cutover and generic notification fixtures

`relay.sql` now supports signed `require-protected` and fresh `account-mode`, both
with the exact payload `[]`. The four-field receipt reports durable account policy,
not encryption or device permission. Existing peer-policy fields and signed-wire
version/domain are unchanged. No downgrade API exists. New native actions have
not been integrated or deployed to the hosted pilot.

`privateNotifications.sql` and `legacyCutoverFixture.sql` install only into a
fresh local fixture after `relay.sql`. They are not migrations. The first queues
one accepted-decision notification with fixed generic content and an opaque
server UUID. The second stands in for legacy messages and private previews to
test denial/suppression while preserving old bytes. Its caller-settable GUC
identity is explicitly mocked, not authenticated. Private policy tables and
helpers remain ungranted; only narrow processor claims/acknowledgements and the
necessary synthetic-client RLS gate are exposed.

Reproduce with an already-owned archive matching `pglite-pin.json`; this runner
does not fetch/install anything or write shared dependencies:

```sh
pgrep -fl "vite build|tsc|vitest"
node --experimental-strip-types experiments/scuttlebutt-e2ee/relay/cutoverProof.mjs /absolute/path/pglite.tgz
```

The runner retains source copies/hashes and a sanitized receipt in a fresh private
temporary directory. SQL runs on disk with real Ed25519 fixture signatures and
synthetic Auth/legacy identity/ciphertext; close/reopen is persistence evidence,
not independent-connection concurrency or device encryption. See the
[checkpoint](../../../docs/SCUTTLEBUTT_E2EE_CHECKPOINT.md) and
[server manifest](../review/server-cutover-2026-10-06.json) for executed results.
No external sink, worker enumeration or claim expiry/reclaim is installed.
Repeated same-token projections require sink deduplication; post-claim block or
revocation cannot retract an already dispatched notification. No delivery/read
or exactly-once push claim follows from a unique SQL row.

## Isolated hosted pilot — not app encryption

The owner-approved test project is `kmtupdvwdgbhtssqqova` in organization
`tideqlkywysyczrqreiz`, not Thalassa production. `hostedGateway.ts` pins its origin,
trusted runtime mounting, dedicated database DSN and at most two participant
UUIDs. An empty allowlist closes access. Fresh Supabase `/auth/v1/user` and device
signatures gate only three parameterized signed-path RPCs; the login has no owner
or table privileges. The PostgreSQL client closes after each committed/rolled-back
transaction. Connection-budget refusals remain unresolved, never terminal sends.
This deliberately bounded host has no production concurrency/availability proof.

`../hosted/provision.mjs bootstrap` is a fresh-project-only guarded setup; never
rerun it to reset keys or messages. Config/link/project/organization checks refuse
other targets. `repair-gateway-schema` restores only gateway schema USAGE under
the owner role; no elevated grants or data rewrite. The ordinary app has no pilot
configuration, plugin registration or live chat cutover.

`../hosted/updatePolicy.mjs` defaults to read-only inspection of the existing
approved pilot. Explicit `apply-policy` replaces only three pinned function
definitions under the pilot lock, with exact precommit data/catalog/authority
preservation checks. It never reruns bootstrap or its unsigned privilege grants.
`../hosted/deployPolicy.mjs --deploy /absolute/private/policy-update-receipt.json`
requires an applied SQL receipt, deploys only the named pilot Edge function with
JWT enabled, and checks unchanged secret metadata, SQL state and bounded negative
HTTP responses. Neither script enrolls accounts, rotates keys, changes the
participant allowlist or touches production. Negative checks and definition
hashes cannot substitute for a positive signed policy/native exchange. See the
checkpoint for the 4 October executed deployment and retained failed preflights.

`../hosted/fixtureRelayProof.mjs HUMAN_ALLOWLIST_FILE [FIXTURE_CREDENTIALS_FILE]`
uses two disposable `.invalid` actors, not the phone accounts. Private credentials
and signing fixtures stay in 0700/0600 temporary artifacts outside the repo.
The wrapper temporarily installs the fixture allowlist, runs `liveProof.mjs`,
then restores the human allowlist even on failed assertions. It never resets
immutable devices/prekeys to make a test pass. CLI children opt out of telemetry
for that process only; secret-bearing outputs/errors are suppressed.

The completed hosted smoke proof uses real Auth, Ed25519 signatures, HTTPS and
SQL, but **synthetic ciphertext only**. It is not a native encrypted exchange,
physical-device delivery or independent security review. Its receipt records
local source hashes and the unchanged deployed function revision/bundle hash;
these are execution identifiers, not independent binary/source attestation.
The simulator Olm proof and the hosted relay proof remain separate milestones.

## HTTP and native network contract

`httpGateway.ts` exposes only two exact HTTPS POST endpoints at its configured
service origin: `/v1/register` accepts the unchanged signed public bundle (4,096
bytes maximum), and `/v1/dispatch` accepts the unchanged signed request (100 KiB
maximum). Bodies are canonical printable-ASCII JSON, not a JSON-encoded string
wrapper. The `Authorization` header carries one bounded RFC 6750 Bearer token;
only the gateway's fresh Auth result identifies the account. Cookies, Origin/CORS,
compressed request bodies, unsigned endpoints and alternate origins are refused.
The host must preserve/reject duplicate headers and supply trusted HTTPS routing;
the generic handler's fixture tests alone do not prove a host mounting adapter.
The separately pinned hosted adapter and its live evidence are described below.

Success is HTTP 200 with exact outer framing `{"version":1,"result":...}` and at
most 2 MiB of complete UTF-8 JSON. Both success and errors use `no-store` and
`nosniff`; all error bodies are `{"version":1,"error":"request-unresolved"}`.
Boundary errors may use 400/401/404/405/413/415, downstream failure 503, and a
deadline 504. None is an authenticated terminal message refusal. Actual accepted
or refused sends use the existing exact-record receipt inside a successful result.
Bounded result encoding rejects getters, custom serializers, cycles, sparse arrays,
non-JSON values and excessive depth/node counts.

Both HTTP and Auth use a timer plus monotonic elapsed checks across body reads,
downstream work and synchronous parsing/encoding. Tiny or empty stream chunks
cannot postpone the deadline by continuously replenishing the microtask queue.
An HTTP timeout or disconnect does **not** cancel/roll back a possibly committed
SQL operation; its later result is observed, not relabelled as a refusal.

`../VodozemacRelayTransport.swift` provides a per-operation ephemeral URLSession
with no URL cache, stored credentials or cookies. Only HTTPS configured origins
are accepted, redirects are refused and TLS uses the system's normal trust
evaluation—there is no trust-bypass delegate. Declared and streamed response sizes
are bounded independently. A continuous-clock deadline is checked before dispatch,
inside the once-only completion gate and after awaiting; a timer also cancels
stalled requests. The complete response must be valid JSON before extracting its
strict outer result, preventing mixed UTF-8/UTF-16/32 fragment parsing.

The native transport captures account/device, owner generation, credential epoch and
optional peer generation, checking the supplied current native context before
resume and after await. The research relay adapter now additionally checks the
coordinator's sealed active flag, durable generation/credential epoch and accepted
peer in one native snapshot, **after** evaluating that external reader. Captured
epochs also fence native signing/receipt/receive transactions and their sealed CAS.
Account attestation and bearer tokens remain fixtures: this does **not** integrate
app Auth, refresh tokens, or make a callback/JavaScript assertion authoritative. A transition
after the preflight check can still reach the server; stale results are discarded,
and existing coordinator owner/peer/CAS guards remain mandatory before accepting
a receipt or releasing decrypted content. The client returns public JSON result
bytes, never a delivery decision or plaintext. Endpoint-specific result validation
is still the coordinator/adapter's responsibility.

Retry exactly the stored signed request and ciphertext. Once its signature expires,
reconcile the same durable ciphertext/message ID using a newly signed request with
a **new** request ID. Changing an existing nonce's expiry/wire conflicts with the
request ledger. Networking must never re-encrypt an uncertain send or silently
discard its pending outbox.

Native default ephemeral behaviour and redirect controls are documented by Apple:
[`ephemeral`](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/ephemeral),
[`willPerformHTTPRedirection`](<https://developer.apple.com/documentation/foundation/urlsessiontaskdelegate/urlsession(_:task:willperformhttpredirection:newrequest:completionhandler:)>).
Apple's [`timeoutIntervalForRequest`](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/timeoutintervalforrequest)
resets on received data; that is why this client also has an independent whole deadline.

New reproduction runners (after checking the shared build slot):

```sh
node experiments/scuttlebutt-e2ee/relay/nativeTransportProof.mjs
node --experimental-strip-types experiments/scuttlebutt-e2ee/relay/httpProof.mjs /absolute/path/pglite.tgz
```

The native runner executes **URLProtocol response fixtures on the Mac** and compiles
for simulator/iPhone; it does not run a physical phone or prove native TLS/live
Auth. The HTTP runner uses real localhost HTTPS, normal certificate/hostname
verification with a fresh request-local fixture CA, real device signatures and
the pinned on-disk PostgreSQL engine. Auth HTTP responses and ciphertext are
explicit fixtures. Its Node socket adapter buffers up to 256 KiB before the
Fetch handler; stalled-body/disconnect/deadline cases remain unit fixtures, not
socket-level host adapter evidence. No global CA is changed, no production account
or schema is used, and test certificates/database artifacts stay in a fresh
temporary directory. The previous native-provider/relay proof and this HTTPS
proof are separate: this does not claim a native-to-live-service encrypted exchange.

## Native Auth continuation (unwired)

`../VodozemacSupabaseAuth.swift` verifies a supplied access token afresh at the
trusted configured project's `/auth/v1/user`, using ordinary system TLS and a
bounded ephemeral URLSession. Only its unique canonical top-level user UUID is
used; metadata/local JWT claims cannot choose an actor. Public-key configuration,
exact origin/URL, redirects, UTF-8, duplicate IDs, header/body caps and monotonic
timeout are checked. See [Supabase's server getUser boundary](https://supabase.com/docs/reference/swift/auth-getuser).

`../VodozemacAuthSession.swift` is native continuation for one existing immutable
owner/device store, not a login SDK or Capacitor plugin. Native store UUID owns
the device label; the trusted issuer is sealed on first successful continuation.
Restart has no bearer/readiness. Each verification clears the prior lease and
reserves a durable epoch BEFORE HTTP. Full-lifecycle tickets and sealed CAS fence
refresh/logout/account-switch races. Accepted renewal preserves pending ciphertext;
resume advances owner generation without reviving historical sends. Bearers remain
in memory, with a fixed maximum 60-second monotonic verified lease captured before
awaiting Auth (including network time), not restarted after OS suspension or slow
storage, and not on disk or in JS. Verification failure does not restore a prior token.

Local logout clears memory first and retries only unconditional deactivation's
competing revision at most three times; exhaustion is failure, not a guarantee
that another session is inactive. Expected-ticket mismatches never retry. There is
no remote logout/revocation claim. Initial verified identity provisioning, account
store selection, SDK token/event acquisition, device registration/replenishment
and app wiring still need implementation. Research coordinator entry points are
not a shipping authorization API. The new Auth probe deliberately uses mocked
URLProtocol responses alongside real native crypto/sealed state. It does not
prove live Supabase, TLS, a physical phone or an independent security review.

## Combined native/local HTTPS research proof

`nativeExchangeProof.mjs` now connects the real native sealed coordinator, strict
result codec and relay client to `nativeExchangeServer.mjs` over HTTPS. Supply an
existing completed native-relay build cache and the pinned PGlite archive; it
does not download/install dependencies or mutate the primary Xcode project:

```sh
node --experimental-strip-types experiments/scuttlebutt-e2ee/relay/nativeExchangeProof.mjs /absolute/path/native-cache /absolute/path/pglite.tgz
```

This runner **creates, boots and removes one fresh disposable simulator** using
an already installed iOS 26.5 runtime. It first requires a real untrusted TLS
handshake refusal with zero HTTP/Auth calls, then trusts its fresh one-day test
certificate **only in that simulator**. Native URLSession keeps normal trust;
there is no URLProtocol mock, custom challenge acceptance or ATS exception. No
existing simulator, Mac/system trust store, phone, production account or app
changes. The fixture CA disappears with the disposable device.

Four actual native Olm messages are required by the current reproduction runner
to cross the signed gateway/on-disk SQL boundary, including one after durable
same-account sign-out/resume and process restart.
Lost response, wrong receipt, structural and cryptographic poison, native process
restart, exact-ciphertext retry, duplicates and SQL reopen are checked. Both
logical clients share one research app/simulator. Account/token attestation
and independently exchanged peer pins remain fixtures; epoch/generation/active
state is now native-owned and persisted: this is not live Supabase
Auth, two physical phones or security review. Cache manifest/lock/source/binary
hashes are recorded; reuse is not a fresh Rust build or independently attested
binary provenance. Read the checkpoint for observed run evidence.

The native client validates a complete inbox page before mutations, but commits
each authenticated row individually. It re-scans from zero within a bounded
single-peer store; it does not advance/persist a sync cursor. Structural poison
rejects the whole page. Typed incoming-message failures are retained in a sealed
unresolved ledger without committing speculative session/account/prekey changes;
later valid rows may proceed. This does not classify intent or establish permanent
failure: a legitimate message beyond the provider's gap limit can also be unresolved.
The adapter returns counts, not successful plaintext for failed rows or read receipts.
Owner/peer generation changes still hide old history. Under the same immutable
device/key scope, a separate read-only helper recognises exact previously saved
envelopes as **historical**, so they do not stall later rows. It neither decrypts
them again nor re-tags/restores old plaintext. Strict direct receive remains
generation-bound, and old pending sends are never rebound after reauthentication.
Unseen older ciphertext cannot be distinguished from a newly arriving message
by these wire fields. Device/key replacement is unsupported, not handled by this
helper. The sealed coordinator snapshot is now version 4; older research stores
are refused, never silently recreated/migrated into active identities.

The unchanged pinned provider is wrapped by a narrow `MessageNotOpened` boundary:
local pickle/key/configuration/output failures never become deferred-message
results. Local provider restoration precedes incoming wire inspection. Only this
typed failure or an isolated authenticated-content binding failure can defer;
identity/frame/metadata conflicts, capacity, storage and CAS errors still stop.
The queue retains exact server ID, record fields and ciphertext under the original
local owner/peer generations. Those bindings survive successful promotion. A
rescan never retries crypto, evicts ciphertext, restores old history or rebinds an
old queue. Explicit same-generation retry atomically promotes a successful receive;
a failed retry retains the exact original payload with a fencing CAS. A single
16-row inbox-plus-unresolved budget and the sealed-store byte cap fail closed,
without eviction. Capacity/retention policy and scalable recovery remain shipping
work; this research queue is not a production mailbox or user-facing retry UI.
Read the checkpoint for fresh-build and simulator execution evidence; source
review alone does not establish that the new native error boundary was executed.
Scalable sync, actual Auth lifecycle/attestation, device/prekey renewal and
independent review remain required before app integration. No silent discard,
plaintext fallback or security badge is added by this prototype.

## Trust boundary

The gateway host must validate each credential and derive `userId` independently
of the request body. `supabaseAuth.ts` makes a fresh, bounded GET to a trusted
HTTPS project origin's `/auth/v1/user`, using only a public API key and the supplied
bearer token. Redirects, failures, invalid IDs and oversized/stalled responses
fail closed. Only the Auth server's canonical UUID `id` selects an actor; editable
metadata and locally decoded user JWT claims never do. Supabase's documented
[`getUser(jwt)`](https://supabase.com/docs/reference/javascript/auth-getuser)
contacts its Auth server and returns identity suitable for authorization. That
is the source for that boundary. Adapter tests and the native bridge inject Auth
HTTP responses. They do not contact live Auth, test real token revocation, or
establish logout/session binding. A fresh Auth check is not a claimed guarantee
that every previously issued token becomes invalid immediately on logout.

SQL receives the actor as a trusted gateway argument. The private gateway role
must never be given to app clients. A caller holding that role can assert an
actor; SQL cannot distinguish such an assertion from a properly authenticated
gateway call. Only the eight declared RPCs are executable by the gateway role. Client roles
have no schema/table/RPC access, and the gateway has no direct table or helper
function access. Roles are non-login roles with no privileged attributes.
Creation fails if the research roles or schema already exist.

Tables enable RLS with no client policies. The non-login table owner's
`SECURITY DEFINER` functions intentionally use owner access and perform explicit
ownership checks. This is a private function boundary, not a demonstration that
Supabase client RLS policies are integrated. Functions use a fixed search path,
qualified relations and bounded inputs. Gateway errors discard Auth, SQL and
cryptographic exception details.

A bundle signature binds its account/device IDs, identity reference, Ed25519
signing key, Curve25519 identity key, one-time prekey ID/key and expiry to the
signing key. The gateway checks that the account ID equals the authenticated
actor. A self-signature alone does not authenticate the first key's ownership;
the injected authenticated actor supplies that account binding. This does not
provide fingerprint verification, key transparency, or protection against a
malicious directory replacing first-use key material. Peer pinning and identity
change handling remain client responsibilities.

Registration proves signing-key possession. Subsequent requests require both
fresh account authentication and an Ed25519 signature verified against the
immutable registered signing key obtained through private SQL lookup, never a
key supplied in the request. `signedRequest.ts` binds account/device, action,
nonce, expiry and exact canonical payload in the `thalassa-relay-request` array
domain. The wire is fixed-order printable ASCII JSON, at most 100 KiB; expiry
must be a future integer no more than 300 seconds ahead. Lookup still returns a
revoked device's immutable public key so old receipts can be authenticated;
current SQL policy controls new actions and read/claim retries.
Signing-key possession does not establish physical device identity, independent
first-key verification or protection from a compromised native process.
`ownerSessionGeneration` and `recipientIdentityGeneration` are immutable record
comparison fields and local lifecycle guards, not server authentication claims.

### Current bilateral policy read

The signed `policy` action takes canonical
`[peerUserId,peerDeviceId,peerIdentityKeyId]`. Its reply has exactly six string
bindings (`requestId`, owner user/device, peer user/device/identity reference)
and four strict booleans: `ownerRevoked`, `peerRevoked`, `blockedByMe` and
`blockedByPeer`. The gateway verifies fresh Auth and the immutable registered
request-signing key; the reply is authenticated by HTTPS, not independently
signed. Native matches all bindings to its saved request and full sealed pin.

SQL recomputes flags under the pilot lock on every read, including exact nonce
replay. Known revoked devices may read their denial state; unknown or mismatched
targets refuse. Policy reads do not write or exhaust the mutation nonce ledger.
They do not create a send grant or alter immutable terminal decisions.

The scoped native client explicitly refreshes policy before protected work.
Each derived permit is memory-only and expires five seconds after the native
request's original monotonic start. Refresh first invalidates old permission;
send/inbox completion cannot adopt a replacement permit. Acceptance/inbox
commit guards require the original paired permit, while only an exact terminal
refusal may settle via the original owner-only lease. A later remote change can
occur during this bounded interval: authoritative SQL still decides new actions.
This is research gating, not finished polling, trusted time across restart or a
production latency policy. These SQL/gateway changes are deployed only to the
isolated hosted pilot, with preservation and negative HTTP checks. No positive
signed native-to-hosted policy exchange has run.

## Separate native research app

The standalone `bridge-web/` screen now exposes explicit research messaging
through the existing `ScuttlebuttResearchAuth` plugin. Auth and messaging share
one JavaScript proxy and the exact same native host/facade. This is not the
shipping `PrivateMessageNativePort`; the primary app and live chat are unchanged.
The native host pins the pilot origin, conversation and hosted function mount.

Each message call carries only the expected Auth `credentialBinding` and its
bounded public inputs: a public pairing card/fingerprint or a message ID/text.
Native derives account/device, owner/peer generations, policy authority, clocks,
transport and storage. No keys, pickles, credentials, raw records, request wires,
server responses or arbitrary callbacks are returned to JavaScript.

`ResearchMessagingAdapter.swift` returns exact public setup facts, canonical
pairing cards, guarded committed plaintext rows, prepared IDs and historical
send/inbox outcomes. Its native-only `publish()` rechecks the original snapshot
immediately before plugin resolution. Accepted/inbox outcomes are nonplaintext
historical facts, not renewed policy permits; their commits already passed the
scoped client's original-policy guard. Terminal rejection alone retains the
captured original owner-only completion authority.

The UI requires explicit registration, native card inspection and a full
fingerprint comparison on the other device before confirmation. Only the native
initiator claims the peer prekey. Send and Receive explicitly refresh policy;
neither registration nor clear diagnostic flags create an encryption/readiness
badge. A pending attempt reconciles native history and retries the same durable
ID, never prepares replacement ciphertext. A nonplaintext scheduling barrier
survives hide/Auth changes until the admitted action settles, while visible
messages, drafts, pairing cards and old UI tickets clear immediately. Literal
text-node rendering is tested with hostile-looking text; this is not a claim of
OS clipboard or secure-memory erasure.

Cold launch now fences credentials and reopens only an exact sealed, selected,
ready and active owner. Fresh same-account Auth is required before access;
bearers, Auth leases and policy permits are never restored. Native close/reopen
fixtures preserve ratchet/history and pending ciphertext, but no physical
force-kill or power-loss case has run. Explicit logout still quarantines the
old generation; no account/device replacement or prekey replenishment exists. Hosted
policy SQL/gateway changes are deployed only to the pilot, with preservation and
negative HTTP evidence, not a positive signed policy/native exchange. The human
allowlist metadata and unused human device slots were checked read-only on
4 October; recheck before enrollment. The separate research app is now signed,
installed and its process launched on both devices. Actual Capacitor invocation,
human login and the iPhone–iPad exchange remain unverified. Do not rerun provisioning
or delete immutable rows to bypass those blocks. See the checkpoint for exact
fixture, browser, compile and physical-test evidence categories.

`bridge-native/signDevice.mjs` defaults to offline inspection of a hash-matched
unsigned research app, a matching development identity and a profile for exactly
the two selected devices. Only explicit `--sign` signs a new private copy, with
the exact research bundle and minimal entitlements. Embedded frameworks/dylibs
must be unsigned; cached signed inputs refuse safely. It does not provision,
build, install, launch or call the server. Its 37 validator/command fixtures are
not real CMS trust, code signing or device acceptance. A matching owner-approved
research profile now exists; its optional Apple token authorization and companion
platform labels never become extra app entitlements. A corrected optional
certificate-extraction flag passed actual local strict signing checks. Separate
device commands installed and launched that verified artifact on both endpoints;
see the checkpoint for retained failed attempts and receipts. CMS decoding and
local selected-certificate trust are not independent CMS authority or fresh
revocation proof. Never reuse the normal app's identifier, profile or Keychain
groups. No verified device SDK/native login, enrollment or physical message
exchange has passed. The owner reports an iPhone login problem; a Mac-only Auth
diagnostic accepts that account's stored test credentials. The on-phone failure
stage and iPad native verification still need evidence.

## Directory and reservation contract

Each account can register exactly one immutable device for its entire lifetime
in this disposable database. Device IDs are globally unique. An exact unchanged
registration retry is idempotent; changing keys or device IDs conflicts.
Revocation is permanent. No replacement, account/device recovery, key rotation,
second device, bundle renewal or prekey replenishment exists.

The bundle is compact canonical JSON with exactly the declared fields and order.
Public keys are 32-byte canonical unpadded standard Base64; the signature is 64
bytes in the same encoding. New registration requires an integer expiry after
the trusted current time and no more than seven days ahead. SQL repeats
structural, ownership and new-registration expiry checks, but relies on the
gateway for signature verification. SQL can replay an unchanged registration
after expiry; the gateway's freshness check rejects that expired request before
SQL. Neither path makes an expired prekey claimable.

There is one public prekey per device. A claim binds the authenticated owner,
sender device and request ID to one target account/device. Exact retries return
the same reservation; changing the target conflicts. Another requester or a new
request ID cannot claim the already reserved key. Claim retries recheck active
devices, target expiry and bilateral blocks. No reservation is recycled after a
timeout, block, revocation or expiry.

Directory reservation does not consume the recipient's native private prekey;
only a successful authenticated native receive can do that. Several Olm messages
can retain `messageType: prekey` before a reply, so this relay does not demand a
new claim for each such envelope. Native prekey consumption and relay reservation
are not integrated in this experiment. Same-account sends, claims and blocks are
unsupported and rejected at both gateway and SQL boundaries.

## Relay decisions and reads

Signed execution atomically stores a bounded request ledger with the operation.
An exact nonce/wire retry does not reapply block/revoke mutations or manufacture
a second message decision. Changed wire under that nonce fails. Cached key claims
recheck both devices, target expiry and current blocks. Cached reads require an
active recipient and filter the original snapshot against current blocks; they
never add later messages or rewrite the stored snapshot. Send receipts remain
immutable even after lifecycle changes. Gateway expiry is checked before and
after asynchronous key verification; an expired proof must be replaced with a
new nonce/signature, while the exact ciphertext message ID remains unchanged.
The message ledger then reconciles its original terminal decision. SQL-only
receipt replay can outlive the proof's TTL; this is not an expired-proof exception
in the signed gateway.

The durable key is `(owner, sender device, client message ID, recipient device)`.
The stored record includes both account IDs, recipient identity reference, both
local generations and the exact canonical serialized envelope. The envelope is
stored as text, not a parsed JSONB replacement. Framing requires envelope v2,
`olm-v1`, a `prekey`/`session` discriminator, strict ASCII IDs and canonical
padded ciphertext Base64. This validates framing, not encryption.

After authenticating the owner and registered sender ownership, SQL checks for
an existing decision before evaluating current block/revocation state. An exact
retry returns the original receipt. Changed fields or bytes under the same key
return `record-conflict` without modifying the winning record. For a new key,
recipient ownership and identity must match the directory, then acceptance or a
`blocked`/`device-revoked` refusal is committed atomically. Invalid requests and
capacity failures throw; they do not fabricate terminal receipts.

An accepted record remains accepted after a subsequent block or revocation.
A blocked rejection remains rejected after unblock. Conflicts remain conflicts
because the winning record is retained. No terminal row is evicted or deleted.
The gateway validates every send receipt against the exact submitted record and
requires the SQL adapter to resolve only after commit. The proof's adapter uses
that transaction boundary and can inject rollback after SQL produces a result.
Exceptions, rollback and network timeouts are not terminal server decisions.
Acceptance means server commitment only, not recipient delivery or reading.

Reads return only accepted records for the active recipient account/device,
ordered by increasing server ID, with a batch of at most 16. Bilaterally blocked
senders are filtered at read time. This creates a cursor limitation: advancing
past other messages while one sender is blocked can skip that sender's earlier
accepted records after unblock. A future client needs cursor reconciliation or
a deliberate revisit strategy on unblock. This experiment implements neither a
complete inbox sync protocol nor a delivery/read acknowledgement scheme.

All directory, claim, block, send and list operations acquire the same
transaction-scoped advisory lock. They require `READ COMMITTED`; an older
repeatable snapshot must not hide a lifecycle change committed before the lock
was acquired. This deliberately serializes the pilot and is not a scalable
design. PGlite exposes one exclusive database connection, so this runner cannot
prove contention between independent PostgreSQL connections, lock ordering
under real concurrent clients, or distributed gateway behavior. See the official
[PGlite documentation](https://pglite.dev/docs/).

Bounds are intentionally fixed and have no eviction policy:

| Resource                                         | Limit                                             |
| ------------------------------------------------ | ------------------------------------------------- |
| Registered devices, including revoked            | 64 total                                          |
| Immutable relay decisions                        | 256 per owner                                     |
| Signed request ledger                            | 512 per owner; no eviction                        |
| Prekey reservations                              | 64 per owner; one total per target device         |
| Block relationships, including unblocked entries | 64 per owner                                      |
| Read batch                                       | 1–16 records                                      |
| Identifiers                                      | 1–128 ASCII characters from `A-Z a-z 0-9 . _ : -` |
| Public bundle                                    | 4,096 ASCII characters                            |
| Signed request wire / proof lifetime             | 100 KiB / at most 300 seconds                     |
| Decoded envelope ciphertext                      | 65 KiB                                            |
| Serialized envelope                              | 90,156 bytes                                      |
| Local generations and read cursor                | Integer from 0 through 9,007,199,254,740,991      |

Exact decision retries remain available at the owner cap. The per-owner bounds
are not a rate limiter or small global storage guarantee: the maximum admitted
ciphertext across all owners can exceed a gigabyte. No production retention,
quota allocation or abuse-control design is implied.

## Reproduction

Use Node 24 on the shared Mac, from the repository root. Honor the checkpoint's
one-heavy-job-at-a-time rule, including native jobs. The runner checks for
`vite build`, `tsc` and `vitest` before loading the database, waits if needed,
then identifies itself in that build-slot check. It does not automatically detect
every native build.

For the nine focused TypeScript suites, first check the shared build slot with
`pgrep -fl "vite build|tsc|vitest"` and wait if another job is running. Then run:

```sh
node node_modules/vitest/vitest.mjs run --config experiments/scuttlebutt-e2ee/relay/vitest.config.mjs --configLoader runner --no-cache --maxWorkers 1 --no-file-parallelism
```

After another build-slot check, strict type checking can be reproduced with:

```sh
node --max-old-space-size=1024 node_modules/typescript/bin/tsc \
  --noEmit --strict --allowImportingTsExtensions --target ES2022 --module ESNext \
  --moduleResolution Bundler --lib ES2022,DOM --types node --skipLibCheck \
  services/chat/e2ee/directMessageEnvelope.ts services/chat/e2ee/encryptedDmDelivery.ts \
  experiments/scuttlebutt-e2ee/relay/deviceBundle.ts experiments/scuttlebutt-e2ee/relay/gateway.ts \
  tests/DirectMessageEnvelope.test.ts tests/EncryptedDmDelivery.test.ts \
  tests/E2eeResearchDeviceBundle.test.ts tests/E2eeResearchGateway.test.ts \
  experiments/scuttlebutt-e2ee/relay/supabaseAuth.ts experiments/scuttlebutt-e2ee/relay/signedRequest.ts \
  experiments/scuttlebutt-e2ee/relay/signedGateway.ts \
  experiments/scuttlebutt-e2ee/relay/httpGateway.ts \
  tests/E2eeResearchSupabaseAuth.test.ts tests/E2eeResearchSignedGateway.test.ts \
  tests/E2eeResearchHttpGateway.test.ts \
  experiments/scuttlebutt-e2ee/relay/hostedGateway.ts \
  tests/E2eeHostedGateway.test.ts tests/ResearchRelayPolicy.test.ts
```

Fetch the single pinned public research dependency:

```sh
node --experimental-strip-types experiments/scuttlebutt-e2ee/relay/proof.mjs --fetch
```

Or supply the absolute path to an already downloaded matching archive:

```sh
node --experimental-strip-types experiments/scuttlebutt-e2ee/relay/proof.mjs /absolute/path/pglite.tgz
```

The cached-archive mode makes no network request. `--fetch` downloads only the
pinned npm archive. Neither mode invokes npm, changes package manifests or
installs into the app/shared `node_modules`. The runner creates a fresh
`thalassa-e2ee-relay-*` directory beneath the operating system's temporary
directory and prints its exact path. It verifies the archive before importing
it, extracts the dependency there, and creates the research database there.
The run directory and archive are retained for inspection/offline reproduction;
there is no automatic deletion. Private fixture keys exist in the test process,
while persisted directory rows contain public key material only.

`pglite-pin.json` pins `@electric-sql/pglite` **0.5.8**, the registry URL and this
archive integrity value:

```text
sha512-n9tsbUOhwx2epK1V0ZG9Ar4SHWUju04dhmzZXiSBXwBoleOvIfals33NAaWgagQVAL4Rbvx/Ptsu3P+pA09f6Q==
```

The runner also checks the package name/version, its `Apache-2.0` package
metadata, absence of declared runtime dependencies and `install`/`postinstall`
hooks, archive paths, and extracted file types. No dependency lifecycle script is executed. This
research dependency has `shippingApproved: false`; package metadata is not a
complete distribution/licence review.

The proof is designed to exercise SQL role permissions, registration/ownership,
claims, exact decisions/conflicts, bilateral blocks, revocation, malformed
frames, rollback, capacity and orderly database close/reopen. It prints a pass
line only after each scenario completes and a total only at successful end.
Those are PostgreSQL-engine checks inside PGlite, not mocked SQL adapters.
Its account credentials and `YQ==` ciphertext are deliberate fixtures: that
ciphertext is a Base64-encoded byte, not an Olm-encrypted message. This runner
therefore cannot establish end-to-end encryption or a real-provider relay round
trip. Real signature checks do not change that limitation.

`nativeRelayBridge.mjs` is imported only by the optional native proof runner.
It verifies/extracts the same pinned archive into a new temporary namespace,
uses the real SQL and signed gateway, and returns committed ciphertext records
to separately launched native processes. Only public bundles, signed requests,
ciphertext and exact receipts cross the bridge. Auth HTTP responses and
out-of-band peer pins are explicit fixtures; the filesystem bridge is not TLS
or an authenticated transport response. Decryption/history assertions run only
inside native code. See the native README for reproduction and its device limits.

Live JWT/Auth integration, transport response authentication, request rate limits,
directory consistency, app/native lifecycle integration, independently concurrent database connections, crash/power-loss
behavior, two real phones and an independent security review remain unverified.
No app dependency, live schema, production configuration, phone installation or
deployment is created by this research runner.
