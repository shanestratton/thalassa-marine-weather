/**
 * One hull, one skipper — MMSI claim + Release (Shane, 2026-09-08).
 *
 * "the only way a person can get access to the same vessel as someone who has
 * already claimed it, is via the invite part. however we also need a way for a
 * punter to release a vessel in case it has been sold, or they were just doing
 * a delivery." The migration is the seam; these pins keep it honest, in the
 * VesselTelemetryContract style (source pins, no database).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const MIGRATION = 'supabase/migrations/20260908170000_vessel_claim_and_release.sql';
const sql = read(MIGRATION);

/** The full text of one function definition: header, body, closing `$$;`. */
function fn(name: string): string {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} is defined in the migration`).toBeGreaterThan(-1);
    const end = sql.indexOf('\n$$;', start);
    expect(end, `${name} closes its dollar-quoted body`).toBeGreaterThan(start);
    return sql.slice(start, end + 4);
}

/** One SQL statement starting at `marker`, up to and including its `;`. */
function statement(source: string, marker: string): string {
    const start = source.indexOf(marker);
    expect(start, `statement "${marker}" exists`).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf(';', start) + 1);
}

const FLEET_ROW_FUNCTIONS: Array<[string, string]> = [
    ['_owned_vessel_fleet_rows', 'UUID, UUID, BOOLEAN'],
    ['create_owned_vessel_profile', 'JSONB, JSONB, JSONB, TEXT, TEXT, JSONB'],
    [
        'patch_owned_vessel_profile',
        '\n    UUID, JSONB, JSONB, JSONB, BOOLEAN, TEXT, BOOLEAN, TEXT, BOOLEAN, JSONB, BIGINT\n',
    ],
    ['set_active_owned_vessel', 'UUID'],
    ['bootstrap_owned_vessel_profile', 'JSONB, JSONB, JSONB, TEXT, TEXT, JSONB'],
    ['get_released_vessels', ''],
];

const CLIENT_RPCS: Array<[string, string]> = [
    ['release_owned_vessel', 'UUID, TEXT'],
    ['undo_vessel_release', 'UUID'],
    ['get_released_vessels', ''],
    ['create_owned_vessel_profile', 'JSONB, JSONB, JSONB, TEXT, TEXT, JSONB'],
    [
        'patch_owned_vessel_profile',
        '\n    UUID, JSONB, JSONB, JSONB, BOOLEAN, TEXT, BOOLEAN, TEXT, BOOLEAN, JSONB, BIGINT\n',
    ],
    ['set_active_owned_vessel', 'UUID'],
    ['bootstrap_owned_vessel_profile', 'JSONB, JSONB, JSONB, TEXT, TEXT, JSONB'],
];

/** Every function this migration (re)defines — the bodies later migrations must not silently supersede. */
const DEFINED_FUNCTIONS = [
    'sync_boat_summary_from_profile',
    'assert_mmsi_unclaimed',
    '_owned_vessel_fleet_rows',
    'create_owned_vessel_profile',
    'patch_owned_vessel_profile',
    'set_active_owned_vessel',
    'bootstrap_owned_vessel_profile',
    'release_owned_vessel',
    'undo_vessel_release',
    'get_released_vessels',
    'sync_vessel_crew_to_boat_members',
];

describe('vessel claim + release migration', () => {
    it('is balanced, defines exactly the eleven functions, and every definer pins search_path', () => {
        expect((sql.match(/\$\$/g) ?? []).length % 2).toBe(0);
        const definitions = (sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length;
        expect(definitions).toBe(DEFINED_FUNCTIONS.length);
        for (const name of DEFINED_FUNCTIONS) {
            expect(sql, `${name} is defined here`).toContain(`CREATE OR REPLACE FUNCTION public.${name}(`);
        }
        expect((sql.match(/SECURITY DEFINER/g) ?? []).length).toBe(definitions);
        expect((sql.match(/SET search_path = pg_catalog, public/g) ?? []).length).toBe(definitions);
    });

    it('is the LATEST definition of every function it carries — a later migration that redefines one must update this contract', () => {
        // The bodies here were copied from the latest definitions on 2026-09-08
        // (20260727120000 / 20260728130000 / 20260728140000 / 20260516150000 +
        // 20260728150000). If a newer migration redefines any of them, the
        // claim/release pins below no longer describe what runs in production.
        const later = readdirSync('supabase/migrations')
            .filter((n) => n.endsWith('.sql') && n > '20260908170000_vessel_claim_and_release.sql')
            .sort();
        for (const file of later) {
            const text = read(`supabase/migrations/${file}`);
            for (const name of DEFINED_FUNCTIONS) {
                expect(text, `${file} redefines ${name}; re-pin the contract against it`).not.toMatch(
                    new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${name}\\s*\\(`),
                );
            }
        }
    });

    it('carries the 2026-09-08 decision and the pre-push duplicate-MMSI query in its header', () => {
        const header = sql.slice(0, sql.indexOf('-- ── 1. Columns'));
        expect(header).toContain('2026-09-08');
        expect(header).toContain('supabase db push');
        expect(header).toContain('HAVING count(*) > 1;');
        expect(header).toMatch(/WHERE b\.archived_at IS NULL\s+--\s+GROUP BY 1/);
    });

    it('never touches RLS policies or the publication, and never changes boats.owner_id', () => {
        expect(sql).not.toMatch(/CREATE POLICY|DROP POLICY|ALTER POLICY|ALTER PUBLICATION/);
        // No SET clause anywhere in the file writes owner_id: there is no transfer.
        for (const update of sql.matchAll(/UPDATE public\.\w+(?: AS \w+)?\s+SET([\s\S]*?)\s+WHERE/g)) {
            expect(update[1]).not.toMatch(/\bowner_id\s*=/);
        }
    });
});

describe('the claim', () => {
    it('is a partial unique index on active boats only, so Archive and Release both free the MMSI', () => {
        expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS boats_active_mmsi_claim');
        expect(sql).toMatch(
            /boats_active_mmsi_claim\s+ON public\.boats \(mmsi\)\s+WHERE archived_at IS NULL AND mmsi IS NOT NULL;/,
        );
        expect(sql).toContain("ADD COLUMN IF NOT EXISTS mmsi TEXT CHECK (mmsi IS NULL OR mmsi ~ '^[0-9]{9}$')");
        expect(sql).toContain('ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ');
        expect(sql).toContain("release_reason IN ('sold', 'delivery_complete', 'other')");
        expect(sql).toContain('ADD COLUMN IF NOT EXISTS mmsi_at_release TEXT');
        expect(sql).toContain('ADD COLUMN IF NOT EXISTS boat_id UUID REFERENCES public.boats(id) ON DELETE SET NULL');
    });

    it('backfills exactly as decided: oldest active boat wins, losers are NOTICEd, relays only for sole-boat owners', () => {
        const backfill = sql.slice(sql.indexOf('-- ── 2. Backfill'), sql.indexOf('-- ── 3. The claim itself'));
        expect(backfill).toMatch(
            /ROW_NUMBER\(\) OVER \(\s+PARTITION BY regexp_replace[\s\S]*?ORDER BY boat\.created_at, boat\.id/,
        );
        expect(backfill).toContain('AND candidate.rn = 1');
        expect(backfill).toContain("AND candidate.norm ~ '^[0-9]{9}$'");
        expect(backfill).toContain('AND boat.mmsi IS NULL'); // re-run safe: never overwrites a claim
        expect(backfill).toContain(
            "RAISE NOTICE 'MMSI % on boat % (%) is held by an older active boat; no claim assigned'",
        );
        const relays = statement(backfill, 'WITH sole AS');
        expect(relays).toContain('HAVING COUNT(*) = 1');
        expect(relays).toContain('UPDATE public.pi_diary_relays AS relay');
        expect(relays).toContain('AND relay.boat_id IS NULL');
        // Backfill runs BEFORE the unique index exists.
        expect(sql.indexOf('WITH candidates AS')).toBeLessThan(
            sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS boats_active_mmsi_claim'),
        );
    });

    it('summary trigger claims only when free and never refuses (advisory on edits)', () => {
        const trigger = fn('sync_boat_summary_from_profile');
        expect(trigger).toContain(
            "PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:mmsi-claim:' || wanted_mmsi, 0));",
        );
        expect(trigger).toMatch(
            /NOT EXISTS \(\s+SELECT 1\s+FROM public\.boats AS other\s+WHERE other\.mmsi = wanted_mmsi\s+AND other\.archived_at IS NULL\s+AND other\.id <> NEW\.boat_id\s+\)/,
        );
        expect(trigger).toContain('mmsi = claimed_mmsi');
        expect(trigger).not.toContain('RAISE EXCEPTION');
        // The pre-existing name/type/model mirror is intact.
        expect(trigger).toContain("IF profile_name IS NOT NULL AND profile_type IN ('sail', 'power', 'observer') THEN");
        expect(trigger).toContain("model = NULLIF(BTRIM(NEW.profile ->> 'model'), ''),");
    });

    it('assert_mmsi_unclaimed is internal, names the boat and never the owner', () => {
        const assert = fn('assert_mmsi_unclaimed');
        expect(assert).toContain("RAISE EXCEPTION 'MMSI_CLAIMED'");
        expect(assert).toMatch(/USING ERRCODE = 'P0001',\s+DETAIL = holder_name,\s+HINT = p_mmsi;/);
        expect(assert).toContain('SELECT holder.name');
        expect(assert).not.toMatch(/holder\.owner_id|DETAIL = .*owner/);
        expect(sql).toContain(
            'REVOKE ALL ON FUNCTION public.assert_mmsi_unclaimed(TEXT, UUID) FROM PUBLIC, anon, authenticated;',
        );
        expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.assert_mmsi_unclaimed/);
    });

    it('is refused HARD only on create and bootstrap; patch stays advisory', () => {
        const create = fn('create_owned_vessel_profile');
        const bootstrap = fn('bootstrap_owned_vessel_profile');
        const patch = fn('patch_owned_vessel_profile');

        expect(create).toContain("'thalassa:mmsi-claim:'");
        expect(create).toContain('PERFORM public.assert_mmsi_unclaimed(wanted_mmsi, NULL);');
        // Owner lock first, then MMSI lock, then the insert — deterministic and deadlock-free.
        expect(create.indexOf("'thalassa:owned-boat-limit:'")).toBeLessThan(create.indexOf("'thalassa:mmsi-claim:'"));
        expect(create.indexOf('assert_mmsi_unclaimed')).toBeLessThan(
            create.indexOf('INSERT INTO public.boats AS boat'),
        );
        // The 20260728140000 ambiguity fix survives.
        expect(create).toContain('RETURNING boat.id INTO new_boat_id;');

        expect(bootstrap).toContain("'thalassa:mmsi-claim:'");

        expect(patch).not.toContain('assert_mmsi_unclaimed');
        expect(patch).not.toContain('MMSI_CLAIMED');
        expect(patch).not.toContain('mmsi-claim');
        // The 20260728130000 ambiguity fix survives.
        expect(patch).toContain('ELSE target.polar_data END');
        expect(patch).toContain('WHERE target.boat_id = p_boat_id;');
    });

    it('bootstrap refuses to resurrect a hull this account released — after the existing-boat branch, before create', () => {
        const bootstrap = fn('bootstrap_owned_vessel_profile');
        expect(bootstrap).toContain("RAISE EXCEPTION 'VESSEL_RELEASED'");
        expect(bootstrap).toMatch(
            /USING ERRCODE = 'P0001',\s+DETAIL = released_name,\s+HINT = released_when::TEXT \|\| '\|' \|\| COALESCE\(released_why, 'other'\);/,
        );
        expect(bootstrap).toContain('AND released.released_at IS NOT NULL');
        expect(bootstrap).toContain('released.mmsi_at_release = wanted_mmsi');
        expect(bootstrap).toContain('lower(released.name) = wanted_name');
        expect(bootstrap).toContain('WHERE released.owner_id = current_owner_id');
        const existingBranch = bootstrap.indexOf('IF existing_boat_id IS NOT NULL THEN');
        const guard = bootstrap.indexOf("RAISE EXCEPTION 'VESSEL_RELEASED'");
        const create = bootstrap.indexOf('FROM public.create_owned_vessel_profile(');
        expect(existingBranch).toBeLessThan(guard);
        expect(guard).toBeLessThan(create);
        // Deliberate Add vessel carries no such guard.
        expect(fn('create_owned_vessel_profile')).not.toContain('VESSEL_RELEASED');
    });
});

describe('release_owned_vessel', () => {
    let release = '';
    beforeAll(() => {
        release = fn('release_owned_vessel');
    });

    it('is an authenticated-only SECURITY DEFINER RPC with the fleet owner lock', () => {
        expect(release).toContain('RETURNS JSONB');
        expect(release).toContain("IF p_reason IS NULL OR p_reason NOT IN ('sold', 'delivery_complete', 'other') THEN");
        expect(release).toContain(
            "PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:owned-boat-limit:' || current_owner_id::TEXT, 0));",
        );
    });

    it('archives under the SAME owner and keeps the MMSI as it stood', () => {
        const archive = statement(release, 'UPDATE public.boats AS boat');
        expect(archive).toContain('archived_at = now(),');
        expect(archive).toContain('released_at = now(),');
        expect(archive).toContain('release_reason = p_reason,');
        expect(archive).toContain('mmsi_at_release = boat.mmsi');
        expect(archive).toContain('AND boat.owner_id = current_owner_id');
        expect(archive).toContain('AND boat.archived_at IS NULL;');
        expect(archive).not.toMatch(/SET[\s\S]*owner_id\s*=[\s\S]*WHERE/);
        expect(release).toContain(
            "RAISE EXCEPTION 'Vessel not found, already archived, or not owned by current user' USING ERRCODE = '42501';",
        );
    });

    it('never mentions the operational history tables', () => {
        expect(release).not.toMatch(/ship_logs|live_track|diary_entries|\bvoyages\b/);
    });

    it('unpairs ONLY the Pi matched to this hull and reports, never deletes, unmatched relays', () => {
        const cut = statement(release, 'DELETE FROM public.pi_diary_relays');
        expect(cut).toMatch(
            /DELETE FROM public\.pi_diary_relays AS relay\s+WHERE relay\.owner_id = current_owner_id\s+AND relay\.boat_id = p_boat_id;/,
        );
        expect(cut).not.toContain('boat_id IS NULL');
        // Exactly one DELETE on the relay table.
        expect((release.match(/DELETE FROM public\.pi_diary_relays/g) ?? []).length).toBe(1);
        // The unmatched count is a SELECT, not a DELETE.
        expect(release).toMatch(
            /SELECT COUNT\(\*\)\s+INTO relays_unmatched\s+FROM public\.pi_diary_relays AS relay\s+WHERE relay\.owner_id = current_owner_id\s+AND relay\.boat_id IS NULL;/,
        );
        // DELETE, not enabled = false: a disabled row would 409 the next skipper with no reset path.
        expect(cut).not.toContain('enabled');
    });

    it('ends account-wide crew, codes and the legacy identity ONLY on the last active boat', () => {
        const branchStart = release.indexOf('IF remaining = 0 THEN');
        const branchEnd = release.indexOf('ELSE', branchStart);
        expect(branchStart).toBeGreaterThan(-1);
        expect(branchEnd).toBeGreaterThan(branchStart);
        const lastBoat = release.slice(branchStart, branchEnd);
        const elsewhere = release.slice(0, branchStart) + release.slice(branchEnd);

        expect(lastBoat).toContain('DELETE FROM public.vessel_identity');
        expect(elsewhere).not.toContain('DELETE FROM public.vessel_identity');
        expect((release.match(/DELETE FROM public\.vessel_identity/g) ?? []).length).toBe(1);

        expect(lastBoat).toContain('DELETE FROM public.vessel_crew');
        expect(elsewhere).not.toContain('DELETE FROM public.vessel_crew');
        expect(lastBoat).toMatch(
            /UPDATE public\.manifest_invites AS invite\s+SET status = 'revoked'\s+WHERE invite\.owner_id = current_owner_id\s+AND invite\.status = 'pending';/,
        );
        expect(elsewhere).not.toContain('manifest_invites');

        // With boats left, the compatibility row follows the replacement.
        expect(release.slice(branchEnd)).toContain(
            'PERFORM public.project_selected_boat_to_vessel_identity(current_owner_id);',
        );
    });

    it('removes the hull’s crew landings, clears telemetry, and darkens the public page (AIS + instruments pinned off)', () => {
        expect(release).toMatch(
            /DELETE FROM public\.boat_members AS member\s+WHERE member\.boat_id = p_boat_id\s+AND member\.role = 'crew';/,
        );
        expect(release).toMatch(
            /DELETE FROM public\.vessel_telemetry AS telemetry\s+WHERE telemetry\.owner_id = current_owner_id\s+AND \(\s+telemetry\.boat_id = p_boat_id\s+OR \(telemetry\.boat_id IS NULL AND remaining = 0\)\s+\);/,
        );
        const page = statement(release, 'UPDATE public.voyage_log_configs');
        expect(page).toContain('enabled = false,');
        expect(page).toContain('public_ais_enabled = false,');
        expect(page).toContain('public_instruments_enabled = false');
        expect(page).toContain('AND config.boat_id = p_boat_id;');
    });

    it('returns the counts the result dialog reads', () => {
        for (const key of [
            'released',
            'remaining_active_boats',
            'next_active_boat_id',
            'crew_removed',
            'invites_revoked',
            'relays_removed',
            'relays_unmatched',
            'telemetry_cleared',
            'public_pages_disabled',
        ]) {
            expect(release).toContain(`'${key}',`);
        }
    });
});

describe('undo_vessel_release and get_released_vessels', () => {
    it('undo restores within 30 days, re-checks the claim under the lock, and never restores crew/relays/page', () => {
        const undo = fn('undo_vessel_release');
        expect(undo).toContain("AND boat.released_at > now() - interval '30 days'");
        expect(undo).toContain(
            "PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:mmsi-claim:' || wanted_mmsi, 0));",
        );
        expect(undo).toContain('claim_lost := true;');
        expect(undo).toMatch(
            /SET archived_at = NULL,\s+released_at = NULL,\s+release_reason = NULL,\s+mmsi = claimed_mmsi,\s+mmsi_at_release = NULL/,
        );
        expect(undo).toContain("'claim_lost', claim_lost");
        expect(undo).not.toMatch(/INSERT INTO public\.(boat_members|vessel_crew|pi_diary_relays)/);
        expect(undo).not.toContain('voyage_log_configs');
        // Re-select only when nothing is selected; the trigger re-projects identity.
        expect(undo).toMatch(
            /IF NOT EXISTS \(\s+SELECT 1\s+FROM public\.user_active_vessels AS active\s+WHERE active\.user_id = current_owner_id\s+\) THEN\s+INSERT INTO public\.user_active_vessels/,
        );
    });

    it('get_released_vessels lists the caller’s releases from the last 30 days in fleet-row shape', () => {
        const released = fn('get_released_vessels');
        expect(released).toContain('FROM public._owned_vessel_fleet_rows(current_owner_id, NULL, true) AS fleet_row');
        expect(released).toContain('WHERE fleet_row.released_at IS NOT NULL');
        expect(released).toContain("AND fleet_row.released_at > now() - interval '30 days'");
        expect(released).toContain('current_owner_id UUID := auth.uid();');
    });
});

describe('fleet row shape', () => {
    it('adds mmsi_claimed / released_at / release_reason to _owned_vessel_fleet_rows and every RETURNS TABLE wrapper', () => {
        const tail =
            'is_active BOOLEAN,\n    mmsi_claimed BOOLEAN,\n    released_at TIMESTAMPTZ,\n    release_reason TEXT\n)';
        expect((sql.match(/RETURNS TABLE \(/g) ?? []).length).toBe(FLEET_ROW_FUNCTIONS.length);
        for (const [name] of FLEET_ROW_FUNCTIONS) {
            expect(fn(name), `${name} returns the extended row`).toContain(tail);
        }
        const rows = fn('_owned_vessel_fleet_rows');
        expect(rows).toContain('(boat.mmsi IS NOT NULL AND boat.archived_at IS NULL) AS mmsi_claimed,');
        expect(rows).toContain('boat.released_at,');
        expect(rows).toContain('boat.release_reason');
    });

    it('drops every RETURNS TABLE function before recreating it, dependents before the row source', () => {
        for (const [name, args] of FLEET_ROW_FUNCTIONS) {
            const drop = sql.indexOf(`DROP FUNCTION IF EXISTS public.${name}(${args})`);
            const create = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
            expect(drop, `${name} has a DROP FUNCTION IF EXISTS`).toBeGreaterThan(-1);
            expect(drop, `${name} is dropped before it is created`).toBeLessThan(create);
        }
        const rowsDrop = sql.indexOf('DROP FUNCTION IF EXISTS public._owned_vessel_fleet_rows(');
        for (const [name] of FLEET_ROW_FUNCTIONS) {
            if (name === '_owned_vessel_fleet_rows') continue;
            expect(
                sql.indexOf(`DROP FUNCTION IF EXISTS public.${name}(`),
                `${name} drops before the row source`,
            ).toBeLessThan(rowsDrop);
        }
        // Functions whose return type did not change are not dropped.
        expect(sql).not.toMatch(/DROP FUNCTION[^;]*archive_owned_vessel/);
        expect(sql).not.toMatch(/DROP FUNCTION[^;]*get_owned_vessel_fleet/);
        expect(sql).not.toMatch(/DROP FUNCTION[^;]*sync_vessel_crew_to_boat_members/);
        expect(sql).not.toMatch(/DROP FUNCTION[^;]*sync_boat_summary_from_profile/);
    });

    it('re-applies the 20260727120000 grant posture to every client RPC, and keeps the row source private', () => {
        for (const [name, args] of CLIENT_RPCS) {
            expect(sql, `${name} revoked from PUBLIC, anon`).toContain(
                `REVOKE ALL ON FUNCTION public.${name}(${args})`,
            );
            const revoke = statement(sql, `REVOKE ALL ON FUNCTION public.${name}(${args})`);
            expect(revoke).toMatch(/FROM PUBLIC, anon;/);
            const grant = statement(sql, `GRANT EXECUTE ON FUNCTION public.${name}(${args})`);
            expect(grant).toMatch(/TO authenticated;/);
        }
        expect(sql).toMatch(
            /REVOKE ALL ON FUNCTION public\._owned_vessel_fleet_rows\(UUID, UUID, BOOLEAN\)\s+FROM PUBLIC, anon, authenticated;/,
        );
        expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\._owned_vessel_fleet_rows/);
        expect(sql).toContain(
            'REVOKE ALL ON FUNCTION public.sync_boat_summary_from_profile() FROM PUBLIC, anon, authenticated;',
        );
    });
});

describe('sync_vessel_crew_to_boat_members', () => {
    let bridge = '';
    beforeAll(() => {
        bridge = fn('sync_vessel_crew_to_boat_members');
    });

    it('lands accepted crew on the owner’s LIVE hull via ORDER BY, never a bare LIMIT 1', () => {
        expect(bridge).toMatch(
            /FROM public\.boats AS boat\s+LEFT JOIN public\.user_active_vessels AS active\s+ON active\.user_id = boat\.owner_id\s+AND active\.boat_id = boat\.id\s+WHERE boat\.owner_id = target_owner_id\s+AND boat\.archived_at IS NULL\s+ORDER BY \(active\.boat_id IS NOT NULL\) DESC, boat\.updated_at DESC, boat\.id\s+LIMIT 1;/,
        );
        expect(bridge).not.toMatch(/WHERE owner_id = target_owner_id\s+LIMIT 1/);
        expect(bridge).not.toMatch(/FROM public\.boats\s+WHERE/);
    });

    it('removes the crew’s landing on every boat of that owner when they leave or decline', () => {
        expect(bridge).toMatch(
            /DELETE FROM public\.boat_members AS member\s+USING public\.boats AS boat\s+WHERE boat\.id = member\.boat_id\s+AND boat\.owner_id = target_owner_id\s+AND member\.user_id = target_crew_id\s+AND member\.role = 'crew';/,
        );
    });

    it('keeps the 20260516150000 byline body and the 20260728150000 hardening', () => {
        expect(bridge).toContain('SELECT * INTO parts FROM public.user_name_parts(target_crew_id);');
        expect(bridge).toContain('EXCEPTION WHEN unique_violation THEN');
        expect(bridge).toContain('IF suffix > 99 THEN');
        expect(bridge).toContain('SET search_path = pg_catalog, public, pg_temp');
        expect(sql).toContain(
            'REVOKE ALL ON FUNCTION public.sync_vessel_crew_to_boat_members() FROM PUBLIC, anon, authenticated;',
        );
        // The trigger binding is left where 20260516130000 put it.
        expect(sql).not.toMatch(/CREATE TRIGGER|DROP TRIGGER/);
    });
});
