import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260911073000_guardian_sender_receipt.sql', 'utf8');
const previousBroadcast = readFileSync('supabase/migrations/20260804192000_guardian_broadcast_contract.sql', 'utf8');

function functionDefinition(name: string): string {
    const match = migration.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$\\$;`));
    if (!match) throw new Error(`Missing migration function: ${name}`);
    return match[0];
}

const receipt = functionDefinition('broadcast_guardian_alert_with_receipt');
const legacy = functionDefinition('broadcast_guardian_alert');
const feed = functionDefinition('guardian_alerts_nearby');

describe('Guardian server-confirmed sender receipt migration', () => {
    it('keeps all existing validation, identity, armed-presence and quota checks in the receipt RPC', () => {
        const checks = (sql: string) =>
            sql.slice(sql.indexOf('    IF sender_user_id IS NULL'), sql.indexOf('    INSERT INTO'));
        expect(checks(receipt)).toBe(checks(previousBroadcast));
        expect(receipt).toMatch(/RETURNS JSONB[\s\S]*SECURITY DEFINER[\s\S]*search_path = pg_catalog, public/i);
    });

    it('preserves the existing bounded fan-out without a sender push or count inflation', () => {
        const fanOut = (sql: string) =>
            sql.slice(sql.indexOf('    notification_type :='), sql.indexOf('    END LOOP;') + 13);
        expect(fanOut(receipt)).toBe(fanOut(previousBroadcast));
        expect(receipt).toContain('WHERE profile.user_id <> sender_user_id');
        expect(receipt.match(/INSERT INTO public\.push_notification_queue/g)).toHaveLength(1);
        expect(receipt).toContain('notify_count INTEGER := 0;');
    });

    it('returns the real inserted row including server ID, timestamp, vessel name and rounded coordinates', () => {
        expect(receipt).toMatch(/RETURNING id INTO alert_id/);
        expect(receipt).toMatch(/'id', ga\.id[\s\S]*'source_vessel_name', ga\.source_vessel_name/);
        expect(receipt).toContain("'created_at', ga.created_at");
        expect(receipt).toContain('round(ST_Y(ga.location::geometry)::numeric, 3)::double precision');
        expect(receipt).toContain('round(ST_X(ga.location::geometry)::numeric, 3)::double precision');
        expect(receipt).toMatch(/INTO saved_alert[\s\S]*WHERE ga\.id = alert_id/);
        expect(receipt).toContain("RETURN jsonb_build_object('notified', notify_count, 'alert', saved_alert)");
    });

    it('derives the sender marker from authenticated identity and strips coordinate metadata', () => {
        for (const sql of [receipt, feed]) {
            expect(sql).toContain("- 'exact_location' - 'lat' - 'lon' - 'latitude' - 'longitude' - 'sent_by_you'");
            expect(sql).toContain(
                "|| jsonb_build_object('sent_by_you', COALESCE(ga.source_user_id = auth.uid(), false))",
            );
        }
    });

    it('retains the INTEGER legacy signature and delegates exactly once without a second insert or quota charge', () => {
        expect(legacy).toMatch(/RETURNS INTEGER/);
        expect(legacy).toMatch(/sender_user_id UUID,[\s\S]*alert_data JSONB DEFAULT '\{\}'::jsonb/);
        expect(legacy.match(/public\.broadcast_guardian_alert_with_receipt\(/g)).toHaveLength(1);
        expect(legacy).toContain("->> 'notified')::integer");
        expect(legacy).not.toMatch(/INSERT INTO|consume_edge_quota/);
    });

    it('keeps own recent history independent of presence while tightly bounding target alerts', () => {
        expect(feed).toContain("consume_edge_quota('guardian_alerts', 180, 3600)");
        expect(feed).toContain("RAISE EXCEPTION 'Authentication required'");
        expect(feed).toMatch(/WHERE gp\.user_id = auth\.uid\(\)[\s\S]*gp\.armed IS TRUE[\s\S]*interval '5 minutes'/);
        expect(feed).toMatch(/make_interval\(hours => LEAST\(GREATEST\(guardian_alerts_nearby\.max_hours, 1\), 24\)\)/);
        expect(feed).toMatch(
            /AND \(\s*ga\.source_user_id = auth\.uid\(\)\s*OR \(\s*ga\.target_user_id = auth\.uid\(\)/,
        );
        expect(feed).toMatch(
            /ga\.target_user_id = auth\.uid\(\)\s*AND caller_lat IS NOT NULL\s*AND caller_lon IS NOT NULL\s*AND ga\.location IS NOT NULL\s*AND ST_DWithin/,
        );
        expect(feed).toContain('LEAST(GREATEST(guardian_alerts_nearby.radius_nm, 0.1), 10) * 1852');
        // guardian_alerts also has a radius_nm column; an unqualified argument
        // here throws SQLSTATE 42702 instead of returning any feed rows.
        expect(feed).not.toMatch(/GREATEST\(radius_nm,/);
        expect(feed).not.toContain("RAISE EXCEPTION 'Arm Guardian with a recent position before checking alerts'");
        expect(feed).toContain('LIMIT 50;');
    });

    it('preserves the existing feed response columns and accepts no arbitrary query coordinates', () => {
        expect(feed).toMatch(
            /guardian_alerts_nearby\(\s*radius_nm DOUBLE PRECISION DEFAULT 10,\s*max_hours INTEGER DEFAULT 24\s*\)/,
        );
        expect(feed).toMatch(
            /RETURNS TABLE \(\s*id UUID,\s*alert_type TEXT,\s*source_vessel_name TEXT,\s*title TEXT,\s*body TEXT,\s*lat DOUBLE PRECISION,\s*lon DOUBLE PRECISION,\s*data JSONB,\s*created_at TIMESTAMPTZ\s*\)/,
        );
    });

    it('keeps both broadcast RPCs authenticated/service-only and does not widen table access', () => {
        for (const name of ['broadcast_guardian_alert', 'broadcast_guardian_alert_with_receipt']) {
            expect(migration).toMatch(
                new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?FROM PUBLIC, anon;`),
            );
            expect(migration).toMatch(
                new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([\\s\\S]*?TO authenticated, service_role;`),
            );
        }
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.guardian_alerts_nearby(DOUBLE PRECISION, INTEGER) FROM PUBLIC, anon;',
        );
        expect(migration).not.toMatch(/CREATE POLICY|ALTER TABLE|GRANT SELECT|TO PUBLIC|TO anon/);
    });
});
