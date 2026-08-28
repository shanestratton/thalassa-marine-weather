import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260828150000_crew_automatic_publication.sql', 'utf8');

function sqlFunction(name: string): string {
    const match = migration.match(
        new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, 'i'),
    );
    expect(match, `Expected ${name} function`).toBeTruthy();
    return match?.[0] ?? '';
}

function table(name: string): string {
    const match = migration.match(new RegExp(`CREATE TABLE public\\.${name} \\([\\s\\S]*?\\n\\);`, 'i'));
    expect(match, `Expected ${name} table`).toBeTruthy();
    return match?.[0] ?? '';
}

describe('Crew List automatic-publication migration', () => {
    it('keeps risk state and publication audit private, forced through RLS, and free of copied content', () => {
        const holds = table('crew_profile_review_holds');
        const attempts = table('crew_profile_publication_attempts');
        const decisions = table('crew_profile_publication_decisions');
        const attestations = table('crew_profile_publication_attestations');

        expect(holds).toMatch(/reason_code TEXT NOT NULL/);
        expect(attempts).toMatch(/profile_digest TEXT NOT NULL[\s\S]*?photo_manifest_digest TEXT NOT NULL/);
        expect(decisions).toMatch(/decision_channel TEXT NOT NULL[\s\S]*?decision TEXT NOT NULL/);
        expect(attestations).toMatch(/profile_digest TEXT NOT NULL[\s\S]*?photo_manifest_digest TEXT NOT NULL/);
        expect(`${attempts}\n${decisions}\n${attestations}`).not.toMatch(
            /\b(?:profile_text|bio|first_name|phone|image_bytes|provider_payload|provider_response)\b/i,
        );

        for (const tableName of [
            'crew_profile_review_holds',
            'crew_profile_publication_attempts',
            'crew_profile_publication_decisions',
            'crew_profile_publication_attestations',
        ]) {
            expect(migration).toMatch(new RegExp(`ALTER TABLE public\\.${tableName} FORCE ROW LEVEL SECURITY`, 'i'));
            expect(migration).toMatch(
                new RegExp(`REVOKE ALL ON TABLE public\\.${tableName} FROM PUBLIC, anon, authenticated`, 'i'),
            );
            expect(migration).toMatch(
                new RegExp(
                    `CREATE TRIGGER account_deletion_write_fence[\\s\\S]*?ON public\\.${tableName}[\\s\\S]*?block_tombstoned_account_write\\('user_id'\\)`,
                    'i',
                ),
            );
        }
        expect(migration).toMatch(
            /GRANT SELECT, INSERT ON TABLE public\.crew_profile_publication_decisions TO service_role/i,
        );
        expect(migration).not.toMatch(
            /GRANT (?:UPDATE|DELETE)[^;]*crew_profile_publication_decisions TO service_role/i,
        );
    });

    it('binds moderation to every canonical public field and exact immutable storage objects', () => {
        const profileDigest = sqlFunction('crew_list_public_profile_digest');
        const photoDigest = sqlFunction('crew_list_photo_manifest_digest');

        for (const field of [
            'listing_type',
            'first_name',
            'partner_details',
            'skills',
            'sailing_experience',
            'sailing_region',
            'bio',
            'vibe',
            'languages',
            'interests',
            'location_state',
            'location_country',
            'crew_photo_path',
            'crew_photo_paths',
            'crew_intents',
        ]) {
            expect(profileDigest).toContain(`'${field}'`);
        }
        expect(profileDigest).not.toContain("'location_city'");
        expect(photoDigest).toMatch(/primary_path IS DISTINCT FROM first_path/i);
        expect(photoDigest).toMatch(/distinct_count <> expected_count/i);
        expect(photoDigest).toMatch(/stored_object\.bucket_id = 'crew-list-photos'/i);
        for (const field of ['object_id', 'updated_at', 'etag', 'size', 'mime_type']) {
            expect(photoDigest).toContain(`'${field}'`);
        }
        expect(photoDigest).toMatch(/object_count <> expected_count/);
    });

    it('lets only the service role begin and finalize a snapshot-bound automatic check', () => {
        const begin = sqlFunction('begin_crew_profile_publication');
        const finalize = sqlFunction('finalize_crew_profile_publication');

        for (const fn of [begin, finalize]) {
            expect(fn).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'/i);
            expect(fn).toMatch(/pg_advisory_xact_lock/i);
        }
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.begin_crew_profile_publication\(UUID, TEXT\)[\s\S]*?FROM PUBLIC, anon, authenticated/i,
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.finalize_crew_profile_publication\(UUID, UUID, TEXT, TEXT\)[\s\S]*?FROM PUBLIC, anon, authenticated/i,
        );
        expect(begin).toMatch(/crew_list_account_is_verified\(p_user_id\)/i);
        expect(begin).toMatch(/crew_list_account_is_in_good_standing\(p_user_id\)/i);
        expect(begin).toMatch(/listing_type = 'seeking_crew'[\s\S]*?ARRAY\['find_crew'\]/i);
        expect(begin).toMatch(/listing_type = 'seeking_berth'[\s\S]*?ARRAY\['find_skipper'\]/i);
        expect(begin.indexOf('profile_hash :=')).toBeLessThan(begin.indexOf("SET approval_status = 'pending'"));
        expect(begin).toMatch(/status = 'stale', reason_code = 'superseded'/i);
        expect(begin).toMatch(/attempt\.expires_at > statement_timestamp\(\) \+ interval '60 seconds'/i);
        expect(begin).toMatch(/reason_code = 'worker_abandoned'/i);
        expect(begin).toMatch(/RETURN jsonb_build_object\('status', 'checking', 'attempt_id', attempt_id\)/i);

        expect(finalize).toMatch(/p_verdict NOT IN \('approved', 'manual_review'\)/i);
        expect(finalize).toMatch(/attempt_row\.expires_at <= statement_timestamp\(\)/i);
        expect(finalize).toMatch(/current_profile_digest IS DISTINCT FROM attempt_row\.profile_digest/i);
        expect(finalize).toMatch(/current_photo_digest IS DISTINCT FROM attempt_row\.photo_manifest_digest/i);
        expect(finalize).toMatch(/crew_list_profile_requires_manual_review\(p_user_id\)/i);
        expect(finalize).toMatch(/publication_source = 'automatic'/i);
        expect(finalize).toMatch(/crew_profile_publication_attestations/i);
        expect(finalize).toMatch(/decision_channel, decision, reason_code/i);
        expect(finalize).toMatch(/reason_code = 'verification_changed'/i);
        expect(finalize).toMatch(/THEN 'safety_signal'/i);
        expect(finalize.indexOf('SELECT * INTO profile_row')).toBeLessThan(
            finalize.indexOf('SELECT * INTO attempt_row'),
        );
    });

    it('performs the historical source backfill without invoking owner fences or legacy intent validation', () => {
        const disableOwner = migration.indexOf(
            'ALTER TABLE public.sailor_crew_profiles DISABLE TRIGGER sailor_crew_profiles_beta_guard',
        );
        const backfill = migration.indexOf("SET publication_source = 'manual'");
        const enableOwner = migration.indexOf(
            'ALTER TABLE public.sailor_crew_profiles ENABLE TRIGGER sailor_crew_profiles_beta_guard',
        );
        const intentConstraint = migration.indexOf('ADD CONSTRAINT sailor_crew_profiles_review_intent_shape');

        expect(disableOwner).toBeGreaterThanOrEqual(0);
        expect(disableOwner).toBeLessThan(backfill);
        expect(backfill).toBeLessThan(enableOwner);
        expect(enableOwner).toBeLessThan(intentConstraint);
        expect(migration).toMatch(
            /DISABLE TRIGGER account_deletion_write_fence[\s\S]*?SET publication_source = 'manual'[\s\S]*?ENABLE TRIGGER account_deletion_write_fence/i,
        );
    });

    it('never lets an automatic uncertainty reject or expose a profile', () => {
        const finalize = sqlFunction('finalize_crew_profile_publication');
        const compatibilitySubmit = sqlFunction('submit_crew_profile_for_review');

        expect(finalize).not.toMatch(/p_verdict[^\n]*rejected/i);
        expect(finalize).toMatch(
            /INSERT INTO public\.crew_profile_review_holds[\s\S]*?approval_status = 'pending'[\s\S]*?crew_list_visibility = 'private'/i,
        );
        expect(compatibilitySubmit).toMatch(/crew_list_visibility = 'private'/i);
        expect(compatibilitySubmit).not.toMatch(/crew_list_visibility = 'visible'/i);
        expect(compatibilitySubmit).not.toMatch(/publication_source = 'automatic'/i);
    });

    it('makes owner photo objects immutable and keeps referenced objects undeletable', () => {
        const canDelete = sqlFunction('can_delete_crew_list_photo');

        expect(migration).toMatch(/DROP POLICY IF EXISTS "Crew List photo owner update" ON storage\.objects/i);
        expect(migration).not.toMatch(/CREATE POLICY "Crew List photo owner update"/i);
        expect(canDelete).toMatch(/split_part\(p_object_name, '\/', 1\) = auth\.uid\(\)::TEXT/i);
        expect(canDelete).toMatch(/profile\.crew_photo_path = p_object_name/i);
        expect(canDelete).toMatch(/p_object_name = ANY\(profile\.crew_photo_paths\)/i);
        expect(migration).toMatch(
            /CREATE POLICY "Crew List photo owner delete"[\s\S]*?public\.can_delete_crew_list_photo\(name\)/i,
        );
    });

    it('closes direct profile reads and exposes only the narrow discoverable projection', () => {
        const discoverable = sqlFunction('crew_list_profile_is_discoverable');
        const browse = sqlFunction('browse_crew_list_profiles');
        const photos = sqlFunction('can_view_crew_list_photo');

        expect(migration).toMatch(
            /CREATE POLICY "crew_profiles_owner_or_approved_visible"[\s\S]*?USING \(user_id = auth\.uid\(\) OR public\.is_chat_admin\(auth\.uid\(\)\)\)/i,
        );
        expect(discoverable).toMatch(/crew_list_account_is_verified\(p_user_id\)/i);
        expect(discoverable).toMatch(/crew_list_account_is_in_good_standing\(p_user_id\)/i);
        expect(discoverable).toMatch(/crew_list_photo_manifest_digest\(profile\.user_id\) IS NOT NULL/i);
        expect(discoverable).toMatch(/publication_source = 'automatic'[\s\S]*?has_current_automatic_attestation/i);
        expect(discoverable).toMatch(/listing_type = 'seeking_crew'[\s\S]*?ARRAY\['find_crew'\]/i);
        expect(discoverable).toMatch(/listing_type = 'seeking_berth'[\s\S]*?ARRAY\['find_skipper'\]/i);
        expect(browse).not.toMatch(/location_city/i);
        expect(browse).not.toMatch(/review_requested_at|reviewed_at|reviewed_by/i);
        expect(browse).toMatch(/request\.status = 'accepted'/i);
        expect(photos).toMatch(/request\.status = 'accepted'/i);
    });

    it('preserves sanctions and durable report/manual-review safeguards around automatic publication', () => {
        const standing = sqlFunction('crew_list_account_is_in_good_standing');
        const manual = sqlFunction('crew_list_profile_requires_manual_review');
        const report = sqlFunction('review_crew_list_report');
        const intros = sqlFunction('can_send_crew_intro');
        const messages = sqlFunction('can_send_crew_intro_message');

        expect(standing).toMatch(/is_blocked/i);
        expect(standing).toMatch(/muted_until > statement_timestamp\(\)/i);
        expect(manual).toMatch(/crew_profile_review_holds/i);
        expect(manual).toMatch(/crew_list_reports[\s\S]*?status = 'pending'/i);
        expect(report).toMatch(/reason_code[\s\S]*?'substantiated_report'/i);
        expect(report).toMatch(/cleared_at = statement_timestamp\(\)[\s\S]*?reason_code = 'pending_report'/i);
        expect(report).toMatch(/crew_list_visibility = 'private'/i);
        expect(intros).toMatch(/interval '7 days'/i);
        expect(intros).toMatch(/\) < 5[\s\S]*?\) < 3/i);
        expect(messages).toMatch(/crew_list_account_is_in_good_standing\(auth\.uid\(\)\)/i);
        expect(migration).toMatch(
            /CREATE TRIGGER crew_list_reports_insert_guard[\s\S]*?guard_crew_list_report_insert\(\)/i,
        );
        expect(report.indexOf('pg_advisory_xact_lock')).toBeLessThan(report.indexOf('FOR UPDATE'));
    });

    it('serializes introductions, rejects legacy batches, and exposes a one-request RPC', () => {
        const insertGuard = sqlFunction('guard_crew_intro_request_insert');
        const batchGuard = sqlFunction('guard_crew_intro_request_batch');
        const createIntro = sqlFunction('create_crew_intro_request');

        expect(insertGuard).toMatch(/pg_advisory_xact_lock/i);
        expect(insertGuard).toMatch(/public\.can_send_crew_intro\(NEW\.recipient_id\)/i);
        expect(batchGuard).toMatch(/auth\.role\(\) = 'authenticated'/i);
        expect(batchGuard).toMatch(/count\(\*\) FROM inserted_requests\) > 1/i);
        expect(migration).toMatch(
            /CREATE TRIGGER crew_intro_requests_batch_guard[\s\S]*?REFERENCING NEW TABLE AS inserted_requests[\s\S]*?FOR EACH STATEMENT/i,
        );
        expect(createIntro).toMatch(/pg_advisory_xact_lock/i);
        expect(createIntro).toMatch(/INSERT INTO public\.crew_intro_requests\(sender_id, recipient_id, message\)/i);
        expect(createIntro).not.toMatch(/jsonb_array|unnest|jsonb_to_recordset/i);
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.create_crew_intro_request\(UUID, TEXT\) TO authenticated/i,
        );
    });

    it('recovers expired workers and still deletes their bounded snapshot records', () => {
        const sweep = sqlFunction('sweep_crew_profile_publication_attempts');

        expect(sweep).toMatch(/attempt\.status = 'checking'[\s\S]*?attempt\.expires_at <= statement_timestamp\(\)/i);
        expect(sweep).toMatch(/pg_advisory_xact_lock/i);
        expect(sweep.indexOf('FROM public.sailor_crew_profiles profile')).toBeLessThan(
            sweep.indexOf('FROM public.crew_profile_publication_attempts attempt\n         WHERE attempt.id'),
        );
        expect(sweep).toMatch(/account_deletion_jobs/i);
        expect(sweep).toMatch(/SET approval_status = 'draft'/i);
        expect(sweep).toMatch(/reason_code = 'worker_abandoned'/i);
        expect(sweep).toMatch(/attempt\.created_at < statement_timestamp\(\) - interval '24 hours'/i);
        expect(sweep).toMatch(/DELETE FROM public\.crew_profile_publication_attempts/i);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.sweep_crew_profile_publication_attempts\(INTEGER\)[\s\S]*?service_role/i,
        );
    });
});
