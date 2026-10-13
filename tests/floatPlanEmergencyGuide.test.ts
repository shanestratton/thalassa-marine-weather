import { describe, expect, it } from 'vitest';

import { createFloatPlanSharePayload, estimateSmsSegments, holdNumbersLeftToRight } from '../services/floatPlan';
import type { FloatPlanInput } from '../services/floatPlan';

const NOW = 1788000000000;

function guideFor(vessel: Record<string, unknown>): string {
    const text = createFloatPlanSharePayload(
        {
            vessel: { name: 'Serene Summer', type: 'sail', ...vessel },
            route: { from: 'Newport, QLD', to: 'Mooloolaba', waypoints: [] },
            departureMs: NOW,
            overdueMs: NOW + 12 * 3600e3,
            personsOnBoard: 2,
            whoToCall: 'Marine Rescue Redcliffe — 07 3203 5522',
            contactAboard: 'Sat phone +881 6234 5678',
            timeZone: 'Australia/Brisbane',
        } as unknown as FloatPlanInput,
        'email',
    ).text;
    return text.slice(text.indexOf('IF WE ARE OVERDUE'));
}

describe('overdue guide', () => {
    it('gives explicit permission to do nothing before the overdue time', () => {
        // A holder who panics early burns the goodwill that gets a real search
        // started, and the paper form never says this out loud.
        expect(guideFor({})).toMatch(/Nothing needs doing before/i);
    });

    it('names the shore contacts when the vessel has them', () => {
        const guide = guideFor({
            shoreContact1: 'Jane Stratton — 0412 345 678',
            shoreContact2: 'Redcliffe Marina — 07 3269 1234',
        });
        expect(guide).toContain('Jane Stratton — 0412 345 678');
        expect(guide).toContain('Redcliffe Marina — 07 3269 1234');
        expect(guide).toMatch(/Ring the people ashore/i);
    });

    it('still gives a usable step when no shore contacts are set', () => {
        // The guide must never degrade into a blank rung: a plan filled in
        // hastily before leaving is the normal case, not the exception.
        const guide = guideFor({});
        expect(guide).toMatch(/Ask anyone else who might have heard/i);
        expect(guide).not.toContain('undefined');
    });

    it('always ends with the number to ring and how to speak to them', () => {
        const guide = guideFor({});
        expect(guide).toContain('Marine Rescue Redcliffe — 07 3203 5522');
        expect(guide).toMatch(/I am reporting an overdue vessel/i);
        expect(guide).toMatch(/say you do not know/i);
    });
});

describe('every channel tells the holder what to do', () => {
    // The guide shipped on the email brief only at first, which meant the most
    // likely way this is actually sent — WhatsApp to a mate — carried the facts
    // and no instruction. A holder with a plan and no idea what to do with it is
    // the failure this whole feature exists to prevent.
    const input = {
        vessel: { name: 'Serene Summer', type: 'sail', shoreContact1: 'Jane — 0412 345 678' },
        route: { from: 'Newport', to: 'Mooloolaba', waypoints: [] },
        departureMs: NOW,
        overdueMs: NOW + 12 * 3600e3,
        personsOnBoard: 2,
        whoToCall: 'Marine Rescue Redcliffe — 07 3203 5522',
        contactAboard: 'Sat phone',
        timeZone: 'Australia/Brisbane',
    } as unknown as FloatPlanInput;

    it.each(['email', 'whatsapp', 'generic'] as const)('%s carries the full ladder', (channel) => {
        const text = createFloatPlanSharePayload(input, channel).text;
        expect(text).toMatch(/IF WE ARE OVERDUE/i);
        expect(text).toMatch(/Try us first/i);
        expect(text).toContain('Marine Rescue Redcliffe — 07 3203 5522');
    });

    it('sms carries the escalation order without the full ladder', () => {
        // Every line here is another segment, and a truncated guide is worse
        // than a short one that is complete.
        const text = createFloatPlanSharePayload(input, 'sms').text;
        expect(text).toMatch(/IF OVERDUE/i);
        expect(text).toMatch(/do not guess/i);
        expect(text).toMatch(/OVERDUE:/);
        expect(text).toMatch(/CALL:/);
    });
});

describe('the guide reads as plain English on every channel', () => {
    // The Tailwind 4 codemod (c3c1e1f3c, 2 Sep 2026) renamed the class `ring`
    // to `ring-3` inside this prose too, so every plan carried "They will
    // ring-3 back for more" until 129. No class name belongs in this text.
    const input = {
        vessel: { name: 'Example Star', type: 'sail', shoreContact1: 'Robin Example — 0400 000 003' },
        route: { from: 'Port Example', to: 'Example Cove', waypoints: [] },
        departureMs: NOW,
        overdueMs: NOW + 12 * 3600e3,
        personsOnBoard: 3,
        whoToCall: 'Coast Radio Example — +1 555 0100',
        contactAboard: 'Sat phone +881 600 000 000',
        timeZone: 'Pacific/Auckland',
    } as unknown as FloatPlanInput;
    const CLASS_NAME = /\b(?:ring|shadow|drop-shadow|blur|rounded|outline)-(?:\d|xs|sm|hidden)\b/;

    it.each(['email', 'whatsapp', 'generic', 'sms'] as const)('%s has no class names in it', (channel) => {
        expect(createFloatPlanSharePayload(input, channel).text).not.toMatch(CLASS_NAME);
    });

    it('asks the holder to keep the phone free because they will ring back', () => {
        expect(createFloatPlanSharePayload(input, 'email').text).toContain(
            'Keep your phone free. They will ring back for more, and you are now the person',
        );
    });
});

describe('a phone number after a Hebrew or Arabic name stays in dialling order', () => {
    // Without a mark the bidi algorithm lays "+972 50 000 0000" out as
    // "0000 000 50 972+" beside a right-to-left name: measured in WebKit and
    // Chromium (scratchpad bidi129, 14 Oct 2026). A holder reading the guide
    // left to right would dial the groups backwards.
    const LRM = '\u200E';

    it('marks the number on a right-to-left line, on both sides', () => {
        expect(holdNumbersLeftToRight('   מרים לוי — +972 50 000 0000')).toBe(
            `   מרים לוי — ${LRM}+972 50 000 0000${LRM}`,
        );
        expect(holdNumbersLeftToRight('ليلى حداد — (01) 000-000')).toBe(`ليلى حداد — ${LRM}(01) 000-000${LRM}`);
    });

    it('leaves Latin-only lines, short numbers and times alone', () => {
        const latin = 'Alex Example (sister) — 0400 000 001\nVHF 16, 21:00, 2026';
        expect(holdNumbersLeftToRight(latin)).toBe(latin);
        expect(holdNumbersLeftToRight('חיפה VHF 16 at 21:00')).toBe('חיפה VHF 16 at 21:00');
    });

    it('carries the marks on every channel, and a Latin-only SMS stays in the GSM alphabet', () => {
        const base = {
            vessel: { name: 'Example Star', type: 'sail', shoreContact1: 'מרים לוי — +972 50 000 0000' },
            route: { from: 'Port Example', to: 'Example Cove', waypoints: [] },
            departureMs: NOW,
            overdueMs: NOW + 12 * 3600e3,
            personsOnBoard: 2,
            whoToCall: 'Coast Radio Example — +1 555 0100',
            contactAboard: 'Sat phone +881 600 000 000',
            timeZone: 'Asia/Jerusalem',
        } as unknown as FloatPlanInput;
        for (const channel of ['email', 'whatsapp', 'generic'] as const) {
            expect(createFloatPlanSharePayload(base, channel).text).toContain(
                `מרים לוי — ${LRM}+972 50 000 0000${LRM}`,
            );
        }
        const latinOnly = { ...base, vessel: { ...base.vessel, shoreContact1: 'Robin Example — 0400 000 003' } };
        const sms = createFloatPlanSharePayload(latinOnly, 'sms');
        expect(sms.text).not.toContain(LRM);
        expect(sms.smsSegments).toBe(estimateSmsSegments(sms.text.replace(/\u200E/g, '')));
    });
});
