import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

describe('Founding Skippers submission boundary', () => {
    const migration = read('supabase/migrations/20260824110000_founding_skipper_applications.sql');
    const edge = read('supabase/functions/founding-skipper-application/index.ts');

    it('keeps application PII behind RLS and a service-role-only deduplicating RPC', () => {
        expect(migration).toContain('ALTER TABLE public.founding_skipper_applications ENABLE ROW LEVEL SECURITY');
        expect(migration).toContain(
            'REVOKE ALL ON TABLE public.founding_skipper_applications FROM PUBLIC, anon, authenticated',
        );
        expect(migration).toContain("IF auth.role() <> 'service_role'");
        expect(migration).toContain('SET search_path = pg_catalog, public');
        expect(migration).toContain('ON CONFLICT (email) DO NOTHING');
        expect(migration).toContain("INTERVAL '180 days'");
        expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE).*\sTO\s+(?:anon|authenticated)/i);
    });

    it('bounds the credentialless request before the service role is used and never logs applicant fields', () => {
        expect(edge).toContain("requireAuthenticatedOrPublicQuota(req, 'founding_skipper_apply', 10, 5, 3600, true)");
        expect(edge.indexOf('requireAuthenticatedOrPublicQuota')).toBeLessThan(
            edge.indexOf("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')"),
        );
        expect(edge).toContain('readJsonObject(req, 8_192)');
        expect(edge).toContain("if (req.method !== 'POST')");
        expect(edge).toContain('return respond(req, { ok: true }, 202)');
        expect(edge).not.toMatch(
            /console\.(?:log|warn|error)\([^\n]*(?:application\.name|application\.email|application\.notes)/,
        );
    });
});
