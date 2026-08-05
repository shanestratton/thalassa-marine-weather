import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    'supabase/migrations/20260805110000_enforce_traced_route_cast_off_verification.sql',
    'utf8',
);

describe('Route Tracer Cast Off database authority', () => {
    it('runs on the planning-to-active transition and leaves ordinary voyages alone', () => {
        expect(migration).toMatch(/OLD\.status = 'planning' AND NEW\.status = 'active'/i);
        expect(migration).toMatch(/NEW\.saved_route_id IS NULL[\s\S]+NOT LIKE prefix[\s\S]+RETURN NEW/i);
        expect(migration).toMatch(/BEFORE UPDATE OF status ON public\.voyages/i);
    });

    it('binds the proof to the exact owned live saved_routes geometry', () => {
        expect(migration).toMatch(/route\.id = NEW\.saved_route_id/i);
        expect(migration).toMatch(/route\.user_id = NEW\.user_id/i);
        expect(migration).toMatch(/route\.deleted = false/i);
        expect(migration).toMatch(/trace-geometry-v1\|/i);
        expect(migration).toMatch(/proof->>'geometryKey' IS DISTINCT FROM expected_geometry_key/i);
        expect(migration).toMatch(/jsonb_array_length\(grades\) <> jsonb_array_length\(route_points\) - 1/i);
    });

    it('rejects malformed, assumed-draft, stale and unacknowledged checks', () => {
        expect(migration).toMatch(/jsonb_typeof\(proof\) IS DISTINCT FROM 'object'/i);
        expect(migration).toMatch(/checked_at IS NULL OR proof_departure_ms IS NULL/i);
        expect(migration).toMatch(/graderVersion' IS DISTINCT FROM 'route-tracer-v1'/i);
        expect(migration).toMatch(/draftAssumed' IS DISTINCT FROM 'false'/i);
        expect(migration).toMatch(/jsonb_typeof\(grades\) IS DISTINCT FROM 'array'/i);
        expect(migration).toMatch(/Every no-go leg must be acknowledged/i);
        expect(migration).toMatch(/interval '48 hours'/i);
        expect(migration).toMatch(/interval '30 days'/i);
        expect(migration).toMatch(/outside the checked tide-departure window/i);
        expect(migration).toMatch(/proof_departure_ms[\s\S]+OLD\.departure_time/i);
        expect(migration).not.toMatch(/proof_departure_ms[\s\S]+NEW\.departure_time\) \* 1000/i);
    });
});
