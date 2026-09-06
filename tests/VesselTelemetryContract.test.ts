/**
 * The boat's live snapshot in the cloud — who may read it, who may write it.
 *
 * Shane 2026-09-06: the Pi is the primary device, and crew see the panel
 * anywhere without a VPN. The table is the seam; these pins keep it honest.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const migration = read('supabase/migrations/20260906170000_vessel_telemetry.sql');
const fn = read('supabase/functions/telemetry-relay/index.ts');
const auth = read('supabase/functions/_shared/pi-relay-auth.ts');

describe('vessel_telemetry', () => {
    it('is one row per skipper, RLS on, no anon, authenticated may only read', () => {
        expect(migration).toContain('owner_id        UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE');
        expect(migration).toContain('ALTER TABLE public.vessel_telemetry ENABLE ROW LEVEL SECURITY;');
        expect(migration).toContain('REVOKE ALL ON TABLE public.vessel_telemetry FROM PUBLIC, anon, authenticated;');
        expect(migration).toContain('GRANT SELECT ON TABLE public.vessel_telemetry TO authenticated;');
        expect(migration).not.toMatch(/GRANT (INSERT|UPDATE|ALL)/);
    });

    it('the skipper reads their own row; boat members and accepted vessel crew read the boat’s', () => {
        expect(migration).toContain('USING (owner_id = auth.uid());');
        expect(migration).toContain('FROM public.boat_members AS member');
        expect(migration).toContain('member.boat_id = vessel_telemetry.boat_id');
        expect(migration).toContain('FROM public.vessel_crew AS membership');
        expect(migration).toContain("membership.status = 'accepted'");
    });

    it('the relay function is the only writer, and it writes as the Pi’s paired skipper', () => {
        expect(fn).toContain('authenticatePiRelay(admin, readRelayCredential(req, body))');
        expect(fn).toContain("from('user_active_vessels')");
        expect(fn).toContain("from('vessel_telemetry').upsert(");
        expect(fn).toContain("{ onConflict: 'owner_id' }");
        expect(fn).not.toContain('requireAuthenticatedQuota'); // the Pi has no user JWT
        expect(auth).toContain("from('pi_diary_relays')");
        expect(auth).toContain('secureEqual(await sha256Hex(credential.token), row.token_hash)');
    });

    it('every field is bounded before it is stored', () => {
        const parse = read('supabase/functions/telemetry-relay/parse.ts');
        expect(parse).toContain('sog_kts: [0, 100]');
        expect(parse).toContain('twa_deg: [-180, 180]');
        expect(parse).toContain('export const MAX_REPORT_AGE_MS = 15 * 60_000;');
        expect(fn).toContain('parseTelemetryBody(body)');
    });
});
