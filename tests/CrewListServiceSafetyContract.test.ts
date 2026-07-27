import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const service = readFileSync('services/LonelyHeartsService.ts', 'utf8');

function sourceBetween(startMarker: string, endMarker: string): string {
    const start = service.indexOf(startMarker);
    const end = service.indexOf(endMarker, start + startMarker.length);
    expect(start, `Expected source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
    expect(end, `Expected source marker: ${endMarker}`).toBeGreaterThan(start);
    return service.slice(start, end);
}

describe('Crew List service safety contract', () => {
    it('queries only explicitly opted-in, visible, approved, verified profiles and has no legacy browse fallback', () => {
        const browse = sourceBetween('async getCrewListings(', 'private matchesCrewFilters(');

        expect(browse).toContain('.from(CREW_PROFILES_TABLE)');
        expect(browse).toMatch(/\.eq\('community_enabled', true\)/);
        expect(browse).toMatch(/\.eq\('crew_list_visibility', 'visible'\)/);
        expect(browse).toMatch(/\.eq\('approval_status', 'approved'\)/);
        expect(browse).toMatch(/\.eq\('verification_status', 'verified'\)/);
        expect(browse).toMatch(/crew\.community_enabled !== true/);
        expect(browse).toMatch(/crew\.crew_list_visibility !== 'visible'/);
        expect(browse).toMatch(/crew\.approval_status !== 'approved'/);
        expect(browse).toMatch(/crew\.verification_status !== 'verified'/);
        expect(browse).not.toContain('looking_for_love');
        expect(browse).not.toContain('CHAT_PROFILES_TABLE');
        expect(browse).not.toMatch(/crewOnly|chatProfiles|legacy fallback/i);
    });

    it('keeps owner-controlled opt-in state separate from review and verification controls', () => {
        const stateUpdate = sourceBetween(
            'async updateCrewListState(',
            '/** Submit a complete, private profile for administrator verification. */',
        );
        const reviewSubmit = sourceBetween('async submitCrewProfileForReview(', '/** Admin-only queue.');

        expect(stateUpdate).toContain('community_enabled');
        expect(stateUpdate).toContain('crew_intents');
        expect(stateUpdate).toContain('crew_list_visibility');
        expect(stateUpdate).not.toContain("approval_status: 'approved'");
        expect(stateUpdate).not.toContain("verification_status: 'verified'");
        expect(stateUpdate).toMatch(/update\.community_enabled === false\) updates\.crew_list_visibility = 'private'/);

        expect(reviewSubmit).toMatch(/approval_status: 'pending'/);
        expect(reviewSubmit).toMatch(/verification_status: 'pending'/);
        expect(reviewSubmit).toMatch(/crew_list_visibility: 'private'/);
        expect(reviewSubmit).toMatch(/!profile\.community_enabled/);
        expect(reviewSubmit).toMatch(/profile\.crew_intents\.length === 0/);
        expect(reviewSubmit).toMatch(/!profile\.photo_url\?\.trim\(\)/);
    });

    it('rejects contact details before an introduction request can write anything', () => {
        const sanitizer = sourceBetween('private normalizeCrewIntroMessage(', 'async init()');
        const sendIntro = sourceBetween('async sendCrewIntroRequest(', '/** Return only introductions');

        expect(sanitizer).toMatch(/normalized\.length > 500/);
        expect(sanitizer).toMatch(/const hasControlCharacter/);
        expect(sanitizer).toMatch(/String\.fromCharCode\(0\)/);
        expect(sanitizer).toMatch(/String\.fromCharCode\(127\)/);
        expect(sanitizer).toMatch(/const containsEmail/);
        expect(sanitizer).toMatch(/const containsUrl/);
        expect(sanitizer).toMatch(/const containsPhone/);
        expect(sanitizer).toMatch(/return containsEmail \|\| containsUrl \|\| containsPhone \? null : normalized/);

        expect(sendIntro.indexOf('this.normalizeCrewIntroMessage(message)')).toBeLessThan(
            sendIntro.indexOf('.from(CREW_INTRO_REQUESTS_TABLE)'),
        );
        expect(sendIntro).toMatch(/note === null/);
        expect(sendIntro).toMatch(/return null/);
        expect(sendIntro).toMatch(/\.insert\(\{ sender_id: ownerId, recipient_id: recipient, message: note \}\)/);
        expect(sendIntro).not.toMatch(/\b(?:email|phone|mobile|url|website|contact)\b/i);
    });

    it('scopes introduction reads and state changes to the participant who is allowed to make them', () => {
        const listIntros = sourceBetween('async getCrewIntroRequests(', '/** A recipient may accept or decline');
        const respond = sourceBetween('async respondToCrewIntroRequest(', '/** A sender may withdraw');
        const withdraw = sourceBetween('async withdrawCrewIntroRequest(', '// ─── BROWSE DATING PROFILES');

        expect(listIntros).toMatch(/\.or\(`sender_id\.eq\.\$\{ownerId\},recipient_id\.eq\.\$\{ownerId\}`\)/);
        expect(listIntros).toMatch(/request\.sender_id === ownerId \|\| request\.recipient_id === ownerId/);
        expect(respond).toMatch(/\.eq\('recipient_id', ownerId\)/);
        expect(respond).toMatch(/response !== 'accepted' && response !== 'declined'/);
        expect(withdraw).toMatch(/\.eq\('sender_id', ownerId\)/);
        expect(withdraw).toMatch(/status: 'withdrawn'/);
    });

    it('uses the canonical direct-message block list to suppress Crew List discovery', () => {
        const browse = sourceBetween('async getCrewListings(', 'private matchesCrewFilters(');
        const block = sourceBetween('async blockCrewListUser(', '/** Remove a Crew List block');
        const unblock = sourceBetween('async unblockCrewListUser(', '/** Read the signed-in sailor');

        expect(browse).toContain('this.getCrewListBlockedUserIdsForScope(scope, ownerId)');
        expect(block).toContain('.from(CREW_LIST_BLOCKS_TABLE)');
        expect(block).toMatch(/blocker_id: ownerId, blocked_id: target/);
        expect(unblock).toContain('.from(CREW_LIST_BLOCKS_TABLE)');
        expect(unblock).toMatch(/\.eq\('blocker_id', ownerId\)/);
        expect(unblock).toMatch(/\.eq\('blocked_id', target\)/);
    });
});
