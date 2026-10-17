# Isolated Linux PostgreSQL 17.6 catch proof

`supabase/tests/private-catches-postgres17.mjs` is an additional backend adapter for the same **31** migration, RLS, grants, constraints, tombstone, cascade and publication-refusal assertions used by the existing PGlite proof. The assertions were moved unchanged to `private-catches-cases.mjs`; PGlite still passes all 31 locally. This packet does not replace a native PostgreSQL result with a WASM result.

The real adapter refuses before importing the driver unless running on Linux with explicit opt-in, the exact `postgres://postgres:fixture-only-password@127.0.0.1:5432/catch140_test` fixture URL, an absolute local `PG_MODULE_PATH`, and no conflicting PGlite runtime. Connection fields are fixed rather than inherited from PostgreSQL environment variables. Before any DDL it independently queries and checks the actual database/user, PostgreSQL version `170006`, Linux server description, absence of user tables/functions/auth schema/custom roles, no non-fixture databases, and no existing publications. The fixture therefore requires a dedicated disposable cluster. Connection setup is bounded to 5 seconds, statements to 15 seconds, and client queries to 20 seconds.

Local, socket-free Node tests pass **22** unsafe URL/runtime/identity/version/nonempty-cluster guard cases. This is guard proof, not an assertion that native PostgreSQL has already passed. The real Linux job remains a separate reviewed workflow handoff, using an ephemeral official `postgres:17.6` service with only synthetic rows and fixture-only credentials. It needs no product database, provider, storage, auth token, signing, deployment or Pi connection. No active server or workflow is changed by these files.

After review, the pinned isolated job runs:

```sh
node --test supabase/tests/private-catches-disposable.test.mjs
THALASSA_DISPOSABLE_PRIVATE_CATCH_TEST=1 \
PRIVATE_CATCH_TEST_DATABASE_URL=postgres://postgres:fixture-only-password@127.0.0.1:5432/catch140_test \
PG_MODULE_PATH=/outside-repository/node_modules/pg/lib/index.js \
node supabase/tests/private-catches-postgres17.mjs
```

The resulting receipt must record the actual PostgreSQL server version and 31 passing cases before it can be called native database proof. Local evidence: `work/validation14006-postgres17-guard-final.log`, `work/validation14006-shared-cases-pglite.log`, `work/validation14006-pg17-lint.log` (zero errors/warnings). The frozen application source packet remains `93e075bcc56ca84e967835e33439fe85ee9dd2d0`; this follow-up changes only test adapters and documentation.
