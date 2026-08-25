import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

describe('Founding Skipper application privacy disclosure', () => {
    const terms = read('public/terms.html');
    const applicationPage = read('src/FoundingSkippersPage.tsx');

    it('discloses transactional notification processing in the policy and at collection', () => {
        for (const source of [terms, applicationPage]) {
            const surface = source.replace(/\s+/g, ' ');

            expect(surface).toContain('Resend');
            expect(surface).toContain('transactional email provider');
            expect(surface).toContain('solely to notify the operator');
            expect(surface).toContain("operator's private email inbox");
            expect(surface).toMatch(/(?:does not|don't) sell application data/);
            expect(surface).toContain('use it for advertising');
        }
    });
});
