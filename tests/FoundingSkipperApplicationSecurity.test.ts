import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

describe('Founding Skippers submission boundary', () => {
    const migration = read('supabase/migrations/20260824110000_founding_skipper_applications.sql');
    const insertResultMigration = read(
        'supabase/migrations/20260825110000_founding_skipper_application_insert_result.sql',
    );
    const edge = read('supabase/functions/founding-skipper-application/index.ts');
    const alert = read('supabase/functions/founding-skipper-application/alert.ts');

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

    it('returns a service-role-only id for a genuinely new insert so duplicate submissions cannot alert', () => {
        expect(insertResultMigration).toContain('submit_founding_skipper_application_v2');
        expect(insertResultMigration).toContain('RETURNS UUID');
        expect(insertResultMigration).toContain("IF auth.role() <> 'service_role'");
        expect(insertResultMigration).toContain('ON CONFLICT (email) DO NOTHING');
        expect(insertResultMigration).toContain('RETURNING id INTO inserted_id');
        expect(insertResultMigration).toContain('RETURN inserted_id');
        expect(insertResultMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.submit_founding_skipper_application_v2\([\s\S]*FROM PUBLIC, anon, authenticated/,
        );
        expect(edge).toContain("admin.rpc('submit_founding_skipper_application_v2'");
        expect(edge).toContain("if (typeof insertedApplicationId === 'string')");
    });

    it('keeps Resend credentials server-side and makes alert failure non-blocking and non-PII', () => {
        expect(alert).toContain("const RESEND_EMAILS_ENDPOINT = 'https://api.resend.com/emails'");
        expect(alert).toContain("readEnvironment('RESEND_API_KEY')");
        expect(alert).toContain("readEnvironment('FOUNDING_SKIPPER_ALERT_FROM')");
        expect(alert).toContain("readEnvironment('FOUNDING_SKIPPER_ALERT_TO')");
        expect(alert).toContain("'Idempotency-Key': `founding-skipper-application/${application.id}`");
        expect(alert).toContain("'User-Agent': ALERT_USER_AGENT");
        expect(alert).toContain("{ status: 'skipped', reason: 'not_configured' }");
        expect(alert).not.toMatch(/VITE_(?:RESEND|FOUNDING_SKIPPER)/);
        expect(edge).toContain('runtime.waitUntil(task)');
        expect(edge.indexOf('runInBackground(alertTask)')).toBeLessThan(
            edge.lastIndexOf('return respond(req, { ok: true }, 202)'),
        );
        expect(edge).not.toMatch(
            /console\.(?:log|warn|error)\([^\n]*(?:application\.name|application\.email|application\.notes)/,
        );
    });
});
