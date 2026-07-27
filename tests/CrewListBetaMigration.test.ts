import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260727130000_crew_list_beta_safety.sql', 'utf8');

function policy(name: string): string {
    const match = migration.match(
        new RegExp(
            `CREATE POLICY\\s+"${name}"[\\s\\S]*?(?=\\n(?:CREATE POLICY|DROP POLICY|GRANT |REVOKE |-- ──|$))`,
            'i',
        ),
    );
    expect(match, `Expected ${name} policy`).toBeTruthy();
    return match?.[0] || '';
}

function introTable(): string {
    const match = migration.match(/CREATE TABLE IF NOT EXISTS public\.crew_intro_requests \([\s\S]*?\n\);/i);
    expect(match, 'Expected crew_intro_requests table').toBeTruthy();
    return match?.[0] || '';
}

describe('Crew List beta safety migration', () => {
    it('keeps every existing Crew Finder profile private and unapproved by default', () => {
        expect(migration).toMatch(/community_enabled BOOLEAN NOT NULL DEFAULT false/i);
        expect(migration).toMatch(/crew_list_visibility TEXT NOT NULL DEFAULT 'private'/i);
        expect(migration).toMatch(/approval_status TEXT NOT NULL DEFAULT 'draft'/i);
        expect(migration).toMatch(/verification_status TEXT NOT NULL DEFAULT 'unverified'/i);

        const visibilityGate = migration.match(
            /ADD CONSTRAINT sailor_crew_profiles_visible_profile_shape[\s\S]*?\n\s*\);/i,
        )?.[0];
        expect(visibilityGate).toBeTruthy();
        expect(visibilityGate).toMatch(/community_enabled/i);
        expect(visibilityGate).toMatch(/approval_status = 'approved'/i);
        expect(visibilityGate).toMatch(/verification_status = 'verified'/i);
        expect(visibilityGate).toMatch(/cardinality\(crew_intents\) > 0/i);
        expect(visibilityGate).toMatch(/photo_url/i);
    });

    it('replaces the broad profile-read policy with an owner-or-fully-approved visibility gate', () => {
        expect(migration).toMatch(/DROP POLICY IF EXISTS "Anyone can view crew profiles"/i);
        const readPolicy = policy('crew_profiles_owner_or_approved_visible');

        expect(readPolicy).toMatch(/user_id = auth\.uid\(\)/i);
        expect(readPolicy).toMatch(/public\.is_chat_admin\(auth\.uid\(\)\)/i);
        expect(readPolicy).toMatch(/community_enabled/i);
        expect(readPolicy).toMatch(/crew_list_visibility = 'visible'/i);
        expect(readPolicy).toMatch(/approval_status = 'approved'/i);
        expect(readPolicy).toMatch(/verification_status = 'verified'/i);
        expect(readPolicy).not.toMatch(/USING\s*\(\s*true\s*\)/i);
    });

    it('makes introductions participant-only and grants no anonymous public access', () => {
        const introductions = introTable();
        const readPolicy = policy('crew_intro_requests_participants_read');
        const writePolicy = policy('crew_intro_requests_sender_create');
        const updatePolicy = policy('crew_intro_requests_participants_update');

        expect(readPolicy).toMatch(/sender_id = auth\.uid\(\) OR recipient_id = auth\.uid\(\)/i);
        expect(readPolicy).not.toMatch(/USING\s*\(\s*true\s*\)/i);
        expect(writePolicy).toMatch(/sender_id = auth\.uid\(\)/i);
        expect(writePolicy).toMatch(/public\.can_send_crew_intro\(recipient_id\)/i);
        expect(updatePolicy).toMatch(/sender_id = auth\.uid\(\) OR recipient_id = auth\.uid\(\)/i);
        expect(updatePolicy).toMatch(/status IN \('accepted', 'declined'\)/i);
        expect(migration).toMatch(/GRANT SELECT, INSERT, UPDATE ON public\.crew_intro_requests TO authenticated/i);
        expect(migration).not.toMatch(/GRANT[\s\S]*ON public\.crew_intro_requests TO anon/i);

        // The only payload is an in-app note. No independently queryable
        // email, phone, URL, or contact field can leak from this table.
        expect(introductions).toMatch(/message TEXT NOT NULL DEFAULT ''/i);
        expect(introductions).not.toMatch(/^\s*(?:email|phone|mobile|url|website|contact)\s+/im);
    });

    it('enforces contact-free intro notes in the database as a backstop to client validation', () => {
        const introductions = introTable();

        expect(introductions).toMatch(/crew_intro_requests_message_length_check/i);
        expect(introductions).toMatch(/char_length\(message\) BETWEEN 0 AND 500/i);
        expect(introductions).toMatch(/crew_intro_requests_message_shape_check/i);
        expect(introductions).toContain(String.raw`message !~ E'[\\n\\r\\t]'`);
        expect(introductions).toMatch(/message !~\* '.*@/i);
        expect(introductions).toContain("message !~* '(https?://");
        expect(introductions).toContain("message !~ '[+]?(");
    });

    it('allows only the recipient to accept or decline and only the sender to withdraw', () => {
        const guard = migration.match(
            /CREATE OR REPLACE FUNCTION public\.guard_crew_intro_request_update\(\)[\s\S]*?\n\$\$;/i,
        )?.[0];

        expect(guard).toBeTruthy();
        expect(guard).toMatch(/auth\.uid\(\) = OLD\.sender_id AND NEW\.status = 'withdrawn'/i);
        expect(guard).toMatch(/auth\.uid\(\) = OLD\.recipient_id AND NEW\.status IN \('accepted', 'declined'\)/i);
        expect(guard).toMatch(/A resolved Crew List introduction cannot be changed/i);
    });
});
