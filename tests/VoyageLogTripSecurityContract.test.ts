import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'supabase/functions/voyage-log/index.ts'), 'utf8');
const migration = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20260727114500_public_voyage_log_trip_catalog.sql'),
    'utf8',
);

describe('public Voyage Log trip selector safety contract', () => {
    it('uses a compact, retention-scoped catalogue before fetching selected geometry', () => {
        expect(source).toContain("supabase.rpc('public_voyage_log_trip_catalog'");
        expect(source).toContain('p_since: trackSince');
        expect(source).toContain('fetchTrack({ voyageId: selectedTrackId })');
        expect(source).not.toContain('candidateVoyageIds');
    });

    it('fails closed for track data when hidden-voyage authority cannot be read', () => {
        expect(source).toContain('trackVisibilityReadable = false');
        expect(source).toContain('if (!trackVisibilityReadable) return { data: [], error: null };');
        expect(source).toContain("tripSelection.mode === 'legacy' && trackVisibilityReadable");
    });

    it('does not present an old selected track as current telemetry', () => {
        expect(source).toContain('const telemetryBelongsToView =');
        expect(source).toContain('(selectedTrackId !== null && selectedTrackId === currentVoyageId)');
        expect(source).toContain('latestCatalogueLiveTs <= liveNow + 60_000');
    });

    it('keeps the catalogue RPC service-role-only and inside public retention', () => {
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("auth.role() IS DISTINCT FROM 'service_role'");
        expect(migration).toContain('p_since TIMESTAMPTZ DEFAULT NULL');
        expect(migration).toContain('AND (p_since IS NULL OR logs.timestamp >= p_since)');
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.public_voyage_log_trip_catalog(UUID, TIMESTAMPTZ)\n    TO service_role;',
        );
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.public_voyage_log_trip_catalog(UUID, TIMESTAMPTZ)');
    });
});
