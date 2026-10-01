# Isolated device-directory and ciphertext-relay research

This directory prototypes a device-signed, account-authorized, single-device relay boundary.
It is not an HTTP endpoint, Supabase migration, app adapter or deployment. It
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

For the six focused TypeScript suites, first check the shared build slot with
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
  tests/E2eeResearchSupabaseAuth.test.ts tests/E2eeResearchSignedGateway.test.ts
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
