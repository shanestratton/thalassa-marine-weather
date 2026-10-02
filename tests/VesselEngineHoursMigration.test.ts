/**
 * vessel_engine_hours (2026-10-02): one engine-hours reading per skipper,
 * shared through the R&M register exactly as maintenance_tasks is.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261002190000_vessel_engine_hours.sql', 'utf8');
const squash = (text: string) => text.replace(/\s+/g, ' ');
const body = squash(sql.replace(/--[^\n]*\n/g, '\n'));

describe('vessel_engine_hours migration', () => {
    it('holds one non-negative reading per owner, removed with the account', () => {
        expect(body).toContain('CREATE TABLE IF NOT EXISTS public.vessel_engine_hours (');
        expect(body).toContain('id UUID PRIMARY KEY');
        expect(body).toContain('user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE');
        expect(body).toContain('hours INTEGER NOT NULL CHECK (hours >= 0)');
        expect(body).toContain('updated_at TIMESTAMPTZ NOT NULL DEFAULT now()');
    });

    it('ties the row id to its owner, so no account can take a skipper’s id or add a second row for him', () => {
        // The same derivation as engineHoursRowId (LocalEngineHoursService):
        // the first 16 bytes of SHA-256, laid out as an RFC 9562 version 8 UUID.
        expect(body).toMatch(
            /CREATE OR REPLACE FUNCTION public\.vessel_engine_hours_row_id\(p_owner UUID\) RETURNS UUID LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS \$\$/,
        );
        expect(body).toContain(
            "substring(extensions.digest('thalassa:vessel_engine_hours:v1:' || p_owner::text, 'sha256') FROM 1 FOR 16)",
        );
        expect(body).toContain(
            "encode( set_byte(set_byte(b, 6, (get_byte(b, 6) & 15) | 128), 8, (get_byte(b, 8) & 63) | 128), 'hex' )::uuid",
        );
        expect(body).not.toMatch(/vessel_engine_hours_row_id[^;]*SECURITY DEFINER/);
        expect(body).toContain('REVOKE ALL ON FUNCTION public.vessel_engine_hours_row_id(UUID) FROM PUBLIC, anon;');
        expect(body).toContain(
            'GRANT EXECUTE ON FUNCTION public.vessel_engine_hours_row_id(UUID) TO authenticated, service_role;',
        );
        // Defined before the table that checks against it.
        expect(body.indexOf('FUNCTION public.vessel_engine_hours_row_id')).toBeLessThan(
            body.indexOf('CREATE TABLE IF NOT EXISTS public.vessel_engine_hours'),
        );
        expect(body).toContain(
            'CONSTRAINT vessel_engine_hours_id_is_owners CHECK (id = public.vessel_engine_hours_row_id(user_id))',
        );
    });

    it('mirrors the maintenance_tasks policies: register read, register write, owner-only delete', () => {
        expect(body).toContain('ALTER TABLE public.vessel_engine_hours ENABLE ROW LEVEL SECURITY');
        expect(body).toContain('REVOKE ALL ON TABLE public.vessel_engine_hours FROM PUBLIC, anon, authenticated');
        expect(body).toMatch(
            /FOR SELECT TO authenticated USING \(public\.can_access_vessel_register\(user_id, 'maintenance', false\)\)/,
        );
        expect(body).toMatch(
            /FOR INSERT TO authenticated WITH CHECK \(public\.can_access_vessel_register\(user_id, 'maintenance', true\)\)/,
        );
        expect(body).toMatch(
            /FOR UPDATE TO authenticated USING \(public\.can_access_vessel_register\(user_id, 'maintenance', true\)\) WITH CHECK \(public\.can_access_vessel_register\(user_id, 'maintenance', true\)\)/,
        );
        expect(body).toMatch(/FOR DELETE TO authenticated USING \(user_id = auth\.uid\(\)\)/);
        expect(body).not.toMatch(/TO anon|TO PUBLIC/i);
    });

    it('stamps updates like the binder tables, keeps the owner fixed, and fences deleted accounts', () => {
        expect(body).toContain(
            'BEFORE UPDATE ON public.vessel_engine_hours FOR EACH ROW EXECUTE FUNCTION public.update_maintenance_tasks_updated_at()',
        );
        expect(body).toContain('IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id THEN');
        expect(body).toMatch(
            /guard_vessel_engine_hours_owner\(\) RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public/,
        );
        expect(body).not.toMatch(/SECURITY DEFINER/);
        expect(body).toContain(
            "BEFORE INSERT OR UPDATE ON public.vessel_engine_hours FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id')",
        );
        // A crew write is stamped with the skipper's id by the app; nothing re-owns it.
        expect(body).not.toContain('crew_rewrite_user_id');
    });

    it('joins supabase_realtime only when it is not already there', () => {
        expect(body).toMatch(/IF EXISTS \(SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'\)/);
        expect(body).toMatch(
            /AND NOT EXISTS \( SELECT 1 FROM pg_publication_tables[^)]*tablename = 'vessel_engine_hours' \)/,
        );
        expect(body).toContain('ALTER PUBLICATION supabase_realtime ADD TABLE public.vessel_engine_hours;');
    });
});
