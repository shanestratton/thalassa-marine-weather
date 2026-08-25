import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

describe('Founding Skippers submission boundary', () => {
    const migration = read('supabase/migrations/20260824110000_founding_skipper_applications.sql');
    const insertResultMigration = read(
        'supabase/migrations/20260825110000_founding_skipper_application_insert_result.sql',
    );
    const outboxMigration = read('supabase/migrations/20260826120000_founding_skipper_email_outbox.sql');
    const edge = read('supabase/functions/founding-skipper-application/index.ts');
    const workerIndex = read('supabase/functions/founding-skipper-email-worker/index.ts');
    const worker = read('supabase/functions/founding-skipper-email-worker/worker.ts');
    const email = read('supabase/functions/founding-skipper-email-worker/email.ts');

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

    it('atomically queues email only for a genuinely new, service-role-only application insert', () => {
        const v3Definition = outboxMigration.slice(
            outboxMigration.indexOf('CREATE OR REPLACE FUNCTION public.submit_founding_skipper_application_v3'),
            outboxMigration.indexOf('COMMENT ON FUNCTION public.submit_founding_skipper_application_v3'),
        );
        const v2Definition = outboxMigration.slice(
            outboxMigration.indexOf('CREATE OR REPLACE FUNCTION public.submit_founding_skipper_application_v2'),
            outboxMigration.indexOf('COMMENT ON FUNCTION public.submit_founding_skipper_application_v2'),
        );
        const reviewDefinition = outboxMigration.slice(
            outboxMigration.indexOf('CREATE OR REPLACE FUNCTION public.review_founding_skipper_application'),
            outboxMigration.indexOf('COMMENT ON FUNCTION public.review_founding_skipper_application'),
        );
        expect(insertResultMigration).toContain('submit_founding_skipper_application_v2');
        expect(outboxMigration).toContain('submit_founding_skipper_application_v3');
        expect(outboxMigration).toContain('RETURNS UUID');
        expect(outboxMigration).toContain("IF auth.role() IS DISTINCT FROM 'service_role'");
        expect(v3Definition).toContain('p_consent_version TEXT');
        expect(v3Definition).toContain("p_consent_version NOT IN ('founding-skippers-v1', 'founding-skippers-v2')");
        expect(outboxMigration).toContain('ON CONFLICT (email) DO NOTHING');
        expect(outboxMigration).toContain('RETURNING id INTO inserted_id');
        expect(outboxMigration).toContain('IF inserted_id IS NOT NULL THEN');
        expect(v3Definition).toContain("VALUES (inserted_id, 'operator_new_v1')");
        expect(v3Definition).toContain("IF p_consent_version = 'founding-skippers-v2' THEN");
        expect(v3Definition).toContain("VALUES (inserted_id, 'applicant_received_v1')");
        expect(v2Definition).not.toContain("'applicant_received_v1'");
        expect(v2Definition).toContain("'founding-skippers-v1'");
        expect(outboxMigration).toContain(
            "CHECK (consent_version IN ('founding-skippers-v1', 'founding-skippers-v2'))",
        );
        expect(outboxMigration).toContain('Compatibility delegate that passes v1 consent to the explicit v3 contract.');
        expect(reviewDefinition).toContain('RETURNING application.id, application.consent_version');
        expect(reviewDefinition).toContain("changed_consent_version = 'founding-skippers-v2'");
        expect(reviewDefinition).toContain("last_error_code = 'applicant_email_not_consented'");
        expect(outboxMigration).toContain('RETURN inserted_id');
        expect(outboxMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.submit_founding_skipper_application_v3\([\s\S]*FROM PUBLIC, anon, authenticated/,
        );
        expect(edge).toContain("admin.rpc('submit_founding_skipper_application_v3'");
        expect(edge).toContain("if (typeof insertedApplicationId === 'string')");
    });

    it('keeps delivery durable, service-only, idempotent, and free of duplicated PII', () => {
        const outboxDefinition = outboxMigration.slice(
            outboxMigration.indexOf('CREATE TABLE public.founding_skipper_email_outbox'),
            outboxMigration.indexOf('COMMENT ON TABLE public.founding_skipper_email_outbox'),
        );
        expect(outboxDefinition).toContain('UNIQUE (application_id, message_kind)');
        expect(outboxDefinition).not.toMatch(/^\s*(?:name|email|notes|home_waters)\s+/m);
        expect(outboxMigration).toContain('ALTER TABLE public.founding_skipper_email_outbox FORCE ROW LEVEL SECURITY');
        expect(outboxMigration).toContain(
            'REVOKE ALL ON TABLE public.founding_skipper_email_outbox FROM PUBLIC, anon, authenticated',
        );
        expect(outboxMigration).toContain('FOR UPDATE OF outbox SKIP LOCKED');
        expect(outboxMigration).toContain("'applicant_accepted_v1'");
        expect(outboxMigration).toContain("public.invoke_edge_function(''founding-skipper-email-worker'', 30000)");

        expect(worker).toContain('requireServiceRolePost(request, serviceRoleKey)');
        expect(worker).toContain("payload.role === 'service_role'");
        expect(worker).toContain('Never deploy this compatibility path with gateway');
        expect(worker).toContain("const WORKER_KEY_HEADER = 'x-thalassa-worker-key'");
        expect(worker).toContain('const WORKER_KEY_MAX_LENGTH = 1_024');
        expect(workerIndex).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
        expect(workerIndex.indexOf('if (!emailConfig)')).toBeLessThan(workerIndex.indexOf('queueGateway(admin)'));
        expect(email).toContain("const RESEND_EMAILS_ENDPOINT = 'https://api.resend.com/emails'");
        expect(email).toContain("readEnvironment('RESEND_API_KEY')");
        expect(email).toContain("readEnvironment('FOUNDING_SKIPPER_ALERT_FROM')");
        expect(email).toContain("readEnvironment('FOUNDING_SKIPPER_ALERT_TO')");
        expect(email).toContain("readEnvironment('FOUNDING_SKIPPER_APPLICANT_FROM')");
        expect(email).toContain("readEnvironment('FOUNDING_SKIPPER_REPLY_TO')");
        expect(email).toContain("'Idempotency-Key': `founding-skipper/${job.applicationId}/${job.messageKind}/v1`");
        expect(email).toContain("'User-Agent': EMAIL_USER_AGENT");
        expect(email).not.toMatch(/VITE_(?:RESEND|FOUNDING_SKIPPER)/);
        expect(edge).toContain('runtime.waitUntil(task)');
        expect(edge).toContain('/functions/v1/founding-skipper-email-worker');
        expect(edge).toContain("Deno.env.get('SUPABASE_ANON_KEY')");
        expect(edge).toContain('apikey: anonKey');
        expect(edge).toContain('Authorization: `Bearer ${anonKey}`');
        expect(edge).toContain("'X-Thalassa-Worker-Key': workerKey");
        expect(edge).not.toContain('Authorization: `Bearer ${serviceRoleKey}`');
        expect(edge.indexOf('runInBackground(wakeEmailWorker')).toBeLessThan(
            edge.lastIndexOf('return respond(req, { ok: true }, 202)'),
        );
        expect(edge).not.toMatch(
            /console\.(?:log|warn|error)\([^\n]*(?:application\.name|application\.email|application\.notes)/,
        );
        expect(workerIndex).not.toMatch(
            /console\.(?:log|warn|error)\([^\n]*(?:application\.name|application\.email|application\.notes)/,
        );
        expect(edge).not.toMatch(
            /console\.(?:log|warn|error)\([^\n]*(?:anonKey|serviceRoleKey|workerKey|X-Thalassa-Worker-Key)/,
        );
    });
});
