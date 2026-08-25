import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260825120000_founding_skipper_admin_inbox.sql', 'utf8');

function sqlFunction(name: string): string {
    const match = migration.match(
        new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, 'i'),
    );
    expect(match, `Expected ${name} function`).toBeTruthy();
    return match?.[0] || '';
}

describe('Founding Skipper admin inbox security boundary', () => {
    it('keeps PII and the single UUID reviewer slot inaccessible as browser tables', () => {
        expect(migration).toMatch(/CREATE TABLE public\.founding_skipper_reviewers/i);
        expect(migration).toMatch(/reviewer_slot SMALLINT PRIMARY KEY DEFAULT 1 CHECK \(reviewer_slot = 1\)/i);
        expect(migration).toMatch(/user_id UUID NOT NULL UNIQUE REFERENCES auth\.users\(id\) ON DELETE CASCADE/i);
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.founding_skipper_reviewers FROM PUBLIC, anon, authenticated/i,
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.founding_skipper_applications FROM PUBLIC, anon, authenticated/i,
        );
        expect(migration).not.toMatch(/is_chat_admin|platform_owner_email/i);
        expect(migration).not.toMatch(/auth\.users[\s\S]{0,80}\bemail\b/i);
    });

    it('answers capability from the authenticated caller UUID without a caller-supplied identity', () => {
        const capability = sqlFunction('can_review_founding_skipper_applications');
        expect(capability).toMatch(/can_review_founding_skipper_applications\(\)/i);
        expect(capability).toMatch(/auth\.role\(\) = 'authenticated'/i);
        expect(capability).toMatch(/reviewer\.user_id = auth\.uid\(\)/i);
        expect(capability).toMatch(/SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/i);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.can_review_founding_skipper_applications\(\) FROM PUBLIC, anon, authenticated/i,
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.can_review_founding_skipper_applications\(\) TO authenticated/i,
        );
    });

    it('server-authorizes and bounds the keyset inbox query to at most 50 rows', () => {
        const list = sqlFunction('list_founding_skipper_applications');
        expect(list).toMatch(/p_limit INTEGER DEFAULT 50/i);
        expect(list).toMatch(/NOT public\.can_review_founding_skipper_applications\(\)/i);
        expect(list).toMatch(/p_limit IS NULL OR p_limit < 1 OR p_limit > 50/i);
        expect(list).toMatch(/\(p_before_created_at IS NULL\) IS DISTINCT FROM \(p_before_id IS NULL\)/i);
        expect(list).toMatch(/\(application\.created_at, application\.id\) < \(p_before_created_at, p_before_id\)/i);
        expect(list).toMatch(/ORDER BY application\.created_at DESC, application\.id DESC[\s\S]*LIMIT p_limit/i);
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.list_founding_skipper_applications\(TEXT, TIMESTAMPTZ, UUID, INTEGER\)[\s\S]*TO authenticated/i,
        );
    });

    it('uses compare-and-set status updates and records only UUID/status audit metadata', () => {
        const review = sqlFunction('review_founding_skipper_application');
        expect(review).toMatch(/NOT public\.can_review_founding_skipper_applications\(\)/i);
        expect(review).toMatch(/application\.status = p_expected_status/i);
        expect(review).toMatch(/RETURNING application\.id INTO changed_application_id/i);
        expect(review).toMatch(/IF changed_application_id IS NULL THEN\s+RETURN false/i);
        expect(review).toMatch(/status_updated_by = auth\.uid\(\)/i);
        expect(review).toMatch(/INSERT INTO public\.founding_skipper_application_status_audit/i);
        expect(review).toMatch(/p_expected_status = 'declined' AND p_status = 'new'/i);
        expect(review).not.toMatch(/p_expected_status = 'withdrawn' AND p_status/i);

        const auditTable = migration.match(
            /CREATE TABLE public\.founding_skipper_application_status_audit \([\s\S]*?\n\);/i,
        )?.[0];
        expect(auditTable).toBeTruthy();
        expect(auditTable).toMatch(/application_id UUID/i);
        expect(auditTable).toMatch(/actor_id UUID/i);
        expect(auditTable).toMatch(/previous_status TEXT/i);
        expect(auditTable).toMatch(/status TEXT/i);
        expect(auditTable).not.toMatch(/\b(?:name|email|notes|home_waters|details)\b/i);
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.founding_skipper_application_status_audit FROM PUBLIC, anon, authenticated/i,
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.review_founding_skipper_application\(UUID, TEXT, TEXT\)[\s\S]*TO authenticated/i,
        );
    });
});
