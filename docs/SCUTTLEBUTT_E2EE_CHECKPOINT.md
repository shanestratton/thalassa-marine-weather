# Scuttlebutt private-message E2EE — isolated checkpoint

Updated: 4 October 2026. Branch: `codex/scuttlebutt-e2ee-foundation`.

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
research app. An owner-approved isolated hosted relay now exists; no production
relay migration, Thalassa app linking/signing changes or distribution occurred.
Dependency/licence review, an iPhone–iPad exchange and an
independent security review still gate release. An off-by-default switch is not
a substitute for those checks or a way around a bundled dependency's licence.

## What exists today

This is an isolated framing/delivery prototype, a real-provider native message
coordinator, and an isolated device-directory/hosted-relay experiment, **not functioning
E2EE in Thalassa**. Nothing is wired into live chat.
The separate research app now has a native messaging plugin and explicit test
screens. These are not a shipping private-message port. No shipping app dependency,
production database change, production encryption indicator, production deployment
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

### 4 October research restart continuity and device preparation

Cold launch now fences credentials without signing out the selected owner.
Only an exact sealed, selected, ready and active account can continue. Native
code rotates the directory and credential epochs, then requires fresh HTTPS
`/auth/v1/user` verification for that same account before publishing access.
No bearer, Auth lease or policy permit is restored. The owner and peer
generations, ratchet, history, claim, cursor and pending ciphertext remain
unchanged. A valid login to a different account refuses without deactivating
the surviving ratchet. Explicit logout still clears selection and quarantines
the old generation; account/device replacement and prekey replenishment are
not implemented.

The web SDK remains memory-only. Expired or unsolicited sessions fence native
credentials and clear visible content, while an explicit same-account login
may reopen the retained owner. An incomplete cold selection cannot be adopted;
explicit logout remains available even if initialization failed before SDK
creation. Failed SDK subscription setup does not publish a partial client.

Observed evidence on the current sources:

- **795 focused tests across 12 suites passed**: 592 relay cases, 49 Auth
  controller cases, 133 messaging/controller cases and 21 pure signing-validator
  cases. Auth/native/RPC inputs are mocked; signing cases use synthetic profile
  and certificate metadata, not CMS trust or actual signing. The strict pilot
  TypeScript check, named TypeScript lint and signing-runner syntax check passed.
  These are not full ordinary-app tests or CI.
- **282 directory/facade and 283 native bridge assertions passed**, along with
  266 Auth, 40 enrollment-intent, 65 authority, 105 pairing/history, 81 scoped-relay,
  188 scoped-enrollment and 709 readiness assertions. The new bridge cases close
  and reopen both endpoints in one process, require fresh Auth and policy, retry
  the original pending ciphertext, and decrypt subsequent messages both ways.
  They use real provider/Keychain/sealed SQLite with synthetic Auth/relay replies.
  This is not a physical force-kill, power-loss or hosted exchange test. All nine
  disposable simulator phases also passed, including the older client's four
  encrypted messages over ordinary HTTPS/local SQL. The simulator and temporary
  CA were removed. Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-native-exchange-t3jBSg/exchange-run.json`.
- All **30 exact simulator-tested Swift sources** compiled/linked unsigned for
  physical iOS. Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-e2ee-device-compile-d9YMxP/compile.json`.
  The fresh separate Capacitor app compiled 17 Swift sources; all 14 shared
  runtime hashes match the simulator receipt and current files. All 54 artifact
  file hashes match its receipt. The app, two Debug dylibs and two frameworks
  were independently checked unsigned. App receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-messaging-build-tqCOsi/build-receipt.json`.
  The fresh web bundle is in `thalassa-messaging-web-yu3NRe/public` under the same
  temporary directory. No browser layout rerun or actual Capacitor call occurred.

Read-only device checks found the paired iPhone 15 Pro Max on iOS 27.0.1 and
iPad 9th generation on iPadOS 26.5, with Developer Mode enabled. The separate
research bundle is absent on both; the normal iPhone app remains version 1.2.0,
build 119. Read-only pilot checks confirmed matching participant-allowlist
metadata and unused device slots for both human test accounts. Neither was
logged in or enrolled by this slice.

The new `bridge-native/signDevice.mjs` defaults to offline inspection. Explicit
`--sign` can sign only a fresh private copy of a hash-matched research artifact,
using a matching development profile for exactly the two selected devices and
four minimal entitlements. It refuses signed embedded inputs, extra capabilities
and primary-app identifiers. It cannot build, provision, install, launch or call
the relay. Internal review corrected literal `codesign --test-requirement`
syntax before execution. The actual signing runner is unrun: no matching
research profile exists, and owner approval to create it is pending. Pure
validators and local unsigned checks are not iOS profile acceptance or fresh
certificate-revocation evidence.

Cached provider archives were hashed, not rebuilt or independently attested.
No signing, installation, launch, human enrollment, positive native-to-hosted
policy/message exchange, primary sync or independent security audit occurred.
Physical restart cases remain unrun. Do not reset immutable pilot rows,
re-enroll or start a new generation to manufacture continuity. Missing files or
partial Keychain/install state, logout recovery, device/prekey lifecycle and
shipping app integration remain unresolved release gates. Production and
`master` were not changed.

### 4 October isolated hosted policy deployment

The owner approved deployment only to pilot `kmtupdvwdgbhtssqqova`, not
production. Commit `1b7b3b60` adds an explicit policy updater; commit `ab1563db`
adds the gateway deployment wrapper, followed by its JSON-metadata correction.
The updater replaces only `parse_request`, `parse_request_payload` and
`execute_request` from the pinned SQL candidate. A single owner transaction
checks exact baseline bodies, acquires the existing pilot lock, and verifies
preserved function OIDs, ACLs, security settings, other functions, roles,
memberships, schema, relations, RLS, constraints and data before committing.
It does not replay the bootstrap privilege tail, reset data or change enrollment.

Read-only preflight initially refused a metadata representation mismatch:
PostgreSQL serialized a function OID as a numeric string. Casting that metadata
field to `bigint` retained the strict safe-integer check and passed inspection.
The exact locked update then passed with 2 existing fixture devices, 0 blocks,
2 claims, 2 decisions and 28 request rows unchanged. SQL receipt:
`/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-e2ee-policy-h0SenL/policy-update-receipt.json`.
This is hosted definition/invariant evidence, not a signed policy exchange.

The single Edge function was deployed from the isolated hosted configuration
through Supabase's API, with JWT verification retained. Revision 25 became
active revision 26, bundle SHA-256
`17e7d6d4185737ef0f25f331b24391d74c3630538860fb267ca00aaeb512eddf`.
The wrapper records local dependency hashes and deployment metadata; it does
not independently attest the remote bundle's source or binary provenance.
Secret metadata fingerprints, including the participant allowlist, were
unchanged. Postflight verified the same policy definitions, authority/catalog
snapshot and data diagnostics.

Four bounded negative HTTPS checks passed: missing authorization returned 401,
an unknown route 404, a wrong method 405 and a public API key used as a user
credential produced an unresolved 503. The last three matched the generic
runtime error body and no-store/nosniff headers. An aggregate 503 alone does
not identify the exact internal refusing check. No register, claim, send,
human login or positive signed policy request was executed. Receipt:
`/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-e2ee-policy-deploy-ijQ8ld/deployment-receipt.json`.

The first deployment-wrapper attempt refused before deployment because it
expected a `digest` JSON field; the CLI returns the digest in `value`. The
correction validates bounded hexadecimal metadata and independently matches
the known public project URL's SHA-256. The failed preflight receipt remains in
`thalassa-e2ee-policy-deploy-OzJNc2`; it was not a failed remote deployment.
No secret values or private CLI diagnostics were printed. Human-device
enrollment, actual native-to-hosted policy/messaging, physical execution and
independent review remain unrun. Production and the primary app were untouched.

### 4 October isolated research messaging bridge

The separate Capacitor research app now exposes explicit native registration,
public-card inspection and full-fingerprint confirmation, a lower-device peer
claim, current-policy refresh, text preparation, exact pending-ID send/retry,
inbox sync and guarded local history. Auth and messaging share one registered
JavaScript proxy and one native host/facade. Native code derives authority;
JavaScript supplies only bounded public inputs and the expected Auth binding.
No keys, pickles, native record handles, bearer tokens or arbitrary authority
selectors are returned by the messaging methods.

Native publication retains the original account and complete peer snapshot
across awaits. Delayed outputs captured before a peer change remain refused
even after that peer is accepted again under a new generation. Fact-only
acceptance and inbox counts report completed operations; they do not refresh
current permission or release plaintext. The web controller checks exact DTO
shapes, binding and view revision after every awaited phase. It clears visible
content on Auth changes or hiding the view, but retains a private nonplaintext
scheduling barrier until an old preparation settles. New message actions cannot
race that preparation or queue replacement ciphertext. Exact retries reconcile
the original native ID. Content is rendered with text nodes, never interpreted
as markup.

Observed evidence on frozen sources:

- **765 focused TypeScript tests across 11 suites passed**: the prior 592 relay
  cases, 40 Auth-controller cases and 133 messaging/controller cases. These use
  mocked native/Auth/RPC parts; the renderer cases run in jsdom. The first run
  passed 764 cases and failed a supplemental filesystem source-tripwire because
  jsdom's URL class was passed to Node's filesystem API. Explicit Node URL use
  corrected that harness error. A duplicate plugin registration warning led to
  sharing the existing Auth proxy, not changing Auth lifecycle behavior.
  The strict pilot TypeScript check and ESLint on the four changed TypeScript
  files passed; these are not full ordinary-app checks.
- **222 native bridge assertions passed** with real provider, Directory, facade,
  Keychain and sealed SQLite, using synthetic Auth/relay transport. They include
  an encrypted opening and reply plus stale Auth, refresh/logout and peer-change
  publication races. All nine disposable simulator phases passed, including
  the older client's four actual encrypted messages over ordinary HTTPS/local
  SQL. The scoped bridge fixtures do not exercise hosted policy SQL or the
  Capacitor runtime. The 266 Auth, 247 directory, 40 enrollment-intent, 65
  authority, 105 pairing/history, 81 scoped-relay, 188 scoped-enrollment and
  709 readiness assertions passed again. Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-native-exchange-DePl99/exchange-run.json`.
  The earlier 190-assertion pass remains in `thalassa-native-exchange-g8SQ5r`;
  the final rerun adds peer-generation publication tests. Both disposable
  simulators and their temporary CAs were removed.
- All **30 exact simulator-tested Swift sources** compiled/linked unsigned for
  physical iOS. Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-e2ee-device-compile-aPXQjg/compile.json`.
  This is compilation, not signing, installation or execution.
- A fresh isolated Vite web bundle and the separate research Capacitor app
  compiled. The app includes 17 Swift sources; all 14 shared runtime source
  hashes match the final successful simulator receipt. App receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-messaging-build-pfu8Jk/build-receipt.json`.
  Its public web bundle is in `thalassa-messaging-web-tM79Fp/public` under the
  same temporary directory. Headless Chromium checks at 390×844 and 810×1080
  found no horizontal overflow or external requests. These show the unsupported
  browser screen with messaging disabled, not native Capacitor execution.

Cached provider archives were hashed, not freshly rebuilt or independently
attested. No signing/install/launch, actual Capacitor calls, human enrollment,
native-to-hosted message exchange, primary-app sync or independent audit occurred.
At that checkpoint, cold launch deliberately signed out and quarantined
surviving history/session state. The later restart-continuity section above
records the bounded same-owner implementation and its fixture limits; usable
recovery and physical restart evidence remain missing. Native block/revoke UI,
device/prekey renewal, scalable sync and app cutover also remain release gates.
The later isolated hosted deployment is recorded separately above; these bridge
fixtures are not that hosted exchange. No production activation or master merge
is included.

### 4 October native messaging readiness and current relay policy

Closed native text preparation, pending-send dispatch, acceptance and inbox
application now require registration acknowledgement, the complete confirmed
peer pin and a recent HTTPS response to a natively signed policy request. A first outgoing session
also requires its verified, unexpired peer claim; an already-established current
session does not reclaim an expired initial prekey. Historical owner/peer
generations cannot revive a surviving session after logout.

The new `policy` action reads both devices' revocation and both accounts' block
flags under the SQL pilot lock. Even an exact request replay recomputes current
flags rather than returning cached permission. The read does not consume the
bounded mutation-nonce ledger. Native code matches every response binding and
strict boolean to its saved request. Its permit exists only in memory, expires
five seconds after the original monotonic request start, and retains the
original account, credential and peer context. Starting a refresh invalidates
the previous permit immediately. No automatic refresh is hidden inside send or
receive, and a new clear permit cannot authorize an older in-flight response.

Native operation and sealed-store commit guards recheck that exact permit.
After a block/policy change, only an exact authenticated terminal refusal may
settle the saved outgoing record through the original owner-only Auth lease.
Acceptance cannot use that lane; refresh/logout cannot replace its authority.
Local history and enrollment facts are not converted into current permission.
The five-second read is not atomic remote authorization or instant detection of
a later remote change: SQL still decides new actions. It is not trusted time
across restart, a finished polling strategy or production latency policy.

Observed evidence on frozen sources:

- **709 native readiness assertions passed** with real Olm, Directory, facade,
  Keychain and sealed SQLite, but synthetic Auth/policy/receipt transport.
  These include independently verified native policy signatures, all four
  denied flags, strict malformed replies, missing/historical claims, genuine
  established-session continuation after fixture prekey expiry, permit expiry
  during commit, and held-response races with refresh, peer changes and logout.
  Explicit gate release and subsequent successful exchanges are positive
  controls. Snapshot comparisons prove no durable mutation on refusal, not
  that no cryptographic computation occurred. Synthetic metadata/time seams
  are not actual device-clock rollback or live revocation evidence.
- All nine disposable simulator phases passed. The prior research client
  exchanged four actual encrypted messages over ordinary HTTPS and local SQL;
  it does not exercise the new scoped policy client against SQL or the hosted
  relay. The 266 Auth, 247 directory/facade, 40 enrollment-intent, 65 authority,
  105 pairing/history, 81 scoped-relay and 188 scoped-enrollment assertions
  passed again. Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-native-exchange-ttJ1sM/exchange-run.json`.
  The disposable simulator and temporary CA were removed. Two earlier attempts
  failed before simulator creation on test-harness tuple/visibility compile
  mistakes; their `thalassa-native-exchange-N6jXJx` and
  `thalassa-native-exchange-uQijlQ` receipts remain retained, not counted as passes.
- **592 focused TypeScript tests across nine suites passed**, using mocked Auth
  and RPC dependencies with real request signatures. The focused strict relay
  TypeScript check also passed, not a full app typecheck. **31 local SQL scenario
  groups passed**, including fresh bilateral policy on exact nonce replay,
  revoked-device diagnostics, unknown-peer refusal and no policy-ledger writes
  at capacity. SQL artifacts: `thalassa-e2ee-relay-PRmgeI` in the same temporary
  directory. This uses fixture Auth and synthetic ciphertext in single-connection
  PGlite, not adversarial independent PostgreSQL connections or cloud deployment.
- The separate transport proof passed 13 host URLSession fixture groups and
  compiled for simulator/physical iOS; artifacts: `thalassa-native-network-VVmFfi`.
  The new split send-completion behavior is covered by the readiness fixtures,
  not those older 13 groups. All **28 exact simulator-tested Swift sources**
  compiled/linked unsigned for physical iOS, without installation/execution.
  Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-e2ee-device-compile-gKcK24/compile.json`.
- The separate auth-only Capacitor app compiled/linked unsigned with 16 current
  Swift sources and the unchanged existing research web bundle. All 13 shared
  runtime hashes match the successful simulator run. Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-auth-only-build-I5oHwz/build-receipt.json`.
  Cached provider archives were hashed, not freshly rebuilt or independently
  attested. No screen/SDK rerun, signing/install/launch, live login, human device
  enrollment, cloud deployment, primary-app sync or independent audit occurred.

At this readiness checkpoint the policy SQL/gateway changes were local candidates,
not deployed to the hosted pilot, and concrete plugin/screens were missing. The
later bridge slice above adds isolated plugin/screens and bounded history/sync,
not native block/revoke controls, production history/sync, iPhone–iPad execution
or external review. No production E2EE badge or master merge is authorized.

### 4 October native registration and peer claims

Closed native registration now seals the exact first signed bundle before
dispatch. A lost or malformed reply leaves that intent pending; retries replay
the same bytes, even after expiry, rather than replacing keys or extending the
bundle. A strict reply must identify this native user and device before a digest
of the exact bundle is sealed as an acknowledgement. Exact acknowledged retries
return locally without HTTP. This is a historical registration fact, not proof
of current server permission, revocation status or readiness to send.

The lower ASCII device can request a peer prekey only after registration
acknowledgement and complete out-of-band identity confirmation. Native code
retains one stable claim ID across uncertain retries while signing a new outer
request nonce. Completion uses the original facade/account/credential/peer
snapshot and compares every returned identity key, including the signing key,
to the full sealed pin. The exact verified signed bundle is stored against the
claim ID, original owner and peer generations, and confirmed fingerprint.
No claim operation creates a ratchet/session. A changed generation reports
historical state and refuses rebinding; the higher device refuses before HTTP.

Expiry at completion uses the greater of native wall time and the native start
time plus monotonic elapsed time. Reopening verifies saved signature/canonical
bytes without rejecting the entire store when the old prekey expires. Cached
`verified`/`expired` labels use the current device clock; they are not a trusted
time policy across restart or later clock rollback. Missing optional fields in
older version-5 research snapshots remain unknown, never promoted to success.
Partial or inconsistent acknowledgements/confirmations fail closed.

At this earlier registration checkpoint, the scoped client exposed only native
research operations and prepare/send/inbox were not yet gated on enrollment or
bilateral block policy. The readiness slice above adds those research gates;
both slices were absent from the then auth-only Capacitor plugin. Do not label
this a complete private-message port or expose a security badge from these
facts. Physical-device, hosted native exchange and independent external review
gates remain open.

Observed evidence on frozen sources:

- **188 scoped-enrollment assertions passed** with real provider, Directory,
  facade, Keychain and sealed SQLite, using synthetic Auth/relay responses.
  They cover lost/malformed/duplicate-field replies, exact registration replay,
  stable claim IDs with fresh signed request nonces, signing-key-only
  substitution, expired bundles, responder refusal, refresh/logout completion,
  cached/historical facts and seven partial/mismatched-state reopen refusals.
  An explicitly synthetic native start-time seam proves the monotonic floor
  refuses a still-wall-valid bundle, with the same original token as a positive
  control. This is not an actual system-clock rollback or live enrollment test.
  Expired saved confirmations remain readable and cached without HTTP; exact
  disposable payload/key restoration is not rollback-resistance evidence.
- All nine simulator phases passed, including the prior research client's four
  actual encrypted messages over ordinary HTTPS and local SQL. The 266 Auth,
  247 directory/facade, 40 enrollment-intent, 65 messaging-authority, 103
  pairing/history and 81 scoped-relay assertions passed again. The new scoped
  registration/claim client used synthetic transport fixtures, **not** the
  hosted relay or that local SQL exchange. Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-native-exchange-UvTwg0/exchange-run.json`.
  Its disposable simulator and temporary CA were removed.
- All 26 exact simulator-tested Swift sources compiled/linked unsigned for
  physical iOS, without installation or execution. Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-e2ee-device-compile-rqYYSq/compile.json`.
  Cached provider archives were hashed, not rebuilt or independently attested.
  The test-only probe emitted two unused-cleanup-result warnings; both native
  compile checks succeeded. No warning-free build is claimed for the harness.
- The separate auth-only Capacitor app compiled/linked unsigned for physical
  iOS with 15 current Swift sources and the unchanged existing research web
  bundle. Twelve shared source hashes match the simulator-tested sources.
  Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-auth-only-build-x62sG7/build-receipt.json`.
  No signing/install/launch, live login, human enrollment, cloud deployment,
  primary-app sync, screen/SDK rerun or independent external audit occurred.

### 3 October native relay send and receive

A new native relay client prepares and applies messages through the closed
facade dispatcher. It resolves a message ID to the exact sealed outbox record;
native code supplies each request nonce and expiry. The original account,
credential, peer and deadline snapshot is retained across HTTP. No authority
lock crosses an await, and no replacement snapshot can consume an old response.
Receipt parsing matches the durable record before acceptance or rejection is
committed. Already-terminal exact IDs return their sealed decision without a
network request; acceptance still means server acceptance, not delivery/read.

Inbox reads rescan from zero in batches of at most 16. Complete structural and
routing validation precedes any decryption or inbox mutation. Commits remain
per-row: a later crypto/storage conflict can leave earlier valid rows committed,
and an explicit rescan reconciles them. This is not batch atomicity, a scalable
cursor, automatic unresolved recovery or proof that an empty batch is caught up.
Only counts leave the relay client; plaintext remains in guarded native history.
Raw response application is native-only and absent from the auth-only plugin.

Observed evidence on frozen sources:

- **81 scoped-relay assertions passed** using real Olm provider bytes, Directory,
  facade, Keychain and sealed SQLite, with synthetic Auth/relay responses through
  URLProtocol. Covered exact ciphertext/text/time after lost or malformed replies,
  fresh native nonces and independently checked Ed25519 signatures, terminal
  idempotency/conflicts, refresh/logout during flight, cancellation, complete
  malformed-batch refusal, actual native opening/replies, duplicate rescans and
  the 16-row bound. Race gates explicitly report release without timeout;
  fixture request counts do not prove server commits or live delivery.
- All nine disposable simulator phases also passed. The earlier research client
  exchanged four actual encrypted messages over ordinary HTTPS and local SQL,
  with restarts, exact retries and unresolved recovery. The 266 Auth, 247
  directory/facade, 40 enrollment-intent, 65 messaging-authority and 103
  pairing/history assertions passed again. The new scoped client was exercised
  by synthetic transport responses, **not** that local SQL exchange or the
  hosted relay. Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-native-exchange-NHusGJ/exchange-run.json`.
  The simulator and temporary CA were removed.
- The first attempt, `thalassa-native-exchange-6EAuSI`, failed because the new
  relay fixture omitted the transport's outer response envelope. Its failed
  receipt is retained and its simulator was removed. The corrected fixture also
  closes the gate-timeout false-pass gap found in internal review. No assertion
  from that failed attempt is counted as a pass.
- All 25 exact simulator-tested Swift sources compiled/linked unsigned for
  physical iOS, without signing, installation or execution. Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-e2ee-device-compile-tD4qfx/compile.json`.
  Cached provider archives were hashed, not rebuilt or independently attested.
- The separate auth-only Capacitor app compiled/linked unsigned with its 15
  current Swift sources and unchanged existing research web bundle. Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-auth-only-build-vsfcbx/build-receipt.json`.
  No screen/SDK suite rerun, app signing/install/launch, live login, human device
  enrollment, cloud deployment or primary-app sync occurred in this slice.

At that 3 October checkpoint, scoped registration acknowledgement, full-pin
claims and readiness gates were still missing. The 4 October slices above add
those native research paths, not a complete private-message port, pairing UI,
usable restart history, human-device exchange or independent security review.
They remain isolated research, not functioning E2EE in Thalassa. Fixture passes
do not satisfy release gates.

### 3 October native messaging authority and sealed pairing history

The native facade now captures an opaque, nonserializable messaging snapshot
for one verified account, credential epoch and optional peer generation. A
closed command dispatcher performs identity reads, pairing, current thread
reads and text preparation. It never returns a coordinator, storage handle,
bearer or arbitrary callback to JS. The Capacitor plugin is still auth-only;
these messaging commands are not connected to its screen or the hosted relay.

Synchronous operations hold the facade, Directory, sealed index writer,
AuthSession and coordinator authority through the account-store transaction.
Network awaits hold none of these locks. The original native deadlines are not
renewed by a snapshot, read or slow Keychain/crypto operation. The account store
checks held native authority immediately before SQLite UPDATE and COMMIT;
refusal before COMMIT rolls back, and uncertain rollback poisons the handle.
This is not an atomic transaction across the index and account databases. A
commit followed by a late deadline/refusal can still require exact reconciliation;
no failure authorizes creating a replacement message or identity.

Pairing fingerprints use domain-separated SHA256 over canonical project,
conversation, account/device identifiers, signing key, curve key and prekey.
The full identity and matching fingerprint are sealed together. An exact repeat
is idempotent; replacement, wrong routing and promotion of an older partial
fixture pin are refused. A matching supplied fingerprint means only that native
checked those bytes: no human comparison, live peer enrollment or ownership
verification was performed by these fixtures.

New outgoing records seal plaintext and native-local creation time in the same
commit as ciphertext and the advanced ratchet. Exact retries preserve the first
text, time and ciphertext. Current thread reads retain pending, server-accepted,
rejected and received statuses; server acceptance is not delivery or reading.
Legacy records without text/time stay unavailable rather than being reconstructed.

Observed evidence on frozen sources:

- **65 native messaging-authority assertions and 103 pairing/history assertions
  passed**. They use real provider/Keychain/sealed stores with fixture Auth,
  synthetic peer confirmation and injected trusted terminal decisions. Covered
  stale account/credential/peer generations, deadlines, actual competing SQLite
  writer refusal, rollback before UPDATE/COMMIT, full-key pinning, exact retries,
  sealed reopen, current-generation history and bounded capacities.
- All nine disposable simulator exchange phases passed, including four actual
  Olm encrypted messages over ordinary URLSession HTTPS and local SQL, restarts,
  exact retries and unresolved recovery. The prior 266 Auth, 247 directory/facade
  and 40 enrollment-intent assertions also passed. This exchange still uses the
  earlier research relay client, not the new scoped facade or Capacitor plugin.
- The simulator and its temporary CA were removed. Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-native-exchange-WcizRH/exchange-run.json`.
  Earlier attempts retained failed receipts: `2z6gW3` caught nonescaping callback
  inference, `uMgZuv` caught a private fixture error enum, and `kgJ5Q5` reached
  the harness deadline during the old directory suite. The harness preparation
  bound is now three minutes; native leases, HTTP and held-lock deadlines are
  unchanged. No failed attempt is counted as a test pass.
- The exact 23 simulator-tested Swift sources also compiled and linked for
  physical iOS unsigned, with no installation or execution. Cached provider
  binaries were hashed, not rebuilt or independently attested. Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-e2ee-device-compile-5z7W37/compile.json`.
- The separate Capacitor auth-only app also rebuilt and linked for physical iOS
  unsigned with the changed native sources. Its existing research web bundle
  was reused; no screen/SDK fixture rerun is claimed for this native-only slice.
  No signing, installation, launch, live Auth or human device registration was
  performed. Receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-auth-only-build-uXpehj/build-receipt.json`.

Thread rows are grouped outgoing then incoming, not globally chronological;
future UI keys must include direction plus message ID. Incoming observation time
is absent, not fabricated sender time. Historical owner/peer generations remain
hidden but consume the bounded 16-outgoing/16-incoming capacity. Cold launch's
explicit sign-out still advances owner generation on reauthentication, so normal
history continuity requires a deliberate policy before a usable device pilot.
Scoped relay enrollment, full-pin claim checking, plugin receive/receipt wiring,
pairing UI, physical iPhone/iPad exchange and independent review remain pending.
Internal agent review is development evidence, not independent audit.

### 3 October separate native account authentication app

`bridge-native/` now contains a registered **account-authentication-only**
Capacitor plugin and a standalone iPhone/iPad application. Its distinct bundle is
`app.thalassa.research.scuttlebutt-auth`; the generated project and artifacts stay
in private temporary storage. The ordinary Thalassa target, its `ios` directory,
production project and hosted relay were not changed in this slice.

The native bundle pins the pilot origin, conversation and public API key. JS
cannot choose an origin, account, device, key namespace or storage path. Native
Auth fences complete before explicit SDK token acquisition; fresh server
verification selects native account authority. Bearers pass from the memory-only
SDK into native authentication and are not returned or persisted by native code.
Capacitor logging and WebView debugging are disabled. The research web page has
no browser fallback, remote script source or static public-config copy.

Cold launch explicitly signs out the previous native owner before constructing
the SDK. A device-only, nonsynchronizing WhenUnlocked Keychain locator must match
protected native files before reopening the sealed account directory. Partial
initialization, a remaining marker with missing files, or files without the
marker refuse reopening; no recovery/reset method is exposed. If **both** marker
and files are absent, the host treats that as first installation. It cannot
distinguish first use from total previous-state loss, and reinstall/restore
behavior has not been tested on a physical device.

The purple/cyan research UI supports login, account re-verification and local
logout. It shows only public account/device metadata and explicitly says
“Messaging is not yet connected.” `credentialBinding` is not peer trust or a PM
lifecycle version. This plugin does not implement the private-message port,
peer enrollment, fingerprints, send/receive, complete thread history or block
controls. Those require scoped native operation authority, not hardcoded
readiness or permission flags.

Observed evidence for this slice:

- **151 screen/SDK fixture tests in seven files passed**, including 40 new
  auth-bridge fixtures. Focused pilot TypeScript and the separate Vite web build
  passed. These fixtures do not exercise a real plugin, live login or device.
- The separate Capacitor app compiled and linked for physical iOS **unsigned**.
  The runner verified arm64/iOS and absence of an app signature. It did not sign,
  install, launch, enroll a human device or execute live native Auth. Cached
  provider/bindings/frameworks were copied and hashed; this is not a fresh Rust
  build or independent binary-provenance attestation.
- Compile receipt:
  `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-auth-only-build-PAg2Ct/build-receipt.json`.
  Two earlier link attempts failed because the generated project's provider
  library search path was absent. Their failed receipts remain in
  `thalassa-auth-only-build-1Ci8dy` and `thalassa-auth-only-build-3L5yyd` under the
  same temporary parent. The generator now specifies that path.

The coordinator also seals the first byte-identical registration bundle and a
stable prekey-claim reservation independent of expiring outer request IDs.
Reconciliation cannot extend bundle expiry, change registration parameters or
rebind a claim after owner/peer generation changes. Optional metadata reopens old
research states but refuses reconstructing enrollment from a used state.

The frozen native regression rerun passed all nine disposable simulator phases,
**40 new enrollment-intent assertions**, 266 Auth assertions and 247
directory/facade assertions. Four actual Olm encrypted messages crossed ordinary
URLSession HTTPS and on-disk SQL with process restarts and exact retries. Auth
was a fixture; both clients ran inside one simulator, which was removed along
with its temporary test CA. This does not execute the Capacitor auth app or
connect native encryption to the hosted pilot. Receipt:
`/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-native-exchange-k2cDZC/exchange-run.json`.
Those exact simulator-tested sources also compiled/linked unsigned for physical
iOS, without signing, installation or execution. Receipt:
`/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-e2ee-device-compile-OqLbIX/compile.json`.
Internal review is not independent audit.

### 3 October native facade and isolated hosted pilot

`VodozemacSessionFacade.swift` now narrows account selection to native-created,
single-use Auth fences. Fencing completes durably before SDK token acquisition.
The facade exposes only public account/device data and an opaque credential
binding; this is not peer trust, messaging readiness or a lifecycle version.
Same-owner renewal retains existing pending ciphertext. A cold persisted
selection cannot silently reopen under a new bearer: explicit native sign-out
and verification are required. That cold-start policy still needs integration
with the SDK adapter. This is native research code, **not a registered app plugin**.

Internal review found that a returned directory scope could outlive the original
reservation deadline. The scope now retains that exact monotonic deadline and
checks it before and after reading native authority. The regression probe expires
a shortened reservation while the inner Auth lease would otherwise still live;
sealed state must remain unchanged. Internal review is not independent audit.

Observed checks on the frozen native sources:

- Nine disposable simulator process phases passed, exchanging **four actual Olm
  encrypted messages** over ordinary URLSession HTTPS and on-disk SQL. The run
  passed **266 Auth and 247 directory/facade fixture assertions**. Auth responses
  were fixtures and both logical clients shared one simulator.
- Those exact simulator-tested Swift sources compiled and linked for physical
  iOS, **unsigned, never installed or executed**. Cached provider binaries were
  hash-checked, not freshly built or independently attested. The disposable
  simulator and its test CA were removed; receipts remain locally.
- The native URLSession response-fixture runner passed 13 scenario groups,
  including the exact trusted hosted prefix and hostile URL aliases. It compiled
  for simulator and physical iOS; this was not live native hosted networking.
- Focused relay tests: **568 passed in eight files**. Screen/SDK fixtures:
  **111 passed in six files**. Focused pilot TypeScript and the actual Deno edge
  entrypoint typecheck passed. These are not a full app build or device test.

The separate free project is **Thalassa E2EE Pilot**, project
`kmtupdvwdgbhtssqqova`, in **Thalassa Encryption Testing**. Production project
`pcisdplnodrphauixcau` was untouched. `hosted/provision.mjs` requires that exact
healthy project, organization, linked config and isolated worktree. It refuses
an existing bootstrap rather than resetting data. The dedicated edge login has
no table access, owner membership or elevated role flags; it can SET only the
gateway role, which can execute only the three signed-path RPCs. Secrets remain
server-side and in owner-only local artifacts, never committed or printed.

The owner-supplied iPhone and iPad accounts were created only in that project.
Admin-confirmed email flags and password-token checks are setup scaffolding, not
mailbox or hardware ownership proof. No email was sent and neither human
account's immutable device/prekey slot was used. Hosted smoke checks use two
separate `.invalid` fixture actors, preserving their signing material for exact
reruns. The wrapper temporarily selects those actors and restores the human
participant allowlist in `finally`, including after failed assertions.

Live hosted checks passed real Supabase password Auth and `/auth/v1/user`,
Ed25519 registration, reciprocal prekey claims, exact signed request/message
retries, bidirectional relay acceptance and recipient-only inbox reads. Invalid
signatures, substituted accounts/device keys, an API key without a user, and
endpoint/query aliases were refused. The payload was one-byte synthetic
ciphertext: **this does not prove native Olm messages reached another phone**.
Server acceptance is not device delivery or reading.

Deployment initially exposed a missing schema USAGE grant: the managed postgres
bootstrap role's NOINHERIT membership was not sufficient to issue it. A narrowly
scoped owner-role repair restored only gateway schema USAGE; bootstrap now grants
it after SET ROLE. Live ACL checks require both denied client/table privileges
and affirmative gateway schema access, avoiding a vacuous all-denied pass.
Per-transaction clients close after COMMIT/rollback to respect the two-connection
pilot budget. Sequential live checks passed; burst capacity and independent
concurrent PostgreSQL transactions remain unproved. No admin fallback or TLS
verification bypass was introduced.

The hosted adapter maps only the two observed exact Supabase internal URLs to
the configured external HTTPS endpoints. It does not trust forwarded headers or
permit native HTTP. The temporary JWT-protected routing canary was deleted and
its source removed. Temporary response-shape diagnostics were removed; remaining
driver logs contain only allowlisted error codes. Provisioning and smoke runners
suppress private error bodies. Their CLI children disable telemetry for that
process only, without changing the owner's global preference.

Local evidence:

- Native simulator: `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-native-exchange-dbAHR0/exchange-run.json`.
- Physical target compile: `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-e2ee-device-compile-Odek1J/compile.json`.
- Hosted initial pass: `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-hosted-fixtures-1XKFdZ/hosted-live-receipt-ab6366ac-476d-4a4e-86d5-eef0d56a5346.json`.
- Hosted cleaned deployment rerun: `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-hosted-fixtures-1XKFdZ/hosted-live-receipt-6e037391-2de9-4076-ab5f-313ea613c1d9.json`. All 13 check categories passed. The receipt records source hashes and the unchanged JWT-gated deployed revision; these identify the run, not independently attest deployment provenance.

An earlier simulator prepare phase timed out; its failed receipt remains in
`thalassa-native-exchange-2vdZZh/exchange-run.json` under that temporary parent.
The later pass does not establish the original cause. A separate unsupported Mac
Keychain diagnostic also failed; no Keychain fallback or protection weakening was
made. Its temporary source was removed and local artifacts retained. Some CLI
commands reported success and then exited nonzero on PostHog shutdown; live
readbacks, not those ambiguous exits, establish deployed behavior.

Next gates: implement the actual app-native bridge and isolated login/device
enrollment, execute the iPhone–iPad restart/logout/recovery plan, resolve immutable
device/prekey recovery and concurrent-host limits, then independent security and
dependency review before any production activation. The selected provider remains
unchanged Olm Double Ratchet: no homemade third ratchet or post-quantum claim.
The dated sections below are historical evidence, not today's deployment status.

### 2 October account directory and private message screen slice

The isolated branch now includes native account-directory selection and a
disabled-by-default SDK/native adapter contract with an injected private-message
screen. The contract is not an implemented Capacitor plugin. The ordinary app
continues its existing chat path; only explicitly injected research fixtures
enter the new subtree. Its notice says “Encryption test—not reviewed”. No
runtime switch, app installation, Capacitor sync or live chat cutover occurred.

The native directory creates its own bounded account/store identifiers after
server Auth verification. Its authenticated index holds writer authority across
account lifecycle checks and mutations. An obsolete selection/logout cannot
deactivate a newer winner; selecting an account in the gap before the old
deactivation advances its generation without exposing old pending ciphertext.
Missing/corrupt stores remain unavailable. Cross-database crash atomicity,
whole-database rollback detection and physical Keychain behavior are not proved.

The screen adapter fences SDK account generations, native readiness and runtime
replacement. It clears old runtime history/drafts/permissions, bounds outstanding
event validation to 32, suppresses stale completions, and never downgrades native
acceptance/read state. Native failures do not invoke legacy sends, subscriptions
or the plaintext offline queue. These are tested screen/SDK contracts, not live
authentication or functioning E2EE in Thalassa.

Native continuation also has a split reservation API: durably fence the old
credential before acquiring an SDK token, then consume that exact native-only,
single-use reservation under its original authority guard and 60-second deadline.
Same-owner renewal preserves pending ciphertext; a stale, duplicate, foreign or
expired reservation cannot dispatch Auth or erase a newer winning lease. The SDK
adapter now awaits successful fencing before `getSession`; merely queuing the
native call is insufficient. Mapping those reservations to opaque plugin fences
and integrating directory access remain unimplemented facade work.

Observed checks on 2 October:

- **111 tests in six files passed**, including SDK/native-port mocks and hook/UI
  fixtures. The focused `pilot/tsconfig.json` check passed. This is not a full
  repository typecheck or application build.
- A disposable simulator ran nine process phases with **four actual native Olm
  encrypted messages** over ordinary URLSession HTTPS and on-disk SQL. It passed
  **266 Auth fixture assertions and 181 account-directory fixture assertions**,
  including the logout/selection gap races and actual SQLite writer exclusion.
  Auth responses were fixtures; both logical endpoints shared one simulator.
- The exact simulator-tested Swift sources compiled and linked for physical
  iOS, **unsigned and never installed or executed**. Both runs reused cached,
  hashed provider binaries/bindings; this is not a fresh Rust build or independent
  binary-provenance attestation. The disposable simulator and its test CA were
  removed; temporary research receipts and build artifacts were retained.

Reproduce in the isolated worktree, one heavy job at a time:

```sh
node experiments/scuttlebutt-e2ee/pilot/checks.mjs tests types
node --experimental-strip-types experiments/scuttlebutt-e2ee/relay/nativeExchangeProof.mjs NATIVE_CACHE PINNED_PGLITE_ARCHIVE
node experiments/scuttlebutt-e2ee/pilot/deviceCompile.mjs NATIVE_CACHE SUCCESSFUL_EXCHANGE_RECEIPT
```

Successful local receipts:

- Simulator: `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-native-exchange-t4tOMl/exchange-run.json`.
- Physical target compile: `/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-e2ee-device-compile-H0eB6P/compile.json`.

The physical-target runner disables linker ad-hoc signing, explicitly checks
that `codesign` finds no signature, and rechecks all provider/header/binding/source
hashes after compile. Scoped lint and formatting checks passed. A multiline
`pgrep -l` shell command caused false build-slot waits; the research guards now
ignore non-PID continuation lines while retaining real competing process records.

Failures are retained, not replaced by these passes. A fresh native runner timed
out after 600 seconds in `cargo metadata`; its execution outcome was unresolved.
An explicit 20-second diagnostic also timed out. No fresh Rust/provider test pass
is claimed for this slice. The first exchange build failed because the cleanup
branch still returned an integer after the probe result became a tuple. That
wiring error was corrected and the later simulator/device-target runs passed.
Its failed receipt remains in `thalassa-native-exchange-NdwwAj/exchange-run.json`
under the same temporary parent.
Another attempt (`thalassa-native-exchange-kZDrDX/exchange-run.json`) failed
compilation because its Auth probe changed during the build. That runner began
before the final test edit was frozen; it installed nothing. The frozen rerun
above passed. Earlier successful receipts remain, but do not cover the later
split-reservation edit.

The owner approved a separate free Supabase test project. Its organization is
`Thalassa Encryption Testing`; project creation and credentials are a separate
setup step, not evidence of a deployed authenticated relay. No production schema
or accounts were changed by this slice. [The review brief](SCUTTLEBUTT_E2EE_REVIEW_BRIEF.md)
and [physical device plan](SCUTTLEBUTT_E2EE_DEVICE_TEST_PLAN.md) distinguish the
remaining gates. Next: implement the real native facade/plugin and isolated live
relay, then run iPhone–iPad acceptance before external security review and any
release decision. Do not merge this research as completed encryption.

### 2 October native Auth continuation slice

`VodozemacSupabaseAuth.swift` is a concrete, bounded native HTTPS verifier for a
configured trusted project's `/auth/v1/user`. It returns only a unique canonical
top-level account UUID. Bearer JWT claims, metadata and caller-supplied account or
device labels never select the native scope. The trusted public API key cannot be
a service-role/secret key. System TLS, exact final URL, no redirects/cookies/cache,
strict UTF-8/JSON, a 512 KiB cap, cancellation and an independent monotonic deadline
remain mandatory. This matches the server-validation boundary described in
[Supabase's getUser documentation](https://supabase.com/docs/reference/swift/auth-getuser).

`VodozemacAuthSession.swift` continues ONE existing immutable native identity,
requiring a canonical account UUID and a device ID equal to its native store UUID.
No missing key/store is recreated. The first verified continuation seals the
trusted project origin; a different project/account cannot rebind that store.
Version 5 research snapshots are explicit: prior snapshots refuse, without
automatic migration, recreation or relabelling as authenticated identities.
Supabase confirms an account, not possession of a hardware device or permission
to enrol one. Initial attested provisioning and the account/device store directory
are NOT implemented by this slice.

Construction/restart supplies no usable bearer even if sealed state is active.
Every verification clears its in-memory lease and reserves a durable epoch before
HTTP. Native tickets plus full lifecycle equality and sealed CAS prevent late
same-account refreshes, account switches, logout or competing coordinator writes
from publishing stale credentials. Accepted same-account renewal retains owner
generation and exact pending ciphertext; signed-out resume advances generation
without rebinding old outbox/history. Tokens stay in memory only, with a maximum
60-second monotonic verification lease captured BEFORE awaiting Auth (conservatively
including network time), not restarted after suspension or completion storage work,
and rechecked after native validation. Expiry/refusal/cancellation never restores
the prior lease. No secure-erasure guarantee is made for Swift memory.

Local logout clears tickets/bearers first and durably deactivates native state.
Unconditional deactivation retries only a competing sealed revision, at most three
times from fresh state. Storage/key errors and expected-ticket mismatches are never
retried. Exhaustion reports failure: this adapter stays unready, but does NOT claim
that every competing session is durably signed out. A future app must surface
failed logout and keep one native session authority per scope. Already-dispatched
server requests may still commit; this is not remote logout or token revocation.

Observed validation: **20 real-provider Rust boundary tests passed** in the fresh
native rebuild. Simulator and physical-iPhone target compilation/linking passed;
compilation is not phone execution. The final
`thalassa-native-exchange-eikImL/exchange-run.json` reported **passed**, including
**211 native Auth fixture assertions**, nine simulator process launches and four
actual native encrypted messages over ordinary URLSession HTTPS and on-disk SQL.
Lost-response/exact-ciphertext retry, poisoned inbox/recovery and SQL reopen checks
passed, with eight poisoned responses, zero stale-context HTTP requests and zero
unexpected host failures. Executed native source hashes were unchanged after the
run; the disposable simulator and its test CA were removed. The seven existing
TypeScript research suites passed **474 tests**, followed by strict selected-file
type checks. These are distinct kinds of evidence, not hundreds of live encrypted
phone conversations.

Earlier attempts were not counted as passes: one stopped during preparation with
an unspecific sanitized failure label; its cause was not established. Ordinary
Auth fixture deadlines were made less scheduling-sensitive and expected-positive
steps received fixed non-secret diagnostic labels. Another run passed the 211
Auth assertions but stopped on the existing poison rescan. The probe had reused
one nonce while recomputing signed expiry, conflicting if the calls crossed a
second boundary. Independent rescans now use different nonces; SQL's exact-wire
replay protection is unchanged. Both failed runs removed their owned simulators.

`VodozemacAuthProbe.swift` uses explicit URLProtocol Auth fixtures plus real native
provider/Keychain/sealed storage. It tests scope/issuer binding, stale async responses,
cancellation, storage/CAS failure, exact ciphertext retention, bounded logout and
deterministic clock-boundary cases. Such fixtures do NOT establish live Supabase
sign-in. The ordinary transport is not a mocked implementation, but these tests
mock its Auth responses. No live token, login SDK event bridge, initial enrolment,
refresh-token acquisition, app plugin, production schema or deployment is included.
Existing direct coordinator APIs remain research-only; they are not a shipping
authorization boundary. Peer trust, device registration/prekey lifecycle, two real
phones, licensing/dependency checks and independent security review remain gates.

### 1 October typed incoming-message failure and sealed retry slice

The native wrapper now has one narrowly classified `MessageNotOpened` variant,
with exhaustive pinned upstream error matching. Local pickle/key/configuration
and output failures remain non-deferable. Restoring the relevant local provider
snapshot happens before inspecting incoming wire, so damaged ciphertext cannot
mask a corrupt pickle. The upstream library, dependency manifest/lock and Olm v1
cryptography are unchanged; this is error classification, not a new ratchet.

Version 4 research state retains a bounded sealed unresolved ledger alongside
the inbox. It captures exact ciphertext, server ID, full relay-record metadata,
original local owner/peer generations and a fixed sanitized reason. No failed
message becomes plaintext or a read/deletion receipt. A speculative copy is used
for decryption: deferring authenticated-content failure preserves the ORIGINAL
account, one-time key, session, outbox and inbox. Persistence/CAS errors cannot be
caught as message failure, and no deferred/stored result is returned before commit.

Ordinary rescans only classify exact saved rows; they never automatically retry,
evict, rebind or restore old history. Explicit retry requires the original active
owner/accepted-peer generations and current credential epoch. Successful retry
atomically removes the queue row, advances crypto and appends bound native history.
Failed retry persists the unchanged payload through a lifecycle-fencing CAS.
Server/record/ciphertext collisions remain conflicts before and after promotion.
Inbox plus unresolved shares a 16-row limit; the sealed-store byte cap also applies.
Full stores stop without silent eviction, including historical unresolved rows.
Production capacity/retention policy, scalable cursors and retry UI are not built.

Observed validation: **20 real-provider Rust boundary tests passed** after a fresh
offline boundary rebuild and regenerated Swift bindings. Simulator and physical
iPhone target compilation/linking also passed; compilation is not phone execution.
The final `thalassa-native-exchange-XjN28V/exchange-run.json` reported **passed**
across nine simulator process launches, four actual native encrypted messages,
eight poisoned inbox responses and zero stale-context HTTP requests. SQL reopen,
lost-response/exact-ciphertext retry, wrong receipt, malformed structural page and
scoped relay plaintext-absence checks remained passing. No unexpected host failures.

Preparation executed the native unresolved probe, including genuine provider
2,002/1,000-position message-gap recovery: the exact late ciphertext stayed queued
through reopen, an ordinary rescan did not retry it, and explicit retry atomically
promoted it after an intermediate message made decryption possible. Corrupt local
account/session state remained a hard failure with no queued row. Exact bindings,
shared capacity, deferral/promotion rollback and competing lifecycle CAS probes
passed. In the HTTPS exchange, the retained poison preceded a valid successor,
survived another process, and became historical after trust/owner changes without
being deleted/rebound or exposing text. The disposable simulator/test CA were
removed; executed Swift source hashes remained unchanged after the run.

The seven existing TypeScript research suites passed **474 tests**, followed by
strict selected-file type checks. They remain framing/delivery/server tests, not
474 native encrypted exchanges. Both logical native clients still share one
research simulator; real account/token attestation and peer pins are fixtures.
The exchange runner records hashes of the freshly rebuilt boundary artifacts but
does not independently attest their provenance. No live Auth, app integration,
primary phone project or deployment changed. Two phones, device/prekey lifecycle,
production retention/scalable sync and independent review still gate release.

Earlier checkpoints below describe their then-current boundaries and limits.

### 1 October native lifecycle and known-inbox recovery slice

The isolated sealed coordinator now owns a persisted active/signed-out flag,
owner generation and credential epoch. Sign-out closes ordinary identity,
signing, send, receive and history access. Same-account/device resume uses a new
generation/epoch without changing its immutable keys or rebinding prior history
or pending sends. Wrong-account/device and stale resume requests refuse. At the
maximum generation, sign-out still persists inactive state and a new epoch;
resume permanently refuses rather than overflowing or leaving the account active.
These are explicit native research fixtures, **not real Auth attestation**.

Same-account token renewal rotates only the persisted credential epoch; current
pending ciphertext remains byte-identical and resumable. Relay checks evaluate
the external context reader before one fresh sealed authority read. Its captured
epoch is checked again inside signing and receipt/receive transactions and their
CAS, so a reentrant reader or competing credential renewal cannot silently apply
an old-epoch result. Already dispatched server work may still commit; this does
not promise network cancellation or immediate server token revocation.

Inbox rescans can explicitly recognise exact previously stored ciphertext from
earlier owner/peer generations as historical, under the **unchanged immutable
identity** and current accepted-peer guards. This read-only classification returns
no text and does not mutate the ratchet or restore/re-tag old history. Unknown rows
still require actual decrypt and atomic guarded commit. Known IDs with changed
bytes, stale owners/peers and blocked/changed/revoked peers refuse. Direct receive
keeps its strict generation checks. Unseen historical ciphertext is not identifiable
as such from the current wire; future identity/device replacement requires a new
identity-scoped design rather than reusing this helper.

Observed final run: temporary `thalassa-native-exchange-QuNkaU/exchange-run.json`
reported **passed**, with nine separate simulator process launches and four actual
native Olm messages over ordinary URLSession HTTPS into the signed SQL relay.
The fourth message decrypted after Bob's persisted sign-out/resume and another
process restart (owner generation 23, accepted peer generation 9). Two previously
stored rows were classified historical without restoring their text; only the new
message appeared in current history. The following rescan reported one current
duplicate and two historical rows, with no extra receive mutation.

The native lifecycle probe and existing coordinator/result probes executed during
preparation. They check wrong/stale/off contexts, epoch races, reopen,
exact-ciphertext retention, known-history isolation, competing lifecycle CAS and
generation exhaustion. The server observed **zero stale-context HTTP requests**
for both the stale epoch and reentrant context-reader cases. Existing lost-response,
wrong-receipt, malformed-batch, cryptographic-poison and retry checks passed;
four exact message IDs and four decisions persisted. SQL reopen and scoped
plaintext-absence checks passed, with no unexpected server failures. The runner
removed its own disposable simulator and test trust root. The seven existing
TypeScript suites also passed **474 tests**, followed by strict selected-file type
checks; these are not 474 native encrypted exchanges.

Two earlier attempts compiled but timed out booting fresh simulators before any
message test ran. A third booted and passed TLS refusal, preparation and opening,
then failed in retry; its exact failure cause was not established. The final run
uses the transport's normal bounded 10-second deadline instead of the earlier
research harness's 5 seconds. These failed attempts are not counted as passes;
each removed only its own simulator. Simulator startup now precedes SQL allocation
to reduce peak memory, with a bounded 600-second boot wait and observable progress.

The final runner recorded provider/source hashes and reused previously tested
cached bindings/static artifacts; it was not a fresh Rust rebuild or independently
verified artifact provenance. Both logical clients still ran inside one research
app on one simulator, not two physical phones. Auth tokens, same-account resume
attestation and peer pins remain fixtures.

Version 3 research snapshots now include active/epoch authority. Earlier snapshots
are refused, never recreated or automatically migrated. No actual account, app
plugin, primary phone project, Supabase schema or master deployment is changed.
Auth/token and peer-identity attestations remain fixtures. Two physical phones,
key/device/prekey lifecycle, scalable sync and independent review remain gates.

**At that checkpoint, poison recovery was deliberately not implemented.** The then-current native
provider error conflates invalid ciphertext/content with restored-state failure.
Safely retaining an unresolved encrypted row while continuing later messages
first needs typed error boundaries, a fresh binding/binary rebuild, a bounded
sealed queue with no eviction, and CAS-protected retry/promotion. Broadly catching
all decrypt/storage/lifecycle failures would hide broken local state and is refused.

### 1 October complete native/local HTTPS exchange checkpoint

The previously separate provider/network/SQL pieces now have an isolated native
client and one combined reproduction runner. `VodozemacRelayClient.swift` signs
only the sealed coordinator's durable outbox, sends over the bounded URLSession
transport, validates the exact endpoint result, and settles the record through
the existing native owner/peer/CAS guards. It never re-encrypts an uncertain send.
`VodozemacRelayResult.swift` rejects duplicate keys, numeric/Boolean confusion,
unsafe generations/cursors, extra fields, wrong identities/devices and changed
receipt ciphertext bytes. A claim is rechecked for expiry after awaiting using
monotonic elapsed time plus current native wall time, not just captured time.

Observed final run: temporary `thalassa-native-exchange-aSUXN0/exchange-run.json`
reported passed, including **eight separate simulator process-launch phases**:

- Before trust installation, normal native URLSession refused the fresh loopback
  certificate. The server observed failed TLS and no HTTP/Auth requests. After
  adding that certificate only to a newly created disposable simulator, the same
  client exchanged real signed public requests over ordinary HTTPS. There is no
  URLProtocol mock, TLS challenge override or ATS exception in this exchange.
- **Three actual Olm messages** (opening, reply and successor) travelled through
  the signed HTTP gateway and committed on-disk SQL relay, then authenticated and
  decrypted in the native Keychain-backed sealed coordinators. Native plaintext
  history checks passed; the relay's device/decision/request rows did not contain
  the three known test plaintext strings. This is a scoped check, not proof that
  every possible server artifact contains no secret.
- The opening send committed at SQL, but its response was deliberately lost.
  Native outbox stayed pending across process restart. A wrong receipt was
  refused without changing its ratchet/outbox payload. A new signed request
  reconciled the **same ciphertext and message ID**; exactly one decision existed.
- A malformed final inbox row caused the whole structural batch to be refused
  before ratchet/inbox payload mutation. A canonical but cryptographically invalid
  final row instead allowed the first valid receive to commit, then failed closed.
  Repeating that response preserved the first receive, returned no successful
  plaintext batch, and did not store the poison message. Normal rescan/duplicates
  subsequently passed. Signing-only sealed CAS revisions can increase on these
  requests; the tests assert unchanged payload where appropriate, not an unchanged
  entire database file.
- Owner-generation changes and peer block/reaccept hid old native history and
  refused old-generation rescans. These tests expose a remaining recovery limit;
  they do **not** establish successful logout/relogin or unblock reconciliation.
- SQL close/reopen, native process restarts, exact durable receipts and native
  duplicates passed. Twelve bounded native result-parser fixture groups also ran
  during preparation; those individual parser tests use fixture ciphertext and
  real Ed25519 signature checks, not additional encrypted exchanges.
- The existing seven TypeScript research suites were rerun: **474 tests passed**,
  followed by strict selected-file type checks. Changed Markdown/MJS formatting,
  both new proof-script syntax checks and diff whitespace checks passed.

The runner reused previously tested generated bindings/static provider artifacts,
verified the pinned manifest/lock and recorded immutable artifact/source hashes.
This was not a fresh Rust dependency rebuild or independently signed artifact
provenance. It compiled the new integration for the simulator; it did not execute
or install on a physical iPhone. Both logical native clients ran in one disposable
research app/simulator, not on two independent devices. Auth HTTP responses,
account IDs, credential epochs and out-of-band peer pins remain fixtures.

At that checkpoint, the bounded inbox rescanned from zero with no advancing cursor.
This avoided skipping temporarily hidden rows but stalled on old-generation duplicates
or permanent cryptographic poison. Generation-safe reconciliation/quarantine,
durable real Auth/refresh/logout state, scalable inbox sync, device/prekey
renewal/recovery, independent PostgreSQL connections, two physical phones,
locked-device/crash checks and independent security/licence review remain gates.
No Thalassa plugin/UI, live backend, production schema/account, primary phone
project or master deployment was changed. The fresh simulator, its fixture CA and
native test keys were removed; nonsecret receipts and local research artifacts
were retained. Agent review is not an independent security audit.

### 1 October isolated HTTP/native networking checkpoint

Added an **unmounted** HTTPS-only Fetch handler around the existing signed
gateway and a separate bounded native URLSession client. Only registration and
signed dispatch are exposed; no unsigned client RPC, live backend, app plugin,
production migration, private-message UI or current-phone build was changed.
The native credential context is caller-supplied research state; durable app Auth
and token lifecycle wiring remain outstanding. No homemade/PQ third ratchet was
added; the provider remains unchanged vodozemac/Olm v1 Double Ratchet.

The transport preserves exact public request/ciphertext bytes, disables redirects,
cookies/cache/stored credentials, uses default system TLS trust and drops stale
owner/credential/peer-context results. It returns public JSON bytes, not a message
decision: the coordinator must still validate the exact receipt and CAS native
state before acceptance/decryption. HTTP errors, cancellation and expiry remain
unresolved even if SQL later commits; they never invent terminal refusals.

Review found timer-only deadline gaps in both native and server components:
delayed callbacks or continuously replenished microtasks could outlast the deadline.
They now also check monotonic elapsed time before/after work and before returning
success. Review also found that parsing a result fragment alone could auto-detect
UTF-16/32 inside an invalid UTF-8 outer response; complete-document validation now
precedes strict outer framing and extraction. Both have regression coverage.

Observed:

- **474 focused TypeScript tests passed** across seven suites. These include
  mocked HTTP/Auth/SQL adapters and real signature checks where identified,
  not 474 real network or cryptographic end-to-end exchanges.
  Strict selected-file TypeScript checking, selected-file ESLint, formatting and
  proof-runner syntax checks also passed.
- **11 native URLSession fixture scenario groups passed on the Mac**, including
  actual redirect callbacks, exact transmitted request streams, declared/streamed
  bounds, malformed/mixed-encoding responses, pre-resume/post-await lifecycle
  fences, stalled/dripping streams, slow context reads and cancellation races.
  Probe bodies/Auth are fixtures. Default TLS trust and challenge behaviour are
  not demonstrated by URLProtocol interception; no native-to-service TLS or
  physical-phone execution claim is made.
- The same native client/probe compiled and linked for simulator and iPhone.
  `vtool` confirmed `IOSSIMULATOR`/`IOS` Mach-O platforms with minimum iOS 17.
  No simulator/physical-phone installation or execution occurred in this slice.
  Final native artifacts: temporary `thalassa-native-network-Zz64aR`.
- **9 actual localhost HTTPS/PostgreSQL-engine scenario groups passed**: ordinary
  TLS rejects the untrusted fixture certificate; request-local CA/hostname trust
  permits the owned loopback service. Real Ed25519 requests traverse the signed
  gateway and committed on-disk SQL relay; retries/tampering/conflicts, fresh Auth
  responses, blocks, revocation and database close/reopen passed. Auth responses
  and ciphertext are explicit fixtures, not live Supabase identities or native
  encrypted messages. Final database/certificate artifacts remain in temporary
  `thalassa-e2ee-http-1ii6zT`; no global CA was installed.

The Node proof host buffers up to 256 KiB before its Fetch adapter; unit fixtures,
not real-socket tests, cover stalled uploads/disconnect/deadline behaviour. Native
network fixtures and the real HTTPS fixture exchange are **separate** from the
preceding real-native-provider/local-SQL exchange. They are not combined proof of
two native clients using live Auth/TLS. Endpoint-specific client result validation,
real auth/logout generations, inbox sync, device/prekey renewal/recovery, multiple
independent PostgreSQL connections, physical-phone/locked-device/crash checks and
independent security/licence review remain gates. Agent review is not an audit.

See `experiments/scuttlebutt-e2ee/relay/README.md` for endpoint/retry semantics and
the two self-contained reproduction commands. All research stays on the isolated
side branch; the primary Xcode project, production accounts/schema, website and
existing messages are untouched.

### 1 October signed native-to-relay checkpoint

The native provider now signs public bundle and request bytes with its own
Ed25519 identity. Keys remain in the Keychain-backed sealed native account;
only public signatures/keys leave the provider. The Swift coordinator accepts
only its exact durable pending outbox for send signing, checks native owner/peer
generations, and CASes sealed state before exposing a signature. State version 2
includes the immutable public signing key; old research state fails closed.
There is still no Capacitor plugin or live chat import.

The signed gateway authenticates the account and verifies each request against
the registered immutable device key, not a caller-selected key. The domain binds
user/device, action, nonce, integer expiry and canonical payload bytes. Proof TTL
is at most 300 seconds. SQL atomically records request execution with immutable
message decisions; exact retries cannot repeat block/revoke mutations, and changed
wire under the same nonce fails. Read/claim retries enforce current lifecycle
policy. The server role remains trusted and private, not a client credential.

`supabaseAuth.ts` implements fresh bounded GET `/auth/v1/user` verification with
a trusted HTTPS project origin and public API key. It rejects redirects, invalid
UUID identity, oversized/stalled responses and transport errors. Its tests use
HTTP response fixtures, not a live project. Process-local app auth generations
must not become durable E2EE generations: production native logout/relogin and
confirmed-auth transition wiring remain outstanding.

Observed on the final source:

- **359 focused tests passed**, across six TypeScript suites; strict selected-file
  TypeScript and ESLint passed. These include real signature checks but mocked
  Auth/SQL adapters where identified, not 359 end-to-end security checks.
- **30 PostgreSQL-engine scenario groups passed**, including nonce conflicts,
  the 512-request owner cap, post-execution rollback, expiry, grants and real
  persisted read/claim retry policy. Fixture Auth and fixture ciphertext remain
  explicit in this SQL-only runner. Database run retained in temporary
  `thalassa-e2ee-relay-6VsvWW`.
- **15 host native-boundary tests passed** with unchanged pinned vodozemac 0.11.0
  Olm v1 and UniFFI 0.29.4; five new signing tests verify exact bytes, tampering,
  bounds, deterministic signatures and unchanged account/prekey state.
- Both simulator and unsigned physical-iPhone targets compiled/linked. **All 18
  separate simulator process phases passed**, including 112 existing coordinator
  assertions and the new native signing/lifecycle guards. Three actual native Olm
  messages passed through the signed gateway and on-disk SQL relay, then decrypted
  only in native code after restarts. Exact signed retries, changed-request refusal,
  durable inbox deduplication and database reopen passed. Public bundle/request,
  ciphertext and receipts—not private keys/pickles/plaintext/history—crossed the
  local bridge. Fresh Auth HTTP responses and out-of-band peer pins are fixtures;
  filesystem delivery is not TLS or a live authenticated response channel.

Final simulator receipt: `/private/tmp/thalassa-vodo-native.AQR0PF/run-4ec0e5b2-6e1e-4c7d-aa6f-6ab67f16a788.json`.
It records `passed`, 18 run/phase/PID observations, complete namespace cleanup and
research app uninstall; physical-device protection is explicitly `false`/unverified.
The local relay database remains at that scratch directory's `native-relay`.

Review caught an unconditional cached read/claim replay bypassing later blocks or
revocation. It was fixed and covered by three new SQL regression groups. A native
probe also incorrectly compared unsorted JSONEncoder byte ordering; it now checks
semantic state with sorted encoding. That failed test run was not relabelled as a
pass: its original failure receipt is retained, and a separate verified recovery
run authenticated and removed only its disposable UUID-bound stores/keys and app.
Its database was preserved as `native-relay-failed-f5e77d91`. Recovery never applies
to unknown launch outcomes or production keys.

Agent reviews found no further actionable issue in this slice; they are **not an
independent security audit**. No physical phones, locked-device/reboot/power-loss
behavior, live Supabase Auth/transport, independent PostgreSQL connections, real
account/device lifecycle, complete inbox sync, key renewal/recovery, UI integration
or security badge are proved. Production schema, website, primary Xcode project
and existing messages remain untouched. The next integration requires an isolated
authenticated test backend, native app lifecycle/transport wiring and a two-phone
pilot; independent security/licence review still gates distribution.

### 1 October device-directory and relay checkpoint

Historical predecessor checkpoint (before device request signing/native relay bridge):

`experiments/scuttlebutt-e2ee/relay/` adds a canonical, domain-separated Ed25519
public bundle, an injected-auth gateway boundary and a private PostgreSQL schema.
This is not an HTTP service or Supabase migration. The SQL gateway role is trusted
server-side authority; clients cannot be given it. Credentials are fixture-to-user
mappings in this proof, not real JWT verification. Signatures prove possession
of the signing key, not an independently verified first identity or device origin
of later account-authorized requests.

The bounded directory allows one immutable device and one public prekey per
account, with permanent revocation and exclusive, non-recycled prekey claims.
The relay stores exact ciphertext-envelope bytes and immutable acceptance/refusal
decisions. Block/unblock and revoke changes cannot rewrite a prior receipt.
Both local generations are comparison fields, not server authentication evidence.
All six private RPCs serialize through one transaction lock and require READ
COMMITTED. Replacement/recovery, replenishment, native registration, authenticated
network delivery, inbox reconciliation and scalable concurrency remain future work.

Observed: **19 scenario groups passed** against the hash-pinned PGlite 0.5.8
PostgreSQL engine with an on-disk disposable database. They include exact role
denials (SQLSTATE 42501 after asserting session/current identity), cross-account
ownership, immutable retries/conflicts, exclusive claims, bilateral blocks,
revocation, malformed input, transaction rollback, the 256-decision owner cap,
expiry, and orderly close/reopen. This is real SQL execution with **synthetic
principals and unencrypted fixture bytes**, not a provider-to-relay end-to-end test.
PGlite is single-connection; independently concurrent PostgreSQL transactions,
Supabase Auth/PostgREST, network response authentication, power-loss durability,
two physical phones and independent security review are **not proved**.

The permission harness uses distinct sequential sessions, explicitly setting
each fixture session's SQL authorization before testing denials. PGlite's
`username` option only performs SET ROLE, and an aborted LOCAL session-authorization
fixture did not reliably reset. Neither shortcut was accepted as permission-test
evidence. No production credential is used, and NOLOGIN research roles do not
demonstrate a real login.

**259 focused tests passed** across framing, mocked delivery, real bundle-signature
checks and mocked gateway wiring. The review also found JavaScript's `$` anchor
accepting a final newline in IDs; both older framing/delivery validators now
require a full match, with line-terminator regressions. The independent native
provider/store proof from the preceding checkpoint was not rebuilt in this slice.
See the relay README for the pinned dependency, reproduction commands, caps,
trust boundaries and the blocked-inbox cursor limitation. The SQL/files remain
outside `supabase/migrations`, app imports and the production dependency graph.

Strict TypeScript checks and selected-file ESLint passed for this checkpoint.
No web/native rebuild or Capacitor sync was needed for these unwired files;
Shane's primary Xcode project and production remained untouched.

Earlier framing/delivery baseline, retained for provenance:

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

Next: connect the native coordinator and this relay experiment through a reviewed
authenticated account/device lifecycle, including native public bundle signing
and request-origin binding. Then test the off-by-default adapter and lock/crash
behaviour on real phones. The injected-auth SQL proof is not live authenticated
transport. The synthetic single-prekey fixture is not
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
