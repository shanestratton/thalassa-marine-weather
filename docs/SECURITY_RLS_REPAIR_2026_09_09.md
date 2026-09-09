# Supabase RLS incident repair — 9 September 2026

## Status

Two live exposures are repaired and verified. One remains open with Supabase
support. This is not an all-clear or a finding that data was, or was not, accessed.

Project: `pcisdplnodrphauixcau` (Thalassa Marine Forecasting).
The 6 September alert was checked against live database metadata and Security
Advisor on 9 September, rather than assumed to reflect current migration state.

| Table                    | Before                                                              | After                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `public.sailor_blocks`   | No RLS or policies; anon/authenticated broad table privileges       | RLS; no anonymous access; authenticated users can read, upsert and delete only their own blocks                                               |
| `public.sailor_reports`  | No RLS or policies; anon/authenticated broad table privileges       | RLS; no anonymous access; authenticated users can submit reports only under their own identity, without reading, updating or deleting reports |
| `public.spatial_ref_sys` | RLS off; broad anon/authenticated grants; owned by `supabase_admin` | Unchanged; administrator remediation requested through Supabase support                                                                       |

## Applied repair

Only `20260909023000_secure_sailor_blocks_and_reports.sql` was applied. It retains
the existing legacy TEXT identity columns, generated row IDs, timestamps and all
existing rows. It records table definitions for fresh databases because these
legacy tables had no corresponding CREATE migration in the repository.

The repair revokes table privileges from PUBLIC, anon and authenticated before
granting the required authenticated column privileges and owner-scoped RLS.
Block upserts retain INSERT/UPDATE on the two identity fields plus SELECT/DELETE;
generated IDs and timestamps are not client-writable. Report submission retains
INSERT on `reporter_id`, `reported_id`, `reason`, `created_at`, with an ownership
check and no client read/modify permission. Service-role maintenance remains.

Migration history was narrowly repaired to mark this exact version applied, then
queried to confirm the version and name. No pending migrations were bulk-pushed.

## Verification

- Live metadata confirms RLS enabled and the expected policies on both tables.
- Column ACLs match the exact grants; no anonymous grants remain on either table.
- A rollback-only transaction used two synthetic identities after checking that
  they did not already occur in these tables and that no application triggers
  existed. It verified owner reads, repeated block upsert, unblock and report
  submission, other-user read/update/delete isolation, denied ownership spoofing,
  denied generated-field writes, denied report reads/updates/deletes, anonymous
  SELECT/INSERT/UPDATE/DELETE denial, and privileged maintenance reads.
- Every synthetic write was rolled back; both fixture counts were verified zero.
- 41 tests passed across `SailorSafetyRlsMigration`, `LonelyHeartsIdentity` and
  `LonelyHeartsService`. Targeted ESLint and Prettier passed.
- Migration audit passed over 161 files.
- A fresh live Security Advisor scan dropped from three ERROR findings to one:
  `rls_disabled_in_public_public_spatial_ref_sys`. The dashboard independently
  displayed that single remaining critical finding.

## Remaining provider-owned exposure

`spatial_ref_sys` and the PostGIS extension are owned by `supabase_admin`; PostGIS
is installed in `public`. Available `current_user` is `postgres`, which has neither
owner-role usage nor INSERT/UPDATE/DELETE grant options on that table. Its ACL
also includes PUBLIC SELECT. Effective anon/authenticated write and destructive
privileges are still present. Do not dismiss the finding merely because the
table contains public coordinate-system reference data.

With the user's express approval, a **High** priority support ticket was sent
through the authenticated Supabase dashboard. The dashboard confirmed
“Support request sent” and that the ticket was logged for this project, with a
reply to the account email. It did not show a ticket number.

Subject: **Urgent security remediation: public.spatial_ref_sys writable by anon;
supabase_admin ownership blocks fix**.

The request asks the owning administrator to remove untrusted write/destructive
grants, preserve required reference reads, apply supported RLS or equivalent
remediation, verify effective permissions/API access, and preserve/review relevant
access history if available. It explicitly requires a proposed plan and approval
before dropping, reinstalling or relocating PostGIS or deleting rows. No customer
records, credentials or raw logs were attached, and the optional broad human/AI
support-access toggle was left off. Additional access, if needed, requires an
explicit follow-up decision.

Do not change PostGIS catalogs or attempt to assume its owner role to bypass
these permissions. Re-check live grants and Advisor after the provider responds;
ticket submission is not remediation.

## Follow-up outside this containment change

The legacy sailor tables have no foreign keys to `auth.users`. The existing
account-deletion routine's FK discovery therefore does not automatically find
them. Explicit retention/deletion handling needs a separately reviewed change;
this repair does not claim to resolve it or delete legacy records.

## Release boundary

This is a database security migration, source contract test and evidence note.
No application bundle, native project, uploaded build 107, yacht configuration,
authentication provider or mapping extension was rebuilt or changed. Do not
rebuild or reuse the already-uploaded build number 107 for this repair.
