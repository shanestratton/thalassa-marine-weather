import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260804192000_guardian_broadcast_contract.sql', 'utf8');

describe('Guardian broadcast RPC compatibility migration', () => {
    it('retires both legacy overloads and exposes the app argument names', () => {
        expect(migration.match(/DROP FUNCTION IF EXISTS public\.broadcast_guardian_alert/gi)).toHaveLength(2);
        expect(migration).toMatch(
            /CREATE FUNCTION public\.broadcast_guardian_alert\(\s*sender_user_id UUID,\s*p_alert_type TEXT,\s*lat DOUBLE PRECISION,\s*lon DOUBLE PRECISION,\s*radius_nm DOUBLE PRECISION[\s\S]*alert_data JSONB/i,
        );
        expect(migration).not.toMatch(/CREATE FUNCTION[\s\S]*p_lat DOUBLE PRECISION/i);
    });

    it('requires an armed, recent, identity-matched caller and rate limits reports', () => {
        expect(migration).toMatch(/sender_user_id <> auth\.uid\(\)/i);
        expect(migration).toMatch(/profile\.armed IS TRUE[\s\S]*interval '5 minutes'/i);
        expect(migration).toContain("consume_edge_quota('guardian_broadcast', 3, 3600)");
    });

    it('notifies only armed recent recipients without copying exact coordinates into push data', () => {
        expect(migration).toMatch(
            /FOR recipient IN[\s\S]*profile\.armed IS TRUE[\s\S]*interval '5 minutes'[\s\S]*LIMIT 50/i,
        );
        expect(migration).toMatch(/jsonb_build_object\('alert_id', alert_id, 'alert_type', p_alert_type\)/i);
        expect(migration).not.toMatch(/jsonb_build_object\([\s\S]{0,120}'lat'/i);
    });

    it('keeps the RPC unavailable to anonymous callers', () => {
        expect(migration).toMatch(/FROM PUBLIC, anon/i);
        expect(migration).toMatch(/TO authenticated, service_role/i);
    });
});
