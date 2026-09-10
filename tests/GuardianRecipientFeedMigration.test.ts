import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260911080000_guardian_recipient_feed.sql', 'utf8');
const previous = readFileSync('supabase/migrations/20260911073000_guardian_sender_receipt.sql', 'utf8');

function definition(sql: string, name: string): string {
    const match = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$\\$;`));
    if (!match) throw new Error(`Missing migration function: ${name}`);
    return match[0];
}

const receipt = definition(migration, 'broadcast_guardian_alert_with_receipt');
const feed = definition(migration, 'guardian_alerts_nearby');

describe('Guardian durable recipient feed migration', () => {
    it('uses a server-owned, RLS-protected join table with deduplication and cascading deletion', () => {
        expect(migration).toMatch(/alert_id UUID NOT NULL REFERENCES public\.guardian_alerts\(id\) ON DELETE CASCADE/);
        expect(migration).toMatch(/recipient_user_id UUID NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
        expect(migration).toContain('PRIMARY KEY (alert_id, recipient_user_id)');
        expect(migration).toContain('ALTER TABLE public.guardian_alert_recipients ENABLE ROW LEVEL SECURITY;');
        expect(migration).toContain(
            'REVOKE ALL ON TABLE public.guardian_alert_recipients FROM PUBLIC, anon, authenticated;',
        );
        expect(migration).toContain(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guardian_alert_recipients TO service_role;',
        );
        expect(migration).not.toMatch(/CREATE POLICY|GRANT SELECT[^;]*TO authenticated/);
    });

    it('adds audience grants inside the existing atomic selected-recipient loop and changes nothing else in broadcast', () => {
        const grantBlock = receipt.match(
            / {8}-- The exact server-selected audience[\s\S]*? {8}ON CONFLICT DO NOTHING;\n\n/,
        )?.[0];
        expect(grantBlock).toBeDefined();
        expect(receipt.replace(grantBlock!, '')).toBe(definition(previous, 'broadcast_guardian_alert_with_receipt'));
        expect(receipt).toMatch(
            /LIMIT 50\s*LOOP[\s\S]*INSERT INTO public\.guardian_alert_recipients\(alert_id, recipient_user_id\)\s*VALUES \(alert_id, recipient\.user_id\)\s*ON CONFLICT DO NOTHING;[\s\S]*INSERT INTO public\.push_notification_queue/,
        );
        expect(receipt).toContain('WHERE profile.user_id <> sender_user_id');
        expect(receipt.match(/notify_count := notify_count \+ 1/g)).toHaveLength(1);
        expect(receipt).not.toMatch(/EXCEPTION WHEN|COMMIT|ROLLBACK/);
    });

    it('does not treat historical push metadata or self-queued alerts as recipient authority', () => {
        const outsideFunctions = migration.replace(receipt, '').replace(feed, '');
        expect(outsideFunctions).toContain('Deliberately NO historical queue backfill');
        expect(outsideFunctions).not.toMatch(/INSERT INTO public\.guardian_alert_recipients/);
        expect(migration).not.toMatch(/FROM public\.push_notification_queue|JOIN public\.push_notification_queue/);
        expect(feed).not.toContain('push_notification_queue');
    });

    it('requires an exact server-granted alert and authenticated recipient, not merely proximity', () => {
        expect(feed).toMatch(
            /ga\.target_user_id IS NULL\s*AND EXISTS \(\s*SELECT 1\s*FROM public\.guardian_alert_recipients AS receipt\s*WHERE receipt\.alert_id = ga\.id\s*AND receipt\.recipient_user_id = auth\.uid\(\)/,
        );
        expect(feed).toMatch(/ga\.source_user_id = auth\.uid\(\)\s*OR \(\s*\(\s*ga\.target_user_id = auth\.uid\(\)/);
        expect(feed).toContain("RAISE EXCEPTION 'Authentication required'");
        expect(feed).toContain("consume_edge_quota('guardian_alerts', 180, 3600)");
    });

    it('retains owner history and all fresh armed position, bounded radius and time constraints', () => {
        const grantAlternative =
            /\(\n {18}ga\.target_user_id = auth\.uid\(\)\n {18}OR \([\s\S]*?\n {14}\)\n {14}AND caller_lat/;
        expect(feed.replace(grantAlternative, 'ga.target_user_id = auth.uid()\n              AND caller_lat')).toBe(
            definition(previous, 'guardian_alerts_nearby'),
        );
        expect(feed).toMatch(/gp\.armed IS TRUE\s*AND gp\.last_known_at > now\(\) - interval '5 minutes'/);
        expect(feed).toMatch(
            /AND caller_lat IS NOT NULL\s*AND caller_lon IS NOT NULL\s*AND ga\.location IS NOT NULL\s*AND ST_DWithin/,
        );
        expect(feed).toContain('LEAST(GREATEST(guardian_alerts_nearby.radius_nm, 0.1), 10) * 1852');
        expect(feed).toContain('LEAST(GREATEST(guardian_alerts_nearby.max_hours, 1), 24)');
        expect(feed).not.toMatch(/GREATEST\(radius_nm,/);
        expect(feed).toContain('LIMIT 50;');
    });

    it('returns only the existing redacted feed shape with an identity-derived sender marker', () => {
        expect(feed).toContain('round(ST_Y(ga.location::geometry)::numeric, 3)::double precision');
        expect(feed).toContain('round(ST_X(ga.location::geometry)::numeric, 3)::double precision');
        expect(feed).toContain("- 'exact_location' - 'lat' - 'lon' - 'latitude' - 'longitude' - 'sent_by_you'");
        expect(feed).toContain("|| jsonb_build_object('sent_by_you', COALESCE(ga.source_user_id = auth.uid(), false))");
        expect(migration).not.toMatch(
            /ALTER TABLE public\.guardian_alerts\b|ON public\.guardian_alerts FOR|GRANT SELECT ON (?:TABLE )?public\.guardian_alerts/,
        );
    });

    it('keeps authenticated RPC grants and leaves the compatible legacy delegate intact', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.broadcast_guardian_alert_with_receipt\([\s\S]*?FROM PUBLIC, anon;/,
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.broadcast_guardian_alert_with_receipt\([\s\S]*?TO authenticated, service_role;/,
        );
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.guardian_alerts_nearby(DOUBLE PRECISION, INTEGER) FROM PUBLIC, anon;',
        );
        expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.broadcast_guardian_alert\(/);
        expect(definition(previous, 'broadcast_guardian_alert')).toContain(
            'RETURN (public.broadcast_guardian_alert_with_receipt(',
        );
    });
});
