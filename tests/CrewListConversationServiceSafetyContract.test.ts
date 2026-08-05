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

describe('Crew List private conversation service contract', () => {
    it('resolves a conversation only from an accepted introduction owned by the current sailor', () => {
        const resolver = sourceBetween(
            'private async getCrewIntroConversationForRequestForScope(',
            '/** Return the server-created Crew List conversation',
        );

        expect(resolver).toContain('.from(CREW_INTRO_REQUESTS_TABLE)');
        expect(resolver).toMatch(/\.eq\('id', introRequestId\)/);
        expect(resolver).toMatch(/\.or\(`sender_id\.eq\.\$\{ownerId\},recipient_id\.eq\.\$\{ownerId\}`\)/);
        expect(resolver).toMatch(/request\.status !== 'accepted'/);
        expect(resolver).toContain('.from(CREW_INTRO_CONVERSATIONS_TABLE)');
        expect(resolver).toMatch(
            /normalized\.participant_one_id === ownerId \|\| normalized\.participant_two_id === ownerId/,
        );
        expect(resolver).toMatch(/!isAuthIdentityScopeCurrent\(scope\)/);
    });

    it('reads private messages through the accepted Crew List conversation lane only', () => {
        const readMessages = sourceBetween(
            'async getCrewIntroMessages(',
            '/**\n     * Send one private Crew List message.',
        );

        expect(readMessages.indexOf('this.getCrewIntroConversationForRequestForScope')).toBeLessThan(
            readMessages.indexOf('.from(CREW_INTRO_MESSAGES_TABLE)'),
        );
        expect(readMessages).toContain('.from(CREW_INTRO_MESSAGES_TABLE)');
        expect(readMessages).toMatch(/\.eq\('conversation_id', conversation\.id\)/);
        expect(readMessages).toMatch(/message\.conversation_id === conversation\.id/);
        expect(readMessages).not.toMatch(/(?:sendDM|chat_direct_messages|DM_TABLE|enqueue)/i);
    });

    it('sends through the Crew List message table with no generic-DM fallback', () => {
        const sendMessage = sourceBetween('async sendCrewIntroMessage(', '// ─── BROWSE DATING PROFILES');

        expect(sendMessage.indexOf('this.normalizeCrewIntroConversationMessage(message)')).toBeLessThan(
            sendMessage.indexOf('this.getCrewIntroConversationForRequestForScope'),
        );
        expect(sendMessage.indexOf('this.getCrewIntroConversationForRequestForScope')).toBeLessThan(
            sendMessage.indexOf('.from(CREW_INTRO_MESSAGES_TABLE)'),
        );
        expect(sendMessage).toContain('.from(CREW_INTRO_MESSAGES_TABLE)');
        expect(sendMessage).toMatch(
            /\.insert\(\{ conversation_id: conversation\.id, sender_id: ownerId, message: text \}\)/,
        );
        expect(sendMessage).toMatch(/sent\?\.conversation_id === conversation\.id && sent\.sender_id === ownerId/);
        expect(sendMessage).toMatch(/!isAuthIdentityScopeCurrent\(scope\)/);
        expect(sendMessage).not.toMatch(/(?:sendDM|chat_direct_messages|DM_TABLE|enqueue)/i);
    });

    it('rejects contact or precise-location content in every public profile field before it can write', () => {
        const profileSafety = sourceBetween(
            'private hasSafeCrewListPublicProfileFields(',
            'private isCrewListDiscoverableProfile(',
        );
        const updateProfile = sourceBetween('async updateCrewProfile(', 'private async updateCrewProfileForScope(');

        expect(profileSafety).toMatch(/updates\.partner_details, 500, true/);
        expect(profileSafety).toMatch(/updates\.skills, 30, 80\)/);
        expect(profileSafety).toMatch(/updates\.vibe, 20, 80\)/);
        expect(profileSafety).toMatch(/updates\.languages, 20, 80\)/);
        expect(profileSafety).toMatch(/updates\.interests, 40, 80\)/);
        expect(profileSafety).toMatch(/this\.isCrewListPublicTextArraySafe/);

        expect(updateProfile.indexOf('this.hasSafeCrewListPublicProfileFields(updatesSnapshot)')).toBeLessThan(
            updateProfile.indexOf('await this.getAuthenticatedOwner(scope)'),
        );
        expect(updateProfile).toMatch(
            /if \(!this\.hasSafeCrewListPublicProfileFields\(updatesSnapshot\)\) return false/,
        );
    });

    it('uses private Crew List photo paths with signed display URLs and retires objects on removal', () => {
        const sanitizer = sourceBetween('private sanitizeCrewProfileUpdates(', 'private normalizeCrewIntroMessage(');
        const signedUrls = sourceBetween(
            'private async getCrewPhotoSignedUrlMapForScope(',
            'private withCrewProfilePhotoUrls(',
        );
        const upload = sourceBetween('async uploadCrewPhoto(', '/** Remove a photo at a display position');
        const remove = sourceBetween('async removeCrewPhotoAtIndex(', '/** Backwards-compatible shorthand');
        const deleteProfile = sourceBetween('async deleteCrewProfile(', '// ─── DATING PROFILES');

        expect(sanitizer).toMatch(/'photo_url'/);
        expect(sanitizer).toMatch(/'photos'/);
        expect(sanitizer).toMatch(/'crew_photo_path'/);
        expect(sanitizer).toMatch(/'crew_photo_paths'/);
        expect(upload).toContain(".from('crew-list-photos')");
        expect(upload).toContain('this.getCrewPhotoSignedUrlMapForScope(scope, [path])');
        expect(signedUrls).toContain(".from('crew-list-photos').createSignedUrls(uniquePaths, 60 * 60)");
        expect(upload).toMatch(/const primaryPath = persistPrimary \? path/i);
        expect(upload).toMatch(/crew_photo_path: primaryPath/i);
        expect(upload).toMatch(/crew_photo_paths: photoPaths/i);
        expect(upload).not.toMatch(/getPublicUrl/i);
        expect(remove).toContain("retireOwnedMedia(scope, cleanupAuthorization, 'crew-list-photos', removedPath)");
        expect(deleteProfile).toContain(
            "retireMediaPaths(scope, cleanupAuthorization, 'crew-list-photos', photoPaths)",
        );
        expect(remove).not.toMatch(/storage\.from\('crew-list-photos'\)\.remove/);
        expect(deleteProfile).not.toMatch(/storage\.from\('crew-list-photos'\)\.remove/);
    });
});
