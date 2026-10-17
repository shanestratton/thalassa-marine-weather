# Isolated Linux PostgreSQL 17.6 catch proof

`supabase/tests/private-catches-postgres17.mjs` is an additional backend adapter for the same **31** migration, RLS, grants, constraints, tombstone, cascade and publication-refusal assertions used by the existing PGlite proof. The assertions were moved unchanged to `private-catches-cases.mjs`; PGlite still passes all 31 locally. This packet does not replace a native PostgreSQL result with a WASM result.

The real adapter refuses before importing the driver unless running on Linux with explicit opt-in, the exact `postgres://postgres:fixture-only-password@127.0.0.1:5432/catch140_test` fixture URL, an absolute local `PG_MODULE_PATH`, and no conflicting PGlite runtime. Connection fields are fixed rather than inherited from PostgreSQL environment variables. Before any DDL it independently queries and checks the actual database/user, PostgreSQL version `170006`, Linux server description, absence of user tables/functions/auth schema/custom roles, no non-fixture databases, and no existing publications. The fixture therefore requires a dedicated disposable cluster. Connection setup is bounded to 5 seconds, statements to 15 seconds, and client queries to 20 seconds.

Local, socket-free Node tests pass **22** URL/runtime/identity/version/nonempty-cluster guard cases (20 refusal cases and two positive controls). The separate reviewed Linux job has now also passed against an ephemeral official `postgres:17.6` service with only synthetic rows and fixture-only credentials. It used no product database, provider, storage, auth token, signing, deployment or Pi connection. This is an isolated migration proof; the product migration has not been applied live.

After review, the pinned isolated job runs:

```sh
node --test supabase/tests/private-catches-disposable.test.mjs
THALASSA_DISPOSABLE_PRIVATE_CATCH_TEST=1 \
PRIVATE_CATCH_TEST_DATABASE_URL=postgres://postgres:fixture-only-password@127.0.0.1:5432/catch140_test \
PG_MODULE_PATH=/outside-repository/node_modules/pg/lib/index.js \
node supabase/tests/private-catches-postgres17.mjs
```

The successful [Linux run 38990132087](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/38990132087), job `117270461811`, checked exact source `19b3a57953a0120c7e3d9fd159a2fe517a15e48e` under definition `ea66755dde7ca81989e10195f4d7da355562de9a`. Its reviewed workflow SHA-256 is `cfc9ab5fe8f879e9b3f769602bc4510bd370ec0b812bfe0b32c72b8932c59a6e`. The actual server reported **PostgreSQL 17.6 (Debian 17.6-2.pgdg13+1), x86_64-pc-linux-gnu**. All **31 shared SQL checks** and **22 guard cases** passed, with no skipped guards.

Artifact `12084792139`, `private-catch-140-pg17-19b3a5795`, is 2,607 bytes with ZIP SHA-256 `e6075326aaa8345d99154f0c01377926db5d0464d637f1541b1a4f12902194da`. Its source inventory was independently compared with exact Git blobs, including canonical migration SHA-256 `eadff4920fed6e88282012fd283b501f6a16ea121c07f9d1aa13a7531a393beb`. The captured official image repository digest is `postgres@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929`; the isolated driver was `pg@8.16.3`, with package-lock SHA-256 `fbb351241d4947e7d00459576dd0c49ffc992939f5a9d99d66a6e0a86c945c93`.

The downloaded artifact, bounded job log, extraction inventory and verification receipt are preserved under `work/validation14006-native-postgres17-proof/`. The immutable receipt `outputs/Build14006 real Linux PostgreSQL proof.json` has SHA-256 `18a1f519508f0f8956f2f2d4b5816c95edd597957fd354bc62f9c5462036a454`. Verification used GET requests only, checked metadata and byte limits before downloading, and omitted API credentials on the cross-origin artifact/log redirects. No rerun or live change was made.

Earlier local evidence remains `work/validation14006-postgres17-guard-final.log`, `work/validation14006-shared-cases-pglite.log`, and `work/validation14006-pg17-lint.log` (zero errors/warnings). The frozen application source packet remains `93e075bcc56ca84e967835e33439fe85ee9dd2d0`; its receipt and the original pending native-proof draft remain preserved. This follow-up changes only documentation.
