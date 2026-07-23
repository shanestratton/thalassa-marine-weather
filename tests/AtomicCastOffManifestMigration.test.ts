import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260723104400_atomic_cast_off_manifest.sql', 'utf8');
const voyageService = readFileSync('services/VoyageService.ts', 'utf8');
const castOffFunction = migration.match(/CREATE OR REPLACE FUNCTION public\.cast_off_voyage[\s\S]+?\n\$\$;/i)?.[0];

describe('atomic Cast Off manifest migration', () => {
    it('enforces one active voyage per owner at the database boundary', () => {
        expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS manifest_locked_at TIMESTAMPTZ/i);
        expect(migration).toMatch(
            /CREATE UNIQUE INDEX IF NOT EXISTS uq_voyages_one_active_per_owner[\s\S]+ON public\.voyages\(user_id\)[\s\S]+WHERE status = 'active'/i,
        );
        expect(migration).toMatch(/row_number\(\) OVER \([\s\S]+PARTITION BY user_id[\s\S]+active_rank > 1/i);
        expect(castOffFunction).toMatch(/pg_advisory_xact_lock/i);
        expect(migration).toMatch(/CHECK \(status <> 'active' OR manifest_locked_at IS NOT NULL\)/i);
    });

    it('stores one immutable owner-or-crew snapshot row per voyage member', () => {
        expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.voyage_manifest/i);
        expect(migration).toMatch(/PRIMARY KEY \(voyage_id, member_user_id\)/i);
        expect(migration).toMatch(/ALTER TABLE public\.voyage_manifest ENABLE ROW LEVEL SECURITY/i);
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.voyage_manifest[\s\S]+FROM PUBLIC, anon, authenticated/i,
        );
        expect(migration).toMatch(/CREATE POLICY "Manifest members read snapshot"[\s\S]+FOR SELECT TO authenticated/i);
        expect(migration).not.toMatch(/voyage_manifest FOR (?:INSERT|UPDATE|DELETE)/i);
    });

    it('rejects direct activation and makes the manifest lock write-once', () => {
        expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.guard_voyage_manifest_transition/i);
        expect(migration).toMatch(/OLD\.manifest_locked_at IS NOT NULL/i);
        expect(migration).toMatch(
            /manifest\.member_user_id = NEW\.user_id[\s\S]+manifest\.snapshot_at = NEW\.manifest_locked_at/i,
        );
        expect(migration).toMatch(/Use cast_off_voyage to activate a voyage/i);
        expect(migration).toMatch(/BEFORE UPDATE OF status, manifest_locked_at ON public\.voyages/i);
    });

    it('snapshots the owner and deduplicates accepted global/scoped crew', () => {
        expect(castOffFunction).toBeTruthy();
        expect(castOffFunction).toMatch(/'skipper'[\s\S]+'owner'/i);
        expect(castOffFunction).toMatch(/membership\.status = 'accepted'/i);
        expect(castOffFunction).toMatch(
            /membership\.voyage_id IS NULL[\s\S]+membership\.voyage_id = voyage_row\.id::text/i,
        );
        expect(castOffFunction).toMatch(
            /row_number\(\) OVER \([\s\S]+PARTITION BY membership\.crew_user_id[\s\S]+membership\.voyage_id = voyage_row\.id::text\) DESC/i,
        );
        expect(castOffFunction).toMatch(/WHERE applicable\.membership_rank = 1/i);
        expect(castOffFunction).not.toMatch(/UPDATE public\.vessel_crew/i);
    });

    it('is owner-only, authenticated-only, atomic, and idempotent after response loss', () => {
        expect(castOffFunction).toMatch(/caller_id UUID := auth\.uid\(\)/i);
        expect(castOffFunction).toMatch(/voyage_owner <> caller_id/i);
        expect(castOffFunction).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public/i);
        expect(castOffFunction).toMatch(
            /voyage_row\.status = 'active'[\s\S]+manifest_locked_at IS NOT NULL[\s\S]+RETURN to_jsonb\(voyage_row\)/i,
        );
        expect(castOffFunction?.match(/ON CONFLICT \(voyage_id, member_user_id\) DO NOTHING/gi)).toHaveLength(2);
        expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.cast_off_voyage\(UUID\)[\s\S]+FROM PUBLIC, anon/i);
        expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.cast_off_voyage\(UUID\)[\s\S]+TO authenticated/i);
    });

    it('removes the invalid crew status and unsupported local voyage-log writes', () => {
        expect(voyageService).toMatch(/\.rpc\('cast_off_voyage'/i);
        expect(voyageService).not.toMatch(/status:\s*['"]confirmed['"]/i);
        expect(voyageService).not.toMatch(/insertLocal\(\s*['"]voyage_log['"]/i);
        expect(voyageService).toMatch(/CastOffPanel \+ ShipLogService/i);
    });
});
