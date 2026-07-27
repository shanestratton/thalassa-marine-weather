import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260727131000_crew_list_conversation_hardening.sql', 'utf8');

function sqlFunction(name: string): string {
    const match = migration.match(
        new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, 'i'),
    );
    expect(match, `Expected ${name} function`).toBeTruthy();
    return match?.[0] || '';
}

function policy(table: string, name: string): string {
    const match = migration.match(
        new RegExp(
            `CREATE POLICY\\s+"${name}"[\\s\\S]*?ON public\\.${table}[\\s\\S]*?(?=\\n(?:CREATE POLICY|DROP POLICY|GRANT |REVOKE |ALTER TABLE|-- ──|$))`,
            'i',
        ),
    );
    expect(match, `Expected ${name} policy`).toBeTruthy();
    return match?.[0] || '';
}

describe('Crew List conversation hardening migration', () => {
    it('cannot accept a stale pending introduction after either profile leaves the discoverable approved state', () => {
        const canAccept = sqlFunction('can_accept_crew_intro');
        const updateGuard = sqlFunction('guard_crew_intro_request_update');
        const pairBlock = sqlFunction('crew_list_pair_is_blocked');

        expect(canAccept).toMatch(/auth\.uid\(\) = p_recipient_id/i);
        expect(canAccept).toMatch(/public\.crew_list_profile_is_discoverable\(p_sender_id\)/i);
        expect(canAccept).toMatch(/public\.crew_list_profile_is_discoverable\(p_recipient_id\)/i);
        expect(canAccept).toMatch(/NOT public\.crew_list_pair_is_blocked\(p_sender_id, p_recipient_id\)/i);
        expect(pairBlock).toMatch(/FROM public\.dm_blocks block/i);
        expect(pairBlock).toMatch(/block\.blocker_id = p_left_user_id AND block\.blocked_id = p_right_user_id/i);
        expect(pairBlock).toMatch(/block\.blocker_id = p_right_user_id AND block\.blocked_id = p_left_user_id/i);

        expect(updateGuard).toMatch(/OLD\.status <> 'pending'/i);
        expect(updateGuard).toMatch(/auth\.uid\(\) = OLD\.recipient_id AND NEW\.status IN \('accepted', 'declined'\)/i);
        expect(updateGuard).toMatch(
            /NEW\.status = 'accepted'\s+AND NOT public\.can_accept_crew_intro\(OLD\.sender_id, OLD\.recipient_id\)/i,
        );
        expect(updateGuard).toMatch(/Both Crew List profiles must remain approved, active, and unblocked to accept/i);
    });

    it('creates a separate private conversation only for an accepted introduction and closes the generic-DM bypass', () => {
        expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.crew_intro_conversations/i);
        expect(migration).toMatch(/intro_request_id UUID NOT NULL UNIQUE REFERENCES public\.crew_intro_requests/i);
        expect(migration).toMatch(/crew_intro_conversations_canonical_pair/i);
        expect(migration).toMatch(/crew_intro_conversations_one_pair UNIQUE/i);

        const updateGuard = sqlFunction('guard_crew_intro_request_update');
        const reservation = sqlFunction('reserve_crew_intro_conversation');
        expect(updateGuard).toMatch(
            /PERFORM public\.reserve_crew_intro_conversation\(NEW\.id, OLD\.sender_id, OLD\.recipient_id\)/i,
        );
        expect(reservation).toMatch(/INSERT INTO public\.crew_intro_conversations/i);
        expect(reservation).toMatch(/ON CONFLICT \(participant_one_id, participant_two_id\) DO NOTHING/i);
        expect(reservation).toMatch(/IF conversation_id IS NULL THEN/i);
        expect(reservation).toMatch(/conversation already exists for these sailors/i);
        expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.create_crew_intro_conversation');
        expect(migration).not.toContain('CREATE TRIGGER crew_intro_requests_create_conversation');
        expect(migration).toMatch(/WHERE request\.status = 'accepted'/i);

        const genericDmGate = sqlFunction('can_send_generic_dm_to_recipient');
        const genericDmPolicy = policy('chat_direct_messages', 'Users can send unblocked DMs');
        expect(genericDmGate).toMatch(/NOT public\.crew_list_profile_is_discoverable\(p_recipient_id\)/i);
        expect(genericDmGate).toMatch(/FROM public\.crew_intro_requests request/i);
        expect(genericDmGate).toMatch(/request\.status = 'accepted'/i);
        expect(genericDmGate).toMatch(/FROM public\.chat_direct_messages dm/i);
        expect(genericDmGate).toMatch(/dm\.sender_id = auth\.uid\(\) AND dm\.recipient_id = p_recipient_id/i);
        expect(genericDmGate).toMatch(/dm\.sender_id = p_recipient_id AND dm\.recipient_id = auth\.uid\(\)/i);
        expect(genericDmPolicy).toMatch(/public\.can_send_generic_dm_to_recipient\(recipient_id\)/i);
    });

    it('server-gates Crew List message reads and writes to accepted, unblocked conversation participants', () => {
        const canSendMessage = sqlFunction('can_send_crew_intro_message');
        const readPolicy = policy('crew_intro_messages', 'crew_intro_messages_participants_read');
        const writePolicy = policy('crew_intro_messages', 'crew_intro_messages_accepted_insert');

        expect(canSendMessage).toMatch(/FROM public\.crew_intro_conversations conversation/i);
        expect(canSendMessage).toMatch(
            /conversation\.participant_one_id = auth\.uid\(\) OR conversation\.participant_two_id = auth\.uid\(\)/i,
        );
        expect(canSendMessage).toMatch(/FROM public\.crew_intro_requests request/i);
        expect(canSendMessage).toMatch(/request\.status = 'accepted'/i);
        expect(canSendMessage).toMatch(
            /NOT public\.crew_list_pair_is_blocked\(\s*conversation\.participant_one_id,\s*conversation\.participant_two_id\s*\)/i,
        );

        expect(readPolicy).toMatch(/FROM public\.crew_intro_conversations conversation/i);
        expect(readPolicy).toMatch(
            /conversation\.participant_one_id = auth\.uid\(\) OR conversation\.participant_two_id = auth\.uid\(\)/i,
        );
        expect(readPolicy).not.toMatch(/USING\s*\(\s*true\s*\)/i);
        expect(writePolicy).toMatch(/sender_id = auth\.uid\(\)/i);
        expect(writePolicy).toMatch(/public\.can_send_crew_intro_message\(conversation_id\)/i);
        expect(migration).toMatch(/GRANT SELECT, INSERT ON TABLE public\.crew_intro_messages TO authenticated/i);
        expect(migration).toMatch(/REVOKE ALL ON TABLE public\.crew_intro_messages FROM anon, authenticated/i);
    });

    it('retires pending introductions when a Crew List profile is deleted without revoking accepted conversations', () => {
        const retirement = sqlFunction('retire_pending_crew_intro_requests_on_profile_delete');

        expect(retirement).toMatch(/UPDATE public\.crew_intro_requests/i);
        expect(retirement).toMatch(/WHERE status = 'pending'/i);
        expect(retirement).toMatch(/sender_id = OLD\.user_id OR recipient_id = OLD\.user_id/i);
        expect(retirement).toMatch(/sender_id = OLD\.user_id THEN 'withdrawn' ELSE 'declined'/i);
        expect(migration).toMatch(/CREATE TRIGGER sailor_crew_profiles_retire_pending_intros/i);
    });

    it('extends the public-profile privacy backstop to partner detail and every displayed text array', () => {
        const scalarSafety = sqlFunction('crew_list_public_text_is_safe');
        const arraySafety = sqlFunction('crew_list_public_text_array_is_safe');
        const profileGuard = sqlFunction('guard_sailor_crew_profile_beta');

        expect(scalarSafety).toMatch(/@/i);
        expect(scalarSafety).toMatch(/https\?:\/\//i);
        expect(scalarSafety).toMatch(/p_reject_exact_coordinates/i);
        expect(arraySafety).toMatch(/FOREACH public_value IN ARRAY p_values/i);
        expect(arraySafety).toMatch(/public\.crew_list_public_text_is_safe\(/i);

        expect(profileGuard).toMatch(/NEW\.partner_details, 500, true/i);
        expect(profileGuard).toMatch(/NEW\.skills, 30, 80, false/i);
        expect(profileGuard).toMatch(/NEW\.vibe, 20, 80, false/i);
        expect(profileGuard).toMatch(/NEW\.languages, 20, 80, false/i);
        expect(profileGuard).toMatch(/NEW\.interests, 40, 80, false/i);
    });

    it('makes blocking bilateral for discovery and prevents an administrator from self-verifying', () => {
        const readPolicy = policy('sailor_crew_profiles', 'crew_profiles_owner_or_approved_visible');
        const profileGuard = sqlFunction('guard_sailor_crew_profile_beta');
        const review = sqlFunction('review_crew_profile');
        const discoverable = sqlFunction('crew_list_profile_is_discoverable');
        const browseProfiles = sqlFunction('browse_crew_list_profiles');

        expect(readPolicy).toMatch(/user_id = auth\.uid\(\)/i);
        expect(readPolicy).toMatch(/public\.is_chat_admin\(auth\.uid\(\)\)/i);
        expect(browseProfiles).toMatch(/NOT public\.crew_list_pair_is_blocked\(auth\.uid\(\), profile\.user_id\)/i);
        expect(profileGuard).toMatch(/NEW\.user_id IS DISTINCT FROM auth\.uid\(\)/i);
        expect(review).toMatch(/p_profile_user_id = auth\.uid\(\)/i);
        expect(discoverable).not.toMatch(/SELECT\s+1\s+SELECT\s+1/i);
    });

    it('returns a deliberately broad public-card shape with no town or review metadata', () => {
        const browseProfiles = sqlFunction('browse_crew_list_profiles');
        const returnShape = browseProfiles.slice(
            browseProfiles.indexOf('RETURNS TABLE'),
            browseProfiles.indexOf('LANGUAGE sql'),
        );

        expect(returnShape).toContain('location_state TEXT');
        expect(returnShape).toContain('location_country TEXT');
        expect(returnShape).not.toMatch(/\blocation_city\b/i);
        expect(returnShape).not.toMatch(/\b(?:reviewed_by|reviewed_at|review_requested_at)\b/i);
    });

    it('takes both pending and approved profiles back to private draft when a reviewed public field changes', () => {
        const profileGuard = sqlFunction('guard_sailor_crew_profile_beta');

        expect(profileGuard).toMatch(/OLD\.approval_status IN \('approved', 'pending'\)/i);
        expect(profileGuard).toMatch(/NEW\.approval_status := 'draft'/i);
        expect(profileGuard).toMatch(/NEW\.crew_list_visibility := 'private'/i);
    });

    it('uses private, owner-scoped Crew List photo objects and only grants eligible signed reads', () => {
        const profileGuard = sqlFunction('guard_sailor_crew_profile_beta');
        const photoPath = sqlFunction('crew_list_photo_path_is_valid');
        const photoView = sqlFunction('can_view_crew_list_photo');

        expect(migration).toMatch(/INSERT INTO storage\.buckets \(id, name, public/i);
        expect(migration).toMatch(/'crew-list-photos',\s*'crew-list-photos',\s*false/i);
        expect(photoPath).toMatch(/split_part\(p_path, '\/', 1\) = p_user_id::TEXT/i);
        expect(profileGuard).toMatch(/NEW\.photo_url IS NOT NULL/i);
        expect(profileGuard).toMatch(/public\.crew_list_photo_paths_are_valid\(NEW\.crew_photo_paths, NEW\.user_id\)/i);
        expect(profileGuard).toMatch(/NEW\.crew_photo_path = ANY\(NEW\.crew_photo_paths\)/i);
        expect(photoView).toMatch(/NOT public\.crew_list_pair_is_blocked\(auth\.uid\(\), profile\.user_id\)/i);
        expect(photoView).toMatch(/profile\.crew_photo_path = p_object_name/i);
        expect(migration).toMatch(/CREATE POLICY "Crew List photo eligible read"/i);
        expect(migration).toMatch(/public\.can_view_crew_list_photo\(name\)/i);
    });

    it('gives Crew List safety reports an admin-reviewed lifecycle rather than a permanent pair lock', () => {
        const canReport = sqlFunction('can_report_crew_list_user');
        const reviewReport = sqlFunction('review_crew_list_report');

        expect(migration).toMatch(/status TEXT NOT NULL DEFAULT 'pending'/i);
        expect(migration).toMatch(/reviewed_at TIMESTAMPTZ/i);
        expect(migration).toMatch(/reviewed_by UUID REFERENCES auth\.users/i);
        expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS crew_list_reports_one_open_report_per_pair_idx/i);
        expect(migration).toMatch(/WHERE status = 'pending'/i);
        expect(canReport).toMatch(/public\.crew_list_profile_is_discoverable\(auth\.uid\(\)\)/i);
        expect(canReport).toMatch(/request\.status = 'accepted'/i);
        expect(reviewReport).toMatch(/public\.is_chat_admin\(auth\.uid\(\)\)/i);
        expect(reviewReport).toMatch(/p_decision NOT IN \('resolved', 'dismissed'\)/i);
        expect(reviewReport).toMatch(/AND status = 'pending'/i);
    });
});
