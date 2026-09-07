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
const sharing = read('supabase/migrations/20260907140000_instrument_sharing.sql');
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

    it('2026-09-06: the skipper read their own row; boat members and all accepted crew read the boat’s (superseded below)', () => {
        expect(migration).toContain('USING (owner_id = auth.uid());');
        expect(migration).toContain('FROM public.boat_members AS member');
        expect(migration).toContain('member.boat_id = vessel_telemetry.boat_id');
        expect(migration).toContain('FROM public.vessel_crew AS membership');
        expect(migration).toContain("membership.status = 'accepted'");
    });

    it('2026-09-07: the panel is invite-only — crew read only with the skipper’s share, and boat_members no longer grants it', () => {
        expect(sharing).toContain('DROP POLICY IF EXISTS vessel_telemetry_crew_reads ON public.vessel_telemetry;');
        const policy = sharing.slice(sharing.indexOf('CREATE POLICY vessel_telemetry_crew_reads'));
        expect(policy).toContain("membership.status = 'accepted'");
        expect(policy).toContain("COALESCE((membership.permissions ->> 'can_view_instruments')::boolean, false)");
        expect(policy).not.toContain('boat_members');
        // The switch exists on every row, false unless ticked.
        expect(sharing).toContain('"can_view_instruments": false');
        expect(sharing).toContain(`SET permissions = permissions || '{"can_view_instruments": false}'::jsonb`);
        // The owner's own read is left where it was.
        expect(sharing).not.toMatch(/(DROP|CREATE) POLICY[^;]*vessel_telemetry_owner_reads/);
        // The app derives the same flag from the 'instruments' register.
        const crew = read('services/CrewService.ts');
        expect(crew).toContain("can_view_instruments: registers.includes('instruments')");
        expect(crew).toContain("instruments: 'Instrument Panel'");
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
