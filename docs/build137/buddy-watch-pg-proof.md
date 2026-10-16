# Disposable buddy-watch database proof

`supabase/tests/buddy-watch-db.mjs` keeps its existing 45 ACL, ownership, held
capability, compare-and-swap, cooldown, bounded-state and quota assertions. The
default outside-repository PGlite run passes all 45 and explicitly reports that
it has not exercised PostGIS or concurrent database sessions.

The PostgreSQL-only extension is
`supabase/tests/buddy-watch-postgres-cases.mjs`. Its only caller is behind the
existing explicit opt-in, empty-database and exact localhost `buddy137_test`
guards. The URL pins port 5432 and the disposable `postgres` / `fixture-only-password`
identity, rejects query/hash overrides and mixed-runtime variables, and checks
the actual database name, emptiness and exact PostgreSQL 17.6 before any DDL.
It installs no packages and uses the PostGIS
extension that the guarded harness creates in the `extensions` namespace. There
is no HTTP client, provider query, notification delivery or product credential.
Only synthetic fixture rows are written to the disposable database.

The extension verifies:

- Actual geography distance in nautical miles: coincident points, an asymmetric
  equatorial case checked against the WGS84 equatorial circumference, high
  latitude, and the short antimeridian crossing. A public-schema function trap
  rejects accidentally unqualified spatial lookup. No chosen-area/provider
  coordinates may appear in returned scalar facts.
- Sixteen distinct database backends, all observed waiting behind a real
  PostgreSQL lock before release. Merely launching promises is not counted as
  overlapping execution.
- The ten-watch account bound across two owned hulls, with six concurrent
  capacity refusals; one configuration-revision winner and fifteen reviewable
  conflicts; one winner for each empty/existing state revision.
- Pending assessments refusing original facts or explicit configuration changed
  while they waited for the watch lock.
- Sixteen overlapping apply requests across ten eligible watches competing for
  one remaining daily notification slot: ten state advances, six duplicate-CAS
  refusals, exactly one ordinary queue row, and quota exactly twelve. The queued
  observation retains its original source clock and contains no coordinates.

Each cohort is capped at 16 sessions, the pool at 18, lock-barrier waiting at five
seconds, connection setup at five seconds and SQL statements at fifteen seconds.
Failure paths release/roll back fixture locks and sessions. The final receipt
records actual server/PostGIS versions, spatial namespace and seven overlap
cohorts. It never labels the PGlite path as spatial/concurrency proof.

Actual PostgreSQL execution requires a **new empty** local database without a
preinstalled PostGIS reference table; the harness creates the extension after
checking emptiness:

```sh
THALASSA_DISPOSABLE_BUDDY_TEST=1 \
BUDDY_TEST_DATABASE_URL=postgres://postgres:fixture-only-password@localhost:5432/buddy137_test \
PG_MODULE_PATH=/outside-repository/node_modules/pg/lib/index.js \
node supabase/tests/buddy-watch-db.mjs
```

No held migration, production function, cron or delivery capability is changed
by this test-source packet. The standard Vitest suite includes 15 disposable
guard cases in `tests/BuddyWatchDisposableGuard.test.ts`: unsafe URL/driver
refusal, actual database/version/emptiness before DDL, and conflicting runtime
variables. These use a socket-free fake driver and pass locally.
The 45-case PGlite baseline and JS syntax checks are
verified locally; the actual PostgreSQL/PostGIS result must come from the
dedicated source-pinned Linux proof before being reported as passed.

Primary semantics checked against [Supabase's PostGIS namespace guidance](https://supabase.com/docs/guides/database/extensions/postgis),
[PostGIS geography distance units](https://postgis.net/docs/ST_Distance.html), and
[PostgreSQL 17 row/advisory lock behavior](https://www.postgresql.org/docs/17/explicit-locking.html).
