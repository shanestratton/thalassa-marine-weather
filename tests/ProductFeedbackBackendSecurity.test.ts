import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

describe('Product feedback backend security contract', () => {
    const migration = read('supabase/migrations/20260828190000_product_feedback.sql');
    const edge = read('supabase/functions/feedback-submission/index.ts');
    const validation = read('supabase/functions/feedback-submission/validation.ts');
    const worker = read('supabase/functions/feedback-email-worker/worker.ts');
    const email = read('supabase/functions/feedback-email-worker/email.ts');
    const config = read('supabase/config.toml');

    it('keeps contact details and free text behind forced RLS and a service-only transaction', () => {
        expect(migration).toContain('ALTER TABLE public.product_feedback_submissions ENABLE ROW LEVEL SECURITY');
        expect(migration).toContain('ALTER TABLE public.product_feedback_submissions FORCE ROW LEVEL SECURITY');
        expect(migration).toContain(
            'REVOKE ALL ON TABLE public.product_feedback_submissions FROM PUBLIC, anon, authenticated',
        );
        expect(migration).toContain("IF auth.role() IS DISTINCT FROM 'service_role'");
        expect(migration).toContain('SET search_path = pg_catalog, public');
        expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE).*\sTO\s+(?:anon|authenticated)/i);
        expect(migration).toContain("INTERVAL '364 days'");
        expect(migration).toContain('public.sweep_expired_product_feedback()');
        expect(migration).toMatch(
            /app_build TEXT CHECK \([\s\S]*?char_length\(app_build\) BETWEEN 1 AND 40[\s\S]*?app_build !~ '\[\[:cntrl:\]\]'/,
        );
        expect(migration).toMatch(
            /app_platform TEXT CHECK \([\s\S]*?char_length\(app_platform\) BETWEEN 1 AND 40[\s\S]*?app_platform !~ '\[\[:cntrl:\]\]'/,
        );
    });

    it('makes concurrent client retries exact and queues each email intent only once', () => {
        const submit = migration.slice(
            migration.indexOf('CREATE OR REPLACE FUNCTION public.submit_product_feedback'),
            migration.indexOf('COMMENT ON FUNCTION public.submit_product_feedback'),
        );
        expect(submit).toContain('ON CONFLICT (client_submission_id) DO NOTHING');
        expect(submit.indexOf('ON CONFLICT (client_submission_id) DO NOTHING')).toBeLessThan(
            submit.indexOf('FOR UPDATE'),
        );
        expect(submit).toContain('stored.diagnostics IS DISTINCT FROM p_diagnostics');
        expect(submit).toContain('stored.app_version IS DISTINCT FROM p_app_version');
        expect(submit).toContain('stored.app_build IS DISTINCT FROM p_app_build');
        expect(submit).toContain('stored.app_platform IS DISTINCT FROM p_app_platform');
        expect(submit).toContain('Client submission UUID was reused with different content');
        expect(submit).toContain("(stored.id, 'operator_new_v1')");
        expect(submit).toContain("(stored.id, 'submitter_received_v1')");
        expect(migration).toContain('UNIQUE (submission_id, message_kind)');
    });

    it('bounds anonymous intake before loading the service role and silently discards its honeypot', () => {
        expect(edge).toContain("requireAuthenticatedOrPublicQuota(req, 'product_feedback_submit', 20, 5, 3_600, true)");
        expect(edge.indexOf('requireAuthenticatedOrPublicQuota')).toBeLessThan(
            edge.indexOf("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')"),
        );
        expect(edge).toContain('readJsonObject(req, 65_536)');
        expect(edge).toContain("'https://www.thalassawx.com'");
        expect(edge).toContain("'https://www.thalassawx.app'");
        expect(edge).toContain("reference: 'FB-RECEIVED'");
        expect(validation).toContain("export const FEEDBACK_CONSENT_VERSION = 'product-feedback-v1'");
        expect(validation).toContain('Object.keys(input).length !== 7');
        expect(validation).toContain('!CURRENT_PATH.test(currentPath)');
        expect(validation).toContain("'appBuild'");
        expect(validation).toContain("'appPlatform'");
        expect(edge).not.toMatch(
            /console\.(?:log|warn|error)\([^\n]*(?:feedback\.(?:name|email|details)|serviceRoleKey|workerKey)/,
        );
    });

    it('uses a PII-minimal leased outbox with bounded non-PII failures and stable provider idempotency', () => {
        const outbox = migration.slice(
            migration.indexOf('CREATE TABLE public.product_feedback_email_outbox'),
            migration.indexOf('COMMENT ON TABLE public.product_feedback_email_outbox'),
        );
        expect(outbox).not.toMatch(/^\s*(?:name|email|title|details|diagnostics)\s+/m);
        expect(migration).toContain('ALTER TABLE public.product_feedback_email_outbox FORCE ROW LEVEL SECURITY');
        expect(migration).toContain('FOR UPDATE OF outbox SKIP LOCKED');
        expect(migration).toContain("public.invoke_edge_function(''feedback-email-worker'', 30000)");
        expect(worker).toContain("const WORKER_KEY_HEADER = 'x-thalassa-worker-key'");
        expect(worker).toContain("payload.role === 'service_role'");
        expect(email).toContain("readEnvironment('RESEND_API_KEY')");
        expect(email).toContain("readEnvironment('FOUNDING_SKIPPER_ALERT_TO')");
        expect(email).toContain("readEnvironment('FOUNDING_SKIPPER_ALERT_FROM')");
        expect(email).toContain("readEnvironment('FOUNDING_SKIPPER_APPLICANT_FROM')");
        expect(email).toContain("readEnvironment('FOUNDING_SKIPPER_REPLY_TO')");
        expect(email).toContain("'Idempotency-Key': `product-feedback/${job.submissionId}/${job.messageKind}/v1`");
        expect(email).toContain("['Version', job.appVersion || 'Not supplied']");
        expect(email).toContain("['Build', job.appBuild || 'Not supplied']");
        expect(email).toContain("['Platform', job.appPlatform || 'Not supplied']");
        expect(email).not.toMatch(/VITE_(?:RESEND|FOUNDING_SKIPPER)/);
    });

    it('pins only the public intake open while keeping the worker gateway-verified', () => {
        expect(config).toMatch(/\[functions\.feedback-submission\][\s\S]*?verify_jwt = false/);
        expect(config).toMatch(/\[functions\.feedback-email-worker\][\s\S]*?verify_jwt = true/);
    });
});
