import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');
const text = (source: string) => source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('Product Feedback privacy disclosure', () => {
    const terms = text(read('public/terms.html'));
    const collectionNotice = text(read('src/FeedbackPage.tsx'));

    it('makes optional diagnostics genuinely opt-in and names their bounded contents', () => {
        expect(terms).toContain('Basic technical details are optional and off by default');
        for (const detail of [
            'browser platform and user-agent description',
            'screen and viewport sizes',
            'language',
            'online status',
            'current page path',
        ]) {
            expect(terms).toContain(detail);
        }
        expect(terms).toContain('excludes all query parameters');
        expect(terms).toContain(
            'does not include coordinates, account data, cookies, local-storage contents, device identifiers, URL parameters',
        );
        expect(collectionNotice).toContain('optional and off by default');
    });

    it('distinguishes app launch context from optional browser diagnostics and trusted identity', () => {
        for (const queryName of ['appVersion', 'build', 'platform']) {
            expect(terms).toContain(queryName);
        }
        expect(terms).toContain('stores their bounded values with every report');
        expect(terms).toContain('app version, app build, and app platform metadata');
        expect(terms).toContain('fields are empty when Thalassa did not supply that context');
        expect(terms).toContain('caller-supplied context');
        expect(terms).toContain(
            "not verified or trusted proof of a person's identity, account, device, or entitlement",
        );
        expect(terms).toContain('including the three app-context parameters above');
        expect(terms).toContain('arbitrary query parameters are not copied into the report');
    });

    it('discloses the pseudonymous abuse limit without claiming that a raw IP is retained', () => {
        expect(terms).toContain('derives a keyed HMAC token');
        expect(terms).toContain('does not store the raw network address');
        expect(terms).toContain("cannot be reversed without Thalassa's private server-side key");
        expect(terms).toContain('Quota rows older than two days become eligible for opportunistic deletion');
        expect(collectionNotice).toContain('raw IP');
        expect(collectionNotice).toMatch(/(?:is not|isn’t|isn't|do not|don't) store/);
    });

    it('names Resend, both transactional recipients, retention, and early deletion', () => {
        for (const surface of [terms, collectionNotice]) {
            expect(surface).toContain('Resend');
            expect(surface).toContain('receipt');
            expect(surface).toContain('operator');
            expect(surface).toMatch(/private,? monitored (?:email )?inbox/);
        }
        expect(terms).toContain('transactional email provider');
        expect(terms).toContain('scheduled for automatic deletion within 365 days');
        expect(terms).toContain('privacy@thalassawx.com');
        expect(terms).toContain('submission reference from your receipt');
        expect(terms).toContain('Resend separately retains delivery information');
    });

    it('warns against secrets, private chart files, and third-party personal data at collection', () => {
        for (const surface of [terms, collectionNotice]) {
            expect(surface).toContain('passwords');
            expect(surface).toContain('one-time codes');
            expect(surface).toContain('authentication tokens');
            expect(surface).toContain('private chart files');
            expect(surface).toContain("another person's personal information");
        }
        expect(collectionNotice).toMatch(/(?:do not|don't) sell/i);
        expect(collectionNotice).toContain('advertising');
    });
});
