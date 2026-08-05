import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260804191000_guardian_presence_privacy.sql', 'utf8');

describe('Guardian public-beta presence privacy migration', () => {
    it('makes disarm remove discoverability and heartbeat require an armed profile', () => {
        expect(migration).toMatch(/guardian_disarm[\s\S]*last_known_lat\s*=\s*NULL[\s\S]*last_known_at\s*=\s*NULL/i);
        expect(migration).toMatch(/guardian_heartbeat[\s\S]*WHERE user_id = auth\.uid\(\)[\s\S]*armed IS TRUE/i);
        expect(migration).toContain("consume_edge_quota('guardian_heartbeat', 180, 3600)");
    });

    it('retires arbitrary-coordinate discovery and returns only minimal armed recent presence', () => {
        expect(migration).toMatch(/DROP FUNCTION public\.thalassa_users_nearby/i);
        expect(migration).toMatch(
            /nearby_guardians\(radius_nm[\s\S]*RETURNS TABLE \(\s*user_id UUID,\s*vessel_name TEXT,\s*distance_nm DOUBLE PRECISION,\s*last_known_at TIMESTAMPTZ/i,
        );
        expect(migration).toMatch(/nearby_guardians[\s\S]*gp\.armed IS TRUE[\s\S]*interval '5 minutes'/i);
        expect(migration).not.toMatch(/nearby_guardians\(query_lat/i);
        expect(migration).toContain("consume_edge_quota('guardian_nearby', 180, 3600)");
    });

    it('anchors the alert feed to the caller and limits rows to related alerts', () => {
        expect(migration).toMatch(/guardian_alerts_nearby\(\s*radius_nm/i);
        expect(migration).toMatch(/ga\.source_user_id = auth\.uid\(\) OR ga\.target_user_id = auth\.uid\(\)/i);
        expect(migration).not.toMatch(/guardian_alerts_nearby\(\s*query_lat/i);
    });

    it('keeps MMSI verification server-controlled when client columns are restricted', () => {
        expect(migration).toMatch(/guardian_reset_mmsi_verification[\s\S]*NEW\.mmsi_verified := false/i);
        expect(migration).toMatch(/BEFORE INSERT OR UPDATE ON public\.guardian_profiles/i);
        const clientGrantBlock = migration.match(
            /GRANT INSERT \([\s\S]*?ON public\.guardian_profiles TO authenticated;/i,
        )?.[0];
        expect(clientGrantBlock).toBeDefined();
        expect(clientGrantBlock).not.toContain('mmsi_verified');
    });

    it('rejects crafted location-based broadcasts from disarmed profiles', () => {
        expect(migration).toMatch(
            /guardian_require_armed_user_broadcast[\s\S]*NEW\.alert_type IN \('suspicious', 'weather_spike'\)[\s\S]*gp\.armed IS TRUE/i,
        );
        expect(migration).toMatch(/BEFORE INSERT ON public\.guardian_alerts/i);
    });
});
