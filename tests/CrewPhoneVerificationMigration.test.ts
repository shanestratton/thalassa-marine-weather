import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260828120000_crew_phone_verification.sql', 'utf8');

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

describe('Crew List phone-verification migration', () => {
    it('stores no raw number or OTP and exposes neither private table to app roles', () => {
        const attempts = table('crew_phone_verification_attempts');
        const identities = table('crew_phone_identities');
        const keyConfig = table('crew_phone_hmac_config');
        expect(attempts).toContain('phone_hmac TEXT NOT NULL');
        expect(attempts).toContain('phone_last4 TEXT NOT NULL');
        expect(attempts).toMatch(/status NOT IN \('pending', 'approved'\) OR twilio_verification_sid IS NOT NULL/i);
        expect(attempts).not.toMatch(/\b(?:phone_number|phone_e164|raw_phone|otp|verification_code)\b/i);
        expect(identities).not.toMatch(/\b(?:phone_number|phone_e164|raw_phone|otp|verification_code)\b/i);
        expect(keyConfig).toMatch(/singleton BOOLEAN PRIMARY KEY[\s\S]*?hmac_version[\s\S]*?key_tag TEXT NOT NULL/i);
        expect(keyConfig).not.toMatch(/\b(?:secret|raw_key|hmac_key)\b/i);
        expect(migration).toMatch(/ALTER TABLE public\.crew_phone_verification_attempts ENABLE ROW LEVEL SECURITY/i);
        expect(migration).toMatch(/ALTER TABLE public\.crew_phone_identities ENABLE ROW LEVEL SECURITY/i);
        expect(migration).toMatch(/ALTER TABLE public\.crew_phone_hmac_config ENABLE ROW LEVEL SECURITY/i);
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.crew_phone_verification_attempts FROM PUBLIC, anon, authenticated/i,
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.crew_phone_identities FROM PUBLIC, anon, authenticated/i,
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.crew_phone_hmac_config FROM PUBLIC, anon, authenticated/i,
        );
    });

    it('pins each HMAC version to one server secret and fails closed on accidental replacement', () => {
        const keyGuard = sqlFunction('assert_crew_phone_hmac_key');
        expect(keyGuard).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'/i);
        expect(keyGuard).toMatch(/pg_advisory_xact_lock\(hashtextextended\('crew-phone-hmac-config'/i);
        expect(keyGuard).toMatch(
            /current_config\.hmac_version = p_hmac_version[\s\S]*?current_config\.key_tag = p_key_tag/i,
        );
        expect(keyGuard).toMatch(
            /EXISTS \(SELECT 1 FROM public\.crew_phone_identities\)[\s\S]*?EXISTS \(SELECT 1 FROM public\.crew_phone_verification_attempts\)[\s\S]*?RETURN false/i,
        );
        expect(keyGuard).toMatch(
            /public\.edge_public_rate_limits quota[\s\S]*?quota\.bucket LIKE 'crew_phone_number_%'[\s\S]*?RETURN false/i,
        );
        expect(keyGuard).toMatch(
            /UPDATE public\.crew_phone_hmac_config[\s\S]*?hmac_version = p_hmac_version[\s\S]*?key_tag = p_key_tag/i,
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.assert_crew_phone_hmac_key\(SMALLINT, TEXT\)[\s\S]*?FROM PUBLIC, anon, authenticated/i,
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.assert_crew_phone_hmac_key\(SMALLINT, TEXT\)[\s\S]*?TO service_role/i,
        );
    });

    it('enforces one active identity per user and phone with account-deletion write fences', () => {
        expect(migration).toMatch(
            /CREATE UNIQUE INDEX crew_phone_identities_one_current_per_user_idx[\s\S]*?ON public\.crew_phone_identities \(user_id\)/i,
        );
        expect(migration).toMatch(
            /CREATE UNIQUE INDEX crew_phone_identities_one_current_per_phone_idx[\s\S]*?\(hmac_version, phone_hmac\)/i,
        );
        expect(migration).toMatch(
            /CREATE TRIGGER account_deletion_write_fence[\s\S]*?ON public\.crew_phone_verification_attempts[\s\S]*?block_tombstoned_account_write\('user_id'\)/i,
        );
        expect(migration).toMatch(
            /CREATE TRIGGER account_deletion_write_fence[\s\S]*?ON public\.crew_phone_identities[\s\S]*?block_tombstoned_account_write\('user_id'\)/i,
        );
        expect(migration).toMatch(
            /CREATE TRIGGER account_deletion_write_fence[\s\S]*?ON public\.crew_list_contact_fences[\s\S]*?block_tombstoned_account_write\('user_id'\)/i,
        );
        const quotaSweep = sqlFunction('sweep_crew_phone_public_quotas');
        expect(quotaSweep).toMatch(/left\(quota\.bucket, 11\) = 'crew_phone_'/i);
        expect(quotaSweep).toMatch(/date_trunc\('day',[\s\S]*?AT TIME ZONE 'UTC'/i);
        expect(quotaSweep).toMatch(/LIMIT p_limit[\s\S]*?FOR UPDATE SKIP LOCKED/i);
        expect(migration).toMatch(/IF EXISTS \(SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'\)/i);
        expect(migration).toMatch(/'sweep-crew-phone-public-quotas',[\s\S]*?'17 \* \* \* \*'/i);
        expect(migration).not.toMatch(/(?:BEFORE DELETE ON auth\.users|AFTER DELETE ON public\.crew_phone_)/i);
    });

    it('keeps owner status narrow and every mutation RPC server scoped', () => {
        const status = sqlFunction('get_current_crew_phone_status');
        const revoke = sqlFunction('revoke_current_crew_phone_identity');
        const complete = sqlFunction('complete_crew_phone_verification');
        expect(status).toMatch(/auth\.role\(\) IS DISTINCT FROM 'authenticated'/i);
        expect(status).toMatch(/'last4'/i);
        expect(status).not.toMatch(/phone_hmac|provider_verification_sid/i);
        expect(revoke).toMatch(/DELETE FROM public\.crew_phone_verification_attempts WHERE user_id = caller_id/i);
        expect(revoke).toMatch(/DELETE FROM public\.crew_phone_identities WHERE user_id = caller_id/i);
        expect(revoke).not.toMatch(/DELETE FROM public\.edge_public_rate_limits/i);
        expect(complete).toMatch(/DELETE FROM public\.crew_phone_identities WHERE user_id = p_user_id/i);
        expect(complete).not.toMatch(/revoked_at|revocation_reason/i);
        for (const name of [
            'assert_crew_phone_hmac_key',
            'reserve_crew_phone_verification_attempt',
            'activate_crew_phone_verification_attempt',
            'fail_crew_phone_verification_attempt',
            'claim_crew_phone_verification_check',
            'complete_crew_phone_verification',
        ]) {
            expect(sqlFunction(name)).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'/i);
        }
        expect(sqlFunction('fail_crew_phone_verification_attempt')).toMatch(/status IN \('initiating', 'pending'\)/i);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.complete_crew_phone_verification\([\s\S]*?FROM PUBLIC, anon, authenticated/i,
        );
        const cleanup = sqlFunction('cleanup_crew_phone_verification_attempts');
        expect(cleanup).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'/i);
        expect(cleanup).toMatch(/RETURN public\.sweep_crew_phone_verification_attempts\(p_limit\)/i);
        const scheduledCleanup = sqlFunction('sweep_crew_phone_verification_attempts');
        expect(scheduledCleanup).toMatch(/interval '24 hours'/i);
        expect(scheduledCleanup).toMatch(/LIMIT p_limit[\s\S]*?FOR UPDATE SKIP LOCKED/i);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.sweep_crew_phone_verification_attempts\(INTEGER\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/i,
        );
        expect(migration).toMatch(
            /'sweep-crew-phone-verification-attempts',[\s\S]*?'23 \* \* \* \*'[\s\S]*?sweep_crew_phone_verification_attempts\(1000\)/i,
        );
    });

    it('allows drafts but gates review submission and moderator approval on email plus phone', () => {
        const eligibility = sqlFunction('crew_list_account_is_verified');
        const publicationGate = sqlFunction('guard_crew_phone_publication');
        const submit = sqlFunction('submit_crew_profile_for_review');
        const review = sqlFunction('review_crew_profile');
        expect(eligibility).toMatch(/auth\.users[\s\S]*?email_confirmed_at IS NOT NULL/i);
        expect(eligibility).toMatch(/public\.crew_phone_identities[\s\S]*?identity_row\.user_id = p_user_id/i);
        expect(publicationGate).toMatch(/NEW\.approval_status = 'pending'/i);
        expect(publicationGate).toMatch(/NEW\.crew_list_visibility = 'visible'/i);
        expect(submit).toMatch(/public\.crew_list_account_is_verified\(caller_id\)/i);
        expect(submit).toMatch(/approval_status IN \('draft', 'rejected'\)/i);
        expect(review).toMatch(/p_decision = 'approved'[\s\S]*?crew_list_account_is_verified\(p_profile_user_id\)/i);
    });

    it('gates new discovery and public photos while preserving accepted conversations', () => {
        const discoverable = sqlFunction('crew_list_profile_is_discoverable');
        const directRead = sqlFunction('can_select_crew_list_profile');
        const browse = sqlFunction('browse_crew_list_profiles');
        const photos = sqlFunction('can_view_crew_list_photo');
        expect(discoverable).toMatch(/public\.crew_list_account_is_verified\(p_user_id\)/i);
        expect(directRead).toMatch(/public\.crew_list_profile_is_discoverable\(p_user_id\)/i);
        expect(migration).toMatch(
            /CREATE POLICY "crew_profiles_owner_or_approved_visible"[\s\S]*?USING \(public\.can_select_crew_list_profile\(user_id\)\)/i,
        );
        expect(browse).toMatch(/public\.crew_list_account_is_verified\(profile\.user_id\)/i);
        expect(photos).toMatch(/public\.crew_list_account_is_verified\(profile\.user_id\)/i);
        expect(browse).toMatch(/request\.status = 'accepted'/i);
        expect(photos).toMatch(/request\.status = 'accepted'/i);
        expect(migration).not.toMatch(/DELETE FROM public\.crew_intro_(?:requests|conversations|messages)/i);
    });

    it('keeps former Crew List accounts fenced from generic first contact and reportable after consent', () => {
        const fences = table('crew_list_contact_fences');
        const genericDm = sqlFunction('can_send_generic_dm_to_recipient');
        const report = sqlFunction('can_report_crew_list_user');
        expect(fences).toMatch(/user_id UUID PRIMARY KEY REFERENCES auth\.users\(id\) ON DELETE CASCADE/i);
        expect(migration).toMatch(/ALTER TABLE public\.crew_list_contact_fences ENABLE ROW LEVEL SECURITY/i);
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.crew_list_contact_fences FROM PUBLIC, anon, authenticated/i,
        );
        expect(migration).toMatch(
            /INSERT INTO public\.crew_list_contact_fences\(user_id\)[\s\S]*?FROM public\.sailor_crew_profiles profile/i,
        );
        expect(migration).toMatch(
            /CREATE TRIGGER sailor_crew_profiles_remember_contact_fence[\s\S]*?AFTER INSERT ON public\.sailor_crew_profiles/i,
        );
        expect(genericDm).toMatch(
            /NOT EXISTS \([\s\S]*?FROM public\.crew_list_contact_fences fence[\s\S]*?fence\.user_id = p_recipient_id/i,
        );
        expect(genericDm).not.toMatch(/NOT public\.crew_list_profile_is_discoverable/i);
        expect(genericDm).toMatch(/public\.crew_intro_requests request[\s\S]*?request\.status = 'accepted'/i);
        expect(genericDm).toMatch(/public\.chat_direct_messages dm/i);
        expect(report).toMatch(
            /crew_list_profile_is_discoverable\(auth\.uid\(\)\)[\s\S]*?AND public\.crew_list_profile_is_discoverable\(p_reported_id\)/i,
        );
        expect(report).toMatch(/public\.crew_intro_requests request[\s\S]*?request\.status = 'accepted'/i);
    });

    it('fails existing public listings closed without discarding manual approval or profile drafts', () => {
        expect(migration).toMatch(
            /UPDATE public\.sailor_crew_profiles[\s\S]*?SET crew_list_visibility = 'private'[\s\S]*?WHERE crew_list_visibility = 'visible'/i,
        );
        const rollout = migration.match(
            /ALTER TABLE public\.sailor_crew_profiles DISABLE TRIGGER sailor_crew_profiles_beta_guard;[\s\S]*?ENABLE TRIGGER sailor_crew_profiles_beta_guard;/i,
        )?.[0];
        expect(rollout).toBeTruthy();
        expect(rollout).not.toMatch(/approval_status\s*=/i);
        expect(rollout).not.toMatch(/verification_status\s*=/i);
    });
});
