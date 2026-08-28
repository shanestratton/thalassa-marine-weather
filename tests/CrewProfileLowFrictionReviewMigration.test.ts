import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260828170000_crew_profile_low_friction_review.sql', 'utf8');
const automaticPublicationMigration = readFileSync(
    'supabase/migrations/20260828150000_crew_automatic_publication.sql',
    'utf8',
);
const publicationWorker = readFileSync('supabase/functions/crew-profile-publication/index.ts', 'utf8');

function sqlFunction(name: string): string {
    const match = migration.match(
        new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, 'i'),
    );
    expect(match, `Expected ${name} function`).toBeTruthy();
    return match?.[0] ?? '';
}

function automaticPublicationSqlFunction(name: string): string {
    const match = automaticPublicationMigration.match(
        new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, 'i'),
    );
    expect(match, `Expected ${name} function`).toBeTruthy();
    return match?.[0] ?? '';
}

describe('Crew List low-friction profile edit migration', () => {
    it('keeps the private city field out of publication invalidation while retaining its safety fence', () => {
        const guard = sqlFunction('guard_sailor_crew_profile_beta');
        const moderatedSection = guard.match(/moderated_change\s*:=([\s\S]*?);\n\s*END IF;/i)?.[1] ?? '';

        expect(guard).toMatch(/crew_list_public_text_is_safe\(NEW\.location_city, 120, true\)/i);
        expect(moderatedSection).not.toMatch(/NEW\.location_city IS DISTINCT FROM OLD\.location_city/i);
        expect(guard).toContain('City/town is deliberately private and excluded here.');
    });

    it('fails closed if city is ever added to the public snapshot, browse result, or moderation worker', () => {
        const digest = automaticPublicationSqlFunction('crew_list_public_profile_digest');
        const browse = automaticPublicationSqlFunction('browse_crew_list_profiles');
        const workerProfileSelect = publicationWorker.match(
            /from\('sailor_crew_profiles'\)[\s\S]*?\.select\(([\s\S]*?)\)[\s\S]*?\.eq\('user_id'/i,
        )?.[1];

        expect(digest).not.toContain("'location_city'");
        expect(browse).not.toMatch(/\blocation_city\b/i);
        expect(workerProfileSelect).toBeTruthy();
        expect(workerProfileSelect).not.toMatch(/\blocation_city\b/i);
    });

    it('still withdraws every member-visible or role-sensitive edit for exact-snapshot automatic checking', () => {
        const guard = sqlFunction('guard_sailor_crew_profile_beta');
        const moderatedSection = guard.match(/moderated_change\s*:=([\s\S]*?);\n\s*END IF;/i)?.[1] ?? '';

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
            expect(moderatedSection).toMatch(new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}`, 'i'));
        }

        expect(guard).toMatch(
            /OLD\.approval_status = 'approved' AND moderated_change[\s\S]*?approval_status := 'draft'[\s\S]*?crew_list_visibility := 'private'/i,
        );
        expect(guard).toMatch(/DELETE FROM public\.crew_profile_publication_attestations/i);
    });

    it('does not trust a client edit-impact flag or weaken managed review fields', () => {
        const guard = sqlFunction('guard_sailor_crew_profile_beta');
        expect(guard).not.toMatch(/benign|safe_edit|edit_impact/i);
        expect(guard).toMatch(/Crew List review fields are managed by Thalassa/i);
        expect(guard).toMatch(/Crew List publication source is managed by Thalassa/i);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.guard_sailor_crew_profile_beta\(\)[\s\S]*?FROM PUBLIC, anon, authenticated/i,
        );
    });
});
