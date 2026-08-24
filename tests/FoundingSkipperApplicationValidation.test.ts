import { describe, expect, it } from 'vitest';
import { validateFoundingSkipperApplication } from '../supabase/functions/founding-skipper-application/validation';

const valid = {
    name: '  Shane   Stratton  ',
    email: 'SKIPPER@EXAMPLE.COM',
    boatType: 'sail_monohull',
    homeWaters: ' Moreton Bay ',
    appleDevice: 'iphone_and_ipad',
    boatingFrequency: 'weekly_plus',
    interests: ['marine_weather', 'anchor_watch'],
    notes: 'Straight-up feedback.',
    consent: true,
    source: 'moreton-bay-club',
    website: '',
};

describe('founding skipper application validation', () => {
    it('normalizes a complete application and does not retain consent metadata from the browser', () => {
        const result = validateFoundingSkipperApplication(valid);
        expect(result.fields).toEqual([]);
        expect(result.value).toEqual(
            expect.objectContaining({
                name: 'Shane Stratton',
                email: 'skipper@example.com',
                source: 'moreton-bay-club',
                honeypotTriggered: false,
            }),
        );
        expect(result.value).not.toHaveProperty('consentedAt');
        expect(result.value).not.toHaveProperty('consentVersion');
    });

    it('rejects unknown keys, bad enums, duplicate interests, controls, and missing consent', () => {
        const result = validateFoundingSkipperApplication({
            ...valid,
            name: 'Shane\u0000',
            boatType: 'submarine',
            interests: ['anchor_watch', 'anchor_watch'],
            consent: false,
            isAdmin: true,
        });
        expect(result.value).toBeNull();
        expect(result.fields).toEqual(expect.arrayContaining(['form', 'name', 'boatType', 'interests', 'consent']));
    });

    it('flags the honeypot without including it in stored application fields', () => {
        const result = validateFoundingSkipperApplication({ ...valid, website: 'https://spam.invalid' });
        expect(result.fields).toEqual([]);
        expect(result.value?.honeypotTriggered).toBe(true);
        expect(result.value).not.toHaveProperty('website');
    });
});
