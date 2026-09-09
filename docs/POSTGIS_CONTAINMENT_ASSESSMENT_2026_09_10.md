# PostGIS containment verification and relocation assessment

Project: `pcisdplnodrphauixcau`. Support ticket: **SU-467604**, Clément Aucouturier.
Verified **10 September 2026, 05:51–05:53 AEST** (9 September 19:51–19:53 UTC).

## Outcome and authority boundary

**Support's write containment is effective. Relocation is not yet safe to approve as an extension-only change.** Thirteen application functions need explicit dependency/search-path treatment, and the current database role cannot perform the privileged relocation.

This assessment used catalog SELECTs inside `BEGIN READ ONLY` / `ROLLBACK`, Security Advisor reads, and two public-reference-data API GETs. No live DDL/DML, migration, extension update, role escalation, email, or support reply was performed. Credentials were not printed. Earlier incident history remains in [the 9 September repair note](SECURITY_RLS_REPAIR_2026_09_09.md); its then-current spatial-reference exposure is superseded by the checks here.

## Verified permissions

| Access                              | `anon`                     | `authenticated`            | PUBLIC ACL       |
| ----------------------------------- | -------------------------- | -------------------------- | ---------------- |
| SELECT                              | Allowed                    | Allowed                    | SELECT only      |
| INSERT / UPDATE / DELETE / TRUNCATE | Denied                     | Denied                     | No grants        |
| REFERENCES / TRIGGER / MAINTAIN     | Denied                     | Denied                     | No grants        |
| Column INSERT / UPDATE / REFERENCES | Denied on all five columns | Denied on all five columns | No column grants |

Effective privilege checks include inherited access; neither client role has another role membership. The table ACL now grants only SELECT directly to the client roles, with SELECT also granted to PUBLIC. Privileged `postgres`, `service_role`, and owner `supabase_admin` retain maintenance/write access.

`public.spatial_ref_sys` remains owned by `supabase_admin`; RLS and FORCE RLS remain false. The available `postgres` role has neither owner-role usage/SET permission nor UPDATE permission on `pg_catalog.pg_extension`; it also lacks the table's INSERT/UPDATE/DELETE grant options. No SECURITY DEFINER function body directly referencing `spatial_ref_sys` was found; this text scan does not establish absence of every possible indirect/dynamic path.

Read-only Data API checks with the existing public client key:

- `public.spatial_ref_sys`, selecting only SRID 4326: HTTP 200, returned `4326`.
- The same GET with `Accept-Profile: extensions`: HTTP 406 / `PGRST106`; exposed schemas are `public, graphql_public`, not `extensions`.

No write/delete/truncate request was attempted, even with zero-row predicates. Authenticated-session HTTP writes were not tested; denial above is from effective live database privileges.

The fresh Security Advisor scan still reports one ERROR, `rls_disabled_in_public` on `spatial_ref_sys`, and the WARN `extension_in_public` for PostGIS. The complete scan has 119 WARN findings; this is not an all-clear on unrelated warnings. Public-schema default privileges for newly created tables still grant broad client rights for both `postgres` and `supabase_admin` creators. Those defaults do not re-grant this existing table automatically, but recreation/maintenance merits explicit ACL re-verification. Historical abuse or reference-data integrity has not been established either way.

## Installation and dependency findings

- PostgreSQL **17.6**; PostGIS installed/default available **3.3.7**, schema `public`, owner `supabase_admin`, `extrelocatable=false`.
- PostGIS reports GEOS 3.12.1 and PROJ 9.4.0, without a reported scripts/library mismatch.
- No raster/topology/SFCGAL/tiger companion extension is installed, and no dependent extension was found.
- `extensions` exists; client roles have USAGE, not CREATE. The checked target function signatures and relation names have no collisions. This is not a comprehensive proof against all object-kind collisions.
- Available catalog paths include **3.3.7 → 3.3.7next → 3.3.7**. No 3.3.7 → ANY path exists. No upgrade was executed.
- Six application geography columns exist: `guardian_alerts.location`; `guardian_profiles.armed_position`, `.home_coordinate`, `.last_known_position`, `.armed_location`; `vessels.location`. All are `geography(Point,4326)`.
- Four associated GiST indexes are ready and valid: `idx_guardian_alerts_location`, `idx_guardian_profiles_home`, `idx_guardian_profiles_position`, `vessels_location_idx`.

All thirteen following application functions contain **unqualified** PostGIS function/type names. Their pinned paths omit `extensions`, so moving the extension without updating these contracts risks missing-function/type errors on fresh execution. A global database search-path change does not override these per-function settings.

| Function in `public`            | Pinned `search_path`          | Security |
| ------------------------------- | ----------------------------- | -------- |
| `broadcast_guardian_alert`      | `pg_catalog, public`          | DEFINER  |
| `check_bolo_distance`           | `pg_catalog, public, pg_temp` | DEFINER  |
| `check_geofence_distance`       | `pg_catalog, public, pg_temp` | DEFINER  |
| `guardian_alerts_nearby`        | `pg_catalog, public`          | DEFINER  |
| `guardian_arm`                  | `pg_catalog, public`          | DEFINER  |
| `guardian_heartbeat`            | `pg_catalog, public`          | DEFINER  |
| `guardian_set_home`             | `pg_catalog, public, pg_temp` | DEFINER  |
| `guardian_watchdog_position`    | `pg_catalog, public`          | DEFINER  |
| `merge_vessels`                 | `public`                      | DEFINER  |
| `nearby_guardians`              | `pg_catalog, public`          | DEFINER  |
| `queue_guardian_watchdog_alert` | `pg_catalog, public`          | DEFINER  |
| `search_vessels`                | `pg_catalog, public, pg_temp` | DEFINER  |
| `vessels_nearby`                | `pg_catalog, public`          | INVOKER  |

This reaches AIS ingestion/search and Guardian safety functions, not merely cosmetic chart rendering. The evidence JSON includes exact overload arguments and referenced spatial symbols. The raw dependency query found 372 edges, but many are implicit extension internals; that number must **not** be described as 372 application dependencies. Catalog links alone also miss late-bound SQL/PLpgSQL body references, which is why the thirteen-function text scan matters.

## Assessment of support's two suggested approaches

The [support-linked gist](https://gist.github.com/monicakh/de0f842876f94a80004d42498b2af093) is actually a **drop/reinstall** example: copy spatial values to WKT, drop dependent spatial columns, reinstall, and restore values. It is not metadata-only relocation, and its dummy-table recipe is not a complete restore plan for these tables, indexes, constraints, triggers, grants, SRIDs/dimensions, and RPCs. Do not apply it or `DROP EXTENSION ... CASCADE` to this production database as a shortcut.

The [Supabase troubleshooting procedure](https://supabase.com/docs/guides/database/extensions/postgis#troubleshooting) offers a provider-assisted relocation transaction with temporary relocatability, a schema move, a forced extension update, and restoring the flag. [Official PostGIS guidance](https://postgis.net/documentation/tips/tip-move-postgis-schema/) explains that the update reinstalls internally schema-qualified functions and distinguishes the pre-3.5 `next` path from `ANY`. This installation has the former path. Neither page is a substitute for the application's thirteen-function review or the provider-owned extension permissions.

Recommended next step is a **reviewed, provider-assisted in-place plan, rehearsed on a restored staging copy**, not approval to run a generic snippet. Before any production authorization, require:

1. A verified recoverable backup/restore point and an agreed maintenance/rollback plan; neither was tested in this assessment.
2. Supabase confirmation of the operator, exact 3.3.7 update path, transaction boundaries and ownership handling. The available `postgres` role cannot perform the required catalog update or assume `supabase_admin`.
3. Reviewed schema-qualified `extensions` references, or carefully pinned paths, for all thirteen application functions while preserving overloads, ownership, SECURITY DEFINER status and execution grants. Update future-install migration assumptions separately; do not rewrite applied history blindly.
4. Staging checks for all six spatial columns, four indexes, dependent functions and Guardian/AIS workflows, including fresh sessions; restore validation must preserve more than WKT values.
5. Post-change checks of version/schema, effective PUBLIC/client/table/column grants, Data API exposure, spatial read/transform behavior, Security Advisor and absence of remaining old-schema references. Recheck containment after later extension/PostgreSQL maintenance.

## Local read-only evidence

- [Primary catalog query](/private/tmp/thalassa-postgis-readonly-20260910.WIShfM/metadata.sql) and [result](/private/tmp/thalassa-postgis-readonly-20260910.WIShfM/metadata.json).
- [Follow-up query](/private/tmp/thalassa-postgis-readonly-20260910.WIShfM/followup.sql) and [result](/private/tmp/thalassa-postgis-readonly-20260910.WIShfM/followup.json).
- [Data API GET results](/private/tmp/thalassa-postgis-readonly-20260910.WIShfM/api-read-checks.jsonl).
- [Fresh Security Advisor results](/private/tmp/thalassa-postgis-readonly-20260910.WIShfM/advisors.json).
- Support Gmail thread ID: `1a083fd43d1a3d39`; reply dated 9 September 2026, 10:05 UTC. Read only; no reply/draft created.

Temporary evidence paths are local audit artifacts, not durable backups. They contain catalog metadata and the public SRID check, not customer rows or credentials.
